// One-shot, idempotent patch: wire dial-logger into power-dialer.js without
// touching its hardcoded config/keys. Run on the CALLS droplet:
//   node apply-dial-logging.js
// Then: pm2 restart power-dialer
const fs = require('fs');
const FILE = './power-dialer.js';
let src = fs.readFileSync(FILE, 'utf8');
let changed = false;

// 1) require the logger (after the http require).
if (!src.includes("require('./dial-logger')")) {
  src = src.replace(
    /const http = require\('http'\);/,
    "const http = require('http');\nconst { logDial } = require('./dial-logger');"
  );
  changed = true;
}

// 2) log every placed call, right after it ends.
if (!src.includes('logDial({')) {
  const anchor = 'const callEnd = await waitForCallToEnd(phoneMyUser, phoneNumber, callStartTime);';
  const inject = anchor + '\n' +
    '        logDial({\n' +
    '            rep_phone: phoneMyUser,\n' +
    '            donor_phone: phoneNumber,\n' +
    '            call_status: callEnd.status || callEnd.reason || "unknown",\n' +
    '            duration_seconds: callEnd.duration || 0,\n' +
    '            maskyoo_uuid: callEnd.uuid || null,\n' +
    '            started_at: new Date(callStartTime).toISOString(),\n' +
    '        }, addLog);';
  if (src.includes(anchor)) { src = src.replace(anchor, inject); changed = true; }
  else { console.error('ANCHOR NOT FOUND — waitForCallToEnd call site changed; patch manually.'); process.exit(1); }
}

if (changed) {
  fs.writeFileSync(FILE + '.bak_' + Date.now(), fs.readFileSync(FILE));
  fs.writeFileSync(FILE, src);
  console.log('✅ patched power-dialer.js (backup written). Now: pm2 restart power-dialer');
} else {
  console.log('ℹ️ already patched — nothing to do.');
}
