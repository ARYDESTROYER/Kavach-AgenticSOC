# Competitive research: Splunk, Elastic Security and agentic-SOC startups (chat, investigations, long-running work)

Researched 2026-10-10 for the Agentic SOC Round 12 chat work. Sources are vendor docs (preferred),
vendor product pages and blogs, and trade press. Each item is labelled:

- **[DOC]**: the vendor's product documentation describes the behaviour.
- **[PAGE]**: a product page or vendor blog describes it. This is weaker evidence and may be aspirational.
- **[MKT]**: a marketing or performance claim with no published methodology.

**Method notes.**
- The shared web-search budget ran out near the end of the run. The last few items come from pages fetched directly.
  Splunk AI Assistant 2.2 visualization behaviour could not be confirmed, and it is flagged where relevant.
- Several Elastic pages were read from the official `elastic.co/docs` site. Their version badges (9.3, 9.4, 9.5,
  Serverless) are quoted as published. Some of the same pages also exist on preview builds, where the badges may move.

---

## 0. Takeaways for Agentic SOC (read this first)

1. **No vendor shows a per-answer "continue where it stopped" step to the user.** Long work is handled in three ways.
   - **Keep large tool output out of the prompt.** Elastic keeps it in a conversation "file store" and uses selective
     compaction. Dropzone keeps it in an Evidence Locker. Torq tells builders to format workflow output.
   - **Run the work in the background with a visible status.** Examples are Dropzone's Queued/Running/Stopped and
     Elastic's In progress / Awaiting your input / Unread / Error conversation states. Elastic also has a Generations
     control centre with per-step timing. Splunk's SOC analyst agent has already finished before the analyst opens the
     finding.
   - **Stream structured steps inline.** Elastic shows inline reasoning and tool-call events marked running or returned.
     Splunk has an "Analysis Details" step timeline, Exaforce a workflow graph, and 7AI a per-step "mission / input /
     tools / conclusion" report.
2. **The hard limits vendors publish are on input, scope and spend, not on answer length.**
   - Splunk: 4,000-character prompts; the triage agent analyses the first 10 findings per detection run and about 200
     findings per day per tenant.
   - Elastic: 99 retained conversations per user (legacy assistant); 100 alerts by default in Attack Discovery.
   - Dropzone: 10 investigations run at once.
   - Torq: 8 AI credits per chat.
   - None of these vendors documents a per-message output-token cap that users see. Elastic documents
     `context_length_exceeded` as a known issue; the fix it gives is to start a new conversation with a summary.
3. **A "working" signal is expected in the navigation as well as in the thread.**
   - Elastic marks each conversation in the chat list as In progress, Awaiting your input or Unread (finished while you
     were elsewhere). Several conversations can run at the same time.
   - This is the direct precedent for the user's "animated logo in the left-hand side while the agent works".
4. **Investigation answers share one skeleton across vendors.** It is a verdict or determination with a one-line reason,
   then:
   - key findings (Dropzone shows the top 5);
   - question threads, each with its findings and the sources queried;
   - an evidence locker (source, request, raw response);
   - MITRE mapping;
   - recommendations and next steps.
5. **Reports are a single click from chat and land on the case.** Splunk has default requests "Generate investigation
   report" and "Generate finding report", each saved as a file attachment, a note or a PDF download. Elastic has "Add to
   existing case" and "Add note to timeline" on every message. Torq's case summary has fixed headings: what, when,
   impact, key indicators.
6. **Charts are interactive and stay in the thread.** Elastic Agent Builder (9.4 preview, 9.5 GA) renders single charts
   inline. You can change the time range or drag-select to zoom. Dashboards attach to the reply and open in a "Preview"
   canvas beside the conversation, where they can be saved or opened with "Edit in Dashboards".
7. **Human-in-the-loop clarifying questions** (Elastic: up to 5 multiple-choice questions, each with Skip and a custom
   answer) are the documented fix for vague or ambiguous queries. This is relevant to the user's "some queries don't
   work".

---

## 1. Splunk

### 1.1 Splunk AI Assistant for SPL, now "Splunk AI Assistant" 2.x (Search app)

