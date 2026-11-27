ROUND 15 SPEC REVIEW: CONSOLE AND UI LENS (read-only; no files edited; no state-changing git)

Ranked findings (most severe first). Each: SPEC id, what is wrong, evidence, correction.

=== HIGH ===

H1. D4.4 is wrong about today's behaviour, and as written it shifts the grading population.
- Wrong: "No rating, no grade (as today when the grade is skipped), so the grading population does not shift."
- Evidence: CaseDetail.tsx:1262-1283 posts `caseFeedback` whenever `freshAssessment` is set. That happens on every close whose disposition is a match or an override of a TP/FP verdict, even with no stars and the grading section collapsed. Pinned by CaseDetail.grading.test.tsx:114-155 ("closing a VERDICT-bearing case issues BOTH the action POST and a derived feedback POST", assessment 'agree', no stars) and :250-300. ui-standard.md:629-632 describes the same contract.
- Under D4.4 only rated closes post. The Agreement samples in `feedback_stats` and `agent_improvement` fall to the rated minority.
- Correction, option (a), recommended: "The close posts the computed assessment on every close whose disposition compares with the AI verdict (match or override), as today. Stars and 'What did the AI miss?' are added when given. A Needs-human resolution, a duplicate, or no verdict posts nothing unless rated."
- Correction, option (b): keep D4.4, but state that the population shifts. Then amend ui-standard.md:629-632, rewrite CaseDetail.grading.test.tsx:114 and :250, and record the Agreement-metric discontinuity in the CHANGELOG.

H2. D8.3: the old-tab redirect cannot work as specified. Today it would drop the case id as well.
- The router validates `tab` with `isCaseTab` (router.tsx:227-232). One invalid key rejects the whole query (router.tsx:327-343), so `#/case_manager?caseId=X&tab=timeline` opens Case Manager with no case. docs/analyst/case-manager.md:74-80 documents this.
- Lazy loaders are keyed on the removed tab ids:
  - stages load only when `tab === 'timeline'` (CaseDetail.tsx:819);
  - threat context loads only when `tab === 'threat'` (CaseDetail.tsx:1020).
- `OverviewPanel` exports `OverviewTab = 'timeline' | 'investigation' | 'threat' | ...` (OverviewPanel.tsx:727) and calls `onOpenTab('timeline')` and `onOpenTab('threat')` (OverviewPanel.tsx:920, 942).
- There is no section-scroll mechanism today. Only the `requestedTab` prop exists (CaseDetail.tsx:405-419).
- Correction: add to D8.3:
  - "case-tabs.ts keeps CASE_TABS strict and adds `LEGACY_CASE_TABS = {timeline: 'overview', threat: 'investigation'}`.
  - The router's case_manager `tab` validator accepts both sets. `redirectRoute` rewrites a legacy value to its new tab with `replaceState` and carries a section request (new NavOpts key, in memory only).
  - CaseDetail scrolls to `[data-section="what-happened"]` or `[data-section="threat-context"]`.
  - Stages load when Overview opens; threat context loads when Investigation opens.
  - OverviewPanel's `OverviewTab` type and its two `onOpenTab` calls are updated.
  - Tests: an old link keeps its caseId and lands on the new tab."
- Owners: WP6a (router, case-tabs), WP6b (loaders, panels).

H3. D4.4: deriving `actual_outcome` from the disposition makes a close-time label beat later corrections.
- `_confirmation` returns the latest feedback label before it looks at any declared disposition (analyst_outcomes.py:142-156). A rated close therefore pins its derived label permanently.
- Later `set_disposition`, or a reopen and re-close with a new disposition, no longer changes `analyst_confirmed_outcome`, unless the analyst rates again.
- This breaks the toast promise "keeps this outcome on record until you close the case again with a new one" (CaseDetail.tsx:1203-1204; ui-standard.md:626-628).
- The declared disposition already supplies ground truth as `explicit_analyst_disposition` (analyst_outcomes.py:158-175).
- "Others → unknown" also contradicts grading.tsx:76-79 and :107, which never post `unknown`.
- Correction: "The close-time feedback never carries `actual_outcome`. Ground truth from a close comes from the declared disposition."
- If the SPEC keeps the mapping: state that `_confirmation` changes to take the newest of (feedback label, declared classification) by timestamp. Then omit `actual_outcome`, rather than sending `unknown`, for suspicious, undetermined and duplicate. Also note the [crit] G8 shift of tuner provenance from `disposition_labels` to `feedback_labels`.

