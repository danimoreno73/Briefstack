# UI audit (U0)

The web app as it was at tag `ui-start`, before any change of the UI pass
(BRIEF-ui §6, U0). Screens were taken over the fake runners with
`tests/screenshots/audit.shots.ts` at 1280 and 390 px, in the light and the
dark scheme (the app follows the system scheme; it has no switch). They are in
`docs/design/shots/u0/<width>-<scheme>/`; the temp folder of each run is shown
as `<tmp>`.

Checklists, pinned in `docs/design/vendor/`:

- **WIG**: Vercel web interface guidelines (`web-design-guidelines/AGENTS.md`
  and `command.md`), cited by section.
- **TS**: Taste Skill, the redesign route in `SKILL.md` and the app-screen
  chapter `references/app-screens.md`, cited by section.
- **BRIEF**: `docs/BRIEF-ui.md`, for the direction and constraints this pass
  must meet.

Severity:

- **High**: a person cannot read, find or safely decide something, or a
  hard requirement (WCAG AA, phone width) fails.
- **Medium**: it works, but it is confusing, inconsistent or breaks a MUST of
  the checklists.
- **Low**: polish.

## Summary

| Severity | Findings |
| --- | --- |
| High | 7 |
| Medium | 19 |
| Low | 14 |
| **Total** | **40** |

The five worst, in order:

1. **H1.** In dark, added and removed lines of every diff are unreadable
   (dark green text on dark green). The proposal page that carries a safety
   notice is exactly where the user must read them.
2. **H2.** After a server restart an old tab shows "Something went wrong
   (web.rejected.token)" and a "Try again" that can never work.
3. **H3.** What the creation waits for does not stand out: the question, the
   spec and the permission sit in the same grey box as the result, and on a
   phone they start about 700 px down, under the nine-step progress list.
4. **H4.** On the proposal page, Approve comes before the diff, and the
   safety notice says "read the diff above" when the diff is below.
5. **H5.** In dark, buttons are the browser's grey with pink danger labels,
   well under AA (about 2.4:1 for "Cancel creation", "Decline", "Discard").

## Findings

Screen numbers are the file names in `docs/design/shots/u0/`.

### High

