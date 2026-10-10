# D8: Case Manager UX diagnosis and a redesign that keeps every datum

**Scope.** Diagnosis only. No repository file was changed.

**Environment.**
- Repo: `Testing` @ `6769207`.
- Live demo: web UI on :5173 (Vite dev, React `StrictMode`) and backend on :8088, logged in as `Admin`.
- Demo data: 95–97 cases, 23 of them active.

**Scripts (read-only).** All are in `r12/diag/scripts/cm/`:
- `capture.mjs`: viewport × theme captures, tabs, Take Action, Close dialog, bulk actions, keyboard probe.
- `probe2.mjs`: latency, focus, below-xl layout.
- `probe3.mjs`: 1280×800 Close dialog, bottom of the Investigation tab, a closed case, the sheet.
- `lat.mjs`, `sse.mjs`: connection-stall probe.
- Raw numbers: `results-dark.json`, `results-light.json`, `probe2-dark.json`, `probe3.json`.

**Screenshots.** All in `r12/shots/`, prefixed `diag-cm-*`. 38 files:
- `diag-cm-{dark,light}-{1280,1440,1920}-overview.png`
- `diag-cm-{dark,light}-1440-tab-{timeline,investigation,threat-context,collaboration,chat}.png`
- `diag-cm-dark-1440-overview-scroll{1,2}.png`, `...-tab-*-scroll1.png`, `...-tab-timeline-loaded.png`
- `diag-cm-{dark,light}-1440-takeaction.png`, `...-close-dialog.png`, `...-bulk-menu.png`, `...-row-hover.png`
- `diag-cm-dark-1280-close-dialog.png`, `diag-cm-dark-1280-closed-case.png`, `diag-cm-dark-1280-tab-investigation-bottom.png`
- Sheet presentation: `diag-cm-dark-1440-sheet.png` (still loading) and `diag-cm-dark-1440-sheet-loaded.png`.
- Below the xl breakpoint: `diag-cm-dark-1180-below-xl.png`.

> Note: the server-synced theme overrode the requested one in `probe3.mjs`. The three
> `diag-cm-dark-1280-close-dialog / -closed-case` and `diag-cm-dark-1440-sheet-loaded`
> files therefore render in the **light** theme despite their names.

Companion documents. This diagnosis does not repeat them.
- `r12/research/case-ux.md`: the competitor study (XSIAM/XSOAR, SecOps, Defender/Sentinel, Splunk ES 8, Elastic, TheHive) and an earlier data inventory. Its §5 recommendations are adopted below.
- `r12/diag/disposition.md`: root cause of the SOC analyst's screenshot 5, where the case was "Undetermined" after closing it as FP.

---

## 0. TL;DR: the 14 problems that make it feel "cramped and unfinished"

