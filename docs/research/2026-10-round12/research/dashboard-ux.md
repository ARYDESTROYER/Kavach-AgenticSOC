# SOC command-center dashboard UX: research and redesign brief (Round 12)

Scope: why the Agentic SOC landing dashboard ("Cyber Defence Center", `webui/src/soc/pages/Overview.tsx`) feels "super clamped", and how to declutter it **without removing any data**. The brief draws on how security leaders build their home dashboards, on public design-system and dashboard guidance, and on the Apple design skill (`../apple-design-SKILL.md`). Target stack: React + Tailwind 3.4 + Radix (shadcn primitives). The constraints in `docs/development/ui-standard.md` still apply.

Evidence quality: vendor UI layouts are only partly documented in public docs. Claims marked **[doc]** are quoted or paraphrased from official documentation at the cited URL. Claims marked **[inferred]** are reasonable readings of screenshots or marketing copy and should be treated as such.

---

## 0. TL;DR: ten decisions for the redesign

1. **Keep the hierarchy and add air.** Every leader uses the same order: a KPI band first, then the "how work flowed" instruments, then the queue or lists, then deeper analytics. Ours already follows that order. The cramped feel comes from **zero gutters, 12px cell padding, 11–12px type and one continuous hairline lattice**, not from having too much data.
2. **Name the bands.** Use 3–5 titled sections in sentence case (`text-sm font-semibold` + muted caption, with a right-aligned "View all →" link), as in Sentinel's Overview (Incidents / Automation / Data / Analytics) and Splunk's Executive summary (Key metrics / Findings / Risk / Additional). Today rows 1–2 of the lattice have no section title, so the eye cannot chunk them.
3. **Use one card grammar.** Make each independent instrument a flat surface (`bg-card border border-border/60 rounded-xl`, no resting shadow). Put a **16px gutter (`gap-4`)** between surfaces, rising to **24px (`2xl:gap-6`)**. Do not nest a `Card` inside a `DashboardGroup` inside a band. "Deeper analytics" does exactly that today, which breaks ui-standard's no-nested-cards rule.
4. **Increase padding at wide widths.** Use `p-4` (16px) at `xl` and `p-5`/`p-6` at `2xl` and above. Keep the 608px container minimum for the noise-flow cell; at 1280 with the sidebar pinned that cell has about 629px of content today, so recompute before changing any padding (§7).
5. **Strengthen the type ladder, not the colour.** KPI numerals go from 30px to 36px at `2xl` (`tabular-nums`, `tracking-[-0.02em]`, `leading-none`). Labels move from 11px (`text-2xs`) to 13px medium. Captions are 12px muted. Weight carries emphasis (Apple §15; Carbon "highest contrast + largest area" for the most important item).
6. **Equal heights per row, with capped lists.** Use `items-stretch` and `h-full`. Lists show N rows plus "View all" rather than growing; PatternFly suggests about 4 items, Elastic shows the top 4 with a "View …" link.
7. **Every number drills down.** Clicking a number should open a filtered list or a side sheet (XSIAM, Splunk, Elastic, Qualys all do this). We already do; keep it, and add visible "View all →" section links (Sentinel's "Manage incidents", Elastic's "View alerts").
8. **Charts: position and length beat angle and area.** Prefer bars and columns. Keep donuts only for small (≤4-segment) part-to-whole figures with direct labels, and use one colour per series across the whole page (NN/g, Carbon, Datadog).
9. **Wide screens: add columns, do not stretch rows.** Add `3xl:1920px` and `4xl:2560px` screens. At 2560 either cap the canvas (about 2200–2400px) or adopt Datadog's "high density mode": two halves side by side, with Deeper analytics as a right-hand column.
10. **Apple restraint.** Make the control band (time range, refresh) a sticky translucent "dashbar" with a scroll-edge fade instead of a hard rule. Use critically damped motion (count-ups, section reveal). Anchor drill-down sheets to their source tile. Honour reduced motion, reduced transparency and high contrast.

---

## 1. Vendor teardown

