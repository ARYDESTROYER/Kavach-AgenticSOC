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

The projection window is bounded. It is filled round-robin across rule identities, so a
bulk confirmation on one rule cannot evict every other rule's precedent from the corpus.
Set `precedent.window.stratify_by_rule` to `false` to restore a flat newest-first window.

Retrieval surfaces resolved cases as fenced context. Enable optional precedent promotion
under **Settings → Knowledge & threat context → Analyst-confirmed precedent promotion**;
it additionally reports, as a computed count, how many analyst-confirmed benign and
malicious outcomes exist for the exact rule identity under investigation. That count is
evidence given to the investigator; the verdict remains the model's and the close
decision remains the deterministic policy's. Promotion requires an exact rule-identity
match, an unanimous confirmed history, a minimum confirmed count, and a matching
precedent actually retrieved for the case. Unreviewed agent auto-closes are never
promotable. See [Deterministic decisions](../concepts/deterministic-decisions.md).

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
