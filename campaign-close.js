#!/usr/bin/env node
// campaign-close.js — סגירת קמפיין: מרוקן call_status (ל-null) לכל ליד שחויג בטווח (לפי call_time),
// כדי שה-power-dialer יחייג אליו מחדש בקמפיין חדש. תמלול/ניתוח לא נמחקים.
//
// שימוש:
//   node campaign-close.js --from 2026-06-01 --to 2026-06-30 [--dry]
//
// תמיד הרץ קודם עם --dry כדי לראות כמה רשומות יושפעו לפני המחיקה בפועל.
//
// airtableConfig כמו ב-campaign-open.js (ENV AIRTABLE_BASE_ID/TABLE_ID/API_KEY או CAMPAIGN_CONFIG).

const http = require('http');
const fs = require('fs');

const AC_BASE = process.env.ANSWER_CHECKER_BASE || 'http://127.0.0.1:3020';

function parseArgs(argv) {
    const a = {};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--dry') a.dry = true;
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

function post(path, payload) {
    return new Promise((resolve, reject) => {
        const u = new URL(AC_BASE + path);
        const body = JSON.stringify(payload);
        const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
        const r = http.request(opts, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
        });
        r.on('error', reject);
        r.write(body);
        r.end();
    });
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.from || !args.to) { console.error('❌ נדרש --from YYYY-MM-DD ו---to YYYY-MM-DD'); process.exit(1); }
    const airtableConfig = loadConfig();
    if (!airtableConfig) { console.error('❌ חסר airtableConfig (ENV או CAMPAIGN_CONFIG)'); process.exit(1); }

    const dryRun = !!args.dry;
    console.log(`🧹 סגירת קמפיין (${dryRun ? 'DRY RUN — ספירה בלבד' : 'מבצע מחיקה'}): call_time ${args.from} → ${args.to}`);

    const r = await post('/reset-batch', { airtableConfig, dateFrom: args.from, dateTo: args.to, dryRun });
    if (r.error) { console.error('❌', r.error); process.exit(1); }
    console.log(`📊 נסרקו ${r.scanned} רשומות; ${r.matched} עם call_time בטווח ועם סטטוס קיים.`);
    if (dryRun) {
        console.log('ℹ️ DRY RUN — לא נמחק כלום. הרץ שוב בלי --dry כדי לאפס בפועל.');
    } else {
        console.log(`⏳ האיפוס רץ בשרת (${r.matched} רשומות). עקוב בלוגים: pm2 logs answer-checker`);
    }
})();
