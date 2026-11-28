# Changelog

## Unreleased

What phase 12 adds ([brief](docs/BRIEF-phase-12.md),
[plan](docs/PLAN-phase-12.md); decisions in
[`docs/decisions.md`](docs/decisions.md), "Phase 12" and "Decisiones sin
Dani (fase 12)"). Not yet checked for real: the two real checks
(`scripts/real/check-server-access.ts`, `scripts/real/check-build-reserve.ts`)
are prepared, to be run by the user inside the container.

- **Server mode.** `briefstack web --server --listen <address>
  --allowed-hosts <name:port,...> --access-secret-file <path>` runs it on a
  machine that stays on, inside a container, reached through Tailscale's
  HTTPS. Local mode is unchanged without `--server` (its three options are
  then a usage error). Server mode prints no token and no secret, accepts
  only the loopback names and the configured ones (with an `https://`
  origin), and turns Codex off. Guide, compose example and outbound hosts:
  [docs/server.md](docs/server.md).
- **Device sessions.** Each device signs in once with the access secret (at
  least 32 characters, read from a file at start, kept as a digest, never
  logged) and gets the cookie `__Host-briefstack-session` (`HttpOnly`,
  `Secure`, `SameSite=Strict`, 400 days). Five wrong secrets in 15 minutes
  lock sign-in for 15 minutes. Settings lists the signed-in devices; signing
  one out, or all, ends their open pages at once. Sessions survive a
  restart (digests only, in `<home>/server/sessions.json`, owner-only).
- **The pages on a phone.** The build's progress table becomes one card per
  task under 720 px; e2e at 390×844 for the board, the build page, the
  sign-in and the devices.
- **Reserve providers.** `reserveProviders` in `config.json` (written by
  hand: name, `https://` base URL, models, an absolute key file path; never
  a key). Settings shows them with a status check that sends no key. A
  build's start page chooses, at the usage threshold, to pause (as before)
  or go on with a provider: the cards that start while the plan is over the
  threshold run on it, each keeping its provider for all its rounds, its
  redo included; a missing key file pauses with `pause.reserveMissing`. A
  provider's round gets the key only in its own environment, with Anthropic
  credentials taken out and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, runs in
  permission mode `default` under the same guard and list of commands, and
  each card shows its provider next to its tokens.
- **Builds on a machine that stays on.** `buildsAutoResume` (Settings, off
  by default): a build a restart interrupted resumes by itself at the next
  start once the server listens (a pause for usage keeps its timer; a pause
  you asked, even while cards were still at work, stays; three restarts in
  a row that cut its cards short, without a card ending, leave it
  interrupted, saying so). A round a server stop cut short no longer counts
  against the build's cap of rounds. `buildSlotsCap` (1 to 4,
  default 4): the most cards a build runs at once on this machine, read at
  each pass; the start page offers no more.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` now reaches briefstack's
  sessions when set. With the app folder read-only, `usage set` and
  improvements fail with a clear error (`usage.repoReadOnly`,
  `improve.repoReadOnly`).

## 1.3.0 — 2026-11-26

What phase 11 adds ([brief](docs/history/BRIEF-phase-11.md),
[plan](docs/history/PLAN-phase-11.md); decisions in
[`docs/decisions.md`](docs/decisions.md), "Phase 11"). Phase 11 was
accepted on its real check (`scripts/real/check-build-parallel.ts`,
"Phase 11: accepted"), through the API: two cards at once, one conflict
redone and joined, the checks run again on a joined commit. Among what
was not seen in real, only in tests: the board's page itself, overlapping
areas kept apart, one card at a time with a moved head, a second
conflict, checks that fail only on the joined tree, pauses, cancels and
restarts with several cards, a full shared limit, more than two cards at
once, macOS and Linux.

- **The build's board.** The planner proposes cards with an area (the
  paths or folders each is expected to change) and a size. Before the
  start you edit a card's text, dependencies, area (one path per line) and
  size, add or remove cards, reorder them (a card never goes above one it
  depends on, and the page says so), and choose how many run at once (1 to
  4; the page offers 2, the API's default is 1). While it runs, the
  build's page shows the cards in columns: pending, blocked, running,
  waiting, done, skipped (with why: the card it depends on, or the build's
  cancel). A build planned with 1.2.0 has no areas, and a card without one
  counts as the whole project, so its cards run one at a time.
- **Cards in parallel.** Cards whose dependencies are done and whose areas
  do not overlap run at the same time, each in its own worktree, each a
  session in the shared limit. **Parallel cards spend the plan's 5-hour
  window faster** (more work at once, not more work per window). A card is
  joined to the build's branch when its rounds pass, one join at a time;
  one joined onto other cards' changes runs the build's checks again on
  the joined tree first (when the build has checks). A card that collides
  is redone once on top of what was joined; a second failure leaves it
  waiting for you. Over the usage threshold no card starts and the build
  pauses once the running ones end; cancel ends every running card.
- With one card at a time a build runs as in 1.2.0, but a task joined onto
  a branch that moved (you approved a waiting task meanwhile) is now
  checked again on the joined tree (when the build has checks), and may be
  redone once.
- A restart leaves every running card waiting; resuming a build with more
  than one card at a time starts them again on the build's branch.
- Git: a task's branch is deleted with `update-ref -d` (no rewrite of
  `.git/config`), and a configuration read that failed while another git
  wrote it is tried again.

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
