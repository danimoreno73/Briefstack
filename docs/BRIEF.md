# briefstack — Phase 1 brief: Creator + Library

> Phase 1 of 5. This file is the source of truth for scope.
> If something here conflicts with a later instruction in chat, ask before building.

## 1. What this is

A local tool that turns a rough idea into a ready-to-use Claude project, and gets
better at it with every project created.

The problem: setting up a Claude project by hand (refining the idea, writing
instructions, deciding files, memory and structure) takes about two hours and is
nearly the same work every time.

Phase 1 delivers the core with **no web UI**: the user runs one command inside
Claude Code, answers a short interview, and gets a generated project folder.

## 2. Users and constraints

- Any user, any kind of project (software, research, learning, personal
  management, writing...). Nothing may be hard-coded to the author's own projects.
- Local use. No login, no accounts, no telemetry.
- Must run on **native Windows**, macOS and Linux. No hard-coded absolute paths,
  no POSIX-only shell assumptions. Use path APIs, never string concatenation.
- Talks to Claude **only through the user's own Claude Code** (interactive
  session or `claude -p`). No Anthropic API key, no `--bare`.
- May be published later as a free GitHub repo: nothing personal in the repo.

## 3. Deliverables

### 3.1 The `/new-project` skill

Entry point. Runs in the main session and orchestrates the flow in section 4.
The main session is the only one that talks to the user.

### 3.2 Five subagents (`.claude/agents/`)

| Agent | Job | Tools |
|---|---|---|
| `interviewer` | Gap analysis: given the idea, the user profile and past lessons, return the shortest list of questions still needed. Does not talk to the user. | Read, Grep, Glob |
| `researcher` | Look up facts the project needs (tools, conventions, comparable setups). Returns findings with sources. | WebSearch, WebFetch, Read |
| `architect` | Decide project type, target and structure. Recommend a target, or respect the user's choice. Output: a project spec. | Read, Grep, Glob |
| `generator` | Turn the spec into files by calling the CLI scaffolder and filling templates. | Read, Write, Edit, Bash, Glob |
| `reviewer` | Read-only check of the generated project against the spec and the validator output. Lists problems; does not fix. | Read, Grep, Glob, Bash |

Each agent's model and effort come from the active usage profile (section 3.5),
never from a value hard-coded in the agent file by hand.

Before relying on a subagent asking the user anything, check the official docs.
The design assumes subagents cannot, and the main session asks.

### 3.3 A small CLI (`briefstack`)

Deterministic work must be code, not prompts:

- `briefstack init` — create the personal library if missing.
- `briefstack scaffold <spec.json> <out-dir>` — create the folder tree from a spec.
- `briefstack validate <project-dir>` — check a generated project (section 6).
- `briefstack library <add|list|show>` — read and update library entries.
- `briefstack usage <show|set <profile>>` — show or change the usage profile.

Stack: TypeScript on current Node LTS, npm, vitest. Keep dependencies minimal.
If you want a different stack, say why in the plan and wait for approval.

### 3.4 Two libraries

**Base library** (in the repo, `library/`): general templates and skills only.
Ship at least three project templates: `software`, `learning-or-management`,
`generic`. The generic one must work for an idea that fits neither of the others.

**Personal library** (outside the repo; default `~/.briefstack/library`,
overridable by config or env var). Plain markdown, usable as an Obsidian vault
but with no dependency on Obsidian:

```
INDEX.md      short index, the only file always read
profile/      user preferences: style, tools, way of working
templates/    user's own or adapted templates
skills/       reusable procedures
projects/     one note per created project: summary, target, path, status
log/          one note per creation session, index at the top
lessons.md    what was over-asked, what the user corrected
```

Rules: read `INDEX.md` first and open detail only on demand; append to an
existing note before creating a new one; link notes with `[[wikilinks]]`;
never store secrets, credentials or sensitive personal data; keep it a local
git repo so changes can be undone.

### 3.5 Usage profiles

The user chooses how much to spend. One setting drives every agent's model and
effort and how thorough the flow is. Phase 2 will expose it as a slider; phase 1
ships the mechanism and the CLI command.

Starting presets (tune them, keep the three levels):

| | `saver` | `balanced` (default) | `max` |
|---|---|---|---|
| interviewer | haiku | sonnet | opus |
| researcher | haiku, only if the spec cannot be written without it | haiku | sonnet |
| architect | sonnet | opus | opus |
| generator | sonnet | sonnet | opus |
| reviewer | haiku | sonnet | opus |
| effort | low | medium | high |
| review rounds | 1 | up to 2 | until clean, max 3 |

