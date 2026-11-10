/* HQ Template: what happens to a ticket when you act on it.
 *
 * Pure functions on parsed tickets (see format.js), shared by the server (which enforces them)
 * and the dashboard (which shows the buttons they allow). No dependencies.
 *
 * Statuses:  open → (you answer) answered → (your AI records it) verify → (you tick your checks) done
 *            working = your AI is doing the task.
 * Cancel:    any ticket holding your call (answered, working, verify, done) can go back to open.
 *            If your AI never saw it, that's all. If it did, the ticket gets a `cancelled:` entry
 *            with `undo: pending`, and your AI undoes what the decision changed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./format.js'));
  else root.HQLogic = factory(root.HQFormat);
})(typeof self !== 'undefined' ? self : this, function (F) {
  'use strict';

  class Refused extends Error {
    // status 400: the request makes no sense; 409: it makes sense, just not for this ticket right now
    constructor(status, message) { super(message); this.name = 'Refused'; this.status = status; }
  }

  const records = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const answerText = (t) => F.getSection(t, 'Answer').trim();
  const hasCall = (t) => !!(t.choice || answerText(t));
  const sentIn = (t) => (t.extra && typeof t.extra.sent === 'string' ? t.extra.sent : '');
  const cancellations = (t) => records(t.extra && t.extra.cancelled);
  const lastCancel = (t) => { const c = cancellations(t); return c.length ? c[c.length - 1] : null; };
  const pendingUndo = (t) => cancellations(t).filter((c) => c.undo === 'pending');

  // What you decided, in a few words.
  function callLabel(t) {
    if (t.choice) return F.optionLabel(t, t.choice) || t.choice;
    const a = answerText(t).split('\n')[0];
    return a ? (a.length > 80 ? a.slice(0, 79) + '…' : a) : 'my answer';
  }

  // Has your AI (possibly) acted on your call already? Then cancelling needs an undo.
  const reached = (t) => !!sentIn(t) || t.status !== 'answered';

  const canAnswer = (t) => t.status === 'open' || t.status === 'answered';
  const canCancel = (t) => hasCall(t) && ['answered', 'working', 'verify', 'done'].includes(t.status);

  function lockedBy(t, byId) {
    return (t.needs || []).filter((id) => { const n = byId[id]; return !n || !F.SETTLED.includes(n.status); });
  }

  // Where a ticket shows up in the dashboard.
  function bucket(t, byId) {
    if (t.status === 'open') return lockedBy(t, byId).length ? 'locked' : 'needs';
    if (t.status === 'verify') return 'check';
    if (t.status === 'answered') return 'answered';
    if (t.status === 'working') return hasCall(t) ? 'answered' : 'working';
    if (t.status === 'done') return 'done';
    return 'needs'; // an unknown status still shows up, with its warning
  }

  /* ---------- rubric ---------- */

  const allTicked = (t) => { const r = F.rubric(t); return r.length > 0 && r.every((x) => x.done); };

  // Tick or untick your (you) checks: all of them, or just the first.
  function setYourChecks(t, done, firstOnly) {
    let next = t;
    const r = F.rubric(t);
    for (let i = 0; i < r.length; i++) {
      if (r[i].who !== 'you') continue;
      if (r[i].done !== done) next = F.setRubric(next, i, done);
      if (firstOnly) break;
    }
    return next;
  }

  // Ticking your last check on a "Check it" ticket closes it; unticking one on a done ticket reopens it.
  function tickRubric(t, index, done) {
    if (!Number.isInteger(index) || typeof done !== 'boolean') throw new Refused(400, 'Send "index" (a number) and "done" (true or false).');
    let next;
    try { next = F.setRubric(t, index, done); } catch (e) { throw new Refused(400, e.message); }
    let change = '';
    if (next.status === 'verify' && allTicked(next)) { next = { ...next, status: 'done' }; change = 'closed'; }
    else if (next.status === 'done' && !allTicked(next)) { next = { ...next, status: 'verify' }; change = 'reopened'; }
    return { next, check: F.rubric(next)[index], change };
  }

  // A "Check it" ticket whose checks are all ticked already (say the AI ticked the last one):
  // closing it is still your move.
  function close(t) {
    if (t.status !== 'verify') throw new Refused(409, `${t.id} is "${t.status}". Only a ticket in Check it can be closed.`);
    if (!allTicked(t)) throw new Refused(409, `${t.id} still has unticked checks. Tick them to close it.`);
    return { next: { ...t, status: 'done' } };
  }

  /* ---------- answering ---------- */

  function addCancel(next, prev, undo, today) {
    const rec = { at: today, label: callLabel(prev), choice: prev.choice || '', was: prev.status, undo };
    return { ...next, extra: { ...next.extra, cancelled: [...cancellations(next), rec] } };
  }

  function withoutSent(t) {
    const extra = { ...t.extra };
    delete extra.sent;
    return { ...t, extra };
  }

  // Save your answer. `locked` is lockedBy(t, byId).
  function answer(t, input, locked, today) {
    if (!canAnswer(t)) throw new Refused(409, `${t.id} is "${t.status}", so it can't be answered now. Cancel or change your decision first.`);
    if (locked && locked.length) throw new Refused(409, `${t.id} is locked until ${locked.join(', ')} ${locked.length > 1 ? 'are' : 'is'} answered or done.`);
    const choice = typeof input.choice === 'string' ? input.choice.trim() : '';
    const words = typeof input.answer === 'string' ? input.answer : '';
    if (choice && !t.options.some((o) => o.key === choice)) throw new Refused(400, `"${choice}" isn't one of ${t.id}'s options (${t.options.map((o) => o.key).join(', ')}).`);
    if (!choice && !words.trim()) throw new Refused(400, t.options.length ? 'Pick an option or write an answer.' : 'Write an answer.');
    let next = { ...t, choice, status: 'answered' };
    // Editing an answer your AI may already have (it went out in a batch): the old one is cancelled.
    if (t.status === 'answered' && sentIn(t)) next = addCancel(withoutSent(next), t, 'pending', today);
    next = F.setSection(next, 'Answer', words);
    // By convention a decision's first (you) check is "Picked": answering ticks it.
    if (t.kind === 'decision') next = setYourChecks(next, true, true);
    return { next, label: callLabel(next), edited: t.status === 'answered' };
  }

  // Take your call back. The ticket returns to open, ready for a new answer.
  function cancel(t, today) {
    if (!canCancel(t)) throw new Refused(409, `${t.id} has no decision of yours to cancel.`);
    const undo = reached(t) ? 'pending' : 'none';
    let next = withoutSent({ ...t, status: 'open', choice: '' });
    next = F.setSection(next, 'Answer', '');
    next = setYourChecks(next, false, false);
    next = addCancel(next, t, undo, today);
    return { next, label: callLabel(t), undo, logLine: undo === 'pending' ? F.logLine({ date: today, ticket: t.id, text: `Cancelled "${callLabel(t)}" (was ${t.status}). The AI undoes what it changed.` }) : '' };
  }

  // What changing a recorded decision would throw away: shown before you confirm.
  function reversalCost(t, logEntries) {
    const r = F.rubric(t);
    return {
      aiChecks: r.filter((x) => x.who === 'AI' && x.done).map((x) => x.text),
      yourChecks: r.filter((x) => x.who === 'you' && x.done).map((x) => x.text),
      evidence: F.getSection(t, 'Evidence').trim(),
      log: (logEntries || []).filter((e) => e.ticket === t.id).map((e) => `${e.date}: ${e.text}`),
    };
  }

  /* ---------- the Inbox order ---------- */

  // How many unsettled tickets wait on this one, directly or through others.
  function blocks(t, tickets) {
    const waiting = new Set();
    let frontier = [t.id];
    while (frontier.length) {
      const next = [];
      for (const x of tickets) {
        if (waiting.has(x.id) || F.SETTLED.includes(x.status) || x.id === t.id) continue;
        if ((x.needs || []).some((n) => frontier.includes(n))) { waiting.add(x.id); next.push(x.id); }
      }
      frontier = next;
    }
    return waiting.size;
  }

  const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  const quick = (t) => (t.tags || []).some((g) => /^effort:\s*quick$/i.test(g));

  // Projects by your ranking, then each project's phases in order, then what unblocks the most,
  // then quick ones first, then ticket number.
  function inboxOrder(projects) {
    const rows = [];
    for (const p of projects) {
      const phaseIx = Object.fromEntries((p.phases || []).map((ph, i) => [ph.key, i]));
      const byId = Object.fromEntries(p.tickets.map((t) => [t.id, t]));
      for (const t of p.tickets) {
        rows.push({
          project: p, ticket: t, bucket: bucket(t, byId), lockedBy: lockedBy(t, byId),
          key: [p.rank || 0, t.phase in phaseIx ? phaseIx[t.phase] : 999, -blocks(t, p.tickets), quick(t) ? 0 : 1, idNum(t.id)],
        });
      }
    }
    rows.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0; });
    return rows;
  }

  return {
    Refused, hasCall, sentIn, cancellations, lastCancel, pendingUndo, callLabel, reached,
    canAnswer, canCancel, lockedBy, bucket, allTicked, tickRubric, close, answer, cancel, reversalCost,
    blocks, inboxOrder,
  };
});
