// 🔄 today-recovery.js - שחזור שיחות טלמרקטינג של היום שנתקעו ב-Processing
// מריץ את telemarketing-recovery.js עם פילטר לתאריך היום בלבד

const https = require('https');
const { spawn } = require('child_process');

const AIRTABLE_API_KEY = 'process.env.AIRTABLE_API_KEY';
const AIRTABLE_BASE_ID = 'app5pnaEc4UK3RUcP';
const TELEMARKETING_TABLE = 'tblcNkAMMCJQ3EVMl';
const MASKYOO_API_KEY = 'process.env.MASKYOO_API_KEY';
const DELAY_BETWEEN_RECORDS = 20000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayDateString() {
    // תאריך היום בזמן ישראלי
    const now = new Date();
    const israeliStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
    return israeliStr;
}

function formatPhone(phone) {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('9720')) cleaned = '972' + cleaned.substring(4);
    if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
    if (!cleaned.startsWith('972')) cleaned = '972' + cleaned;
    return cleaned;
}

async function fetchTodayProcessingRecords(today) {
    const records = [];
    let offset = '';
    // מסנן רק Processing - לא in_progress (כדי למנוע ריצה כפולה)
    const filter = encodeURIComponent(`AND({call_status}='Processing', IS_SAME({call_time}, '${today}', 'day'))`);

    do {
        const result = await new Promise((resolve) => {
            let path = `/v0/${AIRTABLE_BASE_ID}/${TELEMARKETING_TABLE}?filterByFormula=${filter}&pageSize=100&fields[]=phone_number&fields[]=phone_my_user&fields[]=call_time&fields[]=donor_name&fields[]=call_status`;
            if (offset) path += '&offset=' + offset;
            const req = https.request({
                hostname: 'api.airtable.com', port: 443, path,
                headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve({ records: [] }); }
                });
            });
            req.on('error', () => resolve({ records: [] }));
            req.end();
        });
        records.push(...(result.records || []));
        offset = result.offset || '';
    } while (offset);

    return records;
}

