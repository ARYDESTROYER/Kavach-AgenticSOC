# D7 — Overview ("Cyber Defence Center") crampedness diagnosis + redesign proposal

Diagnosis only; no repo file was modified. Live demo at http://127.0.0.1:5173/#/dashboard,
Admin, demo data (≈53 cases/24h). Light theme forced by rewriting `theme_mode` in the
`/api/prefs/effective` response in-browser (the Admin's server pref is `dark`, which overrides
`localStorage soc.theme` — `webui/src/soc/prefs.tsx:123`). No server state was mutated.

## 0. Evidence captured

Scripts: `scratchpad/r12/diag/scripts/ov/{capture,extra,deeper}.mjs` (raw JSON next to them:
`measure-dark_light.json`, `measure-light.json`, `extra.json`).
Screenshots (`scratchpad/r12/shots/`):

| What | Files |
|---|---|
| Above the fold, 4 widths × 2 themes | `diag-ov-{1280,1440,1920,2560}-{dark,light}-fold.png` |
| Full page, Deeper analytics collapsed | `diag-ov-{w}-{theme}-full.png` |
| Full page, Deeper analytics expanded | `diag-ov-{w}-{theme}-deeper.png` |
| KPI drill-down modal (FPR + Resolved/Closed partition) | `diag-ov-{1280,1440,1920,2560}-dark-modal-{fpr,resolved}.png`, `diag-ov-1440-light-modal-{fpr,resolved}.png` |
| Noise flow Detailed mode | `diag-ov-1440-dark-detailed.png` |
| KPI hover-trend card | `diag-ov-1440-dark-hovertrend.png` |
| Row-2 at 2560 (stretch) | `diag-ov-2560-dark-row2-crop.png` |
| "VERDICTS" donut glitch | `diag-ov-1440-dark-verdict-donut-crop.png` |

Note: the left nav state (pinned 240px vs 64px rail) varied between runs; the content width
numbers below state which applied.

## 1. Layout code + grid model

All layout is in one 3,545-line file, `webui/src/soc/pages/Overview.tsx` (render starts ~2676).

- Width: `<PageContainer variant="fluid" className="w-auto space-y-4 sm:-mx-2">` (`Overview.tsx:2693`).
  `fluid` = `max-w-none` (`components/PageContainer.tsx:42`). This contradicts that file's own
  archetype note, which puts Overview under `wide` and says "widen by COLUMN COUNT on ultrawide,
  not by stretching rows" (`PageContainer.tsx:9-11`).
- Masthead: `PageHeader` with the controls in `meta`, so the right half is empty on purpose (`:2709-2722`).
- KPI strip: `Stagger` grid `grid-cols-1 sm:2 md:3 xl:6` with hand-tuned `nth-child` divider
  math (`:2774-2810`, math comment `:2776`). Tiles use `density="compact"` + `numeral="hero"` (`:2842`, `:2848`). Compact
  sets `px-3`, `pb-2`, `min-h-0` (`components/KpiTile.tsx:856-860`).
- "Command lattice" (`Reveal data-testid="hero-row"`, `:2982-2985`), a single **gutterless** `xl:grid-cols-12`:
  - row 1 `:2992`: Noise flow `xl:col-span-8 px-3 py-3 … xl:border-r` (`:2994`) | Human-vs-AI `xl:col-span-4` (`:3058`).
  - row 2 `:3076`: snapshots `col-span-4` (`:3086`) | MTTD/response `col-span-4` (`:3155`) | Latest cases `col-span-4` (`:3224`).
  - Every cell abuts its neighbour and is separated only by `border-border/70` hairlines.
- Deeper analytics: `DashboardGroup defaultOpen={false}` (`:3238`). Inside it:
  - a `grid gap-3 sm:2 lg:4` of `KpiTile variant="bar"` cards (`:3245`);
  - **nested** `DashboardGroup`s, each wrapping a `<Card>` (`:3337`, `:3357`, `:3371`, `:3436`, `:3497`, `:3509`);
  - grid splits of 1 / 2 / 3 columns.