| # | Problem | Severity | Evidence |
|---|---|---|---|
| 1 | **The queue silently omits data.** It loads the newest 200 cases and filters Active, search and Status **client-side**. On the analyst's deployment (6,438 cases, 253 open, per screenshots 1–3) the Active queue can drop open cases older than the newest 200, and search cannot find them. Active mode never says "of N total". | **P0 (data loss)** | `CaseManager.tsx:84,533` (`limit: 200`), `:562-565` (Active = client filter), `:579-603` (client search), `:802-807` (only All mode shows total). The backend already supports `status_group=active`, `offset` and `sort_field` (`backend/app/api/routes.py:4792-4806`, `CASE_PAGE_LIMIT=200` at `:4766`). |
| 2 | **Status, outcome, owner, tags and times are missing from the detail header.** The embedded header shows only title, id, "Critical severity" and SAMPLE. Status and disposition live in the Overview body and disappear on the other 5 tabs. Assignee appears only in Collaboration. Tags are not rendered anywhere. SLA clocks (`detected_at`, `acknowledged_at`, `first_response_at`) and `urgency_band` are not rendered. | P0 | Embedded header `CaseDetail.tsx:1320-1355`; the sheet header does show them at `:1369-1402`. Status chips in body only: `OverviewPanel.tsx:1227-1244`. Assignee: `CollaborationPanel.tsx:74`. `grep "\.tags"` finds no render. |
| 3 | **The headline contradicts the human outcome.** "Needs human review — closed" while the analyst recorded FP. This is the analyst's screenshot 5. | P0 | `OverviewPanel.tsx:132-156,1068`; see `disposition.md`. |
| 4 | **The Close dialog hides its own submit button.** At 1440×900 the dialog is 765 px tall and scrolls (871 px of content). At 1280×800 it is 680 px tall and **Cancel / Close case sit at y = 872, below the viewport**. The footer is not sticky. | P0 | `diag-cm-dark-1280-close-dialog.png`; `ui/dialog.tsx:44` (whole content `overflow-y-auto`); `ConfirmActionDialog.tsx:156,311`. |
| 5 | **Focus is lost after every lifecycle dialog.** Escape, Cancel or submit leaves `document.activeElement = BODY` in both themes (WCAG 2.4.3). | P1 | `results-*.json → *-focus-after-dialog`. The dialog is opened from a menu item via state, not a trigger (`CaseDetail.tsx:1455-1466`, `ConfirmActionDialog.tsx:156`). Contrast the sheet's explicit opener restore at `CaseDetail.tsx:322-332`. |
| 6 | **No keyboard model in the queue.** It takes **46 Tab presses** to get from the first row to Take Action, because every row has two tab stops. There are no ↑/↓ or J/K, no `/` to search, no `?` help and no tab or action shortcuts. | P1 | `probe2-dark.json`, `results-*.json → *-keyboard`; `CaseManager.tsx:307-328`. A grep for `keydown` or hotkeys in `Cases`, `CaseManager` and `CaseDetail` finds nothing. |
| 7 | **Slow case switching with a full blank flash.** A row click takes about 2.5 s before the Overview renders. `key={selectedCaseId}` remounts the whole detail into a page-level `LoadingState`. There is no stale-while-revalidate and no prefetch. The backend answers `GET /cases/{id}` in 2–4 ms with curl, but the **first browser fetch after mount stalls 2.7–4.9 s**. | P1 | `CaseManager.tsx:1233-1240`. The timings are in `lat.mjs` (`fetch /api/health` ×4 = 4923, 5, 4, 4 ms) and `probe2-dark.json` (`msRowClickToOverview` = 2562). See §2.6. |
| 8 | **The queue never updates on its own.** No SSE subscription, no polling, and no refresh after a bulk job finishes. Rows keep their old status until the manual ↻. | P1 | `CaseManager.tsx:529-554` (load once), `:682-723` (submit then clear selection, no reload). `useEventStream` is not used. The backend publishes no `cases` topic (only `cases:{id}` agent steps and activity: `pipeline.py:242`, `routes_cases_collab.py:250,291`). |
| 9 | **Truncation everywhere in the queue.** It is fixed at 400 px even on a 1920 screen (21% of the width). 50 meta spans across 23 rows are truncated at every viewport, so the **case id is unreadable** ("case-dfe…") and the source is clipped ("Micros…"). 4 of 23 titles are truncated. | P1 | `results-dark.json` (`metaTrunc: 50`, `truncTitles: 4` at 1280, 1440 and 1920); `CaseManager.tsx:93` (`SPLIT_DEFAULT_QUEUE_PX = 400`), `:357-364`. |
| 10 | **Severity and risk contradict each other without explanation.** Rows read "Critical · Risk 7". The explanation ("Source severity: Critical → We assess: Low risk") is only on the second screen of Overview. Investigation paints **Risk 7/100 in critical red**. The Timeline's risk stage is always red and glowing. | P1 | `CaseManager.tsx:170-172` (row severity = source `severity_band`), `InvestigationPanel.tsx:231-235` (hard-coded `text-critical-text`), `StageTimeline.tsx:244` (risk stage always `bg-critical` + glow). |
| 11 | **Heavy duplication; weak hierarchy.** See the table below. | P1 | §2.3. |
| 12 | **Three visual dialects inside one pane.** Overview is flat and sentence case. Investigation and Threat context use bordered cards, tracked capitals and Title Case. The Timeline uses tracked-caps stage titles with glows. Chat starters are Title Case. All of this breaks the ui-standard rule "sentence case, never tracked capitals" and its rule against nested cards. | P2 | Tracked capitals: `InvestigationPanel.tsx:192,221,230,255`; `ThreatContextPanel.tsx:194,332-375,563-607`; `StageTimeline.tsx:263,364,439,528`; `DecisionCard.tsx:94,248`; `WhyPanel.tsx:209-357`; `CollaborationPanel.tsx:342`; `ClusterFormationDiagram.tsx:101,250`. Title Case: "AI Assessment Summary" and "Investigation Trace" (`InvestigationPanel.tsx:183,257`); `CaseChatPanel.tsx:29` "Summarize Case / Check IOCs / Suggest Remediation". Standard: `docs/development/ui-standard.md:30,38,55,126`. |
| 13 | **Misleading or raw content.** IOC verdict shows **"Clean"** when the source is "Unavailable" and confidence is 0%. AI discussion messages show raw Markdown (`**`, backticks). The Activity feed shows raw `turn=turn-0c55…8 step=4 model call 2 of 5`. | P1 (13a), P2 | `ThreatContextPanel.tsx:252,468` (`is_malicious ? 'Malicious' : 'Clean'`); `CaseThread.tsx:413` (pre-wrap plain text; `chat/ChatMarkdown.tsx` exists); `CaseActivityFeed.tsx:252-260`. Screenshots `...-tab-threat-context.png` and `...-tab-collaboration.png`. |
| 14 | **The main action takes two clicks and is buried.** The embedded header has no primary contextual CTA. "Close case" is item 2 of 15 in Take Action. The sheet does have a primary-CTA footer (`CaseDetail.tsx:2165-2261`), so the two presentations disagree. Bulk actions are invisible until a hidden checkbox is hovered, and bulk cannot "Close with disposition". | P1 | `CaseDetail.tsx:1436-1575`; `CaseManager.tsx:313-317` (checkbox `opacity-0` until hover), `:1017-1103`. |

Other glitches found while capturing:

- **Sheet (Overview/Scans/Investigate).**
  - Radix autofocus lands on an icon button, so the "Ask about this case" tooltip opens by itself.
  - The source page's `CaseHoverCard` stays open on top of the modal sheet (`probe3.json`: `tooltipOpen: true, hovercard: true`).
  - The header is 9 unlabeled icons.
  - The body still uses the forbidden "Decision brief" eyebrow and card-in-card layout.
  - Files: `diag-cm-dark-1440-sheet*.png`; `CaseDetail.tsx:1589-1906`; `OverviewPanel.tsx:1313,1351`.
- **Below xl (1180 px).** The back bar shows the raw UUID `case-66a5a935…` instead of the display id or title (`CaseManager.tsx:1228-1230`).
- **Status filter.** Its options come only from statuses present in the loaded slice (`CaseManager.tsx:567-573`).
- **Dev-only.** Every case GET fires twice (`/rationale`, `/triage`, `/campaign`, `/{id}`) because of React `StrictMode` (`main.tsx:12`). Do not attribute this to production.

---

## 1. Measurements

All figures are from `results-dark.json`. Light-theme geometry is identical.

| Viewport | Nav | Queue | Detail | Detail header | Visible tab-panel height | Overview length | Rows fully visible | Queue chrome above first row |
|---|---|---|---|---|---|---|---|---|
| 1280×800 | 40 px (collapsed) | 400 | 773 | **132 px** (2-line title) | **522 px** (65% of the viewport) | **3.39 screens** | 8 | 182 px |
| 1440×900 | 40 | 400 | 933 | 108 | 646 | 2.57 | 10 | 182 |
| 1920×1080 | 40 | 400 | 1413 | 83 | 850 | 1.90 | 13 | 182 |

