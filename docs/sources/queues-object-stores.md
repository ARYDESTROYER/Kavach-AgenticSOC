---
title: Queues and object stores
description: Connect broker, stream, object-store, and file receivers while preserving retry and checkpoint semantics.
---

# Queues and object stores

This guide applies to **Agentic SOC 0.2** and is for operators integrating retained
transports. The default full backend image includes the client libraries named by
the built-in connector manifests; an intentionally lean core build may omit them.

## Built-in families

| Family | Connectors |
| --- | --- |
| Brokers and queues | Kafka/Redpanda, AWS SQS, Azure Event Hubs, Google Pub/Sub, RabbitMQ, NATS/JetStream, MQTT, Redis Streams |
| Provider streams | AWS Kinesis |
| Object stores | AWS S3, Google Cloud Storage, Azure Blob Storage |
| Host files | Local file or directory tail |

Availability in the image proves packaging, not live-provider certification. Check
the [support matrix](support-matrix.md) for connector-specific limits.

## Configure a receiver

1. Create one source per independently owned topic, subscription, stream, bucket
   prefix, or file path.
2. Set a stable consumer-group, subscription, shard, prefix, or path identity.
3. Store credentials through the source secret tier or deployment environment.
4. Match the parser hint to JSON, NDJSON, CEF, LEEF, GELF, syslog, key/value, or
   gzip-compressed text where supported.
5. Set provider visibility, lease, or acknowledgement timeouts longer than the
   expected processing interval.
6. Send a synthetic record and inspect source health, normalized fields, and the
   resulting candidate/case.

## Acknowledgment principle

The source transport should retain a record until Agentic SOC confirms processing. Kafka
withholds its offset commit after a processing error, and S3 notification mode
retains a failed queue message. Other transports must be tested against their client
and provider behavior.

Agentic SOC uses stable source identities and cursors to make retry safer, but network
exactly-once delivery is not claimed. Idempotent source IDs, retained input, and
replay procedures remain necessary.

## Checkpoints and restart

Object-store and Kinesis receivers can attach to the Agentic SOC cursor store. Broker
offsets or subscriptions may also be durable in the provider. The exact guarantee is
connector-specific; do not infer a shared durability level from the word “queue.”

Validate all of these before widening scope:

- restart after receipt but before case creation;
- duplicate delivery of one native event ID;
- a poison record followed by valid records;
- consumer rebalance, visibility timeout, or shard change;
- object overwrite and late arrival; and
- credential rotation.

## Important 0.2 limits

- There is no common durable receipt/dead-letter ledger before correlation.
- Event Hubs' default checkpoint path and some object/file progress paths require
  environment-specific validation.
- MQTT acknowledgment behavior is not suitable for a loss-intolerant path without
  explicit integration testing.
- S3 supports text formats and gzip, not Security Lake OCSF Parquet.
- A local file path must be mounted into the backend container.
- NATS core messaging is not replayable; use JetStream when retention matters.

Run one backend replica so receiver ownership and in-process supervision are not
duplicated.

## Related pages

- [Connect sources](index.md)
- [Source support matrix](support-matrix.md)
- [Ingestion and investigation](../architecture/ingestion.md)
