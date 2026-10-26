# briefstack — Backlog plan 2

Plan for the second pass over the backlog in [IDEAS.md](IDEAS.md): the
three proposals of backlog 1 (B8, B9, B10) built, and two notes in
IDEAS.md. The scope and the rules come from the user's request of
2026-10-26, given for an unattended run: no questions; where a decision is
needed, the most conservative option is taken and recorded in
[decisions.md](decisions.md) ("Backlog 2").

Starting point: tag `backlog-2-start` on `745efb3`, before any change.
Work happens on `main`. One item per commit, each with its tests; build,
lint and tests green before the commit; push, and CI green on Linux,
Windows and macOS before the next item.

Rules: no real SDK sessions (the real checks are written, not run); no
change to the guard's settings; no tag but `backlog-2-start` and
`backlog-2-done`; files written only with Write and Edit. A step that fails
twice is marked here and the next one starts.

## 0. Status

Updated 2026-10-26. In progress.

| # | Step | State |
|---|---|---|
| — | Plan, tag `backlog-2-start` | done |
| B10 | The chat quotes the creation's step: `stepText` in `list_sessions` and `session_panel`, and the line in the chat's prompt | done: `stepText` in `src/panel/steps.ts`, names in `src/i18n/steps.ts`; real check `check-chat-step.ts` written, not run |
| B8 | Creations do not load the repo's `CLAUDE.md`: `claudeMdExcludes` in the creation's flag settings | done: the docs support it for flag settings and the main session, and for subagents by inference (decisions.md); parent folders' `CLAUDE.md` do load (left as they are, in IDEAS.md); real check `check-claude-md.ts` written, not run |
| B9 | The web app treats the folders of terminal creations in progress as taken; README note | done: `paths check --session` records `folder.json` in the session folder; the server's claims count the folders of sessions in progress it does not run; option (1) stays in IDEAS.md |
| C | IDEAS.md: Codex goal (c); section 2 marked "brief in phase 7" | to do |
| — | Status updated, tag `backlog-2-done` | to do |

## 1. Steps

### B10 — The step as the panel shows it

Option (1) of the proposal in IDEAS.md.

- `stepPosition` moves from `src/ui/panel.tsx` to `src/panel/steps.ts`
  (pure, no imports at run time), unchanged; the UI imports it from there.
- The step labels move from `src/i18n/ui.ts` to `src/i18n/steps.ts`; the
  UI's `stepLabel` reads them, so the panel's text does not change.
- `stepText(input, lang)` in `src/panel/steps.ts`, built from the panel
  state's steps, the open step and what the creation waits for: "Step 3 of
  9: Interview — waiting for the user's answer", in the chat's language.
  Finished and interrupted sessions say so. Its strings are in
  `src/i18n/steps.ts`.
- `list_sessions` gives `stepText` for each active creation (from the
  creation's recorded events, as the panel builds them, plus what the
  manager knows live); `session_panel` gives it for the session.
- The chat's system prompt: to say what a creation is doing or where it
  is, quote `stepText` as the tools give it; never infer the step.
- Tests: `stepText` against `stepPosition` and the panel's labels for an
  open step, between steps, waiting for an answer, finished and
  interrupted, in English and Spanish; both tools carry it; the prompt
  names it.
- A real check, `scripts/real/check-chat-step.ts`, written and not run:
  the real chat (haiku) with a fake creation held mid-flow; it asks what
  the creation is doing and compares the answer with `stepText`.

### B8 — The repo's `CLAUDE.md` out of creations

Option (1) of the proposal in IDEAS.md.

- First, the official docs of Claude Code and the Agent SDK: whether
  `claudeMdExcludes` holds in flag settings, in the main session and in
  subagents, and whether `CLAUDE.md` files above the repo load. Sources in
  decisions.md.
- `buildQueryOptions` adds `claudeMdExcludes` with the repo's `CLAUDE.md`
  (built by code from the repo folder) to the flag settings, next to the
  guard's hooks, which stay exactly as `guardCommandSettings` writes them.
- Tests: the exclusion and the guard's settings unchanged (unit); the
  guard and security tests as they are.
- A real check, `scripts/real/check-claude-md.ts`, written and not run: a
  creation-like session and one subagent are asked whether a marker line
  of the repo's `CLAUDE.md` is in their instructions.

### B9 — Terminal creations' folders, read only

Option (2) of the proposal in IDEAS.md; option (1) stays there.

- `paths check` takes `--session SESSION`; with it, the folder it checked
  is recorded in the session's folder in the briefstack home (never in
  `events.jsonl`, never in the repo). The skill passes it.
- The server treats the recorded folder of every session in progress that
  it does not run (the apply gate's rule) as taken: its own creations are
  refused that folder, or one that overlaps it, and writes into it. The
  terminal flow is refused nothing.
- README: a terminal creation and a web creation must not use the same
  folder.
- Tests: the record (CLI), reading it back (stale, finished, damaged,
  overlap), a web creation refused a terminal session's folder (fake
  runner), and the folder-claims tests as they are.

### C — IDEAS.md

- Section 5 (Codex): the user's goal (c), as given.
- Section 2: marked "brief in phase 7".
