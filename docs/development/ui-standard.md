---
title: Console UI standard
description: The current enforceable visual, interaction, loading, navigation, and accessibility contract for every Agentic SOC Console page.
---

# Console UI standard

This is the current implementation contract for the Agentic SOC Console. It turns the
Cyber Defence Center visual language into reusable rules for every route. New work
must use these primitives; existing pages migrate toward them as they are touched.

## Migration contract

The shared shell, navigation rail, route-loading fallback, in-app Documentation
index, Case Manager, Settings frame, and Entity investigation workflow are the
current reference surfaces. Other routes remain supported while they move to this
grammar incrementally; a page is not called migrated merely because the shell around
it changed.

When touching an older page, include its loading/empty/error states, menus and
popovers, both themes, narrow layout, and keyboard path in the same change. Remove
page-local card, color, spacing, and motion inventions rather than layering new chrome
over them. Keep deep links and permissions stable, and record any intentional legacy
route in the feature registry and operator documentation.

## Visual character

The Console is a calm SOC command surface: near-black dark mode, quiet light mode,
hairline dividers, dense but readable information, and semantic color only when the
meaning warrants it. Avoid decorative gradients, nested cards, heavy resting shadows,
large rounded marketing panels, emoji status symbols, and animation that competes with
case state.

- Use `background`, `surface`, `card`, `border`, `foreground`, and
  `muted-foreground` tokens from `theme.css`; never add page-local hex colors.
- Use the shared severity/status/verdict/risk palette. Color supplements an icon or
  label; it never carries meaning alone.
- Prefer transparent sections separated by `border-border` over card-inside-card
  layouts. A card is reserved for a selectable record, contained editor, dialog, or
  genuinely independent widget.
- Controls are compact and quiet with concentric radii (`Button`, `Select`,
  `SegmentedControl`, `TimeRangePicker`); keep one visual grammar in light and dark
  themes.

## Foundations

Restraint is expressed through space, type, and one material for floating chrome, not
through new chrome. These rules are implemented once — `tailwind.config.js`,
`styles/theme.css`, `lib/ui-recipes.ts`, `components/motion/variants.ts`, and the
`src/ui` primitives — and pinned by `src/design-system/__tests__/foundations.test.ts`
and `src/ui/__tests__/foundations.round12.test.tsx`. Compose them; do not restate them.

**Spacing.** Tailwind's 4px scale on an 8px rhythm, in `rem` so zoom and text size
scale the layout. Dense inside, generous between: `1` (4px) inside chips and menu
insets, `2`–`3` (8–12px) between related controls and for row padding, `4`–`5`
(16–20px) for instrument and pane insets, `6` (24px) for column gutters, `8`–`10`
(32–40px) between bands, `12` (48px) only for sparse identity screens. The container
sets rhythm with `gap-*`/`space-y-*`; children never add sibling margins. One 16–24px
rail per pane; never stack page, pane, and panel padding.

**Radii.** One concentric scale on the brandable `--radius` (10px by default):
inner radius = outer radius − inset.

| Surface | Radius | Class |
|---|---|---|
| Badges, chips, menu and list items, tab triggers, segments | 6px | `rounded-sm` |
| Buttons, inputs, selects, segmented rails, cards | 8px | `rounded-md` |
| Menus, popovers, hover cards, tooltips, toasts | 10px | `rounded-lg` |
| Dialogs, sheets (leading edge only, from `sm`), the command palette | 14px | `rounded-xl` |
| Bands, list rows, tables, the KPI strip, split panes | 0 | divider-led |

