// Fire-and-forget dial logger for the power-dialer.
// Posts one row per placed call to our own dial_log (via the self-hosted
// functions router's `log-dial` endpoint), so call counts come from our data
// rather than Maskyoo's leg-duplicated CDR. Never throws and never blocks the
// dialing loop — on any failure it logs a warning and moves on.
//
// Config (all via env, with safe defaults):
//   DIAL_LOG_URL    - full URL of the log-dial endpoint
//   DIAL_LOG_TOKEN  - shared secret, sent as x-dial-token (matches the function's env)
//   DIAL_LOG_APIKEY - Supabase anon/publishable key, if the public proxy requires it
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// power-dialer isn't managed with a pm2 env block, so config can also come from
// a small JSON file next to this module (env still wins if set).
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'dial-log.config.json'), 'utf8')) || {}; } catch (_) { /* optional */ }

const DIAL_LOG_URL = process.env.DIAL_LOG_URL || fileCfg.url || 'https://app.calls.org.il/functions/v1/log-dial';
const DIAL_LOG_TOKEN = process.env.DIAL_LOG_TOKEN || fileCfg.token || '';
const DIAL_LOG_APIKEY = process.env.DIAL_LOG_APIKEY || fileCfg.apikey || '';

/**
 * @param {object} data { rep_phone, donor_phone, call_status, duration_seconds, maskyoo_uuid, started_at, institution_name }
 * @param {(msg:string)=>void} [log] optional logger (e.g. the dialer's addLog)
 */
function postTo(url, data, log) {
  return new Promise((resolve) => {
  try {
    const payload = JSON.stringify(data || {});
    const u = new URL(url);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (DIAL_LOG_TOKEN) headers['x-dial-token'] = DIAL_LOG_TOKEN;
    if (DIAL_LOG_APIKEY) { headers['apikey'] = DIAL_LOG_APIKEY; headers['Authorization'] = 'Bearer ' + DIAL_LOG_APIKEY; }

    const opt = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: 5000,
    };
    const client = u.protocol === 'http:' ? http : https;
    const req = client.request(opt, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 300 && log) log(`⚠️ dial-log ${res.statusCode}`);
        resolve();
      });
    });
    req.on('error', (e) => { if (log) log(`⚠️ dial-log נכשל: ${e.message}`); resolve(); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  } catch (e) {
    if (log) log(`⚠️ dial-log exception: ${e.message}`);
    resolve();
  }
  });
}

function logDial(data, log) {
  return postTo(DIAL_LOG_URL, data, log);
}

// Presence ping for the live screen ("rep is dialing now"), same endpoint and auth.
function touchActivity(repEmail, action, log) {
  if (!repEmail) return Promise.resolve();
  return logDial({ touch: true, rep_email: repEmail, action: action || 'dial' }, log);
}

// Keeps every analyzed call's transcript in our DB (Airtable overwrites it on the next call).
const SAVE_TRANSCRIPT_URL = DIAL_LOG_URL.replace(/log-dial$/, 'save-transcript');
function saveTranscript(data, log) {
  return postTo(SAVE_TRANSCRIPT_URL, data, log);
}

module.exports = { logDial, touchActivity, saveTranscript };
