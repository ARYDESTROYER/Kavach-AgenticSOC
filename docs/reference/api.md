---
title: API reference
description: Curated Agentic SOC API endpoint groups, authentication, pagination, realtime events, and OpenAPI discovery for version 0.1.
---

# API reference

The **Agentic SOC API** is the FastAPI service behind the Agentic SOC Console. This page covers
the public HTTP surface in application version **0.1.13** and documentation line
**0.1**. The API is mounted at `/api`; the service root is `/`.

## Interactive and machine-readable specifications

Each running API publishes:

- Swagger UI at `/docs`;
- the OpenAPI document at `/openapi.json`;
- build identity at `/api/health/build-info`.

Build information reports the application version, independent release channel,
commit SHA, build time, state backend, and OCSF version. A Testing candidate and its
Stable promotion both remain `0.1.13`; `TLSOC_RELEASE_CHANNEL` distinguishes
`testing` from the accepted `stable` build.

The same identity is persisted on newly produced operational records. A Case's
nullable `app_version` and `build_sha` identify the build that created the case and
remain unchanged across later updates or re-investigation. Each newly appended AuditDoc
and UsageDoc records the build that first appended it, with idempotent retries preserving
that first-writer stamp. Legacy records are not backfilled and therefore return `null`;
an unset current build SHA is the explicit string `unknown`, not `null`. This is additive
under application version `0.1.13` and requires no SQL migration.

The committed 0.1 OpenAPI snapshot contains 221 paths. It is the
best source for current request-body models, enums, parameters, and operation IDs.
Some handlers return plain dictionaries without a FastAPI `response_model`, so their
generated response schema is intentionally less specific than the runtime payload.
The specification also does not declare tags or an OpenAPI security scheme in 0.1.
Runtime authentication and authorization still apply as described below.

Because `/docs` and `/openapi.json` sit outside the protected `/api` router, restrict
them at the reverse proxy if publishing the route inventory is not acceptable in your
environment.

## Base URL and JSON

The Agentic SOC Console uses relative `/api/*` URLs. External clients should use the same
HTTPS origin exposed by the deployment proxy:

```text
https://soc.example.com/api/cases
```

Requests with a body use `Content-Type: application/json`. Errors normally use
FastAPI's `{"detail": ...}` envelope. Validation failures return HTTP 422.

## Authentication

Authentication is disabled by default in the base configuration. When enabled, the
API accepts either:

- the HTTP-only `tlsoc_token` cookie issued by `/api/auth/login`; or
- `Authorization: Bearer <token>` using the token returned by that login.

For example, with a cookie jar:

```bash
curl --fail-with-body \
  --cookie-jar tlsoc.cookies \
  --header 'Content-Type: application/json' \
  --data '{"username":"analyst","password":"replace-me"}' \
  https://soc.example.com/api/auth/login

curl --fail-with-body \
  --cookie tlsoc.cookies \
  'https://soc.example.com/api/cases?limit=25&offset=0'
```

An MFA-enabled account receives a short-lived `pending_token` after password
verification and completes sign-in through `/api/auth/mfa/verify`. Session refresh,
revocation, and step-up reauthentication have dedicated endpoints in the auth group.

Authentication is applied centrally to the `/api` routers. A small bootstrap and
health allowlist remains public; `POST /api/ingest/{source_id}` performs receiver-level
bearer or HMAC authentication instead. State-changing routes also enforce resource and
action permissions when RBAC is enabled. See [Permissions](permissions.md) and
[Authentication](../administration/authentication.md).

## Endpoint groups

The table is a curated map of the full surface. Use `/docs` or `/openapi.json` for
the exact request model and every operation under a prefix.

