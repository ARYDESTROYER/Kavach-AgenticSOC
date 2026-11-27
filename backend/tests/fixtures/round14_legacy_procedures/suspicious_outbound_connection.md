---
id: suspicious_outbound_connection
name: Suspicious outbound / beacon-like connection
version: 1
description: Beacon-like egress or outbound traffic to flagged infrastructure.
match:
  rule_ids: [suricata_mail, ml_stats]
  entity_types: [ip, host]
  mitre: [T1071]
  min_event_count: 3
  any_tags: [network, egress, beacon, c2]
priority: 40
suggested_tools: [enrich, es_query, rag_retrieve]
rag_queries:
  - C2 beacon detection
  - MITRE T1071 application layer protocol C2
  - outbound traffic reputation triage
escalate_if: The destination.ip is confirmed-malicious (threat-intel hit) and outbound contact shows regular periodicity from one or more internal host.name — treat as active C2 and escalate.
suggested_verdict_bias: Bias toward TRUE_POSITIVE when cadence is regular and destination.ip reputation is hostile; bias toward FALSE_POSITIVE when the destination is a known SaaS/update/CDN endpoint with naturally periodic traffic.
---
## Objective
Determine whether repeated outbound connections to a `destination.ip` represent
command-and-control beaconing (T1071) or benign periodic traffic (updates, SaaS,
telemetry). Note: `suricata_mail` and `ml_stats` are the closest rules in this
catalog; operators commonly add dedicated network/IDS rules — match on those too
where available.

## Phase 1 — Scope
- Identify the egress target: group events by `destination.ip` and count contacts
  (require at least `min_event_count` = 3). Capture `event.module` / `rule.id`.
- Identify the internal side: which `host.name` / `source.ip` are reaching out,
  and how many distinct internal hosts touch the same `destination.ip` (fan-out
  to one external IP is suspicious).
- Pull the `@timestamp` series of the contacts to the same `destination.ip` for
  cadence analysis.

## Phase 2 — Enrich & correlate
- **Cadence / periodicity:** examine inter-arrival times across `@timestamp`.
  Regular, low-jitter intervals (heartbeat) are the strongest beacon signal;
  bursty human-like traffic is not.
- **Reputation:** `enrich` the `destination.ip` for threat-intel, ASN, geo, and
  category. A flagged/hostile destination plus periodicity is high-confidence C2.
- **Correlate the host:** check the involved `host.name` for prior alerts
  (malware, suspicious process via `message` / `event.action`) that would explain
  an implant initiating the beacon.
- Distinguish benign periodicity: known update/CDN/SaaS endpoints also beat
  regularly — reputation + destination ownership resolves these.

## Phase 3 — Decide
- **TRUE_POSITIVE (escalate):** regular cadence to a hostile/flagged
  `destination.ip`, especially with a correlated host alert → active C2; isolate
  the `host.name`, block the destination, hunt for the implant.
- **TRUE_POSITIVE (no escalate):** suspicious destination with weak cadence and
  no host corroboration → recommend monitoring/blocking, lower urgency.
- **FALSE_POSITIVE:** destination resolves to a known SaaS/update/CDN endpoint
  whose periodic traffic is expected.
- **NEEDS_HUMAN:** reputation inconclusive or cadence ambiguous (too few samples
  to judge periodicity).

## Reproduce
- Egress volume: group by `destination.ip`, count contacts, list contributing
  `host.name` / `source.ip`.
- Cadence: order the contacts by `@timestamp` and inspect inter-arrival gaps.
- Reputation: `enrich` on `destination.ip`; pull C2 detection guidance from RAG.
