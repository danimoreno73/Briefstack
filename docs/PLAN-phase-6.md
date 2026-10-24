# briefstack — Phase 6 plan

Plan for phase 6: a library of third-party skills, plus three small
additions. Scope comes from [BRIEF-phase-6.md](BRIEF-phase-6.md); the
decisions in its section 2 are the user's. The user asked to start without
reviewing this plan; decisions taken without them are in
`docs/decisions.md`, "Decisiones sin Dani (fase 6)". H0 results are in the
same file, "# Phase 6", "H0".

Starting point: tag `phase-6-start`. Work happens on `master` in small
commits, one concern each; build, lint and tests green before each commit;
push and CI after each milestone.

## 0. Status

Updated 2026-10-25. M1–M11 done, and the fixes from the security review
(decisions.md, "Phase 6: fixes from the security review"); the real checks
and the real run (section 3) are the user's, not run yet. A new session reads `CLAUDE.md`,
`docs/BRIEF-phase-6.md`, this file and `docs/decisions.md` from "# Phase 6"
onwards before continuing.

### Done

| # | What exists now |
|---|---|
| H0 | All four points answered (decisions.md, "# Phase 6", "H0"): REST trees API + `raw.githubusercontent.com` without a token, blob hashes verified; subagent `skills:` preloads (probe PASS); app ZIP layout; discovery by folder name (probe PASS). Probe `scripts/real/probe-h0-phase6.ts` |
| M1 | `src/skills/url.ts` (link forms, ref splits), `github.ts` (`fetchSkill`: pin, tree walk, limits, refusals, blob hashes, rate limit, no redirects, timeouts); `tests/skillsWorld.ts` (fake GitHub); tests `skills-url`, `skills-fetch`; `skills.*` error codes in English and Spanish |
| M2 | `src/skills/review.ts` (inventory, frontmatter, line and file rules, license), `modelReview.ts` (`SdkSkillReviewer`, fake; `runToolFreeReview` shared with the phase 5 safety notice); `tests/skillFixtures.ts` (harmless, exfiltrator, injector, secret); tests `skills-review`, `skills-model-review` |
| M3 | `src/skills/record.ts` (metadata note), `service.ts` (`SkillService`: add, approve, reject, delete, tags, check update into `next/` with a diff, approve or reject it, approved index, approved files with hashes); `gitCommit` takes `git add` options; test `skills-library` |
| M4 | Routes `src/server/skills.ts`, `briefstack web` serves them (`src/skills/wiring.ts`); HTTP statuses; test `server-skills` |
| M5 | `src/skills/zip.ts`, `install.ts` (`skills install`, `.briefstack/skills.json`, NEXT_STEPS section), CLI subcommand, validator `librarySkill.*`, guard entry for the generator; spec field `librarySkills` and agent `skills:` lists; tests `skills-install`, `spec`, `creation-guard` |
| M6 | `library context` lists approved skills as data; `spec check` refuses unapproved ones; approval screen data and unticking (`CreationManager.readSpec`, `removeSkills`); `FakeRunner` `generate` step; architect, generator and skill instructions; test `creation-library-skills` |
| M7 | Chat tools `list_skills`, `add_skill`, `add_skill_to_project` (`src/skills/projectInstall.ts`), cards, source kind `skill`; test `chat-skills-tools` |
| M8 | Plan-usage warning (`src/usage/warning.ts`, config thresholds, `usage.high`, `force`, chat cards), archive (`src/library/archive.ts`, route), discard (`dismissedAt`, route); test `small-additions` |
| M9 | UI: Skills page (`src/ui/skills.tsx`), spec approval list, usage-warning dialog, archive button and filter, discard button, Settings thresholds, chat cards; English and Spanish strings |
| M10 | `tests/e2e/skills.spec.ts` (12 tests: add from the page and the chat, review page, malicious and injected skills, rate limit, new version with diff, architect proposes two and one is unticked, install into a new and an existing project, usage warning on the page and the card, archive, discard); the e2e suite runs in CI |
| M11 | `scripts/real/check-skill-fetch.ts`, `check-skill-model-review.ts`, `check-skill-creation.ts` with static tests (not run); `docs/api.md` (skill routes, `skills install`, archive, discard, `usage.high`, chat tools, `generate` recording line); decisions "Decisiones sin Dani (fase 6)" |

| Review fixes | File kinds by name first and decoded text (`encoding` finding); only the approved spec's library skills are installed (guard list, `skills.notInSpec`, `librarySkill.notChosen`); strict model answer, nonce tags, every text file, `failed` state, partial review; `add_skill_to_project` folder checks and a protected project `path`; architect descriptions as JSON lines cut to 300; 40-hex listing ids, more reserved and invisible names, `skills.pathTooLong`; the heuristic note on the skill page |