| Area | Principal operations | Purpose |
|---|---|---|
| Service and health | `GET /`, `GET /api/health`, `/live`, `/ready`, `/build-info` | Service discovery, probes, dependency readiness, and release identity |
| First-run setup | `GET /api/setup/status`; `POST /api/setup/account`, `/secrets`, `/complete` | Bootstrap the first account, submit runtime secrets, and complete setup |
| Authentication | `/api/auth/login`, `/logout`, `/refresh`, `/reauth`, `/change-password`; `/api/auth/mfa/*`; `/api/auth/sso/*` | Password sessions, MFA, refresh rotation, step-up authentication, and OIDC |
| Account and sessions | `/api/account/*`, `/api/me/avatar`, `/api/sessions*`, `/api/admin/sessions*` | Profile, effective permissions, activity, and session revocation |
| Users and roles | `/api/users*`, `/api/roles*` | User lifecycle, built-in/custom roles, permission preview, and simulation |
| Connector catalog | `GET /api/connectors`, `GET /api/connectors/{source_type}`, `POST /api/connectors/test` | Discover connector manifests and test source access |
| Sources and ingest | `/api/sources*`, `POST /api/ingest/{source_id}`, `POST /api/poll`, `GET /api/logs` | Configure feeds, accept pushed records, poll pull sources, inspect health, and browse logs |
| Cases | `GET /api/cases`, `GET /api/cases/{case_id}`, `POST /api/cases/bulk` | List, filter, retrieve, export, and act on cases |
| Case investigation | `/api/cases/{case_id}/triage`, `/timeline`, `/trace`, `/stages`, `/rationale`, `/threat-context`, `/forwarding`; `POST /investigate`, `/reinvestigate`, `/feedback` | Explain evidence, agent work, deterministic routing, and analyst feedback |
| Case collaboration | `/api/cases/{case_id}/thread*`, `/tasks*`, `/activity`, `/comment`, `/assign`, `/tags`, `/notify` | Discussion, reactions, tasks, ownership, activity, and manual notification |
| Workspace | `POST /api/chat`, `/api/chat/conversations*`, `POST /api/investigate`, `POST /api/overview`, `GET /api/search`, `/scans`, `/personas` | Console chat with per-user history, entity investigation, cross-surface search, scan queues, and personas |
| Detection and automation | `/api/rules*` (including `/api/rules/analyst-policies*`), `/api/tuning*`, `/api/baseline*`, `/api/campaigns*`, `/api/batch*`, `/api/proposals*` | Rule lifecycle, safe preview/version rollback, analyst-grounded recommendations, baselines, reconciled campaigns, batch jobs, and approvals |
| Playbooks | `GET/POST /api/playbooks`, `GET/PUT /api/playbooks/{playbook_id}`, `POST /api/playbooks/reload`, `/dry-run`, `GET /coverage`, `/selection/{case_id}`, `POST /api/cases/{case_id}/run-playbook` | Durable catalog/open/edit, deterministic diagnostics and coverage, selection provenance, and case execution |
| Knowledge and memory | `/api/rag/*` (including `/api/rag/precedent/composition` and `/api/rag/precedent/exclusions*`), `/api/memory*`, `/api/runbooks*`, `POST /api/threat-context/import` | Import/search/delete knowledge, inspect precedent composition, evict individual precedent records durably, manage operator memory, and manage protected/owned runbooks |
| Enrichment and MITRE | `/api/enrichment/*`, `/api/mitre/coverage*`, `GET /api/cases/{case_id}/threat-context` | IOC enrichment, provider configuration, ATT&CK coverage, and Navigator export |
| Dashboards and metrics | `/api/dashboards*`, `/api/metrics*`, `/api/feedback/stats`, `/api/usage/summary`, `/api/cost/estimate` | Personal dashboards, posture/noise/improvement metrics, usage, feedback, and cost estimates |
| Agent health diagnostics | `GET /api/diagnostics/health`, `GET /api/diagnostics/precedent-composition`, `GET /api/metrics/auto-close-health` | Permission-separated precedent/migration and auto-close evidence for the range-aware Effectiveness surface, including the per-rule precedent distribution, futility findings, and the zero-cost corpus composition report |
| Standup and handoff | `/api/standup*` | Shift report, acknowledgements, and action items |
| Notifications | `/api/notifications/providers`, `/channels/*`, `/preview`, `/test`, `/prefs`, `/inbox*` | Channel catalog/secrets, safe previews, tests, per-user preferences, and in-app inbox |
| Application background jobs | `POST/GET /api/jobs`, `GET /api/jobs/{job_id}`, `POST /cancel`, `GET /artifact` | Self-scoped durable work, progress, cooperative cancellation, bounded failures, result projections, and verified retained artifacts |
| Preferences and presentation | `/api/settings*`, `/api/prefs/*`, `/api/branding`, `/api/terminology`, `/api/views*`, `/api/budget*`, `/api/llm/*`, `/api/models` | Organization/user preferences, saved views, model routing/pricing, branding, and budget controls |
| Release-source discovery | `GET /api/releases/upstream`, `POST /api/releases/upstream/check` | Read cached or force a cooldown-bounded refresh of public Stable/Testing source metadata; never deploys or activates code |
| Supervised application updates | `GET /api/system-updates/status`, `POST /preflight`, `POST /jobs`, `GET /jobs/{job_id}`, `POST /cancel`, `POST /rollback`, `GET /receipt` | Capability and blocker discovery plus a fresh-auth, built-in-super-admin control plane for one supported signed Compose/PostgreSQL application update; host operations stay behind the private supervisor socket |
| Improvement worker health | `GET /api/schedulers/health` | Process-local threshold-tuner, campaign, event-driven baseline, and Batch health; list-only, never a personal Inbox job |
| Telemetry-gap evidence | `GET /api/tuning/source-recommendations` | Query-backed supported missing-evidence recommendations; connector absence alone is never proof |
| Own-state storage lifecycle | `GET/PUT /api/storage/lifecycle`, `POST /api/storage/lifecycle/preview`; apply via `POST /api/jobs` | Inspect/save/preview desired policy; submit canonical `storage_lifecycle_apply` work as a Job (`POST .../apply` is retired with 410) |
| Portable data export | `POST /api/admin/export` | Legacy single-file, bounded, secret-free application-state snapshot (`data_export:export`) |
| Full-history export archive | `POST /api/admin/export/archive` | OpenAPI-deprecated executable compatibility primitive: synchronously assemble and verify selected safe scopes before serving one ZIP (fresh auth + `data_export:export`) |
| Full-history export segment | `POST /api/admin/export/segment` | OpenAPI-deprecated executable compatibility primitive: continue one supported safe scope past 5,000 records using an opaque cursor (fresh auth + `data_export:export`) |
| Cancel export segment | `POST /api/admin/export/segment/cancel` | Release the PIT carried by an unfinished cursor (fresh auth + `data_export:export`) |
| Audit and realtime | `GET /api/audit`, `GET /api/events` | Append-only action history and server-sent event updates |
| Demo and reset | `/api/demo/*`; reset via `POST /api/jobs` | Isolated synthetic demonstration lifecycle and canonical `tiered_reset` Job submission (`POST /api/admin/reset` is retired with 410) |

## Supervised application updates

`GET /api/system-updates/status` returns the current application identity, newer
installable Stable release when one exists, private-supervisor protocol/capability,
explicit blockers and warnings, the fixed supported scope, and any active or most
recent durable job. Status is observational and requires `system_updates:read`.

Mutations require `system_updates:apply` or `system_updates:rollback`, authentication
enabled, the built-in `super_admin` role, a current registered session and token
version, a completed temporary-password change, and recent reauthentication. Custom
roles and RBAC-off mode cannot elevate into deployment authority. Session/audit-store
failure denies the operation.

The browser begins with `POST /api/system-updates/preflight`, sending only an exact
`vX.Y.Z` release ID and an opaque idempotency key. The response contains an expiring
opaque preflight token, fixed component scope, checks, blockers, warnings, backup, and
rollback contract. `POST /api/system-updates/jobs` returns HTTP 202 for the durable job
when the exact release, token, and a new idempotency key are accepted. Poll
`GET /api/system-updates/jobs/{job_id}` through the expected backend/Web reconnect and
read the terminal receipt at `/receipt`. Cancel is valid only before component
switching; rollback is valid only when the supervisor retained a rollbackable snapshot.

Clients never send a repository, artifact URL, image, digest, host path, Compose
fragment, command, backup path, or migration instruction to these routes. The backend
derives canonical assets and delegates over one configured Unix socket; the supervisor
independently enforces its host-pinned repository and signed release contract.

## Runbook management

Runbooks use a dedicated resource boundary: list/detail require `runbooks:read`,
while create, update, delete, and reindex require `runbooks:manage`.

| Operation | Contract |
| --- | --- |
| `GET /api/runbooks` | Bundled and operator runbook summaries plus enabled/retrieval state and per-item index status |
| `GET /api/runbooks/{runbook_id}` | Metadata, full stored `content`, and parsed guidance body |
| `POST /api/runbooks` | Validate and create an operator runbook from `{id, content}`, then attempt immediate targeted indexing |
| `PUT /api/runbooks/{runbook_id}` | Validate and replace an operator runbook using `{content, expected_revision}`, then attempt targeted reindexing |
| `DELETE /api/runbooks/{runbook_id}?expected_revision=N` | Delete the expected operator revision and its retrieval projection |
| `POST /api/runbooks/{runbook_id}/reindex` | Reconcile one runbook's full-body retrieval projection |
| `POST /api/runbooks/reindex` | OpenAPI-deprecated executable compatibility primitive for full-catalog reconciliation; the Console uses a `runbook_reindex` Job |

