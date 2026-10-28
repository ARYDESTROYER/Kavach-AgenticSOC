---
id: suspicious-outbound
title: Suspicious outbound or known-bad destination
summary: A host talks to a destination with a bad reputation, or in a regular beacon-like pattern. Decide whether it is command and control.
use_when: Threat intelligence flags an address our hosts talk to, or a detection reports beacon-like outbound traffic.
prerequisites: Firewall, proxy or DNS logs; endpoint telemetry to find the process behind a connection.
version: 1
priority: 40
review_every_days: 180
mitre: [T1071, T1571]
applies_when:
  rule_ids: [enrichment, suricata_mail, ml_stats]
  entity_types: [ip, host]
retrieval_queries:
  - C2 beacon detection
  - MITRE T1071 application layer protocol C2
  - outbound traffic reputation triage
references:
  - https://attack.mitre.org/techniques/T1071/
  - https://attack.mitre.org/techniques/T1571/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Where did this address connect, and how often? {#destinations kind=lookup}
Focus: steady counts to one destination suggest a beacon; compare each destination with threat intelligence.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [destination.ip, destination.port]
window: case_first_seen-1d..case_last_seen+1h
limit: 20
run: on_attach
```

Destinations come from the ECS fields `destination.ip` and `destination.port`. A source that names them differently shows the count without the destinations.

### Reputation of the destination domain {#destination-reputation kind=lookup}
Focus: which sources flag the domain, for what, and how recently.

```lookup
tool: enrich
indicator: "{{entity.domain}}"
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

## Investigate

### Which process made the connection? {#process kind=check evidence=note}
Focus: the process, its parent and its user on each host that made the connection.
Escalate if: an unknown or unsigned process, a script interpreter, or a process running from a temporary folder.
Benign if: a known updater, browser or security agent talking to its vendor.

### Command and control, suspicious or benign? {#decide kind=decision}
Escalate if: a destination listed by the first lookup is known-bad, or one internal host contacts it at regular intervals.
Benign if: a known SaaS, update or CDN endpoint with naturally periodic traffic.
Options:
- c2: Command and control
- suspicious: Suspicious, not confirmed | skips: isolate-host
- benign: Benign | skips: block-destination, isolate-host

Recording a decision does not change the verdict or close the case.

## Contain

### Block the destination {#block-destination kind=action react=RA3101}
Block the destination at the firewall, or ask for a DNS sinkhole. Record the change reference.

### Isolate the host when it is command and control {#isolate-host kind=action optional d3fend=D3-NI}
Isolate each host that beaconed, keeping the management connection, until it is clean.

### Record the outcome and what you would change {#record-outcome kind=record}
Write which hosts were involved, what you blocked, and what would have caught it sooner.
