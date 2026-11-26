# briefstack — Phase 12 brief: briefstack in a container on the user's home server, with reserve model providers

> `v1.3.0` is prepared and phase 11 is done. This file is the source of truth
> for phase 12. If something here conflicts with a later instruction in chat,
> follow the most conservative reading and record it in `docs/decisions.md`.
> Approved by the user on 2026-11-26, including working **unattended**: H0,
> the plan and the milestones go ahead without a stop for approval unless a
> stop condition in §8 is met.

## 1. What phase 12 is

briefstack runs on the user's Windows PC, listening on 127.0.0.1 with a token
that changes at every start. The user wants it on his home server (Ubuntu,
Ryzen 5 3600, 16 GB) so that builds run day and night with the PC off, and
to use it from the PC and the phone. The server's environment is prepared
apart (another conversation): a **hardened Docker container**. Phase 12
makes briefstack work well **inside that container**, reached through
**Tailscale**, and lets builds go on with **reserve model providers** when
the Claude plan's usage runs low.

## 2. Decisions confirmed by the user (2026-11-26)

1. **A hardened Docker container**, prepared outside briefstack: a non-root
   user inside, all capabilities dropped, `no-new-privileges`, no Docker
   socket, one volume of its own (nothing of the user's home or game
   storage mounted), RAM and CPU limits with low priority, outbound traffic
   only to an allowlist (Anthropic and what Claude Code needs, the reserve
   providers, the npm registry, GitHub) and the LAN, the tailnet and the
   host blocked. `restart: unless-stopped` in its compose file (no systemd
   unit).
2. **Access through Tailscale**, with `tailscale serve` on a port of its own
   (for example 8445) towards the container's port, which the host publishes
   on its 127.0.0.1 only. No Funnel, nothing open to the Internet.
3. **Credentials:** keys used only by briefstack, each with a spending cap in
   its provider's console, and a known way to revoke each one (the Claude
   Code session included). Inside the container the agents can read what the
   service user can read; the allowlist and the caps are the protection,
   not the file layout.

Defaults chosen by the advisor, open to change in the plan (record each in
`decisions.md`):

4. **Server mode, explicit:** a start option (flag or environment variable)
   lets briefstack listen on an address other than 127.0.0.1 (`0.0.0.0`
   inside the container) only when it is set, with a startup warning; the
   default stays 127.0.0.1. A configured list of **allowed host names**
   (the tailnet name and port) extends the host and origin checks; nothing
   else is accepted.
