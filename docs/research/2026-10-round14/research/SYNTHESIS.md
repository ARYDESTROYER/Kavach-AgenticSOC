# Round 14 synthesis: what to build, what the operator chooses, how we prototype it

Date: 2026-10-25. Branch `claude/round12` at `a966b0d` (fresh from Testing after Round 13).
Status: research synthesis only. No product code changed.

Inputs, all in this folder:

| Brief | Covers |
|---|---|
| `runbooks-industry.md` | Ask 9: industry practice, standards, ASP, the proposed one Runbooks feature |
| `runbooks-codemap.md` | Ask 9: every place playbooks and runbooks live today, blast radius, migration |
| `audit-log.md` | Ask 2: today's page, industry and standards, layouts A/B/C, export |
| `dashboards.md` | Ask 3: three built-in dashboards, widgets, the one new endpoint |
| `chat-drilldown.md` | Asks 6 and 7: rule drill-down and severity breakdown, options 6A-C and 7A-C |
| `small-asks.md` | Asks 1, 4, 5: sign-out wording, Overview band headers, chat capacity |
| `nav-animation.md` | Ask 8, part 1: the left navigation, defects D1-D11, options A/B/C |
| `ui-audit-a.md` | Ask 8, part 2a: triage and reporting pages, findings X1-X19, primitives |
| `ui-audit-b.md` | Ask 8, part 2b: configuration pages and Settings, findings Y1-Y13, Settings A/B |

Path abbreviations used below (all absolute):

