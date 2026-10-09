# Chat answer blocks: schema, renderers and exports

Companion to `SPEC.md` (§7). This file is the committed copy of the answer-block contract.
Where the two disagree, the **v2 amendments** below win, then `SPEC.md`, then the catalogue.

## v2 amendments (from the spec review, 2026-10-08)

1. **Block identity and provenance of data.** Every block carries `id` (unique per message),
   `artifact_kind` (the artifact kind it was materialised from, or `null` for model-written
   `markdown`/`callout`/`report`), and `allowed_views` (the views the client may switch between
   without a model call, from SPEC §7.3). Numeric blocks are materialised by the server from
   artifacts produced by tools; the server rejects numeric blocks authored by the model.
2. **Two more chart kinds for infographics.** `chart.kind` adds `funnel` (stage bars with the
   step-down % between stages; a single series; categories are the stages in order) and
   `kpi_group.items[].display` adds `gauge` (a 0-100 index drawn as `RiskGauge`, with bands).
3. **Interactions (replaces "G10 inert").** Allowed: tooltip on hover and focus; legend series
   toggle; chart ↔ table toggle; view switch among `allowed_views` (client-side, no model
   call); `drill` navigation to a validated `InternalRef`; Copy data (TSV, defused); Download
   CSV/JSON; Add to report. Nothing in a block can trigger a mutation. "Ask about this" on a
   data point is deferred (P2).
4. **Global display rule.** G1, G2 and G7 apply to every string in `ChatResponse`, stream events,
   reports and exports, not only block strings. One `displayText()` helper strips C0/C1, bidi and
   zero-width characters, bounds length and never linkifies.
5. **Markdown subset.** `markdown` text is parsed into a fixed AST: paragraphs, emphasis, inline
   code, lists, headings up to H3 (rendered one level below the message heading), blockquote,
   rule, fenced code, GFM tables and links. A link is kept only if its target is a Help Center
   path (`DOC_REF_PATTERN`, amendment 10); in-app navigation never comes from a
   model-written path (it comes from `console_links` ids). Images, raw HTML, autolinks and
   reference links render as literal text; an external URL renders as defanged text with a copy
   button. The Markdown and HTML exporters serialise from the same sanitised AST.
6. **Report envelope.** The model may write one structural `report` block whose leaves are only
   artifact refs, `callout` or `markdown` (SPEC §4.1). The server validates the envelope and
   materialises each leaf.
7. **Storage form.** Blocks are persisted compactly (SPEC §7.5): tables ≤ 25 rows, series ≤ 100
   points (downsampled with a `downsampled_for_storage` flag), step queries ≤ 1 kB. The live turn
   may carry the full limits below.
8. **HTML export without react-dom/server.** The HTML export is produced by a deterministic string
   serialiser sharing the Markdown serialiser's block walker (no `react-dom/server`, which would
   land in the eager `react-vendor` chunk). The file carries
   `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`.
9. **Clipboard and exports are defused.** CSV/TSV cells (string columns only) are formula-escaped;
   numeric columns stay numeric. IOCs are defanged by default in Markdown, HTML, Print and Copy
   data (toggle in the export menu; never applied to the live UI; off for JSON).

### Wave-3 amendments (implementation decisions; SPEC §13 has the full text)

