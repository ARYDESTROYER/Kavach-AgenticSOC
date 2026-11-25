---
title: OCSF normalization
description: Understand the canonical Agentic SOC 0.2 event shape, field mapping, severity, provenance, and lossless source data.
---

# OCSF normalization

This page applies to **Agentic SOC 0.2** and is for source integrators and operators
validating field mapping. Agentic SOC pins its canonical event subset to **OCSF 1.4.0**.

Every connector converts its native record into the same event model before
correlation, risk, investigation, or case management sees it. This keeps the engine
source-neutral while preserving the original record for review.

## Canonical fields

The shipped subset includes:

- OCSF category, class, activity, and type identifiers;
- UTC event time in epoch milliseconds;
- OCSF severity ID;
- message and optional status;
- source product and connector provenance;
- source and destination endpoints;
- device and actor user;
- typed observables;
- finding title and source rule ID; and
- `unmapped` and `raw_data` carry-through fields.

`metadata.source_type` records the connector family,
`metadata.connector` records the configured source ID, and `metadata.uid` carries a
stable source-scoped event identity.

## Mapping paths

Elasticsearch, OpenSearch, and Wazuh records use the ECS-aware mapper and the
operator-configured field paths. Generic JSON receivers first use configured paths,
then probe common aliases for timestamp, address, user, host, rule, severity, and
message.

Unknown source shapes conservatively classify as a detection finding. Native values
without a supported OCSF home are retained rather than discarded.

## Severity

OCSF severity uses IDs from 0 through 6. Connectors normalize a source's scale before
the deterministic risk engine projects severity onto its 0–100 input range. Declare
the correct source scale when the source uses 0–10, 0–16, or 0–100 values; otherwise
the generic fallback has to infer the scale.

Do not compare a source's raw severity number directly with Agentic SOC risk. They are
different fields with different purposes.

## Lossless does not mean trusted

`raw_data` preserves the original source record. `unmapped` preserves fields that
were not mapped into the canonical subset. Both are attacker-influenceable data.
When their values enter a model prompt, Agentic SOC wraps them in explicit untrusted-data
fences. They never become instructions merely because they were stored.

## Validate a mapping

For each source, send or select a synthetic record and confirm:

1. `metadata.connector` identifies the expected source;
2. `metadata.uid` remains stable on delivery retry;
3. the timestamp resolves to the intended UTC instant;
4. rule, severity, user, host, and addresses map correctly;
5. the chosen category and class are reasonable; and
6. unmapped source fields remain available for review.

The source editor's sample analyzer is deterministic. It flattens a pasted sample,
suggests field names, and does not persist the sample. An operator must review and
save the mapping.

## Agentic SOC 0.2 boundaries

The model is a pragmatic OCSF subset, not the full taxonomy or a published OCSF
conformance profile. Mapping coverage varies by source, and immutable mapping
versions, shadow comparison, drift monitoring, and one-click rollback are not yet a
complete shipped lifecycle.

## Related pages

- [Feeds and field mapping](../sources/feeds-mapping.md)
- [Source support](../sources/support-matrix.md)
- [Ingestion and investigation](../architecture/ingestion.md)
