---
id: data-exfiltration
title: Data exfiltration
summary: Data may be leaving the network without permission. Measure what moved and where, decide whether it was allowed, and stop it if not.
use_when: A detection reports unusual data collection, staging, bulk downloads, DNS tunnelling or transfers to an external destination.
prerequisites: Proxy, firewall, DNS or cloud storage logs; someone who knows the data and its owner.
version: 1
priority: 88
review_every_days: 180
mitre: [T1041, T1567]
applies_when:
  rule_ids: [data_exfiltration, bulk_data_download, cloud_storage_exfiltration, dns_tunneling, loan_api_access]
retrieval_queries:
  - data exfiltration response
  - sensitive data staging
  - unusual outbound transfer
references:
  - https://attack.mitre.org/techniques/T1041/
  - https://attack.mitre.org/techniques/T1567/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Volume and destinations of the transfer {#transfer-volume kind=lookup}
Focus: destinations, volume and timing compared with the account's normal use.

```lookup
tool: log_stats
filter:
  user: "{{entity.user}}"
group_by: [destination.ip, action]
window: case_first_seen-1d..case_last_seen+1h
limit: 20
run: on_attach
```

Destinations come from the ECS field `destination.ip` and actions from the ECS field `event.action`. If the source does not record one of them, it is not listed; that means the field is missing, not that nothing moved.

### Is the destination a sanctioned service? {#sanctioned-destination kind=check evidence=note}
Focus: the destination against the list of approved services, partners and company cloud accounts.
Escalate if: a personal mailbox, an unknown host, a new cloud account or a DNS tunnel.
Benign if: an approved backup, sync or partner service that the data owner uses.

## Investigate

### Reputation of the destination {#destination-reputation kind=lookup}
Focus: newly registered, hosting or file-sharing destinations and known hostile ones.

```lookup
tool: enrich
indicator: "{{entity.domain}}"
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

### What data was involved and who owns it? {#data-owner kind=check evidence=note}
Focus: the repository, file names and classification of the data that moved.
Escalate if: customer, financial, health or credential data, or data under a legal hold.
Benign if: public or test data, or data the account is allowed to move there.

### Exfiltration, suspicious or benign? {#decide kind=decision}
Escalate if: sensitive data reached an unapproved external destination, or access and transfer records show an unauthorised loss.
Benign if: volume alone, with an approved destination and an authorised user.
Options:
- exfiltration: Exfiltration
- suspicious: Suspicious, not confirmed
- benign: Benign | skips: block-destination, notify-owner, notification-duties

Recording a decision does not change the verdict or close the case.

## Contain

### Block the destination and stop the transfer {#block-destination kind=action d3fend=D3-NI}
Block the destination at the proxy or firewall and stop the session or job that moves the data.

### Notify the data owner {#notify-owner kind=record}
Tell the data owner what moved, when and where, and agree the next steps.

## Close and learn

### Record whether notification duties apply {#notification-duties kind=record}
Record whether contracts or regulations require you to notify anyone, who decided, and when.

### Record the outcome and what you would change {#record-outcome kind=record}
Write what left, how, and what would have stopped it, such as a data loss rule or tighter access.