Per-tab scroll height at 1440 (visible panel 646 px):

| Tab | Scroll height | Note |
|---|---|---|
| Timeline | 948 | |
| Investigation | **2,488** | The deterministic decision sits at **2,388 px**, after the full trace (`probe3.json`). |
| Threat context | 931 | |
| Collaboration | 1,317 | |
| Chat | 646 | |

---

## 2. UX problems by category, with code

### 2.1 Crampedness and space
- **Fixed 400 px queue at every width** (`CaseManager.tsx:93,439`). At 1920 the queue keeps 21% of the width while ids and sources are clipped. There is no responsive default.
- **182 px of queue chrome before the first row:**
  - h1, scope line and Active/All on one row;
  - a full-width search;
  - three Selects;
  - a "Select visible" row.
  - Code: `CaseManager.tsx:902-1119`.
- **The detail header wraps to 132 px at 1280.** The 2-line title (`line-clamp-2 text-xl`) sits above an id row above a badge row (`CaseDetail.tsx:1324-1354`). Tabs then sit below it in a non-sticky band, so the evidence panel gets only 522 px.
- **Wasted width at 1920.** The decision brief's left column has a large empty area. Impact and Priority are capped at `max-w-sm`, and the recommended action spans about 1,000 px with nothing beside it (`OverviewPanel.tsx:1247`, `diag-cm-dark-1920-overview.png`).

### 2.2 Truncation
- Row line 2 has severity, risk, id, fact and status in one flex line. The id and fact both `truncate` (`CaseManager.tsx:357-364`), so the id becomes useless ("case-dfe…").
- The full id is only in the `title=` attribute, which keyboard and touch users cannot reach.
- The Threat context "Opened case" card truncates the id (`case-dfec9180a889470...`). Related cases appear as raw 32-hex UUID chips with no title or status (`diag-cm-dark-1440-tab-threat-context.png`).

### 2.3 Duplicate information (one case, Overview tab plus siblings)

| Datum | Where it appears today | Count |
|---|---|---|
| Detection rule | Source says → Detection rule (`OverviewPanel.tsx:1461`) · Attack story → "Detection rule fired" (`:1116`) · Entity relationship → Detection (`:1152`) · Timeline → Alert received | 4 |
| Primary entity value | Title ("ip:192.0.2.90 — …") · Primary entity (`:1727`) · Entity relationship → IP (`:1149`) · Timeline | 4 |
| Source / surface | Source says → Source (`:1473`) · Entity relationship → Surface (`:1154`) · Timeline | 3 |
| Risk score | Signal profile meter · Investigation card · Timeline: text, chip and meter (3×) · DecisionCard | 6 |
| Recommended action | Overview (`:1261`) · Investigation card (`InvestigationPanel.tsx:225`) · chat answers. On closed FP cases it is **identical to the summary sentence** shown right above it ("Benign baseline activity; no action required." twice, `diag-cm-dark-1280-closed-case.png`). | 2–3 |
| Investigation inputs block | Overview (`OverviewPanel.tsx:1377-1385`) and Investigation (`InvestigationPanel.tsx:241-248`) render the **same component** | 2 |
| "Decision is made by deterministic code" disclaimer | Recommended action (`OverviewPanel.tsx:1264-1267`) · Code decided (`:1652-1655`) · Investigation inputs footnote · Investigation decision band | 4 |
| Status | Queue · Overview chips · Attack story "Escalated · System" · Timeline decision · Investigation decision badge | 5 |
| Findings and MITRE counts | Agent found · Attack story · Evidence checklist / Threat context | 3 |

### 2.4 Weak hierarchy and unclear status, verdict and disposition
- **The headline is built from the AI verdict and the lifecycle status** (`OverviewPanel.tsx:132-156`). The analyst's disposition is just a grey chip beneath it.
- The embedded Overview has **no AI verdict chip** (the `isCaseManager` path drops `VerdictBadge` at `OverviewPanel.tsx:1494-1508`). The verdict exists only inside the headline sentence.
- **Two badge grammars sit side by side.** Status ("Escalated") and disposition ("True positive") are both filled outline chips of the same size and tone family (`OverviewPanel.tsx:1228-1229`). Nothing says which is the lifecycle and which is the outcome.
- **"Code decided" contradicts itself on human-closed cases.** It shows "Deterministic decision authority `case_manager`", then "Authority: Analyst", then "made by deterministic code" (`OverviewPanel.tsx:1628-1655`; `disposition.md` §diag-disp-6).
- **On closed cases, Overview still says** "Use the case action controls to close or escalate" (`OverviewPanel.tsx:1264`).
- **The Investigation tab puts the decision last.** It renders the AI banner, then inputs, then the about-2,000 px trace, then the "Deterministic decision" (`InvestigationPanel.tsx:154-289`). The banner turns critical-red whenever `severity_band === 'critical'` **or** the verdict is TP (`:142-144`), so a Risk 7 case looks like an emergency.

### 2.5 Inconsistent chips and colour semantics
- **Severity colours are reused for non-severity meanings.** Timeline stage tones are fixed per stage kind (risk = critical red with glow, triage = medium amber; `StageTimeline.tsx:241-247`). Investigation risk is always red (`InvestigationPanel.tsx:231-235`).
- **The same concept is styled differently across tabs.**
  - Uppercase tracked chip: "INITIAL ACCESS" (Threat context).
  - Mono pill: "1 input".
  - Coloured outline chip: "risk 7/100" (Timeline).
  - Source tags: "SIEM", "AI" and "Code" tag pills, with "SIEM" repeated twice in Source says.