- Fixed-size instruments do not scale with width:
  - Noise inline graph is `h-[216px]`, and `SIMPLE_INLINE_HEIGHT = 216` (`components/NoiseFunnel.tsx:678`, `:1926`).
  - Snapshot donuts are `height={112}` (`Overview.tsx:717`).
  - HvA chart is `min-h-[122px] xl:min-h-[160px]` (`components/HumanVsAiCard.tsx:314`).
  - Case volume is `height={180}` (`:3361`), and the outcomes donut is `height={150}` (`:3442`).
- `text-2xs` is 11/14 with tracking 0.02em. Its config comment reads "badges/timestamps only"
  (`webui/tailwind.config.js:106`), but in practice it carries legends, captions and stat subtitles.

## 2. Measured crampedness

### Geometry, Deeper analytics collapsed

Height is identical at every viewport: page body 934px, KPI strip 92px, lattice 752px.

| Viewport | Content w | KPI tile w×h | Numeral fill of tile | Flow band | Row-2 cell w | Viewport left empty below "Deeper analytics" |
|---|---|---|---|---|---|---|
| 1280×800 (rail) | 1184 | 196×90 | 19–34% | 764×216 | 395 | 0 (scrolls) |
| 1440×900 (rail) | 1344 | 223×90 | 17–30% | 871×216 | 448 | 0 (scrolls) |
| 1920×1080 (pinned) | 1824 | 303×90 | ~12% | 1191×216 (5.5:1) | 608 | ~40px |
| 2560×1440 (rail) | 2464 | 410×90 | **10%** (37px numeral in 380px tile) | **1618×216 (7.5:1)** | 821 | **~426px (30% of viewport)** |

The page is clamped on two axes at once. Vertically, every block has a fixed pixel height. Horizontally, every block stretches with no cap. The result:

- **At 1280/1440 it looks compressed.** Tile padding is 8/12px, cell padding is 12px, and there are no gutters between cells. Following one vertical line at the flow column's x, there are 10 horizontal rules in 844px: y = 128, 220, 304, 543, 559, 575, 597, 610, 791, 972.
- **At 1920/2560 it looks sparse.**
  - Content floats in the top-left of each over-wide cell.
  - In the snapshot legend, the severity label ("Critical") sits ~470px from its count at 2560 (`li` width 586px). The legend `ul` is `flex-1` (`:745`).
  - The MTTD numeral box is 738px wide for the 4-character string "<1m".
  - The KPI numeral uses 10% of its tile.
  - The flow ribbon becomes a thin 7.5:1 strip.

### Typography (1440, collapsed)

Rendered text-node font sizes: 11px ×51 (+7 SVG axis ticks at 11px), 12px ×61, 13px ×13, 14px ×238, 18px ×3, 24px ×5, 30px ×6. Expanded view: 11px rises to 64–66 nodes.

The 11px text is used for:

- Noise stage shares ("· 68%") and the UPPERCASE "ALERTS INGESTED" / "AFTER CLUSTERING" tags.
- "REVIEW" (uppercase).
- "√ scale" (mono chip).
- HvA band labels and percentages, plus its axis caption.
- Both snapshot legends (labels and percentages).
- TrendChips (+14 / +36).
- The MTTD and Respond subtitles and samples lines (`Overview.tsx:851-852`).
- Queue status badges.
- In Deeper: the "VERDICTS" donut label, verdict percentages, case-volume dates and coverage micro-labels (`:1017`, uppercase tracked).

Contrast is **not** the issue. The minimum for 11px text is 5.81:1 in dark and 5.0:1 in light (AA passes). The problem is size, density and the number of competing numerals: about 12 large numerals compete above the fold (6 KPIs at 30px, 2 donut centres at 30px, MTTD/Respond at 30px, HvA 20px ×3).

### Truncation and ellipsis

- Latest-cases IDs are hard-capped at `max-w-40` (160px vs 271px needed), so they truncate at **every** width, including the 755px-wide row at 2560 (`Overview.tsx:976`).
- Queue titles truncate at ≤1440: 295–348px shown vs 388–512px needed.
- Top signatures truncate at 332px vs 385–534px (Deeper).
- In the KPI modal, case IDs (~110px) and Title/Rule truncate at every width.
- The Detailed-mode stage-rail UPPERCASE labels wrap to two lines at 1440 ("ALERTS / INGESTED", "AUTO-CLEARED / BY AI", "CLOSED BY / HUMAN").

