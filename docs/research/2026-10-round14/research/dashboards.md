# Round 14 research: three built-in dashboards (operator ask 3)

Author: research sub-agent (dashboards). Date: 2026-10-25. Branch: `claude/round12`
at `a966b0d`. Scope: research only, no product code changed.

Operator ask 3, verbatim: "Create three default dashboards, the one we have currently, that
is already the main screen default, but add 3 more default coveering different aspects in
the dashboards section got it ? It should be included by default per the best standards and
practice in the industry."

Reading of the ask: the Cyber Defence Center (the Overview page) stays the main landing
screen. The Dashboards section gains three more dashboards that ship by default for every
user, each covering a different aspect, chosen the way leading SOC products choose theirs.

---

## 0. Summary of conclusions

1. **Dashboards are per-user only today.** There is no concept of a shared, system or
   read-only template dashboard. The only "default" is a code-defined, per-role widget set
   of 3 or 4 widgets, shown read-only until the first Save and named "Overview", which
   collides with the real Overview page (`webui/src/soc/pages/Dashboards.tsx:52-69`,
   `webui/src/soc/dashboard/registry.ts:392-409`).
2. **Every leading product separates three aspects beyond its landing page**: (a) SOC
   operations and workload for the SOC manager or shift lead, (b) detection quality and
   data health for the detection engineer or platform owner, (c) an executive summary of
   trends, risk and automation value for leadership. Splunk ES, Microsoft Sentinel,
   Cortex XSIAM, Google SecOps and Elastic all ship this split (section 2).
3. **Recommended built-ins:** "SOC operations" (24 hours), "Detection and data health"
   (7 days) and "Executive summary" (30 days, compared with the previous 30 days). Each has
   a KPI strip in the same visual grammar as the Cyber Defence Center, then 8 to 11 panels.
4. **Industry rule for system dashboards:** read-only, cannot be edited or deleted,
   **Duplicate** gives an editable personal copy (Cortex XSIAM system dashboards, Google
   SecOps curated dashboards). We should copy this exactly. Hiding a built-in from one's own
   list is a reasonable per-user extra; deleting it is not.
