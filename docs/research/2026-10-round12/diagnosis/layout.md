# D3: Chat page layout and visual glitches (diagnosis)

Scope: operator screenshots 1, 3 and 4 (layout), plus the "Report · 0" and composer "0%"
questions. Diagnosis only; no repo file was modified. Every finding below was reproduced in
the live demo (vite dev :5173, Demo Mode) unless marked "code reading".

Probe scripts: `r12/diag/scripts/layout/` (`s1_setup.mjs` builds one conversation with
kpi_group, chart, report, case_list and table blocks; `s2_matrix.mjs` measures 32 layouts:
widths 1280/1440/1920/2560, nav 240/64, history rail docked/strip, report panel
closed/open; `s5_light.mjs` and `s6_escape.mjs` cover the frame-scroll bug; raw JSON in
`matrix-dark.json`, `light.json`, `light-shots.json`). Screenshots: `r12/shots/diag-layout-*.png`.
The demo context response was patched in the browser (Playwright route, not demo state)
to enable the default $10/day budget, so the "0%" ring renders as it does for the operator.

---

## 0. Summary

| # | Symptom (screenshot) | Root cause | Evidence |
|---|---|---|---|
| a | Narrow centered column with everything collapsed (1) | The lane is a fixed centered track: prose, bubble and composer are `min(48rem,100%)`, and blocks can only break out by 8rem per side (64rem max). Extra width goes to two `1fr` side tracks. | `webui/src/soc/chat/message/lane.ts:15-16, 29-30, 33, 36`; SPEC `docs/research/2026-10-chat-revamp/SPEC.md:908-909` prescribes it |
| b | Blocks wider than and misaligned with prose and composer (3, 4) | `WIDE_COL` = grid lines 2 to 5, so a block grows 8rem on both sides of the prose. Its left edge is 128 px left of the prose, the follow-ups and the composer. The card adds `px-3`, so card text starts 116 px left of the prose. | `lane.ts:36`; `message/Message.tsx:345`; `blocks/BlockCard.tsx:528-531`; composer uses `CONTENT_COL` at `workspace/ChatWorkspace.tsx:455-456` |
| c | KPI "≥… in the returned …" and an empty fourth cell (4) | (1) The grid has a fixed `@[60rem]:grid-cols-6`, whatever the item count. With 3 items, 3 tracks stay empty inside the closed frame. (2) The chat passes `item.context` as KpiTile `secondary`, which sits BESIDE the numeral in one flex row. Both are `min-w-0 truncate`, so in a 166 px cell both are cut. | `blocks/renderers/KpiGroupView.tsx:138-145` (grid), `:109-115` (secondary); `components/KpiTile.tsx:739-790` (row), `:752` (numeral truncate), `:626-641` (secondary truncate). KpiTile's own doc `:150-155` records this failure ("turned 72% into 7…") and the hero-only fix |
| d | Composer floats mid-page, blank band below, rail border stops short (3, light) | The overflow-hidden chat FRAME becomes scrollable. Each turn's `sr-only` `<h3>` ("You"/"Assistant") is `position:absolute`. Its containing block is the Transcript wrapper (`relative`, OUTSIDE the scroll lane). So these headings escape the lane's clip and give the frame a scrollHeight of 3721 px against a clientHeight of 777 px. Any programmatic scroll then moves the whole frame: `scrollIntoView` (report Contents jump), `focus()` without `preventScroll`, or find-in-page. The toolbar slides under the header, the strip and section end early, and the user cannot scroll it back (overflow hidden: no scrollbar, no wheel). | `message/Transcript.tsx:401` (`relative` wrapper), `:402-405` (lane not positioned), `message/Message.tsx:283` and `message/UserTurn.tsx:51` (sr-only h3); frame `workspace/ChatWorkspace.tsx:366` (`overflow-hidden`). Triggers: `blocks/renderers/ReportView.tsx:64` (`scrollIntoView`), `message/Message.tsx:216` (`entry.focus()`) |
| e | "Jump to latest" overlaps content (1, 3) | The pill is absolutely positioned over the bottom of the lane (`absolute inset-x-0 bottom-0` plus a 48 px fade). It always covers the last visible lines: prose bullets in screenshot 1, a case row and "Escalated"/"Risk" chips in the demo. Separately, up to 72 px of content (a whole follow-up row) can be hidden under the fold with no pill, because "near the bottom" means ≤ 72 px. | `message/Transcript.tsx:466-497`, `:239`, `:250`, `FOLLOW_THRESHOLD_PX` `:42` |
| f1 | "Report · 0" | This counts the items the analyst has added to the conversation's report collection. It is unrelated to the report the model wrote in the answer (a `report` block captioned "Brief"). It always shows the count, including "· 0". The panel heading repeats the word ("REPORT" eyebrow over "Report"). | `workspace/ThreadToolbar.tsx:229-241`; `report/ReportPanel.tsx:621-627` |
| f2 | Composer "0%" ring | `BudgetRing` = today's AI spend ÷ the daily budget, rounded. $0.004 of $10 prints "0%". It sits next to "≈ 3.2k" with no visible label, so it reads as context-window usage, as in Claude or Cursor. It is meaningful only to assistive tech (`aria-valuetext` "0% of today's AI budget used, $0.004 of $10.00"). | `composer/BudgetRing.tsx:31-60`, `composer/format.ts:233-243`, placement `composer/TokenMeter.tsx:156`, `composer/Composer.tsx:592-595` |
| g | (extra) Geometry frozen after mount in dev | `useChatGeometry` disconnects its ResizeObserver in a `useEffect` cleanup, but creates it in a ref callback. Under React 18 StrictMode (dev, i.e. `run-demo.sh`), the simulated unmount disconnects it, and the ref callback never re-observes. `frameWidth` stays at its mount-time value. Measured at 900 px viewport: frame 612 px, but the rail stays docked and the conversation is crushed to 348 px. At 1280 the report split opened with a 359 px conversation (below C_min 640). Toolbar compaction uses the same stale width. | `workspace/useChatGeometry.ts:131-149` (`:149` is the cleanup); `webui/src/main.tsx:12` StrictMode; React 18.3.1. Production builds do not double-invoke effects, so prod is believed unaffected (not built here) |
| h | (extra) 24 px canvas strips left and right of the chat | The frame bleeds the shell inset only vertically (`-my-6`), not horizontally. Every layout measured `gutterLeft = gutterRight = 24`. In light theme this is the grey band between the nav rail and the history strip in screenshot 3 (x≈80-115). | `ChatWorkspace.tsx:366`; `AppShell.tsx:143` (`CONTENT_INSET` `px-4 sm:px-6`) |