A 10px menu with a `p-1` inset holds 6px items; a 14px dialog holds its own 8px
controls. Focus rings follow the element's radius. Use the `rounded-tr-xl
rounded-br-xl` pair rather than `rounded-r-xl`, which collides with the `r-xl` token
key. The 14px step is `--radius + min(--radius, 4px)`, so the brand "Square" preset
(`--radius: 0rem`) squares every step, dialogs and sheets included. A rounded side
sheet clips its children to the curve (`overflow-hidden`), so a full-bleed child with
its own fill never paints square corners over it.

**Typography.** Inter Variable stays the face (identical metrics offline, tabular
figures, the `ss01`/`cv01`/`zero` sets that keep IOCs legible). Tracking is
size-specific and follows Inter's dynamic-metrics curve, carried by each `fontSize`
step: +0.005em at 11px, 0 at 12px, −0.003 to −0.011em from 13 to 16px, tightening to
−0.022em at 32px. Do not add `tracking-tight`/`tracking-wide` on top of a size step.
Leading is inverse (looser body, tighter display); `leading-none` only on single-line
numerals. Hierarchy comes from weight + size + leading together; weights stay 400–650.
11px (`text-2xs`) is for badges, axis ticks and timestamps only; content text,
legends, captions and stat context are 12px or larger.

**Numerals.** A numeral never truncates and is never broken inside its digits: no
ellipsis, no clip, no `break-words` split, because a cut number is a plausible wrong
number ("≥77,77" over "7"). Nothing shares its line — a metric's context sits on its
own line under it and wraps, a delta chip wraps under it when the row is short, and a
tile's corner icons (help, drill-down) sit in the label row's corner, which reserves
their width, never over the numeral. The hero ladder counts what is drawn, the `≥`
floor mark included. `KpiTile` then measures the numeral against the row it is really
in and steps the size down — then abbreviates through `formatCompact`, with the exact
value as text, and keeps measuring the short form (it starts on the size its own length
earns and steps down again) — until it fits; only a value with a real space may take a
second line, after the smallest step. The smallest step is the floor (18px): a cell whose
numeral row is narrower than the short form at 18px (under about 100px of tile) cannot
hold a number, so never lay one out that narrow — `KpiTileGrid` keeps every tile at
least 10rem wide. `KpiTile size="fluid"` sizes the hero numeral from its own
tile, never the viewport: the numeral row is a size container and the rungs are `cqi`
clamps (25 / 20 / 15% of the row, 24–44px on the top rung) with −0.021em tracking.
Use it inside a sized cell. Tile grids use `KpiTileGrid`, whose column count follows
the tile count, so a grid never draws an empty track.

**Materials.** One translucent material, for floating chrome only: the top bar, sticky
page/control/filter bars, a sticky table or record header. Use the `materialBar`
recipe (or `materialThick` for large floating panes, or `MaterialBar` from
`@/design-system`); never a page-local `bg-*/95 backdrop-blur`. Content — tables,
charts, transcripts, evidence — always sits on an opaque canvas or card, and menus,
popovers, dialogs and sheets are solid, so translucent never stacks on translucent (a
material nested in another material, or in the glass top bar, is painted solid). Fill
opacity stays at or above 0.80 so 12px secondary text keeps AA; on a material, small
text uses `text-foreground` or `text-secondary-foreground` at `font-medium`, and colour
lives on solid chips (a sticky table header lifts its column labels to
`text-secondary-foreground`). Under sticky chrome the scroll-edge fade replaces a hard
divider: `PageHeader`, `ControlBar`, `FilterBar` and `TableHeader` with `sticky`,
`MaterialBar` and the Settings section strip show it only while content is scrolled
beneath the pinned bar (`useScrollEdge` / `useScrollEdgeRef`), and drop their own
hairline while pinned. The fade hangs below the bar, so a material never sets `overflow`
on itself (a horizontally scrolling row goes inside it). Each recipe has its own opaque
token (`--material-solid`: the background for a bar, the popover colour for a thick
pane), which both the fade and every solid fallback paint, so neither changes the surface's
colour. Never animate `backdrop-filter`. `src/design-system/__tests__/material-gate.test.ts`
fails on a new page-local blur or translucent sticky fill.

Sticky chrome needs a scroller that actually scrolls. The shell clips horizontal
overflow with `overflow-x-clip`, never `overflow-x-hidden`: a lone hidden axis turns
the element into a vertical scroll container that never scrolls, and every sticky
descendant — the top bar included — then leaves with the page. Pin below the top bar
with `top-[var(--header-h)]`, never a bare `top-0`/`top-4` in a window-scrolled page. A
full-width sticky bar (anything on the material) pins FLUSH at `top-[var(--header-h)]`:
an offset such as `calc(var(--header-h)+0.5rem)` leaves an unpainted slit between the top
bar and the bar through which scrolled content shows. Want breathing room? Pad inside
the material. A `calc()` offset is only for a sticky aside in its own column (a section
rail), which no content scrolls past. `material-gate.test.ts` fails on an offset material.

**Elevation.** Borders for tiled and scrolled content; shadows only for detached
portals. Menus and select lists use `shadow-menu`; popovers, hover cards, tooltips,
dialogs, sheets and the palette use `shadow-overlay`. No resting shadows on
instruments; `hover-lift` only on genuinely clickable standalone tiles. Modal tasks dim
the page with the shared scrim; a non-blocking side pane gets no scrim.

**Motion.** One spring vocabulary (`components/motion/variants.ts`): `SPRING_UI`
(critically damped, `bounce: 0`, 0.3s visual duration) is the default for tabs,
disclosure, row reflow and the bulk bar; `SPRING_PANE` (0.35s) for sheets, side panes
and the report panel; `SPRING_MOMENTUM` (a little bounce) only after a pointer release
that carried velocity, never for click-driven motion. `HOUSE_SPRING` is a deprecated
alias of `SPRING_UI`. Exits are short tweens. CSS overlays use the same curve through
`ease-spring` (a sampled critically damped `linear()` where supported) with
`duration-ui` / `duration-pane`. Overlays scale from their trigger: menus, popovers,
hover cards, tooltips and selects zoom from Radix's `--radix-popper-transform-origin`
through one base rule in `theme.css` (no per-primitive class), and a
dialog opened from state passes `origin` (the trigger's centre) to `DialogContent`.
Enter and exit follow the same path. Press feedback is immediate: buttons settle to
97% in 100ms on pointer-down (`motion-safe` only; link-styled buttons never scale),
and full-width rows darken on `:active` instead of scaling — the `Button` base does
this for any `w-full` button. Animate `transform` and
`opacity` only, from the current value, and never lock input during a transition.
Data on an automatic refresh never animates (`KpiTile roll={false}`).

**Accessibility media queries.** All three signals are honoured.
`prefers-reduced-motion`: JS motion keeps only opacity (`MotionConfig
reducedMotion="user"`), CSS overlays swap their scale/slide keyframes for a 150ms
opacity-only cross-fade, and press scale is dropped. `prefers-reduced-transparency`
(and `data-transparency="reduced"` on `<html>`, the in-app override for browsers that
never report it): every material and the top bar become solid. The override is the
per-user Settings → Appearance & customization → "Reduce transparency" choice
(System / On), stored in `UserPrefs.misc.transparency`, mirrored on the device in
`soc.transparency` and stamped before first paint by `index.html`
(`design-system/transparency.ts`); Safari never reports the media query and Firefox
only behind a flag.
`prefers-contrast: more`: hairlines become ≥3:1 structural lines — including the
alpha hairline variants (`border-border/70` and the like), through the
`--border-alpha-floor` the `border` colour carries — secondary text strengthens (and
is never weaker than muted text), the login identity canvas strengthens its own
borders, field edges and text, and materials turn solid with a defined bottom rule
instead of the scroll-edge fade.

## Page anatomy

Every routed page follows the same order:

1. `PageContainer` owns the width (`fixed`, `wide`, `fluid`, or `prose`).
2. One `PageHeader` owns title, description, status metadata, and primary actions.
3. Optional controls occupy one compact `ControlBar`/`FilterBar` band.
4. Content is organized into flat sections or shared data/table/chart components.
5. Loading, empty, denied, error, and partial-data states occupy the same geometry as
   the final content so the layout does not jump.

Do not repeat a page title inside the first content panel. Do not add an eyebrow such
as “Decision brief” when the actual outcome heading is already explicit. A nested
workflow can have its own section label only when it adds information.

Tabbed or embedded leaves yield width, heading, and page-action authority to their
host. They may contribute a labelled `ControlBar`, but must not nest another
`PageContainer` or detach an unlabelled refresh row. Queue filters and refresh actions
belong in that control band; `PageHeader` stays focused on route identity and the
single primary action.

`ControlBar` adapts to its own available width, including inside a split pane. Put the
task-defining controls in its primary slot so they remain first in visual and tab order;
lower-priority fields, selects, and segmented controls belong in the secondary slot and
wrap after them. Only simple button-like commands may use the overflow-action contract:
they stay inline on a roomy desktop band and move behind one visibly labelled **More
actions** menu below the shared component breakpoint. Menu items keep visible text,
disabled and consequential styling, Radix arrow-key/Enter/Escape behavior, and return
focus to the trigger when the menu closes. Never move form fields, value selectors, a
sole primary action, or an in-progress command into overflow. Keep `role="group"` for
ordinary independently tabbable controls; do not advertise `role="toolbar"` unless the
implementation also supplies the toolbar roving-focus keyboard model.

## Empty-state semantics

Use the shared `EmptyState` with an explicit `state` whenever a Console surface has
loaded but cannot render its ordinary content. The state is an operator truth, not a
decorative tone:

- **`first-use`** — the capability is available, but its prerequisite configuration
  or first record has not been created. Name the missing prerequisite and offer the
  safest create/configure action when the operator is allowed to take it.
- **`no-data`** — the requested scope loaded successfully and contains no records.
  State that scope without implying success, failure, or a disabled capability.
- **`no-results`** — records may exist, but the current search or filters exclude all
  of them. Preserve the operator's filters and provide one clear/reset action.
- **`success`** — absence is the confirmed desirable outcome, such as a completed or
  clear attention queue. Say what was checked and what the operator should do next;
  do not infer success from missing, degraded, or unavailable evidence.
- **`unavailable`** — a known disabled, unsupported, or unmet prerequisite prevents
  the content from being produced. Explain the prerequisite and the safe recovery;
  a request failure remains an error, and authorization denial keeps its own gate.
- **`error`** — a load or operation failed. Keep the failure actionable, preserve any
  usable stale content, and offer Retry when safe. Legacy `variant="error"` remains a
  compatibility alias for this semantic state.

The title names the outcome; the description says why content is absent and gives the
next safe action. `EmptyState` supplies the state-appropriate marker and accessible
group/status/alert semantics. Do not use a calm no-data state for a failed request, or
celebrate a clear queue unless the loaded evidence proves it.

## Queue and detail workspaces

A desktop list/detail split uses one hairline, focusable separator rather than two
unrelated cards. Pointer resizing and keyboard resizing are the same operation: Arrow
keys make a documented small step, Shift+Arrow a larger step, Home/End reach the safe
bounds, and double-click resets. Clamp both panes to usable minimums, persist only a
presentation preference locally, and remove the handle below the desktop breakpoint;
compact layouts use an explicit back-to-list path.

A routed split workspace may reclaim the shared shell gutter down to a consistent
16px operational inset, but it remains framed rather than touching the navigation or
viewport edge. Inside the detail pane, header, tabs, and every tab panel share one
responsive 16–24px content rail. Do not stack page, pane, and panel padding into
separate 32px gutters; the resizable detail pane must spend its width on evidence.

Queue rows are a divided list, not boxed cards. A row has two lines: the title and its
relative age, then the severity word, risk score, display id, a secondary fact only
when it adds to the title, and the status as sentence-case text with its glyph. The
word carries severity; a left rail only reinforces it (solid for critical and high,
dashed for medium, none below). Hover, keyboard focus, selected (checked box and a
light tint) and open (a stronger tint, a primary edge rail and `aria-current`) never
look alike. Labels and titles are sentence case, never tracked capitals. Panels inside a
resizable pane lay out against the pane width with container queries, not the viewport.

The Case Manager queue (Round 12) keeps that grammar and adds to it. Its scope (Active,
Mine, All), filters, search and sort are answered by the server over every case, paged
with Load more, and the scope line always states loaded against total; a client-side
filter of a recent window is never the queue. The comfortable row may carry a third
line (the middle-ellipsised id and the secondary fact, which shrinks first and hides in
a narrow queue but stays in the row's accessible name); a compact density is one line.
The second line names the case outcome (§ Case outcome) beside severity and risk. The
list is one tab stop with a roving focus (↑/↓ or J/K move and open, X or Space select,
Enter moves into the case, / searches, ? lists the shortcuts) and rows update live from
the `cases` realtime topic. A live change is checked against the whole view (scope,
status, owner, search, severity): a row that no longer matches leaves the window and the
total, a case that now lists inside the loaded window appears, and Load more re-reads the
window rather than skip a case when the live order has shifted. "N new cases · Show"
re-reads the window grown by the new cases, never just the first page, so rows the
analyst loaded (and the open case) keep their place. When the open case leaves the view
(a plain Close, or a live change), the roving stop moves to the row that took its place
and the first J/↓ (K/↑ when the last row closed) or Enter opens that row rather than
skipping it. A count that claims an exact total (the Cases "Needs human" tile) is made
from structured filters (status, AI verdict), never the free-text search. A single-letter shortcut
never fires while focus is in a control that takes letters itself (text, a select, a
menu, a radio group).

Row selection is independent of row navigation. “Select visible” means the filtered
rows in the loaded client window and never implies every server match; "Select all N
matching" is a separate, explicit control that snapshots the server's matches. A row
checkbox is a sibling of the row's open control, never nested in it; it may appear on
hover or focus, but stays visible on touch screens and once anything is selected (the
Case Manager shows it always). Mixed bulk operations expose progress and per-record
partial failures; successful records leave the selection while failures remain
retryable. Every bulk or single path that ends a case (close, resolve) collects a
disposition first. Permission hiding in the Console is guidance—the API must recheck
every action.

**Case outcome.** Status answers "where is the work", the outcome answers "what was it"
and the AI verdict answers "what did the model think"; the three never share a style
(status is glyph and text, the outcome a filled disposition badge with an `Analyst`
tag, the AI verdict an outline chip with the AI glyph). Once an analyst classifies a
case (the classification history entry, exactly as the ground-truth authority reads
it), the classification is the headline ("Closed as false positive") and the AI verdict
stays as a labelled secondary line. One shared helper decides it for the case header,
queue rows, the Cases list, hover cards and grading; a disposition value alone is never
treated as an analyst's call.

**Case header.** The header stays put above every tab: the title (one line in a narrow
pane, its full text on hover and in its accessible name), one meta row (id, severity,
risk with its band, status, outcome, AI verdict, owner, tags, times and SLA, campaign),
one primary contextual action plus the full Take action menu. Facts about the case live
once, in a facts rail beside every tab (a non-blocking Details sheet in a narrow pane);
the tabs hold the evidence narrative. The title shares its row with the actions only
when the whole title fits beside them; otherwise the actions wrap below it, so the title
is never squeezed. Lifecycle dialogs keep their actions in a footer that never scrolls
away, open with focus on the field the analyst must fill (the disposition), and return
focus to the control that opened it, or, when that control left with its row, to the
row that took its place ("Close & next" lands on the next case's row). The confirmation
after a close offers **Reopen**, never "Undo": reopening keeps the recorded outcome until
the case is closed again with a new one, and the toast says so. Closing a Needs-human
case the analyst did not grade records no AI agreement either way; a grade the analyst
does give there (or on a duplicate close, or a case with no AI verdict) carries no
assessment, and the Agreement rate counts only grades that compare with the AI verdict.

Campaigns is analyst-first. The default **Campaign review** workspace owns the current
group list, detail, and read-only refresh; manual correlation and saved cadence belong
only in the permission-gated **Policy & schedule** workspace. Do not append the policy
editor below the analyst queue or expose mutation controls to read-only roles. Each
workspace keeps its own stable loading, error, and empty geometry, while campaign
grouping remains advisory and never becomes deterministic case-decision authority.

## Case investigation-input provenance

Case Manager may disclose the context and platform configuration recorded for one
investigation run, but it must never turn global feature availability into case
provenance. Project the **latest run only** and render applicable inputs conditionally:

- approved operator **memory consulted**;
- indexed **RAG knowledge retrieved**;
- **runbook references retrieved** through RAG, separate from playbooks;
- a **playbook actually injected and consulted**, never merely selected; and
- an immutable **platform threshold-tuning snapshot** for a correlation threshold or
  severity floor that this case traversed.

Call the last item threshold tuning, not model fine-tuning. The summary belongs in the
flat Overview evidence flow and links to detailed Investigation evidence; do not add a
nested feature-badge card. Hide a successful empty section, preserve a stable loading
geometry, and distinguish an unavailable projection from “no inputs.” All displayed
model, memory, retrieval, and operator-authored strings remain plain untrusted text.
Close the section with the authority boundary: these inputs may inform preprocessing
or the agent assessment, while deterministic case policy makes the final route.

## Conversation workspaces

Workspace Chat is a three-zone conversation workspace: a history rail, the
conversation, and an on-demand report panel. Zones follow the **measured** width of
the chat frame (a ResizeObserver), never viewport breakpoints, because the app
navigation rail (240 or 64 px) and the shell gutter have already taken their share.
The conversation always keeps at least 640 px:

- The history rail docks at 264 px plus a hairline while the frame minus 265 px still
  leaves 640 px; below that it becomes a 48 px icon strip (New chat, Search, Show
  history), and below a 640 px frame a left Sheet opened by **History** in the toolbar.
  A viewer may collapse the docked rail to the strip; that choice persists locally.
- The report panel opens as a split column (default 360 px, 320–480 px, plus its 9 px
  separator handle) only when the conversation keeps 640 px, collapsing the docked rail
  to the strip first if that is enough; otherwise it is an overlay Sheet. The split
  reuses the queue/detail separator idiom: one focusable 9 px handle around a centred
  1 px hairline (`role="separator"` with value attributes), arrow keys in small steps,
  Shift for larger ones, Home/End, double-click to reset, pointer drag, and a width
  persisted per viewer. Split mode never moves focus; the overlay moves focus to the
  panel heading and returns it on close. The first Add to report of a conversation
  opens the split without moving focus; in overlay geometry it never auto-opens, and a
  toast offers **Open** instead.
- Exactly one **New chat** is visible at every width: in the docked rail header, in the
  icon strip, or in the toolbar when the rail is a Sheet.

**Chrome.** The Chat route owns its frame: it bleeds the shell's whole inset with
`-mx-4 -my-6 sm:-mx-6` and `w-auto` (the matched pair of `CONTENT_INSET`'s
`px-4 py-6 sm:px-6`), so the rail, strip and report panel sit flush with the nav rail and
the window edge with no canvas strips beside them, and it is exactly
`h-[calc(100dvh-3.5rem)]` tall, so the document never scrolls at 1280×560, 1440×900,
1920×1080 or 390×844. The frame is `overflow-clip`, never `overflow-hidden`: a clipped box
cannot be scrolled by a `focus()`, a contents jump or find-in-page, so the toolbar never
slides under the header and no blank band opens below the composer. It
does not sit inside a `PageContainer` or `PageHeader`. Headings: one `sr-only`
`<h1>Chat</h1>`; the thread title is the 44 px toolbar's `<h2>` (click to rename, full
text in a tooltip); every turn has a hidden `<h3>`. The toolbar holds, left to right,
History (Sheet mode only), the title, the conversation total ("12.4k tokens · $0.03",
inline from 560 px, otherwise in the ⋯ menu), **Report** (with a count badge only when
the analyst has added items; its tooltip and accessible name say "items you added from
this chat", never "Report · 0"), New chat (Sheet mode only) and ⋯: Rename, Pin
conversation, Export conversation and Delete once the thread is saved, and **Width**
(Comfortable, Wide, Full width) on drafts too. Tooltips of History, Collapse/Show history and New chat name
their shortcut (Ctrl/⌘+Shift+S, Ctrl/⌘+Shift+O); `aria-keyshortcuts` carries the
machine form. An inline rename (title or rail row) returns focus to what it replaced,
and a rename started from a menu begins only after the menu has closed, so the menu's
focus trap cannot pull focus out of the field.

**Lane.** One lane, two edges (`message/lane.ts`). The conversation zone is an
`@container`; the lane is `min(conversation − 2·gutter, cap)` with the gutter
`clamp(1rem, 2.5cqi, 2.5rem)` and the cap the viewer's **Width** preference: Comfortable
64rem, Wide 88rem, Full width (no cap, the default since the Round 12 final review, so with
the side menus collapsed the conversation fills the screen), kept in localStorage and
`UserPrefs.misc.chat_lane_width` (written through the prefs provider, so the choice
survives leaving Chat and coming back; a stored Comfortable or Wide choice is kept, and the
menu marks Full width "(default)"). However wide the lane, prose never widens with it:
prose, notices and the run log keep a ≤ 48rem
measure on the lane's LEFT edge (never centred), and so do the bare prose blocks a model
may add (`markdown`, and `callout`, whose box sits on the prose edge like a notice);
answer blocks span the whole lane from that edge, and a framed card hangs into the gutter
by its border and padding so its title and table text start on the prose edge; the user bubble sits on the lane's RIGHT edge; the composer,
follow-ups and a meta row under blocks span the lane. The gutters are grid tracks, never
padding, so the transcript and the composer resolve the same edges. Every exchange repeats
the same three-track list (an off-screen exchange uses `content-visibility: auto`, whose
layout containment turns a subgrid into a plain grid) and each message subgrids its
exchange, so every turn and the composer share the same edges. The scroll lane is
`relative`, the containing block of every absolutely positioned descendant (the sr-only
turn headings), so none can escape its clip. A `kpi_group` (a period comparison's tiles
included) uses `KpiTileGrid` with as many
columns as figures (never an empty track). Inside a framed host (a block card, an entity's
own frame) it draws no frame of its own and hangs by the tiles' padding, so every label and
numeral starts on the card's content edge, the same edge as the card title and the prose;
where nothing frames it (a report leaf, the expanded sheet, a report panel item) it keeps
its own closed frame. Its static and print form, an entity's counts included, has no tile
buttons and puts each change chip on its own line.
The
transcript is the only scrolling region and the composer stays docked below it in the
empty, restoring, error and populated states. The empty state is top-aligned in the
lane, never a centred marketing panel.

**History rail.** New chat and a server-side content search sit in the header; a hit
shows a snippet under its title and opening it scrolls to and highlights the matching
message. Groups are Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, then
month; the group labels label `role="group"` lists and are not headings (the page
outline is h1 Chat → h2 thread title → h3 turns). Rows are one line (title and a quiet
relative time, with the full title and exact date in a tooltip) whose accessible name
is "title — exact date · N messages"; the active row carries `aria-current`, and ↑/↓/
Home/End move between rows through a single roving tab stop that always lands on an
existing, enabled row. The row menu offers Rename (inline, IME-safe), Pin/Unpin, Open
report (when the thread has one; disabled with its reason while another thread's turn
runs), Export and Delete; Delete confirms that the report stays in Reports and is
disabled for the thread a turn is running in. History truth is fail-closed: a read failure is an explicit
retryable error, never the calm **No previous conversations** state. The footer
discloses retention when history was truncated or at least 45 conversations exist.

**Turns.** A user turn is a compact muted bubble, right-aligned, at most 36rem, showing
the display form of the prompt. An assistant turn is unboxed with no avatar. While it
runs, the run log sits expanded under the user turn: one row per tool call or framed
parallel batch, each with a status icon and status word (Done, Failed, Timed out,
Denied, Skipped, Stopped), the engine label, parameter chips including the effective
window and source, the summary, rows/basis/coverage, the duration and the exact query
behind a collapsed disclosure rendered as untrusted code. Model steps add no rows except
the step the turn is waiting on and a failed call; their tokens tick on the header
("Working · 3 lookups · 1.2k tokens · $0.002"). The log collapses when answer text
starts. A finished turn reads answer → blocks → meta row → follow-ups (latest turn only).
The meta row is one 28 px `text-xs` line: a disclosure that reopens the run log in place
("4 lookups · 6.2 s"; "Answered in 1.1 s" without lookups), the token figure that opens
the usage details (a popover: click, tap, Enter, or hover with a mouse), **Sources n**,
and the Copy / Good answer / Bad answer / Add to report / Add to case / Ask again icon
actions — always visible on the latest turn and revealed on hover or focus-within on
older ones by opacity, never `visibility: hidden` (a hidden control cannot take focus),
with their space reserved. Below a 30rem meta row the thumbs stay and the other actions
move into one ⋯ menu, so the row's figures stay whole.
A turn without recorded usage reads "Usage not recorded · —", never 0, followed by the
model and source it ran on when known; Demo Mode appends "simulated". Quiet lines
follow when relevant: a memory echo or proposal (confirmable only with
`memory:manage`; a removal first resolves its ids and lists exactly the facts it would
forget, skipping unknown ones) and the not-saved line: **Not saved**, the notice's own
sentence, and, when the save can be retried, **Run again to save** with "asks the model
again and uses tokens again" (honestly a new, billed run, not a save-only retry).
Restored turns render collapsed. Aim for no more than 40 px of chrome per historical
turn.

**Add to report.** The answer and block toggles keep one stable name and use
`aria-pressed` for "In report ✓". They never unmount while a request is in flight
(a click then is ignored) or when the report is full: the answer toggle becomes
`aria-disabled` with the reason ("Report is full (60 items)") in its tooltip, a new add
is refused with that reason, and an item already in the report stays removable.

**Answer features (Round 12).** A clarify answer shows its question in a card with up
to four option chips and "Something else…" (a pick is `origin: clarify`, typed words are
the analyst's own); the card says "Needs input" on the latest turn and becomes a quiet
"Asked: …" line once answered. A lookup that matched nothing offers the engine's
widen-the-search chips LAST, below the follow-ups: they load after the answer, so they
only append (nothing above them moves, and a chip a shown follow-up already asks is left
out instead of removing that follow-up). Every settled lookup in the run log has
**Inspect**, a side sheet that opens on its title, with what was sent (an input shown as
untrusted is not repeated as a plain value), its time, rows and tokens, and the stored
observation the model saw as untrusted text. In both halves (untrusted inputs, the query
as run, and the observation) invisible and bidi characters are written as visible `\uXXXX`
escapes as the model read them; a copy cut for storage says the model saw the full result.
**Explain this step** and, for a failed lookup, **Retry step** name the answer by quoting
its question (step numbers restart in every answer) and, when several answers replied to
the same question, by its recency ("your second most recent answer to …"). The thumbs are
one single-choice group ("Rate this answer", radios, one tab stop): a rating can be
changed, not withdrawn. Thumbs down opens a reason panel (Wrong, Incomplete, Slow, Other,
an optional comment, "never used to train a model"), scrolled clear of the transcript's
bottom band; **Add details** beside a down rating reopens it. The stored rating shows on
reload. A report the server saved reads "Saved to Reports · title · Open · Export"; when
that save failed and may work later, **Save as report** saves the same report once per
answer and records it on the answer. **Add to case** previews the exact comment as plain
text (no Markdown syntax; a cited `[D1]` marker is kept and resolved by a "Sources:" list
at the end, an uncited one is dropped), picks the case from a single-choice list with a
result count, and posts only after a case is picked; chart and table blocks stay in chat.
A long answer gets a one-line contents row and **Jump to end** (an in-flow end marker, so
it lands where the answer ends), and Ctrl/⌘+Shift+C copies the latest answer under the
chat shortcut rules (the typed character decides, never during IME composition or on
repeat, and never while a dialog or sheet owns the keyboard). An investigation brief is
labelled "Advisory — the case decision is made by policy (decide())" in chat, in the
Reports library, in Print and in every export.

**Notices.** Partial, denied, timeout, provider, breaker, cancelled, unsupported, limited,
stopped-repeating and budget notices are one callout at the top of the answer, with
Retry only when the notice is retryable. Chat has no answer limits (Round 12 SPEC D2/D3):
there is no Continue chip, and a limit never earns a "Partial" label (that word is kept
for a real failure); in the operator's bounded mode a capped answer says so in its
callout. A summary of earlier messages is a quiet line and a run-log note, never a
callout; continuation and a very long investigation's wrap-up are run-log notes. An
unsupported answer names a console page only when one resolved. A failed turn offers **Retry same request** (same idempotency key) or, when retrying
cannot help, **Ask again** (a new key). A locally stopped turn says "Stopped. The saved
version appears after refresh." The daily AI budget never limits chat (Round 12 SPEC D5):
it bounds automatic investigations, and chat's spend is recorded in the cost ledger without
counting against it. So budget state appears as one window-neutral, dismissible warning
above the composer that says what happens to automatic investigations ("paused until it
resets, so new cases wait for an analyst") and that chat keeps answering; it never uses a
critical tone, never says AI answers are paused, and a spent budget never disables Send.
Only the optional chat cap, off by default, stops a chat answer, and then the answer's own
budget notice says so.

**Composer.** A textarea over ONE 32 px control row of 28 px chips, about 86 px at rest and
never more than 88 px; there is no permanent footer line. Left: the **Read-only** chip (it
opens the access popover), the Scope chip (source and time range in one popover) and removable
`@` scope chips. The Scope chip reads "<source> · <range>": the source truncates, the range
never does. Its time presets sit in a three-column grid of radios (`SegmentedControl
orientation="both"`, so every arrow key moves to the next or previous preset); the default,
**Auto**, chooses no range and names its meaning to screen readers, and **24h** is a separate
explicit range, so the chip never shows "24h" for a default that is not 24 hours. Right: the token estimate with the context-window ring (the next request ÷
the model's `context_window`, "<1%" rather than "0%" for a real share; never today's spend),
Options ⋯ (Model, Type out
answers, Saved prompts, Keyboard shortcuts) and Send, which becomes Stop while a turn runs.
Below 560 px of composer width the Scope and `@` chips merge into "Scope · n", the placeholder
shortens to "Ask… / for commands, @ to scope" so it stays on one line, the **Read-only** chip
shows only its lock (its accessible name is unchanged), and a non-default model chip turns
icon-only but stays visible and removable. The Case Manager composer has no menus and
reads "Ask about this case". In the `/` and `@` menus only Enter chooses; Tab keeps its focus
meaning and never sends a command or adds a scope, and the `@` menu waits for the tool
catalogue. A command that takes a value fills the composer and selects its placeholder rather
than sending, so the value goes out as the analyst's own text. A blocked Enter announces its
reason and adds it to the field's description. Esc closes the topmost layer first and stops a
running turn only from inside the composer with no layer open. The meter card is a Popover
(mouse hover, click or tap; it never takes focus), because a HoverCard trigger cancels taps on
touch screens. It leads with the context window ("12% used · ≈ 24k of 200k tokens" and, in
unlimited mode, "summarised automatically near the limit … no hard cap"), then the next
request, and ends with the daily AI budget: a bar, the spend, and the note that automatic
investigations count against it while chat is recorded but never paused by it. When the tool catalogue cannot load, one line, "Couldn't load what the assistant
can access.", with **Retry** replaces the access list and the empty-state starters.

**Scrolling and announcements.** On send, the user turn moves to the lane top with a
48 px peek of the previous turn; the lane follows new content only while the reader is
within 72 px of the bottom and only until that turn's top reaches the lane top.
**Jump to latest** shows whenever any content is hidden below the fold (more than 8 px),
as a round pill centred on the lane's bottom edge over a band the lane fades out with a
scroll-edge mask while the pill shows, so it never covers a line of text, a chip or a row.
The mask spares the scrollbar gutters (the thumb and arrows stay visible), and a
transparent band inside the lane takes the pointer over the faded strip, so nothing that
cannot be seen there is clickable or hoverable, while wheel and touch still scroll. The
pill's focus ring is never clipped (the compact embed's bar keeps room above and below
it). After a jump, or when a thread opens, the lane sticks
to the bottom while a turn runs or late content lands (lazy answer blocks), until the
reader scrolls, points or focuses inside it; content growth is observed, so **Jump to
latest** returns whenever new content lands below a reader who scrolled away. A requested
message that is not in the restored thread is dropped and the thread opens at its
latest turn. Reduced motion means no smooth scrolling and no typewriter effect.
Off-screen exchanges use `content-visibility: auto`. The transcript is `role="log"` with
an explicit `aria-live="off"` (the role is implicitly polite and would read every
delta); every announcement ("Working", throttled step progress, "Answer ready",
"Stopped", "Error: …", "Added to report (n items)") goes through the shell announcer.
Focus never jumps on new content, and an action whose control is replaced or disabled
by the send — a starter, a quick action, a follow-up, Continue, Ask again, Retry, Jump
to latest — hands focus to the composer instead of dropping it to the page.

**Truth and persistence.** A new conversation is a local draft until its first answer
is saved; selecting a thread restores the server transcript and its time range in the
still-mounted frame, with **Retry** and **Start new chat** on a restore failure. The model
returns to the default and the source to **All sources**, and `@` scopes are cleared:
the stored model and source are what the server resolved for the last turn, not the
analyst's choice, so adopting them would pin both on the next question. Each restored
answer still names the model and source it ran on.
Drafts are kept per thread and never written to the server. Every persisted turn
carries one stable idempotency key; a turn whose first model call failed is shown but
never enters model history. A deep link (`#/chat?conversationId=&messageId=`) selects,
scrolls to and highlights the message for 2 s and is cleared from the hash once the
selection moves; a missing thread reads "This conversation is no longer available".
History is bounded (50 conversations, 10 of them pinnable beyond the limit) and every
boundary is disclosed rather than inferred. Since Round 12 no message is removed: the
transcript opens on the newest 100 messages, and a quiet **Show earlier messages** control
above the first turn (with how many remain) pages older ones in, 50 at a time, keeping the
reader's position: the first message in view is measured before the load and the lane is
scrolled by exactly how far it moved. The control keeps focus through loading (never
`disabled`), shows an error with Retry, and gives way to "Start of the conversation".

