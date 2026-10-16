# Choosing the target

The one rule for `claude-code` or `claude-app`. The interviewer reads it to
recommend a target and the architect reads it to choose one. Both cite it as
`library/rules/target.md`.

## The rule

- **`claude-app`** when the value is mainly conversation, learning or ongoing
  personal management: practising, studying, planning, reflecting, tracking
  habits or tasks by talking about them.
- **`claude-code`** when the work is mainly files an agent edits and can
  verify: code with tests, structured documents with a build or a check.
- **Mixed ideas**: conversation that also needs reliable file reading or saved
  state (for example a study trainer that reads PDFs and keeps progress per
  topic). Do not decide silently. Ask, show both options with the trade-off in
  one line each, and recommend the one that serves the **main value** of the
  idea:
  - `claude-app`: best for conversation and learning; reading files and keeping
    state depend on the files added to the project and on what each chat sees.
  - `claude-code`: reads and writes files in the folder reliably and can check
    them; the conversation happens in a terminal or an IDE.

## Who chose

- `user`: the user named a target in the idea or answered the target question,
  including by accepting the recommended option.
- `architect`: nobody asked the user, and the architect applied this rule.

The spec records it in `targetChosenBy`. `targetReason` says why in one or two
lines: the user's own reason when they chose (or "chosen by the user" when they
gave none), the rule's reason when the architect chose.
