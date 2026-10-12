# Round 12 chat synthesis: competitor capabilities, gaps and the feature plan

Synthesis lead, 2026-10-10. Inputs: the five chat research reports in this folder and a code
reading of the current chat (paths are repo-relative, line numbers are from the current
working tree). This document feeds the Round 12 SPEC. It does not change code.

## 0. Inputs, evidence quality and gaps

| Report | Status | Evidence caveats |
|---|---|---|
| `paloalto-qualys.md` | Read in full | Strong (Cortex docs read as Markdown, Qualys ETM docs). No Qualys product named "QAGENT" exists. |
| `microsoft-google.md` | Read in full | Strong (Learn and Google Cloud docs, 2026 revisions). The Security Copilot export formats are not documented on Learn. |
| `amazon-crowdstrike-s1.md` | Read in full | AWS is strong (docs and blogs). CrowdStrike is mostly datasheets and press, so treat it as claims. SentinelOne is a mix of blog and press. |
| `splunk-elastic-agentic.md` | Read in full | Elastic and Splunk are strong (docs). The search budget ran out, so the Splunk AI Assistant 2.2 chart behaviour is **unconfirmed**. The startups (Dropzone, Prophet, Torq, Exaforce, 7AI) are documented for Dropzone and Torq only; the rest are product pages. |
| `chat-ux-standards.md` | Read in full | Claude, Gemini, Apple HIG and WCAG are documented. Several OpenAI and Perplexity pages returned 403. Items marked [Obs] (ChatGPT interactive charts, Perplexity "Related" questions, exact column widths) must be verified before they drive a requirement. |

Other files in the folder (`case-ux.md`, `dashboard-ux.md`, `remember-me.md`, the vendor
dumps) belong to other Round 12 workstreams. This synthesis does not depend on them.

No report is missing.

## 1. Headline findings

1. **No vendor caps answer length or step count in front of the user.**
   - The documented bounds are on spend and volume:
     - Microsoft: SCU capacity.
     - CrowdStrike and SentinelOne: credits.
     - Torq: 8 credits per chat.
     - Google: about 10 TIN investigations per hour.
     - GuardDuty: 10 investigations per day.
   - The other documented bounds are on input or wall clock:
     - Splunk: a 4,000-character prompt.
     - Palo Alto: a 5-minute *action* timeout.
   - Palo Alto states that no chat token, turn or message caps are published, and it shows agent
     cost as non-billable telemetry.
   - Elastic runs "tools in a loop until it reaches its goal or exceeds the maximum conversation
     length".
   - The general leaders replace caps with **auto-continue** (Anthropic's `max_tokens`
     continuation loop) and **compaction** (Claude.ai, Claude Code, Cursor, Elastic's file store
     plus selective compaction).
   - Agentic SOC is the outlier: 5 model calls, 10 tool calls, a 60k-token ceiling, 4k output
     tokens, 90 s per turn and 30 s per model step, a visible "cap" notice and a
     "Continue where this stopped" chip.
2. **The 2026 standard is "show the work, live, everywhere".** Examples: Elastic's inline
   running/returned tool events and its conversation-list statuses (In progress / Awaiting input /
   Unread), Claude Code's agent-view state icons and notifications, Qualys "Watch ROCky Think"
   with retry and explain per step, and Palo Alto's Plan with JSON artifacts. Our run log covers
   the in-thread half. We have **nothing at the navigation level**, and nothing when the user is
   on another page.
3. **Analytical depth is what separates SOC copilots.** Palo Alto (XQL), Splunk (SPL), Elastic
   (ES|QL), SentinelOne (PowerQuery) and Microsoft (KQL, plus the Python-backed Security Analyst
   Agent) answer exact aggregate questions over any range, with calendar buckets and trends.
   Our chat:
   - samples the newest 5,000 cases;
   - clamps windows to 90 days (30 days for case, metric and cost tools);
   - stops bucketing at 1 day;
   - compares only against the immediately previous window.

   This probably explains many of the "queries don't work" reports (see §2.2).
4. **Reports are one click from the conversation at the leaders.** Examples: Splunk "Generate
   investigation report" (file, note or PDF), Microsoft's incident report with PDF export and
   "Post to activity log", the CloudWatch investigation report, and ChatGPT/Gemini/M365
   Researcher reports exported to MD/DOCX/PDF. We have a strong report model and library, but
   getting a brief into the library takes manual "Add to report" clicks, and exports are reported
   as glitchy.
5. **Charts in chat are table stakes. Interactivity is the differentiator.**
   - Microsoft: switchable chart type and grouping.
   - Elastic: time-range change, brush zoom, a dashboard preview canvas, and "Save".
   - Palo Alto: edit by follow-up, then save to the Widget Library.

   Our block set is already broad. What it lacks: regrouping, zoom, comparison charts, saving to
   a dashboard, and using the width the collapsed navigation frees (blocks are capped at 64rem).
6. **Clarify instead of fail** is documented by Microsoft (Defender Chat, up to 4 quick picks),
   Elastic (up to 5 multiple-choice questions with Skip and a custom answer) and AWS (Q asks for
   missing details; the SIR agent auto-proceeds after 10 minutes). We have no clarify path.
7. **Every vendor keeps chat read-only, or approval-gated, and RBAC-scoped.** Our 12
   non-negotiables already match the market's governance model. None of the recommended features
   needs to relax #1, #2, #3, #5, #7 or #9. One item, the daily budget for chat, needs an explicit
   operator decision under #6/#10 (§4, D-1).

## 2. The current chat in brief (evidence for the matrix)

### 2.1 What exists

- **Engine.** One `ChatEngine` with a text-JSON ReAct loop:
  - `backend/app/agents/chat.py:1254-1365` (`_AgentTurn.run`);
  - stream events `turn.start/step.start/step.end/usage/text.delta/text.reset/turn.done/turn.error/ping`
    in `backend/app/agents/chat_events.py`;
  - Stop through `POST /api/chat/turns/{id}/cancel` (`backend/app/api/routes_chat.py:1099`);
  - a process-local `ChatTurnRegistry` (`routes_chat.py:238`) that lets a turn finish after a
    client disconnect.
- **Tools** (`backend/app/agents/chat_tools/*.py`, 17):
  - logs: `search_logs`, `log_stats`;
  - cases: `search_cases`, `get_case`, `shift_report`, `list_campaigns`, `explain_decision`;
  - metrics: `soc_metrics` (kinds posture, trends, noise_funnel, case_mix, timing, mitre_coverage,
    auto_close_health, agent_improvement, feedback), `cost_usage`;
  - intel: `lookup_indicator`, `mitre_lookup`, `search_knowledge`;
  - ops: `source_health`, `automation_status`, `audit_search`;
  - docs: `app_help`, `app_status`.

  RBAC is enforced per tool (`registry.py`). Indicator taint lives in `taint.py`.
- **Blocks** (`backend/app/agents/blocks.py`, SPEC §7.2):
  - `markdown`, `kpi_group` (gauge), `chart` (bar, hbar, stacked_bar, line, area, donut,
    sparkline, funnel), `heatmap`, `table`, `case_list`, `timeline`, `entity`, `mitre`, `query`,
    `callout`, `citations`, `guide`, and the `report` brief envelope;
  - a client view switcher (`webui/src/soc/chat/blocks/views.ts`);
  - per-block Expand sheet, Copy data and CSV/JSON (`blocks/BlockCard.tsx:381-583`).
- **Workspace** (`webui/src/soc/chat/**`):
  - history rail with Pinned/Today/… groups, server content search
    (`GET /api/chat/conversations?q=`, `backend/app/api/routes.py:1743`), pin, rename, export and
    delete;
  - composer with `/` commands (`composer/commands.ts`), `@` scopes, saved prompts (≤ 50),
    model picker (`ComposerOptions.tsx`), token meter and budget ring;
  - 6 server-built starters;
  - follow-up chips (≤ 3, model-written);
  - memory proposals (`MemoryLine.tsx`);
  - Sources/citations; Report panel, Reports library, AI summary and MD/HTML/Print/CSV/JSON exports
    (`report/**`);
  - case-scoped chat in Case Manager.
- **App help.** The bundled Help Center corpus answers at $0 when AI is unavailable (SPEC §5.4.1).