H4. D2.1 and D2.2 contradict the code path the wizard uses. One state is also unspecified, and one string is ungrammatical.
- The wizard reads only the PUBLIC `GET /api/setup/status` (Wizard.tsx:195-200, 220-224; routes.py:545-552 "PUBLIC first-run status"). D2.1's fallback therefore applies, and `ai_runtime_provider` is not available.
- So the row "The default investigation models use {provider}..." cannot be rendered.
- The KeysStep alert keys on `anyConfigured` (Wizard.tsx:1312-1343). When a key is present but unusable, the alert shows "Live provider configured" with a success style, while the new body says the key is unusable. D2.2 gives no title or variant for that state.
- The review row's ready detail lists only Anthropic and OpenAI (Wizard.tsx:1457-1462). It reads "Configured: " (empty) when readiness comes from Azure, Bedrock, Vertex or LiteLLM.
- There are three readiness sites, not one `hasProvider`: Wizard.tsx:275, :1312 (`anyConfigured`) and :1397.
- "Add a {provider} key" renders "Add a OpenAI key" or "a Azure OpenAI key", and OpenAI is the default provider.
- Correction:
  - Decide the provider source: add `ai_runtime_provider` (a provider-family token from a fixed enum) to the public status, or have the wizard read an authenticated endpoint. Otherwise drop the {provider} row.
  - Specify the three alert states: ready gives success "Live provider configured"; key present but not ready gives a warning titled "Your key does not match the default models"; no key gives a warning titled "No usable AI provider yet".
  - Specify the ready detail ("Configured: <provider labels from configured booleans>").
  - Reword to "Add a key for {provider}, or choose other models in Settings > Models after launch."
  - Apply `ai_runtime_ready` at all three sites.

H5. §6.3 omits several overrides of Round 14 SPEC §4.10.11, which the SPEC itself says must all be listed.
- Round 14 §4.10.11 (Round 14 SPEC.md:2318-2323) specifies:
  - a Runbook tab "second in Case detail and Case Manager", with a "Runbook 4/11" progress chip on its trigger;
  - a "Runbook" section in the facts rail;
  - the queue chip.
- Round 15 contradicts each of them:
  - D8.3 moves Runbook to third and changes its count to "open steps".
  - D8.4's seven sections silently drop the rail Runbook section (FactsRail.tsx:321-328). This breaks soc/runbooks/run/__tests__/case-surfaces.test.tsx:161-176, a file outside WP6's ownership.
  - D8.1 removes the queue chip (case-surfaces.test.tsx:188-195 covers the chip component).
- Correction: add to §6.3: "Round 14 SPEC §4.10.11: the Runbook tab moves to third; its count shows open required steps; the facts-rail Runbook section is removed (or name it as an eighth section if kept); the queue chip leaves the row."
- Give WP6 ownership of soc/runbooks/run/__tests__/case-surfaces.test.tsx and of docs/analyst/investigation.md (runbook tab text).

=== MEDIUM ===

M1. §3.1 and WP2: the wizard copy is not byte-neutral.
- Measured string deltas (UTF-8): -21, -5, +13, +127 (the new {provider} sentence), +4. Total +118 B before the new readiness logic and provider labels.
- "Wizard copy (net about 0)" and WP2's "byte-neutral or shorter in total" cannot both hold with the D2.2 table.
- Correction: "Wizard: about +150 B, covered by the §3.1 removal."
- Also count the shared perm constant `{resource:'team',action:'view'}` (about 37 B) and the legacy tab alias (about 40 to 60 B) in the spend list.

