---
title: Audit log
description: Open, filter and export the append-only record of every action by people, the AI agent and the system in Agentic SOC 0.1.
---

# Audit log

The audit log is the append-only record of what people, the AI agent and the system did
in Agentic SOC: sign-ins, setting and user changes, case work, every step of an
investigation, exports and resets. Rows are never edited or deleted. Open it from
**Platform → Audit log**. Reading it needs the `audit:view` permission (super admin, SOC
manager and auditor by default); exporting it also needs `audit:export` (the same three
roles by default). See [Users and RBAC](users-rbac.md) and the
[permission reference](../reference/permissions.md).

## Scopes

The control under the page header chooses which rows the list reads:

| Scope | What it shows |
|---|---|
| **People and settings** (default) | Every row a person (or a service acting for one) made, plus every access, configuration and case work row, whoever made it: sign-ins, access denied, user and role changes, settings, exports, resets, runbook and dashboard changes, case work. |
| **Agent activity** | What the AI agent and the system did on their own: investigation steps (prompts, log queries, tool calls, verdicts, decisions) and system work (source polls, scans, notifications, background jobs, errors). |
| **All** | Both. |

The two scopes never overlap, so a row's scope does not change after an upgrade. A
decision the deterministic case manager made is recorded with the system as its actor
type, because code, not the AI agent, decides whether a case closes.

## Finding events

- **Time range.** The header offers the last hour, 24 hours, 7 days (the default), 30
  days and 90 days. **Custom** sets a start and an end in UTC, to the minute.
- **Search.** Type in the search box (or press `/` to reach it) and press Enter. It
  searches the event name, the actor, the target and the stored summaries on the server,
  across the whole log, never only the rows already loaded. You can narrow with
  qualifiers, which become filters (shown as chips) rather than search text:

  | Qualifier | Filter |
  |---|---|
  | `actor:trao` | actor name contains `trao` |
  | `event:auth.login_failed` | one event, an event family (`event:auth`) or a category (`event:config`) |
  | `outcome:failed` | `success`, `failed`, `denied`, `partial` or `not recorded` |
  | `case:<case id>` | rows about one case |
  | `target:<id>` | rows about one user, source, setting, runbook, job or other target |
  | `ip:203.0.113.24` | rows from one client address |

  Matching is case-insensitive. On Elasticsearch the stored summaries are matched by
  whole words and phrases, so `login failed` finds "login failed" but `gin fail` does not;
  names, actions and targets match any part of the text on every store. Accented letters
  fold to their plain form on PostgreSQL and Elasticsearch only.
- **Event, Actor, Outcome and More filters.** The Event menu is grouped by category and
  searchable. An older event type that shares its name with a newer event is listed with
  "(older rows)", because it matches only rows stored without the newer event name. The
  Actor menu filters by part of a name, by one exact name from the events
  loaded, or by kind (people, AI agent, system, services). More filters adds a case, a
  source, a surface or a client address.
- **Chips.** Every filter you add shows as a chip; remove one with its button, or use
  **Clear all**. The scope and the time range stay.
- **Quick views.** One click applies one common filter, and each view is named for exactly
  what it matches, in the words of the chip it leaves: **Sign-in failed** (the failed
  sign-in event), **Access denied** (every row whose outcome is Denied, older
  access-denied rows included), **User events** (every user event: accounts created,
  changed and deleted, role assignments and personal preferences), **Settings events**
  (every settings event) and **Configuration and data** (that whole category, older rows
  included). Sign-in failed, User events and Settings events match rows recorded since
  Round 14: an older failed sign-in is a general sign-in row with no outcome of its own,
  and an older user or settings change keeps its stored type, so to include those rows
  pick **Access and identity** or **Configuration and data** in the Event menu. Custom role
  definitions (created, changed and deleted) are separate events: pick **Any role event**
  in the Event menu. Press a view again to clear it. The views read People and settings
  rows, so applying one from Agent activity switches the scope to People and settings.

The page address carries the view (for example
`#/audit?scope=people&from=now-7d&q=role&record=<id>`), so a link you copy opens the same
rows and the same record. The source, surface and actor kind filters and the sort order last
while the page is open and are not part of the link; following a **Related** link in a
record clears the source, surface and actor kind filters, so the link shows every event it
names.

## Reading the list

