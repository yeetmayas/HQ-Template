#!/usr/bin/env node
/* HQ Template: the local server.
 *
 *   node server/hq.js                 start, using ./data (created on first run)
 *   node server/hq.js --data <folder> keep your data somewhere else (or set HQ_DATA)
 *   node server/hq.js --port <n>      use another port (default 4870, or HQ_PORT)
 *   node server/hq.js --no-git        don't keep local history
 *
 * Uses only modules built into Node. Nothing to install.
 *
 * It serves the dashboard (app/), reads and writes your data folder, pushes file changes to
 * open pages (server-sent events), and after every saved change makes a local git commit inside
 * the data folder. That history never leaves your computer: the data repo has no remote.
 *
 * Phase 1 listens on this computer only (127.0.0.1). Phone access with a QR code and PIN
 * comes in phase 4.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const F = require('../app/format.js');
const L = require('../app/logic.js');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DEFAULTS = path.join(ROOT, 'defaults');
const EXAMPLE_SLUG = 'example-weekend-trip';
const DEFAULT_PORT = 4870;
const MAX_BODY = 1024 * 1024;
const SLUG = /^[A-Za-z0-9][\w-]*$/;
const TICKET_ID = /^T-\d{3,}$/;

/* ---------- options ---------- */

function parseArgs(argv, env) {
  const o = { port: null, data: env.HQ_DATA || path.join(ROOT, 'data'), git: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--port') o.port = Number(next());
    else if (a === '--data') o.data = next();
    else if (a === '--no-git') o.git = false;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  if (o.port == null && env.HQ_PORT) o.port = Number(env.HQ_PORT);
  o.portFixed = o.port != null;
  if (o.port == null) o.port = DEFAULT_PORT;
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be a number from 0 to 65535');
  o.data = path.resolve(o.data);
  return o;
}

/* ---------- small file helpers ---------- */

const version = (raw) => crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
const exists = (p) => fs.existsSync(p);

async function readText(p, fallback) {
  try { return await fsp.readFile(p, 'utf8'); } catch (e) { if (fallback !== undefined && e.code === 'ENOENT') return fallback; throw e; }
}

// Write to a hidden temp file, then rename, so a reader (or an AI) never sees half a file.
async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

async function copyDirNoOverwrite(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDirNoOverwrite(s, d);
    else if (e.isFile() && !exists(d)) await fsp.copyFile(s, d);
  }
}

async function listProjects(dataDir) {
  const dir = path.join(dataDir, 'projects');
  if (!exists(dir)) return [];
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory() && SLUG.test(e.name) && exists(path.join(dir, e.name, 'project.md'))) out.push(e.name);
  }
  return out.sort();
}

const byIdNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });
// Today's date on this computer, as YYYY-MM-DD.
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* ---------- local history: a git repo inside the data folder, never pushed ---------- */

