# Round 16 research: explainability audit ("every number explainable")

Report key: `explainability`. Repository: `/home/user/Kavach-AgenticSOC`, branch `claude/round16`
(HEAD `3cd362c`, "Journal: Round 16 start", on top of the Round 15 merge). Work was read-only: no
file in the repository was edited. Commands run: `grep`/`sed` reads, and a few one-off Python calls
into the real pure functions (`compute_risk`, `compute_routing_risk`, `derive_triage`,
`_decision_span`, `wilson_interval`, `wilson_lower_bound`, `percentile`) through `backend/.venv`
to get exact worked numbers and to reproduce two defects.

## 1. Summary

The operator's requirement is: hover a number for a short explanation, click it for the exact
inputs and the arithmetic, so the reader can cross-verify. Today the Console has good pieces,
but they are scattered, partial, and sometimes contradict each other:

* **Risk score** (seen on every queue row, rail and timeline) has the best coverage: a factor
  disclosure in the facts rail (`SignalProfile.tsx`) and a weighted-sum table in the Timeline's
  "Risk assigned" stage (`StageTimeline.tsx` `RiskDerivation`, fed by
  `routes_triage._risk_calculation`). But the raw inputs (event count, observed span, events per
  minute, rule-type count, reputation provenance, asset policy match) and the weights in force at
  scoring time are **not recorded**, so the per-factor math (`100 x ln(1+count) / ln(51)` and so
  on) cannot be shown, and the weighted table uses **today's** weights. The rail's factor
  tooltips honestly say "this view does not retain the exact observed span".
* **Priority, impact, urgency, severity**: the API already returns every input
  (`GET /api/cases/{id}/triage`, `engine/priority.derive_triage`), but the Console shows only
  the band words. A risk-81 case on an uncatalogued asset reads **P3**, which looks wrong until
  you see `matrix["low/high"] = P3`. Nothing on screen says so.
* **Decision card** re-runs `decide()` at read time with the **current** policy and presents
  that as the recorded decision, including a freshly computed objection window. Reproduced: an
  analyst-closed case is reported as "decided by agent" with an objection window expiring
  tomorrow (section 4, D1).
* **SLA**: the Console computes per-case SLA in the browser from `acknowledged_at` only, which
  production writes only on the Acknowledge action. Escalate, Put on hold and Set status leave
  the Console on the Response clock ("Response overdue") while the server's SLA metric counts the
  response as met (D2).
* **Dashboards and Overview KPI tiles** are well explained in words (help text, drill-down
  panel, trend hover). What is missing is the literal arithmetic with the real counts, the
  sample counts and percentiles for MTTA/MTTR/dwell, and per-case samples to cross-check a
  median.
* **Statistics** (Wilson intervals, agreement rates) are computed by three duplicate Wilson
  functions and three different "agreement" definitions; the Console states none of the
  formulas, and one Tuning path fabricates FP/TP counts from a Wilson lower bound (D6).

Recommendation in one line: build one lazy `Explain` primitive (hover = one-line formula with the
real numbers; click = full breakdown with inputs, weights, caps, rounding, provenance and a link to
the source records), feed it from **recorded** inputs produced by the same pure functions that
compute the numbers (never a parallel re-implementation), and fix the eight drift defects in
section 4 first, because an explanation that disagrees with the number it explains is worse than
none. `decide()` and `compute_risk()` keep their behaviour exactly: `decide()` is not touched at all,
and `compute_risk()` keeps every output value byte-identical while gaining an additive `inputs`
record built from the same intermediate variables.

## 2. Inventory of every number the Console shows

Frequency rank: A = every queue row or every case view; B = every Overview or Dashboard visit;
C = Analytics, Effectiveness, Cost; D = specialist pages. "Inputs in API" means the response
already carries enough to reproduce the number exactly.

### 2.1 Case-level numbers (rank A)

