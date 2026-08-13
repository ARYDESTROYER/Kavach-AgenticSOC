---
title: Cases
description: Find, assess, assign, progress, and close v0.1 cases without crossing the deterministic decision boundary.
---

# Cases

A case is Agentic SOC's durable, human-reviewable record for a correlated security story.
It preserves source provenance, selected event identifiers, risk, the agent verdict,
the code decision, analyst actions, cost, and an append-only lifecycle history.

## Find the work that matters

Open **Triage → Cases** for the established table workflow, or **Triage → Case
Manager** for the additive split-pane queue and case workspace. Search by display or
internal case ID, title, entity, rule, source, or tag. Narrow the table by status,
disposition, severity, assignee, time, or cross-source relationship. Saved views and
column choices are personal preferences; they do not change the underlying case.

Case Manager is the intended successor. The Cases table itself remains available for
its mature table/saved-view workflow, but opening a row or case deep link shows a
short announced handoff and opens that exact record in Case Manager. The selected
`caseId` survives refresh and browser history. Use Case Manager directly when you
want queue, detail, and bulk operations in one continuous workspace. See the
dedicated [Case Manager guide](case-manager.md) for exact selection, resize,
permission, and failure semantics.

Selecting rows opens bulk actions. Long-running Case Manager operations snapshot the
selected case IDs and submit one server-owned background job. The dialog closes after
`202 Accepted`; work continues across navigation or reload and reports progress in
**Analytics → Jobs** and **Inbox**. A partial terminal result keeps successful changes
and reports bounded per-case failures rather than rolling the whole selection back.

The terminal action opens a safely allow-listed Cases context such as active status,
resulting status, assignee, or tag. That destination is a useful current filter, not
an immutable cohort of every attempted ID: cases can change again and other cases can
match the same filter. Use job counts, case history, and Audit for exact accountability.

## Status and disposition are different

**Status** is the work lifecycle:

| Status | Meaning |
|---|---|
| New | Created but not yet investigated |
| Open / needs human | Investigated and awaiting an analyst |
| Investigating | An analyst or re-investigation is working the case |
| Escalated | Marked for analyst escalation |
| On hold | Paused for information, maintenance, or a third party |
| Resolved | Work is complete and pending final close or audit |
| Closed | Terminal |

**Disposition** is the investigative outcome: true positive, false positive, benign,
suspicious, duplicate, or undetermined. Closing with a disposition records the
analyst's conclusion; it does not rewrite the earlier agent verdict.

## Work a case

The canonical Case Manager detail has six tabs. Cases no longer opens a separate
sheet with another copy of the same controls.

- **Overview** — a compact decision brief, risk and confidence signal profile,
  persisted risk-factor values, source/agent/code provenance, entity context, attack story,
  ownership, and history without duplicating the same verdict in every card.
- **Timeline** — the chronological input → correlate → risk assigned → triage →
  investigate → decision story. Expanding Risk Assigned reconstructs current-weight
  arithmetic from persisted factors and flags any historical-weight mismatch. In
  Case Manager only, the final stage marker pulses.
- **Investigation** — AI assessment, pinned deterministic decision, and the full
  tool/reasoning trace.
- **Threat** — indicator reputation, ATT&CK context, related cases, and the persisted
  redacted Input alerts → Correlation cluster → Opened case explanation. Focus or
  hover its nodes for source counts, grouping, threshold/window, status, and verdict;
  raw identifiers and payloads are excluded.
- **Collab** — discussion, reactions, activity, and tasks.
- **Chat** — case-scoped questions using the shared chat engine.

In Case Manager, the top-right **Take Action** menu contains state-changing, investigative, and export
commands: the appropriate lifecycle action, disposition, re-investigation, playbook,
refresh, case chat, open in a new tab, JSON/Markdown export, and notification as
permissions allow. Timeline and Investigation are visible tabs and are intentionally
not repeated as menu actions. **Share** remains separate. Exports are available as
JSON or a Markdown handoff report.

## Lifecycle actions and permissions

- Reading cases requires `cases:read`.
- Acknowledge, hold, resume, escalate, de-escalate, reopen, and non-terminal status
  changes require `cases:write`.
- Closing, resolving, or otherwise reaching a terminal state requires `cases:close`.
- Assignment requires `cases:assign`; discussion requires `cases:comment`.
- Re-investigation requires `cases:reinvestigate`; running a playbook requires
  `playbooks:run`.

The server rejects illegal transitions. Reopen a terminal case before moving it to
another non-terminal state; use the dedicated close or resolve action rather than a
generic status setter.

## Automatic decisions

The model produces `FALSE_POSITIVE`, `TRUE_POSITIVE`, or `NEEDS_HUMAN` with a
confidence value. Deterministic code then compares the verdict, confidence, risk,
and configured auto-close policy.

- False-positive auto-close is enabled by default only above its confidence bar and
  below its risk ceiling.
- True-positive auto-close is disabled by default and requires an explicit operator
  opt-in.
- `NEEDS_HUMAN` and missing verdicts can never auto-close.
- Automatically closed cases record an objection window and remain reopenable by
  an authorized analyst.

Analyst actions and automatic decisions are separately attributed in the history and
audit log.

## Close the feedback loop

When closing or resolving, select a disposition deliberately and grade the AI result.
Confirmed false positives can produce a pending suppression proposal and can be
indexed as prior-case context. Neither process silently changes decision policy.

See [Investigation](investigation.md), [Collaboration](collaboration.md),
[Background jobs](../operations/background-jobs.md), and
[Playbooks and approvals](../automation/playbooks-approvals.md).
