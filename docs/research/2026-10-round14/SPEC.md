# Round 14 SPEC: one console grammar, a dashboards library, an audit log you can use, rule drill-down and one Runbooks feature

Status: binding for every Round 14 work package. Owner: orchestrator. Branch: `claude/round14`
(Round 13 merged into `Testing`; Round 14 starts at commit `1cf20a7` on `claude/round14` and
reaches `Testing` through a pull request). Version stays `0.1.13` (no `VERSION` change in this
round; `CHANGELOG.md` gets an `[Unreleased]` entry, §9.3). Revised once after two adversarial
reviews (product safety, engineering); the resolutions are folded into the sections below and
the review notes are in Appendix A.

This document replaces nothing in `AGENTS.md`. Where it is silent, `AGENTS.md`,
`docs/development/ui-standard.md`, the Round 12 spec (`docs/research/2026-10-round12/SPEC.md`),
the Round 13 chat spec (`docs/research/2026-10-round13/SPEC-chat.md`) and the chat-revamp spec
(`docs/research/2026-10-chat-revamp/SPEC.md`, `BLOCKS.md`) stay binding. Every override of those
documents is listed in §9.4 and recorded in them by WP-DOC.

Inputs (the evidence base; read the parts your package cites):

- Synthesis: `docs/research/2026-10-round14/research/SYNTHESIS.md`, cited as **[S §n]**.
- Briefs in the same folder, cited by short name: **[audit]** `audit-log.md`, **[dash]**
  `dashboards.md`, **[drill]** `chat-drilldown.md`, **[small]** `small-asks.md`, **[nav]**
  `nav-animation.md`, **[uia]** `ui-audit-a.md` (findings X1 to X19), **[uib]** `ui-audit-b.md`
  (findings Y1 to Y13), **[rbi]** `runbooks-industry.md`, **[rbc]** `runbooks-codemap.md`.
- Prototype records (scratchpad, reference only, never merged):
  `SP/r14/options/<C>/final/INDEX.md`, `SP/r14/options/U1..U4-*.md`, `SP/r14/options/C6/NOTES.md`
  and the local branches `r14-proto-u1` (navigation), `r14-proto-u2` (surfaces, headers, Overview
  spacing, Settings), `r14-proto-u3` (audit, dashboards, rule and severity mocks), `r14-proto-u4`
  (runbooks mock), worktrees `SP/r14/wt/u1..u4`. Cited as **[P-C1]** to **[P-C11]**. Implementers
  may read the prototype code for measurements and copy; they rebuild the chosen option in the
  real components and never cherry-pick prototype commits.
- The operator's decision screenshot for C2: `SP/r14/operator/c2-decision-dashboards-library.png`.

`SP` is `/tmp/claude-0/-home-user-Kavach-AgenticSOC/2fc24c44-3228-5bc2-8fb3-56e1bc548beb/scratchpad`.
Third-party screenshots under `SP/r14/notes/rbshots/` are internal references and are never
committed.

Copy rule for every string in this document that reaches a screen: plain, specific, sentence
case, no em dashes, numbers with thousands separators, times in the viewer's display zone unless
the surface says UTC, only the product name "Agentic SOC", and never the word "playbook" in
Console-authored copy (§4.10.16 lists the wire identifiers that keep it; stored data shown
verbatim is exempt, §3.1).

---

## 1. Operator asks (Round 14)

