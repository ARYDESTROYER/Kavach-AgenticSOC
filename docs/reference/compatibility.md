---
title: Compatibility
description: Supported runtimes, state backends, telemetry sources, providers, deployment shapes, and contract expectations for Agentic SOC 0.2.
---

# Compatibility

This matrix describes application **0.2.0** and documentation line **0.2**. It
distinguishes implemented support from enum placeholders and archived components.

## Runtime and build matrix

| Component | Version 0.2 baseline | Notes |
|---|---|---|
| Agentic SOC API | Python 3.11 or newer | Dependency pins are in `backend/requirements.txt`; project metadata requires Python `>=3.11` |
| Agentic SOC Console | Node 22 for install/build | React 18, Vite 5, TypeScript 5.6, Tailwind, and Radix/shadcn-style primitives |
| Container frontend | nginx | Serves the compiled SPA, version-matched `/docs/<major.minor>/` Help Center, and relative `/api/*` proxy |
| Event schema | OCSF 1.4.0 | Every connector normalizes before the engine processes an event |
| Documentation | MkDocs Material; Mike history plus native GitHub Pages deployment | Every app serves its installed 0.2 guide at `/docs/0.2/` and redirects `/docs/0.1/` pages to it; the public selector uses `0.2`; packages/images use `0.2.0` |

The Agentic SOC Console is the only supported primary UI. It does not require Kibana. The
former Kibana plugin is archived, frozen, and excluded from current build/test/release
workflows.

The same-origin installed Help Center is authoritative for the running build and is
generated before every canonical Console build. Public Stable documentation is a
secondary upgrade/comparison surface; Testing documentation is a preview. An
internet connection is not required to open the installed guide.

## State backends

| Backend | Supported baseline | Vector behavior | Deployment notes |
|---|---|---|---|
| PostgreSQL | 15/16 with pgvector | pgvector-backed retrieval | The reference standalone stack uses the `pg16` image |
| Elasticsearch | 8.x; client pinned to 8.12.1 and legacy stack target 8.19.12 | Agentic SOC vector-store implementation for the ES profile | Requires a management key scoped only to `tlsoc-agent-*`; explicit owned-ledger lifecycle additionally needs cluster `manage_ilm` + `manage_index_templates` + `monitor` and Hot/Warm roles |
| SQLite | SQLite through `aiosqlite` | SQL/in-process-compatible development path | Single-node file profile; exercised by the offline test suite |

The state backend is independent of telemetry connectors. A PostgreSQL deployment can
read Elasticsearch/OpenSearch/Wazuh or accept only pushed events; an Elasticsearch
state deployment can also connect to a different source cluster.

## Telemetry sources

Version 0.2 implements three pull connectors:

- Elasticsearch;
- OpenSearch;
- Wazuh Indexer.

It also registers 16 push, queue, stream, object-store, and file receivers: webhook,
HEC-compatible HTTP, syslog, Kafka, SQS, Kinesis, Azure Event Hub, GCP Pub/Sub,
RabbitMQ, NATS, MQTT, Redis Streams, S3, GCS, Azure Blob, and local file/directory.
Several require optional connector dependencies, loaded lazily only when selected.

Additional vendor names in `SourceType` are reserved/planned and are not evidence of
an implemented pull connector. Check the live connector catalog at
`GET /api/connectors` or the [Source support matrix](../sources/support-matrix.md).

## Models and enrichment

The model gateway recognizes:

- Anthropic;
- OpenAI;
- Azure OpenAI;
- AWS Bedrock;
- Google Vertex;
- OpenAI-compatible endpoints such as LiteLLM, vLLM, Ollama, or LM Studio;
- the deterministic mock provider for test/demo paths.

All providers are called through the same usage/cost-ledger gateway. A provider being
listed does not imply that every model name, region, or account feature has been
certified; test the configured model from the Console/API.

Agentic SOC registers 19 enrichment provider classes. Providers are selected by indicator
kind, enablement, and key availability. Keyless services and Redis/in-memory cache
fallbacks reduce setup requirements, but third-party service availability, rate limits,
licensing, and response contracts remain external dependencies.

## Deployment shapes

| Shape | Application state | Source model | Supported UI |
|---|---|---|---|
| Standalone Compose | PostgreSQL/pgvector plus Redis | Add pull/push sources from setup | Agentic SOC Console behind nginx |
| Legacy ELK merge | Elasticsearch `tlsoc-agent-*` plus Redis | Read-only connection to the existing log indices | Agentic SOC Console deployed separately/alongside |
| Direct development | Elasticsearch, SQLite, or configured PostgreSQL | Explicit connectors or implicit Elastic defaults | Vite development server |

The legacy merge does not modify Kafka, Logstash, the upstream detection engine,
Elasticsearch log indices, or Kibana. Agentic SOC is a read-only consumer of that telemetry
path.

## API and stored-data compatibility

Version 0.2 currently uses Semantic Version `0.2.0`. As a pre-1.0 product, it prioritizes
additive API and model changes but does not promise indefinite wire or storage
compatibility across future minor versions.

For integrations:

- pin an exact application patch and documentation line;
- tolerate unknown JSON response fields;
- use OpenAPI request models instead of copying UI-internal TypeScript types;
- test changes on `Testing`, promote the accepted source tree to `main`/Stable, and
  re-run the gate on the resulting `main` commit;
- back up the state store and secrets before an upgrade;
- do not assume that starting an older image is a safe database rollback.

Persisted Pydantic models generally use defaults/migrations for additive fields, and
shared KV stores avoid a new table for many features. Version 0.2 does not yet provide
a complete database migration/rollback framework. See [Upgrades](../operations/upgrades.md).

## Browser, proxy, and network expectations

No formal per-browser certification matrix is published for 0.2. Use a maintained
browser capable of modern ES modules, CSS variables, and server-sent events. The
Console expects same-origin relative `/api` access; the reference nginx configuration
provides that proxy. If a custom proxy changes origins, cookies, buffering, or SSE
behavior, validate login, refresh, uploads, and event reconnection explicitly.

Outbound access is needed only for the model/enrichment services selected by the
operator. A fully self-hosted OpenAI-compatible model can remove third-party model
egress, but source and enrichment network paths still depend on configuration.

## Explicitly unsupported or unverified claims

Agentic SOC 0.2 does not claim high availability, coordinated horizontal workers,
multi-tenant row isolation, universal push-transport durability, autonomous write-side
response, or production certification for every source/provider combination. Review
[Known limitations](../releases/known-limitations.md) and [Security](security.md)
before production use.
