# briefstack — Backlog plan 1

Plan for the first pass over the backlog in [IDEAS.md](IDEAS.md), section
"4. Open items from the plans". The scope and the rules come from the
user's request of 2026-10-25, given for an unattended run: no questions;
where a decision is needed, the most conservative option is taken and
recorded in [decisions.md](decisions.md) ("Backlog 1").

Starting point: tag `backlog-1-start` on `9dc9e78`, before any change.
Work happens on `main`. Part A: one fix per commit, each with a test;
build, lint and tests green before the commit; push, and CI green on
Linux, Windows and macOS before the next fix. Part B: proposals only, no
code. Part C: a new section in IDEAS.md with the user's text.

Rules: no real SDK sessions; no change to the guard, the hooks, the CSP or
the security routes; no tag but `backlog-1-start` and `backlog-1-done`;
files written only with Write and Edit. A step that fails twice is marked
here and the next one starts.

## 0. Status

Updated 2026-10-25. Done: every step passed, none failed twice. Each fix
was pushed alone and CI was green on Linux, Windows and macOS before the
next one. Choices made without the user are in decisions.md, "Backlog 1".
One step outside the list: a flaky folder-claims test that failed on
Windows CI at `backlog-1-start` was fixed first (A0), since CI had to be
green.

| # | Step | State |
|---|---|---|
| A0 | (found on the way) `folder-claims.test.ts`: the first creation holds its folder at a question, not for a fixed 300 ms | done, `ddd35c0` |
| A1 | `improve-manager.test.ts`: wait for a gate tick that found the blocker instead of a fixed 80 ms | done, `c07dd86` |
| A2 | Skills scanner: URLs in license files and `localhost` URLs as `info`; `subprocess` and `socket` weighed by context; no malicious fixture finding goes down in severity | done, `3da6749`: weighed by the rest of the file; a test pins every malicious fixture finding at its earlier severity |
| A3 | Skills scanner: portability finding for absolute Linux paths (`/tmp`, `/mnt`, `/home`) in scripts | done, `1cb82ef`: rule `portability`, `low`, scripts only |
| A4 | Usage page: the last known plan usage with its time, saved in the briefstack home; no new reading when the page opens | done, `ecbab9a`: `<home>/plan-usage.json`, `lastPlanUsage` in `GET /api/usage`, a card on the page |
| A5 | Suggestions: the count of turns that ended in text persisted on disk, so it survives a restart | done, `59859da`: `<home>/improve/text-turns.json`, read by the evidence after a restart |
| A6 | Check whether the SDK passes the abort signal to the chat's tools; record it; fix only if local, with a test | done, `222d58d`: it does (SDK 0.3.286); nothing to fix; a test pins it. Whether Claude Code sends the cancellation needs a real session |
| A7 | The library lock on writes longer than 2 minutes: reproduce with a test and fix | done, `3c0d343`: reproduced with a second process; the holder keeps its lock fresh |
| B8 | Proposal: creations see the repo's `CLAUDE.md` | done, `47b3fd8`, in IDEAS.md |
| B9 | Proposal: folder claims do not see creations started from the terminal | done, `47b3fd8`, in IDEAS.md |
| B10 | Proposal: the chat describes a creation's step wrongly | done, `47b3fd8`, in IDEAS.md |
| C | IDEAS.md: section "Codex" with the user's text | done, `63d46d3`, section 5 |
| — | Status updated, tag `backlog-1-done` | done |

Not run in this pass (its rules): real SDK sessions. The real checks that
B8–B10 would need, and the open half of A6, are for the user.

## 1. Steps

### A1 — A gate tick instead of a fixed wait

The test "waits while a creation runs and applies once none does" sleeps
80 ms and then checks that nothing was committed. The test's `blockers`
function tells a listener each time the manager looks; after `approve`
answers `waiting`, the test waits for the next look that found the
blocker (a gate tick), then checks `HEAD`. Test only; no change in
`src/`.

### A2 — Less noise in the static scanner

- A URL in a license file (`LICENSE`, `COPYING`, …) is `info`.
- A `localhost`, `127.0.0.1` or `[::1]` URL is `info` in any file.
- A call through a shell (`shell=True`, `os.system`, `os.popen`,
  `execSync`, `sh -c`, `cmd /c`, `powershell -Command`, …) stays `medium`.
- Starting a process without a shell (`subprocess`, `Popen`,
  `child_process`, `spawnSync`, `execFile`) and a raw socket
  (`socket.`, `net.connect`, …) are weighed by the rest of the file:
  `medium` when the file has another `medium` or `high` finding (an
  outside address, a credential read, a deletion, a shell call, a script
  that is not UTF-8, …), `low` otherwise. The line alone is not enough: the
  malicious fixture's `import os, shutil, subprocess, requests` is a plain
  import in a file that steals a token.
- A test fixes the severity of every finding of the malicious fixtures
  (`EXFILTRATOR`, `INJECTOR`, the non-UTF-8 scripts) as it was before the
  change, and checks that none goes down.

### A3 — Portability finding

A new rule `portability` (`low`, scripts only): an absolute Linux path
starting with `/tmp`, `/mnt` or `/home` in a script. On Windows it ends up
under the current drive. Names in English and Spanish in `src/i18n/`.

### A4 — Last known plan usage

Every successful plan usage reading made by the web server (a creation's
panel, the chat's `show_usage`, the high-usage check before a start) is
saved in `<home>/plan-usage.json` with its time. `GET /api/usage` adds it
as `lastPlanUsage` (read from the file; no new reading), and the Usage page
shows the two percentages and when they were read, or a line saying that
none was read yet. Hidden in API key mode, like the rest of the plan usage.

### A5 — Text turns on disk

Each turn that ends in text is also counted in
`<home>/improve/text-turns.json` (by session id, newest first, capped). The
improvement evidence reads the memory count first and the file after a
restart.

### A6 — The abort signal of chat tools

Read the SDK's in-process MCP server (version in `package.json`): whether
the tool handler's `extra` carries the request's `AbortSignal`, and what
aborts it. Record it in decisions.md. If the chain is intact, add a test
that pins it through `SdkChatRunner` with a fake `query` (no session).

### A7 — Library lock held longer than 2 minutes

A lock older than `staleMs` (2 minutes) is taken over even when its owner
is alive and still writing. Reproduce with a test (small `staleMs`, a
second process waiting), then fix: the holder refreshes the lock's time
while it holds it, so only a lock whose holder stopped refreshing it is
stale.

### B8–B10 — Proposals

Added under each item in IDEAS.md: cause, options, risk and the tests
needed. No code.

### C — Codex

A section "5. Codex" in IDEAS.md with the user's text, as given.
