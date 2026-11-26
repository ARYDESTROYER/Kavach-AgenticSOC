---
title: Explainable numbers
description: How to read the hover line and the calculation panel behind a number in Agentic SOC 0.2, with the risk score math and a worked example, the auto-close decision, SLA clocks, rounding, Copy calculation, and what "not recorded" means.
---

# Explainable numbers

Most numbers in the Console can show how they were calculated. Point at a number to see
a one-line formula with the real numbers. Click it to see the whole calculation: the
inputs and where each one came from, every arithmetic step, how the result was rounded,
and whether the inputs were recorded when the number was computed.

Every calculation an explanation prints gives the result it prints. An explanation only
describes a number. It never changes a case, a score or a decision.
The automatic close or escalate decision is still made by code against the auto-close
policy (see [Deterministic decisions](../concepts/deterministic-decisions.md)).

## Where to see a calculation

On a case:

- the **Risk** chip in the case header and the risk meter in the case facts' **Signal**
  section;
- the **AI verdict** chip, which shows how the code decided;
- the **severity**, the **priority** and the **SLA** phrase;
- the investigation cost in the case facts' **Record** section, which opens every AI
  call on the case with its own rates.

In the Case Manager queue, the risk number in each row shows its formula when the mouse
rests on it. The row stays one control: the line has no buttons, and a screen reader
hears the number in the row's name. Open the case for the full calculation.

On the **Cyber Defence Center** and on a dashboard, the KPI figures and the cells of a KPI
strip show their formula on hover. On **Analytics**, many figures do, such as MTTR, the
agreement rate, the FP rate, Average risk, Incident yield, Escalation rate, Containment
and the Posture SLA strip. The response times (MTTD, Respond, MTTA, MTTR and dwell) also
read the cases behind the median. The **Cost** page explains its totals the same way, and
**Team activity** explains its median time to acknowledge.

On the **Noise Reduction** flow, the Detailed view's **Reduced by** figure is
`1 - cases that needed a human / alerts ingested`, and its explanation names both counts.
It is not shown while the counters cover only part of the window.

## Read the hover line

Rest the pointer on the number for a moment, or move keyboard focus to it. A short line
appears with the formula and the real numbers, for example:

`Risk 39.11 = (0.25 x 65.24 + 0.20 x 24 + 0.30 x 40 + 0.15 x 40 + 0.10 x 0) / 1.00. Click for inputs.`

On a dashboard tile it reads like this:

`32 false positive verdicts of 38 verdicted cases = 84.2%, the last 24 hours.`

When the line does not already say how to open the rest, it ends with "Select it for the
full calculation." In a queue row the line has no such pointer, because a click there
opens the case.

The line stays while the pointer or focus is on the number or on the line itself, so you
can move onto it to read it. Press **Escape** to close it. On a touch screen there is no
hover line: a tap opens the full calculation.

## Open the full calculation

Click the number, or focus it and press **Enter** or **Space**. A panel opens beside it
with these parts, top to bottom:

| Part | What it holds |
| --- | --- |
| Result | The number as the Console shows it, and the hover line |
| Formula | The calculation in words and symbols |
| Inputs | Each input with its value and where it came from, such as "Recorded at scoring" or "Today's policy" |
| Steps | Every arithmetic step, one per row, with its result |
| Rounding | How the shown number was rounded from the computed one |
| Provenance | Whether the inputs were recorded when the number was computed (see below) |
| Notes | Anything that limits the reading, such as a policy that changed since |

Press **Escape** to close the panel. Focus returns to the number you opened it from.

On a KPI drill-down the formula sits under the sentence that says which cases the
figure counts, and **Show the calculation** opens the same parts in a small panel that
scrolls on its own, so the case list below stays in view.

### Copy calculation

**Copy calculation** copies the whole explanation as plain text, so you can paste it into
a ticket, a handoff note or a chat message. The button reads **Copied** for a moment. If
the browser refuses the copy, the panel says "Could not copy."

