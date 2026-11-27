# Palo Alto Networks and Qualys: AI assistant and chat capabilities

Research date: 2026-10-10. Scope: Palo Alto Networks (Cortex XSIAM and Cortex AgentiX Agentic
Assistant, the legacy Cortex Assistant (formerly "Cortex Copilot"), Help Center agent, XSOAR,
Prisma Cloud Copilot, Strata Copilot, the Precision AI brand) and Qualys (Enterprise TruRisk
Management (ETM) Cyber Risk AI Assistant "ROCky", Cyber Risk AI Agents including Agent Val, VMDR
and QQL). Purpose: competitive input for the Agentic SOC chat (read-only, RBAC-scoped ReAct
assistant with streamed answers, interactive blocks, per-user history, a reports library and a
token meter).

How to read the evidence labels:

- **[DOC]** means vendor product documentation that describes shipped behaviour. This is the
  strongest evidence.
- **[RN]** means vendor release notes.
- **[MKT]** means a press release, blog or marketing page. Treat numbers and "industry first"
  claims as unverified.
- **[AI-ANS]** means an answer from the vendor's own documentation search ("ask") endpoint. I used
  it only to confirm that something is *not* documented, and the underlying pages are cited too.

Most Palo Alto pages were read in full as Markdown (`.md` variants of cortex-docs pages). The
Qualys pages were read in full as HTML from docs.qualys.com. Reference keys such as [P7] or [Q3]
are listed in section 9.

---

## 0. Summary for Agentic SOC

1. **Palo Alto's current product is the Cortex Agentic Assistant** in XSIAM, AgentiX, Cortex
   Cloud and XDR. It is a multi-agent chat: you pick an agent (Case Investigation, Threat Intel,
   Help Center, IT, Email, Endpoint, Network, Exposure, Cloud Posture, AppSec, Automation
   Engineer), and the agent builds a visible *Plan* of actions.
   - Read actions run directly. "Sensitive" actions need an explicit Approve or Deny.
   - The assistant generates and runs XQL from natural language, draws any platform chart in the
     chat and lets you save it to the dashboard Widget Library.
   - It auto-loads case context and regenerates AI case titles and summaries.
   - It keeps per-user history for 186 days and logs every agent action to an XQL-queryable audit
     dataset.
   - Sources: [P1] [P7] [P11] [P12] [P13] [P15] [P3].
2. **Palo Alto publishes no token, message or turn limits for chat.** The documented runtime bound
   is an action timeout: "Actions exceeding five minutes result in an error" [P7].
   - Agent and LLM usage is *shown* on the Compute Units page as "evaluated compute cost" but is
     **non-billable** and does not reduce quotas [P32] [P39].
   - Large results are handled as a **preview in chat plus "open the full dataset on the XQL
     page"** [P11]. They are not silently truncated.
   - Max-output-token settings exist only for reusable *AI Prompts* used in playbooks and actions
     (default 2,500, adjustable) [P28].
   - This supports the operator's "no chat token limits" request: show spend in the meter, but do
     not cap answers.
3. **Qualys ROCky is a narrower, prompt-library-led assistant** over ETM risk data.
   - It offers 5 one-click quick-start queries, a Prompt Library with 5 categories, free text,
     voice input and New Chat.
   - Per-user private history auto-saves, and you can replay, continue and copy past chats.
   - It streams intermediate steps. Since ETM 1.12 (2026-08-03), "Watch ROCky Think" lets the user
     open a tool call (name, input, output, endpoint, status, timestamp), **retry a failed step**,
     **ask for an explanation of a step** or trigger an action from it.
   - Thumbs up or down feedback is available.
   - The docs publish a list of 49 "supported prompts" and 31 query tokens, which points to a
     grammar-constrained NL-to-query layer.
   - Sources: [Q1] [Q3] [Q5] [Q10] [Q11].
4. **Qualys "agents" are task-based, not chat-based.** You hire agents (Sid, Nyra, Sophia, Sara,
   Insta, Val) from a Marketplace, then assign scheduled tasks with a scope, triggers and output
   actions. Outputs include an exposure summary, a prioritization plan, a patch job draft and an
   email.
   - Agent Val validates exploitability and keeps a human approval step for patching and risk
     acceptance [Q7] [Q12] [Q13] [Q14].
   - I found **no Qualys product named "QAGENT"**. "Qualys Cloud Agent" is the endpoint sensor,
     not an AI assistant (see section 6.5).
5. **Prisma Cloud Copilot** (now folded into Cortex Cloud) has these documented features [P46]–[P50]:
   - Favorites (star a prompt) and Rename or Remove on conversations.
   - Text-to-RQL, with the LLM only translating. A local parser validates the query and runs it
     locally, so data does not go to the LLM.
   - Masked summarization for follow-ups.
   - Docs Q&A and support-case creation with screenshots and recordings.
6. **Ideas worth copying** are expanded in section 8:
   - An agent or mode picker with up to 4 conversation starters each.
   - Time-bucketed history (Today, Yesterday, Last 7 days, Older).
   - An expandable plan or step view with JSON artifacts, retry and "explain this step".
   - Chart edit-by-follow-up and "Save to dashboard".
   - Inline preview plus "open full result" instead of truncation.
   - Auto-attached case context with per-case chat resume.
   - Executive versus technical summary toggles, "Ask AI" chips on entities and a categorized
     prompt library with favorites.
   - A docs-grounded Help agent with live diagnostics, a jump-to-end anchor on long answers,
     thumbs feedback and a per-chat model tier selector.

---

## 1. Product map and naming (current as of October 2026)

| Vendor surface | What it is now | Status and evidence |
|---|---|---|
| **Cortex Agentic Assistant** (XSIAM, AgentiX, Cortex Cloud, XDR 5.x) | LLM multi-agent chat with plans, actions, approvals, history and Slack | Disabled by default. Admin enables it at Settings → Configurations → General → Server Settings → AI Configuration. Region-limited (AU, CA, FR, DE, IN, JP, EU-NL, SG, KR, UK, US). When enabled it **replaces** the Cortex Assistant UI. [DOC P1 P3 P5] |
| **Cortex Assistant** (legacy; the 2024 "Cortex Copilot" feature set) | NLP search bar with insights and suggestion columns (Investigate, Respond); entity investigation via XQL library queries; "/" navigation | Default for tenants without the Agentic Assistant. [DOC P17 P18 P19] The older docs-cortex page "Cortex Copilot capabilities" describes the same Help, Investigate and Respond set, so I infer a rename. |
| **Cortex AgentiX** | Launched 2025-10-28 as "the next generation of Cortex XSOAR". Licensed SOAR plus agent platform, "available today in Cortex Cloud and Cortex XSIAM"; XDR and the standalone product in early 2026. | [MKT P44] [DOC P41 P42] |
| **XSOAR 8** | No native LLM chat assistant in the XSOAR 8 SaaS docs. AI arrived through content packs (ChatGPT/OpenAI, AnythingLLM RAG) posting into the War Room, and now through AgentiX. | [MKT P53]; checked the XSOAR 8 SaaS docs index |
| **Prisma Cloud Copilot** | Chat over Prisma Cloud (CNAPP): text-to-RQL, attack paths, vulnerabilities, docs Q&A, support cases | Private preview 2024-05-07, rollout 2024-10-01. Enterprise license and System Admin role only; no credits consumed. Cortex Cloud is positioned as the next version of the Prisma Cloud CNAPP. [DOC P46 P50] [MKT P51] |
| **Strata Copilot** | Network (SASE, NGFW, SD-WAN) assistant | Per the SD-WAN docs, "does not (yet) retain conversational context". [DOC P52] |
| **Precision AI** | Umbrella brand ("ML + DL + GenAI") for the 2024 copilots, not a separate chat product | [MKT P45] |
| **Qualys ETM Cyber Risk AI Assistant "ROCky"** | Chat over ETM risk data | Introduced in ETM 1.6.1 (2026-02-20); history and streaming in 1.9 (2026-06-05); "Watch ROCky Think" in 1.12 (2026-08-03). Must be enabled by Qualys Support or the account TAM. [DOC/RN Q1 Q9 Q10 Q11] |
| **Qualys Cyber Risk AI Agents** | Marketplace of hireable task agents (Sid, Nyra, Sophia, Sara, Insta, Val) plus a no-code agent builder (announced) | Preview announced 2025-08-04; agents in ETM 1.6.1+; Agent Val 2026-03-23. [MKT Q16 Q17] [DOC Q6 Q7] |
| **Qualys Agent Grant** | Identity-security agent ("governed autonomy" under ROC approvals and rollback) | Blog only, 2026-01-06. [MKT Q18] |

