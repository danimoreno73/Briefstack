# briefstack — Phase 3 plan

Plan for phase 3, the live agent panel. Scope comes from
[BRIEF-phase-3.md](BRIEF-phase-3.md). The user approved the polish round
(section 0) and the whole of phase 3 in advance, except the final real run,
and was away while it was built: decisions taken without them are in
`docs/decisions.md`, "Decisiones sin Dani (fase 3)". Verified behaviour also
goes in `docs/decisions.md`. The phase 2 plan is
[PLAN-phase-2.md](PLAN-phase-2.md).

Starting point: tag `phase-3-start` (after P1–P4). Work happens on `master`
in small commits, one concern each.

## 0. Status

Updated 2026-10-17. A new session reads `CLAUDE.md`,
`docs/BRIEF-phase-3.md`, this file and `docs/decisions.md` from
"# Phase 3" onwards before continuing.

### Done

| # | What exists now |
|---|---|
| P1 | One target rule in `library/rules/target.md`, read and cited by the interviewer and the architect. The spec has an optional `targetChosenBy` (`user` or `architect`), shown on the approval screen, in the summary the skill prepares and on the project detail page (`targetChoice`, read from the project's `.briefstack/spec.json`). Real check prepared, **not run**: `scripts/real/check-interviewer-target.ts` |
| P2 | The interviewer never returns a question with fewer than two options; the skill merges or drops one before `AskUserQuestion` |
| P3 | `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` is hidden only when it names exactly `approve_spec` and `grant_directory` (`src/creation/sdkWarnings.ts`); `allowedTools` is pinned to those two; a test reads the installed SDK's wording |
| P4 | `CLAUDE.md` names phase 3 and loads this brief |
| M1 | Events: `docs/events.md`; hook lines get `toolUseId`, `target`, `effort`, `model`; the manager writes `source: "runner"` lines (`tool.denied` by guard, policy or user, `session.profile`) and streams them as kind `runner`; `GuardDenial` has `agentId` and `toolUseId`; runner lines are not activity in `summarizeSession`; the streamed `denied` reason is now redacted too; `FakeRunner` takes the new fields and a `burst` step. Fixture `tests/fixtures/sessions/h10-run3.jsonl` copied with placeholders (used from M2). The `usage` line type exists; writing it is M3 |
| M2 | `src/panel/state.ts`: `buildPanelState(events, { now, live? })`, pure and browser-safe, exported from `src/index.ts`; `src/panel/project.ts`: what may leave the server (known fields only, redacted targets and reasons, absolute paths shown as `[outside allowed folders]`, 120/300 character limits). Tests on synthetic cases, a 40 000-line burst and the real H10 run 3 fixture |
| M3 | `src/creation/planUsage.ts` (the preflight's reading, now shared with `scripts/real/common.ts`); the manager reads it once the session id is known and every 5 minutes until the creation finishes, and writes `usage` lines; wired only with the real runner |
| M4 | `GET /api/sessions/:id/events` (projected lines with `id`, `badLines`, `state`); the creation stream projects `hook` and `runner` lines the same way; `docs/api.md` updated |
| M5 | `src/ui/panel.tsx` (agent tree, timeline as HTML rows with inline SVG bars, node detail with denials, plan usage, a text view in `<details>`; recomputed at most every 200 ms and every second while running), `src/ui/panelData.ts` (pure glue, tested); the creation page shows the panel under the pending control, which has id `pending-control` and is reached from the node that asked; `#/sessions/<id>` rebuilds a session from `GET /api/sessions/:id/events`, linked from the project detail and the interrupted and cancelled list; strings in English and Spanish |
| M6 | `tests/e2e/panel.spec.ts` (live updates, requests on the asking node, a guard denial, reopening the tab, a 3000-pair burst, cancelled, interrupted and pre-phase-3 sessions, an agent with no stop, the text view with the keyboard, no sideways scroll at 390 px); recording `panel.jsonl`; `npm run screenshots` (`playwright.screenshots.config.ts`, `tests/screenshots/`) writes 12 screenshots at 1280 and 390 px to the git-ignored `screenshots/`. Looked at; fixed: a denial written after its agent stopped lost its target, the header scrolled sideways at 390 px, the pending note used the error color, an empty model showed as `—`, a single plan reading showed twice |
| M7 | Decisions 5–13 in `decisions.md`; this Status; the real-run steps below |

### Real run (2026-10-17) — accepted

Run by Claude over the real library, driven with Playwright against `npm run
briefstack -- web`; session `62a0ad02`, project `photo-exif-renamer`, outcome
`completed`, no permission dialog and no guard denial. Phase 3 accepted by the
user as to function. Screenshots are in the git-ignored `screenshots/phase-3-real/`.

| Point | Result |
|---|---|
| Build, server up on `127.0.0.1` | PASS |
| Creation: recommended interview answers, one "Request changes" (`--undo`), approve | PASS; the new summary included `--undo` |
| Models, efforts and states on the nodes | PASS |
| Short targets, no full paths (0 absolute paths in 95 `target` fields) | PASS |
| Pending question marked on the main session node | PASS |
| Timeline: click on a row selects the node | PASS |
| Plan usage at start and after ~5 min | PASS (13%/26% then 22%/26%); see backlog for the first second |
| Who chose the target, in the spec | PASS (architect, by `library/rules/target.md`) |
| Reload mid-creation | PASS: `events.jsonl` 159 lines before and after; same panel text |
| Panel of the finished session from the project page | PASS: same as the live final state, except durations |
| `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` in the server output | PASS: none |
| New fields in `events.jsonl` | PASS: `toolUseId`, `effort`, `target` on `tool.pre`; `model` on 9/9 `subagent.start`; `session.profile`; 2 `usage` lines. `reason` of a guard denial not exercised (no denial); covered by tests |
| Server stopped | PASS |

### Left

Nothing in phase 3. The P1 check (`scripts/real/check-interviewer-target.ts`)
was not part of this run and stays prepared for the user.

### Backlog (not phase 3, not started)

- Plan usage shows "Not available for this session" during the first second of
  a creation, before the first reading arrives; it shows the reading a moment
  later.
- A late `session.finished` (or end event) can fail to reach the live panel;
  the stream closes after one more read of `events.jsonl`, but a line written
  later is missed until the page is reloaded.
- Session model when no usage profile resolves: `buildQueryOptions` passes
  `model` only if the profile has `sessionModel`. With a profile, the option
  wins over `ANTHROPIC_MODEL` and user settings are not loaded
  (`settingSources: ['project', 'local']`). Without one, the model would come
  from `ANTHROPIC_MODEL` (not removed from the session env) or the CLI default.
  To check against the official docs and decide (always pass a model, or drop
  `ANTHROPIC_MODEL` from the env); record it in `decisions.md`.
- A UI and UX pass over the whole app, after phase 4 and before publishing,
  using an external design repository the user will choose.

## 1. Approach

The panel is a **read model**. Everything it shows comes from the session's
`events.jsonl`, through one pure function, `buildPanelState(events, options)`
(`src/panel/state.ts`). The browser runs the same function on the live
stream and on a finished session's recorded events; the server exports it
for phase 4 and returns its result from the new read route. Nothing in the
panel answers, starts or stops anything; the phase 2 controls stay where
they are, and the panel links to them.

What phase 2 lacks for that, and how phase 3 adds it:

| Panel needs | Source today | Added in phase 3 |
|---|---|---|
| Agent tree, start and end | `subagent.start`/`stop` hook lines | nothing |
| Tool now, tool counts | `tool.pre`/`post`/`failure` lines, name only | `toolUseId` on all three (pairs parallel calls exactly), `target` on `tool.pre` |
| Model per agent | nothing | `model` on `subagent.start`, read by the hook from the agent file (written only by `usage set`); main session's from a runner line |
| Effort per agent | the runner's one-off `effort` event, not stored | `effort` on `tool.pre` and `subagent.stop`, from the hook input `effort.level` |
| Guard denials with reason, on the right node | runner `denial` events, in memory only | `tool.denied` lines written by the manager (`source: "runner"`), with `agentId` and `toolUseId` (two fields added to the guard's denial) |
| Plan usage at start and now | `scripts/real/preflight.ts` only | `usage` lines written by the manager from the same SDK reading |

All new fields are optional and the format stays `v: 1`: every phase 2
line reads as before. Lines written by the server itself get
`source: "runner"`, so they never pretend to come from a hook.

### Targets

A target is `{ "root": "session" | "projects" | "repo" | "cli" | "outside", "path"?: "…" }`,
computed by `scripts/hook-event.mjs` (so terminal sessions get it too):

- `Read`, `Write`, `Edit`, `NotebookEdit` (`file_path`/`notebook_path`),
  `Glob`/`Grep` (`path`), and `approve_spec`/`grant_directory`
  (`specFile`/`dir`): the path relative to the session folder, the projects
  folder or the briefstack repo, whichever holds it most closely, with `/`;
  else `{ "root": "outside" }` and no path.
- `Bash`/`PowerShell`: only a `npm run [--silent] briefstack -- <sub> [<sub>]`
  command, recorded as `{ "root": "cli", "path": "library add" }`. Nothing
  else from a command is kept.
- Any other tool: no target. Never a query, a URL, a pattern or file content.

At most 120 characters (the end is kept). The server redacts it again on
the way out (`src/panel/project.ts`): secret lines, any absolute path left
in it, unknown fields dropped.

## 2. Milestones

Each milestone ends with build, lint, unit and e2e tests green, a push and
this Status updated.

### M1 — Events (schema, hook fields, runner lines)

- `docs/events.md`: every type, its fields, which are optional, who writes it.
- `src/events/index.ts`: optional fields on hook lines (`toolUseId`,
  `target`, `effort`, `model`); runner lines (`source: "runner"`):
  `tool.denied` (`tool`, `by: guard | policy | user`, `agentId?`,
  `agentType?`, `toolUseId?`, `reason?`), `session.profile` (`profile`,
  `model?`, `effort?`), `usage` (`fiveHour`, `sevenDay`, numbers or `null`).
  The reader accepts them; old lines unchanged.
- `scripts/hook-event.mjs`: the new fields; the rule for `projectsDir`
  (config, then `~/briefstack-projects`) copied with a sync test like
  `briefstackHome`.
- Guard: `agentId` and `toolUseId` added to `GuardDenial` (fields only).
- Manager: writes `tool.denied` for guard, policy and user denials,
  `session.profile` once the session id is known; streams runner lines as
  kind `runner`. The phase 2 `denied` stream items stay.
- `FakeRunner`: recordings may carry the new hook fields.

### M2 — Panel state (pure)

- `src/panel/state.ts`: `buildPanelState(events, { now, live? })` →
  session (status, outcome, start, end, usage start/now), nodes (main
  session first, then one per subagent in start order: type, model, effort,
  status, start, end, duration, current tool and target, tool count, denial
  count and denials, pending request), timeline rows, the flow steps.
  Statuses: `waiting` (asks the user), `running`, `done`, `failed`,
  `cancelled` (main session), and `noEnd` (no stop recorded and the session
  is over). Tool calls pair by `toolUseId`, else first-in-first-out per
  agent and tool. Activity after a `subagent.stop` reopens the agent (seen
  in H10 run 3).
- `src/panel/project.ts`: what may leave the server (redaction, `outside`,
  truncation, a whitelist of fields).
- Tests: synthetic cases, every status, bursts, a session recorded before
  phase 3, and **`tests/fixtures/sessions/h10-run3.jsonl`**, the real H10
  run 3 with the session id and agent ids replaced by placeholders (it held
  no paths or names).
- Exported from `src/index.ts`.

### M3 — Plan usage

- `src/creation/planUsage.ts`: the reading `preflight.ts` uses (a session
  that sends no message), moved out of `scripts/real/common.ts`, which now
  calls it.
- The manager reads it when the session id is known and every 5 minutes
  while the creation runs, and writes `usage` lines. Injected, so tests use
  a fake. A failed reading writes nothing; the panel says "not available".

### M4 — Routes and stream

- `GET /api/sessions/:id/events`: the session's lines, projected, each with
  its line number as `id`, and `state` (`buildPanelState` now). Token like
  every route; no new write route.
- The creation stream also carries kind `runner`; hook and runner lines are
  projected before they are streamed.
- `docs/api.md` updated.

### M5 — UI

- `src/ui/panel.tsx`: agent tree (HTML), timeline (inline SVG, one row per
  agent, a click selects the node), node detail, denials on their node,
  plan usage, and the text alternative: a list with every agent, its
  status, times, tool and counts, reachable by keyboard.
- Creation page: the panel is the main view; the progress list stays as a
  compact summary; a pending request shows on the node that asked with a
  button that takes focus to the control that answers it.
- `#/sessions/<id>`: a finished session's panel, rebuilt from its events.
  Linked from the project detail and from the interrupted and cancelled
  list.
- The live panel recomputes at most every 200 ms, so a burst of events does
  not freeze the page. Reopening rebuilds from the replayed stream (from
  sequence 0, deduplicated by sequence number).
- All strings in `src/i18n/ui.ts`, English and Spanish.

### M6 — End-to-end tests and screenshots

- Recordings with the new fields, a guard denial, a burst and a pending
  question from a subagent's permission request.
- Playwright: live updates; a pending question on the right node; a guard
  denial shown with its reason; reopening the tab mid-creation without lost
  or duplicated events; cancelled and interrupted sessions; a session
  recorded before phase 3; the text alternative; a burst.
- Screenshots of the panel at 1280 and 390 px wide in `screenshots/`
  (git-ignored), looked at, and the layout fixed where needed.

### M7 — Docs and hand-off

- `decisions.md`, this Status, and the steps for the real run.

## 3. Real runs (prepared, run by the user)

None of these was run while building phase 3.

1. **P1 check** (two short interviewer turns):
   `npx tsx scripts/real/check-interviewer-target.ts --yes`. Expected: four
   PASS lines, `claude-code` for the photo renamer, `claude-app` for the
   conversation partner, and both reports citing `library/rules/target.md`.
2. **Preflight** (reads only): `npx tsx scripts/real/preflight.ts`.
3. **Phase 3 real run**, on the real library:
   1. `npm run build`, then `npm run briefstack -- web`, and open the address
      it prints.
   2. Start a creation. While it runs, check in the panel: the main session
      shows its model (for example `opus`) and an effort; each subagent appears when it
      starts, with its model and effort; the tool in use shows a short
      target (a path under the projects or session folder, `briefstack
      <command>`, or "outside allowed folders"), never a full path; a
      question or the spec shows on the main session with "Go to the
      answer"; plan usage shows a reading at the start and a later one after
      about 5 minutes.
   3. Reload the tab once mid-creation: the panel comes back with the same
      counts.
   4. At the end, open the project page and "Open the agent panel": the same
      tree and timeline, rebuilt from `events.jsonl`.
   5. In the server console: no `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning.
   6. In the session's `events.jsonl`: `tool.pre` lines with `toolUseId`,
      `target` and `effort`, `subagent.start` with `model`, a
      `session.profile` line and `usage` lines.
   7. Accept or reject the panel. Phase 3 is done only after acceptance.