| Capability | How invoked | Output / UI | Limits | Evidence |
|---|---|---|---|---|
| Write SPL (NL→SPL) | New Chat, plain-English task | SPL plus an explanation; can be run or iterated | 4,000 characters per prompt for each chat option | [DOC] https://help.splunk.com/en/splunk-enterprise/search/splunk-ai-assistant/2.1.0/use-splunk-ai-assistant |
| Explain SPL | Paste SPL | Step-by-step plain-language breakdown | same | [DOC] same; https://splunk.com/en_us/products/splunk-ai-assistant.html |
| Optimize SPL (2.x) | Ask to optimize new or existing SPL | Rewritten SPL "applying the best Splunk practices in the context of your environment" | same | [DOC] same |
| Edit SPL (1.5.0+) | NL refinement such as "Last 7 days only" | Modified SPL that keeps the original structure | same | [DOC] same |
| "Tell me about…" | Product and concept questions | Text answer | same | [DOC] https://help.splunk.com/en/splunk-cloud-platform/search/splunk-ai-assistant/1.3.2/use-splunk-ai-assistant-for-spl |
| Chat history | Left side of the page | All chats saved; rename and delete | No cap documented | [DOC] same |
| Prompt library | Built in | 10+ prompts in three categories: Administrative ("which hosts are sending data"), Data Discovery, and Security (CIM login searches) | — | [DOC] 2.1.0 page |
| Guardrails | Automatic | Blocks unsupported languages (EN/FR/ES/JA supported), gibberish, prompt injection and profanity; advises rephrasing blocked prompts as specific directives | — | [DOC] 2.1.0 page |
| Feedback | Thumbs up/down on results | Sent to Splunk | — | [DOC] |
| Context (opt-in) | Admin Settings → Context tab | Uses index/sourcetype/field-name metadata, user search logs and knowledge objects; never field values; respects ACLs; "marginally longer" generation time | — | [DOC] https://help.splunk.com/en/splunk-enterprise/search/splunk-ai-assistant/2.2.0/use-splunk-ai-assistant/context-in-splunk-ai-assistant |
| **Agent Mode** (2.0.0+) | Admin toggle "Enable Agent Mode"; needs Model Runtime opt-in and Cloud 10.1.x in listed AWS regions | Agentic response generation with more tools: event scans, fetching existing dashboards, executing searches. Splits a prompt into **parallel tool/skill calls**. **"Executing non-trivial searches requires explicit permission from the user"** because of SVC cost. Executed searches go to audit logs. "Teach AI" markdown guidance is in beta. | Spend is controlled by role limits; disabling Agent Mode stops users approving searches. Agent Mode metrics are not in the AI Usage Dashboard (2.0.0). | [DOC] https://help.splunk.com/en/splunk-enterprise/search/splunk-ai-assistant/2.0.0/use-splunk-ai-assistant/agent-mode-in-splunk-ai-assistant |

Not documented in what we read: how Agent Mode shows progress, reasoning or steps; whether results render as tables or
charts in the chat; and stop or cancel controls in Agent Mode.

### 1.2 AI Assistant in Splunk Enterprise Security (Mission Control)

- **Entry point.** Mission Control → analyst queue → finding or investigation → **View details** (Overview) → **AI
  Assistant** icon, which opens a chat box. The agentic chat is opened with an "AI sparkle button". [DOC]
  https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/ai-assistant-in-security-and-agentic-capabilities/summarize-findings-and-investigations-with-the-ai-assistant-in-splunk-enterprise-security
  ; https://help.splunk.com/en/splunk-enterprise-security-8/troubleshoot/8.6/troubleshooting/troubleshoot-ai-assistant-in-splunk-enterprise-security
- **Default requests (prompt chips).** "Summarize the findings" returns a **structured summary**, a **narrative of
  events**, a **MITRE ATT&CK analysis**, and **suggested follow-up / next steps**. [DOC] same page; scenario
  https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.7/scenarios
- **Recommendation buttons under the chat.**
  - **Suggest SPL**, followed by **Open in search**, which pastes the SPL into the Search tab to edit and run there. SPL
    is not run inline.
  - **Generate investigation report** and **Generate finding report**.
  - [DOC]
    https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/ai-assistant-in-security-and-agentic-capabilities/generate-spl-with-the-ai-assistant-in-splunk-enterprise-security
- **Report save options.** **Attach as file**, **Add as note**, **Download as PDF**. "The AI Assistant generates a report
  summary and adds it to the finding or investigation." [DOC]
  https://help.splunk.com/splunk-enterprise-security-8/user-guide/8.2/mission-control/summarize-findings-and-investigations-with-the-ai-assistant/generate-a-report-with-the-ai-assistant
- **Stop.** "If a response runs too long, select the **stop** icon." [DOC] same.
- **Unavailability states.** The assistant is unavailable while loading, when AI is turned off, or "after the daily
  triage limit is reached". [DOC] summarize page.
- **Agentic chat v1 vs v2.**
  - v1 is available on-premises and in Cloud. v2 is Cloud only.
  - Failure guidance is to "Send the message again or create a new chat session". This is the closest Splunk comes to
    documenting a "continue" behaviour.
  - [DOC]
    https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/ai-assistant-in-security-and-agentic-capabilities/agentic-ai-offerings-in-splunk-enterprise-security
    ; troubleshooting page above.
- **Model governance.** With Model Runtime, every response is tagged **internal** (Splunk-hosted) or **external**
  (third-party LLM) in the audit logs. Admins can choose "Limit to Splunk-hosted models only". [DOC]
  https://help.splunk.com/en/splunk-enterprise-security-8/release-notes-and-resources/8.6/splunk-enterprise-security-release-notes

### 1.3 AI SOC analyst / Triage agent (ES 8.6–8.7, Premier, Cloud only)

- **What it does.** Investigates findings in the Analyst queue automatically when enabled. It searches connectors,
  gathers evidence and **suggests a disposition**: true positive, false positive, benign positive or needs review. "By
  the time an analyst opens a finding, the investigation is typically already done." It **never overwrites an analyst's
  disposition**. [DOC]
  https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/ai-assistant-in-security-and-agentic-capabilities/setting-up-the-ai-soc-analyst-agentic-workflow-in-splunk-enterprise-security
- **Presentation: the "AI Analysis" side panel** on the finding. [DOC] same page. It shows:
  - the suggested disposition and a reasoning summary;
  - a justification;
  - **tools and connectors used**;
  - **evidence and hypothesis analysis**;
  - triage coverage (how many findings were triaged);
  - relationships between findings;
  - **Analysis Details**: a step-by-step timeline of actions, the SPL that was run, and how the evidence was weighed.