Bundled items return `source_type=bundled`, `protected=true`, and `editable=false`.
Operator items return their current revision, actor/timestamp metadata, and separate
index state (`index_status`, `indexed_revision`, `last_indexed_at`, and a bounded
`index_error`). The list envelope also reports `enabled` and `retrieval_enabled`;
catalog management remains possible when retrieval is disabled.

Update and delete are optimistic: a stale `expected_revision` is rejected rather
than overwriting another operator's edit. Create/update/delete responses report the
durable catalog result separately from the index result. Reindex responses report
`indexed`, `deleted`, `failed`, and bounded `errors`, so callers must not treat a
partial synchronization as a complete success.

New and replacement operator documents require a small plain-text manifest plus a
strict plain-text body of no more than 1,800 characters. The body uses the required
ordered labels documented in [Runbooks](../intelligence/runbooks.md), rejects
Markdown and HTML formatting, and permits sequential numbered lines only in
`INVESTIGATION STEPS`. Manifest fields have independent write ceilings and their
combined retrieval descriptor may not exceed 1,200 Unicode characters.
Validation failures return actionable issues identifying what failed, why it is
rejected, and how to fix it. A rejected request creates neither a catalog revision nor
a retrieval projection. Existing non-compliant content remains readable and
reindexable; its next edited revision must satisfy the current contract.

The validation response uses HTTP 422 with this stable detail envelope:

```json
{
  "detail": {
    "code": "runbook_validation_failed",
    "message": "Runbook rejected. Fix the issues below and submit again.",
    "issues": [
      {
        "code": "stable_issue_code",
        "field": "body",
        "problem": "What is missing or invalid.",
        "reason": "Why the contract rejects it.",
        "fix": "The concrete correction to make."
      }
    ],
    "limits": {
      "body_max_characters": 1800,
      "retrieval_descriptor_max_characters": 1200,
      "document_max_bytes": 131072
    },
    "body_characters": 0
  }
}
```

`body_characters` is the Unicode character count of the parsed, newline-normalized,
outer-trimmed body. Clients should render all returned issues rather than stopping at
the first one. `GET /api/runbooks` publishes the full backend-owned
`authoring_standard`, including current field/list limits and prohibited formatting,
so alternate authoring clients can present the same guidance.

Runbook content is trusted operator-controlled knowledge and is projected under a
stable `runbook:<id>` document identity. These routes never execute it as a playbook
and never call or modify deterministic case-policy authority.

## Analyst rule policies

`GET /api/rules/analyst-policies` (`rules:read`) lists every operator declaration that a
detection is benign in this environment, each with a derived `live` flag
(enabled and not expired). `PUT /api/rules/analyst-policies/{policy_id}`,
`POST /api/rules/analyst-policies/{policy_id}/enabled`, and
`DELETE /api/rules/analyst-policies/{policy_id}` require `rules:manage`. Pass `new` as
the id to have the server mint one. Author and creation instant are recorded
server-side and survive later edits; every mutation appends an audit row.

A cluster whose detections are **all** declared is closed with the `false_positive`
disposition and the `analyst_policy` decision owner, with no model call. The case is
still created, audited, and reopenable — this is not the event drop that
`suppression_rules` performs. The evaluation happens before any verdict exists, so it
neither reads nor extends the auto-close policy.

`analyst_policy` closes are excluded from false-positive rate, automation rate,
auto-close health, the noise-reduction funnel, case lineage, tuner observed volume, and
improvement evidence, and are never accepted as analyst-confirmed outcomes.

## Threshold tuning and approvals

`GET /api/tuning/recommendations` (`automation:read`) distinguishes the full observed
population from independently confirmed learning evidence. Per-rule output includes
`observed`, `analyst_samples`/`total`, `unconfirmed`, `fp`, `tp`, Wilson FP estimates,
EWMA volume, and proposal reason. Model verdicts, inferred terminal dispositions, and
auto-closed outcomes are excluded from the learning denominator. Reason values include
`insufficient_analyst_evidence`, `suppression_drop`,
`shadow_eval_would_hide_confirmed_tp`, `policy_requires_approval`, and
`confirmed_evidence_candidate`.

The observer is enabled by default, but `auto_apply_confirmed` defaults to `false`.
`POST /api/tuning/{rule_id}/apply` (`automation:manage`) recomputes the rule and routes
eligible bounded changes to a HITL proposal under that safe default. Explicit automatic
application additionally requires the configuration opt-in, sufficient independent
analyst evidence, and a clean shadow replay. Suppression is never auto-applied.
`GET`/`PUT /api/tuning/config` use `automation:read/manage`; rollback uses
`automation:manage`.

`GET /api/proposals` requires `proposals:read`; approve/reject requires
`proposals:approve`. Approval recomputes/materializes the tuning change rather than
trusting stale proposal text. A stale threshold returns `409`; rejection leaves
preferences unchanged and proposal history remains available. Built-in Analyst Tier 1,
Analyst Tier 2, Responder, and Auditor roles can read proposals; Responder and
management roles with the approve grant can decide them.
Proposal kinds are `suppression`, `memory`, `tuning`, and acknowledgement-only
`automation_ack`. Generic automation reviews use the last kind and never materialise
trusted Memory or mutate a case. Approvals use a strict CAS
`pending -> applying -> approved` lifecycle and proposal-id idempotency; concurrent
decisions return `409`, storage failures remain visible/retryable, and a trusted
Memory approval succeeds only after confirmed persistence. Approve and reject both
require strict append-only control-audit evidence keyed by proposal id before final
status, so an unavailable audit ledger fails closed and a retry reuses the same row.

## Precedent corpus composition and exclusion

`GET /api/rag/precedent/composition` (`rag:read`) and
`GET /api/diagnostics/precedent-composition` (`settings:read`) report the same read-only
composition: the precedent corpus as it stands beside the projection a rebuild would
produce. Both are seed-free and cost zero embedding calls — the payload states so
explicitly with `embedding_calls: 0`.

Each half cross-tabulates the analyst-confirmed `outcome` against the model's own
`verdict` (`outcome_by_verdict`) as well as reporting each marginal, per-rule counts, and
chunk/document totals. The joint distribution is the point: per-outcome counts alone read
clean on a corpus that is unanimously `false_positive` and also unanimously
`needs_human`. `projected.pool` reports the qualifying population the bounded window was
drawn from, its own composition, and whether the bounded scan completed, so a window
drawn from an equally skewed pool — which no reprojection can repair — is visible.
`projected.admission` reports how much of the window one operator transaction occupies.
`rebuild_corpus(dry_run=true)` returns the same report and changes nothing.