10. **Help Center links (SPEC A1).** `DocRef.doc`, `Citation.doc` and Markdown doc links match
    `^/docs/[0-9]{1,4}\.[0-9]{1,4}/(?:SEG(?:/SEG)*/?)?(?:#[a-z0-9_-]+)?$` with
    `SEG = [a-z0-9_-]+(?:\.[a-z0-9_-]+)*`: the home and dotted release pages are citable; `.`/`..`/
    empty segments, schemes, hosts, queries, uppercase, `%` and `\` never match. Shared vectors:
    `doc_ref_examples` in the contract file; they also run through the citation normaliser
    (`stream-events.ts`), which must use the same grammar before merge (SPEC A1).
11. **Callouts are notes (SPEC A5).** Every tone renders `role="note"` (no chat-local live
    regions, SPEC §10.9); the host announces a new warning once through `useAnnouncer()` when it
    must be spoken.
12. **KPI groups are lists (SPEC A6).** `role="list"` with one `listitem` per `KpiTile` (the tile
    has no `dt`/`dd` mode); units stay spelled out in `sr-only` text.
13. **Honest views (SPEC A15).** `stacked_bar` and `donut` appear in `allowed_views` only when the
    values add up (additive units, or percent/ratio parts that reconcile to the whole per stack
    slot or across the donut's categories; never score or durations; a donut also needs a
    complete, untruncated population on both sides). Server `chart_kind_fits` and client
    `chartKindFits` run the shared `chart_honesty` vectors (incl. a truncated donut); the client
    still draws a dishonest kind as columns/hbar.
14. **`open_in` (SPEC A14).** Every block may carry `open_in?: InternalRef`, the exact console
    view of its data ("Open in Logs"), built by server code from a log call's own input, never by
    the model (dropped from any `ai` block). `InternalRef.opts` gains `logQuery`, `from`, `to`,
    `sourceId` with the router's deep-link grammar (shared `nav_log_examples` vectors); `from`/`to`
    are the absolute UTC instants the call resolved, so a reopened answer opens its own window.
    No `open_in` when the call read a live-tail (`buffer`) source, whose Logs view would ignore
    the filter. The card's ⋯ menu offers "Open in <page>" for `open_in`, or for a single exact
    case; any other filter keeps Copy query only.
15. **Report envelopes are clipped (SPEC A3).** Over-limit sections and leaves are removed and
    counted in the notice line, never a rejection of the whole brief; `subtitle`, a section
    `summary` and `blocks` (alias of `items`) are accepted.
    A blank, whitespace-only or explicit `null` `subtitle` or section `summary` is treated as
    absent, so it can no longer cost the whole envelope or the section.

### Wave-4 amendments (integration decisions; SPEC §13 has the full text)

16. **Stored size is escaped bytes (SPEC A22).** The ≤ 16 kB storage bound of amendment 7 is
    measured on the presentation's stored, string-escaped bytes; a near-bound answer is tightened
    at storage and its `history_truncated` flag says only that something was shortened.
17. **Report snapshots (SPEC A23 (a), (k), (l)).** A block or whole answer is added only when its
    stored presentation still validates; an answer with any expired or unreadable block is
    refused whole. The summary digest keeps every item at reduced fidelity (per-item block caps,
    then skeleton blocks with type, view, title, provenance, total, truncated and expired but no
    figures) before it drops trailing items, and says what it left out (`omitted.items`,
    `omitted.blocks`, `omitted.sections`, `columns_total`).
18. **Add to report on a full report (SPEC §10.6, A25).** The toggles never unmount: an answer or
    block already in the report stays removable, and a new add on a full report is
    `aria-disabled` with the reason "Report is full (40 items)" in its tooltip.
19. **Tool-call headers list only honest views (SPEC A15).** `Artifact.views()` delegates to
    `blocks.artifact_views`, so the header a model reads never offers `stacked_bar`, `sparkline`
    or `donut` where materialisation would fall back to the default view.

### Wave-5 amendments (browser-review decisions; SPEC A34 has the full text)

20. **No empty blocks (SPEC A34).** A data block with nothing to show (a table with no rows, a
    chart or heatmap with no measured value, an empty KPI row, case list, timeline, ATT&CK list,
    citation list or guide) is never materialised by the server (`blocks.is_empty_block`) and
    never rendered by the client (`isEmptyDataBlock`, dropped with reason `empty` and no
    fallback, which narrows G9's "fallback" to blocks that are invalid rather than empty). No
    notice line counts it: the prose says the lookup found nothing. Zero is a value and is kept;
    an all-`null` series is "not measured" and is empty. The client applies the rule to live,
    stored and report content alike and drops a `report` envelope whose every leaf is empty; a
    report item whose block was empty keeps its saved title and reads "The lookup found
    nothing." instead of a card (SPEC A36).
21. **One figure shown once (SPEC A34).** A `kpi_group` from a `kpis` artifact that only restates
    an `entity` card of the same tool call is left out (`blocks.drop_restated_kpis`), so a
    reputation score appears once, in the card's gauge.
22. **Units and labels (SPEC A34).** `KpiItem.delta.value` is in the item's own `unit` (a count
    moves by a count, a `percent` by percentage points, a duration by its unit), never a relative
    percentage, with `period_label` "vs previous window". A zero duration reads in its unit
    ("0 min", "0 h"), and a positive minutes or hours value under one second reads "< 1 min",
    never a millisecond figure the measurement never had. A `guide` link to a `DocRef` carries the section title alone and the renderer adds
    "Read:" once. KPI `context` captions and trusted entity facts use the sans muted caption
    style; mono is for identifiers, code and attacker-derived values.
23. **Neutral identifiers (AGENTS.md naming contract).** Chat and report code mints no new
    compatibility-prefixed identifiers: the print root is `#agentic-soc-report-print` (§7.4) and
    the in-page report sync event is `agentic-soc:report-changed`, like the
    `agentic-soc-workspace-chat-history` BroadcastChannel. Neither is a released wire contract.

---

## 5. The answer-block schema

### 5.1 Envelope and global rules

`ChatResponse` gains an additive field, also mirrored in `types.ts` and
`api-types.gen.ts` via `npm run gen:types`:

```ts
blocks?: AnswerBlock[];          // validated server-side; re-validated client-side
blocks_version?: 1;              // renderer ignores blocks of an unknown MAJOR version
```

The legacy `ChatResponse.table` (`{columns: string[], rows: (string|number|null)[][],
truncated?}`) maps client-side to a `table` block with every column `type: "text"` and
`untrusted: true`, so old saved turns render through the same path.

**Global rules (each one is enforced, not advisory):**

