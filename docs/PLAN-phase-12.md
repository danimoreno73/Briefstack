# briefstack — Phase 12 plan: a server mode for the user's home server, and reserve providers for builds

Plan for [BRIEF-phase-12.md](BRIEF-phase-12.md). H0 is in
[decisions.md](decisions.md), "Phase 12: H0", with sources and dates; this
plan follows from it. Work happens on `main`, from the brief's commit
`aec3342` (the tag `phase-12-start` was refused to the session; the user
creates it on `0442ed3`). Small commits, one concern each; build, lint,
unit and e2e tests green before each commit; CI checked after each push
and green on Linux, Windows and macOS before the next milestone's first
commit.

**Not approved by the user before the work:** the brief lets H0, the plan
and the milestones go ahead unattended (its §8). Every choice made without
the user is in decisions.md, "Decisiones sin Dani (fase 12)".

## 0. Status

Updated 2026-11-26.

| # | Milestone | State |
|---|---|---|
| H0 | Verify before designing (BRIEF §6) | done, decisions.md "Phase 12: H0" |
| M1 | Server mode: listening address, allowed names, warning, Codex off; local mode pinned by a regression test | to do |
| M2 | Access secret and device sessions: sign-in, cookie, devices, sign-out, revoke-all, attempt limit; the page in server mode | to do |
| M3 | The pages on a phone: the progress table, the sign-in and devices pages, e2e at phone width | to do |
| M4 | Reserve providers: configuration, status check, a provider's session environment, the build's choice at the threshold, provider and tokens per card | to do |
| M5 | Builds resume by themselves after a restart (setting), and the cap on slots (setting) | to do |
| M6 | Docs (`docs/server.md`, README, `docs/api.md`, CHANGELOG) and two real checks prepared, not run | to do |
| Real | The real checks, run by the user inside the container | to do |
| Accepted | The user's acceptance | to do |

## 1. Design decisions taken from H0

Each one is the conservative reading and is in decisions.md.

1. **Server mode is one start flag, and nothing changes without it.**
   `briefstack web --server` turns it on; it requires
   `--access-secret-file <path>` and at least one `--allowed-host
   <name:port>` (repeatable), and accepts `--listen <address>` (default
   `127.0.0.1`; `0.0.0.0` in the container). `--listen`,
   `--allowed-host` and `--access-secret-file` without `--server` are a
   usage error, so local mode cannot be half-changed by mistake. Flags,
   not environment variables: the compose file's `command:` shows them,
   and nothing in the environment of the user's shell turns server mode
   on by itself. At start, server mode prints a warning naming the
   address and the allowed names.
2. **Allowed names.** In server mode the accepted `Host` values are the
   loopback ones on the listening port (as today: the container's own
   checks reach it there) and the configured names exactly (lowercase,
   `name:port`, no wildcard, no scheme, no path). The origin of a
   configured name must be `https://<name:port>` (Tailscale serves
   HTTPS; H0, 1); a loopback name keeps `http://`. `Sec-Fetch-Site`, when
   sent, must still be `same-origin`.
3. **The access secret.** Read once at start from the file (trailing
   newline trimmed), at least 32 characters, never from the command line,
   the environment or the page, never logged, compared with
   `timingSafeEqual` over SHA-256 digests (equal length whatever the
   input). A missing, empty or short file stops the start with an error
   that names the file, not its content. On Linux and macOS a file
   readable by group or others prints a warning.
4. **Device sessions.** A correct secret at `POST /api/server/sign-in`
   creates a session: 32 random bytes, sent once in the cookie
   `__Host-briefstack-session` (`HttpOnly; Secure; SameSite=Strict;
   Path=/`, a `Max-Age` of 400 days, the most browsers keep); the server
   keeps only its SHA-256, with a device label (the browser's
   `User-Agent`, cut to 120 characters and stripped of control
   characters), the creation time and the last use, in
   `<home>/server/sessions.json` (written through a temp file and a
   rename, mode `0600` where it applies). `/api` in server mode needs a
   known session instead of the token; mutating calls also need the
   origin check. The devices list, sign-out (this device), revoke one and
   revoke all are routes of their own; revoking all also signs this
   device out. Restarting the server keeps the sessions; changing the
   secret file does not revoke them (the guide says to revoke all).
5. **The attempt limit.** One counter for the whole server (one user;
   the addresses behind Tailscale and Docker are not trustworthy): after
   5 failed sign-ins within 15 minutes, every sign-in is refused for 15
   minutes, the right secret included, with `429 server.signInLocked`
   and the time left. A failed attempt's answer takes the same time as a
   good one (no early return on length). The counter lives in memory: a
   restart clears it (the container restarts only on a crash).
6. **The page in server mode.** `GET /api/server/state` answers without
   any credential with `{ mode, signedIn }` only. Without `#token=` in
   the address the page asks it: in server mode it shows a sign-in form
   (the secret in a password field, never in the address), then loads as
   today; every request is sent with `credentials: 'same-origin'`. In
   local mode the page and its requests are exactly today's
   (`credentials: 'omit'`, the token header).
7. **Codex stays off in server mode.** The Codex service reports it off
   and refuses to turn it on (`codex.serverMode`), so no task round and
   no creation offers it; Codex on Windows in local mode is unchanged.
8. **Reserve providers are configured in `config.json`, not from the
   page.** `reserveProviders: [{ name, baseUrl, model, smallModel?,
   keyFile, note? }]` (name: lowercase letters, digits and `-`, unique;
   `baseUrl`: `https://` only; `keyFile`: absolute path). The page and
   the API show them (name, base URL, models, key file path, the status
   check) and never write them: a page that could change a base URL or a
   key file could send a key elsewhere, or send any file the server can
   read as a key. The key is read from its file only when a round starts,
   passed only to that round's environment, never stored, logged, shown
   or returned (unit tests look for it in every API answer and log line).