function makeGit(dataDir, enabled) {
  const gitDir = path.join(dataDir, '.git');
  let queue = Promise.resolve();
  let identity = null;
  let usable = null;

  const gitFile = (args, opts) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dataDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
  // Always name the data repo explicitly, so git can never fall through to a repo above it
  // (for example the template repo, when data/ sits inside it).
  const run = (args) => gitFile(['--git-dir', gitDir, '--work-tree', dataDir, ...args]);

  async function available() {
    if (usable === null) { try { await gitFile(['--version']); usable = true; } catch { usable = false; } }
    return usable;
  }

  async function init() {
    if (!enabled) return { ok: false, why: 'turned off with --no-git' };
    if (!(await available())) return { ok: false, why: 'git is not installed, so there is no local history' };
    if (!exists(gitDir)) await gitFile(['init', '-q', dataDir]);
    return { ok: true };
  }

  async function ident() {
    if (identity) return identity;
    let email = '';
    try { email = (await run(['config', 'user.email'])).trim(); } catch { /* not set */ }
    identity = email ? [] : ['-c', 'user.name=HQ Template', '-c', 'user.email=hq@localhost'];
    return identity;
  }

  function commit(message) {
    const job = queue.then(async () => {
      if (!enabled || !exists(gitDir) || !(await available())) return { committed: false };
      await run(['add', '-A']);
      try {
        await run([...(await ident()), '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]);
        return { committed: true };
      } catch (e) {
        if (/nothing to commit|nothing added|no changes added/i.test(`${e.stdout}${e.stderr}`)) return { committed: false };
        throw e;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  return { init, commit, run, gitDir };
}

/* ---------- the data folder ---------- */

// Create anything missing from defaults. Never overwrites a file that already exists.
async function ensureData(dataDir) {
  const steps = [];
  const firstRun = !exists(path.join(dataDir, 'projects'));
  await fsp.mkdir(dataDir, { recursive: true });

  const copied = {};
  for (const f of ['design.json', 'RULES.md']) {
    const dst = path.join(dataDir, f);
    if (!exists(dst)) {
      const text = await fsp.readFile(path.join(DEFAULTS, f), 'utf8');
      await fsp.writeFile(dst, text, 'utf8');
      copied[f] = crypto.createHash('sha256').update(text).digest('hex');
      steps.push(`copied ${f} from defaults`);
    }
  }
  // Remember exactly which default was copied, so a later update can tell whether you've edited it.
  if (Object.keys(copied).length) {
    const stampFile = path.join(dataDir, '.hq-defaults.json');
    const stamp = JSON.parse(await readText(stampFile, '{}'));
    stamp.about = 'Which defaults were copied into this folder (sha256 of the copied text). Updates only replace files you have not edited.';
    stamp.copied = { ...(stamp.copied || {}), ...copied };
    await fsp.writeFile(stampFile, JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  }

  if (firstRun) {
    await copyDirNoOverwrite(path.join(DEFAULTS, 'example-project'), path.join(dataDir, 'projects', EXAMPLE_SLUG));
    steps.push(`added the example project (projects/${EXAMPLE_SLUG}); delete it whenever you like`);
  }

  for (const slug of await listProjects(dataDir)) {
    const dir = path.join(dataDir, 'projects', slug);
    await fsp.mkdir(path.join(dir, 'tickets'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'batches'), { recursive: true });
    const log = path.join(dir, 'log.md');
    if (!exists(log)) {
      let name = slug;
      try { name = F.parseProject(await fsp.readFile(path.join(dir, 'project.md'), 'utf8')).name || slug; } catch { /* keep slug */ }
      await fsp.writeFile(log, `# Decision log: ${name}\n\nEvery recorded decision, newest last: date, ticket, the decision in the user's words.\n`, 'utf8');
      steps.push(`created projects/${slug}/log.md`);
    }
  }

  const rankFile = path.join(dataDir, 'projects.md');
  if (!exists(rankFile)) {
    await fsp.writeFile(rankFile, F.serializeRanking(await listProjects(dataDir)), 'utf8');
    steps.push('created projects.md (your project ranking)');
  }

  const ignore = path.join(dataDir, '.gitignore');
  if (!exists(ignore)) await fsp.writeFile(ignore, '.DS_Store\n*.tmp\n', 'utf8');

  return { firstRun, steps };
}

async function loadProject(dataDir, slug, rank) {
  const dir = path.join(dataDir, 'projects', slug);
  const warnings = [];
  let project;
  try { project = F.parseProject(await fsp.readFile(path.join(dir, 'project.md'), 'utf8')); } catch (e) {
    project = { name: slug, goal: '', status: 'active', phases: [], extra: {}, intro: '', sections: [] };
    warnings.push(`projects/${slug}/project.md: ${e.message}`);
  }
  const tdir = path.join(dir, 'tickets');
  const files = exists(tdir) ? (await fsp.readdir(tdir)).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort(byIdNumber) : [];
  const tickets = [];
  for (const f of files) {
    const rel = `projects/${slug}/tickets/${f}`;
    const raw = await fsp.readFile(path.join(tdir, f), 'utf8');
    try {
      tickets.push({ ...F.parseTicket(raw), file: rel, version: version(raw) });
    } catch (e) {
      const id = f.slice(0, -3);
      tickets.push({ id, title: f, status: 'open', kind: 'decision', phase: '', needs: [], tags: [], options: [], choice: '', extra: {}, intro: '', sections: [], file: rel, version: version(raw), error: e.message });
      warnings.push(`${rel}: ${e.message}`);
    }
  }
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const phases = project.phases.map((p) => p.key);
  for (const t of tickets) {
    t.locked = F.isLocked(t, byId);
    t.rubric = F.rubric(t);
    t.visuals = F.visuals(t);
    t.warnings = t.error ? [t.error] : F.checkTicket(t, { fileId: path.basename(t.file, '.md'), phases, byId });
  }
  const log = F.parseLog(await readText(path.join(dir, 'log.md'), ''));
  return { slug, rank, ...project, tickets, log, byId, warnings };
}

async function loadState(dataDir) {
  const ranking = F.parseRanking(await readText(path.join(dataDir, 'projects.md'), ''));
  const order = F.rankProjects(ranking, await listProjects(dataDir));
  const projects = [];
  const warnings = [];
  for (let i = 0; i < order.length; i++) {
    const p = await loadProject(dataDir, order[i], i + 1);
    warnings.push(...p.warnings);
    delete p.byId;
    projects.push(p);
  }
  let design = null;
  try { design = JSON.parse(await fsp.readFile(path.join(dataDir, 'design.json'), 'utf8')); } catch (e) {
    warnings.push(`design.json: ${e.message} (using the default design)`);
    design = JSON.parse(await fsp.readFile(path.join(DEFAULTS, 'design.json'), 'utf8'));
  }
  return { dataDir, projects, design, warnings };
}

/* ---------- watching the data folder ---------- */

function watchData(dataDir, onChange) {
  let timer = null;
  const changed = new Set();
  const fire = (rel) => {
    const parts = String(rel || '').split(/[\\/]/).filter(Boolean);
    if (parts.some((p) => p.startsWith('.'))) return; // .git, temp files, .DS_Store
    changed.add(parts.join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => { const paths = [...changed]; changed.clear(); onChange(paths); }, 120);
  };
  try {
    const w = fs.watch(dataDir, { recursive: true }, (_ev, f) => fire(f));
    return () => { clearTimeout(timer); w.close(); };
  } catch {
    // Older Node on Linux has no recursive watch: watch each folder and pick up new ones.
    const watchers = new Map();
    const walk = (dir) => {
      if (!watchers.has(dir)) {
        try { watchers.set(dir, fs.watch(dir, (_ev, f) => { fire(path.relative(dataDir, path.join(dir, String(f || '')))); walk(dataDir); })); } catch { return; }
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name));
    };
    walk(dataDir);
    return () => { clearTimeout(timer); for (const w of watchers.values()) w.close(); };
  }
}

/* ---------- HTTP ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function send(res, status, body, headers) {
  const isText = typeof body === 'string' || Buffer.isBuffer(body);
  const data = isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Send JSON (Content-Type: application/json).'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'That request is too big.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'That is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function createApp(opts) {
  const dataDir = opts.data;
  const git = makeGit(dataDir, opts.git !== false);
  const clients = new Set();
  let allowedHosts = new Set();

  const ticketPath = (slug, id) => path.join(dataDir, 'projects', slug, 'tickets', `${id}.md`);

  async function readTicketFile(slug, id) {
    if (!SLUG.test(slug) || !TICKET_ID.test(id)) throw new HttpError(404, 'No such ticket.');
    const file = ticketPath(slug, id);
    const raw = await readText(file, null);
    if (raw == null) throw new HttpError(404, `There is no ticket ${id} in ${slug}.`);
    return { file, raw };
  }

  function checkVersion(raw, body) {
    if (typeof body.version !== 'string') throw new HttpError(400, 'Include the "version" you read, so a newer edit is never overwritten.');
    if (body.version !== version(raw)) throw new HttpError(409, 'This ticket changed on disk since you opened it (perhaps your AI edited it). Reload it and try again.', { version: version(raw) });
  }

  // Write one or more files, then make one local commit for the lot.
  async function save(file, text, message, more) {
    await writeAtomic(file, text);
    for (const [f, t] of more || []) await writeAtomic(f, t);
    let history;
    try { history = await git.commit(message); } catch (e) { history = { committed: false, error: (e.stderr || e.message || '').trim() }; }
    return history;
  }

  async function describeTicket(slug, id) {
    const p = await loadProject(dataDir, slug, 0);
    const t = p.byId[id];
    return t;
  }

  const routes = [
    ['GET', /^\/api\/state$/, async () => loadState(dataDir)],

    ['GET', /^\/api\/tickets\/([^/]+)\/([^/]+)$/, async (_req, [slug, id]) => {
      const { raw } = await readTicketFile(slug, id);
      return { ticket: await describeTicket(slug, id), raw, version: version(raw) };
    }],

    // Replace a ticket file's text (the fallback editor, or the dashboard writing a whole ticket).
    ['PUT', /^\/api\/tickets\/([^/]+)\/([^/]+)$/, async (req, [slug, id]) => {
      const body = await readJson(req);
      const { file, raw } = await readTicketFile(slug, id);
      checkVersion(raw, body);
      if (typeof body.raw !== 'string') throw new HttpError(400, 'Send the ticket text as "raw".');
      let t;
      try { t = F.parseTicket(body.raw); } catch (e) { throw new HttpError(400, `That ticket text doesn't parse: ${e.message}`); }
      if (t.id !== id) throw new HttpError(400, `The id in the text (${t.id}) must stay ${id}.`);
      const history = await save(file, body.raw, `Edit ${id}: ${t.title}`);
      return { ok: true, version: version(body.raw), history };
    }],

    // Save your answer: a choice (one of the option keys) and/or your own words.
    ['POST', /^\/api\/tickets\/([^/]+)\/([^/]+)\/answer$/, async (req, [slug, id]) => {
      const body = await readJson(req);
      const { file, raw } = await readTicketFile(slug, id);
      checkVersion(raw, body);
      const t = F.parseTicket(raw);
      const p = await loadProject(dataDir, slug, 0);
      const { next, label, edited } = L.answer(t, body, L.lockedBy(t, p.byId), today());
      const text = F.serializeTicket(next);
      const history = await save(file, text, `${edited ? 'Edit answer' : 'Answer'} ${id} (${t.title}): ${label}`);
      return { ok: true, version: version(text), history, ticket: await describeTicket(slug, id) };
    }],

    // Cancel your decision: the ticket goes back to open. If your AI had already seen it, the
    // ticket records an undo for your AI and the project's log says so.
    ['POST', /^\/api\/tickets\/([^/]+)\/([^/]+)\/cancel$/, async (req, [slug, id]) => {
      const body = await readJson(req);
      const { file, raw } = await readTicketFile(slug, id);
      checkVersion(raw, body);
      const { next, label, undo, logLine } = L.cancel(F.parseTicket(raw), today());
      const text = F.serializeTicket(next);
      const more = [];
      if (logLine) {
        const logFile = path.join(dataDir, 'projects', slug, 'log.md');
        const old = await readText(logFile, `# Decision log\n`);
        more.push([logFile, old.replace(/\s*$/, '\n') + logLine + '\n']);
      }
      const history = await save(file, text, `Cancel ${id} (${next.title}): ${label}`, more);
      return { ok: true, version: version(text), undo, history, ticket: await describeTicket(slug, id) };
    }],

    // Close a Check it ticket whose checks are all ticked.
    ['POST', /^\/api\/tickets\/([^/]+)\/([^/]+)\/close$/, async (req, [slug, id]) => {
      const body = await readJson(req);
      const { file, raw } = await readTicketFile(slug, id);
      checkVersion(raw, body);
      const { next } = L.close(F.parseTicket(raw));
      const text = F.serializeTicket(next);
      const history = await save(file, text, `${id} is done (${next.title})`);
      return { ok: true, version: version(text), history, ticket: await describeTicket(slug, id) };
    }],

    // Tick or untick one rubric check (numbered from 0, in file order). Ticking the last check of
    // a "Check it" ticket closes it; unticking one on a done ticket reopens it.
    ['POST', /^\/api\/tickets\/([^/]+)\/([^/]+)\/rubric$/, async (req, [slug, id]) => {
      const body = await readJson(req);
      const { file, raw } = await readTicketFile(slug, id);
      checkVersion(raw, body);
      const { next, check, change } = L.tickRubric(F.parseTicket(raw), body.index, body.done);
      const text = F.serializeTicket(next);
      const tail = change === 'closed' ? `; ${id} is done` : change === 'reopened' ? `; ${id} back to Check it` : '';
      const history = await save(file, text, `${id}: ${body.done ? 'ticked' : 'unticked'} "${check.text}"${tail}`);
      return { ok: true, version: version(text), change, history, ticket: await describeTicket(slug, id) };
    }],
  ];

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad path.'); }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(APP, rel));
    if (!file.startsWith(APP + path.sep)) return send(res, 404, 'Not found.');
    let st;
    try { st = await fsp.stat(file); } catch { return send(res, 404, 'Not found.'); }
    if (!st.isFile()) return send(res, 404, 'Not found.');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\nevent: hello\ndata: {}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  }

  async function handle(req, res) {
    // Phase 1 answers only on this computer. Refusing other Host names also blocks
    // "DNS rebinding" pages from reaching the server through your browser.
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) return send(res, 403, 'This HQ only answers on localhost.');
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin.toLowerCase() !== `http://${host}`) return send(res, 403, { error: 'Requests from other sites are refused.' });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') return events(req, res);
    if (url.pathname.startsWith('/api/')) {
      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (!m) continue;
        if (req.method !== method) continue;
        try {
          return send(res, 200, await fn(req, m.slice(1).map(decodeURIComponent)));
        } catch (e) {
          if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
          if (e instanceof L.Refused) return send(res, e.status, { error: e.message });
          console.error(e);
          return send(res, 500, { error: 'Something went wrong on the server. See the terminal.' });
        }
      }
      return send(res, 404, { error: 'No such API route.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.');
    return serveStatic(req, res, url.pathname);
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Server error.'); }); });

  let stopWatch = null;
  async function start() {
    const setup = await ensureData(dataDir);
    const history = await git.init();
    if (history.ok) await git.commit(setup.firstRun ? 'HQ: created your data folder from defaults' : 'HQ: saved changes found at start');

    let port = opts.port;
    for (let tries = 0; ; tries++) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        break;
      } catch (e) {
        if (e.code === 'EADDRINUSE' && !opts.portFixed && tries < 10) { port++; continue; }
        throw e;
      }
    }
    port = server.address().port;
    allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    stopWatch = watchData(dataDir, (paths) => broadcast('change', { paths }));
    const heartbeat = setInterval(() => { for (const c of clients) c.write(': still here\n\n'); }, 25000);
    heartbeat.unref();
    return { url: `http://127.0.0.1:${port}/`, port, setup, history };
  }

  async function stop() {
    if (stopWatch) stopWatch();
    for (const c of clients) c.end();
    clients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { start, stop, server, git, dataDir };
}

/* ---------- command line ---------- */

const HELP = `HQ Template

  node server/hq.js                  start (your data lives in ./data, created on first run)
  node server/hq.js --data <folder>  keep your data in another folder (or set HQ_DATA)
  node server/hq.js --port <n>       use another port (default ${DEFAULT_PORT}, or set HQ_PORT)
  node server/hq.js --no-git         don't keep local history in the data folder
`;

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { console.error(`HQ Template needs Node 18 or newer. You have ${process.versions.node}. Get it from https://nodejs.org`); process.exit(1); }
  let opts;
  try { opts = parseArgs(process.argv.slice(2), process.env); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) { process.stdout.write(HELP); return; }

  const app = createApp(opts);
  let info;
  try { info = await app.start(); } catch (e) {
    if (e.code === 'EADDRINUSE') console.error(`Port ${opts.port} is already in use. Try: node server/hq.js --port ${opts.port + 1}`);
    else console.error(e);
    process.exit(1);
  }
  const lines = ['', 'HQ Template is running.', ''];
  if (info.setup.steps.length) lines.push(info.setup.firstRun ? 'First run, so I set up your data folder:' : 'Added what was missing:', ...info.setup.steps.map((s) => `  - ${s}`), '');
  lines.push(`  Open this link:  ${info.url}`);
  lines.push(`  Your data:       ${app.dataDir}`);
  lines.push(`  History:         ${info.history.ok ? 'a local git commit after every saved change (never pushed)' : info.history.why}`);
  lines.push('', 'Press Ctrl+C to stop.', '');
  console.log(lines.join('\n'));

  const shutdown = () => { app.stop().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp, parseArgs, ensureData, loadState, makeGit, version, EXAMPLE_SLUG };