- **Follow-up.** Analysts can ask follow-up questions about the analysis and can summarise several agent-analysed
  findings together. [DOC]
- **Limits.**
  - Only the **first 10 findings** per detection run are analysed.
  - The daily cap is **about 200 findings per tenant**.
  - It does not re-triage inside investigations, and findings added later get no agent results.
  - It needs SOAR pairing and frontier models. [DOC]
- **Field data from .conf26** (Cisco blog, observational, not a benchmark). Suggested dispositions came with confidence
  bands (20–39 / 40–59 / 60–79 / 80–100). Counts reported: 1,503 AI events, 7,605 SPL queries, 26,207 pieces of evidence,
  14,279 hypotheses, 11,250 TI lookups, 94% coverage. [PAGE]
  https://blogs.cisco.com/security/conf26-agentic-soc-triage-agent

### 1.4 Other ES agents

- **Malware Reversing / Phishing Analysis agent.** Select a file or URL in the "Resources Analyzed" tree on the Overview
  page. The **AI Analysis box has three tabs: Summary | MITRE TTPs | IOCs and Recommendations**. [DOC]
  https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/ai-assistant-in-security-and-agentic-capabilities/analyze-scripts-using-the-ai-powered-malware-reversing-agent-and-phishing-analysis-agent-in-splunk-enterprise-security
  - Contents:
    - a suggested severity;
    - a high-level description of the behaviour;
    - a step-by-step breakdown;
    - code snippets showing the suspicious activity;
    - ATT&CK mappings;
    - IOCs with next steps, which can be used to build SPL.
  - URL analysis shows the verdict, the phished brand and task scores.
  - Supported inputs: scripts, Office documents, PDF, images including QR codes, and .ics files.
- **Detection Builder.** Runs inside the detection editor; creates, tunes, validates, troubleshoots and annotates
  detections. [DOC] (release notes)
- **SOP agent.** Imports an SOP into a **structured response plan**. [DOC]
- **Automation Builder.** Turns a natural-language idea into a tested SOAR playbook. [DOC]
- **Guided Response.** Runs SOAR actions on findings. [DOC]
- The performance claims ("machine speed", "trusted autonomy", MTTD/MTTR gains) are [MKT]:
  https://www.splunk.com/en_us/blog/artificial-intelligence/advancing-the-soc-in-splunk-enterprise-security-8-6.html ,
  https://www.splunk.com/en_us/blog/security/from-reactive-to-agentic-with-enterprise-security-at-rsac-2026.html

---

## 2. Elastic Security

### 2.1 Elastic AI Assistant for Security (the classic assistant)

As of 9.4 this is no longer the default; Agent Builder is (§2.2), and admins can switch back in GenAI Settings. [DOC]
https://www.elastic.co/docs/solutions/security/ai/ai-assistant

- **Invoke.**
  - Toolbar button, or **Cmd/Ctrl + ;**.
  - **Ask AI Assistant** in the footer of the alert/event flyout.
  - The detection-rule query editor.
  - The Data Quality "Incompatible fields" tab.
- **Starting points.**
  - **Prompt tiles** (9.1+): Alerts, Research, Query (ES|QL), Suggest.
  - Context-dependent **Quick Prompts**, for example "Alert summarization" when an alert is open.
  - **System Prompts**, which can be scoped to contexts.
- **Context.**
  - "Alerts to analyze" sets how many alerts are sent.
  - Index names and field metadata are included (9.1+; "may slightly increase response times").
  - **Anonymization** per field (Allowed / Anonymized). "Show anonymized" changes only the view, not what is sent.
- **Knowledge Base.** You can say "remember X about host Y" and it is reused in later answers. ES|QL answers depend on
  the KB.
- **Actions on each message.**
  - **Add note to timeline**.
  - **Add to existing case** (posts the message as a case comment).
  - **Copy to clipboard**.
  - **Add to timeline** (a query or filter; shown on query answers only).
- **History.**
  - The **99 most recent conversations** are kept per user, in a list beside the chat and in the Conversations tab.
  - Sharing can be Private, Shared or Restricted. A shared conversation is read-only to others, who **Duplicate** it to
    continue.
  - Changes to sharing are written to the audit log.
- **Streaming** is a toggle: word by word, or the whole answer at once.
- **Citations** (Chat options) can point to shared data, KB entries, Elastic Security Labs or the product docs.
- **ES|QL.** Can generate, explain, optimise, customise and troubleshoot queries. "ES|QL queries generated by AI
  Assistant might require additional validation." [DOC]
  https://elastic.co/guide/en/security/8.x/esql-queries-assistant.html

### 2.2 Elastic Agent Builder: the default Security chat from 9.4

[DOC] https://www.elastic.co/docs/solutions/security/ai/agent-builder/agent-builder ,
https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/chat

