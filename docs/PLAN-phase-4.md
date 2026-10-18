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

Updated 2026-10-18. A new session reads `CLAUDE.md`,
`docs/BRIEF-phase-4.md`, this file and `docs/decisions.md` from
"# Phase 4" onwards before continuing.

### Done

| # | What exists now |
|---|---|
| H0 | All four checks PASS (decisions.md, "# Phase 4", "H0"); probe script `scripts/real/probe-h0-phase4.ts` |
| M1 | Backlog: explicit `model` on every SDK session and `ANTHROPIC_MODEL` removed from its environment (test; the repo settings name no model); `usageReading` in the creation state and "Reading the plan usage…" in the panel; a finished creation's stream closes only after the runner is done and two more reads of `events.jsonl` (`tailMs`), so a late `session.end` reaches the live panel |

| M2 | Config `maxActiveCreations` (default 2, whole number ≥ 1; Settings field with a note above 3; `creation.limit`, 409); library queue `src/library/lock.ts` around `addNote`, `saveNote`, `revertLibraryCommit` and the `init` commit (`library.busy` after 60 s); folder claims `src/creation/folderClaims.ts` (manager registry, `RunnerIO.claimFolder`/`folderHeldByOther`, a `PreToolUse` hook of its own, `grant_directory` refuses a held folder); fake runner steps `claim` and `library`; `#/creations` page (idea, step, what it waits for, link), a count in the menu, the "plan usage adds up" note on the form, "For the creation: …" on every pending control; e2e `tests/e2e/several.spec.ts` (questions kept apart, two finishing with both commits, the folder collision) and the limit in `creation.spec.ts` |

| M3 | `RunnerHandle.sendMessage` (SDK runner: same input queue; fake runner: step `turnEnd`, option `received`), `CreationManager.reply`, `POST /api/creations/:id/reply` (`creation.noReply`, 409), `ReplyBox` (`src/ui/reply.tsx`, Ctrl+Enter sends) in the "waiting for a reply" panel; unit tests and an e2e |

| M4 | `chat: { model, effort }` required in every preset (`ChatSettingSchema`); base presets saver → haiku/low, balanced → sonnet/medium, max → opus/high; shown by `usage show`, `GET /api/usage` and the Usage page |

| M5 | `src/chat/`: `toolNames.ts`, `tools.ts` (registry of 8 read and 4 action tools, `resultText` wraps and redacts), `diff.ts`, `store.ts` (`<home>/chat/state.json`, `threads/<id>.jsonl`), `manager.ts` (`ChatManager`: one active thread, confirmations one at a time, 10 per 10 minutes, idle close and resume, `resumeFailed` fallback, "New chat"), `fakeChatRunner.ts` (scripts of `say`/`call`/`sayResult`/`echo`/`fail`), `sdkChatRunner.ts`, `wiring.ts`; routes `src/server/chat.ts`; `briefstack web` starts the chat; the SDK warning filter knows the chat's exact set; `docs/api.md` documents routes and every tool |

| M6 | `src/ui/chat.tsx` (`#/chat` page with the model in use, messages, tool lines with links to their sources, confirmation cards with Confirm/Decline and the note diff, notices, `ReplyBox`, "New chat", past chats read-only at `#/chat/<id>`; `ChatDrawer` on every other page, closed with its own button or Escape), `src/ui/chatData.ts` (pure: source links, stream events applied once each); strings in English and Spanish; e2e `tests/e2e/chat.spec.ts` (answer from data with a source link; start, profile and note change each declined then confirmed; cancel declined then confirmed; an injected instruction in a note; reload and server restart with resume; "New chat" and past chats; the drawer; 390 px). The project tables now scroll inside their box at 390 px |

| M7 | `scripts/real/check-chat-read.ts`, `check-chat-start-creation.ts`, `check-two-creations.ts` (and `sandboxLibrary` in `common.ts`); static checks in `tests/unit/real-scripts.test.ts`. First run of `check-two-creations` failed (2026-10-18, decisions.md "`check-two-creations` saw the user's real folders"); fixed: creation sessions load only project settings, no auto memory, `paths` reports the runner's folders, the sandbox stays out of protected folders, the answerer never picks a folder outside it, `shutdown()` is bounded. To run again |
| M8 | Decisions 1–13 in `decisions.md` ("Decisiones sin Dani (fase 4)"), `docs/api.md` and `docs/events.md` updated, this Status, the real-run steps below |

### Left

The real checks and the real run (section 3), run by the user. Phase 4 is
not done before the real run is accepted.

Before the real run: if `<home>/usage-profiles.json` has user presets, each
needs a `chat` entry (decisions.md, phase 4, item 7).

### Backlog (not phase 4, not started)

- Folder claims live in the server's memory: a creation started from the
  terminal (`/new-project` in Claude Code) is not seen by them.
- The chat's MCP tool waits for a confirmation without a timeout of its own,
  as `approve_spec` does; a card left open for hours keeps the chat's turn
  open until it is answered or "New chat" is pressed.
- The UI and UX pass over the whole app (after phase 4, before publishing). Before the real run the user checks that any preset
in `<home>/usage-profiles.json` has a `chat` entry (decisions.md, phase 4,
item 7).

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

None was run while building phase 4 (only the H0 probes). In order:

1. **Preflight** (reads only): `npx tsx scripts/real/preflight.ts`.
2. **Chat answers from its read tools** (a few short haiku turns, temp home):
   `npx tsx scripts/real/check-chat-read.ts --yes`. Expected: five PASS
   lines; the answer names "Seed tracker".
3. **Chat starts a creation through the confirmation** (haiku; the creation
   behind it is fake): `npx tsx scripts/real/check-chat-start-creation.ts --yes`.
   Expected: a card declined (no creation), a card confirmed (one creation
   with the idea), no error notice.
4. **Two real creations at once** (saver, temp home, up to 40 minutes):
   1. `npm run briefstack -- usage set saver` (the script never rewrites the
      agent files; it stops if they do not hold saver);
   2. `npx tsx scripts/real/check-two-creations.ts --yes`. Expected: both
      `completed`, two project folders, a clean temp library, overlapping
      times;
   3. `npm run briefstack -- usage set <your profile>` to go back.
5. **P1 check from phase 3**, still pending:
   `npx tsx scripts/real/check-interviewer-target.ts --yes`.
6. **Phase 4 real run**, on the real library:
   1. Check `<home>/usage-profiles.json` (user presets need `chat`).
   2. `npm run build`, then `npm run briefstack -- web`, and open the
      address it prints.
   3. Settings: the limit of creations at once (2 by default).
   4. Chat: ask which projects you have and where a note says something;
      the answer names its source, and the link opens it.
   5. From the chat, start two creations (two cards, each confirmed). The
      Creations page lists both; each panel shows its own agents; each
      question and the spec say which creation they belong to.
   6. Finish both. The library has both project notes and its git log both
      commits; `git status` in the library is clean.
   7. Reload the chat page, then stop and start `briefstack web` again: the
      chat history is there and the chat still remembers the conversation.
   8. Accept or reject phase 4. It is done only after acceptance.
