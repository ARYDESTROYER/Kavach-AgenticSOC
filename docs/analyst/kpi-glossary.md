---
title: KPI glossary
description: Exact definitions of the Overview and Analytics KPIs, including the Active Risk Index, risk score, AI-verdict false positive rate, MTTD, MTTA, MTTR, dwell, SLA attainment, noise reduction stages, auto-closed cases, and AI spend.
---

# KPI glossary

This page is the single reference for the numbers on **Overview → Cyber Defence Center** and
**Analytics → Metrics**. On the dashboard, most KPIs carry a short help (`?`) popover
drawn from these definitions, and when you can use chat that popover ends with **Ask
about this**, which opens a new chat that asks the question for you. MTTD and Respond
explain themselves in a tooltip instead. A few **Analytics → Metrics** tiles carry a
short help tip; this page holds the full definitions. Workspace Chat answers questions
such as "What does MTTA measure?" from this page and cites the matching section.

Every KPI is advisory. A metric describes stored cases, ingest counters, or the usage
ledger; none of them feeds the deterministic close or escalate decision.

## How to read a KPI

- **Window.** Most tiles count cases that **arrived** in the selected time window,
  keyed on case-arrival time. Open Cases and the Active Risk Index are exceptions: they
  measure the queue as it is right now.
- **Not measured.** An em dash (`—`) means the value was not measured, for example
  because no case carries the timestamp a timing metric needs. It is never a zero.
- **Lower bound.** A `≥` before a number means the server could only count part of the
  window; the real value is at least that large.
- **Withheld.** A rate is withheld rather than shown when the window was not fully
  covered, because a partial ratio would look like a fact.
- **Exact at any size.** A few figures are exact store-wide counts however many cases
  the store holds, and they match what Workspace Chat reports for the same question:
  the **Open Cases** stock, and the case counts on **Analytics → Metrics** (**Total
  cases**, Needs human, Resolved or closed, the active cases beside it, and the counts
  by status, verdict, and disposition). There **Needs human** is the open cases whose AI
  verdict is Needs human, the same figure Standup and the dashboards show; a case an
  analyst has closed is not counted.
- **Exact up to 20,000 cases in the window.** Every other dashboard figure is computed
  from the cases in its window, up to 20,000 of them. That covers every Overview figure
  for the selected window (Total Cases, Total Critical, Resolved / Closed, Auto Closed,
  the AI-verdict FP rate, and the rollups below them) and the heavier rollups behind
  the dashboards (timing, verdict mix, ATT&CK coverage, auto-close health, agent
  improvement, and similar). When a window holds more than 20,000 cases, typically
  **All time** on a large store, only its newest 20,000 are analysed: a count then shows
  as a lower bound (`≥`) and a rate is withheld, instead of a partial figure being shown
  as complete. Chat's case counts have no such limit, so for a window that large the
  chat figure is the exact one.

## Risk

### Active Risk Index

The **Active Risk Index** is the average deterministic risk score (0–100) across every
case that is currently **open**. Resolved and closed cases are excluded, and the index
is not scoped to the selected time window: it describes the queue right now.

The gauge uses four bands:

| Band | Index |
| --- | --- |
| Critical | 74 or higher |
| High | 48 to 73 |
| Medium | 22 to 47 |
| Low | below 22 |

When there are no open cases the gauge shows "no open cases" instead of a zero.

### Risk score

Each case carries a deterministic **risk score** from 0 to 100. It is a weighted blend
of five factors (default weights):

| Factor | Weight | What it measures |
| --- | --- | --- |
| Reputation | 30% (heaviest) | The worst threat-intelligence reputation among the cluster's IP addresses; 0 when there is no IP |
| Volume | 25% | How many events fired, log-normalised so large clusters level off around 50 events |
| Velocity | 20% | Events per minute (full near 10 per minute); 0 below three events or a sub-second window |
| Diversity | 15% | How many distinct rule types fired (maxes out at five) |
| Asset criticality | 10% | How important the targeted asset is, from the operator's CIDR or exact-match map; 0 when uncatalogued |

Change the weights in **Settings → General → Detection → Risk weights** and the asset
map in **Settings → General → Detection → Asset criticality**. The risk score only
ranks what an analyst looks at first and decides which candidates reach investigation;
it never closes or escalates a case on its own. It is not the model's confidence.

## Case volume KPIs

### Total Cases

Every case that **arrived** in the selected window, including cases an operator closed
under a "declared benign" rule policy. This is the denominator the other window tiles
are shares of.

On **Analytics → Metrics**, **Total cases** is a different figure: every case in the
store (all time), whatever the selected window, counted exactly at any store size. Its
caption says "Every case in the store", or names the breakdown that could only be
counted in part.

### Total Critical

