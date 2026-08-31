---
id: web_application_abuse
name: Web application abuse
version: 1
description: Exact procedures for application session, privileged-administration, upload, and enumeration alert families.
priority: 80
match:
  rule_ids: [web_app_endpoint_abuse, web_app_session_token_reuse, web_app_dangerous_file_upload, web_app_path_enumeration, web_app_privileged_admin_action, web_app_sensitive_data_access]
  entity_types: [ip, user, host, rule]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [web application incident response, application session abuse, application administrative activity]
escalate_if: Confirmed account misuse, destructive administration, executable upload, or sustained service impact.
suggested_verdict_bias: Require corroborating authentication, application, and authorization evidence; automation alone is not compromise.
---
## Procedure

1. Confirm the exact application rule, time window, affected user, source IP, application context, and action count.
2. Compare the activity with the user's recent authentication and administrative baseline.
3. For session-token reuse, verify overlapping IPs and sessions; shared NAT without overlap is not sufficient.
4. For endpoint abuse or path enumeration, measure rate, endpoints, failures, and service impact. Separate health checks and accessibility tools from hostile automation.
5. For privileged administration, sensitive-data access, or uploads, verify authorization, object scope, file type, and whether the action succeeded.
6. Escalate confirmed unauthorized changes, data access, executable content, or material denial of service. Otherwise document the benign explanation or the evidence still missing.