Requirements:

- Presets live in one data file (`library/usage-profiles.json`), not in code.
  Users can edit them or add their own.
- `briefstack usage set <profile>` rewrites the `model` and `effort` frontmatter of
  the agent files from that data file. It is the only thing allowed to write
  those two fields.
- The flow reads the active profile for the non-model knobs (skip research,
  number of review rounds).
- When the tool launches Claude Code itself (`claude -p`, phase 2 onwards), it
  passes the session model and effort for the profile as CLI flags. In an
  interactive session it cannot change the session model: tell the user which
  model the profile expects.
- Verify the result against the docs' model resolution order, and by checking
  `/tasks` during a real run.
- Generated projects record the profile they were created with; if the
  generated project has its own agents, they get the same treatment.
- Do not show token or cost predictions as if they were exact. Label the levels
  qualitatively and point to `/usage` for real consumption.

## 4. The creation flow

1. **Idea.** User describes it in free text.
2. **Gap analysis.** `interviewer` reads the idea, `profile/` and `lessons.md`
   and returns only the questions whose answers are not already known.
3. **Interview.** Main session asks them, in small batches, each with a proposed
   default so the user can accept quickly.
4. **Research** (only if needed). `researcher` fills factual gaps.
5. **Spec.** `architect` writes `spec.json` plus a human-readable summary.
   The user approves or edits it. This is the one mandatory checkpoint.
6. **Generate.** `generator` scaffolds and fills the project.
7. **Validate and review.** `briefstack validate`, then `reviewer`. Fix and repeat
   until clean.
8. **Learn.** Write the project note, the session log, new lessons, and any
   preference the user explicitly stated.
9. **Hand-off.** Print where the project is and the exact next steps.

## 5. Targets

**`claude-code`** — fully automatic. The generated folder contains: a short
`CLAUDE.md`, `docs/BRIEF.md`, `.claude/skills/` and `.claude/agents/` when the
project needs them, `.claude/settings.json` with deny rules for common secret
locations, `.gitignore`, and an initialised git repo.

**`claude-app`** — a folder the user registers as a project in the Claude
desktop app ("use an existing folder"). The tool cannot create that project
itself. The folder contains the context files plus:

- `INSTRUCTIONS.md` — the project instructions, ready to paste.
- `NEXT_STEPS.md` — the exact manual steps: create the project from this
  folder, paste the instructions, create any scheduled tasks (with their text).
  Include the fallback for web-only users: create the project and upload files.

If the user does not choose a target, `architect` recommends one and says why.

## 6. Verification — definition of done

`briefstack validate` must check, at minimum:

- Required files for the target exist and are non-empty.
- Frontmatter of every skill and agent file parses and has the required fields.
- `CLAUDE.md` is under 60 lines.
- No secret-looking strings and no absolute paths from the build machine.
- Every `[[wikilink]]` and relative link resolves.

Tests (vitest), all passing on Windows and POSIX path styles:

- Unit tests for scaffold, validate and library commands.
- Three fixture specs (software, learning-or-management, an unrelated idea such
  as a novel) scaffold and validate cleanly for both targets.
- Learning test: after a first creation records a preference, the gap analysis
  input for a second creation already contains it.
- Usage test: `briefstack usage set` for each preset produces agent files whose
  `model` and `effort` match the data file, and a custom preset works too.

Phase 1 is done when: tests pass, `npm run build` is clean, the three fixtures
validate, and one real end-to-end run of `/new-project` produces a project the
user accepts. Do not report done before that.

## 7. Prepare for later phases, without building them

- Write lifecycle events (flow step started/finished, subagent start/stop, tool
  used) to an append-only `events.jsonl` in the session folder, using hooks.
  Phase 3 will draw the live agent panel from it.
- Keep the CLI usable as a library so a web server can call it in phase 2.
- Each project note in `projects/` keeps a short status block: phase 4's
  global chat will read these.

## 8. Out of scope for phase 1

Web UI. Live agent panel. Global chat across projects. Self-modification of the
tool. Any use of the Anthropic API. Creating Claude app projects automatically.
Running anything with permissions bypassed.

## 9. Working rules

- Build setup: the session that builds this tool runs on Opus. This is separate
  from the usage profiles, which govern the tool's own agents at run time.
- Plan first; get the plan approved before writing code.
- Small commits, one concern each. Never commit the personal library.
- Run tests before saying something works.
- Only launch agents in folders this tool created.
- Code and documentation in English. User-facing strings in English and
  Spanish, kept in one place.
- When a requirement is ambiguous, ask instead of guessing.
