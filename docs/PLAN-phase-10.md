# briefstack — Phase 10 plan: the creation writes the first version of the code

Plan for [BRIEF-phase-10.md](BRIEF-phase-10.md). H0 is in
[decisions.md](decisions.md), "Phase 10: H0", with sources and dates; this
plan follows from it. Work happens on `main`, from `722420b` (the tag
`phase-10-start` was refused to Claude Code; the user creates it). Small
commits, one concern each; build, lint, unit and e2e tests green before
each commit; CI checked after each push and green on Linux, Windows and
macOS before the next milestone.

**Not approved by the user before the work:** the brief lets H0, the plan
and the milestones go ahead unattended (its §8). Every choice made without
the user is in decisions.md, "Decisiones sin Dani (fase 10)".

## 0. Status

Updated 2026-11-22.

| # | Milestone | State |
|---|---|---|
| H0 | Verify before designing (BRIEF §6) | done, decisions.md "Phase 10: H0": the no-shell mode holds (8 real Codex calls of 10) |
| M1 | The spec checkpoint: code choice, lists, fix passes, Codex checkbox; the no-shell status check | done (`2446c90`, `ee4fb98`; CI green on the three systems, run 45035131741). Review: apto con reservas; I1–I4 and m2–m7 fixed with M2 (decisions.md, "Phase 10: review of M1, the fixes"); the bounds settings moved to M3 |
| M2 | The `implement` step: the implementer, its tools, the guard, the two commits, a fake implementer | done (`f7a098e..aa1abfd`; CI green on the three systems, run 45054683892). Review: apto con reservas; I1–I4 and m1–m5, m7, m11 fixed with M3 (decisions.md, "Phase 10: review of M2, the fixes") |
| M3 | Checks, fix passes, bounds and the usage reading | done (`69ff686..ba3f2ab`; CI green on the three systems, run 45056801649). Review: no apto (B1: the command hook denied implementer writes); B1, I1–I4, m1–m7, m9 fixed in `cd4d2c4..5b2382e` (decisions.md, "Phase 10: review of M3, the fixes") |
| M4 | Codex without its shell in the implement step | done (`236f5b3..74d73ff`). Review (with the M3 fixes): apto con reservas; Windows CI of `5b2382e` red (short temp path, I2); I1–I3, I5, I6, m1, m3 fixed with M5 (decisions.md, "Phase 10: review of M4, the fixes") |
| M5 | The live panel and the result screen | done in the working tree (decisions.md, "Phase 10: M5") |
| M6 | Docs and the real check script (prepared, not run) | not started |

## 1. Design decisions taken from H0

Each one is the conservative reading and is in decisions.md.

1. **Where code is offered.** At the spec checkpoint of the **web app**
   only, for a spec with `type` `software` and `target` `claude-code`. The
   user chooses "workspace only" (the default, today's behaviour) or
   "workspace and a first version of the code" (brief §2, 5). The terminal
   flow is unchanged: the skill's new section is for `MODE` web with code
   chosen, and a test holds the terminal text.
2. **What the approval carries.** With code chosen, the spec page sends,
   with `approve`: the exact commands (install, test, build, lint; at most
   20, each validated with `approvedListIssues` from
   `src/builds/commands.ts`), the declared checks (at most 10, the same
   validation), the fix passes (0 to 2, default 1) and, when offered, the
   Codex checkbox (off by default). The server validates them, records them
   on the creation (`code` in its state and `code.json` in the session
   folder, written by the server) and tells the flow `{"decision":
   "approve", "code": true}`. A later "change" and approval replaces them;
   once the implement step starts they are fixed. The page shows the
   warning of brief §4 next to the choice.
3. **The implementer has no shell.** Subagents' shell commands run in the
   briefstack repo, not the project (H0, 2), so the implementer gets no
   Bash or PowerShell at all (the guard denies them, recorded, no dialog).
   It writes with Write and Edit in the creation's roots (H0, 3) and runs
   commands only through a new `briefstack-web` tool, `run_command`, whose
   handler runs a command in the project folder only when
   `isApprovedCommand` accepts it against the recorded list; anything else
   is refused by the handler, recorded on the creation and shown, with no
   dialog. A listed command runs as the declared checks do (a fixed shell,
   its own process group, 10 minutes, output cut and redacted) but **with
   the network** (an install needs it) and with an environment without
   credentials (the names `src/codex/env.ts` drops).
4. **The step's tools**, on `briefstack-web`, web only. For the main
   session: `implement_start` (checks that code was chosen, reads plan
   usage, commits the workspace, starts the step's clock; answers go or
   not with the reason) and `implement_finish` (runs the checks; says
   whether a fix pass is due and with which failures; at the end commits
   the code and returns the summary). For the implementer:
   `run_command` and, with the checkbox on, `delegate_to_codex`. The guard
   gives each tool to its caller only. The order and counting (fix passes,
   commits, the end) are code in the handlers, not prompt.
5. **Two commits** by the server (H0, 4): the workspace with
   `PROJECT_COMMIT_MESSAGE` in `implement_start`, the code with "Write the
   first version of the code with briefstack" in `implement_finish`. The
   hand-off's `briefstack commit` then has nothing to commit.
6. **The implementer agent** is `.claude/agents/implementer.md` (tools:
   Read, Glob, Grep, Write, Edit and its two MCP tools), model and effort
   from the profile's `work` unless a preset names `implementer` in
   `agents`, written by `usage set` (changed in M2: a user's preset made
   before phase 10 stays valid; decisions.md, "Decisiones sin Dani (fase
   10)").
   Its prompt: the brief's deliverables and "done when" as far as the
   bounds allow, then the brief's "Current status" with what is done and
   what is left (brief §2, 10). The generator keeps its rule of never
   writing code.
7. **Bounds** (brief §2, 9): two settings, the step's minutes (default 30,
   5 to 120) and the implementer's tool calls (default 150, 20 to 1000),
   both counted by the server from `implement_start`; past either, the
   guard denies every further tool of the implementer with "the limit was
   reached: stop and report". Plan usage is read in `implement_start`;
   at or above the user's warning thresholds (Settings), or when the
   reading fails, the step does not start and says why; a login without
   plan limits starts.
