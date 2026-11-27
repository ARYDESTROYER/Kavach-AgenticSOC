# Round 14 research: why the left navigation feels buggy, and what to do about it

Ask 8, part 1 (operator, verbatim): "Overall apps ui polishing needs to start. The dashboard
looks so professional and neat, similar UI elements need to be followed and other ui aspects
needs to be cleaned up too. Especially the LHS navbar, animation is so buggy. Get working on it
please."

Status: research only. No repository file other than this brief was changed.

## 1. Summary

The rail does not have one bug, it has a choreography problem plus several small timing bugs.
Measured in the shared demo and in a production build (section 3), the "buggy" feel comes from
these, in order of how much they hurt:

1. **The content swaps before the box moves.** On every toggle the sidebar replaces its whole
   item tree (icon rail markup versus labelled drawer markup) in the first frame, then animates
   the width. Expanding shows 15 of 15 labels clipped and all 6 group headers cut off inside a
   64 px box; collapsing first throws every icon, the brand tile and the toggle into the middle
   of a still 240 px wide rail and then slides them left. Icons also change size (20 px to
   16 px) and vertical position (by 23 px) at the same instant.
2. **The width is a layout animation, run twice, that drags the page with it.** Both the shell
   frame and the aside transition `width`, so the main column, the top bar and every chart
   reflow on every frame. On this container's fast CPU it stays smooth; with a 4x CPU slowdown
   (a mid-range laptop) a production build loses about 110 ms of the 200 ms transition to one
   long frame, and at 6x the whole transition is skipped (the panel just jumps).
3. **The toggle button is unmounted and remounted in a different place** (header right when
   expanded, under the brand when collapsed). Keyboard focus falls to `<body>` after every
   toggle, in every viewport and theme we tried, and the pointer is no longer over the control.
4. **Collapsed-rail flyouts open too eagerly.** A 100 ms dwell timer means simply moving the
   pointer down the rail at a normal speed pops 3 to 6 flyout panels in a row, and the shared
   tooltip "skip delay" makes every icon crossed show its own tooltip instantly, several at once.
5. **Clicking a grouped icon flashes its flyout** for 110 to 210 ms before the page changes,
   because pointer focus is treated like keyboard focus.
6. Smaller issues: an unusually front-loaded easing curve (75 percent of the distance in the
   first 40 ms), group children that appear with no transition while the chevron rotates, a
   long frame on every group toggle because nav state lives in the 2,128-line AppShell, a nav
   list that overflows when four groups are open (scrollbar gutter risk on Windows/Linux), and
   on mobile a double animation on open plus a list that jumps inside the closing sheet.