### Unequal heights and dead space

- **Row 2 at 361px.** The snapshot column (361px) sets the height. The timing cell holds two ~80px stat blocks, centred with `justify-center` in two halves (`:3178-3198`, `xl:justify-center`), which leaves a ~110px void between MTTD and Respond. The queue fills 349 of 361px.
- **Deeper analytics:**
  - Case volume card is 226px next to the workload card at 320px (−94px).
  - The Case outcomes card is 196px next to Top signatures/entities at 552px (**−356px** of empty card).
  - Ingest coverage is a full-width 224px card holding four numbers and a full-width progress bar.

### Borders, chrome and grammar split

- 34 bordered elements in the collapsed view, 47 expanded.
- Competing bordered chips:
  - TrendChip pills;
  - every queue status Badge;
  - the "√ scale" chip;
  - the "15 open cases REVIEW" button;
  - the Partial-coverage left-rule callout;
  - the Simple/Detailed segmented control, Full screen button and hide icon;
  - the flat flow panel's own `border-y` inside an already-ruled cell.
- **Grammar split.** The top half is flat and hairline-ruled. Deeper analytics reverts to rounded `Card`s with coloured left accent bars (`KpiTile variant="bar"`), uppercase tracked labels, and collapsible groups nested inside a collapsible group. This violates ui-standard "Prefer transparent sections … over card-inside-card" (`docs/development/ui-standard.md:36-39`).

### Glitches found

1. **Donut centre label overflows.** The Case outcomes centre label "VERDICTS" (57px, 11px, uppercase, tracked) overflows the hole of the 150px donut and collides with the ring; at 1280 light it reads "ERDICTS". See `Overview.tsx:3450` and `diag-ov-1440-dark-verdict-donut-crop.png`.
2. **Inconsistent button label.** The flow's "Full screen" button relabels to "Expand" in Detailed mode.
3. **Three different "open" numbers with near-identical labels.**
   - KPI "Open Cases 23 · any arrival date" (stock).
   - Snapshot "Open cases 15 · Still open from the last 1 day" (cohort).
   - Noise "15 open cases REVIEW".

   All three are honest, but they sit 400px apart with no visual link.
4. **The same figure repeated across widgets.**
   - Auto Closed 36 = HvA "AI agent 36" = flow "Auto-cleared by AI 36".
   - Resolved/Closed 38 = "Cases resolved 38".
   - Total Cases 53 = "Cases opened 53".
   - Respond "—" = Deeper MTTA "—".

   Keep all of them, but present the repeats as cross-references so they are not read as clutter.
5. **Inconsistent window wording.** The caption says "last 1 day" while the KPI context and picker say "24h" (`windowLabel` vs the KPI context).

### KPI drill-down modal

- Size: 1408×828 at 1440, capped at 1920×900 at 2560 (centred, fine).
- **235 text nodes at 11px**: breadcrumb, eyebrow, metric-switcher chips, stat labels, footer.
- The table gets almost no room. Above it, in one scroller, sit:
  1. the header;
  2. the switcher;
  3. the filter row;
  4. the trend chart (~170px);
  5. the partition block (Resolved/Closed);
  6. a sentence;
  7. four bordered stat cards.

  The scroller is 532px tall over 1,594px of content (1440), so only ~6 table rows are visible on open (4 at 1280).
- The footer holds three lines of 12px disclaimers.
- The four stat boxes are bordered cards inside the bordered modal (nested cards).

## 3. Complete data-element inventory (everything a redesign must keep)

### Masthead

- Title "Cyber Defence Center" (`PAGE_TITLE`; the boot-smoke test anchors on it).
- TimeRangePicker (Last 24h …).
- Auto-refresh select (LIVE / intervals).
- Manual refresh button (spins while loading or live; uses the success colour when live).
- Conditional: AutomationNudge (enable / review / dismiss), LoadError + Retry, EmptyState ("Connect a source" + StartDemoButton).

