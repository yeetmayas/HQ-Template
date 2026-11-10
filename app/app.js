/* HQ Template, phase 1: show what the server reads from your data folder, and keep it live.
 * The real dashboard (Inbox, answering, decision box) replaces this in phase 2. */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS_WORD = { open: 'Open', working: 'Being worked on', answered: 'Answered', verify: 'Check it', done: 'Done' };
  const HEX = /^#[0-9a-f]{3,8}$/i;

  // design.json → CSS variables. Only hex colours and numbers get through.
  function applyDesign(d) {
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
    el.textContent = css;
  }

  function ticketRow(t) {
    const word = t.locked ? `Locked · needs ${t.needs.join(', ')}` : STATUS_WORD[t.status] || t.status;
    const cls = t.locked ? 'locked' : t.status;
    const done = t.rubric.filter((r) => r.done).length;
    const bits = [t.phase, t.kind === 'task' ? 'task' : 'decision', t.rubric.length ? `rubric ${done}/${t.rubric.length}` : '', t.visuals.length ? `visual: ${t.visuals.map((v) => v.type).join(', ')}` : '', t.choice ? `picked: ${HQFormat.optionLabel(t, t.choice)}` : ''].filter(Boolean);
    const warn = t.warnings && t.warnings.length ? `<small class="warn">⚠ ${esc(t.warnings.join('; '))}</small>` : '';
    return `<li><span class="tid">${esc(t.id)}</span><span class="ttitle">${esc(t.title)}<small>${esc(bits.join(' · '))}</small>${warn}</span><span class="st ${esc(cls)}">${esc(word)}</span></li>`;
  }

  function render(state) {
    applyDesign(state.design);
    $('data').textContent = `Your data folder: ${state.dataDir}`;
    if (!state.projects.length) { $('main').innerHTML = '<p>No projects yet. Ask your AI to "set me up" (see SETUP.md).</p>'; return; }
    const warn = state.warnings.length ? `<p class="warn">⚠ ${state.warnings.map(esc).join('<br>⚠ ')}</p>` : '';
    $('main').innerHTML = warn + state.projects.map((p) => `
      <section class="project" aria-labelledby="p-${esc(p.slug)}">
        <p class="rank">Rank ${p.rank} · ${esc(p.status)}</p>
        <h2 id="p-${esc(p.slug)}">${esc(p.name || p.slug)}</h2>
        <p class="muted">${esc(p.goal)}</p>
        <ul class="phases" aria-label="Phases">${p.phases.map((ph) => `<li>${esc(ph.key)} · ${esc(ph.name || '')}</li>`).join('')}</ul>
        <h3>${p.tickets.length} ticket${p.tickets.length === 1 ? '' : 's'}</h3>
        <ul class="tickets">${p.tickets.map(ticketRow).join('')}</ul>
      </section>`).join('');
  }

  async function load() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (!r.ok) throw new Error(`the server said ${r.status}`);
      render(await r.json());
    } catch (e) {
      $('main').innerHTML = `<p class="warn">Couldn't read your data: ${esc(e.message)}. Is <code>node server/hq.js</code> still running?</p>`;
    }
  }

  function live() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    let t = null;
    es.addEventListener('hello', () => { $('live').textContent = 'Live: changes to your files show up here'; $('live').classList.add('on'); });
    es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(load, 80); });
    es.onerror = () => { $('live').textContent = 'Not connected to the server'; $('live').classList.remove('on'); };
  }

  load();
  live();
})();
