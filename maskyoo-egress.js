// Maskyoo's Cloudflare allowlists only 46.101.212.74, so Maskyoo API traffic - and only that -
// tunnels through a CONNECT relay there (tinyproxy: allows only this server, filtered to
// app.maskyoo.co.il:443). TLS is end-to-end: the relay never sees the API key or call data.
// Loaded once from server-secrets.js, which every Maskyoo-using script requires.
// MASKYOO_EGRESS_PROXY=off disables it (e.g. once Maskyoo allowlists this server directly).
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const HOST = 'app.maskyoo.co.il';
const PROXY = process.env.MASKYOO_EGRESS_PROXY || 'http://46.101.212.74:8899';

if (!https.__maskyooEgress && PROXY !== 'off') {
  const agent = new HttpsProxyAgent(PROXY);
  for (const fn of ['request', 'get']) {
    const orig = https[fn];
    https[fn] = function (...args) {
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        if (new URL(args[0]).hostname === HOST) {
          if (args[1] && typeof args[1] === 'object' && typeof args[1] !== 'function') args[1] = { ...args[1], agent };
          else args.splice(1, 0, { agent });
        }
      } else if (args[0] && typeof args[0] === 'object') {
        const h = args[0].hostname || String(args[0].host || '').split(':')[0];
        if (h === HOST) args[0] = { ...args[0], agent };
      }
      return orig.apply(this, args);
    };
  }
  https.__maskyooEgress = true;
}
