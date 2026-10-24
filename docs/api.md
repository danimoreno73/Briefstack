# briefstack web API

The local server started by `briefstack web` (BRIEF-phase-2 §6). The browser
UI uses it; phase 4's global chat and phase 5 can call it too.

## Requests

- The server listens on `127.0.0.1` only. The `Host` header must be
  `127.0.0.1:<port>` or `localhost:<port>` (403 `web.rejected.host`).
- Every `/api` call needs the per-launch token in `X-Briefstack-Token`
  (401 `web.rejected.token`). `briefstack web` prints it in the URL
  fragment: `http://127.0.0.1:<port>/#token=<token>`.
- Every call that is not `GET`/`HEAD` also needs `Origin` equal to the
  server's own origin, and `Sec-Fetch-Site: same-origin` when the browser
  sends it (403 `web.rejected.origin`).
- JSON bodies: `Content-Type: application/json` (else 415
  `web.unsupportedMediaType`), at most 64 KB (else 413 `web.bodyTooLarge`),
  valid JSON (else 400 `web.invalidJson`) of the documented shape, with no
  extra fields (else 400 `web.invalidBody`).
- Unknown route or method: 404 `web.notFound`.

## Errors

Route errors come back as:

```json
{ "code": "creation.limit", "params": { "limit": 2, "active": ["<id>", "<id>"] }, "message": "The limit of active creations is reached (…)." }
```

`message` is in the server's language (`BRIEFSTACK_LANG`, config `lang`,
OS locale). `code` and `params` are stable: clients that show their own
text use those. The security rejections above send `{ "code" }` only.

| Status | Codes |
|---|---|
| 400 | `web.invalidJson`, `web.invalidBody`, `web.invalidQuery`, `creation.invalidAnswer`, any other coded error |
| 404 | `web.notFound`, `creation.notFound`, `creation.noSpec`, `library.noteNotFound`, `library.commitNotFound`, `events.sessionNotFound` |
| 409 | `creation.limit`, `creation.noReply`, `library.busy`, `creation.noPending`, `creation.wrongPending`, `library.dirtyTree`, `library.revertConflict` |
| 413 | `web.bodyTooLarge` |
| 415 | `web.unsupportedMediaType` |
| 503 | `creation.unavailable` (the server was started without a creation manager; `briefstack web` always has one) |

## Routes

### `GET /api/health`

`200 { "ok": true, "version": "0.1.0" }`

## Read routes

All `GET`, all need the token. They read the config and files on every call,
so a change made from the CLI shows at once. Text from notes and generated
files passes the secret check first: a line that looks like a secret comes
back as `[redacted]`.

### `GET /api/projects`

`200 { "projects": [ProjectListing, …] }`, newest first. A listing is
`{ slug, file, name, created?, session?, status?, issues? }`: `status` is the
note's frontmatter (`target`, `path`, `status`, `profile`, `updated`,
`summary`), `issues` says what is wrong with an invalid one.

### `GET /api/projects/:slug`

```json
{
  "project": { "slug": "…" },
  "note": { "file": "projects/<slug>.md", "text": "…" },
  "timeline": { "summary": {}, "steps": [], "agents": [] },
  "nextSteps": "…",
  "instructions": "…",
  "openCommand": { "cwd": "<project path>", "command": "claude" },
  "targetChoice": { "chosenBy": "user", "reason": "…" }
}
```

- `timeline` is the creation session's (see `GET /api/sessions/:id`), or
  `null` without a `session` or without its `events.jsonl`.
- `nextSteps` and `instructions` are the text of `NEXT_STEPS.md` and
  `INSTRUCTIONS.md` for `claude-app` projects, else `null`. A missing or
  oversized (over 256 KB) file is `null` too.
- `openCommand` is where to run `claude`; `null` when the note has no valid
  status block.
- `targetChoice` comes from the project's `.briefstack/spec.json`:
  `chosenBy` (`user | architect`) and `reason` (the spec's `targetReason`,
  redacted), each optional. `null` when the spec is missing, unreadable or
  has neither field (projects created before the field existed).
- `404 library.noteNotFound` for an unknown slug; `400` for an invalid one.

### `GET /api/sessions`

`200 { "sessions": [{ id, status, outcome?, startedAt?, lastEventAt?, lastStep?, endReason?, idea? }, …] }`,
newest first. `status` is `finished | in-progress | interrupted`;
`outcome` (`completed | cancelled | failed`) comes with `finished`. The UI
lists `interrupted` and `cancelled` ones apart, named by their `idea`, with
their `lastStep`.

`idea` (read-only, added in the UI pass) is the session's `idea.md` as the
flow wrote it: lines that look like a secret replaced with `[redacted]`,
whitespace collapsed to one line, cut to 300 characters (`…` at the end).
It is absent when the file is missing, empty or over 64 KB. Only this route
returns it; the chat's `list_sessions` tool does not.

### `GET /api/sessions/:id`

`200 { summary, steps: [{ step, startedAt, finishedAt?, outcome? }], agents: [{ agentId, agentType, startedAt, stoppedAt? }] }`.
`404 events.sessionNotFound`, `400 events.invalidSession`.

