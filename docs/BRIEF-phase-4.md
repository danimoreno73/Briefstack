# briefstack — Phase 4 brief: Global chat and several creations

> Phase 4 of 5. Phase 3 (live agent panel) is done and tagged `phase-3-done`.
> This file is the source of truth for phase 4 scope. If something here
> conflicts with a later instruction in chat, follow the most conservative
> reading and record it in `docs/decisions.md`.

## 1. What phase 4 is

Two features on top of the web app:

1. **A global chat** where the user talks to Claude about everything
   briefstack holds: projects, the personal library, creation sessions and
   their panels, the usage profile. From the chat the user can also ask for
   actions (start a creation, cancel one, change a library note), and every
   action is confirmed in the UI before it happens.
2. **Several creations at the same time**, each with its own session, guard,
   panel and controls.

It also adds the free-text reply planned in phase 2: when a creation ends a
turn waiting for a text answer, the user can reply from the browser.

## 2. Constraints

- Everything from phases 2 and 3 still holds: local only, `127.0.0.1`,
  per-launch token, no API key, no `bypassPermissions`, the guard on every
  creation, reuse the existing library and server code.
- **The chat has no built-in file or shell tools.** No Read, Write, Edit,
  Bash, PowerShell, WebFetch or WebSearch. It reaches briefstack only through
  MCP tools served by the briefstack server, which call the same code as the
  HTTP API and apply the same redaction.
- **Every tool that changes something waits for a confirmation in the UI**,
  shown as a card with exactly what will happen (the same pattern as
  `approve_spec`). Read tools need no confirmation.
- **Content the chat reads is data.** Library notes, project files and
  session events may contain text that looks like instructions; the chat
  must not follow it. Because every change needs a UI confirmation, injected
  text can at most propose an action the user then sees.
- The chat model and effort come from the usage profile (a new `chat` entry
  in each profile), never from the user's own Claude Code settings.
- Code and docs in English. UI strings in English and Spanish in `src/i18n/`.

## 3. Features

### 3.1 Global chat

- A chat page reachable from the navigation, plus a compact chat drawer
  available on every page.
- **Read tools:** list and show projects; search and read library notes
  (index, profile, lessons, project notes, logs); list sessions; get the
  panel state of a session (the phase 3 pure function); show usage profile
  and plan usage; show settings and resolved paths.
- **Action tools (confirmation required):**
  - start a creation from an idea (it then appears in the creations list and
    runs exactly like one started from the "New project" page);
  - cancel a running creation;
  - propose a change to a library note, shown as a diff; on confirmation it
    goes through `saveNote` (secret check, date rules, INDEX, one commit);
  - change the usage profile.