**Case Manager chat** is the same engine scoped to one case: compact presentation, its
one-line status and quick actions, the compact composer, no rail, no report panel and no
Add to report. Case turns never enter personal Workspace history.

**Context failures.** When `/chat/context` fails with nothing cached, the empty state and
the composer's access popover say so with **Retry** (in Workspace and Case Manager
alike); they never show skeletons or "Checking…" forever.

**Chart interactions (Round 12).** Every chart interaction is client-side and read-only,
never a re-query or a model call, and is stated wherever the chart travels: **Group by**
re-bins a calendar series only to a unit the server allowed (`allowed_rebin`) and the
caption, table, Copy data, CSV and image say "grouped by month"; **zoom** on line and
area charts keeps a zoom row on screen at all times (a hint before a zoom, then the range
and **Reset zoom**) so the plot never moves under the pointer, and is dropped when the view
changes; **legend toggles** keep at least one series and say "Showing 1 of 2 series";
**Download PNG / SVG** draws the chart as shown, in the card's theme, with its grouping,
zoom and hidden series written on the image; **Full width** lets one block leave the
conversation lane for the conversation's gutters and is offered only when there is room to
gain (under Comfortable or Wide, never in a Full width lane). Line charts with 2 to 4 series
label each line's end with as much of its name as fits in a quarter of the chart (never fewer
than 14 characters), with the whole name as the label's hover title when it is clipped. Calendar axes name their time zone and draw the in-progress period lighter with
"(in progress)".

