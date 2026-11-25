---
title: Feeds and field mapping
description: Scope Agentic SOC 0.2 collection with feed roles and validate source-to-OCSF field mappings.
---

# Feeds and field mapping

This guide applies to **Agentic SOC 0.2** and is for operators tuning what a source reads
and how its records become canonical events.

## Feed roles

One pull source can have multiple feeds. Each feed has its own pattern and cursor.

| Role | Behavior |
| --- | --- |
| `alerts` | Source-native detections are prioritized for investigation, subject to global caps and budget |
| `events` | Records are normalized, correlated, risk-scored, and admitted to investigation through deterministic routing |
| `ignore` | The feed is muted and excluded from live processing |

An event-feed severity floor changes automatic forwarding; it does not silently drop
below-floor events. Disabling correlation or auto-investigation can leave a visible
candidate for manual review.

## Feed settings

The v0.1 feed model supports:

- stable ID and human label;
- index pattern;
- role and enabled state;
- connector-native query filter;
- per-feed field mapping and message field;
- OCSF severity floor;
- correlation and auto-investigation controls; and
- optional poll-interval override.

Feed-level mapping wins over source-level mapping, which wins over global defaults.
Keep connector-native filters operator-authored and reviewable; they are not model
instructions.

## Mapping priority

Validate at least these source fields:

| Meaning | Common paths |
| --- | --- |
| Time | `@timestamp`, `timestamp`, `event.created` |
| Native ID | `event.id`, `_id`, `uuid` |
| Rule | `rule.id`, `rule.name`, `alert.signature` |
| Severity | `event.severity`, `severity`, `risk_score` |
| User | `user.name`, `username`, `account` |
| Host | `host.name`, `hostname`, `device.hostname` |
| Source address | `source.ip`, `src_ip`, `client.ip` |
| Message | `message`, `event.original`, `description` |

The OCSF mapper preserves the original record even when a field has no canonical
home. Correct mapping is still essential because correlation, risk, filters, and
case readability depend on canonical fields.

## Use the sample analyzer

Paste one representative synthetic or redacted record into the source editor. The
analyzer flattens its field paths and deterministically suggests mapping overrides.
It does not call a model and does not persist the pasted sample.

Review every suggestion, save only field names, then test against a separate record.
Do not paste credentials, tokens, or unnecessary sensitive values.

## Validation checklist

1. Send records from both an alert and an event feed when both are configured.
2. Confirm each record is attributed to exactly one source and intended feed.
3. Confirm timestamps and source-native IDs are stable.
4. Confirm severity uses the source's declared scale.
5. Confirm user, host, address, rule, and message populate correctly.
6. Confirm ignored patterns do not appear.
7. Confirm below-floor event records remain visible without an unwanted model call.
8. Confirm the same native record on retry is not duplicated.

## Agentic SOC 0.2 boundaries

The analyzer does not profile a representative sample set, persist immutable mapping
versions, shadow old and new mappings, detect drift, or roll back automatically.
Operators own mapping approval and should retain reproducible test records.

## Related pages

- [OCSF normalization](../concepts/ocsf.md)
- [Pull sources](pull.md)
- [Create your first case](../getting-started/first-case.md)

