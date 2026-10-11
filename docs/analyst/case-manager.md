---
title: Case Manager
description: Work the case queue, read a case's outcome and facts at a glance, close with a disposition, and run permission-gated bulk actions in Agentic SOC 0.1.
---

# Case Manager

**Triage → Case Manager** keeps queue triage and case investigation in one screen.
The established **Cases** table remains available, no saved view is migrated
automatically, and opening Case Manager does not change a case. The two surfaces read
and mutate the same backend case records and audit trail. Opening a row or case deep
link from Cases shows a short announced **Taking you to Case Manager…** handoff, then
opens that exact case here. The `caseId` remains in the Case Manager URL so refresh,
browser history, and bookmarks preserve the selected record.

## The outcome of a case

Every case answers three different questions, and Case Manager never mixes them:

- **Status** says where the work is: Open, Investigating, Escalated, On hold, Resolved,
  or Closed.
- **The analyst's classification** says what the case was: true positive, false
  positive, benign, suspicious, duplicate, or undetermined.
- **The AI verdict** says what the assistant thought, with its confidence.

Once a person classifies a case, that classification is the headline everywhere the
case appears, for example **Closed as false positive**, with the AI's view kept as a
labelled second line, such as "AI verdict: Needs human review (75%)", and a note on
whether the analyst agrees with the AI, overrides it, or resolves the AI's hand-off. A
case counts as classified by a person only when its history records that person's
classification (setting a disposition, confirming a false positive, or closing or
resolving with a chosen disposition), not merely because it carries a disposition
value: the system derives a provisional disposition from the AI verdict at triage, and
that value is never shown as an analyst's call.

Until a person classifies it, the headline is the AI's assessment, attributed to the AI.
A case closed by the automatic close policy reads as auto-closed; a case closed under
an operator's "declared benign" rule policy reads **Declared benign**; and a case a
person closed without recording a classification reads **Outcome not recorded**. The
same rule drives the case header, the queue rows, the **Cases** list, hover cards, and
grading, so a case never reads differently in two places. The headline is display only:
the deterministic case policy still makes every automatic close or escalate decision.

## Queue scope and ordering

Choose **Active** for non-terminal work, **Mine** for active cases assigned to you, and
**All** to include resolved and closed records. Scope, status, severity, search, and
sort are answered by the server over every matching case, not by filtering a loaded
page in the browser, so an old open case is never missing from Active. The scope line
always states how many cases are loaded out of the exact total, and **Load more** pages
through the rest, 50 at a time.

The queue provides:

- search across the case ID and number, title, summary, status, AI verdict, entity,
  source, and assignee (every word you type must match);
- severity and status filters; the status filter lists every lifecycle state, with
  needs-human cases shown as **Open · awaiting analyst**;
- latest-updated, highest-risk, newest-created, and title ordering;
- manual refresh, plus live updates: a case that changes elsewhere updates its row, and
  a case that no longer matches the view leaves it.

Each row shows the case's outcome headline, its status, severity, risk, owner, and age.
Selecting a row opens the case in the workspace without leaving the queue, and switching
cases never blanks the pane: the new case shows at once from its row and fills in as the
full record arrives. On a narrow viewport, the queue is the complete first screen and
the case workspace opens after selection.

## Keyboard

The queue is one tab stop. Press **?** in the queue for this list:

| Keys | Action |
|---|---|
| ↑ ↓ or K J | Move through the queue and open the case |
| Home, End | First or last loaded case |
| X or Space | Select or clear the focused case |
| Shift+↑ ↓ or Shift+X | Extend the selection |
| Enter | Move focus into the open case |
| Esc | Clear the selection |
| / | Search the queue |
| A, C, E, H | Acknowledge, close, escalate, or hold the open case |
| R | Reinvestigate the open case |
| M, T | Change the owner or edit tags |
| Alt+1 … 6 | Switch case tabs |

Shortcuts never fire while you type in a field, and an action you lack the permission for
does nothing. After a dialog closes, focus returns to the control or row that opened it.

## Resize the desktop split

At desktop width, drag **Resize case queue** between the queue and detail panes.
Keyboard users can focus the divider and use Left/Right Arrow in 24-pixel steps,
Shift+Arrow in 48-pixel steps, Home/End for the allowed minimum/maximum, or
double-click to reset. The queue defaults to 400 px, stays between 320 and 680 px,
and never consumes the detail pane's 560 px minimum. The chosen width is stored in
this browser. Below the desktop breakpoint, the selected detail replaces the queue
and the **Cases** back control returns to it instead of exposing a resize handle.

## Read the workspace

The case header stays in view while you scroll. Its first line holds the title and one
primary action chosen for the case's state (for example **Acknowledge** on a new case),
**Take action** for every other command, and **Share**. When the title is long, the
actions move to their own line rather than squeezing it. Its second line holds the facts
every tab needs: the case ID with a copy button, source severity, risk with its band,
status, the outcome of record, the AI verdict, the owner (select to reassign), tags,
age and SLA, and the campaign.

