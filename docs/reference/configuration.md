---
title: Configuration reference
description: Configuration authorities, environment wiring, durable preferences, runtime-only secrets, and state backends in Agentic SOC 0.1.
---

# Configuration reference

Agentic SOC 0.1 separates credentials and process wiring from validated application
preferences. Keep that boundary intact: a secret is never an ordinary setting.

## Configuration authorities

| Authority | Examples | Persistence | Managed through |
|---|---|---|---|
| Backend environment | state URL, provider keys, auth signing key, TLS paths | Deployment-owned | Process environment or `.env` |
| Organization preferences | sources, feeds, models, correlation, budgets, automation, branding, RBAC | Selected Agentic SOC state backend | Agentic SOC Console or `/api/settings*` |
| User preferences | theme, saved views, table layouts, personal dashboards | Selected Agentic SOC state backend | Agentic SOC Console or `/api/prefs/user`, `/api/views*`, `/api/dashboards*` |
| Runtime secret tier | wizard-submitted global keys and per-source/channel/provider secrets | Process memory only unless also supplied at boot | Secret-setting API routes |

`backend/app/config.py` defines both `Secrets` and `Preferences`. The settings schema
is available at `GET /api/settings/schema`; `GET /api/settings/{section}` returns a
validated section, while `GET`/`PUT /api/settings` operate on the preference document.

## Environment names

The backend reads **unprefixed** names, case-insensitively. For example:

```dotenv
STATE_BACKEND=postgres
STATE_DB_URL=postgresql+asyncpg://tlsoc:password@postgres:5432/tlsoc
AUTH_ENABLED=true
AUTH_JWT_SECRET=<stable-random-secret>
OPENAI_API_KEY=<secret>
```

The repository's Compose files accept selected root `.env` names prefixed with
`TLSOC_` and explicitly map them into the backend container. For example,
`TLSOC_OPENAI_API_KEY` becomes `OPENAI_API_KEY`. A prefixed variable has no effect
unless the selected Compose service maps it. Use `.env.example` and the Compose file
as the authority for those mappings.

Unknown values are ignored by the Pydantic settings loader. Validate spelling by
checking the relevant configured boolean or health/configuration surface rather than
assuming that a process-start succeeded with the intended value.

Release identity is the deliberate exception to the ordinary unprefixed settings
rule. The image/build pipeline passes these names directly:

| Variable | Meaning |
|---|---|
| `TLSOC_VERSION` | Compose image tag/build argument; must match the code's Semantic Version (`0.1.13`) |
| `TLSOC_RELEASE_CHANNEL` | `testing` by default; set to `stable` only for the accepted `main`/tag build |
| `TLSOC_BUILD_SHA` | Exact source commit embedded in `/api/health/build-info`, image metadata, and newly produced operational records; when unset it remains the literal `unknown` |
| `TLSOC_BUILD_DATE` | Build timestamp embedded in `/api/health/build-info` and image metadata |
| `TLSOC_SOURCE_URL` | Dockerfile build argument for the canonical source URL embedded in OCI image metadata; the reference Compose files currently use the Dockerfile's repository default |

The release channel is independent of SemVer: both the accepted Testing candidate and
its Stable promotion are application `0.1.13`. Promotion changes provenance/channel,
not the source version.

The Console compiles version/channel/SHA/date into its own build and displays an
always-visible `vX.Y.Z · Testing|Stable` badge. Opening the badge compares Console
and `/api/health/build-info` identities. A channel/version/known-SHA mismatch is
shown as Testing; Stable is never inferred from SemVer or a branch name.

New cases copy this non-secret identity once as immutable creation-build
`app_version` and `build_sha`. New append-only audit and usage rows copy the build
that first writes them; idempotent retries preserve that first-writer stamp. Updating
or re-investigating a case never replaces its creation-build identity, and legacy
records remain `null` rather than being backfilled by the first upgraded build that
touches them. These additive fields do not require a version bump or SQL migration.

