---
title: Health, backup, and restore
description: Monitor Agentic SOC health, capture release identity, and protect application state and secrets.
---

# Health, backup, and restore

Health checks answer different questions. Use the narrow endpoint that matches the
orchestrator decision you are making.

## Health endpoints

| Endpoint | Meaning | Expected use |
|---|---|---|
| `/api/health/live` | The process can serve requests | Restart/liveness probe |
| `/api/health/ready` | Agentic SOC can use the selected state store, including a bounded write-path probe | Traffic/readiness gate; returns 503 when unavailable |
| `/api/health` | Backward-compatible aggregate status used by the web UI | Human/UI summary |
| `/api/health/build-info` | Version, release channel, commit/build metadata, state backend, and OCSF version | Support and deployment inventory |

Readiness does not prove that every connector, model provider, enrichment service, or
notification channel is healthy. Use source health/coverage, provider tests, and
notification tests for those dependencies.

### Subsystem degradation on `/api/health`

`status` reports state-store readiness only, and keeps that meaning for compatibility.
A subsystem that is impaired while the state store is fine is reported separately:

| Field | Meaning |
|---|---|
| `degraded` | At least one depended-on subsystem is impaired |
| `degraded_reasons` | Opaque codes naming each active degradation |

Current codes are `rag_corpus_empty`, `rag_projection_refused`,
`llm_provider_unauthenticated`, `llm_provider_quota_exhausted`, and
`llm_provider_unavailable`. `degraded` is a genuine product-level alarm: an empty
knowledge corpus means every investigation runs without runbook, ATT&CK, or precedent
context, and auto-close cannot fire. Alert on it.

This endpoint is **unauthenticated**, so it deliberately publishes codes only — never
corpus counts, source names, provider names, or detection posture. The
`settings:read`-gated `/api/diagnostics/health` carries that detail, including the
corpus-versus-source-history reconciliation and the last projection outcome. Both are
read-only and never trigger a projection or an embedding spend.

A degradation raised by a genuinely empty corpus resolves automatically once the
underlying cause clears; see [background jobs](background-jobs.md) for the explicit
rebuild and [troubleshooting](troubleshooting.md) for the diagnosis order.

## What to back up

- The selected `StateStore`: cases, audit, usage, configuration, cursors, users,
  sessions, knowledge, and feature KV documents.
- PostgreSQL roles/extensions and schema when using the standalone stack.
- The SQLite database file only after quiescing writes or using a consistent database
  backup mechanism.
- Agentic SOC-owned Elasticsearch indices and their templates when using ES state.
- Deployment configuration, CA material, JWT/MFA keys, and all external secrets in a
  separate protected secret backup.
- The exact application version, commit SHA, image digests, and Compose configuration.
- The application-job artifact directory/volume when retained ZIP exports are part of
  the recovery objective. Job metadata alone cannot recreate a pruned or missing ZIP.

Redis is an optimization/cache and is not the authoritative application backup.
Upstream logs remain in their source systems and require their own retention/backup.

**Settings → Organization → Data export** submits a background job that can package all
records in its selected supported safe scopes into one verified server-assembled ZIP,
using either the archive or internal segmented walk,
but it is a support/analysis artifact, not a whole-application
backup. Its Knowledge scope preserves sanitized authoritative operator runbook and
playbook documents plus safe bundled manifests/references, but it omits credentials,
users/sessions, chat/collaboration state, raw upstream logs, and raw knowledge chunks,
and has no matching import/restore endpoint. The ZIP manifest proves that the server
emitted each scope's starting count and verified the prepared artifact, not that the
client received it or that it is recoverable. Only exact Elasticsearch scopes are fixed
snapshots; PostgreSQL honestly reports a non-exact `bounded_at_start` view.
Segment cursors are signed and bound to the requesting operator, scope, and snapshot;
the server follows them and packages the envelopes into the one retained artifact.
Use the selected state backend's
consistent dump or snapshot mechanism for recovery.

The Jobs registry retains operational summaries, not a full copy of imported text or
selected case IDs. Artifacts are count-pruned after the newest 50 attachments and each
download re-verifies size/SHA-256. Download and independently retain an export needed
for recovery or evidence; an Inbox entry is not a backup.

The desired Storage & retention archive stage is also not a backup mechanism in
0.1.13. Glacier requires an independent immutable export, manifest, checksums, and a
tested restore path. Never transition an Elasticsearch snapshot-repository prefix to
Glacier; every repository object must remain directly readable by Elasticsearch.

## Backup procedure

1. Record build information and state-backend type.
2. Stop or quiesce ingestion for a consistency-sensitive backup.
3. Use the database/vendor-supported snapshot or dump mechanism.
4. Back up deployment secrets separately.
5. Encrypt, checksum, and retain the artifacts under access control.
6. Resume ingestion and confirm cursor/source coverage.

## Restore test

Restore into an isolated environment with the same application version. Supply secrets,
start the state dependency, then the backend, and verify readiness before the web UI.
Check users/login, settings, cases, audit, usage, knowledge, source cursors, and a
synthetic connector. Confirm that notification and model tests cannot reach production
destinations from the restore environment.

## Limitations

Agentic SOC 0.1 has no built-in backup scheduler or complete versioned database migration
framework. A successful dump is not sufficient evidence; test a full restore and retain
upstream data long enough to replay after failure.

See [Background jobs](background-jobs.md), [Upgrades](upgrades.md),
[Reset and recovery](../administration/reset.md), and [Troubleshooting](troubleshooting.md).
