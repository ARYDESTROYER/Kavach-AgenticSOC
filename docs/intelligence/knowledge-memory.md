---
title: Knowledge and memory
description: Manage retrieved procedures and durable operator facts with explicit trust boundaries.
---

# Knowledge and memory

Open **Intelligence → Knowledge corpus** for the retrieval corpus and
**Intelligence → Memory** for durable operator facts. Both can ground an
investigation, but they have different trust and lifecycle rules.

## Knowledge base

The built-in corpus contains runbooks, MITRE ATT&CK reference text, and suppression
guidance. Authorized operators can also create versioned runbook knowledge under
**Intelligence → Reference runbooks**. When enabled, resolved-case summaries can be indexed for
similarity. Knowledge search combines lexical and vector retrieval and returns source
and score metadata.

Use the Knowledge page to:

1. inspect corpus and chunk statistics;
2. list and open documents;
3. import a bounded Markdown or plain-text document;
4. test a retrieval query; and
5. delete an imported document that is no longer valid.

Import and deletion require `rag:manage`. Seed material is protected from ordinary
deletion; overriding that protection requires an explicit force operation.

Knowledge import is a server-owned `rag_import` background job. The Console snapshots
up to 20 validated documents and keeps aggregate UTF-8 payload headroom below the
active registry's 8 MiB cap. After `202 Accepted`, navigation or reload does not stop
the import; per-document progress and bounded failures remain in
**Analytics → Jobs** and **Inbox**. Imported text is compacted out of the terminal job
record. Deletion remains a direct, explicit document operation.

`POST /api/rag/import` remains executable for compatibility clients, but it is an
OpenAPI-deprecated, request-bound single-document primitive. It is not the Console
workflow and does not gain the durable progress/recovery guarantees of `rag_import`.

Resolved-case precedent bootstrap uses the same durable job surface. It is distinct
from importing operator documents and retains the existing trust rules. The older
direct `POST /api/rag/precedent/bootstrap` route is likewise executable but
OpenAPI-deprecated and request-bound; new user workflows should submit a
`precedent_bootstrap` Job.

## Precedent by detection rule

Each projected precedent record carries the canonical identity of the detection rule set
that produced it, so precedent can be matched on the rule rather than on text similarity
alone. Records written before this was captured are re-tagged in place from the case
store on the next projection; the re-tag reuses the existing document and does not
re-embed, so it costs nothing. Records whose case can no longer be read stay retrievable
and are reported as unattributed rather than treated as absent.

The projection window is bounded, and two settings decide which precedents fill it.

`precedent.window.stratify_by` is an ordered list of projection keys the window is
filled round-robin across. It defaults to detection rule identity and then the
analyst-confirmed outcome, so neither a bulk confirmation on one rule nor a run of
identical outcomes can evict every other rule's precedent — or leave the corpus
unanimous about a rule the analysts have in fact resolved two ways. The second key is
the analyst's confirmed outcome and not the agent's own verdict: the two differ exactly
when an analyst overturned the agent, and those corrections are the precedent worth
keeping. A key whose values are all identical carries no information and is skipped.

`precedent.window.max_transaction_fraction` (default `0.5`) is the largest share of the
window one operator transaction — a bulk analyst action, or the coarse time bucket that
stands in for one on cases labelled before bulk actions were marked — may occupy. It is
a fraction rather than a count, so it does not encode one deployment's volume, and it is
soft: over-cap cases move to the back of the queue rather than being dropped, so the
window still fills completely whenever enough qualifying cases exist. Set it to `0` or
`1.0` to disable the cap.

Set `precedent.window.stratify_by_rule` to `false` to switch window fairness off
entirely — both the keys above and the admission cap. Note that an empty
`stratify_by` list disables only the keys; the admission cap is governed separately.

The window's ordering is always globally newest-first across the terminal case statuses,
independently of these settings.

Retrieval surfaces resolved cases as fenced context. Enable optional precedent promotion
under **Settings → Knowledge & threat context → Analyst-confirmed precedent promotion**;
it additionally reports, as a computed count, how many analyst-confirmed benign and
malicious outcomes exist for the exact rule identity under investigation. That count is
evidence given to the investigator; the verdict remains the model's and the close
decision remains the deterministic policy's. Promotion requires an exact rule-identity
match, an unanimous confirmed history, a minimum confirmed count, and a matching
precedent actually retrieved for the case. Unreviewed agent auto-closes are never
promotable. See [Deterministic decisions](../concepts/deterministic-decisions.md).

## What the precedent corpus is made of

`GET /api/rag/precedent/composition` (and the equivalent
`GET /api/diagnostics/precedent-composition`) reports what the precedent corpus holds
today beside the projection a rebuild would produce. It embeds nothing, writes nothing
and costs no provider spend: both halves come from a corpus metadata read plus the
ordinary per-case projector.

