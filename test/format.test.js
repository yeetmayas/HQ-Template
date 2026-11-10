'use strict';
// Phase 1 check: the parser round-trips every field of the example tickets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../app/format.js');

const EX = path.join(__dirname, '..', 'defaults', 'example-project');
const ticketFiles = fs.readdirSync(path.join(EX, 'tickets')).filter((f) => f.endsWith('.md')).sort();
const read = (...p) => fs.readFileSync(path.join(EX, ...p), 'utf8');

test('there are six example tickets', () => {
  assert.deepEqual(ticketFiles, ['T-001.md', 'T-002.md', 'T-003.md', 'T-004.md', 'T-005.md', 'T-006.md']);
});

for (const f of ticketFiles) {
  test(`${f}: parse → write gives back the same bytes, and parse → write → parse the same fields`, () => {
    const raw = read('tickets', f);
    const t = F.parseTicket(raw);
    const out = F.serializeTicket(t);
    assert.equal(out, raw);
    assert.deepEqual(F.parseTicket(out), t);
    assert.deepEqual(F.rubric(F.parseTicket(out)), F.rubric(t));
    assert.deepEqual(F.visuals(F.parseTicket(out)), F.visuals(t));
  });
}

test('the example tickets are clean: no warnings against their project', () => {
  const project = F.parseProject(read('project.md'));
  const tickets = ticketFiles.map((f) => F.parseTicket(read('tickets', f)));
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  for (const t of tickets) assert.deepEqual(F.checkTicket(t, { fileId: t.id, phases: project.phases.map((p) => p.key), byId }), [], t.id);
});

test('T-001: every field reads as written', () => {
  const t = F.parseTicket(read('tickets', 'T-001.md'));
  assert.equal(t.id, 'T-001');
  assert.equal(t.title, 'Where do we go?');
  assert.equal(t.status, 'done');
  assert.equal(t.kind, 'decision');
  assert.equal(t.phase, 'P1');
  assert.deepEqual(t.needs, []);
  assert.deepEqual(t.tags, ['area: plans', 'effort: quick']);
  assert.deepEqual(t.options, [
    { key: 'city', label: 'A big city', hint: 'lots to do, about €140 a night' },
    { key: 'coast', label: 'The coast', hint: 'cheaper, weather risk' },
    { key: 'hills', label: 'The hills', hint: 'walking, needs a car' },
  ]);
  assert.equal(t.choice, 'coast');
  assert.deepEqual(t.extra, {});
  assert.deepEqual(t.sections.map((s) => s.title), ['Question', 'Context', 'Rubric', 'Visual', 'Evidence', 'Answer']);
  assert.equal(F.getSection(t, 'question'), 'Where should the trip be?');
  assert.equal(F.getSection(t, 'Answer'), 'Somewhere cheap by the sea, an easy train ride away.');
  assert.deepEqual(F.rubric(t), [
    { done: true, who: 'AI', text: 'Options shown with what each one costs' },
    { done: true, who: 'you', text: 'Picked' },
    { done: true, who: 'AI', text: 'Recorded in the log' },
    { done: true, who: 'you', text: 'Checked the log entry says what I meant' },
  ]);
  const [v] = F.visuals(t);
  assert.equal(v.type, 'table');
  assert.equal(v.fields.columns, 'Option | Per night | Getting there');
  assert.equal(F.optionLabel(t, t.choice), 'The coast');
});

test('every visual and lock in the example project', () => {
  const ts = Object.fromEntries(ticketFiles.map((f) => { const t = F.parseTicket(read('tickets', f)); return [t.id, t]; }));
  assert.deepEqual(F.visuals(ts['T-003']).map((v) => [v.lang, v.type]), [['chart', 'bars']]);
  assert.equal(F.visuals(ts['T-003'])[0].fields.rows, 'Hostel, private room 60 | Holiday flat 75 | Small hotel 110');
  assert.deepEqual(F.visuals(ts['T-004']).map((v) => v.type), ['flow']);
  const locked = Object.values(ts).filter((t) => F.isLocked(t, ts)).map((t) => t.id);
  assert.deepEqual(locked, ['T-006']);
  assert.equal(ts['T-004'].kind, 'task');
  assert.deepEqual(ts['T-004'].options, []);
  assert.equal(ts['T-005'].title, 'I read this as: "cheap" means under €80 a night');
  assert.ok(ts['T-005'].tags.includes('read-back'));
});

