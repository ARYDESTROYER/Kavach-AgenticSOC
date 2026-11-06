# Round 14 research: whole-console UI audit, group B pages (ask 8, part 2b)

Author: research sub-agent `ui-audit-b`. Date: 2026-10-25. Branch `claude/round12` (fresh from Testing after Round 13).
Scope: the configuration, platform and reference pages (Sources, Detection and rules, Auto-tuning, Baseline, the Intelligence pages, Models, every Settings section, Users, Roles, Sessions, Account, Audit, Jobs, Scans, Help Center, Login, the first-run Wizard, the top bar and the command palette), audited against the Overview, which the operator calls "professional and neat".
Companion brief: `ui-audit-a.md` (group A, triage and reporting pages). Its section 3 ("the Overview standard") and its cross-cutting findings X1 to X19 apply here unchanged; this brief does not repeat them, it adds what group B shows on top, above all the Settings and form layer, which group A did not cover.
Out of scope: the left navigation rail and its animation (separate brief), and the content redesigns other Round 14 asks make (Audit log content and export: `audit-log.md`; Runbooks and Playbooks rebuild: `runbooks-industry.md`, `runbooks-codemap.md`; chat timeouts: `small-asks.md`). Where those pages appear here, only the visual grammar is assessed.

## 1. The ten things that matter most

1. **Every group B page uses the old header.** Every group B header except Auto-tuning (44 of 45 measured views) carries the icon chip; none matches the Overview's plain header. A dozen different overlines appear ("Platform", "Intelligence", "Administration", "Operations", "AUTOMATION", "Account", "Personal account", "Settings", "Analytics > Anomaly baseline", "Platform > Log Sources", "Help > Documentation", ...), several contradicting the rail (Models says "Administration" but lives under Analytics; Operator memory's code says "Platform"; Jobs says "Operations"). The overline system was already flagged as group A's X3; group B makes the case for removing it entirely.
2. **Settings speaks four layout grammars inside one page.** (a) `SectionShell` + `SettingsCard` bands with square icon chips and an anchor strip (8 sections), (b) `SectionTitle` + ad hoc `<section border-t>` blocks with `SubHeader` (10 sections, including Chat assistant), (c) embedded pages that bring their own `PageHeader` with eyebrow, icon chip and Refresh button (Profile, Sessions, Users, Roles, Admin sessions), (d) a bare `h3` card with no section title at all (Security and two-factor). On top sit four header layers (page header with description and status pill, "CONFIGURATION 29 sections", a breadcrumb context line with "No unsaved changes in this section", then the section `h2`), so the first control starts about 400 px down a 900 px screen. One Settings section layout fixes this; two options are shown with screenshots in section 6.
3. **A one-line typography bug is visible on every page**: `body { font-variant-numeric: tabular-nums }` (`webui/src/styles/theme.css:336`) widens Inter's hyphen, so hyphenated words render with gaps: the page title "Auto - tuning", "Re - run setup wizard", "warm - up", "analyst - confirmed", "Read - only". `docs/development/ui-standard.md` (Typography) already describes this effect and fixes it for chat prose only. Make the body proportional and put tabular figures only where numbers line up (tables, KPI numerals, timestamps, meta rows). High visibility, low risk.
4. **Numeric fields come in four patterns and are sized for paragraphs, not numbers.** Stepper with unit inside (Baseline, Rule editor, SLA), stepper without unit (Chat assistant), plain input with the unit outside (Security session policy), plain full-width input (Detection threshold, Data scope). A "3" sits in a 210 px field and a "14" in a 490 px field. Fourteen raw `type="number"` inputs bypass the shared `NumberField`. GOV.UK's design system advises sizing inputs to their content and avoiding `type="number"` ([GOV.UK text input](https://design-system.service.gov.uk/components/text-input/)); our `NumberField` already uses `inputMode="decimal"` text (`webui/src/soc/components/NumberField.tsx:189-190`) but stretches to `w-full` (`NumberField.tsx:211-212`).
5. **Seven more KPI tile styles** on top of group A's six: Sources' local `CoverageStat` with monospace numerals and uppercase labels, Baseline's `StatCard` tiles with coloured left bars, Knowledge/Memory/Models/Jobs/Scans strips with coloured icons and green or red numerals, Security's `PostureTile`, Storage's HOT/WARM/ARCHIVE tiles, and Tuning's three-up "Needs attention / Collecting evidence / Within target" strip. All should become group A's `KpiStrip` on a panel.
6. **Real defects found on the way**: the Audit log's Build column wraps "v0.1.13 · c00deef1c0" onto seven lines while the Detail column runs off the right edge, giving 131 px rows and a 26,559 px page for 200 events; the Models catalog shows the "Vision" chip twice for one model and wraps prices mid-phrase (137 px rows); the Memory form's Category and Tags fields are misaligned (labels and boxes at different heights); a Knowledge card's "0 docs" pill collides with its description; the Detection rules callout prints an internal reference "(#3)" to operators; Auto-tuning prints raw backend text ("configured mode=EVERY, which never consults n, so a correlation_n raise would change nothing"); ten places use 10 px text, below the standard's 11 px floor.
7. **One destination, several names.** Nav "Sources" / title "Log Sources" / button "New Log Source"; nav "Baseline" / title "Anomaly baseline"; nav "Models" / title "Models & LLMs"; nav "Documentation" / title "Help Center" / overline "Help > Documentation"; Settings rail "Models" / heading "Per-role models", "Updates & releases" / "Updates & release channels", "Single sign-on & policy" / "Security & single sign-on". The registry should own one label per page and every surface should read it.
8. **Tables disagree with each other even inside Settings**: 11 px uppercase tracked headers on Sources, Knowledge, Models, Audit, Jobs, Users, Roles, Sessions, Admin sessions and Tuning; 12 px sentence-case headers on Detection rules and Case policy. Row heights run from 32 px (Case policy) to 137 px (Models). Group A's X4/X9 table change (sentence case, one compact density) covers both.
9. **Five tab and section-navigation styles in this group alone**: boxed segmented tabs with icons (Auto-tuning), boxed tabs without icons (Models, Sessions, Rule editor), an underline anchor strip with icons (Data scope, Storage, Updates), a vertical anchor rail that makes a third navigation column beside the app rail and the Settings rail (Detection, SLA), and a boxed selected-item list (Help Center categories). Group A's X6 proposes one underline variant for page sections; Settings should drop in-section anchor navigation once sections are shorter.
10. **Red and colour at rest.** Every detection rule row shows a red trash icon; every session row shows a red "Revoke" link; Knowledge colours its corpus bars by guesswork (MITRE in critical red); "priority 50" chips are amber; green zeros on Memory, Models and Jobs. Colour should mean state; destructive actions should be neutral until confirmed in a dialog.

## 2. Method and artefacts