`POST /api/rag/precedent/exclusions` (`rag:manage`) durably excludes cases from the
precedent projection and deletes their records in the same operation, so an eviction is
not undone by the next projection. `GET` lists the set with per-rule and per-reason
breakdowns (`rag:read`); `DELETE /api/rag/precedent/exclusions/{case_id}` removes a
marker, after which the record is re-derived on the next projection. Selection uses
projection metadata keys only. Exclusions never modify case ground truth, are bounded
relative to the configured precedent window, and are audited in both directions, as are
knowledge-document deletes.

`GET /api/diagnostics/health` reports the exclusion set inside `precedent_corpus`,
subtracts excluded cases from the reconciliation's qualifying-record count, and reports a
corpus emptied by exclusions as `operator_excluded` rather than `starved`. A refused
projection attributable to a deliberate precedent-window reduction is reported as a
warning with `reason_code: window_size_reduction`, not as a critical corpus loss; a
projection that would reach zero is refused unconditionally and no setting changes that.

## Analyst-confirmed precedent evidence

`GET /api/diagnostics/health` (`settings:read`) returns `precedent_effectiveness`
alongside the existing corpus block:

- `distribution` — analyst-confirmed precedent counted per rule identity (the canonical,
  order-independent detection set), with `available`, `truncated`, `unattributed_documents`
  (precedent recorded before rule identity was captured), and `total_confirmed`. An
  unreadable corpus reports `available: false`, never an empty distribution.
- `futile_rules` — rules holding abundant analyst-confirmed benign precedent whose cases
  still route to a human, each with its counts, an explanation, and remediation. Each also
  appears as a `precedent_not_effective:{rule}` warning in `alerts`.
- `promotion_enabled`, `window_size`, and `window_stratified` describe the active policy.

When `precedent.promotion` is enabled, each investigated case records `precedent_signal`:
`status` (`qualified`, `insufficient`, `conflicting`, `not_retrieved`, `unavailable`,
`disabled`, or `not_applicable`), the confirmed benign/malicious counts for the matched
rule identity, how many matching precedents were retrieved, and the thresholds applied.
Rule identity must match exactly; similarity alone never qualifies, and the lower-trust
`model_unconfirmed` tier is never promotable. The signal is evidence supplied to the
investigator — the verdict remains the model's and the close decision remains the
deterministic policy's.

## Memory and RAG trust

Only memory entries that are both active and `review_status=approved` are injected as
trusted operator context. Agent-authored memory starts `pending` and remains fenced as
an untrusted review candidate. Legacy agent memory without review metadata migrates to
pending on read; legacy human memory remains approved. Direct `POST`, `PUT`, and
`DELETE /api/memory*` mutations require `memory:manage`; an authorized direct POST is
human/approved, while authorized Chat creation is agent/pending. Unauthorized Chat
requests do not write. An authorized PUT can approve pending memory and records its
approver/time. Memory writes use strict compare-and-swap storage.

Managed RAG projection follows the saved `rag.enabled`, runbook, MITRE, resolved-case,
suppression, and threat-context source toggles and reconciles when they change; imported
operator documents remain untouched. Only independently analyst-confirmed terminal
cases enter the managed resolved-case corpus. Completion-only assignments are rejected
for the embedding role. Cardinality mismatch, empty/all-zero vectors, and mixed
dimensions fail before partial indexing; an embedding-space change clears/reseeds
rather than mixing dimensions. Local fallback records the actual provider/model and
`embedding_fallback=true`.

## Playbook catalog and procedure provenance

Bundled playbooks are immutable package data. Operator playbooks are strict-CAS
StateStore records across Elasticsearch, PostgreSQL, and SQLite; no separate index or
table is required. Management is `playbooks:manage`; reads, dry-run, and coverage use
`playbooks:read`; case selection explanation uses `cases:read`. A successful write is
durable and atomically refreshed into the active catalog. The limits are 100 operator
playbooks, 2 MiB aggregate operator content, 256 KiB per document, and 2,400 characters
of rendered trusted procedure context. Send the current `expected_revision` on PUT;
a stale update returns `409`. There is no delete route.

`POST /api/playbooks/dry-run` accepts at most 100 `rule_ids`, one `entity_type`, and
`event_count` from 0 through 1,000,000. It explains exact deterministic match/no-match
without an LLM, investigation, or decision call. `GET /api/playbooks/coverage` scans at
most 20,000 stored cases and reports covered/uncovered cases, selected counts,
`truncated`, and the top 100 unmatched rule families. Matching is exact—not fuzzy or
model-selected.

The latest investigation's `procedure_provenance` audit row distinguishes selected
from consulted persona/playbook state, selection reason, consultation path, retrieval
query groups, and retrieved knowledge source/score/document id/revision/content hash
with a bounded snippet. Rationale and Case Manager Overview project the latest run;
selected-only inputs are never presented as consulted/applied.

Its `retrieval_status` and `retrieval_reason` describe that run only. `measured` means
every configured retrieval query group completed, including a measured empty result;
`not_attempted` means a known path skipped retrieval; `unavailable` means the run's
retrieval evidence cannot be established, such as interruption, unverified corpus
seeding, or any failed query group. Retrieval is fail-soft: bounded last-known-good
chunks or chunks from successful groups may still appear in that run's `knowledge` and
ground the investigator. They do not turn a partial/unverified run into a measurement.
These run-level fields do not overwrite the Case's authoritative lifetime
`retrieval_history_status` or its cumulative `retrieval_observation_status`.

## Scheduler and telemetry evidence

`GET /api/schedulers/health` (`automation:read`) returns
`scheduler_runtime_running` plus `workers` for `threshold_tuner`,
`campaign_correlation`, `baseline_producer`, and `batch_jobs`. Each worker reports
`enabled`, `gated`, `running`, `cadence`, `last_attempt_at`, `last_success_at`,
`last_error`, and `processed`. The first, second, and fourth are cadence loops covered
by `scheduler_runtime_running`. `baseline_producer` is event-driven with
`cadence=on_ingest`; it is enabled/running when baseline learning is enabled outside
Demo and reports its own attempted, confirmed-success, error, and processed evidence
without depending on the cadence-loop runtime flag. Tuner/campaign success anchors
recover from durable state after restart; the workers remain process-local and have no
distributed lease. `manual` is reported as gated, and a push/queue-only deployment is
not marked gated merely because pull polling is disabled.

`GET /api/tuning/source-recommendations` (`cases:read`) scans at most 20,000 cases and
returns `status`, `recommendations`, `scanned_cases`, `truncated`,
`evidence_schema="agentic-soc.telemetry-gap/v1"`, and an explicit
`not_available_reason`. It also returns `capture_status` and
`capture_not_available_reason`; v0.1.13 reports capture unavailable rather than
claiming that uncontrolled legacy text is evidence. It accepts only stored structured
history from a controlled producer after a bounded query/tool attempt with result `field_missing`,
`query_unsupported`, or `source_unqueryable`. The v1 allowlist maps outbound DNS,
endpoint process, and identity-authentication evidence; unknown fields/sources and
connector absence are ignored. Each recommendation exposes affected count, up to 50
case ids, and up to 10 bounded proofs.

