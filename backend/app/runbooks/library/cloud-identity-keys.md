---
id: cloud-identity-keys
title: Cloud identity and access key compromise
summary: A cloud identity, role, token or access key is used in a way its owner did not intend. Scope what it can reach, then rotate it.
use_when: A detection reports anomalous role assumptions, OAuth token replay, unusual access key use or risky service principal sign-ins.
prerequisites: Cloud audit logs (for example CloudTrail or Entra ID sign-in and audit logs); access to disable keys and revoke sessions.
version: 1
priority: 82
review_every_days: 180
mitre: [T1078.004, T1552]
applies_when:
  rule_ids: [cloud_iam_anomaly, iam_role_assumption, oauth_token_replay, risky_service_principal_signin, impossible_travel, identity_signin]
retrieval_queries:
  - cloud IAM compromise
  - OAuth token replay
  - suspicious role assumption
references:
  - https://attack.mitre.org/techniques/T1078/004/
  - https://attack.mitre.org/techniques/T1552/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Which identity or key is involved and what can it reach? {#identity-scope kind=check evidence=note}
Focus: the user, role, service principal or access key, and the permissions attached to it.
Escalate if: the identity can change permissions, read sensitive data or create credentials.
Benign if: a low-privilege test identity with no access to production.

### Recent API activity by this identity {#api-activity kind=lookup}
Focus: which actions it called, how often, and whether any failed.

```lookup
tool: log_stats
filter:
  user: "{{entity.user}}"
group_by: [action]
window: case_last_seen-1d..case_last_seen+1h
limit: 20
run: on_attach
```

Actions come from the ECS field `event.action`. If the source does not record that field, no actions are listed; that means the field is missing, not that nothing happened.

## Investigate

### Calls from new locations or unusual services {#new-locations kind=lookup}
Focus: source addresses, regions and services the identity has not used before.

```lookup
tool: log_stats
filter:
  user: "{{entity.user}}"
group_by: [ip, action]
window: case_last_seen-7d..case_last_seen+1h
limit: 20
run: on_attach
```

Actions come from the ECS field `event.action`. If the source does not record that field, no actions are listed; that means the field is missing, not that nothing happened.

### Were new keys, roles or policies created? {#new-credentials kind=check evidence=note}
Escalate if: new access keys, roles, policies, consents or federation settings appeared.
Benign if: a recorded change by an approved automation or administrator.

### Compromised, suspicious or benign? {#decide kind=decision}
Escalate if: an unexpected session changed privileges or credentials, granted consent, or reached sensitive resources.
Benign if: an unusual location or reputation alone, with no change and an expected owner.
Options:
- compromised: Compromised
- suspicious: Suspicious, not confirmed
- benign: Benign | skips: rotate-key, remove-attacker-resources, workloads-updated

Recording a decision does not change the verdict or close the case.

## Contain

### Disable or rotate the key and revoke sessions {#rotate-key kind=action d3fend=D3-CR}
Disable or rotate the key, revoke the identity's sessions and tokens, and record the change reference.

## Eradicate

### Remove attacker-created keys, roles and resources {#remove-attacker-resources kind=action}
Remove every key, role, policy, consent and resource the attacker created, after you have recorded them.

## Recover

### Are workloads using the new credentials? {#workloads-updated kind=check evidence=note}
Escalate if: the old key is still in use, or new unexpected activity appears.
Benign if: every workload runs on the new credentials and the old ones are gone.

### Record the outcome and what you would change {#record-outcome kind=record}
Write how the identity was exposed and what would have limited it, such as shorter-lived keys or tighter permissions.
