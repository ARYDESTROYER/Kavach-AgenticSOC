# Case / incident management UX — competitor study + Agentic SOC Case Manager inventory

Round 12 research brief. Scope: how SOC leaders (Palo Alto Cortex XSIAM/XSOAR, Google SecOps,
Microsoft Defender XDR + Sentinel, Splunk ES 8, Elastic Security, TheHive 5) lay out the case
queue and the case detail, and — the central question — how they separate **lifecycle STATUS**,
the **AI/engine VERDICT**, and the **analyst CLASSIFICATION/DISPOSITION**, and which one becomes
the headline once a human resolves the case. Then a complete data inventory of the current
Agentic SOC Case Manager (so a redesign loses nothing), a diagnosis of the SOC analyst's
screenshot complaint, and concrete React + Tailwind + Radix recommendations aligned with the
Apple design skill (`scratchpad/r12/apple-design-SKILL.md`) and `docs/development/ui-standard.md`.

---

## 0. TL;DR — decisions this research supports

1. **Three axes, three visual grammars, one headline rule.** Every leader keeps lifecycle
   status (New/In progress/Resolved/Closed) separate from the outcome. After a human resolves,
   the **analyst's classification is the outcome of record** and is what lists, headers and
   reports show (Defender "Classification/Determination", Sentinel "Classification", XSIAM
   "Resolved – False Positive", SecOps "Close reason + Root cause", Splunk "Disposition",
   TheHive closing status). The AI verdict is never overwritten but is demoted to a labelled
   recommendation ("AI Analysis" in Splunk, "Summary by Gemini" in SecOps) with agree/override
   feedback. Agentic SOC currently does the opposite: the Overview headline is built from
   `verdict` (AI) + `status` → "Needs human review — closed", even after an analyst classified
   the case as a false positive.
2. **Classification is captured at the moment of resolution, on every path.** Sentinel makes
   the classification mandatory to close; XSIAM requires a resolution reason in the Resolve
   dialog; SecOps requires reason + root cause including for bulk close; Defender shows the
   classification field when Status=Resolved. Agentic SOC's single-case **Close** requires a
   disposition (good), but **Mark resolved**, **bulk Resolve** and the overflow paths do not —
   these leave `disposition = undetermined` (auto-mapped from the NEEDS_HUMAN verdict), which is
   exactly what the analyst's screenshot shows.
3. **Header anatomy convergence:** title → ID (copy) → severity + score → status → owner →
   outcome/classification → tags → SLA/due, with one primary contextual action plus a "More"
   menu. Agentic SOC's embedded header shows only title, ID, severity, demo badge, Share and
   Take Action; status/disposition live 150px lower in the Overview body; **assignee is only in
   the Collaboration tab and tags are not rendered anywhere in the case detail.**
4. **Queue/detail split is the standard** (Defender side pane with ↑/↓ next/previous, SecOps
   queue cards + detail, Sentinel persistent collapsible left details panel). Agentic SOC has the
   split but lacks keyboard next/previous, an outcome/assignee cue on rows, and density options.

---

## 1. Competitor findings

### 1.1 Palo Alto Networks — Cortex XSIAM / Cortex XSOAR

