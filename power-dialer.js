// power-dialer.js
// Power Dialer — חיוג אוטומטי רצוף
// PORT 3003 | PM2: power-dialer

const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3003;
const SECRET_KEY = process.env.DIALER_SECRET_KEY || 'mK9vR3pQ8nX2fA7sB1cD4eF6gH5jL0mN';

// ─── קונפיגורציה ───────────────────────────────────────────
const AIRTABLE_CONFIG = {
    apiKey: 'process.env.AIRTABLE_API_KEY',
    baseId: 'app5pnaEc4UK3RUcP',
    tableId: 'tblcNkAMMCJQ3EVMl'
};

const MASKYOO_CONFIG = {
    apiKey: 'process.env.MASKYOO_API_KEY',
    baseUrl: 'https://app.maskyoo.co.il/issa_153/api/'
};

// ─── מצב הדיילר ────────────────────────────────────────────
let dialerState = {
    isPlaying: false,
    isPaused: false,
    currentRecord: null,
    currentCall: null,
    stats: { total: 0, dialed: 0, noAnswer: 0, skipped: 0, errors: 0 },
    startedAt: null,
    pausedAt: null,
    log: []
};

function addLog(msg) {
    const entry = `${new Date().toISOString().substring(11, 19)} ${msg}`;
    dialerState.log.unshift(entry);
    if (dialerState.log.length > 100) dialerState.log.pop();
    console.log(`📞 [DIALER] ${entry}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Airtable: שליפת רשומות ממתינות ────────────────────────
async function fetchPendingRecords() {
    return new Promise((resolve) => {
        // פילטר: call_status ריק
        const filterFormula = encodeURIComponent(`{call_status} = ""`);
        const fields = encodeURIComponent('fields[]=phone_number&fields[]=phone_my_user&fields[]=call_status');
        const path = `/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableId}?filterByFormula=${filterFormula}&${fields}&maxRecords=200`;

        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_CONFIG.apiKey}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const records = (parsed.records || []).filter(r =>
                        r.fields.phone_number && r.fields.phone_my_user
                    );
                    console.log(`📋 Fetched ${records.length} pending records`);
                    resolve(records);
                } catch (e) {
                    console.error(`❌ Airtable fetch error: ${e.message}`);
                    resolve([]);
                }
            });
        });

        req.on('error', (e) => { resolve([]); });
        req.end();
    });
}

// ─── Airtable: עדכון סטטוס ──────────────────────────────────
async function updateCallStatus(recordId, status) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ fields: { call_status: status } });
        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableId}/${recordId}`,
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(res.statusCode === 200));
        });

        req.on('error', () => resolve(false));
        req.write(body);
        req.end();
    });
}

// ─── Maskyoo: חיוג ──────────────────────────────────────────
async function dialNumber(phoneNumber, phoneMyUser) {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            service: 'create_maskyoo_call_v2',
            maskyoo1: phoneMyUser,
            maskyoo2: phoneNumber
        }).toString();

        const options = {
            hostname: 'app.maskyoo.co.il',
            port: 443,
            path: '/issa_153/api/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MASKYOO_CONFIG.apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status?.code === 200) {
                        resolve({ success: true, callId: parsed.result?.call_id });
                    } else {
                        resolve({ success: false, error: parsed.status?.description || 'Unknown error' });
                    }
                } catch (e) {
                    resolve({ success: false, error: e.message });
                }
            });
        });

        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.write(postData);
        req.end();
    });
}