**The working indicator (Round 12).** While an answer is being written, the Chat item
shows one glyph in every navigation form (expanded rail, collapsed rail, mobile sheet):
a turning quarter arc while running, an accent dot for an unread answer, amber for a
question waiting for input that the analyst has not opened yet, red for a failure; its
text ("Chat: 1 answer in progress: <title>") is the item's description, never a live
region. Glyph and text come and go together: a question already looked at keeps "Needs
input" on its history row only, and a fresh visit to Chat opens the newest conversation
rather than that thread. Reduced motion keeps the same
static arc and the tooltip says "Working"; forced colors use system colors. The optional
ring around the logo tile follows `chat_agent.animated_brand`; an operator's logo itself
never moves. The tab title takes a "●" (running) or "✓" (unread) prefix, and an answer that
finishes off screen raises one "Answer ready" toast and one announcement.

## Navigation and information architecture

`src/soc/registry.tsx` is the only feature registry. It derives routes, the left rail,
and command-palette destinations. Add, rename, gate, hide, or deprecate a feature there;
do not hand-build a second nav list.

- Primary navigation contains distinct operator jobs, not alternate reports over the
  same objects. Legacy destinations may stay hidden and routable for bookmarks during a
  transition.
- The **Intelligence** group uses five direct, non-overlapping operator destinations:
  **Knowledge corpus** is indexed RAG material; **Reference runbooks** are retrievable
  investigation guidance; **Operator memory** is approved durable context;
  **Response playbooks** are deterministically selected procedures; and **Agent
  personas** are read-only specialist profiles. Each destination is a first-level
  child and stable deep link. Do not hide Personas behind a Playbooks tab or use the
  generic labels “Knowledge”, “Memory”, “Catalog”, or “Playbooks & agents” when the
  specific contract is known. The legacy `#/catalog` route remains a compatibility
  alias that opens **Response playbooks**.