### `GET /api/sessions/:id/events`

The session's lines for the agent panel (phase 3):
`200 { "events": [ { "id", "v", "ts", "session", "source", "type", … } ], "badLines": <n>, "state": <PanelState> }`.

- `events`: every valid line of `events.jsonl` in file order, projected
  (`src/panel/project.ts`): known fields only (docs/events.md), targets and
  denial reasons redacted, any absolute path shown as
  `[outside allowed folders]`, a target at most 120 characters and a reason
  at most 300. `id` is the line's position among the valid lines, from 1;
  the creation stream gives `hook` and `runner` lines the same `id`.
- `badLines`: how many lines could not be read.
- `state`: `buildPanelState(events, { now })` (`src/panel/state.ts`): the
  session, one node per agent (main session first), the timeline, the flow
  steps and plan usage. For a creation still open, the page adds what the
  creation stream knows (the pending request).
- `404 events.sessionNotFound`, `400 events.invalidSession`.

### Library

- `GET /api/library/index`: `{ "file": "INDEX.md", "text": "…" | null }`.
- `GET /api/library/notes[?section=<s>]`: `{ "notes": [{ section, name?, file, summary }, …] }`;
  sections are `profile`, `projects`, `log`, `skills`, `lessons`. An unknown
  section is a 400.
- `GET /api/library/note?section=<s>[&name=<slug>]`: `{ "file", "text" }`.
  `lessons` takes no name; the others need one. `404 library.noteNotFound`.
- `GET /api/library/history[?limit=<1–200>]`: `{ "commits": [{ sha, shortSha, date, subject, files }, …] }`,
  newest first, 50 by default. A library without git history has none.

### `GET /api/usage`

What `briefstack usage show --json` prints (`profile`, `label`, `fromConfig`,
`sessionModel`, `chat: { model, effort }`, `agents`, `tiers`, `research`, `reviewRounds`, `available`,
`drift`, `envWarnings`) plus `presets`: `[{ name, source: "base" | "user", label: { en, es }, sessionModel, effort, chat, tiers, research, reviewRounds }, …]`.
No token or cost figures.

### `GET /api/paths`

What `briefstack paths --json` prints: `home`, `configFile`, `libraryDir`,
`libraryExists`, `projectsDir`, `sessionsDir`, `repoDir`, `allowedDirs`.

### `GET /api/paths/check?dir=<path>`

What `briefstack paths check` inspects, for a folder that is absolute or starts
with `~`: `{ "outDir", "status", "overlaps"? }`. `status` is `missing`, `empty`,
`nonEmpty`, `notADirectory` or `forbidden`; `overlaps` (`repo`, `library`,
`home`, `claudeConfig`, `appData` or `localAppData`) comes with `forbidden`. A
folder inside one of them, or one that contains one (a drive root, the user's
home), is `forbidden`. Nothing is created. A relative path is a 400
`config.relativePath`. Settings uses it to say that a missing projects folder
will be created.

### `GET /api/settings`

`{ "projectsDir", "lang", "configLang": "en" | "es" | null, "permissionPolicy": "ask" | "unattended", "maxActiveCreations": 2, "usageWarning": { "fiveHour": 80, "week": 85 } }`.
`lang` is the language in use; `configLang` the one saved in the config;
`usageWarning` the plan-usage percentages from which a start shows a warning.

## Write routes

Mutating: they need the token, the `Origin` check and a JSON body, as in
"Requests". They call the same library code as the CLI. Responses never echo
note text and the server log has no bodies, so a refused secret goes nowhere.

### `PUT /api/library/note`

Body `{ "section", "name"?, "text" }` (`text` up to 48 KB; `lessons` takes no
name, the others need one). Saves the whole note as `saveNote` does: text that
only adds lines at the end becomes a dated append (`### YYYY-MM-DD`), any other
edit is a full rewrite. Notes in `projects/` keep a validated status block.
One commit and an `INDEX.md` update. Answers
`{ section, name?, file, mode: "append" | "rewrite" | "create" | "unchanged", indexUpdated, committed, status?, warnings }`.
Text with a secret is a 400 `library.secretContent` (`params.lines` are line
numbers) and nothing is written. A text that changes the `path` of a
project note that has one is a 409 `library.pathProtected`: it is where
briefstack made the project, and installs go there.

### `POST /api/library/revert`

Body `{ "sha" }` (4–64 hex characters). Undoes that commit with a new one:
`{ "reverted": sha, "commit": newSha }`. `404 library.commitNotFound`;
`409 library.dirtyTree` (uncommitted changes) or `409 library.revertConflict`
(aborted, the library is as it was). The UI asks for confirmation first.

### `PUT /api/usage`

