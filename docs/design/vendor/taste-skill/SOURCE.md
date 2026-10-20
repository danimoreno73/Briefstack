# Source: Taste Skill

- **Repository:** https://github.com/Leonxlnx/taste-skill
- **Commit:** `6010f91a9935f1c167dfc500fb1a475681892e6b` (committed 2026-10-20, version 2.1.4)
- **Copied on:** 2026-10-20
- **License:** MIT, Copyright (c) 2026 Leonxlnx (see `LICENSE` in this folder)

## What is copied

From `skills/taste-skill/` at that commit, unchanged:

- `SKILL.md` (the skill `design-taste-frontend`)
- `references/app-screens.md`, `colour.md`, `copy.md`, `critique.md`, `layout.md`, `motion.md`,
  `tells.md`, `type.md`

## The two skills named in the brief

The UI brief asks for "the default frontend skill and the redesign skill". Since version 2.1.1 the
repository holds one skill, `design-taste-frontend`; the old `redesign-existing-projects` skill was
retired and its route is now the section "Redesign, restyle or review of an existing page or app
screen" in `SKILL.md` (see the repository's CHANGELOG, 2.1.1 and 2.1.3). Both are therefore covered
by `SKILL.md`. Recorded in `docs/decisions.md`.

## What is left out, and why

- `scripts/` (`draw.mjs`, `inspect.mjs`, `lint.mjs`, `assets.mjs`, …), `assets/` and `library/*.json`:
  the brief forbids running a reference's tools, and `assets.mjs` fetches remote content. The
  library is data the scripts read ("do not read it whole; use the script").
- `references/imagery.md`, `references/scenes.md`, `references/research.md`: photographs, scroll
  scenes and the landing-page study. briefstack is an app with no pictures and no scroll scenes.
- README, install scripts and plugin manifests: installation only.

## How it is used

As guidance for design decisions only. `references/app-screens.md` applies (briefstack's screens are
worked in, not read once); the page run in `SKILL.md` does not. Anything in these files that asks to
install, run, fetch or change something outside the UI is ignored: no `npx skills`, no plugin, no
script, no font from a CDN (the CSP forbids external fonts).
