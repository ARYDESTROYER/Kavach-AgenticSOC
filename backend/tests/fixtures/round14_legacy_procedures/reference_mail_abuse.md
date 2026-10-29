---
id: mail_abuse
title: Suspicious mail activity (Postfix)
applies_to_rules: [postfix]
applies_to_techniques: [T1566]
applies_to_entities: [ip]
keywords: [postfix, smtp, relay, recipient, spam, mail]
persona: identity_access
summary: High-volume relay attempts, rejected recipients, or submission auth failures.
---
SIGNAL
Mail telemetry shows high-volume relay attempts, repeated rejected recipients, or submission authentication failures.

EVIDENCE REQUIRED
Authentication outcomes, send volume, sender and recipient domains, rejection reasons, source reputation, and mailbox ownership.

INVESTIGATION STEPS
1. Classify the activity as outbound relay, inbound spam, or submission authentication abuse.
2. Check whether submission authentication succeeded and whether sending activity followed.
3. Review rejection reasons, sender domains, recipient patterns, and source reputation.
4. Compare message and rejection volume with the normal baseline for the service and mailbox.

TRUE POSITIVE SIGNALS
Successful authentication followed by mass sending, or sustained relay abuse from a hostile source, supports a true positive.

FALSE POSITIVE SIGNALS
Low-volume rejects, normal bounce traffic, or expected bulk mail from an approved sender supports a false positive.

NEEDS HUMAN WHEN
Authentication outcomes, mailbox ownership, or the expected sending baseline cannot be established.

RECOMMENDED NEXT ACTION
Escalate suspected mailbox compromise for credential reset and session review; block a corroborated hostile relay source.

LIMITATIONS
Mail hygiene noise can resemble abuse when recipient and authentication context is missing.
