---
id: cloud_identity_compromise
name: Cloud identity compromise
version: 1
description: Investigate anomalous role assumptions, OAuth tokens, access keys, and service-principal sessions.
priority: 82
rule_ids: [cloud_iam_anomaly, iam_role_assumption, oauth_token_replay, risky_service_principal_signin, impossible_travel, identity_signin]
entity_types: [user, host, ip, rule]
mitre: [T1078, T1098, T1550.001]
any_tags: [cloud, iam, identity, oauth]
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries: [cloud IAM compromise, OAuth token replay, suspicious role assumption]
escalate_if: A successful unexpected session changes privileges or credentials, grants consent, or accesses sensitive resources.
suggested_verdict_bias: Require successful activity plus identity, session, and authorization evidence; unusual geography or reputation alone is not compromise.
---
## Procedure

1. Identify the principal, credential or token type, session issuer, source, device, target account or tenant, and successful actions.
2. Compare the session with recent sign-ins, role assumptions, devices, locations, resources, and workload schedules for the same identity.
3. Verify MFA and conditional-access results. Inspect new keys, tokens, service principals, consent grants, role or policy changes, and persistence.
4. Scope every resource and identity touched by the session, credential, source, or principal, including follow-on access and data movement.
5. Treat shared egress, federation, automation, and approved emergency access as benign candidates only when ownership and authorization are attributable.
6. Recommend revoking sessions and credentials, limiting privileges, and preserving cloud audit evidence when misuse is corroborated.
