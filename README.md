# HQ Template

One dashboard for all your projects. It runs on your own computer, keeps everything in plain
files, and works with any AI.

> Status: phase 2 of 6 (dashboard core). Charts, theming and dark mode arrive in phase 3.

## Run it

You need [Node](https://nodejs.org) 18 or newer. Nothing else to install.

```bash
node server/hq.js
```

Open the link it prints. The first run creates your `data/` folder (copied from `defaults/`, with
an example project) and starts a local history of every change you save.

## Where things live

| Folder | What it is |
|---|---|
| `app/` | the dashboard page |
| `server/hq.js` | the local server (Node built-ins only) |
| `defaults/` | the design system, rules and example project copied into `data/` on first run |
| `data/` | **your** projects and tickets. Never part of this repo (it's git-ignored); it has its own local git history with no remote |

To keep your data somewhere else: `node server/hq.js --data ~/HQ-data` (or set `HQ_DATA`).

## Working with an AI

Point your AI at this folder. It reads [AGENTS.md](AGENTS.md) first, then your
`data/RULES.md`. Your rules win.

## Tests

```bash
node --test
```

## Licence

MIT. See [LICENSE](LICENSE).
