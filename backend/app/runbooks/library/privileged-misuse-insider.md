---
id: privileged-misuse-insider
title: Privileged access misuse and insider activity
summary: A privileged account did something outside its approved work. Check whether a change covers it and whether it fits the person's role.
use_when: A detection reports privileged or administrative access that no change explains, or unusual activity by an insider.
prerequisites: Administrative and application audit logs; the change calendar; a contact in HR or legal for insider cases.
version: 1
priority: 85
review_every_days: 180
mitre: [T1078.003]
applies_when:
  rule_ids: [external_admin_panel_access]
retrieval_queries:
  - privileged web access response
  - administrative login verification
  - insider threat investigation
references:
  - https://attack.mitre.org/techniques/T1078/003/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Is the activity covered by an approved change or ticket? {#approved-change kind=check evidence=note}
Focus: the change calendar, open tickets and on-call duty for this account and time.
Escalate if: no change, ticket or on-call duty covers the activity.
Benign if: an approved change or an on-call task covers it.

### Privileged actions by this account in 7 days {#privileged-actions kind=lookup}
Focus: administrative actions, their targets and their times.

```lookup
tool: log_stats
filter:
  user: "{{entity.user}}"
group_by: [action]
window: case_last_seen-7d..case_last_seen+1h
limit: 20
run: on_attach
```

Actions come from the ECS field `event.action`. If the source does not record that field, no actions are listed; that means the field is missing, not that nothing happened.

## Investigate

### Does the activity match the person's role? {#role-match kind=check evidence=note}
Focus: what the person's role needs, compared with what the account did.
Escalate if: access to data or systems outside the role, at unusual hours or in unusual volume.
Benign if: normal duties for the role at expected times.

Keep what you learn about the person to the people who need it.

### Involve HR or legal as your policy requires {#involve-hr-legal kind=record approval=soc_manager}
Record who you involved, when, and what they asked you to do.

### Misuse, suspicious or authorised? {#decide kind=decision}
Escalate if: the access is unauthorised, comes from hostile infrastructure, or is followed by privileged changes.
Benign if: authorised access from an expected place by the account owner.
Options:
- misuse: Misuse
- suspicious: Suspicious, not confirmed
- authorised: Authorised | skips: reduce-privileges

Recording a decision does not change the verdict or close the case.

## Contain

### Remove or reduce the account's privileges {#reduce-privileges kind=action d3fend=D3-AL}
Remove the privileges the account does not need, or lock it while the review continues.

## Close and learn

### Record the outcome and what you would change {#record-outcome kind=record}
Write what happened and whether access reviews or approvals should change.
