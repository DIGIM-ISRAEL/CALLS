// answer-checker.js — שירות בדיקת answered/no_answer על שיחות קיימות
// PORT 3003 | לא נוגע במערכת הראשית
// שלב 1: CDR מ-Maskyoo (חינם) → שלב 2: Silero VAD (מקומי, חינם) לשיחות קצרות
//
// משתני סביבה נדרשים:
//   MASKYOO_API_KEY   — מפתח API של Maskyoo
//
// הרצה:  MASKYOO_API_KEY=xxx node answer-checker.js

const https = require('https');
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3003;
const MASKYOO_API_KEY = process.env.MASKYOO_API_KEY;
const MASKYOO_BASE_URL = 'https://app.maskyoo.co.il/issa_153/api/';
const VAD_SCRIPT = path.join(__dirname, 'vad_check.py');
const ANSWERED_DURATION_THRESHOLD = 30; // שניות — מעל זה: ודאי נענה ללא VAD

if (!MASKYOO_API_KEY) {
    console.error('❌ MASKYOO_API_KEY environment variable is required');
    process.exit(1);
}

// ─── מצב עבודה ───────────────────────────────────────────
let jobState = null;

// ─── Resume state — נשמר בדיסק כדי לשרוד restart/crash של התהליך ───
const DONE_FILE = '/root/answer_checker_done.txt';
function loadDoneSet() {
    try { return new Set(fs.readFileSync(DONE_FILE, 'utf8').split('\n').filter(Boolean)); }
    catch (_) { return new Set(); }
}
function markDone(recordId) {
    try { fs.appendFileSync(DONE_FILE, recordId + '\n'); } catch (_) {}
}
function doneCount() {
    try { return fs.readFileSync(DONE_FILE, 'utf8').split('\n').filter(Boolean).length; }
    catch (_) { return 0; }
}

// ─── Phone / Date helpers (from recovery-processor.js) ───

function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const cleaned = String(phoneNumber).replace(/\D/g, '');
    if (cleaned.startsWith('972')) return cleaned;
    if (cleaned.startsWith('0')) return `972${cleaned.substring(1)}`;
    return `972${cleaned}`;
}

