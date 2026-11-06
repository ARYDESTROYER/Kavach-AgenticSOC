---
id: web_scanner_activity
name: Web scanner and exploit activity
version: 1
description: Exact procedure for vulnerability scanning and web-shell or PHP execution alert families.
priority: 75
match:
  rule_ids: [automated_vulnerability_scanning, suspicious_web_shell_execution]
  entity_types: [ip, host, rule]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [web scanner triage, web shell response, approved vulnerability assessment]
escalate_if: A scanner achieves execution, creates a file or process, or is not attributable to an approved assessment.
suggested_verdict_bias: Scanner signatures require approval and outcome evidence; confirmed server-side execution is high risk.
---
## Procedure

1. Identify the source, target, request path, response code, user agent, method, and alert count.
2. Check the approved scanner inventory and assessment window. Name similarity alone does not prove authorization.
3. Separate broad probing with only blocked or failed responses from a request that produced a successful server-side effect.
4. For web-shell or PHP execution, look for file creation, process execution, child processes, outbound connections, persistence, and follow-on access.
5. Enrich external sources and compare targets with exposed asset ownership and criticality.
6. Escalate unapproved scanning with material impact or any corroborated execution. Close as expected only with an approved source, window, scope, and no successful exploitation.

