---
title: Background jobs
description: Operate durable long-running work, progress, cancellation, result links, and verified artifacts in Agentic SOC 0.1.
---

# Background jobs

Agentic SOC runs long operations as server-owned background jobs. After the Console
accepts a submission, the work is no longer tied to the page that started it: it can
continue while the operator navigates elsewhere or reloads the browser.

Open **Analytics → Jobs** to see your application jobs. The same application jobs
update durable entries in **Inbox**. A terminal transition may also produce one
short-lived toast, but the toast is only a convenience; the Jobs list, Inbox entry,
result counts, failure summary, audit trail, and any retained artifact are the
authoritative surfaces.

## Work that uses the job system

The current job registry covers:

- Case Manager bulk reinvestigation, lifecycle changes, assignment, and tagging;
- Data export archive and full server-side segment collection;
- resolved-case precedent bootstrap;
- Runbook retrieval reindex;
- bounded Knowledge imports;
- knowledge-corpus rebuild (`rag_rebuild`);
- cases, sources, and factory reset;
- Storage & retention policy apply; and
- read-only projections of related asynchronous LLM Batch work and scheduler health.

Each submission snapshots its validated parameters. Changing a Case Manager selection,
editing a saved policy, or leaving the page after the server returns `202 Accepted`
does not mutate that job's input.

The Console and documented user workflows are Jobs-only for long work. A narrow set of
direct APIs remains executable for compatibility clients: archive export, advanced
segment export, precedent bootstrap, RAG import, and full-catalog Runbook reindex.
Those routes are explicitly marked deprecated in OpenAPI and retain their request-bound
or synchronous limits; they are compatibility primitives, not alternate Console
workflows or a reason to keep a browser open. Targeted single-Runbook reindex remains a
normal direct catalog operation.

Reset and storage lifecycle mutation have no synchronous bypass. Authenticated calls to
the retired `POST /api/admin/reset` and `POST /api/storage/lifecycle/apply` seams return
`410 Gone` with `durable_job_required`; their canonical mutations are the corresponding
`tiered_reset` and `storage_lifecycle_apply` submissions to `POST /api/jobs`. Storage
policy GET/PUT and preview remain direct operations.

The application updater is **not** part of this registry. It retains its separate,
hardened supervisor-owned job and receipt protocol under `/api/system-updates/*`.
Application background jobs neither replace nor relax that update boundary.

### Rebuilding the knowledge corpus

`rag_rebuild` reprojects the whole enabled knowledge corpus. It takes no parameters —
the failure it recovers from is "the corpus is gone and nothing will bring it back",
and asking an operator to first work out which sources are missing would reintroduce
exactly the diagnosis step that makes this expensive. It requires `rag:manage`.

The rebuild is **idempotent and non-destructive**. It reuses the same
staged-then-verified projection path as ordinary seeding, so it either converges on the
identical corpus (document ids are stable, so a repeat never duplicates) or it is
refused and the existing corpus is left untouched. A refused rebuild finishes as
`failed`, never as a success with zero documents, so "the corpus is still broken" can
never read as done.

Use it when health reports an empty corpus or a refused projection. If the rebuild is
refused, fix the underlying cause first — most often the embedding provider — because
the product deliberately refuses to persist chunks embedded in a degraded fallback
space. See [troubleshooting](troubleshooting.md).

Most recoveries need no job at all: the corpus rebuilds on its own once the provider
recovers.

## Lifecycle and visibility

An application job moves through `queued` and `running`, then finishes as one of:

| Status | Meaning |
| --- | --- |
| `succeeded` | All admitted work completed successfully. |
| `partial` | Some items completed and at least one item failed. |
| `failed` | The operation could not produce its intended result. |
| `cancelled` | A cancellation request was honored at a safe checkpoint. |

Progress is reported as completed and total units. Item jobs also retain aggregate
success/failure counts. Detailed failures are bounded to the first 20 safe summaries;
`failure_count` and `failures_truncated` preserve the full count without retaining an
unbounded error body.

The Console listens for actor-scoped `jobs` SSE events and polls as a fallback. The
server samples ordinary progress only after at least one second and a five-percentage-
point advance, while submission, start, and terminal transitions are forced. Reloading
the Console does not replay old terminal toasts. A job accepted by the current browser
is remembered across a reload so an unusually fast terminal transition is still
announced once. Inbox remains durable whether or not a toast appears, the operator is
offline/logged out at completion, or the Inbox item has already been marked read. Active
job entries are protected from ordinary bounded-ring eviction.

Application job rows are self-scoped by the server. Listing, detail, cancellation, and
artifact access require the exact live actor/account generation plus `inapp:read`.
Admission enforces the operation-specific grants, and execution rechecks those grants.
Data export, reset, and storage apply also require fresh authentication. Losing required
authority while work is running fails the job closed at a checkpoint; it does not turn
the worker into a detached privilege.

