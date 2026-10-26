---
title: Analyst overview
description: Start a shift from the v0.1 Cyber Defence Center and move from posture to action.
---

# Analyst overview

The **Cyber Defence Center** is the operational starting point for a shift: the
Console opens on it after you sign in, and **Overview → Cyber Defence Center** in the
navigation returns to it. It combines case pressure, response timing, source coverage,
and recent outcomes without changing any case or detection policy.

## Read the page from top to bottom

1. **Select a time window.** The primary case counts, hover trendlines, and the
   open/resolved comparison chips use the same range. The page opens at **Last 24 hours** with **Live** selected. Live
   refreshes every five seconds while the browser tab is visible and pauses while it
   is hidden. Choose Off, 5 seconds, 30 seconds, 1 minute, or 5 minutes when a
   different operating cadence is more appropriate. The refresh button beside the
   range reloads every card at once; it spins only while a reload you pressed is in
   flight, and keeps your keyboard focus when it is done. A Live refresh never turns
   it busy: the green Live dot in the range control is what tells you the page
   refreshes itself.
2. **Read the six operational KPIs**: Total cases, Total critical, Open cases,
   AI-verdict FP rate, Resolved or closed, and Auto-closed. On a phone the strip shows
   two tiles to a row. The Open total includes
   every non-terminal lifecycle (`new`, `open`, `needs_human`, `investigating`,
   `escalated`, and `on_hold`) and is a **stock** read at the rollup's own timestamp,
   so it is deliberately not filtered by the selected window. Total critical counts
   the top band the severity ladder declares, over the window, from the server
   rollup. **AI-verdict FP rate** (called False Positive Rate before this release) is
   the share of the window's verdicted cases that the AI verdicted false positive; it
   measures the AI's call, not an analyst's, and carries no period-over-period chip. Its
   drill-down also shows how many of the same cases an analyst confirmed as false
   positive. Numerals never truncate: on a narrow screen a tile's caption moves under
   its number instead.

   **Auto-closed is a subset of Resolved or closed, not a sixth independent total.**
   The row does not sum: `auto closed + human closed + system closed` equals
   Resolved or closed exactly, and Open cases sits outside the window altogether.
   Auto-closed is counted over the agent-worked population only: cases an operator
   closed under a "declared benign" rule policy are excluded, which is why its share
   names its own denominator ("of agent-worked closes") rather than borrowing the tile
   beside it.

   The tiles carry a **numeral and a label, and no standing caption**. What a numeral
   counts, and the "out of what" behind it, live in the tile's help (the `?` beside
   the label, which opens on click and is reachable by keyboard and touch) and in the
   drill-down that opens when you select the tile. A caption appears only when
   something is wrong with the measurement (see below). Where a numeral is a **lower
   bound** rather than a fact, the tile marks the number itself with a `≥`, and the
   full sentence is announced to screen readers; where a value is **withheld** because
   the window was not fully covered, the dash shown in its place carries that
   explanation instead.
   Hover or keyboard-focus a metric to reveal
   its recent trendline for the same window: the card names the exact series it
   draws, states the bucketing (for example `last 24 hours · 1h buckets`), and shows
   a quiet "No trend data yet" line instead of inventing a trend when the series has
   no measured buckets. Total critical deliberately has no trendline, because no
   per-severity bucket series exists for it.
