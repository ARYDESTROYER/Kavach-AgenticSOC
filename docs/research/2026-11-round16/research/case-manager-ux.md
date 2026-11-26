# Case Manager: a cleaner, segregated workspace (Round 16 research, key `case-manager-ux`)

Repository: `Kavach-AgenticSOC`, branch `claude/round16`, read at `3cd362c` ("Journal: Round 16 start",
the tree that follows `3cfd5c0`). Read only. Screenshots read: `round15/shots/FINAL/case-manager-queue-*.png`,
`case-investigation-*.png`, `case-collaboration-files-*.png`, `close-dialog-*.png`, `review-card-*.png`,
`review-pending-*.png`, `phone-case-light.png` (desktop shots are 2880x1800 at device pixel ratio 2, so a
1440x900 CSS viewport; the phone shot is a 390x844 viewport).

Font scale used in this document is the project's own (`webui/tailwind.config.*`): `text-xs` 12/16,
`text-sm` 13/18, `text-base` 14/20, `text-md` 15/22, `text-lg` 16/24, `text-xl` 18/24, `text-2xl` 20/26.
All sizes below are CSS pixels.

---

## 1. Summary

The Case Manager is functionally rich but spends its first 324 px of a 900 px viewport on chrome before the
first line of case content, hides the facts rail at the most common laptop width, mixes four kinds of
information (source evidence, the AI's reading, the code's decision, the people's work) inside the same tabs,
and gives no visible signal while the AI is working on the open case. Every number the operator asked about
(for example "Risk 62") has its full arithmetic already computed by the backend, but it is buried three clicks
deep inside the Overview's stage story and is not reachable from the number itself.

The redesign below keeps every existing contract (#3 `decide()` untouched, one gateway, KV only, untrusted
values fenced) and changes presentation only, plus two small additive backend changes (a risk weight snapshot
on new cases, and a cheap "investigation running" nudge on the `cases` topic). It is organised as:

1. Reclaim the top: drop the page title band, compact the case header to two rows, collapse it on scroll.
   The first content line moves from y = 324 to y = 206 at 1440x900 (118 px higher), and to y = 182 once the
   header condenses.
2. Segregate by provenance into five tabs that each answer one question: **Brief** (what is this, in four
   lanes), **Evidence** (what the sources said), **AI investigation** (what the model did), **Response**
   (runbook and tasks), **Activity** (discussion, files, history). The Decision (the code lane) lives on the
   Brief and in click-through explainers, never inside the AI tab.
3. Make every number explainable on hover or click: risk (full arithmetic), AI confidence (against the
   auto-close bar), the decision (which policy clause, with the numbers it compared), SLA, severity
   provenance, priority.
4. Show the AI working: a slim live strip in the header while an investigation or re-investigation runs on
   the open case, and a glyph on its queue row. Re-investigate stops blocking the analyst in a modal.
5. Make the facts rail an "inspector" column that appears at more widths, slims to six collapsible sections,
   and can later host the case chat (Ask AI) so chat no longer replaces the evidence.

---

## 2. What the current build does (measured and read)

### 2.1 Vertical budget at 1440x900 (from `case-manager-queue-light.png`, `case-investigation-light.png`)

| Region | y start | y end | Height | Source |
|---|---|---|---|---|
| App top bar | 0 | 56 | 56 | `--header-h: 56px` (`webui/src/styles/theme.css:184`) |
| Shell inset top | 56 | 80 | 24 | `CONTENT_INSET` `py-6` (`webui/src/soc/AppShell.tsx:222`) |
| Page header "Case Manager", help, Live, Refresh | 80 | 120 | 40 | `PageHeader` in `CaseManager.tsx:2145` |
| Gap to the split frame | 120 | 144 | 24 | `gap-6` in `CaseManager.tsx:2144` |
| Detail header top padding | 144 | 160 | 16 | `pt-4` in `CaseDetail.tsx:1914` |
| Title row | 160 | 192 | 32 | `leading-8` `h2` (`CaseDetail.tsx:1940`) |
| Meta row, wrapped to two lines | 196 | 245 | 49 | `CaseHeaderMeta` `flex-wrap` (`CaseHeaderMeta.tsx:142`) |
| Tabs | 257 | 297 | 40 | `mt-3` + trigger `h-10` (`ui/tabs.tsx`) |
| Panel top padding, then first content | 297 | 324 | 27 | `CASE_MANAGER_PANEL_PADDING` |

First content at y = 324: 36% of the viewport is chrome. On a pending auto-close review case the review band
adds 46 px (first content at y = 374, 42%; `review-pending-light.png`). On a phone (`phone-case-light.png`)
first content is at y = 449 of 844 (53%): the page title, the "Cases" back bar, the title, a wrapped action
row and a three-line meta block all stack.

The top bar breadcrumb already says "Agentic SOC / Case Manager", so the page `h1` repeats it. The Chat route
already sets the precedent of a workspace route that owns its frame with an `sr-only` `h1`
(`webui/src/soc/chat/workspace/ChatWorkspace.tsx:548`).

### 2.2 Horizontal budget and the hidden facts rail

At 1440 px with the navigation expanded, the split frame is about 1150 px, the queue defaults to 360 px
(`responsiveQueueWidth`, `CaseManager.tsx:276`, 28% clamped to 360..520), the handle 9 px, so the detail pane is
about 780 px. The facts rail column only renders from a 60rem (960 px) pane (`CaseDetail.tsx:2496`,
`@[60rem]/case:block`). With the navigation collapsed to 64 px the pane is about 955 px, still under 960. So
at 1440 px, in either navigation state, the rail (outcome, risk meter, times, source, tags, record) is never on
screen; it lives behind the header's "Details" button (visible in every desktop screenshot).

### 2.3 Mixed lanes inside tabs

* Overview mixes the human workflow (runbook Next step card), the AI (Summary), the sources (What happened,
  Key entities), and the pipeline narrative (the six-stage story whose stages are source, code, AI and code).
* Investigation mixes the AI (assessment, trace, inputs), the code (Decision, automation applied) and source
  enrichment (Threat context: MITRE, indicator reputation, clustering, asset context).
* Collaboration has a "Tasks" section whose only content is a pointer ("Case tasks are in the Runbook tab")
  and a button (`case-collaboration-files-dark.png`).
* Chat is a full tab, so asking the AI about the case hides the evidence being asked about.

The product already has the four lane primitives: `ProvenanceTag` kinds `source` (Database glyph, info tint),
`ai` (Bot, primary), `code` (Binary, neutral) and `analyst` (UserCheck, strong outline)
(`webui/src/soc/components/ProvenanceTag.tsx:47-80`). They are used as small tags, not as the organising
principle of the page.

### 2.4 Explainability exists but is unreachable from the numbers

* `RiskDerivation` in `webui/src/soc/pages/casedetail/StageTimeline.tsx:178-290` renders a factor table
  (value, weight, share, contribution in points), the formula `Σ(value × weight) = N; N ÷ D = S/100`, and an
  honest mismatch note, from `StageRiskCalculation` returned by `GET /api/cases/{id}/stages`
  (`CaseDetail.api.ts:156-175`, `routes_triage.py`). It is shown only after Overview, What happened, expand
  "Risk assigned".
* The header shows no risk number at all; the queue row shows "Risk 62" with no hover; the rail shows a meter
  and five factor bars behind "Show risk factors" with per-factor tooltips, but no weights and no sum
  (`SignalProfile.tsx`).
* Weights are read from today's `Preferences.risk_weights` (`config.py:617`); the case stores only factor
  values and the total (`RiskBreakdown`, `models.py:282`). After any weight change the derivation cannot
  reproduce the stored score and says so.
* The AI confidence ("Needs human review 55%") has no visible comparison with the auto-close bar on the
  header chip; `confidenceCalibration()` (`casedetail/shared.tsx:446`) computes it and the rail prints one line
  only while the case is open.

### 2.5 The AI's work is invisible while it happens

* The pipeline publishes `agent.step` frames (`router`, `persona`, `tools`, `verdict`, then a terminal
  `decision` frame) to the per-case room `cases:{id}` (`backend/app/agents/pipeline.py:406-439`, emitted at
  lines 931, 985, 1030, 1179, 1254).
* The only consumer is `CaseActivityFeed`, which renders inside Collaboration, History, behind "Show all
  activity", collapsed by default (`CollaborationPanel.tsx:122,238`). So the narration is invisible unless the
  analyst opens that disclosure.
* Re-investigate is a synchronous request held inside a modal dialog with a spinner
  (`CaseDetail.tsx:1579-1597`, dialog at about 2580-2610), so the analyst cannot read the case while the AI
  works.
* The status word "Investigating" is the human-acknowledged lifecycle status; there is no separate signal
  for "the AI agent is working on this case now", so the two read alike.

### 2.6 Smaller defects seen while reading

| # | Where | What |
|---|---|---|
| D1 | `casedetail/AutomationApplied.tsx:85-93` | A `request_approval` record prints its raw detail `proposal=prop-94f0… kind=automation_ack` and then the same proposal id again under it (`case-investigation-light.png`). |
| D2 | `casedetail/shared.tsx:44`, `CaseDetail.tsx:1914` | Pane padding uses viewport breakpoints (`sm:`, `lg:`) although the UI standard says panels in a resizable pane follow container queries. |
| D3 | `CaseHeaderMeta.tsx:142` | The "one meta row" wraps to two lines at a 780 px pane (Opened, P3 and SLA drop to line two), costing 28 px. |
| D4 | `review/ReviewBand.tsx` in `CaseDetail.tsx:2242` | The review band is a 46 px bordered panel inside the sticky header on every tab. |
| D5 | `CollaborationPanel.tsx:216-233` | The Tasks section is a pointer to another tab. |
| D6 | `lib/useEventStream.ts:241` | Every `useEventStream` hook opens its own `EventSource`. On Case Manager with Collaboration open and the activity feed expanded the page can hold up to six (NotificationBell, JobMonitor, runbook frames, CaseManager, CaseThread, CaseActivityFeed). Without HTTP/2, browsers allow six SSE connections per browser and domain, counted across all tabs (MDN, https://developer.mozilla.org/en-US/docs/Web/API/EventSource), and `webui/nginx.conf` listens on plain port 80 (HTTP/1.1 unless a front proxy adds HTTP/2). The Console's own "Open in new tab" makes a second tab likely. **Verify in a browser** before adding any new subscription (section 5.4). |
| D7 | `CaseDetail.tsx` reinvestigate dialog | Long-running work in a blocking modal (section 2.5). |

---

## 3. What best-in-class workspaces do (with sources)

| Product | Pattern relevant here | Source |
|---|---|---|
| Microsoft Sentinel incident page | A details panel that "is always on display, no matter which tab is shown", collapsible to the margin while owner, status and severity stay editable; the rest of the page is two tabs, Overview (timeline, similar incidents, entities, top insights) and Entities; Tasks, Activity log and Logs open as side panels from a button bar under the title. | https://learn.microsoft.com/en-us/azure/sentinel/investigate-incidents |
| Microsoft Defender XDR, legacy incident page | A queue row opens a summary pane with "the priority assessment, the factors influencing the priority score", recommended actions, with up and down arrows to move through the queue; the full page has Attack story, Alerts, Assets, Investigations, Evidence and Response, Summary, Similar incidents; incident details sit in a right pane; Similar incidents shows a "Similarity reason" you can hover. | https://learn.microsoft.com/en-us/defender-xdr/investigate-incidents |
| Microsoft Defender incident cases (current, preview) | Two groups: Overview (Summary by Copilot, Attack graph) and Artifacts (Alerts, Assets, Investigations, Evidence, Activities, Similar cases), plus Comments and Attachments. AI summary, evidence and the human record are separate places. | https://learn.microsoft.com/en-us/defender-xdr/investigate-incident-cases |
| Defender priority score | A 0-100 priority score with the factors that influenced it shown in the summary pane. | https://learn.microsoft.com/defender-xdr/incident-queue |
| Google SecOps cases | Case top bar: priority, title, ID, stage, timestamp, tags on the left; Chat, Close Case, Refresh, Graph, Actions on the right; then tabs Case Overview, Case Wall, Alert Overview, Alert Events, Alert Playbooks. The Overview is a set of widgets (alerts, pending actions, description, latest wall activity, Gemini summary, quick actions); the Case Wall is the chronological log of human and automated actions. | https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/whats-on-the-cases-screen , https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/whats-on-the-case-overview-tab |
| Cortex XSOAR | Each incident has a War Room (chat plus an audit trail of every automatic or manual action), a Work Plan tab (the running playbook as a diagram) and an Evidence Board; evidence can be marked from the War Room. | https://cortex-docs.paloaltonetworks.com/cortex-xsoar-8-saas/investigate-and-respond-to-threats/incidents-and-indicators-investigation/investigate-an-incident/use-the-war-room-in-an-investigation |
| Splunk Mission Control | Response plans (phases with tasks) on a dedicated Response tab, separate from the incident overview. | https://help.splunk.com/en/splunk-enterprise-security-7/mission-control/investigate-and-respond-to-threats/respond-to-incidents/apply-response-templates-to-standardize-response-to-incidents-in-splunk-mission-control |
| Tines cases | Case content plus a configurable sidebar with Activity and comments, Case actions, Case fields, Linked cases and Tasks; each section has a shortcut (Shift+H, Shift+F, Shift+A, Shift+T, Shift+L), the sidebar hides with Ctrl+], resizes up to half the window, and its order and collapse state persist per browser. | https://www.tines.com/llm/docs/cases/overview/sidebar.md |
| Dropzone AI (AI SOC analyst) | Header carries Priority, Conclusion and Review Status; the investigation page separates the Investigation Summary (alert claim, conclusion reasoning, key findings), Threads (each AI question with sources queried), an Actions graph, an Evidence Locker (each source, the request and the response) and a Changelog. | https://docs.dropzone.ai/best-practices/deep-dive-into-investigation-reviews |
| Datadog incidents | A header with status and severity; an Overview whose summary modules (condensed timeline, latest notifications, pending tasks, responders, recent timeline entries) each link to a full tab. | https://docs.datadoghq.com/service_management/incident_management/incident_details/ |
| GitHub issues | A sticky sidebar "that stays visible as you scroll", so properties can be read and changed while reading long threads. | https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/ |
| Linear | "The issue sidebar now closely integrates issue properties with the main content" (July 2026); the March 2026 refresh made headers consistent and made "navigation sidebars slightly dimmer, allowing the main content area to stand out"; Space toggles a peek preview of a focused issue from a list; `[` collapses the sidebar. | https://linear.app/changelog/2026-07-23-agent-assisted-editing , https://linear.app/changelog/2026-03-12-ui-refresh , https://linear.app/docs/peek (search result; the page returned 404 to the fetcher, see section 10) |
| incident.io | The incident page highlights an up-to-date suggested summary "at the top of the incident page" that responders can accept, skip or edit. | https://incident.io/changelog/ai-in-the-dashboard |
| Zendesk Agent Workspace | A context panel beside the ticket for everything beyond the core conversation; agents can resize the context panel and the ticket properties panel. | https://support.zendesk.com/hc/en-us/articles/5447837546138-Creating-custom-layouts-to-improve-agent-workflow |
| Front | Sidebar plugins sit in a right panel of roughly a quarter to a third of the screen, resizable, pinned per user. | https://dev.frontapp.com/plugin.html (via search summary) |
| Cisco XDR (UX writing) | Risk scores explain themselves on hover; selecting an incident opens a side drawer with status, assignees, description, risk breakdown and assets; data is layered from summary to detail to raw. | https://blogs.cisco.com/security/from-frustration-to-clarity-embracing-progressive-disclosure-in-security-design/ |
| Research: "Too Much to Trust?" (arXiv 2503.02065) | "more explanation is not always better"; recommends "delivering brief, high-salience rationales by default, with on-demand access to layered contextual and technical detail"; Tier-1 analysts benefit from summary-level justifications, Tier-3 want internals. Interview-based (about 24), not a controlled measurement. | https://arxiv.org/html/2503.02065v2 |

Patterns that recur across them and that this design adopts:

1. **A summary first, whose modules link to full tabs** (Datadog, Defender Summary, SecOps Case Overview).
2. **Evidence is its own place** (Defender Artifacts and Evidence, Dropzone Evidence Locker, XSOAR Evidence
   Board).
3. **The human record (comments, actions, history) is its own place** (SecOps Case Wall, XSOAR War Room,
   Defender Activities, Sentinel Activity log).
4. **Response procedures are their own tab** (Splunk Response, XSOAR Work Plan, SecOps Alert Playbooks).
5. **Properties stay visible in a sticky, collapsible side panel** (Sentinel, GitHub, Linear, Tines, Zendesk).
6. **The AI assistant sits beside the record, not instead of it** (Defender Copilot pane on the right, SecOps
   Chat in the top bar).
7. **Scores explain themselves on hover or click, summary first, raw last** (Defender priority factors, Cisco
   XDR, the arXiv study).

---

## 4. Design rules for the redesign

1. **One question per region.** Header: what is it and what can I do. Brief: the four-lane answer. Each tab:
   one lane. Inspector: the facts. Nothing appears in two places except as a link.
2. **Lanes are always labelled the same way.** Evidence = `source` tag, AI = `ai` tag, Decision = `code` tag,
   People = `analyst` tag. Use the existing `ProvenanceTag` with its glyphs; colour is never the only signal.
3. **Numbers are short by default and complete on demand.** A number shows as a single value; hover (desktop,
   300 ms delay) shows a short reason; click or Enter opens the full arithmetic. Every explainer says where
   its numbers come from and never infers a missing input (the rule `riskFactorCaseReason` already follows).
4. **Chrome stays under 120 px.** Page plus header above the first content line: 206 px at 1440x900 including
   the 56 px app bar, 182 px when condensed.
5. **The pane, not the viewport, decides layout.** All case layout breakpoints are container queries on
   `@container/case` (fix D2).
6. **No new dependency, no new storage.** Popover, HoverCard, Collapsible, Sheet, Tabs are the existing Radix
   wrappers under `webui/src/ui/*`.

---

## 5. The redesign specification

### 5.1 Page frame (route `case_manager`)

File: `webui/src/soc/pages/CaseManager.tsx` (render at about lines 2126-2180).

* Remove the routed `PageHeader`. Render `<h1 className="sr-only">Case Manager</h1>` as the first child, as
  Chat does. Move:
  * the Live dot and the Refresh icon button into the queue control band, row 1, right end;
  * the page help text (`CASE_MANAGER_HELP`) into the view menu as "About Case Manager" (a menu item that
    opens a small Popover with the same text), next to "Keyboard shortcuts".
* Reclaim 8 px of the 24 px shell inset top and bottom, so the board sits on a 16 px inset on all four sides
  (matching the existing 16 px horizontal bleed):
  * `PageContainer` className: `h-[calc(100dvh-5.5rem)] min-h-0 w-auto -my-2 sm:-mx-2 xl:min-h-[600px]`
    (5.5rem = 56 px bar + 2 x 16 px insets).
  * Remove `gap-6` and the header from `case-manager-layout`; the split frame is the only child.
* The split frame keeps `surface-panel`, the 9 px focusable separator and its keyboard contract.
* Update `webui/src/soc/__tests__/route-visual-standard.test.ts:91` (the matched-pair assertion),
  `CaseManager.test.tsx:396`, and the console grammar guard if it requires a routed header on this page
  (`console-grammar.guard.test.ts:310-320`; Chat is the existing exception to copy).

Saving: 72 px (frame top moves from y = 144 to y = 72).

### 5.2 Queue pane

File: `CaseManager.tsx` (`QueueRow` at 344-565, control band at 2192-2590).

**Control band** (`data-testid="case-queue-controls"`), `px-3 py-2.5 space-y-2`, two rows of 32 px:

* Row 1: `SegmentedControl` (Active, Mine, Review with count, All) | spacer | Live dot (`StatusDot`, text
  hidden below a 400 px queue, `@[25rem]/queue:inline`) | Refresh icon button `h-8 w-8` | view menu (sort,
  Compact rows, Keyboard shortcuts, About Case Manager).
* Row 2 (unchanged): Select visible checkbox (bulk roles) | search | Filters (n).
* Band height: 10 + 32 + 8 + 32 + 10 = 92 px (today 98 px).

**Row** (comfortable density stays two lines, 64 px):

* Leading 40 px slot: by default the **severity glyph** (16 px, coloured by severity, the existing
  `semanticIcon(severity)`); it becomes the checkbox on row hover, `focus-within`, when any row is selected,
  while a bulk job runs, and always under `(pointer: coarse)`. Classes: the glyph `group-hover/row:hidden
  group-focus-within/row:hidden` and the checkbox `hidden group-hover/row:block group-focus-within/row:block`,
  with a `data-selection-active` attribute on the list that forces checkboxes on. This keeps bulk work one
  hover away (the Gmail and Linear pattern) and removes a column of empty boxes. The UI standard currently
  says the Case Manager shows the checkbox always; amend that sentence (section 8 of `ui-standard.md`
  already permits hover or focus reveal with the touch and "anything selected" exceptions).
* Line 2: severity word, "Risk N", case number, status or outcome, owner monogram. Colour once: keep the
  severity word and the left rail coloured, render "Risk N" in `text-foreground/80 tabular-nums` (today both
  are orange, so every high row has two orange tokens). Risk keeps its colour only in the header chip and the
  inspector meter.
* Hover (mouse only, 500 ms open delay) on the "Risk N" span: a `HoverCard` (`webui/src/ui/hover-card`) with
  the five factor bars from the row's own `risk_breakdown` and "Open the full calculation" (selects the case
  and opens the risk popover, section 5.7). It is not focusable inside the row button (no nested
  interactive); keyboard users reach the same content from the header chip.
