# {{name}}

{{summary}}

Read [the brief](docs/BRIEF.md) first: goal, scope and "done when" live there.

## How to work

- Start each session by reading "Current status" in the brief.
- When the brief is ambiguous, ask instead of guessing.
- Propose before making large changes; keep the user's voice and choices.
- Check work against "Done when" in the brief.
- Ideas, open questions and references go in
  [docs/NOTES.md](docs/NOTES.md); settled points move into the brief.
- Keep real secrets (keys, passwords, tokens) out of this folder.
  `.claude/settings.json` stops Claude's file tools and common read commands
  from opening secret files, but not a script or a recursive search that
  reads them, and native Windows has no sandbox. Keep that file as it is.
- Project content language: `{{language}}`.

## End of session

Update "Current status" in the brief: what was done, what is next.
