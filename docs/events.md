# Session events

One JSON object per line in `<briefstack home>/sessions/<session id>/events.jsonl`,
append-only. Every line has `v` (always `1`), `ts` (ISO time), `session`
and `source`. Fields marked optional may be missing; lines written before
phase 3 have none of the fields added in phase 3 and stay valid. A reader
skips lines it does not understand.

## `source: "flow"` — written by `briefstack event`

| type | fields |
|---|---|
| `session.started` | — |
| `session.finished` | `outcome?`: `completed` \| `cancelled` \| `failed` |
| `step.started` | `step`: a flow step |
| `step.finished` | `step`, `outcome?`: `ok` \| `skipped` \| `failed` |

## `source: "hook"` — written by `scripts/hook-event.mjs`

| type | fields |
|---|---|
| `subagent.start` | `agentId?`, `agentType`, `model?` (phase 3: from the agent file) |
| `subagent.stop` | `agentId?`, `agentType`, `effort?` (phase 3) |
| `tool.pre` | `agentId?`, `agentType?`, `tool`, `toolUseId?`, `target?`, `effort?` (the last three phase 3) |
| `tool.post`, `tool.failure` | `agentId?`, `agentType?`, `tool`, `toolUseId?` (phase 3) |
| `session.end` | `reason?` (also written by the server: `server_stop`, `runner_exit`, `runner_failed`) |

No `agentId` means the main session. Tool inputs and outputs are never recorded.

### Targets

`target` is `{ "root": "session" | "projects" | "repo" | "cli" | "outside", "path"?: string }`:
a file path relative to the session folder, the projects folder or the
briefstack repo (the closest), or the briefstack subcommand of a shell
command (`cli`, e.g. `library add`). A path in none of those folders is
`{ "root": "outside" }` with no path. At most 120 characters, the end kept.
Other tools get no target: never a query, URL, pattern, command or content.
The server redacts targets again before showing them.

## `source: "runner"` — written by the web server (phase 3)

| type | fields |
|---|---|
| `tool.denied` | `tool`, `by`: `guard` \| `policy` \| `user`, `agentId?`, `agentType?`, `toolUseId?`, `reason?` (secrets redacted, absolute paths hidden). Since phase 4, `guard` also covers the folder claim hook (a project folder another active creation holds); its reason says so |
| `session.profile` | `profile`, `model?`, `effort?` (the effort asked for) |
| `usage` | `fiveHour`, `sevenDay`: percent of the plan window, or `null` |

Runner lines are not activity: they do not change whether a session reads
as in progress or interrupted.

## Not an event: the session's folder record

`briefstack paths check <dir> --session <id>` (the flow passes it since
backlog 2) writes the folder it checked to
`<briefstack home>/sessions/<session id>/folder.json` (`{ "v": 1, "dir",
"at" }`; not for a forbidden folder or a file), replacing the last one. It
is kept out of `events.jsonl` because it holds an absolute path. The web
server reads it for the sessions it does not run: while such a session is
in progress (by the rules above), its folder counts as taken for the
server's own creations (`src/events/sessionFolder.ts`).
