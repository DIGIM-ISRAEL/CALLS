// test-3calls.js - process first 3 CDR-matched records for today
const https = require('https');
const { spawn } = require('child_process');

const AIRTABLE_API_KEY = 'process.env.AIRTABLE_API_KEY';
const AIRTABLE_BASE_ID = 'app5pnaEc4UK3RUcP';
const TELEMARKETING_TABLE = 'tblcNkAMMCJQ3EVMl';
const MASKYOO_API_KEY = 'process.env.MASKYOO_API_KEY';
const MAX_CALLS = parseInt(process.argv[2]) || 3;
const TODAY = '2026-04-26';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPhone(phone) {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('9720')) cleaned = '972' + cleaned.substring(4);
    if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
    if (!cleaned.startsWith('972')) cleaned = '972' + cleaned;
    return cleaned;
}

async function fetchRecords(status) {
    const filter = encodeURIComponent(`AND({call_status}='${status}', IS_SAME({call_time}, '${TODAY}', 'day'))`);
    const records = [];
    let offset = '';
    do {
        const result = await new Promise((resolve) => {
            let path = `/v0/${AIRTABLE_BASE_ID}/${TELEMARKETING_TABLE}?filterByFormula=${filter}&pageSize=100&fields[]=phone_number&fields[]=phone_my_user&fields[]=call_time&fields[]=donor_name&fields[]=call_status`;
            if (offset) path += '&offset=' + offset;
            const req = https.request({ hostname: 'api.airtable.com', port: 443, path, headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } }, (res) => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ records: [] }); } });
            });
            req.on('error', () => resolve({ records: [] }));
            req.end();
        });
        records.push(...(result.records || []));
        offset = result.offset || '';
    } while (offset);
    return records;
}

async function fetchCDR(date, virtualNumber) {
    return new Promise((resolve) => {
        const sql = `SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, cdr_ddi, user_phone, call_status FROM webserviceview WHERE start_call >= '${date} 00:00:00' AND start_call <= '${date} 23:59:59' AND cdr_ddi = '${virtualNumber}' AND end_call IS NOT NULL AND call_status = 'ANSWER' ORDER BY start_call ASC`;
        const params = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' });
        const url = `https://app.maskyoo.co.il/issa_153/api/?${params}`;
        const req = https.request(url, { headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}`, 'User-Agent': 'Test3Calls/1.0' } }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).result || []); } catch { resolve([]); } });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}

async function runUUIDTester(recordId, virtualNumber, customerPhone, callTime, uuid, callInfo) {
    return new Promise((resolve) => {
        const jobData = {
            recordId, phoneMyUser: virtualNumber, phoneNumber: customerPhone,
            callTime, uuid, callInfo, skipDelay: true,
            analyzerScript: 'donation-analyzer.js',
            airtableConfig: {
                apiKey: AIRTABLE_API_KEY, baseId: AIRTABLE_BASE_ID, tableId: TELEMARKETING_TABLE,
                tableName: 'leads of Clients: Telemarketing', uuidField: 'UUID',
                callStatusField: 'call_status', callTimeField: 'call_time'
            }
        };
        const child = spawn('node', ['uuid-tester-tele.js'], { cwd: '/var/webhook-forwarder', stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '';
        child.stdout.on('data', d => { output += d; process.stdout.write('  > ' + d); });
        child.stderr.on('data', d => { errors += d; process.stderr.write('  ERR> ' + d); });
        child.on('close', code => resolve({ success: code === 0, output, errors, code }));
        child.on('error', err => resolve({ success: false, error: err.message }));
        setTimeout(() => { try { child.stdin.write(JSON.stringify(jobData)); child.stdin.end(); } catch {} }, 100);
        setTimeout(() => { try { child.kill(); } catch {} resolve({ success: false, error: 'timeout' }); }, 8 * 60 * 1000);
    });
}

async function main() {
    console.log(`\n🧪 === TEST: First ${MAX_CALLS} matched calls for ${TODAY} ===\n`);

    const records = await fetchRecords('Processing');
    console.log(`Found ${records.length} Processing records`);

    // group by virtual
    const byVirtual = {};
    for (const rec of records) {
        const phone = formatPhone(rec.fields.phone_my_user);
        if (!phone) continue;
        if (!byVirtual[phone]) byVirtual[phone] = [];
        byVirtual[phone].push(rec);
    }

    let processed = 0;
    for (const [virtualNumber, airtableRecs] of Object.entries(byVirtual)) {
        if (processed >= MAX_CALLS) break;
        console.log(`\n📞 Virtual: ${virtualNumber}`);
        const cdrCalls = await fetchCDR(TODAY, virtualNumber);
        console.log(`CDR: ${cdrCalls.length} calls`);

        const cdrByPhone = {};
        for (const cdr of cdrCalls) {
            if (cdr.user_phone) {
                const fmt = formatPhone(cdr.user_phone);
                if (fmt && (!cdrByPhone[fmt] || cdr.call_duration > cdrByPhone[fmt].call_duration))
                    cdrByPhone[fmt] = cdr;
            }
        }

        for (const rec of airtableRecs) {
            if (processed >= MAX_CALLS) break;
            const customerPhone = formatPhone(rec.fields.phone_number);
            const cdr = cdrByPhone[customerPhone];
            if (!cdr) continue;

            console.log(`\n${'='.repeat(60)}`);
            console.log(`👤 ${rec.fields.donor_name} | ${rec.id}`);
            console.log(`📞 ${customerPhone} | UUID=${cdr.cdr_uniqueid} | ${cdr.call_duration}s`);
            console.log(`🕐 ${cdr.start_call} → ${cdr.end_call}`);
            console.log(`${'='.repeat(60)}`);

            const result = await runUUIDTester(rec.id, virtualNumber, customerPhone, cdr.start_call, cdr.cdr_uniqueid, cdr);
            console.log(`\n${result.success ? '✅ SUCCESS' : '❌ FAILED'} (exit code ${result.code})`);
            processed++;

            if (processed < MAX_CALLS) await sleep(3000);
        }
    }
    console.log(`\n✅ Done. Processed ${processed} calls.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
