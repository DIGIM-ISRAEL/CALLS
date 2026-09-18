// shift-gap-analyzer.js
// ניתוח פערים בין המוסד שנרשם במשמרת לבין המוסד/ות שעליהם הטלפן/ית עבד/ה בפועל.
//
// הרעיון:
//   * ב-Airtable כל שיחה שבוצעה מקבלת UUID מ-maskyoo בפורמט "<unix>.<seq>".
//     החלק השלם של ה-UUID הוא חותמת הזמן המדויקת (שנייה) של תחילת השיחה.
//     => אפשר לשחזר שעה מדויקת לכל שיחה בלי לפנות שוב ל-maskyoo.
//   * לכל ליד יש קישור ל-"telemarketing clients" (המוסד/לקוח שאליו הליד שייך)
//     => זהו המוסד שעליו עבדו בפועל באותה שיחה.
//   * שיוך טלפן: השדה "Donation Credited To" (אימייל) מזהה מי זיכה תרומה.
//     מתוך התרומות בונים מפה (תאריך, phone_my_user) -> טלפן, ואז משייכים גם
//     שיחות ללא מענה (שאין בהן זיכוי) לפי מספר החיוג של אותו יום = כיסוי מלא.
//
// דרישות: משתני סביבה AIRTABLE_API_KEY. (אין צורך ב-maskyoo — הזמן מוטמע ב-UUID.)
//
// הרצה:
//   node shift-gap-analyzer.js --shifts shifts.csv --start 2026-08-01 --end 2026-10-01
//   הוסף --write-airtable כדי לכתוב לטבלת "Shift Gaps".
//   הוסף גם --replace כדי לנקות את הטבלה הקיימת לפני הכתיבה (מונע כפילויות).
//
// פורמט ה-CSV של המשמרות (עם כותרות, כפי שמיוצא ממערכת המשמרות):
//   עובד,אימייל,תאריך,כניסה,יציאה,משך (שעות),מוסד,auto-stopped,override

const https = require('https');
const fs = require('fs');

// ─── קונפיגורציה ───────────────────────────────────────────────
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'app5pnaEc4UK3RUcP';
const LEADS_TABLE = 'tblcNkAMMCJQ3EVMl';       // Telemarketing
const GAPS_TABLE  = 'tbli1dMmNsZjgyrjH';       // Shift Gaps

// שדות בטבלת ה-Telemarketing
const F = {
    phoneMyUser: 'phone_my_user',
    callTime:    'call_time',       // תאריך בלבד (ללא שעה) — משמש רק כפילטר גס
    uuid:        'UUID',            // "<unix>.<seq>" — הזמן המדויק
    client:      'telemarketing clients',
    creditedTo:  'Donation Credited To',
};

// שיוך אימייל <-> שם טלפן (מתוך ה-CSV; ניתן להרחבה)
const NAME_BY_EMAIL = {
    'efratbenzaken68@gmail.com': 'אפרת בן זקן',
    'sagicohen1204@gmail.com':   'שגיא כהן',
    'shira3463@gmail.com':       'שירה סמחוב',
    'creative@digim.co.il':      'שרה עייאש',
    'hadassah.edri123@gmail.com':'הדסה בן הרוש',
};
const EMAIL_BY_NAME = Object.fromEntries(Object.entries(NAME_BY_EMAIL).map(([e, n]) => [n, e]));

// כינויים: שמות שהם אותו מוסד/קמפיין בפועל תחת תיוג שונה.
// כל קבוצה מנורמלת לשם הראשון => נחשב התאמה מלאה, לא פער.
const ALIASES = [
    ['רועי אמגר - מתחברות', 'גמח עריסות - מתחברת'],  // אושר: אותו מוסד
];
function canon(name) {
    for (const g of ALIASES) if (g.includes(name)) return g[0];
    return name;
}
function sameInst(a, b) { return canon(a) === canon(b); }