- Intelligence catalogs are divider-led reference lists, not card galleries. Each
  persona or playbook row exposes identity, purpose, and the smallest useful evidence
  summary first; criteria, tools, coverage, and replay evidence disclose in place.
  Reserve a Sheet for a full source document or create/edit workflow so scanning the
  catalog never replaces the operator's route context.
- The collapsed rail remains a stable 64px dock until the operator explicitly expands
  it. Hovering or focusing a grouped icon reveals one compact, viewport-clamped
  destination flyout; it never widens the entire rail. Pointer travel across the gap is
  delay-safe, focus opens immediately, Escape restores the trigger, and childless
  destinations retain simple labels/tooltips. Explicit expansion uses the shared
  reduced-motion-aware transition.
- The global command palette uses progressive disclosure. Its blank state contains
  recent work, a few safe quick actions, and top-level destinations only. Deep child
  routes, individual Settings sections, cases, and sources appear after the operator
  types a query. Do not render the entire route and Settings registry before input: a
  launcher should offer one calm first decision, then reveal precision on demand.
  Because the palette has wide, compact, and keyboard openers outside its Dialog,
  remember the exact opener and restore focus to it on Escape, selection, or close.
- Product documentation is a bottom utility destination, separate from operational
  feature groups.
- The in-app **Documentation** destination opens the version-matched Help Center
  shipped with the application at `/docs/<major.minor>/`; it never substitutes a
  GitHub directory for product help. Generate that static site from the same Markdown
  and accepted source identity as the application instead of copying articles into
  React components or maintaining a second manual.
- Installed documentation is authoritative for the running build and does not carry
  a blanket freshness warning. Latest Stable, Development, “View source”, and “Edit
  this page” are secondary destinations with explicit version/channel context.
- Deep links remain stable. If a page is consolidated, add an explicit redirect or a
  hidden compatibility route and document the replacement.

## Motion and loading

Every lazy route renders the shared centered route fallback immediately. A blocking
page, panel, or empty-table load uses `LoadingState` from `@/design-system`: one named,
centered, reduced-motion-safe indeterminate progress ring over optional static geometry. Never show a blank
canvas, only the word “Loading”, a page-local spinner, or several competing shimmer
animations. Keep usable content mounted during refresh and use the existing
`LoadingBar`; do not add another animation dependency. Button-level progress remains
local to the button it disables.

Manual page and queue reloads use the shared `RefreshButton`. Keep its visible action
label and fixed icon slot mounted while the request runs; indicate progress with the
same reduced-motion-safe rotating refresh glyph, `aria-busy`, and a disabled control.
Do not swap the glyph for a differently sized spinner, rename the action to
“Refreshing…”, or allow a second click while the request is in flight: those variants
create toolbar movement and inconsistent feedback. Initial blocking loads and
background data refreshes still follow the `LoadingState` / `LoadingBar` contract above.

Motion explains state change: route entry, disclosure, row insertion/removal, or a
terminal live marker. It does not decorate static content. Honor
`prefers-reduced-motion`; no required information depends on animation. Only two things
may animate continuously: the newest terminal timeline marker, and the single
agent-activity glyph while a chat turn is running (a rotation or arc sweep of about a
1.2–1.35s period — never a slow "breathing" loop — with a static mark and the word
"Working" under reduced motion). A successfully committed data refresh
may replay one short transform/opacity-only cue tied to the new payload; it must never
run on its own timer or imply that a request is in flight when it is not. Springs,
press feedback and overlay origins follow **Foundations → Motion**.

## Detection-rule authoring honesty

The normal Detection & Rules editor exposes only capabilities that survive Save and
affect the current runtime. A detection-match rule authors exactly one predicate plus
its active correlation threshold: group-by, event count, and time window. Do not add an
**Add condition** affordance, nested AND/OR builder, MITRE metadata input, per-rule
suppression editor, or per-rule cadence input until that capability is persisted,
validated, executed, previewed, and explained end to end.

The Schedule tab remains useful as a read-only explanation: detection cadence is owned
by the source feed and its durable cursor; case-automation rules run after a case
decision. Direct or legacy API clients may already have additive `mitre`, `schedule`,
or `suppression` metadata. Keep those values in the form adapter solely for invisible,
lossless compatibility round-trip so editing a name or threshold cannot erase them;
never badge them as active or let hidden metadata influence deterministic case
authority. Rule preview sends the same single authoritative predicate that Save emits.

## Operational metric and tuning surfaces

Operational summaries use one continuous strip rather than a row of independent
cards. The strip owns its outer hairlines; each metric supplies only the responsive
internal divider needed for the current column count. At every column count a strip
uses — they differ per surface, and the primary dashboard runs one, two, three and six
— no cell may acquire both a left and top divider or lose the line that separates it
from the preceding row. A strip that HEADS a dashboard page uses the `comfortable`
density (between compact and default: `px-4 py-3` at `xl`, `px-5 py-4` at `2xl`, about
120px tall, 13px label and context lines) with the fluid hero numeral (`size="fluid"`,
24 → 44px, growing with its own tile). Use the compact density when the strip is a band
embedded in a denser surface (a panel, a tab, a chat answer), and the default density for a
strip that stands alone. Density changes padding and numeral scale only; it must never alter
the cell count or the per-breakpoint divider rules above, which are tuned to an exact number
of cells. Numerals roll (count up) on the first load and on a window change, never on a LIVE
or manual refresh (`roll={false}`): data on an automatic refresh does not animate. The rule
covers every counting numeral on the page — donut centres, hero counts and flow stage totals
included — not only the strip; a one-shot sweep may replay on a refresh, its numerals may not. A strip tile's focus ring is drawn inset: the tile's cell clips anything
drawn outside it, and an outset ring there is invisible to a keyboard user.

A hero strip (`numeral="hero"`, the primary dashboard) reads top to bottom as a quiet
sentence-case label, the numeral, and exactly one muted **context line** that answers
"compared to what?" ("17% of 47 cases", "36 of 47 verdicted"). The line is data, never a
sentence about the metric; that belongs in help. A state disclosure (loading,
unavailable) takes the line first, then a conditional bound, then the context, so the
row's rhythm never changes with state. The line wraps and is never ellipsized: every hero
line reserves a two-line slot (`min-h-[2lh]`), so a caption that wraps keeps its numeral
level with its neighbours' and nothing is left to a mouse-only `title`. Never put context
beside the numeral: at six columns flex shrinks the numeral first. Hero numerals are
neutral ink; only a non-zero critical count is red. Hero tiles carry no icon, and their help and drill-down marks
appear on hover or focus beside the numeral (always shown on devices without hover).
A strip is followed by the next band after the normal band gap; its own bottom rule
closes the strip, and the band below draws no second rule against it.

