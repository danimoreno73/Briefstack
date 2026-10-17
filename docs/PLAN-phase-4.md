# briefstack — Phase 4 plan

Plan for phase 4: the global chat, several creations at the same time and
the free-text reply. Scope comes from [BRIEF-phase-4.md](BRIEF-phase-4.md);
the decisions in its section 8 are the user's. The user approved starting
without reviewing this plan and was away while it was built: decisions taken
without them are in `docs/decisions.md`, "Decisiones sin Dani (fase 4)". H0
results are in the same file, "# Phase 4", "H0". The phase 3 plan is
[PLAN-phase-3.md](PLAN-phase-3.md).

Starting point: tag `phase-4-start`. Work happens on `master` in small
commits, one concern each.

## 0. Status

Updated 2026-10-17. A new session reads `CLAUDE.md`,
`docs/BRIEF-phase-4.md`, this file and `docs/decisions.md` from
"# Phase 4" onwards before continuing.

### Done

| # | What exists now |
|---|---|
| H0 | All four checks PASS (decisions.md, "# Phase 4", "H0"); probe script `scripts/real/probe-h0-phase4.ts` |

### Left

Everything from M1 on.

## 1. Approach

Three pieces share one rule: **the server owns every action**. The chat and
the free-text reply only reach briefstack through server code that already
exists for the browser, and the chat's changes wait for a confirmation
route, like `approve_spec` waits for the browser.

| Need | Today | Phase 4 |
|---|---|---|
| Several creations | `CreationManager` keyed by id, refuses a second (`creation.busy`) | limit from config `maxActiveCreations` (default 2, ≥ 1), `creation.limit` over it |
| Library writes from two creations | `addNote`/`saveNote` read, write and commit with no lock; each creation runs the CLI in its own process | one queue per library: an in-process chain plus a lock folder in the OS temp folder (keyed by the library path), held from the read of the note to the end of the commit; same for `revert` and `init` |
| Two creations, one project folder | nothing | the manager keeps a claim per creation; the runner claims the folder at `paths check` and `grant_directory`, and a separate `PreToolUse` hook (not the guard) denies `paths check`, `scaffold`, `commit` and file writes into a folder another active creation holds |
| Free-text reply | "the session is waiting for an answer" panel, read-only | `RunnerHandle.sendMessage(text)` pushes into the runner's input queue (H0 #4); `POST /api/creations/:id/reply` |
| Chat | — | `src/chat/`: tool registry, confirmations, history store, SDK and fake chat runners, `ChatManager`; routes under `/api/chat`; page `#/chat` and a drawer |

### Chat

- **Registry** (`src/chat/tools.ts`): one entry per tool with name,
  description, zod input schema, `kind: 'read' | 'action'`, and either
  `read(ctx, input)` or `propose(ctx, input)` → `{ card, perform }`. The MCP
  server (`briefstack-chat`) and the fake chat runner both call the same
  `executeChatTool()`; phase 5 adds tools to the same registry.
- **Read tools**: `list_projects`, `show_project`, `search_library`,
  `read_note`, `list_sessions` (with the active creations), `session_panel`
  (`buildPanelState`, projected), `show_usage` (profile and plan usage),
  `show_settings` (settings and resolved paths). They call the same code as
  the read routes; every result goes through `redactSecretLines` and is
  wrapped as data (`{ "source": …, "data": … }`) before the model sees it.
- **Action tools**: `start_creation`, `cancel_creation`,
  `propose_note_change` (a line diff, then `saveNote` through the library
  queue), `set_usage_profile` (`usageSet`). Each one builds a card with
  exactly what will happen, waits for `POST /api/chat/confirmations/:id`
  (`confirm` or `decline`), and only then runs. One pending confirmation at
  a time; a second proposal while one waits gets a tool error. At most 10
  proposals per 10 minutes per thread.