- **Sheet vs embedded divergence.**
  - The sheet has the eyebrow, card-in-card, icon tabs, a 9-icon toolbar and a footer CTA.
  - The embedded view has underline tabs and the Take Action menu.
  - The two presentations of the *same* case look like two products (`diag-cm-dark-1440-sheet-loaded.png` vs `diag-cm-light-1440-overview.png`).

### 2.6 Slow interactions
- **Switching case remounts everything.** `key={selectedCaseId}` (`CaseManager.tsx:1234`) and the page-level `LoadingState` (`CaseDetail.tsx:1926-1933`) together blank the pane for 2.5 s. The queue row is highlighted immediately, but the detail is blank. Apple §1 asks for instant response, and §3 says never lock out input.
- **The first API call stalls. Evidence:**
  - The backend answers in 2–4 ms with curl.
  - In the page, the first `fetch('/api/health')` after mount took **4,923 ms**, then 5, 4 and 4 ms. The first `GET /cases/{id}` took 2,742 ms.
  - The page holds 2 long-lived `EventSource` streams (`/api/events?topics=jobs` **and** `?topics=inbox,jobs,notifications`; `jobs` is subscribed twice).
  - It also opens two more during the StrictMode double mount.
  - Production nginx is plain HTTP/1.1 (`webui/nginx.conf:3`, no `http2`).

  **Hypothesis to verify on the nginx image:** a per-origin connection-pool stall caused by SSE streams plus the dev double-mount. Mitigation regardless of the cause: one multiplexed `EventSource` (already supported by the bus), prefetch, and keep-previous rendering.
- **The list payload is heavy:** 266 KB for 95 cases, because whole `Case` documents include `history`, `evidence` and `status_history`. That is about 560 KB at 200 cases. A queue-row projection would cut it more than 10×.
- **Tab persistence across case switches works** (the Timeline stays selected). Keep this.

### 2.7 Scroll traps and layout
- **Nested scrolling.**
  - The queue list scrolls inside the frame.
  - The tab panel scrolls inside the detail.
  - The Close dialog scrolls inside the modal, and its Grade card nests inside that.
  - In Collaboration, the right column (Ownership, Tasks, Activity) scrolls with the discussion. The **assignee control scrolls off-screen** once the thread is long (`diag-cm-dark-1440-tab-collaboration-scroll1.png`).
- **The trace is a "terminal" pane** with macOS traffic-light dots (decorative chrome, `TraceTimeline`) about 2,000 px tall, with no collapse, filter or jump-to-decision. Everything below it is effectively unreachable.

### 2.8 Focus and accessibility
- The lifecycle dialog loses focus to `BODY` (problem 5).
- The queue has 2 tab stops per row and no roving tabindex. The WAI-ARIA listbox/grid pattern expects one tab stop and arrow-key navigation.
- **Opening a case does not move or announce anything.** Focus stays on the row (good for browsing). But no `aria-live` announcement says "Case X loaded", and nothing jumps to the detail (there is no F6 or region-cycling shortcut).
- **The row's accessible name is the concatenated text** ("…2m ago High Risk 7"). It omits the id, outcome and owner.
- The Select-visible checkbox and the row checkbox are hidden (`opacity-0`) until hover or focus on pointer devices, so **bulk work cannot be discovered**.

### 2.9 Missing keyboard shortcuts
None exist. Defender has ↑/↓ for previous/next incident; SecOps and Gmail-style queues use J/K, X, `/` and `?` (see `case-ux.md` §2.2).

### 2.10 Bulk-action discoverability and coverage
- **The toolbar only exists after a hidden checkbox is ticked** (`CaseManager.tsx:1017`). "Select visible" is the only selection affordance before that.
- **Bulk cannot close with a disposition.** Bulk "Resolve" sends no disposition (`CaseManager.tsx:781-787`), which is how the analyst's "Undetermined" also arises (`disposition.md`). `set_status=closed` is rejected server-side.
- **Bulk assign is free text** with no user picker. Single-case assign uses the user list (`CollaborationPanel.tsx`).
- **No progress is shown in place.** The banner says "Track progress in Inbox". Completed jobs do not refresh rows (problem 8).

---

## 3. Data inventory: every element that must survive

`case-ux.md` §3 is the authoritative long-form inventory and §6 is its checklist. The live capture confirms it and adds the items marked **(+)**.

**Queue pane.**
- Header and scope:
  - h1 "Active cases" / "All cases";
  - scope line "N shown · N active / N loaded (/ N total)";
  - Active/All;
  - refresh.
- Filters:
  - search over 10 fields (`case_id`, `case_number`, `title`, `summary`, `status`, `verdict`, entity type and value, `source_name`, `assignee`);
  - Severity;
  - Status;
  - Sort (Latest, Highest risk, Newest, Title A–Z);
  - Clear filters.
- Selection:
  - "Select visible" with its count;
  - empty, error and loading states.
- Row:
  - severity rail;
  - title;
  - relative updated age;
  - severity word and glyph;
  - Risk N;
  - display id;
  - primary fact (entity, else source, else summary);
  - status glyph and label ("Open · awaiting analyst");
  - checkbox;
  - open-state rail and `aria-current`.
- Bulk:
  - count and help line;
  - Acknowledge, Assign, Add tag, Set status, Set disposition, Reinvestigate and Resolve;
  - Clear;
  - outcome banner and toast "Open Inbox";
  - form dialogs and confirm dialogs with their copy.
- Split:
  - resizable divider (320–680, persisted, keyboard, double-click reset);
  - back bar below xl;
  - "Select a case" empty state.

**Detail header.**
- Title (UNTRUSTED);
- display id and copy;
- severity badge;
- SAMPLE/Demo badge;
- Share;
- Take Action, in three groups:
  - *Case actions*, which depend on status: Acknowledge & investigate, Escalate, Close case, Mark resolved, Put on hold, Resume, De-escalate, Reopen, Set disposition, Confirm FP;
  - *Investigation*: Reinvestigate (model picker and cost warning), Run a playbook, Refresh case, Ask about this case;
  - *Share & export*: Open in new tab, Export JSON, Export Markdown report, Notify (channel picker), Open campaign;
