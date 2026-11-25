# Changelog

## 1.2.0 — 2026-11-25

**Upgrading from 1.1.0:**

- To let a creation hand code to Codex, run Codex's check again in
  Settings: a check saved by 1.1.0 has no no-shell part, so creations do
  not offer Codex until it passes once more. Tasks are not affected.
- The new `implementer` agent ships with the Balanced profile's model and
  effort. If your active profile is another one, choose it again on the
  Usage page (or `npx briefstack usage set <profile>`) so the
  implementer gets your profile's `work` model and effort.

What phase 10 adds ([brief](docs/history/BRIEF-phase-10.md), [plan](docs/history/PLAN-phase-10.md);
decisions in [`docs/decisions.md`](docs/decisions.md), "Phase 10"). Phase 10
was accepted on its real check (`scripts/real/check-creation-code.ts`,
"Phase 10: accepted"); a command off the list being refused was not seen
in real, only in tests.

### A first version of the code in a creation

- At the spec checkpoint of the web app, a `software` project for Claude
  Code may get "workspace and a first version of the code" (the default
  stays "workspace only"), with the exact commands the step may run, the
  checks to run at the end (at least one) and the fix passes (0 to 2).
- A new step, `implement`, after validate-review: the workspace is
  committed first; an `implementer` agent with no shell writes the code
  inside the project folder and runs only the listed commands, through
  briefstack (anything else is denied without asking anyone and listed);
  the checks run, a failure gets a fix pass, and the code is committed
  apart. Checks that still fail leave the code with a warning, never a
  failed creation. Protected files (briefstack's, Claude Code's settings
  and hooks, `.mcp.json`) changed by anyone are put back first, and so are
  skills, commands and agents that declare hooks in their frontmatter, as
  a task refuses them; the result screen lists them with the reason. A
  protected file, or a definition with hooks, that git ignored when the
  step started goes back as it was and stays out of the code commit even
  if its ignore line was removed (briefstack adds it to the repository's
  own `.git/info/exclude`); other ignored files are not watched. When
  those ignored files cannot be read first, the step does not run and the
  screen says why.
- Bounds in Settings: the step's minutes (default 30) and the
  implementer's tool calls (default 150). The plan usage is read before
  the step; at or above the warning thresholds, or unread, it does not
  start.
- The creation page and the result screen show the step: the two
  commits, the commands run and denied, each run of the checks, Codex's
  calls and tokens, and the brief's "Current status" (what is left).
- The terminal `/new-project` flow is unchanged.

### Codex without its shell

- Measured first (8 real calls): with `--disable shell_tool` and the rest
  of what could run commands off (the user's `config.toml` ignored, web
  search off), Codex 0.167.0 ran no command, wrote nothing outside the
  folder and read no text file.
- A creation may tick Codex (off by default) when Codex is on and its
  check passed; the check gains a no-model no-shell part. Codex is used
  only at the version checked, with the calls-per-round limit for the
  whole step. Tasks keep Codex with its shell as before.

## 1.1.0 — 2026-11-22

**Upgrading from 1.0.0:**

- Usage profiles have a `work` entry (the model and effort of a task's
  session). Every preset needs it, user presets included, so a
  `usage-profiles.json` of your own from 1.0.0 no longer loads until you
  add `work` to each preset (the error names the missing field; no
  default is filled in).
- Tasks and builds need git 2.40 or later.

What phases 7, 8 and 9 add. The briefs are in [`docs/history/`](docs/history/)
([phase 7](docs/history/BRIEF-phase-7.md), [phase 8](docs/history/BRIEF-phase-8.md),
[phase 9](docs/history/BRIEF-phase-9.md)); the decisions are in
[`docs/decisions.md`](docs/decisions.md).

### Tasks in existing projects (phase 7)

- A task on a `claude-code` project briefstack created: Claude works in a
  separate copy (a git worktree on its own branch), never in the user's
  folder.
- Every shell command and web request asks first, in a dialog with the
  exact command: once, for the rest of the task, or deny.
- The session loads the project's `CLAUDE.md`, agents and skills; the
  project's hooks never run.
- The result is a diff to review, with validations (files outside the
  copy, settings or hooks, hidden lines, secrets, personal paths); approve
  applies it as one commit on the project's branch, ask for changes runs
  another round on the same branch, revert undoes an approved one,
  discard drops it. Nothing is pushed.
- Tasks start from the project's page or from the chat, with a card to
  confirm.
- Usage profiles have a `work` entry (the model and effort of a task's
  session); see "Upgrading from 1.0.0" above.
- The project's declared checks run only after a click and a
  confirmation on the proposal page.
- Tasks share the active-sessions limit with creations, one per project
  at a time.

### Codex in tasks (phase 8)