8. **Checks and fix passes** (brief §2, 8): `implement_finish` runs the
   recorded checks in the project folder through the declared checks'
   runner (offline environment, 10 minutes each). If one fails and fix
   passes are left, it answers "fix" with the failures (cut, redacted, as
   data); the main session launches the implementer again with them. When
   none are left and checks still fail, the creation ends with the code
   and a clear warning, never as failed.
9. **Codex without its shell** (brief §2, 2–4): the measured call of H0
   (calls 3–8): `--ignore-user-config --disable shell_tool --disable
   multi_agent --disable plugins --disable apps --disable hooks --disable
   browser_use --disable computer_use -c web_search="disabled"` with the
   rest of phase 8's call. Codex's status check gains a no-model no-shell
   check (`codex debug prompt-input` with those flags: no `exec_command`
   or `write_stdin` in its tools); the checkbox shows only when the switch
   is on, the last check passed, the mode is the one checked and the
   no-shell check passed. The calls per creation are Settings' calls per
   round (1 to 10). Tasks keep Codex with its shell as it is.
10. **Not changed:** the task guard, `guardCommand.ts` of tasks,
    `shell.ts`, S8, builds, Codex with its shell in tasks, the terminal
    flow.

## 2. Milestones

### M1 — the spec checkpoint

- (Moved to M3: the config `implementMaxMinutes`, `implementMaxToolCalls`.)
- The spec answer's schema with `code`; the server's validation (type,
  target, lists, fix passes, Codex only when available); the creation's
  `code` record and `code.json`; what the flow is told.
- Codex: the no-shell check in the status (additive field) and
  `creationCodexAvailable`.
- The spec page: the choice, the two lists, fix passes, the checkbox, the
  warning; i18n in English and Spanish.
- Tests: validation, the record, the answer to the flow, availability;
  e2e of the page (workspace only unchanged; code with lists).

### M2 — the implement step

- `FLOW_STEPS` gains `implement` (between `validate-review` and `learn`).
- `commitProject` takes the message; the CLI is unchanged.
- `briefstack-web`: `implement_start`, `run_command`, `implement_finish`
  (no checks yet: M3); the guard's `implementer` caller and the
  command-hook guard; denials recorded.
- `.claude/agents/implementer.md`, the profiles' entry, `usage set`.
- The skill: the web-only section; the terminal text held by a test.
- The fake runner plays a creation with code (a fake implementer that
  writes a file, runs a listed and an unlisted command).
- Tests: the guard (implementer allowed and denied, others denied the new
  tools), the handler (exact list, refusal recorded, no dialog), the two
  commits, the terminal regression.

### M3 — checks, fix passes, bounds, usage

- Config: `implementMaxMinutes`, `implementMaxToolCalls` (Settings).
- `implement_finish` with the checks and fix passes; the warning when
  they still fail.
- The clock and tool-call cap in the guard; the usage reading in
  `implement_start`.
- Tests and e2e: failing checks with a fix pass, bounds reached, usage
  above the threshold.

### M4 — Codex without its shell

- `codexExecArgs` with the no-shell set (only for creations); the
  creation's `delegate_to_codex` on `briefstack-web` (the project folder,
  its branch and HEAD before and after, the cap, the record).
- The fake Codex learns the no-shell arguments (refuses a command when
  called with them).
- Tests: the arguments (no shell tool, nothing from Claude but the
  instruction), the checkbox's conditions, the cap; e2e with Codex.

### M5 — panel and result screen

- The panel: the step, the implementer, Codex calls, denied commands,
  the checks.
- The result screen: the two commits, the checks and their output,
  denied commands, Codex calls and tokens, the "what is left" note.
- `GET /api/creations/:id` carries the record.

### M6 — docs and the real check

- README ("the creation runs code before you read it"; Codex without its
  shell), `docs/api.md`, `CHANGELOG.md` "Unreleased", decisions.md,
  `CLAUDE.md` current state.
- `scripts/real/check-creation-code.ts` prepared and **not run**, with
  verdicts for the two commits, a listed command run, an off-list command
  denied without a dialog, Codex called in no-shell mode, and the checks.
