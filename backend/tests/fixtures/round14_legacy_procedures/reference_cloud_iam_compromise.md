---
id: cloud_iam_compromise
title: Cloud IAM session and credential compromise
applies_to_rules: [cloud_iam_anomaly, iam_role_assumption, oauth_token_replay, risky_service_principal_signin, impossible_travel]
applies_to_techniques: [T1078, T1098, T1550.001]
applies_to_entities: [user, host, ip]
keywords: [cloudtrail, assume role, iam, oauth token, service principal, access key, conditional access]
persona: cloud_identity
summary: Triage anomalous cloud sessions, role assumptions, tokens, access keys, and service-principal activity.
---
SIGNAL
A cloud identity used a token, role, key, or privileged session outside its expected access pattern.

EVIDENCE REQUIRED
Identity and principal IDs, session issuer, authentication method, source address, device, requested resource, action outcome, and change history.

INVESTIGATION STEPS
1. Confirm the principal, credential type, source, target account or tenant, time, and whether the action succeeded.
2. Compare the session with recent sign-ins, devices, locations, role assumptions, and normal resources for the same identity.
3. Inspect MFA and conditional-access results, token or key creation, privilege changes, consent grants, and subsequent API activity.
4. Scope every resource and identity touched by the same credential, session, source, or service principal.

TRUE POSITIVE SIGNALS
Unexpected successful privilege use, new credentials, consent, policy changes, or access to sensitive resources supports a true positive.

FALSE POSITIVE SIGNALS
An attributable workload or operator using an approved role, device, source, change window, and expected resources supports a false positive.

NEEDS HUMAN WHEN
Identity ownership, session lineage, authorization, or cloud audit coverage cannot be verified, or location evidence conflicts.

RECOMMENDED NEXT ACTION
Escalate confirmed misuse for session and credential revocation, privilege review, resource scoping, and preservation of cloud audit evidence.

LIMITATIONS
Federation, shared egress, token refresh, and service-principal automation can obscure the original user and device.
