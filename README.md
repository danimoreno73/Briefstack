# briefstack

Turn a rough idea into a ready-to-use Claude project, and get better at it with
every project created.

You run `/new-project` inside Claude Code, answer a short interview, approve a
spec, and get a generated project folder for Claude Code or the Claude desktop
app. Each run is recorded in a personal library so the next interview asks less.

> Status: phase 2 in progress. Scope: [docs/BRIEF-phase-2.md](docs/BRIEF-phase-2.md); phase 1: [docs/BRIEF-phase-1.md](docs/BRIEF-phase-1.md).
> Plan: [docs/PLAN-phase-2.md](docs/PLAN-phase-2.md); phase 1: [docs/PLAN-phase-1.md](docs/PLAN-phase-1.md).

## Requirements

- Node.js 24 LTS or later
- Claude Code (talks to Claude only through your own Claude Code; no API key)
- git (optional, recommended: the personal library is kept as a git repo)
- For `briefstack web`, a current browser: Chrome or Edge 123, Firefox 121,
  Safari 17.5 (macOS and iOS) or later. The styles use the CSS `light-dark()`
  and `color-mix()` functions, the `:has()` selector and CSS nesting, with no
  fallback for older browsers.

Works on native Windows, macOS and Linux.

## Development

```sh
npm install
npm run build            # type-check and build
npm test                 # run vitest
npm run lint             # lint
npm run briefstack -- <command>   # run the CLI from source
```

## Usage profiles

`briefstack usage set <profile>` rewrites the `model` and `effort` fields of the
agent files in `.claude/agents/`. The repo ships them on `balanced`. Do not
commit profile changes; `briefstack usage show` warns when the files differ from
the committed version.
