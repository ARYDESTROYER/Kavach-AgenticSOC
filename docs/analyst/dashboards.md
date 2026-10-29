---
title: Dashboards
description: The Dashboards library, the four built-in boards, every module and headline figure, and the boards you build yourself.
---

# Dashboards

The Console still opens on the **Cyber Defence Center** after you sign in, and
**Overview → Cyber Defence Center** in the navigation returns to it. Pressing the
**Overview** row itself, or **Overview → Dashboards**, opens the **Dashboards library**:
every board you can open, in two sections.

- **Built-in**: the Cyber Defence Center and three boards made for a role and a
  question. They are read-only and update with each release. Duplicate one to make it
  your own.
- **Yours**: the boards you made, starting with **My dashboard**, and a dashed
  **New dashboard** tile.

Dashboards only read. They never change a case, never decide whether a case closes, and
never call a model: every figure comes from the same read-only rollups the rest of the
Console uses, so opening a board costs nothing.

## The library

Each card is one link. It shows an outline of the board's layout (the headline strip as
a thin line, each module as an empty box), a badge, the time window the board opens on,
the board's name, the question it answers and who it is for.

| Card | Badge | Window | The question it answers | For |
|---|---|---|---|---|
| Cyber Defence Center | Default | Last 24 hours | The landing page: alert flow, case state and response time right now. | Everyone |
| SOC operations | Built-in | Last 24 hours | Is the team keeping up today? | SOC managers and shift leads |
| Detection and data health | Built-in | Last 7 days | Are we seeing everything, and are the detections any good? | Detection engineers and platform admins |
| Executive summary | Built-in | Last 30 days | Are we safer and faster than last month, and what does automation cost? | The CISO and leadership |

