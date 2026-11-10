/* HQ Template: the dashboard's plumbing. State from the server, live updates, routing, design.
 * The screens themselves are in inbox.js. */
'use strict';
window.HQ = (function () {
  const $ = (id) => document.getElementById(id);
  const HQ = { state: null, route: { name: 'inbox' }, connected: false };

  /* ---------- text ---------- */

  HQ.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // A little Markdown: paragraphs, "- " lists, **bold**, *italic*, `code`, and links to
  // http(s) addresses. Everything else stays plain text.
  function inline(s) {
    return HQ.esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  HQ.md = (text) => {
    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; } };
    for (const line of String(text || '').split('\n')) {
      const li = /^\s*[-*] (.*)$/.exec(line);
      if (li) { flushPara(); (list = list || []).push(li[1]); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join('');
  };

  /* ---------- design.json → CSS variables (only hex colours and numbers get through) ---------- */

  const HEX = /^#[0-9a-f]{3,8}$/i;
  HQ.applyDesign = (d) => {
    if (!d || typeof d !== 'object') return;
    const vars = (c) => Object.entries(c || {}).filter(([k, v]) => /^[a-z-]+$/i.test(k) && HEX.test(v)).map(([k, v]) => `--${k}:${v};`).join('');
    const scale = Array.isArray(d.type && d.type.scale) ? d.type.scale.filter((n) => typeof n === 'number' && n > 0 && n < 200) : [];
    const safeFont = (f) => (typeof f === 'string' && !/[{};<>]/.test(f) ? f : null);
    let root = vars(d.color && d.color.light) + scale.map((n, i) => `--s${i + 1}:${n}px;`).join('');
    if (safeFont(d.type && d.type.family)) root += `--font:${d.type.family};`;
    if (safeFont(d.type && d.type.mono)) root += `--mono:${d.type.mono};`;
    if (typeof d.radius === 'number') root += `--r:${d.radius}px;`;
    if (d.space && typeof d.space.grid === 'number') root += `--g:${d.space.grid}px;`;
    if (typeof d.target === 'number') root += `--target:${d.target}px;`;
    const css = `:root{${root}}@media (prefers-color-scheme: dark){:root{${vars(d.color && d.color.dark)}}}`;
    let el = $('hq-design');
    if (!el) { el = document.createElement('style'); el.id = 'hq-design'; document.head.appendChild(el); }
    if (el.textContent !== css) el.textContent = css;
  };

  /* ---------- talking to the server ---------- */

  HQ.api = async (method, url, body) => {
    const r = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) {
      const e = new Error((json && json.error) || `The server said ${r.status}.`);
      e.status = r.status;
      throw e;
    }
    return json;
  };

  HQ.load = async () => {
    try {
      HQ.state = await HQ.api('GET', '/api/state');
      HQ.applyDesign(HQ.state.design);
      HQ.render();
    } catch (e) {
      HQ.state = null;
      $('main').innerHTML = `<p class="warn">Couldn't read your data: ${HQ.esc(e.message)} Is <code>node server/hq.js</code> still running?</p>`;
    }
  };

  // Run a write. On "changed on disk" (your AI edited the file meanwhile) reload and say so.
  HQ.act = async (method, url, body, done) => {
    try {
      const r = await HQ.api(method, url, body);
      if (done) HQ.toast(done);
      await HQ.load();
      return r;
    } catch (e) {
      HQ.toast(e.status === 409 && /changed on disk/.test(e.message) ? 'This ticket just changed on disk (your AI may have edited it). I reloaded it: check, then try again.' : e.message, 'bad');
      await HQ.load();
      return null;
    }
  };

  /* ---------- toast ---------- */

  let toastTimer = null;
  HQ.toast = (msg, kind) => {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show${kind === 'bad' ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'bad' ? 7000 : 3500);
  };

  /* ---------- routes: #/  #/t/<project>/<ticket>  #/p/<project> ---------- */

  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    let m;
    if ((m = /^t\/([\w-]+)\/(T-\d+)$/.exec(h))) return { name: 'ticket', slug: m[1], id: m[2] };
    if ((m = /^p\/([\w-]+)$/.exec(h))) return { name: 'project', slug: m[1] };
    return { name: 'inbox' };
  }
  window.addEventListener('hashchange', () => { HQ.route = parseRoute(); HQ.render({ nav: true }); });

  /* ---------- live: the server tells us when any file in your data folder changes ---------- */

  function setLive(on) {
    HQ.connected = on;
    const el = $('live');
    el.textContent = on ? 'Live' : 'Not connected';
    el.title = on ? 'Changes to your files show up here as they happen' : 'The server is not reachable. Is node server/hq.js running?';
    el.classList.toggle('on', on);
  }

  function live() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    let t = null;
    es.addEventListener('hello', () => { if (!HQ.connected) { setLive(true); HQ.load(); } });
    es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(HQ.load, 60); });
    es.onerror = () => setLive(false);
  }

  HQ.boot = () => {
    HQ.route = parseRoute();
    HQ.load();
    live();
  };

  return HQ;
})();
