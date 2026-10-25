# briefstack — Phase 2 brief: Local web app

> Phase 2 of 5. Phase 1 (creator + library, CLI and `/new-project` skill) is done
> and tagged `phase-1-done`. This file is the source of truth for phase 2 scope.
> If something here conflicts with a later instruction in chat, ask before building.

## 1. What this is

A local web app on top of the phase 1 core. The user does everything from the
browser: see their projects, create a new one through the full guided flow,
edit their personal library and choose the usage profile.

The CLI and the `/new-project` skill keep working exactly as today. The web app
is a second way in, not a replacement.

## 2. Constraints

- **Local only.** The server listens on `127.0.0.1` only. No login, no accounts,
  no remote access, no telemetry.
- **Same platforms as phase 1:** native Windows, macOS, Linux. Same path rules.
- **No API key required.** The app drives the user's own installed Claude Code,
  through the TypeScript Agent SDK or `claude -p`, with the user's existing login.
  The official help article "Use the Claude Agent SDK with your Claude plan"
  (updated 2026-10-07) states that the Agent SDK, `claude -p` and third-party apps
  can use subscription limits. If H0 finds that this does not work in practice,
  stop and ask. Do not silently switch to requiring an API key.
- **Reuse, do not duplicate.** All logic stays in the phase 1 library code. The
  server is a thin layer over it. The creation flow must not be reimplemented in
  the server: the web runs the same `/new-project` skill and the same five agents.
- **Never bypass permissions.** No `bypassPermissions`, no `--dangerously-skip-permissions`.
- Code and docs in English. UI in English and Spanish, all strings in `src/i18n/`.
- Stack: TypeScript, same Node LTS and test setup as phase 1. Choose the web and
  UI framework in the plan and justify it; keep dependencies minimal.

## 3. Features

### 3.1 Projects

- List of every project in the personal library: name, target, status, profile,
  creation date, path. Data comes from the project notes' frontmatter.
- Project detail:
  - summary and status block;
  - creation history: the steps of the creation session with times and result,
    read from that session's `events.jsonl` (a simple timeline, not the live
    agent panel of phase 3);
  - for `claude-app` projects, the content of `NEXT_STEPS.md` and a copy button
    for `INSTRUCTIONS.md`;
  - a button that copies the project path, and one that shows the command to
    open it in Claude Code.
- Sessions that ended `interrupted` or `cancelled` are listed separately, with
  their last step.

### 3.2 Create a project in the browser

The same flow as `/new-project`, from the browser:

1. The user writes the idea.
2. The server starts a creation session that runs the `/new-project` skill.
3. Every question the flow asks (`AskUserQuestion`) appears as a form, with the
   recommended option preselected and a free-text field.
4. Tool permissions must not depend on the user being present. The session:
   - pre-approves the actions the creation flow always needs, with narrow rules:
     the briefstack CLI, writes inside `projectsDir` and the session folder,
     and read-only web access for the researcher;
   - runs in `auto` permission mode, so the classifier reviews anything else;
   - handles what still needs an answer according to a setting:
     **ask me** (default: an approve/deny dialog showing exactly what is
     requested) or **unattended** (denied automatically, recorded in the
     session history, and the flow continues).
   The interview questions and the spec approval always need the user; that is
   intended. Verify in H0 how these rules and modes apply under the SDK.
5. A progress list shows which step of the flow is running and which agent is
   working, updated live.
6. The spec approval is a dedicated screen with the summary and the three
   choices: approve, change (with a text field), cancel.
7. The result screen shows where the project is and the next steps.

Rules:

- **Cancel** is always visible and ends the session as `cancelled` through the
  flow, never by killing the process mid-write.
- Closing the browser tab does not end the session. Reopening the app shows the
  creation in progress and lets the user continue.
- If the server stops mid-creation, the session ends as `interrupted`, as today.
- **One active creation at a time** in phase 2. The design must not prevent
  several later (phase 4).
