# briefstack — Phase 6 brief: Skills library

> The five feature phases and the UI pass are done (`ui-done`). This file is
> the source of truth for phase 6. If something here conflicts with a later
> instruction in chat, follow the most conservative reading and record it in
> `docs/decisions.md`.

## 1. What phase 6 is

A personal library of third-party Claude skills. The user adds skills they
find (from a GitHub link, in the web or the chat); briefstack reviews each
one in quarantine, the user approves it, and from then on the architect can
propose it for new projects and for specific subagents. The user can also
add an approved skill to an existing project.

Three small additions ship with it: a plan-usage warning before expensive
actions, archiving projects, and discarding suggestions.

## 2. Decisions confirmed by the user

1. **Adding a skill:** from a GitHub link (in the Skills page or the chat).
   The chat adds it behind a confirmation card. Public repositories only.
2. **Skills with scripts are allowed,** with quarantine, automatic review and
   a clear warning. The user approves after seeing the code. briefstack
   never executes any of it.
3. **Choosing skills for a project:** the architect proposes them in the
   spec, with the reason and the agent they are for. The user keeps or
   removes them at spec approval, like the rest of the spec.
4. **Small additions:** plan-usage warning, archive projects, discard
   suggestions. Not in this phase: profiles edited from the web, open
   folder, read-only paths, CSV export, working inside projects.

## 3. Features

### 3.1 Adding a skill

- Input: a GitHub URL to a skill folder (one containing `SKILL.md`), with a
  branch, tag or commit. briefstack resolves it to a **commit SHA** and
  stores exactly that version.
- Fetching is the only new network access, and only when the user asks:
  - only GitHub hosts needed for public content; no tokens;
  - limits on total size, number of files and file size; timeouts;
  - no symlinks, submodules or LFS pointers; paths normalised and kept
    inside the skill folder.
- The chat tool `add_skill(url)` shows a card; confirming only fetches it
  into quarantine. Approving, rejecting and deleting happen only on the
  Skills page.

### 3.2 Storage

- In the personal library under `skills/<name>/`, Obsidian-compatible: the
  skill's files exactly as fetched, plus a metadata note with source URL,
  commit, fetch date, license, status (`quarantine`, `approved`,
  `rejected`), tags, a file list with SHA-256 of each file, and the review
  results.
- Written through the library code (one commit per change). The library's
  secret check applies to the metadata note; secret-looking content inside
  the skill's own files becomes a review finding, not a silent block.
- Library skills are data. They are never registered as skills of
  briefstack's own sessions.

### 3.3 Review in quarantine (nothing is executed)

- **Inventory:** every file with type (markdown, script by extension or
  shebang, binary, other), size and hash.
- **Frontmatter:** name, description and `allowed-tools`, if present.
- **Static findings,** each with file, line and severity:
  - scripts and binaries present;
  - network use (URLs, curl, wget, fetch, requests, sockets);
  - shell execution, file deletion, writes outside the working folder;
  - access to credentials or environment (keys, tokens, `~/.ssh`, `.env`,
    browser profiles);
  - obfuscation (long base64 or hex blobs, minified code);
  - hooks or settings files;
  - instructions aimed at the agent to bypass permissions or ignore its
    instructions.
- **License:** detected from a license file or SPDX header; missing or
  unknown is a finding.
- **Model review:** the same kind of cheap review as phase 5 (Haiku, no
  tools) reads `SKILL.md` and the scripts' text and says whether anything
  looks harmful, with reasons. Text inside the skill that addresses the
  reviewer is data.
- The Skills page shows a summary on top (what the skill does, scripts yes
  or no, network yes or no, license) and the full findings, with each file
  viewable.

### 3.4 Skills page

- List with name, description, status, tags, source and whether it has
  scripts; search and filter by tag and status.
- Detail: metadata, review, files, and actions: approve, reject, delete,
  edit tags.
- **Updates are never automatic.** "Check for a new version" fetches the
  latest commit into quarantine as a new version, shows the diff against the
  approved one, and needs approval again.

