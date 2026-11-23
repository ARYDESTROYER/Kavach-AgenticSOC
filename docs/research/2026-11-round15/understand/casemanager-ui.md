# Round 15 understand map: the Case Manager UI

Reader scope: `webui/src/soc/pages/CaseManager.tsx`, everything it renders, the other case
view (`CaseDetail.tsx` as a Sheet), `casedetail/*`, the close/disposition dialogs, the thread
and tasks, the rules a redesign must follow, the tests that pin the current structure and the
docs that describe it. Branch `claude/round15` at `b49780c`. Read only; nothing edited.

---

## 0. The ten facts that matter most

1. **One orchestrator, two hosts.** `CaseDetail.tsx` (2,468 lines) is the whole case workspace.
   Case Manager mounts it `presentation="embedded"` (CaseManager.tsx:2514-2525); the Overview
   dashboard (Overview.tsx:5266) and Investigate (Investigate.tsx:720) mount it as a right-side
   Sheet (`presentation` default `'sheet'`). Campaigns/Cases do NOT mount it (Cases navigates to
   `case_manager` at Cases.tsx:1043). The doc comment at CaseDetail.tsx:28 ("Cases / Scans /
   Investigate use the default right-side sheet") is stale: Scans is gone, Cases navigates.
2. **The panels' `'default'` presentation is dead in production.** CaseDetail hard-codes
   `presentation="case-manager"` on every panel (OverviewPanel 2054, TimelinePanel 2125,
   InvestigationPanel 2144, ThreatContextPanel 2159, CollaborationThreadTab 2202, ChatTab 2212),
   even inside the Sheet. The `!isCaseManager` branches (OverviewPanel's chip row, DecisionCard on
   Overview, Entity relationship lane, run/cost meta; TimelinePanel's boxed variant; WhyPanel
   standalone; InvestigationPanel's non-CM layout; ThreatContext's PanelCard layout; Collaboration
   non-CM) only run in tests. A redesign can delete them, but tests render both presentations
   (e.g. case-visual-dialect.test.tsx:67-90 loops `['default','case-manager']`).
3. **There is no footer any more.** CaseDetail.tsx:17-18 and shared.tsx's comments describe "a
   footer with ONE primary CTA"; the actions now live in the sticky header (1659-1934). The test
   file is still called `CaseDetail.footer.test.tsx`.
4. **Facts are repeated, despite the docs claiming "each fact has one home"**
   (docs/analyst/case-manager.md:157). Owner is editable in THREE places (header meta popover,
   facts rail Ownership, Collaboration tab Ownership); severity, risk, confidence, outcome, AI
   verdict, SLA, tags and primary entity each appear 2-5 times (see §6).
5. **Close dialog asks "what was it" three times**: Disposition (6 radio cards, required),
   Resolution (optional select whose options include Benign and Duplicate again), and the grading
   "What actually happened?" select (TP/FP/TN/FN). Plus tags, note, AI grade badge, "What did the
   AI miss?", 15 star buttons. ~28 controls (§4.1).
6. **No attachments or screenshots anywhere in a case.** `CaseMessage` (backend/app/models.py:1190-1210)
   is text-only (`body`, `mentions`, `reactions`, `ai_meta`); CaseThread.tsx has no file/paste/drop
   handling. The nearest precedent is runbook step evidence `note_or_attachment`, which is really
   "A note or a link" (runbooks/shared/labels.ts:258) and the user avatar upload
   (`PUT /api/me/avatar`, routes.py:4763, `validate_avatar`).
7. **Auto-closed review hooks already exist**: the queue's `closedBy` filter
   (`#/case_manager?closedBy=agent`, CaseManager.tsx:633-659, chip "Closed by the AI agent"),
   `isAutoClosedByAI` (badges.tsx:635), the FP objection window `objection_window_expires_at`
   (FactsRail.tsx:265-270, OverviewPanel CM "Code decided" lane), `Set disposition` on a terminal
   case (shared.tsx action plans), and the separate grading POST `api.caseFeedback`
   (`POST /api/cases/{id}/feedback`, routes.py:7543) that never touches `decide()`.
8. **Entry budget has 77 B of room.** Round 14 recorded entry 337,163 B vs
   `PRE_REVAMP_ENTRY_BYTES` 336,216 + `REVAMP_ENTRY_BUDGET_BYTES` 1,024
   (bundle-first-paint.test.ts:158-159, 233, 243). Case Manager itself is a lazy chunk
   (registry.tsx:586), but `soc/case-tabs.ts` (the tab tuple) and the registry/router entries are
   in the entry chunk; changing the tab set changes entry bytes.
9. **Every file under `soc/pages/` is a "page file" for the console grammar guard**
   (console-grammar.guard.test.ts:319-321), so `casedetail/*` may not: put a `Card` inside a
   `Panel`, use tracked capitals, an arbitrary radius, `Alert variant="info"`, a spinning
   `RefreshCw`, or a text size under 11px. `PanelCard` (shared.tsx:548-552) IS a `Card`.
10. **Many tests pin source text and class names**, not just behaviour (route-visual-standard,
    CaseDetail.tabs, CaseDetail.footer, case-detail-close, case-visual-dialect, design-gates). A
    redesign must update them in the same change (§9).

---

## 1. File inventory (lines)

| File | Lines | Role |
|---|---|---|
| `webui/src/soc/pages/CaseManager.tsx` | 2,689 | Route page: header, queue, split, bulk bar/dialogs, shortcuts |
| `webui/src/soc/pages/CaseDetail.tsx` | 2,468 | Case orchestrator (fetch, lazy loads, mutations, header, tabs, dialogs) |
| `webui/src/soc/pages/CaseDetail.api.ts` | 415 | triage/timeline/stages/thread/tasks/activity/users API helpers + types |
| `webui/src/soc/case-tabs.ts` | 17 | `CASE_TABS = ['overview','runbook','timeline','investigation','threat','collab','chat']` (entry-safe; router validates `tab`) |
| `casedetail/OverviewPanel.tsx` | 1,910 | Overview tab |
| `casedetail/StageTimeline.tsx` | 712 | Six-stage narrative (Timeline tab) |
| `casedetail/InvestigationPanel.tsx` | 686 | Investigation tab (Decision, AI assessment, inputs, trace, grading history) |
| `casedetail/ThreatContextPanel.tsx` | 680 | Threat context tab |
| `casedetail/ConfirmActionDialog.tsx` | 680 | The ONE lifecycle dialog (close/resolve/escalate/hold/...) |
| `casedetail/WhyPanel.tsx` | 641 | Full assessment evidence (inside a disclosure on Investigation) |
| `casedetail/RunbookPanel.tsx` | 580 | Runbook tab (lazy) |
| `casedetail/grading.tsx` | 570 | AI grading model + GradingSection + GradingHistory |
| `casedetail/shared.tsx` | 560 | ActionDef model, `actionPlanForStatus`, DISPOSITION_OPTIONS, `PanelCard`, `CASE_MANAGER_PANEL_PADDING` |
| `casedetail/FactsRail.tsx` | 495 | Facts rail (beside every tab from a 60rem pane) |
| `casedetail/CaseHeaderMeta.tsx` | 458 | Header meta row |
| `casedetail/CollaborationPanel.tsx` | 419 | Collaboration tab + `AssigneePicker` |
| `casedetail/SignalProfile.tsx` | 369 | Risk/confidence meters + 5 factor bars (in the rail) |
| `casedetail/InvestigationInputs.tsx` | 326 | Latest-run inputs (Overview AND Investigation) |
| `casedetail/DecisionCard.tsx` | 302 | Deterministic decision card (inside "Show policy inputs") |
| `casedetail/ClusterFormationDiagram.tsx` | 301 | Alert → cluster → case diagram (Threat context) |
| `casedetail/BulkCloseDialog.tsx` | 288 | Bulk (and Cases one-click) close/resolve with disposition |
| `casedetail/queue.ts` | 251 | Pure queue helpers |
| `casedetail/CaseChat.tsx` | 219 | Lazy case chat body |
| `casedetail/DispositionPicker.tsx` | 192 | Radio cards + 1-6 hotkeys |
| `casedetail/case-starters-prefetch.ts` | 191 | Case chat starters prefetch |
| `casedetail/caseFacts.ts` | 178 | `caseDisplayId`, `caseTitle`, `primaryFact`, `slaReading`, `statusWords`, ... |
| `casedetail/CaseChatPanel.tsx` | 135 | Chat tab shell |
| `casedetail/TimelinePanel.tsx` | 91 | Timeline tab shell |
| `casedetail/AskAi.tsx` | 59 | Ask AI chip/icon (opens a NEW Workspace chat, #5) |
| `casedetail/notifyResult.ts` | 52 | Notify toast wording |
| `casedetail/keyboard.ts` | 43 | `shortcutBlocked` |
| `soc/components/CaseThread.tsx` | 745 | Discussion thread (text only) |
| `soc/components/CaseTasks.tsx` | 408 | Task checklist (Runbook tab "Other tasks") |
| `soc/components/CaseActivityFeed.tsx` | 361 | Activity timeline |
| `soc/runbooks/run/NextStepCard.tsx` | 510 | Next step card (Runbook tab) + `OverviewNextStep` (Overview) |
| `soc/runbooks/run/OpenStepsNotice.tsx` | 140 | Open required steps + reason field in the close dialog |
| `soc/runbooks/run/OtherTasks.tsx` | 140 | Free-form tasks loader |
| `soc/components/badges.tsx` / `outcome.ts` / `OwnerMonogram.tsx` / `ProvenanceTag.tsx` / `TraceTimeline.tsx` | 864 / 409 / 65 / 163 / 538 | Shared case vocabulary |

---

## 2. CaseManager.tsx (2,689 lines)

### 2.1 Structure
- File header comment 1-25 (Round 12 CM-1…CM-9; Round 14 D27 header and "Closed by").
- Constants 152-190: `ANY_SEVERITY`, `ANY_STATUS`, `SPLIT_STORAGE_KEY='soc.caseManager.queueWidth'` (156),
  `DENSITY_STORAGE_KEY='soc.caseManager.density'` (157), split min/max/default 320/680/400, detail
  min 560, handle 9px, keyboard step 24px, `SEARCH_DEBOUNCE_MS=250`, `LIVE_FLUSH_MS=600`.
  `BULK_STATUSES` (171: Open, Investigating, On hold, Escalated), `BULK_DISPOSITIONS` (178: a
  second hand-written copy of the six dispositions; `shared.tsx` `DISPOSITION_OPTIONS` is the
  schema-pinned one).
- `SEVERITY_RAIL` (192), `SEVERITY_WORD`, `RISK_WORD` (tone maps; risk band cut-offs 74/48/22
  hard-coded at 368, which differ from `scoreBand`).
- `QueueRow` 317-563; `QueueSkeleton` 565 (`LoadingState` "Loading cases" / "Preparing the case queue.").
- `canSelectCases` 582 (any of `cases:write|assign|reinvestigate|close`), `caseManagerShortcuts`
  595 (role-filtered shortcut list), `QueueCloser` + `CLOSED_BY_LABEL` 633 ("Closed by the AI
  agent", "Closed by an analyst", "Closed by an analyst policy", "Closed by the system"),
  `caseCloser` (client mirror of `closed_by`), `CASE_MANAGER_HELP` 661 (help tip text).
- `CaseManager` 678 wraps `CaseManagerWorkspace` (686) in `MotionProvider`.
- Workspace state/logic 686-1908: queue query (server-backed `GET /api/cases`), paging, resync,
  live `useEventStream(["cases","jobs"])` (1333), hover prefetch, reconcile, tracked bulk job,
  split resize (ResizeObserver), selection, bulk submit as durable jobs
  (`case_lifecycle`, `case_assign`, `case_tag`, `case_reinvestigate`), keyboard model.
- Render 1909-2689.

### 2.2 Render tree (line numbers in the file)
- `ProtectedRoute cases:read` → `PageContainer variant="fluid"` with the pinned class
  `"h-[calc(100dvh-7rem)] min-h-0 w-auto sm:-mx-2 xl:min-h-[600px]"` (1915-1919; pinned by
  route-visual-standard.test.ts:89-91).
- `PageHeader title="Case Manager" help={CASE_MANAGER_HELP}` with controls: `StatusDot` "Live"
  (`data-testid="case-manager-live"`) and `RefreshButton display="icon" label="Refresh case queue"` (1928-1947).
- Split frame `div.surface-panel grid ... xl:grid-cols-[var(--case-manager-columns)]`
  (`data-testid="case-manager-split-frame"`, 1950-1964).
- **Queue** `<aside aria-label="Case queue">` (1966-2441), `hidden xl:flex` while a case is open
  below xl:
  - Header (1973-2135, `border-b`): `h2` scope heading ("Active cases" / "My cases" / "All
    cases"), scope line `data-testid="case-queue-scope"` ("1 of 68 active · 50 loaded"); icon
    buttons **Compact rows** (aria-pressed; tooltip "Compact rows: on/off") and **Keyboard
    shortcuts** (`?`); `SegmentedControl` "Case queue scope" (Active / Mine / All); search input
    "Search all cases, entities…" (aria "Search case queue", `/` kbd hint); a 3-column grid of
    selects: Severity filter, Status filter, Sort ("Latest", "Highest risk", "Newest", "Title
    A-Z"); the removable "Closed by" chip (`data-testid="case-queue-closed-by"`, aria
    "Remove filter: Closed by the AI agent").
  - Selection row (2140-2331, `border-b`, `data-testid="case-manager-selection-row"`): header
    checkbox "Select all visible cases" + label "Select visible" + "N visible"; with a selection:
    "N selected", "Select all N matching" link, **Assign** (cases:assign), **Close…**
    (cases:close), **More** menu (aria "More bulk actions for N selected cases"; items Acknowledge,
    Assign, Add tag, Set status, Set disposition, Reinvestigate, Resolve…, Close…), clear (X).
    Demo note (`case-bulk-demo-note`): "Bulk changes run as background jobs, which are off in
    Demo Mode. Open a case to change it on its own." Progress line "{label}: N of M done" with
    `LoadingBar`; outcome message with a left border.
  - "N new cases · Show" (2333-2345, `case-queue-show-new`).
  - List (2347-2440): skeleton / `LoadError "Could not load cases"` / `EmptyState`
    ("No matching cases", "No cases in this queue", with scope-specific descriptions, "Clear
    filters") / `role="list" aria-label="Cases"` of `motion.div role="listitem"` rows inside
    `AnimatePresence` (row exit height+opacity, `SPRING_UI`); then "Load more · X of Y loaded" or
    "All N loaded".
- **Separator** `<button role="separator" aria-label="Resize case queue">` (2446-2481,
  `case-manager-divider`, keyboard + pointer + double-click reset; hidden below xl).
- **Detail** `<section aria-label="Selected case workspace">` (2484-2536): below-xl back bar
  ("Cases" back button, aria "Back to case queue", display id + title) then
  `<CaseDetail presentation="embedded" previewCase onCaseChange onAdvance resolveDialogFocus requestedTab>`;
  empty: `EmptyState` "Select a case" / "Choose a case from the queue to open the complete
  investigation workspace."
- Dialogs: bulk form dialog (2541-2631: Assign / Tag / Set status / Set disposition; copy e.g.
  "Assign N selected cases", "The selected case IDs are snapshotted when submitted; later
  selection changes do not alter the job."), `BulkCloseDialog` (2633), `ConfirmDialog` for
  Acknowledge/Reinvestigate (2643; copy "Acknowledge N cases?", "Reinvestigate N cases?" with the
  token-spend warning), shortcuts dialog (2654-2685, "Keyboard shortcuts", "Shortcuts work when
  focus is not in a text field. Every case change still opens its dialog first.").

### 2.3 QueueRow (317-563)
Comfortable = three lines: (1) title · chat `ActivityGlyph` · age; (2) severity glyph+word ·
"Risk N" · outcome short label ··· `OwnerMonogram` · status glyph+word (or job spinner/warning);
(3) mono case id (`middleEllipsis`) · primary fact (hidden under `@[22.5rem]/queue`) ·
`RunbookProgressChip`; optional job failure line. Compact = one line. Always-visible checkbox for
bulk roles (sibling, never nested). 3px severity rail (`case-queue-severity-rail`), 2px right
open rail (`case-queue-open-rail`), tints for open/selected/hover. Accessible name concatenates
~12 facts (title, id, fact, severity, risk, status, outcome, owner, age, runbook, job failure, chat).
Test ids: `case-queue-row`, `case-queue-severity`, `case-queue-outcome`
(`data-outcome-source`), `case-queue-status`, `case-queue-id`, `case-queue-fact`.

### 2.4 Density (what a designer calls clutter in the queue)
- Above the first row: page title row (title, help, Live, Refresh) + queue header (h2, scope
  line, 2 icon buttons, 3-segment control, search, 3 selects, optional chip) + selection row
  (checkbox, label, count) = **~11 controls and 3 horizontal rules** before any case.
  At 400px wide the three selects are ~120px each, so "Severity"/"Status" read as unlabelled values.
- The scope line and the selection row both count ("1 of 68 active · 50 loaded" and "50 visible").
- Each comfortable row shows up to **9 facts + 2 glyphs** (title, age, severity glyph+word, risk,
  outcome, owner monogram, status glyph+word, id, fact, runbook chip, chat glyph) and a checkbox,
  in 12px text, with a coloured rail.
- Status and outcome are both on line 2 (a closed case shows "Closed" and "Closed as false
  positive").

### 2.5 Behaviour that must survive a redesign
Server-backed queue (never a client filter of a recent window); loaded-vs-total scope line;
live reconcile (membership vs the whole view, "N new · Show" re-reads the grown window, Load
more resync on shifted order); roving single tab stop (J/K/↑/↓ move and open, X/Space select,
Shift extends, Enter focuses `[data-case-title]`, `/` search, `?` shortcuts, Esc clears); the
"open case left the view" gap logic (1817-1835); focus resolution after dialogs
(`resolveDialogFocus`, "Close & next" lands on the next row or title below xl); selection only
for bulk roles (roles-07); `GET /api/users` read only with `users:manage` (roles-02, an audit
row per refusal otherwise); bulk work as idempotent durable jobs (`retainJobSubmissionIntent`),
refused in Demo Mode; `closedBy` chip carried through navigation.

---

## 3. CaseDetail.tsx (2,468 lines): the case workspace

### 3.1 Props and hosts (373-424)
`caseId`, `onClose`, `onNavigate`, `presentation: 'sheet'|'embedded'`, `onCaseChange`,
`previewCase` (render at once, CM-5), `onAdvance` ("Close & next"), `resolveDialogFocus`,
`requestedTab` (validated with `isCaseTab`). `CaseDetailSurface` (277-371): embedded = a
`<section aria-label="Case detail">`; sheet = `Sheet side="right" size="full"
max-w-[min(98vw,1400px)]`, focuses the title on open, restores focus to the opener on close.

### 3.2 State (436-650)
~60 `useState`s: case, loading, error, campaign, tab, triage, timeline, stages, thread,
activity, pickUsers, rationale, threat, runbook request/prefs, refusedSteps/openStepsReason,
`takeActionOpen`, pending action + 9 field states (note, resolution, priority, assignee, tags,
tagDraft, disposition, `dispositionDeclared` (G1), reason), grading draft, acting, reinvestigate
(open, model, busy, models), exporting, fpPolicy, slaPolicy, owner/tags/details popovers, notify
(open, channels, enabled, channelId, sending). Permission reads (`useAuth().hasPermission`):
`runbooks:read`+`cases:read` (Runbook tab), `runbooks:run`, `cases:reinvestigate`, `cost:view`,
`users:manage`, `cases:comment`, `cases:write`, `cases:assign`, `cases:close`.

Lazy loads: triage eager; campaign best-effort; rationale on Investigation OR always when
embedded (998: `needsRationale = tab === 'investigation' || presentation === 'embedded'`);
timeline + stages on their tabs; thread + activity on Collaboration; threat on Threat context;
runbooks through `useCaseRunbooks`.

### 3.3 Actions model (`casedetail/shared.tsx`)
- `ActionKind` (incl. UI-only `close_disposition` → wire `close` via `wireAction`, #3).
- `ACTION_PERMISSION` (close-class = `cases:close`, rest `cases:write`; `reopen` is `cases:close`).
- `ALL_ACTIONS` with labels/copy: "Close case" ("Close with a disposition" / "Choose the
  investigative outcome, then close this case. The close/escalate decision is still made by
  deterministic code. This records your disposition and closes the case."), "Escalate",
  "Reopen", "Acknowledge & investigate", "Put on hold", "Resume", "Mark resolved", "De-escalate",
  "Set disposition". `close` and `confirm_fp` ActionDefs are defined but never placed in any plan
  (dead UI paths still referenced by key in dialog/grading logic).
- `actionPlanForStatus` (primary / close / overflow):

| Status | Primary | Secondary Close | Overflow |
|---|---|---|---|
| closed | Reopen | none | Set disposition |
| resolved | Close case | none | Set disposition, Reopen |
| on_hold | Resume | Close case | Mark resolved, Escalate |
| escalated | Mark resolved | Close case | De-escalate, Put on hold |
| new / '' | Acknowledge & investigate | Close case | Escalate, Mark resolved, Put on hold |
| open/investigating/needs_human | Escalate | Close case | Acknowledge & investigate, Mark resolved, Put on hold |

- `DISPOSITION_OPTIONS` (schema-pinned, `DispositionCoverage` compile guard): True positive,
  False positive, Benign, Suspicious, Duplicate, Undetermined. `RESOLUTION_OPTIONS`: Handled,
  Benign, Duplicate, No action needed, Other. `PRIORITY_OPTIONS`: Low, Medium, High, Critical.
- `DURABLE_CONTEXT_NOTE`: "Saved with the resolved case as durable context. The AI reads this
  note when it investigates similar cases later."
- `CASE_MANAGER_PANEL_PADDING = 'px-4 py-4 sm:px-5 sm:py-5 lg:px-6'` (pinned by test).
- `PanelCard` = `<Card elevation="none" className="p-6">`; `SectionHeading`, `MetaItem`,
  `HeadlinePanel`, tone maps.

### 3.4 `runAction` (CaseDetail.tsx ~1141-1335): how an analyst closes a case today
1. Build `CaseActionInput {action: wireAction ?? key}` + note, resolution, assignee, priority,
   tags, disposition (+ `disposition_declared` only when the picker was operated, G1), reason.
2. Terminal verb on a non-terminal case: `require_open_steps_reason: true`, `open_steps_reason`;
   blocks client-side with "Say why you are closing with required steps open." unless duplicate.
3. `POST /api/cases/{id}/action` (`api.caseActionExec`, routes.py:7107) → `commitCase`.
4. Toast "Closed as false positive." (8 s) with **Reopen** (posts the `reopen` verb with note
   "Reopened from the close confirmation right after it was closed."), description "Reopening
   keeps this outcome on record until you close the case again with a new one."
   `set_disposition` toasts "Recorded as …".
5. `onAdvance()` for Close & next; reset rationale/timeline/stages; reload triage/activity.
6. Separate best-effort `api.caseFeedback` (grading) with the agreement DERIVED at submit time
   (`deriveAgreement(verdict, committedDisposition)`); posted only on a match/override or a
   dirty grade; 4xx → error toast "Case updated, but the grading was rejected: …", else warning.
7. A `409 runbook_steps_open` keeps the dialog open and lists the steps the server named.

### 3.5 Header (1634-1960): sticky `materialBar`
- `LoadingBar` "Loading case" while refreshing.
- Title row (`data-testid="case-title-row"`): `h2[data-case-title] tabIndex=-1`
  (`truncate text-lg font-semibold leading-8 tracking-tight` → `@[56rem]/case:line-clamp-2
  text-xl`; pinned by case-detail-close.test.tsx:107-108) and the action cluster:
  secondary **Close case** (only from a 56rem pane, `aria-keyshortcuts="C"`), primary action
  (`data-testid="case-primary-action"`, tooltip = `help`), **Take action** menu, **Details**
  (below 60rem, opens the facts Sheet), **Share** (copies the link; "Copy a link to this case"),
  X "Back to case queue" (embedded, xl only).
- **Take action** menu (1721-1904, `w-72`): group "Case actions" (every permitted lifecycle
  action, with A/C/E/H hints), group "Investigation" (Reinvestigate R, Start runbook, Refresh
  case, Ask about this case Alt 7, Change owner M, Edit tags T), group "Share and export" (Open in
  new tab, Export JSON, Export Markdown report, Notify, Open campaign). Up to **~19 items**.
- `CaseHeaderMeta` (meta row) then the tab list (1962-1997): 7 `TabsTrigger`s with
  `EMBEDDED_TAB_TRIGGER` classes (264-266: hand-rolled underline, `text-xs` = 12px) and counts:
  Runbook (`RunbookTabCount`), Investigation (trace steps), Threat context (MITRE count),
  Collaboration (messages), Chat (activity glyph). Alt+1…7.
- Keyboard (1450-1529): A/C/E/H open dialogs, R reinvestigate, M owner, T tags, Alt+digit tabs;
  blocked while any popover/dialog is open or focus is in text entry.

### 3.6 Body (2000-2235)
Error alert "Could not load case"; `LoadingState` "Loading case" / "Retrieving the case record
and its evidence."; one scroll lane `data-testid="case-detail-scroll"` (Chat tab gets
`overflow-hidden`); each `TabsContent` wraps a `TabPanelMotion`. Facts column
`data-testid="case-facts-column"` `w-[19rem] border-l px-4 py-5`, visible `@[60rem]/case`.
Narrow panes: non-modal `Sheet` "Case facts" holding the same rail (2238-2268).

### 3.7 Dialogs in CaseDetail
- Reinvestigate (2273-2330): "Re-run the investigation", warning Alert "Costs tokens and
  overwrites the verdict", Model select ("Use configured model" + providers), Reinvestigate.
- `ConfirmActionDialog` (2333-2380) wired with every controlled field.
- Notify (2384-2448): "Send this case to a notification channel. Delivery is fire-and-forget and
  never changes the case." Channel select / "Notifications are off" / "No channels configured".

---

## 4. The close and disposition controls

### 4.1 `ConfirmActionDialog.tsx` (680 lines)
Polymorphic on `pending.fields`. `wide` (max-w-3xl, two columns from `@[40rem]/confirm`) when the
action has disposition, grading or open steps; else max-w-md. Sticky footer
(`confirm-action-footer`, `border-t bg-card`) with a polite status line ("Pick a disposition." /
"Say why you are closing with required steps open."), Cancel, and either the action button or
(terminal + `onSubmitAndNext`) **{label}** (outline) + **Close & next** / **Resolve & next**.

Left column: `DispositionPicker` (required) → compare line (`confirm-action-compare`: "AI: …" →
"You are recording: …" · agreement words) → reconcile prompt (`confirm-action-reconcile`: "You
graded this a … Record it as the case disposition?" Record / Not now) → **Resolution
(optional)** select → **Tags (optional)** `TagInput` (max room vs `CASE_TAG_MAX_COUNT`, blocks a
typed-not-added tag) → Assign to (optional) → Priority (optional) → Reason (optional).
Right column: `OpenStepsNotice` (steps + "Why are you closing with required steps open?") →
**Analyst note (optional)** + `DURABLE_CONTEXT_NOTE` when the note persists (close/confirm_fp)
→ `GradingSection` ("Grade the AI decision", default open, bordered `rounded-md border p-4`).

`GradingFields` (grading.tsx): agreement Badge ("Matches AI verdict" / "Overrides AI verdict
(X → Y)" / resolved), **What actually happened? (optional)** select (Not stated, True positive:
the alert was real, False positive: the alert was wrong, True negative: correctly quiet, False
negative: the detection missed it) with help "The confirmed outcome. This is the only part of a
grade that becomes analyst-confirmed ground truth…", "What did the AI miss? (optional)" on an
override, "Rate in detail" disclosure with three 5-star rows (Accuracy, Reasoning quality,
Action appropriateness).

**Clutter counts for Close case on a case with an AI verdict:** 6 radio cards (each with a kbd
"1"…"6" chip and a definition), AI-suggested hint chip, compare line, Resolution select, tags
input, note textarea, grading trigger, agreement badge, outcome select, (miss textarea), Rate in
detail trigger, 15 star buttons, Cancel, Close case, Close & next ≈ **28-30 controls and 4
bordered boxes** (dialog, radio cards, grading box, star box). The outcome question is asked
three ways: Disposition, Resolution (Benign/Duplicate overlap) and What actually happened
(TP/FP overlap; the reconcile prompt exists only to paper over that overlap).

### 4.2 `DispositionPicker.tsx` (192)
`RadioGroup` of 6 label-cards, opens EMPTY (G1), "Disposition (required)", "AI suggested: …"
hint (read-only), definitions (`DISPOSITION_DEFINITIONS`), help "Currently recorded: …. Pick the
outcome you are confirming; your choice is what is stored as the analyst's." Document-level 1-6
hotkeys while not in a text field. `focusDispositionPicker` gives the dialog its initial focus.

### 4.3 `BulkCloseDialog.tsx` (288)
Used by the Case Manager bulk bar and the Cases list (bulk and one-click row close). Title "Close
N cases"/"Resolve N cases", same picker, Resolution (optional), note or reason, the shared
optional open-steps reason with a count, `AUTOMATIC_CLOSES_NOTE`. Submits `BulkCloseInput`
(`disposition_declared: true` always) as a `case_lifecycle` job; defaults resolution "Bulk-closed
by analyst" / reason "Bulk-resolved by analyst" (CaseManager.tsx `submitBulkTerminal`).

### 4.4 Runbook open-steps close reason
`OpenStepsNotice.tsx`: `OPEN_STEPS_REASON_LABEL = 'Why are you closing with required steps
open?'`, `OPEN_STEPS_REASON_MAX_CHARS = 500`, `AUTOMATIC_CLOSES_NOTE = 'Automatic closes never
look at runbook steps.'`; required except Duplicate; audited on `case.closed_with_open_steps`.

### 4.5 Other entry points to close/disposition
- Header secondary Close case, primary on resolved, `C` key, Take action items.
- Facts rail Outcome "Set disposition" (when `analyst_unrecorded`).
- Overview "No analyst classification was recorded when this case was closed." + **Set
  disposition** (`overview-set-disposition`).
- Runbook tab / Next step "All required steps are done." → **Close case** (opens the same dialog).

### 4.6 Assignment, acknowledge, reopen
- Owner: `CaseHeaderMeta` popover (`case-detail-owner`, "Owner", picker + "Assign to me",
  "You can view the owner but not change it."), `FactsRail` Ownership `AssigneePicker`,
  `CollaborationPanel` Ownership `AssigneePicker` (Label "Assignee"), Escalate dialog's "Assign to
  (optional)", bulk Assign. `AssigneePicker` is a Select over `users:manage` users with a
  free-text fallback (`api.caseAssign`, `POST /api/cases/{id}/assign`).
- Acknowledge: primary on a new case ("Acknowledge & investigate" → INVESTIGATING), overflow on
  working cases, `A` key, bulk Acknowledge (ConfirmDialog).
- Reopen: primary on closed, overflow on resolved, the 8 s toast action.

---

## 5. The tabs

### 5.1 Overview (`OverviewPanel.tsx`, 1,910; CM branch from 995)
Root `@container/overview space-y-6` + panel padding. In order:
1. `runbookCard` = `OverviewNextStep` (NextStepCard.tsx:425-510): h3 "Runbook" + "{title},
   version N", bordered `CardFrame` (rounded-xl border bg-card, 3px primary rail) with "Next step",
   "{Phase} · step N of M", `KindChip`, Required/Optional, assignee, step title, focus line,
   **Open runbook** / **Review draft**; `ProgressLine`.
2. Decision summary (`case-manager-decision-summary`, a `PanelCard` stripped flat): h2 headline
   (outcome of record or AI headline) + `ProvenanceTag` ai/analyst; `overview-ai-line`; unrecorded
   note + Set disposition; summary sentence; "Recommended action" block (left border, AI tag) or
   "Summary and recommended action"; "Escalated" badge; the authority sentence
   (`overview-authority`, e.g. "The close or escalate decision is made by deterministic code
   against the operator policy, never by this panel or by the model."); auto-close line with lock
   icon; terminal: "AI recommendation at triage" `<details>`.
3. `InvestigationInputs` (h3 "Investigation inputs", "Only latest-run inputs actually consulted or
   applied to this case path.", **Review inputs**, one tooltip button per input, closing note
   "These inputs informed preprocessing or the agent assessment. Deterministic policy still made
   the final route.").
4. Provenance (`SectionLabel` "Provenance", `source-assessment-delta` "Source severity: X → We
   assess: Y risk", three lanes via `CM_THREE_LANES` from `@[42rem]`): **Source says** (reported
   severity badge + provenance tag, detection rules as `RuleLink`s, Source, "Why it fired"),
   **Agent found** (findings counts as tooltip buttons: findings, clean checks, prior analogous
   cases, MITRE), **Code decided** / **Analyst resolved** / **Analyst policy** (lock row
   "Deterministic decision authority" + `case_manager` badge, Authority, Auto-close, objection
   window; or the analyst lane `overview-analyst-lane`). Each lane: icon + h3 + `ProvenanceTag`.
5. "Entity & story": **Primary entity** (`SectionHeading`, InlineCode, Internal/External badge,
   type badge, enrichment rows, Copy chip, Ask AI chip) and **Attack story** (4 steps, each a
   link to a tab: "See what happened on Timeline", "See the searches on Investigation", "See the
   intel on Threat context", "See the decision on Investigation").
6. `BaselineAdvisory` (conditional).
7. "Evidence": **Evidence checklist** table (Check, Result (Found/Clear badge), Evidence
   (InlineCode), Confidence impact) spanning 2 lanes + **Reproduce investigation** (CodeBlocks).
8. "Related cases" collapsible (conditional), "Provenance & audit" collapsible
   (AutomationApplied + StatusTimeline).
9. "Investigation error" destructive Alert.

Density: **~11 section headings, 6+ ProvenanceTags, 3 three-lane grids, 1 bordered card, 1
table, 2 code blocks, 2 collapsibles**, plus the facts rail beside it. The authority sentence
is said 3 times on this tab alone (decision summary, Code decided lane, Investigation inputs note).

### 5.2 Runbook (`RunbookPanel.tsx`, 580, lazy)
Strip (title, pinned version, how/when attached, Why attached, Add runbook, More), progress
line, the pinned **Next step card**, `PhaseTabs` (only the selected phase's steps), **Other
tasks** (`OtherTasks` → `CaseTasks variant="other"`), a one-line limits note. Empty: "No runbook
is attached to this case." + Start runbook. Read-only notes: "You can view this runbook but not
update it." / "Runbooks are turned off in Settings, so steps cannot change." `onCloseCase` opens
the case close dialog.

### 5.3 Timeline (`TimelinePanel.tsx` 91 + `StageTimeline.tsx` 712)
CM branch = only `StageTimeline presentation="case-manager"` on the panel rail. Six stages
(input → correlate → risk → triage → investigate → decide), deterministic badge
(`story-stage-deterministic`), risk derivation (`risk-derivation`, `risk-formula`), final marker
deep-links to Investigation.

### 5.4 Investigation (`InvestigationPanel.tsx` 686, CM variant 133-520)
1. Decision section (`investigation-decision`, `border-b`): icon chip, h2 "Decision" / "Analyst
   resolved" / "Analyst policy" + `ProvenanceTag`, decision line (mono when it is a `key=value`
   record), "Before the analyst: …", AI line, status Badge; "Show policy inputs" disclosure →
   **DecisionCard** (DecisionCard.tsx: `rounded-xl border-2 border-low/40 bg-low/5 p-5`, h3
   "Deterministic decision", "The close / escalate authority (#3)", Decided by, facts grid
   Verdict/Confidence/Risk score/Result, policy clause, precedent, objection window; motion
   "verdict lands").
2. AI assessment (`investigation-assessment`, bordered card `rounded-lg border bg-card p-4`,
   critical-risk left rail): h2 "AI assessment" + AI tag, "The model's reading of the evidence.
   Advisory only.", confidence, summary, Recommended action / "AI recommendation at triage", Risk
   score (`investigation-risk`), "Show full assessment evidence" → `WhyPanel hideDecision
   hideMitre` inside a `rounded-md border` box. **WhyPanel renders its own `space-y-6 p-6` and
   one bordered `PanelCard` per section (Agent reasoning, Investigation procedure, knowledge,
   tools, memory, enrichment, ...)**: 3-4 levels of nested borders.
3. `InvestigationInputs showSelectionStatus` (the SAME component as on Overview).
4. Trace (`investigation-trace`): h2 "Investigation trace" (focus target), counts
   (`investigation-trace-counts`: "N steps · M tools" / "Loads when opened"), "Jump to decision",
   "Show trace"/"Hide trace", actor `SegmentedControl` (All / Agent / Tool / Code), `TraceTimeline`.
5. `GradingHistory` ("Previous gradings", bordered cards per grading).

### 5.5 Threat context (`ThreatContextPanel.tsx` 680, CM branch 226-~440)
Flat sections with `FlatHeading`: threat summary, MITRE techniques (`threat-mitre`, links to
attack.mitre.org), IOC reputation rows (`threat-ioc`, `threat-ioc-row`, tri-state verdict
"Malicious" / "No detections" / "Not checked", never "Clean"), `ClusterFormationDiagram`, asset
context. Non-CM branch uses 4 `PanelCard`s (dead in production).

### 5.6 Collaboration (`CollaborationPanel.tsx` 419)
Grid `lg:grid-cols-[minmax(0,1fr)_18rem]` (viewport `lg`, not a container query): left
"Discussion" (`SectionHeading` + "N messages" info Badge, `LoadingBar`, `LoadError`s, `CaseThread`
restyled with arbitrary child selectors `[&>div:last-child]:…`); right sticky aside
(`bg-muted/20`): **Ownership** (Label "Assignee" + `AssigneePicker`), **Tasks** ("Case tasks are in
the Runbook tab, under Other tasks." + "Open the Runbook tab"), **Activity** (`CaseActivityFeed`
with "Show activity by" All/Human/AI/System). **At ≥60rem pane AND ≥1024px viewport the tab shows
three columns at once: thread, this 18rem aside, and the 19rem facts rail.**

`CaseThread.tsx` (745): replies (one level), @mentions (users from `users:manage`), edit,
soft-delete tombstones, reactions (fixed emoji set), live via `cases:{id}` SSE; human text plain,
AI text through the safe `Markdown` renderer. **No attachments, images, paste or drop.**
`CaseTasks.tsx` (408): checklist with status open/in_progress/done/blocked and a log trail
(`/api/cases/{id}/tasks`, `PATCH`, `/log`); never a case status (#3).

### 5.7 Chat (`CaseChatPanel.tsx` 135 + `CaseChat.tsx` 219)
Lazy; the shared engine with `caseId` (#5), never in Workspace history; compact composer; up to 3
case starter chips (`GET /api/chat/starters?surface=case`); quick actions "Summarise the case",
"Check indicators", "Suggest remediation".

---

## 6. Facts shown more than once (the duplication a redesign should remove)

| Fact | Where it appears in one open case |
|---|---|
| Owner (editable) | Header meta popover · Facts rail Ownership picker · Collaboration Ownership picker · queue row monogram |
| Tags | Header meta (2 badges + n, popover editor) · Facts rail Ownership badges · close dialog Tags |
| Severity | Queue row · header `SeverityBadge`+provenance · Rail Triage · Overview "Source says" · delta cue |
| Risk | Queue row · header "Risk N Band" · Rail Signal profile meter · Investigation risk score · DecisionCard · Timeline risk stage · delta cue |
| Confidence | Header AI verdict chip · Rail Signal profile · Investigation assessment · DecisionCard |
| Outcome of record | Queue row · header `OutcomeBadge` · Rail Outcome headline · Overview headline (h2) · Investigation decision line |
| AI verdict line | Header chip · Rail Outcome aiLine · Overview AI line · Investigation AI line · close dialog compare line |
| Status | Queue row · header status · Investigation status badge · DecisionCard Result |
| Times / SLA | Header (Opened, Ack, SLA) · Rail Times and SLA |
| Primary entity | Overview Primary entity lane · Rail Primary entity · queue fact |
| Detection rules | Overview Source says · Rail Source · Rail Primary entity "Seen by" |
| Recommended action | Overview decision summary · Investigation assessment |
| Investigation inputs | Overview · Investigation |
| Authority sentence | Overview (×3: summary, Code decided lane, inputs note) · Investigation inputs note · DecisionCard |
| Objection window | Rail Outcome · Overview Code decided lane · DecisionCard |
| Related cases | Overview Agent found · Overview Related cases collapsible · Rail Related cases |
| MITRE | Overview Agent found · Threat context tab · tab count |

Header density (embedded, pane ≥56rem): ~6 action controls, ~8-10 interactive meta items (copy,
Ask AI, risk info button, owner, tags, campaign chip) + up to 6 badges/chips (severity, outcome,
AI verdict, 2 tags, Demo) + 7 tabs with up to 4 counts ⇒ **~22 tab stops before the first tab
panel**. The facts rail adds 10 sections (Outcome, Signal profile, Triage, Ownership, Runbook,
Times and SLA, Source, Primary entity, Related cases, Record), each with an icon heading and a
top hairline.

At 1920px the visible columns are: nav rail · queue · tab body (with 3-lane grids inside) ·
19rem facts rail = up to **six visual columns**.

---

## 7. Rules a redesign must follow

From `docs/development/ui-standard.md` (2,088 lines) and `docs/development/design-system.md` (229):

- **Visual character (26-43):** calm, hairline dividers, semantic colour only when meaningful;
  avoid nested cards, resting shadows, decorative gradients; tokens only (`background`, `surface`,
  `card`, `border`, `foreground`, `muted-foreground`), never page-local hex; prefer transparent
  sections separated by `border-border` over card-in-card.
- **Spacing (53-65):** Tailwind 4px scale on an 8px rhythm; 4px in chips, 8-12px between
  related controls/rows, 16-20px pane insets, 24px column gutters; containers set rhythm with
  `gap-*`/`space-y-*`; children never add sibling margins; **one 16-24px rail per pane, never
  stack page, pane and panel padding**.
- **Radii (67-87):** `rounded-sm` 6px chips/tabs/segments; `rounded-md` 8px buttons/inputs/cards;
  `rounded-lg` 10px menus/popovers/tooltips; `rounded-xl` 14px dialogs/sheets/panels; 0 for
  bands, list rows, tables, split panes. No arbitrary radius in a page file (guard).
- **Typography (89-121):** Inter; size steps carry tracking, **do not add `tracking-tight`**
  (12 occurrences in the case files today); weights 400-650; proportional figures by default,
  `tabular-nums` only on compared numbers (never a whole row); `text-2xs` (11px) only for badges,
  ticks, timestamps; content ≥12px.
- **Numerals (123-142):** never truncated or split.
- **Materials (144-187):** `materialBar`/`materialThick`/`MaterialBar` for sticky chrome only
  (the case header uses `materialBar` already); content on opaque surfaces; no page-local blur.
- **Elevation (189-193):** borders for tiles, shadows only for portals; non-blocking side panes
  get no scrim.
- **Motion (195-207, 1397-1431):** `SPRING_UI` for tabs/disclosure/row reflow/bulk bar,
  `SPRING_PANE` for sheets and side panes; animate transform/opacity only; honour reduced
  motion; automatic refresh never animates; pane timings 200ms open/160ms close
  (`ease-standard`). `motion` stays lazy (the Case Manager imports it via
  `@/soc/components/motion`, inside the lazy chunk).
- **Page anatomy (227-347):** `PageContainer` owns width and rhythm (a full-height workspace
  may pass `rhythm="none"`); one `PageHeader` (title h1, help tip, controls slot, actions; no
  icon chip, no eyebrow, no description); modules on `Panel` (`surface-panel`, 14px, no border);
  **no `Card` inside a `Panel`**; one KPI strip max; **record sections are underline tabs:
  `TabsList variant="underline"`, 13px labels, no icons, 2px primary rule** (the case tabs
  hand-roll this with 12px `text-xs` via `EMBEDDED_TAB_TRIGGER`); sentence case; `RefreshButton`;
  `Callout` (warning/error/intro) not `Alert variant="info"`; states keep the geometry. "Do not
  repeat a page title inside the first content panel. Do not add an eyebrow…". Embedded leaves
  yield heading/actions to their host and may use a labelled `ControlBar`; queue filters belong
  in that control band.
- **Tables, filters, lists (349-480):** `DataTable` with `kind` per column; `FilterBar` = search
  + at most three primary filters, the rest behind "More filters", removable chips, "Clear all",
  a labelled group (below 768px: search + "Filters (n)" sheet); `ListRows`/`ListRow` for record
  lists, divided by hairlines; `StatusDot`; `RowActions`; `Callout`; `Field`/`NumberField`.
- **Activity and audit logs (482-520):** case activity as plain-sentence timeline with
  "Show activity by" segmented control; inspector sections divider-led.
- **Empty states (522-548):** `EmptyState` with explicit `state` (`first-use`, `no-data`,
  `no-results`, `success`, `unavailable`, `error`).
- **Queue and detail workspaces (550-639):** one hairline focusable separator with documented
  keyboard steps, persisted presentation-only width, removed below desktop with a back path;
  routed split may bleed to a 16px inset; **header, tabs and every tab panel share one 16-24px
  rail**; queue rows are a divided list (title + age, then severity word, risk, id, fact, status
  glyph+text), severity rail only reinforces the word; open/selected/hover/focus distinct;
  server-backed queue with loaded-vs-total; roving focus model; selection independent of
  navigation, "Select visible" vs "Select all N matching"; every path that ends a case collects
  a disposition. **Case outcome:** status = glyph+text, outcome = filled disposition badge with
  Analyst tag, AI verdict = outline chip with AI glyph, never sharing a style; one shared helper
  (`caseOutcome`). **Case header:** stays above every tab; title one line in a narrow pane; one
  meta row; one primary contextual action + Take action; facts live once in a facts rail (Details
  sheet when narrow); title never squeezed; lifecycle dialogs keep actions in a non-scrolling
  footer, open on the disposition, return focus to the opener (or the next row); **Reopen, never
  "Undo"**; a Needs-human close without a grade records no agreement.
- **Investigation-input provenance (641-661):** latest run only; flat Overview flow linking to
  Investigation detail; no nested feature-badge card; authority boundary sentence at the end.
- **Case Manager chat (1145-1154).**
- **Accessibility (2064-2088):** visible focus; icon-only controls named, ≥24×24; Radix for
  menu/dialog/radio/tabs; untrusted text as text; truncation has an accessible full value;
  load-bearing caveats as visible text (never only a `title`); WCAG AA in both themes; do not
  dim a measured `*-text` token with opacity; reduced motion/transparency/increased contrast.
  Before handoff: typecheck, lint, design gates, focused tests, full suite, build; inspect both
  themes, narrow viewport, hover/focus, lazy loading, console.
- **Design system (design-system.md):** import `LoadingState`, `LoadingBar`, `Panel`,
  `SectionTitle`, `PANEL_*`, `ListRow(s)`, `RowActions`, `StatusDot`, `Callout`, `MaterialBar`
  from `@/design-system` (shared primitives import `@/design-system/material` directly);
  `OwnerMonogram` is the one assignee monogram for Cases list, queue and case header; `Tabs`
  underline for record sections; `SegmentedControl` = 36px rail; one blocking-load grammar
  (`layout="page"|"panel"|"table"|"inline"`), `LoadingBar` for refresh, no page-local spinner.
- **AGENTS.md constraints:** no new npm deps (only lazy `motion`); keep `webui/src/lib/types.ts`
  in sync with `models.py`; #9 every case-derived string plain text; #3 the UI never decides a
  close (only existing verbs via `wireAction`); #5 case chat never enters Workspace history.

---

## 8. Data-testids and copy a redesign touches

Queue: `case-manager`, `case-manager-layout`, `case-manager-live`, `case-manager-split-frame`,
`case-manager-selection-row`, `case-bulk-demo-note`, `case-manager-divider`, `case-queue-row`,
`case-queue-severity-rail`, `case-queue-open-rail`, `case-queue-severity`, `case-queue-outcome`,
`case-queue-status`, `case-queue-id`, `case-queue-fact`, `case-queue-scope`,
`case-queue-closed-by`, `case-queue-show-new`.
Detail: `case-detail-header`, `case-title-row`, `case-title-cell`, `case-primary-action`,
`case-detail-scroll`, `case-facts-column`, `case-detail-meta`, `case-detail-id`,
`case-detail-risk`, `case-detail-status`, `case-detail-owner`, `case-detail-tags`,
`case-detail-times`, `case-detail-sla`, `case-facts-rail`, `facts-outcome`,
`facts-outcome-headline`, `facts-recorded-disposition`, `facts-triage`, `facts-ownership`,
`facts-runbook`, `facts-times`, `facts-source`, `facts-entity`, `facts-related`, `facts-record`,
`case-signal-profile`, `risk-factor-grid`, `case-manager-decision-summary`, `overview-ai-line`,
`overview-unrecorded-note`, `overview-set-disposition`, `overview-summary-and-action`,
`overview-authority`, `overview-triage-recommendation`, `overview-section-label`,
`source-assessment-delta`, `overview-analyst-lane`, `investigation-decision`,
`investigation-decision-line`, `investigation-ai-line`, `investigation-assessment`,
`investigation-risk`, `investigation-trace`, `investigation-trace-counts`, `decision-card`,
`confirm-action-dialog`, `confirm-action-body`, `confirm-action-compare`,
`confirm-action-reconcile`, `confirm-action-footer`, `confirm-action-status`,
`disposition-picker`, `disposition-ai-hint`, `threat-mitre`, `threat-ioc`, `threat-ioc-row`,
data attributes `data-case-panel`, `data-presentation`, `data-case-manager-section`,
`data-overview-surface`, `data-collaboration-surface`, `data-next-step-card`, `[data-case-title]`,
`[data-queue-row]`, `data-row-state`, `data-outcome-source`, `data-decided-by`.

Accessible names pinned by tests include: "Case queue", "Cases" (list), "Case queue scope",
"Search case queue", "Severity filter", "Status filter", "Sort case queue", "Select all
visible cases", "Select {id}", "Compact rows", "Keyboard shortcuts", "More bulk actions for N
selected case(s)", "Clear case selection", "Resize case queue", "Back to case queue", "Selected
case workspace", "Case detail", "Take action", "Share", "Details", "Case facts", "Refresh case
queue", "Remove filter: Closed by the AI agent", tab names Overview/Runbook/Timeline/
Investigation/Threat context/Collaboration/Chat, "Re-run the investigation".

---

## 9. Tests that pin Case Manager / case detail structure or copy

Lines in parentheses. **Source-text tests (readFileSync)** are marked ★: they break on renames
and moved markup, not only on behaviour.

Case Manager page
- `src/soc/pages/__tests__/CaseManager.test.tsx` (1,869): ~60 cases; mocks CaseDetail as
  `embedded-case-detail`, so it pins the queue, split, bulk bar, dialogs, keyboard model, copy
  ("1 of 68 active · 50 loaded", "All 68 loaded", "Select visible", "2 selected", "Close…",
  "Close 2 cases", "Acknowledge cases", "Reinvestigate 2 cases?", "1 new case · Show", heading
  level 1 "Case Manager"), the axe check, roles-02/roles-07, `caseManagerShortcuts`.
- ★ `src/soc/__tests__/route-visual-standard.test.ts` (179): exact PageContainer class string,
  `w-auto sm:-mx-2`, `role="separator"`, `CONTENT_INSET` pair, `CASE_MANAGER_PANEL_PADDING` value
  and its use in six panel files.
- ★ `src/soc/__tests__/nav-titles.round14.test.ts` (151): `case_manager: ['pages/CaseManager.tsx']`.
- `src/soc/__tests__/router-deep-links.round14.test.tsx` (394): `caseId`, `tab`, `closedBy` keys.
- `src/soc/__tests__/console-map.contract.test.ts` (447): keywords for `page:case_manager`
  ('split pane', 'queue', 'bulk', 'case detail', 'start runbook', 'runbook tab', 'take action');
  regenerate with `npm run gen:console-map`.
- `src/soc/__tests__/nav.behaviour.test.tsx`, `src/soc/components/__tests__/NavSidebar.activity.test.tsx`
  (the chat glyph on the Case Manager nav item), `src/soc/chat-activity/__tests__/glyph.test.tsx` ★.
- `src/soc/__tests__/cases.round14.test.tsx`, `src/soc/__tests__/cases-controls.test.tsx`
  (Cases list hand-off to Case Manager and BulkCloseDialog use).

CaseDetail orchestrator
- ★ `src/soc/pages/__tests__/CaseDetail.tabs.test.tsx` (318): exactly 7 `TabsTrigger` in source
  order with labels and `aria-keyshortcuts="Alt+N"`, one mount per panel, removed tabs
  (why/trace/feedback), `presentation="case-manager"` forwarding, Chat lane, lazy loads, "Open in
  new tab", Runbook tab gating, Next step card, D34 close reason.
- ★ `src/soc/pages/__tests__/CaseDetail.footer.test.tsx` (158): one primary CTA, one "Close case"
  secondary, Take action, no "Confirm false positive"/"Set disposition" buttons, `close` wire verb
  regexes over shared.tsx and CaseDetail.tsx.
- `src/soc/__tests__/case-detail-close.test.tsx` (231): one dismiss control, embedded region,
  7 tabs, Share/Take action/Back to case queue, "High severity", title classes
  (`text-lg truncate font-semibold`, `@[56rem]/case:text-xl`, `@[56rem]/case:line-clamp-2`),
  id `font-mono break-all`, meta `text-xs text-muted-foreground`, Take action menu items.
- `CaseDetail.campaign.test.tsx` ★, `CaseDetail.collaboration-errors.test.tsx`,
  `CaseDetail.focus-return.test.tsx`, `CaseDetail.grading.test.tsx` (505: two POSTs, Reopen toast,
  G1 empty picker), `CaseDetail.header-bands.test.tsx`, `CaseDetail.keyboard.test.tsx` (Details
  sheet focus, wrapped actions), `CaseDetail.lazyguards.test.tsx` ★, `CaseDetail.live.test.tsx` ★,
  `CaseDetail.notify.test.tsx`, `CaseDetail.permissions.test.tsx` (tier gates, "Case actions"
  group), `CaseDetail.requested-tab.test.tsx` (537), `CaseDetail.resolved.test.tsx`
  (`actionPlanForStatus` table), `CaseDetail.runbook-close.test.tsx` (all in
  `src/soc/pages/__tests__/`).
- `src/soc/pages/__tests__/Investigate.round6.test.tsx`, `Workspace.round14.test.tsx`,
  overview drill-down suites (`overview.drilldown*.test.tsx`, `overview.deepinspection`,
  `overview.kpimodal.a11y`, `overview.lattice`, `spec-independent-drilldown`) open the Sheet host.

Panels and dialogs (`src/soc/pages/casedetail/__tests__/`)
- `OverviewPanel.test.tsx` (916), `OverviewPanel.automation.test.tsx`,
  `OverviewPanel.baseline.test.tsx`, `InvestigationPanel.test.tsx` (439), `WhyPanel.test.tsx`
  (387), `DecisionCard.test.tsx`, `DecisionCard.precedent.test.tsx`, `FactsRail.test.tsx`,
  `CaseHeaderMeta.tags.test.tsx`, `ConfirmActionDialog.test.tsx`,
  `ConfirmActionDialog.tags.test.tsx`, `BulkCloseDialog.test.tsx`, `grading.test.tsx`,
  `analyst-note-disclosure.test.tsx` (DURABLE_CONTEXT_NOTE placement), `CollaborationPanel.test.tsx`,
  `TimelinePanel.test.tsx`, `StageTimeline.test.tsx`, `ThreatContextPanel.test.tsx`,
  `ClusterFormationDiagram.test.tsx`, `CaseChatPanel.test.tsx`, `CaseChat.starters.test.tsx`,
  `CaseChat.width.test.tsx`, `case-starters-prefetch.test.tsx`, `InvestigationInputs.test.tsx`,
  `queue.test.ts`, `keyboard.test.ts`, `notifyResult.test.ts`, `shared.test.tsx`,
  `case-copy.punctuation.test.ts` (copy punctuation rules), ★ `case-visual-dialect.test.tsx`
  (no tracked caps in any casedetail file, "Clean" never renders in either presentation, AI
  Markdown in the thread, timeline colour by value).

Shared components and runbook-run surfaces
- `src/soc/components/__tests__/CaseThread.test.tsx`, `CaseTasks.test.tsx`,
  `CaseActivityFeed.round14.test.tsx`, `OwnerMonogram.test.tsx` ★, `TraceTimeline.test.tsx`,
  `AskAiChip.hosts.test.tsx`, `RuleLink.hosts.test.tsx`, `CaseHoverCard.provenance.test.tsx`,
  `BaselineGauge.test.tsx`, `src/soc/components/audit/__tests__/AuditLinks.test.tsx` ("Open case trace").
- `src/soc/runbooks/run/__tests__/RunbookPanel.test.tsx` (919), `case-surfaces.test.tsx`,
  `close-with-open-steps.test.tsx`, `run-regressions.test.tsx` (838),
  `approvals-announcements.test.tsx` ★.

Global gates that read these files
- ★ `src/soc/__tests__/console-grammar.guard.test.ts` + `guard-allow/*.json` (every
  `soc/pages/**` file is a page file).
- ★ `src/soc/__tests__/design-gates.test.ts` (CaseDetail.tsx, casedetail/shared.tsx,
  casedetail/StageTimeline.tsx must stay at 0 arbitrary text sizes; total ceiling 75).
- `src/soc/__tests__/bundle-first-paint.test.ts` (entry budget; motion off the entry path).
- `src/ui/__tests__/foundations.round12.test.tsx`, `src/ui/__tests__/sheet.test.tsx` ★.
- `src/lib/__tests__/docs-bundle.config.test.ts`, `src/soc/pages/__tests__/Docs.test.tsx`
  (Help Center pages incl. case-manager).

---

## 10. Docs and assets that change with a redesign

- `docs/analyst/case-manager.md` (387 lines): sections "The outcome of a case" (20),
  "Queue scope and ordering" (50), "Keyboard" (90), "Resize the desktop split" (112: 400/320/680/
  560 px, 24/48 px steps), "Read the workspace" (122: header line 1/2, the facts rail list, the
  7-tab table at 147-155, the "Each fact has one home" claim at 157), "Work the runbook" (176),
  "Single-case actions" (265: Take action contents), "Close or resolve with a disposition" (274),
  "Select cases and run bulk work" (296), "Authority and audit" (351), "Cases the agent closed"
  (371), "When to use the Cases page" (378). It does not embed the screenshot itself.
- `docs/assets/screenshots/case-manager.webp`: embedded in `README.md:163` and
  `docs/getting-started/quickstart.md:249`, both with the alt text "Case Manager with an escalated
  true-positive case selected: the Decision card, labelled Code, records why code escalated it,
  and the advisory AI assessment below gives the model's reading and confidence, above the
  investigation inputs." Recapture manually (no capture script in `scripts/`).
- Other user docs describing the workspace: `docs/analyst/cases.md:141` (Take action),
  `docs/analyst/collaboration.md` (Collaboration tab, "Open the Runbook tab"),
  `docs/analyst/investigation.md:126-152` (Runbook and Chat tabs), `docs/getting-started/first-case.md:65-74`
  (Overview/Timeline/Investigation tour), `docs/getting-started/demo.md`, `docs/USAGE.md`,
  `docs/intelligence/runbooks.md`, `docs/reference/permissions.md` (case grants).
- `docs/development/ui-standard.md` §"Queue and detail workspaces" (550-639) and §"Case
  investigation-input provenance" (641-661) describe the current header/rail/tab grammar; update
  them when the shared pattern changes ("do not let implementation and the document drift").
- Generated Help Center knowledge: `backend/app/knowledge/{app_docs,console_map,aliases,manifest}.json`
  must be regenerated after doc/console changes (`npm run gen:console-map`, then
  `scripts/build_app_knowledge.py`; CI runs `build_app_knowledge --check`).
- Journal.md entry and CHANGELOG `[Unreleased]` per AGENTS.md.

---

## 11. Risks and constraints for the redesign

1. **Shared surface:** the Overview dashboard and Investigate open the SAME CaseDetail as a
   Sheet; a Case Manager-only layout must keep the Sheet working (or deliberately change both).
2. **Test churn:** ~80 test files touch this surface; ★ source-text tests will fail on any
   markup move. Plan the test updates as part of each work package.
3. **Tab set is a cross-chunk contract:** `CASE_TABS` (entry), router `tab` deep links
   (`#/case_manager?caseId=…&tab=investigation` from the audit log "Open case trace"),
   Alt+1…7 shortcuts, `CaseDetail.tabs.test.tsx`, docs tables. Merging/removing a tab needs a
   redirect for old `tab=` values and costs entry bytes (77 B left).
4. **#3 and G1 must hold:** the close dialog never posts a model-derived disposition as declared;
   the picker opens empty; grading is a separate POST; `close_disposition` maps to `close`.
5. **#9:** all case strings stay text nodes; attachments (if added) need a safe image path
   (no SVG/HTML, size cap, server-side content-type check) and KV-only storage (#12, no new index
   or table); an image is untrusted data and must never reach a model prompt unfenced.
6. **Keyboard/focus contracts** are dense and tested (roving queue, focus after dialogs, title
   focus target, Details sheet focus, shortcuts blocked in dialogs). Keep `[data-case-title]`,
   `[data-queue-row]` and the separator semantics.
7. **Guard ratchets:** removing `PanelCard`/`tracking-tight` is welcome; adding `Panel` around
   content that still renders `PanelCard` violates "no Card inside a Panel" in spirit even where
   the per-file guard cannot see it.
8. **Dead code to delete safely:** panel `'default'` branches, unused `close`/`confirm_fp`
   ActionDefs, `HeadlinePanel`, `BriefChip`, the stale "footer" comments, `BULK_DISPOSITIONS`
   duplicate (use `DISPOSITION_OPTIONS`), risk cut-offs 74/48/22 in QueueRow (vs `scoreBand`).