### 1.1 Palo Alto Networks: Cortex XSIAM Command Center
Sources: [XSIAM Command Center (doc .md)](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference/xsiam-command-center.md), [Command Center reference](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference.md), [Cases Overview](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference/xsiam-command-center/cases-overview.md), [Dashboards and reports](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/onboard-cortex-xsiam/post-deployment/dashboards-and-reports.md), [Product tour](https://www.paloaltonetworks.com/resources/infographics/xsiam-product-tour)

- **Hierarchy [doc].** Three sections tell one story. **Incoming data** lists connected endpoints and data-source instances "ordered by ingestion volume", with errored integrations in red. **Cases and issues** shows issues opened, then cases created from them, split *manual vs automated* ("automated cases include at least one playbook"), then open and resolved cases by severity. **KPIs** cover data and events ingested plus ingestion rate, *currently* open cases by severity ("not limited to the time frame"), and attacks prevented.
- **Visual flow [inferred from the tour and docs].** The page reads left to right as *sources → alerts/issues → cases → resolved*. This is the same lifecycle our Noise-Reduction flow encodes. The product tour says you "start your day" here, then check "how many incidents XSIAM resolved automatically", then go to incidents needing attention.
- **KPI anatomy [doc].** Value, then a trend percentage versus the previous time frame, then an up/down arrow. Clicking a KPI opens a dedicated investigation page.
- **Window-exempt stock is labelled [doc].** "Open cases" covers all current cases, not the selected window. This matches our "Open Cases is a window-exempt stock" rule, so the precedent is good.
- **Drill-down [doc].** Data Inventory, Dynamic View (a live activity feed behind a concentric-circle icon), Cases Overview, and the Agentic Assistant. A **"Start Investigation"** button opens the AI assistant with suggested prompts; this is the precedent for our "Ask about this".
- **Second-level page [doc].** Cases Overview has four sections: automation suggestions ("cases that could have been automated"), resolved cases plus top resolving assignees, open cases by severity plus MITRE tactics, and KPIs (data ingested, assets affected, trend arrows).
- **Chrome [doc].** The Command Center dashboards are dark-mode only and not editable. A fixed, curated landing view is separate from a customizable widget library.
- **Takeaway.** The landing view is curated and fixed, three titled sections tell the flow story, every number drills down, and there is an AI entry point on the KPIs.

### 1.2 Google Security Operations (SecOps SIEM + SOAR)
Sources: [SOAR dashboards overview](https://docs.cloud.google.com/chronicle/docs/soar/monitor-and-report/soar-dashboards/dashboard-overview), [Add SOAR dashboard widgets](https://docs.cloud.google.com/chronicle/docs/soar/monitor-and-report/soar-dashboards/add-dashboard-widgets), [Native dashboards overview](https://docs.cloud.google.com/chronicle/docs/reports/native-dashboards2?hl=en), [Manage native dashboards](https://docs.cloud.google.com/chronicle/docs/reports/manage-native-dashboards), [Navigate the SOAR platform](https://docs.cloud.google.com/chronicle/docs/soar/overview-and-introduction/navigating-the-soar-platform)

- **Predefined dashboards [doc].** "SOC Status" is an "overview of the SOC's current state, highlighting important metrics for cases, alerts, incidents, and analyst activities". There is also a Playbooks dashboard. A separate **Your Workdesk** holds the analyst's own tasks, so the personal work queue is a different surface from the SOC posture view.
- **Restraint by rule [doc].** "A dashboard can hold up to 12 widgets." Each widget has a required title and a selectable **widget width**. Display forms are pie (default), horizontal bar, vertical bar, or table. Time and environment are inherited from the dashboard. Data auto-refreshes every 5 minutes.
- **Alert Reduction widget [doc].** The formula is `1 − (Cases / Alerts) × 100%`. This is the canonical single-number expression of our Noise-Reduction flow; consider surfacing it as the flow's headline number (computed only when both counts are in the same window and measured).
- **Curated vs custom [doc].** Curated dashboards cannot be edited but can be duplicated. The dashboard list supports sort, search, pin and filter.
- **Takeaway.** A hard cap on widget count, a title on every widget, a small set of widths, and inherited time scope. The personal work queue lives apart from posture.

### 1.3 Microsoft: Sentinel Overview, Defender XDR home, SOC efficiency workbook
Sources: [Sentinel Overview dashboard](https://learn.microsoft.com/en-us/azure/sentinel/get-visibility), [Manage SOC with incident metrics](https://learn.microsoft.com/en-us/azure/sentinel/manage-soc-with-incident-metrics), [Defender portal (Learn module)](https://learn.microsoft.com/en-gb/training/modules/describe-threat-protection-with-microsoft-365-defender/7-describe-microsoft-defender-portal), [SC-900 lab: explore the Defender portal](https://microsoftlearning.github.io/SC-900-Microsoft-Security-Compliance-and-Identity-Fundamentals/Instructions/Labs/LAB_09_explore_m365_defender_portal.html), [Defender Experts home card](https://learn.microsoft.com/en-us/defender-xdr/start-using-mdex-xdr), [Unified SecOps overview](https://learn.microsoft.com/unified-secops-platform/overview-unified-security)

- **Sentinel Overview: four titled sections in a fixed order [doc].**
  - **Incidents:** new/active/closed in 24h; totals by severity; closed by closing classification; status by creation time in **4-hour intervals**; **mean time to acknowledge** and **mean time to close**, linking to the SOC efficiency workbook; and a "Manage incidents" link.
  - **Automation:** incidents closed by automation; **time saved** = `(avgWithout − avgWith) × resolvedByAutomation`; playbook health; actions by type; active rule count; and a "configure automation rules" link.
  - **Data:** records in 24h versus the previous 24h, with anomalies; connector health split into unhealthy and active; TI records by indicator type; "Manage connectors".
  - **Analytics:** rules by status (enabled, disabled, auto-disabled); "MITRE view" and "manage analytics rules" links.
  - **Per-section freshness [doc].** "The last refresh time is shown at the top of each section", plus one page-level Refresh. We show one global refresh; per-section "updated Xs ago" would be more honest because our slices load independently.
- **Defender XDR home [doc].** Card-based. Card composition **depends on the user's role**. "+ Add cards" lists absent cards, a card's ellipsis menu removes it, and cards are **dragged by their title bars**. A status card sits "in the top row immediately after the home page banner". The unified home shows incident totals across Sentinel and XDR, connector status, and top risky entities.
- **SOC efficiency workbook [doc].** Incidents over time; incidents by closing classification, severity, owner and status; MTT-triage; MTT-closure; **p5/p50/p90/p99 percentiles** of triage and closure; MTT-triage per owner; recent activity and closing classifications.
- **Takeaway.** Every section has its own title, its own freshness stamp and its own "manage/view" exit. Timing is reported as means plus percentiles. "Time saved" is the automation value metric, but it is formula-based and only honest when both averages are measured.

### 1.4 Splunk Enterprise Security 8: Mission Control, Security posture, Executive summary
Sources: [Mission Control overview (8.6)](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.6/mission-control), [Executive summary dashboard (8.6)](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.6/analytics/executive-summary-dashboard), [Security posture dashboard (8.4)](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.4/analytics/security-posture-dashboard), [Add key indicators](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.4/dashboards/add-key-indicators-in-splunk-enterprise-security), [Dashboard Studio: absolute vs grid](https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.2/create-a-dashboard-in-dashboard-studio/create-a-dashboard-in-dashboard-studio/compare-absolute-and-grid-layouts)

- **Mission Control [doc].** The work surface is an **analyst queue** (findings, finding groups, investigations; default last 24h, newest first). **Charts and a timeline are optional toggles above the queue** behind icons: four pie charts (Urgency, Status, Owner, Domain) and a zoomable timeline. Selecting a finding's name opens a side panel to assign, change status, or start an investigation.
  - Lesson: the analytics are *collapsible over the queue*, never in place of it. Manual refresh plus an admin-controlled auto-refresh.
- **Security posture [doc].** Built for a SOC wall display. A row of **key indicators** (counts per domain over 24h), then findings by urgency, then findings over time by domain, then top findings by rule and by source. **Clicking a value opens the Mission Control queue filtered to that slice** (for example, that urgency in the last 24h).
- **Executive summary [doc].** Four titled sections:
  - **Key metrics:** mean time to triage, mean time to resolution, investigations created. Each has a trendline "in absolute value" against the previous same-length period.
  - **Findings:** urgency distribution timechart, findings by domain, untriaged by domain, top-10 untriaged sources, untriaged by type, frequent and rare sources.
  - **Risk:** three panels.
  - **Additional metrics:** three panels.
  - A KPI the viewer's role cannot read shows an error message rather than a fake value.
- **Grid [doc].** Dashboard Studio's grid layout sizes "panels in a row to equal proportions" and scales with browser width.
- **Takeaway.** Three KPIs and no more at the top. Deltas are absolute against the previous period. Lists are top-10 with sections titled by question. Every value filters the queue.

### 1.5 Qualys: VMDR / TruRisk / Unified Dashboard
Sources: [Qualys Insights](https://docs.qualys.com/en/vm/latest/mergedProjects/analyze_reports_and_dashboards/assets/qualys_insights.htm), [TruRisk Score widget (search result)](https://docs.qualys.com/en/vmdr/latest/threat/risk_score_widget.htm), [Implement RBVM with TruRisk, part 2](https://blog.qualys.com/vulnerabilities-threat-research/2022/12/16/implement-risk-based-vulnerability-management-with-qualys-trurisk-part-2), [mROC 2.0 release notes](https://docs.qualys.com/en/mssp/release-notes/mroc/release_2_0.htm)

- **Count widgets with compact numbers [doc].** Examples: "TruRisk ≥ 700", "Not scanned 30 days", "CISA KEV", "Ransomware vulns". Totals are abbreviated with a K suffix ("1.94K", "17.7K"). KEV shows "detections in KEV **out of** total detections", which is a numerator with its denominator, the same as our context line.
- **Drill-down into the query [doc].** Clicking a widget writes a QQL query into the search bar, which the user can refine (`AND operating.system:Windows`). Both totals update. The number is a doorway into the filtered population.
- **TruRisk widget [doc, search summary].** A score meter (asset or vulnerability query) with optional contributing factors; display settings let you pick the meter colour.
- **Blog guidance [doc, 2022–23].** A unified dashboard built from TruRisk widgets, table widgets grouped by tags, and Venn-style "high value ∩ high risk" comparisons.
- **mROC 2.0 [doc].** A Home page with a "Risk Overview" tab that consolidates critical insights in one place (TruRisk score, asset counts, critical vulns).
- **Takeaway.** Compact count tiles that each name their population and denominator. Click-to-query. Tabs ("Risk Overview") are used to split the home into views rather than one long scroll.

### 1.6 Elastic Security: Overview, Detection & Response, Value report
Sources: [Overview dashboard](https://www.elastic.co/docs/solutions/security/dashboards/overview-dashboard), [Detection & Response dashboard](https://www.elastic.co/docs/solutions/security/dashboards/detection-response-dashboard), [EASE value report](https://www.elastic.co/docs/solutions/security/ai/ease/ease-value-report), [Entity analytics dashboard](https://elastic.co/guide/en/serverless/current/security-detection-entity-dashboard.html)

- **Detection & Response [doc].** Six sections in order: **Alerts** (total, by status and severity, "View alerts"), **Cases** (total by status, "View cases"), **Open alerts by rule** (**top 4**, "View all open alerts"), **Recently created cases** (**4 most recent**, "View recent cases"), **Hosts by alert severity** (≤100), **Users by alert severity** (≤100).
  - The date picker sits top-right and scopes the whole page.
  - Hovering a count reveals an **"Investigate in timeline"** icon. Clicking a rule, case, host or user opens its detail page.
- **Overview [doc].** Live feed (recent cases, favourited timelines, news); histograms with **"Stack by"** and click-drag time selection; host/network events grouped by source and expandable; threat-intel totals. Every chart has a hover **Inspect** / options menu (view query, add to case, open in Lens).
- **Value report (AI SOC) [doc].** "Analyst time saved", "Cost savings", and alerts the AI "Escalated" vs "Filtered". A summary message at the top explains how the figures were determined. Time selector and "Export report" (PDF) top-right.
- **Takeaway.** Short lists capped at 4 with "View …" exits. An inspect/provenance affordance on every chart. A plain-language explanation of how each AI value metric was computed.

### 1.7 CrowdStrike Falcon (Insight / Next-Gen SIEM)
Sources: [Customized dashboards (tech hub)](https://www.crowdstrike.com/tech-hub/endpoint-security/customized-dashboards/), [Foundry dashboards](https://developer.crowdstrike.com/foundry/experience-capabilities/dashboards/), [Next-Gen SIEM security monitoring](https://www.crowdstrike.com/en-us/platform/next-gen-siem/security-monitoring/)

- **Role-based dashboards [doc].** Separate SOC-analyst, IT-admin and vuln-analyst dashboards are built from widget categories. The SOC-analyst example uses New detections, Prevented malware by host, Detections by tactic, and an objectives-over-time line. Widgets can be moved and **resized "to show more information"**.
- **Dashboard-level filters [doc].** Severity and time filters apply across single-source dashboards; per-widget filters apply on multi-source ones.
- **Drill-down [doc].** Clicking a donut slice opens that item, and "Group by hosts" pivots the list.
- **Chart vocabulary [doc/marketing].** Charts, lists, maps, **sankey diagrams**; prebuilt dashboards for data-collection health, SOAR executions and security trends. Foundry widgets: table, bar, line, pie, counter, world map.
- **Takeaway.** Role-tailored views, resizable widgets, global filters, and flow (sankey) diagrams accepted for ingestion and triage flow.

### 1.8 AI-SOC peers (closest to our product)
Sources: [Dropzone: why Dropzone](https://dropzone.ai/why-dropzone), [Prophet Security](https://www.prophetsecurity.ai), [Prophet case study](https://www.prophetsecurity.ai/case-studies/zip-boosting-soc-throughput-with-prophet-ai)

- **[marketing].** Dashboards lead with response clocks (time to detect, acknowledge, investigate, remediate), lifetime investigations, **time saved**, FP rate, and alert volume with "decreased/saved" deltas. ROI views show hours saved. Prophet: dwell time, mean time to investigate, mean time to resolve.
- **Takeaway.** Our KPI set (cases, critical, open, FP rate, resolved, auto-closed, MTTD/respond, MTTA/MTTR/dwell, noise reduction, human-vs-AI) matches the category. The missing *headline* is an honest automation-value number. It is optional and must follow our honesty rules (em dash when unmeasured).

---

## 2. Design-system and dashboard-craft guidance (vendor-neutral)

| Source | Concrete rule we should adopt |
|---|---|
| [PatternFly dashboard guidelines](https://www.patternfly.org/patterns/dashboard/design-guidelines) | Each card holds "a single metric or a group of closely related metrics". Use equal-width columns with equal gutters; the example is **4 columns, 16px gutters, 16px margins**, filling 1200–1400px, and 3–4 columns are most common. Most important at the top. **Match card shape to content** (lists tall, line graphs wide). **Avoid a dynamic card pushing a neighbour and leaving gaps**: match heights or fix the height and scroll. **Event lists: about 4 items, then scroll.** Aggregate-status cards show only non-zero exceptions. A "dashbar" (a small top dashboard of critical state) is a recognised pattern. Card chrome: drop-shadow on grey backgrounds, **flat 1px-border cards on white** ([card guidelines](https://www.patternfly.org/components/card/design-guidelines)). |
| [Carbon: dashboards](https://carbondesignsystem.com/data-visualization/dashboards) | "Prioritize data by importance… the most important data should have the highest contrast and occupy the largest area." Follow an **F-pattern**: key content at the top, least important last. Strip distractions. **Consistent colour per data set** across the dashboard. White space separates and groups, with a cited claim of "almost 20%" better comprehension. Exploration charts: "same layout and spacing… legends in the same position". |
| [Carbon 2x grid](https://carbondesignsystem.com/elements/2x-grid/overview/) | Breakpoints: sm 320 (4 col), md 672 (8), lg 1056 (16), **xlg 1312 (16)**, **max 1584 (16, 24px margin)**. Each grid box has 16px padding, so the effective gutter is 32px. Gutters are optional for tightly related content. |
| [Grafana best practices](https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/build-dashboards/best-practices.md) | "Dashboards should reduce cognitive load, not add to it." Order "large to small or general to specific" and let **row order follow data flow**. Colour has fixed meaning. **Avoid stacked graphs in most cases** (they hide data). Use hierarchical drill-downs to the next level, and add panel descriptions. |
| [Datadog integration-dashboard guide](https://docs.datadoghq.com/extend/integrations/create-an-integration-dashboard/) + [Datadog dashboards blog](https://datadoghq.com/blog/datadog-dashboards) | **Overview group at the top.** Use titled groups, not free text, and order groups macro → micro or upstream → downstream. Timeseries at least 4 of 12 columns wide ("so they don't look squashed"), streams at least 6. Query-value tiles carry a timeseries background so they don't look blank. **Test at 1280 and 2560** (also 1440, 1680, 1920). **High density mode** on large monitors places the top and bottom halves side by side; keep the halves symmetrical. Sentence-case widget titles that don't repeat the group name. Colour "to highlight important relationships… not for style". Align x-axes for side-by-side charts. |
| [NN/g: dashboards and preattentive processing](https://www.nngroup.com/articles/dashboards-preattentive/) | Operational dashboards are for time-sensitive action. Encode quantities with **length and 2D position**; bars should be sorted. **Avoid pie/donut "most of the time"**; gauges "take up a lot of space and are harder to interpret". Colour is not magnitude; use colour to flag outliers. Pair colour with shape or labels for colour-blind users (about 4.5%). |
| Stephen Few, *Information Dashboard Design* ([Why most dashboards fail (PDF)](https://blogs.ischool.berkeley.edu/i247s13/files/2013/02/WhyMostDashboardsFail.pdf), [UXmatters review](https://uxmatters.com/mt/archives/2007/04/book-review-information-dashboard-design.php)) | A dashboard is a "single-screen display of the most important information people need to do a job". The sequence is overview, then flag what needs attention, then drill down. Failure modes include **inadequate context, excessive detail/precision, useless clutter, and misused colour**. Prefer sparklines and bullet graphs for compact comparison. |
| Apple design skill (`../apple-design-SKILL.md`) | §16 **Simplicity is not minimalism**: "use hierarchy (order, spacing, contrast) so the most important thing is the most obvious"; "show the common path first, advanced options one level deeper"; every element earns its place. §16 **Grouping and mapping**: proximity implies relationship; put a control near what it affects. §16 **Wayfinding**: where am I, where can I go. §15 typography: size-specific tracking (negative on large numerals), inverse leading, weight+size+leading as one set, rem spacing. §12 materials: translucent floating chrome, **scroll-edge fades instead of hard dividers**, never stack light translucent surfaces, bigger surfaces read thicker. §1/§4/§7 motion: respond on pointer-down, critically damped springs (`bounce: 0, duration ≈ 0.3–0.4`), sheets originate from the trigger. §14: reduced motion → cross-fade; reduced transparency → solid; more contrast → defined borders. |

---

## 3. Synthesis: patterns by question asked

### 3.1 Information hierarchy: what goes top-left
- **Universal order:** (a) a time scope and refresh control band; (b) **one row of 3–6 headline KPIs**; (c) a **flow/lifecycle** instrument (sources → alerts → cases → outcome) or a severity/urgency breakdown; (d) **the work queue** (top 4–10 recent or highest-risk) with "View all"; (e) timing/efficiency (MTTA/MTTR, percentiles); (f) composition lists (top rules, sources, entities, MITRE); (g) health of the pipeline (connectors, ingestion).
- **Top-left is the most consequential count.** XSIAM puts open cases by severity in its KPIs. Sentinel's first section is Incidents. Splunk's Executive summary leads with mean time to triage, and its posture view leads with key indicators. Elastic D&R leads with Alerts. For us, **Total cases (or open critical)** belongs top-left. The KPI strip already does this; keep it.
- **Wall vs desk.** Several vendors split the SOC-manager view (Splunk Executive, Sentinel workbook, XSIAM Command Center) from the analyst view (Mission Control queue, Google Workdesk). Ours is a hybrid: posture plus a live queue. That is acceptable, but the **queue must not be squeezed into a third of a row**; give it a full-height column or a wider cell (§6).

### 3.2 KPI tile anatomy (consensus, mapped to our `KpiTile`)
```
┌──────────────────────────────────────────┐
│ Label (13px, medium, muted)       (?)  ↗ │  ← help + drill marks on hover/focus (ours already)
│ 1,284                                     │  ← numeral 30–36px, tabular-nums, tracking −0.02em, leading-none
│ 17% of 47 cases                           │  ← ONE context line: numerator-of-denominator (Qualys KEV, ours)
│ ▲ +8 vs prev 24h                          │  ← delta chip: absolute for small bases (Splunk "absolute value")
└──────────────────────────────────────────┘    whole tile = button → drill-down (XSIAM/Splunk/Qualys)
```
- Optional: a timeseries backdrop or sparkline (Datadog advises against blank query-value tiles; PatternFly "trend" card). **Our rule** (ui-standard): no in-tile sparkline unless the series counts the same population, so keep the hover trend. A visible "trend available" mark is fine.
- Window-exempt stocks are labelled as such (XSIAM's open cases; ours "Open Cases").
- Unreadable or unauthorized values show a state line, never 0 (Splunk shows an error message; ours uses an em dash with a reason).

### 3.3 Density vs whitespace
- Vendors are **dense inside a widget and generous between widgets**. Grafana, Datadog, PatternFly and Carbon all space panels with 16–32px gutters. Carbon cites white space for comprehension and grouping.
- **Our page inverts this.** Cells touch each other (hairline lattice, `gap-0`) and the insides use 12px padding and 11–12px text. Same pixels, opposite effect: everything reads as one undifferentiated slab. Hence "clamped".

### 3.4 Grid and breakpoints for wide screens
- PatternFly: 4 equal columns at 1200–1400. Carbon: 16 columns at ≥1056, with "max" at 1584. Datadog: 12-column groups, tested at 1280/1440/1680/1920/2560, with two-column high-density mode on large monitors. Splunk grid: equal-proportion panels in a row.
- **Principle:** above about 1600–1700px of content width, **add a column (or a side-by-side half) rather than stretching existing cells**. Stretched donuts and 3-row lists in 900px-wide cells create visual emptiness *and* make the page feel crammed vertically.
- Our Tailwind has **no screens above `2xl` (1536px)**, and Overview uses `PageContainer variant="fluid"` (`max-w-none`). At 2560 the 12-column lattice simply stretches.

### 3.5 Card chrome: borders vs elevation
- Leaders use **flat, bordered tiles on a slightly contrasting canvas** in dark themes (XSIAM is dark-only; Sentinel/Defender use cards with subtle borders). Shadows are reserved for floating layers (menus, sheets), which matches our `--elev-*` tokens and ui-standard ("heavy resting shadows" banned).
- PatternFly: shadow cards on a grey page, flat 1px-border cards on white. Apple §12: material weight encodes hierarchy; never stack light-on-light translucency.
- **Recommendation:** one chrome for every independent instrument: `rounded-xl border border-border/60 bg-card` on a `bg-background` canvas, with `gap-4` between them. Use hairlines only *inside* a card (dividing stats within it). No `Card` inside a `DashboardGroup` inside a band.

### 3.6 Progressive disclosure
- **Click a number → filtered list** (XSIAM → Cases Overview; Splunk → Mission Control filtered; Elastic → Alerts page; Qualys → QQL).
- **Side panel for a record** (Splunk finding side panel; ours `CaseDetail` sheet).
- **Collapsible analytics over the queue** (Splunk Mission Control chart/timeline toggles; Datadog collapsible stream groups; Grafana collapsed rows; our "Deeper analytics" group).
- **Tabs to split views** (Qualys mROC Home / Risk Overview; our Analytics page). Inspect/provenance per chart (Elastic Inspect).
- Section-level exits: "Manage incidents" (Sentinel), "View alerts" (Elastic), "View all open alerts".

### 3.7 How they avoid "clamped" without deleting data
1. **Titled sections** (Sentinel 4, Splunk Exec 4, XSIAM 3, Elastic D&R 6, Datadog groups) so the eye can chunk.
2. **Gutters between surfaces** (16–32px), with dense content only inside.
3. **Caps on list length** (top 4 / top 10) plus "View all".
4. **Equal row heights**: match neighbours or fix the height and scroll (PatternFly).
5. **Collapsible secondary sections** (Grafana rows, Datadog stream groups, Splunk chart toggles), sometimes **remembered per user** (Defender's per-user card layout).
6. **Fewer chart types, one per question**; bars over pies.
7. **More columns on wide screens** (Datadog high density).
8. **Typographic hierarchy**: big numerals, quiet labels, sentence-case titles.
9. **Per-section freshness and actions in the section header**, not floating below content.
10. **Role-based composition** (Defender cards by role, CrowdStrike role dashboards), or user hide/reorder.

### 3.8 Chart conventions
- Time on x, left to right; bucket width disclosed ("4-hour intervals" in Sentinel; ours "1h buckets"); previous-period comparison as an absolute delta.
- Severity colours are fixed across all charts. Severity order runs Critical → Info (Splunk urgency order: Critical, High, Medium, Low, Info, Unknown).
- Bars sorted descending for top-N. Stacked only when parts must sum to a whole (Grafana warns against stacking otherwise). Our Human-vs-AI stacked columns are a legitimate part-to-whole that sums to 100%.
- Flow/sankey is accepted for ingest → triage (CrowdStrike sankey, XSIAM flow story, Google Alert Reduction).
- Donut: avoid most of the time (NN/g). Where kept, use ≤4 segments, direct labels, the total in the centre, and a legend in the same position on every donut (Carbon).
- Every chart: a title, a unit, and an accessible table equivalent (ours: visually hidden tables in places).

---

## 4. Current Agentic SOC Overview: complete data inventory (must all survive)

File: `webui/src/soc/pages/Overview.tsx` (3,545 LOC). Helpers: `KpiTile`, `KpiDrilldownPanel`, `MetricHoverTrend`, `NoiseFunnel` (2,585 LOC), `HumanVsAiCard`, `DashboardGroup`, `BarList`, `charts.tsx` (`DonutChart`, `TrendArea`). Data calls: `usePosture(hours,'prev')` (authoritative lifecycle rollup), `listCases` (current and previous window), `getMetrics` (timing_trend, by_status), `usageSummary`, `noiseReduction`, `metricsTrends`, `sourcesCoverage`, fetched with `allSettled` and stale-while-revalidate.

**A. Masthead** (`PageHeader` title "Cyber Defence Center", `data-testid="page-hero"`)
- `TimeRangePicker` (window), auto-refresh interval select (LIVE etc.), manual refresh pulse. These sit in the `meta` slot beside the title; the right half of the header is deliberately empty.
- `AutomationNudge` (conditional onboarding card).
- `LoadError` banner and `EmptyState` "No triage activity yet" (Connect a source / Start demo).

**B. KPI strip** (`data-testid="kpi-strip"`; 6 cells; `grid-cols-1 sm:2 md:3 xl:6`; `density="compact"`, `numeral="hero"`; hand-tuned nth-child hairlines)
1. **Total Cases**: window cohort (it is the denominator itself).
2. **Total Critical**: share of the cohort, red only when non-zero, no hover trend.
3. **Open Cases**: window-exempt stock, no hover trend.
4. **False Positive Rate**: share of verdicted cases.
5. **Resolved / Closed**: share of the cohort; the drill-down carries the close-attribution partition.
6. **Auto Closed**: AI auto-closes as a share.
- Each tile has a context line, sub/bound state, help (?), "Ask about this" topic, delta, a hover trend card (`MetricHoverTrend`) where an honest series exists, and a **drill-down modal** (`KpiDrilldownPanel`: population, filters, sorting, own time range, metric switcher, full-list deep link).

**C. Lattice row 1** (`data-testid="hero-row"`, `xl:grid-cols-12`)
- **Noise reduction flow** (8 columns; needs ≥608px container): Alerts ingested → After clustering → Cases opened → {Auto-cleared by AI, Closed by analyst policy, Escalated → {Closed by human, Not analyst-closed}}. Also: the Open-cases side action (queue depth, partial/lower bound), the Awaiting review / Candidate side cohort, Simple/Detailed modes, full-screen, per-user hide toggle, stage click → Cases filter, coverage/truncation disclosures, an unavailable state with Retry.
- **Human vs AI close attribution** (4 columns): agent-closed / analyst-closed / system residual counts with reconciling %; stacked columns per arrival bucket (hatched when not measured); an alerts-ingested tally; stale/truncated/unavailable states; help.

**D. Lattice row 2** (`xl:grid-cols-12`, 4 + 4 + 4)
- **Resolved and open cases** (4): `SnapshotCard` "Open cases" (total, delta, severity donut with legend, hover trend "New cases opened", CTA "View open cases") stacked over "Cases resolved" (total, delta, severity donut, hover trend "Cases now closed", CTA "View resolved cases").
- **MTTD / response** (4): MTTD p50 (detect: log arrival → case; daily-mean hover trend) and Respond p50 (first human action; hover trend), with a "Detail →" link to Metrics/Posture.
- **Latest cases** (4): `TopCasesPanel`, a real-time triage queue (title, id, age, status chip; hover card; opens `CaseDetail` sheet in place; "View all").

**E. Deeper analytics** (`DashboardGroup`, collapsed by default, `mt-4`)
- Timing tiles: **MTTA**, **MTTR**, **Dwell** (p50; MTTA/MTTR hover trends; Dwell has none) plus **LLM spend** (cost, tokens, calls; retry if unavailable; links to Metrics/Cost; spend hover trend).
- **Ingest coverage** (`CoverageTile`): Events/min, Triaged 24h, Silent sources, silent-source alarm or an all-clear with the oldest last event.
- **Case volume** (`TrendArea`, cases opened over time) and **Case workload state** (per-status progress bars → Cases filter).
- **Case outcomes** (verdict donut: True positive / Needs human / False positive / Unverdicted, with legend and %), **Top signatures** (`BarList`, rank and %), **Top entities** (`BarList`, rank and %).

**F. Overlays**: `CaseDetail` sheet (opened from the queue or a drill-down); the KPI drill-down dialog; hover-trend cards.

**Data not on this page that peers lead with** (candidates, not removals): per-section freshness stamps (Sentinel); MTTA/MTTR **p90** alongside p50 (Sentinel workbook percentiles; the posture API already returns p50/p90 per AGENTS.md); an "Alert reduction %" headline (Google formula; derivable from the noise payload); "time saved by automation" (Sentinel/Elastic/Dropzone, only if measured honestly); MITRE tactic mix on open cases (XSIAM Cases Overview; a MITRE corpus exists elsewhere in the app); connector health counts on the landing page (XSIAM incoming data, Sentinel Data). All are optional additions; none is required to fix the cramped feel.

---

## 5. Diagnosis: why it reads as "super clamped"

Evidence from code; widths are derived from class tokens.

1. **Zero gutters.** The strip and lattice are one bordered slab (`border-y`, internal `border-r/b border-border/70`, no `gap`). The code comments explain this was deliberate ("the strip's bottom rule IS the lattice's top edge"). Visually it removes every grouping cue. Proximity (Apple §16, Carbon) cannot work when everything is equidistant.
2. **Tight insets.** Cells use `px-3 py-3` (12px); the KPI strip is `px-3 py-2` (compact); `TopCasesPanel` is `p-3`. These were chosen to protect the flow's 608px minimum at 1280. The same 12px insets are applied at 1920 and 2560, where there is ample room.
3. **Small type.** Section captions are `text-xs`, strip labels `text-2xs` (11px), and metadata is mono 11–12px. Hero numerals are 30px. Labels and captions at 11–12px on a dense lattice read as fine print.
4. **Untitled bands.** Rows 1 and 2 have per-cell `h2`s but no band-level titles. The page jumps from the KPI strip straight into five instruments.
5. **Mixed chrome.** The lattice is hairline-flat, while Deeper analytics is `DashboardGroup` → `Card` → `CardContent` (bordered cards, nested inside a collapsible section). Two visual grammars on one page; ui-standard discourages nested cards.
6. **Six-number strip at `xl`** (1280–1535). At about 982px of content, each KPI cell is roughly 160px wide, so numerals, context lines and deltas crowd. Splunk caps its key metrics at 3; XSIAM's KPI section is about 4.
7. **Four-column cells holding two donuts plus a legend each** (the snapshot cell) and a 2-row timing stack. These are short, wide-content items forced into narrow columns; PatternFly says to match card shape to content.
8. **No wide-screen behaviour.** There is no `3xl`/`4xl` screen and the page is `max-w-none`. At 2560 the instruments stretch (donuts stay small in wide cells, lists get long empty rows), and the eye travels too far between related numbers.
9. **Hidden half.** Deeper analytics is collapsed by default, so the visible half is compressed and the rest is an unlabelled fold. This is fine as disclosure (Splunk/Grafana do it), but it needs a summary of what is inside, and a remembered open/closed state per user.
10. **Many donuts.** There are three donuts (open severity, resolved severity, verdict mix). NN/g advises avoiding donuts most of the time; bars read faster and pack better in short rows.

---

## 6. Recommended redesign (no data removed)

### 6.1 Section model (titled bands, top to bottom)
Each band is a `<section aria-labelledby>` with a header row: **title** (`text-sm font-semibold`, sentence case), a **muted caption**, then on the right **freshness** ("Updated 12s ago") and a **"View all →"** link where one exists.

| # | Band title (proposal) | Contents (all existing) | Peer precedent |
|---|---|---|---|
| 0 | *(sticky dashbar, no title)* | Time range, auto-refresh, refresh, last-updated | PatternFly dashbar; Elastic top-right picker; Apple §12 floating toolbar |
| 1 | **Right now** | KPI strip (6 tiles) | XSIAM KPIs; Splunk key metrics; Sentinel Incidents counts |
| 2 | **How alerts became outcomes** | Noise-reduction flow (8) · Human vs AI (4) | XSIAM flow story; Google Alert Reduction; Sentinel Automation |
| 3 | **Queue and response** | Latest cases (taller; about 8 rows) · Open/resolved snapshots · MTTD/Respond | Splunk Mission Control queue; Elastic "Recently created cases"; Sentinel MTTA/MTTC |
| 4 | **Efficiency and cost** | MTTA · MTTR · Dwell · LLM spend · Ingest coverage | Sentinel workbook; XSIAM KPIs; Sentinel Data |
| 5 | **What's driving volume** | Case volume trend · Workload state · Case outcomes · Top signatures · Top entities | Splunk Findings section; Elastic open alerts by rule; Sentinel Analytics |

Bands 4–5 are today's "Deeper analytics". Two options keep the progressive disclosure:
- **Option A (recommended):** render bands 4–5 open, each as its own collapsible `DashboardGroup`, and **persist the open/closed state per user** (`UserPrefsStore`, or a try/catch `localStorage` fallback). Defender and Grafana both remember the user's layout. The collapsed state shows an inline summary such as "MTTA 14m · MTTR 2h · $3.12 spend · 1 silent source", so nothing is hidden behind an unlabelled fold.
- **Option B:** a `SegmentedControl` / Radix `Tabs` under the KPI strip: **Overview | Efficiency | Volume** (Qualys mROC "Home / Risk Overview" precedent). Panels stay mounted (`forceMount` + `hidden`) so nothing refetches.

### 6.2 Surfaces, gutters and padding (Tailwind recipes)
```tsx
// canvas
<PageContainer variant="fluid" className="w-auto space-y-6 sm:-mx-2 3xl:max-w-[2400px] 3xl:mx-auto">
// band
<section aria-labelledby="band-flow" className="space-y-3">
  <header className="flex items-end justify-between gap-3">
    <div><h2 id="band-flow" className="text-sm font-semibold tracking-[-0.005em]">How alerts became outcomes</h2>
         <p className="text-xs text-muted-foreground">Selected window · p50 · server-computed</p></div>
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="tabular-nums">Updated 12s ago</span>
      <a className="font-medium text-primary hover:underline">View all →</a></div>
  </header>
  <div className="grid gap-4 2xl:gap-6 xl:grid-cols-12">
    <article className="rounded-xl border border-border/60 bg-card p-4 2xl:p-5 xl:col-span-8">…</article>
    <article className="rounded-xl border border-border/60 bg-card p-4 2xl:p-5 xl:col-span-4">…</article>
  </div>
</section>
```
- **Surfaces:** `rounded-xl` (`--radius-xl` 14px) or `rounded-lg` (10px); `border-border/60`; `bg-card` on `bg-background`. No resting shadow. Use the hover lift only on clickable tiles; `.hover-lift` already exists and is gated.
- **Inside a surface:** keep the hairline dividers between sub-stats (`divide-y divide-border/60`).
- **Equal heights:** `items-stretch` on the grid and `h-full flex flex-col` on the surface. Lists use `max-h-[…] overflow-auto` with a fade mask at the bottom (Apple scroll-edge) instead of growing the row.
- **KPI strip:** either keep the continuous strip (ui-standard demands one strip with hairlines) and wrap it in **one surface** (`rounded-xl border bg-card overflow-hidden`), padding each tile `px-4 py-3 2xl:px-5 2xl:py-4`, or move to `density="default"` at `2xl` (`2xl:min-h-24`). The nth-child divider classes stay as they are because the cell count is unchanged. **Tests assert `px-3 py-2`** in `overview.render.test.tsx:388`; update the tokens deliberately (the test says to update, never delete).
- **The flow cell's 608px minimum.** Moving from `px-3` + hairline to `p-4` + border + gap changes the arithmetic. At 1280 with the sidebar pinned: content ≈ 1280 − 10 (scrollbar) − 240 (rail) − 48 (inset) + 16 (reclaim) = **998px**; with a 16px gap the 8-of-12 span is (998 − 16) × 8/12 ≈ 655, minus 32 (p-4) minus 2 (border) ≈ **621px**, which still clears 608 by about 13px. Keep `p-4` at `xl` and **do not use `p-5` until `2xl`**. Alternatively, at `xl` only, use `xl:col-span-8` → `xl:col-span-9` with Human-vs-AI at 3 (riskier for that card), or let row 2 drop to `2xl:` and stack at `xl` (flow full width, Human vs AI below).

### 6.3 Breakpoints (add to `tailwind.config` `theme.extend.screens`)
```js
screens: { '3xl': '1920px', '4xl': '2560px' }   // keep Tailwind defaults below
```
Approximate content widths (fluid page, sidebar pinned 240 / collapsed 64, 10px scrollbar, 48px inset, +16 reclaim):

| Viewport | Pinned | Collapsed | Layout |
|---|---|---|---|
| 1280 (`xl`) | ~998 | ~1174 | 12-col; strip 6 across; flow 8 / H-vs-AI 4; row 3 = queue 5 + snapshot 4 + timing 3 (or stack) |
| 1440 | ~1158 | ~1334 | as above; `gap-4`, `p-4` |
| 1536 (`2xl`) | ~1254 | ~1430 | `gap-6`, `p-5`, numerals 36px, KPI `density="default"` |
| 1920 (`3xl`) | ~1638 | ~1814 | Bands 4–5 go side by side (Efficiency 5 · Volume 7); the queue shows 10 rows |
| 2560 (`4xl`) | ~2278 | ~2454 | **High-density two-column page**: left 7/12 = bands 1–3, right 5/12 = bands 4–5 (Datadog), or cap at `max-w-[2400px]` and centre |

### 6.4 Type ladder (Apple §15 + Carbon contrast)
| Role | Now | Proposed |
|---|---|---|
| KPI numeral | 30px (`text-4xl` compact hero) | 30px at `xl`, **36px at `2xl`** (`2xl:text-[2.25rem]`), `tracking-[-0.02em] leading-none tabular-nums font-semibold` |
| KPI label | 11px `text-2xs` | **13px** `text-[13px] font-medium text-muted-foreground`, near-zero tracking (no uppercase) |
| Context line | 11–12px | 12px `text-xs text-muted-foreground tabular-nums` |
| Band title | n/a | 14px `text-sm font-semibold` (sentence case) |
| Instrument title | 14px | 14px semibold, with 12px caption |
| Instrument big numbers (snapshots, timing) | 24–30px | 28–32px at `2xl` |
| Metadata (ids, ages) | 11–12px mono | 12px; mono only for ids |

Do not add colour for emphasis. Numerals stay neutral ink (ui-standard); only non-zero Critical is red.

### 6.5 Charts
- **Snapshot severity donuts → horizontal stacked severity bar plus a legend row** (length encoding, about 30% less height, consistent with NN/g). Alternatively keep the donut (operator-provided prototype) but enlarge it to 112–128px at `2xl` and put the legend to its right. The severity colour order is fixed across all charts.
- **Verdict donut:** keep it (4 segments, centre total, direct %), but align its legend position with the snapshot legend (Carbon: legend in the same place everywhere).
- **Case volume:** use columns per bucket instead of a smoothed area, matching the hover-trend rule (one column per bucket; unmeasured buckets shown as gaps).
- **Top signatures / entities:** keep `BarList` (sorted bars are best practice). Cap at 5 with "View all".
- **Human vs AI:** a legitimate stacked part-to-whole; keep it.
- **Every chart:** title, unit, window disclosure, and a hidden data table (already partly present).

### 6.6 Drill-down and wayfinding
- Keep: tile → modal (`KpiDrilldownPanel`), row → `CaseDetail` sheet, stage → Cases filter.
- Add: band-header "View all →" (Cases, Metrics/Posture, Sources, Metrics/Cost), per-band "Updated Xs ago", and a *Start investigation / Ask about this* action on the dashbar (XSIAM "Start Investigation" → assistant with suggested prompts; our `AskAboutThis` exists).
- Apple §7: the drill-down dialog should scale and fade from the source tile (`transform-origin` at the tile rect; Radix `Dialog` + motion `layoutId` or a CSS origin). Use critically damped `bounce: 0, duration: 0.3`; under reduced motion, cross-fade only.

### 6.7 Motion and material (Apple skill)
- **Sticky dashbar:** `sticky top-0 z-20 bg-background/70 backdrop-blur-md supports-[backdrop-filter]:bg-background/60`, with a 12px gradient mask under it *only while scrolled* (scroll-edge effect) instead of `border-b`. Under `prefers-reduced-transparency`, use solid `bg-background`; under `prefers-contrast: more`, add `border-b border-border`.
- **Count-ups:** keep `CountUp` springs critically damped (no overshoot) and skip them on refresh, animating only on the first load or a window change, so "LIVE" refreshes don't jitter numerals.
- **Band reveal:** the existing `Reveal`/`Stagger` is fine, but keep the stagger under about 40ms per item and the total under 300ms. Never animate layout on auto-refresh.
- **Press feedback:** tiles get `active:scale-[0.99]` with a 100ms ease-out (Apple §1), gated by `motion-safe:`.

---

## 7. Constraints and regression risks to carry into the spec
- **ui-standard "Operational metric surfaces":** the KPI strip must stay one continuous strip with exact per-breakpoint hairline rules for **six** cells. Wrapping it in one surface is allowed; splitting it into six cards is not.
- **ui-standard "Operational flow visualizations":** Simple/Detailed modes, the 608px container gate, conserved shares and disclosures are all load-bearing. Change only the container chrome and padding, and recompute §6.2.
- **Tests encode layout tokens.** `overview.render.test.tsx` checks strip `grid-cols-*`, nth-child classes, compact `px-3 py-2`, `min-h-0`, the snapshot ring `w-28` and `text-3xl leading-none`, `page-hero` not `bg-card`, and the controls' classes. `overview.commandcenter.test.tsx` checks the noise rail classes and tiles `bg-transparent`. Update these intentionally; do not delete them.
- **`page-hero` must not become a card** (test line 251). The dashbar can be a sticky wrapper *around* `PageHeader`'s meta controls, or a separate `ControlBar` (ui-standard: optional controls occupy one compact `ControlBar` band).
- **Boot guard:** the page title string is anchored by the smoke test; do not rename "Cyber Defence Center".
- **No new npm dependencies.** `motion` is already lazily available; Radix Tabs/Collapsible already exist.
- **Honesty contracts:** any new headline (Alert reduction %, time saved, p90) must follow the em-dash-with-reason rule and use one payload per numerator/denominator pair.
- **#3/#7/#9:** presentation-only; nothing feeds `decide()`; render all values as plain text.

---

## 8. Source list
- Palo Alto: [XSIAM Command Center](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference/xsiam-command-center.md) · [Command Center reference](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference.md) · [Cases Overview](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference/xsiam-command-center/cases-overview.md) · [Dashboards and reports](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/onboard-cortex-xsiam/post-deployment/dashboards-and-reports.md) · [XSIAM product tour](https://www.paloaltonetworks.com/resources/infographics/xsiam-product-tour)
- Google: [SOAR dashboards overview](https://docs.cloud.google.com/chronicle/docs/soar/monitor-and-report/soar-dashboards/dashboard-overview) · [Add SOAR widgets](https://docs.cloud.google.com/chronicle/docs/soar/monitor-and-report/soar-dashboards/add-dashboard-widgets) · [Native dashboards](https://docs.cloud.google.com/chronicle/docs/reports/native-dashboards2?hl=en) · [Manage dashboards](https://docs.cloud.google.com/chronicle/docs/reports/manage-native-dashboards) · [Navigate SOAR](https://docs.cloud.google.com/chronicle/docs/soar/overview-and-introduction/navigating-the-soar-platform)
- Microsoft: [Sentinel Overview](https://learn.microsoft.com/en-us/azure/sentinel/get-visibility) · [Incident metrics / SOC efficiency workbook](https://learn.microsoft.com/en-us/azure/sentinel/manage-soc-with-incident-metrics) · [Defender portal module](https://learn.microsoft.com/en-gb/training/modules/describe-threat-protection-with-microsoft-365-defender/7-describe-microsoft-defender-portal) · [SC-900 lab](https://microsoftlearning.github.io/SC-900-Microsoft-Security-Compliance-and-Identity-Fundamentals/Instructions/Labs/LAB_09_explore_m365_defender_portal.html) · [Defender Experts home card](https://learn.microsoft.com/en-us/defender-xdr/start-using-mdex-xdr) · [Unified SecOps](https://learn.microsoft.com/unified-secops-platform/overview-unified-security)
- Splunk: [Mission Control](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.6/mission-control) · [Executive summary](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.6/analytics/executive-summary-dashboard) · [Security posture](https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.4/analytics/security-posture-dashboard) · [Key indicators](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.4/dashboards/add-key-indicators-in-splunk-enterprise-security) · [Absolute vs grid](https://help.splunk.com/en/splunk-enterprise/create-dashboards-and-reports/dashboard-studio/10.2/create-a-dashboard-in-dashboard-studio/create-a-dashboard-in-dashboard-studio/compare-absolute-and-grid-layouts)
- Qualys: [Qualys Insights](https://docs.qualys.com/en/vm/latest/mergedProjects/analyze_reports_and_dashboards/assets/qualys_insights.htm) · [TruRisk widget](https://docs.qualys.com/en/vmdr/latest/threat/risk_score_widget.htm) · [TruRisk RBVM blog](https://blog.qualys.com/vulnerabilities-threat-research/2022/12/16/implement-risk-based-vulnerability-management-with-qualys-trurisk-part-2) · [mROC 2.0](https://docs.qualys.com/en/mssp/release-notes/mroc/release_2_0.htm)
- Elastic: [Overview](https://www.elastic.co/docs/solutions/security/dashboards/overview-dashboard) · [Detection & Response](https://www.elastic.co/docs/solutions/security/dashboards/detection-response-dashboard) · [Value report](https://www.elastic.co/docs/solutions/security/ai/ease/ease-value-report)
- CrowdStrike: [Customized dashboards](https://www.crowdstrike.com/tech-hub/endpoint-security/customized-dashboards/) · [Foundry dashboards](https://developer.crowdstrike.com/foundry/experience-capabilities/dashboards/) · [NG-SIEM monitoring](https://www.crowdstrike.com/en-us/platform/next-gen-siem/security-monitoring/)
- AI SOC: [Dropzone](https://dropzone.ai/why-dropzone) · [Prophet](https://www.prophetsecurity.ai)
- Craft: [PatternFly dashboard](https://www.patternfly.org/patterns/dashboard/design-guidelines) · [PatternFly card](https://www.patternfly.org/components/card/design-guidelines) · [Carbon dashboards](https://carbondesignsystem.com/data-visualization/dashboards) · [Carbon 2x grid](https://carbondesignsystem.com/elements/2x-grid/overview/) · [Grafana best practices](https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/build-dashboards/best-practices.md) · [Datadog dashboard guide](https://docs.datadoghq.com/extend/integrations/create-an-integration-dashboard/) · [Datadog dashboards blog](https://datadoghq.com/blog/datadog-dashboards) · [NN/g preattentive dashboards](https://www.nngroup.com/articles/dashboards-preattentive/) · [Few: why most dashboards fail](https://blogs.ischool.berkeley.edu/i247s13/files/2013/02/WhyMostDashboardsFail.pdf) · Apple design skill (`../apple-design-SKILL.md`)
