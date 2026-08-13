---
title: Known limitations
description: Release gates and explicit operating constraints for Agentic SOC 0.1.13.
---

# Known limitations

This list is part of the product contract for Agentic SOC `0.1.13` in Testing and,
if the exact verified commit is published, its Stable artifacts. It distinguishes
release gates from documented beta constraints so a green unit-test suite is never
mistaken for release or production evidence.

## Release gates

### Repository protections require administrator verification

The canonical `Testing` and default `main` branches now exist, but branch protection,
required checks, Pages source, and environment rules are GitHub repository settings;
the application source cannot enforce or attest to them.

**Required control:** require the fail-closed `CI passed` aggregate and reviewed
promotion into `main`, set Pages source to **GitHub Actions**, and protect the
`github-pages` environment as appropriate. Verify those settings before treating a
new commit or documentation deployment as accepted merely because its workflow ran.

### No project license

The repository does not contain a `LICENSE` file. Publicly visible source is not
automatically open source and does not grant redistribution rights.

**Required decision:** choose and commit the intended license before publishing
binaries, containers, or an “open-source” announcement. Apache-2.0 is permissive and
patent-explicit; AGPL-3.0 requires network-service modifications to be offered to
users. This is an owner/product decision and must not be guessed by automation.

### Signed update acceptance is external to local unit tests

The updater protocol, release plan, signature verification, rollback state machine,
and reference Compose contracts have offline coverage. That does not prove the exact
published `v0.1.13` images and signed assets work through a real PostgreSQL Compose
upgrade, interruption, cancellation, automatic rollback, and post-success rollback.

**Required control:** after the exact accepted `main` commit passes remote CI, publish
the immutable tag artifacts, then run the documented isolated signed-update acceptance
matrix against those public digests before enabling the Console update action for a
supported deployment. Keep the action fail-closed until that evidence exists.

## Priority beta limitations

The following constraints limit reproducibility, durability, topology, or stronger
production claims. They remain explicit engineering priorities, but they are not all
automatic blockers to publishing a clearly labelled beta release within its stated
support boundary.

### Published release inputs are not fully reproducible

The immutable Stable-tag workflow now requires the annotated `vX.Y.Z` tag to resolve
to the exact accepted `main` commit and pass the fail-closed CI aggregate. It builds
multi-architecture backend, Web, and updater images once, publishes exact GHCR
digests, emits SBOM/provenance attestations, signs every image and the declarative
upgrade plan with the tag-bound GitHub Actions identity, and attaches the plan and
Sigstore bundle to the GitHub Release.

Transitive Python resolution and container base images are not yet locked by reviewed
hash/digest constraints. An attempt that fails before an exact draft contains its
canonical plan can therefore resolve different upstream inputs when rerun. The draft
is not public: the workflow stages both assets, downloads and byte-compares them, and
verifies the signature before publishing it in one transition. A rerun may clean an
interrupted `starter` upload or resume an exact tag/SHA draft, but never changes a
published release. A complete plan pins the resulting application images exactly; a
partial published asset set fails closed and requires a new patch release, and the plan
does not prove its transitive inputs reproducible.

**Required change:** generate reviewed hash-locked Python constraints, pin every base
image and tool action by immutable digest or commit with an update policy, record and
compare a complete materials manifest, then prove reproducible rebuilds before making
that stronger claim.

### Push receipt is not durable

Receivers currently normalise and process a batch in the backend process. Processing
errors propagate so retry-capable transports can avoid acknowledging failed work,
but there is no transactional receipt/inbox committed before correlation.

Consequences:

- a process or host loss inside the receipt/processing window can lose an HTTP or
  lossy-syslog event;
- there is no durable poison-event ledger or replay control;
- queue acknowledgement behaviour must be certified per adapter;
- receipt lag and oldest-unprocessed age cannot be measured centrally.

**Required change:** durable receipt + idempotency key + outbox, acknowledge only
after receipt commit, retry workers, and a bounded dead-letter/replay workflow.

### Receiver checkpoints are not uniformly durable