Summarised from the research round (the synthesis quotes each brief's verbatim ask):

1. Ask 1. The automatic sign-out notice must not state how long the session lasted.
2. Ask 2. The Audit log must be something a person can open, filter and export.
3. Ask 3. "Create three default dashboards, the one we have currently, that is already the main
   screen default, but add 3 more default covering different aspects in the dashboards section
   ... per the best standards and practice in the industry."
4. Ask 4. Remove the two Overview band headers ("Alert flow", "Cases and response") and reclaim
   the space.
5. Ask 5. Triple the Chat assistant "Timeouts and capacity" defaults.
6. Ask 6. Clicking a detection rule shows that rule's picture ("like a dashboard or all alerts
   under that rule").
7. Ask 7. A severity breakdown a person can use (named levels, and at least the rule behind each).
8. Ask 8. UI polish everywhere, starting with the left navigation; the Overview's look is the
   standard for every page.
9. Ask 9. "Can we please merge playbooks and runbooks pls, too complicated, just remove both and
   redo runbooks from scratch ... per the best cybersecurity and how others do it standards."

The operator's closing instruction (binding on process): "Highest quality work, keep me updated
occasionally with work updates and screenshots of before and after side by side in a single image
too. Use sub agents for everything to ensure highest quality work, and best standards." §8.4 turns
this into the progress-screenshot contract.

---

## 2. Decisions

### 2.1 The operator's choices

| ID | Ask | Decision (binding) | Section |
|---|---|---|---|
| C1 | 2 | **A, side sheet.** A 560 px inspector from the right; non-modal from 1280 px so the list stays live; J and K move the record; full screen on a phone. The scope control (People and settings, Agent activity, All), the Export menu and the export dialog are part of the page. | §4.5 |
| C2 | 3 | **Changed from every prototype option: the Dashboards library (option 3), with the operator's rules.** The landing route and sign-in still open the Cyber Defence Center exactly as now. The left navigation's "Overview" entry opens the Dashboards library: a "Built-in" section with four cards and a "Yours" section with personal boards and a dashed "New dashboard" tile. The Cyber Defence Center card's badge reads "Default"; the other built-ins read "Built-in". Opening a card shows that board. | §2.2, §4.4 |
| C3 | 4 | **B, one panel gutter.** Both band headers removed; every Overview row one panel gutter apart (16 px, 20 px from 1280 px, 24 px from 1920 px); the moved information goes into the cards. | §4.3 |
| C4 | 6 | **A, rule sheet**, with "Open all N in Logs" (the exact filtered Logs view, option B) as its main action; every rule name in the Console opens it through one `RuleLink`. | §4.6 |
| C5 | 7 | **A plus B's control.** Named severity levels in a table with the top rules per level, rows expand to all rules, and a "Split by" control when the server returned more than one split. | §4.7 |
| C6 | 8 | **A, docked rail with a stable morph.** 64 px icon rail or 240 px labelled drawer, one explicit toggle, icons never move, hover never expands, flyouts with hover intent. | §4.8 |
| C7 | 8 | **1, panels everywhere.** Every module, table and list sits on the Overview's tinted borderless panel. | §4.9 |
| C8 | 8 | **1, title and controls only.** The page header carries the title, its controls and a help tip for explanations; the Overview header grammar on every page. | §4.9 |
| C9 | 8 | **A, grouped panels** in Settings. | §4.9.6 |
| C10 | 9 | **B, phased runbook** inside a case: phase tabs with counts, the Next step card pinned on top, and the same card on the case Overview tab. | §4.10.11 |
| C11 | 9 | **A, structured outline and step form** for writing a runbook, with Preview and Markdown Source toggles. | §4.10.12 |
| Ask 1 | 1 | Exactly the before and after in [S §2.13]. | §4.1 |
| Ask 5 | 5 | Exactly the before and after in [S §2.13]. | §4.2 |

### 2.2 The C2 change, worked out in full

This is the part of the round no prototype showed as one piece. Every rule below is binding.

1. **Landing stays.** After sign-in, at `#/`, at `#/overview`, at any unknown hash (today's
   `pageFromHash` fallback, `webui/src/soc/router.tsx:185-192`) and after the first-run wizard, the
   Console opens the Cyber Defence Center (the `overview` page rendered by `Home`) exactly as it
   does today. Its page id, route, title, header, content (apart from ask 4's spacing change, §4.3,
   and the shared primitives that apply to every page, §4.9) and top-bar breadcrumb ("Agentic SOC /
   Overview") do not change.
2. **The nav "Overview" entry opens the library.** The registry's `overview` group row gains a
   target: clicking it (labelled drawer or 64 px rail) navigates to `#/dashboards`, the library,
   and leaves the group's open or closed state as it was (the chevron alone opens and closes the
   children, so the drawer looks as the operator's screenshot shows: Overview active, its group
   collapsed unless the viewer opened it; E13).
   A new optional `FeatureNode.target?: PageId` field carries this ("the page this row opens when
   it is pressed; defaults to the row's own id"). Only the Overview row sets it this round.
   Viewers without `metrics:view` cannot open the library, so for them the row's target falls back
   to `overview` (the Cyber Defence Center) and the Dashboards child is hidden, exactly as the
   Dashboards item is hidden today.
3. **Children of the Overview group** (labelled drawer, flyout and phone sheet, in this order):
   "Cyber Defence Center" (the existing child id `dashboard`, renamed from "Dashboard"),
   "Dashboards" (`dashboards`, gated on `metrics:view`), "Standup" (`standup`). `FeatureChild`
   gains the same optional `target`; the `dashboard` child sets `target: 'overview'`, so it
   navigates to `#/overview`, and a child is current when the page equals its target (or its id
   when it has none). The hash `#/dashboard` keeps resolving and is normalised to `#/overview` with
   `history.replaceState`, so the landing page has one URL.
4. **Routes and deep links** (all hash routes; validators in the router's `DEEP_LINK_KEYS`):

   | URL | Shows |
   |---|---|
   | `#/`, `#/overview`, `#/dashboard` (normalised) | Cyber Defence Center (landing, default) |
   | `#/dashboards` | The Dashboards library |
   | `#/dashboards?board=builtin:soc-operations` | SOC operations board |
   | `#/dashboards?board=builtin:detection-data-health` | Detection and data health board |
   | `#/dashboards?board=builtin:executive-summary` | Executive summary board |
   | `#/dashboards?board=builtin:cyber-defence-center` | Normalised to `#/overview` (replace) |
   | `#/dashboards?board=<personal id>` | That personal board in view mode (`overview` is "My dashboard") |
   | `#/dashboards?board=u:<sha8>` | A personal board stored before Round 14 whose id is reserved or fails `NAV_ID` (see below) |
   | `#/dashboards?board=new` | The builder in Edit mode on an unsaved draft (§4.4.6) |

   `board` validates with the existing `NAV_ID` grammar (`/^[\w.:-]{1,128}$/`); empty keys are
   omitted from every hash (as `pageHash` does today), never written as `board=`. A `board` value
   that names no visible board (unknown, hidden by role, deleted) shows the library with a toast
   "That dashboard is not available." and the URL is replaced with `#/dashboards`. `new`, `u:*`
   and every `builtin:` id are reserved: the server rejects **creating** a personal board whose id
   is `new` or starts with `builtin:` or `u:` (`400 dashboard_id_reserved`). Boards stored earlier
   are free strings today (`routes_dashboards.py` `_sanitize_layout` keeps any id), so updates,
   rename, duplicate and delete of an existing stored board keep working whatever its id: a stored
   board whose id is reserved or fails `NAV_ID` is listed and linked under the alias
   `u:<first 8 hex of SHA-256 of its id>` (the client resolves the alias against the loaded list;
   the server API still addresses it by its stored id).
5. **The brand (home) link** in the rail and the phone sheet goes to `#/overview`, the Cyber
   Defence Center, as today.
6. **Breadcrumbs (top bar).** The breadcrumb keeps today's one-leaf form except on a board:

   | Route | Breadcrumb |
   |---|---|
   | Cyber Defence Center | "Agentic SOC / Overview" (unchanged) |
   | Library | "Agentic SOC / Dashboards" |
   | A board | "Agentic SOC / Dashboards / SOC operations", where "Dashboards" is a link to `#/dashboards` and the board name is the current page (`aria-current="page"`) |

   The board segment truncates with the full name in `title`; below the top bar's 46 rem
   container tier only the board name shows (the product name already folds there today).
7. **Returning to the library from a board**: an "All dashboards" link (ArrowLeft glyph, 13 px,
   `text-primary`, focusable, first element of the board's page header) above the board title,
   rendered through the one sanctioned C8 exception, `PageHeader back={{label, href}}` (§4.9.3;
   the guard test allows `back=` and nothing else of the removed props); the
   breadcrumb's "Dashboards" segment; the nav's "Dashboards" child; the browser Back button (board
   selection is a `pushState` navigation, so Back returns to the library). Leaving a personal board
   with unsaved edits asks first ("Discard changes to My dashboard?", Discard / Keep editing), as the
   builder does today.
8. **Where the personal builder lives**: inside the board page. A personal board opens in view
   mode; its header carries "Edit" (primary outline button). Edit mode is today's
   `DashboardBuilder` edit surface (widget gallery, keyboard move and resize, Save, Discard, Reset to
   default layout for "My dashboard", Delete dashboard for others), loaded lazily with
   `react-grid-layout` only in Edit mode, as today. "New dashboard" (the library header button and
   the dashed tile) opens `#/dashboards?board=new`. "Duplicate to customise" on a built-in creates a
   personal copy and opens it in Edit mode (§4.4.6).
9. **What the nav highlights**:

   | Route | Labelled drawer | 64 px rail | Phone sheet |
   |---|---|---|---|
   | `#/overview` | "Overview" row tinted as the active group; when the group is open, child "Cyber Defence Center" is current | Overview icon tinted (current-page pill) | Overview group open (the sheet opens the current page's group, as today), "Cyber Defence Center" current |
   | `#/dashboards` (library) | Group active; when open, child "Dashboards" current | Overview icon tinted | "Dashboards" current |
   | `#/dashboards?board=*` | Group active; when open, child "Dashboards" current | Overview icon tinted | "Dashboards" current |
   | `#/standup` | Group active; when open, child "Standup" current | Overview icon tinted | "Standup" current |

   **`aria-current` rule** (today's `NavSidebar.tsx:340-347, 515-516` rule, kept): exactly one
   element in the nav landmark carries `aria-current="page"`: the current child when the child list
   is rendered (drawer group open, flyout open, phone sheet), otherwise its group row (drawer group
   closed) or its rail icon (64 px rail, flyout closed). The flyout marks the same child current
   while it is open.
10. **Page header (C8 applies).** The library header is the title "Dashboards", a help tip beside
    the title, and one action on the right: "New dashboard" (outline button with a Plus glyph). The
    screenshot's description line ("Built-in boards for each role, and the ones you made.") is
    **not** kept as a line: under C8 1 explanations move into the help tip, whose text is
    "Built-in boards for each role, and the ones you made. Built-in boards are read-only; duplicate
    one to make it your own." The operator's other words stay where the screenshot puts them: the
    "Built-in" section title with its aside "Read-only. Duplicate one to make it your own." The icon
    chip shown beside the title in the screenshot is also dropped (C8 removes it on every page).
    A board's header is its name, the "Built-in" or "Yours" badge and the help tip ("For SOC
    managers and shift leads. Is the team keeping up today?") beside the title, the board's
    `TimeRangePicker` and `RefreshButton` in the controls slot, and the board actions on the right
    (§4.4.5).
11. **Order and names.** Built-in, left to right: Cyber Defence Center (badge "Default", window
    "Last 24 hours", "The landing page: alert flow, case state and response time right now.", "For
    everyone"), SOC operations ("Built-in", "Last 24 hours", "Is the team keeping up today?", "For
    SOC managers and shift leads"), Detection and data health ("Built-in", "Last 7 days", "Are we
    seeing everything, and are the detections any good?", "For detection engineers and platform
    admins"), Executive summary ("Built-in", "Last 30 days", "Are we safer and faster than last
    month, and what does automation cost?", "For the CISO and leadership"). The per-role default
    personal board is renamed "My dashboard" (id `overview` kept so saved copies still match).
12. **The Cyber Defence Center card** is a link to `#/overview`. It cannot be hidden, duplicated or
    edited (it is a hand-built page, not a widget board), so its card has no menu.
13. **Command palette and generated maps.** The command palette (derived from `FEATURES`) lists
    "Cyber Defence Center" opening `#/overview` and "Dashboards" opening `#/dashboards`; the palette
    and `npm run gen:console-map` apply `target` the same way the nav does, so the console map emits
    the nav paths "Overview > Cyber Defence Center" and "Overview > Dashboards" and chat app-help
    answers ("Open Overview from the left navigation") name the destination they actually reach.
14. **Confirmation with the operator.** E1 (no description line, no icon chip) and E13 (pressing
    the row does not expand the group) are the two places the build departs from, or reads more
    into, the screenshot. The first Wave C progress update (§8.4) shows both as BEFORE and AFTER
    crops next to the operator's screenshot so the operator can overrule them before Wave D.

### 2.3 Accepted defaults ([S §2.14], every proposed default accepted)

| ID | Ask | Default (binding) |
|---|---|---|
| D1 | 1 | Keep "Sign in to continue." after each notice (option 1A). |
| D2 | 1 | Keep sending `lifetime_seconds` from `/auth/me`; the Console ignores it (documented). |
| D3 | 1 | Keep the Remember me hint ("Stay signed in on this device for up to 24 hours"): a disclosure before opting in. |
| D4 | 2 | Default scope: People and settings. |
| D5 | 2 | New permission `audit:export`, granted by default to super admin, SOC manager and auditor. |
| D6 | 2 | Fresh sign-in before an audit export. |
| D7 | 2 | Formats CSV and JSON Lines; 100,000 rows per file; streaming to a SIEM is later (ROADMAP). |
| D8 | 2 | Searching or opening the audit log is recorded, coalesced to one row per user per distinct filter set per 5 minutes. |
| D9 | 2 | Client IP and user agent are captured on new rows and documented as personal data. |
| D10 | 2 | Times in UTC in the table header, with a per-viewer local toggle. |
| D11 | 2 | Demo Mode shows real sign-ins and admin changes beside demo agent rows, each labelled. |
| D12 | 3 | Names and windows: "SOC operations" 24 h, "Detection and data health" 7 d, "Executive summary" 30 d. |
| D13 | 3 | Four boards listed: the landing page plus three new ones. |
| D14 | 3 | A built-in can be hidden per user; "Set any board as my landing page" is later. |
| D15 | 3 | AI spend on the Executive board, only for viewers with `cost:view`. |
| D16 | 3 | With row-level data scope on, case-derived built-in panels are hidden until aggregates respect scope. |
| D17 | 4 | Short window captions on the flow and Response time titles ("last 24 hours"). |
| D18 | 5 | Move the model call timeout in Bounded mode too. |
| D19 | 5 | Do not triple the client's 5-minute wait for a free chat slot. |
| D20 | 5 | Cap the report AI summary wait below the Web UI proxy's 300 s now. |
| D21 | 6 | The rule sheet opens from every place a rule appears, through one `RuleLink`. |
| D22 | 6 | Both the log-events and the cases severity breakdowns get the fix. |
| D23 | 7 | Show `High (8)` for sources whose scale is not 0 to 100, as the Logs page does. |
| D24 | 8 | Hover never expands the rail. |
| D25 | 8 | One name per page: "Sources", "Help Center" (the nav item is renamed), "Baseline", "Models". |
| D26 | 8 | Permanent explanation boxes (Detection rules, Baseline, Memory, Secret keys, SLA) become help tips; callouts only for live warnings. |
| D27 | 8 | Retire the hidden Automated scans page; `#/scans` redirects to Case Manager filtered to agent-closed cases. |
| D28 | 8 | Users, Roles and Sessions stay inside Settings, without their own page headers. |
| D29 | 8 | Campaigns show a derived label (entity and case count) instead of the hash. |
| D30 | 8 | "Discounted inference" moves from Jobs to Settings. |
| D31 | 8 | The navigation timings become the standard for other side panes. |
| D32 | 9 | Auto-attach the matching runbook to cases that need a person: on. |
| D33 | 9 | "Generic incident (NIST 800-61)" runbook attaches when nothing else matches: on. |
| D34 | 9 | Closing by hand with required steps open asks for a short reason, audited; never blocks. |
| D35 | 9 | Publishing needs `runbooks:publish`; "approver must differ from author" and per-step approvals exist, off by default. |
| D36 | 9 | Free-form Case tasks move into the runbook checklist as "Other tasks". |
| D37 | 9 | Library scope: the 12 runbooks of §4.10.14 now; denial of service, vulnerability disclosure and cryptomining later. |
| D38 | 9 | Migrated operator content: valid content stays Published with an "Imported" badge and an immediate review date; invalid content becomes Draft. |
| D39 | 9 | Edits create a Draft; only Published text is trusted by the AI. |
| D40 | 9 | "Draft a runbook from this closed case" is a later round. |
| D41 | 9 | No ASP-style "Run" menu of AI jobs on a case; lookups live inside runbooks; Reinvestigate stays. |
| D42 | 9 | CACAO JSON export later; Markdown export now. |
| D43 | 9 | Matching on MITRE techniques and tags too, with a second evaluation after the verdict. |
| D44 | 9 | Old routes and pages stay as aliases for one release, then are removed. |
| D45 | 9 | Demo Mode honours runbooks: the demo pipeline gets the same library. |

### 2.4 Decisions this spec makes that the operator did not state

Each is recorded so a reviewer can challenge it; none touches a non-negotiable.

- **E1 (C2) No description line on the library.** C8 1 moves the screenshot's description into
  the help tip and drops the icon chip; the section notes and card text stay (§2.2 item 10).
- **E2 (C2) Breadcrumb on the landing page unchanged** ("Agentic SOC / Overview"), because the
  operator said the landing stays as it is; boards gain a three-part breadcrumb (§2.2 item 6).
- **E3 (C2) "Dashboard" nav child renamed "Cyber Defence Center"** so the group no longer lists
  "Dashboard" next to "Dashboards" (D25, one name per destination).
- **E4 (C2) `board=` deep-link key and reserved ids** `new`, `u:*` and `builtin:*`, rejected on
  create only, with an alias for older stored boards (§2.2 item 4).
- **E5 (C10) Fallback runbook on.** The final prototype showed the Generic incident fallback off;
  accepted default D33 turns it on. The UI shows "Fallback" as the attachment reason.
- **E6 (C11) Review cadence default 180 days** for operator runbooks ([rbi §8.2]); the prototype's
  90-day figure was illustrative. Configurable per runbook (30 to 730 days).
- **E7 (ask 9) Runs live in a per-case KV document plus a month-sharded run ledger written only
  on run-level transitions**, and free-form
  Case tasks keep their store and render as "Other tasks" (no data migration of tasks) (§4.10.6).
- **E8 (ask 9) `runbooks:run` is granted by default to every role except auditor**, because
  working the checklist is the analyst's core task; `playbooks:run` maps to it in every stored
  grant layer. Every stored layer that grants `runbooks:manage` or `playbooks:manage` (the
  `roles` and `resources` overrides and custom roles, in Preferences and the KV store) also grants
  `runbooks:publish`, so no role silently loses its ability to make text trusted; a stored deny is
  mapped the same way, so no role silently gains one either (§3.7).
- **E9 (ask 9) Migration runs at startup**, idempotent, behind a marker document, audited as the
  system actor `runbook_migration`; it is not a Job because no person starts it (§4.10.17).
- **E10 (ask 9) Prompt budget 3,000 characters** for the investigator's runbook rendering,
  enforced at publish for operator runbooks and by a test for each bundled runbook (§4.10.9).
- **E11 (ask 8) Entry bundle.** The orchestrator, not a package, rebases `PRE_REVAMP_ENTRY_BYTES`
  at most once, after WP-0, W1, W2a and W3 are all committed, with per-file before and after
  deltas and a written justification in the test, the records of §3.4 and the Journal, as Round 13
  did; the 400,000 B ceiling never moves (§3.4, §8.2).
- **E12 (ask 2) Audit record ids** are opaque, store-prefixed strings (`es:<index>:<_id>`,
  `sql:<row id>`, `mem:<n>`, and `demo:` before any of them for Demo store rows).
- **E13 (C2) Pressing a group row navigates and never expands or collapses the group**; the
  chevron alone does (the screenshot shows Overview active with its group collapsed). The phone
  sheet keeps today's rule of opening the current page's group when the sheet opens (§2.2 items 2
  and 9, §4.8.1).
- **E14 (ask 9) Old HTTP routes for one release (D44): reads stay as aliases, writes answer
  `410`.** `GET /api/playbooks`, `GET /api/playbooks/{id}` and the old `/api/runbooks` list and
  detail shapes (`?shape=v1`) keep answering from the new library for one release; old-shape writes
  and `POST /api/cases/{id}/run-playbook` answer `410 runbooks_moved`, because a write in the old
  shape cannot be honoured without bypassing Draft and review (#9). The deviation is named in the
  upgrade notes and in the first Wave A progress update (§4.10.16).
- **E15 (ask 2) The client IP is believed from a forwarded header only when the request came
  from a named trusted proxy** (`TRUSTED_PROXIES`, default the existing Web UI service name, so the
  frozen compose base needs no edit; §4.5.3), and then only its rightmost entry; the raw header is
  kept beside it as untrusted.
- **E16 (all) Audit before visible.** Every new state change appends its audit row before the
  store write becomes visible, and a failed store write appends a failure row; there is no
  "write, then audit, then roll back" path (§3.6).

---

## 3. Shared contracts (every package)

### 3.1 Copy, tokens, type

- Copy follows the rule at the top of this document. New strings are listed in each section's
  copy table and in the Help Center page that owns the surface. A test per package asserts no new
  string contains an em dash (U+2014), an en dash used as punctuation (U+2013), or the word
  "playbook" in Console-authored copy (labels, headings, help tips, empty states, toasts, dialog
  text, friendly names in tables).
- **Stored data is shown verbatim and is exempt** (AU-7: an audit tool never alters what it
  reports): raw records and the Record section of the audit inspector, stored chat transcripts,
  notes, case activity payloads and runbook text keep whatever words they hold. Legacy tokens get a
  Console-authored friendly name where a list shows them (`playbook_selector` shows as "Runbook
  selector (before Round 14)", `run_playbook` as "Runbook automation (before Round 14)",
  `ActionType.PLAYBOOK` as "Runbook (before Round 14)") while Raw record and Record keep the stored
  value. The rendered-text test runs over Console-authored strings and over fixtures that contain no
  stored legacy data; a separate test asserts a legacy row's raw token is shown unchanged in Raw
  record.
- The word "playbook" may appear in the Help Center only where an upgrade needs it: the Round 14
  notes in `docs/operations/upgrades.md`, one "Coming from an earlier version" paragraph on the
  runbooks page, and the alias list in `docs/reference/api.md` and `docs/reference/permissions.md`.
  Console-authored UI copy never shows it.
- Colours come only from the tokens in `webui/src/styles/theme.css` through Tailwind and from
  `webui/src/soc/components/palette.ts`. No new colour token, brand token, blur, resting shadow or
  motion token is added in this round (the Round 13 rules). The one approved token change is the
  Low severity hue if the palette owner (WP-W2) can separate it from the link blue while keeping
  every measured WCAG AA pair green in `npm run gates`; otherwise it stays and is listed in §10.
- Type: Inter for text, JetBrains Mono only for identifiers, queries, raw records and code. Body
  text is proportional (`theme.css:336` changes to `proportional-nums`); tabular figures are set on
  numeric surfaces only (table cells, KPI numerals, timestamps, meta rows, `TimeRangePicker`).
  Nothing below 11 px except the badge primitive.

### 3.2 Motion

- One vocabulary: `ease-standard` (`cubic-bezier(0.2,0,0,1)`), 200 ms for opening panes and
  drawers, 160 ms for closing, 150 ms for chevrons, flyouts and menus, 120 ms for tooltips. No
  `ease-premium` in the navigation. Side panes (chat history rail, report panel, inspectors, rule
  sheet) adopt the same timings (D31).
- Animate `transform` and `opacity` only. Reduced motion: layout changes are instant; overlays
  cross-fade with opacity only (today's `theme.css:1518-1529, 1623-1636` behaviour, kept).

### 3.3 Accessibility (binding for every UI change)

- WCAG 2.2 AA: contrast measured in both themes by `npm run gates`; focus order follows reading
  order (SC 2.4.3); every interactive element has a visible focus ring on its own surface (on a
  panel the ring offset uses the panel colour, no white halo); targets at least 24 by 24 px
  (44 px on phones for primary row actions); status never by colour alone (text or glyph with it).
- Keyboard: every list that supports J and K also supports Up and Down; single-letter shortcuts
  never fire inside a text field, a menu or a dialog; Esc closes the topmost layer and returns focus
  to the element that opened it.
- Screen readers: page `h1` is the page title; each module is a labelled region (`section
  aria-labelledby` its `h2`); live counts and step changes are announced in a polite live region.
- Disclosure and navigation semantics: a control that opens a flyout or popup carries
  `aria-haspopup`, `aria-expanded` and `aria-controls` naming the popup, and the popup is a
  labelled list or menu; a control that navigates is an `<a href>`, never a `button` that changes
  the hash; decorative previews (outline thumbnails, sparklines with a text equivalent) are
  `aria-hidden`; a status shown as a dot or colour has the same fact in the accessible name ("1
  waiting"); hit and focus boxes match the visible control (no 224 px boxes clipped to a 56 px
  rail).

### 3.4 Shell and entry bundle

- **Measured today** (Journal, the PR 132 flap fix, unchanged on every prototype branch): the
  entry chunk is **371,876 B** against a budget of 372,027 B (`PRE_REVAMP_ENTRY_BYTES` 371,003 B
  plus 1,024 B): **151 B of headroom**. The 400,000 B ceiling never moves.
- **Entry modules** (anything they import statically ships at first paint): `App.tsx`,
  `AppShell.tsx`, `NavSidebar.tsx`, `router.tsx`, `registry.tsx`, `nav.ts`, `nav-types.ts`,
  `auth.tsx`, `pages/Login.tsx` and `pages/Wizard.tsx` (both eager), `ui/sheet.tsx` (AppShell),
  `lib/api.ts` (one object literal that `App.tsx` imports, so every method added to it ships in the
  entry), `lib/format.ts` (AppShell imports `humanizeToken`), `lib/useEventStream.ts`
  (`STREAM_CHANNELS`), the `@/design-system` index as far as AppShell imports it, and the
  chat-activity store. Every new feature body, sheet, inspector, editor and widget is `React.lazy`.
- **New client calls never go into `api.ts`.** WP-0 puts every new Round 14 client call in
  modules that only lazy pages import: `webui/src/lib/api-audit.ts`, `api-runbooks.ts`,
  `api-dashboards.ts` and `api-rules.ts` (each a small set of functions over the existing request
  helper). Only new optional parameters on existing `api.ts` methods stay in `api.ts` (they add a
  few bytes and are counted). New TypeScript mirrors live in type-only modules
  (`webui/src/lib/types-runbooks.ts`, `types-audit.ts`, `types-dashboards.ts`), which cost no
  bytes.
- **Platform keys.** `isApplePlatform` and `keyLabel` move from `chat/shortcuts/shortcut-list.ts`
  into a tiny entry-safe module `webui/src/lib/platform-keys.ts`, which the shortcut list
  re-exports; NavSidebar and AppShell import only that module (importing the shortcut list would
  pull `CHAT_SHORTCUTS` into the entry).
- **One rebase, by the orchestrator** (E11): after WP-0, W1, W2a and W3 are all committed, the
  orchestrator builds, measures the entry chunk, and if it exceeds the budget rebases
  `PRE_REVAMP_ENTRY_BYTES` once with per-file deltas (bytes each package added). The rebase changes
  `bundle-first-paint.test.ts`, repoints
  `backend/tests/test_docs_round12_records.py::test_round12_entry_bundle_item_records_the_rebased_baseline`
  to a new "Entry bundle" item in this spec's §11.1 (the Round 12 SPEC §7.3 bullet gains one
  sentence pointing here, so its other assertions keep holding), and writes the Journal entry.
  Until then each of those packages builds and reports its own entry delta, and none rebases.
- **After the rebase**, every package that touches an entry module (W9b on Login and Wizard, A7c
  on the `STREAM_CHANNELS` hunk, W3 if it returns to the shell) builds and measures inside the
  remaining budget; going over is a finding for the orchestrator, never a second rebase.

### 3.5 Demo Mode

Every read that has a Demo store reads it while Demo Mode is on, keyed on the Round 13 Demo
identity token (PR 132) so a toggle never shows real figures under the Demo badge or the reverse.
Every new surface works in Demo Mode with no live model (the Demo planner in
`backend/app/engine/demo_chat.py` and the demo pipeline in `engine/demo_runtime.py` emit the same
blocks, links and runbook behaviour). Writes to Demo-swapped stores land in the Demo store and
vanish when Demo Mode ends; writes to real stores stay real, as the table says.

Every new or touched store, its Demo behaviour, and the audit sink of each writer:

| Store or state | In Demo Mode | Writes in Demo Mode | Audit sink |
|---|---|---|---|
| `runbook_library` (library, versions, migration marker) | real, **read-only**: the Demo pipeline and matcher read the real library (D45); every write returns `409 runbook_demo_readonly` and the editor shows "Runbooks cannot be edited in Demo Mode." | none | `control_audit` (writes outside Demo Mode only) |
| `runbook_runs` (per-case runs, ledger) | Demo-swapped (Demo cases have Demo runs) | land in the Demo store | the Demo audit |
| Personal dashboards (`DashboardStore`), `UserPrefs` (`dashboards_hidden`, `dismissed_intros`, nav state) | real, as today (not Demo-swapped) | real | `control_audit` |
| Cases, case tasks, case activity | Demo-swapped, as today | Demo store | the Demo audit |
| Audit reads (`audit_view`), audit export (`audit.export_*`), job artifact downloads (`job.artifact_downloaded`), sign-ins, settings, users and roles | real | real | **always `control_audit`**, whatever the Demo state |

Rule for every writer: a change to real state writes to `control_audit`; a change to Demo state
writes to the Demo audit (`state.audit` is the Demo audit while Demo Mode is on, `state.py`, so
writers of real state name `state.control_audit` explicitly). A test per new writer asserts the
sink with Demo Mode on and off. The audit log's People and settings scope in Demo Mode merges the
Demo store's human rows (case work on Demo cases) with the real control rows, the Demo ones
labelled "Demo" (§4.5.5).

### 3.6 Auditing helper

Every new state change is **audited before it becomes visible** (E16, the jobs registry's
audit-before-visible rule). A shared helper `audited_write(state, *, sink, action, target,
expected_revision, changes, write)` (new, `backend/app/audit/write.py`, owned by A4a) does, in
order:

1. Pre-checks that cost nothing and change nothing (grant, validation, the stale-revision check
   against a fresh read). A pre-check failure returns its error and writes **no** row (nothing was
   attempted).
2. Appends the action row (the record additions of §4.5.3, `outcome="success"`, `target` naming
   the target and the revision it will create, the request id). A failed append returns
   `503 audit_unavailable` and nothing changes.
3. Performs the store write (strict CAS on the expected revision, §4.10.6). If it fails, appends a
   failure row with the action `<resource>.<verb>_failed` (for example `runbook.publish_failed`,
   matching the `action` grammar), `outcome="failure"`, the same request id and the reason, and
   returns the store's error (`409 runbook_conflict`, `503 runbook_store_unavailable` and so on).
   Readers pair the two rows by request id: the inspector shows the action row with "Not applied
   (see the next record)".
4. Only then publishes the SSE frame and returns the response (the Round 3 rule: frames are
   published after save).

There is no "where it cannot be rolled back the response says so" path: success is never returned
without its row. Known limit, documented in `docs/administration/audit-log.md`: a process crash
between steps 2 and 3 leaves an action row whose revision was never written; the inspector shows
the row's target revision, and a reader can see it does not exist. This applies to every new
writer (runbook library transitions, runs and steps, dashboards, `UserPrefs.misc` writes made by
new UI, role and permission writes, settings writes including `PUT /api/settings` and every
curated settings route, audit export, artifact downloads). The existing best-effort settings
audit (`routes.py:1730-1744`, "never fail the settings save") becomes audit-first under this rule;
A4b-1 rewrites the tests that pin the best-effort behaviour to pin the new one. Test (A4a): with an
audit store whose append fails, nothing changes, the response is 503, and the runbook matcher never
sees the would-be version.

### 3.7 Permissions summary (new and changed)

| Resource:action | New or changed | Default holders |
|---|---|---|
| `audit:export` | new | super_admin, soc_manager, auditor |
| `runbooks:read` | unchanged | every role |
| `runbooks:run` | new | super_admin, soc_manager, analyst_tier2, analyst_tier1, responder |
| `runbooks:manage` | unchanged meaning (author drafts, duplicate, retire, import) | super_admin, soc_manager |
| `runbooks:publish` | new | super_admin, soc_manager |
| `playbooks:read`, `playbooks:run`, `playbooks:manage` | kept as accepted aliases on load in every grant and deny layer, mapped to `runbooks:read`, `runbooks:run`, `runbooks:manage` (+ `runbooks:publish` for `manage`, E8); no longer listed in the matrix UI | (mapped) |

**Sequence** (each step leaves every route and tool gate that exists at that moment working):

1. **WP-0** adds only the new actions and holders: `"runbooks": ["read", "run", "manage",
   "publish"]`, `"audit": ["view", "export"]`, and the default holders above. `"playbooks"` **stays
   in `RESOURCES`** with its current actions, because `/api/playbooks*`
   (`routes.py:2728-2919`), run-playbook (`routes.py:6851`) and `list_playbooks`
   (`chat_tools/intel.py:493`) still gate on it, and `_clean_actions` and `_SUPER_ADMIN` derive
   from `RESOURCES`.
2. **A7a** adds `policy.normalise_grants()` and `normalise_denies()` (alias rewrites only;
   `playbooks` still present).
3. **A8c** removes `"playbooks"` from `RESOURCES` and the default matrix, once a grep test proves
   no route, tool or Console gate names it.

**Where the alias applies: every grant layer.** `normalise_grants()` runs on load and on every
write of: the default matrix; `Preferences.rbac.roles` (REPLACE semantics per role);
`Preferences.rbac.resources` (the additive layer); `Preferences.rbac.denies`; each custom role's
`grants` and `denies`, in Preferences and in the custom role KV store (`stores/custom_roles.py`);
and every body `routes_roles.py` accepts (`:111, 198, 330` never drop them silently). Mapping:

| Stored | Becomes (unioned with any `runbooks` entry already in the same map, never replacing it) |
|---|---|
| grant `playbooks:read` | `runbooks:read` |
| grant `playbooks:run` | `runbooks:run` |
| grant `playbooks:manage` | `runbooks:manage` and `runbooks:publish` |
| grant `playbooks:*` | `runbooks:*` |
| grant `runbooks:manage` (any layer, stored before Round 14) | also `runbooks:publish` (E8) |
| deny `playbooks:read` / `run` | deny `runbooks:read` / `run` |
| deny `playbooks:manage` or `runbooks:manage` | also deny `runbooks:publish` |
| deny `playbooks:*` | deny `runbooks:*` |

The rewrite runs **before** `_clean_actions` and `_apply_denies`, which silently skip unknown
resources (`policy.py:248-306`), so a stored deny is never dropped and never turns into a silent
privilege gain. The "stored before Round 14" publish grant is applied once and stamped
(`rbac_grants_version: 2` beside the stored map), so an administrator who later removes
`runbooks:publish` from a role keeps that choice. Tests (A7a): a stored deny of `playbooks:run`
leaves the role without `runbooks:run`; a `roles` override holding both `playbooks` and
`runbooks` keys unions them; a `resources`-layer grant of `playbooks:manage` yields publish; a
deny of `playbooks:manage` also denies publish; the stamp makes a later removal stick; and (A8c)
every role's effective matrix, apart from the removed `playbooks` entry, is equal before and after
`playbooks` leaves `RESOURCES`.

---

## 4. Behaviour contracts, per ask

### 4.1 Ask 1: no duration in the automatic sign-out notice

#### 4.1.1 Wording (one table, `webui/src/soc/components/auth/rememberMe.ts` `signedOutNotice`)

| Reason | Before | After |
|---|---|---|
| `absolute_expired` (standard or remembered; from `/auth/me` or from the device marker) | "For your security, you were signed out after 12 hours. Sign in to continue." | "For your security, you were signed out. Sign in to continue." |
| `idle_expired` | "For your security, you were signed out after a period of inactivity. Sign in to continue." | unchanged |
| `revoked` | "This session was ended from another device or by an administrator. Sign in to continue." | unchanged |
| `tv_mismatch` | "All of your sessions were signed out. Sign in to continue." | unchanged |
| any other non-empty reason (the union is open, `webui/src/lib/types.ts:51-56`) | no notice | "For your security, you were signed out. Sign in to continue." |
| empty or absent reason | no notice | no notice |

#### 4.1.2 Code contract

- `signedOutNotice(reason: string | null | undefined): string | null` loses its second
  parameter and the duration branch (`rememberMe.ts:189-190`). The "your session ended" variant
  (`:191`) is removed; both absolute cases use the neutral sentence.
- The remembered-session device marker `soc.login.rememberedUntil` is written as `{ until }` only;
  `takeExpiredRememberedSession()` keeps accepting an old `{ until, lifetime }` value and ignores
  `lifetime`. Its return type becomes `{ expired: true } | null`.
- Removed: `SessionEnded.lifetimeSeconds` (`webui/src/soc/auth.tsx:28-34, 173-179`), the
  `lifetimeSeconds` prop of `SessionEndNotice` (`RememberMeControls.tsx:240-248`), the plumbing in
  `Login.tsx:459-466, 809-813`. Comments quoting "after 24 hours" (`auth.tsx:163`,
  `routes.py:3574`, `auth/tokens.py:77`) are reworded without a duration.
- Kept: `formatRememberDuration` and `formatRememberWindow` for the Remember me hint and the
  administrator's session policy editor (`SessionPolicyEditor.tsx:338, 359, 628`); `/auth/me`
  keeps emitting `lifetime_seconds` (D2); WP-DOC adds to `docs/reference/api.md:94-97` that the
  Console does not show it (§9.1; `api.md` is WP-DOC's file).
- Accessibility: unchanged (`SessionEndNotice` stays a polite live region linked to the focused
  field with `aria-describedby`).

#### 4.1.3 Tests

- `webui/src/soc/__tests__/login.remember.test.tsx:761-799`: the two `absolute_expired` rows
  (86,400 s and 21,600 s) and the "ran out while the browser was closed" case expect the neutral
  sentence.
- New regression: for every reason in `{absolute_expired, idle_expired, revoked, tv_mismatch,
  "future_reason", ""}` and every lifetime in `{0, 60, 3600, 21600, 86400, 604800}`, the notice
  contains no digit and none of the words hour, hours, minute, minutes, day, days, week, weeks.
- A marker written by the previous build (`{until, lifetime}`) produces the neutral notice once.
- `backend/tests/test_remember_me.py:974, 984` stay green unchanged.

### 4.2 Ask 5: triple the chat "Timeouts and capacity" defaults

#### 4.2.1 Values (`backend/app/config.py` `ChatAgentConfig`, `:1644-1682`)

| UI label | Key | Default before | Default after | Bounds before | Bounds after |
|---|---|---|---|---|---|
| Lookups at once | `max_parallel` | 4 | 12 | 1 to 8 | 1 to 24 |
| Lookup timeout | `tool_timeout_s` | 15 s | 45 s | 1 to 120 | 1 to 120 |
| Model call timeout | `model_step_timeout_s` | 300 s | 900 s | 5 to 900 | 5 to 1,800 |
| Questions at once per user | `max_concurrent_turns_per_user` | 4 | 12 | 1 to 10 | 1 to 24 |
| Questions at once in total | `max_concurrent_turns_global` | 16 | 48 | 1 to 100 | 1 to 100 |

#### 4.2.2 Migration (`chat_limits_version` 2)

- `CURRENT_CHAT_LIMITS_VERSION = 2`; the field's `le` follows it.
- `_migrate_chat_limits` becomes staged: run the version 1 step when the stored version is below 1,
  then the version 2 step when it is below 2, then stamp 2. A block at version 2 is never
  re-decided.
- Version 2 step, persisted blocks only (`_CHAT_PERSISTED_MARKERS`), in both limits modes (D18):
  for each key in the table, move the value to the new default only if it equals the old default
  exactly; any other value is the administrator's choice and stays. A pre-Round-12 block
  (`model_step_timeout_s` 30, per user 2, global 8) chains to 300 / 4 / 16 in step 1 and to
  900 / 12 / 48 in step 2. A Bounded block that kept 30 s in Round 12 stays at 30 s.
- `_repair` (`config.py:1727-1812`) clamps to the new bounds; programmatic construction (for
  example `ChatAgentConfig(model_step_timeout_s=30)` in code) is untouched.
- Known limitation, documented: an administrator who deliberately chose exactly the old defaults
  cannot be told apart and is moved once.

#### 4.2.3 Knock-on changes

- `routes_chat.py:1702-1703` fallbacks `or 4` and `or 16` become `or 12` and `or 48`.
- Report AI summary wait (`routes_reports.py:131-133, 1705-1706`) becomes
  `min(2 * model_step_timeout_s, 280)` seconds (D20), below the Web UI proxy's 300 s
  (`webui/nginx.conf:58-68`). A timeout returns the existing summary-timeout error, worded "The
  summary took too long. Try again, or summarise fewer items."
- Client: `CHAT_AGENT_DEFAULTS` and `CHAT_AGENT_BOUNDS` in
  `webui/src/soc/pages/settings/chat-agent.tsx:49-72, 126-141` follow the table (the bounds pin
  test `__tests__/chat-agent.test.tsx:98-104` moves with them); `DEFAULT_CHAT_BOUNDS` in
  `webui/src/soc/chat/chat-api.ts:213-227` takes the new defaults (fixing the stale 30 s).
- Bounded mode shows "10" for Lookups at once (effective `min(max_parallel, max_tool_calls)`);
  the hint already says so. The Help Center chat settings page adds one sentence: "Higher values
  run more lookups and questions at once; on small model plans this can reach the provider's
  per-minute limits, and Agentic SOC retries those calls."
- The client's 5-minute wait for a free chat slot (`turn-runner.ts:236`) is unchanged (D19).
- Demo planner (`demo_chat.py:600` clamps to 16, `:4878` shows at most 4 values): 12 is inside both;
  planner tests that pin "4 lookups at a time" are updated to read the configured value.

#### 4.2.4 Tests

`backend/tests/test_chat_limits_migration.py`: a version 1 block at the Round 12 defaults moves to
the tripled values; a version 1 block with one changed value keeps it and moves the rest; a
pre-Round-12 block chains to the new values; a Bounded block moves `model_step_timeout_s` too; a
programmatic construction is untouched; running the migration twice is a no-op; a stored version 2
block is never re-decided. `test_settings_schema_chat_agent.py:49-51`,
`test_chat_round12_api.py:245-253` (429 at 12 per user), `test_chat_contracts.py:560-588`
(repair to the new defaults) and the web `chat-agent.test.tsx` pins follow the table. A route test
proves the summary wait never exceeds 280 s for any stored step value.

### 4.3 Ask 4: the Overview without band headers (C3 B)

#### 4.3.1 Layout

- `Band` (`webui/src/soc/pages/Overview.tsx:1576-1614`) is deleted. Its two uses
  (`:3882-3891`, `:3984-3989`) become plain `div`s with `data-band="flow"` and
  `data-band="cases"` (test and print hooks). The test ids `cases-band-container` and
  `cases-band-grid` stay. Prototype attributes (`data-u2-ovgap`, `data-ov-*`) never appear (the
  Round 13 `overview-panels` test forbids `data-ov`).
- Vertical gap between the KPI strip, the flow row, the cases row and the Deeper analytics header:
  the panel gutter, `gap-4` (16 px), `xl:gap-5` (20 px from 1280 px), `3xl:gap-6` (24 px from
  1920 px), the same values the panels use inside a row. The masthead-to-strip gap is unchanged.
- Measured targets ([P-C3]): the top of the cases row at 777 px (1440 by 900), 801 px (1280 by 800),
  896 px (1920 by 1080) and 1,568 px (390 by 844), each within 8 px. Geometry is verified by the
  live QA harness (§8.3) and recorded in the Journal and §11.4; Vitest asserts the structure that
  produces it (the gap classes on the row container, no band element, DOM order).
- The KPI strip uses 2 columns below 768 px (shared `KpiStrip`, §4.9.2), which also shortens the
  phone page.

#### 4.3.2 Moved information

| Was in a band caption | Now |
|---|---|
| "How the last 24 hours of alerts became cases" | A 13 px muted window caption inline after the flow title: "Noise reduction flow · last 24 hours" (the window label follows the page's `TimeRangePicker`) |
| "(the N in Total Cases above)" | A quiet footer line in the flow panel, on its scale row: "Same count as Total cases above." Shown only when `crossRefs.flowCases` equals the Total cases tile (the existing equality rule, `:3255-3285`). New optional `crossReference?: string` prop on `NoiseFunnel` (flat variant) |
| "Cases that arrived in the last 24 hours" | Window caption after each cases-row title: Open cases, Cases resolved, Response time ("p50 · last 24 hours"), Latest cases ("Newest of the last 24 hours", replacing "Real-time triage queue") |
| "response timing is p50, computed on the server" | Response time keeps "p50"; "server-computed" moves into its help tip |
| two "Updated" stamps | One page-header stamp (§4.3.3) |

KPI labels in sentence case: "Total cases", "Total critical", "Open cases", "Resolved or closed",
"Auto-closed", and the footers that quote them ("Same count as Auto-closed above.").

#### 4.3.3 One honest freshness stamp

The page header's `Freshness` (`:3653-3659`) is computed from the **oldest** of the independently
loaded slices that feed visible modules: the case batch `loadedAt`, `posture.generated_at`,
`noise.generated_at` (today the newest, `:3611-3614`). It renders a `<time datetime>` whose tooltip
reads "Oldest of cases, flow and response data: 14:02:31 UTC". A slice whose refresh failed keeps
its in-card message ("Refresh failed. Showing the last loaded flow.").

#### 4.3.4 Structure, print and docs

- Outline: `h1` "Cyber Defence Center", then one `h2` per module in reading order (Noise reduction
  flow, Human vs AI, Open cases, Cases resolved, Response time, Latest cases, Deeper analytics). The
  flow panel becomes `<section aria-labelledby>` pointing at the funnel's `h2` (give it an id).
- Print CSS (`theme.css:1896-1901`) retargets from `[aria-labelledby='overview-band-flow']` to
  `[data-band='flow']`; `overview.print.test.ts:68-72` moves with it.
- Tests: `overview.inventory.test.tsx:265-268, 365-368` (regions gone, stamp kept at `:226`),
  `:596-604, 625-630` (the cross-reference moves to the flow footer line);
  `overview-panels.test.tsx:555, 561-570` becomes "no band titles; every module title is inside its
  panel; the row container carries the panel gutter classes" (the measured gap at 1280, 1440 and
  1920 is a live-harness check, §8.3).
- Docs: `ui-standard.md` "Dashboard bands" (`:1083-1095`) is rewritten as "Modules on grouped
  panels, one gutter apart, no section titles"; `docs/analyst/overview.md:54-65`; `docs/USAGE.md:119-125`;
  the header comment `Overview.tsx:18-25` and the band comment `:3862-3881`.

### 4.4 Ask 3: built-in dashboards in a Dashboards library (C2)

§2.2 fixes the navigation, routes, breadcrumbs and headers. This section fixes the data, the
boards and every screen state.

#### 4.4.1 Data model

- Built-ins are **code-defined** in `webui/src/soc/dashboard/builtins.ts` (new): `BUILTIN_BOARDS:
  readonly BuiltinBoard[]` with `{ id: 'builtin:soc-operations' | 'builtin:detection-data-health'
  | 'builtin:executive-summary', name, badge: 'Built-in', audience, purpose, defaultWindow:
  'now-24h' | 'now-7d' | 'now-30d', compare: boolean, widgets: DashboardWidget[], outline:
  OutlineBox[] }` plus the Cyber Defence Center card entry `{ id: 'builtin:cyber-defence-center',
  badge: 'Default', href: '#/overview', window: 'now-24h' }`. They are never stored. They update
  with releases.
- Personal boards keep `DashboardLayout` in the per-user `DashboardStore` (no change to the KV
  shape, `backend/app/stores/dashboards.py`). The role default is offered under the fixed id
  `overview` with the new name "My dashboard" until the first Save (`Dashboards.tsx:52-69`,
  `registry.ts:392-409`). Read-time rename for boards already saved: a stored board whose id is
  `overview` and whose name is exactly "Overview" displays as "My dashboard" everywhere (library
  card, header, breadcrumb, dialogs), and the next Save writes the new name; any other stored name
  is the user's choice and is shown as stored.
- `DashboardLayout.default_window: Literal["now-24h", "now-7d", "now-30d", "now-90d"] | None`
  (new, additive, WP-0; validated in `_sanitize_layout` by A2). Absent means the client default
  `now-24h`. A Duplicate copies the built-in's window into it; the board's `TimeRangePicker`
  starts there. The board picker offers only those four relative presets, no custom range, because
  every provider key except `breakdown` takes a trailing integer `window_hours` (24, 168, 720,
  2,160); `breakdown` receives the same token.
- Hidden built-ins: `UserPrefs.misc.dashboards_hidden: list[str]`, each entry a built-in id other
  than `builtin:cyber-defence-center`, at most 8 entries, unknown ids dropped on read. Written
  through the existing `PUT /api/prefs/user` (no new endpoint). `backend/app/models.py`'s
  `UserPrefs.misc` validator gains the key (list of strings, each `^builtin:[a-z-]{1,40}$`).
- Server: `backend/app/api/routes_dashboards.py` rejects creating a board whose id is `new` or
  starts with `builtin:` or `u:` (`400 dashboard_id_reserved`, create only; §2.2 item 4);
  `WIDGET_TYPES` (`:71-80`) gains the new types (§4.4.3). The cross-stack contract moves
  atomically in A2: `webui/src/soc/dashboard/widget-types.contract.json`, the backend
  `test_round5_dashboards_widget_type_contract.py`, the web contract test and the client
  `WidgetType` union with stub registry entries (a stub renders the shared "Not available yet"
  empty state; W4c replaces every stub body).
- Duplicate of a built-in: the client copies the built-in's widgets (dropping any the viewer
  cannot read) and creates the board through the existing `POST /api/dashboards` with name
  "SOC operations (copy)" and the new optional `DashboardLayout.derived_from: str | None`
  (`"builtin:soc-operations"`, at most 64 characters, plain data, shown as "Copied from SOC
  operations" in the board's help tip). The 24-board
  and 40-widget limits apply (`routes_dashboards.py:84-85`); at the limit the dialog says "You have
  24 dashboards, the most allowed. Delete one to add another." and disables Duplicate.

#### 4.4.2 The one new endpoint: `GET /api/metrics/breakdown`

Owned by `backend/app/api/routes_metrics.py`. Gate `metrics:view` (`cost:view` for `kind=usage`). No audit row (a read).

| Param | Type | Default | Bounds |
|---|---|---|---|
| `kind` | `cases` \| `usage` | `cases` | `usage` aggregates the usage ledger through the existing `aggregate_usage` engine (`USAGE_GROUP_FIELDS`, metrics `calls` and `cost_usd`), gate `cost:view`; used by `kpi.cost_budget` |
| `by` | `rule` \| `source` \| `severity` \| `status` \| `verdict` \| `closed_by` \| `assignee` \| `mitre_tactic` \| `mitre_technique`; with `kind=usage` one of `USAGE_GROUP_FIELDS` (`surface`, `role`, `model`, `provider`, `service_tier`) | required | one value |
| `then` | same set, not equal to `by` | none | optional second grouping (exact, `case_aggregate` multi-field) |
| `window` | the Round 12 window grammar (`engine/time_windows.py`: `now-24h`, `now-7d`, `now-30d`, calendar tokens, ISO ranges) | `now-7d` | as the grammar |
| `bucket` | `hour` \| `day` \| `week` | none | optional time bucketing (zero-filled, the plan's time zone) |
| `top` | int | 10 | 1 to 50; the rest is one exact "Other" row |
| `filter_rule` | string | none | exact match on `Case.rule_ids`, 1 to 256 printable characters |
| `status_group` | `open` \| `closed` | none | filters to the open stock or the terminal cases through `case_aggregate`'s existing `status_group` filter; with `open`, use `window=all` for "open now" figures |

Body: `CaseAggregateSpec(window, group_by=(by[, then]), bucket, metrics=("count", "open_now",
"verdicted", "verdict_tp", "verdict_fp", "verdict_needs_human", "analyst_tp", "analyst_fp",
"analyst_ungraded"), top_n=top, filters)` passed to `aggregate_cases`
(`engine/case_aggregate.py:1405`), the engine chat's `case_stats` uses, so the dashboards and chat
agree on every number.

**Two metric families** (A2 adds the new ones to `CASE_METRICS` in `engine/case_aggregate.py` with
the Elasticsearch push-down, the SQL `GROUP BY` and the streaming fold, and to `chat_tools/stats.py`
`METRICS` so parity covers them; additive, no existing metric changes):

| Metric | Family | Definition |
|---|---|---|
| `verdicted` | AI verdict | cases with any investigator verdict (TRUE_POSITIVE, FALSE_POSITIVE or NEEDS_HUMAN); also "cases investigated" |
| `verdict_tp`, `verdict_fp`, `verdict_needs_human` | AI verdict | cases whose current AI verdict is that value; `verdict_tp + verdict_fp + verdict_needs_human = verdicted` |
| `analyst_tp` | analyst outcome | cases an analyst classified as a true positive (the Round 12 `caseOutcome` analyst-classification rule), excluding `decided_by=analyst_policy` closes |
| `analyst_fp` | analyst outcome | the existing metric, unchanged (same rule, false positive) |
| `analyst_ungraded` | analyst outcome | `count - analyst_tp - analyst_fp` |

The existing `fp_rate` stays as it is for existing callers; new surfaces use the named families and
always say which one they show ("AI verdicts" or "Analyst outcome"). A surface labelled "Analyst
outcome" or "Confirmed" reads only the `analyst_*` fields.

Response (`MetricsBreakdown`, new model in `models.py`, mirrored in `types-dashboards.ts`):

```json
{
  "by": "rule", "then": null, "bucket": null, "status_group": null,
  "window_label": "Last 7 days", "window_from": "2026-10-19T00:00:00Z", "window_to": "2026-10-26T00:00:00Z",
  "total": 1874, "exact": true, "partial": false, "multi_valued": true,
  "groups": [{"key": "ssh_auth_failed", "then_key": null, "bucket": null, "count": 41,
              "open_now": 3, "verdicted": 33,
              "verdict_tp": 4, "verdict_fp": 18, "verdict_needs_human": 11,
              "analyst_tp": 3, "analyst_fp": 14, "analyst_ungraded": 24}],
  "other": {"count": 210, "groups": 37}
}
```

(41 cases. AI verdicts: 4 + 18 + 11 = 33 verdicted. Analyst outcome: 3 + 14 = 17 classified and
24 not graded, 3 + 14 + 24 = 41.)

`multi_valued` is true for `rule`, `mitre_tactic` and `mitre_technique` (a case with two rules
counts in both rows); every widget that reads it must not present the rows as summing to `total`.
Errors: `400 breakdown_bad_param` (unknown `by`, `then == by`, bad window), `403` without the
grant. With row-level data scope on (`can_object`), case-derived rows are refused with
`409 breakdown_scope_unsupported` (D16); the widget shows "Hidden while row-level scope is on.".
Demo Mode reads the Demo case store. Keys (rule ids, source names, technique names) are untrusted
and returned as plain strings (#9). Tests: parity with `case_stats` for every `by` and every new
metric (exact and fold paths, Elasticsearch and SQL), multi-valued rule rows, `then` cross-tab
exactness, `top` and "Other", windows and buckets, `status_group`, analyst-policy closes excluded
from `analyst_*`, the family sums of the example, RBAC 403, scope 409, Demo store, and a gateway
spy (no model call, #6).

#### 4.4.3 Widget types

Each follows the existing contract (one value in `widget-types.contract.json`, one registry entry
in `webui/src/soc/dashboard/registry.ts`, one lazy body under `dashboard/widgets/`, the server
allowlist, the two contract tests). All render on the shared `Panel` (§4.9.2) with a title, a
caption that starts with the window or "Open now", and a "View ..." exit to the page that lists
the population.

| Type | Options | Provider keys | Gate |
|---|---|---|---|
| `kpi.strip` (new) | `preset: operations \| detection \| executive` | per cell, as the binding table below | per cell (a denied cell shows "No access") |
| `chart.case_trend` (new) | `series: flow \| alerts \| outcomes` | `trends` | `metrics:view` |
| `chart.case_breakdown` (new) | `by` (any breakdown key), `top` | `metrics` (status, verdict) or `breakdown` | `metrics:view` |
| `chart.severity_trend` (new) | `bucket: day \| week` | `breakdown` (`by=severity`, bucketed) | `metrics:view` |
| `chart.backlog_aging` (new) | none | `posture` | `cases:read` |
| `chart.noise_funnel` (new) | none | `noise` | `metrics:view` |
| `table.attention_queue` (new) | `limit` 8 | `shift` | `cases:read` |
| `table.workload` (new) | none | `shift` | `cases:read` |
| `table.sla_breaches` (new) | none | `posture` | `cases:read` |
| `table.top_rules` (new) | `top` 10 | `breakdown` (`by=rule`) | `metrics:view` |
| `table.noisy_rules` (new) | none | `tuning` | `automation:read` |
| `table.top_techniques` (new) | `top` 10 or 5 | `mitre` | `metrics:view` |
| `kpi.auto_close_health` (new) | none | `autoClose` | `metrics:view` |
| `table.campaigns` (new) | none | `campaigns` | `cases:read` |
| `table.telemetry_gaps` (new) | none | `telemetry` | `cases:read` |
| `kpi.agent_quality` (new) | none | `agentImprovement` | `metrics:view` |
| `chart.autonomous_vs_human` | unchanged | `posture` | `metrics:view` |
| `kpi.lifecycle_timing` | adds MTTD and p90 | `posture` | `metrics:view` |
| `table.connector_health` | adds last-event age and silent flag | `sourcesHealth` | `sources:read` |
| `mitre.heatmap` | label "Techniques seen in cases" (never "detection coverage") | `mitre` | `metrics:view` |
| `gauge.active_risk` | caption "74 and above is critical" | `metrics` | `cases:read` |
| `kpi.cost_budget` | page window, spend per investigated case, "Of which chat, outside the budget" line, budget line only with `models:read` | `usage`, `budget`, `breakdown` | `cost:view` |
| `kpi.needs_human` | fixed: counts open cases whose AI verdict is Needs human, `breakdown?by=verdict&status_group=open&window=all`, group `NEEDS_HUMAN`; never status `open` only | `breakdown` | `metrics:view` |

**KPI strip bindings** (binding; WP-0 writes the same table as `KPI_STRIP_BINDINGS` in
`webui/src/soc/dashboard/kpi-bindings.ts`, and A2's `test_kpi_strip_bindings.py` pins every
server field named here on the Demo dataset and a fixture; a field marked "new" is added by A2 in
`routes_metrics.py`). "W" is the board window; "all" means `window=all`.

| Preset · cell | Source and field | Definition shown in the help tip | Grant (the cell's display gate) |
|---|---|---|---|
| operations · Open now | `GET /api/metrics/posture` `open_now.count` (a stock) | Cases not closed or resolved right now | `cases:read` |
| operations · Awaiting a decision | `breakdown?by=verdict&status_group=open&window=all`, group `NEEDS_HUMAN` | Open cases whose AI verdict is Needs human | `metrics:view` |
| operations · Unassigned | `breakdown?by=assignee&status_group=open&window=all`, the unassigned group (`key: null`) | Open cases with no assignee | `metrics:view` |
| operations · SLA breached | `GET /api/standup/report` `sla_aging.breached` | Open cases past their response or resolve target | `cases:read` |
| operations · New cases | posture `case_count` (window W) | Cases created in the window | `metrics:view` |
| operations · Closed | posture `quality.terminal_cases` (window W) | Cases created in the window that are now closed or resolved | `metrics:view` |
| detection · Sources reporting | `GET /api/sources/health`: enabled rows whose last event is inside W | Enabled sources that sent at least one event in the window | `sources:read` |
| detection · Silent sources | `GET /api/sources/health`: enabled rows flagged silent | Enabled sources the silent-source detector flags | `sources:read` |
| detection · Events per minute | `GET /api/metrics/noise-reduction` `events_per_min_from_ticks` | Mean events per minute over the window, from the poller's tallies | `metrics:view` |
| detection · Alerts ingested | noise-reduction first stage count | Raw alerts counted in the window | `metrics:view` |
| detection · Alert reduction | noise-reduction `reduction` | Share of raw alerts that did not become a case | `metrics:view` |
| detection · Techniques seen | `GET /api/mitre/coverage`: techniques with at least one case in W | ATT&CK techniques on at least one case in the window (never "detection coverage") | `metrics:view` |
| executive · Cases | posture `case_count` (window W) | Cases created in the window | `metrics:view` |
| executive · Confirmed threats | `breakdown?by=severity&window=W`, the sum of `analyst_tp` over the groups (severity is single-valued) | Cases an analyst confirmed as true positives (analyst-policy closes excluded); never the AI verdict | `metrics:view` |
| executive · MTTD p50 | posture `lifecycle.mttd_minutes` p50 | Median first event to case creation | `metrics:view` |
| executive · MTTR p50 | posture `lifecycle.mttr_minutes` p50 | Median case creation to resolution | `metrics:view` |
| executive · Closed by the AI agent | `GET /api/metrics/auto-close-health` (`recorded_auto_close_health`, first-decision anchoring from the append-only trail) auto-closed count and share | Cases whose first terminal decision was the agent's automatic close; a later human acknowledgement does not move it (the deprecated last-writer `automation_rate` is never used) | `metrics:view` |
| executive · SLA attainment | posture `sla.attainment_pct`, with `attainment_reason` when null | Share of scored cases that met their targets; "Not measured" with the reason when nothing was scored | `metrics:view` |
| `kpi.cost_budget` · Spend per case | `breakdown?kind=usage&by=surface&window=W`, the `cost_usd` of the surfaces the investigation pipeline's router and investigator calls carry (A2 names them in `KPI_STRIP_BINDINGS` from the gateway's actual values and pins them in the binding test) ÷ `breakdown?by=severity&window=W` summed `verdicted` | Investigation spend divided by cases the agent investigated in the window; chat, standup and report spend are excluded | `cost:view` |

A value whose source is partial or a lower bound shows "at least" or "about" exactly as the
source says; a null shows "Not measured" with the source's reason, never 0.

New provider keys in `DashboardDataProvider.tsx` (`:109-137`): `trends`, `noise`, `shift`
(`GET /api/standup/report`, deterministic, never the billing `GET /api/standup`), `coverage`,
`autoClose`, `usage`, `budget`, `campaigns`, `tuning`, `telemetry`, `agentImprovement`,
`breakdown` (keyed by its query string, so two widgets with different `by` fetch twice and two with
the same share one fetch). Every key is a non-billing read (#6) that returns aggregates or case
rows, never raw log rows (#7). The provider narrows fetches to the keys placed widgets need, keeps
the 60 s visible-tab refresh, takes the page window from the board's `TimeRangePicker` (fixing the
silent 168 hours, `DashboardBuilder.tsx:429-433`), and keys its cache on the Demo identity token.

#### 4.4.4 The three boards (layouts at 1440 px and wider; 12 columns)

**SOC operations** (default window last 24 hours, compared with the previous 24):

```
[ KPI strip: Open now | Awaiting a decision | Unassigned | SLA breached | New cases | Closed ]   (12)
[ Arrivals and closures (8)                        ][ Human vs AI (4)          ]
[ Needs attention now (8)                          ][ Analyst workload (4)     ]
[ Backlog aging (4) ][ SLA breaches and at risk (4) ][ Open cases by status (4) ]
[ Response timing: MTTD | MTTA | MTTR | Dwell, p50 and p90 (12), title inside its panel ]
```

Rules from [P-C2]: AI agent is blue and a person orange in every chart (the Human vs AI mapping),
"New cases" the neutral line; 2 to 4 lines are named at their ends, no duplicate legend, no zoom
hint; delta chip and "vs prior 24h" on one line; Backlog aging labels all six buckets (`<1h`,
`1-4h`, `4-24h`, `1-3d`, `3-7d`, `>7d`); Needs attention ranks breached cases first, then by
urgency; captions start with the window or "Open now" ("Open now · oldest 9 days").

**Detection and data health** (default last 7 days):

```
[ KPI strip: Sources reporting | Silent sources | Events per minute | Alerts ingested | Alert reduction | Techniques seen ] (12)
[ Alerts and cases over time (8), two labelled charts on one day axis ][ Noise reduction (4) ]
[ Top detection rules (6)                ][ Noisiest rules (6)                 ]
[ Connector health (6)                   ][ Cases by source (6)                ]
[ Techniques seen in cases, ATT&CK heatmap (8) ][ Top techniques (4)           ]
[ Auto-close health (4) ][ Telemetry gaps (8)                                  ]
```

The heatmap fits all tactics with a 96 px column minimum below 1600 px and becomes the Top
techniques list on a phone; Connector health uses two-line rows on a phone; Top detection rules
names are `RuleLink`s (§4.6.5).

**Executive summary** (default last 30 days, compared with the previous 30):

```
[ KPI strip: Cases | Confirmed threats | MTTD p50 | MTTR p50 | Closed by the AI agent | SLA attainment ] (12)
[ Cases by severity over time (8)                  ][ Active risk index (4)    ]
[ Outcomes over time (8)                           ][ Human vs AI (4)          ]
[ Top ATT&CK techniques (4) ][ Cases by source (4)  ][ AI spend (4)             ]
[ Active campaigns (6)                 ][ Agent quality (6)                   ]
```

Outcomes over time names its metric family in its caption ("AI verdicts" or "Analyst outcome",
§4.4.2, never mixing the two) and states its own population ("1,313 in these 4 weeks" and one line
accounting for cases with no verdict yet or outside the weeks); the KPI strip cells follow the
binding table of §4.4.3; AI spend shows model spend, "Of which chat,
outside the budget $22.40" and "Budget used $161.80 of $300 (54%)", all from the server; no
"analyst hours saved" figure exists anywhere. Every chart on every board uses the chart kit's one
day label format ("Oct 1").

Each module's caption, title and "View ..." exit are listed in the Help Center page
`docs/analyst/dashboards.md` (new, §9.1), which is the copy source for the help tips; each KPI
cell's source and definition are fixed by the binding table of §4.4.3, and the Help Center page
repeats that table in plain words.

#### 4.4.5 Screens and states

Library (`#/dashboards`, `webui/src/soc/pages/Dashboards.tsx` rewritten as the library host;
board view in `webui/src/soc/dashboard/BoardView.tsx`, new, lazy):

- Layout: `PageContainer variant="wide"`; header per §2.2 item 10; then section "Built-in"
  (`h2`, 15 px semibold, aside text "Read-only. Duplicate one to make it your own." right-aligned
  13 px muted), then section "Yours" (`h2`). Grid `grid gap-4 sm:grid-cols-2 xl:grid-cols-4
  xl:gap-5`; 32 px between sections.
- Card anatomy (each card is one `<a>` to its route, on `.surface-panel`, `p-4 xl:p-5`, hover
  `bg-hover`, focus ring on the panel colour): a fixed `aspect-[16/7]` outline preview of the
  board's grid (`aria-hidden="true"`, decorative; the KPI strip as one 8 px line, modules as
  `rounded-sm border-border` boxes, no fill, drawn from `outline` for built-ins and from the saved
  widget geometry for personal boards), then one row with the badge (left) and the window or edited time (right, 12 px muted),
  then the name (15 px semibold), then the purpose (13 px muted, two lines max), then the audience
  ("For SOC managers and shift leads", 12 px muted, pinned to the card foot).
- Badges: "Default" (Cyber Defence Center), "Built-in" (the three boards), both `secondary` with a
  Lock glyph; "Yours" (`outline`, no glyph). Personal card text: "Edited 3 days ago" (absolute
  time in `title`), detail "4 widgets" or, for an unsaved My dashboard, "4 widgets · your role
  default".
- The dashed "New dashboard" tile ends the Yours grid (`rounded-xl border border-dashed`, Plus
  glyph, 13 px), an `<a href="#/dashboards?board=new">` (it navigates, so it is a link, not a
  button); the header's "New dashboard" is the same link styled as an outline button.
- Hidden built-ins: the Built-in aside gains "Show 1 hidden" (link button) when any are hidden;
  toggled on, hidden cards render with a "Hidden" badge and an "Unhide" button in the card foot.
- Loading: built-in cards render at once (code-defined); Yours shows two skeleton cards while
  `GET /api/dashboards` loads (the shared skeleton, no spinner). Error: an inline `LoadError` in
  the Yours section ("Your dashboards could not be loaded." with Retry); built-ins stay usable.
  Permission denied (no `metrics:view`): the route shows the shared permission state ("You do not
  have access to dashboards."), and the nav target falls back to the Cyber Defence Center (§2.2).
  A built-in whose every panel is denied is not listed; a partly denied one shows "2 panels need
  permissions your role does not have." on its card and its board.
- **Row-level data scope (D16).** `GET /api/auth/me` gains `object_scoped: bool` for the viewer
  (computed like `chat_starters.object_scoped`: true when `can_object` scoping is enabled and
  applies to the viewer's role for cases). When it is true, every **case-derived widget** does
  not fetch and renders "Hidden while row-level scope is on.", and the library card shows the
  existing "N panels need permissions ..." note counting them. Case-derived widget types (the
  binding list, kept in `dashboard/registry.ts` as `caseDerived: true` and tested): `kpi.strip`
  cells whose source is posture, breakdown, the standup report or auto-close health;
  `chart.case_trend`, `chart.case_breakdown`, `chart.severity_trend`, `chart.backlog_aging`,
  `chart.noise_funnel` (its case stages), `chart.autonomous_vs_human`, `table.attention_queue`,
  `table.workload`, `table.sla_breaches`, `table.top_rules`, `table.top_techniques`,
  `table.campaigns`, `kpi.auto_close_health`, `kpi.lifecycle_timing`, `kpi.needs_human`,
  `kpi.agent_quality`, `kpi.cost_budget` (its per-case line), `gauge.active_risk`,
  `mitre.heatmap`. Not case-derived: `table.connector_health`, `table.telemetry_gaps`,
  `table.noisy_rules` (rule tuning state), the detection strip's source and event cells. The Cyber
  Defence Center page itself is unchanged by this rule (the landing stays as it is). Test (W4c):
  with `object_scoped` true, no case-derived provider key is fetched (a fetch spy) and every listed
  widget shows the sentence.
- Phone (390 px): one column; header action becomes a 36 px outline button "New"; cards keep the
  outline preview at full width.
- Keyboard and screen reader: cards are links in reading order; the card's accessible name is its
  name, `aria-describedby` points at the badge, window and purpose; Hide and Unhide are separate
  buttons, never nested inside the link (the Hide action lives on the board's More menu; Unhide is
  a sibling button below the link).

Board (`#/dashboards?board=...`):

- Header (C8): "All dashboards" link (the `PageHeader back` slot), then the title row: board name
  (`h1`), badge, help tip ("For {audience}. {purpose}"), and in the controls slot the
  `TimeRangePicker` (presets 24h, 7d, 30d and 90d only, no custom range, §4.4.1; default the
  built-in's `defaultWindow` or the personal board's `default_window`, else 24h) and the
  `RefreshButton`. Actions on the right:
  built-in boards "Duplicate to customise" (outline) and a More menu ("Hide from my list"; a
  disabled "Built-in boards cannot be edited"); personal boards "Edit" and More ("Duplicate",
  "Rename", "Reset to default layout" for My dashboard, "Delete dashboard" otherwise, destructive
  in its confirm dialog only).
- Body: widgets flow-packed in the 12-column grid in view mode (no `react-grid-layout`), sized to
  content (no clipped bodies, no fixed 56 px rows in view mode, fixing `WidgetGrid.tsx:156, 381`),
  each on a panel, no nested cards.
- Changing the window refetches every key that takes a window; the KPI strip's comparison follows
  ("vs prior 7d").
- States per widget: loading skeleton in the panel; `EmptyState state="no-data"` with the window
  ("No cases in the last 24 hours"); `LoadError` with Retry for that widget only; honest gaps
  ("MTTA is not available: no case has been acknowledged yet") never a zero.
- Duplicate dialog: title "Duplicate SOC operations?", body "You get an editable copy in your
  dashboards, opened in Edit mode. A copy does not update with new releases; the built-in board
  stays as it is.", a Name field prefilled "SOC operations (copy)" (1 to 120 characters), two notes
  ("Copies every panel, its position and the default window (last 24 hours)." and "Panels your role
  cannot read are left out of the copy."), buttons Cancel and "Duplicate and edit".
- Demo Mode: every board reads the Demo store; the honest Demo gaps show their reasons ([dash
  §3.5]).
- Phone: the strip is 2 columns; modules stack in reading order; tables use two-line rows.

#### 4.4.6 Duplicate, hide, new

- Duplicate: client copies widgets, `POST /api/dashboards`, then navigates to the new board in
  Edit mode; a toast "Copy created. Your changes are saved to the copy only." Failure toast "The copy
  could not be created." with the server's reason.
- Hide: writes `misc.dashboards_hidden`, returns to the library, toast "SOC operations is hidden.
  Undo" (Undo restores it).
- New: `#/dashboards?board=new` opens the builder on an empty draft named "Untitled dashboard"; Save
  creates it (`POST /api/dashboards`) and replaces the URL with the new id; leaving unsaved asks
  first; a refresh on `board=new` opens a fresh empty draft.

#### 4.4.7 Defects fixed here ([S §1.10])

`kpi.needs_human` "0 open" against the Overview's 20 (`widgets/kpi.tsx:23-24`); no time picker;
nested bordered tiles and clipped widget bodies (`WidgetGrid.tsx:156, 381`); the "Overview" name
collision (now "My dashboard", including boards already saved under that name, §4.4.1).

#### 4.4.8 Tests

Backend: §4.4.2 list; reserved ids rejected on create, while a stored board with id `new` (and
one with `builtin:x`) can still be read, updated, renamed and deleted; `default_window`
validation; `misc.dashboards_hidden` normalisation; `object_scoped` on `/api/auth/me`; the KPI
strip bindings. Web: a stored board with id `new` is listed under its `u:` alias and opens;
a stored `overview` board named "Overview" shows as "My dashboard" and saves the new name;
library renders four built-ins in order with "Default" only on the Cyber
Defence Center card and the operator's copy; cards are links with the right hrefs; Yours lists
personal boards with edited time and widget count and ends with the dashed tile; hidden built-ins
and Unhide; the route table of §2.2 item 4 including normalisations and the unknown-board toast;
nav highlight table of §2.2 item 9 (labelled, rail, phone); breadcrumb on a board with a working
"Dashboards" link; Back returns to the library; Duplicate creates and opens a copy without denied
widgets; per-widget gates and "No access" strip cells; page window reaches every provider key as
`window_hours` (and as the token for `breakdown`); `kpi.needs_human` counts by verdict; no widget
fetches `GET /api/standup`; view mode never loads `react-grid-layout`; Demo identity change
refetches; row-level scope hides every case-derived widget without fetching; the `aria-current`
rule of §2.2 item 9 with the Overview group open and closed; pressing the Overview row leaves the
group's open state unchanged; no em dash in any board copy.

### 4.5 Ask 2: the Audit log (C1 A)

#### 4.5.1 Page structure (`#/audit`, gate `audit:view`)

- Header (C8): title "Audit log", help tip ("Every action by people, the AI agent and the system,
  kept append-only. Open a row to see the full record."), controls slot: `TimeRangePicker` (1 h,
  24 h, 7 d default, 30 d, 90 d, custom with an end time) and `RefreshButton`; actions: the Export
  menu (hidden without `audit:export`).
- Control band under the header (on the canvas, divider-led): the scope `SegmentedControl`
  ("People and settings" default, "Agent activity", "All") with a help tip explaining each scope;
  the server-side search box (placeholder "Search events, people and targets", `/` focuses it);
  facet menus Event (grouped by category, searchable), Actor (known actors with counts; typing
  filters with `actor_contains`, picking a known actor uses the exact `actor`), Outcome, and "More
  filters" (case, source, surface, client IP, build); Quick
  views ("Failed sign-ins", "Access denied", "User and role changes", "Settings changes", "Exports
  and resets") on the chips row; active filters as removable chips with "Clear all".
- Scope line: "Showing 1 to 50 of 1,284 events · last 7 days · times in UTC · newest first", with
  "at least 10,000" when `total_relation` is `gte`, plus the retention note from
  `GET /api/storage/lifecycle` ("Kept 180 days hot, then 90 days warm" or "This deployment keeps the
  audit log in memory; it is lost on restart."). In Demo Mode: "Demo Mode: agent activity is demo
  data; sign-ins and settings changes are real." (D11).
- The table on one `Panel` (padding none, C7 1), `table-layout: fixed`, compact rows, sticky
  header, sentence-case 12 px headers. Columns: Time (tabular, "25 Oct 15:09:15", header "Time
  (UTC)" or "Time (local)" with the per-viewer toggle in the column header menu, remembered in
  `localStorage` key `soc.audit.timezone`), Outcome (column 2, 104 px, text plus glyph: Success,
  Failed, Denied, Partial, Not recorded), Event (friendly name), Actor (glyph for person, AI agent
  or system plus name), Target (case number, user, source, setting area, job, rule), Summary (one
  line, truncated). Build, Surface and Model live in the inspector only. Nothing wraps or scrolls
  sideways at 1280 px and wider.
- Agent activity groups one investigation's rows into one expandable row: "Investigation of
  CASE-000214 · 10 steps · closed as false positive" with a chevron button (`aria-expanded`) and an
  "Open case trace" link. Paging is by event (below), so a run can straddle a page boundary: the
  response carries `run_totals: {run_id: n}` for every `run_id` on the page, and a group whose rows
  on screen are fewer than its total reads "Investigation of CASE-000214 · 6 of 10 steps shown ·
  Load more" (Load more fetches the next page, which completes the group in place). Rows without a
  `run_id` (legacy rows and non-pipeline rows) are never grouped. The scope line counts events
  ("Showing 1 to 50 of 18,406 events"), never groups.
- Paging: server-side, 50 rows, "Load more" at the foot (the Case Manager queue grammar), never a
  client filter over a window.
- URL state: `#/audit?scope=people&from=now-7d&q=...&record=<id>`; **empty keys are omitted**
  (`pageHash` already omits them; `optsFromHash`, `router.tsx:206-226`, rejects an empty value and
  drops the whole query). Validators, added to `DEEP_LINK_KEYS` in `webui/src/soc/router.tsx`
  (`:131-135`) by W3:

  | Key | Validator |
  |---|---|
  | `scope` | `^(people\|agent\|all)$` |
  | `from`, `to` | the existing `NAV_TIME` grammar |
  | `q` | `^[^\p{C}\u2028\u2029]{1,200}$` (the `logQuery` rule, 200 characters) |
  | `event` | `^[a-z_]{1,32}(\.[a-z_]{1,32})?$` (an action or a category id) |
  | `actor` (exact), `actor_contains` | `^[^\p{C}\u2028\u2029]{1,128}$` |
  | `outcome` | `^(success\|failure\|denied\|partial\|unknown)$` |
  | `case`, `target` | `NAV_ID` |
  | `ip` | an IPv4 dotted quad or an IPv6 address (`^[0-9A-Fa-f:.]{2,45}$` plus a parse check) |
  | `record` | `^(demo:)?(es:[\w.-]{1,255}:[\w-]{1,128}\|sql:\d{1,19}\|mem:\d{1,12})$` (the record key alone may exceed `NAV_ID`'s 128 characters, up to 404) |

  A bad key drops the whole query, as today.

#### 4.5.2 The inspector (C1 A)

- A 560 px `Sheet` from the right, the console's sheet radius; **non-modal from 1280 px** (no
  overlay, the list stays scrollable and clickable; clicking another row swaps the record); below
  1280 px it is modal (a focus trap and an overlay), and below 640 px it fills the screen. Focus
  moves to the inspector title only when the person opens a record with Enter or a click (and
  always in the modal form); J and K move the record while focus stays on the row in the list, and
  a polite live region announces the new record ("Role changed, 25 Oct 15:09, record 3 of 50"); Esc
  or Close (36 px, 44 px on a phone) closes and returns focus to the row last shown
  (`onCloseAutoFocus`). The non-modal sheet is a labelled region (`role="region"
  aria-labelledby`), the modal one a dialog.
- Header: friendly event title, one sentence under it ("trao changed the role of vpatel from
  analyst_tier1 to analyst_tier2."), outcome, the time in UTC and local, "Copy link" (copies
  `#/audit?record=<id>` with the current filters; "Copied" announced politely), Previous and Next
  (K and J).
- Sections in this order, divider-led like the Case Manager facts rail, no nested cards:
  1. **Who**: actor with kind (person, AI agent, system), role at the time (new field), client IP
     with its source ("From the connection" or "From the trusted proxy"; the raw forwarded header,
     when present, behind "Show forwarded header", labelled "Supplied by the client; not
     verified"), user agent parsed ("Chrome 141 on macOS", raw string behind "Show raw"), session
     (shortened reference and whether it was remembered).
  2. **What changed** (change events only): Field, Before, After. Friendly field name with the key
     in 11 px mono under it; Before struck through and muted, After in semibold; no red or green;
     secret fields show "Changed (secret values are never recorded)".
  3. **Details**: full `result_summary` and `tool_output_summary`; the reproducible `query_text` in
     a code block with Copy; model and tool; `tool_input` as a collapsible JSON tree (text nodes
     only, keyboard expandable) with Copy JSON; `prompt_excerpt` in a code block labelled "Contains
     untrusted log data".
  4. **Raw record**: the stored JSON as returned, read-only, `pre-wrap` with `overflow-wrap:anywhere`,
     Copy JSON; where a text field hit the 1,000-character write cap, the note "Stored truncated at
     1,000 characters".
  5. **Record**: action token, surface, target, case (link by case number), source (link), record
     id (Copy), event id, request id, run id, app version and full build SHA.
  6. **Related**: links that apply a filter: "Same actor within 15 minutes", "All events for this
     target", "All events for this case" and "Open case trace", "The sign-in that started this
     session" (when `session_ref` exists).
- Fields that legacy rows do not carry are omitted, not shown empty; a legacy row's Outcome reads
  "Not recorded" (or the derived value of §4.5.3 marked "derived" in the inspector).
- A deep link to a record that is not in the current store shows "This record is not in the current
  store." with "Back to the audit log".

#### 4.5.3 Record additions (`backend/app/models.py` `AuditDoc`, additive, new rows only)

| Field | Type | Written by | Notes |
|---|---|---|---|
| `outcome` | `Literal["success","failure","denied","partial","unknown"] \| None` | every writer | legacy rows: readers derive `denied` for `access_denied`, `failure` for `error`, otherwise `None` ("Not recorded") |
| `actor_type` | `Literal["human","agent","system","service"] \| None` | every writer | legacy: derived from the known agent role list, labelled derived |
| `action` | `str \| None`, `^[a-z_]+\.[a-z_]+$`, at most 64 | the writers in §4.5.4 | for example `auth.login`, `auth.login_failed`, `auth.logout`, `auth.mfa_failed`, `user.created`, `user.role_changed`, `role.updated`, `settings.updated`, `audit.exported`, `audit.export_downloaded`, `runbook.published`, `runbook.step_updated` |
| `actor_role` | `str \| None` | request-driven writers | the actor's role at the time |
| `client` | `{ip: str, ip_source: "peer" \| "trusted_proxy", peer: str, forwarded_for: str \| None, user_agent: str} \| None` | request-driven writers | a new `audit_client_ip(request, trusted)`, **not** the existing `client_ip_from` (`state.py:3911`, which returns the first, client-supplied `X-Forwarded-For` entry). `TRUSTED_PROXIES` (new unprefixed backend env setting in `config.py` `Secrets`; a comma list of host names, IP addresses or CIDRs; default `tlsoc-webui`, the existing Web UI service name, resolved through the container DNS at startup and every 5 minutes, an unresolvable name ignored) names the proxies whose forwarded header is believed. When the socket peer is one of those addresses, `ip` is the **rightmost** `X-Forwarded-For` entry (the bundled nginx appends `$remote_addr` with `$proxy_add_x_forwarded_for`, `webui/nginx.conf:21, 46, 63`) and `ip_source` is `trusted_proxy`; otherwise `ip` is the socket peer and `ip_source` is `peer`, whatever headers the caller sent. So a caller that reaches the published backend port 8088 directly (`deploy/docker-compose.agnostic.yml:164`) can never choose its recorded IP, and the frozen compose base (`deploy/update-base-v1.sha256`) needs no edit. `peer` is the socket address; `forwarded_for` is the raw header (at most 256 characters, untrusted, never used for filtering or grouping). User agent capped at 512 characters. Personal data (D9). Documented in `docs/ENVIRONMENT.md` and DEPLOY.md (a deployment behind another proxy adds that proxy to `TRUSTED_PROXIES`) |
| `session_ref` | `str \| None` | request-driven writers | HMAC-SHA-256 of the session id with the server's session key, first 16 hex characters; never the token |
| `target` | `{type: str, id: str, label: str} \| None` | the writers in §4.5.4 | type in `case`, `user`, `role`, `source`, `setting`, `job`, `rule`, `runbook`, `dashboard`, `export` |
| `changes` | `list[{field: str, before: str \| None, after: str \| None, secret?: bool}] \| None`, at most 50 entries, each value at most 500 characters | settings, user, role, rule and runbook writes | secrets (the export's `_SENSITIVE_KEYS` list plus any key the settings schema marks secret) are written as `{field, before: null, after: null, secret: true}`. Every other `before` and `after` value passes through the export's `_redact_text` patterns; for any field named `url` or matching `*webhook*` (notification channel `config.url`, source URLs) the value is reduced to scheme and host (userinfo, path and query dropped, because Slack and Teams webhook URLs carry the credential in the path: `https://hooks.slack.com/services/T0/B0/X` is recorded as `https://hooks.slack.com`), and the entry gets `secret: true` when anything was removed. Test: a Slack webhook URL and a source URL with `user:pass@` never appear in `changes` |
| `request_id` | `str \| None` | the new request-id middleware | `X-Request-ID` honoured only if it matches `^[A-Za-z0-9._-]{8,64}$`, otherwise a fresh UUIDv4; echoed in the response header |
| `run_id` | `str \| None` | the investigation pipeline | one id per investigation run, so the Agent scope can group its rows |

The record store interface changes once, in A4a: `AuditRepository.record` and `record_strict`
(`backend/app/stores/base.py`) gain the optional keyword arguments for every field above (default
`None`, so every existing call keeps working), implemented in `backend/app/audit/audit_log.py`
and `backend/app/stores/sql/repositories.py`, with `backend/app/es/fake.py` gaining the
`wildcard` and `ip` query support the read API needs. A4b-1 and A4b-2 only call the new arguments.

- No backfill (the provenance contract). `app_version` and `build_sha` stamping is unchanged.
- Elasticsearch: `backend/app/es/indices.py` adds keyword mappings for `outcome`, `actor_type`,
  `action`, `actor_role`, `client.ip` (type `ip`), `session_ref`, `target.type`, `target.id`,
  `request_id`, `run_id`; `changes`, `client.user_agent`, `client.peer` and
  `client.forwarded_for` are `enabled: false` objects or text not used for filters. Bootstrap
  never remaps, so on an existing index those fields map
  dynamically until the write index rolls over: readers filter on `<field>.keyword` when the live
  mapping says `text` (the same trap as `source_id`, `indices.py:77-85`), and `DEPLOY.md` and
  `docs/operations/upgrades.md` tell operators to roll the audit write index.
- SQL: no migration; filters push down through JSON accessors (`AuditRow.doc["actor"].as_string()`)
  instead of the Python scan (`stores/sql/repositories.py:1365-1431`).

#### 4.5.4 Writers that fill the new fields

Sign-in, failed sign-in (today only `actor` and "login failed", `routes.py:3459-3462`), sign-out,
MFA enrol and failure, session revoke, user create, update, delete and role change, role and custom
role changes, settings writes (`PUT /api/settings` and every curated settings route, with
`changes` computed from the stored before and the validated after), exports, resets, updates,
rule edits, analyst policy edits, runbook writes (§4.10.15), dashboard create and delete. The
pipeline stamps `run_id` and `actor_type="agent"` on its rows. A shared helper
`audit_context(request) -> AuditContext` (new, `backend/app/audit/context.py`) builds `client`,
`session_ref`, `actor_role` and `request_id` so writers never compute them by hand, and every
writer goes through `audited_write` (§3.6). The writers live in files several packages touch, so
A4b is split and sequenced after their current owners (§7.3, §7.9): **A4b-1** (sign-in, failed
sign-in, sign-out, MFA, sessions, users, roles and custom roles, `PUT /api/settings` and the
curated settings routes in `routes_prefs.py`) and **A4b-2** (exports `routes_export.py`, resets
through `engine/jobs.py`, updates `routes_updates.py` and `engine/update_audit.py`, rules
`routes_rules.py`, analyst policy `routes_analyst_policy.py`, the curated settings routers
`routes_tuning.py`, `routes_baseline.py`, `routes_batch.py`, `routes_campaigns.py`,
`routes_models.py`, `routes_notifications.py`, `routes_setup.py`, and dashboard create, update and
delete in `routes_dashboards.py` after A2).

#### 4.5.5 Read API

`GET /api/audit` (moved from `routes_search.py:171-203` to a new auto-discovered
`backend/app/api/routes_audit.py`). **Backward compatibility**: every old parameter keeps its
meaning exactly; new behaviour comes only through new parameter names.

| Param | Notes |
|---|---|
| `scope` | `people`, `agent` or `all`; absent means `all` (backward compatible); the page always sends it and defaults to `people` (D4) |
| `q` | server-side search over event name, actor, target label and the four summary fields; 1 to 200 printable characters; qualifiers `actor:`, `event:`, `outcome:`, `case:`, `target:`, `ip:` are compiled by the client into the structured params, never sent as a query language |
| `action` | **unchanged**: filters `action_type`, as today (`routes_search.py:173-195`, `api.ts:1105`) |
| `event` | new: the structured dotted `action` field of §4.5.3 (`auth.login`), or a category id (`access`, `config`, `case_work`, `agent`, `system`) |
| `actor` | **unchanged**: exact match, as today; per-user links (Users "Audit events for this user", the Account page) use it |
| `actor_contains` | new: contains-match, case-insensitive; the page's typed actor filter uses it |
| `actor_kind`, `outcome`, `surface`, `case_id`, `source_id`, `target`, `ip`, `from`, `to` | structured filters (`surface`, `case_id`, `source_id`, `from`, `to` unchanged) |
| `cursor` | opaque, signed, bound to the actor and the filter set (the export cursor pattern) |
| `order` | `desc` (default) or `asc` |
| `limit` | default 100 when `scope` is absent (today's default), 50 when it is present; any value is **clamped** to 1 to 200 and the response carries `next_cursor` for the rest; never a 422 (today's cap was 500) |

Response `AuditPage` (field table in §4.5.10); each record gains `record_id`. Elasticsearch pages
with point-in-time and `search_after` and counts with `track_total_hits` up to 10,000 (beyond it
`gte`); SQL pages by keyset on `(ts, id)` and counts exactly. An expired point-in-time on "Load
more" returns `409 audit_cursor_expired` and the page reloads from the top with a toast "The list
was refreshed because it had been open a long time." In Demo Mode an `all` or `people` read merges
two stores, so its cursor holds both positions, `{control: <cursor>, demo: <cursor>}`, signed
together, and each page is the merge by time of the next rows from each.

`GET /api/audit/count?<the same filters>&cap=100001` (new): an exact count up to `cap` (at most
100,001), using Elasticsearch `_count` or `track_total_hits: cap` and an exact SQL count; response
`{count, relation: "eq" | "gte"}`. The export dialog uses it and the export job re-checks it.

`GET /api/audit/records/{record_id}` returns one record or `404 audit_record_not_found`; gate
`audit:view`; opening a record counts toward view auditing (it is coalesced into the same
`audit_view` row as the list read with that filter set plus the record id).

Scope membership is computed from `actor_type` (new rows) or from the category of the legacy row
(below): People and settings is every row whose actor is a person or a service acting for one, plus
the categories Access and identity, Configuration and data, Case work; Agent activity is the Agent
pipeline and System categories.

**Event categories and friendly names.** The one table is a JSON fixture,
`backend/app/audit/event_categories.json` (owned by A4a), loaded by `backend/app/audit/events.py`
and imported by `webui/src/soc/components/audit/events.ts` through a contract test that reads the
same file, so the two cannot drift. A legacy row's category key is the pair **`(action_type,
surface)`**, because legacy settings writes are stored as `action_type=status, surface=settings`
(`routes.py:1736-1741`) and settings user changes as `user_mgmt, surface=settings`
(`routes_prefs.py:231, 270`):

| Category | `(action_type, surface)` keys (surface `*` means any) |
|---|---|
| Access and identity | `(auth, *)`, `(access_denied, *)`, `(user_mgmt, *)`, `(audit_view, *)` (new) |
| Configuration and data | `(status, settings)` (legacy settings writes, "Settings changed"), `(data_export, *)`, `(reset, *)`, `(system_update, *)`, `(runbook, *)`, `(playbook, *)` (legacy, shown as "Runbook (before Round 14)"), `(tuning, *)`, `(automation, *)` |
| Case work | `(status, *)` other than settings, `(collab, *)`, `(feedback, *)`, `(thread_post, *)`, `(reaction, *)`, `(task_update, *)`, `(proposal, *)`, `(report, *)` |
| Agent pipeline | `(prompt, *)`, `(es_query, *)`, `(tool_call, *)`, `(verdict, *)`, `(decision, *)`, `(context, *)` |
| System | `(poll, *)`, `(scan, *)`, `(notification, *)`, `(inapp_notify, *)`, `(job, *)`, `(error, *)` |

A specific surface key wins over `*`. New rows are categorised by their structured `action`
prefix through the same fixture. A new `action_type` maps to its category explicitly; an unknown
one falls into System with its token shown, never hidden.

**View auditing (D8)**: one `audit_view` row per user per distinct normalised filter set per 5
minutes (a process-local coalescing map with a bounded size of 10,000 entries; a restart may write
one extra row, documented). Viewing is a read, so the row is **best-effort**: a failed append is
logged and counted (`audit_view_dropped` in the health diagnostics) and never fails the read. It
always goes to `control_audit` (§3.5).

**Demo Mode**: People and settings reads the real control store **and** the Demo store's human
rows (case work on Demo cases), merged by time; Agent activity reads the Demo store; All merges
both. Demo rows carry `record_id` prefix `demo:` and a "Demo" badge (D11).

#### 4.5.6 Export (job kind `audit_export`)

- Menu items: "Export CSV (spreadsheet)", "Export JSON Lines (for a SIEM)", and "Full application
  export" (a link to Settings, Data export, shown only with `data_export:export`, which auditors do
  not hold by default). The menu is hidden without `audit:export`; items are disabled with the
  reason "Nothing to export in this view" when the view is empty.
- Dialog: when the person opens it, the page resolves the range to **absolute ISO 8601 UTC
  instants** (a relative `now-7d` becomes `2026-10-18T15:10:00Z` to `2026-10-25T15:10:00Z`); the
  count, the shown range, the file name and the job all use those instants. "Export 1,284 events?"
  with the scope, range ("18 Oct 15:10 to 25 Oct 15:10 UTC"), filters including the search text
  ("None added" when none), order ("oldest first"), format and file name
  (`agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv`, with `<wbr>` after each underscore),
  and two notes: "You will be asked to sign in again." and "This export is recorded in the audit
  log." The count comes from `GET /api/audit/count?...&cap=100001` (§4.5.5). Over 100,000 events
  (D7) the count reads "More than 100,000 events" (never an "About N" without an exact count), the
  Export button is disabled, and the dialog offers "Use last 30 days" only when that range counts
  100,000 or fewer (one more count call), otherwise "Narrow the filters"; nothing is ever silently
  truncated.
- Submit: `POST /api/jobs` with `{kind: "audit_export", params: {format: "csv" | "jsonl", filters:
  <the page's structured filters>, q, order, scope, from, to}}`, where `from` and `to` are the
  absolute instants the dialog showed and `q` is the free-text search, gate `audit:export`, fresh
  authentication (`require_fresh_auth`, D6), 429 `job_busy` if the actor already has one running.
  The handler
  (`backend/app/engine/audit_export.py`, new) reads with the same filters, oldest first, ISO 8601
  UTC, through the read API's store calls, and writes the plain file (`.csv` or `.ndjson`, never a
  ZIP) to the private artifact root; `JobArtifact` records size and SHA-256 (`models.py:1125-1133`).
  It re-checks the count with the same call before reading, is cancellable at every page boundary
  and refuses more than 100,000 rows (`partial` never; it fails with `audit_export_too_large` if
  the count grew past the cap).
- CSV: a fixed documented column set covering every record field (structured fields flattened,
  `tool_input` and `changes` as JSON text columns), RFC 4180 quoting of every string field, and the
  formula defusal of `webui/src/lib/csv.ts` ported and extended: a leading `=`, `+`, `-`, `@`, tab,
  carriage return, line feed, the full-width `＝ ＋ － ＠`, or any of those after leading spaces
  (today's ` +[=+\-@]` case) gets a leading apostrophe. The rule set is one shared fixture,
  `webui/src/lib/csv-formula.contract.json` (cases and expected outputs, created by A5), read by the
  backend writer's test and by the client `csv.ts` test, and W5 extends `webui/src/lib/csv.ts`
  (`FORMULA_LEAD`) to the same rules, so chat-table, report and severity-breakdown CSV and Excel
  exports get them too. JSON Lines writes each stored record unmodified, one per line.
- Audit rows: `audit.export_requested` (format, filters, row count), `audit.exported` (size,
  SHA-256) and `audit.export_downloaded` (job id, size, SHA-256).
- Download auditing for every job kind: `GET /api/jobs/{id}/artifact`
  (`routes_jobs.py:626-650`) writes `job.artifact_downloaded` (job kind, artifact id, size, SHA-256,
  actor) before streaming; a failed audit append returns `503 audit_unavailable`.
- Small exports (at most 5,000 rows) are waited for on the page and downloaded automatically;
  larger ones finish in the background with the usual Inbox notice and Jobs entry.

#### 4.5.7 States and copy

| State | Copy |
|---|---|
| Loading (first load) | the shared centred `LoadingState`; refresh keeps rows |
| No data | "No audit events in the last 7 days." with "Show the last 30 days" |
| No results | "No events match these filters." with "Clear filters" (filters kept) |
| Error | `LoadError` "The audit log could not be loaded." with Retry, stale rows kept |
| Volatile store | a calm `Callout` warning above the table: "This deployment keeps the audit log in memory; it is lost on restart." |
| No permission | the shared permission state "You do not have access to the audit log." |
| Phone | the control band collapses into "Filters (n)" (a sheet); the table shows Time, Outcome, Event; the inspector is full screen |

Keyboard: the list is a `role="grid"` with one roving tab stop; Up and Down move; J and K move and
open; Enter opens; Esc closes; `/` focuses search; `?` lists shortcuts. Headers that sort expose
`aria-sort`; times carry `datetime`. Every value renders as plain text (#9).

#### 4.5.8 Links into the audit log

Case trace "View in audit log" (`#/audit?scope=all&case=<id>`), Users "Audit events for this user",
the Account page's recent activity, and the Jobs entry of an export job.

#### 4.5.9 Tests

Backend: paging and cursors on fake ES and SQLite (both orders, filters, `total_relation`);
**compatibility with the old query shapes** (`?action=auth` filters `action_type`; `?actor=bob`
does not return `bobby`; `?limit=500` returns 200 rows and a `next_cursor`, never a 422; no
`scope` defaults to 100 rows); search; scopes for new and legacy rows, including legacy settings
rows (`status`, `settings`) in Configuration and data; the category fixture loaded by both sides;
get-one, its gate and 404; the count endpoint (exact to the cap, `gte` above); an expired PIT
returns `409 audit_cursor_expired`; the merged Demo cursor; `run_totals` across a page boundary;
the JSON-accessor push-down returns the same rows as the old scan; every writer in §4.5.4 stamps
its fields and writes to the right sink with Demo Mode on and off; secret and URL redaction in
`changes`; a forged leading `X-Forwarded-For` entry never becomes `client.ip`, neither through a trusted
proxy peer (the rightmost entry wins) nor from a direct peer (headers ignored);
request-id middleware (valid header honoured, invalid replaced, echoed); view coalescing and a
failing view append that does not fail the read; Demo split and the People scope's Demo human
rows; export job (`q` set: the CSV row set equals the page query; absolute instants; CSV defusal
from the shared fixture including line feed, leading spaces and full-width forms, RFC 4180, JSON
Lines round-trip, cap re-check, cancel, oldest first, SHA-256 matches the artifact); fresh auth;
`audit:export` grants and the auditor can export; download auditing for two job kinds. Web:
scopes, facets, chips, URL round-trip with empty keys omitted, roving grid keyboard, inspector
non-modal at 1280 and modal below (structure: the modal prop and overlay presence by viewport
mock), focus moves to the title on Enter but stays on the row on J and K, focus return, J and K
paging across a page boundary, a partial investigation group, Copy link, the export dialog's count
("More than 100,000 events"), absolute range, "Use last 30 days" offered only when it fits, every
state above, the client CSV defusal from the shared fixture, plain-text rendering of a crafted
`<script>` summary. Live harness (§8.3): no horizontal scroll at 1280 and 1440.

#### 4.5.10 Response models (`models.py`, mirrored in `webui/src/lib/types-audit.ts`)

`AuditRecord` (the stored `AuditDoc` fields as today, plus):

| Field | Type | Notes |
|---|---|---|
| `record_id` | `str` | E12 grammar |
| every §4.5.3 field | as §4.5.3 | omitted on legacy rows that lack it |
| `outcome_derived` | `bool` | true when `outcome` was derived for a legacy row |
| `actor_type_derived` | `bool` | the same for `actor_type` |
| `category` | `str` | the category id from the fixture |
| `event_label` | `str` | the friendly event name from the fixture (Console-authored copy) |
| `demo` | `bool` | true for Demo store rows |
| `truncated_fields` | `list[str]` | text fields that hit the 1,000-character write cap |

`AuditPage`:

| Field | Type | Notes |
|---|---|---|
| `records` | `list[AuditRecord]` | at most `limit` |
| `next_cursor` | `str \| None` | opaque, signed |
| `total` | `int` | |
| `total_relation` | `"eq" \| "gte"` | |
| `run_totals` | `dict[str, int]` | per `run_id` on this page, its total event count under the same filters |
| `retention` | `{hot_days: int \| None, warm_days: int \| None, volatile: bool}` | from the storage lifecycle, for the scope line |

`AuditCount`: `{count: int, relation: "eq" | "gte"}`. The old `AuditListResponse {records,
total}` keys stay present in `AuditPage` (`records`, `total`), so existing clients keep working.

### 4.6 Ask 6: clicking a rule opens its picture (C4 A)

#### 4.6.1 Backend: exact filters on existing reads

- `GET /api/logs` (`backend/app/api/routes.py:1215`, `sources:read`) gains additive params:
  `rule` (exact match on the row's rule value, 1 to 256 characters, single line, validated with
  `is_safe_log_query`), `severity` (`info|low|medium|high|critical`, exact named level) and
  `severity_gte` (same set). `engine/log_rows.py` `browse_query` (`:148-163`) sets
  `StructuredQuery.rule` (`connectors/base.py:108-125`, already compiled by the connectors) and the
  severity bounds through each source's `severity_scale_max`; push sources' live-tail rings (mode
  `buffer`) ignore filters, so the route filters their rows itself (the chat pattern,
  `chat_tools/logs.py:402-419`). The response adds `filters: {rule, severity, severity_gte}` and per
  source `exact: bool` (false when a source could only be filtered after a bounded read).
- `GET /api/cases` (`routes.py:5701`, `cases:read`) gains `rule` (exact on `Case.rule_ids`) and
  `closed_by` (`agent` \| `human` \| `analyst_policy`, the existing `CASE_FILTER_FIELDS` key, used by
  the `#/scans` redirect, D27), and the queue search haystack includes rule values
  (`:5447-5456`).
- Chat may now attach "Open in Logs" to rule-filtered answers: `rule` leaves
  `LOGS_UNEXPRESSIBLE_FILTERS` (`chat_tools/common.py:746`, rationale `:789-818` updated).

#### 4.6.2 Backend: the rule summary endpoint

`GET /api/rules/summary` in a new auto-discovered `backend/app/api/routes_rule_summary.py`. Auth
required; each section checks its own grant and returns its own status, so the sheet degrades per
section. No model call (#6), no raw rows (raw alerts come from `GET /api/logs`, §4.6.4), no audit
row (a read).

| Param | Notes |
|---|---|
| `rule` | required, exact value as shown in the row (rule id or name), same validation as above |
| `window` | Round 12 window grammar, default `now-3d` or the window of the surface that opened the sheet |
| `source_id` | optional, restricts the alert sections to one source |

Response `RuleSummary` (new model, mirrored in `types.ts`):

```json
{
  "rule": "Web scanner user agent detected",
  "window": {"label": "Last 3 days", "from": "...", "to": "..."},
  "alerts": {"status": "ok", "count": 381, "count_relation": "eq",
             "first_seen": "...", "last_seen": "...",
             "series": {"bucket": "12h", "levels": ["critical","high","medium","low","info"],
                        "points": [{"t": "...", "critical": 0, "high": 3, "medium": 40, "low": 2, "info": 0}]},
             "sources": [{"id": "src-1", "name": "Wazuh", "exact": true}]},
  "top_source_ips": {"status": "ok", "rows": [{"value": "198.51.100.23", "count": 120}], "exact": true},
  "top_targets": {"status": "ok", "rows": [{"value": "web01", "kind": "host", "count": 88}], "exact": true},
  "cases": {"status": "ok", "count": 3, "open_now": 1,
            "outcomes": {"analyst_tp": 1, "analyst_fp": 1, "analyst_ungraded": 1},
            "latest": [{"case_id": "case-...", "case_number": "CASE-000214", "title": "...", "status": "investigating", "verdict": "NEEDS_HUMAN"}]},
  "definition": {"status": "ok", "kind": "source", "suite_rule": null},
  "tuning": {"status": "forbidden"},
  "analyst_policy": {"status": "ok", "policy": null}
}
```

- Section statuses: `ok`, `forbidden` (missing grant), `unsupported` (no source can aggregate;
  the alert figures then come from the newest-N sample with `count_relation: "gte"` and
  `exact: false`), `unavailable` (an error, with a short `reason`).
- Grants: `alerts`, `top_source_ips`, `top_targets` need `sources:read`; `cases` needs
  `cases:read` (exact through `case_aggregate` with the `rule` filter; `outcomes` carries only the
  analyst-outcome family of §4.4.2, which already excludes analyst-policy closes, the Round 12
  rule; the AI verdict family is never labelled as an analyst outcome); `definition` and `analyst_policy` need
  `rules:read` (`definition.kind` is `suite` with the `RuleDefinition` summary, or `source` meaning
  "Defined in the source SIEM"); `tuning` needs `automation:read` (Wilson lower bound, samples,
  proposed change, last tuned).
- Aggregation uses the connectors' `aggregate()` through `call_aggregate` (`chat_tools/logs.py:984-1002`)
  with `rule=` and `group_by=[severity]` bucketed, `[source.ip]`, `[host, user]`; per-source
  severities are projected through `severity_scale_max` before merging (§4.7.2).
- With row-level data scope on, `cases` returns `unsupported` with reason "Hidden while row-level
  scope is on." (D16).
- Demo Mode reads the Demo sources and cases. Rule values, IPs, hosts and titles are untrusted
  plain strings (#9). Bounded: each top list at most 10 rows; `latest` at most 5.
- Tests: every section's grant gate; exact versus sampled honesty; projection of a 0 to 15 and a
  0 to 10 source; case outcomes exclude analyst-policy closes; scope; Demo; gateway spy.

#### 4.6.3 Chat blocks

- `log_stats` (`chat_tools/logs.py:1315-1326`) sets a per-label `drill` list built by code from a
  validated `InternalRef`: rule labels get `{"page": "rule", "opts": {"rule": <value>, "from":
  <window from>, "to": <window to>}}`; severity labels get `{"page": "logs", "opts": {"severity":
  <level>, "from", "to"}}`. `NavRefOpts` (`blocks.py:604-627`) gains `rule` (single line, at most
  256, `is_safe_log_query`) and `severity` (the five levels); a value that fails validation gets no
  link. `rule` is a new `InternalRef.page` value the client resolves to the rule sheet, never a
  route. `provenance="ai"` blocks never get links (`blocks.py:753`).
- `_build_categories` (`blocks.py:2537-2581`) copies `drill` into the table view as well as the
  chart view; the table view gains a per-row trend (a sparkline from the tool's existing `matrix`
  for the first grouped field, dots below 5 points).
- BLOCKS amendment (WP-DOC): `drill` is allowed on table views; `rule` page refs.
- The chat case entity block names cases by case number (never `case-95928c...`) and prints status
  history and reasons in plain words ("Open to Escalated: automatic close of a confirmed threat is
  off"), mapping reason codes through one table in `webui/src/soc/chat/blocks/labels.ts`.
- `BlockCard.tsx:824-829`: the heading gets `w-fit max-w-full`, and `title` is set only when the
  text is truncated (`scrollWidth > clientWidth`, re-measured on resize).
- Demo planner (`engine/demo_chat.py`) emits the same `drill` refs for "What are the top detection
  rules this week?" and "Show alerts by severity for the last 3 days"; golden-set questions cover
  both.

#### 4.6.4 The rule sheet (web)

`webui/src/soc/components/RuleSheet.tsx` (new, lazy) opened by `RuleLink` (§4.6.5).

- Container: the console `Sheet` from the right, 46 rem wide (736 px), modal with overlay at every
  width (it is a destination, not an inspector), full screen below 640 px; focus to the title on
  open, returned to the opening link on close. Opening a second rule replaces the first.
- Header: the rule value as the title (plain mono text, wraps, never a link), a "From your answer"
  or "From CASE-000214" line naming where it was opened (`aria-describedby`), the window as a
  `TimeRangePicker` (default from the opener), and source chips when filtered.
- Key figures on one tinted strip (the Overview KPI grammar): Alerts ("381" or "at least 1,000"),
  Cases from this rule, Still open, Analyst outcome ("1 confirmed" over "1 benign · 1 waiting for
  an analyst", read only from `cases.outcomes` `analyst_*`), plus "Last seen 14:02 UTC · first
  seen Oct 22" under the strip.
- Primary action: "Open all 381 in Logs" (filled button) opens `#/logs?rule=<value>&from=<iso>&to=<iso>`
  plus `sourceId=<id>` when the sheet is filtered to one source (the Logs page with an exact "Rule
  is" chip, §4.6.6). The number appears only when `alerts.count_relation` is `eq` and every source
  in the count was filtered exactly; otherwise the label is "Open in Logs" with no number, so the
  button never names a count Logs may not show. Secondary: "Show the 3 cases" (Cases list
  filtered by `rule`) and "Ask AI about this rule" (the existing fenced `rule` entity question,
  `agents/chat_entity.py:63, 183`, an ordinary metered chat turn through the one gateway).
- Sections, each with its own loading, empty and permission line ("You do not have access to
  cases."): Alerts over time by severity (stacked by named level, dated ticks "Oct 23", caption
  "12 h buckets · exact" or "sampled from the newest 200 per source"); Top source IPs; Top targets;
  Latest alerts (the newest 5 rows from `GET /api/logs?rule=...&limit=5`, plain text, shown to the
  person only, never sent to a model, #7); Cases from this rule (number, title, status, verdict);
  About this rule ("Defined in the source SIEM" with no settings link, or the suite rule's name,
  state and MITRE with "Rule settings", tuning state, "No analyst policy applies." or the policy).
- Keyboard: Tab order header, figures, actions, sections; Esc closes. Phone: one column; actions
  stack under the figures.
- Demo Mode: identical, Demo data.

#### 4.6.5 `RuleLink`: one entry point everywhere

`webui/src/soc/components/RuleLink.tsx` (new, small, not lazy; it lazy-loads the sheet; created
by W6a with its module store and the sheet, before any package that places it, §7.5): a
`button` styled as inline mono text with an underline on hover and focus, accessible name "Open
rule {value}", props `{rule, window?, sourceId?, origin?}`. A module store keeps one open sheet.
Used by: chat table and bar rows with a `rule` ref (`TableView.tsx` row action, `HBarChart.tsx`
click and Enter), the chat entity block's Rules fact, Case Manager facts rail "Detection rule"
badges (`casedetail/FactsRail.tsx:318-333`), Logs row details (`UnifiedLogsSheet.tsx:696`), the
Tuning page rule list, "Precedent by rule" in health diagnostics (`HealthDiagnostics.tsx:364`), the
Overview's top signatures, the dashboard `table.top_rules` and `table.noisy_rules` widgets, and the
severity breakdown's rule names (§4.7.3). The opened table row stays marked (`aria-current="true"`
styling) while its sheet is open.

#### 4.6.6 Logs with an exact rule filter (the main action)

`webui/src/soc/pages/UnifiedLogs.tsx` reads `rule`, `severity` and `severity_gte` deep-link keys
(added by W3 to `DEEP_LINK_KEYS` in `webui/src/soc/router.tsx:131-135`, beside the existing
`logQuery`, `from`, `to` and `sourceId`; the `NavOpts` fields in `nav-types.ts`), shows a
removable chip "Rule is" with the value in mono and the severity chips ("Severity is High",
"Severity High or above"), hides the Rule column while the chip fixes it, shows the exact count
("381 events · last 3 days") or "at least 1,000 events" when a source was not exact, "Sources: all 5
that support browsing" (or the sources that applied the filter exactly), and "Back to answer" when
opened from chat. W6b owns these chips. Validators: `rule` is `^[^\p{C}\u2028\u2029]{1,256}$`
(the `logQuery` rule, 256 characters, so spaces and non-ASCII letters pass); `severity` and
`severity_gte` are `^(info|low|medium|high|critical)$`. Test: a rule name with spaces and
non-ASCII letters ("Fehlgeschlagene Anmeldung über SSH") round-trips through the hash.

The Cases page gains a "Rule" filter control (W6b) fed by a Cases `rule` hash key, which W3 adds
to `hashKeys('cases')` in `router.tsx` with the same validator, and to `ROUTES.cases.render` in
`registry.tsx` as an `initialRule` prop.

#### 4.6.7 Tests

Backend: filters on `/api/logs` per connector kind and on buffered push rows; `/api/cases?rule=`;
summary sections as §4.6.2; `drill` refs validated, absent on bad values and on `provenance="ai"`;
table view keeps `drill`; Demo planner parity. Web: `RuleLink` from each listed surface opens one
sheet; per-section permission lines; primary action URL (with `sourceId` when filtered) and its
label without a number when the count is not exact; a rule with spaces and non-ASCII letters
round-trips through the Logs and Cases hashes; Logs chip, hidden Rule column and count;
BlockCard title tooltip only when truncated and hit box equals the text width; the case entity
block shows numbers and plain words; no rule value is ever rendered through `dangerouslySetInnerHTML`.

### 4.7 Ask 7: a severity breakdown a person can use (C5 A plus Split by)

#### 4.7.1 Where it applies

Every severity breakdown: chat `log_stats` grouped by severity, chat `case_stats` and
`soc_metrics` "Cases by severity" (`chat_tools/stats.py:162`, `chat_tools/metrics.py:750-752`),
the Executive board's severity widgets and the rule sheet's series (D22).

#### 4.7.2 Computation (backend)

- Each event's raw severity is projected to a named level through **its own source's**
  `severity_scale_max` (`engine/priority.py:143`, `ocsf/model.py:101`) before sources are merged,
  then through the one ladder (`badges.tsx:91-98`; backend mirror `_queue_score_band`,
  `routes.py:5468-5478`). Wazuh 0 to 15 and QRadar 0 to 10 sources therefore land in the same
  levels as a 0 to 100 source.
- All five levels always appear in fixed order (Critical, High, Medium, Low, Info), zeros
  included.
- Each level carries `raw_values` (the distinct raw values seen, at most 5, per source scale), its
  count, its share of the counted events (one decimal), a trend (the level's count per bucket over
  the window, at most 24 points), its top rules (up to 3 with counts) and `rules_total`.
- Second dimension: for aggregate-capable sources (Elastic, OpenSearch, Wazuh `aggregate()`,
  `connectors/elastic.py:1125`) a two-level terms aggregation (severity, then rule; and severity,
  then source); otherwise a cross-tab over the bounded sample (`_STATS_SAMPLE`, newest 200 per
  source, `logs.py:105`), marked sampled. Case-side breakdowns use `case_aggregate` multi-field
  grouping and are exact.
- Honesty: `sample = {counted: 1000, total: 2500, per_source_cap: 200, exact: false}` whenever
  the bars do not cover the stated total; the caption reads "1,000 of 2,500 events sampled, newest
  200 per source". Mixed exact and sampled sources say both.
- Artifact: the `categories` artifact gains `kind: "severity"` with `levels[]` as above and
  `splits: {"rule": {...}, "source": {...}}` (each split: per level, the top 5 keys with counts and
  an "Other" count). BLOCKS amendment (WP-DOC) records the shape; old stored answers without
  `kind` keep rendering with today's renderer.
- `drill` on each level: Logs filtered by `severity` and the window; on each rule: the rule sheet.

#### 4.7.3 Rendering (web, `webui/src/soc/chat/blocks/renderers/SeverityBreakdownView.tsx`, new)

- Default (option A): a table. Columns: Severity (badge on an opaque chip, label "High (73, 8)"
  with a help tip naming each source's scale), Events, Share (one decimal), Trend (sparkline), Top
  rules (a two-line borderless list of up to 3 rule names as `RuleLink`s with counts, then "+7
  more rules"). The first cell holds the row disclosure, a `<button aria-expanded>`; an opened row
  lists every rule in that level, each with its count, a `RuleLink` and a Logs icon button ("Open
  in Logs").
- "Split by" (from option B) in the block header, shown only when the server returned more than
  one split: None, Rule, Source (Host is listed disabled with "Ask again to add it"). Choosing
  Source swaps the Top rules column for the top sources; it never makes a model call and never
  re-queries.
- The matrix view (option C) is offered in the block's view switcher only when a rule spans two or
  more levels; it opens in the wide lane; a phone falls back to the table.
- Caption: the honest sample sentence of §4.7.2; footnote "Levels use each source's own scale."
- Phone: Trend and Top rules columns drop; an opened row lists the rules.
- Reports, print and exports (CSV, Word, Excel) render the table form.

#### 4.7.4 Tests

Projection across three scales; five levels with zeros; shares sum to 100.0 within rounding;
sampled caption only when counted is less than total; splits shape; case-side exactness; Demo
planner emits the new kind; old answers render unchanged; renderer keyboard (disclosure, Split by
menu, rule links), the phone column drop, and a shared fixture proving a rule's count is equal in
the rule table and the severity table of the same sample ([P-C4] and [P-C5] used one sample).

### 4.8 Ask 8, part 1: the left navigation (C6 A)

#### 4.8.1 Behaviour

- Two states only: a 64 px icon rail and a 240 px labelled drawer. **One explicit toggle** changes
  them: the toggle control, Ctrl+B (⌘B on Apple platforms, the label from `keyLabel` and
  `isApplePlatform` in the new entry-safe `webui/src/lib/platform-keys.ts`, §3.4, never by
  importing the chat shortcut list), or a 6 px click strip on the rail's right edge. Hover never
  expands (D24). The state persists per viewer as today (`useNavPrefs`: `localStorage` and
  `PUT /api/prefs/user`).
- **One DOM for both states** (fixes D1): every row is `[40 px icon cell at x 12][label]`; icons
  are 18 px in both states and sit at the same x and y; group headers keep a 24 px slot that
  cross-fades between the heading text and a short divider; nothing is swapped.
- **The morph** (fixes D2): the panel is `position: fixed` and always 240 px wide; a clipping layer
  (`overflow: clip`) slides with `transform` while its content slides back by the same amount, so
  the visible edge moves and the icons stay put. The in-flow spacer changes width **once, at the
  click**, without a transition: the page moves once. On expand the panel (surface, `border-r`,
  top-bar hairline) fills 240 px at the click and only the labels fade in (120 ms after a 60 ms
  delay); on collapse the panel closes over the already-moved page in 160 ms. Open 200 ms, close
  160 ms, `ease-standard`. Group children collapse at the click with the spacer (no transition) and
  reveal with the labels on expand.
- **The toggle** (fixes D3) is one element in a fixed slot at the top of the icon column under the
  brand, never unmounted, so focus and the pointer stay on it. It is a quiet 28 px row (12 px muted
  text, 16 px icon, 8 px of air before the first destination); visible text "Collapse navigation"
  in the drawer, an icon with the tooltip "Expand navigation" in the rail; the accessible name
  follows the state; the shortcut shows in the tooltip ("Ctrl+B" or "⌘B").
- **Flyouts** (fixes D4, D6): in the 64 px rail a grouped icon opens its target page on a click
  with no flyout flash (Overview opens the Dashboards library, §2.2); its children appear in a
  flyout after a **300 ms pointer rest** (any movement restarts the clock), switch to a neighbour
  after 120 ms once one is open, close 400 ms after the pointer leaves icon and flyout, keep a safe
  triangle toward the flyout, open at once on keyboard `:focus-visible` (never on pointer focus),
  and never open on a pointer press. Keyboard: ArrowRight enters the flyout; arrows, Home and End
  move inside; Escape, ArrowLeft or Shift+Tab return to the icon; Tab moves on to the next rail
  destination (flyout items are `tabIndex=-1`). Enter and Space on a grouped icon do what a click
  does (open its page). A grouped rail icon carries `aria-haspopup="true"`, `aria-expanded` (true
  while its flyout is open) and `aria-controls` naming the flyout, which is a list labelled by the
  group name ("Overview pages").
- **Hit and focus boxes** match the visible state: in the 64 px rail each row's hit box and focus
  ring are 48 px wide around the icon cell (not the 224 px drawer row clipped to 56 px, [U1
  critique 11]), so focus outlines and Voice Control targets sit on the icon; in the drawer the row
  is full width.
- **One rail tooltip surface** (fixes D5): a rail-local tooltip that moves to the icon under a
  300 ms rest, shows at once on keyboard focus, never on a press, never while a flyout or the phone
  sheet is open; tooltips are `aria-hidden` (every button has its own name).
- **Current page**: a tinted pill and a tinted icon; no accent bar at the window edge. Nav sections
  that hold one top-level item of the same name (Intelligence, Analytics, Notifications) get a hairline instead of a
  heading that repeats the item; Notifications, whose only child is its own page, is a plain
  destination with no chevron.
- **Grouped rows in the labelled drawer and the phone sheet**: the row (icon and label) is a link
  to the group's target page (for Overview, the Dashboards library, §2.2) and **does not** change
  the group's open state (E13, matching the operator's screenshot); the chevron is a separate 28 px
  button (`aria-expanded`, `aria-controls` the child list, accessible name "Show Overview pages" or
  "Hide Overview pages") that only toggles the children and never navigates. The phone sheet still
  opens the current page's group when the sheet opens (today's `handleMobileNavOpenChange` rule).
  `aria-current` follows the one rule of §2.2 item 9.
- Insets 8 px left and right; the nav scroller has a 6 px scrollbar (`scrollbar-width: thin`
  where `::-webkit-scrollbar` is unsupported), not `scrollbar-gutter: stable both-edges` (it moves
  the icon column 2 px).
- **Phone (390 px)**: the existing Radix Sheet; rows 44 px (40 px inside a group); no inner list
  fade (the sheet's slide is the only motion); open groups frozen for one open and close cycle;
  the nav chunk warmed on load.
- **State store** (fixes D2, D8): `collapsed` and `openGroups` move out of `AppShell` into
  `webui/src/soc/nav-store.ts` (new, `useSyncExternalStore`), so toggles re-render the nav only.
- **Top bar**: the hard-coded "⌘K" search chip and the toggle tooltip use the platform label;
  the bell shows health as a small dot, not a warning triangle; the "Demo mode" pill uses the
  neutral pill style and only the Testing channel pill is amber (Y13); menu icons are 16 px.
- Reduced motion: layout changes are instant, labels and flyouts cross-fade with opacity only.

#### 4.8.2 Registry (`webui/src/soc/registry.tsx`, owned by W3)

- `FeatureNode.target?: PageId` (§2.2 item 2); Overview group as §2.2 item 3.
- Intelligence group: one "Runbooks" entry (id `runbooks`, gate `runbooks:read`) replaces
  "Reference runbooks" and "Response playbooks"; page ids `playbooks` and `catalog` stay routable
  for one release as redirects to `#/runbooks` (D44); "Agent personas" moves to the new
  `Personas.tsx` page id `personas` (unchanged id).
- Names (D25): the nav item "Documentation" is renamed "Help Center"; pages take their title from
  the registry label ("Sources", "Baseline", "Models", "Help Center"). The test is **target-aware**:
  for every routed page, the label of the nav element that is current for that page (the child
  whose `target`, or id, equals the page; for `overview` that is the child "Cyber Defence Center")
  equals the page's `h1`. Group rows are exempt (the Overview group row reads "Overview" while its
  pages are titled "Cyber Defence Center" and "Dashboards"), and so are the host groups whose own id
  is also a child (Workspace and Chat, Notifications and Inbox), listed by name in the test. The
  top-bar breadcrumb is not part of this test; it stays "Agentic SOC / Overview" on the landing page
  (E2).
- `scans` (hidden) becomes a redirect to `#/case_manager?closedBy=agent` (D27): W3 adds the Case
  Manager hash key `closedBy` (`^(agent|human)$`) to `hashKeys('case_manager')` in `router.tsx` and
  the redirect; A6a adds `closed_by` to `GET /api/cases` (§4.6.1); W8b adds the Case Manager filter
  chip "Closed by the AI agent" that reads the key.
- The command palette entries follow `target` (§2.2 item 13); `components/CommandPalette.tsx` and
  `chat/shortcuts/shortcut-list.ts` (the platform-keys re-export) are W3's.
- Short labels are not added (they belonged to option C).

#### 4.8.3 Regression guards

Two layers, because jsdom has no layout and the repository has no browser test lane:

**Vitest** (`webui/src/soc/__tests__/nav.behaviour.test.tsx`, new; structure, events and fake
timers):

- one DOM for both states: the same row elements and icon cells exist before and after a toggle
  (no unmount, no swap), and the icon cell classes do not change;
- `document.activeElement` is the toggle after a keyboard toggle both ways;
- with fake timers, zero flyouts and zero tooltips mount during a scripted pointer-move sequence
  that never rests 300 ms; a 300 ms rest mounts one;
- no flyout mounts on a pointer click of a grouped icon, and the click navigates at once;
- the `aria-haspopup`, `aria-expanded`, `aria-controls` and `aria-current` rules;
- pressing the Overview row leaves the group's open state unchanged (E13);
- 16 Tab stops from the toggle to Settings in the collapsed rail;
- the entry chunk stays inside the budget (`bundle-first-paint.test.ts`, §3.4).

**Live QA harness** (§8.3; the scratchpad scripts `SP/r14/notes/nav-repro.mjs` and
`nav-perf.mjs`; results recorded in the Journal and §11.4, never as a repository test):

- icon x and y constant (0 px drift) at 0, 40, 80, 120, 160 and 200 ms of a toggle in both
  directions;
- the production build at 4x CPU: the median longest frame of 15 toggles each way is at or below
  100 ms (prototype A measured 83 to 100 ms).

### 4.9 Ask 8, part 2: one console grammar (C7 1, C8 1, C9 A)

#### 4.9.1 The rule

Every page uses the Overview's grammar: the page header of §4.9.3, then modules on the tinted
borderless panel (`.surface-panel`: tinted fill, no border, no resting shadow, 14 px corner), one
panel gutter apart (16, 20 from 1280, 24 from 1920), no nested cards, one KPI strip per page at
most, sentence-case labels, compact tables that bleed to the panel edge. `Card` remains only for a
selectable record, a contained editor or dialog content (the ui-standard rule). The ui-standard
"Page anatomy" section becomes the binding statement of this rule (WP-DOC).

#### 4.9.2 Shared primitives (WP-W2 creates them; pages adopt them in WP-W8 and WP-W9)

| Primitive | File | Contract |
|---|---|---|
| `Panel` | `webui/src/design-system/panel.tsx`, exported from `@/design-system` | `<Panel title? caption? count? aside? actions? as="section" padding="default" \| "none" id?>`; renders `.surface-panel` with Overview's `PANEL_PAD` and the instrument title row (moved from `Overview.tsx:1516-1518, 1642-1680`); `as="section"` sets `aria-labelledby` to its title; a `Card` inside a `Panel` fails the guard test |
| `SectionTitle` | same module | The one module title style (15 px semibold, sentence case, optional 13 px caption and aside); replaces the uppercase `h2`s |
| `KpiStrip` | `webui/src/soc/components/KpiStrip.tsx` | `KpiTileGrid` plus strip tiles on a `Panel`; `density="comfortable" \| "compact"`; labels 13 px sentence case; ink numerals; red only for a non-zero critical count (the hero rule, by changing `KpiTile.tsx:1057-1059`, applied to page strips); no icons; 2 columns below 768 px. **Page defaults only**: `KpiTile` gains `chrome="strip" \| "framed"`; pages and dashboards use `strip` (the new default); the bordered chrome and `variant="bar"` (`KpiTile.tsx:1164, 1182-1187`) stay available as `chrome="framed"`, which the chat answer blocks (`ComparisonView`, `InfographicView`, `KpiGroupView`), `chat/report/ReportPanel.tsx` and `components/StatCard.tsx` pass explicitly in W2a, so their rendering and tests do not change (no BLOCKS amendment needed) |
| `ChartPanel` | `ChartCard.tsx` keeps its name and API but renders on `Panel` (no header rule, no icon chip, `ChartCard.tsx:56-61`) | used by Analytics and dashboard widgets |
| Table | `webui/src/ui/table.tsx`, `soc/components/DataTable.tsx` | headers 12 px medium sentence case (`table.tsx:129`, `DataTable.tsx:437`); `density="compact"` default for operational tables (36 px header, about 38 px rows); `table-layout: fixed` when columns declare widths; one-line truncation with a tooltip by default; a right-edge fade while more columns scroll; optional sticky first column; `emptyState` prop that hides the header row and renders `EmptyState` on the panel; `whitespace-nowrap` on id, time and IP cells |
| Tabs | `webui/src/ui/tabs.tsx` | `variant="underline"` (13 px, no icons) for page and record sections; the boxed rail stays only as `SegmentedControl` for in-module view switches |
| `FilterBar` | `soc/components/FilterBar.tsx` | the only filter layout: search, up to three primary filters, "More filters", removable chips, "Clear all"; below 768 px a "Filters (n)" sheet |
| `RefreshButton` + `TimeRangePicker` | existing | the only page-level data controls, placed in the header controls slot; `TimeRangePicker` gains `presets` and `refreshOptions` props (from [P-C8]); hand-rolled spinners removed (`Cost.tsx:701-704`, `AgentEffectiveness.tsx:491`, `HealthDiagnostics.tsx:321`) |
| Formatting | `webui/src/lib/format.ts` | `fmtDuration(minutes)` ("6d 21h", moved from `Metrics.tsx:130`), `fmtOverage(minutes)` ("5d 15h over"), `caseLabel(case)` (always the case number) |
| `PageContainer` | `soc/components/PageContainer.tsx` | owns the rhythm: 24 px header to first module, one panel gutter between modules; pages stop setting `space-y-*` themselves |
| Sheet close | `webui/src/ui/sheet.tsx` | close button `z-30` (fixes the case detail sheet, `sheet.tsx:122-133`) |
| `ListRow`, `RowActions`, `StatusDot` | `webui/src/design-system/` | a record row on a panel (title, one muted line, trailing status shown only for exceptions, one trailing action, the rest in a row menu); neutral ghost row actions, red only on hover, focus and in the confirm dialog; a 6 px dot plus text, coloured only when not the healthy default |
| `Callout` | `webui/src/design-system/callout.tsx` | three intents only: `warning` (a live condition), `error`, `intro` (dismissible, remembered per user in `UserPrefs.misc.dismissed_intros`); `Alert variant="info"` in page files fails the guard test (D26) |
| `NumberField` | `soc/components/NumberField.tsx` | `size: 'xs' \| 'sm' \| 'md' \| 'full'` (6, 8, 12 rem, full) defaulting from `max` digits (8 rem for up to 4 digits); unit inside; steppers inside the right edge, hidden above 4 digits; replaces `NumPref`'s input (`settings/primitives.tsx:241-320`) and the 13 raw `type="number"` inputs ([uib Y4]) |
| `Field` | existing | the only labelled-control wrapper (fixes the Memory form, `Memory.tsx:213-237`) |
| Settings | `pages/settings/primitives.tsx` | `SettingsSection` (§4.9.6), `SettingsGroup`, `SettingRow` (`switch`, `select`, `field`, `status`, `action`) |
| Typography | `webui/src/styles/theme.css:336` | `body` proportional figures; tabular on numeric surfaces (Y1) |

Guard test `webui/src/soc/__tests__/console-grammar.guard.test.ts` (new) fails on: `eyebrow=` or
`breadcrumb=` under `soc/pages` or `soc/rules`; `uppercase tracking` in page files; arbitrary
`rounded-[` radii in page files; `<Card` inside a `Panel`; `RefreshCw` with `animate-spin` outside
`RefreshButton`; `SectionShell rail`; `type="number"` outside `NumberField`; `Alert variant="info"`
in page files; `text-critical` on an icon button outside a dialog; `text-[10px]` or `text-[9px]`
outside the badge primitive; and any path under `webui/src/soc/preview/`, `nav-preview/`, or a
`data-u2-` attribute (the prototype deletion check, [S §3.1 item 10]). `PageHeader back=` is the
one allowed header extra (§4.9.3). The allow-list is one file per package,
`webui/src/soc/__tests__/guard-allow/<WP>.json` (W2a creates the folder and the merge in the
test; each of W8a, W8b, W9a and W9b owns and empties only its own file), so parallel page
migrations never edit the same file.

#### 4.9.3 The page header (C8 1)

- `PageHeader` defaults to the Overview grammar: title (`h1`, 24 px, weight 650, tracking
  -0.48 px; 30 px from 1536 px), an optional `help` (a `HelpTip` beside the title), a `controls`
  slot beside the title (time range, live, refresh; alias of today's `meta`), and `actions` on the
  right (freshness or the primary action). No icon chip, no overline, no breadcrumb, no description
  line, no `tracking-tight` (`PageHeader.tsx:247`), no `variant="hero"`. The props `icon`,
  `eyebrow`, `breadcrumb`, `description` and `variant="hero"` are removed from routed pages (the
  guard test enforces it); `description` remains only for `PageHeader embedded` uses that are not
  routed pages and is rendered as the help tip text everywhere else.
- **The one sanctioned exception**: `back?: {label: string; href: string}` renders a 13 px
  `text-primary` link with an ArrowLeft glyph above the title, for a page that is a child of a
  list it was opened from (a dashboard board, "All dashboards"). It is a link, not a breadcrumb,
  and the guard test allows `back=` only.
- Measured target ([P-C8]): the title's top at 89 px at 1440 (88 at 1920) on every page; first
  content at 144 px on Cases, Analytics, Sources, Standup and Audit, 140 px on Settings. Verified
  by the live QA harness and recorded (§8.3, §11.4); Vitest asserts the header structure (DOM
  order, classes, no removed props).
- One time-range control per windowed page: the `TimeRangePicker` pill in the controls slot
  (Analytics' 24h/7d/30d segmented control, Standup's select and Logs' select plus Live switch are
  replaced); the Cases sort stays with its table (the Updated header).
- Explanations: each page's former description becomes its help tip text, one or two sentences,
  no em dash; pages whose name alone is unclear (Standup, Audit log) keep the same text in the help
  tip, not a line.

#### 4.9.4 Page migrations (WP-W8 pass 1, WP-W9 pass 2)

Pass 1 (triage and reporting): Analytics (Metrics, Cost, Agent effectiveness, Health diagnostics,
Analytics host), Standup, Cases (with the phone list, X16), Logs density (`UnifiedLogs.tsx`,
`UnifiedLogsSheet.tsx`), Campaigns, Reports, Inbox, Jobs, Approvals, Entity investigation and
Workspace, the Case Manager frame. Pass 2 (configuration): Settings and every section,
`Account.tsx`, `Sessions.tsx`, `Users.tsx`, `Roles.tsx`, `AdminSessions.tsx`, `Security.tsx`,
`Sources.tsx`, `SourceLogsSheet.tsx`, `Tuning.tsx`, `Baseline.tsx` and `BaselineGauge.tsx`,
`Knowledge.tsx`, `Memory.tsx`, `Models.tsx` and `ModelsCatalog.tsx`, `BatchJobs.tsx`, `Docs.tsx`,
the editors (`EnrichmentProvidersEditor.tsx`, `NotificationsEditor.tsx`, `DangerZone.tsx`,
`CaseActivityFeed.tsx`), the top-bar pieces of `AppShell.tsx`, the first-run wizard's uppercase
labels and the Login disabled-button style (LI2). For each page the package applies, in order:
the header (§4.9.3), panels and `KpiStrip` (§4.9.2), tables, tabs and filters, formatting
(§4.9.5) and the page's findings from [uia §5] and [uib §5], which are binding change lists
(each row's "Change" column), except rows that this spec overrides elsewhere.

Specific contracts carried from the prototypes ([P-C7]):

- Cases: title column at least 280 px; Case ID 120 px with Ask AI over it on hover or focus; no
  provenance glyph in the row; one "Demo" note beside the module title instead of SAMPLE on every
  row; no Close button on closed or resolved rows and the button named "Close CASE-000048"; one
  sort (the Updated header); one count ("77 cases · all time", plus "N of M shown" only while a
  filter is on); the strip divides state from severity with a strong rule and says "81% of 77";
  Investigating in the tinted status style; no severity stripe; trimmed default columns (id,
  title, severity, status, assignee, updated; the rest under Columns). Phone: Case Manager's list
  rows, a 2-column strip, one toolbar row with search and "Filters (n)", placeholder "Search
  cases".
- Logs: "Time (UTC)" with the time only (date in a group row or tooltip), the source's short name
  in a 240 px column (full name in the tooltip), "Latest 60 events from 5 sources", the severity
  as the named level only (raw score in the tooltip), the Overview's time-range pill with Off or
  Live.
- Sources: Name takes the spare width, every other column shrinks to content; no pager for one
  page; "Sources are fixed in Demo mode" as text instead of a disabled button; "QRadar" spelled
  correctly; the add button reads "Add source".
- Campaigns: the panel title "Active campaigns"; a derived label "198.51.100.23 · 3 cases" (the
  shared entity and case count) instead of the hash, the id in the detail (D29).
- Analytics: a window caption on every tile; Needs human counted by verdict (as on Cases);
  "Resolved or closed" and active from the server's split (not total minus a count); bar
  percentages are shares of the total; "Knowledge base and memory" on the strip grammar; "MITRE"
  spelled correctly.
- Jobs: "Discounted inference" moves to Settings, Models (D30), leaving one line on Jobs
  ("Discounted inference settings moved to Settings, Models." with a link) for one release.
- Approvals and Case activity: case numbers and plain words instead of "demo-hitl-..." and
  "(verdict=NEEDS_HUMAN, risk=62.0)" or "rule=... action=..." payloads.
- Scans (D27): `#/scans` redirects to `#/case_manager` with the agent-closed filter; `Scans.tsx`
  is deleted with its tests.

#### 4.9.5 Raw values and formatting

"+18613m" (`Standup.tsx:709, 577`) becomes `fmtOverage` ("12d 22h over"); "165h"
(`Metrics.tsx:1293, 1346`) becomes `fmtDuration` ("6d 21h"); "+8124%" over target
(`Metrics.tsx` near `:1406-1409`) becomes "5d 15h over"; internal case ids become case numbers via
`caseLabel` (Audit, Approvals, chat entity); em dashes used as sentence breaks are removed
(Standup, Inbox, Dashboards edit banner, Approvals footer).

#### 4.9.6 Settings (C9 A)

- Shell (`webui/src/soc/pages/Settings.tsx`): the page header is the title "Settings" with a help
  tip and, in actions, nothing at rest. Removed: the page description and "Preferences saved"
  pill, the "CONFIGURATION · 29 sections" rail heading, the context line with breadcrumb and "No
  unsaved changes in this section", and the footer on sections with no preference keys or secrets
  (ST4). The rail's group labels are 13 px sentence case with no counts; "Appearance &
  customization" is renamed "Appearance"; "Re-run setup wizard" moves to the foot of the Settings
  rail.
- `SettingsSection` (replaces `SectionTitle`, `SectionShell`, `SettingsCard` and the embedded
  `PageHeader` uses): props `title` (from `settings-sections-meta.ts`, which is also the `h2`
  text), `help`, `actions` (Refresh for Users, Sessions and Admin sessions moves here as
  `RefreshButton`), `askTopic` ("Ask about this" in the title row), `modified` (the nav dot only;
  no "Modified" text in the header). Max width 44 rem (704 px) for form sections; table sections
  (Users, Roles, Sessions, Admin sessions, Enrichment providers) take the full content width.
- `SettingsGroup`: the group title (15 px semibold) sits above its panel on the row inset (16 px,
  20 px from 1280), an optional one-line caption, an optional trailing action; the panel holds
  `SettingRow`s divided by hairlines; 40 px between groups.
- `SettingRow`: label 14 px medium, helper 13 px muted at most 42 rem, the control at the row end
  for switches, selects and status, below the label for wide fields (text areas, tag inputs, the
  "Typed-out answers" control); below 640 px every control stacks under its label (fixes the phone
  overlap of fields drawing over labels).
- Numbers use `NumberField` at 8 rem with units ("h", "s", "(24 hours)"); field paths and
  evidence fields in 13 px mono with the placeholder "Add a field".
- Dirty state: the Settings rail shows a dot on the section; the save bar is capped to the section
  width with 72 px of room below the last row; nothing else.
- "Connected sources" in Data scope is a navigation row ("5 of 5 enabled" and a chevron) that opens
  Sources; no floating button.
- Embedded pages (Profile, Sessions, Users, Roles, Admin sessions, Security and two-factor) render
  as `SettingsSection`s (D28); Security and two-factor gets a section title and one `SettingRow`
  ("Two-factor authentication · Off · Turn on").
- Long sections (Detection, SLA, Enrichment, All settings) drop in-section anchor navigation;
  Detection and SLA split into groups; the SLA policy shows per-priority rows in one panel ("P1
  Critical · respond 15 min · resolve 240 min"); Enrichment providers become `ListRow`s with an
  on/off switch and a "Needs key" status, details in a sheet; All settings humanises schema labels
  with known acronyms (IP, URL, ID, TTL).
- Explanation boxes on Detection rules, Baseline, Memory, Secret keys and SLA become help tips
  (D26); warnings that describe a live condition stay as `Callout warning`.
- New sections (W9a, in `settings-sections-meta.ts` and `settings-sections.ts`): "Runbooks" (id
  `runbooks`, Intelligence group, every key of §4.10.19) and "Discounted inference" (id
  `discounted-inference`, Models group, moved from Jobs, D30). The Jobs page line links to
  `#/settings?s=discounted-inference` (the existing `settingsSectionHash` form).
- Measured targets ([P-C9]): first control at 367 px (Chat assistant) and 473 px (Data scope) at
  1440, switch-to-label distance at most 465 px at 1440 and 1920, zero label overlaps at 390;
  verified by the live QA harness and recorded (§8.3, §11.4).

### 4.10 Ask 9: one Runbooks feature, rebuilt (C10 B, C11 A)

#### 4.10.1 The concept and the word

- One feature, one word: **Runbooks**, under Intelligence. "Reference runbooks", "Response
  playbooks" and the hidden `catalog` page leave the Console; the word "playbook" never appears in
  rendered Console text again (§3.1).
- The definition, shown as the Runbooks page help tip and in the Help Center: "Runbooks are your
  team's step-by-step response procedures. The matching runbook is attached to each case that needs
  a person. Analysts work through it as a checklist; the AI runs the read-only lookups and can draft
  notes. A runbook never closes a case; your case policy does that."
- Three surfaces: the library and editor (`#/runbooks`), the per-case run (the Runbook tab in Case
  detail and Case Manager, plus the Next step card on the Overview tab), and the AI's use of it (the
  investigator's trusted guidance, RAG, Case chat).

#### 4.10.2 The runbook model (`backend/app/engine/runbook_model.py`, new; mirrored in `types.ts`)

Phases are a fixed vocabulary; a runbook uses any ordered subset (most need three or four).

| Phase id | Label | NIST SP 800-61r3 | SANS PICERL |
|---|---|---|---|
| `triage` | Triage | DE.AE, RS.MA-02, RS.MA-03 | Identification |
| `investigate` | Investigate | RS.AN-03, RS.AN-06 to RS.AN-08 | Identification |
| `contain` | Contain | RS.MI-01 | Containment |
| `eradicate` | Eradicate | RS.MI-02 | Eradication |
| `recover` | Recover | RC.RP-01 to RC.RP-06 | Recovery |
| `close` | Close and learn | RC.CO-03, RC.CO-04, ID.IM | Lessons learned |

```python
Severity = Literal["info", "low", "medium", "high", "critical"]
StepKind = Literal["check", "lookup", "decision", "action", "record"]
PhaseId = Literal["triage", "investigate", "contain", "eradicate", "recover", "close"]

class AppliesWhen(BaseModel):          # every present criterion is any-of; all present must match
    rule_ids: list[str] = []           # exact rule values, <= 50 items, each 1..256 chars
    mitre: list[str] = []              # T#### or T####.###; a parent matches its sub-techniques; <= 50
    entity_types: list[Literal["ip","host","user","domain","hash","url","email","process","file"]] = []
    severity_at_least: Severity | None = None
    sources: list[str] = []            # source ids, or "type:<SourceType>"; <= 20
    verdicts: list[Literal["TRUE_POSITIVE","FALSE_POSITIVE","NEEDS_HUMAN"]] = []
    statuses: list[str] = []           # CaseStatus values; <= 10
    any_tags: list[str] = []           # <= 20, each <= 64
    min_event_count: int | None = Field(default=None, ge=1, le=1_000_000)
    always: bool = False               # only the Generic incident fallback; lowest specificity

class LookupTemplate(BaseModel):
    tool: Literal["log_stats", "log_search", "enrich", "related_cases", "campaign", "mitre"]
    filter: dict[str, str] = {}        # field -> literal or one {{template value}}; <= 8 entries
    group_by: list[str] = []           # log_stats only; <= 2 fields
    indicator: str | None = None       # enrich only: one {{template value}}
    window: str = "case_first_seen-1h..case_last_seen+1h"   # or a Round 12 window token; span <= 30 days
    limit: int = Field(default=20, ge=1, le=50)              # log_search rows are capped at 20
    run: Literal["on_attach", "on_demand"] = "on_attach"

class DecisionOption(BaseModel):
    id: str                            # slug, unique in the step
    label: str                         # <= 80
    marks_not_applicable: list[str] = []   # later step ids this option skips

class RunbookStep(BaseModel):
    id: str                            # slug, unique in the runbook, stable across versions
    phase: PhaseId
    kind: StepKind
    title: str                         # <= 160; Checks are written as questions
    instructions: str = ""             # restricted Markdown, <= 2,000
    focus: str | None = None           # <= 300, "which fields to look at"
    escalate_if: str | None = None     # <= 300, check and decision steps
    benign_if: str | None = None       # <= 300
    required: bool = True
    evidence: Literal["none", "note", "note_or_attachment"] = "none"
    owner_role: str | None = None      # a built-in role name or a custom role id
    approval_role: str | None = None   # action and record steps; honoured only when step approvals are on
    target_minutes: int | None = Field(default=None, ge=1, le=10_080)   # shown, never enforced
    lookup: LookupTemplate | None = None        # lookup steps only (required there)
    options: list[DecisionOption] = []          # decision steps only, 2..6 options
    react: str | None = None           # RE&CT id, for example RA3101
    d3fend: str | None = None          # D3FEND technique id, for example D3-AL

class RunbookDefinition(BaseModel):
    id: str                            # built-ins: ^[a-z0-9][a-z0-9-]{1,62}$ (kebab-case)
                                       # operator runbooks: ^[a-z0-9][a-z0-9_-]{0,63}$ (the legacy
                                       # grammar of playbooks/manifest.py:22 and engine/runbooks.py:84,
                                       # so migrated ids such as brute_force_login stay valid)
                                       # reserved, never an id: new, metrics, validate, import,
                                       # progress, match-preview, lookup-test, reindex, readme, index
    title: str                         # <= 120
    summary: str                       # <= 280
    use_when: str = ""                 # <= 500, plain language scope shown to analysts
    prerequisites: str = ""            # <= 500
    applies_when: AppliesWhen
    priority: int = Field(default=50, ge=0, le=100)
    mitre: list[str] = []              # techniques the runbook covers (coverage views)
    phases: list[PhaseId]              # ordered, 1..6, each used by at least one step
    steps: list[RunbookStep]           # 1..40
    retrieval_queries: list[str] = []  # companion retrieval for the investigator, <= 5, each <= 200
    owner: str | None = None
    review_every_days: int = Field(default=180, ge=30, le=730)
    references: list[str] = []         # https links only, <= 10
```

Validation (one function, `validate_runbook(defn) -> list[Issue]`, used by the editor's live check,
the import, the migration and publish): every rule above (a reserved id is
`422 runbook_id_reserved`); every `{{value}}` is from the closed set
of §4.10.8; decision options reference existing later step ids; an action step has no lookup; the
investigator rendering fits the budget (§4.10.9); total Markdown source at most 64 KiB. An `Issue`
is `{path, code, message}`; messages are plain sentences ("Step 'How many accounts were tried?'
uses {{entity.ipaddr}}, which is not a case value. Use {{entity.ip}}."). A brand-new runbook starts
with zero issues shown: required-field issues appear only after the author leaves a field or tries
to save (fixes "17 fixes" on open).

#### 4.10.3 The five step kinds

| Kind | Who does it | What the run records | Copy on the step |
|---|---|---|---|
| Check | a person verifies something | status, note, optional evidence link; "Escalate if" and "Benign if" shown as a pair | "Your note" |
| Lookup | the suite runs a declarative read-only query | the result attached as evidence labelled "Collected automatically", the resolved parameters, when, by whom ("Agentic SOC" or the person who pressed Run) | "Read-only. Log values are shown as untrusted data." |
| Decision | a person picks an option | option, who, when; options may mark later steps Not applicable (only steps still To do) | "Recording a decision does not change the verdict or close the case." |
| Action | a person acts in another system | who, when, where (system or ticket reference, at most 200 characters), outcome (at most 500); optional second-person approval | "Agentic SOC does not run this action. It keeps the record." |
| Record | a person notifies, documents or hands off | as Action | "Agentic SOC does not send this. It keeps the record." |

Step status values: `todo` (To do), `in_progress` (In progress), `done` (Done),
`not_applicable` (Not applicable, needs a reason of 1 to 500 characters), `blocked` (Blocked, needs
a reason). "Waiting for approval" is a derived display state of a recorded Action whose approval is
pending. Done counts only `done`; Not applicable is counted on its own and never as done.

#### 4.10.4 Applies when, selection and Why attached (`backend/app/engine/runbook_match.py`, new, pure)

- `match(case_facts, catalog) -> MatchResult`: a pure function over a frozen `CaseFacts`
  (rule values, entity types, severity, source ids and types, verdict, status, tags, event count,
  MITRE techniques) and the catalog of matchable versions (every Published operator runbook, every
  built-in not replaced by a Published operator copy, never drafts, in review or retired).
- Specificity tiers: 3 when `rule_ids` matched; 2 when `mitre` matched and the runbook has no
  `rule_ids`; 1 when only other criteria matched; 0 for `always` (the fallback). The winner is the
  highest tier, then the highest `priority`, then the most matched criteria, then the newest
  `published_at`, then `id` ascending. Ties that survive to the `id` rule are reported in the
  explanation ("2 runbooks matched equally; the first by name was chosen").
- `MatchResult {winner, explanation, candidates[]}`; the explanation is structured
  `{tier, matched: [{criterion, value}], missed: [{criterion, expected, actual}], tie: bool}` and
  rendered by the client as "Matched rule ssh_auth_failed and technique T1110", with every criterion
  listed in the Why attached popover and the selection rules behind "How matching works".
- `near_misses(case_facts, runbook)`: the criteria that failed, used by the editor's match preview.
- When it runs ($0, no model, #6):
  - **Investigator guidance**: per cluster before investigation (rule values, entities, severity,
    source, event count, tags; MITRE when the cluster carries it). The winner's investigator
    rendering enters the prompt (§4.10.9).
  - **Attachment** (when `runbooks.auto_attach`, D32): after the pipeline's decision leaves the
    case open (any non-terminal status: the case needs a person) **and is not a pending automatic
    close** (a false-positive close waiting out its objection window is non-terminal but is not
    attached; if the objection window ends with the case reopened or escalated instead, the
    status-change trigger below attaches then); again when the case changes (severity raised,
    verdict changed by a re-investigation, status moves to escalated, tags change), which is the
    second evaluation after the verdict (D43). Auto-closed cases, including those closed at the end
    of an objection window, never get a run. Every re-evaluation hook is A7c's (the tag and action
    routes in `routes.py`, the `case_tag` and `case_lifecycle` jobs in `engine/jobs.py`, and
    whatever path ends an objection window by reopening or escalating, which A7c locates and names
    in its progress file); A8a wires only the post-investigation trigger in `pipeline.py`;
    each trigger has its own test. Attachment is idempotent per `(case_id, runbook_id)` (#4): a runbook attaches to a case at
    most once; a re-evaluation attaches another runbook only when its tier is higher than every run
    already on the case; it never removes or replaces a run. The fallback attaches only when
    nothing else matched and the case has no run (D33).
  - Re-investigation never creates a second run of the same runbook.

#### 4.10.5 Governance, states and versions

- Version states: `draft`, `in_review`, `published`, `superseded`, `retired`. One draft and at
  most one published version per runbook at a time. Editing a published runbook creates a draft
  (D39); publishing the draft makes it the live version and the previous live version
  `superseded`.
- Transitions and grants: create, edit, discard draft, duplicate, import, submit for review,
  restore an old version as a draft, retire: `runbooks:manage`. Publish, reject (back to draft
  with a reason), un-retire, Mark reviewed: `runbooks:publish`. When
  `runbooks.require_distinct_approver` is on (default off, D35) the publisher must differ from the
  version's author; otherwise a publisher may publish a draft directly.
- Review: `review_due_at = last_reviewed_at + review_every_days` (E6: default 180 days); "Review
  due" shows from that date; "Mark reviewed" records reviewer and time without a new version.
  Imported content is due immediately (D38).
- Versions are immutable: `{version, state, content_hash (SHA-256 of the canonical definition),
  source (Markdown), author, created_at, submitted_by/at, published_by/at, superseded_at,
  retired_by/at, review notes}`. History shows every version with who published it, a step-level
  diff between any two versions (client-side over step ids), and "Restore as draft".
- Built-ins: read-only, versioned by the release (`version` in front matter). "Duplicate to
  customise" creates an operator runbook (`<id>-custom`, then `-2`, `-3`), `derived_from: {id,
  version}` and `replaces: <built-in id>` (default true); when the copy is Published, the built-in
  stops matching and is listed under "Show replaced built-ins".
- Retire: the runbook stops matching; runs that used it keep working and stay readable. A draft
  that was never published can be discarded; published history is never deleted.
- Limits: 200 operator runbooks; 100 versions per runbook; 40 steps per runbook.

#### 4.10.6 Storage (KV only, #12)

All new state uses the shared KV store (no new index or table). On Elasticsearch every document
uses fixed `runbook_`-prefixed field names holding one opaque canonical-JSON string (the reports
store rule, `stores/reports.py:1-30`), so runbook content never grows the shared mapping. Writes
are strict compare-and-set on `_rev` followed by a confirming read; a storage failure raises and
the request fails (no pretend success).

| Namespace (constant) | Key | Fields | Content | Bound |
|---|---|---|---|---|
| `runbook_library` (`RUNBOOK_LIBRARY_NS`) | `index` | `runbook_index_json` | list of runbook summaries (id, title, origin `operator \| imported`, live version, draft version, in-review version, retired, replaces, derived_from, owner, review_due_at, updated_at/by, migrated_from) | 200 entries |
| `runbook_library` | `rb:<id>` | `runbook_doc_json` | every version of one runbook (definition, source, metadata) | 100 versions, 2 MiB |
| `runbook_library` | `migration` | `runbook_migration_json` | the one-shot migration marker (§4.10.17) | 1 |
| `runbook_runs` (`RUNBOOK_RUNS_NS`) | `case:<case_id>` | `runbook_runs_json` | every run on one case (§4.10.7), including live step progress and step durations | 5 runs, 1 MiB, of which lookup evidence at most 512 KiB |
| `runbook_runs` | `ledger:<yyyy-mm>` (UTC month of `started_at`) | `runbook_ledger_json` | one compact row per run, written **only on run-level transitions** (attach, complete, abandon, version switch): `{run_id, case_id, runbook_id, version, attached_by, started_at, completed_at, status, total, required_total, skipped_step_ids, step_durations}` (the last two filled at completion from the run document) | 512 KiB per month document; rows past the cap are counted in `evicted` and the metrics say `partial`; months older than 13 are deleted on write |

**Write traffic and bounds.** A step update, a step evidence write and an AI draft write touch only
that case's document; no step-level write touches the ledger, so concurrent analysts on different
cases never contend. A strict CAS conflict on a case document is retried up to 3 times with a fresh
read when the change does not depend on the conflicting field (a background lookup result, a run
completion stamp); a user's step update with a stale `expected_revision` is never retried and
returns `409 runbook_conflict`; three failed retries return `503 runbook_store_unavailable`. The
evidence budget keeps every case document under 1 MiB: before writing a lookup result the store
measures the document's evidence bytes; a re-run of a lookup **replaces** the previous automatic
result for that step (the step shows "Ran again at 14:31; the earlier result was replaced"); a
write that would still exceed 512 KiB of evidence stores the result with its `table` dropped and
the note "Table not kept: this case has reached its evidence limit." (count and facts kept).

Built-in runbooks are package data under `backend/app/runbooks/library/*.md` (12 files, §4.10.14),
loaded once and cached, never stored. Free-form Case tasks keep `CaseTaskStore`
(`stores/case_tasks.py`, unchanged storage) and render inside the Runbook tab as "Other tasks"
(D36, E7). Factory reset clears both new namespaces (the factory tier already wipes the whole KV
surface, `engine/reset.py:243-272`); the cases tier also clears `runbook_runs` (runs belong to
cases); the sources tier keeps both. The legacy namespaces `playbooks` and `runbooks` are read-only
for one release (§4.10.16), read only through `backend/app/stores/legacy_procedures.py` (new, A7a:
a read-only decoder of both legacy namespaces using a raw KV `list_strict()` and the existing
decode rules, with no write method), which the migration and the legacy export groups use, so A8c
can delete `stores/playbooks.py` and `engine/runbook_service.py` without breaking either; a test
runs the migration with `app.stores.playbooks` absent.

#### 4.10.7 Per-case runs

```python
class StepEvidence(BaseModel):
    kind: Literal["lookup_result", "link", "ticket"]
    lookup: LookupResult | None = None   # kind == lookup_result
    url: str | None = None               # https only, <= 500
    label: str | None = None             # <= 120

class LookupResult(BaseModel):
    tool: str; params: dict[str, str]    # resolved values, plain strings (untrusted)
    window_from: str; window_to: str; ran_at: str; ran_by: str   # "agentic_soc" or a user name
    status: Literal["ok", "empty", "partial", "error", "not_applicable"]
    reason: str | None = None            # for example "This case has no source IP"
    count: int | None = None; count_relation: Literal["eq", "gte"] = "eq"
    facts: list[dict[str, str]] = []     # <= 8 label/value pairs
    table: dict | None = None            # {columns <= 6, rows <= 20, cells <= 200 chars}
    table_kind: Literal["aggregate", "rows"] | None = None
                                         # "aggregate": log_stats-style counts per key;
                                         # "rows": log_search raw log rows, shown to people only
    window_clamped: bool = False         # window_to was cut to ran_at (data not yet collected)

class StepState(BaseModel):
    status: Literal["todo", "in_progress", "done", "not_applicable", "blocked"] = "todo"
    assignee: str | None = None
    started_at: str | None = None; completed_at: str | None = None; completed_by: str | None = None
    note: str = ""                       # <= 4,000, plain text
    reason: str | None = None            # not_applicable and blocked, 1..500
    evidence: list[StepEvidence] = []    # <= 10
    decision: dict | None = None         # {option_id, label, by, at}
    action_record: dict | None = None    # {performed_by, performed_at, where, outcome}
    approval: dict | None = None         # {required_role, status: pending|approved|rejected, by, at, reason}
    ai_draft: dict | None = None         # {text <= 2,000, created_at, model, usage_id, confirmed: bool}
    revision: int = 0

class RunbookRun(BaseModel):
    run_id: str                          # "run-<uuid>"
    case_id: str; runbook_id: str; version: int; title: str
    snapshot: RunbookDefinition          # the pinned version, so the run renders without the catalog
    attached_by: Literal["rule", "fallback", "person", "suggestion"]
    attached_reason: dict                # the match explanation, or {by: <user>, note}
    attached_at: str; attached_actor: str
    status: Literal["active", "completed", "abandoned"] = "active"
    completed_at: str | None = None; abandoned_reason: str | None = None
    steps: dict[str, StepState]
    revision: int = 0

class RunbookProgress(BaseModel):
    done: int; not_applicable: int; total: int; required_open: int; blocked: int; waiting: int
```

- A run pins its version (Splunk SOAR: changes apply only to future uses). When a newer version is
  published the run shows "A newer version exists (v5)" with "Switch to v5", which carries over the
  state of every step whose id exists in both versions and resets the rest; switching is audited.
- A run completes when every required step is Done or Not applicable; it can be abandoned with a
  reason. Completion and abandonment never change the case (#3).
- Free-form tasks (`CaseTask`) list under "Other tasks" in the same tab with "Added by Asha"
  provenance; "Add task" stays.
- Progress chip text: "4/11" (done over total); with blocked steps "5/9 · 1 blocked"; with
  pending approvals "4/11 · 1 waiting". Shown in the case header, on the Runbook tab trigger and in
  the Case Manager queue. Progress is computed from the case documents (`RunbookProgress` is
  derived on read, never stored in the ledger).

#### 4.10.8 Lookups (`backend/app/engine/runbook_lookup.py`, new)

- The closed set of template values: `{{case.rule}}` (the primary rule value), `{{case.source_id}}`,
  `{{case.first_seen}}`, `{{case.last_seen}}`, `{{entity.ip}}`, `{{entity.user}}`, `{{entity.host}}`,
  `{{entity.domain}}`, `{{entity.hash}}`, `{{entity.url}}`, `{{entity.email}}`. Each resolves from
  the case's stored entities and is validated against its kind's grammar; a missing or invalid
  value makes the lookup `not_applicable` with a plain reason ("This case has no source IP").
- Values are bound as structured parameters (`StructuredQuery` filters, the enrichment
  indicator), never concatenated into query text; field names in `filter` and `group_by` come only
  from the runbook text (trusted after publishing) and are validated against the evidence-fields
  grammar (`app/evidence_fields.py`).
- Tools and paths, all read-only: `log_stats` and `log_search` through the read-only log client and
  the connectors' `aggregate()` and browse paths (#1); `enrich` through the cached enrichment path
  (#8); `related_cases` through the case store (cases sharing the entity in the window, at most 10);
  `campaign` through the campaign store; `mitre` through the bundled ATT&CK lookup.
- Bounds: window span at most 30 days; `log_search` at most 20 rows (a `table_kind="rows"` table
  of at most 6 columns); `log_stats` top at most 50 keys; each lookup times out at 45 s (the chat
  `tool_timeout_s` default after ask 5); at most 2 lookups at once per run.
- **Window clamp**: `window_to` is `min(resolved window_to, ran_at)`; when it was cut,
  `window_clamped` is true, the result reads "Searched up to collection, 14:31 UTC", and once the
  resolved end has passed the step offers "Run again" (an `on_demand` run, which replaces the
  automatic result). An empty result inside a clamped window never reads as "no success after the
  failures".
- **Grants for lookups**, to run and to view: `log_stats` and `log_search` need `sources:read`
  (as `GET /api/logs` does); `enrich` needs `enrichment:read` (the grant the enrichment routes use);
  `related_cases` and `campaign` need `cases:read`; `mitre` needs only `runbooks:read`. A viewer
  without the grant sees the step and its status, and in place of the evidence "You do not have
  access to log data." (or "... to enrichment results.", "... to cases."); the run endpoint returns
  `403` for that tool. Background `on_attach` lookups run as the system actor and are stored; what
  is redacted is the reading, per viewer.
- `on_attach` lookups run in the background right after attachment (an in-process task under the
  run's lease, never a model call, $0); `on_demand` lookups run on "Run lookup". Each result is
  stored as `StepEvidence(kind="lookup_result")` and audited (`step.evidence_collected`).
- Results are untrusted (#9): rendered as plain text. **What a model may receive (#7)**: a
  lookup's `count`, `count_relation`, `facts` and `table_kind="aggregate"` tables only, inside the
  untrusted fence. A `table_kind="rows"` table (raw log rows from `log_search`) is reduced by code
  before any prompt to its row count and, per column, the top 3 values with counts; no cell text of
  a row table ever reaches a draft, a suggestion, Case chat or any other prompt. Test (A7c and
  A8b): a gateway spy over a draft, a suggestion and a Case chat `get_case` turn on a case whose
  run holds a `log_search` result with marker cell values asserts no marker reaches any prompt.

#### 4.10.9 How a Published runbook reaches the investigator

- `backend/app/agents/prompts.py`: the `<<<PLAYBOOK>>>` block (`:479-494`) is replaced by a
  `<<<RUNBOOK>>> ... <<<END_RUNBOOK>>>` block under the heading "Active runbook (TRUSTED operator
  procedure, published and reviewed; advisory only)". Only a Published version (or a built-in) ever
  fills it; drafts, in-review versions and AI text never do (D39, #9).
- The investigator rendering (`render_runbook_prompt(version) -> str`, `runbook_model.py`):
  "<title> (v<n>)", the summary, `use_when`, then for each Triage and Investigate step its kind,
  title, `focus`, `escalate_if` and `benign_if`, then one line per later phase listing its step
  titles. Instructions bodies are not included (they are for people). This is why the migration
  (§4.10.17) moves each legacy section's guidance into the step's `focus`: a migrated runbook reaches
  the investigator through its focus, escalate and benign lines, never through instructions.
- **Budget: 3,000 characters** (E10), one constant `MAX_RUNBOOK_PROMPT_CHARS` used by validation
  and by the prompt. The prompt never truncates: an over-budget operator version cannot be
  published (`422 runbook_prompt_budget` with the measured length), the editor shows the meter
  "Investigator guidance: 2,140 of 3,000 characters" in Preview, and
  `backend/tests/test_runbook_library.py` asserts every bundled runbook renders within the budget
  with no truncation (fixing the three truncated playbooks).
- Precedence wording in the investigator system prompt (`prompts.py:656-662`): deterministic policy
  > base role rules > runbook > operator MEMORY > untrusted evidence.
- `retrieval_queries` become retrieval groups `runbook:1..n`, interleaved with the cluster query
  as `playbook:1..n` are today (`agents/graph.py:160-200`).
- Provenance: a `DECISION` audit row by the new actor `runbook_selector` (`tool_input.runbook_selection`
  with the match explanation) and a `CONTEXT` row by `procedure_provenance` recording selected
  versus consulted; `Case.runbook_id` and `Case.runbook_version` (new, nullable) are assembled where
  `Case.playbook_id` is today (`pipeline.py:891`); `playbook_id` stays readable and is never written
  by new code. The case rationale reads both old and new actors forever.
- The marker normaliser (`prompts.py:66-127`) already neutralises any `<<<NAME>>>` token; this
  round pins `RUNBOOK` to the neutral tag `<rb>` beside `PLAYBOOK`'s `<pb>`
  (`test_marker_normaliser.py:122-195` extended), and `chat_protocol.py:1635` recognises
  `end_runbook` beside `end_playbook`.
- The cheap router still sees no runbook (`agents/router.py:53-61`).

#### 4.10.10 The AI's role and limits

| The AI may | The AI never |
|---|---|
| Suggest a runbook when nothing but the fallback matched, on a person's click ("Suggest a runbook" in the Start runbook picker; one gateway call, #6; `runbooks.ai_suggest`, default on as a button) | Attach a runbook by itself |
| Draft a note for a Check step from the step's lookup results, on a click ("Draft note"; one gateway call; `runbooks.ai_step_drafts`, default on as a button), labelled "AI draft" until a person confirms it | Mark any step Done, Not applicable, Blocked or Approved |
| Answer "what is next on this case" and "summarise runbook progress" in Case chat (the `get_case` tool returns the run summary: title, version, progress, the next step's title, required steps open) | Change the verdict, the status, `AutoClosePolicy` or `decide()` (#3) |
| Receive Published runbook text as trusted guidance (§4.10.9) | Treat its own drafts as trusted, or publish anything |

- Both AI calls go through the one gateway, are ledgered and budget-gated (the daily AI budget; a
  blocked call shows "The AI budget for today is used up." and nothing changes); each offers the
  existing dry-run estimate on hover.
- Inputs to a draft: the step's title, focus, escalate and benign text (trusted, Published), and the
  step's lookup results reduced as §4.10.8 says (count, relation, facts and aggregate tables; a row
  table only as its row count and top values per column), fenced as untrusted (#7, #9). The Case
  chat `get_case` run summary follows the same rule. Case values, notes and log values are always
  fenced. The draft prompt is a new template in `prompts.py`; its output is plain text at most
  2,000 characters, never rendered as HTML.
- Demo Mode: the Demo planner plays the model for suggestions and drafts, deterministically, $0.

#### 4.10.11 The run inside a case (C10 B)

Owned by `webui/src/soc/pages/casedetail/RunbookPanel.tsx` (new, lazy) and its parts under
`webui/src/soc/runbooks/run/` (new).

- **Where**: a "Runbook" tab, second in Case detail and Case Manager, its trigger carrying the
  progress chip ("Runbook 4/11"); the Next step card repeated at the top of the Overview tab
  (primary action "Review draft" when an AI draft waits, otherwise "Open runbook"); a "Runbook"
  section in the facts rail from 60 rem of pane width (phases in a two-column grid with counts,
  never truncated); the queue chip in Case Manager (one tab stop per row, live from the progress
  endpoint).
- **Runbook strip** at the top of the tab: title, "v4", how and when it attached ("Matched
  automatically · 12:52 UTC", "Fallback", "Added by Asha Rao", "Suggested by the AI, accepted by
  Asha Rao"), a "Why attached" popover (24 rem: the matched criteria, every criterion, the pinned
  version, "How matching works" disclosure), "Add runbook" and a More menu (Switch version when a
  newer one exists, Abandon run, Export as Markdown). Under 640 px of pane width the strip collapses
  to one line ("Brute force and password spray · v4", the Why attached icon, the menu).
- **Progress line**: "4 of 11 steps done · 1 not applicable · 5 required open · 1 waiting"; short
  form under 640 px "4 of 11 done · 5 required open · 1 waiting".
- **Next step card** (pinned on top, C10 B with C's card): a 3 px primary rail on the left and a
  neutral border; the step's phase and kind, its title as an `h3` (`tabIndex=-1` so focus can land
  on it), its focus line, the Escalate if and Benign if pair, the lookup evidence summary if any,
  the AI draft (labelled "AI draft · not part of the case until you confirm it") with Confirm, Edit
  note and a More menu (Not applicable, Blocked), or for a Decision the options as radio buttons
  and "Record decision" (disabled with the hint "Pick an option to record the decision."). After
  Confirm, Mark done or Record decision, focus moves to the new Next step heading (`preventScroll`
  then `scrollIntoView({block: "nearest"})`) and a polite live region says "Step 5 done. Next, step
  6: Is this a confirmed compromise?". When every required step is done the card says "All
  required steps are done." with "Close case" (opens the close dialog) and the remaining optional
  steps listed.
- **Phase tabs** (Radix Tabs, one tab stop, arrow keys): one tab per phase with "Triage 3/3",
  "Investigate 1/4", "Contain 0/2" and a 6 px amber dot when a step waits for approval; the dot's
  fact is in the tab's accessible name ("Contain, 0 of 2 done, 1 waiting"); the
  selected tab uses `bg-accent` with a neutral border; the default selected phase is the Next
  step's phase. Below them, only that phase's steps.
- **Step rows**: a status mark (to do, in progress half disc, done, not applicable, blocked,
  waiting for approval), the title, kind chip, assignee and "Optional" for non-required steps; the
  whole row is a disclosure button (two tab stops per row: the row and its primary action); the
  Next step appears in the list as one line "Shown above". An opened row shows Instructions,
  Focus, Escalate if and Benign if, Evidence ("Collected automatically" lookup results with facts
  and a table, "Read-only. Log values are shown as untrusted data."; or a "Run lookup" box), the AI
  draft, Your note (a textarea, saved on blur and with Save), the recorded decision or action
  ("Recorded by Asha Rao at 14:31 UTC"), approval ("Asha Rao recorded this action, so a different
  incident lead approves it." with Approve disabled and the hint "Only an incident lead other than
  Asha Rao can approve." for the recorder), and the buttons Mark done, Not applicable (asks a
  reason), Blocked (asks a reason), Assign, and Reopen step (a ghost button in the footer).
- **Decisions** mark only steps still To do as Not applicable with the reason "Skipped by the
  decision 'Benign'"; a recorded action keeps its record and approval.
- **Other tasks** under the phases: today's case tasks with "Added by" provenance and "Add task".
- **Empty state** (no run): "No runbook is attached to this case." with "Start runbook" (filled,
  centred) and the line "Rules with no runbook are listed on the Runbooks page."; the header Start
  runbook button is outline.
- **Start runbook picker** (a dialog with a searchable list): the best match pre-selected with its
  explanation, then "Other matches", then "Fallback" (Generic incident), then "All published
  runbooks"; the list fades at its bottom edge when it scrolls; a preview pane of the selected
  runbook's phases; an optional note; "Suggest a runbook" (AI, when enabled) adds a "Suggested by
  the AI" entry with its reason that a person must select; Start.
- **Close dialog with required steps open** (D34): the real `DispositionPicker` (opens empty, six
  outcomes, keys 1 to 6, focused on open), then the open required steps listed by title with their
  status on a second line, and the field "Why are you closing with required steps open?" (1 to 500
  characters, required); the footer reads "Pick a disposition." until one is chosen; the sentence
  "Automatic closes never look at runbook steps." under the field.
- **States**: loading skeleton rows; `LoadError` with Retry; a stale revision on save ("This step
  changed since you opened it. Showing the latest.", the edit kept in the field); permission
  without `runbooks:run`: read-only rows and the line "You can view this runbook but not update
  it."; Demo Mode identical (Demo store).
- **Phone**: the strip on one line, the Next step card first with full-width Confirm, phase tabs
  scroll horizontally with an edge fade, rows full width, Confirm above the fold at 390 by 844.
- Measured targets ([P-C10]): Confirm at y 567 or less at 1440 by 900, y 768 or less at 390 by 844
  (live QA harness, recorded in §11.4); 19 or fewer Tab stops inside the tab (Vitest).

#### 4.10.12 The library and the editor (C11 A)

Owned by `webui/src/soc/pages/Runbooks.tsx` (rewritten) and `webui/src/soc/runbooks/editor/`
(new, lazy).

- **Library** (`#/runbooks`): header "Runbooks" with the definition as its help tip; controls none;
  actions "New runbook" (`runbooks:manage`) and More ("Import Markdown", "Export all as Markdown").
  A `KpiStrip`: Published runbooks, Runs (30 days), Completed, "Cases with a runbook 71%" over
  "52 of 73 human-handled cases", Needs attention (review due plus in review). Then one table panel:
  Name (title, and a muted line with the summary and the origin "Built-in", "Yours" or "Imported"),
  Applies to (rule and technique chips, "+3"), State ("Published v4", "Draft v5", "In review",
  "Retired"; a `StatusDot` only for exceptions), Steps ("4 phases · 11 steps"), Runs (30 days),
  Review due ("in 4 days", "Overdue"). Filters: search, State, Origin, the switch "Show replaced
  built-ins". Below: two panels, "Rules with no runbook" (rules seen in the last 30 days that no
  Published runbook matches, from the metrics endpoint, each a `RuleLink`) and "Recent runs" (case
  number, runbook, status, who, duration). The run figures of the strip, the Runs column and both
  panels come from case-derived reads (`GET /api/runbooks/metrics` needs `cases:read`, §4.10.15);
  without that grant they show "You do not have access to cases." and the rest of the page works.
  Phone: stacked rows, no sideways scroll. The one-time
  migration `Callout intro` (§4.10.17) sits above the strip until dismissed.
- **Editor** (`#/runbooks?id=<id>` and `#/runbooks?id=new`; `id` added to `DEEP_LINK_KEYS` by W3
  with the validator `^[a-z0-9][a-z0-9_-]{0,63}$`; `new` is reserved, so no runbook can have it,
  §4.10.2):
  - Header: the title (`h1`), the governance strip on one line: "Draft · v5 by you", "In review
    · needs a second person", "Published · v4 is live", "Retired · read only", plus "3 open cases
    stay on v4", "Review due Oct 29, 2026" and the owner; actions by state: Save, Send for review,
    Publish (with `runbooks:publish`), History, and More (Discard draft, styled destructive, with a
    confirm; Duplicate; Retire; Export as Markdown).
  - Applies when as chips under the header with a picker per criterion (rules from the rule
    catalogue and recent case rules, techniques from the bundled ATT&CK corpus, severity, entity
    types, sources, verdicts, statuses, tags, minimum events).
  - Edit view: an outline of phases and steps on the left (reorder by drag or Alt+Up and Alt+Down,
    "Add step" by kind from a menu, "Optional" shown as a word), the selected step's form on the
    right (kind, title, instructions, focus, escalate if, benign if, required, evidence, owner role,
    approval role, target time, RE&CT and D3FEND ids; for a Lookup: tool, filters with case values
    as chips, group by, limit, window, when it runs, the boundary line "Read-only. Case values are
    passed as parameters; results are untrusted.", and "Test with a case" that runs the lookup
    against a chosen case without saving anything, through `POST /api/runbooks/lookup-test`
    (§4.10.15); for a Decision: options and the steps each one
    skips). Below 1680 px two columns so the step form is wide; from 1680 px a third column holds
    the match panel.
  - "Preview as analyst": the run view as an analyst will see it, with "Fill with CASE-000214"
    resolving the template values, and the investigator guidance meter (§4.10.9).
  - "Source": the Markdown of §4.10.13, editable; edits validate live and the outline follows;
    "Chips and front matter are the same fields; edit either."
  - Live validation lists issues beside the fields they belong to and in a summary; Publish is
    disabled with the count ("Fix 2 problems to publish").
  - "Which cases would this match?": a summary line ("Gets it 6 · Another wins 3 · Near misses 5")
    that opens a sheet below 1680 px and is a side column from 1680 px; groups Gets it, Another wins
    (naming the winner), Near misses (the failing criterion); icons CircleCheck, Circle and
    CircleMinus with a legend; "Show all 14"; the note "Nothing is attached and no metric changes."
    It runs `POST /api/runbooks/match-preview` over the last 500 cases of the last 30 days.
  - History: a sheet listing every version with who published and approved it, a step-level diff
    between any two versions, and "Restore as draft".
  - A built-in opens read-only with the badge "Built-in" and "Duplicate to customise"; Preview and
    Source work.
- Accessibility: the outline is a tree (`role="tree"`, arrow keys, Enter selects); the form fields
  use `Field`; issues link to their field; focus returns to the outline item after a move.
- States: library loading uses the shared skeleton rows inside the table panel; an empty operator
  list still shows the 12 built-ins (there is no empty library); a filter with no match shows
  `EmptyState state="no-results"` ("No runbooks match these filters." with "Clear filters"); a
  load failure shows `LoadError` with Retry; without `runbooks:manage` the New runbook and Import
  actions are hidden and every runbook opens read-only (Preview and Source still work); a save
  conflict shows "Someone else changed this draft. Reload it to see their changes." with Reload
  (the local edit is kept in the Source view until reloaded); Demo Mode shows the same (real)
  library read-only with Demo runs, the editor's write actions disabled with "Runbooks cannot be
  edited in Demo Mode." (§3.5); at 390 px the editor shows the outline first and the step form as
  a full-screen sheet, and the match panel as a sheet.
- Motion: sheets and the history panel use the side-pane timings of §3.2; reordering a step
  moves it instantly (no drag animation under reduced motion).

#### 4.10.13 Markdown source format (native, import and export)

One file per runbook: front matter, then phase headings, then step headings with an attribute
list and recognised key lines. Parsing is dependency-free (a strict subset: scalars, flow lists,
block lists and one level of nested mapping), like today's `parse_frontmatter`.

````markdown
---
id: brute-force-password-spray
title: Brute force and password spray
summary: Many failed sign-ins against one or more accounts, from one or many sources.
use_when: A detection reports repeated failed authentication against our accounts.
version: 4
priority: 60
owner: soc-leads
review_every_days: 180
mitre: [T1110, T1110.003]
applies_when:
  rule_ids: [ssh_auth_failed, win_logon_failure_burst]
  mitre: [T1110]
  entity_types: [ip, user]
references:
  - https://attack.mitre.org/techniques/T1110/
---

## Triage

### Is the source internal or external? {#source-scope kind=check}
Focus: source IP, its network zone and the asset inventory.
Escalate if: the source is an internal host that is not an approved scanner.
Benign if: the source is an approved vulnerability scanner or a known test.

Look the source up in the asset inventory before anything else.

### How many accounts were tried? {#accounts-tried kind=lookup}
```lookup
tool: log_stats
filter:
  source.ip: "{{entity.ip}}"
  event.outcome: failure
group_by: [user.name]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

## Investigate

### Is this a confirmed compromise? {#decide kind=decision}
Options:
- confirmed: Confirmed compromise
- suspicious: Suspicious, unconfirmed
- benign: Benign | skips: block-source, reset-credentials

## Contain

### Block the source at the edge {#block-source kind=action optional react=RA3101 d3fend=D3-NI}
Record where you blocked it (firewall, WAF or ticket number).
````

- Heading attributes: `#<step id>` (required), `kind=` (required), `optional`, `owner=<role>`,
  `approval=<role>`, `evidence=note|note_or_attachment`, `target=<n>m|<n>h`, `react=`, `d3fend=`.
- Key lines at the start of a step body: `Focus:`, `Escalate if:`, `Benign if:`, `Options:` (a
  list of `<id>: <label>` with an optional `| skips: <ids>`). The rest is instructions in restricted
  Markdown (paragraphs, lists, bold, italics, inline code, links to https only; no HTML, no images,
  no headings inside a step).
- A fenced ```` ```lookup ```` block holds the lookup template (Lookup steps only).
- `version` in front matter is **metadata outside the definition** (`RunbookDefinition` has no
  `version` field): export writes the version it exported; import accepts and ignores it (an import
  is always a new Draft); bundled files must carry it and the loader reads it into the built-in's
  summary (`RunbookSummary.live_version`), which is where a built-in's release version lives. The
  parser lists `version` among the accepted keys, so it never raises an unknown-key issue.
- Export writes exactly this form; import accepts it and always lands as a Draft (#9); unknown keys
  are reported as issues, never silently dropped. The round-trip test (§4.10.21) is parse, export,
  parse with the definitions equal and `version` ignored. CACAO v2.0 JSON is later (D42).

#### 4.10.14 The built-in library (12 runbooks, `backend/app/runbooks/library/`)

Each merges today's bundled files (whose rule ids, entity types and techniques become its
`applies_when`, the union of the merged files' `match.rule_ids` and `applies_to_rules`), uses the
"question, focus, implication" step shape, folds today's TRUE POSITIVE, FALSE POSITIVE and NEEDS
HUMAN content into `escalate_if` and `benign_if`, and fits the prompt budget. Steps are listed as
kind · title; every runbook's Close or last phase ends with a Record step "Record the outcome and
what you would change". Required unless marked optional.

| File and title | Merges | ATT&CK | Phases and steps |
|---|---|---|---|
| `phishing-suspicious-email.md` Phishing or reported suspicious email | `mail_abuse`, `phishing_reported_email` | T1566 | **Triage**: Lookup · Find the message and every copy in the mail logs; Check · Is the sender or domain impersonating us or a partner? **Investigate**: Lookup · Reputation of the sender domain, links and attachments (enrich); Lookup · Did anyone click a link or open the attachment? (proxy and endpoint logs); Check · Did anyone enter credentials?; Decision · Malicious, suspicious or benign? (benign skips Contain and Recover). **Contain**: Action · Remove the message from every mailbox (RA3203, RA4201); Action · Block the sender and links at the mail and web gateways (RA3101); Action · Reset credentials of anyone who entered them (optional, RA4601). **Recover**: Record · Tell affected users what happened and what to watch for. **Close**: Record · Record the outcome and tell the reporter |
| `malware-endpoint.md` Malware on an endpoint | `malware` | T1204, T1059 | **Triage**: Check · Is the host a server, a user device or a test machine?; Lookup · Other alerts on this host in the last 24 hours. **Investigate**: Lookup · Reputation of the file hash (enrich); Lookup · Processes and network connections around the alert; Lookup · Other hosts with the same hash (related cases); Decision · Malicious, suspicious or benign? **Contain**: Action · Isolate the host from the network (D3-NI); Action · Stop the process and quarantine the file (D3-PT, D3-FE). **Eradicate**: Action · Remove persistence and the malware; Check · Is the host clean after a fresh scan? **Recover**: Action · Return the host to service or rebuild it; Record · Record the outcome and what you would change |
| `ransomware-destructive.md` Ransomware or destructive activity | `ransomware_response` | T1486, T1490 | **Triage**: Check · Are files being encrypted or deleted right now?; Record · Declare an incident and name an incident lead (approval when step approvals are on). **Contain**: Action · Isolate affected hosts and shares (D3-NI); Action · Disable accounts used by the attacker (D3-AL); Lookup · Which hosts show the same activity? **Eradicate**: Action · Remove the attacker's tools and access; Check · Are backups intact and unaffected? **Recover**: Action · Restore data from backup (RA5002); Check · Are restored systems working and monitored? **Close**: Record · Notify legal, leadership and any regulator as required; Record · Record the outcome and what you would change |
| `brute-force-password-spray.md` Brute force and password spray | `brute_force`, `brute_force_login` | T1110 | **Triage**: Check · Is the source internal or external?; Lookup · How many accounts were tried? (log_stats by user); Lookup · Reputation of the source IP (enrich). **Investigate**: Lookup · Did any attempt succeed after the failures?; Check · Are the targeted accounts privileged or service accounts?; Lookup · Other cases from this source in 30 days (related cases); Decision · Is this a confirmed compromise? (benign skips Contain). **Contain**: Action · Block the source at the edge (optional, RA3101); Action · Reset or lock the affected accounts (D3-AL). **Close**: Record · Tell the account owners; Record · Record the outcome and what you would change |
| `compromised-account.md` Compromised account or suspicious sign-in | (new; impossible travel) | T1078 | **Triage**: Lookup · Sign-ins for this account in the last 7 days; Check · Does the user confirm the sign-in? **Investigate**: Lookup · Reputation of the sign-in IP (enrich); Check · Were MFA settings, mail rules or app consents changed?; Decision · Compromised, suspicious or benign? **Contain**: Action · Revoke sessions and reset the password (RA4601, D3-CR); Action · Remove attacker-added MFA methods, rules or consents. **Recover**: Check · Is the account back under the owner's control?; Record · Record the outcome and what you would change |
| `cloud-identity-keys.md` Cloud identity and access key compromise | `cloud_iam_compromise`, `cloud_identity_compromise` | T1078.004, T1552 | **Triage**: Check · Which identity or key is involved and what can it reach?; Lookup · Recent API activity by this identity. **Investigate**: Lookup · Calls from new locations or unusual services; Check · Were new keys, roles or policies created?; Decision · Compromised, suspicious or benign? **Contain**: Action · Disable or rotate the key and revoke sessions (D3-CR). **Eradicate**: Action · Remove attacker-created keys, roles and resources. **Recover**: Check · Are workloads using the new credentials?; Record · Record the outcome and what you would change |
| `data-exfiltration.md` Data exfiltration | `data_exfiltration`, `data_exfiltration_response` | T1041, T1567 | **Triage**: Lookup · Volume and destinations of the transfer; Check · Is the destination a sanctioned service? **Investigate**: Lookup · Reputation of the destination (enrich); Check · What data was involved and who owns it?; Decision · Exfiltration, suspicious or benign? **Contain**: Action · Block the destination and stop the transfer (D3-NI); Record · Notify the data owner. **Close**: Record · Record whether notification duties apply; Record · Record the outcome and what you would change |
| `web-application-attack.md` Web application attack | `web_attack`, `web_application_abuse` | T1190 | **Triage**: Lookup · Requests from this source to the application (log_stats by path and status); Check · Did any request succeed (2xx or unusual size)? **Investigate**: Lookup · Reputation of the source (enrich); Check · Is the targeted component vulnerable to this attack?; Decision · Exploited, attempted or benign? **Contain**: Action · Block the source or request a WAF rule (optional, RA3101); Action · Patch or take the component offline when exploited. **Close**: Record · Record the outcome and what you would change |
| `scanning-reconnaissance.md` Scanning and reconnaissance | `port_scan`, `vuln_scan`, `web_scanner_activity` | T1595, T1046 | **Triage**: Check · Is the scanner one of ours or an approved third party?; Lookup · How many hosts and ports were touched? (log_stats); Lookup · Has this source scanned us before? (related cases); Decision · Approved, repeated hostile scanning, or one-off noise? **Close**: Action · Block the source if scanning repeats (optional, RA3101); Record · Record the outcome and what you would change |
| `suspicious-outbound.md` Suspicious outbound or known-bad destination | `ip_reputation`, `suspicious_outbound_connection` | T1071, T1571 | **Triage**: Lookup · Reputation of the destination (enrich); Lookup · Which hosts talked to it and how often? **Investigate**: Check · Which process made the connection?; Decision · Command and control, suspicious or benign? **Contain**: Action · Block the destination (RA3101, or a DNS sinkhole request); Action · Isolate the host when it is command and control (optional, D3-NI); Record · Record the outcome and what you would change |
| `privileged-misuse-insider.md` Privileged access misuse and insider activity | `privileged_web_access` | T1078.003 | **Triage**: Check · Is the activity covered by an approved change or ticket?; Lookup · Privileged actions by this account in 7 days. **Investigate**: Check · Does the activity match the person's role?; Record · Involve HR or legal as your policy requires (approval when step approvals are on); Decision · Misuse, suspicious or authorised? **Contain**: Action · Remove or reduce the account's privileges (D3-AL). **Close**: Record · Record the outcome and what you would change |
| `generic-incident.md` Generic incident (NIST 800-61) | (new fallback, `applies_when.always: true`) | any | **Triage**: Check · What happened, where, and how bad is it?; Record · Name an incident lead. **Investigate**: Lookup · Other alerts for the case's entities in 24 hours; Check · What is the scope: which hosts, accounts and data?; Decision · Incident, suspicious or benign? **Contain**: Action · Contain the affected systems or accounts. **Eradicate**: Action · Remove the cause. **Recover**: Action · Restore normal service. **Close**: Record · Record the outcome and what you would change |

Packaging: `backend/pyproject.toml`, `MANIFEST.in`, `backend/Dockerfile` (the `COPY` lines,
`:44-47`) and `.github/workflows/ci.yml` (`:108-109`) ship `app/runbooks/library/*.md` and stop
shipping `backend/playbooks/` and the old `app/runbooks/*.md`; the distribution and portability
contract tests assert the 12 files are in the wheel and the image.

#### 4.10.15 API, permissions, audit events, errors and limits

Library routes live in `backend/app/api/routes_runbooks.py` (rewritten, A7b; the `/api/runbooks`
path stays the home); case routes and `POST /api/runbooks/progress` live in
`backend/app/api/routes_case_runbooks.py` (new, A7c). **Route order**: the fixed paths
(`/metrics`, `/validate`, `/match-preview`, `/lookup-test`, `/import`, `/reindex`) are declared
before `/{id}` in their router, and a route-order test asserts `GET /api/runbooks/metrics` never
reaches the detail handler; the reserved ids of §4.10.2 keep a runbook from ever taking one of those
names. Bodies and responses are Pydantic models in `models.py` (the single home; `runbook_model.py`
imports them), mirrored in the type-only `webui/src/lib/types-runbooks.ts`; field tables in
§4.10.15a.

| Method and path | Grant | Notes |
|---|---|---|
| GET `/api/runbooks` | `runbooks:read` | library list: built-ins and operator runbooks; params `q`, `state`, `origin`, `show_replaced` |
| GET `/api/runbooks/{id}` | `runbooks:read` | detail: live version, version list; draft and in-review versions only with `runbooks:manage` **or** `runbooks:publish` (a publisher must see what it approves) |
| GET `/api/runbooks/{id}/versions/{n}` | `runbooks:read` | one version with its Markdown source; the detail route's visibility rule applies (a draft or in-review version without `manage` or `publish` is `404 runbook_version_not_found`) |
| POST `/api/runbooks` | `runbooks:manage` | create a draft from `{definition}` or `{source}`; `201` |
| PUT `/api/runbooks/{id}/draft` | `runbooks:manage` | update the draft; `expected_revision` required |
| DELETE `/api/runbooks/{id}/draft` | `runbooks:manage` | discard the draft (a never-published runbook disappears) |
| POST `/api/runbooks/{id}/duplicate` | `runbooks:manage` | built-in or operator; returns the new draft |
| POST `/api/runbooks/{id}/submit` | `runbooks:manage` | draft to in review |
| POST `/api/runbooks/{id}/publish` | `runbooks:publish` | `{version, expected_revision}`; fresh auth not required |
| POST `/api/runbooks/{id}/reject` | `runbooks:publish` | `{version, reason}` back to draft |
| POST `/api/runbooks/{id}/retire`, `/restore` | `manage`, `publish` | retire stops matching; restore republishes the last live version |
| POST `/api/runbooks/{id}/reviewed` | `runbooks:publish` | Mark reviewed |
| POST `/api/runbooks/{id}/versions/{n}/restore` | `runbooks:manage` | a new draft from version n |
| POST `/api/runbooks/validate` | `runbooks:read` | `{definition}` or `{source}` to issues and the investigator guidance length; no write |
| POST `/api/runbooks/match-preview` | `runbooks:read` and `cases:read` | `{definition}` or `{id}`; last 500 cases in 30 days; no write, no metric change |
| GET `/api/runbooks/{id}/export` | `runbooks:read` | `text/markdown` attachment |
| POST `/api/runbooks/import` | `runbooks:manage` | `{source}` Markdown; always a draft |
| GET `/api/runbooks/metrics` | `runbooks:read` and `cases:read` | `window` (default `now-30d`): runs started, completed, abandoned per runbook; median time to complete per runbook, phase and step; most skipped steps; coverage of human-handled cases; rules seen with no matching runbook; with and without completed runbook response-time cohorts with counts and "comparison, not cause"; `partial` when a ledger month document reached its cap in the window; rule names are untrusted plain strings |
| POST `/api/runbooks/{id}/reindex` | `runbooks:manage` | kept; job kind `runbook_reindex` kept for the full projection |
| GET `/api/cases/{case_id}/runbooks` | `runbooks:read` and `cases:read` | runs, progress, newer versions, other tasks; each step's evidence is redacted per viewer by the tool grants of §4.10.8 |
| GET `/api/cases/{case_id}/runbooks/candidates` | `runbooks:read` and `cases:read` | picker list with the match explanation; `q` |
| POST `/api/cases/{case_id}/runbooks` | `runbooks:run` | `{runbook_id, note?}`; idempotent: an existing run returns `200 {already_attached: true}` |
| POST `/api/cases/{case_id}/runbooks/suggest` | `runbooks:run` | AI suggestion (gateway); `dry_run=true` returns the estimate; never attaches |
| PATCH `/api/cases/{case_id}/runbooks/{run_id}/steps/{step_id}` | `runbooks:run` | `{expected_revision, status?, assignee?, note?, reason?, decision?, action_record?, evidence_link?}` |
| POST `.../steps/{step_id}/lookup` | `runbooks:run` and the tool's grant (§4.10.8) | run the lookup now; replaces the previous automatic result |
| POST `/api/runbooks/lookup-test` | `runbooks:manage`, `sources:read`, `cases:read` and the tool's grant | `{lookup: LookupTemplate, case_id}`: runs a draft lookup against a chosen case for the editor's "Test with a case"; read-only, nothing stored, the same bounds and 45 s timeout, not audited (a read) |
| POST `.../steps/{step_id}/approval` | `runbooks:run` and the step's `approval_role` | `{decision: approve \| reject, reason?}`; the recorder cannot approve |
| POST `.../steps/{step_id}/draft`, `.../draft/confirm` | `runbooks:run` | AI draft (gateway) and confirmation (`{text}` as edited) |
| POST `/api/cases/{case_id}/runbooks/{run_id}/switch-version` | `runbooks:run` | `{version}` |
| POST `/api/cases/{case_id}/runbooks/{run_id}/abandon` | `runbooks:run` | `{reason}` |
| POST `/api/runbooks/progress` | `cases:read` | in `routes_case_runbooks.py`; `{case_ids: [<= 100]}` to `{case_id: RunbookProgress}`, read from the case documents with at most 8 reads at once |

- **Closing by hand never blocks (D34).** Every human terminal transition gains two optional
  fields: `open_steps_reason` (1 to 500 characters) and `require_open_steps_reason: bool` (default
  false). Only when the request carries `require_open_steps_reason: true` (the Console sends it, so
  it can show the dialog) and an active run has required steps open and no reason is given does the
  call return `409 runbook_steps_open` with `{required_open, steps: [{run_id, step_id, title,
  status}]}`. Every other close proceeds exactly as today (old-shape API clients and scripts keep
  getting 200) and, when required steps were open, writes `case.closed_with_open_steps` with
  `reason` (the given text or `null`) and `via: "console" | "api" | "bulk" | "proposal"`.
  The human terminal transitions and what the Console does on each:

  | Transition | Console prompt when required steps are open |
  |---|---|
  | `POST /api/cases/{id}/action` resolve or close | the close dialog (§4.10.11) |
  | `confirm_fp` | the close dialog |
  | `set_status` to a terminal status | the close dialog |
  | `set_disposition` that closes the case | the close dialog |
  | merge into another case, mark duplicate | no prompt; the row records `via: "console"` and `reason: null` with the note "Merged" or "Duplicate" |
  | bulk close (`case_lifecycle` job) | one shared reason in the bulk dialog (optional); items never fail for open steps |
  | approving a close proposal in Approvals | no prompt; `via: "proposal"`, `reason: null` |

  Automatic closes (`decide()`, auto-close, analyst-policy closes) never read runbook state (#3);
  `decide()` and `AutoClosePolicy` are untouched. Test (A7c): an old-shape close with required
  steps open returns 200 and writes the row with `reason: null`; each transition above writes its
  `via`; `require_open_steps_reason: true` without a reason returns 409.
- Audit events (`ActionType.RUNBOOK`, the `action` field of §4.5.3, `target` the runbook or the
  case, `changes` for edits): `runbook.created`, `runbook.draft_updated`, `runbook.draft_discarded`,
  `runbook.duplicated`, `runbook.imported`, `runbook.exported`, `runbook.submitted`,
  `runbook.published`, `runbook.rejected`, `runbook.retired`, `runbook.restored`,
  `runbook.reviewed`, `runbook.migrated`, `runbook.selected` (actor `runbook_selector`),
  `run.attached`, `run.started`, `run.version_switched`, `run.abandoned`, `run.completed`,
  `step.updated` (every status, assignee and note change, with before and after), `step.evidence_collected`,
  `step.decision_recorded`, `step.action_recorded`, `step.approval_requested`, `step.approved`,
  `step.rejected`, `step.ai_drafted`, `step.ai_draft_confirmed`, `case.closed_with_open_steps`
  (#2). The case activity feed shows the same events in plain words.
- Errors: `404 runbook_not_found`, `404 runbook_version_not_found`, `404 run_not_found`,
  `404 step_not_found`, `409 runbook_conflict` (stale revision, the latest returned), `422
  runbook_invalid` (with `issues[]`), `422 runbook_prompt_budget` (with the length), `409
  runbook_readonly` (a built-in), `409 runbook_state` (an illegal transition), `409 runbook_limit`,
  `409 run_limit` (5 runs per case), `409 step_state`, `403 runbook_distinct_approver`, `403
  runbook_approval_role`, `409 runbook_ai_disabled`, `422 runbook_id_reserved`, `409
  runbook_demo_readonly`, `503 lookup_unavailable`, `503 runbook_store_unavailable`.
- SSE: `case.runbook` frames after each run write, carrying `{case_id, run_id, progress,
  revision}` only, delivered only to subscribers who hold both `runbooks:read` and `cases:read`.
  The channel is added atomically by A7c in `backend/app/realtime.py` (`SSE_EVENT_TYPES`, with
  `test_sse_agent_step_channel.py` updated) and in the web `STREAM_CHANNELS` list in
  `webui/src/lib/useEventStream.ts` with its test (an entry module, so its bytes are measured,
  §3.4).

#### 4.10.15a Response models (`models.py`, mirrored in `types-runbooks.ts`)

| Model | Fields |
|---|---|
| `RunbookSummary` | `id`, `title`, `summary`, `origin: "builtin" \| "operator" \| "imported"`, `state: "draft" \| "in_review" \| "published" \| "retired"` (the most advanced visible state), `live_version: int \| None`, `draft_version: int \| None`, `in_review_version: int \| None`, `retired: bool`, `replaces: str \| None`, `replaced_by: str \| None`, `derived_from: {id, version} \| None`, `owner: str \| None`, `phases: list[PhaseId]`, `step_count: int`, `applies_to: {rule_ids: list[str], mitre: list[str], more: int}`, `runs_30d: int \| None` (null without `cases:read`), `review_due_at: str \| None`, `updated_at`, `updated_by`, `migrated_from: {namespace, id, revision} \| None` |
| `RunbookVersionDoc` | `version: int`, `state`, `definition: RunbookDefinition`, `source: str` (Markdown), `content_hash`, `author`, `created_at`, `submitted_by/at`, `published_by/at`, `superseded_at`, `retired_by/at`, `review_notes: list[{by, at, text}]`, `import_notes: list[str]`, `prompt_chars: int` |
| `RunbookDetail` | `summary: RunbookSummary`, `live: RunbookVersionDoc \| None`, `draft: RunbookVersionDoc \| None` and `in_review: RunbookVersionDoc \| None` (present only under the visibility rule above), `versions: list[{version, state, published_by, published_at}]`, `open_runs_by_version: dict[int, int]`, `revision: int` (the library document's CAS revision, sent back as `expected_revision`) |
| `RunbookIssue` | `path: str`, `code: str`, `message: str` |
| `RunbookValidation` | `issues: list[RunbookIssue]`, `prompt_chars: int`, `prompt_budget: int` |
| `MatchPreview` | `considered: int`, `window_label`, `gets_it: list[{case_id, case_number, title, explanation}]`, `another_wins: list[{case_id, case_number, title, winner_id, winner_title}]`, `near_misses: list[{case_id, case_number, title, failed: list[{criterion, expected, actual}]}]`, `truncated: bool` (each list at most 50; counts always exact) |
| `RunbookMetrics` | `window_label`, `partial: bool`, `per_runbook: list[{id, title, started, completed, abandoned, median_minutes_to_complete \| None}]`, `per_step: list[{runbook_id, step_id, title, median_minutes \| None, skipped}]`, `coverage: {cases_with_run, human_handled_cases}`, `rules_without_runbook: list[{rule, cases}]` (at most 20), `cohorts: {with_completed_run: {cases, mttr_p50_minutes}, without: {cases, mttr_p50_minutes}, note: "comparison, not cause"}` |
| `CaseRunbooks` | `runs: list[RunbookRun]` (evidence redacted per viewer), `progress: dict[run_id, RunbookProgress]`, `newer_versions: dict[run_id, int]`, `other_tasks: list[CaseTask]`, `revision: int` |

WP-0 writes these models in full from this table; A7b and W7a never invent a field.

#### 4.10.16 Removals, and what stays accepted

Removed once the migration exists and the tests have moved ([S §4.6], all binding):

- Backend: `backend/app/playbooks/` (`__init__.py`, `manifest.py`, `loader.py`, `registry.py`,
  `durable.py`); `backend/playbooks/` (9 files and the README) and its packaging lines;
  `backend/app/stores/playbooks.py`; `backend/app/engine/runbook_service.py`; the plain-text
  authoring standard in `backend/app/engine/runbooks.py` (the file is deleted; `parse_frontmatter`
  moves into `runbook_model.py`); the 9 old `backend/app/runbooks/*.md`; `SEED_RUNBOOKS` and
  `_runbook_seed_items` (`tools/rag.py:788-846`); the `<<<PLAYBOOK>>>` block; the dead
  `PlaybookConfig.llm_select` and `suggested_tools`; the `force_playbook_id` plumbing and the
  automation callback (`state.py:1143-1162`); the legacy directory registry
  (`Preferences.playbooks.dir`, read once by the migration, §4.10.17).
- HTTP, for one release (D44, E14), then deleted:
  - **Reads stay as aliases.** `GET /api/playbooks` and `GET /api/playbooks/{id}` answer from the
    new library in the old response shape (each Published runbook mapped to the old playbook fields;
    `body` is the exported Markdown) with the headers `Deprecation: true` and `Link:
    </api/runbooks>; rel="successor-version"`, behind `runbooks:read`. `GET /api/runbooks` and
    `GET /api/runbooks/{id}` with `?shape=v1` answer in the old runbook shape (`enabled`,
    `retrieval_enabled`, `count`, `runbooks[]` and the old item fields) with the same headers;
    without `shape` they answer in the new shape.
  - **Writes answer `410 runbooks_moved`** with `{detail: "Playbooks are now runbooks.", see:
    "/api/runbooks"}` (the `routes_reset` pattern): every `/api/playbooks*` write, `POST
    /api/cases/{id}/run-playbook`, and an old-shape body (`{id, content}`) on `POST
    /api/runbooks` or `PUT /api/runbooks/{id}`. An old-shape write cannot be honoured without
    making unreviewed text live, which #9 forbids.
  - `POST /api/runbooks/reindex` (deprecated) stays as is.
  - The deviation (writes 410 rather than aliased) is recorded in `docs/operations/upgrades.md`,
    DEPLOY.md and `docs/reference/api.md`, and named in the first Wave A progress update.
- Console: the playbooks half of `Catalog.tsx` (personas move to `Personas.tsx`), the old
  `Runbooks.tsx`, `runbookAuthoring.ts`, `runbookExamples.ts`; the nav entries "Reference
  runbooks" and "Response playbooks"; the "Run a playbook" item and dialog
  (`CaseDetail.tsx:430-434, 931-971, 1632-1643, 2123-2175`); the Cases `playbooks` column; the
  "Playbook usage" chart (replaced by "Runbook usage"); the Settings links "Suppression & response
  playbooks" and "Corpus & procedures" (replaced by one "Runbooks" link); the `run_playbook` choice
  in the rule editor (replaced by "Attach a runbook"); the Audit filter "playbook" (kept as the
  legacy category label); the Docs card "Playbooks and approvals" (approvals keep a card); the
  `Playbook*` and old `Runbook*` types and client methods.

Stays accepted (aliases; never renamed, the AGENTS.md naming contract):

- `Case.playbook_id` (readers prefer `runbook_id`; history never rewritten).
- `CaseAutomationRule.action = "run_playbook"` with `payload.playbook_id` stays the stored form,
  **never rewritten** in stored Preferences (so a rollback to a build whose `action` Literal lacks
  any new value still loads). The rule editor's "Attach a runbook" also writes `action:
  "run_playbook"` (the existing literal, kept by the naming contract) with `payload.runbook_id`
  and, for compatibility, `payload.playbook_id` set to the same id; the Literal gains no new value.
  At fire time `engine/threshold_automation.py` resolves the target: `payload.runbook_id`, else
  `payload.playbook_id` through the migration's stored id map (operator documents), else through
  the static `LEGACY_BUNDLED_RUNBOOK_MAP` (new, `engine/runbook_model.py`: each of the 18 legacy
  bundled ids to its new built-in id, from the Merges column of §4.10.14; also used to show
  `Case.playbook_id` and stored chat refs). The rule then **attaches** that runbook ($0) instead of
  forcing a re-investigation (behaviour change, documented). A target that is unmapped, unknown, a
  Draft or retired is skipped with an audit row `run.attach_skipped` (reason) and the rule editor
  shows "Needs a runbook" on that rule. The rule version ledger keeps validating.
- `JobKind.RUNBOOK_REINDEX = "runbook_reindex"`.
- Permissions `playbooks:read`, `playbooks:run`, `playbooks:manage` (mapped, §3.7, E8).
- Audit actors `playbook_selector`, `procedure_provenance`, `run_playbook`, and
  `ActionType.PLAYBOOK` and `ActionType.RUNBOOK`, readable forever by the case rationale and the
  timeline.
- Chat `search_knowledge` kinds `list_playbooks` (now an alias of `list_runbooks`) and
  `list_runbooks`; the page refs `playbooks`, `runbooks` and `catalog` in stored transcripts and
  Inbox items (both resolve to `#/runbooks`); the citation kind `runbook`.
- The replay field `playbooks_enabled` under `extra="forbid"`, mapped to the runbook guidance flag.
- The neutral marker tag `<pb>` and the token `end_playbook`.
- The KV namespaces `playbooks` and `runbooks`, read-only for one release, with their export groups.
- Config keys `playbooks.enabled`, `playbooks.dir`, `playbooks.llm_select`, `runbooks.enabled` and
  `rag.use_runbooks`, accepted on load (§4.10.19).

#### 4.10.17 The one-shot migration of stored operator content

`backend/app/engine/runbook_migration.py` (new), called once from the application startup after
the stores are ready (E9). It reads legacy content only through
`backend/app/stores/legacy_procedures.py` (§4.10.6).

1. Read the marker `runbook_library:migration`. If it holds `{version: 1, completed_at}` and a
   `projection_completed_at`, stop. If it holds `completed_at` but no `projection_completed_at`,
   go to step 7 (resume the projection).
2. Read, never write: the legacy `playbooks` and `runbooks` KV documents, and, when
   `Preferences.playbooks.dir` names a readable directory other than the packaged one, its `*.md`
   files.
3. Convert each document ([rbc §10.2]). **Ids**: an operator id keeps its legacy spelling (the
   operator grammar of §4.10.2 accepts `brute_force_login`). Any suffix this step adds
   (`-reference`, `-imported`) is fitted by truncating the base id so the result is at most 64
   characters. A reserved id (§4.10.2) is renamed `<id>-imported` and keeps its state, with the
   note "Renamed because the id is reserved."
   - Playbook: `id`, `name` to `title`, `description` to `summary`, `match.rule_ids`,
     `entity_types`, `min_event_count`, `mitre` and `any_tags` to `applies_when`, `priority` kept,
     `rag_queries` to `retrieval_queries`, `escalate_if` to the decision step's `escalate_if`,
     `suggested_verdict_bias` and `suggested_tools` dropped (recorded in the migration note); the
     Markdown body: each `##` or `###` section becomes a Check step in Investigate whose title is
     the heading, whose **`focus`** is the section's guidance (its text up to 300 characters, cut at
     the last sentence boundary, else the last word boundary) and whose instructions are the full
     section text. The investigator reads `focus`, never instructions (§4.10.9), so the guidance
     that today reaches the prompt keeps reaching it. A body without headings becomes one Check
     step "Follow the procedure" with the same focus rule. A Decision step "Decide the outcome"
     (Confirmed, Suspicious, Benign) is appended.
   - Runbook (seven labels): SIGNAL to `summary` and `use_when`; EVIDENCE REQUIRED to a Triage
     Check "Collect the required evidence"; each line of INVESTIGATION STEPS to an Investigate
     Check (the line is its title, and its focus when it is longer than the 160-character title);
     TRUE POSITIVE SIGNALS and FALSE POSITIVE SIGNALS to the Decision step's `escalate_if` and
     `benign_if`; NEEDS HUMAN WHEN to a Check "Does this need a person?" with `escalate_if`;
     RECOMMENDED NEXT ACTION to a Contain Action; LIMITATIONS appended to `use_when` as "Limits:
     ..."; `applies_to_rules`, `applies_to_entities`, `applies_to_techniques` and `keywords` to
     `applies_when.rule_ids`, `entity_types`, `mitre` and `any_tags`.
   - **Overflow rules** (deterministic; every move is one line in `import_notes`, nothing is
     dropped): a `summary` over 280 is cut at the last word boundary and the remainder is
     prepended to `use_when`; a `use_when` (or `prerequisites`) over 500 keeps its first 500
     characters at a sentence boundary and the remainder goes to the instructions of a Triage Check
     "Scope and background" (created when needed, first in Triage); an `escalate_if` or `benign_if`
     over 300 keeps its first 300 characters at a sentence boundary and the full text goes to the
     owning step's instructions under the line "Escalate if, in full:" or "Benign if, in full:"; a
     `title` over 160 is cut at a word boundary and the full title becomes the first line of the
     instructions; instructions over 2,000 split into "(part n)" steps of the same kind and phase at
     paragraph, then sentence, boundaries (only part 1 carries focus); list fields over their caps
     keep their first items (in source order). If the investigator rendering is over the 3,000-
     character budget, every focus line the migration created is shortened to the same maximum, at
     a word boundary, in 20-character steps down to 80, until it fits. A document that still
     breaks a limit after these rules (for example more than 40 steps) is stored as a Draft with
     the issue.
   - **Shadowed and colliding ids**: the shadow check is against the **union** of the 18 legacy
     bundled ids (the Merges column of §4.10.14, which is what shadowed operator documents before
     Round 14) and the 12 new built-in ids. An operator document whose id is in that union becomes
     `<id>-imported`, is stored as a **Draft** with the note "This had the same id as a bundled
     procedure, so it was never used.", and never matches until someone publishes it. A runbook
     whose id equals a migrated playbook id becomes `<id>-reference`.
4. A converted document that passes `validate_runbook` is stored Published v1 (D38) with origin
   `imported`, `migrated_from: {namespace, id, revision}`, `review_due_at` = now and the badge
   "Imported"; one that fails is stored as a Draft with its issues in `import_notes`. Nothing is
   dropped.
5. One `runbook.migrated` audit row per document (source, new id, state, issues, overflow moves)
   and one summary row; actor `runbook_migration`, `actor_type="system"`, sink `control_audit`.
6. Write the marker: `{version: 1, completed_at, counts: {published, draft, skipped}, sources,
   id_map: {<legacy namespace>:<legacy id>: <new id>}, projection_generation: <uuid4>}`. The
   `id_map` is what automation rules resolve against at fire time (§4.10.16). A failure before the
   marker leaves it absent; the next start resumes and skips ids whose `migrated_from` already
   matches (idempotent).
7. **Reproject the RAG corpus at once** (#9, D39): right after the marker, the migration runs the
   same full projection the `runbook_reindex` job runs (in process, not a Job, E9), which writes
   the Published-only corpus of §4.10.18 with every chunk tagged `projection_generation` and
   deletes the legacy `runbook:<id>:<n>` and `seed:runbook*` documents. It then writes
   `projection_completed_at` into the marker. **Until that field exists**, the retriever
   (`tools/rag.py`) excludes every chunk whose id matches `runbook:*` or `seed:runbook*` and does
   not carry the current generation tag, so no legacy text (a document that became a Draft, a
   shadowed one, the removed `SEED_RUNBOOKS`) is ever served as trusted between the upgrade and
   the end of the projection. A crash mid-projection resumes at the next start (step 1).
8. The Runbooks page shows a dismissible `Callout intro`: "Your 10 procedures from the previous
   version are now runbooks. 9 are published and due for review; 1 is a draft with problems to
   fix. The AI now reads each step's title and focus line, so check each imported runbook." with
   "Show imported" (filters Origin = Imported). The text is built from the marker's counts and
   never uses the retired word.
9. Rollback: a downgrade finds the legacy documents untouched. Removing the legacy namespaces is a
   later release, after an export prompt.

Tests: each mapping and overflow rule (a 1,800-character SIGNAL, a 700-character TRUE POSITIVE
SIGNALS, a 70-character id that gains `-reference`, a reserved id); collisions; the **shadow rule**
(an operator playbook with id `brute_force_login` lands as Draft `brute_force_login-imported` and
never matches); invalid content becomes a draft; the directory source; idempotency (two starts, a
crash between documents, a crash during the projection); the marker and its `id_map`; audit rows;
no write to the legacy namespaces; the migration runs with `app.stores.playbooks` absent; **RAG**:
after the migration, and also before the projection completes, the text of a legacy runbook that
became a Draft never appears as a TRUSTED line in an investigator or chat prompt; **guidance
kept**: for every legacy bundled playbook converted as an operator document, the investigator
rendering contains its escalation guidance (the `escalate_if` text and each section's focus);
`run_playbook` rules resolve through the `id_map` and through `LEGACY_BUNDLED_RUNBOOK_MAP`.

**Acceptance fixture (A7a)**: the 9 legacy bundled playbooks (`backend/playbooks/*.md`) and the 9
legacy bundled runbooks (`backend/app/runbooks/*.md`), copied into the test as operator documents
and run through the conversion, overflow and validation steps (the shadow rule aside, because
their ids are the shadowing ids). All 18 must land Published v1 within the 3,000-character
budget. Any that cannot is listed by name, with the failing rule, in the A7a Journal entry and in
§11.3 as a known limitation before the package is accepted, and the fixture pins that list (an
empty list is the goal), so any change to it is visible in review.

#### 4.10.18 RAG, chat, Demo, replay, metrics, export, automation

- **RAG** (`tools/rag.py`): the `runbook` corpus is built from Published versions only (built-ins
  and live operator versions), one chunk per phase with a descriptor (title, summary, use when,
  techniques, rules, entity types), `trust_class` `bundled_runbook` or `operator_runbook`, both
  trusted because both are Published. Drafts and in-review versions are never indexed. Publish,
  retire and restore trigger a targeted reindex; `runbook_reindex` reprojects all and removes the
  old `runbook:<id>:<n>` and `seed:runbook` documents; the startup migration runs that full
  projection itself, and until it completes the retriever excludes untagged legacy runbook chunks
  (§4.10.17 step 7). `TRUSTED_KNOWLEDGE_SOURCES` keeps `runbook`;
  reserved source labels keep stopping imports from claiming it. `rag.use_runbooks` becomes
  `runbooks.rag_corpus`.
- **Chat**: `search_knowledge` `list_runbooks` returns the new library (title, summary, applies
  to, state), `list_playbooks` is its alias; the Case chat `get_case` tool adds the run summary
  (§4.10.10), fenced; follow-ups keep treating runbook tools as reference-only
  (`chat_followups.py:61, 797`).
- **Demo** (D45): `engine/demo_runtime.py` builds the demo pipeline with the bundled library and
  the matcher, so demo cases receive investigator guidance and runs; the demo seed attaches runs to
  its human-facing cases and completes a deterministic subset of steps so the library metrics and
  the case tab are populated; "Start runbook", step updates and lookups work against the Demo
  store; the Demo planner answers runbook questions and plays the AI suggestion and drafts.
- **Replay**: the replay stack freezes the Published catalog at job start (fixing
  `engine/replay/stack.py:546`, which read the live registry); `playbooks_enabled` maps to
  `runbook_guidance_enabled`.
- **Metrics**: `/api/metrics` adds `runbook_usage` (from `Case.runbook_id`) and keeps
  `playbook_usage` for one release; Analytics shows "Runbook usage"; the library KPIs come from
  `GET /api/runbooks/metrics`; every figure states its population and never claims that a runbook
  caused a time change.
- **Export** (`routes_export.py`, `knowledge` scope): new groups `operator_runbook_library` (every
  operator runbook, every version, with Markdown sources) and `bundled_runbook_library`
  (references); `operator_playbooks` and `operator_runbooks` keep exporting the untouched legacy
  documents for one release, read through `stores/legacy_procedures.py`; `bundled_playbooks` and `bundled_runbooks` export empty with the
  manifest note "Removed in Round 14; see bundled_runbook_library"; the manifest version moves to
  the next integer. The `cases` scope gains `case_runbook_runs` (the per-case run documents),
  which **drops the rows of every `table_kind="rows"` lookup table** (raw `log_search` rows) and
  keeps count, relation, facts, params, window and the aggregate tables, so the manifest's
  declared exclusion of upstream raw log payloads (`routes_export.py` `_EXCLUDED`) stays true. Test:
  no row cell of a `log_search` lookup appears in an export.
- **Automation**: `engine/threshold_automation.py` treats `run_playbook` as attach, resolving the
  target at fire time (§4.10.16, never by rewriting stored Preferences, so load order against the
  startup migration does not matter: a rule that fires before the migration's id map exists falls
  back to `LEGACY_BUNDLED_RUNBOOK_MAP` or is skipped with `run.attach_skipped`); attaching through
  a rule writes `run.attached` with actor `threshold_automation`.

#### 4.10.19 Configuration (`backend/app/config.py`)

`RunbookConfig` (replaces `PlaybookConfig` and the old `RunbookConfig`, `config.py:730-741,
1347-1357`), under `Preferences.runbooks`:

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `enabled` | true | | the feature (library, runs, guidance) |
| `auto_attach` | true | | attach the matching runbook to cases that need a person (D32) |
| `fallback` | true | | attach Generic incident when nothing else matches (D33) |
| `investigator_guidance` | true | | feed the winning Published runbook to the investigator |
| `rag_corpus` | true | | index Published runbooks for retrieval |
| `ai_suggest` | true | | show "Suggest a runbook" (a click, a gateway call) |
| `ai_step_drafts` | true | | show "Draft note" on Check steps (a click, a gateway call) |
| `require_distinct_approver` | false | | the publisher must differ from the author (D35) |
| `step_approvals` | false | | honour `approval_role` on steps (D35) |
| `review_every_days_default` | 180 | 30 to 730 | for new operator runbooks (E6) |
| `runbooks_config_version` | 1 | | migration marker for the keys below |

Accepted on load and mapped once (stamping `runbooks_config_version: 1`), by meaning, never by
name: `playbooks.enabled=false` to `investigator_guidance=false` (it switched off the procedure in
the prompt); `runbooks.enabled=false` to **`rag_corpus=false`** (the old key only stopped
reference-runbook retrieval, `RunbookConfig` docstring, `config.py:1347-1357`);
`rag.use_runbooks=false` to `rag_corpus=false`; `playbooks.dir` kept read-only for the migration and then ignored
with a startup warning; `playbooks.llm_select` dropped. The new `enabled` is **never derived from
an old key** (it defaults to true). An explicit stored `false` is preserved (the Round 10 opt-out
rule); an old `true` maps to nothing (the new defaults are on). Test: each combination of the
three old booleans maps as stated, and `enabled` stays true in every case. The curated Settings section "Runbooks" (Intelligence group) exposes every key above with
help tips; `settings_schema.py:81-82` labels follow.

#### 4.10.20 Non-negotiables

| # | How the design keeps it |
|---|---|
| 1 | Lookups use the read-only log client, the connectors' read paths and the case and campaign stores; no write tool exists. |
| 2 | Every runbook and run change is audited before it becomes visible, with a failure row when the store write fails (§3.6, §4.10.15); legacy actors stay readable. |
| 3 | Runbooks, steps, decisions, completion and the close reason never feed `decide()` or `AutoClosePolicy`; automatic closes never read run state; a decision step's copy says it does not change the verdict. |
| 4 | One run per case and runbook; re-investigation never creates a second run. |
| 6 | Suggestion and drafts are gateway calls, ledgered and budget-gated; matching and lookups are $0. |
| 7 | A model receives only a lookup's count, facts and aggregate tables; raw `log_search` rows are reduced by code before any prompt, shown to people only (with `sources:read`), and dropped from exports (§4.10.8, §4.10.18). |
| 8 | Enrichment lookups go through the cached path. |
| 9 | Only Published text is trusted; imports, migrations with problems, shadowed legacy documents and AI drafts start as Draft; untagged legacy RAG chunks are excluded until the migration's projection completes; every case value, template value, lookup result and note is fenced; the normaliser covers `RUNBOOK`. |
| 10 | Library, auto-attach and fallback on by default; AI help offered as clicks that can be switched off. |
| 11 | The model, validator, matcher and lookup binder are pure and tested first (WP-A3). |
| 12 | KV only: two new namespaces, no new index or table; bundled content ships in the package; the legacy namespaces stay readable. |

#### 4.10.21 Tests (in addition to the per-section lists)

Backend: model validation (every limit and the closed template set); Markdown round trip
(parse, export, parse equals); the matcher's tiers, priority, ties and explanations, including
sub-technique matching and the fallback; the prompt budget for each of the 12 bundled runbooks and
the publish rejection over budget; the fence, precedence wording and normaliser tags; governance
transitions and grants (distinct approver on and off); runs (attach idempotency, re-evaluation
tiers, auto-closed cases get none, switch version carry-over, completion, abandon); step updates
(revision conflict, reasons required, decision skips only To do steps, approval role and the
recorder rule); lookups (each tool, parameter binding, missing values, bounds, timeouts, the window
clamp, the per-tool grants to run and to view, `lookup-test` storing nothing, and a gateway spy
proving no `log_search` cell reaches any prompt); storage (20 cases updated concurrently never
contend on the ledger; a case at the evidence cap stays under 1 MiB and drops the table with its
note; CAS retry and `503 runbook_store_unavailable`); the close reason on every human terminal
transition (old-shape closes return 200; `require_open_steps_reason` returns 409) and its absence
on automatic closes (`decide()` unchanged: the existing byte-identity test of
`engine/case_manager.py` stays green); attachment skipped for a pending automatic close;
permissions and the alias mapping in every grant and deny layer (§3.7); version visibility for
`manage` and `publish`; metrics behind `cases:read`; `case.runbook` frames only to holders of both
grants; route order and reserved ids; the read aliases (`/api/playbooks`, `?shape=v1`) and the
`410` writes; the migration (§4.10.17, including the 18-document acceptance fixture); RAG
projection of Published only and the pre-projection exclusion; Demo parity and the read-only
library in Demo Mode; replay freeze; export groups and the dropped row tables; automation
resolution at fire time; packaging contract. Web: library, editor (outline, form, Preview, Source,
live validation, match preview, history, built-in read-only, Demo read-only), the run tab (Next
step card, phase tabs and their accessible names, rows, decisions, approvals, AI draft, other
tasks, empty state, picker, close dialog, permission-read-only, redacted evidence, phone),
progress chips in the header and queue, focus and live announcements, and no "playbook" in
Console-authored copy (§3.1).

---

## 5. Defects fixed whatever the options ([S §1.10], binding)

| # | Defect | Evidence | Fix | Package |
|---|---|---|---|---|
| F1 | Case detail sheet close button painted over by the sticky header | `webui/src/ui/sheet.tsx:122-133`, `CaseDetail.tsx:1503-1510` | `z-30` on the sheet close button; a Vitest test asserts the close button's stacking class sits above the sticky header's and that it comes after the header in DOM order; the live QA harness checks that `elementFromPoint` at the button centre returns the button (§8.3) | W2a |
| F2 | Body tabular figures widen hyphens ("Auto - tuning") on every page | `webui/src/styles/theme.css:336` | proportional `body`, tabular only on numeric surfaces; ui-standard Typography updated | W2a |
| F3 | Dashboard widgets clip their content; an empty quarter of the grid | `WidgetGrid.tsx:156, 381` | content-sized widgets on panels in view mode | W4c |
| F4 | Needs-human widget "0 open" while 20 are open | `dashboard/widgets/kpi.tsx:23-24` | `breakdown?by=verdict&status_group=open&window=all`, group `NEEDS_HUMAN` (§4.4.3; `posture.open_now` has no verdict split) | W4c |
| F5 | Audit Build column wraps to 7 lines, 131 px rows, Detail clipped | `Audit.tsx:284-302` | superseded by the rebuild (§4.5); fixed layout | W5 |
| F6 | Stray native tooltip over chat tables | `chat/blocks/BlockCard.tsx:824-829` | `title` only when truncated, hit box equals the text | W6b |
| F7 | Chat case entity shows the internal case id and raw status text | `SP/r14/notes/drill/op-case-entity.png` | case number and plain words (§4.6.3) | W6b (web), A6b (labels in tool output) |
| F8 | Raw values "+18613m", "165h", "+8124%" | `Standup.tsx:709`, `Metrics.tsx:1293, 1346` | `fmtDuration`, `fmtOverage` (§4.9.5) | W2a helpers, W8a pages |
| F9 | Models "Vision" chip twice; prices wrap mid-phrase | `ModelsCatalog.tsx:50-66` | de-duplicate by label; one price per line with `whitespace-nowrap`; capabilities collapse to "+3" after two | W9b |
| F10 | Memory form Category and Tags misaligned | `Memory.tsx:213-237` | `Field` for both | W9b |
| F11 | Detection rules notice prints "(#3)" | `rules/DetectionRulesHome.tsx:323-330` | help tip text: "The close or escalate decision is always made by code; a rule can recommend, tag, notify or propose, never set a case status." | W9b |
| F12 | Auto-tuning prints raw backend text ("configured mode=EVERY ...") | `Tuning.tsx:168, 183-190` | one reason-code table, for example "This rule fires on every event, so raising its threshold would change nothing."; the raw detail is never rendered | W9b |
| F13 | Ten places use 10 px text | `EnrichmentProvidersEditor.tsx:211, 228`, `ModelsCatalog.tsx:170, 213`, `BaselineGauge.tsx:172, 233, 244`, `AppShell.tsx:877, 1420, 1676` | 11 px floor plus the guard test | W2a guard, W3 (AppShell), W9b (others) |
| F14 | Three bundled playbooks truncated in the investigator prompt | `agents/prompts.py:492` | superseded by the new library and the tested budget (§4.10.9) | A3, A8a |
| F15 | Demo "Playbook applied" without a playbook | `routes.py:6863-6887`, `demo_runtime.py:240-244` | superseded: the feature is removed and Demo runs runbooks (§4.10.18) | A8a, A8c |
| F16 | Client chat fallback still says 30 s | `chat/chat-api.ts:213-227` | new defaults (§4.2.3) | W1 |
| F17 | A new runbook form opens with "17 fixes" | [rbc §8.7] | issues shown only after a field is left or a save is tried (§4.10.2) | W7a |
| F18 | Replay uses the live procedure registry | `engine/replay/stack.py:546` | frozen Published catalog (§4.10.18) | A8b |
| F19 | Knowledge "0 docs" pill collides with its description | `Knowledge.tsx:1014-1032` | pill in the title row | W9b |
| F20 | Report AI summary can wait longer than the proxy allows | `routes_reports.py:131-133`, `nginx.conf:58-68` | `min(2 x step, 280 s)` (§4.2.3) | A1 |

---

## 6. Non-negotiables cross-check

| # | Round 14 exposure | How it holds |
|---|---|---|
| 1 | Rule summary, Logs filters, runbook lookups | Every read goes through the read-only log client and the connectors' read paths; no write path is added. |
| 2 | Audit record additions, export, downloads, runbook events | All append-only; new fields at append time; export and paging are reads; download auditing added for every job kind; every runbook and run change is audited. |
| 3 | Runbook runs, close reason, dashboards, rule sheet | `decide()` and `AutoClosePolicy` are untouched (the byte-identity test stays); runbooks and the close reason are human workflow outside the policy; automatic closes never read run state. |
| 4 | Runbook attachment | One run per case and runbook, idempotent; re-investigation never makes a second run. |
| 5 | Case chat reads the run summary | Still one chat engine; Case Manager chat stays case-scoped. |
| 6 | AI runbook suggestion and drafts, chat capacity | Every call through the one gateway, ledgered and budget-gated; dashboards, breakdown, rule summary, matching and lookups make no model call (gateway spy tests). |
| 7 | Rule sheet latest alerts, lookups, dashboards | Raw rows are shown to people only; models see aggregates; widgets read aggregates or case rows; `GET /api/standup` (billing) is never a widget source. |
| 8 | Enrichment lookups | Cached path only. |
| 9 | Rule names, audit summaries, lookup results, runbook text, notes | Plain-text rendering; links built by code from validated refs; only Published runbook text is trusted inside `<<<RUNBOOK>>>`; every case value and log value fenced; normaliser covers the new name. |
| 10 | New defaults | Chat capacity tripled with a staged migration that keeps administrator choices; runbook library, auto-attach and fallback on; dashboards on; AI help offered as clicks. |
| 11 | Runbook spine | The pure model, validator, matcher and binder (A3) land and are tested first. |
| 12 | Storage | KV only: `runbook_library` and `runbook_runs` namespaces, `UserPrefs.misc` keys; no new index, table or migration; Elasticsearch bootstrap never remaps (the audit write-index roll is documented). |

---

## 7. Work packages

### 7.1 Rules

- Every package runs: implement, then two independent adversarial reviews (correctness and
  security; UX and accessibility for web packages, API contract and non-negotiables for backend
  packages), then fix, then a re-review, and ends with its own tests and every repository gate it
  touches green, under the generated-artefact rule of §8.2. Sub-agents do every step (the
  operator's instruction).
- Owned files are exclusive while a package runs. Touching another package's file needs the
  orchestrator. Shared contract files take additive edits only in the sections named.
- **Atomic contracts.** A change to a shape that both stacks pin (a contract JSON, an SSE channel
  list, a records test) lands in one package with both sides of its tests (§7.9).
- **Legacy tests belong to the package whose change breaks them**, and are listed in that
  package's owned files; the package rewrites each one to pin the new contract (§8.1: never
  deleted to make a gate green). The known assignments are in §7.3. A package that finds another
  test its change breaks stops and asks the orchestrator, who assigns it before the package goes
  on.
- Nobody runs git commands that change state; the orchestrator commits and records each package.
- Each package keeps a progress file in `SP/r14/impl/<WP>/PROGRESS.md`, returns a Journal entry,
  and updates the Help Center pages its behaviour changes in the same change (§9.1).
- "After" means the named packages are committed; "Parallel" lists packages that may run at the
  same time (no shared files). "Commits after" means the work may run in parallel but the
  orchestrator commits it only after the named package.

### 7.2 Wave 0 (orchestrator, before anyone starts)

**WP-0 Contracts and the base build.**

- Owns: `backend/app/models.py` (the single home of every new model and field of §4.4.1,
  §4.4.2, §4.5.3, §4.5.10, §4.6.2, §4.10.2, §4.10.7, §4.10.15a, `DashboardLayout.derived_from` and
  `default_window`, and the `UserPrefs.misc` keys `dashboards_hidden` and `dismissed_intros`,
  written in full from those field tables, with validators; `runbook_model.py` imports them),
  `backend/app/constants.py` (`RUNBOOK_LIBRARY_NS`, `RUNBOOK_RUNS_NS`, `JobKind.AUDIT_EXPORT`,
  `ActionType.AUDIT_VIEW = "audit_view"`, actor names `runbook_selector`, `runbook_migration`),
  `backend/app/rbac/policy.py` (**only** the new actions and default holders of §3.7 step 1;
  `playbooks` stays in `RESOURCES`), the type-only mirrors `webui/src/lib/types-runbooks.ts`,
  `types-audit.ts`, `types-dashboards.ts` (new; names that exist today in `types.ts`, such as
  `RunbookDetail` and `AuditRecord`, are imported by new code only from these modules, so nothing
  collides), the lazy-only client modules `webui/src/lib/api-audit.ts`, `api-runbooks.ts`,
  `api-dashboards.ts`, `api-rules.ts` (new; §3.4), `webui/src/soc/dashboard/kpi-bindings.ts`
  (the §4.4.3 binding table), and in `webui/src/lib/types.ts` and `api.ts` **only** new optional
  fields and parameters on existing types and methods.
- Changed signatures of existing client methods (all optional additions, listed so no package
  invents one): `listCases({rule?, closed_by?})`, `getLogs({rule?, severity?, severity_gte?})`,
  the case action call (`open_steps_reason?`, `require_open_steps_reason?`), the bulk case
  lifecycle job params (`open_steps_reason?`), `submitJob` for `audit_export` params, the dashboard
  create and update calls (`derived_from?`, `default_window?`), `putUserPrefs` misc keys, and the
  `/auth/me` result type (`object_scoped`). The old `audit()` method keeps its signature; the new
  audit calls live in `api-audit.ts`.
- Delivers: the contracts above, a `backend/tests/test_round14_contracts.py` that round-trips each
  model and pins the permission matrix (with `playbooks` still present); and the **base build**
  for progress screenshots: a git worktree at the Round 14 starting commit `1cf20a7` in
  `SP/r14/base/`, built once with `npm run build` and served with `vite preview` on port 4960
  against the shared demo backend, plus the BEFORE captures of every surface in §8.4 at 390, 1440
  and 1920 in both themes into `SP/r14/progress/base/`.
- Acceptance: the full backend suite, `tsc --noEmit` and `bundle-first-paint.test.ts` are green
  with the stubs, and WP-0 reports its entry delta (it should be zero: new calls are outside the
  entry); BEFORE shots exist for every surface.

### 7.3 Wave A (backend)

| WP | Delivers | Owns | After | Parallel with | Size |
|---|---|---|---|---|---|
| **A1** Chat limits v2 | §4.2 | `backend/app/config.py` (`ChatAgentConfig` block and the chat migration only), `backend/app/api/routes_reports.py` (summary wait), `backend/app/api/routes_chat.py` (the two fallbacks only), tests `test_chat_limits_migration.py`, `test_settings_schema_chat_agent.py`, `test_chat_round12_api.py`, `test_chat_contracts.py` (the limits pins only), `test_demo_chat_planner.py` (pins only) | WP-0 | A2, A3, A4a | S |
| **A2** Breakdown, KPI bindings, reserved ids, widget contract | §4.4.1 (server), §4.4.2, the §4.4.3 bindings and widget contract | `backend/app/api/routes_metrics.py`, `backend/app/api/routes_dashboards.py` (reserved ids on create, `default_window`), `backend/app/engine/case_aggregate.py` (the new metrics, additive), `backend/app/agents/chat_tools/stats.py` (`METRICS` parity entries only), `webui/src/soc/dashboard/widget-types.contract.json`, the client `WidgetType` union and stub entries in `webui/src/soc/dashboard/registry.ts` (stub hunk only), tests `test_round5_dashboards_routes.py`, `test_round5_dashboards_widget_type_contract.py`, the web widget contract test, new `test_metrics_breakdown.py`, `test_kpi_strip_bindings.py` | WP-0 | A1, A3, A4a | M |
| **A3** Runbook core, pure | §4.10.2 to §4.10.4, §4.10.8 (validation and binding, not execution), §4.10.9 renderer and budget, §4.10.13, §4.10.14, `LEGACY_BUNDLED_RUNBOOK_MAP` | new `backend/app/engine/runbook_model.py`, `engine/runbook_match.py`, `engine/runbook_lookup.py`, `backend/app/runbooks/library/*.md` (12), tests `test_runbook_model.py`, `test_runbook_match.py`, `test_runbook_lookup_binding.py`, `test_runbook_library.py` (budget per bundled runbook, every file valid, Markdown round trip) | WP-0 | A1, A2, A4a | M |
| **A4a** Audit read API and record interface | §4.5.5, §4.5.10, §3.6 helper, the record interface of §4.5.3 | new `backend/app/api/routes_audit.py`, `backend/app/api/routes_search.py` (the audit route removed), `backend/app/stores/base.py` (`record` and `record_strict` keyword arguments), `backend/app/audit/audit_log.py`, `backend/app/stores/sql/repositories.py` (audit part), `backend/app/es/fake.py` (`wildcard`, `ip`), `backend/app/es/indices.py`, new `backend/app/audit/events.py`, `audit/event_categories.json`, `audit/write.py` (`audited_write`), `backend/app/state.py` (Demo read split hunk only), the one-line `routes_audit.py` entries in `AGENTS.md` and `docs/HANDOFF.md` (the Round 13 records tests count routers), tests `test_audit_read_api.py`, `test_audited_write.py` (new) | WP-0 | A1, A2, A3 | M |
| **A4b-1** Audit fields: identity and settings writers | §4.5.3, §4.5.4 (A4b-1 list), `object_scoped` on `/auth/me` | new `backend/app/audit/context.py`, new `backend/app/middleware/request_id.py`, `backend/app/main.py` (middleware registration), `backend/app/api/routes.py` (auth, users, settings, sessions and `/auth/me` hunks), `backend/app/api/routes_roles.py`, `backend/app/api/routes_prefs.py`, `backend/app/auth/service.py`, `backend/app/config.py` (`Secrets.trusted_proxies` only), `backend/app/agents/pipeline.py` (`run_id` stamping only), tests `test_audit_record_fields.py` (new) and the existing tests that pin the best-effort settings audit (rewritten to pin audit-first) | A4a, A1 | A3, A2 | M |
| **A4b-2** Audit fields: every other writer | §4.5.4 (A4b-2 list) | `backend/app/api/routes_export.py`, `routes_updates.py`, `backend/app/engine/update_audit.py`, `routes_rules.py`, `routes_analyst_policy.py`, `routes_tuning.py`, `routes_baseline.py`, `routes_batch.py`, `routes_campaigns.py`, `routes_models.py`, `routes_notifications.py`, `routes_setup.py`, `routes_dashboards.py` (stamping hunk), `backend/app/engine/jobs.py` (reset jobs), their audit tests | A4b-1, A2 | A3 | M |
| **A5** Audit export | §4.5.6 | new `backend/app/engine/audit_export.py`, `backend/app/engine/jobs.py` (handler), `backend/app/stores/jobs.py`, `backend/app/api/routes_jobs.py` (submit and artifact download auditing), new `webui/src/lib/csv-formula.contract.json`, tests `test_audit_export.py`, `test_jobs_artifact_audit.py` (new) | A4a, A4b-2 | A6a | M |
| **A6a** Rule filters and rule summary | §4.6.1, §4.6.2, §4.7.2 (connector aggregation part) | `backend/app/api/routes.py` (`/api/logs`, `/api/cases` `rule` and `closed_by` hunks), `backend/app/engine/log_rows.py`, new `backend/app/api/routes_rule_summary.py`, new `backend/app/engine/severity_levels.py` (per-source projection and the ladder), `backend/app/connectors/elastic.py`, `opensearch.py`, `wazuh.py` (two-level aggregation), the one-line router entries in `AGENTS.md` and `docs/HANDOFF.md`, tests `test_logs_rule_filter.py`, `test_rule_summary.py` (new) | A4b-1, A2 | A5 | M |
| **A6b** Chat drill and severity | §4.6.3 (backend), §4.7.2 (artifact), F7 (tool labels), the answer-blocks contract | `backend/app/agents/chat_tools/logs.py`, `chat_tools/stats.py` (after A2), `chat_tools/metrics.py`, `chat_tools/common.py`, `backend/app/agents/blocks.py`, `backend/app/engine/demo_chat.py`, `webui/src/soc/chat/blocks/answer-blocks.contract.json` with `test_chat_contracts.py` (the blocks half) and the web blocks contract test, tests `test_chat_tools_logs.py`, `test_blocks_drill.py` (new), `test_chat_severity_breakdown.py` (new), the golden set | A6a, A1 | A7a, A7b | M |
| **A7a** Runbook stores, config, permissions, migration | §4.10.5 (storage of states), §4.10.6, §4.10.17, §4.10.19, §3.7 steps 2 and the layers | new `backend/app/stores/runbook_library.py`, `stores/runbook_runs.py`, `stores/legacy_procedures.py`, new `backend/app/engine/runbook_migration.py` (step 7 calls the RAG projection hook; A8b supplies the Published-only projection and the retriever exclusion), `backend/app/config.py` (`RunbookConfig` and the alias mapping only), `backend/app/api/settings_schema.py` (labels `:81-82`), `backend/app/rbac/policy.py` (`normalise_grants`, `normalise_denies`), `backend/app/api/routes_roles.py` (grant mapping), `backend/app/stores/custom_roles.py` (normalise on load), `backend/app/state.py` (accessors and the startup call), `backend/app/engine/reset.py`, tests `test_runbook_stores.py`, `test_runbook_migration.py` (with the 18-document fixture), `test_runbook_permissions.py` (new), and the legacy tests that pin `PlaybookConfig`, `RunbookConfig` or `playbooks:*` grants: `test_rbac_policy.py`, `test_rbac_users.py`, `test_round3_wave1_rbac.py`, `test_round3_wave2_roles.py`, `test_settings_roundtrip.py` | A1, A3, A4a, A4b-1 | A6b | M |
| **A7b** Runbook library API | §4.10.5 (transitions), §4.10.15 library rows, the `?shape=v1` read alias and old-shape `410` writes | `backend/app/api/routes_runbooks.py` (rewritten), new `backend/app/engine/runbook_catalog.py` (transitions, governance, validation, match preview, export and import, metrics), tests `test_runbook_library_api.py`, `test_runbook_governance.py`, `test_runbook_match_preview.py`, `test_runbook_metrics.py` (new), legacy `test_runbook_management.py` (rewritten to pin the new routes, `?shape=v1` and the `410`s) | A7a | A6b, A7c | M |
| **A7c** Case runs | §4.10.4 attachment service and every re-evaluation hook, §4.10.7, §4.10.8 execution, §4.10.15 case rows, the close reason, the `case.runbook` channel, the `/api/playbooks*` aliases and `410`s | new `backend/app/engine/runbook_runs.py` (attach, re-evaluate, steps, approvals, lookups execution and grants, AI suggestion and drafts through the gateway, progress, ledger), new `backend/app/api/routes_case_runbooks.py` (with `POST /api/runbooks/progress` and `POST /api/runbooks/lookup-test`), `backend/app/api/routes.py` (case action close fields, tags and action re-evaluation hooks, the `/api/playbooks*` read aliases and write `410`s, run-playbook `410`), `backend/app/engine/jobs.py` (`case_lifecycle` and `case_tag` hooks), `backend/app/realtime.py` with `test_sse_agent_step_channel.py`, the `STREAM_CHANNELS` hunk of `webui/src/lib/useEventStream.ts` with its test, `backend/app/agents/prompts.py` (the draft and suggestion templates only, handed back to A8a), the one-line router entries in `AGENTS.md` and `docs/HANDOFF.md`, tests `test_runbook_runs.py`, `test_runbook_close_reason.py`, `test_runbook_lookups_exec.py`, `test_runbook_ai_calls.py` (new), legacy `test_playbook_management.py` and `test_playbook_run.py` (rewritten to pin the aliases and `410 runbooks_moved`) | A5, A6a, A7a | A7b | L |
| **A8a** Runbooks in the agent path | §4.10.9, investigator selection, the post-investigation attachment trigger, provenance, rationale, Demo pipeline | `backend/app/agents/prompts.py`, `agents/investigator.py`, `agents/graph.py`, `agents/pipeline.py`, `agents/chat_protocol.py` (token only), `backend/app/engine/case_rationale.py`, `backend/app/api/routes_triage.py`, `backend/app/engine/demo_runtime.py`, `backend/app/state.py` (pipeline wiring, removal of the automation callback), tests `test_pipeline.py`, `test_runbook_prompt.py` (new), `test_marker_normaliser.py`, `test_explainability.py`, `test_case_stages.py`, legacy `test_playbook_selection.py`, `test_playbook_loader.py`, `test_vigil_wave1.py`, `test_vigil_wave2.py`, `test_vigil_wave3.py`, `test_round3_wave5_prompt_fencing.py` | A7c, A4b-1 | none | M |
| **A8b** Runbooks everywhere else | §4.10.18, the Published-only RAG projection and the pre-projection exclusion | `backend/app/tools/rag.py`, `agents/chat_tools/intel.py`, `agents/chat_tools/cases.py`, `agents/chat_tools/base.py` (runbook slots), `agents/chat.py`, `agents/chat_followups.py`, `backend/app/engine/demo_chat.py`, `backend/app/engine/demo_generator.py` (the seed that attaches runs), `backend/app/engine/replay/`, `backend/app/engine/metrics.py`, `backend/app/api/routes_export.py`, `backend/app/engine/threshold_automation.py`, `backend/app/engine/jobs.py` (`runbook_reindex`), `backend/app/api/routes_rules.py` (docs strings), `routes_search.py` (palette entries), `routes_diagnostics.py` (wording), `routes.py` (the case Markdown report line), tests for each (RAG Published-only and the migration RAG trust test, chat kinds and aliases, replay freeze, export groups and dropped row tables, automation resolution, metrics) and the legacy RAG, chat-tool (`test_chat_tools_ops.py`, `test_chat_tools_registry.py`), threshold-automation, export (`test_discounted_inference_export.py`) and replay tests | A8a, A6b, A4b-2 | none | L |
| **A8c** Removals and packaging | §4.10.16 backend removals, packaging, §3.7 step 3 | delete `backend/app/playbooks/`, `backend/playbooks/`, `stores/playbooks.py`, `engine/runbook_service.py`, `engine/runbooks.py`, the old `app/runbooks/*.md`; `backend/app/rbac/policy.py` (`playbooks` leaves `RESOURCES` and the matrix); `backend/pyproject.toml`, `backend/MANIFEST.in`, `backend/Dockerfile` (the `COPY` lines only; the version markers `scripts/check_version.py` checks stay), `.github/workflows/ci.yml` (packaging lines only), `test_distribution_contract.py`, `test_portability_contract.py`, the final import grep test, and whatever legacy test still names a removed module (assigned by the orchestrator from the A8c grep) | A8b | none | M |

### 7.4 Wave B (generated contracts)

**WP-B1 Contracts and client.** After A8c (so no later backend package changes the OpenAPI
contract). Owns `webui/openapi.json`, `webui/src/lib/api-types.gen.ts`, and the reconciliation of
WP-0's hand mirrors (`types-*.ts`, `api-*.ts`) with the generated contract; once W5, W7a and W7b
no longer import the old `Playbook*`, `Runbook*` and `AuditRecord` declarations in `types.ts` and
the old methods in `api.ts`, B1 deletes them and re-exports the new names from `types.ts` (the
orchestrator schedules that hunk after W7b). Acceptance: `npm run check:types` with
`TLSOC_REQUIRE_TYPEGEN=1` passes; `tsc --noEmit` passes; the API client behaviour tests cover every
new method. Web packages before B1 build against WP-0's mirrors; B1 fixes any drift in their files
only through the orchestrator. WP-GEN re-runs `check:types` on the merged tree as the final
authority.

### 7.5 Wave C (web, exclusive ownership)

| WP | Delivers | Owns | After | Parallel with | Size |
|---|---|---|---|---|---|
| **W1** Small asks | §4.1, §4.2.3 client | `webui/src/soc/components/auth/rememberMe.ts`, `RememberMeControls.tsx`, `webui/src/soc/auth.tsx`, `webui/src/soc/pages/Login.tsx` (notice wiring only), `webui/src/soc/pages/settings/chat-agent.tsx` (defaults and bounds only), `webui/src/soc/chat/chat-api.ts` (`DEFAULT_CHAT_BOUNDS` only), their tests, `docs/administration/authentication.md` | WP-0, A1 | W2a, W3 | S |
| **W2a** Shared primitives, surfaces and headers | §3.1 type, §4.9.2 (`Panel`, `SectionTitle`, `KpiStrip`, `KpiTile` chrome, `ChartCard`, `PageHeader` with `back`, `PageContainer`, Tabs, formatting, Sheet close), §4.9.3, F1, F2, the guard test | new `webui/src/design-system/panel.tsx`, the `@/design-system` index and `catalog.ts`, new `webui/src/soc/components/KpiStrip.tsx`, `KpiTile.tsx`, `StatCard.tsx`, the `chrome="framed"` prop on the chat and report `KpiTile` callers (`ComparisonView.tsx`, `InfographicView.tsx`, `KpiGroupView.tsx`, `chat/report/ReportPanel.tsx`; one prop each), `ChartCard.tsx`, `PageHeader.tsx`, `PageContainer.tsx`, `webui/src/ui/tabs.tsx`, `webui/src/ui/sheet.tsx`, `webui/src/lib/format.ts`, `webui/src/styles/theme.css` (body figures, panel rules), new `console-grammar.guard.test.ts` and the `__tests__/guard-allow/` folder with one file per migrating package, `docs/development/ui-standard.md` (Page anatomy, Typography, Radii) | WP-0 | W1, W3, W4a | M |
| **W3** Navigation, registry, router, shell | §2.2 items 2, 3, 5, 6, 9, 13; §4.8; every deep-link key of §2.2, §4.5.1, §4.6.6, §4.8.2 and §4.10.12 (`board`, the audit keys, `rule`, `severity`, `severity_gte`, the Cases `rule` hash key and `initialRule`, the Case Manager `closedBy` key and the `#/scans` redirect, the runbooks `id`), every new `NavOpts` field; F13 in `AppShell.tsx`; its entry delta | `webui/src/soc/components/NavSidebar.tsx`, `webui/src/soc/AppShell.tsx` (nav, top bar, breadcrumb trail API `setBreadcrumbTrail`), new `webui/src/soc/nav-store.ts`, new rail tooltip and hover-intent modules, new `webui/src/lib/platform-keys.ts`, `chat/shortcuts/shortcut-list.ts` (the re-export only), `components/CommandPalette.tsx`, `webui/src/soc/registry.tsx`, `webui/src/soc/nav.ts`, `webui/src/soc/router.tsx`, `webui/src/soc/nav-types.ts`, the nav tests, `docs/development/ui-standard.md` (Navigation and information architecture, motion timings) | WP-0 | W1, W2a; commits after W2b (ui-standard order) | M |
| **R** Entry rebase (orchestrator) | §3.4, E11 | `webui/src/soc/__tests__/bundle-first-paint.test.ts`, `backend/tests/test_docs_round12_records.py` (repointed), the Round 12 SPEC §7.3 pointer sentence, this spec's §11.1 "Entry bundle" item | WP-0, W1, W2a, W3 | none | S |
| **W2b** Shared primitives, lists, forms and Settings | §4.9.2 (Table, `FilterBar`, `TimeRangePicker` props, `RefreshButton`, `ListRow`, `RowActions`, `StatusDot`, `Callout`, `NumberField`, `Field`, Settings primitives) | `webui/src/ui/table.tsx`, `webui/src/soc/components/DataTable.tsx`, `FilterBar.tsx`, `TimeRangePicker.tsx`, `RefreshButton.tsx`, `NumberField.tsx`, `Field.tsx`, new `webui/src/design-system/list-row.tsx`, `row-actions.tsx`, `status-dot.tsx`, `callout.tsx`, the `@/design-system` index and catalog entries for them (after W2a), `webui/src/soc/pages/settings/primitives.tsx` (`SettingsSection`, `SettingsGroup`, `SettingRow`), `webui/src/soc/components/SettingsGrid.tsx`, `docs/development/ui-standard.md` (tables, forms and Settings sections) | W2a | W1, W4a | M |
| **W4a** Overview without band headers | §4.3 | `webui/src/soc/pages/Overview.tsx`, `webui/src/soc/components/NoiseFunnel.tsx`, the Overview print block in `theme.css`, `overview.inventory.test.tsx`, `overview-panels.test.tsx`, `overview.print.test.ts`, `docs/analyst/overview.md` | W2a | W2b, W5 | S |
| **W6a** Rule sheet and RuleLink | §4.6.4, §4.6.5 (the component, its store and every RuleLink swap outside chat) | new `webui/src/soc/components/RuleLink.tsx`, `RuleSheet.tsx` and the rule-sheet module store, `pages/Overview.tsx` (the top-signatures RuleLink hunk), `pages/casedetail/FactsRail.tsx` (rule badges only), `UnifiedLogsSheet.tsx` (row details), `Tuning.tsx` and `HealthDiagnostics.tsx` (RuleLink swaps only), tests | W2b, A6a, W4a | W5 | M |
| **W4c** Dashboard widgets and data | §4.4.3, the row-level scope rule of §4.4.5, F3, F4 | `webui/src/soc/dashboard/widgets/**`, `DashboardDataProvider.tsx`, `dashboard/registry.ts` (after A2's stubs), `WidgetGrid.tsx`, widget tests | W2b, A2, A4b-1, W6a | W5, W6b | M |
| **W4b** Dashboards library and boards | §2.2 (library, boards, routes, header), §4.4.1 (client), §4.4.4 to §4.4.6 | `webui/src/soc/pages/Dashboards.tsx`, new `webui/src/soc/dashboard/builtins.ts`, new `dashboard/BoardView.tsx`, new `dashboard/Library.tsx`, `DashboardBuilder.tsx`, new tests `dashboards-library.test.tsx`, `dashboards-routes.test.tsx`, `docs/analyst/dashboards.md` (new), `mkdocs.yml` (its nav entry) | W4c, W3 | W5, W6b, W7a | M |
| **W5** Audit page | §4.5.1, §4.5.2, §4.5.6 (client), §4.5.7, §4.5.8, the client CSV rules | `webui/src/soc/pages/Audit.tsx` (rebuilt), new `webui/src/soc/components/audit/**` (inspector, JSON tree, events table and its fixture contract test, export menu and dialog), `webui/src/lib/csv.ts` with its fixture test, the "View in audit log" links in the Case trace component, `Users.tsx` and `Account.tsx` (one link each, handed back to W9a), tests, `docs/administration/audit-log.md` (new), `mkdocs.yml` (its nav entry, after W4b) | W2b, A4a, A5 | W4a, W6a, W6b, W7a | M |
| **W6b** Chat drill, severity and the Logs and Cases filters | §4.6.3 (web), §4.6.6, §4.7.3, F6, F7 | `webui/src/soc/chat/blocks/BlockCard.tsx`, `chat/blocks/renderers/TableView.tsx`, new `renderers/SeverityBreakdownView.tsx`, `chat/blocks/charts/HBarChart.tsx`, `chat/blocks/labels.ts`, `chat/blocks/schema.ts` (the `rule` page and opts validators), the chat entity block renderer, `chat/composer/access-copy.ts`, `pages/UnifiedLogs.tsx` (rule and severity chips), `pages/Cases.tsx` (the Rule filter control), tests, `docs/analyst/chat.md` (rule and severity sections) | W6a, A6b | W4b, W5, W7a | M |
| **W7a** Runbooks library and editor | §4.10.1, §4.10.12, §4.10.13 (client), F17 | `webui/src/soc/pages/Runbooks.tsx` (rewritten), new `webui/src/soc/runbooks/editor/**`, new `webui/src/soc/runbooks/shared/**` (step kind chip, status marks, governance badge, provenance chips; used by W7b), `Intelligence.tsx`, new `Personas.tsx` (split from `Catalog.tsx`), `Catalog.tsx` (deleted after the split), `runbookAuthoring.ts` and `runbookExamples.ts` (deleted), `rules/RuleEditor.tsx`, `rules/constants.ts` and `rules/types.ts` ("Attach a runbook", writing the existing `run_playbook` literal), `Docs.tsx` (the card only), tests, `docs/intelligence/runbooks.md` (rewritten), `docs/automation/rules.md` | W2b, W3, A7b, W6a | W4b, W5, W6b | L |
| **W7b** The run inside a case | §4.10.11 | new `webui/src/soc/pages/casedetail/RunbookPanel.tsx`, new `webui/src/soc/runbooks/run/**`, `CaseDetail.tsx` (tab, removal of Run a playbook), `casedetail/OverviewPanel.tsx` (Next step card), `casedetail/FactsRail.tsx` (Runbook section, after W6a), `casedetail/CollaborationPanel.tsx` and `CaseTasks.tsx` (Other tasks), `WhyPanel.tsx`, `InvestigationInputs.tsx`, the close dialog and `BulkCloseDialog.tsx` (close reason, sending `require_open_steps_reason`), the Case Manager queue chip (`CaseManager.tsx` row only), tests, `docs/analyst/case-manager.md`, `docs/analyst/investigation.md` and `docs/analyst/cases.md` (runbook sections) | W7a, W6a, A7c | W8a | L |

### 7.6 Wave D (page migrations, ask 8)

| WP | Owns | After | Parallel with | Size |
|---|---|---|---|---|
| **W8a** Pass 1, analytics | `pages/Metrics.tsx` (including "Runbook usage" replacing "Playbook usage"), `Cost.tsx`, `AgentEffectiveness.tsx`, `HealthDiagnostics.tsx` (after W6a), `Analytics.tsx`, `Standup.tsx`; their tests; its `guard-allow/W8a.json` | W2b, W6a, A8b | W8b, W9a, W9b | M |
| **W8b** Pass 1, triage and reporting | `pages/Cases.tsx` (phone list, columns, the `playbooks` column removed; after W6b), `UnifiedLogs.tsx` and `UnifiedLogsSheet.tsx` (density, after W6a and W6b), `Campaigns.tsx`, `Reports.tsx`, `Inbox.tsx`, `BatchJobs.tsx` (the `#/settings?s=discounted-inference` line), `Approvals.tsx`, `Investigate.tsx`, `Workspace.tsx`, the Case Manager frame and its "Closed by the AI agent" filter chip (`CaseManager.tsx` outside the queue chip, after W7b), `CaseActivityFeed.tsx`, `Scans.tsx` (deleted with its tests); its `guard-allow/W8b.json` | W2b, W6b, W7b | W8a, W9a, W9b | L |
| **W9a** Pass 2, Settings | `pages/Settings.tsx`, every `pages/settings/*.tsx` and `settings-sections-meta.ts`, `settings-sections.ts` (including the new `runbooks` and `discounted-inference` sections and the chat-agent layout after W1), `Account.tsx`, `Sessions.tsx`, `Users.tsx`, `Roles.tsx`, `Roles.api.ts` (new permission rows), `AdminSessions.tsx`, `Security.tsx`, `SessionPolicyEditor.tsx`; tests; `docs/administration/settings.md`; its `guard-allow/W9a.json` | W1, W2b, W3, A7a | W8a, W8b, W9b | L |
| **W9b** Pass 2, configuration pages | `Sources.tsx`, `SourceLogsSheet.tsx`, `SourceEditor.tsx`, `Tuning.tsx` (after W6a), `Baseline.tsx`, `BaselineGauge.tsx`, `Knowledge.tsx`, `Memory.tsx`, `Models.tsx`, `ModelsCatalog.tsx`, `Docs.tsx` (after W7a), `EnrichmentProvidersEditor.tsx`, `NotificationsEditor.tsx`, `DangerZone.tsx`, `rules/DetectionRulesHome.tsx`, `components/rules/AnalystPolicyBuilder.tsx`, `Wizard.tsx` and `Login.tsx` (uppercase labels, disabled button style; entry modules, measured after R), tests; its `guard-allow/W9b.json` | W2b, W6a, W7a, W1, R | W8a, W8b, W9a | L |

### 7.7 Wave E (records, regeneration, gates)

| WP | Delivers | After |
|---|---|---|
| **WP-DOC** | §9 (cross-cutting docs, spec amendments, AGENTS, HANDOFF, ROADMAP, CHANGELOG, Journal), `mkdocs.yml` (the approvals rename, after W5) | every W and A package |
| **WP-GEN** | regenerates `webui/openapi.json`, `api-types.gen.ts`, the console map (`npm run gen:console-map`), the Help Center corpus (`scripts/build_app_knowledge.py`) and the docs bundle; runs every gate of §8.2 on the merged tree (`check:types` as the final authority); fixes roots, not symptoms; updates the AGENTS.md and HANDOFF baselines; takes the final screenshots (§8.3, §8.4); opens the pull request into `Testing` and drives CI to green | WP-DOC |

### 7.8 Order in one view

```
Wave 0:  WP-0
Wave A:  A1 | A2 | A3 | A4a                       (from WP-0)
         A4b-1                                    (after A4a, A1)
         A4b-2                                    (after A4b-1, A2)
         A5 | A6a                                 (A5 after A4b-2; A6a after A4b-1, A2)
         A6b | A7a                                (A6b after A6a; A7a after A1, A3, A4a, A4b-1)
         A7b | A7c                                (after A7a; A7c also after A5, A6a)
         A8a -> A8b -> A8c                        (A8a after A7c; A8b also after A6b, A4b-2)
Wave B:  B1                                       (after A8c)
Wave C:  W1 (after A1) | W2a | W3                 (from WP-0; W3 commits after W2b)
         R                                        (orchestrator, after WP-0, W1, W2a, W3)
         W2b | W4a                                (after W2a)
         W5                                       (after W2b, A4a, A5)
         W6a                                      (after W2b, A6a, W4a)
         W4c | W6b | W7a                          (W4c after A2, A4b-1, W6a; W6b after W6a, A6b;
                                                   W7a after W3, A7b, W6a)
         W4b                                      (after W4c, W3)
         W7b                                      (after W7a, W6a, A7c)
Wave D:  W8a | W8b | W9a | W9b                    (each after the packages named in 7.6)
Wave E:  WP-DOC -> WP-GEN -> pull request into Testing
```

Web packages W1, W2a, W2b, W3, W4a and W5 may start while Wave A runs. The critical path is ask
9: A3, A7a, A7c, A8a, A8b, A8c, B1 on the backend and W6a, W7a, W7b on the web.

### 7.9 Ownership matrix for the shared files (conflict check)

| File | Sequence of owners |
|---|---|
| `backend/app/models.py` | WP-0 only; any later change goes through the orchestrator |
| `backend/app/config.py` | A1 (`ChatAgentConfig`), then A4b-1 (`Secrets.trusted_proxies`), then A7a (`RunbookConfig`) |
| `backend/app/rbac/policy.py` | WP-0 (new actions), then A7a (`normalise_grants`), then A8c (`playbooks` removed) |
| `backend/app/api/routes.py` | A4b-1, then A6a, then A7c, then A8b |
| `backend/app/state.py` | A4a, then A7a, then A8a |
| `backend/app/engine/jobs.py` | A4b-2 (reset jobs), then A5, then A7c, then A8b |
| `backend/app/engine/case_aggregate.py`, `agents/chat_tools/stats.py` | A2, then A6b (`stats.py`) |
| `backend/app/engine/demo_chat.py` | A6b, then A8b |
| `backend/app/agents/prompts.py` | A7c (two templates), then A8a |
| `backend/app/agents/pipeline.py` | A4b-1 (`run_id`), then A8a |
| `backend/app/api/routes_roles.py` | A4b-1, then A7a |
| `backend/app/api/routes_dashboards.py` | A2, then A4b-2 |
| `backend/app/api/routes_export.py`, `routes_rules.py` | A4b-2, then A8b |
| `backend/app/api/routes_search.py` | A4a, then A8b |
| `backend/tests/test_chat_contracts.py` | A1 (limits pins), then A6b (blocks half) |
| `AGENTS.md`, `docs/HANDOFF.md` | A4a, A6a, A7c (one router line each), then WP-DOC |
| `webui/src/soc/dashboard/registry.ts`, `widget-types.contract.json` | A2 (contract and stubs), then W4c |
| `webui/src/lib/useEventStream.ts` | A7c (`STREAM_CHANNELS` hunk) |
| `webui/src/lib/csv-formula.contract.json` | A5 (creates), read by W5 |
| `webui/src/styles/theme.css` | W2a, then W4a |
| `docs/development/ui-standard.md` | W2a, then W2b, then W3, then WP-DOC |
| `webui/src/design-system/index.ts`, `catalog.ts` | W2a, then W2b |
| `webui/src/soc/__tests__/console-grammar.guard.test.ts` | W2a only; W8a, W8b, W9a and W9b each own only their `guard-allow/<WP>.json` |
| `mkdocs.yml` | W4b, then W5, then WP-DOC |
| `webui/src/soc/pages/Overview.tsx` | W4a, then W6a (RuleLink hunk) |
| `webui/src/soc/pages/casedetail/FactsRail.tsx` | W6a, then W7b |
| `webui/src/soc/pages/UnifiedLogs.tsx` | W6b, then W8b |
| `webui/src/soc/pages/UnifiedLogsSheet.tsx` | W6a, then W8b |
| `webui/src/soc/pages/Cases.tsx` | W6b, then W8b |
| `webui/src/soc/pages/Tuning.tsx` | W6a, then W9b |
| `webui/src/soc/components/HealthDiagnostics.tsx` | W6a, then W8a |
| `webui/src/soc/pages/Docs.tsx` | W7a, then W9b |
| `webui/src/soc/pages/Login.tsx` | W1, then W9b |
| `webui/src/soc/pages/settings/chat-agent.tsx` | W1, then W9a |
| `webui/src/soc/pages/CaseManager.tsx` | W7b (queue chip), then W8b |
| `webui/src/soc/pages/Users.tsx`, `Account.tsx` | W5 (one link each), then W9a |
| `webui/src/lib/types.ts`, `api.ts` | WP-0 (optional additions), then B1 |
| `webui/src/soc/__tests__/bundle-first-paint.test.ts` | R only |
| Generated artefacts (`webui/openapi.json`, `api-types.gen.ts`, `backend/app/knowledge/console_map.json`, the knowledge corpus and manifest, the docs bundle) | regenerated by the orchestrator at each commit and by WP-GEN (§8.2), never hand-merged |

### 7.10 Acceptance per package (in addition to §8.1 and §8.2)

- **A1**: §4.2.4 tests; the Settings schema endpoint returns the new bounds.
- **A2**: §4.4.2 tests; `case_stats` and the endpoint return equal numbers for every `by` and every
  new metric on the Demo dataset and a 30,000-case fixture; every KPI strip binding pinned; the
  widget contract green on both stacks with the stubs.
- **A3**: every bundled runbook validates and fits the budget; matcher tests cover every tier and
  tie; the module imports nothing from the store, network or gateway (a test asserts it).
- **A4a**: paging and totals honest on both stores; the old `GET /api/audit` query shapes return
  the same rows as before; the Demo split shows a real sign-in beside demo agent rows;
  `audited_write` never returns success without its row.
- **A4b-1** and **A4b-2**: a sign-in, a failed sign-in, a role change, a settings change, an export
  and a reset each produce a row with every applicable new field; secrets and webhook URLs never
  appear in `changes`; a forged forwarded header never becomes `client.ip`.
- **A5**: a 1,284-row CSV export with a search term matches the page query exactly, oldest first,
  with SHA-256 equal to the file; an auditor can export; a download writes its audit row.
- **A6a**: Logs and Cases rule filters exact on every connector kind and on buffered rows; the
  rule summary degrades per section.
- **A6b**: the two operator questions reproduce with clickable rows; severity labels are named; the
  sampled caption appears only when needed; the blocks contract green on both stacks.
- **A7a**: migration of a store with 7 playbooks and 3 runbooks (one colliding id, one invalid, one
  shadowed by a legacy bundled id) yields 8 Published and 2 Draft, audited, idempotent; the
  18-document fixture of §4.10.17; custom roles keep every capability and no stored deny is lost.
- **A7b**: every governance transition and grant; match preview changes nothing (a store snapshot
  before and after is equal); the read aliases and `410`s.
- **A7c**: attach idempotency; the close reason on every human transition and never blocking; old
  close calls still 200; automatic closes ignore runs; lookups stay read-only (a write-guard spy on
  the stores and the log client) and respect their grants; the `case.runbook` channel delivered on
  the web.
- **A8a**: the investigator prompt carries the winning Published runbook within budget and never a
  draft; rationale reads old and new provenance rows; Demo cases receive guidance and runs.
- **A8b**: RAG indexes Published only and excludes untagged legacy chunks before the projection
  completes; replay is hermetic; export groups present and row tables dropped; `run_playbook`
  rules attach runbooks.
- **A8c**: no import of the removed modules remains (a test greps `backend/app`); `playbooks` is
  gone from `RESOURCES` with every effective grant otherwise unchanged; the wheel and the image
  carry the 12 runbook files; the full backend suite is green.
- **R**: the entry chunk at or below the rebased budget with per-file deltas recorded.
- **W1** to **W9b**: their sections' tests; live screenshots of every surface they change (§8.3);
  zero new em dashes; no "playbook" in Console-authored copy; each `guard-allow/<WP>.json` empty
  by the end of its package.

---

## 8. Verification

### 8.1 Tests per package

Each package adds the tests named in its section and in §7.3, §7.5 and §7.6, and updates the
existing tests its change touches (never deletes a test to make a gate green; a retired test is
replaced by one that pins the new contract). Backend tests run offline on the fake Elasticsearch
and on SQLite; web tests run under `test:strict`. Every new **surface** (a page, sheet, dialog or
widget) has tests covering: loading, empty, error, partial (where the data can be partial),
permission-denied, Demo Mode, phone width (by viewport mock: structure, not geometry), keyboard
operation, and the absence of em dashes and of the word "playbook" in Console-authored copy. Unit
tests of helpers and primitives test their own contract and are not held to that list. Geometry,
timing and pixel positions are never Vitest assertions (jsdom has no layout and the repository has
no browser lane); they are checked by the live QA harness (§8.3) and recorded in the Journal and
§11.4.

### 8.2 Gates (each package for what it touches; WP-GEN on the merged tree)

| Gate | Command (from the repository root unless noted) | Pass condition |
|---|---|---|
| Backend tests | `cd backend && . .venv/bin/activate && python -m pytest -q` | 0 failures; the new count recorded in the Journal |
| Python fatal static | `python -m ruff check --select E9,F63,F7,F82 backend/app backend/tests` (ruff 0.12.5) | 0 findings |
| Web tests | `cd webui && npm run test:strict` | 0 failures and zero stderr or captured console output |
| Type check | `cd webui && npx tsc --noEmit` | 0 errors |
| Lint | `cd webui && npm run lint` | 0 errors, 0 warnings (jsx-a11y at error) |
| Design gates | `cd webui && npm run gates` | tokens, contrast in both themes, colour-vision separation all pass |
| Generated types | `cd webui && TLSOC_REQUIRE_TYPEGEN=1 npm run check:types` | no drift between `openapi.json`, `api-types.gen.ts` and the backend |
| Full build | `cd webui && npm run build` | Help Center bundle plus `tsc --noEmit` plus Vite, clean |
| Entry budget | `bundle-first-paint.test.ts` (inside `test:strict`, and on the built `dist/`) | entry chunk at or below `PRE_REVAMP_ENTRY_BYTES + 1,024` and below 400,000 B; `motion` off the entry path; the one rebase is package R (§3.4, E11), with per-file before and after bytes |
| Docs bundle | `cd webui && npm run docs:check` | app 0.1.13 matches bundled docs 0.1 |
| Docs lint | `python3 scripts/check_docs.py` | 0 findings |
| Help Center corpus | `python3 scripts/build_app_knowledge.py --check` | the generated corpus matches the docs and the console map |
| CI contract | `python3 scripts/check_ci_contract.py` | the workflow lanes and the `CI passed` aggregate are intact |
| Version | `python3 scripts/check_version.py` | `VERSION`, `CHANGELOG.md` and the build metadata agree |
| Packaging | the CI image lane (`python -m pip check` in the image) after A8c | clean, the 12 runbook files present |

**Generated artefacts and records during the waves.** `webui/openapi.json`,
`webui/src/lib/api-types.gen.ts`, `backend/app/knowledge/console_map.json`, the Help Center
knowledge corpus and its manifest, and the docs bundle are derived files. A package that changes
their inputs (a route or model, `FEATURES` or `SETTINGS_SECTIONS_META`, a Help Center page) runs
the regeneration in its own tree to prove the gates (`npm run gen:console-map`,
`scripts/build_app_knowledge.py`, `npm run build`), but never hand-merges the files: the
orchestrator regenerates them on the merged tree at each commit, one commit at a time. The
Generated types gate is the exception during Waves A and C: before B1, drift between the live
backend and `api-types.gen.ts` is recorded in the package's progress file, not required to be
zero; B1 and WP-GEN require it green. The Round 13 records tests that count feature routers
(`test_docs_round13_records.py`) stay green because the package that adds a router adds its
one-line entries to `AGENTS.md` and `docs/HANDOFF.md` (§7.3).

No gate is softened, skipped or marked `continue-on-error` to make a package green.

### 8.3 Live screenshots of every changed surface

The orchestrator (or WP-GEN) runs the seeded demo (`./scripts/run-demo.sh`, or the
`SP/r14/proto/start-demo.sh` helper on unique ports) and captures every changed surface at 390 by
844, 1440 by 900 and 1920 by 1080, in light and dark, with the theme forced by rewriting
`GET /api/prefs/effective` in the browser context and `PUT /api/prefs/user` intercepted (never
pressing Save in Settings or Dashboards on the shared demo). Each capture records `overflowX` (must
be 0) and page errors (must be none). The surface list: sign-in with each notice reason; Chat
settings Timeouts and capacity; Cyber Defence Center; Dashboards library; each built-in board; a
personal board in view and Edit mode; the Duplicate dialog; Audit log in each scope, with the
inspector open, the export dialog and the cap state; a chat answer with Top detection rules and the
rule sheet open; the Logs page with a Rule chip; the severity breakdown (closed, a row open, Split
by Source); the navigation (rail, drawer, flyout, tooltip, phone sheet); Cases, Logs, Sources,
Campaigns, Analytics (every tab), Standup, Reports, Inbox, Jobs, Approvals, Entity investigation;
Settings (Chat assistant, Data scope, Users, Runbooks, Discounted inference); Models, Knowledge,
Memory, Baseline, Auto-tuning, Help Center; the Runbooks library, the editor (Edit, Preview,
Source, match panel, history, a built-in); a case Runbook tab (Next step card, a phase, an opened
Lookup step, a Decision, an Action waiting for approval, other tasks, the empty state, the Start
runbook picker, the close dialog with required steps open); the case Overview tab's Next step
card. Files: `SP/r14/qa/<surface>-<width>-<theme>.png`.

The same harness runs the **geometry and timing checks** that Vitest cannot (§8.1), each with its
measured value written to the Journal and §11.4: the Overview cases-row tops (§4.3.1); the page
header title top and first-content offsets (§4.9.3); the Settings first-control offsets, switch
distance and label overlaps (§4.9.6); nav icon drift through a toggle and the 4x CPU frame median
(§4.8.3); no horizontal scroll on the audit log at 1280 and 1440; the case sheet close button hit
by `elementFromPoint` (F1); the run tab Confirm position (§4.10.11). The harness scripts stay in
the scratchpad (`SP/r14/notes/harness.mjs`, `nav-repro.mjs`, `nav-perf.mjs`); a failed check is a
finding for the owning package, never a softened target.

### 8.4 Progress screenshots for the operator (binding)

- After each wave (A has no UI; send after C, D and E, and after any backend wave whose behaviour
  is visible in the existing UI, such as A1 in Chat settings), the orchestrator builds
  side-by-side **BEFORE | AFTER** composites: one image per surface, the BEFORE taken from the
  unchanged base build of WP-0 (`SP/r14/progress/base/`, commit `1cf20a7`), the AFTER from the
  current tree, the same viewport, theme, account, Demo dataset and scroll position.
- Composite recipe (ImageMagick, installed):

  ```
  montage -font DejaVu-Sans -pointsize 24 -background '#eef0f3' -geometry +24+24 -tile 2x1 \
    -label 'BEFORE (base 1cf20a7)' before.png -label 'AFTER (wave C)' after.png row.png
  convert row.png -gravity North -splice 0x80 -pointsize 34 \
    -annotate +0+20 'Dashboards library  ·  1440 light' composite.png
  ```

- Files: `SP/r14/progress/<wave>/<surface>-<width>-<theme>.png` (for example
  `SP/r14/progress/C/dashboards-library-1440-light.png`), one per surface at 1440 light, plus 1920
  dark and 390 light for the surfaces the wave changed most; an `INDEX.md` in each wave folder
  lists them with one line each on what changed.
- The orchestrator sends each wave's composites to the operator with a short update (what landed,
  what is next, anything that needs a decision), as the operator asked.
- **Items the operator can overrule**: the first Wave A update names E14 (old playbook write
  routes answer `410`; reads stay as aliases). The first Wave C update shows, beside the operator's
  C2 screenshot, BEFORE and AFTER crops of E1 (no description line, no icon chip on the library
  header) and E13 (pressing the Overview row does not expand its group), and asks whether to keep
  them.

---

## 9. Documentation and records

### 9.1 Help Center pages (in the same change as the behaviour; the package named owns it)

| Page | Change | Package |
|---|---|---|
| `docs/administration/authentication.md:45-48` | the sign-in page says why a session ended, without stating how long it lasted | W1 |
| `docs/administration/settings.md:118-122`, `docs/analyst/chat.md:1223, 1228-1231` | tripled capacity values, fifteen minutes of silence before a retry, the provider-limit sentence | A1 (docs), W9a (settings layout) |
| `docs/analyst/overview.md:54-65` | no bands; modules one gutter apart; the freshness stamp rule | W4a |
| `docs/analyst/dashboards.md` (new) | the library, the four built-ins, every module and KPI definition, Duplicate, Hide, the personal builder | W4b |
| `docs/administration/audit-log.md` (new) | scopes, fields, the inspector, retention, export, the personal data note, the index roll | W5 (A4a and A5 supply the facts) |
| `docs/analyst/chat.md` (rule and severity sections) | clicking a rule, the rule sheet, Logs with a Rule filter, named levels and Split by | W6b (the rule sheet text supplied by W6a) |
| `docs/intelligence/runbooks.md` (rewritten) | the one Runbooks feature: definition, step kinds, matching and Why attached, governance, versions, the editor, Markdown format, the built-in library, migration | W7a |
| `docs/analyst/case-manager.md`, `docs/analyst/investigation.md`, `docs/analyst/cases.md` | the Runbook tab, the Next step card, other tasks, the close reason | W7b |
| `docs/automation/playbooks-approvals.md` | the approvals content moves to a new `docs/automation/approvals.md` and the runbook content to the runbooks page; the old path stays for one release as a short stub page that links to `approvals.md` and the runbooks page (`mkdocs.yml` loads only the `search` plugin, so there is no redirect plugin and none is added); the `Docs.tsx` card link and `app_docs.json` (through the corpus regeneration) point at `approvals.md` | WP-DOC (the `Docs.tsx` link through the orchestrator after W9b) |
| `docs/automation/rules.md` | "Attach a runbook" replaces `run_playbook` (alias accepted) | W7a |
| `docs/intelligence/knowledge-memory.md`, `docs/concepts/deterministic-decisions.md`, `docs/concepts/terminology.md` | one word, Runbooks; runbooks never decide | WP-DOC |
| `docs/reference/permissions.md` | `audit:export`, `runbooks:run`, `runbooks:publish`, the `playbooks:*` mapping | WP-DOC |
| `docs/reference/api.md` | every new and changed endpoint, the `/api/audit` compatibility rules (`action`, `actor`, `limit` keep their meaning; `event`, `actor_contains` are new), the read aliases (`/api/playbooks`, `?shape=v1`) and the `410 runbooks_moved` writes, the close fields, `lifetime_seconds` not shown by the Console (§4.1.2) | WP-DOC |
| `docs/reference/configuration.md`, `docs/ENVIRONMENT.md` | `chat_limits_version` 2, `RunbookConfig`, the accepted old keys and how each maps, `UserPrefs.misc.dashboards_hidden` and `dismissed_intros`, `DashboardLayout.default_window`, the `TRUSTED_PROXIES` backend setting | WP-DOC |
| `docs/operations/background-jobs.md` | `audit_export`, artifact download auditing for every kind | WP-DOC |
| `docs/operations/upgrades.md`, `DEPLOY.md` | Round 14 upgrade notes: chat limits version 2, the audit write-index roll, settings saves now fail with `503` when the audit log cannot be written (audit before visible), `TRUSTED_PROXIES`, the runbook migration (what becomes Published or Draft and why, the RAG reprojection) and its rollback, the RBAC alias mapping of every grant and deny layer, the HTTP changes (read aliases, `410` writes, E14), the `run_playbook` behaviour change and `run.attach_skipped` | WP-DOC |
| the rest of the about 40 pages listed in [rbc §5] | runbook vocabulary | WP-DOC |

### 9.2 Development docs

`docs/development/ui-standard.md`: Page anatomy (the panel grammar for every page), Typography
(proportional body), Navigation and information architecture (C6 A, the toggle vocabulary
"Collapse navigation" and "Expand navigation", the Tab rule, the timings as the side-pane
standard), Dashboard bands rewritten (§4.3.4), Tables, Forms and Settings, Activity and audit logs
(the inspector grammar). `docs/development/design-system.md`: the new `@/design-system` exports
(`Panel`, `SectionTitle`, `ListRow`, `RowActions`, `StatusDot`, `Callout`) and the catalog
entries. `docs/development/extensions.md:117-134` and `docs/development/testing.md`: runbooks
instead of playbooks; the guard test.

### 9.3 Records

- `AGENTS.md`: the repository layout lines (runbook modules and stores, the removed playbook
  modules, the 12-file library; the one-line router entries for `routes_audit.py`,
  `routes_rule_summary.py` and `routes_case_runbooks.py` are added earlier by A4a, A6a and A7c so the
  Round 13 router-count records tests stay green), the "Current status" paragraph for Round 14, the
  baseline counts, and the naming contract list of accepted `playbook` identifiers.
- `docs/HANDOFF.md`, `docs/USAGE.md`, `README.md`: Round 14 in one paragraph each and the changed
  usage sections.
- `ROADMAP.md`: CACAO v2.0 export and import; streaming the audit log to a SIEM; "Draft a runbook
  from this closed case"; denial of service, vulnerability disclosure and cryptomining runbooks;
  "Set as my landing page"; row-level scope in aggregates; removal of the legacy `playbooks` and
  `runbooks` namespaces, the read aliases and the `410` routes next release.
- `CHANGELOG.md` `[Unreleased]` entry (WP-DOC writes it; wording binding, details may be added):

  ```
  ### Round 14
  - Dashboards: the Overview item in the navigation opens a Dashboards library with four
    built-in boards (Cyber Defence Center, marked Default, SOC operations, Detection and data
    health, Executive summary) and your own boards. The Cyber Defence Center stays the landing
    page. Built-ins are read-only; duplicate one to customise it. New GET /api/metrics/breakdown.
  - Audit log: server-paged, three scopes, search and filters in the URL, a record inspector with
    what changed, and CSV or JSON Lines export (new audit:export permission, fresh sign-in,
    audited). New audit fields on new rows: outcome, actor type, action, client, session, target,
    changes, request id, run id. Every job artifact download is now audited.
  - Rules: clicking a detection rule anywhere opens a rule sheet with its alerts over time, top
    sources and targets, latest alerts and cases, with "Open all in Logs". Logs and Cases accept an
    exact rule filter.
  - Severity breakdowns use named levels per source scale, show the top rules per level, say what
    was sampled, and offer Split by.
  - Runbooks: playbooks and runbooks are merged into one Runbooks feature: phased procedures with
    five step kinds, deterministic matching with a reason, a per-case checklist with a Next step
    card, Draft, In review, Published and Retired versions, and a library of 12 built-in runbooks.
    Stored operator playbooks and runbooks are converted once at startup. /api/playbooks answers
    410 for one release. Automation rules that ran a playbook now attach a runbook.
  - Console: a docked navigation rail that never moves its icons, the Overview's panels and header
    on every page, grouped Settings, and many smaller fixes.
  - Chat: Timeouts and capacity defaults tripled (stored values that equal the old defaults move
    once). The report summary wait stays below the web proxy limit.
  - Sign-in: the automatic sign-out notice no longer states how long the session lasted.
  ```

- `Journal.md`: an entry at the start and end of every package and wave (the AGENTS.md rule), with
  test counts, gate results and the screenshot folders; never local credentials or host details.

### 9.4 Amendments to earlier specs (recorded by WP-DOC)

- Chat-revamp `SPEC.md`: amendments for `drill` on table views, the `rule` page ref, the severity
  `kind` of the categories artifact, the case entity block wording, and the `get_case` runbook
  summary (next numbers after A68).
- `BLOCKS.md`: amendments for `drill` in tables and the severity breakdown view (next numbers after
  33).
- Round 12 `SPEC.md` and Round 13 `SPEC-chat.md`: a pointer that the chat capacity defaults and
  bounds changed (§4.2) and that the Overview bands are gone (§4.3). The Round 12 SPEC §7.3 "Entry
  bundle" bullet gains one sentence pointing to this spec's §11.1 (written by package R, §3.4, not
  WP-DOC, so the records test is never red between the rebase and the docs pass).

---

## 10. Not built this round (ROADMAP)

CACAO JSON import and export; drafting a runbook from a closed case; runbooks for denial of
service, vulnerability disclosure and cryptomining; "Set as my landing page"; org-published shared
dashboards (`CustomizationConfig.default_dashboards` stays dormant); audit log streaming to a SIEM,
CEF or LEEF, scheduled exports; row-level scope inside aggregates; executable response actions of
any kind (the suite never acts on another system); the Low severity hue change if it cannot pass
the gates (§3.1); removal of the legacy namespaces, the read aliases and the `410` routes (next
release); a browser test lane in CI (geometry stays a live-harness check this round, §8.1).

---

## 11. As built

Left empty on purpose. WP-DOC and WP-GEN record here, per package: contract resolutions, any
deviation from this spec with its reason, measured results (bundle bytes, screenshot folders,
timings), known limitations and the verification record.

### 11.1 Contract resolutions

- **Entry bundle.** Package R rebased the first-paint baseline once (§3.4, E11):
  `PRE_REVAMP_ENTRY_BYTES = 377_070` (377,070 B) in
  `webui/src/soc/__tests__/bundle-first-paint.test.ts`, with the unchanged +1,024 B budget
  over it and the unchanged 400,000 B ceiling. Every figure is the entry chunk on disk after
  `vite build`, attributed to source files through the source map. The spec commit and WP-0
  (`07a0a8f`) measure 371,876 B (WP-0 added no entry bytes). WP-0, W1, W2a, W2b and W3 took
  the entry to 384,789 B, 12,762 B over the old budget. Package R first moved what first
  paint never needs out of the entry, keeping every behaviour. The collapsed rail's
  interaction layer (the group flyouts, their hover intent, the one rail tooltip and the
  handlers that drive them) is the lazy chunk `nav-rail-interactions.tsx`;
  `nav-rail-loader.ts` prefetches it into the HTTP cache when the browser is idle, loads it
  on the rail's first pointer move or focus, and replays that first interaction once the
  handlers attach, so a pointer at rest or keyboard focus that arrived first still gets its
  tooltip or flyout (`NavSidebar.tsx` -4,744 B, `nav-rail-tip.tsx` -1,900 B,
  `nav-hover-intent.ts` -1,719 B, `nav-rail-loader.ts` +1,675 B, `nav-shared.ts` +295 B).
  `Field`'s two Settings row layouts are renderers in the lazy Settings primitives
  (`pages/settings/field-layouts.tsx`, `inlineFieldLayout` and `wideFieldLayout`) that
  `SettingRow` hands to `Field` through `FieldLayoutContext`, so Login and Wizard, which
  import `Field`, never carry them (`Field.tsx` -1,380 B). With +54 B of attribution drift
  on `main.tsx`, whose source did not change, that pass measured 377,070 B (-7,719 B), with
  W1 in the tree. The round's first-paint growth over 371,876 B is then
  +5,194 B, per file: `nav-store.ts` +2,125 B (W3: the rail state, open groups and
  breadcrumb trail, hydrated synchronously so the rail never flashes), `router.tsx`
  +1,558 B (W3: the Round 14 deep-link keys and page redirects, validated on the eager
  first route), `nav-rail-loader.ts` +1,675 B (R), `platform-keys.ts` +332 B (W3), `nav.ts`
  +327 B (W3), `nav-shared.ts` +295 B (R), `Field.tsx` +215 B (W2b, after R: the row
  renderer hook), `NavSidebar.tsx` -710 B (W3, after R), `AppShell.tsx` -480 B (W3),
  `registry.tsx` -191 B (W3), `auth.tsx` -120 B and `Login.tsx` -110 B (W1, the sign-out
  notice), `ui/sheet.tsx` +11 B (W2a), the build-written chunk list +14 B, and +253 B of
  attribution drift on files whose source did not change (`main.tsx` +153 B,
  `EmptyState.tsx` +114 B, others -14 B). Each of those runs before or during first paint.
  Package R's review fixes then spent 162 B of the 1,024 B budget, measured at 377,232 B:
  `nav-rail-loader.ts` +156 B (a failed load is retried on a later interaction after a
  pause, never on every pointer move) and `NavSidebar.tsx` +6 B (a grouped icon registers
  in a layout effect, before the replayed first interaction). Later packages that touch an
  entry module (W9b on Login and Wizard, A7c on the stream channels) measure inside what
  remains of the 1,024 B; going over is a finding for the orchestrator, never a second
  rebase. The Round 12 SPEC §7.3 "Entry bundle" item points
  here, and `backend/tests/test_docs_round12_records.py` reads this item.

### 11.2 Per package

### 11.3 Known limitations

### 11.4 Verification record

---

## Appendix A. Review notes

Two adversarial reviews (product safety: 32 findings; engineering: 31 findings) were resolved in
this revision. **No finding was rejected.** Where the resolution differs from the reviewer's
suggested fix, the reason is one line here:

- Client IP (product, major): the suggested `TRUSTED_PROXY_HOPS=1` set in the agnostic compose
  file cannot ship, because that file is the frozen updater base (`deploy/update-base-v1.sha256`,
  checked by `scripts/check_version.py`) and it also publishes the backend port directly; the spec
  instead trusts a forwarded header only from named proxies (`TRUSTED_PROXIES`, default the
  existing `tlsoc-webui` service name), which needs no compose edit (§4.5.3, E15).
- Audit before visible (product, major): applied to every new writer, not only to publish, role,
  settings and non-rollbackable stores, so there is one rule and no rollback path (§3.6, E16).
- Automation alias (product, major): resolved at fire time as suggested, and the rule editor also
  keeps writing the existing `run_playbook` literal, so stored Preferences never hold a value an
  older build rejects (§4.10.16).
- Migrated playbook guidance (product, major): the `focus` option was chosen over rendering
  instructions for imported versions, so the investigator rendering has one rule for every origin
  (§4.10.9, §4.10.17).
- Agent activity paging (product, minor): partial groups are marked with `run_totals` rather than
  paging by run, which keeps one paging model for every scope (§4.5.1).
- Group row and the screenshot (product, minor): the build matches the screenshot (pressing the
  row never expands the group, E13) instead of recording a deviation, and the first Wave C update
  still asks the operator to confirm it with E1 (§2.2 item 14).
- HTTP removals (product, major): reads stay as aliases per D44; writes answer `410`, recorded as
  E14 and named in the first Wave A update, because an old-shape write cannot be honoured without
  making unreviewed text trusted (#9).
- Breakdown metric definitions (both reviews): both families are kept (AI verdict and analyst
  outcome) rather than one, because the Executive board and the rule sheet need the analyst family
  while chat parity and "cases investigated" need the verdict family (§4.4.2).
- RuleLink ordering (engineering, major): solved by a separate package W6a that W4c and W7a
  depend on, and W6a also owns the Overview RuleLink hunk after W4a (§7.5, §7.9).
- Generated artefacts (engineering, blocker): the console map, corpus and docs bundle are
  regenerated by the orchestrator at each commit, and `check:types` drift is recorded rather than
  required before B1, combining both suggested options (§8.2).
