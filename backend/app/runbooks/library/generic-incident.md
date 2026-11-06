---
id: generic-incident
title: Generic incident (NIST 800-61)
summary: A general response procedure for a case no other runbook covers, following the NIST incident response life cycle.
use_when: No other runbook matches the case. Replace it with a specific runbook when you see the same kind of case again.
version: 1
priority: 0
review_every_days: 180
applies_when:
  always: true
retrieval_queries:
  - incident response procedure
  - incident scoping and containment
references:
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### What happened, where, and how bad is it? {#what-happened kind=check evidence=note}
Focus: the detection, the affected hosts, accounts and data, and the business impact.
Escalate if: production systems, sensitive data or a privileged account is involved, or the activity continues.
Benign if: a known test, a misconfiguration or expected behaviour explains it.

### Name an incident lead {#incident-lead kind=record}
Name the person who leads the response until the case is closed.

## Investigate

### Other alerts for the case's entities in 24 hours {#entity-alerts kind=lookup}
Focus: other rules that fired for the same address around the case.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [rule]
window: case_first_seen-1d..case_last_seen+1h
limit: 20
run: on_attach
```

### What is the scope: which hosts, accounts and data? {#scope kind=check evidence=note}
Escalate if: more than one host or account, or data leaving the network.
Benign if: one host or account, contained, with no data at risk.

### Incident, suspicious or benign? {#decide kind=decision}
Escalate if: confirmed malicious activity, or impact on production systems or data.
Benign if: a test, a misconfiguration or expected behaviour.
Options:
- incident: Incident
- suspicious: Suspicious, not confirmed
- benign: Benign | skips: contain-systems, remove-cause, restore-service

Recording a decision does not change the verdict or close the case.

## Contain

### Contain the affected systems or accounts {#contain-systems kind=action}
Isolate hosts, disable accounts or block addresses as the scope needs. Record each change.

## Eradicate

### Remove the cause {#remove-cause kind=action}
Remove the malware, access or misconfiguration that caused the incident.

## Recover

### Restore normal service {#restore-service kind=action}
Bring systems back into service and watch them closely for a while.

## Close and learn

### Record the outcome and what you would change {#record-outcome kind=record}
Write what happened and what you would change. If this kind of case comes back, write a specific runbook for it.