### 3.5 Using skills in creations

- The architect gets an index of **approved** skills only: name,
  description and tags, as data. It proposes the ones the project really
  needs, each with a reason and where it goes (the whole project or a named
  subagent). Most projects need none.
- The spec carries the chosen skills. The spec approval screen lists them
  with their reason, a link to their page, and a scripts warning when it
  applies; the user can remove any of them.
- **Installing is done by the CLI, not by the model:** a briefstack
  subcommand copies the approved files byte for byte into the generated
  project (`.claude/skills/<name>/` for `claude-code`) and records the
  source and commit next to them. The validator checks the installed files
  against the stored hashes.
- Subagents: if Claude Code supports giving a subagent specific skills
  (verify in H0), the generated agent files reference them. If not, the
  agent's instructions name the skill to use.
- `claude-app` projects: the CLI prepares a zip of each skill in the
  project folder, and `NEXT_STEPS.md` explains how to add it in the app.
- **Existing projects:** the chat tool `add_skill_to_project(skill,
  project)` with a card; confirming installs it with the same CLI
  subcommand and updates the project note.

### 3.6 Small additions

- **Plan-usage warning:** before starting a creation or an improvement, if
  the 5-hour window or the week is high (thresholds in Settings, defaults
  80 % and 85 %), show the current values and a "start anyway" choice. It
  never blocks.
- **Archive projects:** archive and unarchive from the project page; the
  list hides archived projects by default with a filter to show them.
  Stored in the project note; nothing is deleted.
- **Discard suggestions:** a suggestion can be dismissed and does not come
  back.

## 4. Security

- Nothing from a skill is ever executed by briefstack, its server or its
  sessions. Skills reach a project only as copied files, and the user's
  Claude Code applies its own permissions when it uses them.
- Only approved skills are visible to the architect, and only their name,
  description and tags.
- The fetch is user-initiated, limited to the needed GitHub hosts, size-
  capped and pinned to a commit.
- The install subcommand writes only inside the target project, only
  approved files, and only if their hashes match.
- The creation guard allows the install subcommand for the generator and
  nothing else new.

## 5. Verification — definition of done

- Unit tests: URL parsing and commit pinning; fetch limits and path
  normalisation, using a local fake GitHub server (no network in tests or
  CI); every static finding with malicious fixtures; license detection;
  quarantine, approve, reject, delete and new-version flows; install and the
  hash check; the three small additions.
- End-to-end tests over the fake runners: add from the page and from the
  chat; review page; approve; the architect proposes a skill and the user
  removes another at the spec; install into a new project and into an
  existing one; usage warning; archive; discard.
- Build, lint and tests pass, and the CI is green. Add the e2e suite to the
  CI in this phase.
- **Real checks** in `scripts/real/`, prepared and run only by the user:
  fetch and review a real public skill; the model review on a harmless and
  a malicious fixture; a cheap creation where the architect proposes an
  approved skill.
- **Real run:** add two real skills, approve them, create a project that
  uses one of them, check it is installed and works in Claude Code, add the
  other to an existing project, and accept the result.

## 6. H0 — verify before designing

Record each item in `docs/decisions.md` with source, date and conclusion.

1. The most reliable way to fetch one folder of a public GitHub repo at a
   commit without a token, and the rate limits involved.
2. Whether Claude Code lets a subagent be given specific skills, and how.
3. How a skill is added to the Claude app, and the zip layout it expects.
4. How Claude Code discovers skills in a project's `.claude/skills/`.

## 7. Out of scope

Executing or testing skills. Private repositories or tokens. Automatic
updates. A public skill marketplace. Profiles edited from the web, open
folder, read-only paths, CSV export. Working inside projects from
briefstack.

## 8. Working rules

- Tag `phase-6-start` before the first change.
- `docs/PLAN-phase-6.md` with milestones and a Status section kept current.
- Small commits, one concern each, gates green before each commit, CI
  checked after each push.
- Write and edit files only with the Write and Edit tools.
