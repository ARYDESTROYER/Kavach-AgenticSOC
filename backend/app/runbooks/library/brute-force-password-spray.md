---
id: brute-force-password-spray
title: Brute force and password spray
summary: Many failed sign-ins against one or more accounts, from one or many sources. The question that matters is whether any attempt succeeded.
use_when: A detection reports repeated failed authentication against our accounts or services.
prerequisites: Authentication logs from the targeted systems with the outcome of each attempt.
version: 1
priority: 50
review_every_days: 180
mitre: [T1110]
applies_when:
  rule_ids: [mail_auth, waf_auth, web_auth, roundcube_login, postfix, sshd, linux_auth, winlogon]
  entity_types: [ip, user, host]
retrieval_queries:
  - brute force lockout policy runbook
  - MITRE T1110 password spray
  - credential stuffing detection thresholds
references:
  - https://attack.mitre.org/techniques/T1110/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Is the source internal or external? {#source-scope kind=check evidence=note}
Focus: the source IP, its network zone and the asset inventory.
Escalate if: an internal host that is not an approved scanner, or an external address with a hostile reputation.
Benign if: an approved vulnerability scanner or a known test.

### How many accounts were tried? {#accounts-tried kind=lookup}
Focus: many accounts from one source is a spray; one account is targeted guessing.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [user]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

### Reputation of the source IP {#source-reputation kind=lookup}
Focus: known hostile, anonymising or unexpected geography for this account.

```lookup
tool: enrich
indicator: "{{entity.ip}}"
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

## Investigate

### Did any attempt succeed after the failures? {#success-after-failures kind=lookup}
Focus: a success for the same source or account during or right after the failures is the decisive signal.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [event.outcome, user]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

If the source changed address, repeat the check for each targeted account.

The outcome comes from the ECS field `event.outcome`. A source that names it differently shows the attempts without their outcome, so check the outcome in the logs before you conclude that nothing succeeded.

### Are the targeted accounts privileged or service accounts? {#privileged-accounts kind=check evidence=note}
Escalate if: an administrator, service or shared account was targeted, or any attempt succeeded.
Benign if: a few failures followed by a normal sign-in from the user's usual device and place.

### Other cases from this source in 30 days {#related-cases kind=lookup}
Focus: repeat activity from the same source, and the accounts it went after before.

```lookup
tool: related_cases
filter:
  entity: "{{entity.ip}}"
window: case_last_seen-30d..case_last_seen
limit: 10
run: on_attach
```

### Is this a confirmed compromise? {#decide kind=decision}
Escalate if: any attempt succeeded and the session then did something unusual, or a hostile source is still active.
Benign if: no attempt succeeded and the failures match a user error or an approved test.
Options:
- confirmed: Confirmed compromise
- suspicious: Suspicious, not confirmed
- benign: Benign | skips: block-source, reset-accounts

Recording a decision does not change the verdict or close the case.

## Contain

### Block the source at the edge {#block-source kind=action optional react=RA3101}
Block the source at the firewall or WAF. Record where you blocked it and the change reference.

### Reset or lock the affected accounts {#reset-accounts kind=action d3fend=D3-AL}
Reset the password and end the sessions of every account that signed in from the source; lock any that you cannot reset now.

## Close and learn

### Tell the account owners {#tell-owners kind=record}
Tell each account owner what happened and what changed for them.

### Record the outcome and what you would change {#record-outcome kind=record}
Write what happened and whether lockout, MFA or detection thresholds should change.