| # | Rule | Enforcement |
|---|---|---|
| G1 | Every string is **plain text**. React text nodes only. No `dangerouslySetInnerHTML` anywhere in `chat/**` | ESLint `no-restricted-syntax` on `JSXAttribute[name.name='dangerouslySetInnerHTML']` scoped to `src/soc/chat/**`, plus an XSS test |
| G2 | No string from a block ever reaches `style`, `href`, `src`, `xlink:href`, an SVG `fill`/`stroke`/`url()`, a DOM `id`, `className` or `token()` | Colour, unit, tone, column type and semantic are **enums**. Links are **typed internal refs**. DOM ids come from `React.useId()` plus the block index, never `block.id` |
| G3 | `null` = not measured: never drawn as 0, never summed as 0, em dash `—` in text | Shared `formatValue()` and geometry helpers |
| G4 | Bounds are explicit: `truncated` plus `total` mean "top N of M". A lower bound renders `≥` (`KpiTile`'s `bound` vocabulary) | Renderer, plus a caption that is required whenever `truncated` is set |
| G5 | Every numeric block declares `provenance: 'code' | 'source' | 'ai'`. `ai` renders the "AI" `ProvenanceTag` plus caption copy "Values stated by the model, not measured" | Server sets it; the client defaults a missing value to `ai` (fail-safe) |
| G6 | One `unit` per chart, so a single y-axis (no dual axis, by construction) | Schema |
| G7 | Untrusted labels (log- or source-derived: hostnames, users, rule names) set `untrusted: true` per block or column. They render in mono or as `InlineCode` and are **never** turned into links. They are **sanitised for display**: strip C0/C1 and bidi override/isolate controls (U+202A–202E, U+2066–2069, U+200E/F), the same class as `UNSAFE_CASE_RESULT_TEXT` in `case-result-route.ts`; clamp length and show the full value in the tooltip and table | `displayText()` helper |
| G8 | Hard size limits (§5.4). Excess is clipped server-side with `truncated: true`. The client clamps again defensively | Pydantic `max_length`, client guards |
| G9 | Unknown `type` or failed validation: render `fallback_text` (plain) plus a quiet `callout` "This part of the answer could not be displayed". Never throw, never blank the message | `parseBlocks()`, which never throws |
| G10 | Blocks are inert data. No block can trigger a mutation. The only actions are navigation (`InternalRef`), copy and download | Schema has no action verbs |

### 5.2 Shared types (TypeScript, proposed `webui/src/soc/chat/blocks/schema.ts`)

```ts
import type { PageId } from '@/soc/nav';
import type { SeverityKey, StatusKey, VerdictKey } from '@/soc/components/palette';

export const ANSWER_BLOCKS_MAJOR = 1;

export type BlockProvenance = 'code' | 'source' | 'ai';
export type SemanticKey = SeverityKey | StatusKey | VerdictKey;       // validated against palette maps
export type ToneKey = 'info' | 'success' | 'warning' | 'critical';    // → ui/alert variants
export type ValueUnit =
  | 'count' | 'percent' /* 0..100 */ | 'ratio' /* 0..1 */ | 'score' /* 0..100 */
  | 'ms' | 'seconds' | 'minutes' | 'hours' | 'usd' | 'tokens' | 'bytes';

/** In-app destination, never a URL. Rendered via router `pageHash()`/`useNavigate()`. */
export interface InternalRef {
  page: PageId;                                  // isPageId()
  opts?: {
    caseId?: string;                             // isSafeCaseId()
    severity?: SeverityKey;
    status?: string;                             // isSafeCaseResultStatus()
    window?: number;                             // 1..720 (hours)
    tab?: string; section?: string; anchor?: string;  // isSafeRouteToken()
    logQuery?: string; from?: string; to?: string; sourceId?: string;  // Logs deep link (amendment 14)
  };
}
/** Same-origin Help Center page, e.g. "/docs/0.1/analyst/chat/#sources". */
export interface DocRef { doc: string }          // DOC_REF_PATTERN (amendment 10)

interface BlockBase {
  id: string;                 // /^[a-z0-9][a-z0-9_.-]{0,47}$/, unique per message (anchors/TOC only)
  type: BlockType;
  title?: string;             // ≤ 120
  caption?: string;           // ≤ 280: scope / window / sample disclosure ("top 10 of 1,240 hosts, last 24h")
  provenance: BlockProvenance;
  untrusted?: boolean;        // labels are log/source-derived (#9)
  truncated?: boolean;
  total?: number | null;      // population when truncated
  as_of?: string;             // ISO-8601 UTC
  from_step?: number;         // the lookup step that produced the data (links into Evidence & execution)
  fallback_text?: string;     // ≤ 2k, plain; shown if the renderer cannot display the block
  open_in?: InternalRef;      // exact console view of the data (amendment 14); never on `ai` blocks
}

export type BlockType =
  | 'markdown' | 'kpi_group' | 'chart' | 'heatmap' | 'table' | 'case_list'
  | 'timeline' | 'entity' | 'mitre' | 'query' | 'callout' | 'citations' | 'guide' | 'report';
```

Naming deliberately matches `backend-chat.md` §(c): `kpi_group`, `chart{kind}`,
`table`, `case_list`, `timeline`, `entity`, `mitre`, `query`, `callout`, `report`.
Additions here are `heatmap`, `citations` (as a block) and `guide` (app help).
**Chart data is columnar** (`x.values[]` plus `series[].values[]`), not the backend
draft's `points[{x,y}]`. Columnar data guarantees aligned x across series and is
roughly half the JSON for multi-series data, which matters under the 64 kB
saved-response cap (§9). If the backend emits points, normalise server-side in
`to_blocks()`.

### 5.3 Block catalogue

#### `markdown` (answer prose)

```ts
{ type: 'markdown'; text: string /* ≤ 12,000 */ }
```

- **Renderer:** build `ChatMarkdown`, extending `Markdown.tsx`. Keep it a React-node
  parser: `###`/`####` headings, `**bold**`, `*italic*`, inline code, lists,
  blockquote, `---`, fenced code (rendered through `CodeBlock`), GFM pipe tables
  (rendered through `TableBlock`, all text columns).
- **Links:** only internal tokens. `[label](app:cases?caseId=…)` or `[label](/docs/0.1/…)`
  are parsed into `InternalRef`/`DocRef` and validated. Anything else, including
  `http(s):`, `javascript:` and `data:`, renders as plain text with the URL visible.
- **Citations:** `[n]` markers become in-message anchor links to the `citations` block
  (`#<msgDomId>-cite-n`).
- **Interactivity:** none beyond links and copy.
- **Tokens:** `text-foreground`; code uses `bg-muted`.
- **A11y:** real heading levels, nested under the message's own heading (h3 and below).

#### `kpi_group` (infographic KPI row)

```ts
interface KpiItem {
  key: string; label: string;                 // label ≤ 60
  value: number | null; unit: ValueUnit;
  bound?: 'lower';                            // renders "≥"
  context?: string;                           // "of 43 cases", ≤ 60
  delta?: { value: number; period_label: string; good_direction: 'up' | 'down' | 'none' };
  semantic?: SemanticKey;                     // accent chip + SEMANTIC_ICON
  trend?: { points: Array<number | null>; window_label: string };  // ≤ 60 points
  ref?: InternalRef;                          // tile becomes a nav button
}
{ type: 'kpi_group'; items: KpiItem[] /* 1–6 */ }
```

- **Renderer:** `KpiTile variant="strip" density="compact"`. Pass the **formatted
  string** as `value` (no `countTo`, so no count-up animation on restore) and pass
  `bound` and `context`. A grid wrapper with parent hairlines handles layout (the strip
  variant expects them). Use container queries (`@container` is already enabled by
  `@tailwindcss/container-queries`): 2 columns under about 28rem (Case Manager embed),
  3 columns at about 40rem, 6 columns at about 60rem.
- **Trend:** a `KpiTrendColumns` SVG, re-using `MetricTrendBody` geometry
  (`SLOT=10, BAR=7, PLOT_H=48`, muted floor tick for `null`). Prefer extracting its
  column renderer over importing `MetricHoverTrend` (that module also brings HoverCard,
  which is acceptable but larger). The trend is decorative (`aria-hidden`); its first,
  peak and latest values are in the tile's `sr-only` text.
- **Interactivity:** a tile with `ref` is a keyboard button that navigates. No hover
  card inside the transcript, because hover cards stacked over the transcript are noisy.
- **Delta colours:** improved shows `success`, regressed shows `critical`, and the
  arrow always shows the true direction (`goodDirection`, as in `KpiTile`).
- **A11y:** a list (`role="list"`, one `listitem` per tile; amendment 12), each value with its
  unit spelled out in `sr-only`.

#### `chart` (bar, hbar, stacked bar, line, area, donut, sparkline)

```ts
type ChartKind = 'bar' | 'hbar' | 'stacked_bar' | 'line' | 'area' | 'donut' | 'sparkline';
interface ChartSeries {
  key: string; label: string;                 // label ≤ 60
  semantic?: SemanticKey;                     // else categoricalCapped(index)
  values: Array<number | null>;               // aligned to x.values
}
{
  type: 'chart'; kind: ChartKind; unit: ValueUnit; y_label?: string;
  x: { kind: 'category' | 'time'; values: string[]; label?: string;
       bucket?: '1m'|'5m'|'15m'|'1h'|'6h'|'1d'|'1w' };   // time: ISO-8601 UTC strings
  series: ChartSeries[];                      // 1..8 (7 + "Other"); donut/sparkline: exactly 1
  reference?: { axis: 'y'; value: number; label: string } | { axis: 'x'; value: string; label: string };
  last_in_progress?: boolean;                 // newest bucket still filling
  drill?: Array<InternalRef | null>;          // per x category
}
```

Renderers (all hand-built SVG, in the one lazy `ChartBlock` chunk):

| kind | Geometry (dataviz + house rules) | Hover / focus | Keyboard | Notes |
|---|---|---|---|---|
| `bar` (columns) | ⅔-slot bars capped at 20–24 px; 2 px top radius, square at baseline; ticks from `niceStep`; solid `--border` hairlines; grouped when ≥ 2 series (gap between group members comes from geometry) | whole x-slot is the hit target; band highlight `muted-foreground/0.1`; portal tooltip lists every series, **value first** (bold, `tabular-nums`), label second, line-key swatch | figure = one tab stop; ←/→ slot, Home/End, Esc | `last_in_progress` draws at 0.6 opacity (house value that clears 3:1) |
| `hbar` | horizontal bars; labels left (truncate with an ellipsis; full label in tooltip and table); value at the bar tip in text tokens | the whole row is the hit target | ↑/↓ row, Home/End | for single-series ≤ 10 rows with no axis needed, render **`BarList`** (lighter, already accessible) |
| `stacked_bar` | `CloseAttributionChart` stack: 1 px inset gap, top-segment radius, 2 px minimum segment, **hatched band for any `null` segment**, shares via `reconcilingShares()` | slot tooltip: total, then one row per segment top-to-bottom (zero rows kept so the structure never jumps) | ←/→ slot, ↑/↓ segment (announced) | legend required (≥ 2 series) |
| `line` / `area` | 2 px lines with round join; end-dot r = 4 with 2 px ring (`token('card')`); `area` fill at about 12% opacity as a flat wash (not the old gradient); **gaps at `null`, never interpolated**; selective end labels for ≤ 4 series | vertical crosshair snapping to nearest x; one tooltip with **all** series at that x | ←/→ x, ↑/↓ series, Home/End | `reference` drawn as a solid muted rule with a plain-text label; time axis uses UTC labels with ≤ 5 regular-interval ticks (`pickXLabels` logic) |
| `donut` | arc paths with ≤ 6 segments; the tail folds into "Other" (`--chart-8`); segment gaps from `padAngle` geometry (no `stroke=card`, which breaks on the transcript's `--background`); centre overlay sized to the hole (`holePx` from `DonutChart`) | per-segment hit target; tooltip shows value + share | ←/→ segment | **always** a legend list beside it with value + `reconcilingShares` %. The legend is the direct label. When values are close or there are more than 6 segments, the server should pick `hbar` instead |
| `sparkline` | `MetricTrendBody` columns (not a smoothed line) | readout of the pointed bucket | none (decorative) | `aria-hidden`; first/peak/latest in text |

**Legend.** Shown only for ≥ 2 series. Each item is a `<button aria-pressed>` with a
hit target of at least 24×24 (WCAG 2.5.8). It toggles that series' visibility, and at
least one series must remain visible. Colours stay bound to the series (no recolour).
The y-scale may rescale; announce "Showing 3 of 4 series". Swatches mirror the mark (a
rect for bars, a line for lines) and carry `SeriesGlyph`/`SEMANTIC_ICON` when the label
is semantic, as in `charts.tsx`.

**Drill-through.** When `drill[i]` is set, clicking a slot or pressing Enter on it
navigates through the router. The tooltip shows "Open in Cases ›".

**Chart or table toggle.** A `SegmentedControl` (28 px) in the block header switches the
visible view to the data table. The `sr-only` table is always present while the chart
view is shown.

**Light/dark.** Every mark uses `token()` strings (live re-resolution). Axis text uses
`style={{ fill: token('muted-foreground') }}` with `text-2xs tabular-nums`. The hatch
uses `token('muted-foreground', 0.3)`. Focus rings use `token('ring')`. **No raw hex**
(the grep gate) and no model colours.

**Accessibility.** The structure is a `<figure>`:

- a visible title in `figcaption` plus the caption;
- the plot `role="group"` with an `aria-label` (title + unit + window) and
  `aria-describedby` instructions;
- polite announcements through the shared `useAnnouncer()` rather than one live region
  per chart, because many charts in a long transcript would mean many live regions;
- an `sr-only <table>` with `<caption>`, a column per series, a row per x, and
  "not measured" for `null`.

Under reduced motion there is nothing to reduce: no draw-in animation, and restored
history must look identical to fresh history. In `forced-colors: active`, marks get a
1 px `CanvasText` stroke and the hatch pattern for stacks.

#### `heatmap` (hour-of-week, entity × time, rule × severity)

```ts
{ type: 'heatmap'; unit: ValueUnit;
  x: { values: string[]; label?: string };      // ≤ 48 columns
  y: { values: string[]; label?: string };      // ≤ 24 rows
  cells: Array<Array<number | null>>;            // y-major
}
```

- **Renderer:** a DOM grid in `MitreHeatmap`'s style. Use the viridis `sequential()`
  ramp with 5 quantised alpha steps (`intensityAlpha`). `null` cells use
  `bg-muted/20` plus a dashed hairline so they read as different from a 0 value.
- **Text:** value labels sit on a `bg-background/85` scrim chip for AA, only when the
  cell is at least 28 px wide; otherwise the value is in the tooltip and table only.
- **Legend:** "Low ▢▢▢▢▢ High", plus max.
- **Interaction:** one tab stop with 2-D arrow navigation and a tooltip per cell.
- **A11y:** `sr-only` table.

#### `table`

```ts
type ColumnType = 'text' | 'number' | 'time' | 'severity' | 'verdict' | 'status' | 'risk'
                | 'case' | 'entity' | 'mitre' | 'code';
interface TableColumn { key: string; label: string; type: ColumnType; unit?: ValueUnit;
                        align?: 'left' | 'right'; untrusted?: boolean }
type Cell = string | number | boolean | null;
{ type: 'table'; columns: TableColumn[] /* ≤ 12 */; rows: Cell[][] /* ≤ 200 */;
  sort?: { key: string; dir: 'asc' | 'desc' } }
```

Rows are positional arrays, aligned with the legacy `ChatTable` shape and smaller as
JSON.

- **Renderer:** reuse **`DataTable`** (the console's one table primitive, with its
  `aria-sort` and announcer contract) through `useClientTable` (local sort plus a
  25/50/100 page size). Use `density="compact"`, no selection, and a hairline surface
  with no wrapping card.
- **Cells by type:**
  - `severity` / `verdict` / `status`: the matching badge with glyph;
  - `risk`: `RiskBadge`;
  - `case`: a router link (`isSafeCaseId`) plus a lazy `CaseHoverCard`;
  - `entity` / `code`: `InlineCode`;
  - `mitre`: technique id validated by `/^T\d{4}(\.\d{3})?$/`;
  - `time`: UTC `formatTimestamp`;
  - `number`: right-aligned `tabular-nums` through `formatValue(unit)`.
- **Visibility:** all-blank columns are hidden (current `ResultTable` behaviour). Show
  50 rows, then "Show all N".
- **Actions:** Copy CSV and Download CSV (§7). "Open wide" opens the existing `Sheet`
  (`max-w-[min(98vw,1400px)]`).

#### `case_list`

```ts
{ type: 'case_list'; items: Array<{ case_id: string; title: string; severity?: SeverityKey;
  verdict?: VerdictKey; status?: StatusKey; risk?: number | null; created_at?: string }> /* ≤ 25 */ }
```

- **Renderer:** compact rows (title link, badges, age). This is the same visual as a
  `table` with fixed columns, so render it as a `TableBlock` preset.
- **Interaction:** the title is a link plus a lazy `CaseHoverCard`.

#### `timeline`

```ts
{ type: 'timeline'; events: Array<{ at: string /* ISO UTC */; label: string; detail?: string;
  kind?: 'alert' | 'detection' | 'case' | 'action' | 'note'; semantic?: SemanticKey;
  ref?: InternalRef }> /* ≤ 50, ascending */ }
```

- **Renderer:** build `TimelineBlock`, an ordered list in `TraceTimeline`'s visual
  dialect:
  - left gutter with UTC time (`tabular-nums`) and day dividers;
  - a node glyph per `kind`, plus `SEMANTIC_ICON` when there is a semantic key;
  - label in plain text, detail muted (`CodeBlock` when `untrusted`);
  - optional `ref` link.
- **Density strip:** above the list for ≥ 10 events, a tiny SVG strip (events per
  bucket) that is decorative.
- **A11y:** `<ol>` with each `<li>` carrying a `<time dateTime>`.

#### `entity` (entity card)

```ts
{ type: 'entity';
  entity: { kind: 'ip' | 'domain' | 'url' | 'hash' | 'host' | 'user' | 'email' | 'process'; value: string };
  risk?: number | null;                                // 0..100
  verdict?: VerdictKey;
  facts?: Array<{ label: string; value: string; untrusted?: boolean }>;   // ≤ 12
  reputation?: Array<{ provider: string; verdict: 'malicious' | 'suspicious' | 'clean' | 'unknown';
                       score?: number | null; detail?: string }>;        // ≤ 12 (enrichment fan-out)
  counts?: KpiItem[];                                  // ≤ 4 (alerts, cases, first/last seen)
  related_cases?: Array<{ case_id: string; title: string; severity?: SeverityKey }>; // ≤ 5
  first_seen?: string; last_seen?: string }
```

- **Renderer:** build an `EntityBlock` card. This is one bounded surface in the
  transcript, so a card is acceptable here.
  - Header: `InlineCode` value with copy, and a kind chip.
  - Right side: `RiskGauge size={96}` (numeric value plus band word).
  - Body: a facts `<dl>`, then reputation rows. Verdict badges map `malicious` to the
    critical glyph, `suspicious` to high, `clean` to the info glyph (not green; this is
    the verdict axis) and `unknown` to muted.
  - Then counts as a compact `kpi_group` and related cases as links.
- **Actions:** "Investigate" navigates to the Investigate page (navigation only).
  Multiple lookups render as multiple entity blocks, laid out in a 2-column grid at
  ≥ 48rem.

#### `mitre`

```ts
{ type: 'mitre'; techniques: Array<{ id: string /* T1234(.001) */; name?: string;
  tactic?: string; count?: number | null }> /* ≤ 60 */ }
```

- **Names:** the server resolves `name` and `tactic` from the bundled
  `threat/mitre_techniques.json`. The model never names a technique, which prevents
  hallucinated names.
- **Renderer:** with `count`, the extracted `MitreHeatmap` (sr-only table included).
  Without counts, a grouped-by-tactic chip list.
- **External link:** a technique link is the only external URL in the whole system. It
  is **constructed** from the validated id
  (`https://attack.mitre.org/techniques/T1059/001/`) with
  `rel="noopener noreferrer" target="_blank"`. It is never passed in from data.

#### `query`

```ts
{ type: 'query'; language: 'kql' | 'lucene' | 'esql' | 'dsl' | 'sql';
  query: string /* ≤ 4k */; source_name?: string; hits?: number | null }
```

- **Renderer:** `CodeBlock` with copy, `wrap` and a caption ("ES|QL · Primary ·
  1,240 hits").
- **Placement:** usually inside the Evidence & execution disclosure. It is a block so a
  report can include it.

#### `callout`

```ts
{ type: 'callout'; tone: ToneKey; text: string /* ≤ 600 */ }
```

- **Renderer:** `ui/alert`. `critical` maps to `destructive`; the others map one to one
  (`info/success/warning`). Every tone renders `role="note"` (amendment 11).
- **Use:** caveats such as "Scan bounded at 5,000 cases: counts are lower bounds" or
  "Insufficient evidence".

#### `citations`

```ts
{ type: 'citations'; items: Array<{ n: number; kind: 'runbook' | 'mitre' | 'case' | 'docs' | 'memory'
  | 'knowledge' | 'log'; label: string; ref?: InternalRef | DocRef; snippet?: string }> /* ≤ 20 */ }
```

- **Renderer:** a numbered `<ol>` with an anchor per item (`#<msgDomId>-cite-n`).
- **Links:** internal refs become router links. `docs` becomes a same-origin Help Center
  link. `log`/`knowledge` snippets render in `CodeBlock` (untrusted, fenced) and never
  link.

#### `guide` (answers about the app itself)

```ts
{ type: 'guide'; steps?: Array<{ text: string }> /* ≤ 10 */;
  links: Array<{ label: string; ref: InternalRef | DocRef }> /* ≤ 6 */ }
```

- **Renderer:** numbered steps, then a row of quiet link buttons, for example
  "Open Settings › Sources" built as `{page:'settings', opts:{section:'sources'}}` and
  "Read: Chat in the Help Center" built as `{doc:'/docs/0.1/analyst/chat/'}`.
- **Safety:** `NavOpts` already supports `section`/`anchor`, so deep links into
  Settings cards work with no router change. Every ref is validated (`isPageId`,
  `isSafeRouteToken`).

#### `report` (a document made of sections and blocks)

```ts
{ type: 'report'; title: string; subtitle?: string;
  scope: { window_label?: string; sources?: string[]; generated_at: string };
  sections: Array<{ id: string; heading: string; summary?: string;
                    blocks: Exclude<AnswerBlock, ReportBlock>[] }> /* ≤ 12 sections, ≤ 40 blocks */ }
```

- **Renderer:** `ReportBlock`, lazy.
  - Header: title, scope line, `generated_at` (UTC), and provenance summary chips
    ("12 measured · 1 AI-stated").
  - A collapsible table of contents with in-message anchors.
  - Sections rendered with the same block renderers (no nested report).
  - An **Export** menu: Markdown, HTML, Print / Save as PDF, CSV (all tables, one file
    per table), JSON.
  - "Open as document" opens a wide `Sheet` with a readable measure for long reports.

### 5.4 Limits

These are the server clip limits; the client clamps the same values again.

| Item | Limit | Why |
|---|---|---|
| blocks per message | 12 (report counts as 1; ≤ 40 inside) | readability; 64 kB saved-response cap |
| serialized `blocks` per message | ≤ 40 kB target, 48 kB hard | `MAX_RESPONSE_BYTES = 64_000` in `stores/chat_conversations.py` |
| chart series | ≤ 8 (7 + Other) | `CATEGORICAL_CAP`, CVD |
| chart points per series | ≤ 200 (downsample server-side by bucket) | geometry and payload |
| donut segments | ≤ 6 | dataviz part-to-whole rule |
| table | ≤ 12 cols × ≤ 200 rows; cell ≤ 500 chars | DOM and payload |
| heatmap | ≤ 48 × 24 | legibility |
| strings | title 120, label 60, caption 280, callout 600, markdown 12k | layout |

### 5.5 Validation on both sides

- **Backend:** Pydantic v2 models with `extra="forbid"`, `Literal` discriminators,
  `max_length` and regex `pattern`s. One function `validate_blocks(raw) -> (blocks,
  dropped)` runs before persistence. For persisted history, type `blocks` leniently
  (`list[dict]` re-validated on read) so an older shape never makes
  `_replayed_chat_response` fail.
- **Contract file** `webui/src/soc/chat/blocks/answer-blocks.contract.json` lists the
  block types, chart kinds, units, column types and tones. Mirror the existing
  `widget-types.contract.json` pattern: two contract tests, a webui one and a backend
  one, so the enums cannot drift.
- **Client:** a hand-written `parseBlocks(raw: unknown): { blocks; dropped }` in
  `schema.ts`. There is no zod dependency (no new dependencies). It never throws, clamps
  lengths, applies `displayText()`, coerces non-finite numbers to `null`, and replaces
  invalid blocks with a fallback callout. Unit-test it with adversarial fixtures.

---

## 6. Shared chart machinery (one implementation for every kind)

Proposed in `src/soc/chat/blocks/charts/`:

- **`geometry.ts`** (pure, unit-testable): `niceStep` and `ticks` (from
  `CloseAttributionChart`), `pickXLabels` (UTC regular intervals, ≤ 5),
  `stackSegments` (inset gap, 2 px minimum, top flag), `roundedTopPath`,
  `reconcilingShares` (import from `CloseAttributionChart`, or move it to
  `lib/shares.ts`), `donutArcs(values, padAngle)`, and `bucketWhen`/`bucketRangeLabel`
  for UTC labels.
- **`useChartSize(ref, fallback)`:** ResizeObserver plus jsdom fallback, applied
  silently. In print or static mode it returns a fixed width (680 px logical, about the
  A4 content width) and a deterministic height.
- **`useChartNavigator({ slots, series, onActivate })`:** generalised from
  `CloseAttributionChart` lines 553–713.
  - State: `active`, `open`, `focusRing`, `dismissedFor`.
  - Pointer: `slotAt(clientX|clientY)`, plus the pointer-down/focus distinction.
  - Keys: ←/→/↑/↓/Home/End/Esc/Enter, with a 160 ms hide delay.
  - Dismissal: global Esc and outside-press.
  - Announcing: through `useAnnouncer()`, with a `summarize(slot, series)` callback per
    chart kind.
- **`ChartTooltipPortal`:** `createPortal` to `document.body`, `fixed z-50 w-64
  rounded-md border bg-popover text-popover-foreground shadow-elev2 text-xs`. It is
  anchored beside the active slot (preferring the side away from the plot centre) and
  clamped 8 px inside the viewport. It is itself hoverable (1.4.13) and `aria-hidden`
  (the live region carries the text). Rows read: line-key swatch, **value**
  (semibold, tabular), label.
- **`BlockFigure`:** the shared header and frame for every visual block. A flat
  hairline section, not a nested card. Contents:
  - `title`, `ProvenanceTag variant="icon"`, the Chart/Table `SegmentedControl`;
  - an overflow menu (`DropdownMenu`): Copy CSV, Download CSV, Copy as Markdown, Open
    wide;
  - the caption, and truncation and bound disclosures.
- **`DataTableFallback`:** the `sr-only` table (also used for the visible Table view,
  minus `sr-only`).
- **`formatValue(v, unit)`:** one formatter used everywhere:
  - `count` → `fmtNumber`;
  - `percent` (0–100) and `ratio` (0–1) explicitly, with `<1%` handling;
  - durations → humanised ms/s/min/h;
  - `usd` → `fmtMoney`, `tokens` → `fmtTokens`, `bytes` → KB/MB/GB, `score` → `n/100`;
  - `null` → `—`.

  Do **not** use `lib/format.ts` `fmtPercent`. It treats any value ≤ 1 as a fraction, so
  a genuine "1%" renders as "100%". The explicit `percent`/`ratio` units remove that
  ambiguity.

**Performance in long transcripts:**

- Every block wrapper gets `content-visibility: auto; contain-intrinsic-size: auto
  320px`. Off-screen charts skip layout and paint but stay in the accessibility tree.
- One ResizeObserver per chart is fine at these sizes.
- No animation, so restoring 30 charts costs one render each.

---

## 7. Reports and export (no new dependencies)

### 7.1 Where export code lives

`chat/blocks/report/export/*` is loaded by `await import()` inside the click handler,
so none of it is in any chunk until it is used.

- **Shared helpers, consolidating four copies of the same pattern:**
  - `lib/download.ts` `downloadText(filename, mime, text)`, feature-detecting
    `URL.createObjectURL` exactly as `KpiDrilldownPanel.exportCsv` does (jsdom-safe,
    revokes the URL immediately). Copies exist in `KpiDrilldownPanel.tsx:1008`,
    `MfaSetupCard.tsx:243`, `jobs/jobs.ts:296` and `CaseDetail.tsx:1217`.
  - `lib/csv.ts`: move `csvField()` (formula-injection defusal: a leading
    `= + - @ \t \r` gets a `'` prefix, then RFC-4180 quoting) out of
    `KpiDrilldownPanel.tsx:495`, with no behaviour change.
- **Filenames:** `agentic-soc-report-<slug(title)>-<yyyymmdd-hhmm>Z.<ext>`. The slug
  rule is the same as `KpiDrilldownPanel.slug`.

### 7.2 Markdown (`toMarkdown(report | blocks)`)

The serialiser is deterministic and pure (unit-tested).

**Document layout:**

- `# Title`, then a metadata line (`Generated 2026-10-07 14:05 UTC · Window: last 24h ·
  Sources: Primary`).
- Each section is `## Heading`.

**Blocks:**

| Block | Markdown output |
|---|---|
| `markdown` | text as written, with HTML-significant characters escaped (`<`, `>`, `&`) so a viewer that renders inline HTML cannot be injected |
| `kpi_group` | a 2–3 column table: Metric, Value, Context |
| `chart` / `heatmap` | title, caption, a **data table** (x × series, `—` for null) and a note `_Chart: stacked bar, unit: count._` (Markdown viewers have no reliable charting) |
| `table` / `case_list` | GFM table; cells escape `|`, newlines become spaces, length is clamped; `untrusted` cells are wrapped in backtick code spans with a fence-safe backtick count |
| `timeline` | `- 14:05 UTC — label` |
| `entity` | a facts list |
| `mitre` | list grouped by tactic, with constructed ATT&CK links |
| `citations` | numbered references |

**Untrusted text** never becomes Markdown link syntax. `[`, `]`, `(`, `)` and `!` are
backslash-escaped outside code spans.

**Delivery:** "Copy as Markdown" uses `copyText()`; "Download .md" uses
`downloadText()`.

### 7.3 HTML (a static, scriptless, self-contained file)

- **Rendering:** call `renderToStaticMarkup(<ReportDocument report={r} mode="static" />)`
  from `react-dom/server`, which is part of the existing `react-dom` dependency. Import
  it dynamically in the export chunk so its roughly 25–40 kB never reaches page chunks.
  React escapes every text node, so the output cannot carry injected markup. Charts in
  `mode="static"` use fixed geometry and render direct labels plus visible data tables
  (no tooltips without script). Use `<details>` for "Show data", which works with no
  JavaScript.
- **Template:**
  ```html
  <!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>…escaped title…</title><style>/* report tokens + report CSS */</style></head>
  <body class="report">…static markup…</body></html>
  ```
  The CSP is defence in depth: even if something slipped through, the file can run no
  script and make no network request (no beacons through CSS `url()`).
- **Tokens:**
  - Charts reference `hsl(var(--chart-1))` and similar, so the file must define those
    variables.
  - A generated constant `report-tokens.ts` holds the ~35 light-theme values the report
    uses: `--background/--foreground/--card/--muted/--muted-foreground/--border/
    --primary`, the semantic set, and `--chart-1..8`.
  - A unit test asserts those values equal `:root` in `theme.css`, reusing
    `scripts/lib/theme-css.mjs`'s parser in the gate style.
  - Optionally include the `.dark` set under `@media (prefers-color-scheme: dark)` for
    on-screen viewing of the exported file.
- **Stylesheet:** a small dedicated sheet (`report.css`, imported `?raw` from the lazy
  export module), using plain classes rather than Tailwind (the full `index-*.css` is
  170 kB). Rules cover: type scale, table hairlines, figure spacing, badge chips,
  `break-inside: avoid`. Keep it at 4–6 kB.

### 7.4 Print / Save as PDF (the PDF path)

1. **Click "Print / Save as PDF".** The lazy `ReportPrintView` mounts a portal at
   `<div id="agentic-soc-report-print">` directly under `<body>`, rendering the report with
   `mode="print"`:
   - fixed 680 px chart width, from `usePrintMode()`;
   - all disclosures expanded;
   - data tables visible under each chart;
   - a footer with "Generated by Agentic SOC · <UTC timestamp> · provenance legend".
2. **Light theme without touching `.dark`.** The print root carries the light-token map
   as **inline custom properties** (`style={{'--background': '0 0% 100%', …}}`). Every
   descendant's `hsl(var(--x))`, including Tailwind utilities and SVG attributes,
   resolves from that nearest scope. Paper stays readable when the operator is in dark
   mode, and the theme provider is not involved. Browsers drop background colours by
   default, so dark-mode printing would otherwise give light text on white.
3. **CSS**, from the lazy report stylesheet:
   ```css
   @media screen { #agentic-soc-report-print { display: none; } }
   @media print {
     @page { size: A4; margin: 14mm 12mm; }
     body > *:not(#agentic-soc-report-print) { display: none !important; }
     #agentic-soc-report-print { display: block; }
     .report-block, figure, table, .report-kpis { break-inside: avoid; }
     .report-section > h2 { break-after: avoid; }
     #agentic-soc-report-print * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
   }
   ```
4. **Then:** wait two `requestAnimationFrame`s (layout settles), call `window.print()`,
   and unmount on `afterprint`, with a 60 s timeout fallback. In jsdom,
   `window.print` is a no-op stub; tests assert the portal content and the CSS hooks.

Pure SVG prints as vectors, so the PDF stays crisp. Using the portal (rather than
hiding shell elements with new `data-*` attributes in `AppShell`) adds **zero bytes to
the entry chunk**.

### 7.5 CSV and JSON

- **CSV:** per table, chart or heatmap. Header is the column labels, rows are the data,
  `null` becomes an empty field, and every field passes through `csvField()`. A report
  exports one CSV per table-like block. Because there are no ZIP dependencies, this is
  either sequential downloads (browsers may prompt) or one concatenated CSV with
  `# section` separator lines. **Recommendation:** per-block CSV from each block's
  menu, plus Markdown or HTML for the whole report.
- **JSON:** `{ blocks_version, report }` exactly as received, for re-use and sharing.

---

