---
id: ransomware-destructive
title: Ransomware or destructive activity
summary: Files are being encrypted or destroyed. Stop the spread first, then remove the attacker and restore from backup.
use_when: A detection reports mass file encryption, ransom notes, deleted shadow copies or other destructive changes.
prerequisites: Endpoint and file server telemetry; access to isolate hosts and disable accounts; a tested backup.
version: 1
priority: 92
review_every_days: 180
mitre: [T1486, T1490]
applies_when:
  rule_ids: [ransomware_behavior, mass_file_encryption, ransomware_encryption, endpoint_ransomware, file_encryption_burst]
retrieval_queries:
  - ransomware containment
  - mass file encryption
  - inhibit system recovery
references:
  - https://attack.mitre.org/techniques/T1486/
  - https://attack.mitre.org/techniques/T1490/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Are files being encrypted or deleted right now? {#active-impact kind=check evidence=note}
Focus: the file change rate, ransom notes, deleted shadow copies and the process making the changes.
Escalate if: encryption or deletion is still running, or more than one host or share is affected.
Benign if: a known backup, archive or compression job explains the file changes.

Treat this as urgent until you know the answer. Do not reboot affected hosts; it can destroy evidence.

### Declare an incident and name an incident lead {#declare-incident kind=record approval=soc_manager}
Declare an incident under your response plan and name the person who leads it.

## Contain

### Isolate affected hosts and shares {#isolate-hosts kind=action d3fend=D3-NI}
Isolate every affected host and take affected shares offline. Record what you isolated.

### Disable accounts used by the attacker {#disable-accounts kind=action d3fend=D3-AL}
Disable or lock the accounts that started the encryption, including service accounts.

### Which hosts show the same activity? {#same-activity kind=lookup}
Focus: other cases from the same detection rule, and the hosts they name.

```lookup
tool: related_cases
filter:
  rule: "{{case.rule}}"
window: case_first_seen-1d..now
limit: 10
run: on_attach
```

## Eradicate

### Remove the attacker's tools and access {#remove-tools kind=action}
Remove the attacker's tools, persistence and remote access, and reset credentials they may have.

### Are backups intact and unaffected? {#backups-intact kind=check evidence=note}
Escalate if: backups were deleted, encrypted or are reachable with the attacker's credentials.
Benign if: offline or immutable backups are intact and a test restore works.

## Recover

### Restore data from backup {#restore-data kind=action react=RA5002}
Restore systems and data from clean backups, oldest affected systems last.

### Are restored systems working and monitored? {#restored-monitored kind=check evidence=note}
Escalate if: encryption starts again, or the attacker's tools reappear.
Benign if: restored systems work normally under close monitoring.

## Close and learn

### Notify legal, leadership and any regulator as required {#notify-stakeholders kind=record}
Record who you notified, when, and under which duty.

### Record the outcome and what you would change {#record-outcome kind=record}
Write the timeline, the way in, what stopped the spread and what you would change.
