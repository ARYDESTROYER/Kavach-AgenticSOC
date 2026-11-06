# Round 14 research: whole-console UI audit, group A pages (ask 8, part 2a)

Author: research sub-agent `ui-audit-a`. Date: 2026-10-25. Branch `claude/round12` (fresh from Testing after Round 13).
Scope: the pages operators use for triage and reporting, audited against the Overview ("Cyber Defence Center"), which the operator calls "professional and neat" and wants the rest of the console to follow.
Out of scope here: the left navigation rail and its animation (separate brief), Settings, Sources, Intelligence pages (group B), and the content changes the other Round 14 asks make to Overview, Dashboards, Audit log and chat blocks.

## 1. The ten things that matter most

1. **The console speaks three visual dialects.** Overview uses the Round 13 grouped panels (`.surface-panel`: tinted fill, no border, no shadow, 14 px corner). Every other page in this group uses white bordered cards (`Card`, 8 px corner, and `KpiTile`'s own card chrome, 10 px corner), and Analytics > Effectiveness uses a third, flat divider-led dialect. Measured live: Overview has 7 panels and 0 bordered cards; every other page has 0 panels and up to 20 bordered cards, with 8 px and 10 px corners mixed on the same page. One `Panel` primitive (and moving `ChartCard` and the standalone `KpiTile` onto it) converges most of the console in a handful of files.
2. **Nested cards are common** although `docs/development/ui-standard.md` forbids them: measured 9 on Standup, 8 on Analytics > Performance, 5 on Analytics > Operational, 3 on Dashboards. They come from metric tiles (`KpiTile variant="bar"` and P50/P90 boxes) placed inside chart cards.
3. **Page headers do not match the Overview.** Overview: plain title, its time range and refresh in the `meta` slot beside the title, freshness on the right, no icon, no overline, no description. Others: an icon chip, a two-line description, and one of nine different overlines ("TRIAGE", "WORKSPACE", "SHIFT HANDOFF", "Automation > Approvals", ...) that repeat the top bar's breadcrumb and sometimes contradict the rail (Approvals says "Automation" but lives under Triage; Jobs says "Operations" but lives under Analytics). Header heights at 1440 px range from 46 px to 236 px (Standup's "hero" card).
4. **Tracked uppercase micro-labels everywhere except Overview**: table headers (11 px semibold uppercase in the shared `TableHead`), every non-hero `KpiTile` label, Analytics section titles, Approvals, Dashboards widgets. Overview moved to 13 px sentence-case labels and 15 px sentence-case band titles in Round 12 for exactly this reason. One change in each shared primitive fixes most of it.
5. **Six different KPI tile styles** in this group alone (Overview hero strip; Cases summary strip; Analytics strip with coloured icons and green/red numerals; bordered tiles with icon chips; rainbow left-accent tiles on Posture; Standup's bordered uppercase tiles). Converge on one `KpiStrip` on a panel, ink numerals, red only for a non-zero critical count (the Overview rule, already coded in `KpiTile` for `numeral="hero"`).
6. **Two real defects found on the way**: the case detail sheet's close button is painted over by the sticky case header (pointer users cannot see or click it; Escape still works), and dashboard widgets clip their content mid-row (Connector health table and the Response timing tiles are cut off in view and edit mode).
7. **Wide tables clip silently**: Cases (Outcome and Risk columns cut at 1440 px and even at 1920 px), the Cost ledger (Avg / call cut), the MITRE heatmap on Posture (last tactic cut). No edge fade, no sticky first column.
8. **Row density is inconsistent and low where it matters**: body rows measure 41 px (Cost) to 62 px (Cases); Logs, the densest data, has 57 to 61 px rows because the timestamp wraps onto two lines and rule names break mid-word. Carbon recommends one row size per table from 24/32/40/48/64 px and says 64 px rows are only for two-line content ([Carbon data table style](https://carbondesignsystem.com/components/data-table/style/)).
9. **Raw values leak into the UI**: SLA overage as "+18613m", oldest open case as "165h", breach as "+8124%", campaign names as 40-character hashes, Approvals citing an internal case id and "(verdict=NEEDS_HUMAN, risk=62.0)", Case activity rows printing "rule=... action=... proposal=prop-..." key=value text.
10. **Phones**: Cases at 390 px puts about 950 px of header, seven summary tiles and seven stacked filters before the first case, then shows a nine-column table where only the case id and a truncated title are visible. Case Manager already has a good phone list; Cases should reuse it.

## 2. Method and artefacts

- Live shared demo `http://127.0.0.1:5901` (Demo Mode, synthetic data), Chromium via playwright-core. Every page at 1440x900 light and 1920x1080 dark (viewport plus full-page), and Overview, Cases, Case Manager and Chat at 390x844 (light and dark).
- Screenshots: `<scratch>/r14/shots/research/ui-a/NN-<page>-<view>.png` (128 files). Numbering: 01 Overview, 02-04 Dashboards (view, list, builder), 05 Cases, 06-11 Case Manager (queue + Overview tab, then Timeline, Investigation, Threat context, Collaboration, Chat), 12 case detail sheet, 13 Campaigns, 14/14b/15 Chat, 16 Reports, 17 Standup, 18-22 Analytics (Operational, Performance, Posture, Effectiveness, Cost), 23 Inbox, 24 Jobs, 25 Logs, 26 Entity investigation, 27 Approvals.
- Objective DOM measurements per page (header size and height, panel and bordered-card counts, corner radii, nested cards, resting shadows, heading ladder, uppercase labels, table header and row metrics, tab metrics, button heights, icon sizes, overflow): `<scratch>/r14/notes/uia/audit-1440-light.json`, `audit-1920-dark.json`, `audit-390-light.json`, `audit-390-dark.json`. Scripts: `.../notes/uia/shoot.mjs`, `audit-fn.mjs`, `probe2.mjs`, `preview.mjs`.
- **Convergence previews** (rough, in-browser only, no repository edit): the same live pages restyled by a script that applies the Overview grammar (panels instead of bordered cards, nested cards flattened, sentence-case labels, no header icon chip or overline, ink numerals): `P-analytics-operational-converged-1440-light.png`, `P-analytics-operational-converged-1920-dark.png`, `P-analytics-performance-converged-1440-light.png`, `P-standup-converged-1440-light.png`, `P-cases-converged-1440-light.png`, `P-approvals-converged-1440-light.png` in the same folder. They show the direction, not a finished design (for example the Performance P50/P90 boxes are still nested there).
- Side effect, reverted: toggling dark mode in the browser writes the Admin user's theme preference to the server; the last run set it back to light.

## 3. The reference: what "the Overview standard" is, concretely

Read from `webui/src/soc/pages/Overview.tsx`, `webui/src/styles/theme.css`, `docs/development/ui-standard.md` and measured live (01-overview-*.png).

| Element | Overview rule | Where it is defined |
|---|---|---|
| Page container | `PageContainer variant="wide"`; modules grouped with `space-y-10` (40 px) | Overview.tsx:3621, 3696 |
| Page header | `PageHeader` default dense, **no icon, no overline, no description**; time range, live toggle and refresh in `meta` beside the title; page freshness ("Updated just now") in `actions` on the right; sticky from `sm`, clear at rest, material when content scrolls under | Overview.tsx:3637-3664 |
| Title | 24/30 semibold (30/36 from 1536 px via `2xl:[&_h1]:text-4xl`) | Overview.tsx:3644, tailwind.config.js:133-134 |
| Surfaces | Every module on `.surface-panel`: `--panel` fill, radius `--radius + min(--radius,4px)` (14 px), no border, no shadow; neutral tokens remapped inside the panel so hover, tracks and badges stay visible | theme.css:1762-1786; Overview.tsx:1516-1518 (`PANEL`, `PANEL_PAD = p-4 xl:p-5 3xl:p-6`, `PANEL_GAP`) |
| Module title | Inside the panel: 14 px semibold (`text-base`), optional count and 13 px muted caption on the same baseline row; no icon chip, no header rule | Overview.tsx:1642-1680 (`Instrument`) |
| Band title | Outside the panels, on the canvas: 15 px semibold sentence case (`text-md`), 13 px caption, right-aligned aside | Overview.tsx:1576-1612 (`Band`) |
| KPI strip | One continuous strip on one panel; `KpiTile variant="strip" density="comfortable" size="fluid" numeral="hero"`; 13 px sentence-case label, ink numeral, one muted context line; inset column rules | Overview.tsx:3705-3790; KpiTile.tsx:977-987, 1051-1056 |
| Colour | Neutral ink; colour only for severity/state; a critical count is red only when non-zero | KpiTile.tsx:1051-1056 |
| Lists | Divider-led rows inside a panel, no inner cards; "View all" link in the module title row | Overview.tsx:1079-1230 (`TopCasesPanel`) |
| Empty state | `EmptyState compact` inside the panel ("Queue clear") | Overview.tsx:1229 |
| Measured | h1 24 px/650; header 48 px tall; 0 bordered cards; 0 resting shadows; 0 nested cards; icons 12-16 px | audit-1440-light.json |

Industry practice agrees with this grammar: a page header carries the title, optional breadcrumb, and actions on the right ([Atlassian AUI page header](https://aui.atlassian.com/aui/7.3/docs/page-header.html)); header labels use sentence case and should not be crammed with actions ([Sainsbury's design system, header](https://design-systems.sainsburys.co.uk/components/header/)); dashboards group related content in titled sections of plain cards ([PatternFly dashboard guidelines](https://www.patternfly.org/patterns/dashboard/design-guidelines), [PatternFly card guidelines](https://www.patternfly.org/components/card/design-guidelines), [Carbon dashboards](https://carbondesignsystem.com/data-visualization/dashboards)); Round 12's dashboard research reached the same conclusions (docs/research/2026-10-round12/research/dashboard-ux.md:12, 249, 307-309).

## 4. Cross-cutting findings (ranked)

Each finding: what is wrong, evidence, where it comes from, the exact change. "High" means broken, hidden, clipped or misleading, or the dialect clash the operator sees first; "Medium" means a visible inconsistency on a main page; "Low" means polish.

### X1. Bordered cards instead of grouped panels (High)
- Evidence: 0 panels on every page except Overview; bordered cards per page at 1440 px: Analytics Operational 20, Performance 19, Posture 16, Standup 16, Cost 15, Dashboards 7, Jobs 4, Approvals 3. Corner radii mixed 8 px and 10 px on the same page (audit-1440-light.json `cardRadii`).
- Sources: `webui/src/ui/card.tsx:49-50` (`rounded-md` + `border border-border/80 bg-card`); `webui/src/soc/components/ChartCard.tsx:56-61` (a `Card` with a ruled header and a bordered icon chip); `webui/src/soc/components/KpiTile.tsx:1164` (`rounded-lg border border-border bg-card` for every non-strip tile).
- Change: add `Panel` (see section 6). Switch `ChartCard` to `Panel` with the `Instrument` title row (no `CardHeader` rule at ChartCard.tsx:57, no icon chip at ChartCard.tsx:59-61). Give `KpiTile` default variant no chrome of its own; standalone tiles render inside a `KpiStrip` on a panel. Keep `Card` only for a selectable record, a contained editor or dialog content, as ui-standard already says.

### X2. Nested cards (High)
- Evidence (measured `nestedCards`): Standup 9, Analytics Performance 8, Operational 5, Dashboards 3, Cost 1. Visible in 17-standup (SLA tiles inside "SLA pressure"), 19-analytics-performance (P50/P90/Mean/Max boxes inside each card), 18-analytics-operational ("Analyst feedback quality" and "LLM spend" tiles with coloured left bars), 02-dashboards-view (MTTA/MTTR/Dwell tiles inside the "Response timing" widget).
- Sources: `KpiTile variant="bar"` (KpiTile.tsx:1182-1187; used by `StatCard.tsx:36`, `soc/dashboard/widgets/lifecycle.tsx:54`, `soc/chat/report/ReportPanel.tsx:1123, 1131`), and the Performance percentile boxes in `Metrics.tsx` (section starting near Metrics.tsx:1073).
- Change: inside a panel, figures are a compact strip (`KpiTileGrid` + `KpiTile variant="strip" density="compact"`, hairline dividers) or a `dl` of label/value rows. Retire `variant="bar"` (the coloured left bar carries no meaning the label does not).

### X3. Page header dialect (High)
- Evidence: icon chip on every page header except Overview (and Case Manager/Chat, which have none); description on 15 of 19; overline text on 12 of 19 with nine different values; header heights 46, 52, 68, 70, 86 and 236 px. The top bar already shows "Agentic SOC / <Page>".
- Sources: `webui/src/soc/components/PageHeader.tsx:193` (deprecated `eyebrow`, uppercase tracked), 231-240 (icon chip), 255-263 (description, `line-clamp-2`), 247 (`tracking-tight` on top of the size step, which ui-standard "Typography" says not to do). Call sites: Cases.tsx:1516-1520 (breadcrumb "Triage > Cases" + chip + total pill), Campaigns.tsx:470-472 (eyebrow "Triage"), Reports.tsx:42 and 55 (eyebrow "Workspace"), Standup.tsx:319-325 (`variant="hero"`, eyebrow "Shift handoff"), Analytics.tsx:39-43, Inbox.tsx:659-661, BatchJobs.tsx:416-418 (eyebrow "Operations"), UnifiedLogs.tsx:222-224 (eyebrow "Triage"), Workspace.tsx:57-61 (eyebrow "Agent workspace" for Entity investigation), Approvals.tsx:814-817 (breadcrumb "Automation > Approvals"), Dashboards.tsx:144-147.
- Change: make the Overview header the default. In `PageHeader`: drop the icon chip unless `icon` is passed with an explicit `showIcon` (and pass it nowhere on routed pages); remove `eyebrow` and `breadcrumb` from routed pages (the top bar owns the trail); description becomes optional, one line, 13 px, and pages that need more explanation use a `HelpTip` beside the title; drop `tracking-tight` at line 247 (the size step carries its tracking); deprecate `variant="hero"`. Put the page's time range and refresh in `meta` (beside the title, like Overview) and the primary action or freshness in `actions`.

### X4. Tracked uppercase micro-labels (Medium)
- Evidence: uppercase labels on 14 of 19 pages (none on Overview). Table headers 11 px/600 uppercase on every table (Cases, Campaigns, Reports, Jobs, Logs, Cost, Dashboards).
- Sources: `webui/src/ui/table.tsx:129` and `webui/src/soc/components/DataTable.tsx:437` (th: `text-[11px] font-semibold uppercase tracking-wide`); KpiTile.tsx:983-986 (non-hero label: `font-semibold uppercase tracking-wide`); Metrics.tsx:1045, 1073, 1085, 1280, 1365, 1445 (section h2 `text-xs font-semibold uppercase tracking-wider`); Metrics.tsx:851, 1169; Cases.tsx:697 (SummaryTile label); Approvals.tsx (10 occurrences); `soc/dashboard/widgets/*` eyebrows ("SPEND IN THIS WINDOW").
- Change: th becomes `text-xs font-medium text-muted-foreground` sentence case (12 px; Carbon's column header is 14 px semibold with no case rule, see [Carbon data table style](https://carbondesignsystem.com/components/data-table/style/)); every KPI label takes the hero label style (KpiTile.tsx:979-982: `text-sm`/`text-xs font-medium text-muted-foreground`); section titles use `Band`/`SubBandTitle` (15/14 px semibold sentence case). The KpiTile comment at KpiTile.tsx:977-978 already states why: "tracked capitals at 11px read as decoration and outweighed the data they named".

### X5. KPI tile styles (Medium)
- Evidence: six styles, see screenshots 01, 05, 17, 18, 19, 20, 22, 24.
- Sources: Cases.tsx:656-720 (`SummaryTile`) and Cases.tsx:1584-1608 (strip on the canvas with `border-y`); Metrics.tsx:565-650 (Operational strip, icons, `accent` per tile); KpiTile.tsx:1057-1059 (a non-hero strip numeral turns green or red whenever `accent` is `success` or `critical`, so "Closed 78" and "Agreement 100%" are green and "Avg risk 29" is red); Posture tiles with coloured left bars (`variant="bar"`); Cost tiles with four colours of icon chip (Cost.tsx around 760-800); Standup tiles (Standup.tsx, KPI row under the hero); Jobs Batch strip (BatchJobs.tsx around 520-570) with a green zero.
- Change: one `KpiStrip` (panel + `KpiTileGrid` + strip tiles, `comfortable` at the top of a page, `compact` inside a module); no icons on tiles; apply the hero colour rule (ink, red only for a non-zero critical count) to all strip tiles by changing KpiTile.tsx:1057-1059 to the hero branch.

### X6. Two tab grammars (Medium)
- Evidence: boxed segmented tabs with icons (Analytics, Campaigns: list radius 8 px, 13 px labels) versus underline tabs (case detail: no box, 12 px labels).
- Sources: `webui/src/ui/tabs.tsx:14` (TabsList is a bordered segmented rail) and 29-32; Metrics.tsx:922-943 (icons in triggers); Campaigns.tsx:482-494; CaseDetail.tsx:1828-1850 (`tabTrigger`).
- Change: add `variant="underline"` to `ui/tabs` and use it for page and record sections (Analytics, Campaigns, case detail); keep the boxed rail as `SegmentedControl` for in-module view switches (Overview's "Simple / Detailed"). No icons in tab triggers. One label size (13 px).

### X7. Refresh controls (Medium)
- Evidence: Overview: icon refresh in the header `meta`; Analytics: labelled "Refresh" in the tab row; Cost: a separate icon-only refresh; Effectiveness: three Refresh buttons on one tab (page, Agent health, outcome evidence); Cases, Campaigns, Inbox, Approvals: Refresh in a ControlBar band below the header.
- Sources: hand-rolled spinners against the ui-standard "Motion and loading" rule (use the shared `RefreshButton`): Cost.tsx:701-704, AgentEffectiveness.tsx:491-492, `soc/components/HealthDiagnostics.tsx:321-324`.
- Change: one `RefreshButton` per page, in the header `meta` next to the time range; sub-sections refresh with the page.

### X8. Time-range control placement and type (Medium)
- Evidence: Overview: `TimeRangePicker` in header `meta`. Analytics: a 24h/7d/30d segmented control at the tab row's right on three tabs, in its own row on Cost, without Refresh on Effectiveness. Standup: a `Select` in header actions. Logs: a "Last 1 hour" select beside the search. Cases: an "Any time" button among the filters. Entity investigation: a "Lookback" select.
- Change: `TimeRangePicker` (same presets and labels) in the header `meta` on every windowed page; remove page-local selectors.

### X9. Table density and wrapping (Medium)
- Evidence (body row height at 1440 px): Cost 41, Effectiveness 46, Dashboards widget 53, Logs 57-61, Campaigns 61, Cases 62. Header row 39-44 px. The Logs timestamp wraps to two lines in a monospace face; "osquery_process_event" breaks as "osquery_process_ev / ent"; Cases' id wraps as "CASE- / 000109".
- Sources: `webui/src/ui/table.tsx:131, 150` (default `normal` density: h-11 header, py-3 cells); `webui/src/soc/components/UnifiedLogsSheet.tsx:560` (170 px timestamp column) and 576 (`font-mono text-xs`, no `whitespace-nowrap`); Cases.tsx:1214 (`width: '9.5rem'`) and 1225 (mono + `uppercase tracking-wide` id beside a SAMPLE badge and the Ask AI chip).
- Change: default operational tables to `density="compact"` (36 px header, py-2 cells, roughly 36-40 px rows); `whitespace-nowrap` on ids, timestamps and IPs; a short timestamp form for log rows (time only, date in a group header or tooltip); `break-words` never inside identifiers (use truncation with a tooltip); Cases status in one line (the status badge, with the closure detail in the Outcome column).

### X10. Wide tables clip silently (High)
- Evidence: 05-cases-1440-light and 05-cases-1920-dark (Outcome then Risk cut at the right edge with no affordance), 22-analytics-cost (ledger "Avg / call" cut inside its card), 20-analytics-posture (MITRE heatmap's last tactic cut).
- Change: in `DataTable`, a right-edge fade while more columns are scrollable and a sticky first column; trim Cases' default visible columns (id, title, severity, status, assignee, updated; the others behind "Columns"); the MITRE heatmap wraps tactics or scrolls with the same fade.

### X11. Raw values and internal identifiers (Medium)
- "+18613m" SLA overage: Standup.tsx:709 (`+{Math.round(b.overdue_minutes)}m`), and Standup.tsx:577.
- "165h" oldest open case: Metrics.tsx:1293 and 1346, although Metrics.tsx:130-140 already has a page-local `humanizeMinutes` ("6d 21h").
- "+8124%" over target: Metrics.tsx around 1406-1409 (`over_pct`); an overage duration ("5d 15h over") reads better.
- Campaign names are hashes: Campaigns.tsx:203 renders `c.name || c.id`; derive a label from the shared entity and top technique (for example "198.51.100.23, 3 cases") and keep the id in the detail.
- Approvals "Source case: demo-hitl-00000539-0001" and "(verdict=NEEDS_HUMAN, risk=62.0)": Approvals.tsx around 437-472; show the case number (CASE-000047) and plain words.
- Case Collaboration activity shows "rule=demo-seed-approval action=request_approval proposal=prop-..." (10-case-manager-tab-collab): the automation event renders its raw payload (`soc/components/CaseActivityFeed.tsx`).
- Change: move `humanizeMinutes` from Metrics.tsx:130 into `webui/src/lib/format.ts` as `fmtDuration(minutes)` and use it in Standup and Posture; render case numbers wherever a case is cited.

### X12. Empty states inside table chrome (Medium)
- Evidence: Reports and Jobs (twice) render full uppercase column headers over an empty body; Inbox renders its empty state in a bordered card.
- Change: when a table has no rows and no active filter, render `EmptyState` (with its `state`) inside a `Panel` and hide the header row, as Overview's "Queue clear" does (Overview.tsx:1229).

### X13. Case detail sheet close button is covered (High, defect)
- Evidence: in both themes `document.elementFromPoint` at the close button's centre returns the case header, not the button (probe2.mjs output: `"isSelf":false`); 12-case-detail-sheet-*.png shows no close mark beside Share.
- Sources: `webui/src/ui/sheet.tsx:122-133` (close button absolutely positioned with no z-index); `webui/src/soc/pages/CaseDetail.tsx:1503-1510` (the sticky header is `relative z-10` with an opaque material and reserves `pr-14` for the button it then paints over).
- Change: give the sheet close button `z-30` in ui/sheet.tsx (fixes every sheet with a sticky header), or drop `z-10` from the case header.

### X14. Dashboard widgets clip their content (High, defect; owned with the dashboards brief)
- Evidence: 02-dashboards-view and 04-dashboards-builder: the Connector health table stops mid-row and the Response timing tiles are cut at the bottom; at 1440 px the right quarter of the grid is empty.
- Sources: `webui/src/soc/dashboard/WidgetGrid.tsx:156` (`overflow-hidden` on the widget body) with fixed `rowHeight = 56` (WidgetGrid.tsx:381) and default widget heights too small for their content.
- Change: size default widgets to their content (or let the view grid auto-size rows in view mode), and render widgets on panels like Overview instruments.

### X15. Colour used without meaning (Medium)
- Evidence: rainbow left bars on Posture KPI tiles; four colours of icon chip on Cost KPIs; green "Closed" and "Agreement" numerals, red "Avg risk 29"; a green zero on Jobs.
- Change: X5's colour rule; severity/status colour only on badges and the critical count.

### X16. Phone layout of Cases (High at 390 px)
- Evidence: 05-cases-390-light-full.png: about 950 px of chrome before the first row, then a nine-column table showing only id and a truncated title.
- Change: below `md`, render the queue as Case Manager's list rows (06-case-manager-queue-390-light.png), collapse the seven filters into a "Filters (n)" sheet, and show the summary strip as one horizontally scrolling row.

### X17. Vertical rhythm differs (Low)
- Evidence: Overview groups modules with 40 px gaps (`space-y-10`, Overview.tsx:3696); other pages use 24 px (`space-y-6` at Analytics.tsx:38, Campaigns.tsx:469, Standup.tsx:319, Inbox.tsx:658, UnifiedLogs.tsx:221, Approvals.tsx:813, Workspace.tsx:56).
- Change: `PageContainer` owns the rhythm: 24 px from header to first module, 40 px between bands (48 px from 1920 px), panel gutters 16/20/24 px as on Overview.

### X18. Em dashes and dangling marks in copy (Low)
- Standup description (Standup.tsx:323), Inbox description, the Dashboards edit banner, and the Approvals footer, which ends with a stray dash after "plain text." (Approvals page footer). The missing-value placeholder (`DASH` in lib/format.ts:12) is intentional; a dash used as a sentence break is not (Round 13 already removed them from seed strings).

### X19. Settings embedded in an operational page (Medium)
- Evidence: 24-jobs: the Jobs page ends with a "Discounted inference" settings form (toggles, a severity slider, provider tags). Source: BatchJobs.tsx:591.
- Change: move it to Settings (Models / AI) and leave a one-line link on Jobs.

## 5. Page-by-page findings

Ranks: H high, M medium, L low. Line numbers are on `claude/round12` as of this audit.

### Overview (reference), 01-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| OV1 | L | Title is 30 px from 1536 px while every other page stays 24 px, so the "same" header differs between pages on a large screen | Overview.tsx:3644 (`2xl:[&_h1]:text-4xl`) | Decide once: either all pages take the 30 px display step at `2xl` (in `PageHeader`) or Overview drops it |
| OV2 | L | The time range and LIVE chips use a monospace face, unlike every other control | `TimeRangePicker` | Use Inter tabular figures; keep mono for identifiers only |
| OV3 | info | Band headers "Alert flow" and "Cases and response" are being removed by ask 4; once removed, the module titles inside the panels carry the structure, which is the pattern the other pages should copy | Overview.tsx:1576 (`Band`) | Covered by the ask 4 brief |

### Dashboards (view, list, builder), 02-04
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| DB1 | H | Widget content clipped (X14) | WidgetGrid.tsx:156, 381 | See X14 |
| DB2 | H | White bordered widget cards with a ruled header and an icon chip; nested timing tiles with coloured left bars | ChartCard.tsx:56-61; widgets/lifecycle.tsx:54 | Widgets on `Panel` with the `Instrument` title row; timing as a compact strip |
| DB3 | M | Header: icon chip + description; the dashboard picker appears in `meta` only when there is more than one board; "Overview" sub-title with its own rule | Dashboards.tsx:144-178 | Overview header grammar; board picker always visible (it is the page's main control) |
| DB4 | M | Uppercase widget eyebrows ("SPEND IN THIS WINDOW", "AWAITING A HUMAN DECISION") | soc/dashboard/widgets/* | Sentence-case 13 px labels |
| DB5 | M | Builder repeats each title twice (drag bar and card header) | WidgetGrid.tsx:138-160 | In edit mode put the drag handle and arrows in the card's title row |
| DB6 | L | Grid leaves a quarter of the width empty at 1440 px | default layout | Default layout fills 12 columns |

### Cases, 05-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| CS1 | H | Table clips Outcome/Risk at 1440 and 1920 px with no affordance (X10) | Cases.tsx:1209 onward (columns) | Fewer default columns, edge fade, sticky id |
| CS2 | H | Phone layout (X16) | Cases.tsx | Case Manager list rows under `md` |
| CS3 | M | Case id wraps "CASE- / 000109" | Cases.tsx:1214, 1225 | `whitespace-nowrap`, no uppercase/tracking on the id, 11 rem column or move SAMPLE into the title cell |
| CS4 | M | Filters: seven full-width controls in three rows (about 180 px) at 1440 px; one row only from 1536 px | Cases.tsx:1697-1860 (`lg:grid-cols-3 2xl:flex`) | One `FilterBar`: search + 3 primary selects inline, the rest behind "More filters", active filters as removable chips |
| CS5 | M | Summary strip: icons, uppercase labels, 16 px numerals, on the canvas with `border-y` | Cases.tsx:656-720, 1584-1608 | `KpiStrip` on a panel, sentence-case labels |
| CS6 | M | Header: breadcrumb + icon chip + bordered "109 total" pill; the sort and Refresh live in a second band ("Case queue") | Cases.tsx:1516-1540, 1541-1575 | Overview header; total as plain muted text in `meta`; Refresh in header `meta`; sort in the table header |
| CS7 | M | 17 arbitrary `rounded-[4px]` (inputs, selects, buttons, pill) off the radius scale | Cases.tsx:766, 1532, 1553, 1568, 1716, 1721, 1742, 1760, 1775, 1789, 1805, 1849, 1859, 1920 | Remove; controls take `rounded-md` from the primitives |
| CS8 | M | Rows 62 px because Status stacks two badges | Cases.tsx (status column) | One status badge; closure detail stays in Outcome |
| CS9 | L | 2 resting/elevated shadows on page surfaces | Cases.tsx:763, 2167 | Only the floating bulk bar keeps an elevation |

### Case Manager (queue and detail tabs), 06-11
Already the closest to the standard (ui-standard lists it as a reference surface).
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| CM1 | M | The split frame is a white bordered box on the canvas, not a panel; at 1440 px it is visually a third surface level beside the Overview panels | CaseManager.tsx:1725-1740 (`case-manager-split-frame`) | Either a panel frame or no frame (queue and detail flush on the canvas, divided by the existing divider) |
| CM2 | M | Investigation tab: "AI assessment" is a bordered card inside the frame | CaseDetail.tsx / casedetail AI assessment block | Flat section with a hairline, like the other tab sections |
| CM3 | M | Threat context: the three "How this case was clustered" cards have different top offsets and heights | casedetail clustering flow | Equal-height row (`items-stretch`) |
| CM4 | M | Collaboration activity prints raw key=value automation payloads (X11) | CaseActivityFeed.tsx | Human sentence ("Automation requested approval (rule demo-seed-approval)") |
| CM5 | L | Tabs are 12 px underline; Analytics tabs are 13 px boxed (X6) | CaseDetail.tsx:1828-1850 | One underline variant at 13 px |
| CM6 | L | Phone: the tab row scrolls horizontally with "Threat context" cut and no fade | 06-case-manager-queue-390-light | Edge fade on the tab row |

### Case detail sheet, 12-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| SH1 | H | Close button hidden under the sticky header (X13) | ui/sheet.tsx:122-133; CaseDetail.tsx:1503-1510 | `z-30` on the close button |
| SH2 | L | The sheet uses Case Manager's header and tabs, which is right; nothing else to converge | | |

### Campaigns, 13-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| CP1 | M | Rows are named by 40-character hashes (X11) | Campaigns.tsx:203 | Derived human label; id in the detail |
| CP2 | M | Eyebrow "TRIAGE", icon chip, description; Refresh in a separate band | Campaigns.tsx:469-480, 281 | Overview header; Refresh in `meta` |
| CP3 | M | Boxed tabs with icons for "Campaign review / Policy & schedule" | Campaigns.tsx:482-494 | Underline tabs, or move "Policy & schedule" to Settings and drop the tabs |
| CP4 | M | Bordered table card with uppercase headers, 61 px rows | Campaigns table | Panel + compact sentence-case table |
| CP5 | L | MITRE column empty for most rows while "Shared entities" repeats the same IP on 8 rows | data | Group or label repeated entities |

### Chat workspace, 14-15
Rebuilt in Round 13; mostly consistent (the start cards already use a tinted panel fill).
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| CH1 | L | In a thread, the composer is wider than the 42 rem reading column, so the answer and the composer do not share a right edge (15-chat-thread-1440-light) | soc/chat/message READING_COL vs composer width | Cap the composer to the reading column in a thread, or align both to the lane |
| CH2 | L | Case list answers show four outlined badges per row (severity, verdict, status, risk) | soc/chat/blocks | Covered by the chat drill-down brief (ask 6) |

### Reports, 16-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| RP1 | M | Empty library shows full uppercase column headers over an empty body inside a bordered card (X12) | soc/chat/report/ReportsLibrary.tsx | `EmptyState` on a panel without header row |
| RP2 | M | Eyebrow "WORKSPACE" + icon chip + description | Reports.tsx:42, 55 | Overview header |

### Standup, 17-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| SU1 | H | `variant="hero"` header: a 236 px bordered, tinted card holding the title, controls, a mono stamp and six bordered KPI tiles | Standup.tsx:319-345 | Overview header (title, window and refresh in `meta`, "generated just now" as freshness in `actions`); the six tiles become a `KpiStrip` on a panel below |
| SU2 | H | Raw "+18613m" SLA overage; "CASE-000004" followed by the dash placeholder where the priority is missing | Standup.tsx:709, 706, 577 | `fmtDuration`; omit the empty priority |
| SU3 | M | Nested SLA tiles inside the SLA card; attention queue in a bordered card | Standup.tsx (SLA pressure section) | Panels, compact strip |
| SU4 | M | Attention queue shows all 20 rows (page 2,747 px tall) | Standup.tsx | Show 8 with "Show all 20" (Overview's queue rule: fill, floor, cap) |
| SU5 | L | Em dash in the description (X18) | Standup.tsx:323 | Rewrite |

### Analytics (all five tabs), 18-22
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| AN1 | H | Bordered chart cards, nested tiles, uneven card heights leaving holes in the grid (Operational: Verdict mix stops at 685 px while Persona usage runs to 860 px) | ChartCard.tsx; Metrics.tsx CARD_GRID (Metrics.tsx:127) | Panels; rows `items-stretch`; a long list caps its rows with "Show all" |
| AN2 | M | KPI strip: uppercase labels with coloured icons, coloured numerals (X5) | Metrics.tsx:565-650; KpiTile.tsx:1057-1059 | `KpiStrip`, ink numerals |
| AN3 | M | Uppercase section titles ("LIFECYCLE TIMING (7D)", "OPEN-CASE AGING", "SLA ATTAINMENT", "MITRE ATT&CK COVERAGE") | Metrics.tsx:1045, 1073, 1085, 1280, 1365, 1445 | `SubBandTitle` style, sentence case |
| AN4 | M | Controls move between tabs: window + Refresh + sort on the tab row (Operational), window + Refresh (Performance, Posture), window + metric + icon-only refresh in their own row (Cost), window without Refresh (Effectiveness), plus two extra Refresh buttons inside Effectiveness | Metrics.tsx:920-960; Cost.tsx:690-710; AgentEffectiveness.tsx:491; HealthDiagnostics.tsx:321 | Window + one RefreshButton in the Analytics header `meta`, the same on every tab; tab-specific controls (Count / A-Z, Cost / Tokens / Calls) move into the module they sort |
| AN5 | M | Boxed tab strip with icons (X6) | Metrics.tsx:922-943 | Underline tabs, no icons |
| AN6 | M | Performance: three different tile styles on one tab (icon-chip tiles, nested P50/P90 boxes, plain tiles) | Metrics.tsx:1036-1120 | One compact strip per module |
| AN7 | M | Posture: "165h" and "+8124%"; MITRE heatmap clipped; uppercase "BREACHED" badges | Metrics.tsx:1293, 1346, around 1393-1409; Metrics.tsx:1458 (MitreHeatmap) | `fmtDuration`; overage duration; heatmap wraps or scrolls with a fade; sentence-case badge |
| AN8 | M | Operational: the embedding model value "text-embedding-3-small" breaks mid-word inside a KPI tile | Metrics.tsx:494-505 (`InlineCode` as a KPI value) | Show the model as the tile's context line or a plain row, `break-normal`, never inside a numeral slot |
| AN9 | M | Effectiveness: a third dialect (flat, uppercase micro-labels, mono figures, 3,524 px tall) with a mid-page segmented control | AgentEffectiveness.tsx; AgentOperationalOutcomes.tsx; AgentOutcomeReview.tsx | Same panels and strip; collapse the "insufficient evidence" detail rows into one disclosure while evidence is collecting |
| AN10 | M | Cost: ledger table clipped inside its card; four colours of KPI icon chips; a 24-hour spend chart with only 2 buckets draws a straight line | Cost.tsx (ledger, KPI row); usage buckets | Edge fade or fewer columns; ink tiles; hourly buckets for 24 h |
| AN11 | L | Header description wraps to two lines with a hyphenation break ("evidence- / led") | Analytics.tsx:39-43 | One short line or a HelpTip |

### Inbox, 23-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| IN1 | M | Eyebrow "NOTIFICATIONS", chip, two-line description with an em dash; a second "Inbox view" band carries five buttons | Inbox.tsx:658-700 | Overview header; filters in one `FilterBar`; Refresh in `meta` |
| IN2 | M | Empty state inside a bordered card; a disclaimer line under it | Inbox.tsx:690-730 | Panel + EmptyState; move the disclaimer into the help |

### Jobs, 24-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| JB1 | M | Settings form on an operational page (X19) | BatchJobs.tsx:591 | Move to Settings |
| JB2 | M | Two empty tables with full headers (X12); worker cards boxed with "Last success" followed by the dash placeholder | BatchJobs.tsx:415-600 | EmptyState on a panel; worker rows as a list in one panel with "never" instead of a dash |
| JB3 | L | Eyebrow "OPERATIONS" (rail says Analytics); green zero numeral | BatchJobs.tsx:418; KpiTile.tsx:1057-1059 | Overview header; ink numerals |

### Logs (unified), 25-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| LG1 | H | Densest data with the tallest rows: timestamp wraps, rule names break mid-word, 57-61 px rows, 9,113 px page for 150 events | UnifiedLogsSheet.tsx:556-600 | Compact density, nowrap timestamp (time only, date as a group header), truncate module with tooltip, about 36 px rows |
| LG2 | M | Bordered table card, uppercase headers, source chips with uppercase "SEARCH" | UnifiedLogsSheet.tsx:556 (`rounded-lg border`), source chips above | Panel; sentence case; chips quieter |
| LG3 | M | Eyebrow "TRIAGE", chip, description; time range as a Select beside search, separate Live tail toggle | UnifiedLogs.tsx:221-230 | Overview header with `TimeRangePicker` + live toggle in `meta`, search as the page's `FilterBar` |

### Entity investigation, 26-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| EI1 | M | Eyebrow "AGENT WORKSPACE" (rail says Workspace), chip, description, then a lone "View cases" button in its own 40 px row | Workspace.tsx:56-62; Investigate.tsx:485-492 | Overview header with "View cases" in `actions` |
| EI2 | L | The three-step explainer strip takes 95 px above the form on every visit | Investigate.tsx | Collapse into a HelpTip or show it only in the empty state |

### Approvals, 27-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| AP1 | M | Proposal cards with a 3 px coloured left accent; uppercase labels (10 occurrences) | Approvals.tsx:249-278 | Panel rows; the kind as a badge; sentence case |
| AP2 | M | Cites the internal case id and raw "verdict=..., risk=..." text (X11) | Approvals.tsx around 437-472 | Case number link; plain words |
| AP3 | M | Breadcrumb "Automation > Approvals" (rail: Triage), chip, description, plus an always-on info callout above the queue | Approvals.tsx:814-830 | Overview header; the callout as help |
| AP4 | L | Footer ends with a stray dash after "plain text." | Approvals.tsx footer | Remove |

### Dark mode and phone notes
- Dark mode carries the same structure; no token is missing. The bordered cards read as a third surface step between canvas and panel in dark (02-dashboards-view-1920-dark, 18-analytics-operational-1920-dark), which is the clearest argument for X1. Coloured numerals are louder in dark (green 80, red 29).
- At 390 px Overview, Case Manager and Chat are sound; Cases is not (X16). No page overflows the document horizontally (`docOverflowX` 0 everywhere); clipping happens inside table and tab scrollers without a visible fade.

## 6. Shared primitives to create or unify

The goal is that a page converges by swapping components, not by restyling itself. Each item names what exists today, what to change, and which findings it closes.

1. **`Panel` (new, `webui/src/design-system/panel.tsx`, exported from `@/design-system`)**: `<Panel title? caption? count? aside? as="section">` rendering `.surface-panel` with Overview's `PANEL_PAD` and the `Instrument` title row (Overview.tsx:1516-1518, 1642-1680 move here). Props: `padding="default|none"` (tables bleed to the panel edge), `role` passthrough. Lint rule: no `Card` inside a `Panel`. Closes X1, X2, X12, DB2, AN1, SU3, AP1, LG2.
2. **`Band` and `SubBandTitle` (promote from Overview.tsx:1576-1640)**: the one section title style (15 px / 14 px semibold sentence case, caption, aside). Replaces the uppercase h2s. Closes X4, AN3.
3. **`PageHeader` (change defaults)**: Overview grammar by default; `icon`, `eyebrow`, `breadcrumb` and `variant="hero"` deprecated for routed pages; `description` one line or `help`; a `controls` slot (alias of `meta`) documented for time range + refresh; `freshness` slot. Drop `tracking-tight` (PageHeader.tsx:247). Closes X3, X7, X8, SU1, and every page's header row.
4. **`KpiStrip` (new wrapper over `KpiTileGrid` + `KpiTile`)**: panel + strip tiles + divider math, `density="comfortable|compact"`, sentence-case labels, no icons, hero colour rule for every tile (change KpiTile.tsx:1057-1059; remove the uppercase non-hero label branch at KpiTile.tsx:983-986; retire `variant="bar"` and `variant="default"` chrome at KpiTile.tsx:1164). Closes X5, X15, CS5, AN2, AN6, SU1, JB3.
5. **`ChartCard` → `ChartPanel`**: same API, rendered on `Panel`, no header rule, no icon chip (ChartCard.tsx:56-61). Also used by dashboard widgets so the custom dashboards look like Overview.
6. **Table density and header style (`ui/table.tsx`, `DataTable`)**: header sentence case 12 px medium (table.tsx:129, DataTable.tsx:437); `compact` default for operational tables; built-in right-edge fade and optional sticky first column; `emptyState` prop that hides the header row. Optionally a `TimestampCell` and `IdCell` with `whitespace-nowrap`. Closes X9, X10, X12, CS1, CS3, LG1.
7. **`FilterBar` (exists, `soc/components/FilterBar.tsx`; make it the only filter layout)**: search + up to three primary filters inline, "More filters" popover for the rest, active filters as removable chips, Clear all; collapses into a sheet below `md`. Closes CS4, X16, IN1, LG3.
8. **Tabs: `variant="underline"` in `ui/tabs.tsx`** for page and record sections (13 px, no icons); the boxed rail stays as `SegmentedControl` for in-module view switches. Closes X6, AN5, CP3, CM5.
9. **`RefreshButton` + `TimeRangePicker` as the only page-level data controls**, placed by `PageHeader`; remove the hand-rolled spinners (Cost.tsx:701-704, AgentEffectiveness.tsx:491, HealthDiagnostics.tsx:321). Closes X7, X8, AN4.
10. **Formatting helpers in `lib/format.ts`**: `fmtDuration(minutes)` (moved from Metrics.tsx:130), `fmtOverage(minutes)`, and a `caseLabel(case)` that always prefers the case number. Closes X11, SU2, AN7, AP2.
11. **`PageContainer` rhythm**: one vertical rhythm for all pages (24 px header to content, 40 px between bands, 48 px from 1920 px), so pages stop setting `space-y-6` themselves. Closes X17.
12. **Sheet close stacking** in `ui/sheet.tsx` (`z-30`). Closes X13.

A guard test in the style of `route-visual-standard` and `material-gate.test.ts` (both already exist) would keep pages from drifting back: fail on `eyebrow=` or `breadcrumb=` in `soc/pages/*`, on `uppercase tracking` in page files, on `rounded-[` arbitrary radii, on `<Card` inside a `Panel`, and on a `RefreshCw` with `animate-spin` outside `RefreshButton`.

## 7. Suggested order of work

1. Defects first, small and safe: X13 (sheet close), X14 (widget clipping), X11 formatting (`fmtDuration`, case numbers), CS3/LG1 nowrap.
2. Shared primitives (section 6, items 1-6 and 8-9) with their tests, then migrate pages in two passes: Analytics (all tabs), Standup, Dashboards widgets, Cases, Logs first (largest visual gain, see the P-*-converged previews); then Campaigns, Reports, Inbox, Jobs, Approvals, Entity investigation, Case Manager frame.
3. Phone pass for Cases (X16) and the guard test.
4. Update `docs/development/ui-standard.md` ("Page anatomy", "Foundations > Radii", "Operational metric surfaces") so the grouped-panel grammar is the rule for every page, not only the primary dashboard.

## 8. Open questions for the operator

1. Should every data page adopt the grouped panels (tinted, borderless), or do you prefer the flatter divider-led look for list pages (Cases, Logs, Campaigns) and panels only for dashboards and analytics? The P-cases-converged preview shows panels on a list page.
2. Page descriptions: remove them (Overview has none) or keep one short line under the title? Help tips would carry the longer explanations.
3. Should the 30 px display title stay Overview-only, or should all page titles grow to 30 px on large screens?
4. Campaigns: may we show a derived human-readable campaign label (entity + case count) instead of the hash id?
5. Jobs: may we move the "Discounted inference" settings into Settings?

## Sources

- [Carbon data table style](https://carbondesignsystem.com/components/data-table/style/) (row heights 24/32/40/48/64 px, column header 14 px semibold, one row size per table, pagination matches row height).
- [Carbon dashboards](https://carbondesignsystem.com/data-visualization/dashboards).
- [PatternFly dashboard design guidelines](https://www.patternfly.org/patterns/dashboard/design-guidelines) and [card design guidelines](https://www.patternfly.org/components/card/design-guidelines).
- [Atlassian AUI page header](https://aui.atlassian.com/aui/7.3/docs/page-header.html) (title, optional breadcrumb, actions on the right).
- [Sainsbury's design system header](https://design-systems.sainsburys.co.uk/components/header/) (sentence case, primary actions, do not overload).
- [Singapore Government Design System header block](https://www.designsystem.tech.gov.sg/templates/block-templates/header) (title, optional description and breadcrumb, primary action for internal tools).
- Earlier project research: docs/research/2026-10-round12/research/dashboard-ux.md, SYNTHESIS-ux.md, apple-design-SKILL.md; docs/development/ui-standard.md.