## Common query behavior

Case listing uses `limit` and `offset`, with optional `status`, `surface`, `entity`,
`from`, and `to` filters. Other list endpoints define their own query parameters;
do not assume that all collections share one pagination envelope. Follow the OpenAPI
operation for the endpoint being called.

Source and log browse limits are server-bounded. Treat every returned log field,
raw record, case-derived string, and search result as untrusted data when presenting
it in another system.

## Workspace Chat persistence and retry

`POST /api/chat` remains compatible with stateless and Case Manager callers. Durable
personal Workspace history is opt-in with `persist_conversation: true` and is disabled
whenever the effective request is case-scoped. Resume a saved thread with its
`conversation_id`; the server transcript is authoritative and caller-supplied `history`
does not replace it.

Persisted Workspace sends may include an `idempotency_key` of **8 through 128
characters** using letters, digits, `.`, `_`, `:`, or `-`. When omitted, the server
returns a generated key for the completed persisted turn. Keep that value stable when
retrying an ambiguous turn. Reusing a key for the same completed request replays the
committed response without another transcript append or model charge. A still-running
key returns `409 chat_request_in_progress`; a key reused for a different request returns
`409 chat_idempotency_conflict`. Each principal may hold at most 256 simultaneous live
request leases; while all are occupied, a new key returns retryable
`409 chat_request_capacity_busy` without invoking or billing the model.

The additive `ChatResponse` fields are:

| Field | Meaning |
|---|---|
| `idempotency_key` | Stable identifier for the persisted Workspace turn |
| `effective_model` | Model that actually executed the answer |
| `effective_source_id`, `effective_source_name` | Queryable source that actually served the turn |
| `truncated` | Whether the bounded saved response snapshot omitted larger supporting structures |

An explicit `source_id` is strict: disabled, removed, push-only, or unbuildable sources
return `422 chat_source_unavailable`; the route never queries Primary and labels it as
the requested source. Primary remains the default only when no source was explicitly
selected. Persisted assistant messages carry `idempotency_key`, `model`, `source_id`,
and `source_name`, so later selector changes cannot rewrite historical provenance.

History endpoints are newest-first and per authenticated user:

| Operation | Contract |
|---|---|
| `GET /api/chat/conversations` | Retained summaries plus `total`, `history_truncated`, `total_conversation_count`, and `oldest_retained_at` |
| `GET /api/chat/conversations/{conversation_id}` | Authoritative retained transcript and per-turn provenance |
| `PATCH /api/chat/conversations/{conversation_id}` | Rename an owned conversation |
| `DELETE /api/chat/conversations/{conversation_id}` | Delete an owned conversation; audit remains append-only |

`total` and a conversation's `message_count` describe retained rows. The additive
`total_conversation_count` and `total_message_count` describe the corresponding total
before retention, while `history_truncated` and `oldest_retained_at` disclose an
incomplete retained window. The current bounds are **50 conversations per user** and
**100 messages per conversation**. Conversation summary/detail objects also include
`source_name`, `history_truncated`, `total_message_count`, and `oldest_retained_at`.

History lives in one hashed StateStore partition per normalized user. On first access,
the compatibility path can read and lazily migrate that user's entries from the legacy
shared document; no reset or new index/table is required. A history read or commit that
cannot be verified returns `503 chat_history_unavailable` instead of an empty list or a
false saved result. Existing `404 conversation not found` behavior remains unchanged.

## Base metrics and retrieval-history evidence

`GET /api/metrics` reads at most 2,000 cases and returns its existing deterministic
dashboard aggregates plus an additive `retrieval_history` object. Retrieval eligibility
is limited to investigated cases with a verdict. The Case wire contract keeps
`knowledge_used` as an array. `retrieval_history_status` is authoritative for lifetime
completeness, while `retrieval_observation_status` (`measured`, `not_measured`, or
`unavailable`) is authoritative for whether at least one completed observation exists.
Therefore `knowledge_used=[]` is a measured zero only when the observation status is
`measured`. A legacy Case starts with both status fields `unavailable`; a later fully
measured run may advance the observation status, but lifetime history remains
`unavailable` and is never backfilled. The object reports:

| Field | Contract |
|---|---|
| `status`, `available`, `reason` | `available`, `insufficient_evidence`, or `unavailable`, with an explanatory reason whenever no headline can be reported |
| `loaded_cases`, `total_cases`, `truncated` | Cohort completeness; any truncated read makes the headline unavailable |
| `eligible_cases` | Investigated cases with a verdict |
| `history_available_cases`, `history_unavailable_cases` | Split by the authoritative Case lifetime marker `retrieval_history_status` |
| `completed_attempt_cases` | History-available cases whose `retrieval_observation_status` is `measured`; array presence or emptiness is not used to infer completion |
| `cases_with_references` | Completed-attempt cases whose cumulative reference list is non-empty; `null` when the cohort cannot support the measure |
| `reference_coverage` | `cases_with_references / completed_attempt_cases`, rounded to four decimals; otherwise `null` |
| `formula` | Human-readable definition of the same case-level ratio |

This is case-level reference coverage only. `knowledge_used` is cumulative,
de-duplicated, and bounded, so the metric is neither retrieval quality nor a per-run hit
rate. Any investigated case with unavailable lifetime history makes a mixed cohort
`unavailable`; a truncated read does the same. No eligible cases or no completed,
instrumented attempt reports `insufficient_evidence`. In all three situations the
numerator and rate remain `null`. In an otherwise history-complete cohort,
`not_measured` cases are excluded from the denominator; when at least one measured Case
exists they do not force the headline unavailable. Absent instrumentation is never
converted to zero.

## Agent-improvement evidence

`GET /api/metrics/agent-improvement` is an additive, read-only reporting endpoint
protected by `metrics:view`. By default it compares the **last seven complete UTC
days** with the **preceding, non-overlapping 28 complete UTC days**. The current UTC
day is excluded so a partial day cannot be compared with complete history.

Optional query parameters are:

| Parameter | Default | Contract |
|---|---:|---|
| `as_of` | current UTC date | Exclusive `YYYY-MM-DD` boundary; future UTC dates are rejected |
| `current_days` | `7` | Current cohort length, from 1 through 31 complete days |
| `baseline_days` | `28` | Preceding baseline length, from 7 through 90 complete days |

The established headline deliberately reports three separate measurements rather
than a synthetic composite score:

