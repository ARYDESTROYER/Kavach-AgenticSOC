# Round 12 cross-package follow-ups (orchestrator notes)

## From WP-ENG
- WP-API: /chat/context max_output_tokens via chat_step_output_tokens(..., blocking=not streams); budget_state follow chat cap; disabled_tools unlimited; full history estimate.
- Settings editor chat-agent.tsx: mode switch first, knobs only in bounded, chat cap + animated logo inputs; web ChatAgentConfig type new fields (owner: WP-FEAT).
- WP-ACT: client recovery window derived from turn_timeout_s -> fix for unlimited.
- WP-DOC: AGENTS.md daily-budget sentence; amendments D3 (max output only streaming providers; others 4k/step + continuation), D2 (Stop abandons in-flight call), D11 (no report from stopped/failed answer), notices chat_budget_cut/budget_cut, bounded per-call timeout, bounded step inspector, T7 closed.
## From WP-TOOLS
- WP-BLK: render x.labels, x.tz, allowed_rebin, grouped_bar, comparison tiles (change, "new", "n < 20"), report layout + 4 templates; storage compaction clip x.labels with x.values.
- time_range_max_days null; chip accepts {"from":"all"}.
- WP-DOC: document case_stats, window forms, compare, templates, aligned-window labels ("last 6 months (since May 2026)"), month/year chips; types.ts TimeRange comment + openapi now-<n>M|y.
- WP-DEMO: golden set case "by month for the last 6 months vs previous period".
## From WP-AUTH
- Entry chunk +2.8 KB (Login/auth/api). Rebase bundle-first-paint baseline at the end; record budget.
- WP-DOC: regenerate openapi/api-types (LoginBody.remember, SSO remember param), knowledge corpus; DEPLOY/ENVIRONMENT notes (AUTH_TOKEN_HOURS only non-remembered; AUTH_COOKIE_SECURE for HTTPS; same-host proxy must send X-Forwarded-For; revoke_reason self_signout); CHANGELOG lines (Added Remember me; Changed browser-session cookie; Fixed /auth/me); settings-sections-meta keywords remember me after console map regen; document idle_seconds, active, ended_reason, effective_absolute_expires_at.
## From WP-REP
- WP-CHATUI: useConversationReport.test.tsx "full report" fixture 40 -> MAX_REPORT_ITEMS (60). Optional: KPI delta chip on own line in static mode.
- WP-BLK: EntityView copy button data-print-hide.
- App-wide @media print rule hiding console chrome / resetting fixed heights (theme.css) -> WP-OV or final.
- Entry-chunk Jobs download helper + KPI drill-down CSV + CaseDetail exports still revoke object URL at 0 ms -> use lib/download.ts (WP-CM / final).
- WP-API: report titles cut at 80 chars on server (chat_conversations.py).
- WP-DOC: flat export menu, Word/Excel, Download PDF button, Markdown escaping change, defang coverage (PDF, Word, MD, HTML, Excel Report sheet; never Excel tables/CSV/JSON) in docs/analyst/chat.md ~329 + corpus.
- design gates: raw hex colour in login.remember.test.tsx (WP-AUTH) -> check at integration.
## From WP-API
- WP-ACT: subscribe topic `chat` for chat.turn frames; resume with after=<last seq> (seq = non-ping line count on a from-start stream); call POST /api/chat/conversations/{id}/read when an answer is on screen; recovery polls turns/active or reattaches (no turn_timeout_s window). New thread temp row: GET detail 404 until saved.
- WP-DEMO: demo planner answers "Create a report of lifetime performance" with product help (write-verb misroute) -> fix; report save from header only testable once planner emits report header.
- WP-DOC: docs/reference/api.md (chat_request_failed, chat_account_unavailable, "(continued)" report sections, chat ratings in soc_metrics feedback, 429 retry_after/scope/limit, new routes); new chat_feedback KV namespace, chat exchange doc kinds, rollback notes in DEPLOY/AGENTS; regenerate OpenAPI/web types.
- WP-AGG: undefined names in metrics_shared.py (being fixed in WP-AGG final).
## From WP-AGG
- SPEC amendment (WP-DOC): dashboards exact up to 20,000 cases per rollup scope; above that heavy all-time rollups (auto-close health, MITRE coverage, agent improvement...) analyse the newest 20,000 with an explicit truncated marker; chat aggregates (case_stats/search_cases totals) always exact. store_total meaning = cases in rollup scope; SLA scores derived priority.
- Metrics page: "Total cases (7d)" label sits on a store-wide count; show counts_exact/truncated -> WP-OV (Metrics page) .
- chat soc_metrics sla_metrics without prefs -> derived-priority parity (WP-TOOLS file) - check fixed.
- GC deferral during population reads: final review to evaluate.
## From WP-DS
- Entry budget: 396,849 B vs 392,917 B limit (WP-AUTH ~3.0 KB, WP-DS ~0.7 KB). Orchestrator: amend SPEC §6 + rebase PRE_REVAMP_ENTRY_BYTES at the end (after WP-ACT).
- WP-CHATUI: KpiGroupView -> <KpiTileGrid count={items.length}> with framed={false} inside a block card.
- WP-OV: density="comfortable" size="fluid" on the strip, roll={false} on LIVE refreshes, origin on KPI drill-down; MaterialBar for dashbar; TimeRangePicker/RefreshButton old 3px radius pinned by overview.render.test.tsx.
- WP-CM: ~40 rounded-[3px]/[4px] overrides in Cases/CaseManager/CaseDetail.
- WP-DOC: "reduce transparency" keyword in settings-sections-meta.ts with console-map regen; Help Center mention of the setting.
## From WP-OV / WP-BLK / WP-ACT / WP-CHATUI / WP-DEMO (wave 2)
- ENTRY BUDGET: entry 399,958 B vs 400,000 B ceiling (42 B headroom); "+1 kB over baseline" check failing (~+7-8 kB this round: WP-AUTH ~3 KB, WP-DS ~0.7 KB, WP-ACT ~2.5 KB, others ReauthDialog/ThemeModePill). Need a WP-BUNDLE pass: trim entry (lazy Login remember bits etc.) to restore >= 3 KB headroom, then rebase PRE_REVAMP_ENTRY_BYTES with a SPEC amendment.
- KpiTile.round7 'countTo runs through format' failing (WP-DS area) -> fix.
- chat topic on an existing shell stream (JobMonitor/NotificationBell) for faster settling: optional; 5 s poll used now.
- src/test/setup.ts afterEach clears activity store (WP-ACT) - note.
- WP-FEAT: clarify option chips (backend returns them), zero-result chips, RunLog waiting line exists; ReportPanel "REPORT/Report" duplicate heading; Reports library infographic layout for saved infographic briefs; chart tooltip blocking drag on phones (WP-BLK minor follow-up).
- WP-DOC: Help Center + console map label updates ("AI-verdict FP rate", "Response time", "Total cases (all time)", per-user Deeper analytics), Group by/zoom/image download/full width in BLOCKS.md + ui-standard, nav badge wording, Settings "Animate the logo while chat works", "Waiting for another answer to finish", openapi + types regen; SPEC §10.1 reference widths (WP-CHATUI report numbers).
- HMR "useRoute must be used within a RouterProvider" blank page seen during concurrent edits -> verify on a production build at final QA.
## From WP-FEAT-A
- WP-DEMO small: "Explain step N (...)" answered as product help; "Run step N again" reruns only when a window is named.
- WP-DOC: Help Center still says 5 model calls / 10 lookups / 90 s per question; describe Add to case (Sources list + note), step inspector, feedback, clarify; ChatStep visible escapes amendment (visible_display_text, display_params(visible=True)).
- Compaction summary text is not returned by any route -> no "show summary" disclosure (decide: add summary to conversation detail? or accept).
- Possible stray thread switch on reload to an older "Needs input" thread (WP-ACT selection preference) -> final review.
- Flaky under load: ComposerEnterRepeat.test.tsx (act warning stderr), one CaseManager test.