---

## 2. Palo Alto: Cortex Agentic Assistant (XSIAM and AgentiX), in detail

### 2.1 Entry points and layout [DOC]

- **Global chat panel.** Open it from the Agentic Assistant icon in the upper-right corner, or
  from XSIAM Command Center → Cortex Agentic Assistant → **Start Investigation**. Close it by
  clicking outside or clicking the icon again [P5].
  - Chat history sits **to the left of the prompt** [P13].
  - "You can manage multiple chats simultaneously and easily switch between the agents you have
    access to" [P5].
- **In the case card.** The assistant is "embedded directly within the case card" as "a
  side-by-side partner" [P14]. The Feb 2026 redesign put "contextual agentic assistance … side by
  side with the investigation" [P35].
- **Ask AI on entities.** "By clicking **Ask AI** next to a specific entity (such as an IP address
  or file hash), the assistant launches with a pre-configured prompt tailored to that specific
  object" [P14].
- **Help → Get Support** opens the Help Center agent [P9].
- **Slack** (Slack v3 integration): tag the bot in a thread, then pick an agent from a dropdown
  (public agents only) [P8].
- **"/" navigation.** "Typing / in the prompt area" jumps to product pages and works even when the
  Agentic Assistant is disabled [P7].
- **Legacy Cortex Assistant entry points:**
  - Left-menu item.
  - Right-click an entity → **Open in Cortex Assistant**.
  - A personal keyboard shortcut. If you highlight an entity before using the shortcut, it opens
    focused on that entity [P17].

### 2.2 Agents, agent picker and conversation starters [DOC]

- **Agent picker.** Click the agent icon at the left of the prompt and hover to see each agent's
  description [P6].
- **System agents** [P6]: IT, Case Investigation, Email Investigation, Threat Intel, Help Center,
  Network Security, Exposure Management (add-on), Cloud Posture, Application Security, Endpoint
  Investigation.
  - The Automation Engineer agent drafts and deploys Python scripts through chat [P34].
  - The Email Security agent arrived in May 2026 [P37].
  - Agents appear according to licence or module.
- **Custom agents** [P23]:
  - Fields: name, colour, description, "Specific Instructions" (role, rules, output structure),
    public or private access, knowledge sources, and **"Conversation starters: up to four prompts
    that appear under the prompt bar"**.
  - Custom agents have "the same or fewer permissions as the user who creates them". A
    **read-only agent** is called out as an example.
  - "Agents are self-contained and cannot communicate with other agents."
- **Recommended agent.** "If you are viewing a case and have a chat with the Threat Intel agent
  open, the system will suggest switching to the Case Investigation agent" [P6].
- **Documented starters (SOC persona)** [P7] [P2]:
  - "What are the top issues I should prioritize today?"
  - "Show me all issues with an overdue SLA"
  - "Which automations are waiting for my input?"
  - "Clean up all expired indicators."
  - "Create a visual representation of the top 10 targeted assets over the last 7 days."
- **Other documented example prompts** [P2]:
  - Multi-step, multi-lookup: "Read this Unit42 blog and get all the CVEs … For every critical CVE
    found, check if my assets are vulnerable and isolate them."
  - "Summarize the latest security issues from the past 24 hours".
  - "What is the riskiest unresolved issue affecting our critical infrastructure?"
  - Charts: "Create a pie chart of the top 10 targeted assets over the last 7 days", "Show
    critical assets by region in a bar chart" and a line-chart trend.

### 2.3 Natural-language querying (NL to XQL) [DOC] [MKT]

- **How you invoke it.** Plain language, for example "Create an XQL query to…", "Build an XQL
  query for…" or "Generate an XQL query that…" [P11].
- **Mechanism.** A hidden, non-removable built-in **TextToXQL** action generates the query. A
  separate **Cortex - Run XQL Query** action runs it; it is included in all system agents and
  optional for custom agents [P11].
- **Permission split.** TextToXQL "can generate queries for datasets you can't access", but the
  run action only executes if the user has permission for the dataset [P11]. Generation works
  for system datasets only, not custom datasets. You can paste your own XQL and ask the agent to
  run it [P11].
- **Who runs it.** "You can have the agent run the query automatically or run it yourself" [P11].
- **Output.** "The agent shows a **preview of the results**. You can open the **full dataset on
  the XQL page**" [P11]. Query generation is EU and US only; running works in all regions [P35].
- **Cost.** Running queries manually through an agent, including multi-step plans, does not
  consume compute units [P11].
- **Engineering background** (blog, 2025-04-23, then private preview) [MKT P43]. NL2XQL is a
  five-phase pipeline:
  1. Intent classification to tables and event types.
  2. Candidate field selection.
  3. A fine-tuned LLM plans a pseudo-query.
  4. Each step is implemented in XQL in parallel.
  5. The query is assembled and "validated for compilability and correctness".
  - Evaluation used experts, static KPIs (compilability; Jaccard over fields, stages and
    operators) and LLM-as-judge. **No accuracy figures were published.**
- **Legacy Cortex Assistant** [P19]: type an entity or a question about it, then pick from the
  **Investigate** column (XQL library queries). "A summary of the entity's details is displayed.
  For more details, click **Show me more**."
  - Limitation: "if the prompt does not include at least one recognizable entity … no response is
    returned."

### 2.4 Charts and visualizations in chat, plus dashboards [DOC] [RN]

- **In chat.** "When you request a visualization, the agent generates an XQL query, executes it,
  and then presents the results in a graph. Agentic Assistant **supports all graph types supported
  by the Cortex Platform**" [P12]. It shipped as "Natural language visualizations" in May 2026,
  all licenses [P36].
- **Iterative editing.** "Instruct the agent to build a new query from scratch or **to modify an
  existing one**." Data filtering lets you "alter the visual representation … **without risking
  any changes to or breaking the existing underlying XQL query**" [P12].
- **Save to dashboard.** The ⋯ menu on the chart saves it to the **Widget Library**, from which it
  can be applied to a dashboard. "Once … saved … the link to the chat artifact is severed" [P12].
- **Widget Library → Create widget → Generate with AI** [P33]:
  - Write a prompt, optionally refine it with more prompts, optionally **Edit in XQL** in the Query
    Builder or Chart Editor, then **Save as Widget** with a name, description and visibility
    (Public or Restricted).