- **One default "Elastic AI Agent" with modular skills.** Skills turn on according to the role and the prompt.
  - The standalone Threat Hunting Agent was removed in 9.4. Its conversations are hidden, and no migration is planned.
  - Security skills: [DOC] https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/builtin-skills-reference

    | Skill | What it does | Tools |
    |---|---|---|
    | `alert-analysis` | Alert context, related alerts sharing entities, Security Labs TI, entity risk; recommends a disposition | `security.alerts`, `security.security_labs_search`, `security.entity_risk_score` |
    | `threat-hunting` | Hypothesis-driven iterative ES|QL | generate/execute ES|QL, search, list indices, mappings, cases |
    | `entity-analytics` | Entity profiles | — |
    | `detection-rule-edit` | Creates and edits rules; ES|QL rules only | — |
    | `visualization-creation` | Charts | — |
    | `dashboard-management` | Dashboards (9.5 GA) | — |
    | `cases-management` | Cases (9.5 preview) | — |

- **Attachments.** **Add to chat** on a rule (from the rule page, rule form, alert flyout or alerts table) attaches a rule
  card. "Agent Builder only has access to the fields included in the rule attachment." From the card you can **Apply to
  creation** or **Update rule**.
- **Inline progress and reasoning.** This is the most relevant pattern for us.
  - "Reasoning, tool calls, tool results, and the final response appear inline as one sequence, in the order they
    happen." This replaced the earlier collapsible Reasoning panel.
  - "Tool call events show whether a tool is still running or has returned."
  - Expanding a tool call shows **Parameters sent** and **Response returned**. Some results render inline; others offer
    **View JSON** or **View execution**.
  - After the answer, a **response metadata menu shows timing and token usage**, and **View response JSON** shows the
    raw response.
  - **View Trace** opens a waterfall of model and tool spans when tracing is on.
- **Loop bound.** "The agent runs tools in a loop until it reaches its goal or exceeds the maximum conversation length."
  No fixed number of steps or tools is documented.
- **Status indicators in the conversation list.** This is the precedent for a "working" indicator in the side rail.

  | Status | Meaning |
  |---|---|
  | In progress | The agent is generating |
  | Awaiting your input | Paused on a human-in-the-loop prompt |
  | Unread | Finished in a conversation you weren't viewing |
  | Error | Being removed from Stack 9.5 and Serverless |

  "Conversations run independently, so you can work in several at the same time."
- **Conversation management.**
  - Search across conversations.
  - Pin by dragging to **Pinned**; pins persist.
  - Sharing: Private, **Restricted** (named users) or **Public**. Members can read and continue a shared conversation.
  - "Skip agent" posts a message without triggering a response.
  - Shared conversations refresh about every 5 seconds while the tab is in the foreground.
  - Chat runs both standalone and as a flyout.
- **Human-in-the-loop prompts.**
  - Tool confirmation: a preview with buttons such as "Delete permanently", or a generic Allow/Deny.
  - Connector authorization.
  - **Clarifying questions: up to 5 multiple-choice questions, with a custom answer and "Skip question",
    Back/Continue/Submit.**
  - "Don't grant extra privileges": actions run with the user's own permissions.
- **Images.** Paste with Ctrl/Cmd+V; up to 10 per message; PNG/JPEG only; 3.5 MB each. Serverless preview only.
- **Not documented:** a stop or cancel control, conversation export, or keyboard shortcuts other than paste.

### 2.3 Charts and dashboards in chat (9.4 preview, 9.5 GA on Stack; GA on Serverless)

[DOC] https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/agent-builder-dashboards-and-visualizations ;
[PAGE] https://www.elastic.co/search-labs/blog/ai-dashboard-generation-elastic-agent-kibana (May 25, 2026)

- **Single charts and metrics render inline in the thread.** "You can change the time range or select a range on the
  chart to zoom in."
- **Dashboards are attached to the reply.**
  - **Preview** opens them "in a canvas beside the conversation".
  - In the canvas you can use KQL, filter pills, time range, click-to-filter on marks and legends, and maximize or
    inspect panels.
  - **Save** opens a dialog for title, description, tags and permissions. Saving again overwrites.
  - An earlier version can be saved from the conversation.
  - If someone edits the dashboard outside the chat, an **outdated-attachment notice** appears.
  - **Edit in Dashboards** continues editing in the full app.
- **Chart engines.** ES|QL charts, tables and metrics render with Lens. Vega-Lite covers small multiples, layered charts,
  scatter and bubble charts. **Sankey, radar and network charts fall back to the closest supported chart.**
- **Fast mode** (bolt icon) returns sampled, estimated results for a single `STATS` command.
- **Pipeline.** Each panel goes through its own pipeline: chart type → ES|QL → config → validation. The panels run
  concurrently, outside the main agent context, "to avoid bloating its context".
- **Model caveat.** Elastic recommends a higher-tier model; Claude 4.6 Sonnet "may require more corrections". [DOC]

### 2.4 Long conversations and context (how Elastic avoids truncation)

- **Conversation context store.** Tool and query results go into an in-memory "file store" and are "only pull[ed]… into
  the active context when needed". [PAGE] https://www.elastic.co/search-labs/blog/elastic-agent-builder-ai-agents-context-management
  (May 5, 2026, 9.4)
- **Selective compaction.** Older turns are compressed into retrievable summaries, "not simple truncation". The context
  "remains within a limit even for chats with 30 or more turns". [PAGE] same. No trigger threshold is published.
- **Dynamic skill loading.** Unused skills stay as name-and-description stubs. This cut input tokens by 21–39% in
  Elastic's testing. Top-snippet retrieval cut 27–34%. [PAGE]
