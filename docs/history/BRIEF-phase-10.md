# briefstack — Phase 10 brief: the creation writes the first version of the code, with Codex

> `v1.1.0` is prepared and phase 9 (builds) is done. This file is the source
> of truth for phase 10. If something here conflicts with a later
> instruction in chat, follow the most conservative reading and record it in
> `docs/decisions.md`. Approved by the user on 2026-11-22, including working
> **unattended**: H0, the plan and the milestones go ahead without a stop for
> approval unless a stop condition in §8 is met.

## 1. What phase 10 is

Today a creation prepares a project's workspace (brief, `CLAUDE.md`,
skills) and its generator is forbidden to write application code; the code
comes later from tasks or builds. Phase 10 lets a creation **also write a
first version of the code**, when the user asks for it at the spec
checkpoint, and lets Claude hand parts of that code to **Codex without its
shell**. Builds stay as they are, to continue from that first version.

## 2. Decisions confirmed by the user (2026-11-22)

1. **The creation writes code.** A creation can end with the workspace and a
   first version of the project's code, not only the workspace.
2. **Codex helps write it**, through briefstack's own tool, in Codex's mode
   **without its shell** (`codex exec` with the shell tool disabled): Codex
   writes files only and runs nothing, so it cannot bypass the creation's
   rules on commands.
3. **Measure first:** the no-shell mode has never been measured. H0 measures
   it with **up to 10 real Codex calls** made by Claude Code unattended, in
   temporary folders, with every command and output saved. **If the mode
   does not hold** (Codex can still run a command, or write outside the
   project folder), Claude Code stops and reports; nothing of Codex is
   built.
4. **Codex is opt-in per creation:** a checkbox when the user approves the
   spec, off by default, shown only when Codex's switch is on in Settings
   and its status check (including the no-shell mode) passes.

Defaults chosen by the advisor, open to change in the plan (record each in
`decisions.md`):

5. **Opt-in for code at all:** at the spec checkpoint the user chooses
   "workspace only" (today's behaviour, the default) or "workspace and a
   first version of the code". Only `software` projects with the
   `claude-code` target; only in the **web app** (the terminal flow
   `/new-project` stays as it is).
6. **A new agent, `implementer`**, runs a new step `implement` after
   `validate-review` and before `learn`. The `generator` keeps its rule of
   never writing application code; the reviewer reviews the workspace as
   today.
7. **Two commits:** the workspace is committed first (as today's hand-off
   does), and the first version of the code is a second commit, so the user
   can see and revert the code apart from the workspace.
8. **Commands:** as in builds, the user approves at the spec checkpoint an
   **exact list of commands** (install, test, build, lint); the implement
   step runs those and nothing else: any other command is **denied without
   a dialog and recorded** (reuse `src/builds/commands.ts`). The declared
   checks run after the implementer ends, with builds' limits; if they fail,
   **one fix pass** (a setting, 0 to 2); if they still fail, the creation
   ends with the code and a clear warning, never as failed.
9. **Bounds:** the implement step has a cap on turns and time (settings,
   conservative defaults) and reads the plan usage before it starts; above
   the user's threshold it does not start and says so (no pause and resume
   in a creation).
10. **Scope of the first version:** the implementer works from the brief's
    deliverables and "done when", as far as the bounds allow, and writes in
    the brief's "Current status" what is done and what is left, so a build
    can continue.

## 3. Features

- **Spec checkpoint:** the code choice, the command list, the declared
  checks, the fix passes and (when available) the Codex checkbox, with the
  warning of §4. Recorded in the creation; unchanged after approval.