9. **The status check reads no key** (H0, 3): the key file exists and is
   not empty (its size), and the base URL's host answers an HTTP request
   sent without any credential (any status counts as reachable; a network
   error or 10 s without an answer as unreachable); the key's validity is
   `notChecked`. It runs only when the user clicks.
10. **A provider's round** (H0, 3): the clean environment, every Anthropic
    credential taken out, the provider's base URL, the key as
    `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` unset (the model goes as
    the query's option), `ANTHROPIC_DEFAULT_OPUS_MODEL`,
    `_SONNET_` and `_FABLE_` set to `model`, `_HAIKU_` and
    `CLAUDE_CODE_SUBAGENT_MODEL` set to `smallModel` (or `model`),
    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, the permission mode
    `default` instead of `auto` (the guard decides every call), effort
    not sent. Everything else of a build's round is the same: the guard,
    the exact list, no dialog, the integration branch, the final apply.
11. **The build's choice at the threshold.** The start page gains "At the
    usage threshold": pause (the default, today's behaviour) or go on
    with one of the configured providers, with a warning that the
    provider is paid per use, sees the code and prompts of the cards it
    runs, and where its data goes is what its own terms say. Stored in
    the build's settings as `reserve: <name>`. Before each pass the plan
    usage is read as today; at or above a threshold (`reason: 'usage'`)
    with a reserve whose key file exists, the cards of that pass start on
    the reserve; below the thresholds, on Claude again. A failed reading
    (`usageUnread`) still pauses (unknown is not "over"). A reserve whose
    key file is missing at that moment pauses the build as today, with
    the reason in its detail. A card keeps the provider it started with
    for its fix rounds; a redo starts on whatever the next pass chooses.
    The planner, creations and ordinary tasks never use a provider.
12. **Provider and tokens per card.** Each round records the provider it
    ran on (absent: Claude); the build's card and progress row show it
    next to the tokens, which are the SDK's own count for that session.
13. **Auto-resume** (H0, 5): `buildsAutoResume` in `config.json` and
    Settings, off by default. At start, after both `recover()` calls, a
    build that the restart interrupted (it was `running`, or `paused` for
    usage) resumes through the manager's lock: one paused for usage goes
    back to paused with its timer (or resumes if its time passed); one
    that was running resumes with the usage read first, its interrupted
    cards started again at the integration head (their tasks discarded)
    whatever the slots. A build interrupted by a restart 3 times in a row
    without a card ending in between stays interrupted, with a message.
    The record keeps `autoResumes` (reset when a card ends).
14. **The slot cap:** `buildSlotsCap` in `config.json` and Settings (1 to
    4; absent means 4, today's maximum). A build started with more slots
    runs with the cap; the start page offers no more than the cap.

## 2. Milestones

### M1 — Server mode

- `src/server/security.ts`: a `ServerAccess` description (listen address,
  allowed names, secret digest) and the checks parameterised by it; the
  local functions unchanged in behaviour.
- `startWebServer`: an optional `server` option; listen on its address;
  `GET /api/server/state`.
- `briefstack web`: `--server`, `--listen`, `--allowed-host`,
  `--access-secret-file`; the warning; usage errors; i18n en and es.
- Codex off in server mode.
- Tests: off by default (address, hosts, token, origin as today: a
  regression test); the flags and their errors; hosts and origins
  accepted and refused in server mode; the secret file (missing, short,
  trimmed, never in output).

### M2 — Access secret and device sessions

- `src/server/sessions.ts`: the store, the digest, the cookie, the
  attempt limit (clock injected).
- Routes: sign-in, sign-out, devices, revoke one, revoke all; `/api` by
  cookie in server mode.
- The page: the state call, the sign-in form, `credentials` by mode, a
  devices section in Settings (server mode only).
- Tests: constant-time compare, cookie flags, revoke, sign-out, limit and
  its end, the secret and the cookie never in a log line or an answer;
  e2e: sign in once and stay signed in (reload, new tab), revoke.

### M3 — The pages on a phone

- The build's progress table without sideways scroll at 390 px; the
  sign-in page and the devices list at phone width.
- e2e at 390×844: the board before the start and the build page.

### M4 — Reserve providers

- `src/providers/`: config parsing, the status check, the round's
  environment, the key read at use.
- Settings: a read-only list with the check button. API:
  `GET /api/providers`, `POST /api/providers/:name/check`.
- Builds: `reserve` in the settings and the start page with its warning;
  the gate's choice; the provider passed through the task manager to the
  round; provider per card on the page.
- Tests: the environment (credentials out, provider in, no other
  session gets it); the key never in an answer or a log line; pause or
  reserve at the threshold; a missing key file; the fake runner records
  the provider; e2e: a build that goes on with a fake reserve provider.

### M5 — Auto-resume and the slot cap

- Settings and config fields; the start's resume after `recover()`; the
  cap on the start page and in the manager.
- Tests: on and off; paused for usage; the cap of 3; the interrupted card
  requeued with one slot; the slot cap.

### M6 — Docs and the real checks

- `docs/server.md` (needs, domains with sources, flags, files, an
  example compose file publishing on the host's 127.0.0.1 only,
  credentials and how to revoke each), README, `docs/api.md`, CHANGELOG
  "Unreleased".
- `scripts/real/check-server-access.ts` (no model) and
  `scripts/real/check-build-reserve.ts` (spends a little of the
  provider's credit), prepared and not run, with static tests like the
  other real checks'.