- `SP` = `<scratch>`
- `SHOTS` = `SP/r14/shots/research` (research screenshots and option mockups)
- `UIA` = `SHOTS/ui-a`, `UIB` = `SHOTS/ui-b`, `NAV` = `SHOTS/nav`
- `OP` = `SP/r14/operator` (the operator's own screenshots; PNG copies of two of them are in `SP/r14/notes/drill/op-top-rules.png` and `op-case-entity.png`)

Third-party screenshots in `SP/r14/notes/rbshots/` (ASP, Sentinel, Splunk) are for internal
comparison only and must never be committed.

---

## 0. Summary

1. **Two asks have no real design choice** and get a single before and after example:
   ask 1 (sign-out sentence without a duration) and ask 5 (triple the chat capacity
   values). Both are small.
2. **Eleven design choices need the operator** (section 2, C1 to C11), each with two to
   four options and a recommendation. Ask 4 has a real choice (row spacing), so it is not
   in the "no choice" group.
3. **Ask 9 (Runbooks) and ask 8 (UI polish and navigation) are the two big pieces.** Ask 9
   replaces two engines, two stores, two permission resources and two pages with one
   Runbooks feature whose centre is a per-case checklist; ask 8 is a navigation rebuild
   plus a shared-primitives convergence of about 40 views.
4. **The asks depend on each other in three places**, which drives the order of work:
   - The shared `Panel`, `KpiStrip`, table and header primitives (ask 8) should land
     before the new screens of asks 2, 3 and 9, so those are built once in the final
     grammar.
   - `GET /api/metrics/breakdown` (ask 3) and the read-only rule summary (ask 6) both sit
     on `engine/case_aggregate.py`; build the breakdown once and reuse it in the rule
     sheet, the dashboards' "Top detection rules" and the case-side severity breakdown
     (ask 7).
   - The rule drill-down sheet (ask 6) is the click target for every rule name, including
     the new dashboard widgets (ask 3).
5. **Prototype in four parallel units after one small shared step** (section 3): a
   dev-only preview switch (the Round 13 `?separation=` pattern, generalised) for options
   that live in real pages, and a dev-only preview route with fixture data for options
   that need backend data that does not exist yet (Audit record fields, built-in
   dashboards, rule sheet, severity cross-tab, Runbooks). Nothing reaches production
   bundles.
6. **Implementation runs in five waves** (section 4): backend contracts first and
   sequenced on shared files, one generated-types step, then web packages with exclusive
   file ownership, then page migrations, then documentation and gates.
7. **Several defects should be fixed whatever the operator chooses** (section 1.10), for
   example the hidden close button on the case detail sheet, clipped dashboard widgets,
   the Audit Build column, the hyphen gaps caused by global tabular figures, and three
   bundled playbooks silently truncated in the investigator prompt.

---

## 1. Per ask: recommendation, evidence, risks, size

Size scale: XS (one small package, under a day of agent work), S (one package), M (one
large or two small packages), L (three or four packages), XL (five or more packages and a
migration). Every package follows the Round 13 cycle: implement, two adversarial reviews,
fix, gates.

### 1.1 Ask 1: no duration in the automatic sign-out notice

**Recommendation.** One neutral sentence for the time-limit case: "For your security, you
were signed out. Sign in to continue." It applies to `absolute_expired` from the server
and from the device marker (remembered session that ran out while the browser was
closed), and to any unknown non-empty reason so a future server reason is never silent.
The idle, revoked and all-sessions sentences already state a reason, not a duration, and
stay. Remove the client's `lifetimeSeconds` plumbing (it becomes dead), keep
`formatRememberDuration` for the Remember me hint and the admin session editor, keep
emitting `lifetime_seconds` from `/auth/me` (no API change) and document that the console
ignores it. Add a regression test: no notice, for any reason and any lifetime, contains a
digit or the words hour, minute or day.

**Evidence.**
- One wording table builds every notice: `webui/src/soc/components/auth/rememberMe.ts:183-201`
  (the "after ${formatRememberDuration(...)}" branch is at `:189-190`); the server sends
  `lifetime_seconds = exp - iat` at `backend/app/api/routes.py:3570-3580` (`small-asks.md` 1.2).
- Guidance agrees on giving no duration after the fact and stating it only before the
  task: HMRC "For your security, we signed you out"
  (https://design.tax.service.gov.uk/hmrc-design-patterns/service-timeout), WCAG 2.2 SC
  2.2.6 "displayed to the user once at the beginning"
  (https://www.w3.org/WAI/WCAG22/Understanding/timeouts.html), OWASP Session Management
  (https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
  NIST SP 800-63B-4 section 5.2 (https://pages.nist.gov/800-63-4/sp800-63b/session).
- Screenshots: `SHOTS/signout-current-absolute-light.png` (today) and
  `SHOTS/signout-proposed-absolute-light.png` (proposed), each also `-dark.png`.

**Risks against the non-negotiables.** None. Session enforcement is unchanged. One tension
to confirm: the sign-in page's Remember me hint still says "Stay signed in on this device
for up to 24 hours" (`ui-audit-b.md` LI1). The research recommends keeping it, because it
is a disclosure before the person opts in, which is where WCAG wants a duration.

**Size.** XS. Web only: `rememberMe.ts`, `RememberMeControls.tsx`, `auth.tsx`,
`Login.tsx:464, 811`, a `types.ts` comment, comment-only edits in `routes.py:3574` and
`auth/tokens.py:77`; test `webui/src/soc/__tests__/login.remember.test.tsx:761-799`; docs
`docs/administration/authentication.md:45-48`; Help Center corpus regeneration.

### 1.2 Ask 2: an Audit log you can open, filter and export

**Recommendation.**
- Rebuild the page as a server-paged queue with three scopes in a segmented control:
  **People and settings** (default), **Agent activity** (one investigation's rows grouped
  into one expandable row) and **All**. Friendly event names grouped by category, an
  Outcome column (text plus glyph), absolute times with the zone in the column header,
  URL-backed filters with the shared `TimeRangePicker`, facet menus, removable chips and
  server-side search. Build, Surface and Model move out of the table into the detail.
- Clicking a row opens a detail view (layout is choice C1) with Who, What changed (Field,
  Before, After; secrets shown only as "changed"), Details (full summaries, the
  reproducible query in a code block, `tool_input` as a JSON tree), Record (ids, build),
  Raw record (Copy JSON), Related (same actor within 15 minutes, same target, same case,
  the session's sign-in), Copy link, and J/K for previous and next.
- Export menu in the header: "Export CSV" and "Export JSON Lines" of exactly the current
  scope, filters, search and range, confirmed in a dialog with the count; delivered as a
  new Job kind `audit_export`, capped at 100,000 rows per file, oldest first, ISO 8601
  UTC; gated by a new `audit:export` permission (super admin, SOC manager and Auditor)
  with fresh sign-in; CSV formula defusal extended to line feed and full-width lookalikes;
  the export is audited when requested, when assembled (size and SHA-256) and when
  downloaded. Add download auditing to `GET /api/jobs/{id}/artifact` for every job kind.
- Record additions on new rows only (legacy rows are never backfilled): `outcome`,
  `actor_type`, `action`, `client {ip, user_agent}`, `session_ref`, `target {type, id,
  label}`, `changes [{field, before, after}]`, `request_id` and, for agent rows, `run_id`.
- In Demo Mode, People and settings reads the real control store and Agent activity
  reads the demo store, each labelled, so sign-ins and admin changes become visible.

**Evidence.** No row handler (`webui/src/soc/pages/Audit.tsx:445-473`), 200-row window
(`Audit.tsx:50`), API cap 500 with `total = len(rows)`
(`backend/app/api/routes_search.py:189, 203`), browser-only search (`Audit.tsx:194-214`),
Demo Mode store split (`backend/app/state.py:502-513`), thin record
(`backend/app/models.py:1855-1882`), no view or download auditing
(`backend/app/api/routes_jobs.py:626-650`). Standards: NIST SP 800-53 AU-3, AU-7(1), AU-9;
PCI DSS v4.0 10.2.1.3, 10.2.2, 10.3; OWASP Logging and CSV Injection (URLs in
`audit-log.md` section 5). Industry: CloudTrail, Purview, Entra, Datadog, Okta, GitHub,
Vercel (exports audited, `previous`/`next` values), Atlassian (export ignoring UI filters,
the cautionary tale). Screenshots: `SHOTS/audit-light-1440*.png`, `SHOTS/audit-dark-1920*.png`
and the three option mockups `SHOTS/audit-option-{A,B,C}-light-1440.png`.

**Risks against the non-negotiables.**
- #2 append-only: no update or delete path; new fields are written at append time;
  paging and export are reads.
- #9: summaries, prompt excerpts (which carry the untrusted log fence), query text, tool
  input, IP and user agent are attacker-influenceable and render as plain text only; the
  JSON viewer builds text nodes.
- Elasticsearch: bootstrap creates missing templates only and never remaps (AGENTS.md
  section 5), so new string fields on an existing index map dynamically as text and term
  filters would silently miss. The template must add keyword mappings, the docs must tell
  existing deployments to roll the write index, and filters must use `.keyword` until then
  (`backend/app/es/indices.py:77-85` documents the same trap for `source_id`).
- #12: SQL needs no migration (filters pushed down through JSON accessors).
- Privacy: client IP and user agent are personal data and will appear in exports, so the
  permission, fresh sign-in and documentation matter.
- Auditing views of the audit log adds rows to the log itself; coalesce to one row per
  user per distinct filter per 5 minutes.
- No exposure for #3, #6 or #7.

**Size.** L: two backend packages (read API and paging; record fields and export job),
one web package, one documentation package (new Help Center page, permissions, background
jobs, API reference).

### 1.3 Ask 3: three built-in dashboards beside the landing page

**Recommendation.**
- The Cyber Defence Center stays the landing page and is listed first in the Dashboards
  section (selecting it opens `#/overview`). Three read-only built-ins follow, each in the
  Overview grammar (a KPI strip on its own panel, modules on borderless panels, no nested
  cards, a population caption on every module, a "View ..." exit), each with one
  page-level time picker:
  - **SOC operations** (last 24 hours, compared with the previous 24): open now, awaiting a
    human decision, unassigned, SLA breached, MTTA and MTTR p50; arrivals vs closures, who
    closed, needs attention now, analyst workload, backlog aging, SLA breaches, open cases
    by status, response timing.
  - **Detection and data health** (last 7 days): sources reporting, silent sources, events
    per minute, alerts ingested, alert reduction, ATT&CK techniques seen; alerts and cases
    over time, noise reduction, top detection rules, noisiest rules, connector health,
    cases by source, techniques seen in cases (never called "detection coverage"), top
    techniques, auto-close health.
  - **Executive summary** (last 30 days vs the previous 30): cases, confirmed threats,
    MTTD and MTTR p50, closed by the AI agent, SLA attainment; cases by severity over time,
    active risk index, outcomes over time, who closed, top techniques, cases by source, AI
    spend, active campaigns. No "analyst hours saved" figure (it would be invented).
- Built-ins are defined in code with reserved ids `builtin:<slug>` (the server rejects a
  user board with that prefix), cannot be edited or deleted, offer **Duplicate to
  customise** through the existing `POST /api/dashboards`, and can be hidden per user
  (`UserPrefs.misc.dashboards_hidden`). The per-role default becomes "My dashboard" (keep
  its id `overview`). Presentation is choice C2.
- One new read-only endpoint, `GET /api/metrics/breakdown?by=rule|source|severity|...&window_hours=&top=&bucket=`,
  a thin wrapper over `aggregate_cases` (`backend/app/engine/case_aggregate.py:1405`), gated
  on `metrics:view`. About 12 new widget types follow the existing contract
  (`webui/src/soc/dashboard/widget-types.contract.json`, server allowlist
  `backend/app/api/routes_dashboards.py:71-80`).
- Fix the three defects found in today's section: the Needs-human widget counts only
  status `open` ("0 open" against the Overview's 20, `webui/src/soc/dashboard/widgets/kpi.tsx:23-24`);
  no time picker (every widget silently reads 168 hours, `DashboardBuilder.tsx:429-433`);
  nested bordered tiles and clipped widget bodies (`WidgetGrid.tsx:156, 381`).

**Reading of the ask.** "Create three default dashboards, the one we have currently ... but
add 3 more" is read as: the current landing page plus three new built-ins, four listed in
total. Confirm with the operator.

**Evidence.** Dashboards are per user only, the default is a per-role widget set named
"Overview" (`webui/src/soc/pages/Dashboards.tsx:52-69`, `webui/src/soc/dashboard/registry.ts:392-409`).
Splunk ES (Executive summary, SOC operations, Security posture), Sentinel (Security
Operations Efficiency, Data collection health), Cortex XSIAM ("System dashboards ... can't
be edited or deleted", duplicate to edit), Google SecOps curated dashboards (copy to
customise) and Elastic (Detection & Response, Data Quality) all split operations,
detection and data health, and executive views (URLs in `dashboards.md` section 5).
Screenshots of today: `SHOTS/dashboards-*.png`.

**Risks against the non-negotiables.** #6: no widget calls a model; the billing
`GET /api/standup` stays excluded, the deterministic `GET /api/standup/report` is used.
Under #7, aggregates and case rows only, never raw log rows; #9: rule ids, source names,
technique names and case titles render as plain text; #3 untouched. Row-level data scope
(`can_object`, shipped off) is not applied by the aggregate endpoints, so case-derived
built-in panels should be hidden while it is on. No new store; widget bodies stay lazy.

**Size.** L: endpoint S, widget types L, Dashboards shell M.

### 1.4 Ask 4: remove the two Overview band headers and reclaim the space

**Recommendation.** Delete both band headers ("Alert flow" and "Cases and response") and
set the gap between every Overview row to the panel gutter (choice C3, option B). Move the
one fact the captions carried that is said nowhere else ("the N in Total Cases above")
into the flow panel as a quiet footer line, the pattern Human vs AI already uses; add a
short window caption to the flow and Response time titles; keep one "Updated" stamp in the
page header, computed from the OLDEST of the independently loaded slices so it never
claims more freshness than a card has. Replace `Band` with plain `div`s carrying
`data-band` hooks, make the flow panel a labelled section, and update print CSS
(`webui/src/styles/theme.css:1896-1901`), three test files, the ui-standard "Dashboard
bands" section, the Overview Help Center page and USAGE together.

**Evidence.** `Band` at `webui/src/soc/pages/Overview.tsx:1576-1614`, used at `:3882-3891`
and `:3984-3989`; each header is 56 px (96 px on a phone). Option B shortens the page by
172 px at 1440, 168 px at 1920 and 264 px at 390; at 1440x900 the cases row starts at 777 px
instead of 929 px, above the fold (`small-asks.md` 4.2). Every module already has its own
visible `h2`. Screenshots: `SHOTS/overview-annotated-1440x900-light-full.png` (today, the
headers outlined), `SHOTS/overview-opt{A,B,C}-*.png`.

**Risks.** None against the non-negotiables. Keep the Round 12 honesty rule for freshness
(hence the oldest-slice stamp).

**Size.** S.

### 1.5 Ask 5: triple the chat "Timeouts and capacity" defaults

**Recommendation.** New defaults: Lookups at once 4 to 12, Lookup timeout 15 s to 45 s,
Model call timeout 300 s to 900 s, Questions at once per user 4 to 12, Questions at once
in total 16 to 48. Raise the maximum bounds that would otherwise clamp or pin the new
defaults: `max_parallel` 8 to 24, `max_concurrent_turns_per_user` 10 to 24,
`model_step_timeout_s` 900 to 1,800. A staged `chat_limits_version` 2 migration moves
only stored values still equal to the old defaults (an administrator's own choice stays),
chained after the Round 12 step, in both limits modes. Update the stale client fallback
`DEFAULT_CHAT_BOUNDS` (`webui/src/soc/chat/chat-api.ts:213-227`, still says 30 s). In the
same round, cap the report AI summary wait below the Web UI proxy's 300 s
(`min(2 x step, 280 s)`), because tripling widens an existing mismatch.

**Evidence.** Defaults and bounds at `backend/app/config.py:1644-1682`, Round 12 migration
pattern `CURRENT_CHAT_LIMITS_VERSION = 1` at `config.py:1536` with the staged logic at
`:1532-1599`; editor `webui/src/soc/pages/settings/chat-agent.tsx:300-312` with bounds pinned
to the backend by a test; report summary timeout `backend/app/api/routes_reports.py:131-133,
1705-1706` against `webui/nginx.conf:58-68`. Screenshots: `SHOTS/chatcap-current-1440.png`
and `SHOTS/chatcap-tripled-preview-1440.png`.

**Risks.** #10: a default change; chat stays outside the AI budget as decided in Round 12,
and every call still goes through the one gateway (#6). Load: worst case 48 questions x 12
lookups = 576 concurrent read queries on the read-only key (#1 holds; the Elasticsearch
search queue absorbs a burst but slows other readers). Model provider token-per-minute
limits on low tiers (429s are retried; the circuit breaker is advisory by default).
Memory: about 240 MB worst case per backend process for the per-turn event rings
(process-local). A silent stream now waits 15 minutes before its retry.

**Size.** S.

### 1.6 Ask 6: clicking a rule shows that rule's picture

**Recommendation.** Every rule value in the Console becomes a button that opens a **rule
drill-down sheet** (choice C4, option A) with: key figures (alerts, exact or "at least";
cases from the rule; still open; analyst outcome TP / FP / not graded; first and last
seen), alerts over time by named severity, top source IPs and targets, the latest five
alerts (shown to the person only), linked cases, rule facts ("Defined in the source SIEM"
or the suite rule with a Rule settings link, tuning state, analyst policy, MITRE) and Ask
AI. Its primary action, **Open all N in Logs**, is option B: the Logs page with an exact
Rule filter chip. The chat rule table also gains a row action and a small per-row trend.
Fix the stray tooltip on block titles. The same sheet opens from the Case Manager facts
rail, Logs row details, Tuning, Overview and the new dashboard widgets through one shared
`RuleLink`.

**Evidence.**
- Both operator blocks come from the same `log_stats` tool
  (`backend/app/agents/chat_tools/logs.py:1315-1326`); the block format already has a per-label
  `drill` list that no tool sets, the table view drops it (`backend/app/agents/blocks.py:2560-2579`),
  and `TableView` passes no row action although `DataTable` supports one
  (`webui/src/soc/components/DataTable.tsx:140`).
- The tooltip is the browser's own `title` on a full-width truncating heading
  (`webui/src/soc/chat/blocks/BlockCard.tsx:824-829`): text 130 px, hover box 606 px.
- Elastic rule details, Splunk "Top Notable Events" drilling into Incident Review scoped
  to the rule, Sentinel's rule Insights tab, Google SecOps Rules Dashboard and Datadog's
  Rules List all treat a rule as a place with a trend, its alerts and its definition
  (URLs in `chat-drilldown.md` section 4).
- Seen in the operator's own screenshot (`SP/r14/notes/drill/op-case-entity.png`, this
  synthesis): the Case entity block names the case by its internal id
  (`case-95928c251fb6...`) rather than its case number, and Status history prints
  `open -> escalated` and the raw reason "tp auto-close disabled". Both should use case
  numbers and plain words (the same rule as `ui-audit-a.md` X11).

**Risks.** #1: every read goes through the existing read-only routes and connector
aggregates. #7: raw alert rows are shown to the person only and never enter a prompt or a
stored answer; an answer stores only the aggregate block and the link. #9: links are built
by code from validated `InternalRef`s (`NavRefOpts`, `blocks.py:604-627`), rule names stay
plain mono text, and `provenance="ai"` blocks never get links (`blocks.py:753`). #3 and #6
untouched; Ask AI is an ordinary metered chat turn using the existing fenced `rule` entity
question (`backend/app/agents/chat_entity.py:63, 183`). Each sheet section checks its own
grant. The Demo planner must emit the same blocks and links.

**Size.** M on its own; L together with ask 7 (they share the backend work).

### 1.7 Ask 7: a severity breakdown a person can use

**Recommendation.** Everywhere a severity breakdown appears (chat `log_stats`, chat
`case_stats` and `soc_metrics`, the new dashboard widgets): named levels from the one
ladder with the raw value in brackets, as the Logs page already shows (`Medium (30)`);
each source's values projected through its own `severity_scale_max` before sources are
merged; all five levels in fixed order with zeros; a share column; an honest caption
("1,000 of 2,500 events sampled, newest 200 per source") whenever the bars do not cover
the stated total; every level clickable into the exact filtered list. Default rendering
is choice C5 option A (a table with the top rules of each level), with option B's "Split
by" control added when the server returned more than one split. Backend: a two-level
severity then rule aggregation for aggregate-capable sources, a sampled cross-tab
otherwise; the case side uses `case_aggregate`'s multi-field grouping and is exact.

**Evidence.** Labels are bare numbers because the categories label is the raw numeric
`severity` (`backend/app/agents/chat_tools/logs.py:379, 1320`), while the console ladder is
at `webui/src/soc/components/badges.tsx:91-98`; the newest-200-per-source sample is
`_STATS_SAMPLE` (`logs.py:105`). Elastic's alert Summary, Counts and Treemap views, Splunk's
urgency drill-down and Datadog's facet panel all pair named severities with a second
dimension (`chat-drilldown.md` 4.2). Screenshot of today: `SHOTS/drill-severity-viewport.png`.

**Risks.** Honesty (sampled versus exact must always be said); #9 as in ask 6; no #3, #6
or #7 change.

**Size.** M.

### 1.8 Ask 8: UI polish, starting with the left navigation

**Recommendation, navigation.** Rebuild the rail as a docked rail with an explicit toggle
and a stable morph (choice C6, option A):
- one DOM for both states, icons one size and never moving, labels clipped and faded;
- the in-flow spacer changes width once at the click, the visible panel animates only
  `transform` and `opacity` (`ease-standard`, 200 ms open, 160 ms close);
- one persistent toggle in a fixed slot, so focus stays on it;
- flyouts open after 300 ms of pointer rest (not dwell), close after a 400 ms grace, keep
  a safe triangle, open immediately on keyboard focus-visible and never on a pointer click;
- a rail-local tooltip provider (300 ms, no skip delay);
- nav state moved out of the 2,128-line AppShell into a small external store;
- `scrollbar-gutter: stable`, the mobile Sheet fixes, and four regression guards (icon x
  constant during a toggle, focus kept, zero flyouts in a 1 s sweep, no flyout on click).

**Recommendation, the rest of the Console.** Converge every page on the Overview grammar by
changing shared primitives, not page by page: a `Panel` primitive (and `ChartCard` and
`KpiTile` moved onto it), `PageHeader` defaults (no icon chip, no overline or breadcrumb,
explanation in a help tip, controls in `meta`), one `KpiStrip` (ink numerals, red only for
a non-zero critical count), sentence-case table headers with compact density, a right-edge
fade and an empty state, underline tabs for page sections, one `FilterBar`, one
`RefreshButton` plus `TimeRangePicker` placement, `fmtDuration` and `caseLabel` helpers,
one `PageContainer` rhythm; for Settings, `SettingsSection`, `SettingsGroup`, `SettingRow`,
a content-sized `NumberField` and a constrained `Callout` (choice C9); `ListRow`,
`RowActions` and `StatusDot` for record lists; proportional figures on `body`; one name
per destination; retire the hidden Automated scans page; a guard test so pages do not
drift back. Surface and header choices are C7 and C8.

**Evidence.**
- Navigation: the item tree swaps in the first frame and the width animates twice as
  layout (`webui/src/soc/components/NavSidebar.tsx:917-956, 862-865`,
  `webui/src/soc/AppShell.tsx:1509-1522`); the toggle remounts and drops focus
  (`NavSidebar.tsx:901, 905-907`); the flyout dwell is 100 ms (`NavSidebar.tsx:463`). In a
  production build at 4x CPU slowdown about 110 ms of the 200 ms transition is one long
  frame; at 6x the transition is skipped (`NAV/perf/prod-overview-*.json`). Evidence
  sheets: `NAV/sheets/d1440l-collapse.png`, `d1440l-expand.png`, `d1440d-tooltip-trail.png`,
  `d1440l-click-group-flash.png`, `m390l-navigate.png`. Industry: shadcn/ui sidebar (one
  DOM, icons never move), Fluent 2 and Material 3 rails, GitLab's walked-back hover peek,
  NN/g hover timing (https://www.nngroup.com/articles/timing-exposing-content/), web.dev
  (https://web.dev/articles/animations-guide).
- Pages: three visual dialects (Overview has 7 panels and 0 bordered cards; other pages 0
  panels and up to 20 bordered cards); nested cards (9 on Standup, 8 on Analytics
  Performance); header heights 46 to 236 px; thirteen KPI tile styles across both groups;
  `body { font-variant-numeric: tabular-nums }` at `webui/src/styles/theme.css:336` widening
  hyphens ("Auto - tuning"); Settings with four grammars and the first control about 400 px
  down a 900 px screen (`ui-audit-a.md` sections 1 and 4, `ui-audit-b.md` sections 1 and 4;
  previews `UIA/P-*-converged-*.png`, `UIB/P-*.png`).

**Risks.** No backend and no non-negotiable is touched. Accessibility improves (WCAG 2.2
SC 2.4.3 focus order, reduced motion kept as instant layout and opacity-only overlays).
Two real risks:
- **Entry bundle budget.** `NavSidebar` and `AppShell` are in the entry chunk, which is at
  371,859 B against a budget of `PRE_REVAMP_ENTRY_BYTES` 371,003 B plus 1,024 B, that is
  372,027 B (`webui/src/soc/__tests__/bundle-first-paint.test.ts:117, 192-202`), so only
  about 168 B of headroom remain. The nav rewrite must be byte-neutral or the baseline
  rebased with a recorded justification, as Round 13 did once.
- **Test churn.** Primitive changes ripple through many DOM and snapshot tests; the
  `test:strict` zero-stderr rule and jsx-a11y at error stay in force.

**Size.** XL: navigation M, shared primitives L, two page-migration passes L each,
Settings L.

### 1.9 Ask 9: one Runbooks feature, rebuilt from scratch

**Recommendation.**
- **One feature, one word.** Intelligence, **Runbooks**. Remove "Reference runbooks" and
  "Response playbooks" (and the hidden `catalog` alias page) and never show "playbook" in
  the Console again. Define the word on the page: "Runbooks are your team's step-by-step
  response procedures. The matching runbook is attached to each case that needs a person.
  Analysts work through it as a checklist; the AI runs the read-only lookups and suggests
  notes. A runbook never closes a case; your case policy does that."
- **The centre is the per-case run**, a checklist inside the case (choice C10), built on
  the existing `CaseTask` store pattern: pinned runbook version, per-step status (To do,
  In progress, Done, Not applicable with a reason, Blocked), assignee, notes, evidence
  (lookup results labelled "Collected automatically"), optional second-person approval,
  AI drafts flagged "AI draft" until a person confirms; today's free-form Case tasks move
  in as "Other tasks"; a progress chip ("4/11") in the case header and the queue; a "Next
  step" card. Closing a case by hand with required steps open asks for a short reason
  that is audited; `decide()` and auto-close never look at runbook state.
- **Five step kinds**: Check (a person verifies, with "escalate if" and "benign if"),
  Lookup (a declarative read-only query the suite runs with existing read-only tools),
  Decision (a person picks an option that can mark later steps Not applicable), Action (a
  person acts in another system and records who, when, where, outcome; the suite never
  executes it), Record (notify, document, hand off).
- **Deterministic, explainable matching**: today's playbook contract (rule ids, entity
  types, minimum event count, MITRE, tags) plus severity, source, verdict and status; most
  specific wins, then priority, then version; attach once per case and runbook;
  re-evaluate when the case changes; store and show why it attached; a generic "Generic
  incident (NIST 800-61)" fallback; an optional AI suggestion a person must accept; "Which
  cases would this match?" in the editor without attaching anything.
- **Governance**: Draft, In review, Published, Retired; a `runbooks:publish` permission;
  optional "approver must differ from author"; review-due dates; immutable version history
  with diff and restore-as-draft; built-ins read-only with "Duplicate to customise"
  (`derived_from`). Editor experience is choice C11.
- **AI, bounded**: suggest a runbook when nothing matches, run Lookup steps, draft a note
  for a Check step, answer "what's next on this case"; never tick a human step, never act,
  never change verdict, status, `AutoClosePolicy` or `decide()`. The investigator receives
  only **Published** runbook text as trusted operator guidance, through a new
  `<<<RUNBOOK>>>` fence that replaces the `<<<PLAYBOOK>>>` block, with one prompt budget
  enforced for bundled content by a test.
- **Library**: about 12 built-ins merging today's 18 files (phishing, malware, ransomware,
  brute force and password spray, compromised account, cloud identity and keys, data
  exfiltration, web application attack, scanning, suspicious outbound, privileged misuse
  and insider, generic incident), each mapped to NIST SP 800-61r3 and SANS phases, ATT&CK,
  D3FEND and RE&CT, written in the Elastic "question, focus, implication" step shape.
- **Format**: Markdown with front matter as the native, diffable format; CACAO v2.0 JSON
  export later (ROADMAP).
- **Migration**: one-shot, idempotent, audited conversion of stored operator playbooks and
  runbooks at startup (or as a visible Job), a marker document so it never runs twice, the
  legacy KV documents kept read-only for one release, both old and new groups in the
  export for that release, and aliases for every wire identifier (section 4.6).
- **From ASP** (asp.viperrtp.com, an unrelated open-source product): one-button "Start
  runbook" with a searchable picker and the match pre-selected; run records with status,
  who, when, duration and result; drafting a runbook only from a human-confirmed closed
  case (a later round). ASP itself has no checklist, phases, approvals or versioning.

**Evidence.**
- Two engines with the same content: 9 bundled playbooks and 9 bundled runbooks covering
  the same families (`runbooks-codemap.md` section 1). A playbook is selected per cluster and
  injected as a trusted block (`backend/app/playbooks/registry.py:180-256`,
  `backend/app/agents/prompts.py:479-494`); a runbook only reaches the model if retrieval
  happens to rank it (`backend/app/tools/rag.py:596`).
- Defects today: three bundled playbooks render at 2,934 to 3,113 characters against the
  2,400 budget and lose their tail (`prompts.py:492`); `suggested_tools` and `llm_select`
  do nothing although the Console shows "Suggested tools"; in Demo Mode "Run a playbook"
  re-investigates without a playbook but toasts "Playbook applied"
  (`backend/app/engine/demo_runtime.py:240-244`, `webui/src/soc/pages/CaseDetail.tsx:963`,
  inferred from code); a new runbook form opens with "17 fixes"; operator playbooks cannot
  be deleted; the Help Center says operator playbooks live in a directory; replay uses the
  live playbook registry (`backend/app/engine/replay/stack.py:546`).
- Industry: Splunk ES response plans and SOAR workbooks, Microsoft Sentinel incident tasks,
  Cortex XSOAR Work Plan, TheHive case templates, Elastic investigation guides, FireHydrant
  runbook conditions, Torq runbook-driven AI; standards NIST SP 800-61r3 section 2.3 and
  RS.AN-06, CISA playbooks' companion checklist, OASIS CACAO v2.0, RE&CT, D3FEND (URLs in
  `runbooks-industry.md` section 11). Screenshots of today: `SHOTS/runbooks-*.png`; references
  `SP/r14/notes/rbshots/` (do not commit).

**Risks against the non-negotiables.**
- #3: runbooks, steps, decisions and completion never feed `decide()` or
  `AutoClosePolicy`; the close-reason prompt is a human workflow outside the policy.
- #9 is the critical boundary: only Published runbooks are trusted; publishing needs its
  own permission; imported and AI-drafted runbooks start as Draft; every case value,
  template value, lookup result and note is fenced untrusted. The marker normaliser
  already neutralises any `<<<NAME>>>` token in untrusted text, so `RUNBOOK` is covered on
  day one (`prompts.py:66-127`).
- #2: attach, step change, note, evidence, approval, skip reason, version switch, publish
  and retire each write an append-only audit row; old audit actors (`playbook_selector`,
  `procedure_provenance`, `run_playbook`) stay readable by the case rationale forever.
- #4: one run per case and runbook, idempotent by key; re-investigation never makes a
  second run.
- #6 and #7: suggestion and drafting are gateway calls; matching and lookups are $0;
  lookup results are bounded and aggregated before any model sees them. #8: enrichment
  lookups go through the cached path. #1: lookups use the read-only client only.
- #10: library on and auto-attach on for human-facing cases by default; AI suggestion and
  drafts behind settings.
- #12: KV only (no new index or table); legacy namespaces stay readable; packaging must
  ship the new bundled library (a missed Dockerfile `COPY` silently disables bundled
  content, `backend/Dockerfile:44-45`).
- #11: build the pure matcher and its explainer first, fully tested offline.
- Naming contract: wire identifiers that contain "playbook" stay accepted (section 4.6);
  no new compatibility-prefixed identifiers.

**Size.** XL, the largest ask: three backend packages, two web packages, a migration, a
12-file library, about 94 test files to update or retire (40 backend, 54 Console) and about
40 documentation pages plus the generated Help Center corpus.

### 1.10 Defects to fix whatever the operator chooses

| Defect | Evidence | Fix | Package (section 4) |
|---|---|---|---|
| Case detail sheet close button painted over by the sticky header | `webui/src/ui/sheet.tsx:122-133`, `CaseDetail.tsx:1503-1510` | `z-30` on the sheet close button | W2 |
| Body tabular figures widen hyphens on every page ("Auto - tuning") | `webui/src/styles/theme.css:336` | proportional `body`, tabular only on numeric surfaces | W2 |
| Dashboard widgets clip their content; empty quarter of the grid | `webui/src/soc/dashboard/WidgetGrid.tsx:156, 381` | size to content, panels | W4 |
| Needs-human widget "0 open" while 20 are open | `webui/src/soc/dashboard/widgets/kpi.tsx:23-24` | use `open_now` and the verdict definition | W4 |
| Audit Build column wraps to 7 lines, 131 px rows | `webui/src/soc/pages/Audit.tsx:284-302` | fixed table layout (superseded by the rebuild) | W5 |
| Stray native tooltip over chat tables | `webui/src/soc/chat/blocks/BlockCard.tsx:824-829` | `title` only when truncated, hit box to text | W6 |
| Chat case entity shows internal case id and raw status text | `SP/r14/notes/drill/op-case-entity.png` | case number and plain words | W6 |
| Raw values "+18613m", "165h", "+8124%" | `Standup.tsx:709`, `Metrics.tsx:1293, 1346` | `fmtDuration`, overage durations | W2 helper, W8 pages |
| Models "Vision" chip twice; prices wrap | `ModelsCatalog.tsx:50-66` | de-duplicate, one price per line | W9 |
| Memory form Category and Tags misaligned | `Memory.tsx:213-237` | `Field` for both | W9 |
| Detection rules notice shows "(#3)" | `rules/DetectionRulesHome.tsx:323-330` | plain sentence | W9 |
| Auto-tuning prints raw backend text | `Tuning.tsx:168, 183-190` | reason-code sentences | W9 |
| Ten places use 10 px text | `EnrichmentProvidersEditor.tsx:211, 228`, `ModelsCatalog.tsx:170, 213`, `BaselineGauge.tsx:172, 233, 244`, `AppShell.tsx:877, 1420, 1676` | 11 px floor plus a guard | W2 guard, W3 and W9 fixes |
| Three bundled playbooks truncated in the prompt | `backend/app/agents/prompts.py:492` | superseded by the new library with a tested budget | B4 |
| Demo "Playbook applied" without a playbook | `backend/app/api/routes.py:6863-6887`, `demo_runtime.py:240-244` | superseded by ask 9 (demo parity) | B4 |
| Client chat fallback still says 30 s | `webui/src/soc/chat/chat-api.ts:213-227` | new defaults | W1 |

---

## 2. What the operator decides

### 2.1 The eleven design choices at a glance

| ID | Ask | Question | Options | Recommended |
|---|---|---|---|---|
| C1 | 2 | How does an Audit record open? | A side sheet, B inline row, C split pane | A |
| C2 | 3 | How do the built-in dashboards appear? | 1 grouped switcher, 2 tabs, 3 library page | 2 |
| C3 | 4 | How much space between Overview rows once the headers go? | A keep 40 px rows, B one panel gutter, C 24 px rows | B |
| C4 | 6 | What does clicking a rule open? | A rule sheet, B filtered Logs, C row expands in place | A, with B as its main action |
| C5 | 7 | How is a severity breakdown drawn? | A named levels with top rules, B "Split by" stacked bars, C rule by severity matrix | A, plus B's control |
| C6 | 8 | How does the left navigation behave? | A docked rail with a stable morph, B fixed rail with an overlay drawer, C labelled rail with no expansion | A |
| C7 | 8 | Do list pages sit on panels too? | 1 panels everywhere, 2 panels for dashboards only, lists flat | 1 |
| C8 | 8 | What does a page header carry? | 1 title and controls only (help tip), 2 plus one short description line | 1 |
| C9 | 8 | How is Settings laid out? | A grouped panels, B annotated two columns | A |
| C10 | 9 | How does a runbook look inside a case? | A flat checklist, B phased runbook, C guided next step | B, with C's "Next step" card on top |
| C11 | 9 | How is a runbook written? | A structured outline and step form, B Markdown with live preview | A, with a Markdown source view |

Every option below lists what its screenshot must show so the difference is obvious at a
glance. Section 3 says who builds each prototype and which files it touches.

### 2.2 C1, Audit record detail (ask 2)

| Option | In one line | The screenshot must show |
|---|---|---|
| A Side sheet | A 560 px inspector slides in from the right; from 1280 px it is non-modal, so the list stays live and J/K move the selection | The same selected row ("User role changed") with the list still readable behind it, the What changed table and the start of Raw record visible without scrolling at 1440; the full-screen sheet at 390 |
| B Inline row | The row opens in place into two columns (fields left, raw JSON right); the rows below move down | The expanded row pushing the following rows below the fold at 1440; two rows open at once (the compare case); the tall row at 390 |
| C Split pane | A resizable list on the left and the detail on the right, like Case Manager | The list losing its Summary column at 1440 and a narrower detail than A; the resize handle; 1920 dark where both fit comfortably |

Recommended: **A**. It is what security consoles use (Datadog, Purview, Entra), keeps all six
columns on a 1440 laptop, supports deep links and J/K, and the same inspector can serve the
Case trace and the Account page's activity. C is the better choice only if an auditor walks
events one by one all day; the detail content is identical in all three, so only the
container differs. Research mockups: `SHOTS/audit-option-A-light-1440.png`,
`SHOTS/audit-option-B-light-1440.png`, `SHOTS/audit-option-C-light-1440.png` (approximate
colours; the prototype must use the console's real tokens).

All three prototypes also show (identical, not part of the choice): the scope control
(People and settings, Agent activity, All), the Export menu, and the export confirmation
dialog with the row count.

### 2.3 C2, how the built-in dashboards appear (ask 3)

| Option | In one line | The screenshot must show |
|---|---|---|
| 1 Grouped switcher | Today's board picker in the header, grouped "Built-in" and "Yours", a Built-in label and a Duplicate button | The picker open with both groups, and a built-in board selected with its read-only label |
| 2 Tabs | A tab row under the title: Cyber Defence Center, SOC operations, Detection and data health, Executive summary, My dashboards (a menu of personal boards and New dashboard) | The tab row with SOC operations active at 1280 (all tabs fit), and the My dashboards menu open |
| 3 Library page | A gallery of cards (name, audience, one-line purpose, small preview, Built-in label); open one to view it | The gallery with four built-ins and two personal boards, then one board opened from it |

Recommended: **2**. Switching is one click, deep links work (`#/dashboards?d=executive`),
and four or five tabs fit at 1280 px. A library page pays off with many boards, not four.

Shown once for all three options (the board content does not depend on the choice): each
built-in board as a full page at 1440 light and 1920 dark, one board at 390, and the
Duplicate confirmation ("A copy does not update with new releases").

### 2.4 C3, Overview row spacing after the headers go (ask 4)

| Option | In one line | The screenshot must show |
|---|---|---|
| A 40 px rows | Remove both headers, keep today's 40 px (48 px from 1920) between rows | Full page at 1440 light with the 900 px fold drawn |
| B One gutter | Remove both headers; every row is one panel gutter apart (16, 20 or 24 px, like the gaps between panels in a row) | The same, showing the cases row starting above the fold |
| C 24 px rows | Remove both headers, 24 px between rows (32 px from 1920) | The same |

Recommended: **B**. The page reads as one grid of panels (the ui-standard rule that panel
padding and gutters grow together), it reclaims the most space (172 px at 1440, 264 px on a
phone) and brings the cases row above the 900 px fold. Existing previews already show the
three options: `SHOTS/overview-optA-1440x900-light-full.png`,
`SHOTS/overview-optB-1440x900-light-full.png`, `SHOTS/overview-optC-1440x900-light-full.png`,
plus 1920 and 390 variants and the annotated "before"
`SHOTS/overview-annotated-1440x900-light-full.png`. The prototype (section 3) adds the moved
footer line and the window captions, which those CSS-only previews do not show.

### 2.5 C4, what clicking a rule opens (ask 6)

| Option | In one line | The screenshot must show |
|---|---|---|
| A Rule sheet | A right-hand sheet: key figures, alerts over time by severity, top IPs and targets, latest alerts, linked cases, rule facts, Ask AI; main button "Open all N in Logs" | The operator's own answer ("Top detection rules") with one row clicked and the sheet open at 1440 light and 1920 dark; the full-screen sheet at 390 |
| B Filtered Logs | The Logs page opens with an exact "Rule = ..." chip and the answer's time window | The Logs page with the chip and only that rule's alerts, with Group by and Export visible |
| C Row expands | The table row opens inside the chat block: severity mix, top IPs, linked cases, and buttons to Logs, rule details and Ask AI | The expanded row inside the 42 rem reading column, and how cramped it is |

Recommended: **A, with B as its main action**, which answers both halves of "like a dashboard
or all alerts under that rule". B alone is a sensible first slice if time is short (A needs
it anyway). Research mockups: `SHOTS/drill-option-6A-rule-sheet.png`,
`SHOTS/drill-option-6B-filtered-logs.png`, `SHOTS/drill-option-6C-row-expand.png`.

### 2.6 C5, the severity breakdown (ask 7)

| Option | In one line | The screenshot must show |
|---|---|---|
| Before | Today: bare numbers `30.0` and `10.0`, bars that add up to 1,000 under a sentence that says 2,500 | `SHOTS/drill-severity-viewport.png` |
| A Named levels with top rules | A table: severity badge, events, share, trend, the top two or three rules as chips; a row expands to all its rules | All five named levels in order with zeros, the sampled caption, the top-rule chips |
| B "Split by" | Bars per severity stacked by a chosen second dimension (None, Rule, Source, Host) | The dropdown open with Rule chosen, the legend, one segment hovered |
| C Matrix | Rows are the top rules, columns the five levels, tinted counts, totals | The matrix in the reading column (and whether it needs the wide block mode) |

Recommended: **A by default, plus B's "Split by" control** when the server returned more than
one split, with C offered as a view of the same data. A table with named levels and top rules
gives a person a reference at once ("Medium is mostly web access and Entra sign-in"). All
options use the same data and must show the same caption and zero rows. Research mockups:
`SHOTS/drill-option-7A-named-bands-top-rules.png`, `SHOTS/drill-option-7B-split-by-stacked.png`,
`SHOTS/drill-option-7C-rule-severity-matrix.png`.

### 2.7 C6, the left navigation (ask 8)

| Option | In one line | The screenshot must show |
|---|---|---|
| A Docked rail, stable morph | 64 px icon rail or 240 px labelled drawer, chosen with one fixed toggle; icons never move; the page shifts once, at the click | Frame strips of a collapse and an expand (0, 40, 80, 120, 160, 200 ms) where icons stay put and labels fade, next to today's strip |
| B Fixed rail plus overlay drawer | The rail always takes 64 px; the labelled drawer slides over the page with a shadow and never pushes it; optional hover peek (off by default); a "Keep open" pin | The same frame strips with the page not moving, the drawer over content, and the pin control |
| C Labelled rail | A fixed 80 px rail with an icon and a short label under it; no collapse at all; groups open a menu on click | The rail at 1440 light and 1920 dark with one group menu open, and the short labels ("Scans", "Case Mgr") |

Every option also needs: a side-by-side video of the same toggle sequence, and the harness
table (icon drift in px during a toggle, where focus lands after a keyboard toggle, flyouts
opened by a 1 s pointer sweep, flash on clicking a grouped icon, longest frame at 4x CPU in a
production build). Today's evidence: `NAV/sheets/d1440l-collapse.png`, `NAV/sheets/d1440l-expand.png`,
`NAV/sheets/d1440d-tooltip-trail.png`, `NAV/sheets/d1440l-click-group-flash.png`; the rough
overlay prototype `NAV/sheets/optionB-proto-expand.png`.

Recommended: **A**. It is the smallest change to how operators already work, it is what the
ui-standard already promises ("the collapsed rail remains a stable 64px dock until the
operator explicitly expands it"), and it fixes the swap, the double layout animation and the
lost focus at the root. Hover never expands the rail.

### 2.8 C7, surfaces on list pages (ask 8)

| Option | In one line | The screenshot must show |
|---|---|---|
| 1 Panels everywhere | Every module, table and list sits on the Overview's tinted borderless panel; tables bleed to the panel edge | Cases, Logs and Sources at 1440 light and 1920 dark |
| 2 Panels for dashboards only | Dashboards and Analytics use panels; list pages (Cases, Logs, Campaigns, Sources, Audit) stay flat on the canvas, divider-led, like Case Manager | The same three pages, plus Analytics Operational (identical in both options) to show where the boundary falls |

Recommended: **1**. The operator asked for the dashboard's look to be followed everywhere,
one grammar is easier to keep from drifting, and the panel's text contrast is already gated
in both themes. Option 2 is reasonable if dense tables on a tint feel heavy. Rough previews of
option 1: `UIA/P-cases-converged-1440-light.png`, `UIB/P-sources-converged-1440-light.png`.

Both options share everything else from the page audit: no nested cards, one KPI strip,
sentence-case table headers, compact rows, underline tabs.

### 2.9 C8, the page header (ask 8)

| Option | In one line | The screenshot must show |
|---|---|---|
| 1 Overview header exactly | Title; time range, live and refresh beside it; freshness or the primary action on the right; any explanation in a help tip beside the title; the 30 px title from 1536 px on every page | Header crops (top 260 px) of Cases, Analytics, Sources, Standup, Settings and Audit, today versus option 1, with the measured top of the first content |
| 2 Plus one line | The same, plus one short muted description line under the title (13 px, never wrapping) | The same crops in option 2 |

Recommended: **1**. It is the Overview's header, today's descriptions mostly repeat the top
bar's breadcrumb, and it gains 20 to 40 px on every page. Both options drop the icon chip, the
overline and the breadcrumb on routed pages.

### 2.10 C9, Settings layout (ask 8)

| Option | In one line | The screenshot must show |
|---|---|---|
| A Grouped panels | Each group of settings is one panel with its title above it, rows divided by hairlines, the section capped at about 56 rem | Chat assistant, General and Data scope at 1440 light, 1920 dark and 390 light; where the first control starts; how far a switch sits from its label |
| B Annotated two columns | Group title and description in a 15 rem left column, controls on a panel on the right; becomes A below 1280 px | The same views, including the cramped three-column Data scope form at 1440 |

Recommended: **A**. One layout at every width, Apple's grouped-form pattern, and no cramping.
Both options remove the four header layers (page description, "Configuration 29 sections",
the breadcrumb line with "No unsaved changes", repeated section names). Rough previews:
`UIB/P-settings-chat_agent-optA-grouped-1440-light.png`,
`UIB/P-settings-chat_agent-optB-annotated-1440-light.png`, and their `-1920-dark` variants.

### 2.11 C10, a runbook inside a case (ask 9)

All three options are full clickable mocks of the library list, the editor and the per-case
run, using the same case (CASE-000214, "Brute force and password spray") at the same moment:
4 of 11 steps done, one Lookup result attached, one Decision waiting, one Action waiting for
approval.

| Option | In one line | The screenshot must show |
|---|---|---|
| A Checklist | One flat list with a progress bar (Microsoft Sentinel incident tasks): circle checkbox, title, "From runbook ..." or "Added by ...", expand for instructions, lookup result and note; phases only as small labels | The run in the case at 1440 light, 1920 dark and 390 light, with one step expanded |
| B Phased runbook | Phase pills with counts ("Triage 3/3, Investigate 1/4, Contain 0/2"), the selected phase's steps below, each expanding to Instructions, Evidence (collected automatically), Your note and Done / Not applicable / Blocked; the "Next step" card pinned on top (Splunk ES response plans) | The same views, with Investigate selected and the Next step card visible |
| C Guided next step | One card at a time: the next step with the AI's prefilled lookup and draft note, Confirm or Edit, then the next card; the full list one click away (Torq, Defender guided response) | The same views, showing the card and the "Show all 11 steps" link |

Shown once (identical in all): the library page, the "Why attached" explanation ("Matched rule
`ssh_auth_failed` and technique T1110"), the close dialog when required steps are open ("Give
a reason"), and the "Start runbook" picker for a case with no match.

Recommended: **B with C's Next step card on top**, repeated on the case Overview tab. It is the
most structured for longer runbooks, the phases map to NIST and SANS, and the card gives tier 1
the speed of C. A is the fallback if B feels heavy on a phone. Reference images (internal only):
`SP/r14/notes/rbshots/sentinel-incident-tasks.png`, `SP/r14/notes/rbshots/splunk-es-response-plans.png`,
`SP/r14/notes/rbshots/asp-img_0.B0Y86DL3.png` (ASP's Run Playbook entry).

### 2.12 C11, writing a runbook (ask 9)

| Option | In one line | The screenshot must show |
|---|---|---|
| A Structured outline | Header fields and "Applies when" as chips on top; an outline of phases and steps on the left (reorder, add a step by kind); the selected step's form on the right; a Preview toggle (as an analyst will see it) and a Source toggle (the Markdown) | The Brute force runbook with a Lookup step selected and its query template visible; the "Which cases would this match?" panel; 1440 light and 1920 dark |
| B Markdown with live preview | One editor holding front matter and a structured body (phase and step headings with a short key list), the analyst preview on the right, validation inline | The same runbook with one validation hint showing, at the same sizes |

Recommended: **A with the Source toggle**. Step kinds, evidence rules, lookup templates and
approvals are structured data that a form can validate as you type; Markdown stays the file
format for import, export and review diffs. Both options share the governance strip (Draft, In
review, Published; Review due; version history).

### 2.13 Asks with no real choice: before and after

**Ask 1, the sign-out notice.**

| Reason | Before | After |
|---|---|---|
| Session reached its time limit (standard or remembered) | "For your security, you were signed out after 12 hours. Sign in to continue." | "For your security, you were signed out. Sign in to continue." |
| Inactivity | "For your security, you were signed out after a period of inactivity. Sign in to continue." | unchanged (a reason, not a duration) |
| Ended from another device or by an administrator | "This session was ended from another device or by an administrator. Sign in to continue." | unchanged |
| All sessions signed out | "All of your sessions were signed out. Sign in to continue." | unchanged |
| Any other reason | no notice | "For your security, you were signed out. Sign in to continue." |

Screenshots: before `SHOTS/signout-current-absolute-light.png` and `-dark.png`; after
`SHOTS/signout-proposed-absolute-light.png` and `-dark.png`. A shorter variant without "Sign in to
continue." exists (`SHOTS/signout-proposedB-absolute-light.png`); it is a wording preference,
listed in 2.14, not a design choice.

**Ask 5, Chat assistant, Timeouts and capacity.**

| Setting | Before | After (new default) | Allowed range after |
|---|---|---|---|
| Lookups at once | 4 | 12 | 1 to 24 (was 1 to 8) |
| Lookup timeout | 15 s | 45 s | 1 to 120 s (unchanged) |
| Model call timeout | 300 s | 900 s | 5 to 1,800 s (was 5 to 900) |
| Questions at once per user | 4 | 12 | 1 to 24 (was 1 to 10) |
| Questions at once in total | 16 | 48 | 1 to 100 (unchanged) |

Screenshots: before `SHOTS/chatcap-current-1440.png`, after `SHOTS/chatcap-tripled-preview-1440.png`
(values painted in for the picture; nothing was saved). Existing installs move only values that
still equal the old default.

### 2.14 Decisions that need an answer but no screenshot

Each has our proposed default, so "go with the defaults" is a complete answer.

| Ask | Question | Proposed default |
|---|---|---|
| 1 | Keep "Sign in to continue." after each notice? | Keep (option 1A) |
| 1 | Keep sending `lifetime_seconds` from `/auth/me`? | Keep; the console ignores it |
| 1 | Should the Remember me hint ("for up to 24 hours") stop naming a duration too? | Keep it: it is a disclosure before opting in |
| 2 | Default scope: People and settings, or All? | People and settings |
| 2 | Who may export the audit log? | New `audit:export` for super admin, SOC manager and Auditor |
| 2 | Sign in again before exporting? | Yes |
| 2 | Formats and cap | CSV and JSON Lines, 100,000 rows per file; SIEM streaming later |
| 2 | Record that someone searched or opened the audit log? | Yes, coalesced (one row per user per filter per 5 minutes) |
| 2 | Capture client IP and user agent? | Yes, documented as personal data |
| 2 | Times in UTC or local? | UTC in the table header with a per-viewer local toggle |
| 2 | Demo Mode: show real sign-ins beside demo agent rows? | Yes, each labelled |
| 3 | Names and windows | "SOC operations" 24 h, "Detection and data health" 7 d, "Executive summary" 30 d |
| 3 | "Three default dashboards ... add 3 more": the landing page plus three new? | Yes, four listed |
| 3 | Hide a built-in; set any board as landing page | Hide yes; landing page later |
| 3 | AI spend on the Executive board? | Yes, only for viewers with `cost:view` |
| 3 | With row-level data scope on, hide case-derived built-in panels? | Yes, until aggregates respect scope |
| 4 | Window captions on the flow and Response time titles? | Yes, short ("last 24 hours") |
| 5 | Also move the model timeout in Bounded mode? | Yes |
| 5 | Triple the client's 5-minute wait for a free chat slot? | No, it is not a capacity setting |
| 5 | Fix the report-summary timeout against the 300 s proxy now? | Yes |
| 6 | Rule sheet from every place a rule appears, or chat only? | Everywhere, through one `RuleLink` |
| 6 | Was "Severity - count" a log-events or a cases breakdown? | Both get the fix; a link to that conversation would confirm |
| 7 | Show `High (8)` for sources whose scale is not 0 to 100? | Yes, as the Logs page does |
| 8 | Hover ever expands the rail? | Never |
| 8 | One name per page: "Sources", "Documentation" or "Help Center", "Baseline", "Models"? | "Sources", "Help Center" (rename the nav item), "Baseline", "Models" |
| 8 | Permanent explanation boxes (Detection rules, Baseline, Memory, Secret keys, SLA) become help tips? | Yes; callouts only for live warnings |
| 8 | Retire the hidden Automated scans page? | Yes, redirect to Case Manager filtered to agent-closed |
| 8 | Users, Roles and Sessions stay inside Settings? | Yes, without their own page headers |
| 8 | Campaigns show a derived label (entity and case count) instead of the hash? | Yes |
| 8 | Move "Discounted inference" from Jobs to Settings? | Yes |
| 8 | Make the nav timings the standard for other side panes? | Yes |
| 9 | Attach the matching runbook automatically to cases that need a person? | Yes (auto-attach on) |
| 9 | Generic incident runbook when nothing matches? | Yes |
| 9 | Closing with required steps open | Ask for a short reason, audited; never block |
| 9 | Two-person approval | Publishing needs `runbooks:publish`; "approver must differ from author" and per-step approvals available, off by default |
| 9 | Move free-form Case tasks into the runbook checklist as "Other tasks"? | Yes |
| 9 | Library scope | The 12 proposed now; denial of service, vulnerability disclosure and cryptomining later |
| 9 | Migrated operator content: Published or Draft? | Valid content stays Published (it is trusted today, so nothing changes) with an "Imported" badge and an immediate review date; invalid content becomes Draft |
| 9 | Edited operator runbooks need review before the AI trusts them? | Yes: edits create a Draft; only Published is trusted |
| 9 | "Draft a runbook from this closed case" this round? | Later round |
| 9 | ASP-style "Run" menu for AI jobs on a case? | No; lookups live inside runbooks, Reinvestigate stays |
| 9 | CACAO JSON export now? | Later; Markdown export now |
| 9 | Matching on MITRE techniques and tags too? | Yes, with a second evaluation after the verdict |
| 9 | Keep old routes and pages as aliases for one release? | Yes, then remove |
| 9 | Demo Mode honours runbooks? | Yes, the demo pipeline gets the same library |

---

## 3. Prototype plan (the options phase)

### 3.1 Principles

1. **Two mechanisms.**
   - A **preview switch on a real page** when an option rearranges data the page already
     has (navigation, Overview spacing, surfaces, headers, Settings). Pattern: Round 13's
     `?separation=` switch (`webui/src/soc/pages/overview-separation.ts`, added in commit
     `9401945`, removed when the operator chose): read once on mount from `?key=value` in
     the page URL or in the hash route, remembered per tab in sessionStorage, `current`
     clears it, nothing changes without it.
   - A **mock route with fixture data** when an option needs backend data that does not
     exist yet (proposed Audit record fields, built-in dashboards, the rule summary, the
     severity by rule cross-tab, Runbooks). `#/preview?mock=<name>&opt=<id>` renders the
     mock inside the normal Console shell with the real components, tokens, fonts and both
     themes, so it is a static mock "built with the console's real tokens and fonts", and it
     is clickable with local state only. A standalone HTML mock (tokens copied from the
     `:root` blocks of `webui/src/styles/theme.css`, fonts from `@fontsource`) is the
     fallback only if a mock cannot run in the shell.
2. **Dev-only, zero production bytes.** Every switch reader and the mock route are guarded
   by `import.meta.env.DEV`, so production builds drop them. The navigation options live in
   lazily loaded files because `NavSidebar` and `AppShell` are in the entry chunk, which has
   about 168 B of headroom. Check with `npm run build` that the entry chunk size is
   unchanged.
3. **No route registry change.** The mock route is a dev-only branch in `App.tsx` before
   page resolution (`pageFromHash()` otherwise falls back to Overview,
   `webui/src/soc/router.tsx:185-192`; the page Suspense boundary is at
   `webui/src/soc/App.tsx:196-202`), so the console-map contract, the route-registry tests
   and the entry budget are untouched.
4. **Every preview says what it is.** A small corner label, "Preview · C4 · Option A, Rule
   sheet · illustrative data", hidden with `label=0` for clean comparison shots.
5. **Fixture data is neutral.** Shapes copied from the shared demo; IPs from RFC 5737 ranges,
   hosts from the demo or RFC 2606 names. The research mockup 6A used a host name from the
   operator's own environment; committed fixtures must not.
6. **Never change the shared demo.** Force the theme by rewriting the
   `GET /api/prefs/effective` response in the browser context and intercept
   `PUT /api/prefs/user` (the `ui-audit-b.md` method; clicking the theme toggle writes the
   shared Admin preference). Never press Save in Settings or Dashboards.
7. **Isolation.** U1 and U2 edit files the dev server compiles for every page (shell,
   primitives, `theme.css`), so each works in its own git worktree with its own
   `run-demo.sh` instance on unique ports (symlink `webui/node_modules` and
   `backend/.venv`). U3 and U4 only add new lazily loaded files under
   `webui/src/soc/preview/mocks/`, so they can use the main tree and the shared demo.
8. **Gates stay green on the prototype snapshot:** `tsc --noEmit`, eslint 0/0, design
   gates, `test:strict`, the bundle test. Each unit adds a small test that its switch or
   mock is dev-only and inert without its parameter.
9. **House copy rules:** no em dashes, sentence case, only the product name, and never the
   word "playbook" in the runbook mocks.
10. **Afterwards.** The winning option is rebuilt properly in the implementation wave (the
    prototype is a reference, not shipped code). The whole `webui/src/soc/preview/` folder,
    the dev branch in `App.tsx`, every switch reader, `nav-preview/` and the scoped CSS blocks
    are deleted, and a test asserts they are gone, as Round 13 did
    (`webui/src/soc/pages/__tests__/overview-panels.test.tsx:227-228`).

### 3.2 Step P0: shared preview infrastructure (first, small, one owner)

| File | What |
|---|---|
| `webui/src/soc/preview/previewSwitch.ts` (new) | `readPreviewChoice(key, ids, aliases?)`, the Round 13 reader generalised: search and hash query, sessionStorage `soc.r14.preview.<key>`, `current`/`off`/`none`/`default` clear, returns `null` outside DEV |
| `webui/src/soc/preview/PreviewLabel.tsx` (new) | The corner label; `label=0` hides it |
| `webui/src/soc/preview/PreviewHost.tsx` (new, lazy) | Reads `mock`, loads `./mocks/<mock>/index.tsx` through `import.meta.glob`, so units add mocks without editing the host; an unknown name lists the available mocks |
| `webui/src/soc/App.tsx` (edit) | The dev-only branch that renders `PreviewHost` inside the shell when the hash starts with `#/preview` |
| `webui/src/soc/preview/__tests__/preview-switch.test.ts` (new) | Parse, remember, clear, DEV guard, host lists mocks |
| `SP/r14/proto/shoot.mjs` (scratchpad) | Screenshot harness: the login helper from `SP/r13/dash/shoot.mjs` (`#login-username`, Continue, `#login-password`, Sign in), theme forced by response rewrite, prefs writes intercepted, flags `--url --w --h --theme --full --clip --out` |
| `SP/r14/proto/sheet.sh` (scratchpad) | Comparison sheet builder (3.4) |
| `SP/r14/proto/make-index.mjs` (scratchpad) | Builds the operator index page (3.4) |

### 3.3 Four parallel units (exclusive file ownership)

#### U1 Navigation (C6)

Switch `?nav=a|b|c` (`current` is today's rail).

| Files | |
|---|---|
| `webui/src/soc/components/NavSidebar.tsx` | Read the switch; when set, render the lazy option component instead of today's tree |
| `webui/src/soc/components/nav-preview/NavRailA.tsx`, `NavRailB.tsx`, `NavRailC.tsx` (new) | The three options; C's short labels live here (no registry edit) |
| `nav-preview/navPreviewStore.ts`, `hoverIntent.ts`, `RailTooltipProvider.tsx` (new) | External store via `useSyncExternalStore`; 300 ms rest, 400 ms grace, safe triangle; rail-local tooltips |
| `webui/src/soc/AppShell.tsx` | Only the `desktop-navigation-frame` block (`:1509-1522`) and the toggle slot (`:1399-1424`), both under the switch |
| `nav-preview/__tests__/nav-preview.test.tsx` (new) | Inert without the switch; focus stays on the toggle; one DOM per row in A |

Evidence to produce, reusing `SP/r14/notes/nav-repro.mjs`, `nav-perf.mjs` and `sheet.sh` with
`?nav=`:
- collapse and expand frame strips for today, A and B at 1440 light and 1920 dark; C has no
  toggle, so frames of a group menu opening instead;
- a 1 s pointer sweep over the collapsed rail (today, A, B), a click on a grouped icon (all),
  the focus target after a keyboard toggle (all);
- 390 light: the mobile sheet opening and navigating (the shared fixes, shown once);
- static shots: rail collapsed and expanded per option at 1440 light and 1920 dark, C at
  1280 light;
- one video per option and a side-by-side `nav-compare.mp4` (`ffmpeg ... hstack`);
- the metrics table: icon x drift, focus target, flyouts per sweep, click flash in ms,
  longest frame and main-thread blocking at 4x CPU on a production build (`npm run build`
  in the worktree, `vite preview` on a unique port).

#### U2 Surfaces, headers, Overview spacing and Settings (C3, C7, C8, C9)

Switches `?ovgap=a|b|c`, `?surface=panels|flat`, `?header=title|line`, `?settings=a|b`.

| Files | |
|---|---|
| `webui/src/soc/pages/Overview.tsx` | Under `?ovgap`: `Band` becomes a plain `div` with `data-band`, the flow footer line ("Cases opened is the same count as Total Cases above"), window captions, the oldest-slice stamp |
| `webui/src/soc/components/NoiseFunnel.tsx` | Optional `crossReference` footer prop |
| `webui/src/styles/theme.css` | Scoped blocks `[data-ov-gap]`, `[data-ui-surface]`, `[data-ui-header]`, `[data-settings-preview]`; no motion, blur, resting shadow or brand-token change (the Round 13 rules) |
| `webui/src/soc/components/PageContainer.tsx` | Sets the root data attributes from the switches |
| `PageHeader.tsx`, `ChartCard.tsx`, `KpiTile.tsx`, `DataTable.tsx` (in `soc/components`), `webui/src/ui/card.tsx`, `ui/table.tsx`, `ui/tabs.tsx` | Data hooks only (chip, overline, description, card, header cell), no behaviour change without a switch |
| `webui/src/soc/pages/Settings.tsx`, `pages/settings/primitives.tsx`, `soc/components/SettingsGrid.tsx`, `pages/settings/chat-agent.tsx`, `pages/settings/general.tsx`, the Data scope section file | Data hooks for group title, description and control column, and the shell layers hidden under `?settings` |
| `webui/src/soc/__tests__/r14-surface-preview.test.tsx` (new) | Inert without switches; no motion or brand override in the scoped CSS |

Screens:
- C3: today, A, B, C full page at 1440 light with the 900 px fold drawn, 1920 light and dark,
  390 light.
- C7: Cases, Logs, Sources, Campaigns and Analytics Operational in today, 1 and 2 at 1440
  light (viewport and a two-viewport crop) and 1920 dark; Cases at 390 light.
- C8: header crops (0 to 260 px) of Cases, Analytics, Sources, Standup, Settings and Audit
  in today, 1 and 2 at 1440 light, one row at 1920 dark.
- C9: Chat assistant, General and Data scope in today, A and B at 1440 light, 1920 dark and
  390 light.

#### U3 Data-view mocks (C1, C2, C4, C5)

Mocks:
- `#/preview?mock=audit&opt=a|b|c&scope=people|agent|all&state=list|detail|export`
- `#/preview?mock=dashboards&opt=switcher|tabs|library&board=landing|soc-ops|detection|executive`
- `#/preview?mock=rule&opt=a|b|c`
- `#/preview?mock=severity&opt=before|a|b|c`

| Files (all new) | |
|---|---|
| `webui/src/soc/preview/mocks/audit/` | `index.tsx`; `fixtures.ts` (about 60 records across the three scopes, the proposed fields labelled "proposed"); `AuditInspector.tsx`; `ExportDialog.tsx` |
| `webui/src/soc/preview/mocks/dashboards/` | `index.tsx`; `boards.tsx` (the three built-ins in the Overview grammar); `fixtures.json` captured once from the shared demo's existing endpoints plus fixture rows for the breakdown endpoint that does not exist yet |
| `webui/src/soc/preview/mocks/rule/` | `index.tsx` (a chat lane with the real `BlockCard` and fixture blocks reproducing the operator's "Top detection rules"); `RuleSheet.tsx`; `LogsRuleView.tsx`; `RowExpand.tsx` |
| `webui/src/soc/preview/mocks/severity/` | `index.tsx`; `SeverityTable.tsx`; `SplitByBars.tsx`; `SeverityMatrix.tsx` |
| one render test per mock | Renders, contains no em dash |

Real components are imported read-only (`BlockCard`, `DataTable`, `Sheet`, `KpiTile`, badges,
`TimeRangePicker`, the chart kit); no shared file is edited.

Screens: the per-option lists in 2.2, 2.3, 2.5 and 2.6 at 1440 light, 1920 dark and 390
light, plus the shared states: the export dialog; each built-in board as a full page; the
Duplicate dialog; the block-title tooltip before and after.

#### U4 Runbooks mock (C10, C11)

Mock `#/preview?mock=runbooks&opt=a|b|c&view=library|editor|run|close|start&editor=outline|markdown`.

| Files (all new) | |
|---|---|
| `webui/src/soc/preview/mocks/runbooks/index.tsx` | View and option routing |
| `fixtures.ts` | Three runbooks in the new model (Brute force and password spray; Phishing or reported suspicious email; Generic incident) and CASE-000214's run state (4 of 11 done, one Lookup result, one Decision waiting, one Action awaiting approval) |
| `Library.tsx`, `EditorOutline.tsx`, `EditorMarkdown.tsx` | Library (name, applies to, status, steps, runs, review due) and the two editors |
| `RunChecklist.tsx` (A), `RunPhased.tsx` (B), `NextStepCard.tsx` (C, and pinned in B) | The three run views |
| `CaseFrame.tsx`, `CloseDialog.tsx`, `StartRunbookPicker.tsx`, `WhyAttached.tsx` | A Case Manager-like frame with the Runbook tab and the "4/11" chip; the shared states |
| `__tests__/runbooks-mock.test.tsx` | Renders every view; no em dash; no "playbook" |

Screens: library at 1440 light and 1920 dark (once); editors A and B at 1440 light and 1920
dark; the run view per option at 1440 light, 1920 dark and 390 light; the close dialog, Start
picker and Why attached once. "Before" images: `SHOTS/runbooks-01-runbooks-list.png`,
`SHOTS/runbooks-04-playbooks-list.png`, `SHOTS/runbooks-09-case-take-action-menu.png`.

### 3.4 Screenshot conventions and comparison sheets

- File names: `SP/r14/options/<choice>/<option>-<view>-<width>-<theme>.png`, for example
  `SP/r14/options/C1/A-detail-1440-light.png`. Viewports 1440x900 light, 1920x1080 dark,
  390x844 light. Full-page captures are cropped to two viewport heights for sheets; the
  full-size files stay linked.
- One sheet per choice and view: today first where it exists, then the options left to
  right, each tile labelled with the option letter and name, a title bar with the question
  and the recommendation. ImageMagick (installed) builds them:

  ```
  montage -font DejaVu-Sans -pointsize 26 -background '#eef0f3' -geometry +24+24 -tile 4x1 \
    -label 'Today' today.png -label 'A  Side sheet (recommended)' A.png \
    -label 'B  Inline row' B.png -label 'C  Split pane' C.png row.png
  convert row.png -gravity North -splice 0x90 -pointsize 40 -annotate +0+24 \
    'C1  How does an Audit record open?  1440 light' sheet-detail-1440-light.png
  ```

  Phones four per row; navigation frame strips one row per option; videos side by side with
  `ffmpeg -filter_complex hstack=inputs=N`.
- Asks 1 and 5: two-tile before and after sheets from the existing screenshots.
- `SP/r14/options/index.html`: one section per choice (question, one line per option, the
  sheets, links to every full-size shot, our recommendation), then the before and after
  pairs and the decision list from 2.14. The orchestrator can publish it as a private
  Artifact for the operator to review.

### 3.5 Order

P0 first, then U1, U2, U3 and U4 in parallel. Each unit returns its screenshots, sheets and a
short options note (scratchpad, not the repository) plus its Journal entry; the orchestrator
builds the index. U4 and U1 are the largest.

---

## 4. Implementation work packages (after the operator decides)

### 4.1 Rules

- Backend contracts first. Packages that touch the shared backend files (`api/routes.py`,
  `config.py`, `models.py`, `constants.py`, `rbac/policy.py`, `engine/jobs.py`,
  `engine/demo_chat.py`) run one after another; the rest run in parallel.
- One package regenerates the API contract and adds every new client method and type before
  the web packages start, so web packages only consume them.
- Web packages own their files exclusively; the shared primitives package (W2) lands before
  the packages that build new screens on them.
- Every package: implement, two adversarial reviews, fix, gates; documentation in the same
  change as the behaviour; a Journal entry per milestone.

### 4.2 Wave A, backend

| WP | Asks | Owns | After | Notes |
|---|---|---|---|---|
| A1 Chat limits v2 | 5 | `backend/app/config.py` (the `ChatAgentConfig` block and chat migration only), `backend/app/api/routes_reports.py` (summary wait cap), tests `test_chat_limits_migration.py`, `test_settings_schema_chat_agent.py`, `test_chat_round12_api.py`, `test_chat_contracts.py`, demo planner tests | none | S |
| A2 Breakdown endpoint and built-in ids | 3, 6, 7 | `backend/app/api/routes_metrics.py` (`GET /api/metrics/breakdown`), `backend/app/api/routes_dashboards.py` (reject `builtin:` ids, allow the new widget types), tests (parity with `case_stats`, multi-valued rule rows, RBAC, Demo store) | none | S |
| A3 Runbook core, pure | 9 | new `backend/app/engine/runbook_model.py` (schema, front-matter parser, budgets), `engine/runbook_match.py` (pure matcher and explainer), `engine/runbook_lookup.py` (template validation, parameter binding, read-only tool allowlist), the new bundled library (for example `backend/app/runbooks/library/*.md`, 12 files), tests including a prompt-budget test for every bundled runbook | none | M; the spine of ask 9 (#11) |
| A4 Audit read API and record | 2 | the audit route in `backend/app/api/routes_search.py` (or a new auto-discovered `routes_audit.py` that takes it over), `backend/app/audit/audit_log.py`, the audit part of `backend/app/stores/sql/repositories.py`, `backend/app/models.py` (additive `AuditDoc` fields), `backend/app/constants.py`, `backend/app/es/indices.py` (keyword mappings), a new request-id middleware, writers at the auth, users, roles and settings call sites in `backend/app/api/routes.py`, the Demo Mode read split in `backend/app/state.py` | A1 | M |
| A5 Audit export | 2 | `backend/app/engine/jobs.py` (`audit_export` handler), `backend/app/stores/jobs.py`, `backend/app/api/routes_jobs.py` (submit; download auditing for every job kind), `backend/app/rbac/policy.py` (`audit:export`), new `backend/app/engine/audit_export.py` (CSV and JSON Lines writers with defusal) | A4 | M |
| A6 Rule filters, rule summary, severity | 6, 7 | `backend/app/api/routes.py` (`rule` and `severity_gte` on `GET /api/logs`, `rule` on `GET /api/cases`), `backend/app/engine/log_rows.py`, new `backend/app/api/routes_rule_summary.py`, `backend/app/agents/chat_tools/logs.py` (named levels, per-source projection, share, honest caption, tool-built `drill`, severity by rule), `chat_tools/stats.py` and `chat_tools/metrics.py` (second dimension), `backend/app/agents/blocks.py` (`drill` in the table view, a `rule` key in `NavRefOpts`), `chat_tools/common.py` (`LOGS_UNEXPRESSIBLE_FILTERS`), connector two-level aggregation (`backend/app/connectors/elastic.py`, OpenSearch, Wazuh), `backend/app/engine/demo_chat.py` parity, golden set | A2, A5 | L |
| A7 Runbook stores, API, migration, permissions | 9 | new `backend/app/stores/runbook_catalog.py` and `stores/runbook_runs.py` (strict-CAS KV, new namespaces), `backend/app/api/routes_runbooks.py` (rewritten: catalog with states and versions, match preview, per-case runs, start, step updates, approvals, close reason), `routes.py` (playbook routes as deprecated aliases or `410`), new `backend/app/engine/runbook_migration.py` (one-shot, audited, marker), `config.py` (`RunbookConfig`; old keys and `run_playbook` accepted on load), `models.py` (`Case.runbook_id`; keep `playbook_id`), `constants.py`, `rbac/policy.py` (`runbooks:read/run/manage/publish`, `playbooks:*` mapped), `backend/app/api/routes_roles.py` (custom-role grant mapping) | A3, A6 | L |
| A8 Runbooks in the pipeline | 9 | `backend/app/agents/prompts.py` (`<<<RUNBOOK>>>` fence, precedence wording, keep `<pb>`), `agents/investigator.py`, `agents/graph.py`, `agents/pipeline.py` (match, attach, provenance rows), `backend/app/tools/rag.py` (corpus from Published versions), `agents/chat_tools/intel.py` and `agents/chat.py` (kinds and aliases), `agents/chat_followups.py`, `engine/demo_runtime.py` (demo parity), `engine/demo_chat.py`, `engine/replay/` (frozen catalog; `playbooks_enabled` accepted), `engine/metrics.py` (runbook usage; `playbook_usage` still readable), `api/routes_export.py` (new group; old groups for one release), `engine/case_rationale.py`, `api/routes_triage.py`, `engine/threshold_automation.py` (`attach_runbook`; `run_playbook` alias), `engine/jobs.py` (`runbook_reindex` kept), packaging (`backend/pyproject.toml`, `MANIFEST.in`, `backend/Dockerfile`, `.github/workflows/ci.yml`, distribution and portability contract tests), the removals in 4.6 | A7 | XL; the largest backend package, consider splitting by agent path versus everything else |

### 4.3 Wave B, generated contracts

| WP | Owns | After |
|---|---|---|
| B1 Contracts and client | `webui/openapi.json`, `webui/src/lib/api-types.gen.ts`, every new method in `webui/src/lib/api.ts`, every new type in `webui/src/lib/types.ts` (Audit, breakdown, rule summary, logs and cases filters, Runbooks), kept in sync with `models.py` | A2, A5, A6, A7 |

### 4.4 Wave C, web (exclusive ownership)

| WP | Asks | Owns | After |
|---|---|---|---|
| W1 Small asks | 1, 5 | `webui/src/soc/components/auth/rememberMe.ts`, `RememberMeControls.tsx`, `webui/src/soc/auth.tsx`, the notice wiring in `webui/src/soc/pages/Login.tsx`, `webui/src/soc/pages/settings/chat-agent.tsx` (defaults and bounds), `webui/src/soc/chat/chat-api.ts`, their tests | A1 (bounds); can start during wave A |
| W2 Shared primitives | 8 | new `webui/src/design-system/panel.tsx` and its export, `KpiStrip`, `ChartPanel` (`ChartCard` on `Panel`), `PageHeader.tsx` defaults (C8), `KpiTile.tsx` colour and label rules, `webui/src/ui/table.tsx` and `DataTable.tsx` (header style, compact default, edge fade, sticky first column, empty state, fixed layout), `webui/src/ui/tabs.tsx` (underline variant), `FilterBar.tsx`, `RefreshButton` placement, `webui/src/lib/format.ts` (`fmtDuration`, `fmtOverage`, `caseLabel`), `PageContainer.tsx`, `webui/src/ui/sheet.tsx` (close stacking), `webui/src/styles/theme.css` (proportional body, the C7 rules), the Settings primitives (`SettingsSection`, `SettingsGroup`, `SettingRow`, `NumberField` sizes, `Callout`), `ListRow`, `RowActions`, `StatusDot`, the guard test, `docs/development/ui-standard.md` | B1 not needed; start early |
| W3 Navigation | 8 | `webui/src/soc/components/NavSidebar.tsx`, the nav parts of `webui/src/soc/AppShell.tsx`, new `webui/src/soc/nav-store.ts`, the rail tooltip provider, `webui/src/soc/registry.tsx` (owned here: one name per destination, the single Runbooks entry, short labels if C, the Scans redirect), tests and the browser guard, the entry-bundle measurement | parallel with W2 |
| W4 Overview and Dashboards | 3, 4 | `webui/src/soc/pages/Overview.tsx`, `NoiseFunnel.tsx`, `webui/src/soc/pages/Dashboards.tsx`, `webui/src/soc/dashboard/*` (provider keys, page time picker, built-in definitions, Duplicate and Hide, new widget types and the contract JSON, widget fixes), the Overview print block in `theme.css` (after W2), tests | W2, B1 |
| W5 Audit page | 2 | `webui/src/soc/pages/Audit.tsx` rebuilt, new `webui/src/soc/components/audit/*` (inspector, JSON tree, export menu and dialog), "View in audit log" links from the Case trace, Users and Account, tests | W2, B1 |
| W6 Rule drill-down and severity | 6, 7 | `webui/src/soc/chat/blocks/BlockCard.tsx` (tooltip), `renderers/TableView.tsx` (row action, sparkline), `charts/HBarChart.tsx`, a new severity renderer, new lazy `webui/src/soc/components/RuleSheet.tsx` and `RuleLink.tsx`, `casedetail/FactsRail.tsx`, `UnifiedLogsSheet.tsx`, `webui/src/soc/pages/UnifiedLogs.tsx` (Rule chip), `webui/src/soc/nav-types.ts`, the Cases rule filter control, the chat case entity block (case number, plain status words), the blocks contract JSON, tests | W2, B1 |
| W7 Runbooks UI | 9 | new `webui/src/soc/pages/Runbooks.tsx` (library and editor, rewritten), `webui/src/soc/runbooks/*` (editor, match preview, version history), new `webui/src/soc/pages/casedetail/RunbookPanel.tsx` (run view, Next step card, close-reason dialog, Start picker), `CaseDetail.tsx` (tab; Run a playbook removed), the Case Manager progress chip, `casedetail/CollaborationPanel.tsx` and `CaseTasks.tsx` (Other tasks), `Intelligence.tsx`, a new `Personas.tsx` split out of `Catalog.tsx`, `WhyPanel.tsx`, `InvestigationInputs.tsx`, the Cases column, the Metrics chart, Settings links, `rules/RuleEditor.tsx` and `rules/constants.ts`, access copy, `Roles.api.ts`, the `Docs.tsx` card, the Audit filter labels (handed to W5 as a list), tests | W2, W3 (registry), B1 |

### 4.5 Wave D, page migrations (ask 8)

| WP | Owns | After |
|---|---|---|
| W8 Pass 1 | Analytics (`Metrics.tsx`, `Cost.tsx`, `AgentEffectiveness.tsx`, `HealthDiagnostics.tsx`, `Analytics.tsx`), `Standup.tsx`, `Cases.tsx` (with the phone list), log density in `UnifiedLogs.tsx` and `UnifiedLogsSheet.tsx`, `Campaigns.tsx`, the Case Manager frame | W2; after W6 on the two Logs files |
| W9 Pass 2 | `Settings.tsx` and every `pages/settings/*.tsx`, the embedded `Account.tsx`, `Sessions.tsx`, `Users.tsx`, `Roles.tsx`, `AdminSessions.tsx`, `Security.tsx`; `Sources.tsx`, `SourceLogsSheet.tsx`, `Tuning.tsx`, `Baseline.tsx` and `BaselineGauge.tsx`, `Knowledge.tsx`, `Memory.tsx`, `Models.tsx` and `ModelsCatalog.tsx`, `BatchJobs.tsx` (Discounted inference moves to Settings), `Inbox.tsx`, `Approvals.tsx`, `Reports.tsx`, `Docs.tsx` (after W7), `Investigate.tsx` and `Workspace.tsx`, `EnrichmentProvidersEditor.tsx`, `NotificationsEditor.tsx`, `DangerZone.tsx`, `CaseActivityFeed.tsx`, the top-bar pieces of `AppShell.tsx` (after W3) | W2, W3, W7 |

### 4.6 Ask 9: what is removed, and what stays accepted

Removed (after A7's migration exists and the tests have moved):
- Backend: `backend/app/playbooks/` (`__init__.py`, `manifest.py`, `loader.py`, `registry.py`,
  `durable.py`); `backend/playbooks/` (9 files and the 12 KB README) and its packaging lines
  (`backend/pyproject.toml:18, 25, 29`, `MANIFEST.in:4`, `backend/Dockerfile:44-47`,
  `.github/workflows/ci.yml:108-109`), replaced by the new library's lines;
  `backend/app/stores/playbooks.py`; `backend/app/engine/runbook_service.py`; the plain-text
  authoring standard in `backend/app/engine/runbooks.py`; the 9 old `backend/app/runbooks/*.md`;
  `SEED_RUNBOOKS` and `_runbook_seed_items` (`backend/app/tools/rag.py:788-846`); the
  `<<<PLAYBOOK>>>` block (`backend/app/agents/prompts.py:479-494`); the dead
  `PlaybookConfig.llm_select` and `suggested_tools`; the `force_playbook_id` plumbing and the
  automation callback (`backend/app/state.py:1143-1162`); the playbook routes
  (`backend/app/api/routes.py:2725-2937`, `:6846`), first as deprecated aliases or `410` with a
  pointer for one release, then deleted; the old `/api/runbooks` shapes (the path stays);
  `test_playbook_management.py`, `test_playbook_run.py`, `test_playbook_selection.py`,
  `test_playbook_loader.py`, `test_runbook_management.py` rewritten or retired, about 35 more
  updated.
- Console: the playbooks half of `webui/src/soc/pages/Catalog.tsx` (personas move to
  `Personas.tsx`), the old `Runbooks.tsx`, `runbookAuthoring.ts`, `runbookExamples.ts`; the nav
  entries "Reference runbooks" and "Response playbooks" (page ids `catalog` and `playbooks`
  stay routable as redirects to `#/runbooks` for one release); the "Run a playbook" item and
  dialog (`CaseDetail.tsx:430-434, 931-971, 1632-1643, 2123-2175`); the Cases `playbooks`
  column; the "Playbook usage" chart; the Settings links "Suppression & response playbooks"
  and "Corpus & procedures"; the `run_playbook` choice in the rule editor; the Audit filter
  "playbook"; the Docs card "Playbooks and approvals" (approvals keep a card); the `Playbook*`
  and old `Runbook*` types and client methods (`webui/src/lib/types.ts:501-710`,
  `webui/src/lib/api.ts:749-807`); about 54 Console test files updated or retired.
- Docs: rewrite `docs/intelligence/runbooks.md`; rename and rewrite
  `docs/automation/playbooks-approvals.md` keeping the approvals content; update the about 40
  pages listed in `runbooks-codemap.md` section 5; regenerate `app_docs.json`,
  `console_map.json` and `aliases.json`.

Stays accepted (aliases; never renamed in this round, per the AGENTS.md naming contract):
- `Case.playbook_id` (readers prefer the new `runbook_id`; history is never rewritten).
- `CaseAutomationRule.action = "run_playbook"` and `payload.playbook_id`, accepted on load and
  mapped, so stored Preferences and the rule version ledger still validate.
- `JobKind.RUNBOOK_REINDEX = "runbook_reindex"` (terminal job rows must decode).
- Permissions: `runbooks:*` stays; `playbooks:read`, `playbooks:manage` and `playbooks:run`
  map to `runbooks:read`, `runbooks:manage` and `runbooks:run`, in custom roles too, so no
  role silently loses a grant.
- Audit actors `playbook_selector`, `procedure_provenance`, `run_playbook` and
  `ActionType.PLAYBOOK`/`RUNBOOK`, readable forever by the case rationale and the timeline.
- Chat `search_knowledge` kinds `list_playbooks` and `list_runbooks`, and the page refs
  `playbooks`, `runbooks` and `catalog` (stored transcripts and Inbox links).
- The replay field `playbooks_enabled` under `extra="forbid"`.
- The neutral marker tag `<pb>` (pinned by `backend/tests/test_marker_normaliser.py:122-195`).
- The KV namespaces `playbooks` and `runbooks`, read-only for one release, with their export
  groups kept for that release.

### 4.7 Wave E, documentation and gates

- Documentation with each package: Help Center pages (a new Audit log page, Dashboards,
  Runbooks rewritten, Overview, chat settings, authentication), `docs/reference/permissions.md`,
  `docs/reference/api.md`, `docs/reference/configuration.md`,
  `docs/operations/background-jobs.md`, `docs/operations/upgrades.md` and `DEPLOY.md` (chat
  limits version 2, the audit index rollover, the runbook migration), `docs/development/ui-standard.md`
  (the panel grammar for every page, navigation timings, forms and Settings, activity and
  audit logs), `docs/USAGE.md`, `docs/HANDOFF.md`, `AGENTS.md` (layout and baseline),
  `ROADMAP.md` (CACAO export, audit streaming to a SIEM, AI runbook drafting), `CHANGELOG.md`
  `[Unreleased]`, `Journal.md`.
- Generated artefacts: OpenAPI, API types, console map, Help Center corpus
  (`scripts/build_app_knowledge.py`), the version-matched docs bundle.
- Gates: `pytest -q`, `npm run build`, `npm run docs:check`, `npm run test:strict` (zero
  stderr), `npm run lint` (0 errors, 0 warnings), `npm run gates` (tokens, contrast in both
  themes, colour-vision separation), the entry bundle budget, `python -m pip check` in the
  image lane; live screenshots of every changed surface at 390, 1440 and 1920 in both themes.

### 4.8 Order in one view

```
Options:  P0 -> U1 | U2 | U3 | U4 -> operator decides
Wave A:   A1 | A2 | A3                (parallel; W1 and W2 and W3 may start)
          A4 -> A5 -> A6 -> A7 -> A8  (sequential: shared backend files)
Wave B:   B1                          (after A2, A5, A6, A7)
Wave C:   W2 | W3, then W4 | W5 | W6 | W7   (W7 after W3's registry change)
Wave D:   W8, then W9                 (W8 after W6 on the Logs files)
Wave E:   docs, regeneration, gates, screenshots, Journal, pull request into Testing
```

The critical path is ask 9 (A3, A7, A8, B1, W7). Asks 1, 4 and 5 can ship early inside the
round; asks 2, 3, 6 and 7 follow W2 and B1.

---

## 5. Sources

Briefs (this folder): `runbooks-industry.md`, `runbooks-codemap.md`, `audit-log.md`,
`dashboards.md`, `chat-drilldown.md`, `small-asks.md`, `nav-animation.md`, `ui-audit-a.md`,
`ui-audit-b.md`. Every code citation above is taken from them or re-checked at `a966b0d`
(spot-checked: `rememberMe.ts:183-201`, `BlockCard.tsx:824-829`, `Audit.tsx:445-450`,
`config.py:1536, 1644-1682`, `bundle-first-paint.test.ts:117, 192-202`, the Round 13 switch in
commit `9401945`).

Key external sources (full lists in each brief):
- Session timeouts: https://design.tax.service.gov.uk/hmrc-design-patterns/service-timeout,
  https://www.w3.org/WAI/WCAG22/Understanding/timeouts.html,
  https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html,
  https://pages.nist.gov/800-63-4/sp800-63b/session
- Audit logs: https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final,
  https://learn.microsoft.com/en-us/entra/standards/pci-requirement-10,
  https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html,
  https://owasp.org/www-community/attacks/CSV_Injection,
  https://docs.datadoghq.com/account_management/audit_trail/, https://vercel.com/docs/audit-log
- Dashboards: https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.5/analytics/executive-summary-dashboard,
  https://learn.microsoft.com/en-us/azure/sentinel/manage-soc-with-incident-metrics,
  https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/system-dashboards,
  https://docs.cloud.google.com/chronicle/docs/reports/native-curated-dashboards
- Rule drill-down and severity: https://www.elastic.co/guide/en/security/8.19/alerts-ui-manage.html,
  https://www.elastic.co/guide/en/security/8.19/visualize-alerts.html,
  https://learn.microsoft.com/azure/sentinel/monitor-optimize-analytics-rule-execution,
  https://docs.cloud.google.com/chronicle/docs/detection/view-all-rules
- Navigation: https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/sidebar.tsx,
  https://fluent2.microsoft.design/components/web/react/core/nav/usage,
  https://www.nngroup.com/articles/timing-exposing-content/, https://floating-ui.com/docs/usehover,
  https://web.dev/articles/animations-guide, https://gitlab.com/gitlab-org/gitlab/-/issues/389958
- Page and form grammar: https://carbondesignsystem.com/components/data-table/style/,
  https://carbondesignsystem.com/components/form/usage/,
  https://design-system.service.gov.uk/components/text-input/,
  https://polaris.shopify.com/patterns/app-settings-layout,
  https://developer.apple.com/design/human-interface-guidelines/settings
- Runbooks: https://csrc.nist.gov/pubs/sp/800/61/r3/final,
  https://docs.oasis-open.org/cacao/security-playbooks/v2.0/security-playbooks-v2.0.html,
  https://learn.microsoft.com/en-us/azure/sentinel/incident-tasks,
  https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.7/mission-control/respond-to-investigations-with-response-plans-in-splunk-enterprise-security,
  https://www.elastic.co/docs/solutions/security/detect-and-alert/write-investigation-guides,
  https://docs.firehydrant.com/docs/runbook-conditions, https://asp.viperrtp.com,
  https://atc-project.github.io/atc-react/, https://d3fend.mitre.org/

---

## Journal entry (for the orchestrator to append)

### 2026-10-25 17:00Z, research sub-agent (synthesis), Round 14 research synthesis
- Context: combine the nine Round 14 research briefs into one plan: per-ask recommendations,
  the operator's design choices, a prototype plan for the options phase, and a first cut of
  implementation work packages.
- Did: wrote `docs/research/2026-10-round14/research/SYNTHESIS.md`: recommendations, evidence,
  non-negotiable risks and size for asks 1 to 9; eleven design choices (C1 to C11) with options,
  what each screenshot must show, and recommendations; before and after examples for asks 1
  and 5; a decision list with proposed defaults; a prototype plan (dev-only preview switches and
  a dev-only fixture mock route, step P0 plus four parallel units with exclusive files, screenshot
  conventions and comparison sheets); implementation waves A to E with file ownership and order;
  the ask 9 removal and alias lists.
- Tests: none (research only; no product file changed).
- Status: done.
- Next: run P0, then units U1 to U4; build `SP/r14/options/index.html`; send the options to the
  operator.
