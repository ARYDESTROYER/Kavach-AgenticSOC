---
title: Deployment
description: Deploy Agentic SOC 0.1 with the standalone stack or attach it safely to an existing log platform.
---

# Deployment

Agentic SOC 0.1 ships a FastAPI backend and a standalone web console. The recommended
deployment is the self-contained Compose stack with PostgreSQL and Redis. Existing
Elastic/OpenSearch/Wazuh systems remain external data sources; Agentic SOC consumes them
with least-privilege credentials.

## Choose a deployment shape

| Shape | Application state | Log sources | Use when |
|---|---|---|---|
| Standalone/agnostic | PostgreSQL + pgvector | Pull or push connectors | New deployment or no desired dependency on an existing Elasticsearch cluster |
| Existing ELK attachment | Agentic SOC-owned Elasticsearch indices | Read-only existing log indices | A compatible Elasticsearch stack is already operated and separate application-state privileges are acceptable |
| SQLite | Local database file | Pull or push connectors | Single-node evaluation and development only |

The standalone web UI is the supported interface. The archived Kibana plugin is not
built, tested, or shipped as part of 0.1.

## Prerequisites

- Docker with the Compose plugin for the reference stack;
- persistent storage for PostgreSQL or the selected state backend;
- a stable JWT and MFA key if authentication is enabled;
- at least one configured model provider for live LLM investigation, or an explicitly
  controlled mock/demo profile;
- source credentials scoped to the minimum required indices/APIs;
- HTTPS termination for any shared or non-loopback deployment.

Supervised updates additionally require authentication enabled, a durable JWT secret
of at least 32 characters, a durable PostgreSQL password, the unmodified reference
Compose topology, and public anonymous pull access to the release's `backend`,
`webui`, and `updater` GHCR packages.

## Standalone stack

1. After every signed-publication and canonical runtime acceptance gate passes, check
   out the accepted `v0.1.13` tag for Stable; use the `Testing` branch only for
   acceptance testing.
2. Copy `.env.example` to `.env` and set a strong PostgreSQL password.
3. Configure authentication and provider credentials.
4. Validate the rendered Compose configuration through
   `./scripts/agentic-soc-compose.sh config --quiet`.
5. Build and start it through `./scripts/agentic-soc-compose.sh up --detach --build`.
6. Confirm liveness, readiness, and build information before opening the UI.
7. Complete first-run setup and add a synthetic source before real data.

The stack contains PostgreSQL/pgvector, Redis, the backend, the nginx-hosted Console,
and the isolated update supervisor. The web image serves both the compiled SPA and
the version-matched Help Center at `/docs/0.1/`, and proxies `/api/*` to the backend.
Redis is a cache, not the authoritative case/config store.

The updater is a privileged host boundary: it alone receives the Docker socket. The
ordinary backend sees only its bounded private Unix control socket; the Web container
and browser see neither. Docker-socket access is effectively root-equivalent on the
host, so deploy only the reviewed supervisor image, restrict access to the host and
Compose project, protect `.env` and updater volumes, and never expose the control
socket over TCP.

The remote uses `Testing` for integration and default `main` for accepted Stable
source. Version 0.1.13 is Stable only when the exact verified `main` commit has the
immutable `v0.1.13` tag, matching signed/public artifacts, and completed canonical
runtime acceptance. A pull of `main` receives the current accepted Stable tree while
integration work continues on `Testing`. Branch
protections, required checks, and release-environment policy remain repository
settings that administrators must verify independently.

The immutable `v0.1.4` and `v0.1.5` tags are failed, non-installable publication
attempts and must not be used as deployment or bootstrap sources. The published
`v0.1.6`, `v0.1.7`, and `v0.1.8` records are bootstrap-blocked and superseded;
`v0.1.9` failed before its canonical Release was published.
The immutable `v0.1.10` workflow timed out while its architecture-neutral Web Console
builder ran under target emulation; it has no complete three-image set, canonical
signed plan, GitHub Release, Stable tags, or Stable Help Center and is non-installable.
The immutable `v0.1.11` workflow completed image and plan verification but failed
before canonical publication. Version `v0.1.12` completed the full signed/public
release, then canonical v0.1.1 bootstrap failed closed before application mutation
because matching absent legacy state-schema labels were normalized asymmetrically.
Both are superseded and are not supported installation sources.
Use `v0.1.13` only when its complete
publication gate, canonical signed Release, anonymous digest-pull evidence, and
canonical PostgreSQL Compose runtime acceptance
verify; otherwise use a previously verified Stable release.

