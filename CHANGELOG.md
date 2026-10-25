# Changelog

## 1.0.0 — 2026-10-25

First public release. briefstack was built in phases; the brief, plan and
decisions of each are in [`docs/`](docs/).

### Creator and library (phase 1)

- The `/new-project` flow in Claude Code: a main session and five agents
  (interviewer, researcher, architect, generator, reviewer) that turn an
  idea into a spec the user approves, then a project folder for Claude
  Code or the Claude app.
- The `briefstack` CLI: `init`, `library`, `paths`, `spec check`,
  `scaffold`, `validate`, `usage`, `commit`, `event`.
- Base templates (software, learning or management, generic), base skills
  and the rule that picks the target.
- The personal library: Markdown notes, kept as a git repository, with a
  secret check on every write.
- Usage profiles (saver, balanced, max) for each agent's model and effort.

### Local web app (phase 2)

- `briefstack web`: a server on 127.0.0.1 with a launch token, running
  creations through the Agent SDK with the user's own Claude Code.
- A guard on every session: writes only inside the projects folder, the
  session folder and folders granted for one creation; permission
  requests asked to the user or denied in unattended mode.
- Projects, sessions, the library editor with its history, settings.

### Live agent panel (phase 3)

- A live view of every agent of a creation: status, tool in use, model
  and effort, timeline, denied calls, and plan usage at the start and now.

### Chat and several creations (phase 4)

- A global chat about projects, the library, creations and usage, with no
  file or shell tools; every change it proposes is a card to confirm.
- Several creations at the same time, with a limit set in Settings.

### Self-improvement (phase 5)

- Proposals to improve the creation flow's own agents, skill and
  templates, prepared in a separate worktree, checked, tested and safety
  reviewed, applied as one commit only after approval, and revertible.
- Suggestions after a creation, from what went wrong in it.

### Interface (UI pass)

- A new design in light and dark themes, at desktop and phone widths, in
  English and Spanish.

### Skills library (phase 6)

- Third-party skills from public GitHub links: pinned to a commit,
  fetched into quarantine, reviewed by static checks and a short model
  review, never executed; installed into projects only when approved, and
  checked against their hashes.
- A plan-usage warning before expensive actions, archived projects, and
  discarded suggestions.

### Release

- briefstack runs with whatever the user set up for their own Claude
  Code: a Claude plan, their own API key, or a cloud provider. The web
  app and the CLI say which one is in use, and what to do when Claude
  Code is missing, too old or not signed in. Plan usage is shown only
  with a plan.
- `npm install` builds the app, so `npx briefstack` works from a clone.
- Dependencies updated for the security advisories `npm audit` reported:
  markdown-it 15.0.3, and body-parser 2.4.0 and fast-uri 3.1.9 through the
  Agent SDK.
- The CI runs on Linux and Windows.
- README, license (MIT), security policy, contributing guide and this
  changelog.
