'use strict';
// Phase 2: the rules behind every button (logic.js), shared by the server and the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../app/format.js');
const L = require('../app/logic.js');

const EX = path.join(__dirname, '..', 'defaults', 'example-project');
const load = () => {
  const tickets = fs.readdirSync(path.join(EX, 'tickets')).sort().map((f) => F.parseTicket(fs.readFileSync(path.join(EX, 'tickets', f), 'utf8')));
  const project = { slug: 'ex', rank: 1, ...F.parseProject(fs.readFileSync(path.join(EX, 'project.md'), 'utf8')), tickets };
  return { project, byId: Object.fromEntries(tickets.map((t) => [t.id, t])) };
};
const DAY = '2026-11-10';

test('buckets: where each example ticket shows up', () => {
  const { byId } = load();
  assert.deepEqual(Object.fromEntries(Object.values(byId).map((t) => [t.id, L.bucket(t, byId)])),
    { 'T-001': 'done', 'T-002': 'answered', 'T-003': 'needs', 'T-004': 'working', 'T-005': 'needs', 'T-006': 'locked' });
  assert.deepEqual(L.lockedBy(byId['T-006'], byId), ['T-003', 'T-004']);
});

test('Inbox order: project rank, then phase, then what unblocks the most, then quick, then number', () => {
  const { project, byId } = load();
  assert.equal(L.blocks(byId['T-003'], project.tickets), 1);
  assert.equal(L.blocks(byId['T-005'], project.tickets), 0);
  const second = { ...project, slug: 'second', rank: 2, tickets: [{ ...byId['T-005'], id: 'T-001', needs: [] }] };
  const rows = L.inboxOrder([second, project]);
  assert.deepEqual(rows.map((r) => `${r.project.slug}:${r.ticket.id}`), ['ex:T-001', 'ex:T-002', 'ex:T-003', 'ex:T-004', 'ex:T-005', 'ex:T-006', 'second:T-001']);
  // inside a phase, a quick ticket that unblocks the same amount comes first
  const a = { ...byId['T-003'], id: 'T-010', tags: ['effort: quick'], needs: [] };
  const b = { ...byId['T-003'], id: 'T-009', tags: ['effort: medium'], needs: [] };
  assert.deepEqual(L.inboxOrder([{ ...project, tickets: [b, a] }]).map((r) => r.ticket.id), ['T-010', 'T-009']);
});

test('open → answered: saves the choice and words, and ticks the "Picked" check', () => {
  const { byId } = load();
  const { next, label, edited } = L.answer(byId['T-003'], { choice: 'flat', answer: 'Sea view.' }, [], DAY);
  assert.equal(next.status, 'answered');
  assert.equal(next.choice, 'flat');
  assert.equal(F.getSection(next, 'Answer'), 'Sea view.');
  assert.equal(label, 'Holiday flat');
  assert.equal(edited, false);
  assert.deepEqual(F.rubric(next).map((c) => c.done), [true, true, false]);
});

test('answering is refused when locked, closed, or empty, or with an unknown option', () => {
  const { byId } = load();
  assert.throws(() => L.answer(byId['T-006'], { answer: 'x' }, ['T-003'], DAY), (e) => e.status === 409 && /locked until T-003/.test(e.message));
  assert.throws(() => L.answer(byId['T-001'], { choice: 'city' }, [], DAY), (e) => e.status === 409);
  assert.throws(() => L.answer(byId['T-004'], { answer: 'x' }, [], DAY), (e) => e.status === 409, 'working');
  assert.throws(() => L.answer(byId['T-003'], {}, [], DAY), (e) => e.status === 400);
  assert.throws(() => L.answer(byId['T-003'], { choice: 'castle' }, [], DAY), (e) => e.status === 400);
});

test('answered → answered: editing before your AI saw it just replaces the answer', () => {
  const { byId } = load();
  const { next, edited } = L.answer(byId['T-002'], { choice: 'first', answer: '' }, [], DAY);
  assert.equal(edited, true);
  assert.equal(next.choice, 'first');
  assert.deepEqual(L.cancellations(next), []);
});

