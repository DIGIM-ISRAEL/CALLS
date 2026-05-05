// telemarketing-recovery.js
// שחזור 112 שיחות טלמרקטינג תקועות ב-Processing
// אסטרטגיה: לכל תאריך → שולף CDR → מתאים לפי user_phone → מריץ pipeline

const https = require('https');
const { spawn } = require('child_process');

const AIRTABLE_API_KEY = 'process.env.AIRTABLE_API_KEY';
const AIRTABLE_BASE_ID = 'app5pnaEc4UK3RUcP';
const TELEMARKETING_TABLE = 'tblcNkAMMCJQ3EVMl';
const MASKYOO_API_KEY = 'process.env.MASKYOO_API_KEY';
const DELAY_BETWEEN_RECORDS = 20000; // 20 שניות בין רשומות

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPhone(phone) {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('9720')) cleaned = '972' + cleaned.substring(4);
    if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
    if (!cleaned.startsWith('972')) cleaned = '972' + cleaned;
    return cleaned;
}

// שליפת כל רשומות Processing מ-Airtable
async function fetchProcessingRecords() {
    const records = [];
    let offset = '';
    const filter = encodeURIComponent("{call_status}='Processing'");

    do {
        const result = await new Promise((resolve) => {
            let path = `/v0/${AIRTABLE_BASE_ID}/${TELEMARKETING_TABLE}?filterByFormula=${filter}&pageSize=100&fields[]=phone_number&fields[]=phone_my_user&fields[]=call_time&fields[]=donor_name&fields[]=call_status`;
            if (offset) path += '&offset=' + offset;
            const req = https.request({ hostname: 'api.airtable.com', port: 443, path, headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }, (res) => {
                let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(JSON.parse(data)));
            });
            req.on('error', () => resolve({ records: [] }));
            req.end();
        });
        records.push(...(result.records || []));
        offset = result.offset || '';
    } while (offset);

    return records;
}