// ─── Maskyoo CDR: המתנה לסיום שיחה ─────────────────────────
async function waitForCallToEnd(phoneMyUser, phoneNumber, callStartTime, timeoutMinutes = 15) {
    const maxAttempts = (timeoutMinutes * 60) / 10;
    const startStr = new Date(callStartTime).toISOString().replace('T', ' ').substring(0, 19);

    for (let i = 0; i < maxAttempts; i++) {
        await sleep(10000); // בדיקה כל 10 שניות

        // אם הפאוז נלחץ — יציאה מוקדמת
        if (dialerState.isPaused) return { ended: true, reason: 'paused' };

        const sql = `SELECT cdr_uniqueid, end_call, call_duration, call_status ` +
                    `FROM webserviceview ` +
                    `WHERE cdr_ddi = '${phoneMyUser}' ` +
                    `AND cdr_ani = '${phoneNumber}' ` +
                    `AND start_call >= '${startStr}' ` +
                    `ORDER BY start_call DESC LIMIT 1`;

        const result = await queryCDR(sql);

        if (result.length > 0 && result[0].end_call) {
            return {
                ended: true,
                duration: result[0].call_duration,
                status: result[0].call_status,
                uuid: result[0].cdr_uniqueid
            };
        }
    }

    return { ended: true, reason: 'timeout' };
}

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
                'Authorization': `Bearer ${MASKYOO_CONFIG.apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.result || []);
                } catch (e) {
                    resolve([]);
                }
            });
        });

        req.on('error', () => resolve([]));
        req.write(postData);
        req.end();
    });
}

function formatPhone(phone) {
    if (!phone) return phone;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
    if (!cleaned.startsWith('972')) cleaned = '972' + cleaned;
    return cleaned;
}

// ─── לולאת החיוג הראשית ──────────────────────────────────────
async function dialingLoop() {
    addLog('▶️  PLAY — מתחיל חיוג');
    dialerState.startedAt = new Date().toISOString();
    dialerState.stats = { total: 0, dialed: 0, noAnswer: 0, skipped: 0, errors: 0 };

    const records = await fetchPendingRecords();
    dialerState.stats.total = records.length;
    addLog(`📋 נמצאו ${records.length} רשומות לחיוג`);

    if (records.length === 0) {
        addLog('✅ אין רשומות ממתינות');
        dialerState.isPlaying = false;
        return;
    }

    for (const record of records) {
        if (!dialerState.isPlaying || dialerState.isPaused) {
            addLog('⏸️  עצור');
            break;
        }

        const { id: recordId, fields } = record;
        const phoneNumber = formatPhone(fields.phone_number);
        const phoneMyUser = formatPhone(fields.phone_my_user);

        if (!phoneNumber || !phoneMyUser) {
            addLog(`⚠️  דילוג — חסר מספר טלפון (${recordId})`);
            dialerState.stats.skipped++;
            continue;
        }

        dialerState.currentRecord = { recordId, phoneNumber, phoneMyUser };
        addLog(`📞 מחייג ${phoneNumber} דרך ${phoneMyUser}`);

        // עדכון סטטוס לפני חיוג
        await updateCallStatus(recordId, 'Dialing...');

        // חיוג
        const callResult = await dialNumber(phoneNumber, phoneMyUser);
        const callStartTime = Date.now();

        if (!callResult.success) {
            addLog(`❌ שגיאת חיוג: ${callResult.error}`);
            await updateCallStatus(recordId, 'Error');
            dialerState.stats.errors++;
            await sleep(3000);
            continue;
        }

        dialerState.currentCall = { callId: callResult.callId, startTime: callStartTime };
        dialerState.stats.dialed++;
        addLog(`✅ שיחה נשלחה — ממתין לסיום...`);

        // המתנה לסיום השיחה
        const callEnd = await waitForCallToEnd(phoneMyUser, phoneNumber, callStartTime);

        if (callEnd.reason === 'timeout') {
            addLog(`⏱️  Timeout — ממשיך לבאה`);
            await updateCallStatus(recordId, 'Timeout');
        } else if (callEnd.reason === 'paused') {
            await updateCallStatus(recordId, 'Call Sent - Answer Your Phone');
            addLog(`⏸️  פאוז במהלך שיחה`);
            break;
        } else {
            addLog(`🔚 שיחה הסתיימה — ${callEnd.duration || '?'}s | ${callEnd.status || ''}`);
            // הסטטוס כבר עודכן ע"י מערכת ה-webhook הראשית
        }

        dialerState.currentRecord = null;
        dialerState.currentCall = null;

        // הפסקה קצרה בין שיחות
        if (dialerState.isPlaying && !dialerState.isPaused) {
            await sleep(2000);
        }
    }

    dialerState.isPlaying = false;
    dialerState.isPaused = false;
    dialerState.currentRecord = null;
    dialerState.currentCall = null;

    addLog(`🏁 סיום — ${dialerState.stats.dialed} חויגו | ${dialerState.stats.errors} שגיאות | ${dialerState.stats.skipped} דילוגים`);
}

// ─── אבטחה ───────────────────────────────────────────────────
function auth(req, res, next) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
}

// ─── Endpoints ────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'power-dialer',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        dialer: dialerState.isPlaying ? 'playing' : dialerState.isPaused ? 'paused' : 'stopped'
    });
});

// ▶️ PLAY
app.post('/dialer/play', auth, async (req, res) => {
    if (dialerState.isPlaying && !dialerState.isPaused) {
        return res.json({ success: false, error: 'כבר רץ', state: getPublicState() });
    }

    if (dialerState.isPaused) {
        // המשך מפאוז
        dialerState.isPaused = false;
        dialerState.isPlaying = true;
        addLog('▶️  המשך מפאוז');
        dialingLoop();
        return res.json({ success: true, action: 'resumed', state: getPublicState() });
    }

    dialerState.isPlaying = true;
    dialerState.isPaused = false;
    dialingLoop(); // לא await — רץ ברקע

    res.json({ success: true, action: 'started', state: getPublicState() });
});

// ⏸️ PAUSE
app.post('/dialer/pause', auth, (req, res) => {
    if (!dialerState.isPlaying) {
        return res.json({ success: false, error: 'הדיילר לא רץ' });
    }

    dialerState.isPaused = true;
    addLog('⏸️  בקשת פאוז התקבלה — יעצור אחרי השיחה הנוכחית');

    res.json({ success: true, action: 'pausing', state: getPublicState() });
});

// 📊 STATUS
app.get('/dialer/status', auth, (req, res) => {
    res.json({ success: true, state: getPublicState() });
});

function getPublicState() {
    return {
        status: dialerState.isPlaying && !dialerState.isPaused ? 'playing'
              : dialerState.isPaused ? 'paused'
              : 'stopped',
        currentRecord: dialerState.currentRecord,
        stats: dialerState.stats,
        startedAt: dialerState.startedAt,
        recentLog: dialerState.log.slice(0, 10)
    };
}

// ─── הפעלה ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n📞 === POWER DIALER ===`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`▶️  Play:   POST /dialer/play`);
    console.log(`⏸️  Pause:  POST /dialer/pause`);
    console.log(`📊 Status: GET  /dialer/status`);
    console.log(`⏰ Started: ${new Date().toISOString()}\n`);
});

process.on('SIGTERM', () => {
    dialerState.isPlaying = false;
    process.exit(0);
});
