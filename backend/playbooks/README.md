# Agentic SOC Markdown Playbooks

A **playbook** is an operator-authored Markdown file that tells the agent *how to
think about a particular kind of cluster*: which tools to suggest, which RAG
queries to pull context with, and what verdict bias / escalation hint to keep in
mind. It is the deterministic sibling of the plain-text **runbooks** — where a
runbook is selected by a fuzzy keyword/rule score, a playbook is selected by an
**explicit, auditable match contract**.

> **Playbooks can only RECOMMEND.** A playbook never closes, escalates, or sets a
> verdict on its own — only deterministic code (`engine/case_manager.py`'s
> `decide()`) against the operator-configured `AutoClosePolicy` can do that
> (non-negotiable #3). FALSE_POSITIVE auto-close is on by default above a
> confidence/risk bar; TRUE_POSITIVE auto-close is a real, opt-in (off by default)
> policy knob; only NEEDS_HUMAN never auto-closes. A playbook's `escalate_if` and
> `suggested_verdict_bias` are *hints for the investigator*, not actions, and can
> never override that policy.

Each file has two parts: a **front-matter manifest** (between the `---` fences) and
a free-text **Markdown body** (your operator procedure). The body is injected as
TRUSTED guidance into the investigator when the playbook is selected.

## Full example

```markdown
---
id: mail_credential_bruteforce
name: Mail credential brute force
version: 2
description: A burst of failed mail / webmail authentications from one source.
priority: 50
match:
  rule_ids: [mail_auth, roundcube_login, postfix, web_auth, waf_auth, suricata_mail]
  entity_types: [ip, user]
  min_event_count: 5
  mitre: [T1110]
  any_tags: [credential-access]
suggested_tools: [es_query, enrich]
rag_queries:
  - mail authentication brute force playbook
  - roundcube failed login burst
escalate_if: any single attempt SUCCEEDED after the failure burst
suggested_verdict_bias: lean TRUE_POSITIVE if a success follows the burst
---

## Procedure

1. Confirm the volume and the time window of the failed authentications.
2. Check whether ANY attempt **succeeded** from the same source/user — a success
   after a failure burst is the escalation trigger.
3. Enrich the source IP reputation; correlate with `postfix` / `suricata_mail`.
4. If only failures and the source is low-reputation noise, lean toward a benign
   verdict; otherwise surface for human review.
```

## Front-matter fields

### Top level (`PlaybookManifest`)

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `id` | string (slug) | **required** | Unique id. Must match `^[a-z0-9][a-z0-9_-]{0,63}$`. A bad/missing id skips the file. |
| `name` | string | falls back to `id` | Human-readable name. |
| `version` | int ≥ 1 | `1` | Bump when you change a playbook; higher version wins ties. |
| `description` | string | `""` | One-line summary for the catalog UI. |
| `match` | object | empty | The match contract (see below). |
| `priority` | int | `0` | Higher priority wins when multiple playbooks match. |
| `suggested_tools` | list | `[]` | Tool names the investigator should consider (e.g. `es_query`, `enrich`). |
| `rag_queries` | list | `[]` | Queries to pull supporting context from the RAG corpus. |
| `escalate_if` | string | `""` | A human-readable escalation hint. Advisory only. |
| `suggested_verdict_bias` | string | `""` | A verdict nudge for the investigator. Advisory only. |

Unknown front-matter keys are **ignored** (logged as a warning) — a typo or a newer
schema field never makes a playbook fatal to load.

### `match` (`PlaybookMatch`) — the selection contract

Every criterion is **any-of** and **optional**. A playbook matches a cluster iff
**ALL of its PRESENT (non-empty) criteria are satisfied**; an empty / omitted
criterion does **not** constrain.

| Field | Type | Matches when |
|-------|------|--------------|
| `rule_ids` | list of rule ids | the cluster's rule set (`rule_values` ∪ `primary_rule()`) intersects this list. |
| `entity_types` | list of `ip` / `user` / `host` | the cluster entity type is in this list. |
| `min_event_count` | int | `cluster.count >= min_event_count`. |
| `mitre` | list of techniques | matches **opportunistically** against the cluster's rule names (see note). |
| `any_tags` | list of tags | matches **opportunistically** against the cluster's rule names (see note). |

> **Note on `mitre` / `any_tags`.** Clusters carry no MITRE techniques or tags
> *before* investigation, so these two criteria currently match opportunistically
> against the cluster's (lowercased) rule names — e.g. a rule literally named like a
> technique/tag will satisfy them. Treat them as additive hints; rely on
> `rule_ids` / `entity_types` / `min_event_count` for precise targeting.

## Selection order

Among all matching playbooks the engine picks **one**, deterministically:

1. highest `priority`
2. then highest `version`
3. then lexicographically smallest `id`

When nothing matches, selection returns `(None, "no_playbook_matched")`.

## Rule ids: keep them portable

`match.rule_ids` is matched EXACTLY against the cluster's rule set
(`rule_values` ∪ `primary_rule()`), and that rule set is whatever the operator's
own rule catalog produced. A bundled playbook therefore declares **portable,
Layer-3 identifiers** — a lowercase slug (`_` or `-` between words), no spaces, no
capitals, no vendor product names, no query-language markers — and an operator
**maps their own SIEM rule titles onto those ids** with a `RuleDefinition` in the
rule catalog (Settings → Detection & Rules):

```
name:  external_admin_panel_access                    # the portable id a playbook declares
match: field=rule.name  op=equals  value=<your SIEM's exact rule title>
```

Pasting a SIEM rule title straight into `match.rule_ids` works only in the one
deployment that title came from; every other deployer of this open-source suite
gets a playbook that can never match. Operator-authored playbooks in an override
directory are free to declare whatever ids that site actually emits — the rule is
about what **ships in this repository**. `backend/tests/test_portability_contract.py`
enforces the shape on the bundled set.

The same applies to `match.any_tags` and `match.mitre`: selection tests **all three**
against the same cluster rule set, and a playbook whose only declared criteria are
those two soft signals is selectable *solely* when a rule name hits one of them. So a
SIEM title parked in `any_tags` is deployment-locked exactly like one in `rule_ids`.
Keep `any_tags` portable slugs and `mitre` real ATT&CK technique ids (`T1110`,
`T1550.001`) — the lint holds all three to those shapes.

**A bundled id is reserved.** The merged catalog gives a bundled playbook precedence
over an operator document of the same id: the operator row is retained but inert, the
entry stays read-only, and the reload summary lists it under `shadowed_by_bundled`.
Author site-specific procedures under a deployment-specific id so a future release
cannot displace them.

## Sample rule ids seeded on a fresh install

The default rule catalog (`backend/app/config.py`, `_SAMPLE_EVENT_MODULES` +
`_MODSEC_SUBRULES`) seeds 13 `event.module` rules plus 5 ModSecurity sub-rules,
18 sample ids in total. They are **illustrative starter content from one reference
environment**, not a contract: they seed only when the stored catalog is EMPTY, and
operators are expected to edit, disable, or replace them with their own detections.

**`event.module` rules** (priority 100):
`mail_apache_access`, `mail_auth`, `mail_fim`, `ml_stats`, `modsec_audit_log`,
`openvas_report`, `postfix`, `roundcube_login`, `suricata_mail`,
`waf-nginx-access`, `waf_auth`, `web_apache_access`, `web_auth`.

**ModSecurity OWASP CRS sub-rules** (`rule.id` prefix match, priority 50 — these
classify before the generic `modsec_audit_log` rule above):
`modsec_xss` (941xxx), `modsec_sqli` (942xxx), `modsec_lfi` (930xxx),
`modsec_rce` (932xxx), `modsec_scanner` (913xxx).

## Shipped playbooks in this directory

| File / `id` | Name | Priority | Scope (`rule_ids` / `entity_types`) |
|---|---|---|---|
| `brute_force_login.md` | Brute-force / password-spray login | 50 | `mail_auth, waf_auth, web_auth, roundcube_login, postfix` / `ip, user, host` |
| `cloud_identity_compromise.md` | Cloud identity compromise | 82 | cloud IAM, role, token, service-principal, and impossible-travel rule families / `user, host, ip, rule` |
| `data_exfiltration_response.md` | Data exfiltration response | 88 | staging, bulk-download, covert-channel, insider, and data-access rule families / `user, host, ip, rule` |
| `phishing_reported_email.md` | Reported phishing email | 45 | `postfix, roundcube_login, mail_auth, mail_apache_access, suricata_mail` / `user, ip` |
| `privileged_web_access.md` | Privileged web access | 85 | successful external administrative-access family / `ip, user, host, rule` |
| `ransomware_response.md` | Ransomware impact response | 92 | mass-encryption and ransomware-impact rule families / `host, user, ip, rule` |
| `suspicious_outbound_connection.md` | Suspicious outbound / beacon-like connection | 40 | `suricata_mail, ml_stats` / `ip, host` |
| `web_application_abuse.md` | Web application abuse | 80 | application session/administration/upload/enumeration families / `ip, user, host, rule` |
| `web_scanner_activity.md` | Web scanner and exploit activity | 75 | vulnerability-scanner and web-shell families / `ip, host, rule` |

Each carries ATT&CK and tag hints where useful. See the file's front matter for
the exact match contract and its Markdown body for the investigation procedure.

## API + configuration

- `GET /api/playbooks` — list the loaded catalog (id/name/version/priority/
  description/match summary plus `bundled|operator` ownership and editability).
- `GET /api/playbooks/{id}` — open the parsed metadata and plain UTF-8 Markdown.
- `POST /api/playbooks` / `PUT /api/playbooks/{id}` — create or atomically update
  an **operator-owned** Markdown file (`playbooks:manage`). IDs are slug/path
  constrained, content is bounded to 256 KiB, the front-matter id must match, and
  a successful write reloads the registry and appends an audit event.
- `POST /api/playbooks/reload` — atomically re-read this directory and hot-swap
  the live registry (validate-then-swap; a broken file never replaces a
  known-good set).
- `GET /api/playbooks/selection/{case_id}` — show which playbook (if any) was
  selected for a given case and why.
- **`Preferences.playbooks.dir`** overrides the default location (this
  directory, `backend/playbooks/`) if you want to point at an operator-owned
  playbook directory instead. `Preferences.playbooks.enabled` (default `true`)
  turns the whole system off if you never want playbook injection.

The nine procedures shipped in this directory are protected reference content in
the runtime editor: browse/copy is allowed, overwrite is not. Files created through
the Console are operator-owned and editable. Every valid file in a configured
override directory is treated as operator-owned. Runtime deletion is intentionally
not exposed in v0.1; use controlled deployment/configuration management to retire a
file, then reload the registry.

## Loading order

Playbooks live in this directory (or the `Preferences.playbooks.dir` override) as
`*.md` files, loaded in sorted order at boot and on every
`POST /api/playbooks/reload`. An invalid file is **skipped** (logged) and never
breaks the rest.

> **Selection note — `mitre` / `any_tags` are advisory, not hard filters.** A
> cluster carries no MITRE techniques or tags at *selection* time (those come from
> the verdict, after investigation), so requiring them would make every
> technique-tagged playbook unmatchable. The hard match criteria are therefore
> `rule_ids`, `entity_types`, and `min_event_count`; `mitre`/`any_tags` only
> *boost* the match reason when a rule name happens to carry the signal. They never
> exclude an otherwise-matching playbook.