Read it before rebuilding. **A successful rebuild is not evidence of repair.** The
projection pages the case store newest-first, so if a bulk confirmation put a skewed run
at the head of the qualifying population, a rebuild re-selects the same records and
converges on the composition it just replaced. Where the qualifying pool is itself more
skewed than the window drawn from it, no selection policy over that pool can produce a
healthy corpus, and the answer is better ground truth or a different window — not
another rebuild.

The report is deliberately a cross-tabulation of the analyst-confirmed outcome against
the model's own verdict, not a count per outcome. Per-outcome counts read pristine on a
corpus that is actively misleading the model: a corpus that is entirely
`outcome=false_positive` looks like a clean benign baseline, and if it is also entirely
`verdict=needs_human` what it actually tells a future investigation is "we saw this and
escalated it every time". Alongside the cross-tab it reports per-rule counts, chunk and
document totals, the size of the qualifying pool the bounded window was drawn from, and
how much of the selected window one operator transaction occupies.

`rebuild_corpus(dry_run=true)` returns the same report without rebuilding anything.

## Excluding a precedent record

Force-deleting a `resolved_case` document removes its chunks, and the next projection
re-derives that case from the case store and puts it back, so a plain delete silently
undoes itself. `POST /api/rag/precedent/exclusions` is the supported way to make the
removal hold: it records a durable, case-scoped exclusion marker and performs the delete
together, in that order, so no projection can re-derive the record while its chunks are
being removed. The marker suppresses every path that could otherwise re-create the
record — the bounded confirmed window, the lower-trust unconfirmed tier, the bulk
ratification indexer, and the preserved-precedent path taken when the embedding model
changes.

An exclusion **does not touch ground truth**. No feedback row, disposition, decision
owner, status or history entry is altered, so the case keeps its analyst label and the
independent-evidence counts that threshold tuning derives from those labels are
unchanged. Its intended side effect is that closing or re-closing an excluded case no
longer indexes it either.

Supply `case_ids`, or `select` a population by the projection's own metadata keys
(detection rule identity, confirmed outcome, model verdict, trust class, ground-truth
source, entity, status, and the bulk-ratification markers). Free-text rule-title matching
is deliberately not offered, because a title is content that a detection-content update
can rewrite underneath a saved selection. Add `"dry_run": true` to resolve the selection
without excluding anything.

Each exclusion carries a bounded reason (`mislabelled`, `ratification_artifact`,
`duplicate`, `superseded`, `sensitive`, `other`) and an optional short note. Neither ever
enters a corpus record or a model prompt; they are operator and audit fields. Every
exclusion and restoration is audited, as is every knowledge-document delete.

The exclusion set is bounded relative to the configured precedent window rather than by a
fixed number: an exclusion list several windows deep means the corpus composition itself
needs a policy change rather than more individual exclusions.

`DELETE /api/rag/precedent/exclusions/{case_id}` removes a marker. It writes nothing to
the corpus; the record returns on the next ordinary projection, exactly as it would have
been derived before.

`GET /api/rag/precedent/exclusions` lists the current set with a per-rule and per-reason
breakdown. The same information appears on `GET /api/diagnostics/health`, where excluded
cases are subtracted from the qualifying-record count so the corpus-versus-history
reconciliation cannot report a deficit caused by a deliberate operator action, and where a
corpus emptied by exclusions is reported as operator-excluded rather than as the starved
state that indicates a broken projection. If the exclusion set cannot be read, the
projection keeps honouring the last set it read successfully and diagnostics reports the
comparison as unknown rather than publishing a confident one.

## Trust labels

Only administrator-controlled `runbook` knowledge and the system-verified `mitre` and
`suppression` sources are treated as trusted reference material in a prompt. Imported documents, pasted threat
intelligence, resolved-case summaries, and unknown future source types are fenced as
untrusted data before model use.

Importing a document does not promote it to trusted instructions. Review provenance,
age, owner, and scope before relying on any retrieved statement.

## Operator memory

Memory stores explicit facts an operator wants the agent to remember, such as known
scanner ranges, asset roles, or local conventions. Memory entries can be active or
inactive and remain attributable.

Creating, editing, or deleting memory requires `memory:manage`; reading requires the
deployment's normal authenticated access. Do not store credentials, personal data
that is not required for triage, or unverified claims copied from logs.

Memory informs answers and investigations but cannot alter the deterministic case
decision.

## Hygiene

- Keep each entry narrow, dated, and attributable.
- Deactivate or delete obsolete facts.
- Prefer a [versioned runbook](runbooks.md) for reusable investigation guidance and
  memory for short local facts.
- Test retrieval after large corpus changes.
- Treat missing retrieval as degraded context, not permission to drop a case.

See [Runbooks](runbooks.md),
[Background jobs](../operations/background-jobs.md), [Enrichment](enrichment.md),
[MITRE and threat context](mitre-threat-context.md), and
[Playbooks and approvals](../automation/playbooks-approvals.md).
