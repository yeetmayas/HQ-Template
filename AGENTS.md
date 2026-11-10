# HQ Template: how to work in this dashboard

You are working inside a personal project dashboard. The user's work lives in `data/`. Read `data/RULES.md` before anything else; the user's rules win over this file.

## Files
- Projects: data/projects/<project>/project.md (name, goal, phases).
- Tickets: data/projects/<project>/tickets/T-###.md. One decision or task per ticket. Copy the example ticket's format exactly.
- Ranking: data/projects.md lists projects most important first.
- Log: append every recorded decision to the project's log.md: date, ticket, the decision in the user's words.

## Ticket format
A ticket is Markdown with a header between `---` lines. The example project
(`data/projects/example-weekend-trip/`) has one of every kind; copy its layout.

```md
---
id: T-014
title: Pick a venue for the launch party
status: open
kind: decision
phase: P2
needs: [T-011]
tags: [area: events, effort: quick]
options:
  - key: rooftop | label: Rooftop bar | hint: €€€, weather risk
  - key: studio | label: The studio | hint: free, small
choice:
---

## Question
## Context
## Rubric
## Visual
## Evidence
## Answer
```

- `status`: open, working, answered, verify or done. `kind`: decision or task (a task has `options: []`).
- `needs`: ticket ids in the same project. `choice`: one option `key`, filled when the user answers.
- Rubric lines are `- [ ] (AI) …` or `- [ ] (you) …`; tick with `[x]`.
- A value that holds ` # `, `|`, a comma inside a list, or starts with `[` or `"` goes in double quotes.
- Visuals are fenced blocks (`table`, `bars`, `flow`, `grid`, `stack`, `img`) holding `name: value` lines. The dashboard draws them; you only write the data.

## Statuses
open → (user answers) answered → (you record it) verify → (user ticks their checks) done.
working = you're doing the task. A ticket whose `needs:` aren't answered or done is locked: don't ask it yet.

## Every ticket
- A rubric: checks for you marked (AI), checks for the user marked (you). It closes only when all are ticked.
- A visual (chart, table or flow) wherever one helps.
- Options with what each one costs. Show what a reversal would throw away before recording one.
- Never reopen something the user has decided. If a new decision conflicts with an old one, open a new ticket that says so.

## When the user answers
1. Read every ticket with status answered (or the batch they pasted).
2. Record each one: tick your rubric checks, update anything the decision changes, append to log.md, set status to verify.
3. If an answer is unclear, open an "I read this as…" ticket instead of guessing.
4. If a decision opens new questions, open new tickets with `needs:` set.

## Never
- Don't edit app/ or server/ unless the user asks you to change the dashboard itself.
- Don't commit or push data/ to any remote.
