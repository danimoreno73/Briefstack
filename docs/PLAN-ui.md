# briefstack — UI pass plan

Plan for the UI and UX pass. Scope comes from [BRIEF-ui.md](BRIEF-ui.md).
Decisions taken during the pass are in `docs/decisions.md`, "# UI pass".

Starting point: tag `ui-start`. Work happens on `master` in small commits,
one concern each, with build, lint and tests green before each commit and CI
checked after each push. Plan usage is read with `scripts/real/preflight.ts`
before each step; the work stops if the 7-day window is over 85% or the
5-hour window over 90%.

## 0. Status

Updated 2026-10-22. U0 to U4 are done. **Waiting for the user's approval
of the final screenshots and one use of the app** (a creation and the
chat); the tag `ui-done` comes after that, not before.

| Step | State | What exists |
| --- | --- | --- |
| U0 | done | References pinned in `docs/design/vendor/` with `SOURCE.md`; `tests/screenshots/audit.shots.ts`; 108 screenshots in `docs/design/shots/u0/`; `docs/design/audit.md` (40 findings: 7 high, 19 medium, 14 low) |
| U1 | done | `docs/DESIGN.md` §2 with directions A "Quiet sheet" and B "Ink and signal" and their tokens for both themes; `src/ui/static/directions.css` and the development flag `src/ui/direction.ts` (`localStorage['briefstack-direction']`); applied to the shell, the projects list and the creation screen; screenshots in `docs/design/shots/u1/{a,b}/` |
| U1b | done | The user asked for direction A only, with better type. BRIEF-ui §5 allows bundled OFL fonts; seven faces in `src/ui/static/fonts/` with licenses in `docs/design/vendor/fonts/`; three variants in `src/ui/static/type-variants.css` (flag `localStorage['briefstack-type']`), `docs/DESIGN.md` §2.4; `tests/screenshots/type.shots.ts` writes the specimens and screens to `screenshots/u1b/` (git-ignored) |
| U2 | done | Direction A with Bricolage Grotesque + JetBrains Mono is the only style; flags, the other direction and fonts removed. Tokens in `src/ui/static/tokens.css` (`light-dark()`), base and components in `style.css`; theme switch (`src/ui/theme.ts`); `tests/unit/contrast.test.ts`; components page and shots in `tests/screenshots/components.*` (output `screenshots/u2/`, git-ignored); 13 findings closed, 3 partial (`docs/design/audit.md`, "Status after U2") |
| U3 | done | Every screen in six groups plus the shell, one commit each: creation; chat; improvements; projects and creations; library; usage, settings and the restart message; page titles and the skip link. All high findings and every medium but M8 (partial, API proposal) closed; `docs/design/audit.md` "Status after U3". Minimum browsers in the README and `docs/decisions.md`. Screenshots per group in `screenshots/u3/` (git-ignored); `SHOTS_VIEWS` limits the views |
| U4 | done | M8 with a read-only, redacted `idea` in `GET /api/sessions` (user-approved exception, `docs/api.md`, `docs/decisions.md`); L3, L6, L10 closed; the flaky "both library commits" test and three other one-shot readings wait for conditions (10 full e2e runs in a row green); the note editor's load race fixed; final audit on every screen with 5 new findings closed, none high or medium left (`docs/design/audit.md`, "Status after U4"); `docs/design/before-after.md` with 6 pairs in `docs/design/before-after/`; final screenshots in `screenshots/u4/final/` (git-ignored) |

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
  sets the folder (default `screenshots/audit`, git-ignored), `SHOTS_ONLY`
  a list of screen numbers, `SHOTS_VIEWS` a list of views
  (`1280-light,1280-dark,390-light`). The test's temp folder is shown as `<tmp>` so no
  path of the machine lands in a committed picture.
- `npm run screenshots -- components.shots.ts` takes the components page
  and two key screens at 1280 light and dark and 390 light (default
  `screenshots/u2`, git-ignored).
- `tests/unit/contrast.test.ts` checks the token pairs for WCAG AA in both
  themes, as part of `npm test`.