### 2.2 Hard limits behind the operator's complaints (code-verified)

| Limit | Where | Effect the user sees |
|---|---|---|
| `max_model_calls` 5, `max_tool_calls` 10, `turn_token_ceiling` 60,000, `final_max_tokens` 4,000, `turn_timeout_s` 90, `model_step_timeout_s` 30, `observation_chars` 6,000 | `backend/app/config.py:1551-1587` (`ChatAgentConfig`) | "Reached this question's limit…", "Answer cut at the output limit", "Stopped at the time limit…" (`backend/app/agents/chat_protocol.py:893-903`) and the "Continue where this stopped (≈ +N tokens)" chip (SPEC §10.3) |
| History replay: newest 12 exchanges / 24,000 chars; older ones are dropped | `backend/app/agents/chat_events.py:126-127`, `chat_protocol.py:529-541` | Long threads forget early context |
| The model's own previous reply is echoed truncated to 4,000 chars | `chat.py:167`, `chat.py:1391-1394` | Multi-step reasoning loses text |
| Window clamp at 90 days | `backend/app/agents/chat_tools/common.py:156,281-282` | "Last 6 months" or "all time" silently becomes 90 days |
| `window_hours ≤ 720` (30 days) for `search_cases`, `soc_metrics`, `cost_usage`, `audit_search`; `metric_window` caps engine metrics at 30 days | `cases.py:105`, `metrics.py:135-157,178,834`, `ops.py:540` | Longer metric questions are narrowed |
| Cases filtered in memory over the newest 5,000 (`CASE_SCAN_LIMIT`), labelled "lower bound" | `cases.py:54,245-326` | No exact lifetime totals |
| Cost over the newest 5,000 usage records | `metrics.py:737-752` | Cost history is truncated |
| Log intervals `5m…1d` only; metric buckets 1h/6h/1d | `logs.py:140`, `metrics.py:74` | No by-week or by-month breakdowns |
| Exact log aggregates only on Elastic/OpenSearch/Wazuh, otherwise the newest 200 events per source | `logs.py` docstring, `logs.py:80` | Sampled answers on other sources (labelled) |
| Comparison is only `compare_previous` (the previous equal window, as a KPI delta) | `metrics.py:179` | No month-vs-month, year-over-year or custom A-vs-B |
| Blocks max 64rem, prose 48rem, whatever the free width | `webui/src/soc/chat/message/lane.ts` (`LANE_GRID`) | The chat does not use the full screen when the menus are collapsed |
| Storage: 16 kB per stored presentation, 256 kB per conversation, 100 messages, 50 conversations (+10 pinned) | `backend/app/stores/chat_conversations.py:103-105` | Long unbounded answers would evict history faster |
| No conversation-level or app-level running state | (absent) | No "agent working" indicator in the left navigation |

Likely causes of "some queries don't even work". These are hypotheses for the diagnosis
workstream to confirm:
- **30 s per model step** is short for reasoning models, so a slow step shows as "Model call
  failed".
- **One of the 5 model calls** can be used by a format correction.
- **Windows over 30 or 90 days are narrowed**, and "by month" cannot be expressed.
- **Case counts are lower bounds.**
- **There is no clarify path**, so a vague question gets a weak answer instead of a question back.

## 3. Capability matrix

Vendor columns:
- **PA**: Palo Alto (XSIAM/AgentiX Agentic Assistant, Prisma Copilot).
- **QL**: Qualys (ROCky, task agents).
- **MS**: Microsoft (Security Copilot, Defender).
- **GG**: Google SecOps (Gemini).
- **AW**: AWS (Amazon Q, GuardDuty/SIR/CloudWatch agents, Security Hub MCP App).
- **CS**: CrowdStrike Charlotte.
- **S1**: SentinelOne Purple.
- **SP**: Splunk.
- **EL**: Elastic.
- **SU**: startups (Dropzone, Prophet, Torq, Exaforce, 7AI).
- **GL**: general AI leaders (Claude, ChatGPT, Gemini app, M365 Copilot, Perplexity, Cursor).

Cells:
- **D**: documented.
- **P**: partial or indirect.
- **M**: marketing or press only.
- **–**: not found.

The Agentic SOC column reads **Yes**, **Partial** or **No**, with file evidence.

### 3.1 Questions, analysis and agent loop

| # | Capability | PA | QL | MS | GG | AW | CS | S1 | SP | EL | SU | GL | Agentic SOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | NL question → native query, with the query visible | D | P | D | D | P | D | D | D | D | D | – | **Partial.** Structured `StructuredQuery` params and the exact native query in the run log; `query` block with Copy query and Open in Logs (`chat_tools/logs.py`, `message/RunLog.tsx`, `blocks/BlockCard.tsx`). No edit-and-rerun. |
| 2 | Multi-step loop with live steps | D | D | D | D | D | M | D | D | D | D | D | **Yes.** `chat.py:1254-1365`, `RunLog.tsx`, `step.start/step.end` events. |
| 3 | Step drill-down: inputs and outputs, retry or explain a step | D (JSON artifacts) | D (retry, explain) | P | D (hunt steps) | – | D (response details) | P | D (Analysis Details) | D (Parameters/Response/View JSON/trace) | D (Dropzone chips, 7AI request/response) | – | **Partial.** Param chips, summary, duration, basis/coverage, exact query. No response payload, retry-step or explain-step. |
| 4 | No user-visible per-answer step/token cap | D | D | D | D | D | P (credits) | P (credits) | D | D | P (Torq credits/chat) | D | **No.** `config.py:1551-1587`; cap/length/timeout notices (`chat_protocol.py:893-903`); Continue chip (SPEC §10.3). |
| 5 | Auto-continue when output hits the model limit | – | – | – | – | – | – | – | – | – | – | D (Anthropic loop; Claude Code) | **No.** A `length` notice instead (`chat.py:2057`). |
| 6 | Context compaction instead of dropping history | – | – | – | – | – | – | – | – | D (file store, selective compaction) | P (Dropzone evidence locker) | D | **No.** 12 exchanges / 24k chars (`chat_events.py:126-127`). |
| 7 | Long investigation as background or async work with status | – | D (tasks) | D (Security Analyst, TI briefing) | D (TIN, Threat Hunt) | D (GuardDuty agent, CloudWatch) | M | D | D (pre-run agent) | D (Attack Discovery generations, concurrent chats) | D (Dropzone queue) | D (deep research) | **No.** No chat job kind (`constants.py:672-687`); the server turn survives a disconnect (`routes_chat.py:238`). |
| 8 | Arbitrary or long time windows, calendar periods | D | D ("last 180d", "last quarter") | D | P (hunt ≤ 30 d) | P (trends 5 d–1 y) | – | D | D | D | – | – | **Partial.** 90-day clamp (`common.py:156,281`); 30 days for cases, metrics and cost (`cases.py:105`, `metrics.py:135-178`). |
| 9 | Exact full-population aggregates | D (XQL) | P | D (KQL) | D (UDM) | P | – | D (PowerQuery) | D (SPL) | D (ES\|QL; Fast mode labelled sampled) | – | – | **Partial.** Logs exact on ES/OS/Wazuh only; cases are the newest 5,000 (`cases.py:54`); cost is the newest 5,000 (`metrics.py:737`). |
| 10 | Calendar buckets (week, month, quarter, year) | D | P | D | D | D (Security Hub trends) | – | D | D | D | – | – | **No.** `logs.py:140`, `metrics.py:74`. |
| 11 | Period-over-period comparison | P | D ("fixed vs open in last 180d") | D (Security Analyst trends) | – | P | – | – | P | D (Attack Discovery trends) | – | P | **Partial.** Previous equal window only, as a KPI delta (`metrics.py:179`). |
| 12 | Analytic engine (trend, anomaly, clustering, forecast) over results | – | – | D (Security Analyst Agent, Python) | – | – | M | – | – | – | – | P | **No.** Deterministic aggregates only. |
| 13 | Clarifying questions with quick picks | P (clarifies ambiguity) | – | D (≤ 4 options) | P ("no valid query") | D (asks for missing info; SIR auto-proceeds) | – | – | P | D (≤ 5 MCQ, Skip, custom) | – | D (M365 Researcher) | **No.** |
| 14 | Page or entity context ("Ask AI" on an entity) | D | – | D | D (pane) | D (Detective pane) | M | D (alert view) | D | D (flyout, Add to chat) | D (investigation-scoped chat) | – | **Partial.** "Ask about this" for KPI/settings topics (`components/AskAboutThis.tsx`, `/api/chat/topics`), Case Manager chat, palette "Ask AI". No entity chips. |
| 15 | Agent or mode picker | D | – | P (plugins) | – | – | M | – | P (Agent Mode) | D (skills) | D (Torq) | – | **Partial.** `@` scopes narrow the tools (`composer/Composer.tsx`). |
| 16 | Per-chat model choice | D | – | – | – | – | D (BYO model) | – | D (internal/external) | P | – | D | **Yes.** `composer/ComposerOptions.tsx`. |

