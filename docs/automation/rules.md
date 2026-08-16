---
title: Detection and rules
description: Author, preview, version, and roll back v0.1 detection and case-automation rules.
---

# Detection and rules

Open **Settings → General → Detection & rules**. The unified catalog exposes three
rule tiers while preserving their different responsibilities.

| Tier | Purpose |
|---|---|
| Detection match/threshold | Classify matching events and define when a grouped set fires |
| Anomaly/baseline | Surface deviations from learned aggregate behavior |
| Case automation | React after a case has been saved and decided |

Reading the catalog, previews, and version history requires `rules:read`. Creating,
editing, enabling, deleting, rolling back, or otherwise managing a rule requires
`rules:manage`.

## Detection rules

A detection rule combines:

- identity, name, description, enabled state, priority, and tags;
- a match definition over event fields; and
- a trigger definition such as every match or a threshold count within a window,
  grouped by an entity.

Keep rule names stable and descriptions operational. Validate field paths against
normalized events in [Logs](../analyst/logs-search.md) before enabling a rule broadly.

## Case-automation rules

Case automation evaluates all configured conditions after the deterministic decision
and initial save. Supported actions are tag, recommend, notify, run a playbook, or
request human approval. A rule cannot set status or disposition.

Conditions can constrain verdict, minimum risk or severity, status, source, rule,
and entity type. Rules run in priority order; lower numbers run first.

## Preview before saving

Preview evaluates the proposed rule and recent data without persisting the rule. The
decision preview is a pure what-if: it does not call the LLM, write usage, or mutate a
case. Treat the preview's sample count and time window as part of the result.

## Versions and rollback

Each meaningful edit appends an immutable version record. The history is newest
first and includes the action and saved configuration. Rollback restores a selected
configuration by appending a new rollback version; it never deletes earlier history.

After rollback, preview again and monitor case and noise metrics.

## Analyst rule policies

Some detections cannot be resolved by review. If a rule's alerts carry no request,
payload, or execution context, an investigation has nothing to verify a given instance
against, so it routes to a human every time — no matter how many prior cases of that
rule an analyst has confirmed benign. Confirming more of them cannot change that.

An analyst rule policy is an explicit statement that a detection is benign in your
environment. Open **Settings → Case policy → Declared benign**, add a declaration naming
the detection rule, and give a reason. A cluster whose detections are all declared is then closed automatically
with the `false_positive` disposition and the `analyst_policy` decision owner, without a
model call.

**Understand the trade before you enable one.** A declaration closes matching alerts
**with no model call and no human**. If a genuine attack fires a declared rule, that case
closes silently. Use a declaration only where the alerts genuinely cannot carry the
evidence an investigation needs — where they can, enrich the source instead.

Three bounds keep that decision reversible:

- **Risk ceiling.** Set an optional maximum risk score. A cluster scoring above it is
  investigated normally, so an unusual instance of a declared rule is not closed unseen.
- **Scope and expiry.** Limit a declaration to one source, and give it an expiry, so it
  cannot outlive the situation that justified it.
- **Per-case override.** Reinvestigating a case always overrides the declaration for that
  case, and it needs only `cases:reinvestigate` — an analyst who suspects a declared-benign
  case is real never needs `rules:manage` to act on it.

What it does and does not do:

- the case is still created, still audited, and still reopenable — it is closed, not
  discarded before it exists (that is what a suppression rule does instead);
- every detection on a cluster must be declared before it closes, so a cluster that also
  fired an undeclared detection is investigated normally;
- it never overrides a person. A case an analyst has acted on — reopened, escalated, held,
  acknowledged — or one the agent has already investigated is left alone;
- it applies to new clusters only; close cases that are already open from the case queue;
- policy closes are excluded from false-positive rate, automation rate, auto-close
  health, the noise-reduction funnel, and improvement evidence, and are never counted as
  analyst-confirmed outcomes; and
- revoke by disabling, letting it expire, or deleting it — the next match stops
  immediately, and cases already closed stay closed.

Prefer a policy over repeated confirmation when the alerts genuinely cannot carry the
evidence an investigation needs. Prefer enriching the source when they could. The
diagnostics panel names the rules where confirmation is not helping — see
[Analytics](../analyst/analytics.md).

See [Tuning and baselines](tuning-baselines.md) for generated recommendations and
[Playbooks and approvals](playbooks-approvals.md) for actions requiring review.