- **AI-driven dashboard builder** (July 2026 highlight): "Turn natural language prompts into data
  visualizations in seconds … build executive-ready dashboards and reports faster" [RN P38]. There
  is no deeper documentation yet.
- **Legacy Cortex MCP Server examples** include "create a graphical representation for my manager"
  and "create a visual timeline" from an external MCP client [P30].

### 2.5 Case and incident summaries, and investigation guidance [DOC]

- **AI-generated case titles and descriptions** [P15]:
  - They are "regenerated each time you open a case" and as new issues or data arrive. They are
    **not saved**, so list and table views keep the static system title.
  - Content covers the nature of the threat, key issues and artifacts, and affected assets or
    identities.
  - Limits: supported regions only; Security and Posture domains only; **no AI summary for
    single-issue cases**.
  - A tenant-level toggle ("AI Case Summarization") and a per-case toggle ("Summarize with AI")
    control the feature.
- **Case Investigation agent** [P14]:
  - "Executive overviews: high-level summaries that focus on impact and risk" **and** "Extended
    technical overviews: deep-dive summaries that outline the technical progression of the
    threat".
  - Targeted Q&A on issue deep-dives, asset relationships and asset or artifact impact.
  - "Investigation guidance: suggests potential next steps and actions, and **links to detailed
    views**."
- **Case context loading rules** [P7]:

  | User action | Context |
  |---|---|
  | Open chat, no message sent | No context loaded ("Case data is only loaded when you send your first message") |
  | Send first message | Current case context loaded |
  | Switch cases with no active chat | Nothing transferred |
  | Switch cases with an active chat | Assistant offers to start a new chat for the new case, or resumes an existing one |
  | Return to a case with chat history | Previous chat and context resume automatically |

- **Resolution Center** (case workspace) [P16]: tabs **Pending, Recommended, In Progress, Done**.
  Agentic Response runs show their pending approvals, errors and completed runs there [P29].

### 2.6 Plan transparency, streaming and long answers [DOC]

- "Before acting, the agent generates a **plan**, verifying each step while executing" [P5].
- "When an agent is formulating a plan or executing steps, **clicking the agent will show which
  actions it is using**. You can scroll between the actions or close the panel" [P7].
- "Click **Plan** and expand the chevron to review the detailed breakdown." **JSON artifacts**
  created when agents retrieve data or create objects are viewable in the plan view. This shipped
  in Feb 2026 [P7] [P34].
- "**Navigate long responses**: … jump directly to the last line of the response by clicking the
  anchor icon" [P7].
- "While an agent is processing a prompt, **you can begin typing a new prompt** … only submit … once
  the previous one has completed. … **Actions exceeding five minutes result in an error**" [P7].
- A caveat shown in the docs: "An agent's proposed plans and results may contain inaccuracies or
  errors" [P7].
- **Not documented:** token-by-token text streaming, a stop button, regenerate, or message edit.

### 2.7 Agentic actions, approvals and guardrails [DOC]

- **Actions** wrap playbooks, scripts, commands, AI prompts and MCP tools. There are more than 50
  system actions [P21].
  - When registering an action you supply a name, a goal, few-shot examples, and the subset of
    inputs and outputs **visible to the LLM** [P22].
- **Sensitive actions.** "Any action marked as sensitive … requires explicit user approval before
  execution." The approval checkbox is **on by default** when you register an action, and system
  actions "are marked sensitive if they affect system reality" [P21] [P22]. MCP-discovered tools
  are "by default … marked as sensitive" [P25]. Sensitive actions "are never run automatically"
  [P4].
- **Slack approval UX.** A "hard lock" refuses text input and shows **Approve** (green) and
  **Deny** (red). Only the initiator can click. With no response in two weeks the request is
  auto-denied and the chat closes [P8].
- **Autonomous runs (Agentic Response, private preview).** Automation rules trigger agents without
  chat. If a sensitive action is needed, the agent "**pauses execution and generates a pending
  task** in the case Resolution Center" for approve or deny [P29].
- **RBAC** [P26] [P3]: a dedicated "CORTEX AGENTIC ASSISTANT" permission category with Interact
  with agents, Manage actions, Manage agents and Agents admin. "Agents are limited by the
  individual permissions of the user." Integration permissions can restrict commands, including
  MCP tools, to specific roles.
- **Safeguards** [P7]: agents "validate their proposed plans, ensuring that all necessary
  permissions are in place". The assistant "clarifies ambiguous prompt intentions and **blocks
  requests that may be exploitative or harmful**."
  - **Prompt-injection defences are not described** anywhere I could find [P4].
- **Audit.** "All actions an agent takes are saved in an audit dataset" (`agentix_agents_actions`,
  queryable in XQL) with agent, action and invoking user. The audit records who, what and when
  "**without logging the private content of your prompts**" [P3] [P4] [P7].
- **Data handling.** Dedicated GCP project; prompts and outputs "processed only to generate the
  immediate response", never used for training, kept within the regional compute boundary [P4].

### 2.8 Conversation history, sharing and export [DOC]

- History is grouped as **Today, Yesterday, Last 7 days, Older**. "The first prompt you enter in a
  new chat becomes its title." The ⋯ menu offers **Edit** (rename) and **Delete** [P13].
- **Retention: 186 days** for chats and related artifacts, extendable with a retention add-on.
  Slack sessions close after two weeks of inactivity [P13].
- "Your conversations within the Agentic Assistant chat are **private**" [P7].
- **Export, share, copy, attachments, search and pin:** none is documented for the chat UI
  [AI-ANS P54].
- Sharing is indirect, through public agents, Widget Library charts, War Room entries (the Help
  Center action "Create War Room Entry", up to 20 cases or issues per call, approval required
  [P10]) and Slack threads.
- **Slack rendering** [P8]:
  - "Small tables (less than 5 rows) are rendered as Markdown, while **larger tables will be
    summarized with a link to view the full results**."
  - Chat artifacts are not visible in Slack.
  - The agent reads the last 5 thread messages for context.
  - Feedback is thumbs up or down.

### 2.9 Product-help Q&A: the Help Center agent [DOC]

- "Grounded in official documentation, the agent queries your tenant to perform **live
  diagnostics**" across platform health, security policies, detection rules and data
  collection [P9].
- **Support case prefill.** It "gathers all required technical information, license details, and
  logs … your case is automatically built using details from your conversation". It also offers
  "proactive resolution interception" while you draft a ticket [P9].
- **HITL.** It needs "explicit user confirmation before performing critical operations or
  initiating long-running diagnostic tasks, and provides notifications upon completion" [P9].
- **Example prompts** [P9]: "How do I build a custom dashboard", "How do I set up user roles and
  permissions?" and "How do I manage and close cases in bulk?"
- **Action catalogue with published per-call limits** [P10]. Examples:
  - Check Allow/Block Lists: one SHA256 per call.
  - List Endpoints: 30 per page.
  - List Assets: 100 per page, maximum 5,000.
  - List BIOC Rules: 200 per page.
  - Diagnose Broker Collectors: 100 audit rows.
  - Create War Room Entry: 20 cases per call, approval required.
  - Update Content Packs: approval required; aborts on breaking changes.
  - In short, pagination is explicit and full coverage "requires retrieving all pages".

### 2.10 Prompt library, knowledge sources, models and MCP [DOC] [RN]