- Output folder outside `projectsDir`: ask for it in the flow as today; the server
  grants it to that session only (the SDK equivalent of `/add-dir`), after the
  user confirms in the UI.
- The usage profile decides the session model and effort, passed to the SDK.

### 3.3 Personal library

- Browse `INDEX.md`, profile, lessons, project notes and session logs.
- Edit any note in a markdown editor with preview.
- Every save goes through the existing library code: secret check, date heading
  rules, `INDEX.md` update and one git commit.
- History of the library (git log) with the option to revert a commit, after
  confirmation.

### 3.4 Usage profile

- A three-position slider (saver, balanced, max) plus any user-defined presets.
- Changing it calls the same code as `briefstack usage set`.
- Show what each level means qualitatively, never as exact token or cost figures.
- Show the warnings `usage show` already produces (overriding environment
  variables, drift from the committed agent files).

### 3.5 Settings

- `projectsDir` and UI language.
- Unexpected permission requests: ask me / unattended (see 3.2).
- Read-only view of the resolved paths (`briefstack paths`).

## 4. Security

- Bind to `127.0.0.1` only. Reject requests whose `Host` header is not the local
  address and port (DNS rebinding).
- Mutating requests require a per-launch token and a same-origin check (CSRF).
- The server only starts creation sessions with the briefstack repo as working
  directory, and only writes where phase 1 already allows.
- Secrets never appear in the UI or in server logs.
- Destructive actions (revert a library commit, cancel a creation) ask for
  confirmation.

## 5. Verification — definition of done

- Unit and API tests for every server route.
- A **fake runner** with the same interface as the real Agent SDK runner, which
  replays a recorded creation: questions, permission requests, spec approval,
  events. All UI and API tests use it, so tests spend no tokens and need no login.
- End-to-end browser tests (Playwright, already installed) over the fake runner:
  full creation, change request at the spec, cancel, closing and reopening the
  tab, library edit and revert, slider change.
- Security tests: wrong `Host` header, missing token, cross-origin request.
- Windows and POSIX path tests as in phase 1.
- Build, lint and tests pass.
- **Real run:** one project created entirely from the browser, on the user's real
  library, accepted by the user. Phase 2 is not done before that.

## 6. Prepare for later phases, without building them

- Stream session events to the browser (for example with server-sent events) in
  a form the phase 3 live agent panel can reuse.
- Keep creation sessions addressable by id so several can run later (phase 4).
- Keep the server API documented in `docs/` so the global chat (phase 4) and
  self-modification (phase 5) can call it.

## 7. Out of scope for phase 2

Live agent graph panel. Global chat. Self-modification. Several creations at the
same time. Remote access or deployment. Publishing. API-key mode, unless H0 shows
it is the only way and the user approves it.

## 8. H0 — verify before designing

Record each item in `docs/decisions.md` with source URL, date and conclusion.

1. The TypeScript Agent SDK can run a project skill (`/new-project`) and the
   project's agents, hooks and settings, as the CLI does.
2. `AskUserQuestion` and tool permission requests reach a `canUseTool` callback
   in the TypeScript SDK, can wait for a browser answer, and can be resumed after
   a long wait (the documented defer mechanism).
3. The SDK runs with the user's existing Claude Code login and no API key, on
   Windows. Check how it finds the Claude Code binary on Windows.
4. How to grant an extra writable directory to one SDK session.
5. Passing session model and effort through the SDK.
6. Hooks still write `events.jsonl` when the session is started from the SDK, and
   `SessionEnd` fires when the server stops it.
7. Re-read the official policy on subscription use from third-party apps
   (help article above and the Agent SDK docs) and note any conflict.

## 9. Working rules

- Plan first; get the plan approved before writing code.
- Small commits, one concern each. Tag `phase-2-start` before the first change.
- Run tests before saying something works.
- Only launch agents in folders this tool created.
- When a requirement is ambiguous, ask instead of guessing.