---

## 1. Measurements (dark; light matches, the geometry is theme-independent)

Conversation = the `<section aria-label="Conversation">` width. "Fill" = prose ÷ conversation.

| Viewport | nav | rail | panel | conversation | prose x,w | block x,w | composer x,w | fill | KPI cols/items |
|---|---|---|---|---|---|---|---|---|---|
| 1280 | 64 | strip | closed | 1120 | 312,768 | 184,1024 | 312,768 | 69% | 6/6 (166 px) |
| 1440 | 64 | strip | closed | 1280 | 392,768 | 264,1024 | 392,768 | **60%** | 6/3 (3 empty) |
| 1920 | 64 | strip | closed | 1760 | 632,768 | 504,1024 | 632,768 | **44%** | 6/3 |
| 2560 | 64 | strip | closed | 2400 | 952,768 | 824,1024 | 952,768 | **32%** | 6/3 |
| 2560 | 240 | docked | closed | 2008 | 1148,768 | 1020,1024 | 1148,768 | 38% | |
| 1920 | 64 | strip | split | 1391 | 448,768 | 320,1024 | 448,768 | 55% | |
| 1440 | 64 | strip | split | 911 | 208,768 | 170,843 | 208,768 | 84% | 3/3 |

* At every width ≥ 1280 with everything collapsed, the composer is 768 px and blocks are
  1024 px. That is 47-57% of the window's horizontal space left unused at 1920-2560
  (screenshot 1).
* Every block's left edge sits 128 px (8rem) left of the prose, the follow-up chips and the
  composer. At 1280 and docked, the side tracks shrink, so the offset varies with width
  (26 px at 1440 docked, 34 px at 1280 docked). The edge is not even consistent.