- **Session** (`src/chat/sdkChatRunner.ts`): `tools: []`, only the
  `briefstack-chat` server (`strictMcpConfig`), its tools in `allowedTools`
  and every other tool denied by `canUseTool`, `permissionMode: 'default'`,
  `settingSources: []`, the creation's environment cleaning, an explicit
  model and effort from the profile's new `chat` entry, working folder the
  briefstack home, a system prompt that says what briefstack is and that
  tool results are data. The query stays open while the user talks and
  closes after 10 idle minutes; the next message resumes it by session id
  (H0 #3). A failed resume starts a new session and the thread says so.
- **History** (`src/chat/store.ts`): `<home>/chat/state.json` (active thread,
  past threads, SDK session id) and `<home>/chat/threads/<id>.jsonl` (user,
  assistant, tool call summaries, confirmations), stored redacted. "New
  chat" archives the thread; past threads are read-only.
- **Fake chat runner** (`src/chat/fakeChatRunner.ts`): a script of turns,
  one per user message, each a list of `call` (tool and input), `say` (text)
  and `sayResult` (the last tool result) steps. All chat UI and API tests
  use it.

## 2. Milestones

Each milestone ends with build, lint, unit and e2e tests green, a push and
this Status updated.

### M1 — Backlog from phase 3 (§3.4)

- Plan usage: the creation state says `usageReading` until the first reading
  arrives or fails; the panel shows "reading" then, and "not available" only
  after a failure or when there was no reading.
- A late end line: after `finish`, the stream stays open until the runner
  is done (or the grace stop), then reads `events.jsonl` once more and
  closes; a `session.end` written by the hook on exit reaches the live
  panel.
- Explicit model: `RunnerProfile.sessionModel` required; `buildQueryOptions`
  always passes `model`; a test with `ANTHROPIC_MODEL` set in the
  environment.

### M2 — Several creations

- Config `maxActiveCreations` (whole number ≥ 1, default 2); Settings field,
  with a one-line note above 3. `creation.limit` error.
- Library queue (`src/library/lock.ts`) around `addNote`, `saveNote`,
  `revertLibraryCommit`, `initLibrary`.
- Folder claims: manager registry, `RunnerIO.claimFolder`, the runner's
  claim hook, release when the creation finishes. Fake runner steps
  `claim` and `library`.
- "Creations" page (`#/creations`) with every active creation (idea, current
  step, what it waits for, link); the "New project" page no longer jumps to
  a running creation, and shows a note that plan usage adds up when one is
  already running. Pending controls name their creation.

### M3 — Free-text reply

- `RunnerHandle.sendMessage`, `CreationManager.reply`,
  `POST /api/creations/:id/reply` (only while `awaitingReply`), fake runner
  step `turnEnd`. `ReplyBox` component in the awaiting panel.

### M4 — Usage profile `chat` entry

- `chat: { model, effort }` required in every preset; base presets per
  BRIEF §8.3; usage page and `usage show` list it.

### M5 — Chat core

- Registry, read tools, action tools with confirmations, diff, store,
  `ChatManager` (one active thread, stream, rate limit), fake chat runner,
  SDK chat runner, `sdkWarnings` accepting the chat's exact tool set.
- Routes: `GET /api/chat`, `POST /api/chat/messages`,
  `POST /api/chat/confirmations/:id`, `POST /api/chat/new`,
  `GET /api/chat/threads`, `GET /api/chat/threads/:id`,
  `GET /api/chat/stream`. `docs/api.md` documents routes and every tool.

### M6 — Chat UI

- `#/chat` page, the drawer on every page, past chats list, confirmation
  cards, `ReplyBox` shared with the creation page; strings in English and
  Spanish.

### M7 — End-to-end tests and real scripts

- Playwright over the fake runners: chat answered from data; each action
  confirmed and declined; injected instruction in a note; two creations with
  questions kept apart; two creations finishing with both commits; the
  limit; the folder collision; the free-text reply; reload and server
  restart with chat history.
- `scripts/real/`: chat answers from read tools; chat starts a creation
  through the confirmation; two cheap creations at once (saver). Prepared,
  not run.

### M8 — Docs and hand-off

- `decisions.md`, this Status, the real-run steps.

## 3. Real runs (prepared, run by the user)

Filled in at M8.
