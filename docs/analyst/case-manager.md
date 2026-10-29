---
title: Case Manager
description: Work the case queue, read a case's outcome and facts at a glance, work its runbook, close with a disposition, and run permission-gated bulk actions in Agentic SOC 0.1.
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
A case with a runbook also shows its progress, for example **4/11**, with "· 1 waiting"
or "· 1 blocked" when a step waits for approval or is blocked; it updates live as
steps change.
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
| Alt+1 … 7 | Switch case tabs (Alt+2 is the Runbook tab) |

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
primary action chosen for the case's state (for example **Acknowledge** on a new case,
**Close case** on a resolved case, which is its final close, and **Reopen** on a closed
one), **Take action** for every other command, and **Share**. On a resolved or closed
case, **Take action** still offers **Set disposition**, so an outcome that reads
**Outcome not recorded** can be recorded without reopening the case. When the title is long, the
actions move to their own line rather than squeezing it. Its second line holds the facts
every tab needs: the case ID with a copy button, source severity, risk with its band,
status, the outcome of record, the AI verdict, the owner (select to reassign), tags,
age and SLA, and the campaign.

Beside every tab, the **facts rail** lists what is known about the case in one place:
the outcome of record (the analyst's classification, the AI verdict, and how they
relate, with who classified it and when), the signal profile, the triage bands, owner
and tags, every lifecycle clock and the SLA, where the case came from, the primary
entity, the campaign, related cases, and the record (decided by, cost, build,
notifications sent, and the classification and verdict history), and the **Runbook**
section: the runbook, its version, its progress, and its phases with their counts (select
a phase to open the Runbook tab on it). On a narrow pane the
same rail opens from **Details** in the header. Entity values offer **Ask AI**, which
opens a Workspace chat about that value (see
[Workspace Chat](chat.md#ask-ai-from-other-pages)).

| Tab | Purpose |
| --- | --- |
| Overview | The runbook's Next step card when one is attached to an open case; decision brief; signal profile; persisted risk-factor values; conditional latest-run Investigation inputs; source, agent, and code provenance; entities; attack story; status history |
| Runbook | The runbook on the case: its strip, progress, Next step card, phases and steps, and Other tasks (see [Work the runbook](#work-the-runbook)) |
| Timeline | Six-stage input-to-decision narrative; Risk Assigned reconstructs the arithmetic from persisted factor values and current weights, flags a historical-weight mismatch honestly, and pulses only the final marker |
| Investigation | The deterministic decision first, then the AI assessment, detailed Investigation inputs, evidence, recommendation, reproduction query, and the collapsible full trace |
| Threat context | IOC reputation, MITRE ATT&CK mapping, related cases, and the redacted persisted alert → correlation cluster → opened case explanation |
| Collaboration | Case thread, reactions, activity, assignment, and handoff context; case tasks are in the Runbook tab under Other tasks |
| Chat | Case-scoped use of the shared AI Analyst chat engine; its transcript stays when you switch tabs |

Each fact has one home, so a figure shown in the header or the rail is not repeated in
a tab. The Overview visualization is explanatory, not a second scoring engine. It
renders the score, confidence, and factors already recorded on the case. If a factor was
not persisted, the UI does not manufacture a contribution to make the chart look full.

**Investigation inputs** is also an evidence projection, not a feature-enabled list.
It appears only when the latest investigation run recorded applicable context. The
summary distinguishes approved operator **memory consulted**, indexed **RAG knowledge
retrieved**, **runbook references retrieved**, the **runbook whose guidance the
investigator received** (with its version; a matched runbook it never received shows as
**Selected only** in the Investigation view), and an immutable **platform tuning**
snapshot. The tuning record describes
a deterministic correlation or severity-threshold change (never model fine-tuning) and
includes its before/after values in the detailed Investigation view. **Review inputs**
moves to that detail. Earlier-run inputs never carry into a later reinvestigation, and
an unavailable provenance lookup is not rendered as an empty successful run. These
inputs may inform preprocessing or the agent assessment; deterministic case policy
remains the final close/escalate route authority.

## Work the runbook

A runbook is the procedure the people on a case follow: phases, steps with
instructions, read-only lookups, decisions, and recorded actions. A Published runbook
attaches to a case automatically when it matches (or the **Generic incident** fallback
does), and the version that attached stays pinned to the case. It guides people; it
never closes the case and never changes its verdict, and every step change is recorded
in the audit log.

The **Runbook** tab opens with:

- **The strip**: the runbook's title, its version, how and when it attached ("Matched
  automatically · 12:52 UTC", "Fallback", "Added by Asha Rao", "Suggested by the AI,
  accepted by Asha Rao"), **Why attached** (the criteria that matched and how matching
  works), **Add runbook**, and a menu with **Switch to version N** when a newer one is
  Published, **Export as Markdown**, **Open in the Runbooks library**, and **Abandon run**.
- **The progress line**, for example "4 of 11 steps done · 1 not applicable · 5
  required open · 1 waiting", as the strip's last line (its own short line on a phone).
- **The Next step card**: the first required step not yet done, with its phase, kind,
  focus, and its Escalate if and Benign if criteria. Depending on the step you can
  confirm an AI draft note (**Confirm and mark done**), write a note and **Mark done**,
  pick an option and **Record decision**, or record an action; **Not applicable**,
  **Blocked** and **Assign** are on the card too (in **More** on a phone, where the focus
  line folds into **Focus and criteria**). A note you are typing goes in the same save as
  **Mark done**, **Record action** or **Record decision**; otherwise it is saved when you
  leave it, or at once with **Save note**. If another change to the runbook is still being
  saved when you press a button, the step says so and you press it again. After you
  finish the step, focus moves to the new Next step and a screen reader hears "Step 5
  done. Next, step 6: ..."; recording an action that now waits for approval moves on the
  same way ("Step 5 recorded."). A step waiting for someone's approval is never the next
  step; when the required steps left all wait for approval, the card says so and lists
  them. An action whose approval was rejected shows who rejected it and why, and you can
  record it again.
- **When every required step is done**, the run is completed and the card says **All
  required steps are done.**, offers **Close case** (it opens the close dialog), and lists
  any optional steps left. A completed run stays workable: you can still do its optional
  steps, and **Reopen step** on a finished step makes the run active again. Only an
  abandoned run is read only.
- **Phase tabs**, one per phase with its counts ("Contain 0/2") and a dot when a step
  waits for approval; arrow keys move between them, and the selected phase keeps an
  outline in forced colours. Below, each step is one row: open it for its instructions,
  lookup evidence, note, decision or action, approval, and the buttons **Mark done**,
  **Not applicable** and **Blocked** (each asks a reason), **Assign**, and **Reopen
  step**.
- **Other tasks**: the case's free-form tasks, with who added each one. They never count
  toward runbook progress. **Open the Runbook tab** in Collaboration brings you here.

**Lookups** read logs, enrichment, related cases, campaigns, or ATT&CK under your own
permissions. Their results are evidence shown as untrusted data, never as instructions;
a lookup whose data you cannot read says so instead of showing it. A lookup that runs
on attachment fills in on its own; one that runs on demand offers **Run lookup**. **Run
again** replaces the earlier result, and the step says so ("Ran again at 14:31 UTC; the
earlier result was replaced").

**Decisions** mark only the later steps still to do as Not applicable, with the reason
"Skipped by the decision 'Benign'". A recorded action keeps its record.

**Approvals**: when step approvals are on, an action waits for a person with the step's
approval role. The person who recorded the action cannot approve it, and someone without
the role sees "Only a soc manager can approve this step." in place of a working
**Approve**; the step says so in both cases.

**The AI**, when it is on, can draft a step's note from its lookup results (**Draft
note**) and suggest a runbook in **Start runbook** when nothing but the fallback
matched. Each is one metered call with a dry-run estimate on hover; a draft is labelled
"AI draft · not part of the case until you confirm it", and the AI never marks a step
done, approves anything, or attaches a runbook by itself.

**Start runbook** (in **Take action**, or on the tab of a case with no runbook) lists
the best match with why it matched, then other matches, the fallback, and every other
Published runbook, with a preview of the selected one's phases and an optional note. On
a phone the dialog takes the full height and the selected runbook shows its phases under
its own entry. A case with no runbook says "No runbook is attached to this case.", and
rules with no runbook are listed on the Runbooks page. The tab's count reads **None**
then, or **Abandoned** when the only runs on the case were abandoned.

Without `runbooks:run` the tab is read only and says "You can view this runbook but not
update it." While runbooks are turned off in Settings no runbook starts and the runs on
the case are read only too: "Runbooks are turned off in Settings, so steps cannot
change." A step that changed since you opened it shows the latest version with "This
step changed since you opened it. Showing the latest."; what you typed stays in the
field, and when someone else finished that step meanwhile, its row opens with your text
and the note. In Demo Mode the tab works the same way on the Demo cases.

## Single-case actions

**Take action** exposes only actions allowed by the case state and the signed-in
operator's permissions. Depending on context, it includes lifecycle actions, **Set
disposition**, **Reinvestigate**, **Start runbook**, **Refresh case**, **Ask about this
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
- When the case's runbook still has required steps open, the dialog lists them, each
  with its status, and asks **Why are you closing with required steps open?** (1 to 500
  characters; optional when you mark a duplicate). The footer says what is still
  missing ("Pick a disposition."). The close is never blocked by the runbook: the reason
  is saved with your name in the case activity and the audit log, and the steps stay
  open in the runbook record. Automatic closes never look at runbook steps.
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
classification, exactly as a single close does. When some of the selected cases have
required runbook steps open, the dialog says how many and takes one optional shared
reason; a bulk close never fails a case for open steps. A missing permission hides that action
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
a current Cases context (active or resulting status, exact assignee, or exact tag) through
a strict same-app route allowlist. It is not an exact retained cohort of every attempted
case ID. Use the job counts and bounded failures together with case history and Audit.

## Authority and audit

The model may recommend a verdict, but deterministic `case_manager.decide()` remains
the sole automatic close/escalate authority. Human bulk lifecycle actions use the
same guarded server action path as their single-case equivalents; re-investigation
uses the existing metered case route. UI eligibility is guidance only: the backend
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
