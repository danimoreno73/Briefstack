# briefstack

Local tool that turns an idea into a ready-to-use Claude project and learns from
each one.

## Current state

Phases 7 to 10 are done (tags `phase-7-done` … `phase-10-done`): tasks
in existing projects; Codex in tasks (off by default); builds (from a
project's brief, briefstack plans a queue of tasks and runs it unattended
on an integration branch; the user applies the whole build at the end);
and a creation that can also write a first version of the code (web app,
`software` projects for Claude Code, chosen at the spec checkpoint), with
an `implementer` agent that has no shell, the exact commands the user
approved, checks and fix passes, two commits, and Codex without its shell
when ticked. Their briefs and plans are in `docs/history/` (phase 8 has a
brief with what changed and no plan); their decisions are in
`docs/decisions.md`, "Phase 7" to "Phase 10" (the closes: "Phase 7: M9
accepted, phase closed", "Phase 8: closed", "Phase 9: accepted", "Phase
10: accepted"). What they leave open is in `docs/IDEAS.md` §7 to §10.
Version 1.2.0 is prepared in `CHANGELOG.md` and `package.json`; its tag
`v1.2.0` and the GitHub release are the user's to make.

Phase 11 is in progress: the build's board and cards run in parallel
(`docs/BRIEF-phase-11.md`, `docs/PLAN-phase-11.md` with its Status;
decisions in `docs/decisions.md`, "Phase 11"). Its milestones M1–M5 are
written; it is not done until the user runs
`scripts/real/check-build-parallel.ts` and accepts it.

`v1.0.0` and `v1.1.0` are published. The living backlog is
`docs/IDEAS.md`. The briefs and plans of phases 1–10, the UI pass, the
release and backlogs 1 and 2 are in `docs/history/` (tags `phase-1-done`
… `phase-10-done`, `ui-done`, `v1.0.0`, `backlog-1-done`,
`backlog-2-done`); open them only when needed. Contributors' rules are
also in `CONTRIBUTING.md`.

## Commands

- `npm run build` — type-check and build
- `npm test` — run vitest
- `npm run lint` — lint
- `npm run briefstack -- <command>` — run the CLI from source

A task is not done until build, tests and lint pass. Run them; do not assume.

CI runs on GitHub (Linux, Windows and macOS). After every push, check it with `gh run list` and
`gh run watch` (if `gh` is not available, say so and read the public API,
`https://api.github.com/repos/danimoreno73/Briefstack/actions/runs`). A
milestone is not done while CI is red; local Windows runs do not stand in for it.

## Layout

- `src/` — the `briefstack` CLI and its library code
- `library/` — base library shipped with the repo (templates, skills, rules, usage profiles)
- `.claude/skills/new-project/` — the entry-point skill
- `.claude/agents/` — the five flow agents and the implement step's `implementer`
- `tests/` — unit tests and fixture specs
- `docs/` — reference (web API, events, design, decisions) and the backlog
  (`IDEAS.md`); `docs/history/` — past briefs, plans and the UI audit

## Rules

- Cross-platform: native Windows, macOS, Linux. Use `node:path` and `node:os`;
  never build paths by string concatenation; no POSIX-only shell commands in code.
- No absolute paths from this machine in code, tests, templates or docs.
  In versioned documents, write this machine's paths with `<home>` or
  `<user>`, also when recording incidents.
- The personal library lives outside the repo. Never commit it, never read a
  user's real one in tests; use a temp directory.
- No secrets anywhere. No Anthropic API key, no `--bare`.
- `model` and `effort` in `.claude/agents/*.md` are written only by
  `briefstack usage set`. Do not edit them by hand.
- Deterministic work (creating folders, validating, rewriting frontmatter) is
  code with tests, not prompt instructions.
- Only launch agents in folders this tool created.
- Code and docs in English. User-facing strings in English and Spanish, all in
  `src/i18n/`.

## How to work

- Plan first and wait for approval before writing code.
- Small commits, one concern each.
- Write and edit files with the Write and Edit tools, never through shell
  heredocs, echo or inline scripts that embed the file's text.
- When the brief is ambiguous or contradicts itself, ask.
- If a Claude Code behaviour matters to the design, check the official docs
  instead of assuming, and note what you verified in `docs/decisions.md`.
