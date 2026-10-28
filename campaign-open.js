#!/usr/bin/env node
// campaign-open.js — פתיחת קמפיין: סיווג Answered/No Answer מוגבל-תקופה
//
// בודק, עבור כל ליד בהיקף, האם נוצר קשר (ANSWER ב-CDR, מאומת VAD) *בתוך הטווח שנבחר*.
// ANSWER מחוץ לטווח לא נחשב → ליד שדיברת איתו בקמפיין קודם בלבד = "No Answer".
//
// שימוש:
//   node campaign-open.js --from 2026-06-01 --to 2026-06-30 [--filter "FORMULA"] [--force] [--limit 0] [--no-vad] [--concurrency 2]
//
// airtableConfig נטען מ-ENV (AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID, AIRTABLE_API_KEY)
// או מקובץ JSON שהנתיב אליו ב-ENV CAMPAIGN_CONFIG (שדות: baseId, tableId, apiKey).

const http = require('http');
const fs = require('fs');

const AC_BASE = process.env.ANSWER_CHECKER_BASE || 'http://127.0.0.1:3020';

function parseArgs(argv) {
    const a = {};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--force') a.force = true;
        else if (k === '--no-vad') a.skipVAD = true;
        else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
    }
    return a;
}

function loadConfig() {
    if (process.env.CAMPAIGN_CONFIG && fs.existsSync(process.env.CAMPAIGN_CONFIG)) {
        return JSON.parse(fs.readFileSync(process.env.CAMPAIGN_CONFIG, 'utf8'));
    }
    const { AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID, AIRTABLE_API_KEY } = process.env;
    if (AIRTABLE_BASE_ID && AIRTABLE_TABLE_ID && AIRTABLE_API_KEY) {
        return { baseId: AIRTABLE_BASE_ID, tableId: AIRTABLE_TABLE_ID, apiKey: AIRTABLE_API_KEY };
    }
    return null;
}

function req(method, path, payload) {
    return new Promise((resolve, reject) => {
        const u = new URL(AC_BASE + path);
        const body = payload ? JSON.stringify(payload) : null;
        const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: {} };
        if (body) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(body); }
        const r = http.request(opts, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const args = parseArgs(process.argv);
    if (!args.from || !args.to) { console.error('❌ נדרש --from YYYY-MM-DD ו---to YYYY-MM-DD'); process.exit(1); }
    const airtableConfig = loadConfig();
    if (!airtableConfig) { console.error('❌ חסר airtableConfig (ENV AIRTABLE_BASE_ID/TABLE_ID/API_KEY או CAMPAIGN_CONFIG)'); process.exit(1); }

    const payload = {
        airtableConfig,
        dateFrom: args.from,
        dateTo: args.to,
        filter: args.filter || '',
        limit: args.limit !== undefined ? parseInt(args.limit) : 0, // 0 = כל הרשומות
        force: !!args.force,
        skipVAD: !!args.skipVAD,
        concurrency: args.concurrency ? parseInt(args.concurrency) : 2
    };
    console.log(`🚀 פתיחת קמפיין: ${args.from} → ${args.to} | filter="${payload.filter}" | force=${payload.force} | vad=${!payload.skipVAD} | limit=${payload.limit || 'ALL'}`);

    const started = await req('POST', '/check-batch', payload);
    if (started.error) { console.error('❌', started.error); process.exit(1); }
    console.log('▶️ ', started.message || JSON.stringify(started));

    let last = -1;
    for (;;) {
        await sleep(5000);
        let s;
        try { s = await req('GET', '/status'); } catch (e) { console.log('… status unavailable, retrying'); continue; }
        if (s.scanning) { console.log('… scanning Airtable'); continue; }
        if (s.processed !== last) {
            console.log(`[${s.processed}/${s.total}] Answered=${s.answered} NoAnswer=${s.noAnswer} Unknown=${s.unknown} Skipped=${s.skipped} VAD=${s.vadUsed}`);
            last = s.processed;
        }
        if (!s.running) {
            console.log(`✅ סיום. Answered=${s.answered} NoAnswer=${s.noAnswer} Unknown=${s.unknown} Skipped=${s.skipped} VAD=${s.vadUsed}`);
            break;
        }
    }
})();
