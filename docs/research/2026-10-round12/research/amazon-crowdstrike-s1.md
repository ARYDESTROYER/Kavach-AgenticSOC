# Competitor research: Amazon/AWS, CrowdStrike Charlotte AI, SentinelOne Purple AI

Research date: 2026-10-10. Scope: how these vendors build AI security assistants and agents, compared
with the Agentic SOC chat (read-only, RBAC-scoped ReAct loop over log/case/metrics/intel/ops/help
tools, streamed answers with interactive blocks, per-user history, reports library, token meter).

**Evidence grades** used throughout:
- **[DOC]** vendor product documentation (behavior is specified).
- **[BLOG]** vendor technical blog or AWS News/Security blog (describes shipped behavior, sometimes loosely).
- **[PR]** press release or marketing page (claims; often no UX detail).
- **[3P]** third-party write-up, trade press, or reviews.

Accuracy and speed figures are vendor claims unless stated otherwise.

---

## 1. Amazon / AWS

AWS has no single "security copilot". Its AI security work is spread across services:
1. a general console chat (Amazon Q Developer) that can read your resources,
2. one-shot generative summaries embedded in security consoles (Detective, GuardDuty),
3. asynchronous investigation agents (Security Incident Response, GuardDuty investigation agent,
   CloudWatch investigations, DevOps Agent),
4. read-only MCP servers that bring security data into external assistants (Security Hub MCP App).

### 1.1 Amazon Q Developer chat in the AWS console [DOC]

Sources: <https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-with-q.html>,
<https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-actions.html>,
<https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-artifacts.html>,
<https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-ops.html>,
<https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-network-security.html>

| Capability | Invocation | Output / UI | Limits and notes |
|---|---|---|---|
| Console chat panel | Q icon in the unified navigation bar | Side panel. A **maximize icon switches it to full screen**, a resize icon toggles back, and a **draggable divider** sets the width. Context survives navigation across console pages and tabs. | Region defaults to the console Region (shown under the gear icon). |
| Conversation management | **+** starts a new chat. A **clock icon** opens a Conversations pop-up (switch or delete). The title is editable, otherwise auto-generated from the first questions. | Every conversation is auto-saved. | **Up to 1,000 saved conversations. Inactive conversations are deleted after 90 days, and messages older than 90 days are deleted even in active ones.** |
| Answer chrome | Automatic | Each answer has a **Sources** section linking its references, a **copy** icon, and **thumbs up/down**. | — |
| Prompt library | **Book icon** in the panel header. Suggested prompts also appear on a new conversation. | Library can be filtered by response type ("table or visualization"). | — |
| Resource Q&A ("chat about your resources") | Natural language, e.g. "List RDS databases without CloudWatch alarms", "Which instances across all regions are open to the world?" | Q calls get/list/describe APIs through Cloud Control. For complex questions it "creates dynamic, multi-step plans that **explain the reasoning behind the actions it's taking**". If the plan fails it tries another approach or **asks you for the missing information**. | **Uses only the caller's IAM permissions** ("will never access resources that your IAM identity doesn't have access to"). Normal API fees apply. **Cannot answer questions about data stored in resources, or about account security, identity, credentials or cryptography.** |
| Conversation-scoped parameters | Implicit | If a question names no Region, Q uses "a Region previously specified in your conversation if applicable", otherwise the console Region. | — |
| **Q artifacts** (rich visualizations) | Automatic when "a visual interface would be helpful" | Opens a **separate panel next to the chat** with tables, charts, dashboards, time-series graphs, key-value pairs and diagnostic views. You can **paginate, filter and sort inside the answer**. Resource tables carry **deep links to each resource's console page**. | Read-only. Visualization data is stored in us-east-1. |
| Ops/telemetry chat | "Why is my alarm X firing?", "Investigate anomalies related to S3 between X and Y" | Health checks, alarm root cause, Application Signals SLOs, charts. May ask for resource names and time ranges. | Hands off to CloudWatch investigations (1.5). |
| Network-security chat (preview) | "Identify my top network security findings", "Do I have any resources without WAF protection?" | Resource-specific findings, **detailed remediation steps**, links into the console. | Preview; requires Shield network security director. |
| Chat apps | Slack and Teams via Amazon Q Developer in chat applications | Same chat; receives Security Hub and GuardDuty notifications. | — |

Takeaway: the closest analog to our chat is a **general ops copilot with security exclusions**. AWS
pushes deep security reasoning into dedicated investigation agents rather than the chat.

### 1.2 Amazon Detective finding-group summaries [DOC]

Source: <https://docs.aws.amazon.com/detective/latest/userguide/finding-group-summary.html>

- **What it does.** On by default and at no extra cost, it generates a natural-language summary of a
  finding group (GuardDuty and Inspector findings grouped by Detective) using Bedrock-hosted models.
- **UI.** Finding groups → choose a group → **Summary pane**. The pane shows a succinct title, a
  summary of the resources involved, curated resource information, and "an analysis of the top
  threat events in the finding group, which you can then investigate further."
- **Actions.** A **copy icon** puts the summary on the clipboard "to add … to your notes or a
  ticketing system". **Thumbs up/down** feedback "is not used for model tuning … only to help …
  the prompts".