Durable brokers retain acknowledged offsets, and the ES-compatible pull path now has
a persisted cursor. Kinesis sequences and S3/GCS/Azure object markers now persist
through the configured StateStore after successful processing. Local-file byte
offsets and the default Event Hubs checkpoint path remain process-local. Restart can
therefore replay or miss file data depending on start settings, while Event Hubs
durability depends on wiring a supported checkpoint store.

**Required change:** persist per-source/partition/object/file checkpoints only after
durable receipt, or require a native durable consumer/checkpoint store. Test crash and
restart at every boundary, object overwrite/late arrival, file rotation, broker
rebalance/reshard, and checkpoint corruption. Publish the actual guarantee per
connector rather than one umbrella “durable” claim.

### Dynamic secrets do not survive restart

Per-source, notification, SSO, and locally registered model secrets entered through
the UI/API live in process memory. Their configured field names may persist, but the
values disappear when the backend restarts.

**Required change:** integrate a supported secret manager or encrypted secret store
with rotation, versioning, audit, and explicit backup/restore semantics. Environment
variables are a temporary boot-time path, not a complete multi-source lifecycle.

### No versioned database migrations

SQL state uses idempotent `create_all` and shared KV documents. There is no Alembic
or equivalent ordered schema/data migration ledger, compatibility gate, or downgrade
plan.

**Required change:** version every persisted schema and data transform; test clean
install, forward upgrade, backup/restore, interrupted migration, and supported
rollback for PostgreSQL. SQLite may remain a single-node evaluation profile.

### Open-case identity is too entity-centric

Configured sources now scope the active signature by source, so the same entity from
source A and source B creates distinct cases that the related-case/campaign layer can
link. Within one source, however, identity is still essentially
`(source_id, entity_type, entity_value)`. While a case remains open, a later and
potentially unrelated rule family or distant episode on the same user, host, or
address can attach to it. The legacy unconfigured path remains entity-only. This can
over-merge distinct stories and distort evidence, risk, ownership, and timing.

**Required change:** version the case-signature policy and add a bounded incident
episode or strong native lineage within each source. Keep deterministic
event/detection idempotency separate from the decision to attach, relate, or open a
new case. Add tests for retries of one incident, distinct rules on the same entity,
NAT/shared IPs, distant/reopened activity, legacy migration, and cross-source
related-but-not-merged cases.

## Version 0.1 constraints

### One-click updates support one deployment profile

The unpublished 0.1.2 snapshot introduced source discovery and coherent-pair
activation but did not publish the host supervisor or signed upgrade plan. Version
0.1.13 carries the version-1 supervisor protocol and canonical base-Compose contract
without broadening its supported topology. It still cannot retroactively install a
privileged host component. A supported canonical v0.1.1 installation requires one manual
`scripts/bootstrap-updater.sh` step from the clean, exact annotated `v0.1.13` tag whose
commit remains contained in `origin/main`; that step delegates the full
v0.1.1→v0.1.13 transition to the signed plan. That tag is not an installation source
until the complete signed publication and canonical runtime acceptance evidence exists.
Testing/source-built 0.1.3 and the
non-installable v0.1.4/v0.1.5 attempts, plus the published-but-bootstrap-blocked
v0.1.6 through v0.1.8 records, failed-publication v0.1.9 through v0.1.11 records,
and the fully published but bootstrap-blocked v0.1.12 record must instead be
reconciled according to their actual installed state and cannot be relabelled
Stable. Version 0.1.7's public, signed artifacts remain an immutable
publication record, but its updater could not create the control socket under the
shipped capability boundary. Version 0.1.8 corrected that startup contract but
canonical bootstrap then failed when cosign 3 tried to initialize its default TUF
cache beneath the read-only `/root` filesystem. Version 0.1.9 placed that trust state
on the writable updater-state volume and replaced an inspectable idle mismatched
supervisor before plan verification, but its constrained updater could not traverse
the runner-owned verification bind source. Its workflow stopped before attestations,
GitHub Release publication, canonical plan assets, Stable convenience tags, or
Stable documentation. Version 0.1.10 corrected that fixture permission boundary but
its signed-release workflow then timed out while the architecture-neutral Web Console
builder ran under target emulation. It published no complete three-image set,
canonical signed plan, GitHub Release, Stable tags, or Stable documentation and is
immutable, superseded, and non-installable. Version 0.1.11 retained the trust and
traversal corrections and moved only architecture-neutral Console builder work to
BuildKit's native platform; the final nginx runtime remained target-specific. Its
workflow then built, signed, anonymously proved, and verified all three images and
its plan, including inside the constrained updater, but post-verification cleanup
failed before attestations, GitHub Release, canonical asset, Stable-tag, or
Stable-documentation publication. It is immutable, superseded, and non-installable.
Version 0.1.12 restored the runner-owned fixture directory to mode `0700` only after
verifier exit, then removed it. That release completed its entire signed/public
publication gate, but canonical v0.1.1 bootstrap failed closed before application
mutation because both legacy images omit the state-schema label and one absence was
normalized while the other remained raw. Version 0.1.13 normalizes matching absent
legacy schema labels symmetrically while retaining every mixed/later-identity
rejection. It changes no application schema, updater protocol, publisher identity,
process privilege, trust predicate, or frozen-base bytes.
Subsequent compatible Stable releases can be installed from the Console only for
the reference, single-replica
standalone Docker Compose topology with PostgreSQL-owned state, durable authentication/secrets, a
coherent known build/schema identity, a base Compose file matching the signed
canonical SHA-256, canonical project/network/service and PostgreSQL-volume identity,
and a signed plan whose migration strategy is `none`.

