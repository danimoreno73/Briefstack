# briefstack — ideas

The living backlog: ideas and open items after `v1.0.0`. None of them is
planned or in scope yet, and nothing here is to be built until the user
decides so; each needs its own plan and approval.

## 1. A library of third-party skills

**Done in phase 6** ([BRIEF-phase-6.md](history/BRIEF-phase-6.md)).

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

**Done in phase 7** ([BRIEF-phase-7.md](BRIEF-phase-7.md),
[PLAN-phase-7.md](PLAN-phase-7.md)): tasks in existing projects. What
stays open is in §7, "Open items from phase 7".

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

**Done in phase 6** (M8 in [PLAN-phase-6.md](history/PLAN-phase-6.md)).

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
  (verification 9). From [PLAN-phase-1.md](history/PLAN-phase-1.md).
- A `claude-code` project does not show its scheduled tasks anywhere; only
  `NEXT_STEPS.md` of a `claude-app` project does. From
  [PLAN-phase-1.md](history/PLAN-phase-1.md).
- **Done in backlog 2** (B10 in [PLAN-backlog-2.md](PLAN-backlog-2.md),
  option (1); its real check, `scripts/real/check-chat-step.ts`, is for the
  user to run). The chat sometimes describes a creation's step wrongly: it should quote the
  exact step from the panel. From [PLAN-phase-4.md](history/PLAN-phase-4.md), carried
  in [PLAN-phase-5.md](history/PLAN-phase-5.md).

  **Proposal** (backlog 1, B10):
  - *Cause.* The chat gets the step as data and words it itself.
    `list_sessions` gives the open step's id (`gap-analysis`,
    `validate-review`, …) only while a step is open: the manager's
    `currentStep` is unset between a `step.finished` and the next
    `step.started`. `session_panel` gives every step's state, but not the
    position or the name the panel shows ("step 3 / 9", "Validate and
    review"), which come from UI code (`stepPosition` and `t.stepLabel` in
    `src/ui/`). The system prompt does not say to quote the step, so the
    model infers it, at times from which agent runs or from the order, and
    between steps it has nothing to go on.
  - *Options.* (1) One `stepText` in both tools, built by the same code as
    the panel: the step reached (the open one, else the last one that is not
    waiting, as `stepPosition` does), "Step n of 9: name" in the chat's
    language, and what the creation waits for. `stepPosition` and the step
    labels move to code both sides import (`src/panel/`, `src/i18n/`), and
    the system prompt says to tell what a creation is doing by quoting
    `stepText`, never by inferring it. (2) Only the prompt line, with the
    ids as they are: cheaper, but the wording and the gaps between steps
    stay with the model. Recommended: (1).
  - *Risk.* Low. The panel's own text must not change (the moved function
    is the same one); the prompt change shifts how the model answers, so it
    needs a real check.
  - *Tests.* `stepText` equals what the panel shows for an open step,
    between steps, waiting for an answer, finished and interrupted, in
    English and Spanish; `list_sessions` and `session_panel` carry it; the
    system prompt names it; a real check for the user that asks the chat
    mid-creation and compares the answer with the panel.