Every major product we looked at either keeps the rail's icons perfectly still while the panel
changes (shadcn/ui, Material 3, Fluent 2), avoids hover expansion altogether (Linear, Notion's
documented controls, Apple, Fluent, Kibana's own fix for one-click access), or overlays the
expanded panel so the page never reflows (Material 3 modal rail, GitLab's 2023 design, our own
Round 9b). Section 6 turns that into three options with exact timings. Recommendation: **Option
A, a docked rail with an explicit toggle and a stable morph**, plus the shared fixes in
section 7, which are needed whichever option is chosen.

## 2. How the navigation works today (code map)

| Concern | Where | What it does |
|---|---|---|
| Rail component | `webui/src/soc/components/NavSidebar.tsx` (1,004 lines) | One `<aside>` with two width states, `w-16` (64 px) and `w-60` (240 px), `NavSidebar.tsx:861-866` |
| Width transition on the aside | `NavSidebar.tsx:862-864` | `transition-[width] duration-200 ease-premium` |
| Second width transition on the shell frame | `webui/src/soc/AppShell.tsx:1509-1522` | `desktop-navigation-frame` also runs `transition-[width] duration-200 ease-premium`, `z-40` only while collapsed |
| Item tree swap | `NavSidebar.tsx:917-956` | `collapsed ? <CollapsedItem/> : <ExpandedItem/>` per group, a different element tree per state |
| Collapsed layout | `NavSidebar.tsx:865`, `912-913` | `items-center` on the aside and the list, so icons are centred in whatever the current width is |
| Icon sizes | `NavSidebar.tsx:373`, `412` (16 px, expanded) and `640` (20 px, collapsed) | Two sizes for the same item |
| Brand row | `NavSidebar.tsx:870-902` | `justify-center px-2` collapsed versus `gap-3 px-3` expanded; product name unmounted when collapsed (`896-900`) |
| Toggle placement | `NavSidebar.tsx:901` and `905-907`; button built in `AppShell.tsx:1399-1424` | Rendered in the header when expanded, in a separate row under the brand when collapsed, so it remounts on every toggle |
| Shortcut | `AppShell.tsx:1382-1397` | Ctrl/Cmd+B calls `toggleCollapsed` |
| Nav state | `NavSidebar.tsx:129-224` (`useNavPrefs`), used at `AppShell.tsx:1171` | `collapsed` and `openGroups` live in AppShell state, mirrored to `localStorage` and `PUT /api/prefs/user` |
| Flyout timing | `NavSidebar.tsx:463-464` | `NAV_FLYOUT_OPEN_DELAY_MS = 100`, `NAV_FLYOUT_CLOSE_DELAY_MS = 180` |
| Flyout open on focus | `NavSidebar.tsx:675-678` | `onFocusCapture` calls `openImmediately()` for any focus, pointer or keyboard |
| Flyout animation | `NavSidebar.tsx:717-722` | `animate-in fade-in-0 slide-in-from-left-1 duration-150 ease-premium` |
| Group disclosure | `NavSidebar.tsx:419-454` | Chevron rotates `duration-200 ease-premium`; children `<ul>` mounts with no transition (`441-454`) |
| List entrance | `NavSidebar.tsx:914`, `965` | `animate-fade-in` on the list and footer (runs on mount, so on every mobile sheet open) |
| Tooltips | `webui/src/soc/App.tsx:221`, `webui/src/ui/tooltip.tsx` | One global `TooltipProvider delayDuration={200}`; Radix default `skipDelayDuration` 300 ms |
| Mobile | `AppShell.tsx:1459-1502`, `1172-1205` | Radix Sheet (`ui/sheet.tsx:29-51`, open `duration-pane` 350 ms spring, close `duration-base`); `mobileOpenGroups` derived from the current page |
| Motion tokens | `webui/src/styles/theme.css:185-201`, `webui/tailwind.config.js:219-237`, `webui/src/soc/components/motion/variants.ts:38-41` | `--motion-base` 200 ms, `ease-standard` `cubic-bezier(0.2,0,0,1)`, `ease-premium` `cubic-bezier(0.16,1,0.3,1)`, `SPRING_UI` 0.3 s, `SPRING_PANE` 0.35 s |
| Reduced motion | `NavSidebar.tsx` `reducedMotion` props, `theme.css:1518-1529` and `1623-1636` | Width and chevron transitions off; global 0.001 ms override; overlays cross-fade. This part works. |
| Contract | `docs/development/ui-standard.md:198-200`, `950-955` | "Animate `transform` and `opacity` only"; "The collapsed rail remains a stable 64px dock until the operator explicitly expands it" |

History: Round 9b (CHANGELOG.md:3067-3075) shipped a hover-to-expand rail that floated as an
overlay without reflowing the page. A later round replaced it with today's locked rail and
per-group flyouts (`NavSidebar.tsx:25-28`, `ui-standard.md:950-955`). The explicit toggle kept
the push layout and the width transition, which is where most of the defects below live.

## 3. Method

* Shared demo `http://127.0.0.1:5901` (Vite dev server, Demo Mode), Admin account. Every
  `PUT /api/prefs/user` from the harness was intercepted and answered locally, and
  `GET /api/prefs/{user,effective}` was patched per run, so the shared Admin preferences were
  never changed.
* Viewports: 1440x900 and 1920x1080 in light and dark, 1280x800 light, 390x844 light and dark.
* Evidence per run: true painted frames from the Chrome DevTools screencast (about 25 to 40
  frames per second), a requestAnimationFrame sampler recording the rail width, icon positions,
  label clipping, toggle position, main column geometry, ResizeObserver callbacks and focus,
  plus Long Animation Frame and layout-shift entries, and a full-run video.
* Clean performance runs (`nav-perf.mjs`): no screencast and no layout reads, only frame
  timestamps and Long Animation Frames, 3 collapses and 3 expands per cell, on the Overview, at
  CPU 1x, 4x and 6x, against both the dev server and a **production build** served locally
  (built into the scratchpad, served on port 5947 and stopped afterwards). Variants: `current`,
  `instant` (width transition removed) and `overlay` (a CSS-only prototype where the rail
  keeps 64 px in the layout and the expanded panel floats over the content).
* Caveats: headless Chromium hides scrollbars (so the gutter issue in D9 is inferred from
  `scrollHeight`, not seen); the dev server runs React's development build, which is several
  times slower than production, so only the production numbers are used for conclusions; the
  sampler adds its own layout reads, so its frame times are not used as performance evidence.

All evidence lives under
`<scratch>/r14/shots/research/nav/`
(called `NAV/` below): `NAV/sheets/*.png` contact sheets (each tile is stamped with its frame
number and time), `NAV/<viewport>-frames/<scenario>/` raw frames plus `index.json`,
`NAV/<viewport>-frames/*.json` sampler data, `NAV/perf/*.json`, and videos
`NAV/d1440l-video/nav-d1440l.webm`, `NAV/d1920d-video/nav-d1920d.webm`,
`NAV/m390l-video/nav-m390l.webm`. Harness scripts are in
`<scratch>/r14/notes/`
(`nav-repro.mjs`, `nav-perf.mjs`, `nav-profile.mjs`, `nav-optionB.mjs`, `nav-analyze.mjs`,
`sheet.sh`).

## 4. Defects, evidence, root cause and fix

Severity: High means visible on every toggle or every hover pass; Medium means visible in a
common situation; Low means edge case or polish.

### D1 (High). The item tree swaps in the first frame, then the box animates

* **Evidence, collapse** (`NAV/sheets/d1440l-collapse.png`, frame #002 at 68 ms; also
  `NAV/sheets/d1440d-collapse.png` in dark): the rail is already in its collapsed markup while
  still about 200 px wide, so every icon sits in the middle of the rail; the page has not moved
  yet. Sampler (`NAV/d1440l-frames/01-02-toggle.json`): between two frames 37 ms apart the
  first icon jumps from x 18, y 103, 16 px to x 110, y 126, 20 px; the brand tile from x 12 to
  x 101.5; the toggle from (195, 11.5) to (103.5, 64). Everything then slides left to x 22
  over the next 190 ms.
* **Evidence, expand** (`NAV/sheets/d1440l-expand.png` frame #003 at 93 ms;
  `NAV/sheets/d1920d-expand.png` frames #002 to #004 in dark): the labelled markup appears inside
  a 64 px rail: 15 of 15 labels have zero visible width, all 6 group headers are clipped to
  "OVERVI", "TRIAGE", "INTELLI", chevrons sit next to icons, and the product name shows as
  "A..." (1920 dark, #004 at 150 ms).
* **Root cause:** `NavSidebar.tsx:917-956` renders different components per state, so React
  swaps the subtree on the commit, before the CSS width transition (`862-865`) has moved a
  pixel. `items-center` (`865`, `913`) centres icons in the animating width, so they drift.
  Icon size differs per state (`373`, `412` versus `640`), and collapsed rows (40 px buttons
  with 4 px gaps and separators) have a different vertical rhythm from expanded rows (36 px plus
  24 px group headers). The product name and toggle are conditionally mounted (`896-907`).
* **Fix:** one DOM for both states. Every row keeps the same structure (fixed 40 px icon cell
  at a fixed inset from the rail's left edge, then a label that is clipped by the rail and
  faded with opacity). Group headers keep their height and cross-fade between text and a
  divider so nothing moves vertically. One icon size in both states. This is exactly how the
  shadcn/ui sidebar works: one tree, icons never move, group labels go to `opacity-0` with a
  negative margin, labels are clipped by `overflow-hidden` (sidebar.tsx lines 221-239, 408-409
  and 477, see section 5).

### D2 (High). Width is animated as layout, twice, and reflows the whole page every frame

* **Evidence:** during a collapse at 1x the main column goes 1200, 1320.7, 1358.9, 1374.9,
  1376 px wide and the first KPI tile's width 192, 212, 218, 221 px, i.e. every tile, chart and
  header chip is re-laid out on every frame; 48 ResizeObserver callbacks fired in about 5 frames
  (`01-02-toggle.json`). At 1280 the top bar crosses its `@[72rem]/topbar` tier mid-animation,
  so "Agentic SOC /" disappears from the breadcrumb halfway through the expand
  (`NAV/sheets/d1280l-expand-topbar.png`, #005 at 111 ms) and the search field narrows.
* **Production build, Overview, clean runs** (`NAV/perf/prod-overview-*.json`, averages of 3):

  | CPU | Variant | Collapse: longest frame gap / longest LoAF / main-thread blocking | Expand: same |
  |---|---|---|---|
  | 1x | current | 28 ms / none / 0 ms | 33 ms / none / 0 ms |
  | 4x | current | 117 ms / 104 ms / 96 ms | 111 ms / 104 ms / 93 ms |
  | 4x | instant (no transition) | 105 ms / 100 ms / 42 ms | 139 ms / 126 ms / 105 ms |
  | 4x | overlay prototype | 67 ms / 58 ms / 18 ms | 89 ms / 87 ms / 36 ms |
  | 6x | current | 172 ms / 148 ms / 169 ms | 172 ms / 150 ms / 169 ms |
  | 6x | overlay prototype | 100 ms / 108 ms / 50 ms | 145 ms / 139 ms / 104 ms |

  On a fast desktop the transition is smooth. On a mid-range machine (4x) more than half of the
  200 ms transition is one blocked frame, and at 6x the whole transition is lost: the user sees
  a pause, then the panel jumps. The dev server is worse (4x collapse: 156 ms gap, 185 ms LoAF,
  264 ms blocking, `NAV/perf/overview-cpu4-current.json`; files without the `prod-` prefix are dev-server runs). A CPU profile of the production
  collapse (`NAV/perf/profile-prod-current.json`) is dominated by React work, recharts and the
  Overview chunk, i.e. the page re-rendering because its width changed.
* **Root cause:** `AppShell.tsx:1519-1521` and `NavSidebar.tsx:862-865` both transition `width`
  on in-flow elements, which the ui-standard forbids (`ui-standard.md:198-200`: "Animate
  `transform` and `opacity` only"). web.dev's animation guide says the same: restrict animation
  to `opacity` and `transform` and avoid any property that triggers layout or paint. Removing
  the transition alone does not help (the `instant` row): the cost is the subtree swap (D1)
  plus a relayout of the page, so the fix is to make the page relayout once and keep the swap
  out of the commit.
* **Fix:** see Option A (section 6). In short: the in-flow spacer changes width once, at the
  start, with no transition; the visible panel is out of flow and animates with transform and
  opacity only; the item tree no longer changes (D1). The overlay prototype already halves the
  main-thread cost without any of the D1 work.

### D3 (High). The toggle button remounts in a different place and drops focus

* **Evidence:** keyboard focus on "Collapse navigation", press Enter: `document.activeElement`
  is `BODY`. Same for "Expand navigation". Reproduced at 1280, 1440 and 1920, light and dark
  (`NAV/*-frames/log.txt`). Pointer: the button moves from (195, 12) to (16, 64) and back
  (log: "toggle moved"), so a second click lands on the brand or the Overview row.
* **Root cause:** `NavSidebar.tsx:901` renders `toggleSlot` in the header only when expanded and
  `905-907` renders it in its own row only when collapsed; React unmounts the focused button.
* **Fix:** one persistent toggle element in a fixed slot (Option A puts it at the top of the
  icon column, x 16 in both states), or keep the element and move it with a transform. Never
  unmount the focused control. WCAG 2.2 success criterion 2.4.3 Focus Order requires focus to
  move in an order that preserves meaning; dropping to `<body>` restarts the tab sequence.

### D4 (High). Flyouts open on a 100 ms dwell, so a normal pointer pass pops a cascade

* **Evidence** (collapsed rail, pointer moved straight down from the first to the last icon,
  `NAV/*-frames/06-sweep-*.json`):

  | Sweep speed | Flyouts opened (1280 / 1440 L / 1440 D / 1920 L / 1920 D) | Tooltips shown |
  |---|---|---|
  | 2.4 s, about 0.31 px/ms | 6 / 6 / 6 / 6 / 6 | 8 to 9 |
  | 1.0 s, about 0.74 px/ms | 5 / 5 / 5 / 4 / 3 | 0 to 4 |
  | 0.35 s | 0 everywhere | 0 |

  At the medium speed (someone heading for Settings) Intelligence, Analytics, Notifications and
  Settings open one after another for 140 to 230 ms each.
* **Root cause:** `NAV_FLYOUT_OPEN_DELAY_MS = 100` (`NavSidebar.tsx:463`) starts on
  `pointerenter` (`564-572`) with no "is the pointer at rest" check; the close delay (180 ms) is
  longer than the open delay, so the next group's flyout replaces the previous one while the
  pointer is still travelling.
* **Industry guidance:** NN/g recommends waiting 0.3 to 0.5 s with the cursor stopped before
  exposing hover content, showing it within 0.1 s once intent is clear, and keeping it up until
  the cursor has been outside for more than 0.5 s; it also describes the triangle technique for
  the diagonal problem. Floating UI's `useHover` offers exactly these primitives: `restMs` (only
  open when the cursor is at rest) and `safePolygon` (keep open while the cursor moves toward the
  panel).
* **Fix:** open after the pointer has rested for 300 ms on the icon (rest, not dwell), close
  350 to 400 ms after leaving both icon and panel, keep the existing gap bridge and add a
  triangle (safe polygon) toward the panel. Keyboard focus-visible still opens immediately.

### D5 (Medium). Tooltip trail: every icon crossed shows its tooltip instantly, several at once

* **Evidence** (`NAV/sheets/d1440d-tooltip-trail.png`; events in `09-tooltip-flyout.json`):
  after the first tooltip opens, moving 200 ms down the rail shows "Case Manager", "Campaigns"
  and "Logs" instantly, with two tooltips mounted together for about 100 to 190 ms, and the
  "Logs" tooltip still visible for 150 ms after the Workspace flyout opened. In the chat page
  they print over the history list.
* **Root cause:** one global `TooltipProvider delayDuration={200}` (`App.tsx:221`) with Radix's
  default `skipDelayDuration` of 300 ms (Radix documents defaults of 700 ms and 300 ms), so
  once any tooltip has opened, every tooltip within 300 ms opens with no delay; each Radix root
  also plays its own exit animation, so they overlap.
* **Fix:** give the rail its own provider: `delayDuration` 300 ms, `skipDelayDuration` 0 for the
  rail, and hide childless-item tooltips while a group flyout is open. Alternatively label every
  item with the same flyout surface (one surface, one timer), which Option B and C do.

### D6 (Medium). Clicking a grouped rail icon flashes its flyout before navigating

* **Evidence** (`NAV/sheets/d1440l-click-group-flash.png`, frames #012 to #016): clicking
  Workspace shows the Workspace flyout for 211 ms (1440) or 113 ms (1920) and then the page
  cross-fades to the Chat route.
* **Root cause:** a pointer click focuses the button; `onFocusCapture` (`NavSidebar.tsx:675-678`)
  calls `openImmediately()` regardless of input type, then `navigate()` clears it (`841-849`).
* **Fix:** only open on focus when the focus is keyboard focus (`:focus-visible` on the target,
  or a pointerdown flag), and never open a flyout as a side effect of the click that navigates.

### D7 (Medium). One-off easing and timing that front-loads the motion

* **Evidence:** the rail, its chevrons and its flyouts use `ease-premium`
  `cubic-bezier(0.16,1,0.3,1)`. Evaluated numerically, it covers 49 percent of the distance at
  10 percent of the time, 75 percent at 20 percent and 97 percent at 50 percent. In a 200 ms
  transition that is three quarters of the movement in the first 40 ms and almost nothing in
  the last 100 ms, matching the frames (aside 240 to 119 px in the first 37 ms). Combined with
  D1 it reads as a snap followed by a crawl. Elsewhere the app uses `ease-standard`
  `cubic-bezier(0.2,0,0,1)` (50 percent at 20 percent of the time) and the spring tokens
  (`SPRING_UI` 0.3 s, `SPRING_PANE` 0.35 s, `variants.ts:38-41`); the mobile Sheet opens with
  `duration-pane` and `ease-spring` (`ui/sheet.tsx:32`).
* **Root cause:** `NavSidebar.tsx:434`, `631`, `721`, `864` and `AppShell.tsx:1520` hard-code
  `ease-premium`, which `theme.css:189-192` describes as an entrance curve, not a resize curve.
* **Fix:** use the standard UI curve for the rail (`ease-standard`, 200 ms open, 160 ms close)
  or the pane spring; chevrons 150 ms `ease-standard`; flyouts follow the menu recipe.

### D8 (Medium). Disclosure groups: instant children, rotating chevron, long frame per toggle

* **Evidence** (`NAV/d1440l-frames/04-groups/`): the children list appears in a single frame
  while the chevron takes 200 ms; each group toggle produced a 53 to 81 ms Long Animation Frame
  in the dev build.
* **Root cause:** `NavSidebar.tsx:441-454` mounts the `<ul>` with no transition; `openGroups`
  lives in AppShell (`AppShell.tsx:1171`), so each toggle re-renders the whole shell including
  the top bar, and also writes `localStorage` and a `PUT` (`NavSidebar.tsx:184-192`).
* **Fix:** animate the children with the CSS `grid-template-rows: 0fr to 1fr` pattern plus
  opacity (200 ms `ease-standard`), or keep them instant and make the chevron instant too; move
  nav state into a small external store read with `useSyncExternalStore` (the pattern already
  used by `soc/chat-activity/store`), so a toggle re-renders only the nav.

### D9 (Low). The labelled list overflows with a few groups open

* **Evidence:** with Workspace, Intelligence, Analytics and Settings open the list's
  `scrollHeight` is 1,276 px against a 693 px (1280x800), 793 px (1440x900) or 973 px
  (1920x1080) viewport. Headless Chromium hides scrollbars, but the app sets a 10 px WebKit
  scrollbar (`theme.css:552-555`), so on Windows and Linux classic scrollbars the label column
  narrows by 10 px the moment a group opens and widens again when it closes.
* **Fix:** `scrollbar-gutter: stable` on the nav scroller (`NavSidebar.tsx:912`), which reserves
  the gutter in both states (MDN, scrollbar-gutter).

### D10 (Medium). Mobile sheet: slow start, double animation, list jumps while closing

* **Evidence** (`NAV/sheets/m390l-open.png`, `NAV/sheets/m390l-navigate.png`): after tapping the
  menu about 200 ms pass before the sheet moves (a 115 ms Long Animation Frame, 58 ms
  blocking, while the full nav mounts); the sheet then slides for about 270 ms while the list
  inside it also runs its own fade (labels without icons in #018). On navigating, the closing
  sheet re-renders: the auto-opened Overview group collapses and the list jumps up while the
  sheet slides out (#009 at 172 ms).
* **Root cause:** `NavSidebar.tsx:914` and `965` add `animate-fade-in` inside the sheet;
  `mobileOpenGroups` (`AppShell.tsx:1172-1177`) is derived from the current page, and
  `navigateFromMobile` (`1198-1205`) closes the sheet and changes the page in the same tick.
* **Fix:** no inner fade when the nav is inside a Sheet; snapshot the open groups when the sheet
  opens and keep them until the close animation ends; optionally navigate after the close
  starts. Pre-mounting the nav tree hidden (or keeping the Sheet content mounted) removes the
  open stall.

### D11 (Low). Small visual seams

* The brand tile shifts 2 px between `px-2` centred and `px-3` (`NavSidebar.tsx:874`).
* The wrapper's `z-40` exists only while collapsed (`AppShell.tsx:1521`), so stacking changes at
  the start of a toggle.
* The active-trail bar is 2 px wide in the drawer and 4 px wide (`-left-2`) on the rail
  (`NavSidebar.tsx:371`, `391` versus `642-646`), so the indicator changes shape on toggle.

### What already works

* Reduced motion: width, chevron and flyout transitions are off and overlays cross-fade.
* Flyout geometry: viewport clamping, the 8 px pointer bridge and Escape-to-trigger behave.
  Aiming diagonally at the last child of the Intelligence flyout across the Analytics icon kept
  the right flyout open in every run (`07-diagonal`).
* Active page marking (`aria-current`) is maintained in both states.

## 5. How others do it

| Product | Pattern | Collapse control | Hover behaviour | Widths and motion | Source |
|---|---|---|---|---|---|
| Linear | Full-height sidebar that can be fully collapsed | `[` shortcut, click the sidebar border, or "Collapse"/"Expand" in the command menu; expand from the top-left icon | None documented | Not documented | [Linear changelog](https://linear.app/changelog/unpublished-collapsible-sidebar) |
| Notion | Resizable sidebar, fully hideable | `<<` button, Cmd/Ctrl+\\, drag the right edge to resize | The help page documents no peek, but a Chrome extension exists only to stop the sidebar "opening on hover" (about 567 users) | Not documented | [Notion help](https://www.notion.com/help/navigate-with-the-sidebar), [NotionSidebarHider](https://chromewebstore.google.com/detail/notionsidebarhider/laogfgfllgbpkdbggdbmlfbogikkfinj) |
| Slack (2023 redesign) | Top-level areas (Home, DMs, Activity, Files) as tabs beside the channel sidebar | Not documented in the source | Not documented in the source | Not documented | [Slack help](https://slack.com/intl/en-au/help/articles/16764236868755-An-overview-of-Slacks-new-design) |
| GitHub (2023) | No persistent rail; the hamburger opens a site-wide menu | Hamburger button | None | Not documented | [GitHub blog, Justin Young, 2023-06-15](https://github.blog/2023-06-15-exploring-github-with-the-redesigned-navigation-now-in-public-beta/) |
| Vercel (2026) | Resizable sidebar that "can be hidden"; mobile uses a floating bottom bar | Hide control | Not documented | Not documented | [Vercel changelog, 2026-02-26](https://vercel.com/changelog/dashboard-navigation-redesign-rollout) |
| Microsoft Fluent 2 Nav | Inline drawer next to content (default 260 px); becomes an overlay drawer at 640 px and below | Hamburger, "a persistent and predictable UX pattern"; tooltip text "Expand navigation" / "Collapse navigation" | Not specified | Fluent drawers move with `translate3d`; a small drawer enters in `durationGentle` 250 ms with `curveDecelerateMid` `cubic-bezier(0,0,0,1)` and exits with `curveAccelerateMin` | [Fluent 2 Nav usage](https://fluent2.microsoft.design/components/web/react/core/nav/usage), [drawerMotions.ts](https://github.com/microsoft/fluentui/blob/master/packages/react-components/react-drawer/library/src/shared/drawerMotions.ts), [durations.ts](https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/durations.ts), [curves.ts](https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/curves.ts) |
| Material 3 navigation rail | Collapsed rail 96 dp (narrow 80 dp) with labels under icons; expanded 220 to 360 dp; a modal expanded rail "is elevated above the app's UI and doesn't affect the screen's layout grid" | Explicit | None | Standard rail animates with the DefaultSpatial spring (damping 0.9, stiffness 700, settles in roughly 170 ms); the modal one with FastSpatial (0.9, 1400) | [NavigationRailCollapsedTokens.kt](https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/NavigationRailCollapsedTokens.kt), [NavigationRailExpandedTokens.kt](https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/NavigationRailExpandedTokens.kt), [WideNavigationRail.kt](https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/WideNavigationRail.kt), [StandardMotionTokens.kt](https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/StandardMotionTokens.kt) |
| Apple (HIG, macOS) | Sidebar beside content; on macOS 26 it floats over content in the Liquid Glass layer | Show/hide button or View menu commands; "Avoid hiding the sidebar by default"; consider auto-collapse when the window shrinks | None | No more than two levels of hierarchy | [HIG Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) |
| shadcn/ui Sidebar (the primitives our UI is built on) | 16 rem expanded, 3 rem icon mode, 18 rem mobile sheet; one DOM for both states | `SidebarTrigger`, Ctrl/Cmd+B, a click strip on the border (`SidebarRail`) | None | Spacer `transition-[width] duration-200 ease-linear`; icons never move; group labels fade to `opacity-0` with `-mt-8`; labels clipped | [sidebar.tsx](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sidebar.tsx), [docs](https://ui.shadcn.com/docs/components/radix/sidebar) |
| GitLab (super sidebar) | 2023: collapsed meant fully hidden, revealed as an overlay by hovering the toggle or the left 8 px of the page; concerns that this "chromeless" state hurt people who keep the sidebar collapsed; users asked for icons only | Today: an icon-only mode; "The left sidebar can never be fully collapsed on desktop"; the peek component is gone from `master` | Removed | Not documented | [issue 378544](https://gitlab.com/gitlab-org/gitlab/-/issues/378544), [issue 390773](https://gitlab.com/gitlab-org/gitlab/-/issues/390773), [issue 389958](https://gitlab.com/gitlab-org/gitlab/-/issues/389958), [issue 431164](https://gitlab.com/gitlab-org/gitlab/-/issues/431164), [collapsed state manager](https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/assets/javascripts/super_sidebar/super_sidebar_collapsed_state_manager.js) |
| Elastic Kibana 9.2 (hosts Elastic Security) | Collapsed mode is a column of icons with tooltips; "Access both main and submenu items with just one click"; hover menus | Explicit | Hover menus open submenus | Research: "Collapsed mode required multiple clicks just to access the menu"; over 70 percent of 66 open-text responses were frustrated with the earlier navigation | [Elastic Search Labs, 2025-10-23](https://www.elastic.co/search-labs/blog/elastic-kibana-9-2-navigation-refresh) |
| Datadog (2024 redesign) | Core features at the top and bottom of the sidebar, features grouped by product area, room for favorites | Not documented in the source | Not documented in the source | Not documented | [Datadog blog via mirror, 2024-04-16](https://www.plushcap.com/content/datadog/blog/datadog-datadog-navigation-redesign) |
| CrowdStrike Falcon | Menu opens from a button in the top-left corner; Ctrl+/ (Cmd+/) shortcut | Button or shortcut | Not documented | Not documented | [CU Boulder Falcon guide, July 2024](https://oit.colorado.edu/software-hardware/software-catalog/endpoint-detection-response/crowdstrike/private-tenant-user-guide) |
| Splunk Enterprise Security 8.6/8.7 | Main navigation with feature icons; 8.6 added collapsible secondary side panels, 8.7 removed them in favour of direct pages and a queue header | Not documented | Not documented | Not documented | [Splunk ES 8.7 get started](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.7/introduction/get-started-with-splunk-enterprise-security) |

Cross-cutting guidance:

* Hover intent: wait 0.3 to 0.5 s with the cursor stopped, show within 0.1 s, keep visible
  until the cursor has been away for more than 0.5 s, and solve the diagonal problem with a
  triangle ([NN/g, Aurora Harley, 2015](https://www.nngroup.com/articles/timing-exposing-content/)).
  SAP Fiori uses the same 300 to 500 ms window
  ([SAP Fiori timing](https://www.sap.com/design-system/fiori-design-web/v1-145/foundations/interaction/timing)).
  Floating UI implements it as `restMs` and `safePolygon`
  ([Floating UI useHover](https://floating-ui.com/docs/usehover)).
* Tooltip defaults: Radix `delayDuration` 700 ms, `skipDelayDuration` 300 ms
  ([Radix Tooltip](https://www.radix-ui.com/primitives/docs/components/tooltip)).
* Performance: animate only `opacity` and `transform`; avoid properties that trigger layout or
  paint ([web.dev, high-performance CSS animations](https://web.dev/articles/animations-guide)).
* Timing range in the systems above: 200 ms linear (shadcn), 250 ms decelerate (Fluent small
  drawer), roughly 120 to 170 ms springs (Material 3), and our own `SPRING_PANE` 350 ms for
  panes. A 180 to 240 ms open with a shorter close sits in the middle of all of them.

What the field converges on: icons do not move when the panel changes; the collapse is an
explicit choice (button, shortcut, border click); hover expansion of the whole panel is either
absent or was walked back (GitLab), and where it exists some users actively disable it
(Notion); sub-destinations in a collapsed rail should be one action away (Kibana).

## 6. Options for the operator

All three options keep the mobile Sheet (with the D10 fixes), keep Ctrl/Cmd+B, keep reduced
motion as "no movement, short cross-fade at most", and include every shared fix in section 7.
Screenshots of each option are the job of the options stage; the evidence that exists today is
the overlay prototype in `NAV/sheets/optionB-proto-expand.png` (content never moves, the D1
label cramming is still visible at #009 because the prototype did not change the markup).

### Option A (recommended): docked rail, explicit toggle, stable morph

The model the operator already uses, rebuilt so nothing jumps.

* **States:** collapsed 64 px icon rail, expanded 240 px labelled drawer (as today). The
  choice is explicit and persisted. No hover expansion of the rail.
* **Controls:** one toggle element in a fixed slot at the top of the icon column (x 16 in both
  states, "Collapse navigation" / "Expand navigation" tooltip with the shortcut); a 6 px click
  strip on the rail's right border (Linear, shadcn `SidebarRail`); Ctrl/Cmd+B. Focus stays on
  the toggle after every toggle.
* **One DOM:** every row is `[40 px icon cell at a fixed inset][label]`. Icons are one size in
  both states and never move horizontally or vertically. Group headers keep a 24 px slot and
  cross-fade between their text and a divider. Chevrons fade out when collapsed. Children of a
  group are hidden (and made `inert`) when collapsed.
* **Choreography, expand (200 ms):** at t = 0 the in-flow spacer jumps from 64 to 240 px (one
  page relayout, no transition) and the panel's background layer scales from `scaleX(0.267)` to
  `scaleX(1)` from the left edge with `ease-standard` `cubic-bezier(0.2,0,0,1)`; labels and
  headers fade in over 120 ms starting at 60 ms. Only `transform` and `opacity` animate.
* **Choreography, collapse (160 ms):** labels fade out over 80 ms at once; at t = 0 the spacer
  jumps to 64 px (the page moves under the still-opaque panel, so the move is hidden); the
  background scales back to `scaleX(0.267)` over 160 ms, revealing the page.
* **Grouped items in the collapsed rail:** click navigates to the host page (as today, no
  flash); the flyout opens on 300 ms pointer rest or immediately on keyboard focus-visible,
  closes 400 ms after the pointer leaves both, with a safe triangle; fade plus 4 px slide in
  150 ms.
* **Pros:** smallest behaviour change; matches ui-standard and shadcn/Fluent/Material practice;
  fixes D1 to D3 and D7 at the root; page relayout happens once per toggle, so slower machines
  lose at most one frame at the start instead of the whole animation.
* **Cons:** the page still shifts by 176 px once per toggle (at the moment of the click, which
  reads as the response); requires reworking `NavSidebar.tsx` row markup.
* **Effort and risk:** medium; NavSidebar tests that assert the two markups will need updating.

### Option B: fixed 64 px rail plus an overlay drawer that never pushes

Round 9b's idea done properly, closest to Material 3's modal rail and GitLab's 2023 overlay.

* **Layout:** the rail always reserves 64 px. Opening the labelled drawer slides a 240 px
  panel over the page with a shadow and no scrim; the page never reflows (measured: about half
  the main-thread cost of today at 4x CPU).
* **Open:** the toggle, Ctrl/Cmd+B or a click on a grouped icon (which opens the drawer
  scrolled to that group, replacing per-group flyouts). Optional hover peek, off by default:
  pointer at rest on the rail for 300 ms. Opening never changes focus order; focus moves into
  the drawer only when it was opened from the keyboard.
* **Close:** 400 ms after the pointer leaves the drawer (peek only), Escape, a click outside,
  or choosing a destination. A "Keep open" pin docks it (becomes Option A's docked mode) for
  people on wide screens who want permanent labels.
* **Motion:** enter `translateX(-176px)` to 0 plus shadow fade, 200 ms
  `cubic-bezier(0,0,0,1)` (Fluent's decelerate); exit 150 ms `cubic-bezier(0.8,0,0.78,1)`
  (Fluent's accelerate). Labels never move relative to the panel.
* **Pros:** zero page reflow on open; quick access to labels without giving up width at 1280
  to 1440; one flyout pattern instead of two.
* **Cons:** a hover-peek default is what GitLab walked back and what some Notion users install
  an extension to disable, hence off by default; two modes (peek and pin) to explain.
* **Effort and risk:** medium to high (overlay focus management, pin state, tests).

### Option C: labelled rail, no expansion at all

The calmest option, like Slack's tab rail or Material 3's 80 dp rail.

* **Layout:** a fixed 80 px rail; each destination is a 20 px icon with an 11 px label under it
  (two lines at most). No collapsed or expanded state, no toggle, no width animation.
* **Groups:** Overview, Workspace, Intelligence, Analytics, Notifications and Settings open a
  menu-style flyout on click, Enter or Space (not hover), anchored to the right, 150 ms fade plus
  4 px slide, Escape returns focus to the icon.
* **Labels:** need short forms (for example "Scans" instead of "Automated scans (legacy)",
  "Case Mgr" or a shorter product term for "Case Manager"); full names stay in tooltips and the
  breadcrumb.
* **Pros:** nothing to animate, nothing to get wrong; labels always visible; 160 px narrower
  than today's expanded drawer.
* **Cons:** 16 px wider than today's collapsed rail; label shortening is a product decision;
  loses the full labelled tree view some operators like at 1920.
* **Effort and risk:** medium (registry gains a short label; NavSidebar rewritten; tests).

### Comparison

| | A docked, stable morph | B fixed rail + overlay | C labelled rail |
|---|---|---|---|
| Page reflow per toggle | once, at the click | never | never (no toggle) |
| Animated properties | transform, opacity | transform, opacity | opacity, small transform on menus |
| Hover behaviour | flyouts only, 300 ms rest | optional peek, off by default | none |
| Width cost when collapsed / open | 64 / 240 px | 64 px always | 80 px always |
| Matches today's mental model | yes | mostly | no |
| Best fit | operators who toggle rarely and like the full tree | narrow screens, frequent quick access | operators who want zero motion |

## 7. Shared fixes (needed whichever option is chosen)

1. **S1 one DOM per row** (D1); not needed in Option C, which has one state.
2. **S2 never unmount the focused toggle**; assert in a test that focus stays on it (D3).
3. **S3 hover intent**: 300 ms rest to open, 400 ms grace to close, safe triangle, keyboard
   focus-visible opens immediately, pointer focus never does (D4, D6).
4. **S4 rail-local TooltipProvider**: 300 ms delay, no skip delay, suppressed while a flyout or
   drawer is open (D5).
5. **S5 one motion vocabulary**: `ease-standard` 200 ms open, 150 to 160 ms close, chevrons
   150 ms, flyouts 150 ms like menus; drop `ease-premium` from the nav (D7). Record the values
   in `ui-standard.md` "Navigation and information architecture".
6. **S6 nav state out of AppShell** into a small external store with `useSyncExternalStore`, so
   rail and group toggles re-render only the nav (D2, D8).
7. **S7 `scrollbar-gutter: stable`** on the nav list (D9).
8. **S8 mobile**: no inner fade inside the Sheet; freeze open groups for the life of an
   open/close cycle; avoid mounting the whole nav on tap (D10).
9. **S9 single spacer change per toggle**, so container-query tiers in the top bar flip once
   instead of mid-animation (D2, the 1280 breadcrumb flip).
10. **S10 keep reduced motion as it is today**: instant layout, opacity-only overlays.
11. **S11 regression guards**: a browser test that samples icon x positions during a toggle
    (must stay constant), checks `document.activeElement` after keyboard toggles, counts flyouts
    opened by a scripted 1 s sweep (must be 0), and checks that no flyout mounts on a pointer
    click of a grouped icon. The harness in `notes/nav-repro.mjs` already measures all four.

## 8. Open questions for the operator

1. Which option: A (docked, explicit toggle, recommended), B (fixed rail with an overlay
   drawer) or C (labelled rail, no expansion)?
2. For A and B: should hover ever expand the panel? The recommendation is no (A) or an opt-in
   setting that is off by default (B).
3. Do you mostly keep the rail collapsed (as in the Round 13 reference tour) or expanded? That
   decides whether the flyouts (A) or the drawer (B) get the most polish.
4. For C: are short labels such as "Scans" and "Case Mgr" acceptable?
5. Should the new nav timings become the shared standard for other side panes (chat history
   rail, report panel), so the whole Console moves with one rhythm?