The updater never transports or replaces the base Compose file. The 0.1.x protocol
pins its version-invariant bytes in `deploy/update-base-v1.sha256`, while signed
release overrides carry component versions and digests. Sequential patch upgrades
therefore retain one base; changing it requires a new protocol and manual bootstrap.

PostgreSQL and Redis infrastructure images are deliberately unchanged. SQLite,
Elasticsearch-owned state, external PostgreSQL, the legacy ELK composition,
custom/forked Compose layouts, Kubernetes, horizontal replicas, runtime-only UI
secrets, migration-bearing releases, and incompatible updater protocols are blocked
with a manual remediation. Automatic rollback depends on retained prior application
image IDs and never restores PostgreSQL. The verified quiesced dump is a break-glass
artifact for explicit operator recovery; a host or storage failure that destroys
those recovery assets remains a manual disaster-recovery event. Image rollback cannot
undo an incompatible data change, which is why migration-bearing plans fail preflight.
Supervisor self-replacement uses a restartable helper whose name-swap transaction is
idempotent across ordinary helper-process, Docker-daemon, and host restarts. A failure
that prevents Docker and all of its containers from running, or destroys Docker
metadata/storage, remains an operator-owned host recovery event.
After bootstrap, raw Compose invocations are unsupported; use
`scripts/agentic-soc-compose.sh` so the active digest override remains in force and
mutating lifecycle commands serialize with the supervised updater. The guard cannot
protect an operator who deliberately bypasses it with raw Docker or Compose commands.
An unknown, malformed, or orphaned durable update marker intentionally fails closed
and requires operator reconciliation; only an exact terminal ledger job is cleared
automatically after restart.

The supervisor has Docker-socket authority, which is effectively root-equivalent on
the host, and is therefore part of the trusted computing base rather than an ordinary
application sidecar. Official update plans are also anonymously pull-only: the three
GHCR packages must be public because the supervisor intentionally stores no registry
credential. See [Upgrades](../operations/upgrades.md).

### Updater artifacts are not auto-pruned

The updater foundation included in version 0.1.13 retains updater jobs, preflights,
signed plan assets, receipts, and deployment snapshots in the updater-state volume
and verified PostgreSQL dumps in the
updater-backup volume. It does not implement age-, count-, or status-based pruning.
Operators must monitor capacity for both volumes and retain, at minimum, every active
job, the latest terminal record, the current installed release's rollback evidence,
any terminal outcome not yet mirrored into application audit, and every break-glass
artifact still covered by local policy.

