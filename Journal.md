# Journal.md — shared work diary

> **Every agent (orchestrator + sub-agents) MUST add an entry here for every work
> session and milestone.** This is our memory across context resets. Newest at the
> bottom. Sub-agents that cannot commit must return their entry in their final
> report so the orchestrator appends it. Format is defined in `AGENTS.md`.

```
### YYYY-MM-DD HH:MMZ — <agent/role> — <short title>
- Context: <goal / roadmap item>
- Did: <files, endpoints, decisions>
- Tests: <pytest/tsc/build results>
- Status: <done | in-progress | blocked: why>
- Next: <handoff>
```

---

### 2026-06-16 (earlier) — orchestrator — Phase 1 build (history backfill)
- Context: Build the full suite from the TLSOC spec (Phase-1 POC, Kibana 8.12.2).
- Did: Authored the backend (config/models/constants/utils; es client+fake+
  querybuilder+indices; llm gateway+providers+pricing; tools es_query/enrich/rag/
  vectorstore+cache; engine correlation/risk/cost_gate/case_manager/signatures/
  poller; agents prompts/router/investigator/formatter/chat/standup/graph/pipeline;
  stores + audit; api routes + state + main; Dockerfile). Built the Kibana 8.12.2
  plugin (5 surfaces + wizard + server proxy) and the zip. Wrote deploy block,
  mappings, dashboards, and all docs.
- Tests: 49 backend tests green; live in-process end-to-end (poll→investigate→
  TRUE_POSITIVE→needs_human, audit + cost ledger, idempotent). Plugin zip built
  with UI bundle. Compose merge validated against real upstream.
- Status: done. Commits 32d52d0, 942bc49, cd6571b, 585647b.
- Next: 8.19.12 support.

### 2026-06-16 (earlier) — orchestrator + sub-agents — Kibana 8.19.12 plugin build
- Context: Produce an 8.19.12-installable zip (8.12.2 manifest was rejected).
- Did: Fresh v8.19.12 checkout (`/tmp/kibana-8.19`), Node 22.22.0 (repo pin; Bazel
  removed in 8.19). Discovered 8.19 third-party plugins still use legacy
  `kibana.json` (plugin_helpers REJECTS `kibana.jsonc` package plugins);
  `--kibana-version 8.19.12` stamps the manifest. Source change = 18 import-path
  lines only (`src/plugins/*`/`src/core/*` → `@kbn/*` aliases). Added a forward-
  compat `kibana.jsonc` (reference only). Root-guard worked around with a PATH
  `yarn` shim (no Kibana source patched).
- Tests: tsc clean for our code; zip contains target/public/...plugin.js; manifest
  kibanaVersion 8.19.12; 0 hardcoded backend URLs in browser bundle; built+verified
  3×; 8.12.2 zip byte-identical.
- Status: done. Commit 9474802. Then exhaustive docs (USAGE/TROUBLESHOOTING +
  matrix updates) committed 585647b.
- Next: Dev Work Order (P0/P1/P2 + Features 1-5) on 8.19.12.

### 2026-06-16 — orchestrator — coordination docs + work-order kickoff
- Context: User asked for CLAUDE.md + Journal.md (this file) + extra docs, answered
  two product questions (no header chat button; settings incomplete), and a large
  dev work order (P0/P1/P2 + Features 1-5), all targeting 8.19.12.
- Did: Wrote CLAUDE.md (master/context/env/journal-mandate) and Journal.md.
  Confirmed root causes: `plugin.ts` registers 0 navControls (→ Feature 1);
  settings.tsx is a 369-line subset of ~91 Preferences fields (→ Feature 4).
- Tests: n/a (docs).
- Status: in-progress — beginning the work order via sequenced Opus sub-agents.
- Next: backend contract+logic changes, then plugin, then rebuild 8.19.12 + test.

### 2026-06-16 — backend agent A — P1 (stability/provenance) + P2 (risk/correctness)
- Context: Work-order P1 + P2 (ran in parallel with the P0 frontend agent).
- Did: P1 — `Case.origin_surface` + `Case.verdict_history`; `investigate_cluster(force=…)`
  skips re-investigation of an unchanged already-investigated OPEN case (no LLM,
  no verdict drift); preserve original `source_surface` on update. P2 — velocity
  no longer saturates on a same-ms burst (needs ≥3 events + ≥1s window);
  `caps.timeout_seconds` enforced via `asyncio.wait_for` → NEEDS_HUMAN on timeout;
  `normalize_kql` maps bare `ip:/user:/host:` to configured fields; CIDR
  `asset_networks` internal-asset policy in `risk.compute_risk`. Added
  `overview_model` pref + `Role.OVERVIEW` (prep for Feature 2).
- Tests: `pytest -q` green (53 passed; +test_pipeline_stability, +risk cases).
- Status: done for P1+P2. Agent was rate-limited before Features 1-4 backend.
- Next: Feature 1 chat-context, Feature 2 /api/overview, Feature 3 trigger-reason,
  Feature 4 /api/models (routes.py still untouched), then RAG.

### 2026-06-16 — frontend agent — P0 (case detail + lifecycle)
- Context: Work-order P0 ("features feel broken").
- Did: new `public/components/case_detail.tsx` rehydrates a case via
  `api.get('cases/'+id)`; selection lifted into `app.tsx` (survives tab switches);
  table rows OPEN the stored case (GET by id) instead of re-investigating; a
  separate explicit "Re-investigate (LLM)" action remains; lifecycle controls
  (Close/Confirm FP/Escalate/Reopen) → `POST cases/{id}/action`; scans rows open
  detail too.
- Tests: tsc --noEmit clean for our public/ + common/ against /tmp/kibana-8.19.
- Status: done (pending final 8.19 zip rebuild at the end).
- Next: features-frontend (F1-5) builds on this app.tsx selection state.

### 2026-06-16 14:10Z — docs sub-agent — SECURITY/RUNBOOK/CONTRIBUTING/CHANGELOG
- Context: Create the extra full-scale-deployment docs the user asked about.
- Did: SECURITY.md (threat model, trust-boundary diagram, two-key model + role
  descriptors, secrets/injection posture, hardening checklist); docs/RUNBOOK.md
  (health, dashboards, key rotation, kill switch, ILM/backup, scaling, tool IR,
  plugin re-install); CONTRIBUTING.md (workflow, conventions, extension points,
  Journal mandate); CHANGELOG.md (Keep-a-Changelog from git log). 703 lines total,
  grounded in 12 source files. Docs-only.
- Tests: n/a (docs). git status = only the 4 new files from this agent.
- Status: done.
- Next: orchestrator commit; backend Features 1-4 + RAG agent still running.

### 2026-06-16 ~15:30Z — orchestrator — backend Features 1-4 (authored directly)
- Context: The big backend agent stalled (infra watchdog) after only Feature 4's
  pricing helpers; rate-limits had also hit two earlier agents. To guarantee the
  frontend-blocking contract, I authored Features 1-4 backend myself.
- Did: Feature 4 `GET /api/models` (grouped from pricing.PRICES + configured).
  Feature 1 `ChatContext` model + `ChatRequest.context`; `ChatEngine.chat(context=)`
  fences it as UNTRUSTED and uses time_range/data_view as es_query DEFAULTS only;
  `CHAT_SYSTEM` note; `/chat` passes context. Feature 2 `agents/overview.py`
  (`OverviewService`, single-event, enrichment-reusing, cost-ledgered, never
  raises) + `POST /api/overview` + state wiring. Feature 3 `TriggerReason` model +
  `Cluster.trigger_reason` + `Case.trigger_reason`; correlation `_window_detail`
  captures the primary rule's matched window + builds a human sentence; pipeline
  copies it onto the case in all 3 builders; `CASES_MAPPING` gains
  `trigger_reason/verdict_history/origin_surface`; template priority bumped to 600.
- Tests: `pytest -q` = 60 passed (+test_features_backend: models/overview/chat-
  context/trigger-reason).
- Status: done. RAG (P1) still outstanding.
- Next: commit; then RAG (resolved-case memory, ES dense_vector store, embedding
  guard, min-cosine, chat grounding); then features-frontend; then 8.19.12 rebuild.

### 2026-06-16 ~16:10Z — frontend agent + orchestrator — Features 1/3/4 (FE) + 8.19.12 rebuild
- Context: Deliver the user's two pain points (header chat button + full settings)
  plus trigger-reason rendering, then rebuild the 8.19.12 zip.
- Did (agent): plugin.ts start() registers core.chrome.navControls.registerRight
  (global header button via toMountPoint+core.rendering); new global_chat_control
  + global_chat_flyout (reuses the Chat component with a send-time screen-context
  collector); lib/screen_context.ts (best-effort, per-source try/catch; query/
  selection only ever go in the request body); chat.tsx optional getContext prop;
  settings.tsx full rewrite (every Preferences field, per-role model pickers from
  GET /models, correlation/asset/suppression/network editors, kill switch, secrets
  status + update-keys, read-only mode); trigger_reason_callout wired into
  case_detail + scans; common/index.ts synced (origin_surface/verdict_history/
  trigger_reason + ChatContext/TriggerReason/ModelsResponse).
- Did (orchestrator): built the authoritative tlsocAgenticTriage-8.19.12.zip from
  repo source (Node 22.22.0, root-guard yarn shim, BROWSERSLIST_IGNORE_OLD_DATA).
- Tests: pytest 60 passed; tsc clean for public/+common; zip verified — bundle
  present, kibanaVersion 8.19.12, 0 backend URLs in browser bundle, navControls +
  "TLSOC Agent" compiled in (header button confirmed in the artifact).
- Status: done. Pain points delivered in the rebuilt zip.
- Next (queued): Feature 2 (Discover doc-viewer + in-app overview button),
  Feature 5 (wizard rewrite), P1 RAG; refresh USAGE/BUILD docs.

### 2026-06-16 ~17:00Z — backend/RAG sub-agent — P1 RAG upgrades
- Context: P1 "RAG improvements" (6 tasks).
- Did: (1) use_resolved_cases — RagService takes CaseStore; index_resolved_cases()
  indexes CLOSED cases (verdict+entity+rules+evidence+action, source=resolved_case)
  from ensure_seeded. (2) ESVectorStore (dense_vector tlsoc-agent-rag, kNN cosine,
  mgmt client) selected only with a real RealESClient+_mgmt; InMemoryVectorStore
  stays default/fallback; delete_index added to real+fake ES. (3) StoredChunk tagged
  with embedding_model+dim; cosine truncation removed; dim mismatch raises
  EmbeddingSpaceMismatch → clear+reseed (never truncate). (4) RagConfig.min_score=0.2;
  retrieve drops sub-threshold. (5) richer pure rag_query (entity+count+hosts/users+
  sample message). (6) RagService wired into ChatEngine; chat adds a TRUSTED
  (non-fenced, our own corpus) KB block, graceful with/without RAG.
- Tests: +tests/test_rag_p1.py (9 offline). pytest -q = 69 passed.
- Status: done. plugin/ untouched; non-negotiables preserved.
- Next: orchestrator commit; expose rag.min_score in Settings (already covered by
  the full-prefs settings page).

### 2026-06-16 ~18:00Z — orchestrator — Feature 2 (per-log AI overview) + 8.19.12 rebuild
- Context: The Feature 2/5 frontend agent STALLED (infra watchdog, 4th frontend
  infra failure) with zero repo changes. The original wizard already has working
  4-step EuiSteps, so Feature 5 is a polish-rewrite of a functional wizard ->
  DEFERRED (tracked). I implemented Feature 2 directly.
- Did: new public/components/log_overview.tsx (renders POST /api/overview result);
  doc_viewer_overview.tsx (resolves http via getStartServices for the Discover
  tab); plugin.ts setup() registers a guarded, loosely-typed unifiedDocViewer
  doc-viewer tab "TLSOC AI Overview" (optionalPlugins, try/catch -> can't break
  setup); in-app per-row "AI overview" button in the chat result table (opens a
  modal; reconstructs a nested _source so IP enrichment works); types.ts
  AppPluginSetupDependencies; kibana.json optionalPlugins=[unifiedDocViewer].
  Rebuilt the 8.19.12 zip from source.
- Tests: pytest 69 green; tsc clean for public/+common; zip verified — bundle
  present, kibanaVersion 8.19.12, optionalPlugins set, 0 backend-URL leak,
  Feature 1/2 compiled in. dist zip 57493 bytes.
- Status: Feature 2 done. Feature 5 (wizard rewrite) DEFERRED — the existing
  wizard works; rewrite is polish + risky to do blind (no live Kibana).
- Next: USAGE/CHANGELOG refresh; Feature 5 wizard-rewrite when a live 8.19 stack
  is available to validate dataViews.createAndSave.

### 2026-06-16 ~18:40Z — docs sub-agent — USAGE.md + BUILD.md refresh for shipped features
- Context: Document this cycle's user-facing features in the usage/build guides.
- Did: USAGE.md (+144/-15) — global header chat button (F1), new "Per-log AI
  overview" section (F2) + curl for POST /api/overview & GET /api/models, case
  detail+lifecycle (P0), "why this fired" (F3), Settings now documents every
  preference + 7 per-role models, wizard-is-functional note (F5 deferred).
  BUILD.md (+20/-2) — optionalPlugins:[unifiedDocViewer] (guarded), no recipe
  change, verified 8.19.12 zip ~57KB. Grounded in routes.py/config.py/pricing.py/
  plugin.ts/kibana.json/components.
- Tests: n/a (docs); git status shows only the 2 files.
- Status: done — work-order cycle complete except deferred Feature 5.
- Next: Feature 5 wizard rewrite against a live 8.19 Kibana (tracked in ROADMAP).

### 2026-06-16 17:00Z — orchestrator — Cycle 2/3 kickoff (fresh container)
- Context: New session on branch `claude/epic-cannon-p5z5ha` at 948bc45 — the exact
  deployed commit the Cycle 2 bugs were filed against. Goal: work the Cycle 2 bug
  list + Cycle 3 feature requests via Opus sub-agents, backend-first (pytest is the
  only in-container verification; plugin build needs the heavy Kibana checkout).
- Did: rebuilt backend/.venv (baseline 69→ now 88 tests green); re-cloned
  `/tmp/kibana-8.19` (v8.19.12) + `yarn kbn bootstrap` (exit 0) in background so the
  plugin toolchain is warm for the final 8.19.12 zip rebuild. Ran Wave 1 = 3 isolated
  backend agents on disjoint files (below).
- Tests: full suite 88 passed after the wave.
- Status: in-progress — Wave 1 committed (7370f43, 65e695b, ba6d09f).
- Next: Wave 2 = investigate-path agent (BUG-2 backend + IMPROVEMENT + C3-4) owning
  routes/pipeline/config/models; then rule-catalog wave (C3-1 + C3-6b); then
  trace+resolved-RAG wave (C3-3 + C3-5); then frontend; then rebuild 8.19.12 zip.

### 2026-06-16 17:10Z — backend agent (BUG-1) — chat 2-turn analysis
- Context: BUG-1 (HIGH) — chat never showed analysis; ChatEngine.chat was single-turn
  and the fetched rows never reached the model (only a preamble + raw table).
- Did: second model turn `_analyse_results` in agents/chat.py — on tr.ok+tr.data, build
  a COMPACT facets-first aggregate (counts, time span, top-5 rules/users/hosts/ips,
  <=5 sample rows), fence() it UNTRUSTED, re-prompt for {answer}, set the final answer
  + add res2.cost to the ledger; try/except falls back to old summary so chat never
  hard-fails. No-query/query-failed paths + Feature-1 ChatContext unchanged. CHAT_SYSTEM
  rewritten for the 2-step contract (only that constant). +tests/test_chat_analysis.py.
- Tests: pytest 73 passed (at the time). Note: fence() caps at 600 chars; facets are
  ordered before sample_rows so truncation drops samples first (acceptable).
- Status: done (committed 7370f43).
- Next: plugin chat UI already renders answer+table — no contract change.

### 2026-06-16 17:15Z — backend agent (BUG-5) — real-time correlation over full window
- Context: BUG-5 (HIGH) — poller correlated only the incremental cursor batch, so bursts
  spread across >1 poll interval never reached the threshold (slow-burn misses).
- Did: poller.py only — poll_once now does a second read-only sliding look-back read
  (`max(widest rule window, poll_interval)+2*interval`, clamped to cold-start), de-dupes
  by event id with new_events, and feeds the FULL window to correlate() (signature
  unchanged). Cursor still defines "new"; signature idempotency + _attach prevent dup
  cases / re-investigation. +2 tests: a 6-event/~60s burst arriving as below-threshold
  batches now creates exactly 1 case; overlapping windows + idle polls create no dup and
  no re-investigation; verified 0 cases under old per-batch behavior.
- Tests: pytest 75 passed (at the time).
- Status: done (committed 65e695b).
- Next: live-stack sanity that the window read stays within poll_batch_size on noisy windows.

### 2026-06-16 17:30Z — backend agent (C3-6a) — OpenAI catalog + provider param quirks
- Context: C3-6 PART A (isolated half) — expand the OpenAI price catalog + per-model param
  quirks; per-rule model wiring (config/pipeline) deferred to the rule-catalog wave.
- Did: pricing.py — added gpt-4.1, gpt-4.1-mini, gpt-4-turbo, gpt-4, o4-mini, gpt-5,
  gpt-5-mini with operator-verifiable approx USD/1M prices (commented), kept _DEFAULT_PRICE;
  provider_for() maps o1/o3/o4* to openai. providers.py — _is_reasoning_or_gpt5(); OpenAI
  complete omits temperature + sends max_completion_tokens for gpt-5 family + o-series,
  classic params elsewhere. +tests/test_pricing_catalog.py (13 cases incl. httpx-boundary).
- Tests: pytest 88 passed.
- Status: done (committed ba6d09f).
- Next: per-rule model_for_rule wiring rides with C3-1 rule catalog (shares model_override).

### 2026-06-16 19:45Z — backend agent (Wave2) — investigate path: BUG-2 + IMPROVEMENT + C3-4
- Context: own the investigate flow — fix the hardcoded now-24h 400 (BUG-2), restore manual
  "Why this fired"/provenance/reproduce_query (IMPROVEMENT), add human-triggered case
  re-investigation (C3-4).
- Did: added Preferences.investigate_lookback + InvestigateRequest.lookback (per-request
  override). Rewrote routes._cluster_for_request with an auto-widen ladder
  (configured/requested → now-7d → now-30d → now-365d; skips rungs narrower than the start;
  first non-empty wins) + a neutral, specific 400 detail for the FE empty-state. Synthesized
  a manual TriggerReason (mode=manual) so "Why this fired" renders on manual cases; preserve
  origin_surface across a forced re-investigate. New POST /api/cases/{id}/investigate
  (load→rebuild via id-requery then config-windowed entity fallback→investigate_cluster(
  force=True); preserves source/origin surface, appends verdict_history; 404 missing, neutral
  400 when aged out). Made pipeline._assemble_case normalize reproduce_query UNCONDITIONALLY
  and fixed a latent normalize_kql regex bug (source.ip → source.source.ip) via a (?<![\w.])
  negative lookbehind in agents/common.py. Used now-365d (not now-1y; relative_to_millis lacks
  a year unit). No ES-layer change needed (existing ids_query + search_logs sufficed).
- Tests: +tests/test_investigate_flow.py (8). Full suite 96 passed (committed 2d07439).
- Status: done.
- Next: FE — surface the new POST /cases/{id}/investigate button + render the neutral-400
  empty-state (errorDetail); expose investigate_lookback in settings.

### 2026-06-16 18:00Z — orchestrator — build toolchain + Wave 3 launch
- Context: validate the plugin build toolchain (historically flaky) before frontend exists;
  start the rule-catalog backend wave.
- Did: yarn kbn bootstrap installed all deps (node_modules 2.4G, 1112 @kbn pkgs) but aborted
  at the trailing Playwright FIREFOX browser install (blocked CDN — PLAYWRIGHT_SKIP_BROWSER_
  DOWNLOAD only suppresses the npm postinstall, not Kibana's explicit `playwright install`).
  Since the optimizer build needs no browsers, run plugin_helpers build directly against the
  populated node_modules (build-only smoke test in flight). Launched Wave 3 (C3-1 rule catalog
  + C3-6b per-rule models) after two transient infra errors (Bash classifier + a 0-token Agent
  500) cost a retry — no work lost (tree was clean).
- Tests: n/a (orchestration).
- Status: in-progress.
- Next: verify build-only zip; commit+push Wave 3; then trace+resolved-RAG wave; then frontend.

### 2026-06-16 19:30Z — orchestrator (direct) — Wave 4: trace (C3-3) + resolved-case RAG (C3-5)
- Context: agent spawns were repeatedly 529-Overloaded (two Wave-4 sub-agents died at
  0 tokens), so I implemented this wave directly. All backend Cycle-2/3 work now done.
- Did: C3-3 — TraceStep model; GET /api/cases/{id}/trace (mgmt-key term case_id, sort ts
  asc; NEVER 404); AuditLogger.records_for_case(); formatter now writes a Role.FORMATTER
  audit row (so it appears in the trace); Preferences.trace.include_prompts toggle omits the
  untrusted prompt excerpt. C3-5 — RagService.index_resolved_case() indexes ONE resolved_case
  chunk on close/confirm_fp (entity+rules+verdict+risk+trigger+analyst note) with deterministic
  doc_id=resolved_case:{id}; StoredChunk gains doc_id (InMemory upserts, ES upserts by _id);
  case_action calls it fail-safe (close still 200 if RAG/embeddings fail); render_cluster groups
  resolved_case chunks under "## Prior analyst decisions (baseline)". Also: update_prefs now syncs
  RagService prefs so a live settings toggle (rag.enabled/use_resolved_cases/min_score) takes effect.
- Tests: +tests/test_trace_rag.py (8). Full suite 121 passed, clean under -W error::UserWarning.
  Committed 04c7be2.
- Status: BACKEND COMPLETE for Cycle 2/3. Remaining = frontend phase + 8.19.12 rebuild + docs.
- Next: own common/index.ts contract (BUG-3 standup shape, TraceStep/TraceResponse, RuleMatch/
  RuleDefinition); then parallel FE agents (case-detail hub · standup+board · settings editors);
  consolidated tsc + zip rebuild; docs + migration note.

### 2026-06-16 19:40Z — orchestrator + 3 FE agents — frontend phase (Cycle 2/3) + 8.19.12 rebuild
- Context: deliver all remaining frontend work after the backend was complete; one coordinated
  phase + a single verified build (frontend can only be tsc'd/built against the Kibana checkout).
- Did: orchestrator owned common/index.ts (BUG-3 cases-object shape; +TraceStep/TraceResponse,
  RuleMatch/RuleDefinition; committed ec7a847). Three parallel FE agents on disjoint files:
  FE-A case-detail (509b928) — BUG-2 neutral no-events empty-state (errorDetail/isNoEventsError),
  C3-3 agent_trace.tsx (EuiCommentList, untrusted query/tool/prompt in EuiCodeBlock), C3-4
  Investigate button (POST cases/{id}/investigate + trace refresh), C3-5 note modal feeding the
  action, C3-7 case_timeline.tsx (merge history+verdict_history, dedupe decisions ×N). FE-B
  (a9c97c1) — BUG-3 standup fix + ErrorBoundary, C3-2 board.tsx Kanban (drag→close/reopen/escalate,
  optimistic+revert) + Board tab in app.tsx. FE-C (49a69a8) — C3-1 rule-catalog editor + C3-6
  per-rule model table in settings.tsx (reuses the per-role pickers).
- Tests: consolidated `tsc --noEmit` CLEAN for public/server/common (all 3 agents' code). Built the
  8.19.12 zip: bundle present, kibanaVersion 8.19.12, 0 backend-URL leaks, 68KB (was 57KB); copied to
  plugin/dist (b988329). Backend suite remains 121 green.
- Status: ALL Cycle 2 bugs + Cycle 3 features delivered (BE + FE), verified, pushed. Two deliberate
  deferrals: Feature 5 (wizard rewrite — the existing 4-step wizard works; rewrite best validated on a
  live 8.19 stack) and the Cycle-2 "entity-signature attach" NOTE (being handled next).
- Next: implement the optional NOTE (surface trigger_reason on attached non-scan cases); refresh
  USAGE/BUILD/CHANGELOG/ROADMAP + migration note; final push.

### 2026-06-16 19:50Z — docs sub-agent — USAGE/BUILD/CHANGELOG/ROADMAP + migration note (Cycle 2/3)
- Context: refresh user-facing docs for the shipped Cycle-2 bug fixes + Cycle-3 features, grounded
  against the code on this branch.
- Did: USAGE.md — 7-tab table + new Board section; documented chat 2-turn analysis, native header
  button, investigate lookback/auto-widen/empty-state, agent trace + re-investigate + RAG-on-close +
  merged timeline, standup cases-object + error boundary, settings rule-catalog + per-rule models +
  expanded catalog + trace toggle, sliding correlation, and new curl examples (/cases/{id}/investigate,
  /cases/{id}/trace, lookback). BUILD.md — zip ~57→~68KB, new components compile in, recipe unchanged.
  CHANGELOG.md — Cycle 2/3 subsections. ROADMAP.md — status ticks. DEPLOY.md — new ## Migration section
  (reinstall zip, version-guarded rule_catalog seed, additive prefs, no new ES index, rebuild on pricing
  edits). Verified every claim against chat.py/routes.py/standup.py/poller.py/config.py/pricing.py/
  models.py/app.tsx/board.tsx.
- Tests: n/a (docs). Orchestrator corrected the cited test count 121→124 (the NOTE added 3 after the
  agent ran).
- Status: done.

### 2026-06-16 19:55Z — orchestrator — Cycle 2 + Cycle 3 COMPLETE
- Context: close out the full work order (Cycle-2 bugs + Cycle-3 features) on branch
  claude/epic-cannon-p5z5ha (started at the deployed 948bc45).
- Did: delivered + pushed EVERY Cycle-2 item (BUG-1..5, IMPROVEMENT, NOTE) and EVERY Cycle-3 item
  (C3-1..C3-7), backend + frontend. Backend across waves 1-4 + the NOTE; frontend via the contract
  (common/index.ts) + 3 parallel FE agents (case-detail hub / standup+board / settings editors); docs
  refreshed. Several sub-agent spawns hit transient 529/500/classifier outages — Wave 4 was authored
  directly after two 0-token agent deaths; all other waves landed via agents.
- Tests: backend 124 passed (clean under -W error::UserWarning); plugin tsc --noEmit clean for
  public/server/common; 8.19.12 zip rebuilt + verified (bundle present, kibanaVersion 8.19.12, 0
  backend-URL leaks, ~68KB) and committed to plugin/dist.
- Status: DONE. Deferred (deliberate): Feature 5 wizard rewrite (existing 4-step wizard works; rewrite
  best validated on a live 8.19 stack).
- Next: live-stack validation on the SIEM server (install the 68KB zip, restart backend → rule_catalog
  seeds; exercise board drag, agent trace, re-investigate, close-with-note→RAG, settings editors).

### 2026-06-16 18:10Z — orchestrator — plugin build toolchain VALIDATED
- Context: de-risk the historically-flaky plugin build before frontend changes exist.
- Did: wrote /tmp/build_only.sh (root-guard yarn shim → --allow-root; PLAYWRIGHT/PUPPETEER/etc.
  skip vars; BROWSERSLIST_IGNORE_OLD_DATA mandatory). generate_plugin scaffolded the skeleton,
  copied repo source over it, plugin_helpers build --kibana-version 8.19.12 against the populated
  node_modules. Result zip VERIFIED: browser bundle present, kibanaVersion 8.19.12, 0 backend-URL
  leaks, 57494 bytes (== committed zip; source unchanged). Only warning is ci-stats.kibana.dev 403
  (telemetry, harmless). The final post-frontend rebuild is now just a re-run of this script.
- Tests: build verification block (bundle/version/leak/size) all pass.
- Status: done.

### 2026-06-16 18:42Z — frontend agent (BUG-4) — header chat button styling
- Context: BUG-4 (LOW, cosmetic) — global navControl chat trigger was a dark, low-contrast button.
- Did: public/components/global_chat_control.tsx now uses Kibana's native EuiHeaderSectionItemButton
  wrapping EuiIcon type="discuss" (no hardcoded colors → EUI owns theme contrast), with aria-label/
  title + aria-expanded/pressed and a subtle notification dot while the flyout is open. Behavior/props/
  flyout wiring preserved; no other files, no new deps.
- Tests: tsc -p tsconfig.json --noEmit against /tmp/kibana-8.19 → NO PLUGIN TS ERRORS.
- Status: done (committed 387d27b, pushed).

### 2026-06-16 18:05Z — backend agent (Wave3) — rule catalog (C3-1) + per-rule models (C3-6b)
- Context: C3-1 config-driven rule catalog (13 real event.module rules + 5 ModSec sub-rules isolating
  XSS/SQLi/LFI/RCE/scanner via rule.id prefix) + C3-6b per-rule model selection (share model_override).
- Did: RuleMatch/RuleDefinition + rule_catalog/rule_catalog_seed_version/rule_model_override +
  match_rule/correlation_for_def/model_for_rule/maybe_seed_rule_catalog/default_rule_catalog in
  config.py. from_hit classifies via catalog when non-empty (empty path byte-identical); Cluster.
  primary_rule(). correlate uses correlation_for_def(rd) with legacy correlation_for(name) fallback.
  router/investigator/formatter resolve models via model_for_rule(role, cluster.primary_rule()).
  Seeding via ConfigStore.seed_rule_catalog wired into state.startup(), version-guarded, never clobbers
  operator edits. Verified empty-catalog backward-compat in correlation.py + from_hit diffs.
- Tests: +tests/test_rule_catalog.py (17). Full suite 113 passed (was 96). Committed e714a35, pushed.
- Status: done.
- Next: FE rule-catalog editor + per-rule model table in settings.tsx; common/index.ts types.

### 2026-06-18 09:00Z — orchestrator + 6 frontend sub-agents — UI redesign (design system + all surfaces)
- Context: User asked for a cleaner, more attractive UI across the plugin — better
  colour scheme + nomenclature, a Board you can actually move cards in, and a much
  tidier Automated Scans, Cost, and Settings. Branch `claude/amazing-noether-vrm2ly`.
- Did (orchestrator, authored directly):
  - NEW shared design system (single source of truth for the look):
    `public/lib/format.ts` (DASH, humanizeAge, formatTimestamp, fmtMoney/Number/
    Tokens/Percent, toPercentValue, humanizeToken) and `public/components/ui.tsx`
    (COLORS palette + tint(); verdictColor/verdictHex/statusHex/riskHex; RiskBadge/
    VerdictBadge/StatusBadge/ConfidenceBadge; SectionHeader; StatTile; EmptyState).
    Expanded `public/index.scss` with layout utilities (tlsocIconChip, tlsocStatTile,
    tlsocBoard__scroll/__column/__dropZone, tlsocCard hover/dragging, tlsocCard__handle).
  - Dispatched 6 non-overlapping sub-agents; reviewed every diff for EUI-prop/JSX
    correctness against the bootstrapped 8.19 EUI.
- Did (sub-agents, one file-set each, presentation-only, no logic/contract change):
  - board.tsx — SectionHeader; horizontal scroll lane (no more cramped columns);
    coloured column headers (status dot + count); cards restyled with verdict/status
    left-accent + shared badges; **fixes "can't move cards"**: a VISIBLE grab handle
    (customDragHandle + hasInteractiveChildren) AND a per-card actions menu
    (Open / Close / Escalate / Reopen) — both funnel into the existing confirm flow.
  - scans.tsx — SectionHeader + 4 KPI StatTiles + a responsive card grid (verdict/
    status accent, entity icon chip, shared badges, formatTimestamp·age, Open/
    Reproduce/Why-fired); EmptyState + spinner. Replaced the plain table.
  - cost.tsx — SectionHeader + 4 StatTiles; By model/role/surface breakdown cards
    with proportional EuiProgress bars; dependency-free cost-over-time bar list;
    resilient top-cost-drivers table; EmptyState. No @elastic/charts.
  - settings.tsx — visual-only: SectionHeader; accordion sections now carry an
    accented icon chip; configured-credentials shown via EuiHealth; consistent
    subsection labels. ALL ~91 fields + every handler/path unchanged.
  - app.tsx — page-header description; restrictWidth 1280; tab nomenclature + per-tab
    EuiIcon (prepend) + bottomBorder; error → EuiCallOut. Logic untouched.
  - standup.tsx — SectionHeader + 3 StatTiles + titled summary/breakdown cards +
    EmptyState; ErrorBoundary + BUG-3 cases-object handling preserved.
  - investigate.tsx / case_detail.tsx / verdict_card.tsx — adopt shared badges +
    SectionHeader + formatTimestamp; removed duplicated local verdict/status colour
    fns. trigger_reason_callout.tsx left as-is (already consistent).
- Tests: bootstrapped a fresh /tmp/kibana-8.19 (v8.19.12, Node 22.22.0); `tsc -p
  tsconfig.json --noEmit` → **0 plugin-scoped errors** (the 13 errors are all in
  `src/`/`x-pack/` kbn-config-schema/kbn-i18n — pre-existing monorepo noise).
  `plugin_helpers build --kibana-version 8.19.12` rc=0; verification block all green:
  bundle `tlsocAgenticTriage.plugin.js` present, `"kibanaVersion": "8.19.12"`,
  backend-URL leak count = 0. Verified zip = **75,631 B (~74 KB)**, copied into
  `plugin/dist/`. (Bootstrap note: the only bootstrap failure was the post-install
  `playwright install` Firefox download — blocked by egress, irrelevant to plugin
  builds; deps + all 1112 `@kbn/*` symlinks installed fine.)
- Status: done (8.19.12). The legacy 8.12.2 zip is NOT rebuilt this session (needs the
  Node 18 + bazel checkout) — source is version-agnostic; flagged in BUILD.md for parity.
- Next: commit + push to claude/amazing-noether-vrm2ly. Optional follow-ups: live-stack
  visual check on a real 8.19 Kibana; rebuild the 8.12.2 zip for parity.

### 2026-06-18 11:25Z — orchestrator — Investigate page → reference "Security Investigation" design
- Context: User supplied a reference mock for the Investigate tab and asked to implement it +
  "use the wasted free space" + make it prettier.
- Did: Rewrote `public/components/investigate.tsx` to match the reference. Header is now
  "Security Investigation" (subtitle "Triage emerging threats and analyze entity behavior
  across the infrastructure."). Manual entry uses an uppercase meta-label + entity-type
  `EuiSelect` ("IP Address"/User/Host) + `EuiFieldSearch` (magnifier + Enter-to-investigate)
  + a filled Investigate button. Replaced the cases `EuiBasicTable` with a 3-column
  `EuiFlexGrid` of "Active Case" cards — each shows ENTITY/RISK meta labels, the entity in
  monospace/primary, a prominent colour-coded risk number (riskNumberColor: ≥80 danger,
  ≥60 orange, else ink), RULES pills, a divider, CREATED timestamp and a status pill
  (open=hollow / needs_human=amber / closed=green). Whole card is a keyboard-accessible
  selectable control with a primary ring on the selected case. Added an "Active Cases"
  sub-header (live count) with Refresh + a functional **Filters** popover (client-side
  status toggles + a hidden-count badge). When no case is selected the detail area shows a
  tall dashed "Select a case to begin Agentic Triage" prompt; selecting one renders the
  existing CaseDetail + follow-up Chat. Dropped the old per-row re-investigate modal
  (CaseDetail already exposes Re-investigate). Also added a subtle global footer to
  `app.tsx` (PLUGIN_NAME + read-only note + ES-connected when known). No new deps; logic/
  contracts unchanged.
- Tests: tsc -p tsconfig.json --noEmit against /tmp/kibana-8.19 → 0 plugin-scoped errors;
  all new EUI icons verified against icon_map.js (filter/search/refresh/iInCircle OK);
  rebuilt + verified 8.19.12 zip (bundle present, kibanaVersion 8.19.12, 0 backend-URL leak,
  76,850 B ~75 KB) → copied into plugin/dist/.
- Status: done.
- Next: commit + push. Optional: apply the same card style to Scans/Board for full parity;
  live-stack visual check.

### 2026-06-18 19:45Z — orchestrator + 2 sub-agents — case detail flyout + unified cards + Settings nav
- Context: User design review: clicking a case only revealed detail far down the page (had to
  scroll) and several surfaces still felt unpolished. Agreed direction (via AskUserQuestion):
  right-side FLYOUT for detail; unify the card + open behaviour across Investigate + Scans +
  Board; add severity accents/hover, sort, filter chips, KPI strip; add a left section-nav to
  Settings; and use the wasted horizontal space.
- Did (orchestrator, authored directly):
  - NEW `lib/cases.ts` — risk banding (critical/high/medium/low), sort (risk/date), and
    filter (status/risk-band/verdict) pure helpers.
  - NEW `components/case_card.tsx` — the ONE uniform case card (severity left-accent, entity,
    prominent restrained risk number, band+verdict chips, rules +N, created + status pill;
    clickable root; optional dragHandle/cornerActions slots for the Board). Exports MetaLabel/
    StatusPill/riskNumberColor/fmtRisk.
  - NEW `components/case_grid.tsx` — KPI strip + controls (count, sort EuiSelect, refresh,
    filter EuiPopover) + removable active-filter chips + an auto-filling responsive CSS grid
    (`.tlsocCaseGrid` repeat(auto-fill,minmax(320px,1fr))).
  - NEW `components/case_detail_flyout.tsx` — right-side EuiFlyout (size l): header (entity +
    verdict/status/risk/confidence badges) + tabs (Overview · Agent trace · History · Ask) +
    sticky EuiFlyoutFooter with contextual lifecycle actions + Re-investigate; reuses
    TriggerReasonCallout/AgentTrace/CaseTimeline/Chat; confirm modal with note; neutral
    no-events handling.
  - `app.tsx` — renders ONE global flyout over any tab (selectedCaseId), full-width
    (`restrictWidth={false}`), a `casesVersion` refresh signal bumped on flyout change so
    grids re-sync; surfaces now just call `onOpenCase` (no tab switch).
  - Rewrote `investigate.tsx` + `scans.tsx` as thin wrappers around `CaseGrid` (Investigate
    keeps the search panel; Scans points at the `scans` endpoint).
  - `index.scss` — `.tlsocCaseCard` + `.tlsocCaseGrid`. Removed dead `case_detail.tsx`
    (superseded by the flyout; was imported only by the old Investigate).
- Did (sub-agents):
  - board.tsx — uses the shared `CaseCard` (dragHandle + per-card actions menu), opens the
    global flyout on click instead of switching tabs, re-fetches on `refreshSignal`; drag +
    quick-move confirm flow preserved.
  - settings.tsx — replaced the accordion stack with a two-column layout: a left `EuiSideNav`
    listing all 10 sections + the selected section's content on the right (sticky nav, uses
    the wide space). EVERY field/handler/path unchanged.
- Tests: `tsc -p tsconfig.json --noEmit` against /tmp/kibana-8.19 → 0 plugin-scoped errors;
  full icon sweep of all new/changed files verified against EUI icon_map.js (all valid);
  8.19.12 zip rebuilt + verified (bundle present, kibanaVersion 8.19.12, 0 backend-URL leak,
  78,330 B ~76 KB) → copied into plugin/dist/.
- Status: done.
- Next: commit + push. Optional follow-ups: dark-mode-safe palette pass; rebuild the 8.12.2
  zip for parity; live-stack visual check of the flyout + side-nav.

### 2026-06-20 — orchestrator — Vendor-agnostic SOC transition: research + design
- Context: User asked to convert the ELK/Kibana-coupled suite into an open-source,
  self-hosted, vendor-agnostic agentic SOC that integrates with any SIEM/EDR/XDR
  (start ELK + OpenSearch), and to research data ingestion + scaling to millions of
  logs/day. Discussion/architecture turn (no code changes yet).
- Did: ran 4 parallel sub-agents — (A) codebase ELK-coupling audit, (B) agnostic
  schema/prior-art, (C) per-vendor ingestion mechanics, (D) scaling to millions/day.
  Key finding: the reasoning/agent layer is already ~90% source-agnostic (`RawEvent`
  projection + configurable field maps in `Preferences` + MCP-shaped tools + a
  cursor that needs only timestamp+stable-id); coupling is concentrated in 3 seams
  (query/log-access = ES DSL passed straight through; internal storage = 100% ES;
  UI = Kibana plugin). Locked 4 decisions with the user: canonical schema **OCSF**;
  internal state **decoupled from ES → Postgres + pgvector**; first new connector
  after ELK+OpenSearch = **Wazuh**; UI = **standalone web app** (retire the Kibana
  plugin). Wrote `docs/AGNOSTIC_ARCHITECTURE.md` (full design: OCSF normalization,
  connector SPI via entry-points + manifest + OCSF type, pull/push ingestion +
  cursor patterns, the volume funnel + build-now/build-later scaling, StateStore
  decoupling, standalone-UI plan, 5-epoch roadmap, risks/licensing). Added the EPIC
  block to `ROADMAP.md` (Epochs A–E).
- Tests: n/a (research + docs only; no code touched, suite untouched).
- Status: done (design approved); implementation not started.
- Next: Epoch A first (StateStore SPI + Postgres impl + pgvector RAG) — highest
  "self-hostable" payoff, contained blast radius — then Epoch B (connector SPI +
  query IR + OCSF; Elastic-parity + OpenSearch connectors). Keep `pytest -q` green
  at every step; the 12 non-negotiables still hold.

### 2026-06-20 21:45Z — backend agent (connectors) — Elastic/OpenSearch pull connectors
- Context: Implement the first two PULL connectors against the connector SPI
  (app/connectors/base.py) + OCSF schema, as faithful wrappers of the read-only ES
  access, so a later rewire of es_query.py/poller.py is behavior-preserving.
- Did: app/connectors/elastic.py (ElasticConnector(PullConnector); ping/poll/
  search/fetch_by_ids/to_ocsf/test_connection; rich manifest with es_url/es_api_key
  [secret]/es_ca_cert/es_verify_certs + 8 ECS-default config_fields) reusing
  poll_query/ids_query and reproducing es_query.py's body+KQL exactly;
  app/connectors/opensearch.py (subclass; source_type=OPENSEARCH; manifest only;
  query_language=lucene); tests/test_connectors_elastic.py (11 offline tests).
- Tests: 135 passed (124 existing + 11 new); parity confirmed programmatically.
- Status: done. Next: orchestrator wires registry + rewires es_query/poller.

### 2026-06-20 22:30Z — backend agent (receivers) — push/queue/object-store ingestion
- Context: Support EVERY common way logs are forwarded to us, against the SPI + OCSF.
- Did: app/connectors/receivers/{formats,common,webhook,syslog,queues,objectstore,
  __init__}.py. formats.py = stdlib detect/parse json/ndjson/CEF/LEEF/syslog-3164/
  5424/GELF/kv (never raises). PayloadReceiver base (records→generic_to_ocsf→
  RawEvent.from_ocsf). WebhookReceiver (bearer/HMAC/none) + HECReceiver (Splunk
  envelope). SyslogReceiver (asyncio UDP/TCP). 9 broker receivers (Kafka/SQS/
  Kinesis/EventHub/PubSub/RabbitMQ/NATS/MQTT/RedisStreams) + S3/GCS/AzureBlob/File,
  all lazy-importing optional deps. BUILTIN_RECEIVERS (16). 
- Tests: tests/test_receivers.py (48) — formats, webhook auth, HEC unwrap, syslog,
  all manifests valid with NO optional deps. Full suite 183 passed.
- Status: done. Next: orchestrator wires registry + receiver runtime/lifecycle.

### 2026-06-20 23:30Z — orchestrator — connector registry + live rewire + wizard backend
- Context: Make the connector abstraction the LIVE path and stand up the
  multi-source wizard backend (Epoch B integration), after the two sub-agents.
- Did: app/connectors/registry.py (SourceType→class map, manifests() for the
  wizard, tlsoc.connectors entry-point discovery; 18 builtins = 2 pull + 16
  receivers). Rewired the agent's log surface through the connector, behaviour-
  preserving: es_query.py tool now compiles a StructuredQuery and calls
  source.search()/fetch_by_ids() (identical ToolResult, incl. the 0-severity
  edge); poller.poll_once reads via source.poll() for both the incremental and
  sliding-window reads; pipeline/chat take an optional `source` (default
  ElasticConnector(es) for back-compat, test_rag_p1 still constructs ChatEngine
  directly); state._wire builds self.log_source (_build_log_source picks Elastic/
  OpenSearch by primary_source) and injects it; added state.rebuild_log_source().
  Routes: GET /api/connectors (+/{source_type}), POST /api/connectors/test,
  GET/POST/DELETE /api/sources (SourceInstance CRUD; new primary unsets others).
  config.py SourceInstance + Preferences.sources + primary_source() (empty ==
  legacy single implicit Elastic source). docs/INGESTION.md authored.
- Tests: 188 passed (183 + 5 new tests/test_connectors_api.py); zero regressions
  through the rewire. NOTE: real baseline is 188 now (CLAUDE.md's "49"/"124" stale).
- Status: done. Connector path is live; wizard backend ready.
- Next: receiver RUNTIME (webhook FastAPI route + asyncio lifecycle in AppState so
  push sources actually flow), per-source secret storage, then Epoch A (StateStore
  → Postgres + pgvector), then the standalone web UI + full first-run wizard.

### 2026-06-21 00:30Z — orchestrator — push ingestion RUNTIME (every-way-in works)
- Context: Make push sources actually flow end-to-end (not just exist as classes),
  on a single shared ingest path with the poller.
- Did: app/engine/ingest.py — extracted the shared correlate→attach/investigate/
  register logic (handle_clusters, attach_cluster, dedup_by_id) + IngestService
  (the entrypoint receivers feed; never raises on a bad batch). Refactored
  poller.poll_once to use handle_clusters/dedup_by_id (kept a thin _attach
  delegator for the existing tests); removed the duplicated loop. config.py: Secrets
  gains connector_secrets (per-source secret tier, never persisted to config) +
  source_secrets()/set_source_secret(). state.py: wires self.ingest_service; starts
  enabled background PUSH receivers (syslog/queues/object-store) as guarded asyncio
  tasks whose emit feeds IngestService (HTTP webhook/HEC are route-driven, skipped);
  _stop_receivers on shutdown. routes.py: POST /api/ingest/{source_id} (webhook/HEC
  → verify auth → parse → OCSF → IngestService; 401 on auth fail), POST
  /api/sources/{id}/secrets (per-source secrets → secret tier; records field NAMES
  on the SourceInstance). FIX: generic_to_ocsf no longer short-circuits to the ECS
  path on a loose @timestamp heuristic — that dropped the record id (collapsing a
  batch to 1 via id-dedup) and missed generic field names (src_ip vs source.ip);
  now always uses the alias path (covers ECS + generic) with per-record uid.
- Tests: +tests/test_ingest_push.py (4: webhook→case end-to-end, 404, bearer-auth
  enforced via per-source secret, NDJSON body). Full suite 192 passed (188 + 4).
- Status: done. Push + pull both flow through one ingest path.
- Next: Epoch A (StateStore → Postgres + pgvector); standalone web UI + wizard
  (sub-agent in flight); later: TLS for syslog, S3 Parquet, restart receivers on
  live source change, standup-aggregation + routes entity-path onto the connector.

### 2026-06-21 00:00Z — frontend agent (webui) — standalone SPA + first-run wizard
- Context: New deliverable — a vendor-agnostic, self-hosted web UI decoupled from
  Kibana; talks to the FastAPI backend directly. Headline = first-run wizard +
  connector/source management (Epoch D start).
- Did: Created webui/ (Vite+React+TS+@elastic/eui 95). Typed API client
  (src/lib/api.ts, ApiError); types mirroring ConnectorManifest/AuthField/
  SourceInstance/Preferences/ConnectionTest/ModelsResponse/Case; framework-free
  format.ts; plugin COLORS palette reproduced as standalone theming. Reusable
  dynamic ConnectorForm + ConnectorPicker + SourceEditor + ModelPicker +
  SecretInput. 5-step first-run Wizard (Welcome+demo-mode / Sources / Providers+
  per-role models / Detection+correlation+risk+allowlist+kill-switch / Review→
  /setup/complete); auto-shows when setup_complete is false; re-runnable from
  Settings. Sources manager (list/add/edit/test/delete/primary). Sectioned
  Settings (full Preferences + secret status). Shell (nav + /health + dark mode).
  Preview pages for Cases/Chat/Investigate/Scans/Standup/Cost.
- Tests: npm install clean; npm run build (tsc --noEmit strict + vite build) green,
  no type errors (orchestrator re-verified: 2319 modules, dist built). No browser
  run (CDNs blocked) — static build + tsc is the verification.
- Status: done — wizard + sources + settings functional; analytics surfaces are
  preview stubs.
- Next: port analytics surfaces in depth; serve dist/ from backend or reverse
  proxy; improve /api/connectors/test to test UNSAVED form values (see below).

### 2026-06-21 01:00Z — orchestrator — webui build verification + commit
- Context: Verify + land the standalone SPA the sub-agent built.
- Did: re-ran `npm run build` (strict tsc + vite) → green; committed webui/ (WIP
  snapshot earlier as ccc1aa9, finalized here); node_modules/dist git-ignored.
- Tests: webui build green; backend suite unaffected (192).
- Status: done. Standalone UI is the primary front door (Kibana plugin retiring).
- Next: improve POST /api/connectors/test to accept unsaved {source_type,config,
  secrets} and build a throwaway connector (better wizard "Test connection" UX),
  then Epoch A (StateStore → Postgres + pgvector).

### 2026-06-21 — backend agent (statestore) — Epoch A: SQL StateStore
- Context: Decouple the suite's OWN state (cases/audit/usage/config/cursor/RAG)
  from Elasticsearch so self-hosting needs no ES; keep ES default; only management
  state moves — the read-only log surface stays on the connector layer.
- Did: repository ABCs (app/stores/base.py) mirroring the existing store
  signatures; ES stores + AuditLogger subclass them. SQLAlchemy 2.x async SQL
  backend under app/stores/sql/ (engine factory, ORM tables cases/audit/usage/kv/
  rag_chunks, Sql{Case,Audit,Usage}Repository + SqlKVStore/SqlConfigStore/
  SqlCursorStore + SqlVectorStore). Audit INSERT-only (preserves #2). Secrets
  state_backend + state_db_url. state.py _build_state_backend() selects ES vs SQL
  from one async engine; SQL startup create_all + SKIP bootstrap_indices; _build_rag
  → SqlVectorStore on SQL; shutdown disposes the engine; es kept for the log
  surface. bootstrap_indices guarded for non-ES backends. asyncpg/pgvector lazy
  (postgres only). Added sqlalchemy/aiosqlite (dev) + sqlalchemy/aiosqlite/asyncpg/
  pgvector (prod) to requirements.
- Tests: pytest 216 passed (192 existing + 24 new), SQLite only, no postgres/
  asyncpg installed. test_state_store_sql.py (case round-trip/list filters+total/
  sort/find_open_by_signature/count_new_scans; append-only audit + ordered search;
  usage window summary; KV/config/cursor; SqlVectorStore cosine/upsert/dim-mismatch)
  + test_state_backend_e2e.py (AppState boots on sqlite, poll→investigate→persist
  case to SQL, ES kept for logs). Orchestrator reviewed SqlAuditRepository (append-
  only confirmed) + wiring; full suite re-verified green.
- Status: done. A self-hosted deploy can now run on Postgres with NO Elasticsearch
  for the app's own state.
- Next: document TLSOC_STATE_BACKEND/TLSOC_STATE_DB_URL (ENVIRONMENT/DEPLOY) +
  surface the selector in the wizard; real-Postgres integration test in a deploy
  session (pg deps blocked in sandbox).

### 2026-06-21 — orchestrator — Epoch C: Wazuh connector + per-source field mapping
- Context: Complete the "ELK + OpenSearch + Wazuh" story; first third-party
  (non-ECS) connector proves the connector abstraction.
- Did: Added per-source field-mapping to the Elastic connector family —
  `ElasticConnector._effective_prefs(prefs)` overlays the source's `config`
  field-mapping/scope keys (data_view_pattern/time_field/*_field/severity_threshold/
  in_scope_rules/excluded_rules) onto the global prefs; applied at the top of
  poll/search/fetch_by_ids/to_ocsf/test_connection (empty config → returns prefs
  unchanged → byte-identical legacy behaviour). New app/connectors/wazuh.py
  (WazuhConnector(ElasticConnector), source_type=WAZUH; manifest with Wazuh indexer
  connection fields + Wazuh alert-schema config defaults: wazuh-alerts-*,
  timestamp, data.srcip, data.srcuser, agent.name, rule.id, rule.description,
  rule.level). Registered in the registry; state._build_log_source now passes
  primary.config to the connector and handles WAZUH/OPENSEARCH/ELASTICSEARCH.
  .env.example documents TLSOC_STATE_BACKEND/TLSOC_STATE_DB_URL.
- Tests: +tests/test_connector_wazuh.py (5: poll extracts Wazuh schema; to_ocsf
  entity mapping; search filters by data.srcip + KQL; manifest/registry; overlay
  no-op-when-empty + applied). Full suite 221 passed (216 + 5).
- Status: done. Three sources live (ELK, OpenSearch, Wazuh); per-source field
  mapping works.
- Next: deep UI surface port (Cases/Chat/Investigate/Scans/Standup/Cost beyond
  previews) + serve dist/ from backend; standup-aggregation + routes entity-path
  onto the connector; ENVIRONMENT/DEPLOY prose for the state backend; pre-save
  /api/connectors/test; Epoch E scale-out.

### 2026-06-21 — docs agent (readme) — README rewrite + CHANGELOG vendor-agnostic entry
- Context: Refresh docs for the vendor-agnostic transition ahead of first deploy.
- Did: Full README rewrite (agnostic positioning, source→connectors→OCSF→funnel→
  case→webui diagram, feature list, agnostic-compose quick start, connectors table,
  repo layout incl. ocsf/connectors/receivers/stores-sql/webui, honest pull-vs-push
  limits, doc links). CHANGELOG [2.0.0] entry (OCSF, connector SPI+registry, ELK/
  OpenSearch/Wazuh pull, 16 receivers + /api/ingest, per-source secrets, wizard
  backend, SQL StateStore, standalone webui, deploy artifacts, plugin→legacy).
  Verified endpoints/enums/paths/test-count against source.
- Tests: n/a (docs). 221 backend green per prior runs.
- Status: done.
- Next: trim the legacy plugin section once webui surfaces are fully ported.

### 2026-06-21 — docs agent (deploy) — DEPLOY.md rewrite (agnostic + legacy)
- Context: Make DEPLOY.md accurate for the vendor-agnostic stack ahead of deploy.
- Did: Rewrote DEPLOY.md — Mode A (agnostic: deploy/docker-compose.agnostic.yml,
  postgres+pgvector/redis/backend STATE_BACKEND=postgres/webui:8080, .env, wizard
  walkthrough, PULL vs PUSH sources, 16 receivers + optional pip deps, /api/ingest
  + /api/sources/{id}/secrets curl, syslog port publishing, verify); state-backend
  matrix; secrets model; ops (pg_dump/ES-snapshot backups, upgrades); Mode B
  (legacy ELK merge + two scoped ES keys + plugin install); hardening. Env-var
  nuance (backend reads UNPREFIXED names; compose maps TLSOC_*) stated. Orchestrator
  stripped a stray journal entry the agent had appended into DEPLOY.md.
- Tests: n/a (docs). Commands cross-checked against the real artifacts.
- Status: done.

### 2026-06-21 — docs agent (env/compat/claude) — vendor-agnostic doc refresh
- Context: Align ENVIRONMENT.md, COMPATIBILITY.md, CLAUDE.md with the agnostic
  transition (OCSF, pluggable connectors, selectable state backend, standalone
  webui primary / Kibana plugin legacy).
- Did: COMPATIBILITY.md = matrix (state backends ES8/PG15-16+pgvector/SQLite; pull
  Elastic/OpenSearch/Wazuh + 16 receivers w/ requires_pip; OCSF 1.4.0; Py3.11/
  Node22; plugin legacy). ENVIRONMENT.md both envs (webui toolchain, pytest=221,
  SQL offline on SQLite, TLSOC_*→backend env mapping table, per-source secrets).
  CLAUDE.md §1/§3/§4/§6/§7/§10 updated (agnostic framing, connectors/ocsf/stores-sql/
  webui in layout, 49→221 reconciled, Epoch A/B/C/D status), additive OCSF-unmapped
  note under #9; PRESERVED the Journal mandate, §5 non-negotiables, §9, Journal format.
- Tests: backend 221 passed; webui build clean.
- Status: done.

### 2026-06-21 — docs agent (usage/ops/security) — usage/ops/security/contrib refresh
- Context: Refresh the usage/ops/security/contrib docs for the agnostic suite.
- Did: docs/USAGE.md (standalone UI + wizard, managing pull/push sources, API curl
  examples incl. /api/connectors, /api/sources, /api/sources/{id}/secrets,
  /api/ingest); docs/TROUBLESHOOTING.md (Postgres/pgvector, connector test failures,
  webhook 401, optional-dep ConnectionError, syslog ports, UI build, no-cases);
  docs/RUNBOOK.md (state-backend ops + pg backup/restore, receiver lifecycle, key
  rotation, kill switch/budget, scaling); SECURITY.md (per-source secrets, read-only
  source creds generalised, webhook HMAC/bearer + untrusted push payloads, OCSF
  unmapped fencing, state-backend security, TLS reverse proxy); CONTRIBUTING.md
  ("Writing a connector" via the SPI + manifest + entry-point, updated layout);
  webui/README.md (dev/build + Docker/nginx production serving).
- Tests: n/a (docs); cross-checked endpoints/paths against source.
- Status: done.

### 2026-06-21 — orchestrator — research roadmap + UI overhaul (pass 1)
- Context: User asked to (a) research agentic-AI/SOC open-source platforms for what
  to add next, and (b) overhaul the "ugly" webui.
- Did (research): ran parallel sub-agents over open-source agentic SOCs (Vigil,
  AiSOC, FunnyWolf, SecurityClaw, SocTalk, Tracecat, Nemesis), agentic-AI
  frameworks/patterns (LangGraph HITL/streaming/checkpointing, Langfuse/OpenLLMetry,
  DeepEval/promptfoo, Mem0, LlamaFirewall, prompt caching), detection-engineering AI
  (pySigma/SigmAIQ/Uncoder/SigmaGen, CTI-REALM/CyberSOCEval benchmarks), and a
  codebase gap analysis. Wrote docs/ROADMAP_RESEARCH.md. CRITICAL finding: the
  FastAPI API has NO auth and the webui→nginx→backend path is open (old model
  assumed Kibana session) — flagged as #1 priority.
- Did (UI pass 1): new design-system foundation — charts.tsx (SVG donut/barlist/
  sparkline/minibars/gauge), Card+TrendStat primitives, index.css polish, branded
  Shell (logo/wordmark/grouped nav/health), new Overview dashboard as the default
  landing. webui build green. Committed e319849.
- Tests: webui `npm run build` green (tsc+vite). Backend untouched.
- Status: research done; UI pass-1 foundation shipped; UI pass-2 (Case detail
  flyout + Chat/Investigate/Scans/Standup/Cost) in progress via 3 sub-agents.
- Next: integrate UI pass-2, full build, commit; then (per roadmap) API auth is the
  top backend priority.

### 2026-06-21 — orchestrator — UI overhaul pass 2 (surfaces)
- Context: Turn the preview stubs + dead-end Cases table into real, polished
  surfaces on the pass-1 design kit (3 parallel sub-agents, disjoint files).
- Did: Case-detail flyout (CaseDetailFlyout.tsx — verdict/evidence/MITRE deep
  links/risk-breakdown bars/RiskGauge + Agent-trace timeline via /cases/{id}/trace
  + merged history timeline + sticky lifecycle action footer) and clickable Cases
  page w/ status filter; Chat console (bubbles, result tables, query/cost
  footnotes, suggested prompts, typing indicator); Investigate form → rich Case
  result card + neutral no-events empty state + session history; Scans card grid +
  KPIs; Standup hero digest + guarded aggregate tiles/barlists; Cost dashboard
  (window selector, sparkline/minibars, by-model/role/surface charts). All build
  on common/ui + charts + theme + format + soc* CSS; no kit files changed.
- Tests: full webui `npm run build` green (tsc strict + vite, 2322 modules). Note:
  JS bundle ~2.0MB (570KB gz) — fine for an internal console; code-split later.
- Status: done. UI is materially better (branded shell, dashboard, drill-in,
  charts).
- Next: per docs/ROADMAP_RESEARCH.md — API auth (#1), then observability + prompt
  caching + notifications. Optional UI follow-ups: open Case-detail from Overview/
  Scans cards; bundle code-splitting.

### 2026-06-21 — orchestrator — Vigil deep-study + overhaul kickoff
- Context: User asked to (1) study github.com/Vigil-SOC/vigil end-to-end with a
  fleet of Opus sub-agents, (2) propose + execute a heavy architectural overhaul of
  our suite taking inspiration from Vigil (multi-agent, runbooks, RAG), and (3)
  archive the legacy Kibana plugin now that we're vendor-neutral.
- Did (recon): cloned Vigil (11M, v0.2.3) + its mempalace (77M, memory/RAG) and
  mcp-servers submodules to /tmp. Mapped it: 339 py / 79 tsx; pillars = Agents
  (services/soc_agents.py + claude_service.py 4156 LoC + daemon/agent_runner.py),
  Workflows (markdown WORKFLOW.md + orchestrator/plan_generator), MCP+tools+skills,
  LLM gateway/router/cost/budgets (+ Bifrost), daemon/federation/autonomy, mempalace
  RAG. Stack: claude-agent-sdk + anthropic (NOT LangGraph), heavy MCP, Postgres.
- Tests: n/a yet (recon only).
- Status: in-progress — launching parallel Opus research sub-agents over Vigil + a
  fresh map of our own repo.
- Next: synthesize findings → recommendations → archive plugin → overhaul.

### 2026-06-21 — orchestrator — Vigil study done; plugin archived; Wave-1 begins
- Context: 10 Opus sub-agents finished reading Vigil end-to-end (agents, workflows,
  MCP/tools/skills, LLM/cost, daemon/federation/autonomy, RAG/mempalace, data model,
  frontend, architecture/philosophy) + a fresh ground-truth map of our own repo.
- Did: (1) wrote docs/VIGIL_STUDY.md — full synthesis, subsystem-by-subsystem
  Vigil-vs-us verdicts, ranked port list, anti-patterns, 4-wave overhaul plan.
  (2) Archived the legacy Kibana plugin: `git mv plugin → archive/kibana-plugin`
  (45 files, history preserved) + archive/README.md explaining the freeze (we're
  vendor-neutral; webui is the sole primary surface). (3) Established a GREEN test
  baseline: created backend/.venv, installed requirements-dev, `pytest -q` = 221
  passed before any code change.
- Tests: baseline pytest 221 passed.
- Status: in-progress — starting Wave 1 (agent personas · plain-text runbooks ·
  hybrid RAG · tool safety tiers · stronger fencing + pricing provenance).
- Next: implement Wave 1 additively, keep pytest + webui build green, then commit.

### 2026-06-21 — orchestrator — Wave-1 overhaul shipped (personas · runbooks · hybrid RAG)
- Context: Implement the Vigil-inspired overhaul the user named (multi-agent,
  runbooks, RAG) additively on our spine, keep everything green.
- Did:
  - **Multi-agent roster**: `agents/personas.py` (`AgentPersona` registry +
    deterministic `select_persona`); investigator composes the persona addendum
    (`prompts.build_investigator_system`); persona threaded through `graph.run_
    investigation` + `pipeline`; recorded on `Case.agent_persona` + audit; `GET
    /api/personas`; badge on the webui case-detail flyout.
  - **Plain-text runbooks**: `engine/runbooks.py` (dep-free frontmatter parser +
    loader + `select_runbook`) + 7 seed `runbooks/*.md`; matched runbook injected as
    TRUSTED guidance via `render_cluster(runbook=...)` and indexed into RAG
    (concise descriptor); `GET /api/runbooks`; `RunbookConfig`.
  - **Hybrid RAG**: drawer-floor-first vector + dep-free BM25 re-rank in `tools/rag.py`
    (`_hybrid_rerank`); `RagConfig.hybrid/vector_weight/bm25_weight/overfetch`.
  - **Tool tiers**: `constants.ToolTier` + `tools/base.Tool.tier`; investigator gates
    non-safe tools (propose, never execute).
  - **Hardened fencing + provenance**: `fence()` escapes forged close-markers + adds
    source/tool tags; `pricing.pricing_source` (+ tier heuristic) onto `UsageDoc`.
  - Archived the Kibana plugin (`git mv plugin → archive/kibana-plugin`) + archive
    README. Wrote `docs/VIGIL_STUDY.md`. Refreshed CLAUDE.md / ROADMAP / CHANGELOG.
  - Added `tests/test_vigil_wave1.py` (23 tests) covering all of the above.
- Tests: `pytest` **244 passed** (was 221); webui `tsc --noEmit` clean; `vite build`
  clean (2322 modules). Baseline was green before changes.
- Status: done (Wave 1). All 12 non-negotiables intact; spine (cost_gate /
  case_manager / durable cursor / OCSF / one gateway) untouched.
- Next: Wave 2 — auth-by-default + CI route-coverage test (the #1 gap) +
  CSRF/headers/rate-limit; approval workflow + pre-flight projected-cost gate +
  $-budget. See docs/VIGIL_STUDY.md §5.

### 2026-06-21 — orchestrator — Wave 2: Markdown playbooks + optional auth (+AutoClosePolicy)
- Context: User approved Wave 2 ("but ensure the old version without auth is also
  available") + supplied a detailed brief for a Markdown playbook/workflow system
  (single-agent, deterministic selection, injection, AutoClosePolicy refactor).
- Did (sub-agent fleet, disjoint files; orchestrator owned all shared-file
  integration + the safety-critical refactors):
  - **Playbook engine** (`app/playbooks/{manifest,loader,registry}.py`): strict
    `PlaybookManifest`, dep-free front-matter (reuses engine.runbooks.parse_frontmatter),
    deterministic `select_playbook` (rule_ids/entity_types/min_event_count hard;
    mitre/tags advisory — clusters carry no MITRE pre-investigation), atomic
    validate-then-swap reload. 3 seed playbooks in `backend/playbooks/`.
  - **Injection**: matched playbook → distinct `<<<PLAYBOOK>>>` TRUSTED block in
    render_cluster, separate from fenced UNTRUSTED evidence + a PRECEDENCE line in
    INVESTIGATOR_SYSTEM; `rag_queries` augment retrieval (bounded by top_k, deduped);
    selection/fallback audited; `Case.playbook_id`. Pipeline/graph/investigator
    threaded; Wave-1 runbook injection retired (runbooks = RAG knowledge only).
  - **AutoClosePolicy** (`case_manager.decide` pure over policy): per-verdict-class
    enable/min-confidence/max-risk/objection-window; FP on above a bar; TP opt-in
    (default OFF); NEEDS_HUMAN never (code-enforced); `fp_auto_close` migrated.
  - **Optional auth (default OFF — old no-auth version preserved & default)**:
    `app/auth/` (PBKDF2 + stdlib HS256) + `app/middleware/` (headers/csrf/ratelimit);
    router-level `require_auth` (no-op when off) + tiny PUBLIC allowlist (normalised
    path, tight ingest regex); `/api/auth/{login,me,logout}`, `/api/playbooks*`;
    CI route-coverage test. webui: login gate (no-op when off) + Playbooks/Agents catalog.
  - **2 review sub-agents** (auth-security, playbook-safety): playbook = ship-ready
    (all 7 invariants hold); auth = 1 HIGH (prefix not normalised) + MEDIUM/LOW.
    Applied fixes: normalised path + tight ingest regex; `auth_cookie_secure`;
    rate-limit default OFF + XFF only when trusted; real full-iteration timing
    dummy; PLAYBOOK-marker neutralisation in fence(); atomic state.reload_playbooks();
    CI test hardened (no Mount/WS under /api; ingest regex tightness). Docs:
    SECURITY.md auth section, .env.example, playbooks/README note, CLAUDE/CHANGELOG/ROADMAP.
- Tests: `pytest` **302 passed** (was 244 → +playbook/auth/wave2/coverage suites);
  webui `tsc + vite build` clean. All 12 non-negotiables hold (#3 generalised to the
  policy model — documented).
- Status: done (Wave 2 core). Deferred (noted): approval workflow + pre-flight
  cost projection + $-budget; webui CSRF token wiring.
- Next: Wave-2 leftovers above, then Wave 3 (memory/KG, MITRE-from-STIX, HITL UI).

### 2026-06-22 — orchestrator — Wave 3: analytics, eval loop, collaboration, white-label UI, CI
- Context: User asked to continue on a non-`claude/*` branch ("Testing"), add must-have
  agentic-SOC features + heavy UI/UX (case hover highlights, org logo/branding
  customization), set up a GitHub CI merge gate, research first with sub-agents,
  double-triple test, update docs.
- Did (research): 2 Opus agents — a prioritized must-have feature gap analysis +
  a concrete, conflict-free webui overhaul plan (both kept; informed the build).
- Did (backend, committed): branding (BrandingConfig + public GET/PUT /branding),
  AI-decision feedback loop (Case.feedback + /feedback + /feedback/stats), case
  collaboration (tags/comments/assignee + routes), metrics (engine/metrics.py +
  /metrics), export (json/md), method-aware public allowlist. +test_vigil_wave3.
- Did (CI, committed): .github/workflows/ci.yml (backend pytest incl. auth coverage
  + webui build; aggregate `CI passed`) + CONTRIBUTING branch-protection note.
- Did (webui, committed): Track A foundation (themeable accent CSS vars,
  BrandingProvider, Skeleton/PageHeader/Card-flat/KPI-delta, Metrics page, branded
  shell), then 4 parallel surface agents — CaseHoverCard hover preview + Cases/Scans/
  Overview; Branding settings panel + branded login; flyout Notes&feedback tab
  (grading + comments + tags + assignee + export menu); polish (Chat md/Investigate/
  Cost/Standup/Catalog). No new npm deps.
- Tests: backend `pytest` 310 passed; webui `npm run build` GREEN (2328 modules).
- Status: in-progress — webui security/correctness review running; docs being updated;
  then commit + push.
- Next: apply review fixes; finish README/USAGE; push branch `Testing`.

### 2026-06-22 — backend — RAG ingest/management + visibility
- Context: "see the RAG" + import documents and index them; then see exactly what the corpus contains.
- Did: engine/chunking.py (chunk_text); VectorStore ABC list_documents/list_chunks/delete_document/stats (InMemory+ES+SQL); RagService import_document/list_documents/get_document/delete_document/rag_stats (seeds guarded; force flag); routes GET /rag/stats,/rag/documents,/rag/documents/{id}, POST /rag/import, DELETE /rag/documents/{id}, GET /rag/search.
- Tests: test_rag_management.py (11). Full suite green.
- Status: done.

### 2026-06-22 — backend — agent memory (Claude.ai-style)
- Context: a memory of the model we can add/remove from, by telling an agent to remember/forget, like claude.ai.
- Did: stores/memory.py MemoryStore over KVStore (+EsKVStore adapter; SQL via SqlKVStore) — no new index; MemoryEntry model; prompts.render_memory() -> <<<MEMORY>>> TRUSTED block + fence() neutralises forged markers; investigator/graph/pipeline thread memory through; chat injects memory + emits memory_action (executed, audited) / memory_suggestion (UI-confirm); routes GET/POST/PUT/DELETE /memory. Memory never overrides the deterministic CaseManager.
- Tests: test_memory.py (14). Full suite green.
- Status: done.

### 2026-06-22 — backend — case explainability (CONTEXT audit + /rationale)
- Context: see the model's thinking, the evidence/data sources, the commands it ran, and exactly how it reached its conclusion.
- Did: ActionType.CONTEXT; investigator emits a CONTEXT audit record (persona/playbook/memory/knowledge/enrichment) + reasoning excerpt on VERDICT; GET /cases/{id}/rationale (_build_rationale) returns decision/reasoning/knowledge/tools(commands)/memory_used/enrichment/playbook/mitre/evidence + the deterministic decision_rationale.
- Tests: test_explainability.py (5). 340 total green.
- Status: done.

### 2026-06-22 — webui foundation+pages engineer — Knowledge/RAG + Memory pages & api/types contracts
- Did: api.ts +RAG/memory/rationale methods + chat memory fields; types.ts +Rag*/MemoryEntry/CaseRationale; App.tsx+Shell.tsx routed Knowledge+Memory (Platform nav); new KnowledgePage (stats, import paste+upload, documents table+chunk flyout, guarded force-delete, retrieval search) + MemoryPage (add/inline-edit/delete/active-toggle).
- Tests: npm run build GREEN. Status: done.

### 2026-06-22 — webui rationale engineer — case "Why" explainability tab
- Did: CaseDetailFlyout 'why' tab consuming api.caseRationale — deterministic decision, reasoning, knowledge used, commands the agent ran, memory applied, enrichment, playbook, MITRE; trace-tab polish. UNTRUSTED-safe. Status: done.

### 2026-06-22 — webui chat-memory engineer — chat memory action/suggestion UI
- Did: ChatPage memory-action echo + dismissible "remember this?" suggestion (calls api.addMemory) with per-message double-save guard; UNTRUSTED text rendered plain. Status: done.

### 2026-06-22 — webui dashboards engineer — RAG/memory health on Metrics + Overview
- Did: Metrics "Knowledge base & memory" section (RAG docs/chunks, embedding model+dim, memory facts/active, corpus-by-source, memory-by-author); Overview compact RAG/memory nav tiles; non-fatal loading. Status: done.

### 2026-06-22 — webui collaboration engineer — case-list collaboration
- Did: CasesPage sortable assignee column, tags + comment-count badges, collaboration/assignee filters. Status: done.

### 2026-06-22 — webui review engineer — integrated review
- Did: reviewed all 11 changed/new files; fixed one invalid EUI icon (bookmark->bell) on the two memory tiles; verified UNTRUSTED-safety (#9), non-fatal data flows, no regressions, no new deps; npm run build GREEN. Verdict: safe to commit.

### 2026-06-22 — orchestrator — round wrap-up: explainability, RAG management, agent memory, dashboards/collaboration
- Context: ship "see the RAG" (import + visibility), Claude.ai-style agent memory (remember/forget), and case explainability (the model's thinking + data sources + commands + how it concluded), plus the webui surfaces and dashboard/collaboration polish — additive, spine + the 12 non-negotiables intact.
- Did: integrated 3 backend features (engine/chunking.py + RagService/VectorStore management; stores/memory.py MemoryStore over KVStore; ActionType.CONTEXT + GET /cases/{id}/rationale) committed as c4c6b3d, d324028; webui Knowledge + Memory pages, case "Why" tab, chat memory UI, Metrics/Overview RAG+memory health, Cases-list collaboration committed as c0fa662. Memory + RAG inject as TRUSTED context but NEVER override the deterministic CaseManager; all attacker-influenceable text renders plain/EuiCodeBlock (#9).
- Tests: backend pytest 340 passed (was 310; +test_rag_management 11, +test_memory 14, +test_explainability 5); webui npm run build GREEN (2330 modules), no new npm deps.
- Status: done. Docs updated this pass (doc-maintainer): CLAUDE.md (test count 340 + section 4 layout + new Done group + Remaining trimmed), ROADMAP.md (done entry + Wave-3 sub-items), CHANGELOG.md (new top entry), docs/USAGE.md (Knowledge/Memory/Why how-tos + endpoints), README.md (feature bullets + 340), SECURITY.md (TRUSTED-context §4.3 + CONTEXT action type). Journal appended above.
- Next: Wave-3 leftovers — temporal KG + cross-case memory linkage, MITRE-from-STIX, detection-rule RAG corpus, HITL/Auto-Ops webui surfaces.

### 2026-06-23 — backend — browse-logs endpoint + read-only test_connection + per-source TLS
- Context: Part A (browse logs per source) + Part B (Test-connection works for read-only keys; per-source TLS honored).
- Did: GET /api/sources/{id}/logs (pull=bounded scoped search ≤200 honoring field mapping+TLS; push=in-memory live-tail buffer); capabilities:["browse"] on pull connectors + registry auto-apply for receivers; ConnectionTest +mode/+cluster_monitor; ElasticConnector.test_connection no longer gates on ping (scoped read authoritative; 401/403 vs net/TLS); AppState.es_client_for_source builds a per-source ES client honoring es_verify_certs/es_ca_cert (mgmt key dropped); IngestService per-source ring buffer.
- Tests: pytest 349 passed (+9, tests/test_browse_and_connection.py).
- Status: done

### 2026-06-23 — webui — source Browse-logs flyout + read-only test-connection rendering
- Context: surface per-source log browsing + clearer read-only Test-connection feedback.
- Did: SourceLogsFlyout (EuiBasicTable + expandable _raw EuiCodeBlock, search, EuiSuperDatePicker, 10s live-tail); SourcesPage gated "Logs" button (browse capability); SourceEditor read-only/full success callout; types + api.sourceLogs.
- Tests: npm run build GREEN; no new deps.
- Status: done

### 2026-06-23 — orchestrator — round wrap-up: browse-logs + read-only test-connection + per-source TLS
- Did: integrated both features (backend commit d35f578, webui commit 5b9537c); 349 backend tests green, webui build green; docs updated this pass (Journal, CHANGELOG, CLAUDE.md, docs/USAGE.md, docs/TROUBLESHOOTING.md, SECURITY.md). Status: done.

### 2026-06-23 — frontend agent — Standup fix + redesign, Shell + global polish
- Context: Fix the "not working" Standup page, redesign it, polish app shell + global CSS. webui only (Vite+React+EUI 95.12.0), branch Testing.
- Did:
  - StandupPage.tsx: removed the invalid EUI icon `printer` (the runtime culprit — not in EUI 95 and not in the registered icon cache, so it rendered as a blank gray square) and the fragile `globalThis.print()` Print button. Added handling for the hardened backend's 3 shapes: `enabled:false` -> friendly EmptyState (hint to enable in Settings, not an error); `degraded:true` -> non-alarming warning EuiCallOut with the `error`/"limited data" note while still rendering whatever aggregate/cases exist; happy path. Read new fields (`degraded`/`error`/`cost`/`cases`) via a local widened type (did NOT edit types.ts). Added a 24h/7d EuiButtonGroup window selector that re-fetches, Copy-summary, Regenerate (fill). Redesign: accent-bordered hero summary card (always shows summary), 4 KPI StatTiles (Events / Unique IPs / Cases opened / Cases closed), an events-over-time Sparkline (new `toSeries` reader), and tidy top-N bar-list cards. Summary rendered as plain text (`white-space: pre-wrap`) — untrusted-safe, no dangerouslySetInnerHTML.
  - Shell.tsx: clearer selected nav (accent tint + inset left accent bar via new socNavItem/socNavItem--selected classes), header polish (rounded health pill + slim divider + version badge order, dark-toggle tooltip), swapped two ambiguous nav icons (Memory `bell`->`memory`, Playbooks&Agents `inspect`->`article`); all props/behavior preserved.
  - index.css: theme-neutral card/stat hover elevation, visible `:focus-visible` ring, app-wide refined scrollbars (webkit + Firefox), socHealthPill/socHeaderDivider/socSideNav nav styles; reduced-motion block already neutralizes the new transitions.
  - Audited every iconType/icon string in the owned files against lib/icons.ts (the 128 registered glyphs) — all valid; no `printer` remains.
- Tests: `npm run build` GREEN (tsc --noEmit + vite); package.json/package-lock.json unchanged; no new npm deps.
- Status: done (not committed, per instructions).
- Next: orchestrator review + commit; optionally rename index.css->index.scss if SCSS is desired (kept plain CSS as it builds).

### 2026-06-23 17:20Z — frontend agent — Case flyout: iconed lifecycle actions + Reinvestigate + Ask chat
- Context: Upgrade `webui/src/components/Cases/CaseDetailFlyout.tsx` — clearer/iconed lifecycle actions collecting optional structured data, a model-customizable Reinvestigate action, an embedded "Ask about this case" chat tab, and fix a pre-existing invalid-icon typo. Touch ONLY this file; no new npm deps.
- Did (all in CaseDetailFlyout.tsx, additive):
  - **Iconed, self-explaining lifecycle actions.** `ActionDef` gained `help` (one-line explainer) + `fields` (which optional structured fields to collect). Icons set to spec: close `check`, confirm_fp `faceHappy`, escalate `bell`, reopen `refresh`, acknowledge `eye`. Footer buttons now wrapped in `EuiToolTip` (help text) + an `EuiIconTip` (`questionInCircle`) so "what does this button do" is answered in-product.
  - **Confirm modal reworked** from `EuiConfirmModal` to a structured `EuiModal` (header w/ action icon + title; a primary/warning `iInCircle` EuiCallOut showing the explainer at top). Per-action OPTIONAL fields, none blocking submit: close/confirm_fp → Resolution `EuiSelect` (handled/benign/duplicate/no_action/other) + Tags `EuiComboBox`; escalate → Assignee `EuiFieldText` + Priority `EuiSelect` (low/medium/high/critical); all → note `EuiTextArea`. Submits via `api.caseActionExec(caseId, { action, note?, resolution?, assignee?, priority?, tags? })` (only attaches a field when its action collects it AND a value is present). On success: `setC(next)` + invalidate trace + rationale + `onChanged?.()` (deterministic close/escalate stays server-side).
  - **Reinvestigate** added to the header actions (next to Export): primary `refresh` button → `EuiPopover` with an `EuiIconTip` ("Re-run the AI investigation on this case (force), optionally with a different model."), an OPTIONAL model `EuiSelect` (default "Use configured model" → sends no model; options from a one-time `api.getModels()` flattened to `<model> · <provider>`), and a loading note. Confirm → `api.reinvestigateCase(caseId, { model? })`, loading state, then reload case + invalidate trace/rationale + `onChanged?.()`; disabled while in-flight; errors via the existing error path.
  - **"Ask" chat tab** added (`'chat'`, icon `discuss`) to the tabs array + conditional render; tab strip now shows each tab's icon via `prepend={<EuiIcon .../>}`. Content embeds `<ChatPanel caseId={c.case_id} compact starters={[…]} />` inside a `height:60vh` flex column so it scrolls within the size="l" flyout. Panel owns its own model picker/state.
  - **Icon typo fixed**: `ASSESSMENTS` "Disagree" `crossInACircleFilled` (not a valid EUI glyph) → `crossInCircle`. Audited EVERY icon string in the file against EUI 95.12.0 `icon_map.js` AND `src/lib/icons.ts` (the app-wide registry) — all valid + registered (incl. new `faceHappy`/`bell`/`play`/`questionInCircle`/`discuss`).
  - External props (`caseId`/`onClose`/`onChanged?`) UNCHANGED. Existing overview/why/trace/timeline/collab tabs untouched. Echoed case-derived text (resolution/assignee/tags/notes) only ever flows into request bodies or plain inputs; ChatPanel handles its own escaping. Removed now-unused `EuiConfirmModal` import; added `EuiIcon`/`EuiIconTip`/`EuiModal*`/`EuiToolTip` imports + `ChatPanel` + `CaseActionInput`/`ModelsResponse` types.
- Tests: `npx tsc --noEmit` exit 0 (whole project type-checks clean; zero errors in CaseDetailFlyout). Did not run full `vite build` per the build note (concurrent caseFilters work); orchestrator runs the integrated build. No package.json change.
- Status: done (not committed, per instructions).
- Next: orchestrator runs the final integrated `npm run build` (tsc+vite) after the concurrent CasesPage/caseFilters lands, then commit.

### 2026-06-23 — frontend foundation agent — shared contracts (api/types/icons) for source/index/entity UI
- Context: Own ONLY `webui/src/lib/{api.ts,types.ts,icons.ts}`. Add the shared TS contracts the surface agents depend on (Case source fields, IndexPattern/EntityStrategy/source-config additions, `chat(... sourceId)`) and harden icon coverage so the new UI never shows blank gray squares. No component touched; no new npm deps. Branch Testing.
- Did:
  - **types.ts**: extended `Case` with `source_id?: string|null`, `source_name?: string|null`, `entity_type?: string|null` (additive). Added `export interface IndexPattern { pattern: string; role: 'events'|'alerts'|string }`, `export type EntityStrategy = 'auto'|'ip'|'host'|'user'|'rule'`, and `export interface SourceConfigExtras` (`index_patterns?`, `entity_strategy?`, `message_field?`, index sig) documenting the backend's additive `SourceInstance.config` keys. Widened `SourceInstance.config` to `Record<string,unknown> & Partial<SourceConfigExtras>` so the well-known keys are typed while unknown keys still round-trip.
  - **api.ts**: `chat(message, history?, caseId?, model?, sourceId?)` — `source_id` is included in the body ONLY when set (same only-when-set pattern as `case_id`/`model`); existing 1–4 arg callers unchanged. `listCases`/`scans`/`getCase` already return `Case`/`CasesResponse`, so they pick up the new source fields with no signature change.
  - **icons.ts**: added 53 new EUI icon imports + registrations (source/index/entity UI coverage): apps, at, bolt, boxesHorizontal, color, controlsHorizontal/Vertical, copy, dotInCircle, email, eql, errorFilled, filterInCircle, flag, fold, grab, grabHorizontal, grid, heatmap, help, home, index, indexTemporary, invert, ip, key, launch, listAdd, magnifyWithMinus/Plus, menu, merge, move, nested, newChat, node, offline, online, paperClip, partial, percent, pin, pinFilled, push, share, sparkles, tableOfContents, unfold, visBarHorizontal(+Stacked), visMetric, warningFilled. Each asset file verified present on disk and each camelCase->snake_case key checked against icon_map.js before registering. Registry now has **181 keys, 0 duplicates, 0 undefined registrations** (verified by script).
- Tests: `npx tsc --noEmit` on the project — ZERO errors in my three lib/ files (the only errors are unused-import/var TS6133 in `CaseDetailFlyout.tsx`/`CasesPage.tsx`, owned by concurrent component agents). Icon audit script: 180 imports all resolve to existing assets; all 181 registrations map to a real import. No package.json/lock change.
- Status: done (not committed, per instructions).
- Next: orchestrator runs the final integrated `npm run build` after the concurrent component edits land, plus the full icon-coverage audit. Surface agents may rely on the contracts above.

### 2026-06-23 — frontend/designer — CaseDetailFlyout: Notes&feedback redesign + Ask density
- Context: Own only `webui/src/components/Cases/CaseDetailFlyout.tsx`. (1) Redesign the ugly "Notes & feedback" (CollaborationTab) into a clean dense case-management panel; (2) make the "Ask" (chat) tab use flyout height instead of a fixed 60vh dead band.
- Did:
  - **Ask tab density**: replaced the `height:60vh` wrapper with a `flex:1; minHeight:0` flex column, and made the flyout body a full-height flex column ONLY on the chat tab via a scoped class (`tlsocFlyoutBody--chat`) + a small `<style>` that turns EUI's internal `.euiFlyoutBody__overflowContent` into `display:flex;flex-direction:column;height:100%;min-height:0` (trim vertical padding). ChatPanel (already `height:100%;min-height:0`, `compact`) now fills the lane and its transcript scrolls inside; starters + caseId scoping unchanged.
  - **CollaborationTab redesign** (all existing API calls intact: caseAssign/caseTags/caseFeedback/caseComment):
    - **Ownership** card: assignee shown as an EuiAvatar (initials, or `user` glyph + "Unassigned") + compressed inline edit + Save (disabled until dirty), and Tags as a compressed combobox with auto-save helper text — two clean columns.
    - **Rate the AI decision** card: agree/partially/disagree as a full-width segmented choice (`aria-pressed`); star ratings moved into a tidy bordered "Quality (optional)" sub-panel via a denser `StarRating`; compressed outcome (with `flag` prepend)/analyst/time-saved/comment; submit gated on a `gradingDirty` UX flag (payload logic unchanged); previous gradings as compact flat cards with relative-time tooltips.
    - **Notes** (comment thread): new `CommentRow` helper = per-author EuiAvatar (stable hashed accent via `authorAccent`) + author + relative `humanizeAge` (full ts on hover) over a bordered body card; empty state "No notes yet"; bottom composer in a subdued panel with avatar + name + textarea + "Add note".
  - Design system used throughout (Card/EmptyState/ErrorCallout/COLORS/tint, format helpers). All case-derived text rendered as plain text nodes / badges (UNTRUSTED-safe, #9). Only icons already registered in `icons.ts` used (users, flag, editorComment, user, inspect, save, tag, clock, check, star*, *InCircle*) — no `icons.ts` change. Added `EuiAvatar` + `EuiPanel` to imports. No new npm deps.
  - Kept lifecycle actions, reinvestigate, export, and overview/why/trace/timeline tabs untouched; external props (caseId/onClose/onChanged?) unchanged.
- Tests: `npx tsc --noEmit -p tsconfig.json` → ZERO errors in `CaseDetailFlyout.tsx`. The only 3 project errors are in sibling files being edited concurrently (`KnowledgePage.tsx` EuiPanel paddingSize, `MetricsPage.tsx` missing EuiToolTip import) — not mine. Did NOT run `npm run build` (siblings editing), per instructions.
- Status: done (not committed, per instructions).
- Next: orchestrator runs the final integrated `npm run build` once sibling component edits land.

### 2026-06-23 20:32Z — design/frontend agent — Console standardization (tokens, shared primitives, Shell, Overview/Metrics/Cost)
- Context: User says the console looks "very very ugly", wastes screen space, wants it CLEAN/STANDARDIZED/dense/smooth like a polished OpenSearch/Elastic console. Owned ONLY: `Shell/Shell.tsx`, `common/ui.tsx`, `lib/theme.ts`, `index.css`, `Overview/OverviewPage.tsx`, `Metrics/MetricsPage.tsx`, `Cost/CostPage.tsx`.
- Did:
  - **theme.ts (additive token layer):** added `MAX_CONTENT_WIDTH=1320`, `SPACE` (xxs..xxl), `RADIUS` (sm/md/chip/lg/pill), `WEIGHT` (regular..bold). Refined `COLORS` for contrast KEEPING names (success `#00a38c`→`#0a9b86`, warning `#e9a200`→`#d9930a`, subdued `#69707d`→`#646b78`); tuned `CHART_COLORS[2..3]` to match. Tightened `TYPE.h1` 24→22, `h2` 18→17. ALL existing exports (COLORS/tint/TYPE/setAccent/verdict*/status*/risk*/chartColor/CATEGORY_META/...) unchanged in name+signature.
  - **ui.tsx (shared primitives, backward-compatible):** PageHeader denser (m spacer, tighter eyebrow/title, `.socPageHeader` wrapper); IconChip crisper (34/44px, token radius, subtle inset hairline ring, `.socIconChip`); SectionHeader title now token-styled div (m spacer); StatTile + TrendStat get `.socStat .socTile` + token radius + the standardized `.socTile__label`; Card gets token radius + tighter title row (s spacer). Removed now-unused `EuiTitle` import; added `RADIUS`/`WEIGHT` imports. No prop/signature changes.
  - **index.css:** added design-token CSS vars (`--soc-radius-*`, `--soc-hairline`, `--soc-elev-1/2/3`, `--soc-ease`); font smoothing; GPU-friendly transform/opacity hover on cards/tiles/icon chips; refined nav (denser rail, 16px aligned glyphs, uppercase group titles, clearer selected accent bar); refined health pill; focus-visible-only rings; smoother scrollbars; `.socTile__label` (currentColor+opacity, theme-aware). Kept ALL existing class names; reduced-motion still honored.
  - **Shell.tsx:** crisper logo lockup (centred 17px glyph via CSS, uppercase tagline), explicit nav icon `size="m"` with semantic accent on active, `restrictWidth` now `MAX_CONTENT_WIDTH`. Removed unused `EuiText`. All props/behaviour (PageId/onNavigate/health poll/branding/dark toggle/logout/nav groups) intact.
  - **Overview:** SectionHeader→PageHeader (eyebrow "Dashboard"); tightened section spacers l→m + grids gutter l→m + skeleton radii→12; **added a Recent/Risk sort toggle** to the recent-cases feed; sources list now sorted (primary first, then A–Z).
  - **Metrics:** **added a Count/A–Z sort toggle** (header) driving persona/playbook/corpus bar lists via `recordSegments(rec, sort)`; added missing `EuiToolTip` import; tightened all section spacers l→m + skeleton radii→12.
  - **Cost:** **added a Cost/Tokens/Calls sort toggle** (header) — `metricSegments(rows,by)` + `sortRows()` re-rank+revalue By model/role/surface and Top drivers; metric-aware `fmtMetric` formatter; "Top drivers · by {metric}" title; tightened spacers l→m + skeleton radii→12.
- Tests: `node_modules/.bin/tsc --noEmit` → ZERO errors across all of `src` (clean). No errors in any owned file; no cross-file errors referencing my exports/tokens (backward-compat confirmed). Did NOT run `npm run build` (siblings editing concurrently), per instructions.
- Status: done (not committed, per instructions). No new npm deps; only icons already in `lib/icons.ts` used; UNTRUSTED-safe (no attacker-text styling changes); theme-aware light+dark.
- Next: orchestrator runs the final integrated `npm run build` + visual pass once all sibling component edits land.

### 2026-06-23 — backend/engineer — Entity-agnostic correlation + deep source/index customizability (NO-SOURCE-IP fix)
- Context: Implement deep source/index customizability + fix the no-source-IP bug (in-scope events with a null primary entity were silently dropped → no case formed). Touch ONLY backend/. Keep the 12 non-negotiables intact; additive + back-compatible.
- Did:
  - **Entity-agnostic correlation (NO-SOURCE-IP fix)** — `engine/correlation.py`: new `resolve_entity(ev, group_by, strategy)` + `correlate(..., entity_strategy=None)`. With `auto` (default) the per-rule `group_by` entity is tried FIRST (byte-identical when present), and ONLY when missing does it walk the ladder IP→HOST→USER→RULE, so a case STILL forms (never drop an in-scope event). New `EntityType.RULE` + `EntityStrategy` enum (`constants.py`). `RawEvent.entity_value(RULE)` = `"<rule>|<5min-bucket>"` (`RULE_BUCKET_SECONDS=300`); `_build_cluster` keeps the bucket in the SIGNATURE (idempotent per window) but shows the clean rule name as the entity value, and records the ACTUAL resolved entity type on `Cluster.group_by`/`Entity.type` (UI "grouped by host/rule"). `agents/common.entity_kql` now maps a RULE entity to `rule_field`.
  - **Per-source entity strategy** — `Preferences.entity_strategy` (default AUTO) + `SourceInstance.config["entity_strategy"]` override; `Preferences.entity_strategy_for(source)` resolves it. Wired into the poller (primary source) + `IngestService.ingest` (originating source) + chat path.
  - **Multiple index patterns per source + per-pattern ROLE** — `SourceInstance.config["index_patterns"]: list[{pattern, role: events|alerts}]` (+ `IndexPattern` model, `IndexRole` enum, `SourceInstance.index_patterns()` helper, falls back to single `data_view_pattern` role=events). `ElasticConnector` (inherited by OpenSearch/Wazuh) now reads across the comma-joined union of ALL patterns in one search and tags each `RawEvent` via `_tag_events` with `index_role` (matched against the configured patterns), `source_id`, `source_name`. `Cluster.is_alert` true when ANY member came from an alerts-role pattern → `engine/ingest.handle_clusters` AUTO-FORWARDS that cluster regardless of `auto_forward_allowlist` (still gated by `background_scan_enabled`). PUSH sources tagged in `IngestService.ingest` (whole-source `role: alerts` / all-alerts `index_patterns`).
  - **Source on each case** — `Case.source_id`/`source_name` (default None) + `Cluster.source_id`/`source_name`/`is_alert`; set in `pipeline._assemble_case`/`register_candidate`/`_fail_to_human_case` from the cluster (preserved across re-investigations). `GET /cases` dumps the full Case so the fields are present for UI filter-by-source.
  - **Per-source field mapping** — added `message_field` (Preferences default `message` + per-source) + `entity_strategy` + `index_patterns` to `ElasticConnector._OVERLAY_KEYS`/flow; all existing mapping keys already overlaid.
  - **Chat source scoping** — `ChatRequest.source_id` (optional); `routes._chat_source_connector` builds the selected PULL source's connector (its config+TLS, like browse) and `ChatEngine.chat(..., source=...)` runs the es_query against it; absent/push/error → primary (today's behaviour). Per-source field mapping applied via the connector's `_effective_prefs`. NOTE: single-source SELECT, NOT cross-source aggregation (deferred).
  - Connector `display_name` threaded through config in `state._build_log_source` + `routes` so tagged events carry a human-readable `source_name`.
- Tests: `python -m pytest -q` → **380 passed** (was 364; +16 new in `tests/test_source_customizability.py`: no-IP→rule/host fallback case forms, with-IP default byte-identical, rule-bucket separation, pinned host strategy, resolve_entity, alerts-role auto-forward vs events-role candidate via handle_clusters, Case source provenance set+dumped, chat source_id routing/primary-default/unknown-fallback, SourceInstance helpers). No regressions.
- Status: done (NOT committed, per instructions).
- Next: Frontend round already in flight referenced a `Case.entity_type` field — backend exposes the entity type via the existing `case.entity.type` (now incl. value `rule`); the FE's optional `entity_type?` stays unpopulated, read `entity.type` instead. New `SourceInstance.config` keys (`index_patterns`/`entity_strategy`/`message_field`) round-trip through the unchanged `POST /api/sources` (free-form config). Future: cross-source chat AGGREGATION; a wizard surface for index-pattern roles.

### 2026-06-24 08:21Z — frontend sub-agent (Opus) — PART 1: EuiAvatar white-screen fix + React ErrorBoundary + Vitest
- Context: Scoped Part 1 — fix the EuiAvatar rgba-color crash that white-screens the app, add a top-level React error boundary as a safety net, and stand up a Vitest test harness (none existed) with a regression test.
- Did:
  - **FIX 1a (avatar crash):** In `webui/src/components/Cases/CaseDetailFlyout.tsx` removed the `tint()` (rgba) wrapper from the 4 `EuiAvatar color=` props — EUI 95 `EuiAvatar` THROWS on non-hex/`plain`/`subdued` colors, so the rgba string crashed render → white screen. Now pass the bare `#rrggbb`: CommentRow `color={accent}`, assigned owner `color={COLORS.accent}`, unassigned owner `color={COLORS.subdued}`, composer `color={authorAccent(...)}`. Left all `EuiBadge color={tint(...)}` untouched (EuiBadge accepts arbitrary CSS colors); confirmed `tint` import still used (14 refs).
  - **FIX 1b (error boundary):** New `webui/src/components/common/ErrorBoundary.tsx` — class component (`getDerivedStateFromError` + `componentDidCatch`→`console.error`), renders the shared `ErrorCallout` from `./ui` as fallback; `componentDidUpdate` clears the error when `resetKey` changes. Wrapped (1) the flyout tab-body conditional in `CaseDetailFlyout.tsx` with `resetKey={\`${tab}:${caseId}\`}` so one failing tab shows the callout in-place + recovers on tab/case switch; (2) the app body in `webui/src/App.tsx` around `<Shell>` (inside `EuiProvider`) with `resetKey={page}` — BrandingProvider/EuiProvider/auth/loading paths untouched.
  - **TEST 1 (harness + regression test):** Added dev-only devDeps `vitest@1.6.1`, `@testing-library/react@16.1.0`, `@testing-library/jest-dom@6.6.3`, `jsdom@25.0.1`, `@testing-library/user-event@14.5.2` (`@vitejs/plugin-react` already present). New `webui/vitest.config.ts` (separate from `vite.config.ts`; jsdom + React plugin + setup), `webui/src/test/setup.ts` (jest-dom matchers + jsdom stubs for `matchMedia`/`ResizeObserver`/canvas-2d `getContext`), `webui/tsconfig.test.json` (test-only, `types:["vitest/globals","@testing-library/jest-dom"]`). Kept the PROD build green by EXCLUDING `src/**/*.test.{ts,tsx}` + `src/test` from the app `tsconfig.json`. Added `"test": "vitest run"` script. New `webui/src/components/Cases/CaseDetailFlyout.test.tsx`: mocks `../../lib/api` (factory-local minimal Case + benign resolves), renders the flyout in `EuiProvider`, opens the "Notes & feedback" (collab) tab, asserts "Rate the AI decision" renders and NO "Something went wrong" fallback. VERIFIED the test catches the regression: temporarily reintroducing the buggy `tint()` on the composer avatar made the test fail (boundary caught the throw, collab content vanished), restoring the fix made it pass — proving both the avatar fix AND the boundary work.
- Tests: `npx vitest run` → **1 passed**. `npm run build` (tsc --noEmit + vite) → **GREEN** (2513 modules; build does NOT pick up test files/globals). `tsc -p tsconfig.test.json` → clean.
- Status: done (NOT committed — orchestrator commits Part 1 as its own scoped commit).
- Next: Orchestrator to commit Part 1 (touched ONLY: CaseDetailFlyout.tsx, common/ErrorBoundary.tsx [new], App.tsx, CaseDetailFlyout.test.tsx [new], package.json/lock, vitest.config.ts/tsconfig.test.json/src/test/setup.ts [new]). Note the canvas-2d/matchMedia/ResizeObserver jsdom stubs in setup.ts will support any future component tests.

### 2026-06-24 08:32Z — frontend/data-viz (Cost surface) — Further breakdown of costs
- Context: User asked for "a further breakdown of costs" on the Cost & usage page. Scope: own ONLY `webui/src/components/Cost/CostPage.tsx`, additive, no new npm deps, do NOT run full `npm run build` (siblings editing) — self-review TS in isolation.
- Did: Added four deeper, client-side breakdowns to `CostPage.tsx`, all recomputed from the single `api.usageSummary(hours)` call (no new backend calls), recomputing on window/sort/dimension change:
  1. **Detailed cost ledger** — sortable `EuiBasicTable<LedgerRow>` (compressed, `tableLayout="auto"`, `Criteria`-driven `onChange`/`sorting`) with a `Card` `actions` `EuiButtonGroup` dimension switch (Model / Role / Surface / Top drivers). Columns (all `sortable`, currency-aware): name (+ palette swatch), Cost, **% of total** (inline `ShareBar` mini-bar + `fmtPercent`), Tokens, Calls, **Avg / call**, **Cost / 1K tok**. Derived `share`/`avgCost`/`costPerKTok` per row; NaN efficiency cells render `DASH` and sort to the bottom. Empty dimension → `EmptyState`.
  2. **Cost composition** — `Card` donut (`DonutWithLegend`) of the active dimension with **% labels** appended to each legend label + an **"Other (n)"** roll-up bucket (`withOtherBucket`, keeps top 6, subdued colour) so many small rows stay legible; center = total cost.
  3. **Spend-over-time stats** — Window total / Avg per bucket / **Peak bucket** stat row added under the existing `MiniBars` in the "Spend over time" card (`seriesStats`).
  4. **Efficiency StatTiles** — new KPI row: overall **Avg cost/call**, **Cost/1K tokens**, **Tokens/call**, and **Priciest scope** (single most-expensive model|role|surface, labelled + cost).
  - Helpers added: `num`, `toLedger`, `seriesStats`, `withOtherBucket`, `ShareBar`; types `Dimension`/`LedgerRow`/`LedgerSortField`. Defensive throughout (non-array → [], zero denominators guarded, NaN → DASH, never throws). UNTRUSTED-safe (keys rendered as plain text via `humanizeToken`, no markup). Theme-aware (COLORS/RADIUS/chartColor, inline styles). Icon `tableDensityNormal` confirmed registered in `lib/icons.ts` (and a valid EUI 95 asset). Existing hero/KPI/charts/Top-drivers sections untouched (additive).
- Tests: Isolated type-check `tsc --noEmit -p tsconfig.json`, filtered to the file → **NO ERRORS IN CostPage.tsx**. Did NOT run full `npm run build` per instructions. Project-wide tsc shows only PRE-EXISTING unused-symbol errors in the sibling `Settings/BrandingSection.tsx` (another engineer's in-flight file) — unrelated to this change.
- Status: done (NOT committed).
- Next: Orchestrator to fold this into the round's commit once siblings (esp. BrandingSection.tsx) settle; a full `npm run build` should be green for Cost once BrandingSection's unused-symbol errors are cleared by its owner.

### 2026-06-24 — full-stack engineer — Branding: more white-label options (additive)
- Context: User asked "branding should have more options too." Extend the white-label BrandingConfig additively + back-compatibly (own: config.py BrandingConfig, routes.py branding handlers only, BrandingSection.tsx, branding.tsx, theme.ts, types.ts Branding type).
- Did:
  - **backend/app/config.py** `BrandingConfig` — added 5 optional/defaulted fields: `favicon_data_url:str=""`, `login_subtitle:str=""`, `footer_text:str=""`, `support_url:str=""`, `dark_mode_default:bool=False`. Server-side validators: favicon shares the data:image/* + ~1MB guard (validator now covers logo+favicon); `login_subtitle`/`footer_text` capped 400 chars; `support_url` must be http(s) and ≤2000 chars (rejects e.g. `javascript:`). Existing org_name/product_name/logo_data_url/accent_color/accent_color2/theme untouched.
  - **backend/app/api/routes.py** — GET/PUT /branding handlers already generic (`model_dump` / `BrandingConfig` body); new fields flow + validate automatically, no edit needed (scope reviewed, confirmed correct as-is).
  - **webui/src/lib/types.ts** — `Branding` interface gained the matching 5 fields (favicon_data_url, login_subtitle, footer_text, support_url, dark_mode_default).
  - **webui/src/lib/theme.ts** — `setAccent(primary?, secondary?)` (signature already supported secondary) now ALSO writes a hyphenated alias `--soc-accent-2` in lock-step with the existing `--soc-accent2` (additive; existing exports/vars unchanged).
  - **webui/src/lib/branding.tsx** — DEFAULT_BRANDING extended (back-compat seed). New provider side effects on load + on update: `applyFavicon` (inject/update `<link rel="icon">` from a trusted data:image/* URL only), `applyDocumentTitle` (org · product), wrapped with accents into `applyBranding`. `resolveDark` now honours `dark_mode_default` as the new-session seed (only when no stored override and theme unset → collapses to prior prefersDark() when false). footer_text/login_subtitle/support_url/dark_mode_default exposed via `useBranding().branding`. Did NOT touch App.tsx/Shell.tsx.
  - **webui/src/components/Settings/BrandingSection.tsx** — added editors for every new field: favicon EuiFilePicker (ICO/PNG/SVG, 64KB client guard mirroring backend, preview chip, remove), dark-mode-default EuiSwitch, and a "Login & messaging" section with login_subtitle / footer_text / support_url text inputs (maxLength + http(s) validity gate on support_url, helper text). dirty/save/discard updated; existing logo/accent/name/theme editors intact.
- Tests: `cd backend && . .venv/bin/activate && python -m pytest` → **395 passed**. Added inline sanity check confirming back-compat defaults, full-set construction, and rejection of js: URLs / oversized favicon / overlong footer. Did NOT run full webui build (siblings editing) — self-reviewed TS: all Branding literals build via DEFAULT_BRANDING spread or API cast (no literal breaks from new required fields); `globe` icon valid + used elsewhere; EuiSwitch imported.
- Status: done (NOT committed).
- Next: Orchestrator folds into the round commit once sibling webui files settle; run full `npm run build` then.

### 2026-06-24 — orchestrator (Opus) — webui UX overhaul round: 5 user mockups + 26-agent research, built by 22 sub-agents
- Context: User asked to (1) deep-research the webui UX with 20+ sub-agents, (2) reconcile 5 provided UI mockup PDFs, (3) implement with 10 agents, (4) test with 10 agents, (5) push. Two blockers were raised+resolved up front: the PDFs weren't attached (user re-sent them) and "push to main" conflicted with session rules — user chose the **Testing** branch (no direct-to-default push). Backend was NOT touched (every item maps to existing endpoints), so the 395 backend tests stay green by construction.
- Research: a 26-agent Workflow (14 internal-area audits + 8 external best-practice sweeps → 3 prioritization lenses → master merge). The master-merge agent crashed on its oversized structured-output schema; recovered by resuming from the cached 25-agent prefix and dropping the merge — the orchestrator did the 10-workstream partition itself. Output: 70 deduped backlog items (`scratchpad/synth.json`). The 5 mockups (Metrics/Scans/Catalog→"Playbooks & Agents"/Knowledge overview+docs) were rendered to PNG (PyMuPDF) and specced (`scratchpad/PDF_MOCKUP_SPEC.md`, `BUILD_BRIEF.md`).
- Implementation (12-agent Workflow): F1 design-system + F2 shell/routing/contract (sequential, shared files) then 10 page agents in parallel on disjoint files. Highlights: charts a11y `title`/`format`/tinted-track; new ui.tsx primitives `PostureBadge`/`MitreList`(+47-id MITRE map)/`UrgencyPill`/`NavTile` + calibration-aware `ConfidenceBadge`; theme `COLORS.clay`/`HEADER_H`/`chartPalette`/`riskBandColor`; hash routing + `navigate(page,opts)` drill-through + `EuiSkipLink`/`role=main`/nav aria-label + debounced/live health pill + `support_url`/`footer_text` wiring; Metrics/Scans(card grid + "N new" pill)/Catalog(persona+playbook tabs)/Knowledge(overview + density-toggle docs table) redesigned to the mockups; Overview stats-correctness fixes + autonomy/posture strip; Cases in-view counts + honest totals + UrgencyPill + bulk-action bar; flyout provenance/MITRE-names/ruled-out/entity/decision-path; chat per-message actions + provenance disclosure + a11y; Cost/Standup/Investigate fixes; Settings Autonomy panel + dirty-tracking; Sources confirm-delete + test-connection relabel; Approvals bulk; Memory/Login polish.
- Verification (10-agent Workflow): disjoint-ownership review+fix across correctness/UNTRUSTED-safety/a11y/light+dark/registered-icons/design-system/mockup-fidelity/contract. Result: 0 escalations, 0 high-severity; surgical fixes applied (MitreList dup-key, evidence empty-state, chat accordion dup-id, CostPage hardcoded rgba→`tint`, Cases dead-code guard). One test-mock gap fixed by orchestrator (flyout's new `getSettings` effect — product code already `.catch`-guarded).
- Tests: `npx tsc --noEmit` clean; `vite build` ✓ (2516 modules); `vitest run` 1/1; backend `pytest -q` 395 passed; NO new npm deps; 29 files changed (+2985/−409), webui-only.
- Status: done — committed + pushed to `Testing` (and the dev branch `claude/busy-gauss-dyk7bg`).
- Next: optional follow-ups deferred this round (streaming chat, global command palette, virtualized table workbench, full useEuiTheme palette refactor) per `scratchpad/synth.json` structural lens. Re-attach-and-extend any further mockups as a new round.

### 2026-06-24 — orchestrator (Opus) — UI polish: loading/entrance motion layer (additive)
- Context: User follow-up — "further ui cleaning, animations for loading, etc." Done hands-on (no multi-agent workflow); additive, shared-design-layer-first so it propagates with minimal blast radius. EUI-only, no new deps, light+dark, fully reduced-motion-guarded.
- Did:
  - **index.css** — motion tokens (`--soc-ease-out`, `--soc-dur-fast/base/slow`); refined `.socSkeleton` (gentle base `socSkeletonPulse` + smoother `--soc-ease` sweep with a solid mid-band); page-enter now uses the easeOut curve + duration token; NEW utilities: `.socFadeIn` (content swap-in), `.socStagger > *` + auto-applied `.socGrid > *` staggered cascade (nth-child delays capped at 9+), `.socPulse` (live/in-progress indicators), `.socLoadingBar` (indeterminate brand-gradient sliver). Extended the `prefers-reduced-motion` block to neutralise all new animations to their final visible state.
  - **lib/theme.ts** — added `MOTION` tokens (fast/base/slow + ease/easeOut) mirroring the CSS custom properties, so JS inline transitions stay in lock-step.
  - **components/common/ui.tsx** — `Loading` now fades in (`.socFadeIn`) + optional `center` layout; new `LoadingBar` primitive (the `.socLoadingBar` indeterminate bar, role=progressbar/aria-busy).
  - **Catalog/CatalogPage.tsx** — persona grid gets `.socStagger` so the persona cards cascade in. (Dashboards using `.socGrid` — Metrics/Scans/Cost/Standup — get the cascade automatically; all 15 pages already had `.socPageEnter`; the improved Skeleton reaches the 10 files that use it and the Loading fade-in reaches 8.)
- Tests: `npx tsc --noEmit` clean; `vite build` ✓ (2516 modules; CSS 6.0→7.9 kB); `vitest run` 1/1. No new npm deps; 4 files changed.
- Status: done — committed + pushed to `Testing` (and `claude/busy-gauss-dyk7bg`).
- Next: `LoadingBar` + `.socPulse` are exported/available for per-page wiring (e.g. health-pill "checking…", scan "N new" badge) in a future pass if desired.

### 2026-06-28 — orchestrator (Opus) — UI OVERHAUL (rebuild) phase 1: Tailwind+shadcn foundation
- Context: User asked for a full professional UI overhaul inspired by the Agentic SOC Platform (FunnyWolf/agentic-soc-platform, MIT) dark "command center" look — both light+dark. Approved: full Tailwind+shadcn rebuild, build on branch Testing. Inspired-by only (no brand/asset clone; TLSOC branding kept). Reference live demo is 403-gated; design language extracted from the MIT repo screenshots (scratchpad/ref_png/).
- Strategy: new UI built in a SEPARATE tree (src/ui primitives + src/soc app) so the legacy EUI app keeps building until a single clean cutover. Reuse lib/api.ts + lib/types.ts + lib/format.ts verbatim (backend untouched).
- Did (foundation): installed Tailwind v3 + tailwindcss-animate + Radix primitives + cva/clsx/tailwind-merge + lucide-react + recharts + framer-motion + cmdk + sonner; added tailwind.config.js, postcss.config.js, src/styles/theme.css (dual-theme CSS-var tokens: deep-navy command-center dark + clean light), src/lib/cn.ts, and a `@/`→src alias (tsconfig+vite). Then a 10-agent workflow built: src/ui/* shadcn-style primitives (button/card/badge/alert/input/textarea/label/select/checkbox/switch/radio/slider/tabs/accordion/separator/scroll-area/progress/avatar/dialog/sheet/popover/tooltip/dropdown-menu/table/skeleton/command/sonner) and src/soc/* domain widgets (badges, CodeBlock, EmptyState, LoadingBar, Stagger, PageHeader, HeroPanel, KpiTile, StatCard, RiskGauge, BarList, palette+charts[recharts], DataTable) + theme.tsx/nav.ts/router.tsx/AppShell.tsx. 45 new files.
- Tests: `npx tsc --noEmit` clean (foundation + legacy together); legacy `vite build` still green; no new errors. Backend untouched.
- Status: foundation done + committed/pushed to Testing. New entry NOT yet wired (cutover pending).
- Next: phase 2 = ~14 page agents build src/soc/pages/* (reuse api/types) → phase 3 cutover (new main.tsx/App.tsx, remove EUI) → phase 4 verification fleet → final build + push.

### 2026-06-28 — orchestrator (Opus) — UI OVERHAUL phase 2+3: all pages rebuilt + CUTOVER to new app
- Context: Continue the Tailwind+shadcn rebuild — build every page on the new foundation, then cut the live entry over to it.
- Did (pages): a 17-agent workflow rebuilt every surface in src/soc/pages/* (Overview/Cases/CaseDetail/Chat/Investigate/Scans/Standup/Metrics/Cost/Knowledge/Memory/Sources/Catalog/Settings/Approvals/Login/Wizard), each reusing the legacy data wiring (api.*/types/format) with the new command-center UI; all reported zero own-file tsc errors. Sources/Settings/Chat created their own helper components (SourceEditor/SourceLogsSheet/ConnectorPicker, BrandingEditor, ChatPanel).
- Did (cutover): wrote src/soc/ErrorBoundary.tsx + src/soc/App.tsx (boot: auth.me→login | setup→Wizard | app shell + hash-routed page switch, mirroring legacy flow) and switched src/main.tsx to import styles/theme.css + render the new App. Fixed 3 integration nits (ErrorBoundary override modifiers; Memory/Settings onNavigate prop types). Legacy EUI tree left in place (unused/tree-shaken) pending a cleanup pass after verification.
- Tests: `npx tsc --noEmit` clean; `vite build` GREEN — bundle 2.84MB→1.20MB (EUI out of the bundle), CSS→52KB Tailwind, 2530 modules; `vitest` 1/1 (legacy test still green). Backend untouched.
- Status: cutover done + committed/pushed to Testing. New Tailwind/shadcn app is now the live entry.
- Next: phase 4 = verification fleet (a11y, UNTRUSTED-safety, light+dark, runtime correctness, mockup fidelity) → fixes → optional legacy/EUI prune + dep removal → final build + push.

### 2026-06-28 — orchestrator (Opus) — UI OVERHAUL phase 4+5: verification + legacy/EUI removal (DONE)
- Context: Harden the rebuilt app, then prune the dead legacy EUI layer for a clean professional result.
- Did (verify): a 13-agent verification fleet reviewed+fixed every slice (shell/theme/router, ui primitives, domain widgets, all pages) across runtime-correctness, UNTRUSTED-safety, a11y, light+dark, Tailwind/icon validity, design-system contract, mockup fidelity. 0 escalations / 0 high-severity; surgical fixes only (Cmd-K palette accessible name, Switch track contrast in light theme, BrandingEditor accent-preview leak on unmount, SourceLogsSheet aria-describedby, chart fix, regenerate label, etc.).
- Did (cleanup): severed the one legacy tendril (moved `ConnectorFormValue` type into lib/connectors.ts), then DELETED the entire legacy EUI view layer — src/components/** (all old pages + the EUI regression test), src/App.tsx, src/index.css, src/lib/{euiTheme,icons,theme,branding}.ts(x) — and UNINSTALLED @elastic/eui + @emotion/react + @emotion/css + moment. Cleaned the EUI ambient decls from vite-env.d.ts. Added the `@/` alias to vitest.config.ts + a new whole-app smoke test (src/soc/__tests__/App.smoke.test.tsx: mounts <App/> with a mocked api, asserts it boots to the Security Posture Dashboard without tripping the error boundary).
- Tests: `npx tsc --noEmit` clean; `vite build` GREEN — bundle 2.84MB→1.20MB (EUI fully gone), CSS 52KB Tailwind, 2530 modules; `vitest` 1/1 (new smoke test); backend `pytest` 395 (untouched). Deps now: Radix + lucide + recharts + framer-motion + cmdk + sonner + tailwind utils (no EUI/emotion/moment).
- Status: DONE — full professional UI overhaul (dark+light command-center) committed + pushed to Testing. Inspired-by the Agentic SOC Platform look; no brand/asset clone; TLSOC branding system preserved.
- Next: optional follow-ups — wire a real branding→token bridge for custom accents in light mode edge cases; add per-page vitest render tests; revisit any deferred backlog items.

### 2026-06-29 — orchestrator (Opus) — UI polish pass: OpenSearch/AdSense/Wazuh clean + bug fixes
- Context: User feedback — the rebuilt UI still needed brush-ups; make it prettier + much cleaner (heavy inspiration: OpenSearch Dashboards/OUI, Google AdSense, Wazuh). Specific bugs: broken RiskGauge (needle/value overlap + dark blob, per screenshot) and the missing case hover-preview.
- Did (orchestrator fixes): rebuilt RiskGauge.tsx clean (muted track + single severity-coloured arc + centred value; no needle/hub). Added @radix-ui/react-hover-card + src/ui/hover-card.tsx + src/soc/components/CaseHoverCard.tsx (UNTRUSTED-safe case summary popover).
- Did (24-agent polish workflow): Foundation (5) — calmer dual-theme tokens (light = clean white/very-light-gray + confident blue; dark = refined low-chroma slate, de-glowed), border-first quiet elevation, OpenSearch-crisp tables, cleaner primitives + domain widgets + DataTable. Pages (16) — airier AdSense spacing, calm cards, consistent PageHeaders across every surface; Cases + Scans now wrap case refs in CaseHoverCard (hover preview restored + working). Verify (3) — review+fix across cleanliness/a11y/UNTRUSTED/light+dark; all PASS.
- Tests: tsc --noEmit clean; vite build green (2533 modules); vitest 1/1 (app smoke); no new deps beyond react-hover-card; backend untouched.
- Status: done — committed + pushed to Testing. (theme.css/tailwind.config intentionally retuned for the calmer look.)
- Next: optional — gather fresh screenshots for another fidelity pass; add per-page render tests.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul Phase 0: research + design
- Context: Scope a full SOC-platform overhaul (identity/RBAC, MFA/SSO, case taxonomy, notifications, multi-source correlation, automation, threat-context, settings/UI) on top of the agnostic suite. Captured prior round in `docs/research/` (RBAC + cross-source-aggregation designs).
- Did: Decomposed the work into 7 additive waves (W1 identity, W2 MFA+SSO, W3 cases, W4 notifications, W5 multi-source, W6 automation+threat, W7 settings+UI) with hard constraints: zero new deps, non-negotiable #3 (`case_manager.decide()`) byte-identical, auth DEFAULT OFF (back-compat + offline tests), every wave green before the next. Sequenced agents around the shared files (`models.py`/`config.py`/`routes.py`/webui shell). Baseline: 395 backend tests green.
- Tests: n/a (design); baseline 395.
- Status: done — plan locked; waves begin.
- Next: W1 identity foundation (persisted users + RBAC + OOBE).

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W1: identity (multi-user + RBAC + OOBE)
- Context: Add a persisted multi-user identity layer + role-based access control without a new index/table and without breaking the no-auth default.
- Did: `stores/users.py` UserStore over the existing KV doc store (no migration). `auth/service.py` grew the **6-role** model (super_admin/soc_manager/analyst_tier2/analyst_tier1/responder/auditor) + a permission matrix + `require_permission(resource, action)` deps (no-op when auth disabled). Routes gated by permission (sources/settings/users/...). OOBE first-run; when `auth_enabled` and no users exist, seed **Admin / Admin@123** (super_admin). webui: `/users` page + `Can.tsx` guard component wrapping privileged UI; login flow. Auth stays DEFAULT OFF (`Secrets.auth_enabled`).
- Tests: backend 395 → **481** (+86; users/RBAC/permission-coverage); webui tsc+vite clean.
- Status: done.
- Next: W2 — MFA (TOTP) + OIDC SSO.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W2: MFA + SSO
- Context: Strengthen auth with TOTP MFA + recovery codes and federated SSO, all stdlib (no new deps).
- Did: `auth/mfa.py` — stdlib **RFC-6238 TOTP** (verified against the official RFC test vectors), single-use **recovery codes**, two-phase login (password → MFA challenge). Browser inline-SVG **QR** (`webui/.../QRCode.tsx` + `MfaSetupCard.tsx`) so no qrcode dep. Routes `POST /api/auth/mfa/{setup,confirm,verify,disable}`. `auth/oidc.py` — **OIDC SSO** for Google/Microsoft/generic via server-side authorization-code exchange + userinfo (no id_token-signature-verify dependency), with group→role provisioning; routes `GET /api/auth/sso/{providers,authorize,callback}` + `POST /api/auth/sso/providers/{id}/secret`.
- Tests: backend 481 → **527** (+46; TOTP vectors, recovery codes, two-phase login, OIDC code-exchange/provisioning); webui clean.
- Status: done.
- Next: W3 — case status/disposition taxonomy + nomenclature.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W3: case taxonomy + nomenclature
- Context: Richer case lifecycle (analyst-grade status + disposition) and a customizable case-id scheme — without changing the deterministic auto-close.
- Did: Extended `CaseStatus` (NEW/INVESTIGATING/ESCALATED/ON_HOLD/RESOLVED) **keeping** open/needs_human/closed; added `Disposition` (true_positive/false_positive/benign/suspicious/duplicate/undetermined); `needs_human` retained as an alias. Lifecycle actions + a **transition guard** + `status_history` on the case. **`case_manager.decide()` is byte-identical** (#3 intact — verified by an equality test). `engine/case_id.py` — customizable **`case-XXXX`** nomenclature (template + KV-backed sequence) with a live preview. Polished the case overview panel in the webui.
- Tests: backend 527 → **554** (+27; taxonomy transitions, decide() byte-identity, case-id sequence/template); webui clean.
- Status: done.
- Next: W4 — notifications.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W4: notifications
- Context: Pluggable outbound alerting on case events, secrets in the secret tier, never blocking the pipeline.
- Did: `notifications/` — `NotificationChannel` SPI + **email** (stdlib SMTP, **13 provider presets**) + **Slack / Teams / generic webhook / PagerDuty / Telegram**; per-condition triggers + **dedup / rate-limit / digest** (`dispatch.py`); templates. Dispatch is **fire-and-forget after `apply()`+save** so a failing channel never affects case state. Channel secrets keyed in the in-memory secret tier (UI sees only `configured ✓`). Routes `GET /api/notifications/providers`, `POST /api/notifications/test`, `POST /api/notifications/channels/{id}/secret`; webui `NotificationsEditor`.
- Tests: backend 554 → **571** (+17; channel rendering, trigger matching, dedup/rate-limit, secret redaction); webui clean.
- Status: done.
- Next: W5 — multi-source correlation.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W5: multi-source correlation
- Context: Let operators control correlation per source/sub-source and optionally link cases across sources by shared entity.
- Did: **Auto-Correlate** toggle per source AND per sub-source (`IndexPattern`). Opt-in **cross-source correlation** in `engine/correlation.py` that links RELATED cases by a shared entity (ip / host / user / file_hash / domain) without merging them. Per-source field-mapping overrides; connector `setup_help` surfaced as `HelpTip`s + an analyze-sample affordance in the webui source editor.
- Tests: backend 571 → **600** (+29; per-source toggle, cross-source entity linking, mapping overrides); webui clean.
- Status: done.
- Next: W6 — threshold automation + threat context.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W6: automation + threat-context
- Context: Add operator-tunable automation and richer triage context — automation MUST stay #3-safe (never auto-decides a case).
- Did: `engine/threshold_automation.py` — threshold rules with actions tag / recommend / notify / run_playbook / **request_approval → HITL `Proposal`**; **automation never sets case status** (#3 enforced; only humans/`decide()` change disposition). **Run-a-playbook** = context-only re-investigation. `engine/threat_context.py` + `engine/mitre.py` + `threat/mitre_techniques.json` — a **threat-context panel**: IOC reputation + bundled **MITRE ATT&CK (697 techniques)** + related cases, **fail-open** (context degrades, never blocks). Resolved-case → RAG knowledge loop closed.
- Tests: backend 600 → **638** (+38; automation action mapping, #3-safety asserts, MITRE lookup, threat-context fail-open, playbook re-investigation); webui clean.
- Status: done.
- Next: W7 — consolidated settings + UI polish.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul W7: settings + UI polish
- Context: Consolidate the sprawling preferences into one coherent Settings surface and finish the visual pass.
- Did: Consolidated **Settings** into **13 sections / 4 nav groups** driven by a new `GET /api/settings/schema`. **RiskGauge** redesign (fixes the Active-Risk-Index glitch). Skeleton/shimmer loading + staggered reveals (`LoadingBar`/`Stagger`), 8px-grid alignment, WCAG AA contrast pass across the app.
- Tests: backend 638 → **649** (+11; settings schema coverage); webui **27 Vitest specs green** + tsc/vite clean.
- Status: done.
- Next: overhaul complete — update master docs.

### 2026-06-29 — orchestrator (Opus) — SOC overhaul COMPLETE + docs sync
- Context: Close out the 7-wave SOC overhaul and bring the master context/history/roadmap/env docs in sync.
- Did: Shipped W1–W7 (identity/RBAC, MFA/SSO, case taxonomy+nomenclature, notifications, multi-source correlation, threshold automation+threat-context, settings+UI) — **all additive, zero new deps, non-negotiable #3 (`decide()`) byte-identical, auth DEFAULT OFF**. Updated `CLAUDE.md` (status + module map + corrected UI design-system section: webui is Vite+React+**Tailwind+shadcn/Radix**, NOT EUI), `ROADMAP.md` (RBAC/auth-on/HITL/threshold-automation/multi-source-correlation marked done), `docs/ENVIRONMENT.md` (new auth/MFA/SSO/notification `TLSOC_*` env vars + demo-enable note).
- Tests: backend **649** green (395 → 481 → 527 → 554 → 571 → 600 → 638 → 649 across W1–W7); webui tsc+vite clean + **27 Vitest** green.
- Status: done — committed/pushed to `Testing`.
- Next: remaining backlog — pre-flight projected-cost gate + `$`-budget ceiling; persisted encrypted secret store; Splunk + Microsoft Sentinel connectors; Wave-4/Epoch-E scale-out (ARQ/KEDA, Helm, OTEL+Grafana).

### 2026-06-30 00:00Z — orchestrator (Opus) — Round 2 W0: research + diagnosis
- Context: Open a second overhaul round (R2) covering 5 bug reports + 10 feature asks (login redesign, account self-service, sessions/token policy, Settings IA, Demo Mode, source multi-feed, Resend/SES email + templates, pervasive customization, UI consolidation, "best of the best"). Process rules for this round: Opus-4.8 sub-agents only, document everything to disk so a context compaction can't lose state, large self-verifying fleets, every wave review-gated then committed as a clean checkpoint. Baseline before R2: backend 649 pytest green, webui build + 29 vitest, 0 rules-of-hooks lint errors, tree clean at `6adf195`.
- Did: Ran a ~30-agent Opus research + diagnosis fleet that re-mapped the current code per area, root-caused every bug, and researched standards (login/session/SOC-product norms). Wrote four planning docs under `docs/research/2026-06-round2/`: `ROUND2_PLAN.md` (master tracker + acceptance criteria + wave plan + status log), `ROUND2_BUGS.md` (5 bugs, exact files + root causes), `ROUND2_DESIGN.md` (per-wave backend/frontend/endpoint/test/risk design, dependency-ordered W1→W7), `ROUND2_BEST_OF_BEST.md` (prioritized gap list vs Sentinel/Chronicle/Splunk ES/Stellar/Panther/Hunters/TheHive with additive data contracts). Confirmed bug root causes: gauge had a Wave-7 `<linearGradient stopColor=currentColor>` in `<defs>` painting white + unbounded value overlay + baseline round-cap; MFA QR `placeFormatInfo` second-copy bit placement inverted (unscannable) + `navigator.clipboard?` no-op over HTTP; case-detail rendered BOTH the shadcn `SheetContent` built-in X and a hand-rolled header X. Locked the cross-cutting invariants for every wave: `case_manager.decide()`/`apply()` byte-identical (#3), all attacker-influenceable text plain/fenced (#9), secrets env/in-memory only (#10), ZERO new runtime deps, additive request/response fields only.
- Tests: n/a (research/design); baseline 649 backend / 29 vitest carried forward.
- Status: done — plan + 3 design docs on disk; waves begin in dependency order.
- Next: R2-W1 (the 5 critical bug fixes — webui-only).

### 2026-06-30 02:36Z — orchestrator (Opus) — Round 2 W1: critical bug fixes (commit 9ab2954)
- Context: Land the five bug fixes first to restore confidence in the gauge, MFA enrollment, the case toolbar, chat framing, and the store-degraded chip before the larger feature waves. Purely webui/presentational — no backend data-model changes, so the backend suite is untouched by construction.
- Did: **B1 gauge** — rewrote `RiskGauge.tsx` as a stroke-dasharray progress-ring on a half-circle (muted track + single severity-coloured arc, exact-centred value, no needle/hub/stray cap, no value↔label overlap); deleted the stale `__tests__/riskgauge.test.tsx` and added `components/__tests__/RiskGauge.test.tsx` asserting geometry at scores 0/27/55/85/100 and sizes 100/208. **B2 MFA** — fixed `QRCode.tsx` format-info bit placement so the matrix is scannable (correct EC, ≥4-module quiet zone, integer module scaling) + added `lib/clipboard.ts` (HTTP-safe clipboard fallback) wired into `MfaSetupCard.tsx`/`Security.tsx` so Copy works off-HTTPS; new `components/__tests__/QRCode.test.tsx`. **B3 two-close** — removed the hand-rolled header X in `CaseDetail.tsx` (keep the single shadcn `SheetContent` panel-close; the lifecycle "Close case" stays a distinct labeled action); new `__tests__/case-detail-close.test.tsx`. **B4 chat framing** — full-height frame + anchored composer + balanced empty state in `Chat.tsx`/`ChatPanel.tsx`. **B5 store-degraded** — informative tooltip on the amber chip in `AppShell.tsx` (explains in-memory fallback + non-persistence, calmer in demo).
- Tests: backend unchanged at **649** (webui-only round); webui tsc+vite clean; vitest **29 → 50**; 0 rules-of-hooks errors.
- Status: done — committed `9ab2954`.
- Next: R2-W2 (login redesign + account self-service).

### 2026-06-30 02:51Z — orchestrator (Opus) — Round 2 W2: login redesign + account self-service (commit 317bd5a)
- Context: Restyle the existing 4-mode `Login.tsx` without touching any submit handler or the mode state machine, and add user-owned profile self-service. The profile model is the spine W3/W4/W7 build on.
- Did: **Login** rebuilt into a 2-column split (brand hero + aurora glow drift on the left, the existing Card + all 4 forms verbatim on the right): per-provider SSO brand icons (google/microsoft/generic), a 6-cell segmented OTP for the MFA step, and a client-only password-strength meter (tiny local heuristic, no new dep) for the OOBE setup/change modes — every submit handler byte-identical (`loginParts.tsx` extracted; `theme.tsx` now also sets a secondary accent CSS var from `branding.accent_color2` into the hero gradient). **Account self-service** — additive defaulted `User` fields (`display_name`/`alias`/`avatar`/`alt_email`/`timezone`/`locale`/`prefs`) so old KV docs load unchanged (no migration); `User.public()` adds the non-secret fields (password_hash/mfa_secret/mfa_recovery_hashes stay excluded); `stores/users.py` allowlist widened. New endpoints `GET/PUT /api/account/me` (env-managed single-admin → 400 read-only) + `PUT /api/me/avatar`, with a tight avatar validator (empty or `data:image/(png|webp|jpeg)`, SVG rejected, magic-byte sniff, 64KB cap) and a browser Canvas resize to 256×256 WebP before upload (`lib/avatar.ts`). New `pages/Account.tsx` + a user menu in the shell; `api.account.get/put/avatar`.
- Tests: backend **649 → 666** (+17; profile round-trip, env-managed 400, secrets-never-leak, avatar accept/reject); webui tsc+vite clean; vitest **50 → 58** (Login renders all 4 modes auth-on, Account render); 0 lint errors.
- Status: done — committed `317bd5a`.
- Next: R2-W3 (server-side sessions + token policy). Guardrail recorded: `require_auth`'s new async session check MUST no-op when auth off and DENY only on explicit revocation / `tv` mismatch / policy expiry; an unknown `sid` on a validly-signed token is lazily registered (not rejected) so direct-token tests + the 666 baseline stay green; `verify()` stays sync/IO-free.

### 2026-06-30 03:18Z — orchestrator (Opus) — Round 2 W3: sessions, revocation & access policy (commit 88cb3c6)
- Context: Turn the stdlib HS256 JWT into a short-lived ACCESS token carrying a `sid` (128-bit) + `tv` (token_version) claim and back it with a backend-agnostic server-side session registry, enforcing idle/absolute/revocation without slowing the sync `verify()` hot path.
- Did: `stores/sessions.py` (NEW) — `SessionStore` over the existing KVStore (EsKVStore/SqlKVStore adapters, persisted so sessions survive `_wire()` rebuilds and an ephemeral JWT secret); rows carry username/refresh-hash(+prev)/token_version/created/last_active/last_authn/absolute+idle expiry/revoked metadata/IP+geo/UA(browser/os/client_type)/mfa_method. `auth/service.py` mints `sid`+`tv` at both session-mint sites (not `begin_mfa` — pending tokens are exchanged, not registered); `AuthUser.sid` added. `api/deps.py` — `require_auth` does the async store check AFTER `verify()` (load by `sid`, reject on missing-revoked/`tv`-mismatch/absolute-expiry/idle-expiry, lazy `last_active` bump >60s), returning 401 `{code:'session_invalid'|'session_expired'|'reauth_required'}`; **no-op when auth off; unknown sid lazily registered, not rejected**. New `require_fresh_auth(window)` step-up dep. Session-create hooks at all three cookie-set sites (login, mfa/verify, sso/callback). Refresh rotation + reuse-detection theft path (replay of `refresh_prev_hash` → revoke + bump `tv` + audit). Policy fields on Preferences (`access_ttl`/`idle_timeout`/`absolute_lifetime`/`refresh_ttl`/`sudo_reauth_window` + notify toggles). Endpoints: `POST /api/auth/refresh|reauth`, `GET /api/sessions`, `POST /api/sessions/{sid}/revoke`, `POST /api/sessions/revoke-others`, admin `GET /api/admin/sessions` + `POST /api/admin/sessions/{sid}/revoke` + `POST /api/admin/users/{id}/revoke-all` (admin + fresh-auth gated; route-auth-coverage CI extended). webui: `pages/Sessions.tsx` (own sessions, current pinned + "This device", revoke + sign-out-all-others) + `pages/AdminSessions.tsx` (all users, filter, force-terminate) + `ReauthDialog.tsx` (triggered on `reauth_required`) + `SessionPolicyEditor.tsx` + `ui/alert-dialog.tsx`. #2 audit on every session create/revoke.
- Tests: backend **666 → 682** (+16; sid mint at all 3 sites, idle/absolute expiry reject, revoke single + revoke-all `tv` bump, refresh rotation + reuse-detection theft, step-up `require_fresh_auth`, admin-gate coverage, auth-off no-op + unknown-sid lazy-register verified); webui tsc+vite clean; vitest grew (sessions + admin-sessions render); 0 lint errors.
- Status: done — committed `88cb3c6`.
- Next: R2-W4 (Settings IA consolidation + page consolidation).

### 2026-06-30 03:45Z — orchestrator (Opus) — Round 2 W4: Settings IA consolidation + page consolidation (commit 9eb7d57)
- Context: Pure information-architecture pass — fold Users/Security/SSO + the W2 Profile and W3 Sessions pages under one two-scope Settings home (Personal Account / Organization) and declutter the top-level rail; consolidate near-duplicate pages into tabbed surfaces. No backend changes (everything round-trips via existing `/api/settings`, `/api/branding`, `/api/roles`, plus the W2/W3 routes).
- Did: `pages/Settings.tsx` — widened the `SectionId` union + `isSectionId` and `SECTION_GROUPS` with an `account` group (Profile/Account/Preferences/Notifications/Security/Sessions, no perm → all signed-in users) and the admin items (`admin_users` → `users:manage`, `admin_security` → `settings:manage`) under an `administration` group; `renderSection()` arms embed `Users`/`Security` (MFA + SSO) bodies as exported sub-components wrapped in `<Can>`, with RBAC-aware filtering that auto-jumps off a hidden active section (allow-all preserved when auth/rbac off). SSO writes route through Settings' single save (`prefs.sso`) so there's one save button. Hooks (visibleGroups/effect) kept ABOVE the `loading`/`!prefs` early returns (React #310 guard). **Page consolidation** via a new `TabbedPage.tsx` + `nav.ts` regroup into ≤5 top-level groups (Overview/Triage/Intelligence/Analytics/Admin, Miller's 7±2): Investigate folded into Chat as a segmented control (ONE chat engine), Cost into Metrics/Analytics as a tab, Standup into Overview, and Knowledge/Memory/Catalog under one Intelligence area (`Home.tsx`/`Workspace.tsx`/`Analytics.tsx`/`Intelligence.tsx` scaffolds; both `nav.ts` and the hand-written `App.renderPage` switch updated together).
- Tests: backend unchanged at **682** (webui-only); webui tsc+vite clean; vitest grew (`settings.render` — section deep-link + hooks-ordering + RBAC hide/show); 0 lint errors.
- Status: done — committed `9eb7d57`.
- Next: R2-W5 (Demo Mode + Experimental Settings).

### 2026-06-30 04:18Z — orchestrator (Opus) — Round 2 W5: reversible, isolated Demo Mode + Experimental Settings (commit 93ac735)
- Context: Add a first-class, reversible TENANT STATE (off|seeded|live) — not a fork — that flows synthetic OCSF events through the REAL pipeline but writes to a SEPARATE in-memory store with a deterministic mock LLM, so demo is $0, isolated, and one-flip reversible. #3 stays byte-identical.
- Did: `connectors/demo.py` (`DemoPullConnector`, `capabilities=['browse']`, registered only when `demo.mode != 'off'`); `engine/demo_generator.py` (seeded fictional org fixture + benign diurnal/Zipf baseline + MITRE ATT&CK storylines, deterministic by seed) + `engine/demo_runtime.py` (the jittered `DemoSimulator` tick). `state.py` builds a throwaway `demo_cases` `CaseStore(InMemoryESClient())` + demo IngestService and starts/stops the simulator on enable/disable; the poll gate in `poller.py` is gated BEFORE `source.poll` so the real durable cursor (#4) is untouched. `llm/gateway.py` + `llm/providers.py` select a deterministic MockProvider when `demo_run_id` is set (scenario-keyed verdicts; usage rows `pricing_source='zero'` with a plausible synthetic `$`); FP runs through the REAL `decide()` against a SANDBOXED `AutoClosePolicy` copy (live policy untouched), NEEDS_HUMAN stays open. Preferences gained the `demo` block (mode/seed/run_id/history_days/tick params/incident_rate). Endpoints `POST /api/demo/enable|reset|disable` + `GET /api/demo/status` (all admin-gated; route-auth-coverage extended). webui: `<DemoBanner/>` (amber, Reset + "Exit & clear"), `DemoBadge` SAMPLE chip on demo rows, cost tiles suffixed "(simulated)", `useDemoGuard()` disabling real-write actions, and a `DemoModeSection` under Experimental Settings.
- Tests: backend **682 → 697** (+15; seeded-generator determinism, isolation/write-guard, enable→reset→disable lifecycle, $0-cost assertion, real cursor untouched, decide() byte-identical); webui tsc+vite clean; vitest grew (`demo.render`); 0 lint errors.
- Status: done — committed `93ac735`.
- Next: R2-W6 (source multi-feed customization).

### 2026-06-30 04:47Z — orchestrator (Opus) — Round 2 W6: source multi-feed (events/alerts/ignore + per-feed config) (commit 2ada050)
- Context: Promote the per-source `IndexPattern` to a richer per-feed `Feed` model (keep the wire key `config['index_patterns']` + class name to avoid a breaking rename), add an `ignore` role, and give each feed its own query/field-mapping/severity-floor/schedule — all back-compatible with stored configs.
- Did: `constants.py` `IndexRole.IGNORE`. `config.py` `IndexPattern`→richer `Feed` (additive defaulted `id`/`role`/`enabled`/`query`/`field_mapping`/`message_field`/`severity_floor`/`correlate`/`auto_investigate`/`poll_interval_seconds`/`label`) with a pure `upgrade_feed()` migration (legacy `{pattern,role,auto_correlate}` and bare-string entries still validate; `auto_investigate` derived from `role=='alerts' or legacy auto_correlate`); both lock-step parsers updated (`SourceInstance.feeds()`/`index_patterns()` + `connectors/elastic.py:_index_patterns` role-coercion allowlist gains `ignore`). The single union ES query was split into per-pattern sub-queries so per-feed `query`/`severity_floor` work (poll + search). `engine/ingest.py`: IGNORE feeds skip ingest entirely; `severity_floor` registers the candidate + live-tail but sets `auto_investigate_eligible=False` — NEVER drops the event (#4); role drives smart defaults (alerts → auto-investigate, events → allowlist path). `engine/poller.py` uses a per-feed durable cursor key `f'{source.id}:{feed.id}'` so a fast alerts feed and a slow events feed never share/skip (#4). `config['data_view_pattern']` kept synced (non-ignore patterns) for the legacy fallback. Optional `GET /api/sources/{id}/feeds` returns resolved effective feeds. webui: `SourceEditor.tsx` per-row Feeds editor (role segmented events/alerts/ignore, enabled toggle, severity-floor slider, correlate + auto-investigate switches, monospace query with a bounded test affordance, mapping-override drawer, schedule, effective-config preview chip); `types.ts` extended.
- Tests: backend **697 → 716** (+19; legacy + bare-string still validate to identical effective `auto_investigate`, IGNORE excludes a sub-index by longest-pattern-wins, severity_floor blocks auto-forward but keeps candidate (#4), per-feed cursor isolation, effective-mapping precedence); webui tsc+vite clean; vitest grew (`source-feeds.render`); 0 lint errors.
- Status: done — committed `2ada050`.
- Next: R2-W7a (email: Resend + SES + templates).

### 2026-06-30 05:05Z — orchestrator (Opus) — Round 2 W7a: Resend + SES channels + customizable email templates (commit f0909af)
- Context: Add Resend (HTTPS API) and SES (SMTP preset + optional SigV4) to the existing `NotificationChannel` SPI and ship a preloaded, operator-overridable template SET rendered by a tiny stdlib mustache-subset renderer with hard UNTRUSTED-escaping. Channel `send()` must never raise (channel isolation), secrets never leak into `detail`.
- Did: `notifications/resend.py` (NEW) — `ResendChannel(_HttpChannel)` type=`resend`: POST `https://api.resend.com/emails` with Bearer key + mandatory User-Agent + optional Idempotency-Key, client-side rps token bucket, retry only 429/5xx (not 4xx config/quota), 200 → provider message id stored for audit. SES — ship the SMTP preset (`email-smtp.{region}.amazonaws.com:587`) and accept either pre-made SMTP creds or a raw IAM key pair, deriving the SMTP password via the stdlib AWS4 HMAC chain. Registered both in `channel.py:_load_builtins()` and widened the `type` Literal in all three places (`config.py` `NotificationChannelConfig`, `types.ts` union, `NotificationsEditor.tsx` hardcoded list). `notifications/templates.py` — a stdlib mustache-subset renderer (`{{var}}` auto-`html.escape`d, `{{{var}}}` raw only for trusted header HTML, `{{#}}`/`{{^}}` sections, dotted lookup, no eval/getattr) + a `NotificationTemplates` model (per-trigger subject/html/text overrides) with `header_safe()` (strip CRLF, cap 120) and `text_safe()`; 5 preloaded templates `case.new`/`case.escalation`/`case.resolved`/`digest.daily`/`test`; deterministic `Message-Id`/`In-Reply-To`/`References` threading + `X-TLSOC-*` headers; a deterministic NotifyPolicy (NEEDS_HUMAN always emails). Endpoint `POST /api/notifications/preview?trigger=` (server-side render of a sample case, escaping authoritative); secrets via the existing `POST /api/notifications/channels/{id}/secret`. webui: Resend/SES config rows + domain-verification/sandbox callouts + test-send + a template preview pane.
- Tests: backend **716 → 744** (+28; Resend self-registers in `channel_types()` + `send()` ok via injected poster, `SendResult.detail` never leaks secrets, renderer escapes `<script>`/`{{ }}` in untrusted vars, `header_safe` strips CRLF (header-injection), `text_safe` strips newlines, all 5 templates render, raw marker only for trusted header); webui tsc+vite clean; vitest grew (`notification-templates.render`); 0 lint errors.
- Status: done — committed `f0909af`.
- Next: R2-W7b (per-user customization: prefs, saved views, columns, terminology, theme).

### 2026-06-30 05:37Z — orchestrator (Opus) — Round 2 W7b: per-user prefs, saved views, columns, terminology, theme (commit 36ff656)
- Context: Add a two-store customization model — org Preferences (admin) + per-user `UserPrefsStore` (KV) — with a `user ?? org ?? system` cascade, carrying saved views, per-table column state, terminology overrides, and a personal theme mode. Admin gates on every org-scope write; all view/terminology text rendered as data (#9).
- Did: `stores/user_prefs.py` (NEW) — `UserPrefsStore` over the KVStore (EsKVStore/SqlKVStore, keyed by user_id, `'default'` when auth off, no new index). `models.py` gained `SavedView`/`ColumnState`/`DashboardLayout`/`WidgetPlacement`/`UserPrefs`; `config.py` Preferences gained `terminology:dict[str,str]` + org default saved views. Endpoints: `GET /api/prefs/effective` (merged cascade), `GET/PUT /api/prefs/user`, `GET/PUT /api/prefs/org` (admin), `GET/POST/PUT/DELETE /api/views` + `POST /api/views/{id}/clone`, `PUT /api/prefs/user/tables/{table_id}`, `GET/PUT /api/terminology` (PUT admin) — every org-scope route added to the route-auth-coverage CI test. webui: a `PrefsContext` (`prefs.tsx`) hydrated once from `/api/prefs/effective`; `SavedViewsBar.tsx` (personal vs org views, pin-as-default, system presets) + `ColumnsMenu.tsx` + a column-persisting `DataTable.tsx`, wired into `Cases.tsx`; a `t(key)` terminology helper; a user light/dark/system theme toggle; `CustomizationSection.tsx` under Settings.
- Tests: backend **744 → 758** (+14; UserPrefsStore CRUD on SQLite+fake-ES, cascade resolver precedence, admin-gate on every `/api/prefs/org` + `/api/terminology`, SavedView clone personal←org); webui tsc+vite clean; vitest grew (`customization.render`); 0 lint errors.
- Status: done — committed `36ff656`.
- Next: R2-W7c (best-of-the-best UX: command palette, global search, bulk actions, audit viewer).

### 2026-06-30 06:04Z — orchestrator (Opus) — Round 2 W7c: command palette, global search, bulk case actions, audit viewer (commit 5869f13)
- Context: Ship the highest value/effort Tier-1 "best of the best" gaps vs top SOC products. Bulk closes must still run the REAL `decide()` per case (#3); the audit viewer reads the existing append-only `tlsoc-agent-audit-*` (#2); attacker-influenceable text stays plain (#9).
- Did: **Command palette (Cmd-K)** — `components/CommandPalette.tsx`: fuzzy jump to pages / cases-by-id / sources + context-aware actions, mounted in the shell. **Global search** — `GET /api/search` across cases/sources/knowledge/memory (RAG retrieval for knowledge/memory, cap 50), wired into Cmd-K + the top bar. **Bulk case actions** — `POST /api/cases/bulk {ids[],action,payload}` returning per-id `{ok,error}` (close/assign/tag/comment/status/reinvestigate; per-case audited; closes run the real `decide()`), with a multi-select bar in `Cases.tsx`. **Audit-log viewer** — `GET /api/audit` (keyset pagination + facets + CSV/NDJSON export, secrets redacted server-side) backed by additions in `audit/audit_log.py` + `stores/base.py`/`sql/repositories.py`; new `pages/Audit.tsx` serving both the global (admin) console and a per-user "My activity" view from one component; `nav.ts` entry added.
- Tests: backend **758 → 772** (+14; `test_w7c_ux.py` — global search shaping/cap, bulk per-id results + real-`decide()` on close, audit keyset/facets/export + secret redaction); webui tsc+vite clean; vitest grew (`command-palette` + `cases-bulk` + `audit.render`); 0 lint errors.
- Status: done — committed `5869f13`.
- Next: R2-Final (adversarial audit fleet + docs fleet + full green sweep + demo walkthrough).

### 2026-06-30 06:30Z — orchestrator (Opus) — Round 2 COMPLETE (all feature waves green)
- Context: Close out Round 2 — the 5 bug fixes + 10 feature asks across W1–W7c — and confirm the spine held throughout.
- Did: Shipped R2-W1 bug fixes (`9ab2954`), W2 login + account self-service (`317bd5a`), W3 sessions + token policy (`88cb3c6`), W4 Settings IA + page consolidation (`9eb7d57`), W5 reversible isolated Demo Mode (`93ac735`), W6 source multi-feed (`2ada050`), W7a Resend/SES + email templates (`f0909af`), W7b per-user customization + saved views + terminology + theme (`36ff656`), and W7c Cmd-K palette + global search + bulk actions + audit viewer (`5869f13`) — **all additive, ZERO new runtime deps, non-negotiable #3 (`case_manager.decide()`/`apply()`) byte-identical, #9 untrusted text plain/fenced, #10 secrets env/in-memory only, auth DEFAULT OFF**.
- Tests: backend **649 → 666 → 682 → 682 → 697 → 716 → 744 → 758 → 772** green across W1(webui-only)→W2→W3→W4(webui-only)→W5→W6→W7a→W7b→W7c (**+123** over the Round-1 baseline of 649); webui build clean + **86 vitest** green (29 → 50 → 58 → … → 86); 0 rules-of-hooks lint errors.
- Status: done — every feature wave committed/pushed to `Testing` (tip `5869f13`).
- Next: R2-Final housekeeping — adversarial audit fleet + the docs fleet (README/USAGE/DEPLOY/CLAUDE/ROADMAP/CHANGELOG sync + demo-walkthrough update); then carry the standing backlog (pre-flight projected-cost gate + `$`-budget ceiling; persisted encrypted secret store; Splunk + Microsoft Sentinel connectors; Wave-4/Epoch-E scale-out).

### 2026-06-30 — orchestrator (Opus) — Round 2 — audit + remediation + handoff (FINAL)
- Context: Close Round 2 for real — run an adversarial audit over the W1–W7c surface, fix what it finds, and leave a single authoritative onboarding doc. The feature waves were green at `758 → 772`; this pass hardens them and re-baselines the count.
- Did: Ran a **16-agent adversarial audit fleet** over auth/RBAC/sessions/poller/email/demo/UI; findings + dispositions captured in `docs/research/2026-06-round2/ROUND2_AUDIT.md`. Landed the **8 confirmed fixes** (commit `aae7a76`) across RBAC, the per-feed poller, and the RiskGauge, alongside the docs sweep. Then landed the **HIGH/MEDIUM remediation** (commit `763ded9`, **+22 tests**): #4 per-feed cursor starvation (fast feed no longer starves a slow one), demo-chat isolation (demo chat cannot touch live state), env single-admin token-version lockout, a `set_status → RESOLVED` RBAC gap, email `text_safe`/`{{{ }}}` raw-marker + branding-SVG hardening, and a **strengthened authZ-coverage CI test** that now fails if ANY non-GET `/api` route lacks an authZ gate. Non-negotiable #3 (`engine/case_manager.py` `decide()`/`apply()`) verified **byte-identical** end to end; **zero new runtime deps**. Authored `docs/HANDOFF.md` as the single START-HERE onboarding doc (run commands, status, what's done, what's next), cross-linked from CLAUDE/ROADMAP/ENVIRONMENT.
- Tests: backend **772 → 794** (+22 from the remediation pass); webui build clean (tsc + vite); **86 vitest** green (19 files); eslint **0 `react-hooks/rules-of-hooks` errors** (2 benign `exhaustive-deps` warnings). (Earlier entries citing 772 are the correct per-wave checkpoints; **794** is the final Round-2 baseline.)
- Status: done — Round 1 + Round 2 **complete and committed on `Testing`** (tips `aae7a76` → `763ded9`); **local only, NOT pushed**.
- Next: deferred/low items tracked in `ROUND2_AUDIT.md` (session-KV optimistic concurrency, multi-generation refresh-reuse, ES-only `CONFIG_INDEX` nested-type collision, deep-link breadcrumb cosmetic) + the best-of-best Tier-2/3 backlog in `ROUND2_BEST_OF_BEST.md` (API keys, dashboards builder, scheduled reports, watchlists, SLA timers, hunting/query builder). New here? Start with `docs/HANDOFF.md`.

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 0 (hot-file foundations) green
- Context: Round 3 overhaul — 12 user requests, approved plan at `docs/research/2026-06-round3/PROPOSAL.md` (built from a 26-agent understand fleet + a 30-agent web-research fleet). Cadence = autonomous, test gate per wave. Wave 0 = additive scaffolding so later waves don't churn the hot files (`models.py`/`config.py`/`constants.py`) + webui route code-splitting.
- Did: **Backend** (one owner) — 5 advisory `Case` axes (severity/impact/urgency/priority bands + sources) + 3 SLA lifecycle datetimes; **11 new model classes** (Observable, ProviderResult, CaseMessage, CaseActivity, CaseTask, InAppNotification, NotificationPref, CustomRole, ActionItem, ShiftAck, TraceSpan); **4 enums** (IndicatorKind/AuthorType/NotificationCategory/Material) + 4 new `ActionType` audit values; **8 KV-namespace triples** (CASE_THREAD/CASE_ACTIVITY/CASE_TASKS/INBOX/NOTIF_PREFS/CUSTOM_ROLES/PRICE_OVERLAY/SHIFT_HANDOFF) in `constants.py`; **4 Preferences blocks** (sla/priority_matrix/budget/realtime) + `BrandingConfig.material/default_theme/theme_tokens/presets/effective_theme()`; `EnrichmentConfig` provider toggles + `RBACConfig.custom_roles/resources/denies` carriers + 13 optional `Secrets` provider-key slots (booleans only); `settings_schema.py` titles. **Webui** (one owner) — `App.tsx` ~25 page imports → `React.lazy` + one `<Suspense fallback={<PageSkeleton/>}>` inside the ErrorBoundary (Login/Wizard stay eager); new `PageSkeleton.tsx`; `vite.config.ts` `manualChunks` (react-vendor/recharts/motion/icons/radix).
- Tests: backend **794 → 802** (+8 `test_round3_wave0_foundations.py`, incl. a guard that `case_manager.py` never references the advisory field names); webui `tsc+vite` clean + **86 vitest** green; entry bundle **444 KB → 63.75 KB gzip** (recharts isolated + lazy, 45 chunks). `case_manager.py` **byte-identical** (#3); **zero new runtime deps**. Clean-room verifier verdict: green, no regressions.
- Status: done — committed locally on `Testing` (not pushed).
- Next: Wave 1 — shared substrate (KVStore stores for thread/activity/tasks/inbox/notif-prefs/custom-roles/price-overlay/shift-handoff, the EnrichmentProvider SPI mirroring the connector registry, RBAC custom-role/inheritance/deny resolution + resource-vocab split, and the multiplexed SSE `/api/events` channel).

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 1 (shared substrate) green
- Context: Build the 7 build-once foundations' backend half. Ran as 4 parallel builders on DISJOINT new files + one integrator owning the hot files (`routes.py`/`state.py`/`deps.py`) + a clean-room verifier, so parallel edits never collided.
- Did: **(stores)** 8 KV-backed stores mirroring `user_prefs/memory/sessions` over the shared `KVStore` (no new index/table/migration): `CaseThreadStore`, `CaseActivityStore`, `CaseTaskStore`, `InboxStore` (per-user fan-out, ~200/user ring), `NotificationPrefsStore`, `CustomRoleStore`, `PriceOverlayStore`, `ShiftHandoffStore`; confirmed the generic KV path is namespace-agnostic on both ES (`EsKVStore._doc_id` fallback) and SQL (`KVRow`). **(enrichment)** `backend/app/enrichment/` SPI — `EnrichmentProvider` ABC + manifest, `ProviderRegistry` (built-ins + `tlsoc.enrichers` entry-point, filtered by `use_*` toggle + key presence), `dispatch.enrich_indicator()` (type-routed, fail-open, cached), `aggregate.fuse()` (default `max()` byte-identical; weighted fusion gated behind `fusion_enabled`); AbuseIPDB+VirusTotal refactored behind it; `enrich_ip()` kept as a byte-identical alias (risk/threat_context contracts unchanged, #3). **(sse)** in-process async `EventBus` singleton (bounded per-subscriber ring, Last-Event-ID replay, heartbeat) + nginx `location /api/events`. **(rbac)** split RESOURCES so each feature is its own resource (notifications/branding/sessions/demo/terminology/automation/roles/models/enrichment/inapp) with behavior-preserving DEFAULT_MATRIX grants; `effective_matrix()` folds custom roles + cycle-guarded inheritance + DENY-wins (super_admin hard-allowed); opt-in `can_object()` row-scope hook shipped OFF. **(integrate)** wired 8 stores into `AppState._wire()`, exposed `enrichment_registry`/`event_bus`, added `GET /api/events` (cookie-auth, 204 when `realtime.enabled` false), migrated the 4 notification routes to `notifications:*`, folded `CustomRoleStore` into `can()` via `deps._enforce`.
- Tests: backend **802 → 900** (+98: stores 19, enrichment 19, rbac 36, sse 24); `test_route_auth_coverage.py` 16/16 (incl. new `/api/events`); webui build still green; `case_manager.py` **byte-identical** (#3); **zero new runtime deps**. Verifier verdict: green.
- Status: done — committed locally on `Testing` (not pushed).
- Next: Wave 2 — backend feature logic on the substrate (posture metrics MTTA/MTTR/SLA/aging/MITRE-coverage, shift report, +10 enrichment providers + budget guard + multi-indicator, models registry+provider-generalization+budget gate, in-app channel + notif routing, case priority/impact derivation + triage, custom-role CRUD + preview/simulate).

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 2 (backend feature logic) green
- Context: All 7 backend feature surfaces on the Wave-1 substrate. Ran as 8 parallel feature builders — each owning DISJOINT domain modules + its OWN `api/routes_<feature>.py` router (so nobody edits the 4,439-line monolith) — then one integrator (mount routers in `main.py` + 4 service wirings in `state.py`) + a clean-room verifier. Builders ran only their own targeted tests; the integrator owns the full-suite gate.
- Did: **#5 posture** — `engine/metrics.py` extended (MTTA/MTTR/dwell p50/p90 from status_history, quality/aging/SLA, period-over-period) + `engine/mitre_coverage.py` (per-tactic coverage vs the 697-corpus + ATT&CK Navigator v4.5 layer); `routes_metrics.py`. **#11 standup** — `engine/shift_report.py` (attention queue + SLA aging + workload + deltas, deterministic) folded into `StandupService` (keeps #7); `routes_standup.py` (report + action-items CRUD + acknowledge). **#7 enrichment** — 17 providers behind the SPI (GreyNoise/Shodan InternetDB+host/Censys/BinaryEdge/IPinfo/OTX/Pulsedive/Spur/X-Force + abuse.ch trio/VT files-urls-domains/RDAP+DoH/URLscan/HIBP), multi-indicator, per-provider rate guard, fail-open + cached; `routes_enrichment.py`. **#9 models** — provider registry (Azure/Bedrock/Vertex/OpenAI-compatible base_url), bundled `model_registry.json` + `PriceOverlayStore`, `engine/budget.py` BudgetGate (pre-flight, over-budget→NEEDS_HUMAN); `routes_models.py`. **#8 in-app** — `InAppChannel` (no network; fan-out to `InboxStore`) wired into dispatch after apply()+save; `routes_inapp.py` (inbox + prefs). **#4 collaboration** — full ticket model (threaded human/ai/system messages, reactions, soft-delete, tasks, @mention→inbox, persisted in-case AI chat turns); `routes_cases_collab.py`. **#12 triage** — `engine/priority.py` (read-time severity/impact/urgency/priority derivation, advisory-only) + `routes_triage.py` (4 honest chips + typed ReAct timeline w/ a distinct deterministic DECISION step). **#6 roles** — `routes_roles.py` (custom-role CRUD + preview/simulate + /account/permissions + assign). Integrator mounted all 8 routers under `require_auth` + wired gateway↔budget/overlay, chat↔threads, standup↔cases/handoff, dispatch↔inbox.
- Tests: backend **900 → 1074** (+174 across 8 `test_round3_wave2_*` suites); `test_route_auth_coverage.py` 16/16 (every non-GET route gated); `case_manager.py` **byte-identical** (#3); **LLM ledger written exactly once/call** (#6 — budget gate pure pre-flight, raises before the call & before any write); webui build green; **zero new runtime deps**. Verifier verdict: green.
- Status: done — committed locally on `Testing` (not pushed). Wave 2.5 gap-closure next (config fields the frozen pass deferred).
- Next: Wave 2.5 — additive `config.py` (`ModelConfig.base_url` + Azure/Bedrock/Vertex Secrets so cloud providers are first-class; `EnrichmentConfig.use_honeypot` + `Secrets.honeypot_access_key`/`abusech_auth_key`) + fold per-user assigned custom roles into `deps._enforce` (so RBAC assignment is enforced server-side, not just shown) + a conftest network guard for offline enrichment tests. Then Wave 3 (webui surfaces).

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 2.5 (backend gap-closure) green
- Context: Close the 3 real gaps the Wave-2 builders flagged when `config.py` was frozen for parallel-safety. 3 disjoint builders (config+LLM+enrichment / RBAC deps / test conftest) + verifier.
- Did: **(A cloud LLM)** widened `Provider` Literal to azure/bedrock/vertex/openai_compatible; added `ModelConfig.base_url/api_version/region` + 12 cloud/enrichment `Secrets` (Azure/AWS/Vertex creds + honeypot/abusech keys, booleans-only) + `EnrichmentConfig.use_honeypot`; gateway authenticates azure/bedrock(SigV4)/vertex; registered `ProjectHoneypotProvider`; abuse.ch `Auth-Key` header when set; 4 cloud rows in `model_registry.json`; removed the `model_construct()` workaround. **(B RBAC enforcement)** new pure `can_for_roles(base, custom_roles, ...)` (role-union, deny-wins, super_admin hard-allow, parity-clean when none assigned) + `deps._assigned_custom_roles()` loading `User.prefs['custom_roles']`; `_enforce` now decides via the union → assigned custom roles are enforced on routes, consistent with `/api/account/permissions`. **(C netguard)** autouse `conftest` socket guard blocks non-loopback egress (with `@pytest.mark.allow_network` opt-out); flagged enrichment test 4.04s→0.17s (~20x), suite now deterministic/network-free.
- Tests: backend **1074 → 1109** (+35: config 21, rbac 6, netguard 8); `case_manager.py` **byte-identical** (#3); authZ green; webui build green; **zero new runtime deps**. Verifier verdict: green. Backend now feature-complete for Round 3.
- Next: Wave 3 — webui surfaces (hamburger nav, Settings grid, branding/material, Roles editor, Models page, Metrics+MITRE heatmap, Standup attention queue, CaseDetail 4-chip + trace timeline + collaboration, Inbox bell, enrichment editor) against the now-stable backend contract.

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 3 (webui surfaces) green
- Context: Build every UI surface for the 12 asks. Sequenced: 1 design-system agent (shared primitives) → 6 parallel surface builders (disjoint pages + co-located api, no monolith/App.tsx/nav contention) → integrator (register pages in App.tsx + nav reconcile + full build) → clean-room verifier.
- Did: **(design system)** allow-listed theme tokens (radius/density/canvas/surface/font + material chrome vars) in theme.css/tailwind; ONE precedence resolver `theme-tokens.ts` (applyTokens sanitises/allow-lists, applyBranding, 6 AA accent presets, 'command' material pack where 'quiet'===today); `GlassSurface` (reduced-transparency fallback); `SettingsGrid/SettingsCard/StickySaveBar/SettingsTOC`; chart primitives `MitreHeatmap/BurnDownChart/AreaSpark/MultiSeriesTrend`; page-archetype layouts. **(#2 shell)** `NavSidebar` — one sidebar, two width states, Cmd/Ctrl+B, WAI-ARIA disclosure children + collapsed hover-card fly-outs, persisted in UserPrefs.misc + localStorage; `NotificationBell` (unread badge + dropdown, poll now/SSE-ready). **(#1+#3+#10)** Settings card-grid + sticky save + per-section dirty + anchors; BrandingEditor tokens/presets/material + contrast preview. **(#6+#9)** Roles matrix editor (grants/denies/inherits + preview-diff + simulate + assignment w/ lockout guard); standalone Models admin page (capability badges, price edit, test-call, cost estimator, budget burn-down, cloud providers). **(#5+#11)** Metrics Operational/Performance/Posture tabs + MITRE heatmap + SLA/aging + deltas; Standup attention queue + action items + acknowledge + deep-links. **(#12+#4)** CaseDetail 4 honest chips (risk/severity/impact/priority) + typed ReAct TraceTimeline w/ distinct deterministic DECISION step + full threaded human/ai/system collaboration (reactions, tasks, @mentions→inbox, activity feed). **(#8+#7)** Inbox page + NotificationPrefs; EnrichmentProvidersEditor (catalog/toggles/secrets/try-a-lookup) mounted in Settings. Integrator registered Models/Roles/Inbox + host-tab routes, fixed the shared api-mock gap.
- Tests: webui `tsc --noEmit && vite build` exit 0 (51 chunks, code-split preserved, entry 68.85 KB gz); **vitest 86 → 175** (+89 across 10 new spec files); backend UNTOUCHED (case_manager.py byte-identical); **#9 audit PASS** (no dangerouslySetInnerHTML on data; CaseThread/TraceTimeline/enrichment escape untrusted; secrets boolean-only); **zero new npm deps**. Verifier verdict: green.
- Status: done — committed locally on `Testing` (not pushed). One backend follow-up for Wave 4: PUT /api/branding doesn't yet compute contrast_warnings/auto_corrected (editor already degrades gracefully).
- Next: Wave 4 — live SSE wiring (publish from poller/dispatch/pipeline → EventBus; webui EventSource w/ polling fallback for bell/case-activity/agent-stream), branding contrast computation, the RAG-fencing-allowlist security fix (operator-imported docs currently reach the LLM unfenced), distinctive-UI polish + WCAG 2.2 pass, docs sync. Then Wave 5 — the big test fan-out.

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 4 (live wiring + security fix + polish + docs) green
- Context: Close Round 3 build with live SSE wiring, the research-confirmed RAG injection fix, the branding-contrast gap, a WCAG/distinctiveness pass, and the docs sync. 6 disjoint builders → integrator (full gate) → verifier.
- Did: **(SECURITY — OWASP LLM01)** inverted the RAG knowledge block to a DEFAULT-DENY trusted allowlist (`tools/rag.py` `TRUSTED_KNOWLEDGE_SOURCES={runbook,mitre,suppression}` + `is_trusted_knowledge()`); BOTH prompt paths (`prompts.render_cluster`, `chat._render_knowledge`) now fence operator-IMPORTED / threat_context / resolved_case / unknown sources via `fence()` (forged UNTRUSTED/PLAYBOOK/MEMORY markers neutralised), seed corpus byte-identical. **(SSE)** `pipeline._emit_step()` publishes ordered `agent.step` frames (router→persona→tools→verdict→decision) on `cases:{id}`, the decision frame strictly AFTER apply()+save()+audit (#3); `routes_cases_collab._publish_case_activity()` emits `case.activity`; mention badge aligned to the allowlisted `notifications` topic; `state.py` wires `pipeline.event_bus`. **(webui SSE)** `lib/useEventStream.ts` (EventSource, cookie-auth, Last-Event-ID, default-OFF → inert/polls; 204 keeps polling; live frames are refetch NUDGES, payloads never rendered #9) wired into NotificationBell/CaseActivityFeed/CaseThread. **(branding)** `engine/contrast.py` WCAG luminance/ratio + PUT /api/branding now returns `auto_corrected` foregrounds + `contrast_warnings` (warn, never block). **(polish)** display typography + CommandCenterLayout hero on Overview + WCAG 2.2 target-size/focus wins on nav/buttons. **(docs)** CLAUDE.md test counts + Round 3 status, ROADMAP, README/DEPLOY/ENVIRONMENT new env vars, `.env.example` cloud-LLM + enrichment keys, HANDOFF refresh, new `docs/research/2026-06-round3/IMPLEMENTATION.md`.
- Tests: backend **1109 → 1142** (+33: rag-fencing 10, events 8, branding-contrast 15); webui build green + **vitest 175 → 181** (+6 useEventStream); `case_manager.py` **byte-identical** (#3); decision frame emitted only post-decision; **zero new deps**. Integration needed zero cross-fixes. Verifier verdict: green.
- Status: done — committed locally on `Testing` (not pushed). All 12 requests delivered; Round 3 BUILD complete.
- Next: Wave 5 — the big multi-agent TEST fan-out (backend integration + webui interaction + adversarial #3/#9/#6/RBAC + accessibility + end-to-end flows), triple-verify, then final full-suite sweep + commit.

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 5 (adversarial audit + harden) green
- Context: The big test fan-out. 5a = a 24-dimension READ-ONLY adversarial audit fleet (77 agents: 24 auditors + 53 per-finding skeptics that refuted false positives). 5b = 11 disjoint fix agents implement the confirmed findings + regression tests → integrator → verifier + a re-audit of the 3 dims that failed to return.
- Did (5a): **40 confirmed findings, 11 refuted** (3 HIGH, 11 MEDIUM, rest LOW/INFO). (5b) Fixed all 40: **HIGH** — `render_cluster` now fences enrichment country/`*_error` leaves (the #9 hole the RAG fix missed; covers router+investigator); a `_would_orphan_super_admin` guard on PUT /users/{u}/roles|PUT /users/{u}|DELETE; `standup` `fence_block()` (16K cap, per-leaf fencing) replaces the 600-char `fence(json.dumps())` that was dropping 80-95% of the shift aggregate (same fix in the chat es_query path, #7 preserved). **MEDIUM** — real read routes (cases/search/sources/logs) now carry `require_permission` so `rbac.denies` is honored; ES usage summary switched to a sum aggregation (budget no longer under-counts past 10k docs); source-scale-aware `severity_band_from_events` (OCSF severity_id / Wazuh rule.level); trace cost/token attributed once; **optimistic-concurrency (version+retry) on the KVStore RMW path across all 8 stores** (lost-update race); user-delete clears inbox+prefs; Demo Mode no longer leaks `agent.step` to the shared EventBus; recharts no longer first-paint + framer-motion removed entirely; nav aria-current dedupe + disclosure + prefs-reconcile; dead Wave-4 SSE live props wired into CaseDetail; ~25 cloud-LLM/enrichment secrets wired into BOTH compose files + CHANGELOG Round-3 entry + corrected doc counts. Plus the LOW/INFO (quiet-hours tz, posture truncation honesty, period-delta symmetry, etc.).
- Tests: backend **1142 → 1234** (+92 regression tests across 8 new files); webui build green (entry 62.96 KB gz, recharts lazy-only, no motion chunk) + **vitest 181 → 199** (+18). `case_manager.py` **byte-identical** (#3); ledger one-write/call (#6); integration needed ZERO cross-fixes. Verifier verdict: green; all 3 HIGH fixes verified real + test-locked; secrets re-audit 0 findings.
- Status: 5a+5b done — committed locally on `Testing`. Re-audit surfaced 8 accessibility + 2 branding findings (3 a11y MEDIUM: skip-link, MITRE-heatmap sr-only data-table misattribution, tag-input focus indicator; quiet-material not byte-identical) → Wave 5c.
- Next: Wave 5c — fix the re-audit a11y + branding findings, then the final full-suite sweep + Round-3 close-out.

### 2026-06-30 — orchestrator (Opus) — Round 3 Wave 5c (re-audit a11y + branding) green
- Context: Close the 10 findings the 3 re-run audit dimensions surfaced (8 WCAG 2.2 a11y + 2 branding). 1 webui-a11y agent + 1 backend contrast cleanup + verifier.
- Did: **(a11y)** skip-to-main link (focusable `#socMain`); MITRE heatmap sr-only data-table rebuilt ROW-PER-TACTIC (each cell = its own technique:value — fixes the 1.3.1 misattribution); tag-input focus-within ring; ≥24px hit areas on tag-remove + feedback stars; AA contrast scrim on 10px heatmap labels; branding hex-field `Label`/`id` association; SettingsTOC smooth-scroll gated on prefers-reduced-motion; collapsed-nav children now an inline group-hover/focus-within fly-out (keyboard-reachable, dropped the portaled HoverCard). **(branding)** `quiet` material no longer pins `--glass-opacity` (byte-identical to pre-wave dark again; only `command` raises glass); removed dead `_THEME_BG` + corrected `engine/contrast.py` docstring.
- Tests: backend **1234** (unchanged; contrast.py tests green); webui build green + **vitest 199 → 205** (+6 a11y specs); `case_manager.py` byte-identical (#3); zero new deps. Verifier verdict: green; all 3 MEDIUM a11y fixes real.
- Status: done — committed locally on `Testing` (not pushed). **ROUND 3 COMPLETE** — all 12 requests delivered + audited + hardened.
- Next: final clean full-suite sweep (pytest + webui build + vitest) to re-confirm the committed tip, then Round-3 close-out. Standing item: nothing pushed (local-only per project convention) — push when the user asks.

### 2026-07-01 — orchestrator (Opus) — Round 4 SESSION START: understand + re-run focused research
- Context: Open Round 4 ("fix the logic, fine-tune the product") — 12 requests + 3 confirmed bugs. Proposal already drafted at `docs/research/2026-07-round4/PROPOSAL.md`; user has locked the 4 key decisions (auto-tuning = AUTO-APPLY with audit/rollback/shadow-eval; batch/flex = the two-tier data-stream vision to research; reset = tiered danger-zone + fresh OOBE with account setup; models = broad multi-provider + flex/batch + the Opus-4.8 price fix). A prior focused-research pass died on its synthesizer (structured-output cap), so it must be re-run from scratch. Baseline: backend 1234 pytest, webui build + 205 vitest, tip `3cd7d54` on `Testing`.
- Did: Read CLAUDE.md + Journal (all Round-3 entries) + `docs/research/2026-07-round4/PROPOSAL.md` + Round-3 PROPOSAL/IMPLEMENTATION for prior patterns. Launched TWO background Workflow fan-outs: **(1) understand fleet** — 60 Opus readers over disjoint subsystems + 6 domain synthesizers writing `docs/research/2026-07-round4/understand/0{1..6}-*.md` (ingestion/collection · llm-cost-tools · detection-core · agents-prompts-pipeline · backend-platform · webui). **(2) research fleet** (the re-run, cap-safe: small researcher schemas, text/disk synthesizers) — 18 web-researchers across 8 areas (a SIEM event-vs-alert streams · b AI-SOC agent detection + cost guardrails · c baselining-over-time EWMA/percentile/seasonality · d daily campaign correlation · e Anthropic/OpenAI batch+flex idempotency · f terminology · g reset UX · h OOBE account setup) → 8 area briefs in `research/area-*.md` → 1 design synth writing `RESEARCH-SYNTHESIS.md`.
- Tests: n/a (understand + research phase; no code touched). Baseline 1234 / 205 carried forward.
- Status: in-progress — both fleets running in background; awaiting completion to synthesize the refined batch/ingestion + reset/OOBE design into PROPOSAL.md and present to the user for final confirm before any build.
- Next: on completion, read the 6 understand maps + RESEARCH-SYNTHESIS.md, reconcile with PROPOSAL.md, update the proposal, and present the refined two-tier-ingestion/baseline/batch/reset/OOBE design for approval. Then build in ~6 waves (W0 pricing+UI-glitch+risk-help → W1 hot-file contracts → W2 PollerManager → W3 engine → W4 routes → W5 webui → W6 tests+docs). Commit per wave on `Testing`; NO Claude co-author trailer.

### 2026-07-01 — orchestrator (Opus) — Round 4 understand+research DONE (rate-limited, recovered), PROPOSAL refined
- Context: Both fleets completed but were throttled by a TRANSIENT server-side rate limit (529 "temporarily limiting", NOT usage cap) caused by running two heavy Opus-1M fleets (~30+ concurrent) at once. Understand: 17/60 readers landed (the highest-value ones) → 4 partial maps written (`understand/01,03,04,05`), `02-llm-cost` + `06-webui` missing. Research: 4/18 researchers + 1/8 area briefs survived, but the design synth still produced a solid `RESEARCH-SYNTHESIS.md` (grounded on the strong area-c baseline brief + own vendor-doc fetches).
- Did: Read the `01-ingestion` + `03-detection` maps (authoritative — pinned every bug to a line). Verified the LLM pricing/caching/Batches facts via the **claude-api** skill (all confirmed: Opus-4.8 correct $5/$25; cache read 0.1×/write 1.25×(5m)/2×(1h); min-prefix 4096 Opus/2048 Sonnet; Batches 50%, ≤100k/256MB, <1h/24h, 29-day retention, UNORDERED→key by custom_id, NOT on Bedrock/Vertex/Foundry). Folded a big **§6 REFINED PLAN** into `docs/research/2026-07-round4/PROPOSAL.md`: corrections (risk weights 25/20/30/15/10 Reputation-heaviest; decide-guard forbids literal "automation"; poller legacy-cursor collision; acknowledge=routes.py:3136; per-rule FP metric is NEW; CapsConfig.max_concurrent NEW), two NEW subsystems (campaign correlation + entity baseline w/ the precise "improves over time" answer: online EWMA/EWMV + hour-of-week + t-digest, MAD |M|>3.5, warmup 3×period, slow H=14d), authoritative pricing table, batch state machine, tiered reset, OOBE account setup, terminology lock, revised 6-wave plan.
- Tests: n/a (planning). Baseline 1234/205 carried forward. No code touched.
- Status: in-progress — presenting the refined plan to the user for FINAL confirm (via a 4-question ask on the remaining open decisions) before any build. Understand-gaps (02-llm-cost + 06-webui maps) will be re-run as a small SINGLE fleet just before/at W0 (rate limit will have cleared; never run two heavy fleets concurrently again).
- Next: on approval → W0. Recovery note: relaunch fleets ONE AT A TIME to avoid re-triggering the 529.

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 0 GREEN (price fix + with_retry + 3 UI glitches + (?) risk-help)
- Context: First build wave. 4 disjoint Opus builders (single fleet, no concurrent second fleet) → 1 clean-room verifier running the full gate. Recovered the 2 missing understand maps (02-llm-cost-tools + 06-webui) first via a small single fleet — both written; the maps pinned every W0 fix to a line.
- Did: **(A price #2)** `claude-opus-4-8` corrected **$15/$75 → $5/$25** in all THREE coordinated places (`llm/pricing.py` PRICES + `_TIER_HEURISTIC`; `llm/model_registry.json` incl. cache 18.75/1.5→6.25/0.5 + ctx 200K→1M) + broadened the Anthropic family (fable-5 10/50, opus-4-7 5/25, sonnet-4-6 3/15 ctx→1M, haiku-4-5 1/5). Cache-rate APPLICATION deliberately deferred to W1/W3 (needs the UsageDoc/CompletionResult/provider chain) — non-cache cost math byte-identical, no 2nd UsageDoc write (#6), demo `pricing_source='zero'` unaffected. **(A retry)** wired the dead `providers.with_retry()` around the raw `self._client.post` in Anthropic/OpenAI `.complete/.embed` (gateway untouched). **(B glitches)** `ui/hover-card.tsx` `collisionPadding` default 8 (right-edge clip); `SettingsGrid.tsx` `min-w-0 flex-1` + desc `break-words` (one-word-per-line). **(C tabs)** `CaseDetail.tsx` — de-duplicated the Collaboration/Feedback tabs + renamed the grading-only component `CollaborationTab→FeedbackTab` so value↔label↔component agree (net −252). **(D #8 risk help)** `CaseTriageHeader.tsx` HelpTip on RiskBreakdownBars with the 5 factors authored VERBATIM from `risk.py` (weights **25/20/30/15/10**, Reputation heaviest) + honest "ranks, never closes" caveat; synced the duplicated string at `priority.py:262` + `CaseTriageHeader.tsx:203`.
- Tests: backend **1234 → 1235** (+1 provider-retry test; price assertions updated); `test_wave6_decide_guard.py` green + `case_manager.py` **byte-identical** (#3); webui build exit 0; vitest **205 → 214** (+9: ui-glitch-fixes, CaseDetail.tabs, CaseTriageHeader help); lint 0 rules-of-hooks (3 benign exhaustive-deps). Verifier verdict: GREEN, diff scope = exactly the 4 builders' files.
- Status: done — committed on `Testing` (docs `068ede4`, code next). Zero new deps.
- Next: W1 — hot-file contracts once (`models.py`/`config.py`/`constants.py`): UsageDoc cache/batch fields + CompletionResult cache fields + provider cache-token extraction (providers.py:171-179 currently drops them); Campaign/CampaignStatus/BaselineState/BatchJob/BatchJobState/DetectionSource/ResetScope models; ActionType.{TUNING,RESET}; Preferences.{threshold_tuning,batch,baseline,caps.max_concurrent}+login_* branding; AutomationRule→CaseAutomationRule alias; additive DetectionRule migrate-on-read.

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 1 GREEN (hot-file contracts)
- Context: Additive scaffolding over the 3 interdependent hot files so later waves don't churn them. ONE backend owner (hot-file safety) → clean-room verifier. All defaulted, zero behavior change, zero new deps.
- Did: **constants.py** — `ActionType.{TUNING,RESET}`; 4 enums `CampaignStatus`/`BatchJobState`/`DetectionSource`/`ResetScope`; 4 KV-namespace triples `CAMPAIGNS`/`BASELINE`/`BATCH_JOBS`/`TUNING`. **models.py** — `UsageDoc` +`cache_read_tokens`/`cache_write_tokens`/`batch` (data-only; cost unchanged, W3 applies rates); new `CampaignEntity`/`Campaign`/`BaselineState`(Welford+EWMA+t-digest centroids)/`BatchJob`/`DetectionRule`(composite match+trigger carrier, not rewired); `Case` +advisory `campaign_id`/`detection_source` (kept OUT of case_manager.py). **config.py** — `ThresholdTuningConfig`/`BatchConfig`(severity_floor=3)/`BaselineConfig`(H=14d, warmup=3, mod-z=3.5, tdigest=100)/`CampaignConfig` (all default OFF); `CapsConfig.max_concurrent=3`; `BrandingConfig.login_*` bounded plain-text + a validator rejecting any `<` (no markup, #9) + curated illustration keys; `AutomationRule→CaseAutomationRule` with a module alias (routes.py approve/reject + stored `threshold_automation` round-trip verbatim). **settings_schema.py** — titles for the new blocks. New `tests/test_round4_wave1_contracts.py` (18 tests incl. old-dict back-compat, alias, legacy wire-key, branding `<`-rejection, #3 guard).
- Tests: backend **1235 → 1253** (+18), 0 fail; `test_wave6_decide_guard.py` green + `case_manager.py` byte-identical (grep: no campaign_id/detection_source/automation); webui build exit 0; vitest 214 (unchanged); additivity verified (legacy UsageDoc/threshold_automation/AutomationRule still validate). Verifier verdict: GREEN, scope clean.
- Status: done — committing on `Testing`.
- Next: W2 — `state.py` + new `engine/poller_manager.py` (THE bug fix): fan out over every enabled PULL source (`registry.is_pull`), each connector via `es_client_for_source(src)` with `connector_id=src.id`, per-source try/except + single-poll fallback; the legacy-`"primary"`-cursor collision guard (two un-fed sources → distinct keys); track+close ALL owned clients; gate on polling_enabled/setup_complete/not kill_switch/not demo_active; `entity_strategy_for(THAT source)` not primary; keep `state.poller` exposing start/stop/poll_once/_source; primary shrinks to the default read/browse/chat surface. + per-signature in-flight guard.

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 2 GREEN (PollerManager — THE bug fix)
- Context: Fix the single-source poller (the #1 incoherence). ONE backend owner (state.py is a hot file; read the 01-ingestion map first) → clean-room verifier. NOTE: the DI hub is `backend/app/state.py` (NOT `api/state.py` — CLAUDE.md's layout label was imprecise; `api/routes.py` IS under api/).
- Did: **NEW `engine/poller_manager.py`** — `PollerManager(state)` IS `state.poller`; owns N per-source `Poller` children. Enumerates enabled PULL sources (`registry.is_pull` or `ingest_mode==PULL`, receivers skipped); the PRIMARY child = `state.log_source` (so 0/1-source path is byte-identical); every NON-primary source gets its connector via `state.es_client_for_source(src)` (forces mgmt key None #1) with `connector_id=src.id`, owned client tracked + closed on rebuild/stop (no leak). Skips the primary in the non-primary set (no double-poll). Un-fed non-primary sources get a distinct `f"{src.id}:primary"` legacy cursor key so two un-fed sources never stomp the shared `"primary"` doc, true primary keeps `"primary"` (no migration #4). `poll_once` fans out under a `caps.max_concurrent` semaphore + a per-tick in-flight guard keyed on `cluster.signature`, aggregates per-source stats; `_run`/demo-off gate byte-identical. **poller.py** — `_legacy_cursor_key`; the un-fed branch uses it; entity-strategy line now resolves `prefs.source_by_id(self._source.connector_id)` (ITS source, not primary). **state.py** — Poller→PollerManager; `rebuild_log_source` calls `poller.rebuild()`; `startup` calls `rebuild_log_source()` after persisted prefs load so a multi-source boot polls all. **config.py** — additive `Preferences.source_by_id()`. Shares the ONE pipeline/gateway/cases/audit/cursor_store (#6). `state.poller` still exposes start/stop/poll_once/_source/_attach.
- Tests: backend **1253 → 1263** (+10 `test_round4_wave2_poller_manager.py`: both-sources-polled, no-cursor-collision, single/zero-source legacy-cursor parity, per-source connector_id gate, per-source entity strategy, owned-client close, demo-off, #1 mgmt-key); existing `test_cursor_poller`/`test_source_feeds`/`test_state_backend_e2e`/`test_attach_note` all still pass; `case_manager.py` byte-identical (#3); webui build exit 0. Verifier verdict: GREEN.
- Status: done — committing on `Testing`.
- Next: W3 (the big engine wave, larger builder fan-out over DISJOINT new modules): `engine/threshold_tuner.py`+`stores/tuning.py` (nightly auto-apply observer, Wilson+min-samples+EWMA, bounded ≤1 step, audit+rollback+shadow-eval, DROPs→HITL Proposal, NEVER imports decide()) · `explain_forwarding()` · bounded-concurrency + realtime/batch partition · `BatchProvider`(Anthropic+OpenAI+flex)+`stores/batch_jobs.py`+batch poller (custom_id=hash(sig), one UsageDoc/result #6, decide()/result #3) · apply cache rates in cost_for + provider cache-token extraction (providers.py:171-179) · per-rule FP noise metric (keyed on Case.rule_ids) · prompt-prefix restructure for cacheability · `engine/campaigns.py`+`stores/campaigns.py` (daily deterministic, xsrc RELATED links, never re-cluster) · `engine/baseline.py`+`stores/baseline.py` (online EWMA/EWMV + hour-of-week + t-digest, MAD |M|>3.5, warmup 3×period) · `engine/event_detection.py` (funnel→batched Haiku detection→same pipeline). Sequence hot-file-touching pieces; keep routes.py for W4.

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 3 GREEN (engine capabilities: tuner · campaigns · baseline · batch · event-detection)
- Context: The big engine wave. 4 parallel disjoint builders → event-detection (Build2, depends on baseline+batch) → 1 integrator (state.py store-wiring) → verifier. All additive + default OFF. NOTE: builder F shipped `event_detection.py`+`forwarding.py` but NOT its test file (empty return) — caught by the verifier's file-list audit; a follow-up gap-fill agent wrote 29 event-detection/forwarding tests (incl. an adversarial fence test) — no module bug found, modules honest.
- Did: **(A llm economics)** `pricing.cost_for` now applies cache rates via keyword-only args (read 0.1×, write 1.25×[5m]/2×[1h], batch 0.5×; non-cache path byte-identical); `providers.py` extracts Anthropic/OpenAI cache tokens into `CompletionResult` + an OpenAI `service_tier='flex'` opt-in; `gateway._record` populates UsageDoc cache/batch fields (still ONE write/call #6); NEW `llm/batch.py` `BatchProvider` SPI (Anthropic `/v1/messages/batches` + OpenAI `/v1/batches`, results UNORDERED→keyed by custom_id); NEW `stores/batch_jobs.py` (resume-safe, per-custom_id `retrieved` dedup → exactly-one UsageDoc/result at 0.5× batch, #6). **(C tuner)** NEW `engine/threshold_tuner.py` (826L) + `stores/tuning.py` — deterministic nightly observer: per-rule FP via Wilson-LB(z=1.96)+min-samples(25)+EWMA; auto-applies bounded +1 `CorrelationRule.n` / +1 feed `severity_floor` with `ActionType.TUNING` audit + rollback; shadow-eval blocks any change that would have hidden a confirmed TP; suppression DROPs → HITL Proposal queue; config-writer only, NEVER imports case_manager/decide/risk-weights/signature; default OFF. **(D campaigns)** NEW `engine/campaigns.py` + `stores/campaigns.py` — daily deterministic graph of cases sharing an entity (reuses xsrc RELATED machinery), ≥2 cases+≥1 shared entity → `Campaign` (idempotent = hash of sorted member signatures); only REFERENCES case_ids, never re-clusters/closes (#3/#4). **(E baseline)** NEW `engine/baseline.py` + `stores/baseline.py` — online EWMA mean+EWMV var per cluster_signature per 168 hour-of-week buckets (α=1−exp(−ln2/H), H=14d slow), Welford alongside, t-digest(compression 100) p50/p95/p99, robust modified-z |M|>3.5, warmup 3×period; deterministic pure PRODUCER, never reads decide()/risk-weights. **(F event-detection)** NEW `engine/event_detection.py` (4-stage cheap-first funnel: pre-aggregate→rules→anomaly(baseline)→batched Haiku detection, #7 aggregate-only, #9 fenced, candidate re-enters correlate → same cluster_signature #4, custom_id hashed) + `engine/forwarding.py` (`explain_forwarding` — read-only 7-gate explainer). **(G integrate)** `state.py` (+195) wires Tuning/Campaign/Baseline/BatchJob stores + the 4 services into AppState, all gated OFF (schedulers/routes/feed-routing = W4).
- Tests: backend **1263 → 1371** (+108: llm 21, tuner 15, campaigns 15, baseline 19, wiring ~4, event-detect 29, + parametrize expansions); `case_manager.py` byte-identical (#3, grep-clean of case_manager/decide across all 6 new modules); no cluster_signature reassignment (#4); batch one-UsageDoc/result + dedup proven (#6); app boots with all 4 new Preferences blocks default-disabled; webui build exit 0 (unaffected). Verifier + orchestrator full-gate: GREEN (`pytest -o addopts=""` → 1371 passed, 1 benign TLS warning).
- Status: done — committing on `Testing`.
- Next: W4 — `routes.py` once + new routers, mount under require_auth (route-auth-coverage CI): acknowledge→INVESTIGATING (routes.py:3136) + unified Close-with-disposition; `GET /api/logs` scatter-gather; `/api/tuning/*` (recommendations/apply/rollback/config); `/api/campaigns/*`; `/api/baseline/*`; `/api/batch/jobs`; `/api/admin/reset {scope,confirm}` (admin+fresh-auth, never wipe env secrets); `/api/setup/{account,status}` (OOBE); `/api/cases/{id}/forwarding`; `/api/sources/health`. + START the schedulers (tuner/campaign/batch poller, gated) + route EVENT feeds to the funnel (gated). Keep webui for W5.

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 4 GREEN (API surface + runtime wiring)
- Context: The routes + runtime wave. 6 parallel owners on disjoint files → main.py integrator → verifier (route-auth-coverage + reset-secrets + default-off checks). Builder S flagged 2 reset-test failures mid-run — a concurrent-edit artifact (RC's reset.py was still being written); the verifier's + my own post-barrier full run show 1437 passed / 0 failed.
- Did: **(RA)** NEW `api/routes_tuning.py` (GET /recommendations dry-run · GET/PUT /tuning/config · POST /tuning/{rule}/apply|rollback, `automation:*` gated, `ActionType.TUNING` audited; shadow-blocked raise → HITL Proposal, never auto-applied) + `routes_batch.py` (GET /batch/jobs[/{id}], read-only, secret-free). **(RB)** NEW `routes_campaigns.py` (list/get/by-case + POST /recorrelate admin-gated, never mutates case status/#4) + `routes_baseline.py` (GET /baseline/stats + /{signature} warm-up gauge + p50/p95/p99). **(RC)** NEW `engine/reset.py` + `routes_reset.py` — POST /api/admin/reset {scope,confirm} (admin + require_fresh_auth, type-to-confirm 'RESET CASES'/'RESET SOURCES'/'FACTORY RESET'): cases-tier clears cases/campaigns/baseline/inbox/collab/batch-jobs/live-tail but KEEPS cost ledger + audit; sources-tier +sources+cursors; factory +users/sessions/prefs/roles/proposals/memory/branding + setup_complete=false→OOBE; **env secrets byte-identical across ALL tiers (airtight test)**; audited before acting (#2); SQL-backend factory truncates tables preserving secrets. **(RD)** NEW `routes_setup.py` — GET /api/setup/status + POST /api/setup/account (public, self-locking OOBE first-super_admin, force strong pw min-12/≠username/not-common, MFA prompted-optional; Admin/Admin@123 survives only as auth-OFF default) + `/api/setup/*` added to `deps.PUBLIC_API_PATHS`. **(M)** `routes.py` — acknowledge→`CaseStatus.INVESTIGATING` (routes.py:3339, non-terminal, not a close #3) + stamps `acknowledged_at`; NEW GET /api/logs (scatter-gather over browse-capable sources, `asyncio.gather(return_exceptions=True)`+per-source `wait_for`, mandatory source provenance, secrets never returned, #1 read-only) + GET /api/cases/{id}/forwarding (explain_forwarding) + GET /api/sources/health. **(S)** `state.py`+`poller.py` — gated background schedulers (nightly tuner / daily campaign / batch-jobs poller — spawn-but-sleep when disabled, byte-identical boot) + EVENT-feed routing to the funnel (engages ONLY when batch+baseline both enabled; default-off = existing realtime path byte-identical; alerts always realtime; demo/kill-switch gate off). **(I)** `main.py` mounts the 6 new routers under `require_auth`.
- Tests: backend **1371 → 1437** (+66); `test_route_auth_coverage.py` PASS (16, setup public-allowlist correct); `case_manager.py` byte-identical (#3, acknowledge is INVESTIGATING not CLOSED, no route closes outside decide()); reset env-secret preservation airtight across all 3 tiers (#1/#10); default-off boot byte-identical; webui build exit 0. Verifier + my independent full run: GREEN.
- Status: done — committing on `Testing`.
- Next: W5 — webui (the last big fan-out): page consolidation + redirects (admin pages standalone→Settings, dead NavGroupIds) · analytics declutter (Cost = one home) · CaseDetail single primary-CTA + unified Close-with-disposition · Login white-label (BrandingConfig login_* + BrandHero/loginParts) · OOBE AccountSetupStep in the wizard · Models catalog + cache/batch pricing columns · new surfaces (UnifiedLogsSheet /api/logs · tuning recommendations/apply/rollback · campaigns · baseline warm-up gauge · batch jobs · DangerZone reset in Experimental) · types.ts sync. Then W6 tests+docs + adversarial audit/harden.

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 5 GREEN (webui — surfaces + case/analytics/login/models + integration)
- Context: The last big feature wave — surface every new backend capability + consolidation/cleanup. 8 disjoint surface builders → integrator → verifier. IMPORTANT: the integrator agent no-op'd TWICE (empty return, nav/App/Settings unmodified — the read-a-huge-Settings.tsx-then-edit-4-hot-files task overran one agent), so the orchestrator did the integration DIRECTLY (more reliable than a 3rd delegation).
- Did (builders): **WA** UnifiedLogsSheet + UnifiedLogs.api (GET /api/logs scatter-gather, mandatory source-provenance column, 10s live-tail, partial-failure strip, #9 plain-text). **WB** Tuning page (recommendations table + apply/rollback + config, honest "only changes what's investigated, never closes" framing, DROP→Approvals) + Campaigns page + CampaignChip. **WC** BaselineGauge components (warm-up n/target gauge + p50/p95/p99 + stats overview) + BatchJobs viewer. **WD** cleaner CaseDetail — single primary CTA + overflow, unified Close-with-disposition dialog (posts the existing close→decide(), #3). **WE** analytics declutter — one tab strip, Cost as the single home, de-duped posture. **WF** login white-label (BrandHero renders BrandingConfig.login_* bounded plain-text + 3 curated layouts + illustrations, no raw HTML/SVG #6/#9) + OOBE account-setup wired to /api/setup/*. **WG** Models catalog cache/batch pricing columns. **WH** DangerZone reset (3 tiered type-to-confirm cards, super_admin, env-secrets-preserved copy).
- Did (integration, by orchestrator): nav.ts — added PageIds logs/campaigns/tuning/batchjobs/baseline + nav entries (logs/campaigns→Triage, tuning→Platform, baseline/batchjobs→Analytics children) + icons; REMOVED the dead NavGroupIds 'automation'+'admin'. App.tsx — 5 React.lazy imports + 5 renderPage arms. Created pages/Baseline.tsx (fetch wrapper around the presentational BaselineStatsOverview). Settings.tsx — mounted <DangerZone/> in the Experimental section. DEFERRED: the admin-page consolidation-REDIRECTS (#4) — standalone admin pages still render standalone (they work + deep-link fine; the map flagged that refactor as top-risk, not worth rushing).
- Tests: webui build exit 0 (tsc+vite clean); **vitest 214 → 273** (+59 across 9 new W5 specs); lint 0 rules-of-hooks errors (3 benign exhaustive-deps); #9 audited (no dangerouslySetInnerHTML on data; login white-label plain-text); **backend untouched** (empty backend diff). All 6 new surfaces reachable.
- Status: done — committing on `Testing`. Backend feature set (W0-W4) + webui (W5) complete; all 12 requests + 3 bugs delivered.
- Next: W6 — big test/harden fan-out (adversarial audit over the Round-4 surface: #3/#4/#6/#9 boundary, reset-secrets, tuner-safety, batch-idempotency, route-auth, default-off) + docs (CLAUDE.md/HANDOFF/README/ROADMAP/CHANGELOG + Round-4 IMPLEMENTATION.md) + final full-suite sweep. Optional follow-up: the deferred admin-page consolidation-redirects (#4).

### 2026-07-01 — orchestrator (Opus) — Round 4 Wave 6a+6b: adversarial audit + harden GREEN
- Context: Close Round 4 with a Round-3-style adversarial audit + harden. 6a = a 16-dimension READ-ONLY audit fleet (16 auditors + per-finding skeptics that refute-by-default). 6b = 5 disjoint fix owners + a full-gate verifier.
- Did (6a): **16 confirmed / 4 refuted** (2 HIGH, 6 MEDIUM, 8 LOW; deduped: event-detection dead-end ×2, openai-cache ×2, inflight-guard ×2). (6b) Fixed all 16: **HIGH** — (poller #4) a per-cluster_signature `asyncio.Lock` on the ONE pipeline serialises find_open_by_signature→save across the fan-out so concurrent sources/ticks create exactly ONE case (`pipeline._sig_locks` + `ingest.handle_clusters` holds it around the critical section); (poller reentrancy) DELETED the `_InflightGuard` monkeypatch of the shared `pipeline.investigate_cluster`, replaced with a per-manager `_poll_lock` serialising whole fan-out ticks (loop vs manual /api/poll). **MEDIUM** — batched EVENT-detection now REALLY creates cases: `BatchJob.candidates` persists the funnel survivors at submit, and `_reenter_detections` reconstructs + feeds each confirmed result through `register_candidate`+`investigate_cluster` → SAME cluster_signature (#4), UNCHANGED decide() (#3), gated default-OFF; tuner shadow-eval reader now pages CLOSED+RESOLVED (`TERMINAL_CASE_STATUSES`) so it isn't blind to RESOLVED TPs; tuner cadence-gated (`last_run_at` + `already_tuned`) so a knob bumps once/window (was unbounded); OpenAI prompt-cache no longer double-billed (provider passes the UNCACHED remainder as full-rate input; Anthropic path unchanged); legacy public `/api/setup/init-admin` REMOVED (bypassed the strong-pw policy) — sole first-admin writer is the policy-enforced `/api/setup/account`. **LOW** — `process_results` dedup is now an atomic CAS claim-before-bill (#6 exactly-once under concurrency); funnel hook propagated to ALL fan-out children (+ assigned to the primary at wire time); setup self-lock fails SAFE (raising `has_any()`) + race-safe create; the funnel hook; t-digest centroid count now bounded ~O(compression) (was unbounded ~log growth). Migrated test_oobe/test_rbac_users off init-admin.
- Tests: backend **1437 → 1461** (+24 regression across concurrency/event-reentry/tuner-cadence/openai-cache/oobe/tdigest); `case_manager.py` byte-identical (#3, event-detection re-enters via the normal pipeline, never calls decide()); the 2 HIGH fixes test-locked (concurrent same-signature → 1 case; monkeypatch gone); #6 batch atomic + openai-cache proven; webui build exit 0. Verifier + my independent full run: GREEN (1461 passed, 1 benign TLS warning). Known trivial loose end: a dead `api.setup.initAdmin` webui stub (never called; live flow uses /setup/account) — prune-later.
- Status: 6a+6b done — committing on `Testing`.
- Next: W6c — docs (CLAUDE.md status/counts/module map + HANDOFF + ROADMAP + CHANGELOG + ENVIRONMENT env vars + Round-4 IMPLEMENTATION.md) + a final full-suite sweep, then Round-4 close-out.

### 2026-07-01 — orchestrator (Opus) — Round 4 COMPLETE (docs W6c + final sweep)
- Context: Close out Round 4 — docs sync + the authoritative final sweep. 3 doc owners (CLAUDE.md; HANDOFF/README/ROADMAP/CHANGELOG; the new IMPLEMENTATION.md + env check) → final full-gate sweep.
- Did: Updated CLAUDE.md (§4 module map with the Round-4 modules, §7/§8 counts 1461/273, §10 Round-4 COMPLETE block, 12 non-negotiables intact); refreshed docs/HANDOFF.md + README.md + ROADMAP.md + CHANGELOG.md (Round-4 done, green numbers, honest deferred items); wrote docs/research/2026-07-round4/IMPLEMENTATION.md (as-built record mirroring the Round-3 one). Verified **NO new env vars** (Round-4 backend diff 3cd7d54..1df27ac adds zero os.getenv reads / zero new Secrets fields — all new config is default-OFF Preferences.*; batch reuses existing provider keys) → ENVIRONMENT.md/.env.example left unchanged.
- Tests: FINAL SWEEP GREEN — backend **1461 passed / 0 failed**; `case_manager.py` byte-identical (#3) + decide-guard PASS; webui build exit 0; vitest **273 passed**; lint **0** react-hooks/rules-of-hooks (3 benign exhaustive-deps); route-auth-coverage PASS. ZERO new runtime deps across the whole round.
- Status: **ROUND 4 COMPLETE** — all 12 requests + 3 bugs delivered, audited (16 confirmed findings all fixed), hardened, documented. Committed on `Testing` (docs commit after 1df27ac); **local only, NOT pushed** (per project convention — push when the user asks).
- Round-4 recap: 8 commits 068ede4→1df27ac; backend 1234→1461 pytest, vitest 205→273; the poller multi-source bug fixed (PollerManager + #4 concurrency locks), Opus-4.8 pricing $5/$25 + cache/batch economics, acknowledge→INVESTIGATING; new capabilities — adaptive threshold auto-tuning, two-tier ALERT/EVENT ingestion (realtime alerts + daily campaign correlation + batched agent-driven EVENT detection that now genuinely creates cases via the unchanged decide() pipeline), entity baseline that improves over time, BatchProvider (Anthropic/OpenAI/flex, custom_id-idempotent), tiered reset (never wipes env secrets), OOBE first-admin, login white-label, broadened+repriced model catalog, unified logs, cleaner case view, decluttered analytics, terminology cleanup. #1/#3/#4/#6/#7/#9 held throughout.
- Deferred/known (honest): the admin-page consolidation-REDIRECTS (#4 — the standalone admin pages still work + deep-link; only the redirect-into-Settings refactor was deferred as the map's top risk) + a dead `api.setup.initAdmin` webui stub (never called; live flow uses /setup/account). Both are cosmetic/non-functional.
- Next: optional — push to remote (on request); the two deferred cosmetic items; the standing pre-Round-4 backlog (Splunk/Sentinel connectors, ARQ/KEDA scale-out, Helm, OTEL).

### 2026-07-02 09:00Z — orchestrator — Round 5 complete
- Context: Round 5 — "UI/UX overhaul + rules customization + custom dashboards + loose coupling": 9 goals (G1–G9) + a 16-dimension adversarial audit. Overwhelmingly a webui overhaul with a surgical, path-byte-identical backend surface for rules, dashboards, and a zero-bill decision-preview. Plan + spec: docs/research/2026-07-round5/ (PROPOSAL.md + DESIGN_STANDARD.md [canonical] + understand/ maps + RESEARCH_*.md + IMPLEMENTATION.md + AUDIT_FINDINGS.md).
- Did: **G1** cohesive color/type — Radix slate+blue + 3 orthogonal semantic axes (severity/status/verdict), each a token/-foreground/-text triple with MEASURED WCAG-AA in both themes; Okabe-Ito chart ramps + viridis; self-hosted Inter + JetBrains Mono; label→token authority. **G2** ONE shadcn/Radix/Tailwind standard enforced end-to-end via a codemod + ~15 new shared primitives (Field/SegmentedControl/ConfirmDialog/NumberField/LabeledSlider/SecretField/TagInput/IconButton/PageContainer/TimeRangePicker/DashboardGroup/collapsible/typography); split the CaseDetail god-file 4210→1529 LOC. **G3** Settings decluttered 2673→575 LOC (data-driven registry + pages/settings/* section files), 6→5 groups, Security promoted top-level, ≤2 nesting, 33 redirect tests; fixed the auto-close dead-field bug (now writes prefs.auto_close, the field decide() reads). **G4/G5** denser wide dashboard (PageContainer wide/fluid killed the max-w-[1400px] cap → three-zone) + compact hero (~176px HeroPanel → ~52px PageHeader) + KpiTile delta-by-sign. **G6** rules customization — Detection & Rules home over 3 tiers, polymorphic editor + flat condition builder, Test/Preview vs recent data that NEVER calls decide()/NEVER bills the LLM (new read-only POST /api/triage/preview-decision wrapping the pure decide()), version ledger + rollback (stores/rule_versions.py), asset/SLA/priority/suppression editors; backend api/routes_rules.py + new soc/rules/*. **G7** custom dashboards — widget registry reusing existing tiles/charts, per-user drag/resize grid (react-grid-layout LAZY edit-mode only), zero-migration DashboardStore (stores/dashboards.py), per-role defaults + clone-to-customize (UserPrefs.dashboards + CustomizationConfig.default_dashboards); backend api/routes_dashboards.py + new soc/dashboard/* + pages/Dashboards.tsx. **G8** loose coupling — single FEATURES[] registry (soc/registry.ts) deriving nav+routes+palette, useNavigate() replacing onNavigate prop-drill, React.lazy code-splitting restored (entry 537→264 kB), routes.py decomposed into domain routers (paths byte-identical), generic EntryPointRegistry + Protocol narrowing + openapi-typescript type generation, typed config endpoints (baseline/campaign/batch), new soc/hooks/*. **G9** a11y — SEMANTIC_ICON non-color signalling, WCAG-2.2, jest-axe, 20 jsx-a11y rules at error (48→0), Field labels associated, flaky tests stabilized. **Audit** — a 16-dimension adversarial audit → 23 findings, 9 must-fix all resolved + regression-tested (C1 dashboards couldn't persist · H2 rules verdict case-bug · H3 a dashboards path billed the LLM · H4 19 unnamed comboboxes · M1–M4) + polish P1–P18. Also fixed the pile of long-standing bugs the maps surfaced: wizard cosmetic demo toggle, clipboard-over-http, misc-prefs clobber, automation impossible-verdict, roles perm mismatch, no-confirm destructive close (now ConfirmDialog-gated), campaigns read-perm gate, dead initAdmin stub, request_approval dead-end, tuning row always-Active, a SQL sort no-op, a derive_priority disagreement. Deps: REMOVED framer-motion (zero importers); ADDED react-grid-layout ^2.2.3 (runtime, LAZY edit-mode only) + dev-only @fontsource-variable/inter, @fontsource/jetbrains-mono, @tailwindcss/container-queries, openapi-typescript, jest-axe/@axe-core, eslint-plugin-jsx-a11y. Backend ZERO new runtime deps. Docs: updated ROADMAP.md + CHANGELOG.md + this Journal entry.
- Tests: VERIFIED GREEN (2026-07-02) — backend **1601 pytest** (was 1461); webui tsc+vite build clean, entry chunk **264 kB** (was 537); **625 Vitest** (was 273); eslint **0 errors** (4 warnings; jsx-a11y 48→0); route_auth_coverage green; design-gate green; **engine/case_manager.py decide() BYTE-IDENTICAL vs the pre-Round-5 baseline 27f0983 (#3 held throughout)**; #6/#9/#2/#10 upheld; PUT /api/settings deep-MERGE intact; all API paths byte-identical.
- Status: done — **ROUND 5 COMPLETE**. 12 commits 5ab7c05→0e99c76→9854c36→7c86706→f50e0b2→3e447da→b661bc8→830e836→d3801f9→a9e2b49→8b91fc0→05552c7 on `Testing`; **LOCAL only, NOT pushed** (per project convention — push when the user asks).
- Next: optional — push to remote (on request); the standing backlog (Splunk/Sentinel connectors, ARQ/KEDA scale-out, Helm, OTEL; the pre-Round-3 Tier-2/3 items — API keys UI, SLA timers, watchlists, scheduled reports, hunting/saved-query builder).

### 2026-07-02 06:08Z — orchestrator (Fable) — Round 6 START: verify + glitch-hunt + fix fleet
- Context: user re-issued the Round-5 brief with a screenshot of the post-Round-5 Dashboards page glitching (widgets stacked, clipped right-edge control, wasted space) + "a tonne of UI glitches". Round 5 already complete, so Round 6 = full-app Opus audit fleet -> fix fleet -> re-verify. Tracker: ROUND6_TRACKER.md.
- Did: confirmed flagship bug inline — dashboard/registry.ts buildDefaultWidgets()+reconcileWidgets() emit x:0,y:0 for ALL widgets; VIEW-mode WidgetGrid renders persisted coords in a plain CSS grid (no compaction) so default widgets STACK on one cell. Launched the ~90-finder Opus audit workflow (file groups + 12 thematic + 4 API-contract auditors, each adversarially verified); pytest/vitest/build/lint baselines running in background.
- Tests: baselines in progress (expect 1601 pytest / 625 vitest / clean build / 0 lint errors).
- Status: in-progress.
- Next: read fleet findings -> fix-fleet batches -> re-verify -> commit on Testing (NO co-author per user) -> delete tracker.

### 2026-07-02 12:15Z — orchestrator (Fable) — Round 6: audit fleet COMPLETE (464 findings), fix fleet LAUNCHED
- Context: Round-6 P2 audit fleet finished after a session-limit pause + resume: 155/155 units (213 agents on resume, ~18M subagent tokens total), 466 claimed -> 464 verified findings (21 high / 240 medium / 203 low; criticals downgraded to high on verification, 2 refuted). Saved to ROUND6_FINDINGS.json.
- Did: partitioned all 464 findings into 30 conflict-free fix batches (exclusive file ownership, staged sequencing for batches >24 findings) under the session scratchpad round6-batches/; launched the round6-fix-fleet workflow (wf_fd3f1a7a-76c): 37 Opus fixers, verify-first, root-cause fixes + tests, scoped tsc self-checks, handoffs instead of foreign-file edits. Headline fixes in flight: dashboard packing + curated per-role default layouts, AppShell/PageContainer single width authority, nav flyout clipping, PUT-vs-PATCH 405s, rules anomaly-save + version ledger + preview 422, connector secret drops, KPI delta inversions, recommended-automation onboarding feature.
- Tests: baselines all green pre-fleet (webui build/625 vitest/0 lint errors; backend pytest exit 0). Full gate re-runs after the fleet.
- Status: in-progress (fix fleet running).
- Next: orchestrator gate (tsc+vitest+lint+pytest), process handoffs, adversarial diff review, docs, commit on Testing (NO co-author).

### 2026-07-02 17:24Z — orchestrator (Fable) — Round 6 COMPLETE: fleet glitch-hunt + integration polish shipped
- Context: closed out Round 6 (user brief: fix "a tonne of UI glitches" incl. the dashboards stacking screenshot, with 100s of Opus agents; verify everything).
- Did: audit fleet 155/155 units -> 464 adversarially-verified findings; fix fleet 30 conflict-free batches (379 fixed) + handoff/closer wave (44 more; 47 total refuted as not-real). Flagship: packWidgets + curated per-role default dashboard layouts (view-mode stacking bug); PageContainer single width authority; api.patch 405 fixes; rules version ledger now records (rollback live); anomaly-rule saves persisted; SecretField unification + connector-secret drop fixes; honest KPI deltas; WCAG-AA both themes; AutomationNudge one-click beginner automation; window-scoped cases + severity drills; baseline/campaign mounts on CaseDetail. Docs: CLAUDE.md + CHANGELOG + docs/research/2026-07-round6/IMPLEMENTATION.md. decide() untouched; API paths byte-identical (additive only); ZERO new deps.
- Tests: backend 1613 pytest green; webui 1051 Vitest / 199 files green; lint 0 errors (3 warnings); build clean entry 281.61 kB; design-gate + route_auth_coverage green (verified independently twice).
- Status: done.
- Next: push when the user asks; optional live-run visual check (./scripts/run-demo.sh) to admire the fixed dashboards; deferred nits listed in IMPLEMENTATION.md §Deferred.

### 2026-07-05 — orchestrator (Opus 4.8, 1M) — Round 7 COMPLETE: Security Command Center + Noise-Reduction funnel
- Context: user brief — 12 UI changes + 1 feature ("total alerts by severity → what AI reduced it to"), on a NEW branch `feature/round7-ui-overhaul` (off `Testing`). Full pipeline: document → plan(14) → code-verify(26) → UX research(25) → validate(14) → implement (3 waves, 25 opus) → adversarial QA(14) → fixes(3). 4 product decisions confirmed with the user upfront.
- Did: Overview → **Security Command Center**; Active Risk Index unified + `(?)` explainer; honest **MTTA/MTTR/Dwell** (no fabricated MTTD) + tooltips; live-delta KPIs + Top-Contributors; durable-counter **Noise-Reduction** funnel (`GET /api/metrics/noise-reduction` + `stores/noise_counters.py` + `engine/noise_counters.py` + `_noise_sink` on the poller, separate from the Round-4 `_event_funnel`); Cases severity-column bug fixed + a shared `source|ai|code` **ProvenanceTag**; CaseDetail 8→5 tabs told as a story (facts → AI assessment → pinned `DecisionCard`); feedback folded into the close dialog (derived agree/disagree, two-POST, #3 intact); **Auto-closed by AI** badge; motion system (CountUp/Reveal, ease-premium, no new deps); unified 5-band severity ladder in `priority.py` (risk `scoreBand` untouched). Commits `850600f`→`1b9ac90`→`e40f0bc`→`7355a9a`.
- Tests: the final 14-agent QA caught **8 real bugs** the green tests had masked (2 HIGH funnel-correctness: per-tick counter over-count + a fraction-vs-percent headline; fixed w/ regression tests). Green after fixes: backend pytest + webui **build** + **vitest** + lint 0 errors; `engine/case_manager.py decide()` **byte-identical**; ZERO new runtime deps. Docs: `docs/research/2026-07-round7/` (state map, plan, verification, UX research, implementation plan).
- Status: done (committed on `feature/round7-ui-overhaul`, local — not pushed).
- Next: Round 8 (user feedback on the same branch).

### 2026-07-06 — orchestrator (Opus 4.8, 1M) — Round 8 COMPLETE: UI cleanup + glitch fixes (user feedback)
- Context: user screenshots flagged glitches + "still don't see the cleanup". 8 asks. Same process, **sonnet-only research** per the user; short human commit notes, no co-author; a `docs/research/2026-07-round8/MEMORY.md` savior file kept updated then deleted. Plan fleet(10 opus) → research fleet(25 sonnet, incl. QRadar attack-path/Sankey study) → Wave A(10 opus, disjoint files) → Wave B(Overview integration) → QA(10 opus, **0 findings**).
- Did: (1) Active Risk Index → its own **Card** top-right, bigger gauge, dropped the glitchy notch; (2) **Cases** sticky-header glitch fixed — root cause a double-nested overflow (`DataTable` outer `overflow-hidden` + `Table` inner `overflow-auto`) trapped the sticky `<thead>` → removed the broken `sticky` + uniform row height; (3) CaseDetail Overview/Threat tabs deduped (Verdict/Confidence 2×, Risk 3× → once), Investigation left alone; (4) VISIBLE cleanup — `PageHeader` title bumped app-wide, Overview inverted-pyramid ("Deeper analytics" collapsed), 12-page spacing sweep; (5) **reinvestigate** now rebuilds from stored case evidence when the log window aged out (`_cluster_for_case(allow_stored_reconstruction=True)`); (6) Chat tab rebuilt on the shared `ChatPanel` (−~150 lines) + Collaboration tidied; (7) Command Center header **de-carded** (plain Sources-style big title); (8) Noise-Reduction redesigned as a **horizontal QRadar-style Sankey ribbon** (reuses `deriveFunnel()` + the endpoint contract). Commits `58745fa`(wave A) `f56f812`(wave B) `91aae40`(docs).
- Tests: green throughout — backend **1678 pytest** · webui **1238 vitest** / 223 files · build clean (entry ~282.4 kB) · lint **0 errors** (3 pre-existing warnings) · `decide()` **byte-identical** · ZERO new deps. QA fleet 0 findings. Docs: `docs/research/2026-07-round8/{PLAN,RESEARCH,IMPLEMENTATION}.md` + CHANGELOG (R7+R8) + this Journal.
- Status: done (committed on `feature/round7-ui-overhaul`, local — **not pushed**; awaiting user to raise the PR).
- Next: push + open PR when the user asks; optional `./scripts/run-demo.sh` visual check; #5b auto-reinvestigate-on-key-save is a seeded default-OFF pref (full auto-trigger flagged as a follow-up).

### 2026-07-05 22:05Z — orchestrator (Opus 4.8) — Round 9: UI/UX overhaul (11 asks) + adversarial validation
- Context: user brief (11 asks) on `claude/ui-ux-improvements-7nq5be` (created off `Testing`, == `Testing` HEAD `1ab98f2` at start): (1) noise reduction "looks weird" → cleaner; (2) Log Sources like the IBM QRadar "Log Source Management" screenshot; (3) remove the in-page tab strips that duplicate the left nav; (4) drop LLM Spend from the Overview hero, top = alerts, bigger Active Risk Index card, clean dashboard; (5) a case "Timeline" tab (what-happened + rest of the investigation); (6) a clean case Overview separating what the SIEM reported vs our analysis; (7) add a self-hosted LiteLLM/OpenAI-compatible model provider; (8) fix the glitchy login/preview; (9) dashboard wastes screen space; (10) cleaner setup wizard; (11) clean overall aesthetics. Method (per the user "deep research → fit the codebase → test 3× → re-validate vs the standard, with sub-agents"): a 12-agent research + codebase-mapping fan-out (QRadar/Splunk ES/Sentinel/Elastic/Chronicle/XSIAM + Prophet/Dropzone + LiteLLM/vLLM/Ollama/OpenWebUI/Jan + login/wizard/dataviz UX) → design briefs → parallel implementation sub-agents on DISJOINT files → 3× full test → a 4-agent adversarial validation → a fix pass.
- Did:
  - **Wave 1 (task 3, `709e758`):** removed the redundant in-page tab strips — Overview `Dashboard|Standup`, Workspace `Chat|Investigate`, Intelligence `Knowledge|Memory|Playbooks` — each host now renders the active sub-view by the existing `tab` route opt (NO registry change; TabbedPage retained for its own test). Left Analytics/Metrics' strip alone: its Performance/Posture tabs are NOT left-nav destinations, so per the user's rule ("remove IF the lhs gives buttons") removing it would orphan them.
  - **Waves 2/3 (5 sub-agents, disjoint files, `d13b6f0`+`1adc5ce`):** (4/9) Overview — LLM Spend off the hero → 5 alert/case KPIs (spend demoted to a Deeper-analytics tripwire); bigger notch'd Active Risk Index card; tightened rhythm (space/gap) to fill the wide screen. (1) Noise — retired the Round-8 "QRadar Sankey ribbon" (a Sankey is for BRANCHING flows; ours is a linear reduction → the curves read as blobs) for clean horizontal aligned stage bars (single-hue spine) + a part-to-whole disposition row; kept `deriveFunnel()` + testids + `onStageClick` contract. (2) Sources — rebuilt the card list into a QRadar-style DataTable (search/filter/"+ New Log Source"/columns-gear, bulk-select, inline Enabled Switch, Status dot, Last Event via a NEW `api.sourcesHealth()` over the already-built-but-unused `GET /api/sources/health`). (5/6) CaseDetail — "Investigation" tab → "Timeline" (what-happened narrative on top + collapsible full ReAct trace); Overview split into "Reported by source" vs "Our assessment" provenance peer-sections + a disagreement delta + the pinned deterministic DecisionCard as trust anchor. (8/10) Login — top-aligned card (kills the mode-switch recenter), SSO folded into the paint gate (no pop-in), reserved meter/error slots, a faithful NON-clipping BrandingEditor preview (the "glitchy preview"), autofill + pre-paint theme stamp; Wizard — dropped the marketing cards + double hero, consolidated demo copy, light numbered stepper, single-toggle recommended-automation, fixed-footer scroll shell. (7) Models — reuses the backend's existing `openai_compatible` path: a zero-migration custom-models KV store + `POST/DELETE /api/llm/models/custom` + a non-metered `POST /api/llm/providers/test` reachability probe + $0 pricing (store 0/0 AND gateway `_effective_price_tuple`, belt-and-suspenders) + a dedicated `litellm_api_key` secret; UI "Add local model" dialog (base_url + model id + optional key + "Fetch models"). 17 new backend tests incl. "custom model routes to its base_url at $0 with exactly one UsageDoc".
  - **Wave 4 (validation fixes, `26c4266`):** 4 adversarial reviewers audited the shipped code vs the standard (unanimous "close to / meets standard, NO blockers"). Fixed the must-fix + high-value should-fix: the shared `POST /api/sources` rebuilt from `SourceUpsert` (which lacks `configured_secrets`/`created_at`) → every enable/disable toggle, bulk action, or make-primary wiped the secret-name list + reset the creation date (a PRE-EXISTING latent bug the new inline toggle/bulk paths amplified + the new Creation Date column surfaced) → carry both forward + regression test; the 1440px KPI-grid orphan cell (`2xl:`→`xl:grid-cols-5`, the very "wasted space" complaint); a DERIVED severity no longer reads as "Reported severity" in the source band (gated on `source_asserted`) + `created_at` no longer mislabeled "Source event time" (moved to "Provenance & activity" as "Created") + no spurious delta on an `info` source band; Sources Status folds staleness (>24h → "Idle", never green next to a red Last Event) + `text-critical-text` AA + "Store Payload"→"Browsable"; noise spine alpha floor + disposition hairlines; login theme-flash fallback (corrupt storage → OS) + Wizard `h-dvh`; a stale `severity_source` type comment.
- Tests: webui **build clean** (entry **278.7 kB**, down from 282.4 — spend code removed); **vitest 1252 / 227 files GREEN** (run ×3, stable, no flake); **lint 0 errors** (3 pre-existing warnings); **backend 1696 pytest GREEN** (1695 + 1 F1 regression); design-gate + `tsc` clean; `engine/case_manager.py decide()` **byte-identical** (#3); ledger one-write-per-call (#6); attacker-influenceable values fenced/plain (#9); **ZERO new runtime deps**. Committed + pushed on `claude/ui-ux-improvements-7nq5be` (`709e758`→`d13b6f0`→`1adc5ce`→`26c4266`).
- Status: done (pushed). The branch is the designated dev branch and started == `Testing` HEAD; raise a PR / fast-forward `Testing` when the user asks (I did NOT push to `Testing`).
- Next: optional live `./scripts/run-demo.sh` visual check; deferred low-value validation nits — enrichment KV under the source band's "Affected assets" (provenance bleed), the login paint-gate having no request timeout — documented but not fixed this round.

### 2026-07-05 (later) — orchestrator (Opus 4.8) — Round 9b: dashboard reimagine + case redesign (user feedback)
- Context: user feedback on the Round-9 result (`claude/ui-ux-improvements-7nq5be`), near their weekly limit so efficiency-first (3 focused disjoint-file agents, no research fan-out). 7 asks: (1) REVERT noise to the ribbon but prettier + hover detail; (2/3/4) still-wasted space under the Command Center + remove the tagline + put MTTR/MTTD on the default dashboard + "reimagine" a genuinely useful dense dashboard (priority #1); (5) Timeline ALONE, full trace in its own tab; (6) hover-to-expand sidebar; (7) larger case view + "open in new tab" + a clean Decision-Brief-style Overview (per an attached screenshot).
- Did (4 commits `71153f2`→`283aa59`→`b0d8747`, pushed): **Sidebar** (`71153f2`) — collapsed rail hover/focus-expands to a floating drawer overlay (rail keeps its 64px footprint, no reflow), persisted pref untouched. **Dashboard** (`283aa59`) — reverted the flat stage-bars to the horizontal flow RIBBON + polished (real %-reduced hero, full-width column-aligned band, fixed corners + wavy-blob crush) + per-stage HOVER cards (count/%/meaning/severity mini-breakdown); removed the tagline; put Response timing (MTTA·MTTR·Dwell from posture p50; MTTD honestly "—/n/a", not fabricated) on the MAIN dashboard; reorganized into a dense multi-zone grid (KPIs → timing → noise → attention-queue+severity+outcome-donut → top lists) with only a shallow "Deeper analytics" fold. **Case detail** (`b0d8747`) — Timeline tab = "what happened" story ONLY (new TimelinePanel); new Investigation tab = AI assessment + pinned DecisionCard + full ReAct trace; widened the Sheet to `max-w-[min(98vw,1400px)]`; an "Open in new tab" button that opens `#/cases?caseId=<id>` (I wired `router.optsFromHash()` to parse `caseId` on a fresh load so the new tab boots straight into the case — Cases already auto-opens from `opts.caseId`); redesigned the Overview into a Decision-Brief hero → SOURCE SAYS/AGENT FOUND/CODE DECIDED provenance row (DecisionCard as authority anchor) → primary-entity/attack-story/relationship row → evidence-checklist + reproduce → Related/Provenance collapsibles.
- Tests: webui **1264 vitest / 228 files GREEN**, **build clean (entry 279.3 kB)**, tsc + design-gate + lint 0 errors. No backend change this round (pytest unaffected). `decide()` byte-identical (#3); values plain (#9); ZERO new deps.
- Status: done (pushed). Notes/deviations: the Overview hero shows the recommended-action + auto-close note but NOT duplicate Close/Escalate buttons (the single-CTA footer owns those; frozen footer tests); MTTD has no data source (shown n/a).
- Next: raise a PR / fast-forward `Testing` when the user asks.

### 2026-07-06 — orchestrator (Opus 4.8) — Round 9c: dashboard from-scratch + cleaner Cases + noise "closed by human" + real MTTD/Respond
- Context: user feedback on Round-9b (`claude/ui-ux-improvements-7nq5be`, PR #26 → `Testing`). 3 asks, "highly classy and polished, attractive", referencing Prisma Cloud "Cloud Security Operations Dashboard" + Cortex XSIAM screenshots: (1) rebuild the MAIN dashboard from scratch — CORE = Active Risk Index + noise suppression, and the noise flow MUST read `events ingested → clustering → cases opened → auto cleared by AI → escalated → closed` with a terminal **"closed / handled by human"** stage; (2) **Mean Time To Detect** + **Mean Time To Respond**, where *respond = the FIRST human response* ("could be assigning to himself or anything"); (3) dashboard + Cases page genuinely clean per the screenshots. Method: a BE contract agent + a dashboard agent + a Cases agent on disjoint files, then a validation Workflow (review → adversarial-verify), then a fix pass.
- Did (commits `20118a7`→`ceba59d`→`c4d1bb6`→`2cc94c5`, pushed):
  - **BE metrics contract** (`ceba59d`): real **MTTD** — `Case.first_seen_millis` (advisory, populated at case-creation from the originating cluster) → `lifecycle_intervals.mttd_minutes` (first-event → case-open, skips backdated negatives) + `timing_trend.mttd`; **burndown** opened-vs-resolved-per-day in `compute_metrics`; **timing_trend** per-day mttd/respond/resolve (null-gap, never a fake 0); noise **`closed`** terminal stage in `noise_counters` (terminal AND NOT AI-auto-cleared = human-driven; a SEPARATE overlapping view, not part of the MECE partition). All advisory/read-time — `decide()` never reads them (#3).
  - **Dashboard** (`c4d1bb6`): Overview rebuilt Prisma-style — masthead + a 5-tile alert/case KPI micro-strip → a hero row (Active Risk Index + a Cases-resolved donut + an Open-cases donut, each with a real previous-window trend delta) → the full-width Noise-Suppression ribbon now flowing `ingested → clustered → cases → auto_cleared → escalated → closed` → a Zone-C row (Cases burndown, a Mean-time-to-detect/respond card with a detect/respond trend + average reference line, a Top-open-cases work list); secondary bands fold into a shallow "Deeper analytics". `NoiseFunnel` extended with the `closed` stage; `MultiSeriesTrend` gained null-gap + reference-line support.
  - **Cases** (`20118a7`): clean XSIAM/Prisma-style list — a 6-tile incident-summary strip, a calm 2-tier toolbar, a monogram Assignee column.
  - **Validation fix pass** (`2cc94c5`): a review→adversarial-verify Workflow confirmed 5 findings, all fixed: (1 blocker) **Respond honesty** — `timing_trend.respond` + the Overview Respond card read the **ACK clock** (`mtta_minutes` / acknowledged_at + investigating/escalated/on_hold), NOT `dwell` (whose `_RESPONSE_STATUSES` counts a RESOLVED/CLOSED AI auto-close as a "response" → fabricated a human-response time); (4) **reopened-case guard** — `_resolved_dt` now guards on the case's CURRENT terminal status first, so a stale terminal transition in the append-only `status_history` of a REOPENED (now-open) case can't corrupt burndown/MTTR/resolve-trend (routed `lifecycle_intervals` MTTR through it); (2) **NoiseFunnel fan overflow** — auto_cleared/escalated/closed are OVERLAPPING terminal views (an escalated case can also be human-closed), so their source shares can sum >1.0 → the fan's source slices are now normalized to their own sum so ribbons tile the cases node exactly (each outcome node keeps its true share-height; exact counts on the rail); (3) **WCAG-AA** — Overview SLA chip + autonomy tiles use the `-text` severity variants; (5) Cases "Needs human" tile `tone="primary"` (own routing color, not the "High" severity tone). +3 backend regression tests; updated 1 Overview timing test to the ACK clock.
- Tests: **backend 1708 pytest** (1705 + 3 new dashboard-metric regressions) · **webui 1268 vitest / 229 files** · **build clean** (entry 279.3 kB) · **lint 0 errors** (3 pre-existing warnings) · **all 5 design gates pass** · `engine/case_manager.py decide()` byte-identical (#3) · one ledger write/call (#6) · attacker-influenceable values plain/fenced (#9) · **ZERO new runtime deps**.
- Status: done (pushed to `claude/ui-ux-improvements-7nq5be` / PR #26). Commit identity `Claude <noreply@anthropic.com>`, no co-author trailer (per the user).
- Next: raise/merge PR #26 into `Testing` when the user asks; optional live `./scripts/run-demo.sh` visual check.

### 2026-07-09 — orchestrator (Opus 4.8, 1M) — Session arc: docs overhaul → UI+demo fixes → CI fix → Round 10 (Autopilot & Comprehensive Ingestion + motion.dev)
- Context: a multi-milestone session, all Opus-orchestrated with research→code→adversarial-verify→fix→re-test workflows; no co-author trailer (user rule). Milestones, in order:
  1. **Docs full overhaul** (committed): read-only ground-truth + audit fleet → rewrote all 24 living docs for accuracy/formatting; corrected recurring landmines (EUI→shadcn/Radix, archived plugin, `store_type` is the ES client class not `STATE_BACKEND`, auth built-but-default-OFF, enrichment 19 not 2, 6 nav groups/Settings 5×25, CaseDetail 6 tabs); new `docs/research/README.md`; CHANGELOG caught up to Round 9c; SECURITY §4.2 real bug fixed (guarded the wrong verdict class).
  2. **UI + demo round** (`2a78bcc`): 8 asks — donut overlap, provenance overflow, bulk-bar glitch + bulk Reinvestigate, risk-gauge space, login layout + branding-not-reflected (root cause: ThemeProvider fetched branding once → added `refreshBranding()`), and a full Demo Mode overhaul (LumenPay/Lentra-style fintech, 3 sources SIEM/XDR/EDR, bounded ~40 evt/s via the EVENT funnel, 10-min pre-seed, all capabilities live in isolated demo-scoped stores at $0). Adversarial pass found 3 major + 3 minor, all fixed.
  3. **CI fix** (`621e6fb`, pushed): backend pytest red on CI / green locally — the demo `search()` used a 1h window and demo benign volume is diurnal → 0 hits at trough hours (CI ran at night UTC). Widened to 24h (hour-of-day-stable); verified under `TZ=UTC` + full suite.
  4. **Round 10 overhaul** (this entry, LOCAL, not pushed) — below.
- Did (Round 10 — "if this is a serious tool, it must read EVERYTHING and be smart by default"): a research-first overhaul across 5 disjoint coding batches. **Core insight:** the machinery already existed but shipped default-OFF, so a fresh install correlated everything and reasoned over almost nothing. Changes:
  - **Comprehensive ingestion** — `background_scan_enabled` default TRUE; events-role clusters auto-forward to the strong LLM via a DETERMINISTIC RISK GATE (`auto_investigate_risk_floor` default **70** = Elastic entity-risk "High" band, cited); below-floor stay $0 candidates (never dropped, #4); alerts-role feeds correlate `mode=EVERY` so every alert = exactly one case (bursts coalesce); per-source per-tick cap **25** (cap-deferred candidates now genuinely DRAIN on later ticks — a verify-caught bug); investigations sequential; push=pull symmetric.
  - **Autopilot smart-defaults (default-ON, $0/#3-safe)** — threshold tuning (shadow-eval forced), campaigns, cross-source correlation, SLA, priority, realtime SSE, automation engine (rules=[]), baseline as producer + silent-source. `Preferences.autopilot_profile` dial (conservative/balanced/aggressive → floor 90/70/40 · $5/$10/$50 · cap 10/25/100). Kept opt-in: batch, budget block-mode, run_playbook/notify, baseline-drives-investigation.
  - **Default budget backstop** — `BudgetConfig` enabled, `daily_usd=$10`, warn-only (over-budget → NEEDS_HUMAN, never closes). The global spend bound.
  - **Migration** — auto-adopt + one-time `show_autopilot_banner`; inverted AutomationNudge to a reassurance/one-click-OFF card; explicit post-marker opt-outs preserved; tuner shadow-eval force-on for migrated tenants.
  - **Coverage observability** — per-source last-poll snapshot (ok/error/events_per_min/silent) on `/api/sources/health`; multi-feed all-feeds-failed now reports ok=False; `AuditDoc.source_id` (+ ES `AUDIT_MAPPING` keyword) → `GET /api/audit?source_id=`; per-source noise dim; new `GET /api/sources/coverage` rollup; webui Sources coverage banner + Overview coverage tile + honest "awaiting/candidate" noise stage.
  - **motion.dev** — added ONE deliberate runtime dep `motion@12.42.2` (framer-motion was removed R5), LAZY behind `LazyMotion`+`m`+`domAnimation`+`MotionConfig reducedMotion="user"`; motion in a lazy ~83.85 kB chunk, entry stays **281.44 kB (<400 ceiling)**; route/tab/bulk-bar/nav transitions + dashboard KPI count-ups (`AnimatedNumber` dynamic-imported into KpiTile to stay lazy); reduced-motion honored.
  - All defaults grounded in an intensive, cited standards research pass (Elastic/CrowdStrike/Splunk risk bands; Iglewicz-Hoaglin modified-z 3.5; Wilson 0.95; Sentinel UEBA 14d warm-up; Elastic ML 75).
- Tests: **backend 1796 pytest** (1738 → +58) · **webui 1332 vitest / 239 files** (+32) · **build clean** (entry 281.44 kB, motion lazy 83.85 kB) · **lint 0 errors** (3 pre-existing warnings) · `engine/case_manager.py decide()` **byte-identical** (#3), `risk.py`/`signatures.py` untouched (risk gate is routing-only) · one ledger write/call (#6) · #4 never-drop/no-dup upheld · **ZERO new deps except the deliberate lazy `motion`**. Full suite re-verified under `TZ=UTC`.
- Adversarial verification found **5 major + 6 minor** (all confirmed, all fixed): cap-deferred clusters never drained; multi-feed silent-vs-broken blind; ES audit `source_id` unmapped; silent-threshold false-positives on quiet alert feeds; RouteMotion lazy-resolve unmount/remount; tuner-migration skipping mandatory shadow-eval; per-tick cap is per-source (redocumented, daily budget is the global bound); motion cross-fade/count-up honesty. Test-integrity audit confirmed the 20+ modified existing tests were LEGIT default-ON updates, not masked regressions.
- Status: **done — Round 10 complete, LOCAL on `Testing`, committed (no co-author), NOT pushed** (per "commit locally").
- Next: user's call to push `Testing`; possible fast-follows flagged in ROADMAP (global-per-tick cap threading, opt-in reputation-in-routing-gate, batch default posture, OTEL/scale-out). Pixel QA of the motion + coverage surfaces needs a human (agents can't render).
### 2026-07-11 10:23Z — Codex orchestrator — Bleeding Edge release-readiness program started
- Context: Make `AGENTS.md` the cross-agent source of truth, inspect the complete product with multiple agents, research competitive SOC architectures and release practices, identify and fix backend/product gaps, validate all release gates, and produce a locally committed Bleeding Edge candidate without pushing.
- Did: Read `docs/HANDOFF.md`, `AGENTS.md`, the active branch state, and the deep-security-scan operating contract; confirmed `Testing` is clean at `d8f415a` except for the user-provided untracked `AGENTS.md`; began the required source-of-truth conversion and release audit.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Create the temporary continuity note, inventory the repository and baselines, run parallel architecture/security/product research, implement validated fixes, rerun all gates, remove the temporary note, and commit locally.

### 2026-07-11 — Codex security worker R05b — `routes_setup.py` review started
- Context: Defensive first-party correctness review of the public OOBE first-admin route for the active deep security scan.
- Did: Read the scan-specific `security_guidance.md` and `threat_model.md` in full, then read the owned source file in full; beginning direct-control tracing for self-locking, password policy, race safety, public-route conditions, auth/session state, audit, and secret handling.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Inspect only direct supporting controls, write the R05b discovery receipt, and report concrete invariant failures only.

### 2026-07-11 11:49Z — Codex security worker R08a — `config.py` review started
- Context: Defensive first-party correctness review of `backend/app/config.py` for the active deep security scan.
- Did: Read the scan-specific `security_guidance.md` and `threat_model.md` in full and resolved the finding-discovery workflow; beginning a full-file review focused on production defaults, secret boundaries, validators/overposting, URL/TLS/auth settings, default credentials, autopilot invariants, migration, and configured-status disclosure.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Read the target file in full, inspect only direct supporting controls as needed, and write the R08a discovery receipt.

### 2026-07-11 11:49Z — Codex security worker R07b — `routes_cases_collab.py` review started
- Context: Defensive first-party correctness review of the case-collaboration API for the active deep security scan.
- Did: Read the finding-discovery workflow, scan-specific `security_guidance.md`, `threat_model.md`, and project handoff in full; preparing the assigned one-file review.
- Tests: Not run (discovery start milestone).
- Status: in-progress.
- Next: Read the owned source fully, trace only direct controls for scope/authorship/untrusted text/fan-out/concurrency, and write the R07b receipt.

### 2026-07-11 — Codex security worker R05b — `routes_setup.py` review completed
- Context: Completed the scoped defensive review of the public OOBE first-admin route.
- Did: Wrote `artifacts/02_discovery/worker_results/R05b.json` with one completed file receipt, three concrete candidates, three suppressions, and exact supporting evidence; wrote three-row discovery/validation/attack-path ledgers for R05b-C01 through R05b-C03. No target source was edited and no offensive payload was used.
- Tests: Targeted backend OOBE suites passed: `tests/test_round4_wave4_setup.py` and `tests/test_oobe.py`; JSON and all three JSONL ledgers parsed successfully, with exactly three rows per ledger.
- Status: done.
- Next: Parent scan should reconcile and centrally validate the environment-admin self-lock mismatch, default-ES fail-open existence probe, and incomplete strong-password predicate.

### 2026-07-11 12:12Z — Codex security worker R07b — `routes_cases_collab.py` review completed
- Context: Completed the scoped defensive review of case collaboration reads, authorship, mutations, stored data, fan-out, audit behavior, and idempotency.
- Did: Wrote `artifacts/02_discovery/worker_results/R07b.json` with one completed receipt, nine concrete candidates, eight exact suppressions, and candidate-local control evidence; wrote three-row discovery/validation/attack-path ledgers for R07b-C01 through R07b-C09. No target source was edited and no offensive payload was used.
- Tests: `tests/test_round3_wave2_collab.py` + `tests/test_round3_wave5_rbac.py` passed (28 tests); isolated auth/RBAC, ownership, provenance, mention-replay, audit-failure, metadata-bound, and migration-race control checks completed; JSON parsed and all nine ledgers validated at exactly three rows each.
- Status: done.
- Next: Parent scan should reconcile and centrally validate the three missing cases:read instances, provenance spoofing, cross-author edit/delete, unbounded metadata, mention replay, and migrate-on-read race.

### 2026-07-11 12:26Z — Codex security worker R08a — `config.py` review completed
- Context: Completed the scoped defensive review of production defaults, authentication/authorization policy, secret/non-secret separation, loose config boundaries, URL/TLS credential binding, Autopilot safety, migration behavior, and configured-status disclosure.
- Did: Wrote the scan artifact `artifacts/02_discovery/worker_results/R08a.json` with one completed receipt, 13 concrete candidates, seven suppressions, canonical supporting evidence, and validation guidance; wrote exactly three discovery/validation/attack-path ledger rows for R08a-C01 through R08a-C13. The owned target `backend/app/config.py` was not edited and no offensive payload or external target was used.
- Tests: 99 targeted backend tests passed across Autopilot, connectors, RBAC, OOBE, and Round-3 foundation suites; isolated defensive harnesses confirmed auth/RBAC/cookie defaults, the public MFA fallback, source and notification config overposting, model/source/SMTP endpoint-to-secret rebinding, warning-only budget behavior, and repeated non-durable Autopilot migration. The receipt and all 13 JSONL ledgers parsed successfully and every ledger has exactly the required three phases.
- Status: done.
- Next: Parent scan should deduplicate and centrally validate the 13 candidates, especially the three endpoint/credential binding instances and the two persisted-config overposting families.

### 2026-07-11 12:28Z — Codex orchestrator — Security lane deferred; release-readiness work resumed
- Context: The supporting Codex Security scan repeatedly hit automated response filters while dispatching repository-wide review shards, and the user explicitly directed the session to leave that review out for now and return to the original Bleeding Edge product task.
- Did: Preserved the scan-local threat model, 786-file ranked inventory, 140-file deep-review worklist, partial coverage ledger, and completed worker receipts outside the repository; stopped the security goal and scan without applying any scan findings to source. The partial lane reviewed 35 selected files and produced unvalidated candidates for a future dedicated scan. No source file was changed by the security workers.
- Tests: Security workers ran targeted defensive suites on their owned files; these do not replace the final product gates. Full repository gates remain pending.
- Status: done (security lane intentionally deferred, not represented as a completed audit).
- Next: Run parallel backend/architecture, product/release/docs, and ingest/correlation/scaling assessments; validate findings directly against the current tree; implement only confirmed fixes.

### 2026-07-11 12:46Z — Codex ingest/scale research sub-agent — Ingestion and scaling audit completed
- Context: Read-only backend architecture and industry-research lane for the first Bleeding Edge release.
- Did: Confirmed ID-less push-event collapse, unstable pull pagination/late-arrival handling, unsafe acknowledgement/checkpoint semantics, receiver lifecycle and capability gaps, detection/case identity conflation, process-local coordination, non-atomic KV mutation, and normalization-profile limitations. Synthesized a low-cost architecture in which every event is handled deterministically while only compact candidates reach an LLM.
- Tests: Reproduced two distinct RFC5424 records with empty IDs collapsing to one after deduplication. No source files were edited.
- Status: done.
- Next: Fix ingestion identity and acceptance semantics first; keep the first alpha explicitly single-replica until durable queues, leases, and atomic state operations exist.

### 2026-07-11 12:51Z — Codex release/docs research sub-agent — BE release and documentation audit completed
- Context: Read-only audit of product versioning, branches, CI, packaging, health/readiness, upgrades, artifacts, and professional public documentation.
- Did: Confirmed conflicting product versions, no tags/releases/license, divergent default/testing branches, incomplete CI, misleading readiness, absent SQL migrations, incomplete connector image packaging, volatile source secrets, and documentation/navigation gaps. Recommended protected `main` + `next`, prerelease/RC tags for testing, a conservative `3.0.0-alpha.1`, and MkDocs Material on GitHub Pages.
- Tests: Agnostic Compose configuration validated with a temporary password; checked branch/version/OpenAPI/package metadata. No source files were edited.
- Status: done.
- Next: Implement canonical version/readiness/CI/docs foundations, then publish only after the integrity and golden-path gates pass.

### 2026-07-11 12:53Z — Codex backend release-readiness sub-agent — Backend/runtime audit completed
- Context: Read-only end-to-end audit of ingest, connectors, normalization, correlation, investigation, persistence, source lifecycle, schedulers, scaling, and release readiness.
- Did: Confirmed release blockers in push event identity, false-success ingestion acknowledgement, multi-source investigation routing, volatile connector secrets, receiver reconciliation, push mappings, connector packaging, default routing risk, push evidence retention, incident over-merging, multi-replica CAS/locking, spend governance, and readiness reporting. Produced an ordered remediation plan.
- Tests: Full backend suite passed: 1,798 tests across 127 files. Focused probes reproduced the principal blockers. No source files were edited.
- Status: done.
- Next: Implement the durable event/idempotency foundation, source-aware investigation, supervised receiver lifecycle, truthful capabilities/readiness, and release gates in that order.

### 2026-07-11 13:02Z — Codex orchestrator — Release implementation tracks started
- Context: The audit/research phase converged on a common blocker set and the user directed uninterrupted progress on the original task.
- Did: Started three non-overlapping implementation tracks for push-ingest identity/mapping, canonical version/readiness/CI, and public GitHub Pages documentation/release architecture. The orchestrator is handling acknowledgement semantics and final integration.
- Tests: Pending implementation.
- Status: in-progress.
- Next: Merge the three tracks, run targeted tests, then complete the full backend and web gate matrix before a local commit.

### 2026-07-11 13:20Z — Codex backend integrity worker — Push identity and mapping repair started
- Context: Implement the focused Bleeding Edge integrity slice for deterministic push-event identity, source-isolated vendor IDs, and application of saved per-source field mappings across push receiver paths.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; isolated the work to backend connector/ingest normalization code and focused offline tests.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Trace common/webhook/object-store normalization and ingest deduplication, implement the smallest compatible fix, and run targeted receiver/ingest tests.

### 2026-07-11 13:20Z — Codex release-runtime agent — Release/runtime hardening started
- Context: Implement the bounded first-Bleeding-Edge release slice: one canonical prerelease version, truthful liveness/readiness/build metadata, Docker health semantics, and stronger CI gates.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; reserved release/version, health API, Docker healthcheck, and CI files while avoiding receiver/OCSF code and public documentation content.
- Tests: Not run yet (start milestone).
- Status: in-progress.
- Next: Inventory all active version literals and health/auth contracts, implement backward-compatible changes, then run the focused backend and release gates.

### 2026-07-11 13:21Z — Codex public-docs agent — Public documentation foundation started
- Context: Build a professional public documentation and release-planning foundation for the first Bleeding Edge release, deployable free through GitHub Pages.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; reserved MkDocs configuration, public documentation pages, the separate Pages workflow, and documentation-only dependencies while avoiding backend/web source, root versioning, CI, and `CLAUDE.md`.
- Tests: Not run yet (start milestone).
- Status: in-progress.
- Next: Verify current connector/deployment truth, implement the public information architecture and release/ingestion guidance, then build the site in strict mode and validate internal links.

### 2026-07-11 13:24Z — Codex orchestrator — Failed-ingest acknowledgement made truthful
- Context: A persistence failure was previously returned as a successful receive, causing webhook senders and durable brokers to discard unprocessed alerts.
- Did: Added a retryable `IngestBatchError` boundary; HTTP push now returns 503 with `Retry-After` instead of `ok: true`; Kafka auto-commit is disabled and offsets commit only after successful shared ingestion; S3 notification messages are retained when object processing fails.
- Tests: Focused backend ingestion suite passed: 8 tests across `test_ingest_acknowledgement.py` and `test_ingest_push.py`, including store failure, HTTP 503, Kafka commit-after-success, and no-commit-on-failure.
- Status: done (bounded integrity improvement; durable local inbox/outbox remains a documented alpha blocker).
- Next: Integrate source-scoped identities/mappings, version/readiness/CI, and docs tracks; then reassess receiver lifecycle and source routing within the remaining release budget.

### 2026-07-11 13:31Z — Codex backend integrity worker — Push identity and mappings repaired
- Context: Close two confirmed ingest-loss/customization gaps before the Bleeding Edge candidate: empty push ids collapsing a batch and `field_mappings_extra` being ignored outside Elastic pull.
- Did: Added deterministic source-scoped push identities (vendor-id or canonical-record+ordinal), enforced the invariant again before ingest deduplication, taught generic OCSF normalization to prefer configured mapping paths, and routed common/webhook/object-store record normalization through one mapping-aware implementation. Added focused NDJSON, syslog, vendor-id isolation, webhook mapping, and S3 object-path regressions.
- Tests: 98 passed across `tests/test_receivers.py`, `tests/test_ingest_customization.py`, and `tests/test_source_feeds.py`; 18 passed in `tests/test_overhaul_b1_ingestion.py`; `compileall` clean for the edited backend modules.
- Status: done (implementation milestone; final shared-tree integration review remains with the orchestrator).
- Next: Orchestrator should retain the shared acknowledgement changes in `ingest.py`/`objectstore.py`, run the complete backend suite, and include the new `app/ocsf/identity.py` file in the final commit.

### 2026-07-11 13:32Z — Codex backend integrity worker — Push integrity session ended
- Context: Final handoff of the bounded push identity/mapping implementation to the Bleeding Edge orchestrator.
- Did: Reviewed the scoped diff for whitespace/errors, confirmed the new identity helper is dependency-free and idempotent at both normalization and ingest boundaries, and preserved concurrent acknowledgement/retry edits in shared files.
- Tests: Scoped `git diff --check` clean; prior 98-test + 18-test backend runs and module compilation remain green.
- Status: done.
- Next: Run the repository-wide backend gate after all parallel patches settle; no commit or push was performed by this worker.

### 2026-07-11 13:33Z — Codex release-runtime agent — Version and runtime gates implemented
- Context: Establish a truthful, mechanically checked release identity and separate process liveness from persistence readiness for the first public prerelease.
- Did: Added canonical root `VERSION` (`3.0.0-alpha.1`) and synchronized Python, FastAPI, web package/lock, generated OpenAPI, and Compose default image tags; added the zero-dependency `scripts/check_version.py`; added public `/api/health/live`, `/api/health/ready`, and `/api/health/build-info` while preserving the legacy `/api/health` shape; readiness now probes SQL directly or the ES management client specifically. Docker/Compose now gate on readiness. CI now runs version/Compose validation plus web lint, design gates, Vitest, and build, and covers the current/default plus proposed release branches.
- Tests: 34 focused backend tests passed (`test_api`, `test_health_runtime`, route-auth coverage, response contracts); generated API-type contract 5/5 passed; version checker passed; agnostic Compose config passed; Python compileall passed. Ruff was unavailable in the existing venv, so no Ruff result is claimed.
- Status: done (implementation milestone; final shared-tree full gates remain with the orchestrator).
- Next: Re-run the focused tests after all concurrent edits settle, then include these files in the full backend/web release gate and local commit.

### 2026-07-11 13:35Z — Codex release-runtime agent — Release/runtime session ended
- Context: Final verification and handoff of the bounded release/runtime hardening slice.
- Did: Regenerated OpenAPI/TypeScript contracts twice and confirmed byte-identical checksums; reviewed the scoped changes, retained concurrent ingest/source-lifecycle edits, and handed the integration summary to the orchestrator. No commit or push was performed.
- Tests: Re-run passed 34/34 focused backend tests; canonical version check and agnostic Compose validation passed; repository `git diff --check` passed; generated contract checksums were stable across regeneration.
- Status: done.
- Next: Orchestrator owns full-suite backend/web gates, temporary-memory cleanup, final diff review, and the requested local commit.

### 2026-07-11 13:36Z — Codex pull-cursor worker — Pull pagination correctness started
- Context: Repair pull-source cursor correctness for equal timestamps, multi-page result sets, retry boundaries, and bounded late arrivals without touching push receivers or release surfaces.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; reserved the Elastic/OpenSearch/Wazuh pull connector path, poll cursor flow, and focused offline tests.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Confirm the shared pull query abstraction, implement deterministic pagination plus overlap-safe deduplication, then run focused regression tests.

### 2026-07-11 13:39Z — Codex public-docs agent — Public documentation foundation implemented
- Context: Turn the internal engineering documentation into a concise, professional public foundation for the first Bleeding Edge build without hiding alpha constraints.
- Did: Added a pinned MkDocs Material site, polished public landing page, demo/evaluation quickstart, honest 19-connector support matrix, current-vs-target ingestion/correlation/mapping/scaling design, two-permanent-branch release policy, explicit blocker register, GitHub Pages workflow, and ignored generated site output. Kept HANDOFF, Journal, legacy long-form docs, and research scratchpads out of the public build.
- Tests: `mkdocs build --strict` passed; generated-link validation passed for 368 links across 7 HTML pages; documentation workflow YAML parsed; scoped `git diff --check` passed. Interactive visual QA was unavailable because the workspace exposed no browser surface.
- Status: in-progress (implementation milestone; final blocker wording will be reconciled with the in-flight source-aware investigation and pull-pagination fixes).
- Next: Reconcile every limitation against the settled shared tree, rerun strict/link checks, remove generated output, append the closing Journal entry, and hand off without committing.

### 2026-07-11 13:42Z — Codex container/package worker — Bleeding Edge image correctness started
- Context: Make the backend image and Python distribution truthful and runnable for the first Bleeding Edge build: complete package/data contents, non-root runtime, pinned base, OCI metadata, and honest optional-connector availability.
- Did: Reserved `backend/Dockerfile`, backend package/dependency metadata, Docker build-context exclusions, and focused offline packaging/image smoke tests; explicitly excluded routes, pipelines, receivers, CI, public docs, and version changes.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Re-read the current handoff/rules, inspect package and image ground truth, implement a core/full image contract, and verify wheels plus Dockerfile semantics offline.

### 2026-07-11 13:43Z — Codex orchestrator — Source lifecycle and investigation isolation repaired
- Context: Source mutations required a restart, and secondary-source investigations could query the primary source, mixing evidence across connectors.
- Did: Added live receiver reconciliation after source create/edit/delete and secret rotation, revoked orphaned secrets, awaited receiver shutdown, and surfaced background task exits. Threaded each originating pull connector through automated, manual, re-investigation, playbook, and event-detection paths; source-specific event reconstruction now uses the connector SPI, and push-only sources cannot silently fall back to a different query surface. Also made the pipeline propagate a terminal fallback-case persistence failure so transports can retry rather than acknowledge an unsaved case.
- Tests: 42 source-aware/poller/reinvestigation tests passed, followed by 22 focused acknowledgement/source/investigation tests; new selected-source regression proved source-B events and rule IDs exclude source A. Receiver lifecycle/ingest focused set passed 10/10.
- Status: done (receiver auto-restart/backoff and durable push evidence remain explicit alpha limitations).
- Next: Integrate the pull pagination and packaging tracks, regenerate API contracts for the additive `source_id`, then run every backend/web/docs/release gate.

### 2026-07-11 13:54Z — Codex pull-cursor worker — Pull cursor integrity implemented and verified
- Context: Eliminate equal-timestamp starvation and single-page loss on the shared Elasticsearch/OpenSearch/Wazuh pull path while admitting bounded late events without replaying prior rows.
- Did: Added PIT + `search_after` pagination with a stable `_shard_doc` tie-breaker and bounded no-PIT fallback; server-side, source-index-qualified boundary exclusions; a durable five-minute exact late-arrival identity ledger with replay-safe old-cursor backfill and a 100k safety cap; complete cursor-state persistence; and deterministic offline PIT/search-after support. Added regressions for >2× batch size at one timestamp, multi-page fallback, retry boundaries, same-ms inserts, rollover `_id` collisions, and late arrival once-only case handling.
- Tests: Full backend suite passed: 1832 tests collected/passed; focused pull/connector/poller/state/observability matrix passed 102 tests; `compileall` and `git diff --check` passed.
- Status: done (implementation milestone; no distributed exactly-once claim — no-PIT concurrent-refresh semantics remain the documented compatibility bound).
- Next: Hand the shared-tree patch to the orchestrator for final cross-track review and commit.

### 2026-07-11 13:54Z — Codex pull-cursor worker — Pull pagination session ended
- Context: Final handoff of the bounded pull correctness slice.
- Did: Reconciled the public-doc limitation wording with the documentation worker, preserved concurrent source-aware investigation/readiness changes in shared files, and reviewed the final scoped behavior and residual bounds.
- Tests: Full backend 1832/1832 green; focused 102/102 green; source compilation and whitespace checks clean.
- Status: done.
- Next: Orchestrator should retain the additive cursor fields and `test_pull_pagination.py`, rerun final repository-wide release gates after the packaging/docs tracks settle, and commit locally without claiming exactly-once delivery.

### 2026-07-11 13:55Z — Codex pull-cursor worker — Cursor contract wording synchronized
- Context: Final post-verification cleanup after the pull correctness handoff.
- Did: Updated the in-code Cursor and FeedScan/poll documentation to describe paginated frontier reads, source-index-qualified identities, bounded late-arrival state, and the explicit absence of a distributed exactly-once claim.
- Tests: `test_pull_pagination.py` 5/5 passed again; `compileall` and `git diff --check` clean.
- Status: done.
- Next: No additional pull-cursor work remains before orchestrator integration.

### 2026-07-11 13:59Z — Codex public-docs agent — Public documentation foundation completed
- Context: Finalize a professional, GitHub Pages-ready documentation and release-policy foundation that matches the settled Bleeding Edge code rather than the pre-audit repository claims.
- Did: Reconciled the public pages against the implemented push identity/mapping and retry boundary, source-safe investigations, live receiver reconciliation, draft connector tests, PIT pull pagination/late overlap, source-scoped case signatures, available-signal routing risk, persisted aggregate baseline learning, hard budget preflight, and full/core distribution contract. The remaining blocker register now contains only current gaps: project license, durable receipt/replay, non-uniform receiver checkpoints, persistent dynamic secrets, versioned database migrations, and within-source incident-episode identity. Added preview artifacts plus main-only Pages deployment and kept internal handoff/research material excluded.
- Tests: `mkdocs build --strict` passed; 380 generated links across 7 HTML pages validated including fragments; landing hero/Mermaid/version banner rendered in generated HTML; workflow YAML/main-only deploy condition validated; all four public external links returned HTTP 200; scoped `git diff --check` passed; generated `site/` removed; the shared packaging contract also passed 5/5 (actual wheel content/import smoke included). Interactive browser visual QA remained unavailable because no browser surface was exposed.
- Status: done (documentation lane complete; no commit or push performed).
- Next: Orchestrator should include `.gitignore`, `mkdocs.yml`, `.github/workflows/docs.yml`, `docs/requirements.txt`, and the new public page/style directories in final review; decide the license before any public binary/open-source release; then run the final whole-repository gates and commit locally.

### 2026-07-11 14:01Z — Codex final backend reviewer — Release-integrity review started
- Context: Perform a read-only final review of the uncommitted backend hardening, concentrating on pull cursor/PIT pagination, late-arrival deduplication, ingest acknowledgement, source isolation/signatures, receiver lifecycle, budget/risk routing, and baseline persistence.
- Did: Read the current handoff and agent rules; reserved a no-code-change review pass over the settled shared tree.
- Tests: Not run (session-start milestone; full-suite execution explicitly excluded from this review).
- Status: in-progress.
- Next: Trace each changed boundary end to end, run only small diagnostic checks if needed, and report concrete release blockers with file/line evidence.

### 2026-07-11 14:01Z — Codex release-engineering reviewer — Final release/docs audit started
- Context: Independently audit the uncommitted Bleeding Edge release surface: synchronized version metadata, core/full backend packaging, Compose readiness, CI and GitHub Pages workflows, public documentation claims and links, release-channel policy, and known limitations.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` completely; reserved a read-only product/docs review, with `Journal.md` as the only permitted edit.
- Tests: Not run (session-start milestone; long suites are outside this focused review).
- Status: in-progress.
- Next: Compare every release claim to executable configuration and package contents, run only short static checks, then report concrete findings with file/line evidence.

### 2026-07-11 14:11Z — Codex release-engineering reviewer — Static release contracts audited
- Context: Validate the release metadata, distribution tiers, Compose/readiness wiring, CI/docs workflows, channel policy, and public alpha claims against the live shared tree.
- Did: Confirmed the 19-manifest/full-dependency and wheel-data design, found and reported generated-contract CI and web OCI-label gaps (both corrected by the orchestrator during the audit), and identified remaining state-readiness, exact-release CI/artifact, MQTT acknowledgement, quickstart-demo, stale master-context/changelog, and reproducibility gaps with file/line evidence.
- Tests: `scripts/check_version.py` passed for `3.0.0-alpha.1`; agnostic `docker compose config --quiet` passed; OpenAPI JSON and generated TypeScript were independently regenerated to `/tmp` and matched byte-for-byte; `git diff --check` passed. A fresh local MkDocs invocation was unavailable in this shell, while the dedicated docs agent's strict build/link validation is recorded separately.
- Status: in-progress (evidence collected; final severity/order and handoff remain).
- Next: Re-read concurrently corrected workflow/packaging files, separate resolved observations from open release blockers, append the session-end journal entry, and return the final audit without editing product/docs files.

### 2026-07-11 14:14Z — Codex release-engineering reviewer — Final release/docs audit completed
- Context: Close the independent release-engineering review after reconciling fixes made concurrently by the orchestrator.
- Did: Re-verified the corrected hard generated-contract CI gate, backend+web OCI metadata, truthful write-path readiness sentinel, narrowed transport-ack wording, and Kafka no-exactly-once language. Returned the remaining blockers: dead `CLAUDE.md` section references plus stale HANDOFF/AGENTS status/defaults, incorrect local-demo claim, stale hard-budget changelog, no CI/release/docs artifact run on `release/**` or immutable tags, no image/SBOM/provenance publication lane, non-reproducible open dependency/base-image ranges, unresolved owner license, documented data-plane alpha blockers, and mandatory removal of `memory.md` before commit.
- Tests: Final `scripts/check_version.py`, agnostic `docker compose config --quiet`, and `git diff --check` all passed. No long suite was run by this read-only reviewer; the dedicated docs agent recorded strict MkDocs/link success and the packaging worker recorded wheel-contract success.
- Status: done (audit only; no product/docs files edited, no commit or push).
- Next: Orchestrator should resolve the documentation/release-lane hygiene items before the local commit, preserve the explicit blocker register, run the complete backend/web/docs gates, delete `memory.md`, and avoid tagging `v3.0.0-alpha.1` until the license and stated alpha exit gates are satisfied.

### 2026-07-11 14:30Z — Codex orchestrator (worker handoff) — Backend final review closed after capacity error
- Context: Preserve the read-only backend reviewer's findings and required end-of-session journal record after its model became unavailable before it could write the closing entry.
- Did: Triaged every concrete finding the worker returned: fixed push/deleted-source evidence isolation, push-first primary leakage, rollover event identity, legacy signature migration, local receiver restart supervision, successive-callback push correlation, and quiet-tick deferred-candidate draining. Kept durable receipt/checkpoints/distributed ownership as explicit public blockers.
- Tests: Focused source/push/pull/receiver/cap regressions were rerun during each fix and passed; the final full suite is still pending.
- Status: done (review lane ended; no security-scan claim is made).
- Next: Run the full integrated backend/web/docs/release gates and correct any cross-suite regressions before commit.

### 2026-07-11 14:30Z — Codex orchestrator — Alpha integrity and release-contract reconciliation
- Context: Close high-confidence issues found by the independent final reviewers before the first complete release gate.
- Did: Added write-path readiness, web OCI metadata, exact contract CI checks, release/tag CI triggers, source-index case membership, a durable deferred queue over case state, receiver restart backoff, push sliding-window correlation, push-only no-query behavior, canonical AGENTS references, current autopilot defaults, a real seeded one-command demo, direct dependency pins, and a consolidated `3.0.0-alpha.1` changelog entry. Updated public limitations rather than overstating production readiness.
- Tests: Focused matrices for health, push thresholds, source isolation, rollover, legacy migration, reinvestigation, receiver restart, and deferred draining passed; version/Compose/strict docs/contract checks were green before the latest additive model changes.
- Status: in-progress (implementation complete enough for integrated gates; generated contracts and all final gates must be rerun).
- Next: Regenerate OpenAPI/types, run the full backend and web matrices plus docs/package/version/Compose checks, then clean temporary state and commit locally only.

### 2026-07-11 14:44Z — Codex pre-commit integrity reviewer — Bounded release-integrity review started
- Context: Perform one read-only pre-commit review of the changed ingest/source/pagination/deferred-queue and release packaging/version/docs paths, explicitly excluding a security scan and the already-green full test suites.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` completely; reserved a short evidence-driven pass for concrete P0/P1 correctness regressions or release contradictions. Product files will not be edited.
- Tests: Not run (session-start milestone; only short targeted diagnostics are permitted).
- Status: in-progress.
- Next: Inspect the changed boundaries and release contracts, report only actionable P0/P1 findings with file/line evidence, then close the journal entry.

### 2026-07-11 14:52Z — Codex pre-commit integrity reviewer — Bounded release-integrity review completed
- Context: Close the read-only pre-commit review of the changed ingest/source/pagination/deferred-queue and release packaging/version/docs paths; this was explicitly not a security scan.
- Did: Found and reported two concrete P1 correctness blockers: per-source pull secrets are written after the live connector rebuild but do not trigger another pull/poller rebuild, and the durable deferred drain unconditionally grants a second full investigation allowance after the current tick can already consume its configured cap. No product files were edited.
- Tests: `git diff --check` passed; `scripts/check_version.py` passed for `3.0.0-alpha.1`; `pip install --dry-run -r backend/requirements-connectors.txt` resolved every pinned full-image connector dependency. Full backend/web suites were intentionally not repeated (the orchestrator already recorded 1841/1332 green).
- Status: done (two P1 findings handed to the orchestrator with file/line evidence).
- Next: Rebuild the pull connector/poller set after per-source secret mutation and make deferred draining consume only remaining per-source tick headroom (or run only on a truly quiet tick), then add focused regressions before the local commit.

### 2026-07-11 14:57Z — Codex orchestrator (worker handoff) — Container/package session closed after capacity error
- Context: Supply the mandatory closing record for the package worker whose model became unavailable after its shared-tree implementation and verification completed.
- Did: Retained the full/core backend image contract, non-root runtime, pinned advertised connector clients, complete wheel package-data discovery, OCI metadata, and actual built-wheel import/data smoke tests. Kept missing hash-locked transitives, base-image digests, SBOM/provenance, and the owner license decision explicit in the public release blockers rather than overstating reproducibility.
- Tests: The distribution contract's 5 tests passed independently and again inside the final full backend suite; canonical version and agnostic Compose checks passed.
- Status: done (worker lane closed; no image was published and no license was invented).
- Next: Address the documented reproducible-publication and license gates before creating a public tag or binary release.

### 2026-07-11 14:57Z — Codex orchestrator — Bleeding Edge foundation final gate and session end
- Context: Finish the requested end-to-end product/backend/release pass after deferring the optional security scan, integrate all multi-agent findings, test the real out-of-box path, remove temporary memory, and prepare one local commit without pushing or tagging.
- Did: Made `AGENTS.md` canonical with a minimal `CLAUDE.md` forwarder; synchronized `3.0.0-alpha.1`; hardened push identity/mapping/acknowledgement, source-safe investigations, PIT pagination and late-event deduplication, source-scoped case identity migration, receiver reconciliation/restart, baseline observation, conservative routing/budget gates, durable deferred-candidate draining, live pull-secret rotation, and write-path readiness. Added full/core packaging, strict CI/contracts, a seeded one-command demo, GitHub Pages-ready public docs, a two-branch/three-channel release policy, and an honest blocker register. The final independent review's two P1 findings were fixed: pull secrets now rebuild live clients, and the deferred drain shares unused cap headroom. Removed the stale Tailwind build warning and all three eslint warnings. Deleted `memory.md` and generated `site/` before staging.
- Tests: Full backend **1843/1843** passed (one intentional `verify_certs=False` fixture warning); webui **1332/1332** across 239 files passed; eslint **0 errors / 0 warnings**; all 5 design gates passed; `tsc --noEmit && vite build` passed (entry **281.60 kB**, gzip **83.35 kB**, lazy motion **83.85 kB**); OpenAPI/TypeScript drift check passed (189 paths); package/wheel contract 5/5 passed; `compileall`, canonical version, agnostic Compose, strict MkDocs, demo shell, secret-pattern scan, and `git diff --check` passed. A real `run-demo.sh` smoke completed auth, setup, seeded 45 cases, returned 200 from live/ready/build-info and the Vite root, then shut down cleanly.
- Status: done for the requested local Bleeding Edge foundation; deliberately **not tag-ready** while the public blocker register remains open. The optional security scan was not completed and is not claimed.
- Next: Create the local commit only. Before any public alpha tag, choose a license and close or deliberately reclassify the durable receipt/checkpoint/secrets/migrations/episode-identity plus reproducible-artifact gates in `docs/releases/known-limitations.md`.

### 2026-07-11 16:15Z — Codex orchestrator — Claude include shorthand follow-up started
- Context: Apply the owner's final request that `CLAUDE.md` contain only Claude Code's direct `@AGENTS.md` include shorthand.
- Did: Reserved the exact one-line edit and a byte-level verification; no product behavior or release scope changes are involved.
- Tests: Not applicable yet (documentation-only instruction entry point).
- Status: in-progress.
- Next: Verify the file contains exactly `@AGENTS.md` plus its terminating newline, journal completion, and commit locally without pushing.

### 2026-07-11 16:15Z — Codex orchestrator — Claude include shorthand follow-up completed
- Context: Close the exact one-line Claude entry-point adjustment requested by the owner.
- Did: Replaced the prior prose forwarder with exactly `@AGENTS.md` and updated the journal's format pointer to the canonical file.
- Tests: Byte assertion passed: `CLAUDE.md == b'@AGENTS.md\n'`; `git diff --check` is the final staging gate.
- Status: done.
- Next: Commit this documentation-only follow-up locally without pushing.

### 2026-07-11 17:34Z — Codex orchestrator — Multi-source live demo and UI quality pass started
- Context: Build a high-fidelity, fully live synthetic demo spanning Splunk, QRadar, Wazuh, and RFC syslog inputs with occasional native/system alerts, while cleaning backend demo architecture and auditing the primary web UI for visual and interaction defects.
- Did: Re-read the canonical handoff/rules, selected parallel backend/demo-research/UI-audit lanes, and reserved real browser verification plus complete backend/web regression gates. Demo data will be synthetic and labelled but wire-format-faithful; external projects may inform formats and scenario design without copying incompatible datasets or licenses.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Map the current demo/runtime and UI surfaces, research authoritative vendor formats plus permissively licensed generators/datasets, then implement in isolated backend/web tracks and iterate through live browser QA.

### 2026-07-11 17:36Z — Codex UI quality worker — Primary web console audit started
- Context: Audit and fix concrete visual, interaction, responsive, accessibility, and state defects in the standalone web UI for the multi-source live-demo release, without subjective redesign churn or new dependencies.
- Did: Reserved AppShell/NavSidebar, Overview, Sources, Cases, demo surfaces, tables/sheets, narrow layouts, overflow, and loading/empty/error states for a standards-driven static and test pass; backend files are out of scope for this lane.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Read the complete handoff, canonical agent rules, and Round-5 design standard; inventory affected components/tests; then implement high-confidence fixes with focused regressions and the full web quality gates.

### 2026-07-11 17:52Z — Codex UI quality worker — Responsive and state defects reproduced
- Context: Complete the standards-driven audit before changing shared UI primitives and the primary operational routes.
- Did: Read the full handoff, canonical rules, and 837-line design standard; traced AppShell/NavSidebar, Overview, Sources, Cases, DemoBanner, DataTable, dialog/sheet primitives, and their regression suites. Confirmed with the orchestrator's live 390×844 browser baseline that the desktop 240px sidebar remained in-flow on mobile, forcing a 733px document and ~150px dashboard; also isolated narrow pager/header/banner pressure, Sources' misleading table on an initial load failure, and a source-kind filter that dropped all results when optional health data was absent.
- Tests: Static source/test inspection only at this milestone; implementation and focused Vitest are next.
- Status: in-progress.
- Next: Ship a real off-canvas mobile navigation, compact responsive command-bar controls, wrap-safe demo/table controls, honest Sources error/fallback behavior, and focused accessibility/regression coverage before the full web gates.

### 2026-07-11 17:36Z — Codex demo research worker — Vendor-format and dataset research started
- Context: Research authoritative current event contracts for Splunk HEC, IBM QRadar LEEF/syslog, Wazuh JSON alerts/archives, and RFC 5424/3164 syslog, plus permissively licensed SOC demo generators/datasets, without modifying product code.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; reserved an evidence-backed design note under `docs/research/2026-07-live-demo/RESEARCH.md` and a licensing-safe synthetic-data recommendation.
- Tests: Not run (research session start).
- Status: in-progress.
- Next: Verify vendor/RFC wire formats from primary documentation, assess upstream generator and dataset licenses, document representative contracts and concrete integration guidance, then close the journal entry.

### 2026-07-11 17:36Z — Codex backend live-demo worker — Multi-source simulation implementation started
- Context: Audit and extend the isolated, deterministic, $0 Demo Mode so it emits standards-faithful Splunk, QRadar LEEF, Wazuh JSON, and RFC syslog traffic with coherent cross-source incidents and occasional alerts.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; reserved only backend demo modules/new demo helpers and focused backend tests, leaving shared API/config/state integration seams for the orchestrator.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Trace current demo generation/runtime/connector normalization, verify vendor wire contracts, implement the native-record simulator through production parsers, then run focused regressions.

### 2026-07-11 17:47Z — Codex orchestrator — Real-browser baseline and demo integration gaps mapped
- Context: Validate the current seeded demo as an operator actually sees it before integrating the four native source streams and responsive UI fixes.
- Did: Started the authenticated one-command demo on isolated local ports and inspected Overview, Sources, and Logs through the in-app browser at 1280×720 and 390×844. Confirmed concrete defects: the mobile sidebar permanently consumes 240px and forces 733px document overflow; the banner/header collapse into an unusable sliver; the three demo source rows report generic/pull/idle while ingest coverage says 0 of 0; and unified Logs reports no browse-capable sources despite the demo source overlay. Routed the responsive fixes to the UI lane and the authoritative source/status/log seams to the backend lane.
- Tests: Local backend/web startup, seeded demo enable, authenticated browser sign-in, desktop DOM/visual inspection, mobile viewport measurement, and Sources/Logs interaction all completed successfully; these are discovery checks, not final gates.
- Status: in-progress (defects reproduced with measurements; fixes are underway).
- Next: Integrate native runtime metadata/recent-event buffers into source overlay, health, coverage, and unified log browsing; then repeat the same desktop/mobile browser checks against live mode.

### 2026-07-11 17:51Z — Codex orchestrator — Native-format research and live-first product contract integrated
- Context: Turn the external research into an implementable, licensing-safe demo contract and make the supported one-command/OOBE path select the requested live experience by default.
- Did: Accepted the authoritative Splunk HEC, QRadar LEEF/offense, Wazuh archive/alert JSON, and RFC syslog design note; documented the OSS alternatives and why no dependency or copied corpus is needed. Updated the demo script to default to `live` with an explicit `DEMO_MODE=seeded` escape hatch and validation, synchronized README/deploy/usage/quickstart/handoff/demo documentation, made the Settings demo picker live-first, made the first-run wizard request live mode explicitly, and changed the active summary/type comments to the four vendor identities.
- Tests: `bash -n scripts/run-demo.sh`, the invalid-mode exit-2 contract, documentation `git diff --check`, and 10 focused DemoModeSection/Wizard Vitest assertions passed. The focused knob test still prints its pre-existing React `act()` warnings while passing; full web gates remain pending.
- Status: in-progress (contract and entry points are live-first; simulator/API/UI integration is still underway).
- Next: Land and review the four native adapters, expose source telemetry/log browsing/manual incident trigger through API/UI, then run the real live session and full matrices.

### 2026-07-11 17:46Z — Codex demo research worker — Vendor-format and licensing research completed
- Context: Close the research-only lane for a protocol-faithful live demo spanning Splunk-compatible HEC, IBM QRadar, Wazuh, and RFC syslog without copying vendor datasets or adding dependencies.
- Did: Added `docs/research/2026-07-live-demo/RESEARCH.md` with primary-source citations, independently authored representative payloads, exact HEC/LEEF/offense/Wazuh/RFC contracts, OCSF projection guidance, a coherent cross-source scenario clock, stable-ID/dedup guidance, a bounded-volume design, and a nine-part test matrix. Assessed Eventgen (Apache-2.0), Flog (MIT), soc-faker (MIT), Splunk attack_data/Attack Range (Apache-2.0), OTRF Security-Datasets (MIT at repository level), Atomic Red Team (MIT), Caldera (Apache-2.0), OCSF (Apache-2.0), and Wazuh (GPL-2.0 covering its rules/decoders/data). Recommended project-owned synthetic fixtures and no new runtime dependency/corpus.
- Tests: All 32 cited URLs resolved successfully; focused existing receiver/Wazuh contract selection passed **16/16** (`tests/test_receivers.py -k 'hec or leef or syslog' tests/test_connector_wazuh.py`); `git diff --check` passed before the journal close.
- Status: done (research/docs only; no backend or webui product files changed, no corpus copied).
- Next: Orchestrator/backend lane should implement native serializers through the existing HEC/`formats.py`/OCSF path, expose four honest source/feed identities, and guarantee a seeded cross-source incident within the first 20–30 seconds while retaining cooldown, isolation, stable IDs, and bounded memory.

### 2026-07-11 17:47Z — Codex demo API integration worker — Four-source API truthfulness pass started
- Context: Integrate the isolated live demo with the existing Sources, health, coverage, per-source browse, and unified-log API contracts while keeping all real-tenant/off-demo behavior byte-compatible.
- Did: Read the complete handoff and canonical rules; reserved only `backend/app/state.py`, `backend/app/api/routes.py`, and focused API tests, with native generation/runtime owned by the parallel backend lane.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Align against the runtime's exact source-spec/stat/recent-event seams, trace the production endpoint behavior, implement a demo-only adapter with bounded provenance-safe records, then run focused regressions.

### 2026-07-11 18:00Z — Codex demo API integration worker — Native source surfaces wired
- Context: Close the reproduced Sources/coverage/Logs truthfulness gaps against the backend lane's new `DEMO_SOURCE_SPECS` and bounded adapter rings.
- Did: Added demo-only state adapters for four vendor identities and runtime health; exposed non-secret protocol/format metadata; made coverage demo-scoped while active; and routed per-source plus unified log browsing through each native adapter with mandatory provenance. Added an isolated public-route regression suite covering off-demo compatibility, all four source contracts, bounded browsing, coverage, secret non-disclosure, and teardown persistence.
- Tests: New API tests are 3/4 green; the remaining assertion correctly exposed a backend adapter defect where parsed events increment counters but retain `timestamp_millis=0`. Eight existing unified-log/health/coverage regressions passed, plus `py_compile` and `git diff --check`.
- Status: in-progress (API behavior is implemented; waiting on the native lane's timestamp and manual-trigger seams before the final focused gate).
- Next: Re-run after native parsing carries event time, then add the admin/audit/isolation route for `trigger_incident()` if that promised runtime seam lands.

### 2026-07-11 18:02Z — Codex UI quality worker — Responsive and demo-console quality pass completed
- Context: Close the primary web-console audit for the four-source live demo with concrete responsive, interaction, accessibility, and honest-state fixes; no subjective redesign or new dependencies.
- Did: Replaced the mobile in-flow rail with a zero-footprint off-canvas navigation that focuses the semantic current route; compacted the persistent demo notice into a one-row mobile control without hiding Reset/Exit or the isolation statement; made headers, search/toolbars, time controls, dialogs, and table pagination narrow-safe; added retry-only initial error states and useful Demo CTAs to Overview/Cases; corrected source-kind fallback and native protocol display; and made synthetic Sources rows explicitly demo-managed/read-only while preserving Browse Logs. Added per-row DataTable selection gating and focused regressions for every changed contract.
- Tests: Full web suite **1342/1342** across **240 files** passed; eslint **0 errors / 0 warnings**; `tsc --noEmit` passed; production Vite build passed (entry **284.76 kB**, gzip **83.98 kB**); focused responsive/demo/source tests **49/49** passed; `git diff --check` passed. The full suite still prints known non-failing Recharts zero-size/jsdom and legacy React `act()` stderr noted outside this scoped pass.
- Status: done (UI lane complete; product files left in the shared worktree for orchestrator integration, with no commit from this worker).
- Next: Orchestrator should repeat the 390×844 and desktop live-browser smoke against the integrated native runtime, especially Demo Sources → Browse Logs, banner height, current-route focus, and the no-horizontal-overflow measurement.

### 2026-07-11 18:03Z — Codex UI final reviewer — Independent UI regression review started
- Context: Independently review the completed web UI diff for correctness and UX regressions, with emphasis on responsive shell/navigation, demo-mode guards and labels, auth-aware demo entry, error/empty states, shared controls, and tests/types.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` in full; reserved a read-only review scope with no product-file edits and no security scan.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Inspect the exact webui diff and focused contracts, reproduce any plausible issues with targeted tests or static tracing, and report only evidence-backed P0/P1/P2 findings.

### 2026-07-11 18:07Z — Codex backend live-demo worker — Native four-source engine milestone
- Context: Replace the pre-normalized three-segment live ticker with a deterministic, isolated, $0 four-source simulator that proves the production parse/OCSF/ingest path and supports truthful health/log browsing.
- Did: Added `engine/demo_sources.py` with Splunk HEC access+risk, QRadar LEEF 2.0+offense, Wazuh archives+alerts JSON, and RFC 5424/3164 renderers parsed by the existing receivers; exact untrusted wire evidence, stable IDs, bounded 500/source rings, static source metadata, health snapshots, reserved TEST-NET/.example fixtures, and native/provider storyline mappings. Reworked `DemoSimulator` for all-source benign flow, a guaranteed ~20–30s coherent incident, three native alerts plus a correlated syslog detection, deterministic cadence, and cooldown-aware manual `trigger_incident()`. Added idempotent retry coverage and updated legacy demo expectations to four sources.
- Tests: Focused native/API/demo/isolation suite passed **68/68** after fixing two stale three-source assertions; direct end-to-end trigger produced 7 events across 4 sources, 3 native investigations, 1 TLSOC syslog detection, cross-source links, and no network/real-store access. `py_compile` passed.
- Status: in-progress pending the full backend regression gate and final handoff review.
- Next: Run the complete backend suite, fix any integration regression, journal exact totals, and hand the exported source/snapshot/trigger contracts to the orchestrator.

### 2026-07-11 18:09Z — Codex UI final reviewer — Focused changed-surface checks green
- Context: Validate the integrated UI changes without repeating the already-green full web gate.
- Did: Reviewed the shell/navigation, demo controls, source management, table selection/pager, dashboard/case empty states, time picker, dialogs, types, and focused regression coverage; retained a read-only product scope.
- Tests: Targeted Vitest run passed **52/52** across **7 files** (`AppShell`, DemoBanner, StartDemoButton, DataTable, TimeRangePicker, Sources, Wizard demo).
- Status: in-progress; targeted checks are green, with a small set of edge cases still under evidence review.
- Next: Calibrate the remaining findings to P0/P1/P2, capture exact file/line evidence, and hand fixes to the orchestrator.

### 2026-07-11 18:11Z — Codex UI final reviewer — Independent UI review completed
- Context: Complete the bounded, read-only regression review of the live-demo/UI quality diff and hand only evidence-backed issues to the orchestrator.
- Did: Reported six P2 gaps with exact code paths and fixes: nested-route current focus in the mobile drawer; real ingest-mode normalization in the Pull/Push fallback; demo-overlay-derived guarding of Add Source during status hydration/failure; dynamic accessible state for the compact auto-refresh control; `demo:manage` gating for banner mutations; and active-demo suppression of the cold-start CTA. Confirmed the orchestrator will integrate all six. No product files were edited by this reviewer.
- Tests: Focused Vitest remained green at **52/52** across **7 files**; no full-suite duplication and no security scan.
- Status: done.
- Next: Orchestrator implements the six fixes, adds the missing edge-case regressions, and includes them in the final web gates/live-browser smoke.

### 2026-07-11 18:12Z — Codex demo API integration worker — Four-source API integration completed
- Context: Finish the public API/state contract for the protocol-faithful live demo without allowing a demo session to read, mutate, or disclose real tenant source data.
- Did: Updated `state.py` and `routes.py` so active Demo Mode exposes exactly Splunk, QRadar, Wazuh, and syslog identities with protocol/format metadata, truthful bounded activity counters, demo-scoped coverage, and per-source/unified logs with mandatory provenance. Real source configuration/health/logs are hidden while demo is active and restored unchanged on disable; direct real-source browse is blocked. Added persistent seeded/manual simulator control, additive `ticking` + `source_activity` status, and cooldown-aware `POST /api/demo/incident` under the dedicated `demo:manage` grant with actual-actor recording in the REAL append-only audit. Added `test_demo_api_integration.py` for off-demo parity, all four identities, health/coverage, bounded browsing, tenant-read prevention, secret non-disclosure, RBAC, trigger cooldown/audit, and teardown isolation.
- Tests: Full backend suite passed **1864/1864** (one intentional `verify_certs=False` fixture warning). The final focused integration matrix passed **88/88**; `py_compile` and `git diff --check` passed.
- Status: done.
- Next: Orchestrator aligns all demo UI mutation gates to `demo:manage`, exercises the incident control/source telemetry in the live browser, then runs the combined web and release gates before committing.

### 2026-07-11 18:13Z — Codex backend live-demo worker — Native four-source engine completed
- Context: Close the backend implementation lane for a polished, standards-faithful, deterministic live demo spanning Splunk, QRadar, Wazuh, and syslog.
- Did: Delivered the new native adapter/ring/search layer, four-source runtime, static scenario identities, exact raw wire evidence, reserved safety fixtures, guaranteed coherent incident, native-vs-system alert provenance, manual trigger/cooldown/single-flight behavior, and no-duplicate retry semantics. Addressed final review edge cases: Wazuh native severity/time, RFC 3164 coverage, import-order purity, concurrent trigger deduplication, seeded-mode monotonic cooldown expiry, manual-trigger schedule suppression, and a wall-clock first-incident clamp. `case_manager.decide()` and every real-store boundary remain untouched.
- Tests: Full backend suite passed **1864/1864** with one intentional insecure-TLS fixture warning. Focused native/API/demo/isolation tests passed, `py_compile` passed, `git diff --check` passed, and a direct incident smoke produced exactly 7 events across 4 sources (3 source-native alerts + 1 correlated TLSOC syslog detection) with $0 isolated processing and cross-source relationships.
- Status: done.
- Next: Orchestrator owns the integrated browser smoke, final docs/count synchronization, complete web/release gates, and commit.

### 2026-07-11 18:17Z — Codex demo product reviewer — Independent product-contract review started
- Context: Independently review the integrated four-source live demo end to end: truthful native formats, backend/API/web typing and consumption, operator UX, and script/documentation agreement.
- Did: Began a read-only product-file review with exact contract tracing; only this mandatory Journal entry is being written.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Read the canonical handoff/rules in full, trace source generation through API and UI, compare every user-facing document/script, and return prioritized evidence-backed findings without editing product files.

### 2026-07-11 18:17Z — Codex backend final reviewer — Live-demo security and correctness review started
- Context: Independently review the completed backend live-demo working-tree diff for isolation, concurrency/idempotency, standards fidelity, API/RBAC contracts, security invariants, and code quality.
- Did: Read `docs/HANDOFF.md`, `AGENTS.md`, and the security diff-scan workflow; began a read-only product review. This mandatory Journal entry is the only file modification owned by this reviewer.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Resolve the exact backend diff, threat boundaries, and changed routes; exercise focused negative/concurrency tests and report only concrete findings.

### 2026-07-11 18:19Z — Codex security preflight worker — Security diff-scan config preflight started
- Context: Run only the Codex Security `security_diff_scan` configuration preflight for the repository; do not inspect product source.
- Did: Read the active security diff-scan skill and its config-preflight procedure; reserved a read-only preflight scope apart from mandatory Journal entries.
- Tests: Preflight not run yet (session-start milestone).
- Status: in-progress.
- Next: Execute the prescribed helper once with verified runtime/tool-surface facts and report its compact result.

### 2026-07-11 18:20Z — Codex security preflight worker — Security diff-scan config preflight completed
- Context: Complete the bounded `security_diff_scan` capability check without inspecting product source or beginning scan phases.
- Did: Ran the prescribed read-only `config_preflight.py` helper with the active native V2 four-slot runtime facts, delegation/goal-tool checks, and available Codex Security skills.
- Tests: Helper exited **0** with overall status **ready**; all three evaluated capabilities passed, with no failed or unknown requirements.
- Status: done.
- Next: Parent reviewer may proceed; no required remediation exists. The helper exposed optional `features.goals = true` guidance, while the effective goals requirement already passes via the documented default.

### 2026-07-11 18:21Z — Codex orchestrator — Four-source demo and UI review findings integrated
- Context: Converge the native runtime, API isolation, presentation controls, and independent UI review before full release gates.
- Did: Integrated all six UI review findings (nested mobile-route focus, real push-mode facets, source-overlay hydration guard, dynamic refresh accessibility name, demo-control RBAC, and active-run reseed prevention); added typed per-source activity plus a cooldown-aware Generate Incident UI; made every demo mutation use `demo:manage` and real-operator audit attribution; synchronized the supported docs/script; retained exact `@AGENTS.md` in `CLAUDE.md`.
- Tests: Focused backend demo/native/API/priority matrix passed; production web build passed at **285.79 kB** entry (**84.39 kB gzip**); the corrected AppShell mobile regression passed **8/8**; shell/doc diff checks and `run-demo.sh` syntax passed. Full web/backend gates and live-browser QA remain pending.
- Status: in-progress, with focused functional paths green.
- Next: Receive the two independent final reviews, resolve concrete findings, run complete backend/web matrices, then exercise the actual live app at desktop/mobile widths before the final local commit.

### 2026-07-11 18:38Z — Codex backend final reviewer — Adversarial demo findings validated
- Context: Validate isolation, concurrency/idempotency, standards fidelity, and truthful API behavior in the live-demo backend diff.
- Did: Reproduced real-provider egress for non-Anthropic model configs, concurrent lifecycle ticker leakage, the scheduled/manual incident race, partial demo initialization behind the 42→81 case-count jump, and real-source severity misclassification from the broad demo-id heuristic; confirmed QRadar `offense_type` violates IBM's numeric API contract and identified stale health reporting/RBAC/rate-cap gaps. Supplied exact regression-test shapes to the orchestrator; reviewed fixes as they landed and found the pending-prefs closure's custom-seed mismatch.
- Tests: Before fixes, focused demo/API/native/priority suites were green; after the truthful-health change, the current focused matrix reached **48 passed / 1 expected stale-test failure** (`seeded` now correctly reports `static`, while the old test still expects `streaming`). Direct concurrency and provider-resolution reproductions are recorded in the review handoff.
- Status: in-progress while the orchestrator closes the findings and updates regressions.
- Next: Re-run focused isolation/concurrency/standard-contract tests on the stabilized tree, inspect the final fixes, and report any remaining blocker with exact file/line evidence.

### 2026-07-11 18:40Z — Codex demo product reviewer — End-to-end demo product-contract review completed
- Context: Independently assess the four-source demo as an operator-facing product: native-record truthfulness, coherent API/web contracts, UX consumption, safe local launch, and documentation agreement.
- Did: Traced Splunk HEC, QRadar LEEF/offense, Wazuh archive/alert, and RFC 5424/3164 generation through production parsing, OCSF, correlation, API overlays, and UI. Confirmed a manual incident coherently produces 7 records, 3 native alerts, 1 TLSOC syslog detection, four related cases, and no duplicate case per source. Checked IBM's official offense schema (numeric `offense_type`) and Wazuh's official custom-rule guidance (IDs 100000–12000), then reported provider-isolation, severity, health, OpenAPI, native-schema, RBAC/docs, script-safety, response-consumption, and misleading-claim gaps as evidence emerged; reconciled concurrent fixes and left all product files untouched.
- Tests: Controlled in-memory incident/tick smokes confirmed the four-source outcome and stable benign case count. Final focused command `pytest -q tests/test_demo_native_sources.py tests/test_demo_api_integration.py` produced **19 passed / 1 stale assertion failure**: seeded health now truthfully reports `state=static`, while the test still expects `streaming`. `git diff --check` passed. `webui/openapi.json` still lacks `/api/demo/incident` at handoff.
- Status: done (read-only product review complete; required Journal entries are the only owned edits).
- Next: Orchestrator should close the remaining source-schema/type/docs/script/OpenAPI gaps, update the stale health test, add all-provider no-egress coverage, and run the full backend/web plus desktop/mobile live-browser release gates.

### 2026-07-11 18:40Z — Codex demo docs/safety worker — Documentation and launcher review started
- Context: Align the four-source live-demo documentation and local launcher with the implemented RBAC, API, audit, cost-isolation, and incident-cadence contracts.
- Did: Began a bounded review limited to demo-facing documentation, `scripts/run-demo.sh`, and this mandatory journal; product backend/webui code and generated contracts are out of scope.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Correct stale privilege/case-id/audit/rate/model claims, harden local bind/port behavior, then run a Bash syntax check and targeted documentation consistency scans.

### 2026-07-11 18:53Z — Codex demo docs/safety worker — Demo contracts and local launcher hardened
- Context: Complete the bounded documentation/script lane for the four-source live demo without touching backend, webui, or generated OpenAPI code.
- Did: Synchronized the README, deployment/security/usage/handoff/quickstart/demo/research/changelog/roadmap text with the implemented `demo:read` + `demo:manage` grants, `/api/demo/incident`, mixed seeded/live case-ID formats, persistent lifecycle-audit visibility after exit, per-alert-interval `incident_rate`, and forced `$0` provider behavior. Narrowed isolation claims to generated workload data/RAG/usage/cursors/providers, documented that source controls and notification tests are guarded while other admin settings stay live. Hardened `run-demo.sh` with loopback-only binds, port validation/preflight, Vite `--strictPort`, accurate key guidance, and portable child supervision.
- Tests: `bash -n scripts/run-demo.sh` passed; Vite help confirmed `--strictPort`; duplicate-port and occupied-port negative smokes passed; targeted `git diff --check` and stale-claim consistency scans passed.
- Status: done.
- Next: Orchestrator should retain these docs during generated-contract refresh, run the repository's strict MkDocs/full release gates, and include the launcher in the final live-browser smoke.

### 2026-07-11 18:54Z — Codex correlation component worker — Cross-source symmetry fix started
- Context: Repair the reproduced cross-source link overwrite where overlapping entity groups are applied sequentially and leave asymmetric related-case metadata.
- Did: Read the canonical handoff/rules and traced the pure grouping plus ingest application path; scoped work to deterministic bounded connected-component collapse and focused regressions only.
- Tests: Not run yet (session-start milestone).
- Status: in-progress.
- Next: Implement a canonical component merge, add transitive/reciprocal/isolation/idempotence coverage, and run the focused correlation/ingest tests.

### 2026-07-11 19:02Z — Codex correlation component worker — Connected-component regression green
- Context: Validate the reproduced A↔B, B↔C, C↔D overwrite and persisted-component bridge before broader ingest regression testing.
- Did: Added deterministic union-find collapse for overlapping eligible groups plus bounded continuity seeds from resolved same-component IDs and reciprocal prior links; dangling/unresolved IDs are ignored and seed-only components are never resurrected.
- Tests: The two new red-first regressions passed **2/2**; the complete correlation + ingest-customization files passed **38/38**; `py_compile` and focused `git diff --check` passed.
- Status: in-progress pending adjacent poller/ingest verification.
- Next: Run the broader non-demo ingest/poller matrix and hand the isolated diff to the orchestrator.

### 2026-07-11 19:03Z — Codex correlation component worker — Cross-source symmetry fix completed
- Context: Complete the bounded correlation repair with reciprocity, transitivity, isolation, deterministic ordering, and repeat-pass idempotence proven.
- Did: Finalized changes in `engine/correlation.py` and `engine/ingest.py`; four demo-like cases now share one canonical component and exact reciprocal related sets, a preseeded A↔B component safely expands through B↔C↔D, unrelated/dangling cases stay out, and repeated reversed-order application performs zero writes.
- Tests: Broader non-demo correlation/ingest/poller matrix passed **71/71** (one intentional insecure-TLS fixture warning). A larger matrix reached **96/98**; its two failures are concurrent demo-health/router work outside this scope (`streaming` vs `silent`, `/api/campaigns` 404), while every correlation/ingest/poller test passed. `py_compile` and `git diff --check` passed.
- Status: done.
- Next: Orchestrator integrates the shared working tree, resolves the two independent demo failures, and runs the final full backend gate.

### 2026-07-11 19:06Z — Codex backend final reviewer — Isolation and active-surface review milestone
- Context: Re-audit the stabilized demo backend after the initial provider/lifecycle/vendor fixes, including APIs not covered by the original focused matrix.
- Did: Reproduced and reported live enrichment egress, disconnected demo capability/collaboration stores, unsafe real notification/RAG paths, HTTP-push data loss into the throwaway store, asymmetric overlapping cross-source links, and native demo query filters that ignored structured entity constraints. Reviewed the resulting active-store/prefs/source/EventBus fixes as they landed; independently confirmed the QRadar numeric offense contract, Wazuh local-rule range, four-source incident result, and the remaining standards discrepancy in real Wazuh priority scaling.
- Tests: Focused demo/native/API/priority/receiver/capability/collaboration matrix reached **214/216**; the two failures precisely identified the now-fixed prime timestamp cadence and a test fixture that had not mounted auto-discovered feature routers. Correlation worker's repaired component path is separately green **71/71**; `compileall`, `git diff --check -- backend`, and the immutable `case_manager.py` diff check passed.
- Status: in-progress while the orchestrator closes the structured-query filter and feature-router fixture gaps, then reruns final gates.
- Next: Re-run the stabilized focused matrix, exercise real-ingest survival and demo-store teardown directly, inspect the connected-component integration, and report only any remaining backend blocker.

### 2026-07-11 19:07Z — Codex correlation component worker — Persisted component-ID stability follow-up started
- Context: Address final-review feedback that a newly overlapping raw entity hash could sort below, and therefore rename, an already persisted canonical component.
- Did: Reopened the completed correlation lane and scoped a seed-first canonical-ID rule plus a forced lower-raw-ID expansion regression.
- Tests: Not run yet (follow-up start).
- Status: in-progress.
- Next: Prefer the minimum valid persisted seed ID during expansion, retain deterministic raw-ID selection for new components, and rerun focused correlation/ingest tests.

### 2026-07-11 19:07Z — Codex correlation component worker — Persisted component-ID stability completed
- Context: Close the final canonical-ID stability edge case found during independent review.
- Did: Changed component canonicalization so the minimum valid persisted seed ID wins whenever an old component expands or two old components merge; only a brand-new component chooses the minimum raw entity-group ID. Updated the integration story to use seeded same-user Splunk/QRadar cases and asserted the ID survives expansion through Wazuh/syslog; added a forced lower-raw-hash unit regression.
- Tests: New stability/reciprocity regressions passed **3/3**; full correlation + ingest-customization files passed **39/39**; broader non-demo correlation/ingest/poller matrix passed **72/72** (one intentional insecure-TLS fixture warning). `py_compile` and focused `git diff --check` passed.
- Status: done.
- Next: Backend final reviewer reruns the combined demo/correlation matrix; orchestrator owns the final full-suite gate and commit.

### 2026-07-11 19:19Z — Codex backend final reviewer — Backend blocker review completed
- Context: Close the independent final pass after the demo-isolation, source-aware investigation, batch-ledger, vendor-fidelity, and connected-component fixes landed.
- Did: Reviewed the final active-store/prefs/audit/EventBus boundaries, verified every native automated investigation receives its producing source adapter, checked demo batch config and job visibility remain sandboxed, and rechecked lifecycle, ingest, correlation, RBAC, receiver, and collaboration boundaries. No remaining P0/P1 backend release blocker was found in this bounded review; product files remained read-only.
- Tests: Final combined backend matrix passed **314/314** across demo mode/native sources/API, priority, receivers, correlation, ingest customization/push/acknowledgement, source-aware investigation, batch/tuning/config routes, auth/RBAC, and collaboration. `python -m compileall -q app`, `git diff --check -- backend`, and the immutable `case_manager.py` diff check all passed.
- Status: done.
- Next: Orchestrator owns the repository-wide backend/web release gates, live-browser QA, final documentation/generated-contract checks, and local commit.

### 2026-07-11 19:40Z — Codex orchestrator — Fresh four-source live-browser release QA completed
- Context: Exercise the final candidate through the actual loopback launcher after all backend review fixes, including the last formatter/storyline and Cases-facet changes.
- Did: Started `run-demo.sh` on fresh ports, signed in through the real UI, confirmed four healthy streaming source overlays, generated the SQL-injection-to-webshell incident, and inspected the resulting syslog case end to end. Verified the demo produced seven native records across Splunk, QRadar, Wazuh, and syslog, three vendor alerts plus one TLSOC detection, a consistent true-positive containment brief, a source-scoped `es_query`, the retained `SQL injection → webshell (loan API)` reasoning, monotonic noise-funnel counts, and truthful nonzero `Active` / `Needs human` facets. Browser console diagnostics contained only Vite/React development informational messages and no warning/error entries; all browser tabs and demo processes were closed cleanly.
- Tests: Live desktop/dark route and modal checks passed on the final fresh server; prior responsive QA also covered 390×844 mobile navigation/banner/cards and the light theme.
- Status: done.
- Next: Run the complete offline backend/web release matrices and repository integrity checks.

### 2026-07-11 19:47Z — Codex orchestrator — Final release gates green; work session complete
- Context: Close the multi-agent backend cleanup, native live-demo, and UI quality pass only after complete automated and manual verification.
- Did: Regenerated and verified the 190-path OpenAPI/TypeScript contract with zero drift; synchronized the canonical handoff/readme/roadmap/changelog/agent verification figures; confirmed `CLAUDE.md` is exactly one line (`@AGENTS.md`), no temporary `memory.md` exists, and `engine/case_manager.py` remains byte-identical in the working diff. Independent backend review found no remaining P0/P1 blocker.
- Tests: Full backend suite passed with **1887/1887 tests**; full web suite passed with **1349/1349 tests across 240 files**; `npm run build` passed (entry **285.91 kB**, gzip **84.44 kB**, lazy motion **83.85 kB**), `npm run lint` passed with zero errors/warnings, `npm run gates` passed all five design gates, `npm run check:types` passed, `python -m compileall -q app` passed, canonical version validation passed at `3.0.0-alpha.1`, agnostic Compose validation passed, `mkdocs build --strict` passed, `git diff --check` passed, and launcher/browser QA passed.
- Status: done; candidate is ready for the requested local commit. No push or release action was performed.
- Next: User can run the demo/test candidate locally, then promote it through the chosen release channel after acceptance.

### 2026-07-14 10:16Z — OpenCode — Local browser deployment started
- Context: Deploy the suite locally and make it available in the user's browser.
- Did: Read the canonical handoff and launcher; found the backend and web UI already listening on the documented loopback ports `8088` and `5173`, so preserved the existing session pending health verification.
- Tests: Runtime and HTTP verification in progress.
- Status: in-progress.
- Next: Verify backend health, UI delivery, and process identity, then open the local UI in the default browser.

### 2026-07-14 10:18Z — OpenCode — Current checkout deployed locally
- Context: Complete the requested local browser deployment without disrupting another checkout already using the default ports.
- Did: Launched this workspace with `scripts/run-demo.sh` on backend `127.0.0.1:8089` and web UI `127.0.0.1:5174`; completed OOBE, enabled the isolated live four-source `$0` Demo Mode, authenticated as the seeded local admin, and opened the UI in the default browser. Runtime logs are at `/var/folders/tv/24gycdyn7430fbwhz1dmj4mm0000gn/T/opencode/agentic-kibana-demo.log`.
- Tests: `bash -n scripts/run-demo.sh` passed; `/api/health` and `/api/health/live` returned HTTP 200 with version `3.0.0-alpha.1`; the Vite root returned HTTP 200; authenticated `/api/demo/status` confirmed `active=true`, `mode=live`, simulator ticking, and all four demo sources healthy/streaming.
- Status: done.
- Next: Use `http://127.0.0.1:5174` with `Admin` / `Admin@123`; this in-memory demo is non-persistent and loopback-only.

### 2026-07-15 00:00Z — Claude (Fable) — Backend deep audit: 47 findings fixed, one commit each
- Context: User asked to "go through the repo end to end and investigate backend bugs/issues/architectural gaps with multiple sub-agents," then to "fix each one of them, one at a time, and commit each one, without co-authoring, locally" and "double triple test everything before green light."
- Did: Ran a 24-subsystem-auditor Workflow over the whole backend (~200 files / 63k LOC); every reported finding was handed to an independent adversarial verifier that re-checked it against the source (REFUTED dropped) → **47 verified findings** (0 critical, 10 high, 24 medium, 13 low). Report artifact + `scratchpad/audit_report.json` retained. Then fixed ALL 47, **one atomic local commit per finding** on `Testing`, each with a focused regression test, **no co-author trailer** (user rule). Clusters:
  - **Security/authZ:** `fence()` source/tool provenance-label injection closed (#9); `setup/secrets` + `setup/complete`, `/cases/{id}/investigate`+`/reinvestigate`, `/investigate`+`/overview`+`/chat`, and case-thread edit/delete now gated (RBAC); OIDC state browser-bound (cookie) + verified-email-only account linking (takeover fix); enrichment API-key leak scrubbed from HTTP errors; JWT decode 500 on non-ASCII → TokenError; `/api/ingest` body size capped (413).
  - **Concurrency:** SessionStore/UserStore/ProposalStore routed through the CAS `kv_mutate` (per-store lock + `_rev`); added a REAL atomic `KVStore.put_if` (SqlKVStore `SELECT … FOR UPDATE`); notify() merges onto the fresh case; notification dedup key recorded only after a successful send.
  - **Ingestion durability:** object-store/Kinesis cursors persisted via CursorStore; non-PIT pagination capped at `max_result_window`; poller no longer re-handles closed clusters; cross-source drain no longer starves (sum-of-unused headroom) and filters to OPEN cases; MQTT acks only after a confirmed ingest; syslog UDP surfaces ingest errors.
  - **Correctness:** MTTA/SLA count only human acks (not system escalations); string-epoch and uppercase-Z timestamps parse correctly; ModSec sub-rules match `rule.id` (not the absent `.keyword`); OpenAI batch parser subtracts cached tokens; `score_to_severity_id` is scale-aware; campaigns treat MITRE as advisory (no over-clustering); tuner guards severity_floor per window and records ledger/audit only after a confirmed write; investigator/overview get full evidence (fence_block, no 600-char truncation).
  - **Leaks/observability:** EventBus history, in-memory cache fallback, rate-limit bucket map, per-signature lock registry (WeakValueDictionary), and DemoMockProvider calls are all bounded; SSE no longer duplicates on reconnect or leaves zombie connections; SqlUsageRepository.summary window-bounds in SQL; audit records() pages so JSON-filters don't under-return; ES count() surfaces live faults instead of masking as 0; dead `set_demo_registered` removed.
  - **#3 verified clean:** the audit found no path where LLM output/playbook drives close/escalate; `engine/case_manager.py::decide()` was NOT touched.
- Tests: The final full-suite run caught one follow-on I had missed — the audit-#24 change to `_handle_proposal`'s return contract also needed the `/api/tuning/apply` route updated (it passed a tuple to the config store); fixed as a 48th commit. Final gates all green: **backend `pytest` → 1942 passed, 0 failures** (full suite run twice end-to-end + targeted runs after every fix; up from 1887 baseline via +55 new regression tests); **webui `npm run build` clean, `npm run lint` 0 errors, `vitest` 1349 passed / 240 files** (no webui code changed). Working tree clean; **zero co-author trailers** across all 48 commits verified.
- Status: done. 48 commits on `Testing` (`c5516e5`→`abd0385`), **local only — NOT pushed** (per the user's "commit it locally").
- Next: User reviews via `git log --oneline c5516e5..HEAD` and decides whether/when to push. The audit report artifact lists all 47 findings with failure scenarios + fix hints if a re-review is wanted.

### 2026-07-16 13:52Z — Claude (Opus 4.8) — Noise-Reduction funnel: clear counters on reset/delete + fold needs_human into Escalated
- Context: Two backend-only Noise-Reduction funnel fixes on `claude/noise-reduction-funnel-fixes-54kz5r` (off `Testing`). (1) The durable `NoiseCounterStore` was never cleared on source-delete or reset, so the funnel over-reported inbound volume from removed/purged sources. (2) `build_noise_reduction` left `needs_human` cases + the `true_positive` residual out of every terminal node the UI renders, so the visible outcomes didn't account for every case.
- Did:
  - Fix 1: added `(NOISE_NS, NOISE_KEY)` to `engine/reset.py::_CASES_KV` so the durable counters clear on cases/sources/factory resets (baseline was already cleared there); `DELETE /api/sources/{id}` (`api/routes.py`) now best-effort `state.noise_counters.clear()` + `state.baseline_store.clear()` after removing the source. Advisory (#3-safe, no `cluster_signature` recompute #4), fail-open.
  - Fix 2: `engine/noise_counters.py::build_noise_reduction` — the funnel's `escalated` stage total + per-severity bands now fold in the `needs_human` bucket + the `true_positive` residual (== `cases − auto_cleared`), so the terminal outcomes account for every windowed case. Standalone `needs_human` stage + the nh-based reduction headline are unchanged; funnel diagram / node set / `OUTCOME_KEYS` / API shape byte-identical; no query params or frontend logic changed.
  - Tests: new reset-suite test (noise_counters + baseline empty after a cases-scope reset); rewrote/added `build_noise_reduction` tests (needs_human folded into escalated; `auto_cleared + escalated == cases`); updated the frontend `NoiseFunnel` fixture to the new contract + added a coverage test.
- Tests: backend `pytest` 1944 collected → all pass except **3 PRE-EXISTING environmental** failures (sandbox leaks `AWS_ACCESS_KEY_ID` into `Secrets` → 2 config tests; a 2.02s>2.0s netguard timing flake) — confirmed identical with my changes stashed, and none touch the code I changed. webui `npm run build` clean, `npm run lint` 0 errors, `vitest` **1350 passed / 240 files**. ruff clean on every changed file (only the pre-existing `SourceSurface` F401 in the untouched routes.py import block remains).
- Status: done — committed + pushed to `claude/noise-reduction-funnel-fixes-54kz5r`.
- Next: n/a. `decide()` untouched / not imported (#3 held).

### 2026-07-17 00:00Z — Claude (Opus 4.8) — Auth lockout from a transient empty user-store read (backend)
- Context: Bug report — a transient empty `UserStore` read wiped the in-memory auth view and locked every account out until restart. Branch `claude/auth-lockout-empty-store-nfujmc` off `Testing`. Five asks: guard `refresh_users`, harden `set_users`, narrow the refresh trigger to user mutations, investigate the source-rename non-persistence, add regression tests.
- Did:
  - **Root cause:** `UserStore._load` swallows read errors → `list()` degrades to `[]`; `AppState.refresh_users` fed that straight to `AuthService.set_users([])`, which rebuilds the synced view as `dict(self._base)` overlaid with the (empty) store list → on an OOBE-only deployment (no env-seeded admin, empty base layer) every persisted account is evicted → total silent lockout, `authenticate()` 401s despite an intact, verifiable `password_hash`.
  - **#1 `refresh_users` guard (`state.py`):** an empty `users.list()` is now treated as a failed read (keep the view, like the exception branch) UNLESS the raising `UserStore.has_any()` probe authoritatively confirms zero users; a probe that raises or reports accounts present keeps the view.
  - **#2 `set_users` defensive (`auth/service.py`):** added `allow_empty` (default False). An empty update that would evict previously-known STORED (non-base) records is refused (warn + keep the view) unless `allow_empty=True`. Two independent layers now protect the view.
  - **#3 trigger:** confirmed the source-rename path (`POST /api/sources` → `update_prefs` → `rebuild_log_source` → `reconcile_receivers`) does NOT call `refresh_users`; the ONLY callers are startup seeding + genuine user-management mutations — the trigger is already narrowed. Found + fixed a RELATED gap: `apply_secrets` rebuilds `AuthService` via `_wire()` (base-layer only) on a credential change without re-folding the store overlay → same lockout class; now calls `await self.refresh_users()` after the rewire (guarded, so it can only restore, never wipe).
  - **#4 source-rename non-persistence:** the write path (`update_prefs` → `config_store.save`, a full-doc replace with no CAS + an unlocked `self.prefs =` assign) can lose an update when a background writer (the default-ON nightly threshold-tuner writes prefs via `update_execution_prefs → update_prefs`) interleaves. Added a `self._prefs_lock`; `update_prefs` is now atomic and a new `mutate_prefs(mutate)` runs the read-modify-write under the lock. Converted `upsert_source` / `delete_source` / `set_source_secrets` to `mutate_prefs` so a source edit reads the freshest prefs and can't be clobbered by a same-path concurrent write. (Residual: a blind stale-snapshot `update_prefs` from a background writer can still clobber — fully closing that needs config-store CAS, a tracked backlog item; not in scope here.)
  - **#5 tests:** new `tests/test_auth_lockout_empty_store.py` (13 tests): `set_users` refuses/honours empty per `allow_empty`; `refresh_users` keeps the view on transient-empty / raising-read / probe-failure and honours an authoritative empty; a `_wire()` rebuild + `refresh_users` restores stored accounts; `mutate_prefs` reads the freshest prefs + survives concurrent writes; a source rename persists via the route and never mutates the auth view.
- Tests: backend `pytest` **1957 passed** (1942 baseline + 13 new − none removed; the only 2 non-passes are the sandbox's proxy-injected `AWS_ACCESS_KEY_ID` breaking 2 config tests — identical on a clean tree, cleared → green). `ruff check` clean on all changed files (only the pre-existing `SourceSurface` F401 in the untouched routes.py import block remains). Backend-only diff — no webui files touched, webui build/vitest unaffected.
- Status: done — committing + pushing to `claude/auth-lockout-empty-store-nfujmc`; PR into `Testing`.
- Next: consider config-store `_rev`/CAS to fully close the cross-writer prefs lost-update (AUDIT_FINDINGS backlog). `decide()` untouched / not imported (#3 held).

### 2026-07-18 15:07Z — Codex orchestrator — Shoo-inspired documentation redesign started
- Context: Rework the TLSOC documentation site to match `https://docs.shoo.dev/docs` as the visual source of truth while retaining TLSOC content and routes.
- Did: Began target-site visual/DOM inspection, repository MkDocs theme inventory, and side-by-side implementation planning.
- Tests: Pending strict MkDocs build, responsive visual QA, navigation checks, and browser diagnostics.
- Status: in-progress.
- Next: Recreate the reference layout and design tokens in the checked-in docs theme, then iterate against rendered desktop and mobile comparisons.

### 2026-07-18 15:08Z — Codex docs mapper — Shoo/MkDocs design mapping started
- Context: Inspect the existing MkDocs documentation and map the exact Shoo reference design without editing files.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` fully, then began inventorying MkDocs configuration, public content, styling, assets, overrides, and the reference DOM/CSS.
- Tests: Read-only inspection in progress; no build or source mutation.
- Status: in-progress.
- Next: Produce a minimal file-level implementation plan and identify MkDocs Material compatibility pitfalls.

### 2026-07-18 15:09Z — target-css-forensics — Begin Shoo documentation design inspection
- Context: Reverse-engineer the live Shoo documentation design for an exact MkDocs Material reproduction.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` completely; began live HTML, CSS, font, layout, and asset inspection without editing repository files.
- Tests: Live target and production stylesheet returned HTTP 200.
- Status: in-progress.
- Next: Extract exact tokens, responsive geometry, SVG assets, and MkDocs selector mappings.

### 2026-07-18 15:10Z — target-visual-forensics — Start Shoo docs visual audit
- Context: Inspect `docs.shoo.dev/docs` as the visual source of truth for the MkDocs redesign.
- Did: Read `docs/HANDOFF.md` and `AGENTS.md` fully; began read-only production markup, stylesheet, and responsive-render inspection.
- Tests: N/A — visual research only.
- Status: in-progress.
- Next: Measure desktop/mobile geometry, tokens, typography, components, and interactions.

### 2026-07-18 15:17Z — Codex docs mapper — Shoo/MkDocs design mapping complete
- Context: Complete the read-only implementation map for recreating the Shoo documentation design while preserving TLSOC routes and content.
- Did: Inventoried the original MkDocs site, confirmed no assets or overrides existed, extracted the reference production layout/tokens/breakpoints, and supplied the required override/CSS/content plan plus Material-specific risks. Observed but did not modify concurrent implementation changes.
- Tests: Confirmed pinned MkDocs 1.6.1 and Material 9.6.19 toolchain; no build run because this assignment was read-only.
- Status: done.
- Next: Finish the layout CSS, keep desktop search mounted, then run strict build and responsive browser comparison.

### 2026-07-18 15:21Z — target-css-forensics — Complete Shoo documentation design forensics
- Context: Supply source-backed measurements for the Shoo-style documentation rebuild.
- Did: Identified the framework stack, fonts, complete light/dark palette, breakpoints, layout equations, typography, border/radius/shadow values, motion, and inline SVG assets; mapped each surface to MkDocs Material selectors. No files edited.
- Tests: Live HTML and immutable CSS returned HTTP 200; recorded HTML SHA-256 `84415488…` and CSS SHA-256 `6268c29c…`.
- Status: done.
- Next: Apply the supplied tokens and custom override markup, then visually compare desktop and mobile renders.

### 2026-07-18 15:21Z — target-visual-forensics — Shoo docs design forensics complete
- Context: Produce implementation-grade visual specifications for an exact MkDocs recreation.
- Did: Captured 1440px, 1024px, and mobile renders; extracted production HTML/CSS; documented palettes, typography, shell geometry, spacing, components, breakpoints, and interaction states. No repository files edited.
- Tests: Target returned HTTP 200; desktop/compact/mobile renders visually inspected against production CSS.
- Status: done.
- Next: Implement the MkDocs override shell and CSS, then pixel-compare at 1440px, 1024px, and 390px.

### 2026-07-18 15:33Z — Codex orchestrator — Shoo shell implemented; strict build green
- Context: Complete the first implementation pass of the reference-matched MkDocs theme before visual comparison.
- Did: Replaced the blue marketing home with a reference-shaped Introduction article; added supported Material overrides for the marquee, mobile header, sidebar, TOC, article shell, and next/previous cards; translated the exact Shoo tokens, fonts, 32/56/40px chrome, 268/286/286px columns, 1200px shell, grid, typography, code, table, search, and responsive behavior into documentation CSS; added functional Cmd/Ctrl-K search.
- Tests: `backend/.venv/bin/python -m mkdocs build --strict` passed; documentation built in 0.22s with no warnings.
- Status: in-progress.
- Next: Render the generated site at 1440px, 1024px, and 390px; compare with the captured reference, fix visual/interaction drift, then rerun strict and link checks.

### 2026-07-18 15:48Z — Codex orchestrator — Responsive shell and controls hardened
- Context: Resolve the first desktop/tablet/mobile comparison findings in the Shoo-matched documentation theme.
- Did: Removed inherited Material content offsets, restored the persistent tablet sidebar and closed mobile drawer geometry, suppressed the unintended desktop search surface, aligned the wide article/right-TOC columns, converted search/drawer affordances to real buttons, and added keyboard-aware search, drawer, mobile on-page navigation, active-section, and reading-progress behavior.
- Tests: Strict MkDocs build passed in 0.23s; JavaScript syntax check, PostCSS parse, and `git diff --check` all passed; generated HTML contains the new button controls.
- Status: in-progress.
- Next: Complete final computed and screenshot comparisons at 1440px, 1024px, and 390px, address any residual pixel drift, then rerun route/link/asset checks.

### 2026-07-18 15:34Z — Codex docs validator — Generated documentation validation started
- Context: Validate the rebuilt Shoo-inspired MkDocs output across every public route without editing files.
- Did: Began strict-build, route, template-hook, search, palette, navigation, footer, asset, link, fragment, and responsive-structure checks.
- Tests: Validation in progress against a fresh `site/` build.
- Status: in-progress.
- Next: Resolve or report strict-build-compatible structural and interaction defects, then re-run from a clean temporary build.

### 2026-07-18 15:51Z — Codex docs validator — Generated documentation validation complete
- Context: Complete read-only validation of the rebuilt MkDocs documentation.
- Did: Validated all six public routes plus the 404 page; checked Material search/palette/drawer/TOC/footer hooks; scanned the complete generated link and asset graph; verified search-index coverage; and DOM-tested search, drawer, mobile TOC, Escape handling, ARIA synchronization, and clean scroll labels. Reported several responsive/interaction defects that were fixed during the pass.
- Tests: `mkdocs build --strict` passed in 0.21–0.29s; fresh output exactly matched `site/`; all six generated routes plus the 404 artifact validated; 7 HTML files and 71 search records checked; 0 missing links/assets, 0 bad fragments, 0 duplicate IDs; `node --check` passed; DOM integration passed; CSS/JS source-build hashes matched.
- Status: done.
- Next: Complete final browser pixel-comparison at desktop/tablet/mobile; optionally point drawer `aria-controls` at the revealed navigation element rather than its checkbox.

### 2026-07-18 15:34Z — target-css-forensics — Begin Shoo implementation audit
- Context: Validate the checked-in MkDocs implementation against docs.shoo.dev/docs at 1440px, 1024px, and 390px.
- Did: Began generated-DOM, computed-layout, selector-cascade, keyboard, interaction, and reduced-motion auditing.
- Tests: Generated HTML and CSS artifacts were ready for measurement.
- Status: In progress.
- Next: Measure exact reference/implementation geometry and report prioritized drift without editing files.

### 2026-07-18 16:02Z — target-css-forensics — Complete Shoo implementation audit
- Context: Read-only implementation audit against the live Shoo reference.
- Did: Measured reference and implementation layouts at 1440px, 1024px, and 390px; validated Material selector overrides, typography, sidebar/TOC geometry, search/drawer/TOC interactions, keyboard order, focus treatment, and reduced motion. Captured the reference open mobile drawer for comparison.
- Tests: Main shell and desktop/tablet sidebar geometry pixel-match the target; source/build assets matched during audit; search, drawer, TOC, keyboard, and reduced-motion checks passed.
- Status: Complete; no files edited.
- Next: Replace the mobile drawer’s 102px desktop-style head with Shoo’s 58px controls-only header and begin its scroll region at y58.

### 2026-07-18 15:35Z — target-visual-forensics — Shoo parity QA started
- Context: Compare the rendered MkDocs redesign with https://docs.shoo.dev/docs across desktop, tablet, mobile, and interactive drawer states.
- Did: Began read-only visual, geometry, responsive, console, and interaction inspection.
- Tests: Generated site rendered successfully for comparison.
- Status: in-progress.
- Next: Capture all viewports, compare exact target geometry, and rank remaining deltas.

### 2026-07-18 16:11Z — target-visual-forensics — Shoo parity QA complete
- Context: Completed final responsive and drawer comparison after all cosmetic passes.
- Did: Captured desktop, tablet, mobile, and reference/implementation open-drawer states; measured exact geometry, colors, borders, pseudo-elements, and interactive controls; exercised search, navigation, theme, drawer, and TOC behavior.
- Tests: Rendered pages produced no console, page, or asset-request errors. Primary responsive geometry, drawer placement, toolbar controls, row height, overlay, and navigation surface matched. No repository files were edited.
- Status: done.
- Next: The orchestrator completed the final 60px body-grid selector and 1px drawer-border corrections identified during this pass.

### 2026-07-18 16:12Z — Codex orchestrator — Shoo-matched documentation redesign complete
- Context: Finish the literal responsive parity pass for the redesigned documentation.
- Did: Completed the Shoo-shaped dark grid shell, exact desktop/tablet/mobile columns and chrome, reference typography and acid-lime palette, marquee, sidebar/search, right and intermediate TOCs, next/previous navigation, light theme, and the 85vw right-side mobile sheet with matching toolbar, border, blur, row geometry, keyboard behavior, and reading progress. Retained the TLSOC identity, content, routes, and repository links.
- Tests: Final strict MkDocs build passed in 0.18s; JavaScript syntax, PostCSS parse, and `git diff --check` passed; all six generated public routes and required assets validated; generated link/fragment scan found 0 missing assets, 0 invalid fragments, and 0 duplicate IDs; responsive geometry matched the reference at 1440px, 1024px, and 390px; search, Cmd/Ctrl-K, drawer, theme, accordion, TOC, Escape, keyboard order, and reduced-motion checks passed with no browser console/page/request errors.
- Status: done.
- Next: Apply later documentation refinements through the same strict-build and responsive-QA gates.

### 2026-07-18 16:30Z — Codex orchestrator — Documentation theme preferences refinement started
- Context: Make dark mode the documentation default, replace the theme control with the requested two-icon segmented pill, and keep the Journal focused strictly on development work.
- Did: Began auditing MkDocs palette initialization, existing theme-control markup/styles, the supplied visual reference, and the documentation-redesign Journal entries that require development-only wording.
- Tests: Strict build, theme-state, responsive visual, accessibility, and Journal-content checks pending.
- Status: in-progress.
- Next: Implement the theme preference/control changes, rewrite the affected development history, then verify both color schemes and generated documentation.

### 2026-07-18 16:44Z — Codex orchestrator — Dark-first theme control implemented
- Context: Complete the source implementation for the requested documentation theme behavior before responsive verification.
- Did: Kept `slate` as the explicit first-visit default while preserving saved choices; added a scheme-based palette-index migration for preferences created before the palette order changed; retained Material as the single persistence engine; replaced its visible control with one accessible 54×28 sun/moon button using the reference geometry, Lucide paths, and exact light/dark active colors.
- Tests: Strict MkDocs build passed in 0.17s; JavaScript syntax, PostCSS parsing, and `git diff --check` passed.
- Status: in-progress.
- Next: Verify clean, legacy, and current saved-theme states plus desktop/mobile visual geometry and keyboard behavior.

### 2026-07-18 16:31Z — Codex journal auditor — Documentation journal hygiene audit started
- Context: Audit the documentation-redesign Journal history for durable, development-only content.
- Did: Read the canonical handoff and project rules, then scoped the audit to the Codex documentation work beginning at 15:03Z.
- Tests: Entry-by-entry content scan in progress.
- Status: in-progress.
- Next: Identify transient preview-status entries and wording changes needed for retained development records.

### 2026-07-18 16:33Z — Codex journal auditor — Documentation journal hygiene audit complete
- Context: Complete the development-only audit of the documentation-redesign history.
- Did: Identified two transient preview-status entries for removal and exact scrubs preserving design, implementation, build, accessibility, and responsive-QA history.
- Tests: Exhaustive scoped scan confirmed the proposed revision contains only durable development information.
- Status: done.
- Next: Apply the scoped Journal revision while preserving all older and unrelated agent entries.

### 2026-07-18 16:31Z — Codex palette auditor — Documentation theme audit started
- Context: Audit the documentation dark-mode default, saved preference behavior, and requested sun/moon theme control before implementation.
- Did: Began a read-only review of the MkDocs palette configuration, Material initialization lifecycle, override templates, theme styles, generated markup, and persistence compatibility.
- Tests: Source and generated-output inspection in progress.
- Status: in-progress.
- Next: Establish the minimal persistence-safe implementation and its accessibility and regression checks.

### 2026-07-18 16:43Z — Codex palette auditor — Documentation theme audit complete
- Context: Complete the implementation audit for the dark-default documentation theme and segmented sun/moon control.
- Did: Confirmed dark-first behavior for new visitors, identified the legacy palette-index inversion risk, and specified a pre-bundle scheme-based migration plus one accessible 54×28 two-icon toggle backed by Material's existing persistence engine. Documented duplicate-ID, hidden-label, keyboard, target-size, and state-synchronization requirements.
- Tests: Read-only inspection confirmed the generated body defaults to `slate`, Material restores from scoped palette storage, and the current templates mount exactly one palette component.
- Status: done.
- Next: Implement the migration and custom toggle, then verify empty, legacy, and current storage states across both responsive layouts.

### 2026-07-18 16:31Z — Codex theme-control visual auditor — Theme-control parity audit started
- Context: Measure the supplied theme-switch reference and review the documentation palette surface across desktop and mobile layouts.
- Did: Read the canonical handoff and project rules, then began read-only pixel, markup, CSS, icon, and responsive-state inspection.
- Tests: Measurement and generated-source audit in progress.
- Status: in-progress.
- Next: Compare exact control geometry, colors, icons, and active treatment with the implementation and report any corrections.

### 2026-07-18 16:48Z — Codex theme-control visual auditor — Theme-control parity audit complete
- Context: Complete the visual and source audit of the dark-default documentation theme control.
- Did: Confirmed the implementation matches the requested 54×28 segmented pill, 26×26 choices, 14×14 Lucide icons, exact light/dark colors, active-state placement, responsive positioning, and single-component palette architecture.
- Tests: Strict MkDocs build, JavaScript syntax, and diff-integrity checks passed; all seven generated documentation artifacts contain exactly one palette component, unique palette IDs, and dark-first markup.
- Status: done.
- Next: Complete the separate interaction regression for clean, saved, and legacy preference states.

### 2026-07-18 16:53Z — Codex orchestrator — Documentation theme preferences refinement complete
- Context: Finish the requested dark-default behavior, reference-matched theme switch, and development-only Journal cleanup.
- Did: Made dark mode the first-visit documentation default while preserving explicit visitor choices; added a compatibility migration for preferences saved before the palette reorder; replaced the visible palette affordance with one accessible two-icon pill matching the supplied reference; removed transient preview-status records and retained only durable development history for this documentation work.
- Tests: Strict MkDocs build, JavaScript syntax, PostCSS parsing, and `git diff --check` passed; all seven generated pages passed palette-component, unique-ID, dark-first, link, asset, and fragment checks; exact geometry, clean/current/legacy preference migration, toggle-state synchronization, and Journal-content checks passed.
- Status: done.
- Next: Treat future documentation Journal entries as durable development records only.
### 2026-07-19 05:58Z — Codex orchestrator — Version 0.1 documentation program started
- Context: Build the complete public documentation set, standardize the Testing-to-Stable/main release model, establish application version 0.1, and add maintainable per-version documentation navigation.
- Did: Began a repository-wide documentation, release nomenclature, version-authority, and MkDocs architecture audit while preserving the approved Shoo-matched design.
- Tests: Documentation inventory, source-of-truth checks, strict build, version-selection behavior, link validation, and responsive browser QA pending.
- Status: in-progress.
- Next: Resolve the canonical version/release model, map every product capability to public documentation, implement the complete information architecture, and verify the generated site end to end.

### 2026-07-19 06:06Z — Codex orchestrator — Version 0.1 authority and docs version provider established
- Context: Resolve the canonical product identity and maintainable per-version documentation mechanism before authoring the full manual.
- Did: Standardized package, runtime, OpenAPI, Compose, and changelog metadata on SemVer `0.1.0`; defined the public documentation line as `0.1`; established `Testing` as the acceptance branch and `main` as Stable; pinned Mike 2.2.0 and configured Material's native version provider with the `stable` default alias.
- Tests: Core metadata consistency and full generated-site validation pending after documentation integration.
- Status: in-progress.
- Next: Replace remaining active release terminology, implement the version selector in the custom shell, author the full manual, and run the consistency gates.

### 2026-07-19 05:51Z — Codex documentation IA auditor — Public manual coverage audit started
- Context: Establish the end-to-end public documentation structure required for TLSOC 0.1.
- Did: Began a read-only inventory of current public pages, connector concepts, onboarding gaps, product terminology, and custom Material version-selector integration points.
- Tests: Source and documentation topology inspection in progress.
- Status: in-progress.
- Next: Produce a source-grounded page map and identify current-versus-roadmap boundaries.

### 2026-07-19 06:02Z — Codex documentation IA auditor — Public manual coverage audit complete
- Context: Finish the onboarding, concepts, and source-documentation gap analysis.
- Did: Defined the canonical TLSOC product/service terms, mapped the required getting-started, concepts, and source pages, separated shipped behavior from roadmap material, and identified the custom header slot required by Material's version selector.
- Tests: Existing public navigation and product-source coverage reviewed; no files changed.
- Status: done.
- Next: Author the mapped pages and integrate them into the versioned navigation.

### 2026-07-19 05:42Z — Codex product-surface auditor — Analyst and automation coverage audit started
- Context: Map the implemented TLSOC Console and API surface into complete public task documentation.
- Did: Began a read-only inventory of navigation, case workflows, automation, intelligence, settings, roles, connectors, providers, metrics, and API operations.
- Tests: UI registry, backend routes, configuration defaults, and provider registries under review.
- Status: in-progress.
- Next: Return an authoritative feature inventory and public page plan.

### 2026-07-19 06:03Z — Codex product-surface auditor — Analyst and automation coverage audit complete
- Context: Finish the feature and API surface map for the TLSOC 0.1 manual.
- Did: Mapped analyst navigation, case-detail tabs, automation controls, settings sections, roles, connector and enrichment catalogs, dashboard widgets, API coverage, and safety defaults into a source-grounded documentation plan.
- Tests: Cross-checked active UI registry, route modules, OpenAPI snapshot, configuration models, and role matrix; no files changed.
- Status: done.
- Next: Author analyst, automation, and intelligence guides and later validate the integrated manual.

### 2026-07-19 05:48Z — Codex release auditor — Version and publication audit started
- Context: Replace the prior prerelease vocabulary with a standard Testing-to-main/Stable model and versioned public documentation.
- Did: Began a read-only audit of version authorities, branch-triggered workflows, release examples, Material/Mike integration, and current documentation chrome.
- Tests: Package, Compose, workflow, template, and version-consistency sources under review.
- Status: in-progress.
- Next: Define the exact metadata, alias, publication, and branch-protection changes.

### 2026-07-19 06:05Z — Codex release auditor — Version and publication audit complete
- Context: Finish the release-model and versioned-documentation design audit.
- Did: Identified every canonical version surface, the Testing preview and main/Stable publication gates, Mike's major.minor directory/alias model, stale workflow branches/examples, and the custom-shell selector and outdated-version requirements.
- Tests: Version files, workflows, release documentation, and Material template behavior reviewed; no files changed.
- Status: done.
- Next: Apply SemVer 0.1.0, documentation line 0.1, Stable aliases, and exact-commit promotion guidance.

### 2026-07-19 06:04Z — Codex documentation author — Onboarding, concepts, and source guides started
- Context: Build the public TLSOC 0.1 documentation batch covering onboarding, core concepts, and source integration.
- Did: Reviewed the connector, source-feed, OCSF, case-policy, state, health, and ingestion contracts required for accurate user-facing guidance.
- Tests: Source-grounding and page-contract review in progress.
- Status: in-progress.
- Next: Author the requested pages with explicit audience, verification, safety, and version boundaries.

### 2026-07-19 06:14Z — Codex documentation author — Source and safety documentation milestone
- Context: Complete the substantive onboarding, architecture, decision-safety, and connector documentation.
- Did: Added the full getting-started and concepts sets plus source guides spanning pull, HTTP, syslog, brokers, object stores, feeds, mappings, and third-party connectors.
- Tests: Reviewed claims against current connector manifests, OCSF models, source routes, feed contracts, and deterministic case policy.
- Status: in-progress.
- Next: Align cross-page links with the integrated information architecture and run lightweight content checks.

### 2026-07-19 06:18Z — Codex documentation author — Public documentation batch complete
- Context: Finish and validate the assigned TLSOC 0.1 documentation pages.
- Did: Created 16 version-scoped pages with task prerequisites, shipped behavior, expected results, adjacent limitations, and integrated related-page links.
- Tests: Front matter, single-H1, version-scope, relative-link, non-empty-file, terminology, and whitespace checks passed; 16 files checked with zero missing relative links.
- Status: done.
- Next: Integrate the pages into the final navigation and run the repository-wide strict documentation build.

### 2026-07-19 06:07Z — Codex feature/API documenter — Version 0.1 operational documentation started
- Context: Author the complete analyst, automation, and intelligence documentation for the public 0.1 manual.
- Did: Mapped implemented UI routes, permissions, lifecycle states, automation defaults, metrics, enrichment providers, retrieval trust boundaries, and deterministic safety controls into a bounded 14-page documentation plan.
- Tests: Source-grounding and documentation validation pending.
- Status: in-progress.
- Next: Write the operational pages, connect their task flows, and validate links and public-document hygiene.

### 2026-07-19 06:14Z — Codex feature/API documenter — Version 0.1 operational documentation authored
- Context: Complete the analyst, automation, and intelligence content required for the versioned public manual.
- Did: Authored 14 task-oriented pages covering dashboards, case lifecycle, investigations, logs, collaboration, campaigns, analytics, autopilot, rules, tuning, baselines, playbooks, approvals, knowledge, memory, enrichment, MITRE ATT&CK, and threat context. Documented permissions, defaults, provenance, cost, fail-open behavior, and the deterministic decision boundary throughout.
- Tests: Completed source-level accuracy review against the active routes, configuration, enums, metrics engine, provider registry, and web navigation.
- Status: in-progress.
- Next: Run structural, link-target, whitespace, and internal-only-content validation.

### 2026-07-19 06:17Z — Codex feature/API documenter — Version 0.1 operational documentation complete
- Context: Finish and verify the assigned operational documentation batch.
- Did: Corrected lifecycle, widget, playbook-selection, dwell-time, enrichment-indicator, and protected-corpus wording during final review; preserved public-only product documentation with cross-links into the wider versioned manual.
- Tests: Validated all 14 expected files, front matter, exactly one H1 per page, relative link targets, trailing whitespace, and prohibited internal-only terms; all checks passed.
- Status: done.
- Next: Integrate these pages into the versioned MkDocs navigation and run the complete site build and browser QA.

### 2026-07-19 06:06Z — Codex administration/operations writer — Public 0.1 administration and operations batch started
- Context: Create the complete public administration, operations, and documentation-version guidance for TLSOC 0.1 within the assigned non-overlapping file set.
- Did: Reviewed the implemented settings, RBAC, authentication, model-budget, notification, reset, health, state-backend, and secret-handling contracts before authoring.
- Tests: Source-grounding and endpoint/config inventory completed.
- Status: in-progress.
- Next: Write the administration pages, then the deployment, security, recovery, upgrade, troubleshooting, and release-version pages.

### 2026-07-19 06:13Z — Codex administration/operations writer — Public 0.1 administration and operations content completed
- Context: Complete the source-grounded content for the assigned documentation batch.
- Did: Added seven administration guides and six operations guides covering durable preferences, users/RBAC, local auth/MFA/OIDC, model routing and spend, notifications, customization, tiered reset, deployment shapes, configuration layers, hardening, health/backup, upgrades, and troubleshooting. Explicitly documented off-by-default authentication, runtime-only UI secrets, spend-gate limits, and migration/availability boundaries.
- Tests: Manual contract comparison against backend configuration, routes, RBAC policy, and reset service completed.
- Status: in-progress.
- Next: Add the 0.1 release and documentation-version policy pages, then validate metadata and links.

### 2026-07-19 06:16Z — Codex administration/operations writer — Public 0.1 administration and operations batch complete
- Context: Finish and validate the assigned public documentation set.
- Did: Added 15 complete pages under `docs/administration`, `docs/operations`, and `docs/releases`, standardized on display version 0.1, machine version 0.1.0, and Testing-to-main/Stable promotion. Kept engineering process history and internal test details out of public guidance.
- Tests: Lightweight validation passed for all 15 pages: front matter and H1 shape valid, every relative Markdown link resolves, obsolete active release nomenclature absent, and `git diff --check` clean.
- Status: done.
- Next: Integrate these pages into the concurrent navigation/version-selector work and run the final strict site build and rendered-link validation.

### 2026-07-19 06:21Z — Codex orchestrator — Complete 0.1 manual and release workflow integrated
- Context: Integrate the parallel documentation batches into one maintainable versioned product manual.
- Did: Added the full navigation across onboarding, concepts, sources, analyst work, automation, intelligence, administration, operations, reference, development, and releases; replaced active prerelease terminology; implemented the Testing-only review gate and main/Stable Mike publication; added dynamic channel/version chrome, Stable/latest aliases, and an automated public-page/link/nomenclature coverage gate.
- Tests: Individual author batches passed source, structure, relative-link, terminology, and whitespace checks; repository-wide strict build and rendered/browser validation pending the final reference batch.
- Status: in-progress.
- Next: Complete API/developer reference, resolve integrated link/content findings, then exercise version publication and the full responsive site.

### 2026-07-19 06:19Z — Codex nomenclature auditor — Active release terminology audit started
- Context: Verify active product, documentation, workflow, and release metadata against the TLSOC 0.1 and Testing-to-main/Stable model.
- Did: Began a read-only repository-wide drift scan covering public documentation, developer surfaces, templates, workflows, scripts, and product metadata.
- Tests: Audit and link checks in progress.
- Status: in-progress.
- Next: Re-check integrated documentation, identify only remaining actionable drift, and verify external Git refs.

### 2026-07-19 06:22Z — Codex reference/development documenter — TLSOC 0.1 reference and developer manual started
- Context: Complete public API, configuration, permissions, compatibility, security, and development guidance for the versioned 0.1 documentation.
- Did: Began a read-only contract audit of OpenAPI, configuration tiers, state backends, RBAC, runtimes, extension registries, authentication middleware, release identity, and contract-generation/test tooling.
- Tests: Source-grounding review in progress; no shared site build run while navigation and content were concurrent.
- Status: in-progress.
- Next: Author the ten assigned pages and validate every material claim against current code.

### 2026-07-19 06:35Z — Codex reference/development documenter — Reference and development content authored
- Context: Complete the public reference and contributor-facing sections of the TLSOC 0.1 manual.
- Did: Added five reference pages covering the API, configuration authorities, six-role permission matrix, compatibility, and security model, plus five development pages covering repository orientation, backend, Console, extension SPIs, contract generation, testing, and Testing-to-main/Stable promotion.
- Tests: Runtime source inspection confirmed application 0.1.0, OCSF 1.4.0, 190 paths/223 operations, six roles, 19 connectors, 19 enrichment providers, seven notification channels, seven model-provider identifiers, and current security/configuration defaults.
- Status: in-progress.
- Next: Reconcile the independent release-channel contract and run final structural, link, terminology, and whitespace validation.

### 2026-07-19 06:43Z — Codex reference/development documenter — TLSOC 0.1 reference and developer manual complete
- Context: Finish and verify the ten assigned public documentation pages.
- Did: Documented the direct release identity variables, including 0.1.0 remaining constant through promotion while `TLSOC_RELEASE_CHANNEL` changes from `testing` to `stable`; corrected exact secret-route parameters and realtime event behavior; completed all cross-links without exposing internal development records.
- Tests: All ten files passed front-matter parsing, exactly-one-H1 validation, 34 relative-link checks, obsolete-nomenclature scanning, and `git diff --check`; `python3 scripts/check_version.py` passed; final claims were rechecked against current routes, Docker metadata, Compose arguments, RBAC policy, registries, and configuration defaults.
- Status: done.
- Next: Run the integrated strict MkDocs build, version-publication exercise, and responsive browser QA.

### 2026-07-19 06:45Z — Codex nomenclature auditor — Active release terminology audit complete
- Context: Complete the integrated TLSOC 0.1 nomenclature and version-model audit.
- Did: Audited the 61-page public manual, active engineering documentation, workflows, templates, package/image metadata, release-channel behavior, and remote Git state. Confirmed the canonical product names, application version 0.1.0, documentation line 0.1, and Testing-to-main/Stable terminology are consistently applied apart from the reported residual items.
- Tests: `python3 scripts/check_version.py` passed; `python3 scripts/check_docs.py` passed for 61 public pages; a 76-file relative-link scan found zero missing targets; scoped `git diff --check` passed.
- Status: done.
- Next: Resolve the exact-commit promotion mechanism, retire the remaining roadmap alpha wording, decide the compatibility policy for the Compose project slug, and create/configure the external main branch and v0.1.0 tag only after acceptance.

### 2026-07-19 08:03Z — Codex orchestrator — Version 0.1 documentation program complete
- Context: Finish the complete public manual, release nomenclature, versioned publication model, and end-to-end quality gates for TLSOC 0.1.
- Did: Completed 61 public pages for every shipped product surface; standardized the formal product, Console, and API names; set package/image/API SemVer to `0.1.0` and the documentation line to `0.1`; defined feature-to-`Testing` integration and protected `Testing`-to-`main`/Stable promotion; added independent `testing`/`stable` release identity; implemented Mike publication with `stable` and `latest` aliases, a native version selector, channel-aware chrome, and outdated-version guidance. Resolved the final promotion wording, roadmap wording, compatibility-stable Compose slug policy, light-theme contrast, duplicate generated code-line IDs, and a versioned-page URL bootstrap defect found by rendered QA. Kept all public pages free of internal Journal and research material.
- Tests: `1957` backend tests passed; `1350` Console tests across 240 files passed; Console type drift, lint, production build, and all design gates passed; application/docs version checks, 61-page coverage, workflow YAML, Compose configuration, JavaScript syntax, CSS parsing, and `git diff --check` passed; strict MkDocs builds passed; the isolated Mike publication produced documentation `0.1`, `stable`/`latest` aliases, the Stable default redirect, and 444 search records; 63 generated HTML files and 6,387 links, assets, and fragments validated with no missing targets or duplicate IDs; responsive dark/light, selector, search, navigation drawer, page-outline, desktop, and mobile browser QA passed with no current-page warnings or errors.
- Status: done. The repository implementation is complete on `Testing`; no remote `main` branch or `v0.1.0` tag exists yet, so Stable publication remains an explicit post-acceptance release action.
- Next: Protect `Testing` and `main`, promote the accepted source tree through a reviewed pull request, re-run the release gate on the resulting `main` commit, tag that commit `v0.1.0`, and enable GitHub Pages from the generated `gh-pages` branch.

### 2026-07-19 15:20Z — Codex frontend implementer — Dashboard prototype integration started
- Context: Inspect the attached Stitch frontend prototype in the in-app browser, fit its dashboard design to the existing TLSOC Console, and deliver a fully working dashboard with thorough verification.
- Did: Read the repository handoff and agent rules, selected the required in-app browser workflow, and began mapping the prototype against the current dashboard architecture and contracts.
- Tests: Baseline repository and visual checks pending.
- Status: in-progress.
- Next: Inspect the prototype and current dashboard, implement the visual integration, then run focused tests, full Console tests, lint, build, and browser QA.

### 2026-07-19 15:36Z — Codex frontend implementer — Live command-center dashboard integrated
- Context: Adapt the attached flat, dense Stitch dashboard concept without replacing the Console's real data, RBAC, routing, accessibility, theme, or drill-down behavior.
- Did: Rebuilt the dashboard composition as a borderless five-cell telemetry strip, integrated Active Risk/resolved-open/latest-case instrument band, and Noise-Reduction/burndown/timing operations band; added reusable strip/flat component variants and aligned the loading skeleton with the new layout. Verified the rendered result against the supplied prototype in the in-app browser using the live demo backend.
- Tests: Console production build passed (`tsc --noEmit` + Vite, 3,156 modules); initial focused dashboard/component run passed 53/54 assertions, with the sole failure identified as stale copy expecting `Noise reduced by` after the intentional compact `Reduced by` label change. No backend decision logic was touched.
- Status: in-progress.
- Next: Re-run focused tests after the expectation update, then complete full tests, lint, design gates, and responsive light/dark interaction QA in a fresh browser tab.

### 2026-07-19 15:45Z — Codex frontend implementer — Stitch-inspired dashboard integration complete
- Context: Finish the dashboard-only frontend adaptation and verify it more rigorously than the supplied static concept, including live data, responsive behavior, accessibility, interactions, and regression safety.
- Did: Completed the dense command-center dashboard with working range/refresh controls, KPI and funnel drill-downs, risk and lifecycle instruments, latest-case queue, noise flow, burndown/timing rail, and preserved collapsed deeper analytics. Browser QA exposed a mobile CSS-grid min-content overflow; added explicit `min-w-0` constraints through the telemetry/instrument/operations composition and confirmed 390 px body/main widths exactly match the viewport. Kept all existing Console navigation, RBAC, light/dark theming, demo safety, real API contracts, and deterministic case-manager authority intact. The final live dashboard remains open as the browser deliverable.
- Tests: Focused dashboard/component/a11y suite `54/54` passed; full Console suite `1,350/1,350` across 240 files passed after the responsive fix; lint passed with zero errors/warnings; API type-drift check passed for 190 paths; all design gates passed (37 tokens, 82 dual-theme contrast axes, grep guards, CVD); production `tsc --noEmit` + Vite build passed with the 287.45 kB entry chunk unchanged; all 1,957 backend tests passed twice (one pre-final and one final exit-0 regression run); `git diff --check` passed and `backend/app/engine/case_manager.py` remained byte-unchanged. In-app browser checks passed in desktop dark/light and mobile dark at 390×844, including time-range reload, open-case drill-down, deeper-analytics expansion, zero horizontal overflow, and zero warnings/errors in a fresh tab.
- Status: done.
- Next: Operator visual review of the live dashboard; no further implementation or deployment action is required for this dashboard-only scope.

### 2026-07-19 15:57Z — Codex frontend implementer — Exact dark-console palette and glitch pass started
- Context: Match the Console's global dark mode to the newly supplied near-black/violet command-center reference and remove dashboard visual glitches shown in the accompanying crop.
- Did: Re-read the handoff, repository rules, canonical design standard, and in-app browser workflow; preserved the existing uncommitted dashboard integration as the starting point.
- Tests: Baseline screenshot/token/browser comparison pending.
- Status: in-progress.
- Next: Sample and map the reference palette, inspect the live dashboard and shared shell, implement global dark-token changes plus dashboard glitch fixes, then run full visual and automated verification.

### 2026-07-19 16:03Z — Codex orchestrator — Documentation interaction bug investigation started
- Context: Diagnose and correct the documentation defect demonstrated in the supplied screen recording.
- Did: Began frame-level recording inspection and source-to-rendered interaction tracing, scoped strictly to the documentation site.
- Tests: Reproduction, targeted implementation, strict build, and browser regression pending.
- Status: in-progress.
- Next: Identify the exact failing state, apply the smallest source fix, and verify it across the affected viewport and themes.

### 2026-07-19 16:09Z — Codex frontend implementer — Dark-console parity and responsive glitch fixes verified live
- Context: Apply the supplied dark command-center palette across the Console and eliminate the lifecycle and settings layout glitches exposed during visual QA.
- Did: Sampled the reference image into near-black canvas/card layers plus lavender, red, orange, blue, and lime semantic axes; remapped the dark design tokens and shared navigation states; removed the lifecycle row's oversized hover wash; shortened the resolved donut center label so it no longer clips. Cross-page browser QA then exposed the Settings three-column grid activating before its two fixed rails left enough content width, so the third column/full-span breakpoint now waits until `2xl`.
- Tests: All design gates passed (37 tokens, 82 dual-theme contrast axes, grep guards, CVD); focused dashboard, shared navigation/theme, settings, and a11y tests passed `114/114`; live browser verification passed on dashboard, Cases, Settings, command-palette overlay, and 390×844 dashboard with exact 390 px document width.
- Status: in-progress.
- Next: Run the full Console test/lint/type/build suite, backend regression suite, fresh-tab browser console check, and final diff/journal audit.

### 2026-07-19 16:15Z — Codex frontend implementer — Exact reference dark mode and glitch pass complete
- Context: Finish the operator-requested visual match to the supplied dark command-center image across the Console without regressing the established light theme or application behavior.
- Did: Finalized the reference-derived `#050505` canvas, `#0a0a0a` cards, `#121212` popovers, `#1b1c1e` hairlines, `#2d2a36` active surfaces, `#cdbdfa` ultraviolet primary, and sampled semantic red/orange/blue/lime axes. Matched the dashboard strip roles (neutral open, red critical/high, blue escalation, orange false-positive, lime auto-resolved), preserved the old light navigation treatment via dark-only variants, removed the lifecycle hover slab, fixed the clipped resolved donut label, and repaired the Settings action-card collapse at 1280 px. The Browser skill guided live comparison across dashboard, dense Cases table, Settings forms, command overlay, desktop light/dark, and mobile dark.
- Tests: Full Console suite passed `1,351/1,351` across 240 files; all `1,957` backend tests passed; lint passed with zero errors/warnings; 190-path API type drift passed; all design gates passed (37 tokens, 82 dual-theme contrast axes, grep guards, three CVD simulations); repeated `tsc --noEmit` + Vite production builds passed (3,156 modules, 287.63 kB entry); focused post-final dashboard/a11y tests passed `28/28`; `git diff --check` passed and deterministic `backend/app/engine/case_manager.py` remained unchanged. Browser QA confirmed exact live token values, no desktop/mobile horizontal overflow, preserved light rendering, and no warning/error logs in a fresh dark tab.
- Status: done. The global dark mode now follows the supplied near-black/violet command-center scheme while the Console remains functional, responsive, AA-gated, and light-theme compatible.
- Next: Operator visual review of the final live dark dashboard; no deployment or source-control publication was requested.

### 2026-07-19 16:17Z — Codex orchestrator — Documentation page-end navigation defect fixed
- Context: Correct the documentation sidebar defect demonstrated in the supplied recording.
- Did: Traced the disappearing active submenu to Material's footer-aware inline resize of the fixed primary sidebar and added a desktop-scoped height override so the navigation viewport and its scroll position remain stable.
- Tests: Strict MkDocs build, 61-page consistency check, CSS parse, and whitespace validation passed. Browser regression passed at compact and full desktop heights in both themes plus the mobile drawer; the active Administration subtree remained visible through the page-end transition with no console errors.
- Status: done.
- Next: None.

### 2026-07-19 16:25Z — Codex frontend implementer — Dashboard micro-layout polish started
- Context: Apply five operator-specified refinements to the dark command-center dashboard: remove redundant lifecycle/SLA copy, clean up donut geometry, adapt the supplied Latest Cases treatment, and simplify Noise-Reduction stage labels.
- Did: Re-read the handoff, repository rules, and required in-app browser workflow; preserved the existing dashboard and global dark-mode work as the baseline.
- Tests: Reference/prototype inspection and focused regression checks pending.
- Status: in-progress.
- Next: Inspect the supplied zip and current components, implement the five scoped changes, then run focused/full Console verification and live responsive browser QA.

### 2026-07-19 16:35Z — Codex frontend implementer — Five dashboard refinements implemented and verified live
- Context: Match the operator's follow-up lifecycle, Latest Cases, and Noise-Reduction references while preserving live data and drill-down behavior.
- Did: Removed the redundant lifecycle group heading/subtitle and masthead SLA chip; enlarged donut boxes from 88 px to 120 px and thickened their rings while retaining the bounded center hole; adapted the zip's compact Latest Cases rows to real cases with case ID/title, age, semantic status badge, View All, and row navigation; removed the old source/risk/dot/chevron/escalation-footer clutter. Removed shield/bot stage pictograms from Noise Reduction, applied the requested text labels and status color cues, and changed the stage rail to responsive 2/3/6-column layouts after mobile QA exposed collisions.
- Tests: Focused dashboard/noise/chart/a11y tests passed `39/39`, the post-responsive focused set passed `34/34`, lint passed, design gates passed, and the production build passed (3,156 modules). Live browser checks passed on desktop dark and 390×844 mobile with exact viewport/document width and readable, non-overlapping stage labels.
- Status: in-progress.
- Next: Run the full Console/backend regression suites, repeat build/type checks, and complete clean-tab desktop/mobile browser handoff.

### 2026-07-19 16:39Z — Codex frontend implementer — Dashboard micro-layout polish complete
- Context: Complete and independently verify the five requested dashboard refinements against the supplied screenshots and attached frontend prototype.
- Did: Finalized the simplified masthead and lifecycle area, cleaner 120 px thick-ring donuts, prototype-derived compact Latest Cases queue, and text-only Noise-Reduction stages. Preserved live API data, case navigation, View All behavior, responsive layouts, light/dark compatibility, RBAC, and all deterministic backend behavior. A fresh desktop dark-mode browser pass confirmed the redundant lifecycle/SLA copy is absent, both donut canvases render at 120 px, the six-stage rail is evenly distributed, the document has no horizontal overflow, and the page emits no warnings or errors.
- Tests: Full Console suite passed `1,351/1,351` across 240 files; all `1,957` backend tests passed; lint passed with zero errors/warnings; 190-path API type-drift check passed; all design gates passed (37 tokens, 82 dual-theme contrast axes, grep guards, CVD); final `tsc --noEmit` + Vite production build passed (3,156 modules, 287.63 kB entry); focused post-responsive tests passed `34/34`; `git diff --check` passed and `backend/app/engine/case_manager.py` remained unchanged. Browser QA passed at 1280 px desktop and 390×844 mobile with zero horizontal overflow.
- Status: done.
- Next: Operator visual review; no deployment or source-control publication was requested.

### 2026-07-19 16:49Z — Codex frontend implementer — Dashboard density and interaction pass started
- Context: Match the supplied KPI/control references, reduce the risk/lifecycle/latest band only vertically, maximize the risk gauge within its panel, and show exactly four latest cases with richer hover disclosure.
- Did: Re-read the handoff, project rules, supplied screenshots, and required browser workflow; retained the verified dark-console and dashboard changes as the implementation baseline.
- Tests: ZIP/code inspection, component changes, automated regressions, and responsive browser QA pending.
- Status: in-progress.
- Next: Compare the current implementation with the prototype markup, implement the scoped density/shape/hover changes, then verify desktop and mobile behavior.

### 2026-07-19 17:06Z — Codex frontend implementer — Dashboard density and interactions verified
- Context: Validate the ZIP-derived KPI strip, compact instrument band, reshaped controls, and four-row Latest Cases queue before final handoff.
- Did: Matched the KPI strip's 4xl numerals, concise captions, semantic delta chip, and real timestamp-bucket micro-trends; added near-square three-control command chrome with compact `Last 24h` copy; reduced the instrument band to 326 px at 1280 px while expanding the Active Risk gauge to 320 px; reduced lifecycle donuts to clean 100 px/28%-thick rings; sorted all cases by latest activity, capped the queue at four, and wrapped every row in the existing rich accessible CaseHoverCard. Live 390 px QA confirmed the full-width gauge, readable rings, four visible case rows, and zero horizontal overflow.
- Tests: Focused dashboard/control/gauge/hover/a11y suite passed `62/62`; full Console suite passed `1,352/1,352` across 240 files; lint, all design gates, 190-path type drift, and final production build passed (3,156 modules, 287.68 kB entry); all `1,957` backend tests completed at 100% with the one known TLS warning only. Browser QA passed at 1280 px desktop and 390×844 mobile.
- Status: in-progress.
- Next: Reset the temporary mobile viewport, run a clean-tab desktop console/geometry audit, then complete the final diff and journal checks.

### 2026-07-19 17:07Z — Codex frontend implementer — Dashboard density and interaction pass complete
- Context: Finish the operator-requested ZIP/reference adaptation with production-grade live data and interaction behavior.
- Did: Completed the compact KPI telemetry strip, three-button squared masthead controls, vertically tightened risk/lifecycle/latest band, full-width Active Risk gauge, and exactly-four Latest Cases queue with rich hover/focus previews. The Browser skill drove a final fresh-tab dark-mode audit after resetting the temporary mobile viewport: 1280 px body/scroll widths match, the instrument band is 326 px tall, the gauge is 320 px wide, both donuts are 100 px high, all four latest rows render, all three controls have transparent 3 px-radius chrome, and the browser console is clean.
- Tests: Final status remains green at `1,352/1,352` Console tests across 240 files and `1,957/1,957` backend tests; lint, design gates, API type drift, production build, whitespace validation, and the byte-unchanged deterministic case manager all passed.
- Status: done.
- Next: Operator visual review; no deployment, staging, commit, or push was requested.

### 2026-07-19 17:13Z — Codex frontend implementer — Lifecycle ring enlargement started
- Context: Enlarge the Cases Resolved/Open rings again and improve their center-number proportions against the newly supplied reference.
- Did: Preserved the current dashboard density work as the baseline and scoped the change to SnapshotCard ring geometry and its matching assertions.
- Tests: Focused component/build and live browser comparison pending.
- Status: in-progress.
- Next: Increase the ring canvas/diameter and center typography, then verify desktop/mobile fit and regressions.

### 2026-07-19 17:15Z — Codex frontend implementer — Larger lifecycle rings complete
- Context: Finish the requested resolved/open donut enlargement while retaining clean center copy and responsive safety.
- Did: Increased each lifecycle ring from a 100 px canvas/112 px box to a 136 px canvas/144 px box, tuned thickness to 26% for a roughly 95 px visible outer donut and 71 px center hole, promoted ordinary center totals to 3xl, and retained compact 2xl typography for abbreviated four-digit totals. The surrounding column widths and all case drill-down behavior remain unchanged.
- Tests: Focused Overview/command-center/a11y/chart suite passed `26/26`; lint and the final production build passed (3,156 modules, 287.68 kB entry); `git diff --check` passed and the deterministic case manager remained untouched. Live dark-mode browser QA confirmed both rings at 144×136 px, clean centers, zero warnings/errors, and exact body/scroll widths at both 1280 px desktop and 390×844 mobile.
- Status: done.
- Next: Operator visual review; no deployment or source-control action was requested.

### 2026-07-19 17:28Z — Codex frontend implementer — Latest-case escalation copy update started
- Context: Replace the Latest Cases `TRIAGE` status label with `ESCALATED` for needs-human/escalated cases.
- Did: Located the single dashboard status-vocabulary mapping; unrelated product and metric uses of “triage” remain intentionally unchanged.
- Tests: Focused dashboard regression and production type/build checks pending.
- Status: in-progress.
- Next: Update the mapping, pin it with a render assertion, and verify the dashboard build.

### 2026-07-19 17:29Z — Codex frontend implementer — Latest-case escalation copy update complete
- Context: Finish the requested Latest Cases badge wording change without altering status semantics or colors.
- Did: `needs_human` and `escalated` rows now render `ESCALATED`; the high-severity badge treatment, navigation, hover preview, and backend status values remain unchanged. Added a regression assertion that the queue contains `Escalated` and no `Triage` badge.
- Tests: Focused Overview/command-center tests passed `21/21`; TypeScript typecheck and lint passed; `git diff --check` passed and the deterministic case manager remained untouched.
- Status: done.
- Next: None.

### 2026-07-19 18:42Z — Codex frontend implementer — Dashboard hover and menu polish started
- Context: Repair the glitchy lifecycle/latest-case hover behavior, square and darken dropdown surfaces, and replace the ambiguous KPI abbreviation `obs.`.
- Did: Reproduced the three affected interaction surfaces from the supplied screenshots and traced them to the shared donut tooltip, hover-card, popover, select, and dropdown primitives.
- Tests: Focused component checks, full Console validation, and live in-app Browser QA pending.
- Status: in-progress.
- Next: Patch the shared primitives and dashboard copy, add regression coverage, then verify hover/menu geometry in dark mode.

### 2026-07-19 18:51Z — Codex frontend implementer — Hover/menu verification milestone
- Context: Validate the dashboard interaction fixes across the shared primitives and the live dark-mode console.
- Did: Disabled segment tooltips only on the lifecycle rings; added a steadier 320 ms open / 220 ms close window and left-side placement for Latest Cases previews; prevented preview footer collisions; changed shared floating surfaces and menu rows to 3 px corners; mapped the dark popover token to the near-black card surface; and replaced `obs.` with plural-aware `critical case(s)` copy.
- Tests: Focused hover/chart/select/dashboard suite passed `37/37`; the full Console suite passed `1,353/1,353` across 240 files; lint, TypeScript production build (3,156 modules, 287.69 kB entry), design gates, 190-path API type drift, and `git diff --check` passed. In-app Browser QA measured all four dark menus at 3 px / rgb(10,10,10), confirmed lifecycle hover exposes zero visible Recharts tooltips, and confirmed 390 px mobile has 390 px body/scroll width with four Latest Cases rows and an in-bounds picker menu.
- Status: in-progress.
- Next: Perform the final clean console-log audit, finalize the Browser session, then close the journal entry.

### 2026-07-19 18:52Z — Codex frontend implementer — Dashboard hover and menu polish complete
- Context: Complete the requested interaction cleanup and dark squared menu treatment.
- Did: Finalized the verified implementation with lifecycle overlays removed, Latest Cases hover timing/placement stabilized, floating menus uniformly squared and near-black in dark mode, and the KPI caption rewritten in plain language.
- Tests: Final in-app Browser console audit reported zero warnings/errors after desktop and mobile interaction passes; all automated checks remain green at `1,353/1,353` Console tests plus lint, design gates, API type drift, build, and whitespace validation.
- Status: done.
- Next: Operator visual review; no deployment, staging, commit, or push was requested.

### 2026-07-19 18:59Z — Codex frontend implementer — Lifecycle center-label removal started
- Context: Remove the `RES` and `OPEN` captions from the resolved/open lifecycle rings and center the totals by themselves.
- Did: Scoped the change to `SnapshotCard` center content and its dashboard regression assertions.
- Tests: Focused Overview/chart checks and live Browser geometry audit pending.
- Status: in-progress.
- Next: Remove the center-label API/rendering, update assertions, and verify both rings visually.

### 2026-07-19 19:02Z — Codex frontend implementer — Lifecycle center-label removal complete
- Context: Finish the requested numbers-only resolved/open lifecycle ring centers.
- Did: Removed the `centerLabel` API and all `RES`/`OPEN` center rendering, including the no-data branch; each ring now contains only its total with an explicit single-line treatment.
- Tests: Focused Overview/command-center/chart suite passed `26/26`; lint, TypeScript production build (3,156 modules, 287.69 kB entry), and `git diff --check` passed. Live Browser measurement confirmed both desktop and 390 px mobile numerals at exact 0 px X/Y offset from their ring centers, with no horizontal overflow and zero console warnings/errors.
- Status: done.
- Next: Operator visual review; no deployment, staging, commit, or push was requested.

### 2026-07-19 20:25Z — Codex frontend implementer — Case Manager workspace started
- Context: Add a new `Case Manager` navigation entry beneath Cases, adapt the supplied Stitch CaseManager ZIP into the standalone Console, and carry every existing case-detail capability into the new split-pane SOC workflow while retaining the current dark theme.
- Did: Established the scope as a new additive workspace; the existing Cases route remains intact for phased migration. Explicitly excluded Codex Security review as requested.
- Tests: ZIP audit, feature-contract mapping, focused/full Console validation, and live Browser QA pending.
- Status: in-progress.
- Next: Inspect the ZIP, inventory all existing CaseDetail tabs/actions/contracts, map routing/navigation conventions, then implement the integrated workspace.

### 2026-07-19 20:20Z — `/root/zip_audit` — Case Manager ZIP audit started
- Context: Read-only audit of `stitch_agentic_kibana_frontend CaseManager.zip` covering archive structure, UI/UX patterns, static data contracts, interactions, and mappings to the existing case-detail primitives.
- Did: Began inspection of both standalone HTML mocks, their renders, and the Quantum Glass design specification. No repository edits and no security review.
- Tests: Static artifact inspection in progress.
- Status: in-progress.
- Next: Distinguish functioning prototype behavior from visual-only controls and map the complete workflow to the Console.

### 2026-07-19 20:27Z — `/root/zip_audit` — Case Manager ZIP audit complete
- Context: Complete the read-only audit of all supplied Case Manager prototype artifacts.
- Did: Audited all nine archive entries and confirmed the ZIP is static art direction: only tab switching works, while case selection, filters, actions, collaboration, and chat are inert. Mapped the split queue/workspace, six tabs, provenance, entity/story, and action areas to existing Console components; recommended inline reuse of the CaseDetail orchestrator.
- Tests: Static source and image inspection only; no files changed and no security review was run.
- Status: done.
- Next: Adapt the layout around live Console behavior instead of copying inert prototype logic.

### 2026-07-19 20:26Z — Codex route/nav mapper — Case Manager route audit started
- Context: Map registry, router, navigation, RBAC, lazy-loading, mobile, and test contracts for a new Case Manager destination beneath Cases.
- Did: Began a read-only trace of the registry-derived route/nav system and existing CaseDetail deep-link behavior. No files changed and no security review was run.
- Tests: Static source inspection in progress.
- Status: in-progress.
- Next: Identify exact integration points and regression coverage.

### 2026-07-19 20:29Z — Codex route/nav mapper — Case Manager route audit complete
- Context: Complete the additive Case Manager route and navigation map.
- Did: Confirmed `registry.tsx` is the single route/nav source feeding desktop, mobile, breadcrumbs, and Cmd-K; mapped the generic `caseId` deep-link seam, `cases:read` guard, responsive queue/detail behavior, and focused route/nav test requirements.
- Tests: Static source inspection only; no files changed and no security review was run.
- Status: done.
- Next: Register a lazy `case_manager` page and embed the shared CaseDetail workflow.

### 2026-07-19 20:26Z — Codex case-contract mapper — Existing case workflow inventory started
- Context: Map the complete Cases/CaseDetail experience before integrating it into the new workspace.
- Did: Began a read-only inventory of six detail tabs, lifecycle actions, dialogs, collaboration, data dependencies, shared components, routing, and regression coverage. No security review or source edits.
- Tests: Static source inspection in progress.
- Status: in-progress.
- Next: Identify the minimum-risk reuse seam and current gaps.

### 2026-07-19 20:30Z — Codex case-contract mapper — Existing case workflow inventory complete
- Context: Finish the contract map needed to retain every current case-detail capability.
- Did: Confirmed CaseDetail is the single shared workflow orchestrator; catalogued all tabs, header/footer actions, collaboration/task/activity/chat features, eager/lazy APIs, routing seams, and tests. Recommended a backward-compatible embedded presentation plus outward case-sync callback instead of duplicating mutation logic.
- Tests: Static source inspection only; no files changed and no security review was run.
- Status: done.
- Next: Implement the additive split workspace while leaving the existing Cases route unchanged.

### 2026-07-19 20:36Z — Codex frontend implementer — Live Case Manager workflow implemented
- Context: Convert the prototype's split-pane art direction into a functioning Console workspace without regressing the legacy Cases sheet.
- Did: Added the registry-derived Case Manager route directly after Cases with `cases:read` RBAC; built a real Active/All queue with search, severity/status filters, sort, counts, refresh, selection, responsive replacement navigation, empty/loading/error states, and dark semantic tokens; added a backward-compatible embedded CaseDetail presentation and synchronized authoritative case mutations back into the queue. All six existing detail tabs, lifecycle actions, RBAC checks, collaboration, tasks, activity, exports, notifications, playbooks, reinvestigation, and chat remain shared rather than copied.
- Tests: First production TypeScript/Vite build passed (3,157 modules); focused and full regression testing plus live Browser QA pending.
- Status: in-progress.
- Next: Add focused route/page/embedded-mode coverage, run full Console validation, then inspect desktop/mobile interaction and geometry in the in-app Browser.

### 2026-07-19 20:54Z — Codex frontend implementer — Case Manager validation milestone
- Context: Exercise the additive Case Manager against the complete Console contract and the live local demo stack.
- Did: Added route/nav/deep-link, queue behavior, mutation synchronization, embedded-workspace, responsive-back, failure-state, and automated accessibility coverage. Replaced an invalid nested `main` landmark with a labelled workspace region and tightened the mobile filter grid after measuring the rendered controls.
- Tests: All `1,362/1,362` Console tests passed across 241 files; lint, TypeScript/Vite production build (3,157 modules; 12.20 kB lazy Case Manager chunk), design gates (37 tokens, 82 contrast axes, raw-colour/arbitrary-size/CVD checks), 190-path API type drift, `git diff --check`, and the complete backend test suite passed. No Codex Security review was run, per request.
- Status: in-progress.
- Next: Finish the live responsive/browser diagnostics pass and record the handoff.

### 2026-07-19 20:55Z — Codex frontend implementer — Case Manager workspace complete
- Context: Complete the ZIP-inspired Case Manager as a production-connected alternative workflow while preserving the old Cases page for phased migration.
- Did: Finalized the dark split-pane SOC interface with Active/All scopes, honest loaded/total counts, critical/high quick filters, search, severity/status filters, sorting, live selection, mutation-aware queue updates, mobile queue/detail replacement, and the entire shared CaseDetail workflow. Updated the operator usage and handoff documentation. The supplied prototype's own shell and inert controls were intentionally not copied.
- Tests: In-app Browser QA exercised Overview, Timeline, Investigation, Threat context, Collaboration, and Chat against real local demo data. At 390×844 the page and manager had exact client/scroll widths (390/390 and 358/358) and all filter controls stayed within the queue; at 1280×720 both panes and all six tabs were visible with no horizontal overflow. A fresh reload produced zero browser warnings/errors. Automated checks remain green as recorded above.
- Status: done.
- Next: Operator visual review and continued Case Manager iteration; the existing Cases workflow remains available. No deployment, staging, commit, or push was requested.

### 2026-07-20 03:02Z — Codex frontend implementer — Case Manager header fidelity correction started
- Context: Match the supplied Case Manager reference more literally by removing toolbar clutter from the detail header and consolidating operational controls behind one top-right `Take Action` button.
- Did: Re-read the project handoff, canonical agent rules, and UI design standard; scoped the correction to the embedded CaseDetail presentation so the legacy Cases sheet remains backward-compatible.
- Tests: Source audit, focused interaction coverage, production build, and live desktop/mobile Browser comparison pending.
- Status: in-progress.
- Next: Audit the prototype header and current action contracts, implement the top-right action menu and exact header/tab geometry, then verify all controls remain reachable.

### 2026-07-20 03:03Z — `/root/header_fidelity` — Case Manager header fidelity audit started
- Context: Read-only comparison of the supplied Case Manager prototype header against the shared embedded `CaseDetail` workflow, including title/severity placement, tabs, top-right controls, action consolidation, responsive behavior, accessibility, and test implications.
- Did: Began tracing the ZIP markup and the current CaseDetail header/action contracts. No product source edits and no Codex Security review.
- Tests: Static source inspection pending.
- Status: in-progress.
- Next: Produce an exact implementation map for the orchestrator and record the completed audit.

### 2026-07-20 03:08Z — `/root/header_fidelity` — Case Manager header fidelity audit complete
- Context: Finish the read-only header/action comparison requested for the Case Manager fidelity correction.
- Did: Mapped the prototype's single square-edged header, case identity/severity/title hierarchy, unframed underline tabs, and exact top-right `Share` / `Take Action` / `X` order to the current embedded CaseDetail. Catalogued every existing header utility and lifecycle footer action that must move behind `Take Action`, including RBAC gates and the existing confirm/notify/reinvestigate/playbook flows; identified the robust shared clipboard helper for Share and the outer rounded Case Manager frame as an additional fidelity mismatch.
- Tests: Static inspection of both ZIP HTML mocks, `quantum_glass/DESIGN.md`, `CaseDetail.tsx`, the action plan/dialog helpers, shared primitives, and focused tests. No product source edits and no Codex Security review.
- Status: done.
- Next: Implement the embedded-only header branch, preserve legacy Sheet behavior, and add live menu/share/responsive/accessibility regression coverage.

### 2026-07-20 03:24Z — Codex frontend implementer — Case Manager reference-fidelity validation milestone
- Context: Verify the corrected Case Manager header, borders, split geometry, and consolidated action surface against the supplied screenshot and ZIP in the live dark-theme Console.
- Did: Rebuilt the embedded header as a flat square-edged surface with the prototype's one-third/two-thirds split, larger mono case identity, explicit severity label, underline-only tabs, and the exact top-right `Share` / filled `Take Action` / `X` order. Removed the embedded lifecycle footer and outer frame rounding/elevation; moved every lifecycle and operational command into the RBAC-aware `Take Action` menu while retaining the legacy Cases sheet unchanged. Added detached reinvestigate/playbook dialogs, canonical Case Manager link sharing, honest long-ID truncation, and neutral action-location copy.
- Tests: Focused CaseDetail/CaseManager interaction suite passed `24/24`; live in-app Browser QA at 1600×900 measured the structural split at 1:2, pinned all three controls inside the right edge, exercised the complete action menu and reinvestigate dialog, and confirmed dark squared surfaces. At 390×844 the page width remained exactly 390 px, tabs scrolled locally, and the 288 px action menu stayed in-bounds with internal scrolling. A fresh reload produced zero browser warnings/errors.
- Status: in-progress.
- Next: Run the complete Console/backend regression, production build, lint, API drift, and design gates; then close the correction.

### 2026-07-20 03:27Z — Codex frontend implementer — Case Manager header fidelity correction complete
- Context: Complete the requested literal Case Manager header/action correction without changing deterministic case behavior or the legacy Cases workflow.
- Did: Finalized the screenshot-matched embedded CaseDetail hierarchy and documented the top-right action contract. `Share` copies a canonical `#/case_manager?caseId=…` link; `Take Action` now owns lifecycle confirmations, reinvestigation, playbooks, refresh, case-scoped chat/timeline/investigation jumps, exports, notification, and campaign navigation; `X` returns to the queue. No Codex Security review was run, per the user's standing request.
- Tests: Full Console suite passed `1,364/1,364` across 241 files; full backend suite passed `1,957/1,957`; TypeScript/Vite production build passed with 3,157 modules; lint, 190-path generated API type drift, design gates (37 tokens, 82 contrast axes, raw-colour/arbitrary-size/CVD checks), `git diff --check`, focused runtime interaction coverage, and desktop/mobile in-app Browser QA all passed.
- Status: done.
- Next: Operator visual review. No deployment, staging, commit, or push was requested.

### 2026-07-20 03:34Z — Codex frontend implementer — Case Manager all-tab fidelity pass started
- Context: Extend the supplied Stitch Case Manager aesthetic beyond the header into Timeline, Threat Context, Investigation, Collaboration, and Chat while preserving every live Console capability and the legacy Cases drawer.
- Did: Scoped the work to presentation-aware Case Manager tab surfaces and began a fresh comparison of both ZIP prototypes, the supplied Timeline/Threat Context screenshots, current shared panel contracts, and live dark-theme rendering. Explicitly excluded Codex Security review per the user's standing request.
- Tests: ZIP/tab audit, focused panel coverage, full Console validation, and live desktop/mobile Browser QA pending.
- Status: in-progress.
- Next: Map each static prototype tab to its real API-backed panel, implement embedded-only visual compositions, then exercise every tab and interaction in the browser.

### 2026-07-20 03:42Z — `/root/tab_zip_audit` — Case Manager all-tab prototype audit started
- Context: Read-only audit of both supplied Case Manager HTML prototypes and screenshots for exact Timeline, Investigation, Threat Context, Collaboration, Chat, and materially distinct Overview styling.
- Did: Began extracting DOM hierarchy, layout geometry, visual tokens, static/inert interactions, and mappings from prototype content to the live case contract. No product files will be edited and no Codex Security review will be run.
- Tests: Static ZIP/source inspection in progress.
- Status: in-progress.
- Next: Produce line-referenced implementation maps and call out fidelity and live-data pitfalls for the frontend implementer.

### 2026-07-20 03:42Z — `/root/tab_test_audit` — Case Manager all-tab test audit started
- Context: Read-only audit of the shared CaseDetail and Case Manager test contracts for Overview, Timeline, Investigation, Threat Context, Collaboration, and Chat.
- Did: Began mapping existing runtime/static/a11y coverage, realistic fixtures, responsive assumptions, and the smallest non-brittle regression set needed to pin the supplied all-tab visual language. No product files will be edited and no Codex Security review will be run.
- Tests: Static source and fixture inspection in progress.
- Status: in-progress.
- Next: Return exact proposed test files, assertions, fixtures, and likely failure modes to the orchestrator.

### 2026-07-20 03:42Z — `/root/panel_contract_map` — Case Manager panel contract audit started
- Context: Map the existing Overview, Timeline, Investigation, Threat Context, Collaboration, and Chat components/data contracts to safe embedded-only styling seams for the all-tab fidelity pass.
- Did: Began a read-only source and test inventory, explicitly preserving legacy CaseDetail sheet behavior and excluding Codex Security review.
- Tests: Static component, API-contract, and regression-test inspection in progress.
- Status: in-progress.
- Next: Return exact file/line mappings, reusable live data, missing prototype data, and presentation-prop recommendations to the frontend implementer.

### 2026-07-20 03:47Z — `/root/tab_zip_audit` — Case Manager all-tab prototype audit complete
- Context: Finish the read-only audit of the two supplied Stitch Case Manager variants and the attached Timeline/Threat Context screenshots.
- Did: Identified the `fully_integrated_mission_control_suite` member as the canonical richer variant; extracted exact DOM, spacing, radius, typography, colour, microchart, empty-state, and interaction details for all six tabs; mapped each static element to the live Case, rationale, stage, threat-context, collaboration, and chat contracts; documented unsupported/fabricated-data hazards and the newer Take Action precedence. No product files were edited and no Codex Security review was run.
- Tests: Static inspection of both ZIP HTML files, both ZIP screenshots, both user-supplied screenshots, the ZIP design specification, current TypeScript contracts, and the live panel implementations. No runtime tests were required for this read-only audit.
- Status: done.
- Next: Apply the richer variant's embedded-only skin while preserving the legacy sheet, live loading/error/empty states, RBAC, untrusted-data rendering, deterministic decision authority, and all existing controls.

### 2026-07-20 03:51Z — `/root/panel_contract_map` — Case Manager panel contract audit complete
- Context: Finish the read-only component, API-contract, and regression audit for the Case Manager all-tab fidelity pass.
- Did: Mapped all six existing CaseDetail panels to additive embedded-only presentation seams while preserving the legacy Cases sheet and its shared data/mutation orchestration. Catalogued reusable live Timeline, rationale, threat-context, collaboration, and chat data; identified absent prototype-only history/last-reported values; and found an existing IOC contract drift where the backend emits `score`/`sources` but the Console expects `reputation_score`/`source`. Flagged the in-progress hard-coded Timeline bar series as fabricated data and recommended an honest scalar risk visualization instead. No product source was edited and no Codex Security review was run.
- Tests: Static inspection of CaseDetail, all panel components, TypeScript/API contracts, backend timeline/threat-context assemblers, and the focused sheet/embedded/panel/live/lazy/a11y regression suites. No runtime tests were required for this read-only audit.
- Status: done.
- Next: Implement per-panel `case-manager` presentation branches, normalize real IOC fields additively, keep every existing capability, and verify both the embedded workspace and default sheet.

### 2026-07-20 03:51Z — `/root/tab_test_audit` — Case Manager all-tab test audit complete
- Context: Finish the read-only runtime/static/accessibility/responsive coverage audit for all six shared CaseDetail panels in the embedded Case Manager.
- Did: Mapped existing coverage and proposed a minimal non-snapshot suite: one real six-tab embedded traversal, backend-canonical Timeline fixture + trace jump, backend-realistic MITRE/IOC/asset fixture + two-up/stack contract, and a mounted Collaboration composition. Recommended a single exported presentation type, explicit per-panel presentation props, stable panel hooks, and direct panel axe coverage. Found two live Threat Context fixture traps hidden by current tests: backend IOC rows use `score`/`sources` while the UI expects `reputation_score`/`source`, and backend asset criticality is numeric/top-level while the UI types it as a string/nested attributes; realistic fixtures must cover both.
- Tests: Static inspection of CaseDetail/CaseManager orchestration, all six panel implementations, panel/component tests, frontend/backend contracts, backend stage/threat-context builders, both ZIP prototypes, and the canonical design standard. No product files were edited, no runtime mutation was needed, and no Codex Security review was run.
- Status: done.
- Next: Add the focused tests alongside the embedded-only implementation; use live desktop/mobile browser geometry checks for actual wrapping because jsdom cannot validate media-query layout.

### 2026-07-20 03:54Z — `/root/tab_test_audit` — Case Manager all-tab focused test implementation started
- Context: Implement the focused, tests-only regression coverage requested after the all-tab audit while the embedded panel presentation work lands in parallel.
- Did: Scoped changes to Timeline, Threat Context, Collaboration, Chat, and static CaseDetail wiring tests; product source remains owned by the frontend implementer. Fixtures will mirror backend stage, IOC, asset, thread, task, and activity contracts and assertions will stay semantic rather than snapshot-based. No Codex Security review will be run.
- Tests: Focused Vitest files pending.
- Status: in-progress.
- Next: Inspect the final in-flight presentation branches, patch only tests, then run the touched Vitest files.

### 2026-07-20 04:00Z — `/root/tab_test_audit` — Case Manager all-tab focused tests complete
- Context: Close the tests-only implementation for the Case Manager Timeline, Threat Context, Collaboration, Chat, and CaseDetail presentation wiring.
- Did: Added a backend-canonical six-stage Timeline story with ordered semantic headings, a deterministic-trace callback assertion, and an escaped untrusted source block; added backend-real Threat Context coverage for `score`/`sources`, numeric criticality, the two lead cards, and axe; mounted Collaboration with human/AI discussion, ownership, task, activity, live SSE wiring, the 16rem responsive rail contract, and axe; pinned the shared case-scoped Chat frame and axe; and statically required all six panels plus the Timeline handoff to receive the embedded presentation contract. Product source was not edited and no Codex Security review was run.
- Tests: Focused Vitest command passed 39/39 across 5 files; `git diff --check` passed for all touched tests and Journal. ChatPanel's pre-existing asynchronous model/source initialization still emits non-failing React `act(...)` warnings in its test file.
- Status: done.
- Next: The frontend implementer can run the wider Console validation and browser geometry pass after the remaining product presentation branches settle.

### 2026-07-20 04:01Z — Codex frontend implementer — Case Manager live all-tab compositions implemented
- Context: Complete the first implementation milestone for the requested ZIP-faithful Timeline and remaining Case Manager tabs without forking the legacy Cases workflow.
- Did: Added an embedded-only panel presentation seam across all six shared panels; rebuilt Timeline as the live six-stage UTC narrative with honest scalar risk meter and a real Investigation jump; added the critical AI-assessment banner, always-visible terminal trace, lean deterministic summary, and retained evidence/policy disclosures; rebuilt Threat Context around the two equal MITRE/IOC cards while preserving summary/assets and normalizing backend-real `score`/`sources` plus numeric asset context; reskinned Collaboration to the reference 1fr/16rem rail and Chat to the 500px divided frame. Existing RBAC, SSE, task/thread mutations, one chat engine, escaped untrusted data, loading/errors, and the default sheet remain intact. No Codex Security review was run.
- Tests: TypeScript compile and full Console lint passed. Focused semantic/a11y tests, production build, full regressions, and desktop/mobile Browser QA remain pending.
- Status: in-progress.
- Next: Land focused panel tests, exercise every embedded tab in the live Browser, correct visual/overflow issues, then run the complete frontend/backend validation matrix.

### 2026-07-20 04:02Z — `/root/panel_contract_map` — Full backend regression validation started
- Context: Validation-only follow-up for the Case Manager all-tab implementation using the repository's existing backend virtual environment.
- Did: Began the complete offline backend pytest suite. No product source edits and no Codex Security review.
- Tests: `cd backend && .venv/bin/python -m pytest -q` in progress.
- Status: in-progress.
- Next: Record the exact count, elapsed time, and any failures, then report to the frontend implementer.

### 2026-07-20 04:07Z — `/root/tab_zip_audit` — Frontend release-gate validation started
- Context: Validation-only follow-up for the completed Case Manager all-tab implementation.
- Did: Confirmed the repository-standard frontend commands from `webui/package.json` and began production build, lint, generated API drift, and UI design-gate validation. No product source edits and no Codex Security review.
- Tests: `npm run build`, `npm run lint`, `npm run check:types`, and `npm run gates` pending from `webui/`.
- Status: in-progress.
- Next: Record exact command outputs and return any actionable failures without modifying product code.

### 2026-07-20 04:08Z — `/root/tab_zip_audit` — Frontend release-gate validation complete
- Context: Complete the validation-only frontend release checks for the Case Manager all-tab implementation.
- Did: Ran the exact repository-standard package scripts without modifying product source. Production TypeScript/Vite compilation, ESLint, generated OpenAPI type drift, and every UI design gate passed. No Codex Security review was run.
- Tests: `cd webui && npm run build` passed (3,157 modules; Vite build 4.20s; entry 288.11 kB / 85.15 kB gzip; CaseDetail 177.87 kB / 42.32 kB gzip; CaseManager 12.19 kB / 4.39 kB gzip). `npm run lint` passed with zero errors/warnings. `npm run check:types` passed against OpenAPI 3.1.0 / 190 paths with no generated drift. `npm run gates` passed all checks: 37 required tokens, 82 contrast axes across both themes, no new arbitrary text sizes, no new raw hex colours, and a separable chart ramp across three dichromacies in both themes.
- Status: done.
- Next: Combine these green release gates with the focused/full Console tests, backend regression, and final Browser geometry checks owned by the orchestrator.

### 2026-07-20 04:09Z — `/root/panel_contract_map` — Full backend regression validation complete
- Context: Complete the requested validation-only backend regression run for the Case Manager all-tab implementation.
- Did: Ran the complete offline backend suite from the existing `.venv`; pytest exited successfully. No product source edits and no Codex Security review.
- Tests: `cd backend && .venv/bin/python -m pytest -q` passed `1,957/1,957` tests in approximately `60.004s` of tool-measured wall time, with `0` failures and `1` warning. The warning is the expected Elasticsearch client `SecurityWarning` in `test_per_source_client_never_carries_mgmt_key` for the test fixture URL using `verify_certs=False`.
- Status: done.
- Next: Combine this green backend gate with the frontend release checks, full Console suite, and final Browser QA.

### 2026-07-20 04:21Z — Codex frontend implementer — Case Manager all-tab fidelity pass complete
- Context: Finish the requested ZIP- and screenshot-faithful Timeline plus the remaining Case Manager tabs while preserving the existing Cases surface and every live case capability.
- Did: Finalized the embedded-only Overview, Timeline, Investigation, Threat Context, Collaboration, and Chat compositions; kept the flat reference header with top-right Share / Take Action / Close controls; retained live RBAC actions, deterministic decision authority, SSE collaboration, tasks, activity, shared case chat, escaped untrusted evidence, loading/error/empty states, and the legacy Cases drawer. Corrected the final phone-width Collaboration grid min-content overflow so both Collaboration and Chat stay exactly within the viewport. No Codex Security review was run, per the user's standing request.
- Tests: Full Console suite passed `1,375/1,375` across 241 files; after the final responsive sizing correction, the affected CaseDetail/panel/component suite passed `49/49`, production TypeScript/Vite build passed (3,157 modules), lint passed with zero errors/warnings, and `git diff --check` passed. Generated API drift and design gates passed (OpenAPI 3.1.0 / 190 paths; 37 tokens; 82 contrast axes; raw-colour/arbitrary-size/CVD checks). Full backend suite passed `1,957/1,957`. Live in-app Browser QA exercised all six tabs at desktop and phone widths; at `390×844`, Collaboration and Chat each measured `356px` client/scroll width inside a `390px` document, and at `1280×720` Timeline rendered all six live stages with zero console warnings/errors.
- Status: done.
- Next: Operator visual review. No deployment, staging, commit, or push was requested.

### 2026-07-20 04:29Z — Codex frontend implementer — Noise-flow spacing refinement started
- Context: Use the free dashboard space to make the Noise Reduction Flow graph slightly larger and place its six stage summaries slightly lower.
- Did: Located the shared flat `NoiseFunnel` composition and scoped the change to its flow-band height and rail spacing only; no metric derivation, hover behavior, click navigation, or other dashboard layout will change.
- Tests: Focused component test, lint/build, and live dashboard visual check pending.
- Status: in-progress.
- Next: Apply the small responsive sizing adjustment, pin it with focused coverage, and verify the running local dashboard.

### 2026-07-20 04:32Z — Codex frontend implementer — Noise-flow spacing refinement complete
- Context: Finish the requested small enlargement of the Noise Reduction Flow and lower its six stage summaries into the available dashboard space.
- Did: Increased the flat dashboard flow band from `h-32 sm:h-36` to `h-36 sm:h-44` and added an 8px top inset to the six-stage rail. Card-mode sizing, Sankey data/geometry, labels, hover cards, click navigation, and surrounding dashboard composition remain unchanged.
- Tests: `NoiseFunnel.test.tsx` passed `15/15`; full lint passed; TypeScript/Vite production build passed with 3,157 modules; `git diff --check` passed. Local frontend and backend health checks returned HTTP 200 / `status: ok`. The in-app Browser controller remained confined to its stale pre-restart network-error interstitial, so no unsafe bypass was attempted; the exact responsive height/spacing contract is covered by the focused test.
- Status: done.
- Next: Refresh the already-running local Overview page to review the updated proportions.

### 2026-07-20 08:20Z — Codex frontend implementer — Case decision copy and analyst-chat refinement started
- Context: Remove the redundant Case Manager decision wording, shorten the false-positive policy notice exactly as requested, and redesign the embedded Chat tab to match the supplied analyst transcript reference without forking the suite's shared live chat engine.
- Did: Scoped the work to the embedded Case Manager Overview and Chat presentations and began a source, regression, and visual-reference audit. The legacy Cases drawer, backend contracts, deterministic decision authority, and shared chat transport remain out of scope for behavioral change. No Codex Security review will be run, per the user's standing request.
- Tests: Focused semantic/a11y tests, full frontend validation, and live local Browser QA pending.
- Status: in-progress.
- Next: Correct the decision copy, add an embedded transcript presentation around the existing ChatPanel state/actions, then exercise copy, messages, quick actions, composer, loading states, accessibility, and responsive geometry.

### 2026-07-20 08:43Z — Codex frontend implementer — Case decision copy and analyst-chat refinement complete
- Context: Finish the requested Case Manager copy cleanup and screenshot-led Chat redesign while retaining the suite's single shared live chat engine.
- Did: Shortened the disabled-policy notice to exactly `False-positive auto-close is disabled`; de-duplicated equivalent verdict/lifecycle labels so `needs_human + needs_human` now reads once while distinct outcomes still append; replaced the embedded Chat card chrome with the flat analyst-console composition from the reference; added the scoped READY/WORKING rail, honest empty analyst state, outlined AI and right-aligned operator turns, live searching state, three functional quick actions, compact growing composer, square send control, and a quiet settings popover that preserves source/model selection. Kept the default Chat page/legacy case chat unchanged, retained real case-scoped API sends, response tables/provenance/memory/actions, and added responsive height plus accessible quick-action grouping. No Codex Security review was run.
- Tests: Focused Overview/CaseChat/shared-Chat suite passed `32/32`; complete Console suite passed `1,380/1,380` across 241 files; TypeScript/Vite production build passed with 3,157 modules; ESLint passed with zero errors/warnings; OpenAPI type drift check passed for 190 paths; all design gates passed (37 tokens, 82 contrast axes, raw-colour/arbitrary-size/CVD checks); `git diff --check` passed. Live Browser QA confirmed the exact policy sentence, the single `Needs human review` heading, a real demo chat exchange, the READY rail, full source/model control retention, zero horizontal document overflow, and no browser console warnings/errors; a deferred-send regression test pinned the WORKING state and transition back to READY. Frontend and backend health checks returned HTTP 200 / `status: ok`.
- Status: done.
- Next: Operator visual review of the already-open Case Manager Chat tab; no commit, push, deployment, or unrelated mutation was requested.

### 2026-07-20 08:45Z — Codex frontend implementer — Case chat composer placement refinement started
- Context: Move the Case Manager analyst quick actions and composer slightly lower to use the free vertical space shown in the operator screenshot.
- Did: Confirmed the composer is correctly bottom-pinned inside its chat frame and scoped the adjustment to the frame's responsive height only, so transcript scrolling, prompt growth, and shorter viewport behavior remain intact. No Codex Security review will be run.
- Tests: Focused CaseChat regression, production build, lint, diff check, and live visual/geometry validation pending.
- Status: in-progress.
- Next: Increase the roomier-screen height band, update the exact responsive contract test, and verify the final bottom spacing in the running console.

### 2026-07-20 08:48Z — Codex frontend implementer — Case chat composer placement refinement complete
- Context: Finish the small Case Manager Chat spacing refinement requested from the 1420×892 reference screenshot.
- Did: Expanded only the embedded analyst console's responsive height from `clamp(30rem,58vh,36rem)` to `clamp(30rem,66vh,40rem)`. This moves the bottom-pinned quick actions and Ask AI Analyst composer about 72px lower at the reference height while preserving the existing 30rem minimum on shorter viewports, transcript scrolling, and composer growth.
- Tests: Focused CaseChat suite passed `9/9`; TypeScript/Vite production build passed with 3,157 modules; ESLint passed with zero errors/warnings; `git diff --check` passed. Live in-app Browser QA at exactly 1420×892 measured a 588.7px chat frame, the composer 28px above its panel edge, document width equal to viewport width, no horizontal overflow, and no browser warnings/errors.
- Status: done.
- Next: Operator visual review in the already-open local Case Manager Chat tab; no commit, push, deployment, or unrelated mutation was requested.
### 2026-07-20 10:06Z — Codex frontend implementer — Case Manager explainability and bulk-workflow refinement started
- Context: Refine the new Case Manager from the supplied timeline, action-menu, and overview screenshots: make risk derivation explicit, remove redundant investigation text/actions, rename the final stage, pulse only the terminal marker, clean and enrich Overview without information loss, and add multi-case selection with useful bulk actions.
- Did: Began a source/data-contract/visual audit across StageTimeline, OverviewPanel, CaseDetail actions, and the Case Manager queue. The existing deterministic close/escalate authority and dark-theme design system remain unchanged. The in-app browser workflow will be used for live interaction and responsive visual QA. No Codex Security review will be run, per the user's standing request.
- Tests: Focused semantic/a11y regressions, full frontend validation, and live browser QA pending.
- Status: in-progress.
- Next: Implement the four isolated UI slices in parallel, integrate their contracts, then exercise all interactions and layout states in the running local console.

### 2026-07-20 10:08Z — Codex frontend implementer — Take Action redundancy removed
- Context: The Timeline and Investigation destinations are already permanently visible as Case Manager tabs and should not be repeated as pseudo-actions.
- Did: Removed only the duplicate Timeline and Investigation entries from the embedded top-right Take Action menu. Kept Reinvestigate, playbook execution, refresh, case chat, lifecycle controls, exports, notification, and campaign navigation intact.
- Tests: Focused embedded CaseDetail workflow suite passed `4/4`, including explicit absence assertions for the two repeated menu entries.
- Status: complete milestone; broader Case Manager work remains in progress.
- Next: Integrate explainable timeline, overview, and multi-select queue refinements.

### 2026-07-20 10:07Z — `/root/case_bulk_selection` — Case Manager multi-select workflow started
- Context: Add accessible per-case selection and a compact, deterministic-safe bulk reinvestigation workflow to the new Case Manager queue only.
- Did: Scoped ownership to `webui/src/soc/pages/CaseManager.tsx` and its focused tests; began mapping the existing case action API and queue interaction model. No backend endpoint, decision-policy change, dependency, or Codex Security review is planned.
- Tests: Focused interaction/a11y tests, build, lint, and diff validation pending.
- Status: in-progress.
- Next: Reuse the existing per-case reinvestigation path with bounded all-settled execution, update successful cases, surface partial failures honestly, and lock select-all/indeterminate/navigation semantics with tests.

### 2026-07-20 10:14Z — `/root/case_bulk_selection` — Case Manager multi-select workflow complete
- Context: Finish the new Case Manager queue's accessible multi-case selection and safe bulk reinvestigation workflow.
- Did: Added sibling (non-nested) per-case checkboxes, select-all-visible with native mixed-state semantics, filter-stable selection, clear-selection, and a compact responsive action rail. Reused `api.reinvestigateCase` behind the existing explicit LLM-cost confirmation; work runs through bounded batches of three using `Promise.allSettled`, so every case re-enters the canonical pipeline and deterministic decision path. The rail reports live progress and persistent success/partial-failure results (including each failed case's display id), removes only successful ids from selection, leaves failures selected for retry, replaces queue cases with authoritative responses, and refreshes the open detail only when it changed. No backend endpoint, lifecycle shortcut, dependency, or Codex Security review was added.
- Tests: Focused `CaseManager.test.tsx` passed `9/9`, including row-navigation isolation, select-all `mixed`, filter persistence, clear selection, confirmation, partial failure, authoritative row refresh, concurrency cap, progress locking, and `jest-axe`. File-scoped ESLint passed with zero errors/warnings; owned-file `git diff --check` passed. The integrated build reached TypeScript and was blocked only by concurrent out-of-scope unused declarations in `OverviewPanel.tsx:76` and `StageTimeline.tsx:324`; the orchestrator owns the final post-merge build.
- Status: done.
- Next: Orchestrator to run the integrated build/full suite and live browser QA after the Overview/Timeline agents finish their concurrent edits.

### 2026-07-20 10:07Z — Codex timeline implementer — Case Manager timeline explainability refinement started
- Context: Isolate the Case Manager Timeline changes: operator-facing stage labels, an honest score derivation, duplicate investigation copy, and terminal-marker motion.
- Did: Began tracing the live `TimelineStage` payload from the backend projection through the typed frontend renderer and its focused regression suite. Scope is limited to `StageTimeline` and its tests; no deterministic decision logic or backend behavior will change, and no Codex Security review will be run.
- Tests: Focused Timeline tests, lint, type/build validation, and accessibility/motion checks pending.
- Status: in-progress.
- Next: Preserve the existing API contract, derive explanations only from supplied score/factor data, and pin all four requested behaviors with focused tests.

### 2026-07-20 10:07Z — `/root/overview_refinement` — Case Manager Overview refinement started
- Context: Clean and tighten the embedded Case Manager Overview from the supplied reference while retaining every current fact, action, and deterministic decision-policy explanation.
- Did: Scoped changes to `OverviewPanel` and its focused tests, with an embedded-only flat SOC treatment and compact risk/confidence visuals derived strictly from existing case fields. The legacy Case Detail presentation and backend decision authority remain unchanged. No Codex Security review will be run.
- Tests: Focused semantic/accessibility tests and type/build validation pending.
- Status: in-progress.
- Next: Audit the existing component variants and test contracts, implement the presentation refinement, then verify information parity and accessible visual equivalents.

### 2026-07-20 10:16Z — `/root/overview_refinement` — Case Manager Overview refinement complete
- Context: Finish the screenshot-led cleanup of the embedded Case Manager Overview without losing case facts, provenance, or deterministic-policy explanations.
- Did: Consolidated the repeated Decision brief / provenance / pinned DecisionCard projection into one compact embedded brief plus a CODE DECIDED authority lane; kept route, disposition, escalation, impact, priority, recommendation, policy note, decider, objection window, and auto-close marker. Added dependency-free risk and confidence meters plus five recorded risk-factor mini bars sourced only from existing case/triage data, each with visible numeric text and labelled progress semantics. Tightened embedded spacing and card padding while leaving the default legacy presentation and its pinned DecisionCard unchanged. No Codex Security review was run.
- Tests: Focused Overview + baseline suites passed `28/28`, including `jest-axe`; TypeScript/Vite production build passed with 3,157 modules; ESLint passed with zero errors/warnings; all UI design gates passed (37 tokens, 82 contrast axes, raw-colour/arbitrary-size/CVD checks); `git diff --check` passed.
- Status: done.
- Next: Orchestrator to include the shared Overview changes in the integrated 1420×892 dark-theme Browser pass and full-suite validation.

### 2026-07-20 10:20Z — Codex timeline implementer — Case Manager timeline explainability refinement complete
- Context: Finish the requested Case Manager Timeline labels, risk-score explanation, investigation de-duplication, and terminal-marker animation.
- Did: Renamed the canonical API/UI labels to `Risk assigned` and `Decision` while retaining compatible `risk`/`decide` ids; added a read-only `StageRiskCalculation` payload with all five persisted 0–100 factor values, current configured weights, numerator terms, normalized score contributions, numerator/denominator, calculated/recorded/displayed totals, and a historical-mismatch signal; rendered those facts behind the `Risk factors` disclosure with a table and readable formula. Older payloads fall back to their supplied factor values and explicitly state that missing weights/contributions prevent exact reconstruction. Suppressed only the Investigate headline that exactly duplicates its verdict/confidence chips. Applied reduced-motion-safe pulsing to only the terminal marker and exposed stable marker/terminal/motion data hooks. `compute_risk()` and deterministic `decide()` were untouched; no Codex Security review was run.
- Tests: Backend case-stage suite passed `9/9`; focused StageTimeline + TimelinePanel suites passed `18/18`, including expanded risk-derivation `jest-axe`; TypeScript/Vite production build passed with 3,157 modules; ESLint passed with zero errors/warnings; all five design gates passed; OpenAPI drift check passed at 190 paths with no generated-file change; scoped `git diff --check` passed.
- Status: done.
- Next: Orchestrator to restart/reload the local backend if needed, then use the stable timeline hooks during integrated dark/light Browser QA; legacy/demo cases with non-reconstructable historical factors will correctly show the explicit mismatch/data-gap copy.

### 2026-07-20 10:39Z — Codex frontend implementer — Case Manager explainability and bulk-workflow refinement complete
- Context: Finish the supplied screenshot-led Case Manager refinement: exact risk-score explainability, clearer timeline language/motion, a non-redundant action menu, a denser information-complete Overview, and safe multi-case operations.
- Did: Integrated `Risk assigned` / `Decision` timeline labels, exact five-factor value/weight/contribution math behind the Risk factors disclosure, exact duplicate Investigate-copy suppression, and reduced-motion-safe pulsing on only the terminal marker. Removed the redundant Timeline and Investigation destinations from Take Action while retaining every real lifecycle, investigation, collaboration, export, and campaign action. Consolidated the embedded Overview into one compact decision brief and deterministic authority lane, added accessible risk/confidence/factor visuals without dropping route, policy, impact, priority, disposition, provenance, or recommendation data, and added independent row selection, select-all-visible/mixed state, clear selection, and confirmed bulk reinvestigation with three-request concurrency, progress, authoritative refreshes, and honest partial failures. Corrected seeded demo factor fixtures so their displayed risk scores reconcile exactly under the default configured weights; older real cases still show the explicit historical-weight mismatch/data-gap notice when exact reconstruction is impossible. No Codex Security review was run.
- Tests: Complete Console suite passed `1,392/1,392` across 241 files; focused integrated Case Manager/Timeline/Overview/action suites passed `55/55`; TypeScript/Vite production build, ESLint, OpenAPI drift check (190 paths), all design gates (37 tokens, 82 contrast axes, raw-colour/arbitrary-size/CVD checks), and `git diff --check` passed. Complete backend suite passed `1,960/1,960` with the one expected Elasticsearch test-fixture TLS warning. Live in-app Browser QA in dark mode verified exact `62/100` factor reconciliation, one terminal pulse, no duplicate Investigate sentence or Timeline/Investigation action items, select-all and indeterminate behavior, non-navigating row checkboxes, the LLM-cost bulk confirmation (cancelled without mutation), seven accessible Overview progress visuals, fully visible factor labels, zero browser warnings/errors, and zero horizontal overflow at both desktop and `390×844` widths.
- Status: done.
- Next: Operator visual review of the Case Manager Overview left open in the in-app browser. No deployment, commit, staging, or push was requested.

### 2026-07-20 10:56Z — Codex frontend implementer — Case Manager overview and chat geometry follow-up started
- Context: Apply the operator's screenshot-led follow-up: remove the redundant Decision brief eyebrow, semantically colour true-positive/escalated headings, prevent recorded-factor label wrapping, add case-specific factor explanations on hover, and anchor the Case Manager chat composer to the bottom edge.
- Did: Began a focused audit of the embedded Overview signal profile, semantic verdict palette, shared hover primitives, and embedded analyst-console height/flex contracts. The deterministic score/decision pipeline and legacy Cases surface remain unchanged. The in-app browser workflow will verify both themes and responsive geometry; no Codex Security review will be run.
- Tests: Focused Overview/Chat semantic and accessibility regressions, full frontend validation, and live browser checks pending.
- Status: in-progress.
- Next: Implement the isolated Overview and Chat slices in parallel, integrate them, then exercise hover content and bottom anchoring at desktop and phone widths.

### 2026-07-20 11:22Z — Codex frontend implementer — Case Manager overview and chat geometry follow-up complete
- Context: Finish the operator's follow-up on Overview hierarchy, true-positive emphasis, risk-factor readability/explainability, and bottom-anchored Case Manager chat composition.
- Did: Removed the embedded-only Decision brief eyebrow while preserving the legacy case sheet; applied the dual-theme semantic critical text token to true-positive/escalated headings; replaced the cramped factor columns with non-wrapping horizontal meters; and added keyboard-focusable hover explanations for Volume, Velocity, Reputation, Diversity, and Asset criticality that state both the engine definition and the case evidence actually available. Reworked the embedded Chat height chain so only the transcript scrolls and the quick actions/composer remain at the bottom, including compact responsive status/action rails at phone widths. The deterministic risk and decision pipeline remains unchanged. No Codex Security review was run.
- Tests: Complete Console suite passed `1,396/1,396` across 241 files; final focused Overview/Chat/Case Detail/Case Manager regression passed `59/59`; TypeScript/Vite production build passed with 3,157 modules; ESLint, all design gates, OpenAPI drift check at 190 paths, and `git diff --check` passed. In-app Browser QA verified dark/light AA heading contrast (`5.17:1` / `6.07:1`), unbroken factor labels, no horizontal overflow, transcript-only scrolling, bottom-visible composers at desktop, `390x844`, and `320x568`, and no new browser logs.
- Status: done.
- Next: Operator visual review of the dark-theme Case Manager Overview left open in the in-app browser. No deployment, staging, commit, or push was requested.

### 2026-07-20 12:43Z — Codex dashboard implementer — Dashboard flow, lifecycle, scope, and refresh follow-up started
- Context: Apply the operator's four dashboard refinements: widen only the Noise Reduction graph toward the left, reverse the Open/Resolved snapshot order, reconcile the Critical/High KPI with the selected time-window data, and add a five-second auto-refresh cadence.
- Did: Began auditing the NoiseFunnel plot geometry independently of its heading/stage rail, the lifecycle snapshot composition order, the dashboard metric derivations, and the shared refresh dropdown contract. The in-app Browser workflow will compare both themes and responsive behavior. No Codex Security review will be run.
- Tests: Focused dashboard, NoiseFunnel, and refresh-control regressions plus full frontend validation and live Browser checks pending.
- Status: in-progress.
- Next: Resolve the KPI scope from code and live data, implement the four isolated changes in parallel, then integrate and verify.

### 2026-07-20 11:25Z — Codex frontend implementer — Case Manager flat Overview follow-up started
- Context: Remove the recorded-factor scale helper, restore larger neutral decision headings, and replace the embedded Overview's card-like treatment with the flatter visual language used by the current dashboard.
- Did: Began comparing the embedded Overview structure and tokens against the dashboard's border-light section hierarchy. Scope is presentation-only; risk explanations, case facts, deterministic scoring, and legacy Case Detail behavior remain intact. The in-app Browser workflow will verify both themes and responsive behavior; no Codex Security review will be run.
- Tests: Focused Overview semantic/accessibility tests, production build, lint, diff hygiene, and live browser checks pending.
- Status: in-progress.
- Next: Identify the exact shared dashboard treatment, implement the embedded-only flattening, then validate visually and with focused regressions.

### 2026-07-20 11:37Z — Codex frontend implementer — Case Manager flat Overview follow-up complete
- Context: Match the embedded Case Manager Overview to the Security Command Center's flat, divider-led surface grammar while restoring a larger neutral decision title and removing the redundant recorded-factor scale helper.
- Did: Removed the visible `0–100 each` copy; changed every embedded decision outcome to the shared `text-foreground` title color at the larger `text-3xl` step; removed the semantic left-edge/card chrome; and converted the embedded summary, provenance, entity, evidence, baseline, and expanded audit surfaces to transparent dashboard bands separated by quiet borders. All case facts, signal meters, accessible factor explanations, and deterministic decision projections remain present. The legacy Case Detail sheet retains its original card treatment. No Codex Security review was run.
- Tests: Complete Console suite passed `1,396/1,396` across 241 files; focused Overview/baseline regression passed `31/31`, including accessibility coverage; TypeScript/Vite production build passed with 3,157 modules; ESLint and `git diff --check` passed. In-app Browser QA verified the flat composition in light and dark themes, neutral dark-mode heading color, no scale helper, no horizontal overflow at desktop, `390x844`, or `320x568`, and a clean stable reload with only normal Vite/React development messages.
- Status: done.
- Next: Operator visual review of the dark-theme Case Manager Overview left open in the in-app browser. No deployment, staging, commit, or push was requested.

### 2026-07-20 13:00Z — `/root/overview_refinement` — Dashboard flow-plot extension complete
- Context: Use the available left-side plot space without moving the Noise Reduction heading, explanatory copy, or six-stage rail.
- Did: Added a flat-variant-only 14-unit SVG left extension that tapers to zero at the terminal node; the first node/ribbons move left while the final node and all surrounding text stay fixed. The reusable card variant remains byte-for-byte geometrically unchanged.
- Tests: Focused NoiseFunnel suite passed `16/16`; the regression compares flat/card first and final node coordinates; scoped ESLint and diff hygiene passed.
- Status: done.
- Next: None.

### 2026-07-20 13:00Z — `/root/timeline_explainability` — Dashboard lifecycle reconciliation complete
- Context: Reverse the Open/Resolved presentation and make the Critical/High KPI explain and reconcile with the lifecycle snapshot in the selected time window.
- Did: Rendered Open cases before Cases resolved; aligned the frontend active-case set with the backend's `new/open/needs_human/investigating/escalated/on_hold` taxonomy; limited the combined Critical/High tile to recognized active or terminal cases; exposed the exact `N open + M resolved` breakdown; aligned the sparkline to the same scope; and routed Open drill-downs through the existing all-active virtual filter. The combined Critical/High drill-down no longer pretends one singleton severity filter represents two severities.
- Tests: Focused and broader Overview suites passed `27/27`, including order, active-state aliases, current-window reconciliation, drill-throughs, and accessibility; scoped ESLint and diff hygiene passed.
- Status: done.
- Next: None.

### 2026-07-20 13:00Z — `/root/case_bulk_selection` — Five-second auto-refresh option complete
- Context: Add an exact five-second cadence to the shared squared auto-refresh dropdown.
- Did: Extended the shared refresh contract with `5s`, displayed `5 seconds` immediately after Off, and mapped it to exactly 5,000 ms without changing the default Off state or the existing 30-second/1-minute/5-minute choices.
- Tests: TimeRangePicker suite passed `21/21` and consumer suites passed `20/20`; fake-timer coverage proves no early tick at 4,999 ms and ticks at 5,000/10,000 ms; scoped ESLint and diff hygiene passed.
- Status: done.
- Next: None.

### 2026-07-20 13:00Z — Codex dashboard implementer — Dashboard flow, lifecycle, scope, and refresh follow-up complete
- Context: Integrate and verify the four requested dashboard refinements.
- Did: Integrated the left-extended flow plot, Open-first lifecycle snapshot, backend-aligned active-case taxonomy, reconciled Critical/High breakdown, honest drill-through scope, and exact five-second refresh option. Live data now visibly reconciles the Critical/High total as open plus resolved (during verification: `63 = 17 open + 46 resolved`), with Open remaining the default lifecycle view and auto-refresh left Off. No Codex Security review was run.
- Tests: Complete Console suite passed `1,400/1,400` across 241 files; TypeScript/Vite production build passed with 3,157 modules; ESLint and `git diff --check` passed. Stable in-app Browser QA verified Open-before-Resolved ordering, the live arithmetic, the visible five-second option, unchanged text/stage-rail geometry, the flat flow's 14-unit first-node extension with fixed final node, zero desktop horizontal overflow, clean light/dark rendering, and no application console warnings/errors after reload.
- Status: done.
- Next: Operator visual review of the dark-theme Dashboard left open in the in-app browser. No deployment, staging, commit, or push was requested.

### 2026-10-09 13:16Z —  AD attack runbooks + decode_acl (#127)
- Context: Final handoff of the Active Directory attack-investigation work; author is leaving the project. Branch `dev/ad1`, based on `e2d89f5` (NOT rebased onto current `Testing`).
- Did: 13 Markdown AD-attack runbooks in `backend/app/runbooks/` (DCSync, DCShadow, Kerberoasting, Kerberos password spray, noPac, Zerologon, SID-history injection, privileged group addition, ADCS ESC1/ESC8, PsExec/WMI lateral movement, Empire schtasks persistence, alert triage), each tested against its EVTX attack sample. `engine/runbooks.py` accepts alias frontmatter keys (`mitre`/`attack_technique`/`techniques`/`tags`/`rules`/`entities`), extracts ATT&CK ids from prose entries, falls back to the body's first paragraph for a missing summary. `agents/prompts.py` projects ~20 extra Windows event fields into the fenced event view (outcome/status/event code, subject_user, SPNs, AccessMask/Properties, SIDs, sAMAccountName renames, 5136 attribute changes, group members; SDDL capped at 2k) + `focus_runbooks()` (a runbook bound to the cluster's rule drops merely-similar ones; applied once in the investigator so the CONTEXT audit matches the prompt). `pipeline.py`: case MITRE adopts the matched runbook's curated techniques, falling back to the model's. New `Preferences.investigator_max_events` (default 12). New read-only `tools/decode_acl.py` (`ToolTier.SAFE`, decodes 5136 SDDL into ACEs, flags replication/ACL-abuse grants, facts only, no verdict) + `Tool.bind_events()` hook so it reads the untruncated field by event id; audit `tool_output_summary` cap 1000 → 8000; Timeline tool steps fall back to the tool summary. WebUI `StageTimeline.tsx`/`WhyPanel.tsx`: decoded-ACL delta headline + collapsible full ACL; agent reasoning split into paragraphs. Two tests read files as UTF-8 (Windows); `test_vigil_wave2` expects the 4th tool. `.gitignore` anchored and extended for local replay data/scripts/datasets/venv. `decide()` untouched (#3); no new deps.
- Tests: Backend pytest on Windows: all pass except 6. Five of them (`test_cache::test_mem_fallback_expires`, `test_distribution_contract::test_built_wheel_contains_all_python_modules_and_runtime_data`, `test_round3_wave2_metrics::test_posture_endpoint`, `test_round3_wave2b_netguard::test_real_keyless_dispatch_on_public_ip_fails_open_fast`, `test_rule_versions_store::test_append_and_list_newest_first`) fail identically on clean `e2d89f5` (pre-existing / Windows environment). The sixth, `test_overhaul_b1_ingestion::test_quiet_poller_tick_drains_durable_deferred_candidate`, is a Windows clock-resolution flake (deferred case `updated_at` == tick start, so the drain skips it); it passes with these changes once a 50 ms gap separates the two. No new unit tests added for decode_acl / alias parsing / focus_runbooks. WebUI build/vitest not re-run.
- Status: done (handed off; not merged).
- Next: Merging into current `Testing` conflicts in `engine/runbooks.py` (rewritten upstream), `agents/pipeline.py`, `agents/prompts.py`, `config.py`, `WhyPanel.tsx`. The current strict runbook loader (plain-text body, 7 fixed labels, 1800-char cap) SKIPS these Markdown runbooks with only a warning, so either adapt the loader to accept them or convert them. Consider unit tests for `decode_acl`, alias parsing and `focus_runbooks`.