- Live shared demo `http://127.0.0.1:5901` (Demo Mode, synthetic data), Chromium via playwright-core. Every page at 1440x900 light (viewport and full page); a 28-view subset at 1920x1080 dark; Sources, Runbooks, Audit, Settings › Chat assistant (plus the Settings chooser and console controls) at 390x844 light; the Login page at all three.
- Theme was forced per browser context by rewriting `theme_mode` in the `/api/prefs/effective` response, so no run wrote the shared Admin preference (group A noted that clicking the theme toggle does).
- Screenshots: `<scratch>/r14/shots/research/ui-b/NN-<page>-<view>.png`. Numbering: 01 Sources, 02 Source logs sheet, 04 Detection rules home, 05 Rule editor, 06 Auto-tuning, 07 Baseline, 08 Knowledge corpus, 09 Reference runbooks, 10 Operator memory, 11 Response playbooks (Catalog), 12 Agent personas, 13 Models, 14 Audit log, 15 Jobs, 16 Automated scans (legacy), 17 Help Center, 20-47 one per Settings section (20 Profile, 21 Security and two-factor, 22 Sessions, 23 Appearance and customization, 24 Data scope, 25 Models, 26 Chat assistant, 27 Detection, 28 Cases, 29 SLA priority and suppression, 30 Automation, 31 Standup, 32 Alerting and notifications, 33 Enrichment, 34 Knowledge and threat context, 35 Users, 36 Roles, 37 Single sign-on and policy, 38 Admin sessions, 39 Secret keys, 40 Branding, 41 Updates, 42 Advanced, 43 All settings, 44 Demo, 45 Storage, 46 Data export, 47 Danger zone), 48 Settings chooser (phone), 50 Wizard (re-run), 51 command palette, 52 notifications popover, 53 version popover, 56 user menu, 57 top-bar search, 58 console controls (phone), 60-61 Login.
- Convergence previews (browser-only restyle, no repository edit): `P-settings-chat_agent-current-1440-light.png`, `P-settings-chat_agent-optA-grouped-1440-light.png`, `P-settings-chat_agent-optB-annotated-1440-light.png`, `P-settings-general-optA-grouped-1440-light.png`, `P-settings-general-optB-annotated-1440-light.png`, `P-sources-converged-1440-light.png`, `P-knowledge-converged-1440-light.png`, `P-models-converged-1440-light.png`, `P-baseline-converged-1440-light.png`, and dark variants (`-1920-dark`) for the Settings options and Sources, all in the same folder.
- Objective DOM measurements (header, panels, bordered cards and radii, nested cards, uppercase labels, table header and row metrics, tabs, buttons, icon sizes, overflow, plus a form pass: label placement, control widths and heights, switches, steppers, help-text sizes, headings): `<scratch>/r14/notes/uib/audit-1440-light.json`, `audit-1920-dark.json`, `audit-390-light.json`. Scripts: `.../notes/uib/shoot.mjs`, `form-fn.mjs`, `preview.mjs`, `login.mjs` (the DOM audit function is shared with group A: `.../notes/uia/audit-fn.mjs`).
- Not reachable in Demo Mode: the source Add/Edit editor (Sources.tsx:915 disables "New Log Source" for demo-managed state); the Wizard's Data sources stage shows the same `SourceEditor`. The update button and health popover opened nothing in this demo build.

## 3. The reference, and what is different for configuration pages

The Overview standard is defined in `ui-audit-a.md` section 3 (plain header with controls in `meta`, `.surface-panel` modules with 14 px titles inside, one KPI strip on a panel, ink numerals, divider-led lists, 40 px between bands). Measured live again here: Overview has 7 panels, 0 bordered cards, header 48 px; every group B page has 0 panels and an icon chip header of 68 to 86 px (audit-1440-light.json).

The Overview has no forms, so configuration pages need one more reference. Industry practice for settings and forms:

