---
title: Deterministic decisions
description: Learn why model verdicts are advisory and how Agentic SOC 0.1 code owns close, escalation, and human review.
---

# Deterministic decisions

This page applies to **Agentic SOC 0.1**. It explains the central safety contract for
analysts, administrators, and integrators: **the model supplies a verdict; code owns
the consequential case decision**.

## Verdict and decision are separate

The investigator can return one of three verdicts:

- `TRUE_POSITIVE`
- `FALSE_POSITIVE`
- `NEEDS_HUMAN`

The case manager then evaluates a pure policy over:

```text
verdict + confidence + deterministic risk score + operator auto-close policy
```

The policy result sets the case state and records a plain-language rationale. Model
text, a playbook, a notification, and a case-automation rule cannot directly set the
result.

## Auto-close policy

True-positive and false-positive verdict classes have independent settings:

- enabled or disabled;
- minimum confidence;
- maximum risk score; and
- human objection-window duration.

False-positive auto-close can be enabled with conservative thresholds. True-positive
auto-close is off by default and requires an explicit operator choice. If a class is
disabled or its confidence/risk bar is not cleared, the case routes to a human.

`NEEDS_HUMAN`, a missing verdict, and an unknown verdict are never auto-closable.
That rule is enforced in code and is not exposed as a setting.

## Analyst rule policies

The auto-close policy applies to a verdict. Some detections never produce one worth
applying it to: if a rule's alerts carry no request, payload, or execution context, an
investigation cannot verify that a given instance is benign, so it routes to a human
however many prior cases of that rule an analyst has confirmed benign. Confirming more
cases cannot change that, because the judgement is about missing evidence rather than
about precedent.

An analyst rule policy is the operator's own statement about their environment: this
detection is benign here. A cluster whose detections are all declared is closed with the
`false_positive` disposition and the `analyst_policy` decision owner, without any model
call. The declaration is recorded with its author, reason, optional source scope, and
optional expiry, and is revoked by disabling, expiring, or deleting it.

A declaration closes matching alerts with no model call and no human, so a genuine attack
matching a declared rule closes silently. It carries an optional risk ceiling, an optional
source scope and an optional expiry to bound that, and an explicit reinvestigation of a
single case always overrides it.

Four properties keep it honest:

- the case stays visible, audited, and reopenable — nothing is dropped before a case
  exists, which is what a suppression rule does instead;
- every detection on the cluster must be declared, so a cluster that also fired an
  undeclared detection is still investigated normally; and
- the close is excluded from agent-performance measurement and is never read as an
  analyst-confirmed outcome, so it can neither flatter the agent nor become training
  evidence for the automation it replaces; and
- it never overrides a person. A case an analyst has acted on, or one the agent has
  already investigated, is left alone — a statement about a detection does not overrule a
  decision about a case.

This path runs before a verdict exists. It does not change, read, or extend the
auto-close policy above.

## Analyst-confirmed precedent

Retrieval already surfaces resolved cases as context. When enabled, precedent promotion
additionally tells the investigator, as a computed count rather than retrieved prose, how
many analyst-confirmed benign and malicious outcomes exist for the **exact** detection
rule set under investigation.

It is evidence, not authority. The verdict still comes from the model and the policy
above still decides the outcome. It requires the rule identity to match — a
high-similarity match from a different rule never qualifies — an unanimous confirmed
history, a minimum confirmed count, and at least one matching precedent actually
retrieved for the case. The agent's own unreviewed auto-closes are never promotable. What
was promoted, or why it was not, is recorded on the case.

## Escalation and analyst action

A high-severity true positive that does not auto-close can be escalated for priority
human attention. Escalation is not closure. Analysts can acknowledge, investigate,
hold, resume, resolve, reopen, escalate, de-escalate, and set a disposition through
guarded lifecycle actions.

Every transition records who or what made it, when it happened, and the reason.

## What automation may do

After the deterministic decision and case save, approved automation can:

- add tags;
- record recommendations;
- send notifications;
- request human approval; or
- queue an allowed playbook run.

It cannot change the close/escalate truth table. A playbook is investigation context,
not policy.

## Failure behavior

Missing provider credentials, provider errors, tool failures, invalid model output,
or an exhausted budget must not drop the signal. The safe result is human review.
Likewise, the event-feed risk gate decides whether to spend on investigation; it does
not modify canonical risk or close a case.

## Verify the contract

On a case's **Investigation** tab, compare:

1. the model verdict and confidence;
2. the deterministic risk score;
3. the pinned decision card and its policy rationale; and
4. the status-history and audit entries.

The four should tell one traceable story without implying that model prose executed
the action.

## Related pages

- [Architecture](architecture.md)
- [State, audit, and cost](state-audit-cost.md)
- [Create your first case](../getting-started/first-case.md)
- [Security](../operations/security.md)