- **Disclaimer.** Summaries "may … not always provide completely accurate information."
- **Controls.** Users can opt out in Preferences. IAM can deny `detective:InvokeAssistant`.
  Cross-Region inference starts 2026-02-16.

Pattern: **one-click, embedded, copy-to-ticket summaries** with an explicit accuracy caveat and a
feedback loop.

### 1.3 GuardDuty Extended Threat Detection (attack sequences) [BLOG]/[DOC]

Sources: <https://aws.amazon.com/blogs/aws/amazon-guardduty-adds-extended-threat-detection-for-amazon-ec2-and-amazon-ecs>,
<https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-guardduty-extended-threat-detection/>

- Correlates signals across data sources, resources and time into **one critical-severity "attack
  sequence" finding**.
- Each finding has a **natural-language summary**, an **events timeline**, contributing signals, a
  graph of how the affected resources relate, **MITRE ATT&CK tactics and techniques**, and
  remediation recommendations.
- Expanded to EC2 instance groups and ECS clusters in December 2025. On by default, no extra cost.

### 1.4 GuardDuty investigation agent (public preview, 2026-07-20) [BLOG]

Sources: <https://aws.amazon.com/blogs/security/introducing-the-amazon-guardduty-investigation-agent-on-demand-ai-powered-threat-assessment/>,
<https://www.helpnetsecurity.com/2026/07/21/amazon-guardduty-investigation-agent-on-demand/>

| Aspect | Detail |
|---|---|
| Invocation | Console: Investigations → **Initiate Investigation**. Also CLI/SDK (`CreateInvestigation`/`GetInvestigation`/`ListInvestigations`) and the AWS MCP server from Kiro or Claude. |
| Prompt | A free-form natural-language trigger prompt of **up to 2,048 characters** |
| Scope | One finding ID, one account, or the whole organization |
| Output | **Risk level** (Info/Low/Medium/High/Critical), **confidence** (Unknown/Low/Medium/High), Summary, Investigation Details, **MITRE ATT&CK mapping**, **resource mapping**, Threat Assessment, and **Recommended Actions (may include AWS CLI commands)** |
| Execution | **Asynchronous** job with status RUNNING/COMPLETED/FAILED (poll about every 30 s). Typical runtime is 2–5 min for an account and 10–12 min for a finding. |
| Quotas | **10 investigations per account per day**, 100 cumulative in preview. Failed runs don't count. Free in preview. |
| RBAC | Admin accounts can create investigations. Member accounts can only view their own. |
| Transparency | The post describes outputs but does not show the agent's queries. It notes non-determinism. |

### 1.5 CloudWatch investigations (AIOps, with an Amazon Q chat entry point) [DOC]

Source: <https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Investigations.html>

- **Starting a run.** From a console view, from **a chat prompt with Amazon Q**, or from an alarm action.
- **Investigation feed.** Shows observations, suggestions and **root-cause hypotheses**, with a
  visual graph when multiple resources are involved, plus natural-language explanations.
- **Accept/discard.** For each suggestion "you decide whether to add it to the investigation
  findings or to discard it". This steers the agent toward the root cause.
- **Notes.** You can add comments to findings for reporting and audit.
- **Sharing and lifecycle.** Investigations can be shared with team members. You can end, archive,
  or **reopen** one.
- **Reports.** "generate a comprehensive investigation report that automatically captures all
  investigation findings, timeline events, and recommended actions".
- **Actions.** Can suggest Systems Manager runbooks that a human executes.
- **Guarantees.** Runs with the signed-in user's permissions, creates no resources, and logs every
  action to CloudTrail.
- **Limits.** **2 concurrent active investigations per account and 150 enhanced investigations per month.**

### 1.6 AWS Security Incident Response investigative agent (GA 2025-11-21) [DOC]/[BLOG]

Sources: <https://docs.aws.amazon.com/security-ir/latest/userguide/ai-investigative-agent.html>,
<https://aws.amazon.com/about-aws/whats-new/2025/11/aws-security-incident-response-agentic-ai-powered-investigation>,
<https://aws.amazon.com/blogs/security/accelerate-investigations-with-aws-security-incident-response-ai-powered-capabilities>,
<https://docs.aws.amazon.com/security-ir/latest/userguide/investigative-agent-processing.html>

- **Trigger.** Starts automatically when an AWS-supported case is created (not for self-managed
  cases). It runs in parallel with AWS IR engineers.
- **Clarifying questions first (optional).** It may ask for affected account IDs, IAM principals,
  resource identifiers and the timeframe. **"If no answer is provided within 10 minutes, the
  investigation starts automatically."** It skips the questions when the case already has enough
  context.
- **Evidence.** Queries CloudTrail, IAM, EC2 APIs and Cost Explorer through a read-only
  service-linked role. Every action is logged in CloudTrail under `AWSServiceRoleForSupport`.
- **Natural-language queries.** Analysts can say "unusual API calls from IP address X" and the agent
  "translates that into the technical queries needed" [BLOG].