The immutable `v0.1.6` tag has a valid signed/public artifact set, but canonical
macOS Bash 3.2 bootstrap acceptance failed before supervisor installation. Preserve
it as historical evidence; do not use it as a deployment or bootstrap source.

The immutable `v0.1.9` publication built, signed, and anonymously proved all three
images, but its constrained supervisor could not traverse the runner-owned
verification directory. The workflow stopped before GitHub Release publication, so
that tag has no installable signed plan and must remain historical evidence only.

## Existing Elasticsearch attachment

Keep two physical credentials:

- a read-only log credential scoped only to the intended log indices;
- a management credential scoped only to Agentic SOC's own `tlsoc-agent-*` state
  indices, with cluster `manage_ilm`, `manage_index_templates`, and `monitor` when native lifecycle is applied.

Never use `elastic` or `kibana_system`. Mount the appropriate CA certificate read-only,
keep certificate verification enabled, and test the exact index patterns before enabling
background collection. Agentic SOC must not modify the upstream pipeline.

Bootstrap creates only missing Agentic SOC-owned Elasticsearch templates and indices.
It does **not** overwrite an existing template, update an existing index mapping, or
reindex stored documents. Therefore the current additive `app_version`, `build_sha`,
`retrieval_history_status`, and `retrieval_observation_status` mappings are automatic
for new installations only.
Existing Elasticsearch-state installations must apply the shipped template/mapping
changes through their normal controlled Elasticsearch procedure if explicit mappings
are required. Dynamic field acceptance is not retrospective template application, and
legacy documents are not backfilled.

## Own-state lifecycle and archive boundary

The desired default under **Settings → Organization → Storage & retention** is
Hot for 180 days, Warm for another 90 days, then archive from day 270 to AWS S3
Glacier Flexible Retrieval. Deletion is always off. This preference applies only to
Agentic SOC-owned state; source log/index/bucket retention remains external and
read-only.

Native enforcement is currently limited to Elasticsearch ILM for the append-only
audit and usage/cost ledgers. Preview must confirm `manage_ilm`,
`manage_index_templates`, `monitor`, and hot /
warm tier capability before an administrator performs the explicit, freshly
authenticated Apply. Cases and operational metadata stay Hot because they are
mutable. PostgreSQL reports the policy as advisory; SQLite reports export-only.

Archive is a desired target, not an active pipeline in 0.1.13. Build a separate
immutable export with a manifest and checksums, verify restore, and only then place
those independent archive objects under an S3 lifecycle rule. **Never transition an
Elasticsearch snapshot-repository prefix to Glacier**; Elasticsearch expects its
repository objects to remain directly readable.

## Background-job artifact volume

Application job metadata lives in the selected StateStore, but verified ZIP artifacts
live on the backend filesystem. Direct source runs and the updater-managed standalone
Compose v1 default to `./data/job-artifacts`; those files survive a backend process or
ordinary container restart, but not container replacement. The standalone base file is
byte-pinned by the updater protocol, so use a reviewed Compose override/bind mount when
replacement-safe retention is required. The legacy ELK merge profile maps
`TLSOC_JOBS_ARTIFACT_DIR` (default `/var/lib/agentic-soc/jobs`) onto the persistent
`agentic-soc-job-artifacts` volume.

The backend creates the root at `0700` and files at `0600`, uses opaque IDs, and verifies
size plus SHA-256 on download. Retention is bounded to the newest 50 attached artifacts,
not by age or backup policy. Monitor the volume and export important ZIPs into an
independent controlled archive. Never store artifacts in the updater control, state, or
backup volumes.

## Image identity

Backend and web images use the machine version `0.1.13` and accept OCI version,
revision, build-date, and source metadata. Record the image digest and
`/api/health/build-info` result with each deployment. Do not treat a mutable branch or
image tag as an immutable release identity.

Release channel is stamped independently from SemVer. Source builds default to
`TLSOC_RELEASE_CHANNEL=testing`; the accepted `main`/`v0.1.13` build must explicitly
set it to `stable`. This preserves the same `0.1.13` candidate identity through
acceptance without allowing a Testing build to report itself as Stable.

