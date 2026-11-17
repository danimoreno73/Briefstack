# Brief — Phase 8: Codex delegation in tasks

## Status (2026-11-17)

**Done for tasks** (steps 19 to 28, 2026-11-07 to 2026-11-08). Both real
checks on Windows, run by the user, passed (decisions.md, "Phase 8: step
27" and "Phase 8: closed"). Generation with Codex is not done: it needs a
brief of its own (IDEAS.md §5).

The brief below is the one the user approved on 2026-11-07, kept as it
was approved, with the names of people replaced by "the user". What
changed after it:

- **Decision 4, the Windows sandbox:** the default is `unelevated`, and
  `elevated` can be chosen (step 25). On the user's machine `elevated`
  cannot run Node installed in the user's profile (nvm), and neither mode
  closes the network, so requiring `elevated` added no isolation there.
- **Calls per round:** a setting, **5** by default, 1 to 10 (the brief
  proposed 3).
- **The network:** the brief assumed "network blocked inside". Steps 20 to
  22 measured that, on Windows, both modes read outside the worktree,
  reach 127.0.0.1 and reach the Internet, and that no Codex setting tried
  closes the network. After step 22 the user chose option (3) of
  decisions.md, "Phase 8: step 22": go on with Codex and its shell and
  accept the measured risk with a plain warning in Settings. A closed
  network is no longer a requirement (decisions.md, "Phase 8: step 25").
- **Step numbers:** the measurements took more steps than planned, so the
  runner became step 25, the real check step 26, the page step 27 and the
  token count and the real cancel check step 28 (below).
- No `PLAN-phase-8.md` was written: each step had its own instructions,
  and its results are in decisions.md.

### The steps as they were done

| Step | What | Commits | decisions.md |
|---|---|---|---|
| 19 | Spike on the real machine: `.git` protected, writes outside blocked, reads outside and 127.0.0.1 open, `elevated` cannot run nvm's Node | `b082e57..6ae8fdc` | "Phase 8: Codex spike" |
| 20 | Second spike, no model: the profile is readable in both modes, 127.0.0.1 open, closing reads needs `elevated` and persistent `DENY` ACLs | `15fe68f..e4721eb` | "Step 20: the Internet, the user's profile, and closing reads or network per call" |
| 21 | The Internet control, three attempts: both modes reach the Internet; gate closed | `51a4b7b..13fe824` | "Phase 8: step 21, the Internet control" |
| 22 | Codex's firewall rules (enabled, `CategoryDisabled`) and `codex exec` with `network_access=false`: no setting closes the network | `4c7ec73..1eb67a9` | "Phase 8: step 22, can the network be closed on Windows?" |
| 23 | Stopped without commits: found the library lock defect fixed in step 24 | — | — |
| 24 | The library lock's judge no longer counts its own delay (the intermittent A7 test) | `f80a0f0..d6e8d7e` | "Phase 8: step 24, the library lock's judge counted its own delay" |
| 25 | The runner, `delegate_to_codex`, the per-round record and the Settings card, over a fake Codex | `4847a7f..75effd8` | "Phase 8: step 25, the Codex runner, `delegate_to_codex` and Settings" |
| 26 | Real check prepared (`scripts/real/check-codex-task.ts`); the user ran it: all PASS | `ae68fbe..a422c7d` | "Phase 8: step 26, real check prepared" |
| 27 | Codex calls, tokens and cancel on the task page | `c515bcd..5f0aad3` | "Phase 8: step 27, Codex calls on the task page" |
| 28 | Codex's own token count first; real cancel check prepared (`scripts/real/check-codex-cancel.ts`); the user ran it: all PASS | `99b06ac..6b4e5d1` | "Phase 8: step 28, Codex's token count and the real cancel check" |

---

Status as approved: **approved in outline; details open to change as step
19 shows what is real.** Source: IDEAS.md §5 (c) and the recon of
2026-11-07 (official Codex docs seen only as search snippets; third-party
blogs for the Windows sandbox; see "Unverified").

## Goal

While working on a task, Claude decides on its own whether to hand a piece of the code writing to Codex, and both build the result. The diff, the declared checks and the user's approval stay the control.

## Decisions by the user (2026-11-07)

1. **Login:** the user's own ChatGPT login (plan usage, no API key). briefstack never reads, copies or stores `~/.codex/auth.json`; it only asks `codex login status`.
2. **Surface (path A):** briefstack's own tool that runs `codex exec`; **not** the official plugin (a plugin is a foreign invocable and breaks the task's skill layers, check 5 of M9).
3. **When:** at any moment, Claude decides (mostly for writing code). No click per task.
4. **Windows sandbox:** Settings offers the options. Default: require `elevated` (it only adds isolation and removes no feature). A second option lets the user accept `unelevated` with a plain warning that network blocking is weaker. If neither is available, the tool is absent and the reason is shown. *(Changed in step 25: see the Status.)*
5. **Scope:** tasks first; generation later with its own brief (approved).
6. **Global switch:** off by default, no click per task once on (approved).