- **Output.** An **Investigation tab** shows status (In Progress / Completed), a summary with findings,
  timeline and recommendations, and a technical-findings tab with an event timeline. The blog
  describes the summary sections: overview, critical findings, exposure pattern, observed activity
  and timeframe, affected resources, and **"limiting factors"**. **The summary is also posted
  automatically as a comment in the case's Communication section.**
- **Data handling.** Processing is transient on Bedrock (global Region). Customer data is not used
  for training. The case and its recommendations remain under human ownership (Responsible AI
  disclosure).

### 1.7 Security Hub (new, GA 2025-12-02) and the Security Hub MCP App (preview, 2026-07-27)

Sources: <https://aws.amazon.com/blogs/aws/aws-security-hub-now-generally-available-with-near-real-time-analytics-and-risk-prioritization/> [BLOG],
<https://aws.amazon.com/about-aws/whats-new/2026/07/aws-security-hub-mcp-app/> [PR],
<https://www.helpnetsecurity.com/2026/07/15/aws-security-hub-ai-workload-protection/> [3P]

- **Security Hub itself has no chat or generative summaries.** It correlates GuardDuty, Inspector,
  Macie and CSPM findings into **exposure findings** with near-real-time updates. It also offers:
  - a **"Potential attack path" graph tab**,
  - remediation ordered by risk reduction,
  - a summary dashboard with trend widgets covering 5 days to 1 year,
  - OCSF-formatted findings,
  - automation rules that create Jira or ServiceNow tickets.
- **Security Hub MCP App (preview).** A local, **read-only** MCP server that brings exposure findings
  into Claude Desktop. **"Each tool call returns a text summary for the AI agent and an interactive
  visualization for the user to verify in the same conversation."** It covers top exposures, attack
  and network paths, correlated findings and remediation. No additional cost.
- **Pattern.** AWS is exposing security data to *external* assistants through read-only MCP, pairing
  text for the model with a visual for the human.

### 1.8 Other AWS items (brief)

- **Security Lake + Bedrock chatbot (reference architecture, 2025-05-01) [BLOG].** A Bedrock agent
  with two knowledge bases: IR playbooks, and Security Lake table schemas used for NL→SQL on Athena.
  Example: "Which AWS accounts have the most security findings for EC2 instances in the last 7
  days?" The post does not say whether the SQL is shown. It advises adding a time window for better
  queries. This is a do-it-yourself pattern, not a product.
  <https://aws.amazon.com/blogs/security/use-an-amazon-bedrock-powered-chatbot-with-amazon-security-lake-to-help-investigate-incidents>
- **AWS Security Agent** (preview December 2025; on-demand pentest GA 2026-03-31) [PR]. A "frontier
  agent" for design and code security reviews and context-aware penetration testing. It is
  AppSec-focused, not SOC chat. <https://aws.amazon.com/about-aws/whats-new/2026/03/aws-security-agent-ondemand-penetration>
- **AWS DevOps Agent** (GA 2026-03-31) [BLOG]. Starts from alerts (CloudWatch, PagerDuty, Datadog,
  ServiceNow), maps topology, proposes root cause plus a mitigation plan with validation and
  rollback steps, and builds "learned investigation skills" from past investigations.
  <https://aws.amazon.com/blogs/aws/aws-devops-agent-helps-you-accelerate-incident-response-and-improve-system-reliability-preview>
- **Amazon Q Developer security in the IDE** [DOC]. `/review` and auto-review run SAST, secrets
  detection, IaC and SCA checks. Each finding has a description, a recommended fix, and sometimes a
  one-click fix applied in place. <https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-reviews.html>.
  The 2026-05-05 security blog shows **Security Hub triage through Kiro plus AWS MCP servers**
  ("Show me all critical security findings from Security Hub in my production account"), not
  through the console chat. <https://aws.amazon.com/blogs/security/five-ways-to-use-kiro-and-amazon-q-to-strengthen-your-security-posture/>

---

## 2. CrowdStrike Charlotte AI

Sources:
- <https://www.crowdstrike.com/en-us/platform/charlotte-ai/> [PR]
- Charlotte AI data sheets (2026 edition [PR], 2024 edition [PR]): <https://www.crowdstrike.com/content/dam/crowdstrike/marketing/en-us/documents/pdfs/data-sheets/crowdstrike-charlotte-ai-datasheet.pdf>, <https://www.crowdstrike.com/wp-content/uploads/2024/09/crowdstrike-charlotte-ai-datasheet.pdf>
- AWS APN blog, 2024-11-01 [BLOG]: <https://aws.amazon.com/blogs/apn/crowdstrike-charlotte-ai-generative-ai-on-aws/>
- FAQ [PR]: <https://www.crowdstrike.com/products/charlotte-ai/faq>

### 2.1 Conversational Charlotte (GA since 2024)

