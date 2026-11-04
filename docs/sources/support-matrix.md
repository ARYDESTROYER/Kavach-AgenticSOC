---
title: Source support matrix
description: Connector availability, dependencies, acknowledgement boundaries, and validation status for Agentic SOC 0.1.
---

# Source support matrix

The wizard discovers **19 built-in connectors**: 3 pull connectors and 16 push,
queue, or object-store receivers. The default `full` backend image installs every
client named by those manifests. “Installed” still does **not** mean the vendor has
certified this release or that its transport durability has passed a live matrix.

## Status definitions

- **Core + full**: adapter and client are available in both image targets.
- **Full image**: adapter is built in and its pinned optional client is installed by
  the default final image. The deliberately lean `core` target omits that client.
- **Reserved**: the source type exists for compatibility/roadmap purposes; no
  built-in runtime connector is registered.

All sources should be validated against a non-production tenant and a synthetic
alert before wider rollout. Packaging and offline contract tests do not constitute
live-vendor certification for Agentic SOC `0.1.13`.

## Pull sources

| Source | Mode | Image status | Current capability | Boundary |
|---|---|---|---|---|
| Elasticsearch | Pull | Core + full | PIT + `search_after` polling, structured search, fetch by ID, browse, draft connection test | Five-minute late overlap and bounded per-tick page/ID ledger |
| OpenSearch | Pull | Core + full | Same connector contract with OpenSearch provenance and draft connection test | Validate exact distribution; no-PIT offset fallback is not exactly-once during concurrent refresh |
| Wazuh indexer | Pull | Core + full | Reads `wazuh-alerts-*` with Wazuh field defaults and draft connection test | Connect to the indexer, not the dashboard; same PIT/fallback bounds apply |

Pull sources are read-only consumers. Use a credential limited to `read` and index
metadata on the exact log patterns; never use an Elastic superuser,
`kibana_system`, or an OpenSearch/Wazuh administrator.

## Receivers available in core and full images

| Receiver | Mode | Formats/protocol | Important boundary |
|---|---|---|---|
| Generic webhook | HTTP push | JSON, NDJSON, CEF, LEEF, GELF, key/value | Use bearer or HMAC authentication; `none` is only for a trusted reverse proxy/network |
| Splunk HEC-compatible | HTTP push | HEC event envelope and token authentication | This is an inbound HEC receiver, not a native Splunk search connector |
| Syslog | UDP/TCP/TLS listener | RFC 3164, RFC 5424, RFC 6587 TCP framing | UDP is lossy. TLS requires mounted certificate/private-key paths; optional client-CA verification enables mTLS. Selecting TLS fails closed when its material is missing. |
| Local file/directory | File tail | Auto-detected text formats | Container path must be mounted; byte offsets are process-local in version 0.1 |
| Redis Streams | Queue | Consumer group via the bundled Redis client | Production replay/claim behaviour and multi-replica ownership are not yet certified |

The push path normalises and processes inline. HTTP ingestion returns a retryable
error, Kafka withholds its offset commit, and S3 notification mode retains the queue
message when processing fails. There is not yet a durable receipt/inbox between the
transport and correlation, and not every adapter has equivalent acknowledgement
semantics. The sender or broker must retain and retry until that layer ships.

## Additional adapters in the default full image

The default Docker final stage installs the pinned
`backend/requirements-connectors.txt`; the Python distribution exposes the same set
through the `connectors` extra. Operators who deliberately build `--target core`
omit these clients and should not configure their adapters.

| Source | Mode | Client package in `full` | Current boundary |
|---|---|---|---|
| Apache Kafka / Redpanda | Queue | `confluent-kafka` | Validate offset commit, rebalance, TLS/SASL, and poison-message behaviour in an integration environment |
| AWS SQS | Queue | `boto3` | Validate visibility timeout and redelivery under slow investigations |
| AWS Kinesis | Queue/stream | `boto3` | Per-shard sequence is persisted after successful emit; validate recovery, expired iterators, and resharding |
| AWS S3 | Object store | `boto3` | List mode persists the last object key; SQS-notification mode retains failed work; JSON/text+gzip work; Parquet does not |
| Azure Event Hubs | Queue | `azure-eventhub` | Default checkpoint path is not durable; add/validate a checkpoint store |
| Azure Blob Storage | Object store | `azure-storage-blob` | Last blob name is persisted; validate overwrite, lexicographic ordering, and late-object behaviour |
| Google Cloud Pub/Sub | Queue | `google-cloud-pubsub` | Validate ack deadline extension and redelivery |
| Google Cloud Storage | Object store | `google-cloud-storage` | Last object name is persisted; validate overwrite, lexicographic ordering, and late-object behaviour |
| RabbitMQ | Queue | `aio-pika` | Validate publisher confirms/dead lettering on the source side and consumer recovery |
| NATS / JetStream | Queue | `nats-py` | Use JetStream for durable consumption; core NATS alone is not replayable |
| MQTT | Queue | `paho-mqtt` | Current callback schedules processing asynchronously, so protocol acknowledgement can precede successful processing; do not use as a loss-intolerant path in version 0.1 |

The distribution contract verifies that every manifest dependency is present in the
full requirement set and that the built wheel contains all modules, the 12 built-in
runbooks, and registry data, and none of the removed procedure modules. That proves packaging availability, not provider
connectivity. Add live dependency/transport tests for the clients you operate.

## Reserved, not implemented as built-ins

| Family | Reserved source types | Use today |
|---|---|---|
| SIEM search | Splunk, Microsoft Sentinel, QRadar, Google Chronicle | Export to an implemented webhook/HEC/queue/object-store receiver, or build an out-of-tree connector |
| EDR/XDR | CrowdStrike, SentinelOne, Microsoft Defender | Forward alerts to authenticated webhook/queue transport, or build an out-of-tree connector |
| Forward protocols | Beats/Lumberjack, Fluent forward, OTLP logs, Apache Pulsar | Place a supported forwarder/queue in front, or contribute a connector |

The connector registry supports third-party packages through the
`tlsoc.connectors` Python entry-point group. An out-of-tree connector must still
normalise to OCSF, expose its secret/config schema, preserve source identity, and
obey the same acknowledgement and audit contracts.

## Format and schema coverage

| Input | Parser status | Notes |
|---|---|---|
| JSON object/array | Built in | Generic field mapping; validate entity and severity paths |
| NDJSON | Built in | One record per line |
| CEF | Built in | Header and extension parsing; vendor extensions remain in unmapped data |
| LEEF | Built in | LEEF 1/2 delimiter handling |
| GELF | Built in | JSON GELF shape |
| RFC 3164/5424 syslog | Built in | Transport and payload format are separate concerns |
| key/value text | Built in | Best-effort generic mapping |
| gzip object | Built in | Decompressed before text-format detection |
| Parquet / OCSF Security Lake | Not implemented | Do not select the advertised `parquet` hint for production |

Every mapping should be evaluated for timestamp, native ID, rule, severity, user,
host, source/destination address, and source provenance. The target versioned
mapping-assistant workflow is described in
[Ingestion and investigation](../architecture/ingestion.md#normalisation-and-the-mapping-assistant).