Beside every tab, the **facts rail** lists what is known about the case in one place:
the outcome of record (the analyst's classification, the AI verdict, and how they
relate, with who classified it and when), the signal profile, the triage bands, owner
and tags, every lifecycle clock and the SLA, where the case came from, the primary
entity, the campaign, related cases, and the record (decided by, cost, build,
notifications sent, and the classification and verdict history). On a narrow pane the
same rail opens from **Details** in the header. Entity values offer **Ask AI**, which
opens a Workspace chat about that value (see
[Workspace Chat](chat.md#ask-ai-from-other-pages)).

| Tab | Purpose |
| --- | --- |
| Overview | Decision brief; signal profile; persisted risk-factor values; conditional latest-run Investigation inputs; source, agent, and code provenance; entities; attack story; status history |
| Timeline | Six-stage input-to-decision narrative; Risk Assigned reconstructs the arithmetic from persisted factor values and current weights, flags a historical-weight mismatch honestly, and pulses only the final marker |
| Investigation | The deterministic decision first, then the AI assessment, detailed Investigation inputs, evidence, recommendation, reproduction query, and the collapsible full trace |
| Threat context | IOC reputation, MITRE ATT&CK mapping, related cases, and the redacted persisted alert → correlation cluster → opened case explanation |
| Collaboration | Case thread, reactions, activity, tasks, assignment, and handoff context |
| Chat | Case-scoped use of the shared AI Analyst chat engine; its transcript stays when you switch tabs |

Each fact has one home, so a figure shown in the header or the rail is not repeated in
a tab. The Overview visualization is explanatory, not a second scoring engine. It
renders the score, confidence, and factors already recorded on the case. If a factor was
not persisted, the UI does not manufacture a contribution to make the chart look full.

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

**Take action** exposes only actions allowed by the case state and the signed-in
operator's permissions. Depending on context, it includes lifecycle actions, **Set
disposition**, **Reinvestigate**, **Run a playbook**, **Refresh case**, **Ask about this
case**, **Change owner**, **Edit tags**, open-in-new-tab, JSON export, Markdown report
export, and **Notify**. Destructive or billable operations require their existing
confirmation; server-side transition and authorization checks remain authoritative.

### Close or resolve with a disposition

Closing or resolving a case always records what the case was. The dialog lists the
dispositions as cards with a one-line definition each (press 1–6 to pick one); none is
chosen in advance, so the choice is always yours, not a copy of the AI verdict. The
dialog shows the AI verdict for reference, takes an optional note and, where it
applies, a resolution and grading of the AI's work. Its buttons stay in view however
long the form is.

- **Close & next** (or **Resolve & next**) records the outcome and opens the next case
  in the queue.
- After a close or resolve, a notice confirms the recorded outcome ("Closed as false
  positive.") with **Reopen** for eight seconds. Reopening keeps the outcome you
  recorded on file until you close the case again with a new one, so to correct a
  misclick, reopen and close it again with the right disposition.

## Select cases and run bulk work

Use a row checkbox (or X, or Space) for an individual case. **Select all visible**
selects the loaded rows that match the current view; when more cases match than are
loaded, **Select all N matching** takes a snapshot of every matching case from the
server, up to 5,000. The row checkbox is separate from row navigation, so selecting
never opens a case. Changing search, filters, sort, or scope does not silently discard
hidden selections. Use **Clear case selection** (or Esc) to clear everything. The bulk
toolbar is shown only while at least one case is selected; rows being changed by bulk
work show their progress.

| Action | Permission | Input and behavior |
| --- | --- | --- |
| Close… | `cases:close` | A disposition is required, with an optional resolution and note; closes each selected case |
| Resolve… | `cases:close` | A disposition is required, with an optional reason and note; uses the analyst `resolve` action |
| Acknowledge | `cases:write` | Confirmation; sends `acknowledge` for every selection and moves each eligible case to Investigating |
| Assign | `cases:assign` | Analyst or team; changes owner without changing lifecycle status |
| Add tag | `cases:write` | Appends one non-empty tag while preserving and de-duplicating existing tags |
| Set status | `cases:write` | Choose Open, Investigating, On hold, or Escalated; the server validates each transition |
| Set disposition | `cases:write` | Choose True positive, False positive, Benign, Suspicious, Duplicate, or Undetermined without closing the case |
| Reinvestigate | `cases:reinvestigate` | Confirmation warns that each case reruns the full metered AI pipeline and may change verdict, confidence, and status |

A bulk close or resolve records the chosen disposition on every case as that analyst's
classification, exactly as a single close does. A missing permission hides that action
rather than leaving an unusable menu item. In Demo Mode, bulk changes are unavailable
because they run as background jobs, which Demo Mode does not run; open a case to change
it.

The Console does not execute these selections as a browser-owned per-case loop.
Close, Resolve, Acknowledge, Set status, and Set disposition submit a `case_lifecycle`
job; Assign submits `case_assign`; Add tag submits `case_tag`; and Reinvestigate submits
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

Agreement statistics in grading and analytics count only grades that compare the
analyst's judgement with an AI verdict. Settling a needs-human hand-off, closing a
duplicate, or classifying a case with no AI verdict is recorded as feedback but is not
counted as agreement or disagreement.

## When to use the Cases page

Continue to use **Triage → Cases** when its table columns, saved views, or established
bulk workflow are a better fit. Opening a case from that table hands the record to Case
Manager rather than opening a second drawer, so evidence and actions have one canonical
detail implementation. Use Case Manager directly for continuous queue-to-evidence work.

See [Cases](cases.md), [Investigation](investigation.md),
[Background jobs](../operations/background-jobs.md), and
[Deterministic decisions](../concepts/deterministic-decisions.md).
