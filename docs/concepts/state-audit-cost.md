---
title: State, audit, and cost
description: Understand where Agentic SOC 0.1 stores its own data and how actions and model spend remain reviewable.
---

# State, audit, and cost

This page applies to **Agentic SOC 0.1** and is for operators and administrators planning
storage, retention, accountability, and spend controls.

## Source data and Agentic SOC state are different

Agentic SOC reads security events through connectors. Its own bookkeeping is stored behind
a `StateStore` abstraction.

| State backend | Intended use | Important note |
| --- | --- | --- |
| PostgreSQL + pgvector | Recommended self-contained stack | Stores relational/KV state and vector knowledge without Elasticsearch |
| SQLite | Single-node development and evaluation | Simple local state; not a scale-out profile |
| Elasticsearch | Legacy attachment or existing Elasticsearch operations | Requires a separate management credential for Agentic SOC-owned indices |

The state backend contains cases, configuration, cursors, usage, audit data, users,
sessions, collaboration, and knowledge. Selecting it does not select or migrate the
log source. Switching backends creates a separate state view unless you perform an
explicit migration.

Application background jobs share the existing KV authority: one bounded strict-CAS
registry document stores self-scoped jobs, idempotency fingerprints, item/checkpoint
state, renewable leases, transitions, bounded failures, and terminal summaries. It
adds no SQL table or Elasticsearch index. Large submitted parameters and per-item maps
are compacted at terminal state; the registry is an operational ledger, not long-term
storage for imported text or every selected case ID.

ZIP artifacts are intentionally outside the StateStore. Local development and the
byte-pinned updater-managed standalone profile default to `./data/job-artifacts`; the
legacy merge Compose mounts `/var/lib/agentic-soc/jobs` on a persistent named volume.
Private file modes, opaque
IDs, count-bounded retention, and SHA-256/size verification protect delivery, but this
directory needs its own capacity, backup, and retention decision.

## Producing-build provenance

Operational records carry the build that produced them, not the build that happens to
read them later:

- a new case receives `app_version` and `build_sha` once, at creation; those values are
  immutable creation-build provenance and survive re-investigation or any later update;
- every new append-only audit or usage row receives the version and SHA of the build that
  first appended it; an idempotent retry preserves that first-writer identity; and
- historical rows are not backfilled. A legacy record has `null` provenance rather than
  being attributed to the first upgraded build that reads or updates it.

The values use the same non-secret release identity as `GET /api/health/build-info`.
`app_version` comes from the running package, while an unset build SHA is recorded honestly
as `unknown`. This is record provenance, not proof that an artifact was accepted as Stable.

PostgreSQL and SQLite already store the affected domain records as JSON, so this additive
metadata requires no SQL migration. It also does not change the source version from
`0.1.13`.

The repositories enforce the boundary for direct callers as well as the product
pipeline. Elasticsearch CaseStore checks the document id before applying its defensive
stamp: it stamps only a missing document and restores an existing document's stored
provenance on update, including legacy `null`. The SQL Case repository follows the same
insert-only fallback—stamp when the row is absent, otherwise recover the values already
inside the JSON document. Re-saving an original unstamped object therefore cannot replace
the first writer, and updating a legacy row cannot manufacture a creation build.

Retryable append ledgers preserve the same rule. On Elasticsearch, a deterministic audit
`event_id` or Batch usage `idempotency_key` first reserves the complete first-writer
payload in the existing non-rolling config index. The rolling ledger row is a recoverable
projection: retries search the full read pattern, rebuild a genuinely missing projection,
and never adopt the retrying build. A pre-claim ledger row is adopted verbatim. Conflicting
audit evidence fails closed; usage keeps the first bill. On SQL, deterministic audit ids
converge through the audit primary key, while Batch usage reserves its idempotency hash in
the existing KV table in the same transaction as the ledger insert. These mechanisms add
no new index or SQL table. Ordinary unkeyed live usage calls remain distinct append-only
rows.

## Audit trail

Agentic SOC records agent and operator actions in an append-oriented audit trail. Examples
include prompts, read-only queries, tool calls, context assembly, verdicts,
deterministic decisions, errors, polling, scans, lifecycle actions, and explicit
memory edits.

Audit records should answer:

- who or what acted;
- which surface, source, or case was involved;
- what action occurred;
- when it occurred; and
- whether the action succeeded or failed.

The console's Audit page is a review surface, not permission to alter history.

