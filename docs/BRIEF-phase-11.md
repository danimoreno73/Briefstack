# briefstack — Phase 11 brief: the build's board, and cards run in parallel

> `v1.2.0` is prepared and phase 10 is done. This file is the source of truth
> for phase 11. If something here conflicts with a later instruction in chat,
> follow the most conservative reading and record it in `docs/decisions.md`.
> Approved by the user on 2026-11-25, including working **unattended**: H0,
> the plan and the milestones go ahead without a stop for approval unless a
> stop condition in §8 is met.

## 1. What phase 11 is

A build (phase 9) plans a queue of tasks from the project's brief and runs
them **one after another**. On a real project that takes long. Phase 11 turns
the queue into a **board of cards** the user reviews and edits before the
build starts, and lets the build run **several independent cards at once**,
each in its own worktree, joining each one to the integration branch when it
is done.

## 2. Decisions confirmed by the user (2026-11-25)

1. **Order:** this phase comes before running briefstack on the user's home
   server (a later phase) and before Telegram notices.
2. **The board lives inside briefstack:** a page of its own, with columns,
   no outside account (no Trello, no credentials).
3. **The board is the build's queue:** the planner produces the cards; the
   user edits and approves them; the build runs in parallel the cards that
   do not depend on each other. It reuses the integration branch, the exact
   command list, the checks, fix rounds, the usage pause and the final apply
   of phase 9.
4. **Conflicts: avoid, then retry once.** The planner marks the **area**
   each card touches; the build never runs at the same time two cards of the
   same area. If two cards still collide when joined, the card is redone
   **once** on top of what was already joined; if it collides again, it
   waits for the user.

Defaults chosen by the advisor, open to change in the plan (record each in
`decisions.md`):

5. **Parallel slots:** set at the build's start, 1 to 4, default 2. Each slot
   counts in the active-sessions limit; a full limit makes a card wait, as
   today. **One slot behaves exactly as today** (regression tests).
6. **Usage:** the start page warns that parallel cards spend the plan's
   5-hour window faster (more work at once, not more work per window). The
   plan usage is read before each card starts; at the threshold no new card
   starts, running cards finish, and the build pauses and resumes as today.
7. **A card holds:** title, instruction, "done when", dependencies, area
   (paths or folders it is expected to touch), size (S, M, L) and state.
   The planner's structured output gains area and size.
8. **Columns:** Pending, Blocked (a dependency is not done), Running,
   Waiting (for the user: rules failed or a second conflict), Done
   (applied), Skipped. Before the start the user can edit a card's text,
   dependencies and area, remove it, add one by hand, and change the order
   of priority (buttons; drag and drop only if cheap and accessible). After
   the start the board is read-only, with today's actions (pause, resume,
   cancel, open a waiting card as an ordinary task, apply, discard).
9. **Joining a card:** a card's worktree starts at the integration branch's
   head at that moment. When its rounds pass the rules, the join is
   computed with `merge-tree` from the card's start onto the current head,
   **one join at a time** (the integration ref moves only with
   compare-and-swap). If other cards were joined meanwhile, the **checks run
   again on the joined tree** before the ref moves; a failure there or a
   textual conflict sends the card to its one redo on the new head; a second
   failure leaves it waiting.
10. **Scope:** builds only. The creation's `implement` step (phase 10) stays
    single. Builds still offer no Codex.

## 3. Features

- **Planning:** the planner returns cards with area and size; the server
  validates them (areas inside the project, dependencies only on earlier
  cards, no cycles).
- **The board page** before the start (edit, add, remove, reorder, slots,
  plus today's start settings) and during and after the run (columns live,
  each card with rounds, checks, denied commands, tokens, its join and, when
  it waits, the reason).
- **The scheduler:** picks the next ready card by priority among those whose
  dependencies are done and whose area does not overlap a running card;
  fills free slots; respects the usage pause, the shared limit, the cap of
  rounds and cancel (cancel stops every running card's tree).
- **Restart:** a server restart leaves the build interrupted with every
  running card interrupted; resuming starts them again from the integration
  head (their worktrees are discarded).
- **API and docs:** `docs/api.md`, README (parallel cards, the usage note),
  CHANGELOG «Unreleased».

## 4. Security

Nothing of phase 9's model changes: every card is a build round with the
exact list, no dialog, checks after the round, applied only to the
integration branch, nothing on the default branch before the user's final
apply, nothing pushed. Parallel cards each run in their own worktree under
the same guard. **Joins never skip checks:** a card joined onto a head that
moved is checked again on the joined tree. Areas are scheduling hints, not
a boundary: a card may still write anywhere in its worktree, and the diff
validations and the join catch the rest.

## 5. Verification — definition of done

- Unit tests: card schema and validation (areas, dependencies, cycles);
  the scheduler (ready cards, areas never overlapping, priority, slots, the
  shared limit, usage pause with running cards, cancel with several trees,
  restart); joins (clean, textual conflict, checks failing only on the
  joined tree, the one redo, second failure waits, compare-and-swap with
  two joins racing); one slot equals today's behaviour (phase 9's tests
  pass unchanged).
- The fake runner for all UI and API tests; e2e: edit a board and start it,
  two cards running at once, a conflict redone and joined, a card waiting
  after a second conflict, apply the build.
- Repeat the race and scheduler tests 20 times. Build, lint, unit and e2e
  pass; CI green on Linux, Windows and macOS.
- **Real check** in `scripts/real/`, prepared by Claude Code and run only by
  the user: a fixed board of four cards where two independent cards run at
  the same time (seen in the log), one deterministic conflict that is
  redone and joined, and the final apply. Not run during implementation.
- Phase 11 is not done before the user runs the real check and accepts it.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.
Do **not** stop after H0 and the plan unless an item makes a §2 decision
impossible or unsafe.

1. Where phase 9's build loop and phase 7's "one task per project" rule
   assume one running task, and the smallest change that allows several
   task sessions of one build at once without changing ordinary tasks.
2. Several worktrees of one project at once on the three systems (names,
   locks, cleanup), and `merge-tree` from a card's start onto a moved head:
   clean, conflicting, and the result tree to check.
3. Running the checks on a joined tree that is in no worktree yet (a
   temporary worktree at the joined tree, then removed), with today's
   limits.
4. The planner's structured output with two new fields, within the SDK's
   draft-07 limits.
5. The active-sessions limit and the plan-usage reading with several cards
   starting close together.

## 7. Out of scope

Running briefstack on a server; Telegram; Codex in builds; parallel steps
inside a creation; several builds of one project at once; Trello or any
outside board.

## 8. Working rules

- Tag `phase-11-start` before the first change (if refused, record it and go
  on; the user creates it).
- `docs/PLAN-phase-11.md` with milestones and a Status section kept current.
- H0, then the plan, then the milestones, without a stop for approval,
  unless: an H0 item makes a §2 decision impossible or unsafe; the work needs
  a change to the tasks' guard, S8 for ordinary tasks, phase 9's security
  model, or the creation flow; any security doubt.
- Small commits, one concern each, **gates green before each commit, commit
  by commit**, CI checked after each push, **CI green before the next
  milestone**.
- Write and edit files only with the Write and Edit tools.
- No real Claude or Codex sessions.
