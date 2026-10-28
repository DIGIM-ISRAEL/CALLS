// Idempotent patch: make the power-dialer skip non-Israeli (diaspora) numbers,
// which the Israeli dialer/Maskyoo can't dial (they'd be mangled to "972…").
// Run on the CALLS droplet:  node apply-intl-skip.js  then  pm2 restart power-dialer
const fs = require('fs');
const FILE = './power-dialer.js';
let src = fs.readFileSync(FILE, 'utf8');
let changed = false;

// 1) helper (insert once, before the dialing loop)
if (!src.includes('function isInternationalPhone')) {
  const fn = `function isInternationalPhone(raw) {\n` +
    `    const c = String(raw || '').replace(/\\D/g, '');\n` +
    `    if (!c) return false;\n` +
    `    if (c.startsWith('972')) return false;\n` +
    `    if (c.startsWith('0')) return false;\n` +
    `    if (c.length <= 9) return false;\n` +
    `    return true;\n` +
    `}\n\n`;
  const anchor = 'async function dialingLoop()';
  if (src.includes(anchor)) { src = src.replace(anchor, fn + anchor); changed = true; }
  else { console.error('ANCHOR dialingLoop not found'); process.exit(1); }
}

// 2) skip international numbers in the loop (check the RAW field, before formatPhone)
if (!src.includes('מספר חו"ל')) {
  const anchor = 'if (!phoneNumber || !phoneMyUser) {';
  const inject = `if (isInternationalPhone(fields.phone_number)) {\n` +
    `            addLog(\`🌍 דילוג — מספר חו"ל (\${recordId})\`);\n` +
    `            dialerState.stats.skipped++;\n` +
    `            continue;\n` +
    `        }\n\n        ` + anchor;
  if (src.includes(anchor)) { src = src.replace(anchor, inject); changed = true; }
  else { console.error('ANCHOR missing-phone check not found'); process.exit(1); }
}

if (changed) {
  fs.writeFileSync(FILE + '.bak_intl_' + Date.now(), fs.readFileSync(FILE));
  fs.writeFileSync(FILE, src);
  console.log('✅ patched power-dialer.js (international skip). Now: pm2 restart power-dialer');
} else {
  console.log('ℹ️ already patched — nothing to do.');
}
