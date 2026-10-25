# briefstack — Release brief: publish the repo

> Phases 1–6 and the UI pass are done. This pass prepares the repository to
> be made public on GitHub, so anyone can clone it and run briefstack on
> their own machine with their own Claude account or API key. If something
> here conflicts with a later instruction in chat, follow the most
> conservative reading and record it in `docs/decisions.md`.

## 1. Decisions confirmed by the user

1. **License:** MIT.
2. **Authentication:** both. briefstack uses whatever the user configured in
   their own Claude Code: their own Claude sign-in or their own API key.
3. **Author email** in the history stays as it is. No history rewrite.
4. **Default branch:** rename `master` to `main`.

## 2. Policy and authentication

Sources (read them again before writing the README, and record the date):
the Agent SDK overview, the Claude Code legal and compliance page, and the
support article "Use the Agent SDK with your Claude plan".

- briefstack never offers a sign-in, never reads, stores or forwards
  credentials or session tokens, and runs the user's unmodified Claude Code
  binary. Verify all three in the code and record where.
- **API key mode:** if the user has `ANTHROPIC_API_KEY` (or a supported
  cloud provider configuration) set for their Claude Code, creations, chat
  and improvements must work with it. Today the environment cleaning may
  strip it: change that so the user's own key passes through, never logged,
  never shown in the UI, never written to any file. Test both modes with
  the fake runner; prepare a cheap real check for API key mode that the user
  runs only if they want.
- The preflight and the Settings page say which mode is in use (sign-in or
  API key), without showing any secret.
- The plan-usage display only makes sense with a subscription. In API key
  mode, hide it and say why.
- **Branding:** the product name is briefstack. No "Claude Code" in the
  product name, logo or ASCII art. The README says plainly that briefstack
  runs Claude Code and is not affiliated with or endorsed by Anthropic.

## 3. Privacy and secrets scan

- Scan the **whole history** (every commit, every branch and tag), not only
  the current tree, for: secrets and tokens, personal paths, email
  addresses other than the author's, personal names other than the
  author's, data from the user's personal library (project names, lessons,
  profile), and machine-specific values.
- Also review every committed image (screenshots, before/after) by looking
  at it, for paths, names or real data.
- Report findings before changing anything. Fix what can be fixed forward.
  If something sensitive is only in old history, stop and explain the
  options; do not rewrite history without the user's approval.
- Confirm that `CLAUDE.local.md`, `.claude/settings.local.json`,
  `screenshots/` and any local tool paths are ignored and never committed.
- Section titles like "Decisions without Dani" may stay; record that the
  author's first name appears in the docs.

## 4. A clean first run for a stranger

- `package.json`: name, version (for example `1.0.0`), description,
  license, repository, engines (Node version), and a `bin` entry so
  `npx briefstack` works from a clone after `npm install`.
- From a fresh clone in an empty temporary folder, with an empty
  `BRIEFSTACK_HOME`: install, build, `briefstack init`, `briefstack web`,
  and the fake-runner e2e suite. Fix anything that assumes this machine.
- First-run experience: if Claude Code is missing, too old, or not signed in
  and no API key is set, the CLI and the web say exactly what to do.
- The base library templates and rules are generic, with nothing about this
  user.
- **CI:** add `windows-latest` (and `macos-latest` if time allows) to the
  matrix with build, lint, unit and e2e, since Windows is a primary
  platform.

## 5. Documentation

- `README.md` (English): what briefstack is, a screenshot, requirements
  (Node, Claude Code, supported browsers and operating systems), install,
  quick start, how authentication works and what it costs (it uses the
  user's own plan or API key), usage profiles, where data lives
  (`BRIEFSTACK_HOME`, projects folder), the security model in short (local
  only, token, guard, quarantine, confirmations), limitations, and the
  not-affiliated notice.
- `LICENSE` (MIT, with the author's name and year).
- `SECURITY.md`: how to report a vulnerability privately.
- `CONTRIBUTING.md`: how to run tests and the working rules for
  contributors (including those using Claude Code in the repo).
- `CHANGELOG.md` with a 1.0.0 entry summarising the phases.
- The internal briefs, plans and decisions stay in `docs/` as history.

## 6. Repository hygiene

- Rename `master` to `main` on GitHub and locally; update the CI, docs and
  any script that names the branch.
- Enforce the "edit files only with Write and Edit" rule for Claude Code
  sessions in this repo with permission deny rules in `.claude/settings.json`
  (for example in-place `sed`, shell redirection into tracked files), and
  record the limits of what deny rules can catch.
- A short checklist for the user of GitHub settings to turn on after making
  the repo public: private vulnerability reporting, secret scanning, push
  protection, and branch protection for `main`.

## 7. Verification — definition of done

- Build, lint, unit and e2e tests pass on Linux and Windows in the CI.
- The fresh-clone run in section 4 passes.
- The scan in section 3 is clean, or the user has decided on every finding.
- The user reads the README and approves it.
- The user makes the repo public. Tag `v1.0.0` after that.

## 8. Out of scope

New features. Publishing to npm. A hosted version. Working inside projects
from briefstack.

## 9. Working rules

- Tag `release-start` before the first change.
- `docs/PLAN-release.md` with steps and a Status section kept current.
- Small commits, gates green before each commit, CI checked after each push.
- Write and edit files only with the Write and Edit tools.
- Never make the repository public yourself; that is the user's action.
