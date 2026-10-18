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
the H0 checkpoint and are reflected in `PLAN-phase-1.md`. Main sources:

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
| `settings.invalidJson`, `settings.noDeny`, `settings.hooks`, `settings.allow` | error | `.claude/settings.json` holds deny rules only (deny list required for `claude-code`); `.claude/settings.local.json`, if present, gets `settings.invalidJson` and `settings.hooks` too (2026-10-15) |
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

### Flow design (2026-10-12)

- **CLI pieces the skill needs**, all deterministic and tested:
  `usage show --json` (profile, session model, `research`, `reviewRounds`,
  drift and env warnings), `paths [--json]` (home, library and whether it
  exists, projects and sessions folders, allowed folders) and
  `paths check <dir> [--json]` (`missing` / `empty` / `nonEmpty` /
  `notADirectory` / `forbidden`, and the `settings.local.json` entry that
  already allows it, if any), and `spec check <spec.json>` (spec, profile and
  template checked as `scaffold` will, without writing), so a bad spec is
  caught before the user approves it.
- **Working files in the session folder.** The idea, `spec.json` and the
  note drafts for `library add --from` go in `<home>/sessions/<id>/`, next to
  `events.jsonl` (BRIEF-phase-1 §7). The architect has no Write tool, so the main
  session writes the spec there. `init` now also creates the sessions folder
  and adds it to `additionalDirectories`, so those writes need no extra
  grant. Neither folder applies to a session that was already running: after
  `init`, restart Claude Code.
- **The library is not read by agents.** It lives outside the allowed
  folders; the interviewer and architect get `library context` output
  instead, which is also what makes the learning test meaningful.
- **Output folder** is asked in the first interview batch, with a default
  of `<projectsDir>/<slug proposed from the idea>`, and checked with
  `paths check`. Not allowed yet → the user runs `/add-dir`; if the folder
  does not exist, the user creates it first (the docs do not say whether
  `/add-dir` accepts a missing folder; the rehearsal checks it).
- **Review rounds** count every round, the first included. Clean means no
  validator errors and reviewer verdict `pass` (only `minor` findings).
