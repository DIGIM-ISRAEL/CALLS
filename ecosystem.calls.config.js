// Calls (reps) dial stack — runs ONLY on the calls server 46.101.204.111. Kill Gong lives on 46.101.212.74.
const D = "/var/calls-dialer";
const PATH = "/opt/vad-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const base = { cwd: D, instances: 1, exec_mode: "fork", autorestart: true, watch: false };
module.exports = { apps: [
  { ...base, name: "calls-donation-server", script: D + "/donation-server.js", max_memory_restart: "300M", env: { NODE_ENV: "production", PORT: 3002, TZ: "Asia/Jerusalem", PATH } },
  { ...base, name: "calls-power-dialer", script: D + "/power-dialer.js", env: { NODE_ENV: "production", PORT: 3003, TZ: "Asia/Jerusalem", PATH } },
  { ...base, name: "calls-answer-checker", script: D + "/answer-checker.js", env: { NODE_ENV: "production", PORT: 3020, TZ: "Asia/Jerusalem", PATH } },
  { ...base, name: "calls-vad-server", script: D + "/vad_server.py", interpreter: "/opt/vad-venv/bin/python", env: { PYTHONUNBUFFERED: "1", PYTHONWARNINGS: "ignore" } },
  { ...base, name: "calls-incoming-call-matcher", script: D + "/incoming-call-matcher.js", env: { NODE_ENV: "production", TZ: "Asia/Jerusalem", PATH } },
]};
