/* HQ Template: the screens. Inbox across projects, a ticket, a project's phases and log.
 *
 * Every action goes through the server, which applies the same rules (logic.js) and writes the
 * ticket file. The page then reloads from the files, so what you see is always what's on disk. */
'use strict';
(function (HQ, F, L) {
  const $ = (id) => document.getElementById(id);
  const esc = HQ.esc;

  const ui = {
    tab: 'inbox',
    drafts: {},     // "slug/id" → { choice, answer }: what you've typed but not saved
    ask: null,      // { key, mode: 'cancel' | 'change' }: the confirm step on screen
    editing: null,  // "slug/id" while you edit an answer you already saved
    busy: false,
  };
  try { ui.tab = sessionStorage.getItem('hq.tab') || 'inbox'; } catch { /* private mode */ }

  const TABS = [
    ['inbox', 'Inbox', (b) => b === 'needs' || b === 'check' || b === 'locked'],
    ['answered', 'Answered', (b) => b === 'answered'],
    ['working', 'AI working', (b) => b === 'working'],
    ['done', 'Done', (b) => b === 'done'],
  ];
  const PILL = { needs: 'Open', check: 'Check it', answered: 'Answered', working: 'AI working', done: 'Done', locked: 'Locked' };
  const keyOf = (slug, id) => `${slug}/${id}`;
  const tUrl = (slug, id) => `#/t/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`;

  /* ---------- finding things ---------- */

  function rows() { return HQ.state ? L.inboxOrder(HQ.state.projects) : []; }
  function find(slug, id) {
    const p = HQ.state && HQ.state.projects.find((x) => x.slug === slug);
    const t = p && p.tickets.find((x) => x.id === id);
    if (!t) return null;
    const byId = Object.fromEntries(p.tickets.map((x) => [x.id, x]));
    return { p, t, byId, locked: L.lockedBy(t, byId), bucket: L.bucket(t, byId) };
  }
  const phaseName = (p, key) => { const ph = (p.phases || []).find((x) => x.key === key); return ph ? `${ph.key} · ${ph.name || ''}` : key || 'No phase'; };

  /* ---------- the list ---------- */

  function pillFor(r) {
    const c = L.lastCancel(r.ticket);
    if (r.bucket === 'needs' && c && c.undo === 'pending') return ['cancelled', 'Cancelled'];
    return [r.bucket, PILL[r.bucket]];
  }

  function rowHTML(r, current) {
    const t = r.ticket;
    const [cls, word] = pillFor(r);
    const meta = r.bucket === 'locked' ? `Waits for ${r.lockedBy.join(', ')}` : [t.id, t.kind === 'task' ? 'task' : '', ...t.tags.filter((g) => /^effort:/i.test(g))].filter(Boolean).join(' · ');
    const here = current && current.slug === r.project.slug && current.id === t.id;
    return `<li><a class="row${here ? ' here' : ''}" href="${tUrl(r.project.slug, t.id)}"${here ? ' aria-current="page"' : ''}>
      <span class="row-t">${esc(t.title)}<small>${r.bucket === 'locked' ? esc(t.id) + ' · ' : ''}${esc(meta)}</small></span>
      <span class="pill ${esc(cls)}">${esc(word)}</span></a></li>`;
  }

  function listHTML(current) {
    const all = rows();
    const counts = Object.fromEntries(TABS.map(([k, , test]) => [k, all.filter((r) => test(r.bucket) && r.bucket !== 'locked').length]));
    const tabs = `<div class="tabs" role="tablist" aria-label="Show">${TABS.map(([k, label]) =>
      `<button role="tab" class="tab" id="tab-${k}" aria-selected="${ui.tab === k}" data-tab="${k}">${label}<span class="n">${counts[k]}</span></button>`).join('')}</div>`;
    const test = (TABS.find(([k]) => k === ui.tab) || TABS[0])[2];
    const shown = all.filter((r) => test(r.bucket));
    let body = '';
    if (ui.tab === 'inbox') {
      const live = shown.filter((r) => r.bucket !== 'locked');
      const locked = shown.filter((r) => r.bucket === 'locked');
      body = live.length ? grouped(live, current) : '<p class="empty">Nothing needs you right now.</p>';
      if (locked.length) body += `<h3 class="locked-h">Locked · waiting on other tickets <span class="n">${locked.length}</span></h3><ul class="rows">${locked.map((r) => rowHTML(r, current)).join('')}</ul>`;
    } else {
      body = shown.length ? grouped(shown, current) : `<p class="empty">${{ answered: 'No answers waiting for your AI.', working: 'Your AI isn’t working on anything.', done: 'Nothing done yet.' }[ui.tab]}</p>`;
    }
    return `${tabs}<div class="list" role="tabpanel" aria-labelledby="tab-${ui.tab}">${body}</div>`;
  }

  // Grouped by project (your ranking), then phase.
  function grouped(list, current) {
    let html = '', proj = null, phase = null;
    for (const r of list) {
      if (r.project !== proj) {
        if (proj) html += '</ul>';
        proj = r.project; phase = null;
        html += `<h3 class="proj-h"><a href="#/p/${encodeURIComponent(proj.slug)}"><span class="rank">${proj.rank}</span>${esc(proj.name || proj.slug)}</a></h3>`;
      }
      if (r.ticket.phase !== phase) {
        if (phase !== null) html += '</ul>';
        phase = r.ticket.phase;
        html += `<p class="phase-h">${esc(phaseName(proj, phase))}</p><ul class="rows">`;
      }
      html += rowHTML(r, current);
    }
    return html + (proj ? '</ul>' : '');
  }

  /* ---------- a ticket ---------- */

  function bannerHTML(x) {
    const { t, locked, byId } = x;
    if (t.status === 'open' && locked.length) {
      const why = locked.map((id) => byId[id] ? `<a href="${tUrl(x.p.slug, id)}">${esc(id)}</a> (${esc(PILL[L.bucket(byId[id], byId)] || byId[id].status)})` : `${esc(id)} (missing)`).join(', ');
      return `<div class="banner locked"><b>Locked.</b> This waits for ${why}. Answer ${locked.length > 1 ? 'those' : 'that'} first.</div>`;
    }
    const c = L.lastCancel(t);
    if (t.status === 'open' && c) {
      const how = c.undo === 'pending' ? 'Your AI undoes what it changed the next time it reads your tickets.' : c.undo === 'done' ? 'Your AI has undone it.' : 'Your AI never saw it.';
      return `<div class="banner cancelled"><b>You cancelled “${esc(c.label)}”</b>${c.at ? ` on ${esc(c.at)}` : ''}. ${how} Pick again, or leave it open.</div>`;
    }
    if (t.status === 'working' && !L.hasCall(t)) return '<div class="banner"><b>Your AI is working on this.</b> Tick your checks as you do your part.</div>';
    if (t.status === 'verify' && L.allTicked(t)) return '<div class="banner check"><p><b>Check it.</b> Your AI has done its part and every check is ticked. Close it if you’re happy.</p><div class="btns"><button class="btn primary" id="tk-close">Close it</button></div></div>';
    if (t.status === 'verify') return '<div class="banner check"><b>Check it.</b> Your AI has done its part. Tick your checks below to close it.</div>';
    if (t.status === 'done') return '<div class="banner done"><b>Done.</b> Every check is ticked.</div>';
    return '';
  }

  function decisionBoxHTML(x) {
    const { t, p } = x;
    if (!L.canCancel(t)) return '';
    const k = keyOf(p.slug, t.id);
    const label = L.callLabel(t);
    if (ui.ask && ui.ask.key === k) {
      const yes = ui.ask.mode === 'change' ? 'Yes, change it' : 'Yes, cancel it';
      let body;
      if (ui.ask.mode === 'change') {
        const cost = L.reversalCost(t, p.log);
        const lost = [
          ...cost.aiChecks.map((c) => `Your AI’s check: ${c}`),
          ...cost.yourChecks.map((c) => `Your check: ${c}`),
          ...(cost.evidence ? [`The evidence: ${cost.evidence.replace(/^\s*[-*]\s+/gm, '').replace(/\s*\n\s*/g, ' ').slice(0, 160)}`] : []),
          ...cost.log.map((l) => `The log entry: ${l}`),
        ];
        body = `<p id="ask-q"><b>Change “${esc(label)}”?</b> This takes your decision back so you can pick again. Your AI undoes what it changed.</p>` +
          (lost.length ? `<p>It throws away:</p><ul class="lost">${lost.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
      } else {
        body = `<p id="ask-q"><b>Cancel “${esc(label)}”?</b> ${L.reached(t) ? 'Your AI has it already, so it will undo what it changed.' : 'Your AI hasn’t seen it yet.'} The ticket goes back to your Inbox.</p>`;
      }
      return `<div class="decbox ask" role="group" aria-labelledby="ask-q">${body}<div class="btns"><button class="btn danger" id="ask-yes">${yes}</button><button class="btn" id="ask-no">Keep it</button></div></div>`;
    }
    const state = t.status === 'answered' ? (L.sentIn(t) ? `Copied for your AI in ${esc(L.sentIn(t))}` : 'Saved. Your AI picks it up next') :
      t.status === 'working' ? 'Your AI is working on it' : t.status === 'verify' ? 'Recorded by your AI' : 'Recorded and closed';
    const note = t.choice ? F.getSection(t, 'Answer').trim() : '';
    const second = t.status === 'answered' ? '<button class="btn" id="dec-edit">Edit my answer</button>' : '<button class="btn" id="dec-change">Change my decision</button>';
    return `<div class="decbox"><div class="decbox-t"><p class="eyebrow">Your decision · ${state}</p><b>${esc(label)}</b>${note ? `<small>${esc(note.length > 160 ? note.slice(0, 159) + '…' : note)}</small>` : ''}</div>
      <div class="btns"><button class="btn danger" id="dec-cancel">Cancel my decision</button>${second}</div></div>`;
  }

  function answerFormHTML(x) {
    const { t, p, locked } = x;
    const k = keyOf(p.slug, t.id);
    const editing = ui.editing === k && t.status === 'answered';
    if (!(t.status === 'open' && !locked.length) && !editing) return '';
    const d = ui.drafts[k] || (editing ? { choice: t.choice, answer: F.getSection(t, 'Answer') } : { choice: '', answer: '' });
    ui.drafts[k] = d;
    const opts = t.options.length ? `<fieldset class="opts"><legend>${t.kind === 'task' ? 'Your answer' : 'Pick one'}</legend>${t.options.map((o) =>
      `<label class="opt"><input type="radio" name="choice" value="${esc(o.key)}"${d.choice === o.key ? ' checked' : ''}><span><b>${esc(o.label || o.key)}</b>${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span></label>`).join('')}</fieldset>` : '';
    const wordsLabel = t.options.length ? 'In your own words (optional)' : t.kind === 'task' ? 'Your answer, or the go-ahead' : 'Your answer';
    return `<form class="answer" id="ans-form" novalidate>
      <h3>${editing ? 'Edit your answer' : 'Your answer'}</h3>
      ${opts}
      <label class="lbl" for="ans-words">${wordsLabel}</label>
      <textarea id="ans-words" rows="3">${esc(d.answer)}</textarea>
      <div class="btns"><button class="btn primary" type="submit">Save my answer</button>${editing ? '<button class="btn" type="button" id="ans-keep">Keep my earlier answer</button>' : ''}</div>
    </form>`;
  }

  function rubricHTML(t) {
    const r = F.rubric(t);
    if (!r.length) return '';
    const done = r.filter((c) => c.done).length;
    return `<section class="sec"><h3>Rubric <span class="n">${done} of ${r.length}</span></h3><ul class="rubric">${r.map((c, i) => c.who === 'AI'
      ? `<li class="ai${c.done ? ' done' : ''}"><span class="mark" aria-hidden="true">${c.done ? '✓' : '○'}</span><span class="txt">${esc(c.text)}<span class="sr">${c.done ? ' (done)' : ' (not yet)'}</span></span><span class="who">AI</span></li>`
      : `<li class="you${c.done ? ' done' : ''}"><label><input type="checkbox" data-check="${i}"${c.done ? ' checked' : ''}><span class="txt">${esc(c.text)}</span></label><span class="who">${c.who ? 'you' : ''}</span></li>`).join('')}</ul></section>`;
  }

  // The dashboard draws these as charts in phase 3; until then, the data itself.
  function visualHTML(t) {
    const v = F.visuals(t);
    const rest = F.getSection(t, 'Visual').replace(/(`{3,}|~{3,})[\s\S]*?\1/g, '').trim();
    if (!v.length && !rest) return '';
    return `<section class="sec"><h3>Visual</h3>${v.map((b) => `<figure class="vis"><figcaption>${esc(b.fields.title || b.type)}<span class="pill">${esc(b.type)}</span></figcaption><dl>${Object.entries(b.fields).filter(([k]) => k !== 'type' && k !== 'title').map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl></figure>`).join('')}${rest ? HQ.md(rest) : ''}</section>`;
  }

  function ticketHTML(x) {
    const { t, p } = x;
    const known = ['question', 'context', 'rubric', 'visual', 'evidence', 'answer'];
    const sec = (title) => { const b = F.getSection(t, title).trim(); return b ? `<section class="sec"><h3>${esc(title)}</h3><div class="md">${HQ.md(b)}</div></section>` : ''; };
    const others = t.sections.filter((s) => !known.includes(s.title.toLowerCase()) && s.body.trim()).map((s) => `<section class="sec"><h3>${esc(s.title)}</h3><div class="md">${HQ.md(s.body)}</div></section>`).join('');
    const warn = (t.warnings || []).length ? `<div class="banner bad"><b>This file has a problem:</b> ${t.warnings.map(esc).join('; ')}.</div>` : '';
    const showAnswer = !L.canCancel(t) && t.status !== 'open' ? sec('Answer') : '';
    return `<article class="ticket" aria-labelledby="tk-title">
      <a class="back" href="#/">← Inbox</a>
      <p class="eyebrow">${esc(t.id)} · <a href="#/p/${encodeURIComponent(p.slug)}">${esc(p.name || p.slug)}</a> · ${esc(phaseName(p, t.phase))} · ${t.kind === 'task' ? 'task' : 'decision'}</p>
      <h2 id="tk-title" tabindex="-1">${esc(t.title)}</h2>
      ${t.tags.length ? `<p class="tags">${t.tags.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</p>` : ''}
      ${warn}${bannerHTML(x)}${decisionBoxHTML(x)}
      ${t.kind === 'task' ? sec('Question').replace('<h3>Question</h3>', '<h3>The task</h3>') : sec('Question')}
      ${sec('Context')}
      ${answerFormHTML(x)}
      ${visualHTML(t)}
      ${rubricHTML(t)}
      ${sec('Evidence')}${showAnswer}${others}
      <p class="file">File: <code>${esc(t.file)}</code></p>
    </article>`;
  }

  /* ---------- a project: phases and decision log ---------- */

  function projectHTML(p) {
    const byId = Object.fromEntries(p.tickets.map((x) => [x.id, x]));
    const phases = (p.phases || []).map((ph) => {
      const ts = p.tickets.filter((t) => t.phase === ph.key);
      const done = ts.filter((t) => t.status === 'done').length;
      return `<li><b>${esc(ph.key)} · ${esc(ph.name || '')}</b><span class="n">${done} of ${ts.length} done</span><ul class="rows">${ts.map((t) => rowHTML({ project: p, ticket: t, bucket: L.bucket(t, byId), lockedBy: L.lockedBy(t, byId) }, null)).join('')}</ul></li>`;
    }).join('');
    const log = p.log.length ? `<ol class="log">${p.log.slice().reverse().map((e) => `<li><span class="when">${esc(e.date)} · <a href="${tUrl(p.slug, e.ticket)}">${esc(e.ticket)}</a></span>${esc(e.text)}</li>`).join('')}</ol>` : '<p class="empty">No decisions recorded yet.</p>';
    return `<article class="ticket" aria-labelledby="tk-title">
      <a class="back" href="#/">← Inbox</a>
      <p class="eyebrow">Project ${p.rank} of ${HQ.state.projects.length} · ${esc(p.status)}</p>
      <h2 id="tk-title" tabindex="-1">${esc(p.name || p.slug)}</h2>
      <p class="goal">${esc(p.goal)}</p>
      ${p.intro ? `<div class="md">${HQ.md(p.intro)}</div>` : ''}
      <section class="sec"><h3>Phases</h3><ol class="phases">${phases}</ol></section>
      <section class="sec"><h3>Decision log <span class="n">newest first</span></h3>${log}</section>
      <p class="file">Folder: <code>projects/${esc(p.slug)}/</code></p>
    </article>`;
  }

  /* ---------- render, keeping your place ---------- */

  function render(opts) {
    if (!HQ.state) return;
    const route = HQ.route;
    const x = route.name === 'ticket' ? find(route.slug, route.id) : null;
    const proj = route.name === 'project' ? HQ.state.projects.find((p) => p.slug === route.slug) : null;
    const current = x ? { slug: x.p.slug, id: x.t.id } : null;

    // Remember focus, caret and scroll so a live reload doesn't throw you out of what you're doing.
    const a = document.activeElement;
    const keep = a && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : a && a.dataset && a.dataset.check ? { check: a.dataset.check } : null;
    const scroll = { y: window.scrollY, list: ($('list-pane') || {}).scrollTop, detail: ($('detail-pane') || {}).scrollTop };

    let detail;
    if (x) detail = ticketHTML(x);
    else if (proj) detail = projectHTML(proj);
    else if (route.name !== 'inbox') detail = '<div class="ticket"><a class="back" href="#/">← Inbox</a><h2 id="tk-title" tabindex="-1">Not found</h2><p>That ticket or project isn’t in your data folder (any more).</p></div>';
    else detail = '<div class="hint"><p>Pick a ticket to answer it.</p></div>';

    const warn = HQ.state.warnings.length ? `<div class="banner bad"><b>Some files have problems:</b><ul>${HQ.state.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
    $('main').innerHTML = `${warn}<div class="layout${route.name === 'inbox' ? '' : ' has-detail'}">
      <nav class="list-pane" id="list-pane" aria-label="Tickets">${listHTML(current)}</nav>
      <section class="detail-pane" id="detail-pane" aria-live="off">${detail}</section></div>`;
    $('data').textContent = HQ.state.dataDir;
    wire(x);

    if (opts && opts.nav) {
      const h = $('tk-title');
      if (h) { h.focus({ preventScroll: true }); window.scrollTo(0, 0); }
      return;
    }
    window.scrollTo(0, scroll.y);
    if ($('list-pane') && scroll.list) $('list-pane').scrollTop = scroll.list;
    if ($('detail-pane') && scroll.detail) $('detail-pane').scrollTop = scroll.detail;
    if (keep) {
      const el = keep.id ? $(keep.id) : document.querySelector(`[data-check="${keep.check}"]`);
      if (el) { el.focus({ preventScroll: true }); if (keep.id && el.setSelectionRange && keep.s != null) try { el.setSelectionRange(keep.s, keep.e); } catch { /* not text */ } }
    }
  }

  /* ---------- actions ---------- */

  function wire(x) {
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { ui.tab = b.dataset.tab; try { sessionStorage.setItem('hq.tab', ui.tab); } catch { /* fine */ } render(); const t = $(`tab-${ui.tab}`); if (t) t.focus(); };
    });
    const tablist = document.querySelector('.tabs');
    if (tablist) tablist.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.findIndex(([k]) => k === ui.tab);
      const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
      $(`tab-${n}`).click();
    };
    if (!x) return;
    const { t, p } = x;
    const k = keyOf(p.slug, t.id);
    const base = `/api/tickets/${encodeURIComponent(p.slug)}/${encodeURIComponent(t.id)}`;
    const run = async (fn) => { if (ui.busy) return; ui.busy = true; document.body.classList.add('busy'); try { await fn(); } finally { ui.busy = false; document.body.classList.remove('busy'); } };

    const form = $('ans-form');
    if (form) {
      const d = ui.drafts[k];
      form.querySelectorAll('input[name="choice"]').forEach((r) => { r.onchange = () => { d.choice = r.value; }; });
      $('ans-words').oninput = (e) => { d.answer = e.target.value; };
      form.onsubmit = (e) => {
        e.preventDefault();
        if (!d.choice && !d.answer.trim()) { HQ.toast(t.options.length ? 'Pick an option or write an answer first.' : 'Write an answer first.', 'bad'); return; }
        run(async () => {
          const r = await HQ.act('POST', `${base}/answer`, { choice: d.choice, answer: d.answer, version: t.version }, 'Saved. Your AI picks it up next time it reads your answers.');
          if (r) { delete ui.drafts[k]; ui.editing = null; render(); }
        });
      };
      const keepBtn = $('ans-keep');
      if (keepBtn) keepBtn.onclick = () => { ui.editing = null; delete ui.drafts[k]; render(); };
    }

    const focusAsk = () => { render(); const y = $('ask-yes'); if (y) y.focus(); };
    if ($('dec-cancel')) $('dec-cancel').onclick = () => { ui.ask = { key: k, mode: 'cancel' }; focusAsk(); };
    if ($('dec-change')) $('dec-change').onclick = () => { ui.ask = { key: k, mode: 'change' }; focusAsk(); };
    if ($('dec-edit')) $('dec-edit').onclick = () => { ui.editing = k; delete ui.drafts[k]; render(); const w = $('ans-words'); if (w) w.focus(); };
    if ($('ask-no')) $('ask-no').onclick = () => { ui.ask = null; render(); const b = $('dec-cancel'); if (b) b.focus(); };
    if ($('ask-yes')) $('ask-yes').onclick = () => run(async () => {
      const mode = ui.ask.mode;
      const r = await HQ.act('POST', `${base}/cancel`, { version: t.version }, mode === 'change' ? 'Decision taken back. Pick again below.' : 'Decision cancelled. It’s back in your Inbox.');
      ui.ask = null;
      delete ui.drafts[k];
      render();
      if (r && mode === 'change') { const f = document.querySelector('#ans-form input, #ans-words'); if (f) f.focus(); }
    });

    if ($('tk-close')) $('tk-close').onclick = () => run(() => HQ.act('POST', `${base}/close`, { version: t.version }, `${t.id} is done.`));

    document.querySelectorAll('[data-check]').forEach((box) => {
      box.onchange = () => run(async () => {
        const r = await HQ.act('POST', `${base}/rubric`, { index: Number(box.dataset.check), done: box.checked, version: t.version });
        if (r && r.change === 'closed') HQ.toast(`${t.id} is done.`);
        else if (r && r.change === 'reopened') HQ.toast(`${t.id} is back in Check it.`);
      });
    });
  }

  HQ.render = render;
  HQ.boot();
})(window.HQ, window.HQFormat, window.HQLogic);