Set `TLSOC_VERSION`, `TLSOC_RELEASE_CHANNEL`, `TLSOC_BUILD_SHA`, and
`TLSOC_BUILD_DATE` explicitly through the reference Compose build. Its Dockerfiles
already label the canonical repository as `TLSOC_SOURCE_URL`; a fork must override
that Docker build argument directly or add a deliberate Compose mapping. Verify the
running channel and commit at `/api/health/build-info`; verify the image label
`dev.tlsoc.release.channel` as part of artifact acceptance. The Console's
always-visible `vX.Y.Z · Testing|Stable` badge reconciles its compiled stamp with
backend build-info; open the badge to inspect both identities. Any version,
channel, or known-SHA mismatch displays Testing. This operator aid complements,
but does not replace, digest and endpoint verification.

New operational records also preserve this build identity. A Case records immutable
creation-build `app_version` and `build_sha`; a later update or re-investigation does
not replace them. Each newly appended audit and usage row records the build that first
appended it, and an idempotent retry preserves that first-writer stamp. When the build
SHA is not supplied, new records carry the honest literal `unknown`.

This additive provenance and retrieval-history instrumentation does not change the
source version from `0.1.13`, does not require a PostgreSQL/SQLite schema migration,
and performs no historical backfill. SQL backends store the fields in their existing
JSON documents. Existing records therefore keep `null` provenance and unavailable
legacy lifetime history rather than acquiring reconstructed history from the upgraded
reader. The observation marker also starts `unavailable`; a later fully measured run may
advance that marker, but does not backfill or repair the lifetime-history marker.
The Elasticsearch and SQL Case repositories also make their defensive fallback
insert-only: a missing case id/row may be stamped, but an existing row restores its
persisted provenance (including legacy `null`). Deterministic audit-event and Batch-usage
retries likewise keep the first append's version/SHA instead of adopting the retrying
build.

The web artifact's `/release.json` and `/index.html` must be served with no-store
semantics. A deployment bootstrapped with the external update supervisor may show one
compact **Update to vX.Y.Z** candidate beside the release badge when mutable public
Stable-branch observation reports a newer SemVer and the host reports the supported
capability. The candidate is not installation authority. Selecting it asks the
backend to derive canonical GitHub Release assets and the supervisor to perform the
signed preflight. Confirmation remains blocked until the private supervisor verifies
the declarative plan and signed digest-pinned backend/Web/updater image identities,
compatibility, backup capacity, and installed identity. The browser supplies only the
exact release ID and opaque idempotency/preflight tokens. Actual registry pulls and
image-label inspection happen after job creation but before application mutation.
Stable branch HEAD remains observation-only: the candidate commit is the immutable
commit dereferenced from the exact annotated `vVERSION` tag.

Starting the update creates a durable host-side job. The supervisor pulls and verifies
all images first, creates and catalog-verifies a PostgreSQL custom-format backup,
hands off to the signed updater when required, replaces the backend and Web Console,
verifies readiness/build identity/Help Center, and observes the coherent pair. A
post-switch failure automatically restores the prior application image IDs and
leaves PostgreSQL untouched. The verified backup is retained only as a break-glass
recovery artifact. The Console expects a temporary reconnect and resumes the
same job; a successful installation still repeats the no-store manifest, backend
identity/readiness, entry-document checks, and preserves the current hash route before
activating the new Web document.

Automatic in-flight failure, cancellation before switching, and deliberate rollback
after success all restore application images only; none rewrites PostgreSQL. This
preserves every write accepted after the snapshot was taken. The catalog-verified
quiesced dump remains available for an explicit operator-controlled break-glass
recovery, and v1 therefore permits only plans with `migration.strategy=none`.

This support is deliberately narrow in 0.1.13: the reference single-replica standalone
Docker Compose deployment whose mounted base file matches the signed canonical
SHA-256, canonical project/network/service identities and PostgreSQL volume,
PostgreSQL-owned state, coherent schema labels, authentication enabled with durable
secrets, no database migration, and the separately bootstrapped supervisor. PostgreSQL
and Redis infrastructure images are unchanged. SQLite, Elasticsearch-owned state,
external PostgreSQL, legacy ELK, custom Compose/Kubernetes layouts, horizontal
replicas, runtime-only secrets, unknown build identity, incompatible plans, or any
release requiring a migration are blocked with a manual remediation. A pre-supervisor
installation needs the documented one-time
`scripts/bootstrap-updater.sh` host step; software cannot retroactively install its own
privileged supervisor.

