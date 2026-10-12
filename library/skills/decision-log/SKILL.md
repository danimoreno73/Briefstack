---
name: decision-log
description: Records a decision that is hard to reverse (a tool, a format, a structure, a scope cut) with its reason and the alternatives considered. Use when the user settles a choice that later sessions should not reopen by accident.
---

# Decision log

Keep a short, append-only record of decisions so later sessions know what
was chosen and why.

## Steps

1. Use `docs/DECISIONS.md`. If it does not exist, create it with a one-line
   introduction and link it from the brief.
2. Add an entry at the top, below the introduction:
   - a heading with the date (YYYY-MM-DD) and a short title;
   - **Decision:** one or two sentences;
   - **Why:** the reason, in the user's terms;
   - **Alternatives:** what else was considered and why it lost.
3. If the decision replaces an earlier one, say so in the new entry and add
   "Superseded by" with the new date to the old one. Do not delete it.
4. If the decision changes scope, ask the user whether the brief should be
   updated too.

## Rules

- One decision per entry. Keep each entry under ten lines.
- Only record decisions the user agreed to, not proposals.
- Never write secrets, credentials or personal data.