## Design (conservative defaults; each one is open to change)

- **Global switch, off by default.** Settings page: status (Codex installed? logged in? which sandbox is ready?), the sandbox option (see 4) and one switch. Only when on and all three are true does a task session get the tool. Otherwise the tool is absent, with the reason shown.
- **Tool `delegate_to_codex`**, in-process like the other briefstack tools, **task sessions only**. It runs `codex exec --json --sandbox workspace-write` with `cwd` = the task's worktree. We build the arguments; Claude passes only the instruction text. Never `danger-full-access`, never `--yolo`, no extra flags from Claude.
- **Boundary:** Codex's sandbox is the write boundary (the guard does not see Codex's writes). The diff of the worktree is the same whoever wrote it, so every existing validation runs on it: secrets, absolute paths, S10 warnings, the unchanged S8 (**checks only run on click, after the diff**).
- **Output is data:** Codex's final message and events are shown and summarized, never executed as instructions; secrets are masked as in the rest of the page.
- **Process:** environment cleaned (no tokens of ours), timeout, process-tree kill on stop, cancel and server shutdown (reuse `killProcessTree`); **cap of Codex calls per round** (default proposed: 3; *5 since step 25*).
- **Usage visible:** tokens from `turn.completed` shown per call on the proposal page. There is no readable plan quota, so we warn instead of metering.
- **Fakes in CI:** a fake `codex` executable for Linux, macOS and Windows; **no real Codex call in CI.**

## Steps as planned on 2026-11-08 (see the Status for how they were done)

- **19 — Spike on the real machine (done 2026-11-07).** Results in `decisions.md`, "Phase 8: Codex spike". Findings: the worktree's `.git` is protected (no add, commit, tag, ref changes); writes outside the worktree are blocked; **reads outside it and 127.0.0.1 are open in both modes**; `elevated` cannot run Node installed under the user's profile (nvm); `unelevated` runs as the user.
- **20 — Second spike (done):** the sandbox does not isolate the user's profile (readable in both modes) nor 127.0.0.1; `DENY` profiles exist only in `elevated` and change real ACLs (not used).
- **21 — Internet control (done, 3 attempts):** measured with `codex sandbox -P :workspace`, **both Windows modes reach the Internet** (TCP, plain HTTP and HTTPS with Node's own TLS). The user's condition ("`elevated` does not send traffic out") is **not met**.
- **22 — Can the network be closed on Windows?** Read the Codex firewall rules and measure `codex exec` with the product's policy and with `network_access=false`. Then the user decides: close it, isolate from outside, accept with a strong warning, or postpone Codex on Windows.
- **23 — Runner and tool** (fake codex, unit and e2e), settings status, sandbox option and switch. **Only if 22 allows it.**
- **24 — Proposal page:** Codex calls, tokens, cancel; `docs/api.md`, `decisions.md`.
- **25 — Real check M9-style on Windows**, then review and close.
- **Later — generation:** same tool in the creation flow (its guard differs; separate brief).

## Out of scope

Codex writing without the sandbox; API-key mode; the official plugin; unattended runs (IDEAS.md §6); macOS and Linux sandboxes beyond what CI covers (Linux needs bubblewrap; unverified).

## Unverified (must be shown in step 19, not assumed)

`elevated` setup and its admin prompt on the user's PC; whether the sandbox protects the worktree's `.git`; headless behavior of the ChatGPT login in `codex exec`; paths on a drive other than the system's; third-party claim of an `mxc` sandbox mode; the exact meaning of the docs' recommendation of API keys for programmatic use.