5. **Sign in once per device:** in server mode the per-start token in the
   URL is replaced by a stable **access secret** read from a file (never
   from the command line, never logged), exchanged once per device for a
   session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`), with a list of
   signed-in devices, sign-out and revoke-all, and a limit on failed
   attempts. Mutating calls keep the same-origin check. Local mode is
   unchanged.
6. **Pages usable on a phone:** projects, a creation's interview and spec
   checkpoint, the build's board and page, and Settings readable and usable
   on a narrow screen. No new app; the same pages.
7. **Builds resume by themselves after a restart** when a setting is on
   (off by default; the container turns it on). A creation in progress is
   still left interrupted.
8. **Reserve providers:** providers with an Anthropic-compatible endpoint
   (DeepSeek and Kimi first) configured by name, base URL, model names and
   the path of a key file; keys are never stored by briefstack, never shown,
   never sent to the page, and passed only to the session that uses that
   provider. In a build, a start setting chooses **what happens at the usage
   threshold: pause (today) or go on with a reserve provider**; the planner,
   the creation and ordinary tasks stay on Claude. The build's page shows
   which provider each card used and its tokens; the start page warns that a
   reserve provider is paid per use and where its data goes.
9. **A cap on slots** in Settings (the container sets 2 or 3), under the
   build's own 1 to 4.
10. **Codex stays off in the server** (its Linux sandbox was never
    measured); nothing changes for Codex on Windows.
11. **A server guide** in `docs/server.md`: what the container needs
    (Node, git, Claude Code and its sign-in in text mode), the outbound
    domains briefstack and Claude Code need (from official documentation,
    cited), the environment variables and files, an example compose file
    that publishes only on the host's 127.0.0.1, and what each credential
    risks and how to revoke it. briefstack never ships the user's own
    environment.

## 3. Features

- Server mode (address, allowed hosts, warning), access secret and device
  sessions, phone-friendly pages, auto-resume setting, slot cap.
- Reserve providers: configuration, a status check that reads no key into
  the page (does the key file exist, is the endpoint reachable with a no-cost
  call if one exists, or else "not checked"), the build's choice at the
  threshold, and per-card provider and tokens.
- `docs/server.md`, README, `docs/api.md`, CHANGELOG «Unreleased».

## 4. Security

- Local mode keeps today's model exactly (127.0.0.1, per-start token).
- Server mode never listens beyond 127.0.0.1 without the explicit option;
  the host and origin checks accept only the configured names; the access
  secret and session cookies are never logged, never in URLs, and compared
  in constant time; failed sign-ins are limited; sessions can be revoked.
- Reserve providers' keys live in files the user controls; briefstack reads
  them at use and passes each only to its provider's session environment;
  the page and the API never return them. A reserve provider sees the code
  and prompts of the cards it runs: the start page says so.
- Builds' model (exact list, no dialog, integration branch, final apply) is
  unchanged whatever the provider.

## 5. Verification — definition of done

- Unit tests: server mode off by default; listening address and allowed
  hosts; host and origin rejections; the access secret (file read, constant
  time, attempt limit), sessions (cookie flags, revoke, sign-out); keys never
  in any API response or log line; the provider chosen per card and its
  environment; the threshold choice (pause or reserve); auto-resume on and
  off; the slot cap.
- e2e over the fakes: sign in once and stay signed in; a build that goes on
  with a fake reserve provider at the threshold; the board on a phone-sized
  viewport.
- Build, lint, unit and e2e pass; CI green on Linux, Windows and macOS.
- **Real checks** in `scripts/real/`, prepared by Claude Code and run only by
  the user **inside the container on the server**: (a) server mode reached
  through the tailnet name, sign-in, revoke (no model); (b) a short build
  whose cards go on with a reserve provider at a forced threshold (spends a
  little of that provider's credit).
- Phase 12 is not done before the user runs the real checks and accepts them.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.

1. Where the server binds and checks host, origin and token today, and the
   smallest change for server mode without touching local mode.
2. The outbound domains Claude Code needs (official documentation, cited)
   and how its sign-in works without a browser on Linux.
3. How a task session's environment is built today (`cleanEnvironment`) and
   how to give one session a provider's base URL, models and key without
   leaking them to others; what the SDK's usage reading returns with a
   non-Anthropic endpoint (probably nothing: the threshold then reads only
   Claude's own plan).
4. The pages that break on a narrow screen.
5. What a build needs to resume by itself after a restart safely.

## 7. Out of scope

Building the container or the server's firewall (done outside briefstack);
Telegram; local models; Codex on Linux; several users; pushing to GitHub.

## 8. Working rules

- Tag `phase-12-start` before the first change (if refused, record it and go
  on; the user creates it).
- `docs/PLAN-phase-12.md` with milestones and a Status section kept current.
- H0, then the plan, then the milestones, without a stop for approval,
  unless: an H0 item makes a §2 decision impossible or unsafe; the work
  needs a change to the tasks' guard, S8 for ordinary tasks, phase 9's
  security model, or local mode's security; any security doubt.
- Small commits, one concern each, **gates green before each commit, commit
  by commit**, CI checked after each push, **no commit of a milestone
  before the previous one's CI is green**.
- Write and edit files only with the Write and Edit tools.
- No real Claude, Codex or provider sessions; no real key read.