async function fetchCDRForDate(date, virtualNumber) {
    return new Promise((resolve) => {
        const sql = `SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, cdr_ddi, user_phone, call_status FROM webserviceview WHERE start_call >= '${date} 00:00:00' AND start_call <= '${date} 23:59:59' AND cdr_ddi = '${virtualNumber}' AND end_call IS NOT NULL AND call_status = 'ANSWER' ORDER BY start_call ASC`;
        const params = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' });
        const url = `https://app.maskyoo.co.il/issa_153/api/?${params}`;
        const req = https.request(url, {
            headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}`, 'User-Agent': 'TodayRecovery/1.0' }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data).result || []); } catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}


async function runUUIDTester(recordId, virtualNumber, customerPhone, callTime, uuid, callInfo) {
    return new Promise((resolve) => {
        const jobData = {
            recordId,
            phoneMyUser: virtualNumber,
            phoneNumber: customerPhone,
            callTime,
            uuid,
            callInfo,
            skipDelay: true,
            analyzerScript: 'donation-analyzer.js',
            airtableConfig: {
                apiKey: AIRTABLE_API_KEY,
                baseId: AIRTABLE_BASE_ID,
                tableId: TELEMARKETING_TABLE,
                tableName: 'leads of Clients: Telemarketing',
                uuidField: 'UUID',
                callStatusField: 'call_status',
                callTimeField: 'call_time'
            }
        };

        const child = spawn('node', ['uuid-tester-tele.js'], {
            cwd: '/var/webhook-forwarder',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '', errors = '';
        child.stdout.on('data', d => { output += d; process.stdout.write('  > ' + d); });
        child.stderr.on('data', d => { errors += d; process.stderr.write('  ERR> ' + d); });
        child.on('close', code => resolve({ success: code === 0, output, errors, code }));
        child.on('error', err => resolve({ success: false, error: err.message, code: null }));

        setTimeout(() => {
            try { child.stdin.write(JSON.stringify(jobData)); child.stdin.end(); } catch {}
        }, 100);

        setTimeout(() => {
            try { child.kill(); } catch {}
            resolve({ success: false, error: 'timeout', code: null });
        }, 8 * 60 * 1000);
    });
}

async function main() {
    const today = process.argv[2] || getTodayDateString();

    console.log('\n🔄 === TODAY TELEMARKETING RECOVERY ===');
    console.log(`📅 Date: ${today}`);
    console.log(`⏰ Time: ${new Date().toISOString()}`);

    // שלב 1: שליפת רשומות Processing של היום
    console.log('\n📋 Step 1: Fetching today\'s Processing records...');
    const records = await fetchTodayProcessingRecords(today);
    console.log(`✅ Found ${records.length} Processing records for today`);

    if (records.length === 0) {
        console.log('✅ No stuck calls today!');
        return;
    }

    // קיבוץ לפי מספר וירטואלי
    const byVirtual = {};
    for (const rec of records) {
        const phone = formatPhone(rec.fields.phone_my_user);
        if (!phone) continue;
        if (!byVirtual[phone]) byVirtual[phone] = [];
        byVirtual[phone].push(rec);
    }

    console.log(`\n📞 Virtual numbers today: ${Object.keys(byVirtual).length}`);

    let totalSuccess = 0, totalFailed = 0, totalNoMatch = 0;

    for (const [virtualNumber, airtableRecs] of Object.entries(byVirtual)) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📞 Virtual: ${virtualNumber} | ${airtableRecs.length} records`);

        // שלב 2: שליפת CDR להיום
        console.log(`🔍 Fetching CDR for ${today}...`);
        const cdrCalls = await fetchCDRForDate(today, virtualNumber);
        console.log(`✅ Found ${cdrCalls.length} CDR calls`);

        if (cdrCalls.length === 0) {
            console.log(`❌ No CDR calls found`);
            totalNoMatch += airtableRecs.length;
            continue;
        }

        // מפה: user_phone → CDR (הארוך ביותר)
        const cdrByPhone = {};
        for (const cdr of cdrCalls) {
            if (cdr.user_phone) {
                const formatted = formatPhone(cdr.user_phone);
                if (formatted && (!cdrByPhone[formatted] || cdr.call_duration > cdrByPhone[formatted].call_duration)) {
                    cdrByPhone[formatted] = cdr;
                }
            }
        }

        // שלב 3: התאמה ועיבוד
        for (const rec of airtableRecs) {
            const customerPhone = formatPhone(rec.fields.phone_number);
            const donorName = rec.fields.donor_name || '?';

            console.log(`\n  👤 ${donorName} | ${rec.id} | ${customerPhone}`);

            const cdr = cdrByPhone[customerPhone];
            if (!cdr) {
                console.log(`  ❌ No CDR match for ${customerPhone}`);
                totalNoMatch++;
                continue;
            }

            console.log(`  ✅ CDR match: UUID=${cdr.cdr_uniqueid} duration=${cdr.call_duration}s`);

            const result = await runUUIDTester(
                rec.id, virtualNumber, customerPhone,
                cdr.start_call, cdr.cdr_uniqueid, cdr
            );

            if (result.success) {
                console.log(`  ✅ SUCCESS: ${rec.id}`);
                totalSuccess++;
            } else {
                console.log(`  ❌ FAILED: ${rec.id} (code ${result.code})`);
                totalFailed++;
            }

            if (airtableRecs.indexOf(rec) < airtableRecs.length - 1) {
                await sleep(DELAY_BETWEEN_RECORDS);
            }
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`\n📊 === TODAY RECOVERY SUMMARY ===`);
    console.log(`✅ Success:      ${totalSuccess}`);
    console.log(`❌ Failed:       ${totalFailed}`);
    console.log(`🔍 No CDR match: ${totalNoMatch}`);
    console.log(`📁 Total:        ${records.length}`);
    console.log(`⏰ Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
    console.error('💥 Fatal:', err.message);
    process.exit(1);
});
