# First run: set me up

> Draft. The full interview script is written and tested in phase 5.

When the user says "set me up", you (their AI):

1. Check Node is installed: `node --version` (18 or newer). If not, send them to https://nodejs.org.
2. Create the data folder from the defaults: run `node server/hq.js` once. It copies
   `defaults/` into `data/`, adds the example project and starts local history.
3. Interview them, at most 4 questions at a time:
   - their projects, and a one-line goal for each;
   - each project's phases (P1, P2, …);
   - the ranking, most important first;
   - the first 3–5 tickets for each project.
4. Write `data/projects/<project>/project.md` and the tickets, in the example project's format,
   and list the projects in `data/projects.md`.
5. Leave the example project until they delete it.