Cases in the top severity band of the window's arrivals, counted on the server from the
severity roll-up over the window rather than from the rows the page loaded (up to
20,000 cases; see [How to read a KPI](#how-to-read-a-kpi)). The band is the top band the
severity ladder declares, which is not always called "Critical".

### Open Cases

The cases that are open **right now**, whenever they arrived: `new`, `open`,
`needs_human`, `investigating`, `escalated`, and `on_hold`. It is a stock, not a flow,
so it is deliberately not filtered by the selected window and has no window
denominator. Its drill-down therefore opens on an all-time list.

### AI-verdict FP rate {#false-positive-rate}

The **AI-verdict FP rate** (called False Positive Rate before this release) is the share
of **verdicted** cases in the window that the agent verdicted as false positive:

`AI-verdict FP rate = false-positive verdicts ÷ verdicted cases`

It measures what the AI decided, not what an analyst later confirmed. The denominator
is verdicted cases, not every case in the window, so a window with few verdicts moves
the number a long way on little evidence. Cases closed under an operator "declared
benign" policy are excluded from both the numerator and the denominator, because no
agent verdict exists for them. The tile's help states the sample behind the rate, for
example "43 of 59 verdicted".

Its drill-down shows, beside the AI verdicts, how many of the same cases an analyst
**confirmed as false positive**: graded feedback or an explicit classification by a
person. A model verdict, a disposition derived from it, or a close without a recorded
classification never counts as confirmed. The two figures are different judgements of
the same cases, so they need not match.

### Resolved / Closed

Cases from the window that reached a terminal state (`resolved` or `closed`),
including the ones closed under a "declared benign" rule policy. The drill-down names
who closed them: the agent, an analyst, system routing, or that policy.

### Auto Closed

The cases from the window that the agent closed automatically. **Auto Closed is a
subset of Resolved / Closed, not an independent total**: agent closes, human closes,
and system closes add up to the terminal cases exactly. It is counted over the
agent-worked population only, so "declared benign" policy closes are excluded, and its
share is stated as a percentage of agent-worked closes. An automatic close always comes
from the deterministic auto-close policy, never from the model's verdict alone; see
[Deterministic decisions](../concepts/deterministic-decisions.md).

### Human vs AI

How the window's closed cases were closed, as a share of closed cases (the shares add up
to 100%). Attribution records the **last** decider on a case: an agent-closed case that
a human later acknowledges or re-tags moves into the human share. **System** covers
deterministic routing plus older cases that recorded no decider. Operator "declared
benign" policy closes are excluded entirely. Trend buckets are keyed by case arrival
time, not close time.

## Response timing

Timing metrics use the case creation time, or the detection time when it is known, as
their start. A metric with no eligible samples shows "no samples yet" rather than zero.

### MTTD

**Mean time to detect**: from the cluster's first event to case creation. It shows as
not available when no case carries a first-event time.

### Respond

The Overview **Respond** figure, in the **Response time** card beside MTTD, is the
first **human** response: the first time an
analyst acknowledged the case, assigned it, or moved it to investigating, escalated, or
on hold. An automatic close is never counted as a human response. It is the same clock
as MTTA, not time to resolve.

### MTTA

**Mean time to acknowledge**, reported as the median (p50) time from case creation to
the first analyst acknowledgement, that is, the case entering investigating, escalated,
or on hold. An automatic close is not an acknowledgement.

### MTTR

**Mean time to resolve**, reported as the median (p50) time from case creation to the
first terminal transition (resolved or closed).

### Dwell

The median (p50) time from case creation to the first active response (investigating,
escalated, on hold, resolved, or closed). Dwell is time to first response, not time to
detect.

### SLA attainment

The share of SLA-scored cases in the window that met their response and resolution
targets (set under **Settings → General → SLA, priority & suppression**). A case is
scored when its priority, as shown on the case, has a configured target and it has a
readable creation time. When no case in the window could be scored, attainment shows an
em dash with the reason, for example "3 cases have no priority with an SLA target, so
attainment was not measured", never 0%: 0% would claim that every scored case breached.

## Noise reduction funnel

The **Noise Reduction** funnel shows how raw alert volume becomes a small number of
cases. Alerts, clusters, and cases are different units, so read each stage's count and
its share of the stage it came from.

| Stage | Meaning |
| --- | --- |
| Alerts ingested | Every raw alert pulled from your connected sources, before any triage |
| After clustering | Related alerts grouped into deduplicated clusters by the correlation engine |
| Awaiting review | Clusters that were risk-scored but kept below the auto-investigate floor; seen and tracked as $0 candidates, not yet reasoned over by the AI |
| Cases opened | Clusters the agent promoted into investigable cases |
| Auto-cleared by AI | Cases the agent auto-closed as false positives under the auto-close policy |
| Escalated | Every opened case not auto-cleared, including analyst-owned, needs-human, and confirmed cases |
| Closed by human | Cases an analyst drove to a terminal state; a subset of Escalated, not a third split |
| Closed by analyst policy | Cases closed by an operator "declared benign" declaration, with no model call; excluded from agent performance |

Alerts ingested and After clustering come from durable hourly counters kept for 90 days.
A window, or a trend bucket, that ends before the counters began or lies beyond their
retention shows those two stages as not measured (never 0), and no overall reduction is
given. A window the counters cover only in part says from when they count.

Auto-cleared, analyst-policy closes, and Escalated partition the opened cases. The
funnel does not mean every raw event received a model call: deterministic processing
handles the broad event stream before a smaller set is admitted to investigation. See
[Analytics](analytics.md#noise-reduction) for the drill-down rules.

## LLM spend

AI spend comes from the usage ledger, which records every model call with its tokens
and an estimated price. The **Cost** page breaks it down by model, role, surface, case,
and time. By default a daily budget of **$10** applies, with a warning at 80% and
`on_exceed: block`: past the limit, new investigations route to a human instead of
calling a model. Workspace and Case Manager chat are outside this budget, daily and
monthly: their spend is recorded in the ledger and shown on the Cost page, but it does
not count against the budget and chat is never paused by it. An administrator can set a
separate daily chat spending limit instead; it is chat's only spending limit. Prices are estimates from the model catalog or an operator
override; they do not replace the provider invoice. See
[Models and spend](../administration/models-spend.md).

## Related pages

- [Analyst overview](overview.md)
- [Analytics and standup](analytics.md)
- [Terminology](../concepts/terminology.md)