The text has one line per part, in the order of the panel. This is the copy of the
worked example below:

```text
Risk score: Risk 39
Risk 39.11 = (0.25 x 65.24 + 0.20 x 24 + 0.30 x 40 + 0.15 x 40 + 0.10 x 0) / 1.00.
Formula: sum(weight x factor) / sum(weights), or / 1 when every weight is 0
Inputs:
- Events in the scoring cluster: 12 (Recorded at scoring)
- First to last event: 300 s (Recorded at scoring)
- Events per minute: 12 / (300 s / 60) = 2.4 (Recorded at scoring)
- Distinct rule types: 2 (Recorded at scoring)
- Reputation input: 40, from enrichment (Recorded at scoring)
- Asset criticality input: 0, no asset entry for this entity (Recorded at scoring)
- Weights: Volume 0.25, Velocity 0.20, Reputation 0.30, Diversity 0.15, Asset criticality 0.10 (In force at scoring)
- Rule types: ssh-bruteforce, port-scan (Recorded at scoring)
Steps:
- Volume: min(100, 100 x ln(1 + 12) / ln(1 + 50)) = 65.24
- Velocity: min(100, 100 x 12 / (300 / 60) / 10) = 24
- Reputation: clamp(40, 0, 100) = 40
- Diversity: min(100, 100 x 2 / 5) = 40
- Asset criticality: clamp(0, 0, 100) = 0
- Weighted sum: 0.25 x 65.24 + 0.20 x 24 + 0.30 x 40 + 0.15 x 40 + 0.10 x 0 = 39.11
- Total: 39.11 / 1.00 = 39.11
- Shown: floor(39.11 + 0.5) = 39
Rounding: Each factor is stored with 2 decimals and the total from the unrounded factors, so a hand sum of the stored factors can differ by up to 0.01. Shown as 39 (rounded half up). Band Medium (22 to 47).
Provenance: Weights and inputs recorded when this case was scored, 2026-11-26T09:00:00Z.
```

Values that come from your sources, such as rule names, are copied exactly as text.

## The risk score

Every case has a risk score from 0 to 100. Code computes it from the case's events; the
AI never computes it. The score is the weighted mean of five factors, each from 0 to 100:

| Factor | Default weight | How it is computed |
| --- | --- | --- |
| Volume | 0.25 | `min(100, 100 x ln(1 + events) / ln(1 + 50))`. It levels off near 50 events. 0 with no events. |
| Velocity | 0.20 | `min(100, 100 x events per minute / 10)`, where events per minute is `events / (window seconds / 60)` and the window is the time from the first event to the last, at least 1 second. 0 when the cluster has fewer than 3 events. |
| Reputation | 0.30 | The threat-intelligence reputation of the entity, kept between 0 and 100. 0 when the entity is not an IP address, enrichment is off, or it was not looked up. |
| Diversity | 0.15 | `min(100, 100 x distinct rule types / 5)`. Full at five rule types. |
| Asset criticality | 0.10 | The criticality you gave the asset, kept between 0 and 100. A network range that holds the IP address wins over an exact entry. 0 when the asset has no entry. |

The Velocity step is written from the recorded event count and window, so its
expression gives its result: for 8 events over 434.875 seconds it reads
`min(100, 100 x 8 / (434.875 / 60) / 10) = 11.04`.

Then:

`risk = (sum of weight x factor) / (sum of the weights)`

When every weight is 0, the sum is divided by 1 and the score is 0. Change the weights
under **Settings → General → Detection → Risk weights** and the asset entries under
**Settings → General → Detection → Asset criticality**.

### Worked example

A case is built from 12 events from one IP address over 5 minutes (300 seconds). Two
rule types fired. Enrichment gave the address a reputation of 40, and the address has
no asset entry. The weights are the defaults.

