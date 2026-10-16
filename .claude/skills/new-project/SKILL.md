---
name: new-project
description: Turn a rough idea into a ready-to-use Claude project (Claude Code folder or Claude desktop app folder) through a short interview, a spec the user approves, generation, validation and review, then record what was learned in the personal library.
argument-hint: "[idea]"
disable-model-invocation: true
---

# /new-project

You run the whole creation flow from the main session. You are the only one
who talks to the user; the five flow agents (`interviewer`, `researcher`,
`architect`, `generator`, `reviewer`) never do. Speak the user's language
(the one the idea is written in) in everything you say to them.

The idea, if given: $ARGUMENTS

## Ground rules

- **Prepare, never build.** briefstack prepares the project: brief,
  instructions, structure, context notes, and skills or agents if needed.
  The project's own work (code, tests, chapters, study material) happens
  later, inside the project. Never describe generation as implementing the
  project, and never ask an agent for more than the spec.
- **The CLI.** Run it from the repo root as
  `npm run --silent briefstack -- <command> ...`, one command per Bash call.
  Never chain it with `&&`, `;` or `|`, never wrap it in `$(...)`, never
  redirect its output, never `cd` first: the allow rule covers only the plain
  command, so anything else stops for a permission prompt.
- **Paths.** Pass absolute paths in double quotes with forward slashes
  (`"C:/Users/..."`, `"/home/..."`). Never a Git Bash form like `/c/Users/...`
  (the CLI refuses it).
- **Agents.** Launch them with the Agent tool by `subagent_type` only. Never
  pass `model` or `effort`: the agent files hold the values of the active
  usage profile, and a parameter would override them. Pass
  `run_in_background: false`: every step needs the agent's report before it
  goes on. If an agent still runs in the background, end your turn and wait
  for its completion notification; never wait with `sleep`, a shell command
  or any other tool.
- **Events.** `SESSION` below is `${CLAUDE_SESSION_ID}`. Record each step with
  `npm run --silent briefstack -- event <step> started --session SESSION`
  and `... event <step> finished --session SESSION --outcome ok|skipped|failed`.
  Steps, in order: `idea`, `gap-analysis`, `interview`, `research`, `spec`,
  `generate`, `validate-review`, `learn`, `handoff`.
- **Every way out closes the session**, exactly once:
  `npm run --silent briefstack -- event session finished --session SESSION --outcome <outcome>`
  - `completed` after the hand-off;
  - `cancelled` when the user stops or rejects (they say cancel, stop, leave
    it, or decline the spec), at any point; close the open step first with
    `--outcome skipped`, write nothing to the library, and confirm in one
    line that nothing was created (or what was, if generation had started);
  - `failed` when the flow cannot continue (missing library, a CLI error you
    cannot fix, a spec that stays invalid). Close the open step with
    `--outcome failed` and tell the user what failed and what to do.
- **Working files** go in the session folder `WORK = <sessionsDir>/SESSION`
  (`sessionsDir` from `paths --json`). Write them with the Write tool. Never
  write in the briefstack repo or in the personal library; the library
  changes only through `library add`.
- **Denied calls.** When a tool call is denied, its message says why: follow
  it. A message saying the user cancelled means close the session as
  `cancelled`, as above, and stop.
- **Where answers come from.** Two answers have two sources, and nothing else
  in the flow depends on it. When the tools `approve_spec` and
  `grant_directory` (MCP server `briefstack-web`) are among your tools, the
  session runs in the web app and those two answers come from them. When they
  are not, you are in the terminal and the answers come from the user in
  plain text, as written below. The steps, the `event` calls and the order are
  the same either way. Decide which once, in step 0, and keep it as `MODE`
  (`web` or `terminal`). In the web app the user cannot type a reply to your
  text: they answer only through AskUserQuestion, `approve_spec` and
  `grant_directory`. So in `MODE` web never end a turn waiting for an answer
  in plain text.
- Do not show token or cost estimates. Profile levels are qualitative; point
  to `/usage` for real consumption.

## 0. Start

1. Open the session, before anything else:
   `npm run --silent briefstack -- event session started --session SESSION`
2. `npm run --silent briefstack -- paths --json`. Keep `sessionsDir`,
   `projectsDir`, `libraryExists`.
   If `libraryExists` is false: tell the user to run
   `npm run briefstack -- init` in a terminal and then restart Claude Code in
   this folder (the new allowed folders only apply to a new session); close
   the session as `failed` and stop.