| Number | Where shown | Backend computation | Inputs in API today | Console explains today | Gap |
|---|---|---|---|---|---|
| Risk score 0 to 100 | Queue row "Risk N" (`CaseManager.tsx:378`), Cases list `RiskBadge`, hover card, facts rail meter (`SignalProfile.tsx:312`), Timeline stage, decision card | `engine/risk.py:77 compute_risk` (weighted mean of 5 factors), persisted as `Case.risk_score` and `Case.risk_breakdown` | Factor values (2 dp) and total. Not: count used, span, rate, rule-type count, reputation provenance, asset match, weights at scoring time, refs | Rail: factor bars + definitions; Timeline: weighted table with **current** weights and a warning when they no longer reproduce the score | No per-factor math, no scoring-time weights, row has no hover, three different rounding/banding rules (D4) |
| Risk factor values (volume, velocity, reputation, diversity, asset) | Rail disclosure, Timeline table | Same function, `_log_norm`, velocity rule (`count >= 3`, window floor 1 s), clamp, `/5` | Factor values only | Definitions + "this case" sentence, which pairs the merged member-event count with a factor computed from the latest cluster only (D5) | Raw inputs not recorded |
| Risk band (critical/high/medium/low) | Row colour, meter tone, badge variant | Console `palette.scoreBand` 74/48/22; backend `priority._band_from_magnitude` (3 bands, no critical) for `triage.risk.band` | Score only | Legend in Active Risk Index help only | Backend chip says "high" for 81.11 while Console says critical (D7) |
| Routing risk (the score the auto-investigate gate used) | Not shown | `risk.py:122 compute_routing_risk` (normalised over available signals), compared with `auto_investigate_risk_floor` in `engine/ingest.py:375` and `engine/forwarding.py:261` | No | Forwarding explainer exists (`/cases/{id}/forwarding`) | Value at gate time not stored |
| AI confidence | Header `AiVerdictChip`, rail Outcome AI line, Cases column, decision card, verdict history | Model self-report clamped to 0..1 (`agents/common.py` `_clamp01`) | Yes | Rail shows "Auto-close bar 85%" (`FactsRail.tsx:129 autoCloseBarLine`) | Bar line names the confidence bar only; `decide()` also needs `risk <= max_risk_score`, so a 97% case routed to a human for risk 45 > 30 reads as if it should have closed (D8) |
| Decision (closed / routed, decided by, objection window) | Decision card (`DecisionCard.tsx:113`) | `case_manager.decide()` at decision time; recorded in `status_history.reason`, `history[]` and the DECISION audit row (`pipeline.py:1239`) | Recorded rationale string yes; recorded thresholds no (only inside the rationale string) | Card prefers a **read-time** `decide()` re-run (`routes_triage.py:393 _decision_span`) | D1 |
| Severity band and provenance | Header badge, row rail colour, rail "Severity" | `priority.py:265 severity_band_from_events`: `min(100, raw / scale_max x 100)` on `trigger_reason.severity_max`, else derived from risk; 5 bands 74/48/22/8 | Yes (`triage.severity`: raw, value, scale_max, source) | Provenance icon; "Severity versus risk" note when they disagree | No popover with raw, ceiling and projection |
| Impact band | Rail | `priority.py:366 impact_band` from `risk._asset_criticality` | Yes (value, entity) | Word only | No "why low" |
| Urgency band | Rail | `priority.py:384 urgency_band`: risk bands 48/22, forced high when escalated | Yes | Word only | No "why high" |
| Priority P1..P4 | Rail, Standup, SLA label | `priority.py:400 derive_priority`: `matrix[impact/urgency]`, default when unmapped, none when matrix off | Yes (impact, urgency, matched, enabled, default) | Word only; rail falls back to `default` when `level` is null (`FactsRail.tsx:234`) | Shows "P3" while the matrix is disabled (D9) |
| SLA due / overdue | Header meta, rail "SLA (P2)" | Console-only `caseFacts.ts:153 slaReading` | Policy + case fields | Phrase only | Wrong clock after Escalate / Set status (D2); disagrees with server `metrics.sla_metrics` |
| Case clocks (detected, opened, acknowledged, first response, closed) | Rail "Times" | Case fields | `detected_at` and `first_response_at` are never written in production; `first_seen_millis` (the real first-event instant) is never shown on a case | Relative ages with absolute tooltip | Per-case MTTD invisible |
| Correlation trigger (n, window, observed count) | "Why this fired", cluster diagram | `engine/correlation.py`, `TriggerReason` | Yes | Sentence | Fine; add to Explain for the risk volume input |
| Runbook progress ("3 of 7") | Runbook rail and tab | `engine/runbook_runs.py:426 run_progress`, `:447 case_progress` | Yes | Counts | Small: say Not applicable and blocked are excluded from Done |
| Investigation cost | Rail Record (cost:view) | Sum of the case's `UsageDoc.cost` (`llm/pricing.py:384 cost_for`) | Total only | Amount only | No per-call math; unit prices not recorded on the row |
| Auto-close review selection | Review card | `auto_close_review.py:205 select_for_review` (score < rate, day cap, rule cap); numbers recorded in `SampleDecision` and audit | In audit only | "Selected for review" line | No "why was this case picked" |

### 2.2 Overview and Dashboards (rank B)

| Number | Backend | Inputs in API | Explained today | Gap |
|---|---|---|---|---|
| Total cases, Total critical, Open cases, Resolved or closed, Auto-closed | `routes_metrics` posture and breakdown, exact store counts | Yes, with window coverage and bound flags | Strong: help text, bound marks (`>=`), drill-down panel (`KpiDrilldownPanel.tsx`), trend hover (`MetricHoverTrend.tsx`) | Add arithmetic line ("312 of 1,204 = 25.9%") where a share is shown |
| AI-verdict FP rate | Posture | fp and verdicted counts (tile context shows them) | Good | Show "fp / verdicted = rate" in the popover |
| Active Risk Index | `metrics.py:347` mean of `risk_score` over non-terminal cases of the analysed population | Index and count only | Help text with ladder | Sum, count, top contributors, and the "newest N analysed" truncation are not in the popover |
| MTTD, MTTA, MTTR, dwell (p50) | `metrics.py:564 lifecycle_intervals`, `_stat_block` (p50, p90, mean, max, count) | Stat blocks yes; per-case samples no | Formula help (`posture.format.ts`, `widgets/lifecycle.tsx:53`) | No sample count on hover, no sample list to verify a median; MTTR mixes AI auto-closes (seconds) with human resolutions; dwell help omits "by a person" |
| Respond (Overview) | `timing_trend` ACK clock | Yes | Help | Same as MTTA |
| Noise reduction / Alert reduction | `engine/noise_counters.build_noise_reduction` | Yes | Strong: formula popover and "N alerts became M cases" (`NoiseFunnel.tsx:2404`) | Add the arithmetic with numbers ("1 - 312 / 48,210 = 99.35%") |
| Events / min, Triaged 24h, Silent | `routes_metrics._events_per_min`, sources coverage | Yes | Labels | Popover with numerator, minutes and source list |
| Severity breakdown, top rules | `GET /api/metrics/breakdown` | Yes (exact or bound flags) | Bound captions | Fine |
| LLM spend tile | Usage summary | Yes | Label | Add per-tier split and estimated-row count |

### 2.3 Analytics, Effectiveness, Cost (rank C)