### 3.2 Output: charts, briefs, reports

| # | Capability | PA | QL | MS | GG | AW | CS | S1 | SP | EL | SU | GL | Agentic SOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17 | Charts in chat | D (all platform types) | – | D (hunting observations) | – | D (Q artifacts) | M | – (table and narrative) | – (unconfirmed) | D (inline Lens/Vega) | P | D | **Yes.** 8 chart kinds, heatmap, KPI gauge, timeline, MITRE (`blocks.py`, `blocks/charts/*`). |
| 18 | Change chart type, grouping or time in place | D (modify, filter) | – | D (type and grouping) | – | D (filter, sort) | – | – | – | D (time range, brush zoom) | – | P | **Partial.** View switcher over `allowed_views` (`blocks/views.ts`). No regroup, zoom or time change. |
| 19 | Save a chat chart to a dashboard | D (Widget Library) | – | – | – | – | – | – | – | D (Save dashboard) | – | – | **No.** Custom dashboards exist (`api/routes_dashboards.py`) but there is no chat path. |
| 20 | Wide or full-screen viewing | – | – | P (Open in Security Copilot) | – | D (maximize, divider) | – | – | – | D (Preview canvas) | – | D (canvas, artifacts, DR viewer) | **Partial.** Expand sheet per block and a report split panel; blocks capped at 64rem (`message/lane.ts`). |
| 21 | Investigation brief: verdict, confidence, key findings, limiting factors, next steps | P | – | D (incident summary) | D (TIN) | D (GuardDuty, SIR "limiting factors") | M | D/M | D | D (Attack Discovery) | D (Dropzone skeleton) | – | **Partial.** `get_case` and `explain_decision` blocks; `investigation` report template. No advisory brief with limiting factors. |
| 22 | Executive vs technical summary | D | D | D | P | – | M | – | P | – | P (Torq) | D | **Partial.** Report AI summary is executive-only (`chat_protocol.py:1078-1080`). |
| 23 | Report from chat into a saved document in one action | – | – | D (incident report, promptbook) | – | D (CloudWatch report) | M | M | D (investigation/finding report) | P (Add to case) | M | D (DR report) | **Partial.** Brief block, `/report` templates, "Add to report", Report panel and library, AI summary (`api/routes_reports.py`, `chat/report/**`). No one-action save. |
| 24 | Export: MD, PDF, DOCX, spreadsheet | – | – | D (Excel per table, PDF) | P (Docs export) | – | – | M | D (PDF) | – | – | D (MD/DOCX/PDF) | **Partial.** MD, HTML, Print/PDF, CSV and JSON (`chat/report/export/*`). No DOCX/XLSX; downloads reported glitchy. |
| 25 | Post an answer to a case | P (War Room entry) | – | D (Post to activity log) | – | D (SIR comment) | – | – | D (Add as note) | D (Add to case) | D (Torq note) | – | **No** for Workspace answers. |
| 26 | Citations and deep links | D | – | D | D | D | D | P | P | D | D | D | **Yes.** `message/SourcesDisclosure.tsx`; D*/K* citations; console links. |

### 3.3 Conversation management and status