- Off by default. With the Settings switch on and the status check
  passed, a task's Claude session may hand code writing to the user's own
  Codex CLI (`delegate_to_codex`), inside the task's copy; Claude reviews
  its work, and the diff, the checks and the approval stay the control.
- The proposal page shows each Codex call, its duration, what it ran and
  its tokens as Codex counts them; cancelling a task ends Codex's whole
  process tree.
- Codex's sandbox on Windows was measured: it can read outside the copy
  and reach 127.0.0.1 and the Internet; the README and Settings say so.

### Builds (phase 9)

- "Implement" on a project with a `docs/BRIEF.md`: a planner session with
  no tools proposes a queue of tasks, commands and checks; the user edits
  and approves it once, with the exact commands a round may run, the
  checks, fix rounds and usage thresholds.
- The queue runs unattended on an integration branch: commands off the
  list are denied without a dialog and recorded, checks run after each
  round, a failing task gets fix rounds and then waits for the user, its
  dependents are skipped. A build's own rounds never offer Codex (its
  commands would not pass through the list; this replaces the brief's
  "only through phase 8's switch"); a waiting task the user opens and runs
  as an ordinary task still can.
- Pause and resume, a pause by plan usage that resumes by itself at the
  reset, cancel, and a restart that leaves a build interrupted.
- The build's page: progress, Claude's tokens per task, the whole change,
  and apply (one commit on the project's branch), revert and discard.
  Discarding an applied build deletes only its branch; it can still be
  reverted.
- Safety: the integration branch is never moved or removed while a folder
  has it checked out; a start with no checks needs an explicit
  confirmation; the start page says that the list limits command lines,
  not what an approved command runs. Tasks and builds need git 2.40 or
  later.

### Projects and Usage pages (phase 9, step 33)

- Archive and restore an interrupted or cancelled creation.
- Export the projects list as CSV, with no paths.
- A note on the week's plan window: its figure, its reset day and what
  runs now.
- "New preset based on…": a user preset made from another one on the
  Usage page.

## 1.0.0 — 2026-10-25

First public release. briefstack was built in phases; the brief and plan of
each are in [`docs/history/`](docs/history/) and the decisions in
[`docs/decisions.md`](docs/decisions.md).

### Creator and library (phase 1)

- The `/new-project` flow in Claude Code: a main session and five agents
  (interviewer, researcher, architect, generator, reviewer) that turn an
  idea into a spec the user approves, then a project folder for Claude
  Code or the Claude app.
- The `briefstack` CLI: `init`, `library`, `paths`, `spec check`,
  `scaffold`, `validate`, `usage`, `commit`, `event`.
- Base templates (software, learning or management, generic), base skills
  and the rule that picks the target.
- The personal library: Markdown notes, kept as a git repository, with a
  secret check on every write.
- Usage profiles (saver, balanced, max) for each agent's model and effort.

### Local web app (phase 2)

- `briefstack web`: a server on 127.0.0.1 with a launch token, running
  creations through the Agent SDK with the user's own Claude Code.
- A guard on every session: writes only inside the projects folder, the
  session folder and folders granted for one creation; permission
  requests asked to the user or denied in unattended mode.
- Projects, sessions, the library editor with its history, settings.

### Live agent panel (phase 3)

- A live view of every agent of a creation: status, tool in use, model
  and effort, timeline, denied calls, and plan usage at the start and now.

### Chat and several creations (phase 4)

- A global chat about projects, the library, creations and usage, with no
  file or shell tools; every change it proposes is a card to confirm.
- Several creations at the same time, with a limit set in Settings.

### Self-improvement (phase 5)

- Proposals to improve the creation flow's own agents, skill and
  templates, prepared in a separate worktree, checked, tested and safety
  reviewed, applied as one commit only after approval, and revertible.
- Suggestions after a creation, from what went wrong in it.

### Interface (UI pass)

- A new design in light and dark themes, at desktop and phone widths, in
  English and Spanish.

### Skills library (phase 6)

- Third-party skills from public GitHub links: pinned to a commit,
  fetched into quarantine, reviewed by static checks and a short model
  review, never executed; installed into projects only when approved, and
  checked against their hashes.
- A plan-usage warning before expensive actions, archived projects, and
  discarded suggestions.

### Release

- briefstack runs with whatever the user set up for their own Claude
  Code: a Claude plan, their own API key, or a cloud provider. The web
  app and the CLI say which one is in use, and what to do when Claude
  Code is missing, too old or not signed in. Plan usage is shown only
  with a plan.
- `npm install` builds the app, so `npx briefstack` works from a clone.
- Dependencies updated for the security advisories `npm audit` reported:
  markdown-it 15.0.3, and body-parser 2.4.0 and fast-uri 3.1.9 through the
  Agent SDK.
- The CI runs on Linux, Windows and macOS.
- README, license (MIT), security policy, contributing guide and this
  changelog.
