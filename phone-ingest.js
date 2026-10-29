// phone-ingest.js — ערוץ חיוג מהטלפון (ללא Maskyoo)
// Routes:
//   POST /ingest-call      (multipart: audio + metadata) — העלאת שיחה שהוקלטה בטלפון
//   POST /dial-started     (json) — רגע לפני חיוג, כדי שכרטיס הליד ייפתח במחשב הנציג
//   GET  /app/current-dial?repEmail=  — נקרא ע"י הווב כדי לפתוח את הכרטיס
//
// החוזה: ראה DIALER_APP_SPEC. השרת לא נוגע בזרימת Maskyoo הקיימת — הכול אדיטיבי.
// אימות: header X-Secret-Key == APP_SECRET_KEY (מפתח נפרד לאפליקציה; env או /var/webhook-forwarder/.app-key)
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

let multer = null;
try { multer = require('multer'); } catch (_) { /* נבדק ב-register */ }
const { logDial } = require('./dial-logger');

const REC_DIR = '/var/webhook-forwarder/recordings';
const SEEN_FILE = '/var/webhook-forwarder/.phone-ingest-seen.json';
const APP_KEY = process.env.APP_SECRET_KEY
  || (() => { try { return fs.readFileSync('/var/webhook-forwarder/.app-key', 'utf8').trim(); } catch (_) { return ''; } })();

// ─── Airtable (טוקן מ-.airtable-key; הערך לעולם לא נרשם ללוג) ──
const { airtableConfig: airtableCfg } = require('./server-secrets');

function formatPhone(p) {
  let c = String(p || '').replace(/\D/g, '');
  if (c.startsWith('0')) c = '972' + c.slice(1);
  if (!c.startsWith('972')) c = '972' + c;
  if (c.startsWith('9720')) c = '972' + c.slice(4);
  return c;
}

function atRequest(method, path, body) {
  return new Promise((resolve) => {
    const cfg = airtableCfg();
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.airtable.com', path, method,
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: x.statusCode, j }); }); });
    req.on('error', () => resolve({ status: 0 }));
    if (data) req.write(data);
    req.end();
  });
}

async function findLeadByPhone(num972) {
  const cfg = airtableCfg();
  const digits = String(num972).replace(/\D/g, '').slice(-9);
  if (!digits) return null;
  const formula = encodeURIComponent(`FIND("${digits}", SUBSTITUTE(SUBSTITUTE({phone_number}&"","-",""),"+",""))`);
  const { j } = await atRequest('GET', `/v0/${cfg.baseId}/${cfg.tableId}?filterByFormula=${formula}&maxRecords=1&fields%5B%5D=phone_my_user`);
  const rec = j && j.records && j.records[0];
  return rec ? { id: rec.id, phone_my_user: (rec.fields || {}).phone_my_user } : null;
}

async function getLeadPhoneMyUser(recordId) {
  const cfg = airtableCfg();
  const { j } = await atRequest('GET', `/v0/${cfg.baseId}/${cfg.tableId}/${recordId}?fields%5B%5D=phone_my_user`);
  const v = j && j.fields ? j.fields.phone_my_user : null;
  return Array.isArray(v) ? v[0] : v;
}

// ─── idempotency (clientDialId) ──
let seen = {};
try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (_) {}
function markSeen(id, r) {
  seen[id] = { t: Date.now(), r };
  try {
    const cut = Date.now() - 3 * 864e5;
    for (const k in seen) if (seen[k].t < cut) delete seen[k];
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
  } catch (_) {}
}

// ─── current-dial (in-memory; לפתיחת כרטיס בווב) ──
const currentDial = new Map(); // repEmail -> { leadRecordId, toNumber, clientDialId, ts, at }

