---
title: Connect sources
description: Add, validate, monitor, and safely expand an Agentic SOC 0.2 source.
---

# Connect sources

This guide applies to **Agentic SOC 0.2** and is for operators and integrators. A source is
one configured connector instance: a particular cluster, sender, broker, bucket, or
file input with its own identity, transport, feeds, mappings, and secret presence.

## Choose the physical path

| Path | Who initiates delivery | Built-in examples |
| --- | --- | --- |
| Pull | Agentic SOC polls a read/search API | Elasticsearch, OpenSearch, Wazuh indexer |
| HTTP push | The source posts to Agentic SOC | Generic webhook, Splunk HEC-compatible receiver |
| Socket | The source connects to a listener | RFC 3164/5424 syslog over UDP or TCP |
| Queue or stream | Agentic SOC consumes a broker | Kafka, SQS, Kinesis, Event Hubs, Pub/Sub, RabbitMQ, NATS, MQTT, Redis Streams |
| Object or file | Agentic SOC reads new objects or file content | S3, GCS, Azure Blob, local file/directory |

See the [support matrix](support-matrix.md) before choosing a connector. Reserved
vendor names in the API do not imply a built-in runtime connector.

## Safe onboarding sequence

1. Create a stable source ID and descriptive display name.
2. Configure the smallest useful scope: one test index, alert feed, queue, bucket
   prefix, or authenticated sender.
3. Supply secret values through the source secret flow. Agentic SOC persists configured
   field names, not the values.
4. Test a pull connector before saving. Save and exercise a push or broker receiver;
   it has no meaningful generic one-shot connection probe.
5. Send one synthetic record with a unique native ID.
6. Verify source health, recent coverage, normalized fields, and provenance.
7. Verify the resulting candidate or case before widening scope.

## Source lifecycle

The Sources page lets authorized operators create, update, enable, disable, and
delete sources. A new enabled primary source unsets the previous primary. Only a
pull/search connector can be primary; push receivers still participate fully in
ingestion and cases. The Console offers Make primary only for a pull source, and says it
worked only when the server confirms it. While Demo Mode is on, the Demo sources are
read-only: a change to one is refused with `409 source_demo_readonly`.

Editing a source reconciles its background receiver set. Rotating a pull credential
rebuilds that source's query client for the next operation.

Deleting a source removes its runtime secret values and stops its receiver. It does
not delete events from the upstream system. Review reset and retention behavior
before treating source deletion as case-data deletion.

## Monitor coverage

Use source health and coverage to answer:

- Is the source enabled and configured?
- Did its latest pull succeed?
- When was its latest event seen?
- Is the source unexpectedly silent?
- What is its recent event rate?
- Are all feeds failing or only one?

The per-source log view is bounded. Pull sources run a scoped read; push sources show
a recent process-local live tail. Neither replaces the authoritative source archive.

## Agentic SOC 0.2 boundaries

Operate one backend replica. Runtime-entered source secrets are memory-only. HTTP
push has no durable receipt inbox before processing, and several receivers have
transport-specific checkpoint or acknowledgment limits. Read the connector's
boundary in the [support matrix](support-matrix.md).

## Related pages

- [Pull sources](pull.md)
- [HTTP and syslog](http-syslog.md)
- [Queues and object stores](queues-object-stores.md)
- [Feeds and field mapping](feeds-mapping.md)
