# Round 14, ask 2: Audit log research brief

- Ask (verbatim): "Audit log is very impractical and limited, clicking on logs should
  obviously reveal more. And and export button would be nice."
- Scope of this brief: what the Audit log page does today (code and live demo), how the
  industry presents and exports audit logs, what the standards require, and a concrete
  recommendation with three layout options for the detail view.
- Research only. No product code was changed.
- Screenshots referenced below live in
  `<scratch>/r14/shots/research/`
  (abbreviated as `shots/` in this brief).

## 0. Summary

1. Clicking a row does nothing today. The page has no row handler at all
   (`webui/src/soc/pages/Audit.tsx:445-473` passes no `onRowClick`), and the one
   "Detail" cell is a single truncated line. Verified live: a click leaves the URL and
   the DOM unchanged.
2. The data to show already exists but is hidden. Every record carries up to 16 fields
   (`backend/app/models.py:1855-1882`); the page shows 7 columns and collapses four text
   fields into one cell. `tool_input` (structured JSON: retrieval queries, knowledge
   hits with scores, persona choice, log-query parameters) and the full `build_sha`,
   `model`, `source_id` and `event_id` are never shown anywhere on the page.
3. The page is not a real queue. It loads at most 200 rows
   (`Audit.tsx:50`), the API hard-caps at 500 and returns `total = len(rows)`
   (`backend/app/api/routes_search.py:189,203`), and the search box filters only the
   loaded window in the browser (`Audit.tsx:194-214`). "Showing 148 of 148" is not a
   true total. This breaks the console's own queue rule (`docs/development/ui-standard.md:307`).
4. In Demo Mode the page cannot show who signed in or changed settings. The viewer reads
   `state.audit` (the demo store when Demo Mode is on) while sign-ins, user changes and
   settings changes are written to `state.control_audit` (always the real store)
   (`backend/app/state.py:502-513`). Live check: 0 `auth`, 0 `user_mgmt`, 0
   `access_denied` rows visible although Admin had just signed in.
5. The record itself is thin for compliance. NIST AU-3 and PCI DSS 10.2.2 both require
   outcome (success or failure), origin (source address) and the affected object. Our
   record has no outcome, no client IP or user agent, no session, no structured target
   and no before and after values (a user update records only `updated user 'X'`,
   `backend/app/api/routes.py:5195-5196`).
6. Industry pattern for the detail view: a side panel or fly-out (Datadog, Microsoft
   Purview, Entra), a full details page (AWS CloudTrail) or an inline expanding row
   (Okta). All of them show the raw JSON record, actor, target, client IP and outcome,
   and most show before and after values for changes.
7. Industry pattern for export: export exactly the current filter and time range, in CSV
   and JSON, with an explicit row cap (Atlassian 10,000; Datadog and Google Workspace
   100,000; CloudTrail 200,000 per file; Entra 250,000), large exports run as a
   background task (Purview, Google Workspace, Atlassian, Vercel), and the export is
   itself an audited event (Vercel `auditlog.export.requested` and
   `auditlog.export.downloaded`; PCI 10.2.1.3 "all access to audit logs").
8. Recommendation: rebuild the page as a server-paged queue with three scopes (People and
   settings, Agent activity, All), friendly event names, an Outcome column, absolute
   times, URL-backed filters, and a detail inspector (Option A, a non-modal side sheet)
   with Who, What changed, Record, Raw JSON and Related sections plus a copyable deep
   link. Add an Export menu (CSV and JSON Lines) that exports the current filter through
   the existing Jobs machinery, gated by a new `audit:export` permission that the
   Auditor role also gets, defused against CSV formula injection, and audited when
   requested and when downloaded.

## 1. Today

### 1.1 Files

| Layer | File | Notes |
|---|---|---|
| Page | `webui/src/soc/pages/Audit.tsx` (487 lines) | Filter bar + `DataTable`; gated by `<ProtectedRoute resource="audit" action="view">` (`Audit.tsx:479-486`) |
| Client | `webui/src/lib/api.ts:1107-1112` | `api.audit.list(params)` only; no get-one, no export |
| Types | `webui/src/lib/types.ts:2815-2853` | `AuditRecord`, `AuditResponse {records,total}`, `AuditQuery` |
| Route | `backend/app/api/routes_search.py:171-203` | `GET /api/audit`, `audit:view` |
| Model | `backend/app/models.py:1855-1882` | `AuditDoc` |
| Vocabulary | `backend/app/constants.py:499-536` | `ActionType` (30 values) |
| ES store | `backend/app/audit/audit_log.py:137-188` | term/range bool query, `size=limit`, returns `_source` only |
| SQL store | `backend/app/stores/sql/repositories.py:1365-1431` | `action_type`, `case_id`, `ts` in SQL; `actor`, `surface`, `source_id` filtered in Python over paged scans |
| ES mapping | `backend/app/es/indices.py:72-96` | keyword `actor`/`action_type`/`surface`/`case_id`/`source_id`; text summaries; `tool_input` not indexed |
| RBAC | `backend/app/rbac/policy.py:62,67,189-201` | `audit: ["view"]` only; `data_export: ["export"]` (super admin and SOC manager only); Auditor has `audit:view` but not `data_export` |
| Export | `backend/app/api/routes_export.py`, `backend/app/engine/jobs.py:618-698,889-899` | Full-history `audit` scope inside the application export ZIP; no filter |

