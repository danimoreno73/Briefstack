# {{name}}

{{summary}}

Read [the brief](docs/BRIEF.md) before planning: goal, scope and "done when"
live there.

## Commands

None yet. Add the build, test and lint commands here as soon as they exist.

## How to work

- Plan first for anything non-trivial. When the brief is ambiguous, ask.
- Small commits, one concern each.
- A task is done when build, tests and lint pass. Run them; do not assume.
- Record decisions that are hard to reverse in
  [docs/DECISIONS.md](docs/DECISIONS.md).
- Keep real secrets (keys, passwords, tokens) out of this folder.
  `.claude/settings.json` stops Claude's file tools and common read commands
  from opening secret files, but not a script or a recursive search that
  reads them, and native Windows has no sandbox. Keep that file as it is.- Project content language: `{{language}}`.

## End of session

Update "Current status" in the brief: what was done, what is next.
