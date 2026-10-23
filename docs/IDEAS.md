# briefstack — ideas

Ideas to review after the UI pass. None of them is planned or in scope yet:
they are not in any brief or plan, and nothing here is to be built until the
user decides so.

## 1. A library of third-party skills

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

### Settings: folders with read-only access

A list of folders agents may read without asking, with add and remove. It
would change the guard and the permission policy: a new config field, the
guard allowing reads (never writes) inside those folders, the same
validation as the projects folder (full path, not over the library or the
repository), a note in the creation's denied list, and tests in the
security suite. The design's folder dialog also offers "read only" versus
"read and write" for one creation, which would need the same change.
