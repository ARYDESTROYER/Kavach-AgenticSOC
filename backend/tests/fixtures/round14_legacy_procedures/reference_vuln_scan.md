---
id: vuln_scan
title: Vulnerability scanning (Nessus / OpenVAS / nikto)
applies_to_rules: [nessus-openvas, nessus, openvas, nikto]
applies_to_techniques: [T1595]
applies_to_entities: [ip]
keywords: [nessus, openvas, nikto, vuln, scanner, cve probe]
persona: network_recon
summary: Bursts of varied requests probing known CVEs and default paths from one IP.
---
SIGNAL
One source sends varied requests that probe known vulnerabilities, default credentials, or well-known paths.

EVIDENCE REQUIRED
Source identity, scanner ownership, schedule, target scope, response outcomes, authentication results, and affected asset criticality.

INVESTIGATION STEPS
1. Compare the source with the approved vulnerability-scanner fleet and current schedule.
2. Measure targeted hosts and services, noting any sensitive or out-of-scope assets.
3. Check whether a vulnerability probe or default-credential attempt returned a success indicator.
4. Inspect successful targets for follow-on authentication, execution, or configuration changes.

TRUE POSITIVE SIGNALS
An unapproved scanner or any probe followed by evidence of successful access supports a true positive.

FALSE POSITIVE SIGNALS
An approved internal scanner operating within its documented schedule and target scope supports a false positive.

NEEDS HUMAN WHEN
Scanner ownership, schedule, scope, or probe outcome cannot be verified.

RECOMMENDED NEXT ACTION
Escalate any likely successful probe; otherwise block or monitor an unapproved external scanner according to policy.

LIMITATIONS
A successful response code may confirm reachability without confirming exploitation.
