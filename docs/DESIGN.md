# briefstack — design

How the web app looks. The pass that defines it is in
[BRIEF-ui.md](BRIEF-ui.md); the audit of the app before it is in
[design/audit.md](design/audit.md). The structure of this file follows the
DESIGN.md convention (theme, colour roles, type, components, layout, depth,
do's and don'ts, responsive behaviour) noted in
`design/vendor/awesome-design-md/`; no value here comes from any brand.

**Status: U1.** Section 2 holds two directions for the user to choose from.
After the choice, U2 keeps one, removes the other and the development flag,
and this file describes only the chosen one.

## 1. What every direction keeps

- **Functional and typographic.** Hierarchy from size, weight and space.
  Few colours, one accent. No gradients, no illustrations, no emoji, no glass,
  no glow, no shadows on things at rest.
- **Calm by default, loud only when it matters.** Loud: a question, the spec
  approval, a permission request, a free-text reply the flow waits for, a
  chat confirmation card, a safety warning, an error. Everything else is
  quiet.
- **Fonts served by briefstack itself** or the system stack. U1 used only
  the system stack; U1b (§2.3) bundles OFL fonts, which BRIEF-ui §5 now
  allows. Nothing is loaded from the internet. The system stack: `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue',
  Arial, sans-serif`. A monospace only for paths, commands, code and diffs:
  `ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, monospace`.
- **Tokens in one place** as custom properties; no raw colour in a
  component.
- **Both themes** with the same hierarchy. The theme follows the system and
  (from U2) a manual switch.
- **Accessibility**: text at least 4.5:1, borders that identify a control at
  least 3:1, a visible 2 px focus ring, 44 px targets on a phone, 16 px text
  in fields so phones do not zoom, nothing told by colour alone, reduced
  motion respected.
- **The phone is its own layout**: one row of menu that scrolls sideways,
  what waits for the user before the progress list, tables that become
  blocks.

## 2. Two directions

Both are applied to the projects list and to the creation screen with its
live panel, behind a development-only flag (section 5). Screenshots:
`design/shots/u1/a/` and `design/shots/u1/b/`, each in `1280-light`,
`1280-dark`, `390-light` and `390-dark`, screens `01-projects`,
`05-creation-question`, `06-creation-spec`, `07-creation-permission`.

### 2.1 Direction A — "Quiet sheet"

A tool you keep open all day. A labelled sidebar on the page ground, white
sheets with a 1 px edge for each block, small grey labels, one teal accent.
What waits for the user is a tinted sheet with a 4 px teal edge: clear, not
alarming.

**Type** (4 sizes, 2 weights):

| Role | Size / line height | Weight |
| --- | --- | --- |
| Page title (h1) | 24 / 1.15 | 600 |
| Section (h2) | 18 / 1.3 | 600 |
| Body, controls, card titles | 15 / 1.55 (fields 16) | 400, 600 |
| Meta, labels, table headers | 13 | 400 |

**Space** (4 px base): 4, 8, 12, 16, 24, 32, 48. Sidebar 224 px; content up to
1120 px with 32 px gutters; 16 px gutters on a phone.

**Shape**: card radius 8, control radius 6, chip radius 4. Borders 1 px.
Controls 36 px tall (44 px menu rows on a phone).