The list shows 50 events at a time, newest first; **Load more** reads the next 50 from
the server. **Refresh** reads the view again and keeps the rows on screen until the new
ones arrive; if the read fails, the rows stay under the error and **Load more** still reads
on from them. Load more is unavailable while a read is in progress. The line above the
list says what you are looking at, for example "Showing 1 to 50 of 1,284 events · last 7
days · times in UTC · newest first". On Elasticsearch a total above 10,000 is shown as "at
least 10,000".

| Column | Holds |
|---|---|
| Time | When the event was recorded. The column header menu switches between UTC and your local time (remembered in this browser) and between newest and oldest first. |
| Outcome | Success, Failed, Denied, Partial or Not recorded, always as a word with a glyph. |
| Event | The event's friendly name. |
| Actor | The person, AI agent or system, with a glyph for its kind. |
| Target | What the event acted on: a case, a user, a source, a setting area, a job or a rule. |
| Summary | The stored one-line summary. |

When a scope has no events in the time range, the page says so in that scope's words
("No agent activity in the last 7 days.") and offers a longer range and **Show all
scopes**, so an empty scope is never mistaken for an empty log.

On a phone the list shows Time, Outcome and Event, and the filters fold into **Filters**
(its count leaves out the search, which stays on the page). Below 1,280 pixels the Target
column folds away; every value is still in the record.

