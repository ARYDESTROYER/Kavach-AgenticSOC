---
id: compromised-account
title: Compromised account or suspicious sign-in
summary: A sign-in that does not fit the account, such as impossible travel or a new device. Confirm with the user, then take the account back if needed.
use_when: A detection reports impossible travel, a risky or unfamiliar sign-in, or other signs that someone else is using an account.
prerequisites: Identity provider sign-in logs; a trusted way to reach the user; access to revoke sessions and reset passwords.
version: 1
priority: 84
review_every_days: 180
mitre: [T1078]
applies_when:
  rule_ids: [impossible_travel, identity_signin]
retrieval_queries:
  - suspicious sign-in triage
  - impossible travel investigation
  - MITRE T1078 valid accounts
references:
  - https://attack.mitre.org/techniques/T1078/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Sign-ins for this account in the last 7 days {#recent-signins kind=lookup}
Focus: new source addresses, countries or devices compared with the user's usual ones.

```lookup
tool: log_stats
filter:
  user: "{{entity.user}}"
group_by: [ip, event.outcome]
window: case_last_seen-7d..case_last_seen+1h
limit: 20
run: on_attach
```

The outcome comes from the ECS field `event.outcome`. A source that names it differently shows the sign-ins without their outcome.

### Does the user confirm the sign-in? {#user-confirms kind=check evidence=note}
Focus: ask the user through a channel you trust, not by replying to the alert.
Escalate if: the user did not sign in, or cannot be reached and the sign-in is unusual.
Benign if: the user confirms travel, a VPN or a new device that explains it.

## Investigate

### Reputation of the sign-in IP {#signin-ip-reputation kind=lookup}
Focus: hosting providers, anonymising services and known hostile addresses.

```lookup
tool: enrich
indicator: "{{entity.ip}}"
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

### Were MFA settings, mail rules or app consents changed? {#account-changes kind=check evidence=note}
Escalate if: new MFA methods, mail forwarding rules or app consents appeared after the sign-in.
Benign if: nothing changed after the sign-in, or the user made the changes on purpose.

### Compromised, suspicious or benign? {#decide kind=decision}
Escalate if: the user denies the sign-in, or the account was changed after it.
Benign if: the user confirms the sign-in and nothing changed.
Options:
- compromised: Compromised
- suspicious: Suspicious, not confirmed
- benign: Benign | skips: revoke-sessions, remove-attacker-changes, owner-control

Recording a decision does not change the verdict or close the case.

## Contain

### Revoke sessions and reset the password {#revoke-sessions kind=action react=RA4601 d3fend=D3-CR}
End every session and refresh token, then reset the password with the user.

### Remove attacker-added MFA methods, rules or consents {#remove-attacker-changes kind=action}
Remove every MFA method, mail rule and app consent the user did not add.

## Recover

### Is the account back under the owner's control? {#owner-control kind=check evidence=note}
Escalate if: new sign-ins from the attacker's addresses appear after the reset.
Benign if: only the owner signs in, from usual places, with their own MFA.

### Record the outcome and what you would change {#record-outcome kind=record}
Write how the account was taken over, if it was, and what would have stopped it.
