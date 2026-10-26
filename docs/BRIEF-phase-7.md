# briefstack — Phase 7 brief: Tasks in existing projects

> `v1.0.0` is published and backlog 2 is done. This file is the source of
> truth for phase 7. If something here conflicts with a later instruction in
> chat, follow the most conservative reading and record it in
> `docs/decisions.md`.

## 1. What phase 7 is

Today briefstack only creates projects; the work on them happens in Claude
Code or the app. Phase 7 adds **tasks**: the user describes a piece of work
for an existing project, a Claude Code session does it apart from the user's
copy, and the user reviews the result as a diff and approves it, asks for
changes, or discards it. Every applied task can be reverted from the web.

It reuses what phases 3 to 5 built: the SDK runner, the guard, permission
dialogs, the live panel, the confirmation cards, and the worktree, proposal
and apply/revert pattern of self-improvement.

## 2. Decisions confirmed by the user

1. **What:** the user assigns tasks; a Claude Code session carries them out in
   the project, with a live panel.
2. **Permissions:** writes only inside the task's working copy. Every new
   shell command asks for approval in the web, like the creation permission
   dialogs.
3. **Changes:** the session works on a separate branch. The user sees the
   diff in the web; approving applies it as **one commit on the project's
   default branch**, with no push. Reverting is one click.
4. **Project configuration:** the session loads the project's own
   `CLAUDE.md`, agents and skills, **but not its hooks**.
5. **Model:** a new `work` entry in each usage profile.
6. **Limit:** tasks share the active-sessions limit with creations. One task
   per project at a time.
7. **Projects:** only `claude-code` projects created by briefstack and
   registered in the library.
8. Defaults accepted by the user: the task works in a git worktree outside
   the project folder; it starts from the project page or the chat; the
   server runs the project's declared checks before showing the diff;
   approve, ask for changes, discard; `claude-app` projects are out; if the
   default branch moved and the change no longer applies, approval is
   refused.

## 3. Features

### 3.1 Starting a task

- From the project page (a text box) and from the chat (`start_task` with a
  confirmation card, like the other chat actions).
- The card and the page say: the project, the task text, the profile's model
  and effort, that it uses plan, and that shell commands will ask.
- Preconditions, each refused with a clear message: the project is
  `claude-code`, registered, its folder exists, it is a git repository with
  at least one commit, no other task runs on it, no creation targets its
  folder, and the active-sessions limit allows it. If the project is not a
  git repository, the page offers to initialise it with one commit of the
  current files, behind a confirmation.
- The plan-usage warning from phase 6 applies before starting.
- The task starts from the default branch's last commit. Uncommitted changes
  in the user's folder are not included, and the page says so.

### 3.2 The work session

- A new session kind, `task`, through the same SDK runner: explicit model and
  effort from the profile's `work` entry, environment cleaning, closed tool
  list, no `bypassPermissions`, no background tasks.
- **Working folder:** a git worktree on a branch `briefstack/task-<id>`,
  under the briefstack home (`<home>/tasks/<id>/`), never inside the project
  folder or the repo.
- **Project configuration:** the project's `CLAUDE.md`, agents and skills
  load from the worktree. The project's hooks never run. The project's
  permission settings (allow rules, default mode, extra directories) never
  widen what briefstack allows; briefstack's permission handler and guard
  decide.
- **Guard:**
  - read and write only inside the worktree; the project's original folder,
    the briefstack home, the library and the repo are out of reach;
  - no writes to `.git`, to the project's `.claude/settings*.json` or to
    hook files;
  - every shell command not yet allowed in this task opens a permission
    dialog that shows the exact command; the user allows it once, allows
    that exact command for the rest of this task, or denies it. Nothing is
    remembered after the task ends;
  - web tools ask the same way;
  - the independent command-hook guard from phase 4, configured for the
    worktree.
- Questions to the user go through the same tools and controls as creations.
  When the session ends its turn waiting for text, the free-text reply from
  phase 4 works.

### 3.3 Panel

- The live panel from phase 3 works for tasks: agent tree (main session and
  the project's subagents), current tool and target, timeline, denials,
  pending permission dialogs, plan usage.
- The creations list becomes a sessions list showing creations and tasks,
  each with its kind, project and state.

### 3.4 Checks and the proposal page

- **Declared checks:** a project note can hold a list of check commands (for
  example its test and build commands). The user adds, edits and removes
  them on the project page; each one is confirmed when it is set. The
  server never runs a command the user did not set.
- When the session ends, the **server** (not the model) runs the declared
  checks in the worktree, with a timeout, and stores their exit codes and
  redacted output.
- Server-side validations of the diff: changes only inside the worktree; no
  change to `.claude/settings*.json` or hooks; the secret and personal-path
  check as a warning on the page.
- **Proposal page:** the diff per file, the session's closing summary (as
  data), the check results, the validations, a link to the panel, and the
  actions **approve**, **ask for changes** (text; a new round on the same
  branch and worktree) and **discard** (deletes the branch and the worktree).