3. **Read the two rows of modules.** Below the strip the page is one grid of panels.
   Each module sits on its own soft tinted panel, with no border and no shadow, so you
   can see at a glance where one ends and the next begins; the KPI strip and the Deeper
   analytics header sit on panels too. There are no section titles between the rows:
   the strip, the two rows and the Deeper analytics header sit one panel gutter apart
   (16 px, 20 px from 1280 px, 24 px from 1920 px), the same gap as between the panels
   inside a row. Every module's title is inside its panel, and each one names the window
   it reads right after the title, for example **Noise reduction flow** *last 24 hours*.
   - The first row holds the **Noise reduction flow** and **Human vs AI**, which
     attributes the window's closes to the agent, an analyst, or system routing. When the
     flow's opened cases equal the Total cases tile, the flow's footer says so: "Same
     count as Total cases above."
   - The second row holds the case state (the **Open cases** and **Cases resolved**
     composition rings, which show severity mix and share one panel, split by a thin
     line), **Response time** (MTTD paired with Respond, the first human action, both
     medians, captioned *p50 · last 24 hours*; its help explains that the server
     computes them), and **Latest cases**, *Newest of the last 24 hours*, which shows
     five to eight recent records, as many as fit beside the other modules, and reveals
     bounded detail on hover or keyboard focus.

   On very wide screens each row gains a narrower rail on the right: Human vs AI sits
   above Latest cases beside the main column.
4. **Inspect Noise Reduction.** Follow the horizontal ribbon from alerts ingested
   through clustering and cases opened. Opened cases then split into
   AI auto-cleared and escalated work; human closure is an overlapping analyst-owned
   subset of escalated work, not newly created volume. The restored fan places those
   operational views beside one another for scanability; the aligned labels carry the
   authoritative relationship. Each stage
   retains its count and percentage without decorative icon noise; those labels are
   authoritative when the curves are visually compressed. Hover or focus a stage to
   inspect severity detail. Selecting an outcome opens the matching selected-window
   Cases cohort; earlier stages open the selected-window Cases context. Choose
   **Full screen** for a near-fullscreen, horizontally scrollable view. Beneath the aggregate
   flow, inspect a lazy bounded sample of newest case-forming paths from one-way alert
   references through the persisted deterministic cluster and opened case to its current
   or terminal outcome. Coverage, store-page, and sample notices identify every bound
   instead of presenting partial data as complete.
5. **Check response timing.** Look for changes in MTTD, MTTA, MTTR, or dwell, then
   open **Deeper analytics**. It is one disclosure: **Efficiency and cost** (MTTA, MTTR,
   Dwell, and LLM spend for the window) and **What's driving volume** (ingest coverage,
   case volume, workload state, case outcomes, top signatures, and top entities). While
   it is closed, its header summarizes what it holds, for example the timing figures,
   spend, silent sources, and the top signature. Whether it is open is remembered for
   your account, on every device. For opened-versus-resolved backlog growth, open
   **Analytics → Metrics** and read **Closure vs arrival** on the Posture tab.

## How fresh the page is

