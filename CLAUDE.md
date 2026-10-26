# briefstack

Local tool that turns an idea into a ready-to-use Claude project and learns from
each one.

## Current state

Phase 7 is in progress (tag `phase-7-start`): tasks in existing projects.
Scope and requirements: @docs/BRIEF-phase-7.md — read it before planning.
The plan, with its Status, is `docs/PLAN-phase-7.md`; H0 is in
`docs/decisions.md`, "Phase 7". No code of the phase is written before the
user approves H0 and the plan.

`v1.0.0` is published. The living backlog is `docs/IDEAS.md`. The briefs
and plans of phases 1–6, the UI pass and the release are in
`docs/history/` (tags `phase-1-done` … `phase-6-done`, `ui-done`,
`v1.0.0`); open them only when needed. Backlogs 1 and 2 are done (tags
`backlog-1-done`, `backlog-2-done`; `docs/PLAN-backlog-1.md`,
`docs/PLAN-backlog-2.md`). Contributors' rules are also in
`CONTRIBUTING.md`.

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
- `.claude/agents/` — the five flow agents
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