* The open-cases KPI reproduces screenshot 4 exactly: 3 items in 6 tracks. "STILL OPEN"
  shows `≥…` (numeral 39 px into 35 px) and `in the returned p…` (110 px into 98 px).
* No document overflow in any layout (`docOverflow = 0`). Symptom (d) is the FRAME's own
  scroll, not the page's (section 2).

Screenshots:
* Collapsed, the operator's case: `diag-layout-dark-{1280,1440,1920,2560}-navC-railC-panelC.png`, `diag-layout-light-{1440,2560}-navC-railC-panelC.png`
* Screenshot 4 reproduced: `diag-layout-dark-1440-kpi-open-cases.png`, `diag-layout-light-1440-navC-railC-panelC.png`
* Screenshot 3 reproduced (toolbar gone, blank band, strip border stops short): `diag-layout-light-1390-after-toc-jump.png`
* Report split: `diag-layout-dark-{1920,2560}-navC-railC-panelO.png`, `diag-layout-light-1440-navC-railC-panelO.png`
* Stale geometry (g): `diag-layout-dark-900-stale-geometry.png`, `diag-layout-dark-1280-navE-railD-panelOpen.png`

## 2. (d) in detail: why the composer "floats"

`s6_escape.mjs` at 1390×833 light, on load: `frame.scrollHeight = 3721`, `clientHeight = 777`.
17 absolutely positioned descendants of the lane resolve their containing block to
`div.relative.flex.min-h-0.flex-1.flex-col` (Transcript.tsx:401). That wrapper is outside
the scroll lane, so the lane does not clip them. The 4 below the fold are the `sr-only`
`<h3>` turn headings, at y = 2778-3777. The frame is `overflow-hidden`: that clips
visually but stays programmatically scrollable.

Clicking the last entry of a report's "Contents" list calls `el.scrollIntoView({block:'start'})`
(ReportView.tsx:64). The browser scrolls the lane AND the frame: `frameST` goes from 0
to 44. The section moved up 44 px (`secTop` 56 → 12), the toolbar hid under the sticky
header, and the frame background showed below the composer. Screenshot 3 shows the same
state with roughly 178 px of frame scroll. Nothing scrolls it back, because wheel and
keyboard do not scroll an `overflow:hidden` box. The next layout change does not reset it either.

Other triggers of the same scroll: `focus()` without `preventScroll` on an element near
the lane bottom (`Message.tsx:216` source entry; Radix focus on menus and sheets), Chrome
find-in-page, and a citation or anchor jump.

Fix (both parts, belt and braces):
1. Make the scroll lane the containing block. Add `relative` to the lane div (`Transcript.tsx:405`)
   or to the content grid (`:408`), so every abspos descendant (sr-only headings, KPI
   sr-only text, chart overlays) is clipped and scrolled by the lane.
2. Frame `overflow-hidden` → `overflow-clip` (`ChatWorkspace.tsx:366`). `overflow: clip`
   forbids programmatic scrolling, so a future escapee cannot move the frame. Leave the
   composer area's `overflow-hidden` (`:454`): its `scrollbar-gutter` needs a
   hidden, auto or scroll overflow.
3. Optional: `ReportView` jump → `el.scrollIntoView({ block: 'start', container: 'nearest' })`
   (Chrome 136+), or compute and scroll the lane directly, as Transcript already does.

Tests to update: `pages/__tests__/Chat.test.tsx:370` and
`__tests__/route-visual-standard.test.ts:134` pin `overflow-hidden` on the frame. Add a
jsdom test: the lane has `position: relative`. Add a Playwright-style assertion in QA:
`frame.scrollHeight === frame.clientHeight`.

## 3. Proposed responsive width model ("one lane, two edges")

Principles, from the Apple design skill (`r12/apple-design-SKILL.md`):
* §16.7 Craft: "nothing is random — every spacing … and alignment value is a deliberate
  choice". Today the block edge moves with width and never matches the prose.
* §16.5 Flexibility: "desktop = deep workflows … let people personalize". Use the width
  that is there, and offer a density choice.
* §12 "Scroll edge effects, not hard dividers": content scrolls under floating chrome, with
  a soft mask only where they overlap.
* §15: keep body text near an optimal measure.