## Common backend environment variables

| Group | Variables | Notes |
|---|---|---|
| State | `STATE_BACKEND`, `STATE_DB_URL`, `ES_STORE_ENABLED` | Selects Agentic SOC-owned persistence; does not select a log source |
| Elasticsearch wiring | `ES_URL`, `ES_CA_CERT`, `ES_VERIFY_CERTS`, `ES_REQUEST_TIMEOUT` | Used by the implicit Elastic source and/or Elastic state backend |
| Elasticsearch keys | `ES_API_KEY`, `ES_MGMT_API_KEY` | Read-only log key and separate `tlsoc-agent-*` management key; lifecycle apply additionally needs cluster `manage_ilm`, `manage_index_templates`, and `monitor` |
| LLMs | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LITELLM_API_KEY`; Azure, Bedrock, and Vertex fields | Every call still goes through the Agentic SOC gateway and cost ledger |
| Enrichment | provider-specific API keys plus `EMBEDDING_API_KEY` | Keyless providers need no key; enabled/keyed filtering happens at dispatch |
| Cache | `REDIS_URL` | Enrichment caching degrades to an in-process cache when Redis is unavailable |
| Server | `BACKEND_HOST`, `BACKEND_PORT`, `LOG_LEVEL` | Uvicorn bind and logging configuration |
| Release identity | `TLSOC_VERSION`, `TLSOC_RELEASE_CHANNEL`, `TLSOC_BUILD_SHA`, `TLSOC_BUILD_DATE`, `TLSOC_SOURCE_URL` | Direct prefixed build metadata; channel/SHA/date also reach the API runtime as non-secret identity. Source URL is an OCI-only Docker build argument and is not mapped from `.env` by the reference Compose files |
| Authentication | `AUTH_ENABLED`, `AUTH_JWT_SECRET`, `AUTH_TOKEN_HOURS`, `AUTH_COOKIE_SECURE`, bootstrap user fields | Use a stable signing key and secure cookies behind HTTPS |
| Security middleware | `SECURITY_HEADERS_ENABLED`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_CAPACITY`, `RATE_LIMIT_REFILL_PER_SECOND`, `CSRF_ENABLED` | Headers default on; rate limiting and CSRF default off |
| Secret maps | `CONNECTOR_SECRETS`, `SSO_CLIENT_SECRETS`, `NOTIFICATION_SECRETS` | JSON objects parsed directly by the backend; mapping support differs by Compose file |
| MFA protection | `MFA_OBFUSCATION_KEY` | Stable key for TOTP-secret obfuscation; distinct from user preferences |

The reference standalone Compose file maps the SSO and notification JSON maps. It
does **not** map a `TLSOC_CONNECTOR_SECRETS` variable in 0.1. To boot per-source
connector secrets from the environment, pass the backend's unprefixed
`CONNECTOR_SECRETS` explicitly or add a deliberate Compose mapping.

## State backends

`STATE_BACKEND` controls only Agentic SOC-owned state: cases, audit, usage, preferences,
cursors, users/sessions, collaboration, baselines, campaigns, rule versions, and
knowledge/vector records. Connector credentials and external telemetry remain outside
that store.

| Value | Connection | 0.1 behavior |
|---|---|---|
| `postgres` | `postgresql+asyncpg://...` | Recommended standalone persistent profile; pgvector backs vector retrieval |
| `elasticsearch` | `ES_URL` plus `ES_MGMT_API_KEY` | Stores state in dedicated `tlsoc-agent-*` indices; the default when running the backend directly |
| `sqlite` | `sqlite+aiosqlite:///path/to/tlsoc.db` | Single-node file-backed profile; defaults to `./tlsoc.db` if the URL is omitted |