### KPI strip (6 tiles)

**Every tile has:**

- label;
- count-up numeral (neutral ink; red only for a critical count above 0);
- one context line;
- `sub` state disclosure (Loading Nh / Posture unavailable / server reason);
- `bound` mark (≥ lower bound);
- help (?) popover with an "Ask about this" footer;
- ↗ affordance mark (hover/focus);
- opens the drill-down modal (`aria-haspopup=dialog`).

**Per tile:**

1. **Total Cases.** Context "arrivals, last 24h". Hover trend "New cases opened" (case arrivals per bucket), including the preview population sentence and affordance line.
2. **Total Critical.** Context "25% of 53 cases". No trend, by design.
3. **Open Cases.** Context "any arrival date" (window-exempt stock). Bound when partial. No trend.
4. **False Positive Rate.** Context "37 of 53 verdicted". Trend "False positive rate", per case-arrival bucket, unverdicted buckets not measured.
5. **Resolved / Closed.** Context "72% of 53 cases". Trend "Cases now closed". The modal carries the close partition (AI agent / Human / System / Declared benign).
6. **Auto Closed.** Context "95% of worked closes".

### Noise reduction flow (`NoiseFunnel`, variant flat)

- **Header:** title, help (?), Simple/Detailed segmented control, Full screen (Detailed: "Expand"), hide/show toggle (per-browser `tlsoc.overview.noiseFunnelHidden`).
- **Above the graph:**
  - Partial-coverage / warming notice.
  - Unavailable EmptyState + "Retry noise reduction".
  - Flow-integrity / empty notices.
- **Simple-mode stage labels (each with count and share):**
  - Alerts ingested (n alerts · —)
  - After clustering (n clusters · %)
  - Cases opened (n · %)
  - Auto-cleared by AI (n · %)
  - Escalated (n · %)
  - Closed by human (n · %)
  - Not analyst-closed (n · %)
  - optional Closed by analyst policy
  - optional Awaiting review / Candidate side cohort
- **Below the graph:**
  - Stage hover/focus cards.
  - "√ scale" chip + share-rule disclosure (?).
  - "N open cases → REVIEW" action, with a lower-bound mark when partial.
  - Narrow-width stage rail.
  - Refresh sweep animation.
- **Detailed mode:**
  - "Reduced by X%" headline.
  - "N events ingested → N cases closed by a human".
  - Loss badge "−135 · 71% filtered".
  - Six-stage evidence rail (count and % of ingested).
  - Excluded-count spur.
- Full-screen dialog (graph at 400px).

### Human vs AI (`HumanVsAiCard`)

- Title and help (?) with Ask-about-this.
- Totals for AI agent / Human / System: count and share, with a square legend swatch.
- Stacked bar chart per bucket: y ticks, UTC x ticks, bar hover.
- Caption "last 24 hours · 1h buckets · times in UTC".
- Conditional lines: "bounded sample, shares unavailable", "N alerts ingested", stale/unavailable reason, no-series text.

### Case snapshots (×2: Open cases, Cases resolved)

- Title.
- Window caption.
- TrendChip (±N vs previous window, coloured by judgement, with a title tooltip).
- Donut with a count-up centre total.
- Severity legend: Critical / High / Medium / Low / Info, each with count and %.
- Chevron CTA, deep-linking to Cases with `__active__` or `__terminal__` filters.
- Hover trend (New cases opened / Cases now closed).

### MTTD / response

- Title, "p50 · server-computed", "Detail →" (Analytics → posture).
- MTTD: value or —, "Detect · log arrival → case", "p50 · N samples" or a reason, help (title attribute), hover trend "MTTD · daily mean".
- Respond: value or —, "First human action e.g. assignment / ack", samples or reason, help, hover trend "Respond · daily mean".

### Latest cases

- Title, "Real-time triage queue", "View all".
- 5 rows, each with: title, case ID (mono), age, status badge.
- Each row has a CaseHoverCard preview and opens the CaseDetail sheet in place.
- "Queue clear" empty state.

### Deeper analytics (collapsed)

