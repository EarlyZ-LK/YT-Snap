import express from 'express';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const TOKEN = process.env.ACCESS_TOKEN || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const YTDLP_ARGS = (() => {
  const a = (process.env.YTDLP_EXTRA_ARGS || '').split(' ').filter(Boolean);
  // A missing cookies file makes yt-dlp crash when it tries to save it back, so drop the option and say so.
  const i = a.indexOf('--cookies');
  if (i !== -1 && a[i + 1] && !existsSync(path.resolve(a[i + 1]))) {
    console.warn(`WARNING: cookies file not found at ${path.resolve(a[i + 1])}. Running yt-dlp without cookies. Check --cookies in YTDLP_EXTRA_ARGS.`);
    a.splice(i, 2);
  }
  return a;
})();
const PROMPTS = JSON.parse(await fs.readFile(path.join(__dirname, 'prompts.json'), 'utf8'));

await fs.mkdir(DATA, { recursive: true });

/* ---------- helpers ---------- */

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    // UTF-8 for the child's stdout/stderr: on Windows, piped Python output defaults to cp1252 and can crash on non-Latin titles
    const p = spawn(cmd, args, { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeout);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      // log everything for the operator, show the user the most useful single line
      console.error(`${cmd} failed (exit ${code}):\n${err.trim()}`);
      const lines = err.trim().split('\n').map(l => l.trim()).filter(Boolean).reverse();
      const msg = lines.find(l => /^ERROR:/.test(l)) || lines.find(l => !/^\[PYI-/.test(l)) || `${cmd} exited with code ${code}`;
      reject(new Error(msg));
    });
  });
}