Your own cards show the badge **Yours**, when the board was last edited ("Edited 3 days
ago"; hover for the exact time) and how many widgets it holds. Until you save it,
My dashboard reads "4 widgets · your role default".

A card that says "2 panels need permissions your role does not have." holds panels your
role cannot read; the board still opens and shows each of those panels as "No access"
(with row-level data scope on, a panel built from case data says "Hidden while row-level
scope is on." instead). On a board of your own those panels stay where they are: saving
the board keeps them, so they show again when your role can read them. A built-in board
none of whose panels your role can read is not listed. Opening the library needs the
`metrics:view` permission, the same one every dashboard needs; without it the page says
"You do not have access to dashboards." and the **Overview** row opens the Cyber Defence
Center instead.

### Hide a built-in board

Open the board, open its **More** menu and choose **Hide from my list**. You return to the library and
a notice offers **Undo**. Hidden boards are left out of the Built-in section; **Show 1
hidden** beside the section title brings them back into view with a **Hidden** badge and
an **Unhide** button in each card's foot. The Cyber Defence Center cannot be hidden.
Hiding is personal: it changes only your own list, and each hide or unhide is recorded in
the audit log.

## Open a board

A board opens at its own address (`#/dashboards?board=...`), so you can bookmark it or
share the link, and the browser's Back button returns to the library. The top bar reads
**Agentic SOC / Dashboards / SOC operations**; its **Dashboards** segment and the
**All dashboards** link above the board's title both return to the library.

The board's header holds:

- its name, its badge and a help tip (**?**) that says who the board is for and what it
  answers;
- the **time range**: Last 24 hours, Last 7 days, Last 30 days or Last 90 days. Each
  board opens on its own window; changing it reads every panel again for the new window,
  and the headline comparisons follow ("vs prior 7d"). There is no custom range, because
  every board figure is computed over a whole window;
- **Refresh**, which reads every panel again now. A board also refreshes itself every
  minute while its browser tab is visible;
- the board's actions: **Duplicate to customise** and **More** on a built-in board,
  **Edit** and **More** on your own.

Each panel loads, fails and retries on its own. A panel whose source cannot say
something shows why ("MTTA is not available: no case has been acknowledged yet", "Not
measured") instead of a zero, and a figure the source could only bound reads "at least"
or "about". A panel that could not refresh keeps its last figures and says when they
were loaded.

In Demo Mode every board reads the Demo data, and the figures change when Demo Mode
starts, resets or ends. With row-level data scope on, panels built from case data show
"Hidden while row-level scope is on." and read nothing.

## The built-in boards

### SOC operations

For SOC managers and shift leads, over the last 24 hours, compared with the 24 hours
before.

| Module | What it shows | Leads to |
|---|---|---|
| Headline strip | Open now, Awaiting a decision, Unassigned, SLA breached, New cases, Closed (see [Headline figures](#headline-figures)) | |
| Arrivals and closures | New cases and closures by the AI agent and by a person, hour by hour; the AI agent in blue and a person in orange | View cases |
| Human vs AI | Who closed the window's cases: the AI agent, a person or the system | |
| Needs attention now | Open cases with a breached target first, then the most urgent | View queue |
| Analyst workload | Open cases per analyst, with the unassigned queue | View assignments |
| Backlog aging | Open cases by how long they have been open: under 1 hour, 1 to 4 hours, 4 to 24 hours, 1 to 3 days, 3 to 7 days, over 7 days | View open cases |
| SLA breaches and at risk | Cases past or near their response and resolve targets | View in Standup |
| Open cases by status | The open stock by status | View cases |
| Response timing | Time to detect, acknowledge and resolve, and dwell time, each as p50 with its p90 and the number of cases counted | View performance |

### Detection and data health

For detection engineers and platform admins, over the last 7 days.

| Module | What it shows | Leads to |
|---|---|---|
| Headline strip | Sources reporting, Silent sources, Events per minute, Alerts ingested, Alert reduction, Techniques seen | |
| Alerts and cases over time | Raw alerts and the cases they became, on one day axis | View logs |
| Noise reduction | Raw alerts reduced to cases and outcomes over the window | Open the flow |
| Top detection rules | The rules behind the most cases in the window. A rule can count for several cases and a case for several rules, so the rows do not add up to the case total. Select a rule name to open its picture. | View cases |
| Noisiest rules | Rules above the false-positive target, with their tuning state | Open Auto-tuning |
| Connector health | Each source with its events per minute, its last event and its state | View sources |
| Cases by source | The window's cases by the source that raised them | View cases |
| Techniques seen in cases | ATT&CK tactic by technique for the cases in the window. This is what the cases showed, not detection coverage. | View coverage |
| Top techniques | The techniques seen on the most cases | View coverage |
| Auto-close health | How many cases the agent closed on its first decision, against the window before | View effectiveness |
| Telemetry gaps | Data the detections asked for that no source sent, from query evidence | Open Auto-tuning |

### Executive summary

For the CISO and leadership, over the last 30 days, compared with the 30 days before.

| Module | What it shows | Leads to |
|---|---|---|
| Headline strip | Cases, Confirmed threats, MTTD p50, MTTR p50, Closed by the AI agent, SLA attainment | |
| Cases by severity over time | Case counts stacked by severity level, day by day (hour by hour on a 24-hour window) | View cases |
| Active risk index | The mean risk of the open cases; 74 and above is critical | View open cases |
| Outcomes over time | The AI verdicts of the window's cases, week by week. The caption names the family it shows ("AI verdicts"), and it never mixes AI verdicts with analyst outcomes. | View effectiveness |
| Human vs AI | Who closed the window's cases | |
| Top ATT&CK techniques | The five techniques seen on the most cases | View coverage |
| Cases by source | The window's cases by source | View cases |
| AI spend | Model spend in the window, the part spent by chat (which sits outside the budget), the budget used, and the spend per investigated case. Shown only to roles with `cost:view`. | View cost |
| Active campaigns | Groups of related cases that share entities | View campaigns |
| Agent quality | How often analysts agreed with the agent, against the weeks before | View effectiveness |

No board shows an "analyst hours saved" figure: the Console has no honest way to measure
one.

## Headline figures

Each board's headline strip shows six figures. Point at the **?** beside a figure for
its definition. A figure your role cannot read shows "No access"; a figure its source
could not measure shows "Not measured" with the reason, never 0. "Open now" figures are
a stock read across all time, whatever the window says.

| Board | Figure | What it counts |
|---|---|---|
| SOC operations | Open now | Cases not closed or resolved right now. |
| | Awaiting a decision | Open cases whose AI verdict is Needs human. |
| | Unassigned | Open cases with no assignee. |
| | SLA breached | Open cases past their response or resolve target. |
| | New cases | Cases created in the window. |
| | Closed | Cases created in the window that are now closed or resolved. |
| Detection and data health | Sources reporting | Enabled sources that sent at least one event in the window. |
| | Silent sources | Enabled sources the silent-source detector flags. |
| | Events per minute | Mean events per minute over the measured part of the window, from the poller's tallies. |
| | Alerts ingested | Raw alerts counted in the window. |
| | Alert reduction | Share of raw alerts that did not become a case. |
| | Techniques seen | ATT&CK techniques on at least one case in the window (never detection coverage). |
| Executive summary | Cases | Cases created in the window. |
| | Confirmed threats | Cases an analyst confirmed as true positives. Closes by an analyst policy are left out, and the AI verdict is never used. |
| | MTTD p50 | Median time from the first event to case creation. |
| | MTTR p50 | Median time from case creation to resolution. |
| | Closed by the AI agent | Cases whose first terminal decision was the agent's automatic close. A later human acknowledgement does not move it. |
| | SLA attainment | Share of scored cases that met their targets; "Not measured", with the reason, when nothing was scored. |

The spend per investigated case on the AI spend panel divides the investigation spend
(the router and investigator calls of the case pipeline) by the cases the agent
investigated in the window. Chat, standup and report spend are left out.

The [KPI glossary](kpi-glossary.md) explains the figures the Cyber Defence Center shows.

## Duplicate a built-in board

**Duplicate to customise** asks "Duplicate SOC operations?" and offers a name ("SOC
operations (copy)", 1 to 120 characters). The copy:

- holds every panel, its position and the board's default window (here, the last 24
  hours);
- leaves out the panels your role cannot read;
- is yours: it opens in Edit mode, does not update with new releases, and its help tip
  says which board it was copied from. The built-in board stays as it is.

You can hold up to 24 dashboards. At the limit the dialog says "You have 24 dashboards,
the most allowed. Delete one to add another." and cannot be confirmed; **New dashboard**
is turned off and the dashed tile says the same. A board that is not stored yet (a new
draft, or My dashboard before its first save) would add one more, so at the limit its
**Save dashboard** is turned off with the same sentence, and **Rename** says the same and
cannot be confirmed.

## Your own boards

**My dashboard** is your personal board. Until you save it, it shows the default layout
for your role. A board you saved before this release under the name "Overview" now
reads "My dashboard", and the next save stores the new name.

- **New dashboard** (the header button or the dashed tile) opens an empty board named
  "Untitled dashboard" in Edit mode. **Save dashboard** creates it and gives it its own
  address; **Discard** returns to the library.
- **Edit** turns on Edit mode: rename the board, **Add widget** from the gallery, open a
  widget's settings, drag a widget by its handle or resize it from its corner, or move
  and resize it from the keyboard with its toolbar. **Save dashboard** stores the board;
  **Discard** puts back what was stored.
- **Duplicate** (in the **More** menu) makes a copy of the board and opens it in Edit mode.
- **Rename** (in the **More** menu) changes the board's name.
- **Reset to default layout** (in the **More** menu of My dashboard, once saved) drops
  your saved board and any unsaved changes, and brings back the default for your role.
- **Delete dashboard** (in the **More** menu of any other board) deletes it for good,
  after you confirm.

A board holds up to 40 widgets and its name up to 120 characters. If you leave a board
with unsaved changes (the **All dashboards** link, the breadcrumb, the navigation or
another page), the Console asks "Discard changes to My dashboard?" first; **Keep
editing** stays on the board. Reloading or closing the tab asks too. The browser's Back
and Forward buttons cannot be paused, so save before you use them.

A board saved before this release under an id a link cannot carry opens under a short
alias (`#/dashboards?board=u:...`); it is still the same board.