### 1.2 What a record carries, and what the page shows

| Field (`AuditDoc`) | Meaning | Shown today |
|---|---|---|
| `ts` | Event time | Relative only ("2m ago"); absolute only in a hover title |
| `action_type` | One of 30 `ActionType` values | Badge with the raw token humanised ("Es query", "Inapp notify") |
| `actor` | Agent role or user name | Plain text; no human, agent or system distinction |
| `surface` | Where it happened | Humanised token |
| `case_id` | Related case | Truncated id with a link to the case |
| `app_version`, `build_sha` | Producing build | A "Build" column that wraps vertically (see 1.4) |
| `result_summary`, `tool_output_summary`, `query_text`, `prompt_excerpt` | Four text fields, each truncated to 1,000 characters at write time (`backend/app/stores/base.py:662-672`) | Only the FIRST non-empty one, in one truncated line (`Audit.tsx:64-68`). For a log query the reproducible `query_text` is therefore hidden behind `tool_output_summary` |
| `tool_input` | Structured JSON (arbitrary) | Never shown |
| `model`, `tool_name`, `source_id`, `event_id` | Model used, tool, source, idempotency key | Never shown (searchable client-side only) |

Missing from the record entirely: outcome, client IP, user agent, session, request or
correlation id, a structured target (type and id) for anything that is not a case or a
source, and before and after values for changes. There is no request id or
investigation run id anywhere in the backend (no match for `request_id`, `X-Request-ID`
or `run_id` in middleware or the pipeline). The session registry does record IP and
user agent per session (`backend/app/stores/sessions.py:379-407`), and a helper already
exists to read the client IP (`backend/app/state.py:3911`), but neither reaches the
audit row. A failed sign-in records only `actor` and `result_summary="login failed"`
(`backend/app/api/routes.py:3459-3462`).

### 1.3 Read path behaviour

- Filters: `actor` (exact term match, case-sensitive), `action`, `surface`, `case_id`,
  `source_id`, `from`, `to`, `limit` (`routes_search.py:172-181`). The page exposes
  actor, action, surface, case id and a `from` preset (any time, 24 h, 7 d, 30 d);
  `to` and `source_id` have no control.
- No cursor, no offset, no sort control, newest first only.
- `total` is the length of the returned page, not a count of matches.
- ES returns `_source` only, so a record has no stable id to link to. SQL rows have an
  autoincrement `id` (`backend/app/stores/sql/models.py:42-67`) that is not returned.
- Viewing the audit log is not itself audited.
- In Demo Mode the read goes to the demo store (see Summary point 4).

### 1.4 Live observations (shared demo, 25 Oct 2026)

Screenshots: `shots/audit-light-1440.png`, `shots/audit-light-1440-full.png`,
`shots/audit-light-1440-hover-detail.png`, `shots/audit-light-1440-action-filter.png`,
`shots/audit-light-1440-after-row-click.png`, `shots/audit-dark-1920.png`,
`shots/audit-dark-1920-full.png`, `shots/audit-dark-1920-after-row-click.png`.

- 159 rows loaded (the demo store covers about 18 minutes). Mix:
  `decision` 42, `prompt` 42, `context` 28, `poll` 14, `verdict` 14, `tool_call` 14,
  `automation` 2, `proposal` 2, `tuning` 1. One investigation writes about 10 rows in
  the same second, so the table is almost entirely agent pipeline telemetry.
- Row click: no dialog, no URL change (`detailOpened: false`).
- At 1440 x 900 the Build column wraps to six lines, so each row is about 130 px tall
  and only four rows fit on screen; the table also scrolls horizontally and the Detail
  cell runs past the panel edge (70 of 148 detail cells were clipped).
- At 1920 x 1080 the Build value still wraps to two lines.
- The Action filter lists raw tokens ("Es query", "Inapp notify", "Access denied") in
  one flat alphabetical list of 30 items with no grouping.
- No Export, no Copy, no deep link, no total, no retention notice.

### 1.5 Limitations (numbered for the spec)

- L1. Click reveals nothing; no detail view of any kind.
- L2. Hidden data: `tool_input`, `query_text` (when a summary exists), `prompt_excerpt`
  (when a summary exists), `model`, `tool_name`, `source_id`, `event_id`, full SHA.
- L3. One truncated line for text that can be 1,000 characters; no wrap, no copy.
- L4. 200-row window, 500-row API cap, fake total, no paging.
- L5. Search runs in the browser over the loaded window only.
- L6. Actor filter is exact and case-sensitive; no "contains", no list of known actors.
- L7. Time filter has four presets, no custom range, no end time.
- L8. Relative times only in the table; no timezone statement.
- L9. Raw action tokens, no friendly names, no grouping, no human/agent/system marker.
- L10. No outcome (success, failure, denied) in the record or the table.
- L11. No client IP, user agent, session, request id or structured target in the record.
- L12. No before and after values for setting, user or role changes.
- L13. Agent pipeline rows drown people and settings events; no scope split and no
  grouping of one investigation's rows.
