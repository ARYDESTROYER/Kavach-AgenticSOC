---
id: brute_force_login
name: Brute-force / password-spray login
version: 1
description: Repeated failed authentications or password spray against accounts or services.
match:
  rule_ids: [mail_auth, waf_auth, web_auth, roundcube_login, postfix]
  entity_types: [ip, user, host]
  mitre: [T1110, T1078]
  min_event_count: 5
  any_tags: [auth, login, credential]
priority: 50
suggested_tools: [es_query, enrich, rag_retrieve]
rag_queries:
  - brute force lockout policy runbook
  - MITRE T1110 password spray
  - credential stuffing detection thresholds
escalate_if: A successful authentication (event.outcome:success) follows the failure burst from the same source.ip or for the same user.name — treat as possible account compromise and escalate.
suggested_verdict_bias: Bias toward TRUE_POSITIVE when failures are sustained from a hostile source.ip with no legitimate success; bias toward FALSE_POSITIVE when a handful of failures precede a normal success from a known user/host.
---
## Objective
Decide whether a cluster of failed logins is a real credential attack (guessing,
stuffing, or spray) or benign user error. The single pivotal question: **did any
authentication SUCCEED during or just after the failure burst?**

## Phase 1 — Scope
- Confirm the burst: count `event.action` auth-failure events where
  `event.outcome:failure` in the cluster window, grouped by `source.ip` and
  `user.name`. Require at least `min_event_count` (5) to be meaningful.
- Classify the shape:
  - **Many `user.name` from one `source.ip`** → password spray / stuffing.
  - **One `user.name` from one `source.ip`** → targeted guessing.
  - **One `user.name` from many `source.ip`** → distributed spray on one account.
- Record the targeted `host.name` / service via `event.module` and `rule.id`
  (e.g. `roundcube_login`, `postfix`, `waf_auth`).

## Phase 2 — Enrich & correlate
- **Pivot to success:** query the same `source.ip` and each targeted `user.name`
  for `event.outcome:success` from the start of the window through ~30 min after.
  A success here is the decisive signal (T1078 Valid Accounts).
- `enrich` the `source.ip` for reputation/geo/ASN. Known-hostile or anomalous
  geo for the account raises confidence.
- Correlate the volume against this `user.name`'s normal failure baseline — a
  few stray failures are routine; a sustained spike is not.

## Phase 3 — Decide
- **TRUE_POSITIVE (escalate):** any `event.outcome:success` from the attacking
  `source.ip` or for a sprayed `user.name` after the burst → likely compromise;
  recommend credential reset + source block, hunt for follow-on session/activity.
- **TRUE_POSITIVE (no escalate):** sustained failures, hostile `source.ip`, no
  success → recommend blocking the source; no compromise yet.
- **FALSE_POSITIVE:** a couple of failures then a normal success from a known
  user/host/IP (fat-finger, expired cache, password change).
- **NEEDS_HUMAN:** cannot confirm whether anything succeeded, or partial/missing
  outcome data.

## Reproduce
- List failures: filter `event.outcome:failure` + matching `rule.id`, group by
  `source.ip`, `user.name`; inspect `@timestamp`, `host.name`, `message`.
- Success check: same `source.ip` / `user.name` with `event.outcome:success` over
  the window plus a trailing buffer.
- Reputation: `enrich` on `source.ip`; consult RAG for the lockout policy.
