---
title: Auto-close review
description: A small random sample of the cases the AI agent closed automatically goes to a person, whose answer is kept as independent ground truth.
---

# Auto-close review

The AI agent closes some cases automatically when its verdict clears the auto-close bars
(see [Deterministic decisions](../concepts/deterministic-decisions.md)). Nobody looks at
those cases by default, which is the point of closing them, but it also means nobody
checks them. The **auto-close review** sends a small, random, capped sample of them to a
person to classify. The answer is recorded as independent ground truth, and the case
itself stays exactly as the decision left it unless that person reopens it.

## How cases are picked

Picking happens once, right after the agent closes a case and after every other step
that follows a decision (runbook attachment, automation, the knowledge index and
notifications). Only a case the agent closed automatically is considered: a case routed
to a person, a case closed by an analyst rule policy, and a case whose first decision
was not an automatic close are never picked.

- **A fixed score per case.** Each case gets a score from 0 to 1 computed from its
  case id, which the server creates. The same case always gets the same score, and
  nothing in an alert can steer it. A case is picked when its score is below the share
  you set.
- **A daily cap.** At most this many cases are picked in one day, counted in the SLA
  time zone (Settings, SLA, priority and suppression).
- **A cap per rule.** At most this many cases of one detection rule are picked in a day,
  so one noisy rule cannot fill the day's sample.
- **Once per case.** A case is picked at most once while its entry is kept. The record
  keeps the 2,000 newest picked cases; after an old entry is dropped, a case that is
  reopened and closed again could be picked again.
- **No backfill.** Picking starts with the first automatic close after an upgrade.

Every pick writes an **Auto-close review requested** row to the audit log in Agent
activity, with the score, the share, the day's counts and the rule. If the audit log or
the review record cannot be written, the case is not picked and nothing about the case
changes.

## Settings

Open **Settings → Detection** and find **Auto-close review**, beside the auto-close bars.
Changing it needs `settings:manage`.

| Setting | Default | Range |
|---|---|---|
| Send automatic closes for review | On | On or off |
| Share of automatic closes picked | 5% | 0 to 50% |
| Most picked in a day | 10 | 0 to 200 |
| Most of one rule in a day | 3 | 1 to 50 |
| Days before a review expires | 7 | 1 to 30 |

A value outside its range is refused when you save it. An expired review is still shown
and can still be recorded; it only stops counting as pending.

## Reviewing a case

Picked cases wait in the Case Manager's **Review** scope, with the number still pending
beside it. A picked case shows a band under its header: "Picked at random for auto-close
review. Classify it yourself, then compare with the AI." Choose **Start review**.

1. **What was it?** Choose True positive, False positive, Benign or Unsure. Nothing is
   chosen for you.
2. Add a note if you like. The note is kept as precedent for future investigations,
   like any grading comment, and is always treated as untrusted text.
3. Optionally rate the AI's accuracy, reasoning and recommended action.
4. Choose **Compare with the AI**. Only now does the card show the AI verdict and whether
   your answer agrees with it. Your answer is locked from this point.
5. Choose **Record review**.

The card measures the time from opening it to recording the review, so a manager can see
reviews that took seconds. It is not a full blind review: the rest of the case page still
shows the AI verdict.

You can also review an agent-closed case that was not picked, with **Review this
auto-close** in **Take action**. That review is recorded as an ordinary grade.

Recording a review needs `cases:write`. It never changes the case's status, who decided
it or its disposition. Each case in the sample can be reviewed once; a second attempt
answers that the review is already recorded.

## When you disagree with the AI

The review is always recorded. What happens next depends on your permissions:

- With `cases:close` you are offered **Reopen case** and **Reopen and escalate**. The
  second is two steps; if the escalation fails, the case stays reopened and the card
  says so. Nothing is ever reopened automatically.
- Without `cases:close` the card says "Someone who can close cases has been asked to look
  at this." Each person who can close cases gets one Inbox item in the Assignment
  category (at most 200 people). Someone who turned Assignment off in their Inbox
  settings gets none.

## What a review feeds

A review grade is independent ground truth. It is used by:

- the analyst-confirmed outcome of the case;
- the threshold tuner;
- the precedent corpus (a false positive review can therefore help promote precedent;
  a true positive review makes the rule's precedent conflicting, which blocks promotion);
- the ground-truth supply figures.

It is kept out of the views that measure agreement with the AI agent, because the sample
is drawn only from automatic closes and would shift those views without any change in
the agent:

- the analyst feedback quality figures on Metrics;
- the observed-outcome comparisons on Agent effectiveness;
- the agent reopen rate, for a reopen made from the review card of a case in the sample.

The grade is marked in two places, the grade itself and a history event on the case, so
it is recognised even after a rollback to an older build drops the grade's own marker.

## Where the results show

- **Agent effectiveness** has an **Auto-close review** module for the page's range: how
  many cases were sampled, reviewed, pending and expired; how many reviews agreed with
  the AI ("N of M agreed"); an agreement rate with its 95% interval once there are at
  least 30 reviews, and "Not enough reviews yet" before that; the threats reviewers found
  (they said true positive on an automatic false positive close), with links to the
  cases; the rules sampled most; the median time spent reviewing and the median time from
  picked to reviewed; and how many automatic closes there were, by the day of their first
  decision. It always says: "Agreement describes the sampled cases only, unweighted. It is
  not an estimate of auto-close precision." The daily caps mean each day's cases are not
  equally likely to be picked, so no rate here describes every automatic close.
- **Case Manager**: the Review scope (pending, with links to completed, disagreed and
  expired reviews), and the review's result in the case's Outcome facts
  ("Reviewed: false positive", "Review disagreed: true positive").
- **Team activity** counts the reviews each person completed, with how many agreed and
  the time they spent.
- The **audit log** has an **Auto-close review recorded** row per review, by the person
  who recorded it. Its summary carries ids and codes only, never the note.

## Demo Mode

In Demo Mode the sample, the reviews and their audit rows live in the Demo stores and are
gone when Demo Mode ends. A fresh Demo starts with six picked cases: three pending, two
reviewed and agreeing, and one reviewed and disagreeing, by the Demo analysts.

## Data, reset and export

The review record is one document in the application's own state, with no new index,
table or migration. A cases reset empties it, a factory reset removes it, and the data
export lists every entry (ids, the rule, times, states and the review's answer; the note
stays on the case's grade).

A rollback to an older build resets the five review settings to their defaults when the
older build saves its settings.

## Related pages

- [Deterministic decisions](../concepts/deterministic-decisions.md)
- [Tuning and baselines](tuning-baselines.md)
- [Analytics and standup](../analyst/analytics.md)
- [Permissions](../reference/permissions.md)