- **AI Prompts library** (Investigation & Response → Automation → AI Prompts) [P27] [P28]:
  - Search by name or tag, exact match in quotes, OR between quoted names.
  - System prompts are locked; use "Duplicate Prompt" to edit a copy.
  - A **Prompt Helper** gives tips, and **Optimize** rewrites the prompt with undo.
  - **Test** runs in a playground with arguments. Each run result can be marked as a note, opened
    in a new tab, downloaded or tagged.
  - A prompt can be registered as an agent action or dropped into a playbook as an AI task.
  - Settings: Model (Flash, Thinking or Pro), **Temperature 0–2**, and **Max Output Tokens
    (default 2,500, adjustable)**.
  - "Structured output" with a JSON schema was added in July 2026 [P39].
  - The library is hidden unless the Agentic Assistant is enabled [P34].
- **Knowledge Center / Personalized Agents (preview)** [P24] [P39]:
  - Upload MD, JSON, JSONL, CSV, DOC or DOCX files up to 5 MB, or link Confluence or Google Drive
    with a 24-hour auto-sync, and assign each source to agents.
  - Each source shows Learning, Connected or Error status, and a tenant "Source limit" capacity
    bar is shown.
  - "**Grounding visibility**: … short **source labels or citations within responses** to indicate
    exactly which knowledge was applied". Knowledge use is written to the audit log.
- **Model selector (EU and US only)**, "per chat, AI prompt, and AI prompt task" [P1] [P41] [P38]
  [P40]:
  - Flash = Gemini 3.5 Flash.
  - Thinking = Claude Sonnet 4.6.
  - Pro = Claude Opus 4.8.
  - Claude Sonnet 5 on request.
  - Other regions get Gemini 3.5 Flash only (CA and DE added 2026-09-06).
- **MCP client** [P25]:
  - Agents call third-party MCP servers (streamable HTTP, OAuth or authless). Discovery runs
    hourly, and the tools become system actions marked sensitive by default.
  - Multiple instances are supported, for example a GitHub read-only instance and a read/write
    instance.
- **MCP server** [P30]: a downloadable Cortex MCP Server for external clients such as Claude
  Desktop. Its built-in tools (`get_cases`, `get_issues`, `get_assets`,
  `get_filtered_endpoints`, …) "retrieve information, but do not write to the tenant".

### 2.11 Usage visibility, limits and cost [DOC] [RN]

- **Cortex Agentix Assistant dashboard** (system dashboard, public, not editable) [P31]:
  - User Prompts: the number of users and usage over the last 7 days.
  - Automation Rules triggered.
  - An Agent Grid of the top 5 agents in the last 7 days, with agent cards (roles and actions).
- **Compute units** [P32] [P39]: "Compute unit consumption currently applies only to XQL
  queries. **Agentic and LLM information is shown only for informational purposes** and does not
  consume compute units."
  - The usage table has a **Category: XQL Queries, Agents & LLM** column, a Query/Prompt column
    and a Billable flag.
  - July 2026: "displays the evaluated compute cost for **each agentic request**" (non-billable).
- **Published bounds:**
  - 5-minute action timeout [P7].
  - 186-day retention [P13].
  - Slack: 2 weeks, last 5 messages [P8].
  - Help Center per-action page sizes [P10].
  - AI Prompt max output tokens 2,500 by default [P28].
  - Knowledge files up to 5 MB [P24].
  - Region gating [P1].
  - **No chat token, turn-length or message caps are published** [AI-ANS P54].
- **AgentiX licence quotas** (users, compute units, incident retention) cover the SOAR product,
  not chat tokens [P42].

### 2.12 Marketing claims versus documented behaviour (Palo Alto)

| Claim | Source | Documented? |
|---|---|---|
| "trained on … 1.2 billion real-world playbook executions" | AgentiX PR [MKT P44] | No doc evidence of training data |
| "up to a 98% reduction in MTTR with 75% less manual work" | [MKT P44] | Unverified |
| "1,000+ prebuilt integrations and native MCP" | [MKT P44] | MCP client and server documented [P25] [P30]; integration count not checked |
| "Robust guardrails for total control" | [MKT P44] | Documented: sensitive-action approval, RBAC, audit dataset, harmful-request blocking. **Not** documented: prompt-injection controls. |
| NL2XQL accuracy | [MKT P43] | Method described; no figures |
| Prisma Copilot "24x faster than manual documentation searches" | [MKT P51] | Unverified |

---

## 3. Palo Alto: legacy Cortex Assistant ("Cortex Copilot" feature set) [DOC]

- **Layout** [P18]: a search bar at the top, an **Insights** area, then suggestion columns:
  **Investigate** (recommended follow-up questions answered by XQL) and **Respond** (playbooks,
  scripts, scans, support file collection).
- **Respond.** "Cortex Assistant will **always prompt you to approve the action** before
  executing" [P19].
- **RBAC.** "Suggestions and responses … customized according to that specific user's RBAC
  access" [P19].
- **Responsible AI.** "User confirmation for write actions … explainability … providing the logic
  behind answers and offering a **feedback option**" [P17].
- **Navigation mode.** "/issues" searches page names, with an OR across multiple terms [P19].
- **Takeaway.** Follow-up suggestion columns plus approval-gated actions are the 2024 baseline
  that the agentic chat replaced with plans and starters.

---

## 4. Palo Alto: Prisma Cloud Copilot, Strata Copilot and XSOAR

### 4.1 Prisma Cloud Copilot [DOC unless marked]

- **Entry.** The Copilot icon at the top right next to the user profile. The first screen offers
  "explore options" such as "What are my top risks?" or free text in "Type your question here"
  [P47] [P48].
- **Conversation management** [P48]:
  - **New Chat**.
  - **Favorites**: "hover over a prompt name and click on the star icon … to save the selected
    prompt to Favorites".
  - Rename and Remove (with confirmation) through the ⋯ "Take Action" menu.
  - An **Open Sidebar** shows Favorites and Recent conversations.
- **Capabilities** [P47]:
  - Attack-path insights ("Shows the top attack path and explains the associated risk"; remediation
    "fix in code and cloud").
  - Vulnerability insights (top vulnerabilities, a specific CVE, fix in code or **open a Jira
    ticket**).
  - Asset search ("Am I vulnerable to log4j?", "Am I impacted by CVE-…").
  - Docs Q&A ("How to create a new policy?"), with answers that "summarize the information, which
    is spread across the Prisma Cloud documentation".
  - **Support cases** "including screenshots, documents, as well as screen-recordings".
- **Text-to-RQL** [P49]: about 40 documented example prompts, such as "Find S3 buckets with
  internet exposure or unencrypted storage" or "Show vulnerabilities with a CVSS score higher than
  8 and at least 30 days old". The question "is automatically converted to an RQL query and the
  query is then executed".
- **Data flow and guardrails** [P50]:
  1. Contextualization (for example, adding the log4j CVE IDs).
  2. The LLM translates to RQL or an API request. "**Your data is not sent to the LLM to generate
     the RQL statement.**"
  3. "A local parser checks the LLM's output for accuracy, then runs it against a local API
     endpoint."
  4. The results are displayed, "such as in a graph".
  - Follow-ups such as explaining a graph use the LLM "after **masking out the sensitive
    information**".
  - Actions execute "locally … without LLM involvement".
  - Copilot cannot be disabled; it only runs on prompt.
- **Access and cost.** Enterprise licence and **System Administrator role only**; "currently free
  to use, and it does not consume credits" [P46].
- **Marketing claims** [MKT P51]: real-time fix-status tracking, a "visual dashboard" and the
  "24x faster" figure above.

### 4.2 Strata Copilot (SD-WAN docs) [DOC P52]

