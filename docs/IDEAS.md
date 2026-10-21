# briefstack — ideas

Ideas to review after the UI pass. None of them is planned or in scope yet:
they are not in any brief or plan, and nothing here is to be built until the
user decides so.

## 1. A library of third-party skills

- Add skills from the chat or from a page: a GitHub link, a zip or a
  `SKILL.md`.
- Store them in the personal library with their source, a pinned commit,
  the license and tags.
- Quarantine with an automatic review (scripts, network access, hooks,
  `allowed-tools`, a safety warning) and the user's approval before use.
- The architect proposes which skills to include in each project and which
  subagents they go to.
- Add them to existing projects too, with a confirmation.
- briefstack never runs them.

## 2. Working inside projects from briefstack

Today briefstack only creates projects; the work on them happens in Claude
Code or the app. To consider: whether the global chat should be able to
open and direct work sessions in an existing project.