// שאילתת CDR לתאריך מסוים עם המספר הוירטואלי
async function fetchCDRForDate(date, virtualNumber) {
    return new Promise((resolve) => {
        const sql = `SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, cdr_ddi, user_phone, call_status FROM webserviceview WHERE start_call >= '${date} 00:00:00' AND start_call <= '${date} 23:59:59' AND cdr_ddi = '${virtualNumber}' AND end_call IS NOT NULL AND call_status = 'ANSWER' ORDER BY start_call ASC`;
        const params = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' });
        const url = `https://app.maskyoo.co.il/issa_153/api/?${params}`;
        const req = https.request(url, { headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}`, 'User-Agent': 'Recovery/1.0' } }, (res) => {
            let data = ''; res.on('data', c => data += c); res.on('end', () => {
                try { resolve(JSON.parse(data).result || []); } catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}

// הרצת uuid-tester עם UUID ידוע כבר (מדלג על שלב החיפוש)
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

        const child = spawn('node', ['uuid-tester.js'], { cwd: '/var/webhook-forwarder', stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '';
        child.stdout.on('data', d => { output += d; process.stdout.write('  > ' + d); });
        child.stderr.on('data', d => { errors += d; });
        child.on('close', code => resolve({ success: code === 0, output, errors, code }));
        child.on('error', err => resolve({ success: false, error: err.message }));

        setTimeout(() => {
            try { child.stdin.write(JSON.stringify(jobData)); child.stdin.end(); } catch {}
        }, 100);

        setTimeout(() => { try { child.kill(); } catch {} resolve({ success: false, error: 'timeout' }); }, 8 * 60 * 1000);
    });
}

async function main() {
    console.log('\n🔄 === TELEMARKETING RECOVERY ===');
    console.log('📅 Time:', new Date().toISOString());

    // שלב 1: שליפת כל רשומות Processing
    console.log('\n📋 Step 1: Fetching Processing records from Airtable...');
    const records = await fetchProcessingRecords();
    console.log(`✅ Found ${records.length} Processing records`);

    if (records.length === 0) {
        console.log('Nothing to do!');
        return;
    }

    // קיבוץ לפי virtual number + תאריך
    const byDateAndVirtual = {};
    for (const rec of records) {
        const phone = formatPhone(rec.fields.phone_my_user);
        const date = rec.fields.call_time;
        if (!phone || !date) continue;
        const key = `${date}|${phone}`;
        if (!byDateAndVirtual[key]) byDateAndVirtual[key] = [];
        byDateAndVirtual[key].push(rec);
    }

    console.log(`\n📅 Date/Virtual combinations: ${Object.keys(byDateAndVirtual).length}`);
    Object.entries(byDateAndVirtual).forEach(([k, v]) => console.log(`  ${k}: ${v.length} records`));

    let totalSuccess = 0, totalFailed = 0, totalNoMatch = 0;

    // שלב 2: לכל תאריך/מספר-וירטואלי, שלוף CDR ותאם
    for (const [key, airtableRecs] of Object.entries(byDateAndVirtual)) {
        const [date, virtualNumber] = key.split('|');
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📅 Processing date: ${date} | Virtual: ${virtualNumber} | ${airtableRecs.length} records`);

        // שלב 2: שליפת CDR
        console.log(`🔍 Fetching CDR...`);
        const cdrCalls = await fetchCDRForDate(date, virtualNumber);
        console.log(`✅ Found ${cdrCalls.length} CDR calls`);

        if (cdrCalls.length === 0) {
            console.log(`❌ No CDR calls found for ${date}`);
            totalNoMatch += airtableRecs.length;
            continue;
        }

        // בניית מפה: user_phone → CDR record
        const cdrByPhone = {};
        for (const cdr of cdrCalls) {
            if (cdr.user_phone) {
                const formatted = formatPhone(cdr.user_phone);
                if (formatted) {
                    if (!cdrByPhone[formatted] || cdr.call_duration > cdrByPhone[formatted].call_duration) {
                        cdrByPhone[formatted] = cdr;
                    }
                }
            }
        }
        console.log(`📞 CDR unique customers: ${Object.keys(cdrByPhone).length}`);

        // שלב 3: התאמה ועיבוד
        for (const rec of airtableRecs) {
            const customerPhone = formatPhone(rec.fields.phone_number);
            const donorName = rec.fields.donor_name || '?';

            console.log(`\n  👤 ${donorName} | ${rec.id} | ${customerPhone}`);

            const cdr = cdrByPhone[customerPhone];
            if (!cdr) {
                // נסה גם בפורמט מקומי (0...)
                const localPhone = customerPhone?.startsWith('972') ? '0' + customerPhone.substring(3) : null;
                const cdrLocal = localPhone ? cdrByPhone[localPhone] : null;

                if (!cdrLocal) {
                    console.log(`  ❌ No CDR match for ${customerPhone}`);
                    totalNoMatch++;
                    continue;
                }
            }

            const matchedCDR = cdr || cdrByPhone[customerPhone?.startsWith('972') ? '0' + customerPhone.substring(3) : ''];
            console.log(`  ✅ CDR match: UUID=${matchedCDR.cdr_uniqueid} duration=${matchedCDR.call_duration}s`);

            // שלב 4: הרצת pipeline
            const result = await runUUIDTester(
                rec.id,
                virtualNumber,
                customerPhone,
                matchedCDR.start_call,
                matchedCDR.cdr_uniqueid,
                matchedCDR
            );

            if (result.success) {
                console.log(`  ✅ SUCCESS: ${rec.id}`);
                totalSuccess++;
            } else {
                console.log(`  ❌ FAILED: ${rec.id} (code ${result.code})`);
                totalFailed++;
            }

            await sleep(DELAY_BETWEEN_RECORDS);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`\n📊 === RECOVERY SUMMARY ===`);
    console.log(`✅ Success: ${totalSuccess}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`🔍 No CDR match: ${totalNoMatch}`);
    console.log(`📁 Total: ${records.length}`);
    console.log(`⏰ Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
    console.error('💥 Fatal:', err.message);
    process.exit(1);
});