In **Agent activity**, the steps of one investigation fold into one row that names the
case it worked on, how many steps it took and how it ended (for example "10 steps · closed
as false positive"), with **Open case trace**. Open the row to list its steps. When only
part of an investigation is loaded the row says so ("6 of 10 steps shown") and offers
**Load more**. Rows without an investigation run (older rows and work outside the
pipeline) are never grouped.

A row recorded before Round 14 carries fewer fields. Its outcome reads Not recorded,
except that an access-denied row reads Denied and an error row reads Failed; the record
marks those values as derived.

## The record

Click a row, or select it and press Enter, to open its record in a panel on the right.
From 1,280 pixels wide the panel sits beside the list, which stays live: click another row
to swap the record. Below that the panel opens over the page, and on a phone it fills the
screen. **J** and **K** move to the next and previous record; **Esc** or **Close** returns
you to the row you were on.

The record has six sections:

1. **Who.** The actor and its kind, the role it held at the time, the client address and
   where it came from ("From the connection" or "From the trusted proxy"), the browser or
   tool, and a short reference to the session. A forwarded header the client sent is kept
   behind **Show forwarded header** and labelled "Supplied by the client; not verified".
2. **What changed.** For a change: each field in words with its key under it, the value
   before (struck through) and after. Secret values are never recorded and show as
   "Changed (secret values are never recorded)". A web address is reduced to its scheme
   and host, because webhook addresses carry their credential in the path.
3. **Details.** The full stored summary, the query as it ran, the model and tool, the tool
   input as an expandable tree with **Copy JSON**, and any prompt excerpt or tool output
   in a block labelled as containing untrusted log data.
4. **Raw record.** The record exactly as it is stored, with Copy. The values the page works
   out to show a row (its category, its friendly name, the record id, and an outcome or
   actor kind derived for an older row) are not part of the stored record, so they are
   left out here and shown, labelled, in the other sections. A text field longer than
   1,000 characters is stored cut at 1,000, and the record says which.
5. **Record.** The event and action tokens, the surface, the target and its revision, the
   case (a link to it), the source (a link to its logs, for people who can read sources),
   the record id (with Copy), the event, request and investigation run ids, and the
   application version and build.
6. **Related.** Links that apply a filter: the same actor within 15 minutes, all events
   for this target, all events for this case and its case trace, and the actor's sign-ins
   in the 30 days before this event.

**Copy link** copies the address of this record with the page's filters. When a change was
recorded but its save then failed, the record says "Not applied (see the next record)":
the failure row that follows it in time has the same request id, and **see the next
record** opens it. A link to a record that is not in the current store says "This record is
not in the current store."; one that could not be read offers **Retry**.

Every value is shown as plain text, exactly as stored.

## Keyboard

| Keys | Action |
|---|---|
| Up, Down | Move between events |
| J, K | Move to the next or previous event and open it |
| Enter | Open the event |
| Home, End | First or last loaded event |
| Esc | Close the record |
| `/` | Search the audit log |
| `?` | Show the shortcuts |

Shortcuts never act while you type in a field or use a menu.

## Exporting

**Export** in the page header exports exactly what the page shows: its scope, filters,
search and time range. Choose **Export CSV (spreadsheet)** or **Export JSON Lines (for a
SIEM)**. **Full application export** opens the data export in Settings for people who hold
`data_export:export`.

The export dialog fixes the time range to exact UTC times when it opens (for example "18
Oct 15:10 to 25 Oct 15:09 UTC"); the count it shows, the file name and the export all use
those times. A range that ends now ends at the last whole second that has passed, so the
count and the file hold the same events, as long as this device's clock is set correctly.
One file holds at most 100,000 events. Above that the dialog reads "More than 100,000
events", Export stays disabled, and it offers **Use last 30 days** when that range fits;
otherwise narrow the filters. Nothing is ever cut off silently.

- You are asked to sign in again before the export runs.
- One export per person runs at a time.
- Exports of 5,000 events or fewer download on the page when ready; while you wait,
  **Continue in the background** (or Esc) closes the dialog and the export finishes in
  **Jobs**. Larger exports run in the background; you get an Inbox notice and the file is
  in **Jobs**. See [Background jobs](../operations/background-jobs.md).
- The file is named after the range, for example
  `agentic-soc-audit_2026-10-18T151000Z_2026-10-25T150959Z.csv` (`.ndjson` for JSON
  Lines). Exports always read oldest first, with times in ISO 8601 UTC.
- **CSV** has one fixed set of columns covering every field; the tool input, the changes
  and the truncated field list are JSON text. A text cell that starts like a spreadsheet
  formula (`=`, `+`, `-`, `@`, a tab or a line break, also after spaces or in their
  full-width forms) is written with a leading apostrophe, so a spreadsheet shows it as
  text and never runs it. The CSV and copied data of chat answers and reports use the
  same rule.
- **JSON Lines** writes each stored record unchanged, one per line.
- Audit exports are not available in Demo Mode.

Every export is recorded in the audit log when it is requested, when the file is written
(with its size and SHA-256) and each time it is downloaded. Every download of any job's
file is recorded before it starts; if that record cannot be written, the download does not
start.

## What a record holds

Rows written since Round 14 carry these fields where they apply. Older rows are not
changed.

| Field | Meaning |
|---|---|
| Outcome | Success, failure, denied, partial or unknown. |
| Actor type | Person, AI agent, system or service. |
| Action | The structured event name, such as `auth.login` or `user.role_changed`. |
| Actor role | The role the actor held at the time. |
| Client | The client address, where it came from, the raw forwarded header (untrusted) and the user agent. |
| Session reference | A one-way reference to the session, never the session token. |
| Target | What the event acted on, its name, and the revision the change created. |
| Changes | Up to 50 fields with their values before and after, secrets withheld. |
| Request id | The id of the request (also in the `X-Request-ID` response header). |
| Run id | The investigation run, so its steps group together. |

### Personal data

The client address and the user agent are personal data. They are kept as long as the
audit log is kept and they are in every export. Restrict `audit:view` and `audit:export`
to the people who need them.

### Client addresses behind a proxy

The recorded address comes from a forwarded header only when the request arrived through
a proxy named in the backend setting `TRUSTED_PROXIES` (by default the bundled Web UI). It
is then the rightmost forwarded address that is not itself a trusted proxy. A request that
reaches the backend directly is recorded with its connection address, whatever headers it
sends. A deployment behind another proxy or load balancer adds it to `TRUSTED_PROXIES`.

## Viewing is recorded

Opening the audit log, searching it, counting it for an export and opening a record are
recorded as "Audit log viewed", at most one row per person per filter set every five
minutes. Recording a view never blocks the read.

## Retention

The line above the list says how long the log is kept, for example "Kept 180 days hot,
then 90 days warm" when the Elasticsearch lifecycle is active. A deployment that keeps its
state in memory shows "This deployment keeps the audit log in memory; it is lost on
restart." Retention is set in **Settings → Organization → Storage & retention**.

On Elasticsearch, apply the shipped audit index template and roll the audit write index
when you upgrade, so the new fields are mapped. See
[Upgrades](../operations/upgrades.md).

## Limits

- Sign-in, sign-out and session events never block signing in. If their row cannot be
  written it is logged and counted instead. Every other change is recorded before it takes
  effect: if its row cannot be written, the change is not made and the request answers
  `503 audit_unavailable`.
- If the backend stops between recording a change and saving it, the record names a
  revision that was never saved.
- "Not applied" is shown only when both the change and its failure record are loaded.

For the request and response fields of `GET /api/audit`, `GET /api/audit/count` and
`GET /api/audit/records/{record_id}`, see the [API reference](../reference/api.md).
