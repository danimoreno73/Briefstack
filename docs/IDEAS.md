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

**Brief in phase 7.**

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