- L14. In Demo Mode, sign-in and admin events are invisible on this page.
- L15. No export from the page. The only export is the full-history application
  export in Settings, limited to super admin and SOC manager, so an Auditor cannot
  export audit evidence at all.
- L16. No stable record id, so no deep link and no "copy link to this event".
- L17. Viewing and downloading audit data is not audited: `GET /api/audit` writes
  nothing, and `GET /api/jobs/{id}/artifact` (`backend/app/api/routes_jobs.py:626-650`)
  writes nothing on download (only assembly is audited, `jobs.py:889-899`).
- L18. Layout bugs: Build column wraps, table overflows at 1440, detail cell clips.
- L19. No retention statement; the storage lifecycle API already knows the audit
  ledger's tiers and whether the store is volatile (`GET /api/storage/lifecycle`
  returned "The in-memory fallback is volatile" for the demo).
- L20. No Help Center page for the audit log (only a row in
  `docs/reference/permissions.md:55,95`).

## 2. Industry

### 2.1 How others present the list and the detail

| Product | List | Click shows | Notable |
|---|---|---|---|
| AWS CloudTrail Event history | Columns Event name, Event time, User name, Event source, Resource type, Resource name; page size 10/25/50; wrap lines; UTC or local; choose columns | A details PAGE with the event summary, "Resources referenced" (with links) and the full JSON "Event record"; breadcrumb back | Compare up to 5 events side by side; one attribute filter plus relative or absolute time range |
| Microsoft Purview audit search | Date (UTC), IP Address, User, Record type, Activity, Item, Admin Units, Details | A fly-out with the record's properties | Searches run as async jobs that survive closing the browser, kept 30 days, "Copy this search"; friendly activity names grouped |
| Microsoft Entra audit logs | Date, service, category and activity, status | A details pane with correlation id, actor, target, and "old and new values for the changed properties" | Download CSV or JSON of the current filter |
| Google Cloud Audit Logs | Logs Explorer query results | Expandable JSON entry | Log types: Admin Activity, Data Access, System Event, Policy Denied; caller identity and `callerIp` in every entry |
| Okta System Log | Time, actor, target, event info; count-of-events bar chart (drag to narrow time); map view | Inline row expansion via a right arrow | Default last 7 days; click a column value to filter; Download CSV |
| GitHub org/enterprise audit log | Actor, affected user, repo, action (`category.operation`), country, time | Entry details | Qualifier search (`actor:`, `action:`, `operation:`, `created:`, `country:`), no free text; Export JSON or CSV after filtering |
| Datadog Audit Trail | Log-explorer list with facets (event name, auth, status, method) | Side panel with all attributes, filter-by and exclude actions, an "Inspect Changes (Diff)" tab for config changes | Saved views shared with a short link; "Notable events" curated subset; dashboards and monitors on audit events |
| Splunk `_audit` | `_time`, `user`, `action`, `info` in Search | Raw event | Requires permission to search `_audit` |
| Kibana / Elasticsearch audit | ECS fields `event.action`, `event.category`, `event.outcome` (success, failure, unknown), `user.name`, `user.roles` at time of event, `client.ip`, `trace.id` | Raw JSON | `trace.id` correlates Kibana and Elasticsearch events of one request |
| CrowdStrike Falcon | Console UI docs are behind login; the user activity events stream as `UserActivityAuditEvent` with user id, user IP, operation, service, UTC time and audit key/value pairs (secondary sources) | n/a | Exposed through the Event Streams API |
| Cloudflare | Search by user email or domain, date range | Row details | Download CSV, may fail for large exports, Logpush recommended; 18 months retention |
| Atlassian organization | Date, location, actor, activity | Row details | Export emails a CSV link valid 1 day, up to 10,000 activities from 180 days; a public bug says the export ignored UI filters, a cautionary tale |
| Vercel | Team activity list | n/a | Export CSV by timeframe, emailed link valid 24 h; CSV fields `timestamp, action, actor_vercel_id, actor_name, actor_email, location (IP), user_agent, request_id, previous, next`; exports are themselves audited |
| Google Workspace investigation tool | Results table | Row details | "Export all" to Sheets or CSV; the CSV is collected from the Tasks area (background); 100,000 rows on most editions |

Takeaways:

- T1. Every product lets a click reveal the full record, always including the raw JSON,
  the actor, the target and the time. Most show client IP and outcome. Change events
  show old and new values (Entra, Datadog diff, Vercel previous and next).
- T2. The three detail patterns are a side panel or fly-out (Datadog, Purview, Entra),
  a separate details page (CloudTrail) and inline expansion (Okta). Side panels
  dominate in admin consoles because the list stays visible and the next event is one
  key away.
- T3. Times are absolute and the timezone is stated (Purview and Entra downloads are
  UTC; CloudTrail offers a UTC or local toggle).
