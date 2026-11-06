---
id: data_exfiltration_response
name: Data exfiltration response
version: 1
description: Investigate abnormal sensitive-data collection, staging, and transfer to an external destination.
priority: 88
rule_ids: [data_exfiltration, bulk_data_download, cloud_storage_exfiltration, dns_tunneling, loan_api_access]
entity_types: [user, host, ip, rule]
mitre: [T1020, T1041, T1048, T1530]
any_tags: [exfil, staging, bulk-download, dns-tunnel]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [data exfiltration response, sensitive data staging, unusual outbound transfer]
escalate_if: Sensitive data reached an unapproved external destination or access and transfer evidence indicates unauthorized loss.
suggested_verdict_bias: Volume is not sufficient by itself; require data sensitivity, authorization, destination, and transfer-outcome evidence.
---
## Procedure

1. Establish the actor, source host, data owner, classification, objects, bytes, destination, protocol, and whether the transfer completed.
2. Compare the activity with the actor and asset baseline plus approved backups, migrations, analytics jobs, support tasks, and change windows.
3. Inspect collection and staging before egress: unusual queries, archive creation, cloud sharing, removable media, personal addresses, and covert channels.
4. Scope related sessions, identities, hosts, destinations, and any preceding phishing, credential, or privilege activity.
5. Distinguish an approved bulk workflow only with attributable ownership, expected scope, destination, and timing.
6. Recommend access containment, destination controls, legal and privacy coordination, and evidence preservation when loss is corroborated.
