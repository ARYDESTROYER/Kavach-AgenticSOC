---
title: Approvals
description: Review what automation proposes, and keep every consequential change behind a person's approval.
---

# Approvals

Some changes are too consequential for automation to make on its own. Agentic SOC drafts
them as **proposals** and waits for a person. Open **Triage → Approvals** to review them.
Nothing a proposal describes applies until someone approves it, and approving one never
changes a case's close or escalate decision: that stays with the deterministic case policy
(see [Deterministic decisions](../concepts/deterministic-decisions.md)).

Reading the queue needs `proposals:read`. Approving, acknowledging and rejecting need
`proposals:approve`. Built-in super admins, SOC managers and responders hold both; the
other built-in roles can read the queue. See [Permissions](../reference/permissions.md).

## What waits for approval

Four kinds of proposal reach the queue, each labelled on its card:

| Kind | Drafted by | What approving does |
|---|---|---|
| Suppression | A confirmed false positive, or an automation rule that asks for a suppression | Adds the suppression rule shown and makes it live |
| Memory | An agent or an automation rule that wants to remember a fact | Saves the fact as trusted operator memory |
| Tuning change | Auto-tuning, from analyst-confirmed outcomes | Checks the live value again, then applies only the bounded detection change shown |
| Automation review | A case-automation rule set to request approval | Records that a person reviewed it; nothing else changes |

A tuning proposal can also ask for more human evidence, or for a review of earlier
history, instead of a change. Approving one of those acknowledges it and changes no
threshold.

Proposals that wait too long expire: an automation-drafted proposal retires itself after 30
days, and an expired proposal can no longer be approved (ask for a new one). A suppression
proposal's expiry is the end date of the rule it would create, not a review deadline.

Runbook step approvals are a different thing. When step approvals are on in the Runbooks
settings, an Action or Record step can wait for an approver inside the case's Runbook tab;
those approvals never appear on this page. See [Runbooks](../intelligence/runbooks.md).

## Review the queue

The queue shows **Pending** proposals by default; choose **All** to see the decided ones as
well. **Group by source or rule** gathers proposals that share a suppression field, a memory
category, a tuning rule or an automation rule. Each card shows the proposed change, the case
and evidence it came from, the confidence and rationale, and when it expires, and opens the
source case when you can read cases.

Select several cards to approve or acknowledge them together, or to reject them in one
audited request. A decision that did not finish (for example, the connection dropped) shows
**Resume approval** or **Retry rejection** on its card, and finishing it never applies the
change twice.

## Case automation and proposals

A case-automation rule may request approval instead of performing a consequential action,
and a confirmed false positive can draft a suppression proposal. These proposals begin
pending and do nothing until an authorized person approves them.

- An apply proposal changes only the bounded setting it shows.
- Evidence and history proposals, and automation reviews, record an acknowledgement only
  and never create trusted Memory.
- A memory becomes trusted only once it is approved.
- A tuning change is checked against the live value before it applies.
- Rejected proposals stay in history and change nothing.

Approval applies only the allow-listed proposal type; it never gives the model a general
write channel. Every approval, acknowledgement and rejection is recorded in the
[Audit log](../administration/audit-log.md) before the change becomes visible.

## Safety model

Agent tools are assigned safety tiers, and investigation tools are read-only. Runbook
Action and Record steps are done by a person in another system; Agentic SOC records them
and never performs them. Closing a case or approving a proposal is never an autonomous
tool action.

See [Detection and rules](rules.md), [Tuning and baselines](tuning-baselines.md),
[Cases](../analyst/cases.md) and [Runbooks](../intelligence/runbooks.md).