History is eligible for operator-controlled archive or removal only after a later
successful release supersedes its rollback authority, its exact terminal transition
is confirmed in append-only application audit, and backup/retention policy permits.
There is no supported live per-record purge in this release. Automatic cleanup needs
a future updater/backend protocol that acknowledges the audit mirror, identifies the
authoritative rollback generation, carries policy holds, and commits crash-safe
retention decisions; the updater cannot safely infer those facts from timestamps or a
terminal status alone.

### Single replica only

Run exactly one backend replica. Signature locks, receiver ownership, schedulers,
recent-event buffers, and the realtime event bus are process-local. The storage
abstractions do not yet provide all of the leases, uniqueness constraints, and
atomic claims needed for active-active replicas.

Adding replicas now can duplicate cases or scheduled work, lose receiver ownership,
and deliver inconsistent live updates. The [scale-out roadmap](../architecture/ingestion.md#scale-out-roadmap)
defines the required worker/lease split.

Application background jobs do use strict-CAS mutations and renewable five-minute
leases. That narrow registry protection is not a distributed application runtime: the
runner, foreground-priority investigation gate, archive assembly slot, Inbox/SSE fan-out,
receivers, and schedulers retain process-local authorities. Continue to operate exactly
one backend replica.

### Background-job recovery, cancellation, and retention are bounded

Cancellation is cooperative and does not roll back completed items. After a lost lease,
repeat-safe export/precedent/Runbook work can retry an ambiguous item; unsafe
state-changing items fail closed rather than risk a duplicate effect. This is safer than
blind replay but is not a cross-system exactly-once transaction.

Successful submission/retry and cancel responses, plus terminal Inbox/SSE projection,
wait for the corresponding transition audit. Durable reconciliation repairs an audit
gap before projection. An audit-store outage can therefore delay visible acceptance or
completion even when underlying work is otherwise ready; this is the intended
audit-before-visible boundary, not permission to bypass the Job with a new request.

The strict-CAS registry retains at most 1,000 jobs and 8 MiB of active canonical
parameters. Terminal compaction removes large inputs/item maps and retains only bounded
failure detail. ZIP artifacts are separate filesystem state, count-pruned to the newest
50 attachments, and can disappear while the terminal job record remains. Download and
retain important artifacts independently.

Case completion links deliberately carry a privacy-bounded current status/assignee/tag
context rather than every attempted case ID. They can include other matching cases or
omit a case that changed again, so they are not exact immutable result cohorts. Audit,
case history, job counts, and bounded failures are the accountability sources.

The unified Jobs page projects related LLM Batch records for `models:read`. Only newly
accepted local rows freeze a strict, generation-bound audience, capped at 200 active
effective-`models:read` accounts, and reconcile one stable safe progress/terminal Inbox
note per recipient. Strict authorization-store outage stays pending/retryable;
permission or generation loss removes and fail-closed filters a note. The audience does
not expand later, so legacy rows, later users/grants, and recipients beyond the bound
remain list-only. Notes expose bounded provider/model copy and counts only and have no
Batch Cancel, Download, or completion toast. The bounded audience/outbox contract is
regression-backed; the Jobs list is authoritative for every non-recipient. Scheduler health is intentionally list-only
and never personal Inbox work.

Factory reset's job registry retains only one privileged actorless sanitized receipt
after purging prior Jobs, Inbox state, and artifacts. The supported single-backend-process
profile closes and drains HTTP mutation admission/SSE, quiesces tenant producers and
detached writers, and strictly clears all non-protected tenant StateStore data plus RAG,
usage/audit ledgers, runtime projections, and runtime secret overlays before auditing the
receipt and releasing its fences. This guarantee is process-local; do not claim an atomic
distributed factory reset across arbitrary application replicas. There is no synchronous reset bypass:
the retired `POST /api/admin/reset` route returns 410 and canonical mutation is a
`tiered_reset` Job. A privacy-boundary failure leaves the application fenced/degraded,
blocks ordinary work, and admits only a new freshly authorized factory-reset attempt.

### Volatile push evidence and realtime replay

Push-source browse/live-tail keeps only the latest 500 events per source in process
memory. Realtime SSE replay is also process-local. Restarting the backend clears
both, and another replica would not share them.

Cases retain selected event IDs and evidence, but the suite does not yet provide a
durable raw-event archive for pushed data. Keep the authoritative event in the
source/broker/object store during evaluation.

### Receiver supervision is process-local

Source create/update/delete and secret rotation now reconcile the live receiver set
with a coarse stop-and-rebuild cycle. A failed long-running receiver is restarted
with bounded exponential backoff, preserving broker redelivery after processing
errors. There is still no persisted last-error/restart state, lease, or distributed
ownership, and a permanently invalid configuration retries locally until corrected.
Verify the health/coverage surface after topology changes and alert on repeated
receiver restart logs during evaluation.

### Pull replay and late-arrival handling are bounded

Elasticsearch uses a PIT with `search_after` and a stable `_shard_doc` tie-breaker;
OpenSearch/Wazuh-compatible endpoints can fall back to offset paging when PIT is not
available. Each tick is bounded to 64 frontier pages and 32 late-overlap pages, with
remaining frontier rows continuing on the next tick. The late-event-time overlap is
five minutes and its exact recent-ID ledger is capped at 100,000 entries; saturation
disables optional late acceptance rather than risking replay.

The first-class Elasticsearch path uses PIT. The offset fallback is safe for a
quiescent view but is not claimed exactly-once while an index refreshes. Monitor
cursor saturation/catch-up lag and retain the source long enough to replay events
outside the five-minute overlap.

### Default event routing requires workload calibration

Source-native alert feeds are prioritised for investigation. Raw event feeds use a
pre-enrichment routing score normalised over the signals that are actually available,
plus per-tick and hard daily-budget bounds. Extreme zero-config bursts can now cross
the balanced floor while ordinary activity remains a candidate; the canonical
persisted risk score and deterministic case decision are unchanged. These profile
floors have not yet been benchmarked across representative source mixes. Candidates
deferred only by the per-tick cap are now read from durable case state and drained on
a later quiet tick; risk/policy candidates intentionally await operator action or new
evidence.

Do not assume “all events are read” means “all events receive an LLM call.” That
would be prohibitively expensive. Validate that enabled deterministic detectors,
baselines, and risk settings produce the expected candidates and latency for each
source.

### Noise Reduction case drill-down is bounded by the loaded Cases window

Noise Reduction aggregate counts can cover more records than the Cases page loads in
one request. Outcome activation applies the exact Auto-cleared, Escalated, or
Closed-by-human definition and selected time window to that loaded set, but the visible
rows are a lower bound when the case store reports more records than were fetched.

Use the aggregate stage count, counter-coverage state, and truncation notices for volume
reporting. A complete drill-down requires server-side time/outcome filtering with
cursor pagination rather than a larger hard client limit.

### Baseline learning and anomaly promotion are separate

The normal pull/push path now observes and persists aggregate-only source and cluster
volume series, so the baseline genuinely warms across restarts without retaining raw
logs or affecting case decisions. Its realtime anomaly signal remains advisory. An
automatic anomaly detection is promoted through the separate event funnel only when
that funnel's baseline/batch gates are enabled.

Before treating adaptive detection as autonomous, validate warm-up, late data,
poisoning bounds, drift, false-positive feedback, candidate deduplication, and
rollback on a replayable workload. Keep baseline changes versioned and outside the
deterministic close/escalate policy.

### The daily budget is a preflight ceiling, not an atomic reservation

The default application budget is enabled at `$10/day`, warns at 80%, and blocks new
provider calls over the ceiling; a blocked investigation persists/fails safe to
`NEEDS_HUMAN`. The check does not reserve spend atomically, so calls already in flight
can finish above the boundary. It also cannot prevent costs created outside this
backend. Keep concurrency conservative, configure provider-side budgets/rate limits,
and alert on ledger/provider disagreement.

### Discounted inference depends on provider capacity and reporting

Compatible official OpenAI alert/case work prefers live Flex, but Flex is a
best-effort service tier. Eligibility is intentionally narrow and the configured
standard fallback may cost more than Flex. The Agentic SOC ledger records the tier
actually returned; it remains an estimate and must be reconciled with provider
billing. The separate asynchronous Batch queue is opt-in and can add material
latency or return results out of order.

Batch submission uses a durable five-minute lease so the immediate submit path and
the scheduler do not POST the same local outbox concurrently. Provider acceptance and
local provider-ID persistence still cannot be one transaction; a process failure in
that narrow boundary can be retried after lease expiry because neither bundled API
offers a universal recovery/idempotency key. SQL-backed state uses an atomic revision
predicate across workers. The bundled Elasticsearch state path uses native
sequence-number/primary-term optimistic concurrency (and create-only insertion) for
the shared Batch registry, so submission and re-entry claims are CAS-safe across
backend workers. This narrow Batch guarantee does not remove the application-wide
single-replica constraint above: receivers, schedulers, case signatures, recent-event
buffers, and realtime delivery still lack distributed ownership.

### Portable export is not backup or tenant isolation

The primary Data export workflow now submits a background archive or segment job. Both
walk every selected scope server-side and retain one verified ZIP; the segment strategy
packages its internal numbered envelopes rather than asking the browser to remain open.
The 5,000-record and 25 MiB limits are per internal page/segment, not archive lifetime
bounds. Only one archive assembly slot exists per backend process, and the artifact must
fit available server disk. The older direct archive/segment endpoints remain executable,
explicitly OpenAPI-deprecated compatibility primitives with their synchronous/proxy-
timeout and cursor constraints. They are not canonical Console workflows.

An artifact proves that the server completed and verified the ZIP, not that selected
scopes share a transaction or that a download reached the client. It covers only
selected supported safe scopes, excludes secrets/users/sessions/chat/collaboration/user
preferences/raw logs/raw knowledge chunks, and has no import endpoint. It is suitable
for support and offline analysis, not disaster recovery. Elasticsearch cases/audit/
usage use a PIT; SQL reports a bounded-at-start, non-exact view, and configuration/KV
scopes report live-at-read semantics. PIT cursors expire after ten minutes without
renewal and must be restarted after expiration or backend restart. Automation/knowledge collections
are still materialized before response slicing, so very large catalogs can consume
server memory even though responses stay bounded.
`data_export:export` is also broad scope access rather than per-analyst row isolation;
grant it to custom roles only after reviewing the disclosure boundary.

Job artifacts are retained separately from StateStore metadata and only for the newest
50 attachments. A terminal export row can therefore outlive its Download action. This
count-bounded cache is not an evidence-retention or disaster-recovery policy.

The Console is Jobs-only for long work, but direct precedent bootstrap, RAG import, and
full-catalog Runbook reindex also remain executable OpenAPI-deprecated compatibility
primitives. They retain their request-bound behavior and do not inherit the durable Job
surface merely because an equivalent Job kind exists. Targeted single-Runbook reindex
remains a normal direct operation. Direct reset and storage apply are the exception:
those mutations return 410 rather than executing.

### Storage lifecycle does not yet provide end-to-end archival

The desired default is 180 days Hot, 90 days Warm, and archive from day 270 to AWS
S3 Glacier Flexible Retrieval, with deletion permanently off. Native enforcement is
currently narrower than that desired policy:

- Elasticsearch ILM is applied only to append-only audit and usage/cost ledgers,
  and only after an explicit capability preview plus a freshly authenticated
  `storage_lifecycle_apply` Job;
- mutable cases and live metadata stay Hot;
- PostgreSQL is advisory until partitioning/tablespace/scheduler work exists;
- SQLite is export-only; and
- connected SIEM/log retention remains external and read-only.

The retired direct `POST /api/storage/lifecycle/apply` mutation returns 410; GET, PUT,
and preview remain direct. This prevents a synchronous bypass around the durable Job.

There is no independent Glacier writer, immutable manifest, checksum verifier,
catalog, or tested restore workflow yet. Consequently Archive is reported as not
configured and Warm data is not deleted. Do not work around this by transitioning an
Elasticsearch snapshot-repository prefix to Glacier: Elasticsearch requires direct
access to every repository object and the transition can make snapshots unusable.

### Mapping is not yet a versioned lifecycle

The current sample analyser offers deterministic suggestions from a pasted record;
it does not profile a representative sample, persist immutable mapping versions,
dual-run in shadow, monitor drift, or roll back automatically. Operators own field
validation and should start with synthetic data. The target workflow is documented
under [the mapping assistant](../architecture/ingestion.md#normalisation-and-the-mapping-assistant).

### Campaign operation is single-replica and active-view only

Campaign correlation now enforces configured hourly/daily/weekly/manual cadence,
performs full-set active reconciliation, removes stale campaigns from the current
view, and records a durable last-success anchor. It remains an in-process worker with
no distributed lease or concurrent-replica ownership. Full-set replacement also does
not preserve an immutable campaign split/merge/expiry lifecycle. Scans and component
sizes remain bounded. Treat the result as the current advisory related-case view, not
an incident-history ledger.

### Intelligence improvement evidence is deliberately bounded

- Threshold tuning observes broadly but learns only from independently
  analyst-confirmed outcomes. It is review-first by default; sparse labels produce
  Collecting/proposals rather than an automatic-learning claim.
- Telemetry recommendations require versioned query/tool proof and support only the
  three v1 mappings for outbound DNS, endpoint process, and identity authentication.
  The scan stops at 20,000 cases and reports truncation. Missing connectors alone are
  never evidence.
- Playbook coverage scans at most 20,000 cases, returns at most 100 unmatched rule
  families, and uses exact deterministic matching. There is no operator-playbook
  delete route in v0.1.
- Scheduler health is process-local. Tuner/campaign success anchors recover from
  durable state; the event-driven baseline producer reports on-ingest attempt,
  confirmed-success, error, and processed evidence independently of the cadence-loop
  runtime flag. Distributed ownership and a complete immutable attempt history are not
  implemented.
- Local embedding fallback is explicitly marked and is not equivalent to a provider
  embedding. Changing embedding space requires managed-corpus reseeding, so retrieval
  may be temporarily incomplete while that reconciliation runs.

### Connector-specific boundaries

- Syslog supports UDP, TCP, and TLS 1.2+; TLS requires mounted certificate/private-key
  files, and optional client-CA verification enables mTLS. TLS configuration is
  fail-closed rather than silently falling back to plaintext.
- S3 supports text formats and gzip, but not Security Lake OCSF Parquet.
- MQTT currently schedules processing from its client callback, so protocol
  acknowledgement can precede a successful ingest; exclude it from loss-intolerant
  evaluations until manual acknowledgement is implemented.
- Queue/cloud/object-store clients ship in the default `full` image but are absent
  from the explicitly lean `core` target; neither target implies live certification.
- Native pull/search connectors for Splunk, Sentinel, QRadar, Chronicle,
  CrowdStrike, SentinelOne, and Defender are reserved but not implemented.
- There is no published live-vendor, throughput, or long-duration soak matrix.

See the [source support matrix](../sources/support-matrix.md) for exact package and
protocol status.

### Deployment hardening is operator-owned

The Compose stack is an evaluation topology. Do not expose backend, database,
receiver, or web ports directly to the internet. Production work still needs a
trusted TLS ingress, network policy, secure-cookie/auth settings, credential
rotation, state backup/restore, log retention, monitoring, image scanning, and a
documented incident/upgrade procedure.

The project has not published a compliance certification or an independent
production security assessment for version 0.1.

## What is safe to evaluate

Use generated or non-sensitive data on one backend replica. Keep the original event
in a durable source, use least-privilege source credentials, enable authentication,
rotate default/demo credentials, and rehearse every documented upgrade or reset on a
backup before applying it to retained state.

Suitable evaluation goals include:

- UI and analyst workflow review;
- deterministic OCSF mapping checks;
- rule/correlation quality on replayable synthetic datasets;
- model quality and cost-ledger comparison;
- case provenance, audit, collaboration, and notification UX;
- fault-injection and performance work needed to close the blockers above.

Version 0.1 should not be marketed as lossless, horizontally scalable, production
certified, or independently assessed until the corresponding evidence is published.
