---
title: Investigation
description: Run ad-hoc and case-based investigations while preserving evidence, cost, and decision provenance.
---

# Investigation

Agentic SOC supports two investigation paths. **Workspace → Entity investigation** starts
with an entity; a case's **Re-investigate** action starts with its stored evidence and context.
Both use the same metered gateway and deterministic case policy.

## Investigate an entity

1. Open **Triage → Workspace → Entity investigation**.
2. Choose IP, user, or host and enter the exact value.
3. Select the lookback and, when offered, a model override.
4. Review the retrieved event count before treating the answer as complete.
5. Open the resulting case to inspect evidence and the code decision.

The three visible stages are literal: the Console scopes configured telemetry,
correlates and analyzes the matching evidence, then saves the result as a case. This
is useful for a targeted IP/user/host pivot that did not begin from an existing case;
it is not a second case queue and it does not bypass normal case policy.

The configured lookback begins at `now-24h` by default. If it finds no events, the
manual path can widen through seven days, 30 days, and one year before returning a
no-events result. Queries remain scoped to connected log sources.

The run searches the main log source first. When that source holds nothing for the
entity, it looks further, one source at a time: in Demo Mode the other Demo sources,
otherwise the recent events each push source delivered (its live tail, up to the last
500 events, held in memory and lost on restart). Other pull sources are not searched.
A push source set to ignore is never read, and a record the source delivered twice
counts once. Each source is read through its own field mapping, so an address a QRadar
LEEF record carries in `src` is found as the **Logs** page shows it. The first source
with matching events is the one the case is built from. When nothing matches anywhere,
the page says so and names the widest window searched: the last 365 days.

Manual investigation requires `cases:reinvestigate` when RBAC is enabled.

## Re-investigate a case

Use re-investigation when new evidence arrived, a provider was restored, or an
analyst wants a different configured model to reassess the same story. Agentic SOC first
tries the case's stored event identifiers. If the source no longer retains those
events, it can rebuild a bounded cluster from the evidence already stored on the
case. The case is updated in place; it is not duplicated.

That update preserves the Case's original nullable `app_version` and `build_sha`:
they identify the build that created the case, not the build performing the current
re-investigation. The new audit and usage rows created by the run carry the current
append-build identity instead. Older cases remain `null`; no provenance is backfilled.

Re-investigation spends model tokens and creates usage-ledger entries. Confirm the
model and scope before applying it to many cases.