- **Usage API.** Added in 9.4; tracks token usage, turns and tool calls per conversation. [PAGE]
- **Known issue: `context_length_exceeded`.** It happens when "tools return large responses". The documented fixes are:
  - narrow the query;
  - **start a new conversation with a brief summary**;
  - use a larger-context model;
  - build targeted ES|QL tools that return less.
  - [DOC] https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/limitations-known-issues ,
    https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/troubleshooting/context-length-exceeded
- **A2A** does not stream: it returns the full response only when the task finishes. **Sub-agents** (foreground or
  background) cannot answer human-in-the-loop prompts. [DOC] known-issues page. The background sub-agent feature itself
  is not otherwise documented in what we read.

### 2.5 Attack Discovery (alerts → attack narratives)

- **What it does.** Groups related alerts into attack narratives. Each discovery has:
  - a title and summary;
  - the alert count;
  - ATT&CK tactics;
  - the implicated users and hosts, with the activity seen for each.
  - [DOC] https://www.elastic.co/docs/solutions/security/ai/attack-discovery
- **Invocation.** Manual run, a **schedule** (for example every 24h, with optional Slack or email notifications), a
  workflow, or **from an Agent Builder conversation**. Manual runs still work while a schedule is active. [DOC]
  https://www.elastic.co/docs/solutions/security/ai/attack-discovery/run-from-attack-discovery-page
- **Volume.** By default up to **100 alerts from the last 24h**. A KQL filter, time picker and "Number of alerts" slider
  change the selection; the 8.17 docs give **500** as the slider maximum. Elastic warns that "sending more alerts than
  your chosen LLM can handle may result in an error", and that a run takes "from a few seconds up to several minutes".
  [DOC] https://www.elastic.co/guide/en/security/8.17/attack-discovery.html ,
  https://www.elastic.co/guide/en/security/8.19/attack-discovery.html
- **Attacks view (current).** [DOC] https://www.elastic.co/docs/solutions/security/ai/attack-discovery/manage-discoveries-from-attacks-page
  - **Summary tab:** attack count and volume over time, with **Trends / Count / Treemap** tabs.
  - **Table:** expanding a row shows the entities and attack-chain steps.
  - **Flyout header:** title, status, alert count, assignees, notes.
  - **Overview tab:**
    - **Attack Summary**, with an LLM summary and a Background section;
    - **Attack Chain diagram** mapped to ATT&CK tactics;
    - **Insights**: Entities and Correlation, each opening a child flyout.
  - **Alerts tab:**
    - Alerts outside the current filter are greyed out, and a "Show matching alerts only" toggle hides them.
    - Counts read like "2/10" (2 alerts match the current filters, out of 10 linked historically).
    - This is a pattern for paginating or filtering evidence without truncating it.
  - **Take actions menu:**
    - status: Open / Acknowledged / Closed;
    - run workflow;
    - assign;
    - tags;
    - **Investigate in timeline** (all correlated alerts, ignoring filters);
    - **Add to case**;
    - **View in AI Chat**.
    - Bulk changes can apply to the attack only, or to the attack and its alerts.
  - **Run progress:** the **Generations** control centre lists runs and their status. Opening a run shows workflow
    execution details, with timing and counts for each step (alert retrieval → generation → validation).
    **Failed, cancelled or dismissed runs can be "troubleshot with AI".** There is no documented live progress bar;
    users refresh to see results.
  - Scheduled attacks show a calendar icon that opens the execution history. Manual attacks show a "Run by" avatar.

---

## 3. Agentic-SOC startups

### 3.1 Dropzone AI (best-documented of the startups)

[DOC] https://docs.dropzone.ai/llms-full.txt (Investigations, Chat, Context Memory sections),
https://docs.dropzone.ai/best-practices/deep-dive-into-investigation-reviews ,
https://docs.dropzone.ai/best-practices/utilizing-the-dropzone-ai-chatbot

- **Investigation queue states.**
  - **Queued**: waiting, because **10 investigations already run at once**, which is the system limit.
  - **Running**.
  - **Stopped**: a threshold was hit or an error occurred. A refresh icon retries, and stopped alerts "do not count
    against your license".
  - Priority tabs: Urgent / Notable / Informational.
  - Conclusion and priority can be edited inline and in bulk.
  - The last session's filters are saved.
- **Investigation write-up sections** (the report skeleton):
  1. **Alert Claim**: the alert and rule, plus **Associated Entities**. "View All Details" shows the code the AI ran and
     what it returned.
  2. **Conclusion Reasoning**: the outcome (Malicious / Suspicious / Benign / Inconclusive) "with supporting context and
     confidence", plus **Insight Tags**.
  3. **Investigation Threads**: the AI-generated questions. Each has an expand caret, which opens **Thread Findings**,
     **Sources Queried** and **Additional Threads** (follow-up questions spawned by that finding).
  4. **Key Findings**: "the five most significant findings".
  5. **Evidence Locker**: Source → Request (the exact query or action) → Response ("View Response" shows raw and
     processed results).
  6. **Recommendations**: containment actions, shown only for Malicious, Suspicious and Inconclusive outcomes.
  7. **Notes** for collaboration.
  8. **Changelog**: the lifecycle from ingestion to approval, including conclusion changes.
- **Review loop.** If the conclusion fits the team's SOPs, the reviewer clicks **Close** (→ Reviewed). Otherwise they
  change the conclusion, add a note, and can tick "Use this note to guide context memory generation".