- Close pane.
- The sheet adds created and updated times, status, disposition, auto-closed, escalated and campaign chips.

**Overview.** Everything in `case-ux.md` §3.3, plus:
- **(+)** the severity-delta strip "Source severity → We assess";
- the provenance tags (SIEM, AI, Code);
- "Review inputs";
- the persona label with "Consulted";
- copy-indicator chip;
- Internal/External scope badge;
- attack-story step details;
- evidence-checklist columns (Check, Result, Evidence, Confidence impact);
- reproduce query with its "read-only" caption;
- **(+)** auto-close objection deadline ("reopen before Oct 11, 2026, 05:29 PM").

**Timeline.** Per stage:
- UTC time;
- stage name;
- narrative;
- severity and source chip;
- evidence block with copy;
- "View event details";
- risk score meter and risk-factor table;
- "View deterministic trace".

**Investigation.**
- AI assessment: summary, confidence, recommended action, risk score.
- Investigation inputs.
- Trace header: "18 steps · 5 tools".
- **Each trace step:** time, actor, step, untrusted payload with copy.
- Deterministic decision summary and status badge.
- "Show full assessment evidence" (WhyPanel): retrieved docs, retrieval score, returned-by, tools, threat verdict, reputation, country.
- "Show policy inputs" (DecisionCard).
- Grading history.

**Threat context.**
- MITRE technique id, name, tactic, link;
- IOC reputation (value, verdict, source, confidence, assembled);
- "How this case was clustered": input alerts (count, contributing sources, alert ids), correlation cluster (id, rule sentence, window, threshold), opened case;
- related cases;
- asset context.

**Collaboration.**
- Discussion: message count, author, origin chip (chat or AI), time, Reply / React / Edit / Delete, new message with @mention and ⌘↵.
- Ownership: assignee picker.
- Tasks: empty state, add.
- Activity: type, actor, time, summary, ref.

**Chat.**
- "Scoped to <id>" and "Ready";
- intro;
- "What can the assistant access?";
- 3 starters;
- composer.

**Close dialog.**
- Disposition (required, opens empty, "Currently recorded: X");
- Resolution;
- Tags;
- Analyst note and durable-context help;
- Grade the AI decision:
  - what actually happened;
  - "Rate in detail": accuracy, reasoning quality, action appropriateness, agree/override chip.

**Case fields not rendered in Case Manager today.** These must gain a home:
- `tags`;
- `assignee` (outside Collaboration);
- `detected_at`, `acknowledged_at`, `first_response_at`;
- `urgency_band`;
- `detection_source`;
- `notifications_sent`;
- `origin_surface`;
- `source_id`;
- `history[].classified_disposition` (who classified it and when);
- `verdict_history`;
- `campaign_id` (only reachable through a menu item).

---

## 4. Proposed redesign (keeps every datum)

**Principle.** Separate *facts about the case*, which must stay visible on every tab, from *the evidence narrative*, which belongs in tabs. This is how:
- Sentinel works (persistent left details panel);
- Defender works (Incident details pane plus side pane with ↑/↓);
- XSIAM works (case header with score, severity and assignee editable in place, plus a Resolve dialog with a required reason);
- SecOps works (top bar with priority, stage, tags, assignee, plus a Close Case CTA).

Visual language follows the Apple skill:
- one material hierarchy;
- sentence case;
- weight and size for hierarchy rather than boxes;
- instant feedback;
- interruptible spring motion, honouring reduced motion and reduced transparency.

### 4.1 Layout (desktop, ≥ xl)

```
┌ Queue (default clamp(360px, 28%, 520px); persisted override) ┬ Case workspace ──────────────────────────────────────────────┐
│ Cases  [Active 253|Mine 12|All]   ● Live   ⟳                 │ ┌ Sticky header — translucent material, scroll-edge fade ───┐ │
│ [⌕ Search all cases…  /]  [Filters (2) ▾]  [Sort ▾]          │ │ Title (text-xl/semibold, 2-line clamp; container q → lg)   │ │
│ ☐  23 of 253 · loaded 200 · Load more                         │ │ case-0042 ⧉ · ▲ High (source) · Risk 7 Low · ● Escalated │ │
│ ───────────────────────────────────────────────────────────── │ │ · Outcome: — (AI: True positive 90%) · @asmith ▾ · 2 tags │ │
│▌ip:192.0.2.90 — Entra ID Protection: workload…   15m          │ │ · Opened 15m · Ack — · SLA 45m left   [Acknowledge][Take action ▾][⇪][×] │
│▌High src · Risk 7 · AI TP 90% · @as · ⚠ Escalated             │ │ Overview · Timeline · Investigation · Threat (2) · Collab (4) · Chat │
│  case-dfec…70b4 · Microsoft Entra ID              (Comfortable)│ └──────────────────────────────────────────────────────────┘ │
│ ……                                                            │ ┌ Evidence column (tab content) ─────┬ Facts rail (≥ 60rem pane) ┐ │
│                                                               │ │                                     │ Outcome & AI verdict     │ │
│                                                               │ │                                     │ Signal profile + factors │ │
│                                                               │ │                                     │ Impact · Priority · Urg. │ │
│                                                               │ │                                     │ Owner · Tags · Campaign  │ │
│                                                               │ │                                     │ Times/SLA · Source · Rule│ │
│                                                               │ │                                     │ Related (n) · Build/cost │ │
└───────────────────────────────────────────────────────────────┴─┴─────────────────────────────────────┴──────────────────────────┘
```