- **Header:** title, description, chevron.
- **Response timing and spend:**
  - MTTA, MTTR, Dwell: value, p50 · N samples or reason, help + ask. MTTA and MTTR have hover trends.
  - LLM spend: value, tokens · calls, unavailable/retry state, click → Analytics Cost, hover trend from `cost_over_time`.
- **Ingest coverage:** reporting / enabled, "N configured", completeness bar, Events/min, Triaged 24h, Silent (warning tone), silent-source alarm → Sources or the all-clear line with oldest last event, "Coverage not yet reported" empty state.
- **Case volume:** TrendArea with date ticks.
- **Case workload state:** count pill; per-status label, count and progress bar; click → Cases with that status.
- **Case outcomes:** count pill; donut with "N verdicts" centre; legend TP / Needs human / FP / Unverdicted with count and %.
- **Top signatures and Top entities:** count pill; up to 8 ranked rows of label, count, bar, "% of cases", relative %, entity type.

### KPI drill-down modal

- **Header:** breadcrumb, "METRIC · DETAILS", completeness badge, population sentence, Export listed, Close.
- **Metric switcher:** 6 chips with live values, plus a caption.
- **Filters:** search, severity, status, source (when available), sort, range (dashboard window / custom).
- Partition block (Resolved/Closed).
- **Trend:** title, caption, window, first / peak / latest, buckets measured.
- "Over the N cases listed" sentence.
- **Stats:** Unassigned, Acknowledged, Median age, Oldest.
- **Table:** Case, Created, Title/Rule, Source, Severity, Status, Owner.
- **Footer:** "Showing N of N · complete page of M", drill-through button, scope disclosure, range caveat.

## 4. Redesign proposal (keeps every element above)

Principles from the Apple skill:

- Hierarchy comes from type size, weight and spacing, not boxes.
- Fewer borders; proximity does the grouping.
- Size-specific tracking (negative on display numerals, ~0 on body).
- Every spacing value deliberate on the 8pt grid.
- Consistent heights.
- Generous gutters on wide screens.
- Simplicity is not minimalism: no data is removed.

### 4.1 Width and macro grid

- **Width.** Change `fluid` to `wide` (`max-w-[1760px] 2xl:max-w-[1920px]`), centred. This is what `PageContainer.tsx:9-11` already prescribes.
- **Ultrawide (≥2200px viewport).** Widen by column count, not by stretching. Switch to a two-column macro layout:
  - main column: KPI strip (full width), flow, case state + timing;
  - right rail, ~460px wide, spanning bands 2–3: Human vs AI over Latest cases (more rows).

  This gets rid of the 7.5:1 flow strip and the 30% empty viewport at 2560×1440.
- **Bands.** Replace the gutterless 12-column lattice with **bands separated by whitespace**:
  - `gap-y-8` (32px) between bands;
  - inside a band, `gap-x-6` (24px) at xl and `gap-x-8` at ≥1920;
  - at most **one** hairline per band (its top rule), and no per-cell `border-r`/`border-b`.

  Target: ≤4 horizontal rules on the page, down from 10 crossing one column.
- **Removing cell borders also removes the need for cell padding (`px-3`).** The width returned keeps the flow above its 608px container-query floor even with gutters.
  - Arithmetic at 1280 with the nav pinned: (982 − 24) × 8/12 = 638px ≥ 608. ✓
  - With the old `px-3` plus a 24px gutter it would be 614px, which is still OK but thin.
  - Do **not** add `p-5` to the flow cell; at 1280 pinned that would be 598px and the graph would disappear.

### 4.2 Type scale (replaces ad-hoc 11/12/14/30)

| Role | Size / line-height | Weight | Tracking | Notes |
|---|---|---|---|---|
| Page title | 28/34 | 600 | −0.02em | currently 24 |
| Band / section title | 15/20 | 600 | −0.01em | sentence case |
| Section caption | 13/18 | 400 muted | 0 | — |
| KPI label | 13/18 | 500 muted | 0 | — |
| KPI numeral | `clamp(2.25rem, 1.5rem + 1vw, 2.75rem)` = 36→44px | 600 | −0.02em, tabular | currently 30 |
| KPI context | 13/18 | 400 muted | 0 | — |
| Instrument numerals (donut centre, MTTD/Respond, HvA totals) | 24–28 | 600 | −0.01em | — |
| Lists and legends | 13–14 | — | — | currently 11 |
| Metadata (IDs, ages) | 12 | — | — | — |
| 11px | — | — | — | **only** chart axis ticks and status badges, as `tailwind.config.js:106` already intends |