function formatDateForMaskyoo(dateString) {
    if (!dateString) return null;
    let date;
    if (String(dateString).includes('T')) date = new Date(dateString);
    else if (String(dateString).includes('/')) {
        const parts = dateString.split('/');
        date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    } else date = new Date(dateString);
    if (isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ─── Phase 2: חיפוש UUID לפי טלפון + תאריך ──────────────

function queryCDR(sql) {
    return new Promise((resolve) => {
        const params = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' });
        const url = `${MASKYOO_BASE_URL}?${params}`;
        const req = https.request(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}` }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status?.code === 200 && json.result?.length > 0) {
                        const cdr = json.result[0];
                        resolve({ ok: true, uuid: cdr.cdr_uniqueid, cdr, total: json.result.length });
                    } else {
                        resolve({ ok: false, error: 'no results' });
                    }
                } catch (e) {
                    resolve({ ok: false, error: e.message });
                }
            });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.end();
    });
}

async function findCallUUID(phoneMyUser, phoneNumber, callDate = null, dateFrom = null, dateTo = null) {
    // עקרון: "נוצר קשר אי-פעם, כל חייגן" — מחפשים ANSWER לפי מספר הלקוח (user_phone),
    // בכל חייגן ובכל תאריך. ANSWER מועדף (הארוך ביותר ראשון).

    // ניסיון 1: החייגן שלנו — האות החזק ביותר (אנחנו עצמנו יצרנו קשר). רק אם ידוע מי החייגן.
    // אם הוגדר טווח תאריכים (dateFrom/dateTo) — מגבילים את ה-CDR ל-start_call בתוך הטווח (סיווג מוגבל-תקופה לקמפיין)
    const dateClause = (dateFrom && dateTo)
        ? ` AND start_call >= '${dateFrom} 00:00:00' AND start_call <= '${dateTo} 23:59:59'`
        : '';

    let r1 = { ok: false };
    if (phoneMyUser) {
        const sql1 = `SELECT cdr_uniqueid, start_call, call_duration, cdr_ani, user_phone, call_status FROM webserviceview WHERE cdr_ani = '${phoneMyUser}' AND user_phone = '${phoneNumber}'${dateClause} ORDER BY CASE WHEN call_status = 'ANSWER' THEN call_duration ELSE 0 END DESC`;
        r1 = await queryCDR(sql1);
        if (r1.ok && r1.cdr.call_status === 'ANSWER') return r1;
    }

    // ניסיון 2: כל חייגן — הלקוח ענה לטלפן אחר (לידים עוברים בין טלפנים).
    // מחזיר רק אם נמצא ANSWER אמיתי — קשר עם מספר הלקוח הזה הוא קשר, ללא קשר לקמפיין.
    const sql2 = `SELECT cdr_uniqueid, start_call, call_duration, cdr_ani, user_phone, call_status FROM webserviceview WHERE user_phone = '${phoneNumber}'${dateClause} ORDER BY CASE WHEN call_status = 'ANSWER' THEN call_duration ELSE 0 END DESC`;
    const r2 = await queryCDR(sql2);
    if (r2.ok && r2.cdr.call_status === 'ANSWER') return r2;

    // אין ANSWER בשום מקום — מחזירים רשומה לקביעת "No Answer" (מעדיפים את החייגן שלנו)
    if (r1.ok) return r1;
    if (r2.ok) return r2;
    return { ok: false, error: 'no results' };
}

// ─── Maskyoo CDR ─────────────────────────────────────────

function getMaskyooMetadata(uuid) {
    return new Promise((resolve) => {
        const params = new URLSearchParams({
            service: 'get_cdr_metadata_by_call_uuid',
            call_uuid: uuid,
            format: 'json'
        });
        const url = `${MASKYOO_BASE_URL}?${params}`;
        const req = https.request(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}` }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status?.code === 200 && json.result?.cdr) {
                        resolve({ ok: true, cdr: json.result.cdr });
                    } else {
                        resolve({ ok: false, error: json.status?.description || 'no result' });
                    }
                } catch (e) {
                    resolve({ ok: false, error: e.message });
                }
            });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.end();
    });
}

// ─── Airtable ─────────────────────────────────────────────

function airtableGet(recordId, airtableConfig) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${airtableConfig.baseId}/${airtableConfig.tableId}/${recordId}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${airtableConfig.apiKey}` }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ ok: res.statusCode === 200, record: JSON.parse(data) }); }
                catch (e) { resolve({ ok: false, error: e.message }); }
            });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.end();
    });
}

function airtablePatch(recordId, fields, airtableConfig) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ fields });
        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${airtableConfig.baseId}/${airtableConfig.tableId}/${recordId}`,
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${airtableConfig.apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ ok: res.statusCode === 200 }));
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.write(body);
        req.end();
    });
}

// כותב סטטוס רק אם הוא ודאי (Answered/No Answer) — לעולם לא דורס ב-"unknown" (כשל חולף)
async function patchClassification(recordId, result, airtableConfig) {
    if (result !== 'Answered' && result !== 'No Answer') {
        return { ok: false, skippedWrite: true };
    }
    return airtablePatch(recordId, { call_status: result }, airtableConfig);
}

