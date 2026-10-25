# briefstack — design

How the web app looks. The pass that defines it is in
[BRIEF-ui.md](history/BRIEF-ui.md); the audit of the app before it is in
[design/audit.md](history/design/audit.md). The structure of this file follows the
DESIGN.md convention (theme, colour roles, type, components, layout, depth,
do's and don'ts, responsive behaviour) noted in
`design/vendor/awesome-design-md/`; no value here comes from any brand.

**Status: U5.** Every screen uses the design the user brought from a
design canvas, in [diseno/](diseno/) (Spanish, as given): `bs.css` with its
tokens and components, the guide `LEEME.md` and the markup of every screen.
The app serves `src/ui/static/bs.css` (copied, with one phone rule
removed), `src/ui/static/app.css` (what the canvas leaves to the app: the
shell's phone menu, the fixed dialog and drawer, and the classes that
replace the canvas's `style` attributes, which the CSP refuses) and
`src/ui/static/fonts.css`. Decisions: `docs/decisions.md`, "U5". The
earlier direction A ("Quiet sheet", U1–U4) and its sheet, tokens and fonts
are gone; its screenshots stay in `design/shots/` and
`design/before-after/` for the record.

## 1. Principles

- **Functional and typographic.** Hierarchy from size, weight and space.
  Few colours, one accent. No gradients, no illustrations, no emoji.
- **Calm by default, loud only when it matters.** The four rules of
  `LEEME.md`:
  1. **Cream** (`.dec`, `.chip-dec`, `.badge-dec`) only for what waits for
     the user's answer: questions, the spec, permissions, folders, the
     free-text reply, the chat's confirmation cards, a proposal's decision.
     If nothing waits, it is not cream.
  2. **Green** (the accent): running, valid, primary.
  3. **Amber**: an informative notice, never an agent's state.
  4. **Coral**: an error, a danger, a safety notice (before the decision),
     and where an ended session stopped short.
- **Nothing told by colour alone**: every state also has a word, a dot, a
  ring, a ✓ or a ✕.
- **Tokens in one place**, as custom properties in `bs.css`; app.css uses
  only those tokens.
- **Both themes** with the same hierarchy. The theme follows the system, or
  the switch (System, Light, Dark), remembered per browser.
- **Accessibility**: text at least 4.5:1, control edges, focus and status
  marks at least 3:1 (checked by `tests/unit/contrast.test.ts`), a visible
  2 px focus ring (dark ink inside cream), 42 px targets on a desktop and
  44 px on a phone, real controls (radios hidden visually but focusable),
  reduced motion respected.

## 2. The look

### 2.1 Type

Three bundled faces, served by briefstack itself (sources and licenses in
`design/vendor/fonts/`; Roboto Slab is Apache 2.0, an approved exception to
the OFL rule):

- **Roboto Slab** 500 and 700 for titles.
- **Inter** 400, 500 and 600 for text and actions.
- **IBM Plex Mono** 400 and 500 for paths, ids, agents, models and figures.

The scale is in `bs.css` (`--fs-display` 48, `--fs-1` 34, `--fs-2` 20,
`--fs-3` 16, body 15, small 13.5, mono 13 and 12), smaller on a phone.

### 2.2 Space, shape, colour, motion

All in `bs.css`: a 4 px space scale (`--s-1` … `--s-8`), radii for chips,
controls, cards and decisions (4, 8, 12, 20), 1 and 2 px borders, two
durations (120 and 200 ms). The colours of both themes are its tokens:
ground, rail, surfaces, lines, three inks, the green accent, the cream of
decisions (which turns dark ink on paper in the light theme), amber, coral,
and the diff colours.

### 2.3 Theme

`<html class="bs" data-theme="light|dark">`. bs.css changes its tokens only
through the attribute, so `src/ui/theme.ts` always sets it: from the switch
in the rail, or, for System, from `prefers-color-scheme`, kept current when
the system changes. The choice is stored as
`localStorage['briefstack-theme']`; the switch also sets
`<meta name="theme-color">` to the page's ground.

## 3. Layout

- **Desktop**: the rail (brand, menu with a count on Creations, cream when
  one waits for the user, the theme and language switches, "Open the chat"
  with Ctrl J) beside the page: its head (`.page-head`) and its body
  (`.page`), with a main and a side column (`.cols`) where it helps.
- **Phone (≤ 720 px)**: the top bar with the chat and Menu buttons; the
  menu is the rail over the dimmed page. Columns stack. On the creation
  screen only a compact bar with the state and an outlined Cancel stays in
  sight. The progress segments carry no names; the current step is named
  beside "step 3 / 9".

## 4. Components

`LEEME.md` maps each component to its classes (buttons, fields, question
options, choices and tiers, segmented controls, chips, states, cards,
decisions, notices, tables, dialogs, diffs, progress, usage meters, agents,
chat and drawer, library, empty and loading). app.css adds:

- **Notes** (`Note` in `src/ui/kit.tsx`): a notice with an icon, in the
  tone of its meaning; errors use `role="alert"`.
- **Loading** and **Empty**: the loader bar, and a dashed frame that says
  what is missing with the way to make the first one.
- **Modal confirmation** (`ConfirmModal`): a native modal dialog, focus on
  the button that backs out; destructive actions confirm in coral, others
  (approving, a new chat) in the primary button.
- **In-line confirmation**: reverting a library commit asks in cream under
  the commit (LEEME).
- **The chat drawer**: a modal dialog that keeps focus inside.
- **Diffs** with line numbers worked out from the hunks
  (`src/ui/diffLines.ts`).

## 5. Do and don't

- Do put what waits for the user first, in cream, and announce it without
  moving focus.
- Do say a status in words wherever a colour shows it.
- Do use tabular figures for times, durations and percentages.
- Don't use cream for anything that does not wait for an answer, or coral
  for anything that is not an error, a danger or a stop.
- Don't add a `style` attribute: the CSP refuses it; widths that depend on
  data go through Preact's style object (the CSSOM).
- Don't show the user's machine paths in committed pictures (the U5
  screenshots stay in the git-ignored `screenshots/` folder).