**Colour**:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--ground` | #f6f7f6 | #111312 | page and sidebar |
| `--surface` | #ffffff | #191c1a | sheets, fields |
| `--raised` | #eff1f0 | #222624 | active menu row, code, disabled |
| `--border` | #dfe3e1 | #2d322f | sheet edge |
| `--rule` | #eaedeb | #242826 | row rules |
| `--control` | #858d89 | #6f7873 | field and button edge |
| `--text` | #161a18 | #edf0ee | ink |
| `--muted` | #565d59 | #a8b0ab | secondary text |
| `--accent` | #0b6b5f | #5fc4b3 | links, running state, focus |
| `--primary` / ink | #1c201e / #fff | #edf0ee / #111312 | the one filled button |
| `--attention-bg` | #e6f2ef | #12302a | what waits for the user |
| `--warn-bg` / ink | #fbf1d3 / #5e3d00 | #3a2c0a / #f2d27c | notices |
| `--danger` / bg | #b0222a / #fcebeb | #f2898e / #3b1618 | errors, destructive |
| `--ok` / bg | #1d7343 / #e2f3e7 | #72d39d / #11301e | done, added lines |
| `--waiting` | #9a5b00 | #f0b34a | an agent waiting for you |

**Depth**: none at rest; a sheet is told from the ground by its surface and
edge. Only dialogs float (0 12px 32px at 22% black, scrim 45–60%).

**Focus**: 2 px solid `--accent`, 2 px offset. **Motion**: colour changes on
hover and press in 140 ms `ease`; nothing moves; with reduced motion there are
no transitions.

**Components**: primary button near-black (inverted in dark), secondary white
with a 1 px edge, danger outlined in red; agent cards as sheets with a 3 px
status edge and the status in words; progress as a quiet list with a dot per
step (filled when done, ringed when running); timeline bars 8 px.

### 2.2 Direction B — "Ink and signal"

A printed sheet. A top bar over a wide column, black type on white (white on
near-black), rules instead of boxes, larger titles. No accent colour: the one
colour is a signal yellow that fills, edge to edge, the block that waits for
the user, and marks the agent that asks. The rest is ink.

**Type** (4 sizes, 2 weights):

| Role | Size / line height | Weight |
| --- | --- | --- |
| Page title (h1) | 36 / 1.15, tracking −0.02em | 700 |
| Section (h2), with a 2 px rule above | 20 / 1.3 | 700 |
| Body, controls | 16 / 1.5 | 400, 700 |
| Meta, labels | 13 | 400 |

**Space** (4 px base): 4, 8, 12, 16, 24, 40, 64. Content up to 1200 px with
40 px gutters; 16 px on a phone.

**Shape**: square: radius 0 on blocks, 2 on controls and chips. Borders
2 px. Controls 40 px tall.

**Colour**:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--ground` / `--surface` | #ffffff | #0d0d0d | page |
| `--raised` | #f3f3f2 | #1b1b1b | code, disabled |
| `--rule` | #e2e2e0 | #2b2b2b | row rules |
| `--text`, `--control`, `--primary` | #111111 | #f2f2f2 | ink, edges, the filled button |
| `--muted` | #595959 | #a8a8a8 | secondary text |
| `--signal` / ink | #ffd23f / #111111 | #ffd23f / #0d0d0d | what waits for the user |
| `--warn-bg` / ink | #fff4c7 / #4d3a00 | #3a2f08 / #ffe28a | notices |
| `--danger` / bg | #b3121d / #fdeaea | #ff7b7b / #3a1414 | errors, destructive |
| `--ok` / bg | #17733a / #e4f3e9 | #6bd794 / #0f2e1b | done, added lines |

**Depth**: none; dialogs only. **Focus**: 2 px solid ink (signal yellow in
dark), 2 px offset; inside the yellow block, ink. **Motion**: colour in
120 ms; nothing moves.

**Components**: the current menu item and the selected agent underlined in
ink; the running step inverted (ink bar, ground text); agents as rows of a
list with a 4 px status edge and the status word in bold at the right;
buttons square, primary filled in ink, inside the yellow block filled in ink
with yellow text.

### 2.3 U1b: three type variants of A

After U1 the user found A generic, with poor type. Three variants of A keep
its colours, space and shapes and change only the type, with bundled OFL
fonts (BRIEF-ui §5; sources and licenses in `design/vendor/fonts/`):

| Variant | Faces | Why this pair |
| --- | --- | --- |
| 1 | Source Sans 3 + Source Code Pro | A neutral sans built for interface text, with true tabular figures, and the monospace drawn as its partner, so both share x-height and rhythm. |
| 2 | Bricolage Grotesque + JetBrains Mono | A grotesque with optical sizes: ink-trapped and tight at title size, calm at text size; the tall-x-height mono matches its large lowercase. |
| 3 | Newsreader (titles) + Instrument Sans (text) + Inconsolata | An optical-size serif gives titles a voice of their own; a crisp, narrow sans keeps the dense panel quiet; a narrow mono fits long paths. |

