# briefstack — Phase 5 brief: Self-improvement

> Phase 5 of 5. Phase 4 (global chat and several creations) is done and tagged
> `phase-4-done`. This file is the source of truth for phase 5 scope. If
> something here conflicts with a later instruction in chat, follow the most
> conservative reading and record it in `docs/decisions.md`.

## 1. What phase 5 is

briefstack proposes and applies improvements to **its own creation flow**:
the instructions of its agents, its skill, the templates and the rules of the
base library. It learns from what happened in real creations (lessons,
review rounds, denials, questions asked in text, failures) and from what the
user asks for in the chat.

Every improvement is prepared apart, verified, shown to the user as a diff
with its evidence and test results, and applied only when the user approves
it. Every applied improvement can be reverted from the web.

## 2. Decisions confirmed by the user

1. **Scope:** only text assets of the creation flow (section 3.1). No code,
   no settings, no hooks. The guard and every security mechanism are out of
   reach.
2. **Trigger:** when the user asks (from the chat), plus up to three
   suggestions after each finished creation. A suggestion changes nothing
   until the user asks for it to be prepared.
3. **Applying:** an approved improvement becomes one local commit on
   `master`. The user pushes. Reverting is one click (with confirmation) that
   makes a revert commit.
4. **Verification:** build, lint and all tests always run before the user
   sees a proposal. For changes that affect model behaviour, the proposal
   page offers an optional cheap real check (Haiku or the saver profile,
   temporary home), started only by the user.

## 3. Features

### 3.1 What can change

- An **allowlist defined in code** (one module), which self-improvement can
  never modify. Initially:
  - the body of each agent file in `.claude/agents/` (never the frontmatter:
    `tools`, `model` and `effort` stay as they are);
  - the body of the `/new-project` skill (never its frontmatter);
  - the base library templates and rules shipped in the repo.
- **Locked blocks:** security-relevant instructions inside allowed files
  (for example "never ask in text in web mode", the rules for denied calls)
  are wrapped in explicit markers. A proposal that changes, moves or deletes
  a locked block is rejected.
- Everything else is out of reach: `src/`, `scripts/`, `tests/`, settings
  files, hooks, `package*.json`, CI, the briefs and plans, `CLAUDE.md`.

### 3.2 Improvement sessions

- A new session kind, run through the same SDK runner as creations, with
  its own guard:
  - it works in a separate git worktree on a branch `improve/<id>`, outside
    the repo folder;
  - writes are allowed only to allowlisted paths inside that worktree;
  - no Bash, no web tools; read tools only inside the worktree and the
    evidence it was given;
  - one improvement session at a time.
- **Input:** the user's request, plus the evidence it is about: chosen
  lessons, sessions and panel data (review rounds, denials, text questions,
  failures). Evidence is data, never instructions.
- **Output:** the changed files, a short rationale per change that cites the
  evidence, and what the user should expect to be different.
- **Generic only:** the repo is meant to be public. A proposal must make
  sense for any user. Preferences of this user belong in the personal
  library, not in the repo. Proposals that contain personal paths, secrets
  or text copied from the personal library profile are rejected.

### 3.3 Verification and the proposal page

- After the session ends, the **server** (not the model) runs build, lint
  and all tests in the worktree, and runs the validators of 3.1 and 3.2.
- The proposal page shows: the diff per file, the rationale and evidence,
  the test and validator results, and what the change is expected to
  improve.
- If the change affects model behaviour, the page offers the matching cheap
  real check (for example the interviewer target check when the interviewer
  or the target rule changed), with a one-line cost note. The user starts
  it; its result is added to the page.
- Actions: **approve**, **ask for changes** (text, starts a new round on the
  same branch), **discard** (deletes the branch and worktree).

### 3.4 Applying and reverting

- Approve applies the branch as **one commit on `master`**, with a message
  that names the proposal. No push.
- **Never while a creation is running:** agent files are read when a
  subagent starts, so a change mid-creation would mix versions. If a
  creation is active, the approval waits and applies as soon as none is,
  and the page says so.
