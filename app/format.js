/* HQ Template: the file format.
 *
 * One module, used by the server (Node) and the dashboard (browser). No dependencies.
 *
 * A ticket file is Markdown with a simple header:
 *
 *   ---
 *   id: T-014
 *   title: Pick a venue
 *   status: open
 *   kind: decision
 *   phase: P2
 *   needs: [T-011]
 *   tags: [area: events, effort: quick]
 *   options:
 *     - key: rooftop | label: Rooftop bar | hint: €€€, weather risk
 *     - key: studio | label: The studio | hint: free, small
 *   choice:
 *   ---
 *
 *   ## Question
 *   ...
 *
 * Header rules (deliberately small, not full YAML):
 *   key: value            a single line of text
 *   key: [a, b]           a list (items split on commas)
 *   key:                  followed by indented "- a: 1 | b: 2" lines: a list of records
 *   # ...                 a comment line; " # ..." at the end of a line is a comment too
 *   "..."                 a value in double quotes is read as a JSON string, so it can hold
 *                         anything (" # ", "|", ",", leading "[" ...). The writer adds quotes
 *                         only when a value needs them.
 *
 * The body is split into "## " sections. Section text is kept exactly, so nothing an AI
 * or a person writes there is lost. Helpers read the rubric and visuals out of it and
 * write ticks and answers back into it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HQFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUSES = ['open', 'working', 'answered', 'verify', 'done'];
  const KINDS = ['decision', 'task'];
  // A ticket is unlocked once every ticket in `needs` has one of these statuses.
  const SETTLED = ['answered', 'verify', 'done'];
  const TICKET_KEYS = ['id', 'title', 'status', 'kind', 'phase', 'needs', 'tags', 'options', 'choice'];
  const PROJECT_KEYS = ['name', 'goal', 'status', 'phases'];

  class FormatError extends Error {
    constructor(message, line) {
      super(line ? `line ${line}: ${message}` : message);
      this.name = 'FormatError';
      this.line = line || null;
    }
  }

  /* ---------- small text helpers ---------- */

  const normalise = (text) => String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // Strip a trailing " # comment", but never inside double quotes.
  function stripComment(s) {
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && inQ) { i++; continue; }
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === '#' && i > 0 && /\s/.test(s[i - 1]) && (i + 1 === s.length || /\s/.test(s[i + 1]))) {
        return s.slice(0, i).trimEnd();
      }
    }
    return s;
  }

  // Split on a separator character, ignoring separators inside double quotes or after a backslash.
  function splitOutside(s, sep) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
      if (c === '"') inQ = !inQ;
      if (c === sep && !inQ) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  function readValue(raw, line) {
    const s = raw.trim();
    if (s.startsWith('"')) {
      try { return JSON.parse(s); } catch (e) { throw new FormatError(`bad quoted value ${s}`, line); }
    }
    return s.replace(/\\([|,\\])/g, '$1');
  }

  // Does a value need quotes to survive a write and a read unchanged?
  function needsQuotes(v, sepChars) {
    if (v === '') return false;
    if (v !== v.trim()) return true;
    if (/^["[]/.test(v)) return true;
    if (/[\n\t]/.test(v)) return true;
    if (/\s#(\s|$)/.test(v) || v === '#' || v.startsWith('# ')) return true;
    if (/\\/.test(v)) return true;
    for (const c of sepChars) if (v.includes(c)) return true;
    return false;
  }
  const writeValue = (v, sepChars) => {
    const s = v == null ? '' : String(v);
    return needsQuotes(s, sepChars || '') ? JSON.stringify(s) : s;
  };

  /* ---------- the header ---------- */

  // Returns an ordered list of [key, value]; value is a string, an array of strings,
  // or an array of records (plain objects of strings).
  function parseHeader(lines, firstLine) {
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const lineNo = firstLine + i;
      const line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
      if (!m) throw new FormatError(`expected "key: value", got ${JSON.stringify(line)}`, lineNo);
      const key = m[1];
      if (seen.has(key)) throw new FormatError(`"${key}" appears twice`, lineNo);
      seen.add(key);
      const rest = stripComment(m[2]).trim();
      if (rest.startsWith('[')) {
        if (!rest.endsWith(']')) throw new FormatError(`list for "${key}" must end with ]`, lineNo);
        const inner = rest.slice(1, -1).trim();
        entries.push([key, inner ? splitOutside(inner, ',').map((x) => readValue(x, lineNo)) : []]);
        continue;
      }
      if (rest !== '') { entries.push([key, readValue(rest, lineNo)]); continue; }
      // empty value: either a record list on the following indented "- " lines, or empty text
      const items = [];
      while (i + 1 < lines.length && /^\s+(-\s|#)/.test(lines[i + 1])) {
        i++;
        const item = lines[i];
        if (/^\s+#/.test(item)) continue;
        const body = item.replace(/^\s+-\s+/, '');
        const rec = {};
        for (const part of splitOutside(body, '|')) {
          const pm = /^\s*([A-Za-z_][\w-]*)\s*:(.*)$/.exec(part);
          if (!pm) throw new FormatError(`expected "name: value" in ${JSON.stringify(part.trim())}`, firstLine + i);
          rec[pm[1]] = readValue(pm[2], firstLine + i);
        }
        items.push(rec);
      }
      entries.push([key, items.length ? items : '']);
    }
    return entries;
  }

  function writeHeaderEntry(key, value) {
    if (Array.isArray(value)) {
      if (value.length && typeof value[0] === 'object' && value[0] !== null) {
        return `${key}:\n` + value.map((rec) => '  - ' + Object.keys(rec).map((k) => `${k}: ${writeValue(rec[k], '|')}`).join(' | ')).join('\n');
      }
      return `${key}: [${value.map((x) => writeValue(x, ',]')).join(', ')}]`;
    }
    const s = writeValue(value, '');
    return s === '' ? `${key}:` : `${key}: ${s}`;
  }

  /* ---------- the body: "## " sections, never split inside a code fence ---------- */

  const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
  const closesFence = (m, fence) => !!m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim();

  function parseSections(text) {
    const lines = text.split('\n');
    const intro = [];
    const sections = [];
    let cur = null, fence = null;
    for (const line of lines) {
      const f = FENCE.exec(line);
      if (fence) { if (closesFence(f, fence)) fence = null; }
      else if (f) fence = f[1];
      else {
        const h = /^## (.+?)\s*$/.exec(line);
        if (h) { cur = { title: h[1], lines: [] }; sections.push(cur); continue; }
      }
      (cur ? cur.lines : intro).push(line);
    }
    const tidy = (ls) => ls.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    return { intro: tidy(intro), sections: sections.map((s) => ({ title: s.title, body: tidy(s.lines) })) };
  }

  function writeSections(intro, sections) {
    const parts = [];
    if (intro) parts.push(intro);
    for (const s of sections) parts.push('## ' + s.title + (s.body ? '\n' + s.body : ''));
    return parts.join('\n\n') + '\n';
  }

  /* ---------- a whole document: header + body ---------- */

  function splitDocument(text) {
    const t = normalise(text);
    const lines = t.split('\n');
    if (lines[0].trim() !== '---') throw new FormatError('a file must start with a "---" header line', 1);
    const end = lines.indexOf('---', 1);
    const endLoose = end > 0 ? end : lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (endLoose < 0) throw new FormatError('the header has no closing "---" line');
    return { header: parseHeader(lines.slice(1, endLoose), 2), body: lines.slice(endLoose + 1).join('\n') };
  }

  function writeDocument(entries, intro, sections) {
    const head = '---\n' + entries.map(([k, v]) => writeHeaderEntry(k, v)).join('\n') + '\n---\n';
    const body = writeSections(intro, sections);
    return body.trim() ? head + '\n' + body : head;
  }

  const asText = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(', ') : v == null ? '' : String(v));
  const asList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))) : v ? [String(v)] : []);
  const asRecords = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'object' && x !== null) : []);

  function takeExtra(entries, known) {
    const extra = {};
    for (const [k, v] of entries) if (!known.includes(k)) extra[k] = v;
    return extra;
  }

  /* ---------- tickets ---------- */

  function parseTicket(text) {
    const { header, body } = splitDocument(text);
    const h = Object.fromEntries(header);
    const { intro, sections } = parseSections(body);
    return {
      id: asText(h.id),
      title: asText(h.title),
      status: asText(h.status) || 'open',
      kind: asText(h.kind) || 'decision',
      phase: asText(h.phase),
      needs: asList(h.needs),
      tags: asList(h.tags),
      options: asRecords(h.options),
      choice: asText(h.choice),
      extra: takeExtra(header, TICKET_KEYS),
      intro,
      sections,
    };
  }

  function serializeTicket(t) {
    const entries = [
      ['id', t.id || ''],
      ['title', t.title || ''],
      ['status', t.status || 'open'],
      ['kind', t.kind || 'decision'],
      ['phase', t.phase || ''],
      ['needs', t.needs || []],
      ['tags', t.tags || []],
      ['options', (t.options || []).length ? t.options : []],
      ['choice', t.choice || ''],
    ];
    for (const [k, v] of Object.entries(t.extra || {})) entries.push([k, v]);
    return writeDocument(entries, t.intro || '', t.sections || []);
  }

  /* ---------- sections, rubric, visuals ---------- */

  const findSection = (t, title) => (t.sections || []).find((s) => s.title.toLowerCase() === String(title).toLowerCase());
  const getSection = (t, title) => { const s = findSection(t, title); return s ? s.body : ''; };

  // Returns a copy of the ticket with the section's text replaced (added at the end if missing).
  function setSection(t, title, body) {
    const sections = (t.sections || []).map((s) => ({ ...s }));
    const s = sections.find((x) => x.title.toLowerCase() === title.toLowerCase());
    const clean = String(body || '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (s) s.body = clean; else sections.push({ title, body: clean });
    return { ...t, sections };
  }

  const RUBRIC_LINE = /^(\s*)- \[([ xX])\] (?:\((AI|you)\) )?(.*)$/;

  function rubric(t) {
    const out = [];
    getSection(t, 'Rubric').split('\n').forEach((line) => {
      const m = RUBRIC_LINE.exec(line);
      if (m) out.push({ done: m[2] !== ' ', who: m[3] || null, text: m[4] });
    });
    return out;
  }

  function setRubric(t, index, done) {
    let n = -1, hit = false;
    const body = getSection(t, 'Rubric').split('\n').map((line) => {
      const m = RUBRIC_LINE.exec(line);
      if (!m) return line;
      n++;
      if (n !== index) return line;
      hit = true;
      return `${m[1]}- [${done ? 'x' : ' '}] ${m[3] ? `(${m[3]}) ` : ''}${m[4]}`;
    }).join('\n');
    if (!hit) throw new FormatError(`there is no rubric check number ${index + 1}`);
    return setSection(t, 'Rubric', body);
  }

  // Fenced blocks in the Visual section. "type: bars" style lines become fields;
  // the dashboard draws them (phase 3), the AI only writes data.
  function visuals(t) {
    const out = [];
    const lines = getSection(t, 'Visual').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const open = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(lines[i]);
      if (!open) continue;
      const fence = open[1];
      const block = [];
      i++;
      while (i < lines.length && !closesFence(FENCE.exec(lines[i]), fence)) block.push(lines[i++]);
      const fields = {};
      for (const l of block) {
        const m = /^\s*([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(l);
        if (m) fields[m[1]] = m[2].trim();
      }
      out.push({ lang: open[2] || '', type: fields.type || open[2] || '', fields, raw: block.join('\n') });
    }
    return out;
  }

  const optionLabel = (t, key) => { const o = (t.options || []).find((x) => x.key === key); return o ? o.label || o.key : ''; };

  function isLocked(t, byId) {
    return (t.needs || []).some((id) => { const n = byId[id]; return !n || !SETTLED.includes(n.status); });
  }

  // Problems worth telling the user (or their AI) about. Never thrown: files written by
  // hand stay readable even when they are a little off.
  function checkTicket(t, ctx) {
    const c = ctx || {};
    const w = [];
    if (!/^T-\d{3,}$/.test(t.id)) w.push(`id "${t.id}" should look like T-001`);
    if (c.fileId && t.id !== c.fileId) w.push(`id "${t.id}" does not match the file name ${c.fileId}.md`);
    if (!t.title) w.push('has no title');
    if (!STATUSES.includes(t.status)) w.push(`status "${t.status}" is not one of ${STATUSES.join(', ')}`);
    if (!KINDS.includes(t.kind)) w.push(`kind "${t.kind}" is not one of ${KINDS.join(', ')}`);
    if (c.phases && t.phase && !c.phases.includes(t.phase)) w.push(`phase "${t.phase}" is not one of the project's phases (${c.phases.join(', ')})`);
    if (c.byId) for (const id of t.needs) if (!c.byId[id]) w.push(`needs ${id}, which doesn't exist`);
    if (t.needs.includes(t.id)) w.push('needs itself');
    t.options.forEach((o, i) => { if (!o.key) w.push(`option ${i + 1} has no key`); });
    if (t.choice && !t.options.some((o) => o.key === t.choice)) w.push(`choice "${t.choice}" is not one of the option keys`);
    if (!findSection(t, 'Question') && t.kind === 'decision') w.push('has no "## Question" section');
    if (!findSection(t, 'Rubric')) w.push('has no "## Rubric" section');
    return w;
  }

  /* ---------- projects ---------- */

  function parseProject(text) {
    const { header, body } = splitDocument(text);
    const h = Object.fromEntries(header);
    const { intro, sections } = parseSections(body);
    return {
      name: asText(h.name),
      goal: asText(h.goal),
      status: asText(h.status) || 'active',
      phases: asRecords(h.phases),
      extra: takeExtra(header, PROJECT_KEYS),
      intro,
      sections,
    };
  }

  function serializeProject(p) {
    const entries = [
      ['name', p.name || ''],
      ['goal', p.goal || ''],
      ['status', p.status || 'active'],
      ['phases', (p.phases || []).length ? p.phases : []],
    ];
    for (const [k, v] of Object.entries(p.extra || {})) entries.push([k, v]);
    return writeDocument(entries, p.intro || '', p.sections || []);
  }

  /* ---------- the ranking: data/projects.md ---------- */

  const RANK_LINE = /^\s*(?:\d+[.)]|[-*])\s+`?([A-Za-z0-9][\w-]*)`?/;

  function parseRanking(text) {
    const out = [];
    for (const line of normalise(text).split('\n')) {
      const m = RANK_LINE.exec(line);
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  function serializeRanking(slugs) {
    return '# Projects, most important first\n\n' +
      'Move a line up or down to re-rank. The Inbox sorts by this order, then by phase.\n\n' +
      slugs.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n';
  }

  // Ranked slugs first (in order), then any project folder not in the list, alphabetically.
  function rankProjects(ranking, slugs) {
    const listed = ranking.filter((s) => slugs.includes(s));
    return listed.concat(slugs.filter((s) => !listed.includes(s)).sort());
  }

  /* ---------- the decision log: projects/<p>/log.md ---------- */

  const LOG_LINE = /^- (\d{4}-\d{2}-\d{2}) · (T-\d{3,}) · (.*)$/;
  function parseLog(text) {
    return normalise(text).split('\n').map((l) => LOG_LINE.exec(l)).filter(Boolean).map((m) => ({ date: m[1], ticket: m[2], text: m[3] }));
  }
  const logLine = (e) => `- ${e.date} · ${e.ticket} · ${String(e.text).replace(/\s*\n\s*/g, ' ')}`;

  return {
    STATUSES, KINDS, SETTLED, FormatError,
    parseTicket, serializeTicket, checkTicket, isLocked, optionLabel,
    getSection, setSection, rubric, setRubric, visuals,
    parseProject, serializeProject,
    parseRanking, serializeRanking, rankProjects,
    parseLog, logLine,
  };
});
