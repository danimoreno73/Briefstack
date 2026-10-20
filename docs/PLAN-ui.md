# briefstack — UI pass plan

Plan for the UI and UX pass. Scope comes from [BRIEF-ui.md](BRIEF-ui.md).
Decisions taken during the pass are in `docs/decisions.md`, "# UI pass".

Starting point: tag `ui-start`. Work happens on `master` in small commits,
one concern each, with build, lint and tests green before each commit and CI
checked after each push. Plan usage is read with `scripts/real/preflight.ts`
before each step; the work stops if the 7-day window is over 85% or the
5-hour window over 90%.

## 0. Status

Updated 2026-10-20. U0 is done; U1 is in progress.

| Step | State | What exists |
| --- | --- | --- |
| U0 | done | References pinned in `docs/design/vendor/` with `SOURCE.md`; `tests/screenshots/audit.shots.ts`; 108 screenshots in `docs/design/shots/u0/`; `docs/design/audit.md` (40 findings: 7 high, 19 medium, 14 low) |
| U1 | in progress | — |
| U2 | — | — |
| U3 | — | — |
| U4 | — | — |

## 1. Steps

- **U0 Audit.** Pin the references (Taste Skill, Vercel web interface
  guidelines and the file they fetch, awesome-design-md for structure only).
  Screenshots of every screen at 1280 and 390 px, light and dark, over the
  fake runners. Audit against the Vercel guidelines and the Taste Skill
  redesign route and app-screen chapter: `docs/design/audit.md`.
- **U1 Two directions.** `docs/DESIGN.md` with two directions inside its
  section 2, each with tokens for both themes (type scale, spacing, colours,
  radius, borders, focus, motion). Each applied to the projects list and the
  creation screen with the live panel, switchable by a development-only
  flag. Screenshots of both at 1280 and 390 px, light and dark. Stop for the
  user's choice.
- **U2 Foundations.** The chosen direction's tokens in one place, base
  styles, the theme switch, and the shared components: buttons, inputs,
  cards, dialogs, tables, alerts, empty states. The flag and the other
  direction are removed.
- **U3 Screens.** Every screen, one group per commit: navigation and shell;
  projects and project; new project and creation flow; creations; library;
  usage and settings; chat page, drawer and cards; improvements; the gate
  and the restart message.
- **U4 Audit again.** Fix every high and medium finding, take the final
  screenshots with the same script, `docs/design/before-after.md`, the
  automated contrast check over the tokens, tag `ui-done` after the user's
  approval and use.

## 2. Tools

- `npm run screenshots -- audit.shots.ts` takes every screen. `SHOTS_OUT`
  sets the folder (default `screenshots/audit`, git-ignored),
  `SHOTS_DIRECTION` the development direction flag, `SHOTS_ONLY` a list of
  screen numbers. The test's temp folder is shown as `<tmp>` so no path of
  the machine lands in a committed picture.