test('answered (already copied for the AI) → answered: the old answer is cancelled for the AI to undo', () => {
  const { byId } = load();
  const sent = { ...byId['T-002'], extra: { sent: 'B-2026-11-10-1' } };
  const { next } = L.answer(sent, { choice: 'first' }, [], DAY);
  assert.equal(L.sentIn(next), '');
  assert.deepEqual(L.cancellations(next), [{ at: DAY, label: 'Last weekend', choice: 'last', was: 'answered', undo: 'pending' }]);
});

test('answered → open: cancelling before your AI saw it needs no undo', () => {
  const { byId } = load();
  const r = L.cancel(byId['T-002'], DAY);
  assert.equal(r.undo, 'none');
  assert.equal(r.logLine, '');
  assert.equal(r.next.status, 'open');
  assert.equal(r.next.choice, '');
  assert.equal(F.getSection(r.next, 'Answer'), '');
  assert.deepEqual(F.rubric(r.next).map((c) => c.done), [true, false, false], 'your Picked check is unticked, AI checks stay');
  assert.deepEqual(L.lastCancel(r.next), { at: DAY, label: 'Last weekend', choice: 'last', was: 'answered', undo: 'none' });
  // and it round-trips through the file
  assert.deepEqual(L.lastCancel(F.parseTicket(F.serializeTicket(r.next))), L.lastCancel(r.next));
});

test('done / verify / working → open: cancelling a recorded decision asks the AI to undo it and logs it', () => {
  const { byId } = load();
  for (const status of ['done', 'verify', 'working']) {
    const r = L.cancel({ ...byId['T-001'], status }, DAY);
    assert.equal(r.undo, 'pending', status);
    assert.equal(r.next.status, 'open');
    assert.deepEqual(F.rubric(r.next).filter((c) => c.who === 'you').map((c) => c.done), [false, false], 'your checks are unticked');
    assert.deepEqual(F.rubric(r.next).filter((c) => c.who === 'AI').map((c) => c.done), [true, true], 'your AI unticks its own');
    assert.equal(r.logLine, `- ${DAY} · T-001 · Cancelled "The coast" (was ${status}). The AI undoes what it changed.`);
  }
  assert.throws(() => L.cancel(byId['T-003'], DAY), (e) => e.status === 409, 'nothing to cancel on an open ticket');
  assert.throws(() => L.cancel(byId['T-004'], DAY), (e) => e.status === 409, 'a working task with no call of yours');
});

test('what changing a decision would throw away is listed first', () => {
  const { byId } = load();
  const log = F.parseLog(fs.readFileSync(path.join(EX, 'log.md'), 'utf8'));
  const cost = L.reversalCost(byId['T-001'], log);
  assert.deepEqual(cost.aiChecks, ['Options shown with what each one costs', 'Recorded in the log']);
  assert.deepEqual(cost.yourChecks, ['Picked', 'Checked the log entry says what I meant']);
  assert.match(cost.evidence, /Picked "The coast"/);
  assert.equal(cost.log.length, 1);
});

test('verify → done when your last check is ticked; done → verify when one is unticked', () => {
  const { byId } = load();
  const verify = { ...byId['T-001'], status: 'verify' };
  const open = L.tickRubric(verify, 3, false);
  assert.equal(open.next.status, 'verify');
  const closed = L.tickRubric(open.next, 3, true);
  assert.equal(closed.next.status, 'done');
  assert.equal(closed.change, 'closed');
  const reopened = L.tickRubric(closed.next, 1, false);
  assert.equal(reopened.next.status, 'verify');
  assert.equal(reopened.change, 'reopened');
  const working = L.tickRubric(byId['T-004'], 2, true);
  assert.equal(working.next.status, 'working', 'ticks never move other statuses');
  assert.throws(() => L.tickRubric(verify, 9, true), (e) => e.status === 400);
  assert.equal(L.close(closed.next.status === 'done' ? { ...closed.next, status: 'verify' } : closed.next).next.status, 'done');
  assert.throws(() => L.close(open.next), (e) => e.status === 409, 'unticked checks left');
  assert.throws(() => L.close(byId['T-003']), (e) => e.status === 409, 'not in Check it');
});