| # | Capability | PA | QL | MS | GG | AW | CS | S1 | SP | EL | SU | GL | Agentic SOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 27 | History with time buckets, rename and delete | D (186 d) | D | D | D | D (1,000 / 90 d) | – | P (notebooks) | D | D (99) | P | D | **Yes.** `workspace/HistoryRail.tsx`; 50 + 10 pinned (`chat_conversations.py:103`). |
| 28 | Search past chats | – | – | – | – | – | – | – | – | D | – | D | **Yes.** `routes.py:1743`. |
| 29 | Pin | – | – | D (pin board) | – | – | – | – | – | D | – | D | **Yes.** |
| 30 | Share a conversation (read-only) | – | – | D (link; static-display warning) | – | P (CloudWatch) | M | D (notebooks) | – | D (Private/Restricted/Public) | D (Torq) | D | **No** (per-user by design, #5). |
| 31 | Branch, or edit an earlier prompt | – | – | D (edit or delete prompt) | – | – | – | – | – | – | – | D | **Partial.** ↑ recalls the last prompt only. |
| 32 | Per-conversation status (in progress, unread, needs input) | – | – | – | – | – | – | – | – | D | D (Dropzone queue) | D (Claude Code, Projects) | **No.** |
| 33 | App-level "working" indicator and completion notice | – | – | P (agent activity) | – | – | – | D/M (live in Alerts) | P (unavailable states) | D (list statuses) | M (ExaGo) | D (Claude Code, Gemini notice, ChatGPT DR) | **No.** |
| 34 | Reattach to a running turn after navigating away | P | – | – | – | – | – | – | – | D (concurrent conversations) | – | D | **Partial.** The turn completes server-side; the client replays the final answer only (SPEC §6.4). |

### 3.4 Guidance, feedback and governance

| # | Capability | PA | QL | MS | GG | AW | CS | S1 | SP | EL | SU | GL | Agentic SOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 35 | Starters or quick starts | D (≤ 4 per agent) | D (5) | D | – | D | – | D (Quick Starts) | D | D (prompt tiles) | – | D | **Yes.** 6 starters (SPEC A8). |
| 36 | Prompt library: categories, shared, parameterised | D (AI Prompts) | D (5 categories) | D (promptbooks, `<params>`, org share) | – | D (book icon) | M (shareable promptbooks) | D | D | D (system prompts) | D (Prophet hunt library) | P | **Partial.** Personal saved prompts ≤ 50 (`composer/SavedPrompts.tsx`) and `/` commands. |
| 37 | Follow-up suggestions | D | D | D | D | – | M | D | D | – | – | D (adaptive back-off) | **Yes.** ≤ 3 chips (`message/FollowUps.tsx`). |
| 38 | Answer feedback | D | D (trains) | D (3-way + text) | D | D | – | – | D | – | D | D | **No** for chat answers. |
| 39 | Governed memory ("teach the agent") | D (knowledge sources) | – | D (lessons with conflict check) | – | P (learned skills) | M | – | P (Teach AI beta) | D (KB) | D (Dropzone context memory) | D | **Yes.** Proposals with human approval (`message/MemoryLine.tsx`, #9). |
| 40 | Product help with live diagnostics | D (Help Center agent) | – | – | D (docs) | – | D | D | D | – | – | – | **Yes.** `app_help` + `app_status`; $0 fallback. |
| 41 | Read-only or approval-gated actions | D | D | D | D | D | D | D | D | D | D | – | **Yes.** Structural read-only tools; `decide()` untouched (#3). |
| 42 | RBAC visible to the user | D | D | D (greyed actions) | – | D (IAM) | M | – | D | D | – | – | **Yes.** `composer/AccessPopover.tsx`. |
| 43 | Cost or usage per request | D (evaluated cost) | – | D (SCU dashboard) | P (token dashboard) | – | D (credits) | M (credit balance) | – | D (token metadata) | D (Torq credits) | D (context %) | **Yes.** Token meter, usage card, budget ring (SPEC §8). |
| 44 | Spend governed by budget, not answer truncation | D | – | D | D | D | D | D | D | D | D | D | **Partial.** The daily budget blocks chat *and* per-turn caps truncate. |
| 45 | Documented prompt-injection defence | – | – | – | – | – | – | – | D | P (anonymisation) | – | – | **Yes.** #9 fencing, taint ledger (`chat_tools/taint.py`), marker normaliser (SPEC §7.6). |
| 46 | MCP server or client | D | – | D | D | D | D | D | – | D | – | D | **No.** Out of scope (AGENTS.md: 0.1.13 ships no MCP server). |
| 47 | Slack/Teams, voice, mobile | D (Slack) | D (voice) | – | – | D (chat apps) | – | – | – | – | M (ExaGo voice) | D | **No.** |

## 4. Prioritized new chat features for Round 12

Every item below has been checked against AGENTS.md §5:
- **#1:** read-only, scoped log key; no new log write path.
- **#2:** every tool call audited.
- **#3:** chat never closes or escalates.
- **#5:** one engine; case chat stays case-scoped.
- **#6:** every model call, including continuations, compactions and summaries, goes through
  `LLMGateway` with exactly one UsageDoc.
- **#7:** models see aggregates, never raw logs.
- **#9:** every log- or model-derived string is fenced and taint-ruled.
- **RBAC:** enforced per tool and per route.

UI rules: no new npm runtime dependencies, chat code stays in lazy chunks, the entry-chunk
budget applies, and Demo Mode must demo every feature at $0 with deterministic transcripts.

### P0 (this round; each maps to an explicit operator ask)

#### P0-1 Unbounded multi-step investigations (auto-continue, no step/token caps)

- **Precedent.** No competitor shows per-answer caps (§1, finding 1).
  - Anthropic documents continuing automatically on `max_tokens`.
  - Elastic loops "until it reaches its goal".
  - Palo Alto bounds only a 5-minute *action*.
- **User story.** As an analyst I ask a broad question ("investigate everything related to
  10.0.4.7 over the last quarter and tell me what happened"). The assistant keeps working until it
  has an answer, however many lookups and words that takes. I never see "reached this question's
  limit" or a Continue chip, and I can Stop at any time.
- **Invocation.** Any question. No new control.
- **UI output.**
  - The run log grows as needed.
  - The header reads "Working · 14 lookups · 38.2k tokens · $0.31", updating live.
  - A continued final shows one quiet run-log row: "Continued the answer (part 2)".
  - The answer streams as one piece.
  - The "Continue where this stopped" chip and the `cap` and `length` notices are removed from
    the client. `origin: "continue"` stays accepted on the wire for old clients but is never sent.
- **Backend changes.**
  1. `ChatAgentConfig` (`config.py:1534`):
     - `max_model_calls`, `max_tool_calls`, `turn_token_ceiling`, `turn_timeout_s` and
       `final_max_tokens` become `int | None`, defaulting to `None` (meaning unlimited).
     - `_repair` keeps clamping set values and accepts `None`.
     - A one-time `chat_limits_version` migration (the `autopilot_config_version` pattern) turns
       stored values that equal the old defaults (5/10/60,000/90/4,000) into `None` and keeps
       explicit operator overrides.
     - The Settings → General → Chat assistant editor shows an "Unlimited" switch per knob.
  2. `model_step_timeout_s` defaults to 300 (reasoning models). It is a per-call stall guard,
     not a length limit.
  3. Each step requests the model's maximum output (from the model catalogue). On
     `finish_reason == "length"` the engine runs a **continuation step** through the same
     gateway entry point:
     - append the partial body as the assistant turn, plus a fixed `CONTINUE_INSTRUCTION`
       ("Continue exactly where you stopped; do not repeat text; do not restart the header");
     - stitch the bodies;
     - keep streaming `text.delta` (no `text.reset`).
     - If the cut falls inside the protocol header, re-run that step once with a larger output
       budget, then treat the reply as a plain-text final.
     - The parser rules (§4.1.1) gain "a continuation never carries a header".
  4. **Loop guard** (correctness, not a cap):
     - A repeated identical `(tool, canonical params)` call returns "already ran → reuse mK.aJ"
       instead of executing again.
     - Three consecutive model steps that add no new artifact and request no new tool force a
       final-only step, with the notice "Stopped repeating the same lookup".
     - Three continuation steps that add under 50 characters each end the answer with a
       `partial` notice.
  5. `observation_chars` scales with the model's context window (structural shrink only, as
     today). Older observations are handled by P0-2.
  6. `_echo` stops truncating the model's own reply at 4,000 chars (`chat.py:1391`); compaction
     handles growth instead.
  7. **Persistence.**
     - Assistant answer text is stored in full.
     - The 256 kB conversation budget and the 16 kB per-presentation budget
       (`chat_conversations.py:103-105`, SPEC §7.5) are revised so a long answer never evicts
       text. Recommended approach: per-exchange KV documents under the existing namespace (no new
       index or table).
     - Blocks keep today's compact-storage rules; their "View full result" re-runs the
       deterministic tool, not the model.
  8. Concurrency (`max_concurrent_turns_per_user` 2, global 8) is a capacity bound, not a token
     limit; see D-2. nginx `proxy_read_timeout 120s` on `/api/chat/stream`
     (`webui/nginx.conf:52`) is safe because pings arrive every 10 s (`chat_events.py:61`).
     Add a test so a 10-minute turn never ends on a proxy timeout.
- **Acceptance criteria.**
  - A scripted FakeProvider turn that needs 14 tool calls and 9 model steps completes with no
    `cap`, `length` or `timeout` notice.
  - A final cut three times by `finish_reason="length"` arrives as one stitched answer with no
    duplicated sentences. Exactly 4 UsageDocs are written, each with `surface="chat"`.
  - The loop guard ends a scripted infinite repeat within 3 steps, with its notice.
  - Stop still ends the turn after the in-flight call. The work so far is persisted and replays
    as "Stopped".
  - The migration leaves an explicitly set `max_tool_calls: 25` unchanged and turns a stored 10
    into `None`.
  - A 60,000-character answer survives storage and replay byte-for-byte.
  - `grep -r "Continue where this stopped" webui/src` returns nothing.

#### P0-2 Auto-compaction (cross-turn history and intra-turn observations)

- **Precedent.** Elastic (file store and selective compaction, more than 30 turns), Claude.ai
  ("summarizes earlier messages to continue the conversation seamlessly"), Claude Code
  (auto-compact, "Conversation compacted") and Cursor (made summarisation visible).
- **User story.** In a 40-exchange hunt I refer back to "the host from the start" and the
  assistant still knows it. No context-length error ever ends my thread.
- **Invocation.** Automatic. It can also be forced with `/compact` (P1 command).
- **UI output.**
  - One quiet transcript divider at the boundary: "Earlier messages were summarised to keep
    going". Its disclosure shows the summary as untrusted text.
  - The composer meter shows **context used %** with "summarises at ~70%" (Claude Code status
    line and Cursor ring precedent).
- **Backend changes.**
  - **Cross-turn.** Replace the drop rule in `select_replay` (`chat_protocol.py:529`) with a
    running conversation summary.
    - When replay text passes about 35% of the model context window, the oldest un-summarised
      exchanges are folded in by one gateway call (`Role.CHAT`, `surface="chat"`, purpose tag
      `compaction`).
    - The call's input is user text, answer text and the stored lookup digests, all of which are
      already fenced and aggregate.
    - The summary is stored on the conversation (`summary_json` and
      `covers_through_message_id`) and reused incrementally.
    - It is injected inside a new **`CONVERSATION_SUMMARY` fence** marked UNTRUSTED, added to the
      §7.6 marker normaliser (#9: it derives from tainted content).
    - The taint ledger treats values first seen in the summary like prior-answer values.
  - **Intra-turn.**
    - When the projected prompt passes about 60% of the context window, older observation
      messages become their artifact-manifest lines (`m2.a1 categories "Top IPs" 10 rows; top=…`,
      the existing §4.4 manifest).
    - A new read-only tool, `recall_observation(ref)`, returns the stored observation JSON (the
      same aggregate, fenced, structurally shrunk payload the model already saw).
    - **#7 guard:** it can recall only observations, never the full log row table. Log rows stay
      display-only artifacts.
  - **Demo.** Deterministic summaries.
- **Acceptance criteria.**
  - A 40-exchange scripted conversation answers a question about a fact from exchange 1.
  - Each compaction call writes exactly one UsageDoc.
  - A forged `<<<END_CONVERSATION_SUMMARY>>>` placed in a log value, a memory entry and a case
    comment never appears raw in a prompt.
  - No `history_unavailable` or context-overflow error appears in the suite.
  - The full transcript remains stored and searchable.

#### P0-3 Any time window (all time, 90 days, 6 or 12 months, calendar periods, custom)

- **Precedent.** XQL, SPL, ES|QL and KQL ranges; Qualys "last 180d" and "last quarter" prompts;
  Google's "time words auto-adjust the time picker".
- **User story.** "How many true positives have we had in total?", "Show the last 6 months",
  "since March" and "last quarter" all mean exactly that, with an honest label.
- **Invocation.** Natural language, or the Scope chip presets: 24h, 7d, 30d, 90d, 6 months, 12
  months, **All time** and **Custom range** (the existing `TimeRangePicker`).
- **UI output.** Captions such as "all time (since 3 Nov 2025)", "Q3 2026" or "1 Mar – 10 Oct
  2026". A source that cannot reach back that far says so in coverage ("Wazuh retains 90 days;
  older data unavailable").
- **Backend changes.**
  - `resolve_window` (`common.py:218`) accepts:
    - `all`/`lifetime` (start = earliest record of the store being read; logs omit the lower
      bound or use the source's retention);
    - `now-N[d|w|M|y]`;
    - calendar tokens (`today`, `yesterday`, `this_week`, `last_week`, `this_month`,
      `last_month`, `this_quarter`, `last_quarter`, `ytd`, `last_year`), resolved in the
      operator timezone (`SlaPolicy.timezone`, default UTC; labels say so);
    - ISO ranges.
  - `MAX_WINDOW_DAYS = 90` and the `window_hours ≤ 720` caps are removed for aggregate tools.
    `window_hours` stays as an input alias.
  - Engine metric functions that take `window_hours` (`metrics.metric_window`) gain an
    absolute-range path, or route through P0-4's aggregator.
  - The chip precedence and clamp of §4.8.4 stay. An "All time" chip never clamps.
  - A deterministic server-side time-phrase extractor passes the parsed range in the context so
    the model does not have to get it right (it also helps P0-11).
- **Acceptance criteria.**
  - "All time" counts equal a direct store COUNT on SQLite, PostgreSQL and ES fixtures.
  - "Last 6 months" produces a window of exactly 6 calendar months in the operator timezone.
  - No silent narrowing: every narrowing appears in the caption and in coverage.
  - The chip clamp still wins over a model-requested wider window.

#### P0-4 Exact full-population aggregates (no 5,000-case or 5,000-record sampling)

- **Precedent.** Every query-language copilot. Elastic labels its sampled Fast mode explicitly.
- **User story.** "What share of all cases this year were auto-closed as false positives, by
  rule?" gives an exact answer over every case, not "a lower bound over the newest 5,000".
- **Invocation.** Natural language. The model calls a new tool.
- **UI output.**
  - KPI, category and series blocks with `basis: exact` (or `point_in_time`) and a caption such
    as "118,402 cases · exact".
  - While a large scan runs, the run-log row shows progress ("Counted 42,000 of 118,402
    cases…").
  - The "lower bound" captions disappear from aggregate answers.
- **Backend changes.**
  - **New tool `case_stats`** (scope `cases`, requires `cases:read`).
    - Inputs:
      - the `search_cases` filters;
      - `group_by` (≤ 2 of verdict, status, status_group, severity, priority, rule, assignee,
        source, surface, disposition, mitre_tactic, mitre_technique, decided_by);
      - `bucket` (none/hour/day/week/month/quarter/year);
      - `metrics` (count, auto_closed, human_closed, fp_rate, tp_rate, mtta/mttr/mttd p50 and
        p90, mean_risk);
      - `top_n` (≤ 50, with an exact "Other" remainder);
      - a window (P0-3);
      - `compare` (P0-6).
    - Output: `categories`, `series`, `kpis` and `table` artifacts. The observation holds
      aggregates only (#7).
  - **Store surface.**
    - An optional `CaseStore.aggregate(spec) -> AggregateResult | None`, detected with
      `getattr` exactly like `PullConnector.aggregate`, so third-party repositories keep
      working.
    - Native push-down:
      - ES: terms/composite plus `date_histogram` with `calendar_interval` and `time_zone`,
        only on aggregatable mapped fields. The bootstrap never remaps, so it returns `None`
        otherwise.
      - SQL: `GROUP BY` over the JSON documents (`json_extract` on SQLite, `->>` on PostgreSQL).
    - Fallback: a streaming reduce over `export_page` (`stores/base.py:445`; ES uses PIT with
      `search_after`, `stores/cases.py:265`) in pages of 1,000, keeping only counters (memory
      grows with the number of groups, not the number of cases) and reporting the store's
      consistency (`point_in_time` or `bounded_at_start`).
  - **Progress.** Add a new stream event, `step.progress {index, done, total?}`, to the
    `chat-stream-events.contract.json` on both sides. Aggregate tools get their own long per-call
    budget (default 600 s, cancellable by Stop) instead of the 15 s `tool_timeout_s`.
  - `search_cases` keeps listing rows, but its counts and totals come from the aggregator.
    `soc_metrics` kinds `case_mix`, `timing` and `posture` use it for windows beyond the
    dashboard's 5,000-case page.
  - **Cost.** `cost_usage` gets the same treatment (`UsageStore.aggregate` with an
    `export_page` fallback; group by day, week, month, role, model or surface), replacing the
    5,000-record read (`metrics.py:737`).
  - **Demo.** The demo stores implement `aggregate` deterministically.
- **Acceptance criteria.**
  - On a seeded 12,000-case store, every `case_stats` grouping equals ground truth on all three
    backends, with no "lower bound".
  - A 100,000-case SQLite fallback scan completes and shows progress events.
  - A store failure mid-scan yields a `partial` notice with the counted share, never a smaller
    number presented as exact.
  - RBAC: without `cases:read` the tool is absent from the catalogue and from the access popover
    status.

#### P0-5 Calendar breakdowns: group by day, week, month, quarter or year

- **Precedent.** `bin span=1mon` (Splunk), `date_histogram` (Elastic), XQL `bin`, and Security Hub
  trend widgets.
- **User story.** "Alerts by month for the last year", "cases per week this quarter", "AI spend
  by month".
- **UI output.**
  - A line or bar chart with period labels ("Mar 2026", "W14 2026").
  - Zero-filled buckets, plus a table view with a Total row.
  - A partial current period is marked "(in progress)".
- **Backend changes.**
  - `LogStatsInput.interval` (`logs.py:140`) adds `1w`, `1M`, `1q` and `1y`. These map to
    `calendar_interval` week/month/quarter/year in the Elastic and OpenSearch `aggregate`;
    Wazuh goes through OpenSearch. The sample fallback labels its basis.
  - Cases and cost use P0-4's `bucket`.
  - `soc_metrics trends` takes `bucket`.
  - ISO weeks start on Monday. The timezone is the operator timezone. Auto-bucket picks the
    smallest calendar unit that keeps ≤ 200 points (`MAX_POINTS`).
- **Acceptance criteria.**
  - 12 monthly buckets for "the last 12 months", with correct month boundaries in a non-UTC
    timezone fixture.
  - Week numbering matches ISO-8601.
  - The current-period flag is set.
  - Bucket sums equal the window total.

#### P0-6 Period comparisons

- **Precedent.** Qualys "fixed vs open in last 180d" and Risk Removal Velocity, Elastic Attack
  Discovery trends, and Microsoft's Security Analyst trend analysis.
- **User story.** "Compare this month with last month for case volume and FP rate", "Q3 vs Q2 by
  rule", "this week vs the same week last year".
- **Invocation.** Natural language, or `/compare` (an optional command).
- **UI output.**
  - A KPI group with absolute and percentage deltas ("vs Sep 2026").
  - A **grouped bar** (new chart kind) per category.
  - A delta table (category · A · B · Δ · Δ%).
  - Small-sample cells are flagged ("n < 20"). Month-over-month adds a Δ column to monthly
    tables.
- **Backend changes.**
  - A `compare` input on `case_stats`, `log_stats`, `soc_metrics` and `cost_usage`:
    `previous_period | same_period_last_year | {from, to}`, or `periods[]` (≤ 4).
  - A new artifact kind `comparison`, materialised to `kpi_group` (with deltas), `chart` kind
    `grouped_bar` (allowed views grouped_bar, hbar, table) and `table`.
  - Deltas are computed in code. The model only narrates them.
  - BLOCKS contract update on both sides.
- **Acceptance criteria.**
  - Every comparison number equals two independent exact `case_stats` calls.
  - Δ% for a zero baseline is shown as "new", never ∞ or NaN.
  - The grouped bar is keyboard-navigable and has an sr-only table.

#### P0-7 Report generation from chat into the Reports library

- **Precedent.** Splunk "Generate investigation report" (file, note or PDF), Microsoft's incident
  report and promptbook executive report, CloudWatch's investigation report, and ChatGPT, Gemini
  and M365 Researcher reports.
- **User story.** "Create a monthly SOC report for September 2026" produces a finished report in
  Reports, with charts, comparisons, top cases and an executive summary, that I can open, edit and
  export. I do not have to click Add to report twelve times.
- **Invocation.**
  - Natural language ("create a report…", "make this a report").
  - `/report <template>`, with new templates `executive` and `monthly`.
  - "Save as report" on any Brief block.
  - Thread ⋯ → "Save conversation as report".
- **UI output.**
  - Under the answer: "Saved to Reports · *September 2026 SOC report* · Open · Export ▾".
  - The Report panel opens in split mode where it fits.
  - The library row appears immediately.
- **Backend changes.**
  - The final header may carry `report: {title, template}`. After persistence the server, not
    the model, creates the report from the persisted message through the existing server-resolved
    `/api/reports/add` path:
    - owner-scoped and CAS;
    - brief sections expanded into items;
    - `ChatResponse.saved_report {id, title, items}` returned;
    - an optional summary generated in the same flow (one gateway call, `surface="report"`, the
      existing §9.4 digest).
  - Review `MAX_REPORT_ITEMS`/`MAX_REPORT_LEAVES` (40) against the monthly template. Recommended:
    60 items, 60 leaves.
  - Case-scoped turns can never create one (§9.2 is unchanged).
  - Export reliability is fixed in the same package, with the root causes from the diagnosis
    workstream. Every format is verified by test: the file opens, all sections are present, charts
    render as image plus data table, and no table is clipped.
  - DOCX is P1-7.
- **Acceptance criteria.**
  - The monthly-report prompt in Demo creates one library report with ≥ 6 sections, using
    `case_stats` by month plus comparisons.
  - Its MD, HTML and Print outputs contain every section title and every KPI value.
  - A second identical request with the same idempotency key does not duplicate the report.
  - A report is never created from a case-scoped turn.

#### P0-8 Charts and infographics upgrade

- **Precedent.** Microsoft (switch type and grouping), Elastic (time change, brush zoom, preview
  canvas), M365 Researcher (infographic output) and Palo Alto (chart edit by follow-up).
- **User story.** I can turn a daily series into weekly, zoom into a spike, hide a series, open the
  chart full-screen and download it as an image for my slide. "Make me an infographic of our
  posture this quarter" gives a one-page visual.
- **UI output.**
  - **New kinds:** `grouped_bar` (P0-6), and a Brief `layout: "infographic"` that renders a hero
    KPI row (large numbers with sparklines), a 2-up chart grid and highlight callouts. It is
    print-friendly and shares the report renderer.
  - **Interactions:**
    - re-bin to a coarser calendar unit on the client when the artifact carries finer buckets;
    - brush zoom on line and area charts;
    - legend toggles;
    - Download PNG/SVG (SVG serialisation plus a canvas rasterise; no dependencies);
    - Expand to full width (P0-10).
  - All interactions are client-side and read-only. They never re-query or bill.
- **Backend changes.** The materialiser emits the finest bucket that is ≤ 200 points, plus
  `allowed_rebin`. Add the `report` template `infographic`. Add Demo planner intents.
- **Acceptance criteria.**
  - Re-binning daily to weekly gives sums equal to a server weekly query.
  - The PNG export is non-blank in both themes.
  - Chart keyboard navigation and the sr-only table are preserved.
  - jest-axe is clean.
  - Charts stay out of the entry chunk (the source guard of SPEC §10.10).

#### P0-9 Navigation-level "agent working" indicator, conversation statuses and live reattach

- **Precedent.** Claude Code agent view (animated = working, yellow = needs input, green = done,
  red = failed), the Claude Projects Overview dot, Elastic list statuses (In progress / Awaiting
  input / Unread) and Gemini's "notice next to the chat thread". The Claude.ai Chat tab lacks it,
  so this is a chance to do better than the leader.
- **User story.** I ask a long question, open Cases, and the left navigation's Chat item shows our
  mark animating. When the answer is ready I see a dot and hear "Answer ready in *<title>*". When I
  come back, the live steps continue where they are.
- **UI output.**
  - **Navigation Chat item** (expanded 240 px and collapsed 64 px):
    - the product mark animates (≤ 16 px, about 1.2 s cycle, transform and opacity only) while
      any of my turns runs;
    - an accent dot means an unread answer;
    - a red dot means failed;
    - an amber dot means needs input (P0-11).
  - **Tooltip and `aria-description`:** "Chat — 1 answer in progress: *<title>*".
  - **Announcements:** one shell announcement on completion.
  - **Document title:** prefixed "(1)" while the tab is hidden.
  - **Optional browser notification** on completion, opt-in from Chat Options, never on by
    default.
  - **History rail rows** show the same states.
  - **Reduced motion:** a static mark plus the word "Working" in the tooltip. No 0.2 Hz
    oscillation (apple-design §14).
  - Case-scoped turns appear too, linking to Case Manager.
- **Backend changes.**
  - `GET /api/chat/turns/active` (`cases:read`, owner-scoped) returns `turn_id`,
    `conversation_id`, `case_id?`, `started_at`, `label` (engine template), `lookups`, `tokens`
    and `status`, from `ChatTurnRegistry`.
  - Targeted SSE `chat.turn` events (started, progress, finished, failed, needs_input) on the
    existing EventBus with `audience = {owner}` (`realtime.py:152-186`).
  - When auth is disabled, targeted events do not reach anonymous subscribers, so the client
    polls `turns/active` every 5 s while anything is known to be running.
  - **Live reattach:** `GET /api/chat/turns/{turn_id}/events?after=<seq>` (owner-checked)
    replays a bounded per-turn event ring (text deltas coalesced) and then tails live. Opening a
    conversation with a running turn reattaches, and Stop works after reattach.
  - The registry is process-local, as today.
- **Frontend changes.**
  - A tiny app-level `ChatActivity` store, mounted in the shell. The engine reports its running
    turns there, so the state survives the Chat route unmounting.
  - The poller and SSE subscriber load lazily after first paint.
  - The entry-chunk delta stays within the bundle rule; the CSS keyframes are in `theme.css`.
- **Acceptance criteria.**
  - Starting a 60 s scripted turn and navigating to Cases shows the indicator within 1 s.
  - Returning shows live steps without duplicates.
  - Completing while away sets unread, announces once and updates the title.
  - Reduced-motion snapshot test.
  - Two browser tabs agree (BroadcastChannel).
  - No other user ever sees my turns (owner-scoped tests, auth on and off).

#### P0-10 Use the full width (breakout lane)

- **Precedent.**
  - Amazon Q: maximize and a draggable divider.
  - Claude, ChatGPT and Gemini: side panels and a full-screen viewer.
  - Apple HIG: hiding the sidebar is a request for "more room for content".
  - WCAG 1.4.8: prose stays at ≤ 80 characters.
- **User story.** With both menus collapsed on a 1920 px screen, tables, charts and timelines
  stretch across the screen, and the prose stays readable.
- **UI output.**
  - The prose, user bubble, meta row and composer stay at 48rem (Comfortable) or 56rem
    (Wide/Full).
  - The **block track grows with the lane** (container queries, capped at about 120rem).
  - Tables with more than 6 columns, timelines and charts default to the wide track. KPI rows
    wrap to more tiles instead of stretching.
  - A per-viewer width preference in thread ⋯: Comfortable / Wide / Full (localStorage plus
    prefs).
- **Changes.** `message/lane.ts` `LANE_GRID` becomes a container-query breakout. Update the SPEC
  §10.1 reference widths and the geometry tests.
- **Acceptance criteria.**
  - At 1920 px with the navigation at 64 px and the rail as a strip, in Full, a table block is
    ≥ 1,600 px wide and prose is ≤ 56rem.
  - No horizontal page scroll at 390 px.
  - The report split still keeps C_min = 640.

#### P0-11 Clarify instead of fail; zero-result recovery; a query-robustness golden set

- **Precedent.** Defender Chat (≤ 4 quick-select options), Elastic (≤ 5 multiple-choice
  questions with Skip and custom), Amazon Q (asks for missing info) and Google ("no valid query"
  with guidance).
- **User story.** When my question is ambiguous ("show me the trend"), the assistant asks "Trend of
  what?" with chips (Alerts · Cases · AI cost · FP rate) instead of guessing or failing. When a
  search finds nothing, it tells me how to widen it, in one click.
- **UI output.**
  - **Clarify card:** a question, up to 4 option chips, and "Something else…" (free text).
  - The history row and navigation dot turn amber ("Needs input").
  - **Zero-result:** a callout with deterministic one-click suggestions, for example "Last 7
    days · All sources · Without the rule filter".
- **Backend changes.**
  - A new final variant in the protocol header: `clarify: {question ≤ 200, options ≤ 4 × 80,
    allow_custom}`. Choosing an option sends `origin: "clarify"`, which carries the same taint
    class as `follow_up` (option text is model-authored and may echo log values, #9).
  - Tool observations with zero matches carry engine-built `suggestions[]` that the UI renders as
    chips.
  - A golden set of at least 120 real analyst questions runs in Demo and FakeProvider CI. It
    includes every failing query from the operator's screenshots and every new capability
    (windows, buckets, comparisons, reports).
- **Acceptance criteria.**
  - The golden set passes with no `unsupported` or empty answer where the data exists.
  - An ambiguous-question fixture returns a clarify card.
  - A zero-result fixture shows ≥ 2 suggestions, each producing a valid tool call.

### P1 (this round if capacity allows; otherwise next)

- **P1-1 Step inspector and evidence chips.**
  - **Precedent:** Elastic (Parameters/Response/View JSON), Qualys (retry or explain a step),
    Dropzone (chips: hover shows the query, click opens the payload), 7AI (step report).
  - **Story:** I open any lookup and see exactly what was sent, what came back (aggregates, fenced
    as untrusted display), and its time, rows and tokens. I can retry a failed step or ask "explain
    this step".
  - **Backend:**
    - `ChatStep` gains `observation_ref`.
    - `GET /api/chat/conversations/{id}/messages/{mid}/steps/{n}` returns the stored observation
      (owner-scoped; projection as in §7.5).
    - "Retry step" sends a new turn with `origin: "retry_step"`.
    - "Explain step" is a follow-up turn.
  - **Acceptance:** the payload shown equals what the model saw. Log values render as untrusted
    text nodes.
- **P1-2 Background deep investigation (Jobs).**
  - **Precedent:** GuardDuty investigation agent, Google Threat Hunt, Microsoft Security Analyst,
    Elastic Generations, ChatGPT deep research.
  - **Story:** "Run this as a background investigation". I get a Jobs row and an Inbox
    notification, and the result is posted into the conversation, optionally as a report.
  - **Backend:**
    - `JobKind.CHAT_INVESTIGATION` (`constants.py:672`). The handler drives the same
      `ChatEngine.run_turn` (#5).
    - Actor-scoped, audit-before-visible, cancellable.
    - Like `replay_experiment`, it refuses to resume across a worker restart rather than bill a
      second time.
  - **Acceptance:** the job completes after the browser closes, the conversation shows the answer,
    and exactly one set of UsageDocs is written.
- **P1-3 Advisory investigation brief.**
  - **Precedent:** AWS SIR (including "limiting factors"), GuardDuty (risk level and confidence
    enum), Dropzone (Claim → Reasoning → Threads → Key findings top 5 → Evidence locker → Recs).
  - **Output:** a `report` template `investigation_brief` with the assessment (advisory), a
    confidence enum, key findings (≤ 5), affected entities, ATT&CK, recommended next steps,
    **"What I couldn't check"**, and console links to the human screens.
  - **Guard:** the brief is labelled "Advisory — the case decision is made by policy (decide())"
    (#3). It never writes to a case.
- **P1-4 Answer feedback.**
  - **Precedent:** Microsoft (Looks right / Needs improvement / Inappropriate, plus text) and
    thumbs everywhere else.
  - **Backend:** `POST /api/chat/feedback` stores the rating in the per-user KV, writes an audit
    row and adds a `soc_metrics feedback` breakdown. It **never trains** a model, unlike ROCky.
- **P1-5 "Ask AI" entity chips across the console.**
  - **Precedent:** Palo Alto "Ask AI" next to an entity, Elastic "Add to chat", CrowdStrike
    embedded one-click.
  - **Behaviour:** a chip on IP, host, user, hash, rule and case values in Cases, Logs and Case
    Manager opens chat with a templated, server-resolved question. It follows the topic pattern
    (A7): the value goes as a typed reference, never free text.
  - **Taint:** the value is log-derived, so the indicator taint rules apply. `lookup_indicator`
    only runs if the policy allows it.
- **P1-6 Long-answer ergonomics.**
  - An automatic mini table of contents for answers with ≥ 4 headings.
  - A jump-to-end anchor (Palo Alto precedent).
  - `Ctrl/Cmd+Shift+C` copies the last answer; delete chat with confirm (ChatGPT muscle memory).
  - `/compact` with focus text.
  - `aria-busy` on the running turn.
- **P1-7 DOCX and XLSX exports.**
  - **Precedent:** M365 Researcher, ChatGPT and Perplexity export DOCX; Defender exports any table
    to Excel.
  - **Backend:** built server-side with the Python stdlib (`zipfile` plus OOXML templates; no new
    dependencies) from the same sanitised report AST. Owner-scoped. Defang is on by default.
  - **Acceptance:** the files open in Word, LibreOffice and Excel fixtures (schema-validated in
    CI).
- **P1-8 Prompt library and promptbooks.**
  - **Precedent:** Microsoft promptbooks (`<Parameter>` inputs, org sharing), Palo Alto AI Prompts,
    Qualys' 5 categories, Prisma favorites, Prophet's hunt library.
  - **Behaviour:**
    - Categories (Triage, Hunt, IOC, Posture, Reporting, App help) and a favorites star.
    - Org-shared entries, which need a new permission (`chat_prompts:manage`) to publish.
    - Ordered multi-prompt "promptbooks" with typed parameters, run as sequential turns.
  - **Storage:** the KV pattern, no new index.
- **P1-9 Add an answer to a case.**
  - **Precedent:** Splunk "Add as note", Elastic "Add to existing case", AWS SIR comment.
  - **Behaviour:** a human-confirmed action posts a snapshot of a Workspace answer as the user's
    own case-thread comment through the existing collaboration route and permission. The content
    is fenced as untrusted wherever it later reaches a model.
  - **Guard (#5):** Workspace history never receives case-scoped turns, and the reverse direction
    is an explicit human write, not a chat side effect.

### P2 (backlog; record in ROADMAP.md)

- **P2-1 Save a chart to a custom dashboard.** Palo Alto Widget Library and Elastic precedent. A
  dashboard widget stores the deterministic `(tool, params)` of the block. It re-runs read-only
  with no LLM ($0), under the viewer's RBAC.
- **P2-2 Share a conversation read-only within the tenant.** Microsoft and Elastic precedent.
  Re-render it under the *viewer's* grants, or show a snapshot with Microsoft's explicit
  "static display" warning, and record the decision.
- **P2-3 Branch from a message, and edit an earlier prompt as a new version** (ChatGPT and Claude
  precedent).
- **P2-4 Conversation folders by case or hunt** (ChatGPT/Claude Projects precedent).
- **P2-5 Scheduled saved questions.** Microsoft TI briefing and Prophet scheduled-hunt precedent.
  A promptbook runs on a cadence as a job and delivers a digest or report to the Inbox.
- **P2-6 Model tier presets** (Fast, Balanced, Deep) mapped to configured models with cost hints
  (Palo Alto precedent). Today's model picker already covers the core.
- **P2-7 Mid-run steering and a recap on return** (Claude Code precedent).
- **P2-8 Adaptive follow-up back-off** (Claude Code) and multilingual answer guarantees (S1,
  Splunk).

## 5. Do not build, and why

| Item | Seen at | Why not |
|---|---|---|
| Executing response actions from chat (isolate a host, disable a user, close or escalate a case, apply a suppression) | PA, S1, CS, Torq, MS guided response | The chat is read-only by design, and #3 says only `decide()` closes or escalates. Instead, link to the existing human-in-the-loop screens, pre-filled (P1-3 console links). |
| A chat verdict that feeds a case decision | CS triage, S1 auto-triage | #3. Briefs stay advisory and are labelled. |
| Free-form NL→raw query executed over logs (arbitrary ES DSL, SQL or KQL text) | PA TextToXQL, MS, SP, EL | Bypasses `StructuredQuery`, the field mapping and the read-only key discipline (#1). It also invites raw rows into prompts (#7). Keep structured tool parameters and show the generated native query. |
| Paging raw log rows into the model ("read the whole table") or a Python sandbox over raw logs | MS Security Analyst Agent | #7. `recall_observation` returns aggregates only; rows stay display artifacts. |
| Generating queries for data the user cannot access | PA (TextToXQL generates for inaccessible datasets) | An RBAC leak. Generation and execution are both scoped by grants. |
| Feedback that trains models | Qualys ROCky | Privacy and governance. Feedback goes to audit and metrics only (P1-4). |
| Hidden silent truncation or sampling presented as exact | (anti-pattern) | G3/G4 honesty. Every narrowing and every sample is stated. |
| A "Continue where this stopped" chip, or any per-answer output cap | today's SPEC §10.3 | Replaced by auto-continue (P0-1). This is the operator's explicit request. |
| Removing the gateway, the ledger or the global spend backstop | — | #6, and #10 (Round 10 default budget backstop). The operator's "no limits" is met by removing *per-chat* caps; spend stays metered and visible (D-1). |
| A plan-approval gate before read-only lookups | MS Defender Chat (Approve/Reject plan) | Friction with no safety gain on read-only tools. Show the plan and progress instead. Approval belongs to writes, which chat has none of. |
| Shared conversations that show data to viewers without access | MS (static display regardless of access) | RBAC leak. Only P2-2 with re-render under the viewer's grants, or an explicit, decided snapshot policy. |
| Browser-local-only history | MS Defender Chat (10 local chats) | We already have durable per-user server history. |
| Agent marketplace, custom agent builder or multi-agent personas | PA, Qualys, CS AgentWorks, Torq | #5 says one engine; scope is a filter (`@`), not a second engine. This is also beyond the round. |
| An MCP server or client | PA, MS, GG, AW, CS, S1 | Out of scope (AGENTS.md: 0.1.13 ships no MCP server; the design-system catalog is "input for future MCP tooling"). |
| Voice input, Slack/Teams entry, mobile app | QL, PA, AW, Exaforce | Not asked for. Separate auth and channel work; backlog only. |
| A "Fast mode" sampled chart presented as an answer | EL | Would reintroduce sampling. If ever added, it must be labelled an estimate and opt-in. |
| Auto-writing agent "lessons" to trusted memory | (MS needs admin review; Dropzone is direct) | #9: agent-authored memory starts pending until a human approves it. Keep today's flow. |

## 6. Operator decisions, risks and cross-checks

### 6.1 Decisions the SPEC must record

- **D-1 Daily AI budget and chat (needs explicit sign-off).**
  - Today the global `BudgetConfig` (`config.py:1506`; $10/day, `on_exceed="block"`) also pauses
    chat. The user asked for no limits on chats "this once".
  - **Options:**
    - (a) Keep it shared (today).
    - (b) **Recommended:** chat is not blocked by the daily budget, its spend is excluded from the
      pipeline budget's consumption, and a separate optional chat daily cap defaults to off.
      Every chat call still goes through the gateway and the ledger (#6) and is shown live.
    - (c) Exempt chat but keep counting its spend toward the global figure. Not recommended:
      chat could exhaust the pipeline budget and push investigations to NEEDS_HUMAN.
  - Option (b) changes AGENTS.md's Round 10 wording ("the daily budget is the GLOBAL spend
    bound"), so it must be updated in the same change.
- **D-2 Concurrency.**
  - Long turns make the 429 `chat_busy` at 2 per user (8 global) likelier.
  - **Recommendation:** raise the defaults to 4 per user and 16 globally, and **queue** rather
    than reject, with a "Queued" state in the rail.
  - This is a capacity bound, not a token limit.
- **D-3 Runaway protection.** There are no numeric caps by default; the loop guard (P0-1) and
  Stop are the controls. Optionally add a non-blocking "this question has used $X" warning at an
  operator threshold.
- **D-4 Timezone for calendar buckets.** Reuse `SlaPolicy.timezone` (default UTC) or add a
  dedicated organisation timezone. Labels always state the timezone.

### 6.2 Risks and feasibility notes

- **Process-local registry.** Turns, reattach and `turns/active` are single-replica, as today.
  This is documented, not fixed.
- **Elasticsearch mapping.** The bootstrap never remaps existing indices. Case fields that are
  not aggregatable force the `export_page` fallback, which is slower but exact. Timing must be
  honest, with progress events.
- **Storage.** Unbounded answers interact with the 16 kB/256 kB/100-message limits. Per-exchange
  KV documents (no new index or table) are the recommended fix. The rollback note in DEPLOY.md
  must be revisited, because SPEC §7.5 already documents a one-way storage form on ES.
- **Contracts.** `chat-stream-events.contract.json` (`step.progress`, the `chat.turn` SSE, the
  clarify final) and `answer-blocks.contract.json` (`grouped_bar`, the `comparison`
  materialisation, `infographic` layout, `allowed_rebin`) change on both sides in the same
  package.
- **Demo Mode.** The `engine/demo_chat.py` planner needs intents for `case_stats`, windows,
  buckets, comparisons, report-save, clarify and compaction, with byte-identical transcripts.
- **Bundle.** The navigation indicator lives in the entry chunk, which has a tight budget. Keep
  the store tiny and lazy-load the poller and SSE.
- **Cost.** Unbounded turns on reasoning models can cost dollars per question. The live meter,
  the per-question running cost and D-1 make this visible, not blocked.
- **#9 surface area grows.** New items to fence and taint-rule: the conversation summary fence,
  clarify options, saved-report titles, entity chips and recalled observations. Each needs a
  forged-marker test.

### 6.3 Non-negotiables cross-check (P0)

| Feature | #1 | #2 | #3 | #5 | #6 | #7 | #9 | RBAC |
|---|---|---|---|---|---|---|---|---|
| P0-1 Unbounded and auto-continue | n/a | tool audit unchanged | n/a | one engine | each continuation is one UsageDoc | unchanged | continuation text treated as model output | unchanged |
| P0-2 Compaction | n/a | n/a | n/a | n/a | compaction calls metered | recall of aggregates only | new UNTRUSTED fence | owner-scoped |
| P0-3 Windows | read-only key | audited | n/a | n/a | n/a | n/a | labels sanitised | per tool |
| P0-4 `case_stats` | own-state read only | audited | no `decide()` | n/a | no model call | aggregates only | untrusted labels flagged | `cases:read` |
| P0-5/6 Buckets and comparisons | read-only | audited | n/a | n/a | n/a | aggregates | flagged labels | per tool |
| P0-7 Report save | n/a | mutation audited | n/a | case turns cannot save | summary is one call | §9.4 digest | titles fenced | owner-scoped |
| P0-8 Charts | n/a | n/a | n/a | n/a | no calls | n/a | G1/G2 render rules | n/a |
| P0-9 Indicator and reattach | n/a | n/a | n/a | case turns link to Case Manager | n/a | n/a | engine labels only | owner-scoped endpoint and SSE audience |
| P0-10 Width | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| P0-11 Clarify | n/a | audited | n/a | n/a | metered | n/a | `clarify` origin is taint-ruled | per tool |
