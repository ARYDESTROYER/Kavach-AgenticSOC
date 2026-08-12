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

## Read the result in layers

In a case:

1. **Overview** separates the decision brief, signal profile, source assertion,
   agent findings, deterministic code result, entities, and attack story. Recorded
   risk factors are visualized without inventing factors that are not stored. When
   applicable, **Investigation inputs** summarizes the memory consulted, RAG
   knowledge retrieved, runbook references retrieved, playbook actually consulted,
   and platform threshold-tuning snapshot for the latest run.
2. **Timeline** shows when the six pipeline stages occurred. The visible labels are
   Input, Correlate, Risk Assigned, Triage, Investigate, and Decision. Expanding
   **Risk Assigned** reconstructs the arithmetic from persisted factor values and
   current configured weights. When historical weights differ, it preserves the
   recorded score and explicitly says exact historical attribution is unavailable.
   The terminal marker alone pulses to identify the current end of the story.
3. **Investigation** shows the agent assessment, evidence, recommended action,
   reproduction query, detailed Investigation inputs, deterministic decision, and
   optional full trace. Runbooks retrieved through RAG remain distinct from a
   playbook injected into the investigator. Platform tuning records correlation or
   severity-threshold changes, not model fine-tuning. When the narrative sentence
   already states the verdict and confidence, duplicate verdict and confidence chips
   are suppressed rather than shown twice.
4. **Threat** adds enrichment, ATT&CK, related-case context, and **How this case was
   clustered**. That read-only diagram uses persisted facts to show Input alerts →
   Correlation cluster → Opened case. Focus or hover a node to inspect contributing
   source counts, grouping, threshold/window, status, verdict, and related links.
   Alert references are bounded one-way hashes; raw source identifiers and payloads
   are not returned. Older cases may show limited or no cluster metadata rather than
   a reconstructed story.

Investigation inputs are projected from the **latest investigation run** only. A
playbook appears only when it was actually injected and consulted; selection alone is
not sufficient. If no applicable input was recorded, the summary stays absent. If
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
reference list proves reference coverage only—not retrieval quality or whether every run
retrieved knowledge.

RAG remains fail-soft. If corpus refresh/seeding cannot be verified, the investigator may
still use bounded last-known-good references. If one configured query group fails, chunks
from successful groups may still ground the prompt. In either case the latest run records
`unavailable` with an `incomplete:*` or specific failure reason, and the partial context
does not advance `retrieval_observation_status` or enter the case-level coverage measure
as a completed observation. Only completion of every configured query group makes the
run `measured`; a completed zero-hit result is then an honest measured empty result.

The trace is diagnostic evidence, not a second decision system. Tool calls available
to the investigator are read-only log search, cached enrichment, and knowledge
retrieval. Memory, knowledge, runbooks, playbooks, and threshold tuning may inform
preprocessing or the agent assessment; deterministic case policy remains the final
close/escalate route authority.

## Chat in context

Open **Workspace → Chat** for general questions or the case's **Chat** tab for a
case-scoped conversation. The chat engine may query logs and retrieve knowledge, but
it cannot close a case or approve a proposal. On-screen fields and log-derived values
are treated as untrusted data.

Workspace Chat is the analyst's personal, saved conversation workspace. Its history is
newest-first and searchable; select an earlier conversation to restore the server-saved
transcript, source, and model, or use its menu to rename or delete it. On narrow screens,
the same history opens from the **History** Sheet. A new draft is saved only after the
first successful assistant response. Chats created before saved Workspace history was
introduced were browser-only and cannot be recovered.

The Case Manager **Chat** tab is deliberately separate: it stays scoped to that case
and does not appear in personal Workspace history. Use Workspace Chat for a reusable
analyst line of inquiry and the case tab for evidence and follow-up tied to one case.
See [Workspace Chat](chat.md) for conversation history, strict source selection,
evidence disclosure, retention, and retry behavior.

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
