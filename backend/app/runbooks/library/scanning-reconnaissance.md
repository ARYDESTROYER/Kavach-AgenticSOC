---
id: scanning-reconnaissance
title: Scanning and reconnaissance
summary: A source is probing our hosts, ports or web paths. Most scanning is approved or harmless noise; find the exceptions.
use_when: A detection reports port scans, vulnerability scanners or automated probing of web paths.
prerequisites: Firewall, IDS or web server logs; the list of approved scanners and assessments.
version: 1
priority: 75
review_every_days: 180
mitre: [T1595, T1046]
applies_when:
  rule_ids: [suricata, et_scan, nessus-openvas, nessus, openvas, nikto, automated_vulnerability_scanning, suspicious_web_shell_execution]
retrieval_queries:
  - web scanner triage
  - approved vulnerability assessment
  - network reconnaissance detection
references:
  - https://attack.mitre.org/techniques/T1595/
  - https://attack.mitre.org/techniques/T1046/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Is the scanner one of ours or an approved third party? {#approved-scanner kind=check evidence=note}
Focus: the source against the scanner inventory, the change calendar and assessment windows.
Escalate if: the source is on no allow list and no assessment covers it.
Benign if: an approved scanner or assessment covers this source and this time.

### How many hosts and ports were touched? {#hosts-ports kind=lookup}
Focus: breadth across many hosts versus depth on one service.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [destination.ip, destination.port]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

Targets come from the ECS fields `destination.ip` and `destination.port`. A source that names them differently shows the count without the targets.

### Has this source scanned us before? {#previous-scans kind=lookup}
Focus: earlier cases from the same source and how they ended.

```lookup
tool: related_cases
filter:
  entity: "{{entity.ip}}"
window: case_last_seen-30d..case_last_seen
limit: 10
run: on_attach
```

### Approved, repeated hostile scanning, or one-off noise? {#decide kind=decision}
Escalate if: the scanner achieved execution, created a file or process, or no approved assessment covers it.
Benign if: an approved assessment, or one-off internet noise with no successful request.
Options:
- approved: Approved scanning | skips: block-source
- hostile: Repeated hostile scanning
- noise: One-off noise | skips: block-source

Recording a decision does not change the verdict or close the case.

## Close and learn

### Block the source if scanning repeats {#block-source kind=action optional react=RA3101}
Block the source at the edge if it keeps scanning. Record where you blocked it.

### Record the outcome and what you would change {#record-outcome kind=record}
Write what was scanned and whether the scanner list or a detection threshold should change.
