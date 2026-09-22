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
// דרישות: משתנה סביבה AIRTABLE_API_KEY (לניתוח הפערים — הזמן מוטמע ב-UUID).
//   למצב --precise-hours נדרש גם MASKYOO_API_KEY.
//
// הרצה:
//   node shift-gap-analyzer.js --shifts shifts.csv --start 2026-08-01 --end 2026-10-01
//   הוסף --write-airtable כדי להוסיף לטבלת "Shift Gaps" רק שורות חסרות
//   (לא מוחק ולא דורס; התנגשויות מודפסות לטיפול ידני).
//   הוסף --precise-hours לחישוב שעות פעילות מדויקות פר-מוסד לכל משמרת,
//   מתוך ה-CDR של maskyoo (כל שיחה שיצאה) -> shift_precise_hours.csv.
//   מיפוי שיחה->מוסד: טלפון הלקוח (cdr_ani) -> ליד -> telemarketing clients.
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
    phoneNumber: 'phone_number',    // טלפון הלקוח — לשיוך שיחת CDR למוסד
    callTime:    'call_time',       // תאריך בלבד (ללא שעה) — משמש רק כפילטר גס
    uuid:        'UUID',            // "<unix>.<seq>" — הזמן המדויק
    client:      'telemarketing clients',
    creditedTo:  'Donation Credited To',
};