The page header carries **one** freshness stamp, "Updated 2m ago". The cards load
independently (the case batch, the noise flow and the posture rollup that feeds the
strip and Response time), so the stamp shows the **oldest** of them: it never claims a
freshness that one of the cards on screen does not have. Select the stamp (click or
tap it, or press Enter or Space) to see which data it covers and the exact time of the
oldest, in UTC, for example "Oldest of cases, flow and response data: 14:02:31 UTC";
a screen reader reads the same sentence with the stamp. A hidden noise flow is left
out, because no card on screen shows its data, and so are the flow and the response
data on an empty page. When the
noise flow or LLM spend cannot refresh, that card says so ("Refresh failed. Showing
the last loaded flow.") and keeps its last loaded figures, and the flow keeps naming
the window it was loaded for. When the case list or the metric totals cannot refresh,
the cards keep their last loaded figures and the stamp keeps the time of that last
successful read: it never moves past the oldest data on screen.

AI-verdict FP rate, Resolved or closed and Auto-closed come from the server posture
rollup rather than the bounded case list. They are keyed to the selected window and
comparison mode. When the range changes, the Console keeps the last successful posture
snapshot visible instead of blanking the tiles. It no longer captions those numerals
`Loading …` while a refresh is in flight: on a Live dashboard that fired on every tick,
and the numbers being captioned were a real measurement, not a placeholder. The green
Live dot says the page refreshes itself, and the refresh button spins while a reload you
pressed is in flight. A **first** load, with nothing yet to show, still says so on the
tiles. The superseded request
is cancelled, and a response is published only if its echoed `window_hours` still
matches the active selector, so a slower earlier request can never repaint either
tile beneath a newer range. The retained snapshot is always labelled as refreshing,
never presented as fresh selected-window truth.

The full **Agent health** diagnostic panel no longer occupies the Overview layout.
When every readable signal is healthy, or the operator cannot read either diagnostic
source, Overview renders no health panel at all. A positively detected precedent-corpus,
migration, or auto-close degradation produces one compact warning strip. Its
**View effectiveness** action opens the shareable
`#/metrics?tab=effectiveness` route, where the complete evidence follows the same
selected Analytics window. Unknown or unmeasured evidence remains visible there but
is not promoted into a false Overview incident.

The primary Open and Resolved controls drill directly into the matching case scope.
Total critical opens the selected window's cases filtered to the top severity band;
because that band is derived when the cases are read, its drill-down states that it
covers the rows that were read, and the tile's server count remains the authoritative
total. A case
opened from Latest Cases retains its full provenance and deterministic decision.

The dashboard shows an explicit empty or degraded state when there is not enough
data. A zero is not substituted for a timing metric that has no eligible samples.
Noise Reduction does not expose raw alert identifiers or payloads. Alerts that never formed
a case remain represented only by aggregate counters. The Cases destination loads a
bounded case window, so its filtered list can be a lower bound when the backend reports
more records than the loaded set; the aggregate stage count and its coverage notice remain
authoritative. For the full context around one
sampled case, follow its Case Manager link and open **Threat context → How this case was
clustered**.

## Provenance matters

Agentic SOC keeps three responsibilities separate:

- **Source says**: fields and detections reported by a connected system.
- **Agent found**: the model's assessment, supporting evidence, confidence, and
  recommended action.
- **Code decided**: the deterministic policy result that controls automatic close
  or human review.

Use [Cases](cases.md) for the full record. A model verdict is never, by itself, an
authorization to close a case.

## Time and scope

Selected-window cards are windowed rollups. Active Risk is deliberately a current
open-queue measure rather than a historical-window total, and its help text states
that scope.

Every figure for the selected window, including Total cases, Total critical, Resolved
or closed, Auto-closed, the AI-verdict FP rate, and the rollups below the strip, is
computed from the window's cases up to 20,000 cases. A larger window, typically **All
time** on a large store, is analysed over its newest 20,000 cases: its counts show as
lower bounds (`≥`) and its rates are withheld. The Open cases stock is an exact
store-wide count at any size, as are the case totals on **Analytics → Metrics**, and
those agree with what Workspace Chat reports for the same question; chat's case counts
are exact for a window of any size. See
[the KPI glossary](kpi-glossary.md#how-to-read-a-kpi). Timing cards expose their sample availability, and source coverage is
reported independently of case volume: a quiet source and an unread source are not
the same condition.

The posture endpoints require `metrics:view` where RBAC is enabled. Auto-close health
uses the same grant; the broader diagnostic health response requires `settings:read`.
Case drill-down requires `cases:read`; source health requires `sources:read`.

## Custom views

Open **Overview → Dashboards** to use or clone a role-oriented dashboard. A custom
dashboard is personal presentation state: changing its name, widgets, or layout does
not alter detection, risk, or case decisions.

The v0.1 widget catalog includes:

- needs-human queue and LLM cost/budget KPIs;
- open-by-severity and autonomous-versus-human charts;
- lifecycle timing;
- connector health and recent-case tables;
- MITRE ATT&CK coverage; and
- the active-risk gauge.

Widgets are filtered by the same permissions as their underlying data. Unknown or
retired widget types are ignored when a saved layout is loaded.

## A practical shift loop

1. Check coverage before trusting volume-based conclusions.
2. Open the highest-risk or SLA-pressured case.
3. Acknowledge it before beginning work so response timing remains meaningful.
4. Record findings, tasks, disposition, and feedback in the case.
5. Use **Overview → Standup** for the attention queue and shift handoff.

Continue with [case handling](cases.md), [analytics](analytics.md), or
[collaboration](collaboration.md).
