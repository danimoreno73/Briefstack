# briefstack — Phase 9 plan: builds

Plan for [BRIEF-phase-9.md](BRIEF-phase-9.md). H0 is in
[decisions.md](decisions.md), "Phase 9: H0", with sources and dates; this
plan follows from it. Work happens on `main`, from tag `phase-9-start`.
Small commits, one concern each; build, lint, unit and e2e tests green
before each commit; CI checked after each push and green on Linux, Windows
and macOS before the next milestone.

**Not approved by the user before the work:** the brief lets H0, the plan
and the milestones go ahead unattended (its §8). Every choice made without
the user is in decisions.md, "Decisiones sin Dani (fase 9)".

## 0. Status

Updated 2026-11-17.

| # | Milestone | State |
|---|---|---|
| H0 | Verify before designing (BRIEF §6) | done, decisions.md "Phase 9: H0" |
| M1 | Build record and store; the integration branch; tasks based on it | done (`804fba1`, `e96a131`, `f0aca14`; review fixes `4a2b71b`): `src/builds/types.ts`, `store.ts`, `git.ts`, build-aware preconditions. The manager's start of a build's task moved to M2 (below). Review: I1 (scope) moved to M2, I3 (docs and `merge-tree`) aligned, I4 (relaxed checks without a build) fixed; minors in IDEAS §9 |
| M2 | Unattended task rounds: the exact list, no dialog, checks after each round in builds only, rules, fix rounds | done (`971b8b4`, `a259a5c`; review fixes `deea60d`): `src/builds/commands.ts`, `prompt.ts`; `TaskManager.startForBuild`, `newBuildRound`, `runBuildChecks`, approving a build's task onto the integration branch; the runners' unattended mode. Review: I1 (items several commands to some shell) fixed with a safe character set, I2 (refused question unrecorded by the real runner) fixed, I3 (Codex outside the list) resolved by no Codex in build rounds, for the user to decide, I4 (commands allowed for the task) fixed; minors in IDEAS §9 |
| M3 | The planner (fake and SDK) and the start page | pending |
| M4 | The loop: order, dependencies, usage pause and resume, restart, cancel | pending |
| M5 | The build page: progress, cumulative diff, apply, revert, discard | pending |
| M6 | Docs and the real check script (prepared, not run) | pending |

## 1. Design decisions taken from H0

Each one is the conservative reading and is in decisions.md.

1. **A build drives ordinary tasks.** Each queued item becomes a phase 7
   task (its record, worktree, guard, validations, proposal page), marked
   with the build it belongs to (`build: { id, n }` in the task record,
   additive: older records read as they did). The guard, the command hook,
   `TaskApprovals.decide` and S8 for ordinary tasks do not change (H0, 3
   and 4).
2. **The integration branch** is `briefstack/build-<id>`, made at the
   default branch's head when the build starts (`update-ref` that refuses
   an existing ref). It is never checked out in the user's folder. A build
   task's worktree starts at its head; its record's `baseBranch` is the
   integration branch and its `baseCommit` that head, so its diff, its
   validations and its proposal page show the task's own change.
3. **Applying a task to the integration branch** is `merge-tree` of the
   task's change (from its base to the reviewed commit) onto the
   integration head read just before, `commit-tree` with that head as the
   one parent, then `update-ref` with that head as the old value (H0, 1).
   In the loop a task always starts at the head, so the result is the
   task's own tree; a waiting task the user approves later, after other
   tasks were applied, is combined the same way, and a conflict is refused
   (`task.conflict`), as for a task's approval. Also refused when a
   validation blocks, the task's branch moved since the review, or the
   head moved between the read and `update-ref` (`build.branchMoved`). The task's worktree and branch
   go, as after an approval; the task becomes `applied`, with the
   integration commit; nothing is written in the user's folder or library
   note (that happens once, when the whole build is applied). A build
   task's revert is refused: only the whole build is reverted.
4. **An unattended round** is a task round the build starts. The manager
   answers its shell and web requests itself: a command that is exactly an
   item of the build's list, or a compound of `&&`, `||` or `;` whose every
   part is exactly an item, is allowed once; anything else (web requests
   included) is denied without a dialog and recorded on the build. A
   question is refused by the runner with "decide yourself". The turn's
   end ends the round. Its prompt says all of this and lists the approved
   commands, the task's "done when" and, in a fix round, the failing
   checks' output. It never offers Codex (review of M2, I3: Codex's
   commands would not pass through the list); the user's own rounds on a
   waiting task do.
5. **The approved list** holds exact commands only: no wildcard, no
   prefix, each a single line within the declared checks' limits; a
   command with a part that looks like a secret is refused at the start
   (`redactSecretLines` changes it). Compound items are not accepted on the
   list itself (each part is its own item).
6. **Checks after each round, builds only** (`runBuildChecks`, H0, 4):
   the build's recorded checks, after the round's commit and validations,
   with today's runner (proxies pointed nowhere, 10 minutes per command).
   A task without a build is refused. No route calls it.
