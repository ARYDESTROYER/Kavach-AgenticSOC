---
title: Team activity
description: See what each person on the SOC team did, per day, counted from the audit log.
---

# Team activity

**Team activity** shows what each person did, per day: the cases they acknowledged,
closed, reopened and escalated, their comments, assignments and screenshots, the
auto-close reviews they completed, the runbook steps they finished and their sign-ins.
Open **Analytics → Team activity** (`#/team`). Every count comes from the audit log, so
it is the same record the **Audit log** page reads.

The page is meant for the person who runs the team. It shows counts with their context
and nothing else: there is no ranking, no "top performer" and no score. The table is
ordered by name, and you can sort any column.

## Who can open it

Reading the page needs the `team:view` permission. A **SOC manager** holds it by default
so they can track the team, and an **Auditor** holds it so they can read it. Analysts
and responders do not. A Super admin holds every permission.

While role-based access is off, every signed-in account is treated as a Super admin and
so holds every permission. Team activity is stricter: until role-based access is on,
only an account whose role is Super admin, SOC manager or Auditor can open it, and the
page shows a warning that says so with a link to **Roles & permissions**. Anyone else
who opens the page is refused, and the refusal is written to the audit log.

This limit applies to this page only and is not an access control. While role-based
access is off, every account still holds `audit:view` and `users:manage`, so it can read
the same rows in the [Audit log](../administration/audit-log.md), or change its own role
to SOC manager or Auditor (an audited `user.role_changed` row) and then open the page.
Turn on role-based access to keep per-person work private.

With sign-in off, no work can be attributed to a person, so the page says "Sign-in is
off, so work cannot be attributed to people." instead of showing counts.

## Turn the page off

An administrator can turn the page off in **Settings → Security & access → Single sign-on
& policy → Team activity** (the **Team activity page** switch, on by default). While it is off nobody
can open the page, and the page names the switch. The setting is saved with the rest of
the page and its change is written to the audit log.

## Read the page

The header holds the range: **Today**, **Yesterday**, **Last 7 days** or **Last 30
days**, or a **Custom range** of whole days, at most 92 of them. A day is a calendar day
in the operator time zone (the time zone of the SLA policy, set in Settings); the help
tip beside the title names it. Last 7 and 30 days count today and the days before it
from local midnight.

Below the header:

- **One strip of figures**: people active (anyone with at least one counted action or
  sign-in in the range), cases closed by people, cases acknowledged, auto-close reviews
  completed, and the median time to acknowledge.
- **Work per day**: the team's case work for each day of the range, stacked by kind:
  closed, acknowledged, commented, reviewed, escalated, reopened and other case work
  (assignments, screenshots and runbook steps). Sign-ins are not case work and are not
  drawn. A range with no case work shows "No case work in this window".
- **People**: one row per person with their name and role, their counts of the chart's
  kinds (closed, reviews, acknowledged, commented, escalated, reopened and other) and when
  they were last active ("Not in window" when nothing of theirs was counted in the range).
  A count with nothing in it reads 0. Point at a reviews count to see how many agreed
  ("3 of 4 agreed"). Their sign-ins, each kind inside **Other** and their median time to
  acknowledge are on the person's sheet and in the CSV. Select a row to open that
  person's sheet. **Download CSV** saves every count as a spreadsheet; a name that starts
  like a formula is written as text.

### What each count means

| Count | What is counted |
|---|---|
| Acknowledged | An Acknowledge action on a case. |
| Closed | An action that moved a case to Closed (Close, Confirm false positive, or Set status to Closed), split by the disposition it was closed with: true positive, false positive, benign, duplicate or other. |
| Reopened, Escalated | The Reopen and Escalate actions. |
| Commented | A comment or a case thread message written by the person. A thread message labelled as the AI's or the system's is not counted. |
| Assigned | An owner change the person made, on its own or as part of another action (the owner set in the Escalate dialog). |
| Screenshots added | A screenshot attached to a case. |
| Reviews | An auto-close review the person recorded: agreed, disagreed or unsure. Each case counts once per person: a later review of the same case replaces their earlier one. |
| Runbook steps done | A runbook step the person marked done. |
| Sign-ins | A successful sign-in. |

A screenshot, a review or a runbook step whose save failed after its audit record was
written is not counted: the Audit log shows that record as "Not applied (see the next
record)", and this page leaves it out of the counts and the person's events.