**Dashboard bands.** The primary dashboard is a sequence of flat, TITLED bands on the
canvas, separated by whitespace rather than boxes: 32px between bands (40px from 1920px),
24px gutters between instruments inside a band (32px from 1920px). Instruments are
transparent — no card per instrument, no lattice hairlines between cells, no cell padding;
the gutters do the separating. A band draws at most one rule. Instruments in one band row
share one height (`items-stretch`, instruments `h-full flex flex-col`), and a list fills its
share of that height (a queue shows as many rows as fit, within a floor and a cap) instead of
driving the row taller. The floor is set in rem, so a larger browser text size grows it with
the rows, and a wider screen never shows fewer rows than a narrower one. From 1920px the
queue holds eight rows: its band becomes two rows (the snapshots over the response pair on
the left, the queue spanning both on the right — the rail at `4xl`) and the snapshot rings
grow to 192px, so the instruments, not blank space, take the height the queue sets. On paper
the queue is laid out in flow and kept on one page with its header. Instruments
side by side that share a structure (two snapshots) share their rows (`grid-rows-subgrid`),
so a caption that wraps in one moves both donuts and both footnotes together. The dashbar
pins from `sm` up; on a phone it scrolls away with the page. Above 1920px a dashboard widens by COLUMN COUNT, not by stretching:
`wide` width, rising to 2400px at `4xl` (≥2200px), where bands share one track template
with a 460px rail. A secondary fold is ONE disclosure — flat inside, with no nested cards or
collapsibles — whose open/closed choice is remembered and whose collapsed header states what
it holds. That summary wraps (beside the title from `md`, under it below) and never
truncates; a long item label in it is capped so the count after it stays visible, and the
whole sentence is the header's tooltip.

Dashboard type ladder: page title 30px at `2xl` (the `4xl` step; 24px below); band titles 15px semibold
with a 13px muted caption; instrument titles 14px; KPI numerals fluid (24 → 44px);
instrument numerals 24–28px; lists, legends and stage labels 13–14px; metadata 12px (mono
only for identifiers); 11px only for chart ticks, badges and timestamps. Section titles are
sentence case; tracked uppercase is not used for titles or for labels on the dashboard.
Band headers may carry a quiet right-hand freshness stamp ("Updated 2m ago") — slices load
independently, so each band states its own. A figure that repeats on the page (a cohort
count beside a stock, a tile beside the instrument that partitions it) gets a distinct label
and a quiet cross-reference line, never a second identical label.

Every instrument describes ONE population: a donut's centre, its legend and any row beside
it count the same cases over the same span, and a centre labelled "AI verdicts" counts only
verdicted cases. Where a band mixes spans (a fold holding window figures, store-wide all-time
counts and live coverage), each instrument's caption names its span ("last 24 hours", "all
time", "right now"), and a row that drills through opens a list over that same span — an
all-time count opens the list without a window. A tally over a bounded case page says so on
the instrument ("Lower bound · counted from the newest 200 of 450"), and its change chip is
withheld, since a change between two floors is not a change. A collapsed summary names a
"top" item only when it genuinely leads (more than one case, ahead of the next) and states
its count.

Period-over-period chips on small counts state the absolute difference ("+8"), not a
percentage of a tiny base; percentages are for bases of 20 or more and moves under 100%,
and the chip's title names both counts. On a dashboard the chip is borderless tinted text.
Hover trends — and any dashboard chart of counts per period — draw one column per bucket in
its real time slot (unmeasured buckets as a muted floor tick, never as zero) with a readout
of the pointed bucket; never a smoothed line over measured points only.

**Metric drill-down dialogs** grow out of the tile that opened them. Their chrome text is
12–13px; the trend and the page-scoped scalars share one row (chart about 60%, a 2 × 2 or
1 × 4 set of unboxed stats about 40%) so the table keeps most of the height (about ten rows
at 1440 × 900). What the rows ARE stays on screen — the rows-read sentence with its "lower
bound", the completeness badge, any range narrowing — while the long explanation of how
they were read sits behind one "About these rows" disclosure. A whole-window partition beside
the stats lays its label · value pairs out two per row, so it never makes the stats column
taller than the trend (Resolved / Closed keeps ten rows at 1440 × 900). Below `sm` the
dialog's actions sit under its title; below `md` the switcher, the filters and the evidence
scroll as one body, so a phone never shows three fixed bands over a sliver of rows. When the
dialog closes and focus returns to its tile, the tile's hover trend refuses a FOCUS-driven
open until the operator moves on (Radix restores focus after the exit animation, and a card
springing back over a strip just dismissed with Escape reads as a bug); pointer movement over
the tile is a hover and still opens it.

Observed-outcome metrics embedded in another operational page use the integrated
`ComparisonMetric` variant. Keep the shared reporting window, evidence state, and
safety guardrails in one summary band; do not repeat them in every metric cell. An
unavailable metric says why it is unavailable and never renders a synthetic zero.
Definitions remain available from the metric's keyboard-accessible **How** control.

Auto-tuning uses three task-focused Radix tabs: **Operations** (default), **Outcomes**
(`metrics:view`), and **Policy & history**. Do not place all three workflows in one
continuous page. Operations owns authority, rule state, recommendations, approval
routing, and selected-rule detail in one review surface. Outcomes owns the reporting
window, comparisons, daily evidence, and quality controls. Policy & history owns the
append-only ledger and editable tuner policy.

Operations begins with one compact authority/status band and one continuous three-cell
state strip. The cells form one mutually exclusive distribution rather than four
unrelated KPIs; the monitored total belongs in nearby supporting copy. Rule state
vocabulary is fixed: **Collecting** below `min_samples`,
**Within target** when sufficiently sampled and at or below policy, and **Needs
attention** when sufficiently sampled and above policy. Never label under-sampled
evidence healthy.

Recommendations and monitored evidence share exactly one attention-ordered
**Rule review** workspace. Do not introduce a second review queue, recommendation
card stack, or duplicate rule action. Recommendation-only rows remain visible in the
same workspace. Recommendations are grouped by rule and expose exactly one mutation
affordance per rule. The visual and reading order is **Why it needs attention → Recommended action →
Expected operational effect → Safety replay**. Processing one rule may apply multiple
eligible bounded changes and queue restricted changes; same-rule actions lock together
while unrelated rules remain usable. Never label a recommendation merely **Safe**:
use **Can apply after safety check**, because the evidence and safeguards are recomputed
before the write and may still route the change to Approvals. A restricted-only rule
links to Approvals when the operator has access.

All monitored rules use a responsive diagnosis-first list rather than a wide
statistics-first table. Each row states the rule's evidence state and the bounded next
step before exposing supporting measurements. The observed false-positive ratio is
supporting context; the conservative Wilson lower-bound estimate is the policy gate,
and its distance from policy is stated in **percentage points**. The list provides
search and state filtering, truncates long identifiers without letter-wrapping, and
opens a labelled contextual inspector beside the list only at genuinely wide (1536px+)
layouts or in a focus-managed Sheet below that breakpoint. The inspector owns the
diagnosis, current recommendation, expected effect, replay result, supporting
measurements, optional technical context, and recent history. The page must not
introduce horizontal document overflow.

In **Policy & history**, policy controls precede audit history. Advanced statistical
controls may be collapsed, while the append-only ledger exposes rollback only for the
newest active reversible row per rule.

The Outcomes tab shows one daily trajectory at a time—analyst-reported agreement,
material correction rate, or review-turnaround p50—through a keyboard-operable
`SegmentedControl`. Ratios and elapsed minutes must never share one axis. Preserve
every nullable daily point as a visible gap, show how many current-window days are
measurable, and provide the same values in a visually hidden table. Label the series
as raw eligible daily cohorts: the comparison cells above are source × severity mix
adjusted, while the daily series are deliberately unadjusted. Applied tuning events
belong in a collapsed disclosure as chronological context only; never draw a causal
connector or attribute an outcome shift to a change without an explicit future
analysis contract.

Keep these workspaces flat and divider-led rather than nesting them in rounded cards.
Initial loading uses `LoadingState`; refresh keeps the last usable data mounted beneath
one `LoadingBar`, and a refresh error is reported without replacing that data.

## Operational flow visualizations

The Dashboard Noise Reduction instrument has two deliberately separate presentations.
**Simple** is the default direct-labelled, Carbon-informed full alert-to-case flow.
**Detailed** is the compatibility view of the Testing renderer: preserve its 640x220
stretched canvas, proportional processing spine, direct overlapping Cases outcome fan,
loss badges, excluded-count spur, reduction headline, and complete stage evidence rail.
Do not reinterpret Detailed through the Simple geometry. The selected mode carries into
full-screen inspection. Labelled counts, definitions, coverage, and truncation evidence
are authoritative:

- Preserve the familiar left-to-right lifecycle order and the current selected-window
  scope. Do not invent, relabel, or hide volume to make a branch look fuller.
- **Alerts ingested**, **After clustering**, and **Cases opened** change unit. In Simple,
  draw both transitions as real filled, tapered ribbons so the complete path is visible.
  Use the documented square-root display scale to keep later stages legible, disclose that
  compression beside the graph, and keep exact counts plus alert/cluster/case units in the
  labels. Never present those mixed-unit ribbons as mathematically conserved.
- In Simple, treat **Auto-cleared by AI**, optional **Closed by analyst policy**, and
  **Escalated** as the conserved split of opened cases. Split Escalated again into
  **Closed by human** and **Not analyst-closed**, with equal source/target thickness for
  every same-unit ribbon. Detailed intentionally retains Testing's direct Cases-to-outcome
  fan, including the overlapping human-closure view; its aligned evidence rail is the
  authoritative arithmetic.