Job submission and lifecycle transitions are append-only audited before they become
externally successful or visible. Submission/retry and cancellation do not return their
successful `202 Accepted` until the corresponding transition audit is confirmed;
terminal Inbox and SSE projection likewise waits for the terminal audit. Durable
reconciliation repairs an ambiguous or missing transition audit before releasing that
state to projections. An execution does not continue past an unaudited required
transition. Cost-bearing reinvestigation still uses the existing pipeline, single model
gateway, usage ledger, budget gate, and configured concurrency cap; the job runner is
orchestration, not an alternate decision or billing path. Deterministic `decide()`
authority is unchanged.

## Idempotency and deliberate repeats

The Console creates one idempotency key per user intent and retains that same key across
an ambiguous submission retry. A double-click or uncertain network result therefore
converges on the accepted job instead of starting parallel copies. Once submission is
conclusively accepted, a later deliberate repeat creates a new intent and a new key.

On the server, the key is actor/account-generation scoped and bound to a canonical
request fingerprint. Reusing a key with different material parameters returns `409`.
The binding remains for the lifetime of the retained job row, so a retry of the same
intent converges on that job even after it is terminal. Deliberate repeats must use a
fresh intent key. Atomic pruning of a terminal row releases its old binding; active
work is never evicted merely to admit another request. This is request deduplication,
not an exactly-once guarantee for every external side effect.

## Cancellation and recovery

Cancellation is cooperative:

- a queued job can become cancelled before work starts;
- a running job records `cancel_requested` and stops at the next supported checkpoint;
- work already committed is not rolled back; and
- an operation can therefore end cancelled after some progress is visible.

Job state lives in one strict-CAS StateStore document. Claims, heartbeats, transitions,
progress, terminal compaction, and artifact attachment use revision-checked mutations so
two writers cannot silently overwrite one another. The in-process runner holds a
five-minute renewable lease and heartbeats at least once per minute. After a process
loss, the restarted service's runner can reclaim expired work instead of leaving it
permanently running.

Recovery distinguishes repeat-safe work from ambiguous state-changing work. Export,
precedent bootstrap, and Runbook reindex handlers may retry an item that was processing
when a lease expired. For an unsafe state-changing item, the ambiguous item fails closed
rather than being applied a second time. Already recorded items are not re-run.

The CAS and lease machinery protects this bounded job registry; it does **not** make the
whole application active-active. Investigation concurrency, the background-versus-ingest
priority gate, export assembly slot, realtime fan-out, receivers, schedulers, and several
other authorities remain process-local. Operate one backend replica. With
`caps.max_concurrent > 1`, background reinvestigation reserves headroom for foreground
ingest; the reservation is also per process, not a distributed provider semaphore.

## Result links are context, not exact cohorts

Bulk case jobs open a safely allow-listed Cases view. Depending on the operation, the
link can seed a curated status, exact assignee, or exact tag filter. Values are bounded,
normal Unicode text is URL encoded, and malformed or unknown routes fail closed.

These links are useful **current-context filters**, not immutable lists of every case
that the job attempted. A case can move again after completion; an active/status filter
can include other matching cases; and the compact terminal record intentionally does not
retain or expose an unbounded case-ID cohort. Use the job's counts and failures together
with case history and Audit when exact accountability matters.

## Downloadable artifacts

Only a terminal result with a non-empty `artifact_id` displays **Download**. The server
returns verified bytes through `/api/jobs/{job_id}/artifact`; it does not accept a client
file path or arbitrary artifact URL.

Data export archive and segment jobs each produce one server-managed ZIP. Segment mode follows
the selected scope cursors on the server and packages the numbered JSON envelopes into
that single ZIP, so the browser is not responsible for collecting a sequence of files.

Artifact storage has a separate persistence and retention boundary:

- the local default is `./data/job-artifacts`;
- the updater-managed standalone profile keeps that local default; use a reviewed
  override/bind mount if files must survive container replacement;
- the legacy merge profile overrides it with `/var/lib/agentic-soc/jobs` on a
  persistent named volume;
- the artifact root is private (`0700`) and files are private (`0600`);
- IDs and filenames are server-generated, and only ZIP artifacts are admitted;
- size and SHA-256 are verified on every download;
- at most the newest 50 attached artifacts are retained; older job records can remain
  after their artifact metadata and file are pruned; and
- unreferenced files older than two lease windows are cleaned during recovery, while
  active reserved IDs are protected.

Artifact retention is count-based, not a backup policy. A missing, expired, or failed
integrity check is reported instead of streaming unverified bytes. Download important
exports promptly and move them into an independently controlled retention system.

## Application jobs, LLM Batch, and system workers

The Jobs page has three distinct scopes:

1. **Application jobs** are the signed-in actor's server-owned work and are visible to
   ordinary authenticated operators who can use Inbox.
2. **Related LLM Batch jobs** are a read-only provider-batch projection shown only with
   `models:read`. They have their own provider lifecycle and do not gain application-job
   cancellation, artifact, or completion-toast actions.
