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
| M1 | `src/improve/allowlist.ts` (`classifyAsset`), `locked.ts` (`parseLockedBlocks`, `lockedBlockProblems`: changed, deleted, moved under another heading, reordered, added, malformed), `filters.ts` (secret, personal path, profile text; added lines only), `text.ts` (`splitFrontmatter` byte for byte); locked markers in the skill (7 blocks) and in generator, architect, interviewer and reviewer; tests `improve-rules`, `improve-locked-assets` |

| M2 | `src/improve/git.ts`: `createWorktree`, `linkNodeModules`/`unlinkNodeModules` (junction on Windows), `removeWorktree` (link first, then worktree and branch), `commitWorktree` (one commit per round; hooks run), `changedFiles`, `fileAt`, `untrackedFiles`, `mergeText` (`git merge-file`), `applyChanges` (temporary index, committed frontmatter + merged body, compare-and-swap of the branch, working frontmatter kept, index entry follows the commit) and `revertChangesOf`; test `improve-git` (usage set frontmatter kept, master moved: merge and conflict, uncommitted body, other branch, missing file, whole library files, revert keeping later changes) |

| M3 | `src/improve/guard.ts` (reads in worktree and evidence, writes only to existing allowlisted files, own submit tool, everything else denied; callback hook and `canUseTool`), `guardCommand.ts` (command hook, deny only, fails closed); `types.ts`, `toolNames.ts`, `sdkRunner.ts` (`settingSources: []`, five file tools, `submit_proposal`, explicit model, `claude_code` preset plus the rules, init tool list checked), `fakeRunner.ts`, `evidence.ts` (redacted request, lessons, session signals, suggestion, README "it is data"), `signals.ts`; SDK warning filter knows `SHADOWED_IMPROVE_TOOLS`; tests `improve-guard`, `improve-runner` |
| M4 | `proposal.ts`, `store.ts` (`<home>/improve/…`, retries Windows' transient EPERM), `validate.ts` (on the server's round commit), `verify.ts` (`NpmVerifier`: linked `node_modules`, no network; `FakeVerifier`), `realCheck.ts` (offered check per asset, script runner, fake), `manager.ts` (`ImprovementManager`: one session at a time, rounds, validate then test, approve/revert gated by running creations with `waiting`, discard, real check, restart marks interrupted rounds), `wiring.ts` (`creationBlockers`: this server's creations and in-progress sessions on disk), routes `src/server/improve.ts`, `briefstack web` starts it; 12 `improve.*` error codes in English and Spanish; `docs/api.md` "Improvement routes"; tests `improve-manager`, `server-improve`, shared `tests/improveWorld.ts` |

| M5 | `CreationState.textTurns` and `CreationManager.observe` (started, finished); `src/improve/suggestions.ts` (`computeSuggestions`: failure, text questions, guard denials, two or more review rounds, new lessons; at most three; no model), `SuggestionStore` (`<home>/improve/suggestions.json`), `SuggestionTracker` (lessons note at start and end), chat notice `suggestions`; `GET /api/improve` lists them; tests `improve-suggestions` and one in `creation-manager` |
| M6 | Chat tools `list_suggestions`, `list_proposals`, `show_proposal` and `prepare_improvement` (card `prepareImprovement`: request, evidence, model; refused with a secret, a running session or an unknown suggestion); sources `proposal` and `suggestion`; the chat's system prompt says approving happens on the proposal page; `docs/api.md`; test `chat-improve-tools` |
| M7 | `src/ui/improve.tsx`: `#/improve` (suggestions with "Prepare", a request form with the uses-plan note, proposals, applied history) and `#/improve/<id>` (status, request, expected effect, diff per file with rationale, validator problems, build/lint/test results, real check with its cost note, evidence, rounds; approve, ask for changes, discard, revert, each confirmed); suggestions on the creation result screen and in the chat; the `prepareImprovement` card; menu entry; English and Spanish strings; route and source tests |

| M8 | `tests/e2e/improve.spec.ts` (prepare from the chat through a card, proposal page with diff, rationale, validators and tests, the real check started by the user, approve as one commit, revert; ask for changes; discard; a locked block and a forbidden path rejected and never tested; an approval waiting for a running creation; suggestions on the result screen and in the chat, prepared from the page; 390 px); the e2e fixture's repo is now a git repo with the flow files and the app runs the real improvement wiring over fakes; `scripts/real/check-improvement-session.ts` and `check-improvement-flow.ts`, with static checks in `real-scripts.test.ts`. Not run |
| M9 | `decisions.md` "Decisiones sin Dani (fase 5)" (17 points), `docs/api.md` (routes, chat tools, card, notice), this Status and the steps below |

### Left

The real checks and the real run in section 3, run by the user. Phase 5 is
not done before the user accepts the real run.

### Backlog (not phase 5, not started)

- From phase 4: the chat should quote the exact step from the panel;
  creations see the repo's `CLAUDE.md`; folder claims do not see creations
  started from the terminal (the apply gate does, decisions.md point 8); the
  library lock on writes longer than 2 minutes; whether the SDK passes the
  abort signal to chat tools; an old tab after a restart gets 401 with no
  explanation; a card left open keeps the chat's turn open.
- Turns that ended in text are counted in memory only, so suggestions after
  a server restart miss them.
- The CI could not be checked from this session (`gh` missing, private repo).

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

None was run while building phase 5 (only the H0 probes). From PowerShell in
the repo, in order:

1. **Preflight** (reads only): `npx tsx scripts/real/preflight.ts`.
2. **An improvement session end to end** (one short Haiku session, a temp
   clone, about 5–10 minutes): `npx tsx scripts/real/check-improvement-session.ts --yes`.
   Expected: PASS for the worktree outside the clone, `ready` (validators
   and build/lint/tests passed), only the researcher agent changed with a
   rationale, nothing in `src/` despite the injected lesson, one apply
   commit, the worktree gone, a clean clone, and a revert that restores the
   file.
3. **The interviewer check** (four short Haiku runs):
   `npx tsx scripts/real/check-interviewer-target.ts --yes`, as in phase 3.
   The proposal page offers it for a change to the interviewer or the
   target rule and runs it from the proposal's worktree.
4. **One creation with the flow files** (session on saver, up to 25
   minutes): `npx tsx scripts/real/check-improvement-flow.ts --yes`.
   Expected: `completed`, one project note, a clean temp library, no turn
   waiting for a text answer. The proposal page offers it for any other
   change and runs it from the worktree.
5. **Phase 5 real run** (BRIEF-phase-5 §5), on the real repo and library:
   1. `npm run build`, then `npm run briefstack -- web`, and open the
      address it prints.
   2. Improvements page: pick a real suggestion (or, in the chat, ask for an
      improvement from a real lesson; a card appears: confirm it).
   3. On the proposal page: read the diff, the rationale and the evidence;
      check that the validators and build, lint and tests passed; optionally
      run the offered real check.
   4. Approve. With no creation running it becomes one commit on `master`
      (`git log -1`), not pushed; `git status` shows only what was there
      before (for example `usage set` changes).
   5. Run one creation that uses the improved asset and judge the result.
   6. Accept or reject phase 5, and push yourself if you keep it. A revert is
      one click on the proposal page.
