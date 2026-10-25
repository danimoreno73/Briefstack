# Contributing to briefstack

Thanks for helping. This file says how to build and test briefstack and the
rules every change follows, whether you write it yourself or with Claude
Code.

## Set up

```sh
git clone https://github.com/danimoreno73/Briefstack.git
cd Briefstack
npm install
npx playwright install chromium   # once, for the end-to-end tests
```

Node.js 24 or later. Windows, macOS and Linux are all supported; Windows is
a primary platform, so test there when your change touches paths,
processes or the shell.

## Gates

A change is done when all of these pass. Run them; do not assume.

```sh
npm run build      # type-check and build
npm run lint
npm test           # unit tests
npm run test:e2e   # end-to-end tests over the fake runners
```

The CI runs the same on Linux, Windows and macOS for every push and pull request.

The tests never reach the network, never start a real Claude Code session
and never touch your own data: they work in temp folders, with a fake
runner instead of Claude Code and a local fake GitHub. Checks that need a
real Claude Code session live in `scripts/real/`; they ask for `--yes`,
work in a sandbox and are run by a person, never by the tests or the CI.

## Rules

- **Cross-platform.** Use `node:path` and `node:os`; never build paths by
  string concatenation, and no POSIX-only shell commands in code.
- **No machine paths or personal data** in code, tests, templates or docs.
  Write a home folder as `<home>` and a user name as `<user>`. Test data
  uses placeholder domains (`example.com`) and invented names.
- **No secrets anywhere.** No API key in code, tests or fixtures; build
  fake keys at run time when a test needs one.
- **The personal library lives outside the repo.** Never commit one, and
  never read a real one in tests.
- **Deterministic work is code with tests,** not prompt instructions:
  creating folders, validating, rewriting frontmatter.
- **`model` and `effort` in `.claude/agents/*.md`** are written only by
  `briefstack usage set`. Do not edit them by hand, and do not commit a
  profile change.
- **Strings the user sees** are in English and Spanish, in `src/i18n/`.
  Code, comments, commit messages and docs are in English.
- **Small commits,** one concern each, with the gates green.
- **Ask when unsure.** If a Claude Code behaviour matters to the design,
  check the official docs and record what you verified in
  `docs/decisions.md`.

## Working with Claude Code in this repository

`CLAUDE.md` holds the same rules for Claude Code sessions. In addition:

- Files are written and edited only with Claude Code's Write and Edit
  tools, never through shell redirection, `sed -i`, heredocs or inline
  scripts that embed a file's text. `.claude/settings.json` denies some
  common forms (`sed -i`, `perl -i`, `tee`, `node -e`, `python -c`, and in
  PowerShell `Set-Content`, `Out-File`, `Add-Content`, `New-Item -Value`
  and `>`). Deny rules match command text, so they cannot catch every way
  to write a file: a Bash redirection such as `echo x > file` is not
  caught, and neither are .NET calls, `sh -c` or a script that writes.
  Treat them as a reminder, not as a guarantee (`docs/decisions.md`,
  "Deny rules").
- Plan first and get the plan approved before writing code.
- Only launch agents in folders briefstack created.

## Pull requests

Describe what changes and why, how you tested it (which gates, which
platform) and, for a change in behaviour, the docs you updated
(`README.md`, `docs/api.md`, `docs/decisions.md`). Security problems go
through [SECURITY.md](SECURITY.md), not a pull request or an issue.