- **Case views.** XSIAM/AgentiX cases have an **Overview** (grouping graph of issues↔artifacts
  + an Evidence view tracing causality chains) and a table-based **Detailed View** the analyst
  can switch to, with tabs **Issues & Insights · Key Assets & Artifacts (Artifacts / Hosts /
  Users) · Timeline · Case War Room · Executions** (causality-group-owner cards with issue
  counts by severity). Timeline groups entries that share artifacts and filters by action type.
  [cortex-docs: detailed view](https://cortex-docs.paloaltonetworks.com/cortex-agentix/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/analyze-case-details/detailed-view)
- **Header.** "The assigned case score is displayed in the cases header"; clicking it shows the
  scoring method (rule-based or SmartScore). Severity (Critical/High/Medium/Low) and assignee
  are click-to-edit in place. An Actions menu holds *Edit case details* (title, description,
  *Summarize with AI* toggle, star). AI-generated title + summary regenerate as the
  investigation evolves.
  [establish case context](https://cortex-docs.paloaltonetworks.com/cortex-agentix/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/establish-case-context) ·
  [case scoring](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/case-concepts/case-scoring)
- **Resolve dialog.** Fields: **Resolution reason (required)**, Comment, *Resolve all issues in
  the case*, *Create an exclusion*. Standard reasons: **Resolved – True Positive, Resolved –
  False Positive, Resolved – Security Testing, Resolved – Known Issue, Resolved – Duplicate
  Case, Resolved – Risk Accepted** (+ custom, per domain). TP/FP resolutions feed back into
  scoring of future cases. Note the grammar: **the status *is* the outcome** once resolved
  ("Resolved – False Positive"), so the list and header show the human outcome directly.
  [resolution reasons](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/resolve-the-case/resolution-reasons-for-cases-and-issues.md) ·
  [resolve a case](https://cortex-docs.paloaltonetworks.com/cortex-xsiam/detect-investigate-and-respond-to-threats/investigation-and-response/analyze-and-resolve-cases/resolve-the-case/resolve-a-case.md)
- Cases auto-close when all their issues are resolved (resolving an issue does not unlink it).
- **XSOAR incident layout** (customisable, tabs can be reordered/renamed/hidden):
  **Incident Info / Case Info · Investigation · Work Plan** (visual running playbook) **· War
  Room** (chronological journal of actions, artifacts, collaboration; commands run inline)
  **· Evidence Board** (pinned key artifacts) **· Related Incidents · Canvas**. Close dialog:
  **Close reason (required: Resolved / False Positive / Duplicate / Other)** + **Close notes**.
  [XSOAR incident investigation](https://docs-cortex.paloaltonetworks.com/r/Cortex-XSOAR/6.13/Cortex-XSOAR-Administrator-Guide/Incident-Investigation) ·
  [customize incident layouts](https://cortex-docs.paloaltonetworks.com/xsoar-6-administrator-guide/6.15/customize-cortex-xsoar/customize-and-configure-cortex-xsoar/incidents/incident-customization/customize-incident-layouts) ·
  [close fields (Cyware connector doc)](https://techdocs.cyware.com/en/299672-334254-palo-alto-cortex-xsoar.html)

### 1.2 Google Security Operations (SecOps / Chronicle SOAR)

- **Queue.** Case cards show **name + unique ID, timestamp, number of alerts, assigned analyst
  (avatar)**, optional priority and stage. Three densities: **Default view** (cards), **Compact
  view**, **List view** (table for bulk/filters). Auto-refresh every minute.
  [cases overview](https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/cases-overview)
- **Case top bar:** title, ID, **priority and stage**, timestamp, environment, **tags**,
  **assigned analyst**; controls **Chat · Close Case · Refresh · Explore · Case Actions**.
  Tabs: **Case Overview** (admin-configured widgets), **Alert Overview** (linked alerts with
  events/metadata), **Case Wall** (chronological log creation→closure: actions, status changes,
  tasks, comments, pinned chat, favourites, insights).
- **Close Case dialog:** **Reason (required) → Root cause (required, enabled after reason) →
  optional comment posted to the Case Wall.** Same requirement for bulk close (side-by-side
  "Select multiple cases → Close Cases", list view "Actions → Close cases", search page ≤50).
  Reason enum: **Malicious · Not Malicious · Maintenance · Inconclusive**; close action is
  recorded as automatic vs manual.
  [resolve and close cases](https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/how-to-close-cases) ·
  [SOAR data in dashboards](https://docs.cloud.google.com/chronicle/docs/reference/soar-data-dashboard)
- **AI verdict is a separate, labelled artefact.** The Triage and Investigation Agent writes a
  **"Summary by Gemini"** with **disposition (true/false positive), confidence level, and
  explanation**, an **"Investigation timeline"**, **"Suggested next steps"**, **"Re-run
  investigation"**, and **Thumb up/down feedback**. On the case it is folded into the **Case
  Summary**. There is no "accept verdict" control — the analyst's Close reason is the record.
  [triage & investigation agent](https://docs.cloud.google.com/chronicle/docs/secops/triage-investigation-agent)

### 1.3 Microsoft Defender XDR (incidents + new "incident cases") and Sentinel

- **Queue → side pane → full page.** Selecting a row (not its name) opens a **summary pane**
  (priority assessment + factors, details, recommended actions, related threats) with **up/down
  arrows to move to the previous/next incident**; "Open incident page" goes full screen.
  Customisable columns (drag to reorder), 0–100 **priority score** (red >85, orange 15–85, grey
  <15), saved filter sets, filters incl. **Status, Severity, Incident assignment, Tags,
  Classification**, CSV export, default filter New + In progress.
  [incident queue](https://learn.microsoft.com/en-us/defender-xdr/incident-queue)
- **Incident page:** tabs **Attack story · Alerts · Assets (count) · Investigations · Evidence and
  Response · Summary · Activities · Similar incidents**; a right-hand **Incident details** pane
  always shows **assignment, ID, classification, categories, first/last activity, description,
  impacted assets, active alerts**. Evidence entities each carry a verdict
  (Malicious/Suspicious/Clean) + remediation status. **Activities** is a unified, filterable
  timeline of manual + automated actions (origin, category, performed by, …).
  [investigate incidents](https://learn.microsoft.com/en-us/defender-xdr/investigate-incidents)
- **Resolve + classify.** In the **Manage incident** pane: Status → **Resolved** reveals a
  resolution-note field (shown later in the details panel and activity log). **Classification**:
  *Not set* · **True positive** (+ threat type) · **Informational, expected activity** (+ activity
  type) · **False positive**. Bulk: tick many rows → **Manage incidents** (same pane).
  [manage incidents](https://learn.microsoft.com/en-us/defender-xdr/manage-incidents)
- **Determinations** (API): TP → Multistage attack, Malicious user activity, Compromised
  account, Malware, Phishing, Unwanted software, Other; Informational → Security test,
  Line-of-business application, Confirmed activity, Other; FP → **Not malicious, Not enough
  data to validate**, Other. Status enum: Active, InProgress, Resolved, Redirected.
  [incidents API](https://learn.microsoft.com/en-us/defender-xdr/api-incident)
- **Incident cases (preview, recommended):** Manage case pane with Assigned to, Severity,
  Status, custom fields, **Due date/time (SLA-driven)**, Tags, **Classification + Determination +
  closing notes** (stored on case and incident), Comments & Attachments, Tasks, and **agent
  sessions** with an "Agent sessions status" column/filter — the agent's work is a separate,
  reviewable object, not the case outcome.
  [manage incident cases](https://learn.microsoft.com/en-us/defender-xdr/manage-incident-cases)
- **Sentinel incident page:** a persistent **left details panel** (owner/status/severity
  editable even when collapsed; Evidence: Events/Alerts/Bookmarks; first four entities),
  top bar **Tasks · Activity log · Logs**, **Incident actions** (run playbook, create automation
  rule, Teams), tabs **Overview** (Incident timeline, Similar incidents, Entities, Top insights)
  and **Entities**. Closing requires one of five classifications: **True Positive – suspicious
  activity · Benign Positive – suspicious but expected · False Positive – incorrect alert logic
  · False Positive – incorrect data · Undetermined** + comment.
  [Sentinel investigate](https://learn.microsoft.com/en-us/azure/sentinel/investigate-incidents) ·
  [Sentinel triage/close](https://learn.microsoft.com/en-us/azure/sentinel/incident-navigate-triage)
- **AI agents:** Security Copilot Phishing Triage Agent gives a verdict with a natural-language
  rationale; analysts **reclassify incidents and give natural-language feedback** that the agent
  learns from; analysts can override. AI-generated analyst notes carry an "AI generated"
  disclaimer that is removed once a human edits them.
  [Tech Community](https://techcommunity.microsoft.com/blog/microsoftthreatprotectionblog/-/4438301) ·
  [Redmond](https://redmondmag.com/articles/2025/08/06/microsoft-rolls-out-phishing-triage-agent-in-security-copilot-public-preview.aspx)

### 1.4 Splunk Enterprise Security 8 (Mission Control)

- **Disposition is explicitly separate from status.** "Dispositions separate out false
  positives without changing the finding's status (New, In progress, Closed)." Values:
  **True Positive – suspicious activity · Benign Positive – suspicious but expected · False
  Positive – incorrect analytic logic · False Positive – inaccurate data · Other · Testing ·
  Undetermined (default)**, plus custom.
  [configure dispositions](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.3/investigations/configure-dispositions-for-findings-in-splunk-enterprise-security)
- Investigation **Overview panel**: Owner, Status, Urgency, Sensitivity, Disposition, ID,
  description; included findings, detections, response plans, automation results, notes.
  [review investigation details](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.4/investigations/review-investigation-details-in-splunk-enterprise-security)
- **AI Analysis** section in the side panel: a *recommended* disposition (TP/FP/BP/other) with
  summary, reasoning, tools/evidence consulted, "View details" step timeline, thumbs feedback.
  "The agent never changes any fields on your behalf … you remain in control of the final
  disposition." This is the cleanest statement of the AI-vs-analyst split.
  [AI analysis in ES](https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.6/ai-assistant-in-security-and-agentic-capabilities/ai-analysis-in-splunk-enterprise-security)

### 1.5 Elastic Security cases

- Case detail: edit description, comments, assignees, **status (Open / In progress / Closed)**,
  severity (default Low), category, tags, custom fields ("Additional fields"), connectors/push,
  **Sync alert status** with case status, **observables** (≤50; auto-extract in 9.2+). No
  first-class close reason found in official docs; disposition is conventionally recorded via
  alert tags (Duplicate / False Positive / Further investigation required) and notes.
  [open & manage cases](https://www.elastic.co/docs/solutions/security/investigate/open-manage-cases) ·
  [create cases](https://www.elastic.co/docs/explore-analyze/cases/create-cases)

### 1.6 TheHive 5 (StrangeBee)

- Stages are hard-coded (**New · In progress · Closed**; *Imported* for alerts); statuses under
  the Closed stage are only selectable **when closing**. The **Close case** drawer: pick the
  closing status (classic set **True Positive / False Positive / Indeterminate / Other /
  Duplicated**; True Positive asks "with impact?"), **summary (required)**, mandatory custom
  fields, then **"Close tasks and case"**. Again: the closing status *is* the outcome headline.
  [close a case](https://docs.strangebee.com/thehive/user-guides/analyst-corner/cases/close-a-case/) ·
  [about statuses](https://docs.strangebee.com/thehive/administration/status/about-statuses/) ·
  [legacy close guide](https://docs.thehive-project.org/thehive/user-guides/analysts/close-case/)

---

## 2. Synthesis

### 2.1 Status vs AI verdict vs analyst classification

| Product | Lifecycle status | AI / engine verdict | Human outcome (required at close?) | Headline after human resolves |
|---|---|---|---|---|
| Cortex XSIAM | New / Under investigation / Resolved | Score + AI summary | **Resolution reason** (required) | "Resolved – False Positive" (status carries outcome) |
| Cortex XSOAR | Pending / Active / Closed | playbook output | **Close reason + notes** (required) | Closed + close reason |
| Google SecOps | Open / Closed (+ stage) | "Summary by Gemini" disposition + confidence | **Reason + Root cause** (required, incl. bulk) | Closed · reason |
| Defender XDR | Active / In progress / Resolved | Copilot agent verdict / analyst notes (AI-labelled) | **Classification + Determination** + note | Resolved · Classification |
| Sentinel | New / Active / Closed | — | **Classification (5)** mandatory + comment | Closed · Classification |
| Splunk ES 8 | New / In progress / Closed | "AI Analysis" *recommended* disposition | **Disposition** (default Undetermined) | Closed · Disposition |
| Elastic | Open / In progress / Closed | — | tags/notes | Closed |
| TheHive 5 | New / In progress / Closed | — | **Closing status + summary** (required) | Closing status |

Rules the field converges on:

1. **Status answers "where is the work?"; classification answers "what was it?"; the AI verdict
   answers "what did the machine think?"** Three separate controls, three visual treatments.
2. Once a human classifies, **the human classification is the outcome label** on the queue row,
   the header and exports. The AI verdict is preserved and shown as a secondary, explicitly
   labelled line ("AI assessed …"), ideally with an agree/override marker — never deleted.
3. Classification is **captured by the act of closing** — no close path (single, bulk,
   resolve, automation) leaves the outcome blank; "Undetermined"/"Inconclusive" is an explicit
   analyst choice, not a silent default.
4. AI output carries explicit provenance (Gemini/Copilot/"AI Analysis" labels, disclaimers,
   thumbs feedback) and **never mutates the outcome fields itself** (Splunk wording).

### 2.2 Layout patterns

- **Queue + detail split** with a persistent selection: Defender (row → side pane, ↑/↓ for
  previous/next), SecOps (queue cards left + case right; Default/Compact/List densities),
  Sentinel (grid + details pane; full page keeps a collapsible left details panel).
- **Header anatomy** (consensus): title (AI-generated in XSIAM/Defender, editable) · ID ·
  severity · score/priority · status · owner · tags · classification · due/SLA; one primary
  action (Close Case / Manage / Resolve) + Actions menu + Chat/Copilot entry.
- **Tabs**: Overview/Summary · Alerts/Issues · Entities/Assets (with counts) · Evidence ·
  Timeline/Activities (filterable, human + automated in one stream) · War Room/Case Wall
  (collaboration) · Similar/Related. Counts in tab labels (Defender "Assets (n)").
- **Evidence**: per-entity verdict + remediation status (Defender), Evidence Board pinning
  (XSOAR), bookmarks into the timeline (Sentinel).
- **Bulk**: multi-select → one management pane with status + classification + assign + tags
  (Defender), bulk close requires reason + root cause (SecOps), per-record results.
- **Density**: dense tables with column customisation and saved views (Defender), card vs
  compact vs list (SecOps); colour bands on severity with dotted variant for "not part of this
  incident" (Sentinel entity timeline).

---

## 3. Agentic SOC — current Case Manager: complete data inventory

Files: `webui/src/soc/pages/CaseManager.tsx` (queue + split), `pages/CaseDetail.tsx`
(orchestrator, `presentation="embedded"`), `pages/casedetail/*` (panels),
`components/badges.tsx`, `CaseThread/CaseTasks/CaseActivityFeed.tsx`.
Everything below must survive any redesign (see §6 checklist).

### 3.1 Queue pane (`CaseManager.tsx`)
- Header "Active cases"/"All cases" + scope line (`19 shown · 19 active / 84 loaded`; All mode
  adds `/ N total`). Client window `LIST_LIMIT = 200`.
- Controls: **Active / All** segmented; **Refresh**; search ("Search cases, entities…" —
  matches case_id, case_number, title, summary, status, verdict, entity type/value, source_name,
  assignee); **Severity** filter; **Status** filter; **Sort** (Latest · Highest risk · Newest ·
  Title A–Z); **Clear filters**; **Select visible (n)**.
- Row (2 lines): checkbox (hover/focus/touch/when selecting), **severity rail** (solid
  crit/high, dashed medium), **title** (title→summary→case_number→case_id), **relative age**
  (updated_at), **severity word + glyph**, **Risk N**, **display id** (mono), **primary fact**
  (entity type+value → source_name → summary, de-duplicated), **status glyph + label**
  ("Open · awaiting analyst" for needs_human). Open row: tint + right primary rail +
  `aria-current`.
- Bulk bar: count, **Acknowledge**, **Assign** (free text), **Tag**, **Set status**
  (open/investigating/on_hold/escalated), **Set disposition** (TP/FP/benign/suspicious/duplicate),
  **Reinvestigate** (token-cost warning), **Resolve** (`reason: 'Bulk-resolved by analyst'`,
  **no disposition**), Clear; outcome banner "… Track progress in Inbox." All bulk work is a
  durable job (`case_lifecycle` / `case_assign` / `case_tag` / `case_reinvestigate`).
- Split: resizable separator (320–680px, default 400, persisted `soc.caseManager.queueWidth`,
  keyboard arrows), "Select a case" empty state, load error, mobile back path.
- **Not on the row today:** disposition/outcome, verdict, assignee, tags, SLA/age-in-status,
  alert count, source, unread/new marker. (The Cases list table has Assignee, Disposition,
  Alerts, Playbooks, Enrichments, Category, Confidence, Verdict, Urgency, Entity columns.)

### 3.2 Embedded detail header (`CaseDetail.tsx` ~L1294–1585)
- **Title** (h2, line-clamp-2), **display id + copy**, **"<Severity> severity" badge**,
  **Sample/Demo badge**. Actions: **Share** (copy link), **Take Action** menu → *Case actions*
  (status-dependent from `actionPlanForStatus`: Acknowledge & investigate / Escalate / Close
  case (with disposition) / Mark resolved / Put on hold / Resume / De-escalate / Reopen / Set
  disposition), *Investigation* (Reinvestigate [model picker + cost warning], Run a playbook,
  Refresh case, Ask about this case), *Share & export* (Open in new tab, Export JSON, Export
  Markdown report, Notify [channel], Open campaign); **Close pane** (xl only).
- **Not in the embedded header:** status, disposition, assignee, tags, created/updated (the
  sheet presentation shows status/disposition/auto-closed/escalated/campaign + created/updated).

### 3.3 Overview tab (`OverviewPanel.tsx`, case-manager presentation)
- **Decision band:** headline `decisionHeadline(verdict, status)` (e.g. "Needs human review —
  closed"), first sentence of `summary`, **StatusBadge**, **DispositionBadge**, Escalated badge
  (escalation_level>0), **AutoClosedBadge** + objection window, **Impact**, **Priority** (triage
  API, fallback case bands), **Recommended action** + authority note + auto-close policy line.
- **Signal profile aside:** **Risk score** meter ("Deterministic case input"), **Confidence**
  meter ("Agent assessment"), **Recorded risk factors** (Volume, Velocity, Reputation,
  Diversity, Asset criticality with help tips).
- **Investigation inputs** (latest run): Knowledge, Memory, Persona, Playbook, Runbook,
  Threshold tuning — or "Provenance unavailable".
- **Provenance row:** *Source says* (reported severity + provenance tag, severity delta cue
  "Raises/Lowers severity", detection rule ids, Source, Why it fired), *Agent found* (persisted
  findings count, mapped MITRE technique IDs, checks recorded as clean, related case ids), *Code
  decided* (Authority, Final route, Risk score, Auto-close tag).
- **Entity row:** *Primary entity* (value, Internal/External scope, reputation, country, ASN,
  org, first/last seen, copy indicator), *Attack story* (rule fired → agent searched → intel
  checked → case manager routed), *Entity relationship* (entity → rule → surface).
- **Baseline signature card**; **Evidence checklist** table; **Reproduce investigation**
  (search query, reproduce query); **Investigation error** alert.
- Collapsibles: **Related cases**; **Provenance & audit** (Status timeline from→to badges +
  by/at/reason, Automation applied, Source breakdown, run/cost meta: token_cost, agent_persona,
  playbook_id, app_version/build_sha, cluster_signature, member events, cross-source cluster).

### 3.4 Other tabs
- **Timeline** — "What happened": six stages (input, correlate, risk, triage, investigate,
  decide) incl. *Risk score factor calculation* (Factor/Value/Weight/Contribution) and the
  cluster formation diagram (*Why these alerts clustered*: Group, Mode, Observed/threshold,
  Window, Persisted cluster inputs, Related cases, Status, Verdict).
- **Investigation** — *AI assessment* (reasoning, retrieved knowledge with document/retrieval
  score/returned by, runbook references, tools run with threat verdict/reputation/country,
  full ReAct trace) + *Decision* (`DecisionCard`: Verdict, Confidence, Risk score, Result,
  human vs automated decider, "Closed by analyst policy", precedent signal, objection window)
  + recorded analyst **feedback** (assessment, accuracy, reasoning quality, action
  appropriateness, actual outcome, time saved, comment).
- **Threat context** — Threat summary (Assembled, Source, Confidence score), IOC reputation,
  MITRE ATT&CK techniques, Asset context.
- **Collaboration** — **Assignee picker** (only place assignee is shown), discussion thread (AI
  author can only recommend), task checklist, activity feed.
- **Chat** — case-scoped chat (AI analyst status, quick actions).

### 3.5 Dialogs
- **Close with a disposition**: Disposition (required, opens empty; "Currently recorded: X"),
  Resolution (Handled / Benign / Duplicate / No action needed / Other), Tags, Analyst note
  (durable context for future AI), **Grade the AI decision** (Agrees / "Overrides AI verdict
  (Needs human → False positive)" chip, What actually happened?, Accuracy, Reasoning quality,
  Action appropriateness).
- Escalate (assignee, priority); Hold / De-escalate (reason); Mark resolved (reason, tags,
  grading — **no disposition**); Set disposition (disposition, reason, grading); Reinvestigate;
  Run playbook; Notify.

### 3.6 Case fields with no Case Manager rendering today
`tags` (not rendered anywhere in CaseDetail), `assignee` (Collaboration tab only),
`detected_at` / `acknowledged_at` / `first_response_at` (SLA clocks), `detection_source`,
`urgency_band` (Cases list only), `notifications_sent`, `comments` (legacy), `source_id`,
`origin_surface`, `history[].classified_disposition` (who classified, when). The unused
`components/CaseTriageHeader.tsx` (Risk/Severity/Impact/Priority chips with input help tips)
is only referenced by tests.

---

## 4. Diagnosis — the SOC analyst screenshot ("Undetermined remains but the case is FP")

Observed: header "Needs human review — closed", chips **Closed** + **Undetermined**, Confidence
98% "Agent assessment".

1. **Headline is AI-led.** `decisionHeadline(c.verdict, c.status)` (`OverviewPanel.tsx:132`)
   builds the sentence from the AI verdict + status only; `disposition` and analyst grading are
   ignored. Even the successful path (diag shot `diag-disp-4-after.png`: chips Closed + False
   positive) still reads "Needs human review — closed" with "Confidence 75% · Agent
   assessment" — the opposite of every competitor's post-resolution grammar.
2. **Close paths that do not write a disposition.** Backend only applies `body.disposition` for
   `{"set_disposition","close"}` (`api/routes.py` `_DISPOSITION_ACTIONS`) and `confirm_fp`
   only upgrades `undetermined`. `case_manager.apply()` auto-maps NEEDS_HUMAN →
   `Disposition.UNDETERMINED` (`engine/case_manager.py:35–39,163–168`). So **Mark resolved**
   (fields: reason, tags, grading), **bulk Resolve** (`reason: 'Bulk-resolved by analyst'`),
   and a grading "What actually happened? = False positive" (stored as
   `feedback.actual_outcome`, never reconciled to `disposition`) all leave the chip on
   "Undetermined" while the analyst believes they flagged it FP. Any of these reproduces the
   screenshot.
3. Fix direction (no `decide()` change, #3-safe — presentation + analyst-layer only):
   (a) outcome-precedence headline (§5.1); (b) disposition picker on **resolve** (single + bulk)
   and require it when a resolve/close lands on a terminal status, like Sentinel/XSIAM/SecOps;
   (c) when `actual_outcome` is stated and conflicts with a still-auto `undetermined`
   disposition, show a reconcile prompt ("You graded this a false positive — record it as the
   case disposition?") rather than silently diverging. Keep G1: never pre-fill from the model.

---

## 5. Recommendations (React + Tailwind + Radix, Apple-design aligned)

### 5.1 Outcome-precedence headline (P0 — fixes the analyst issue)
- Add a pure `caseOutcome(c)` (shared util + unit tests) returning
  `{ label, source: 'analyst' | 'analyst_policy' | 'agent' | 'pending', by?, at?, aiVerdict, agreement }`:
  1. latest `history` entry with `classified_disposition`, or `decision_by === 'analyst'` with a
     non-undetermined disposition → **analyst outcome** ("False positive", by user, at time);
  2. `decision_by === 'analyst_policy'` → "Closed by analyst policy";
  3. agent auto-close (`isAutoClosedByAI`) → "Auto-closed as false positive" + AI badge;
  4. otherwise **pending**: "AI assessment: Needs human review" (explicitly attributed).
  Optionally expose the same as an additive backend read-time projection `outcome` on the case
  payload (no migration, mirrors `classified_disposition`).
- Overview headline becomes e.g. **"False positive"** + caption "Classified by asmith · closed
  2h ago"; directly beneath, a muted secondary line with a Bot glyph: "AI assessed: Needs human
  review · 98% confidence — overridden" (agreement via existing `grading.deriveAgreement`).
- After human classification, relabel the Confidence meter "AI confidence (at assessment)".
- Three grammars, never mixed: **Status** = glyph + sentence-case text (no fill);
  **Outcome** = filled semantic badge (`DispositionBadge`); **AI verdict** = outline badge with
  `Bot` icon + "AI" provenance tag (`ProvenanceTag kind="ai"`).

### 5.2 Classification on every terminal path (P0)
- Add `'disposition'` to `ALL_ACTIONS.resolve.fields`; backend: include `resolve` in
  `_DISPOSITION_ACTIONS` (analyst layer only).
- Bulk **Resolve** and a new bulk **Close…** open a dialog with the required disposition
  (+ optional resolution, note) — SecOps parity — and pass `disposition` +
  `disposition_declared: true` in the job payload.
- Close dialog: show "AI said X → you're recording Y" side by side (exists as a chip; promote
  it), keep "Undetermined" as an explicit choice (Sentinel/Splunk parity), and consider a
  second-level determination mapped onto the existing `resolution` select
  (Defender classification → determination pattern).
- Offer **Close & next** (primary) so the queue advances to the next active case.

### 5.3 Header anatomy (P1)
- Sticky header (`sticky top-0 z-10`) on a translucent material: `bg-background/80
  backdrop-blur-xl supports-[backdrop-filter]:bg-background/70` with a scroll-edge fade
  (`[mask-image:linear-gradient(to_bottom,black_85%,transparent)]` on a pseudo element) instead
  of a hard hairline (Apple §12); solid fallback under `prefers-reduced-transparency`.
- Line 1: title (line-clamp-2). Line 2 meta row: ID+copy · severity badge · **status** ·
  **outcome** (from §5.1) · **assignee** monogram (Radix `Popover` quick reassign) · **tags**
  (first 2 + "+n") · age/SLA ("Open 3h · Ack 12m"). Right: **one primary contextual button**
  from `actionPlanForStatus().primary` (e.g. "Close…", "Acknowledge", "Reopen") + Take Action
  menu + Share + close. Container queries (`@container/case-header`) collapse labels to icons
  in narrow panes.

### 5.4 Queue rows (P1)
- Keep the two-line grammar (ui-standard). Line 2 right side: status; for terminal rows show
  the **outcome** word instead of/in addition to "Closed" ("Closed · FP"); add assignee
  monogram (24px) before age. Max one extra element per line to avoid clamping.
- Keyboard: `J/K` or `↑/↓` on the focused queue moves selection and opens (Defender ↑/↓
  parity); `Enter` opens; `X` toggles selection; announce via `aria-live`. Keep the checkbox a
  sibling of the open button.
- Density toggle (Comfortable / Compact) via `SegmentedControl`, persisted per user prefs —
  SecOps Default/Compact parity; Compact = single line with title + severity + status.
- After a close in Active mode, animate the row out (height + opacity, `motion` spring
  `bounce: 0`, ~0.3s) and select the next row; reduced motion → instant swap + toast.

### 5.5 Overview reorganisation without losing data (P1)
- Order: Outcome band (§5.1) → **Key facts grid** (Impact, Priority, Urgency, Assignee, Tags,
  Detected / Acknowledged / First response, Source, Detection source) → Recommended action →
  Signal profile → Investigation inputs → Provenance → Entity row → Evidence → collapsibles.
  The new facts grid surfaces every field in §3.6 that is currently hidden.
- Tab labels with counts: "Evidence (n)" style counts on Investigation/Threat/Collaboration
  (messages, open tasks) as Defender does for Assets.
- Activity feed filters (Human / AI / System) mirroring Defender Activities and SecOps Case Wall.

### 5.6 Apple-design specifics for this surface
- **Response/feedback:** pressed state on rows/buttons (`active:scale-[0.99]` on rows,
  `active:scale-[0.97]` on buttons, 100ms); all four feedback kinds — status (job progress),
  completion (toast "Closed as False positive · Undo/Reopen"), warning (reinvestigate cost),
  error (inline).
- **Spatial consistency:** the detail pane and sheets enter/exit from the right along the
  same path; menus/popovers scale from their trigger (`transform-origin` via Radix
  `--radix-*-transform-origin`).
- **Interruptibility:** split-pane resize already 1:1; switching cases mid-transition must
  animate from the current value (Motion springs, `bounce: 0`, `duration: 0.3–0.4`), never
  lock input.
- **Typography:** title `text-xl font-semibold tracking-tight leading-snug`; meta row
  `text-xs` near-zero tracking; no tracked caps (ui-standard).
- **Wayfinding:** queue header shows position ("3 of 19 active"); detail breadcrumbs back to
  queue on compact layouts.
- **Reduced motion/transparency/contrast** media queries honoured for every new animation and
  material.

### 5.7 Guardrails
- #3: nothing here touches `decide()`; outcome precedence is presentation, disposition on
  resolve is the existing analyst layer (`_perform_case_action`).
- #9: all case-derived strings stay plain text nodes.
- G1: disposition pickers open empty; `disposition_declared` sent only when the analyst
  operated the picker.

---

## 6. "Nothing lost" checklist for the redesign
Queue: scope line, Active/All, refresh, search fields (10), severity/status filters, 4 sorts,
clear, select-visible, row fields (rail, title, age, severity, risk, id, fact, status), bulk
actions (8) + job banner, resize persistence. Header: title, id+copy, severity, demo badge,
Share, all Take Action items (lifecycle per status, reinvestigate, playbook, refresh, ask,
new tab, JSON, Markdown, notify, campaign), close. Overview: every item in §3.3. Tabs: §3.4
in full. Dialogs: §3.5. Newly surfaced: §3.6.