Drop UPPERCASE + tracking on the flow tags ("ALERTS INGESTED"), "REVIEW", "VERDICTS", and the coverage and stat labels. Use sentence case.

### 4.3 Bands, top to bottom (sketch at 1440)

```
Cyber Defence Center   [Last 24h] [● LIVE ▾] [↻]                      28/600
                                                                       32
Total cases   Critical   Open now      False-positive   Resolved/closed  Auto-closed   13 muted
53            13         23            70%              38               36            36–44/600
arrivals 24h  25% of 53  any arrival   37 of 53 verd.   72% of 53        95% of worked 13 muted
─────────────────────────────────────────────────────────────────────── (strip keeps its divider grammar; px-5 py-4, ~124px tall)
                                                                       32
Noise reduction flow (?)        Simple|Detailed ⤢ ⊘   │ Human vs AI (?)
 flow graph, height clamp(240px, 18vw, 340px)         │ AI agent 36 95% · Human 2 5% · System 0 0%
 √ scale (?)                 15 open cases → Review   │ chart (flex-1) · last 24h · 1h · UTC
                                                                       40
Case state                       │ Response time     │ Latest cases                View all
 Open 15 ↗+14  Resolved 38 ↗+36  │ Detect   <1m      │ title ……………………………………… Resolved
 (donut) legend (donut) legend   │ p50 · 23 samples  │ case-e2116c82…  · 2m
 (side by side ≥ 560px cell;     │ Respond   —       │ … rows fill the band height
  stacked below)                 │ no ack yet        │   (5 at 1280, 6–8 at ≥1440)
───────────────────────────────── Deeper analytics ▸ ───────────────────
```

**Band 1 — Posture strip.**

- Keep the 6-tile continuous strip and its divider math (ui-standard).
- Change the density: `px-5 py-4`, about 124px tall instead of 92px. The numeral grows with the viewport.
- Help (?) and ↗ stay hover/focus-revealed.
- The context line stays on its own line.

**Band 2 — Flow (8) + Human vs AI (4)**, separated by a 24px gutter (no `border-r`).

- **Flow.**
  - Remove the flat variant's inner `border-y`.
  - Inline height becomes `clamp(240px, 18vw, 340px)`: ~260px at 1440, ~340px at 1920+.
  - `SIMPLE_INLINE_HEIGHT` must follow the measured wrapper height, because the viewBox uses `meet` (`NoiseFunnel.tsx:669-678`).
  - Stage share text goes 11px → 12px. Tags drop uppercase.
  - Make the "Full screen"/"Expand" label consistent.
- **Human vs AI.**
  - Totals at 24px numerals, 13px labels.
  - Chart `flex-1` to match the flow band height.
  - The caption line stays.

**Band 3 — Case state | Response time | Latest cases.** Column split is 5/3/4 at xl. Equal heights come from `items-stretch` plus `h-full flex flex-col` cells.

- **Case state.**
  - Open and Resolved donuts sit side by side when the cell is ≥560px (container query); otherwise they stack.
  - Donut 128px.
  - Legend `max-w-[15rem]`, with count/% columns right next to the label (fixes the ~470px label↔count gap).
  - TrendChip as a borderless tinted text chip.
  - Link the snapshot to the strip with one quiet line ("of 23 open now · 38 resolved", using the existing values), so the three "open" figures read as related, not contradictory.
- **Response time.**
  - The MTTD and Respond pair is top-aligned with 24px between the stats (no `justify-center` void).
  - Rename the visible section title "MTTD / response" to "Response time". Keep the MTTD label on the stat.
  - Keep "Detail →".
