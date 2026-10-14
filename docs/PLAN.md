# briefstack — Phase 1 plan

Approved plan for phase 1. Scope comes from [BRIEF.md](BRIEF.md); this file
records how it will be built and every decision taken while planning.
Verified Claude Code behaviour goes in `docs/decisions.md` (created in H0).

Starting point: tag `phase-1-start`. Work happens on `master` in small commits,
one concern each.

## 0. Status

Updated 2026-10-13: **phase 1 done.** H10 closed, the user accepted the
project of a real run. Build, lint and 294 tests pass on Windows.
Read `CLAUDE.md`, `docs/BRIEF.md`, this file and `docs/decisions.md` before
continuing.

### Done

| # | What exists now |
|---|---|
| H0 | Claude Code behaviour verified and recorded (`decisions.md`, with probes) |
| H1 | TypeScript 6.0 / Node 24 skeleton, vitest, eslint, CI workflow (never run: no remote), README, `.gitattributes` (LF) |
| H2 | Config and paths (`BRIEFSTACK_HOME`, `BRIEFSTACK_LIBRARY`, config file), en/es i18n with coded errors, line-preserving frontmatter rewrite |
| H3 | Usage profiles: `library/usage-profiles.json`, user presets, `usage show [--json]`, `usage set [--project]`, drift and env warnings |
| H4 | Spec schema (zod → `schemas/spec.schema.json`; `files` are documents only), `scaffold` with output-folder, template and overwrite rules; scaffold applies the profile to generated agents; `spec check`; `commit` |
| H5 | `validate [--json]`: every BRIEF §6 rule plus settings and agent checks, and no application code (`code.applicationFile`) |
| H6 | Personal library: `init` (library, projects and sessions folders, both merged into `.claude/settings.local.json`), `library add/list/show/context` (context includes similar projects' session logs), INDEX, status block, dated additions, learning test; `paths [check]` |
| H7 | Base templates (software, learning-or-management, generic; `CLAUDE.md` warns to keep real secrets out), 3 base skills, 3 fixtures that validate clean for both targets |
| H8 | Events: `briefstack event <session|step>`, hook script in `.claude/settings.json` (exec form) for subagent, tool and `SessionEnd` events, only in sessions `/new-project` opened; `summarizeSession` (finished / in-progress / interrupted, at once on `session.end`, else after 120 minutes) |
| H9 | `/new-project` skill, the five agent bodies, allow rule for the CLI only; guided rehearsal: runs A (twice), B, C, D, every finding fixed (`decisions.md`, "/new-project (H9)" onwards) |
| H10 | Real run with the real home: a `claude-code` project the user accepted; `/tasks` checked for generator and reviewer; scaffold writes `.gitkeep` in empty folders; generated documents never mention how they were made (`decisions.md`, "Real run (H10)") |

### Left

Nothing for phase 1: it is closed, tag `phase-1-done`. Phase 2 has not
started; BRIEF section 8 stays out of scope until it is planned and
approved. H10 kept the two-terminal method (the user runs, a second
session inspects) and is recorded in `decisions.md`.

Still open after phase 1 (detail below):

- Verification 9 is half done: `/tasks` was seen for generator and
  reviewer only; interviewer, researcher and architect still need a
  capture during a run.
- The two H10 fixes (`.gitkeep`, no process wording in generated
  documents) have not run in a real flow.
- The known limits in "Open points and known limits".

### Next session

Development sessions on briefstack start with `claude --model opus`
(BRIEF §9; separate from the usage profiles). The user picks one of:

1. Use briefstack on real projects for a few days and collect findings
   (a chance to finish verification 9 and see the H10 fixes run).
2. Push the repo to a private GitHub repository (first CI run).
3. Plan phase 2: plan first, approval before any code.

Do not start any of them before the user chooses.

### Verified in real runs (H9 rehearsal and H10, `decisions.md` has the detail)

1. `init` from the real CLI (temp home): library git repo, projects and
   sessions folders, both entries in `settings.local.json`, git-ignored.
2. The generator writes under `projectsDir` and the main session under the
   sessions folder with no permission prompt ("accept edits").
3. A folder outside `projectsDir`: `/add-dir` refuses a missing folder,
   accepts it once created (session only); the generator then writes there.
4. `library add` dates appended entries once and commits.
5. Hooks record the five flow agents with `agentId`/`agentType`, nothing
   for ordinary work, and no Claude Code internal agents.
6. `completed` (A, B), `cancelled` (C at the spec), `interrupted` at once
   after `/exit` or closing the window (C with Esc, D), inactivity fallback
   on real data.
7. `usage show`: no drift warning, session model message.
8. Generated deny rules: `.env` denied, `.env.example` read, `.env` ignored
   by git; shell reads probed separately (scripts and `grep -r` are not
   covered).
9. (H10) `/tasks` shows the resolved model and the effort: generator and
   reviewer `Sonnet 5.5 (medium)`. Interviewer, researcher and architect
   were not captured (not verified from `/tasks`).

### Open points and known limits

- A `claude-code` project does not show its scheduled tasks anywhere (only
  `NEXT_STEPS.md` for `claude-app` does).
- The scaffolder does not copy base skills; the generator must.
- `.env.test` is left readable by the deny rules (decision; revisit if needed).
- Deny rules do not stop a script or a recursive search from reading a
  secret file, and native Windows has no sandbox; generated `CLAUDE.md` says
  to keep real secrets out.
- `paths check` sees only `settings.local.json`, not folders added with
  `/add-dir`; the skill trusts the user's confirmation.
- Agents cannot read the personal library (outside the allowed folders), so
  the architect does not see personal templates unless told about them.
- The first content of a new library note is not dated (only additions are).
- Preset models are checked for form, not against a list of real models.
- Undocumented: case sensitivity of deny-rule matching on Windows; tolerance
  of unknown fields in agent frontmatter (briefstack writes none); whether
  `SessionEnd` fires when the process is killed.
- The H10 fixes have not run in a real flow yet: `.gitkeep` is covered by
  tests; the generator rule on process wording is a prompt rule only.
- The CI workflow has never run (no remote).
- `npm install` warns that esbuild's install script is not approved
  (`allowScripts`); tests and tsx work anyway.
- Commit `ddc2312` alone has failing hook tests; `fdf9425` fixes them.
- `C:\c` from the H8 incident: the user deletes it by hand.

### Working rules learned in this phase

- No test or probe writes, or deletes, outside the repo or a system temp
  folder. From Git Bash, pass Windows-form paths (`cygpath -w`) to Windows
  programs, in arguments and in environment variables.
- Fake secrets in tests are built by concatenation.
- Worktree agents get the expected base SHA and stop if `HEAD` differs;
  eslint ignores `.claude/worktrees/`.

## 1. Decisions

### Usage profiles

- The repo's agent files stay on `balanced`. The current hand-written
  `model`/`effort` values already match it; a test checks that
  `usage set balanced` leaves them byte-for-byte unchanged.
- `usage show` compares each `.claude/agents/*.md` with its version at `HEAD`
  (`git show HEAD:<path>`) and warns if `model` or `effort` differ. Without git
  the check is skipped.
- The README says not to commit profile changes.
- Base presets live in `library/usage-profiles.json`. User presets live in
  `~/.briefstack/usage-profiles.json`, merged by name and taking precedence
  over the base ones.
- The active profile is stored in `~/.briefstack/config.json`.
- `effort` is global per preset, with an optional per-agent override.
- Non-model knobs per preset: `research` (`required-only` | `when-useful`) and
  `reviewRounds`. In `required-only` mode the interviewer marks gaps as
  factual-blocking; only those trigger the researcher.
- When the review round limit is reached and the project is still not clean,
  the flow stops and shows the findings to the user, who decides.
- The skill never passes `model` or `effort` to the Agent tool (both would
  override frontmatter). `usage show` warns if `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
  (ignores frontmatter `model`) or `CLAUDE_CODE_EFFORT_LEVEL` (overrides
  frontmatter `effort`) is set. `CLAUDE_CODE_SUBAGENT_MODEL` ranks below
  frontmatter and needs no warning. See `decisions.md` §3.

### Generated projects and their agents

- A generated project must work without briefstack installed.
- Each generated agent has a tier: `light`, `standard` or `heavy`.
  `usage-profiles.json` maps each tier to a model per preset.
- The tier is stored in the project's `.briefstack/profile.json` (with the
  profile name), not in agent frontmatter.
- The profile is reapplied from outside:
  `briefstack usage set <profile> --project <dir>`. It rewrites the project's
  agent files and `.briefstack/profile.json`, and refuses any folder without
  `.briefstack/profile.json` (not created by briefstack).

### Output directory

- Asked during the interview. Default comes from `projectsDir` in the config,
  initially `~/briefstack-projects/<slug>`.
- `scaffold` refuses, in code and with tests, any destination inside the
  briefstack repo or the personal library. Paths are compared after
  `realpath`, case-insensitively on Windows and macOS.
- An existing non-empty folder is refused unless `--allow-non-empty` is
  passed. The skill passes it only after the user confirms.
- `briefstack init` adds `projectsDir` to `permissions.additionalDirectories`
  in the repo's `.claude/settings.local.json` (gitignored), merging with what
  is there. Subagents inherit it (`decisions.md` §7, probe).
- The skill asks the user to run `/add-dir <output-dir>` only when the chosen
  folder is not already allowed there. The H9 rehearsal verifies both cases.

### Events

- Written to `~/.briefstack/sessions/<session_id>/events.jsonl`, append-only.
- Flow steps (started/finished) and the session itself
  (`session started|finished`) are emitted by the skill via
  `briefstack event`. Subagent start/stop and tool use come from hooks that
  run a cross-platform Node script in exec form (no shell):
  `node` + `${CLAUDE_PROJECT_DIR}/scripts/hook-event.mjs`.
- The hooks are in `.claude/settings.json` (H8 decision, replacing the H0
  one: skill hooks miss subagent activity). The script records only sessions
  whose folder exists, and only `briefstack event` creates it, so nothing is
  recorded while developing briefstack.
- A session without `session finished` is "interrupted" (`summarizeSession`,
  for the phase 3 panel) at once when Claude Code reports `SessionEnd`
  (`session.end` event, H9), otherwise after 120 minutes without activity.
  A finished session never changes.
- Subagent attribution uses `agent_id` and `agent_type` from the hook payload;
  subagent events without an agent type (Claude Code's own agents) are not
  recorded.

### Learning

- `briefstack library context` (library function plus command) builds the gap
  analysis input deterministically: `INDEX.md`, `profile/`, `lessons.md` and
  similar project notes. The skill passes it to the interviewer. The learning
  test checks a recorded preference shows up there.
- `library add` appends to an existing note before creating a new one, keeps
  `INDEX.md` up to date and commits to the library's git repo. `init` runs
  `git init`. If git is missing, the CLI warns and continues.

### Targets

- `claude-code`: as in the brief. The generated `.claude/settings.json`
  holds deny rules only, never hooks or allow rules: project hooks run even
  before a folder is trusted (`decisions.md` §8).
- `claude-app`: context files, `INSTRUCTIONS.md`, `NEXT_STEPS.md`, and an
  initialised git repo; no `.claude/settings.json`. `CLAUDE.md` length rule
  applies only when the file exists.
- `NEXT_STEPS.md` says "the Claude desktop app", never "Cowork". It covers:
  create a project from this folder, paste the instructions, create any
  scheduled tasks (with their text; from the project or Scheduled → New task;
  paid plans only), and the web fallback (create project, paste instructions,
  upload files). See `decisions.md` §11.

### Validation details

- Absolute path detection: the real home directory, drive letters (`X:\`),
  `/Users/`, `/home/`. Paths starting with `~` are allowed (needed for deny
  rules), and so are `//**` deny patterns.
- Agent files in generated projects must not list `Agent` in `tools`
  (subagents can spawn subagents by default). A unit test checks the same
  for the five flow agents in `.claude/agents/`.

### Language

- CLI output language: `BRIEFSTACK_LANG` > config > OS locale > `en`.
  Strings live in `src/i18n/`, one module per command area to avoid merge
  conflicts. The skill talks to the user in the user's language.

### Stack

- TypeScript on Node 24 LTS, npm, vitest.
- Runtime deps: `yaml` (frontmatter), `zod` (single spec schema; also exports
  `schemas/spec.schema.json` for the architect).
- Dev deps: `typescript`, `vitest`, `eslint`, `typescript-eslint`, `tsx`.

### CI

- A GitHub Actions workflow (Windows, macOS, Linux matrix) is added but not
  exercised: there is no remote. Real verification is local on Windows plus
  tests that use both `path.win32` and `path.posix`. `decisions.md` records
  that CI is untested.

## 2. Claude Code behaviour to verify (H0)

Each item goes into `docs/decisions.md` with source URL, date read and
conclusion.

1. Whether a subagent can ask the user anything (`AskUserQuestion` in
   subagents). The design assumes it cannot.
2. Subagent frontmatter: valid fields, `model` values (aliases, full IDs,
   `inherit`), whether `effort` exists and its values, `tools` format.
3. Subagent model resolution order: `CLAUDE_CODE_SUBAGENT_MODEL`, the Agent
   tool's `model` parameter, frontmatter, session model.
4. Whether edits to `.claude/agents/*.md` apply in the running session or need
   a restart or `/agents`.
5. Hooks: available events, stdin payload (`session_id`, `cwd`, agent id),
   which shell runs hook commands on native Windows, `$CLAUDE_PROJECT_DIR`,
   whether hooks can be scoped to a skill.
6. Skills: location and frontmatter fields, `$ARGUMENTS`, running in the main
   context (no `context: fork`), subagents cannot spawn subagents.
7. Permissions when a subagent writes outside the working directory
   (`additionalDirectories`, `/add-dir`).
8. Deny rule syntax for common secret locations, and that it works on Windows.
9. Whether `/tasks` shows each subagent's model.
10. `claude -p --model` / `--effort` flags (documented only; used in phase 2).
11. Desktop app: project from an existing folder, project instructions,
    scheduled tasks per project, web-only fallback by uploading files.
12. Whether unknown frontmatter fields in agents and skills are tolerated
    (needed by the validator).
13. Which base a subagent with `isolation: worktree` starts from when there is
    no remote (default branch vs session `HEAD`), and confirmation that the
    parallel batches start with H2 and H4 included.

**Checkpoint:** after H0, stop and show the user every finding that changes
the design before continuing.

**Status (2026-10-12):** done. Results in `docs/decisions.md`; the
checkpoint approved the changes now reflected in section 1. Item 7 was also
probed with real `claude -p` runs before H2 (subagents inherit additional
directories). `${CLAUDE_PROJECT_DIR}` was settled in H8 (exec form, no
shell; Git Bash and PowerShell forms also work). Still to check in real
runs: see "0. Status".

## 3. Repo layout

```
src/
  cli.ts                 # argument parsing only; calls the library
  index.ts               # public API (callable from a web server in phase 2)
  config/                # path resolution: env > config > ~/.briefstack
  i18n/                  # all user-facing strings, en and es
  frontmatter/           # read/rewrite YAML frontmatter, body preserved
  spec/                  # zod schema + JSON Schema export
  models.ts              # valid model and effort values (usage + validate)
  packageRoot.ts         # the repo / installed package folder
  scaffold/  validate/  library/  usage/  events/
library/
  usage-profiles.json
  templates/{software,learning-or-management,generic}/
  skills/{session-handoff,review-against-brief,decision-log}/
schemas/spec.schema.json # generated (npm run schema); read by the architect
scripts/hook-event.mjs   # hook entry point (plain JS) + hook-event.d.mts types
scripts/generate-schema.ts
.claude/skills/new-project/SKILL.md   # H9; opens and closes the session
.claude/agents/*.md      # body edits only; never model/effort by hand
.claude/settings.json    # worktree.baseRef + event hooks (exec form)
.claude/settings.local.json  # gitignored; init adds projectsDir here
tests/
  unit/
  fixtures/{software,learning,novel}.spec.json
docs/  BRIEF.md  PLAN.md  decisions.md
README.md
```

## 4. Milestones

Every milestone ends with `npm run build`, `npm test` and `npm run lint`
passing.

| # | Milestone | Verification |
|---|---|---|
| H0 | Verify section 2 → `docs/decisions.md` | Each item with URL, date, conclusion; design-changing findings reviewed with the user |
| H1 | Skeleton: package.json, tsconfig, eslint, vitest, CI workflow, README | build/test/lint green with a trivial test |
| H2 | Core: config/paths, i18n, frontmatter | Unit tests with `path.win32` and `path.posix` |
| H3 | Usage profiles: data file, user presets, `usage show/set`, `--project` | Usage test: 3 presets + a custom one; `balanced` is a no-op; drift warning; `--project` refuses foreign folders |
| H4 | Spec schema + `scaffold` (incl. output directory rules) | Unit tests; invalid spec gives a clear error; forbidden and non-empty destinations refused |
| H5 | `validate` (every rule in BRIEF section 6) | One positive and one negative test per rule |
| H6 | Library: `init/add/list/show/context`, INDEX, wikilinks, git; `init` also updates `settings.local.json` | Tests in a temp dir + learning test; merge test for `settings.local.json` |
| H7 | Base templates, base skills, 3 fixtures | 3 specs × 2 targets scaffold and validate cleanly |
| H8 | Events: `briefstack event` + hook script | jsonl writer test; manual check that subagent events arrive |
| H9 | `/new-project` skill + agent body adjustments; the skill opens the session first (`event session started --session ${CLAUDE_SESSION_ID}`) and closes it on every way out (completed, cancelled, failed) | Guided rehearsal with the user, including a cancelled run that shows as finished/cancelled and an aborted one that shows as interrupted |
| H10 | Real end-to-end run + `/tasks` check | User accepts the generated project. Phase 1 is not done before this |

## 5. Parallel work

At most two subagents at a time.

- **H0 ‖ H1:** two `claude-code-guide` agents —
  (A) subagents, models, `/tasks`, `claude -p`, worktree base;
  (B) hooks, skills, permissions, deny rules, desktop app —
  while the main session builds H1.
- **After H2 and H4 are committed:** batch 1 = H3 ‖ H5, batch 2 = H6 ‖ H7,
  each in its own worktree. The main session integrates and runs
  build/test/lint after each batch.
- Integration after batch 1: `scaffold` applies the spec's profile to the
  generated agents through the H3 code (`usage set --project` logic).
- Worktrees start from the local `HEAD`: `.claude/settings.json` sets
  `worktree.baseRef: "head"`. The main session passes the expected base SHA
  in each worktree agent's prompt; the agent's first step is
  `git rev-parse HEAD`, and it stops and reports if the SHA differs.
- **Not delegated:** the H0 checkpoint, the skill and flow design (H9),
  integration, and the real run (H10).
