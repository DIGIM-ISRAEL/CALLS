#!/usr/bin/env node
/**
 * transcription-lab.js — comparative eval harness for Hebrew call transcription.
 *
 * Runs several transcription strategies on the N longest recordings and writes a
 * side-by-side comparison, so we can pick the best approach before changing
 * speech-analyzer.js (Part 1 of the approved plan).
 *
 * Strategies compared per recording:
 *   A baseline     — current prod: gpt-4o-transcribe, whole file, temperature 0
 *   B whisper-1    — whisper-1, verbose_json (segment timestamps surface gaps/cutoffs)
 *   C gpt4o-temp02 — gpt-4o-transcribe, temperature 0.2 (does it reduce repetition loops?)
 *   D chunked      — split with ffmpeg into ~120s segments, transcribe each, stitch
 *                    (guards against the whole-file cutoff that truncates long calls)
 *
 * Usage (on the CALLS droplet):
 *   OPENAI_API_KEY=sk-... node transcription-lab.js [N] [recordingsDir]
 *   (if OPENAI_API_KEY is unset it is parsed from speech-analyzer.js)
 *
 * Output: ./transcription-lab-out/<recording>.txt per file + a summary table on stdout.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');
const FormData = require('form-data');
const { Readable } = require('stream');

const N = parseInt(process.argv[2] || '5', 10);
const RECORDINGS_DIR = process.argv[3] || path.join(__dirname, 'recordings');
const OUT_DIR = path.join(__dirname, 'transcription-lab-out');
const CHUNK_SECONDS = 120;

function getApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'speech-analyzer.js'), 'utf8');
    const m = src.match(/apiKey:\s*['"`](sk-[^'"`]+)['"`]/);
    if (m) return m[1];
  } catch { /* ignore */ }
  throw new Error('No OpenAI API key: set OPENAI_API_KEY or ensure speech-analyzer.js has one.');
}
const API_KEY = getApiKey();

function transcribe(buffer, filename, { model, response_format = 'json', temperature = 0 }) {
  return new Promise((resolve) => {
    const form = new FormData();
    const s = new Readable({ read() {} });
    s.push(buffer); s.push(null);
    form.append('file', s, { filename, contentType: 'audio/mpeg' });
    form.append('model', model);
    form.append('language', 'he');
    form.append('response_format', response_format);
    form.append('temperature', String(temperature));
    form.append('prompt', 'שיחת מכירה בעברית. יש לפסק משפטים ולהוסיף סימני פיסוק.');

    const started = Date.now();
    const req = https.request({
      hostname: 'api.openai.com', port: 443, path: '/v1/audio/transcriptions', method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, ...form.getHeaders() },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const ms = Date.now() - started;
        if (res.statusCode !== 200) return resolve({ error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}`, ms });
        try {
          const j = JSON.parse(data);
          resolve({ text: j.text || '', segments: j.segments || null, ms });
        } catch (e) { resolve({ error: `parse: ${e.message}`, ms }); }
      });
    });
    // The missing guard in prod: a hard timeout so one stuck request can't hang forever.
    req.setTimeout(180000, () => { req.destroy(new Error('timeout after 180s')); });
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - started }));
    form.pipe(req);
  });
}

async function withRetry(fn, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (!r.error) return r;
    last = r;
  }
  return last;
}

async function chunked(filePath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlab-'));
  const started = Date.now();
  try {
    execFileSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-i', filePath, '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
      '-c:a', 'libmp3lame', '-b:a', '64k', path.join(tmp, 'seg_%03d.mp3')], { stdio: 'ignore' });
    const segs = fs.readdirSync(tmp).filter(f => f.endsWith('.mp3')).sort();
    const parts = [];
    for (const seg of segs) {
      const buf = fs.readFileSync(path.join(tmp, seg));
      const r = await withRetry(() => transcribe(buf, seg, { model: 'gpt-4o-transcribe' }));
      if (r.error) return { error: `chunk ${seg}: ${r.error}`, ms: Date.now() - started };
      parts.push((r.text || '').trim());
    }
    return { text: parts.join(' '), ms: Date.now() - started, chunks: segs.length };
  } catch (e) {
    return { error: `ffmpeg/chunk: ${e.message}`, ms: Date.now() - started };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function longestN(dir, n) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.mp3'))
    .map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size).slice(0, n).map(x => x.f);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = longestN(RECORDINGS_DIR, N);
  console.log(`Model baseline: gpt-4o-transcribe | recordings: ${files.length} (longest by size)\n`);
  const summary = [];
  for (const file of files) {
    const fp = path.join(RECORDINGS_DIR, file);
    const buf = fs.readFileSync(fp);
    const kb = Math.round(buf.length / 1024);
    console.log(`\n=== ${file} (${kb} KB) ===`);

    const variants = process.env.ONLY_CHUNKED
      ? { D_chunked: await chunked(fp) }
      : {
        A_baseline:     await withRetry(() => transcribe(buf, file, { model: 'gpt-4o-transcribe', temperature: 0 })),
        B_whisper1:     await withRetry(() => transcribe(buf, file, { model: 'whisper-1', response_format: 'verbose_json', temperature: 0 })),
        C_gpt4o_temp02: await withRetry(() => transcribe(buf, file, { model: 'gpt-4o-transcribe', temperature: 0.2 })),
        D_chunked:      await chunked(fp),
      };

    let out = `FILE: ${file} (${kb} KB)\n${'='.repeat(70)}\n`;
    for (const [name, r] of Object.entries(variants)) {
      const chars = r.text ? r.text.length : 0;
      const info = r.error ? `ERROR ${r.error}` : `${chars} chars, ${Math.round(r.ms / 1000)}s${r.chunks ? `, ${r.chunks} chunks` : ''}`;
      console.log(`  ${name.padEnd(16)} ${info}`);
      summary.push({ file, variant: name, chars, ms: r.ms, error: r.error || '' });
      out += `\n----- ${name} (${info}) -----\n${r.error ? r.error : r.text}\n`;
    }
    fs.writeFileSync(path.join(OUT_DIR, file.replace(/\.mp3$/, '') + '.txt'), out, 'utf8');
  }

  console.log(`\n\n===== SUMMARY (chars per variant) =====`);
  const byFile = {};
  summary.forEach(s => { (byFile[s.file] ||= {})[s.variant] = s.error ? 'ERR' : s.chars; });
  for (const [file, v] of Object.entries(byFile)) {
    console.log(`${file}\n  A=${v.A_baseline}  B(whisper1)=${v.B_whisper1}  C(temp0.2)=${v.C_gpt4o_temp02}  D(chunked)=${v.D_chunked}`);
  }
  console.log(`\nFull side-by-side transcripts written to: ${OUT_DIR}/`);
  console.log(`Compare: longer char counts + readable punctuation + no repetition loops = better.`);
})();
