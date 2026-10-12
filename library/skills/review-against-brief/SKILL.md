---
name: review-against-brief
description: Checks the current state of the project against the "Done when" list and the constraints in the project brief, and reports what is met, what is missing and what is at risk. Use before calling a milestone done, or when the user asks how far along the project is.
---

# Review against the brief

An honest check of the work against what the brief says "done" means. This
skill reports; it does not fix anything unless the user asks afterwards.

## Steps

1. Read `docs/BRIEF.md`: the goal, the deliverables, the constraints and the
   "Done when" list.
2. For each "Done when" item, look for evidence in the project: files,
   tests, notes, logs. Run read-only checks when they exist (for example the
   project's test command); never change files to make a check pass.
3. Classify each item:
   - **Met:** with the evidence (file, test, or result).
   - **Partly met:** what exists and what is missing.
   - **Not met:** what would be needed.
   - **Cannot tell:** what information is missing to decide.
4. Check each deliverable exists and each constraint is respected. Note any
   work that is outside the brief's scope.
5. Report as a short table or list, most important gap first, then one
   recommended next step.

## Rules

- Evidence over impression: if you did not see it, say "cannot tell".
- Do not soften findings, and do not invent problems to look thorough.
- Do not edit the brief or any other file during the review. If the brief
  itself looks wrong or outdated, say so and let the user decide.