The updater never transports or replaces `deploy/docker-compose.agnostic.yml`. The
0.1.x protocol pins its version-invariant bytes in
`deploy/update-base-v1.sha256`; the signed generated override carries versioned image
digests. Changing that base requires a new updater protocol and manual bootstrap.

The v0.1.1→v0.1.13 bootstrap must run from the clean, exact annotated `v0.1.13` tag
whose commit remains contained in `origin/main`. It installs the initial supervisor
transport and then delegates the complete v0.1.13 transition to the signed release plan
and durable update state machine. After bootstrap, use
`./scripts/agentic-soc-compose.sh` for
every manual lifecycle command. Raw `docker compose -f
deploy/docker-compose.agnostic.yml ...` bypasses the active digest override and is
unsupported.

The 0.1.13 updater bakes
`TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root`, keeping cosign trust state on
the writable updater-state volume while the root filesystem remains read-only. This
release also materializes the plan and bundle as read-only files beneath an explicitly
traversable verification directory before invoking the dropped-capability supervisor.
Its Web Console documentation and application builder stages run on BuildKit's native
build platform while the final nginx stage remains target-platform-specific. After
the production-constrained verifier exits, release-fixture cleanup restores the
runner-owned verification directory to private mode `0700` before removing it; the
plan and bundle remain read-only beneath mode `0555` throughout verification. None
of these corrections changes updater protocol 1, the keyless workflow identity, process
UID/GID, the dropped-capability runtime, state schema, trust predicate, or frozen base
Compose bytes.

A Testing/source-built 0.1.3 deployment, the non-installable `v0.1.4` / `v0.1.5`
publication attempts, the published-but-bootstrap-blocked `v0.1.6` through `v0.1.8`
records, and the failed-publication `v0.1.9` through `v0.1.11` records are
not canonical installable Stable sources and cannot bootstrap by relabelling
themselves. If an earlier attempt left an inspectable idle older supervisor on an
unchanged v0.1.1 application, the v0.1.13 bootstrap replaces that exact-version
mismatch before signed-plan verification. Reconcile other states through the
documented 0.1.13 path appropriate to their installed release. Because bootstrap
requires a strictly newer target, an already-running 0.1.13 cannot bootstrap from the
0.1.13 plan.

The wrapper and supervisor also share a lifecycle lock: inspection commands remain
available, while mutating or unknown Compose commands are refused for the full durable
update transaction. Target pins remain private through self-handoff, writer quiescence,
and verified backup, and become host-visible only at the switch boundary. Restart
reconciliation clears a leftover marker only for an exact durable terminal job;
unknown lifecycle state remains fail-closed.

Bootstrap reuses a compatible idle supervisor and can replace an inspectable idle
incompatible one while preserving/restoring the active digest override. It refuses an
active job or unreadable/invalid supervisor state rather than replacing it blindly.
Preserved pins may be restored only before `/v1/jobs` submission. At submission the
durable supervisor owns the lifecycle; bootstrap retains and reuses an unpredictable
per-release start key after interruption and deletes it only after observing the exact
job terminal.

Keep the prior backend/Web image digests and verified backup until the observation
window and operator retention policy are satisfied. The supervisor's durable job and
receipt remain the recovery source if the browser disconnects during replacement.
Updater self-replacement uses a restartable helper and an idempotent name-swap
transaction. It resumes replacement or restores the exact prior supervisor after an
ordinary helper-process, Docker-daemon, or host restart. A failure that prevents Docker
and all of its containers from running, or destroys Docker metadata/storage, remains a
manual host recovery event.

After deployment, open **Documentation** from the navigation rail and confirm it
stays on the deployment origin at `/docs/0.1/`. Installed help is part of the web
artifact and should remain available in an isolated network; public Stable and
Development documentation are secondary references.

## Production boundaries

Version 0.1 is a single-replica reference deployment, not a high-availability claim.
There is no complete schema-migration framework, durable receipt ledger for every push
transport, or built-in secret manager. Read [Known limitations](../releases/known-limitations.md)
before admitting sensitive or loss-intolerant data.

Application jobs use strict-CAS claims and renewable leases, but their runner,
investigation priority gate, export assembly slot, Inbox/SSE publication, receivers,
and schedulers remain process-local. Those narrow claims do not authorize multiple
backend replicas. See [Background jobs](background-jobs.md).

Next: [Configuration reference](configuration.md), [Background jobs](background-jobs.md),
[Security hardening](security.md), and [Health, backup, and restore](health-backup.md).