- The working tree may already hold uncommitted changes to the agent
  frontmatter made by `usage set`. Applying must keep them as they are and
  commit only the body changes.
- If `master` moved since the proposal was prepared and the change no longer
  applies cleanly, the approval is refused and the user can ask for a new
  round.
- **Revert** from the web (with confirmation) makes a revert commit, under
  the same rules (not during a creation).
- A history page lists applied improvements with links to their proposal,
  evidence and revert.

### 3.5 Suggestions after a creation

- When a creation finishes, briefstack looks at what happened (lessons
  written, review rounds, denials, text questions, failures) and shows up to
  three short suggestions on the result screen and in the chat.
- Most signals are computed without a model. If a model summarises them, it
  is the cheapest one and its cost is negligible. Suggestions never start an
  improvement session on their own.

### 3.6 Chat

- New read tools: list suggestions, list proposals, show a proposal.
- New action tool, confirmed with a card like the others: prepare an
  improvement (starts an improvement session; the card says it uses plan).
- **Approve, discard and revert are not chat tools.** They happen only on
  the proposal page, where the diff and the test results are visible. The
  chat links to it.

## 4. Security

- The allowlist, the locked-block markers and the validators live in code
  that self-improvement cannot touch.
- Improvement sessions run with the same environment cleaning, explicit
  model, closed tool list and permission rules as creations, plus the
  independent command-hook guard from phase 4, configured for their
  worktree.
- Evidence (lessons, notes, events) may contain injected instructions. The
  guard, the allowlist, the locked blocks, the server-side validation and
  the user's review of the diff are the layers that stop them.
- Nothing is applied without the user's approval on the proposal page.
- A secret check and a personal-path check run on every proposed text.

## 5. Verification — definition of done

- Unit tests: the allowlist; frontmatter immutability; locked blocks
  (changed, moved, deleted); the personal-data and secret filters; apply and
  revert, including a working tree with `usage set` changes, an active
  creation, and `master` having moved; suggestion signals.
- A fake improvement runner, used by all UI and API tests.
- End-to-end tests over the fake runners: prepare from the chat, see the
  proposal page with diff and tests, approve, see the commit, revert;
  discard; ask for changes; a proposal touching a locked block or a
  forbidden path is rejected; an approval waiting for a running creation;
  suggestions after a creation.
- Build, lint and tests pass, and the CI is green.
- **Real checks** in `scripts/real/`, prepared and run only by the user: an
  improvement session end to end on a temporary clone (Haiku), and the
  per-asset cheap checks the proposal page offers.
- **Real run:** from a real lesson or suggestion, the user asks for an
  improvement, reviews it, approves it, runs one creation that uses the
  improved asset, and accepts the result. Phase 5 is not done before that.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.

1. An SDK session can work in a git worktree outside the repo folder on
   Windows, with the guard limited to that worktree.
2. Build, lint and tests can run in that worktree (dependencies: reuse or
   link `node_modules`, without network access), and how long they take.
3. When Claude Code reads agent and skill files: at session start, at each
   subagent start, or both. This decides the "not during a creation" rule.
4. How to commit only body changes when the agent files also hold
   uncommitted frontmatter changes from `usage set`.

## 7. Backlog from phase 4

Address these where they touch phase 5, or leave them in the backlog:
the chat should cite the exact step from the panel; creations see the
repo's `CLAUDE.md`; folder claims do not see creations started from the
terminal; the library lock for writes longer than 2 minutes; whether the SDK
passes the abandon signal to chat tools.

## 8. Out of scope for phase 5

Changes to code, settings, hooks or security. Automatic periodic proposals.
Pushing to GitHub. Self-improvement of generated projects. The UI and UX
redesign (the next step, after phase 5). Remote access.

## 9. Working rules

- Tag `phase-5-start` before the first phase 5 change.
- Write `docs/PLAN-phase-5.md` with milestones before coding, and keep its
  Status section current after every milestone.
- Small commits, one concern each. Build, lint and all tests green before
  each commit. Check the CI after each push when possible.
- Run tests before saying something works.