### 3.5 Applying and reverting

- Approve applies the branch as **one commit on the project's default
  branch**, with a message that names the task. No push.
- Refused, with the reason on the page, when: the project folder has
  uncommitted changes, the default branch moved and the change no longer
  applies cleanly, or another task on the project is running. The user can
  ask for a new round.
- After applying, the worktree and the branch are removed.
- **Revert** from the web (with confirmation) makes a revert commit, under
  the same rules.
- The project page lists the project's tasks: state, date, commit, links to
  the proposal, the panel and revert.
- Each applied or reverted task adds a dated line to the project's library
  note, through the library queue.

### 3.6 Chat

- Read tools: list tasks, show a task (state, diff summary, check results).
- Action tool, with a card: `start_task(project, description)`.
- Cancelling a running task uses the existing cancel action.
- **Approve, ask for changes, discard and revert are not chat tools.** They
  happen only on the proposal page, where the diff and the checks are
  visible. The chat links to it.

### 3.7 Usage profiles

- A new `work` entry in each built-in profile. Defaults: saver → Sonnet, low
  effort; balanced → Sonnet, medium effort; max → Opus, high effort. User
  presets must set it too; the CLI validation and the Usage page include it.

## 4. Security

- Tasks run code in the user's project on the user's machine. The guard
  checks tool calls; it is not an OS sandbox, and native Windows has no
  shell sandbox. That is why every new shell command asks and shows the
  exact command. The README states this plainly.
- Text inside the project (its `CLAUDE.md`, files, skills, command output) is
  data. It may contain injected instructions; the guard, the permission
  dialogs, the server-side validations and the user's review of the diff are
  the layers that stop them.
- Project hooks never run, and project permission settings never widen
  briefstack's rules.
- Nothing reaches the project's default branch without approval on the
  proposal page.
- Shell commands and their output in the panel and on the proposal page go
  through the same redaction as the rest of the UI. Absolute paths appear
  only where the UI already shows them.
- No new network access by briefstack itself.

## 5. Verification — definition of done

- Unit tests: preconditions; the worktree lifecycle; the guard for tasks
  (inside and outside the worktree, `.git`, settings and hook files); the
  shell permission flow (once, this exact command for the task, deny,
  compound commands); project hooks not run and project permission settings
  not widening anything; declared checks (only user-set commands, timeout,
  redaction); apply with a dirty folder, a moved branch and a running task;
  revert; the shared limit and one task per project; the `work` profile
  entry; the chat tools.
- A fake task runner, used by all UI and API tests.
- End-to-end tests over the fake runners: start from the page and from the
  chat; a permission dialog for a shell command; the proposal page with diff
  and checks; approve and see the commit; ask for changes; discard; revert;
  refusals (dirty folder, moved branch, limit, `claude-app` project).
- Build, lint, unit and e2e tests pass, and the CI is green on Linux,
  Windows and macOS.
- **Real checks** in `scripts/real/`, prepared and run only by the user, on a
  temporary sample project with the saver profile: a small task end to end;
  a task that needs a shell command (the dialog appears); a project with a
  hook that must not run; a project whose settings allow all shell commands,
  which must still ask.
- **Real run:** on one real project created by briefstack, the user assigns a
  small task, follows the panel, approves it, checks the commit, reverts it,
  and accepts the result. Phase 7 is not done before that.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.
**Stop after H0 and the plan, for the user's approval, before writing code.**

1. How to load a project's `CLAUDE.md`, agents and skills from the worktree
   while its hooks do not run and briefstack's own hooks and command-hook
   guard keep working. If there is no reliable way, stop and report.
2. How the project's permission settings (allow rules, `defaultMode`,
   `additionalDirectories`) interact with briefstack's permission handler,
   and how to make sure they never widen it.
3. Whether projects generated by briefstack are git repositories with a
   commit, their default branch name, and whether any test command is
   recorded today.
4. Git on Windows, macOS and Linux: a worktree outside the project folder,
   applying it as one commit on the default branch while the user's folder
   is clean, revert, long paths. How the project's dependencies reach the
   worktree when a check needs them (for example `node_modules`).
5. How shell commands reach the permission handler: what is shown for
   compound commands (`&&`, pipes, subshells), and how "this exact command
   for this task" is matched safely.

## 7. Out of scope

`claude-app` projects. Projects not created by briefstack. Pushing or pull
requests. Scheduled or unattended tasks. Several tasks on one project at
once. Editing the project's settings or hooks from a task. Codex (planned
after this phase; see `docs/IDEAS.md`).

## 8. Working rules

- Tag `phase-7-start` before the first change.
- `docs/PLAN-phase-7.md` with milestones and a Status section kept current.
- H0 first, then the plan; stop for approval before coding.
- Small commits, one concern each, gates green before each commit, CI checked
  after each push.
- Write and edit files only with the Write and Edit tools.