// ─── עזרי זמן ──────────────────────────────────────────────────
// חילוץ תאריך+דקה בשעון ישראל מתוך UUID
function ilFromUuid(uuid) {
    const ts = parseInt(String(uuid).split('.')[0], 10);
    if (!ts) return null;
    const s = new Date(ts * 1000).toLocaleString('en-GB', {
        timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const m = s.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s(\d{2}):(\d{2})/);
    if (!m) return null;
    return { day: `${m[3]}-${m[2]}-${m[1]}`, min: (+m[4]) * 60 + (+m[5]), hhmm: `${m[4]}:${m[5]}` };
}
function toMin(t) { const [h, m] = String(t).split(':'); return (+h) * 60 + (+m); }
function slotLabel(min) { const h = Math.floor(min / 60); return `${String(h).padStart(2, '0')}:${min % 60 < 30 ? '00' : '30'}`; }

// ─── Airtable REST ─────────────────────────────────────────────
function airtableGet(path) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.airtable.com', port: 443, path,
            headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode !== 200) return reject(new Error('Airtable ' + res.statusCode + ': ' + d));
                    resolve(j);
                } catch (e) { reject(new Error('Bad JSON: ' + d)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}
function airtableDelete(table, ids) {
    return new Promise((resolve, reject) => {
        const qs = ids.map(id => 'records[]=' + encodeURIComponent(id)).join('&');
        const req = https.request({
            hostname: 'api.airtable.com', port: 443,
            path: `/v0/${BASE_ID}/${table}?${qs}`, method: 'DELETE',
            headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error('Airtable DELETE ' + res.statusCode + ': ' + d)));
        });
        req.on('error', reject);
        req.end();
    });
}
async function clearTable(table) {
    let offset = '', ids = [];
    do {
        let path = `/v0/${BASE_ID}/${table}?pageSize=100&fields[]=Worker`;
        if (offset) path += '&offset=' + encodeURIComponent(offset);
        const res = await airtableGet(path);
        ids.push(...(res.records || []).map(r => r.id));
        offset = res.offset || '';
    } while (offset);
    for (let i = 0; i < ids.length; i += 10) await airtableDelete(table, ids.slice(i, i + 10));
    return ids.length;
}
function airtablePost(table, records) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ records, typecast: true });
        const req = https.request({
            hostname: 'api.airtable.com', port: 443,
            path: `/v0/${BASE_ID}/${table}`, method: 'POST',
            headers: {
                Authorization: `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(JSON.parse(d));
                else reject(new Error('Airtable POST ' + res.statusCode + ': ' + d));
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

// שליפת כל השיחות שבוצעו בטווח (עם UUID) — עמוד אחר עמוד
async function fetchCalls(startDate, endDate) {
    const bufferStart = new Date(startDate); bufferStart.setDate(bufferStart.getDate() - 2);
    const bufferEnd   = new Date(endDate);   bufferEnd.setDate(bufferEnd.getDate() + 2);
    const fmt = d => d.toISOString().slice(0, 10);
    const formula = `AND({${F.uuid}}!='', IS_AFTER({${F.callTime}},'${fmt(bufferStart)}'), IS_BEFORE({${F.callTime}},'${fmt(bufferEnd)}'))`;
    const fields = [F.phoneMyUser, F.uuid, F.client, F.creditedTo]
        .map(f => 'fields[]=' + encodeURIComponent(f)).join('&');
    const out = [];
    let offset = '';
    do {
        let path = `/v0/${BASE_ID}/${LEADS_TABLE}?pageSize=100&${fields}` +
            `&filterByFormula=${encodeURIComponent(formula)}`;
        if (offset) path += '&offset=' + encodeURIComponent(offset);
        const res = await airtableGet(path);
        for (const r of res.records || []) {
            const fl = r.fields || {};
            const uuid = fl[F.uuid];
            const t = ilFromUuid(uuid);
            if (!t) continue;
            const clientArr = fl[F.client];
            const inst = Array.isArray(clientArr) && clientArr.length
                ? (clientArr[0].name || clientArr[0]) : (fl[F.client] || '(ריק)');
            out.push({
                phone: String(fl[F.phoneMyUser] || '').replace(/\D/g, ''),
                credited: fl[F.creditedTo] || null,
                inst, day: t.day, min: t.min, hhmm: t.hhmm,
            });
        }
        offset = res.offset || '';
    } while (offset);
    return out;
}

// ─── טעינת CSV משמרות ──────────────────────────────────────────
function splitCsv(line) {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur); return out.map(s => s.trim());
}
function normDate(d) { const [dd, mm, yy] = d.split('.'); return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; }
function loadShifts(path) {
    const lines = fs.readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(1);
    return lines.map(splitCsv).filter(r => r.length >= 7 && r[0]).map(r => ({
        worker: r[0], email: EMAIL_BY_NAME[r[0]] || r[1], date: normDate(r[2]),
        inStart: r[3], inEnd: r[4], startMin: toMin(r[3]), endMin: toMin(r[4]),
        hours: parseFloat(r[5]) || 0, marked: r[6] || '(ריק)',
    }));
}

// ─── ניתוח ─────────────────────────────────────────────────────
function analyze(shifts, calls) {
    // מפה: (תאריך|טלפון) -> טלפן, מתוך זיכויי תרומות
    const dayPhoneOp = {};
    // מפה גלובלית: טלפון -> קבוצת טלפנים (לגיבוי אם אין זיכוי באותו יום)
    const phoneOps = {};
    for (const c of calls) {
        if (c.credited && NAME_BY_EMAIL[c.credited]) {
            dayPhoneOp[`${c.day}|${c.phone}`] = c.credited;
            (phoneOps[c.phone] = phoneOps[c.phone] || new Set()).add(c.credited);
        }
    }
    const opOfCall = c => {
        const direct = dayPhoneOp[`${c.day}|${c.phone}`];
        if (direct) return direct;
        const set = phoneOps[c.phone];
        if (set && set.size === 1) return [...set][0];   // גיבוי חד-משמעי
        return null;                                     // לא ניתן לשייך
    };

    const results = [];
    for (const s of shifts) {
        const inWin = calls.filter(c =>
            c.day === s.date && c.min >= s.startMin - 5 && c.min <= s.endMin + 5 &&
            opOfCall(c) === s.email);
        const byInst = {}; inWin.forEach(c => byInst[c.inst] = (byInst[c.inst] || 0) + 1);
        const actual = Object.keys(byInst);
        const slots = {};
        inWin.forEach(c => { const k = slotLabel(c.min); (slots[k] = slots[k] || {})[c.inst] = (slots[k][c.inst] || 0) + 1; });
        const timeline = Object.keys(slots).sort().map(k => ({ slot: k, inst: slots[k] }));
        const sorted = inWin.slice().sort((a, b) => a.min - b.min);

        let status;
        if (inWin.length === 0) status = 'no_evidence';
        else if (actual.every(a => sameInst(a, s.marked))) status = 'match';
        else if (actual.some(a => sameInst(a, s.marked))) status = 'partial_mismatch';
        else status = 'mismatch';

        results.push({
            worker: s.worker, email: s.email, date: s.date, marked: s.marked,
            shiftStart: s.inStart, shiftEnd: s.inEnd, callCount: inWin.length,
            actual, byInst, timeline, status,
            firstCall: sorted.length ? sorted[0].hhmm : null,
            lastCall: sorted.length ? sorted[sorted.length - 1].hhmm : null,
        });
    }
    return results;
}

// ─── כתיבה ל-Airtable ("Shift Gaps") ───────────────────────────
const STATUS_HE = { mismatch: 'פער מלא', partial_mismatch: 'פער חלקי', naming_review: 'בדיקת שם' };
function gapRow(r) {
    const actualStr = Object.entries(r.byInst).map(([k, v]) => `${k} (${v})`).join(' | ');
    const timelineStr = r.timeline.map(s => {
        const top = Object.entries(s.inst).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(',');
        return `${s.slot}→${top}`;
    }).join('\n');
    return {
        fields: {
            'Worker': r.worker, 'Date': r.date, 'Shift Start': r.shiftStart, 'Shift End': r.shiftEnd,
            'Marked Institution': r.marked, 'Actual Institutions': actualStr,
            'Status': STATUS_HE[r.status], 'Donations In Window': r.callCount,
            'First Call': r.firstCall || '', 'Last Call': r.lastCall || '',
            'Half-Hour Timeline': timelineStr,
        },
    };
}
async function writeGaps(results) {
    const gaps = results.filter(r => STATUS_HE[r.status]);
    const rows = gaps.map(gapRow);
    for (let i = 0; i < rows.length; i += 10) {
        await airtablePost(GAPS_TABLE, rows.slice(i, i + 10));
    }
    return gaps.length;
}

// ─── CLI ───────────────────────────────────────────────────────
function arg(name, def) { const i = process.argv.indexOf('--' + name); return i !== -1 ? process.argv[i + 1] : def; }
async function main() {
    if (!AIRTABLE_API_KEY) { console.error('חסר AIRTABLE_API_KEY בסביבה'); process.exit(1); }
    const shiftsPath = arg('shifts');
    if (!shiftsPath) { console.error('שימוש: node shift-gap-analyzer.js --shifts <csv> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--write-airtable]'); process.exit(1); }
    const start = arg('start', '2026-08-01');
    const end   = arg('end', '2026-10-01');
    const doWrite = process.argv.includes('--write-airtable');

    console.log(`טוען משמרות מ-${shiftsPath} ...`);
    const shifts = loadShifts(shiftsPath);
    console.log(`  ${shifts.length} שורות משמרת`);

    console.log(`שולף שיחות מ-Airtable לטווח ${start}..${end} ...`);
    const calls = await fetchCalls(new Date(start), new Date(end));
    console.log(`  ${calls.length} שיחות עם UUID`);

    const results = analyze(shifts, calls);
    const counts = {};
    results.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1);
    console.log('סטטוסים:', JSON.stringify(counts));

    // דוח לקובץ
    fs.writeFileSync('shift_gaps.json', JSON.stringify(results, null, 1));
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    const csv = ['worker,date,shift_start,shift_end,marked,status,calls,actual,first_call,last_call'];
    for (const r of results) csv.push([
        r.worker, r.date, r.shiftStart, r.shiftEnd, r.marked, r.status, r.callCount,
        Object.entries(r.byInst).map(([k, v]) => `${k}:${v}`).join(' | '), r.firstCall || '', r.lastCall || '',
    ].map(esc).join(','));
    fs.writeFileSync('shift_gaps.csv', csv.join('\n'));
    console.log('נכתבו shift_gaps.json ו-shift_gaps.csv');

    if (doWrite) {
        if (process.argv.includes('--replace')) {
            console.log('מנקה את טבלת "Shift Gaps" הקיימת ...');
            const del = await clearTable(GAPS_TABLE);
            console.log(`  נמחקו ${del} שורות ישנות`);
        }
        console.log('כותב פערים לטבלת "Shift Gaps" ב-Airtable ...');
        const n = await writeGaps(results);
        console.log(`  נכתבו ${n} שורות פער`);
    } else {
        console.log('(דילוג על כתיבה ל-Airtable — הוסף --write-airtable כדי לכתוב)');
    }
}
main().catch(e => { console.error('שגיאה:', e.message); process.exit(1); });
