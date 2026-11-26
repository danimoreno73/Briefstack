# briefstack

briefstack turns a rough idea into a ready-to-use Claude project, and gets
better at it with every project it creates.

You describe the idea in a local web app. A team of five agents, running in
**your own Claude Code**, asks you a short interview, looks things up when
needed, and writes a spec you approve. Then it prepares the project folder,
validates it and reviews it: a folder to open in Claude Code (brief,
`CLAUDE.md`, skills, agents) or one to set up in the Claude app. What it
learns about how you work goes into a personal library on your machine, so
the next interview asks less.

![A creation in progress: the interview question waiting for an answer, the steps, the live agents and the plan usage](docs/images/creation.png)

> briefstack is an independent project. It runs Claude Code, but it is not
> made by, affiliated with or endorsed by Anthropic.

## What it does

- **Creations** from an idea: interview, optional research, spec approval,
  generation, validation and review, with a live panel of the agents and
  every permission request shown to you. Two targets: `claude-code` (a
  folder you open with `claude`) and `claude-app` (a folder with the
  instructions to paste into a project in the Claude app).
- **A personal library** in plain Markdown (Obsidian-compatible), kept as a
  git repository: your profile, one note per project, session logs and
  lessons. You can read and edit it from the web.
- **A chat** about your projects, library, creations and usage. Every
  change it proposes waits for you to confirm it.
- **Improvements**: briefstack can propose changes to its own agents and
  templates. Each proposal is prepared apart, checked and tested, and
  nothing changes until you approve it.
- **A skills library**: add third-party skills from a public GitHub link.
  They are fetched into quarantine, reviewed (never run), and only the ones
  you approve can be proposed for new projects.