3. **System workers** are read-only scheduler health shown only with `automation:read`.
   Rows cover `threshold_tuner`, `campaign_correlation`, `baseline_producer`, and
   `batch_jobs`; they never create personal Inbox entries. `baseline_producer` is
   event-driven (`cadence=on_ingest`) and reports ready/running when learning is enabled
   outside Demo. The page-level `scheduler_runtime_running` flag applies only to the
   cadence loops, not this ingest-driven producer.

For every newly accepted local Batch row, the server strictly snapshots at most 200
active accounts whose effective grants include `models:read`. That frozen,
account-generation-bound audience drives a durable outbox: one stable Inbox note per
recipient is upserted through running and terminal states. The note contains only bounded
safe provider/model labels, request progress, and terminal succeeded/failed/total counts.
It never exposes the provider batch handle, custom or case IDs, candidate payloads, or a
raw provider error.

An authorization-registry outage does not guess recipients or block provider work: the
audience remains pending and reconciliation retries. If a recipient loses `models:read`
or the username is deleted/recreated, the old generation's note is removed and
fail-closed filtered from reads/realtime. The audience does not expand after acceptance,
so later users/grants, legacy Batch rows without a snapshot, and recipients beyond the
200-entry bound remain Jobs-list-only. A missing personal note therefore does not imply
the provider Batch is missing. This bounded audience/outbox contract is accepted with
strict-store outage, stable-retry, permission-loss, account-generation, reset-fence, and
live-filter regressions; the Jobs list remains authoritative for every non-recipient.

## Factory reset privacy boundary

A factory-reset job fences new application-job admission, requests other active jobs to
stop, waits a bounded time, and purges the prior Jobs registry, personal Inbox state, and
job artifacts as part of its reset path. It must not promise a personal Inbox result that
the factory operation itself removes.

The Jobs registry retains one actorless, terminal, sanitized operational receipt. It is
visible only to callers with `users:manage` and is limited to scope, timestamps, status,
counts, and non-secret build identity. It contains no actor, request parameters,
idempotency material, item IDs, failure bodies, session authority, or artifact. Factory
reset also starts a new audit lineage rather than preserving the old personal history.

In the supported single-backend-process profile, factory reset first closes global HTTP
mutation admission, wakes and drains SSE, stops pollers/receivers/schedulers, cancels
tracked detached tenant writers, and tears down Demo Mode. It then strictly clears
tenant-owned cases, cursors, RAG, usage and idempotency claims, audit, every non-protected
KV namespace, personal projections, cache/EventBus state, and runtime secret overlays.
The exact Jobs and Batch fence documents plus updater-operation records are the only
temporary storage exceptions; the old Jobs registry is then compacted to the receipt
above. The Batch, Jobs, and HTTP fences are released only after the actorless reset action
and receipt transition are durably audited. This is an exact single-process boundary,
not an atomic distributed reset across arbitrary application replicas.

If the factory privacy boundary cannot complete, the application remains fenced in a
degraded state rather than reopening ordinary work around a partial purge. Ordinary job
admission stays blocked. The only permitted recovery mutation is a new, freshly
authorized factory-reset attempt; diagnose the failed boundary, reauthenticate, and
retry factory reset instead of submitting non-factory work.

## Capacity and retention

The registry retains at most 1,000 jobs and never evicts active work to make room. It
also bounds active canonical parameters to 8 MiB in aggregate. Large Knowledge imports
are pre-bounded in the Console (up to 20 documents, with aggregate UTF-8 headroom), but
concurrent active work can still make the server return a capacity error. Retry later
with the same intent key if admission was ambiguous; submit a new intent only when the
previous result is conclusive.

Terminal jobs compact large inputs and per-item maps. The retained record is designed
for status, counts, bounded failures, result navigation, and audit correlation—not as a
copy of every submitted document or case ID.

## Troubleshooting checklist

1. Open **Analytics → Jobs** and record the job ID, kind, status, progress, and safe
   failure summary.
2. Check **Inbox** for the stable application-job entry. Scheduler health is always
   list-only. For an LLM Batch row, confirm it was newly accepted after audience support,
   the account was inside the frozen effective-`models:read` snapshot, and the audience
   bound was not exceeded; later grants do not backfill a note.
3. If SSE is unavailable, leave the page open for polling or use **Refresh**; navigation
   does not cancel server work.
4. If cancellation remains pending, wait for the next cooperative checkpoint. Do not
   assume already completed items will be undone.
5. For a missing artifact, confirm the result ever carried an `artifact_id`, then check
   the persistent artifact volume, retention count, permissions, and integrity logs.
6. After a process restart, allow the five-minute lease to expire before declaring a
   running job orphaned.
7. Correlate the job's audit transitions before manually repeating a state-changing
   operation.

See [Notifications](../administration/notifications.md),
[Case Manager](../analyst/case-manager.md), [Settings](../administration/settings.md),
[Reset and recovery](../administration/reset.md), and
[Known limitations](../releases/known-limitations.md).
