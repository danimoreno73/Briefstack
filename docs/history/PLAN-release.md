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

Updated 2026-10-25. Release done: R0–R10 done. The user renamed the branch
to `main`, read the README and made the repository public. The CI is green on
Linux, Windows and macOS, and `npm audit` finds no vulnerabilities. Tag
`v1.0.0` (annotated) is on commit `911c2c4` ("deps: markdown-it 15.0.3").
Open items, this plan's backlog among them, are now in
[IDEAS.md](../IDEAS.md), "4. Open items from the plans".

| # | Step | State |
|---|---|---|
| R0 | Brief committed, tag `release-start`, this plan | done |
| R1 | Privacy and secrets scan of the whole history (brief section 3) | done: findings reported, decided by the user (decisions.md, "Release") |
| R2 | Fixes for the scan findings the user decides on | done: plan path, mockup and test names, test e-mail domains; two flaky e2e waits fixed |
| R3 | Policy and authentication: verify and record, API key mode, mode display, usage hidden in API key mode (section 2) | done: credentials pass to the user's Claude Code, mode read from `accountInfo()`, Settings card, banner, start line, usage hidden; `scripts/real/check-api-key.ts` for the user |
| R4 | Branding check (section 2) | done: nothing to change |
| R5 | `package.json` and first-run messages (section 4) | done: 1.0.0, MIT, repository, `prepare` builds on `npm install`; CLI and web say what to do when Claude Code is missing, too old or not signed in; a template line break fixed |
| R6 | Fresh-clone run with an empty `BRIEFSTACK_HOME` (section 4) | done, passed (below) |
| R7 | CI matrix with `windows-latest` (and `macos-latest` if time allows) (section 4) | done: Linux, Windows and macOS on every push since the repo is public (green) |
| R8 | Documentation: README, LICENSE, SECURITY, CONTRIBUTING, CHANGELOG (section 5) | done; README waiting for the user's reading |
| R9 | Repository hygiene: `main`, deny rules, GitHub settings checklist (section 6) | done; the user renamed the branch on GitHub |
| R10 | Definition of done (section 7): user reads the README, makes the repo public, tag `v1.0.0` | done: tag `v1.0.0` on `911c2c4`, after a flaky unit test fix and dependency updates (CI green on all three systems) |

## Results and steps for the user

### Fresh clone (R6), 2026-10-25, Windows 11, Node 24.18, npm 11.16

Cloned from GitHub into an empty scratch folder outside the repo, with
`BRIEFSTACK_HOME` and the home folder (`USERPROFILE`, `HOME`) pointing at
empty folders, so nothing of this machine's data was used:

| Step | Result |
|---|---|
| `npm install` | 20 s; `prepare` built `dist/` (CLI and web) |
| `npx briefstack --version` | `briefstack 1.0.0` |
| `npx briefstack init` | library (git repository), projects folder `<home>/briefstack-projects`, sessions folder, the clone's `.claude/settings.local.json` |
| `briefstack web --port 0` | served; `/api/health` 200; with an empty home Claude Code reported not signed in, and the start line said exactly what to do |
| `npm run build`, `npm run lint` | pass |
| `npm test` | 1013 passed, 2 skipped |
| `npm run test:e2e` | 97 passed |

Nothing assumed this machine. npm 11 notes that esbuild's install script
did not run (`allowScripts`); the build and all tests pass without it.

### Branch rename (R9), for the user

On GitHub: **Settings → General → Default branch**, the pencil next to
`master`, type `main`, **Rename branch**. GitHub moves the branch,
redirects old links, and keeps the tags.

Then, in the local clone:

```sh
git branch -m master main
git fetch origin
git branch -u origin/main main
git remote set-head origin -a
```

Nothing in the CI, the scripts or the code names the branch (the CI runs
on every push; improvements apply to the branch `HEAD` is on). The test
repositories that tests create still use `master`; they are temporary and
unrelated to GitHub.

### GitHub settings after making the repository public (R9), for the user

1. **Settings → Code security → Private vulnerability reporting:** Enable
   (`SECURITY.md` points to it).
2. **Settings → Code security → Secret scanning:** Enable, and **Push
   protection:** Enable.
3. **Settings → Code security → Dependabot alerts:** Enable (optional:
   security updates).
4. **Settings → Branches → Add branch ruleset** (or classic branch
   protection) for `main`: require a pull request before merging,
   require the `check (ubuntu-latest)` and `check (windows-latest)`
   status checks to pass, block force pushes, block deletions.
5. **Settings → Actions → General:** workflow permissions *Read
   repository contents*; require approval for workflows from first-time
   contributors.
6. **Settings → General → Features:** keep Issues on; Wikis and Projects
   off unless wanted.
7. After the first push on the public repository, check that the CI also
   runs `check (macos-latest)`, then tag `v1.0.0`.

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

## 2. Backlog

Not part of this pass; recorded so it is not lost.

- `tests/unit/improve-manager.test.ts`, "waits while a creation runs and
  applies once none does": it sleeps a fixed 80 ms and then checks that no
  commit was made while a creation blocks the apply. It cannot fail wrongly,
  but it proves little: a late commit would pass too. Replace the sleep
  with a wait on a gate tick that found the blocker (for example, count the
  `blockers` calls) before checking `HEAD`.