// maxRecords=0 → scan ALL records
function airtableScan(airtableConfig, filterFormula, maxRecords = 100) {
    return new Promise((resolve) => {
        const records = [];
        const unlimited = maxRecords === 0;

        const fetchPage = (offset) => {
            let queryParams = `pageSize=100`;
            if (!unlimited) queryParams += `&maxRecords=${maxRecords}`;
            if (filterFormula) queryParams += `&filterByFormula=${encodeURIComponent(filterFormula)}`;
            if (offset) queryParams += `&offset=${encodeURIComponent(offset)}`;

            const options = {
                hostname: 'api.airtable.com',
                port: 443,
                path: `/v0/${airtableConfig.baseId}/${airtableConfig.tableId}?${queryParams}`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${airtableConfig.apiKey}` }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            console.error('❌ Airtable scan error:', JSON.stringify(json.error));
                            resolve(records);
                            return;
                        }
                        if (json.records) records.push(...json.records);
                        const shouldContinue = json.offset && (unlimited || records.length < maxRecords);
                        if (shouldContinue) {
                            fetchPage(json.offset);
                        } else {
                            resolve(unlimited ? records : records.slice(0, maxRecords));
                        }
                    } catch (e) {
                        console.error('❌ Airtable parse error:', e.message);
                        resolve(records);
                    }
                });
            });
            req.on('error', () => resolve(records));
            req.end();
        };

        fetchPage(null);
    });
}

// ─── הורדת שמע חלקי (400KB בלבד ≈ 25 שניות) ──────────────

function downloadPartialAudio(uuid, outputPath) {
    return new Promise((resolve) => {
        const params = new URLSearchParams({
            service: 'get_record_by_call_uuid',
            call_uuid: uuid,
            type: 'mp3',
            format: 'json'
        });
        const url = `${MASKYOO_BASE_URL}?${params}`;

        const req = https.request(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}` }
        }, (res) => {
            if (res.statusCode !== 200) {
                resolve({ ok: false, error: `HTTP ${res.statusCode}` });
                return;
            }

            const MAX_BYTES = 400 * 1024;
            const chunks = [];
            let totalBytes = 0;

            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                if (totalBytes >= MAX_BYTES) req.destroy();
            });

            const finish = () => {
                const buf = Buffer.concat(chunks);
                // בדוק שזה MP3 ולא JSON שגיאה
                if (buf.length < 100 || buf.slice(0, 4).toString().includes('{')) {
                    resolve({ ok: false, error: 'Response is not audio' });
                    return;
                }
                fs.writeFileSync(outputPath, buf);
                resolve({ ok: true, bytes: buf.length });
            };

            res.on('end', finish);
            res.on('close', finish);
            res.on('error', (e) => resolve({ ok: false, error: e.message }));
        });

        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.end();
    });
}

// ─── Silero VAD (via persistent vad_server.py on port 9988) ──
const VAD_SERVER_URL = 'http://127.0.0.1:9988/vad';

function runVAD(audioPath) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ audio_path: audioPath });
        const req = require('http').request(VAD_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 120000
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve({ ok: true, ...result });
                } catch (e) {
                    resolve({ ok: false, error: `vad_server parse error: ${data.slice(0, 100)}` });
                }
            });
        });
        req.on('error', e => resolve({ ok: false, error: `vad_server: ${e.message}` }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'vad_server timeout' }); });
        req.write(body);
        req.end();
    });
}

// ─── לוגיקת זיהוי מרכזית ─────────────────────────────────

const NO_ANSWER_STATUSES = new Set(['NOANSWER', 'BUSY', 'CALLER CANCEL', 'NO ANSWER', 'FAILED']);

// סיווג ישיר מ-CDR (ללא שאילתה נוספת) — משמש ב-Phase 2
function classifyFromCDR(cdr, uuid, skipVAD = false) {
    const { call_status, call_duration } = cdr;
    const duration = parseInt(call_duration || 0);

    if (NO_ANSWER_STATUSES.has(call_status)) {
        return { result: 'No Answer', method: 'cdr_status', detail: `${call_status} (${duration}s)` };
    }
    if (call_status === 'ANSWER') {
        if (skipVAD) {
            // בלי VAD — נשמרני: רק שיחות ארוכות מאוד נחשבות Answered
            const r = duration > ANSWERED_DURATION_THRESHOLD ? 'Answered' : 'No Answer';
            return { result: r, method: 'cdr_no_vad', detail: `ANSWER (${duration}s)` };
        }
        return null; // יטופל ב-VAD
    }
    return { result: 'No Answer', method: 'cdr_unknown_status', detail: `${call_status} (${duration}s)` };
}