// maskyoo — נדרש רק למצב --precise-hours (שעות מדויקות מכל השיחות שיצאו)
const MASKYOO = {
    apiKey: process.env.MASKYOO_API_KEY,
    baseUrl: 'https://app.maskyoo.co.il/issa_153/api/',
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
// שליפת השורות הקיימות בטבלת הפערים -> מפתח "עובד|תאריך|כניסה" => {status, actual}
async function fetchExistingGaps(table) {
    const map = {};
    let offset = '';
    do {
        let path = `/v0/${BASE_ID}/${table}?pageSize=100` +
            ['Worker', 'Date', 'Shift Start', 'Status', 'Actual Institutions']
                .map(f => 'fields[]=' + encodeURIComponent(f)).join('&').replace(/^/, '&');
        if (offset) path += '&offset=' + encodeURIComponent(offset);
        const res = await airtableGet(path);
        for (const r of res.records || []) {
            const f = r.fields || {};
            map[`${f.Worker}|${f.Date}|${f['Shift Start']}`] = { status: f.Status, actual: f['Actual Institutions'] };
        }
        offset = res.offset || '';
    } while (offset);
    return map;
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

// ═══════════════════════════════════════════════════════════════
// מצב --precise-hours: שעות פעילות מדויקות פר-מוסד לכל משמרת,
// מתוך ה-CDR של maskyoo (כל שיחה שיצאה, כולל ללא מענה).
// ═══════════════════════════════════════════════════════════════
function normPhone(p) {
    let c = String(p || '').replace(/\D/g, '');
    if (!c) return '';
    if (c.startsWith('972')) c = c.slice(3);
    else if (c.startsWith('0')) c = c.slice(1);
    return c; // צורה מקומית ללא קידומת/0 מוביל, להשוואה
}
function hmHours(dec) {
    const sg = dec < 0 ? '-' : ''; let x = Math.abs(dec);
    let h = Math.floor(x + 1e-9); let m = Math.round((x - h) * 60);
    if (m === 60) { h++; m = 0; }
    return sg + h + ':' + String(m).padStart(2, '0');
}
function maskyooQuery(sql) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' }).toString();
        const req = https.request(MASKYOO.baseUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${MASKYOO.apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': 'ShiftGapAnalyzer/1.0',
            },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).result || []); } catch (e) { reject(new Error('Maskyoo bad JSON: ' + d.slice(0, 300))); } });
        });
        req.on('error', reject); req.write(body); req.end();
    });
}
// מפה: טלפון לקוח (מנורמל) -> מוסד. נבנית פעם אחת מטבלת הלידים.
async function buildPhoneInstMap() {
    const map = {};
    const fields = [F.phoneNumber, F.client].map(f => 'fields[]=' + encodeURIComponent(f)).join('&');
    let offset = '';
    do {
        let path = `/v0/${BASE_ID}/${LEADS_TABLE}?pageSize=100&${fields}`;
        if (offset) path += '&offset=' + encodeURIComponent(offset);
        const res = await airtableGet(path);
        for (const r of res.records || []) {
            const ph = normPhone((r.fields || {})[F.phoneNumber]);
            const cl = (r.fields || {})[F.client];
            const name = Array.isArray(cl) && cl.length ? (cl[0].name || cl[0]) : cl;
            if (ph && name) map[ph] = canon(name);
        }
        offset = res.offset || '';
    } while (offset);
    return map;
}
// מפה: (אימייל|תאריך) -> קבוצת מספרי חיוג, ו(אימייל)->קבוצה, מתוך זיכויי התרומות
function buildOperatorNumbers(calls) {
    const byDay = {}, byOp = {};
    for (const c of calls) {
        if (c.credited && NAME_BY_EMAIL[c.credited] && c.phone) {
            (byDay[`${c.credited}|${c.day}`] = byDay[`${c.credited}|${c.day}`] || new Set()).add(c.phone);
            (byOp[c.credited] = byOp[c.credited] || new Set()).add(c.phone);
        }
    }
    return { byDay, byOp };
}
async function preciseHours(shifts, calls) {
    if (!MASKYOO.apiKey) { console.error('מצב --precise-hours דורש MASKYOO_API_KEY בסביבה'); process.exit(1); }
    console.log('בונה מפת טלפון->מוסד מטבלת הלידים ...');
    const phoneInst = await buildPhoneInstMap();
    console.log(`  ${Object.keys(phoneInst).length} מספרי לקוח ממופים`);
    const { byDay, byOp } = buildOperatorNumbers(calls);
    const totals = {};
    const rows = [['עובד', 'תאריך', 'משמרת', 'שעות רשומות', 'מוסד שנרשם', 'שעות פעילות (CDR)', 'פילוח פר-מוסד']];
    for (const s of shifts) {
        const nums = [...(byDay[`${s.email}|${s.date}`] || byOp[s.email] || new Set())];
        if (!nums.length) { rows.push([s.worker, s.date, `${s.inStart}-${s.inEnd}`, hmHours(s.hours), s.marked, '', 'אין מספר חיוג ידוע']); continue; }
        const ddi = nums.map(n => `'972${n}','0${n}'`).join(',');
        const sql = `SELECT start_call, cdr_ani, call_status FROM webserviceview ` +
            `WHERE cdr_ddi IN (${ddi}) AND start_call >= '${s.date} ${s.inStart}' AND start_call <= '${s.date} ${s.inEnd}' ORDER BY start_call ASC`;
        let cdr = [];
        try { cdr = await maskyooQuery(sql); } catch (e) { console.error(`  CDR שגיאה ${s.worker} ${s.date}: ${e.message}`); }
        // חלוקת חצאי-שעה -> מוסד דומיננטי לפי טלפון הלקוח
        const slotInst = {};
        for (const c of cdr) {
            const t = c.start_call && c.start_call.split(' ')[1]; if (!t) continue;
            const [h, m] = t.split(':'); const slot = (+h) * 2 + (+m >= 30 ? 1 : 0);
            const inst = phoneInst[normPhone(c.cdr_ani)] || 'לא ידוע';
            (slotInst[slot] = slotInst[slot] || {})[inst] = (slotInst[slot][inst] || 0) + 1;
        }
        const perInst = {};
        for (const k in slotInst) { const top = Object.entries(slotInst[k]).sort((a, b) => b[1] - a[1])[0][0]; perInst[top] = (perInst[top] || 0) + 0.5; }
        for (const i in perInst) totals[i] = (totals[i] || 0) + perInst[i];
        const tot = Object.values(perInst).reduce((a, b) => a + b, 0);
        const brk = Object.entries(perInst).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${hmHours(v)}`).join(' | ');
        rows.push([s.worker, s.date, `${s.inStart}-${s.inEnd}`, hmHours(s.hours), s.marked, hmHours(tot), brk]);
    }
    fs.writeFileSync('shift_precise_hours.csv', '﻿' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n'));
    console.log('\n=== שעות פעילות מדויקות פר-מוסד (CDR) ===');
    for (const i of Object.keys(totals).sort((a, b) => totals[b] - totals[a])) {
        const rate = ({ 'ישיבת דימונה': 80, 'עטרת ירושלים': 75, 'מוסדות עצם': 70 })[i];
        console.log(`  ${i}: ${hmHours(totals[i])}` + (rate ? `  ×${rate} = ${Math.round(totals[i] * rate)} ₪` : ''));
    }
    console.log('\nנכתב shift_precise_hours.csv');
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
function actualString(byInst) {
    return Object.entries(byInst).map(([k, v]) => `${k} (${v})`).join(' | ');
}
// מוסיף רק שורות חסרות. לא מוחק ולא דורס. התנגשות (אותה משמרת, תוצאה שונה) מדווחת לטיפול ידני.
async function writeGaps(results) {
    const gaps = results.filter(r => STATUS_HE[r.status]);
    const existing = await fetchExistingGaps(GAPS_TABLE);
    const toAdd = [], conflicts = [];
    let same = 0;
    for (const r of gaps) {
        const key = `${r.worker}|${r.date}|${r.shiftStart}`;
        const ex = existing[key];
        if (!ex) { toAdd.push(gapRow(r)); continue; }
        const curStatus = STATUS_HE[r.status], curActual = actualString(r.byInst);
        if (ex.status === curStatus && ex.actual === curActual) same++;
        else conflicts.push({ key, was: `${ex.status} | ${ex.actual}`, now: `${curStatus} | ${curActual}` });
    }
    for (let i = 0; i < toAdd.length; i += 10) await airtablePost(GAPS_TABLE, toAdd.slice(i, i + 10));
    return { added: toAdd.length, same, conflicts };
}

// ─── CLI ───────────────────────────────────────────────────────
function arg(name, def) { const i = process.argv.indexOf('--' + name); return i !== -1 ? process.argv[i + 1] : def; }
async function main() {
    if (!AIRTABLE_API_KEY) { console.error('חסר AIRTABLE_API_KEY בסביבה'); process.exit(1); }
    const shiftsPath = arg('shifts');
    if (!shiftsPath) { console.error('שימוש: node shift-gap-analyzer.js --shifts <csv> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--write-airtable] [--precise-hours]'); process.exit(1); }
    const start = arg('start', '2026-08-01');
    const end   = arg('end', '2026-10-01');
    const doWrite = process.argv.includes('--write-airtable');

    console.log(`טוען משמרות מ-${shiftsPath} ...`);
    const shifts = loadShifts(shiftsPath);
    console.log(`  ${shifts.length} שורות משמרת`);

    console.log(`שולף שיחות מ-Airtable לטווח ${start}..${end} ...`);
    const calls = await fetchCalls(new Date(start), new Date(end));
    console.log(`  ${calls.length} שיחות עם UUID`);

    if (process.argv.includes('--precise-hours')) {
        // שעות פעילות מדויקות פר-מוסד לכל משמרת מתוך CDR של maskyoo
        await preciseHours(shifts, calls);
        return;
    }

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
        console.log('מוסיף פערים חסרים לטבלת "Shift Gaps" ב-Airtable (בלי לדרוס) ...');
        const w = await writeGaps(results);
        console.log(`  נוספו ${w.added} שורות חדשות · ${w.same} כבר קיימות וזהות · ${w.conflicts.length} התנגשויות`);
        if (w.conflicts.length) {
            console.log('  ⚠️ התנגשויות לטיפול ידני (משמרת קיימת עם תוצאה שונה):');
            for (const c of w.conflicts) console.log(`     ${c.key}\n        קיים:  ${c.was}\n        חדש:   ${c.now}`);
        }
    } else {
        console.log('(דילוג על כתיבה ל-Airtable — הוסף --write-airtable כדי לכתוב)');
    }
}
main().catch(e => { console.error('שגיאה:', e.message); process.exit(1); });