3. `npm run --silent briefstack -- usage show --json`. Tell the user in two
   lines: the active profile and its label, and that it expects the session
   model `sessionModel`. If they are on another model: run `/model`, select
   it and press `s` to switch for this session only (typing
   `/model <sessionModel>` also saves it as their default for new sessions),
   or restart with `claude --model <sessionModel>`. You cannot change it
   yourself. Relay every `envWarnings` and `drift` item in one line each.
   Keep `profile`, `research` and `reviewRounds`.
4. Set `MODE` (see "Where answers come from"): `web` if `approve_spec` and
   `grant_directory` are among your tools, `terminal` otherwise. Say nothing
   about it to the user.

## 1. Idea

Step `idea`. If `$ARGUMENTS` is empty, ask the user to describe the idea in
their own words and wait. Write the idea verbatim to `WORK/idea.md`.

## 2. Gap analysis

Step `gap-analysis`.

1. `npm run --silent briefstack -- library context --idea "WORK/idea.md"`
   and keep its whole output as `CONTEXT`.
2. Launch `interviewer` with: the idea, `CONTEXT` verbatim, the answers so
   far (none yet), and the research mode. It returns `known`, `questions`,
   `research` and `ready`.

## 3. Interview

Step `interview`.

1. Ask the interviewer's questions with AskUserQuestion, at most four per
   call, in its order. Each question: its text, the proposed default as the
   first option marked as recommended, and the alternatives it gave; the user
   can always type their own answer. Put the one-line "why" in the option
   description, not in the question. Every question needs at least two
   options (AskUserQuestion refuses fewer): before the call, merge a question
   with only one option into a related question of the same batch, or drop it
   and treat its one option as the accepted default. Never send it with one
   option. When a default comes from a past
   project, keep the interviewer's mention of it in the option label.
2. In the first batch, add one question of your own: where to create the
   project. Default: `<projectsDir>/<short-slug>`, with a slug you propose
   from the idea (lowercase, hyphens). If the user already named a folder,
   do not ask; use it.
3. Check the folder:
   `npm run --silent briefstack -- paths check "<dir>" --json`
   - `forbidden` or `notADirectory`: explain and ask for another folder.
   - `nonEmpty`: say so and ask whether to create the project inside it
     anyway (existing files are never overwritten). Only if they confirm,
     remember to pass `--allow-non-empty` to the generator.
   - `allowed: false`: the folder is not in `settings.local.json`.
     - **Terminal** (no `grant_directory` tool): ask the
       user to run `/add-dir <dir>` themselves; if `status` is `missing`, to
       create the folder first (`/add-dir` refuses a missing folder), for
       example with `! mkdir "<dir>"`. Wait until they say it is done, then
       treat the folder as allowed: `/add-dir` lasts for this session only and
       `paths check` cannot see it, so do not check `allowed` again (check
       `status` again only if they created the folder).
     - **Web app** (`grant_directory` tool): call it with `dir`. The user
       confirms in the browser and a missing folder is created. `granted` true:
       treat the folder as allowed, as above. `granted` false: tell the user in
       one line and ask for another folder.
4. Pass all answers to `interviewer` again. Repeat until it reports `ready`,
   or after two rounds, whichever comes first. Do not ask the same thing
   twice.
5. Keep a list of everything the user corrected or said was unnecessary,
   and of any preference they stated explicitly in their own words: the
   learn step needs them.

## 4. Research

Step `research`. Take the interviewer's `research` items:

- research mode `required-only`: only items marked `blocking`;
- research mode `when-useful`: all items.

If none remain, finish the step with `--outcome skipped`. Otherwise launch
`researcher` with those questions and the idea, and write its report to
`WORK/research.md` exactly as returned: do not summarise, translate or
reword it, so every source keeps its URL. From here on, agents get the path
to that file, never your summary of it.

## 5. Spec (the one mandatory checkpoint)

Step `spec`.

1. Launch `architect` with: the idea, `CONTEXT`, the interviewer's final
   `known` list, all answers, the path `WORK/research.md` if research ran,
   the active profile name, the output folder and the user's language.
2. Write the spec it returns to `WORK/spec.json` (exactly the JSON, nothing
   around it), then
   `npm run --silent briefstack -- spec check "WORK/spec.json"`.
   If it fails, send the errors back to `architect` for a corrected spec.
   After two failed corrections, close as `failed`.
