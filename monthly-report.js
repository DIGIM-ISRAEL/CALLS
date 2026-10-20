// monthly-report.js
// דוח חודשי לטלמרקטינג: שיחות שנענו / לא נענו, תרומות ואחוזים - כללי ולפי טלפן
// שימוש: MASKYOO_API_KEY=... AIRTABLE_API_KEY=... node monthly-report.js [YYYY-MM]
// ברירת מחדל: החודש הנוכחי. פלט: טבלה בקונסול + monthly-report-YYYY-MM.csv
//
// מקורות:
//   מסקיו (CDR)  -> כמה שיחות יצאו, כמה נענו (call_status = ANSWER) וכמה לא, לפי מספר הטלפן (cdr_ddi)
//   Airtable      -> תרומות (decision = כן / donation_amount > 0), מקושרות לשיחה לפי UUID
//   telemarketing numbers -> מיפוי מספר -> שם טלפן

const https = require('https');
const fs = require('fs');

const MASKYOO_API_KEY = process.env.MASKYOO_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'app5pnaEc4UK3RUcP';
const TELEMARKETING_TABLE = 'tblcNkAMMCJQ3EVMl';
const NUMBERS_TABLE = 'tblS7Y5SXK1lGQLJu';
const MIN_ANSWER_SECONDS = Number(process.env.MIN_ANSWER_SECONDS || 0); // לסנן "ענו" קצרצרים (תא קולי וכד')

if (!MASKYOO_API_KEY || !AIRTABLE_API_KEY) {
    console.error('חסרים MASKYOO_API_KEY / AIRTABLE_API_KEY במשתני הסביבה');
    process.exit(1);
}

const month = process.argv[2] || new Date().toISOString().substring(0, 7);
const [year, mon] = month.split('-').map(Number);
const daysInMonth = new Date(year, mon, 0).getDate();
const pad = n => String(n).padStart(2, '0');

function formatPhone(phone) {
    if (!phone) return null;
    let c = String(phone).replace(/\D/g, '');
    if (c.startsWith('9720')) c = '972' + c.substring(4);
    if (c.startsWith('0')) c = '972' + c.substring(1);
    if (!c.startsWith('972')) c = '972' + c;
    return c;
}

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ─── Maskyoo CDR ────────────────────────────────────────────
async function queryCDR(sql) {
    const postData = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' }).toString();
    const json = await request({
        hostname: 'app.maskyoo.co.il', port: 443, path: '/issa_153/api/', method: 'POST',
        headers: {
            'Authorization': `Bearer ${MASKYOO_API_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, postData);
    return json.result || [];
}

// שליפה יום-יום כדי לא להיתקל במגבלות גודל תשובה
async function fetchMonthCDR(workerNumbers) {
    const inList = workerNumbers.map(n => `'${n}'`).join(',');
    const rows = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const day = `${month}-${pad(d)}`;
        const sql = `SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, cdr_ddi, user_phone, call_status FROM webserviceview WHERE start_call >= '${day} 00:00:00' AND start_call <= '${day} 23:59:59' AND cdr_ddi IN (${inList}) ORDER BY start_call ASC`;
        const dayRows = await queryCDR(sql);
        console.log(`  ${day}: ${dayRows.length} שיחות`);
        rows.push(...dayRows);
    }
    return rows;
}

// ─── Airtable ───────────────────────────────────────────────
async function airtableList(tableId, query) {
    const records = [];
    let offset = '';
    do {
        const path = `/v0/${BASE_ID}/${tableId}?${query}${offset ? '&offset=' + offset : ''}`;
        const res = await request({ hostname: 'api.airtable.com', port: 443, path, headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` } });
        if (res.error) throw new Error(`Airtable: ${JSON.stringify(res.error)}`);
        records.push(...(res.records || []));
        offset = res.offset || '';
    } while (offset);
    return records;
}

async function fetchWorkers() {
    const recs = await airtableList(NUMBERS_TABLE, 'pageSize=100');
    const map = {}; // virtual number -> worker name
    for (const r of recs) {
        const num = formatPhone(r.fields['number phone']);
        if (num) map[num] = r.fields['Worker name'] || num;
    }
    return map;
}