function register(app, deps) {
  const auth = (req, res, next) => {
    if (!APP_KEY || req.headers['x-secret-key'] !== APP_KEY) return res.status(403).json({ ok: false, error: 'bad key' });
    next();
  };

  app.post('/dial-started', auth, (req, res) => {
    const b = req.body || {};
    const email = String(b.repEmail || '').toLowerCase();
    if (email) currentDial.set(email, { leadRecordId: b.leadRecordId || null, toNumber: b.toNumber || null, clientDialId: b.clientDialId || null, ts: b.ts || null, at: Date.now() });
    res.json({ ok: true });
  });

  app.get('/app/current-dial', (req, res) => {
    const email = String(req.query.repEmail || '').toLowerCase();
    const d = currentDial.get(email);
    if (d && Date.now() - d.at < 25000) return res.json({ ok: true, dial: d });
    res.json({ ok: true, dial: null });
  });

  const ingest = async (req, res) => {
    const audio = req.file || null;
    const cleanup = () => { if (audio && audio.path) { try { fs.unlinkSync(audio.path); } catch (_) {} } };
    try {
      const b = req.body || {};
      const clientDialId = String(b.clientDialId || '').trim();
      const outcome = String(b.outcome || '').trim();
      const repEmail = String(b.repEmail || '').toLowerCase();
      const toNumber = formatPhone(b.toNumber);
      const dialTime = b.dialTime || new Date().toISOString();
      const durationSec = parseInt(b.durationSec, 10) || 0;
      let leadRecordId = b.leadRecordId || null;

      if (!clientDialId) { cleanup(); return res.status(400).json({ ok: false, error: 'clientDialId required' }); }
      if (seen[clientDialId]) { cleanup(); return res.status(200).json({ ok: true, duplicate: true, ...(seen[clientDialId].r || {}) }); }

      // resolve lead + rep phone
      let repPhone = null;
      if (!leadRecordId && toNumber) {
        const f = await findLeadByPhone(toNumber);
        if (f) { leadRecordId = f.id; repPhone = Array.isArray(f.phone_my_user) ? f.phone_my_user[0] : f.phone_my_user; }
      } else if (leadRecordId) {
        repPhone = await getLeadPhoneMyUser(leadRecordId);
      }

      const statusMap = { answered: 'Answered', no_answer: 'No Answer', failed: 'No Answer', busy: 'No Answer' };
      const call_status = statusMap[outcome] || 'No Answer';

      // שלב 1: אם נענתה והוקלטה — להעביר את הקובץ לשם קבוע ולחשב URL ציבורי (למצורף איירטייבל)
      let recFilename = null, recDest = null, recSize = 0, recUrl = null;
      if (outcome === 'answered' && audio) {
        const ext = (audio.originalname && audio.originalname.includes('.'))
          ? audio.originalname.split('.').pop().replace(/[^a-z0-9]/gi, '').slice(0, 5) : 'm4a';
        recFilename = `phone_${clientDialId}.${ext || 'm4a'}`;
        recDest = `${REC_DIR}/${recFilename}`;
        try { fs.renameSync(audio.path, recDest); } catch (_) { fs.copyFileSync(audio.path, recDest); try { fs.unlinkSync(audio.path); } catch (_) {} }
        recSize = fs.statSync(recDest).size;
        recUrl = `https://leads.digim.co.il/recordings/${recFilename}`; // מוגש ע"י webhook-forwarder (/recordings/)
      } else if (audio) {
        cleanup();
      }

      // שלב 2: עדכון הליד — סטטוס/זמן/UUID + מצורף ההקלטה (איירטייבל מושך מה-URL). אין id_caller ב-Telemarketing → UUID.
      if (leadRecordId) {
        // call_time הוא שדה date (תאריך בלבד) — שולחים את חלק התאריך מ-dialTime
        const fields = { call_status, call_time: String(dialTime).slice(0, 10), UUID: clientDialId };
        if (recUrl) fields['Recording File'] = [{ url: recUrl }];
        await atRequest('PATCH', `/v0/${airtableCfg().baseId}/${airtableCfg().tableId}/${leadRecordId}`, { fields });
      }

      try { logDial({ rep_phone: repPhone || repEmail, donor_phone: toNumber, call_status, duration_seconds: durationSec, maskyoo_uuid: clientDialId, started_at: dialTime }); } catch (_) {}

      // שלב 3: ניתוח (רק אם נענתה והוקלטה)
      let analysisStarted = false;
      if (recDest && leadRecordId) {
        const params = {
          uuid: clientDialId, recordId: leadRecordId, airtableConfig: airtableCfg(),
          callInfo: { cdr_uniqueid: clientDialId, cdr_ani: repPhone || '', user_phone: toNumber, call_duration: durationSec, call_status: 'Answered', source: 'phone' },
          recording: { filename: recFilename, filePath: recDest, size: recSize, downloadUrl: recUrl },
          timestamp: new Date().toISOString(), step: 4, source: 'phone',
        };
        const an = spawn('node', ['donation-analyzer.js'], { cwd: '/var/webhook-forwarder', stdio: ['pipe', 'ignore', 'ignore'], detached: true });
        an.stdin.write(JSON.stringify(params)); an.stdin.end(); an.unref();
        analysisStarted = true;
      }

      const r = { leadRecordId, matched: !!leadRecordId };
      markSeen(clientDialId, r);
      return res.status(200).json({ ok: true, ...r, outcome, analysisStarted });
    } catch (e) {
      cleanup();
      console.error('❌ /ingest-call error:', e.message);
      return res.status(500).json({ ok: false, error: 'server error' }); // 5xx → האפליקציה תנסה שוב
    }
  };

  if (multer) {
    const upload = multer({ dest: REC_DIR, limits: { fileSize: 160 * 1024 * 1024 } });
    app.post('/ingest-call', auth, upload.single('audio'), ingest);
  } else {
    app.post('/ingest-call', auth, (req, res) => res.status(500).json({ ok: false, error: 'multer not installed' }));
  }

  console.log(`📲 phone-ingest mounted (/ingest-call /dial-started /app/current-dial) key=${APP_KEY ? 'set' : 'MISSING'} multer=${multer ? 'ok' : 'MISSING'}`);
}

module.exports = { registerPhoneRoutes: register };
