---
title: HTTP and syslog sources
description: Configure authenticated webhook, HEC-compatible, and network-restricted syslog ingestion in Agentic SOC 0.2.
---

# HTTP and syslog sources

This guide applies to **Agentic SOC 0.2** and is for integrators forwarding events directly
to Agentic SOC. HTTP uses the Agentic SOC API listener; syslog binds a separate UDP or TCP port.

## Generic webhook

Create a source with a stable ID, select a body format or automatic detection, and
choose one authentication mode:

| Mode | Use |
| --- | --- |
| `bearer` | Sender provides `Authorization: Bearer <token>` |
| `hmac` | Sender signs the exact request body with HMAC-SHA256 |
| `none` | Only behind a trusted authenticating proxy and restricted network |

Store the token or shared secret through the source secret control after saving the
source. Post records to:

```text
POST /api/ingest/<source-id>
```

Supported text formats include JSON objects/arrays, NDJSON, CEF, LEEF, GELF, and
key/value data. The API caps one request body at 25 MiB.

### Bearer example

```bash
curl --fail-with-body \
  -X POST https://tlsoc.example.com/api/ingest/edr-webhook \
  -H 'Authorization: Bearer REPLACE_WITH_SOURCE_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"event":{"id":"example-001"},"source":{"ip":"192.0.2.10"},"message":"Synthetic check"}'
```

Use the HEC connector for a Splunk HEC event envelope and `Authorization: Splunk
<token>` semantics.

### Delivery contract

Authentication happens before payload parsing. If the batch cannot be persisted,
Agentic SOC returns `503` with a retry hint rather than claiming success. The sender must
retain and retry the complete request with stable native event IDs.

Agentic SOC 0.2 does not yet commit an independent durable receipt before correlation. A
process or host failure in that window can lose a pushed record, so keep the sender's
retry/retention path authoritative.

## Syslog

The syslog receiver parses RFC 3164 and RFC 5424 messages. TCP supports newline and
RFC 6587 octet-counting framing. Configure:

- bind address;
- listener port;
- `udp` or `tcp` protocol;
- TCP framing; and
- optional format hint.

Use a high port such as `5514` when the container or process does not have permission
to bind below 1024. Publish or route that port explicitly; the shared HTTP API port
does not receive syslog datagrams.

!!! danger "The `tls` selection is not encrypted in 0.2"

    The current syslog TLS option does not build a certificate-backed TLS context.
    Treat it as plain TCP. Terminate TLS in a trusted forwarder or proxy, or use an
    authenticated queue/HTTPS path. Syslog itself has no application authentication,
    so restrict network reachability.

UDP can lose or reorder messages and cannot report a persistence failure to the
sender. Prefer TCP or a durable queue for loss-sensitive telemetry.

## Verify

1. Send one synthetic message with a unique native ID or distinctive rule.
2. Confirm the source's last-event time changes.
3. Browse the source live tail and validate field mapping.
4. Confirm the candidate or case retains the correct source provenance.
5. Repeat the same HTTP delivery and verify it does not create a second event/case.

## Related pages

- [Feeds and field mapping](feeds-mapping.md)
- [Queues and object stores](queues-object-stores.md)
- [Known limitations](../releases/known-limitations.md)

