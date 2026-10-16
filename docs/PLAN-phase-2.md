# briefstack — Phase 2 plan

Approved plan for phase 2. Scope comes from
[BRIEF-phase-2.md](BRIEF-phase-2.md). This file records how it will be built
and every decision taken while planning. Verified behaviour goes in
`docs/decisions.md`. The phase 1 plan is
[PLAN-phase-1.md](PLAN-phase-1.md).

Starting point: tag `phase-2-start`. Work happens on `master` in small
commits, one concern each.

## 0. Status

Updated 2026-10-15 (H6 closed, verified in real runs). A new session reads `CLAUDE.md`,
`docs/BRIEF-phase-2.md`, this file and `docs/decisions.md` from
"# Phase 2" onwards before continuing.

### Done

| # | What exists now |
|---|---|
| H0 | Docs read and 8 real SDK probes (`decisions.md`, "Agent SDK and policy", "H0 probes", "Design after the H0 checkpoint"). Section 3 reflects the approved changes: guard hook, cancel without `interrupt()`, the server records the end and kills the process tree, a `result` is not the end, `strictMcpConfig` |
| H1 | `briefstack web` on 127.0.0.1 with Host, token and Origin checks; UI built by `tsc -p tsconfig.ui.json` into `dist/web` (Preact with an import map, strict CSP); `@playwright/test` 1.61.1 (chromium 1228 already installed); SDK 0.3.286 pinned; installed `claude` lookup with a compatibility warning (`src/creation/claudeBinary.ts`) |
| H2 | Project notes get optional `created` and `session` fields (`library add projects … --session <id>`); `listProjects`, `listSessions`, `sessionTimeline`, `saveNote`, `addNote` with `text`, `libraryHistory`, `revertLibraryCommit`, `usageShow`/`usageSet` (moved out of `cli.ts`), `permissionPolicy`, `setProjectsDir` |
| H3 | Read routes in `src/server/read.ts`: projects (with detail, timeline, `NEXT_STEPS.md`/`INSTRUCTIONS.md`), sessions, library index/notes/note/history, usage (with presets), paths, settings; secret lines redacted; documented in `docs/api.md`. `startWebServer` takes `pathEnv` and `repoDir` |
| H4 | Write routes in `src/server/write.ts`: `PUT /api/library/note` (`saveNote`; a note with a secret is a 400 and nothing is written or echoed), `POST /api/library/revert`, `PUT /api/usage`, `PUT /api/settings` (`projectsDir`, `lang` or `null`, `permissionPolicy`). Revert errors map to 404/409. Documented in `docs/api.md` |
| H5 | `CreationRunner` interface (`src/creation/types.ts`), `FakeRunner` with recordings (`tests/fixtures/recordings/`), `CreationManager`, creation routes and the SSE stream (`docs/api.md`) |
| H7 | UI in `src/ui/` (hash router, started after the token leaves the address): projects (list, detail, timeline, copy buttons, the open command with the path in quotes, interrupted and cancelled creations apart), library (browse, editor with preview, history, revert behind a confirmation dialog), usage (3-level slider and a selector for user presets, warnings), settings (`projectsDir`, language, policy, paths). Strings in `src/i18n/ui.ts`. `markdown-it` 15.0.1 is vendored (`/vendor/markdown-it.mjs`). Secrets: the secret detector moved to `src/validate/secrets.ts` (no imports) so the preview hides secrets with the server's own code; a note loaded with `[redacted]` lines cannot be saved until they are removed. `setProjectsDir` now runs `inspectOutputDir` with the shared `protectedDirs` (the check of `paths check`): a folder around or inside the repo or the library, or a file, is refused; a folder that does not exist yet is created. Playwright is set up (`playwright.config.ts`, `tests/e2e/fixtures.ts` starts a server per test over temp folders and the fake runner, with seeded library, projects, sessions and a user preset); 17 e2e tests |
| H8 | Creation UI in `src/ui/creation.tsx` (`#/new`, `#/new/<id>`): idea form; live progress from the stream (`progress.ts`); question form with the recommended option preselected and free text (`answers.ts`); permission panel (not modal, so Cancel stays reachable); spec approval (approve, change with text, cancel) over `GET /api/creations/:id/spec`; folder grant confirmation; result with the project card (found by the session id), and denied requests; Cancel always visible and asks first; the active creation reopened on `#/new` and marked in the menu; one active creation, with a link to it. Settings says before saving that a missing projects folder will be created (`GET /api/paths/check`). Secrets are hidden in permission and denial summaries by the manager as well |
| H9 | Playwright e2e over the fake runner, 38 tests: `ui.spec.ts` (start-up and F5, projects, library edit and revert, secrets, usage, settings), `creation.spec.ts` (whole creation, change at the spec, cancel in three places, close and reopen the tab, second start, permissions under `ask` and `unattended`, folder grant, secrets in a request, Spanish), `security.spec.ts` (wrong Host, missing or wrong token, cross-origin and cross-site writes, a page from another origin, framing). Recordings added: `working`, `permissions`, `grant` |
| H6 | Guard, web MCP tools, `SdkRunner`, process-tree kill, wiring into `briefstack web`, skill and agent changes. After the guard review (`decisions.md`, "Guard review"): wider protected folders, no writes in `.git` and no git hooks or fsmonitor in `commit`, a closed tool list, web for the researcher only, `approve_spec` after symlinks, no hooks in a generated `settings.local.json`, effort read from hook inputs. **Verified in real runs** (2026-10-15): `check-guard-auto` 10 PASS, `check-kill-tree` PASS, `check-effort` PASS for `low` and `high` (see "H6 status") |

