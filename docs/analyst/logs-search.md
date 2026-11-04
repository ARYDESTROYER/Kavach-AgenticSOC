---
title: Logs and search
description: Browse recent normalized events and find cases, sources, and destinations without changing source data.
---

# Logs and search

Open **Triage → Logs** to inspect recent events across enabled, browse-capable
sources. This surface is read-only and requires `sources:read` when RBAC is enabled.

## Unified logs

The unified view fans out to each source and merges rows newest first. Every row
includes `source_id` and source name so identical-looking events remain attributable.

- Pull connectors perform a bounded search with the source's own field mapping,
  index scope, TLS settings, and read-only credential.
- Push, queue, and object-store receivers show their recent in-process browse buffer.
- A source timeout or read error is returned as a per-source failure; successful
  sources still render.
- The result is capped at 200 rows per source and 200 merged rows (the page asks for
  150).

The page header holds the time range and Refresh. The time-range pill offers the last
15 minutes, 1 hour, 4 hours, 24 hours or 7 days, and a refresh choice of **Off** or
**Live** (a live tail that reads again every 10 seconds). Below it, filter by free text.

The events sit on one panel titled with what it holds, for example "Latest 150 events"
with "from 3 sources" (or "from 2 of 3 sources" when one did not answer) beside it. The
table reads newest first:

- **Time (UTC)** shows each event's time of day; the date is a group row above the
  events of that day, shown once when the day changes.
- **Source** shows the source's short name (its configured name without a trailing
  part in brackets, so "Splunk Enterprise Security (HEC)" reads "Splunk Enterprise
  Security"); the full name is the cell's tooltip.
- **Rule** is a link: pressing it opens the rule's sheet (see below).
- **Severity** shows the named level only (Info, Low, Medium, High or Critical); the
  tooltip gives the raw score and the scale it was read on ("Score 12 on a 0 to 16
  scale"), because each source declares its own severity scale.
- The message, and a row's expansion into its source and destination IP, user, host
  and the raw payload, kept for provenance.

On a phone the events are a list rather than a table.

## A rule's sheet

Pressing a rule anywhere in the Console (a log row, a case's facts, Auto-tuning, the
Cyber Defence Center's top signatures, a dashboard rule widget) opens the same rule
sheet, on the last 3 days unless it was opened from a page with its own window. A strip
at the top counts the rule's alerts in the window (exact, or a floor when a source could
not count all of its data) and, for every case the rule ever opened, the cases, how many
are still open and the analyst outcome. Below it are alerts over time by severity, the
top source IPs and targets, the latest alerts, the cases, and the rule's facts (where it
is defined, its tuning and any "declared benign" policy). Each part checks its own
permission, so a missing permission hides one part, never the sheet, and the sheet never
states a zero it did not count. Opening it calls no model. **Open all N in Logs** opens
this page filtered to that rule (the number only when the count is exact), **Show the N
cases** opens those cases, and **Ask AI about this rule** asks chat about it.

## Exact filters

Opened from a rule's sheet or a chat answer, the page can carry exact filters the server
applies: "Rule is" (the exact rule value), "Severity is High" (one named level) and
"Severity High or above". Each is a removable chip. While "Rule is" is set the Rule
column is left out, and the event count above the table is the server's matched count
("381 events · last 3 days", or "At least 1,000 events" when a source could not count
exactly), never a sum of the rows shown. A linked window longer than 90 days keeps every
filter and reads the last 90 days of that window, and the header says so.

!!! warning "Recent push logs are not an archive"

    The push browse buffer is volatile. Restarting the backend clears it. Cases keep
    selected identifiers and evidence, but the authoritative raw event should remain
    in the sending system, broker, or object store.

## Browse one source

From **Platform → Sources**, open a source and choose its log view when available.
This runs the same bounded source-specific search or buffer read. An empty result can
mean a quiet source, an overly narrow time range, a mapping mismatch, or a source that
has not received data; check source health and coverage before concluding that the
pipeline is broken.

## Global search and command palette

Use the command palette to find:

- cases by ID, title, entity, tag, or source;
- configured sources by name, type, or ID;
- navigation and Settings destinations; and
- your saved chat conversations by their content.

The palette also offers **New chat**, **Open Reports**, and **Ask AI**, which opens a new
Workspace Chat with what you typed in the composer, ready to review and send. Chat
entries are listed after pages and settings, so pressing Enter on a page name still
opens that page.

Global search is bounded and requires `cases:read`. It is a navigation aid, not an
unbounded raw-event search engine.

**Open in Logs** on a Workspace Chat result opens this page with the exact query,
source, and absolute time window behind that result, so you can inspect the events
yourself. It is offered only when the Logs page can apply the same filter. **Live tail**
is unavailable only while that window ends at a fixed time in the past, because nothing
new can arrive in it; choose another time range to follow new events.

## Treat log content as data

Log messages, field names, entities, and raw payload values can be attacker
controlled. Agentic SOC renders them as plain data and fences them before model use. Do not
copy an instruction embedded in a log into a trusted runbook or memory entry without
independent verification.

Continue with [Investigation](investigation.md) or the
[source support matrix](../sources/support-matrix.md).