Background-job submission and state transitions are audit-before-visible as well as
audit-before-effect. Submission/retry and cancellation return a successful `202` only
after their transition audit is confirmed, and a terminal Inbox/SSE projection waits
for its terminal audit. Durable reconciliation repairs an ambiguous or missing
transition audit before projection without treating uncertainty as permission to run an
unsafe item again. CAS, audit ordering, and a five-minute lease make bounded restart
recovery possible; cancellation remains cooperative and completed item effects are not
rolled back.

## Retrieval history is evidence-qualified

Knowledge evidence has three separate contracts:

- `retrieval_history_status` is the authoritative lifetime marker. `available` means the
  case was instrumented for its known lifetime; `unavailable` means some earlier history
  cannot be reconstructed. A legacy case stays `unavailable` even after a modern
  re-investigation.
- `retrieval_observation_status` is the authoritative measurement marker. `measured`
  means at least one complete, instrumented retrieval finished; `not_measured` means a
  history-complete new case has not yet completed one; `unavailable` is the legacy
  default. A genuinely measured modern run may advance a legacy Case's observation marker
  to `measured`, but its lifetime-history marker remains `unavailable`.
- `knowledge_used` always remains an array for backward wire compatibility. It is a
  cumulative, de-duplicated, bounded reference list. Current producers add references to
  it only from measured runs; legacy contents remain untouched and must be interpreted
  through the status fields. `[]` is a measured zero only when
  `retrieval_observation_status=measured`; array presence or emptiness alone proves nothing.

Latest-run audit provenance additionally classifies that run as `measured`,
`not_attempted`, or `unavailable` and includes a machine-readable reason. This run-level
evidence must not be used to rewrite the case's authoritative lifetime status. A measured
run requires every configured query group to complete. Fail-soft RAG behavior can still
use successful query-group chunks or a last-known-good corpus when another group or
seeding verification fails; that context remains visible as consulted run evidence, but
the run is `unavailable` and does not advance the Case observation to `measured`.

The `retrieval_history` block returned by `GET /api/metrics` is deliberately a case-level
reference-coverage measure: cases with any recorded reference divided by history-complete
cases whose `retrieval_observation_status` is `measured`. It is neither a retrieval-quality
score nor a per-run hit rate. Mixed legacy/instrumented cohorts and truncated reads report
an unavailable `null` count/rate. A history-complete cohort with no measured observation
reports `insufficient_evidence`; `not_measured` cases are excluded rather than converted
to zero or silently included in the denominator.

## Model usage and cost

All model-backed roles use one gateway. The gateway records model, role, input and
output tokens, cache/batch accounting, outcome, and calculated cost. Candidates that
never enter model investigation correctly cost `$0`.

The default daily budget performs a preflight check and can block new provider calls.
When blocked, the case routes to human review. The check is not an atomic spend
reservation, so already-running calls can finish above the configured amount.
Provider-side budgets and rate limits remain the final billing boundary.

## Secrets are not state

Persisted configuration stores secret presence, not secret values. Environment
variables provide the durable boot-time secret path. Values entered through the UI
or runtime secret endpoints are memory-only in Agentic SOC 0.1 and disappear on restart.

Do not include `.env`, access tokens, API keys, or raw notification credentials in
backups, support bundles, screenshots, or audit annotations.

## Operational checks

After onboarding or an incident exercise:

1. confirm the selected state backend is ready;
2. verify a case persists across an ordinary restart;
3. verify a state-changing action appears in Audit;
4. verify a model call appears once in Cost; and
5. compare the provider invoice with the Agentic SOC ledger.

## Agentic SOC 0.1 boundaries

SQL setup uses idempotent schema creation rather than an ordered migration ledger.
Backup, restore, forward-upgrade, interrupted-migration, and downgrade guarantees
must be established for your environment before relying on persistent production
state.

The job registry's leases and the process-local investigation/export gates do not
remove the supported single-backend-replica constraint. Related LLM Batch records are
a separate provider-job projection, and the updater retains its separate supervisor
state. See [Background jobs](../operations/background-jobs.md) for those boundaries.

## Related pages

- [Architecture](architecture.md)
- [Deterministic decisions](deterministic-decisions.md)
- [Install Agentic SOC](../getting-started/install.md)
- [Configuration and secrets](../operations/configuration.md)
- [Background jobs](../operations/background-jobs.md)
