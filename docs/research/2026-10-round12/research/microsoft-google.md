# Competitor research: Microsoft Security Copilot and Google Security Operations (Gemini)

Research date: 2026-10-10. Scope: SOC assistant / chat and agent capabilities that matter for the
Agentic SOC chat (read-only, RBAC-scoped ReAct assistant with streamed answers, interactive blocks,
per-user history, reports library, token meter).

Method: primary vendor documentation (learn.microsoft.com, docs.cloud.google.com) read directly,
2026 revisions where available (most Microsoft pages carry `ms.date` 2026-05..2026-07, `updated_at`
2026-06..2026-09). Vendor blogs and trade press are used only for announcement and status, and
are labelled **[claim]** when they carry marketing numbers. "Documented" means the behavior is
described step by step in product docs.

---

## Part A. Microsoft Security Copilot

### A1. Surfaces

| Surface | What it is | Source |
|---|---|---|
| Standalone portal (`securitycopilot.microsoft.com`) | Full chat sessions, promptbooks, agents library, history, sharing, owner settings | [Navigate](https://learn.microsoft.com/en-us/copilot/security/navigating-security-copilot) |
| Embedded "sidecar" panes | Copilot pane inside Defender, Sentinel (via Defender), Entra, Intune, Purview, Defender for Cloud, Azure Firewall, Defender TI | [Experiences](https://learn.microsoft.com/en-us/copilot/security/experiences-security-copilot) |
| Defender Chat experience (preview) | Open-prompt chat panel from a **Copilot** button in the Defender top bar, page-context aware | [Copilot in Defender](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender) |
| Agents | Autonomous / scheduled agents (Phishing/Alert Triage, Threat Intelligence Briefing, Security Analyst, Threat Hunting Assistant, Conditional Access Optimization, Vulnerability Remediation, Purview triage) | [Agents overview](https://learn.microsoft.com/en-us/copilot/security/agents-overview) |

Landing page now has two variants: **agents-first** (Agents library is the home; general chat is
reached via *All history > New session*) and **chat-first** (prompt bar on home). Home menu: Home,
Agents, Promptbooks, Build (custom agents), All history, Owner (owner settings, plugin settings,
role assignment, usage monitoring), Settings (theme, time zone, language), Tenant switching.
([Navigate](https://learn.microsoft.com/en-us/copilot/security/navigating-security-copilot))

Embedded sessions are not islands: "When you interact with an embedded Copilot experience to
produce results, the session will appear in your session list" (same page). The sidecar can be
hidden with X; the preference "persists per Copilot embedded experience" and hiding it does not
stop background generation (e.g., incident summary still generates).
([Experiences](https://learn.microsoft.com/en-us/copilot/security/experiences-security-copilot))

### A2. Standalone chat session mechanics (documented)

- **Prompt bar** with a **Prompts** (sparkle) button that opens a searchable library of prompts and
  promptbooks, filterable by **Role** (CISO, SOC analyst, TI analyst, IT admin) and **Plugin**;
  "See all system capabilities" lists every plugin skill as a directly invocable prompt. Prompts
  that need input (incident ID, app name) show an input form before send.
  ([Prompting](https://learn.microsoft.com/en-us/copilot/security/prompting-security-copilot))
- **Sources** button in the prompt bar: toggle plugins on/off and attach uploaded files per session.
- **Process log**: appears directly under the prompt while the answer forms; shows which plugin and
  capability was selected, "actions taken, sources used, and processing time". "You can cancel,
  edit, or delete your prompt during response generation." ([Prompting](https://learn.microsoft.com/en-us/copilot/security/prompting-security-copilot))
- **Grounding links**: "Many responses include direct links to data provided by the Microsoft
  service plugin" (e.g., a Sentinel incident link). ([Navigate](https://learn.microsoft.com/en-us/copilot/security/navigating-security-copilot))
- **Pin board** (side panel): pin prompt/response pairs; on first pin Copilot "generates a summary
  of the session for the pin board"; pinned items show condensed, expandable responses; the board
  shows **tags** under the session name; order is pin order, not session order.
- **Share**: Share icon creates a link (copy, or email except in SouthAfricaNorth/UAENorth). The
  link covers the **entire** session, including prompts added after sharing. Recipients must be in
  the same tenant with Copilot access; shared sessions are **read-only** and show a **static
  display regardless of whether the viewer has access to the underlying data** (explicit warning).
  Forwarding the link does not grant access; only the creator controls access. While viewing a
  shared session there is an **Export** option; the viewer sees the session summary and pinned
  items first. ([Navigate](https://learn.microsoft.com/en-us/copilot/security/navigating-security-copilot),
  [Authentication: Shared sessions](https://learn.microsoft.com/en-us/copilot/security/authentication#shared-sessions))
  - Export formats are not enumerated on Learn; a third-party post states PDF or Word (unverified).
- **Feedback** under each response: "How's this response?" with **Looks right / Needs improvement /
  Inappropriate**, each followed by a free-text dialog.
  ([Sentinel + Copilot](https://learn.microsoft.com/en-us/azure/sentinel/sentinel-security-copilot))
- **File upload** as a session source: DOCX/MD/PDF/TXT, **3 MB per file, 20 MB total**, private to
  the uploader, stored in tenant home geo, toggled on per session; owners can disable uploads. Not
  for malware detonation. ([Upload a file](https://learn.microsoft.com/en-us/copilot/security/upload-file))
- **Prompt tips** Microsoft documents: be unambiguous, one question at a time, use follow-ups, name
  the audience ("Write an executive report ... for a nontechnical audience"), use "me" ("incidents
  assigned to me"), and once a single incident is in context, pronouns like "that incident" work.
  ([Sentinel + Copilot](https://learn.microsoft.com/en-us/azure/sentinel/sentinel-security-copilot))

### A3. Promptbooks (documented)

- A promptbook is a sequence of prompts where "each prompt build[s] on the previous one"; the final
  prompt typically produces an **executive report**. Prebuilt: *Check impact of an external threat
  article* (URL in, indicators + KQL out), *Microsoft Sentinel / Defender XDR incident
  investigation* (incident ID in, executive report out), *Microsoft User analysis* (UPN + time
  range), *Suspicious script analysis* (paste SNIPPET), *Threat actor profile*, *Threat
  Intelligence 360 report based on MDTI article*, *Vulnerability impact assessment* (CVE).
  A round progress indicator replaces the response while running.
  ([Use promptbooks](https://learn.microsoft.com/en-us/copilot/security/using-promptbooks))
- **Build from a session**: tick checkboxes next to prompts in a session > **Create promptbook** >
  name, tags, description; edit and reorder prompts; replace literals with `<Parameter>` inputs
  (angle brackets, no spaces; shown under "Inputs you'll need"); per-step **Continue on failure**;
  call a system capability directly in a step (preview); visibility **Just me** or **Anyone in my
  organization**; library actions View, Run, Duplicate, Edit, Share, Delete. Library columns: name,
  owner, description, number of prompts, required plugins, visibility. "You can cancel
  long-running promptbooks." "Results may vary depending on the permissions and data available to
  the user running the promptbook."
  ([Build promptbooks](https://learn.microsoft.com/en-us/copilot/security/build-promptbooks),
  [Prompting](https://learn.microsoft.com/en-us/copilot/security/prompting-security-copilot))

### A4. Plugins and permissions

- Plugin = collection of tools ("skills"); Microsoft plugins use **on-behalf-of** auth, so
  "Security Copilot doesn't go beyond the access you have". Non-Microsoft plugins, public web, and
  custom plugins (OpenAI-schema API, KQL, GPT; MCP for agents) are supported.
  ([Plugins](https://learn.microsoft.com/en-us/copilot/security/plugin-overview),
  [Authentication](https://learn.microsoft.com/en-us/copilot/security/authentication))
- Roles: **Copilot owner** / **Copilot contributor**, separate from data roles; contributor can
  create sessions, run/share promptbooks, upload files; owner manages plugins, capacity, usage
  dashboard, data sharing. ([Authentication](https://learn.microsoft.com/en-us/copilot/security/authentication))

### A5. Embedded Defender capabilities (documented)

| Capability | Invocation | Output UI | Limits / notes |
|---|---|---|---|
| **Incident summary** | Auto on opening an incident (configurable: Always / by minimum severity / On demand, with a per-severity SCU estimate) | Card in Copilot pane: attack start time and entity, timeline narrative, assets, IoCs, threat actors, **See prompts** (suggested follow-ups); evidence entities are clickable to file/IP/URL pages; **Cancel**, **Regenerate**, Copy, **Open in Security Copilot** | **Up to 100 alerts** per incident summary; cached **one week** and redisplayed "at no cost" if the incident didn't change significantly. [Incident summary](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-incident-summary) |
| **Guided responses** | Auto on incident page | Cards grouped Triage (classify TP/FP/informational), Containment, Investigation, Remediation; each card names the entity, the reason, and a one-click action button; filter by status; **View similar incidents**, **View similar emails** (opens a generated hunting query), **Contact user in Teams / Copy to clipboard** suggested message; cards flag when automation (attack disruption, AIR) already did it | "Grayed out action buttons mean these actions are limited by your permission." Org guidance can be uploaded to shape recommendations. [Guided response](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-guided-response) |
| **Script / command-line analysis** | **Analyze** on an event in the attack story or device timeline | Copilot pane card: explanation, **Show code / Hide code**, **Show MITRE techniques**; Copy, Regenerate, Open in Security Copilot | [Script analysis](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-script-analysis) |
| **File analysis**, **device summary**, **identity summary**, **email summary** | Summarize buttons on entity pages / Copilot pane | Summary cards (file: detections, certificates, API calls, strings; device: posture, unusual behavior, vulnerable software, Intune; identity: role changes, sign-in behavior, devices; email: overview, event timeline, indicators) | Multiple entity summaries can run **in parallel**; results cached unless regenerated; closing a summary panel stops it. [Copilot in Defender](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender) |
| **Incident report** | Incident **More actions > Generate incident report**, or report icon in pane | Card: creation/closure timestamps, first/last logs (analyst vs automated), analysts involved, classification + summarized reason, investigation/remediation actions, follow-ups from comments; actions **Copy to clipboard**, **Post to activity log**, **Export incident as PDF** (attack story, impacted assets, alerts, AI summary + report), **Regenerate**, **Open in Security Copilot** | Resolve the incident first for completeness; live response commands and API/custom-detection actions not yet included. [Incident report](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-create-incident-report) |
| **Copilot tab** on incident | Tab on incident page | One chat-like panel with **Summarize / Recommendations / Report**; incident chats persist when switching incidents so you can compare summaries | [Copilot in Defender](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender) |

### A6. Hunting: NL to KQL, Threat Hunting Assistant, Security Analyst Agent

- **Query assistant (Query-only mode)**: side pane in Advanced hunting; NL in, KQL out using the
  hunting schema; **Stop generating**; **See the logic behind the query** (expandable
  explanation); split button **Run query** (inserted as the last query and run) / **Add to editor**;
  feedback Looks right / Needs improvement / Inappropriate.
  ([Query assistant](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-security-copilot-query-assistant))
- **Threat Hunting Assistant (Rich insights mode, default; prerelease)**: "natural language question
  to natural language answer"; conversational context across the session; **schema-aware
  discovery** (lists tables you can access, inspects schemas, joins multiple tables, includes custom
  Sentinel tables); **iterative refinement** visible in the pane; KQL "generated and run
  automatically" with results in the normal results grid; **Observations** = data highlights plus an
  auto-chosen **chart (pie, timeline, vertical bar)** whose type and grouping the user can change;
  **contextual insights**; **smart follow-up question chips** (click runs them) and **action
  suggestions** that open the **Take actions** wizard pre-filled (only on the last response);
  everything lands in the normal hunting UI so the user can save the query, export results, or
  create a detection rule. "It runs read-only queries and can't run commands that change data or
  configuration." Discovery "follows your own permissions". **New chat (+)** deletes history
  ("isn't saved"). Mode switch clears the conversation after confirmation.
  ([Threat Hunting Assistant](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-security-copilot-threat-hunting-assistant),
  [Copilot in advanced hunting](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-security-copilot))
- **Security Analyst Agent (prerelease)**: chat-first, "python-powered advanced analysis" (pattern,
  trend, time series, anomaly detection, clustering, ranking, risk scoring, forecasting) over
  Defender XDR, Sentinel Log Analytics, or Sentinel data lake (and CSV uploads in standalone);
  asks **clarifying questions** when the task is broad; "can take a few minutes" for complex
  analyses; **Analyze with Copilot** button under any KQL result grid hands the results to the
  agent. Output is a **report**: Executive summary (how the analysis was done, filters, time ranges,
  ranking), Key insights (each with why-it-matters and evidence refs), Visualizations (only when
  they add value), **Artifacts** (CSV of all analyzed entities, evidence files, the KQL used, the
  full plan), plus suggested next prompts; new chat, **historical chats**, settings.
  ([Security Analyst Agent](https://learn.microsoft.com/en-us/defender-xdr/security-analyst-agent))

### A7. Defender Chat experience (preview) – closest analogue to our Workspace chat

From [Copilot in Defender, Defender Chat tab](https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender):

- Opened from the **Copilot** button in the top nav; panel slides in on the right "and stays in
  context while you continue working"; closing preserves the conversation.
- **Page context awareness**: "Which users are involved in *this* incident?" resolves from the page.
- **Interactive follow-ups** ("Tell me more about the first one").
- **Step-by-step plans**: for complex requests it "might first present a proposed plan" that the
  user can **Approve or Reject**; after approval it executes and "shows its progress in real time".
- **Clarifying questions** with **up to four quick-select options**.
- **Conversation history** panel (resume, new, delete, clear all) – but "the last ten conversations
  are stored locally in your browser" and are not synced across devices.
- **Working with responses**: structured tables / bullets / headers; **Copy**, **Export** any table
  **to Excel**, **Stop**, **Retry**.

### A8. Agents (autonomous)

- **Phishing Triage Agent / Security Alert Triage Agent** (Defender; expanding to identity and cloud
  alerts in preview). Trigger: user-reported phish creates an alert. Tools: email content analysis,
  file/URL detonation, screenshot analysis, TI, advanced hunting. Verdict: FP alerts are classified
  and **resolved by the agent**; TP stays open for an analyst. Transparency: the agent assigns the
  alert to itself and tags the incident **Agent**; a card in the incident's Copilot/Tasks panel
  shows verdict + key evidence; **View agent activity** and **See full agent workflow** show a
  graphical decision map. **Feedback as memory**: *Change classification* > "Why did you change
  this" > optional **Use this feedback to teach the agent** > **Evaluate feedback** previews the
  translated "lesson" and checks conflicts > Save; feedback management page lists statuses In use
  / Not in use / Conflict, author, IDs; only a Security Administrator can reject a lesson. Runs as an
  **Entra Agent ID** (recommended) with least-privilege roles; Pause/Run; Performance tab shows
  daily activity, **mean time to triage**, **SCU consumption**; usage dashboard shows **cost per
  email processed**; activity recorded in Purview audit. Prereqs include Defender for Office 365 P2.
  ([Phishing Triage Agent](https://learn.microsoft.com/en-us/defender-xdr/phishing-triage-agent))
  **[claim]** "Each alert may require up to 30 minutes of manual triage" (vendor FAQ framing).
- **Threat Intelligence Briefing Agent**: scheduled (default every 7 days) or **Run agent** on
  demand; parameters Insights count, look-back days, region, industry, recipient email; banner on
  Threat analytics; **View full brief** side panel with threat summary and technical analysis;
  **download as Markdown** or copy; runs saved under **Activity** with an **activity map** of steps;
  thumbs feedback "to the agent to help it learn what you prefer, or to Microsoft".
  ([TI Briefing Agent](https://learn.microsoft.com/en-us/defender-xdr/threat-intel-briefing-agent-defender))
- Others listed by Microsoft: Conditional Access Optimization (Entra), Vulnerability Remediation
  (Intune), Purview DLP / Insider Risk alert triage, Dynamic Threat Detection (trade press
  **[claim]** ">85% accuracy", unverified). Custom agents: no-code **agent builder** (describe in
  natural language) and MCP-IDE building via the **Sentinel MCP server** (preview, Sept 2025).
  ([Agents overview](https://learn.microsoft.com/en-us/copilot/security/agents-overview),
  [MCP get started](https://learn.microsoft.com/en-us/copilot/security/developer/mcp-get-started),
  [The Hacker News, Sept 2025](https://thehackernews.com/2025/09/microsoft-expands-sentinel-into-agentic.html))

### A9. Metering and limits

- Billing is **capacity**, not per-message caps: Security Compute Units, provisioned at **$4 per
  SCU-hour**, overage up to a configurable limit (third parties cite $6/SCU-hour).
  ([Pricing page](https://www.microsoft.com/security/pricing/microsoft-security-copilot/))
- Microsoft 365 E5 inclusion (announced Ignite 2025): **400 SCUs/month per 1,000 licences, capped at
  10,000/month**; phased tenant rollout 2026-04-20 to 2026-06-30 per message center MC1261596.
  ([MC1261596](https://mc.merill.net/message/MC1261596))
- Owners get a **usage monitoring dashboard** (SCU consumption over time, per agent, exportable to
  Excel). Features surface cost before spending (incident-summary settings show an SCU estimate
  per severity choice).
- No per-reply length/token cap, "continue" button, or truncation notice is documented for the
  chat surfaces; the user-visible limits are feature-scoped (100 alerts per summary, 3 MB / 20 MB
  uploads, 10 locally stored Defender Chat conversations).

---

## Part B. Google Security Operations (Gemini)

### B1. Surfaces

- **Gemini pane** (opened from the Gemini logo / Spark icon): single chat side panel used for
  search generation, YARA-L rule generation, threat-intel Q&A, security Q&A and documentation help.
  Chat sessions persist per user; menu offers **Delete chat** and **Delete all chat sessions**;
  "User history is never used to train models." Prompts **must be in English**.
  ([Generate search queries](https://docs.cloud.google.com/chronicle/docs/investigation/generate-udm-search-queries-gemini))
- **SIEM Search natural-language bar** (Investigation > SIEM Search > **Generate Query**).
- **Case Overview "Gemini Summary" widget** (SOAR cases) and **Alerts & IOCs > Run Investigation**
  (Triage and Investigation agent).
- **Playbook designer**: Create / Edit Playbook with Gemini.
- **Agents**: Triage and Investigation (GA), Threat Hunt (preview), Detection Engineering (preview,
  via MCP), Third-Party Context (announced).
- **MCP**: remote SecOps MCP server (GA at Next '26) and "SecOps OneMCP" (preview: list cases,
  retrieve UDM events, manage rules); an **MCP client inside the SecOps chat interface** (preview).
  ([Next '26 blog](https://cloud.google.com/blog/products/identity-security/next26-redefining-security-for-the-ai-era-with-google-cloud-and-wiz),
  [Q1 2026 roundup](https://security.googlecloudcommunity.com/news-announcements-9/google-secops-q1-2026-feature-roundup-7381))
- Overview list of Gemini features: generate search queries, generate a YARA-L rule, TI and
  security Q&A, documentation summaries, playbooks, case summary widget, TIN agent.
  ([Gemini in SecOps overview](https://docs.cloud.google.com/chronicle/docs/secops/gemini-secops))

### B2. Natural language search to UDM (documented)

- **Pane path**: prompt > Gemini shows the generated query (YARA-L 2.0 / UDM search syntax) >
  **Run search** > Gemini returns "a results summary along with suggested actions" > follow-ups such
  as "Who is this user?" or "Generate a rule to help detect that behavior in the future" chain the
  search into entity context and rule authoring.
- **Search-bar path**: time words ("yesterday") **auto-adjust the time picker**; failure message
  "Sorry, no valid query could be generated. Try asking a different way."
- Feedback: thumbs on the generated query; if the analyst rewrites the query and submits, the
  revised query is "sanitized for sensitive data" and used to improve results.
  ([Generate search queries](https://docs.cloud.google.com/chronicle/docs/investigation/generate-udm-search-queries-gemini))

### B3. Case summaries and the Triage and Investigation agent

- **Gemini Summary widget** (Case Overview tab): sections **What Actually Happened?**, **Case
  Activity**, **Next and Pending Actions** (remediation). Inputs: TIN verdict + reasoning, raw event
  JSON, entities, graph data (entities seen in prior malicious cases), **similar cases**. Does not
  auto-refresh on new enrichment (manual refresh). Not shown for manual cases. Limits: averages **2
  cases/min, max 100 cases/hour**, subject to Vertex capacity.
  ([Case summary widget](https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/using-the-gemini-case-summary-widget))
- **Triage and Investigation agent (TIN/TINA)**, GA per Q1 2026 roundup: decides TP/FP with a
  **confidence level** and summary; UI = **Summary by Gemini** (disposition + confidence +
  explanation), **Investigation timeline** in three stages (initial assessment and risk
  prioritization, which can end early for low-risk alerts; contextual enrichment and evidence
  gathering: GTI, Entity Context Graph, network context, case metadata, process tree; adaptive
  investigation), **Suggested next steps**, actions **View alert** / **Re-run investigation**,
  thumbs feedback "focus[ed] on the severity verdict". Tools: dynamic search queries, GTI
  enrichment, command-line analysis, process-tree reconstruction. Triggers: automatic (default **5
  min after the alert**, up to 20; filterable by UDM fields such as `detection.rule_name`) or
  manual **Run Investigation**. Average **~60 s**, max **20 min**; quota around **10 investigations
  per hour per tenant (5 manual + 5 automatic)**; **no queue** – alerts over the limit are not
  analyzed. Curated TIN dashboard tracks volume and **token usage**; audit via Chronicle API logs;
  not FedRAMP. ([TIN agent](https://docs.cloud.google.com/chronicle/docs/secops/triage-agent),
  [Respond to cases](https://docs.cloud.google.com/chronicle/docs/secops/respond-cases))
  **[claim]** "over 5 million alerts" processed and "30-minute manual analysis to 60 seconds"
  (Next '26 blog, vendor-reported).
- **Agentic automation** (preview): playbooks embed an agent step; the playbook waits
  asynchronously (Not Run / Running / Completed) and branches on the agent's verdict and confidence;
  analysts keep "control of critical actions".
  ([Agentic automation](https://docs.cloud.google.com/chronicle/docs/soar/respond/working-with-playbooks/agentic-automation))

### B4. Detection authoring

- **YARA-L from a prompt** in the Gemini pane ("Create a rule to count how many DNS responses were
  truncated per principal asset host") > **Open in rule editor** > Save New Rule > toggle **Live
  Rule**. Generated rule metadata names Gemini as author and stores the prompt as description.
  **Single-event rules only.**
  ([Generate YARA-L](https://docs.cloud.google.com/chronicle/docs/detection/generate-yara-l-with-gemini))
- **Detection Engineering agent** (preview, MCP-driven from an AI client such as Antigravity or
  Claude Code): pulls TI text, produces prioritized **Threat Detection Opportunities**, generates
  **synthetic UDM events**, checks whether existing rules fire ("an empty result ... signaling a
  coverage gap"), drafts YARA-L. "This tool does not automatically upload the rule"; a human creates
  it. Google even ships a skill to stop the model "summarizing or abbreviating tool output".
  ([Detection Engineering agent](https://docs.cloud.google.com/chronicle/docs/secops/agentic-detection-engineering))
  Trade press reports auto-install of rules **[claim]**, which contradicts the docs.
- **Emerging Threat Center** (GA): Gemini reads new GTI campaign reports, determines coverage and
  suggests rules. ([Q1 2026 roundup](https://security.googlecloudcommunity.com/news-announcements-9/google-secops-q1-2026-feature-roundup-7381))

### B5. Threat Hunt agent (preview, Enterprise Plus)

Start from Detection > Emerging Threats > **New Threat Hunt** (also from TI feed, campaign pages,
MITRE drawers); choose category (Actor, Campaign, Malware, Software Toolkit, TTP) and subject;
window default 7 days, max 30. Runs in the background ("actively planning, translating queries, and
scanning UDM events"), decomposes into **atomic questions**, runs YL2 queries, records **event
counts and step evidence**, and creates a case "Threat Hunt for [Subject]". UI: widget with
**Determination** (Substantial Evidence / Evidence Found / Threat Not Found), Results Summary
(hosts, users, command lines, timestamps), **Hunt Steps timeline** (questions, queries, counts,
evidence); statuses Running / Completed / Queued / Failed. Limits: **60-90 min** per hunt, **2
concurrent, 5 per day**. Thumbs feedback on widget, summary, and each step.
([Threat Hunt agent](https://docs.cloud.google.com/chronicle/docs/detection/threat-hunt-agent))

### B6. Playbook generation

Response > Playbooks > **Create Playbook with Gemini** (English prompt > **Generate Playbook** >
preview > refine > **Create Playbook**); **Edit Playbook with Gemini** shows a **before/after
preview**. Can add/delete/move/replace steps and change the trigger; cannot create blocks, parallel
actions, use uninstalled integrations or instances, or edit conditions.
([Playbooks with Gemini](https://docs.cloud.google.com/chronicle/docs/soar/respond/working-with-playbooks/create-edit-playbook-with-gemini))

### B7. Threat intelligence and documentation Q&A

- TI Q&A in the pane ("What is UNC3782?", "Help me hunt for APT 44", "Is 103.224.80.44
  suspicious?", CVE questions); output includes MITRE tactic / technique / sub-technique, detection
  suggestions, procedures, mitigations, a **link to curated detections per TTP**, and a **Sources
  and related content** / **Referenced Sources** footer; follow-ups "create queries for IOCs
  referenced in the reports". Depth depends on edition: only Enterprise Plus has "full access to
  Mandiant and VirusTotal".
  ([TI questions](https://docs.cloud.google.com/chronicle/docs/detection/answer-threat-intelligence-questions-gemini))
- **Documentation summaries** (pre-GA): "How do I create a rule" style questions; answer "might
  also include links to related documentation pages"; Google-Search-grounded answers show a G icon,
  **search query chips and citations**.
  ([In-product help](https://docs.cloud.google.com/chronicle/docs/secops/gemini-docs))

### B8. Limits Google documents

English-only prompts; single-event YARA-L; TIN ~10/hour/tenant with no queue; case summary
100/hour; threat hunts 2 concurrent / 5 per day; summaries depend on edition entitlements; data
processed on global Vertex AI endpoints. No per-reply token caps or "continue" mechanics are
documented for the Gemini pane.

---

## Part C. Cross-vendor patterns (what "standard" looks like in 2026)

1. **Show the work, live.** Process log under the prompt (MS), real-time plan progress (Defender
   Chat), investigation timeline with stages (Google TIN), hunt-steps timeline with per-step queries
   and evidence (Google), agent activity map / decision graph (MS agents). A visible "working"
   state with named steps is table stakes.
2. **Plan, then act, with approval for multi-step work.** Defender Chat proposes a plan that the
   user Approves/Rejects; Google keeps agent-proposed rules and playbooks as previews until a human
   clicks Create / Save.
3. **Clarify instead of guessing.** Defender Chat clarifying questions with up to 4 quick picks;
   Security Analyst Agent asks scoping questions; Gemini returns a clear "no valid query" message.
4. **Every answer is actionable and traceable.** Copy, Retry/Regenerate, Stop, Edit/Delete prompt,
   per-table Export to Excel, "See the logic behind the query", "Open in editor/Run query",
   evidence entities as links, follow-up chips, action suggestions that open pre-filled wizards
   (gated by RBAC, greyed out if not permitted).
5. **Charts as first-class output.** Threat Hunting Assistant auto-picks pie / timeline / bar with
   user-switchable type and grouping; Security Analyst Agent reports include visualizations and
   downloadable CSV artifacts plus the exact queries and plan.
6. **Sessions are documents.** Pin board with AI session summary and tags; share read-only link
   (whole session); export (PDF/Word reported); promptbooks created from selected prompts with
   parameters; incident report with Post to activity log and Export PDF; TI briefing downloadable
   as Markdown.
7. **Context awareness.** "This incident" resolves from the current page; embedded sessions appear in
   the standalone history; workspace defaults (default Sentinel workspace) reduce repetition.
8. **Reusable workflows.** Promptbooks (MS) and NL-built playbooks (Google); scheduled agents
   (TI briefing every 7 days); "continue on failure" per step.
9. **Teachable memory with governance.** Phishing Triage Agent turns analyst corrections into
   reviewed "lessons" with conflict detection, audit and admin-only rejection.
10. **Capacity metering, not per-message truncation.** Both vendors meter at tenant level (SCUs,
    hourly quotas, token-usage dashboards) and surface cost before running (SCU estimate in
    settings). Neither documents per-reply length caps, "continue where stopped" buttons, or
    visible truncation in chat. Google explicitly works to stop models abbreviating tool output.

## Part D. Implications for the Agentic SOC chat (gap list)

Current bounds (SPEC §4.2/§7.4): 5 model calls, 10 tool calls, 90 s turn, 60k token turn ceiling,
4k final tokens, 6k observation chars, 12 blocks/msg, 10 rows inline, markdown 12k chars.

| Pattern | Competitor evidence | Agentic SOC today | Suggested change |
|---|---|---|---|
| No visible per-reply truncation | Neither vendor documents reply caps; both meter capacity | Turn ceiling + 4k final + "continue" flow visible to users | Make chat bounds "unbounded by default" (or very high) for Workspace chat, keep the daily budget / cost ledger (#6) as the only spend governor, remove continue/trim UX; keep observation shrink structural (#7) |
| Live working indicator | Process log, real-time plan progress, stage timelines | Step stream exists | Persistent animated agent-status glyph (nav rail + composer) bound to turn state; named step list |
| Plan approval | Defender Chat Approve/Reject plan | None | For broad asks (>N tools), stream a proposed plan and let the user approve, edit, or reject |
| Clarifying questions with quick picks | Defender Chat (≤4 options), Security Analyst Agent | None | Allow a `clarify` final with up to 4 choice chips |
| Follow-up and action chips | Threat Hunting Assistant, incident summary "See prompts" | Starters only | Per-answer follow-up chips; RBAC-gated "action" chips that open existing console flows (pre-filled) without the chat executing writes |
| Export per table | Defender Chat Export to Excel; Hunting export | Report exports | CSV/XLSX export on every table block; "Copy as Markdown"; "Show query" toggle on log blocks |
| Charts user-switchable | Hunting Observations (pie/timeline/bar, regroup) | Fixed charts | Chart-type and group-by switcher on series/categories blocks |
| Session pin board + share + export | MS pin board, share link, export | Reports library | Pin answers into a report (exists) plus session summary, read-only share link to same-tenant users with RBAC caveat, PDF/DOCX/MD export |
| Promptbooks | MS promptbooks with `<params>` | None | "Save as playbook" from selected prompts with parameters; run with inputs; share org-wide |
| Case-scoped generators | Incident summary, guided response, incident report, script analysis | Case chat | One-click Summarize / Recommend next steps / Generate report / Explain command line on Case Manager, persisted to case activity |
| Feedback taxonomy | Looks right / Needs improvement / Inappropriate + text | thumbs (if any) | Adopt the three-way feedback with free text, auditable |
| Teach-the-agent memory | Phishing Triage lessons with evaluate/conflict/audit | Approved memory store | Route chat corrections to pending memory proposals with a preview "lesson" and conflict check (keeps #9) |
| Long analyses | Security Analyst Agent minutes, Threat Hunt 60-90 min as background job with case | 90 s turn | Offer "Run as background investigation" (Jobs) for heavy questions, with completion notification and a result report |
| Page context | "this incident" from current page | Case/entity context exists | Pass current route entity (case, rule, source, KPI) as context automatically |

Constraints to keep: read-only tools and RBAC-scoped grants (MS: "can't run commands that change
data"; on-behalf-of auth), untrusted fencing of log data (#9), aggregate-then-summarise (#7), every
call through the gateway and cost ledger (#6), and `decide()` as the sole close authority (#3).
Competitors' "action suggestions" only pre-fill a human-confirmed wizard; that is compatible with
these rules.

---

## Sources

Microsoft
- https://learn.microsoft.com/en-us/copilot/security/navigating-security-copilot
- https://learn.microsoft.com/en-us/copilot/security/prompting-security-copilot
- https://learn.microsoft.com/en-us/copilot/security/using-promptbooks
- https://learn.microsoft.com/en-us/copilot/security/build-promptbooks
- https://learn.microsoft.com/en-us/copilot/security/authentication
- https://learn.microsoft.com/en-us/copilot/security/upload-file
- https://learn.microsoft.com/en-us/copilot/security/plugin-overview
- https://learn.microsoft.com/en-us/copilot/security/agents-overview
- https://learn.microsoft.com/en-us/copilot/security/experiences-security-copilot
- https://learn.microsoft.com/en-us/copilot/security/developer/mcp-get-started
- https://learn.microsoft.com/en-us/defender-xdr/security-copilot-in-microsoft-365-defender
- https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-incident-summary
- https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-guided-response
- https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-script-analysis
- https://learn.microsoft.com/en-us/defender-xdr/security-copilot-m365d-create-incident-report
- https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-security-copilot
- https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-security-copilot-query-assistant
- https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-security-copilot-threat-hunting-assistant
- https://learn.microsoft.com/en-us/defender-xdr/security-analyst-agent
- https://learn.microsoft.com/en-us/defender-xdr/phishing-triage-agent
- https://learn.microsoft.com/en-us/defender-xdr/threat-intel-briefing-agent-defender
- https://learn.microsoft.com/en-us/azure/sentinel/sentinel-security-copilot
- https://www.microsoft.com/security/pricing/microsoft-security-copilot/
- https://mc.merill.net/message/MC1261596
- https://thehackernews.com/2025/09/microsoft-expands-sentinel-into-agentic.html
- https://petri.com/microsoft-security-copilot-agent-hidden-threats/ (claims only)

Google
- https://docs.cloud.google.com/chronicle/docs/secops/gemini-secops
- https://docs.cloud.google.com/chronicle/docs/investigation/generate-udm-search-queries-gemini
- https://docs.cloud.google.com/chronicle/docs/detection/generate-yara-l-with-gemini
- https://docs.cloud.google.com/chronicle/docs/detection/answer-threat-intelligence-questions-gemini
- https://docs.cloud.google.com/chronicle/docs/secops/gemini-docs
- https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/using-the-gemini-case-summary-widget
- https://docs.cloud.google.com/chronicle/docs/soar/respond/working-with-playbooks/create-edit-playbook-with-gemini
- https://docs.cloud.google.com/chronicle/docs/soar/respond/working-with-playbooks/agentic-automation
- https://docs.cloud.google.com/chronicle/docs/secops/triage-agent
- https://docs.cloud.google.com/chronicle/docs/secops/respond-cases
- https://docs.cloud.google.com/chronicle/docs/detection/threat-hunt-agent
- https://docs.cloud.google.com/chronicle/docs/secops/agentic-detection-engineering
- https://docs.cloud.google.com/chronicle/docs/reference/mcp
- https://cloud.google.com/blog/products/identity-security/next26-redefining-security-for-the-ai-era-with-google-cloud-and-wiz
- https://security.googlecloudcommunity.com/news-announcements-9/google-secops-q1-2026-feature-roundup-7381
- https://security.googlecloudcommunity.com/what-s-new-in-secops-91/what-s-new-in-google-secops-2026-08-10-8075
- https://securitybrief.news/story/exclusive-google-cloud-on-the-road-to-autonomous-secops (claims only)