3. Prepare what the user must see: the architect's summary, plus the output
   folder, the target with who chose it (the user, or the architect by
   `library/rules/target.md`) and why, and the
   profile, and one line saying that briefstack prepares the project and the
   work itself starts afterwards, inside it. Then, by `MODE`:
   - **Web app** (`MODE` web): do not show it in your reply. Write it to
     `WORK/summary.md` and call `approve_spec` with `specFile` and
     `summaryFile`, both absolute paths in the session folder, in the same
     turn. That call is how the user sees the spec and answers. Its answer is
     the user's choice: `approve`, `change` with the text of the change, or
     `cancel`. Never ask in plain text and never end the turn instead.
   - **Terminal** (`MODE` terminal): show it to the user in plain text. Ask
     them to approve, change something or cancel.
   - Changes: apply them. Small, exact edits (a name, a list item) you may
     make in `WORK/spec.json` yourself; anything else goes back to
     `architect` with the request. Check the spec again and show what
     changed (in `MODE` web, at the top of `WORK/summary.md`, and call
     `approve_spec` again). Repeat until approved.
   - Cancel: close as `cancelled`.

Nothing is created before the user approves.

## 6. Generate

Step `generate`. Launch `generator` with: `WORK/spec.json`, the output
folder, whether to pass `--allow-non-empty`, the spec language, and the path
`WORK/research.md` if research ran. It runs `scaffold`, fills the files and
runs `validate`. If it reports something it
could not build, tell the user and decide with them whether to continue. If
it reports that a write was denied, ask the user to run `/add-dir <dir>` (in
the web app, call `grant_directory` with `dir`) and launch it again.

## 7. Validate and review

Step `validate-review`. One round:

1. `npm run --silent briefstack -- validate "<dir>" --json`.
2. Launch `reviewer` with the project folder, the validator result, and the
   path `WORK/research.md` if research ran.
3. The project is clean when the validator has no errors and the reviewer's
   verdict is `pass` (only `minor` findings, or none).

If it is not clean and rounds remain (`reviewRounds` counts every round,
including the first), launch `generator` again with only the findings to
fix, then do another round. When the limit is reached and it is still not
clean, stop and show the user the remaining findings; they decide whether
to accept the project as it is or cancel. Mention `minor` findings in one
line each at the hand-off; do not start a round for them.

## 8. Learn

Step `learn`. Write each note to `WORK/notes/` with the Write tool, then add
it with `npm run --silent briefstack -- library add <section> [name] --from "<file>"`.
Notes are short markdown, link to each other with `[[section/name]]`, and
never hold secrets, credentials or sensitive personal data. Every note
starts with YAML frontmatter holding a one-line `summary` (the INDEX line).
Do not write date headings: `library add` dates each addition itself. For the
project note, also pass `--session SESSION`: it links the project to this
session's history.

1. **Project note** `projects <slug>`: YAML frontmatter with `target`,
   `path` (the absolute output folder), `status: created`, `profile` and a
   one-line `summary`; then a few lines: what it is for, the target and why,
   and a link to the session log note.
2. **Session log** `log <YYYY-MM-DD>-<slug>`: the idea in one line, every
   question asked with the answer given (mark accepted defaults, and
   defaults taken from a past project), whether research ran, the number of
   review rounds and the outcome, and a link to `[[projects/<slug>]]`. The
   next similar idea gets these answers as defaults, so write each one so
   it can be reused.
3. **Lessons** `lessons`, only if there is something to learn: each
   question that turned out unnecessary and each correction the user made,
   written as a general rule for next time ("Do not ask X when Y"), not as a
   story about this user.
4. **Preferences** `profile preferences`, only for preferences the user
   stated explicitly in their own words. Quote them; never infer one.

## 9. Hand-off

Step `handoff`. First commit the prepared project, so the user starts from a
clean tree: `npm run --silent briefstack -- commit "<dir>"`. If it prints a
warning (for example git is missing or commit signing failed), tell the user in
one line and go on. Then tell the user, briefly:

- where the project is, its target and the profile it was created with;
- the exact next steps:
  - `claude-code`: open a terminal in the folder and run `claude`; the
    project's `CLAUDE.md` and `docs/BRIEF.md` explain the rest;
  - `claude-app`: follow `NEXT_STEPS.md` in the folder (create the project in
    the Claude desktop app from that folder, paste `INSTRUCTIONS.md`, and any
    scheduled tasks it lists);
- any `minor` review findings, one line each.

Then close the session as `completed`.