* AI working glyph: while an investigation runs on that case (section 5.4), a 12 px `Bot` glyph with a 2 px
  primary ring, before the age, `aria-hidden`, and the row's accessible name gains ", AI agent is working".

**Focus mode** (new): `[` or a "Hide queue" button (`PanelLeftClose`, row 1) collapses the queue to a 44 px
strip containing: expand button, previous and next (`ChevronUp`, `ChevronDown`, same as K and J), the position
("3 of 15", vertical text is not needed: show it in a tooltip) and the AI working count. Persist per viewer in
`localStorage` key `soc.caseManager.queueCollapsed` (convenience only, wrapped in try/catch like the existing
width key). J, K, ↑, ↓ keep working while collapsed. Gives the pane about 320 px more.

### 5.3 Case header (sticky, `materialBar`)

Files: `CaseDetail.tsx` (1905-2272), `casedetail/CaseHeaderMeta.tsx`, `casedetail/review/ReviewBand.tsx`.

Container: `px-4 pt-2 @[48rem]/case:px-5 @[64rem]/case:px-6`, `border-b border-border/70`.

**Row 1, 44 px** (`flex h-11 items-center gap-3`):

| Slot | Content | Size and classes |
|---|---|---|
| Title | the case title, one line, full text in `title` and the accessible name | `min-w-0 flex-1 truncate text-lg font-semibold @[56rem]/case:text-xl` (16 px, 18 px from a 56rem pane) |
| Primary action | the existing plan (`actionPlanForStatus`, Start review on a pending sample) | `Button size="sm" h-8` |
| Take action | unchanged menu | `h-8` outline |
| Ask AI | opens the inspector in Ask AI mode (phase 2, section 5.6); before phase 2 it switches to the Chat tab | `Button variant="ghost" h-8 px-2`, `Bot` icon, label from `@[56rem]/case` |
| More options | unchanged | `h-8 w-8` |
| Inspector toggle | replaces "Details": toggles the inspector column when it fits, otherwise opens it as the non-modal sheet; `aria-pressed` reflects the column state | `h-8 w-8`, `PanelRight` icon, shortcut `]` |
| Back to queue | unchanged, embedded only | `h-8 w-8` |

