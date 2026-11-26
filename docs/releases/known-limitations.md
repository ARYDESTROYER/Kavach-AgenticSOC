---
title: Known limitations
description: Release gates and explicit operating constraints for Agentic SOC 0.2.0.
---

# Known limitations

This list is part of the product contract for Agentic SOC `0.2.0` in Testing and,
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

### Project license (resolved in 0.2.0)

The maintainer chose the Apache License, Version 2.0. The verbatim text is `LICENSE` at
the repository root, with byte-identical copies in `backend/` and `updater/` for their
image build contexts. Each shipping image carries it at
`/usr/share/doc/agentic-soc/LICENSE` with the label
`org.opencontainers.image.licenses="Apache-2.0"`, and the backend package declares
`License-Expression: Apache-2.0`. Bundled fonts, Unicode data and the MITRE ATT&CK subset
keep their own terms; the README lists them under "Third-party notices".

### The repository was renamed, so the update trust root changed

The repository is now `ARYDESTROYER/Kavach-AgenticSOC`. From 0.2.0 on, that name is the
signing identity of every release plan, the GHCR namespace and the OCI source label. The
frozen Compose base (`deploy/docker-compose.agnostic.yml`) cannot change under updater
protocol 1, so it still defaults `AGENTIC_SOC_UPDATE_REPOSITORY` to the former name.

**Required control:** set
`AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC` in `.env` before running
`scripts/bootstrap-updater.sh`. The bootstrap refuses a missing line, the former name in
any letter case, and the new name in the wrong letter case, because the signing identity
is case-sensitive; it never edits `.env`. Artifacts of v0.1.12 and earlier stay valid
under the former identity and are not re-signed. GitHub does not redirect project Pages
after a rename, so old `arydestroyer.github.io/Agentic-Kibana/` links answer 404; the
public Help Center is `https://arydestroyer.github.io/Kavach-AgenticSOC/`. A saved
**Updates & releases** preference that names the former repository reads as the new one;
a fork is kept.

### Signed update acceptance is external to local unit tests

The updater protocol, release plan, signature verification, rollback state machine,
and reference Compose contracts have offline coverage. That does not prove the exact
published `v0.2.0` images and signed assets work through a real PostgreSQL Compose
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

## Version 0.2 constraints

### One-click updates support one deployment profile

The unpublished 0.1.2 snapshot introduced source discovery and coherent-pair
activation but did not publish the host supervisor or signed upgrade plan. Version
0.2.0 carries the version-1 supervisor protocol and canonical base-Compose contract
without broadening its supported topology. It still cannot retroactively install a
privileged host component. A supported canonical v0.1.1 installation requires one manual
`scripts/bootstrap-updater.sh` step from the clean, exact annotated `v0.2.0` tag whose
commit remains contained in `origin/main`; that step delegates the full
v0.1.1 to v0.2.0 transition to the signed plan. That tag is not an installation source
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
normalized while the other remained raw. The never-tagged 0.1.13 candidate, folded
into 0.2.0, normalizes matching absent legacy schema labels symmetrically while
retaining every mixed/later-identity rejection. Version 0.2.0 changes no application
schema, updater protocol, process privilege, or frozen-base bytes. It does change the
publisher identity to the renamed repository (see the release gate above).
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

The updater foundation included in version 0.2.0 retains updater jobs, preflights,
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

### Rollback loses chat and thread data

On the Elasticsearch state backend, builds with the rebuilt Workspace Chat store case
discussion threads and Workspace Chat history in a new mapping-safe form that older
builds cannot read. The first write after the upgrade converts the whole document,
entries from before the upgrade included. After a manual rollback to an older image,
case threads and the affected users' chat history appear empty, and the older build's
next write to them removes the converted entries. That backend has no supervised
rollback, and portable export does not cover chat or collaboration data.

PostgreSQL and SQLite keep the previous form, so the supervised image-only rollback
keeps case threads and chat transcripts. The older build does not know the
conversation-level fields this release adds: its first chat write for a user drops that
user's conversation pins, linked reports, time ranges, and usage totals. Transcripts
and the reports themselves remain. Nor does it know that up to 10 pinned conversations
may sit beyond the 50-conversation limit: its first saved answer for a user with more
than 50 conversations deletes that user's oldest conversations (by last activity, pinned
ones included) until 50 remain. Before rolling back, users with more than 50
conversations should export the extra conversations they want to keep and delete them.