The standalone Compose stack fixes the backend to PostgreSQL and derives
`STATE_DB_URL` from `TLSOC_PG_*`. The legacy ELK merge uses Elasticsearch state.
When the Elasticsearch state path cannot initialize, the current implementation can
degrade to in-memory state; monitor readiness and do not mistake that fallback for
durable operation.

## Own-state storage lifecycle

`Preferences.storage_lifecycle` records a desired lifecycle for Agentic SOC-owned
state. Its default is 180 days Hot, 90 more days Warm, then a desired AWS S3 Glacier
Flexible Retrieval archive beginning at day 270. Deletion is not supported and is
always off.

```json
{
  "storage_lifecycle": {
    "enabled": true,
    "hot_days": 180,
    "warm_days": 90,
    "archive_target": "aws_glacier",
    "glacier_storage_class": "GLACIER",
    "delete_after_archive": false
  }
}
```

This is desired policy, not a cross-provider promise. The status/preview API reports
the effective state and blockers before any mutation:

| State backend | Effective 0.1.13 behavior |
|---|---|
| Elasticsearch | Explicit Apply can install ILM for append-only `tlsoc-agent-audit-*` and `tlsoc-agent-usage-*` only, after the cluster/privilege/tier probe succeeds |
| PostgreSQL | Advisory; no built-in partitions, tablespace movement, or archive scheduler |
| SQLite | Export-only; no row-level Hot/Warm lifecycle inside one database file |

Mutable cases and live metadata stay Hot on every backend. Connected SIEM/log
retention remains under the source owner and is never changed by this preference.
The Elasticsearch ILM policy has no delete phase and no Glacier phase. Archive needs
a separate immutable export + manifest + checksum + restore-validation workflow;
never transition an Elasticsearch snapshot-repository prefix to Glacier.

## Upstream release discovery

`Preferences.release_updates` controls bounded observation of the public source
repository. It is enabled on fresh installations with this configuration:

```json
{
  "release_updates": {
    "enabled": true,
    "repository_url": "https://github.com/ARYDESTROYER/Agentic-Kibana",
    "stable_branch": "main",
    "testing_branch": "Testing",
    "check_interval_minutes": 360
  }
}
```

Only a canonical public `https://github.com/owner/repository` URL is accepted. Branch
refs are bounded and reject ambiguous Git syntax. The discovery client is pinned to
`api.github.com`, rejects redirects and oversized/malformed responses, and reads the
branch head plus root `VERSION`. Stable discovery additionally requires the exact
annotated `vVERSION` tag and dereferences it to an immutable commit; branch HEAD stays
observation-only. The interval is 15 minutes to 7 days. This
preference grants no clone, pull, execution, deployment, restart, promotion, rollback,
or migration capability. It is discovery metadata only. A separately bootstrapped,
host-pinned update supervisor may act on a newer Stable release only after the backend
derives the canonical GitHub Release asset URLs and the supervisor independently
validates the signed plan, trusted publisher, exact image digests, and local
compatibility. Changing this observation repository never silently retargets an
already installed supervisor.

Fork operators may change the repository and either release branch in **Settings →
Organization → Updates & releases**. Save the preference before running a manual
check. The same-origin `/release.json` and backend readiness identity remain the final
authority for activating a successfully installed Console build. Installation
authority stays in the private host supervisor described in
[Upgrades](../operations/upgrades.md), never in this preference or the browser.

## Durable preferences

Every `Preferences` field has a default. Major blocks include:

- sources, feeds, OCSF field mappings, polling, and data scope;
- correlation, risk, rules, baselines, campaigns, threshold tuning, and autopilot;
- model routing, concurrency caps, batch processing, budgets, and pricing overlays;
- deterministic auto-close policy, case ID format, priority, and SLA targets;
- playbooks, RAG, memory, enrichment, threat context, and personas;
- auth policy, MFA/SSO metadata, RBAC, sessions, notifications, and realtime events;
- branding, terminology, themes, saved views, dashboard defaults, and the desired
  own-state storage lifecycle;