Measured: the prose is 15 px Inter. The current 768 px prose column is **85 ch** of "0",
about 100+ mixed characters per line, already at the upper limit of comfortable reading.
So the prose should NOT simply get wider. The lane should, and everything that is not
running text should use it.

Model (all in rem, container-measured, never viewport breakpoints):
* **Frame bleeds fully** (fix h): `-mx-4 sm:-mx-6 w-auto -my-6`, a matched pair with
  `CONTENT_INSET`, exactly like CaseManager.tsx:867-875. +48 px everywhere.
* **Lane L** = `min(conversation − 2·gutter, --chat-lane-max)`, centred in the conversation.
  The gutter is `clamp(1rem, 2.5cqi, 2.5rem)`.
  `--chat-lane-max` is set by a per-viewer **Width** preference in the composer Options or
  thread ⋯ menu (localStorage, like `soc.chat.railCollapsed`):
  Comfortable = 64rem, **Wide = 88rem (default)**, Full = none.
* **Prose P** = `min(L, 48rem)`, **left-aligned on the lane's left edge** (`justify-self:start`),
  not centred. The same applies to notices, the run log, the meta row, follow-ups and the
  Continue chip.
* **Blocks** span the full lane L from the same left edge. Optical alignment: the card frame
  hangs into the gutter by its padding (`-mx-3 px-3` on the card `figure`), so the card's
  title and table text start exactly on the prose edge. Nested report leaves keep `bare`.
* **User bubble**: right-aligned on the lane's right edge, max `min(36rem, 100%)`, as in
  Messages. The page then has exactly two edges: lane-left (assistant) and lane-right
  (user and block right edges).
* **Composer** spans the lane L (both edges), so it lines up with the widest content.
  `BudgetAlert` uses the same span.
* **Empty state** (`EmptyState.tsx:103` `max-w-3xl`): the starter grid may use L
  (3 columns from about 56rem).

Resulting widths (nav 64, rail strip, panel closed, after the full bleed):

| Viewport | conversation | gutter | lane L (Wide) | prose | blocks / composer | today (prose / blocks / composer) |
|---|---|---|---|---|---|---|
| 1280 | 1167 | 29 | 1109 | 768 | 1109 | 768 / 1024 / 768 |
| 1440 | 1327 | 33 | 1261 | 768 | 1261 | 768 / 1024 / 768 |
| 1920 | 1807 | 40 | 1408 | 768 | 1408 | 768 / 1024 / 768 |
| 2560 | 2447 | 40 | 1408 (Full: 2367) | 768 | 1408 / 2367 | 768 / 1024 / 768 |
| 1920 + split 360 | 1438 | 36 | 1366 | 768 | 1366 | 768 / 1024 / 768 |

CSS shape (replaces lane.ts's five tracks with three; the subgrid and repeated-tracks trick
stays as documented at lane.ts:21-30):

```
LANE_GRID     = grid grid-cols-[minmax(var(--chat-gutter),1fr)_minmax(0,var(--chat-lane-max,88rem))_minmax(var(--chat-gutter),1fr)]
CONTENT_COL   = col-start-2 col-end-3 min-w-0 w-full max-w-[48rem] justify-self-start   (prose, meta, follow-ups, notices)
WIDE_COL      = col-start-2 col-end-3 min-w-0                                           (blocks)
BUBBLE_COL    = col-start-2 col-end-3 min-w-0 justify-self-end                          (user turn)
COMPOSER_COL  = col-start-2 col-end-3 min-w-0                                           (composer + budget alert)
```

The Case Manager compact embed (`compact`) keeps the prose column for blocks (`Message.tsx:345`).

## 4. Fix list per symptom

* **(a)/(b)**: section 3. Files: `message/lane.ts`, `message/Message.tsx:345`,
  `message/Transcript.tsx:408-462` (header, replace and empty columns), `message/UserTurn.tsx`
  (bubble alignment), `workspace/ChatWorkspace.tsx:366, 454-456`, `blocks/BlockCard.tsx:530`
  (hanging frame), `empty/EmptyState.tsx:103`, and a new preference in
  `workspace/useChatGeometry.ts` (or a sibling hook) plus a menu item. Update SPEC §10.1
  (`SPEC.md:908-909`), BLOCKS.md:445 and the tests at
  `message/__tests__/Transcript.test.tsx:124` and `workspace/__tests__/useChatGeometry.test.ts`.