The three share what gives A its personality without decoration:

- **Mono** for paths, ids (target, slug, model), agent names (not the main
  session) and commands; the text face for everything else.
- **Tabular figures** in the panel (meta, counts, durations, details, plan
  usage), the progress list, tables and the creations count.
- **A marked scale**: label 12–13, meta 13, body 15–16, lead 18–19,
  section 21–24, title 36–42; four weights (400, 500, 600, 700+), titles
  tightly tracked.
- **Section labels** (Progress, Agents, Timeline, Details, Plan usage):
  small, heavy, a hairline running to the edge; caps and tracked in 1 and 3,
  sentence case in ink in 2. Table headers small caps-style.
- **A typographic logotype**: "brief" and "stack" in two weights of one
  word (in 3, "brief" in the serif and "stack" in the sans).

Screenshots (git-ignored): `screenshots/u1b/v{1,2,3}/{1280-light,
1280-dark,390-light}/`, each with `00-specimen`, `01-projects` and
`06-creation-spec`, taken by `tests/screenshots/type.shots.ts`, which also
fails if a face does not load or lacks tabular figures.

### 2.4 How A and B differ

| | A "Quiet sheet" | B "Ink and signal" |
| --- | --- | --- |
| Shell | sidebar (top bar on a phone) | top bar |
| Blocks | white sheets with edges | no boxes; rules and space |
| Title | 24 px | 36 px |
| Colour | one teal accent | none; yellow only for "waiting for you" |
| What waits for you | tinted sheet, teal edge | full yellow field |
| Corners | 6–8 px | square |
| Feel | calm, dense, long sessions | stark, editorial, impossible to miss a request |

## 3. Contrast

Measured on the tokens (WCAG 2 relative luminance) on 2026-10-20 with a
throwaway script; U4 adds an automated check to the tests.

- Every text pair in both directions and themes passes 4.5:1: ink on every
  ground (light / dark: A 16.4 / 16.3, B 18.9 / 17.4), muted on ground and
  surfaces (A 6.3–6.8 / 7.7–8.4, B 7.0 / 8.2), accent links (A 6.4 / 8.2),
  the filled button, warnings, errors, done text and ink on the yellow field
  (B 13.1 / 13.5).
- Control edges pass 3:1 (A 3.4 / 3.8; B 18.9 / 17.4).
- One pair is under 3:1 and accepted: in B light the yellow field against
  white is 1.4:1. The field is not a control; the text, buttons and fields
  inside it all pass, and it is set off from the page by its own space and
  the 2 px rule of the next section.

## 4. Do and don't

- Do put what waits for the user first, at the top of the creation's main
  column, and above the progress list on a phone.
- Do say a status in words wherever a colour shows it.
- Do use tabular figures for times, durations and percentages.
- Don't add a second accent or colour a heading.
- Don't put a shadow on a resting block or a border and a shadow together.
- Don't show the user's machine paths in committed screenshots (the shots
  script shows the temp folder as `<tmp>`).

## 5. The development flag (U1 only)

`src/ui/static/directions.css` holds both directions, scoped to
`<html data-direction="a">` and `"b"`. `src/ui/direction.ts` sets the
attribute from `localStorage['briefstack-direction']` at start; without it
the app looks as before. To look at one in a running app, in the browser's
console: `localStorage.setItem('briefstack-direction', 'a')` and reload;
`localStorage.removeItem('briefstack-direction')` to go back. With
direction A, `localStorage.setItem('briefstack-type', '1')` (or `2`, `3`)
adds a type variant (§2.3, `src/ui/static/type-variants.css`). The shots
script sets it with `SHOTS_DIRECTION`. Only the shell, the projects list and
the creation screen are styled; other screens show the new controls over the
old layout.