| Number | Backend | Gap |
|---|---|---|
| Metrics page "MTTR" | `metrics.py:356` coarse mean of `updated_at - created_at` over status `closed` only | Same label as the Overview MTTR but a different definition: mean not median, excludes `resolved`, and `updated_at` moves on later edits (comment, tag, review grade). D3 |
| Metrics page "Agreement rate" | `metrics.py:128 feedback_stats`: `(agree + 0.5 x partial) / agreement_signals`, every grade entry | Tile context says "N graded" (cases) while the denominator is grade entries with an assessment; returns `0.0`, not `None`, when there are no entries at all. D10 |
| Metrics page "Average risk" | `compute_metrics` mean over all analysed cases | Needs "sum / count" and truncation note |
| Effectiveness "Analyst-reported agreement", "Material correction rate" with Wilson interval | `agent_improvement.py:212 _quality_summary`, `:196 _wilson` | Latest grade per case (different population from the Metrics tile); partial counts 0.5; formula not shown |
| Auto-close review agreement and 95% interval | `auto_close_review.py:280 wilson_interval`, `:318 review_metrics` | Shows rate, interval and "27 of 30 agreed"; formula not shown; no partial weighting here (third definition) |
| Cost KPIs: Total, Tokens, Calls, Today, Per call, Per 1K tokens, Tokens per call | `usage_store.summary`; client-side ratios in `Cost.tsx` | No help on any tile (`Cost.tsx:696` to `:750`); no per-call price basis |

### 2.4 Specialist pages (rank D)

| Number | Backend | Gap |
|---|---|---|
| Team activity counts, median time to acknowledge, review medians | `engine/team_activity.py` (`acknowledgement_seconds`, `_median`) | Explained in page help; add population ("cases a person moved into Investigating, Escalated or On hold in the window") and sample count to the hover |
| Threshold tuning conservative FP rate | `threshold_tuner.py:158 wilson_lower_bound`, min samples, EWMA | Good prose; Tuning fabricates counts in one path (D6) |
| Standup "ranked by urgency" | `shift_report.py:108 urgency_score = 0.5 x risk/100 + 0.25 x severity weight + 0.2 x min(age/target, 1.5) + bumps` | Score and terms never shown; "why is this first" unanswerable |
| Campaign membership and severity roll-up | `campaigns.py:279 build_campaigns` (shared time-bucketed entity edges), `:214 _rollup_severity` (max band) | Campaign stores binding entities but not which cases share which entity |
| Baseline modified z | `baseline.py:468 modified_z = 0.6745 x (x - median) / MAD`, MAD = `max(median - p25, p75 - median)` | Baseline page shows warm-up only; an anomaly-born case records `detection_source=anomaly` but not the M value, value, median or threshold (the candidate carries it, `event_detection.py:575`, the case does not) |
| MITRE coverage % | `engine/mitre_coverage.py` | Add "techniques seen / techniques in tactic" |
| Sources coverage | `/api/sources/coverage` | Fine |

## 3. Worked example: what "risk 81" should explain

Computed with the real `compute_risk` and `derive_triage` on default preferences plus
`asset_criticality = {"10.0.4.12": 60}`: entity IP `10.0.4.12`, 40 events, first to last event
120 s apart, 3 distinct rules, enrichment reputation 75.

Hover (one line, plain text):

> Risk 81.11 = (0.25 x 94.45 + 0.20 x 100 + 0.30 x 75 + 0.15 x 60 + 0.10 x 60) / 1.00. Click for inputs.

Click (panel):

| Factor | Input (recorded at scoring) | Formula | Factor | Weight | Points |
|---|---|---|---|---|---|
| Volume | 40 events in the scoring cluster | `min(100, 100 x ln(1 + 40) / ln(1 + 50))` | 94.45 | 0.25 | 23.61 |
| Velocity | 40 events over 120 s (floor 1 s) = 20.0 per minute | `min(100, 100 x 20.0 / 10)`; 0 when fewer than 3 events | 100.00 (capped from 200) | 0.20 | 20.00 |
| Reputation | 75 from enrichment (IP entity, enrichment on) | clamp 0..100 | 75.00 | 0.30 | 22.50 |
| Diversity | 3 distinct rule types | `min(100, 100 x 3 / 5)` | 60.00 | 0.15 | 9.00 |
| Asset criticality | 60, exact entry for this entity | clamp 0..100 | 60.00 | 0.10 | 6.00 |
| **Total** | | `sum(points) / sum(weights) = 81.11 / 1.00` | | 1.00 | **81.11** |

Rounding and band line: "Stored as 81.11 (2 decimals; factors shown rounded, the total uses
unrounded factors, so a hand sum can differ by at most 0.01). Shown as 81. Band Critical (74 to
100)." Provenance line: "Weights and inputs recorded when this case was scored on <time>, build
<version>." When `inputs` is absent (cases scored before this change, demo cases whose factors are
synthesised by `demo_generator._demo_risk_breakdown`): "Inputs were not recorded for this case;
the table uses today's weights", which is what `RiskDerivation` already says honestly.

Side facts the same panel should state, because they explain the neighbours:

* Routing risk for the same cluster, before enrichment (`compute_routing_risk`, reputation
  unknown and excluded): `(23.61 + 20 + 9 + 6) / 0.70 = 83.73`, compared with the
  auto-investigate floor 70. Shown only when the gate applied.
* Priority: impact `high` (asset 60 >= 48) x urgency `high` (risk 81.11 >= 48) =
  `matrix["high/high"] = P1`. The same case on an uncatalogued IP reads impact `low`, so
  `matrix["low/high"] = P3` (verified with `derive_triage`). This is the single most surprising
  number in the rail and needs the one-line explanation most.
* Severity when the source asserted none: derived from risk 81.11 on the 74/48/22/8 ladder =
  Critical, provenance "derived".

## 4. Defects found (explanation and number disagree, or the number is wrong)