// "90", "90s", "1m30s", "1h2m3s", "1:30", "1:02:03" -> seconds
function parseTime(v) {
  if (v === undefined || v === null) return null;
  v = String(v).trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  if (v.includes(':')) {
    const parts = v.split(':').map(Number);
    if (parts.length > 3 || parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

function parseYoutube(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('That is not a valid URL.'); }
  if (!HOSTS.has(u.hostname)) throw new Error('Only YouTube links are supported.');
  const id = u.hostname === 'youtu.be'
    ? u.pathname.slice(1)
    : u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Could not find a video ID in that URL.');
  const time =
    parseTime(u.searchParams.get('t')) ??
    parseTime(u.searchParams.get('start')) ??
    parseTime(u.hash.replace(/^#t=/, '')) ?? 0;
  return { id, time };
}

// gpt-image-1 only outputs 1024x1024, 1536x1024 or 1024x1536, so the frame is
// letterboxed onto the closest canvas and cropped back out afterwards.
function plan(w, h) {
  const ar = w / h;
  let cw, ch;
  if (ar >= 1.25) { cw = 1536; ch = 1024; }
  else if (ar <= 0.8) { cw = 1024; ch = 1536; }
  else { cw = 1024; ch = 1024; }
  const s = Math.min(cw / w, ch / h);
  const fw = Math.max(2, Math.round((w * s) / 2) * 2);
  const fh = Math.max(2, Math.round((h * s) / 2) * 2);
  return { cw, ch, fw, fh, x: (cw - fw) / 2, y: (ch - fh) / 2 };
}

const ffmpeg = (...args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/* ---------- app ---------- */

const app = express();
app.use(express.json({ limit: '100kb' }));

function auth(req, res, next) {
  if (!TOKEN) return next();
  const given = req.get('x-access-token') || '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Access token missing or wrong.' });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) =>
  res.json({ needsToken: !!TOKEN, hasKey: !!OPENAI_KEY, model: MODEL,
             prompts: PROMPTS.map(({ id, label, text }) => ({ id, label, text })) }));

app.post('/api/capture', auth, async (req, res) => {
  try {
    const parsed = parseYoutube(req.body.url);
    const override = parseTime(req.body.time);
    const t = override ?? parsed.time;
    const step = [0.25, 0.5, 1].includes(Number(req.body.step)) ? Number(req.body.step) : 0.5;

    const info = JSON.parse(await run('yt-dlp', [
      '-f', 'bv*/b', '--no-playlist', '--no-warnings', '-j', ...YTDLP_ARGS,
      `https://www.youtube.com/watch?v=${parsed.id}`
    ]));
    if (info.duration && t > info.duration) throw new Error(`That time is past the end of the video (${Math.floor(info.duration)}s).`);

    const id = crypto.randomBytes(6).toString('hex');
    // three candidates: one step before, the linked time, one step after
    const maxT = info.duration ? Math.max(0, info.duration - 0.1) : Infinity;
    const frames = [-step, 0, step].map((o, i) => ({
      i, time: Math.min(maxT, Math.max(0, +(t + o).toFixed(3)))
    }));
    // -ss before -i = fast seek on the remote stream, still frame-accurate when decoding a single frame.
    // One decode per frame, three outputs: full-quality PNG, 1600px preview and 480px thumbnail (small JPEGs keep the UI fast).
    const jpg = w => `scale='min(${w},iw)':-2,format=yuvj420p`;
    await Promise.all(frames.map(f =>
      ffmpeg('-ss', String(f.time), '-i', info.url,
             '-map', '0:v:0', '-frames:v', '1', '-compression_level', '6', path.join(DATA, `${id}-f${f.i}.png`),
             '-map', '0:v:0', '-frames:v', '1', '-vf', jpg(1600), '-q:v', '3', path.join(DATA, `${id}-p${f.i}.jpg`),
             '-map', '0:v:0', '-frames:v', '1', '-vf', jpg(480), '-q:v', '5', path.join(DATA, `${id}-t${f.i}.jpg`))));

    const meta = { id, videoId: parsed.id, title: info.title, time: t, step, frames,
                   width: info.width, height: info.height, vcodec: info.vcodec, fps: info.fps };
    await fs.writeFile(path.join(DATA, `${id}.json`), JSON.stringify(meta));
    res.json(meta);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/enhance', auth, async (req, res) => {
  try {
    if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set on the server.');
    const { id, promptId, matchSize } = req.body;
    const frame = Number(req.body.frame);
    if (!/^[a-f0-9]{12}$/.test(id || '')) throw new Error('Unknown snapshot.');
    if (![0, 1, 2].includes(frame)) throw new Error('Pick one of the three frames.');
    const meta = JSON.parse(await fs.readFile(path.join(DATA, `${id}.json`), 'utf8'));
    const prompt = PROMPTS.find(p => p.id === promptId) || PROMPTS[0];

    const original = path.join(DATA, `${id}-f${frame}.png`);
    const prep = path.join(DATA, `${id}-prep${frame}.png`);
    const raw = path.join(DATA, `${id}-raw${frame}.png`);
    const final = path.join(DATA, `${id}-e${frame}.png`);

    const P = plan(meta.width, meta.height);
    const padded = P.fw !== P.cw || P.fh !== P.ch;
    await ffmpeg('-i', original, '-vf',
      `scale=${P.fw}:${P.fh}:flags=lanczos,pad=${P.cw}:${P.ch}:${P.x}:${P.y}:black`, prep);

    const text = prompt.text + (padded
      ? ' The black bars around the picture are padding: leave them completely black and keep the picture exactly within its current frame.'
      : '');

    const form = new FormData();
    form.append('model', MODEL);
    form.append('prompt', text);
    form.append('image', new Blob([await fs.readFile(prep)], { type: 'image/png' }), 'frame.png');
    form.append('size', `${P.cw}x${P.ch}`);
    form.append('quality', 'high');
    form.append('input_fidelity', 'high');
    form.append('n', '1');

    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form
    });
    const j = await r.json();
    if (!r.ok) {
      const msg = j.error?.message || `OpenAI error ${r.status}`;
      const err = new Error(msg);
      if (/insufficient_quota|billing_hard_limit_reached/.test(j.error?.code || '') ||
          /no credits|exceeded your current quota|billing/i.test(msg)) err.code = 'no_credits';
      throw err;
    }
    await fs.writeFile(raw, Buffer.from(j.data[0].b64_json, 'base64'));

    let vf = `crop=${P.fw}:${P.fh}:${P.x}:${P.y}`;
    if (matchSize) vf += `,scale=${meta.width}:${meta.height}:flags=lanczos`;
    await ffmpeg('-i', raw, '-vf', vf, final);
    await ffmpeg('-i', final, '-vf', "scale='min(1600,iw)':-2,format=yuvj420p", '-q:v', '3',
                 path.join(DATA, `${id}-q${frame}.jpg`));
    await Promise.all([prep, raw].map(f => fs.rm(f, { force: true })));

    res.json({ id, frame, matchSize: !!matchSize, promptId: prompt.id });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

app.get('/api/files/:name', auth, (req, res) => {
  const name = req.params.name;
  if (!/^[a-f0-9]{12}-([fe][0-2]\.png|[tpq][0-2]\.jpg)$/.test(name)) return res.sendStatus(404);
  const mutable = /-[eq][0-2]\./.test(name); // enhanced results can be regenerated under the same name
  res.sendFile(path.join(DATA, name),
    { headers: { 'Cache-Control': mutable ? 'private, no-cache' : 'private, max-age=86400, immutable' } },
    err => err && !res.headersSent && res.sendStatus(404));
});

// delete anything older than 24h
setInterval(async () => {
  for (const f of await fs.readdir(DATA).catch(() => [])) {
    const p = path.join(DATA, f);
    const st = await fs.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 24 * 3600 * 1000) fs.rm(p, { force: true });
  }
}, 3600 * 1000).unref();

app.listen(PORT, () => console.log(`YT Snap listening on :${PORT}`));
