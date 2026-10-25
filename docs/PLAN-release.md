# briefstack — Release plan

Plan for the release pass: prepare the repository to be made public. Scope
comes from [BRIEF-release.md](BRIEF-release.md); the decisions in its
section 1 are the user's (MIT, both authentication modes, no history
rewrite, `master` renamed to `main`).

Starting point: tag `release-start` (the commit that adds the brief). Work
happens on `master` until step R9 renames it; small commits, one concern
each; build, lint and tests green before each commit; push and CI after
each step. No force push and no history rewrite without the user's explicit
approval. The repository is made public only by the user.

## 0. Status

Updated 2026-10-25. R0 done. R1 (privacy and secrets scan) in progress:
the scan runs first and its findings go to the user before anything is
changed.

| # | Step | State |
|---|---|---|
| R0 | Brief committed, tag `release-start`, this plan | done |
| R1 | Privacy and secrets scan of the whole history (brief section 3) | in progress |
| R2 | Fixes for the scan findings the user decides on | pending |
| R3 | Policy and authentication: verify and record, API key mode, mode display, usage hidden in API key mode (section 2) | pending |
| R4 | Branding check (section 2) | pending |
| R5 | `package.json` and first-run messages (section 4) | pending |
| R6 | Fresh-clone run with an empty `BRIEFSTACK_HOME` (section 4) | pending |
| R7 | CI matrix with `windows-latest` (and `macos-latest` if time allows) (section 4) | pending |
| R8 | Documentation: README, LICENSE, SECURITY, CONTRIBUTING, CHANGELOG (section 5) | pending |
| R9 | Repository hygiene: `main`, deny rules, GitHub settings checklist (section 6) | pending |
| R10 | Definition of done (section 7): user reads the README, makes the repo public, tag `v1.0.0` | pending (user) |

## 1. Steps

### R1. Privacy and secrets scan

Scan every commit on every branch and tag (`git log --all`, all blobs ever
reachable, commit metadata), not only the current tree, for:

- secrets and tokens (API keys, OAuth and GitHub tokens, private keys,
  high-entropy strings);
- personal paths (`C:\Users\<user>\...`, `<home>\...`, `/home/<user>/...`, `/Users/<user>/...`);
- email addresses other than the author's;
- personal names other than the author's;
- data from the user's personal library (project names, lessons, profile);
- machine-specific values (host names, ports, user names, tool paths).

Also: look at every committed image; confirm that `CLAUDE.local.md`,
`.claude/settings.local.json`, `screenshots/` and the local tool paths are
ignored and were never committed; record that the author's first name
appears in the docs.

Output: a list of findings with commit, file and what each is, given to the
user before any change. Stop there.

### R2. Fixes

Fix forward what the user decides. If something sensitive exists only in
old history, explain the options and wait; no rewrite without approval.

### R3. Policy and authentication

Re-read the three sources named in the brief and record the date. Verify in
the code, and record where, that briefstack never offers a sign-in, never
reads, stores or forwards credentials, and runs the user's unmodified
`claude`. Let the user's own `ANTHROPIC_API_KEY` (or cloud provider
configuration) pass through the environment cleaning, never logged, shown
or written. Fake-runner tests for both modes; a cheap real check for API
key mode in `scripts/real/`, run only by the user. Preflight and Settings
show the mode; the plan-usage display is hidden in API key mode with the
reason.

### R4. Branding

No "Claude Code" in the product name, logo or ASCII art.

### R5. Package and first run

`package.json`: version `1.0.0`, description, license, repository,
engines, `bin`. Clear CLI and web messages when Claude Code is missing, too
old, or not signed in and no API key is set. Base library templates and
rules generic.

### R6. Fresh clone

Clone into an empty scratch folder outside the repo with an empty
`BRIEFSTACK_HOME`: install, build, `briefstack init`, `briefstack web`, the
fake-runner e2e suite. Fix anything that assumes this machine.

### R7. CI matrix

Add `windows-latest` (and `macos-latest` if time allows) with build, lint,
unit and e2e.

### R8. Documentation

`README.md`, `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`,
`CHANGELOG.md` (1.0.0). Internal briefs, plans and decisions stay in
`docs/`.

### R9. Repository hygiene

Rename `master` to `main` (the GitHub rename is the user's action if the
token cannot do it); update CI, docs and scripts. Deny rules in
`.claude/settings.json` for editing files outside Write and Edit, with
their limits recorded. Checklist of GitHub settings for after going public.

### R10. Done

Gates green on Linux and Windows in CI, fresh clone passes, scan clean or
decided, README approved. The user makes the repository public; tag
`v1.0.0` after that.