- **Cancel** writes nothing to the library.
- Edits to files still need approval in the default permission mode, even
  in allowed folders ("file editing permissions follow the current
  permission mode", permissions docs); "no prompt" in the rehearsal means
  in the user's usual mode.

### Rehearsal run A (2026-10-12, Claude Code 2.1.296, Windows 11)

`claude-code` target, default folder, temp `BRIEFSTACK_HOME`, session on
sonnet, permission mode "accept edits".

Verified:

- `init` (item 1): library with git and one commit, projects and sessions
  folders, both entries in `settings.local.json`, which git ignores.
- No permission prompt for the CLI or for writes under the projects and
  sessions folders (item 2); only the researcher's web requests asked.
- `library add` appended to `lessons.md` under `### 2026-10-12` and
  committed (item 4).
- Events (item 5): 246 lines, none bad; the nine steps started and finished
  in order, `session.finished` `completed` (item 6, first case); every flow
  agent's start, tool and stop events carry `agentId` and `agentType`.
  Nothing was recorded for the session building briefstack.
- `usage show` (item 7): no drift warning, expected session model shown.
- The skill's agents ran in the background (task notifications); the hooks
  recorded them the same way.

Found and fixed:

- **The generator built the application** (Python package, 98 tests,
  18 minutes): the spec listed source and test files and the main session
  told the generator to write working code. Decision (user): briefstack
  prepares the project; the work happens later inside it, at most with a
  first task plan in `docs/`. Spec `files` now accept documents only
  (`.md`, `.txt`, `.csv`, rule `documentOnly`); `validate` reports source
  and build files outside `.claude/` and `.briefstack/`
  (`code.applicationFile`, error); the architect, generator and skill say
  so. Checked on the run A project: 12 errors, and `spec check` rejects its
  spec.
- **Project goals judged as creation criteria**: the reviewer failed the
  run because `doneWhen` (a real run against Stockfish) was not met.
  `deliverables` and `doneWhen` now describe the project itself, for the
  brief (also in the JSON Schema descriptions); the reviewer judges the
  preparation: complete and coherent with the spec.
- **Research sources lost**: the main session passed the architect its own
  summary of the research without URLs and gave the generator nothing, so
  `docs/UCI.md` cited sources from memory. The report is now saved verbatim
  to `<session>/research.md` and passed by path to the architect, generator
  and reviewer; the generator cites only what the report contains, with
  URLs; the reviewer flags a source without URL as `should fix`.
- **Anonymous subagent events**: 20 `subagent.stop` events with an empty
  `agent_type`, no start and no transcript, about every 30 seconds while a
  subagent ran, two of them after the session closed. They are Claude Code's
  own background agents (inferred: not documented). The hook script now
  skips subagent events without an agent type.

### Rehearsal run A, repeated (2026-10-12)

Same idea, folder `fen-check-2`, after the fixes above.

- The spec listed documents only; `src/` and `tests/` were created empty.
  The generator took about a minute, the reviewer passed in the first
  round, the validator had no findings. `research.md` was written and
  `docs/UCI.md` cites its sources with URLs and confidence levels.
- The user asked for spec changes; they were applied and checked again.
- Events: 223 lines, nine steps in order, `completed`, no anonymous
  subagent events; after the close only the closing command's `tool.post`.
- Library: project note, session log, lessons and the stated preference
  were written, each committed.

Found and fixed:

- **A past answer was asked again with a different default**: `library
  context` gave the interviewer the similar project's note but not its
  session log, where the answers are. The context now includes the session
  logs each similar project note links to, and the interviewer proposes a
  past answer as the default, naming the project. The skill writes each
  answer in the log so it can be reused.
- **Double date heading**: the lessons draft brought its own
  `### 2026-10-12 (…)` heading and `library add` added another, leaving an
  empty one. An addition's leading date heading is now dropped; the skill
  no longer writes date headings.
- **INDEX summary "2026-10-12"** for the preferences note, taken from its
  first line. Date headings are skipped when a summary is derived, and the
  skill gives every note a `summary`.
- **`/model <name>` saves the default for new sessions** (model-config,
  read 2026-10-12: "Typing `/model <name>` directly behaves like `Enter`",
  which saves the default; `s` in the picker switches "for this session
  only"; `--model` "appl[ies] only to the session you launch"). `usage show`
  and the skill now say so.

### Verification 8: deny rules in a generated project (2026-10-12)

Interactive session in `fen-check-2` (folder trusted at the prompt), with a
dummy `.env` and `.env.example`: the Read tool on `.env` was denied ("File
is in a directory that is denied by your permission settings"),
`.env.example` was read, and git ignored `.env`. Claude refused to run
`cat .env` on its own judgement, so the shell case was checked separately.

Docs (permissions, read 2026-10-12): "Read and Edit deny rules apply to
Claude's built-in file tools, to file commands Claude Code recognizes in
Bash, such as `cat`, `head`, `tail`, `sed`, and `tee`, and to the targets
of Bash redirections … They don't apply to a command that reads files
without naming them, such as `grep -r pattern .` …, or to arbitrary
subprocesses that read or write files indirectly, like a Python or Node
script that opens files itself." Sandboxing (read 2026-10-12): "On native
Windows, Claude Code runs commands unsandboxed." The docs say nothing about
PowerShell file commands.

**Probe (Claude Code 2.1.296, Windows 11).** Throwaway folder with the
generated deny rules, a `.env` holding a marker value, and allow rules for
each command (so a denial can only come from the deny rules).
`claude -p --model haiku --setting-sources project,local`.

| Command | Result |
|---|---|
| Bash `cat .env` | denied |
| Bash `head -n 1 .env` | denied |
| PowerShell `Get-Content .env` | denied |
| PowerShell `type .env` | denied (seen as `get-content`) |
| PowerShell `Select-String -Path .env ...` | denied |
| Bash `grep -r PROBE_VALUE .` | **read the value** |
| Bash `node show.js .env` (script opens the file) | **read the value** |

Conclusion: the deny rules cover Claude's file tools and the shell
commands that name the file, in Bash and in PowerShell, but not a recursive
search or a script, and native Windows has no sandbox to back them. The
generated `CLAUDE.md` (all three templates) now says to keep real secrets
out of the project folder; a fixture test pins the line.

### Initial commit (user decision, 2026-10-12)

Every generated project gets one commit at the end of the flow, so the
user starts from a clean tree. `briefstack commit <project-dir>` (refuses
folders without `.briefstack/profile.json`; `git add` respects the
project's `.gitignore`; the fallback identity is used only when none is
configured; git problems are warnings), run by the skill at the start of
the hand-off, after review. Message: "Prepare the project with briefstack".

### `/add-dir` with a missing folder (rehearsal run B, 2026-10-12)

Interactive `/add-dir` on a folder that does not exist yet is refused:
"Path <dir> was not found." After creating it, the same command answered
"Added <dir> as a working directory for this session · /permissions to
manage" (session only, nothing written to `settings.local.json`). So the
skill is right to ask the user to create the folder first.

### Rehearsal run B (2026-10-12)

`claude-app` target, output folder outside `projectsDir`
(`<temp>/fuera/revision-memoria`), same temp home, "accept edits".

Verified:

- `/add-dir` (item 3): refused while the folder was missing, accepted after
  it was created, for the session only. The generator then wrote there
  with no permission prompt and no tool failure.
- The stated preference (direct answers, Spanish) was not asked again; the
  language was not asked either.
- Research sources reached the project: every URL in `docs/PLATAFORMA.md`
  is in `research.md`, which separates verified from unverified points.
- `NEXT_STEPS.md` could be followed without help (user). Validator clean,
  reviewer pass in one round, one commit under the user's git identity and
  a clean tree, events complete (201 lines, nine steps, `completed`, no
  failures), library notes and an appended lesson, dated once.

Found and fixed:

- **`paths check` kept saying `allowed: false` after `/add-dir`**: it only
  reads `settings.local.json`, and `/add-dir` lasts for the session. The
  user had to tell the flow to go on. A write probe was proposed instead,
  but it cannot answer the question: a write by the CLI is an ordinary
  process that Claude Code permissions do not govern (and native Windows
  has no sandbox), so it always succeeds; a probe with the Write tool in a
  folder that is not allowed raises a permission prompt rather than
  failing, and approving it grants that write, not the folder. Only Claude
  Code knows its session folders. Now the skill trusts the user's
  confirmation after `/add-dir` and does not check `allowed` again, the
  generator stops and reports a denied write, and `paths check` says it
  only sees `settings.local.json`.
- **The target was not asked**; the user set it. The interviewer now asks
  when both targets would work, with a recommended default and the reason
  (BRIEF-phase-1 §5 still holds: the architect recommends when the user leaves the
  default).

### Session end from Claude Code (user decision, 2026-10-12)

Rehearsal run C showed a gap: the user rejected the first question with
Esc, which interrupts the turn, so the skill never ran again and could not
close the session. Only the inactivity rule would ever mark it.

Hooks docs (read 2026-10-12): `SessionEnd` fires "when a session
terminates", with `reason` `clear`, `resume`, `logout`,
`prompt_input_exit` or `other`; `SessionEnd` hooks share a 1.5-second
budget. The docs read do not say whether closing the terminal window or
killing the process fires it; run D checks that.

- `.claude/settings.json` also runs the hook script on `SessionEnd`; it
  records `session.end` with the reason (only if it looks like one), in
  sessions `/new-project` opened, like every other hook event.
- `summarizeSession`: a `session.finished` always wins, so a completed or
  cancelled session never changes; otherwise a `session.end` with no
  activity after it makes the session `interrupted` at once, with
  `endReason`; activity after it (a resumed session) goes back to the
  inactivity rule, which stays as the fallback for endings no hook reports.

### Rehearsal run C, repeated, and the first `session.end` (2026-10-12)

- Cancelled with the "Cancel" option at the spec: `spec` finished
  `skipped`, `session.finished` `cancelled`; no project folder; no library
  commit. Research was `skipped` (nothing to look up). The interview asked
  the target, `claude-app` recommended. `spec.json` stays in the session
  folder.
- The first run C session (abandoned with Esc) got `session.end` with
  reason `prompt_input_exit` when the user ran `/exit`, and now summarises
  as `interrupted` with that `endReason`. That session's Claude Code
  process had started before the `SessionEnd` hook was added, so the hook
  configuration in `.claude/settings.json` was picked up without a restart
  (observed, not documented in what was read).

### Rehearsal run D: window closed mid-interview (2026-10-12)

The user closed the terminal window (X) at the first question. Claude Code
fired `SessionEnd` with reason `other` about three seconds after the last
event, so the session summarises as `interrupted` (`endReason: other`) at
once. With the `session.end` removed, the same events stay `in-progress` at
119 minutes and become `interrupted` at 121: the inactivity fallback still
works on real data. The repeated run C session also got a `session.end`
(`prompt_input_exit`) after its `session.finished` and stays
`finished`/`cancelled`.

Not covered: a killed process or a machine that sleeps or loses power;
the inactivity rule is what handles those.

### H9 closed (2026-10-12)

The guided rehearsal covered runs A (twice), B, C (an Esc interruption,
then a cancel at the spec) and D, and every item of PLAN-phase-1 "To verify in
real runs" except `/tasks`, which is H10.

## Real run (H10, 2026-10-13, Claude Code 2.1.296, Windows 11)

Real home (`BRIEFSTACK_HOME` empty), `init` from the CLI, `claude --model
sonnet`, "accept edits", profile `balanced` (default, never set).

- `paths`, `init` and `usage show` as expected: library git repo with one
  commit, projects and sessions folders, both and nothing else in
  `settings.local.json`; no drift or env warning.
- Idea: an HTTP API that turns a supermarket receipt into product lines.
  Two interviewer rounds, research (one researcher), the architect twice:
  the user changed the spec before approving it (local OCR first, Claude
  vision as a second implementation of the same interface, only with an
  API key). The spec listed documents only and passed `spec check`.
- No permission prompt except the researcher's web requests.
- Generated `claude-code` project: validator clean, reviewer `pass` in one
  round with one `minor` finding, one commit, clean tree. Library: project
  note with status block, session log, two lessons from the correction,
  no preference (none stated), three commits. `events.jsonl`: the nine
  steps `ok`, the five flow agents, `session.finished` `completed`.
- Acceptance: the user opened a new session in the project; from
  `CLAUDE.md`, the brief and the plan alone it understood the project, the
  decisions taken and open, and the first task, and raised on its own the
  conflict between an OCR engine that needs temp files and the rule of
  never writing images to disk. The user accepted the project.

### Verification 9: `/tasks` (partly verified)

`/tasks` names the resolved model, not the alias, and the effort:
`Generate the project folder — running · Sonnet 5.5 (medium)` and
`Review the generated project — running · Sonnet 5.5 (medium)`, matching
`balanced` for generator and reviewer. Interviewer, researcher and
architect were not captured during their runs: not verified from
`/tasks`. Indirect evidence only: their `model`/`effort` frontmatter
matched the profile, the skill passes neither per invocation, and
`usage show` reported no override variable, so by the resolution order
(section 3) the frontmatter decides.

### Fixes from the run

- Git does not keep empty folders, so the spec's `src/` and `tests/`
  structure was lost on a clone. `scaffold` now writes an empty `.gitkeep`
  in each spec folder that would otherwise stay empty (user request).
- The reviewer's finding: two documents said "redacción del investigador",
  a briefstack role the project's readers do not know. The generator now
  writes nothing about how the documents were made and credits the cited
  sources; the reviewer checks it (`minor`). A prompt rule, not a validator
  rule: a word list in two languages would give false positives.
- Both fixed in the accepted project by hand, in two commits of its own.

### Phase 1 closed (2026-10-13)

The user accepted the project of a real `/new-project` run. Build, lint
and tests pass.

# Phase 2

## Tooling (H1, 2026-10-14)

- `@playwright/test` is pinned to `1.61.1`: its chromium revision is
  1228, the one already installed in the user's Playwright cache
  (checked in each release's `browsers.json`). Newer releases would
  download another browser.
- `preact` stays on 10.x (`^10.29.8`): 11.0.0 was published on 2026-09-30
  and 11.0.1 on 2026-10-08, both less than two weeks old.
- The UI is compiled by `tsc -p tsconfig.ui.json` (DOM types, Preact JSX)
  into `dist/web`; `src/ui` is excluded from the Node configs. The import
  map is injected into `index.html` by the server and allowed by its
  SHA-256 in the CSP (`script-src 'self' 'sha256-…'`). Checked in headless
  chromium: the page loads with no CSP errors.
- Same-origin check: when `Sec-Fetch-Site` is present it must be
  `same-origin` (stricter than the plan's "not cross-site": `same-site`
  is refused too).
- CI (user decision, 2026-10-14): every push and pull request runs on
  Linux only; the Windows, macOS and Linux matrix runs only when started
  by hand (`workflow_dispatch`). The repo is private and macOS/Windows
  runners use its minutes faster. Windows stays verified locally. Run
  results are not visible from this machine (no `gh` CLI).

## Agent SDK and policy (H0, docs read 2026-10-14)

Read by two `claude-code-guide` agents from the official docs and the
SDK's type definitions (`@anthropic-ai/claude-agent-sdk` 0.3.300,
`sdk.d.ts`). Quotes from legal pages came through a summarising fetch.
Probes with real sessions are still pending; they need the user's go-ahead
first.

### 1. Skills, agents, hooks and settings under the SDK

- `settingSources` omitted = `["user", "project", "local"]`, the same as
  the CLI. Project settings, hooks, skills and agents load only from
  `<cwd>/.claude/`. Source:
  https://code.claude.com/docs/en/agent-sdk/claude-code-features
- "Sending `/<name>` runs a user-invocable skill even when your `skills`
  list omits it." `disable-model-invocation: true` still allows `/name`.
  An unknown `/name` is sent as an ordinary message, not an error: check
  `new-project` is in the init message's `slash_commands`. Source:
  https://code.claude.com/docs/en/agent-sdk/skills
- `${CLAUDE_SESSION_ID}` in skills, and the SDK `session_id` being the
  hooks' `session_id`: inferred, not stated. **Probe.**

### 2. `canUseTool`, `AskUserQuestion`, long waits

- `AskUserQuestion` reaches `canUseTool` with `{ questions }`; the answer
  is `allow` with `updatedInput: { questions, answers }` (answers keyed
  by question text). Main session only. Source:
  https://code.claude.com/docs/en/agent-sdk/user-input
- "The callback can stay pending indefinitely." No timeout is
  documented, so a held callback is the waiting mechanism.
- The defer mechanism (`PreToolUse` → `permissionDecision: "defer"`,
  resume with `--resume`) is documented for `claude -p` subprocesses and
  only when the turn has a single tool call. Not needed while the
  callback can wait. Source: https://code.claude.com/docs/en/hooks
- The callback receives `agentID`, so subagent requests probably reach it:
  inferred. **Probe.**

### 3. Login and the Claude Code binary

- The SDK follows the CLI's auth precedence; `ANTHROPIC_API_KEY` beats
  the subscription login and is always used in `-p` mode when present.
  Decision: the server removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
  and `CLAUDE_CODE_OAUTH_TOKEN` from the session's environment and warns
  if they were set. Source: https://code.claude.com/docs/en/authentication
- The SDK bundles a native binary per platform (optional dependency) and
  accepts `pathToClaudeCodeExecutable`.
- **Decision (user, 2026-10-14):** the server runs the user's installed
  Claude Code (the same binary, login and version as the CLI), passed as
  `pathToClaudeCodeExecutable`, and warns when its version is not
  compatible with the pinned SDK.

### 4. Extra writable folder for one session

- `additionalDirectories` works at start only. A `PermissionUpdate` of
  type `addDirectories` with destination `session` exists in the types,
  but its effect from `canUseTool` mid-session is not documented. `Query`
  has no method to add a folder.
- Fallback that needs no such API: `grant_directory` records the
  confirmed folder in the server, and `canUseTool` allows writes inside
  it for that session only. **Probe** the `addDirectories` update first.
- **Rule (user, 2026-10-14):** a folder granted from the UI is valid for
  that session only and is never written to any settings file
  (`settings.json`, `settings.local.json` or user settings). Any
  `addDirectories` update uses the `session` destination only.

### 5. Model and effort

`model` and `effort` (`low` … `max`) are `query()` options. Source:
https://code.claude.com/docs/en/agent-sdk/typescript

### 6. Hooks and `SessionEnd`

- Settings command hooks run in SDK sessions with the `project` source;
  `${CLAUDE_PROJECT_DIR}` is set. Source:
  https://code.claude.com/docs/en/agent-sdk/hooks
- Whether `SessionEnd` fires on abort, `interrupt()`, `close()` or when
  the server process stops is not documented. Decision: the server
  records the end itself (see `summarizeSession`), and `SessionEnd` is
  best-effort. **Probe.**

### 7. Subscription use from third-party apps

- Help article (support.claude.com/articles/15036540, "Update October 7,
  2026"): "You can still use the Claude Agent SDK, `claude -p`, and
  third-party apps with your subscription limits."
- Agent SDK overview and quickstart (no date): "Unless previously
  approved, Anthropic does not allow third party developers to offer
  claude.ai login or rate limits for their products, including agents
  built on the Claude Agent SDK. Use the API key authentication methods
  described in the Quickstart instead."
- Consumer terms (effective 2025-10-08): no access "through automated or
  non-human means … except … where we otherwise explicitly permit it";
  no sharing of login.
- **Conflict, for the user to decide.** Personal use on one's own machine
  is not addressed by either page. The help article covers it; the
  developer docs restrict products offered by third-party developers,
  which matters if briefstack is later published.
- **Decision (user, 2026-10-14):** briefstack uses the user's subscription
  login, for personal use only. Before publishing the repo, the policy on
  use from third-party apps must be checked again (`PLAN-phase-2.md`,
  "Before publishing").

### 8–11. Design-relevant details

- `permissionMode: 'auto'` exists in the SDK. Auto mode: all plans; on
  Team/Enterprise an admin can disable it; needs a supported model
  (Opus 4.6+, Sonnet 4.6+, Haiku 5.5, Fable); native Windows from Claude
  Code 2.1.233. What the SDK does when auto is unavailable is not
  documented (the CLI falls back to manual). **Probe.**
  Source: https://code.claude.com/docs/en/permission-modes
- Evaluation order: hooks → deny rules → ask rules → permission mode →
  allow rules (`allowedTools`, settings) → `canUseTool`. A bare allowed
  tool name skips the callback. Source:
  https://code.claude.com/docs/en/agent-sdk/permissions
- `Edit(...)` rules govern every file-writing tool; `Write(path)` is never
  matched. On Windows paths are matched in POSIX form: `C:\Users\<user>`
  is `/c/Users/<user>`, written `Edit(//c/Users/<user>/…/**)`. The allow
  rules are built in code from `projectsDir` and the sessions folder.
- In-process MCP tools are named `mcp__<server>__<tool>`; listing them in
  `allowedTools` skips the prompt. Tool search defers SDK MCP tools unless
  `alwaysLoad: true`. Source:
  https://code.claude.com/docs/en/agent-sdk/custom-tools
- `interrupt()` needs streaming input and cancels a pending tool call;
  whether a running tool is cut is not documented. `close()` ends the
  process. **Probe** the cancel recipe (interrupt, then a follow-up
  message asking the skill to close as `cancelled`).
- Version: SDK 0.3.300 is the latest (2026-10-14). Under the two-week
  rule the pin is 0.3.286 (2026-09-30). Node 18+.

### H0 probes (2026-10-14, SDK 0.3.286, Claude Code 2.1.300, Windows 11)

Run with the user's go-ahead, from a Node script (PowerShell, no Git
Bash), on `haiku` with `effort: low`. Every probe created its own temp
folder (BRIEFSTACK_HOME, a throwaway project with the repo's hooks, a
probe skill and a probe agent, output folders) and deleted it. The real
repo was used only to load the SDK, zod and the hook script; the real
library was never touched. The environment passed to the SDK had no
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_*` or
`CLAUDECODE`.

Plan usage, read through the SDK's experimental
`usage_EXPERIMENTAL_…()` (the data behind `/usage`, from a session that
sends no message): Team plan, 5-hour window 20% before and 22% after,
7-day window 68% before and after. Before the probes, one `claude -p
"/usage"` attempt from Git Bash was turned into a path
(`C:/Program Files/Git/usage`) and sent to Sonnet as a prompt: one short
turn. `/usage` is interactive; from Node it is read with the SDK call.

Verified:

1. **Skill, session id, hooks.** `/probe` (with
   `disable-model-invocation: true`) is in `slash_commands` and runs.
   `${CLAUDE_SESSION_ID}` is substituted and equals the SDK `session_id`
   and the hooks' `session_id`. Settings hooks (exec form) recorded tool,
   subagent and `session.end{other}` events with `settingSources:
   ["project", "local"]`.
2. **`canUseTool`.** `AskUserQuestion` arrives there and was held 20 s
   with no problem; the answer is returned in `updatedInput.answers`. A
   subagent's write outside the working folder arrives too, with
   `agentID` and `decisionReason: "Path is outside allowed working
   directories"`.
3. **Login.** `apiKeySource: "none"`: the subscription login, no API key.
   `claude_code_version` 2.1.300 through `pathToClaudeCodeExecutable`
   with SDK 0.3.286: compatible in practice.
4. **Folder for one session.** Returning `updatedPermissions:
   [{ type: "addDirectories", directories: [dir], destination: "session" }]`
   with an `allow` works mid-session: the next write in that folder did
   not reach `canUseTool` (`acceptEdits`). Claude Code itself suggests
   that exact update in `suggestions`. No settings file changed (repo
   `settings.json`, no `settings.local.json` created, user
   `~/.claude/settings.json` hash unchanged).
5. **Model and effort.** `model: "haiku"` → `claude-haiku-5-5`. The init
   message reported `effort: undefined` for `effort: "low"`: not
   verifiable on Haiku. Check with a Sonnet profile in H6.
6. **`SessionEnd`.** It fires when a session ends normally (`other`). It
   does **not** fire on `abortController.abort()`, `close()` or when the
   host process exits. In all three the running command (Git Bash plus
   its `node` child) was left running, orphaned, until it ended or was
   stopped by hand. After `close()` the folder stayed locked for over a
   minute.
7. **Auto mode.** `permissionMode: "auto"` is accepted (init reports
   `auto`). The classifier allowed `node --version`, a write inside the
   working folder **and a write outside it** without calling
   `canUseTool`.
8. **Cancel.** `interrupt()` during a running Bash command kills it in
   about 25 ms (no orphan) and rejects the tool call; a follow-up message
   on the same streaming input is then answered.
9. **Background subagents.** The Agent tool started the subagent
   asynchronously ("Async agent launched"); the main turn ended with a
   `result` and a second turn (new init, second `result`) followed when
   the subagent finished.
10. **Connectors.** Without `strictMcpConfig`, the SDK session also loads
    the user's claude.ai connectors (`source: "claudeai"`).

### Design after the H0 checkpoint (user decisions, 2026-10-14)

- **Guard hook.** File writes outside `projectsDir`, the session folder
  and the session's granted folders, and every shell command (`Bash`,
  `PowerShell`) outside a fixed list, go to `canUseTool` and never to
  the auto classifier. `canUseTool` then shows the UI dialog or applies
  the unattended denial.
  - The list is `npm run --silent briefstack -- <sub> …` with `<sub>` in
    `event`, `paths`, `usage show`, `library context`, `library add`,
    `spec check`, `scaffold`, `validate`, `commit`, and no shell
    operators.
  - Sources: the skill, the five agent bodies, and the commands in the H10
    run's transcripts. All were the CLI, except one reviewer
    `find "<dir>" -path '*/.git' -prune -o -type d -print`, which Glob and
    Read cover. The generator and reviewer bodies lose "read-only commands".
  - The user approved closing the Bash gap this way instead of leaving it
    to the classifier.
- **Cancel** never uses `interrupt()`. It answers a pending question,
  otherwise denies further tools, and the skill closes the session as
  `cancelled`. If the skill does not, the server writes the close.
- **Server stop.** The server writes `session.end` with reason
  `server_stop` and kills the Claude Code process tree (through
  `spawnClaudeCodeProcess`, to verify in H6).
- **End of a creation.** A creation ends with the flow's `session.finished`,
  not with an SDK `result`.
- **MCP.** `strictMcpConfig: true`: only `briefstack-web`.
- **Effort.** Checked in H6 with a Sonnet profile.

## Moving the data folders (2026-10-15)

briefstack keeps no path in code. Where its data lives is set by three
things, so it can move to another drive without a code change:

- `BRIEFSTACK_HOME` (an environment variable) is the home. `config.json`,
  `sessions/`, `usage-profiles.json` and, by default, `library/` live in
  it. The config is inside the home, so this one cannot be in the config:
  it must be a persistent user environment variable. The hook script reads
  it with the same rule (`scripts/hook-event.mjs`).
- `projectsDir` in `config.json` (or Settings in the web app) is where new
  projects go. `BRIEFSTACK_LIBRARY` or `libraryDir` can place the library
  elsewhere, but it is not needed when the home moves.
- The folders Claude Code may write to are entries in the repo's
  `.claude/settings.local.json` (`permissions.additionalDirectories`).
  `briefstack init` and `setProjectsDir` add entries and never remove any,
  so old ones are removed by hand.

Only processes started after the variable is set see it. Anything opened
earlier (a terminal, Claude Code, a running `briefstack web`) keeps the old
home and would create a new, empty one there. Restart them first.

Order that was followed, and should be followed again:

1. **Prepare.** Close Claude Code and `briefstack web`. Check that the
   library's `git status` is clean.
2. **Copy**, without touching the originals: `robocopy <old home> <new home>
   /E /COPY:DAT /DCOPY:DAT` (it includes `library/.git`) and the same for
   the projects folder. robocopy exits with 1 when the copy is correct.
   Compare file counts and a SHA-256 of every file, and in the copied
   library run `git fsck`, check `git status` is clean and that `HEAD` is
   the same commit.
3. **Point to the new place.** Set `BRIEFSTACK_HOME` (`setx` on Windows).
   With it set explicitly: set `projectsDir`, run `briefstack init` (adds
   the new `sessions` entry), remove the old entries from
   `.claude/settings.local.json`, and change the `path:` of each project
   note in the library with `saveNote` (one commit each).
4. **Verify** from a new session: the variable is set,
   `briefstack paths --json` shows only the new places, and the web app
   lists the projects with their new path and opens their timeline.
5. **Delete** the originals only after that, listing exactly what goes.

A project note links to its creation timeline through its `session` field.
Notes made before `--session` existed have none, so their history is empty;
adding the session id to the note with `saveNote` restores it.

Claude Code keeps its own data per project path (trust, history and memory
under its own folders). A project that moves is a new project to Claude
Code, and the old entry stays behind until the user removes it.

## H6 design (2026-10-15; closed and verified in real runs, see the end of this section)

Built and tested with a scripted stand-in for `query()`. What is **not**
verified until the real runs (`PLAN-phase-2.md`, "H6 status"): that a hook's
`deny` and `allow` behave as documented under `permissionMode: 'auto'`, that
the two `briefstack-web` tools are listed to the skill (`alwaysLoad`), that
`slash_commands` in the init message has the field name the runner reads, and
that killing the tree leaves nothing behind.

- **The guard denies; it does not ask** (user, 2026-10-15; this replaces the
  `ask` of 2026-10-14). Writes outside `projectsDir`, the session folder and
  the folders granted to the session, and shell commands outside the
  caller's list, are denied with a reason the model can act on. What the
  guard does not decide (`pass`) goes to the permission mode, then to
  `canUseTool`, which shows the dialog or applies the unattended denial.
- **Registered by code, not by settings.** The guard is passed in the
  `hooks` option of the runner's own `query()`. No settings file mentions it,
  so a normal Claude Code session in this repo never runs it (a test reads
  the settings and scans `src/` to keep it so), and it also ignores any
  hook input whose `session_id` is not the creation's. The runner claims the
  first session id it sees, from the init message or from a hook, whichever
  comes first.
- **`allow` is a pre-approval.** For a write inside an allowed folder, a CLI
  command in the caller's list and the researcher's web tools the hook
  returns `allow`, so no `allowedTools` path rule (with the POSIX-form paths
  of `Edit(//c/...)`) is needed. The two `briefstack-web` tools are in
  `allowedTools`.
- **Shell rule.** `npm run --silent briefstack -- <sub> ...`, read token by
  token: unquoted text may only hold letters, digits and `_ . - / : = ,`;
  inside double quotes there may be no `$`, backtick, backslash, double
  quote or line break; no single quotes. So no `;`, `&`, `|`, redirects,
  subshells, globs, `~` or comments. The skill already says "absolute
  paths in double quotes with forward slashes", so it fits.
- **Per caller.** Main session: `event`, `paths`, `usage show`, `library
  context`, `library add`, `spec check`, `validate`, `commit`. `generator`:
  `scaffold`, `validate`. `reviewer`: `validate`. Any other agent: no shell.
  `usage set`, `init`, `web`, `library list|show` and `scaffold` from the
  main session are denied. A test reads the commands in the skill and in the
  two agent bodies and checks each is allowed for its caller.
- **Commands that write on their own are checked too.** `scaffold` (the
  output folder) and `commit` (the project folder) must point inside the
  allowed folders, symlinks resolved, because the guard cannot see their
  writes any other way.
- **After a cancel** every tool is denied, with a message that tells the skill
  to close the open step as skipped and the session as `cancelled`; only the
  main session's `briefstack event` calls pass. `canUseTool` denies the same.
- **Granted folders** (`grant_directory`): the tool refuses a relative path,
  the repo, the library, the other protected folders ("Guard review" below)
  and a file; says nothing to the user for a folder
  already inside `projectsDir`; creates a missing folder only after the user
  confirmed; and records it for this session only. A write there passes the
  guard, and in `canUseTool` returns `updatedPermissions: [{ type:
  'addDirectories', destination: 'session' }]` (checked in H0). Nothing is
  written to any settings file.
- **`approve_spec`** only takes files inside the session folder.
- **Session end.** A creation ends with the flow's `session.finished`. The
  runner does not end itself on a `result`. Once a turn has ended it ends by
  itself only after 15 minutes with no message at all, so a flow that stopped
  without closing is marked interrupted instead of waiting for ever. That wait
  **never runs while the user has something to answer**: a question, a
  permission request, the spec approval and a folder grant each switch it off
  until they are answered (the user can take hours), and it starts again
  after. While a background agent is running (its start seen, its stop not
  yet) the wait is 2 hours instead of 15 minutes, only as a last resort
  against a stop that never comes. When it does end the run, the manager
  writes `session.end` with reason `runner_exit` and the creation finishes as
  `interrupted`: it shows in the list of interrupted creations with its last
  step. It cannot be resumed (nothing in phase 2 uses the SDK's `resume`,
  and the skill's steps are not written to be repeated); the user starts a
  new creation, and the old session folder keeps what was written. On stop
  the runner closes the query and kills the process tree (`taskkill /T /F`,
  or the process group), and also kills it if it exits on its own.
- **Process.** Claude Code is started by `spawnTracked` (our own spawn,
  `windowsHide`, its own process group on POSIX), and the SDK's forwarded
  abort signal also ends the tree.
- **Environment.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDECODE` and every `CLAUDE_CODE_*` are not
  passed (the runner reports the names, never the values), and
  `BRIEFSTACK_HOME` is set to the home the server uses, so the skill, the
  CLI and the hooks write where the server reads.
- **Errors.** `creation.claudeNotFound` (no `claude` on PATH or in
  `~/.local/bin`) and `creation.slashCommandMissing` (the init message does
  not list `new-project`) end the run as failed, with text in both languages.
- **Manager.** `policy` may be asynchronous: it is read from the config when
  each creation starts, after the creation is registered, so the "one active
  creation" check stays atomic.
- **Tests and the user's data.** `BRIEFSTACK_HOME` is now set at user level
  and points at real data. vitest (`tests/setup-env.ts`) and Playwright
  (`tests/e2e/fixtures.ts`) point `BRIEFSTACK_HOME`, `USERPROFILE` and `HOME`
  at a temp folder before any test runs, and a test fails if they do not.

### Guard review (2026-10-15, code only, nothing run against the real SDK)

A read-only review of the guard, `approve_spec`, `grant_directory` and the
effort check. What it found and how each item was closed, one commit each:

| # | Finding | Severity | Closed by |
|---|---|---|---|
| 1 | `grant_directory`, the projects folder and `paths check` only protected the repo and the library: a user could confirm briefstack's home (config, other sessions), `~/.claude` or AppData. | medium (needs the user's yes) | `protectedDirs` adds briefstack's home, `~/.claude` (and `CLAUDE_CONFIG_DIR`), `%APPDATA%` and `%LOCALAPPDATA%`. The overlap is checked both ways, so a drive root or the user's home is refused too. Consequence: on Windows the system temp folder is inside `%LOCALAPPDATA%`, so a projects or output folder in temp is refused; unit tests point `APPDATA`/`LOCALAPPDATA` at their sandbox. |
| A | Code execution through git: the guard allowed writes anywhere in `projectsDir`, `.git/hooks/` and `.git/config` included, and `briefstack commit` then ran git with the project's hooks and `core.fsmonitor`. | high | The guard denies writes (and `scaffold`/`commit` destinations) with a `.git` segment, ignoring case, trailing dots or spaces and `GIT~n`, also after symlinks. `commitProject` runs every git call with `core.hooksPath` set to a folder made empty for that commit and `core.fsmonitor=false`, which also covers the terminal flow. |
| B | Tools the guard did not know (`Monitor`, which runs a shell command, `EnterWorktree`, `CronCreate`, `Workflow`, `RemoteTrigger`…) went to the auto classifier. | high | `query()` gets `tools`: the built-ins the flow uses (`FLOW_BUILTIN_TOOLS`). The guard denies any tool outside that list plus the two `briefstack-web` tools. Those two are not in `tools` (it names built-in tools, passed as `--tools`); they come from the only MCP server (`strictMcpConfig`) and `allowedTools`. `ToolSearch` is in the list because it only loads schemas of listed tools; `TodoWrite`, `NotebookEdit` and `Skill` are not (the skill is started by its slash command). |
| C | `WebFetch`/`WebSearch` outside the researcher went to the classifier, so any agent could send data out in a URL. | medium | The guard denies them unless `agent_type` is `researcher`. |
| D | `approve_spec` compared paths as text. | low | It uses `insideAny`, symlinks resolved, like the guard. |
| E | A generated project could carry hooks in `.claude/settings.local.json` (only `settings.json` was checked). | medium | The validator reports `settings.hooks` (error) and `settings.invalidJson` for `settings.local.json` too; the reviewer checks both files. No spec field asks for hooks (both files are reserved paths), so there is no exception. Not covered: `hooks` in a generated agent's or skill's frontmatter. |
| — | `check-effort` failed with `init reports undefined`. | check bug | SDK 0.3.286 types: `SDKSystemMessage.effort` is "Present on Remote Control bridge init frames … absent on hosts that do not publish it". The H0 reading of `undefined` on Haiku had the same cause. Hook inputs carry `effort.level` "after any silent downgrade" in a tool-use context (`PreToolUse`, `Stop`…). `check-effort` now compares the level from a `Stop` hook; `SdkRunner` reports the level of the first `PreToolUse` as a runner event (`kind: effort`, with `requested`). Unverified until the script runs: that `Stop` fires before the `result` message the script stops at. |

`check-guard-auto.ts` now also asks for a `.git` write, a `Monitor` call
(added to `tools` on purpose so the guard is what stops it) and a
main-session `WebFetch`; all three must be denied by the guard.

### H6 closed: verified in real runs (2026-10-15)

The user ran the real checks after the guard review; all passed. Source: the
scripts' PASS/FAIL output, reported by the user.

| Check | Result | What it confirms |
|---|---|---|
| `check-guard-auto.ts` | 10 PASS | Under `permissionMode: 'auto'` the guard's `deny` holds before the classifier: `echo hello`, a write outside the projects folder, a main-session `WebFetch` (never reached `canUseTool`), a write in `.git` and `Monitor` (offered on purpose) were denied and left nothing behind; its `allow` lets a write inside the projects folder through; `AskUserQuestion` reaches `canUseTool` and the answer comes back. |
| `check-kill-tree.ts` | PASS (run before the review) | Killing the tree through `spawnClaudeCodeProcess` leaves no orphan. Nothing it uses changed in the review. |
| `check-effort.ts` | PASS for `low` and `high` | The `effort` option of `query()` reaches a Sonnet session: the `Stop` hook input reports the requested level. H0 probe 5 is answered: the effort is applied; the init message just does not carry it. |

This closes the items the section above lists as not verified, except the
two the checks do not exercise: that the `briefstack-web` tools are listed
to the skill (`alwaysLoad`) and the `slash_commands` field name. Both are
exercised by H10, the real run from the browser, which is next.

## Decisiones sin Dani (decisions taken while the user was away, 2026-10-15)

For the user to review. Each one chose the more conservative option.

1. **Guard denies instead of asking** was the user's own instruction for
   writes and shell; I applied it to every shell command outside the list,
   including ones the old plan would have asked about.
2. **Main session cannot `scaffold`** (only `generator` can), following the
   plan's table, although the skill's text never calls it.
3. **`scaffold` and `commit` need their folder inside the allowed folders.**
   Not asked for; it closes a way round the write rule.
4. **No backslashes, `$`, backticks or single quotes in a quoted argument.**
   Stricter than needed for bash, but PowerShell and bash disagree about what
   is special there. If a real run shows the model using backslashes, the
   skill is the place to fix, not the guard.
5. **A 15-minute idle end after a `result`** (2 hours with an agent running)
   is my number, and it is off while the user is being asked anything. If a
   real run shows quiet stretches that are not an agent, change
   `IDLE_AFTER_RESULT_MS` and `IDLE_WITH_AGENTS_MS`.
6. **A denial by the guard is shown like an unattended denial** (listed on the
   result screen, `by: runner`), even under the `ask` policy, because nobody
   was asked.
7. **`markdown-it` 15.0.1** (earlier, in H7) is the only runtime dependency
   added since H5; nothing new in this stretch.
8. **Tests may start a real child process tree** (`creation-process-tree`):
   two `node` processes in a temp folder, killed by the test.

## `/new-project` from the terminal has no guard (2026-10-15)

The guard of H6 exists only in creations started from the web app. A
`/new-project` typed in Claude Code in this repo runs as it always did, with
the repo's `.claude/settings.json` and the user's own permission prompts.
Why:

- **Where it lives.** The guard is a callback passed to the SDK's `query()`
  by `SdkRunner`. A settings-file hook is a command line, and a command-line
  hook would run in every Claude Code session in this repo, development
  sessions included. The guard needs to know that a session is a creation
  (it claims the session id the runner started); a settings hook cannot know.
  Registering it from code is the only way it stays out of ordinary work, and
  a test keeps it that way.
- **What it replaces.** In the web app nobody is at the terminal to approve
  an unexpected command, and the permission mode is `auto`, where a
  classifier decides. The guard keeps the classifier out of writes and shell.
  In the terminal the user sees every prompt, the mode is the one they chose,
  and the repo's allow rule covers only the plain
  `npm run --silent briefstack` command. The user is the guard.
- **The brief.** Phase 2 says the CLI and the skill keep working exactly as
  before; adding a guard there would change that, and the skill test pins the
  terminal text.
- **What follows.** The terminal path has no deny of its own: if the model
  runs a command the user did not expect, the user's prompt is what stops it.
  The agents' bodies still say to use Bash only for the briefstack CLI.

## What each real script touches (2026-10-15, before any is run)

All of them create `briefstack-real-<name>-<random>` under the system temp
folder (`os.tmpdir()`, which on this machine is on C:) and remove it at the
end; `BRIEFSTACK_HOME` for the session is a folder inside it, `settingSources`
is empty, so no user or project settings, hooks or CLAUDE.md are loaded, and
the sessions' working folder is `<temp>/project`. Claude Code itself keeps a
transcript of each session under `~/.claude/projects/` for that temp folder,
as it did for the H0 probes; that is its own bookkeeping, not briefstack data,
and moving its config would also move the login.

| Script | What it makes the model attempt | Exact paths | If the guard (or our check) failed |
|---|---|---|---|
| `preflight.ts` | nothing: no conversation | reads the real `config.json`, runs `git status` in the repo and in the real library, and opens a no-message session in the temp folder for the plan usage | it only reads: `git status` runs with `--no-optional-locks`, so the index is not refreshed either (applied, tested) |
| `check-guard-auto.ts` | `echo hello` (shell), a write outside the projects folder, a write inside, a web fetch of example.com from the main session, an `AskUserQuestion`, a write in a `.git` folder, a `Monitor` call (offered on purpose so the guard is what stops it) | outside: `<temp>/outside/x.txt`; inside: `<temp>/projects/ok.txt`; `.git`: `<temp>/projects/app/.git/hooks/pre-commit`; Monitor marker: `<temp>/monitor-ran.txt`; the shell runs with `<temp>/project` as its folder | the `echo` is harmless; the outside write would create `<temp>/outside/x.txt`, the `.git` write `<temp>/projects/app/.git/hooks/pre-commit` and Monitor would run `echo ran > <temp>/monitor-ran.txt`, all inside the temp folder. A tool that reaches `canUseTool` is denied, but the classifier may allow others without asking (H0 probe 7), so beyond those named paths containment is the prompt, `maxTurns: 14` and the temp working folder. The fetch is a read of one public page |
| `check-kill-tree.ts` | one shell command: `node <temp>/sleeper.cjs`, which writes `<temp>/sleeper.pid` and sleeps two minutes | `<temp>/sleeper.cjs`, `<temp>/sleeper.pid` | this script has no guard, but its `canUseTool` allows that one command character for character and denies everything else, and only the shell tools exist (`tools: ['Bash', 'PowerShell']`); applied and tested without a session (`tests/unit/real-scripts.test.ts`). If the model words the command differently it is denied and the check reports that the command never started: harmless, run it again |
| `check-effort.ts` | nothing: one word as the answer, twice | none | no tool is approved and `maxTurns` is 1 |
| `check-web-tools.ts` (added 2026-10-16) | one call to `approve_spec` on a spec and a summary the script writes first | writes `<temp>/home/sessions/check/spec.json` and `summary.md` | the guard allows writes only there and in `<temp>/projects`; `canUseTool` denies everything; the answer is played by the script, no browser; `maxTurns` is 4 |
| `check-subagent.ts` (added 2026-10-16) | one Agent call to a throwaway haiku agent that reports one word | none | the agent has only `Read`, `canUseTool` denies everything and `maxTurns` is 6; nothing is written outside the temp folder |

The two changes proposed on 2026-10-15 (`--no-optional-locks` in the preflight, and the exact-command rule in `check-kill-tree.ts`) were applied the same day on the user's go-ahead.

## H10 run 1: the interviewer's report never arrived (2026-10-16)

The first H10 run, from the browser on the real library, ended `failed` in
`gap-analysis`. Session `94048952-…` under `<home>/briefstack-data/sessions`;
Claude Code 2.1.301, Agent SDK 0.3.286.

**What happened** (session `events.jsonl` and the SDK transcript):

1. The main session called Agent for the `interviewer`. The tool returned at
   once ("Async agent launched … working in the background"): the subagent
   ran in the background.
2. The main session waited with `sleep 1; echo waiting`. The guard denied it
   (`;`, and not the briefstack CLI). Harmless.
3. The interviewer, done, called `SubagentHandback` to deliver its report.
   The guard denied it: not in `FLOW_TOOLS`. Claude Code reminded it to
   report three more times (`[handback-send-enforce]`, up to 3 in the binary),
   each denied: 4 calls, then the run ended with no report.
4. The main session relaunched it with `run_in_background: false`; same
   four denials; the Agent result was "The subagent ended without delivering
   a report through SubagentHandback, so no report was delivered".
5. The skill closed `gap-analysis` and the session as `failed`, as it should.

**State after the run** (checked read-only): the only files written are
`idea.md` and `events.jsonl` in that session folder. The projects folder is
unchanged (only `receipt-parser-api`, last modified 2026-10-13); the library
has no commit after 2026-10-15 and a clean status; the repo is clean. The
interviewer has only `Read`, `Grep`, `Glob`. Session outcome: `failed`.

**Cause:** the closed tool list of the guard, plus subagents running in the
background by default. No other cause was found.

### `SubagentHandback` (verified 2026-10-16)

Sources: https://code.claude.com/docs/en/tools-reference (table entry and
"subagent tool lists"), https://code.claude.com/docs/en/permission-modes
("How auto mode handles subagents"), and the strings of the bundled
`claude.exe` of SDK 0.3.286.

- "Delivers a subagent's final report to whichever conversation receives that
  subagent's result. Provided only in auto mode, to subagents that the Agent
  tool runs locally other than forks, and available in … the Agent SDK; the
  classifier reviews the report before it's delivered. Requires Claude Code
  v2.1.271 or later." Permission required: No.
- Claude Code gives it to the subagent "even if you leave it out of `tools`
  or list it in `disallowedTools`". That is why it was offered although
  `query()` gets `tools: FLOW_BUILTIN_TOOLS` and the interviewer lists three.
- The subagent's prompt says: "Only a SubagentHandback call reaches your
  caller as your result; plain text you write at the end is not delivered."
  So in `auto` mode, denying it means no subagent ever reports.
- Input: `{ message }` (non-empty). Its `call` stores the report for the
  recipient and ends the subagent's run; a second call is refused ("delivers
  one report"). Called from a session that is not such a subagent it does
  nothing ("Nothing was sent: … not active for this agent").

**Why it is safe to allow:** it writes no file, runs no command, reaches no
network and touches nothing outside the session; its one effect is that text
reaches the parent session, which is exactly what the Agent tool's result is
for. The auto classifier reviews the report on the way (flagged reports
arrive with a security warning), so the guard returning `pass` keeps that
review. **Who:** subagents only; the main session is denied (it has no
caller). It is also passed after a cancel: denying it then only makes the
subagent retry three times before stopping, while delivering ends its run.

No other coordination tool is needed: with background tasks off (below) the
main session never has to message, stop or read a running agent, so
`SendMessage`, `TaskStop` and `ListAgents` stay denied (tests list them).

### Subagents in the foreground (verified 2026-10-16)

Sources: https://code.claude.com/docs/en/sub-agents ("Run subagents in
foreground or background"), https://code.claude.com/docs/en/env-vars, and
`sdk-tools.d.ts` of SDK 0.3.286 (`AgentInput.run_in_background`: "Agents run
in the background by default").

- With fork mode off, as in the Agent SDK, "Claude runs the subagent in the
  background by default and in the foreground when it needs the result".
- "If you set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` to `1`, Claude Code runs
  the subagent in the foreground, in every kind of session." The variable
  "disable[s] all background task functionality, including the
  `run_in_background` parameter on Bash and subagent tools, auto-backgrounding,
  and the Ctrl+B shortcut".

**Change:** `cleanEnvironment` (the environment of every creation) sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` after removing the server's own
`CLAUDE_CODE_*`. It is code, so it does not depend on the model. The skill
also says to pass `run_in_background: false` and, if an agent still runs in
the background (a terminal session with fork mode on), to wait for the
completion notification and never poll with `sleep` or any tool.

**Real check:** `scripts/real/check-subagent.ts` runs a haiku main session
with the runner's options, guard and environment and one throwaway haiku
agent that reports a random word, and checks the Agent call runs in the
foreground (its result is not "Async agent launched"), the word reaches the
main session, the guard denies nothing and the main session runs no shell
command. It writes nothing: the agent has only `Read`, and `canUseTool`
denies everything; the temp folder is removed at the end.

First run (2026-10-16): the word reached the main session, no shell command,
no denial; the check still failed because it wanted the word inside the
Agent result. In auto mode that result only says the report was delivered
through `SubagentHandback`; the report reaches the main session apart from
it. The check was wrong, not the flow, and now asks only for the above.
Nothing in briefstack reads the Agent result: `SdkRunner` reads only the
`init` and `result` messages, the event hook records only tool and agent
names, and the progress list uses `subagent.start` and `subagent.stop`.

## H10 run 2: the spec approval never reached the page (2026-10-16)

Session `a787026c-…`; Claude Code 2.1.301, Agent SDK 0.3.286, profile
`balanced` (main session Sonnet). The run went through idea, gap analysis
(the interviewer reported through `SubagentHandback`, in the foreground),
interview, research and the architect. The main session wrote `spec.json`
and `spec check` passed (12:02:26 local). Its next message was the spec
summary as plain text ending in "¿Lo apruebas, quieres cambiar algo o
cancelas?", and the turn ended (`end_turn`). No `approve_spec` call, no
`summary.md`, no `briefstack-web` tool in `events.jsonl`. The page stayed on
"Working…" with nothing pending. Nothing was created; the projects folder and
the library were not touched.

**Were the tools there?** Yes (SDK transcript in
`<home>/.claude/projects/<repo>/`): the request's tool list
(`api-request-shape`) has `mcp__briefstack-web__approve_spec` and
`mcp__briefstack-web__grant_directory` loaded in full, not deferred; the only
deferred tools were `WebFetch` and `WebSearch`, and there was no pending or
failed MCP server. `ToolSearch` was not needed.

**Root cause: the skill.** Web mode was something the model had to infer
("when the tools … are among your tools"), and step 5.3 led with "Show the
user the architect's summary … Ask them to approve, change something or
cancel", with the web branch as a sub-bullet below. The model did what the
leading sentence said. Nothing in the web app can answer plain text, so the
flow stopped.

**Fixes:**

1. *Skill.* `MODE` is set once in step 0 from the tool list; the ground
   rules say that in `MODE` web the user cannot reply to text, so a turn never
   ends waiting for a plain-text answer. Step 5.3 prepares the summary first
   and then branches, the web branch first: write `summary.md`, call
   `approve_spec` in the same turn, never show it as text. The terminal
   branch keeps its words. A change in web mode goes back through
   `approve_spec`.
2. *Reminder at the decision point.* A `PostToolUse` hook that only
   `SdkRunner` registers adds a short reminder to the result of the main
   session's `spec check` (call `approve_spec` now) and `paths check` (call
   `grant_directory` if not allowed). It is code, it reaches the model right
   when it chooses the next step, and the terminal never sees it.
   `additionalContext` of `PostToolUse` is the documented way to add context
   next to a tool result (https://code.claude.com/docs/en/hooks, "Add
   context for Claude", read 2026-10-16: Claude Code "wraps the string in a
   system reminder and inserts it into the conversation at the point where
   the hook fired"; for `PostToolUse`, "next to the tool result").
3. *Fail early.* On the first `init` message the runner checks that `tools`
   lists both browser tools; if not, it stops before the flow runs, with an
   error that names the missing tools and the MCP server status. Later inits
   are not checked.
4. *A turn with nothing asked.* The runner sends the main session's last
   text (from the `result` message, at most 4000 characters) with
   `turnEnded`; the manager redacts it and keeps it as `awaitingReply` until
   a turn starts, something is asked, or the creation ends. The page shows
   "The session is waiting for a reply", the message and that it can be
   cancelled, instead of "Working…" (docs/api.md).

**Proposed, not built: a free reply box.** On the `awaitingReply` panel, a
text field whose answer the runner pushes as the next user message (the
`InputQueue` already exists and the SDK accepts more messages on the same
stream). It would make any plain-text question answerable instead of a dead
end. Costs: a new route and pending kind (or a new answer on
`awaitingReply`), the secret check on what the user types, tests and an
E2E case, and the reply becomes a second channel into the flow besides the
three tools. Waiting for the user's decision.

**A real check that walks the skill to the spec** would cost about what
the part of a real H10 run up to the spec costs: run 2 took five minutes to
reach the spec, with the main session (Sonnet) doing most of the work
(about 1M cached input tokens read over 33 requests), the interviewer
twice, the researcher (Haiku) and the architect (Opus). The agents' models
come from the agent files, which only `briefstack usage set` writes, so the
check cannot make it cheaper on its own; under the `saver` profile it would
be cheaper. It would also need scripted answers to the interview. My view:
not worth it as a routine check; `check-web-tools.ts` covers the tool
wiring and H10 itself is that walk.

**Seen in passing, not changed:** the first AskUserQuestion of the
interview was rejected by Claude Code because one question had a single
option ("fewer than 2 options … the person never saw it"); the model resent
it with two and went on. If it happens again, the skill or the interviewer
should never offer a one-option question.

# Phase 3

## Decisiones sin Dani (fase 3)

Decisions taken while the user was away (2026-10-16), each the most
conservative reading of the brief. The user can revisit any of them.

1. **The brief was missing at first.** `docs/BRIEF-phase-3.md` did not exist
   when the run started; nothing was done until the user added it. It is
   committed as given.
2. **P1, where the rule lives.** `library/rules/target.md`, a new `rules/`
   folder in the base library. The interviewer reads and cites it; the
   architect reads it and cites it in `targetReason` when it chose.
   `targetChosenBy` is optional in the schema, so every spec written before
   it stays valid; the architect is told to always set it. The project
   detail page reads it from the project's `.briefstack/spec.json` instead
   of adding a field to the project note's status block (no format change).
   Accepting the interviewer's recommended option counts as the user
   choosing.
3. **P2 is prompt text only.** A deterministic check would need a new CLI
   subcommand, and the guard's command list is not to be changed in this
   run. The rule is pinned by tests on the agent and skill text.
4. **P3 hides the warning silently.** The backlog suggested a console note;
   the brief asks for a comment and a test, so there is no note. The filter
   matches the exact set of the two tools; a test fails if the installed SDK
   changes the wording, which makes the warning visible again.
5. **Targets are computed by the hook script** (`scripts/hook-event.mjs`),
   not by the runner, so sessions started from the terminal get them too and
   there is one writer of `tool.pre`. The hook copies the CLI's rule for
   `projectsDir` (a test keeps them equal). Folders granted to one web
   creation outside `projectsDir` are not known to the hook, so a path there
   shows as `outside`: the conservative side. Paths inside the briefstack
   repo are shown relative to it (root `repo`); they are the flow's own files
   and say nothing about the user.
6. **The server writes its own lines to `events.jsonl`** with
   `source: "runner"` (`tool.denied`, `session.profile`, `usage`). Without
   them a finished session would lose its denials, and the brief asks for
   denials and plan usage in finished panels too. The format stays `v: 1`;
   these lines are not activity for `summarizeSession`. The guard itself is
   unchanged except for two fields on its denial (`agentId`, `toolUseId`),
   which the brief allows.
7. **Subagent model** comes from the agent file's `model:` line at
   `subagent.start` (written only by `briefstack usage set`); hook inputs
   carry no model. Effort comes from the hook input `effort.level`, as the
   runner already reads it for the main session.
8. **Plan usage** is read with the same no-message session the preflight
   uses (verified in phase 2), not through the live creation's query (not
   verified): at the start and every 5 minutes while the creation runs. Only
   with the real runner. To confirm in the real run.
9. **A phase 2 gap fixed on the way**: the `reason` of a streamed runner
   denial was not redacted (only its summary was). It is now.
10. **Node statuses.** The brief lists waiting, running, done, failed and
    cancelled. Subagents only report start and stop, so a subagent is
    running, waiting (a permission it asked for is pending), done, or "no
    end recorded" when the session is over without its stop. Failed and
    cancelled describe the main session (the session's outcome), which can
    also be interrupted. A pending question, spec or folder grant is put on
    the main session, which is the one that calls those tools; a permission
    on the latest running agent of the type that asked, else the main one.
11. **Timeline as HTML rows with an inline SVG bar each**, not one SVG: each
    row is a button (keyboard and screen reader for free) and the layout
    works at 390 px. The text alternative is a list inside a `<details>`
    ("Text view of the agents"), so it does not double the page for sighted
    users; the agent tree itself is made of buttons with labels.
12. **Live recomputation at most every 200 ms** and once a second while the
    session runs (for durations). The final state may therefore appear up
    to 200 ms after the result screen.
13. **Screenshots** have their own Playwright config
    (`playwright.screenshots.config.ts`, `npm run screenshots`) so they are
    not part of the test suite, and land in the git-ignored `screenshots/`.

# Phase 4

## H0 (2026-10-17, SDK 0.3.286, Claude Code 2.1.302, Windows 11)

Run by Claude with the user's go-ahead (BRIEF-phase-4 §7), with
`scripts/real/probe-h0-phase4.ts --yes --probe <n>` from PowerShell: `haiku`,
`effort: low`, `maxTurns` 1–6, `settingSources: []`, `strictMcpConfig`, a
temp `BRIEFSTACK_HOME` and temp working folders, the same environment
cleaning as a creation (no `ANTHROPIC_API_KEY`, `CLAUDE_CODE_*`,
`CLAUDECODE`). The real library and projects were not touched. Plan usage
was read before and after every probe, with a stop above 70% of the 5-hour
window: 37% / 27% (5-hour / 7-day) before the first probe and 37% / 27%
after the last.

Docs read the same day: Agent SDK "Work with sessions"
(`code.claude.com/docs/en/agent-sdk/sessions`), "Streaming Input"
(`…/agent-sdk/streaming-vs-single-mode`), and the SDK's own `sdk.d.ts`
(`tools: []` "Disable all built-in tools"; `resume`, `persistSession`).

1. **A session with only MCP tools works; the closed list holds. PASS.**
   `tools: []` plus one in-process MCP server: the init message listed
   exactly the two MCP tools (`mcp__probe__get_word`,
   `mcp__probe__propose_action`), nothing else (no Read, Bash, Agent,
   ToolSearch…). Asked to read a file and run `echo hi`, the model answered
   that it has no file or shell tool; `PreToolUse` saw only the two MCP
   tools and `canUseTool` was never called. An MCP tool that waited 5 s
   before answering (as a UI confirmation will) returned normally. With the
   MCP tools in `allowedTools`, the SDK prints
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for them, as for the creation's two
   web tools: the chat's filter must name its own exact set.
2. **Several sessions at once on Windows, one process. PASS.** Three
   queries started together (overlapping for ~7 s), each with its own
   working folder, its own `PROBE_TAG` environment value, its own callback
   hooks and its own in-process MCP server. Each hook saw only its own
   session id and its own `cwd`; each MCP server was called only by its
   own session; each PowerShell call printed only its own `PROBE_TAG`.
   Callback hooks only (`settingSources: []`): the settings command hooks
   of a creation write to `<sessionsDir>/<session id>/events.jsonl`, keyed
   by session id, so they are separate by construction.
3. **Resume by session id after a restart. PASS.** A first query (no
   tools) was told a word and closed; its `claude` process ended. A second
   query in a new `claude` process with `resume: <id>` kept the same
   session id and answered the word. Cost: the resumed turn sends the whole
   history again: on this two-line conversation, 671 input tokens written
   to the cache on resume against 621 on the first turn (no cache read: the
   new process does not reuse the old cache). So a resumed chat costs one
   uncached read of its history on the first message after a restart, then
   behaves as before. Resume needs the transcript, which Claude Code keeps
   under `~/.claude/projects/<encoded working folder>/`; with the chat's
   working folder in the briefstack home, that is
   `~/.claude/projects/<encoded briefstack home>/`. The probe's own
   transcript stays in `<home>/.claude/projects/<encoded temp folder>/`
   (not deleted: it is outside the temp folders the probes may clean).
4. **A user message after the turn ended. PASS.** On the same streaming
   input queue the runner uses, a first message got its `result`; 3 s later
   a second message pushed into the same queue was answered in the same
   session (a second `init` message arrives before the second turn, which
   the runner already tolerates).

Conclusion: the design in `docs/PLAN-phase-4.md` can rely on all four. The
chat keeps its model context across a restart with `resume`; the
alternative in the brief (new conversation, old one readable) is kept only
as the fallback when a resume fails.

## Decisiones sin Dani (fase 4)

Decisions taken while the user was away (2026-10-17), each the most
conservative reading of the brief. The user can revisit any of them.

1. **Explicit model (backlog).** Every SDK session gets `model` from the
   profile (`RunnerProfile.sessionModel` is now required), and
   `ANTHROPIC_MODEL` is also removed from the session environment. Source:
   Claude Code "Model configuration" (`code.claude.com/docs/en/model-config`,
   read 2026-10-17): the order is `/model`, `--model`, `ANTHROPIC_MODEL`,
   settings `model`, and "project and managed settings take precedence over
   your own selections". So a test also checks that the repo's
   `.claude/settings.json` names no model. `ANTHROPIC_DEFAULT_*_MODEL` (which
   pin what an alias such as `sonnet` means) are left as the user set them.
2. **Plan usage race (backlog).** The creation state carries `usageReading`
   from the start until the first reading has been written (and streamed)
   or has failed; meanwhile the panel says "Reading the plan usage…". A
   failure still writes nothing, and the panel then says "not available".
3. **Late end line (backlog).** A finished creation's stream now stays open
   until its runner is done (it ends by itself, or the grace stop after 30
   s), then reads `events.jsonl` once, waits 1 s, reads it again and only
   then closes. A line written later than that is still only in the file;
   a reload shows it.
4. **Library queue across processes.** Library writes during a creation run
   in the CLI (`library add`), one process per creation, so an in-process
   queue alone would not serialise them. `withLibraryLock` (`src/library/lock.ts`)
   chains calls in one process and, across processes, holds a lock folder
   created with `mkdir` in `<os temp>/briefstack-locks/`, named by a hash of
   the library path. Nothing is written in the library. It covers
   `addNote`, `saveNote`, `revertLibraryCommit` and the commit of
   `initLibrary`, from the read of the note to the end of its commit (so an
   `INDEX.md` line is never lost either). A lock whose process is gone, or
   older than 2 minutes, is taken over; after 60 s of waiting the change is
   refused with `library.busy` and nothing is written.
5. **Folder collision: where and how.** The output folder appears first in
   the skill's `paths check "<dir>"` (interview step 3), then in
   `grant_directory` (outside the projects folder) and the generator's
   `scaffold`. Each of those claims it for the creation; a folder that
   overlaps another active creation's claim is refused there, before
   anything is written, with a reason that tells the flow to ask the user
   for another folder. Writes, `scaffold` and `commit` into a folder another
   creation holds are denied too. It is a `PreToolUse` hook of its own
   (`src/creation/folderClaims.ts`), not a change to the guard: Claude Code
   applies the strictest answer among matching hooks, "`deny` > `defer` >
   `ask` > `allow`" (Claude Code hooks reference, "PreToolUse decision
   control", `code.claude.com/docs/en/hooks`, read 2026-10-17), so its deny
   wins over the guard's allow. Its refusals are recorded like guard
   denials (`tool.denied`, `by: "guard"`) so the panel shows them on the
   node with the reason; no new event value was added. A claim is released
   when the creation finishes. Claims live in the server's memory: they
   cover creations started from the web app, which is where several run at
   once.
6. **Free-text reply.** The box appears only in the existing "waiting for a
   reply" panel (a turn ended with nothing asked). The skill still says
   never to end a turn waiting for plain text in the web app; the reply is
   the way out when it does anyway, not a new path of the flow. The text is
   sent as a user message through the runner's input queue (H0 #4) and is
   not stored by briefstack (the panel shows no model or user text). The
   idle stop of the runner is off from the reply until the next turn ends.
   Limit 10 000 characters, the same as a chat message.
7. **`chat` is required in every preset**, as BRIEF §8.3 says, so a user
   presets file (`<home>/usage-profiles.json`) written before phase 4 no
   longer loads: `usage show`, `usage set`, the Usage page and new
   creations stop with `usage.invalidProfiles`, whose issue names
   `profiles.<name>.chat`. The fix is one line per user preset,
   `"chat": { "model": "<model>", "effort": "<level>" }`. A default was not
   invented for them because the brief makes the user choose. Listed among
   the things to check before the real run.
8. **Chat session.** `tools: []`, only the `briefstack-chat` server
   (`strictMcpConfig`), its twelve tools in `allowedTools` (they shadow
   `canUseTool`, as the two web tools do; the warning is hidden only for that
   exact set) and `canUseTool` denying anything else, `permissionMode:
   'default'`, `settingSources: []` (no user or project settings, so no
   hooks, skills or model from them), working folder the briefstack home,
   explicit model and effort from the profile's `chat` entry, the creation's
   environment cleaning. If the init message lists any tool beyond those
   twelve, the session ends with an error. A custom system prompt says what
   briefstack is, that tool results are data, and that changes go through
   cards.
9. **Confirmations wait inside the tool call**, as `approve_spec` does; the
   MCP call has no timeout of its own in practice (phase 2 and 3 real runs
   waited minutes at the spec). One card at a time; a second action in the
   same turn gets a tool error; at most 10 cards per 10 minutes. While a card
   waits the turn is open, so a new chat message is refused with
   `chat.busy` (the card is answered first). A card open when the server
   stops, or when "New chat" is pressed, becomes `expired` and does nothing.
10. **Read tools.** "Get the panel state of a session" is `session_panel`,
    a compact form of `buildPanelState` (no raw events). Active creations
    (needed to cancel one) are listed by `list_sessions`, so no tool beyond
    the brief's list was added. Results carry `sources` (project, note path,
    session or creation id); the page links them. Tool results are not
    stored in the history, only the tool name, a short summary of the input
    and the sources.
11. **Redaction of the user's own text.** The user's chat message is
    redacted before it is stored and before it is sent to the model, so a
    pasted secret reaches neither.
12. **Resume.** The SDK session id is kept per thread in
    `<home>/chat/state.json`. The session closes after 10 idle minutes and the
    next message resumes it (H0 #3); after a server restart too. If a resume
    fails before the session opens, the thread gets a notice, a new session
    starts and the last message is sent again; the old messages stay.
13. **Real checks.** The chat start check runs the real chat but a fake
    creation behind it, so it costs a few haiku turns, not a creation. The
    two-creations check never rewrites the repo's agent files: it stops
    unless they already hold the saver models (the user runs `usage set
    saver` and back), and it plays the browser conservatively (recommended
    options, spec approved, every permission and folder grant refused).
14. **Small fixes on the way.** The New project page no longer jumps to a
    running creation (several may run); the menu shows the count of active
    creations on "Creations". The project tables scroll inside their box at
    390 px (found by the chat's narrow-screen e2e test).
15. **CI failure on Linux (2026-10-17, reported by the user).** Every phase
    4 commit failed `tests/unit/folder-claims.test.ts` on GitHub CI: the
    folder-collision reason held `/tmp/briefstack-folder-claims-…/projects/garden`.
    Two causes, both fixed:
    - the reason built the message from the absolute folder path; it now
      names the folder against the projects folder (`the folder "garden"
      in the projects folder`) or as "that folder (outside the projects
      folder)" (`folderLabel` in `src/creation/folderClaims.ts`);
    - `hideAbsolutePaths` relied on `findAbsolutePaths`, a check written
      for generated files that only knows the home folder, drive letters,
      `/Users/<name>` and `/home/<name>`, so `/tmp/…` passed on Linux. It
      now has its own pattern: any POSIX path with two segments or more, or
      one of the usual top folders (`/tmp`, `/var`, `/mnt`…), Windows paths
      with `\`, `/` or JSON-escaped `\\`, UNC paths with either slash, and
      `file:` URLs. Slash commands (`/add-dir`) and web URLs stay.
    Other places that could carry an absolute path, now through it: the
    streamed `denied` reason (only `events.jsonl` was covered), a
    creation's `error`, the chat's tool errors, its `sessionError` notice
    detail, and every string of a chat tool result. In tool results a path
    under the user's home is written `~/…` first, so `show_settings` still
    says where the folders are; any other absolute path is hidden. Kept as
    they were: the command shown in a permission dialog (the user must see
    exactly what is allowed) and a denied request's command summary on the
    result screen (phase 2 design).
    `gh` is not installed on this machine; CI is read from GitHub's public
    API until it is. The rule is now in `CLAUDE.md`.
16. **Fixes from the phase 4 review (2026-10-18).**
    - A note change is saved only if the note still holds the text its diff
      was made from (`expectedHash`, checked under the library lock);
      otherwise nothing is saved and the card reads `stale`.
    - The chat reads notes redacted, so a proposed note is written from
      that view. A proposed line that is exactly the redacted form of a line
      of the note gets the note's line back (in place, or moved when only
      one line has that form). This is done when the card is built, not only
      at confirmation, so the diff shows what will be saved. A placeholder
      left in any other new or changed line refuses the proposal, and so
      does a kept line that looks like a secret (the user edits that note
      in the Library page).
    - Library lock (item 4): each lock names its owner with a token. A stale
      lock is renamed to a name of the taker's own before it is removed, so
      only one process takes it; if the renamed lock is not the one judged
      stale (another process took it over in between), it is put back. At
      the end a holder removes the lock only while `owner.json` is still
      its own. A removal that fails after the change is saved is a process
      warning (`BRIEFSTACK_LIBRARY_LOCK`), not an error, and the lock left
      behind is taken over at once by the next change in the same process
      (it holds no call) or by the stale rules in another. A change longer
      than 2 minutes can still lose its lock to the age rule; library
      changes take seconds, so the lock is not refreshed while held.
    - One action at a time holds from the first await: the slot is taken
      before the proposal is built and freed when the action ends, or when
      its proposal fails. A second action in the same turn, even one called
      in parallel, gets a tool error at once; it can no longer replace the
      waiting card and leave the first call hanging.
    - `start_creation` refuses an idea with something that looks like a
      secret and asks for it without, instead of showing it redacted on the
      card and starting the creation with the whole text.
    - The lines of a note-change card go through the secret redactor, so a
      secret line the change removes is never kept in the chat history.
    - **MCP tool-call timeout.** Source: Claude Code "Environment
      variables" (`code.claude.com/docs/en/env-vars`, read 2026-10-18):
      `MCP_TOOL_TIMEOUT` is "Timeout in milliseconds for MCP tool execution
      (default: 100000000, about 28 hours)", and a per-server `timeout`
      overrides it for that server; the idle timeout
      (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`) names stdio, HTTP, SSE,
      WebSocket and claude.ai servers only. The installed SDK (0.3.286,
      `sdk.d.ts`, `createSdkMcpServer`) says the same for in-process
      servers: `options.timeout`, else `MCP_TOOL_TIMEOUT`, "effectively
      unbounded by default". So item 9 held only while the user's
      environment set no `MCP_TOOL_TIMEOUT`, which the environment cleaning
      keeps. Now the chat server sets its own `timeout` of 1 hour
      (`CHAT_TOOL_TIMEOUT_MS`), and a card not answered within 59 minutes
      (`CHAT_CONFIRMATION_TIMEOUT_MS`) expires by itself, so the tool call
      always returns "expired, nothing was done" before Claude Code could
      time it out; a confirmation after that is refused
      (`chat.noConfirmation`). If the SDK passes the call's abort signal
      (the handler's `extra.signal`) and Claude Code gives up the call, the
      card expires at once too.

## `check-two-creations` saw the user's real folders (2026-10-18)

The first run of `scripts/real/check-two-creations.ts` gave both creations
a temp projects folder under `%LOCALAPPDATA%\Temp`, which `paths check`
reports `forbidden` (`localAppData` is protected). The interviewer then
proposed a folder in the user's real projects folder and the script's
answerer took it; the folder grants were refused, so nothing was written
there (checked by the user). The two creation transcripts under
`~/.claude/projects/<repo>/` show where the real paths came from:

1. **`settingSources: ['project', 'local']`.** `local` loads
   `<repo>/.claude/settings.local.json`; its `additionalDirectories` (the
   user's real projects and sessions folders, written by `init`) reached
   the session's environment block as "Additional working directories",
   with `"source": "localSettings"`, before the runner's own two folders.
   `local` also loaded `<repo>/CLAUDE.local.md` (the user's personal
   instructions). Source: Agent SDK "Use Claude Code features"
   (`code.claude.com/docs/en/agent-sdk/claude-code-features`, read
   2026-10-18): `"local"` loads "CLAUDE.local.md,
   `.claude/settings.local.json`".
2. **Auto memory.** The same page: auto memory at
   `~/.claude/projects/<project>/memory/` is "loaded into the system prompt
   at session start" whatever `settingSources` says; "to disable: set
   `autoMemoryEnabled: false` in settings, or
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`". The transcripts hold the
   user's `MEMORY.md` for the repo.
3. **`briefstack paths --json`**, which the skill runs at the start, printed
   `allowedDirs` from the repo's `settings.local.json` (the CLI reads that
   file, not `BRIEFSTACK_HOME`), so the real folders came back a second way.

`BRIEFSTACK_HOME` was the temp one in every child: the same `paths --json`
output shows the temp sessions folder.

In production (`briefstack web` with the real home) items 1 and 3 name the
same folders the runner passes, plus any old projects folder a Settings
change left allowed (`docs/api.md`, `PUT /api/settings`), and item 2 and
`CLAUDE.local.md` reach every creation. The other real scripts: those with
`settingSources: []` and a temp working folder (`check-effort`,
`check-guard-auto`, `check-kill-tree`, `check-subagent`, `check-web-tools`,
`check-interviewer-target`) load no settings file but did load auto memory
for their temp folder (empty there); `check-chat-read` and
`check-chat-start-creation` run the chat with `settingSources: []` in the
temp home, and the latter's creations are fake.

Decisions:

- Creation sessions load `settingSources: ['project']` only (skills, agents,
  hooks and the repo's `CLAUDE.md`); the chat and the plan-usage reading
  keep `[]`. Nothing needed `local`: the hooks are in `settings.json`, and
  the runner passes its folders as `additionalDirectories`.
- `cleanEnvironment` sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for every
  session (creation, chat, plan usage).
- A creation's environment carries `BRIEFSTACK_ALLOWED_DIRS`, a JSON list
  of the two folders the runner passes as `additionalDirectories`.
  `briefstack paths` and `paths check` report and check against that list
  when it is set, and read `settings.local.json` only when it is not (the
  terminal flow). A value that is not a list of absolute paths allows
  nothing. `cleanEnvironment` drops the variable from the server's own
  environment, so only the runner sets it. `GET /api/paths` (the server,
  not a session) still shows the settings file.
- The real scripts' `sandbox()` picks its work folder from
  `BRIEFSTACK_REAL_WORKDIR`, else the system temp folder, else
  `~/.briefstack-real`, taking the first that overlaps (either way round,
  after `realpath`) none of `protectedDirs` of the starting environment
  (repo, real home and library, `~/.claude`, `CLAUDE_CONFIG_DIR`,
  `%APPDATA%`, `%LOCALAPPDATA%`) nor the real projects folder. On Windows
  that is `~/.briefstack-real`; on macOS and Linux the system temp folder.
  It also checks that the sandbox's projects folder passes the flow's own
  check with the temp home, and stops before anything runs otherwise. It
  then sets `BRIEFSTACK_HOME` in `process.env` to the temp home, so default
  paths and every child use it. This replaces "under the system temp
  folder" in "What each real script touches" above.
- The scripts' answerer (`autoAnswer` in `scripts/real/common.ts`) never
  answers with a path outside the sandbox's projects folder. A question
  whose options name a path gets the first option whose paths are all
  inside it; with none, or when the question text names a path outside,
  the script cancels that creation. A spec is approved only when its
  summary names no path outside; a folder grant is accepted only inside.

**`shutdown()` did not return in the scripts.** Both runs ended with
"Detected unsettled top-level await" at `await manager.shutdown()`. The SDK
was not the cause: a probe with a stand-in `claude` that writes nothing
showed the message iterator ends after `query.close()` (and throws after a
kill). The cause was `closeStream`, which waits `tailMs` (1 s) on an
`unref`'d timer: once the runners' processes were gone it was the only
thing left, Node's event loop emptied, and Node (exit code 13) dropped the
pending `await`. Reproduced with the fake runner and no session at all.
`briefstack web` was not affected on Ctrl+C: its HTTP server is still
listening while `creations.shutdown()` runs (`server.close()` comes after),
so the timer fires. But nothing bounded a runner whose `stop()` never
settled, and Ctrl+C would then have waited forever (a second Ctrl+C kills
the process: the handlers are removed after the first).

- The tail wait is no longer `unref`'d.
- `CreationManager.shutdown()` and `ChatManager.shutdown()` wait at most
  `shutdownTimeoutMs` (default 15 s, `settlesWithin` in
  `src/timeLimit.ts`, whose timer keeps the process alive while it waits).
  After it, every creation not yet finished is marked interrupted and its
  stream closed; the chat stops waiting for its session.

## `check-two-creations` run 2: `creation.noReply` (2026-10-18)

The second run got both creations to the spec and both approved it. Then
the script printed `reply` for one of them and died on
`BriefstackError: creation.noReply` from `CreationManager.reply`. No
`claude` process outlived it (checked by the user). The sandbox was
deleted, so the cause is read from the code, not from that run's files.

**What the script saw.** `pending` undefined and `awaitingReply` set. The
flow writes `session.finished` *before* its hand-off text (SKILL.md: every
way out closes the session, then the user is told). The manager polls
`events.jsonl`, sees the close and finishes the creation; the hand-off
turn's `result` comes later and its `turnEnded` set `awaitingReply` on the
finished creation. The script then asked for a reply that `reply()`
refuses, since the creation is finished. A bug in the manager, not a race:
it happens every time the last turn ends after the poll. A second, smaller
cause was in the script: it read both states at once and then awaited
`readSpec` for one, so it could act on the other's stale state.

**The web page.** `creation.tsx` checks `finished` before
`awaitingReply`, so the reply box never showed on a finished creation; the
Creations list and the chat's `list_sessions` leave finished creations
out. Only the API (`GET /api/creations`, `GET /api/creations/:id`) returned
the stale field. A real race
remains and is expected: the box is shown, then a background subagent asks
something (or the creation finishes) before the user sends. The route
answers 409 `creation.noReply`, and the page shows "the page was stale"
and reloads, as for `answer`.

Fixes: `awaitingReply` is never set on a finished or cancelling creation,
and `cancel()` clears it; the script reads each state just before acting
and skips finished creations; every real script runs through
`startCheck()` (`scripts/real/common.ts`), which catches any error and
closes every query, process tree, manager and sandbox in a `finally`, also
on an unhandled rejection or uncaught exception.

### If `briefstack web` crashes (read, not tested)

Sources: Agent SDK 0.3.286 `sdk.mjs` (`ProcessTransport`: every spawned
process, ours through `spawnClaudeCodeProcess` too, is tracked, and on
Node's `exit` event the SDK runs `stdin.end()` on Windows and
`kill('SIGTERM')` elsewhere); H0 phase 2, item 6 (on `close()`, abort or
host exit, the running command is left running, orphaned, until it ends);
`src/cli.ts` (the server handles only SIGINT and SIGTERM); Claude Code
itself is a closed binary, so what it does after its host is gone is not
documented.

- **Uncaught exception or `process.exit()`.** Node emits `exit`. On
  Windows the SDK only closes each `claude` stdin: nothing kills the
  process or its tree. On macOS and Linux `SIGTERM` reaches `claude`
  alone: `spawnTracked` puts it in its own group, but the SDK signals the
  pid, not the group. `killTree()` never runs: it is only called from
  `stop()`.
- **Hard kill** (Task Manager, `taskkill /F`, SIGKILL, out of memory, the
  console closed): no handler runs at all. The pipes close when the OS
  ends the host.
- **What can still write.** A command already running goes on until it
  ends (H0 #6). The guard lets only `npm run --silent briefstack -- …`
  run, so that is one of our subcommands: a `scaffold` or a library
  `save`/`commit` finishes its write. The library queue lives in the dead
  server, so that commit can meet one from the restarted server (a git
  `index.lock` error). Folder claims are in memory too: after a restart a
  new creation can take the folder an orphan is still writing.
- **New tool calls.** Each one needs the guard, which is an SDK callback
  answered by the dead host, and creation sessions run in `auto` mode,
  whose classifier allowed a write outside the working folder in H0
  (item 7). Whether Claude Code then stops, waits forever, or treats the
  failed callback as a non-blocking hook error and goes on is not
  documented. Until a real check says otherwise, it is a risk: in the
  worst case an orphaned session writes without the guard.
- **Hook lines.** The command hooks in `.claude/settings.json` are run by
  `claude` itself and keep appending to `events.jsonl` while it lives.

**Proposed, not built** (the user decides):

1. In `briefstack web`, a synchronous `process.on('exit')` that ends every
   live tracked tree (`taskkill /PID <pid> /T /F` with `execFileSync` on
   Windows, `process.kill(-pid, 'SIGKILL')` elsewhere), and
   `uncaughtException` / `unhandledRejection` handlers that log and run the
   normal `shutdown()` with its time limit before exiting. This covers
   crashes inside Node, not hard kills.
2. A run file per active creation in the briefstack home (pid, the
   process start time, session id, claimed folder), removed when the
   runner ends. On start, `briefstack web` ends any tree it lists that is
   still alive and is the same process (same start time, so a reused pid
   is never killed), writes the `session.end` that `shutdown()` writes,
   and keeps its folder claimed until then. This covers hard kills from
   the next start on.
3. A real check, run by the user, that kills the host mid-session with a
   tool call waiting on the guard, and records what Claude Code does.
   If it goes on without the guard, item 2 is not enough and the creation
   session needs a guard that does not depend on the host (a command
   hook in `.claude/settings.json` that denies when the server's run file
   or port is gone).

### What Claude Code does without its host (docs read 2026-10-18)

Claude Code 2.1.302 and Agent SDK 0.3.286 on this machine. Sources, all
read on 2026-10-18:

- [H] Hooks reference, `code.claude.com/docs/en/hooks`: "Exit code",
  "Block the action when a hook fails", "Command hook fields", "Common
  fields", PreToolUse decision control.
- [S] Agent SDK hooks, `code.claude.com/docs/en/agent-sdk/hooks`: "Hook
  timeout", "Register multiple hooks".
- [P] Run Claude Code programmatically, `code.claude.com/docs/en/headless`:
  "Background tasks at exit", "Stop a run with SIGTERM".
- [T] Agent SDK TypeScript reference,
  `code.claude.com/docs/en/agent-sdk/typescript`: Options (`settings`,
  `settingSources`), `canUseTool`.
- [SDK] `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 0.3.286,
  `ProcessTransport` (read in the section above).

**A failing SDK callback hook.** Only the timeout is documented: "An Agent
SDK callback hook on `PreToolUse` that exceeds its timeout blocks the tool
call, and Claude receives an error result naming the timeout" [H]; "When a
callback exceeds its timeout, Claude Code cancels it and discards its
output, and the session continues rather than hanging. [...] `PreToolUse`:
Claude Code blocks the tool call" [S]. The timeout of a callback defaults
to the `command` default, 600 seconds [S]; the runner sets none. Nothing
says what happens when the callback throws or when the host that answers
it is gone. The docs' general rule for hooks is fail-open: "On most
events, when a hook fails or times out, Claude Code still carries out the
action. A policy hook with a wrong path or a crashing script then lets
everything through" [H]. So with the host dead, the documented best case
is a 10-minute wait per tool call and then a block; a failure reported
sooner than the timeout is not documented either way.

**A failing command hook.** Documented: exit 2 blocks a `PreToolUse` call;
any other exit code, a hook that cannot start, invalid JSON or a timeout
is a non-blocking error and "the action goes ahead" [H]. With
`"onFailure": "block"` on a `command` hook (Claude Code 2.1.295 or later)
every one of those failures blocks the tool call instead, as exit 2 does;
`onFailure` has no effect on hooks run with `async` [H]. The command
hook's timeout defaults to 600 seconds [H]. When several `PreToolUse`
hooks answer, "`deny` > `defer` > `ask` > `allow`" [H][S], so a deny from
a command hook wins over an allow from the callback guard. Command hooks
can be given in the `settings` option of `query()`, which "populates the
flag-settings layer" [T]; `settingSources` controls only the filesystem
settings [T]. That hooks in the flag layer run is implied (they can be
changed at runtime with `applyFlagSettings()`) but not stated; the real
check below confirms it.

**A permission request with no host.** `canUseTool` has no timeout:
"permission prompts don't time out" [T]. But "if your program closes the
session through the Agent SDK, the SDK ends Claude Code's input before
sending any signal, and Claude Code cancels the prompt as soon as the
input ends" [P].

**stdin closed mid-turn.** Not documented for a turn in progress. What is
documented: "After Claude finishes its turn and stdin has closed, a
`claude -p` run can stay open to wait for background work that Claude
started"; background subagents keep it open "until that work completes",
and other background work is stopped after 10 minutes of idle waiting [P].
On SIGTERM Claude Code ends the tree of a running Bash command, runs
`SessionEnd` hooks, "starts no new tool call, sends no new model request,
and runs no hook other than `SessionEnd`" [P]. On Node's `exit` the SDK
only ends `claude`'s stdin on Windows, and sends SIGTERM elsewhere [SDK].

**Conclusion.** After a crash of `briefstack web` on Windows, `claude`
gets an end of input and no signal. A pending question or permission
request is cancelled, but background subagents (the generator, the
reviewer) go on working, and each of their tool calls needs the callback
guard, which nobody answers. The documented outcome is a block after 600
seconds, but how a lost host is handled is not documented, and the docs
say hooks fail open in general. Commands already running finish (H0 #6).
So the guard must not depend on the host: a command hook with
`onFailure: "block"`, which Claude Code runs itself and which blocks on any
failure by documented rule, plus killing the trees when the server exits
and cleaning up at the next start.

### Windows ends a host's children with it (verified 2026-10-18)

A probe on this machine (Node 24, Windows 11): a Node process started a
non-detached child through `spawnTracked`, which started a child of its
own; the host was then ended with `taskkill /PID <host> /F` (no `/T`).
Both descendants were gone two seconds later. The same with an uncaught
exception and no exit hook. The cause is libuv: on Windows it puts every
child it spawns without `detached` in one job object of the host with
"kill on job close" (libuv `src/win/process.c`, `uv__init_global_job_handle`),
so the system ends them when the host's last handle closes, however it
ends. A process that breaks away from the job is not ended: the job
allows breakaway, and the Git Bash commands orphaned in H0 #6 are the
likely case. macOS and Linux have no such thing, and there `spawnTracked`
starts `claude` in its own process group, so nothing ends it with the
host.

So: on Windows a crash or a hard kill of `briefstack web` ends `claude`
and its subagents with it; on all three systems the exit hook
(`killLiveTreesSync`, `taskkill /T` or the process group) also ends
descendants that left the job, after an uncaught exception or
`process.exit()`. What no handler can cover on macOS and Linux after a
hard kill is left to the run files and the sweep at the next start.