M2. §4.6 versus WP3: the knowledge-file ownership conflict blocks per-package green.
- Any registry or Settings-metadata change fails console-map.contract.test.ts:318-330 until `npm run gen:console-map` rewrites backend/app/knowledge/console_map.json.
- manifest.json pins that file's sha256 (test_app_knowledge.py:102-108), so pytest fails until scripts/build_app_knowledge.py runs.
- §4.6 gives knowledge/*.json to WP8 only, yet WP3 (registry), WP2 (Roles keywords) and WP3/WP5 (Settings rows and anchors) all change those inputs.
- Correction: "A package that changes registry.tsx or settings-sections-meta.ts runs gen:console-map and build_app_knowledge.py in its branch. WP8 re-runs both on the integrated tree and owns conflict resolution."

M3. D8.2: the primary-action set does not match today's per-status plan, and no table is given.
- Today (shared.tsx:336-387):
  - new: Acknowledge;
  - open, investigating, needs_human: Escalate, with a secondary "Close case" button (CaseDetail.tsx:1683-1695);
  - on_hold: Resume;
  - escalated: Mark resolved;
  - resolved: Close;
  - closed: Reopen.
- D8.2 lists only "Acknowledge, Close case, Start review, or Reopen". It never says what happens to Resume, Mark resolved or the secondary Close. These are pinned by CaseDetail.resolved.test.tsx and CaseDetail.footer.test.tsx.
- Correction: give the full status-to-primary table. Say that the secondary Close button is removed (C still opens it; it stays in Take action), and where Start review and "Review this auto-close" (D4.7) sit.

M4. D8.2 and D8.4: moving tags to the rail breaks the T shortcut and the "Edit tags" menu item on narrow panes.
- T and the Take action item open `tagsOpen` in CaseHeaderMeta (CaseDetail.tsx:1524, 1823-1827).
- The rail is `hidden` below 60rem (CaseDetail.tsx:2225) and appears only in the Details sheet.
- D8.2 line one also omits the "Details" button (CaseDetail.tsx:1892-1903), which is then the only way to reach tags, campaign and Ask AI on narrow panes.
- Correction: "Line one keeps the Details button below 60rem. T and 'Edit tags' open the Details sheet first when the rail is hidden, then the rail's tag editor."

M5. D3.11: TimeRangePicker cannot do what is asked.
- It has no custom range (presets only, TimeRangePicker.tsx:86-92, 488-509). It also speaks ES date math (`parseDateMath`, :180-208), which cannot parse the window tokens `today` and `yesterday` (time_windows.py:24-27). `resolveRange` would silently fall back to the last 24 hours.
- The Audit page's custom range is a separate component (AuditFilters.tsx:447 `AuditCustomRange`, mounted beside the picker at Audit.tsx:635-641).
- Correction:
  - Presets with `window` tokens: Today = `today`, Yesterday = `yesterday`, Last 7 days and Last 30 days as whole calendar days in the operator zone (`align_whole_periods`).
  - The page maps the picker value to `window` itself and never resolves the tokens with `resolveRange`.
  - "Custom" is a page-local range control following AuditCustomRange, capped at 92 days.
  - The zone statement goes in a caption or help tip, not a PageHeader `description` (guard rule header-removed-prop, console-grammar.guard.test.ts:368-379).

M6. D3.3: the switch location is ambiguous, and `team_activity` is missing from CURATED_SECTIONS.
- The only Settings-save-backed section in Security & access is `security` ("Single sign-on & policy", settings/security.tsx, `ownedKeys` at settings-sections-meta.ts:463). WP2 also edits that file.
- Without a CURATED_SECTIONS entry (advanced-schema.tsx:55-84), the block also appears in Advanced > All settings as a second editor.
- Correction: "WP3 adds a 'Team activity' group with one switch row after Posture in settings/security.tsx. It adds `team_activity` to CURATED_SECTIONS and to the `security` section's ownedKeys, plus a SETTING_ANCHORS entry."

M7. D1.4 and D1.5: the SessionPolicyEditor note goes stale after the switch. Its text needs no change.
- The Remember-me note does not say "no switch" (SessionPolicyEditor.tsx:240-245), so D1.5 changes nothing there.
- The note's input is the Settings draft, `rbacEnabledOf(prefs)` (Security.tsx:718). `PUT /api/rbac` from the embedded Roles section (settings-sections.ts:222) does not update that draft, so the note is wrong until reload.
- Correction: "Security.tsx passes `useAuth().rbacEnabled` (refreshed by `auth.refresh()`) instead of `rbacEnabledOf(prefs)`. The RBAC panel also re-runs RolesInner `load()` so the caption's `perms.rbac_enabled` updates." Give Security.tsx to WP2.

M8. D4.2 and D8.3: the source for "actions taken in History" is not named.
- The Collaboration History is `GET /api/cases/{id}/activity` (routes_cases_collab.py:411-455). It projects only `kind, actor, summary, ref` from audit rows, so `changes` and `actions_taken` never reach it.
- `actions_taken` lives on `Case.history`, which this feed does not read.
- Correction: either the activity endpoint adds the row's `changes` (and WP1 owns routes_cases_collab.py), or the Collaboration History reads `c.history` analyst_action entries.

M9. D6.12: the `caseOutcome` feedback branch is underspecified.
- `caseOutcome` (outcome.ts:239-318) has five sources and no feedback branch.
- The backend authority returns a binary label for ANY feedback with `actual_outcome`, before classification (analyst_outcomes.py:142-156), not only for reviews.
- A literal "feedback first" therefore also re-headlines analyst-classified cases ("Closed as benign" becomes binary words). That changes 13 consumers (badges.tsx:739, outcomeCellText, isHumanSettled, the Overview classification KPIs).
- Correction: define the new `OutcomeSource` (for example `review`). Say whether the branch applies only to `is_review_grade` entries on agent-decided cases. Give its headline, shortLabel and agreement values. Amend ui-standard.md:604-612 ("Case outcome").

M10. D8.1: the custom Filters popover conflicts with ui-standard, and Sort has no home.
- ui-standard.md:403-414 says `FilterBar` is the only filter layout (search, at most three primary filters, "More filters" dialog, chips, Clear all, "Filters (n)" sheet below 768px).
- FilterBar supports `primaryCount` (FilterBar.tsx:14-18), so the intent fits with `primaryCount={0}`.
- D8.1 also drops the existing Sort control (CaseManager.tsx:2098, "Sort case queue") and puts density, a view preference, inside a filter popover counted by Clear all.
- Correction: "Use FilterBar with the search and `primaryCount={0}` (Severity, Status, Closed by behind More filters). Sort and density sit at the list footer or in a view menu, outside the filter count." Otherwise list the override in §6.3.

M11. D4.3 names an AI verdict that does not exist.
- "against an AI false positive or benign verdict": the Verdict enum is FALSE_POSITIVE, TRUE_POSITIVE, NEEDS_HUMAN (constants.py:413-418).
- Correction: "The note is required when `deriveAgreement(verdict, disposition).kind === 'override'` (grading.tsx:203-225). A NEEDS_HUMAN resolution and a duplicate never require it." Also say whether suspicious or undetermined against a TP/FP verdict, which is also an override, requires it.

M12. D2.1: `ai_runtime_ready` goes stale after saving a key in the wizard.
- After `POST /api/setup/secrets`, the wizard re-applies only `result.configured`, because the status read can be briefly stale (Wizard.tsx:292-316).
- `ai_runtime_ready` would keep its old false value, and the wizard would say "No usable AI provider yet" right after a valid key is saved.
- Correction: "POST /api/setup/secrets also returns `ai_runtime_ready`. The wizard patches it in both setStatus calls." This is WP2's routes.py region.

=== LOW ===

L1. D3.1: other tests need entries.
- nav-titles.round14.test.ts:27-53 needs `team: ['pages/TeamActivity.tsx']`, or "knows where every destination page writes its title" (:104-107) fails.
- console-map.contract.test.ts:93 PAGE_KEYWORDS needs `team` keywords.

L2. D3.11: add `PageAccess resource="team" action="view" title="Team activity"`.
- This is the Round 14 roles-02 precedent (PageAccess.tsx:1-20, UnifiedLogs.tsx:526).
- Without it, a typed `#/team` mounts, sends refused reads and writes Access denied rows.

L3. D3.11: the chart needs more definition.
- No shared stacked-bar component exists. charts.tsx exports Donut, HBar, TrendArea, MiniBars and Sparkline; CloseAttributionChart.tsx is a bespoke SVG.
- The Okabe-Ito ramp has 8 slots (`--chart-1..8`), but D3.8 lists more than 8 work kinds.
- Correction: name the at most 7 stacked kinds (fold the rest into "Other") and say recharts `stackId` inside the lazy chunk.

L4. D5.11: three implementation notes.
- lib/avatar.ts is in the entry chunk (AppShell.tsx:79 imports `initialsFrom`). The new canvas helpers must live in the lazy kit, not in avatar.ts.
- `requestBlob` exists but is module-private (api.ts:739). Use the exported `requestResponse` (api.ts:657) in lib/api-case-files.ts.
- Add a fallback when no encoding fits under 2 MiB at 3,840 px: step down to 2,560 and 1,920 px, then refuse with a message (the avatar.ts ladder precedent).

L5. D1.4: the purpose sentence duplicates the dialog title.
- The ReauthDialog title is already "Confirm your identity" (ReauthDialog.tsx:127-129).
- The precedent voice is "Sign in again to export audit events." (api-audit.ts:63).
- Use "Sign in again to change role-based access." Make the call through the exported `request('PUT','rbac',{body, reauthPurpose})`; `api.put` cannot carry a purpose (api.ts:753-761).

L6. Copy quoted in D8.6 and D8.1 does not match the code.
- The real label is "Close & next" (ConfirmActionDialog.tsx:652; CaseManager.test.tsx:1314), not "Close and next".
- The scope line is "1 of 68 active · 50 loaded" (CaseManager.test.tsx:1212), not "12 of 68 active, 50 loaded".

L7. §3.1: the hidden-cost assertion is at registry-router-round6.test.tsx:128, not :121.

L8. D8.3: Alt-shortcut labels and comments to update.
- CaseDetail.tsx:1801 (`MenuShortcut` "Alt 7"), CaseManager.tsx:622 ('Alt + 1 … 7'), case-tabs.ts:7, CaseDetail.tsx:146 and :1430.
- Docs: docs/USAGE.md:553 and docs/analyst/case-manager.md:107 ("Alt+2 is the Runbook tab").

L9. D6.12: NavOpts (soc/nav-types.ts:22) needs `review?: string`. No package owns nav-types.ts; give it to WP6a.

L10. D5.11: the lightbox needs a title.
- It must always render a DialogTitle, visually hidden if need be. Fall back to "Screenshot N of M" when the caption is empty.
- Otherwise Radix warns and `npm run test:strict`, which requires zero stderr, fails.

L11. D2.2: two copy problems.
- "nothing closes automatically" is false on a wizard re-run, when declared-benign analyst policies exist (they close at $0 under ANALYST_POLICY).
- The Console's word for this verdict is "Needs human review" (outcome.ts:106), not "Needs human".
- Suggest: "Until you add one, the AI agent investigates nothing: new cases wait for a person as Needs human review."

L12. D8.8 and WP8: test_app_knowledge.py pins headings in case-manager.md.
- It pins the `work-the-runbook` and `keyboard` anchors (:1338-1341).
- It also pins the second chunk of Work the runbook, which must start "- **The strip**" with the intro "A runbook is the procedure the people on a case follow" (:1427-1430). A rewrite must keep them.

L13. D3.11: the client "Download CSV" must use lib/csv.ts (`csvField`, formula defusal), because display names are user-controlled.

L14. D6.12: Review scope membership and status filtering are undefined.
- `caseInScope` cannot decide Review membership from the case document. On a `cases` frame in Review scope, re-read the window.
- `statusOptions` hides terminal statuses unless the scope is 'all' (CaseManager.tsx:1834). Say that Review behaves like All.
- Say how `review=completed|disagreed|expired` is chosen in the UI, or that it is a deep link only.

L15. D8.7: `BULK_DISPOSITIONS` exists in both CaseManager.tsx:178 and Cases.tsx:2340. Name CaseManager.tsx; Cases.tsx is outside WP6.

L16. §6.3: the ui-standard amendments are incomplete.
- The header meta-row list (ui-standard.md:616-618) still names risk, tags and campaign.
- The Case Manager scope list (Active, Mine, All, :573-575) needs Review.
- The comfortable third line (:577-579) goes.
- Amend "Case outcome" (:604-612) and the grading-agreement sentence (:629-632) if H1(b) or M9 apply.
- No CI test reads the Case Manager parts of ui-standard.md. Only the chat text is pinned (test_docs_round13_records.py:112-115, 143, 203-207, 229-234; test_docs_round12_lane_default.py:58-60).

=== SPEC CLAIMS CHECKED AND FOUND CORRECT ===

Roles, RBAC switch and Settings save path
- Roles.tsx:349-355 holds the "Role-based access is off" callout with the no-switch wording; roles.page.round14.test.tsx:133-134 pins it.
- The Roles page and section are gated on roles:manage (Roles.tsx:150; settings-sections-meta.ts:452).
- ConfirmDialog supports `destructive` (locks dismiss), `busy` async confirm and `richDescription` (ConfirmDialog.tsx:44-90).
- The global ReauthDialog is mounted with `active={authEnabled}` (App.tsx:206), and `reauthPurpose` flows through `requestResponse` (api.ts:646, 698).
- `require_fresh_auth` answers 401 `reauth_required` (deps.py:1103-1104), and `stepUpCode` reads `detail.code`.
- `auth.refresh()` exists (auth.tsx:72, 105).
- The security.tsx Posture "Role-based access" row exists (security.tsx:50-55). SettingRow `variant="status"` accepts an `action` (primitives.tsx:452-457).
- The D1.3 guard will not cause spurious 409s from the Console: Settings sends only changed top-level keys (Settings.tsx:484-507), and no putSettings caller sends `rbac` (`rbac` is in CURATED_SECTIONS).
- The §3.3 permission table matches policy.py (_SOC_MANAGER, _ANALYST_TIER2, _AUDITOR, settings-like reads).

Wizard
- The old strings are exact: STEPS[2] at Wizard.tsx:119; alert title :1335; body :1342; review row :1465; heading :1406.
- "Needs attention" pins are at Wizard.onboarding.test.tsx:265 and :294. The headings are pinned at :190, :211, :263, :291.
- `configured_status` includes Azure, AWS, Vertex and LiteLLM booleans (config.py:410-426).

Navigation, registry and Team activity page
- The Analytics children order is metrics, effectiveness, cost, models, baseline, batchjobs (registry.tsx:394-414).
- `team` collides with no PageId, Settings section, SETTINGS_REDIRECTS key or deep-link key. `#/audit?actor=` is a valid key (router.tsx:184).
- The 11 hidden entries are true duplicates (same id and label as a visible child).
  - PAGE_IDS keeps the child ids (nav.ts:194-200).
  - navLabel resolves children first.
  - The console map and the palette use visible features only.
  - The only test touching them is registry-router-round6.test.tsx:128. nav-derivation.test.ts:34 lists only kept ids, and route-registry.test.tsx:31-42 is unaffected.
- The DataTable sort API, KpiStrip, Sheet (with the SPRING_PANE timing in CSS), SPRING_PANE and SPRING_UI (variants.ts:38-41), lib/api-*.ts lazy modules and the type-only types-*.ts pattern all exist.

Case Manager and case detail
- CaseManager uses SegmentedControl (option label is a ReactNode, so a count fits) and OwnerMonogram. Popover and FilterBar are available.
- The queue risk cut-offs at CaseManager.tsx:357 equal `scoreBand` (palette.ts:224-229), so the change is a de-duplication with no visual change.
- Sheet hosts are at Overview.tsx:5266 and Investigate.tsx:720; Case Manager embeds at :2514.
- The panels' 'default' presentation is dead in production: CaseDetail passes "case-manager" to every panel.
- TabsList `variant="underline"` (13 px) exists. The chat glyph is a span, so it is not hidden by `[&>svg]:hidden`.
- G17 is real (InvestigationPanel.tsx:158).
- HeadlinePanel (shared.tsx:489), BriefChip, PanelCard and CaseDetail.footer.test.tsx exist.
- The `close` and `confirm_fp` ActionDefs are unused in plans. History reads of 'confirm_fp' (outcome.ts:73; FactsRail.tsx:127) must stay.

Close flow and outcome
- `close_disposition` maps to `close` through wireAction (shared.tsx:192-203; CaseDetail.tsx:1146).
- The disposition picker opens empty and sends `disposition_declared`.
- Set disposition is offered on closed agent cases (shared.tsx:341-346), so the D4.7 rationale holds.
- `caseOutcome` has no feedback branch today (outcome.ts:239-318).

Guards, docs and budget
- casedetail files have zero console-grammar allowances (guard-allow/*.json), so any new violation fails.
- case-visual-dialect.test.tsx scans only top-level casedetail files; the grammar guard covers subfolders.
- No CI test reads ui-standard's Case Manager text.
- The entry budget constants are 336,216 + 1,024 (bundle-first-paint.test.ts:158-159, 243).

=== JOURNAL ENTRY (for the orchestrator to append) ===
### 2026-11-23, review sub-agent (Console and UI lens), Round 15 SPEC verified against the code
- Context: Read-only review of docs/research/2026-11-round15/SPEC.md, covering the RBAC switch, wizard copy, Team activity, close dialog, screenshots, auto-close review outcome, and Case Manager redesign decisions.
- Did: Checked each claim in the webui and backend sources. Found 5 high, 12 medium and 16 low issues. Main ones: today's close always posts the computed AI-agreement grade (D4.4 is wrong); the router drops the whole deep link on an unknown tab (the D8.3 redirect needs an alias); a derived feedback label overrides later dispositions; the wizard's provider name is unavailable from the public status (D2.1/D2.2); the Round 14 §4.10.11 overrides are missing from §6.3; wizard copy adds about 150 B; ownership of the knowledge JSON regeneration conflicts.
- Tests: none run (read-only review).
- Status: done.
- Next: the orchestrator writes the corrections into the SPEC before Wave 2 starts.