- It is opened from the Copilot icon at top right, after accepting a supplemental EULA.
- Suggested prompts are context-sensitive to the current page. A Clock icon shows recent
  conversations.
- "**Copilot does not (yet) retain conversational context**": each prompt stands alone.
- Answers are "summary articles" with **sources included**.
- Feedback is thumbs up or down **with comments**. A "Get tech support" path follows feedback.

### 4.3 XSOAR [MKT P53]

- The XSOAR 8 SaaS docs have no native chat assistant. Older patterns:
  - The ChatGPT/OpenAI playbook writes LLM output to the per-incident **War Room**.
  - The AnythingLLM content pack provides a RAG "natural language command interface".
- AgentiX ("next generation of Cortex XSOAR") is the go-forward assistant [P44].

---

## 5. Qualys: Cyber Risk AI Assistant "ROCky" (ETM) [DOC] [RN]

### 5.1 Availability and access

- ROCky is introduced in **ETM 1.6.1 (2026-02-20)** as a separate tab in ETM. "To enable this
  feature, connect with Qualys Support or your Technical Account Manager (TAM)" [Q9] [Q1].
- **RBAC** (ETM 1.9): "Manager users can grant or revoke access for users to view the ROCky from
  the Administration application." Managers have access by default [Q10].
- **Marketing.** The 2025-08-04 press release calls it "a prompt-driven interface that helps teams
  navigate the risk journey", inside "the industry's first agentic AI-powered Risk Operations
  Center", in preview at the time [MKT Q16].

### 5.2 UI anatomy

- **Quick-Start options**, "pre-configured to represent commonly requested queries … with a single
  click" [Q1] [Q3]:
  - Show me blindspots in cloud
  - Show me TruRisk by Business Entities
  - Show me Risk Removal Velocity
  - What are the latest Patch Tuesday Vulnerabilities
  - Show me all trending threat actors or adversaries impacting my industry
- **Text input** ("Ask here…") for custom questions and follow-ups. **Voice input** records and
  submits a spoken question. **Send** is a paper-airplane icon [Q1] [Q2].
- **New Chat** (top right) "clearing the current context" [Q1].
- **Prompt Library** ("at the bottom of the chat interface") has **5 categories** [Q3]:
  - **Asset Inventory**: "Show me the assets ingested in the latest CrowdStrike run", "…
    distributed by business criticality", "… internet-facing assets", "… blindspots in cloud".
  - **Risk Findings**: "Show me a summary of all findings", "Show me fixed vs open in last 180d".
  - **Threat Intel**: trending threat actors, Patch Tuesday, "I want to detect and get recommended
    solutions adversary techniques linked to MITRE TTPs", "Show me the top 10 apt groups in my
    industry".
  - **Business Context**: TruRisk by business entity, top 3 failing, top risky, best performing,
    above risk appetite, "**$ value at risk by Business Entities**".
  - **Response**: "Analyze my remediation strategies", "Analyze my VM Program", Risk Removal
    Velocity, patchable and unpatchable findings.
- **Documented workflows** [Q2]: a daily security review, remediation planning (patchable versus
  no patch), business-unit performance, threat response preparation, asset audits, and
  **executive reporting** ("Gather risk data by business entities for executive summaries and
  board presentations").

### 5.3 History, streaming, transparency and feedback

- **Chat history** (ETM 1.9, 2026-06-05) [Q10] [Q3]:
  - "Automatically saves all user conversations". History is "specific to each user … private and
    not visible or accessible to other users".
  - A **History** button lists conversations. **Conversation replay** lets you view past queries
    and responses, "**continue interaction from the saved context**" and "**copy responses for
    reuse**".
  - Troubleshooting says history is reached with "the left navigation arrow in the top-left
    corner" [Q4].
- **Streaming of intermediate steps** (1.9): "Analyzing request, Searching the knowledge base,
  Fetching sources, Executing tools" [Q10].
- **"Watch ROCky Think in Real Time"** (ETM 1.12, 2026-08-03, on request) [Q11] [Q3]:
  - Live stage-by-stage reasoning with "**Tool execution details (name, input/output, endpoint,
    and status)**", progress tracking for multi-step operations, "**Timestamps for each reasoning
    step**" and "Capability and tool count tracking".
  - Interactive steps: "View detailed information about a specific tool call", "**Retry a failed
    operation**", "**Request an explanation for a specific step**" and "Trigger custom actions
    based on the reasoning context".
- **Feedback.** "When you use the thumbs up or down, your feedback is sent to train ROCky" [Q3]
  [Q10]. ROCky trains on feedback; Palo Alto states it does not train on customer data.

### 5.4 Query grammar, limits and guardrails

- **Supported prompts appendix** [Q5]: 49 enumerated prompts. "Minor variations of supported
  prompts are also recognized." Examples:
  - "Show findings on assets with RDP (port 3389) open, last updated in the past 14 days."
  - "Show findings linked to threat actor APT29."
  - "Show findings mapped to MITRE ATT&CK technique T1490."
  - "Show findings with TTD ≤ 30 days or TTR ≤ 90 days."
  - "Show risk-accepted findings with reason … created in the last quarter."
- **Supported tokens** [Q5]: 31 fields such as `finding.qds`, `finding.epssScore`,
  `finding.riskFactor.isCisaKnownExploit`, `asset.truRisk`, `finding.mitre.attack.technique.id`
  and `finding.ttr`.
  - **Inference:** the NL layer maps onto ETM's QQL token model, which explains the strong steer
    toward library prompts.
- **Timeouts.** "Complex queries … may take longer … If it times out, try submitting a simpler or
  more focused query" [Q4]. No numeric limit is published.
- **Data isolation.** "Responses are generated only from information the user is authorized to
  access." The privacy guidelines advise against including employee names or secrets in queries
  [Q4].
- **Not documented:** answer formats (charts or tables; screenshots only), export, sharing, report
  generation from chat, token limits, model provider and prompt-injection defences.
- **NL query outside ROCky.** I found no documented natural-language-to-QQL feature in VMDR or
  CSAM. QQL remains token, operator and value with auto-suggest [Q20].

---

## 6. Qualys: Cyber Risk AI Agents (task agents, not chat)

### 6.1 Common UI [DOC Q7]

- The **Cyber Risk Agents** tab has My Agents, All Agents (tasks) and **Marketplace** sub-tabs.
- The **Marketplace** shows agent cards (name, use case, description, core skills), search and
  side-by-side comparison, with a **Hire Agent** button.
- **My Agents** shows per-agent metrics (Total Tasks, Total Runs), **Assign Task** and a ⋯ menu.
- The **All Tasks** table shows status, assigned agent, created by and last modified by, last run
  status and date, and next scheduled run.
  - Filters cover status, last run status, assignee, creator and timeframe.
  - **Run Now** triggers a task.
  - "**Last Run With Actions**" opens outputs such as **Prioritization Plans** and **EASM
    Reports**.
- **RBAC** [Q6]: Manager (hire or offboard agents; create, edit, run, enable, disable and delete
  tasks) and Viewer (read-only).

### 6.2 Agents (all are "available on request through the TAM") [DOC Q6]

- **Sid**: external attack surface discovery.
- **Nyra**: threat-informed prioritization.
- **Sophia**: CISA-KEV and ransomware hygiene.
- **Sara**: Patch Tuesday.
- **Insta**: scanless advisory-to-inventory detection. "does not patch, reconfigure, or otherwise
  change any asset" [Q15].
- **Val**: exploit validation through TruConfirm [Q12].

### 6.3 Task configuration example: Agent Sara [DOC Q14]