- **The `implement` step:** the implementer session (model and effort from
  the usage profile; reuse `work` or add an entry, decide in the plan) writes
  inside the project folder only (the creation's guard), runs only listed
  commands, and may call `delegate_to_codex` in no-shell mode when the
  checkbox is on, with the per-creation cap of calls (reuse phase 8's
  limits).
- **The live panel** shows the step, the implementer, Codex calls (as on the
  task page), denied commands and the checks.
- **The result screen** shows the two commits, the checks and their output,
  denied commands, Codex calls and tokens, and the "what is left" note.

## 4. Security

- **The implement step runs code written by a session before anyone reads
  it** (the listed commands and the checks), as the user, with the user's
  files; network proxies point nowhere but a program can ignore them;
  native Windows has no OS sandbox. The spec checkpoint and the README say
  so. Same risk the user accepted for builds (phase 9, decision 7).
- The list holds exact commands only, as in builds; it limits command
  lines, not what an approved command runs.
- **Codex runs without its shell.** Its sandbox stays `workspace-write` with
  the project folder as its root; phase 8 measured that its file tool cannot
  write outside it; H0 measures what it can read and that no command runs.
  What Codex writes back is data, never instructions.
- The creation's guard is unchanged: writes only in the project folder, the
  session folder and granted folders.
- Nothing is pushed; the project has no remote unless the user adds one.

## 5. Verification — definition of done

- Unit tests: the spec's new fields and their validation; the implement
  step's permission mode (listed commands, everything else denied without a
  dialog); the two commits; checks and fix passes; bounds; the usage
  reading; the Codex no-shell arguments (no shell tool, no extra flags from
  Claude) and the checkbox's conditions; the terminal flow unchanged
  (regression).
- A fake implementer and the fake Codex (extended to the no-shell mode) for
  UI and API tests; end-to-end tests: a creation with code, with and without
  Codex, a denied command, failing checks with a fix pass, "workspace only"
  unchanged.
- Build, lint, unit and e2e pass; CI green on Linux, Windows and macOS.
- **Real check** in `scripts/real/`, prepared by Claude Code and run only by
  the user: a small creation with code and Codex on, with verdicts for the
  two commits, a listed command run, an off-list command denied without a
  dialog, Codex called in no-shell mode, and the checks.
- Phase 10 is not done before the user runs the real check and accepts it.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.
Do **not** stop after H0 and the plan unless an item makes a §2 decision
impossible or unsafe.

1. **Codex without its shell** (up to 10 real calls, temporary folders,
   `unelevated` and, if ready, `elevated`): the exact flag and that it holds
   in `codex exec`; that a request to run a command does not run it; that
   the file tool cannot write outside the folder; what it can read outside
   it; its events and usage in `--json`. Codex CLI version recorded.
   **If it does not hold, stop.**
2. How the creation flow's steps are defined and run (the `new-project`
   skill, the web creation manager, step names, the panel), and where a new
   step and agent fit; how the terminal flow can stay unchanged.
3. How the creation's guard and permission policy can take builds' exact
   list for one step only, without changing the rest of the creation.
4. How the hand-off's commit can be split into the workspace commit and the
   code commit.
5. How an in-process tool (`delegate_to_codex`) reaches a creation's
   subagent (today it reaches task sessions only).

## 7. Out of scope

The terminal flow. `claude-app` projects and non-`software` templates.
Codex with its shell in a creation. Pause and resume of a creation.
Starting a build automatically after the creation. Changing builds.
Notifying the user.

## 8. Working rules

- Tag `phase-10-start` before the first change (if refused, record it and go
  on; the user creates it).
- `docs/PLAN-phase-10.md` with milestones and a Status section kept current.
- H0, then the plan, then the milestones, without a stop for approval,
  unless: H0.1 shows the no-shell mode does not hold; an H0 item makes a §2
  decision impossible or unsafe; the work needs a change to the tasks'
  guard, S8 for ordinary tasks, builds' behaviour or Codex's mode with shell
  for tasks; any security doubt.
- Small commits, one concern each, gates green before each commit, CI
  checked after each push, CI green before the next milestone.
- Write and edit files only with the Write and Edit tools.
- No real Claude sessions; real Codex calls only in H0.1, at most 10.
