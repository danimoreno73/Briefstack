# briefstack — Phase 1 plan

Approved plan for phase 1. Scope comes from [BRIEF.md](BRIEF.md); this file
records how it will be built and every decision taken while planning.
Verified Claude Code behaviour goes in `docs/decisions.md` (created in H0).

Starting point: tag `phase-1-start`. Work happens on `master` in small commits,
one concern each.

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
- The skill never passes `model` to the Agent tool. `usage show` warns if
  `CLAUDE_CODE_SUBAGENT_MODEL` (or whatever H0 finds overrides frontmatter)
  is set.

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

### Events

- Written to `~/.briefstack/sessions/<session_id>/events.jsonl`, append-only.
- Flow steps (started/finished) are emitted by the skill via
  `briefstack event`. Subagent start/stop and tool use come from hooks that
  run a cross-platform Node script, never a POSIX shell script.

### Learning

- `briefstack library context` (library function plus command) builds the gap
  analysis input deterministically: `INDEX.md`, `profile/`, `lessons.md` and
  similar project notes. The skill passes it to the interviewer. The learning
  test checks a recorded preference shows up there.
- `library add` appends to an existing note before creating a new one, keeps
  `INDEX.md` up to date and commits to the library's git repo. `init` runs
  `git init`. If git is missing, the CLI warns and continues.

### Targets

- `claude-code`: as in the brief.
- `claude-app`: context files, `INSTRUCTIONS.md`, `NEXT_STEPS.md`, and an
  initialised git repo; no `.claude/settings.json`. `CLAUDE.md` length rule
  applies only when the file exists. Scheduled tasks per project are
  confirmed in H0.

### Validation details

- Absolute path detection: the real home directory, drive letters (`X:\`),
  `/Users/`, `/home/`. Paths starting with `~` are allowed (needed for deny
  rules).

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

## 3. Repo layout

```
src/
  cli.ts                 # argument parsing only; calls the library
  index.ts               # public API (callable from a web server in phase 2)
  config/                # path resolution: env > config > ~/.briefstack
  i18n/                  # all user-facing strings, en and es
  frontmatter/           # read/rewrite YAML frontmatter, body preserved
  spec/                  # zod schema + JSON Schema export
  scaffold/  validate/  library/  usage/  events/
library/
  usage-profiles.json
  templates/{software,learning-or-management,generic}/
  skills/
schemas/spec.schema.json # generated; read by the architect
scripts/hook-event.mjs   # hook entry point
.claude/skills/new-project/SKILL.md
.claude/agents/*.md      # body edits only; never model/effort by hand
.claude/settings.json    # hooks
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
| H6 | Library: `init/add/list/show/context`, INDEX, wikilinks, git | Tests in a temp dir + learning test |
| H7 | Base templates, base skills, 3 fixtures | 3 specs × 2 targets scaffold and validate cleanly |
| H8 | Events: `briefstack event` + hook script | jsonl writer test; manual check that subagent events arrive |
| H9 | `/new-project` skill + agent body adjustments | Guided rehearsal with the user |
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
- **Not delegated:** the H0 checkpoint, the skill and flow design (H9),
  integration, and the real run (H10).