1. Volume: `ln(13) / ln(51) = 2.5649 / 3.9318 = 0.6524`, so `100 x 0.6524 = 65.24`.
2. Velocity: `12 / (300 / 60) = 2.4` events per minute, so `100 x 2.4 / 10 = 24`.
3. Reputation: 40.
4. Diversity: `100 x 2 / 5 = 40`.
5. Asset criticality: 0.
6. Weighted sum: `0.25 x 65.24 + 0.20 x 24 + 0.30 x 40 + 0.15 x 40 + 0.10 x 0`
   `= 16.31 + 4.80 + 12.00 + 6.00 + 0.00 = 39.11`.
7. The weights add up to 1.00, so the score is `39.11 / 1.00 = 39.11`.
8. The Console shows `floor(39.11 + 0.5) = 39`, in the Medium band.

You can repeat these steps with a calculator from the inputs the panel lists.

### Bands

The band of a score is the band of the number the Console shows:

| Band | Shown score |
| --- | --- |
| Critical | 74 to 100 |
| High | 48 to 73 |
| Medium | 22 to 47 |
| Low | 0 to 21 |

A score of 73.6 is shown as 74 and is Critical everywhere it appears. Urgency and the
derived severity also use the score as shown, rounded half up, so a risk of 47.74 is
shown as 48 and reads High everywhere, and the advisory priority and SLA target follow
it. The automatic close decision still compares the unrounded score.

### Event counts that change later

A case can gain events after it was scored, for example when later events join it. The
score keeps the event count of the run that scored it. When the counts differ, the panel
says so, for example "The case now holds 15 events; the score was computed from the 12
events in its scoring run."

### Network ranges

The recorded asset input says how the asset was matched (a network range, an exact
entry, or none). It never stores the range itself. If you may read the settings, the
panel also names the network range that holds the entity today, marked as today's
configuration.

## The decision

The **AI verdict** chip explains what the code decided. The code compares the AI's
verdict, its confidence and the risk score with the policy for that verdict:

- the case closes only when the policy is on for the verdict, the confidence is at
  least the minimum confidence, **and** the risk is at most the maximum risk;
- otherwise a person decides;
- a needs-human verdict never closes without a person. Code fixes this, and no policy
  can change it.

With the default policy, a false positive closes at 85% confidence or more and a risk of
30 or less, and true positives always go to a person. For example:

`Closes automatically: confidence 92% >= 85% (met) and risk 18.4 <= 30 (met).`

The panel lists the verdict, the confidence and the risk score, the two thresholds, a
step for each condition (**Met** or **Not met**), the policy result and the recorded
decision. It says whether the thresholds were **recorded when the decision was made** or
are **today's policy**. When the policy changed after the decision, a note says how
today's policy would read the same numbers. When a person closed the case, a **Policy
check** step says whether the policy alone would have closed it.

Each decision made by this release records its thresholds in the audit log beside the
decision. A case decided earlier has no recorded thresholds, so the panel uses today's
policy and says so. If the newest investigation run failed, the panel says the code
routed the case to a person.

## SLA clocks

The SLA phrase in the case header explains its clock: the priority and its target, when
the clock started, the first human response, the time elapsed and the state.

- The response clock starts when the case was detected, or when it was created if no
  detection time is recorded. It stops at the first human response: an
  acknowledgement, or a person moving the case to Investigating, Escalated, On hold,
  Resolved or Closed. A move made by the system, the AI agent or an analyst policy is
  not a response. If the case is closed before anyone responds, the response clock
  stops at the close.
- The resolution clock stops when the case is first resolved or closed, and runs again if
  the case is reopened.
- A running clock is **at risk** from 80% of its target and **breached** once it is past
  the target.

The default targets are:

| Priority | Response | Resolution |
| --- | --- | --- |
| P1 | 15 minutes | 4 hours |
| P2 | 30 minutes | 8 hours |
| P3 | 2 hours | 24 hours |
| P4 | 8 hours | 3 days |