- **Latest cases.**
  - Row count fills the band: 5 at 1280, 6 at 1440, 8 at ≥1920. This adds rows and removes none. Update the "do not raise above 5" comment at `Overview.tsx:1499-1508` (`.slice(0, 5)` at `:1517`).
  - Remove `max-w-40` on the ID; let it truncate only against the real space.
  - Title 14px, metadata 12px; badges stay 11px.

**Band 4 — Deeper analytics.**

- Keep it collapsed by default and persist the operator's choice (localStorage, like `NOISE_HIDE_KEY`).
- Optionally default it **open** when the viewport is ≥1200px tall.
- Convert to the flat grammar:
  - **No `<Card>`, no accent bars, no nested collapsibles.**
  - MTTA · MTTR · Dwell · LLM spend become a second continuous strip using the same `KpiTile` strip grammar (`variant="strip"`, compact numeral).
  - Then a 12-column grid with gutters:
    - Ingest coverage (4: hero n/m, bar, three stats in one row) | Case volume (8, chart `flex-1`);
    - Case workload state (4) | Case outcomes (4) | Top signatures (4)…
    - …or Top signatures (6) | Top entities (6) on their own row.
  - Equal heights via `items-stretch`, with charts and lists flexing to fill.
- Fix the "VERDICTS" overflow: put "verdicts" in sentence case at 12px **below** the numeral and size the hole for it, or move the label into the legend header.

**KPI drill-down modal.**

- Lift chrome text from 11px to 12–13px.
- Put the trend chart and the 4 stats on **one row** (chart 60% | 2×2 stats 40%, no card borders). This frees about 120–150px, so the table shows ~10 rows at 1440 instead of 6.
- Keep the footer's "Showing N of N · complete page of M" visible. Put the long scope/range disclosure behind an "About these rows" disclosure; the ui-standard honesty review must confirm partial evidence stays visible.
- Widen the Case column, or show `case_number`.

### 4.4 Chrome reduction (keeps the controls, drops the boxes)

- TrendChip: drop the border and keep the tinted text.
- "√ scale": render as plain muted text with its (?).
- "Review" open-cases action: a text button with a count, no border, still a keyboard stop.
- The Partial-coverage callout keeps its single left rule; it carries meaning.
- Segmented control: unchanged.

The goal is ≤20 bordered elements in the collapsed view (34 today).

## 5. Constraints and risks for the implementer

- **ui-standard must change in the same patch.**
  - §"Operational metric and tuning surfaces" (`ui-standard.md:421-444`) currently **mandates** compact `KpiTile` density on the primary dashboard, and says "no vertical gap and no second hairline" between the strip and the band below.
  - The redesign changes both. Update the standard; do not quietly diverge.
- **Width floors.**
  - The noise-flow 608px container-query floor (`NoiseFunnel` `@[38rem]/noise`, arithmetic in `Overview.tsx:2955-2975`) must be re-verified at 1280 with the nav pinned after adding gutters.
  - The KPI `nth-child` divider math (`:2774-2810`) stays valid only if the tile count (6) is unchanged.
- **Tests.** 35 test files reference the Overview. These assert classes:
  - `overview.render.test.tsx:250-275`
  - `overview.commandcenter.test.tsx:144-217,393`
  - `overview.kpimodal.a11y.test.tsx:487-538`
  - `overview.a11y.test.tsx:243`

  Keep the testids (`kpi-strip`, `hero-row`, `kpi-*`, `human-vs-ai*`, `noise-*`), the section `aria-label`s, and the h2 order.
- **Honesty invariants to keep:**
  - context/bound/sub rules;
  - em-dash for unmeasured values;
  - no trend on Critical or Open Cases;
  - the Respond = ACK-clock note;
  - shares withheld when the window is uncovered.
- **Competitor reference points** (pattern level, from prior knowledge; not re-verified this session):
  - Cortex XSIAM Command Center and Google SecOps dashboards use a large-numeral KPI band, then full-width flow/trend instruments with 16–24px gutters, then equal-height widget rows.
  - Microsoft Defender XDR and CrowdStrike Falcon use card grids with consistent row heights.
  - In every case, scale comes from gutters and type, not from hairline-only lattices.
