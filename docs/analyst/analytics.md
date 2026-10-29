---
title: Analytics and standup
description: Interpret v0.1 posture, timing, noise reduction, ATT&CK coverage, cost, and shift handoff metrics.
---

# Analytics and standup

The **Analytics** group in the navigation opens three pages, each titled by its
navigation label: **Metrics** (`#/metrics`), **Agent effectiveness**
(`#/effectiveness`) and **Cost** (`#/cost`). **Overview → Standup** holds the current
action queue. Analytics are advisory: they describe stored cases and ingest counters but
never feed the case decision policy.

Posture and ATT&CK endpoints require `metrics:view` when RBAC is enabled.

## How the Analytics pages are laid out

Each page follows the Overview's layout. The header holds the title with a help tip,
the time range (last 24 hours, 7 days or 30 days) and one refresh beside it, and on the
right when the figures were last read ("Updated just now"). Below it, every module sits
on the same tinted panel and names its window after its title ("all time", "last 7
days", "now"). A caption always names the range of the figures on screen: while a new
range is being read, and if it cannot be read, the page keeps the previous figures under
their own captions and says which range it shows. The range you pick on one Analytics
page is kept for the others until you reload the page or sign out. The navigation switches between
the pages; there is no second row of page tabs.

**Metrics** has three tabs:

- **Operational**: one strip of summary figures, then the verdict and disposition mix,
  persona usage, runbook usage, knowledge reference coverage, cases per day, analyst
  feedback quality and the LLM spend of the selected range, then a module with the
  knowledge base and memory figures as they are now, beside the corpus by source and
  the memory by author. The case counts cover every case in the store, so their
  captions read "all time"; only the LLM spend follows the time range.
  **Needs human** counts the open cases whose AI verdict is Needs human ("open now"),
  the same figure Standup and the dashboards show: a case an analyst has closed no
  longer waits for a person, so it is not counted.
  **Resolved or closed** and the active count beside it come from the server's own
  split by status, never from the total minus a count. Each bar's percentage is its
  share of the whole ("51% of 77"), and each ranked module has its own **Count** or
  **A to Z** switch. **Runbook usage** shows which Published runbook guided each case's
  investigation, with **No runbook** when none did; it shows usage only and does not
  say a runbook made a case faster.
- **Performance**: lifecycle timing (MTTA and MTTR at p50 against the previous window,
  and Dwell at p50), the percentile table and the triage quality rates.
- **Posture**: open-case aging of the cases opened in the range (queue depth, arrivals,
  closures, the age distribution and the oldest open cases), SLA attainment with the
  cases breaching or close to a target ("5d 15h over", "2h left"), and MITRE ATT&CK
  coverage with the Navigator layer export. A long list shows its first rows with
  **Show all** for the rest; when the server lists only part of a longer list (the 25
  furthest past their target, the 10 oldest open cases), the panel counts the rows not
  shown against the full total and says how many it lists of how many there are. If the
  posture rollup cannot be read, SLA attainment says it is not available, never that
  tracking is off.

Each Metrics tab has its own link, so a reload or a bookmark opens the same tab:
`#/metrics` (Operational), `#/metrics?tab=performance` and `#/metrics?tab=posture`.
Switching tabs does not add a step to the browser's Back history. Older links still
work: `#/metrics?tab=effectiveness` opens Agent effectiveness and `#/metrics?tab=cost`
opens Cost.

## Agent health diagnostics

The complete Agent health surface appears above the observed outcomes on
**Analytics → Agent effectiveness**. It explains resolved-case precedent corpus
availability, migration/retrieval state, and auto-close health for the time range in
the page header. The page's one refresh reads both Agent health and the outcome
evidence again. The loader is keyed to that window, aborts superseded requests, and
rejects mismatched response windows, so a quick range change cannot combine old health
evidence with a new selector.

The two inputs retain independent RBAC boundaries. The diagnostic rollup requires
`settings:read`; auto-close health requires `metrics:view`. If only one is readable,
the panel explains only that evidence. If neither endpoint is readable or supported,
it renders nothing rather than implying “healthy.” Unknown and not-measured states
stay distinct from a detected degradation.

Overview consumes the same shared degradation reducer but shows only a compact warning
when a degradation is positively detected. The full evidence, reasons, remediation,
window, and retry action remain here so Overview does not become a second health page.

### Precedent by rule

A single "analyst-confirmed precedents" total hides two failures, so the panel also
reports how that precedent is spread across detection rules (`settings:read`, from the
same diagnostic rollup).

The first failure is starvation by success: the projection window is bounded, so one
rule's bulk confirmation can crowd out every other rule's precedent. The per-rule
distribution makes that visible before auto-close is affected.

The second is futility. A rule can hold hundreds of analyst-confirmed benign outcomes and
still route every case to a human, because its alerts carry no per-case evidence for an
investigation to verify. Those rules are named explicitly, with the two remedies that can
work: enrich the source so the alerts carry that evidence, or declare the detection
benign with an [analyst rule policy](../automation/rules.md). Confirming more cases of
such a rule will not change the outcome on its own, and the panel says so rather than
leaving the request open-ended.

Precedent recorded before rule identity was captured is reported separately as
unattributed rather than counted as absent; it converges automatically on the next
retrieval projection. An unreadable corpus reports "Unknown", never zero.

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
rates together with graded-case and feedback counts. The agreement rate counts only grades
that compare the analyst's judgement with the AI verdict (agree, partial or disagree). A
grade with nothing to compare (an analyst settling a Needs-human hand-off, a duplicate
close, or a case with no AI verdict) still counts as feedback and in the quality scores,
but not toward agreement; when no grade compares, agreement shows as not measured rather
than 0%.

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
Consequently, any mixed instrumented/legacy cohort or any read truncated at 20,000 cases
(a store holding more cases than that) keeps `cases_with_references` and `reference_coverage` `null` with `unavailable` status.
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

Open **Analytics → Agent effectiveness** for the detailed operator surface. The
**Operational outcomes** panel shows its four headline comparisons as one strip, with
**Week over week** or **Rolling 28 days** in the panel's title row; its caption names
the window ("last 7 complete UTC days against the 7 before"). While the headline is
still collecting evidence, an **Evidence details** panel sits above the strip with a
**Show details** button. The comparisons, the rows behind the operational outcomes
(**What supports these movements**, **Evidence by system layer** and the **Trend
check**), evidence quality and daily evidence fold behind it, so the page does not open
on a list of rows that are all still collecting; the strip itself stays. Everything the
button shows opens below it. Its sentence names the operational rows as still collecting
only when a comparison on the strip is. The safety guardrails fold with them only while
neither can be evaluated: a guardrail with enough data, and above all a breached one,
always stays on the page. **Evidence coverage** closes the page with telemetry
suggestions, which are suggestions, not diagnosis. Auto-tuning
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

- urgency-ranked open, escalated, and awaiting-analyst cases;
- SLA and aging pressure;
- workload by assignee;
- current-versus-prior deltas; and
- action items and handoff acknowledgements.

The page header holds the handoff range (the last 24 hours or 7 days) and one refresh,
and on the right the shift, when the snapshot was generated and **Copy summary**. The
strip compares the shift's headline counts with the window before. The attention queue
shows its first eight cases, SLA pressure its first six breaches and the sign-off its
first eight acknowledgements, each with **Show all** for the rest, and each SLA breach
says how far past its target the case is ("12d 22h over"). **Open posture** links to
Metrics, Posture for people who can view Metrics. The "Generated" time stays current
while the page is open, and a failed write to the action items or the sign-off says so
beside the form. If the report for a newly picked range cannot be read, the previous
report stays and the error names both ranges ("Could not load the last 7 days; showing
the last 24 hours").

Its figures are the ones chat's shift report shows for the same window. **Needs human**
counts the open cases whose AI verdict is Needs human. **Awaiting analyst** counts the open
cases still in the status the console shows as **Open · awaiting analyst**, the cases the
automation routed to a person that no one has picked up; the workload list shows that
count per assignee as "N awaiting".

Writing action items or acknowledgements requires `cases:write`.

## Cost

Open **Analytics → Cost** to inspect model calls, tokens, the execution tier each call
ran on, spend over time, a breakdown by model, role and surface (ranked by cost, tokens
or calls), the detailed ledger with its cost composition, and the top cost drivers. Every
tile and module names the range it covers, except **Today**. **Spend over time** places
the ledger's hourly spend on the range's own time axis, hour by hour for the last 24
hours and day by day for longer ranges, with the hours that had no spend counted as
zero; the change on **Total cost** compares the second half of the range with the first.
**Per hour** and **Per day** divide the range total by the hours or days of the range
itself, so a 7-day range reads per day over 7 days, not over the 8 calendar days it
touches.
Every model call must pass through this ledger. A price is an estimate based on the active catalog or operator override; it
does not replace the provider invoice.

See [Analyst overview](overview.md), [Cases](cases.md), and
[Background jobs](../operations/background-jobs.md).