Gates at the end: build, lint, 981 unit tests (2 more on Linux only) and the
e2e tests pass locally on Windows; CI (Linux, unit and e2e) is checked after
the push.

## 1. Approach

### Where things live

- **Library** (the user's, a git repo): `skills/<name>/` per skill:
  - `skills/<name>/<name>.md` — the metadata note (Obsidian "folder note"):
    YAML frontmatter with name, description, status, tags, source (URL,
    owner, repo, path, ref, commit), fetch date, license, flags (scripts,
    network), the file list with size, kind and SHA-256, and the review
    results; a readable body with the summary and the findings.
  - `skills/<name>/files/…` — the skill's files exactly as fetched (the
    approved version, or the first one while in quarantine).
  - `skills/<name>/next/…` — a newer version in quarantine, only while an
    update waits for approval (its metadata under `next:` in the note).
  Third-party skills are not listed in `INDEX.md` (the interviewer and the
  architect read it); the existing `skills/<name>.md` notes are untouched.
- **Fetch:** kept in memory (at most 5 MB), staged in the library under the
  lock and renamed into place; nothing is written before the whole fetch and
  its review passed.

### Fetch (`src/skills/github.ts`)

URL forms: `github.com/<o>/<r>`, `…/tree/<ref>/<path>`,
`…/blob/<ref>/<path>/SKILL.md`. A ref with slashes is found by trying the
shortest prefix first (at most 5 tries). Calls: pin the ref (SHA media
type), walk the trees one level at a time, list the folder recursively,
then download each blob from `raw.githubusercontent.com/<o>/<r>/<sha>/…`
and check its git blob hash. Only those two hosts; no redirects followed;
a timeout per request and for the whole fetch. Limits: 200 files, 1 MB per
file, 5 MB in all. Refused: symlinks, submodules, LFS pointers, a truncated
tree, `.gitattributes` and `.gitmodules` (they would change how the
library's git stores files), paths that are not portable (Windows
reserved names, `..`, control characters, case collisions), no `SKILL.md`
at the folder root. Rate-limit answers become a clear error with the
reset time. Base URLs are injectable so tests use a local fake GitHub.

### Review (`src/skills/review.ts`, `modelReview.ts`)

