---
title: Case collaboration
description: Coordinate analysts with case ownership, discussion, activity, and tasks.
---

# Case collaboration

The **Collaboration** tab keeps human coordination beside the evidence and decision it
concerns. Collaboration data is case state; it does not alter the deterministic
close policy.

## Ownership, tags, and comments

- Assign a case to an analyst or team so the queue has a visible owner.
- Add short tags for routing and review. Tags are deduplicated and bounded.
- Use a case comment for a simple note that should appear in exports.
- Use the threaded discussion for replies, reactions, and mentions.

Assignment requires `cases:assign`. Comments and thread mutations require
`cases:comment`. Editing or deleting a thread message is limited to its author or an
authorized moderator.

## Threaded discussion

Messages identify their author as human, AI, or system. Replies preserve their
thread relationship; reactions are recorded separately. Mention notifications are
delivered to the in-app inbox when applicable.

Keep messages factual and attributable. Source-derived strings remain untrusted
data even when pasted into a discussion.

## Tasks

Case tasks live on the **Runbook** tab, under **Other tasks**, beside the case's runbook
steps; **Open the Runbook tab** in Collaboration takes you there. Each task shows who
added it and when, and tasks never count toward runbook progress. Use tasks for work
that needs an owner or a visible completion state and is not a runbook step:

1. Add a concise task with its assignee and context.
2. Update its state as work progresses.
3. Add task log entries for material results or blockers.
4. Close the task only when the work is complete.

Creating, editing, and logging tasks requires `cases:write`.

## Activity and audit

The case activity stream brings collaboration events into one chronological view,
newest first. Each row reads as one plain sentence, with the system's internal names
shown as names ("Case manager") rather than codes; the text exactly as the audit log
recorded it is one click away under **Details**. **Show activity by** filters the stream
to **All**, **Human**, **AI** or **System**. While an investigation is running, its
steps appear above the stream as they happen; they are a live narration, not part of the
record. Lifecycle changes also remain in the case's append-only status history. The platform
audit log is the authority for privileged or state-changing actions; the discussion
thread is not a substitute for it.

## Shift handoff

Use **Overview → Standup** to review the urgency-ranked attention queue, SLA pressure,
workload by assignee, and action items. Analysts with `cases:write` can create and
update handoff actions and acknowledge the report.

See [Cases](cases.md) for lifecycle work and [Analytics](analytics.md) for timing and
workload definitions.
