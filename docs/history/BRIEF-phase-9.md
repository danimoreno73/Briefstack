# briefstack — Phase 9 brief: Builds (briefstack writes the code, unattended)

> Phase 8 (Codex in tasks) is done. This file is the source of truth for
> phase 9. If something here conflicts with a later instruction in chat,
> follow the most conservative reading and record it in `docs/decisions.md`.
> Approved by the user on 2026-11-17, including working **unattended**: H0,
> the plan and the milestones go ahead without a stop for approval unless a
> stop condition in §8 is met.

## 1. What phase 9 is

Today briefstack creates a project (brief, `CLAUDE.md`, skills) and phase 7
lets the user run one task at a time in it, approving every shell command
and every diff. Phase 9 adds **builds**: from a project's approved brief,
briefstack plans an ordered **queue of tasks**, the user approves the queue
and a set of rules **once, at the start**, and briefstack runs the tasks one
after another **without asking again**, on an **integration branch**, until
the queue ends, a rule stops a task, or the plan's usage runs low (then it
pauses and resumes after the reset). At the end the user reviews the whole
build and applies it to the default branch with one approval, revertable.

It reuses phase 7 (worktree, task session, guard, proposal, apply and
revert, declared checks), phase 8 (Codex through the existing switch) and
the plan-usage reading of phase 2 and 6.

## 2. Decisions confirmed by the user (2026-11-17)

1. **Start:** an "Implement" button on a created project's page. Nothing
   starts by itself when a creation ends.
2. **Queue:** a planning step turns the project's approved brief into a
   queue of tasks (one per milestone or deliverable), each with a title, an
   instruction, a "done when" and the tasks it depends on. The user reviews,
   edits and approves the queue before anything runs.
3. **How far:** the user sets how many tasks to run (default: all).
4. **Who writes:** Claude; it may hand work to Codex only through phase 8's
   existing switch and limits. Nothing of Codex changes.
5. **Applying unattended:** each task's diff is applied **only if the rules
   set at the start hold**: the declared checks pass and no command outside
   the approved list was needed. Applied means **one commit on the build's
   integration branch, never on the default branch**. If a rule fails, the
   task waits for the user and the queue goes on with the tasks that do not
   depend on it.
6. **Shell commands:** a list of **exact commands approved at the start**
   (install, test, build, lint of the project). Any other command is
   **denied without a dialog and recorded**. No permission dialog ever opens
   during a build.
7. **Checks before review (changes S8 for builds only):** in a build, the
   declared checks run after each round on the consent given at the start,
   before the user sees the diff, with today's limits (network proxies
   pointed nowhere, 10 minutes per command). Native Windows has no OS
   sandbox; **the user accepts that risk**. S8 stays exactly as it is for
   ordinary tasks.
8. **Plan usage:** before each task briefstack reads the plan usage; at or
   above a threshold it pauses and resumes by itself after the reset.
   Notifying the user (Telegram, IDEAS §6) is out of this phase.
9. **Projects:** only `claude-code` projects created by briefstack, as in
   phase 7.
10. **Final step:** one approval on the build's page applies the whole
    build to the default branch as one commit (same safety checks as a
    task's apply), revertable. Discarding a build removes its branch and
    worktrees.

Defaults chosen by the advisor, open to change in the plan (record each in
`decisions.md`): one automatic **fix round** per task when a check fails
(the session gets the failing output; a run setting, 0 to 2, default 1);
a per-build cap on rounds; builds share the active-sessions limit and one
build or task per project at a time.

## 3. Features

### 3.1 Planning the queue

- A planning session reads the project's `docs/BRIEF.md` (and `CLAUDE.md`)
  and returns the queue as structured output validated by a schema. It has
  **no write tools and no shell**; its output is data, shown to the user.
- It may also propose the command list and the declared checks, read from
  the project (for example `package.json` scripts); the user confirms or
  edits them. Nothing proposed is approved until the user approves it.
- Model and effort from the usage profile (reuse `work` or add a `plan`
  entry; decide in the plan).

### 3.2 Starting a build

The start page shows and lets the user edit: the queue (order, text,
dependencies, remove), how many tasks to run, the exact command list, the
declared checks, the fix rounds, the usage thresholds (default from
Settings), and the warning text of §4. Starting records all of it in the
build; it does not change after the start.

### 3.3 Running

- Tasks run in order, each in its own worktree **based on the integration
  branch's head**, so each builds on the applied ones. The integration
  branch (for example `briefstack/build-<id>`) starts at the default
  branch's head and is never checked out in the user's folder; applying to
  it moves only that ref.
- After each round: checks run; if they pass and no command was denied, the
  task is applied to the integration branch; otherwise the fix round(s)
  run; if the rules still fail, the task is left **waiting** with the
  reason and its dependents are skipped.
- Usage: read before each task (a free reading, as today); at or above the
  threshold, pause; resume at the reading's `resets_at` (the SDK reading
  has it; verify in H0) or, if absent, re-read on an interval.
