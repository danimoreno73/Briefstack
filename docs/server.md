# briefstack on a server

briefstack normally runs on your own computer: `briefstack web` listens on
127.0.0.1 and prints an address with a token that changes at every start.
Server mode lets it run on a machine of yours that stays on (a home server),
inside a container, reached from your computer and your phone through
[Tailscale](https://tailscale.com/), so builds go on day and night with your
computer off. Builds can also go on with a **reserve provider** when the Claude
plan's usage runs low.

This guide says what the container needs, which hosts it must reach, how to
start briefstack in server mode, which files it uses, an example compose file,
and what each credential risks and how to revoke it. briefstack does not ship
your environment: the image, the firewall or proxy, Tailscale and the keys are
yours to set up.

Sources and dates of what is said about Claude Code are in
[decisions.md](decisions.md), "Phase 12: H0" and "Phase 12: H0, the real
container".

## 1. What the container needs

- **Node.js 24** or later, **git 2.40** or later, and **Claude Code** with the
  same major and minor version as the pinned Agent SDK's `claudeCodeVersion`
  (Settings and `briefstack web`'s start say whether yours fits). Turn Claude
  Code's own updates off (`DISABLE_AUTOUPDATER=1`): the image decides the
  version.
- **briefstack**: a clone of this repository with `npm ci` (which also builds
  it). It may live in a folder the container cannot write (for example
  `/opt/briefstack`, owned by root); see §6.
- **A home volume** for the service user: `BRIEFSTACK_HOME` (the briefstack
  folder), the projects folder, `~/.claude` (Claude Code's sign-in and its
  project data) and npm's cache. Everything briefstack writes at run time is
  there or in the system's temp folder.
- **A non-root user**, all capabilities dropped, `no-new-privileges`, no Docker
  socket, memory and CPU limits: briefstack needs none of what they take away.
- **Sign Claude Code in once, without a browser in the container**
  ([authentication](https://code.claude.com/docs/en/authentication#log-in-to-claude-code)):
  either run `claude` in the container, type `/login`, press `c` to copy the
  sign-in address, open it in a browser on another device and paste the code
  back; or run `claude setup-token` on a machine with a browser and give the
  container the one-year token it prints as `CLAUDE_CODE_OAUTH_TOKEN`
  (briefstack passes that variable to its sessions). Builds read the Claude
  plan's usage; whether that reading works with a `setup-token` token is not
  documented, and neither real check below reads it (a reading costs a
  session). The first build shows it: a reading that fails pauses the build
  ("the plan usage could not be read") and tries again later; a `/login`
  sign-in avoids the question.
- **No compilers, no Python?** Fine for briefstack. A project whose
  dependencies build native modules (`node-gyp`) or need Python fails its
  `npm ci` in a build round. To build such projects, add the packages to the
  image (on Debian or Ubuntu: `apt-get install -y build-essential python3`) and
  rebuild it.

## 2. Outbound hosts

Give the container exact host names, not wildcards. From Claude Code's
[network access requirements](https://code.claude.com/docs/en/network-config#network-access-requirements)
and briefstack's own code:

| Host | Why | When |
|---|---|---|
| `api.anthropic.com` | Claude's API: every session, WebFetch's safety check, feature flags | always |
| `platform.claude.com` | OAuth token exchange, refresh and revocation | always, with a subscription sign-in |
| `claude.ai`, `claude.com` | the browser sign-in | only while signing in (the browser is on another device) |
| `registry.npmjs.org` | the projects' approved `npm ci` / `npm install` | when a build's commands install |
| `api.github.com`, `raw.githubusercontent.com` | the third-party skills library | only to add a skill from GitHub |
| `github.com`, `codeload.github.com` | git dependencies of a project | only if a project's own commands fetch them |
| `api.deepseek.com` | the DeepSeek reserve provider | only if configured |
| `api.moonshot.ai` | the Kimi reserve provider | only if configured |

Not needed with Claude Code's updates and nonessential traffic off
(`DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which
briefstack passes to its sessions): `downloads.claude.ai`,
`storage.googleapis.com`, and the Datadog hosts. Never used by briefstack:
`mcp-proxy.anthropic.com`, `sso.claude.com`, and the desktop and artifact
hosts. Builds never push: no GitHub write access is needed.

**Through a proxy.** If the container goes out only through an HTTP proxy,
set `HTTPS_PROXY`, `HTTP_PROXY` (and their lowercase forms) and
`NODE_USE_ENV_PROXY=1`. briefstack passes the proxy variables to Claude Code
sessions, so the sessions, the commands a build round runs and a reserve
provider's sessions go out through it; briefstack's own requests (the skills
library, a provider's status check) follow it with `NODE_USE_ENV_PROXY=1`. A
build's checks run with their proxies pointed nowhere, on purpose: no network.
Node does not leave loopback out of the proxy by itself: set
`NO_PROXY=127.0.0.1,localhost` (and `no_proxy`) so that whatever calls the
server inside the container reaches it directly. The real checks do not
depend on it: their calls to the server use an agent of their own, which
never goes through the proxy.

## 3. Starting briefstack in server mode

```sh
briefstack web --port 4870 --server \
  --listen 0.0.0.0 \
  --allowed-hosts <your-server>.<your-tailnet>.ts.net:<port> \
  --access-secret-file /home/<user>/secrets/briefstack-access
```

- `--server` turns server mode on. Without it, briefstack runs exactly as on
  your computer (127.0.0.1, a token per start), and the three options below
  are a usage error.
- `--listen <address>`: an IP address; `0.0.0.0` inside a container (the host
  publishes the port on its own 127.0.0.1 only, §5). Default `127.0.0.1`.
- `--allowed-hosts <name:port,...>`: the names the browser will use, with the
  port it uses, separated by commas: with `tailscale serve --https=8445`,
  `<your-server>.<your-tailnet>.ts.net:8445`. No scheme, path or wildcard. The
  page must be opened at one of these names over HTTPS (Tailscale serves HTTPS);
  any other `Host` is refused. The loopback names on the listening port stay
  accepted, for checks run inside the container.
- `--access-secret-file <path>`: a file holding the access secret, at least 32
  characters on one line. Make one with, for example,
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > secret`
  and `chmod 600 secret`. The secret is read once at start and kept only as a
  digest; it is never taken from the command line, the environment or the
  page, and never logged. A file readable by other users prints a warning.

At start, server mode prints a warning with the address and the names, then
the address to open. It prints **no token and no secret**, so the container's
log holds neither. Codex is off in server mode.

**Signing in.** Open `https://<your-server>.<your-tailnet>.ts.net:<port>/` on
each device and type the access secret once. The device gets a session cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`) that lasts 400 days from that
sign-in (it is not renewed by use): then sign in again. A device unused for
400 days is also forgotten by the server. After 5 wrong secrets in 15 minutes, signing in is locked for
15 minutes for everybody, the right secret included. Settings lists the
signed-in devices: sign one out, or sign out every device.

## 4. Files and settings

Everything below is under `BRIEFSTACK_HOME` (`~/.briefstack` by default).

- `config.json`: briefstack's settings. The ones for a server:
  - `buildsAutoResume` (`true` or `false`, default `false`; also in Settings):
    a build that a restart of the server interrupted resumes by itself when
    the server starts again (one paused for usage keeps waiting for its reset;
    one that kept dying is left interrupted after 3 starts in a row without a
    card ending). A creation in progress is still left interrupted.
  - `buildSlotsCap` (1 to 4, default 4; also in Settings): the most cards a
    build may run at once on this machine, whatever its start page asked.
  - `reserveProviders`: §7. Written by hand only; the page shows it and never
    changes it.
- `server/sessions.json`: the signed-in devices, as digests of their session
  tokens (never the tokens), with a label, the sign-in time and the last use.
  Owner-only (`0600`). The server keeps the list in memory: to sign every
  device out, use **Sign out every device** in Settings (deleting the file
  counts only after a restart).
- `tasks/`, `builds/`, `sessions/`, `library/`: as on a computer.

## 5. An example compose file

This publishes the port only on the host's 127.0.0.1; `tailscale serve`, on
the host, brings it to your tailnet over HTTPS. Adapt the names, the paths and
the image to yours.

```yaml
services:
  briefstack:
    image: <your-image-with-node-git-claude-code-and-briefstack>
    user: "1000:1000"
    command:
      - node
      - /opt/briefstack/dist/cli.js
      - web
      - --port
      - "4870"
      - --server
      - --listen
      - 0.0.0.0
      - --allowed-hosts
      - <your-server>.<your-tailnet>.ts.net:<port>
      - --access-secret-file
      - /home/briefstack/secrets/briefstack-access
    environment:
      HOME: /home/briefstack
      BRIEFSTACK_HOME: /home/briefstack/.briefstack
      DISABLE_AUTOUPDATER: "1"
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      # With an outbound proxy:
      # HTTPS_PROXY: http://<proxy>:<port>
      # HTTP_PROXY: http://<proxy>:<port>
      # NODE_USE_ENV_PROXY: "1"
      # NO_PROXY: 127.0.0.1,localhost
    ports:
      - "127.0.0.1:4870:4870"
    volumes:
      - briefstack-home:/home/briefstack
    read_only: true
    tmpfs:
      - /tmp:exec,size=2g
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 6g
    cpus: 4
    pids_limit: 2048
    restart: unless-stopped

volumes:
  briefstack-home:
```

On the host: `tailscale serve --bg --https=<port> http://127.0.0.1:4870`. Do
not use Tailscale Funnel: nothing should be open to the Internet.

A new named volume mounted at `/home/briefstack` takes the owner of that
folder in the image: create it in the image owned by the service user
(`1000:1000` here), or the service user cannot write its home.

## 6. A read-only app folder

When the briefstack folder cannot be written (the image's clone owned by
root):

- **The usage profile** cannot be changed from the page or with
  `briefstack usage set`: both write the flow agents' files in that folder, and
  give a clear error. Choose the profile when the image is built
  (`briefstack usage set <profile>` in the image's build). The profile the
  image chose is recorded in the home's `config.json` only if the home exists
  at build time; otherwise the page shows the agents' own settings.
- **Improvements** (which change briefstack's own files) need a writable
  clone, and give a clear error otherwise.
- Creations, tasks and builds are unaffected: they write the home and the
  projects folder.

## 7. Reserve providers

A build can go on with an Anthropic-compatible provider when the Claude plan's
usage is over the build's threshold. Configure them in `config.json`:

```json
{
  "reserveProviders": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "model": "deepseek-v4-pro",
      "smallModel": "deepseek-flash",
      "keyFile": "/home/briefstack/secrets/deepseek.key",
      "note": "Billed per use; data handled under DeepSeek's terms."
    },
    {
      "name": "kimi",
      "baseUrl": "https://api.moonshot.ai/anthropic",
      "model": "kimi-k3",
      "keyFile": "/home/briefstack/secrets/kimi.key"
    }
  ]
}
```

- `name`: lowercase letters, digits and `-`, unique. `baseUrl`: `https://`
  only. `model`: the model a round uses (and the opus, sonnet and fable
  aliases); `smallModel`: the haiku alias and subagents (default `model`).
  `keyFile`: an absolute path to a file holding the key on one line. No other
  field: a `key` field makes the config invalid, on purpose.
- The model names and base URLs come from each provider's Claude Code guide
  ([DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/),
  [Kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi.md)); check them
  there, they change.
- briefstack never holds a key: it reads the key file when a round on that
  provider starts and puts the key only in that round's environment, with
  every Anthropic credential taken out. The page and the API show the
  provider's name, address, models and key file path, never the key.
- Settings lists the providers with a **Check** button: whether the key file
  exists and is not empty (by its size; it is not read) and whether the
  address answers a request sent without any key. The key itself is "not
  checked": neither provider documents a call without cost.
- On a build's start page, "At the usage threshold" chooses **pause** (the
  default) or **go on with a provider**. While the plan is over a threshold,
  the cards that start run on the provider; below it, on Claude again. A card
  keeps its provider for all its rounds. A failed usage reading still pauses. A
  provider whose key file is missing at that moment pauses the build, saying so.
  The planner, creations and ordinary tasks always use Claude.
- A provider's round runs in Claude Code's `default` permission mode (auto
  mode needs a Claude model): briefstack's task guard and the build's exact
  list of commands decide every call, as always. The build's page shows which
  provider each card ran on, next to its tokens.
- **A provider is paid per use and sees the code, the prompts and the command
  output of the cards it runs.** Set a spending cap in its console.

## 8. Credentials: what each risks and how to revoke it

Inside the container, the sessions briefstack starts can read what the service
user can read; the outbound allowlist and the providers' spending caps are the
protection, not the file layout.

| Credential | Where | What it allows | Revoke |
|---|---|---|---|
| Claude Code sign-in (`/login`) | `~/.claude` in the home volume | model requests on your Claude plan, as your account | claude.ai, Settings, sign out of the session or of all devices; then sign in again in the container |
| `CLAUDE_CODE_OAUTH_TOKEN` (`setup-token`) | the container's environment | model requests on your plan for a year | claude.ai, Settings, revoke the token |
| A reserve provider's key | its key file | paid requests to that provider, up to its cap | the provider's console: delete the key; make a new one and replace the file |
| The access secret | its file | signing a new device in to briefstack | replace the file's content, restart, then **Sign out every device** in Settings (changing the secret does not end existing sessions) |
| A device session | the browser's cookie | using briefstack from that browser | Settings, Signed-in devices: sign it out (its open pages stop at once) |
| Tailscale | the host | reaching the host's published port | the Tailscale admin console |

## 9. Checking it for real

Two checks, prepared in `scripts/real/` and run by you **inside the
container**, after the server is up:

- `npx tsx scripts/real/check-server-access.ts --yes ...` signs in, checks the
  cookie, the refusals and the devices, opens a stream and ends it by
  revoking its own device, and signs out. It uses no model. Run it with
  `--url https://<your-server>.<your-tailnet>.ts.net:<port>` where that name
  reaches the server, so the requests go through `tailscale serve` as a
  phone's do.
- `npx tsx scripts/real/check-build-reserve.ts --yes ...` runs a short build in
  a temp home whose cards go on with a reserve provider at a forced threshold.
  It spends a little of that provider's credit and no Claude session.

Each script's header says what it needs, what it checks and what it spends.
