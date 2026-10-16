# briefstack — Phase 3 brief: Live agent panel

> Phase 3 of 5. Phase 2 (local web app) is done and tagged `phase-2-done`.
> This file is the source of truth for phase 3 scope, and for the short polish
> round that comes before it. If something here conflicts with a later
> instruction in chat, follow the most conservative reading and record it in
> `docs/decisions.md`.

## 0. Polish round (before phase 3)

Small fixes to the phase 1 creation flow found during the H10 runs. Each one
is its own commit, with a test where the behaviour can be tested without a
real session.

- **P1. One rule for the target.** Today only the architect has a rule for
  choosing `claude-code` or `claude-app`; the interviewer recommends a target
  with no rule, so the same idea got different recommendations in two runs.
  - Put the rule in one place that both agents read (for example a short file
    in the base library), and make the interviewer and the architect cite it.
  - The rule: `claude-app` when the value is mainly conversation, learning or
    ongoing personal management; `claude-code` when the work is mainly files an
    agent edits and can verify. For mixed ideas (conversation that also needs
    reliable file reading or saved state), the question shows both options with
    the trade-off in one line each, and recommends by the main value.
  - Record who chose the target (`user` or `architect`) in the spec and show it
    in the summary and in the project detail page.
- **P2. No single-option questions.** The interviewer never sends a question
  with fewer than two options; the skill merges or drops such questions before
  calling `AskUserQuestion`.
- **P3. SDK warning.** Filter the known `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`
  warning for exactly the two `briefstack-web` tools, with a comment and a test
  that explain why it is safe (their handlers wait for the browser). Any other
  warning still prints.
- **P4. Repo docs.** `CLAUDE.md` names phase 3 as the current phase and loads
  this brief.

## 1. What phase 3 is

A live panel that shows what the creation flow is doing while it runs: the
main session, each subagent it starts, what each one is doing now, and how the
run went. The same panel shows finished sessions from their recorded events.

It replaces the simple progress list of phase 2 as the main view of a
creation. The progress list stays as a compact summary.

## 2. Constraints

- Everything from phase 2 still holds: local only, `127.0.0.1`, per-launch
  token, no API key, no `bypassPermissions`, reuse the phase 1 and 2 code.
- **The panel only reads.** It never starts, stops, answers or changes
  anything except through the controls phase 2 already has (answer a question,
  approve the spec, permission dialog, cancel).
- **Data source:** the session's `events.jsonl` (hook and runner events) and
  the existing event stream. No transcript content, no model text, no full
  tool inputs or outputs.
- No new heavy dependencies. Draw the graph with plain SVG or HTML; the tree is
  shallow (main session plus subagents, depth 1–2).
- Code and docs in English. UI strings in English and Spanish in `src/i18n/`.

## 3. Features

### 3.1 Live view of a creation

- **Agent tree:** the main session at the top and one node per subagent, in the
  order they started. Each node shows:
  - agent type and, when known, model and effort;
  - status: waiting, running, done, failed, cancelled;
  - start time and duration;
  - the tool it is using now, as the tool name plus a short target (a path
    relative to the project or session folder, or the CLI subcommand),
    redacted and at most 120 characters;
  - counts of tool calls and of guard denials.
- **What needs the user:** a pending question, spec approval or permission
  request is shown on the node that asked, with a link to the control that
  answers it.
- **Timeline:** a horizontal or vertical timeline with one row per agent,
  showing when each one ran. Clicking a row selects that node.
- **Denials:** guard denials appear on the node that caused them, with the
  reason the guard gave.
- **Plan usage:** the percentage of the 5-hour and 7-day windows at the start
  of the creation and now, from the same source `preflight.ts` uses. Never
  token counts or costs.

### 3.2 Finished sessions

- The project detail page and the list of interrupted or cancelled sessions
  link to the panel of that session, rebuilt from its `events.jsonl`.
- Same tree and timeline, final state. No replay scrubber in this phase.
- A session recorded before phase 3 (missing fields) still renders, with what
  it has.

### 3.3 Robustness

- Reopening the tab or reloading rebuilds the panel from the recorded events,
  then continues live without losing or duplicating events (use event ids and
  resume from the last one received).
- A burst of events must not freeze the page.
- An agent whose stop event never arrives is shown as "no end recorded" when
  the session has ended, not as running forever.
- Accessible: the tree and timeline have a text alternative (a list) that a
  screen reader and the keyboard can use.

## 4. Events

- Document the event schema in `docs/events.md`: every type, its fields, and
  which ones are optional. Keep `v: 1` events readable.
- Add only the fields the panel needs, as optional fields. Candidates: model and
  effort per agent (effort from the hook input `effort.level`, as the runner
  already does for the main session), a short redacted target per tool call,
  and the reason of a guard denial.
- Panel state is computed by a **pure function** from the list of events. All
  the logic lives there, so it can be tested without a browser.

## 5. Security

- Targets and reasons shown in the panel go through the same secret redaction
  as the rest of the UI.
- Paths are shown relative to the project or session folder; an absolute path
  outside them is shown as "outside allowed folders" and never in full.
- No new write routes. Any new read route needs the token like the others.

## 6. Verification — definition of done

- Unit tests for the pure panel-state function, including a fixture built from
  a real recorded session (the phase 2 H10 run) with personal paths and ids
  replaced by placeholders. No personal path may enter the repo.
- Unit tests for every new route and event field.
- End-to-end tests over the fake runner: live updates during a creation; a
  pending question shown on the right node; a guard denial shown; reopen the
  tab mid-creation without lost or duplicated events; cancelled and interrupted
  sessions; a session recorded before phase 3; the text alternative.
- Screenshots of the panel taken with Playwright over the fake runner, checked
  for layout at desktop and narrow widths. Store them outside the repo or in a
  git-ignored folder.
- Build, lint and tests pass.
- **Real run:** one creation watched in the panel from the browser, on the
  user's real library, accepted by the user. Phase 3 is not done before that.
- **P1 real check:** a script in `scripts/real/` that runs only the interviewer
  on two fixed ideas (one clearly `claude-code`, one clearly `claude-app`) and
  reports the recommended target and the cited rule. Prepared, not run, until
  the user runs it.

## 7. Prepare for later phases, without building them

- Panel state keyed by session id, so several panels can exist (phase 4).
- The pure panel-state function exported so the global chat (phase 4) can ask
  "what is creation X doing" without the UI.

## 8. Out of scope for phase 3

Global chat. Several creations at the same time. Self-modification. A free-text
reply box (planned for phase 4). Editing agents or settings from the panel.
Replay scrubber. Token or cost figures. Remote access.

## 9. Working rules

- Tag `phase-3-start` before the first phase 3 change.
- Write `docs/PLAN-phase-3.md` with milestones before coding, and keep its
  Status section current after every milestone.
- Small commits, one concern each. Build, lint and all tests green before each
  commit.
- Run tests before saying something works.