5. **No new store is needed.** Built-ins are code-defined (like today's role defaults),
   duplicates go into the existing per-user `DashboardStore` through the existing
   `POST /api/dashboards`, and a per-user "hidden built-ins" list fits in `UserPrefs.misc`.
6. **One new read-only endpoint is needed:** `GET /api/metrics/breakdown`, a thin wrapper
   over the existing exact aggregate engine (`engine/case_aggregate.py`), for "top rules",
   "cases by source" and "cases by severity over time". The engine already exists and
   already serves chat's `case_stats`; it is simply not exposed over HTTP. Everything else
   the three dashboards need is already served by existing endpoints.
7. **About 12 new widget types** are needed (KPI strip presets, trend lines, backlog aging,
   workload, attention queue, SLA breaches, top rules, noisy rules, top techniques, noise
   funnel, auto-close health, generic breakdown). They follow the existing contract: one
   value in `widget-types.contract.json`, one registry entry, one lazy body, server
   allowlist updated, contract tests pass.
8. **Non-negotiables hold.** Every source is a non-billing, aggregate-only read (#6, #7);
   nothing feeds `decide()` (#3); rule names, case titles and source names are rendered as
   plain text (#9). No built-in shows raw log rows.
9. **Three defects found in today's Dashboards section** that the work should fix: the
   "Needs-human queue" widget's "0 open cases total" contradicts the Overview's "Open Cases
   20" (it reads the `open` status only); there is no time-range picker, so every windowed
   widget is silently fixed at 7 days; and widget bodies nest bordered tiles inside a
   bordered card, which the UI standard forbids (section 1.6).

---

## 1. Today: how dashboards work in this product

### 1.1 Surfaces

| Surface | Route | File | What it is |
|---|---|---|---|
| Cyber Defence Center | `#/overview` (nav: Overview, Dashboard) | `webui/src/soc/pages/Overview.tsx` (4,656 lines) | The landing page. Bespoke, not built from widgets. KPI strip of 6 cells, "Alert flow" band (noise-reduction flow, Human vs AI), "Cases and response" band (case state, response time, latest cases), "Deeper analytics" fold (MTTA, MTTR, dwell, LLM spend, coverage, volume, workload, outcomes, top signatures, top entities). |
| Dashboards | `#/dashboards` (nav: Overview, Dashboards, gated on `metrics:view`, `webui/src/soc/registry.tsx:236-240`) | `webui/src/soc/pages/Dashboards.tsx` | "Your build-your-own operations view." A switcher of the user's saved boards plus one per-role default. |
| Builder | inside Dashboards | `webui/src/soc/dashboard/DashboardBuilder.tsx` | Read-only view by default, explicit Edit mode, widget gallery, per-widget config sheet, keyboard move and resize, explicit Save, Discard, "Reset to default layout" or "Delete dashboard". The drag grid (`react-grid-layout`) loads only in Edit mode. |
| Analytics, Metrics | `#/metrics` | `webui/src/soc/pages/Metrics.tsx` | Tabs: Operational, Performance, Posture, Effectiveness, Cost. Fixed pages, not widgets. |
| Standup | `#/standup` | `webui/src/soc/pages/Standup.tsx` | Shift handoff (attention queue, SLA aging, workload, deltas). |

### 1.2 The widget catalogue (all 9 types that exist)

Canonical list: `webui/src/soc/dashboard/widget-types.contract.json`, mirrored by
`registry.ts:152-299` (client) and `backend/app/api/routes_dashboards.py:71-80` (server
allowlist). Contract tests fail CI if they drift.

| Type | Title | Body | Data source (provider key, endpoint, field) | RBAC gate |
|---|---|---|---|---|
| `kpi.needs_human` | Needs-human queue | `widgets/kpi.tsx` | `metrics`: `GET /api/metrics` `needs_human_cases` (status NEEDS_HUMAN, store-wide) and `open_cases` (status OPEN only) | `cases:read` |
| `kpi.cost_budget` | LLM cost (window) | `widgets/kpi.tsx` | `metrics`: `GET /api/metrics` `cost` (usage summary for the window) | `cost:view` |
| `chart.verdict_mix` | Cases by verdict | `widgets/mix.tsx` | `metrics`: `by_verdict` | `cases:read` |
| `chart.autonomous_vs_human` | Autonomous vs human | `widgets/mix.tsx` | `posture`: `GET /api/metrics/posture` `quality.auto/human/system_closed_cases` | `metrics:view` |
| `kpi.lifecycle_timing` | Response timing (p50) | `widgets/lifecycle.tsx` | `posture`: `lifecycle.mtta/mttr/dwell_minutes.p50` | `metrics:view` |
| `table.connector_health` | Connector health | `widgets/tables.tsx` | `sourcesHealth`: `GET /api/sources/health` | `sources:read` |
| `table.recent_cases` | Recent cases | `widgets/tables.tsx` | `cases`: `GET /api/cases?limit=25` | `cases:read` |
| `mitre.heatmap` | MITRE ATT&CK coverage | `widgets/mitre.tsx` | `mitre`: `GET /api/mitre/coverage?window_hours=0` (all time) | `metrics:view` |
| `gauge.active_risk` | Active risk index | `widgets/risk.tsx` | `metrics`: `active_risk_index` | `cases:read` |

The data layer is `DashboardDataProvider.tsx`: five source keys (`metrics`, `posture`,
`mitre`, `sourcesHealth`, `cases`, declared at `DashboardDataProvider.tsx:109-137`), each
fetched once per refresh and shared by every widget, narrowed to the sources the placed
widgets need (`DashboardBuilder.tsx:335-343`), auto-refreshed every 60 s while the tab is
visible. It deliberately has no `standup` source because `GET /api/standup` bills a model
call (`DashboardDataProvider.tsx:135`). The provider's window defaults to 168 hours and
the builder never passes one (`DashboardBuilder.tsx:429-433`), so there is no time picker.

### 1.3 Every metric endpoint a dashboard could read

All are read-only and none calls a model. "Auth only" means the route has no
`require_permission` and relies on the router-wide `require_auth` (`backend/app/main.py:137,146`).

| Endpoint | Gate | Key payload (verified live in the demo) | Used by widgets today |
|---|---|---|---|
| `GET /api/metrics?window_hours=` (`api/routes.py:2944`, body `routes_metrics.py:139`) | auth only | exact store-wide `total_cases`, `by_status`, `by_verdict`, `by_disposition`; `active_risk_index`, `avg_risk_score`, `mttr_minutes`, `cases_per_day`, `burndown`, `timing_trend`, `persona_usage`, `playbook_usage`, `feedback`, `retrieval_history`; windowed `cost` | yes |
| `GET /api/metrics/posture?window_hours=&compare=prev` (`routes_metrics.py:453`) | `metrics:view` | `case_count`, `severity_counts`, `open_now` (window-exempt stock), `lifecycle` (MTTA, MTTR, dwell, MTTD as p50/p90/mean/max with `available`), `quality` (TP, FP, needs human, escalated, auto/human/system closed, FP rate, automation rate, containment, escalation), `aging` (queue depth, age buckets, oldest, arrivals, closures), `sla` (attainment, breached, at risk, breaching list), `compare` (case count, FP rate, analyst-confirmed FP, escalation, automation, MTTR p50, MTTA p50 vs previous window), coverage flags | yes |
| `GET /api/metrics/trends?window_hours=` (`routes_metrics.py:538`) | `metrics:view` | buckets of `new_cases`, `closed`, `auto_closed`, `human_closed`, `system_closed`, `false_positives`, `analyst_confirmed_fp`, `needs_human`, `sent_to_human`, `escalated`, `fp_rate`, `alerts`; 1 h, 3 h, 6 h or 1 day buckets; max 720 h | no |
| `GET /api/metrics/noise-reduction?window_hours=` (`routes_metrics.py:834`) | `metrics:view` | funnel stages (ingested, clustered, cases, outcomes) by severity, `reduction.overall_pct`, counter coverage flags | no (Overview only) |
| `GET /api/metrics/auto-close-health?window_hours=` (`routes_metrics.py:592`) | `metrics:view` | current vs baseline vs lifetime auto-close rate, `status` (healthy, insufficient evidence, collapsed), policy state | no |
| `GET /api/metrics/agent-improvement` (`routes_metrics.py:775`) | `metrics:view` | 7-day vs 28-day agent quality comparison with explicit "insufficient evidence" | no (Effectiveness tab) |
| `GET /api/mitre/coverage?window_hours=` (`routes_metrics.py:927`) | `metrics:view` | `by_tactic`, `covered_techniques` of 697, `top_techniques` with case counts | yes |
| `GET /api/sources/health` (`api/routes.py:1339`) | `sources:read` | per source: enabled, kind, last poll, buffer depth, events per minute, last event, silent | yes |
| `GET /api/sources/coverage` (`api/routes.py:1363`) | `sources:read` | sources total, enabled, silent, events per minute, alerts triaged 24 h, worst last-event age | no (Overview only) |
| `GET /api/standup/report` (`routes_standup.py:104`) | auth only | deterministic shift snapshot: `attention_queue` (ranked open cases), `sla_aging`, `workload` (per analyst open, escalated, needs human), `deltas` (open, needs human, unassigned vs prior). Never runs a model (`agents/standup.py:213-242`). | no |
| `GET /api/usage/summary?window_hours=` (`api/routes.py:7088`) | auth only | total cost, tokens, calls, by surface, model, role, processing tier, `cost_over_time` | no (via `metrics.cost`) |
| `GET /api/budget/status` (`routes_models.py:861`) | `models:read` | daily and monthly spend against cap, band | no |
| `GET /api/campaigns` (`routes_campaigns.py:81`) | `cases:read` | active campaigns (shared-entity groupings of cases), total | no |
| `GET /api/tuning/recommendations` (`routes_tuning.py:166`) | `automation:read` | per-rule `rule_noise` (observed volume, analyst-confirmed FP rate, over target), pending and applied tuning | no |
| `GET /api/tuning/source-recommendations` (`routes_telemetry.py:21`) | `cases:read` | query-backed telemetry-gap evidence | no |
| `GET /api/schedulers/health` (`routes_schedulers.py:15`) | `automation:read` | tuner, campaign, batch and baseline loop health | no |
| `GET /api/baseline/stats` (`routes_baseline.py:90`) | `settings:read` | per-signature baseline stats | no |

Not exposed over HTTP but already built: `engine/case_aggregate.aggregate_cases`
(`engine/case_aggregate.py:1405`), the exact full-population aggregate with `group_by` on
`verdict`, `status`, `severity`, `priority`, `rule` (multi-valued), `assignee`, `source`,
`disposition`, `mitre_tactic`, `mitre_technique`, `decided_by`, `closed_by`, calendar
buckets, `top_n` with an exact "Other" remainder, and metrics `count`, `fp_rate`,
`auto_closed`, `human_closed`, `mtta_*`, `mttr_*`, `mttd_*`, `mean_risk`, `open_now`
(`engine/case_aggregate.py:1-120,196-258`). It is used by chat's `case_stats` tool
(`agents/chat_tools/stats.py:291-297`) and by `metrics_shared.fetch_case_breakdown`.
It returns aggregates only (#7).

### 1.4 Persistence, defaults, sharing

- **Per user only.** `stores/dashboards.py` keeps one KV document
  `{"dashboards": {"<user>": {"<id>": DashboardLayout}}}` (no index, table or migration),
  CAS-safe, capped at 50 per user in the store (`stores/dashboards.py:45`) and 24 per user
  and 40 widgets per board in the API (`routes_dashboards.py:84-85`). Every route keys on
  the signed-in user, so one user can never read another's dashboards.
- **Defaults are code-defined per role** (`registry.ts:392-409`): for example
  `super_admin` gets cost, connector health, needs-human, timing; analysts get
  needs-human, risk gauge, recent cases, verdict mix. The page offers it under the fixed
  id `overview` with the name "Overview" until the user saves a copy
  (`Dashboards.tsx:52-69,96-106`). "Reset to default layout" deletes the saved copy.
- **Org defaults exist on paper only.** `CustomizationConfig.default_dashboards`
  (`backend/app/config.py:803-821`) is a role-keyed map an admin could fill, and the clone
  route can copy from it (`routes_dashboards.py:372-435`), but the web UI never reads it
  for display. There is no shared, read-only, system or "published" dashboard concept.
- **Duplicate exists server-side.** `POST /api/dashboards/{id}/clone` copies a user's board
  (or an org default) into the user's set with a fresh id and "(copy)" suffix. The UI does
  not expose a Duplicate action today.
- **RBAC.** Editing needs `metrics:view` (`DashboardBuilder.tsx:70-71`). On load
  `reconcileWidgets` silently drops any widget the user lacks the grant for
  (`registry.ts:337-380`), so a stale layout never shows a widget the user cannot read, but
  the user is not told something was removed.
- **Demo Mode.** All read endpoints above serve the isolated demo store while Demo Mode is
  on (for example `/api/sources/health` returns the demo simulators,
  `api/routes.py:1355-1357`). Nothing is persisted from widgets.

### 1.5 Screenshots of today (shared demo, Admin)

All under `<scratch>/r14/shots/research/`:

- `dashboards-view-light-1440.png`, `dashboards-view-dark-1920.png`: the Admin role default
  ("Overview": LLM cost, Connector health, Needs-human queue, Response timing). Note the
  empty right column, the clipped connector table and the inner bordered tiles.
- `dashboards-edit-light-1440.png`, `dashboards-edit-dark-1920.png`: Edit mode (name field,
  Add widget, Reset to default layout, per-widget move handles, Save bar).
- `dashboards-gallery-light-1440.png`, `dashboards-gallery-dark-1920.png`: the "Add a widget"
  sheet with all nine widgets.
- `dashboards-overview-landing-light-1440.png`, `dashboards-overview-landing-dark-1920.png`:
  the Cyber Defence Center for comparison (the visual grammar the built-ins should follow).

Capture script: `<scratch>/r14/notes/shoot-dashboards.mjs`
(view, edit, gallery; it discards and never saves in the shared demo).

### 1.6 Defects and gaps found

1. **Contradictory open count.** The Needs-human widget prints "0 open cases total" from
   `open_cases` (cases whose status is exactly `open`, `widgets/kpi.tsx:23-24`), while the
   Overview shows "Open Cases 20" from `posture.open_now` (all active statuses). Live demo:
   `by_status` = closed 63, resolved 11, escalated 11, on_hold 5, investigating 3, new 1,
   so `open_cases` is 0 while 20 cases are open. The widget should use `open_now` and, like
   the Round 13 Standup tile, count open cases whose verdict is Needs human.
2. **No time picker.** Every windowed widget silently reads 168 hours and the cost widget
   says "(window)" without saying which. Elastic and Google SecOps scope the whole dashboard
   with one time picker; the Overview already has `TimeRangePicker`.
3. **Mixed populations on one board.** `GET /api/metrics` counts are store-wide (all time)
   but its `cost` is windowed; posture widgets are windowed. Built-ins must label each
   population ("all time", "last 24 hours", "open now") the way the Overview does.
4. **Nested cards and holes.** `WidgetShell` wraps a body in a bordered `ChartCard`, and the
   KPI widgets put bordered, left-striped tiles inside it. `docs/development/ui-standard.md`
   (Dashboard bands) says "Never nest a panel in a panel" and uses the borderless
   `.surface-panel` recipe. The packed grid also leaves an empty column at 1440 and 1920.
5. **Name collision.** The per-role default is called "Overview" in a section that sits
   under the "Overview" nav group next to the real Overview page.
6. **Top lists are client-side.** The Overview's "Top signatures" and "Top entities" are
   computed from a bounded 200-case page (`Overview.tsx:1864`), not from the exact
   aggregate engine. A dashboard "top rules" panel should use the server aggregate.
7. **Ungated reads (minor, verify).** `/api/metrics`, `/api/usage/summary` and
   `/api/standup/report` require only sign-in, while the Dashboards nav gates on
   `metrics:view`. Not a leak of anything a signed-in user cannot already see elsewhere, but
   inconsistent with the `metrics:view` model.

---

## 2. Industry: what ships by default

### 2.1 Built-in dashboards by vendor

| Vendor | Built-in dashboards (exact names where documented) | What the non-landing ones cover | Lifecycle rules |
|---|---|---|---|
| **Splunk Enterprise Security 8** | Security posture; Executive summary; SOC operations; Audit dashboards (Analyst queue audit, Suppression audit); Risk analysis; plus domain dashboards (Access, Endpoint, Network, Identity, Threat intelligence) | **Executive summary**: mean time to triage, mean time to resolution, investigations created, each with a trend against the previous equal window; findings by urgency over time; findings by domain; untriaged findings by domain, source and type; frequent and rare finding sources; risk panels; detections enabled vs disabled. **SOC operations**: the same three KPIs plus assigned vs unassigned findings over time. **Security posture**: key indicators, findings by urgency, findings over time, top findings by rule with sparklines, top 10 finding sources; every click opens the analyst queue filtered to that slice. | Shipped with the app; customise by cloning. |
| **Microsoft Sentinel** | Overview page plus workbook templates: Security Operations Efficiency; Data collection health monitoring; Analytics Health & Audit; MITRE ATT&CK Workbook; Incident Overview; Investigation Insights; Workspace Usage Report | **Security Operations Efficiency** (for SOC managers): incidents created over time; by closing classification, severity, owner, status; mean time to triage and to closure; triage and closure percentiles (p5, p50, p90, p99); mean time to triage per owner; incidents by tactic over time; recent closing classifications. **Data collection health**: ingestion size, latency, logs per source, anomalies. **Analytics Health & Audit**: whether each rule runs as expected and its change history. | Templates; "Save" makes your own copy. |
| **Cortex XSIAM / Cortex Cloud** | Command Center (landing); system dashboards including Security Manager, My Dashboard, Data Ingestion, MITRE ATT&CK Framework Coverage, Automation Insights, Threat Intel Management, Troubleshooting Playbooks, Risk Management | **Security Manager**: 30-day open cases by severity, top 10 open cases, workload by assignee. **Data Ingestion**: ingestion rates, by vendor and product, quota. **MITRE coverage**: content and detection coverage by technique and tactic. **Automation Insights**: automation performance, automatically closed issues, execution trends. **My Dashboard**: personal assignments and MTTR. | "System dashboards are managed by the platform and can't be edited or deleted"; "duplicate any system dashboard ... to get an editable copy". Command Center is read-only. |
| **Cortex XDR 3.x** | Incident management, My dashboard, Security admin, Security manager, Data ingestion, Risk management, Agent management | Security admin: resolved and overdue incidents. Incident management: top incidents, hosts, assignees. | Predefined; set any as default; base custom dashboards on them. |
| **Google SecOps** | Curated: Entities, IoC matches, Ingestion metrics, Rules and detections, SOAR cases, SOAR case history, SOAR playbooks, Unified Data Model; SOAR "SOC Status" | **Rules and detections**: rule performance and threat patterns. **Ingestion metrics**: data flow, errors, log distribution. **SOAR cases**: case metrics. | "You cannot edit or delete curated dashboards, you can create a copy and customize it." Max 12 widgets per SOAR dashboard. |
| **Elastic Security** | Overview, Detection & Response, Entity Analytics, Data Quality, plus cloud and Kubernetes dashboards, AI value report | **Detection & Response** (SOC managers and analysts): alerts by status and severity, cases by status, open alerts by rule (top 4), recently created cases (4), hosts and users by alert severity. **Data Quality**: index mapping problems. **Value report**: analyst time saved, escalated vs filtered. | Built in; page-level date picker scopes all panels. |
| **Datadog Cloud SIEM** | Cloud SIEM overview dashboard with Security Operational Metrics, weekly digest | Time to detect, acknowledge, investigate and resolve as distribution metrics (percentiles, filter by team and source). | Out of the box; clone to customise. |
| **IBM QRadar** | Default dashboards include Threat and Security Monitoring, System Monitoring, Network Overview, Compliance Overview, Vulnerability Management, Application Overview (dated source) | System Monitoring is the data-health board. | Default, user-customisable. |
| **CrowdStrike Falcon** | Executive summary, Detection activity, Detection resolution; role dashboards for SOC analyst, IT admin, vulnerability analyst | Detection activity: detections organised by tactic, severity, host. Detection resolution: opened and closed cases. | Customisable widgets. |
| **Microsoft Defender XDR** | Home with role-dependent cards (active incidents, Secure Score, device status), unified reports | Cards can be added, removed and rearranged per user. | Per user. |

### 2.2 What SOC metrics practice says to measure

- **SANS SOC Survey 2023:** 84% of SOCs collect metrics; the top three are number of
  incidents, time from detection to eradication, and ratio of incidents from known vs
  unknown vulnerabilities. **SANS 2025:** 69% still report metrics manually, which is the
  reason built-in dashboards matter.
- **MITRE, 11 Strategies of a World-Class Cybersecurity Operations Center:** strategy 10 is
  "Measure performance to improve performance" and the book stresses telling the SOC's
  story through metrics. NVISO's commentary warns that raw alert and ticket counts are poor
  KPIs on their own because detection configuration changes them; pair volume with quality
  (false-positive rate, analyst-confirmed outcomes) and timing.
- **Timing is reported as percentiles, not only means** (Sentinel p5/p50/p90/p99, Datadog
  distribution metrics). Our posture rollup already carries p50 and p90.
- **Every number compares with the previous equal window** (Splunk executive summary
  trendlines, XSIAM KPI arrows). Our posture `compare=prev` already returns these.
- **The common SOC metric set:** MTTD, MTTA (triage), MTTR, alert volume and alert-to-case
  reduction, false-positive rate, automation rate, analyst workload and unassigned queue,
  SLA attainment, backlog aging, detection coverage by ATT&CK, source health, cost. This
  product already computes all of them; only per-rule and per-source breakdowns lack an
  HTTP endpoint.

### 2.3 The three aspects beyond the landing page

| Aspect | Audience | Question it answers | Precedents |
|---|---|---|---|
| **Operations** | SOC manager, shift lead | Is the team keeping up right now? Who is overloaded, what is breaching SLA, what is aging? | Splunk SOC operations, Sentinel Security Operations Efficiency, XSIAM Security Manager, Cortex XDR Security admin, Google SOC Status |
| **Detection and data health** | Detection engineer, platform admin | Are we seeing everything, and are the detections any good? Which rules are noisy, which sources are silent, what ATT&CK ground do we cover? | Google Rules and detections + Ingestion metrics, Sentinel Data collection health + Analytics Health & Audit + MITRE workbook, XSIAM Data Ingestion + MITRE coverage, Elastic Detection & Response + Data Quality, Splunk Security posture (top rules, top sources) |
| **Executive** | CISO, leadership, auditors | Are we safer and faster than last period, and what is automation giving us for what it costs? | Splunk Executive summary, CrowdStrike Executive summary, Elastic value report, XSIAM Automation Insights, Sentinel Overview automation section |

---

## 3. Recommendation

### 3.1 The three built-in dashboards

Visual grammar for all three (ask 8 asks for the dashboard look everywhere): a KPI strip on
its own grouped panel at the top, exactly as on the Cyber Defence Center, then modules on
borderless `.surface-panel` panels, 12-column grid, no nested cards, each module with a
plain title, one-line population caption ("last 24 hours", "open now", "all time") and a
"View ..." exit to the page that lists the population. Each dashboard has one page-level
`TimeRangePicker` with its own default window. Rows below use 12 columns.

#### A. "SOC operations" (default window: last 24 hours, compared with the previous 24)

Audience: SOC manager and shift lead. Question: is the team keeping up today?

| # | Widget | Exact metric | Chart | Data source in this product | Reuse or new |
|---|---|---|---|---|---|
| 1 | KPI strip, operations preset (w12) | Open now (stock); Awaiting a human decision (open cases with verdict Needs human); Unassigned open; SLA breached (response + resolve); Median time to acknowledge; Median time to resolve; each with delta vs previous window where one exists | 6-cell strip | `posture.open_now.count`; `standup/report` `deltas.needs_human`, `deltas.unassigned`; `posture.sla.response_breached + resolve_breached`; `posture.lifecycle.mtta_minutes.p50`, `mttr_minutes.p50`; `posture.compare.mtta_p50`, `mttr_p50` | **New** `kpi.strip` (preset `operations`), reuses `KpiTile`/`KpiTileGrid` |
| 2 | Arrivals vs closures (w8) | New cases vs closed per bucket, closed split AI agent / human / system | Line plus stacked columns | `GET /api/metrics/trends` `new_cases`, `auto_closed`, `human_closed`, `system_closed` | **New** `chart.case_trend` (series preset `flow`), new provider key `trends` |
| 3 | Who closed (w4) | AI agent / Human / System share of closes | Donut | `posture.quality` | **Reuse** `chart.autonomous_vs_human` |
| 4 | Needs attention now (w8) | Top 8 open cases ranked by urgency: case number, title (plain text), risk, SLA state, age, assignee | Table; row opens the case sheet | `standup/report` `attention_queue` | **New** `table.attention_queue`, new provider key `shift` |
| 5 | Analyst workload (w4) | Open, escalated, needs human per analyst, unassigned first | Table with inline bars | `standup/report` `workload` | **New** `table.workload` |
| 6 | Backlog aging (w4) | Open cases from the window by age bucket (<1h, 1-4h, 4-24h, 1-3d, 3-7d, >7d) | Columns | `posture.aging.age_buckets`, `queue_depth`, `oldest` | **New** `chart.backlog_aging` |
| 7 | SLA breaches and at risk (w4) | Breaching and at-risk cases with priority, clock, percent over | Table | `posture.sla.breaching` (top 25), `attainment_pct` | **New** `table.sla_breaches` |
| 8 | Open cases by status (w4) | New, investigating, escalated, on hold, needs human | Ranked bars | `GET /api/metrics` `by_status` (exact) filtered to active statuses | **New** `chart.case_breakdown` (option `by=status`) |
| 9 | Response timing (w12) | MTTD, MTTA, MTTR, dwell as p50 and p90 with case counts | 4-cell timing strip | `posture.lifecycle` | **Reuse** `kpi.lifecycle_timing`, extended with MTTD and p90 |

Layout sketch (1440 and wider):

```
[ KPI strip: Open now | Awaiting human | Unassigned | SLA breached | MTTA p50 | MTTR p50 ]
[ Arrivals vs closures (8)                         ][ Who closed (4)          ]
[ Needs attention now (8)                          ][ Analyst workload (4)    ]
[ Backlog aging (4) ][ SLA breaches and at risk (4) ][ Open cases by status (4)]
[ Response timing: MTTD | MTTA | MTTR | Dwell, p50 and p90 (12)                ]
```

#### B. "Detection and data health" (default window: last 7 days)

Audience: detection engineer and platform admin. Question: are we seeing everything, and
are the detections any good?

| # | Widget | Exact metric | Chart | Data source in this product | Reuse or new |
|---|---|---|---|---|---|
| 1 | KPI strip, detection preset (w12) | Sources reporting (enabled of total); Silent sources; Events per minute; Alerts ingested (window); Alert reduction % (alerts to cases); ATT&CK techniques seen (of 697) | 6-cell strip | `GET /api/sources/coverage`; `GET /api/metrics/noise-reduction` `stages[ingested].total`, `reduction.overall_pct`; `GET /api/mitre/coverage` `covered_techniques` | **New** `kpi.strip` (preset `detection`), new provider keys `coverage`, `noise` |
| 2 | Alerts and cases over time (w8) | Alerts ingested vs cases created per bucket | Two lines | `trends` `alerts`, `new_cases` | **New** `chart.case_trend` (preset `alerts`) |
| 3 | Noise reduction (w4) | Ingested, clustered, cases, auto-cleared, sent to human | Compact stage bars (the Overview "Simple" funnel, small) | `noise-reduction` `stages` | **New** `chart.noise_funnel` (reuses Overview funnel parts) |
| 4 | Top detection rules (w6) | Top 10 rules by cases in window: cases, share, AI false-positive rate, open now; row opens Cases filtered to that rule | Table with inline bars | **New** `GET /api/metrics/breakdown?by=rule&top=10` (`aggregate_cases`, metrics `count`, `fp_rate`, `open_now`) | **New** `table.top_rules`, new provider key `breakdownRule` |
| 5 | Noisiest rules (w6) | Rules over the false-positive target: observed volume, analyst-confirmed FP rate, samples, tuning state (proposed, applied) | Table | `GET /api/tuning/recommendations` `rule_noise`, `recommendations`, `applied` | **New** `table.noisy_rules`, new provider key `tuning` (`automation:read`) |
| 6 | Connector health (w6) | Per source: enabled, kind, events per minute, last event age, silent flag | Table | `GET /api/sources/health` | **Reuse** `table.connector_health` (add last-event age and silent) |
| 7 | Cases by source (w6) | Cases per source in window with FP rate | Ranked bars | `breakdown?by=source` | **New** `chart.case_breakdown` (option `by=source`) |
| 8 | ATT&CK techniques seen (w8) | Tactic by technique heatmap, labelled "techniques seen in cases", not "detection coverage" | Heatmap | `GET /api/mitre/coverage` | **Reuse** `mitre.heatmap` (honest label) |
| 9 | Top techniques (w4) | Top 10 techniques by case count | Ranked bars | `mitre/coverage` `top_techniques` | **New** `table.top_techniques` |
| 10 | Auto-close health (w4) | Current vs baseline auto-close rate, decided volume, status | Stat with status line | `GET /api/metrics/auto-close-health` | **New** `kpi.auto_close_health`, new provider key `autoClose` |
| 11 | Telemetry gaps (w8, optional) | Query-backed telemetry-gap recommendations | List | `GET /api/tuning/source-recommendations` | **New** `table.telemetry_gaps` (optional, can wait) |

```
[ KPI strip: Sources reporting | Silent | Events/min | Alerts ingested | Reduction | Techniques seen ]
[ Alerts and cases over time (8)                   ][ Noise reduction (4)      ]
[ Top detection rules (6)              ][ Noisiest rules (6)                   ]
[ Connector health (6)                 ][ Cases by source (6)                  ]
[ ATT&CK techniques seen (8)                       ][ Top techniques (4)       ]
[ Auto-close health (4) ][ Telemetry gaps (8, optional)                        ]
```

Honesty note: our ATT&CK view counts techniques observed on cases. We do not own an
upstream rule catalogue with technique mappings, so this must not be labelled "detection
coverage" (XSIAM's term). "Techniques seen in cases" is the honest label.

#### C. "Executive summary" (default window: last 30 days, compared with the previous 30)

Audience: CISO, leadership, auditors. Question: are we safer and faster than last period,
and what does automation give us for what it costs? Every figure carries its delta.

| # | Widget | Exact metric | Chart | Data source in this product | Reuse or new |
|---|---|---|---|---|---|
| 1 | KPI strip, executive preset (w12) | Cases; Confirmed threats (true positive cases); Median time to detect; Median time to resolve; Closed by the AI agent (automation rate); SLA attainment; each with change vs previous 30 days | 6-cell strip | `posture` `case_count`, `quality.true_positive_cases`, `lifecycle.mttd_minutes.p50`, `lifecycle.mttr_minutes.p50`, `quality.automation_rate`, `sla.attainment_pct`, `compare.*` | **New** `kpi.strip` (preset `executive`) |
| 2 | Cases by severity over time (w8) | Daily or weekly case counts stacked by severity band | Stacked columns | `breakdown?by=severity&bucket=week` | **New** `chart.severity_trend`, new provider key `breakdownSeverity` |
| 3 | Active risk index (w4) | Mean risk of open cases (stock) | Gauge | `GET /api/metrics` `active_risk_index` | **Reuse** `gauge.active_risk` |
| 4 | Outcomes over time (w8) | True positive, false positive, needs human per bucket | Stacked columns | `trends` (`new_cases`, `false_positives`, `needs_human`, `escalated`) | **New** `chart.case_trend` (preset `outcomes`) |
| 5 | Who closed (w4) | AI agent / Human / System | Donut | `posture.quality` | **Reuse** `chart.autonomous_vs_human` |
| 6 | Top ATT&CK techniques (w4) | Top 5 techniques this period | Ranked bars | `mitre/coverage?window_hours=720` `top_techniques` | **New** `table.top_techniques` (shared with B) |
| 7 | Cases by source (w4) | Where threats came from | Ranked bars | `breakdown?by=source` | **New** `chart.case_breakdown` (shared with B) |
| 8 | AI spend (w4) | Spend this period, spend per case, budget band | Stat | `GET /api/usage/summary` `total_cost` / `posture.case_count`; `GET /api/budget/status` | **Reuse** `kpi.cost_budget`, fixed to the page window plus per-case figure (`cost:view`; budget line only with `models:read`) |
| 9 | Active campaigns (w6) | Multi-case campaigns: count and the largest by case count | Stat plus short list | `GET /api/campaigns` | **New** `table.campaigns` (`cases:read`) |
| 10 | Agent quality trend (w6, optional) | Analyst-reported agreement and correction rate, 7 vs 28 days, or "Not enough evidence yet" | Stat with reason | `GET /api/metrics/agent-improvement` `headline` | **New** `kpi.agent_quality` (optional) |

```
[ KPI strip: Cases | Confirmed threats | MTTD p50 | MTTR p50 | Closed by AI | SLA attainment ]
[ Cases by severity over time (8)                  ][ Active risk index (4)    ]
[ Outcomes over time (8)                           ][ Who closed (4)           ]
[ Top techniques (4) ][ Cases by source (4)         ][ AI spend (4)             ]
[ Active campaigns (6)                 ][ Agent quality trend (6, optional)    ]
```

Not recommended: an "analyst hours saved" headline. Elastic and XSIAM show one, but it is a
formula over assumed handling times. Our agent-improvement endpoint already reports
"insufficient evidence" in the demo, and the product's honesty rule prefers an explicit
"not measured" over an invented number. Revisit only with a measured baseline.

### 3.2 New widget types and the one new endpoint

New widget types (each needs one contract value, one registry entry, one lazy body, the
server allowlist and the two contract tests):

| Type | Used by | Provider key(s) |
|---|---|---|
| `kpi.strip` (option `preset`: operations, detection, executive) | A, B, C | `posture`, `shift`, `coverage`, `noise`, `mitre` |
| `chart.case_trend` (option `series`: flow, alerts, outcomes) | A, B, C | `trends` |
| `chart.case_breakdown` (option `by`: status, verdict, source, severity, closed_by) | A, B, C | `metrics` (status, verdict) or `breakdown*` |
| `chart.severity_trend` | C | `breakdownSeverity` |
| `chart.backlog_aging` | A | `posture` |
| `chart.noise_funnel` | B | `noise` |
| `table.attention_queue` | A | `shift` |
| `table.workload` | A | `shift` |
| `table.sla_breaches` | A | `posture` |
| `table.top_rules` | B | `breakdownRule` |
| `table.noisy_rules` | B | `tuning` |
| `table.top_techniques` | B, C | `mitre` |
| `kpi.auto_close_health` | B | `autoClose` |
| `table.campaigns` | C | `campaigns` |
| optional: `table.telemetry_gaps`, `kpi.agent_quality` | B, C | `telemetry`, `agentImprovement` |

Existing types reused: `chart.autonomous_vs_human`, `kpi.lifecycle_timing` (extend with
MTTD and p90), `table.connector_health` (add last-event age, silent), `mitre.heatmap`
(honest label), `gauge.active_risk`, `kpi.cost_budget` (page window, per-case cost).
Fix `kpi.needs_human` (use `open_now` and the verdict definition).

New provider keys: `trends`, `noise`, `shift`, `coverage`, `autoClose`, `usage`, `budget`,
`campaigns`, `tuning`, `breakdownRule`, `breakdownSource`, `breakdownSeverity`. All are
non-billing reads; `standup` (which bills) stays excluded. The provider already narrows
fetches to the sources the placed widgets need, and posture, trends and noise reads share
the server's short-lived case population cache (`api/metrics_shared.py`), so a built-in
costs about 6 to 8 round trips per refresh.

New endpoint (the only backend addition):

```
GET /api/metrics/breakdown?by=rule|source|severity|mitre_tactic|mitre_technique|assignee|closed_by
                          &window_hours=168&top=10&bucket=day|week (optional)
gate: metrics:view
body: CaseAggregateSpec(window, group_by=(by,), bucket, metrics=("count","fp_rate","open_now"),
      top_n=top, prefs=state.prefs) -> aggregate_cases(state.cases, spec)
returns: {groups:[{key, bucket, count, fp_rate, verdicted, open_now}], other, total,
          exact, partial, multi_valued, window_label, window_from, window_to}
```

It reuses the same engine and window grammar as chat's `case_stats`, so the dashboard and
chat agree on every number. `rule` is multi-valued (a case with two rules counts in both
rows); the response says so and the widget must not present the rows as summing to the
total. Rule ids, source names and technique names are attacker-influenced values: render as
plain text (#9), never feed them to a prompt. This endpoint also serves Round 14 asks 6
and 7 (a rule-level view behind "top detection rules" and a severity-to-rule breakdown).

### 3.3 How they appear in the Dashboards section

Rules (copied from Cortex XSIAM system dashboards and Google SecOps curated dashboards):

- **Built-ins are read-only.** No Edit button; instead a primary **Duplicate to customise**
  action that creates a personal copy named "SOC operations (copy)" through the existing
  `POST /api/dashboards` (widgets copied client-side; the server allowlist re-validates)
  and opens it in Edit mode.
- **Built-ins cannot be deleted.** A per-user **Hide from my list** is allowed and
  reversible from a "Manage dashboards" menu; store the hidden ids in `UserPrefs.misc`
  (for example `misc.dashboards_hidden: ["builtin:executive"]`). No new store.
- **Clearly marked.** A "Built-in" label beside the name and a one-line purpose under it
  ("For SOC managers: queue, workload, SLA and response times").
- **Fixed order.** 1 Cyber Defence Center (marked "Landing page", selecting it goes to
  `#/overview`, it is not re-implemented as widgets), 2 SOC operations, 3 Detection and
  data health, 4 Executive summary, then the user's own boards. The per-role default
  becomes **"My dashboard"** (XSIAM's name for the personal board; keep the internal id
  `overview` so existing saved copies still match).
- **Reserved id namespace.** Built-ins use ids `builtin:<slug>`. The server should reject a
  user dashboard whose id starts with `builtin:` (one line in `_sanitize_layout`), so a
  personal board can never shadow a built-in.
- **Built-ins update with releases;** a duplicate is a snapshot and does not. Say so in the
  Duplicate confirmation.
- **Optional, later:** "Set as my landing page" (XDR and XSIAM allow it) via
  `UserPrefs.misc.landing_dashboard`; org-published dashboards via the dormant
  `CustomizationConfig.default_dashboards`.

Presentation options to prototype and screenshot (the operator asked for options):

- **Option 1, switcher with groups (smallest change).** Keep today's Select in the header,
  grouped "Built-in" and "Yours", with the Built-in label and a Duplicate button.
- **Option 2, tabs (recommended).** A segmented tab row under the page title: "Cyber Defence
  Center", "SOC operations", "Detection and data health", "Executive summary", "My
  dashboards" (the last opens a menu of personal boards plus New dashboard). Four or five
  tabs fit at 1280px; switching is one click and deep-linkable (`#/dashboards?d=executive`).
- **Option 3, library page.** A gallery of cards (name, audience, one-line purpose, small
  preview, Built-in label) like a Dashboard Manager, then open one. Best when there are many
  boards; slower for daily switching.

### 3.4 Permissions

- The Dashboards entry stays gated on `metrics:view` (unchanged).
- Each widget keeps its `requires`. Built-ins are flow-packed, so a widget the viewer cannot
  read is omitted without leaving a hole, and the header says so in one line: "2 panels need
  permissions your role does not have" (Splunk shows an error rather than a fake value;
  silently dropping, as today's reconcile does, hides the reason).
- Gates to set: KPI strip cells degrade per cell (a cell whose source the user cannot read
  shows "No access", the strip stays); `table.noisy_rules` needs `automation:read`;
  `kpi.cost_budget` needs `cost:view` (budget line also `models:read`); `table.campaigns`,
  `table.attention_queue`, `table.workload`, `table.sla_breaches` need `cases:read`;
  connector and coverage panels need `sources:read`; breakdown, posture, trends, noise,
  MITRE and auto-close need `metrics:view`.
- A built-in whose every widget is denied is not listed for that user.
- **Row-level data scope (`can_object`, shipped off):** the aggregate endpoints do not apply
  object scope today. If an operator turns scope on, store-wide built-in figures would show
  counts beyond the viewer's scope. Chat starters skip case families under object scope for
  the same reason. Recommend the same: hide case-derived built-in panels when object scope
  is on until the aggregates are scope-aware (open question for the operator).

### 3.5 Demo Mode

- Every source above already serves the demo store while Demo Mode is on, so the built-ins
  work in the demo with no special code.
- Expected honest gaps in the demo (verified live): MTTA is unavailable ("no case has been
  acknowledged yet"), noise counters report partial coverage, auto-close baseline has
  "insufficient evidence", agent improvement is `synthetic: true`. Each widget must show its
  reason, never a zero. Seeding a few human acknowledgements in the demo generator would
  make the Operations board look complete (optional).
- Refetch on a Demo Mode switch: key the provider on the Demo identity token introduced in
  Round 13 (PR 132) so a toggle never shows real figures under a demo badge or the reverse.

### 3.6 Non-negotiables check

- **#3:** dashboards are presentation; nothing here is read by `decide()`.
- **#6:** no source calls a model. The billing `GET /api/standup` stays excluded; the
  deterministic `GET /api/standup/report` is safe (`agents/standup.py:213-242`). If an
  "Ask about this" or AI summary is ever added to the Executive board it must be an
  explicit click through the one gateway, never on load.
- **#7:** every widget reads aggregates, or case rows (not raw logs). No built-in shows log
  events; the Logs page remains the place for those. Any future AI summary must use the
  bounded aggregate digest pattern (`engine/report_digest.py`).
- **#9:** rule ids, source names, technique names, case titles and assignee names are
  rendered as plain text; never `dangerouslySetInnerHTML`; never into a prompt.
- **New store:** none. Built-ins are code; duplicates use `DashboardStore`; hidden list in
  `UserPrefs.misc`.
- **Bundle:** built-in widget bodies stay `React.lazy`; the view mode still ships no grid
  library; the entry chunk budget is unaffected.

### 3.7 Suggested work split (for the spec)

1. Backend: `GET /api/metrics/breakdown` plus tests (exact vs fold parity with `case_stats`,
   multi-valued rule rows, RBAC 403, Demo store); reserve `builtin:` ids; extend the widget
   allowlist.
2. Web data: new provider keys; page-level `TimeRangePicker` wired into the provider.
3. Web widgets: the new types above, in the Overview's visual grammar (`surface-panel`, no
   nested cards, KPI strip parity); fix `kpi.needs_human`, `kpi.cost_budget`,
   `table.connector_health`, `kpi.lifecycle_timing`.
4. Web shell: built-in definitions (`SYSTEM_DASHBOARDS` beside `ROLE_DEFAULT_WIDGETS`),
   read-only mode, Duplicate, Hide and Manage, "My dashboard" rename, the chosen
   presentation option, permission note.
5. Docs: Help Center page for the three dashboards and each metric's definition; ui-standard
   section for widget panels.

---

## 4. Open questions for the operator

1. Names: "SOC operations", "Detection and data health", "Executive summary". Acceptable,
   or prefer "Threat detection" or "Leadership summary"?
2. Default windows: 24 hours, 7 days and 30 days. Acceptable?
3. Presentation: tabs (recommended), grouped switcher, or a library page?
4. Should a user be able to hide a built-in, and should "Set as my landing page" be in this
   round?
5. Should the Executive board include AI spend, or keep cost to the Cost page?
6. With row-level data scope turned on, hide case-derived built-in panels until aggregates
   are scope-aware?

---

## 5. Sources

External:

- Splunk ES 8 Security posture dashboard: https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.5/analytics/security-posture-dashboard
- Splunk ES 8 Executive summary dashboard: https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.5/analytics/executive-summary-dashboard
- Splunk ES 8 SOC operations dashboard: https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.5/analytics/soc-operations-dashboard
- Splunk ES 8 Audit dashboards: https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.1/analytics/audit-dashboards
- Microsoft Sentinel, manage your SOC with incident metrics (Security Operations Efficiency workbook): https://learn.microsoft.com/en-us/azure/sentinel/manage-soc-with-incident-metrics
- Microsoft Sentinel, commonly used workbooks: https://learn.microsoft.com/azure/sentinel/top-workbooks
- Cortex XSIAM / Cortex Cloud system dashboards (read-only, duplicate): https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/system-dashboards
- Cortex XDR 3.x predefined dashboards: https://cortex-docs.paloaltonetworks.com/cortex-xdr-3.x/cortex-xdr-3.x-documentation/investigate-and-respond-to-incidents/dashboards/predefined-dashboards
- Google SecOps curated dashboards (cannot edit or delete, copy to customise): https://docs.cloud.google.com/chronicle/docs/reports/native-curated-dashboards
- Google SecOps dashboards overview: https://docs.cloud.google.com/chronicle/docs/reports/dashboards-overview
- Elastic Detection & Response dashboard: https://elastic.co/guide/en/serverless/current/security-detection-response-dashboard.html
- Elastic Security UI (dashboard list): https://www.elastic.co/docs/solutions/security/get-started/elastic-security-ui
- Datadog Cloud SIEM security operational metrics: https://docs.datadoghq.com/security/cloud_siem/respond_and_report/security_operational_metrics/
- IBM QRadar default dashboards (dated course material): https://www.scribd.com/document/563311154/Merge
- CrowdStrike Falcon dashboard types (video): https://www.crowdstrike.com/videos/how-to-hunt-for-threat-activity-with-falcon-endpoint-protection/
- Microsoft Defender portal home cards: https://learn.microsoft.com/en-us/learn/modules/describe-threat-protection-with-microsoft-365-defender/7-describe-microsoft-defender-portal
- SANS 2023 SOC survey metrics (summary): https://www.extrahop.com/blog/top-5-soc-skills-and-metrics-2023-sans-soc-survey/
- SANS 2025 State of the SOC survey: https://www.elastic.co/resources/security/report/2025-state-of-the-soc-survey
- MITRE, 11 Strategies of a World-Class Cybersecurity Operations Center: https://www.mitre.org/news-insights/news-release/mitre-publishes-11-strategies-world-class-cybersecurity-operations
- NVISO, going beyond traditional SOC metrics: https://blog.nviso.eu/2021/05/26/going-beyond-traditional-metrics-3-key-strategies-to-measuring-your-soc-performance/
- Earlier in-repo vendor teardown (XSIAM Command Center, Google SOAR, Sentinel Overview, Elastic value report): `docs/research/2026-10-round12/research/dashboard-ux.md` sections 1.1 to 1.8

In-repo code (all paths relative to the repository root):

- `webui/src/soc/pages/Dashboards.tsx:52-69,96-106,201`
- `webui/src/soc/dashboard/registry.ts:152-299,337-380,392-444`
- `webui/src/soc/dashboard/DashboardDataProvider.tsx:109-137,153`
- `webui/src/soc/dashboard/DashboardBuilder.tsx:70-71,335-343,384,429-433`
- `webui/src/soc/dashboard/widgets/kpi.tsx:20-49`
- `webui/src/soc/dashboard/widget-types.contract.json`
- `webui/src/soc/registry.tsx:224-242,344-362`
- `webui/src/soc/pages/Overview.tsx:1-90,1864`
- `backend/app/api/routes_dashboards.py:71-85,246-435`
- `backend/app/stores/dashboards.py:1-60,45`
- `backend/app/config.py:785-841`
- `backend/app/models.py:794-848,929-949`
- `backend/app/api/routes_metrics.py:83-91,139-176,453-591,592,775,834,927`
- `backend/app/api/routes.py:1339-1415,2944-2952,7088`
- `backend/app/api/routes_standup.py:104-165`, `backend/app/agents/standup.py:213-242`
- `backend/app/engine/case_aggregate.py:1-120,196-258,1405`
- `backend/app/main.py:137,146`
- `docs/development/ui-standard.md:1083-1110` (Dashboard bands)