Each was confirmed by reading the code; D1 and the P3 example were reproduced by calling the real
functions.

**D1. Decision card reports a read-time re-run of `decide()` as the recorded decision (high).**
`routes_triage.py:393 _decision_span` calls `decide()` with `state.prefs.auto_close` (today's
policy, and the live policy even in Demo Mode where cases were decided under the sandbox copy) and
the case's current confidence and risk, then returns `decision_status`, `decision_by` and
`objection_window_expires_at` (which `decide()` computes as now plus the window). `DecisionCard.tsx`
lines 118 to 135 prefer those span values over the case's own `status`, `decision_by` and
`objection_window_expires_at`. Reproduction (defaults, FP min confidence 0.85, max risk 30):
a case with verdict FALSE_POSITIVE, confidence 0.97, risk 20, `status=closed`,
`decision_by=analyst` yields `closed agent 2026-11-25T19:45Z` and the rationale "FALSE_POSITIVE
auto-closed ... objection window 1440m". So an analyst's close reads as an AI auto-close with an
objection window that is always one day in the future; a case routed to a human under a stricter
old policy reads as auto-closed after the policy is loosened. The rationale text shown below it is
the recorded one (`engine/case_rationale.py`), so the card contradicts itself.
Fix: the span reports the recorded decision (latest `history` entry with `event == "decision"`,
the case's `objection_window_expires_at`, and the recorded gate from D-API-2), and adds a separate
`current_policy` block plus `policy_changed: bool` when today's policy would decide differently.
Test: pytest for the reproduction above (span must say analyst and no new window); a policy
change test; vitest that the card renders the recorded decider and the stored window.

**D2. Per-case SLA clock ignores every acknowledgement except the Acknowledge action (high).**
`caseFacts.ts:153 slaReading` treats a case as acknowledged only when `acknowledged_at` or
`first_response_at` is set. `acknowledged_at` is written only by the `acknowledge` action
(`api/routes.py:7615`); `first_response_at` is never written in production. The server's
`metrics.sla_metrics` and `lifecycle_intervals` count a human move into Investigating, Escalated or
On hold from `status_history` (`_CaseTimings`). Result: after Escalate or Set status, the header and
rail keep saying "Response overdue by 2h" while the posture SLA attainment counts the response as
met. Fix in section 6, D-API-3 (server-side per-case SLA reading from the same `_CaseTimings`).

**D3. Two different "MTTR"s under one label (medium).** Analytics, Operational shows
`compute_metrics.mttr_minutes` (`metrics.py:356`): mean of `updated_at - created_at` for status
`closed` only (`Metrics.tsx:600`, help "creation to its last update"). Overview and Posture show
`lifecycle_intervals.mttr_minutes.p50`: median of created to first terminal transition for
`resolved` or `closed`. A comment or a review grade on a closed case moves `updated_at` and so the
Analytics MTTR. Both also mix AI auto-closes (seconds) with human resolutions. Fix: Analytics reads
the lifecycle block (p50 with p90, mean and count in the Explain panel), the legacy field stays on
the wire for one release, and `lifecycle_intervals` adds an additive `mttr_by_decider`
(`agent`, `analyst`, `analyst_policy`, `system`) split so the panel can say "of 214 resolved, 180
were closed by the AI (median 0.4 min) and 34 by a person (median 3h 12m)".

**D4. Three rounding and banding rules for one risk score (medium).** Python `round()` is
round-half-to-even and JavaScript `Math.round` is half-up: `round(80.5) = 80` versus
`Math.round(80.5) = 81` (checked). The Timeline headline and `displayed_score`
(`routes_triage.py:581` and `:701`) use Python; the badge, row and meter use JavaScript. Banding
also differs: the queue row and `RiskBadge` band the rounded integer (`riskValue` then
`scoreBand`), the rail meter bands the raw value (`SignalProfile.tsx`, `scoreBand(riskVal)`), and
the backend's derived severity bands the raw value. A 73.6 case is "Risk 74" painted critical in
the queue and "74/100" painted high in the rail, beside a derived severity of High. Fix: one rule,
round half up to an integer for display (`floor(x + 0.5)`) on both sides, and band the displayed
integer everywhere (the published ranges in `palette.SCORE_BANDS` are integer ranges, 48 to 73
and 74 to 100). Backend helper `app/utils.round_half_up`; Console helper in `lib/format.ts`. This is
advisory presentation only and does not touch `decide()`, which compares the unrounded score.
Test: a shared contract file (section 5.4) with 80.5, 73.5, 73.6, 47.5, 21.5.

**D5. "This case" factor sentence pairs two different populations (medium).**
`SignalProfile.tsx:146 riskFactorCaseReason` says "The case records N correlated events; its
stored Volume factor is X/100", with N from `member_event_keys` (the union across every poll that
touched the case, `pipeline._merge_event_keys`). But Volume is computed from `cluster.count`, the
newest correlation cluster only (`pipeline.py:942`, `:1564`). After three polls of 10 events the
case shows 30 events next to a factor that corresponds to 10 (`100 x ln 11 / ln 51 = 61.0`, whereas
30 would give 87.3). An operator who checks the formula finds a mismatch. Diversity has the same
issue (rule list union versus `cluster.rule_values`). Fix: record the scoring inputs (D-API-1) and
word the sentence from them ("Scored on 10 events from the latest correlation window; the case
holds 30 events in total").

**D6. Tuning fabricates confirmed counts from a Wilson lower bound (low).** `Tuning.tsx:622` to
`:628`: when a recommendation lacks `confirmed_false_positives`, the Console sets
`fp = round(fp_rate x samples)`, but `fp_rate` is the Wilson lower bound
(`threshold_tuner.py:1590`). With 14 FP of 20 the bound is 0.481 and the Console shows 10 FP and 10
TP. Current proposals carry the real counts; inert-rule rows (`threshold_tuner.py:1343`) and older
stored recommendations do not. Fix: show "not recorded" instead of a derived count.

**D7. The triage risk chip uses a three-band ladder and stale copy (low).**
`priority.py:456` bands risk with `_band_from_magnitude` (no critical), so `triage.risk.band` is
"high" for 81.11 while every Console surface says critical. The chip's `definition` text and
`riskCopy.RISK_HELP_TEXT` hard-code the default weights (25/20/30/15/10), so they are wrong after
an operator changes `risk_weights`. The Console does not read `triage.risk.band` today, but chat
tools and future callers may. Fix: band with the 4-band score ladder and render weights from
`prefs.risk_weights` (or the recorded snapshot).

**D8. The auto-close bar line states half of the predicate (medium).** `FactsRail.tsx:129
autoCloseBarLine` prints "Auto-close bar 85% · FP auto-close enabled at this bar". `decide()`
closes only when `confidence >= min_confidence AND risk_score <= max_risk_score`. Show both with a
check or cross each, from the recorded gate when present: "Confidence 97% >= 85% (met). Risk 45 <=
30 (not met). Routed to a person."

**D9. Priority shows the default level when the matrix is disabled (low).**
`FactsRail.tsx:234` uses `triage?.priority?.level ?? triage?.priority?.default`. With the matrix off
`derive_priority` returns `level: null` on purpose (Round 5 bug 14), and the rail then shows "P3".
Show "No priority (matrix off)".

**D10. Agreement figures (low).** `feedback_stats` returns `agreement_rate: 0.0` when there are no
entries (its docstring promises `None`); the Metrics tile guards it, other readers may not. The
tile context counts graded cases while the rate's denominator is `agreement_signals` (grade
entries with an assessment). Three agreement definitions exist (all entries with partial = 0.5;
latest per case with partial = 0.5; review sample without partial); each Explain panel must name
its population.