#### Queue
- **Server-backed scope.**
  - Active uses `status_group=active`; All uses no group.
  - Add **Mine** (`assignee=me`, as an additive query param).
  - Use `sort_field` and `sort_order` server-side. Page with `offset` through "Load more" or infinite scroll.
  - The scope line always states *loaded vs total*.
  - Search: a debounced server query (additive `q` on `/api/cases`, or reuse `/api/search`). A client filter stays as an instant pre-filter on the loaded slice.
  - The Status filter lists the full taxonomy.
- **Row (Comfortable, default).**
  - Line 1: title and age.
  - Line 2: severity word marked *source* when `severity_source = source_asserted` · Risk n with its band word · **outcome** (analyst disposition once classified, else "AI TP 90%" or "Needs human") · assignee monogram · status glyph and label.
  - Line 3: id with **middle ellipsis** (`case-dfec…70b4`; full id in the accessible name and the hover card) · primary fact.
  - **Compact** density (SecOps parity) is one line: rail, title, risk, outcome, status, age. It is persisted per user in `user_prefs`.
  - Nothing is removed: line 3 holds what is truncated today.
- **Selection and bulk.**
  - A visible checkbox column, with no hover-only reveal.
  - When anything is selected, the filter row **morphs** into a bulk toolbar (Gmail or Defender "Manage incidents" pattern): `n selected · Select all 253 matching (server snapshot) · Assign ▾(user picker) · Status ▾ · Close… · More ▾ · ×`.
  - **Close…** opens the same Close-with-disposition dialog in bulk mode (SecOps requires a reason for bulk close).
  - Show per-row inline progress glyphs from the job SSE. Successful rows refresh and leave the selection; failures stay selected with a reason (ui-standard).