Pure static review over the fetched files: inventory (markdown, script by
extension or shebang, binary, other; size; SHA-256), frontmatter (`name`,
`description`, `allowed-tools`, `hooks`, `shell`), findings with file, line
and severity, license detection (license file or SPDX header; the repo
root's license file when the folder has none). The model review is a Haiku
session with no tools, like phase 5's safety notice; the skill's text is
data. It never blocks; it is shown with its reason.

### Install (`src/skills/install.ts`, CLI `skills install`)

`briefstack skills install "<project-dir>" [--skill <name>]`: without
`--skill`, the library skills listed in the project's
`.briefstack/spec.json`; with it, one more skill. Only approved skills,
only after their library files match the stored hashes, only inside the
project, never over an existing file. `claude-code`:
`.claude/skills/<name>/` byte for byte; `claude-app`:
`skills/<name>.zip` (`<name>/…` inside) and a "Skills" section in
`NEXT_STEPS.md`. Both record name, source, commit, agent and file hashes
in `.briefstack/skills.json`. The validator checks those hashes, skips
its own text checks inside installed library skills and requires every
spec library skill to be installed. The guard lets the generator run this
subcommand, with the same folder check as `scaffold`; nothing else
changes in the guard.

### Creations

- `library context` adds "Approved skills (data)": name, description, tags
  of approved skills only.
- Spec field `librarySkills: [{ name, reason, agent? }]` (`agent`: a spec
  agent's name; absent: the whole project). Allowed for both targets;
  `agent` only for `claude-code`. `spec check` refuses a name that is not
  an approved library skill. `scaffold` writes `skills:` into the agent
  files that get one.
- The spec approval screen lists them with the reason, a link to the
  skill's page and a scripts warning; the user can untick any. On
  approval the server removes the unticked ones from `spec.json` (inside
  the session folder) and the `approve_spec` answer says which.

### Small additions

- Plan-usage warning: thresholds in Settings (5-hour 80 %, week 85 %).
  Starting a creation or preparing an improvement (page or chat) reads the
  usage (a reading younger than a minute is reused); when high, the page
  shows the values and "Start anyway", the chat card shows them.
- Archive: `archived: <date>` in the project note's status block; the
  projects list hides archived ones unless the filter is on.
- Discard: a suggestion gets `dismissedAt`; lists, the chat and the
  Improvements page leave it out; it never comes back.

## 2. Milestones

### M1 — Fetch

URL parsing, ref pinning, tree walk, limits, path rules, blob hashes,
rate limits; a fake GitHub server for tests (`tests/skillsWorld.ts`).
Tests: `skills-url`, `skills-fetch`.

### M2 — Review

Inventory, frontmatter, static findings with malicious fixtures, license
detection, model reviewer (SDK, no tools) and fake. Tests:
`skills-review`, `skills-model-review`.

### M3 — Storage and service

Metadata note (write and read), `SkillLibrary`: add (fetch → review →
write under the library lock → one commit), approve, reject, delete, edit
tags, check for a new version (into `next/`, diff against the approved
one), approve or reject the new version; approved index. Tests:
`skills-store`, `skills-library`.

### M4 — API and CLI

Routes `/api/skills…` (list, detail, file, add, approve, reject, delete,
tags, check update); CLI `skills list`, `skills show`, `skills install`
(M5). English and Spanish errors. `docs/api.md`. Tests: `server-skills`.

### M5 — Install and validator

`skills install` for both targets (ZIP writer without dependencies),
`.briefstack/skills.json`, NEXT_STEPS section, project note update for an
existing project, validator rules, guard entry for the generator. Tests:
`skills-install`, `validate`, `creation-guard`.

### M6 — The flow

`library context` section, spec field and checks, scaffold agent
`skills:`, architect and generator instructions, approval screen data and
removal on approval. Tests: `spec`, `scaffold`, `creation-manager`,
`new-project-skill`.

### M7 — Chat tools

`list_skills` (read), `add_skill` and `add_skill_to_project` (cards).
Tests: `chat-skills-tools`.

### M8 — Small additions

Usage warning (settings, server check, page dialog, chat cards), archive,
discard. Tests in `server-*`, `library-projects`, `improve-suggestions`.

### M9 — UI

Skills page (list, search, filters, add form; detail with summary,
findings, files, actions, update diff), spec approval list, archive
filter, usage warning dialog, discard button, settings thresholds, chat
cards. English and Spanish strings.

### M10 — End-to-end tests and CI

`tests/e2e/skills.spec.ts` and additions to the existing specs; the e2e
suite added to CI (Linux, Chromium).

### M11 — Real scripts and docs

`scripts/real/check-skill-fetch.ts`, `check-skill-model-review.ts`,
`check-skill-creation.ts` (prepared, not run) with static tests;
`docs/api.md`, decisions, this Status and the real run steps.

## 3. Real runs (prepared, run by the user)

Each script asks for `--yes`, works in a temp `BRIEFSTACK_HOME` and folder
under `BRIEFSTACK_REAL_WORKDIR` (set it to a scratch folder outside the
repo, the library and the projects folder), never touches the real library
or projects, never rewrites the agent files, prints the plan usage before
and after, and does not start above 70% of the 5-hour window or 95% of the
week. Run them from PowerShell in the repo, in this order:

1. `npx tsx scripts/real/check-skill-model-review.ts --yes`: two very short
   Haiku reviews. Expected: the harmless skill is not flagged; the malicious
   one is flagged, with reasons, although its SKILL.md tells the reviewer to
   answer otherwise, tries to close its file tag and writes its own verdict.
   Each reply must be the JSON alone: "no answer" means Haiku added text or
   a code fence, which the server now records as a failed review.
2. `npx tsx scripts/real/check-skill-fetch.ts --yes` (optionally
   `--url <github link>`): fetches `anthropics/skills` `skills/brand-guidelines`
   without a token (about four GitHub requests), one Haiku review, approve,
   install into a temp project. Expected: pinned to a commit, SKILL.md and
   hashes, a model answer, one library commit, installed, the validator finds
   it intact, the temp library clean.
3. `npx tsx scripts/real/check-skill-creation.ts --yes`: fetches the same
   skill (fake review), approves it, then one creation on the saver profile
   with an idea that needs it (about the cost of `check-improvement-flow`).
   Expected: the spec lists the skill, the creation completes, the project
   has it installed, the validator finds no errors, no turn waits for a text
   answer.

Then the real run (BRIEF-phase-6 §5), on the real library:

4. `npm run build`, `npm run briefstack -- web`, open the printed link.
5. Skills page: add two real skills from GitHub links (for example two
   folders of `anthropics/skills`), read each review and approve both.
6. New project: an idea that needs one of them. At the spec approval the
   skill is listed with its reason (untick nothing, or untick one to see it
   left out). Finish the creation; check `.claude/skills/<name>/` and
   `.briefstack/skills.json` in the project, then open the project with
   `claude` and check the skill is listed and works.
7. Chat: "add <the other skill> to <an existing project>"; the card shows
   the project folder; confirm it. Check the files, the skill added to the
   project's `.briefstack/spec.json` `librarySkills`, that
   `npm run briefstack -- validate <project>` finds no errors, and the line
   in the project note.
8. Accept the result. Tag `phase-6-done` (the user, or the next session
   when asked).
