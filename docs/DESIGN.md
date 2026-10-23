# briefstack — design

How the web app looks. The pass that defines it is in
[BRIEF-ui.md](BRIEF-ui.md); the audit of the app before it is in
[design/audit.md](design/audit.md). The structure of this file follows the
DESIGN.md convention (theme, colour roles, type, components, layout, depth,
do's and don'ts, responsive behaviour) noted in
`design/vendor/awesome-design-md/`; no value here comes from any brand.

**Status: U5, in progress.** The user brought a new design from a design
canvas, in [diseno/](diseno/) (Spanish, as given): `bs.css` with its tokens
and components, the guide `LEEME.md` and the markup of every screen. It
replaces direction A screen by screen. Done: the shell (rail, phone top bar,
opening and restart screens) and the creation screen with the live panel,
plus a finished session's panel. They use `src/ui/static/bs.css` (copied,
with one phone rule removed) and `src/ui/static/app.css` (what the canvas leaves to the app;
see its header). The other screens keep direction A below, its tokens and
sheet nested under `.legacy`, until they move. Decisions: `docs/decisions.md`,
"U5".

Direction A, still used by the screens not yet moved: the user chose "Quiet
sheet" (U1) with type variant 2 (U1b); tokens in `src/ui/static/tokens.css`,
everything else in `src/ui/static/style.css`. The other direction, the other
type variants and the development flags are gone; their screenshots stay in
`design/shots/u1/` for the record.

## 1. Principles

- **Functional and typographic.** Hierarchy from size, weight and space.
  Few colours, one accent. No gradients, no illustrations, no emoji, no glass,
  no glow, no shadows on things at rest.
- **Calm by default, loud only when it matters.** Loud: a question, the spec
  approval, a permission request, a free-text reply the flow waits for, a
  chat confirmation card, a safety warning, an error. Everything else is
  quiet.
- **Tokens in one place**, as custom properties; no raw colour in a
  component.
- **Both themes** with the same hierarchy. The theme follows the system, or
  the switch (System, Light, Dark), remembered per browser.
- **Accessibility**: text at least 4.5:1, control edges, focus and status
  marks at least 3:1 (checked by `tests/unit/contrast.test.ts`), a visible
  2 px focus ring, 44 px targets on a phone, 16 px text in fields so phones
  do not zoom, nothing told by colour alone, reduced motion respected.
- **The phone is its own layout**: one row of menu that scrolls sideways,
  what waits for the user before the progress list, tables that become
  blocks.

## 2. The look: "Quiet sheet"

A tool you keep open all day. A labelled sidebar on the page ground, white
sheets with a 1 px edge for each block, one teal accent. What waits for the
user is a tinted sheet with a 4 px teal edge: clear, not alarming. The type
gives it its personality.

### 2.1 Type

Two bundled OFL faces, served by briefstack itself (BRIEF-ui §5; sources and
licenses in `design/vendor/fonts/`):

- **Bricolage Grotesque** for all text. Its optical sizes make it tight and
  characterful at title size and calm at text size.
- **JetBrains Mono** for paths, ids (target, slug, model), agent names (not
  the main session), commands, code and diffs. Its tall x-height matches the
  text face. Set at 0.84 em.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Page title (h1) | 40 / 1.05, tracking −0.035 em | 760 |
| Section (h2) | 22 / 1.3 | 600 |
| Lead (the idea under a title) | 18 / 1.4 | 400 |
| Body, controls | 15 / 1.5 (fields 16) | 400, 600 |
| Meta, labels, table headers | 13 | 400; labels 760 |

Figures that change or line up (the panel, times, counts, tables) use
tabular digits. Section labels (Progress, Agents, Timeline, Details, Plan
usage, `.section-label`) are 15 px, weight 760, with a hairline that runs
to the edge. Table headers are 13 px in sentence case, muted, weight 600
(U4: no longer caps tracked 0.04 em, which the app-screen rules ban).

The logotype is the word in two weights: "brief" 300, "stack" 800, tracked
−0.045 em.

### 2.2 Space and shape

4 px base: 4, 8, 12, 16, 24, 32, 48. Sidebar 224 px; content up to 1120 px
with 32 px gutters; 16 px gutters on a phone. Card radius 8, control radius
6, chip radius 4. Borders 1 px. Controls 36 px tall (40 px in the phone's
top bar, 44 px menu rows on a phone).

### 2.3 Colour

