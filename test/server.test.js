'use strict';
// Phase 1 checks: server read/write, data/ creation, a local git commit after every saved answer.
// Every test uses a fresh temporary data folder; nothing here touches a real data/ folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const { createApp, EXAMPLE_SLUG } = require('../server/hq.js');

const ROOT = path.join(__dirname, '..');
const tmpData = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hq-test-')), 'data');
const git = (dir, ...args) => execFileSync('git', ['--git-dir', path.join(dir, '.git'), '--work-tree', dir, ...args], { encoding: 'utf8' }).trim();

function request(port, method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(data != null ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, text, json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

async function withServer(fn, dataDir) {
  const data = dataDir || tmpData();
  const app = createApp({ data, port: 0, portFixed: true, git: true });
  const info = await app.start();
  try { await fn({ ...info, data, app }); } finally { await app.stop(); }
}

const ticketOf = (state, id) => state.projects[0].tickets.find((t) => t.id === id);

test('first run creates data/ from defaults, with its own local git and one commit', async () => {
  await withServer(async ({ data, setup }) => {
    assert.equal(setup.firstRun, true);
    for (const f of ['design.json', 'RULES.md', 'projects.md', '.hq-defaults.json', `projects/${EXAMPLE_SLUG}/project.md`, `projects/${EXAMPLE_SLUG}/log.md`, `projects/${EXAMPLE_SLUG}/tickets/T-001.md`]) {
      assert.ok(fs.existsSync(path.join(data, f)), f);
    }
    assert.ok(fs.statSync(path.join(data, 'projects', EXAMPLE_SLUG, 'batches')).isDirectory());
    assert.equal(fs.readFileSync(path.join(data, 'design.json'), 'utf8'), fs.readFileSync(path.join(ROOT, 'defaults', 'design.json'), 'utf8'));
    assert.ok(fs.existsSync(path.join(data, '.git')));
    assert.equal(git(data, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(data, 'log', '-1', '--format=%s'), 'HQ: created your data folder from defaults');
    assert.equal(git(data, 'remote'), '', 'the data repo has no remote');
    assert.equal(git(data, 'status', '--porcelain'), '');
  });
});

test('a second start never overwrites what you changed', async () => {
  const data = tmpData();
  await withServer(async () => {}, data);
  fs.writeFileSync(path.join(data, 'design.json'), '{"mine":true}\n');
  fs.rmSync(path.join(data, 'projects', EXAMPLE_SLUG), { recursive: true });
  await withServer(async ({ setup }) => {
    assert.equal(setup.firstRun, false);
    assert.equal(fs.readFileSync(path.join(data, 'design.json'), 'utf8'), '{"mine":true}\n');
    assert.ok(!fs.existsSync(path.join(data, 'projects', EXAMPLE_SLUG)), 'a deleted example project stays deleted');
    assert.equal(git(data, 'log', '-1', '--format=%s'), 'HQ: saved changes found at start');
  }, data);
});

test('GET /api/state reads every project and ticket, in rank order, with locks', async () => {
  await withServer(async ({ port }) => {
    const r = await request(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    const s = r.json;
    assert.deepEqual(s.warnings, []);
    assert.equal(s.projects.length, 1);
    const p = s.projects[0];
    assert.equal(p.slug, EXAMPLE_SLUG);
    assert.equal(p.rank, 1);
    assert.equal(p.name, 'Plan a weekend trip');
    assert.deepEqual(p.tickets.map((t) => `${t.id}:${t.status}${t.locked ? ':locked' : ''}`), ['T-001:done', 'T-002:answered', 'T-003:open', 'T-004:working', 'T-005:open', 'T-006:open:locked']);
    assert.ok(p.tickets.every((t) => t.warnings.length === 0 && /^[0-9a-f]{12}$/.test(t.version)));
    assert.equal(s.design.color.light.ink, '#1C1B19');
  });
});

test('saving an answer writes the file and makes a local git commit', async () => {
  await withServer(async ({ port, data }) => {
    const before = Number(git(data, 'rev-list', '--count', 'HEAD'));
    const { json: got } = await request(port, 'GET', `/api/tickets/${EXAMPLE_SLUG}/T-003`);
    const r = await request(port, 'POST', `/api/tickets/${EXAMPLE_SLUG}/T-003/answer`, { choice: 'flat', answer: 'The flat, for the sea view.', version: got.version });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.history.committed, true);
    const file = fs.readFileSync(path.join(data, 'projects', EXAMPLE_SLUG, 'tickets', 'T-003.md'), 'utf8');
    assert.match(file, /^status: answered$/m);
    assert.match(file, /^choice: flat$/m);
    assert.match(file, /## Answer\nThe flat, for the sea view\.\n$/);
    assert.equal(Number(git(data, 'rev-list', '--count', 'HEAD')), before + 1);
    assert.equal(git(data, 'log', '-1', '--format=%s'), 'Answer T-003 (Where do we stay?): Holiday flat');
    assert.equal(git(data, 'status', '--porcelain'), '');
    // T-006 needed T-003 (now answered) and T-004 (still working), so it stays locked.
    const s = (await request(port, 'GET', '/api/state')).json;
    assert.equal(ticketOf(s, 'T-003').status, 'answered');
    assert.equal(ticketOf(s, 'T-006').locked, true);
  });
});

test('rubric ticks and whole-file edits save and commit too', async () => {
  await withServer(async ({ port, data }) => {
    let { json: got } = await request(port, 'GET', `/api/tickets/${EXAMPLE_SLUG}/T-004`);
    const r1 = await request(port, 'POST', `/api/tickets/${EXAMPLE_SLUG}/T-004/rubric`, { index: 2, done: true, version: got.version });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.ticket.rubric[2].done, true);
    assert.equal(git(data, 'log', '-1', '--format=%s'), 'T-004: ticked "Booked and paid"');
    ({ json: got } = await request(port, 'GET', `/api/tickets/${EXAMPLE_SLUG}/T-004`));
    const raw = got.raw.replace('title: Book the train tickets', 'title: Book the train tickets (all four)');
    const r2 = await request(port, 'PUT', `/api/tickets/${EXAMPLE_SLUG}/T-004`, { raw, version: got.version });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(fs.readFileSync(path.join(data, 'projects', EXAMPLE_SLUG, 'tickets', 'T-004.md'), 'utf8'), raw);
    assert.equal(git(data, 'log', '-1', '--format=%s'), 'Edit T-004: Book the train tickets (all four)');
  });
});

test('writes refuse stale versions, locked or closed tickets, bad choices and bad text', async () => {
  await withServer(async ({ port }) => {
    const v = async (id) => (await request(port, 'GET', `/api/tickets/${EXAMPLE_SLUG}/${id}`)).json.version;
    const post = (id, body) => request(port, 'POST', `/api/tickets/${EXAMPLE_SLUG}/${id}/answer`, body);
    assert.equal((await post('T-003', { choice: 'flat', version: 'stale0000000' })).status, 409);
    assert.equal((await post('T-003', { choice: 'flat' })).status, 400, 'version is required');
    assert.equal((await post('T-003', { choice: 'castle', version: await v('T-003') })).status, 400);
    assert.equal((await post('T-003', { version: await v('T-003') })).status, 400, 'needs a choice or words');
    const locked = await post('T-006', { answer: 'ok', version: await v('T-006') });
    assert.equal(locked.status, 409);
    assert.match(locked.json.error, /locked until T-003, T-004/);
    assert.equal((await post('T-001', { choice: 'city', version: await v('T-001') })).status, 409, 'done tickets are not re-answered');
    const put = (raw, version) => request(port, 'PUT', `/api/tickets/${EXAMPLE_SLUG}/T-003`, { raw, version });
    assert.equal((await put('not a ticket', await v('T-003'))).status, 400);
    assert.equal((await put('---\nid: T-999\n---\n', await v('T-003'))).status, 400, 'the id must not change');
    assert.equal((await request(port, 'GET', `/api/tickets/${EXAMPLE_SLUG}/T-404`)).status, 404);
    assert.equal((await request(port, 'GET', '/api/tickets/..%2F..%2Fetc/T-001')).status, 404);
    assert.equal((await request(port, 'POST', `/api/tickets/${EXAMPLE_SLUG}/T-003/answer`, 'choice=flat', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  });
});

test('only answers on localhost, and refuses writes from other sites', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await request(port, 'GET', '/api/state', undefined, { Host: 'evil.example:80' })).status, 403);
    const got = (await request(port, 'GET', `/api/tickets/${EXAMPLE_SLUG}/T-003`)).json;
    const r = await request(port, 'POST', `/api/tickets/${EXAMPLE_SLUG}/T-003/answer`, { choice: 'flat', version: got.version }, { Origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });
});

test('serves the dashboard and nothing outside app/', async () => {
  await withServer(async ({ port }) => {
    const home = await request(port, 'GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.match(home.text, /<title>HQ<\/title>/);
    assert.equal((await request(port, 'GET', '/format.js')).status, 200);
    assert.equal((await request(port, 'GET', '/../server/hq.js')).status, 404);
    assert.equal((await request(port, 'GET', '/%2e%2e/server/hq.js')).status, 404);
  });
});

test('an edit made in a text editor (or by an AI) reaches open pages as a live event', async () => {
  await withServer(async ({ port, data }) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' });
    const res = await new Promise((resolve) => req.on('response', resolve));
    res.setEncoding('utf8');
    let buf = '';
    const got = new Promise((resolve) => res.on('data', (c) => { buf += c; for (const m of buf.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)) events.push([m[1], JSON.parse(m[2])]); if (events.some(([e]) => e === 'change')) resolve(); }));
    await new Promise((r) => setTimeout(r, 200));
    const file = path.join(data, 'projects', EXAMPLE_SLUG, 'tickets', 'T-005.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: open', 'status: working'));
    await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no change event within 3 s')), 3000))]);
    req.destroy();
    const change = events.find(([e]) => e === 'change')[1];
    assert.ok(change.paths.includes(`projects/${EXAMPLE_SLUG}/tickets/T-005.md`), JSON.stringify(change));
    assert.equal(ticketOf((await request(port, 'GET', '/api/state')).json, 'T-005').status, 'working');
  });
});

test('`node server/hq.js` prints the link, and the link works', async () => {
  const data = tmpData();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'hq.js'), '--data', data, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    const url = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no link printed. Output so far:\n${out}`)), 5000);
      child.stdout.on('data', (c) => { out += c; const m = /Open this link:\s+(http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(out); if (m) { clearTimeout(t); resolve(m); } });
      child.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
    });
    assert.match(out, /First run, so I set up your data folder/);
    const r = await request(Number(url[2]), 'GET', '/');
    assert.equal(r.status, 200);
  } finally {
    child.kill('SIGINT');
  }
});
