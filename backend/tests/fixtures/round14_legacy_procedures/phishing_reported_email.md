---
id: phishing_reported_email
name: Reported phishing email
version: 1
description: A user-reported phishing message — scope reach, reputation, and follow-on.
match:
  rule_ids: [postfix, roundcube_login, mail_auth, mail_apache_access, suricata_mail]
  entity_types: [user, ip]
  mitre: [T1566]
  any_tags: [mail, phishing, email]
priority: 45
suggested_tools: [enrich, es_query, rag_retrieve]
rag_queries:
  - phishing triage runbook
  - MITRE T1566 phishing
  - malicious URL and attachment reputation triage
escalate_if: A recipient clicked the link or opened the attachment AND a subsequent authentication for that user.name originates from a new/unexpected source.ip — treat as likely credential compromise and escalate.
suggested_verdict_bias: Bias toward TRUE_POSITIVE when sender source.ip or embedded url.original has hostile reputation and the message reached real mailboxes; bias toward FALSE_POSITIVE for a benign newsletter/marketing message a user mis-reported.
---
## Objective
Triage a reported phishing message: confirm it is malicious, measure how many
users it reached (T1566), and detect any follow-on compromise. The cheapest hard
signals are sender/URL/attachment reputation; the highest-stakes signal is a
post-click authentication from a new IP.

## Phase 1 — Scope
- Identify the message: pull the delivery record via `postfix` / `mail_apache_access`,
  capturing sender `source.ip`, embedded `url.original`, and the recipient
  `user.name`(s) from `message`.
- **Measure reach:** count distinct recipient `user.name` that received the same
  sender / subject / `url.original` — one report often represents a campaign.
- Note any attachment indicators present in `message` for the recipients.

## Phase 2 — Enrich & correlate
- **Reputation:** `enrich` the sender `source.ip` and each embedded `url.original`
  (and attachment hash if present). Hostile reputation strongly confirms malice.
- **Click / interaction:** look for outbound contact to the phishing
  `destination.ip` / URL host, or webmail activity via `roundcube_login`
  indicating a recipient engaged.
- **Follow-on auth:** for each recipient `user.name`, correlate `mail_auth` /
  `roundcube_login` for an `event.outcome:success` from a new or unexpected
  `source.ip` shortly after delivery — the key compromise indicator.
- Distinguish benign mis-reports: legitimate newsletters/marketing with clean
  reputation are common false reports.

## Phase 3 — Decide
- **TRUE_POSITIVE (escalate):** hostile sender/URL reputation AND a recipient
  click followed by a successful login from a new `source.ip` → likely account
  compromise; reset credentials, purge the message, hunt mailbox rules/forwarding.
- **TRUE_POSITIVE (no escalate):** malicious message confirmed but no evidence of
  click or follow-on auth → quarantine/purge across recipients, warn users.
- **FALSE_POSITIVE:** clean reputation across sender `source.ip` and `url.original`,
  recognizable legitimate sender → benign mis-report.
- **NEEDS_HUMAN:** reputation inconclusive, or unclear whether any recipient
  interacted.

## Reproduce
- Reach: filter `postfix` / `mail_apache_access` for the sender / `url.original`,
  group by recipient `user.name`; inspect `@timestamp`, `message`.
- Reputation: `enrich` on sender `source.ip` and each `url.original`.
- Follow-on: per recipient `user.name`, query `mail_auth` / `roundcube_login` for
  `event.outcome:success` from a new `source.ip` after delivery; pull phishing
  triage steps from RAG.