Build and lint are clean, 521 vitest tests and 38 e2e tests pass on
Windows. CI runs on Linux only for each push; the full matrix runs by
hand. `npm run test:e2e` builds the UI first; `npm run build` also
type-checks `tests/e2e`.

### Left, in order

H10 (section 5 has its verification). It spends the user's plan and is for
the user to launch.

**Next: H10**, the real run from the browser (step 5 of "Real runs" below).
Nothing is pending in code.
The e2e fixture (`tests/e2e/fixtures.ts`) holds a `CreationManager` over the
fake runner; `appOptions` picks the recording (or builds one at run time),
the permission policy and the language.

### Plan for H6, code only (autonomous run, 2026-10-15)

The user is away and approved H6 (code only), H8 and H9 in advance. No real
SDK session and no `claude -p` is run: the three real checks, the effort
check with Sonnet and H10 are prepared as scripts (below, "Real runs").

- **Guard** (`src/creation/guard.ts`): pure logic plus a `PreToolUse` SDK
  callback that only `SdkRunner` registers. It is not in any settings file,
  so ordinary sessions in this repo never see it; it also passes through any
  hook input whose `session_id` is not the creation's own.
  - Writes (`Write`, `Edit`, `NotebookEdit`): allowed only inside
    `projectsDir`, the session folder and folders granted to this session;
    everything else is denied (relative paths, `..`, symlinks resolved,
    other drive, `/c/...` forms).
  - Shell (`Bash`, `PowerShell`): only `npm run --silent briefstack -- <sub>`,
    no operators, parsed token by token. Per caller: main session `event`,
    `paths`, `usage show`, `library context|add`, `spec check`,
    `validate`, `commit`; `generator` `scaffold` and `validate`;
    `reviewer` `validate`; any other agent nothing.
  - Researcher: `WebSearch`/`WebFetch` allowed. After a cancel: everything
    denied except `briefstack event` from the main session.
  - A denial is recorded as a `denial` runner event (listed on the result).
- **Web tools** (`src/creation/webTools.ts`): in-process MCP server
  `briefstack-web` with `approve_spec` and `grant_directory`.
- **SdkRunner** (`src/creation/sdkRunner.ts`): `query()` injected so tests
  use a scripted fake. Options from `buildQueryOptions` (pure, tested):
  repo `cwd`, `settingSources` project+local, user's `claude`, profile
  model and effort, `permissionMode: 'auto'`, `strictMcpConfig`, a clean
  environment, `additionalDirectories`, streaming input, hooks and
  `canUseTool`. Process tree killed through `spawnClaudeCodeProcess`
  (`taskkill /T /F` on Windows, process group elsewhere). The runner ends
  itself after 15 minutes without messages following a `result`; otherwise
  the manager stops it after `session.finished`.
