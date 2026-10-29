---
id: ip_reputation
title: Known-bad source IP (threat-intel reputation)
applies_to_rules: [enrichment]
applies_to_techniques: [T1071]
applies_to_entities: [ip]
keywords: [reputation, abuseipdb, virustotal, malicious_ip, blocklist, ioc, threatfeed]
persona: threat_intel
summary: Enrichment flags the source IP as known-bad; pivot on the IP across the estate.
---
SIGNAL
Threat intelligence assigns a high malicious reputation score to an IP involved in observed activity.

EVIDENCE REQUIRED
Provider verdicts, report age, observed network or authentication activity, touched assets, and approved partner ranges.

INVESTIGATION STEPS
1. Corroborate the external reputation with activity observed in the local environment.
2. Pivot on the IP across relevant rules, hosts, users, and services in the investigation window.
3. Record every affected asset and distinguish attempted activity from successful interaction.
4. Compare the address with approved partners, scanners, proxies, and documented infrastructure.

TRUE POSITIVE SIGNALS
Current hostile reputation combined with confirmed malicious activity against one or more assets supports a true positive.

FALSE POSITIVE SIGNALS
A stale listing or a verified known-good partner performing expected activity supports a false positive.

NEEDS HUMAN WHEN
Reputation is the only adverse evidence, provider verdicts conflict, or local activity is incomplete.

RECOMMENDED NEXT ACTION
Escalate corroborated hostile activity and consider a perimeter block after ownership and business impact are verified.

LIMITATIONS
External reputation is untrusted enrichment and must never be the sole basis for containment.