For example, a P2 case created 12 minutes ago that no one has answered reads "Response
SLA P2: 12m of 30m elapsed, on track. At risk from 24m.", because `0.8 x 30 = 24`. From
minute 24 it reads at risk, and after minute 30 breached. The SLA is advisory: it never
closes or escalates a case. See the [KPI glossary](kpi-glossary.md#sla-attainment)
for how SLA attainment counts cases.

## Cost

The investigation cost of a case is the sum of its AI calls. Each call made by this
release records the rates it was charged, so the panel can recompute it:

`cost = (input tokens x input rate + output tokens x output rate + cache read tokens x
cache read rate + cache write tokens x cache write rate) / 1,000,000`

The rates are US dollars per million tokens. A Batch or Flex call is charged half, so its
line ends with `x 0.5 (Batch)` or `x 0.5 (Flex)`. Each call also says where its price
came from: the price catalog, an operator price override, a self-hosted model (free),
the mock provider or Demo Mode. When a call's recorded cost differs from what its rates
give, the call says so. Case chat is counted on its own line and is never part of the
investigation cost. You need the **View cost** permission to see cost figures.

## Rounding

- A score is shown as a whole number rounded half up: `floor(x + 0.5)`. 80.5 is shown as
  81 and 47.5 as 48. The code decides on the unrounded score.
- Each risk factor is stored with 2 decimals, and the total is computed from the
  unrounded factors. A sum of the stored factors by hand can differ from the total by up
  to 0.01. When it does, the Total step and the hover line do not print a division that
  would not give the score: they say the score was recorded from the unrounded factors
  and show what the stored factors give, for example "Risk 20.81, from the unrounded
  factors. The stored factors give (...) / 1.00 = 20.82."
- A percentage is shown with at most one decimal: `0.9654` is shown as `96.5%`.
- Time left on an SLA is rounded down, so "due in 1h" never means more than one hour
  remains. Under a minute reads "under 1m".
- An amount of a dollar or more is shown with 2 decimals, and a smaller one with 4. A
  single AI call in the case's usage list keeps up to the ledger's 8 decimals, so a call
  that cost a fraction of a cent still reads its real amount.

## Provenance and "not recorded"

The **Provenance** line says how much of the calculation is a record:

| Provenance | Meaning |
| --- | --- |
| Recorded when the number was computed | The inputs and weights were stored when the number was made, so the steps repeat the real calculation |
| Computed by the server for this reading | The server computed the number now from stored data, for example an SLA clock or a dashboard figure |
| Reconstructed with today's settings | The inputs were stored, but the weights or thresholds of that time were not, so the panel uses today's settings and says so |
| Not recorded | The inputs were not stored, so the panel shows only what was stored |

Cases scored before this release did not keep their inputs. Their panel works from the
five stored factors:

- When the server can rebuild the calculation, the panel shows it with today's weights
  and says "The weights used at scoring were not recorded for this case, so the table
  uses today's weights." If today's weights give a different total, it says so and
  keeps the recorded score: "The difference cannot be attributed exactly; the recorded
  score was not rewritten."
- Otherwise the hover line reads "the inputs were not recorded for this case", the panel
  lists the stored factors, and its note says "This case was scored before the inputs
  were recorded, so the factor arithmetic and the weights in force cannot be shown."

Nothing is guessed to make the table look complete: a factor that was not stored is not
shown.

The same applies after a rollback to an earlier release. That release drops the recorded
inputs when it saves a case again, and the case then reads "not recorded" here (see
[Known limitations](../releases/known-limitations.md)).

## Related pages

- [Case Manager](case-manager.md)
- [KPI glossary](kpi-glossary.md)
- [Analytics](analytics.md)
- [Deterministic decisions](../concepts/deterministic-decisions.md)
- [State, audit, and cost](../concepts/state-audit-cost.md)