Below a 40rem pane (phone and narrow tablet) the actions collapse to: primary action as an icon button with a
tooltip, Take action, and More options; the title keeps the full remaining width and never wraps.

**Row 2, meta strip, 24 px** (`flex h-6 min-w-0 items-center gap-x-2.5 overflow-hidden text-xs
text-muted-foreground`, never wraps). Items in priority order; lower priority items hide first by container
query:

| # | Item | Display | Hover (300 ms) | Click or Enter |
|---|---|---|---|---|
| 1 | Case number | `font-mono text-foreground/80`, copy button appears on hover or focus (`opacity-0 group-hover:opacity-100 focus-visible:opacity-100`) | none | copies (existing `CopyId`) |
| 2 | Severity | existing `SeverityBadge` `h-5` | provenance: "Reported by the source" or "Derived from risk 62 (High from 48)" | none |
| 3 | Status or outcome | status glyph and words while open; `OutcomeBadge` once ended | open: "Since 18m ago, acknowledged by Admin"; ended: who classified, when | none |
| 4 | Risk | new chip "Risk 62" coloured by `scoreBand`, `tabular-nums` | short reason: the top two factors by contribution ("Mostly reputation 80 and volume 64") | opens the risk popover (5.7) |
| 5 | AI verdict | `AiVerdictChip`, label shortened to "AI: Needs human · 55%" (below 48rem: glyph and percentage only) | "55% confidence. The false positive auto-close bar is 90%." | opens the decision popover (5.7) |
| 6 | Owner | monogram and name (name hides below 44rem) | none | owner popover (existing, shortcut M) |
| 7 | SLA (open cases) | "P3 · due in 2h", tone by state | "Opened 18m ago (UTC time). SLA for P3: respond within 4h" | none |
| 8 | Review sample (agent-closed, pending) | chip "Review waiting", `bg-primary/10 text-primary` | the `REVIEW_BAND_TEXT` sentence | same as Start review |

