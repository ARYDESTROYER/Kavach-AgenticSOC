# Round 14 research: drilling into a rule, and a severity breakdown people can use (asks 6 and 7)

Research brief, 2026-10-25. Scope: operator asks 6 and 7. Read only; no product code was changed.

Operator, verbatim:

- Ask 6: "When clicked on the alert it should show like a dashboard or all alerts under that rule or something ? Got it ? Refer IMG"
- Ask 7: "Severity - count. metric is confusing and what reference can human even take from it ? Atleast show the rule or something in it ? Or a dropdown ? Something like that. Check img"

Screenshots used in this brief (all 1440x900, light theme, shared Demo on port 5901):

| File | What it shows |
|---|---|
| `scratchpad/r14/notes/drill/op-top-rules.png` | The operator's own screenshot (converted from webp): "Top detection rules" table, RULE / COUNT, with a stray dark "Top detection rules" tooltip over the table |
| `scratchpad/r14/notes/drill/op-case-entity.png` | The operator's case entity answer (Case entity, Status history, Case figures) |
| `scratchpad/r14/shots/research/drill-toprules-viewport.png` | Demo reproduction: "What are the top detection rules this week?" gives "Top rules (this week)" bars; nothing is clickable |
| `scratchpad/r14/shots/research/drill-severity-viewport.png` | Demo reproduction: "Show alerts by severity for the last 3 days" gives "Top severities (last 3 days)" with bars labelled `30.0` (947) and `10.0` (53) |
| `scratchpad/r14/shots/research/drill-suspicious-*.png` | "Any suspicious activity in last 3 days ?" in Demo (falls back to a case list, verdict chart and key figures) |
| `scratchpad/r14/shots/research/drill-tpcase-*.png` | "Investigate the confirmed true-positive case" in Demo (case list and key figures) |
| `scratchpad/r14/shots/research/drill-today-logs-rule-text.png` | Today's closest "all alerts under that rule": the Logs page with the rule name typed as free text. Note it already shows severity as `Medium (30)` |
| `scratchpad/r14/shots/research/drill-option-6A-rule-sheet.png` | Mockup, ask 6 option A: rule drill-down sheet (mini dashboard) |
| `scratchpad/r14/shots/research/drill-option-6B-filtered-logs.png` | Mockup, ask 6 option B: the Logs page opened with an exact Rule filter |
| `scratchpad/r14/shots/research/drill-option-6C-row-expand.png` | Mockup, ask 6 option C: the table row expands in place |
| `scratchpad/r14/shots/research/drill-option-7A-named-bands-top-rules.png` | Mockup, ask 7 option A: named severities with share, trend and top rules per row |
| `scratchpad/r14/shots/research/drill-option-7B-split-by-stacked.png` | Mockup, ask 7 option B: a "Split by" control with stacked bars |
| `scratchpad/r14/shots/research/drill-option-7C-rule-severity-matrix.png` | Mockup, ask 7 option C: a rule by severity matrix |

(`scratchpad` = `<scratch>`. The mockups are static HTML in `scratchpad/r14/notes/drill/mock.html`, rendered by `scratchpad/r14/notes/drill-mockshots.mjs`; their numbers are illustrative.)

---

## 1. Conclusions