async function fetchDonationRecords() {
    const from = `${month}-01`;
    const nextMonth = mon === 12 ? `${year + 1}-01-01` : `${year}-${pad(mon + 1)}-01`;
    const formula = encodeURIComponent(`AND({call_time}>='${from}',{call_time}<'${nextMonth}')`);
    const fields = ['UUID', 'phone_my_user', 'call_time', 'call_status', 'decision', 'donation_amount']
        .map(f => `fields[]=${encodeURIComponent(f)}`).join('&');
    return airtableList(TELEMARKETING_TABLE, `filterByFormula=${formula}&pageSize=100&${fields}`);
}

const isDonation = f => f.decision === 'כן' || Number(f.donation_amount) > 0;

// ─── חישוב ──────────────────────────────────────────────────
function emptyStats() { return { total: 0, answered: 0, notAnswered: 0, donations: 0, amount: 0 }; }

async function main() {
    console.log(`📊 דוח טלמרקטינג ${month}`);

    console.log('👥 שולף טלפנים...');
    const workers = await fetchWorkers();
    const numbers = Object.keys(workers);
    console.log(`  ${numbers.length} טלפנים`);

    console.log('📞 שולף CDR ממסקיו...');
    const cdr = await fetchMonthCDR(numbers);

    console.log('💰 שולף תרומות מ-Airtable...');
    const atRecords = await fetchDonationRecords();
    const donationByUuid = {};
    let donationsWithoutUuid = [];
    for (const r of atRecords) {
        if (!isDonation(r.fields)) continue;
        if (r.fields.UUID) donationByUuid[r.fields.UUID] = r.fields;
        else donationsWithoutUuid.push(r.fields);
    }

    const byWorker = {};
    const overall = emptyStats();
    const matchedUuids = new Set();

    for (const row of cdr) {
        const name = workers[formatPhone(row.cdr_ddi)] || row.cdr_ddi;
        const s = byWorker[name] || (byWorker[name] = emptyStats());
        const answered = row.call_status === 'ANSWER' && Number(row.call_duration || 0) >= MIN_ANSWER_SECONDS;
        for (const st of [s, overall]) {
            st.total++;
            if (answered) st.answered++; else st.notAnswered++;
        }
        const donation = donationByUuid[row.cdr_uniqueid];
        if (donation) {
            matchedUuids.add(row.cdr_uniqueid);
            for (const st of [s, overall]) {
                st.donations++;
                st.amount += Number(donation.donation_amount) || 0;
            }
        }
    }

    const unmatched = Object.keys(donationByUuid).length - matchedUuids.size + donationsWithoutUuid.length;

    // ─── הצגה ───
    const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '-';
    const toRow = (name, s) => ({
        'טלפן': name,
        'סה"כ שיחות': s.total,
        'נענו': s.answered,
        'לא נענו': s.notAnswered,
        '% נענו': pct(s.answered, s.total),
        'תרומות': s.donations,
        '% תרומות מהנענו': pct(s.donations, s.answered),
        '% תרומות מסה"כ': pct(s.donations, s.total),
        'סכום (₪)': s.amount
    });
    const rows = Object.entries(byWorker)
        .sort((a, b) => b[1].donations - a[1].donations || b[1].total - a[1].total)
        .map(([n, s]) => toRow(n, s));
    rows.push(toRow('סה"כ', overall));

    console.log('\n' + '='.repeat(60));
    console.table(rows);
    if (unmatched) console.log(`⚠️ ${unmatched} תרומות ב-Airtable לא הותאמו לשיחה במסקיו (אין UUID / שיחה לא נמצאה) - לא נספרו`);
    if (MIN_ANSWER_SECONDS) console.log(`ℹ️ "נענה" = ANSWER ומשך לפחות ${MIN_ANSWER_SECONDS} שניות`);

    const csv = [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(','))].join('\n');
    const file = `monthly-report-${month}.csv`;
    fs.writeFileSync(file, '﻿' + csv);
    console.log(`📁 נשמר ב-${file}`);
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