| # | Screen | Problem | Guideline |
| --- | --- | --- | --- |
| H1 | 21 chat card, 23 proposal (dark) | `.diff-add` and `.diff-del` keep their light-theme text colours (#14532d, #7f1d1d) on the dark backgrounds (#14532d, #7f1d1d): the changed lines are solid bars with no readable text. | WIG Design "Meet contrast"; BRIEF §5 contrast AA in both themes |
| H2 | 24 old tab after restart | Any request with a stale token shows "Something went wrong (web.rejected.token)." and "Try again", which repeats the same refused request. Nothing says to open the new address from the terminal. | WIG Feedback "No dead ends; always offer next step"; WIG Content & Copy "Error messages include fix/next step"; BRIEF §4 backlog |
| H3 | 05, 06, 07, 09 (both widths) | The control the flow waits for (questions, spec approval, permission, free-text reply) uses the same quiet grey panel as the result and the working state; its title is the same size as "Agents". On 390 px it starts at about 700 px, after the idea, the policy line and the whole progress list. | BRIEF §2 "loud only when it matters"; TS app-screens §2.2 "the most frequent job is one click away", §12 "blocks that carry an action move up" |
| H4 | 23 proposal | "Approve and apply" and "Discard" come before "Changes"; the flagged notice tells the user to "read the diff above", which is below. A user can approve a flagged change without scrolling past it. | TS app-screens §2.2 "show the evidence beside the answer"; WIG Content "No dead ends" (the instruction points nowhere) |
| H5 | all screens with buttons (dark) | Buttons are unstyled native controls. In dark they become a mid grey with white or pink text; the pink danger label on grey is about 2.4:1, the white label about 5:1 but the button edge against the page is under 3:1. | WIG Design "Meet contrast"; WIG Dark mode; BRIEF §5 contrast AA |
| H6 | all screens (390) | The navigation does not fold: eight links and the chat button take three rows (about 135 px) at the top of every phone screen. Each link is about 20 px tall. | TS app-screens §12 "Navigation folds"; WIG Targets "Hit target ≥24px (mobile ≥44px)" |
| H7 | 20 chat drawer (390) | At phone width the drawer covers the whole screen, including the menu, with no backdrop and no title bar of its own; the only way out is a button at the top right. (The audit script had to close it to reach the menu.) | WIG Touch "overscroll-behavior: contain in drawers"; WIG Keyboard "Manage focus (trap, move, return)" |

### Medium

| # | Screen | Problem | Guideline |
| --- | --- | --- | --- |
| M1 | all | No manual theme switch; only the system scheme. | BRIEF §2 "The theme follows the system setting, with a manual switch" |
| M2 | all | The document `<title>` is always "briefstack", whatever the screen or the creation. | WIG Content "`<title>` matches current context" |
| M3 | all | No "Skip to content" link; the menu has eight links before the page. | WIG Content "'Skip to content' link" |
| M4 | 02 project, 06 spec, 15 editor | Rendered Markdown keeps its own `h1`: "Next steps" appears twice (h2, then a larger h1); the spec's name is a 32 px h1 inside "Approve the spec" (h2). Heading levels jump and the content outshouts the page. | WIG Content "hierarchical `<h1>`–`<h6>`"; TS type §8 "one size dominant per screen" |
| M5 | 19 settings, 09 reply, 21 chat | Labels, fields and hints run on one line: "Language[select]", "Creations at the same time[2]How many…", "Your message[box]Ctrl+Enter sends…". The reply and chat boxes are about 180 × 50 px. | TS app-screens §8.1 "Label above the field"; WIG Forms "Labels clickable", content handling |
| M6 | 19, 18, 15, 21 | Native inputs, selects, the number field and the range slider are unstyled, so each has a different height, border and font size (13.33 px). On a phone the text inputs are under 16 px, which makes iOS zoom. In dark the `<select>` has no explicit colours. | WIG Targets "Mobile `<input>` font-size ≥16px"; WIG Dark mode "Native `<select>`: explicit background-color and color"; TS app-screens §8.1 "one control height per context" |
| M7 | 01 projects (390) | The projects table scrolls sideways inside its box with no cue: "Created" is cut in half and "Path" is hidden. | TS app-screens §12 "Tables become lists of two-line rows below about 640px" |
| M8 | 01 projects | Interrupted and cancelled creations are listed by session id (`sess-cancelled`) in monospace links; the idea is not shown, so the user cannot tell them apart. | TS app-screens §2.1 "words of the trade", §7.4 "IDs … truncated"; WIG Content "Resilient to user-generated content" |
| M9 | 05–09, 12 | A running creation's page is titled "New project"; the idea it is about is a grey quote under it. With two creations open the titles are identical. | TS app-screens §4.3 "A noun … the object's name"; WIG Content "`<title>` matches current context" |
| M10 | 21 chat card | While a card waits for the user the line under it says "Claude is answering…". The state is "waiting for you". | WIG Content & Copy (specific, accurate status); TS app-screens §2.1 "one name per time" |
| M11 | 21 chat card, 20 drawer | The confirmation card is told apart only by a thin blue border. Confirm and Decline have the same weight, and Decline is red as if it destroyed something. | BRIEF §2 confirmation cards stand out; TS app-screens §8.3 "One filled primary per screen" |
| M12 | 08 result | "Your project is ready." heads a result that then says "No project was recorded for this creation." | TS app-screens §2.1 "a fact shown twice is one variable" |
| M13 | 05–09, 03 | Status is carried by coloured left borders (green, blue, amber, red) on steps and agent cards and by bar colour in the timeline; red and green are the only difference between "failed" and "done" bars. The text status exists on cards but not on timeline rows. | WIG Content "Redundant status cues (not color-only)" |
| M14 | 12 cancel dialog, 17 revert dialog (dark) | The modal has no visible backdrop in dark and a 1 px border close to the page colour; the page behind reads as active. | WIG Design contrast; TS app-screens §13 "Shadows on what floats: a dialog" |
| M15 | 05–09 | The agent panel repeats the same facts three times (card meta, "Details" list, "Text view"), and the plan usage block sits under the details. The page is about 1,700 px tall at 1280 for one question. | TS app-screens §5 "One figure, one place"; §2.2 "what is left out" |
| M16 | 09 reply, 21 chat | The reply and chat boxes accept Ctrl+Enter, but the hint is a long sentence beside the field; at 390 it wraps into three lines. | TS app-screens §8.1; WIG Content handling |
| M17 | 23 proposal, 22 improvements | Long pages with no grouping: request, expected effect, real check, actions, changes, validation, tests, evidence and rounds are all h2 at the same level, one after another. | TS app-screens §2.2 "blocks as answers to its next questions"; TS critique pass 2 "squint" |
| M18 | 10 creations, 11 new project busy | "Waiting for: nothing: working" reads as a fault; the list has no idea of time (started, last activity). | TS app-screens §2.1 "words of the trade"; §11 states |
| M19 | 05–09 | "Cancel creation" sits at the very bottom of a long page, far from the creation's title; on a phone it is about 2,000 px down. | TS app-screens §12 "blocks that carry an action move up" |

### Low

| # | Screen | Problem | Guideline |
| --- | --- | --- | --- |
| L1 | 21, 23 | "1 lines added", "… 1 unchanged lines …": no singular. | WIG Content & Copy |
| L2 | 27 (es) | The Spanish menu says "Librería" (bookshop) for the library; "Biblioteca" is the word. | BRIEF §5 strings in `src/i18n/` |
| L3 | 05 (nav) | The active creations count is "● 1" with a bullet glyph; after a creation finishes it stays up to 4 s. | WIG Content "icons have text labels" |
| L4 | all | No `<meta name="theme-color">`. | WIG Dark mode |
| L5 | 03, 05–09 | Durations, percentages and clock times are not in tabular figures, so they jitter as they update. | WIG Typography "tabular-nums"; TS app-screens §9.1 |
| L6 | 01, 02, 19 | Absolute paths are set in a monospace that is wider than the body and wraps mid-word; in the projects table the path column is the widest. | TS app-screens §7.4 "the identity column gets the most width" |
| L7 | 13–16 | Library sections are a row of underlined links with the current one bold; they read as body links, not as tabs. | TS app-screens §4.4 tabs |
| L8 | 16 history | Every commit row has its own "Revert" button at full weight. | TS app-screens §7.8 "Row actions: … one … where it is needed" |
| L9 | 21 chat | "You" and "Claude" are 13 px grey labels; messages are not otherwise told apart. | TS app-screens §7.1 rows |
| L10 | 03, 05 | The timeline shows "0 s" on every row in short runs while the bars have very different lengths. | TS app-screens §6.4 "drawn honestly" |
| L11 | all | Focus uses the browser's default ring; it is visible, but not designed, and differs between native buttons and links. | WIG Focus "visible focus" (passes); BRIEF §2 one look |
| L12 | 22 improvements | Suggestions, the request form, open proposals and history are on one page with equal weight. | TS app-screens §2.2 |
| L13 | 25 no token | The gate screens are a bare heading and one grey line. | WIG Content "No dead ends" (the text says what to do; it is just faint) |
| L14 | 27 (es, 390) | "Sesión prin…" is cut in the timeline's 6 rem label column. | WIG Content handling |

## What passes

- Real `<button>` and `<a>` everywhere; no click handlers on `div`s.
- Every form control has a label; icon-only buttons do not exist.
- No `transition: all`, no animation, so reduced motion is respected by
  default.
- Status texts use `role="status"`, errors `role="alert"`, the chat list
  `aria-live`.
- No zoom blocking; the viewport meta is plain.
- `…` is used in loading texts ("Loading…", "Saving…").
- Dates and times go through `Intl` (`formatWhen`, `formatClock`).

## Not applicable

WIG rules for hydration, images, video, fonts from a CDN, `preconnect`, list
virtualisation and React-specific tooling: the app is a Preact SPA with no
server rendering, no pictures, a system font stack and short lists. The Taste
Skill page run (pictures, scroll scenes, motion floor) is for landing pages.

## Behaviour changes seen, recorded as proposals

These would change behaviour, so the UI pass does not make them (BRIEF §5):

1. Warn before leaving the library editor with unsaved changes (WIG Forms
   "Warn on unsaved changes"). Today the page shows "Unsaved changes" only.
2. The usage slider applies a profile as soon as it is released, with no
   confirmation and no undo.
3. The result screen could find the project of a creation by the project
   folder when the note has no session id, so M12 does not happen with real
   creations that skip the note.
4. (U3) The sessions list (`GET /api/sessions`) could return each session's
   idea (it is in the session folder's request), so the projects page lists
   interrupted and cancelled creations by what they were about (M8). The
   UI pass does not change the API.

## Status after U2 (2026-10-21)

Checked on every screen with `audit.shots.ts` over the U2 styles (output in
the git-ignored `screenshots/u2-audit/`), plus the components page.

| Finding | State | How |
| --- | --- | --- |
| H1 diffs unreadable in dark | closed | Added and removed lines in `--text` on `--ok-bg` / `--danger-bg`, both themes; one block per line |
| H3 what waits does not stand out | closed | Tinted sheet with a 4 px accent edge and a section-size title; first on a phone |
| H5 buttons in dark | closed | Styled buttons with a control edge (3:1); danger text and filled danger pass 4.5:1 in both themes (contrast test) |
| H6 navigation does not fold on a phone | closed | One sideways row of 44 px menu items under the logo, theme and chat |
| M1 no theme switch | closed | System, Light, Dark in the shell, kept per browser |
| M5 labels and fields on one line | closed | Label above, field, hint below, on every field |
| M6 native fields unstyled, under 16 px | closed | One control style and height, 16 px text, explicit colours (selects too) |
| M7 projects table cut on a phone | closed | One block per project under 640 px |
| M11 confirmation card weak, Decline red | closed | Waiting card tinted with the accent edge; Confirm primary, Decline secondary |
| M14 dialog without backdrop in dark | closed | Scrim 65% in dark, shadow, edge |
| L4 no theme-color | closed | `<meta name="theme-color">`, set to the ground by the theme switch |
| L5 figures not tabular | closed | Tabular digits in the panel, times, tables and counts |
| L11 default focus ring | closed | 2 px accent ring, 2 px offset, on every control |
| M4 headings inside rendered Markdown | partial | Sized under the page's headings; the heading levels in the markup are U3 |
| M13 status by colour alone | partial | Agent cards say it in words; timeline rows still only by colour |
| M16 long Ctrl+Enter hint | partial | Now a hint under the field; the text itself is U3 |

Every other finding is open and belongs to U3 (screens) or U4.

## Status after U3

Updated after each group of screens, checked on `audit.shots.ts` at 1280
light and dark and 390 light (git-ignored `screenshots/u3/<group>/`).

| Finding | State | Group | How |
| --- | --- | --- | --- |
| M4 headings inside rendered Markdown | closed | 1 creation | A note's headings are demoted two levels when rendered (`#` becomes `h3`), styled under the page's own |
| M9 a creation titled "New project" | closed | 1 creation | The creation's page is named by its idea (kept to three lines), under a "Creation" label |
| M12 "ready" with no project | closed | 1 creation | "Your project is ready." only with a project to show; otherwise "The creation finished." |
| M13 status by colour alone | closed | 1 creation | Timeline rows say the status in words beside the duration |
| M15 the panel repeats each fact | closed | 1 creation | The card holds model, time and counts; the details only what the card leaves out; plan usage moved to the side column, under the progress |
| M16 long Ctrl+Enter hint | closed | 1 creation | The hint under the field says what the text is for; "Ctrl+Enter sends" sits by the send button |
| M19 cancel at the page's end | closed | 1 creation | "Cancel creation" sits by the creation's name |
| L14 timeline label cut on a phone | closed | 1 creation | On a phone the label has the row's first line and the bar the second |
| H7 the chat drawer on a phone | closed | 2 chat | A title bar that stays, the conversation scrolling under it; on a phone a strip of dimmed page that closes it on a tap; focus moves in on opening and back on closing; Escape closes |
| M10 "Claude is answering…" while a card waits | closed | 2 chat | "Waiting for your answer on the card above." while a card is pending |
| L1 "1 lines added" | closed | 2 chat | Singular and plural in both languages for the card's counts and skipped lines |
| L9 You and Claude look alike | closed | 2 chat | The user's messages sit on a sheet, Claude's on the page |
| H4 Approve before the diff | closed | 3 improvements | The proposal reads in the order of a decision: request, changes, checks, then "Your decision" with Approve; the safety notice says to read the changes below |
| M17 a long proposal page with no grouping | closed | 3 improvements | Four blocks: what was asked, changes, checks (one card), the decision (tinted); evidence and rounds under "How it was prepared" |
| L12 the improvements page has no order | closed | 3 improvements | Open proposals first, then suggestions, the request form in its own card, then the applied ones |
| M8 unfinished creations listed by id | partial | 4 projects | A table by when they stopped, their status and the step's name, the id last; showing the idea needs the sessions list to return it, an API change, recorded as proposal 4 below |
| M18 "Waiting for: nothing: working", no time | closed | 4 projects | A "Started" column; what waits for the user is marked in ink with a dot, working is quiet ("nothing yet: it is working") |
| M4 "Next steps" said twice on a project | closed | 4 projects | A note that opens with the section's own heading drops it (`withoutLeadingHeading`, unit tested) |
| L2 "Librería" in Spanish | closed | 5 library | "Biblioteca" in every Spanish UI string |
| L7 library sections read as links | closed | 5 library | Tabs on a rule, the current one with an ink bar; they scroll sideways on a phone |
| L8 a full-weight Revert on every commit | closed | 5 library | One row per commit (subject, then commit, date and files), Revert as a small quiet action at the right |
| H2 an old tab after a restart | closed | 6 usage, settings | A refused token turns the whole page into "briefstack was restarted" with "open the new link from the terminal", and no retry; an e2e test covers it |
| L13 bare gate screens | closed | 6 usage, settings | Opening, no token, refused and restarted screens show the logotype and a card with a title and what to do |
| M2 the tab is always "briefstack" | closed | shell | Each page names its subject in the tab title (the project, the creation's idea, the proposal, the note), then "· briefstack"; an e2e test covers it |
| M3 no skip link | closed | shell | "Skip to content" is the first stop of every page; it moves focus to the page without changing the route |
| — list tables on a phone | closed | 4 projects | Every list table (projects, unfinished, creations, proposals, a project's history) becomes one block per row under 640 px |