- **Chat** (a deliberately limited "lightweight assistant").
  - Two scopes: **Investigation-scoped** (opened with "Ask a question" inside an investigation; sees its entities and
    alerts but "can't pull alerts directly from your source systems") and **Session-scoped** (freeform; customers "use
    these chats as a search engine" across connected sources).
  - It "does not perform investigative reasoning, hypothesis testing, or behavioural baselining". Dropzone advises
    tactical, time-bound, entity-specific prompts.
  - **Evidence chips**: blue means the query returned results; grey means it returned none. **Hover shows the executed
    query; click opens the full response payload.**
- **Context Memory** stores org facts, not procedures. Entries come from analyst conclusion changes, manual notes, and
  ingestion from Confluence/Jira/ServiceNow. "There is no limit to the number of Context Memory items".
- [MKT] claims: "investigate in minutes", "85% reduction", "5x faster MTTR", "zero variance". https://dropzone.ai/product

### 3.2 Prophet Security (Prophet AI)

- **Output per alert:** a determination (benign / malicious / inconclusive), a severity, remediation steps, and a
  **compiled timeline**. Findings cite their sources, and analysts can expand a conclusion to see "the precise query
  that was run". [PAGE, sponsored] https://www.helpnetsecurity.com/?p=375595 (June 24, 2026)
- **Show-your-work.** "Every question, query, and reasoning step is documented." **Related investigations are grouped
  into one incident.** Response actions are **previewed and backtested against history** before they run. Teaching (org,
  investigation or single-step guidance) is also previewed and backtested, and each learned entry's source is visible.
  [PAGE] https://www.prophetsecurity.ai/how-it-works
- **Dig Deeper:** follow-up questions about **one investigation or across several**. [PAGE] (product-page snippet via
  search; we did not find it in the docs)
- **Threat Hunter:**
  - a chat interface over alerts, context and TI feeds;
  - hypothesis prompts such as "Are we impacted?" and "Where else is this happening?";
  - a curated hunt library;
  - **scheduled hunts that compile into reusable scripts for asynchronous monitoring**.
  - [PAGE] https://prophetsecurity.ai/ai-threat-hunting
- [MKT]: "10x faster", "<5 min per investigation", "senior-analyst depth".

### 3.3 Torq (HyperSOC / Socrates)

- **Socrates tab** "next to the case timeline". Conversations are saved inside the case. Out-of-the-box actions:
  - change state and severity;
  - read and write notes;
  - add observables;
  - assign the case.
  - Every message is logged in the Activity Log as "Socrates conversation message". Socrates' actions are attributed to
    it in the audit log, "on your behalf".
  - [DOC] https://kb.torq.io/en/articles/9734818-socrates-ai-analyst-transforming-case-investigations
- **Context-window guidance.** "Very long workflow output can overflow it, so configure the Exit operator to format
  output." Socrates does not save workflow outcomes, so users should document them in a note. [DOC] same.
- **Socrates chat workspace.** [DOC] https://kb.torq.io/en/articles/17229191
  - An agent picker with search; the Investigator agent works outside cases.
  - **New Chat**, file attachments and collaborators.
  - **`/` opens the tools menu** in the composer.
  - A **Compact vs Detailed view** toggle.
  - Sharing: Private / Restricted / Public.
  - Pricing: **8 AI credits per chat "regardless of the agent or the number of messages"**.
- **Modes.** Co-pilot (conversational) vs **auto-pilot**, which works an assigned case through an **Actionplan**
  ("structured runbooks for AI execution") and asks for analyst confirmation as needed. [DOC]
  https://kb.torq.io/en/articles/13424122-ai-in-torq
- **AI case summary** headings: **what / when / impact / key indicators**, intended for shift handoff. [PAGE]
  https://torq.io/blog/ai-case-management/ (Apr 25, 2025). Another Torq post describes "What happened / When / How, each
  supported by direct citations to original forensic evidence". [PAGE]
- [MKT]: "95% of Tier-1 cases autonomously".

### 3.4 Exaforce (Exabots)

- **Triage page captions** [PAGE] https://www.exaforce.com/platform/exabot-triage :
  - a **triage workflow graph**: planning → data collection → initial investigation agent → **judge review agent**,
    shown completed end to end;
  - a threat finding table, plus a **duplicate finding table grouped under a shared root cause**;
  - an **attack chain graphic** with pivots back to the source evidence;
  - a graph modal;
  - details and analysis cards;
  - an "Additional evidence" tab with third-party enrichment such as AbuseIPDB;
  - a false-positive conclusion view and a FP-rate chart.
  - Each outcome carries a plain-English rationale, key indicators, the affected principals and resources, and links to
    logs and evidence.
- **Exabot Search** image caption: "comparing admin privilege grants across Entra ID, Okta, Google Workspace and
  Microsoft 365", with a notable observation underneath, related identities beside the results, and chat history
  alongside. [PAGE] https://www.exaforce.com/solutions/ai-for-soc
- **ExaGo** (mobile, announced July 28, 2026) [PAGE]
  https://www.exaforce.com/press-release/exaforce-launches-exago-industrys-first-ai-voice-powered-mobile-ai-soc-app :
  - **voice plus a chat transcript where "live investigation updates appear"**;
  - "**Investigations keep running after the first spoken reply**";
  - conversations continue across desktop, mobile and Apple Watch;
  - reports created through conversation, including "audit-ready board reports";
  - push notifications for new hunts.
- [MKT]: "answers in under a minute", "cut irrelevant alerts by up to 80%".

### 3.5 7AI

- **Investigation view.** [PAGE] https://7ai.com/platform/investigations
  - Opens with the **verdict and a one-line reason**.
  - Evidence is grouped by **email / file / user**, each item mapped to its artifact.
  - Recommended actions are attached to the verdict.
  - **Agent step report:** each step shows its **mission, input, tools and conclusion, plus the exact request and
    response**.
  - **Entity graph** (emails, domains, files, hashes, users) with pivots to the raw data and environment-wide
    prevalence.
  - A **follow-up copilot scoped to the investigation's own evidence**, for questions like "why did it escalate?".
  - Remediation steps can be approved one by one or run as orchestrated, and are audit-logged.
  - The page's example concludes in about 6.5 minutes.
- **Pulse:** "the live view of the platform at work". The investigations dashboard shows deflection, escalations and
  analyst time saved. [PAGE] https://7ai.com/platform
- **DFIR report:** executive summary, **timeline** and scope of compromise. [PAGE] https://7ai.com/dfir
- **Dynamic Reasoning:** no-playbook investigation of novel alerts. [MKT/press]
  https://www.businesswire.com/news/home/20250730465750/en . There is no public docs portal (per a third-party profile).

---

## 4. Cross-vendor pattern matrix

| Pattern | Splunk ES / AI Asst | Elastic | Dropzone | Prophet | Torq | Exaforce | 7AI |
|---|---|---|---|---|---|---|---|
| Inline step and tool trace in chat | Analysis Details timeline (agent panel) | **Inline reasoning + tool events (running/returned), Parameters/Response, View JSON, trace waterfall** | Evidence chips (query on hover, payload on click) | Expand conclusion → exact query | Tools in the Activity Log payload | Workflow graph | **Step report: mission/input/tools/conclusion + request/response** |
| "Working" or status signal outside the thread | Unavailable states; daily-limit state | **List status: In progress / Awaiting input / Unread** | **Queued / Running / Stopped** | — | — | Live updates in the transcript | **Pulse** live view |
| Long work in the background | **Agent pre-runs before the analyst opens the finding** | Attack Discovery schedules + **Generations centre**; concurrent conversations | Queue of 10 concurrent | Scheduled hunts → scripts | Auto-pilot Actionplan | "keeps running after first reply" | Every alert to a conclusion |
| Keeping big results out of the prompt | — | **File store + selective compaction + skill stubs** | Evidence Locker | — | "format Exit output" | — | — |
| Investigation skeleton | Summary, narrative, ATT&CK, next steps | Attack Summary, Background, Attack Chain, Entities, Correlation | **Claim, Reasoning+confidence, Threads, Key Findings (5), Evidence Locker, Recs, Notes, Changelog** | Determination, severity, remediation, timeline | what/when/impact/key indicators | rationale, indicators, principals, evidence links | verdict + reason, evidence groups, graph, steps |
| One-click report → case | **Investigation/finding report → file, note or PDF** | Add to case; add note to timeline; save dashboard | Notes | Push to Jira/Slack/Teams | Note on the case | Board reports (mobile) | DFIR report |
| Charts in chat | Not confirmed (2.2 docs not reached) | **Inline charts with time-range change and zoom; dashboard Preview canvas; save/edit** | — | — | — | Graphs, FP chart (product UI) | Entity graph |
| Clarifying questions | Recommendation buttons ask for scope (e.g. index) | **Up to 5 multiple-choice questions** | Prompt guidance only | — | — | — | — |
| Sharing and history | Saved, rename/delete (Search app) | Private/Restricted/Public; pin; search; 99 cap (classic) | — | — | Private/Restricted/Public | Cross-device continuity | — |
| Published input/volume caps | 4,000-char prompt; 10 findings per run; ~200/day | 100 alerts default (500 max in 8.17); 10 images × 3.5 MB | 10 concurrent | — | 8 credits per chat | — | — |

---

## 5. How they handle long multi-step investigations without truncating

1. **Move the long work off the interactive turn.**
   - Splunk's SOC analyst agent and Dropzone/Prophet/7AI investigate on ingest. Chat is then a follow-up surface over a
     finished investigation, and the long run never has to fit in one chat answer.
   - Elastic runs Attack Discovery on schedules and lists the runs in a Generations centre. Agent Builder lets several
     conversations run at once and flags **Unread** when one finishes in the background.
   - ExaGo keeps an investigation running after the first reply and streams updates into the transcript.
2. **Show progress as structured events, not as a spinner.**
   - Elastic shows tool-call events with their running or returned state, then a metadata menu with timing and tokens.
   - Elastic's Generations centre shows timing and counts for each step.
   - Exaforce draws a graph of the stages. 7AI writes a report for each step.
3. **Keep heavy evidence out of the context window, but keep it reachable.**
   - Elastic: file store, selective compaction, skill stubs.
   - Dropzone: Evidence Locker with "View Response" for raw data.
   - Elastic Attack Discovery: "2/10" alert counts with a "Show matching alerts only" toggle.
   - In each case the full data is kept, and what the model or the view shows is filtered.
4. **Vendors fail visibly instead of truncating silently.**
   - Elastic reports `context_length_exceeded` and documents how to recover.
   - Splunk says "Send the message again or create a new chat session" and offers the stop icon.
   - Dropzone's **Stopped** state comes with a refresh to retry and no licence charge.
5. **Caps sit on spend and volume, not on answer length.** Splunk requires approval for non-trivial searches in Agent
   Mode and has daily triage caps. Torq charges credits per chat. Elastic's Fast mode trades exactness for cost on
   charts. None of these vendors publishes a per-message output-token ceiling that users would see.

---

## 6. Recommendations for Agentic SOC chat (mapped to the user's asks; checked against AGENTS.md §5)

Context: SPEC §4.2 currently bounds each turn. The defaults are `max_model_calls` 5, `max_tool_calls` 10,
`turn_timeout_s` 90, `turn_token_ceiling` 60k and `final_max_tokens` 4k. SPEC §10.3 adds a "Continue where this stopped
(≈ +N tokens)" chip, and SPEC §7.4 caps blocks, rows and strings. The user wants these limits gone from chat.

| # | Recommendation | Precedent | Guardrail |
|---|---|---|---|
| R1 | **Remove the per-turn caps users can see.** Let the operator set "unlimited" (or very high) values for model calls, tool calls, token ceiling and answer length. Replace the Continue chip with **server-side auto-continuation**: if a final step stops on the length limit, the engine issues further final-only steps and joins them into one streamed answer. | No vendor exposes a per-answer continuation step | #6: every continuation still goes through the gateway and ledger. The **daily budget backstop (#10, `on_exceed="block"`) stays as the only spend bound**. State this honestly in the UI rather than presenting it as a per-message limit. |
| R2 | **Keep big observations out of the prompt.** Hold tool results in a turn or conversation artifact store; the model sees handles and summaries and pulls rows on demand. **Selectively compact** old turns into retrievable summaries so conversations of 30+ turns never hit a context error. Replace "observation shrink" with "store full, project small". | Elastic file store and compaction | #7: aggregates still go to the model, never raw logs. #9: stored results keep their untrusted fencing when pulled back in. |
| R3 | **Run long investigations as background work.** If a turn runs past an interactive budget, hand it to the existing durable Jobs runner. The thread shows live steps. The history rail shows **In progress / Unread / Needs input** badges. The Inbox and SSE fire when it finishes. | Elastic list statuses, Dropzone queue, ExaGo | Jobs are actor-scoped and audit-confirmed already, and the process-local concurrency note still applies. |
| R4 | **Show a "working" signal in the left-hand navigation.** Animate the product mark or the Chat nav item whenever any of the user's turns or jobs is running, and show an Unread dot when one finishes while the user is elsewhere. Honour reduced motion. | Elastic "In progress / Unread" | Motion stays lazy, off the entry path (bundle rule). |
| R5 | **Make the inline step trace richer.** Each tool step shows running then returned, elapsed time, **Parameters sent / Response returned** (fenced), and "View JSON". Add a response metadata popover with timing, tokens and cost per step, extending the token meter. | Elastic chat, 7AI step report | #9 fencing on any displayed log values; RBAC per tool. |
| R6 | **Add evidence chips to citations.** Solid when the query returned data, muted when it returned zero. Hover shows the query; click opens the payload in a side sheet. | Dropzone | Read-only. |
| R7 | **Add an investigation answer template** for "investigate X" intents. Order: verdict-style assessment + one-line reason; **Key findings (top 5)**; **Investigation threads** (question → findings → sources queried → follow-up questions); **Evidence locker**; ATT&CK; recommendations and next steps. Present the assessment as advisory. | Dropzone, Splunk, 7AI | **#3: the chat never closes or escalates; the case decision stays with `decide()`.** |
| R8 | **One-click report to case.** Add message actions **Add to case (note)**, **Generate investigation report**, **Download PDF**, and **Attach to case**. Add default request chips on Case Manager. | Splunk, Elastic | #5: Case Manager chat stays case-scoped. |
| R9 | **Make charts interactive.** Inline time-range change and brush-zoom. A "Preview" side canvas for multi-panel answers, with **Save to dashboard** (Round-5 per-user dashboards) and an outdated-attachment notice if the dashboard changes later. | Elastic Agent Builder | Server-side downsampling, without a hard user-visible cap. |
| R10 | **Ask clarifying questions instead of failing.** For under-specified or failing queries, ask up to 5 multiple-choice questions with "Skip" and a custom answer, and show "Awaiting your input" in the rail. | Elastic | — |
| R11 | **Prompt library and modes.** Categories such as Hunt / Triage / Metrics / Admin. A `/` tool menu in the composer. A Compact/Detailed view toggle. Pin and search conversations. Optional Restricted or Public sharing later. | Splunk, Torq, Elastic | RBAC on shared transcripts (#5 per-user history). |
| R12 | **Batch hunts.** Turn a chat hunt into a saved or scheduled hunt, and add a "related alerts → attack narrative" view that reuses Campaigns. | Prophet, Elastic Attack Discovery | #4: campaigns reference case IDs and never re-cluster. |

Most important precedents: Elastic's inline running/returned tool events and its conversation statuses (R3–R5),
Dropzone's evidence chips and investigation skeleton (R6–R7), Splunk's report-to-case actions (R8), and Elastic's file
store and compaction (R2). Together they let the chat drop its visible caps without hiding work or spending without a
bound.
