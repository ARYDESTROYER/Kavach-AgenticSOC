# COMPATIBILITY.md — what the suite runs on, reads from, and stays compatible with

Agentic SOC is a **vendor-agnostic agentic SOC** triage system. It
was built next to the original TrustLab / IIT Bombay ELK pipeline and still slots
into it cleanly as a **read-only consumer**, but it is no longer tied to that one
stack: log sources are pluggable connectors, the canonical internal schema is
**OCSF**, the suite's own state runs on a **selectable backend** (Elasticsearch,
PostgreSQL+pgvector, or SQLite), and the **sole primary surface** is a
**standalone web UI** (the Kibana plugin is **archived** — see §F).

This document is the compatibility matrix: what each piece needs, what is
supported today, and which upstream-compatibility guarantees still hold.

---

## A. State backends (the suite's OWN bookkeeping)

The suite owns cases/audit/usage/config/cursor and the RAG vector store. Where
that state lives is selected by the `STATE_BACKEND` env var (compose maps
`TLSOC_STATE_BACKEND` → it). The agent's **read-only log surface is always on the
connector layer** regardless of this setting — `STATE_BACKEND` only moves the
suite's management state, so self-hosting needs no Elasticsearch at all.

| `STATE_BACKEND` | Versions | What it needs | Pip deps | Notes |
|---|---|---|---|---|
| `elasticsearch` (default) | Elasticsearch **8.x** (tested against 8.12.x client / 8.19.12 stack) | a management API key scoped to `tlsoc-agent-*` (`ES_MGMT_API_KEY`) | `elasticsearch[async]` (already a base dep) | Today's path: own-state in `tlsoc-agent-*` indices. Falls back to an in-memory store if ES is unreachable so the spine still runs. |
| `postgres` | PostgreSQL **15 / 16** with the **pgvector** extension | `STATE_DB_URL` (`postgresql+asyncpg://…`); a reachable Postgres + pgvector (compose ships `pgvector/pgvector:pg16`) | `sqlalchemy`, `asyncpg`, `pgvector` (asyncpg/pgvector imported **lazily**, only when selected) | Production self-hosted path. RAG vectors are stored as JSON and, since 0.2.0, ranked in the backend process with an in-memory matrix; pgvector ranks only a very large corpus. |
| `sqlite` | bundled (file DB) | `STATE_DB_URL` defaults to `./tlsoc.db` if unset | `sqlalchemy`, `aiosqlite` | Zero-service dev/test path; the SQL state store is exercised **offline on SQLite** by the test suite (no Postgres needed). |

