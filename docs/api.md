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

`200 { "sessions": [{ id, status, outcome?, startedAt?, lastEventAt?, lastStep?, endReason? }, …] }`,
newest first. `status` is `finished | in-progress | interrupted`;
`outcome` (`completed | cancelled | failed`) comes with `finished`. The UI
lists `interrupted` and `cancelled` ones apart, with their `lastStep`.

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

`{ "projectsDir", "lang", "configLang": "en" | "es" | null, "permissionPolicy": "ask" | "unattended", "maxActiveCreations": 2 }`.
`lang` is the language in use; `configLang` the one saved in the config.

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
numbers) and nothing is written.

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

Answers the same as `GET /api/settings`.

## Creation routes

### `POST /api/creations`

Starts a creation session, which runs the `/new-project` flow.

- Body: `{ "idea": "<free text, 1–20000 chars>" }`
- `201 { "id": "<creation id>" }`
- `409 creation.limit` when as many creations as config `maxActiveCreations`
  (default 2) are active.

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
`{ "summary": "<markdown or null>", "spec": { "name"?, "slug"?, "summary"?, "type"?, "target"?, "targetChosenBy"?, "targetReason"?, "profile"?, "language"? } | null }`.
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
| `spec` | `{ "decision": "approve" }`, `{ "decision": "change", "text": "…" }` or `{ "decision": "cancel" }` |
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

Without an `on…` label, a denied permission or a refused grant just
continues, and a cancelled question or spec closes the session as the skill
does: the open step as `skipped`, then `session finished cancelled`. A
cancel requested through the manager does the same before the next line.
