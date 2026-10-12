# Decisions and verified Claude Code behaviour

Each entry: what was checked, source, date read, conclusion. "Inferred" marks a
conclusion read between the lines rather than stated by the docs.

## Tooling

### TypeScript pinned to 6.0.x (2026-10-12)

TypeScript 7.0.2 is the npm `latest`, but `typescript-eslint@8.71.1` declares
`typescript: ">=4.8.4 <6.1.0"` as its peer dependency (`npm view`). TypeScript
stays on `~6.0.3` until typescript-eslint supports 7.

### Line endings (2026-10-12, user)

`.gitattributes` has `* text=auto eol=lf`: every text file is LF in the repo
and in the working tree, on every OS. The files committed before it were
already LF, so nothing was renormalised.

### esbuild install script (2026-10-12)

npm warns that esbuild's postinstall script is not covered by
`allowScripts`. It was not approved: tsx and vitest work without it (the
platform binary comes as an optional dependency). Revisit only if a fresh
install breaks.

### Fake secrets in tests (2026-10-12)

Test strings that look like real tokens (`sk-ant-…`, `ghp_…`) are built by
concatenation so secret scanners (for example GitHub push protection, if the
repo is published) do not flag the repo. Private-key headers without a key
and the AWS documentation example key (`…EXAMPLE`) are left as literals.

### CI untested (2026-10-12)

`.github/workflows/ci.yml` runs build, lint and test on Windows, macOS and
Linux, but the repo has no remote, so it has never run. Real verification is
local on Windows plus tests that use both `path.win32` and `path.posix`.

## Claude Code behaviour (H0)

Read on 2026-10-12. Conclusions marked **changes the plan** were approved at
the H0 checkpoint and are reflected in `PLAN.md`. Main sources:

- Subagents: https://code.claude.com/docs/en/sub-agents.md
- Skills: https://code.claude.com/docs/en/skills.md
- CLI reference: https://code.claude.com/docs/en/cli-reference.md
- Model configuration: https://code.claude.com/docs/en/model-config.md
- Worktrees: https://code.claude.com/docs/en/worktrees.md
- Hooks: https://code.claude.com/docs/en/hooks.md
- Permissions: https://code.claude.com/docs/en/permissions.md
- Settings: https://code.claude.com/docs/en/settings.md
- Desktop app (Cowork) projects:
  https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-cowork
- Scheduled tasks:
  https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- claude.ai projects:
  https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects

Some hooks, settings and permissions passages were read through a summarising
fetch; re-check exact wording before quoting them in code comments.

### 1. Subagents cannot ask the user

Source: sub-agents. `AskUserQuestion` is in the list of tools removed from
subagents "even when listed in the `tools` field". Permission prompts are the
only interaction: foreground subagents pass them through, background ones
surface them in the main session.

Conclusion: the design holds. Only the main session asks questions.

### 2. Subagent frontmatter

Source: sub-agents. Fields: `name`, `description`, `tools`, `disallowedTools`,
`model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`,
`memory`, `background`, `omitClaudeMd`, `effort`, `isolation`, `color`,
`initialPrompt`, `experimental`.

- `tools`: "a comma-separated string such as `Read, Grep, Bash` or a YAML
  list". Omitted means every tool available to subagents.
- `model`: `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit`.
  Omitted means the resolution order below decides.
- `effort`: exists. `low`, `medium`, `high`, `xhigh`, `max`; "available levels
  depend on the model". Overrides the session effort but not
  `CLAUDE_CODE_EFFORT_LEVEL`.

Conclusion: the validator accepts `tools` as string or list, `model` as alias,
full ID or `inherit`, and `effort` from the five levels.

### 3. Subagent model and effort resolution

Source: sub-agents ("Choose a model", "Set effort"), model-config.

Model, highest first:

1. the per-invocation `model` parameter of the Agent tool
2. frontmatter `model` (`inherit` = main conversation model)
3. `CLAUDE_CODE_SUBAGENT_MODEL`
4. the main conversation model

`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes Claude Code ignore frontmatter and
the per-invocation parameter. Before v2.1.251 `CLAUDE_CODE_SUBAGENT_MODEL` came
first. The org `availableModels` allowlist applies to all three sources.

Effort, highest first (inferred from the quotes): `CLAUDE_CODE_EFFORT_LEVEL`,
per-invocation `effort` parameter (v2.1.292+), frontmatter `effort`, session
effort.

Conclusion — **changes the plan**: `CLAUDE_CODE_SUBAGENT_MODEL` no longer beats
frontmatter. `usage show` must warn about `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
(model) and `CLAUDE_CODE_EFFORT_LEVEL` (effort), not about
`CLAUDE_CODE_SUBAGENT_MODEL`. The skill must pass neither `model` nor `effort`
to the Agent tool.

### 4. Editing agent and skill files mid-session

Source: sub-agents, skills. Claude Code watches `.claude/agents/` and
`.claude/skills/`; edits apply to the next delegation "with no restart needed".
A restart (agents) or `/reload-skills` (skills) is needed only when the
directory did not exist at session start.

Conclusion: `usage set` takes effect on the next subagent call. No restart
message needed, except when the directory is new.

### 5. Hooks

