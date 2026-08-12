---
title: Analytics and standup
description: Interpret v0.1 posture, timing, noise reduction, ATT&CK coverage, cost, and shift handoff metrics.
---

# Analytics and standup

Open **Analytics → Metrics** for measured posture and **Overview → Standup** for the
current action queue. Analytics are advisory: they describe stored cases and ingest
counters but never feed the case decision policy.

Posture and ATT&CK endpoints require `metrics:view` when RBAC is enabled.

## Timing definitions

Agentic SOC reports distributions, including p50 and p90 where available:

| Metric | v0.1 definition |
|---|---|
| MTTD | First member-event time to case creation |
| MTTA | Case creation to the first human acknowledgement |
| MTTR | Case creation to the first terminal resolved/closed transition |
| Dwell | Case creation to the first human response transition |

MTTA uses a human acknowledgement; an automatic close is not counted as a human
response. Missing eligible samples remain missing rather than being displayed as
zero.

## Posture and quality

The posture response includes lifecycle and verdict mix, aging, backlog, SLA state,
period-over-period comparisons, and analyst feedback coverage. Interpret agreement
rates together with graded-case and feedback counts.

SLA targets and impact × urgency priority are operator-configured advisory policies.
They rank work and measure response; they do not authorize automatic closure.

## Knowledge-reference coverage

The base `GET /api/metrics` response includes `retrieval_history`, an
evidence-qualified case-level measure. Its headline is the share of investigated,
fully instrumented cases with a completed retrieval attempt that have ever recorded at
least one knowledge reference. `knowledge_used` always remains an array for backward
compatibility. Within a Case whose lifetime history is `available`, `[]` is a measured
zero only when `retrieval_observation_status=measured`; `not_measured` and `unavailable`
observations do not enter the denominator.

Interpret this as **reference coverage only**. The Case reference list is cumulative,
de-duplicated, and bounded, so the number is not retrieval quality and not a per-run hit
rate. It does not show whether a reference was correct, useful, or influential.

`retrieval_history_status` is the authoritative lifetime marker. A legacy case remains
`unavailable` after re-investigation because its earlier lifetime cannot be recovered.
Consequently, any mixed instrumented/legacy cohort or any truncated 2,000-case read
keeps `cases_with_references` and `reference_coverage` `null` with `unavailable` status.
A fully instrumented cohort with no `measured` observation reports
`insufficient_evidence`, also with a `null` headline. When at least one observation is
measured, history-complete `not_measured` cases are excluded from the denominator rather
than counted as zero. Missing evidence is never displayed as 0%.

The Console's **Knowledge reference coverage** card follows those API states. It renders
a percentage and numerator only when `available=true` and `reference_coverage` is
numeric. For `unavailable` or `insufficient_evidence`, it renders the server reason and
the instrumented/eligible case counts; it does not substitute 0%, 0 references, or a
success-colored empty state.

## Agent-improvement evidence

The additive `GET /api/metrics/agent-improvement` rollup provides neutral evidence
for evaluating whether agent-assisted triage outcomes are changing. Its default
comparison is the last **seven complete UTC days** against the immediately preceding,
non-overlapping **28 complete UTC days**. It never mixes the partial current day into
either cohort.

The established headline continues to read these three measurements separately:

- **Analyst-reported verdict agreement** weights an analyst's Agree grade as 1 and
  Partial as 0.5, then divides by unique cases carrying one latest valid grade. The
  name is deliberate: v0.1 does not persist an independently verified reviewer
  identity on every historical feedback record.
- **Material analyst correction rate** counts explicit Disagree grades and narrowly
  defined conflicts between the recorded outcome and the AI verdict. Partial is not
  automatically treated as a correction.
- **Human review turnaround** is the median elapsed time from the first human
  acknowledgement to the final human terminal transition in the final live episode.
  Known automation actor labels are excluded. Actor values remain operational labels,
  not independently authenticated identity provenance, and this is not active analyst
  touch time because pause/resume work sessions are not recorded.

Every result includes current and baseline sample counts, minimum-sample status,
daily points, exclusions, and the metric definition. Agreement and correction need
30 eligible cases in both cohorts; turnaround needs 20. A daily point needs five
eligible samples. Missing or undersized evidence remains unavailable or insufficient,
not zero.

Agreement and correction are standardized over the same source-by-severity strata in
both windows; a stratum needs at least five grades in each window. The response
discloses coverage for **both** cohorts without returning their source identifiers. A
headline direction requires at least 80% coverage in each cohort, sufficient samples,
and complete retrieval. Safety guardrails must also be evaluable: false-negative rate
needs 20 confirmed positives per cohort, while reopen rate needs 20 eligible agent
closures per cohort whenever such closures exist. Reopen comparisons use one fixed
24-hour follow-up window. An unavailable guardrail stays unknown rather than silently
passing; a material regression prevents a favorable efficiency shift from promotion.
Agreement and correction are two views over the same graded-case cohort, so the
headline treats them as one quality domain. A favorable headline requires both that
quality domain and the independent review-turnaround domain to improve; correlated
grade movement alone cannot produce an improvement claim. Exclusion counts are scoped
to the same 35-day reporting horizon.

There is intentionally no synthetic improvement score. The aggregate returns no case
IDs, entities, raw evidence, prompts, or model calls, performs no billed model call,
and never participates in deterministic case decisions. It describes observed shifts
and does not prove causation or claim that a model has learned.

### Outcome evidence

The additive outcome layer does not alter that headline. It answers narrower operator
questions with separate measures and explicit evidence states:

| Measure | Definition | What it is not |
|---|---|---|
| Confirmed-positive case rate | confirmed-positive outcome-graded cases / all outcome-graded cases | not true positives / raw alerts, not deployment-wide precision |
| Observed closure elapsed difference | signed case-open-to-terminal elapsed difference for agent-terminal cases compared with the observed human-terminal cohort | not active labor saved, payroll saved, or a universal manual-triage benchmark |
| Recorded case-linked AI processing cost | usage-ledger cost for calls carrying a case link inside the cohort | not employee overtime, unlinked usage, or a provider invoice |
| Ingested versus after clustering | durable raw-ingest and post-clustering counter volumes | not proof that tuning or AI caused the change |

The closure comparison needs eligible agent-terminal and human-terminal cases. When
no human terminal cohort exists, the result is unavailable with that reason; no
placeholder duration is used. A negative aggregate difference is shown as slower
elapsed handling rather than being converted into positive “time saved.” Cost includes
only case-linked usage because allocating
chat, standup, or other unlinked calls to cases would invent a relationship. The
confirmed-positive rate is computed only over recorded case outcomes. Its direction is
descriptive, not inherently good or bad: a lower share could reflect less malicious
activity, a changed source mix, missing review, or worse detection. Read it with
feedback coverage and the false-negative guardrail. Likewise, falling ingress can be a
source outage; validate source health before calling lower downstream volume an
improvement.

The endpoint also returns two complete-period trend views: **week over week** compares
the latest seven complete UTC days with the prior seven, and **rolling 28** compares
the latest 28 complete UTC days with the prior 28. The latter is not a calendar-month
comparison. The cost, closure-time, case-mix, alert-volume, and tuning outcome blocks
are recomputed for the selected equal-length windows rather than reusing the default
7-versus-28 comparison. Each trend can be improving, regressing, stable/no material
change, insufficient, or unavailable independently of the established headline.

True-positive/raw-alert yield is deliberately unavailable: correlation turns many
alerts into fewer cases, so dividing case outcomes by alert counts mixes units. A
future yield needs durable like-for-like alert→case→outcome lineage. The aggregate
effectiveness response likewise does not invent semantic telemetry guidance.
Separately, Auto-tuning exposes a deliberately narrow deterministic recommendation
surface for outbound DNS, endpoint process, and identity-authentication evidence. It
requires a stored, versioned query/tool failure proving a supported field was
unavailable; connector absence and free-form model prose alone never create a
recommendation.

Applied tuning rows are reported as context with `causal_claim=false`. Threshold tuning
can affect downstream clustered, promoted, or opened work; it cannot reduce the alerts
emitted by an upstream source. Compare durable volume and safety evidence around a
change, then investigate other policy, source, and workload changes before attributing
an outcome. This is detection-threshold tuning, not model fine-tuning. Quality metrics
describe the agent's case assessment; volume metrics describe the alert-to-case funnel.
Neither proves the upstream alert generator itself is getting better.

Open **Analytics → Agent effectiveness** for the detailed operator surface. Auto-tuning
reuses this same read-only aggregate beside rule-health and recommendation review. It
adds synchronized daily lanes, durable volume, an evidence/guardrail rail, and
applied-tuning chronology. The daily lanes are raw eligible UTC-day cohorts, while the
period comparisons are source-by-severity mix adjusted; null daily values remain gaps.
Tuning chronology is context only and does not attribute a shift to a change. The
Analytics view remains authoritative for the complete definitions and cohort tables.
The shared `ComparisonMetric` and `MetricDefinition` components keep values and
evidence states consistent between the two surfaces.

## Noise reduction

The noise-reduction view combines durable ingest counts with case outcomes. Its
stages distinguish received alerts, clusters, optional review candidates, cases
requiring attention, automatic clears, escalations, and human closures. Candidates
appear as a side cohort from Clustered rather than as a required step before case
creation. Inspect the per-stage definition and source before comparing percentages.

The aligned count/share rail is authoritative; read the ribbon as directional
lifecycle context rather than deriving an exact value from curve thickness alone.
Auto-cleared and escalated cases partition opened cases; human-closed cases are an
overlapping analyst-owned subset of the escalated cohort even when the restored fan
places all three operational views beside one another. A human closure requires
explicit analyst decision provenance; unknown or agent-owned terminal records are not
credited to people. Outcome drill-downs apply these same definitions to the loaded
selected-window Cases set; when that list is bounded, the aggregate and its coverage
notice remain the complete source of truth.

The funnel is not evidence that every raw event received a model call. Deterministic
processing intentionally handles the broad event stream before a smaller set is
admitted to investigation.

## MITRE ATT&CK coverage

Coverage maps techniques recorded on cases to the bundled Enterprise ATT&CK corpus.
The page provides tactic and technique counts and can export an ATT&CK Navigator
layer. It measures observed case coverage, not preventive-control effectiveness. See
[MITRE and threat context](../intelligence/mitre-threat-context.md).

## Standup and handoff

The Standup report is built from aggregates, never a raw-log dump. It contains:

- urgency-ranked open, escalated, and needs-human cases;
- SLA and aging pressure;
- workload by assignee;
- current-versus-prior deltas; and
- action items and handoff acknowledgements.

Writing action items or acknowledgements requires `cases:write`.

## Cost

Open **Analytics → Cost** to inspect model calls, tokens, price source, outcomes, and
spend by model, role, surface, case, and time. Every model call must pass through this
ledger. A price is an estimate based on the active catalog or operator override; it
does not replace the provider invoice.

See [Analyst overview](overview.md) and [Cases](cases.md).
