---
title: Custom connectors
description: Extend Agentic SOC 0.2 with an out-of-tree connector that preserves manifests, OCSF, provenance, secrets, and retry behavior.
---

# Custom connectors

This guide applies to **Agentic SOC 0.2** and is for Python integrators building a source
adapter outside the core repository. Installed connector packages are discovered
through the `tlsoc.connectors` entry-point group.

## Choose a connector shape

Subclass one of the two public connector shapes:

- `PullConnector` when Agentic SOC drives a read/search API; or
- `PushReceiver` when Agentic SOC owns a listener, consumes a broker, watches a stream, or
  reads objects asynchronously.

Both inherit `Connector`, expose a manifest, and normalize native records to OCSF.

## Required contract

### Manifest

Return a `ConnectorManifest` containing:

- an existing stable `SourceType` value and a display name;
- category and ingest modes;
- capabilities such as poll, search, fetch, subscribe, browse, or test;
- non-secret configuration fields;
- secret authentication fields marked `secret=True`;
- optional package dependencies; and
- concise setup guidance and connector boundaries.

The wizard and API render this metadata. Do not create a second connector-specific
configuration UI. In 0.2 the registry is keyed by the built-in `SourceType` enum, so
an out-of-tree vendor connector normally implements one of the reserved vendor types.

### Pull connector

Implement:

- `ping()` or a safer connector-specific connection test;
- cursor-aware, ascending `poll()`;
- source-neutral structured `search()`; and
- `fetch_by_ids()`.

Return the native-query rendering where possible so cases and audit can explain what
was read. All source access must be read-only.

### Push receiver

Implement long-running `start(emit, prefs)` and `stop()`, plus a deterministic parser
for unit and integration testing. Emit complete batches only after transport
authentication and parsing. Withhold acknowledgment or checkpoint advancement when
the downstream emit fails.

Use the attached cursor I/O for provider markers when the receiver owns progress.

### OCSF and provenance

Override `to_ocsf()` for a precise vendor mapping, or use the generic mapper. Every
event must preserve:

- configured source/connector ID;
- stable source-scoped native event identity;
- UTC time and normalized severity;
- useful entity and rule fields;
- original data; and
- unmapped fields that have no canonical home.

Treat all source-controlled values as untrusted data in later prompts.

## Register the package

Expose the connector class from the Python package metadata:

```toml
[project.entry-points."tlsoc.connectors"]
acme_security = "tlsoc_connector_acme:AcmeConnector"
```

After installation into the backend environment, restart the API and check
`GET /api/connectors`. The manifest should appear without a core code change.

## Acceptance checklist

- Manifest fields render and secrets are never echoed.
- Pull credentials are least-privilege and read-only.
- A retry with the same native event ID is idempotent.
- Cursor or broker progress advances only after a confirmed emit.
- Parsing and normalization fail with actionable, secret-free errors.
- Source provenance remains visible through the case and audit trail.
- Package dependencies are declared and included in the intended image.
- Restart, poison-record, redelivery, and credential-rotation tests pass against the
  real transport.

## Related pages

- [Source support matrix](support-matrix.md)
- [OCSF normalization](../concepts/ocsf.md)
- [Queues and object stores](queues-object-stores.md)