Source: hooks.

- Events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`.
- Common stdin JSON: `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `effort`, `hook_event_name`, among others.
- `SubagentStart` adds `agent_id`, `agent_type`. `SubagentStop` adds those plus
  `agent_transcript_path` and `last_assistant_message`.
- Tool events fired inside a subagent carry `agent_id` and `agent_type`, so
  `PreToolUse`/`PostToolUse` can be attributed to a subagent.
- Shell: "sh -c on macOS and Linux, Git Bash on Windows, or PowerShell when Git
  Bash isn't installed". Per-hook `shell: "bash" | "powershell"`. `cmd` is not
  an option.
- `${CLAUDE_PROJECT_DIR}` is the project root (also inside worktrees). In
  shell form, "wrap each placeholder in double quotes".
- On Windows, exec form needs a real `.exe`; `node_modules/.bin` `.cmd` shims
  cannot be spawned without a shell.
- Skills and agents may declare `hooks` in frontmatter. Skill hooks register
  when the skill is invoked and stay for the rest of the session. Agent hooks
  run only while that subagent runs.

Not documented: whether `${CLAUDE_PROJECT_DIR}` is substituted before
PowerShell parses the command.

Conclusion: hook command is `node "${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs"`
(`node` is a real executable on every OS). H8 must check it on Windows both
with Git Bash and with `shell: "powershell"`.