7. **The rules** for applying a task unattended: no blocking validation,
   every check exits 0 without a timeout, and no command was denied in the
   task. Otherwise a fix round runs (a run setting, 0 to 2, default 1) with
   the failing output; when the rules still fail, or the round itself
   failed, the task is left **waiting** with the reason, and the tasks
   that depend on it, directly or not, are **skipped**. A per-build cap on
   rounds (default: the queue's length × (1 + fix rounds), at most 40)
   stops a build that would run longer.
8. **A waiting task** is handled by the user as an ordinary task, on its
   own page: rounds with dialogs, checks on click, discard. Its approval
   goes to the **integration branch** (decision 3), never the default
   branch: nothing reaches the default branch without the final approval
   (BRIEF §4). After it, the user can resume the build, and the tasks that
   were skipped only because of it are queued again.
9. **Usage**: read before each task. At or above a threshold (default
   from Settings, editable at the start), the build pauses until the
   window's `resets_at` when it is a valid time in the future, otherwise
   it reads again every 15 minutes; a reading that fails pauses and is
   retried on the same interval; "not available for this login" never
   pauses (H0, 2). "Resume" from the page skips the reading for the next
   task: the user's explicit choice.
10. **Restart**: a build left `running`, `paused` or `planning` by the
    last server is `interrupted`; its running task is interrupted by the
    task manager's own recovery and becomes waiting. Nothing resumes by
    itself. **Cancel** stops the running round (the task manager's cancel,
    which kills the process tree, Codex included) or the running checks,
    and leaves the integration branch as it is.
11. **One build or task per project at a time**: a build cannot start
    while a task or another build is open on the project; an ordinary task
    cannot start while a build is open; the build's own waiting tasks do
    not block its next tasks. Builds share the active-sessions limit
    (each running round or check counts, as a task's).
12. **The planner** (H0, 5): a session with no tools (`tools: []`, no MCP
    server, no setting sources, nothing allowed), `cwd` an empty folder of
    the build's, the brief, `CLAUDE.md` and the `package.json` scripts in
    the prompt as data, and `outputFormat` with the queue's JSON schema;
    the result is validated again with zod. It returns the queue (title,
    instruction, done when, dependencies), proposed commands and proposed
    checks; nothing is approved until the user starts the build. A fake
    planner serves every UI and API test. Model and effort: the profile's
    `work` entry (no new profile entry, so the user's own presets keep
    loading).
13. **Applying the build**: one commit on the default branch with the
    integration branch's whole change (from the build's base), with the
    same `merge-tree`, compare-and-swap and refusals as a task's approval
    (folder not clean, another branch checked out, the change no longer
    applies, merge drivers, a task or build running on the project).
    Revert is one commit the other way. Discard removes the integration
    branch and every open worktree of the build's tasks.
14. **Storage**: `<home>/builds/<id>/build.json`, saved in order as task
    records are; the planner's folder `<home>/builds/<id>/plan/`.

## 2. Milestones

### M1 — Build record, store, integration branch

`src/builds/types.ts` (zod schema of the record and queue), `store.ts`,
`git.ts` (create the integration branch, apply a task to it, delete it,
its head). Task record: optional `build`. Preconditions: an open build
holds the project; a build's task skips the folder's branch and files only
for the build that holds the project. Tests: the schema; the store;
applying to the integration branch leaves the user's folder untouched
(status, `HEAD`, files) and refuses a stale head; a new worktree is based
on the integration head.

**Moved to M2** (review of M1, I1): the task manager's start of a build's
task and its wiring of `buildOn`. Starting a build's task always starts an
unattended round, so it cannot be committed apart from M2's rounds; until
M2, `task.buildOnProject` has no caller in the manager.

### M2 — Unattended rounds

Task manager and runners: the unattended round (decision 4), its prompt,
the finish on the turn's end, questions refused, the exact-list matching
and the denied record; `runBuildChecks`; apply a task to the integration
branch; a new unattended round (fix round). Tests: listed commands allowed,
compound commands, everything else denied without a dialog and recorded;
an ordinary task still opens the dialog and still runs no check by itself
(S8 regression test, next to the existing invariant); checks after a build
round; fix round; apply to integration.

### M3 — Planner and start page

`src/builds/planner.ts` (SDK and fake), the queue schema, the start
validation (list rules, secret-looking parts refused, dependencies that
exist and come earlier), the build manager's plan and start, the routes,
the project page's "Implement" button and the start page (queue: order,
text, dependencies, remove; how many; commands; checks; fix rounds;
thresholds; the warning of BRIEF §4). Tests: schema and output validation,
start validation, routes, e2e plan, edit and start.

### M4 — The loop

Order, dependencies and skipping, the limit of tasks, the cap of rounds,
the usage pause and resume (with and without `resets_at`, a failed
reading), pause by the user, restart = interrupted, cancel kills the tree.
Tests with the fake runner, 20 repetitions for the timing ones.

### M5 — The build page and the final apply

Progress table (state, rounds, denied commands, checks, Codex calls,
tokens), pause reason and resume time, cumulative diff, actions (pause,
resume, cancel, open a waiting task, apply, revert, discard). Tests: apply
refusals and revert, discard; e2e: a task applied, a task waiting and its
dependent skipped, pause and resume, cancel, apply and revert, discard.

### M6 — Docs and the real check

README ("a build runs code before you read it", what it does, limits),
`docs/api.md`, decisions.md; `scripts/real/check-build.ts` prepared (not
run): `--yes`, the spend warning, a temp sample project, the saver
profile, a short queue of two or three tasks, one task applied and the
final apply.
