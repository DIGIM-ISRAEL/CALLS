// reset-inprogress.js - מאפס רשומות in_progress חזרה ל-Processing
const https = require('https');
const AIRTABLE_API_KEY = 'process.env.AIRTABLE_API_KEY';
const AIRTABLE_BASE_ID = 'app5pnaEc4UK3RUcP';
const TELEMARKETING_TABLE = 'tblcNkAMMCJQ3EVMl';
const TODAY = process.argv[2] || '2026-04-26';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRecords(status) {
    const filter = encodeURIComponent(`AND({call_status}='${status}', IS_SAME({call_time}, '${TODAY}', 'day'))`);
    const records = [];
    let offset = '';
    do {
        const result = await new Promise((resolve) => {
            let path = `/v0/${AIRTABLE_BASE_ID}/${TELEMARKETING_TABLE}?filterByFormula=${filter}&pageSize=100&fields[]=call_status&fields[]=donor_name`;
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

async function resetRecord(recordId) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ fields: { call_status: 'Processing' } });
        const req = https.request({
            hostname: 'api.airtable.com', port: 443,
            path: `/v0/${AIRTABLE_BASE_ID}/${TELEMARKETING_TABLE}/${recordId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.write(body); req.end();
    });
}

async function main() {
    console.log(`\n🔄 Resetting in_progress records for ${TODAY}`);

    const records = await fetchRecords('in_progress');
    console.log(`Found ${records.length} in_progress records`);

    let ok = 0, fail = 0;
    for (const rec of records) {
        const success = await resetRecord(rec.id);
        if (success) {
            console.log(`  ✅ Reset: ${rec.id} (${rec.fields?.donor_name})`);
            ok++;
        } else {
            console.log(`  ❌ Failed: ${rec.id}`);
            fail++;
        }
        await sleep(200);
    }
    console.log(`\nDone: ${ok} reset, ${fail} failed`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
