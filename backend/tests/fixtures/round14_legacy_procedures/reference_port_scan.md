---
id: port_scan
title: Port scan / network reconnaissance
applies_to_rules: [suricata, et_scan]
applies_to_techniques: [T1046, T1595]
applies_to_entities: [ip]
keywords: [suricata, et scan, scan, nmap, port, recon, probe, sweep, masscan]
persona: network_recon
summary: Many connection attempts to distinct ports/hosts from one source IP.
---
SIGNAL
One source attempts connections across many ports or hosts within a short period.

EVIDENCE REQUIRED
Source identity, distinct ports and targets, scan duration, connection outcomes, service responses, and approved scanner schedules.

INVESTIGATION STEPS
1. Measure the distinct ports, hosts, connection rate, and total scan window.
2. Check whether any target returned a service response or accepted a connection.
3. Compare the source with approved scanner addresses and maintenance schedules.
4. Enrich an external source and inspect for follow-on access to sensitive services.

TRUE POSITIVE SIGNALS
Unapproved broad reconnaissance or scanning followed by successful sensitive-service access supports a true positive.

FALSE POSITIVE SIGNALS
An approved internal scanner operating within its documented scope and schedule supports a false positive.

NEEDS HUMAN WHEN
Scanner ownership, connection outcomes, or the approved maintenance window cannot be verified.

RECOMMENDED NEXT ACTION
Escalate successful or targeted reconnaissance; otherwise monitor or block a corroborated hostile external source.

LIMITATIONS
Connection attempts alone do not prove service access or exploitation.
