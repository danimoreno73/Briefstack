# briefstack — Phase 7 plan: tasks in existing projects

Plan for [BRIEF-phase-7.md](BRIEF-phase-7.md). H0 is in
[decisions.md](decisions.md), "Phase 7", with sources and dates; this plan
follows from it. Work happens on `main`, from tag `phase-7-start`. Small
commits, one concern each; build, lint, unit and e2e tests green before each
commit; CI checked after each push and green on Linux, Windows and macOS
before the next milestone.

**Approved by the user on 2026-10-26, as written, with the decisions of
section 1.**

## 0. Status

Updated 2026-10-29.

M1 to M8 run unattended (the user's instruction of 2026-10-29): doubts
are settled with the most conservative option and recorded in
decisions.md, "Decisiones sin Dani (fase 7)"; no real SDK session; the
plan usage is read before each milestone, stopping above 95% of the week
or 90% of the 5-hour window.

| # | Milestone | State |
|---|---|---|
| H0 | Verify before designing (BRIEF §6) | done, decisions.md "Phase 7: H0" |
| M0 | Real probe for the user: hooks and the command-hook guard, external imports | done 2026-10-29 (the user's run): decisions.md "Phase 7: M0"; `disableAllHooks` ruled out, external imports not loaded, C all pass. Follow-up: skills not of the project, decisions.md "Phase 7: skills that are not the project's", §1, 10 |
| M1 | `work` entry in usage profiles | done (`14ab7df`), CI green on the three systems |
| M2 | Tasks: records, preconditions, worktree lifecycle | done (`9bd4121`, `2600cca`); `src/tasks/` git, store, preconditions |
| M3 | Task guard, shell permission flow, project settings | to do |
| M4 | Task runner (SDK and fake), shared limit, panel | to do |
| M5 | Declared checks and server-side validations | to do |
| M6 | Proposal page, apply, revert, project page | to do |
| M7 | Sessions list, start from the page and the chat | to do |
| M8 | End-to-end tests, security review, README | to do |
| M9 | Real checks and the real run (the user) | to do |

## 1. Design decisions taken from H0

These follow from H0 and are the conservative reading; each is in
decisions.md. They need the user's approval with this plan.

1. **The project's `.claude/settings.json` is not read by a task session.**
   In SDK sessions a project's settings file supplies hooks, its `env`
   block and helper commands such as `apiKeyHelper` even in a folder never
   trusted; allow rules are not used there. The worktree hides the file
   from the session: `git update-index --skip-worktree` in the worktree's
   own index and the file removed from the worktree only (verified with
   git: the project folder, its status and the task's commit are not
   touched). The project's `deny` and `ask` rules, which only restrict,
   are read by the server and passed in the task's flag settings. Its
   `CLAUDE.md`, rules, agents and skills still load through
   `settingSources: ['project']` from the worktree.
2. **Hooks that remain possible are stopped by rule, not by trust:**
   project skills (and commands) whose frontmatter declares `hooks` are
   refused at the start of a task with a clear message, and the task guard
   refuses a write that would add `hooks` to a skill, command or agent
   file. Agent frontmatter hooks do not run in SDK sessions of an untrusted
   folder (documented), and are refused the same way. `.mcp.json` is
   ignored (`strictMcpConfig`, as in creations). **M0 answered:**
   `disableAllHooks` in the flag settings also stops the command-hook
   guard, so it is not used; a project skill's frontmatter hook does run
   in an SDK session, so the refusals above are required.
3. **Every shell command is decided in the task's `PreToolUse` hook,**
   not in `canUseTool`: hooks run before every permission rule and mode, so
   neither a project's allow rules, nor `auto` mode's classifier, nor the
   read-only commands Claude Code approves on its own can skip the dialog.
   The hook waits for the user's answer (once, this exact command for the
   task, deny), with a timeout like the chat's cards. "This exact command"
   is the tool name and the whole command string, byte for byte: never
   split, never a prefix, never normalised. The dialog shows the whole
   string, and says when it holds several commands (`&&`, `||`, `;`, `|`,
   newlines, `$(…)`, backticks); the parsing is for display only.
4. **Server-side git never runs project code:** every git command of the
   server passes `core.hooksPath` (an empty folder), `core.fsmonitor=false`
   and `core.longpaths=true`. A project's `.git/hooks` run from a worktree
   for a plain `git commit` (verified), and without `core.longpaths` git
   skips a path over 260 characters on Windows with exit code 0 (verified).
   Shell commands the user approves in the task (`git commit` among them)
   run the project's git hooks; the dialog says so for `git` commands.
5. **Applying and reverting** use `git merge-tree --write-tree` (git 2.38 or
   later, checked before a task starts) to compute the result, `commit-tree`
   for one commit with one parent and the task's message, and
   `git merge --ff-only` in the user's clean folder to move the branch and
   the files together (verified: a moved branch that still applies, a
   conflict refused with nothing touched, revert). No cherry-pick, no merge
   state left behind.
6. **The default branch** is the branch checked out in the project folder
   when the task starts (generated projects use git's `init` default:
   `master` on this machine, `init.defaultBranch` elsewhere). A detached
   `HEAD` is refused.
7. **Dependencies are not shared:** the worktree has no `node_modules` or
   other ignored files. No link to the project's folders (a link would let
   the session's commands change the user's folder). A project that needs
   them declares an install command among its checks; the session may also
   ask to run one.
