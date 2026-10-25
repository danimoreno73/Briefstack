# briefstack — ideas

The living backlog: ideas and open items after `v1.0.0`. None of them is
planned or in scope yet, and nothing here is to be built until the user
decides so; each needs its own plan and approval.

## 1. A library of third-party skills

**Done in phase 6** ([BRIEF-phase-6.md](BRIEF-phase-6.md)).

- Add skills from the chat or from a page: a GitHub link, a zip or a
  `SKILL.md`.
- Store them in the personal library with their source, a pinned commit,
  the license and tags.
- Quarantine with an automatic review (scripts, network access, hooks,
  `allowed-tools`, a safety warning) and the user's approval before use.
- The architect proposes which skills to include in each project and which
  subagents they go to.
- Add them to existing projects too, with a confirmation.
- briefstack never runs them.

## 2. Working inside projects from briefstack

Today briefstack only creates projects; the work on them happens in Claude
Code or the app. To consider: whether the global chat should be able to
open and direct work sessions in an existing project.

## 3. Controls the U5 design shows that the app does not have

The design in `docs/diseno/` draws these. They were left off the screens
during U5, at the user's request, and are recorded here with what each one
would take. Each would be a behaviour change, outside a UI pass.

### Usage: "New preset based on Balanced"

Create a user preset from a base one, from the page. It would need a write
route for presets (today user presets are written by hand in the user's
`usage-profiles.json`), the same schema check as the CLI, a form to change
the model and effort per agent, and the rule that `.claude/agents/*.md` is
only written by `briefstack usage set`.

### Usage: a note on the week's plan window

"The week is at 63% and resets on Monday; switching to Max with two
creations running could reach the limit sooner." The page would need to
read the plan usage outside a creation (today it is read for each creation's
panel), know the reset day, and count the running creations; the reading
costs a call each time.

### Projects: "Export CSV"

Download the projects list as a CSV file. The page could build it from
`GET /api/projects`, but it would need a decision on columns and on paths
(the list shows absolute paths of the user's machine), a file download from
a page whose CSP allows nothing but `'self'` (a `blob:` URL would need
checking against the CSP), and English and Spanish column names.

### Projects: "Archive" an interrupted or cancelled creation

Hide an unfinished creation from the list without deleting it. It would
need a place to keep the choice (a field in the session's folder or in the
briefstack home, written by code with tests), a write route with the
token, a way to see and restore what was archived, and a rule for the chat's
`list_sessions` tool.

### Project and result: "Open folder"

Open the project's folder in the system's file manager. The server would
have to start a program on the user's machine (`explorer`, `open` or
`xdg-open`, one per platform), from a browser request: a new kind of action
for a local server, with its own confirmation, path checks (only folders
this tool created) and tests on the three systems.

### Improvements: "Discard" a suggestion

**Done in phase 6** (M8 in [PLAN-phase-6.md](PLAN-phase-6.md)).

Remove a suggestion from the list without preparing it. Suggestions are
kept by the improvement manager; it would need a discard route with the
token, a stored state for discarded suggestions (so they do not come back
after a restart), the same for the chat's view of suggestions, and tests.

### Settings: folders with read-only access

A list of folders agents may read without asking, with add and remove. It
would change the guard and the permission policy: a new config field, the
guard allowing reads (never writes) inside those folders, the same
validation as the projects folder (full path, not over the library or the
repository), a note in the creation's denied list, and tests in the
security suite. The design's folder dialog also offers "read only" versus
"read and write" for one creation, which would need the same change.

## 4. Open items from the plans

Moved here from the backlogs of the phase plans that were still open when
`v1.0.0` was tagged. Items those backlogs listed and a later phase closed
are not repeated.

- `/tasks` was captured for the generator and the reviewer only; the
  interviewer, researcher and architect still need one during a run
  (verification 9). From [PLAN-phase-1.md](PLAN-phase-1.md).
- A `claude-code` project does not show its scheduled tasks anywhere; only
  `NEXT_STEPS.md` of a `claude-app` project does. From
  [PLAN-phase-1.md](PLAN-phase-1.md).
- The chat sometimes describes a creation's step wrongly: it should quote the
  exact step from the panel. From [PLAN-phase-4.md](PLAN-phase-4.md), carried
  in [PLAN-phase-5.md](PLAN-phase-5.md).
- Creations see the repo's `CLAUDE.md`. From
  [PLAN-phase-4.md](PLAN-phase-4.md), carried in
  [PLAN-phase-5.md](PLAN-phase-5.md).
- Folder claims live in the server's memory, so a creation started from the
  terminal (`/new-project` in Claude Code) is not seen by them (the apply
  gate of improvements does see it). From [PLAN-phase-4.md](PLAN-phase-4.md),
  carried in [PLAN-phase-5.md](PLAN-phase-5.md).
- The library lock on writes that take more than 2 minutes. From
  [PLAN-phase-4.md](PLAN-phase-4.md), carried in
  [PLAN-phase-5.md](PLAN-phase-5.md).
- Check whether the SDK passes the abort signal to the chat's tools. From
  [PLAN-phase-4.md](PLAN-phase-4.md), carried in
  [PLAN-phase-5.md](PLAN-phase-5.md).
- Turns that ended in text are counted in memory only, so suggestions after
  a server restart miss them. From [PLAN-phase-5.md](PLAN-phase-5.md).
- Less noise in the skills static scanner: URLs in license files and
  `localhost` URLs as `info`, `subprocess` and `socket` weighed by context.
  From [PLAN-phase-6.md](PLAN-phase-6.md).
- A portability finding for absolute Linux paths (`/tmp`, `/mnt`, `/home`)
  in skill scripts, which on Windows end up under the current drive. From
  [PLAN-phase-6.md](PLAN-phase-6.md).
- The Usage page shows no figures until a creation reads the usage: show
  the last known values, or read them when the page opens. From
  [PLAN-phase-6.md](PLAN-phase-6.md).
- `tests/unit/improve-manager.test.ts`, "waits while a creation runs and
  applies once none does", sleeps a fixed 80 ms to check that nothing was
  committed; wait for a gate tick that found the blocker instead. From
  [PLAN-release.md](PLAN-release.md).