async function classifyCall(uuid, skipVAD = false, skipInternalLegCheck = false) {
    const meta = await getMaskyooMetadata(uuid);
    if (!meta.ok) {
        return { result: 'unknown', method: 'cdr_error', detail: meta.error };
    }

    const { call_status, call_duration, user_phone, cdr_ani } = meta.cdr;
    const duration = parseInt(call_duration || 0);

    // Internal leg: user_phone = cdr_ani → IVR/routing call, not the customer conversation
    // Recording contains campaign audio or voicemail greeting — unreliable for VAD
    // Only checked in Phase 1 (skipInternalLegCheck=false); Phase 2 already knows status from SQL CDR
    if (!skipInternalLegCheck && user_phone && user_phone === cdr_ani) {
        return { result: 'unknown', method: 'internal_leg', detail: `user_phone=cdr_ani=${cdr_ani} (${duration}s)` };
    }

    if (NO_ANSWER_STATUSES.has(call_status)) {
        return { result: 'No Answer', method: 'cdr_status', detail: `${call_status} (${duration}s)` };
    }

    if (call_status !== 'ANSWER') {
        return { result: 'No Answer', method: 'cdr_unknown_status', detail: `${call_status} (${duration}s)` };
    }

    if (skipVAD) {
        const r = duration > ANSWERED_DURATION_THRESHOLD ? 'Answered' : 'No Answer';
        return { result: r, method: 'cdr_no_vad', detail: `ANSWER (${duration}s)` };
    }

    // VAD — כל שיחת ANSWER עוברת בדיקת הקלטה
    // snap ffmpeg לא ניגש ל-/tmp — משתמשים ב-/root
    const tmpFile = path.join('/root', `vad_${uuid.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`);
    try {
        const dl = await downloadPartialAudio(uuid, tmpFile);
        if (!dl.ok) {
            return { result: 'unknown', method: 'download_error', detail: dl.error };
        }

        const vad = await runVAD(tmpFile);
        if (!vad.ok || vad.answered === null || vad.answered === undefined) {
            return { result: 'unknown', method: 'vad_error', detail: vad.error };
        }

        return {
            result: vad.answered ? 'Answered' : 'No Answer',
            method: 'silero_vad',
            detail: `speech_ms=${vad.speech_after_intro_ms}, segments=${vad.segments_after_skip}`
        };
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
}

// ─── עיבוד רשומה בודדת ───────────────────────────────────

async function processRecord(record, airtableConfig, options = {}) {
    const recordId = record.id;
    const fields = record.fields || {};
    const currentStatus = fields['call_status'] || '';

    // לעולם לא דורסים סטטוס ידני 'not relevant' (גם לא עם force)
    if (currentStatus === 'not relevant') {
        return { recordId, skipped: true, reason: 'preserved_status', previousStatus: currentStatus };
    }

    // לא דורסים "Answered" — אלא אם force:true (לסיווג מחדש)
    if (currentStatus === 'Answered' && !options.force) {
        return { recordId, skipped: true, reason: 'already_answered', previousStatus: currentStatus };
    }

    let uuid = fields['UUID'] || fields['uuid'] || fields['cdr_uniqueid'];
    const storedUuid = uuid; // שמור לזיהוי later
    let phase = 1;
    const windowed = !!(options.dateFrom && options.dateTo);

    // הרצה מוגבלת-תקופה לא נוגעת בלידים שמעולם לא חויגו (אין call_time) — נשארים בתור החיוג של power-dialer
    if (windowed && !fields['call_time']) {
        return { recordId, skipped: true, reason: 'never_dialed', previousStatus: currentStatus };
    }

    // Phase 1: UUID קיים ב-Airtable
    if (uuid && !windowed) {
        const p1 = await classifyCall(uuid, options.skipVAD);
        if (p1.method !== 'internal_leg') {
            // תוצאה אמינה מ-Phase 1 — UUID מצביע על שיחה עם לקוח
            const patched = await patchClassification(recordId, p1.result, airtableConfig);
            return { recordId, uuid, phase, previousStatus: currentStatus, newStatus: p1.result, method: p1.method, detail: p1.detail, airtableUpdated: patched.ok };
        }
        // UUID הוא leg פנימי (IVR/routing) — ההקלטה אינה אמינה — עובר ל-Phase 2
        console.log(`   ⚠️ Phase 1 internal leg (${p1.detail}) → Phase 2`);
        phase = 2;
    }

    // Phase 2: חיפוש לפי מספרי טלפון
    const myPhone = formatPhoneNumber(fields['phone_my_user']);
    const theirPhone = formatPhoneNumber(fields['phone_number']);
    const callDate = fields['call_time'] || null;

    // צריך רק את מספר הלקוח — findCallUUID מחפש any-dialer לפיו. phone_my_user אופציונלי.
    if (!theirPhone) {
        return { recordId, skipped: true, reason: 'missing_fields', missing: ['phone_number'] };
    }

    const found = await findCallUUID(myPhone, theirPhone, callDate, options.dateFrom, options.dateTo);
    if (!found.ok) {
        if (windowed) {
            // הרצה מוגבלת-תקופה: אין שום שיחה ללקוח בטווח → לא נוצר קשר בתקופה הזו
            const patched = await airtablePatch(recordId, { call_status: 'No Answer' }, airtableConfig);
            return { recordId, uuid: storedUuid || null, phase, previousStatus: currentStatus, newStatus: 'No Answer', method: 'no_cdr_in_window', detail: `no call to ${theirPhone} in ${options.dateFrom}..${options.dateTo}`, airtableUpdated: patched.ok };
        }
        if (storedUuid) {
            // היה UUID אבל leg פנימי, ולא מצאנו CDR — לא ניתן לאשר שנענה — שמרני: לא נענה
            const patched = await airtablePatch(recordId, { call_status: 'No Answer' }, airtableConfig);
            return { recordId, uuid: storedUuid, phase, previousStatus: currentStatus, newStatus: 'No Answer', method: 'internal_leg_no_cdr', detail: 'internal leg UUID, no customer CDR found', airtableUpdated: patched.ok };
        }
        return { recordId, skipped: true, reason: 'uuid_not_found', detail: found.error };
    }

    uuid = found.uuid;
    // כתוב UUID רק אם cdr_ani תואם את phone_my_user (מציאה מדויקת, לא fallback)
    const uuidIsReliable = found.cdr.cdr_ani === myPhone;
    if (uuidIsReliable) await airtablePatch(recordId, { UUID: uuid }, airtableConfig);
    console.log(`   📌 Phase 2 UUID: ${uuid} | reliable:${uuidIsReliable} | ${found.cdr.call_status} ${found.cdr.call_duration}s`);

    // סיווג ישיר מ-CDR (NOANSWER/BUSY/etc) — ללא VAD
    const directClass = classifyFromCDR(found.cdr, uuid, options.skipVAD);
    if (directClass) {
        const patched = await airtablePatch(recordId, { call_status: directClass.result }, airtableConfig);
        return { recordId, uuid, phase, previousStatus: currentStatus, newStatus: directClass.result, method: directClass.method, detail: directClass.detail, airtableUpdated: patched.ok };
    }

    // ANSWER — צריך VAD (Phase 2: מדלגים על internal_leg check כי CDR SQL כבר אישר ANSWER)
    const classification = await classifyCall(uuid, options.skipVAD, true);
    const finalResult = classification;

    const patched = await patchClassification(recordId, finalResult.result, airtableConfig);
    return {
        recordId,
        uuid,
        phase,
        previousStatus: currentStatus,
        newStatus: finalResult.result,
        method: finalResult.method,
        detail: finalResult.detail,
        airtableUpdated: patched.ok
    };
}

// ─── Batch Runner ─────────────────────────────────────────

async function runBatch(airtableConfig, options = {}) {
    const { limit = 100, filter = '', skipVAD = false, concurrency = 2, force = false, resume = false, dateFrom = null, dateTo = null } = options;

    // resume=false → התחלה נקייה (מאפס את קובץ ה-done). resume=true → ממשיך מהמקום שנעצר.
    if (!resume) { try { fs.unlinkSync(DONE_FILE); } catch (_) {} }
    const doneSet = resume ? loadDoneSet() : new Set();

    // מגדיר running מיד — לפני הסריקה שלוקחת זמן
    jobState = { startedAt: new Date().toISOString(), total: null, scanning: true, processed: 0, answered: 0, noAnswer: 0, unknown: 0, skipped: 0, vadUsed: 0, errors: 0, results: [], running: true, resumed: doneSet.size };

    const allRecords = await airtableScan(airtableConfig, filter, limit);
    const records = resume && doneSet.size ? allRecords.filter(r => !doneSet.has(r.id)) : allRecords;
    console.log(`📋 Found ${allRecords.length} records; ${records.length} to process (resume skipped ${allRecords.length - records.length})`);
    jobState.total = allRecords.length;
    jobState.processed = allRecords.length - records.length; // כבר-בוצעו נספרים כהתקדמות מצטברת
    jobState.scanning = false;

    const queue = [...records];

    await Promise.all(Array(Math.min(concurrency, queue.length) || 1).fill(null).map(async () => {
        while (queue.length > 0 && jobState.running) {
            const record = queue.shift();
            if (!record) break;

            try {
                const result = await processRecord(record, airtableConfig, { skipVAD, force, dateFrom, dateTo });

                jobState.processed++;
                if (result.skipped)                    jobState.skipped++;
                else if (result.newStatus === 'Answered') jobState.answered++;
                else if (result.newStatus === 'No Answer') jobState.noAnswer++;
                else                                   jobState.unknown++;
                if (result.method === 'silero_vad')    jobState.vadUsed++;
                jobState.results.push(result);
                // markDone רק לתוצאה סופית — 'unknown' (כשל חולף) יישאר ל-retry ב-resume הבא
                if (result.newStatus !== 'unknown') markDone(record.id);

                const tag = result.skipped ? 'SKIP' : result.newStatus;
                console.log(`[${jobState.processed}/${jobState.total}] ${tag} | ${result.uuid || 'no-uuid'} | ${result.method || ''} | ${result.detail || ''}`);

                await new Promise(r => setTimeout(r, 250)); // rate limit
            } catch (e) {
                jobState.errors++;
                jobState.processed++;
                markDone(record.id); // אל תנסה שוב את אותה רשומה אחרי resume
                console.error(`❌ Error on ${record.id}:`, e.message);
            }
        }
    }));

    jobState.running = false;
    jobState.finishedAt = new Date().toISOString();
    console.log(`\n✅ Done: Answered=${jobState.answered} NoAnswer=${jobState.noAnswer} Unknown=${jobState.unknown} Skipped=${jobState.skipped} VAD=${jobState.vadUsed}`);
    return jobState;
}

// ─── Endpoints ────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'answer-checker', port: PORT });
});