- **Scope:** tags, business entities, asset types, locations and cloud providers.
- **Triggers and schedule:** on-demand, weekly or monthly.
- **Actions:** "Exposure summary (narrative summary …)", "Prioritization plan", "**Patch job draft —
  prepared patch jobs for human review and execution**" and email notification.
- The page includes a role-based configuration guide for Patch Manager, VM Manager, CISO and
  Change Advisory Board chair, plus "Sharing results" guidance per audience.

### 6.4 Human-in-the-loop: Agent Val [DOC Q12 Q13] [MKT Q17]

- "Agent Val handles exploit validation autonomously, but **all patch/remediation and
  risk-acceptance decisions go through your team for review and approval**."
- **Flow:** Assign Task → select findings → **Proceed with Assessment** ("Agent Val confirms before
  proceeding") → **Run TruConfirm Assessment** → **View Remediation Options** → **Deploy AI-based
  Recommendations** → revalidation scan → summary.
- The profile page has KPI tiles (TruConfirm-available CVEs, external findings, critical internal
  findings, exploits validated, exploits ruled out), a "Risk vs. Business Criticality" scatter
  chart and an auto-generated **Insights** panel.
- **Agent Grant** (identity, blog) claims operation "under ROC approvals and rollback controls" and
  before/after TruRisk deltas as evidence [MKT Q18]. Rollback mechanics are not documented.

### 6.5 Naming note: "QAGENT", "VMDR AI" and "TruRisk AI"

- I found no AI product, docs page or press release called **QAGENT** (extended web search plus the
  ETM docs table of contents). The likeliest confusion is with the **Qualys Cloud Agent** (the
  endpoint sensor) or with "Cyber Risk Agents".
- Qualys AI branding across VMDR is "TruRisk", plus the 2025 "Agentic AI" and Risk Operations
  Center launch, plus the ETM 1.8 "AI-Generated Title Indicator for CVE Details" [Q8]. No separate
  VMDR chat assistant is documented.

### 6.6 Marketing claims versus documented behaviour (Qualys)

| Claim | Source | Documented? |
|---|---|---|
| "Industry's first agentic AI-powered Risk Operations Center" | [MKT Q16] | Positioning only |
| "Tasks that previously took 2 hours now complete in 2 minutes" | ETM docs page [Q6] | Unquantified vendor claim inside the docs |
| "Autonomously remediating with speed, scale, and accuracy" | [MKT Q16] | Docs show remediation behind human approval (Val, Sara patch drafts) |
| "Build Your Own AI Agent" with a no-code builder | [MKT Q16] | No builder documentation found; the docs show only hire and assign-task |
| Agent Grant "ROC approvals and rollback controls" | [MKT Q18] | Not documented in the ETM help |

---

## 7. Capability matrix

Legend: ✓ documented · ~ partial or indirect · ✗ not documented or absent · (M) marketing only.

| Capability | PANW Agentic Assistant | PANW legacy Cortex Assistant | Prisma Cloud Copilot | Qualys ROCky | Qualys task agents |
|---|---|---|---|---|---|
| NL → native query language | ✓ XQL (generate, then run; EU and US) | ~ XQL library picks | ✓ RQL (local parser validates) | ~ constrained prompts and tokens | ✗ |
| Shows the generated query and lets you edit it | ✓ (paste your own; Edit in XQL for widgets) | ✗ | ✗ | ✗ | ✗ |
| Preview inline plus open the full result elsewhere | ✓ preview → XQL page | ✓ "Show me more" | ~ graph | ✗ | ✓ task outputs |
| Charts in chat | ✓ all platform chart types | ✗ | ✓ "such as in a graph" | ✗ (undocumented) | ✓ profile charts (not chat) |
| Edit a chart by follow-up | ✓ modify, filter without breaking the query | ✗ | ✗ | ✗ | ✗ |
| Save to dashboard or widget | ✓ Widget Library | ✗ | ✗ | ✗ | ✗ |
| Case or incident summary | ✓ auto title and summary; executive versus technical | ~ entity summary | ✗ | ~ "summary of all findings" | ✓ exposure summary |
| Auto case context in chat | ✓ (on first message; resume per case) | ✓ entity focus | ✓ page-context suggestions | ✗ | n/a |
| Multi-step or multi-lookup plan | ✓ plan, parallel or sequential | ✗ | ~ | ✓ multi-step tool trace | ✓ scheduled |
| Visible steps or tool calls | ✓ plan, actions, JSON artifacts | ~ "logic behind answers" | ✗ | ✓ tool input and output, timestamps | ✓ run history |
| Retry or explain a step | ✗ | ✗ | ✗ | ✓ | ~ Run Now |
| Follow-up suggestions | ✓ starters (≤ 4 per agent) | ✓ Investigate and Respond columns | ✓ explore options | ✓ quick-start (5) | ✗ |
| Prompt library and favorites | ✓ AI Prompts library (playbook-oriented) | ✗ | ✓ Favorites (star) | ✓ 5 categories | ✗ |
| History | ✓ time-bucketed, rename and delete, 186 days | ✗ | ✓ Recent, rename and remove | ✓ private, replay, continue, copy | n/a |
| Share or export a chat | ✗ (private; Slack and War Room indirect) | ✗ | ✗ | ✗ (copy only) | ~ email outputs |
| Product-help Q&A | ✓ Help Center agent with live diagnostics and ticket prefill | ✓ Help (Copilot era) | ✓ docs Q&A and support case | ~ "Explain the latest security trends" | ✗ |
| Citations or grounding labels | ✓ knowledge-source labels (preview) | ✗ | ~ | ✗ | ✗ |
| Agentic actions with approval | ✓ sensitive = approval; Slack hard lock; Resolution Center pending task | ✓ always approve Respond | ✓ remediation and Jira (approval undocumented) | ~ "trigger custom actions" | ✓ Val and Sara human review |
| Model choice | ✓ Flash, Thinking, Pro per chat (EU and US) | ✗ | ✗ | ✗ | ✗ |
| Feedback | ✓ Slack thumbs | ✓ feedback option | ✗ | ✓ thumbs (trains) | ✗ |
| Voice input | ✗ | ✗ | ✗ | ✓ | ✗ |
| Long-answer navigation | ✓ jump-to-end anchor | ✗ | ✗ | ✗ | n/a |
| Published chat token or length limits | ✗ none; 5-minute action timeout | ✗ | ✗ | ✗ ("may time out") | n/a |
| Cost visibility | ✓ per-agentic-request evaluated cost (non-billable) and usage dashboard | ✗ | ✓ "no credits" | ✗ | ✓ task and run counts |
| Audit of agent actions | ✓ XQL dataset (prompt text not logged) | ✓ system activity | ~ | ✗ | ✓ created and modified by |
| Slack or Teams entry | ✓ Slack | ✗ | ✗ | ✗ | ✗ |
| MCP | ✓ client and server | ✗ | ✗ | ✗ | ✗ |

---

## 8. Implications for the Agentic SOC chat (concrete, ranked)

These are proposals derived from the evidence above. They keep the 12 non-negotiables: a
read-only chat, #3, #6, #7 and #9.

1. **Remove the hard answer and turn caps; keep spend informational.** No competitor publishes
   chat token caps. Palo Alto bounds *actions* by time (5 minutes) and shows agent cost as
   non-billable telemetry.
   - Map this to Agentic SOC: default `turn_token_ceiling` and `final_max_tokens` to
     "unlimited/model max", and keep the live token meter as **information, not enforcement**.
   - Keep a wall-clock safety timeout per tool. Keep the daily budget as the operator's only spend
     gate, consistent with the existing "budget backstop" design.
   - Replace "continue where stopped" with full answers. Present large data as an **inline preview
     plus "Open full result"** (Unified Logs view or a dialog), as XSIAM does with "preview …
     full dataset on the XQL page" [P11] and Slack's "larger tables summarized with a link"
     [P8].
2. **Plan and step drawer** (XSIAM Plan with JSON artifacts, plus ROCky "Watch it think"):
   - Each step shows the tool name, inputs (fenced), output summary, status, duration and
     timestamp.
   - Add **Retry step** and **Explain this step** actions [P7] [Q11].
3. **Chart follow-ups and Save to dashboard.**
   - Chart edits by follow-up ("make it a bar chart", "only critical", "last 30 days") should
     re-render without re-querying where possible [P12].
   - "Save to dashboard" should place the block into a custom-dashboard widget. Agentic SOC
     already ships per-user dashboards, matching Palo Alto's Widget Library flow [P12] [P33].
4. **Modes or personas with starters.**
   - An agent-style picker over the one engine (#5 stays intact): Investigate, Hunt or Logs, Threat
     Intel, Posture/Metrics, App Help.
   - Each mode gets up to 4 conversation starters [P23], plus ROCky-style one-click quick-start
     chips on the empty state [Q3].
   - Suggest switching mode based on page context [P6].
5. **Prompt library with categories and favorites.** Combine ROCky's 5 categories with Prisma's
   star-to-favorite [Q3] [P48]. Suggested categories: Triage, Hunt, IOC, Shift report, Posture,
   App help.
6. **History polish.**
   - Time buckets: Today, Yesterday, Last 7 days, Older. The title comes from the first prompt,
     with rename and delete [P13].
   - Show the retention policy in the UI.
   - Add Copy response everywhere [Q10].
   - Add search (no competitor documents chat-history search, so this would be a differentiator).
7. **Case chat behaviour.**
   - Attach case context only on the first message.
   - Resume the per-case thread on return.
   - Offer "start a new chat for this case?" when the case changes mid-chat [P7].
   - Add **"Ask AI" chips** next to entities (IP, hash, user, host) that open chat with a
     pre-filled, fenced prompt [P14].
8. **Summaries with an audience toggle.** Offer "Executive overview" and "Technical overview" for
   cases and reports [P14]. ROCky's "executive reporting" workflow [Q2] maps to the reports
   library's summary.
9. **Help agent parity.**
   - Docs-grounded answers with citations, plus live diagnostics from `app_status` (source health,
     poller lag, budget) [P9] [P10].
   - Publish per-tool page limits openly, as Palo Alto does [P10].
10. **Long-answer ergonomics:** a jump-to-end anchor [P7], typing allowed while a turn runs
    [P7], and thumbs feedback written to the audit log only (no training) [P17] [Q3].
11. **Model tier selector per chat** (Fast, Balanced, Deep), mapped to the operator's configured
    models with cost shown [P1].
12. **Future and optional:** a Slack or Teams entry point with initiator-only control [P8]; an MCP
    server exposing read-only chat tools [P30]; knowledge-source citations for operator runbooks
    (Agentic SOC already has RAG) [P24].
13. **Things to avoid:**
    - ROCky's "feedback trains the model".
    - Palo Alto's "TextToXQL can generate queries for datasets you can't access". Agentic SOC
      should keep generation scoped by RBAC as well as execution.
    - Strata's "no conversational context".

---

## 9. References

### Palo Alto Networks: Cortex documentation (cortex-docs.paloaltonetworks.com; read 2026-10-10)

- [P1] Agentic AI in Cortex XSIAM — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/learn-about-cortex-xsiam/agentic-ai-in-cortex-xsiam.md
- [P2] Agentic Assistant use cases — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/learn-about-cortex-xsiam/agentic-ai-in-cortex-xsiam/agentic-assistant-use-cases.md
- [P3] Compare Agentic Assistant with Cortex Assistant — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/learn-about-cortex-xsiam/agentic-ai-in-cortex-xsiam/compare-agentic-assistant-with-cortex-assistant.md
- [P4] Agentic Assistant security — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/learn-about-cortex-xsiam/agentic-ai-in-cortex-xsiam/agentic-assistant-security.md
- [P5] Get started with Agentic Assistant chat — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/get-started-with-agentic-assistant-chat.md
- [P6] Choose an Agentic Assistant agent — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/choose-an-agentic-assistant-agent.md
- [P7] Chat with an Agentic Assistant agent — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/chat-with-an-agentic-assistant-agent.md
- [P8] Chat with the Agentic Assistant from Slack — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/chat-with-the-agentic-assistant-from-slack.md
- [P9] Help Center agent — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/streamline-troubleshooting-and-support-with-the-help-center-agent.md
- [P10] Help Center agent actions — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/streamline-troubleshooting-and-support-with-the-help-center-agent/help-center-agent-actions.md
- [P11] Create and run XQL queries with Agentic Assistant chat — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/create-and-run-xql-queries-with-agentic-assistant-chat.md
- [P12] Use natural language to query and visualize your data — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/use-natural-language-to-query-and-visualize-your-data.md
- [P13] Manage chat history — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/agentic-assistant-chat/manage-chat-history.md
- [P14] Case Investigation agent — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/start-case-analysis/agentic-assistant-case-investigation-agent.md
- [P15] AI-generated case summaries — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/establish-case-context/ai-generated-case-summaries.md
- [P16] Resolution Center — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/resolve-the-case/resolution-center.md
- [P17] Cortex Assistant — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/cortex-assistant.md
- [P18] Cortex Assistant layout — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/cortex-assistant/cortex-assistant-layout.md
- [P19] Cortex Assistant capabilities — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/cortex-assistant/cortex-assistant-capabilities.md (legacy page title "Cortex Copilot capabilities": https://docs-cortex.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-Documentation/Cortex-Copilot-capabilities)
- [P20] Agentic Assistant components and concepts — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agentic-assistant-components-and-concepts.md
- [P21] Manage actions — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agents-hub/manage-actions.md
- [P22] Register actions — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agents-hub/register-actions.md
- [P23] Build agents — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agents-hub/build-agents.md
- [P24] Manage knowledge sources (preview) — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agents-hub/manage-knowledge-sources-preview.md
- [P25] Expand agent capabilities with MCP integrations — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agents-hub/expand-agent-capabilities-with-mcp-integrations.md
- [P26] Agentic Assistant RBAC — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/configure-the-cortex-agentic-assistant-1/agentic-assistant-role-based-access-control.md
- [P27] Use existing prompts (Prompts Library) — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/automations/ai-prompts/use-existing-prompts.md
- [P28] Create a prompt — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/automations/ai-prompts/create-a-prompt.md
- [P29] Agentic Response (Preview) — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/automations/agentic-response-preview.md
- [P30] Cortex MCP server / Use the Cortex MCP server — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/cortex-mcp-server.md ; https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/cortex-mcp-server/use-the-cortex-mcp-server.md
- [P31] Cortex Agentic Assistant dashboard — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/dashboard-reference/command-center-reference/cortex-agentic-assistant-dashboard.md
- [P32] Manage compute unit usage — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/configure-cortex-xsiam/data-management/manage-compute-units/compute-units-usage.md
- [P33] Create widgets using AI — https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/monitor-dashboards-and-reports/advanced-configuration/create-custom-widgets/create-widgets-using-ai.md
- [P34] XSIAM RN Feb 2026: Feature enhancements — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/february-2026/feature-enhancements.md
- [P35] XSIAM RN Feb 2026: Release highlights — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/february-2026/release-highlights
- [P36] XSIAM RN May 2026: Release highlights — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/may-2026/release-highlights.md
- [P37] XSIAM RN May 2026: Feature enhancements — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/may-2026/feature-enhancements.md
- [P38] XSIAM RN July 2026: Release highlights — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/july-2026/release-highlights.md
- [P39] XSIAM RN July 2026: Feature enhancements — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/july-2026/feature-enhancements.md
- [P40] XSIAM RN September 6, 2026 — https://cortex-docs.paloaltonetworks.com/cortex-xsiam-rn/cortex-xsiam-release-information/features-introduced-in-2026-xsiam/september-6-2026.md
- [P41] Agentic AI in Cortex AgentiX — https://cortex-docs.paloaltonetworks.com/cortex-agentix/learn-about-cortex-agentix/agentic-ai-in-cortex-agentix.md
- [P42] Understand Cortex AgentiX licenses — https://cortex-docs.paloaltonetworks.com/cortex-agentix/learn-about-cortex-agentix/understand-cortex-agentix-licenses.md

### Palo Alto Networks: blogs, press and other documentation

- [P43] NL2XQL blog (2025-04-23) — https://www.paloaltonetworks.com/blog/security-operations/nl2xql-turning-natural-language-into-powerful-cybersecurity-querying
- [P44] Cortex AgentiX launch press release (2025-10-28) — https://investors.paloaltonetworks.com/news-releases/news-release-details/palo-alto-networks-unveils-cortex-agentix-build-deploy-and (mirror read: https://securitymea.com/2025/10/29/palo-alto-launches-cortex-agentix-for-the-future-agentic-workforce/)
- [P45] Copilots for Strata, Prisma and Cortex, powered by Precision AI (2024-05-07) — https://www.paloaltonetworks.com/company/press/2024/palo-alto-networks-delivers-more-autonomous-cybersecurity-through-copilots-for-strata--prisma-and-cortex-platforms
- [P46] Prisma Cloud Copilot overview — https://docs.prismacloud.io/content-collections/prisma-cloud-copilot/prisma-cloud-copilot-overview
- [P47] Key benefits of Prisma Cloud Copilot — https://docs.prismacloud.io/content-collections/prisma-cloud-copilot/prisma-cloud-copilot-benefits
- [P48] Interact with Prisma Cloud Copilot — https://docs.prismacloud.io/content-collections/prisma-cloud-copilot/prisma-cloud-copilot-interaction
- [P49] Text to RQL examples — https://docs.prismacloud.io/content-collections/prisma-cloud-copilot/prisma-cloud-copilot-rql
- [P50] Prisma Cloud Copilot FAQs — https://docs.prismacloud.io/content-collections/prisma-cloud-copilot/prisma-cloud-copilot-faqs
- [P51] Prisma Cloud Copilot blog (2024-10-15) — https://www.paloaltonetworks.com/blog/cloud-security/ai-powered-security-copilot
- [P52] Use Copilot in Prisma SD-WAN (Strata Copilot) — https://docs.paloaltonetworks.com/content/techdocs/en_US/prisma-sd-wan/administration/get-started-with-prisma-sd-wan/using-strata-copilot-in-prisma-sd-wan.html
- [P53] Using ChatGPT in Cortex XSOAR — https://live.paloaltonetworks.com/t5/community-blogs/playbook-of-the-week-using-chatgpt-in-cortex-xsoar/ba-p/545414 ; XSOAR with GenAI and RAG — https://live.paloaltonetworks.com/t5/cortex-xsoar-articles/xsoar-with-generative-ai-and-retrieval-augmented-generation/bc-p/1226914
- [P54] [AI-ANS] Cortex docs "ask" endpoint answers (2026-10-10) on chat limits and on chat export, sharing and feedback. Both answers stated "not documented" or "does not specify numeric quotas"; sources included [P3] [P32] [P41].

### Qualys (docs.qualys.com ETM help; read 2026-10-10; pages show "Last updated: September, 2026")

- [Q1] Cyber Risk AI Assistant ROCky — https://docs.qualys.com/en/etm/latest/cyber_risk_assistant/ai_assistant.htm
- [Q2] Getting Started with ROCky — https://docs.qualys.com/en/etm/latest/cyber_risk_assistant/getting_started_rocky.htm
- [Q3] Quick-Start Options, Prompt Library, Chat History, Watch ROCky Think — https://docs.qualys.com/en/etm/latest/cyber_risk_assistant/quick_start.htm
- [Q4] Optimization and Support for ROCky — https://docs.qualys.com/en/etm/latest/cyber_risk_assistant/optimization_support_rocky.htm
- [Q5] Additional Help (supported prompts and tokens) — https://docs.qualys.com/en/etm/latest/cyber_risk_assistant/appendix_agentic_ai.htm
- [Q6] Explore our Agentic AI Suite (RBAC, agents) — https://docs.qualys.com/en/etm/latest/agentic_ai/all_agents.htm
- [Q7] Common User Interface for AI Agents (Marketplace, tasks) — https://docs.qualys.com/en/etm/latest/agentic_ai/cyber_risk_agents.htm
- [Q8] What's New in ETM — https://docs.qualys.com/en/etm/latest/introduction/whats_new.htm
- [Q9] ETM Release 1.6.1 (2026-02-20) — https://docs.qualys.com/en/etm/release-notes/etm/release_1_6_1.htm
- [Q10] ETM Release 1.9 (2026-06-05) — https://docs.qualys.com/en/etm/release-notes/etm/release_1_9.htm
- [Q11] ETM Release 1.12 (2026-08-03) — https://docs.qualys.com/en/etm/release-notes/etm/release_1_12.htm
- [Q12] Agent Val — https://docs.qualys.com/en/etm/latest/agentic_ai/agent_val.htm
- [Q13] Getting Started with Agent Val — https://docs.qualys.com/en/etm/latest/agentic_ai/getting_started_with_val.htm
- [Q14] Getting Started with Agent Sara — https://docs.qualys.com/en/etm/latest/agentic_ai/getting_started_with_sara.htm
- [Q15] Agent Insta — https://docs.qualys.com/en/etm/latest/agentic_ai/agent_insta.htm
- [Q16] Qualys press release: Agentic AI-Powered Risk Operations Center (2025-08-04) — https://www.qualys.com/company/newsroom/news-releases/usa/qualys-unveils-industrys-first-agentic-ai-powered-risk-operations-center/
- [Q17] Qualys press release: Agent Val (2026-03-23) — https://www.qualys.com/company/newsroom/news-releases/usa/qualys-debuts-industrys-first-ai-agent-for-safe-exploit-validation ; blog — https://blog.qualys.com/product-tech/2026/03/23/meet-agent-val-closing-the-validation-gap-in-exposure-management-at-machine-speed-with-agentic-ai
- [Q18] Agent Grant blog (2026-01-06) — https://blog.qualys.com/product-tech/2026/01/06/agent-grant-agentic-ai-identity-security
- [Q19] ROCon Houston 2025 ETM press release (2025-10-15) — https://www.qualys.com/company/newsroom/news-releases/usa/rocon-houston-2025-qualys-expands-enterprise-trurisk-management-etm-with
- [Q20] Qualys Query Language (QQL) overview — https://docs.qualys.com/en/ud/latest/qql_topics/qql_overview.htm