- Every Simple stage label carries its exact count **and** a percentage; the count stays
  primary and the share is rendered quietly beside it. Simple uses exactly one share rule:
  each stage's share of the stage it came from—clusters of alerts ingested, cases of
  clusters, the conserved case split of cases opened, and human closure of escalated
  cases. That one rule governs **every surface Simple can render**. The flow band and the
  narrow-width evidence rail are alternative presentations of the same flow and are never
  on screen together, so the rail repeats the graph's parent-relative shares—including the
  em-dash baseline—rather than Detailed's funnel-top arithmetic. That denominator must be
  named wherever the share is announced (the accessible label and the hover card name it
  in words; a disclosure beside the graph states the rule for sighted readers), because
  two shares with different bases must never invite comparison. The first stage is the
  baseline and shows an em dash rather than a self-referential 100%. A zero, absent, or
  unmeasured denominator also renders an em dash and says why—never a fabricated 0%, and
  never a share carried over from another base. Detailed keeps its own published
  funnel-top ("of ingested") arithmetic in the evidence rail; do not restate Simple's rule
  there or Detailed's rule in Simple.
- A disclosure must describe the surface that is actually rendered at the reader's width.
  Gate a sentence about ribbons and display compression to the same container condition as
  the flow band, drop it when conservation fails and only the rail renders, and give the
  rail its own sentence whenever the rail is what shows. Copy that states one rule while
  the visible percentages follow another is a defect, not a wording preference; keep any
  always-rendered clause true on every surface it can be read against.
- **Open cases** is current lifecycle state from the selected-window posture count. It is
  not equal to Escalated minus human closure, so keep it outside the conserved graph as a
  labelled, keyboard-operable queue action. If the bounded scan is truncated, display the
  count as a lower bound and retain the complete-active-case drill-through.
- When the backend emits an **Awaiting review / Candidate** cohort, keep it distinct
  from the mandatory lifecycle; it is not a parent of Cases opened. Simple names it as
  side evidence, while Detailed retains Testing's side-cohort branch.
- Keep Simple's direct labels and Detailed's evidence rail readable in both themes. Stage
  detail must be available to keyboard and pointer users, not hover-only. At narrow widths,
  use the evidence rail rather than crushing either desktop graph's labels—and carry that
  view's share rule and disclosure into the rail with it.
- Outcome activation opens the matching selected-window Cases filter. Earlier stages
  open the selected-window Cases context because raw alert and cluster records are not
  exposed through the case list.
- Counter coverage, the bounded case-store page, the bounded lineage sample, and any
  truncation remain visible. A chart must never imply that partial evidence is complete.
- In Simple only, a successful payload may replay one short left-to-right matte sweep
  clipped to its ribbons. Key it to `generated_at`, remove it under reduced motion, and
  use no gradient, blur, glow, autonomous five-second loop, or additional animation
  dependency. Detailed retains Testing's static presentation.

The implementation layers, public design-system exports, source-asset rules, and
machine-readable catalog contract are documented in the
[Console design system](design-system.md).

## Evidence-led analytics

Analytics surfaces distinguish measurements, evidence quality, and policy. Use the
shared `ComparisonMetric`/definition disclosure for a current value, comparable
baseline, direction, sample, and formula. A measured value may remain visible beside
an **Insufficient** state, but missing evidence renders as an em dash—never zero.
Loading, unavailable, collecting, insufficient, and not-applicable are different
operator states and must not be collapsed into one neutral card.

Agent Effectiveness is aggregate-only and deliberately has no composite score.
Analyst agreement and correction share one graded-case quality domain; human review
turnaround is the independent second domain. A favorable headline requires both
domains plus evaluable, unbreached safety guardrails. Always expose the two complete
UTC windows, sample counts, comparable source×severity coverage, exclusions,
suppressed strata, and truncation. Do not show raw case/source identifiers or imply
causal model learning from an observed period-over-period change.

Cost execution tiers report what the ledger recorded, not what Settings requested.
Keep the fixed Standard/Flex/Batch/Unconfirmed buckets visible even when zero, include
Unconfirmed in coverage denominators, and never label a Standard row as a Flex
fallback unless a future ledger contract explicitly records that provenance.

## Theme and appearance

System, Light, and Dark are the three supported modes. Signed-in appearance entry points
use `PrefsProvider.setThemeMode`; the pre-auth Login delegates directly to the same
underlying `ThemeProvider.setTheme` persistence path because user preferences are not
available yet. First paint, the persisted choice, and every visible selection must
agree. Test every changed surface in both themes; hard-coded light-only dropdowns,
popovers, tooltips, and native-looking menu surfaces are defects.

The semantic SOC palette is system-owned. Severity, status, verdict, and risk fills
must remain coupled to their measured on-fill foreground and standalone-text tokens;
Branding cannot override only one member of that axis. Legacy semantic keys are ignored
compatibly. Small copy on a 10% semantic wash uses the corresponding `*-text` token,
while the base token remains available for icons, borders, charts, and sufficiently
large non-text marks. The contrast gate must test those text tokens on the actual
card-plus-wash composition in both themes, not merely against pure white or black.

Organisation accent overrides are theme-independent fills. Always derive the higher-
contrast black/white `--primary-foreground` from the effective accent and apply that
same pair in Light and Dark. Reapplying or discarding Branding clears the complete
writable inline-token set first so an older override cannot leak into the next preview.
Persist display-font choices as their stable allow-listed key; expand the key to the
self-hosted stack only when writing CSS. Normalise legacy hex primary/ring/secondary
accent tokens to the HSL triplets expected by `hsl(var(--token))` consumers.

## Release identity and supervised updates

The version badge remains the always-visible release identity. For a built-in
super-administrator with the dedicated update permission, place one compact update
control immediately beside it only when the backend reports a newer Stable candidate
and a supported supervisor capability. Do not replace the badge, add a persistent
banner, infer installability from SemVer alone, or expose a Testing observation as an
installable release.

Below the desktop breakpoint, the top bar still shows that release badge and any
candidate, active, or failed update action directly. Group secondary utilities
(notifications, appearance, health detail, account links, source-only observations,
and non-actionable update setup or receipts) in one labelled, non-menu Sheet. The
Sheet must use normal buttons and sections rather than ARIA menu roles, provide 44px
touch targets, close on Escape, and return focus to its trigger. Do not let shell
chrome create document-wide horizontal scrolling at 320px, 390px, or 600px.

The control must begin with server-bound preflight, then open the shared confirmation
dialog with the exact target, components, backup, rollback guarantee, warnings, and
blocking checks. A known unsaved draft withholds Start and directs the operator to
save or discard it. Cancellation returns focus to its trigger. Announce availability
once through a polite live region, never by repeated toast.

After confirmation, show one durable global progress surface with named stages,
bounded progress, the expected reconnect, automatic rollback state, actionable error,
and receipt. Reloading or navigating back must resume the host-side active job; the
browser must never pretend a disconnected request failed if the supervisor may still
be working. Cancel is offered only before switching starts. Manual rollback is offered
only when the supervisor reports a retained rollbackable snapshot.

Following a successful job, activation repeats the no-store release manifest,
backend identity/readiness, and entry-document checks before preserving the hash route
across a full-page navigation. If automatic activation cannot finish, keep an explicit
**Open updated Console** fallback visible. Background discovery failures stay quiet;
explicit failures use one actionable error surface and leave the current document
interactive. Never expose browser-editable image names, release URLs, commands, host
paths, registry/deployment credentials, migration instructions, or Compose fragments.

## Identity surfaces

The sign-in experience is intentionally minimal. Use one vertically and horizontally
centred, borderless 480px by 492px identity slab for the normal desktop sign-in state
on the isolated identity canvas, with a 384px content measure: one standalone 56px
mark, the current auth-mode heading, one short
description, credential controls, one primary action, and quiet support or operator-
configured footer text. The hierarchy remains left-aligned inside the centred slab. A
configured sign-in headline replaces the default heading; it never stacks above a
second `h1`. Do not add a synthetic audit-status claim: auditing is a platform
invariant, not useful sign-in instructions. The form is the page. Do not add a marketing
hero, split context pane, assurance rail, trust-path diagram, decorative illustration,
fake telemetry, or repeated security claims. Exactly two controls carry a gradient and
a glow — the primary CTA and the corner appearance pill, both described under
*Identity accents* below. Nothing else on this canvas may, and nothing in the Console
may at all.

The slab has no radius, border, or elevation. It uses 48px top/side and 96px bottom
desktop insets. Its fixed, login-scoped palette is intentionally independent of Console
branding tokens: Light canvas/slab/muted tile are `#fbfbf8` / `#fff` / `#f5f4ef`;
Dark uses `#1a1a1e` / `#101013` / `#27272b`. Four explicit 0.5px viewport guides
align to the slab edges. The ambient layer follows the live Mistral sign-in choreography:
exactly four neutral 240px tiles reveal sparsely, dwell, move on a 1,800ms ease-in-out
transition, then fade away before scheduling their next randomized cycle. Top and bottom
use two horizontal endpoints; left and right use a two-column by two-row outer lattice and
choose a next cell sharing the current row or column. Only the top and bottom tiles may
emit an occasional warm directional trail (`gold`, amber, orange, vermilion, or red), one
tile behind the current move. Side tiles never emit colour. The trail belongs to the same
movement lifecycle and retracts when that movement settles; there are no detached colour
anchors or independently timed stationary blocks. The light/dark neutral tile, canvas,
and guide tokens remain the dominant visual treatment, so the background reads as a quiet
grid with rare colour rather than a perpetual saturated animation. Do not replace this
backdrop with a gradient, glow, blurred blob, perpetual CSS drift, or tile border; the
*Identity accents* exception below covers controls, never this ambient layer. The decoration
is pointer-inert, `aria-hidden`, reduced-motion-safe, layered below the opaque slab, and
never crosses behind credential content. Light/Dark changes snap the neutral tile palette
atomically while preserving the active movement; never interpolate white tiles through a
large grey flash during a theme switch. Below the small breakpoint, all
guides and ambient tiles disappear and the
surface becomes a full-width, full-height flow with 32px side/top and 80px bottom insets.
A small pre-auth appearance control may sit in the viewport corner: the Light/Dark
pill plus a round *Use system theme* reset that is pressed while `system` is active.
System, Light, and Dark all remain reachable — the pill reflects and sets the RESOLVED
appearance, and choosing either explicitly releases `system`. It delegates to
`ThemeProvider.setTheme`, while authenticated surfaces continue through the preference
layer. Sign-in, setup, MFA, MFA enrollment, and forced password change
share the same centred slab; taller modes grow naturally and the slab scrolls within the
viewport so software keyboards never trap the primary action. The form owns the page's
single `h1`.
Credential entry is identity-first: the initial surface contains only the username field;
once it has a non-empty value, **Continue** appears and advances to the password step.
The password step repeats the selected identity as quiet context and provides an explicit
way back without discarding it. Credential inputs are 48px and primary/SSO actions are
40px or taller. Inputs use a 16px mobile font and 14px desktop font to avoid browser
focus zoom while keeping the reference's editorial density, password-manager
autocomplete, and paste available. Seeded demo credentials label username and password
explicitly beneath the primary credential form; their optional `Use` action fills the
form, advances to the password step, and never submits it. When configured, icon-led,
accessibly named SSO actions follow the identity step in one equal-width row; no empty
divider or provider region is reserved when SSO is absent.
External support links say they open a new tab, and the blocking first-paint gate uses
the shared `LoadingState`.