test('changing every field and writing it back keeps every change', () => {
  const t = F.parseTicket(read('tickets', 'T-003.md'));
  const changed = {
    ...t,
    id: 'T-099',
    title: 'Fix bug #3 | the "odd" one # really',
    status: 'verify',
    kind: 'task',
    phase: 'P3',
    needs: ['T-001', 'T-002'],
    tags: ['area: odd, commas', '[bracketed]', 'plain'],
    options: [{ key: 'a', label: 'Pipe | inside', hint: ' leading space' }, { key: 'b', label: 'Hash # inside', hint: '' }],
    choice: 'b',
    extra: { owner: 'me', due: '2026-12-01', links: ['one', 'two'], steps: [{ n: '1', what: 'first' }] },
  };
  let edited = F.setSection(changed, 'Answer', 'Line one.\n\nLine two, with ## not a heading.');
  edited = F.setRubric(edited, 1, true);
  edited = F.setSection(edited, 'Notes', 'A new section at the end.');
  const back = F.parseTicket(F.serializeTicket(edited));
  assert.deepEqual(back, edited);
  assert.equal(F.rubric(back)[1].done, true);
  assert.equal(F.getSection(back, 'Answer'), 'Line one.\n\nLine two, with ## not a heading.');
});

test('the format sample from the brief (with comments) reads correctly', () => {
  const sample = [
    '---',
    'id: T-014',
    'title: Pick a venue for the launch party',
    'status: open            # open | working | answered | verify | done',
    'phase: P2               # one of the project\'s phases',
    'needs: [T-011]          # locked until these are answered or done',
    'tags: [area: events, effort: quick]',
    'options:',
    '  - key: rooftop  | label: Rooftop bar   | hint: €€€, weather risk',
    '  - key: studio   | label: The studio    | hint: free, small',
    'choice:                 # filled by the dashboard or the AI',
    '---',
    '',
    '## Question',
    'Where should the launch party be?',
    '',
    '## Visual',
    '```chart',
    'type: bars',
    '## not a heading inside a fence',
    'rows: Rooftop bar 1200 | The studio 0',
    '```',
    '',
    '## Answer',
    '',
  ].join('\n');
  const t = F.parseTicket(sample);
  assert.equal(t.status, 'open');
  assert.equal(t.phase, 'P2');
  assert.equal(t.kind, 'decision');
  assert.deepEqual(t.needs, ['T-011']);
  assert.deepEqual(t.tags, ['area: events', 'effort: quick']);
  assert.deepEqual(t.options, [
    { key: 'rooftop', label: 'Rooftop bar', hint: '€€€, weather risk' },
    { key: 'studio', label: 'The studio', hint: 'free, small' },
  ]);
  assert.equal(t.choice, '');
  assert.deepEqual(t.sections.map((s) => s.title), ['Question', 'Visual', 'Answer']);
  assert.equal(F.visuals(t)[0].fields.rows, 'Rooftop bar 1200 | The studio 0');
  // Comments are not fields: they go on the first write, every field stays.
  assert.deepEqual(F.parseTicket(F.serializeTicket(t)), t);
});

test('Windows line endings and a byte-order mark read the same', () => {
  const raw = read('tickets', 'T-002.md');
  assert.deepEqual(F.parseTicket('﻿' + raw.replace(/\n/g, '\r\n')), F.parseTicket(raw));
});

test('broken files give a clear error with a line number', () => {
  assert.throws(() => F.parseTicket('no header'), /must start with a "---"/);
  assert.throws(() => F.parseTicket('---\nid: T-001\n'), /no closing/);
  assert.throws(() => F.parseTicket('---\nid: T-001\nthis line is wrong\n---\n'), /line 3/);
  assert.throws(() => F.parseTicket('---\nid: T-001\nid: T-002\n---\n'), /appears twice/);
});

test('checkTicket catches the usual mistakes', () => {
  const t = F.parseTicket('---\nid: T-7\ntitle: x\nstatus: finished\nphase: P9\nneeds: [T-404]\noptions:\n  - key: a | label: A\nchoice: z\n---\n');
  const w = F.checkTicket(t, { fileId: 'T-007', phases: ['P1'], byId: {} }).join('\n');
  for (const bit of ['should look like T-001', 'does not match the file name', 'status "finished"', 'phase "P9"', 'needs T-404', 'choice "z"', 'no "## Rubric"']) assert.match(w, new RegExp(bit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('project.md round-trips', () => {
  const raw = read('project.md');
  const p = F.parseProject(raw);
  assert.equal(F.serializeProject(p), raw);
  assert.equal(p.name, 'Plan a weekend trip');
  assert.deepEqual(p.phases.map((x) => x.key), ['P1', 'P2', 'P3']);
  assert.match(p.intro, /example project/);
});

test('ranking and log', () => {
  const r = F.serializeRanking(['b-project', 'a-project']);
  assert.deepEqual(F.parseRanking(r), ['b-project', 'a-project']);
  assert.deepEqual(F.rankProjects(['b', 'gone'], ['a', 'b', 'c']), ['b', 'a', 'c']);
  const log = F.parseLog(read('log.md'));
  assert.deepEqual(log, [{ date: '2026-11-03', ticket: 'T-001', text: 'Picked "The coast". "Somewhere cheap by the sea, an easy train ride away."' }]);
  assert.equal(F.logLine(log[0]), read('log.md').trim().split('\n').pop());
});