Also noted (low): the triage chips route reads `state.prefs` while the case list and detail band
with `state.execution_prefs` (`routes.py:7166`), so in Demo Mode the rail's priority can be
computed against different preferences than the row's; `awaiting_reason` (why a candidate waits,
for example `deferred:` cap) is never rendered by the Console; `first_seen_millis` is never shown on
a case although it is the per-case MTTD input.

## 5. The reusable Console pattern: `Explain`

### 5.1 Behaviour

* **Hover or keyboard focus** on an explainable value shows a small card with the one-line formula
  using the real numbers (example in section 3). It must meet WCAG 2.2 SC 1.4.13 (dismissible with
  Escape, hoverable, persistent). Radix `HoverCard` (already in `webui/src/ui/hover-card.tsx`)
  meets hoverable and persistent; add Escape dismissal.
* **Click, Enter or Space** opens a Popover (focusable, so it can hold a link and a copy button)
  with the full breakdown: Result; Formula; Inputs table (name, value, unit, where it came from);
  Steps (each arithmetic line); Caps, floors and rounding; Provenance ("recorded at scoring time,
  build v0.1.13" or "reconstructed with today's settings"); Population and caveats (bounds,
  truncation, exclusions); Actions ("Open the records" deep link, "Copy calculation" as text).
  Touch devices get the Popover on tap, because a tooltip never opens on touch (the existing
  `HelpTip.alwaysPopover` comment records the same lesson).
* **Long breakdowns** (a median over 214 cases, per-call cost lines) add "Show all N" opening a
  side Sheet with a sortable table (reuse `DataTable`).
* **Inside a row button** (the Case Manager queue row is one `<button>` with roving focus), a nested
  interactive trigger would be invalid. Rows get no trigger: their accessible name already carries
  "risk 81", and the same `Explain` sits on the value in the facts rail one click away. Optionally a
  pointer-only `title` with the hover line. The APG tooltip pattern keeps tooltips non-focusable
  and sends interactive content to a dialog or popover pattern (see references).
* **Visual affordance**: a dotted underline in `text-muted-foreground` on hover and a focus ring,
  no extra icon on dense surfaces, so the numbers stay clean ("not shown outright"). Keep `HelpTip`
  for definitions of labels; `Explain` is for values.

### 5.2 Where it lives

* `webui/src/design-system/explain/Explain.tsx` (component), exported through a **separate**
  entry, not the `@/design-system` barrel, and imported only from lazy route chunks (case detail,
  Overview, Analytics). The entry chunk is 329,093 B against a 330,104 B budget
  (`bundle-first-paint.test.ts:185`, baseline 329,080 B + 1,024 B), about 1 KB of headroom.