* **(c) KPI**:
  * Columns follow the item count, not a fixed 6. Use
    `grid-template-columns: repeat(auto-fit, minmax(max(10rem, calc((100% - (var(--n) - 1)px) / var(--n))), 1fr))`
    with `--n = min(items, 6)`. 3 items then make 3 equal columns that fill the frame, and
    6 items make 6 when ≥ 60rem. Or compute a balanced count (`cols = min(n, ⌊W/10rem⌋)`,
    `rows = ⌈n/cols⌉`, `cols = ⌈n/rows⌉`) via `@container` and a `data-count` attribute.
    No empty tracks. Keep the closed frame for a ragged last row.
  * Chat tiles put the context on its own line under the numeral: pass `item.context`
    as KpiTile `sub` (2-line clamp on the compact strip, `KpiTile.tsx:808-830`) with a sans
    override, not `secondary` (`KpiGroupView.tsx:109-115`). A numeral is never truncated:
    the numeral span gets `shrink-0` when a caption is present, or move its `truncate` to
    the label. This mirrors the `context` fix KpiTile already made for hero tiles
    (`:150-155`).
  * Drop the double frame (card border plus KPI frame border) inside a block card: either
    `bare` the KPI frame inside a card, or keep the hairline grid without the outer border.
* **(d)**: section 2.
* **(e) Jump to latest**:
  * Move the pill off the text. Centre it as a small round "↓" button sitting on the
    composer's top edge (half overlapping the composer area, `-top-4`), as ChatGPT and
    Claude do. Its fade is the scroll-edge mask (Apple §12): a 24-32 px
    `mask-image: linear-gradient(to top, transparent, black 24px)` on the lane's bottom
    edge, applied only while content sits below the fold.
  * Show it whenever any content is hidden below the fold (threshold about 8 px, not 72 px),
    or lower `FOLLOW_THRESHOLD_PX` for the indicator only. Today a whole follow-up row
    (≤ 72 px) can be cut with no affordance (`diag-layout-00-setup.png`, bottom).
* **(f1) Report · 0**: show the count only when > 0 (badge), e.g. "Report" plus "3". Use
  the tooltip "Items you added from this chat". Consider naming the collection
  "Pinned report" or "Collection", so it does not collide with the in-answer "Brief" report
  the user asked for. When the answer contains a `report` block, make its "Add to report"
  the obvious next step. Panel header: drop the duplicate "REPORT" eyebrow when the title
  is the default "Report" (`ReportPanel.tsx:621-627`).
* **(f2) 0% ring**: hide the ring below the soft-warn threshold (default 80%), or below 1%.
  Show it labelled ("$0.00 today") only when it matters. Or render "<1%" and give it a
  visible tooltip label "Today's AI budget". Never place an unlabelled % next to the
  token estimate. Context-window share already lives in the hover card (≥ 50%).
* **(g)**: create the observer in an effect keyed on the node, so StrictMode
  re-creates it, e.g. `const [node, setNode] = useState<HTMLElement|null>(null)` +
  `useEffect(() => { if (!node) return; const ro = …; ro.observe(node); return () => ro.disconnect(); }, [node])`.
  Delete the global cleanup at `useChatGeometry.ts:149`. Add a test that remounts under
  `<StrictMode>` and asserts the zones follow a later resize.
* **(h)**: full horizontal bleed (section 3). The history rail, strip and report panel then
  sit flush with the nav rail and the window edge.

## 5. Notes and caveats

* Demo Mode cannot reproduce the operator's real-LLM answers. The shapes (3-item lower-bound
  KPI with a context caption, a report block with a Contents list, follow-ups) come from the
  demo planner and match the screenshots.
* The KPI "truncated" detector also flags numerals inside off-screen exchanges
  (`content-visibility:auto` skips their layout, so `clientWidth` is meaningless). Only
  on-screen groups were counted as findings.
* The operator's screenshot 1 is an expanded-everything layout at about 1520 css px. The
  centred 768/1024 lane is exactly what the code prescribes there (SPEC §10.1), so (a) is a
  spec change, not a regression.