The SQL backends share one SQLAlchemy-async implementation
(`backend/app/stores/sql/`); the abstract repositories in
`backend/app/stores/base.py` are satisfied identically by the ES-backed and
SQL-backed stores, so every caller (pipeline/chat/standup/poller/routes) is
backend-agnostic. **Audit is append-only in every backend** — the repository
interface exposes no update/delete on a recorded action (non-negotiable #2).

---

## B. Log sources (what the agent reads security events FROM)

A "source" is any system the suite reads security events from. Every connector
normalises native records into **OCSF** (`backend/app/ocsf/`) before the engine
sees them. Sources are added at runtime via the first-run wizard (each becomes a
`SourceInstance`); an empty source list preserves the legacy single implicit
Elasticsearch source wired from `Secrets`.

Two halves of the connector SPI: **PULL** (we poll a query API on a durable
cursor) and **PUSH / QUEUE / OBJECT_STORE** (the source forwards to a receiver we
run). Every receiver's optional client library is imported **lazily inside
`start()`**, so the suite installs and the full test suite passes with **no
optional deps** present; a missing dep raises a wizard-friendly `pip install`
hint, never an import-time crash.

### B1. Pull connectors (today)

| Source | `SourceType` | Transport | How | Extra pip |
|---|---|---|---|---|
| Elasticsearch | `elasticsearch` | PULL (ES `_search` API) | read-only API key at `ES_URL`; reuses the centralised query builder | none beyond base `elasticsearch[async]` |
| OpenSearch | `opensearch` | PULL | subclasses the Elastic connector; Lucene query language; tags OCSF `metadata.source_type=opensearch` | none |
| Wazuh | `wazuh` | PULL (Wazuh indexer = OpenSearch) | subclasses the Elastic/OpenSearch connector; Wazuh alert → OCSF mapping | none |

> `SourceType` also enumerates Splunk, Microsoft Sentinel, QRadar, Chronicle,
> CrowdStrike, SentinelOne, and Defender as **planned** pull/stream connectors.
> They are reserved in the enum but **not yet implemented** (Splunk + Sentinel are
> the next planned pull connectors). Out-of-tree connectors register via the
> `tlsoc.connectors` entry-point group — `pip install tlsoc-connector-<vendor>`
> and it appears in the wizard with zero core change.

### B2. Push / queue / object-store receivers (16, today)

All registered in `BUILTIN_RECEIVERS` (`backend/app/connectors/receivers/`).
`requires_pip` is what the wizard tells the operator to install for that receiver.

| Receiver | `SourceType` | Ingest mode | Optional pip (`requires_pip`) |
|---|---|---|---|
| Webhook (HTTP JSON/NDJSON/CEF/LEEF) | `webhook` | PUSH_HTTP | none (FastAPI owns the port) |
| Splunk HEC-compatible | `hec` | PUSH_HTTP | none |
| Syslog (RFC 3164 / 5424, UDP/TCP/TLS) | `syslog` | PUSH_SYSLOG / PUSH_SOCKET | none (stdlib asyncio) |
| Kafka / Redpanda / Confluent | `kafka` | QUEUE | `confluent-kafka` |
| AWS SQS | `aws_sqs` | QUEUE | `boto3` |
| AWS Kinesis | `aws_kinesis` | QUEUE / STREAM | `boto3` |
| Azure Event Hub | `azure_event_hub` | QUEUE | `azure-eventhub` |
| GCP Pub/Sub | `gcp_pubsub` | QUEUE | `google-cloud-pubsub` (+ `google-auth` for SA creds) |
| RabbitMQ | `rabbitmq` | QUEUE | `aio-pika` |
| NATS | `nats` | QUEUE | `nats-py` |
| MQTT | `mqtt` | QUEUE | `paho-mqtt` |
| Redis Streams | `redis_streams` | QUEUE | `redis` (already a base dep) |
| AWS S3 / Security Lake | `s3` | OBJECT_STORE | `boto3` |
| GCS | `gcs` | OBJECT_STORE | `google-cloud-storage` |
| Azure Blob | `azure_blob` | OBJECT_STORE | `azure-storage-blob` |
| Local file / directory tail | `file` | OBJECT_STORE / PUSH_SOCKET | none (stdlib) |

Syslog TLS is a real TLS 1.2+ server transport, not a compatibility label. It accepts
mounted server certificate/key paths, an optional write-only private-key password,
and an optional client CA with required mTLS. Selecting TLS without readable required
material fails that receiver closed; it never silently downgrades to plaintext TCP.
See `DEPLOY.md` §3.6 for the exact fields and mount requirements.

Payload parsing (JSON, NDJSON, CEF, LEEF, RFC 5424/3164 syslog, GELF, key/value)
is shared (`receivers/formats.py`); records are normalised to OCSF via
`generic_to_ocsf` before ingestion.

---

## C. Canonical schema — OCSF

- **OCSF version pinned: `1.4.0`** (`OCSF_VERSION` in `backend/app/constants.py`).
  It is stored on every event (`metadata`), because OCSF renumbers classes across
  minor versions.
- The OCSF model (`backend/app/ocsf/model.py`) keeps a first-class **`unmapped`**
  catch-all plus `raw_data` (the original source record) so no source data is ever
  lost. **Both `unmapped` and any log-derived value are UNTRUSTED data** and are
  wrapped in the labelled fences (`UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE`) before
  reaching any prompt — non-negotiable #9 still holds end-to-end.
- ECS → OCSF mapping for the Elastic family lives in `backend/app/ocsf/ecs.py`.

---

## D. Runtimes and LLM providers

| Component | Requirement |
|---|---|
| Backend | **Python 3.11**; FastAPI + LangGraph; deps pinned in `backend/requirements.txt` (`sqlalchemy`/`aiosqlite`/`asyncpg`/`pgvector` added for the SQL backends) |
| Standalone web UI | **Node 22**; Vite + React 18 + TypeScript + **Tailwind CSS** + shadcn-style primitives on **Radix UI** (**not** `@elastic/eui` — fully removed); builds with `tsc --noEmit && vite build`; **no Kibana** required |
| Kibana plugin | **ARCHIVED** (`archive/kibana-plugin/`, frozen 2026-06-21) — not built, tested, or shipped; last built for Kibana **8.12.2** and **8.19.12** (see §F) |
| LLM providers | **7**, all through the single gateway: `anthropic`, `openai`, `azure`, `bedrock`, `vertex`, `openai_compatible` (self-hosted LiteLLM/vLLM/Ollama/LM Studio), `mock` (offline tests only); fresh completion roles default to OpenAI `gpt-5.6-luna`, embeddings to `text-embedding-3-small`, and stored/operator assignments remain authoritative |
| Enrichment | **19 registered providers** across 17 files — AbuseIPDB, VirusTotal, GreyNoise, Shodan, Shodan InternetDB, Censys, BinaryEdge, IPinfo, OTX, Pulsedive, Spur, XForce, URLScan, HIBP, ProjectHoneypot, RDAP, URLhaus, ThreatFox, MalwareBazaar (Redis-cached; degrades to in-memory); several keyless ones default ON |

---

## E. Deployment shapes

| Stack | File | Brings up | When |
|---|---|---|---|
| Agnostic (recommended) | `deploy/docker-compose.agnostic.yml` | Postgres+pgvector, Redis, backend (`STATE_BACKEND=postgres`), standalone webui (nginx) | Self-hosted; **no Elasticsearch for the app's own state**. Connect your SIEM/EDR from the wizard. |
| Legacy ELK merge | `deploy/docker-compose.tlsoc.yml` | `tlsoc-backend` (+ optional `tlsoc-redis`) joined to the existing ELK stack | Attaching to an existing `TLSOCDockerDeploy` ELK stack as a read-only consumer. The standalone webui remains the surface (deployed separately or via the agnostic webui image) — the Kibana plugin is **archived**, not part of this flow (see §F). |

---

## F. Kibana plugin — ARCHIVED, not built or shipped

The standalone web UI is the **sole primary** surface. The Kibana plugin that
used to embed the console inside an existing Kibana was retired into
[`archive/kibana-plugin/`](archive/kibana-plugin/) on 2026-06-21 when the suite
completed its vendor-agnostic transition (see
[`archive/README.md`](archive/README.md)). It is **frozen**: not built, tested,
or shipped by any current tooling — do not develop it.

While it was live it built from a **single source tree** for two Kibana
versions — **8.12.2** and **8.19.12** — as two pre-built zips
(`tlsocAgenticTriage-8.12.2.zip` / `-8.19.12.zip`), portable via `@kbn/*` import
aliases (the 8.12 → 8.19 delta was import paths only, no EUI/logic/contract
change) and a `--kibana-version` build stamp. The full recipe (version matrix,
manifest quirks, verification steps) is preserved at
[`archive/kibana-plugin/BUILD.md`](archive/kibana-plugin/BUILD.md).

**If a deployment genuinely needs the embedded-in-Kibana experience again:** the
backend API contract is unchanged and additive-only, so the plugin's
server-side proxy (`/api/tlsoc/*`) still works in principle — reviving it is a
do-it-yourself exercise (move it back under a build root, re-pin it against the
target Kibana's `@kbn/*` packages, rebuild per `BUILD.md`). The standalone
`webui/` is the supported path.

---

## G. Upstream-pipeline compatibility (still true for the legacy ELK merge)

When attached to the original `sankettaware16/foss-soc-engine` +
`sankettaware16/TLSOCDockerDeploy` ELK pipeline:

```
rsyslog (omkafka) → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana
```

- **Read-only consumer.** No new ingestion, no Kafka consumer, no writes to the
  log data path. The suite **polls** Elasticsearch (the store, not the stream).
- **ECS read configurably.** Default entity mapping matches the engine's fields
  (`source.ip`, `user.name`, `host.name`) and rule/severity fields (`event.module`
  as per-event rule identity, `rule.name`/`rule.id`, `event.severity`); all are
  wizard-configurable. Heterogeneous severity is tolerated (`coerce_float`).
- **No service modified.** `tlsoc-backend` joins the existing default Compose
  network, reaches `https://elasticsearch:9200` by container-name DNS, mounts the
  existing CA read-only (`./certs/ca/ca.crt`), uses `TLSOC_`-prefixed env so it
  cannot clash with `ELASTIC_PASSWORD`/`KIBANA_PASSWORD`, and touches no port on
  `9200`/`5601`/`9092-9094`. Kafka/Logstash/ES definitions are untouched.
- **Additive proxy contract.** The Kibana proxy forwards arbitrary JSON bodies, so
  additive request/response fields need **no proxy change**.

### The security boundary — two scoped keys, never the superuser

| Key | Scope | Privileges | Used by |
|---|---|---|---|
| `ES_API_KEY` | log indices (e.g. `all-logs-*`) | `read`, `view_index_metadata` | the agent's pull connector / `es_query` — the **only** path to log data |
| `ES_MGMT_API_KEY` | `tlsoc-agent-*` | Index: `read`, `write`, `create_index`, `view_index_metadata`, `manage`; cluster: `manage_ilm`, `manage_index_templates`, `monitor` | the backend's own state indices and explicit lifecycle capability/apply (only when `STATE_BACKEND=elasticsearch`) |

The read-only key is wired to a **physically separate** ES client
(`RealESClient._ro`) so "running next to Kibana" can never silently escalate what
the agent can touch. `kibana_system` and the `elastic` superuser are **forbidden
at runtime** (non-negotiable #1).

## H. What the suite deliberately does NOT do (legacy ELK merge)

- Does **not** modify `foss-soc-engine`, its rules, or its ECS output schema.
- Does **not** modify any existing `TLSOCDockerDeploy` service, the
  rsyslog→Kafka→engine→Logstash→ES path, or the certs.
- Does **not** write to, block, or slow the log data path (read-only consumer).
- Does **not** use `kibana_system` or the `elastic` superuser at runtime.
- Does **not** add a Kafka consumer to the upstream path or any new upstream
  ingestion (push/queue receivers are the suite's OWN inbound surface, separate).
- Does **not** compile the archived Kibana plugin on the SIEM server, if ever
  revived (pre-built zip only, §F).