Each token is `light-dark(light, dark)` in `tokens.css`:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--ground` | #f6f7f6 | #111312 | page and sidebar |
| `--surface` | #ffffff | #191c1a | sheets, fields, buttons |
| `--raised` | #eff1f0 | #222624 | active menu row, code, disabled |
| `--border` | #dfe3e1 | #2d322f | sheet edge |
| `--rule` | #eaedeb | #242826 | row rules |
| `--control` | #858d89 | #737c77 | field and button edge |
| `--text` | #161a18 | #edf0ee | ink |
| `--muted` | #565d59 | #a8b0ab | secondary text |
| `--accent` | #0b6b5f | #5fc4b3 | links, running state, focus |
| `--primary` / `--primary-ink` | #1c201e / #fff | #edf0ee / #111312 | the one filled button |
| `--attention-bg` / `--attention-line` | #e6f2ef / #0b6b5f | #12302a / #5fc4b3 | what waits for the user |
| `--warn-bg` / `--warn-ink` | #fbf1d3 / #5e3d00 | #3a2c0a / #f2d27c | notices |
| `--danger` / `--danger-bg` / `--danger-ink` | #b0222a / #fcebeb / #fff | #f2898e / #3b1618 / #111312 | errors, destructive |
| `--ok` / `--ok-bg` | #1d7343 / #e2f3e7 | #72d39d / #11301e | done, added lines |
| `--waiting` | #9a5b00 | #f0b34a | an agent waiting for you |

### 2.4 Depth, focus, motion

No shadow at rest; a sheet is told from the ground by its surface and edge.
Only dialogs and the chat drawer float (dialog 0 12px 32px at 22% black,
scrim 45% light, 65% dark). Focus: 2 px solid `--focus`, 2 px offset.
Motion: colour changes on hover in 140 ms `ease`; nothing moves; with
reduced motion there are no transitions.

### 2.5 Theme

`tokens.css` sets `color-scheme: light dark`, so the system decides.
`src/ui/theme.ts` sets `<html data-theme="light|dark">` from the switch in
the shell (stored as `localStorage['briefstack-theme']`; System removes
it), which turns `color-scheme` to one value and with it every
`light-dark()` token. The switch also sets `<meta name="theme-color">` to
the page's ground.

## 3. Components

All in `style.css`, in its "shared components" sections. The components
page (`tests/screenshots/components.html`, served only by
`tests/screenshots/components.shots.ts`, never by the app) shows each in its
states.

- **Buttons.** Secondary: surface with a 1 px control edge. Primary
  (`.primary`, a form's submit, or the first action of what waits for the
  user): filled in `--primary`. Danger (`.danger`): outlined in red; a
  destructive action being confirmed (`.danger.primary`, the confirm
  dialogs): filled in red. Disabled: raised, muted text. Link button:
  accent, underlined.
- **Fields.** Label above, hint below (`.hint`), 16 px text, one height,
  explicit colours in both themes (selects included); radios, checkboxes and
  the range slider in `--primary`.
- **Cards.** `.panel` / `.card`: surface, 1 px edge, radius 8. What waits
  for the user (`.attention`, the creation's pending control, the free-text
  reply): tinted, 4 px accent edge, title at section size. Agent cards: a
  3 px status edge and the status in words.
- **Dialogs.** Surface, edge, shadow, scrim; actions at the right, the
  confirming one last.
- **Tables.** Rules, no bands, caps headers, tabular figures, inside a sheet
  that scrolls sideways; the projects table becomes one block per project
  under 640 px.
- **Notices.** `.banner-ok`, `.banner-warn`, `.banner-error`: a tint and a
  1 px edge in the matching colour, text at AA.
- **Empty states.** `.empty`: a muted sentence in a dashed frame.
- **Chat confirmation card.** Waiting: tinted with the 4 px accent edge,
  the state line in ink, Confirm primary, Decline secondary (declining
  destroys nothing). Answered: a quiet sheet with the state in muted text.
- **Diffs.** One block line per line, the `+` / `−` sign carries the change;
  added lines on `--ok-bg`, removed on `--danger-bg`, both in `--text`.

Added while restyling the screens (U3):

- **Page head** (`.page-head`): a small kind label (`.page-kind`: Creation,
  Project, Improvement proposal), the name as `h1`, and the page's actions
  at the right (under it on a phone). A creation is named by its idea.
- **List tables on a phone** (`.stack-on-phone`): one block per row, the
  first cell as its title, the middle ones in a meta line, the last on its
  own line.
- **For you** (`.for-you`): in a list, what waits for the user is in ink
  with a dot; the rest is quiet.
- **Tabs** (`.tabs`): a row on a rule, the current one with an ink bar.
- **Row action** (`.row-action`): a small quiet button at the end of a row.
- **Hint** (`.hint`) under a field; a keyboard shortcut sits by its button.
- **Section label** (`.section-label`) for a page's own groups.
- **The gate**: the logotype and one card with a title and what to do.
- **Skip link**: first on every page, visible when focused.
- **Tab title**: the page's subject, then "· briefstack".

## 4. Do and don't

- Do put what waits for the user first, at the top of the creation's main
  column, and above the progress list on a phone.
- Do say a status in words wherever a colour shows it.
- Do use tabular figures for times, durations and percentages.
- Don't add a second accent or colour a heading.
- Don't put a shadow on a resting block or a border and a shadow together.
- Don't show the user's machine paths in screenshots (the shots scripts show
  the temp folder as `<tmp>`).
