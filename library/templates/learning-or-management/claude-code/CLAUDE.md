# {{name}}

{{summary}}

Read [the brief](docs/BRIEF.md) first: goal, scope and "done when" live there.

## How to work

- Start each session by reading "Current status" in the brief and the latest
  entry in [docs/PROGRESS.md](docs/PROGRESS.md).
- Propose one concrete next step at a time, sized to the time available.
- When the brief is ambiguous, ask instead of guessing.
- Check understanding or results against "Done when"; do not just add material.
- Keep notes plain markdown, linked with relative links.
- Keep real secrets (keys, passwords, tokens) out of this folder.
  `.claude/settings.json` stops Claude's file tools and common read commands
  from opening secret files, but not a script or a recursive search that
  reads them, and native Windows has no sandbox. Keep that file as it is.
- Project content language: `{{language}}`.

## End of session

Add a short entry to docs/PROGRESS.md (done, learned, stuck, next) and update
"Current status" in the brief. Run the review checklist there once a week.
