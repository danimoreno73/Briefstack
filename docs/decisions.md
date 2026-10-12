# Decisions and verified Claude Code behaviour

Each entry: what was checked, source, date read, conclusion. "Inferred" marks a
conclusion read between the lines rather than stated by the docs.

## Tooling

### TypeScript pinned to 6.0.x (2026-10-12)

TypeScript 7.0.2 is the npm `latest`, but `typescript-eslint@8.71.1` declares
`typescript: ">=4.8.4 <6.1.0"` as its peer dependency (`npm view`). TypeScript
stays on `~6.0.3` until typescript-eslint supports 7.

### CI untested (2026-10-12)

`.github/workflows/ci.yml` runs build, lint and test on Windows, macOS and
Linux, but the repo has no remote, so it has never run. Real verification is
local on Windows plus tests that use both `path.win32` and `path.posix`.

## Claude Code behaviour (H0)

Read on 2026-10-12. Conclusions marked **changes the plan** are pending the
H0 checkpoint with the user. Main sources:

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

Conclusion: the generator writes to `~/briefstack-projects/<slug>` by default,
which is outside the repo. The skill tells the user to approve the prompt or
run `/add-dir <dir>` first. Behaviour with a subagent is checked in H9.

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

Conclusion: generated `.claude/settings.json` denies `Read(.env)`,
`Read(.env.*)`, `Read(**/*.pem)`, `Read(**/*.key)`, `Read(~/.ssh/**)`,
`Read(~/.aws/**)`, `Read(~/.config/gcloud/**)`, `Read(~/.azure/**)`,
`Read(~/.npmrc)`, `Read(~/.netrc)`. The validator allows `~/` and `//**`
patterns and keeps rejecting machine paths.

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

Conclusion: `claude-app` targets a Cowork project. `NEXT_STEPS.md` gives the
Cowork steps, the scheduled task text with "from the project or from
Scheduled → New task", a note that scheduled tasks need a paid plan, and the
web fallback (create project, paste instructions, upload files).

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
same base branch"). To remove the doubt, set `worktree.baseRef: "head"` before
batch 1, and check the base commit in each worktree.

### Subagents can spawn subagents

Source: sub-agents. "By default, a subagent can spawn subagents of its own, up
to three layers below the main conversation." `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`
turns it off.

Conclusion — **changes the plan**: the assumption "subagents cannot spawn
subagents" is false. None of the five flow agents has the `Agent` tool in its
`tools` list, so they cannot spawn; the validator should keep it that way for
flow agents.