| Capability | Invocation | Output / UI | Evidence |
|---|---|---|---|
| NL conversations over Falcon modules | Falcon console **global navigation**, plus the Charlotte AI module | Plain-language answers grounded in Falcon telemetry: detections, vulnerabilities, adversary profiles, decoded commands, product how-to | [PR] datasheet |
| **"Show response details"** toggle | On **every question** | Shows "the underlying data source that Charlotte AI used to assemble the answer" and the **filters applied**. Example: "Which hosts have TeamViewer installed?" A promo video says "all of the underlying data sources and API calls … are available to view". | [BLOG] APN 2024; datasheet: "Traceable answers … inspectable response details" |
| Follow-up with context | Ask again in the same conversation | "Drill deeper with follow-up questions while preserving conversation context from one prompt to the next" | [PR] 2024 datasheet |
| Query and script writing | "Write a query that …" | Generates a query (CQL / Event Search) or a Real Time Response script **for review**, and **explains how it interpreted the request** | [BLOG] APN; [3P] PeerSpot |
| **Promptbooks** | Saved, shareable prompts | "Standardize prompt engineering … with shareable promptbooks to collect, share, and reuse proven queries". Also used to "produce structured output on demand" such as incident reports and executive summaries. | [PR] datasheet, FAQ |
| Embedded one-click AI | Inside other modules | Command-line explanations (Insight XDR), CVE explanations (Exposure Mgmt), Cloud Asset Search, Live Asset Querying (Falcon for IT), and Incident Investigations in Next-Gen SIEM ("Investigate with Charlotte AI" produces a threat summary and an attack graph) | [PR]/[BLOG] |
| Summaries for reporting | Ask, or use a promptbook | "Generate easy-to-understand summaries for reporting" | [PR] |
| Safety | — | Analysts "review and authorize all actions or scripts". RBAC. "Every response is grounded in validated Falcon platform data". ISO/IEC 42001. FedRAMP High (as of March 2026) for NL conversations, Detection Triage, Response Agent and LLM-Completion. | [PR] |
| Credits | — | Qualifying customers get **50 free AI credits per month**. AgentWorks has **credit caps**. | [PR] FAQ |

### 2.2 Agentic Charlotte (2025–2026)

- **Detection Triage Agent** (GA 2025-02).
  - Per detection it outputs **priority, TP/FP verdict, confidence, recommended action, and a
    reasoning explanation**.
  - It runs under "customer-defined bounded autonomy". Fusion SOAR can act on the output, for
    example adding the summary to a ticket or routing by risk.
  - The ">98% accuracy" claim is defined in the footnote as *agreement with Falcon Complete MDR
    analysts' decisions*.
  - Sources: <https://www.crowdstrike.com/en-us/blog/agentic-ai-innovation-in-cybersecurity-charlotte-ai-detection-triage/> [BLOG], platform page [PR].
- **Response Agent / Agentic Response** (RSAC 2025). Drives investigations by "**auto-generating and
  answering guiding questions**", i.e. a visible Q→A chain an analyst would follow. The datasheet
  figure: "drives investigations on the user's behalf, asking and answering successive questions."
  [PR] <https://www.crowdstrike.com/en-us/press-releases/crowdstrike-unleashes-agentic-outcome-driven-ai-innovations/>
- **Agentic Workflows.** An "LLM-Completion" action inside Falcon Fusion SOAR, for example deciding
  whether to contain under company policy, then drafting audience-specific communications with
  translation. [PR]
- **Mission-ready agents** (Fal.Con 2025-09-16): Exposure Prioritization, Malware Analysis (generates
  YARA), Hunt, **Search Analysis** ("summarizes and interprets query results in seconds"), **Correlation
  Rule Generation**, Data Transformation, and **Workflow Generation** (NL→Fusion workflow). [PR]
  <https://www.crowdstrike.com/en-us/press-releases/crowdstrike-unleashes-agentic-security-workforce-to-transform-security-operations>
- **AgentWorks** (no-code custom agents). You define instructions, knowledge files, outputs,
  authorized tools and activation conditions. Governance includes **role-based permissions, execution
  traces, audit logs, credit caps, version history with rollback, and configurable approvals**. By
  default, prebuilt agents only generate information, summaries and recommendations; "Charlotte AI
  does not take automated response actions by default." [PR] platform page and FAQ. The MCP module
  exposes execution-trace spans (LLM calls, agent steps, cost) for 90 days. [DOC]
  <https://developer.crowdstrike.com/falcon-mcp/modules/agentworks/>