Each count of acknowledged, closed, reopened, escalated and assigned cases also says how
many of its actions came from a bulk action (one action over many selected cases), so
one click on 200 cases does not read like 200 separate decisions.

**Median time to acknowledge** uses the same rule as the Metrics page: for each case
whose first acknowledgement by a person fell in the range, the time from the case being
detected (or created) to that acknowledgement, credited to whoever made it. The first
acknowledgement is the Acknowledge action or, for a case nobody acknowledged, the first
time a person moved it to Investigating, Escalated or On hold (an Escalate or a Put on
hold, for example). It is measured from up to 5,000 cases; with more, the page says the
median was not measured rather than guessing.

Point at a figure on the strip, or select it, to see how it was counted. The median's
explanation lists the times it is taken from, shortest first, and works the median from
them: with two times of 2m and 12m it reads "(120 + 720) / 2 = 420 seconds, shown as
7m". With many cases it lists the times around the middle, with their ranks. **People
active** names each person it counted and what they did. A sign-in counts as activity,
so a person who only signed in is active even though the people table's case work
columns show nothing for them.

**Reviews** always read "N of M agreed" on the strip, the person sheet and a reviews
count's hover title, where M counts the reviews that agreed or disagreed (an unsure review is not an answer). An agreement rate is added only from 30
answered reviews, because fewer would say more than the reviews can. A case that was not
picked for review can be reviewed again; only the person's latest review of a case counts,
so the 30 are 30 different cases, and an earlier review shows in their events as
"Replaced by a later review of this case". The person sheet
also shows the median **time spent reviewing** (measured while the review card was open)
and, separately, the median **time to review** (from the case being picked for review to
the review).

## A person's sheet

The sheet shows the person's counts for the range, their closes by disposition and how
many came from bulk actions, their reviews, a table per day and their events, newest
first, with a link to each case. **Load more** reads the next 50 events. A viewer who can
read the Audit log also gets **Open in Audit log**, which opens that person's records.

The table per day has the same kinds as **Work per day**, so its **Other** is the same
assignments, screenshots and runbook steps. Its days and the event times are both in the
operator time zone, which the sheet names, so an event is listed on the day it is
counted on.

An event names what was done ("Closed a case"), the case and a short detail built from
the record's structured fields: the disposition, the actions taken and a review's answer.
Free text from a record (a reason a person typed) is not shown here.

## Who appears on the page

- **Accounts**: every active account appears, with zeros when it did nothing in the range.
- **Environment account**: an account set in the deployment's environment, with no
  saved user record (the environment administrator, for example).
- **Demo analyst**: one of the Demo SOC team, while Demo Mode is on.
- **Deleted account**: a name the audit log holds for an account that no longer exists.
  Its history stays, because the audit log is never changed.
- **Not attributed**: work recorded before sign-in attribution, or with sign-in off, when
  the record names no person ("analyst", "default" or nobody). It is listed last and has
  no events.

People are matched without regard to letter case, so "Admin" and "admin" are one person.

## Privacy

The page never shows an IP address, a browser, a session or a settings change: those stay
in the Audit log, which needs `audit:view`. The counts are kept as long as the audit log
keeps its records. Opening the page writes one **Team activity viewed** record per viewer
every 10 minutes, and opening a person's events one per viewer and person, so the audit
log shows who looked at whose work. Nothing on this page is ever sent to an AI model, and
nothing here changes a case or the automatic close or escalate decision.

## Limits

- A range holds at most 92 days.
- One read counts at most 250,000 audit rows. A busier range shows "Counts are lower
  bounds" and the counts are at least the figures shown; choose a shorter range for exact
  counts. The same caveat appears when the audit store can only be read in part. A median
  or a rate of part of the range is not a lower bound, so the median time to acknowledge,
  the agreement rate and the review times then read "not measured", and a downloaded CSV
  ends with a line that says the read was partial.
- Answers are kept for 60 seconds, so an action may take up to a minute to show. Use
  refresh after that.
- Lifecycle and comment records are written just after the change they describe. If the
  audit store is down at that moment, the case changes but its record, and so its count
  here, is missing.
- Before this release, assignments made from the Console were recorded without the
  person's name; they are counted under Not attributed. Tag changes are not counted on
  this page.
- Demo Mode: the page counts the Demo work only (the seeded cases' acknowledgements,
  closes, comments, assignments and reviews), with real sign-ins, and says "Demo Mode:
  showing Demo work."