The current build adds a second, milder rollback loss on every backend: each new chat
answer is stored in full in its own exchange document, which older builds do not read.
Rolled back, they show each message's compact copy, so answers longer than 24,000
characters end at that length and the oldest messages of long conversations appear as
previews or, past 140 messages, are not shown. Rolling forward restores them, except for
conversations the older build trimmed to its own 100-message window in the meantime.

**Required change:** a versioned, reversible data migration for KV documents, so a
rollback can restore the form an older build reads.

### Rolling back to a build before Round 14 is not clean

Builds before Round 14 predate the rollback forward-compatibility contract. After an
image-only rollback to such a build, a stored `audit_export` job record puts it in
factory-reset safe-stop (every route answers `503 factory_reset_in_progress`), its
knowledge projection is refused at the retention floor against the migrated runbook
corpus, and its graceful stop drops every `runbooks.*` setting. The checks and
workarounds are in [Upgrades](../operations/upgrades.md#rolling-back-from-round-14);
if you lower `rag.min_projection_retention` to `0` on the earlier build, restore it after
the return, because the shared preferences keep it. From this build on, unknown job kinds, unknown preference keys and marked corpus
migrations are kept, and a CI lane boots the previous release on each candidate's data
([Rollback forward compatibility](../operations/upgrades.md#rollback-forward-compatibility)).

**Required change:** none for later releases; it cannot be fixed inside the earlier
builds themselves.

### Rolling back from Round 15 resets two settings

The previous release that the rollback lane pins (`45a4c31`, the Round 14 build) predates
the preferences forward contract and rewrites the settings document without the keys it
does not model. After an image-only rollback to it, `team_activity` and
`auto_close_review` read as their defaults again once you return: the Team activity page
and the review sample are on, at a 5% sample, at most 10 a day and 3 per rule. Note any
values you changed and set them again after the return. Screenshots and the review ledger
stay in the store unused while the earlier build runs, and its feedback statistics count
review grades as ordinary grades; this build recognises them again from the case history.
The steps are in [Upgrades](../operations/upgrades.md#rolling-back-from-round-15).

**Required change:** none for later releases, which carry the forward contract.

### Rolling back from 0.2.0 loses what the earlier build cannot keep

Every field 0.2.0 stores is additive, and the earlier builds load documents with fields
they do not know. They drop those fields when they save a document again. After an
image-only rollback and the return:

- **Recorded risk inputs** are lost on every case the earlier build saves again. Back on
  0.2.0, such a case reads "not recorded", and its explanation uses today's weights.
- **Second-factor lock counters** reset, so a locked account can try again at once.
- **The read grants and the server-side forced password change revert** while the
  earlier build runs: a custom role without a read grant can read again, and an account
  that must change its password is not held to it. The rollback lane runs with sign-in
  off, so it does not prove these two losses; they follow from the earlier build's code.
- **The in-memory list of AI investigations** is lost, as on any restart.

Usage-ledger rows are append-only and keep their rate fields. What's new markers
survive, because the earlier build keeps personal preference entries it does not know.
The steps are in [Upgrades](../operations/upgrades.md#rolling-back-from-020).

The image-only rollback rehearsal to v0.1.1 on PostgreSQL: Recorded at release
preparation.

**Required change:** none for later releases; the earlier builds cannot be changed.

### The audit id column is widened in place on PostgreSQL

Every published release up to v0.1.12 created the PostgreSQL `audit.id` column as a
32-bit integer. On its first start on such a database, 0.2.0 widens the column and its
sequence to `bigint` in place. PostgreSQL rewrites the audit table to do it and holds an
exclusive lock on it, so a large audit table makes the first start slower and audit
writes wait until it finishes. A rollback never narrows the column again. The time per
million rows is measured at release preparation.

**Required control:** on a very large audit table, run the two `ALTER` statements in
[Upgrades](../operations/upgrades.md#the-audit-id-column) in a maintenance window before
upgrading. If the widening fails, the backend still starts, and
`GET /api/diagnostics/health` reports the failed schema migration with the statements
to run; strict audit writes, such as approving a proposal, fail until then.

### Single replica only

Run exactly one backend replica. Signature locks, receiver ownership, schedulers,
recent-event buffers, and the realtime event bus are process-local. The storage
abstractions do not yet provide all of the leases, uniqueness constraints, and
atomic claims needed for active-active replicas.

Adding replicas now can duplicate cases or scheduled work, lose receiver ownership,
and deliver inconsistent live updates. Workspace Chat's running answers are also
process-local: the turn registry, the buffer a browser rejoins a running answer from,
Stop, and the questions-at-once bounds live in one backend process. A backend restart
ends running answers (nothing is saved for them, and the question can be asked again),
and a second replica would neither see nor stop the first one's answers. The list of AI
investigations in progress is process-local too: `GET /api/investigations/active`, the
**AI working** chip, the queue marks and the navigation count show only the runs of the
backend that serves the request, and a restart forgets them (the case itself keeps the
run's result). The guard against a second reinvestigation of the same case is held in
the same list. The [scale-out roadmap](../architecture/ingestion.md#scale-out-roadmap)
defines the required worker/lease split. The second-factor sign-in step keeps its
pending tokens in memory too, at most 10,000; the per-account failure count is stored and
stays the lasting bound.

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

On a push source, correlation looks back over the last 500 events that source delivered,
held in memory and lost on restart. A rule with a long window on a busy push source
therefore sees at most those 500 events, not its whole window. A case built from a push
source always says its events are not retrievable on the Evidence tab, even while that
memory still holds them.

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

### Dashboard figures are exact up to 20,000 cases per window

The store-wide case totals are exact at any store size: the Open cases stock and the
case counts on **Analytics → Metrics** (Total cases (all time), and the counts by
status, verdict, and disposition). Every other dashboard figure, including every
Overview figure for the selected window (Total cases, Total critical, Resolved or closed,
Auto-closed, and the AI-verdict FP rate) and the heavier rollups (timing, verdict mix,
ATT&CK coverage, auto-close health, agent improvement, and similar), analyses every case
in its window up to 20,000 cases. A larger window, typically all time on a large store,
is analysed over its newest 20,000 cases and reported as truncated with the exact window
size: its counts show as lower bounds (`≥`) and its rates are withheld. Chat's case
counts and breakdowns have no such bound, so for a window that large the chat figure and
the dashboard figure differ, and the chat figure is the exact one.

### Chat conversation summaries are not shown

When a long conversation is summarised to fit the model's context window, the run log
says so, but the summary text itself is not shown anywhere in the console or returned by
an API route. It stays inside the conversation's stored data and is used only as
untrusted context for later questions.

### The context note overstates in Case Manager chat

The composer's context card says "Long conversations are summarised automatically near
the limit, so the chat keeps going. There is no hard cap." That holds for a saved
Workspace conversation. Case Manager chat, and a Workspace conversation that is not
saved, keep no running summary: when the conversation outgrows the model's context
window, only the newest exchanges that fit are sent, and the oldest are left out without
a notice. The card shows the same note there.

### Chat suggestions have bounded scope

The suggested questions on a new chat follow each analyst's own visits: a first visit
after 8 hours or more away counts as the start of a shift, and the handoff card appears 7
to 13 hours later. There is no configured team shift schedule. While row-level object
scope is turned on for a role, no suggestion about cases and no "Since …" line is shown,
because chat's case lookups do not apply that scope yet and a suggestion must never state
a count its answer would contradict. Case lists in chat answers name a case by its title
and a short ID until the lookups return case numbers, and chat cannot yet filter cases by
the signed-in analyst, so the answer to "Which of my open cases should I work on first?"
says so and shows the open queue by assignee.

### Case chat is a sixth tab

A case has six tabs this release: Brief, Evidence, AI investigation, Response, Activity
and Chat. Alt+2, Alt+4 and Alt+5 open different tabs than in earlier releases, and Chat
moved to Alt+6. A later release is planned to move case chat into the case facts column,
which brings the tabs back to five and changes the keys again.

### Explanations of older records use today's settings

Cases scored, decisions made and model calls recorded before 0.2.0 did not keep their
inputs, thresholds or rates. Their explanations say "not recorded" and, where they can,
use today's weights or policy, marked as such. A model call recorded before 0.2.0 shows
its stored cost and says its rates were not recorded; it is never repriced. On
Elasticsearch, a deployment
whose client may not read or change index templates cannot add the new cases mapping,
so its cases keep no risk inputs either; the backend logs this once.

### Single sign-on maps only built-in roles

A provider's default role and each group mapping must be a built-in role, and a custom
role name is refused when the provider is saved. Mapping a group to a custom role is in
the backlog. A provider saved before 0.2.0 with a custom role value is kept as stored
until it is next changed. Give an SSO user custom-role grants on their account after
their first sign-in.

### Cost figures follow cost:view in case text, not everywhere

Without `cost:view`, the cost figures in the text of a case's timeout, decision, runbook
AI and budget rows read "hidden", and amounts "(amount hidden)": in the trace, the
timeline, the activity feed, the case rationale and chat answers about the case. Tool
output and log evidence are shown as they were recorded and are never rewritten. Two
places still show cost text: the Audit log shows each row's summary as recorded to
anyone with `audit:view` (every built-in role that holds it also holds `cost:view`), and
a budget refusal's spend figure is stored in the case's error text, which every
`cases:read` holder sees.

### Demo user and host cases score low

The seeded Demo runs with the tenant's asset criticality map, which is normally empty, so
its user and host cases score about 10 to 40 and their impact reads low. A Demo asset map
would raise about half of the seeded scores by some 9 points and change two seeded
cases; it is not shipped.

### Screenshots are checked, not decoded

The server never decodes a screenshot's pixels and has no image library. It accepts PNG,
JPEG and WebP by their magic bytes, checks each file's structure, removes its metadata,
and refuses an image over 2 MiB, 8,192 pixels a side or 40 megapixels. The compressed
image data and a colour profile are stored as sent, so a crafted image aimed at a
browser's image decoder is not detected; the type allowlist, the structure check, the size
limits, sign-in, the audit row and strict response headers are the mitigations. The server
does not re-encode or downscale either: the Console does that before it uploads, so an API
client must send an image that already fits. A screenshot without a thumbnail is served in
full for `variant=thumb`, and the Console shows **No preview** for it in the gallery.

The upload bounds of 30 a minute and 2 at once per person are kept in the backend
process, like the other request bounds. A deleted screenshot keeps its caption, uploader
and time on the case; a case keeps at most 100 such entries, the oldest dropped first.

### Team activity counts are bounded and come from the audit log

Team activity counts audit rows, not distinct cases, in calendar days of the SLA time
zone; there are no shift-based buckets. It reads at most 92 days (`422
team_window_too_long`) and at most 250,000 audit rows. On Elasticsearch, a read that
cannot hold a point in time stops at 10,000 rows, and a store without paging support stops
at its own scan limit; the page then marks its counts as lower bounds ("at least") and
says why (`partial_reason` `row_limit` or `store_limit`). The median time to acknowledge
covers at most 5,000 cases and is left out above that. Answers are cached per viewer and
window for 60 seconds, so a new action can take that long to appear.

The audit row of a case action, assignment, tag change or comment is still written after
the change (best effort), so an action whose row could not be written is not counted.
Rows written before Round 15 or with sign-in off may name no person; they are grouped as
**Not attributed** and have no events list. Counts last as long as the audit rows do.

### Auto-close review bounds

- **Not a blind review.** The review card asks for the reviewer's own classification
  before it shows the AI verdict, but the rest of the case page still shows the verdict
  while a review is pending.
- **Agreement describes the sample only.** It is unweighted and is not an estimate of
  auto-close precision; the rate and its interval appear only from 30 reviews.
- **No backfill and a bounded ledger.** Sampling starts with the first automatic close
  after the upgrade. The ledger keeps the newest 2,000 picks (completed and expired ones are
  dropped first) and the daily counts for 90 days; once a pick is dropped, a case that is
  closed automatically again can be picked again, and the Agent effectiveness module marks
  a window that reaches past the dropped picks as incomplete. Its count of eligible
  automatic closes reads at most 20,000 cases and says when it could not read them all.
- **The Review scope reads whole cases.** `GET /api/cases?review=` reads every case the
  ledger names for that state (up to 2,000) on each request before it filters and pages
  them.
- **A pick on a case reopened outside the review stays pending.** It stays in the Review
  scope and its count, and a review of it is refused with `409 review_not_agent_closed`
  until the case is closed again.
- **One review at a time per process.** Recording a review is serialised by a lock in the
  backend process, and the ledger by strict compare-and-set; run one backend replica.
- **Bulk changes leave out agent-closed cases in the Console only.** Bulk Set status and
  Set disposition in Case Manager and Cases leave out the cases the AI agent closed among
  those the Console has loaded. A selected case the Console never loaded is sent as
  before, and the bulk API and jobs do not refuse agent-closed cases.

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
`NEEDS_HUMAN`. Workspace and Case Manager chat are outside this budget, daily and
monthly: their calls are ledgered but neither blocked by nor counted toward it. Chat
spend is bounded only by the optional daily chat spending limit (there is no monthly
chat limit), which is off by default and, like the budget,
is a preflight check: concurrent chat calls already in flight can finish above it. The check does not reserve spend atomically, so calls already in flight
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
- The runbook match preview reads the last 500 cases of the last 30 days. When a month
  of runs is too large to count in full, the runbook figures read "at least". Matching
  is exact and deterministic. A runbook that was published is never deleted, only
  retired.
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
production security assessment for version 0.2.

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

Version 0.2 should not be marketed as lossless, horizontally scalable, production
certified, or independently assessed until the corresponding evidence is published.
