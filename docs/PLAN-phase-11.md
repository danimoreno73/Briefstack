# briefstack — Phase 11 plan: the build's board, and cards run in parallel

Plan for [BRIEF-phase-11.md](BRIEF-phase-11.md). H0 is in
[decisions.md](decisions.md), "Phase 11: H0", with sources and dates; this
plan follows from it. Work happens on `main`, from the brief's commit
`edeb8aa` (the tag `phase-11-start` was refused to the session; the user
creates it). Small commits, one concern each; build, lint, unit and e2e
tests green before each commit; CI checked after each push and green on
Linux, Windows and macOS before the next milestone.

**Not approved by the user before the work:** the brief lets H0, the plan
and the milestones go ahead unattended (its §8). Every choice made without
the user is in decisions.md, "Decisiones sin Dani (fase 11)".

## 0. Status

Updated 2026-11-26.

| # | Milestone | State |
|---|---|---|
| H0 | Verify before designing (BRIEF §6) | done (`ce3947a`), decisions.md "Phase 11: H0" |
| M1 | Cards: area and size, validation, the planner's output, older builds read as before | done (`b52701e`; review fixes `fb0368d`; CI green on the three systems, run 45683240725): decisions.md "Phase 11: M1, M2 and M3" |
| M2 | Several worktrees per build and the join: `merge-tree` onto a moved head, checks on the joined tree, one join at a time | done (`f81f05e`; review fixes `d82f0b0`; CI green, run 45688275973): `joinForBuild`, `discardForBuild`, the temporary worktree; the join tests 20 of 20 |
| M3 | The scheduler: slots, areas, priority, the shared limit, usage and user pauses with cards at work, cancel of several trees, restart, the one redo | done (`6fbe96a`, CI red on a test that assumed the order sessions open; review "no apto", B1, I2, I3, I4 fixed in `71133bc`, CI green, run 45720863924): the scheduler, join and phase 9 loop tests 20 of 20 |
| M4 | The board page: before the start (edit, add, remove, reorder, slots) and during and after (columns, live) | done (`346219e`, CI green, run 45723000181; review fixes `385b947`, whose Windows run passed the 30 s test timeout in a scheduler test, given 90 s in `5083872`, and the default timeout 60 s in `ee5b23c`): the board's e2e tests 20 of 20; decisions.md "Phase 11: M4 and M5" |
| M5 | Docs and `scripts/real/check-build-parallel.ts` (prepared, not run) | written (`4254bf8` the script and its static tests, its review's fixes `94e73e2`, the docs in the next commit; their CI pending when this was written); the script not run |
| Real | The real check, run by the user | not run |
| Accepted | The user's acceptance | — |

## 1. Design decisions taken from H0

Each one is the conservative reading and is in decisions.md.

1. **A card is a build task with two more fields.** The queue item gains
   `area` (1 to 10 relative paths or folders, each at most 200 characters,
   with `/`; no absolute path, drive, `..` segment, backslash, wildcard or
   control character; `.` is the whole project) and `size` (`S`, `M`,
   `L`). Both are **required in the planner's JSON schema** and
   **optional everywhere else** (the stored plan, the start body, the
   record), so builds planned before phase 11, the API without them and
   phase 9's tests read and run as they did. A card without an area counts
   as touching the whole project. Its state is phase 9's task state; the
   board's columns are derived from it (decision 8).
2. **Validation** at the start, as phase 9's: every field of a card with
   its own issue code; dependencies only on earlier cards (so no cycle can
   exist, and the board's reorder keeps that rule, decision 9); the slots
   1 to 4. The planner's output is validated with the same rules.
3. **Areas overlap** when a path of one is equal to, or a folder above or
   below, a path of the other, compared without case (Windows and macOS
   ignore it; the conservative side is more overlap). `.`, or no area,
   overlaps everything.
4. **Slots**: a start setting, 1 to 4; the API's default when the body
   has none is **1** (phase 9's behaviour, and its tests), the page's
   default is 2 (the brief's §2, 5). A record without `slots` runs with
   one. With one slot the loop starts one card, waits for its end and its
   join, then picks the next: phase 9's order, readings and pauses.
5. **The cap of rounds**: phase 9's (cards × (1 + fix rounds), at most 40)
   with one slot; with more, twice that (each card may be redone once),
   still at most 40.
6. **The join** (BRIEF §2, 9; H0, 2 and 3). After a card's round passes
   the rules, the build joins it, one join at a time per build:
   - head still where the card started: phase 9's apply (its own tree,
     compare and swap);
   - head moved: `merge-tree` from the card's start onto the head; a
     textual conflict sends the card to its redo; otherwise the joined
     commit is made with `commit-tree`, the build's checks run on it in a
     temporary detached worktree (`<home>/tasks/<id>/join`, removed
     whatever happens; the task is `checking` meanwhile, so it counts in
     the shared limit, and a cancel or a stop ends them), and the branch
     moves onto **that commit** with the compare and swap. A failure there
     sends the card to its redo. With no checks the joined commit lands
     after `merge-tree` alone (the user confirmed a start without checks).
   - a compare and swap lost (the user approved a waiting card onto the
     branch meanwhile) reads the head again and joins again, at most three
     times, then the card waits (`notApplied`).
   This is the task manager's build-only `joinForBuild`: refused for a
   task without a build (as `runBuildChecks`), called by no route, so S8
   for ordinary tasks and the checks invariant stay as they are.
7. **The redo** (BRIEF §2, 4 and 9): the card's task is discarded (its
   worktree and branch go) and a new task starts at the integration head
   with the card's text and a line saying its first attempt collided
   with cards joined meanwhile; its rounds count. A second conflict, or
   checks failing again on a joined tree, leaves the card **waiting**
   (`conflict`, `joinChecksFailed`) with its second task kept open for the
   user, as any waiting task; its dependents are skipped.
8. **Columns** (BRIEF §2, 8), derived on the page from the card's state
   and the others': Pending (queued, dependencies applied), Blocked
   (queued, a dependency not applied yet), Running, Waiting (for the
   user), Done (applied), Skipped (skipped, and cancelled by a cancel of
   the build). The table of phase 9 stays below the columns, in the
   cards' order, with every detail.
9. **Before the start** the board edits each card's title, instruction,
   "done when", dependencies, area and size; removes a card; adds one by
   hand; and moves a card up or down in priority with buttons (no drag
   and drop), refused when it would put a card above one it depends on.
   After the start the board is read-only, with phase 9's actions.
10. **The scheduler** (M3): the build manager keeps its running cards
    instead of one task; it starts the first card in priority order whose
    dependencies are applied and whose area overlaps no running card's,
    while a slot is free, the cards started stay under "how many to run"
    and the cap of rounds holds; a full shared limit makes a card wait for
    a place, as today. Every change of the record goes through one lock
    per build (H0, 1). The waits for a place and for the usage reading are
    all woken by a cancel or a stop.
11. **Usage** (BRIEF §2, 6; H0, 5): one reading before each pass that
    would start a card (one card per pass with one slot; with more, the
    cards a pass starts share the reading made just before). Over a
    threshold no card starts; the cards at work go on; the build pauses,
    as today, once none is at work (a reading is made again when a card
    ends and another could start). The user's pause: no card starts, the
    build pauses once none is at work.
12. **Cancel** ends every running card's round or checks (the task
    manager's cancel, which ends each process tree) and the join checks;
    the build is cancelled once no card is at work.
13. **Restart** (BRIEF §3): a build left running is interrupted, every
    running card waiting (`interrupted`), as today. Resuming a build with
    more than one slot discards those cards' tasks and queues them again
    at the integration head. With one slot an interrupted card stays
    waiting for the user, as phase 9's tests require.
14. **What does not change**: the guard, S8 for ordinary tasks, the exact
    list and the unattended rounds, the integration branch and the final
    apply, the creation flow and its `implement` step, Codex (builds still
    offer none). A waiting card the user approves on its own page goes to
    the integration branch as in phase 9 (the user's own approval, with
    checks on their click).

## 2. Milestones

### M1 — Cards

- `src/builds/types.ts`: `area`, `size` (optional) on the queue item and
  the build task; `slots` in the settings; `CARD_SIZES`, `MAX_SLOTS`,
  area limits; `areaPathProblem`, `areasOverlap`; the planner's own strict
  schema with both fields required.
- `src/builds/planner.ts`: the planner's JSON schema from that strict
  schema (draft-07), its prompt asks for areas and sizes; the output
  validated with the shared rules.
- `src/builds/manager.ts`: start issues for areas, sizes and slots;
  cards stored with area and size; `slots` recorded when given (a record
  without it runs with one).
- `src/builds/commands.ts`, `src/i18n/ui.ts`, `src/i18n/errors.ts`: the
  new issue codes in English and Spanish.
- Tests: schema and validation (areas, sizes, dependencies, slots), the
  overlap rule, the draft-07 schema with the new fields, an older record
  and an older plan read and started as before.

### M2 — Several worktrees and the join

- `src/builds/git.ts`: `prepareJoin` (merge-tree from a start onto a
  head, the joined commit, or the conflicted files) and `moveIntegration`
  (the compare and swap, refused when a worktree has the branch checked
  out).
- `src/tasks/manager.ts`: `joinForBuild(id, checks)` (decision 6),
  `discardForBuild(id)` (the build's own discard of a card it drives).
- Tests: several build tasks of one project at once (their worktrees,
  commits and clean-up), clean join, join onto a moved head, textual
  conflict, checks failing only on the joined tree, the temporary
  worktree removed, two joins racing on the compare and swap, a stop
  during the join checks.

### M3 — The scheduler

- `src/builds/manager.ts`: the loop with running cards (decision 10), the
  join and the redo (decisions 6, 7), usage and pauses (11), cancel (12),
  restart and resume (13), the record lock, waits woken together; the
  build view says which cards wait for a place.
- `src/builds/prompt.ts`: the redo's line.
- Tests: ready cards, areas never overlapping, priority, slots, the
  shared limit, usage pause with running cards, the user's pause with
  running cards, cancel with several trees, restart and resume, the redo
  then joined, a second conflict waiting, checks failing on the joined
  tree; one slot equals phase 9 (its tests unchanged). The race and
  scheduler tests repeated 20 times.

### M4 — The board page

- `src/ui/builds.tsx`, `src/ui/types.ts`, `src/i18n/ui.ts`: the start page
  as a board of cards (decision 9) with area and size, add a card, the
  slots and the usage note (parallel cards spend the 5-hour window
  faster); during and after the run, the columns (decision 8) with each
  card's rounds, checks, denied commands, tokens, its join and the reason
  it waits; the table below.
- e2e (fake runner, fake planner): edit a board and start it; two cards
  running at once; a conflict redone and joined; a card waiting after a
  second conflict; apply the build. Phase 9's e2e tests unchanged.

### M5 — Docs and the real check

- README (parallel cards, areas as hints, the usage note), `docs/api.md`
  (cards, slots, the join, the new reasons), CHANGELOG «Unreleased»,
  decisions.md.
- `scripts/real/check-build-parallel.ts`, prepared and **not run**: a
  fixed board of four cards, two independent ones at the same time (seen
  in the log), a deterministic conflict redone and joined, the final
  apply; its static checks in `tests/unit/real-scripts.test.ts`.