- **Wiring**: `briefstack web` builds the manager with the real runner;
  tests inject `creationRunner`. Creation routes stop answering 503.
- **Skill**: `--session` on `library add projects`; `approve_spec` and
  `grant_directory` when the tools exist, else exactly today's text. Test
  that the steps and `event` calls are the same on both branches.
- **Agents**: "read-only commands" removed from generator and reviewer.
- **Secrets** in permission summaries pass through `redactSecretLines`.

### H6 status (2026-10-15): closed, verified in real runs

Done and tested without a real session:

- `src/creation/guard.ts`, `webTools.ts`, `sdkRunner.ts`, `processTree.ts`,
  `wiring.ts`; `briefstack web` builds the manager (real runner unless
  `CliIO.creationRunner` is set); the skill and the two agent bodies;
  permission summaries pass through the secret redactor.
- The guard **denies** (it does not `ask`) writes outside the allowed folders
  and shell commands outside the caller's list (user decision, 2026-10-15,
  replacing the 2026-10-14 `ask`). What it passes goes to the permission mode
  and `canUseTool`. See `decisions.md`, "H6 design".

The user ran the three real checks on 2026-10-15, after the guard review,
and all passed:

- `check-guard-auto.ts`: 10 PASS. Denied by the guard: `echo hello`, the
  write outside the projects folder, the main session's `WebFetch` (it never
  reached `canUseTool`), the write in `.git` and `Monitor` (no file left, its
  command never ran). The write inside the projects folder went through, and
  `AskUserQuestion` reached `canUseTool` and its answer came back.
- `check-kill-tree.ts`: PASS (run before the review; nothing it uses changed).
- `check-effort.ts`: PASS for `low` and `high`, read from a `Stop` hook.

H10 is the real run from the browser.

#### Real runs (checks 2 to 4 passed on 2026-10-15; H10 is next)

Every script needs `--yes`, works in a temp folder it creates (with its own
temp `BRIEFSTACK_HOME`) and deletes it, prints the plan usage (5-hour and
7-day windows) before and after, and ends with PASS or FAIL lines. Run them
from PowerShell in the repo, in this order:

1. `npx tsx scripts/real/preflight.ts` — reads only: resolved paths, claude
   version, API-key variables, clean repo and library, plan usage. Costs
   nothing.
2. `npx tsx scripts/real/check-guard-auto.ts --yes` — haiku, about seven
   tool calls. Checks that under `auto` mode the guard denies `echo hello`, a
   write outside the projects folder, a main-session web fetch, a write in a
   `.git` folder and `Monitor`, lets a write inside through, and that
   `AskUserQuestion` reaches `canUseTool` and gets its answer back.
3. `npx tsx scripts/real/check-kill-tree.ts --yes` — haiku, one tool call.
   Starts a command that sleeps two minutes, then ends the tree as the server
   does on stop and checks no process is left.
4. `npx tsx scripts/real/check-effort.ts --yes` — two one-word Sonnet turns
   (`low` and `high`). Compares the effort a `Stop` hook input reports with
   the requested one (the init message of an SDK session carries none).
5. `npx tsx scripts/real/check-subagent.ts --yes` — haiku, one subagent that
   reports one word. Checks that, with the runner's options and environment,
   the Agent call runs in the foreground (not "Async agent launched"), the
   subagent's word reaches the main session, the guard denies nothing (so `SubagentHandback` goes through) and the main
   session runs no shell command while it waits. Added after the first H10
   run failed (`decisions.md`, "H10 run 1").
6. H10, after the four checks pass and the user has seen their output:
   - `npm run build`
   - `npm run briefstack -- web` (with `BRIEFSTACK_HOME` as the user has it
     set, i.e. the real data), open the printed address, and create one
     project from the browser through the whole flow.
   - Afterwards look at Projects (the new project with its timeline) and
     `git -C <library> log` for the project note and the session log.
   - The user accepts it; phase 2 is not done before that.

If a check fails, stop and read `decisions.md`, "H6 design", before changing
the guard: each rule there has a reason.

### Plan for H8 (autonomous run, 2026-10-15)

UI of the creation flow over the existing creation routes and stream; manual
checks are replaced by the H9 e2e over the fake runner.