- T4. Filters are structured and few (one attribute plus time in CloudTrail; facets in
  Datadog; qualifiers in GitHub). Friendly event names are grouped (Purview). A
  curated "important events" view exists (Datadog notable events; CloudTrail hides
  read-only events by default).
- T5. Export always means "what I am looking at": the current filter and time range.
  Formats are CSV plus JSON (or NDJSON for SIEM drains). Caps are explicit and the UI
  tells you to narrow the filter or use streaming for more.
- T6. Large exports are background tasks with a later download (Purview, Google
  Workspace, Atlassian, Vercel). Immediate download is common below about 100,000 rows.
- T7. Exporting audit data is an audited event (Vercel), and CloudTrail warns about CSV
  injection in its export documentation.

### 2.2 Standards

| Standard | Requirement relevant here |
|---|---|
| NIST SP 800-53 Rev 5 AU-3 | Each record establishes: type of event, when, where, source, outcome, and the identity of individuals, subjects or objects associated. Guidance names timestamps, source and destination addresses, user or process identifiers and success or fail indications. |
| AU-7 and AU-7(1) | Provide audit record reduction and report generation that supports on-demand review and after-the-fact investigation "and does not alter the original content or time ordering"; be able to "process, sort, and search audit records" by field. |
| AU-9 and AU-9(4) | Protect audit information (which includes audit reports) from unauthorised access, modification and deletion; restrict management of audit logging to a subset of privileged users. |
| AU-6, AU-11, AU-12 | Review and report; retain for a defined period; generate records with AU-3 content. |
| NIST SP 800-92 | Protect log confidentiality and integrity (2.3.2); "Ensuring that the original logs are not altered supports their use for evidentiary purposes"; limit access to log files and protect archived files with message digests (5.1.3); avoid recording unneeded sensitive data. |
| PCI DSS v4.0 Req. 10 | 10.2.1.2 all admin actions; 10.2.1.3 "Audit logs capture all access to audit logs"; 10.2.1.4 invalid logical access attempts; 10.2.1.5 credential and privilege changes; 10.2.2 user id, type, date and time, success and failure, origination, affected resource; 10.3.1 read access limited to job need; 10.3.2 protected from modification; 10.5.1 retain 12 months with 3 months immediately available. |
| ISO/IEC 27001:2022 A.8.15 | Logs recording activities, exceptions, faults and other relevant events are produced, stored, protected and analysed (secondary sources; the standard text is paywalled). |
| SOC 2 CC7.2 | Monitor system components for anomalies and analyse them; auditors usually test it through log review evidence (secondary sources). |
| OWASP Logging Cheat Sheet | Attributes: when (log time, event time, interaction id), where (app id and version, address, page and method), who (source address, user identity), what (type, severity, description), plus result status and reason, action and object. "All access to the logs must be recorded and monitored." Encode data for the output format; prefer structured logs. |
| OWASP CSV Injection | No cell may begin with `=`, `+`, `-`, `@`, tab, carriage return or line feed (also the full-width lookalikes); prefix a single quote, quote every field, double embedded quotes. |
| CIS Controls v8, Control 8 | Collect, alert, review and retain audit logs; detailed audit logs (8.5); centralise (8.9); retain at least 90 days (8.10); review (8.11) (safeguard details from secondary sources). |

Mapping to our gaps: AU-3 and PCI 10.2.2 are not met for outcome (L10) and origination
(L11). AU-7 and AU-7(1) are only partly met (no server search, no reports, L4, L5, L15).
PCI 10.2.1.3 is not met (L17). AU-9(4) and PCI 10.3.1 are met for viewing (`audit:view`)
but export currently forces auditors to borrow a broader privilege (L15).

## 3. Recommendation

### 3.1 Information architecture

- One route, `#/audit`, three scopes in a segmented control at the start of the
  control band:
  - **People and settings** (default): every row whose actor is a person or a service
    account acting for one: sign-ins and sign-outs, access denied, user and role
    changes, settings changes, exports, resets, updates, proposals, case lifecycle,
    comments, runbook and rule edits. This is what an auditor means by "audit log".
  - **Agent activity**: prompts, log queries, tool calls, verdicts, decisions, context,
    polls and scans. Group one investigation's rows into a single expandable row
    ("Investigation of CASE-000214, 10 steps, closed as false positive") with a link to
    the case trace that already renders these rows.
  - **All**.
- Friendly event names with a category, replacing raw tokens. Proposed categories:
  Access and identity (`auth`, `access_denied`, `user_mgmt`), Configuration and data
  (`data_export`, `reset`, `system_update`, settings writes, `runbook`, `playbook`,
  `tuning`, `automation`), Case work (`status`, `collab`, `feedback`, `thread_post`,
  `reaction`, `task_update`, `proposal`, `report`), Agent pipeline (`prompt`, `es_query`,
  `tool_call`, `verdict`, `decision`, `context`), System (`poll`, `scan`,
  `notification`, `inapp_notify`, `job`, `error`). Where one `action_type` covers
  several actions (for example `auth` covers sign-in, sign-out, failed sign-in, MFA),
  derive the friendly name from a new structured `action` field on new rows and show
  the category name on legacy rows rather than parsing summary text.
