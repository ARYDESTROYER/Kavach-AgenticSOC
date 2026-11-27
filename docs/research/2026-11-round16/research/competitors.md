# Round 16 research: AI and agentic SOC competitors (key: competitors)

Date of research: 2026-11-24. Repository state read: branch `claude/round16`, commit `3cfd5c0`
(Round 15 merged into Testing). Work was read-only.

## 0. Method and caveats

- Each vendor entry lists analyst-visible capabilities and differentiators in six areas:
  investigation transparency and explainability, autonomy controls, case management,
  reporting, integrations, pricing. Every external claim carries a source URL.
- Almost every source is vendor marketing, vendor documentation or vendor-sponsored press.
  Accuracy, time-saved and "percent of alerts" figures are **vendor claims, not verified**.
  Where only one secondary source (often a competitor's blog) gave a fact, it is marked
  **(unverified)**.
- Primary documentation was opened for Microsoft (Phishing Triage Agent, Security Copilot
  inclusion), Google SecOps (Triage and Investigation Agent and its dashboard), Dropzone
  (investigation review and context memory docs, pricing page), Palo Alto (XSIAM "Resolving
  cases with AI"), Legion (AWS Marketplace listing) and Help Net Security's Prophet showcase.
  Other entries rest on search summaries of the cited pages.
- The Agentic SOC side was read from `README.md`, `ROADMAP.md`, `CHANGELOG.md` (Round 15),
  `docs/ROADMAP_RESEARCH.md`, `docs/VIGIL_STUDY.md` and the code paths named below.

## 1. Vendor profiles

### 1.1 Dropzone AI
- **Transparency:** an investigation review has a header (Priority, Conclusion, Review
  Status), "Investigation Threads" built from AI-generated questions (each expands to Thread
  Findings, Sources Queried and follow-up threads), an "AI Action Graph" grouped by stage, an
  Investigation Summary (Alert Claim, Conclusion Reasoning with confidence, Key Findings: "the
  five most significant findings"), an Evidence Locker (each source, its request and "View
  Response" with raw and processed results) and a Changelog.
  [docs.dropzone.ai/best-practices/deep-dive-into-investigation-reviews](https://docs.dropzone.ai/best-practices/deep-dive-into-investigation-reviews)
- **Learning:** "Context Memory" entries come from investigation reviews (a checkbox "Use
  this note to guide context memory generation"), manual entry, or ingestion from
  Confluence, Jira and ServiceNow. Entries link to entities, can expire, can require approval
  per source ("Needs Approval"), keep revision history, are flagged when overlapping or
  contradictory, and show a usage count with the list of investigations that used them.
  [docs.dropzone.ai/platform/context-memory](https://docs.dropzone.ai/platform/context-memory)
- **Other:** an "AI Interviewer" that asks involved users follow-up questions over chat and
  summarises the answers. [dropzone.ai/use-case/context-inquiry](https://dropzone.ai/use-case/context-inquiry)
- **Reporting:** export of an investigation as PDF or JSON (same review doc).
- **Integrations:** "100+ integrations" with every plan. [dropzone.ai/pricing](https://dropzone.ai/pricing)
- **Pricing:** current page is tiered by organisation size with "unlimited investigations
  under fair use"; no figures. A competitor's article says it historically started at
  $36,000 a year for 4,000 investigations (unverified).
  [intezer.com/guides/soc-as-a-service/dropzone-ai](https://intezer.com/guides/soc-as-a-service/dropzone-ai).
  One source says Cribl acquired Dropzone technology in August 2026 (unverified, single
  source). [tech-insider.org](https://tech-insider.org/?p=22875)

### 1.2 Prophet Security (Prophet AI)
- **Transparency:** each alert gets a determination (benign, malicious, inconclusive), a
  severity, remediation steps and a compiled timeline; "every finding carries citations back
  to the exact source" and analysts can "view the precise query that was run."
- **Learning:** an analyst explains an inconclusive case "once in plain English" and it is
  applied to similar investigations "with scope and an expiration date the analyst controls."
- **Autonomy:** high-confidence false positives can auto-resolve; actions that change access
  or contain a host "default to human approval."
- **Deployment and integrations:** single-tenant isolation, data residency, BYOK; results flow
  into Jira, Slack and Teams.
  All from the sponsored [Help Net Security showcase](https://www.helpnetsecurity.com/2026/06/24/product-showcase-prophet-security-ai-soc-platform).
- **Product line:** AI SOC Analyst, AI Threat Hunter, AI Detection Advisor, and an AI
  Detection Engineer (July 2026).
  [businesswire.com](https://www.businesswire.com/news/home/20250729681026/en/Prophet-Security-Raises-$30M-Series-A-Announces-Industrys-Most-Comprehensive-Agentic-AI-SOC-Platform-to-Transform-Security-Operations),
  [dealroom.co](https://app.dealroom.co/news/feed/prophet-security-launches-ai-detection-engineer-to-automate-security-detection-engineering-with-continuous-gap-analysis)
- **Pricing:** not public. Prophet publishes a guide comparing per-alert, per-endpoint,
  per-data and flat pricing. [prophetsecurity.ai/blog/ai-soc-pricing-models](https://www.prophetsecurity.ai/blog/ai-soc-pricing-models)

### 1.3 7AI
- **Differentiator:** "Dynamic Reasoning": agents choose which sources to query and how deep
  to go per alert, positioned against playbook-based SOAR. Agents cover triage,
  investigation and authorized remediation; "Incident Management" consolidates alerts into one
  view. [helpnetsecurity.com](https://www.helpnetsecurity.com/2025/08/06/7ai-enables-end-to-end-autonomous-security-operations/)
- **Integrations:** EDR, cloud, email and identity tools. **Pricing:** quote only
  ([g2.com/products/7ai/pricing](https://www.g2.com/products/7ai/pricing)).

### 1.4 Radiant Security
- **Transparency:** each escalation or dismissal records the data sources queried, the
  patterns detected and the reasoning; an auto-generated response plan per escalated incident
  that can run manually, "in one click" or automatically.
  [radiantsecurity.ai/platform.md](https://radiantsecurity.ai/platform.md)
- **Differentiator:** AI triage plus built-in log management in one product (April 2025
  launch). [prweb.com](https://www.prweb.com/releases/radiant-security-unveils-the-first-adaptive-ai-soc-platform-enabling-analysts-to-rapidly-detect-and-respond-to-100-of-all-threats-302425016.html)
- **Pricing:** not public ([g2.com](https://www.g2.com/products/radiant-security-radiant/pricing)).

### 1.5 Intezer (Forensic AI SOC)
- **Transparency:** "every verdict comes with clear, evidence-based explanations"; verdicts
  combine LLM reasoning with deterministic forensics (endpoint forensics, reverse engineering,
  sandboxing). [intezer.com/forensic-ai-soc-lp](https://intezer.com/forensic-ai-soc-lp/)
- **Learning:** "Every verdict can be challenged in the platform, and your feedback tunes
  both the triage logic and the detection rules." Investigates every alert, including
  low-severity ones. [intezer.com](https://www.intezer.com)
- **Pricing:** by endpoints, no figure published ([intezer.com/pricing](https://intezer.com/pricing)).

### 1.6 Torq HyperSOC (Socrates)
- **Architecture:** Socrates orchestrates Runbook, Investigation, Remediation and Case
  Management agents. The Case Management agent organises timelines, highlights key indicators,
  reprioritises and writes AI case summaries; runbooks in natural language are associated by
  the case's observables; approvals and evidence capture can run inside Slack or Teams.
  [torq.io/blog/torq-hypersoc-faq](https://torq.io/blog/torq-hypersoc-faq/),
  [torq.io/ai-agents-for-the-soc](https://torq.io/ai-agents-for-the-soc/)
- **Case management:** risk-gated actions run from the case and are recorded on the case
  timeline. [torq.io/case-management](https://torq.io/case-management/)
- **Pricing:** two secondary sources cite $450,000 a year on AWS Marketplace (unverified).
  [underdefense.com](https://underdefense.com/blog/beyond-torq-a-guide-to-ai-soc-alternatives/)

### 1.7 Exaforce
- **Differentiator:** a security knowledge graph built at ingest (events, identities,
  permissions, configurations, code, cloud activity) instead of reconstructing context per
  alert; task agents called "Exabots" for detection, triage, hunting and response; an MDR
  service on top. $125M Series B in May 2026.
  [securityweek.com](https://securityweek.com/exaforce-raises-125-million-for-agentic-soc-platform/),
  [businesswire.com](https://www.businesswire.com/news/home/20260609458725/en/)

### 1.8 Command Zero
- **Differentiator:** a governed **question library**: every investigation, autonomous or
  analyst-led, draws on curated investigation questions; customers add their own; a public
  GitHub repo of starter questions. Analysts "can take over, extend, or redirect any
  autonomous investigation."
  [awards.thehackernews.com](https://awards.thehackernews.com/winners/2026/command-zero-autonomous-soc/),
  [nsfocusglobal.com](https://nsfocusglobal.com/rsac-2025-innovation-sandbox-command-zero-the-human-machine-collaboration-engine-redefining-security-investigations/)
- **Integrations:** public APIs and an MCP server for programmatic investigations.
  [msspalert.com](https://www.msspalert.com/news/command-zero-introduces-apis-mcp-server-to-its-ai-based-autonomous-soc)

### 1.9 D3 Security Morpheus
- **Transparency:** "Attack Path Discovery" produces a structured case file with attack path,
  timeline, MITRE ATT&CK mapping, blast radius and IR recommendations.
- **Autonomy:** "raise autonomy per alert type and can step back at any time"; response
  actions are mode-governed; one audit trail per incident.
- **Integrations:** "800+ self-healing integrations" that adapt to vendor API changes
  (vendor claim). A vendor-run benchmark against Microsoft Security Copilot (unverified).
  [d3security.com/morpheus/investigation](https://d3security.com/morpheus/investigation/)
- **Pricing:** D3's buyer guide says marketed per-alert pricing in this category runs $9 to
  $10 per alert (vendor statement). [d3security.com/morpheus/ai-soc-pricing-models](https://d3security.com/morpheus/ai-soc-pricing-models/)

### 1.10 Simbian
- **Differentiator:** public benchmarks: an "AI SOC LLM Leaderboard" (June 2025, 100
  full-kill-chain scenarios) and a "Cyber Defense Benchmark" (April 2026) with mutated context,
  deterministic scoring against ground truth and cost tracked alongside accuracy.
  [businesswire.com (2025)](https://www.businesswire.com/news/home/20250612762313/en/Simbian-Announces-Industrys-First-Benchmark-to-Comprehensively-Measure-LLM-Performance-in-Security-Operations-Centers),
  [businesswire.com (2026)](https://www.businesswire.com/news/home/20260428509405/en/Simbian-Publishes-Worlds-First-Cyber-Defense-Benchmark-Finds-Frontier-LLMs-Alone-Do-Poor-Job-at-Attack-Discovery)
- A shared "Context Lake" data layer (no technical detail found).

### 1.11 Conifers (CognitiveSOC)
- **Differentiator:** "institutional knowledge" per tenant (assets, risk tolerance, business
  process) so analysts and clients can see why each decision was made; each agent action comes
  with a reasoning chain and evidence trail; remediation within customer guardrails; built for
  MSSPs and multi-tenant use; 60+ integrations.
  [helpnetsecurity.com](https://www.helpnetsecurity.com/2026/05/26/conifers-ai-agentic-soc/),
  [msspalert.com](https://www.msspalert.com/news/conifers-offers-agentic-soc-for-enterprises-and-mssps)

### 1.12 Qevlar AI
- Graph AI linking alerts, entities and activities with "deterministic core reasoning with
  narrowly scoped AI tasks" ([kuppingercole.com](https://www.kuppingercole.com/vendors/qevlar)).
  A competitor (D3) says it cannot run response actions itself (competitor claim).
  [d3security.com/morpheus/vs/qevlar](https://d3security.com/morpheus/vs/qevlar/)

### 1.13 Legion Security
- **Differentiator:** a browser extension that records analysts' own investigations with
  vision models and replays them as workflows; no API integrations needed.
- **Autonomy:** three phased modes: "Learning Mode", "Guided Mode" (human oversight) and
  "Autonomous Mode".
- **Pricing:** $120,000 for a 12-month "Legion AI SOC Annual Contract" on AWS Marketplace.
  [aws.amazon.com/marketplace/pp/prodview-27qsosrtjg6cg](https://aws.amazon.com/marketplace/pp/prodview-27qsosrtjg6cg)

### 1.14 Microsoft Security Copilot agents (Defender)
- **Transparency:** the Phishing Triage Agent (now also the Security Alert Triage Agent for
  some identity and cloud alerts) gives "transparent rationale ... in natural language" and "a
  full graphical representation of its decision-making workflow"; an agent card on the incident
  shows the verdict and the key evidence; "View agent activity" opens the steps.
- **Presence while working:** "When triaging starts, the agent assigns the alert to itself and
  adds an Agent tag to the corresponding incident"; the queue can be filtered by that tag or
  the agent identity.
- **Autonomy and governance:** a dedicated agent identity with least-privilege roles; Pause and
  Run controls; all activity logged and in Purview audit.
- **Learning:** an analyst changes the classification and writes why; only when "Use this
  feedback to teach the agent" is ticked does it become a lesson; "Evaluate feedback" previews
  the lesson and checks conflicts; a feedback management page lists status (In use, Not in use,
  Conflict) and admins can reject a lesson.
- **Reporting:** an agent Performance tab with daily activity, mean time to triage and
  capacity consumption.
  [learn.microsoft.com/defender-xdr/phishing-triage-agent](https://learn.microsoft.com/en-us/defender-xdr/phishing-triage-agent)
- **Pricing:** Microsoft 365 E5 and E7 include 400 SCUs a month per 1,000 user licenses (cap
  10,000); overage planned at $6 per SCU pay-as-you-go. Agents still need set-up.
  [learn.microsoft.com/copilot/security/security-copilot-inclusion](https://learn.microsoft.com/en-us/copilot/security/security-copilot-inclusion)

### 1.15 Google Security Operations (Gemini Triage and Investigation Agent)
- **Transparency:** a "Summary by Gemini" at the top (alert, findings, how it reached its
  conclusion), a disposition (true or false positive) with a confidence level, then an
  "Investigation timeline" where each card is one analysis step, then recommended next steps.
- **Autonomy controls:** auto-investigation on by default for opted-in tenants; "Investigation
  timing" delay before a run starts (default 5 minutes, max 20); "Investigation criteria" on
  UDM fields with `=`/`!=` and AND/OR; manual runs from alerts or cases.
  [docs.cloud.google.com/chronicle/docs/secops/triage-investigation-agent](https://docs.cloud.google.com/chronicle/docs/secops/triage-investigation-agent)
- **Feedback and reporting:** thumbs up/down per investigation; a curated dashboard with
  investigation volume, volume by trigger type (manual vs automatic), dispositions by day, and
  separate feedback charts for "Disposition", "Investigation step", "Investigation summary" and
  "Next steps", plus daily token usage.
  [docs.cloud.google.com/chronicle/docs/secops/triage-investigation-agent-dashboards](https://docs.cloud.google.com/chronicle/docs/secops/triage-investigation-agent-dashboards)
- A playbook calling the agent on an already-investigated alert gets the existing verdict
  rather than a second run (search summary of the same docs).

### 1.16 CrowdStrike Charlotte AI
- **Detection Triage:** priority, true or false positive, and a recommended action per endpoint
  detection; accuracy benchmarked against CrowdStrike's own MDR analysts (vendor claim).
  [crowdstrike.com blog](https://crowdstrike.com/en-us/blog/agentic-ai-innovation-in-cybersecurity-charlotte-ai-detection-triage)
- **Bounded autonomy:** Charlotte "does not take automated response actions by default";
  teams choose which actions run automatically. **AgentWorks**: a no-code workspace to build,
  test and version custom agents across several model providers.
  [crowdstrike.com/platform/charlotte-ai/charlotte-ai-agentworks](https://www.crowdstrike.com/en-us/platform/charlotte-ai/charlotte-ai-agentworks/)

### 1.17 Palo Alto Networks Cortex XSIAM and AgentiX
- **Governance:** agents use only actions assigned to them, capped at the invoking user's
  permissions; sensitive actions need explicit sign-off; every agent action is stored in an
  audit dataset with the agent and the invoking user.
  [cortex-docs: agentic assistant security](https://cortex-docs.paloaltonetworks.com/cortex-agentix/learn-about-cortex-agentix/agentic-ai-in-cortex-agentix/agentic-assistant-security)
- **Case work:** AI-generated case titles and summaries (scope, key issues and artifacts,
  affected assets); a "Resolution Center" listing remediation tasks and what is waiting, in
  progress or completed, where agent approvals wait for the team; agents dispatched from the
  Cases table, once or on an interval.
  [cortex-docs: Resolving cases with AI](https://cortex-docs.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-3.x-Documentation/Resolving-cases-with-AI),
  [cortex-docs: AI generated case summaries](https://cortex-docs.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-3.x-Documentation/AI-generated-case-summaries)
- **Score explainability:** SmartScore case scores open to a breakdown in the details pane;
  "SmartScore Explainability" shows the contributing factors; a manual score overrides it.
  [paloaltonetworks.com blog](https://www.paloaltonetworks.com/blog/security-operations/unlocking-the-black-box-transparency-for-ml-based-incident-risk-scoring),
  [cortex-docs: Case scoring](https://cortex-docs.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-3.x-Documentation/Case-scoring)

### 1.18 Splunk SOAR, Enterprise Security and AI Assistant
- **Agents:** a Triage agent that enriches, prioritises and explains alerts (2026), a Malware
  Reversing agent and a Phishing Analysis agent (ES 8.6+, Splunk platform 10.2+, Premier
  edition per the 8.8 docs).
  [splunk.com blog RSAC 2026](https://www.splunk.com/en_us/blog/security/from-reactive-to-agentic-with-enterprise-security-at-rsac-2026.html),
  [help.splunk.com ES 8.8](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.8/agentic-capabilities-in-splunk-enterprise-security/analyze-scripts-using-the-ai-powered-malware-reversing-agent-and-phishing-analysis-agent-in-splunk-enterprise-security)
- **Score explainability (RBA):** an object's risk is the sum of its risk events over a
  window; each event's score comes from impact and confidence (80 and 70 give 56); a Risk
  Timeline drills into the contributing events.
  [help.splunk.com: how risk scores work](https://help.splunk.com/en/splunk-enterprise-security-7/risk-based-alerting/7.3/introduction/how-risk-scores-work-in-splunk-enterprise-security)

### 1.19 Elastic Security (Attack Discovery, AI Assistant)
- **Attack Discovery:** groups alerts into attacks with an LLM summary and an "Attack Chain"
  diagram on MITRE tactics; entity names open a flyout with risk score, asset criticality and
  recent activity; recurring schedules (daily, weekly); "View in AI Assistant" for follow-ups.
  [elastic.co/docs attack-discovery](https://www.elastic.co/docs/solutions/security/ai/attack-discovery),
  [triage findings](https://www.elastic.co/docs/solutions/security/ai/triage-attack-discovery-findings),
  [schedules](https://www.elastic.co/docs/solutions/security/ai/attack-discovery/schedule-runs-from-attacks-page)
- **Privacy:** field-level anonymization settings decide which alert fields reach the LLM and
  which are obfuscated (same docs).
- **Score explainability:** entity risk scoring documents the categories (Alerts, Asset
  Criticality, Privileged User), the default weights and a worked example (alert score 36.16
  plus criticality contribution 16.95 gives 53.11, Moderate).
  [elastic.co/docs entity-risk-scoring](https://www.elastic.co/docs/solutions/security/advanced-entity-analytics/entity-risk-scoring)
- **Pricing:** Attack Discovery launched for Enterprise license holders (2024 press release);
  current self-managed tiering not confirmed.
  [businesswire.com](https://www.businesswire.com/news/home/20240506012000/en/Elastic-changes-the-SIEM-game-with-AI-driven-security-analytics)

### 1.20 SentinelOne Purple AI
- **Agentic features:** Auto-Triage (similarity analysis and community intelligence: common
  pattern or novel), one-click Auto Investigation (GA at RSAC 2026), Agentic Investigation (June
  2026) where "every verdict carries a complete, auditable evidence chain"; response through
  Hyperautomation "within pre-approved policies"; trial credits.
  [sentinelone.com press](https://www.sentinelone.com/press/sentinelone-opens-purple-ai-agentic-investigation-to-all-customers-bringing-frontier-ai-directly-into-the-soc/),
  [siliconangle.com](https://siliconangle.com/2026/06/17/sentinelone-turns-purple-ai-loose-investigate-threats/)
- **Hunting:** natural language to PowerQuery, self-documenting shareable notebooks, suggested
  next queries, auto-generated post-investigation summaries.
  [sentinelone.com resources](https://www.sentinelone.com/it/resources/general/sentinelones-purple-ai-natural-language-queries-quickstarts-and-notebooks)

### 1.21 Tines
- **Free tier:** Community Edition is free, no card; includes the AI Agent action and
  Workbench (capped at 20 daily messages tenant-wide); limits of 3 flows; event limits differ
  across Tines pages. [tines.com/pricing](https://tines.com/pricing),
  [explained.tines.com](https://explained.tines.com/en/articles/9398967-what-tines-ai-features-are-available-to-community-edition-users)
- **Release communication:** a public "What's new" stream of feature posts.
  [tines.com/whats-new/meet-tines-workbench](https://tines.com/whats-new/meet-tines-workbench)

### 1.22 Swimlane (Turbine, Hero AI)
- Hero AI case-management agents including a **Verdict Agent** that uses knowledge base
  articles, linked case history, threat intelligence and analyst notes (November 2025); Hero
  runs playbooks on demand via MCP (September 2025); an agent builder (January 2026);
  intelligent routing for agentic investigations (August 2026).
  [businesswire.com (Nov 2025)](https://www.businesswire.com/news/home/20251118146015/en/),
  [businesswire.com (Sep 2025)](https://www.businesswire.com/news/home/20250910334619/en/Swimlane-Hero-AI-Super-Powers-Analysts-with-AI-Enabled-Incident-Response),
  [swimlane.com](https://swimlane.com/news/ai-soc-intelligent-routing-agentic-investigations/)

### 1.23 Open-source peers (the "free" competition)
- **Tracecat:** open-source SOAR (AGPL-3.0) with agents, workflows and case management;
  secondary summaries say human-in-the-loop approvals, RBAC and MCP servers sit in the paid
  Enterprise tier (unverified).
  [github.com/TracecatHQ/tracecat](https://github.com/TracecatHQ/tracecat),
  [blog.brightcoding.dev](https://blog.brightcoding.dev/2026/09/10/tracecathqtracecat-open-source-security-automation-for-ai-agents-and-teams)
- **Vigil (DeepTempo):** Apache-2.0, launched at RSAC 2026 with 13 agents (press release).
  [securityinfowatch.com](https://www.securityinfowatch.com/cybersecurity/news/55365866/deeptempo-vigil-launches-as-open-source-ai-soc-to-empower-security-teams)
  Agentic SOC already studied it in `docs/VIGIL_STUDY.md`.
- **AiSOC and FunnyWolf agentic-soc-platform:** MIT-licensed projects (self-reported).
  [github.com/beenuar/AiSOC](https://github.com/beenuar/AiSOC),
  [github.com/FunnyWolf/agentic-soc-platform](https://github.com/FunnyWolf/agentic-soc-platform)

## 2. Convergent patterns across the market

1. **Verdict-first case view.** Google (summary, verdict, confidence, then step cards, then
   next steps), Dropzone (summary, key findings capped at five, evidence locker), Microsoft
   (agent card with verdict and key evidence; full activity one click away), XSIAM (AI case
   summary and a Resolution Center). The long trace is secondary, never the first thing.
2. **Visible agent presence.** Microsoft self-assigns and tags incidents "Agent"; XSIAM puts
   agents on the case team with task states; Google distinguishes manual and automatic runs.
   An analyst can always tell what the AI is doing now and filter by it.
3. **Every score opens to its math.** XSIAM SmartScore breakdown and explainability, Elastic
   documented weights and worked example, Splunk RBA sums with an event timeline.
4. **Correct the AI and teach it, with governance.** Microsoft lessons with an explicit opt-in,
   preview, conflict check and rejection; Dropzone memory with expiry, approval, entity links,
   conflict flags and usage counts; Prophet scope and expiry; Intezer challengeable verdicts.
5. **Granular feedback and agent performance reporting.** Google feedback split by verdict,
   step, summary and next steps; Microsoft MTTT and consumption per agent.
6. **Bounded, opt-in autonomy.** CrowdStrike no automated response by default; AgentiX
   approvals and permission caps; Prophet and Radiant human approval for containment; Legion and
   D3 graduated autonomy per mode or alert type; Google investigation criteria and delay.
7. **Response actions with approval.** Nearly every commercial product (7AI, Radiant, Torq,
   XSIAM, Purple AI via Hyperautomation, D3) closes the loop with approved actions.
8. **Open interfaces.** Command Zero APIs and MCP server, Security Copilot MCP and Graph APIs,
   Swimlane playbooks via MCP, Tracecat driven from external agent harnesses.
9. **Opaque or high pricing.** Public figures where found: Legion $120,000 a year; Torq
   $450,000 (unverified); Dropzone historically $36,000 (unverified); D3's $9 to $10 per alert
   market figure; Microsoft SCU consumption. Free options are capped (Tines CE) or gate
   governance features behind a paid tier (Tracecat, unverified).

## 3. Agentic SOC compared with the market

### 3.1 Where Agentic SOC already leads (keep and say so)
- **Deterministic decision authority** (`engine/case_manager.py` `decide()`), with TRUE_POSITIVE
  auto-close off by default and NEEDS_HUMAN never auto-closing. No vendor above documents a
  code-owned close decision separate from the model.
- **Per-step cost and tokens on the trace** (`webui/src/soc/components/TraceTimeline.tsx` shows
  cost and tokens per span) and one ledger row per model call (#6). Google shows tokens per day
  and Microsoft shows capacity per agent, neither per step.
- **Independent ground truth**: the Round 15 auto-close review (seeded sample, Wilson interval
  from 30 reviews, kept out of agent statistics). No vendor above documents a random audit of
  its own automatic closes.
- **Self-hosted, bring your own model** including local OpenAI-compatible endpoints, OCSF
  normalisation, three state backends, governed runbooks, audit export, Team activity without a
  ranking. Governance features (RBAC, MFA, SSO, approvals, audit) are not paywalled.
- **Explainability already present in places**: `GET /api/cases/{id}/rationale`
  (`engine/case_rationale.py`: tools, reasoning, evidence, memory used, runbook provenance),
  the stage timeline's risk arithmetic (`api/routes_triage.py::_risk_calculation`, rendered by
  `webui/src/soc/pages/casedetail/StageTimeline.tsx`), `reproduce_query`, and evidence queries.

### 3.2 Parity, but behind the best presentation
- Case view: the data a Google or Dropzone view shows exists, but the Investigation tab still
  centres the trace (`casedetail/InvestigationPanel.tsx`), and the risk math lives in the stage
  timeline rather than on the number the analyst looks at (`casedetail/SignalProfile.tsx` shows
  factor bars only).
- Feedback: case grades and chat answer ratings exist; there is no per-step or per-summary
  feedback (Google) and no path from a correction to a governed lesson (Microsoft, Dropzone).
- Memory (`models.py::MemoryEntry`): approval exists, but no expiry, entity or rule scope,
  origin case, or usage count, although `case_rationale.py` already extracts `memory_used`
  per run from the CONTEXT audit row.

### 3.3 Gaps
- No visible "AI is investigating" presence outside the open case: `agents/pipeline.py::_emit_step`
  publishes `agent.step` only to the per-case room `cases:{id}` (consumed by
  `CaseActivityFeed.tsx`); nothing on the `cases` topic or in the shell says investigations are
  running.
- No global pause for automatic investigations (Microsoft has Pause and Run). Per-feed
  `auto_investigate` and the budget gate exist (`config.py`), but there is no one switch.
- No approval-gated response actions, MCP server, scoped API keys, ticketing, attack storyline,
  scheduled digests, field anonymization before the model, multi-tenancy (all in `ROADMAP.md`
  backlog or absent).
- No license (README "License" section), which blocks the "free for the world" claim.

### 3.4 Defects found while comparing (factual, from code)
1. **Risk help text hardcodes the default weights.** `webui/src/soc/components/riskCopy.ts`
   (`RISK_HELP_TEXT`: "Reputation 30% ... Asset criticality 10%") and
   `backend/app/engine/priority.py::derive_triage` (`risk_chip.inputs.definition`) state the
   default weights, while the weights are operator-editable in Settings, Detection
   (`webui/src/soc/pages/settings/detection.tsx`, `prefs.risk_weights`, `config.py::RiskWeights`).
   After an operator changes them, the help text is wrong.
2. **The weights used to score a case are not stored.** `RiskBreakdown` (`models.py`) holds the
   five factor scores and the total only. `_risk_calculation` recomputes with the current
   weights and flags `matches_displayed_score`, so after a weight change the original math of
   an older case cannot be shown, only the disagreement.
3. **Routing score and stored score differ without explanation on the case.**
   `engine/risk.py::compute_routing_risk` normalises over available signals for the auto-forward
   gate; the stored `risk_score` is the canonical `compute_risk`. A case can be auto-investigated
   with a routing score at or above the floor (default 70) while showing a lower stored risk.
   `engine/forwarding.py::explain_forwarding` states this exactly, and
   `GET /api/cases/{id}/forwarding` serves it, but no Console code calls that route (only
   `webui/src/lib/api-types.gen.ts` references it).

## 4. Ranked recommendations

Ranking is by value to the operator's stated goals (free, clean, every number explainable,
cleaner Case Manager, visible AI work) divided by effort, with the non-negotiables as hard
constraints. `this_round: true` marks items that fit Round 16 alongside the operator's asks
(most of them are direct implementations of those asks, informed by the competitor pattern).

### R1. Agent presence: "AI is investigating" everywhere (this_round: true)
- **What:** a live, honest indicator of automatic investigations: a shell glyph with a count
  ("AI investigating 3"), a status line on the Case Manager queue row ("AI investigating: tools,
  step 4"), an "AI agent" chip on the case header while a run is in flight, and an Inbox item or
  toast when a run finishes ("case-0042 escalated to a person"), following the in-app
  notification preferences. Pattern: Microsoft self-assign plus Agent tag, XSIAM agents on the
  case team, Google manual vs automatic runs.
- **Where:**
  - New process-local registry `backend/app/engine/investigation_activity.py` (start, step,
    finish; bounded; cleared in a `finally` so a failed run never leaves a ghost). Updated from
    `agents/pipeline.py::_emit_step` and the run's terminal path.
  - Also publish a compact frame on `CASES_TOPIC` (case id, step, status; no `detail` text) as a
    new `AGENT_ACTIVITY_EVENT` in `backend/app/realtime.py` `SSE_EVENT_TYPES`, mirrored in
    `webui/src/lib/useEventStream.ts` (their agreement test must be extended).
  - New auto-discovered router `backend/app/api/routes_agent_activity.py`:
    `GET /api/agent/activity` under `cases:read` (count plus up to 50 case ids and steps) for
    polling fallback and first paint.
  - Console: an entry-safe store modelled on `webui/src/soc/chat-activity/store.ts`
    (`useSyncExternalStore`), the glyph in the shell, the row line in `pages/CaseManager.tsx`,
    the finish notice through the existing in-app path (`notifications/inapp.py`).
- **Effort:** M. **Value:** high.
- **Risks:** entry chunk budget (329,093 B against a +1,024 B allowance over 329,080 B), so keep
  only the tiny store on the entry path and lazy-load the rest; frame volume (coalesce per case,
  at most one frame per step); single-replica boundary (process-local, like the chat turn
  registry; say so in docs); #9 (frames carry only our own step words); #3 (frames narrate,
  nothing decides).
- **Tests:** pytest for registry lifecycle on success, failure, budget block and exception;
  route RBAC and Demo Mode; SSE type agreement; Vitest for the glyph, row line and notice with a
  fake EventSource, reduced motion, and polling fallback.

### R2. "Show the math" on every risk number (this_round: true)
- **What:** hover or focus on any risk value (facts rail, queue row, hover card, header) opens a
  popover with: each factor's raw input (events, events per minute and window, distinct rules,
  worst reputation and its provider, asset criticality and whether it came from a CIDR or an
  exact match), the normalisation used (log scale to 50 events, 10 per minute, 5 rule types),
  the factor score, the weight and its share, the weighted contribution, the sum and division,
  and the rounding; click pins it with a "Copy math" action. Pattern: XSIAM SmartScore
  breakdown, Elastic worked example, Splunk RBA.
- **Where:**
  - New pure `backend/app/engine/risk_explain.py::explain_risk(cluster, prefs, reputation)`
    returning inputs and rows; must reproduce `compute_risk` exactly (do not edit
    `engine/risk.py`).
  - Store a weight snapshot at scoring time: an additive nullable `Case.risk_weights_used`
    (and optional `risk_inputs`) set beside the three `compute_risk` calls in
    `agents/pipeline.py` (lines near 942, 1415, 1564). Legacy cases stay `null` and the popover
    says "scored before weights were recorded; shown with today's weights" (no backfill, matching
    the provenance contract in AGENTS.md section 5).
  - Extend `api/routes_triage.py::_risk_calculation` to prefer the stored snapshot.
  - Console: one `RiskMathPopover` (HoverCard for pointer, Popover for click and keyboard)
    reused by `casedetail/SignalProfile.tsx`, `CaseHoverCard.tsx` and the queue row.
  - Fix defect 3.4.1: build the help text from the live weights (backend sends them in
    `derive_triage`; `riskCopy.ts` keeps only a fallback).
- **Effort:** M. **Value:** high (it is the operator's explicit example).
- **Risks:** drifting from `compute_risk` rounding (guard with a property test); popover
  clutter (keep it on demand, never inline); `decide()` untouched.
- **Tests:** property test over random clusters and weights that `explain_risk` total equals
  `compute_risk(...).total`; snapshot preserved after a weight change; legacy `null` path; Vitest
  for keyboard access and the copy action.

### R3. "Why was this investigated?" on the AI chip (this_round: true)
- **What:** surface the existing forwarding explainer and the routing score next to the stored
  risk: "Auto-investigated: routing score 72 reached the floor 70 (reputation unknown before
  investigation). Stored risk after enrichment: 48." Pattern: Google investigation criteria and
  manual vs automatic trigger; Microsoft transparency.
- **Where:** consume `GET /api/cases/{id}/forwarding` (`engine/forwarding.py`) from the case
  header provenance chip and the R2 popover; add the routing total to the explainer response if
  absent (it is already computed there).
- **Effort:** S. **Value:** medium to high (fixes defect 3.4.3).
- **Risks:** wording must not imply the stored risk decided anything (#3).
- **Tests:** Vitest for each gate sentence (risk floor, allowlist, alerts role, severity floor,
  toggle off); pytest that the route stays read-only.

### R4. Case Manager, verdict first (this_round: true)
- **What:** reorder the Investigation and Overview content around the convergent pattern:
  1. Verdict card: AI verdict and confidence (AI), the code decision and its policy clause
     (Code), one-line reason. Reuse `casedetail/DecisionCard.tsx`.
  2. Key findings: at most five items from `Case.evidence`, each with its source and a "View
     query" disclosure (Dropzone key findings, Prophet citations).
  3. Next steps: `recommended_action` plus the runbook Next step card (Google next steps,
     XSIAM Resolution Center).
  4. Sources queried: a compact evidence locker list of tools, queries and counts.
  5. "View agent activity": the full `TraceTimeline` in a side sheet instead of inline
     (Microsoft "View agent activity").
- **Where:** `webui/src/soc/pages/casedetail/InvestigationPanel.tsx`, `OverviewPanel`,
  `DecisionCard.tsx`, `TraceTimeline.tsx`, the facts rail; keep the five tabs, Alt+1 to Alt+5 and
  the retired `tab=timeline` and `tab=threat` aliases from Round 15.
- **Effort:** M to L. **Value:** high.
- **Risks:** churn right after the Round 15 redesign (keep URLs and test ids); #9 fencing of
  evidence summaries must stay (they are log-influenced).
- **Tests:** existing casedetail Vitest suites, the visual dialect test, axe checks, and a
  screenshot pass in Demo Mode.

### R5. Every metric explains itself (this_round: true)
- **What:** one shared `NumberExplain` primitive for KPIs (MTTA, MTTR, FP rate, auto-closed,
  agreement rate, cost): formula, numerator and denominator counts, window and time zone,
  exclusions (for example review grades left out of agent statistics), partial or "at least"
  status, and a link to the filtered case list that produced it. Pattern: Google TIN dashboard
  sections, Microsoft agent Performance tab.
- **Where:** extend `webui/src/soc/components/KpiDrilldownPanel.tsx`, `MetricHoverTrend.tsx` and
  `HelpTip.tsx`; backend metric routes already return counts in most places (`api/routes_metrics.py`,
  `engine/metrics.py`); add `numerator`/`denominator` where missing, additively.
- **Effort:** M. **Value:** high.
- **Risks:** inconsistent definitions across pages; keep one definition table.
- **Tests:** contract tests that each KPI response carries its counts; Vitest per primitive.

### R6. Per-release "What's new" and a release tracker (this_round: true)
- **What:** on the first sign-in after an upgrade, a one-time What's new sheet; a permanent
  release tracker page under the Notifications group (shown to the operator as Communication)
  listing every release with dated notes and screenshots. Pattern: Tines "What's new" stream,
  XSIAM monthly release highlights, Microsoft in-product banners.
- **Where:** generate `release-notes.json` at build from `docs/releases/*.md` and
  `docs/assets/screenshots/` (same pipeline style as `npm run gen:console-map`), bundled so it
  works offline; seen state in `UserPrefs.misc` (`stores/user_prefs.py`, KV only, #12); page
  registered in `webui/src/soc/registry.tsx` under `notifications`.
- **Effort:** M. **Value:** medium to high.
- **Risks:** entry bundle (lazy chunk); showing Testing builds as releases (key on the release
  identity the shell already reconciles; a known mismatch shows as Testing).
- **Tests:** shows once per version per user, dismiss persists, Demo Mode, offline build.

### R7. Choose and publish a license (this_round: true, owner decision)
- **What:** add an OSI license file (Apache-2.0 matches Vigil and keeps patent terms; AGPL-3.0
  matches Tracecat). Without it, `README.md` states use and redistribution are not permitted,
  which contradicts "free for the world." Competitors' free tiers are capped (Tines CE) or gate
  governance (Tracecat, unverified); keeping RBAC, approvals and audit free is a differentiator.
- **Where:** `LICENSE`, `README.md` License section, `CONTRIBUTING`, release notes.
- **Effort:** S. **Value:** high. **Risk:** a legal choice that only the owner can make; agents
  must not pick it.
- **Tests:** `scripts/check_docs` and the CI contract if they assert README sections.

### R8. Teach the agent from a close, with scope, expiry and usage (this_round: false)
- **What:** a "Use this note to teach the agent" checkbox in the close dialog creates a pending
  `MemoryEntry` scoped to the case's rule and entity, with an optional expiry; the Memory page
  shows status (pending, approved, expired), origin case, and "used in N investigations" with
  links. Pattern: Microsoft lessons, Dropzone context memory, Prophet scope and expiry.
- **Where:** additive fields on `models.py::MemoryEntry` (`expires_at`, `scope_rule_ids`,
  `scope_entities`, `origin_case_id`); filter at injection; usage from the CONTEXT audit row's
  `tool_input.memory` already parsed in `engine/case_rationale.py`; close dialog in
  `casedetail`; `pages/Memory.tsx`.
- **Effort:** M. **Value:** high.
- **Risks:** approved memory is TRUSTED context (#9), so keep approval by `memory:manage` and
  consider a distinct approver; use the analyst's words verbatim (no model rewrite, unlike
  Microsoft's lesson translation, which would put model text into trusted context).
- **Tests:** pending never injected as trusted; expired excluded; scope match deterministic;
  usage count from audit rows.

### R9. Feedback on steps, summary and next steps (this_round: false)
- **What:** thumbs up/down on each trace step, the AI assessment and the next steps, charted on
  Agent effectiveness. Pattern: Google TIN dashboard feedback split.
- **Where:** a KV namespace like `chat_feedback` (`stores/chat_feedback.py` pattern), a route in
  `api/routes_cases_collab.py`, charts in `pages/AgentEffectiveness.tsx`.
- **Effort:** S to M. **Value:** medium. **Risk:** never used for training or decisions (#3).

### R10. Global pause and resume of automatic investigations (this_round: false, pairs with R1)
- **What:** one audited switch, "Pause new AI investigations", that keeps every candidate as a
  `$0` candidate that drains when resumed. Pattern: Microsoft Pause and Run.
- **Where:** a `Preferences` flag checked at the forwarding gate (`engine/forwarding.py` and
  the matching gate in `engine/ingest.py`), shown in the R1 indicator.
- **Effort:** S to M. **Value:** medium.
- **Risks:** #4 (no skip, no duplicate on resume) and the per-tick cap; `decide()` untouched.

### R11. Approval-gated response actions and a Resolution Center (this_round: false)
- **What:** HITL actions (block an IP, disable an account, isolate a host) with a separate
  write credential, preflight, dry-run, audit-first receipts and rollback where supported; a
  per-case list of pending, approved and done actions. Pattern: XSIAM Resolution Center,
  AgentiX sign-off, CrowdStrike off by default, Radiant and Prophet approval.
- **Where:** `ToolTier.requires_approval` in `tools/base.py`, `stores/proposals.py`, a new
  connector write SPI. Already P1 in `ROADMAP.md` section F.
- **Effort:** L. **Value:** high. **Risks:** the biggest safety surface; never driven by model
  output or runbook text (#3).

### R12. Read-only MCP server and scoped API keys (this_round: false)
- **What:** expose the read-only chat tools and case reads over MCP with per-key RBAC. Pattern:
  Command Zero, Security Copilot MCP and Graph APIs, Swimlane, Tracecat.
- **Where:** `tools/base.py`, `agents/chat_tools/`, `api/deps.py`. Note: `ROADMAP.md` section C
  lists an MCP transport as open while section G lists "an MCP server" as deliberately not
  built; the owner must resolve this before work starts.
- **Effort:** L. **Value:** high. **Risks:** all MCP input is untrusted (#9); keys must be
  revocable and audited (#2).

### R13. Attack storyline on campaigns (this_round: false)
- **What:** a campaign view with cases on MITRE tactic lanes over time, shared entities and
  blast radius, computed deterministically. Pattern: Elastic Attack Chain, D3 attack path,
  XSIAM narrative.
- **Where:** `engine/campaigns.py`, `Case.mitre`, `threat/mitre_techniques.json`,
  `pages/Campaigns.tsx`; any summary through `engine/report_digest.py` (#7).
- **Effort:** M. **Value:** medium to high.

### R14. Field anonymization before the model (this_round: false)
- **What:** per-field pseudonymization (usernames, hostnames, emails) in prompts with a
  reversible per-investigation map shown only in the Console. Pattern: Elastic anonymization
  settings. Valuable for organisations that cannot send identities to a cloud model.
- **Where:** `evidence_fields.py` projection, `agents/prompts.py::render_cluster`, chat tool
  observations.
- **Effort:** M to L. **Value:** high for regulated users. **Risks:** breaks enrichment if
  applied before lookups; must stay inside the fence (#9).

### R15. Autonomy per rule and investigation criteria (this_round: false)
- **What:** in the rule sheet, show and edit one rule's autonomy: investigate or not, auto-close
  false positives or not, review sample, analyst policy; plus an optional settle delay before an
  automatic run. Pattern: Legion modes, D3 per alert type, Google criteria and timing.
- **Where:** `RuleSheet.tsx`, `api/routes_rule_summary.py`, existing `AutoClosePolicy`, analyst
  policies and feed `auto_investigate`; the delay in the forwarding gate.
- **Effort:** M. **Value:** medium. **Risks:** #3 policy stays in `decide()` inputs only; #4
  for delayed candidates.

### R16. Model leaderboard from the replay harness (this_round: false)
- **What:** compare models on captured fixtures (agreement, cost, latency) using the existing
  replay Job; never a composite score. Pattern: Simbian leaderboard.
- **Where:** `engine/replay/`, `pages/Models.tsx`. **Effort:** M. **Value:** medium.

### R17. Scheduled digests and ticketing (this_round: false)
- **What:** scheduled shift and campaign digests through existing channels (Elastic scheduled
  discoveries, Purple AI summaries) and two-way Jira or ServiceNow tickets (Torq, Prophet).
- **Where:** `agents/standup.py`, `notifications/dispatch.py`; a ticketing channel. Both are in
  `ROADMAP.md` already. **Effort:** M each. **Value:** medium.

### R18. Case report as PDF (this_round: false, small)
- **What:** a print-styled case report with a "Save as PDF" action, next to the existing JSON
  and Markdown export (`GET /api/cases/{id}/export`). Pattern: Dropzone PDF and JSON export.
- **Effort:** S. **Value:** medium.

## 5. What not to copy
- Model-written lessons placed directly into trusted context (Microsoft translates feedback
  with a model; here that would break #9 unless a person approves the exact text).
- Autonomous response by default (7AI positioning) or browser recording of analysts (Legion):
  both conflict with this product's read-only consumer stance (#12) and privacy expectations.
- Headline accuracy percentages: every figure found was vendor-measured. Agentic SOC's honest
  "insufficient evidence" and Wilson interval reporting is a better stance.
- Per-alert or per-investigation pricing logic: the product is free and shows real model cost
  per call instead.

## 6. Journal entry (for the orchestrator)

```
### 2026-11-24 00:00Z - research agent (competitors) - AI SOC competitor study for Round 16
- Context: Round 16 discovery; competitor research on 22 AI and agentic SOC products plus open-source peers.
- Did: read-only study of vendor docs and press; compared with README, ROADMAP, CHANGELOG Round 15 and code; wrote research/competitors.md with 18 ranked recommendations (7 for this round) and 3 code defects (hardcoded risk weights in help text, no stored weight snapshot, forwarding explainer route with no Console consumer).
- Tests: none run (read-only research).
- Status: done.
- Next: SPEC author to merge R1 to R7 with the operator's asks; owner to choose a license (R7) and settle the MCP contradiction in ROADMAP (R12).
```
