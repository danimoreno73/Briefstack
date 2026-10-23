# briefstack — UI pass plan

Plan for the UI and UX pass. Scope comes from [BRIEF-ui.md](BRIEF-ui.md).
Decisions taken during the pass are in `docs/decisions.md`, "# UI pass".

Starting point: tag `ui-start`. Work happens on `master` in small commits,
one concern each, with build, lint and tests green before each commit and CI
checked after each push. Plan usage is read with `scripts/real/preflight.ts`
before each step; the work stops if the 7-day window is over 85% or the
5-hour window over 90%.

## 0. Status

Updated 2026-10-23. U0 to U5 are done: every screen uses the design the
user brought (`docs/diseno/`), and direction A is gone. **Waiting for the
user's approval of the final screenshots (`screenshots/u5/`) and one use of
the app** (a creation and the chat); the tag `ui-done` comes after that,
not before. Controls the design shows without a function in the app are in
`docs/IDEAS.md` §3.

| Step | State | What exists |
| --- | --- | --- |
| U0 | done | References pinned in `docs/design/vendor/` with `SOURCE.md`; `tests/screenshots/audit.shots.ts`; 108 screenshots in `docs/design/shots/u0/`; `docs/design/audit.md` (40 findings: 7 high, 19 medium, 14 low) |
| U1 | done | `docs/DESIGN.md` §2 with directions A "Quiet sheet" and B "Ink and signal" and their tokens for both themes; `src/ui/static/directions.css` and the development flag `src/ui/direction.ts` (`localStorage['briefstack-direction']`); applied to the shell, the projects list and the creation screen; screenshots in `docs/design/shots/u1/{a,b}/` |
| U1b | done | The user asked for direction A only, with better type. BRIEF-ui §5 allows bundled OFL fonts; seven faces in `src/ui/static/fonts/` with licenses in `docs/design/vendor/fonts/`; three variants in `src/ui/static/type-variants.css` (flag `localStorage['briefstack-type']`), `docs/DESIGN.md` §2.4; `tests/screenshots/type.shots.ts` writes the specimens and screens to `screenshots/u1b/` (git-ignored) |
| U2 | done | Direction A with Bricolage Grotesque + JetBrains Mono is the only style; flags, the other direction and fonts removed. Tokens in `src/ui/static/tokens.css` (`light-dark()`), base and components in `style.css`; theme switch (`src/ui/theme.ts`); `tests/unit/contrast.test.ts`; components page and shots in `tests/screenshots/components.*` (output `screenshots/u2/`, git-ignored); 13 findings closed, 3 partial (`docs/design/audit.md`, "Status after U2") |
| U3 | done | Every screen in six groups plus the shell, one commit each: creation; chat; improvements; projects and creations; library; usage, settings and the restart message; page titles and the skip link. All high findings and every medium but M8 (partial, API proposal) closed; `docs/design/audit.md` "Status after U3". Minimum browsers in the README and `docs/decisions.md`. Screenshots per group in `screenshots/u3/` (git-ignored); `SHOTS_VIEWS` limits the views |
| U4 | done | M8 with a read-only, redacted `idea` in `GET /api/sessions` (user-approved exception, `docs/api.md`, `docs/decisions.md`); L3, L6, L10 closed; the flaky "both library commits" test and three other one-shot readings wait for conditions (10 full e2e runs in a row green); the note editor's load race fixed; final audit on every screen with 5 new findings closed, none high or medium left (`docs/design/audit.md`, "Status after U4"); `docs/design/before-after.md` with 6 pairs in `docs/design/before-after/`; final screenshots in `screenshots/u4/final/` (git-ignored) |
| U5 | done | The design from the canvas in `docs/diseno/` on every screen. `bs.css` copied (one phone rule removed at the user's review), `app.css`, `fonts.css` with Inter, Roboto Slab (Apache 2.0, user-approved exception) and IBM Plex Mono. The shell and the creation screen first (with the user's review applied), then six groups, one commit each: usage and settings; projects, detail, creations and new project ("Start again with this idea"); library; improvements; chat page, drawer and cards (focus trap); the clean-up (direction A's sheet, tokens, fonts, `.legacy` and the old screenshot tools removed). Controls without a function left off and in `docs/IDEAS.md` §3. Contrast test over bs.css; screenshots `npm run screenshots -- screens.shots.ts` and `panel.shots.ts` (`screenshots/u5/`, git-ignored) |

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
- **U5 The canvas design.** The user's design in `docs/diseno/` replaces
  direction A. bs.css (one phone rule removed at the user's review), plus
  `app.css` for what the canvas leaves to the app. Order: the shell and the
  creation screen; then, in the user's six groups, one commit each: usage
  and settings; projects and detail (with creations and new project);
  library; improvements; chat page, drawer and cards; the clean-up
  (direction A's sheet, tokens, fonts and the `.legacy` wrapper removed).
  Then the final screenshots, and the approval and use above.

## 2. Tools

- `npm run screenshots -- screens.shots.ts` takes every screen but the
  creation's at 1280 and 390, light and dark (output
  `screenshots/u5/screens/`, git-ignored). `SHOTS_ONLY` keeps the screens
  whose name starts with one of its comma-separated prefixes.
- `npm run screenshots -- panel.shots.ts` takes the creation screen in each
  of its states, the result with a project and three suggestions, and a
  finished session's panel, in the same four views (output
  `screenshots/u5/`, git-ignored).
- Both show this machine's temp paths, so their pictures are not committed.
  The U0 and U2 tools (`audit.shots.ts`, the components page) were removed
  with direction A; their pictures stay in `docs/design/shots/` and
  `docs/design/before-after/`.
- `tests/unit/contrast.test.ts` checks the token pairs of bs.css for WCAG
  AA in both themes, as part of `npm test`.