| Response key | Definition | Better direction |
|---|---|---|
| `analyst_reported_verdict_agreement` | Weighted analyst-reported agreement: `(agree + 0.5 × partial) / unique latest-valid graded cases` | Higher |
| `material_analyst_correction_rate` | Explicit disagreement or an allow-listed AI-verdict/outcome conflict divided by the same unique graded-case cohort | Lower |
| `human_review_turnaround` | p50 elapsed time from the first human acknowledgement to the final human terminal transition in the final live episode | Lower |

Each metric carries its current and baseline samples, definition, delta, direction,
minimum sample, and `enough_data`, `insufficient_evidence`, or `unavailable` status.
Agreement and correction require at least 30 eligible cases in both cohorts;
turnaround requires at least 20. Daily points remain `null` until that day has five
eligible samples; missing evidence is never converted to zero.

An additive `outcomes` object is reported separately and never changes the headline:

| Response key | Contract |
|---|---|
| `recorded_case_cost` | Sum of gateway-recorded `UsageDoc.cost` for timestamped rows carrying `case_id`; includes per-day and per-costed-case readings. This is AI processing cost, not overtime, labor, or provider-invoice truth. |
| `observed_time_saved` | p50 human-owned final-episode closure elapsed time minus p50 agent-closed elapsed time. Both cohorts are agent-assisted, actor labels are operational, and elapsed time is not active labor or a human-only benchmark. Requires 10 cases per owner in both compared windows. `observed_aggregate_elapsed_difference_minutes` is the signed p50 difference multiplied by the agent-closed count; the compatibility field `estimated_total_minutes_saved` is populated only when that difference is positive and is never counterfactual labor saved. Analyst-reported estimates remain a separate field. |
| `confirmed_positive_case_rate` | Confirmed-positive latest-valid outcomes divided by all outcome-evaluable latest-valid case outcomes. Requires 20 evaluated cases in each window; direction is descriptive, not automatically good or bad. |
| `true_positive_alert_yield` | Always `unavailable` in this release. Case outcomes and raw-alert counters are different units and alert-level confirmed-outcome lineage is not persisted. `supported_alternative` points to `confirmed_positive_case_rate`. |
| `alert_volume` | Durable `ingested_alerts` and `after_clustering_alerts`, plus clustering-reduction count/rate, per-day readings, and deltas. Counter coverage must span both complete-UTC windows and is bounded by the retained 90-day hourly counter history. Lower ingress can mean a source outage; the response does not grade it as improvement. |
| `tuning_context` | Applied/rolled-back threshold-change counts beside aggregate post-clustering movement. `causal_claim=false` and `model_fine_tuning_evidence=false`; this is context, not attribution. |
| `source_guidance` | Remains `not_available`, with empty `items` and `long_term_objective=true`, in this aggregate response. Query-proven supported gaps are exposed separately by `/api/tuning/source-recommendations`; they are not folded into this outcome contract. |

`period_comparisons.week_over_week` compares seven complete UTC days with the prior
seven. The compatibility wire key `period_comparisons.month_over_month` is labelled
**Rolling 28 days over prior 28 days**, compares the latest 28 complete UTC days with
the prior 28, and returns `calendar_period=false`; it is not a calendar-month
comparison.
Each period comparison reports the four case-derived metrics (agreement, correction,
human review turnaround, and confirmed-positive case rate) with its own samples,
reason, delta, and status, plus an `outcomes` object recomputed over those exact
equal-length windows for cost, closure timing, case mix, volume, and tuning context.
Outcome objects preserve `enough_data`,
`insufficient_evidence`, `unavailable`, and where applicable `not_applicable`; source
guidance uses `not_available`. A missing ledger, incomplete durable-counter window,
bounded read, absent human/agent cohort, or undersized sample remains named rather
than becoming zero.

Agreement and correction use identical reference weights over exact source-by-severity
strata represented by at least five grades in both windows. The payload reports only
aggregate stratum counts and coverage—never source identifiers. A headline improvement
claim requires at least 80% coverage in **each** cohort, complete non-truncated case
retrieval, and sufficient samples. The guardrails report confirmed false-negative rate
over confirmed positives and human reopen-after-agent-close rate over closures with a
complete 24-hour follow-up window. A guardrail needs 20 eligible samples per cohort;
until then `breached` is `null` and the headline remains insufficient evidence. A
material guardrail regression prevents favorable efficiency changes from being
promoted as improvement.

The headline groups agreement and correction into one analyst-grade quality domain;
they are not counted as two independent signals because both derive from the same
graded-case cohort. The second independent domain is human review turnaround, and both
domains must improve before the headline can say `improving`. Turnaround excludes known
automation actor labels, but historical actor fields are operational labels rather
than authenticated identity provenance. Exclusion counters are bounded to the same
reporting horizon as the cohorts.

The response is aggregate-only: it includes no case identifiers, entities, raw
evidence, prompts, or model calls, and it performs no model call or write itself.
`provenance.billing` is `none`, `case_ids_included` is `false`, and
`decision_authority` is `reporting_only`. This endpoint describes observed outcome
shifts; it does not claim that a model learned, establish causation, or participate
in deterministic close/escalate decisions. When the bounded case load is truncated,
the response says so and classifies the headline and metric directions as insufficient
evidence.

## Case clustering explanation

`GET /api/cases/{case_id}/threat-context` includes an additive `clustering` object.
It is a read-only projection of persisted case facts; it never re-runs correlation,
changes a cluster signature, scores risk, or participates in the case decision. The
object reports availability, input/source counts, a source breakdown, correlation
mode/threshold/window/grouping/reason, opened-case status/verdict, and bounded related
cases. Up to 12 member references are returned as stable one-way hashes, with a
truncation count; raw source identifiers and alert payloads are excluded. Consumers
must tolerate `available: false` or incomplete fields for older cases.

## Application background jobs

`POST /api/jobs` accepts `{kind, idempotency_key, params}` and returns HTTP 202 after
the validated job is durably admitted and its submission transition audit is confirmed.
Every Jobs route requires `inapp:read`; the
server also enforces each operation's resource grant at admission and execution. The
supported kinds and material parameters are:

| Kind | Parameters |
| --- | --- |
| `case_reinvestigate` | `case_ids` plus optional `model` |
| `case_lifecycle` | `case_ids`, canonical lifecycle `action`, and its bounded optional action fields |
| `case_assign` | `case_ids`, `assignee` |
| `case_tag` | `case_ids`, one `tag` |
| `data_export_archive` | optional safe `scopes` |
| `data_export_segment` | optional safe `scopes` and `page_size` |
| `precedent_bootstrap` | exact acknowledgement plus bounded optional limit/batch/dry-run fields |
| `runbook_reindex` | optional `runbook_id` |
| `rag_import` | up to 20 bounded documents |
| `tiered_reset` | scope and its exact confirmation phrase |
| `storage_lifecycle_apply` | acknowledgement plus the exact saved lifecycle-policy snapshot |

