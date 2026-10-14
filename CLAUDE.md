# briefstack

Local tool that turns an idea into a ready-to-use Claude project and learns from
each one. Scope and requirements: @docs/BRIEF-phase-2.md — read it before planning.

## Current phase

Phase 2: local web app over the phase 1 core. Anything listed in BRIEF section 7
is out of scope; do not start it. Phase 1 is done (tag `phase-1-done`); its
brief is `docs/BRIEF-phase-1.md`, open it only when needed.

## Commands

- `npm run build` — type-check and build
- `npm test` — run vitest
- `npm run lint` — lint
- `npm run briefstack -- <command>` — run the CLI from source

A task is not done until build, tests and lint pass. Run them; do not assume.

## Layout

- `src/` — the `briefstack` CLI and its library code
- `library/` — base library shipped with the repo (templates, skills, usage profiles)
- `.claude/skills/new-project/` — the entry-point skill
- `.claude/agents/` — the five flow agents
- `tests/` — unit tests and fixture specs
- `docs/` — brief and design notes

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
- When the brief is ambiguous or contradicts itself, ask.
- If a Claude Code behaviour matters to the design, check the official docs
  instead of assuming, and note what you verified in `docs/decisions.md`.