- **Tasks** in your `claude-code` projects: describe a piece of work on the
  project page or in the chat, and a Claude Code session does it in a
  separate copy of the project (a git worktree on a branch of its own),
  with the same live panel. Every shell command and web request it wants to
  run asks you first, showing the exact command. When it is done, you
  review the diff and, if you want, press "Run the checks" to run the
  checks you declared for the project on it; then approve it (one commit on
  the project's branch, never pushed), ask for changes, or discard it. Any
  applied task can be reverted from the web.
- **Codex in tasks** (optional, off by default): when you turn it on in
  Settings, Claude can hand parts of the code writing in a task to Codex
  (OpenAI's coding agent), with your own ChatGPT login. Claude decides
  when; Codex works inside the task's worktree, with a limit of calls per
  round (5 by default, 1 to 10). The task page lists each call, its
  commands, its tokens and Codex's final message. The diff, the checks you
  run from the proposal page and your approval stay the control, whoever
  wrote the code.
- **Builds** in your `claude-code` projects that have a `docs/BRIEF.md`:
  press "Implement" on the project page and a planning session turns the
  brief into a queue of tasks. You review and edit the queue, the exact
  commands a session may run, the checks to run after each round, the fix
  rounds and the plan-usage thresholds, and approve them **once**. Then
  briefstack runs the tasks one after another **without asking again**, on
  a branch of its own (`briefstack/build-<id>`) that is never checked out
  in your folder. After each round the checks run; a task whose checks
  pass and that needed no command outside the list is applied to the
  build's branch, otherwise it waits for you and the tasks that depend on
  it are skipped. Before each task the plan usage is read; at your
  threshold the build pauses and resumes by itself after the reset. You
  can pause, resume or cancel it, open a waiting task as an ordinary task,
  and at the end apply the whole build to your branch as one commit
  (revertable) or discard it. **A build runs code before you read it**:
  see Security and Limitations.
- **The build's board and cards in parallel**: the queue is a board of
  cards. Each card has an area (the paths or folders it is expected to
  change) and a size, and before the start you edit, add, remove and
  reorder cards and choose how many run at once (1 to 4; the page offers
  2). The build then runs at the same time cards whose dependencies are
  done and whose areas do not overlap, each in its own worktree, and joins
  each one to the build's branch when its rounds pass: one join at a time,
  and **a card joined onto other cards' changes runs the build's checks
  again on the joined tree** before it lands (when the build has checks;
  with none, only a textual conflict stops it). A card that still collides
  is redone once on top of what was joined; if it fails again it waits for
  you. The build's page shows the cards in columns (pending, blocked,
  running, waiting, done, skipped) while it runs. With 1 card at a time a
  build runs as before, except that a task joined onto a branch that moved
  (you approved a waiting task meanwhile) is checked again on the joined
  tree (when the build has checks), and may be redone once. **Parallel cards spend the plan's 5-hour window faster**
  (more work at once, not more work per window), and each running card is
  a session in the shared limit.
- **A first version of the code in a creation** (web app, `software`
  projects for Claude Code, off by default): at the spec checkpoint choose
  "workspace and a first version of the code" and give the exact commands
  it may run (install, test, build, lint), the checks to run when it ends
  (at least one) and the fix passes (0 to 2). After the workspace is
  validated and committed, an `implementer` agent writes the code from the
  brief's deliverables and "done when" and updates its "Current status";
  the checks run, a failure gets a fix pass, and the code is committed
  apart from the workspace (two commits, never pushed). Checks that still
  fail leave the code with a clear warning, never a failed creation. The
  step has a time limit and a limit of tool calls (Settings) and does not
  start when plan usage is at or above your warning thresholds or cannot
  be read. When Codex is on and its check passes, you may also tick
  **Codex without its shell**: Claude can hand pieces of the writing to
  Codex, which then writes files only and runs nothing. The result screen
  shows the commits, the commands run and denied, each run of the checks,
  Codex's calls and tokens, and what is left. **This step runs code a
  session wrote before you read it**: see Security and Limitations.

## Requirements

- **Node.js 24** or later, and npm.
- **Claude Code**, installed and working on its own: run `claude` once in a
  terminal and sign in. See [Set up Claude
  Code](https://code.claude.com/docs/en/setup). briefstack uses the
  `claude` it finds on `PATH` or in `~/.local/bin`; on Windows it must be
  the native `claude.exe` (not an npm `claude.cmd` shim).
- **git**, recommended: the library and the improvements use it. Tasks
  need git 2.40 or later.
- **A current browser** for the web app: Chrome or Edge 123, Firefox 121,
  Safari 17.5 or later.
- **Operating systems:** Windows (native), macOS and Linux. The CI runs on
  Linux, Windows and macOS on every push.
- **Codex CLI**, optional, only for Codex in tasks: `npm install -g
  @openai/codex`, then `codex login` with your ChatGPT account. Settings
  checks it (`codex --version`, `codex login status` and one command in
  Codex's sandbox) when you press **Check**. Codex's use counts against
  your ChatGPT plan, which briefstack cannot read.

## Install

```sh
git clone https://github.com/danimoreno73/Briefstack.git
cd Briefstack
npm install        # also builds the CLI and the web app
```

There is no npm package; run briefstack from the clone with `npx
briefstack` (or `node dist/cli.js`).

## Quick start

```sh
npx briefstack init    # creates the library and the projects folder
npx briefstack web     # starts the web app on 127.0.0.1
```

`briefstack web` prints an address like
`http://127.0.0.1:4870/#token=…`. Open it, including the part after `#`:
that token is what lets your browser in. Then go to **New project**,
describe your idea and answer the questions.

When it starts, `briefstack web` also says how your Claude Code signs in,
and what to do if it is missing, too old or not signed in. Settings shows
the same, with a **Check again** button. Use `--port 0` if port 4870 is
taken.

You can also run the flow without the web app: open Claude Code in the
clone (`claude`) and type `/new-project <your idea>`.

## How authentication works, and what it costs

briefstack has no account and no sign-in of its own. It runs your
unmodified Claude Code, which signs in the way you set it up:

- **Your Claude plan** (Pro, Max, Team or Enterprise), after `claude` and
  `/login`. Creations, the chat and improvements use your plan's limits;
  the creation panel shows the 5-hour and weekly usage, and briefstack
  warns before starting when they are high (thresholds in Settings). Per
  Anthropic's article [Use the Claude Agent SDK with your Claude
  plan](https://support.claude.com/articles/15036540), usage from the
  Agent SDK and from third-party apps draws from your subscription limits.
- **Your own API key**: set `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`
  for a gateway) in the terminal that starts `briefstack web`. Usage is
  billed per request to that key. There are no plan limits, so the
  plan-usage meters are not shown.
- **A cloud provider** (Amazon Bedrock, Google Cloud's Agent Platform,
  Microsoft Foundry): set its variables (`CLAUDE_CODE_USE_BEDROCK` and the
  rest) in that terminal. Usage is billed by the provider.

briefstack never shows a login, never reads, stores or forwards your
password, token or key, and never writes them to a file or a log. Your
sessions get the environment of the terminal that started `briefstack
web`. Settings in `~/.claude/settings.json` (such as an `env` block or an
`apiKeyHelper`) are not loaded into briefstack's sessions: set what you
need as environment variables instead.

What a creation costs depends on the idea and on the usage profile. A
creation runs several agents and usually takes about ten minutes, longer
when it researches or asks many questions.

## Usage profiles

A usage profile decides which model and effort each agent uses: **Saver**,
**Balanced** (the default) or **Max**. Choose one on the Usage page or
with `npx briefstack usage set <profile>` (`saver`, `balanced`, `max`).
Saver uses Haiku and Sonnet at low effort with one review round and
research only when required; Balanced mixes Haiku, Sonnet and Opus with two
review rounds; Max uses Opus at high effort with three.
Each profile also has a `chat` entry for the chat and a `work` entry for
tasks: Sonnet at low effort in Saver, Sonnet at medium effort in Balanced,
Opus at high effort in Max.
Profiles rewrite the `model` and `effort` fields of `.claude/agents/*.md`;
do not commit those changes (`briefstack usage show` warns when they
differ from the repository).

**Upgrading to tasks:** your own presets in `usage-profiles.json` must now
have a `work` entry (`{ "model": …, "effort": … }`), like `chat`. A preset
file without it no longer loads, and the error names the missing field.
briefstack does not fill one in, so a model you never chose does not run
in your projects.

## Where your data lives

- **`BRIEFSTACK_HOME`**, by default `~/.briefstack`: `config.json`, the
  personal library (`library/`, a git repository), session records
  (`sessions/`), the chat, improvement proposals, the skills library and
  tasks (`tasks/`, each with its worktree until it is applied or
  discarded). Set the variable to keep it somewhere else.
- **The projects folder**, by default `~/briefstack-projects`: where new
  projects are created. Change it in Settings.

`npx briefstack paths` prints every folder in use. Nothing is uploaded
anywhere except what Claude Code itself sends to Claude.

**Moving a folder:** stop `briefstack web`, move the folder, and if it was
the briefstack home, point `BRIEFSTACK_HOME` to its new place. Then run
`npx briefstack paths rewrite --from <old folder> --to <new folder>`: it
lists every file and path it would change (the config, each project's
path in its note, the tasks, the folders Claude Code may write to) and
writes them only with `--apply`, the notes in one library commit. Run it
once for each folder you moved. Finish or discard open tasks and
improvements before you move anything.

## Security model, in short

- **Local only.** The web server listens on 127.0.0.1. Every API call
  needs the token from the address it printed, and checks the host and the
  origin. A restart issues a new token.
- **A guard on every session.** Agents may write only inside the projects
  folder, the creation's session folder and folders you grant for one
  creation. Unexpected requests are asked to you (or denied, in unattended
  mode) and recorded.
- **Confirmations.** The chat never changes anything by itself: each
  action is a card you confirm. Improvements are applied only after you
  approve them, as one commit you can revert.
- **Skills in quarantine.** A skill from GitHub is pinned to a commit,
  size-capped, reviewed by static checks and a short model review, and
  never executed by briefstack. Only approved skills reach a project, as
  copied files checked against their hashes.
- **Tasks work apart and ask.** A task's session reads and writes only
  inside its own copy of the project, never `.git`, settings or hook
  files. It loads the project's `CLAUDE.md`, agents and skills, but never
  its hooks or its `.claude/settings.json`, and the project's permission
  settings can only restrict it. Every shell command and web request it
  has not been allowed in that task opens a dialog with the exact command;
  you allow it once, allow that exact command for the rest of the task, or
  deny it. Nothing is remembered after the task. A command with a part
  that looks like a secret is hidden, so it can only be denied. Text in
  the project (its files, `CLAUDE.md`, command output) may hold injected
  instructions: the guard, the dialogs, the server's checks of the diff
  and your own review of the diff are what stop them. Nothing reaches your
  branch until you approve the diff.
- **Codex is held by its own sandbox, not by the guard.** When Codex in
  tasks is on, Codex runs `codex exec --sandbox workspace-write` in the
  task's worktree, with an environment cleaned of tokens and keys. The
  guard does not see Codex's writes; the diff does, and every check of the
  diff runs on it as on Claude's changes. What Codex writes back is shown
  as data, never followed as instructions. What its sandbox does and does
  not hold, as measured, is under Limitations.
- **Builds decide at the start, then never ask.** A build's rounds use the
  same guard as tasks, but no dialog opens: a shell command that is not
  exactly one of the commands you approved (or a chain of them with `&&`,
  `||` or `;`) is denied and recorded, and so is every web request. The
  list holds exact commands only (no wildcards, no prefixes, plain
  characters, nothing that looks like a secret). The planner session has
  no tools: it reads the brief as data and answers with a queue you
  review. A build's rounds never offer Codex. Nothing reaches your branch
  until you apply the whole build; nothing is pushed.
- **The creation runs code before you read it** when you choose a first
  version of the code. The implementer has no shell at all; it writes only
  inside the project folder (never `.git`, `.briefstack/`,
  `.claude/settings*.json`, `.claude/hooks/`, `.mcp.json` or hook folders)
  and runs commands only through briefstack, which runs a command in the
  project folder only when it is exactly one of the commands you approved
  (or a chain of them with `&&`); anything else is denied without asking
  anyone and listed at the end. The list limits command lines, not what an
  approved command runs: `npm test` runs the tests the session wrote, as
  you, with your files and the network; the checks run with proxies
  pointed nowhere, which a program can ignore. briefstack starts listed
  commands and checks itself, with no operating-system sandbox on any
  system. Listed commands and checks get no tokens or keys from your
  environment. Changes to protected files, by the implementer or by
  Codex, are put back before the code commit, and so are skills, commands
  and agents written with hooks in their frontmatter (`hooks:`), as far as
  briefstack can see them: an approved command runs any code, so it can
  also write outside the project or hide a change from git. When they
  cannot be put back, the code is not committed.
- **Codex without its shell.** In a creation, Codex runs with its shell
  tool and the rest of what could run commands turned off
  (`--disable shell_tool` and more, your `config.toml` ignored, web search
  off), as measured with Codex 0.167.0: asked to run a command, it could
  not; it could not write outside the project folder, nor read text files.
  It is used only when you ticked it, only when the version installed is
  the one your last check measured, and with the same limit of calls.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- The guard is a set of checks on Claude Code's tool calls, not an
  operating-system sandbox. On native Windows Claude Code has no sandbox
  for shell commands.
- **Tasks run code from your project on your machine.** Allowing a shell
  command runs it as you, with your files and your network; what it runs
  can include files the session just changed (a test script, say). Read
  each command before you allow it. The project's own git hooks run for a
  `git` command you allow (the dialog says so); briefstack's own git never
  runs them.
- **Declared checks run only when you ask.** Nothing runs them when a
  round ends. On the task's page, after reading the diff, you press "Run
  the checks" and confirm a dialog that names the exact commands; the
  server then runs the commands you confirmed for the project, in the
  task's copy, on the change the page shows. They run project code,
  including what the session changed, as you, with network proxies pointed
  nowhere (a program can ignore them, so no network is not guaranteed) and
  a 10-minute limit each. You can approve without running them. Declare
  and run only commands you would run on the task's changes yourself.
- **Codex can read your files and use the network.** Measured on one
  Windows 11 machine with Codex CLI 0.167.0, in both Windows sandbox modes
  (`unelevated`, the default, and `elevated`): Codex's writes stay inside
  the task's worktree and it cannot change the repository's git folders,
  but **it can read files outside the worktree, reach services on
  127.0.0.1 and reach the Internet**. No Codex setting tried closed the
  network on that machine. With reads and the network both open, a
  command Codex runs could read your files and send them out (inferred
  from the two measurements, not tried). Settings
  shows this warning while the switch is on. `unelevated` runs as you;
  `elevated` runs as a separate sandbox account and cannot run Node
  installed in your profile (for example with nvm). Codex in tasks was
  checked with the real Codex on Windows only; on macOS and Linux it is
  tested with a fake Codex in CI, and its sandbox there was not measured.
- **A build runs code before you read it.** In a build, the commands you
  approved at the start and the checks run after each round, on code the
  session has just written, before anyone reads it: as you, with your
  files, network proxies pointed nowhere (a program can ignore them) and a
  10-minute limit per check. Native Windows has no sandbox for them. This
  is the one place where checks run without a click on the change (for
  ordinary tasks they still wait for you). Approve only commands you would
  run on unread code, and review the whole build before applying it.
- **The list limits command lines, not code.** An approved command runs
  whatever the project makes of it, and the session can change that
  before it runs: `npm test` runs the `test` script of `package.json`, and
  the session may rewrite that script, or a test file, or anything the
  command loads. The list stops other command lines, not what an approved
  one does.
- Builds plan only from a project's `docs/BRIEF.md` committed on its
  branch (the `claude-code` templates point their `CLAUDE.md` there);
  without one, "Implement" says so. One build or task per project at a
  time; builds share the active-sessions limit and wait for a free place.
  A build paused for usage resumes by itself only while briefstack runs;
  after a restart a build is interrupted and resumes only when you press
  Resume. The build's page shows Claude's tokens per task (input and
  output, and in brackets with the prompt cache); rounds from before
  this count have none. Discarding an applied or reverted build deletes
  only its branch.
- **A card's area is a hint, not a boundary.** Areas only decide which
  cards run at the same time: a card may still change files outside its
  area, and its join (a textual conflict, or the build's checks on the
  joined tree, when it has any) catches the rest. A card with no area counts as touching the whole
  project and never runs beside another. The join is textual: two cards
  that change different files may still break each other in ways the
  checks do not test.
- **A creation's first version of the code runs code before you read it**,
  as a build does: the commands you approved at the spec and the checks
  run on code the implementer has just written, as you, before anyone
  reads it. Approve only commands you would run on unread code, and read
  the code commit before you build on it. The step is the web app's only
  (the terminal `/new-project` prepares the workspace as before), for
  `software` projects with the `claude-code` target; it writes a first
  version as far as its limits allow, and the brief's "Current status"
  says what is left for a task or a build. The implementer's subagent
  reaching briefstack's own tools was not shown without a real session;
  the real check (`scripts/real/check-creation-code.ts`, run by you) shows
  it. Codex without its shell was measured on Windows only, with Codex
  0.167.0; it cannot read files, so Claude gives it in the instruction
  what it needs, and it can open images by path.
- A task's copy has no `node_modules` or other ignored files: a check that
  needs dependencies must install them (`npm ci --offline` works from
  npm's cache), or the session can ask to run the install.
- Task commits are not signed, even if your git config signs commits, and
  briefstack never pushes. Only `claude-code` projects created by
  briefstack, one task per project at a time; tasks and creations share
  the active-sessions limit.
- A creation uses your plan or key like any Claude Code session; several
  at once add up.
- A creation from the terminal and one from the web app must not use the
  same project folder. The web app treats the folder of a terminal creation
  in progress as taken; the terminal flow does not check the web app's.
- The skill review is heuristic: it can miss code that is split, built at
  run time or encoded. Read every script before approving a skill.
- Public GitHub repositories only, for skills. No automatic updates.
- The web app is for one person on one machine. The interface is in
  English and Spanish.
- `claude-app` projects need a few manual steps in the Claude app; the
  project's `NEXT_STEPS.md` lists them.

## Development

```sh
npm run build            # type-check and build everything
npm test                 # unit tests (vitest)
npm run test:e2e         # end-to-end tests (Playwright, over fake runners)
npm run lint             # lint
npm run briefstack -- <command>   # run the CLI from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The briefs and plans of each phase
are in [`docs/history/`](docs/history/), the decisions behind them in
[`docs/decisions.md`](docs/decisions.md) and open ideas in
[`docs/IDEAS.md`](docs/IDEAS.md).

## License

[MIT](LICENSE).