8. **CLAUDE.md files above the worktree are excluded** with
   `claudeMdExcludes` (what B8 verified), so the user's own files around
   `<home>/tasks/` do not reach the session; `AGENTS.md` files above it
   are excluded the same way. **M0 answered:** external `@` imports do not
   load in an SDK session, so there is no refusal; the task page warns
   when the project's `CLAUDE.md` or rules import a path outside the
   worktree.
9. **The task's closed tool list names `Glob` and `Grep`** (they are absent
   by default on macOS and Linux) and every tool the session may use; a
   project agent whose `tools` resolve to nothing in the task's list is
   reported at the start (Claude Code would refuse it: "zero tools").
10. **Only the project's own skills** (added 2026-10-29, after M0;
    decisions.md, "Phase 7: skills that are not the project's"). Claude
    Code's bundled skills, its built-in plugin skill and the user's synced
    claude.ai skills are kept out: the SDK `skills` option lists only the
    project's skills; the flag settings set `disableBundledSkills`,
    `disableSkillShellExecution` and turn the built-in
    `plugin-authoring` plugin off; the environment sets
    `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` and `CLAUDE_CODE_DISABLE_CRON`;
    the task guard refuses a `Skill` call for any other skill, and a
    project agent that preloads one is refused at the start.

## 2. Milestones

### M0 — Real probe for the user

`scripts/real/probe-h0-phase7.ts`, written by me, run only by the user,
haiku, a temp sample project:

1. Flag settings with `disableAllHooks: true` and the command-hook guard in
   the same flag settings: does the guard still run (its log) and block?
   Does a project skill's frontmatter hook run? A settings hook?
2. A project `CLAUDE.md` with an `@` import of a file outside the worktree:
   is it loaded in an SDK session (no approval dialog there)?
3. The worktree with the hidden settings file: the project's `CLAUDE.md`,
   one agent and one skill are seen; its settings hook does not run.

The answers decide the two open choices of §1 (2 and 8). No code of the
phase depends on them before M3.

### M1 — `work` entry in usage profiles

`work: { model, effort }` in each built-in profile (saver: Sonnet, low;
balanced: Sonnet, medium; max: Opus, high), required in user presets; the
CLI validation, `usage show`, the Usage page and the chat's `show_usage`
include it. Tests: schema, presets, the page.

### M2 — Tasks: records, preconditions, worktree

- A task record in `<home>/tasks/<id>/task.json` (project slug, text,
  state, base commit, branch, rounds, results), written aside and renamed;
  the worktree at `<home>/tasks/<id>/work/`, the branch
  `briefstack/task-<id>`.
- Preconditions (BRIEF §3.1), each with an English and Spanish message:
  `claude-code`, registered in the library, folder exists, git repository
  with a commit, a branch checked out, git 2.38 or later, no other task on
  the project, no creation targeting the folder (the folder claims, B9's
  records included), the shared active limit. The offer to initialise git
  with one commit, behind a confirmation.
- The worktree: created from the branch's last commit, settings file
  hidden, removed with its branch; uncommitted changes in the user's folder
  are not included and the page says so.
- Tests: every precondition; the lifecycle on the three systems (CI).

### M3 — Task guard and permissions

- The task guard (callback and command hook): reads and writes only inside
  the worktree; no writes to `.git`, `.claude/settings*.json`, hook files,
  or a skill, command or agent file that would declare `hooks`; the
  project folder, the home, the library and the repo out of reach; web
  tools ask.
- The shell permission flow in the `PreToolUse` hook (§1, 3), its dialog
  through the same pending-request path as creations, the task's approved
  commands kept in memory only.
- Flag settings: the command-hook guard for the worktree, the project's
  deny and ask rules, `claudeMdExcludes` for the folders above, and what M0
  decides.
- Tests: inside and outside the worktree, `.git`, settings and hook files,
  hooks added by a write; once, this exact command, deny, compound
  commands, an allow rule in the project's settings that must not skip the
  dialog; the security suite as it is.

### M4 — The task runner

A session kind `task` through the SDK runner: the profile's `work` model
and effort, environment cleaning, the closed tool list, `auto` mode as
creations (the shell decisions are the hook's), no background tasks, the
worktree as working folder, events in the session folder so the panel
works. A fake task runner for every UI and API test. Tasks and creations
share the active limit; one task per project.

### M5 — Declared checks and validations

Checks in the project's library note (a list of commands), added, edited
and removed on the project page, each confirmed; the server runs only
those, in the worktree, one after the other, with a timeout, keeping exit
codes and redacted output. Diff validations: changes only inside the
worktree, none to settings or hooks, the secret and personal-path check as
a warning.

### M6 — Proposal, apply, revert

The proposal page (diff per file, the session's closing summary as data,
checks, validations, link to the panel); approve, ask for changes (a new
round on the same worktree), discard. Apply and revert as §1, 5, refused
with the reason when the folder is dirty, the change no longer applies, or
another task runs. A dated line in the project's library note through the
library queue. The project page lists the project's tasks.

### M7 — Sessions list and starting a task

The creations list becomes a sessions list (kind, project, state). Start
from the project page and from the chat (`start_task` card; `list_tasks`,
`show_task`), the plan-usage warning first; cancel through the existing
action. Approve, ask for changes, discard and revert stay on the page.

### M8 — End-to-end, security review, README

E2E over the fake runners (BRIEF §5), a security review of the phase, and
the README: tasks run code on the user's machine, the guard is not an OS
sandbox, every shell command asks.

### M9 — Real checks and the real run

`scripts/real/`: a small task end to end; a task that needs a shell
command; a project hook that must not run; project settings that allow
every shell command and must still ask; the task session's skill list
holds only the project's skills. Then the user's real run on one of
their projects. Phase 7 is not done before it.
