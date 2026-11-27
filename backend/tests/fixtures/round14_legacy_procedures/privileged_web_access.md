---
id: privileged_web_access
name: Privileged web access
version: 1
description: Exact procedure for successful external access to administrative web surfaces.
priority: 85
match:
  rule_ids: [external_admin_panel_access]
  entity_types: [ip, user, host, rule]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [privileged web access response, administrative login verification]
escalate_if: The successful access is unauthorized, originates from hostile infrastructure, or is followed by privileged changes.
suggested_verdict_bias: A successful external administrative login requires identity and change evidence; source reputation alone is not a verdict.
---
## Procedure

1. Confirm that authentication succeeded and identify the account, source IP, destination, authentication method, and session time.
2. Compare the source and device with the account's recent successful administrative access.
3. Verify MFA, approved change window, ticket, and owner where those records are available.
4. Inspect post-login actions for user, policy, configuration, credential, or data changes.
5. Enrich the source IP, but treat reputation as corroboration rather than proof.
6. Escalate unauthorized access or suspicious privileged changes. Mark benign only with an attributable operator and expected activity; otherwise request human validation.