~~Decision (H0 checkpoint): the event hooks are declared in the
`/new-project` `SKILL.md` frontmatter.~~ **Superseded in H8** (see "Events
and hooks"): skill hooks do not see subagent activity, so the hooks live in
`.claude/settings.json` and only record sessions `/new-project` opened.

### 6. Skills

Source: skills.

- Project skills: `.claude/skills/<name>/SKILL.md`. Commands in
  `.claude/commands/` were merged into skills.
- Fields: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`,
  `disable-model-invocation`, `user-invocable`, `allowed-tools`,
  `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`,
  `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`.
- `$ARGUMENTS` holds all arguments; `$ARGUMENTS[N]` / `$N` index them with
  shell-style quoting. `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` are
  substituted.
- `context: fork` runs the skill in a new subagent. Without it the skill runs
  in the main conversation (inferred: fork is the documented opt-in).
- `allowed-tools` grants permission during the invoking turn; it does not
  restrict tools.

Conclusion: `/new-project` has no `context` field and sets
`disable-model-invocation: true`. `${CLAUDE_SESSION_ID}` gives the skill the
session id for `briefstack event` without guessing it.

### 7. Writing outside the working directory

Source: permissions, sub-agents.

- `--add-dir`, `/add-dir`, or `permissions.additionalDirectories`. Files there
  follow the same rules as the working directory; edits follow the permission
  mode. `additionalDirectories` in a project `settings.json` waits for
  workspace trust.
- Subagents inherit the parent's permission rules and mode. Inheritance of
  additional directories is not documented. Foreground subagents pass
  permission prompts through to the user.

**Probe (2026-10-12, Claude Code 2.1.296, Windows 11).** Throwaway folders in
a temp directory. `claude -p --model haiku --permission-mode acceptEdits
--setting-sources project,local --disallowed-tools Bash`, a `writer` subagent
defined with `--agents` (tools `Write, Read`). `acceptEdits` auto-accepts
edits only in the working directory and additional directories; anywhere else
`-p` has nobody to ask, so the write is denied. Each case asked the main
session to write a file in a target folder outside the working directory, and
separately asked it to delegate the write to the subagent. The stream-json log
confirmed the subagent's `Write` ran inside the subagent (`parent_tool_use_id`
set).

| Target folder granted via | Main session | Subagent |
|---|---|---|
| nothing (control) | denied | denied |
| `--add-dir <dir>` | written | written |
| `additionalDirectories` in `.claude/settings.json` (folder never trusted) | denied | denied |
| `additionalDirectories` in `.claude/settings.local.json` | written | written |

Denial text: "Claude requested permissions to write to <path>, but you haven't
granted it yet."

Conclusions:

- Subagents inherit the session's additional directories. The generator can
  write outside the repo once the folder is granted.
- `additionalDirectories` in the committed `settings.json` is ignored until the
  folder is trusted, as the docs say; `settings.local.json` applies at once.
- Not tested: the interactive `/add-dir` command itself (a probe cannot type
  it). The docs present it as the in-session form of `--add-dir`; the H9
  rehearsal checks it for real.
- `briefstack scaffold` runs through Bash, which has its own permission
  prompt either way.

Decision (2026-10-12, after the probe): use `settings.local.json`, the row
that worked for both main session and subagent without a trust step.

- `briefstack init` adds `projectsDir` to `permissions.additionalDirectories`
  in the briefstack repo's `.claude/settings.local.json` (the repo found from
  the CLI's own location, not the cwd). It merges: other keys and existing
  entries stay; an entry already present is not duplicated. The path is
  written absolute with forward slashes, the form the probe used.
- `.claude/settings.local.json` is in `.gitignore` (checked with
  `git check-ignore`).
- The skill asks for `/add-dir <output-dir>` only when the chosen output
  folder is not inside a directory already listed there (for example, the
  user picked a folder outside `projectsDir`).
- Not yet verified in an interactive session: the H9 rehearsal checks that a
  generator writing under `projectsDir` gets no permission prompt.

### 8. Deny rules for secrets

Source: permissions.

- `//path` absolute, `~/path` home, `/path` relative to the settings file's
  project, `path` or `./path` relative to cwd. Bare names match at any depth
  (gitignore semantics).
- "On Windows, paths are normalized to POSIX form before matching." Use
  forward slashes; `//**/.env` matches on every drive.
- Read deny rules also block Edit/Write on the path, and Bash commands Claude
  Code recognises (`cat`, `head`, `tail`, `sed`, `tee`, redirections). They do
  not stop a script that opens files itself; only the sandbox does.
- Write-only path rules are ignored; use `Read(...)` or `Edit(...)`.

Not documented: case sensitivity of matching on Windows. The specific secret
list below is built from the syntax, not copied from the docs.

Conclusion: generated `.claude/settings.json` holds the deny rules in
`src/scaffold/secrets.ts` (see "Secret env files" below for the `.env`
part). The validator allows `~/` and `//**` patterns and keeps rejecting
machine paths.

### Settings precedence and workspace trust

Source: settings, permissions. Precedence: managed > command line >
`.claude/settings.local.json` > `.claude/settings.json` > user settings. Deny
rules from any scope win. Hooks in a project `settings.json` run even before
the folder is trusted; `permissions.allow` and `additionalDirectories` wait for
trust; deny rules apply at once.

Conclusion: generated `settings.json` holds deny rules only, never hooks or
allow rules.

### 9. `/tasks` shows the model

Source: sub-agents. "Claude Code names the model on the subagent's row, and
adds the effort level set for that subagent, if any" (v2.1.242+).

Conclusion: H10 can verify the profile from `/tasks` as the brief asks.

### 10. `claude -p` flags

Source: cli-reference. `--model <alias|full name>` and
`--effort low|medium|high|xhigh|max|ultracode` set the session for that run and
do not persist. `--agents` takes inline JSON or, with `-p`, a JSON file path
(v2.1.281+). Used from phase 2 on.

### 11. Desktop app projects

Source: Cowork projects, scheduled tasks, claude.ai projects articles.

- "Use an existing folder on your computer" exists for **Cowork projects** in
  the desktop app: pick the folder, name the project, add instructions, attach
  files. Such projects "stay on that computer and aren't saved to your Claude
  account".
- claude.ai (web) projects: "Set project instructions" in the project; files
  are uploaded. No local folder link. No numeric file limits in the article;
  paid plans switch to RAG mode near the context limit.
- Scheduled tasks: "Set up recurring tasks that are specific to the project"
  (Cowork projects article). Creation is from "Scheduled" in the sidebar →
  "New task". How a task is tied to a project is not documented. Paid plans
  only. Tasks run remotely unless they need local files.

Conclusion: `claude-app` targets a project in the Claude desktop app created
from an existing folder. The help center now calls Cowork simply Claude, so
`NEXT_STEPS.md` says "the Claude desktop app", never "Cowork". It gives those
steps, the scheduled task text with "from the project or from Scheduled → New
task", a note that scheduled tasks need a paid plan, and the web fallback
(create project, paste instructions, upload files).

### 12. Unknown frontmatter fields

Source: skills. "Claude Code ignores a field it doesn't recognize without
reporting an error." Not documented for agent files.

Conclusion: the validator only checks required fields and known values; it
does not reject extra fields. Agent tolerance is unverified, so briefstack
does not write extra fields into agent frontmatter (tiers already live in
`.briefstack/profile.json`).

### 13. Worktree base for `isolation: worktree`

Source: sub-agents, worktrees. Subagent worktrees branch from the repo's
default branch on the remote (`worktree.baseRef: "fresh"`, default) unless
`worktree.baseRef` is `"head"`. "If no remote is configured ... the worktree
falls back to your current local `HEAD`." Worktrees live under
`.claude/worktrees/`; unchanged ones are removed when the subagent finishes.

Conclusion: with no remote, parallel batches start from the current `HEAD`, so
they include H2 and H4 as long as those are committed first (inferred: the
fallback sentence is written for `--worktree`; the docs say subagents use "the
same base branch"). To remove the doubt, `.claude/settings.json` sets
`worktree.baseRef: "head"`, and each worktree agent checks its base commit
before starting work.

### Subagents can spawn subagents

Source: sub-agents. "By default, a subagent can spawn subagents of its own, up
to three layers below the main conversation." `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`
turns it off.

Conclusion — **changes the plan**: the assumption "subagents cannot spawn
subagents" is false. None of the five flow agents has the `Agent` tool in its
`tools` list, so they cannot spawn; the validator should keep it that way for
flow agents.

## Spec and scaffold (H4, 2026-10-12)

- **Errors are codes, not text.** The library throws `BriefstackError` with a
  code and parameters; `src/i18n/` renders them. zod's built-in messages use
  zod's own `en`/`es` locales, which the CLI selects at startup; briefstack's
  own spec rules carry a rule name and have their own catalogue entries.
- **Spec shape.** `schemas/spec.schema.json` is generated from the zod schema
  (`npm run schema`) and a test fails if it drifts. Required: name, slug,
  summary, language, type, target, profile, goal, audience, deliverables,
  doneWhen. Optional: template (defaults to type), targetReason, constraints,
  directories, files, skills, agents, scheduledTasks. Unknown fields are
  errors, so architect typos surface.
- **Skills and agents only for `claude-code`.** A desktop app project has no
  `.claude/` folder to put them in.
- **Generated agents cannot list `Agent` or `Task`** (enforced in the spec;
  H5 repeats it in `validate`).
- **Portable paths.** Spec paths use `/`, no `..`, and nothing Windows
  rejects (`<>:"|?*`, `CON`, `NUL`, trailing dot or space). Duplicates are
  compared ignoring case. Paths briefstack writes itself (`.git`,
  `.briefstack`, `.gitignore`, `.claude/settings*.json`, `.claude/agents`,
  `.claude/skills`) are reserved.
- **Templates.** `<root>/<name>/common/` plus `<root>/<name>/<target>/`; the
  target folder wins on the same path. Personal library templates shadow base
  ones. `{{key}}` placeholders are filled from the spec; unknown ones are
  left for the generator. A template `.gitignore` is appended to the base
  one; other reserved paths in a template are an error.
- **What the scaffolder writes itself.** `.gitignore`,
  `.briefstack/profile.json` (profile name and agent tiers),
  `.briefstack/spec.json`, and for `claude-code`: `.claude/settings.json`
  (deny rules only), agent files and skill files with frontmatter and the
  purpose as body. Files listed in the spec but not provided by the template
  get a heading (`.md`) or are empty.
- **Agent `model`/`effort`** are not written by `scaffold`; they come from
  `usage set --project` (H3), which the scaffold will call once H3 is merged.
- **Safety.** Every check (spec, output folder, template, clashes) runs
  before the first write; files are opened with `wx`, so an existing file is
  never overwritten. The output folder is refused if it overlaps the repo or
  the library in either direction, compared after `realpath` (junctions and
  symlinks followed) and case-insensitively on Windows and macOS.
- **Deny rules:** see "Secret env files" below.
- **Sorting** uses code-point order, never `localeCompare`, so output does
  not depend on the machine's locale.

## Secret env files (2026-10-12)

Decision (user): `.env.example` and `.env.sample` document variables without
real values and Claude must be able to read them. A deny rule always wins over
an allow rule, so the catch-all `Read(.env.*)` is replaced by narrow patterns
for files that hold real values:

`.env`, `.env.local`, `.env.*.local`, `.env.development`, `.env.production`,
`.env.staging`.

`.env.test` is left readable: frameworks often commit it with dummy values.
Add it to `SECRET_ENV_FILES` in `src/scaffold/secrets.ts` if that proves
wrong. The same list feeds the generated `.gitignore`, so `.env.example` stays
tracked by git.

Tests (`tests/unit/secrets.test.ts`): a matcher that models the documented
syntax keeps `.env.example`, `.env.sample` and `.env.template` readable, and
denies `.env` (also nested), `.env.local`, `.env.production.local`,
`.env.development`, `.pem` and `.key` files. The generated `.gitignore` is
checked against the same lists with real `git check-ignore`.

**Probe (Claude Code 2.1.296, Windows 11).** A temp folder whose
`.claude/settings.json` was written from `DENY_RULES`; `claude -p --model
haiku --setting-sources project --disallowed-tools Bash Grep Glob`, asked to
Read each file:

| File | Result |
|---|---|
| `.env` | denied |
| `.env.example` | read |
| `.env.sample` | read |
| `.env.production.local` | denied |
| `.env.development` | denied |
| `config/.env.example` | read |
| `config/.env` | denied |

Denial text: "File is in a directory that is denied by your permission
settings." Claude Code agrees with the unit-test model on every case, and deny
rules in a project `settings.json` apply in a folder that was never trusted,
as the docs say. Deny rules cover Claude's file tools and the Bash commands
Claude Code recognises; a script that opens files itself is not blocked (§8).

## Usage profiles (H3, 2026-10-12)

Built in a worktree from `21befa8`; merged as `ef8715e`, `8eb5824`.

| | saver | balanced (default) | max |
|---|---|---|---|
| interviewer | haiku | sonnet | opus |
| researcher | haiku | haiku | sonnet |
| architect | sonnet | opus | opus |
| generator | sonnet | sonnet | opus |
| reviewer | haiku | sonnet | opus |
| effort | low | medium | high |
| expected session model | sonnet | sonnet | opus |
| tiers light / standard / heavy | haiku / haiku / sonnet | haiku / sonnet / opus | sonnet / opus / opus |
| research | required-only | when-useful | when-useful |
| review rounds | 1 | 2 | 3 |

- **Data file:** `{ "default"?, "profiles": { name: preset } }`. `default`
  names the profile used when the config has no `activeProfile`; a user file
  may set it and wins; `balanced` is the fallback. Labels are qualitative,
  in en and es, with no numbers.
- **Per-agent effort:** an `agents` entry is a model string or
  `{ model, effort? }`. The five flow agents are required; extra names are
  allowed.
- **Validation:** profile names are slugs; a model is any single safe token
  (alias, `inherit` or full ID), not checked against a list; `reviewRounds`
  is 1–10.
- **Which agent a file is:** frontmatter `name`, else the file name. Files a
  profile does not name are left alone and reported. A file that does not
  parse stops the run before anything is written.
- **Generated projects:** each agent gets `tiers[tier]` and the preset's
  global effort; other fields of `profile.json` are kept; agents listed with
  no file are reported. A `claude-app` project only gets `profile.json`
  updated.
- **Drift check:** `git rev-parse --verify --quiet HEAD`, then
  `git show HEAD:./<file>` from the agents folder, via `execFile` (no shell).
  Skipped without git, outside a repo, or with no commits. A file not in
  `HEAD` is "uncommitted", not drift. `usage show` compares with `HEAD` only,
  not with the active profile.
- **Env warnings** fire for any non-empty value of
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` or `CLAUDE_CODE_EFFORT_LEVEL`.
- **Output:** warnings on stderr. `usage set` (repo) checks the profile
  exists, rewrites the agents, then saves `activeProfile`; an unknown profile
  changes nothing. The "do not commit" reminder appears only when files
  changed. Base presets are always read from the package's `library/`.
- **Tests never touch the real agent files:** the CLI's agents folder is
  injectable (`CliIO.repoDir`), and the CLI usage tests assert the real files
  are byte-identical after each test.

### Lint and worktrees

Agent worktrees live in `.claude/worktrees/` inside the repo. eslint picked
them up and typescript-eslint failed with "multiple candidate
TSConfigRootDirs". `eslint.config.js` now ignores `.claude/worktrees/`
(already in `.gitignore`).

## Validator (H5, 2026-10-12)

Built in a worktree from `21befa8`; merged in `8cd7c31`.

Rules (`src/validate/findings.ts` holds the single severity table):

| Rule | Severity | Checks |
|---|---|---|
| `spec.invalidJson`, `spec.invalid` | error | `.briefstack/spec.json` parses and fits the spec schema. If the raw `target` is still valid, target checks run anyway |
| `target.unknown` | warning | No target could be read; only files required by both targets are checked |
| `required.missing`, `required.empty` | error | Required files per target (one table, `REQUIRED_FILES`); `kind: gitRepo` for a missing `.git` |
| `frontmatter.missing`, `frontmatter.invalid`, `frontmatter.missingField` | error | Agent and skill files have parseable frontmatter with non-empty `name` and `description` |
| `agent.invalidTools`, `agent.spawnTool` | error | `tools` is a string or list; no `Agent`/`Task` (top-level comma split, so `Bash(a, b)` is one tool) |
| `agent.toolsOmitted` | error | No `tools` means every tool, including Agent, which bypasses the no-spawn rule (user decision, 2026-10-12; was a warning). Not raised if `disallowedTools` has Agent |
| `agent.invalidModel`, `agent.invalidEffort` | error | Same rule as usage presets (`src/models.ts`) |
| `skill.missingFile` | warning | A skill folder without `SKILL.md` |
| `claudeMd.tooLong` | error | Root `CLAUDE.md` has 60 or more lines, when it exists |
| `secret.found` | error | High-signal token formats and random-looking credential assignments; params hold the kind, never the value |
| `path.absolute` | error | Real home dir (native, `/` and JSON-escaped forms), drive letters, `/Users/<name>`, `/home/<name>`; URLs skipped except `file://`; `~` and `//**` allowed |
| `link.wikilink` | error | `[[name]]`, `[[name\|alias]]`, `[[name#heading]]` resolve by note name, case-insensitively (Obsidian) |
| `link.relative` | error | Relative markdown links resolve, case-sensitively (a link that only works on Windows or macOS is reported); code spans and fences ignored |
| `settings.invalidJson`, `settings.noDeny`, `settings.hooks`, `settings.allow` | error | `.claude/settings.json` holds deny rules only (deny list required for `claude-code`) |
| `settings.missingDenyRule` | warning | A default deny rule is missing |

- Scans text files; skips `.git` and `node_modules` at any depth, a `.git`
  file, symlinks, binary files (NUL in the first 8000 bytes) and files over
  2 MiB.
- Missing spec: `required.missing` on `.briefstack/spec.json` plus
  `target.unknown`. No `--target` override.
- `--json` prints `{ projectDir, target, errors, warnings, findings }`.
  Exit 1 on any error, 0 with only warnings, 2 on usage errors.
- Secret strings in tests are built by concatenation so scanners do not flag
  the repo.
- For H7: base templates must not contain `/home/<name>`, `/Users/<name>` or
  drive-letter examples, or generated projects fail validation.

### Integration after batch 1

- `MODEL_ALIASES`, `EFFORT_LEVELS`, `isValidModel` and `isValidEffort` live
  in `src/models.ts`. Preset agent and tier models must pass `isValidModel`,
  so a preset cannot write a model `validate` rejects. `sessionModel` keeps a
  broader check: it is only shown to the user, and `/model` accepts more
  aliases (`opusplan`, `best`).
- `scaffold` takes the usage presets, refuses an unknown spec profile before
  writing anything, and sets each generated agent's `model`/`effort` from its
  tier with `applyProfileToProject`.

## Base templates and fixtures (H7, 2026-10-12)

Built in a worktree from `075b8bc`; merged as `9014e58`, `7f9fae6`, `cb79e62`.

- **Templates** `software`, `learning-or-management`, `generic`, each with
  `common/` (`docs/BRIEF.md` plus one extra note: `DECISIONS.md`,
  `PROGRESS.md` or `NOTES.md`), `claude-code/CLAUDE.md`, and
  `claude-app/INSTRUCTIONS.md` + `NEXT_STEPS.md`. `software` adds a
  `.gitignore` for common build and dependency folders.
- **`CLAUDE.md` exists only for `claude-code`**; `claude-app` gets
  `INSTRUCTIONS.md`. `CLAUDE.md` renders no spec lists, so it stays short
  (fixtures: 19–25 lines; a test with 80-item lists stays under 60).
- **Every brief has a "Current status" section**, so the hand-off and review
  skills find it the same way in any project.
- **`NEXT_STEPS.md`** says "Claude desktop app", never "Cowork": create from
  this folder, paste the instructions, scheduled tasks (paid plan; from the
  project or Scheduled → New task; skip if none), start, and the claude.ai
  fallback (upload files, skip `.git` and `.briefstack`). It is copied into
  each template because templates cannot share files.
- **`INSTRUCTIONS.md`** names files as plain code text, not links: links mean
  nothing once pasted into the app.
- **Empty lists** (e.g. no constraints) leave the heading with nothing under
  it; not worth a new placeholder.
- **Templates are English**; adapting content to `spec.language` is the
  generator agent's job.
- **Base skills** in `library/skills/`: `session-handoff`,
  `review-against-brief`, `decision-log`. The scaffolder does not copy them;
  a spec skill gets only its purpose as body, so the generator fills it from
  these (H9).
- **Fixtures** `tests/fixtures/{software,learning,novel}.spec.json`; each
  scaffolds with the real templates and validates with zero findings for both
  targets (agents and skills dropped for `claude-app`). Tests also check no
  `{{` is left and `NEXT_STEPS.md` never says "Cowork".
- **Open point:** a spec's scheduled tasks only appear in `NEXT_STEPS.md`
  (`claude-app`); a `claude-code` project does not show them anywhere yet.
- **CLI smoke test:** `scaffold` + `validate` from source on the novel and
  software fixtures, against the real home folder: no findings.
- **Scaffold output:** the "applied usage profile to the generated agents"
  line is printed only when the project has agents.

## Personal library (H6, 2026-10-12)

Built in a worktree from `075b8bc`; merged in `02a8cd9`.

- **Layout:** `INDEX.md`, `profile/`, `templates/`, `skills/`, `projects/`,
  `log/` (with `log/INDEX.md`), `lessons.md`. `templates/` is created by
  `init` but is not a section for `add`/`list`/`show`.
- **INDEX line:** `- [[<section>/<name>]] — <one-line summary>` under fixed
  English headings (`## Profile`, `## Projects`, `## Skills`, `## Log`,
  `## Lessons`), which stay English because the file is parsed. Links include
  the folder so equal names in different sections never clash. Sessions are
  listed only in `log/INDEX.md` (newest first); the main INDEX links
  `[[log/INDEX]]` to stay short.
- **Project status block** = the note's YAML frontmatter (Obsidian shows it
  as properties): `statusFormat: 1`, `slug`, `target`, `path`, `status`
  (`created|active|paused|done|abandoned`), `profile`, `updated` (UTC date),
  `summary`. zod schema plus typed writer/reader. `library add projects`
  takes it from the `--from` file's frontmatter; briefstack sets
  `statusFormat`, `slug` and `updated`.
- **`library add <section> [name] --from <file.md>`:** content only from a
  file (no shell quoting issues on Windows). Appends to an existing note
  (blank line and a date heading, see below), otherwise creates it. Secret-looking
  content is rejected with line numbers only; nothing is written. Each change
  is a commit of just those files; without a git identity the commit uses
  `-c user.name=briefstack -c user.email=briefstack@localhost` for that one
  command. No git → warning, not failure.
- **Dated additions (user decision, 2026-10-12):** every addition to an
  existing note starts with a heading that is just the ISO date in UTC
  (`### 2026-10-12`), written by code, so old entries — lessons above all —
  can be found and consolidated later. `datedEntries()` reads them back.
  Lessons are always dated, even when `lessons.md` has to be recreated. The
  first content of a new note is not dated; its date is in git and, for
  project notes, in `updated`.
- **`init`:** idempotent (`wx` writes, commits only what it created).
  Computes the `settings.local.json` merge first, so invalid JSON stops
  `init` with the file untouched. Entry absolute with forward slashes;
  duplicates detected after normalising separators and trailing slashes,
  case-insensitively on Windows and macOS. The real write into this repo is
  checked in the H9 rehearsal.
- **`library context --idea <file>`:** `INDEX.md`, `profile/`, `lessons.md`
  and up to `--limit` (default 3) similar project notes. Similarity: count of
  distinct shared keywords (lowercased runs of Unicode letters and digits, at
  least 3 characters, minus a short en/es stop-word list); ties by path in
  code-point order; score 0 excluded. Missing library → message, exit 0.
- **Learning test:** after `library add profile ...`, the context for a
  second idea contains the preference.
- **Tests and git:** `useHermeticGit()` points `GIT_CONFIG_GLOBAL` at an empty
  file and sets `GIT_CONFIG_NOSYSTEM=1`, so tests do not depend on the
  developer's git identity or signing setup.

## Events and hooks (H8, 2026-10-12)

### Hook form

The hooks page documents an exec form: `"command": "node"` plus
`"args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs"]`. With `args` set
there is no shell at all; Claude Code substitutes the placeholder into each
argument and spawns `node.exe` directly. The docs recommend it for any hook
that references a path placeholder. It removes the open question about
`${CLAUDE_PROJECT_DIR}` under PowerShell. `scripts/hook-event.mjs` is plain
JavaScript (fast start), records only tool names (never inputs or outputs),
validates the session id, and always exits 0.

### Probe (Claude Code 2.1.296, Windows 11)

Throwaway projects in the session's temp scratchpad, each with a `probe`
skill that launches an `echo` subagent (tools: Read), run with
`claude -p "/probe" --model haiku --setting-sources project`.

| Hooks declared in | Form | Main-session tool events | `subagent.start` | Subagent tool events | `subagent.stop` |
|---|---|---|---|---|---|
| `SKILL.md` frontmatter | exec | yes | yes | **no** | **no** |
| `SKILL.md` frontmatter | shell, Git Bash | yes | yes | **no** | **no** |
| `SKILL.md` frontmatter | shell, PowerShell | yes | yes | **no** | **no** |
| `.claude/settings.json` | exec | yes | yes | yes (with `agentId`, `agentType`) | yes |

All three forms work on Windows. But hooks declared in a skill's
frontmatter do not fire for events inside subagents (their tool calls and
their stop), while the same hooks in `settings.json` do. This contradicts the
H0 checkpoint decision to put the event hooks in the skill: it would lose
exactly the subagent activity the phase 3 panel needs.

### Decision: hooks in settings, gated by the session folder (user, 2026-10-12)

**This replaces the H0 checkpoint decision** to declare the event hooks in
the `/new-project` `SKILL.md` frontmatter. That decision aimed to record
nothing while briefstack itself is developed; the probe above showed it would
also miss every event inside subagents (their tool calls and their stop),
which is most of what the phase 3 panel has to show.

- The hooks are in the repo's `.claude/settings.json`, exec form (`node` +
  `args`, no shell), for `SubagentStart`, `SubagentStop`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`. A test pins that configuration.
- The goal of the old decision is kept another way: the hook script writes
  only if `<home>/sessions/<session id>/` already exists and never creates
  it. Only `briefstack event` creates it, and `/new-project` opens every run
  with `briefstack event session started --session ${CLAUDE_SESSION_ID}`.
  Ordinary work in the repo spawns the script (tens of milliseconds per tool
  call) but records nothing. Test: without the folder the hook writes
  nothing, does not even create the home folder, and exits 0.
- Hooks in a project `settings.json` run before the folder is trusted
  (§8). The script only appends to an existing folder under the briefstack
  home and never reads tool inputs, so that exposure is acceptable.

### Session start and end (user, 2026-10-12)

- `briefstack event session started|finished --session <id>
  [--outcome completed|cancelled|failed]` (default outcome `completed`).
  `/new-project` must emit `session finished` on every way out: success,
  user cancel, unrecoverable error (H9).
- `summarizeSession(events, { now, staleAfterMinutes = 120 })` classifies a
  session: `finished` (closing event present), `in-progress` (no closing
  event, last event recent) or `interrupted` (no closing event and no
  activity for longer than the threshold, or no events). Hook events count
  as activity. The phase 3 panel uses it. Tests cover all three.

### Real run of option A (Claude Code 2.1.296, Windows 11)

A throwaway project in the session's temp scratchpad with the repo's real
`.claude/settings.json` and hook script, and a `probe` skill that opens the
session, launches an `echo` subagent and closes the session. All paths, in
arguments and environment, in Windows form (`cygpath -w`).

- Control (subagent launched, no session opened): nothing written; the
  briefstack home folder was not even created.
- Probe: `session.started`, `tool.post Bash` (the `tool.pre` of that same
  command ran before the folder existed, so it is correctly absent), `Agent`
  pre/post, `subagent.start echo`, `tool.pre`/`tool.post Read` with
  `agentId` and `agentType: echo`, `subagent.stop echo`, `session.finished`
  (`completed`), then the closing Bash's `tool.post`. No bad lines.
  `summarizeSession` → `finished`; the same events without the closing one,
  three hours later → `interrupted`.
- Nothing was written outside the temp folder (`C:\c` unchanged).

### Incident: the probe wrote to `C:\c\...`

What happened: 5 `events.jsonl` files (and their folders) were created under
`C:\c\Users\<user>\AppData\Local\Temp\claude\...\scratchpad\hook-probe\home-*\sessions\<id>\`,
outside any temp folder. Nothing else was written there.

Exact cause, step by step:

1. The probe ran `claude -p` from Git Bash with
   `BRIEFSTACK_HOME="$S/home-<form>"`, where `$S` was a Git Bash path
   (`/c/Users/<user>/AppData/Local/Temp/...`).
2. The runs also set `MSYS_NO_PATHCONV=1` (needed because Git Bash had
   rewritten the `/probe` argument into `C:/Program Files/Git/probe`). That
   variable also stops Git Bash from converting environment values, so
   `BRIEFSTACK_HOME` reached `claude.exe`, and from it the hook process,
   still as `/c/Users/...`. A debug copy of the script confirmed that value
   and that `${CLAUDE_PROJECT_DIR}` itself was substituted correctly.
3. The hook process (`node.exe scripts/hook-event.mjs`, spawned by Claude
   Code) checked the value with `path.isAbsolute`, which on Windows is true
   for any rooted path, even without a drive letter.
4. `path.resolve('/c/Users/...')` then prefixed the drive of the current
   directory (`C:`), giving `C:\c\Users\...`, and `mkdirSync(recursive)`
   created the whole chain.

So the bug was real, in the product code, not only in the probe: a Windows
program receiving a rooted path without a drive silently wrote to a folder
nobody asked for. The CLI had the same flaw in `toAbsolute` (config and
`BRIEFSTACK_HOME`/`BRIEFSTACK_LIBRARY`) and in every path argument.

Fix:

- `isFullyAbsolute` (`src/config/paths.ts`, mirrored in the hook script): on
  Windows a path counts as absolute only with a drive (`C:\`, `C:/`) or a UNC
  share (`\server\share`). `toAbsolute` uses it, so such config values fail
  with `config.relativePath` (message now mentions the drive letter).
- The hook script records nothing for such a `BRIEFSTACK_HOME` instead of
  guessing.
- The CLI checks every path argument (`scaffold`, `validate`,
  `usage set --project`, `library add --from`, `library context --idea`)
  with `argPath` before touching the disk, and exits 2 with a message
  explaining the drive letter.
- Tests are pure (inject `path.win32`/`path.posix`), so a regression cannot
  recreate the folder: `isFullyAbsolute` cases, the hook's home resolution
  matching the CLI's for twelve kinds of value in both styles, and a CLI test
  that refuses `/c/...` and `\...` arguments under `path.win32`.

Cleanup: the user deletes `C:\c` by hand after checking it only holds the
probe's files; Claude does not touch it.

Rule from now on (user, 2026-10-12): no test or probe writes outside the repo
or a system temp folder. Probes launched from Git Bash pass Windows-form
paths (`cygpath -w`) in arguments and environment variables.

### Git Bash and `claude -p`

Git Bash rewrites arguments that look like POSIX paths when it starts a
Windows program: `claude -p "/probe"` arrived as
`C:/Program Files/Git/probe`. Phase 2 launches `claude -p` from Node with
`execFile` (no shell), which is not affected; anyone scripting it from Git
Bash needs `MSYS_NO_PATHCONV=1` and then Windows-form paths.

## `/new-project` (H9, 2026-10-12)

### Allow rule for the CLI (user decision, after a docs check and a probe)

The skill and the generator run the CLI as `npm run --silent briefstack -- …`
(from source: never stale against a build, nothing installed globally). The
repo's `.claude/settings.json` allows exactly that prefix, for Bash and for
PowerShell, so a run does not prompt for every CLI call. Generated projects
still get deny rules only.

Docs (permissions, "Compound commands", read 2026-10-12): "a rule like
`Bash(safe-cmd *)` won't give it permission to run the command
`safe-cmd && other-cmd`. The recognized command separators are `&&`, `||`,
`;`, `|`, `|&`, `&`, and newlines. A rule must match each subcommand
independently." PowerShell rules split on `|`, `;` and (PowerShell 7+) `&&`
and `||` the same way. The docs do not say how allow rules treat `$(…)` or
backticks.

**Probe (Claude Code 2.1.296, Windows 11).** Throwaway folder in the
session's temp scratchpad: a `package.json` whose `briefstack` script prints
a line, a `mark.js` that writes a marker file, and the allow rule in
`.claude/settings.local.json`. `claude -p --model haiku --setting-sources
project,local`, Bash only, asked to run each command verbatim.

| Command | Result |
|---|---|
| `npm run --silent briefstack -- --version` | ran, no prompt |
| `node mark.js` (control) | denied |
| `… -- --version && node mark.js` | denied ("multiple operations") |
| `… ; node mark.js` | denied |
| `… \| node mark.js` | denied |
| `…` then newline, `node mark.js` | denied |
| `… -- $(node mark.js)` | denied ("nested command … can't be checked") |
| `` … -- `node mark.js` `` | denied (same) |
| `… -- --version > file` | denied (redirect target needs approval) |

No marker file was ever written. The same rule in a project `settings.json`
of a folder that was never trusted did not apply at all (even the plain
command was denied), as the docs say for `permissions.allow`; the briefstack
repo is a trusted folder, so the rule applies there.

What the rule does allow: any briefstack subcommand with any arguments.
That covers `scaffold` (which refuses the repo, the library and non-empty
folders by itself), `usage set` (rewrites agent `model`/`effort`, its job)
and `library add` (commits to the library repo). A test pins the rule list.