// POST /check-batch
// { airtableConfig: {baseId, tableId, apiKey}, limit?, filter?, skipVAD? }
app.post('/check-batch', async (req, res) => {
    if (jobState?.running) {
        return res.status(409).json({ error: 'Job already running', status: getStatus() });
    }
    const { airtableConfig, limit = 100, filter = '', skipVAD = false, force = false, resume = false, concurrency = 2, dateFrom = null, dateTo = null } = req.body;
    if (!airtableConfig?.baseId || !airtableConfig?.tableId || !airtableConfig?.apiKey) {
        return res.status(400).json({ error: 'Missing airtableConfig (baseId, tableId, apiKey)' });
    }
    res.json({ started: true, message: `Processing up to ${limit} records${force ? ' (force reclassify)' : ''}${resume ? ' (resume)' : ''}` });
    runBatch(airtableConfig, { limit, filter, skipVAD, force, resume, concurrency, dateFrom, dateTo }).catch(e => {
        console.error('Batch error:', e.message);
        if (jobState) jobState.running = false;
    });
});

// POST /check-single
// { recordId, airtableConfig, skipVAD?, force? }
app.post('/check-single', async (req, res) => {
    const { recordId, airtableConfig, skipVAD = false, force = false, dateFrom = null, dateTo = null } = req.body;
    if (!recordId || !airtableConfig?.baseId || !airtableConfig?.tableId || !airtableConfig?.apiKey) {
        return res.status(400).json({ error: 'Missing recordId or airtableConfig' });
    }
    const { record } = await airtableGet(recordId, airtableConfig);
    if (!record?.id) return res.status(404).json({ error: 'Record not found' });
    const result = await processRecord(record, airtableConfig, { skipVAD, force, dateFrom, dateTo });
    res.json(result);
});