- **Server additions** (small, documented in `docs/api.md`):
  - `GET /api/creations/:id/spec`: the spec summary (secrets redacted) and
    a few fields of `spec.json`, for the approval screen. Only files the
    creation itself asked about, inside its session folder.
  - `GET /api/paths/check?dir=`: what `paths check` says about a folder, so
    Settings can warn that a missing projects folder will be created.
  - The manager redacts secrets in permission and denial summaries too.
- **Screens** (`#/new`, `#/new/<id>`): idea form; progress list (steps and
  the agent working now); question form (recommended option preselected plus
  free text); permission dialog (exactly what is asked, allow or deny); spec
  approval (approve, change with text, cancel); folder grant confirmation;
  result (project link, next steps through the project page, denied requests
  under the `unattended` policy). Cancel is always visible and asks first.
- **Reopening the tab**: `#/new` finds the active creation and shows it;
  the stream resumes from the last `seq`. A second start says there is one
  running and links to it. The nav marks a creation in progress.
- **Settings**: a note under the projects folder field when the folder does
  not exist; the permission policy is shown on the creation too.
- **Strings**: `src/i18n/ui.ts`, en and es, with the same-keys test.
- **Tests**: unit tests for the pure parts (SSE parsing, progress from
  events, answers from the form) and for the new routes; the browser flow is
  H9.

### How to work from here (user decisions, 2026-10-14)

- One milestone per session. Build, lint and tests must pass, then
  commit, push, update this Status section, and stop so the user can
  run `/clear`.
- H3, H4 and H7 are done with `opusplan`, one after another, in the main
  session. No parallel worktrees.
- Real Claude Code sessions (H6, H10) spend the user's plan.
  - Tell the user first, and report usage before and after.
  - Read usage with the SDK's `usage_EXPERIMENTAL_…()` from a session
    that sends no message (`decisions.md`, "H0 probes").
- Never launch `claude` from Git Bash with a `/…` argument: it becomes a
  path. Start probes from Node, through PowerShell.
- Probes:
  - Use temp folders the probe creates, and delete them with retries.
    Windows keeps the folder locked for a while after `close()`.
  - Never use the real library or the repo as the working folder.
  - Stop leftover processes.

### Before publishing the repo

- Check the policy on subscription use from third-party apps again
  (`decisions.md`, "Subscription use from third-party apps"). Today the
  tool relies on the user's own login, for personal use only.

## 1. Doubts about the brief (answered 2026-10-14: every proposal accepted, with the notes in "User adjustments")

1. **Playwright "already installed".** Only the browsers are on this machine
   (`ms-playwright/chromium-1228`). There is no `@playwright/test` in the repo
   or global npm. Proposal: add `@playwright/test` as a dev dependency, pinned
   to the release that uses chromium 1228, so nothing new is downloaded.
2. **Spec screen and folder grant need a channel the skill does not have.**
   Today the skill asks approve/change/cancel in plain text and tells the user
   to type `/add-dir`. The browser can't type a slash command, and a dedicated
   spec screen needs to know "this is the spec approval".

   Proposal: the server gives web sessions an in-process MCP server
   (`briefstack-web`) with two tools:
   - `approve_spec(specFile, summaryFile)` returns `approve | change(text) | cancel`;
   - `grant_directory(dir)` shows a confirmation in the UI and grants the folder
     for this session only. The grant is never written to any settings file
     (user decision, 2026-10-14).

   The skill uses these tools when they exist, and otherwise behaves exactly as
   today, so the CLI path does not change. This is an I/O channel, not a second
   copy of the flow.
3. **Project list "name" and "creation date"** do not exist in project notes,
   which only have `slug` and `updated`. Proposal:
   - `library add projects` writes two new optional fields when it creates a
     note: `created` and `session` (the creation session id).
   - The name is the note's first `#` heading, falling back to the slug.
   - Older notes without `created` use the date of the note's first library
     commit.
   - `session` is what links a project to its creation timeline.
4. **"Date heading rules" when editing a note.** These rules were written for
   appends. Proposal:
   - If the edit only adds text at the end, the added part gets a
     `### YYYY-MM-DD` heading, as `library add` does.
   - Any other edit is saved as a full rewrite.
   - In both cases: secret check, project-status validation for notes in
     `projects/`, `INDEX.md` update, one commit.