Unknown or extra parameters fail validation. Secret-looking keys are rejected, and
large active canonical parameters share an 8 MiB registry cap. Case operations accept
an immutable `case_ids` snapshot; later UI selection changes cannot alter it.

The Console/user workflow for these long operations is `POST /api/jobs`. Direct
archive/segment export, precedent bootstrap, RAG import, and full-catalog Runbook
reindex remain executable, request-bound compatibility primitives and are explicitly
deprecated in OpenAPI. They are not canonical Console submission paths. Targeted
single-Runbook reindex remains a normal direct catalog operation. By contrast, the old
direct reset and storage-apply mutations are non-executable and return 410.

The idempotency key is scoped to actor/account generation and a canonical request
fingerprint. Retry one ambiguous intent with the same key. A changed request under that
key returns 409. The same material request converges on its retained job for that row's
lifetime. A deliberate repeat uses a fresh key; atomic pruning of a terminal row releases
the old binding, while active rows are never evicted for capacity.

`GET /api/jobs?limit=&offset=` returns the caller's jobs with active work first and then
newest terminal history. A public job exposes `job_id`, kind, actor/timestamps, status,
`progress`, bounded `failures`, full failure/truncation counts, request fingerprint,
result counts/optional `artifact_id`, public compacted parameters, and
`cancel_requested`. The additive response can also contain:

- `related.llm_batches` for `models:read`, using the safe provider Batch projection; and
- `system_workers` for `automation:read`, using the existing scheduler-health shape.

Those two sections are read-only projections, not application jobs. Scheduler health is
always list-only. A newly accepted local LLM Batch row strictly snapshots at most 200
active accounts with effective `models:read` and drives a generation-bound stable Inbox
outbox for those recipients. The note exposes bounded safe provider/model copy, request
progress, and terminal counts only—never provider handles, custom/case IDs, candidates,
or raw errors—and has no Batch Cancel, artifact, or completion toast. Authorization-store
outage remains pending/retryable; permission or account-generation loss removes and
fail-closed filters the note. The audience is frozen, so later users/grants, legacy rows,
and recipients beyond the bound remain Jobs-list-only. The bounded audience/outbox
contract is regression-backed; the Jobs projection remains authoritative for every
non-recipient.

`GET /api/jobs/{job_id}` and `POST /api/jobs/{job_id}/cancel` are self-scoped to the
exact actor/account generation. A successful cancel response waits for its transition
audit before returning `202`.
Cancellation is cooperative: queued work can stop immediately, while running work sets
`cancel_requested` and stops at a supported checkpoint without rolling back completed
items. Live grants, account generation, and step-up authority are rechecked during
execution.

`GET /api/jobs/{job_id}/artifact` returns bytes only when the terminal result has a
non-empty `artifact_id`. The server verifies the private ZIP's size and SHA-256 before
sending `Content-Type`, `Content-Length`, and a bounded attachment filename with
`no-store`/`nosniff`. No artifact returns 404; missing/pruned/corrupt retained metadata
fails instead of streaming unverified content.

Application-job progress upserts one stable per-user Inbox notification and publishes
actor-scoped SSE topic `jobs`, event type `job`, with polling as a client fallback.
Failure details retain at most 20 entries plus the omitted count. Terminal compaction
drops large inputs and item maps. Bulk-case notification URLs carry only allow-listed
current-context filters (`status`, `assignee`, or `tag`), not an exact immutable cohort.
Submission/retry, cancellation, and terminal states are audit-before-visible: successful
`202` responses wait for their transition audit, and terminal Inbox/SSE projection is
withheld until its terminal audit is confirmed. Durable reconciliation repairs an
ambiguous audit transition before projection.

Job claims and transitions use one strict-CAS StateStore registry and renewable
five-minute leases. The runner and its investigation/export concurrency remain
in-process, and the wider application is still single-replica. Factory reset replaces
the prior Jobs/Inbox/artifact state with one privileged actorless sanitized receipt. In
the supported single-backend-process profile, a default-deny HTTP mutation gate drains
admitted requests and SSE before tenant producers and detached writers are quiesced; the
reset then strictly clears tenant state and audits the actorless receipt before releasing
its Jobs, Batch, and HTTP fences. This is not a distributed transaction across arbitrary
application replicas. If that privacy boundary fails, the
application stays fenced/degraded, ordinary work remains blocked, and only a new freshly
authorized factory-reset attempt is admitted. See
[Background jobs](../operations/background-jobs.md).

## Realtime events

`GET /api/events` is a server-sent events stream. The optional `topics` query filters
the stream. Resume with the `Last-Event-ID` header or the `lastEventId` query parameter.
The server emits heartbeats; clients should reconnect and fall back to bounded polling
when the stream is unavailable. When realtime preferences disable the event bus, the
endpoint returns HTTP 204. Browser `EventSource` clients cannot set an Authorization
header, so authenticated Console subscriptions use the session cookie.

Application jobs use topic `jobs` and event type `job`; the payload is the actor-scoped
public job projection. Ordinary progress is sampled, while submission/start/terminal
transitions force publication. SSE is a nudge, not the durable registry or Inbox.

## Upstream release observations

`GET /api/releases/upstream` requires `settings:read` and returns the cached
observation for the saved `release_updates` preference. `POST
/api/releases/upstream/check` requests a refresh but still respects a five-minute
manual anti-hammering floor. A response contains the canonical repository URL, overall
check/cache metadata, and independent `stable` and `testing` channel objects:

- `state`: `available`, `unavailable`, or `disabled`;
- the configured `branch`;
- validated `version`, branch-head `commit_sha`, and safe GitHub review links when
  available;
- for Stable, the immutable `release_commit_sha` dereferenced from the exact annotated
  `vVERSION` tag plus its safe review link;
- `checked_at`, `stale`, and curated `error_code`/`error_message` fields.

One channel's failure never hides its sibling. A later transient failure can retain a
last-known-good available channel with `stale: true`; provider response bodies are not
returned. Both endpoints are discovery-only. They cannot clone, download, execute,
write Git state, deploy, migrate, restart, promote, activate, or roll back code.
The branch-head commit is review metadata only; supervised update candidates use the
Stable annotated-tag commit.

## Own-state storage lifecycle

`GET /api/storage/lifecycle` returns the desired policy, effective state, provider
capabilities, per-tier status, and a target-by-target explanation. `PUT` saves the
validated desired policy but does not silently mutate storage. `POST .../preview`
is read-only and returns the plan/blockers for the supplied or saved policy.

The canonical mutation is `POST /api/jobs` kind `storage_lifecycle_apply`, with
`acknowledge: true` and the exact saved policy snapshot. Admission is freshly
authenticated and audited; execution fails if the authoritative saved policy has
drifted. Authenticated calls to the retired `POST /api/storage/lifecycle/apply` route
receive `410 Gone` plus `durable_job_required`; it is not a synchronous bypass.