Body `{ "profile" }`: what `briefstack usage set <profile>` does (rewrites the
repo's agent files and saves `activeProfile`). Answers
`{ "scope": "repo", "profile", "sessionModel" }`. An unknown profile is a 400
`usage.unknownProfile`.

### `PUT /api/settings`

Body with at least one of:

- `projectsDir`: absolute or starting with `~`. The folder is created and
  allowed in the repo's `settings.local.json`, the old one stays allowed.
  A relative path is a 400 `config.relativePath`.
- `lang`: `"en"`, `"es"`, or `null` to clear it.
- `permissionPolicy`: `"ask"` or `"unattended"`.
- `maxActiveCreations`: a whole number from 1 up (default 2): how many
  creations may be active at once.
- `usageWarnFiveHour`, `usageWarnWeek`: whole numbers from 1 to 100
  (defaults 80 and 85): the plan-usage warning thresholds.

Answers the same as `GET /api/settings`.

### `PUT /api/projects/:slug/archived`

Body `{ "archived": true | false }`. Archives (`archived: <date>` in the
note's status block) or unarchives (the line removed) a project; nothing
else changes and nothing is deleted. One commit.
`{ "archived": "<date>" | null, "committed", "warnings" }`; unchanged when
it already was. `404 library.noteNotFound`. `GET /api/projects` keeps
listing archived projects (`status.archived`); the page hides them unless
asked.

## Creation routes

### `POST /api/creations`

Starts a creation session, which runs the `/new-project` flow.

- Body: `{ "idea": "<free text, 1–20000 chars>", "force"?: true }`
- `201 { "id": "<creation id>" }`
- `409 creation.limit` when as many creations as config `maxActiveCreations`
  (default 2) are active.
- `409 usage.high` with `params { fiveHour, sevenDay, warnFiveHour, warnWeek }`
  when the plan usage is at or above a threshold (Settings) and `force` is
  not set: nothing started. The page shows the values and sends the same
  body with `"force": true` for "Start anyway". The reading is the
  `/usage` one (a session that sends no message); one younger than a
  minute is reused; without a reading there is no warning.

### `GET /api/creations`

`200 { "creations": [CreationState, …] }`, oldest first.

### `GET /api/creations/:id`

`200 CreationState`:

```json
{
  "id": "…",
  "sessionId": "…",
  "idea": "…",
  "profile": "balanced",
  "policy": "ask",
  "status": "running | waiting | finished",
  "outcome": "completed | cancelled | failed | interrupted",
  "pending": { "id": "p3", "kind": "question | permission | spec | grant", "payload": {} },
  "cancelling": true,
  "awaitingReply": { "lastMessage": "…", "at": "<ISO time>" },
  "currentStep": "interview",
  "usageReading": true,
  "denied": [{ "toolName": "Bash", "summary": "…", "agentType": "generator", "at": "<ISO time>" }],
  "error": "…",
  "startedAt": "<ISO time>",
  "finishedAt": "<ISO time>"
}
```

- `sessionId` appears once the runner reports it; it names the session
  folder (`<sessionsDir>/<sessionId>/events.jsonl`).
- `status` is `waiting` while `pending` is set. Only one request is shown at
  a time; others wait behind it.
- `outcome` and `finishedAt` appear when finished. A creation finishes only
  when its `events.jsonl` has `session.finished`, or when the server ends
  it: `interrupted` after a server stop or when the runner ended without
  closing the flow.
- `cancelling` is set between a cancel and the end.
- `awaitingReply` is set when the session ended a turn with nothing
  pending: it waits for a reply the page cannot send. `lastMessage` is the
  main session's last text (at most 4000 characters, secrets redacted). It
  is cleared when a new turn starts, when something is asked, and at the end.
  The `status` event of that moment carries `runner: { "kind": "status",
  "status": "turnEnded", "message"? }` with the same redacted text.
- `currentStep` is the flow step open now (while not finished).
- `usageReading` is set until the first plan usage reading arrived or failed.
- `denied` lists the requests denied without asking under the
  `unattended` policy, for the result screen.

`pending.payload` per kind:

| kind | payload |
|---|---|
| `question` | `{ "questions": [{ "question", "header", "options": [{ "label", "description" }], "multiSelect" }] }` (1–4 questions, `AskUserQuestion`'s shape) |
| `permission` | `{ "toolName", "summary", "agentType"? }` (`summary` has any secret-looking line replaced by `[redacted]`) |
| `spec` | `{ "specFile", "summaryFile" }` (both in the session folder) |
| `grant` | `{ "dir" }` (an output folder outside `projectsDir`) |

### `GET /api/creations/:id/spec`

The spec the flow last asked the user to approve, for the approval screen:
`{ "summary": "<markdown or null>", "spec": { "name"?, "slug"?, "summary"?, "type"?, "target"?, "targetChosenBy"?, "targetReason"?, "profile"?, "language"? } | null, "librarySkills": [{ "name", "reason", "agent"?, "library"?: { "status", "hasScripts", "network", "license", "description" } }] }`.
`librarySkills` are the approved library skills the spec chose (phase 6),
with what the library says of each (absent when it has no such skill).
Both files must be inside the creation's session folder, and lines that look
like a secret come back as `[redacted]`. `404 creation.noSpec` before the
flow has shown a spec.

### `POST /api/creations/:id/answer`

Body: `{ "pendingId": "p3", "answer": … }`, where `answer` depends on the
pending kind:

| kind | answer |
|---|---|
| `question` | `{ "<question text>": "<option label, labels joined by \", \", or free text>" }` with every question of the batch and no other key |
| `permission` | `"allow"` or `"deny"` |
| `spec` | `{ "decision": "approve", "removeSkills"?: ["<library skill>", …] }`, `{ "decision": "change", "text": "…" }` or `{ "decision": "cancel" }`. With `removeSkills` the server first takes those library skills out of the `spec.json` the flow showed (in the session folder) and tells the flow `{ "decision": "approve", "removedLibrarySkills": […], "note" }`; if the file cannot be changed the flow gets a `change` asking it to remove them |
| `grant` | `true` (create it if missing and allow writes there, this session only) or `false` |

- `200 CreationState` (after the answer).
- `409 creation.noPending` when nothing is pending, `409
  creation.wrongPending` when `pendingId` is not the one shown (the page is
  stale: reload the state), `400 creation.invalidAnswer` for a wrong shape.

### `POST /api/creations/:id/cancel`

No body. Cancels through the flow, never by killing a write: a pending
question or spec is answered "cancel" (a permission "deny", a grant
"no"), the runner is asked to close at its next step, and the flow closes
the open step as `skipped` and the session as `cancelled`. If it has not
done so within 60 s, the server stops the runner and writes those two
events itself. `200 CreationState` (with `cancelling: true`). Cancelling a
finished creation changes nothing.

### `POST /api/creations/:id/reply`

Body `{ "text": "<1–10000 characters, trimmed>" }`. The free-text reply
(BRIEF-phase-4 §3.3): only while the creation has `awaitingReply` (the
session ended a turn with nothing asked in the browser) and is neither
cancelling nor asking something; otherwise `409 creation.noReply`. The text
is sent to the session as a user message, through the same input queue as
the first one, and is not stored by briefstack. `200 CreationState`
(without `awaitingReply`).

### `GET /api/creations/:id/stream?from=<seq>`

A `text/event-stream` of the creation's events. It first replays every
event with `seq > from` (default 0; the `Last-Event-ID` header works too),
then sends new ones live, and ends after the event that finishes the
creation. A comment line `: heartbeat` is sent every 15 s. Closing the tab
does not affect the creation: reconnect with the last `seq` seen.

The UI reads it with `fetch` and a `ReadableStream` (not `EventSource`), so
it can send the token header.

Each event:

```
id: 12
event: flow
data: {"seq":12,"ts":"<ISO time>","kind":"flow","data":{…}}

```

| kind | data |
|---|---|
| `flow` | an `events.jsonl` line from the flow: `step.started`/`step.finished` (`step`, `outcome`) or `session.started`/`session.finished` (`outcome`) |
| `hook` | an `events.jsonl` line from the hooks: `subagent.start`/`subagent.stop` (`agentId`, `agentType`, `model`?, `effort`?), `tool.pre`/`tool.post`/`tool.failure` (`tool`, `toolUseId`?, `target`?, `effort`?), `session.end` (`reason`). Projected and with `id`, as in `GET /api/sessions/:id/events` |
| `runner` | a line the server wrote to `events.jsonl` itself: `tool.denied`, `session.profile`, `usage` (docs/events.md). Projected and with `id` |
| `question`, `permission`, `spec`, `grant` | `{ "pendingId", "state": "pending", "payload" }` when shown, `{ "pendingId", "state": "answered", "answer" }` when answered (by the user or by a cancel) |
| `status` | `{ "status", "outcome"?, "sessionId"?, "cancelling"?, "runner"? }`: a status change, or progress the runner reports itself in `runner`. Once per creation the real runner reports `runner: { "kind": "effort", "level", "requested"? }`: the effort Claude Code applied (from the first `PreToolUse` hook input) and the one the profile asked for |
| `denied` | `{ "toolName", "summary", "agentType"?, "at", "by": "policy" \| "runner", "reason"? }` |

`seq` starts at 1 and has no gaps within a creation. The `flow`, `hook`
and `runner` lines are the lines `events.jsonl` holds (docs/events.md),
projected as in `GET /api/sessions/:id/events`, so the agent panel reads
either with the same `buildPanelState`.

## Chat routes

The global chat (BRIEF-phase-4 §3.1). Without a chat every route answers
`503 chat.unavailable`. Reads need the token; writes the token and the
same-origin check, like every mutating route.

### `GET /api/chat`

`200 { thread, messages, status: "idle" | "thinking", pending?, model?, seq }`:
the active thread (`{ id, title, createdAt, updatedAt }`), its messages, the
confirmation waiting for the user (at most one), the chat's model and effort
from the usage profile, and the stream `seq` to continue from.

A message: `{ id, ts, role: "user" | "assistant" | "tool" | "confirmation" | "notice", text?, tool?, confirmation?, notice?, detail? }`.
`tool` is `{ name, summary, sources: [{ kind, ref, label? }], error? }`
(what was asked and where the data came from, never the data itself).
`confirmation` is `{ id, tool, card, state: "pending" | "confirmed" | "declined" | "failed" | "expired" | "stale", result?, sources? }`.
`stale` means the user confirmed but what the card showed no longer held
(the note changed in between), so nothing was done.
A card not answered within 59 minutes expires (`expired`), a minute before
the chat server's own one-hour tool-call timeout, so a late confirmation can
never run an action the chat was told had failed.
`notice` is `resumeFailed` (the model context could not be restored: a new
session started, the old messages stay), `sessionError` (`detail` says
what) or `suggestions` (`suggestions`: the ones a creation that just
finished produced, for the page; the model does not see this notice). Every text is stored and sent redacted.

`card` per kind:

| kind | fields |
|---|---|
| `startCreation` | `idea`, `profile`, `active`, `limit` |
| `cancelCreation` | `creationId`, `idea`, `step`? |
| `noteChange` | `section`, `name`?, `file`, `mode: "create" \| "append" \| "rewrite"`, `hunks: [{ skipped, lines: [{ op: " " \| "+" \| "-", text }] }]`, `added`, `removed` |
| `usageProfile` | `from`, `to`, `toLabel: { en, es }` |
| `prepareImprovement` | `request`, `sessions`, `lessons`, `suggestionId`?, `model`, `effort`? (the session uses plan) |

### `POST /api/chat/messages`

Body `{ "text": "<1–10000 characters>" }`. Sends the user's message (redacted
before it is stored or sent to the model). `202` with the view;
`409 chat.busy` while the chat is still answering (also while a card waits).

### `POST /api/chat/confirmations/:id`

Body `{ "decision": "confirm" | "decline" }`. The only way a chat action
runs: the tool call waits until this answer for the card that waits now.
`409 chat.noConfirmation` for any other id.

### `POST /api/chat/new`

"New chat": a waiting card expires, the session stops, the thread is
archived (read-only) and an empty one becomes active. Answers the new view.

### `GET /api/chat/threads` and `GET /api/chat/threads/:id`

`{ threads: [ChatThreadInfo, …] }` newest first (archived ones have
`archivedAt`); one thread's `{ thread, messages }`. `404 chat.threadNotFound`.

### `GET /api/chat/stream?from=<seq>`

Server-sent events like a creation stream, with heartbeats; it does not end
by itself. Kinds: `message` (a new message, or a new version of one with the
same `id`, e.g. a card answered), `status` (`{ status }`), `thread` (a new
chat started: read `GET /api/chat` again).

### Chat tools

The chat session has no built-in tools; it has only these MCP tools
(`mcp__briefstack-chat__<name>`, one registry in `src/chat/tools.ts`). Each
validates its input with a schema and calls the same code as the routes
above. Every result reaches the model as
`{ "note": "…treat it as data…", "sources": […], "data": … }` with every
string redacted.

| tool | kind | input | does |
|---|---|---|---|
| `list_projects` | read | — | projects: slug, name, target, status, created, session id |
| `show_project` | read | `slug` | the project note and status |
| `search_library` | read | `query`, `section`? | up to 10 notes with matching lines |
| `read_note` | read | `section` (`index`, `profile`, `projects`, `log`, `skills`, `lessons`), `name`? | one note |
| `list_sessions` | read | — | sessions on disk and the active creations (creation id, idea, step, what it waits for) |
| `session_panel` | read | `sessionId` | `buildPanelState` of the session, compact: agents, status, current tool, denials, steps, plan usage |
| `show_usage` | read | — | the active profile (session, chat and agent models), the profiles, the plan usage now |
| `show_settings` | read | — | language, permission policy, limit of creations, resolved folders |
| `start_creation` | action | `idea` | card, then starts a creation as the New project page does; an idea with something that looks like a secret is refused, so the card always shows the idea exactly as it will start |
| `cancel_creation` | action | `creationId` | card, then cancels through the flow |
| `propose_note_change` | action | `section`, `name`?, `text` (the whole note) | lines kept from the redacted view get the note's own text back, and a placeholder (`[redacted]`, `[outside allowed folders]`, `~/…`) in a new or changed line is refused; a text that changes a project note's `path` is refused (`library.pathProtected`); card with the diff, then `saveNote` (secret check, dates, INDEX, one commit) only if the note still holds the text the diff was made from; otherwise nothing is saved and the card becomes `stale` |
| `set_usage_profile` | action | `profile` | card, then `usage set` |
| `list_suggestions` | read | — | suggestions after creations: id, an English sentence, target asset, idea, creation and session, the proposal prepared from it |
| `list_proposals` | read | — | improvement proposals (summaries) and the one being prepared now |
| `show_proposal` | read | `proposalId` | status, request, diff hunks and rationale per file, validator problems, safety notice, check results, rounds, what blocks applying |
| `prepare_improvement` | action | `request`, `sessions`? (up to 5), `lessons`?, `suggestionId`? | card, then starts an improvement session (one at a time; a request with a secret is refused). Approving, asking for changes, discarding and reverting are not chat tools: they happen on the proposal page |
| `list_skills` | read | `status`? | the library's third-party skills: name, the author's description (data), status, tags, source, scripts, network, license, high findings, model review, whether a new version waits |
| `add_skill` | action | `url`, `tags`? | card with the link, repo, folder and ref (an invalid link is refused before any card), then fetches the skill into quarantine with its review. Approving, rejecting and deleting are not chat tools: they happen on the skill's page |
| `add_skill_to_project` | action | `skill`, `project` (slug) | only an approved skill, only a project with a library note, not twice; never a protected folder or one inside `.git` (refused before any card). Card with where it goes (`location`), the project `folder`, `outsideProjects` (outside the projects folder: confirming grants that folder for this install only), its license and a scripts note; then the skill joins the project's `spec.json` `librarySkills` (the user's choice), the same install as `skills install --skill`, and one dated line in the project note. If the note points to another folder by then, nothing is installed (`stale`) |

`start_creation` and `prepare_improvement` cards carry `usage`
(`{ fiveHour, sevenDay, warnFiveHour, warnWeek }`) when the plan usage is
at or above a threshold: confirming the card is "start anyway".

An action is refused without a card when another card waits, after 10 cards
in 10 minutes, when the text holds a secret, when nothing would change, or
when the limit of creations is reached. Not available from the chat:
reverting library commits, the projects folder, the permission policy,
answering a creation's questions or approving its spec, approving,
discarding or reverting an improvement, approving, rejecting or deleting a
skill.
## Improvement routes

Self-improvement of the creation flow (BRIEF-phase-5). Without an
improvement manager every route answers `503 improve.unavailable`. Reads need
the token; writes the token and the same-origin check. Approve, discard,
revert and the real check exist only here, for the proposal page: the chat
can prepare an improvement but never apply one.

### `GET /api/improve`

`200 { active?, proposals, suggestions, blockers }`: the id of the proposal
whose session is running, every proposal newest first
(`{ id, status, title?, request, createdAt, updatedAt, files, appliedCommit?, revertCommit? }`),
the suggestions after creations, and what blocks applying now (running
creations: their ideas, or `session <id>` for one on disk this server does
not run).

A suggestion (BRIEF-phase-5 §3.5; at most three per finished creation,
computed without a model, newest first, at most 60 kept):
`{ id, kind, creationId, sessionId?, idea, createdAt, target, params, proposalId? }`.
`kind` is `failure` (`params.outcome`, `steps`), `textQuestions` (`count`
turns that ended waiting for a text answer), `denials` (`count`, `tools`),
`reviewRounds` (`count`, from 2 up) or `lessons` (`count`, the first
`lines`); `target` is the asset most likely to need the change;
`proposalId` is set once an improvement was prepared from it. A suggestion
changes nothing by itself.

Statuses: `preparing` (the session runs), `verifying` (the server commits,
validates and tests), `ready`, `rejected` (a validator failed), `failed`
(the session, the tests or git failed), `waiting` (approved, waits for no
creation running), `applied`, `revertWaiting`, `reverted`, `discarded`.

### `GET /api/improve/proposals/:id`

`200 { proposal, blockers, check? }`. `proposal` has everything but the
worktree path: `request`, `title`, `expectedEffect`, `evidence`
(`[{ kind, ref, file }]`), `baseBranch`, `baseCommit`, `branch`, `rounds`
(`[{ n, feedback?, startedAt, endedAt?, outcome?, commit?, denials, text?, error? }]`),
`files` (`[{ path, kind, status, base?, proposed?, hunks, added, removed, rationale?, evidence? }]`,
diff hunks as in a note-change card), `validation` (`{ ok, problems: [{ kind, file?, line?, detail }] }`),
`checks` (`{ ok, steps: [{ name: "build" | "lint" | "test", ok, ms, tail }], error? }`),
`head?` (the commit of the last checked round; an approval sends it back),
`safety?` (`{ state: "flagged" | "clear" | "unavailable", reason, model, at }`:
a cheap model's reading of the diff, after the validators pass; never blocks),
`realCheck?`, `offeredCheck?`, `appliedCommit?`, `revertCommit?`, `error?`.
`check` is the offered real check: `{ name, script, cost: { en, es } }`.
`404 improve.notFound`.

Problem kinds: `forbiddenPath` (also a file git ignores left in the
worktree), `notModified` (added, deleted or renamed), `mode` (file mode
changed, such as the executable bit), `notText`, `frontmatter`, `locked`,
`secret`, `personalPath` (also `~/` paths), `personalData` (an e-mail outside
example domains, the git user's name or e-mail, a project name), `profileText`,
`lessonText` (eight words in a row from the lessons), `noChanges`,
`unexplained` (no rationale for a changed file). Problems in the title or the
expected effect have no `file` and a `detail` that starts with "in the title"
or "in the expected effect".

### `POST /api/improve/proposals`

Body `{ "request": "<1–10000>", "sessions"?: [id, …] (at most 5), "lessons"?: boolean, "suggestionId"? }`.
Starts an improvement session (one at a time): `202 { proposal }`;
`409 improve.busy` while one runs, `409 improve.noRepo` when the repo is not
on a branch or the home is inside it, `404 improve.suggestionNotFound` (also
for a discarded suggestion). `"force": true` in the body skips the
plan-usage warning (`409 usage.high`, as for `POST /api/creations`).

### `POST /api/improve/suggestions/:id/discard`

Discards a suggestion for good (`dismissedAt` in
`<home>/improve/suggestions.json`): it is no longer listed here, in the chat
or on a result screen, and cannot be prepared. `200 { suggestions }`;
`404 improve.suggestionNotFound` (unknown or already discarded).

### `POST /api/improve/proposals/:id/changes`

Body `{ "text": "<1–10000>" }`. "Ask for changes": a new round on the same
branch, from `ready`, `rejected` or `failed`. `202 { proposal }`. If the base
branch moved, the worktree first moves to its tip, which becomes
`baseCommit`; changes that no longer merge are dropped and the session is
told which.

### `POST /api/improve/proposals/:id/approve`

Body `{ "head": "<commit>" }`: the `head` of the proposal the page showed.
From `ready` with validators and checks passed. Applies the change as one
commit on the base branch now, or answers with status `waiting` while a
creation runs (it applies as soon as none does; creation starts wait while
it is applied). `409 improve.staleReview` when another round was checked
since. Refusals leave it `ready` with `error` set: `409 improve.notOnBranch`,
`improve.uncommitted`, `improve.baseChanged` (the branch changed a proposed
file since the base: ask for changes), `improve.moved`.

### `POST /api/improve/proposals/:id/revert`

From `applied`: one revert commit now, or `revertWaiting` while a creation
runs. Same refusals.

### `POST /api/improve/proposals/:id/discard`

From `preparing` (the session is stopped), `ready`, `rejected`, `failed` or
`waiting`: removes the worktree and the branch.

### `POST /api/improve/proposals/:id/check`

From `ready`, when the proposal offers a real check: starts it (`202`); the
result is added to the proposal as `realCheck`. `409 improve.noCheck`,
`409 improve.checkBusy`.

## Skill routes

Third-party skills of the library (BRIEF-phase-6). Without a skill service
every route answers `503 skills.unavailable`. Reads need the token; writes
the token and the same-origin check. Each change is one library commit of
`skills/<name>/` (the metadata note `skills/<name>/<name>.md`, the files
under `files/`, a new version under `next/`). Approving, rejecting and
deleting exist only here, for the Skills page.

A detail is `{ "record": SkillRecord, "diff"?: [FileDiff] }`. `SkillRecord`
is the metadata note's frontmatter: `name`, `description`, `status`
(`quarantine` | `approved` | `rejected`), `tags`, `statusChanged`,
`source { url, repo, path, ref, commit, link }`, `fetched`,
`license { spdx, source, file? }`, `hasScripts`, `network`,
`allowedTools?`, `files [{ path, size, kind, sha256, executable }]`,
`findings [{ rule, severity, file, line?, excerpt? }]`,
`model { state: flagged | clear | failed | unavailable, reason, model, at, cut? }`
(`failed`: the review ran but its reply was not exactly the answer's JSON,
or it broke; `unavailable`: no model review in this server; `cut`: files
the model saw only in part or not at all, shown as "Partial review"), and
`next?` (the same version fields for a new version in quarantine).
`FileDiff` is `{ path, change: added | removed | changed, hunks?, binary? }`
of `next` against the current files. A change answers
`{ "detail"?, "committed", "warnings" }`.

### `GET /api/skills`

`200 { skills: [{ name, description, status, tags, repo, path, commit, link, hasScripts, network, license, high, model, update, statusChanged }] }`,
by name. Notes that do not read back are left out.

### `GET /api/skills/:name` and `GET /api/skills/:name/file?path=<p>&version=current|next`

The detail; one file of a version as `{ path, kind, size, text? }` (no
`text` for a binary or a file over 512 KB). `404 skills.notFound`,
`404 skills.fileNotFound` (only recorded paths are served),
`409 skills.unreadable`.

### `POST /api/skills`

Body `{ "url": "<github link>", "tags"?: [...] }`. Fetches the folder from
the two GitHub hosts at the commit the ref points to (limits: 200 files,
1 MB each, 5 MB in all; no symlinks, submodules, LFS pointers,
`.gitattributes` or `.gitmodules`; portable names, without bidirectional or
zero-width characters; only 40-hex object ids in a listing; every blob hash
checked), reviews it (static rules, license, the model review on every text
file) and stores it in quarantine. `201 { detail, committed, warnings }`. `400 skills.invalidUrl` (`params.reason`:
`notHttps`, `notGithub`, `shape`, `notSkillFile`), `404 skills.repoNotFound`,
`skills.refNotFound`, `skills.pathNotFound`, `400 skills.noSkillFile`,
`skills.tooLarge`, `skills.forbiddenEntry`, `skills.integrity`,
`422 skills.pathTooLong` (a file would land on a path over 250 characters
in the library; nothing is written),
`skills.invalidName`, `skills.invalidTag`, `409 skills.exists`
(`params.sameSource`), `429 skills.rateLimited` (`params.reset`),
`502 skills.network`.

### `POST /api/skills/:name/approve`, `/reject`, `/delete`

Approve (from quarantine or rejected; only while the files on disk still
match the recorded hashes, else `409 skills.modified`), reject (from
quarantine or approved), delete (any status). `409 skills.wrongStatus`.

### `PUT /api/skills/:name/tags`

Body `{ "tags": [...] }`: lower-case letters, digits and hyphens, at most
30 characters each and 10 in all (`400 skills.invalidTag`).

### `POST /api/skills/:name/check-update`

Only for an approved skill: fetches the latest commit of the ref it was
added from into `next/`, reviewed like a new skill.
`{ ..., "outcome": "updated" | "upToDate" | "pinned" }` (`pinned`: added at
a commit). `409 skills.updatePending` while one waits. Never automatic.

### `POST /api/skills/:name/update/approve` and `/update/reject`

The new version replaces the approved one (checked against its hashes), or
is dropped. `409 skills.noUpdate` when none waits.

## CLI: `skills install`

`briefstack skills install <project-dir> [--skill <name>] [--json]`. Without
`--skill`, the library skills of the project's `.briefstack/spec.json`
(`librarySkills`) not installed yet; with it, one of them only
(`skills.notInSpec` for a skill the spec does not choose). Only approved
skills whose library files match their hashes; never over an existing
file; never through a link that leads out of the project; never a path
over 250 characters (`skills.pathTooLong`, checked before copying). `claude-code`:
`.claude/skills/<name>/` byte for byte; `claude-app`: `skills/<name>.zip`
(the skill folder at the archive's root) and a line under "Skills" in
`NEXT_STEPS.md`. Each install is recorded in `.briefstack/skills.json`
(source, commit, agent, file hashes, the archive's hash). The validator
checks those hashes (`librarySkill.*`), reports an installed skill the
spec does not choose (`librarySkill.notChosen`), and leaves the skills' own
text alone. The creation guard lets the generator run it, into an allowed
folder, and only for the library skills of the spec as the user approved it
(the runner records them at the approval): a `--skill` outside that list,
or a project `spec.json` that names another, is denied, and so is any
install before an approval.

## Appendix: fake runner recordings

`FakeRunner` (`src/creation/fakeRunner.ts`) replays a recorded creation for
tests and the E2E suite: no tokens, no login. A recording is a text file
with one JSON object per line; blank lines and lines starting with `#` are
ignored. Examples are in `tests/fixtures/recordings/`: `full` (a whole creation), `change-at-spec`, `working` (busy for a long time, to cancel), `permissions` (two requests and a refusal by the guard) and `grant` (an output folder to allow). The e2e fixture can also build a recording at run time.

| line | effect |
|---|---|
| `{"do":"session","phase":"started"}` | writes `session.started` |
| `{"do":"session","phase":"finished","outcome":"completed"}` | writes `session.finished` and ends the run |
| `{"do":"flow","step":"spec","phase":"started"}` | writes `step.started`; `"phase":"finished","outcome":"ok"` writes `step.finished` |
| `{"do":"hook","type":"subagent.start","agentType":"architect"}` | writes a hook line (`agentId`, `agentType`, `tool`, `reason` optional) |
| `{"do":"emit","event":{"kind":"agent",…}}` | sends a runner event through `io.emit` |
| `{"do":"question","questions":[…],"onCancel":"<label>"}` | asks 1–4 questions |
| `{"do":"permission","toolName":"Bash","summary":"…","agentType":"generator","onDeny":"<label>"}` | asks for a permission |
| `{"do":"spec","onChange":"<label>","onCancel":"<label>","spec":"…","summary":"…"}` | writes `spec.json` and `spec-summary.md` (when given) in the session folder and asks for approval; a change jumps to `onChange` |
| `{"do":"grant","dir":"out","onDeny":"<label>"}` | asks to grant a folder (relative to the session folder) |
| `{"do":"label","name":"…"}`, `{"do":"goto","label":"…"}` | jump targets and jumps |
| `{"do":"wait","ms":50}` | a pause, cut short by a cancel or a stop |
| `{"do":"exit"}` | ends without closing the session, like a crash |
| `{"do":"claim","dir":"garden","onRefused":"<label>"}` | claims the output folder (relative to the `projectsDir` option); when another creation holds it, reports a denial and jumps to `onRefused` |
| `{"do":"library","section":"lessons","text":"…"}` | `library add` into the `libraryDir` option, through the library queue |
| `{"do":"turnEnd","message":"…"}` | ends a turn with that text and nothing asked, then waits for the free-text reply |
| `{"do":"generate","dir":"meeting-notes"}` | what the generator does through the CLI: `scaffold` of the session's `spec.json` into the `projectsDir` option (base templates, no git), then `skills install` when the spec has library skills (needs the `libraryDir` option) |

Without an `on…` label, a denied permission or a refused grant just
continues, and a cancelled question or spec closes the session as the skill
does: the open step as `skipped`, then `session finished cancelled`. A
cancel requested through the manager does the same before the next line.
