---
name: session-handoff
description: Ends a work session by updating the project brief with what was done, what is next and what is still open, so the next session can start without re-explaining. Use when the user says they are stopping, wrapping up or handing off.
---

# Session hand-off

Leave the project so that a fresh session, with no memory of this one, can
pick it up from the files alone.

## Steps

1. Find the brief: `docs/BRIEF.md`. If the project keeps a progress log
   (for example `docs/PROGRESS.md`), use it as well.
2. List what changed in this session: files created or edited, decisions
   taken, questions answered. Use the conversation and, if the project is a
   git repository, `git status` and `git diff --stat`.
3. Rewrite the "Current status" section of the brief (create it at the end
   if it does not exist). Keep it to a few lines:
   - **Done:** what was finished this session.
   - **Next:** the single most useful next step, concrete enough to start
     without asking.
   - **Open:** questions or blockers that need the user.
4. If there is a progress log, add a dated entry at the top with the same
   points; leave older entries untouched.
5. If a decision was taken that is hard to reverse and the project keeps a
   decision log, add it there with the reason.
6. Show the user the new status and ask them to correct anything wrong.
   Do not commit unless the user asks.

## Rules

- Replace the status; do not let it grow into a history. History belongs in
  the progress log or in git.
- Write only facts from this session. Mark guesses as guesses.
- Never write secrets, credentials or personal data into these files.
- Keep the brief's other sections unchanged unless the user agreed to change
  the scope.