5. **UI language.** Proposal: reuse the config key `lang`, so the CLI follows
   too. The alternative is a separate `uiLang`.
6. **Changing `projectsDir` from Settings.** Proposal: also add the new folder
   to `.claude/settings.local.json` (the same merge `init` does) and keep the
   old one.
7. **Opening the browser.** Proposal: `briefstack web` prints the URL, with the
   per-launch token in the fragment, and does not open a browser itself. That
   avoids a platform-specific shell command.

### User adjustments (2026-10-14)

- **Doubt 2:** the skill keeps one flow logic. With or without
  `briefstack-web`, the steps it runs are the same. The only difference is
  where two answers come from: the spec approval and the folder permission.
  The skill test checks this.
- **Doubt 7:** the URL is printed alone on its own line, so it is easy to copy.
- **Default port taken:** a clear error that suggests `--port 0`.
- **Unattended policy:** denied requests are also shown on the creation's
  result screen, not only in the history.

## 2. Docs and behaviour to verify (H0, brief §8)

Each result goes into `docs/decisions.md` with source URL, date and
conclusion. Probes are small real SDK sessions on the cheapest model, run in
temp folders the probe creates. They use the user's login, so they spend a
little of the plan, and the user is told before they run.

1. The TypeScript SDK runs the project skill `/new-project`, the project
   agents, hooks and settings. Check which `settingSources` are needed, whether
   `${CLAUDE_SESSION_ID}` is substituted in the skill, and whether the SDK's
   `session_id` equals the hooks' `session_id`.
2. `AskUserQuestion` and permission requests reach `canUseTool` in the main
   session, including permission requests from subagents. The callback can
   wait for the browser. Find the documented defer mechanism for long waits,
   and whether a held callback times out.
3. The SDK uses the existing Claude Code login and no API key, on Windows.
   Check how it finds or bundles the Claude Code binary
   (`pathToClaudeCodeExecutable`, native `claude.exe` in `~/.local/bin`).
4. How to give one session an extra writable folder at run time:
   `addDirectories` permission updates with session destination, versus a
   `Query` control method, versus `additionalDirectories` at start only.
5. The `model` and `effort` options (or their equivalent) in the SDK.
6. Hooks still write `events.jsonl` from an SDK session. Check whether
   `SessionEnd` fires on abort and on server stop, and with which `reason`.
7. Re-read the policy on subscription use from third-party apps (the help
   article from 2026-10-07 and the Agent SDK docs) and note any conflict.

Extra items this design depends on:

8. `permissionMode: 'auto'` exists in the SDK and works on Windows, plus any
   plan or model requirements.
9. Allow-rule syntax for path-scoped `Write`/`Edit` (`projectsDir`, session
   folder) through `allowedTools` or settings.
10. In-process MCP tools (`createSdkMcpServer`): the tool name as the skill
    sees it, and whether the main session can call them while a skill runs.
11. Cancel: whether `interrupt()` stops a turn without cutting a write in half,
    and whether a follow-up message (streaming input mode) can then ask the
    skill to close as `cancelled`.

**Checkpoint:** after H0, stop and show every finding that changes the design.
If subscription use does not work in practice, stop and ask (brief §2).

## 3. Decisions

### Stack

- **Server:** `node:http`, no framework. There are few routes, and the
  security checks are a few lines of our own code. A framework would add
  dependencies without removing much work.
- **Runner:** `@anthropic-ai/claude-agent-sdk`, pinned to a version at least
  two weeks old.
- **UI:** Preact with TSX compiled by `tsc` (no bundler).
  - A separate `tsconfig.ui.json` with `lib: dom` and `jsxImportSource: preact`.
  - An import map points `preact`, `preact/hooks` and `preact/jsx-runtime` to
    files in `node_modules/preact/dist`, served by the server.
  - Small (around 4 KB) and typed, with no build tool beyond `tsc`.
- **Markdown:** `markdown-it` with `html: false`, so raw HTML in notes is
  escaped. The editor is a textarea next to a live preview.
