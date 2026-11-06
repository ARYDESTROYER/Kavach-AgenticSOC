---
id: ransomware_response
name: Ransomware impact response
version: 1
description: Investigate mass encryption, destructive file changes, and related command-and-control activity.
priority: 92
rule_ids: [ransomware_behavior, mass_file_encryption, ransomware_encryption, endpoint_ransomware, file_encryption_burst]
entity_types: [host, user, ip, rule]
mitre: [T1486, T1490, T1071]
any_tags: [ransomware, encryption, impact]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [ransomware containment, mass file encryption, inhibit system recovery]
escalate_if: Encryption or destructive modification is active, containment failed, or multiple hosts or shared repositories are affected.
suggested_verdict_bias: Treat high-rate file changes as impact only when process lineage, file behavior, containment, and affected scope corroborate it.
---
## Procedure

1. Confirm the process, parent lineage, account, host, start time, file count, extensions, repositories, and current containment state.
2. Determine whether encryption or deletion remains active. Scope shared storage and every host, identity, process hash, and destination involved.
3. Inspect for credential access, lateral movement, recovery inhibition, security-control tampering, ransom notes, and command-and-control before impact.
4. Separate approved encryption, backup, synchronization, deployment, or bulk-administration jobs using owner, schedule, process signature, and expected paths.
5. Recommend isolating affected systems, disabling compromised identities, protecting backups, and preserving volatile and file-system evidence when impact is corroborated.
6. Do not claim recovery or eradication from an alert alone; record the evidence still needed from responders.
