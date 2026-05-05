// recovery-analyzer.js
// מעבד מחדש הקלטות שנכשל ניתוחן בגלל מכסת OpenAI
// שימוש: node recovery-analyzer.js [fromDate]
// דוגמה: node recovery-analyzer.js 2026-03-13

const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const RECORDINGS_DIR = '/var/webhook-forwarder/recordings';
const MASKYOO_API_KEY = 'process.env.MASKYOO_API_KEY';

const AIRTABLE_CONFIG = {
    apiKey: 'process.env.AIRTABLE_API_KEY',
    baseId: 'app5pnaEc4UK3RUcP',
    mainTableId: 'tblABFOvI4cQSz3sg',
    donationTableId: 'tblcNkAMMCJQ3EVMl'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// פירוש שם קובץ הקלטה לתאריך/שעה
// פורמט: recording_YYYY-MM-DD_HH-MM-SS.mp3
// CDR מאחסן זמן ישראלי - מחזיר מחרוזת ישראלית ישירות
function parseFilenameToDate(filename) {
    const match = filename.match(/recording_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp3/);
    if (!match) return null;
    const [, date, hh, mm, ss] = match;
    // CDR stores Israeli time, so return as Israeli time string
    return { israeliStr: `${date} ${hh}:${mm}:${ss}`, date, hh, mm, ss };
}

// שאילתת CDR ממסקיו
async function queryCDR(sql) {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            service: 'cdr_query',
            sql,
            format: 'json'
        }).toString();

        const options = {
            hostname: 'app.maskyoo.co.il',
            port: 443,
            path: '/issa_153/api/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MASKYOO_API_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data).result || []); }
                catch (e) { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.write(postData);
        req.end();
    });
}

// חיפוש UUID לפי טווח זמן (CDR מאחסן זמן ישראלי)
async function findUUIDByTime(parsed) {
    // חישוב ±3 דקות בזמן ישראלי
    const baseDate = new Date(`${parsed.date}T${parsed.hh}:${parsed.mm}:${parsed.ss}+03:00`);
    const startTime = new Date(baseDate.getTime() - 3 * 60000);
    const endTime = new Date(baseDate.getTime() + 3 * 60000);

    // המרה לפורמט ישראלי (CDR uses Israeli time)
    const toIsraeli = (d) => {
        const il = new Date(d.getTime()); // already in Israeli context
        return new Date(d.getTime() + 3 * 60 * 60 * 1000)
            .toISOString().replace('T', ' ').substring(0, 19);
    };

    const startStr = toIsraeli(startTime);
    const endStr = toIsraeli(endTime);

    const sql = `SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, user_phone, call_status
        FROM webserviceview
        WHERE start_call >= '${startStr}'
        AND start_call <= '${endStr}'
        AND end_call IS NOT NULL
        ORDER BY start_call DESC LIMIT 5`;

    console.log(`  📅 CDR search: ${startStr} → ${endStr}`);
    return await queryCDR(sql);
}

