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

With sign-in off, no work can be attributed to a person, so the page says "Sign-in is
off, so work cannot be attributed to people." instead of showing counts.

## Turn the page off

An administrator can turn the page off in **Settings → Single sign-on & policy → Team
activity** (the **Team activity page** switch, on by default). While it is off nobody
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
- **People**: one row per person with their counts, their reviews ("3 of 4 agreed"),
  their median time to acknowledge and when they were last active. Select a row to open
  that person's sheet. **Download CSV** saves the table as a spreadsheet; a name that
  starts like a formula is written as text.

### What each count means

| Count | What is counted |
|---|---|
| Acknowledged | An Acknowledge action on a case. |
| Closed | An action that moved a case to Closed (Close, Confirm false positive, or Set status to Closed), split by the disposition it was closed with: true positive, false positive, benign, duplicate or other. |
| Reopened, Escalated | The Reopen and Escalate actions. |
| Commented | A comment or a case thread message written by the person. |
| Assigned | An owner change the person made. |
| Screenshots added | A screenshot attached to a case. |
| Reviews | An auto-close review the person recorded: agreed, disagreed or unsure. |
| Runbook steps done | A runbook step the person marked done. |
| Sign-ins | A successful sign-in. |

Each count of acknowledged, closed, reopened, escalated and assigned cases also says how
many of its actions came from a bulk action (one action over many selected cases), so
one click on 200 cases does not read like 200 separate decisions.

**Median time to acknowledge** uses the same rule as the Metrics page: for each case
whose first acknowledgement by a person fell in the range, the time from the case being
detected (or created) to that acknowledgement, credited to whoever made it. It is
measured from up to 5,000 cases; with more, the page says the median was not measured
rather than guessing.

**Reviews** always read "N of M agreed", where M counts the reviews that agreed or
disagreed (an unsure review is not an answer). An agreement rate is added only from 30
answered reviews, because fewer would say more than the reviews can. The person sheet
also shows the median **time spent reviewing** (measured while the review card was open)
and, separately, the median **time to review** (from the case being picked for review to
the review).

## A person's sheet

The sheet shows the person's counts for the range, their closes by disposition and how
many came from bulk actions, their reviews, a table per day and their events, newest
first, with a link to each case. **Load more** reads the next 50 events. A viewer who can
read the Audit log also gets **Open in Audit log**, which opens that person's records.

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
  counts. The same caveat appears when the audit store can only be read in part.
- Answers are kept for 60 seconds, so an action may take up to a minute to show. Use
  refresh after that.
- Lifecycle and comment records are written just after the change they describe. If the
  audit store is down at that moment, the case changes but its record, and so its count
  here, is missing.
- Before this release, assignments and tag changes made from the Console were recorded
  without the person's name; they are counted under Not attributed.
- Demo Mode: the page counts the Demo work only (the seeded cases' acknowledgements,
  closes, comments, assignments and reviews), with real sign-ins, and says "Demo Mode:
  showing Demo work."