- Labels above fields, short, sentence case, no colons; helper text under the label or field; a consistent 32 px between fields; inputs aligned to grid columns, two columns only when they "respond as a group" ([Carbon form usage](https://carbondesignsystem.com/components/form/usage/)).
- Size each input to the content it takes; avoid `type="number"` because scrolling changes values and it gives poor feedback ([GOV.UK text input](https://design-system.service.gov.uk/components/text-input/)).
- Group related settings; Apple's grouped list style "uses headers, footers, and additional space to separate groups" ([Apple HIG, lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)); nested boxes "can make your interface feel busy and constrained", and a box close to the size of its window "becomes less effective at communicating the separation of grouped content" ([Apple HIG, boxes](https://developer.apple.com/design/human-interface-guidelines/boxes)).
- Settings pages commonly use an annotated layout: "In the left column, glanceable labels and descriptions ... In the right column, settings are grouped in cards"; descriptions only when they clarify, one to three sentences, never repeating the title ([Shopify Polaris, app settings layout](https://polaris.shopify.com/patterns/app-settings-layout)).
- Minimize the number of settings, and keep task-specific options in the screen they affect rather than in a settings area ([Apple HIG, settings](https://developer.apple.com/design/human-interface-guidelines/settings)). That supports keeping Auto-tuning policy, Baseline policy and Jobs options next to their data, provided they use the same form primitives as Settings.

Inside the console the closest existing references are Settings › Models (25-settings-models: a clean two-column grid of labelled selects) and the first-run Wizard shell (50-wizard), which `ui-standard.md` (Guided setup workflows) already names as the guided-workflow reference.

## 4. Cross-cutting findings for group B (ranked)

Each finding: evidence, source, exact change. High = broken, clipped, misleading or seen on every page; Medium = visible inconsistency on a main page; Low = polish. Group A's X1 to X19 also apply to every page below; the "Y" findings are new.

### Y1. Hyphen gaps from global tabular figures (High)
- Evidence: 06-tuning ("Auto - tuning" as the page title, "analyst - confirmed", "false - positive"), 07-baseline ("Per - entity", "warm - up", "Half - life", "t - digest"), Settings header ("Re - run setup wizard"), 13-models ("per - role", "cost - budget"), 14-audit ("Read - only, append - only").
- Source: `webui/src/styles/theme.css:336` (`font-variant-numeric: tabular-nums` on `body`).
- Change: body `proportional-nums`; add `tabular-nums` to `td`, `KpiTile` numerals, `TimeRangePicker`, timestamps and meta rows (most already carry `tabular-nums` explicitly; grep shows the class on numerals across the console). Update the Typography paragraph of `ui-standard.md` to make proportional the default, not a chat exception.

### Y2. Headers: chip, overline, second description, embedded headers (High)
- Evidence (all 1440 light): icon chip on 44 of 45 views (all but Auto-tuning). Overlines: Sources breadcrumb "Platform > Log Sources" (Sources.tsx:905-909), Baseline "Analytics > Anomaly baseline" (Baseline.tsx:121-125), Intelligence host eyebrow "Intelligence" (Intelligence.tsx:83-87), Memory "Platform" when standalone (Memory.tsx:751-755), Runbooks "Intelligence" (Runbooks.tsx:1367-1371), Models "Administration" (Models.tsx:183-187), Settings breadcrumb "Platform" (Settings.tsx:625-628, eyebrow "Platform" again at 531 and 545 in the loading and error states), Users and Roles "Administration" (Users.tsx:344-349, Roles.tsx:356-361), Security "Settings" (Security.tsx:649-653), Sessions "Account" (Sessions.tsx:528-533), Admin sessions "Administration" (AdminSessions.tsx:140-145), Account "Personal account" (Account.tsx:391-396), Audit "Platform" (Audit.tsx:341-345), Jobs "Operations" (BatchJobs.tsx:416-420), Scans literal capitals "AUTOMATION" (Scans.tsx:384-388), Docs breadcrumb "Help > Documentation" (Docs.tsx:382-386). Auto-tuning is the one header already close to the Overview (no chip, no overline, Refresh in actions, Tuning.tsx:828-834), apart from its two-line description.
- A second description paragraph repeats the header description on Runbooks (Runbooks.tsx:1378-1383), Response playbooks (Catalog.tsx:1304) and Agent personas (Catalog.tsx:304).
- Inside Settings, embedded pages render a full `PageHeader embedded` with eyebrow, chip, `h2` at 20 px, description and their own Refresh button (35-settings-admin_users, 36-settings-roles, 20-settings-profile, 22-settings-sessions), while other sections use `SectionTitle` (`pages/settings/primitives.tsx:60-76`) and Security and two-factor has no section heading at all (21-settings-account_security).
- Change: group A's `PageHeader` defaults (no chip, no eyebrow or breadcrumb on routed pages, one short description or a HelpTip). For embedded bodies, `PageHeader embedded` renders exactly like `SectionTitle` (no eyebrow, no chip) and moves Refresh into the section's action slot; Security and two-factor gets a `SectionTitle`. Delete the second description paragraphs (fold any unique sentence into the HelpTip).

### Y3. Settings: four grammars and four header layers (High)
- Evidence: 24, 26, 27, 32, 35, 37, 40, 45 (see section 1, item 2). Measured: section renderer files using `SectionShell` + `SettingsCard`: `general.tsx`, `detection.tsx`, `case-policy.tsx`, `knowledge.tsx`, `release-updates.tsx`, `storage.tsx`, `advanced.tsx`, `advanced-schema.tsx`; using `SectionTitle` + ad hoc sections: `chat-agent.tsx`, `automation.tsx`, `cases.tsx`, `data-export.tsx`, `detection-rules.tsx`, `enrichment.tsx`, `keys.tsx`, `models.tsx`, `standup.tsx`, `security.tsx` (all under `webui/src/soc/pages/settings/`). Subheaders appear in five styles: 14 px semibold (`SubHeader`, primitives.tsx:79-90), 16 px with a square bordered icon chip (`SettingsCard`, `webui/src/soc/components/SettingsGrid.tsx:100-112`, the chip has no radius at line 102), uppercase 12 px tracked ("CHANNELS", "EMAIL TEMPLATES", "PREVIEW": `NotificationsEditor.tsx:931, 950, 964, 1122, 1159, 1175, 1232`; detection legends at `detection.tsx:462, 474`; storage tiers at `storage.tsx:300-318, 399-409`), a title followed by a trailing horizontal rule ("Data access", 39-settings-keys), and an icon plus title (Security "Token & session policy").
- Header layers: page header with description and a "Preferences saved" pill (Settings.tsx:625-660), the rail heading "CONFIGURATION" with a monospace "29 sections" count (Settings.tsx:735-740), the context line with icon, breadcrumb, "Ask about this" and the always-on "No unsaved changes in this section" (Settings.tsx:760-783), then the section `h2` and description. The section name therefore appears three times (rail highlight, breadcrumb, `h2`).
- Change: one `SettingsSection` (title, one-line description, optional actions, "Ask about this" in the title row) containing `SettingsGroup`s of `SettingRow`s (section 7). Remove the context line's breadcrumb and the negative status text (show "Modified" only when true, beside the title); drop the page description and the section count; sentence-case the rail heading and group labels. Pick option A or B in section 6 for how groups are drawn.

### Y4. Form fields: widths, number inputs, alignment (High for widths, Medium otherwise)
- Evidence (form audit, 1440 light): label placement is consistently above the control (good, matches Carbon), but control widths for one-to-three-digit values range from 110 px (Security session policy) through 210 px (Chat assistant) to 490 px (Baseline half-life); stepper buttons sit outside the field on Baseline, Rule editor, SLA, Chat assistant and Enrichment while Security puts the unit outside a plain box; Detection "Threshold (N)" is a 290 px plain box (27-settings-detection); risk weights show each value three times (bold label "0.25", an input "0.25", and "25% of score", 27-settings-detection); Baseline's z-threshold shows "3.5" twice (07-baseline).
- Sources: `NumberField.tsx:211-212` (`w-full`); raw `type="number"` at `SourceEditor.tsx:520, 1108, 1887`, `rules/AnalystPolicyBuilder.tsx:154`, `SessionPolicyEditor.tsx:191`, `NotificationsEditor.tsx:472, 1241, 1252, 1269`, `Models.tsx:671, 683`, `Catalog.tsx:985`, `settings/primitives.tsx:305` (`NumPref`, used by many sections), `settings/knowledge.tsx:379`.
- Memory's "Add a memory" form hand-rolls `Label` + `Input` for Category next to `TagInput` (which uses `Field`), so the two labels and boxes do not line up (Memory.tsx:213-237; visible in 10-memory).
- Change: one `NumberField` everywhere (replace `NumPref`'s input and the 13 other raw inputs), with a `size` prop (`xs` 6 rem, `sm` 8 rem, `md` 12 rem) defaulting by `max` digits, unit always inside, steppers inside the field's right edge or omitted for values over 1,000; sliders show the value once (in the input). Every labelled control goes through `Field`.

### Y5. KPI and status tiles (Medium)
- Evidence and sources: Sources `CoverageStat` with `font-mono text-lg` numerals and `text-2xs uppercase` labels (Sources.tsx:1340-1365); Baseline `StatCard` with `accent` left bars (BaselineGauge.tsx:337-370) plus uppercase 10 px labels (BaselineGauge.tsx:172, 233, 244) and an 11 px one (253); Knowledge, Memory, Models, Jobs and Scans strips with coloured icons and green or red numerals (`KpiTile variant="strip"` with `accent`, e.g. Memory.tsx:787-800, Models.tsx:209); Security `PostureTile` uppercase label (`settings/primitives.tsx:484-510`, label at 502); Tuning's three state tiles with uppercase labels and a green "0".
- Change: group A's `KpiStrip` (panel, sentence-case 13 px labels, ink numerals, no icons, red only for a non-zero critical count). `PostureTile` becomes a `SettingRow` with a status dot, or a compact strip. Storage tiers become a three-column `dl` on a panel.

### Y6. Defects (High)
- Audit Build column: the 11 rem width (Audit.tsx:284-302) is ignored because the Detail cell's `InlineCode` is unbounded and `nowrap`, so the table gives Detail all remaining width and squeezes Build to about 50 px; Detail is then clipped at the right edge with no affordance (14-audit). Fix in the table: `table-layout: fixed` with explicit widths, and truncate Detail to one line with the full text in the row's detail view (the Audit brief adds that view).
- Models capability chips: "Vision" appears twice for Claude Fable 5 because a `vision` modality and a `vision` capability each push a chip (`ModelsCatalog.tsx:50-52` and 66). De-duplicate by label. Price text "in $10.00 · out $50.00" wraps between "out" and "$50.00"; put input and output on separate lines with `whitespace-nowrap` per figure.
- Memory field misalignment (Y4).
- Knowledge "Threat intel" card: the "0 docs" pill touches the description text (08-knowledge); the description needs `pr` equal to the pill width or the pill moves into the title row.
- Detection rules callout says "(#3)" (`rules/DetectionRulesHome.tsx:323-330`), an internal non-negotiable number. Rewrite: "The close or escalate decision is always made by code; a rule can recommend, tag, notify or propose, never set a case status."
- Auto-tuning shows the backend's `correlation_n_inert_detail` text verbatim ("mode=EVERY ... correlation_n", Tuning.tsx:183-190; the label map at 168 also says "Rule is configured mode=EVERY"). Map each reason code to a plain sentence ("This rule fires on every event, so raising its threshold would change nothing") and never render the raw detail.
- Text below the 11 px floor (`ui-standard.md`, Typography): `text-[10px]` at `EnrichmentProvidersEditor.tsx:211, 228`, `ModelsCatalog.tsx:170, 213`, `BaselineGauge.tsx:172, 233, 244`, `AppShell.tsx:877, 1420, 1676`.

### Y7. One name per destination (Medium)
- Evidence: see section 1, item 7. Sources: Sources.tsx:907-908 and 918, 962 ("Log Sources", "New Log Source"); Baseline.tsx:123-124; Models.tsx:186; Docs.tsx:383-384 ("Help Center" under breadcrumb "Help > Documentation", rail "Documentation"); Settings `h2`s in `settings/models.tsx`, `settings/release-updates.tsx`, `settings/security.tsx` versus `settings-sections-meta.ts` titles.
- Change: the page title is the registry label (`webui/src/soc/registry.tsx`); a longer form may appear only as the description. Settings `h2` equals the section's `title` in `settings-sections-meta.ts`. Buttons use the plain noun ("Add source").

### Y8. Section navigation inside pages (Medium)
- Evidence: Auto-tuning boxed tabs with icons (Tuning.tsx:921-940); Models boxed tabs (Models.tsx:216-220); Sessions boxed tabs with icons (22-settings-sessions); Rule editor boxed tabs (05-rules-editor); Data scope, Storage and Updates underline anchor strips with icons (`SectionShell`, primitives.tsx:184-208); Detection and SLA vertical anchor rails (`SectionShell rail`, primitives.tsx:160-181), which create a third navigation column (27, 29).
- Change: page and record sections use group A's underline tabs (13 px, no icons). Settings sections drop anchor navigation: with grouped panels a section is short enough to scroll; the few long sections (Detection, SLA, Enrichment, All settings) split into sub-sections in the Settings rail or use collapsible groups.

### Y9. Callouts and explanatory text (Medium)
- Evidence: an always-on info callout above the content on Detection rules (04), Baseline (07), Memory (10), Secret keys (39), SLA (29: a warning callout and an info callout stacked), Roles (36: warning "RBAC is disabled", appropriate), Storage (45: warning, appropriate). Several restate the non-negotiables in long prose ("never the verdict", "advisory only") on every visit.
- Change: one `Callout` primitive with three uses only: a real current condition (warning), a blocking error, or a first-run explanation that can be dismissed. Reassurance that does not change what the operator does moves into the section HelpTip or the Help Center (ui-standard "Empty-state semantics" and Polaris's "only when it clarifies").

### Y10. Destructive and coloured affordances at rest (Medium)
- Evidence: red trash icon on every rule row (`rules/DetectionRulesHome.tsx:443-446`); red "Revoke" on every session row and a red outlined "Sign out all other sessions" (22-settings-sessions); red trash on the Users row (35); Knowledge corpus bars coloured by name with MITRE in critical red (`Knowledge.tsx:162-170`); amber "priority 50/82/88" chips on playbooks (11-catalog); green "Runnable" and "Ready" badges on every row (09, 11).
- Change: row actions are neutral ghost icons (red only on hover/focus and in the confirm dialog); bars use one neutral series colour (or the Okabe-Ito categorical ramp already in the tokens when categories need telling apart); priority is plain text; "Ready" is the default state and is not badged, only exceptions are.

### Y11. Lists of cards instead of rows (Medium)
- Evidence: Enrichment renders 38 bordered provider cards (41 bordered cards, 10,965 px page, 33-settings-enrichment); Automated scans renders 50 bordered case cards with a 4 px green left border (51 cards, 4,975 px, 16-scans); Jobs' system workers are boxed cards (15-jobs); Runbooks, Playbooks and Personas are divider rows with per-row "Reindex" and "Open" buttons (09, 11, 12).
- Change: one `ListRow` pattern on a panel (title, one muted line, trailing status and one trailing action, the rest in a row menu or the detail sheet), with a filter when the list can exceed about 12 items. Enrichment providers become rows with an on/off switch and "Needs key" status, details in a sheet.

### Y12. Width discipline on wide screens (Low)
- Evidence (1920 dark): Sources' Name column takes about 780 px while Protocol wraps to three lines (01-sources-1920-dark); Baseline's policy form is capped near 1,080 px while the KPI tiles above span the full 1,630 px, leaving a ragged right edge (07-baseline-1920-dark); Settings help text runs to about 760 px per line.
- Change: tables size columns to content with a max on the name column; forms cap at a reading measure (about 56 rem) and their containers cap with them; help text caps at 38 to 42 rem (the chat prose measure from Round 13).

### Y13. Top bar and overlays (Medium)
- Evidence: the bell carries an amber warning triangle overlay that reads like a broken icon (all screenshots, top right); two amber pills side by side mean different things ("Demo mode", "v0.1.13 · Testing") next to an outlined "Enable updates" button, so three chips compete for attention; the notifications popover leads with an uppercase amber "AGENT HEALTH · LAST 24 HOURS" band of 11 px four-line paragraphs with "document(s)" and "record(s)" (52-topbar-notifications); the user menu's Appearance row has a 20 px icon and a taller row than its 16 px siblings (56-topbar-usermenu). The command palette (51) and version popover (53) are consistent and need no change.
- Change: health shows as a small dot on the bell (the label already carries the state), not a triangle; Demo mode uses the neutral or info pill and the channel pill stays amber only for Testing; the popover's health band becomes one line per issue with a "View" link and proper plurals; menu icons all 16 px.

## 5. Page-by-page findings

Ranks: H high, M medium, L low. Line numbers on `claude/round12` at the time of this audit. Cross-references to group A findings are given as X-numbers, to this brief's cross-cutting findings as Y-numbers.

### Sources (list), 01-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| SO1 | M | Header: chip, breadcrumb "Platform > Log Sources", title "Log Sources" (rail "Sources"), description | Sources.tsx:905-909 | Overview header; title "Sources"; "Add source" in actions (Y2, Y7) |
| SO2 | M | Coverage strip: monospace numerals, uppercase labels, icons, on the canvas with `border-y` | Sources.tsx:1297-1365 | `KpiStrip` on a panel (Y5); preview P-sources-converged |
| SO3 | M | Table in a bordered card with 11 px uppercase headers; Protocol wraps to three lines while Name has spare width | DataTable; Sources.tsx column defs | Panel + sentence-case headers (X4); Protocol `whitespace-nowrap` or truncate (Y12) |
| SO4 | M | Toolbar: Filter button + full-width search + "Log Sources (5)" + Refresh + Columns; the count repeats the strip | Sources.tsx:970-1050 | `FilterBar` (search, facets, Columns); Refresh in header `meta` (X7); drop the inline count |
| SO5 | L | The disabled primary "New Log Source" in Demo Mode is a pale blue block with no reason visible | Sources.tsx:915 | Keep enabled-looking outline with a tooltip "Demo sources are managed by Demo Mode", or hide in Demo Mode |
| SO6 | L | Enabled switches are disabled in demo but look active-blue | Sources.tsx:730 | Disabled switch styling (opacity) with the same tooltip |

### Source logs sheet, 02-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| SL1 | H | Same defects as group A's LG1: timestamp wraps to two monospace lines, 57 px rows, uppercase headers | `SourceLogsSheet.tsx` (shares the row model with `UnifiedLogsSheet.tsx`) | Same fix as LG1 (compact density, time-only nowrap timestamp) |
| SL2 | H | Message column shows only "10.20...." at 1440 px: the one column that explains the event is the narrowest | SourceLogsSheet column widths | Message takes the flexible width; Source IP and Module fixed narrow |
| SL3 | L | "SEARCH · most recent 100 (more exist)" in capitals above the table | SourceLogsSheet | Sentence case muted caption |

### Detection and rules (Settings), 04-*, and Rule editor, 05-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| DR1 | H | Callout leaks "(#3)" and restates policy on every visit | rules/DetectionRulesHome.tsx:323-330 | Plain wording; HelpTip instead of a permanent callout (Y6, Y9) |
| DR2 | M | Red trash on every row; history and edit icons beside it | rules/DetectionRulesHome.tsx:443-446 | Neutral row actions; edit on row click; history and delete in a row menu (Y10) |
| DR3 | M | Rules table uses sentence-case 12 px headers while every other table uses uppercase 11 px | DetectionRulesHome table | Becomes the standard (X4) |
| DR4 | M | Editor: boxed tabs, uppercase "CONDITION" and "THRESHOLD" labels plus an uppercase orange "THRESHOLD RULE" badge, condition and threshold in nested bordered boxes, stepper buttons outside the fields, lower half of the sheet empty | rules/RuleEditor.tsx:165, 178-182, 359 | Underline tabs (Y8); 14 px semibold group titles; badge as plain text in the type select; groups as panels inside the sheet; `NumberField size="sm"` (Y4) |
| DR5 | L | Sheet description ends with an em dash clause | rules/DetectionRulesHome.tsx:470 | "Saving writes configuration only. It never changes a case decision." |

### Auto-tuning, 06-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| TU1 | H | Raw backend text in "Next step" | Tuning.tsx:168, 183-190 | Reason-code sentences (Y6) |
| TU2 | H | Title renders "Auto - tuning" | theme.css:336 | Y1 |
| TU3 | M | Boxed tabs with icons; state tiles with uppercase labels and a green 0 | Tuning.tsx:921-940; state strip | Underline tabs (Y8); `KpiStrip` (Y5) |
| TU4 | M | "Operating policy" status row is a third header band between header and tabs | Tuning.tsx (policy band below header) | Move the four facts into header `meta` as one muted line ("Active · confirmed auto-apply · nightly · 99 closed cases") |
| TU5 | L | Rule ids in monospace as the row title | Tuning rule rows | Rule name in Inter, id as a muted second line (ids stay mono) |

### Baseline, 07-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| BL1 | M | Breadcrumb "Analytics > Anomaly baseline", chip, two-line description with an em dash | Baseline.tsx:121-125 | Overview header, title "Baseline" (Y2, Y7) |
| BL2 | M | Four bordered tiles with coloured left bars and uppercase labels; "Hour of week" set as a numeral | BaselineGauge.tsx:336-370 | `KpiStrip`; seasonality as context text, not a numeral (Y5) |
| BL3 | M | Policy form: square icon chip, info callout, 490 px number fields, value shown twice on the slider | SettingsGrid.tsx:102; NumberField; LabeledSlider | Y3/Y4: `SettingsGroup` panel, `NumberField size="sm"`, one value |
| BL4 | L | "OVERALL WARM-UP" uppercase; an empty progress track nearly invisible in dark | BaselineGauge.tsx:253 | Sentence case; track uses `--panel-muted` inside a panel |

### Intelligence host and its pages: Knowledge corpus 08, Reference runbooks 09, Operator memory 10, Response playbooks 11, Agent personas 12
Runbooks and Playbooks are being rebuilt under ask 9; the findings below are only the grammar the rebuilt pages should not repeat.
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| IN1 | M | Eyebrow "INTELLIGENCE", chip, description with an em dash (Knowledge) | Intelligence.tsx:36-62, 83-87 | Overview header; HEADERS descriptions one short line without dashes |
| IN2 | M | "Knowledge controls / Index health and documents" and "Memory controls / Facts and review status" bands with a Refresh repeat the header | Knowledge.tsx:1713-1714; Memory.tsx:746 | Refresh in header `meta`; drop the band (X7) |
| IN3 | M | KPI strips with coloured icons and a green monospace embedding model inside a numeral slot | Knowledge strip; Memory.tsx:787-800 | `KpiStrip`; model name as a plain row (same as group A AN8) |
| IN4 | M | Corpus bars coloured by name (MITRE red) with percentages on a separate line | Knowledge.tsx:162-170, 1807 | One series colour; value and percent on the label row (Y10) |
| IN5 | M | Threat intel / Resolved cases are bordered cards with icon chips; the "0 docs" pill collides with the text | Knowledge.tsx:1014-1032 | Panels; pill in the title row (Y6) |
| IN6 | M | Second description paragraph under the header on Runbooks, Playbooks and Personas | Runbooks.tsx:1378-1383; Catalog.tsx:304, 1304 | Remove (Y2) |
| IN7 | M | Memory form: misaligned Category and Tags; disabled primary washed out; em dash in the placeholder | Memory.tsx:213-237 | `Field` for both (Y4); standard disabled style |
| IN8 | L | Per-row "Reindex" and "Open" buttons, "Updated" rows showing only the dash placeholder, amber "priority" chips, green "Ready"/"Runnable" on every row | Runbooks.tsx:669-740; Catalog rows | `ListRow` with one action, exceptions-only badges (Y10, Y11) |
| IN9 | L | Monospace counts ("9 available", "rev 1") in list headers | Catalog.tsx list header | Inter tabular figures |

### Models, 13-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| MO1 | H | Duplicate "Vision" chip; prices wrap mid-phrase; 137 px rows | ModelsCatalog.tsx:50-66, PricingCell (around 77-120) | De-duplicate; one price per line; capabilities collapse to "+3" after two chips with the full list in a tooltip (Y6) |
| MO2 | M | Eyebrow "Administration" (rail Analytics), title "Models & LLMs" | Models.tsx:183-187 | Overview header, title "Models" (Y2, Y7) |
| MO3 | M | KPI strip with a green "22"; boxed tabs | Models.tsx:209-220 | `KpiStrip`; underline tabs |
| MO4 | L | Two raw number inputs in the local-model form | Models.tsx:671, 683 | `NumberField` (Y4) |

### Audit log, 14-* (content owned by the Audit brief)
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| AU1 | H | Build column squeezed to 7 lines, Detail clipped, 131 px rows, 26,559 px page | Audit.tsx:284-302 and the detail column | Y6; the Audit brief's row detail view |
| AU2 | M | Six equal-width filter boxes, "Clear" on its own row below them | Audit.tsx filter grid | `FilterBar` (group A primitive 7) |
| AU3 | M | Case column shows the internal id "case-862b68c6..." | Audit case cell | Case number (group A X11 `caseLabel`) |

### Jobs, 15-* (group A JB1-JB3 apply)
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| JO1 | M | System workers in four bordered boxes with "Last success" followed by the dash placeholder | BatchJobs.tsx (workers grid) | `ListRow`s in one panel, "never" instead of the dash (Y11) |

### Automated scans (legacy, hidden), 16-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| SC1 | M | Still routable and visually the most off-standard page: uppercase "AUTOMATION" eyebrow, a primary blue Refresh, 50 bordered cards with a 4 px green left border and six badges each, red "5" numeral | Scans.tsx:384-420; registry.tsx:283-291 | Retire: redirect `#/scans` to Case Manager filtered to agent-closed (the registry comment already says Case Manager supersedes it); do not restyle |

### Help Center, 17-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| HC1 | M | Breadcrumb "Help > Documentation", chip, title "Help Center", rail "Documentation"; an amber version pill inside the title row | Docs.tsx:382-390 | Overview header, title "Documentation" (or rename the rail item "Help Center"); version as muted `meta` text |
| HC2 | L | "Documentation for this installation" band with an icon chip and monospace meta columns | Docs.tsx:420-440 | One muted line under the header: "Version 0.1.13 · docs 0.1 · Testing" |
| HC3 | L | Selected category is a bordered blue box (unlike the nav's selected style); "Open guide" repeated on every row | Docs.tsx categories and rows (around 560-590) | Selected style = nav rail item; the whole row is the link |

### Settings shell (all sections), 20-47
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| ST1 | H | Four header layers, section name three times, first control about 400 px down | Settings.tsx:625-660, 735-740, 760-783 | Y3; preview P-settings-*-opt* |
| ST2 | H | Four internal grammars (Y3) | settings/*.tsx, SettingsGrid.tsx, embedded pages | One `SettingsSection`/`SettingsGroup`/`SettingRow` |
| ST3 | M | Rail heading and group labels in uppercase with monospace counts; "Appearance & customizati..." truncated | Settings.tsx:134, 735-740 | Sentence-case 13 px group labels, no counts; rail 264 px or a shorter title ("Appearance") |
| ST4 | M | Footer "Preference changes take effect after Save. Secret values stay write-only..." on every section, including those with no preferences (Users, Roles, Security and two-factor) | Settings.tsx:813-818 | Show only on sections that own preference keys or secrets |
| ST5 | M | Switch rows put the switch about 850 px from its label at 1440 px | SwitchPref (primitives.tsx:322-368) in a full-width pane | Cap the section at about 56 rem (option A) or put the control column beside the text (option B) |
| ST6 | L | "Ask about this" sits on the context line, separated from the title | Settings.tsx:777-779 | In the section title row |

### Settings sections (beyond the shell)
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| SE1 | M | Profile, Sessions, Users, Roles, Admin sessions: embedded `PageHeader` with eyebrow, chip and Refresh (20, 22, 35, 36, 38) | Account.tsx:391-396; Sessions.tsx:528-547; Users.tsx:344-356; Roles.tsx:356-365; AdminSessions.tsx:140-148 | `SectionTitle` look; Refresh into the section actions as `RefreshButton` (Y2) |
| SE2 | M | Security and two-factor has no section title, a smaller primary button, and a "Disabled" pill floating right | Security.tsx (MFA card); 21-settings-account_security | `SettingsSection` + one `SettingRow` ("Two-factor authentication · Off · Turn on") |
| SE3 | M | Notifications: uppercase group titles, dashed separators, template editor with a far-right "PREVIEW" column | NotificationsEditor.tsx:931-1232 | Sentence-case group titles; solid hairlines; preview below the editor under 1536 px |
| SE4 | M | Detection: third navigation column, risk weight value three times, plain 290 px threshold inputs | settings/detection.tsx:462-503; SectionShell rail | Y4, Y8 |
| SE5 | M | SLA: warning and info callouts stacked, nested bordered priority boxes titled with an em dash ("P1", dash, "Critical"), steppers outside fields | settings/case-policy.tsx; SlaPolicyEditor | One callout (Y9); per-priority rows in one panel ("P1 Critical · respond 15 min · resolve 240 min") |
| SE6 | M | Enrichment: 38 bordered provider cards; two switch styles in one section (bordered switch cards and plain rows) | EnrichmentProvidersEditor.tsx; settings/enrichment.tsx | `ListRow` + sheet (Y11); one `SettingRow` switch style |
| SE7 | M | Security posture: `PostureTile` uppercase tiles with vertical rules | settings/security.tsx:39-41; primitives.tsx:484-510 | Compact strip or three `SettingRow`s with status dots (Y5) |
| SE8 | M | Session policy: three number boxes with the unit outside | SessionPolicyEditor.tsx:191 | `NumberField` with unit inside (Y4) |
| SE9 | L | Sessions: boxed tabs with icons; red "Revoke" on every row; IPs in monospace beside "Local network" | Sessions.tsx; 22 | Underline tabs; neutral "Sign out" row action (Y10); mono only for the IP |
| SE10 | L | Users: inline role select inside the table row, red trash, key icon without a label | Users.tsx (columns) | Role as text, change in the edit sheet; actions in a row menu |
| SE11 | L | All settings: schema-derived labels ("Source ip field") | settings/advanced-schema.tsx | Humanize with known acronyms (IP, URL, ID, TTL) |
| SE12 | L | Secret keys: subheaders with a trailing rule; "not set" pill above each field | settings/keys.tsx | `SettingsGroup` titles; status as the field's helper line ("Not set") |
| SE13 | L | Storage: uppercase tier labels with icons; amber "Unsupported" pill beside a neutral one | settings/storage.tsx:300-318, 399-409 | Sentence case; one status line |
| SE14 | L | Danger zone: three solid red buttons of equal weight; uppercase red "THIS CLEARS" | DangerZone.tsx | Outline-destructive buttons (solid red only in the confirm dialog), sentence-case "Clears" / "Keeps" |

### Login, 60-61
The sign-in canvas is governed by its own written standard (`ui-standard.md`, "Identity surfaces" and "Identity accents": a 480 px borderless slab, the ambient 240 px tiles, and exactly two gradient controls, the Sign in button and the corner Light/Dark pill). Measured: 384 px form measure at every width, 48 px Sign in button, one 32 px heading. It conforms; the tile that looks like a stray white block in 60-login-1440-light is the documented ambient tile. No convergence work is proposed.
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| LI1 | info | The Remember me helper states a duration ("Stay signed in on this device for up to 24 hours"). Ask 1 removes the duration from the sign-out message; the operator may want the same rule here | Login.tsx (Remember me helper) | Operator question (section 10) |
| LI2 | L | The disabled Sign in button is a flat grey block with low-contrast text in both themes until a password is typed | Login.tsx; `ShineButton` | Keep the button styled as primary and disable with reduced opacity, or enable it and validate on submit |

### First-run Wizard, 50-*
| # | Rank | Finding | Where | Change |
|---|---|---|---|---|
| WZ1 | L | Uppercase tracked "GET OPERATIONAL" rail heading and a blue uppercase "WORKSPACE" stage eyebrow | Wizard.tsx (3 uppercase uses) | Sentence case; the step name is already the rail item |
| WZ2 | info | Otherwise the clearest layout in group B (one shell, one footer, one column) and already the documented reference for guided flows | ui-standard.md, Guided setup workflows | Keep |

### Top bar, notifications, version, user menu, palette, 51-58
See Y13. The palette (51) and version popover (53) already meet the standard.

## 6. Settings layout options (with screenshots)

The operator asked for options with screenshots. Both options share the same shell changes: no page description, no chip, no overline, the "Preferences saved" status kept beside the title, sentence-case rail labels without counts, no breadcrumb context line, "Ask about this" in the section title row, and proportional figures. They differ in how a group of related settings is drawn.

**Current**: `P-settings-chat_agent-current-1440-light.png` (and 26-settings-chat_agent-1440-light-full.png).

**Option A, grouped panels (recommended).** Each group is a `.surface-panel` (the Overview's material) with its title above it, like Apple's grouped forms; rows inside are divided by hairlines; the section is capped at about 56 rem so a switch sits within easy reach of its label. Matches the Overview exactly, needs no new token, and turns the four grammars into one.
Screenshots: `P-settings-chat_agent-optA-grouped-1440-light.png`, `P-settings-general-optA-grouped-1440-light.png`, `P-settings-chat_agent-optA-grouped-1920-dark.png`.

**Option B, annotated two columns (Polaris).** Group title and description in a 15 rem left column, the controls on a panel to the right. Scans well on wide screens and keeps explanations out of the control column; collapses to option A below about 1280 px, so both must be built. The Data scope preview shows its cost: with the Settings rail and the app rail already present, the control column is about 420 px wide at 1440 px, so three-column field grids must reflow to one or two columns (labels like "Rule / module field" wrap in the preview).
Screenshots: `P-settings-chat_agent-optB-annotated-1440-light.png`, `P-settings-general-optB-annotated-1440-light.png`, `P-settings-chat_agent-optB-annotated-1920-dark.png`.

Recommendation: option A. It is the Overview's grammar, it works at every width without a second layout, and it is the Apple grouped-form pattern the Round 12 design work adopted. The previews are rough in-browser restyles (spacing is approximate, and the Data scope preview still shows a redundant one-line "Data sources" group that the real migration would delete), not designs.

The same grammar converges the non-Settings pages: `P-sources-converged-1440-light.png`, `P-knowledge-converged-1440-light.png`, `P-models-converged-1440-light.png`, `P-baseline-converged-1440-light.png` show the header, KPI strip and panel changes applied to live pages.

## 7. Shared primitives to create or unify

Group A's section 6 list (Panel, Band/SubBandTitle, PageHeader defaults, KpiStrip, ChartPanel, table density and header style, FilterBar, underline Tabs, RefreshButton + TimeRangePicker placement, formatting helpers, PageContainer rhythm, sheet close stacking) applies unchanged. Group B needs these in addition; each names the files it replaces and the findings it closes.

1. **`SettingsSection` (replace `SectionTitle`, `SectionShell`, `SettingsCard`, and the embedded `PageHeader` use).** Props: `title` (from `settings-sections-meta.ts`), `description` (one line, optional), `actions`, `modified` (boolean, shows "Modified" beside the title), `askTopic`. Renders an `h2` row and children with 40 px between groups; owns the max width (about 56 rem). Files: `pages/settings/primitives.tsx:60-208`, `components/SettingsGrid.tsx`, every `pages/settings/*.tsx`, and the `embedded` branches of `Account.tsx`, `Sessions.tsx`, `Users.tsx`, `Roles.tsx`, `AdminSessions.tsx`, `Security.tsx`. Closes Y2 (embedded part), Y3, Y8 (Settings part), ST1-ST6, SE1, SE2.
2. **`SettingsGroup` (new, in `@/design-system` beside `Panel`).** A titled panel (15 px semibold title above, optional one-line caption, optional trailing action) holding `SettingRow`s divided by hairlines. Option A draws the title above the panel; option B places title and caption in a left column from 1280 px. Closes Y3 subheader styles (`SubHeader`, uppercase legends, rule-after titles, icon titles).
3. **`SettingRow` (new; absorbs `SwitchPref`, `PostureTile`, the Field-in-grid patterns).** One row anatomy: label (14 px medium), helper text (13 px muted, max 42 rem), control at the row end for switches/selects/status, or below the label for wide fields (text areas, tag inputs). Variants: `switch`, `select`, `field`, `status` (dot + value), `action` (button). Closes Y4 alignment, Y5 posture tiles, ST5, SE7, SE12.
4. **`Field` as the only labelled-control wrapper.** Already exists (`components/Field.tsx`); make every label go through it (Memory.tsx:213-237 and any `Label` + `Input` pair), so label-to-control spacing and helper placement are one rule (Carbon: label above, helper below). Closes Y4 (alignment), IN7.
5. **`NumberField` everywhere, sized to content.** Add `size: 'xs' | 'sm' | 'md' | 'full'` (6, 8, 12 rem, full) with a default derived from `max`; unit always inside; steppers inside the right edge, hidden above 4 digits; replace `NumPref`'s input (`settings/primitives.tsx:241-320`) and the 13 other raw `type="number"` inputs listed in Y4. One value display for sliders (`LabeledSlider`). Closes Y4, BL3, DR4, SE4, SE5, SE8, MO4.
6. **`Callout` (new or a constrained `Alert` wrapper).** Three intents only (`warning` for a current condition, `error`, `intro` that can be dismissed and remembered per user). Lint: no `Alert variant="info"` in page files. Closes Y9, DR1, SE5.
7. **`ListRow` (new) for record lists on a panel.** Title, one muted line, trailing status (exceptions only) and one trailing action; secondary actions in a row menu; whole row opens the detail sheet. Used by Runbooks (rebuilt), Personas, Enrichment providers, System workers, Sessions, Admin sessions. Closes Y10 (row actions), Y11, IN8, JO1, SE6, SE9.
8. **`RowActions` (new, small).** Neutral ghost icon buttons with labels in tooltips; destructive actions render neutral and turn red only on hover/focus and in the confirm dialog. Closes Y10, DR2, SE10.
9. **`StatusDot` + one status vocabulary.** For "Active", "Ready", "Needs key", "Unsupported", "Off": a 6 px dot and plain text, coloured only when not the healthy default. Replaces the scattered green/amber pills. Closes Y10, SE13.
10. **Registry-owned page names.** `PageHeader` reads the title from the route's registry entry unless a page explicitly overrides it with a reason; Settings `h2` reads `settings-sections-meta.ts`. A unit test asserts nav label = page title for every routed page. Closes Y7.
11. **Typography defaults.** `body` proportional figures with tabular figures on numeric surfaces (theme.css:336); a lint or test that forbids `text-[10px]` and `text-[9px]` outside the badge primitive. Closes Y1, Y6 (10 px).
12. **Table layout contract.** On top of group A's density change: `DataTable` uses `table-layout: fixed` when columns declare widths, and long text cells truncate to one line with a tooltip or detail view by default. Closes AU1, SL2, SO3, Y12.

A guard test like group A's should also fail on: `eyebrow=` or `breadcrumb=` anywhere under `soc/pages` and `soc/rules`, `SectionShell rail`, `type="number"` outside `NumberField`, `Alert variant="info"` in page files, and `text-critical` on an icon button outside a dialog.

## 8. Dark mode and phone notes

Dark, 1920x1080 (28 views, `-1920-dark.png`):
- No missing token and no document overflow. The structural problems get worse with width, not with theme: Settings switches sit about 1,300 px from their labels (26-settings-chat_agent-1920-dark); Sources' Name column takes about 780 px while Protocol still wraps (01-sources-1920-dark); Baseline's policy form stops at about 1,080 px under a full-width tile row (07-baseline-1920-dark). The option A preview at the same size (`P-settings-chat_agent-optA-grouped-1920-dark.png`) shows the 56 rem cap fixing the first of these.
- Bordered cards read as a third surface step between canvas and panel (08-knowledge-1920-dark: the Threat intel, Resolved cases, Import and Try a retrieval cards), the same argument group A makes for X1.
- Coloured numerals and bars are louder in dark: the green embedding model name, the salmon MITRE bar, the yellow suppression bar (08-knowledge-1920-dark); the amber bell badge is the brightest element in the top bar.
- The empty warm-up progress track on Baseline is almost invisible (07-baseline-1920-dark); inside a panel it should use the panel's muted step.
- At 1920 px the Audit Build column no longer wraps (rows 55 px), confirming that Y6's Audit defect is a width-allocation bug that appears at 1440 px and below.

Phone, 390x844 light (`-390-light.png`):
- No page overflows the document horizontally; wide tables scroll inside their containers without an edge fade (group A X10).
- Settings: the first control starts at about 620 px of an 844 px screen, after the page header and description, a full-width "Re-run setup wizard" button, the section chooser (with an uppercase "GENERAL" label), the breadcrumb line, the "Ask about this" and "No unsaved changes" line, and the section `h2` with a four-line description (26-settings-chat_agent-390-light). With the Y3 shell changes the first control would start near 300 px. The in-section anchor strip scrolls sideways with its third item cut ("Ca...") and no fade (48-settings-chooser-390-light).
- Sources: about 580 px of chrome before the first source; the toolbar wraps into three rows (Filter and search; count and Refresh; Columns) (01-sources-390-light).
- Audit: the five filters wrap into ragged rows of mixed widths, and the table shows three columns at 130 px per row (14-audit-390-light). The Audit brief's redesign should use a "Filters (n)" sheet on phones, as group A proposes for Cases.
- Runbooks: readable, but the duplicate description and two full-size buttons push the list below the first screen (09-runbooks-390-light).
- Console controls sheet (58-topbar-controls-390-light): uppercase group labels, some rows as bordered cards and others plain, monospace "Synthetic data (in-memory)". It should use the same `SettingsGroup`/`SettingRow` grammar as Settings (grouped rows on a panel).
- Login at 390 px follows its standard (full-width flow, 32 px insets) and is fine.

## 9. Suggested order of work

1. Defects and one-liners first: Y1 (body figures), Y6 (Audit table layout, Models chips and prices, Memory fields, Knowledge pill, "(#3)", Tuning raw text, 10 px text), SC1 (retire Scans).
2. Settings: build `SettingsSection`, `SettingsGroup`, `SettingRow`, `NumberField` sizing and `Callout`; migrate the 8 `SectionShell` sections and the 10 `SectionTitle` sections; then the embedded pages. Settings is one page, so the operator sees the change at once.
3. Group A's `PageHeader`, `KpiStrip`, `Panel` and table changes applied to Sources, Auto-tuning, Baseline, Knowledge, Memory, Models, Jobs, Help Center (previews show the direction).
4. `ListRow`/`RowActions`/`StatusDot` for Enrichment, Sessions, Users, Personas, and the rebuilt Runbooks (coordinate with ask 9).
5. Names (Y7), top bar (Y13), guard test, and the `ui-standard.md` updates ("Forms, Settings, and dangerous actions" should describe the chosen option and the row anatomy; "Typography" the proportional default).

## 10. Open questions for the operator

1. Settings option A (grouped panels, one column, recommended) or option B (title and description on the left, controls on the right)?
2. May we remove the permanent explanatory callouts (Detection rules, Baseline, Memory, Secret keys, SLA) in favour of a help tip and the Help Center, keeping callouts only for live warnings?
3. Page names: "Sources" or "Log sources"? "Documentation" or "Help Center"? "Baseline" or "Anomaly baseline"? We will use one everywhere.
4. May we retire the hidden Automated scans page (redirect to Case Manager)?
5. Should Users, Roles and Sessions stay inside Settings (as now) or become their own pages under Platform? Inside Settings they must lose their own page headers either way.
6. Ask 1 removes the duration from the sign-out message. Should the sign-in page's Remember me helper ("Stay signed in on this device for up to 24 hours") also stop naming a duration?

## Sources

- [Carbon, form usage](https://carbondesignsystem.com/components/form/usage/) (labels above, helper text, 32 px between fields, two-column rows respond as a group).
- [GOV.UK Design System, text input](https://design-system.service.gov.uk/components/text-input/) (size inputs to content; avoid `type="number"`; `inputmode`).
- [Shopify Polaris, app settings layout](https://polaris.shopify.com/patterns/app-settings-layout) (annotated left column, settings grouped in cards, short descriptions that do not repeat the title).
- [Apple HIG, settings](https://developer.apple.com/design/human-interface-guidelines/settings) (minimize settings; task-specific options in context).
- [Apple HIG, boxes](https://developer.apple.com/design/human-interface-guidelines/boxes) (nested boxes feel busy; a box near window size loses its grouping effect).
- [Apple HIG, lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) (grouped style separates groups with headers, footers and space).
- [Carbon, data table style](https://carbondesignsystem.com/components/data-table/style/) (row heights and header style, via group A).
- Project: `docs/research/2026-10-round14/research/ui-audit-a.md` (Overview standard, X1-X19, primitives 1-12); `docs/development/ui-standard.md` (Foundations, Page anatomy, Forms, Settings, and dangerous actions, Guided setup workflows); `docs/research/2026-10-round12/research/apple-design-SKILL.md`.
