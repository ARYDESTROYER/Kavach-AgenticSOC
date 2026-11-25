---
title: Pull sources
description: Configure read-only Elasticsearch, OpenSearch, and Wazuh sources in Agentic SOC 0.2.
---

# Pull sources

This guide applies to **Agentic SOC 0.2** and is for operators connecting Elasticsearch,
OpenSearch, or a Wazuh indexer. Agentic SOC polls each enabled source and feed on its own
cursor and also uses a primary pull source for ad-hoc read-only investigation queries.

## Supported connectors

| Connector | Typical scope | Notes |
| --- | --- | --- |
| Elasticsearch | One or more log or alert index patterns | First-class PIT plus `search_after` path |
| OpenSearch | OpenSearch-compatible patterns | Can fall back to bounded offset paging when PIT is unavailable |
| Wazuh | `wazuh-alerts-*` or a narrower pattern | Connect to the indexer, not the Wazuh dashboard |

Use the [support matrix](support-matrix.md) for exact current limits.

## Least-privilege credential

The source credential should have only read and index-metadata access on the exact
patterns Agentic SOC needs. Never supply an Elastic superuser, `kibana_system`, an
OpenSearch administrator, or a Wazuh administrator.

When the Agentic SOC state backend is Elasticsearch, its application-state management
credential is separate from the source read credential. Do not combine them.

## Configure the source

1. In **Sources**, choose Elasticsearch, OpenSearch, or Wazuh.
2. Enter the cluster/indexer URL and CA verification settings.
3. Add the narrowest initial pattern or feed.
4. Set source-level field paths when the records are not ECS-shaped.
5. Store the read-only credential through the source secret control.
6. Select **Test connection**.

The draft connection test uses the supplied configuration and secrets only for that
request. It performs a cheap scoped read as the pass/fail gate. Optional cluster
monitoring information may be reported, but cluster-wide monitor permission is not
required for a valid read-only connection.

## Polling and cursors

Each source/feed pair has an independent cursor. The first-class Elasticsearch path
uses a point-in-time view, `search_after`, a stable tie-breaker, and a bounded
late-arrival overlap. When a tick reaches its page bound, the next tick continues the
frontier rather than skipping ahead.

Overlapping feeds use deterministic ownership so a narrower pattern can own a record
without causing the broader feed to stall. Delivery retries and inclusive timestamp
boundaries are deduplicated with stable source-scoped identities.

## Validate

After saving:

- confirm the source reports a successful poll;
- browse recent rows and verify the selected pattern;
- confirm the timestamp, rule, severity, entity, and source ID;
- wait for a second tick and verify the cursor advances; and
- confirm repeated polling attaches new evidence rather than creating a duplicate
  open case for the same active signature.

## Agentic SOC 0.2 boundaries

The OpenSearch-compatible offset fallback is not claimed exactly-once while a live
index refreshes. Late-arrival acceptance is bounded by time, page count, and recent-ID
memory. Monitor catch-up lag and keep the source's retention long enough to replay
outside that overlap.

## Related pages

- [Feeds and field mapping](feeds-mapping.md)
- [Create your first case](../getting-started/first-case.md)
- [State, audit, and cost](../concepts/state-audit-cost.md)