* `webui/src/lib/explain/` pure builders, one per metric: `explainRisk(case, chips)`,
  `explainPriority(chips)`, `explainSeverity(chips)`, `explainSla(slaReading)`,
  `explainDecision(span)`, `explainShare(num, den)`, `explainPercentile(block, samples?)`,
  `explainWilson(successes, n, z)`, `explainCost(rows)`. Builders return a typed `Explanation`;
  the component only renders it. Every value is a text node (#9): entity values, rule names and
  CIDRs are never markup.

### 5.3 Data contract

```ts
interface Explanation {
  metric: string;              // "risk_score", "priority", "mttr_p50" ...
  value: number | string | null;
  display: string;             // exactly what the trigger shows
  summary: string;             // the hover line, with numbers
  formula: string;             // symbolic, e.g. "sum(w_i x f_i) / sum(w_i)"
  inputs: Array<{ key: string; label: string; value: string; source: string }>;
  steps: Array<{ label: string; expression: string; result: string }>;
  rounding?: string;           // "half up to integer"
  provenance: 'recorded' | 'reconstructed_current' | 'server_computed' | 'not_recorded';
  caveats: string[];           // bounds, truncation, exclusions
  link?: { label: string; route: string; params: Record<string, string> };
}
```

### 5.4 One rule for drift: a shared contract file

There is precedent for cross-language contract files (`webui/src/soc/components/ask-ai.contract.json`,
`webui/src/soc/dashboard/widget-types.contract.json`). Add `webui/src/lib/explain/explain.contract.json`
with input vectors and expected outputs for: rounding and banding (80.5, 73.5, 73.6), the risk
formula (the section 3 vector and edge cases: count 2, span 0, zero weights), Wilson (27/30 gives
0.7438 to 0.9654; 14/20 lower bound 0.4810), percentile (4, 9, 31, 62 gives p50 20.0 and p90 52.7),
priority lookups, and SLA states. A pytest reads it and asserts the backend functions produce the
expected values; a Vitest reads it and asserts the builders print the same numbers. If either side
changes, one suite fails.

## 6. Minimal API additions (each produced by the code path that computes the number)

**D-API-1. `RiskBreakdown.inputs: RiskInputs | None` (additive, default `None`).**
Refactor `engine/risk.py` so the body of `compute_risk` moves into a private
`_risk_terms(cluster, prefs, reputation)` that returns the intermediates it already computes
(`count`, `window_seconds`, effective window, rate, `len(rule_values)`, clamped reputation, asset
value and how it matched, the five weights, `total_weight` and whether the zero-sum fallback
applied, refs 50 / 10.0 / 5). `compute_risk` returns exactly the same six numbers plus `inputs`.
Fields: `event_count`, `span_seconds`, `effective_window_seconds`, `rate_per_minute | null`,
`velocity_rule` (`"below_min_events"` or `"rate"`), `rule_type_count`, `reputation_input`,
`reputation_source` (set by the caller: `enrichment`, `not_ip_entity`, `enrichment_off`,
`not_looked_up` for the candidate and analyst-policy paths at `pipeline.py:1415` and `:1564`),
`asset_value`, `asset_match` (`network`, `exact`, `none`), `asset_cidr` (returned only to callers
holding `settings:read`, otherwise "internal-network policy"), `weights`, `total_weight`,
`refs`, `scored_at`, `inputs_version: 1`. `compute_routing_risk` reuses it and the ingest and
forwarding gates can record `routing_total` and the floor.
Why here: `RiskBreakdown` already travels cluster to case on every path (`pipeline.py:944`,
`:1417`, `:1566`, `:1481`, `:1589`, `:1703`, `:1914`, `case_cluster.py:351`), the ES template maps
`risk_breakdown` as an enabled object (`es/indices.py:81`), and SQL stores JSON, so no new index,
table or migration (#12). The investigator prompt renders named attributes only
(`agents/prompts.py:525`), so prompts stay byte-identical. `_risk_calculation` then prefers the
recorded weights and drops the "current weights" warning for new cases.
Tests: existing `tests/test_risk.py` totals unchanged; a parity grid (itertools product over
count 0..120, span 0..3600 s, reputation, rules 0..7, weights including all-zero) asserting that
re-deriving the total from `inputs` with the documented formula equals `total` within 0.005 and
that `compute_risk(...).model_dump(exclude={"inputs"})` equals the pre-change output; a prompt
snapshot test.

**D-API-2. Record the decision gate on the DECISION audit row.** In `pipeline.py:1239`, after
`apply()` has decided and saved (where `classify_auto_close_gate` already runs), add
`tool_input={"gate": {verdict, confidence, risk_score, class_enabled, min_confidence,
max_risk_score, objection_window_minutes, escalation_confidence, critical_severity, outcome}}`.
Nothing branches on it and `decide()` is untouched (#3); the audit is append-only (#2).
`_decision_span` reads it (and falls back to the recorded rationale for older rows), reports the
recorded decision and adds `current_policy` and `policy_changed`. Fixes D1 and gives D8 its data.
Tests: decision span parity with the recorded gate; older rows without `gate` render "thresholds
not recorded".

**D-API-3. Server-computed per-case SLA reading.** A pure `sla_reading(case, policy, now)` in
`engine/metrics.py` that reuses `_CaseTimings`, `_sla_priority` and the same 80% at-risk fraction as
`sla_metrics`, attached at read time beside `advisory_bands` (`routes.py:6350 _with_advisory_bands`)
as `case.sla = {clock, start_at, anchor ("created" | "acknowledged" | "status_history"),
responded_at, target_minutes, due_at, elapsed_minutes, state, priority, priority_source}`.
The Console's `slaReading` becomes a formatter of this object. Fixes D2. Tests: the same case fed to
`sla_reading` and to `sla_metrics` must agree on breached or not for response and resolution;
escalate-then-read shows the Resolution clock.

**D-API-4. `GET /api/metrics/explain?metric=...&window=...`** for distribution and ratio metrics:
`mtta`, `mttr`, `dwell`, `mttd`, `active_risk_index`, `fp_rate`, `sla_attainment`. Returns the
headline value, the stat block, the population definition, and up to 200 samples
(`case_id`, `case_number`, `start_at`, `end_at`, `minutes`, `anchor`, `decided_by`), sorted, with
`truncated` and the shared population's truncation marker. Computed from the same
`fetch_case_population` and the same `_CaseTimings` and `percentile` code as posture. Permission:
the posture route's, plus object scope (`can_object`) on every sample row. Test: for a seeded
population, the endpoint's p50 equals `metrics_posture`'s p50 for the same window, and its sample
count equals the stat block's count.

**D-API-5 (later). Cost basis on each ledger row.** `UsageDoc.price_basis` (additive):
`input_per_m`, `output_per_m`, `cache_read_per_m`, `cache_write_per_m`, `cache_write_ttl`,
`batch_multiplier`, `overlay_applied`, set in the gateway from the exact values `cost_for` used
(`llm/pricing.py:384`). Still one UsageDoc per call (#6). The Explain panel then prints
`12,345 / 1e6 x $5 + 2,100 / 1e6 x $25 = $0.1142` for each call of a case.

**D-API-6 (later, small).** Shift report rows add `urgency_terms` (`risk`, `severity_weight`,
`age_pressure`, `bumps`) from `urgency_score`; campaigns add `links: [{entity_type, value,
case_ids}]` from `_rollup_entities` (it already holds the ids); anomaly-born cases record
`detection_signal = {modified_z, value, p50, p95, bucket, threshold, warm, n}` from the candidate.

## 7. Prioritised recommendations

| # | What to build (where) | Effort | Value | This round |
|---|---|---|---|---|
| R1 | `Explain` primitive, `Explanation` type, builders and `explain.contract.json` (section 5) | M | high | yes |
| R2 | Recorded risk inputs (D-API-1) and the risk Explain on the rail meter, the Timeline table and the header; fix D5 wording | M | high | yes |
| R3 | Decision card shows the recorded decision; record the gate (D-API-2); fix D1 | M | high | yes |
| R4 | Auto-close predicate line with both conditions (D8) | S | high | yes |
| R5 | Priority, impact, urgency, severity Explain from the existing triage inputs; fix D9 | S | high | yes |
| R6 | Server-side per-case SLA (D-API-3), fix D2; show "First event" from `first_seen_millis` and per-case MTTD in Times | M | high | yes |
| R7 | One rounding and banding rule (D4) | S | medium | yes |
| R8 | `GET /api/metrics/explain` and Explain on MTTA, MTTR, dwell, MTTD, Active Risk Index, FP rate (D-API-4) | M | high | yes |
| R9 | One MTTR definition on Analytics plus the AI versus person split (D3) | S | medium | yes |
| R10 | One Wilson implementation in `engine/stats.py` used by tuner, review and effectiveness; formula in their popovers; fix D6 and D10 | S | medium | yes |
| R11 | Arithmetic lines on Overview tiles that show shares, and on Alert reduction | S | medium | yes |
| R12 | "View all fields" sheet on a case (every stored field as plain text, cost withheld without `cost:view`, `awaiting_reason` and retrieval statuses included) | S | medium | yes |
| R13 | Cost KPI Explain from the existing summary (client arithmetic) | S | medium | yes |
| R14 | `UsageDoc.price_basis` and per-call cost math (D-API-5) | M | medium | no |
| R15 | Standup urgency terms, campaign links, anomaly detection signal (D-API-6) | M | low | no |
| R16 | Triage chip band and copy from live weights; triage route on `execution_prefs` (D7) | S | low | yes |

Details per item:

* **R1.** Files: `webui/src/design-system/explain/Explain.tsx`, `webui/src/lib/explain/*.ts`,
  `explain.contract.json`, `backend/tests/test_explain_contract.py`. Risks: bundle budget (keep out
  of the entry graph; add a first-paint assertion that `explain` is not in the entry chunk), nested
  interactive content in rows (rule in 5.1), screen-reader verbosity (the trigger's accessible name
  is the value plus "Explain"). Tests: Vitest for hover line, click panel, Escape, touch tap,
  focus return; axe through the existing jsx-a11y lint.
* **R2.** Files: `backend/app/engine/risk.py`, `backend/app/models.py` (`RiskInputs`),
  `backend/app/agents/pipeline.py` (reputation source annotation), `backend/app/api/routes_triage.py`
  (`_risk_calculation` prefers recorded weights), `webui/src/soc/pages/casedetail/SignalProfile.tsx`,
  `StageTimeline.tsx`, `webui/src/lib/types.ts` and regenerated `api-types.gen.ts` (`check:types`).
  Risks: ES dynamic mapping of a few new numeric and keyword leaves on existing indices (fixed small
  key set, acceptable); replay fixtures captured before the change load with `inputs=None`.
  Tests: section 6 parity grid; Vitest for "inputs not recorded" fallback.
* **R3.** Files: `pipeline.py` (audit `tool_input.gate`), `routes_triage.py` (`_decision_span`,
  `_policy_clause`), `DecisionCard.tsx`. Risk: `decide()` must not be edited; only its caller's audit
  row changes. Tests: D1 reproduction must fail before and pass after.
* **R4.** File: `FactsRail.tsx` (`autoCloseBarLine` takes `max_risk_score` and the case risk; the
  `FpPolicy` type already carries it). Tests: Vitest for met/met, met/not met, class disabled.
* **R5.** Files: `FactsRail.tsx`, new `lib/explain/priority.ts`. Copy: "P3 = matrix[impact low,
  urgency high]. Impact low: asset criticality 0 for 203.0.113.9 (no asset entry). Urgency high:
  risk 81 >= 48." Tests: Vitest with the `derive_triage` outputs from section 3.
* **R6.** Files: `backend/app/engine/metrics.py`, `backend/app/api/routes.py`
  (`_with_advisory_bands`), `webui/src/soc/pages/casedetail/caseFacts.ts`, `CaseHeaderMeta.tsx`,
  `FactsRail.tsx`. Risk: list endpoints get slightly heavier; the reading is O(status_history).
  Tests: section 6 agreement test.
* **R7.** Files: `backend/app/utils.py`, `routes_triage.py:581` and `:701`, `engine/priority.py`
  band helpers, `webui/src/lib/format.ts`, `caseFacts.ts:80`, `SignalProfile.tsx`, `badges.tsx`.
  Risk: severity filters and counts at exact .5 boundaries move by one band for a few cases; state it
  in the changelog. Tests: contract vectors.
* **R8.** Files: `backend/app/api/routes_metrics.py` (new route), `engine/metrics.py`
  (sample-returning variant of `lifecycle_intervals` that the existing one calls, so both share one
  loop), Overview and lifecycle widget triggers. Risks: object scope, response size (cap 200).
* **R9.** Files: `webui/src/soc/pages/Metrics.tsx:600`, `engine/metrics.py` (`mttr_by_decider`).
* **R10.** Files: `backend/app/engine/stats.py` (new), `threshold_tuner.py:158`,
  `auto_close_review.py:280`, `agent_improvement.py:196`, `Tuning.tsx:622`, `metrics.py:128`.
  Tests: the three old call sites return identical numbers (golden vectors) before and after.
* **R11.** Files: `Overview.tsx` KPI specs (add `explain` beside `help`), `NoiseFunnel.tsx:2420`.
* **R12.** Files: new `casedetail/AllFieldsSheet.tsx`, opened from the rail Record section. Untrusted
  values as text nodes; withhold `token_cost` without `cost:view` (server already nulls it).
* **R13.** File: `Cost.tsx:696` to `:750`: "Per call = $4.12 / 318 calls = $0.0130";
  "Per 1K tokens = $4.12 / 1,204,551 x 1,000 = $0.0034"; count of rows with `usage_estimated` and
  `pricing_source != exact`.
* **R16.** Files: `engine/priority.py:454` (use the score ladder, render weights),
  `webui/src/soc/components/riskCopy.ts`, `routes_triage.py:159` (`state.execution_prefs`).

## 8. Non-negotiables check

* #3: `decide()` is not edited. `compute_risk()` outputs stay identical (tested by excluding
  `inputs` from the comparison). The gate record is written after `apply()`, and nothing reads it
  for a decision. SLA, priority and urgency remain advisory.
* #6: no new model call; `price_basis` is an additive field on the one UsageDoc per call.
* #7, #9: explanations are aggregates of our own numbers; any log-derived value (entity, rule name)
  is rendered as a plain text node; nothing new reaches a prompt.
* #12: no new index or table; all additions are optional fields on existing documents, and the
  explain route is a read.

## 9. External references

* NIST IR 8312, Four Principles of Explainable AI (2021), including "explanation accuracy": an
  explanation should correctly reflect the system's process. This is the reason explanations here
  must come from the same code path, not a re-implementation.
  https://nvlpubs.nist.gov/nistpubs/ir/2021/NIST.IR.8312.pdf and
  https://www.nist.gov/publications/four-principles-explainable-artificial-intelligence
  (the exact wording of the final text was not re-read; summary per NIST's publication page).
* Elastic Security entity risk scoring: a risk score flyout lists contributing alerts with each
  alert's contribution and a Contexts table for non-alert inputs (asset criticality and others).
  https://www.elastic.co/docs/solutions/security/advanced-entity-analytics/entity-risk-scoring and
  https://www.elastic.co/docs/solutions/security/advanced-entity-analytics/view-entity-details
* Google Security Operations Risk Analytics publishes its formula: max finding score plus a
  weighting (default 0.2) times the sum of the remaining finding scores.
  https://docs.cloud.google.com/chronicle/docs/detection/risk-analytics-overview and
  https://docs.cloud.google.com/chronicle/docs/detection/risk-analytics-faq
* Splunk Enterprise Security risk-based alerting: scores are built from risk modifier events on a
  risk object, adjustable by asset and identity priority.
  https://help.splunk.com/en/splunk-enterprise-security-7/risk-based-alerting/7.3/modify-risk/how-risk-modifiers-impact-risk-scores-in-splunk-enterprise-security
* Microsoft Sentinel UEBA investigation priority (0 to 10) combines an entity anomaly score and a
  time series score. https://learn.microsoft.com/azure/sentinel/identify-threats-with-entity-behavior-analytics
  (Microsoft's pages describe the anomaly and priority fields inconsistently; not resolved here.)
* Lundberg and Lee (2017), additive feature attribution (SHAP): for a linear model the additive
  attribution is the model itself, which is why `w_i x f_i / sum(w)` per factor is an exact
  explanation of this risk score rather than an approximation. https://arxiv.org/abs/1705.07874
* WCAG 2.2 SC 1.4.13 Content on Hover or Focus (dismissible, hoverable, persistent).
  https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus
* WAI-ARIA APG tooltip pattern (still marked work in progress); interactive content belongs in a
  dialog or popover, not a tooltip (stated by implementations and the APG issue thread; the APG page
  text itself was not verified). https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/
* Vendor positioning that explainability means an evidence trail, not a single confidence number
  (vendor-sponsored, not independent):
  https://www.prophetsecurity.ai/blog/why-explainability-of-ai-soc-analyst-platforms-is-important

## 10. Journal entry (for the orchestrator to append)

```
### 2026-11-24 00:00Z - research agent (explainability) - Round 16 explainability audit
- Context: Round 16 discovery; operator asks that every number be explainable on hover or click.
- Did: Read-only audit of risk, priority, SLA, decision, metrics, review, tuning, cost and campaign
  numbers across backend/app and webui/src; reproduced the decision-card read-time drift and the
  P3-for-risk-81 case with the real functions; wrote the report at
  scratchpad/round16/research/explainability.md (inventory, 10 defects, Explain pattern, 6 API
  additions, 16 recommendations).
- Tests: none run (read-only); one-off calls to compute_risk, derive_triage, _decision_span,
  wilson_interval, wilson_lower_bound, percentile.
- Status: done.
- Next: SPEC should take R1 to R13 and R16; fix D1, D2, D4, D5 before adding explanations.
```
