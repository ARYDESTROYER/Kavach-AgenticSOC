---
id: data_exfiltration
title: Data staging and exfiltration
applies_to_rules: [data_exfiltration, bulk_data_download, cloud_storage_exfiltration, dns_tunneling, loan_api_access]
applies_to_techniques: [T1020, T1041, T1048, T1530]
applies_to_entities: [user, host, ip]
keywords: [exfiltration, data staging, bulk download, archive, personal address, dns tunneling, cloud storage]
persona: data_protection
summary: Triage abnormal data collection, staging, transfer, and access to sensitive repositories.
---
SIGNAL
An identity or host collected, staged, or transferred substantially more sensitive data than its expected workflow requires.

EVIDENCE REQUIRED
Data owner and classification, objects and bytes accessed, source identity and host, destination, protocol, timing, authorization, and transfer outcome.

INVESTIGATION STEPS
1. Confirm which data was accessed, its classification, volume, destination, actor, host, and whether transfer completed.
2. Compare the activity with the actor and asset baseline, approved job, change ticket, backup, migration, or business workflow.
3. Inspect archive creation, unusual queries, removable media, personal destinations, cloud sharing, and covert or encrypted egress.
4. Scope related identities, hosts, sessions, destinations, and preceding credential or privilege activity.

TRUE POSITIVE SIGNALS
Unauthorized sensitive-data access or a completed transfer to an unapproved destination supports a true positive.

FALSE POSITIVE SIGNALS
An approved backup, migration, analytics job, or business transfer matching the expected owner, scope, destination, and window supports a false positive.

NEEDS HUMAN WHEN
Data classification, ownership, authorization, destination, transfer outcome, or baseline is unavailable or conflicting.

RECOMMENDED NEXT ACTION
Escalate confirmed loss for access containment, destination blocking where approved, legal and privacy coordination, and evidence preservation.

LIMITATIONS
Volume anomalies alone cannot distinguish theft from legitimate bulk processing without ownership and destination context.