- public release-source discovery repository, Stable/Testing refs, and cache interval.

`PUT /api/settings` deep-merges a JSON object and validates the resulting complete
preferences model. Prefer small section-specific changes and re-read after updating.
A malformed value is rejected rather than persisted. General preference updates do
not provide a universal revision history in 0.1; detection rules have their own
version ledger and rollback endpoints.

### Discounted alert inference

Fresh preferences use the bundled OpenAI model ID `gpt-5.6-luna` for all six completion roles
(router, investigator, formatter, standup, chat, and overview). Embeddings remain on
the dedicated OpenAI `text-embedding-3-small` model. This changes only newly-created
defaults: persisted role assignments and every alternate provider/model are preserved.
The Chat Completions adapter explicitly uses `reasoning_effort: none` for Luna to
retain the existing non-reasoning latency/cost and function-tool contract.
The bundled short-context Standard ledger rate is configured as $0.20/M input,
$0.02/M cached input, $0.25/M cache write, and $1.20/M output. It is release catalog
metadata, not a provider-invoice guarantee; compare it with current provider pricing
and your account contract before production use.

`batch.prefer_discounted_alerts` defaults to `true`. When an automated-scan or
entity/case investigation uses official OpenAI (no Azure/custom base URL) with a
supported GPT-5, o3, or o4-mini model, the single LLM gateway requests
`service_tier=flex`. The usage ledger applies the discounted rate only when the
provider response actually reports Flex (`processing_tier: flex`); unsupported
providers/models remain standard before the call. `batch.fallback_to_standard`
defaults to `true`, so an OpenAI 429 or Flex/service-tier-specific 400 retries at
standard service and is metered as standard. Chat, standup, embeddings, and
model-test calls are not automatically moved to Flex.

The existing `batch.enabled` switch remains the separate, true asynchronous provider
Batch path for the aggregated event-feed funnel. Ordinary case investigations require
an in-band result before deterministic routing can proceed, so they use supported Flex
rather than pretending an asynchronous Batch job has completed. Neither path changes
the deterministic close/escalate authority.

## Secret durability and exposure

| Secret path | Stored where | Survives restart? | Read behavior |
|---|---|---|---|
| Environment/provider key | Deployment environment | Yes, if the deployment retains it | Configured boolean only |
| First-run `/api/setup/secrets` value | Process memory | No | Configured boolean only |
| `/api/sources/{source_id}/secrets` value | Per-source in-memory secret bucket | No, unless separately boot-supplied | Configured field names only |
| `/api/auth/sso/providers/{provider_id}/secret` value | In-memory SSO map | No, unless `SSO_CLIENT_SECRETS` is boot-supplied | Configured boolean by provider |
| `/api/notifications/channels/{channel_id}/secret` value | In-memory channel map | No, unless `NOTIFICATION_SECRETS` is boot-supplied | Configured field names/booleans only |
| User TOTP seed | User record, obfuscated | With the state store | Never returned after the setup flow |

Back up deployment secrets separately from the state database. A state backup alone
cannot restore provider, connector, SSO, notification, JWT-signing, or MFA-protection
keys.

## Safe configuration sequence

1. Select and initialize a durable state backend.
2. Configure HTTPS termination, authentication, a stable JWT secret, and secure cookies.
3. Add one least-privilege source credential and validate its data scope.
4. Configure one model provider and set a daily budget before enabling broad automation.
5. Review deterministic auto-close thresholds, RBAC, receiver authentication, and notification targets.
6. Back up state and deployment secrets through separate controlled procedures.
7. Record `/api/health/build-info` with the deployment inventory, and confirm a newly
   created case plus newly appended audit/usage rows carry that build identity. Do not
   treat `null` legacy provenance or an honest `unknown` SHA as a different build.

See [Operations configuration](../operations/configuration.md),
[Security](security.md), and [Models and spend](../administration/models-spend.md).
