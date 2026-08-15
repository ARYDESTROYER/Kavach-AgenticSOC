---
title: Case Manager
description: Operate the additive split-pane case queue, detailed investigation workspace, and permission-gated bulk actions in Agentic SOC 0.1.
---

# Case Manager

**Triage → Case Manager** keeps queue triage and case investigation in one screen.
It is additive in 0.1: the established **Cases** table remains available, no saved
view is migrated automatically, and opening Case Manager does not change a case.
The two surfaces read and mutate the same backend case records and audit trail.
Opening a row or case deep link from Cases shows a short announced
**Taking you to Case Manager…** handoff, then opens that exact case here. The
`caseId` remains in the Case Manager URL so refresh, browser history, and bookmarks
preserve the selected record.

## Queue scope and ordering

Use **Active** for non-terminal work and **All** to include resolved and closed
records. The queue distinguishes the number currently shown from the number loaded
by the client; filters operate on the loaded set rather than implying that an
unloaded server result was selected. The current client window is capped at 200
cases and shows the backend total separately when it is larger.

The queue provides:

- case/entity search;
- severity and status filters;
- latest-updated, highest-risk, newest-created, and title ordering;
- manual refresh.

Selecting a queue row opens the case in the workspace without leaving the queue.
On a narrow viewport, the queue is the complete first screen and the case workspace
opens after selection.

## Resize the desktop split

At desktop width, drag **Resize case queue** between the queue and detail panes.
Keyboard users can focus the divider and use Left/Right Arrow in 24-pixel steps,
Shift+Arrow in 48-pixel steps, Home/End for the allowed minimum/maximum, or
double-click to reset. The queue defaults to 400 px, stays between 320 and 680 px,
and never consumes the detail pane's 560 px minimum. The chosen width is stored in
this browser. Below the desktop breakpoint, the selected detail replaces the queue
and the **Cases** back control returns to it instead of exposing a resize handle.

## Read the workspace

The top-right header keeps **Share**, **Take Action**, and close/back controls in one
consistent location. Take Action contains commands, not navigation duplicates;
Timeline and Investigation remain tabs.

| Tab | Purpose |
| --- | --- |
| Overview | Decision brief; signal profile; persisted risk-factor values; conditional latest-run Investigation inputs; source, agent, and code provenance; entities; attack story; status history |
| Timeline | Six-stage input-to-decision narrative; Risk Assigned reconstructs the arithmetic from persisted factor values and current weights, flags a historical-weight mismatch honestly, and pulses only the final marker |
| Investigation | AI assessment, detailed Investigation inputs, evidence, recommendation, reproduction query, deterministic decision, and collapsible full trace |
| Threat context | IOC reputation, MITRE ATT&CK mapping, related cases, and the redacted persisted alert → correlation cluster → opened case explanation |
| Collaboration | Case thread, reactions, activity, tasks, assignment, and handoff context |
| Chat | Case-scoped use of the shared AI Analyst chat engine |

The Overview visualization is explanatory, not a second scoring engine. It renders
the score, confidence, and factors already recorded on the case. If a factor was not
persisted, the UI does not manufacture a contribution to make the chart look full.

**Investigation inputs** is also an evidence projection, not a feature-enabled list.
It appears only when the latest investigation run recorded applicable context. The
summary distinguishes approved operator **memory consulted**, indexed **RAG knowledge
retrieved**, **runbook references retrieved**, a **playbook actually injected and
consulted**, and an immutable **platform tuning** snapshot. The tuning record describes
a deterministic correlation or severity-threshold change—never model fine-tuning—and
includes its before/after values in the detailed Investigation view. **Review inputs**
moves to that detail. Earlier-run inputs never carry into a later reinvestigation, and
an unavailable provenance lookup is not rendered as an empty successful run. These
inputs may inform preprocessing or the agent assessment; deterministic case policy
remains the final close/escalate route authority.

## Single-case actions

**Take Action** exposes only actions allowed by the case state and the signed-in
operator's permissions. Depending on context, it includes a lifecycle action,
**Set disposition**, **Reinvestigate**, **Run a playbook**, **Refresh case**,
**Ask about this case**, open-in-new-tab, JSON export, Markdown report export, and
**Notify**. Destructive or billable operations require their existing confirmation;
server-side transition and authorization checks remain authoritative.

## Select cases and run bulk work