- **Dev dependencies:** `@playwright/test` (see doubt 1).
- **New runtime dependencies in total:** SDK, `preact`, `markdown-it`.
- **Static assets:** a cross-platform `scripts/build-ui.ts` (Node APIs only)
  runs `tsc -p tsconfig.ui.json` and copies `src/ui/static/` into `dist/ui/`.
  `npm run build` runs it. The server finds assets through `PACKAGE_ROOT`.

### Server

- `briefstack web [--port N]` starts it. The default port is fixed, and
  `--port 0` means any free port. If the default port is taken, the server
  stops with a clear error that suggests `--port 0`. It binds `127.0.0.1`
  only and prints `http://127.0.0.1:<port>/#token=<t>` alone on its own line.
- Security on every request:
  - The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`.
  - Every `/api` call needs the `X-Briefstack-Token` header (32 random bytes
    per launch, compared in constant time).
  - Mutating methods also need `Origin` equal to the server's own origin, and
    `Sec-Fetch-Site` must not be `cross-site`.
  - No CORS headers. A strict CSP (`default-src 'self'`).
- The live stream uses `fetch` plus a `ReadableStream` (SSE format) instead of
  `EventSource`, so it can send the token header.
- Logging: method, route and status only. Never bodies, tool inputs or note
  text.
- Routes are thin. Each one parses input with zod, calls library code, and
  returns JSON. Errors come back as `{code, params, message}` using the
  existing `BriefstackError` and `formatError`.
- API documented in `docs/api.md` (brief §6).

### Library additions (deterministic, with tests; the CLI uses them too)

- `listProjects(libraryDir)`: frontmatter, name, created date, session id.
- `listSessions(sessionsDir)`: `summarizeSession` for every session folder.
- `sessionTimeline(sessionsDir, id)`: steps with start, end and outcome.
- `saveNote({libraryDir, section, name, text})`: implements doubt 4. It reuses
  the secret check, INDEX update and `gitCommit`. `addNote` keeps its file
  interface and gains a text variant.
- `libraryHistory(libraryDir, limit)`.
- `revertLibraryCommit(libraryDir, sha)`: `git revert --no-edit`. On conflict
  it aborts and returns a coded error.
- `usageShow()` and `usageSet()` are moved out of `cli.ts` into `src/usage/`,
  so the CLI and the server call the same code.
- `setProjectsDir()`: implements doubt 6. A new config key,
  `permissionPolicy: 'ask' | 'unattended'` (default `ask`).

### Creation sessions

- `CreationRunner` interface: `start({idea, profile, policy, io})` returns a
  handle with `cancel()` and an async stream of runner events.
  - `io` is how the runner reaches the user: `askQuestions`,
    `requestPermission`, `approveSpec`, `grantDirectory`. Each returns a promise
    the browser resolves.
  - Two implementations:
    - `SdkRunner`: the real one.
    - `FakeRunner`: replays a recorded creation from a JSONL script (questions,
      permission requests, spec approval, events). It writes `events.jsonl` as
      the real hooks would.
- `SdkRunner` (H0 changes approved 2026-10-14, `decisions.md` "H0 probes"):
  - Starts `query()` with:
    - `cwd` = repo and `settingSources: ["project", "local"]`;
    - the user's `claude` as `pathToClaudeCodeExecutable`;
    - the profile's session `model`/`effort`;
    - `permissionMode: 'auto'`;
    - `strictMcpConfig: true` with only the `briefstack-web` server, so no
      claude.ai connectors;
    - streaming input;
    - an environment without `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
      `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDECODE` or `CLAUDE_CODE_*`.
  - **Guard hook** (an SDK `PreToolUse` callback; hooks run before the
    permission mode, so the auto classifier never decides these). It applies
    to the main session and to subagents:
    - **File writes** (`Write`, `Edit`, `NotebookEdit`): inside
      `projectsDir`, the session folder or a folder granted to this session,
      they pass. Anywhere else the hook returns `ask`.
    - **Shell** (`Bash` and `PowerShell`): only the commands the flow needs
      pass. That means `npm run --silent briefstack -- <sub> …`, where `<sub>`
      is `event`, `paths`, `usage show`, `library context`,
      `library add`, `spec check`, `scaffold`, `validate` or `commit`, with
      no `&&`, `;`, `|`, `$(`, backticks, redirects or newlines. Any other
      command returns `ask`. The list comes from the skill, the five agents
      and the H10 transcripts.
    - `ask` reaches `canUseTool`. That shows the permission dialog under
      `ask me`, or denies and records under `unattended`.
    - After a cancel, every tool is denied except the `briefstack event`
      calls that close the session.
  - `canUseTool`:
    - `AskUserQuestion` goes to the question form.
    - A write in a folder the user confirmed through `grant_directory` is
      allowed, with `updatedPermissions: [{ type: "addDirectories",
      destination: "session" }]`. The grant is never written to any
      settings file.
    - Anything else goes to the dialog or the unattended denial.
  - `grant_directory` creates a missing folder only after the user confirms
    (it replaces the CLI's `! mkdir`).
  - Before showing a request, inputs pass through the secret redactor.
  - Never `bypassPermissions`.
- `CreationManager`: creations live in a map keyed by id (phase 4 ready). Phase 2
  allows one active creation and answers HTTP 409 for a second.
  - The manager keeps pending questions and requests in memory. Closing the tab
    loses nothing, and on reopen the browser fetches the state and the stream
    replays from the last seen sequence number.
  - A `result` message is not the end: subagents run in the background and
    a second turn follows. A creation ends only with the flow's
    `session.finished` event, or with a stop.
  - **Cancel** never calls `interrupt()`, because it kills a running command
    within about 25 ms and could cut a CLI write.
    - A pending question is answered "cancel".
    - Otherwise the guard hook denies the next tool calls with a message
      telling the skill to close the session as `cancelled`.
    - If the skill has not closed it within a time limit, the server writes
      `session finished cancelled` through `appendEvent`.
  - **Server stop:** `SessionEnd` does not fire on abort, `close()` or host
    exit, and running commands are left orphaned on Windows. On stop, the
    server:
    - writes the end itself (a `session.end` event with reason
      `server_stop`, so the session reads `interrupted`);
    - kills the whole Claude Code process tree. It owns that process through
      the SDK's `spawnClaudeCodeProcess`, verified in H6.
- Stream events: `{seq, ts, kind, data}`, where `kind` is one of
  `flow | hook | question | permission | spec | status`. They are built from
  `events.jsonl` (watched) and runner events. This is the shape the phase 3
  panel can reuse.

### Skill changes (the CLI path stays identical)

- The skill keeps one flow logic. Only two answers change source when the
  `briefstack-web` tools are available:
  - the spec approval comes from `approve_spec` instead of plain-text
    approve/change/cancel;
  - the folder permission comes from `grant_directory` instead of asking for
    `/add-dir`.

  The steps themselves are the same either way.
- `library add projects` gains `--session <id>`, and the skill passes it.
- Generator and reviewer bodies: "Bash only for the briefstack CLI". The
  "read-only commands" wording goes, and the reviewer inspects the tree with
  Glob and Read. In H10 its one non-CLI command was `find -type d`.
  The bodies are edited by hand; `model` and `effort` are not.
- `tests/unit/new-project-skill.test.ts` checks that both answer sources are
  present, and that the step sequence and the `event` calls do not depend on
  the branch.

### UI screens

- **Projects:** list, detail (summary, status, timeline, `NEXT_STEPS.md`, copy
  `INSTRUCTIONS.md`, copy path, the "open in Claude Code" command).
  Interrupted or cancelled sessions are listed separately.
- **New project:** idea, progress list (step plus active agent), question
  form (recommended option preselected, free text), permission dialog, spec
  screen, result. The Cancel button is always visible. Under the
  `unattended` policy, the result screen lists the requests that were denied.
- **Library:** browse sections, editor with preview, history with revert
  (confirmed first).
- **Usage:** a three-position slider plus user presets, with qualitative labels,
  warnings and a link to `/usage`.
- **Settings:** `projectsDir`, language, permission policy, read-only paths.
- **Strings:** all in `src/i18n/ui.ts` (en and es). It is a pure module, so the
  UI imports it directly.

## 4. Layout (new parts only)

```
src/
  server/      # http server, router, security, routes, stream, docs ref
  creation/    # CreationRunner, SdkRunner, FakeRunner, CreationManager, web MCP tools
  ui/          # Preact TSX + static/ (index.html, css); tsconfig.ui.json at root
  i18n/ui.ts   # UI strings, en + es
  library/     # + projects.ts, history.ts, saveNote
  events/      # + sessions.ts (listSessions, sessionTimeline)
  usage/       # + show.ts (moved out of cli.ts)
scripts/build-ui.ts
tests/
  unit/ (+ server-*, creation-*)  fixtures/recordings/*.jsonl
  e2e/ (Playwright over FakeRunner)
docs/  BRIEF-phase-1.md  BRIEF-phase-2.md  PLAN-phase-1.md  PLAN-phase-2.md  decisions.md  api.md
```

## 5. Milestones

Every milestone ends with `npm run build`, `npm test` and `npm run lint`
passing. From H9 on, `npm run test:e2e` must pass as well.

| # | Milestone | Verification |
|---|---|---|
| H0 | Verify section 2 → `decisions.md` | Each item with URL, date and conclusion; checkpoint with the user |
| H1 | Dependencies, `tsconfig.ui.json`, `build-ui`, `briefstack web` serving a blank page with every security check | Security tests: wrong `Host`, missing or wrong token, cross-origin `Origin`; bind address is `127.0.0.1`; default port taken gives the `--port 0` error; URL printed alone on its own line |
| H2 | Library additions (section 3) and the `--session` link; CLI moved onto `usageShow/usageSet` | Unit tests with `path.win32`/`path.posix`; the existing 294 tests unchanged; revert-conflict test |
| H3 | Read routes: projects, project detail/timeline, sessions, library browse, usage, paths, settings; `docs/api.md` | API test per route against a temp home |
| H4 | Write routes: save note, revert, usage set, settings | API tests; no secret in responses or logs; a note containing a secret is refused |
| H5 | `CreationRunner`, `FakeRunner`, `CreationManager`, stream, cancel, reconnect, one-active rule, server-stop behaviour | Unit and API tests over recordings: full run, change at the spec, cancel, reconnect with replay, 409, unattended denial recorded and listed in the result |
| H6 | Web MCP tools, skill branches, `SdkRunner` (guard hook, auto mode, policy, folder grant, model/effort, process tree) | Guard hook unit tests: allowed CLI commands, chained or other commands, PowerShell, writes in and out of the allowed folders, after cancel. Real checks: a hook `ask` reaches `canUseTool` in auto mode; `spawnClaudeCodeProcess` kill leaves no orphan; effort visible with a Sonnet profile. One small real smoke run in a folder the tool creates; a recording captured for the fake runner |
| H7 | UI: projects, library, usage, settings | Component tests where useful; manual check in the browser |
| H8 | UI: creation flow (all screens, Cancel, reopen tab) | Manual check over `FakeRunner` |
| H9 | Playwright E2E over `FakeRunner`: full creation, change at spec, cancel, close/reopen tab, library edit and revert, slider change | `npm run test:e2e` green on Windows |
| H10 | Real run: one project created entirely from the browser on the real library | The user accepts it. Phase 2 is not done before this |

## 6. Parallel work

At most two subagents at a time. Worktrees start from the local `HEAD` and
check the expected base SHA first, as in phase 1.

- **H0 ‖ H1:** two `claude-code-guide` agents read the docs, one on the SDK
  (items 1–5, 8–11) and one on hooks and policy (items 6–7). Meanwhile the main
  session builds H1. The real probes run in the main session after the docs
  are read.
- **After the H0 checkpoint:** H2 ‖ H5 in worktrees (library code, and the
  runner/manager over the fake runner; they don't share files).
- **Then:** H3+H4 in the main session ‖ H7 in a worktree (UI over the read
  API, with mocked data until the routes land).
- **Not delegated:** the H0 checkpoint, skill changes and `SdkRunner` (H6),
  integration, H8's flow wiring, H10.

## 7. Verification (end to end)

- `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e` all pass on
  Windows.
- `npm run briefstack -- web --port 0`:
  - a request with a wrong `Host` gets 403;
  - an `/api` call without the token gets 401;
  - a `POST` with a foreign `Origin` gets 403.
- H10: the user creates a project from the browser on the real library, sees
  it in Projects with its timeline, and accepts it.