- **Live.**
  - Subscribe to a new additive `cases` topic (`{case_id, status, updated_at}`, published after save, aggregate-only, #7/#9 safe).
  - Fold `jobs` into the shell's single EventSource.
  - New cases slide in at the top with a "3 new" pill when the list is scrolled (as XSIAM and SecOps auto-refresh).
- **Keyboard** (one tab stop, roving tabindex, `role="listbox"` with `aria-activedescendant` or a grid):

  | Key | Action |
  |---|---|
  | ↑ ↓ / K J | Move and open |
  | Space / X | Toggle selection |
  | Shift+↑↓ | Extend selection |
  | Enter / O | Focus detail |
  | / | Search |
  | Esc | Clear selection |
  | ? | Shortcut sheet |

  Advertise each with `aria-keyshortcuts` and show them in menus.

#### Header (sticky, the case's facts on every tab)
- Line 1: title.
- Line 2, the meta row (container-query wrap): id and copy · **source severity** · **risk with band** · **status** (glyph and text, no fill) · **outcome** (filled semantic badge: analyst disposition if classified, else an "Unclassified" placeholder plus a muted AI line) · **assignee** (monogram; Popover quick reassign / "Assign to me") · **tags** (first 2 + "+n", Popover edit) · **times** (Opened, Ack, First response, SLA countdown from `urgency_band` and SLA policy) · campaign chip · SAMPLE.
- Right side:
  - **one primary contextual button** from `actionPlanForStatus(status).primary` ("Acknowledge" / "Close case…" / "Reopen"), matching the sheet footer;
  - **Take action ▾** (unchanged contents, plus shortcut hints);
  - Share;
  - Close pane.
- Material: `bg-background/80 backdrop-blur-xl` with a 12 px scroll-edge mask instead of the hairline. It turns solid under `prefers-reduced-transparency` or `prefers-contrast: more` (Apple §12).
- At 1280 the header is about 96 px (single-line title at `text-lg` when the pane is under 56rem; full title in a tooltip and the accessible name). The tab panel gains about 40 px.

#### Facts rail (pane ≥ 60rem, i.e. 1440+ with the queue at default)
This is a sticky right column inside the tab area, visible on **every tab**. It is the single home for:
- outcome block (analyst classification, by and at, AI verdict and confidence, agree/override);
- Signal profile: risk meter, confidence meter, 5 risk factors with help tips;
- Impact, Priority, Urgency;
- Owner and Tags (editable);
- Campaign;
- Times and SLA clocks;
- Source;
- Detection rule (with the source-severity delta cue);
- Primary entity (value, scope, type, enrichment rows, copy);
- Related cases (n, opens the list);
- Build provenance and investigation cost;
- Decided by.

Below 60rem the rail folds into the header meta row plus a **"Details" button** that opens it as a right Sheet. There is no scrim, because it is a parallel non-blocking panel (Apple "separate to keep flow"). This mirrors Sentinel's collapsible details panel.

#### Overview (de-duplicated; each datum has one home and later mentions are links)
1. **Outcome band**, using `case-ux.md` §5.1 `caseOutcome()`.
   - Headline: the analyst classification when present ("False positive · by asmith 2h ago"). Otherwise an attributed AI assessment ("AI assessment: Likely true positive · 90%"). Status is shown separately in the header.
   - Summary sentence.
   - **Recommended action**, rendered only when it differs from the summary. When they are equal, render one paragraph labelled "Summary and recommended action". The datum is kept, the duplicate is dropped.
   - The authority sentence **once**.
2. **Investigation inputs** summary. ui-standard places it here; Investigation links to the detail and does not re-render it.
3. **Why it fired** (Source says, with the trigger sentence) · **What the agent found** (findings, clean checks, MITRE ids and related as links) · **How it was decided** (authority, route, auto-close tag, objection window). Remove the `case_manager` badge versus "Authority: Analyst" contradiction: show "Routed by policy (case_manager) · Closed by Analyst".
4. **Attack story**: a compact horizontal 4-step stepper. Its details become links into Timeline and Investigation instead of repeating the rule and source. The Entity-relationship flow's data (entity → rule → surface) moves into the rail's Primary entity block as "Seen by <rule> on <surface>".
5. **Evidence checklist** (full width at ≥ 56rem) and **Reproduce investigation**.
6. **Baseline advisory**, Related cases, Provenance & audit (status timeline, automation applied, run and cost meta, build), Investigation error, as today.

#### Tabs
- **Timeline.**
  - Stage titles in sentence case at `text-sm font-semibold`.
  - Colour reflects **value** (risk by `scoreBand`), not stage kind. Drop the glow shadows.
  - Show risk once: a meter with a disclosure for factors.
  - Evidence is a flat code block with an inline copy (no empty header bar).
- **Investigation.**
  - Order: **Decision first** (the deterministic decision summary and route) → AI assessment (neutral container; red only for a critical *risk* band) → "Show full assessment evidence" → policy inputs → **trace, collapsed by default** with step and tool counts, an actor filter (Agent / Tool / Code) and "Jump to decision".
  - Remove the decorative traffic-light chrome.
  - Sentence case: "AI assessment", "Investigation trace", "Confidence".
- **Threat context.**
  - Flat, divider-led sections (no card-in-card).
  - Tactic shown as sentence-case text.
  - IOC verdict becomes tri-state: **Malicious / No detections / Not checked (source unavailable)**. Never "Clean" when the provider is unavailable or the confidence is 0.
  - Related cases render as `CaseHoverCard` rows (title, status, outcome) with the id kept in mono.
  - The cluster diagram keeps all fields, with ids middle-ellipsised plus copy.
- **Collaboration.**
  - Ownership and Tasks become a sticky right column. The assignee is also in the header.
  - AI-authored messages render through the existing `chat/ChatMarkdown.tsx` safe renderer (no raw `**`). Human text stays plain (#9).
  - Activity rows become human-readable ("Model call 2 of 5 · gpt-5.6-luna"), with the raw `turn=…` ref under a "Details" disclosure (kept).
  - Add an Activity filter: Human / AI / System (Defender Activities, SecOps Case Wall).
- **Chat.** Starters in sentence case: "Summarize this case", "Check IOCs", "Suggest remediation". The tab label carries the turn count.
- **Tab labels carry counts:** Threat context (MITRE n), Collaboration (messages + open tasks), Investigation (steps).

#### Take Action and lifecycle dialogs
- The primary CTA is in the header (above). The menu keeps every item and shows shortcut hints:

  | Key | Action |
  |---|---|
  | A | Acknowledge |
  | C | Close… |
  | E | Escalate |
  | H | Hold |
  | R | Reinvestigate (always confirmed) |
  | M | Assign to me |
  | T | Tag |
  | Alt+1…6 | Switch tabs |

  Shortcuts are active only when focus is outside text entry. Every mutation still goes through its dialog.
- **Close dialog.**
  - `max-h-[85dvh]`, laid out as a grid: header, scroll body, **sticky footer** with a material and a top scroll-edge fade.
  - Two columns at ≥ 40rem: outcome, resolution and tags on the left; note and grading on the right.
  - Disposition becomes a **radio-card list** with one-line definitions (Sentinel/Splunk wording; keys 1–6). It is still empty by default (G1), with an "AI suggested: X" hint chip.
  - Add a **"Close & next"** split button that advances the queue.
- **Focus return.** Every state-opened dialog restores focus to the element that opened the menu (the Take Action trigger or primary CTA), reusing the sheet's `openerRef` pattern (`CaseDetail.tsx:263-332`), applied to `ConfirmActionDialog`, Reinvestigate, Playbook and Notify.

#### Performance and response (Apple §1 and §3)
- **Never remount the detail per selection.** Drop `key={selectedCaseId}`. Keep the previous case on screen with a 2 px top progress bar and dimmed content (`opacity-60`, no input lock) until the next case resolves. Then cross-fade the header and the content of the active tab. Use a Motion spring with `bounce: 0, duration: 0.25`, and opacity only under reduced motion.
- **Prefetch** `getCase`, `triage` and `rationale` on row hover and on arrow focus. Each costs 3 ms server-side. Cache them in a small LRU keyed by `updated_at`.
- **Lighter queue payload:** an additive `fields=queue` projection on `/api/cases` (id, number, title, summary[:160], status, verdict, confidence, disposition, severity_band, severity_source, risk_score, entity, source_name, assignee, tags, timestamps, urgency_band, campaign_id).
- **Connections:** one multiplexed `EventSource` for the whole shell. Enable HTTP/2 at the TLS terminator or nginx (documentation and Compose change), then re-measure the first-fetch stall on the production image.

### 4.2 Below xl (< 1280) and narrow panes
- **Queue-only, then detail with back.** Unchanged. The back bar shows the display id and title instead of the UUID.
- **The facts rail** becomes a "Details" sheet. Tabs stay scrollable with fade edges.

### 4.3 The sheet presentation (Overview, Scans, Investigate)
Converge it on the embedded design:
- same sticky header and meta row;
- same primary CTA plus Take action menu, replacing the 9-icon toolbar (keep each icon action as a labelled menu item);
- no "Decision brief" eyebrow;
- flat sections.

Also fix the sheet glitches:
- set `onOpenAutoFocus` to focus the title or heading instead of an icon, so no tooltip opens on load;
- close any open `CaseHoverCard` when the sheet opens.

---

## 5. Work packages (suggested ordering, with acceptance criteria)

| WP | Contents | Primary files | Acceptance |
|---|---|---|---|
| CM-1 (P0) | Server-backed queue: `status_group`, sort and paging, total and "loaded" disclosure, Status taxonomy, server search (`q`); a "Mine" scope | `CaseManager.tsx`; `routes.py list_cases` (additive `q`, `assignee`, `fields`) | With 300 open of 6,000 seeded cases, Active shows a total of 300 and pages to all of them. Searching for a case older than the newest 200 finds it. Tests in `CaseManager.test.tsx` plus backend `test_cases_list*`. |
| CM-2 (P0) | Sticky header meta row: status, outcome (`caseOutcome`), assignee, tags, times/SLA, campaign; primary CTA; parity with the sheet | `CaseDetail.tsx` header; new `casedetail/CaseHeaderMeta.tsx`; reuse `badges.tsx`, `CaseTriageHeader` help tips | Status, outcome and owner are visible on all 6 tabs. Tags render. A human-classified case shows its disposition as the outcome (with `disposition.md` fixed). Tests cover each status → primary CTA. |
| CM-3 (P0) | Close dialog: sticky footer, two columns, radio cards, Close & next; focus return on all state-opened dialogs | `ConfirmActionDialog.tsx`, `ui/dialog.tsx` (opt-in `stickyFooter`), `CaseDetail.tsx` | At 1280×800 the submit button is visible without scrolling. After Esc, Cancel or submit, focus is on the opener (Vitest plus Playwright). |
| CM-4 (P1) | Queue keyboard model (roving tabindex, J/K/↑↓, X, `/`, `?`), shortcut sheet, `aria-keyshortcuts`, `aria-live` "Opened case …" | `CaseManager.tsx`, new `soc/hooks/useQueueKeyboard.ts`, `chat/shortcuts` pattern | One tab stop for the queue. ↓ opens the next case. 46 Tab presses become 2. Lint passes jsx-a11y. |
| CM-5 (P1) | No-remount case switching, prefetch, keep-previous plus progress bar, one EventSource; live `cases` topic and bulk-job refresh | `CaseManager.tsx`, `CaseDetail.tsx`, `lib/useEventStream.ts`, backend `realtime` publish after case save | Case switch shows the new header within 150 ms of a prefetch hit and never blanks the pane. A bulk job completion updates rows without ↻. |
| CM-6 (P1) | Facts rail and Overview de-duplication per §4.1; Investigation reorder (decision first, collapsed trace); Timeline colour by value | `OverviewPanel.tsx`, `InvestigationPanel.tsx`, `StageTimeline.tsx`, new `casedetail/FactsRail.tsx` | Every datum in §3 is still present (snapshot test of a field checklist). Each row in the §2.3 table has a single home. Risk 7 is never red. |
| CM-7 (P1) | Bulk toolbar visible-on-select, user-picker assign, bulk Close-with-disposition, per-row progress, "Select all N matching" (server snapshot) | `CaseManager.tsx`, jobs `case_lifecycle` params | Bulk close requires a disposition. Partial failures stay selected with a reason. |
| CM-8 (P2) | Visual-dialect cleanup: sentence case everywhere (the §0 #12 list), no card-in-card in Threat context and Investigation, Chat starters; safe Markdown in AI thread messages; readable Activity rows; tri-state IOC verdict; middle-ellipsis ids; queue density toggle and responsive default width | `ThreatContextPanel.tsx`, `InvestigationPanel.tsx`, `DecisionCard.tsx`, `WhyPanel.tsx`, `StageTimeline.tsx`, `CollaborationPanel.tsx`, `CaseThread.tsx`, `CaseActivityFeed.tsx`, `CaseChatPanel.tsx`, `CaseManager.tsx` | `route-visual-standard` style test: no `uppercase tracking` in `casedetail/*`. "Clean" never renders when the source is unavailable. No raw `**` in AI messages. |
| CM-9 (P2) | Sheet convergence and its glitches: autofocus tooltip, stuck hover card, eyebrow, 9-icon toolbar | `CaseDetail.tsx` sheet branch, `OverviewPanel.tsx` default branch, `CaseHoverCard.tsx` | No tooltip is visible on sheet open. No popper sits above the sheet. |

**Verification for every package:**
- re-run `r12/diag/scripts/cm/capture.mjs dark|light` and compare against the §1 table;
- `npm run test:strict`;
- `npm run lint`;
- `npm run build`;
- `pytest -q` for backend additions.

---

## 6. Guardrails

- **#3.** Nothing here touches `decide()`. The primary CTA and shortcuts open the same dialogs, which post the existing verbs (`wireAction`). Outcome precedence is presentation-only. Bulk close goes through the existing analyst layer (`_perform_case_action`).
- **#9.** Every case-derived string stays a plain text node. AI thread Markdown uses the existing sanitising `ChatMarkdown` only for AI-authored messages. Ids and queries stay in `InlineCode` and `CodeBlock`.
- **#7.** The live `cases` topic carries ids, status and timestamps only. It never carries raw logs.
- **G1.** Disposition pickers open empty. "AI suggested" is a hint, never a preselection.
- **ui-standard.** Keep:
  - one hairline split;
  - persisted queue width;
  - the two-line row grammar (line 3 is additive and density-gated);
  - the checkbox as a sibling of the open control;
  - sentence case;
  - no nested cards;
  - container queries for pane layout;
  - "Select visible" never implying all matches. "Select all N matching" is a separate, explicit, server-snapshotted control.

---

## 7. Journal entry (for the orchestrator)

```
### 2026-10-10 — D8 diag agent — Case Manager UX diagnosis
- Context: Round 12 D8 — "Case Manager could use a lot of work", keep all data.
- Did: Captured CM at 1280/1440/1920 × dark/light, all 6 tabs, Take Action, Close dialog,
  bulk menu, sheet; measured geometry/truncation/focus/keyboard/latency; wrote
  r12/diag/casemanager.md (14 ranked problems with file:line, full data inventory, redesign:
  server-backed queue, sticky header meta + facts rail, de-duplicated Overview, decision-first
  Investigation, sticky-footer close dialog, keyboard model, no-remount switching, live queue;
  9 work packages with acceptance). No repo files changed.
- Tests: n/a (diagnosis). Scripts: r12/diag/scripts/cm/*.mjs.
- Status: done.
- Next: SPEC CM-1..CM-9; CM-1/2/3 are P0 (data completeness, header facts, hidden submit).
```