Use a row checkbox for an individual case. **Select visible** selects only the rows
that remain after the current Active/All scope, search, severity filter, status
filter, and ordering are applied to the loaded client window. It does not claim or
fetch every matching case on the server. The checkbox becomes indeterminate when
only some visible rows are selected; deselecting it removes only that visible scope.
The row checkbox is separate from row navigation, so selecting never opens a case.
Changing search, filters, sort, or Active/All does not silently discard hidden
selections. Refresh prunes IDs that are no longer present in the authoritative
loaded window. Use **Clear case selection** to clear everything. The action menu is
shown only while at least one case is selected.

The current Case Manager menu intentionally contains these seven actions:

| Action | Permission | Input and behavior |
| --- | --- | --- |
| Acknowledge | `cases:write` | Confirmation; sends `acknowledge` for every selection and moves each eligible case to Investigating |
| Assign | `cases:assign` | Focused analyst/team text dialog, prefilled with the current username when available; changes owner without changing lifecycle status |
| Add tag | `cases:write` | Appends one non-empty tag while preserving and de-duplicating existing tags |
| Set status | `cases:write` | Choose Open, Investigating, On hold, or Escalated; the server validates each transition |
| Set disposition | `cases:write` | Choose True positive, False positive, Benign, Suspicious, or Duplicate without silently closing the case |
| Reinvestigate | `cases:reinvestigate` | Confirmation warns that each case reruns the full metered AI pipeline and may change verdict, confidence, and status |
| Resolve | `cases:close` | Confirmation; uses the canonical analyst `resolve` lifecycle action with an audited bulk-resolution reason |

Raw **Close** is deliberately absent. Resolve is the bulk completion action; use
the single-case workflow when a close requires case-specific disposition,
resolution, or feedback. A missing permission hides that action rather than leaving
an unusable menu item.

The Console does not execute these selections as a browser-owned per-case loop.
Acknowledge, Set status, Set disposition, and Resolve submit a `case_lifecycle` job;
Assign submits `case_assign`; Add tag submits `case_tag`; and Reinvestigate submits
`case_reinvestigate`. Each request carries the exact selected `case_ids` snapshot and
validated action input. A later selection, filter, assignee, tag, or status change in
the browser cannot mutate an accepted job.

The confirmation remains open while admission is ambiguous and reuses the same
per-intent idempotency key across a retry or double-submit. After `202 Accepted`, the
dialog closes immediately and the Console confirms that work is running in the
background. Reinvestigation retains its explicit warning that every selected case can
incur model cost and change verdict, confidence, or status. The authoritative progress,
success/failure counts, cancellation request, and bounded failure reasons then live in
**Analytics → Jobs** and the durable **Inbox** entry. Work is not cancelled when the
operator changes pages or reloads.

Cancellation is cooperative and does not undo completed case changes. Each item is
re-authorized and reloaded before execution; unsafe ambiguous in-progress items fail
closed after lease recovery rather than being applied twice. A terminal action opens
a current Cases context—active/resulting status, exact assignee, or exact tag—through
a strict same-app route allowlist. It is not an exact retained cohort of every attempted
case ID. Use the job counts and bounded failures together with case history and Audit.

## Authority and audit

The model may recommend a verdict, but deterministic `case_manager.decide()` remains
the sole automatic close/escalate authority. Human bulk lifecycle actions use the
same guarded server action path as their single-case equivalents; re-investigation
uses the existing metered case route. UI eligibility is guidance only—the backend
rechecks permission and state for every requested case.

Every successful change is audited. Job admission, start, checkpoints, and terminal
outcomes are also attributable and reconciled before side effects continue. Execution
rechecks the authenticated actor's live grants; losing authority fails closed. A mixed
terminal result keeps successful changes and reports failed case IDs within the bounded
failure projection; it does not roll the successful work back or falsely report an
all-or-nothing transaction.

## When to use the legacy Cases page

Continue to use **Triage → Cases** when its table columns, saved views, or established
bulk workflow are a better fit. Opening a case from that table now hands the record
to Case Manager rather than opening a second legacy drawer, so evidence and actions
have one canonical detail implementation. Use Case Manager directly for continuous
queue-to-evidence work and its current selection actions. The list replacement path
is still gradual: parity is verified capability by capability before the Cases table
can be retired.

See [Cases](cases.md), [Investigation](investigation.md),
[Background jobs](../operations/background-jobs.md), and
[Deterministic decisions](../concepts/deterministic-decisions.md).