**Reinvestigate** does not make you wait. Its dialog names the investigation time cap and
the cost to date, starts a fresh run and closes at once; the case header then shows
**AI working** until the run finishes, and the person who started it gets an Inbox item
with the result. While a run on the case is queued or running, a second request is
refused with "An AI investigation is already running on this case." and no second run
starts. A closed case is reinvestigated in place, unless new events already opened
another case for the same activity: then you are pointed to that open case instead. If
you close the case while the run works, the run's result replaces your close when it
finishes, and you get an Inbox notice that says so; your note, disposition, actions
taken, comments and screenshots are kept. See
[Case Manager](case-manager.md#when-the-ai-is-working-on-a-case).

## Read the result in layers

In a case:

1. **Brief** is the case at a glance, in four lanes tagged with where each comes from.
   **Evidence** says why the detection fired. **AI** gives the AI's summary in two or
   three sentences with its recommended action; it is the model's own reasoning, tagged
   as AI, never the deterministic decision's text, and a case the AI did not assess
   says so. **Decision** gives what decided the case, the authority sentence, the
   auto-close reading and any automation applied, with the policy inputs one click
   away. **People** gives the runbook progress, the discussion and files, and the last
   human action. When a runbook is attached to an open case, its **Next step** row sits
   at the top of the Brief. Recorded risk factors are in the case facts' **Signal**
   section, visualized without inventing factors that are not stored.
2. **How this case was built**, folded at the foot of the Brief (the former Timeline
   tab), shows when the six pipeline stages occurred. The visible labels are Input,
   Correlate, Risk Assigned, Triage, Investigate, and Decision. Expanding **Risk
   Assigned** shows the arithmetic with the weights in force when the case was scored and
   the event count of its scoring run; a case that later gained events keeps the count it
   was scored on. A case scored before 0.2 did not record its inputs: it says so, uses
   today's weights, and keeps the recorded score when they disagree. **Decision** shows
   the decision recorded when the case was decided: when it was made, what code decided
   and why, and the confidence and risk thresholds it compared. When today's auto-close
   policy would decide the same inputs differently, the stage says so. A case decided
   before 0.2 has no recorded decision, so the stage re-derives one with today's policy,
   says so and shows no time. If a later investigation run failed, the stage says the
   case was routed to a person. The terminal marker alone pulses to identify the current
   end of the story. See [Explainable numbers](explainable-numbers.md).
3. **Evidence** holds what the sources said: **What happened** (why the detection fired
   and the source evidence), the primary entity under **Entities**, **Threat context**
   (below), **Related cases**, and the signature's anomaly baseline when it has one.
4. **AI investigation** shows the **AI assessment** (the model's reasoning, what it found
   and ruled out, the reproduction query, and the full assessment evidence one click
   away), the detailed **Investigation inputs** (the memory consulted, RAG knowledge
   retrieved, runbook references retrieved, the Published runbook whose guidance the
   investigator received with its version, and the platform threshold-tuning snapshot
   for the latest run), the optional full trace, and earlier gradings of the AI. The
   assessment never falls back to the decision's text: when no assessment text was
   recorded, it says so. The verdict and confidence are in the case header and the case
   facts, so they are not repeated here. Runbook passages retrieved through RAG remain
   distinct from the runbook whose guidance the investigator received. Platform tuning
   records correlation or severity-threshold changes, not model fine-tuning.
5. **Threat context**, a section of the Evidence tab (formerly its own tab), adds
   enrichment, ATT&CK, related-case context, and **How this case was clustered**. That read-only diagram uses persisted facts to show Input alerts →
   Correlation cluster → Opened case. Focus or hover a node to inspect contributing
   source counts, grouping, threshold/window, status, verdict, and related links.
   Alert references are bounded one-way hashes; raw source identifiers and payloads
   are not returned. Older cases may show limited or no cluster metadata rather than
   a reconstructed story.

Investigation inputs are projected from the **latest investigation run** only. The
runbook appears as an input only when the investigator actually received its guidance;
a runbook that was matched but never reached the investigator (the Generic incident
fallback, which is never given to it as guidance, the cheap router path, the kill switch,
a guidance budget) shows as **Selected only** on the AI investigation tab and never counts
as an input. A case investigated before Round 14 keeps its stored procedure id under
**Older runbook**. If no applicable input was recorded,
the summary stays absent. If
provenance could not be read, the Console reports that limitation instead of treating
it as a successful empty result.

Knowledge history has a separate lifetime contract. `retrieval_history_status` is
authoritative for the whole Case: `available` means its known lifetime was instrumented,
while `unavailable` means earlier history cannot be reconstructed. Re-investigating a
legacy case does not change that lifetime marker. Its `knowledge_used` list is cumulative,
de-duplicated, bounded, and always an array for backward compatibility.
`retrieval_observation_status` is authoritative for its meaning: `measured` proves at
least one complete retrieval, `not_measured` means a new history-complete Case has not
completed one, and `unavailable` is the legacy default. A later fully measured modern
run may advance the observation marker on a legacy Case, but its lifetime-history marker
stays `unavailable`. An empty array is a measured zero only when the observation status
is `measured`.

For the latest run, `procedure_provenance` independently records retrieval as
`measured`, `not_attempted`, or `unavailable` with a reason. This tells you whether that
specific run completed retrieval, deliberately skipped it, or could not establish the
result. It does not repair or replace the Case's lifetime history status, and a populated
reference list proves reference coverage only, not retrieval quality or whether every run
retrieved knowledge.

RAG remains fail-soft. If corpus refresh/seeding cannot be verified, the investigator may
still use bounded last-known-good references. If one configured query group fails, chunks
from successful groups may still ground the prompt. In either case the latest run records
`unavailable` with an `incomplete:*` or specific failure reason, and the partial context
does not advance `retrieval_observation_status` or enter the case-level coverage measure
as a completed observation. Only completion of every configured query group makes the
run `measured`; a completed zero-hit result is then an honest measured empty result.

The trace marks people's steps, case chat and automatic code steps apart from the AI's
steps, and its filter offers All, Agent, Tool, Code, People and Chat. The step counts
show once, beside the **Investigation trace** heading; while a filter is on, the trace
also says how many steps it shows, for example "3 of 12 steps". Opening the Evidence tab
is not a step of the investigation, so the trace leaves it out; it stays in Activity and
the audit log. Each step's
**Details** show what it recorded: the model, latency, tokens, cost and how the cost was
found, and the tool input, query and output, with log values marked untrusted. A call
shows its own cost and latency when the ledger names it, otherwise an even split, and
the trace says when it shows only the newest records. On a case with a very long
history, the AI investigation tab also says when its rationale was built from the newest
records only, for example "Built from the newest 500 of 1,200 records. The audit log has
the rest." Without `cost:view`, cost figures in step text read "hidden" and amounts
"(amount hidden)".

The trace is diagnostic evidence, not a second decision system. Tool calls available
to the investigator are read-only log search, cached enrichment, and knowledge
retrieval. Memory, knowledge, runbooks, and threshold tuning may inform preprocessing
or the agent assessment; deterministic case policy remains the final close/escalate
route authority.

## Work the runbook

The runbook on the **Response** tab is the procedure the people on the case follow; the investigator
reads the same Published runbook as guidance. It never closes a case and never changes
the verdict. The Next step card shows the first required step not yet done: confirm an
AI draft note, run a read-only lookup, record a decision or an action, or mark the step
Not applicable or Blocked with a reason. When every required step is done it says so and
offers **Close case**, which opens the case's own close dialog. Lookup results are collected under your
permissions and shown as untrusted data; a lookup you cannot see says so instead of
showing its rows. See [Case Manager](case-manager.md#work-the-runbook) for the full
tab, and [Runbooks](../intelligence/runbooks.md) for writing one.

## Chat in context

Open **Triage → Workspace → Chat** for questions across your data, or a case's **Chat**
tab in Case Manager for a conversation scoped to that case. Both use the same read-only
assistant: for one question it can search logs, count and read cases, query metrics,
look up an indicator, and search the knowledge corpus, and it shows every lookup as it
runs. It cannot close a case or approve a proposal, and log-derived values are treated
as untrusted data.

Workspace Chat is your personal, saved conversation workspace: searchable, pinnable
history, answers with charts and tables you can add to a report, and token and cost
figures for every question. The Case Manager **Chat** tab stays scoped to its case and
never appears in personal history. Each question and its final answer text (without
charts or the run log) are posted to the case's discussion thread, where anyone who can
read the case sees them; this needs `cases:comment`, and without it the answer says it
was not saved to the case thread. Use Workspace Chat for a reusable line of inquiry and
the case tab for evidence and follow-up tied to one case. See
[Workspace Chat](chat.md) for the details.

## Failure and cost boundaries

- A provider or tool failure must not drop the alert; the case routes to human review.
- Every model call passes through the shared usage and cost ledger.
- Budget exhaustion stops the provider call before it starts and routes the case to
  `NEEDS_HUMAN`.
- Raw log streams are not sent wholesale to a model; evidence is selected or
  aggregated first.

Use [Logs and search](logs-search.md) to validate source facts and
[Runbooks](../intelligence/runbooks.md) and
[Knowledge and memory](../intelligence/knowledge-memory.md) to understand retrieved
context and its trust boundary.