// POST /reset-batch — איפוס (סגירת קמפיין): מרוקן call_status (ל-null) לכל רשומה שה-call_time שלה בטווח,
// כדי שה-power-dialer יחייג אליה מחדש בקמפיין חדש. תמלול/ניתוח לא נמחקים.
// { airtableConfig: {baseId, tableId, apiKey}, dateFrom: 'YYYY-MM-DD', dateTo: 'YYYY-MM-DD', dryRun? }
app.post('/reset-batch', async (req, res) => {
    const { airtableConfig, dateFrom, dateTo, dryRun = false } = req.body;
    if (!airtableConfig?.baseId || !airtableConfig?.tableId || !airtableConfig?.apiKey) {
        return res.status(400).json({ error: 'Missing airtableConfig (baseId, tableId, apiKey)' });
    }
    if (!dateFrom || !dateTo) {
        return res.status(400).json({ error: 'Missing dateFrom/dateTo (YYYY-MM-DD)' });
    }
    const all = await airtableScan(airtableConfig, '', 0);
    // סגירה מנקה רק Answered/No Answer — לא נוגעת ב-'not relevant'/'Processing'/'Done'/'Error'/ריק
    const CLEARABLE = new Set(['Answered', 'No Answer']);
    const targets = all.filter(r => {
        const t = (r.fields?.call_time || '').slice(0, 10);
        const s = r.fields?.call_status || '';
        return t && t >= dateFrom && t <= dateTo && CLEARABLE.has(s);
    });
    res.json({ scanned: all.length, matched: targets.length, dryRun });
    if (dryRun) {
        console.log(`🧹 reset-batch DRY RUN: ${targets.length}/${all.length} records match call_time ${dateFrom}..${dateTo}`);
        return;
    }
    let cleared = 0;
    for (const r of targets) {
        const patched = await airtablePatch(r.id, { call_status: null }, airtableConfig);
        if (patched.ok) cleared++;
        await new Promise(rr => setTimeout(rr, 200));
    }
    console.log(`🧹 reset-batch: cleared ${cleared}/${targets.length} (call_time ${dateFrom}..${dateTo})`);
});