- **Fal.Con 2026** (2026-09-02, [BLOG] <https://www.crowdstrike.com/en-us/blog/crowdstrike-delivers-next-evolution-of-agentic-soc/>):
  - **Agentic investigations in Next-Gen SIEM (pre-beta).** An orchestrator "summons specialist agents"
    that run in parallel per domain and converge on one verdict; the next step is close or escalate.
  - **Shared memory** of decisions and corrections across agents.
  - **Unified Agentic SOAR workspace (public preview).**
  - **Bring-your-own OpenAI/Anthropic model (GA).**
  - **CrowdStrike-managed MCP server (GA).**
  - **Agentic Recon (public preview)** turns NL questions into targeted queries.

Marketing versus documented: "machine speed", the "70%/90%" reductions and ">98%" are claims.
Documented behavior is that answers are traceable through response details, actions are opt-in and
approval-gated, and RBAC applies.

---

## 3. SentinelOne Purple AI

Sources:
- Launch blog, 2024-04-08 [BLOG]: <https://www.sentinelone.com/blog/transforming-the-soc-with-purple-ai/>
- GA press release, 2024-04-09 [PR]: <https://www.sentinelone.com/press/sentinelone-revolutionizes-cybersecurity-with-purple-ai/>
- Preview blog, updated 2024-09 [BLOG]: <https://www.sentinelone.com/blog/purple-ai-empowering-cybersecurity-analysts-with-ai-driven-threat-hunting-analysis-response/>
- Datasheet, 2025-06 [PR]: <https://www.eplus.com/content/dam/assets/eplus/documents/partners/sentinelone/sentinelone-datasheet-purple-ai-2.pdf>
- N-able GA note, 2025-09 [3P]: <https://status.n-able.com/2025/09/17/sentinelone-purple-ai-is-now-generally-available-conversational-threat-hunting-for-every-soc/>

### 3.1 Conversational Purple (GA April 2024)

| Capability | Invocation | Output / UI | Evidence |
|---|---|---|---|
| NL → **PowerQuery** | Plain question ("Am I being targeted by FIN12?", "Are there any ec2 instances running xmrig?", "Show me suspicious PowerShell activity from last 24 hours and summarize the top 3 hosts") | Translates to PowerQuery "within seconds" and runs it on native and third-party (OCSF) data. **"SOC teams can easily view query translations for verification and analyst training."** | [BLOG] |
| Result summaries | Automatic | Hunts return "**a table of results along with context-aware insights**". A customer quote describes results as "a narrative and a table". Event questions get a narrative of the behavior, its suspicion level and related entities. Datasheet tiers list **Alert Summaries, Event Summaries, Result Summaries**. | [BLOG]/[PR] |
| **Suggested follow-up questions** | Shown after each answer | "Suggested follow up questions and best next actions are also provided". Contextual next-step suggestions during guided investigations. | [BLOG]/[PR] |
| **Threat Hunting Quick Starts** | **One-click** library of pre-built prompts, including MITRE-technique hunts (e.g. T1140) | Launches the hunt as an NL question → query → results → follow-ups | [PR]/[BLOG] |
| **Investigation notebooks** | Auto-captured as you work | "Dedicated AI workbench with **shared or private notebooks that auto-save** and maintain full investigation context". "**Self-documenting**" with "multi-lingual support and fine-grained access controls". Shared and **exportable**. Notebooks store "hunts, pivots, and findings as reusable artifacts". | [PR]/[3P] |
| Auto-generated comms | From the investigation | "**auto-generated emails**", "post-investigation summaries and draft follow-up emails and reports" | [PR]/[3P] |
| In-conversation response actions | Button in the answer | "With a single click … trigger one or multiple actions, **while continuing the conversation**". Examples: clear user session, suspend Okta account, force password reset, network-quarantine endpoints. | [BLOG] |
| Multilingual | Ask in any language | "Questions can be asked in any language" | [BLOG] |
| Purple AI for Support | Product/support Q&A | Listed in the datasheet tiers | [PR] |
| Alert enrichment | In the alert view | "**Community Verdict**" and "**Similar Alerts**" (AI similarity analysis) | [PR]/[3P] |

### 3.2 Agentic Purple

- **Athena release** (RSAC 2025-04-29) [BLOG]/[PR]
  (<https://www.sentinelone.com/blog/the-purple-ai-athena-release>):
  - **Auto-Triage (GA).** Uses similarity to past alerts and community handling; shows how
    community/MDR experts handled similar alerts; gives a likelihood that the alert is a true
    positive.
  - **Auto-Investigations.** Triggered by a user or run autonomously. Produces a narrative linking
    the observations, whether an intrusion occurred, recommended actions, and "**summaries of results
    and steps taken**". It can **propose a Hyperautomation workflow** for similar future alerts, and
    can recommend a custom detection rule.
  - **Third-party data.** One-click Splunk connection; querying over OCSF-normalized data.
- **Auto Investigation GA** (RSAC 2026-03-23) [PR]
  (<https://www.sentinelone.com/press/sentinelone-unveils-new-ai-security-offerings-to-give-defenders-a-decisive-advantage/>):
  launches a complete agentic investigation in one click. It gathers cross-stack evidence, builds an
  **attack timeline in real time**, and returns an "explainable verdict" that can trigger
  Hyperautomation remediation under analyst-in-the-loop governance.
- **Agentic Investigation for all customers** (2026-06-17) [BLOG]/[PR]
  (<https://www.sentinelone.com/blog/frontier-ai-and-agentic-soc/>,
  <https://investors.sentinelone.com/press-releases/news-details/2026/SentinelOne-Opens-Purple-AI-Agentic-Investigation-to-All-Customers-Bringing-Frontier-AI-Directly-Into-the-SOC/default.aspx>):
  - **Zero-click trigger** when an EDR alert is flagged Critical and Malicious.
  - **The run is visible live in the Alerts view**: "retrieving context, running threat hunts,
    querying host telemetry, and building the case".
  - Verdicts are **True Positive / False Positive / Unknown**. "Every verdict carries a complete,
    auditable evidence chain"; analysts "can review each AI step".
  - Response can be one-click or policy-driven, and "Nothing fires outside the guardrails your team
    defines".
  - **Singularity Credits** with a "balance … visible in real time" and "built-in spending controls".
    Third-party reports also mention daily auto-trigger caps.
  - Uses multiple models: Claude, GPT and SentinelOne's "Ultraviolet".
- **Purple AI MCP server** (open source, **read-only**) [DOC]
  (<https://github.com/Sentinel-One/purple-mcp>). Tools include `purple_ai(query)`,
  `powerquery(query,start,end)`, alerts get/list/search/notes/history, vulnerabilities,
  misconfigurations, asset inventory, CVE search, and VirusTotal intel. Tokens are scoped to an
  account or site.

User feedback [3P] (PeerSpot, early 2026): summaries save time. Complaints: question understanding
needs improvement, it lacks deeper technical insight, and pricing is a concern.
<https://www.peerspot.com/products/purple-ai/leaderboard>

---

## 4. Cross-vendor patterns (what "standard" looks like in 2025–2026)

1. **Show your work.**
   - Charlotte has a per-answer "show response details" toggle (data sources, filters, API calls).
   - Purple shows the query translation "for verification and analyst training".
   - Amazon Q explains its multi-step plan.
   - The AWS agents log every action to CloudTrail.
   - S1 Agentic Investigation keeps an auditable evidence chain and streams its steps live.
   - *The standard is that each answer can be traced to the exact queries and sources behind it.*
2. **Suggested follow-ups after every answer** (Purple, Charlotte), plus **a curated prompt
   library** (Amazon Q book icon, Purple Quick Starts, Charlotte promptbooks that are *shareable
   team assets*).
3. **Ask for missing details instead of failing.**
   - Amazon Q prompts for missing details.
   - The SIR agent asks for accounts, principals, resources and timeframe, and auto-proceeds after
     10 minutes.
   - The AWS Security Lake reference notes that adding a time window gives better queries.
   - Amazon Q carries parameters (Region) forward from earlier in the conversation.
4. **A standard verdict object for investigations**:
   - GuardDuty: risk level, confidence enum, summary, details, MITRE, resources, recommended actions
     including CLI commands.
   - Charlotte: priority, TP/FP, confidence, reasoning, recommendation.
   - S1: TP/FP/Unknown plus evidence chain plus timeline.
   - AWS SIR: overview, critical findings, observed activity and timeframe, affected resources, and
     **limiting factors** (an honest statement of what could not be determined).
5. **Long investigations run as asynchronous jobs** with explicit status (GuardDuty
   RUNNING/COMPLETED/FAILED over 2–12 min; SIR In Progress/Completed). Results attach to the case:
   SIR posts the summary as a case comment, CloudWatch produces an investigation report.
6. **Rich, interactive artifacts beside the chat** (Amazon Q artifact panel with
   paginate/filter/sort and resource deep links; Security Hub MCP App "text for the model, a visual
   for the human"). **Full-screen chat and a resizable divider** are documented Amazon Q controls.
7. **Notebook / workbench persistence** (Purple shared or private auto-saving notebooks;
   CloudWatch investigations shareable and re-openable with notes; Amazon Q 1,000 saved
   conversations).
8. **One-click embedded AI next to data**: Detective summary pane with copy-to-ticket; Charlotte
   command-line and CVE explanations; "Investigate with Charlotte AI" on incidents; Purple
   alert/event summaries.
9. **Every answer has copy plus thumbs up/down** (Amazon Q, Detective). Feedback improves prompts,
   not the model.
10. **Read-only by default; actions are opt-in and human-approved.**
    - Charlotte: "does not take automated response actions by default".
    - Purple: actions are one-click buttons inside the conversation, within guardrails.
    - AWS: all agents read-only; runbooks and CLI commands are suggested for a human to run.
11. **Limits are cost/quota governance, not answer truncation.** No vendor documents cutting answers
    short. They bound *spend* and *volume* and make the balance visible:

    | Vendor | Documented limits |
    |---|---|
    | Charlotte | 50 credits/month free, credit caps per agent |
    | S1 | credits with a real-time balance, spending controls (daily auto-trigger caps per 3P) |
    | GuardDuty agent | 10/day, 2,048-character prompt |
    | CloudWatch investigations | 2 concurrent, 150/month |
    | Amazon Q | 1,000 conversations, 90-day retention |

12. **MCP exposure of read-only security tools** (Purple MCP, CrowdStrike managed MCP GA, Security Hub
    MCP App, GuardDuty agent via AWS MCP). This is the 2026 integration norm.
13. **Detection engineering from conversation**: Charlotte Correlation Rule Generation Agent; Purple
    recommends a custom detection rule and drafts a Hyperautomation workflow.

---

## 5. Gap analysis against the Agentic SOC chat, and recommendations

The Agentic SOC already covers a lot:
- ReAct over read-only tools, with live steps;
- interactive blocks (charts, KPIs, tables, timelines);
- per-user history and a reports library;
- a token meter, a Help Center corpus, RBAC per tool, and fencing (#9);
- `explain_decision`, `search_knowledge`, `lookup_indicator`, `mitre_lookup`, `audit_search`.

The gaps and recommendations below are ordered by value against effort. All of them stay inside the
non-negotiables: read-only, #3, #5, #6, #7, #9.

| # | Recommendation | Competitor precedent | Notes for our implementation |
|---|---|---|---|
| R1 | **Per-answer "How I got this" / response details**: for every tool step, show exact source(s), filter/query, time window, result count and coverage, with an **"Open in Logs/Cases"** deep link that reproduces the query | Charlotte toggle; Purple query translation; Amazon Q artifact deep links | Steps already exist. Make them complete, copyable and deep-linkable. Untrusted values stay fenced or monospace. |
| R2 | **Suggested follow-up chips** after each final answer (2–4, derived from the artifacts: pivot to entity, widen window, related cases, MITRE) | Purple, Charlotte | They can be deterministic ($0) from the artifact manifest. Clicking one sends a normal turn. |
| R3 | **Clarify instead of fail**: when the time window or entity is ambiguous, or a query returns zero results, answer with a short clarifying question plus one-click options (24h/7d/30d, pick a source), and **carry window/source/entity forward** across turns | Amazon Q (asks for missing info, reuses Region), AWS SIR agent (clarifying questions, auto-proceed) | Directly addresses "some queries with the agent don't even work". |
| R4 | **Prompt library / Quick Starts** (book icon): curated hunts tagged by MITRE technique and by response type (table/chart), plus **team-shareable saved prompts ("promptbooks")** | Amazon Q prompt library; Purple Quick Starts; Charlotte promptbooks | Store them per user/org in the existing KV pattern. No new index. |
| R5 | **Full-screen / maximized chat and a draggable divider** between conversation and report panel; chat fills the viewport when the nav is collapsed | Amazon Q maximize icon and divider | Matches the user's complaint about wasted space. Persist the width per viewer. |
| R6 | **Investigation brief block** (standard verdict object): risk level, confidence enum, summary, observed activity and timeframe, affected entities, MITRE, recommended next steps, **"limiting factors / what I couldn't check"** | GuardDuty agent, AWS SIR, Charlotte triage, S1 TP/FP/Unknown | The verdict is advisory. Close/escalate stays with `decide()` (#3). |
| R7 | **"Deep investigation" as a background Job** (status RUNNING/COMPLETED/FAILED in the Jobs inbox), with **the result posted to the case thread** and attachable to a report | GuardDuty agent async API; SIR posts the summary as a case comment; CloudWatch investigation report | Reuse the durable jobs runner and case_thread. This also addresses "continue where stopped": long work runs to completion instead of truncating. |
| R8 | **Interactive artifact controls**: sort, filter and paginate inside tables, an "open in side panel" maximize per block, and row deep links to the case/entity/log record | Amazon Q artifacts | Keep the existing caps, but put "View all" behind a full table view rather than truncating. |
| R9 | **Copy / thumbs up-down / "copy as ticket text"** per answer, with feedback stored for prompt tuning only | Amazon Q, Detective | Use an audit or feedback KV. Never train. |
| R10 | **Accept/discard pins**: pin a step or block as a "finding" into the report or case notes; discarded items are hidden | CloudWatch investigations | The report is the natural notebook. Add per-item notes. |
| R11 | **Auto-drafted stakeholder email / executive summary** from a report or conversation | Purple auto-emails, Charlotte promptbooks for exec summaries, CloudWatch reports | Reuse the existing report summary path (#7 digest). |
| R12 | **Embedded "Explain this"** on command lines, process trees, rule hits and CVEs anywhere in the console (opens chat prefilled) | Charlotte command-line and CVE explanations, Detective summary pane | Builds on "Ask about this". |
| R13 | **Similar cases / precedent** answers ("how were similar alerts closed?") | Purple Similar Alerts and Community Verdict, Charlotte triage | Reuse `engine/precedent.py` read-only. |
| R14 | **Proposed actions as links, never execution**: e.g. "Open case to acknowledge", "Draft a suppression rule (opens Rules editor, preview-decision)" | Purple in-chat actions, Charlotte approvals, AWS suggested runbooks | Keeps chat read-only. Actions route to existing HITL screens. |
| R15 | **Visible live agent activity** (an animated working indicator in the shell and rail, and step narration such as "querying 3 sources…") | S1 Agentic Investigation streams its steps in the Alerts view | Matches the user's "animating logo when the agent is working" request. |
| R16 | **Budget as governance, not truncation**: per-answer token caps and "continue where stopped" removed or raised for chat; a visible spend/budget balance kept as the backstop | Charlotte/S1 credits with caps; no vendor truncates answers | The operator explicitly asked for no chat token limits. Competitors bound spend, not answer length. |
| R17 | **Multilingual questions** answered in the user's language | Purple | Mostly prompt wording. |
| R18 | (Later) **Read-only MCP server** exposing the chat tool catalogue | Purple MCP, CrowdStrike MCP, Security Hub MCP App | AGENTS.md says 0.1.13 ships no MCP server, so treat this as roadmap only. |

### Limits evidence relevant to the "remove token limits" request

None of the researched vendors documents per-answer truncation or a "continue" button in their
security chat. Their documented bounds are:
- **volume and cost**: credits, daily or monthly investigation counts, concurrency;
- **input size**: GuardDuty's 2,048-character trigger prompt;
- **retention**: Amazon Q's 90 days.

Long-running reasoning moves to **asynchronous investigations with status** rather than being cut
off mid-answer. This supports removing per-message truncation in the chat and keeping only a
visible global spend backstop. (The existing `BudgetConfig` default is $10/day, block → NEEDS_HUMAN
for pipeline calls.)

---

## 6. Source list

AWS:
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-with-q.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-actions.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-artifacts.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-ops.html
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/chat-network-security.html
- https://docs.aws.amazon.com/awsconsolehelpdocs/latest/gsg/ask-q.html
- https://docs.aws.amazon.com/detective/latest/userguide/finding-group-summary.html
- https://aws.amazon.com/blogs/aws/amazon-guardduty-adds-extended-threat-detection-for-amazon-ec2-and-amazon-ecs
- https://aws.amazon.com/blogs/security/introducing-the-amazon-guardduty-investigation-agent-on-demand-ai-powered-threat-assessment/
- https://www.helpnetsecurity.com/2026/07/21/amazon-guardduty-investigation-agent-on-demand/
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Investigations.html
- https://docs.aws.amazon.com/security-ir/latest/userguide/ai-investigative-agent.html
- https://docs.aws.amazon.com/security-ir/latest/userguide/investigative-agent-processing.html
- https://aws.amazon.com/about-aws/whats-new/2025/11/aws-security-incident-response-agentic-ai-powered-investigation
- https://aws.amazon.com/blogs/security/accelerate-investigations-with-aws-security-incident-response-ai-powered-capabilities
- https://aws.amazon.com/blogs/aws/aws-security-hub-now-generally-available-with-near-real-time-analytics-and-risk-prioritization/
- https://aws.amazon.com/about-aws/whats-new/2026/07/aws-security-hub-mcp-app/
- https://www.helpnetsecurity.com/2026/07/15/aws-security-hub-ai-workload-protection/
- https://aws.amazon.com/blogs/security/use-an-amazon-bedrock-powered-chatbot-with-amazon-security-lake-to-help-investigate-incidents
- https://aws.amazon.com/about-aws/whats-new/2026/03/aws-security-agent-ondemand-penetration
- https://aws.amazon.com/blogs/aws/aws-devops-agent-helps-you-accelerate-incident-response-and-improve-system-reliability-preview
- https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-reviews.html
- https://aws.amazon.com/blogs/security/five-ways-to-use-kiro-and-amazon-q-to-strengthen-your-security-posture/

CrowdStrike:
- https://www.crowdstrike.com/en-us/platform/charlotte-ai/
- https://www.crowdstrike.com/products/charlotte-ai/faq
- https://www.crowdstrike.com/content/dam/crowdstrike/marketing/en-us/documents/pdfs/data-sheets/crowdstrike-charlotte-ai-datasheet.pdf
- https://www.crowdstrike.com/wp-content/uploads/2024/09/crowdstrike-charlotte-ai-datasheet.pdf
- https://aws.amazon.com/blogs/apn/crowdstrike-charlotte-ai-generative-ai-on-aws/
- https://www.crowdstrike.com/en-us/blog/agentic-ai-innovation-in-cybersecurity-charlotte-ai-detection-triage/
- https://www.crowdstrike.com/en-us/press-releases/crowdstrike-unleashes-agentic-outcome-driven-ai-innovations/
- https://www.crowdstrike.com/en-us/press-releases/crowdstrike-unleashes-agentic-security-workforce-to-transform-security-operations
- https://www.crowdstrike.com/en-us/blog/crowdstrike-delivers-next-evolution-of-agentic-soc/
- https://developer.crowdstrike.com/falcon-mcp/modules/agentworks/

SentinelOne:
- https://www.sentinelone.com/blog/transforming-the-soc-with-purple-ai/
- https://www.sentinelone.com/press/sentinelone-revolutionizes-cybersecurity-with-purple-ai/
- https://www.sentinelone.com/blog/purple-ai-empowering-cybersecurity-analysts-with-ai-driven-threat-hunting-analysis-response/
- https://www.sentinelone.com/blog/the-purple-ai-athena-release
- https://www.sentinelone.com/press/sentinelone-unveils-new-ai-security-offerings-to-give-defenders-a-decisive-advantage/
- https://www.sentinelone.com/blog/frontier-ai-and-agentic-soc/
- https://investors.sentinelone.com/press-releases/news-details/2026/SentinelOne-Opens-Purple-AI-Agentic-Investigation-to-All-Customers-Bringing-Frontier-AI-Directly-Into-the-SOC/default.aspx
- https://www.techzine.eu/news/security/142237/sentinelone-launches-purple-ai-agentic-investigation-for-customers/
- https://www.eplus.com/content/dam/assets/eplus/documents/partners/sentinelone/sentinelone-datasheet-purple-ai-2.pdf
- https://status.n-able.com/2025/09/17/sentinelone-purple-ai-is-now-generally-available-conversational-threat-hunting-for-every-soc/
- https://github.com/Sentinel-One/purple-mcp
- https://www.peerspot.com/products/purple-ai/leaderboard