Legacy `split`, `centered`, and `full` branding values remain readable and round-trip for
configuration compatibility, but all render the same minimal shell. Bounded operator
wordmark, logo, subtitle, optional short welcome copy, footer notes, and support URL may
remain; they must stay plain text and must not rebuild a second content pane. The Branding
editor preview mirrors this exact minimal geometry and tokens.

### Identity accents

The identity canvas — and only the identity canvas — carries two expressive controls:
`ShineButton`, the primary CTA, and `ThemeModePill`, the corner appearance switch. Both
live in `webui/src/soc/components/auth/`, both are styled entirely by
`.login-auth-canvas`-scoped CSS in `theme.css`, and both animate with CSS transitions
and one keyframe — no animation library, and neither sits on a lazy chunk. Every rule
is scoped under the canvas class, so the restriction is structural rather than
advisory: used off the identity canvas these degrade to a plain, legible button rather
than an invisible one. They are a
deliberate exception to the surface grammar above, not a licence to reintroduce
decoration elsewhere: no Console page may adopt either, and the ambient backdrop stays
neutral.

The exception holds only while these rules do:

- **Colour is measured, never eyeballed.** These are the only surfaces that paint text
  on a raw gradient rather than a semantic token pair, so the token contrast gate cannot
  see them. `webui/scripts/gate-login-accents.mjs` re-derives the worst case from
  `theme.css` on every `npm run gates` and every Vitest run, compositing each face stop
  with the sweep at its peak keyframe opacity and the overlay tint at its declared
  per-theme opacity, and measuring against both label stops. Every composite clears
  4.5:1. The reference palettes these are modelled on do not; that is why the ramps here
  are deeper.
- **Decoration never reaches the measured surface.** The CTA's halo renders outside an
  opaque face; the pill's flair orbs render behind an opaque track. Both controls paint
  no background of their own so their glow layers can sit beneath the opaque child.
- **The pill's glyphs own fixed side cells.** The label can never drift over the bright
  end of either ramp, which is what makes the measured label zone true. Ink and track
  swap instantly between states — the two ramps are not interpolable, so a crossfade
  would pair each ink with the wrong ramp mid-transition.
- **The focus ring is drawn on the opaque child, never on the button.** An element's
  outer box-shadow paints before its descendants, so a ring on the button itself sits
  underneath the halo and the flair — on precisely the state that shows the ring. It
  goes on the face and the track instead, with a 2px opaque offset so its contrast is
  measured against the slab or the canvas rather than against whatever the glow is
  painting behind it.
- **Disabled and busy are different states.** The CTA is disabled both while nothing is
  typed and while the request is in flight. Flattening it the instant it is clicked
  reads as the form going dead, so the inert treatment excludes `[data-busy]`; busy
  keeps the identity and lets the spinner carry the state.
- **Every fallback is explicit.** The sweep is gated behind
  `prefers-reduced-motion: no-preference`; translucent and blurred layers — the tint
  included — are dropped under `prefers-reduced-transparency: reduce`; and under
  `forced-colors: active` both controls return to the system palette AND the
  gradient-clipped label is un-clipped, without which it would stay transparent over a
  system-painted face and vanish. Those fallbacks carry `!important` deliberately:
  `forced-color-adjust: none` opts the elements out of the UA's own correction, so any
  state selector that survives on specificity — the pill's `[data-appearance]` ink, the
  disabled CTA's muted face — keeps a hard-coded colour the system theme never sees.
- **The CTA's accessible name is its label alone.** The sweep is `aria-hidden`, the halo
  is a pseudo-element, and any icon renders outside the clipped label span (text-fill
  transparency is inherited, so an icon nested inside it would disappear).

## Forms, Settings, and dangerous actions

Settings is one responsive configuration workspace, not a collection of unrelated
admin cards:

- On desktop, use one searchable, registry-derived, grouped section rail beside the
  active editor. Below the desktop breakpoint, replace that long rail with one compact
  contextual trigger and a searchable Sheet chooser; do not stack the full inventory
  above the form.
- The active renderer owns exactly one visible `h2` and its description. The workspace
  may show a compact group/section context line and truthful dirty status, but it must
  not repeat the section title as a second heading.
- Related controls sit in flat, divider-led `SettingsCard` bands. Fields, switches,
  posture summaries, and status text use aligned field/status lanes inside the band;
  do not wrap the section, each toggle, or each summary in another decorative card.
- Dirty state is visible globally and per section. Save and Discard live in one sticky,
  opaque hairline action bar; never introduce a second section-local preference save
  path.
- A dirty preference or write-only-secret draft must not disappear silently. Protect
  reload/tab close and pause Console-driven cross-page navigation before changing
  React state or the hash; use the shared accessible confirmation dialog rather than
  `window.confirm`. Section and anchor jumps inside Settings preserve the same draft
  and do not prompt.

The responsive shell is presentation only. Preserve `#/settings?s=<id>&a=<anchor>`
deep links, registry/RBAC visibility, schema and API fields, write-only secret drafts,
and partial-update/dirty semantics when changing it. Search may expose matching
in-section anchors, but it must not reveal a section the current role cannot access.

Secrets remain write-only. Destructive or externally consequential actions require a
clear label, scoped confirmation, permission gate, and audited backend operation. Never
place deterministic case decisions behind an LLM-generated button.

## Guided setup workflows

The first-run setup workspace is the reference pattern for a short, stateful guided
workflow. It uses one wide, height-bounded shell rather than a marketing card: a
compact product header, a desktop progress rail, a compact progress strip below the
desktop breakpoint, one scrollable content region, and one sticky footer aligned to
the content column. Long manifest-driven editors consume the available width and
scroll inside that frame.

- Keep the sequence short and job-named. The current setup contract is **Workspace →
  Data sources → AI runtime → Review & launch**.
- Focus the new stage heading after every transition, expose `aria-current="step"`,
  announce progress, provide a skip link, and keep exactly one `h1` in the active
  stage.
- Derive progress status from actual readiness, not from which stages were visited.
  A review must distinguish **Ready**, **Needs attention**, and **Optional** and may
  allow a deliberately limited launch when it says what is unavailable.
- Route Back, Continue, progress links, Close, and Launch through one guarded
  transition. Save write-only credential drafts before leaving their stage; keep the
  operator in place on failure. Confirm before abandoning an open editor draft.
- A first-run terminal action names the product outcome (**Launch Agentic SOC**).
  The same flow used as a Settings re-run uses **Apply changes** and offers Close;
  it does not imply a destructive reset.
- Fail closed when authoritative setup state is unknown. Show a shaped error with
  Retry instead of rendering an operational surface on an assumed default.
- Present the default automation posture as an explanation, not a ceremonial switch.
  Detailed tuning belongs in Settings, and deterministic close/escalate authority is
  never altered by setup copy or controls.

## Accessibility and verification

- Keyboard focus is always visible; use the shared focus ring.
- Icon-only controls have an accessible name and a target of at least 24×24 CSS pixels.
- Radix primitives provide menu, dialog, radio, tabs, tooltip, and focus behavior.
- Render source/log/user text as plain text. Truncation has an accessible full-value
  path (hover/focus detail, title, or expanded view).
- An operationally load-bearing caveat—a filter that never ran, a volatile buffer, a
  result that is not what the controls asked for—is visible text or an accessible string.
  A `title` on a non-focusable element is a mouse-only affordance and never the sole
  carrier of such a caveat.
- Maintain WCAG AA token contrast in both themes and never disable paste. A measured
  `*-text` token has no headroom left: do not dim it with an `opacity-*` modifier on the
  wash it was tuned for—use the token as rendered, or pick a different token.
- Honour reduced motion, reduced transparency, and increased contrast as described in
  **Foundations**; the increased-contrast border and secondary-text values are measured
  in both themes by the foundations test, alongside the design gates.

Before handoff, run typecheck, lint, design gates, focused tests, the complete Console
suite, and the production build. Use the in-app browser to inspect both themes, a narrow
viewport, hover/focus behavior, lazy-route loading, and console errors. Update this
standard when a deliberate shared pattern changes; do not let implementation and the
document drift. Stable promotion additionally requires the complete
[release-candidate browser acceptance matrix](testing.md#release-candidate-browser-acceptance)
against the exact built candidate.
