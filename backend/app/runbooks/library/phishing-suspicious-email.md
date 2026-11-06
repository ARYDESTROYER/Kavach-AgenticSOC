---
id: phishing-suspicious-email
title: Phishing or reported suspicious email
summary: A suspicious message reached our mailboxes, or a user reported one. Find every copy, judge the lure and act on anyone who clicked.
use_when: A mail detection fires, or a user reports a message as phishing, spam or a scam.
prerequisites: Mail gateway and mail server logs; proxy or endpoint logs to see clicks; access to remove messages from mailboxes.
version: 1
priority: 45
review_every_days: 180
mitre: [T1566]
applies_when:
  rule_ids: [postfix, roundcube_login, mail_auth, mail_apache_access, suricata_mail]
  entity_types: [ip, user]
retrieval_queries:
  - phishing triage runbook
  - MITRE T1566 phishing
  - malicious URL and attachment reputation triage
references:
  - https://attack.mitre.org/techniques/T1566/
  - https://csrc.nist.gov/pubs/sp/800/61/r3/final
---

## Triage

### Find the message and every copy in the mail logs {#find-copies kind=lookup}
Focus: recipients and delivery actions for the sending address around the case window.

```lookup
tool: log_stats
filter:
  ip: "{{entity.ip}}"
group_by: [user, action]
window: case_first_seen-1h..case_last_seen+1h
limit: 50
run: on_attach
```

Use the recipients and actions to see how far the message reached and whether the gateway delivered, rejected or quarantined it.

Actions come from the ECS field `event.action`. If the source does not record that field, no actions are listed; that means the field is missing, not that nothing happened.

### Is the sender or domain impersonating us or a partner? {#impersonation kind=check evidence=note}
Focus: sender address, display name, reply-to address and look-alike domains.
Escalate if: the sender imitates our domain, an executive or a partner, or the reply-to differs from the sender.
Benign if: a known newsletter or marketing sender that a user reported by mistake.

Compare the sender domain with our own domains and those of our partners, letter by letter.

## Investigate

### Reputation of the sender domain, links and attachments {#sender-reputation kind=lookup}
Focus: the sender domain's reputation; check each link and attachment hash the same way.

```lookup
tool: enrich
indicator: "{{entity.domain}}"
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

### Did anyone click a link or open the attachment? {#clicks kind=lookup}
Focus: web requests and file opens by the recipients after the message arrived.

```lookup
tool: log_stats
filter:
  user: "{{entity.user}}"
group_by: [action, url.domain]
window: case_first_seen..case_last_seen+1d
limit: 20
run: on_attach
```

Look in proxy and endpoint logs for each recipient, not only the one named on the case.

Actions come from the ECS field `event.action` and domains from the ECS field `url.domain`. If the source does not record one of them, it is not listed; that means the field is missing, not that nobody clicked.

### Did anyone enter credentials? {#credentials-entered kind=check evidence=note}
Focus: sign-ins for the recipients from new places or devices after the message arrived.
Escalate if: a recipient opened the link and then signed in from a new address or device.
Benign if: nobody opened the link, or the page did not ask for credentials.

### Malicious, suspicious or benign? {#verdict kind=decision}
Escalate if: the message carried a lure that reached real mailboxes, or anyone clicked or entered credentials.
Benign if: a legitimate message that a user reported by mistake.
Options:
- malicious: Malicious
- suspicious: Suspicious, not confirmed
- benign: Benign | skips: remove-message, block-sender, reset-credentials, tell-users

Record what you based the decision on. Recording a decision does not change the verdict or close the case.

## Contain

### Remove the message from every mailbox {#remove-message kind=action react=RA3203}
Quarantine or delete every copy, including those in junk folders. Record how many messages you removed.

### Block the sender and links at the mail and web gateways {#block-sender kind=action react=RA3101}
Block the sending address or domain and every malicious link. Record the change reference.

### Reset credentials of anyone who entered them {#reset-credentials kind=action optional react=RA4601}
Reset the password, end the user's sessions and check that MFA is still the user's own.

## Recover

### Tell affected users what happened and what to watch for {#tell-users kind=record}
Tell the recipients what the message was, what to do if they clicked, and how to report the next one.

## Close and learn

### Tell the reporter what you found {#tell-reporter kind=record}
Thank the person who reported it and tell them the outcome in plain words.

### Record the outcome and what you would change {#record-outcome kind=record}
Write what happened, what you did, and what would have caught it sooner, such as a gateway rule or user training.