- **Done in backlog 2** (B8 in [PLAN-backlog-2.md](PLAN-backlog-2.md),
  option (1); what the docs say is in decisions.md, "Backlog 2:
  `claudeMdExcludes` for creations"; its real check,
  `scripts/real/check-claude-md.ts`, passed for the main session and a
  subagent on 2026-10-26: closed). Creations see the repo's `CLAUDE.md`. From
  [PLAN-phase-4.md](history/PLAN-phase-4.md), carried in
  [PLAN-phase-5.md](history/PLAN-phase-5.md).

  Still open after B8: a `CLAUDE.md` in a folder above the repo (the
  user's own, if any) still loads in creations, as the docs say every
  parent folder's does; and the templates'
  `library/templates/*/claude-code/CLAUDE.md` would load on demand if an
  agent read a file in their folder. Neither is excluded yet.

  **Proposal** (backlog 1, B8):
  - *Cause.* Creation sessions run with the repo as working folder and
    `settingSources: ['project']` (`buildQueryOptions` in
    `src/creation/sdkRunner.ts`); that is how they get the flow's skill,
    agents and hooks. The same source loads the repo's `CLAUDE.md` as
    project memory, in the main session and in every subagent. That file
    is for contributors ("plan first and wait for approval", "when the
    brief is ambiguous, ask", commit and CI rules), and some of it pulls
    against the flow, which must ask only through its tools. `CLAUDE.local.md`
    is not loaded (`local` is not a source). Whether `CLAUDE.md` files in
    folders above the repo load too is to be checked.
  - *Options.* (1) The `claudeMdExcludes` setting (in the SDK 0.3.286
    types: "glob patterns or absolute paths of CLAUDE.md files to exclude",
    for user, project and local memory) with the repo's `CLAUDE.md`, in the
    flag settings the runner already passes to each creation. Skills,
    agents and hooks still load. To verify in the docs first: that flag
    settings honour it and that subagents follow it. (2) `omitClaudeMd` on
    agent definitions: subagents only ("no effect on the main session
    agent"), and the flow's agents are files, not SDK definitions; at most
    a complement to (1). (3) Move the contributor rules from the root
    `CLAUDE.md` to `CONTRIBUTING.md`: no code, but contributors' own Claude
    Code sessions lose them, and whatever stays in the root file still
    reaches creations. (4) Run creations from a folder of their own with a
    copy of `.claude/`: the guard's paths, the `npm run briefstack` command
    and the hooks all assume the repo as working folder; too large for the
    gain. Recommended: (1).
  - *Risk.* Low for the flow, which never needed those rules. The setting
    sits in the same flag settings as the command-hook guard, so the change
    must leave the guard's settings exactly as they are. If Claude Code
    ignores the setting, nothing breaks: the file is still loaded, as now.
  - *Tests.* `buildQueryOptions` carries the exclusion with the repo's
    `CLAUDE.md` path, written by code from the repo folder, and the guard's
    settings unchanged (unit); the guard and creation security tests as
    they are; a real check for the user (`scripts/real/`) that asks a
    creation's main session and one subagent whether a marker line of the
    repo's `CLAUDE.md` is in their instructions.
- Folder claims live in the server's memory, so a creation started from the
  terminal (`/new-project` in Claude Code) is not seen by them (the apply
  gate of improvements does see it). From [PLAN-phase-4.md](history/PLAN-phase-4.md),
  carried in [PLAN-phase-5.md](history/PLAN-phase-5.md).

  **Half done in backlog 2** (B9 in [PLAN-backlog-2.md](PLAN-backlog-2.md)):
  option (2), read only, recorded in the session's `folder.json` rather
  than in an event (decisions.md, "Backlog 2: the web app sees the folders
  of terminal creations"), and the README note of option (3). Still open:
  option (1), so that the terminal flow is refused the folder of a web
  creation too.

  **Proposal** (backlog 1, B9):
  - *Cause.* `FolderClaims` is a map in the server's `CreationManager`,
    filled by the server's own `PreToolUse` hook (`folderClaims.ts`) when
    the flow runs `paths check`, `grant_directory` or `scaffold`. A creation
    started from Claude Code has none of the server's hooks (only the repo's
    command hooks, which append events), so it never claims a folder: the
    server cannot refuse it one, nor refuse its own creations the folder the
    terminal one writes. Its `events.jsonl` does not name the output folder
    either (targets are relative to their roots), so the server cannot
    rebuild the claim from disk the way the apply gate finds in-progress
    sessions.
  - *Options.* (1) Claims on disk, written by the CLI: `paths check` and
    `scaffold`, which both flows run, take `--session SESSION` (the flow
    already passes it to `event`) and record `{ session, dir, at }` in
    `<home>/claims/<session>.json`; the server writes its creations' claims
    there too. A claim counts while its session is in progress (the apply
    gate's rule: started, not ended, last event within 2 hours). The
    server's claims hook and the CLI both refuse a folder that overlaps
    another live claim. (2) Read only: a new event records the folder of
    `paths check`, and the server treats the folders of in-progress terminal
    sessions as claimed; the terminal flow is still refused nothing.
    (3) Leave it, and say in the README that a terminal creation and the web
    app must not target the same folder. Recommended: (2) as a first step,
    then (1).
  - *Risk.* A claim left by a session that died blocks its folder until it
    goes stale (2 hours); the refusal must name the session. The claims
    hook is part of the security model: changing what it refuses needs the
    security suite. Several processes write claims, so each session has its
    own file, written aside and renamed. Absolute paths stay in the
    briefstack home, never in events or in the repo.
  - *Tests.* The claims file: overlap, case on Windows and macOS, stale and
    ended sessions, a damaged file (unit); `paths check` and `scaffold`
    refusing a held folder and allowing it once stale or ended (CLI); a web
    creation refused the folder of a terminal session on disk (server, with
    the fake runner); the folder-claims tests as they are; an e2e with a
    fake terminal session; a real check for the user with one terminal and
    one web creation.
- **Done in backlog 1** (A7 in [PLAN-backlog-1.md](PLAN-backlog-1.md)).
  The library lock on writes that take more than 2 minutes. From
  [PLAN-phase-4.md](history/PLAN-phase-4.md), carried in
  [PLAN-phase-5.md](history/PLAN-phase-5.md).
- **Done in backlog 1** (A6): the SDK passes it; whether Claude Code sends
  the cancellation is still to be seen in a real session. Check whether the
  SDK passes the abort signal to the chat's tools. From
  [PLAN-phase-4.md](history/PLAN-phase-4.md), carried in
  [PLAN-phase-5.md](history/PLAN-phase-5.md).
- **Done in backlog 1** (A5). Turns that ended in text are counted in
  memory only, so suggestions after a server restart miss them. From
  [PLAN-phase-5.md](history/PLAN-phase-5.md).
- **Done in backlog 1** (A2). Less noise in the skills static scanner: URLs
  in license files and `localhost` URLs as `info`, `subprocess` and `socket`
  weighed by context. From [PLAN-phase-6.md](history/PLAN-phase-6.md).
- **Done in backlog 1** (A3). A portability finding for absolute Linux
  paths (`/tmp`, `/mnt`, `/home`) in skill scripts, which on Windows end up
  under the current drive. From [PLAN-phase-6.md](history/PLAN-phase-6.md).
- **Done in backlog 1** (A4: the last known values). The Usage page shows
  no figures until a creation reads the usage: show the last known values,
  or read them when the page opens. From
  [PLAN-phase-6.md](history/PLAN-phase-6.md).
- **Done in backlog 1** (A1). `tests/unit/improve-manager.test.ts`, "waits
  while a creation runs and applies once none does", sleeps a fixed 80 ms
  to check that nothing was committed; wait for a gate tick that found the
  blocker instead. From [PLAN-release.md](history/PLAN-release.md).
- An intermittent end-to-end failure on Windows CI: "Test timeout of
  30000ms exceeded while setting up "app"" in two tests of
  `tests/e2e/ui.spec.ts`, "usage › offers the user presets as cards of
  their own" (failed, retry included) and "usage › shows the last known
  plan usage …" (flaky), on the run of `db9b812` (2026-10-26, run
  40391171879), a commit that changed only documentation. The next run,
  with the same code, was green. The `app` fixture (the server and the
  page) took longer than the test's 30 seconds on that runner. To look
  at: what the fixture waits for, and whether its setup needs its own
  timeout. From [PLAN-backlog-2.md](PLAN-backlog-2.md).
- Creations and improvement sessions do not offer the `Skill` tool, so
  their model cannot invoke Claude Code's bundled skills, built-in
  plugins or synced claude.ai skills; but nothing in their settings turns
  those off. Consider giving them the task's layers too
  (`disableBundledSkills`, `disableSkillShellExecution`,
  `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `CLAUDE_CODE_DISABLE_CRON`).
  From [PLAN-phase-7.md](PLAN-phase-7.md); decisions.md, "Phase 7: skills
  that are not the project's".

## 5. Codex

To consider, not planned. (a) Generated projects: add skills-directory/
skill-codex (MIT, runs `codex exec`) through the skills library; it goes
through quarantine like any skill with scripts. The official
openai/codex-plugin-cc (Apache-2.0) is a plugin, not a skill: at most a
recommendation in NEXT_STEPS.md. (b) briefstack's own flow: an optional,
off-by-default Codex read-only review round. Writing through Codex is out:
the guard does not see Codex's writes. Delegating moves usage to the user's
OpenAI quota; it is not free, and every user would need Codex installed.

The user's goal (added in backlog 2): (c) After phase 7: in tasks and in
generation, Claude Code delegates parts of the implementation to Codex and
both build the project. Codex's writes are outside the guard, so Codex runs
in its own sandbox limited to the task's worktree, and the diff, the
declared checks and the user's approval are the control. Auth with the
user's own Codex login; usage goes to the user's OpenAI quota.

**What the spike measured (step 19, 2026-11-07, Codex CLI 0.167.0,
Windows only; decisions.md, "Phase 8: Codex spike").** Against what (c)
and the Codex brief assume:

- *Assumed: the sandbox is limited to the worktree.* Measured: for
  **writes**, yes, in both Windows modes: outside the worktree, Codex's
  file tool and the shell are both refused. For **reads**, no: a file
  outside the worktree was read in both modes.
- *Assumed (open): the worktree's `.git`, which lives outside it, may not
  be protected.* Measured: it is. Codex cannot write in the worktree's
  git folder or the repository's, so `git add`, `git commit` and `git
  tag` all fail and no ref moves. The history and the refs outside the
  task's files stay ours; the diff has to come from the worktree's
  files, which is what tasks already do.
- *Assumed: the network is blocked inside, and `unelevated` blocks it
  less.* Measured: a server on 127.0.0.1 is **reached in both modes**.
  The Internet was not tried. briefstack's own server keeps its token in
  memory and in the opened address only, so reaching it is not enough to
  use its API; other local services are open to Codex.
- *Not foreseen:* in `elevated`, the sandbox account cannot run a Node
  installed in the user's profile (nvm-windows), so Codex could not run
  the project's `npm` checks there; in `unelevated` it can.
- *Confirmed:* the ChatGPT login works headless in `codex exec`; `codex
  login status` answers on stderr (exit 0 signed in, 1 with `Not logged
  in`); the mode can be set per call with `-c windows.sandbox=...`
  without touching `config.toml`; paths with spaces and of 186
  characters work; killing the tree stops the running command and leaves
  the worktree usable; `turn.completed` carries the usage, absent when a
  call is killed; a one-step call costs about 32 000 input tokens, mostly
  cached.
- `codex sandbox -P :workspace -- <command>` runs a command in the same
  sandbox with no model call: a cheap way to tell which mode is ready.

## 6. Unattended runs that reach the user

Goal (user): define a project fully up front, leave Claude working
locally or in the cloud until the plan's usage runs out, resume on its own
after the reset, and contact the user by WhatsApp (message or call) only
when a decision is needed, so the user does not have to watch a screen.

- Up-front definition: the creation spec and phase 7 tasks; a run is a
  queue of tasks with their checks, decided before it starts.
- Running unattended: a run goes task after task; a task's diff is
  applied by rules the user set beforehand (for example checks green and
  no new shell commands) or waits for the user.
- Usage: before each step, read plan usage; at a threshold, pause and
  resume after the reset time the reading gives.
- Reaching the user: a separate project, a personal message gateway
  (notify, ask with options, receive the answer), reusable by other
  tools. Not part of briefstack: it needs an outside account, credentials
  and inbound messages, which briefstack never handles. briefstack talks
  to it through one small interface.
- Channel: WhatsApp Business Platform (business number, templates only
  outside the 24-hour window, charged per message, a Calling API).
  Unofficial personal-WhatsApp automation is out (against its terms). A
  Telegram bot is a simpler first channel: free, and long polling needs
  no public address.
- Safety: messages carry the question and its options, never secrets or
  code; only answers from the user's own number or chat count; approving
  a new shell command from the phone is off unless the user turns it on;
  an unanswered request times out to the safe choice.
- Order: after phase 7 and Codex.
- **The user's decision (2026-11-02):** the decisions and approvals are
  taken at the start; once a run is unattended, the user is not asked
  again except in extreme need; when the user has set that a diff is
  applied once some rules are met, applying it asks for no attention.
  This replaces the earlier proposal that an unattended run always waits
  for the user's approval (decisions.md, "Phase 7: M9 accepted, phase
  closed").
- **To decide when it is planned, not now:**
  - The declared checks would run on the consent given at the start: the
    session writes code that runs before anyone sees the diff, which S8
    (the checks wait for a click on the proposal page) avoids today.
  - The mitigations, to choose then: run the checks in an isolation at
    the system level with no network; apply to an integration branch, not
    the main one, so that everything stays reversible; a list of shell
    commands approved at the start; stop and notify only for something
    outside the rules, with a timeout that takes the safe choice.

  Nothing of this is built.

## 7. Open items from phase 7

Left open when phase 7 closed (2026-11-01). Steps 14 to 16 of the
cleanup (2026-11-02 to 2026-11-05) closed most of them; each item starts
with its state: **done**, **accepted** by the user, or **pending** with
the reason. The phase's plan is [PLAN-phase-7.md](PLAN-phase-7.md); its
decisions are in [decisions.md](decisions.md), "Phase 7".

Each item ends with its source, in one of three forms:

- **"Review of step NN, X"**: finding X of the review of step NN of the
  phase (once, X is an open question of that step's report). The reviews are in the user's working notes, which stay outside
  the repo and are not published, so no file is named or linked; the item
  says what the finding found.
- **A record in this repo**, by document and heading, for example
  decisions.md, "Phase 7: security review", S10.
- **Something seen while the phase was being closed**, by the step that
  saw it (for example "seen in the gates of step 12"), or the open
  warnings in the user's working notes.

### Code

- **Done in the cleanup of phase 7** (step 14, commit `8ab1a6e`: the
  saves of one task are queued in `TaskStore`).
  **The saves of one task are not ordered.** When a round's session
  starts, its session id is saved without waiting
  (`void this.options.store.save(record)` in `startRound`,
  `src/tasks/manager.ts`), and `TaskStore.save` (`src/tasks/store.ts`)
  does not queue writes per task, so that save can land after the round's
  end and leave `running` on disk. Queue the saves per task, or wait for
  that one. It is the cause of the intermittent macOS test below. Review of
  step 07, M4; review of step 10, I1.
- **Done in the cleanup of phase 7** (step 14, commit `8a55729`; a stop
  that begins during the record's own save still leaves the task as an
  abrupt stop does, which `recover()` puts back).
  **The stop is read too early before a record changes.** `startRound`
  clears `reviewed`, `validations` and `checks` and saves `running`
  before the late read of `stopping`, and between the first read and that
  change there are several awaits (`limit`, `checks.commands`,
  `inspectProject`, `projectRestrictions`). A new round refused in that
  window loses the reviewed proposal (the task comes back `interrupted`
  and needs another round); checks refused there leave the task
  `checking` until the next start. Read the flag again just before the
  record changes. Review of step 07, M2.
- **Done in the cleanup of phase 7** (step 14, commit `84d1732`; `answer()`
  answers `task.stopping`).
  **A session that is stopping can still ask.** During the task manager's
  `shutdown()`, between settling the pending requests and `handle.stop()`,
  `request()` looks only at `cancelling` and the state, so a new tool call
  opens a dialog; `answer()` is not refused either. Deny in `request()`
  while stopping, with a test. Review of step 07, M5.
- **Done in the cleanup of phase 7** (step 14, commit `a2315a8`: the
  round and the record are copied, the `checking` step too).
  **"Saved before shown" holds for the state, not for the round.**
  `onRoundDone` sets the round's `finishedAt`, `outcome`, `summary`,
  `error` and `commit` on the record in memory before the save, and
  `next = { ...record }` shares `rounds`: the view and the stream can show
  the finished round while the disk is behind. Actions are not affected
  (they refuse `running` and `checking`), but the comment above the save
  says more than that. Copy the round too, or narrow the comment. Review
  of step 07, M3.
- **Done in the cleanup of phase 7** (step 15, commit `6124ab4`:
  `POST /api/tasks/:id/checks/cancel`, from a button shown while they run).
  **Cancelling the checks from the proposal page.** Running checks end only
  with a server stop (or their 10-minute timeout per command). Review of
  step 05, M2.
- **Done in the cleanup of phase 7** (step 15, commit `cce7fdd`: the
  proposal's actions share one busy state on the page).
  **The checks button while another proposal action runs** is not
  disabled; the server's lock per task already makes the actions wait for
  each other. Optional in the review of step 05, I2; left out in
  decisions.md, "Decisiones sin Dani (fase 7)", M8b.
- **Done in the cleanup of phase 7** (step 15, commit `43ea994`: a
  `notShown` warning for each, which does not stop the approval; errors
  and warnings are now capped apart).
  **Files the proposal page cannot show** (over 256 KB, binary files,
  links) are listed by name only; a warning for any of them was proposed.
  decisions.md, "Phase 7: security review", S10.
- **Done in the cleanup of phase 7** (step 15, commit `aa90a18`: the
  task's line goes under today's heading when it is the note's last one;
  other library additions keep one heading each).
  **Two equal date headings in a project's note** when a task is applied
  and reverted on the same day: `appendDated` (`src/library/notes.ts`)
  puts today's heading before every addition. Review of step 08, M9; seen
  again in the real run of step 11.
- **Done in the cleanup of phase 7** (step 16, commit `156714a`: the
  confirmation closes for good when the task leaves `checking`).
  **The cancel confirmation of the checks came back by itself**: left
  open while the checks ended, it showed again on the next run without a
  click. Review of step 15 of the cleanup, M1.
- **Pending, planned with §6.** **Applying unattended "with checks
  green"** clashes with S8: the declared checks run only after a click on
  the proposal page. The user
  decided on 2026-11-02 how unattended runs are approved; what that leaves
  open for the checks is in §6, "To decide when it is planned". Review of
  step 05, the report's open question.
- **Pending: the user kept it in the backlog (2026-11-05).** **The secret
  and path scans are slow on long lines.** `findSecrets`,
  `findAbsolutePaths` and `maskSecretValues` take time that grows with the
  square of a line's length (measured: about 1.8 s, 1.7 s and 3.7 s for one
  line of 64 KB). The validations scan files up to 1 MB and the proposal
  page masks files up to 256 KB, so a long one-line file (a minified
  bundle) makes a round's end and the page slow. Make the scans linear
  without changing what they find. Seen in step 15 of the cleanup.
- **Pending: minor, not pursued** (the rule of the cleanup: only
  important or blocking findings open work).
  **What the review of step 14 of the cleanup left, all minor:**
  `reply()` is not refused while the task manager stops (a reply reaches
  only the session the stop is ending; M11); a command the user allowed
  for the whole task is still allowed during a stop, which the commit
  message of `84d1732` does not say (`api.md` is exact; M4); `startRound`
  still changes the session id and `running` in memory before saving them
  (M4); `newRound` and `runChecks` load a task into the server's memory
  before the late read of the stop, harmlessly (M3). In the tests: no test
  fixes the `failed` path of `onRoundDone` (M12); the ordering test of
  `tests/unit/tasks-store.test.ts` waits a fixed 50 ms (M1), and its
  "failed save" test fails before the queue, so a write that fails inside
  the queue is not tested (M2); the guard test of
  `tests/unit/tasks-manager.test.ts` polls for any `tool.denied` line, not
  the guard's (M5); the I2 tests keep fixed waits of 300 and 500 ms (M6).
  Review of step 14.
- **Pending: minor, not pursued** (the same rule).
  **What the review of step 15 of the cleanup left, all minor:** two
  paths of cancelling the checks have no test, the 15-second limit
  (cancelling goes on with the process maybe alive, and the old
  `checkWith` must return without writing) and checks that end while the
  cancel arrives (M2); past 50 warnings the cap drops `notShown` warnings
  without saying so on the page, so "a warning for each file" does not
  hold then (M3); `unshown` starts up to four more git processes per file
  besides the two of `blob()`, and does not stop at the cap, which slows
  a round's end on large diffs on Windows (M4); the warning's texts are
  written twice, once per language, and no e2e test goes through the
  Spanish page (M9). Review of step 15.

### Tests

- **Done in the cleanup of phase 7** (step 14, commit `8ab1a6e`: the
  ordered saves, and the test waits for the session id's save to be asked).
  **Intermittent on macOS:** `tests/unit/tasks-manager.test.ts`,
  "TaskManager: after a server stop › marks tasks the last server left
  running as interrupted", failed once in CI (run 41315930066, on
  `666fa66`, a commit that changed only documentation; the runs after it
  were green): it read `running` where `interrupted` was expected. A race
  between the test and the unordered save above, which the test does not
  wait for. Review of step 07, M4; review of step 10, I1.
- **Done in the cleanup of phase 7** (step 14, commit `0e43e2e`: the test
  polls for the line, with a deadline).
  **Intermittent locally on Windows:** `tests/unit/tasks-manager.test.ts`,
  "TaskManager: shell commands and questions › asks questions, and a write
  outside the worktree is denied by the guard", failed once (2026-11-01):
  the session's `events.jsonl` held `tool.pre` for the write but not yet
  the guard's `tool.denied` line when the test read it. The test reads the
  file without waiting for that line. Seen in the gates of step 12 (a
  commit that changed only documentation); the next run passed.
- **Done in the cleanup of phase 7** (step 14, commit `0e43e2e`: approving
  is pinned as `task.wrongState` with `checking`; the 10 repetitions were
  runs of a step's report, not part of the tests, so nothing was removed).
  **The R2 tests** (`tests/unit/tasks-run-checks.test.ts`, "… is on disk
  before an action can see it (R2)"): after the fix the `fulfilled`
  branch of `expectOneOrder` is never reached, so approving is not pinned
  as refused; pin `task.wrongState` with `checking`. Their 10 repetitions
  add nothing, the result being deterministic. Review of step 07, M6.
- **Done in the cleanup of phase 7** (step 14, commit `0e43e2e`: a spy on
  the checks' runs; each I2 test pins the order it forces; all three call
  `recover()`).
  **The I1 and I2 tests:** the route test of I1
  (`tests/unit/server-tasks.test.ts`) infers that nothing ran from the
  task's state, not from a spy; the first I2 test forces the order but its
  `expectOneOrder` accepts either outcome; the I2 tests use a new manager
  rather than `recover()` (the same today). Review of step 06, R5.
- **Done in the cleanup of phase 7** (step 16, commit `61fc0c2`: fake
  improvements, a skill service over a fake GitHub, a project and a
  running creation, so the test fails if any tool is refused; the
  importers' reading finds those forms, bare imports and any dynamic
  import whose target is not a plain string; the pure helpers stay
  exported, since `tests/unit/tasks-checks.test.ts` tests them).
  **The reach of the checks invariant**
  (`tests/unit/tasks-checks-invariant.test.ts`): four read tools
  (`list_suggestions`, `list_proposals`, `show_proposal`, `list_skills`)
  and four action tools (`cancel_creation`, `prepare_improvement`,
  `add_skill`, `add_skill_to_project`) are refused before doing their work,
  since the test has no improvements or skills; give it fakes of both. Its
  pattern for importers misses `import X, { Y } from`, double quotes and
  `import()` with a template. `src/tasks/checks.ts` still exports pure
  helpers that only tests use. Review of step 06, R4.
- **Done in the cleanup of phase 7** (step 16, commit `5659302`: it polls
  for the turn's end). **Intermittent locally:**
  `tests/unit/creation-fake-runner.test.ts`, "ends a turn with a message
  …", read the last event after a fixed 30 ms and got `running` once
  (the session's start is written to disk before the turn ends). Seen in
  the gates of the close of step 15 of the cleanup.
- **Done in the cleanup of phase 7** (step 18, commits `88337c6` and
  `324e772`: the test's clock for the quiet waits, and a condition
  instead of a fixed time). **Intermittent locally:**
  `tests/unit/creation-sdk-runner.test.ts`, "keeps waiting while messages
  keep coming after a result …", found the session closed (`fake.closed`
  `true`, line 824) once, in the gates of the close of step 15 (on
  `af5c4b0`). Cause shown: the test sent a message every 40 ms with real
  timers against an 80 ms quiet wait. With random synchronous stalls of
  the event loop (up to 150 ms, as a loaded machine causes), Node fired
  the 80 ms timer before the 40 ms one created in the same millisecond,
  logged in a probe, and the test failed in 113 of 300 repetitions. CPU
  load alone (a busy worker per core) did not reproduce it in 15 runs of
  the file. The same probe, 20 repetitions per test, also failed "does
  not run while the spec approval waits" (17 of 20: the tool reads the
  disk before it asks, inside a 30 ms wait) and
  `tests/unit/creation-manager.test.ts`, "streams the session.end …"
  (3 of 20: `session.end` was written a fixed 150 ms after
  `session.finished`, and the manager read both lines in one go). The
  three are fixed and pass the probe 20 of 20.
  **Left as they are, noted only:** three tests of the same file that
  look alike passed the probe 20 of 20, so no defect was shown: the reply
  sent after a 20 ms `tick()` against a 60 ms wait ("sends a free-text
  reply …"), the 120 ms pause against the 250 ms wait with a background
  agent ("waits much longer …"), and the fixed 20 ms `tick()` before the
  first hook ("claims the first session id …"), which would fail if the
  runner's reading of its folders took longer than that. Robust by
  reading: the question and permission tests (the wait is cleared in the
  same tick as the request), the polling loops with a bound, and the
  other `creation-*` files (they poll with a deadline, or their fixed
  waits only make a negative check weaker).
- **Done in the cleanup of phase 7** (step 16, commit `209384f`: a comment
  in the test). **The warning `BRIEFSTACK_LIBRARY_LOCK … EPERM`** that a
  passing test logs is `tests/unit/library-lock.test.ts`'s own: the test
  makes the lock's removal fail on purpose and Node prints the warning it
  checks. It is in each of the 20 Windows CI logs read (2026-10-30 to
  2026-11-02); run alone, the file's other tests print nothing. Not a lock
  failure of the machine.
- **Pending, no cause shown: step 16 used about 20 minutes of the two
  hours set for it and none of its two test pushes.** **Intermittent on
  Windows CI: e2e tests that pass 30 seconds, most while setting up the
  `app` fixture.** Seen in 4 of
  the 20 Windows runs read (2026-10-30 to 2026-11-02), each passed on its
  retry: `tests/e2e/security.spec.ts:31` (in setup), `auth.spec.ts:25` and
  `:45` (in setup, the run's first two tests), `tasks.spec.ts:227`
  (waiting for the page's menu), `ui.spec.ts:422` (the Usage page);
  before them, the skills pages (the phase's open warnings) and the Usage
  tests of §4 (run 40391171879), possibly the same kind. A fifth run
  had another kind: `creation.spec.ts:171` waited the 5 s of `expect` for
  the spec screen (8.3 s in all; its retry passed in 3.8 s). Also
  `tests/e2e/several.spec.ts:121` locally, once (`locator.click` on the
  menu's "New project" link at 30 s; seen in the gates of step 14; review
  of step 14, M7), and `tests/unit/library-lock.test.ts` locally, once
  (the failing test is not known; 20 runs of the file in step 16 passed).
  What was measured: the e2e tests take 3.5 s at the median on the
  Windows runner (p90 8.6 s, p99 18.8 s, 2138 passing tests) against
  1.2 s on Linux (p90 2.8 s, max 8.5 s, 6 runs); `security.spec.ts:31`,
  which is nearly all fixture, takes 0.2 s on Linux, 1.3 to 3.3 s on the
  Windows runner when it passes first, and 0.9 to 1.3 s on a Windows 11
  desktop. The retries of the 30 s failures took 4.7 to 18 s.
  A hypothesis the data fit, not a measured cause: the Windows runner
  slows down as a whole for a minute or so, and the fixture, which every
  test runs, passes 30 s first. For it: in two of the four runs, other
  tests next to the failure (two workers) took the longest each took in
  the 20 runs (around `security.spec.ts:31`: 30.6 and 24.1 s, against
  medians of 3.3 and 2.1 s; around the Usage test: 16.9, 21.6 and 27.9 s,
  against 3.2, 5.4 and 4.0 s). Against it, or weaker than it looks: in
  the auth run, the only slow tests were the two failures (30.1 s each)
  and their retries (12.8 and 13.0 s), and the next ones took 3.1 to
  4.3 s; around `tasks.spec.ts:227`, the neighbours took their usual
  time (7.4, 10.8 and 8.6 s, against medians of 6.8, 10.7 and 9.6 s); and
  on Linux `security.spec.ts:31` is not always 0.2 s (1.2 s in run
  41464978588). Not the usual cost of a cold start of the workers (the
  first four tests take 1.9 to 7.5 s in the other 19 runs). Unlikely by
  reasoning, not measured: the library lock (a lock this process failed
  to remove is taken over at once, `src/library/lock.ts`; the EPERM
  warning is the test's own, above), and one test's own code (the
  failures are in different files). A higher limit for Windows CI might
  stop the retries; whether 60 s is enough is not known, since the
  failed attempts were cut at 30 s. It was not set, as step 16 forbade it
  without a measured cause; the retry keeps CI green and shows each case
  as flaky. Still to measure: the fixture's steps timed one by one on the
  Windows CI runner, with at most two test pushes (a probe outside the
  repo was refused by the session's permissions in step 16); that would
  confirm or discard the hypothesis. Also to look at: whether the
  runner's antivirus scans the temp folders and the git processes the
  fixture starts (two git repositories and several commits per test), and
  a fixture that copies a prepared folder instead of running git for
  each test.

### Real checks (`scripts/real/`)

- **Accepted** (decisions.md, "Phase 7: M9 accepted, phase closed").
  **Layer 6 of the task guard** (it refuses a `Skill` call for a skill
  that is not the project's) is shown by unit tests only: in real
  sessions Claude Code refuses those calls first, through the SDK `skills`
  option (check 5 in decisions.md, "Phase 7: M9 real checks"). Showing it
  in real needs a skill Claude Code lets the model call while the task's
  layers keep it out. Review of step 08, I2; review of step 10, M3.
- **Accepted** (decisions.md, "Phase 7: M9 accepted, phase closed").
  **The real sessions of M9 ran on Windows only** (Windows 11, Claude Code
  2.1.316); macOS and Linux are covered by CI over the fake runners.
  decisions.md, "Phase 7: M9 real checks".
- **Done in the cleanup of phase 7** (step 16, commit `223e1d2`: checks 3
  and 4 print it as `NOT CONTROLLED`, and decisions.md, "Phase 7: M9 real
  checks", records it; adding `'local'` to the control session's
  `settingSources` could control it in a later run).
  **`settings.local.json` in checks 3 and 4 has no control:** the control
  session loads `settingSources: ['project']`, which does not read the
  local file, so for it only the hiding in the worktree is shown. Review of
  step 08, M2.
- **Done in the cleanup of phase 7** (step 16, commit `223e1d2`: check 4
  prints it as `NOT CONTROLLED`, recorded in decisions.md as above).
  **Check 4 has no control** that the broad allow rules work without the
  task's layers. By H0, allow rules are not used in SDK sessions, so such a
  control may not be possible; the script should say so. Review of step
  08, M3.
- **Done in the cleanup of phase 7** (step 16, commit `223e1d2`).
  **`startWeb(…, runner?)`** in `scripts/real/tasks-common.ts` takes a
  runner that no script passes (it served rehearsals outside the repo).
  Review of step 08, M4.
- **Done in the cleanup of phase 7** (step 16, commit `223e1d2`: the same
  registration rules, counted in code, and a helper's own: no check of
  its own, no exit, the caller's check first).
  **The structural test of the real scripts**
  (`tests/unit/real-scripts.test.ts`) skips `tasks-common.ts`; holding it
  to the same rules would be stricter. Review of step 08, M5.
- **Done in the cleanup of phase 7** (step 16, commit `223e1d2`: `within`,
  two minutes, and the task's reading after the round too).
  **Waits without a limit:** `controlSession` awaits the context reading
  with no deadline (`scripts/real/tasks-common.ts`), and so does the
  `beforeFinish` of check 5 (`scripts/real/check-task-skills.ts`); a
  missing answer hangs the script instead of failing it (it can never pass
  by it). Race them with a deadline that fails. Review of step 10, M4.
- **Done in the cleanup of phase 7** (step 16, commit `223e1d2`).
  **(c) of check 5 counts any skill that is not the project's, by name,**
  not only bundled ones (source `built-in`) as its step asked. The result
  of the run is the same (the 13 were all `built-in`); require the source
  if it runs again. Review of step 11, M1.
- **Done in the cleanup of phase 7: checked, no line to add** (step 16,
  docs read 2026-11-05, recorded in decisions.md, "Phase 7: M9 real
  checks": the commands reference lists `/design` as a skill, but no
  sentence says it stays typable or is hidden from the model when bundled
  skills are off). **The `design` observation of check 5** has no line in
  the skills docs, which mention `doctor` only; it rests on the control's
  init listing it too. Review of step 11, M2.

### Not listed here

- **Findings already closed:** fixed in a later step of the phase,
  accepted by the user, or checked and found true. Their records are in
  decisions.md, "Phase 7" and "Decisiones sin Dani (fase 7)".
- **Findings about the step reports** (outputs not saved, CI quoted as
  extracts, a diffstat, gates not run on a commit's exact tree): they are
  about the user's working notes, not about briefstack, and past evidence
  cannot be redone.
- **The user's own working setup** outside the repo (the notes and tools
  that drive each step, empty folders left on the user's machine after the
  move of 2026-10-30): not part of briefstack.
- **The other option of the review of step 07, M1:** setting the stop flag
  when `briefstack web` begins to stop, before the improvements and the
  chat. The finding was fixed in [api.md](api.md) instead, and the current
  order is safe: the task manager's stop ends or aborts the work the task
  routes accepted in those seconds.