function getStatus() {
    // doneTotal נקרא מהדיסק — משקף התקדמות מצטברת ששורדת restart (גם כש-jobState אבד)
    if (!jobState) return { running: false, message: 'No job has been run yet', doneTotal: doneCount() };
    return { ...jobState, doneTotal: doneCount() };
}

app.get('/status', (req, res) => res.json(getStatus()));
app.post('/stop', (req, res) => {
    if (jobState) jobState.running = false;
    res.json({ stopped: true });
});

// ─── Internal CDR read-proxy for the digim-selfhost daily-ops-report ───────
// Maskyoo's API only accepts requests from this server's (allowlisted) IP, so
// the donations-server (46.101.204.111) can't call it directly — it relays
// through here instead. Gated by a shared secret (not open to the internet),
// and restricted to read-only SELECTs against Maskyoo's own CDR view.
const CDR_PROXY_TOKEN = process.env.CDR_PROXY_TOKEN;
app.post('/cdr-proxy', (req, res) => {
    if (!CDR_PROXY_TOKEN) return res.status(503).json({ error: 'cdr_proxy_not_configured' });
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CDR_PROXY_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
    const sql = String(req.body?.sql || '').trim();
    if (!/^SELECT\s/i.test(sql)) return res.status(400).json({ error: 'select_only' });
    const params = new URLSearchParams({ service: 'cdr_query', sql, format: 'json' });
    const url = `${MASKYOO_BASE_URL}?${params}`;
    const maskyooReq = https.request(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${MASKYOO_API_KEY}` }
    }, (maskyooRes) => {
        let data = '';
        maskyooRes.on('data', c => data += c);
        maskyooRes.on('end', () => {
            res.status(maskyooRes.statusCode || 200).type('application/json').send(data);
        });
    });
    maskyooReq.on('error', (err) => res.status(502).json({ error: String(err.message || err) }));
    maskyooReq.end();
});

app.listen(PORT, () => {
    console.log(`\n✅ answer-checker running on PORT ${PORT}`);
    console.log(`   POST /check-batch  — הרץ על כמות רשומות`);
    console.log(`   POST /check-single — בדוק רשומה אחת`);
    console.log(`   GET  /status       — ראה התקדמות ותוצאות`);
});