// חיפוש רשומה באיירטייבל לפי UUID
async function findAirtableRecord(uuid, tableId) {
    return new Promise((resolve) => {
        const filter = encodeURIComponent(`{UUID}="${uuid}"`);
        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${AIRTABLE_CONFIG.baseId}/${tableId}?filterByFormula=${filter}&maxRecords=1`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_CONFIG.apiKey}`,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    const records = result.records || [];
                    resolve(records.length > 0 ? records[0] : null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

// הרצת ניתוח על הקלטה
async function runAnalysis(filename, recordId, callInfo, airtableConfig, analyzerScript) {
    return new Promise((resolve) => {
        console.log(`\n🧠 Running ${analyzerScript} for ${filename}...`);

        const jobData = {
            uuid: callInfo.cdr_uniqueid,
            callInfo: callInfo,
            recordId: recordId,
            airtableConfig: airtableConfig,
            recording: {
                filename: filename,
                filePath: `${RECORDINGS_DIR}/${filename}`
            }
        };

        const analyzer = spawn('node', [analyzerScript], {
            cwd: '/var/webhook-forwarder',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        analyzer.stdin.write(JSON.stringify(jobData));
        analyzer.stdin.end();

        let output = '';
        analyzer.stdout.on('data', d => { output += d.toString(); });
        analyzer.stderr.on('data', d => { console.error(`  ⚠️ ${d.toString().trim()}`); });

        analyzer.on('close', (code) => {
            console.log(`  📋 Analyzer finished with code: ${code}`);
            resolve({ success: code === 0, output });
        });

        // timeout 5 דקות לכל הקלטה
        setTimeout(() => {
            analyzer.kill();
            resolve({ success: false, error: 'timeout' });
        }, 5 * 60 * 1000);
    });
}

async function main() {
    const fromDateArg = process.argv[2] || '2026-03-13';
    console.log(`\n🔄 === RECOVERY ANALYZER ===`);
    console.log(`📅 Processing recordings from: ${fromDateArg}`);

    // קבלת כל קבצי ההקלטה
    const allFiles = fs.readdirSync(RECORDINGS_DIR)
        .filter(f => f.endsWith('.mp3'))
        .sort();

    // סינון לפי תאריך (השוואת מחרוזת - פורמט YYYY-MM-DD עובד ישירות)
    const targetFiles = allFiles.filter(filename => {
        const match = filename.match(/recording_(\d{4}-\d{2}-\d{2})_/);
        return match && match[1] >= fromDateArg;
    });

    console.log(`📁 Found ${targetFiles.length} recordings from ${fromDateArg} onwards`);
    console.log(`📁 Files: ${targetFiles.join(', ')}\n`);

    let processed = 0, skipped = 0, failed = 0;

    for (const filename of targetFiles) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📁 Processing: ${filename}`);

        const parsedDate = parseFilenameToDate(filename);
        if (!parsedDate) {
            console.log(`⏭️ Could not parse date from filename, skipping`);
            skipped++;
            continue;
        }

        // שלב 1: חיפוש UUID מ-CDR
        console.log(`🔍 Searching CDR for calls around ${parsedDate.israeliStr} (Israeli time)...`);
        const cdrResults = await findUUIDByTime(parsedDate);

        if (cdrResults.length === 0) {
            console.log(`❌ No CDR records found for this time range`);
            failed++;
            continue;
        }

        console.log(`✅ Found ${cdrResults.length} CDR records`);

        let foundRecord = null;
        let foundUUID = null;
        let foundCallInfo = null;
        let analyzerScript = 'speech-analyzer.js';
        let tableConfig = null;

        // שלב 2: חיפוש רשומת איירטייבל
        for (const cdr of cdrResults) {
            const uuid = cdr.cdr_uniqueid;
            console.log(`  🔍 Checking UUID: ${uuid}`);

            // ניסיון בטבלה הראשית
            let record = await findAirtableRecord(uuid, AIRTABLE_CONFIG.mainTableId);
            if (record) {
                const hasTranscript = record.fields['Call Transcript'] && record.fields['Call Transcript'].length > 10;
                if (hasTranscript) {
                    console.log(`  ✅ Already analyzed (main table), skipping`);
                    foundRecord = 'already_done';
                    break;
                }
                console.log(`  ✅ Found in main table: ${record.id}`);
                foundRecord = record.id;
                foundUUID = uuid;
                foundCallInfo = cdr;
                analyzerScript = 'speech-analyzer.js';
                tableConfig = {
                    ...AIRTABLE_CONFIG,
                    tableId: AIRTABLE_CONFIG.mainTableId
                };
                break;
            }

            // ניסיון בטבלת תרומות
            record = await findAirtableRecord(uuid, AIRTABLE_CONFIG.donationTableId);
            if (record) {
                const hasTranscript = record.fields['call_transcript'] && record.fields['call_transcript'].length > 10;
                if (hasTranscript) {
                    console.log(`  ✅ Already analyzed (donation table), skipping`);
                    foundRecord = 'already_done';
                    break;
                }
                console.log(`  ✅ Found in donation table: ${record.id}`);
                foundRecord = record.id;
                foundUUID = uuid;
                foundCallInfo = cdr;
                analyzerScript = 'donation-analyzer.js';
                tableConfig = {
                    ...AIRTABLE_CONFIG,
                    tableId: AIRTABLE_CONFIG.donationTableId
                };
                break;
            }

            await sleep(200); // לא להציף את ה-API
        }

        if (!foundRecord) {
            console.log(`❌ No matching Airtable record found`);
            failed++;
            continue;
        }

        if (foundRecord === 'already_done') {
            skipped++;
            continue;
        }

        // שלב 3: הרצת ניתוח
        const result = await runAnalysis(filename, foundRecord, foundCallInfo, tableConfig, analyzerScript);

        if (result.success) {
            console.log(`✅ Analysis complete for ${filename}`);
            processed++;
        } else {
            console.log(`❌ Analysis failed for ${filename}`);
            failed++;
        }

        // המתנה קצרה בין הקלטות כדי לא להציף OpenAI
        await sleep(3000);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`\n📊 === RECOVERY SUMMARY ===`);
    console.log(`✅ Processed successfully: ${processed}`);
    console.log(`⏭️ Skipped (already done): ${skipped}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📁 Total: ${targetFiles.length}`);
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
