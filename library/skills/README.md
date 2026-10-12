# Base skills

General procedures any generated project can use, one folder per skill with
a `SKILL.md`. The generator can use them for a project's `.claude/skills/`.
They assume the layout of the base templates: a brief at `docs/BRIEF.md`
with "Done when" and "Current status" sections.

| Skill | Use it to |
|---|---|
| `session-handoff` | End a session: update "Current status" in the brief, and the progress log if there is one |
| `review-against-brief` | Check the work against the brief's "Done when" list and report gaps, without fixing them |
| `decision-log` | Record a decision that is hard to reverse, with its reason and alternatives |