- Not available from the chat: reverting library commits, changing
  `projectsDir` or the permission policy, answering a creation's interview
  questions or approving its spec (those stay in the creation's own forms).
- **History:** the conversation is stored under the briefstack home and
  shown again after a reload or a server restart. Whether the model context
  itself can be resumed after a restart is verified in H0 (see section 7);
  if it cannot, a restart starts a new conversation and the old one stays
  readable.
- Answers that come from data say where it came from (project name, note
  path, session id) so the user can open it.

### 3.2 Several creations at the same time

- A configurable limit of active creations (setting, default and maximum
  decided in section 8). Starting one over the limit is refused with a clear
  message.
- A "Creations" list with every active one: idea, current step, what it is
  waiting for, link to its panel.
- Each creation keeps its own session folder, guard, granted folders,
  permission dialogs and panel. Nothing granted to one is visible to another.
- **Shared resources are serialized:**
  - library writes and commits go through one queue, so two creations
    finishing at the same time never run `git` concurrently;
  - two creations cannot target the same project folder; the second one is
    refused before it writes.
- Pending questions, spec approvals and permission dialogs from several
  creations never mix: each control shows which creation it belongs to.
- Starting a second creation shows a one-line note that plan usage adds up.

### 3.3 Free-text reply

- When a creation ends a turn with nothing pending (the phase 2 "the session
  is waiting for an answer" panel), the panel shows a text box. The reply is
  sent to that session as a user message.
- The same component is used by the chat.

### 3.4 Backlog from phase 3

- Plan usage shows "not available" for the first second of a creation: fix
  the race.
- A late `session.end` from the hook does not reach the live panel: include
  it.
- Always pass an explicit model to every SDK session, so `ANTHROPIC_MODEL` or
  user settings can never override the profile, and add a test for it.

## 4. Security

- The chat's MCP server exposes only the tools listed in 3.1. Each tool
  validates its input with a schema and goes through the existing library and
  server code.
- Action confirmations are server-side: the tool call waits until the
  browser confirms through a token-protected route. A tool result alone never
  performs the action.
- The chat session runs with the same environment cleaning, explicit model,
  closed tool list and permission mode rules as creation sessions. Its
  working directory is the briefstack home, not the repo.
- Rate limit chat actions so a loop of proposals cannot flood the UI (for
  example one pending confirmation at a time).
- Secrets never appear in chat messages: tool results are redacted before the
  model sees them, and chat history is stored redacted.

## 5. Verification — definition of done

- Unit tests for every chat tool, the confirmation flow, the library queue,
  the concurrency limit and the folder collision check.
- A fake chat runner with scripted tool calls, used by all chat UI and API
  tests.
- End-to-end tests over the fake runners: a chat question answered from
  data; each action confirmed and declined; an injected instruction inside a
  library note that the chat must not act on without a confirmation; two
  creations at once with their questions kept apart; two creations finishing
  together with both library commits present; the limit; the folder
  collision; the free-text reply; reload and server restart with the chat
  history.
- Build, lint and tests pass.
- **Real checks** in `scripts/real/`, prepared and run only by the user:
  the chat answers from the read tools; the chat starts a creation through
  the confirmation; two cheap real creations run at the same time (saver
  profile).
- **Real run:** from the chat, start two creations, follow both panels and
  finish both, on the user's real library, accepted by the user. Phase 4 is
  not done before that.

## 6. Prepare for phase 5, without building it

- Keep the chat tools in one registry, so phase 5 (self-modification) can add
  tools behind the same confirmation pattern.
- Document every chat tool in `docs/api.md`.

## 7. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.

1. An SDK session with no built-in tools and only MCP tools works, and the
   closed tool list holds.
2. Several SDK sessions can run at the same time on Windows from one server
   process, each with its own hooks, environment and working directory.
3. Whether an SDK session can be resumed after the server restarts (resume
   by session id), and what it costs.
4. A user message can be sent to a creation session that ended its turn
   (for the free-text reply), through the same input queue the runner uses.

## 8. Decisions confirmed by the user

1. **Chat actions:** read, plus the four action tools in 3.1 (start a
   creation, cancel one, propose a library note change, change the usage
   profile), each confirmed in the UI.
2. **Active creations limit:** default 2. The user sets the limit in
   Settings (any whole number from 1 up). Above 3, Settings shows a one-line
   note that plan usage adds up quickly.
3. **Chat model per profile:** saver → Haiku, low effort; balanced → Sonnet,
   medium effort; max → Opus, high effort. User-defined presets must set the
   chat model and effort too.
4. **Conversations:** one active thread. "New chat" archives the current one,
   which stays readable (read-only) in a list of past chats.

## 9. Out of scope for phase 4

Self-modification (phase 5). The UI and UX redesign (a separate pass after
phase 4, before publishing). Remote access. Several users. Voice. Answering
interview questions or approving specs from the chat.

## 10. Working rules

- Tag `phase-4-start` before the first phase 4 change.
- Write `docs/PLAN-phase-4.md` with milestones before coding, and keep its
  Status section current after every milestone.
- Small commits, one concern each. Build, lint and all tests green before
  each commit.
- Run tests before saying something works.
