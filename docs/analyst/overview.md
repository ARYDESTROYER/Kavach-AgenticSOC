---
title: Analyst overview
description: Start a shift from the v0.1 Security Command Center and move from posture to action.
---

# Analyst overview

The **Overview → Dashboard** page is the operational starting point for a shift. It
combines case pressure, response timing, source coverage, and recent outcomes without
changing any case or detection policy.

## Read the page from top to bottom

1. **Select a time window** — the primary case counts and comparison deltas use the
   same range. The page opens at **Last 24 hours** with **LIVE** selected. LIVE
   refreshes every five seconds while the browser tab is visible and pauses while it
   is hidden. Choose Off, 5 seconds, 30 seconds, 1 minute, or 5 minutes when a
   different operating cadence is more appropriate.
2. **Read the five operational KPIs** — Open Cases, Critical / High, Escalated to
   Human, False Positive Rate, and Auto-resolved. The Open total includes every
   non-terminal lifecycle (`new`, `open`, `needs_human`, `investigating`,
   `escalated`, and `on_hold`). Critical / High covers both open and resolved cases
   in the selected window and states that split explicitly.
3. **Use the instrument row** — Active Risk Index summarizes pressure across the
   entire open queue; the Open and Resolved composition rings show severity mix;
   Latest Cases shows exactly four recent records and reveals bounded detail on
   hover or keyboard focus.
4. **Inspect Noise Reduction** — follow the horizontal ribbon from alerts ingested
   through clustering and cases opened. Opened cases then split into
   AI auto-cleared and escalated work; human closure is an overlapping analyst-owned
   subset of escalated work, not newly created volume. The restored fan places those
   operational views beside one another for scanability; the aligned labels carry the
   authoritative relationship. Each stage
   retains its count and percentage without decorative icon noise; those labels are
   authoritative when the curves are visually compressed. Hover or focus a stage to
   inspect severity detail. Selecting an outcome opens the matching selected-window
   Cases cohort; earlier stages open the selected-window Cases context. Choose
   **Expand** for a near-fullscreen, horizontally scrollable view. Beneath the aggregate
   flow, inspect a lazy bounded sample of newest case-forming paths from one-way alert
   references through the persisted deterministic cluster and opened case to its current
   or terminal outcome. Coverage, store-page, and sample notices identify every bound
   instead of presenting partial data as complete.
5. **Check burndown and response timing** — look for backlog growth and changes in
   MTTD, MTTA, MTTR, or dwell, then open **Deeper analytics** for autonomy,
   connector coverage, workload, outcomes, top signatures, and top entities.

False Positive Rate and Auto-resolved come from the server posture rollup rather
than the bounded case list. They are keyed to the selected window and comparison
mode. When the range changes, the Console immediately hides the old posture values,
cancels the superseded request, and publishes a response only if its echoed
`window_hours` still matches the active selector. A slower earlier request therefore
cannot repaint either tile beneath a newer range. While the replacement is in flight,
the tiles show a loading/unavailable state instead of mixing windows.

The full **Agent health** diagnostic panel no longer occupies the Overview layout.
When every readable signal is healthy—or the operator cannot read either diagnostic
source—Overview renders no health panel at all. A positively detected precedent-corpus,
migration, or auto-close degradation produces one compact warning strip. Its
**View effectiveness** action opens the shareable
`#/metrics?tab=effectiveness` route, where the complete evidence follows the same
selected Analytics window. Unknown or unmeasured evidence remains visible there but
is not promoted into a false Overview incident.

The primary Open and Resolved controls drill directly into the matching case scope.
The combined Critical / High tile opens the selected-window case list without
pretending that the single-severity Cases filter can express both bands at once; its
visible open/resolved arithmetic remains the authoritative combined total. A case
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

- **Source says** — fields and detections reported by a connected system.
- **Agent found** — the model's assessment, supporting evidence, confidence, and
  recommended action.
- **Code decided** — the deterministic policy result that controls automatic close
  or human review.

Use [Cases](cases.md) for the full record. A model verdict is never, by itself, an
authorization to close a case.

## Time and scope

Selected-window cards are windowed rollups. Active Risk is deliberately a current
open-queue measure rather than a historical-window total, and its help text states
that scope. Timing cards expose their sample availability, and source coverage is
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