- A server restart leaves the build **interrupted**, never running on its
  own; the user resumes it from the page. Cancel stops the running task
  and its process tree (Codex included) and leaves the integration branch
  as it is.

### 3.4 The build's page

Progress (each task: queued, running, applied, waiting, skipped,
cancelled; rounds, denied commands, checks, Codex calls, tokens), pause
reason and resume time, the cumulative diff of the integration branch
against the start, and the actions: pause, resume, cancel, open a waiting
task (the user can then handle it as an ordinary phase 7 task), apply the
build, discard the build. Same redaction as the rest of the UI.

### 3.5 Applying and reverting

Applying the build: one commit on the default branch with the integration
branch's whole change, refused (with the reason) when the folder is not
clean, another branch is checked out, the default branch moved and the
change no longer applies, or something runs on the project. Revert is one
click, as for tasks. The per-task commits stay on the integration branch
until the build is discarded.

## 4. Security

- **A build runs code written by a session before anyone reads it.** The
  approved commands and the declared checks execute project code, including
  what the session just wrote, as the user, with the user's files; network
  proxies point nowhere but a program can ignore them. The start page and
  the README say this plainly. This is the user's decision 7.
- The approved list holds **exact commands** only: no wildcards, no
  prefixes. A compound command is allowed only if every part is on the list
  (reuse phase 7's matching). A command with a part that looks like a
  secret cannot be put on the list.
- No permission dialog during a build: anything not allowed is denied and
  recorded, never asked.
- The guard for task sessions is unchanged (writes only in the worktree,
  never `.git`, settings or hooks). Project hooks never run.
- Project text and the planner's output are data. Injected instructions are
  stopped by the guard, the command list, the server's diff validations
  (secrets, absolute paths, S10) and the user's final review.
- **Nothing reaches the default branch without the user's final
  approval.** Nothing is pushed.
- briefstack itself adds no network access.

## 5. Verification — definition of done

- Unit tests: queue schema and planner output validation; start validation
  (command list rules, secret-looking parts refused); the unattended
  permission mode (listed exact commands allowed, compound commands, all
  else denied without a dialog and recorded); checks after each round in
  builds only (ordinary tasks still wait for the click: S8 regression
  test); applying to the integration branch without touching the user's
  folder; worktree based on the integration head; dependency skipping;
  fix rounds; usage pause and resume (with and without `resets_at`, with a
  failed reading); restart leaves the build interrupted; cancel kills the
  tree; final apply refusals and revert.
- A fake planner and the fake task runner for all UI and API tests.
- End-to-end tests over the fakes: plan, edit and start a build; a task
  applied; a task left waiting (failed check, denied command) and its
  dependent skipped; a pause and a resume; cancel; apply the build and
  revert it; discard.
- Build, lint, unit and e2e pass; CI green on Linux, Windows and macOS.
- **Real check** in `scripts/real/`, prepared by Claude Code and run only by
  the user, on a temporary sample project with the saver profile: plan a
  short queue (two or three tasks), run it unattended, see one task applied
  and the final apply. Not run during implementation.
- Phase 9 is not done before the user runs the real check and accepts it.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.
Unlike phase 7, **do not stop after H0 and the plan** unless an item makes
a decision of §2 impossible or unsafe (then stop and report).

1. Applying a commit to a branch that is not checked out (`merge-tree`,
   `commit-tree`, `update-ref` with the old value), on the three systems,
   and basing a new worktree on it; what the user's folder sees.
2. The plan-usage reading: whether `rate_limits.*.resets_at` is filled for
   the user's login type, its format, and what the reading does when the
   window is exhausted. Only from the SDK's types and existing tests: **no
   real reading during implementation**; the real check confirms it.
3. Where phase 7's permission handler and command matching can take a
   pre-approved list and a "never ask" mode without changing ordinary
   tasks.
4. Where the declared checks run after a round today (they don't: S8) and
   the smallest change that runs them automatically for build tasks only.
5. What a created project offers to plan from (`docs/BRIEF.md` sections,
   `CLAUDE.md` commands, `package.json`), and the structured-output path
   for the planner session (as the creation flow does today, if it does).

## 7. Out of scope

Notifying the user (IDEAS §6 gateway). Builds in the cloud. Several builds
or tasks on one project at once. Pushing or pull requests. `claude-app`
projects and projects not created by briefstack. Codex inside the creation
flow (separate brief). Changing S8 for ordinary tasks.

## 8. Working rules

- Tag `phase-9-start` before the first change (if the tag is refused, record
  it and go on; the user creates it).
- `docs/PLAN-phase-9.md` with milestones and a Status section kept current.
- H0 first, then the plan, then the milestones, without a stop for
  approval, unless: an H0 item makes a §2 decision impossible or unsafe;
  the work needs a change to the guard, S8 for ordinary tasks, or phase 8's
  Codex module beyond reading its switch; any security doubt.
- Small commits, one concern each, gates green before each commit, CI
  checked after each push, CI green before the next milestone.
- Write and edit files only with the Write and Edit tools.
- No real SDK or Codex sessions; every test uses the fakes.