"Opened 18m ago" leaves the meta strip (it is on the SLA hover and in the inspector's Times). The 46 px
`ReviewBand` leaves the header; its sentence moves to the chip hover and to the first block of the Brief tab
(5.5.1), so the header height is the same for every case.

**Live AI strip** (only while the AI works, section 5.4): 28 px, between the meta strip and the tabs.

**Tabs, 36 px**: `TabsList variant="underline" className="mt-1.5"` with a new `density="compact"` option in
`webui/src/ui/tabs.tsx` that sets the underline trigger to `h-9` (today `h-10`). Labels `text-sm` (13 px).
Counts stay as quiet suffixes (`TabCount`).

**Header height**: 8 + 44 + 24 + 6 + 36 = 118 px (today 150 px, 196 px with the review band). First content
at y = 72 + 118 + 16 = 206.

**Condense on scroll**: when the tab body scroll container's `scrollTop > 24`, the meta strip collapses
(`grid-rows-[0fr]` transition 150 ms, `motion-reduce:transition-none`) and the title row keeps the risk chip
and the status inline after the title (so the two facts an analyst needs while reading stay visible). Header
becomes 94 px, first content line at y = 182. Drive it from the tab body's existing scroll handler
(`onPanelScroll`, `CaseDetail.tsx:1770`, on the `case-detail-scroll` container) by writing
`data-condensed="true"` on the header element, so no re-render happens per scroll event (the technique
`useScrollEdge` in `design-system/material.tsx` uses for its fade; that hook measures document-sticky bars
and does not fit this inner scroller). Scrolling back to the top restores the strip. The strip never
collapses while focus is inside it.

### 5.4 Showing the AI's work (the operator's "notification while AI investigates")

**Where**: case header live strip, queue row glyph, and (for the global notification) the separate
notifications research.

**Live strip** (`casedetail/AgentWorkingStrip.tsx`, new, about 120 lines):

* Layout: `flex h-7 items-center gap-2 rounded-md border border-primary/20 bg-primary/[0.06] px-2.5 text-xs
  text-foreground dark:bg-primary/[0.1]`, `role="status"`, `aria-live="polite"`.
* Content: `LoaderCircle` 14 px spinning (`motion-reduce:animate-none`), "AI agent is working", a dot, the step
  in words, the elapsed time `m:ss` (tabular), and a "Watch" link that opens the AI investigation tab's live
  trace section.
* Step words from `agent.step` `step` values (fixed vocabulary, never the frame's free text, #9):
  `router` "Triage started", `persona` "Specialist chosen", `tools` "Querying logs and enrichment",
  `verdict` "Verdict reached, the code is deciding", `decision` (terminal) "Finished: <status words>".
  Show "Step k of 5".
* On the terminal `decision` frame: the strip turns to a success tint for 6 s ("Investigation finished.
  Routed to a person." or "Closed by policy."), the case, rationale, timeline and stages reload (the existing
  `loadCase`, `loadRationale`, `loadTimeline`, `loadStages`), then the strip collapses. Announce once.
* Throttle announcements to one per step change and at most one per 10 s.
* Failure: if a re-investigation request fails, the strip shows the existing `reinvestigateErrorText` in
  `text-critical-text` with Retry.

**Data**:

* Re-investigate (client knows the start): on submit, close the dialog immediately, keep the request promise,
  show the strip from the moment of submit, and apply the result with `commitCase` only if
  `activeIdRef.current` still names that case (otherwise just refresh the queue row). File:
  `CaseDetail.tsx` `runReinvestigate` (1579-1597) and the dialog (about 2580-2610).
* Frames: reuse a per-case subscription to `cases:{id}` for `agent.step`. Do **not** add a seventh
  `EventSource` (defect D6). Recommended prerequisite: make `useEventStream` share one `EventSource` per
  page with a reference-counted topic set (a module-level multiplexer in `webui/src/lib/useEventStream.ts`
  that reopens the single source when the topic union changes and fans frames out by topic). If that is too
  large for the round, add `cases:{openCaseId}` to the topics of the existing CaseManager subscription
  (`CaseManager.tsx:1421`) and pass frames down as a prop.
* Queue glyph and first investigations of cases that already exist: add a tiny additive nudge on the shared
  `cases` topic from `_emit_step` for the `router` (state `running`) and `decision` (state `done`) steps only:
  `{"case_id": id, "investigation": "running" | "done"}` on a new channel `case.investigation`
  (`backend/app/realtime.py` registry plus `STREAM_CHANNELS` in the client, which a test already keeps in
  sync). Best effort, after the same try/except, never read by `decide()` (#3), no free text (#9).
* A brand-new case does not exist in the queue until it is saved, so the "how many investigations are
  running" count belongs to the global notification work (a server-side in-flight count), not to this pane.

**Wording**: always "AI agent is working" for the live state. Never reuse "Investigating", which is the
human-acknowledged lifecycle status.

### 5.5 Tabs: one lane each

Tab registry: `webui/src/soc/case-tabs.ts`. Keep the ids that links already use and relabel:

| Order | id | Label | Alt | Lane | Holds |
|---|---|---|---|---|---|
| 1 | `overview` | Brief | Alt+1 | all four, summarised | Next step, the four lanes, how the case was built |
| 2 | `evidence` (new) | Evidence | Alt+2 | source | What happened, events, entities, threat context, related cases, baseline |
| 3 | `investigation` | AI investigation | Alt+3 | ai | Assessment, findings, reproduce queries, inputs, trace, gradings |
| 4 | `runbook` | Response | Alt+4 | analyst | Runbook (phases and steps) and Tasks |
| 5 | `collab` | Activity | Alt+5 | analyst | Discussion, Files, History |

Chat: phase 1 keeps it as a sixth tab `chat` ("Chat", Alt+6); phase 2 moves it into the inspector (5.6) and
`chat` becomes a legacy id that opens the inspector in Ask AI mode.

`LEGACY_CASE_TABS` and `CASE_SECTIONS` (`CaseDetail.tsx:314`):

| Link | Opens |
|---|---|
| `tab=timeline` | `evidence`, section `what-happened` |
| `tab=threat` | `evidence`, section `threat-context` |
| `tab=investigation&section=threat-context` | `evidence`, section `threat-context` (rewrite in the router) |
| `section=related-cases` | `evidence`, section `related-cases` |
| `tab=investigation` (audit log "Open case trace", `AuditInspector.tsx:601`, `AuditTable.tsx:144`) | unchanged |
| `tab=chat` (phase 2) | `overview` plus the inspector in Ask AI mode |

The Response tab is shown to everyone (Tasks always; the Runbook section only with `runbooks:read`), so the
tab set no longer depends on a grant and Alt+N always means the same tab.

All tab bodies keep the flat grammar (sections divided by one hairline, `PanelSection`, no cards) and use one
padding constant changed to container queries:

```ts
// casedetail/shared.tsx
export const CASE_MANAGER_PANEL_PADDING = 'px-4 pt-4 pb-6 @[48rem]/case:px-5 @[64rem]/case:px-6';
```

Section rhythm: `space-y-6` between sections (24 px), `PanelSection` `pt-6` after the hairline. Reading
measure: prose blocks `max-w-[42rem]` (the 42rem chat reading column already in use), tables and timelines
full width.

#### 5.5.1 Brief (`overview`)

File: `casedetail/OverviewPanel.tsx` (rename the component `BriefPanel`, keep the file or re-export).

Order:

1. **Review note** (pending auto-close sample only): one line, `text-sm`, `ClipboardCheck` glyph, the
   `REVIEW_BAND_TEXT` sentence. No border (the header chip and Start review carry the action).
2. **Next step** (open case with a run): a single 48 px row instead of today's 190 px card:
   `flex min-h-12 items-center gap-3 rounded-md border border-border/70 px-3`,
   "Next step" (`text-xs font-medium text-primary`), step title (`text-sm font-medium truncate`),
   "Investigate · step 3 of 9 · Lookup · Required" (`text-xs text-muted-foreground`, hidden below 48rem),
   `Button size="sm" variant="secondary"` "Open". The full card stays on the Response tab
   (`NextStepCard.tsx`).
3. **The four lanes**: one `dl`, `grid grid-cols-[minmax(0,1fr)] @[40rem]/case:grid-cols-[8rem_minmax(0,1fr)]
   gap-x-5`, each lane a row `border-t border-border/60 py-3.5 first:border-t-0`:

   | Lane (dt) | Content (dd) | Link |
   |---|---|---|
   | `ProvenanceTag kind="source"` "Evidence" | The trigger sentence (`triggerSentence`, plain text) and one quiet line: "3 events · user:pnair · first 04:21 UTC · last 04:23 UTC · Splunk ES (HEC)" | "Open evidence" (Alt+2) |
   | `ProvenanceTag kind="ai"` "AI" | Verdict and confidence in words ("Needs human review, 55% confident"), the summary lead (at most 3 sentences, `leadSentences`), then "Recommended: …" while open. A case the AI did not assess says why in words ("Not sent to the AI: risk 42 is below the auto-investigate floor of 70", from the routing reason when recorded) | "Open AI investigation" (Alt+3) |
   | `ProvenanceTag kind="code"` "Decision" | The decision line ("Routed to a person: no confident close decision, fail-safe") and one line with the numbers it compared ("Confidence 55% is below the 90% bar for a false positive auto-close"), then two disclosures: "Policy inputs" (the existing `DecisionCard`) and "Automation applied (1)" (the existing `AutomationApplied`, humanised, D1). The lock sentence "Made by code against the auto-close policy, never by the model" stays, once | "Why?" opens the decision popover |
   | `ProvenanceTag kind="analyst"` "People" | Owner, status, runbook progress ("2 of 9 steps, 7 required open"), discussion count, file count, the last human action ("Acknowledged by Admin 12m ago") | "Open response" (Alt+4), "Open activity" (Alt+5) |

4. **How this case was built** (collapsed `Collapsible`, `text-xs font-medium text-muted-foreground`
   trigger): the existing six-stage `StageTimeline`, each stage tagged with its lane (input source, correlate
   code, risk code, triage ai, investigate ai, decide code). This is the audit narrative across lanes; it is
   the one place where the lanes meet, and it is folded.

Removed from the Brief: Key entities, Related cases, Baseline (to Evidence); the full Next step card (to
Response); the "What happened" heading (to Evidence).

Height target: about 380 px at a 780 px pane, so the whole Brief fits above the fold at 1440x900.

#### 5.5.2 Evidence (`evidence`, new)

New file `casedetail/EvidencePanel.tsx` composed from existing pieces:

1. **What happened** (`section="what-happened"`): "Why it fired" sentence, then the input-stage evidence
   blocks (the untrusted fenced `CodeBlock`s that today sit in the six-stage story's input step) and the
   member events list when present. Untrusted values stay in `CodeBlock` with the untrusted label (#9).
2. **Entities**: today's Key entities (primary entity, scope, type, Copy, Ask AI, enrichment grid).
3. **Threat context** (`section="threat-context"`): `ThreatContextPanel` unchanged (MITRE, indicator
   reputation, clustering diagram, asset context).
4. **Related cases** (`section="related-cases"`): today's `RelatedCases`.
5. **Baseline**: today's `BaselineAdvisory`.

Loads: stages and threat context load when Evidence opens (today they load with Overview and Investigation).
The Brief needs `triggerSentence` and counts only, which are on the case document.

#### 5.5.3 AI investigation (`investigation`)

File: `casedetail/InvestigationPanel.tsx`.

1. **Assessment** (`ProvenanceTag ai`): reasoning, Found and Ruled out, reproduce query, "Show full assessment
   evidence" (`WhyPanel`).
2. **What the AI consulted**: `InvestigationInputs` (memory, RAG knowledge, runbook passages, the Published
   runbook given to it, the threshold-tuning snapshot).
3. **Trace** (`section="trace"`): `TraceTimeline`, expanded while an investigation runs (the live strip's
   Watch link lands here), collapsed otherwise, with its step and tool counts.
4. **Previous gradings**.

Moved out: Decision and Automation applied (to the Brief's Decision lane), Threat context (to Evidence). The
tab name says AI, so nothing on it is code or source. Add one muted line at the top: "Advisory. The case
route is decided by code; see the Decision on the Brief."

#### 5.5.4 Response (`runbook`)

File: `casedetail/RunbookPanel.tsx` (already renders the run, steps, approvals, lookups and Other tasks).

* For a viewer without `runbooks:read`, render only the Tasks section (today `OtherTasksLoader` inside
  Collaboration).
* Empty state when no runbook is attached (`state="no-data"`): "No runbook applies to this case." plus the
  match reason from the existing match preview ("No Published runbook's Applies when matched rule
  LP-ES-RISK-1004 on a user entity") and "Start a runbook" for `runbooks:run`.

#### 5.5.5 Activity (`collab`)

File: `casedetail/CollaborationPanel.tsx`.

* Main column: Discussion, Files. Side column from a 52rem pane: History, with the full activity feed
  disclosure.
* Remove the Tasks pointer section (D5).
* Keep `section="files"` for links.

### 5.6 The inspector column (facts rail today)

Files: `CaseDetail.tsx` (rail column at 2489-2502, sheet at 2507-2552), `casedetail/FactsRail.tsx`,
`casedetail/SignalProfile.tsx`.

**When it shows as a column**: from a 52rem (832 px) pane (today 60rem), width `w-[17rem]` (272 px) up to a
72rem pane, `@[72rem]/case:w-[19rem]` (304 px) above. Change `responsiveQueueWidth` to clamp 340..520 (today
360..520) so the pane reaches 52rem more often. Result: at 1440 px with the navigation collapsed the rail shows
(pane about 946 px, main column about 674 px); with the navigation expanded at 1440 px it is one `]` away; at
1536 px and wider it shows with the navigation expanded. Below 52rem the same component opens in the existing
non-modal Sheet (`modal={false}`).

**Toggle**: `]` and the header's inspector button. Persist the column's open state per viewer
(`soc.caseManager.inspector`, try/catch). Closing it gives the width back to the tab body.

**Sticky**: the column scrolls on its own (`overflow-y-auto`), independent of the tab body (as GitHub's
sticky sidebar).

**Sections** (from eight to six; each a collapsible group whose open state persists per viewer, as Tines
does; headings `text-xs font-semibold text-muted-foreground` sentence case; rows `Fact` label `text-xs
text-muted-foreground`, value `text-sm text-foreground`; section padding `py-3`; hairline between):

1. **Outcome** (open): headline, who classified and when, the AI line (verdict, confidence, the auto-close bar
   while open), Decided by, objection window, review state.
2. **Signal** (open): Risk meter (click: risk popover), Severity with provenance, then one compact line
   "Priority P3 · Impact Medium · Urgency High" (each word hover: what it means and the matrix cell that
   produced it), SLA (moved here from Times).
3. **Times** (open): Detected, Opened, Acknowledged, Closed, Updated (relative; exact UTC on hover).
4. **Source and entity** (open): Source, Detected by, rules (`RuleLink`), primary entity (copy, Ask AI),
   related cases count as a link to Evidence.
5. **Tags and campaign** (open): the tag editor (T), the campaign chip.
6. **Record** (collapsed by default): case number with Ask AI, Demo mark, cost (`cost:view`), creation
   build, profile, investigator runbook, classification history, AI verdict history, notifications.

Removed from the rail: the Runbook phases section (home: the Response tab; the Brief's People lane carries
the progress) and the Related cases section (a link in Source and entity).

**Phase 2, Ask AI mode**: the column header gets a two-option `SegmentedControl` "Facts | Ask AI". In Ask AI
mode the column widens to `w-[24rem]` (384 px), resizable 320..512 px with the same separator idiom (9 px
handle, arrow keys, Shift for larger steps, Home and End, double-click resets, width persisted per viewer),
and renders the existing case chat (`CaseChat`, compact presentation, one engine #5). The tab body keeps the
evidence on screen. Below 52rem it is the Sheet at `w-[min(92vw,32rem)]`. `Alt+6` toggles it. The Chat tab
is removed in the same change; `tab=chat` links open this mode.

### 5.7 Hover and click explainers ("every number explainable")

New shared module `webui/src/soc/components/explain/` (lazy, inside the CaseDetail chunk; never in the
entry chunk):

**Risk popover** (`RiskExplain.tsx`), anchored on: the header Risk chip, the inspector meter, the queue row
hover card's "Open the full calculation", the Brief's Evidence lane if it shows risk, and the "Risk assigned"
stage. Content, `PopoverContent className="w-[26rem] p-4"`:

1. Title "How risk 62 was calculated" (or "Risk 62: details" when the arithmetic does not match).
2. The factor table from `RiskDerivation` (extract it from `StageTimeline.tsx` into this module and import it
   back there, so there is one renderer): Factor, Value /100, Weight (share %), Contribution (points), each
   factor name with the existing definition and case reason tooltips (`RISK_FACTOR_META`,
   `riskFactorCaseReason`).
3. The formula line in `font-mono text-xs`: `Σ(value × weight) = 15.5 + 9.2 + 24.0 + 9.0 + 4.3 = 62.0;
   62.0 ÷ 1.00 = 62.0 → 62/100`.
4. The weight basis: "Weights recorded when the case was scored" (new cases, see the backend change below)
   or "Today's weights; this case predates weight recording" (legacy), and the existing honest mismatch note
   when they disagree.
5. Footer: "Risk is computed by code (`compute_risk`) and is an input to the decision. It never changes after
   scoring." and a link "Risk weights in Settings" for `settings:read`.

Data: the popover fetches `GET /api/cases/{id}/stages` once per case on first open (cached for the open case;
today Overview already fetches it, so in practice it is warm) and reads `stage.state.risk_calculation` of the
risk stage. No new endpoint.

Backend (additive, small): snapshot the weights used at scoring time. In the pipeline, after
`compute_risk(...)` returns (do not edit `engine/risk.py`), set
`breakdown = breakdown.model_copy(update={"weights": prefs.risk_weights.model_dump()})` where
`RiskBreakdown` gains `weights: dict[str, float] | None = None` (`models.py:282`). The case index maps
`risk_breakdown` as an enabled object (`es/indices.py:81`) and `CASES_MAPPING` sets no `dynamic` override, so
Elasticsearch maps the new sub-fields dynamically; SQL stores JSON, so no migration. `routes_triage.py`'s stage builder uses the snapshot when present and sets
`weight_basis: "recorded_at_scoring"`. Legacy cases are not backfilled (the record provenance rule). `decide()`
reads only `risk_score`, so #3 is untouched.

**Decision popover** (`DecisionExplain.tsx`), anchored on the AI verdict chip and the Brief's "Why?":

* "The decision is made by code against the auto-close policy, never by the model."
* A three-row comparison table: Verdict (Needs human review), Confidence 55% vs the bar for this verdict
  (90%), Risk 62 vs the maximum risk for auto-close (from the policy clause), each row ending in "passes" or
  "does not pass".
* Result: "Routed to a person" and the clause from the terminal decision span (`decisionPayload()` in
  `TraceTimeline`), as `DecisionCard` already reads it. NEEDS_HUMAN shows "Needs human never closes
  automatically (fixed by code, not a policy setting)".
* For an analyst close: "Closed by Admin 2h ago as False positive; the AI said False positive 87%: agrees".

**Small explainers** (HoverCard on desktop, Popover on click or Enter for keyboard and touch; 300 ms open
delay, `max-w-xs`, `text-xs`):

| Target | Says |
|---|---|
| Severity | "Reported by the source (Splunk ES: high)" or "Derived from risk 62: High is 48 to 73" |
| Priority, Impact, Urgency | the matrix inputs that produced P3, from the triage chips |
| SLA | the policy row ("P3: respond within 4h"), opened time in UTC and local |
| Confidence | the calibration line from `confidenceCalibration()` |
| Times | exact UTC and the viewer's local time |
| Tab counts | "10 trace steps", "2 of 9 runbook steps done, 7 required open" |
| Queue "1 of 15 active" | "Position 1 of 15 active cases on the server, 15 loaded" |

Security: every explainer renders numbers and fixed copy; any case-derived string (entity, rule, source name)
is a plain text node (#9). No explainer calls a model (#6) or reads logs (#7).

### 5.8 Density, spacing and typography (one table)

| Element | Today | Proposed |
|---|---|---|
| Route top inset | 24 px + 40 px header + 24 px gap | 16 px, no header |
| Queue band | 98 px | 92 px, Live and Refresh moved in |
| Queue row | 64 px, checkbox column always | 64 px, severity glyph that becomes the checkbox on hover, focus, selection, touch |
| Detail header | 150 px (196 px with review band) | 118 px for every case, 94 px condensed |
| Case title | `text-lg` 16 px in a 32 px line, `text-xl` from 56rem | `text-lg` in a 44 px row, `text-xl` from 56rem |
| Meta | `text-xs`, wraps | `text-xs`, one 24 px line, priority hiding |
| Tabs | 40 px | 36 px (`density="compact"`) |
| Tab body padding | viewport `px-4 sm:px-5 lg:px-6`, `py-4 sm:py-5` | container `px-4 @[48rem]:px-5 @[64rem]:px-6`, `pt-4 pb-6` |
| Section heading | `text-base` semibold | unchanged |
| Body prose | `text-sm` 13 px | `text-base` 14 px for AI summary and decision lines (reading), `text-sm` elsewhere |
| Rail | 304 px from 60rem, 8 sections, `text-sm` headings | 272 to 304 px from 52rem, 6 collapsible sections, `text-xs` muted headings |
| Lane label column (Brief) | n/a | 8rem (128 px) from a 40rem pane, stacked below |

Spacing stays on the 4 px grid; no arbitrary text sizes (the design gate forbids new ones); colours only from
tokens.

### 5.9 Empty, loading and error states

| Surface | State | Copy and action |
|---|---|---|
| Detail pane, nothing open | `no-data` (selection) | Title "No case open". Description "Pick a case from the queue, or press J to open the first one." Below, three quiet buttons that apply a queue filter: "4 critical or high unassigned", "3 waiting for review", "2 breaching SLA" (counts from the existing queue summary and review summary; omit a button whose count is unknown). |
| Brief, AI lane, not assessed | `unavailable` | "The AI did not assess this case." plus the recorded reason in words (below the routing floor, budget block, kill switch, error), never a guess. |
| Brief, Decision lane, open and undecided | `no-data` | "No decision yet. The code decides after the AI's verdict." |
| Evidence, stages failed | `error` | existing `LoadError` with Retry, keep stale content |
| Response, no runbook | `no-data` | see 5.5.4 |
| Activity, no discussion | `first-use` | "No discussion yet. Notes here are shared with the team and kept with the case." Composer focused on click. |
| Inspector, Record section | n/a | fields an older case lacks are left out, not shown empty (the audit inspector rule) |
| Live strip, stream not live | n/a | when realtime is off (`live: false`) the strip appears only for a re-investigation this viewer started (client-known) and polls the case every 5 s until it changes; it never claims a step it did not see |
| Loading | all | keep the existing geometry-stable `LoadingState` shapes; the header keeps its 118 px while the case loads (skeleton title 16 px x 18rem, meta 12 px x 24rem) |

### 5.10 Keyboard model

Existing keys are kept with the same meaning (J, K, arrows, Home, End, X, Space, Shift extend, Enter, Esc,
`/`, `?`, A, C, E, H, R, M, T, Alt+1..5) except as marked.

| Key | Action | Note |
|---|---|---|
| Alt+1..5 | Brief, Evidence, AI investigation, Response, Activity | Alt+2 changes from Runbook to Evidence and Alt+4 from Collaboration to Response; say so in the What's new entry |
| Alt+6 | Chat tab (phase 1); toggle Ask AI in the inspector (phase 2) | today Alt+5 |
| `[` | collapse or expand the queue (focus mode) | Linear uses `[` for its sidebar |
| `]` | show or hide the inspector | Tines uses Ctrl+] for its sidebar |
| `I` | open the risk popover for the open case | `aria-keyshortcuts="I"` on the Risk chip |
| `W` | jump to the live trace when the AI is working | only while the strip is shown |
| Esc | closes an open explainer and returns focus to its trigger | Radix default plus explicit `onCloseAutoFocus` like the existing sheets |

All single-letter keys keep using `shortcutBlocked()` (`casedetail/keyboard.ts`). `caseManagerShortcuts()`
(`CaseManager.tsx:597`) lists only keys the viewer can use; add the new rows there so `?` stays truthful.
Explainer triggers are real buttons (Enter and Space open them); hover cards are mouse-only enhancements with a
keyboard path through the same button.

### 5.11 Narrow panes and phone

* Below the `xl` split (today 1280 px), the queue and the case are separate screens (unchanged). The case
  screen drops the separate 40 px "Cases" back bar: the back button moves into header row 1 as the first item
  (`ChevronLeft`, `h-8 w-8`), and the display id moves to the meta strip (it is already there).
* Phone (390 px): row 1 = back, title, primary action as icon, More; meta strip one line, horizontally
  scrollable with a right fade (`mask-image` gradient token), `overflow-x-auto` and `scrollbar-none`; tabs
  scroll horizontally (already). First content at about y = 56 + 8 + 44 + 24 + 6 + 36 + 16 = 190 (today 449).

### 5.12 Compatibility and contracts

* Deep links: section 5.5 mapping; `isCaseTab` accepts `evidence`; old ids rewrite.
* No API path changes. One additive model field (`RiskBreakdown.weights`), one additive SSE channel
  (`case.investigation`), both optional to consumers.
* `decide()` and `engine/risk.py` untouched. No new model call. No new index or table. No new npm dependency.
* `docs/development/ui-standard.md` sections "Queue and detail workspaces", "Case header", "Case tab bodies"
  must be rewritten in the same change; the Help Center Case Manager page and its screenshots too.

---

## 6. Before and after

| Area | Before | After |
|---|---|---|
| First content line at 1440x900 | y = 324 (374 on review cases) | y = 206 for every case, 182 condensed |
| Phone first content | y = 449 of 844 | about y = 190 |
| Page title band | "Case Manager" h1 + help + Live + Refresh (64 px with gap) | sr-only h1; Live, Refresh, About in the queue band |
| Header rows | title, wrapping meta (2 lines), optional 46 px review band, tabs | title row, one meta line, tabs; review is a chip |
| Risk in header | absent | "Risk 62" chip, hover reason, click for full arithmetic |
| Risk arithmetic | Overview, What happened, expand "Risk assigned" | one click from every risk number; weights recorded at scoring for new cases |
| AI confidence | chip with percentage only | hover: against the auto-close bar; click: full decision comparison |
| AI working | invisible unless Collaboration, History, Show all activity is open; re-investigate blocks in a modal | live strip in the header, glyph on the queue row, dialog closes at once |
| Overview | runbook card, AI summary, what happened, entities, related, baseline | Brief: next step row, four labelled lanes (Evidence, AI, Decision, People), folded build story |
| Investigation | AI assessment + code decision + threat context + inputs + trace + gradings | AI investigation: AI only; decision on the Brief; threat context on Evidence |
| Evidence | spread across Overview and Investigation | its own tab |
| Runbook tab | only with `runbooks:read`; tasks elsewhere | Response tab always: runbook (when readable) and tasks |
| Collaboration | discussion, files, a tasks pointer, history | Activity: discussion, files, history |
| Chat | a tab that hides the evidence | phase 1 sixth tab; phase 2 Ask AI beside the evidence in the inspector |
| Facts rail | from a 960 px pane, never at 1440, 8 sections | from an 832 px pane, `]` toggle, 6 collapsible persisted sections |
| Queue rows | checkbox column always, two orange tokens per high row | severity glyph turns into a checkbox on hover or selection, one coloured token |
| Queue width | fixed split only | focus mode `[` collapses it to a 44 px strip |
| Empty pane | "Select a case" | "No case open" with three filter shortcuts and the J hint |
| Automation applied | raw `proposal=… kind=…` and a repeated id | "Approval requested: acknowledge (automation)", rule name, "Open in Approvals" |
| Padding breakpoints | viewport (`sm:`, `lg:`) | container (`@[48rem]/case`, `@[64rem]/case`) |

---

## 7. Recommendations (work packages)

Each item: what to build and where, effort (S, M, L), value, risks, how to test.

### R1. Reclaim the top (page frame and compact header) - effort M, value high, this round

* Build: sections 5.1 and 5.3 (without the explainers and the live strip): drop the routed `PageHeader` in
  `CaseManager.tsx`, sr-only h1, Live and Refresh into the queue band, `-my-2` and
  `h-[calc(100dvh-5.5rem)]`; header row 1 `h-11`, meta strip one line with priority hiding, review band to a
  chip plus a Brief note, compact tabs (`density="compact"` in `ui/tabs.tsx`), container-query padding
  (`shared.tsx:44`, `CaseDetail.tsx:1914`), condense on scroll from `onPanelScroll`.
* Risks: the console grammar guard and `route-visual-standard.test.ts` assert the current strings; the
  header keyboard and focus tests (`CaseDetail.header-actions.test.tsx`, `CaseDetail.header-bands.test.tsx`,
  `CaseDetail.focus-return.test.tsx`) depend on `case-review-band` and the Details button; the condensed
  header must not move focus or steal clicks mid-scroll.
* Test: update those tests; add a jsdom test that the meta strip has `flex-nowrap` and that low-priority items
  carry their container-query hide classes; a Playwright or puppeteer screenshot script (the Round 15 shot
  script pattern, `scratchpad/wp5_shots.cjs`) that asserts at 1440x900: the first `[data-case-panel] h2` top
  is at most 210 px, the header (`case-detail-header`) height is at most 120 px for a normal case and for a
  pending review case, and at 390x844 the first panel heading top is at most 200 px; light and dark
  screenshots for the docs.

### R2. Every number explainable (risk, decision, confidence, SLA, severity) - effort M, value high, this round

* Build: section 5.7. Extract `RiskDerivation` from `StageTimeline.tsx` into
  `components/explain/RiskExplain.tsx`; add the header Risk chip, the inspector meter trigger, the queue row
  hover card; `DecisionExplain.tsx` on the AI verdict chip and the Brief; the small HoverCards. Backend:
  `RiskBreakdown.weights` snapshot in the pipeline and `weight_basis: "recorded_at_scoring"` in the stages
  builder (`routes_triage.py`).
* Risks: the popover must not claim exactness for legacy cases (keep the mismatch note); HoverCard inside the
  row button must not become focusable; the stages request must stay single-flight per case; `models.py`
  change needs `webui/src/lib/types.ts` and `check:types` regeneration.
* Test: Vitest for the popover with (a) a snapshot-weight case whose sum equals the score, (b) a legacy case
  with today's weights that disagree (mismatch note shown, recorded score not rewritten), (c) a case with no
  breakdown ("No risk factors recorded"); keyboard: Enter on the chip opens, Esc returns focus; pytest that a
  new case carries `risk_breakdown.weights` equal to the preferences at scoring time, that changing weights
  afterwards leaves it unchanged, that `compute_risk` output and `decide()` are byte-identical (the existing
  decide parity test), and that the stages response uses the snapshot.

### R3. Show the AI working on the open case - effort M, value high, this round

* Build: section 5.4. `AgentWorkingStrip.tsx`, non-blocking re-investigate, queue row glyph, the
  `case.investigation` nudge on the `cases` topic from `_emit_step` for `router` and `decision` only.
  Prerequisite: share one `EventSource` per page in `useEventStream.ts` (reference-counted topics), or at
  minimum reuse the CaseManager subscription for `cases:{openId}`.
* Risks: the six-connection cap without HTTP/2, shared by every tab of the Console (D6), so do not add a
  hook-level `EventSource`; a re-investigation
  result landing after the analyst moved to another case (guard with `activeIdRef`); announcing too often to
  screen readers.
* Test: Vitest with a mocked stream emitting `router`, `persona`, `tools`, `verdict`, `decision` frames:
  the strip shows "Step k of 5" in order, reloads the case on `decision`, collapses after 6 s, announces at
  most once per step; re-investigate closes the dialog immediately and keeps the case readable; pytest that
  `_emit_step` publishes `case.investigation` only for those two steps, swallows bus errors and carries no
  free text; a browser check counting open `EventSource`s on Case Manager with Activity open (target: one
  shared connection).

### R4. Segregated tabs: Brief, Evidence, AI investigation, Response, Activity - effort L, value high, this round (can ship after R1 to R3)

* Build: section 5.5. `case-tabs.ts` (add `evidence`, relabel), `LEGACY_CASE_TABS` and `CASE_SECTIONS`
  mapping, router rewrite for `investigation&section=threat-context`, new `EvidencePanel.tsx`, Brief lanes in
  `OverviewPanel.tsx`, move Decision and Automation applied out of `InvestigationPanel.tsx`, Response always
  present, Tasks pointer removed from `CollaborationPanel.tsx`, the Next step row, the folded six-stage story.
* Risks: Alt+2 and Alt+4 change meaning (muscle memory); many tests reference tab ids and section names
  (`CaseDetail.tabs.test.tsx`, `CaseDetail.requested-tab.test.tsx`, `router-case-tabs.round15.test.tsx`,
  `router-deep-links.round14.test.tsx`, `OverviewPanel.test.tsx`, `InvestigationPanel.test.tsx`,
  `case-visual-dialect.test.tsx`); the UI standard's G17 rule ("decision text only under Investigation's
  Decision") must be rewritten to "only under the Brief's Decision lane"; the Help Center pages and the app
  knowledge corpus (`build_app_knowledge --check`, `npm run gen:console-map`) must be regenerated.
* Test: update the tests above; add a test that no `ProvenanceTag kind="code"` renders inside the AI
  investigation tab and no `kind="ai"` inside Evidence (the segregation guard); deep-link tests for every
  legacy id; a Brief height check (fits above 900 px at a 780 px pane in the screenshot script).

### R5. The inspector column (facts rail at more widths, six sections, `]`) and queue focus mode (`[`) - effort M, value medium-high, this round

* Build: section 5.6 (phase 1 part) and the focus mode in 5.2. Threshold `@[52rem]`, widths 272 and 304 px,
  `responsiveQueueWidth` clamp 340..520, collapsible persisted sections, Runbook and Related sections removed
  from the rail, the queue strip.
* Risks: a 674 px main column at 1440 with the navigation collapsed is narrower than today's 780 px when the
  rail shows; tabs must stay readable at 520 px (container queries already stack the Activity side column);
  persisted state must be try/catch wrapped.
* Test: `FactsRail.test.tsx` for six sections and collapsed Record; a jsdom test for the `]` and `[` keys
  honouring `shortcutBlocked`; screenshot at 1440 (navigation collapsed) showing the rail; at 1366 showing the
  Sheet path.

### R6. Ask AI beside the evidence (chat into the inspector) - effort M to L, value medium, next round

* Build: section 5.6 phase 2: Facts or Ask AI mode, resizable 320..512 px, `Alt+6`, `tab=chat` legacy
  rewrite, Chat tab removed.
* Risks: chat blocks (tables, charts) in 384 px; `CaseChat.width.test.tsx` expectations; the case chat
  must remain case-scoped and outside Workspace history (#5).
* Test: width tests at 320, 384, 512 px; deep link `tab=chat`; focus returns to the toggle on close.

### R7. Queue row cleanup - effort S, value medium, this round

* Build: section 5.2 row: severity glyph slot that becomes the checkbox, risk number neutral, AI working
  glyph, "Open the full calculation" hover card, the No case open empty state with three filter shortcuts.
* Risks: discoverability of bulk selection (keep "Select visible" always visible in the band; keep the
  checkbox always on touch); the UI standard sentence "the Case Manager shows it always" must change.
* Test: `CaseManager.test.tsx` for the checkbox visible after one selection and under `pointer: coarse`
  (matchMedia mock), X still toggles a row whose checkbox is hidden; the empty state buttons apply the right
  filters.

### R8. Humanise automation records and tidy copy - effort S, value medium, this round

* Build: in `AutomationApplied.tsx`, parse `proposal=<id> kind=<k>` for `request_approval` into "Approval
  requested: <kind in words>" and render the proposal id once, as "Open in Approvals" (route
  `approvals` with the id when the viewer can read proposals); keep the raw detail one click away under
  "Details" (exact text, #2 and #9). Remove the Tasks pointer (D5).
* Test: `AutomationApplied.test.tsx` for the parsed form, an unparseable detail shown verbatim, and no
  duplicated id.

---

## 8. Risks across the whole redesign

* **Test and doc churn**: roughly 20 Case Manager and Case Detail test files assert structure, ids and test
  ids. Plan for a dedicated test pass per package, not a single big bang.
* **Muscle memory**: Alt+2 and Alt+4 change. Mitigation: the What's new entry for the release names it, and
  `?` lists the new map.
* **Grammar consistency**: removing the routed page header from one page is an exception to the Round 14
  console grammar. The Chat route is the precedent; write the exception into `ui-standard.md` ("workspace
  routes Chat and Case Manager own their frame and carry an sr-only h1").
* **Realtime connections**: see D6; fix before adding subscriptions.
* **Entry bundle**: all new UI is in the lazy CaseDetail chunk; `case-tabs.ts` is entry-safe and grows by a
  few bytes only. Re-run the entry budget test.

## 9. Non-negotiables check

* #3: presentation only around the decision; `decide()` and `engine/risk.py` untouched; the decision popover
  reads the recorded decision span. The weight snapshot is written after scoring and never read by `decide()`.
* #5: case chat stays the one engine, case-scoped, never in Workspace history.
* #6, #7: no model call added; explainers read stored numbers.
* #9: every case-derived value stays a plain text node or a fenced `CodeBlock`; SSE nudges carry ids and
  fixed enums only.
* #12: no new index, table or KV namespace; localStorage only for per-viewer conveniences.

## 10. Sources and what could not be verified

Sources (all accessed 2026-11-24):

* Microsoft Sentinel, investigate incidents: https://learn.microsoft.com/en-us/azure/sentinel/investigate-incidents
* Microsoft Defender XDR, investigate incidents (legacy): https://learn.microsoft.com/en-us/defender-xdr/investigate-incidents
* Microsoft Defender, incident cases: https://learn.microsoft.com/en-us/defender-xdr/investigate-incident-cases
* Microsoft Defender, prioritize incidents: https://learn.microsoft.com/defender-xdr/incident-queue
* Google SecOps, Cases page layout: https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/whats-on-the-cases-screen
* Google SecOps, case Overview tab: https://docs.cloud.google.com/chronicle/docs/soar/investigate/working-with-cases/whats-on-the-case-overview-tab
* Cortex XSOAR, War Room: https://cortex-docs.paloaltonetworks.com/cortex-xsoar-8-saas/investigate-and-respond-to-threats/incidents-and-indicators-investigation/investigate-an-incident/use-the-war-room-in-an-investigation
* Splunk Mission Control, response templates: https://help.splunk.com/en/splunk-enterprise-security-7/mission-control/investigate-and-respond-to-threats/respond-to-incidents/apply-response-templates-to-standardize-response-to-incidents-in-splunk-mission-control
* Tines, case sidebar: https://www.tines.com/llm/docs/cases/overview/sidebar.md
* Dropzone AI, investigation reviews: https://docs.dropzone.ai/best-practices/deep-dive-into-investigation-reviews
* Datadog, incident details page: https://docs.datadoghq.com/service_management/incident_management/incident_details/
* GitHub changelog, sticky issue sidebar: https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/
* Linear changelog, issue sidebar: https://linear.app/changelog/2026-07-23-agent-assisted-editing
* Linear changelog, UI refresh: https://linear.app/changelog/2026-03-12-ui-refresh
* incident.io changelog, AI in the dashboard: https://incident.io/changelog/ai-in-the-dashboard
* Zendesk, custom layouts: https://support.zendesk.com/hc/en-us/articles/5447837546138-Creating-custom-layouts-to-improve-agent-workflow
* Front, plugin SDK: https://dev.frontapp.com/plugin.html
* Cisco, progressive disclosure in security design: https://blogs.cisco.com/security/from-frustration-to-clarity-embracing-progressive-disclosure-in-security-design/
* "Too Much to Trust?" (arXiv 2503.02065v2): https://arxiv.org/html/2503.02065v2
* MDN, EventSource (the six-connection limit without HTTP/2): https://developer.mozilla.org/en-US/docs/Web/API/EventSource

Not verified:

* **Linear peek and `[` shortcut**: from search result summaries of https://linear.app/docs/peek and Linear's
  navigation guide; the docs page returned HTTP 404 to the fetcher.
* **incident.io incident page layout** (tabs, sidebar): not found in public docs beyond the summary
  changelog.
* **PagerDuty incident details page**: only the Timeline tab was confirmed
  (https://support.pagerduty.com/docs/navigating-the-incidents-page); no current layout description found.
* **Front and Zendesk specifics**: from search summaries of their help and developer pages; the pages were not
  fetched in full.
* **Six EventSources on one page (D6)**: derived from reading the code; count them in a real browser before
  acting.
* **Pixel figures**: measured from the Round 15 screenshots at device pixel ratio 2 (plus or minus 4 px) and
  from the Tailwind classes in the code.

---

## Journal entry (for the orchestrator)

```
### 2026-11-24 - research agent (case-manager-ux) - Case Manager redesign research
- Context: Round 16 discovery, operator asks for a cleaner, segregated Case Manager and less wasted space at
  the top of the detail pane.
- Did: read CaseManager.tsx, CaseDetail.tsx, casedetail/** and ui-standard.md; measured the Round 15
  screenshots (first content at y=324 of 900, 36% chrome; facts rail never shown at 1440 px); researched
  Sentinel, Defender XDR, Google SecOps, XSOAR, Splunk MC, Tines, Dropzone, Datadog, GitHub, Linear,
  incident.io, Zendesk, Front, Cisco XDR and the arXiv SOC explainability study; wrote a build-ready spec
  (frame, queue, two-row header, five lane tabs, inspector, explainers, live AI strip, keyboard, states).
- Tests: none run (read-only research).
- Status: done. Report: scratchpad/round16/research/case-manager-ux.md.
- Next: SPEC author picks R1 to R5, R7, R8 for Round 16; R6 (Ask AI in the inspector) next round; verify
  the EventSource count (D6) in a browser before R3.
```