- In Demo Mode, People and settings reads the real control store and Agent activity
  reads the demo store, each labelled, so sign-ins remain visible (fixes L14).

### 3.2 The list

- Columns: **Time** (absolute, tabular, "25 Oct 15:09:15", with a column header that
  states the zone and a UTC or local toggle remembered per viewer), **Event** (friendly
  name plus a small category or token badge), **Actor** (glyph for person, AI agent or
  system, then the name), **Target** (case number, user, source, setting area, job,
  rule), **Outcome** (Success, Failed, Denied, Partial, Not recorded; text plus glyph,
  never colour alone), **Summary** (one line, truncated, full text in the detail).
- Move Build, Surface and Model out of the table into the detail (fixes L18).
- `table-layout: fixed` with explicit widths and `min-w-0` truncation so nothing
  wraps or scrolls horizontally at 1280 px and up.
- A scope line under the control band: "Showing 1 to 50 of 1,284 events, last 7 days,
  times in UTC, newest first" plus a retention note from the storage lifecycle API
  ("Kept 180 days hot, then 90 days warm" or "This deployment keeps the audit log in
  memory; it is lost on restart").
- Server paging with Load more (same grammar as the Case Manager queue,
  `ui-standard.md:305-321`), never a client filter over a window.

### 3.3 Filters and search

- Search box (server side) over event name, actor, target and the four summary fields.
  Optional power-user qualifiers that compile into the same structured filters,
  GitHub style: `actor:`, `event:`, `outcome:`, `case:`, `target:`, `ip:`. No raw query
  language is sent to the server.
- Time range: reuse the shared `TimeRangePicker` (`webui/src/soc/components/TimeRangePicker.tsx`)
  with 1 h, 24 h, 7 d (default, as Okta and Purview), 30 d, 90 d and a custom absolute
  range with an end time.
- Facets as menus: Event (grouped by category, with search inside the menu), Actor
  (known actors with counts, contains-match), Outcome, and More filters (case, source,
  surface, client IP, build).
- Active filters shown as removable chips with one Clear all.
- Quick views (built in, Datadog "notable events" idea): Failed sign-ins, Access
  denied, User and role changes, Settings changes, Exports and resets. Personal saved
  searches can reuse the existing per-user saved views (`/api/views`).
- All filter state lives in the URL (`#/audit?scope=people&from=now-7d&outcome=failure`)
  so a link reproduces the view.

### 3.4 Detail content (common to all layouts)

Header: friendly event title, outcome, absolute time in UTC and local, Copy link,
Close.

1. **Who**: actor with kind (person, AI agent, system), role at the time of the event
   (new field), client IP, user agent (parsed to "Chrome 141 on macOS" with the raw
   string on demand), session (shortened id and whether it was a remembered session).
2. **What changed** (change events only): a Field / Before / After table. Secret
   fields show "changed" without values, using the same sensitive-key list the export
   already redacts (`routes_export.py` `_SENSITIVE_KEYS`).
3. **Details**: full `result_summary`, `tool_output_summary`, the reproducible
   `query_text` in a code block with Copy, the model and tool, and `tool_input` as a
   collapsible JSON tree with Copy JSON. `prompt_excerpt` sits in a code block labelled
   "Contains untrusted log data" (it carries the `UNTRUSTED_LOG_DATA` fence).
4. **Record**: action token, surface, target, case (link), source (link), record id
   (Copy), event id, app version and full build SHA.
5. **Raw record**: the stored JSON exactly as returned, read-only, Copy JSON. Show the
   1,000-character write-time truncation honestly ("Stored truncated at 1,000
   characters") where it applies.
6. **Related**: other events by the same actor within 15 minutes, all events for this
   target, all events for this case (and "Open case trace"), the sign-in that started
   this session (when session ids exist), each as a link that applies the filter.

Footer: Previous and Next (K and J), Esc closes.

### 3.5 Detail layout options

Mockups (research only, built from the console's tokens, not shipped):
`shots/audit-option-A-light-1440.png`, `shots/audit-option-A-dark-1920.png`,
`shots/audit-option-B-light-1440.png`, `shots/audit-option-C-light-1440.png`,
`shots/audit-option-C-dark-1920.png`. Fields marked "NEW FIELD" in the mockups need the
record additions in 3.7.

**Option A: side sheet (inspector).** A sheet slides in from the right (about 560 px,
14 px leading radius, the console's `Sheet`). Non-modal at 1280 px and wider so the
table stays live behind it and J/K move the selection; modal full-width sheet on
narrow screens.

- Pros: the most common pattern (Datadog, Purview, Entra); the table keeps all six
  columns; room for long JSON and a diff table; deep link opens it directly; the same
  component can serve the Account page's personal activity list and the Case trace.
- Cons: covers the right part of the table (Summary column) while open; a modal
  variant would block J/K, so the non-modal behaviour needs care with focus.

**Option B: inline expandable row.** The row opens in place into a two-column block
(fields left, raw JSON right), like the Logs page today
(`webui/src/soc/components/UnifiedLogsSheet.tsx`, per-row expansion into `_raw`).

- Pros: matches the existing Logs page; no overlay; several rows can be open to
  compare; nothing to dismiss.
- Cons: pushes the following rows down, so the list loses its place; long JSON makes
  very tall rows; J/K and Previous/Next feel awkward; the deep-linked row has to be
  scrolled to; weakest at phone width.

**Option C: split pane.** A resizable list and detail split, like the Case Manager
(`ui-standard.md:281-300`).

- Pros: best for sequential review (an auditor walking through 50 admin events with
  J/K); consistent with Case Manager; nothing overlays the list.
- Cons: at 1440 px the list loses a column (Summary in the mockup) and the detail is
  narrower than in A; needs the resize handle, persisted width and a back-to-list path
  on compact screens; more build effort.

**Recommended: Option A**, non-modal from 1280 px. It is what reviewers expect from
security consoles, it keeps the six-column list intact on a 1440 laptop, and it
supports deep links and J/K. If the operator prefers C, the detail content in 3.4 is
identical, so the choice is only the container.

### 3.6 Export

- **Where**: an Export menu in the page header actions (the page's primary action,
  since the page is read-only): "Export CSV (spreadsheet)", "Export JSON Lines (for a
  SIEM)", and a link "Full application export" to Settings, Data export.
- **What**: exactly the current scope, filters, search and time range. A confirm
  dialog states it in words and numbers before anything runs: "1,284 events, People
  and settings, last 7 days, outcome any, times in UTC". The file name carries the
  range: `agentic-soc-audit_2026-10-18T000000Z_2026-10-25T151000Z.csv`.
- **Columns**: CSV has a fixed, documented column set covering every record field
  (structured fields flattened, `tool_input` and `changes` as JSON text columns),
  independent of the columns on screen (Entra does the same). JSON Lines writes each
  stored record as one line, unmodified. Times are ISO 8601 UTC in both. Order is
  oldest first (AU-7: never alter time ordering). Content is never rewritten except the
  CSV formula defusal, which is documented.
- **Size**: cap 100,000 rows per file (the Datadog and Google Workspace figure). Above
  the cap the dialog says so and offers to narrow the range; it never silently
  truncates. The full history stays available through the existing application
  export.
- **Delivery**: through the existing Jobs machinery as a new job kind `audit_export`
  (AGENTS.md: Console workflows submit Jobs). The job reads with the same filters, writes
  the file to the private artifact root, records its size and SHA-256 (the
  `JobArtifact` model already carries both, `models.py:1125-1133`), and is cancellable.
  For small exports the page waits for the job and starts the download itself; larger
  ones finish in the background with the usual Inbox notice. The artifact is the plain
  `.csv` or `.ndjson` file, not a ZIP, so a spreadsheet opens it directly; the SHA-256
  is shown in the job detail and written to the audit row for integrity (SP 800-92
  message digests).
- **Permission**: a new action `audit:export`, granted by default to super admin, SOC
  manager and Auditor. Exporting audit evidence is the Auditor's core job, and the
  broader `data_export:export` deliberately excludes Auditors (`policy.py:64-67`).
  Fresh re-authentication, as the application export already requires, is recommended
  because the file contains user names and IP addresses (open question 4).
- **Audit the export**: write `data_export` (or a new `audit_export`) rows when the
  export is requested (filters, format, row count), when it is assembled (size,
  SHA-256) and when the file is downloaded. Add download auditing to
  `GET /api/jobs/{id}/artifact` for every job kind, not only this one (closes L17 for
  all exports).
- **CSV injection**: port `webui/src/lib/csv.ts` rules to the backend writer and close
  two gaps against OWASP: also defuse a leading line feed and the full-width `＝ ＋ － ＠`
  lookalikes (today's `FORMULA_LEAD` covers `= + - @ TAB CR` and spaces only). Quote
  every string field and double embedded quotes (RFC 4180).
- **Not now**: CEF or LEEF, syslog forwarding and scheduled exports. They belong to a
  later "stream the audit log to your SIEM" feature (Vercel drains, Cloudflare Logpush,
  Datadog archives); note it in ROADMAP.

### 3.7 Backend changes

Read API (all additive; the existing call keeps working):

- `GET /api/audit` gains `q`, `scope`, `outcome`, `actor_kind`, `target`, `ip`,
  `cursor`, `order`, and returns `records[].record_id`, `next_cursor`, `total` and
  `total_relation` (`eq` or `gte`, honest when the store cannot count exactly).
  Elasticsearch: point-in-time paging with `search_after` (the export path already does
  this, `audit_log.py:190-224`) and `track_total_hits`. SQL: keyset paging on
  (`ts`, `id`) and push the `actor`, `surface` and `source_id` filters into SQL through
  JSON accessors (`AuditRow.doc["actor"].as_string()`) instead of the Python scan, so
  no schema migration is needed.
- `GET /api/audit/records/{record_id}` returns one record. The id is opaque: the
  Elasticsearch index plus `_id`, or the SQL row id, with a store prefix so a demo
  record and a real record can never collide.
- Searches of the audit log are themselves recorded, coalesced to at most one row per
  user per distinct filter set per 5 minutes (PCI 10.2.1.3 without flooding the log).

Record additions (additive fields on new rows only; legacy rows are never backfilled,
matching the record provenance contract in AGENTS.md):

- `outcome`: `success`, `failure`, `denied`, `partial`, `unknown`. Legacy rows read
  `denied` for `access_denied`, `failure` for `error`, otherwise "Not recorded".
- `actor_type`: `human`, `agent`, `system`, `service`. Legacy rows derive it from the
  known agent role list, labelled as derived.
- `action`: a structured verb such as `auth.login`, `auth.login_failed`,
  `user.role_changed`, `settings.updated` for friendly names and filtering.
- `client`: `{ip, user_agent}` for request-driven events, via the existing
  `client_ip_from` helper. Record whether the IP came from `X-Forwarded-For`.
- `session_ref`: a shortened or hashed session id (never the token).
- `target`: `{type, id, label}`.
- `changes`: `[{field, before, after}]` for settings, user, role and rule writes, with
  secrets reduced to "changed".
- `request_id` (a request-scoped id from a small middleware) and, for agent rows, a
  `run_id` per investigation so the Agent scope can group rows.

Elasticsearch note: bootstrap creates missing templates only and never remaps
(AGENTS.md). New string fields on existing indices would be dynamically mapped as text,
so term filters on them would silently miss (the same trap documented for `source_id`
at `indices.py:77-85`). The template must add keyword mappings and the docs must tell
existing deployments to roll the write index; until then filter on `.keyword`
subfields.

### 3.8 Deep links

- `#/audit?record=<record_id>` opens the inspector on that record, with the filter that
  contains it restored when present in the URL.
- Copy link in the inspector header; "Copied" announced politely.
- Other pages link in: Case trace "View in audit log", the Account page's recent
  activity, the Jobs page for export jobs, and the user detail in Users ("Audit events
  for this user").

### 3.9 Keyboard and accessibility

- The list is one tab stop with roving focus: Up/Down or J/K move, Enter opens,
  Esc closes the inspector and returns focus to the row, `/` focuses search, `?` lists
  shortcuts (the Case Manager grammar). Single-letter keys never fire inside a text
  field or menu.
- The inspector moves focus to its title on open, has `aria-labelledby`, and is a
  labelled region when non-modal or a dialog with a focus trap when modal.
- Outcome is text plus glyph; actor kind has a text label for screen readers; times
  carry `datetime` attributes; sort headers expose `aria-sort`.
- Code and JSON blocks scroll in their own region with a visible focus ring and a Copy
  button; the JSON tree is keyboard expandable.
- Every value is rendered as plain text (non-negotiable 9); the JSON viewer builds text
  nodes, never HTML.

### 3.10 Empty, loading and error states

Use the shared `EmptyState` states (`ui-standard.md:253-279`):

- `no-data`: "No audit events in the last 7 days" with a link to widen the range.
- `no-results`: "No events match these filters" with Clear filters; filters kept.
- `error`: `LoadError` with Retry, keeping stale rows visible.
- `unavailable`: when the store is the volatile in-memory fallback, a calm notice
  above the table (from the storage lifecycle capability) rather than an empty page.
- Loading: the shared centered `LoadingState` on first load only; refresh keeps rows.
- Inspector: a skeleton for the fetched record; a 404 ("This record is not in the
  current store") for stale deep links.
- Export: the menu is hidden without `audit:export`; disabled with a reason when the
  view is empty; the dialog shows the count, or "more than 100,000, narrow the range".

### 3.11 Visual consistency with the Overview

- The table sits in one grouped `.surface-panel` (14 px radius, tinted, no border,
  `webui/src/styles/theme.css:1762`) like the Overview modules; the control band and
  scope line sit on the canvas above it, divider-led (`ui-standard.md:64-74`).
- Compact density, sticky header, tabular numerals for times, monospace for ids and
  SHAs, sentence-case labels, badges from the shared palette.
- The inspector uses the standard sheet radius and the same section rhythm as the Case
  Manager facts rail: plain headings, divider-led rows, no nested cards.

### 3.12 Non-negotiables check

- #2 append-only: no update or delete path is added; new fields are written at append
  time; export and paging are reads.
- #9 untrusted data: summaries, prompt excerpts, query text, tool input, IP and user
  agent are attacker-influenceable and are rendered as plain text; the prompt excerpt
  keeps its untrusted label.
- #3, #6, #7: no model call, no decision path touched.
- Naming: new identifiers use the product vocabulary (`audit_export`, `audit:export`),
  no new compatibility-prefixed names.

### 3.13 Proposed work packages

1. **WP-AUDIT-API** (backend): paging, total, server search, scopes, get-one,
   JSON-accessor push-down, coalesced view audit, Demo Mode store split, tests on fake
   ES and SQLite.
2. **WP-AUDIT-REC** (backend): record additions in 3.7, writers at the auth, users,
   roles, settings, export, reset and update call sites, redaction, ES template, tests.
3. **WP-AUDIT-EXP** (backend and web): `audit_export` job, `audit:export` permission
   and matrix docs, CSV and NDJSON writers with defusal, cap, request, assemble and
   download audit rows, artifact download auditing for every job kind.
4. **WP-AUDIT-UI** (web): page rebuild (scopes, control band, picker, facets, chips,
   URL state, columns, roving focus, inspector, JSON tree, related links, export menu
   and dialog, states), tests, screenshots in both themes at 390, 1280, 1440 and 1920.
5. **WP-AUDIT-DOC**: a Help Center page (for example `docs/administration/audit-log.md`),
   `docs/reference/permissions.md`, `docs/operations/background-jobs.md` (new job kind),
   API reference, a `ui-standard.md` section on activity and audit logs, CHANGELOG.

WP-AUDIT-UI can ship with legacy fields first (most of 3.4 works today because the hidden
fields already exist); the "NEW FIELD" rows appear when WP-AUDIT-REC lands.

## 4. Open questions for the operator

1. Detail layout: A (side sheet, recommended), B (inline row) or C (split pane)?
2. Default scope: People and settings (recommended, hides agent telemetry until asked
   for) or All?
3. Who may export: add a new `audit:export` for super admin, SOC manager and Auditor
   (recommended), or keep export limited to the two roles that hold
   `data_export:export`?
4. Should exporting require signing in again (fresh authentication), as the full
   application export does?
5. Formats: are CSV and JSON Lines enough for now, with SIEM streaming (CEF, syslog,
   webhooks) left to a later round?
6. Is a 100,000-row cap per export acceptable?
7. Record that someone searched or opened the audit log (coalesced, PCI 10.2.1.3)? It
   adds rows to the log itself.
8. Capture client IP and user agent on sign-in and admin events? They are personal
   data, and they will appear in exports.
9. Default time display in the table: UTC (audit convention) or local time with a UTC
   toggle?
10. In Demo Mode, show real sign-in and admin events next to demo agent rows (each
    labelled), or keep the page demo-only?

## 5. Sources

Code (this repository, commit `a966b0d`): file and line references inline above.

External:

- AWS CloudTrail, Viewing recent management events with the console: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-console.html
- Microsoft Purview, Search the audit log: https://learn.microsoft.com/en-us/purview/audit-search
- Microsoft Entra, Audit logs: https://learn.microsoft.com/en-us/entra/identity/monitoring-health/concept-audit-logs
- Microsoft Entra, How to download logs: https://learn.microsoft.com/en-us/entra/identity/monitoring-health/howto-download-logs
- Google Cloud Audit Logs overview: https://docs.cloud.google.com/logging/docs/audit
- Google Workspace, Export search results: https://knowledge.workspace.google.com/admin/security/export-search-results
- Okta System Log: https://help.okta.com/oie/en-us/content/topics/reports/reports_syslog.htm
- Okta, Exporting Okta Log Data: https://support.okta.com/help/s/article/Exporting-Okta-Log-Data
- GitHub, Reviewing the audit log for your organization: https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization
- GitHub, Exporting audit log activity for your enterprise: https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/exporting-audit-log-activity-for-your-enterprise
- Datadog Audit Trail: https://docs.datadoghq.com/account_management/audit_trail/
- Splunk, Search audit logs for ACS activity: https://help.splunk.com/en/splunk-cloud-platform/administer/admin-config-service-manual/10.5.2605/administer-splunk-cloud-platform-using-the-admin-config-service-acs-api/search-audit-logs-for-acs-activity
- Kibana audit logging (ECS fields): https://www.elastic.co/guide/en/kibana/current/xpack-security-audit-logging.html
- Elasticsearch audit event fields (secondary): https://oneuptime.com/blog/post/2026-01-21-elasticsearch-audit-logging/view
- CrowdStrike Falcon audit events (secondary): https://docs.sekoia.io/integration/categories/endpoint/crowdstrike_falcon/ and https://rules.fluencysecurity.com/auto-documentation-models/crowdstrike/falcon-user-activity.html
- Cloudflare, Review audit logs: https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/
- Atlassian, Export audit log: https://support.atlassian.com/security-and-access-policies/docs/export-audit-logs/ and bug ACCESS-2781: https://jira.atlassian.com/browse/ACCESS-2781
- Vercel Audit Logs: https://vercel.com/docs/audit-log
- NIST SP 800-53 Rev 5 (official OSCAL catalog, AU family): https://github.com/usnistgov/oscal-content/blob/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json and https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
- NIST SP 800-92, Guide to Computer Security Log Management: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-92.pdf
- PCI DSS v4.0 Requirement 10 (as reproduced by Microsoft): https://learn.microsoft.com/en-us/entra/standards/pci-requirement-10
- ISO/IEC 27001:2022 A.8.15 (secondary): https://www.isms.online/iso-27001/annex-a-2022/8-15-logging-2022/
- SOC 2 CC7.2 (secondary): https://kirkpatrickprice.com/?p=14759
- CIS Control 8: https://www.cisecurity.org/controls/audit-log-management and (secondary) https://www.tripwire.com/state-of-security/cis-control-08
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OWASP CSV Injection: https://owasp.org/www-community/attacks/CSV_Injection