1. **The operator's two blocks come from the same tool.** Both "Top detection rules" and "Severity - count" are `categories` artifacts from the `log_stats` chat tool (`backend/app/agents/chat_tools/logs.py:1315-1326`), one per `group_by` field. The model retitled the first one ("Top rules" is the engine title, `logs.py:78-82`) and asked for the table view. The operator's answer ran on a live model against a real SIEM, so the Demo planner does not reproduce it word for word, but "What are the top detection rules this week?" and "Show alerts by severity for the last 3 days" reproduce both blocks exactly.
2. **Nothing in a categories block is clickable today.** The block schema already carries an optional per-label `drill` list of in-app links (`backend/app/agents/chat_tools/base.py:81`), the horizontal bar chart already navigates on click and on Enter when it is present (`webui/src/soc/chat/blocks/charts/HBarChart.tsx:177-224`), but **no chat tool sets `drill`** and the table view drops it (`backend/app/agents/blocks.py:2560-2579`: only the chart branch copies `drill`). The table renderer has no row action (`webui/src/soc/chat/blocks/renderers/TableView.tsx`, which never passes `onRowClick` to `DataTable`, although `DataTable` supports one at `webui/src/soc/components/DataTable.tsx:140`).
3. **"Severity - count" is confusing for four concrete reasons**, all visible in `drill-severity-viewport.png`: (a) the labels are raw source numbers (`30.0`, `10.0`) with no name, although the Logs page shows the same events as `Medium (30)` (`webui/src/soc/components/UnifiedLogsSheet.tsx:608`, ladder in `webui/src/soc/components/badges.tsx:91-98`); (b) the bars add up to 1,000 while the sentence above says 2,500 events, because a fan-out samples the newest 200 events per source and the caption only says "Sampled from the newest events"; (c) there is no second dimension, so a person cannot tell which rule or source makes up a band; (d) bars cannot be clicked.
4. **The stray tooltip is a native browser `title` tooltip on a full-width heading.** `BlockCard.tsx:824-829` sets `title={shownTitle}` on the block heading unconditionally, and the heading is a block-level `truncate` element, so its hover box spans the whole card width (measured: text 130 px wide, hover box 606 px). Hovering anywhere along the title row pops the browser's own tooltip just under the pointer, which lands on the table header. The fix is small: set `title` only when the text is actually truncated, and shrink the heading's hit box to its text (`w-fit max-w-full`).
5. **Every major SIEM/XDR treats "a rule" as a place you can open**, with a count over time, the alerts table filtered to it, and the rule's own settings next to them (Elastic rule details page, Splunk ES "Top Notable Events" drill to Incident Review scoped to the rule, Sentinel's rule Insights tab, Google SecOps Rules Dashboard to Rule Detections, Datadog's Rules List to its signals). Severity breakdowns are always named levels, and the useful ones add a second dimension (Elastic's Counts and Treemap group by rule then host; Splunk's urgency panel drills to the filtered queue). Sources in section 6.
6. **Recommendation for ask 6: a rule drill-down sheet (option A), reachable from every place a rule name appears**, with "Open all N in Logs" as the primary action into the exact filtered alert list (which is option B, so A contains B). It reuses existing data and routes; the two real backend gaps are an exact `rule` filter on `GET /api/logs` and on the cases list, plus one small read-only summary endpoint.
7. **Recommendation for ask 7: option A (named severities with share, trend and the top rules in each row) as the default rendering of any severity breakdown, with option B's "Split by" control added where the data allows.** Every severity label must use the console's one ladder and keep the raw value in brackets, exactly like the Logs page, and the caption must say "1,000 of 2,500 sampled" when the bars do not cover the total.
8. **The non-negotiables hold.** The drill-down is console UI that reads through the existing read-only routes and the read-only log key (#1); it never sends raw rows to a model (#7); rule names and log values stay untrusted, rendered as plain text and never as links built from text (#9); it has no effect on `decide()` (#3) and makes no model call (#6). "Ask AI about this rule" reuses the existing fenced `rule` entity question (`backend/app/agents/chat_entity.py:63,183`).

---

## 2. What the operator saw, reproduced

### 2.1 "Top detection rules" (ask 6)

- **Producer.** `log_stats` with `group_by: ["rule"]` (`backend/app/agents/chat_tools/logs.py:1047-1074` for the tool, `1208-1400` for the outcome). For each grouped field it emits one `categories` artifact: `labels` (the rule values, untrusted), `values` (counts), `unit: "count"`, `dimension` (the raw field key, so the data-table header reads lower-case `rule`), and `other` (`logs.py:1315-1326`). It is marked `provenance="source"` and `untrusted_labels=True`.
- **Title.** The engine title is "Top rules" (`logs.py:80`); the Demo planner uses "Top rules (this week)" (`backend/app/engine/demo_chat.py:8967`). The operator's "Top detection rules" is the model's own block title (`MaterialiseOptions.title`, `backend/app/agents/blocks.py:2468`).
- **Materialisation.** `_build_categories` (`blocks.py:2537-2581`) turns the artifact into a `table` block (table view) or a `chart` block (hbar, donut). Only the chart branch carries `drill` (`blocks.py:2574-2579`).
- **What each row has.** A rule value and a count, nothing else. The tool also returns, but does not show per row: the over-time series for the first grouped field (`matrix`, used only by the optional heatmap, `logs.py:1362-1374`), the distinct count, per-source coverage and the native query.
- **Click today.** Nothing. In the table view a row is plain text; in the hbar view the bars are inert because `drill` is never set.
- **Rule identity.** The `rule` column mixes rule ids and rule names depending on the source (Demo shows `Entra sign-in`, `LP-QR-0001`, `osquery_process_event`); `rule_name` is a separate field (`logs.py:75-82`, `event_row` at `logs.py:369-381`). A drill-down must key on the exact value the row shows, never on a fuzzy match.

### 2.2 "Severity - count" (ask 7)

The most likely block is the `log_stats` `group_by: ["severity"]` breakdown, shown as a table (SEVERITY / COUNT) in the operator's answer. Engine title "Events by severity" (`logs.py:80`); Demo title "Top severities (last 3 days)". The Demo reproduction (`drill-severity-viewport.png`) shows exactly what makes it useless:

| Problem | Evidence | Cause |
|---|---|---|
| Labels are bare numbers | `30.0` (947), `10.0` (53) | `event_row` keeps the numeric `severity` (`logs.py:379`); the categories label is `visible_text(k)` of that number (`logs.py:1320`). No band mapping is applied, although the same event shows as `Medium (30)` on the Logs page (`UnifiedLogsSheet.tsx:608`, `badges.tsx:91-98`). |
| Bars do not add up to the stated total | Sentence says 2,500 events; bars sum to 1,000 | The fan-out samples the newest 200 events per source (`_STATS_SAMPLE`, `logs.py:105`) when a source cannot aggregate exactly; the caption says "Sampled from the newest events" but not "1,000 of 2,500". |
| No second dimension | One bar per severity value | `log_stats` merges and ranks each field independently (`logs.py:1250-1274`); the only cross-tab is the first field over time (`matrix`). |
| Nothing to act on | No click, no link | Same as 2.1. |

A case-side alternative also exists: `case_stats` "Cases by severity" and `soc_metrics` "Cases by severity" (`backend/app/agents/chat_tools/stats.py:162`, `backend/app/agents/chat_tools/metrics.py:750-752`). Those already use named bands, so they are less confusing, but they share the "no second dimension, no click" problems. Whatever we choose for ask 7 should apply to both.

### 2.3 The stray "Top detection rules" tooltip

- `webui/src/soc/chat/blocks/BlockCard.tsx:824-829`: `<Heading ... className={cn('text-sm font-semibold ...', staticMode ? 'break-words' : 'truncate')} title={staticMode ? undefined : shownTitle}>`.
- The heading is an `h4` inside a `min-w-0 flex-1` wrapper, so it is as wide as the card's title row. Measured live: text 130 px, element 606 px, `title="Top rules (this week)"` (script `scratchpad/r14/notes/drill-pages.mjs`).
- The operator's tooltip is dark with white text, which is the operating system's native tooltip, not the console's Radix `TooltipContent` (that one is `bg-popover`, light in the light theme, `webui/src/ui/tooltip.tsx`). The browser shows it about 20 px under the pointer, on the table header row.
- Fix (for the implementer): render the `title` only when `scrollWidth > clientWidth`, and give the heading `w-fit max-w-full` so its hit box ends at the text. Same pattern should be checked on other `truncate` + `title` headings.

---

## 3. What the product knows about one detection rule

| Fact | Where it lives | Read route (permission) | Notes |
|---|---|---|---|
| Raw alerts with that rule, in a window, per source | Connected log sources | `GET /api/logs` (`sources:read`), `backend/app/api/routes.py:1215` | **Gap:** the route filters only by free text, window and one source. `StructuredQuery` already has an exact `rule` field (`backend/app/connectors/base.py:108-125`) and the connectors compile it for chat's `search_logs`; `browse_query` just never sets it (`backend/app/engine/log_rows.py:148-163`). Adding an additive `rule` (and `severity_gte`) query parameter is small. Push sources' live-tail rings ignore filters (`mode: buffer`), so the route must filter those rows itself, as chat already does (`logs.py:402-419`). |
| Exact alert count, top values, over-time series for a rule | Connector `aggregate()` (Elastic, OpenSearch, Wazuh) | Reached today only through chat's `log_stats` | A small read-only endpoint can call the same `call_aggregate` (`logs.py:984-1002`) with `rule=` and `group_by=[severity, ip, host, user]`. Sources without `aggregate` fall back to the newest-N sample and must say so. |
| Cases created from the rule | `Case.rule_ids` | `/api/cases` (`cases:read`), `routes.py:5701` | **Gap:** no `rule` filter, and the queue search haystack does not include rules (`routes.py:5447-5456`). The exact case aggregation already supports `rule` as a filter and group key (`backend/app/engine/case_aggregate.py:140,159,535,750,1497`), so counts, outcomes and status per rule are cheap and exact. |
| Analyst outcomes and verdict mix for the rule | Cases (`analyst_confirmed_outcome`, verdict) | via `case_aggregate` (`cases:read`) | Gives "1 TP, 0 FP, 2 not graded" honestly; must keep the Round 12 rule that analyst-policy closes are excluded from agent statistics. |
| Rule definition (if it is a suite rule) | `Preferences.rule_catalog` (`RuleDefinition`, `backend/app/config.py:565-594`: name, enabled, description, match, MITRE, schedule, suppression) | `GET /api/rules` (`rules:read`), `backend/app/api/routes_rules.py:186` | Most SIEM alert rule names (for example "Automated Vulnerability Scanning") are **not** suite rules; the sheet must say "Defined in the source SIEM" rather than show an empty editor. |
| Per-rule false-positive tuning state | Tuner stats + ledger | `GET /api/tuning/recommendations` (`automation:read`), `backend/app/api/routes_tuning.py:166` | Wilson lower bound, sample count, proposed change, last tuned. |
| Analyst "declared benign" policies | Analyst policy store | `GET /api/rules/analyst-policies` (`rules:read`), `backend/app/api/routes_analyst_policy.py:184` | Show "A policy closes this rule's matches" when one exists. |
| Precedent per rule | RAG corpus composition | `GET /api/diagnostics/precedent-composition` (`settings:read`), `backend/app/api/routes_diagnostics.py:1901` | Expensive (bounded scan); keep it out of the default sheet, or show it only on demand. |
| MITRE techniques | `RuleDefinition.mitre`, `Case.mitre` | `/api/rules`, case aggregate | |
| Ask AI about the rule | Fenced `rule` entity question | `POST /api/chat/entity-question`, `backend/app/agents/chat_entity.py:63,183` | Already used by the Case Manager facts rail (`webui/src/soc/pages/casedetail/FactsRail.tsx:318-333`) and Logs row details (`UnifiedLogsSheet.tsx:696`). |

**RBAC.** The default matrix gives every built-in role `cases:read`, `sources:read` and read on `rules`, `automation` and `settings` (`backend/app/rbac/policy.py:127-201`, `_settings_like`). Custom roles can lack any of them, so each section of a drill-down must be gated on its own grant with the existing `Can` guard and say "You do not have access to …" instead of failing the whole sheet. The opt-in object-scope hook (`can_object`, shipped off) means case counts must come from the same scoped reads the Cases page uses.

**Where a rule name appears in the console today** (each is a candidate entry point): chat `categories` blocks (table and bars), the chat entity block's "Rules" fact and case list titles, Case Manager's facts rail "Detection rule" badges (`FactsRail.tsx:318-333`), Logs row details (`UnifiedLogsSheet.tsx:696`), the Tuning page rule list (`webui/src/soc/pages/Tuning.tsx`), and "Precedent by rule" in health diagnostics (`webui/src/soc/components/HealthDiagnostics.tsx:364`). Only the Case Manager and Logs entries offer anything today (an Ask AI chip).

**Existing destinations for "all alerts under that rule".** The Logs page with `#/logs?logQuery=<rule>` (screenshot `drill-today-logs-rule-text.png`) is the closest, but it is a free-text match (it also matches messages that merely mention the name), so chat's own "Open in Logs" link is deliberately withheld for rule filters (`LOGS_UNEXPRESSIBLE_FILTERS`, `backend/app/agents/chat_tools/common.py:746`, explained at `common.py:789-818`). The Cases list cannot filter by rule at all.

---

## 4. Industry practice

### 4.1 Drilling from a rule (or a count) into its alerts

| Product | Pattern | Source |
|---|---|---|
| Elastic Security | Clicking a rule name opens the **rule details page**: the rule's settings, a trend histogram, and an alerts table under it showing every alert from that rule (including earlier revisions); a "Stack by" menu splits the histogram by any field. | [Manage detection alerts 8.0](https://www.elastic.co/guide/en/security/8.0/alerts-ui-manage.html), [8.19](https://www.elastic.co/guide/en/security/8.19/alerts-ui-manage.html) |
| Elastic Security | Alerts table "Group alerts by" rule name (up to three nested fields); each group shows its severity and how many users, hosts and alerts it holds; expand a group to see its alerts, or bulk-act on the whole group. | [Manage detection alerts 8.19](https://www.elastic.co/guide/en/security/8.19/alerts-ui-manage.html) |
| Splunk Enterprise Security | Security Posture "Top Notable Events" lists notables **by rule name with a total count and a sparkline**; clicking opens Incident Review **scoped to that rule**. | [Security Posture dashboard](https://help.splunk.com/en/splunk-enterprise-security-7/user-guide/7.3/dashboard-reference/security-posture-dashboard) |
| Splunk dashboards | Table drilldown on a row or a single cell; link to a search, to another dashboard with tokens, or change the current dashboard in place ("contextual drilldown"). | [Use drilldown for dashboard interactivity](https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/simple-xml-dashboards/9.4/drilldown-and-dashboard-interactivity/use-drilldown-for-dashboard-interactivity) |
| Microsoft Sentinel | Analytics rule details pane, **Insights** tab: alert count over time, closing classification of the rule's incidents, failed runs, top health issues; default last 24 hours; each insight has "View all" that opens Logs with the query and raw results. | [Monitor and optimize analytics rule execution](https://learn.microsoft.com/azure/sentinel/monitor-optimize-analytics-rule-execution) |
| Google SecOps | Rules Dashboard: per rule, today's detections, a 4-week activity sparkline, severity, last detection; the row's "View Rule Detections" opens the rule's detections with metadata, a trend graph and event details. | [Understand the Rules dashboard](https://docs.cloud.google.com/chronicle/docs/detection/view-all-rules) |
| Datadog Cloud SIEM | Signals Explorer "Visualize as: Rules List"; click a rule to see its signals; click a signal for a side panel with Logs, Entities, Related signals and Suppressions tabs. | [Investigate security signals](https://docs.datadoghq.com/security/cloud_siem/triage_and_investigate/investigate_security_signals/) |
| Cortex XSIAM, CrowdStrike Falcon, SentinelOne | Product documentation for their alert tables is behind customer logins, so we cannot cite their exact controls. What is public: XSIAM groups related alerts into incidents ([Incidents](https://docs-cortex.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-Administrator-Guide/Incidents)); Falcon detections carry both a numeric severity and a named level ([Sumo Logic integration](https://help.sumologic.com/docs/integrations/security-threat-detection/crowdstrike-falcon-endpoint-protection)). Treat any claim about their grouping UI as unverified. | |

**Common shape:** a rule is a first-class object with its own view; that view always pairs (1) a count over time, (2) the actual alerts, filtered exactly, (3) the rule's definition or health, and (4) a way to act (tune, suppress, open the full search). Navigation to the full alert list is the primary action, not a hidden link.

### 4.2 Making a "count by severity" informative

| Product | Pattern | Source |
|---|---|---|
| Elastic Security | Alerts page "Summary" view: severity levels, alerts by rule name, and top alerts by host or user with percentages; clicking a severity or rule adds a filter to the page. "Counts" groups by rule then by host (a second "Group by top" field). "Treemap" sizes tiles by count and colours them by risk score, grouped by rule then host. | [Visualize detection alerts 8.19](https://www.elastic.co/guide/en/security/8.19/visualize-alerts.html) |
| Splunk ES | "Notable Events by Urgency" drills to Incident Review showing every notable of that urgency in the same window. | [Security Posture dashboard](https://help.splunk.com/en/splunk-enterprise-security-7/user-guide/7.3/dashboard-reference/security-posture-dashboard) |
| Datadog | Facet panel lets you view signals by severity, detection rule and MITRE ATT&CK at once. | [Investigate security signals](https://docs.datadoghq.com/security/cloud_siem/triage_and_investigate/investigate_security_signals/) |
| Design guidance (already adopted in Round 12) | "Every number drills down"; overview, then flag, then detail; avoid stacked graphs where they hide data. | `docs/research/2026-10-round12/research/dashboard-ux.md:17,119,122` |

**Common shape:** severities are always **named** levels in a fixed order; a count alone is never the whole story, so the useful breakdowns add **share** and **a second dimension** (rule first, then host or source), and each level **filters** to its alerts.

---

## 5. Ask 6: what clicking a rule should open

### Option A: rule drill-down sheet, a mini dashboard (mockup `drill-option-6A-rule-sheet.png`)

A right-hand sheet (the console's existing `Sheet`, same entry and exit as the Case detail sheet) titled with the rule value (plain mono text, untrusted). Contents, top to bottom:

1. Header: rule value, window picker (defaults to the window of the answer or page it was opened from), source chip(s).
2. Key figures: Alerts (exact or "at least"), Cases from this rule, Still open, Analyst outcome (TP / FP / not graded), First and last seen.
3. Alerts over time, stacked by named severity (one series, honest buckets; caption states sampled vs exact).
4. Top source IPs and top targets (hosts or users) with counts.
5. Latest 5 alerts (read through the read-only log route, shown as plain text, never sent to a model) and the primary action **Open all N in Logs** (option B's exact view).
6. Linked cases (number, status, verdict), with **Show the N cases** into the Cases list filtered to the rule.
7. Rule facts: "Defined in the source SIEM" or the suite rule's definition and a **Rule settings** link; tuning state; analyst policy; MITRE.
8. **Ask AI about this rule** (the existing fenced `rule` entity question).

Pros: matches what every product in 4.1 does; answers "what is this rule doing, is it real, what do I do" in one place; one component reused from chat, Case Manager, Logs, Tuning and Overview; each section degrades independently by permission and by source capability.
Cons: largest build (one new summary endpoint, two new filters, one new sheet); the sheet must be careful with sampled sources so its figures stay honest; one more surface to keep consistent.

### Option B: open the exact filtered alert list (mockup `drill-option-6B-filtered-logs.png`)

Clicking a rule opens the Logs page (or the existing `UnifiedLogsSheet`) with an exact **Rule = …** filter chip and the answer's window, plus Group by and Export.

Pros: smallest change (an additive `rule` parameter on `GET /api/logs` and on the Logs deep link, `NavOpts`); exactly "all alerts under that rule"; lets chat finally attach "Open in Logs" to rule-filtered answers (drop `rule` from `LOGS_UNEXPRESSIBLE_FILTERS` once the page can express it).
Cons: a raw list, not a dashboard: no cases, no outcome, no trend, no rule definition, so it only half answers "show like a dashboard"; leaving chat for a full page loses the conversation context.

### Option C: expand the row in place (mockup `drill-option-6C-row-expand.png`)

The table row (or bar) expands inside the chat block to show severity mix, top source IPs, linked cases and three buttons: Open N alerts in Logs, Open rule details, Ask AI.

Pros: no context switch; quick to scan several rules; a trend sparkline per row costs nothing extra (the `matrix` already exists for the first grouped field).
Cons: cramped in a 42rem reading column; it only works inside chat blocks, so Case Manager, Logs and Overview still need a destination; the expanded figures must be fetched live by the console, which complicates replay of a stored answer.

### Recommendation

**Option A, with B as its primary action, and C's sparkline column added to the rule table.** That is: every rule value in the console becomes a button that opens the rule sheet; the sheet's main button is the exact filtered Logs view; and the chat's rule table gains a small per-row trend. Option B alone is a reasonable first slice if Round 14 is short of time, because A needs it anyway.

How a chat row becomes clickable without breaking #9:

- The tool, not the model, attaches the link: `log_stats` sets `drill` per label with an `InternalRef` such as `{"page": "logs", "opts": {"rule": <value>, "from": …, "to": …}}` or a new `rule` page ref, validated by `NavRefOpts` (`blocks.py:604-627`) with a new length-limited, single-line `rule` key that reuses `is_safe_log_query`. A rule value that fails validation simply gets no link.
- Carry `drill` into the table view too (`blocks.py:2560-2567`), and give `TableView` a row action when the block has `drill` (keyboard reachable, "Open" announced, the cell text stays plain).
- `provenance="ai"` blocks never get links (`blocks.py:753` already strips `open_in` from them), so a model cannot invent a destination.

## 6. Ask 7: how the severity breakdown should change

Common to every option (this alone fixes most of the confusion):

- **Name the levels.** Map each bucket through the console's one ladder (`badges.tsx:91-98`; backend mirror `_queue_score_band`, `routes.py:5468-5478`) and keep the raw value in brackets: `Medium (30)`, as the Logs page already does. For a fan-out, project each source's values with that source's declared `severity_scale_max` (`backend/app/engine/priority.py:143`, `backend/app/ocsf/model.py:101`) **before** merging, so `30` from a 0-100 source and `3` from a 0-10 source do not land in different bands. Show all five levels in fixed order, zeros included.
- **Say what the bars cover.** Caption "1,000 of 2,500 events sampled (newest 200 per source)" whenever bars and total differ, and add share (%) of the counted events.
- **Make every level clickable** into the same exact filtered list (ask 6 option B, with `severity` added).

### Option A: named levels with share, trend and the top rules in each (mockup `drill-option-7A-named-bands-top-rules.png`)

A table: Severity (badge) | Events | Share | Trend (sparkline) | Top rules (two or three chips with counts, "+N more"). A row expands to list that level's rules, each with "Open in Logs" and "Rule details" (the ask 6 sheet).

Pros: directly answers "at least show the rule"; readable at a glance; works in chat, reports and print; table-first is accessible.
Cons: needs a level by rule cross-tab, which `log_stats` does not compute today (it groups each field on its own); the backend must add a two-level terms aggregation (severity, then rule) for aggregate-capable sources and a sampled cross-tab otherwise.

### Option B: a "Split by" control with stacked bars (mockup `drill-option-7B-split-by-stacked.png`)

Horizontal bars per severity, stacked by the chosen second dimension (None, Rule, Source, Host), with a legend; clicking a segment opens that rule's sheet already filtered to that level.

Pros: the "dropdown" the operator asked for; one control answers many follow-ups without a new question; mirrors Elastic's "Stack by"/"Group by top".
Cons: the client can only switch between splits the server already sent (chat blocks switch views without a model call), so the tool must return all three cross-tabs or the switch must re-query; stacked bars are hard to compare beyond the first segment (Grafana advice, `dashboard-ux.md:119`); weaker for screen readers than a table.

### Option C: rule by severity matrix (mockup `drill-option-7C-rule-severity-matrix.png`)

Rows are the top rules, columns are the five levels, cells are counts with a light tint, plus row and column totals. Every cell opens the alerts for that rule and level.

Pros: the most information per pixel; shows at once which rule drives which level; maps onto the existing `heatmap` block type.
Cons: dense in the 42rem chat column (wide-block mode needed); sparse when one level dominates (as in Demo, where everything is Medium); less approachable for a quick glance.

### Recommendation

**Option A by default, with option B's Split by control as an addition when the server returned more than one split.** A table with named levels, share, a trend and the top rules gives a human a reference at once ("Medium is mostly web_access and Entra sign-in"), and its expandable rows lead straight into the ask 6 rule sheet. Offer C as a view of the same data (the block's view switcher) for people who want the full grid. Apply the same treatment to case-side severity breakdowns (`case_stats`, `soc_metrics`), whose second dimension can be exact through `case_aggregate`'s multi-field grouping.

---

## 7. Guardrails

- **#1 read-only.** Every new read goes through the existing read-only log client and connector `aggregate()`/browse paths; no new write path.
- **#7 aggregate-then-summarise.** The drill-down sheet and expanded rows are console UI only. Raw alert rows are shown to the person through the read-only log route, as the Logs page does today; they are never added to a model prompt or to a chat answer. A chat answer stores only the aggregate block and the link.
- **#9 untrusted values.** Rule names, hosts, IPs and messages are source-controlled: rendered as plain text (mono), never as Markdown or HTML, never turned into a link by the client. Links come only from code (`provenance` `source`/`code`, validated `InternalRef`). "Ask AI" uses the server-worded, fenced `rule` entity question.
- **#3 and #6.** No change to `decide()`, risk scoring or signatures; the sheet makes no model call. "Ask AI" is an ordinary metered chat turn.
- **Honesty.** Sampled sources say "at least" and "sampled"; mixed exact and sampled sources say both; zero buckets are shown, not hidden.
- **RBAC.** Each section checks its own grant (`sources:read`, `cases:read`, `rules:read`, `automation:read`); a missing grant hides the section with a one-line reason.
- **Demo Mode.** The Demo planner (`demo_chat.py`) must emit the same blocks and links so the feature can be shown without a live model; the Demo data adapters already answer `GET /api/logs` with filters applied.

## 8. Suggested work items (for the spec)

| # | Item | Size | Files |
|---|---|---|---|
| 1 | Stray tooltip: `title` only when truncated; heading hit box to text | XS | `webui/src/soc/chat/blocks/BlockCard.tsx:824-829` |
| 2 | Name severity levels in `log_stats` (per-source projection before merge), share, fixed order with zeros, honest sampled caption | S | `backend/app/agents/chat_tools/logs.py`, `blocks.py` caption helpers |
| 3 | Exact `rule` (and `severity_gte`) filter on `GET /api/logs` and the Logs deep link; let chat attach "Open in Logs" to rule-filtered answers | S | `backend/app/api/routes.py:1215`, `backend/app/engine/log_rows.py:148`, `common.py:746`, `webui/src/soc/nav-types.ts`, `webui/src/soc/pages/UnifiedLogs.tsx` |
| 4 | Exact `rule` filter on `GET /api/cases` (via `Case.rule_ids`) and Cases page | S | `routes.py:5701`, Cases and Case Manager queue |
| 5 | Read-only rule summary endpoint (exact counts by level, top IPs/hosts, series, case outcome mix, catalog/tuning/policy flags), each part gated and fail-soft | M | new `backend/app/api/routes_rule_summary.py` (auto-discovered), reusing `call_aggregate` and `case_aggregate` |
| 6 | Rule drill-down sheet and a shared `RuleLink` used by chat blocks, Case Manager facts rail, Logs rows, Tuning and Overview | M | `webui/src/soc/components/RuleSheet.tsx` (lazy), `TableView.tsx`, `HBarChart.tsx`, `FactsRail.tsx`, `UnifiedLogsSheet.tsx` |
| 7 | `drill` for categories in table view; tool-built `drill` refs for rule and severity labels | S | `blocks.py:2537-2581`, `logs.py:1315-1326`, `TableView.tsx` |
| 8 | Severity by rule cross-tab in `log_stats` (two-level terms aggregation, sampled fallback) and the option A table rendering | M | `logs.py`, connector `aggregate` (`backend/app/connectors/elastic.py:1125`), a severity-breakdown renderer |
| 9 | Demo planner parity and golden-set questions for rule clicks and severity breakdowns | S | `backend/app/engine/demo_chat.py`, chat golden tests |

## 9. Open questions for the operator

1. Ask 6: is a **rule sheet (mini dashboard)** what you meant by "like a dashboard", or would the **exact filtered alert list** alone be enough for now?
2. Should the rule sheet open from **everywhere a rule name appears** (chat, Case Manager, Logs, Tuning, Overview), or only from chat answers in this round?
3. Ask 7: do you prefer the **table with top rules per level** (7A), the **Split by dropdown** (7B), or the **matrix** (7C) as the default look?
4. For sources whose severity scale is not 0 to 100 (for example 0 to 10 or 1 to 15), is it acceptable to show the **named level with the raw value in brackets** (`High (8)`), as the Logs page does today?
5. In the operator's live answer, was "Severity - count" the **log events** breakdown or a **cases by severity** breakdown? The fix covers both, but a copy of that answer (or its conversation link) would let us check the exact block.
