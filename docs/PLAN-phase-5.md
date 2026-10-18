# briefstack — Phase 5 plan

Plan for phase 5: self-improvement of the creation flow. Scope comes from
[BRIEF-phase-5.md](BRIEF-phase-5.md); the decisions in its section 2 are the
user's. The user approved starting without reviewing this plan; decisions
taken without them are in `docs/decisions.md`, "Decisiones sin Dani
(fase 5)". H0 results are in the same file, "# Phase 5", "H0". The phase 4
plan is [PLAN-phase-4.md](PLAN-phase-4.md).

Starting point: tag `phase-5-start`. Work happens on `master` in small
commits, one concern each.

## 0. Status

Updated 2026-10-18. A new session reads `CLAUDE.md`,
`docs/BRIEF-phase-5.md`, this file and `docs/decisions.md` from
"# Phase 5" onwards before continuing.

### Done

| # | What exists now |
|---|---|
| H0 | All four checks PASS (decisions.md, "# Phase 5", "H0"); probe script `scripts/real/probe-h0-phase5.ts` |

### Left

M1–M9 below.

## 1. Approach

One rule from phase 4 still holds: **the server owns every action**. The
model in an improvement session can only write allowlisted text files in a
worktree; everything else (committing on the branch, validating, running
the checks, applying, reverting) is server code with tests.

| Need | Phase 5 |
|---|---|
| What may change | `src/improve/allowlist.ts`: agent bodies (`.claude/agents/*.md` that exist), the `/new-project` skill body, `library/templates/**` and `library/rules/**` (existing text files). Modify only: no new, deleted or renamed files |
| Locked blocks | `<!-- briefstack:locked <id> -->` … `<!-- /briefstack:locked <id> -->` in allowed files; `src/improve/locked.ts` compares the blocks (id, text, the heading they sit under, order) before and after |
| Personal data and secrets | `src/improve/filters.ts` on every added line: `secretLines`, this machine's home, user name and briefstack folders, and text copied from the library `profile` notes |
| Where the session works | a worktree under `<home>/improve/worktrees/<id>` on `improve/<id>`, made from the repo's current branch (H0 #1) |
| The session | `src/improve/sdkRunner.ts`: `cwd` the worktree, `settingSources: []`, `tools: [Read, Glob, Grep, Write, Edit]`, one MCP tool `submit_proposal`, the improvement guard (callback and command hook) and a `canUseTool` that repeats the guard's write check (H0 #1 finding); explicit model and effort from the active profile; no Bash, no web |
| Evidence | `<home>/improve/<id>/evidence/`: the request, the chosen lessons and the chosen sessions' panel data (review rounds, denials, text questions, failures), redacted. Read-only for the session; the prompt says it is data |
| Verification | the server commits the worktree on its branch, runs the validators, and only if they pass links `node_modules` (junction) and runs build, lint and tests (H0 #2, ~35 s) |
| Apply and revert | git plumbing with a temporary index, a three-way merge of each body and a compare-and-swap of the branch ref (H0 #4); never while a creation runs (H0 #3), queued until none does |
| Suggestions | `src/improve/suggestions.ts`: signals from the finished creation (lessons added, review rounds, guard denials, turns that ended in text, failures), no model; up to three per creation |
| Chat | read tools `list_suggestions`, `list_proposals`, `show_proposal`; action tool `prepare_improvement` behind a card |
| Pages | `#/improve` (suggestions, proposals, applied history), `#/improve/<id>` (proposal) |

### Improvement manager

`src/improve/manager.ts`, `ImprovementManager`:

- `prepare(request, evidence)`: one session at a time (`improve.busy`);
  makes the worktree and evidence, starts the runner, then
  `finishRound()`: commit the worktree changes on the branch, validate,
  verify, status `ready` or `rejected` (a validator failed) or `failed`.
- `askChanges(id, text)`: a new round on the same branch and worktree.
- `discard(id)`: removes the worktree (junction first) and the branch.
- `approve(id)`: refused unless `ready`; if a creation is active (this
  server's, or a session on disk that started, has not ended and is
  recent), status `waiting` and it applies when none is; apply refuses if
  the repo is not on the proposal's base branch, if an allowed file has
  uncommitted body changes, or if a body no longer merges. Then the
  worktree and branch are removed; the proposal keeps its diff.
- `revert(id)`: the same plumbing in reverse, same gate.
- Records under `<home>/improve/proposals/<id>.json`; the history is the
  applied ones.
- Optional real check (`startCheck(id)`): runs the matching
  `scripts/real/` check from the worktree with a temp home; only from the
  proposal page.

Runners: `SdkImprovementRunner` and `FakeImprovementRunner` (scripted file
edits and a `submit_proposal`), like the creation and chat runners.
Verifier: `NpmVerifier` and a fake one for tests.

## 2. Milestones

Each milestone ends with build, lint and unit tests green, a push and this
Status updated; e2e from M8.

### M1 — Allowlist, locked blocks, filters

- `allowlist.ts`, `locked.ts`, `filters.ts`, frontmatter split; unit tests.
- Locked markers around the security-relevant instructions of the skill and
  agents (web mode, denied calls, `.git`, secrets), and a test that they are
  there.

### M2 — Git layer

- `src/improve/git.ts`: worktree create and remove (junction), commit of a
  round, changed files and diff per file, `applyChanges` and
  `revertChanges` (H0 #4). Unit tests on temp repos: `usage set`
  frontmatter kept, master moved (merges and refusals), stale ref,
  uncommitted body, wrong branch.

### M3 — Guard and runners

- `src/improve/guard.ts` (rules, callback hook, `canUseTool` check) and
  `src/improve/guardCommand.ts` (command hook, deny only, fail closed).
- `src/improve/evidence.ts`, `sdkRunner.ts` (prompt, `submit_proposal`),
  `fakeRunner.ts`; SDK warning filter knows the new exact set.

### M4 — Improvement manager and API

- Manager, store, validators, `NpmVerifier`, the creation gate, apply and
  revert, real-check launcher; routes under `/api/improve`; `briefstack web`
  wiring; `docs/api.md`.

### M5 — Suggestions

- Signals, store, a creation observer on `CreationManager`, chat notice;
  `GET /api/improve` lists them.

### M6 — Chat tools

- `list_suggestions`, `list_proposals`, `show_proposal`,
  `prepare_improvement` (card); tool docs.

### M7 — UI

- `#/improve`, `#/improve/<id>` (diff, rationale and evidence, validators
  and tests, expected effect, real check with cost note, approve, ask for
  changes, discard, revert with confirmation), suggestions on the result
  screen and in the chat; English and Spanish.

### M8 — End-to-end tests and real scripts

- Playwright over the fake runners and verifier: prepare from the chat, see
  diff and tests, approve, the commit, revert; discard; ask for changes; a
  locked block and a forbidden path rejected; approval waiting for a
  creation; suggestions after a creation.
- `scripts/real/check-improvement-session.ts` (Haiku, temp clone, end to
  end) and `check-improvement-flow.ts` (one cheap creation with the
  proposal's assets); prepared, not run.

### M9 — Docs and hand-off

- `decisions.md`, `docs/api.md`, this Status, the real-run steps.

## 3. Real runs (prepared, run by the user)

Filled in at M9.