Apply is deliberately allowlisted: on Elasticsearch it can install/remove the
Agentic SOC ILM policy and lifecycle settings only for the append-only audit and
usage/cost ledgers. It never accepts an arbitrary index pattern, never rolls mutable
cases, never changes connected source retention, and never adds a delete phase.
PostgreSQL and SQLite return their honest advisory/export-only state instead of
claiming movement. AWS Glacier remains `not_configured` until an independent
checksummed export/manifest/restore pipeline exists.

## Decision previews and side effects

`POST /api/triage/preview-decision` and `POST /api/rules/preview` are preview surfaces.
They do not create a real decision or bill an LLM call. A preview is not authorization
to close or escalate a case. Actual case state transitions still pass through the
human action path or the deterministic case manager.

Secret-setting routes accept values but never return them. Subsequent reads expose
only configured booleans or configured field names. See the
[Configuration reference](configuration.md) before automating setup.

## Portable application export

`POST /api/admin/export` accepts `scopes` (`all`, `cases`, `audit`, `usage`,
`configuration`, `automation`, or `knowledge`) and `limit_per_scope` (1–5000;
default 1000). It returns a canonical `application/json` attachment with a per-scope
count/total/truncation manifest. `limit_per_scope` caps the whole selected scope;
grouped automation and knowledge collections are sampled fairly within that cap. The
Knowledge includes an exact runbook/playbook catalog-count manifest, sanitized full
Markdown for operator-owned procedures, and safe metadata/manifests (without source
content or filesystem paths) for versioned bundled procedures. The server never
traverses environment/source credentials, users, sessions, password/MFA material,
browser tokens, or upstream raw logs; a final recursive sanitizer removes
credential-shaped fields and common token/private-key patterns. Raw knowledge chunks
are also excluded. Exports are hard-limited to 25 MiB;
use fewer scopes or a lower item cap when the server returns HTTP 413. The response is
not an import/restore format. The default permission is limited to `super_admin` and
`soc_manager` through `data_export:export`, and each request is audited.

`POST /api/admin/export/archive` accepts optional `scopes` (default `all`) and is an
executable but OpenAPI-deprecated direct full-history compatibility primitive. It walks the existing bounded segment
machinery on the server, writes one `<scope>.ndjson` ZIP entry incrementally, and writes root
`manifest.json` only after every selected scope emits the record count fixed at that
scope's start. The manifest identifies
the format as `agentic-soc-portable-export-archive` version 1, records the UTC generation
time, authenticated actor, current `app_version` / `build_sha`, and for each scope its
snapshot total, exported count, completion status, consistency/PIT truth, entry name,
uncompressed byte count, and SHA-256. The server reopens the finished ZIP and streams
every member through CRC, count, size, digest, and manifest verification before auditing
or serving it.
The 200 response is `application/zip`, has a real `Content-Length`, and uses a UTC-stamped
`agentic-soc-export-*.zip` attachment filename. Any incomplete or unverified walk,
unavailable strict registry/audit store, expired snapshot, failed late fresh-auth check,
or disk/write error returns non-2xx before an archive is served. The temporary artifact
and any open PIT are released on success, failure, request cancellation, or streaming
disconnect.

The direct archive route is synchronous and uses temporary server disk; artifact delivery is
atomic in the narrow sense that HTTP response headers do not start until the complete ZIP
has passed integrity checks. It is not one cross-scope database transaction. Each scope
declares its own consistency: only `exact: true` proves fixed membership and values;
PostgreSQL `bounded_at_start` means that the starting count was emitted while OFFSET pages
may reflect concurrent changes. The backend permits one archive build/download per process
and preserves 64 MiB of temporary-filesystem free space; another request returns 409 and
insufficient space returns 507. The bundled Console proxy allows five minutes. For a dataset
that may exceed that proxy/ingress window or available temporary-disk capacity, use the
application-job contract or the direct advanced segment contract below. External
reverse proxies need a compatible upstream timeout; increasing a timeout does not turn
this support artifact into a backup.

The primary Console workflow submits `data_export_archive` or `data_export_segment`
through `/api/jobs`. Both run server-side after `202 Accepted` and persist one verified
ZIP behind the terminal job's `artifact_id`. The segment job follows all scope cursors
and packages the numbered JSON envelopes itself; the browser does not collect them.
Artifact storage/retention and cooperative cancellation follow the application-job
contract above.

For all records in a selected supported safe scope, direct advanced clients may use the
executable but OpenAPI-deprecated `POST /api/admin/export/segment` compatibility
primitive with `scope`, optional opaque `cursor`, and
`page_size` (1–5000). The 5,000 value is a per-response/segment safety bound, not a
lifetime cap. Follow `segment.next_cursor` until `segment.complete` is `true`; never
infer completion from a short page. Compact JSON responses are individually capped at
25 MiB and may reduce `actual_page_size`; the Console saves that compact payload rather
than inflating it with display whitespace. `consistency` declares whether the scope is an exact
Elasticsearch point-in-time snapshot or a weaker bounded/live read. Elasticsearch
PIT cursors are renewed per page with a ten-minute keep-alive. Every continuation is
HMAC-authenticated, bound to the requesting operator, scope, and snapshot, and checked
for internally monotonic counters/position. A cursor is not transferable. Expiration,
backend restart, or an invalid cursor requires restarting that scope. Call
`POST /api/admin/export/segment/cancel` with the scope and last cursor on cancellation.

The archive and segment routes require both `data_export:export` and fresh authentication.
Archive permission and freshness are checked again after assembly. Its strict audit row
records a prepared, authorized artifact before network streaming; it cannot prove that the
client received every byte. Knowledge/automation registry reads and the audit write are strict: an
unavailable or malformed backing collection returns HTTP 503, releases an active PIT,
and never emits a truthful-looking `complete` response.
Cases, audit, and usage are store-paginated; automation and knowledge remain KV-backed
collections that are materialized before the response page is sliced. That is a known
large-catalog memory limitation. These routes cover only the documented safe scopes,
not chat history, collaboration, user preferences, identity/session state, raw RAG
chunks, credentials, or upstream logs; they are not a whole-application backup.

## Compatibility expectations

The 0.1 API favors additive fields and stable existing paths, but it is still a
pre-1.0 contract. Pin clients to an application patch version, tolerate unknown
response fields, regenerate typed clients when the OpenAPI snapshot changes, and
test against the `Testing` branch before promoting the accepted source tree to
`main`/Stable and re-running the gate on the resulting commit.
See [Compatibility](compatibility.md) and [Documentation versions](../releases/documentation-versions.md).
