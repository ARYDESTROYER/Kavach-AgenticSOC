# AGENTS.md — Agentic SOC (master context for all agents)

> **New here? Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first** (where we are, how to
> run it, what's done/next), then this file.
>
> **READ THIS FIRST, EVERY SESSION.** This is the single source of truth for the
> project: what it is, how it is built/deployed, the environment, the rules, and
> the current roadmap. It is written for Codex agents (and humans) so any
> fresh session can become productive immediately.
>
> ## ⛔ NON-NEGOTIABLE PROCESS RULE — UPDATE THE JOURNAL
> **Every agent (including the orchestrator) MUST append an entry to
> [`Journal.md`](Journal.md) at the start and end of any work session**, and after
> any meaningful milestone (a feature done, a build produced, a test run, a
> decision, a blocker). The Journal is our shared memory across context resets and
> across sub-agents. If you did work and did not journal it, the work is not done.
> Sub-agents that cannot commit must return their Journal entry in their final
> report so the orchestrator appends it. See the Journal format at the bottom.
>
> **Journal boundary:** product work, repository decisions, milestones, test results,
> and blockers belong in the Journal. Ad-hoc questions about a local deployment,
> localhost URLs/processes, and purely local run/stop/status assistance do **not**.
> Never record local credentials, tokens, host-specific paths, or transient runtime
> details in the Journal.
>
> **Temporary task memory:** a long-running agent may keep a root `memory.md` scratchpad
> to survive context compaction. It is local-only, is ignored by Git, contains no
> secrets, and MUST be deleted when the task is complete. It is never staged,
> committed, or pushed. `Journal.md` remains the durable repository history.

---

## 1. What this is

**Agentic SOC** is a **vendor-agnostic** agentic SOC (Security
Operations Center) triage system. It turns raw alert volume into audited,
cost-metered, human-reviewable cases. It was **built next to** the original
TrustLab / IIT Bombay ELK pipeline and still attaches to it cleanly as a
**read-only consumer**, but it is no longer tied to that one stack:

- **Source-agnostic ingest.** Log sources are pluggable **connectors**
  (`backend/app/connectors/`): pull (Elasticsearch/OpenSearch/Wazuh) + 16 push /
  queue / object-store receivers. Every connector normalises native records into
  **OCSF** (`backend/app/ocsf/`), the canonical internal schema.
- **Selectable state backend.** The suite's OWN bookkeeping runs on Elasticsearch
  (default), PostgreSQL+pgvector, or SQLite via `STATE_BACKEND`.
- **Standalone web UI** is the **primary** surface; the Kibana plugin is archived.

**Naming contract:** **Agentic SOC** is the only product name. Never introduce the
retired prototype name in prose, UI copy, generated documentation, API descriptions,
logs intended for operators, or new identifiers. Existing literal compatibility
contracts keep their current spelling until a separately versioned migration exists:
`TLSOC_*` environment variables, `tlsoc-*` service/image names, `tlsoc-agent-*`
indices, `tlsoc_*` storage/cookie names, `X-TLSOC-*` headers, `tlsoc.connectors`
entry points, existing API fields, and Python/package paths. In documentation, show
those strings only when the exact literal is operationally required; never present
the compatibility namespace as a product or brand. Do not rename a wire identifier
as part of a branding edit, and do not mint new compatibility-prefixed identifiers.

The original upstream pipeline (when attached, we do NOT modify it):
```
rsyslog (omkafka) → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana
```

Components, loosely coupled:
- **Backend** (`backend/`) — FastAPI + LangGraph. ALL the agentic logic:
  connectors + OCSF normalisation, polling/ingestion, correlation, risk scoring,
  the two-tier LLM investigation, the deterministic case manager, tools
  (es_query/enrich/rag), the single LLM gateway + cost ledger, and the suite's own
  state (ES | Postgres | SQLite) behind a `StateStore` abstraction.
- **Web UI** (`webui/`) — the **primary** surface: a standalone Vite + React + TS +
  Tailwind + shadcn/Radix SPA (the first-run wizard + console), talking to the
  backend via an `/api` proxy. Ships in the agnostic compose stack as `tlsoc-webui`
  (nginx). (EUI was removed in the UI overhaul.)
- **Plugin** (`archive/kibana-plugin/`) — **ARCHIVED (2026-06-21)**: the original
  thin Kibana plugin (React + EUI). Retired into `archive/` when we went
  vendor-neutral (the standalone webui is the sole primary surface). It is no longer
  built, tested, or shipped; see `archive/README.md`. Do NOT develop it; if a site
  truly needs the embedded-in-Kibana experience, revive it from the archive.

Authoritative companion docs (keep them in sync when you change behavior):
`docs/HANDOFF.md` (onboarding — START HERE), `README.md` (overview), `DEPLOY.md`
(deploy), `docs/USAGE.md` (use + examples),
`docs/TROUBLESHOOTING.md` (failures), `COMPATIBILITY.md` (upstream compatibility),
`docs/ENVIRONMENT.md` (environments), `docs/VIGIL_STUDY.md` (Vigil study + overhaul
plan), `docs/development/ui-standard.md` (current Console visual/interaction
contract), `ROADMAP.md` (work tracking).

## 2. Target versions

- **The webui (the only surface) targets no specific Kibana version** — it is a
  standalone SPA. The suite connects to Elastic/OpenSearch/Wazuh + 16 push sources
  as data sources, independent of any Kibana.
- When attached to a legacy ELK stack, the compatibility target is Elastic/
  Elasticsearch **8.19.12** (read-only consumer); see `COMPATIBILITY.md`.
- The Kibana **plugin** that used to target 8.19.12 / 8.12.2 is **archived** (see
  `archive/kibana-plugin/`); it is no longer built or version-stamped.

## 3. Architecture (end to end)

```
┌────── PRIMARY surface: standalone Web UI (webui/, Vite+React+Tailwind+shadcn) ─────┐
│ SPA: Wizard · Chat + per-user history · Entity Investigation · Case Manager · Standup │
│      Cost · Settings                                                                  │
│ api (webui/src/lib) → /api proxy (nginx) ───────────────────────▶ tlsoc-backend    │
└────────────────────────────────────────────────────────────────────────┬──────────┘
  (LEGACY surface) Kibana plugin → core.http /api/tlsoc/{path*}            │
  → server proxy (server/routes/index.ts) → ${backendUrl}/api/{path} ─────┤
┌──────────────────── tlsoc-backend (FastAPI + LangGraph) ─────────────────┴──────────┐
│ SOURCES (SIEM/EDR/queues/object-stores)                                              │
│   → CONNECTORS  pull (Elastic/OpenSearch/Wazuh) · push/queue/object receivers (16)   │
│   → OCSF normalisation (canonical schema)                                            │
│   → poll(durable cursor) / ingest → correlate (det.) → risk (det.)                   │
│   → cost-gate → router (role model) → investigator (role model, ReAct)                 │
│   → formatter → Case Manager (deterministic close/escalate)                          │
│ tools: es_query (READ-ONLY logs) · enrich (Redis-cached) · rag_retrieve              │
│ single LLM gateway ──▶ usage/cost ledger (every call)                                │
│ StateStore (own bookkeeping): Elasticsearch (tlsoc-agent-*) | PostgreSQL+pgvector |  │
│   SQLite  ── selected by STATE_BACKEND                                               │
└──── read-only key → log surface (e.g. all-logs-*)   ·   own state → StateStore ──────┘
```

Request path detail (memorize it):
- **Primary (webui):** `webui api.get('cases')` → nginx `/api/*` proxy →
  `${BACKEND}/api/cases` → FastAPI route in `backend/app/api/routes.py`.
- **Legacy (Kibana plugin):** `browser TlsocApi.get('cases')` → `core.http GET
  /api/tlsoc/cases` → Kibana route `/api/tlsoc/{path*}` (`server/routes/index.ts`)
  → `fetch(${backendUrl}/api/cases)` (default `http://tlsoc-backend:8088`) → same
  FastAPI route.

**Both proxies forward arbitrary JSON bodies, so additive request fields need NO
proxy change.**

## 4. Repository layout

```
backend/app/
  config.py          Secrets (env-only; incl. STATE_BACKEND/STATE_DB_URL +
                     per-source connector_secrets) + Preferences (UI-editable,
                     fresh completion roles default to OpenAI GPT-5.6 Luna while
                     embeddings remain dedicated and stored overrides are preserved;
                     incl. sources[] SourceInstance list; Round-4:
                     {threshold_tuning,batch,baseline,campaign} config blocks
                     (tuning observer/campaign/baseline ON; tuning writes review-first
                     unless `auto_apply_confirmed` is explicitly enabled; async Batch
                     opt-in; compatible
                     live OpenAI case/alert Flex preference default ON with truthful
                     standard fallback) +
                     release_updates public GitHub source discovery
                     (default repo + main/Testing refs; configurable and cached;
                     mutable refs remain observation-only) + a separate private-
                     socket supervised-update control plane for signed immutable
                     Stable plans on the supported PostgreSQL Compose profile +
                     storage_lifecycle desired policy (Hot 180d + Warm 90d + desired
                     Glacier from day 270; deletion always off; capability-aware) +
                     caps.max_concurrent + BrandingConfig.login_*
                     bounded plain-text white-label [validator rejects any `<`, #9];
                     AutomationRule → CaseAutomationRule (alias kept, wire key
                     `threshold_automation` unchanged))
  build_identity.py Non-secret current-build normalization plus immutable Case
                     creation-build and first-append audit/usage stamping; legacy
                     provenance is never backfilled
  constants.py       enums (incl. SourceType/IngestMode/CursorKind + OCSF_VERSION),
                     index names, verdict/role/action types, untrusted fences
  models.py          Pydantic data contracts (Case/AuditDoc/UsageDoc/Cursor/
                     RawEvent/...); Case build provenance is nullable+immutable,
                     `retrieval_history_status` is the authoritative lifetime marker,
                     `retrieval_observation_status` proves a completed measurement,
                     and `knowledge_used` retains its backward-compatible array shape
  utils.py           dotted_get, time helpers, extract_json, coerce_float, ...
  ocsf/              OCSF canonical schema: model (OCSFEvent + unmapped/raw_data) ·
                     ecs (ECS→OCSF mapping) · generic_to_ocsf
  connectors/        base (Connector/PullConnector/PushReceiver SPI) · registry
                     (built-ins + tlsoc.connectors entry points) · elastic ·
                     opensearch · wazuh · demo (DemoPullConnector — seeded OCSF;
                     TEST-ONLY, directly instantiated by tests, NOT auto-registered —
                     runtime Demo Mode uses demo_sources/demo_runtime) · receivers/ (webhook ·
                     syslog · queues · objectstore · formats · common) — 16 push receivers
  es/                base (ABC) · client (real, two-key) · fake (in-memory) ·
                     querybuilder · indices (templates + bootstrap)
  llm/               gateway (THE cost-ledger choke point) · providers (Round-4:
                     cache-token extraction + guarded OpenAI `service_tier='flex'` +
                     wired `with_retry`) · pricing (Round-4: `Codex-opus-4-8`
                     corrected $15/$75 → $5/$25 ctx→1M; cache rates applied — read
                     0.1× / write 1.25×[5m]/2×[1h], batch 0.5×; non-cache math
                     byte-identical) · batch (Round-4: `BatchProvider` SPI — Anthropic
                     Message Batches + OpenAI Batch; results UNORDERED → keyed
                     by `custom_id`, one UsageDoc/result at 0.5× #6)
  tools/             base (MCP-shaped, + ToolTier safety tier) · es_query · enrich ·
                     rag (hybrid BM25+vector retrieval; import/list/get/delete +
                     stats; Round-3 TRUSTED-allowlist fencing — only built-in/verified
                     corpus is trusted, imported docs are fenced UNTRUSTED, #9) ·
                     vectorstore (+ list_documents/list_chunks/delete_document/stats)
  enrichment/        EnrichmentProvider SPI (Round 3): base (ABC + manifest) · registry
                     (built-ins + tlsoc.enrichers entry-point, filtered by toggle+key) ·
                     dispatch (enrich_indicator: type-routed IP/domain/hash/url/email,
                     fail-open, Redis-cached) · aggregate (fuse — default max() byte-
                     identical, weighted fusion opt-in) · providers/ (19 registered
                     classes, +17 new in Round 3: abuseipdb · virustotal · greynoise ·
                     shodan · shodan_internetdb · censys · binaryedge · ipinfo · otx ·
                     pulsedive · spur · xforce · urlscan · hibp · projecthoneypot ·
                     abusech [urlhaus/threatfox/malwarebazaar = 3 classes] · rdap;
                     keyless ones default-on)
  realtime.py        multiplexed SSE EventBus (Round 3): in-process asyncio pub/sub +
                     bounded per-subscriber ring + Last-Event-ID replay + heartbeat;
                     GET /api/events (default ON; polling is the graceful fallback);
                     frames published AFTER save, never before decide()
  engine/            correlation (multi-strategy + opt-in cross-source linking) ·
                     risk · cost_gate · case_manager (AutoClosePolicy; decide() pure) ·
                     signatures · poller · poller_manager (Round-4: PollerManager IS
                     state.poller — fans out over EVERY enabled PULL source, per
                     {source.id}:{feed.id} cursor + legacy-"primary"-collision guard +
                     per-signature in-flight lock so concurrent sources never dup a
                     case #4; single/zero-source path byte-identical) ·
                     ingest (push/queue → OCSF) · runbooks
                     (strict Markdown parser/chunker) · runbook_service
                     (protected bundled + CAS-backed operator catalog; RAG projection
                     only, never executable/decision authority) · chunking · case_id (customizable
                     case-XXXX nomenclature; KV sequence + template) ·
                     metrics (verdict/status mix + Round-3 posture: MTTA/MTTR/dwell
                     p50/p90 from status_history, SLA/aging, period-over-period +
                     evidence-qualified case-level knowledge-reference coverage;
                     never quality/per-run; unavailable lifetime history/truncation
                     stay null, not-measured cases stay out of the denominator) ·
                     mitre_coverage (Case.mitre vs the 697-corpus → per-tactic % +
                     ATT&CK Navigator v4.5 layer export) ·
                     shift_report (deterministic attention queue + SLA/aging + workload
                     + deltas for the forward Standup; aggregate-only #7) ·
                     priority (read-time severity/impact/urgency/priority derivation —
                     advisory, never feeds decide()) ·
                     budget (pure pre-flight BudgetGate; over-budget → NEEDS_HUMAN) ·
                     threshold_automation (#3-safe rule actions → HITL proposal) ·
                     threat_context (IOC reputation + MITRE + related cases, fail-open) ·
                     mitre (bundled ATT&CK technique lookup) ·
                     demo_generator (seeded OCSF org+baseline+MITRE storylines) ·
                     demo_runtime (deterministic mock LLM + sandboxed policy — Demo Mode) ·
                     threshold_tuner (Round-4: nightly deterministic tuning observer —
                     per-rule FP uses independent analyst-confirmed outcomes only, with
                     Wilson-LB + min-samples + EWMA + shadow-eval; bounded +1
                     correlation-n/severity_floor changes route to a HITL Proposal by
                     default, suppression always does, and explicit confirmed-evidence
                     auto-apply remains opt-in; audit/rollback; NEVER imports
                     decide()/risk/signature; observer default ON) ·
                     campaigns (Round-4: daily deterministic shared-entity graph →
                     full-set reconciled `Campaign` objects, references case_ids only,
                     never re-clusters #4) ·
                     baseline (Round-4: online EWMA/EWMV + 168 hour-of-week buckets +
                     bounded t-digest + modified-z |M|>3.5 + 3×-period warm-up, H=14d;
                     pure producer) · event_detection (Round-4: EVENT-feed cheap-first
                     funnel pre-aggregate→rules→anomaly→batched configured-router detection →
                     candidates re-enter the SAME correlate/decide pipeline #3/#4,
                     #9-fenced, #7 aggregate-only) · forwarding (Round-4: explain_forwarding
                     — read-only auto-forward-gate explainer) · reset (Round-4: tiered
                     cases/sources/factory reset, NEVER wipes env secrets) ·
                     contrast (pure WCAG contrast/AA-foreground utilities for operator
                     branding, dependency-free, fail-open) · sample_analysis (deterministic
                     field-mapping suggestion from a pasted sample record — no LLM, no
                     persistence of the sample itself, #9-safe) · storage_lifecycle
                     (explicit capability preview/apply; Elasticsearch ILM only for
                     append-only audit+usage; no case rollover/delete/Glacier mutation) ·
                     agent_improvement (read-only aggregate comparison of the last 7
                     complete UTC days against the preceding 28; insufficient evidence
                     stays explicit and never becomes a composite score)
  threat/            mitre_techniques.json (bundled ATT&CK, 697 techniques) +
                     refresh_mitre.py + SOURCE.md (data corpus, not live fetch)
  runbooks/          protected bundled Markdown runbooks (RAG knowledge corpus;
                     operator-authored documents are durable StateStore records)
  playbooks/         Markdown PLAYBOOK engine: manifest · loader · registry
                     (deterministic per-cluster selection + atomic hot-reload)
  auth/              passwords (PBKDF2) · tokens (stdlib HS256 JWT) · service
                     (multi-user + 6-role RBAC + permission matrix + require_permission) ·
                     mfa (stdlib RFC-6238 TOTP + recovery codes) · oidc (Google/
                     Microsoft/generic SSO via code-exchange + userinfo)
  notifications/     channel (NotificationChannel SPI) · email (stdlib SMTP, now incl.
                     an SES preset + IAM-key→SMTP-password HMAC ladder) · webhook
                     (Slack/Teams/generic/PagerDuty/Telegram) · resend (Resend HTTPS
                     API channel) ·
                     dispatch (per-condition triggers + dedup/rate-limit/digest) ·
                     templates (stdlib mustache-subset renderer + 5 preloaded,
                     overridable templates; header_safe/text_safe)
  middleware/        security_headers · csrf · rate_limit (Starlette middleware)
  agents/            prompts · router · investigator · formatter · chat · standup ·
                     graph (LangGraph) · pipeline · common · personas (multi-agent roster)
  stores/            base (abstract repositories — backend-agnostic StateStore) ·
                     cases · usage · ledger_claims (ES keyed Audit/Usage first-writer
                     authority in the non-rolling config index; rolling projection
                     recovery across rollover, no new index) · config_store · cursor_store · users (UserStore
                     over KV — multi-user, no new index/table) · sessions
                     (SessionStore over KV — sid registry, idle/absolute/revocation,
                     refresh rotation) · user_prefs (UserPrefsStore over KV — personal
                     saved views/columns/terminology/theme, keyed by user) · memory
                     (MemoryStore over the KVStore — durable operator facts with
                     approved/pending review state; only approved entries are trusted;
                     EsKVStore/SqlKVStore adapters, no new index) · chat_conversations
                     (bounded per-user Workspace transcripts; server history is
                     authoritative on resume; no new index/table) · proposals ·
                     runbooks (strict-CAS operator Markdown catalog layered over
                     protected bundled runbooks; no new index/table) · playbooks
                     (strict-CAS durable operator procedure catalog layered over
                     immutable bundled playbooks; no new index/table) ·
                     8 Round-3 KV stores (same zero-migration pattern, no new index/
                     table): case_thread · case_activity · case_tasks (per-case
                     collaboration #4) · inbox (per-user fan-out, ~200/user ring) ·
                     notif_prefs (in-app #8) · custom_roles (#6) · price_overlay
                     (per-model price overrides #9) · shift_handoff (Standup acks +
                     action items #11) · 4 Round-4 KV stores (same zero-migration
                     pattern): tuning (per-rule FP tuning state + rollback) · campaigns
                     (full-set active-view reconciliation + durable success anchor) ·
                     baseline (per-signature online stats) · batch_jobs (resume-safe,
                     per-`custom_id` retrieved-dedup → exactly-one UsageDoc/result #6) ·
                     2 Round-5 KV stores (same zero-migration pattern): dashboards
                     (per-user custom dashboards) · rule_versions (rule version ledger +
                     rollback) · noise_counters (Round-7: durable per-hour raw-alert-by-
                     severity tallies backing the Noise-Reduction funnel) · custom_models
                     (Round-9: operator-registered self-hosted/LiteLLM OpenAI-compatible
                     models, $0-priced) · audit/audit_log (ES-backed) · sql/ (engine ·
                     models · repositories · vectorstore — SQLite/Postgres+pgvector)
  api/               routes.py (the base router; incl. /sources, /auth+/users+/auth/mfa+
                     /auth/sso, /auth/refresh+/auth/reauth, /sessions+/admin/sessions,
                     /account/me+/me/avatar, /demo/*, /proposals, /settings/schema,
                     POST /chat + per-user /chat/conversations list/detail/rename/delete;
                     Round-4: acknowledge → INVESTIGATING + GET /api/logs [unified
                     scatter-gather over browse-capable sources] + /cases/{id}/forwarding
                     + /sources/health) + **27 `routes_*.py` feature routers**, ALL
                     auto-discovered at boot (`main.py::discover_feature_routers()` walks
                     `app.api.routes_*`, requires a top-level `router: APIRouter` — no
                     manual registration needed): Round-3's routes_metrics ·
                     routes_standup · routes_enrichment · routes_models · routes_inapp ·
                     routes_cases_collab · routes_triage · routes_roles; Round-4's
                     routes_tuning · routes_campaigns · routes_baseline · routes_batch ·
                     routes_reset [admin + fresh-auth, tiered, never wipes env secrets] ·
                     routes_setup [OOBE first-admin, strong-pw, self-locking]; Round-5's
                     routes_rules [Detection & Rules editor/versioning] ·
                     routes_dashboards [per-user custom dashboards] + **4 more extracted
                     from the base router** — routes_notifications [`/notifications/*`],
                     routes_prefs [`/branding`, `/prefs/*`, `/terminology`, `/views*`],
                     routes_rag [`/rag/*`, `/memory*`], routes_search [`/search`,
                     `/audit`] (none of these paths remain in `routes.py`; there is no
                     `/branding/presets` endpoint). All paths byte-identical across the
                     decomposition; +`POST /api/triage/preview-decision` [rule Test/Preview
                     that NEVER calls decide()/bills the LLM #3/#6] + typed baseline/
                     campaign/batch config endpoints + routes_export [legacy bounded
                     `POST /api/admin/export` plus fresh-auth resumable
                     `/api/admin/export/segment` + `/cancel`; secret-free supported
                     application-state scopes behind `data_export:export`, with ES PIT
                     consistency, actor/scope/snapshot-bound signed cursors, explicit
                     weaker-backend semantics, and Intelligence catalog export with
                     sanitized operator runbook/playbook source plus safe bundled refs]
                     + routes_storage
                     [`GET/PUT /api/storage/lifecycle`, pure preview, freshly authenticated
                     explicit apply limited to supported owned-state targets];
                     routes_runbooks [dedicated `runbooks:read/manage` bundled/operator
                     catalog CRUD + targeted/full RAG reconciliation] · routes_releases
                     [public Stable/Testing source discovery only] · routes_schedulers
                     [read-only worker cadence/attempt/success/error health] ·
                     routes_telemetry [query-backed, versioned telemetry-gap evidence;
                     connector absence alone never creates a recommendation] ·
                     mounted in main.py · deps (require_auth + require_permission +
                     require_fresh_auth + custom-role union enforcement + session check) ·
                     state.py (DI hub; exposes enrichment_registry + event_bus) · main.py
backend/playbooks/   immutable bundled *.md PLAYBOOKS (+ README) — data, not code;
                     durable operator-authored procedures live in the StateStore catalog
backend/tests/       offline tests (fake ES + mock LLM; SQL store on SQLite) — green
webui/               PRIMARY surface: standalone Vite+React+TS+Tailwind+shadcn/Radix SPA
  package.json       Node 22; Tailwind + Radix primitives; `npm run build` bundles the
                     version-matched Help Center, then runs tsc --noEmit + Vite
  src/               main.tsx · styles/theme.css (design tokens + Round-3 allow-listed
                     theme tokens + material chrome vars + Round-5: Radix slate+blue base +
                     3 orthogonal semantic axes severity/status/verdict each token/-fg/-text,
                     MEASURED WCAG-AA both themes, Okabe-Ito+viridis chart ramps, self-hosted
                     Inter+JetBrains Mono) · ui/* (shadcn/Radix primitives) · soc/
                     (App/AppShell/router/nav/theme/auth; Round-5: registry.tsx [the single
                     FEATURES[] registry deriving nav+routes+palette] · rules/* [Detection &
                     Rules home + polymorphic editor + condition builder] · dashboard/*
                     [custom-dashboard builder/grid/widget registry, LAZY react-grid-layout] ·
                     hooks/*; pages/* incl. Users/Security/Approvals/Knowledge/Memory + Round-3
                     Models/Roles/Inbox + Analytics tabs (Operational/Performance/Posture/
                     Effectiveness/Cost; Effectiveness is aggregate-only and Cost exposes
                     actual Standard/Flex/Batch/Unconfirmed ledger tiers) + CaseDetail chips/trace/collab +
                     CaseManager (canonical detail workspace; Active/All split-pane
                     queue, persisted accessible desktop resize, selection +
                     permission-gated bulk work, full six-tab detail; Cases list
                     hands an opened row to the exact Case Manager record) + Chat
                     (searchable 264px desktop history rail/mobile Sheet, newest-first
                     durable per-user transcripts, one docked composer; Case Manager
                     chat stays separate and case-scoped) +
                     Docs (same-origin, version-matched Help Center discovery hub) +
                     Round-5 Dashboards.tsx + settings/* data-driven section files [was a
                     2673-line god-file, now a section registry; includes Organization
                     Storage & retention capability/status/preview/apply]; components/* incl. Can RBAC
                     guard, MfaSetupCard, QRCode, NotificationsEditor, RiskGauge, palette +
                     Round-3 NavSidebar, NotificationBell, GlassSurface, SettingsGrid/Card,
                     theme-tokens resolver, MitreHeatmap/BurnDownChart, TraceTimeline,
                     CaseThread, EnrichmentProvidersEditor, BrandingEditor + ~15 Round-5
                     shared primitives Field/SegmentedControl/ConfirmDialog/NumberField/
                     LabeledSlider/SecretField/TagInput/IconButton/PageContainer/
                     TimeRangePicker/collapsible/typography) · lib/ (api etc.) · test/
  Dockerfile         nginx image (tlsoc-webui) with the /api proxy
archive/             FROZEN legacy code (not built/tested/shipped) — see archive/README.md
  kibana-plugin/     the retired Kibana plugin (tlsoc_agentic_triage/ + dist/ + BUILD.md)
deploy/              docker-compose.agnostic.yml (Postgres+Redis+backend+webui) ·
                     docker-compose.tlsoc.yml (legacy ELK merge) · mappings/ · dashboards/
docs/                USAGE.md · TROUBLESHOOTING.md · ENVIRONMENT.md · VIGIL_STUDY.md ·
                     HANDOFF.md · research/2026-06-round2/ · research/2026-06-round3/
                     (PROPOSAL.md + IMPLEMENTATION.md) · research/2026-07-round4/
                     (PROPOSAL.md + RESEARCH-SYNTHESIS.md + understand/ maps +
                     IMPLEMENTATION.md) · research/2026-07-round5/ (PROPOSAL.md +
                     DESIGN_STANDARD.md + IMPLEMENTATION.md + AUDIT_FINDINGS.md +
                     RESEARCH_* + understand/ maps)
.env.example  README.md  DEPLOY.md  COMPATIBILITY.md  AGENTS.md  Journal.md  ROADMAP.md
```

## 5. The 12 non-negotiables (never regress these)

1. Read-only, scoped ES key for the agent's log access; **never** `kibana_system`
   or the `elastic` superuser. Two physically separate ES clients
   (`es/client.py`): `_ro` (read-only `all-logs-*`) and `_mgmt` (`tlsoc-agent-*`).
2. Every agent action audited, append-only (`tlsoc-agent-audit-*`).
3. Verdict from the LLM; **the close/escalate decision is made by deterministic
   code against the operator-configured `AutoClosePolicy`** — never by raw LLM
   output and never by playbook text (`engine/case_manager.py`, `decide()` is a pure
   fn over `(verdict, confidence, risk_score, policy)`). Auto-close is a tunable,
   per-verdict-class policy (enable/min-confidence/max-risk/objection-window):
   FALSE_POSITIVE on above a bar by default; **TRUE_POSITIVE auto-close is an
   explicit opt-in, OFF by default**; **NEEDS_HUMAN never auto-closes (code-enforced,
   not policy-tunable)**. A playbook can recommend but can never change this policy.
4. Durable polling cursor (no skip / no dup); cases idempotent by cluster
   signature (`engine/poller.py`, `engine/signatures.py`).
5. ONE chat engine, two entry points (`agents/chat.py`). Workspace history is a
   per-user navigation/persistence layer; Case Manager chat remains case-scoped and
   never enters personal Workspace history.
6. 100% of LLM calls through ONE gateway → usage/cost ledger (`llm/gateway.py`).
7. Aggregate-then-summarise (never raw logs to a model) (`agents/standup.py`).
8. Enrichment Redis-cached (`tools/enrich.py`, `cache.py`).
9. Log-derived values are UNTRUSTED DATA in prompts — fenced + labelled
   (`agents/prompts.py`, `UNTRUSTED_OPEN/CLOSE`). Applies to chat context,
   selections, queries — anything attacker-influenceable. The OCSF `unmapped`
   catch-all and `raw_data` (`ocsf/model.py`) carry source-controlled values and
   are treated as UNTRUSTED the same way. Imported and resolved-case RAG remains
   fenced; only curated allow-listed sources and approved human-governed memory may
   enter trusted context. Agent-authored memory starts pending and is never trusted
   until an authorized human approves it.
10. Sane defaults; only keys + data scope required to run (`config.py`). **Since
    Round 10, "sane defaults" means smart-autopilot-ON out of the box** (comprehensive
    ingestion plus tuning observation, campaigns, and baseline producers enabled by
    default). Threshold changes are review-first and learn only from independent
    analyst-confirmed outcomes; the observer being ON is not an outcome-supervised
    auto-write claim. This posture never touches #3: `decide()` stays the sole
    close/escalate authority, and the
    Round-10 risk gate is **routing-only** (reads `compute_risk()`, never changes
    scoring or `decide()`).
11. Spine first & tested (Gate 1); breadth degrades gracefully (Gate 2).
12. Read-only consumer; upstream untouched; cold-deployable.

### Record provenance and retrieval-evidence contract

- A Case's nullable `app_version` and `build_sha` identify its creation build and are
  immutable across later updates or re-investigation. Every new append-only AuditDoc
  and UsageDoc identifies its first append build; idempotent retries preserve that
  first writer. Elasticsearch CaseStore and the SQL Case repository stamp only an
  absent document/row as a defensive fallback; updates restore the existing stored
  provenance, including legacy `null`. Legacy rows are never backfilled.
- `retrieval_history_status` is authoritative for the Case lifetime. A legacy Case
  remains `unavailable` after a modern run because missing earlier history cannot be
  reconstructed. `knowledge_used` always remains an array for wire compatibility;
  `retrieval_observation_status` (`measured`, `not_measured`, or `unavailable`) is
  authoritative for whether that array represents a completed observation. Explicit
  `[]` is a measured zero only when the observation status is `measured`. Latest-run
  procedure provenance separately reports `measured`, `not_attempted`, or `unavailable`
  plus a reason. Fail-soft last-known-good or partial-query context may still inform the
  investigator, but any unverified/failed group keeps that run unavailable and does not
  advance the Case observation to measured.
- Retrieval analytics report case-level reference coverage only. They never claim
  retrieval quality or per-run hit rate. A mixed legacy/instrumented cohort or truncated
  read keeps the headline `null` and unavailable. A history-complete cohort with no
  measured observation is insufficient evidence; individual `not_measured` cases are
  excluded from an otherwise measurable denominator rather than counted as zero.
- This is an additive `0.1.13` contract: no version bump, SQL migration, or historical
  backfill. PostgreSQL/SQLite use existing JSON documents. Elasticsearch bootstrap
  creates missing templates/indices only; it never auto-remaps or reindexes existing
  templates/indices.

## 6. Environment (build/dev sandbox AND deploy target)

See `docs/ENVIRONMENT.md` for the full detail. Summary:

### 6a. This build/dev sandbox (Codex on the web)
- Preserve work deliberately. Commit and publish only when the user or maintainer
  has explicitly authorized that repository mutation; a local verification pass does
  not by itself authorize a push.
- Tooling: `/opt/node22` (Node 22) default on PATH — **fine for the `webui` build**,
  WRONG for the Kibana **plugin** build (use the nvm per-version pin at
  `/opt/nvm/nvm.sh`); Python 3.11 + `backend/.venv`; Docker daemon can be started
  (`sudo dockerd &`) but **image registries are BLOCKED** (docker.elastic.co +
  Docker Hub blobs incl. `pgvector/pgvector` 403) — you CANNOT pull ES/Kibana/
  Postgres images or run any compose stack here.
- Network: `github.com`, `pypi.org`, `registry.npmjs.org`, `nodejs.org` reachable.
  BLOCKED by the egress allowlist: container registries, some Chrome/Playwright
  CDNs (`edgedl.me.gvt1.com`, `cdn.playwright.dev`,
  `playwright.download.prss.microsoft.com`), `ci-stats.kibana.dev` (telemetry).
- **webui (primary surface) builds fully here:** `cd webui && npm install &&
  npm run build`; this first builds the installed `/docs/<major.minor>/` Help Center
  from the pinned MkDocs requirements (bootstrapping ignored `.docs-venv/` when
  needed), then runs `tsc --noEmit && vite build`. `npm run build:app` is the
  app-only typecheck/Vite command and `npm run docs:check` validates an existing
  documentation artifact. No browser/Playwright is required for the static gate.
- **Backend tests run fully offline:** `pytest -q` (fake ES + mock LLM). The SQL
  state backend is testable on **SQLite** (sqlalchemy+aiosqlite) — no Postgres
  needed; asyncpg/pgvector are imported lazily.
- Kibana source checkouts live in `/tmp` (e.g. `/tmp/kibana-8.19`, bootstrapped).
  Keep them warm; `rm -rf` an unused one if disk is tight (~18-22GB free).
- **Consequence:** we verify the supported webui statically (tsc + vite) and the
  backend via offline tests; an archived-plugin revival requires its own unsupported
  unzip/manifest checks. Building/running the
  Docker images (agnostic or legacy compose) is a DEPLOY step.

### 6b. Deploy target (separate session) — two shapes
- **Agnostic stack** (`deploy/docker-compose.agnostic.yml`): Postgres+pgvector
  (`tlsoc-postgres`) + Redis + `tlsoc-backend` (`STATE_BACKEND=postgres`) +
  `tlsoc-webui` (nginx, port 8080). **No Elasticsearch for the app's own state;**
  connect SIEM/EDR sources from the wizard.
- **Existing ELK attachment** (`deploy/docker-compose.tlsoc.yml`): `tlsoc-backend`
  (`STATE_BACKEND=elasticsearch`, own state in `tlsoc-agent-*`) joins an existing
  `TLSOCDockerDeploy` stack (`elasticsearch`/`kibana`/`logstash`/`kafka`, 8.19.12,
  TLS via `./certs/`), reaches `https://elasticsearch:9200` by container name,
  mounts `./certs/ca/ca.crt:ro`; logs in `all-logs-*` (wizard default data view may
  be `fosstlsoc-logs-*` — confirm live). Run the supported standalone webui
  separately; the archived plugin is not built, tested, or shipped.
- Backend env names are **UNPREFIXED** (`ES_API_KEY`/`STATE_BACKEND`/
  `STATE_DB_URL`/…); compose maps `.env` `TLSOC_*` → them (see ENVIRONMENT.md §2.3).
- Global secrets via `.env` (`TLSOC_*`); wizard-pushed global secrets are IN-MEMORY
  only (lost on restart). Per-source connector secrets via the wizard /
  `POST /api/sources/{id}/secrets` — also the in-memory secret tier.

## 7. Build / run / test cheatsheet

```bash
# Backend tests (offline; MUST stay green) — latest recorded full run: 2,306 tests (see Journal for the exact current count)
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
python -m pytest -q                         # -> latest recorded full run: 2,306 passed (see Journal)

# Backend run locally (in-memory store, mock LLM if no keys)
uvicorn app.main:app --port 8088

# Web UI + installed Help Center build, tests, and lint (Node 22)
cd webui && npm install && npm run build   # MkDocs bundle + tsc --noEmit + Vite -> webui/dist/
npm run docs:check                         # validate app 0.1.13 ↔ bundled docs 0.1
npm run test:strict                        # -> latest recorded full run: 1,935 passed / 286 files; zero stderr/console output
npm run lint                               # 0 errors, 0 warnings; jsx-a11y at error

# Shipping backend acceptance also runs `python -m pip check` inside the final
# non-root image; a clean source virtual environment does not substitute for this.

# One-command demo (backend :8088 AUTH ENABLED + webui dev :5173; login Admin / Admin@123)
./scripts/run-demo.sh

# Full agnostic stack (DEPLOY target — NOT runnable in this sandbox: images blocked)
cp .env.example .env   # set TLSOC_PG_PASSWORD + at least one LLM key
./scripts/agentic-soc-compose.sh up -d --build   # webui on :8080

# NOTE: the Kibana plugin is ARCHIVED (archive/kibana-plugin/) and no longer built.
# The standalone webui above is the sole supported surface. To revive the plugin,
# see archive/kibana-plugin/BUILD.md — it is a do-it-yourself exercise.
```

## 8. Conventions

- **Python:** `from __future__ import annotations`, type hints, module docstrings,
  Pydantic v2 (`model_dump(mode="json")` for ES writes). Async throughout.
  Never let an LLM/ES/tool error drop an alert → route to NEEDS_HUMAN.
- **TS/React (webui, the only surface):** functional components + hooks.
  Stack is **Vite + React + TypeScript + Tailwind CSS + shadcn-style primitives on
  Radix UI** — **NOT @elastic/eui** (EUI was fully removed in the UI overhaul). NO
  new npm deps without a deliberate decision — **zero new deps except the deliberate
  lazy `motion`** (12.42.2, Round 10: route/tab/KPI animation, behind `LazyMotion`/
  `domAnimation`, never in the entry chunk). `npm run build` is the supported full
  artifact build (Help Center + `tsc --noEmit` + Vite); use `npm run build:app`
  only when intentionally checking the SPA without rebuilding docs. (The archived
  Kibana plugin's old `@kbn/*`/EUI conventions no longer apply.)
- **UI design system (the suite's shared look — use it, don't re-roll it):**
  - **Design tokens** live in `webui/src/styles/theme.css` as CSS custom properties
    (dual light/dark "command-center" theme) consumed through Tailwind; semantic
    colours (verdict/status/risk) come from `webui/src/soc/components/palette.ts`.
  - **Low-level primitives** are the shadcn/Radix components under `webui/src/ui/*`
    (`button`, `card`, `dialog`, `select`, `tabs`, `table`, `tooltip`, `sheet`,
    `skeleton`, `popover`, `hover-card`, `badge`, … — wrap Radix, do not fork them).
  - **Cross-cutting design-system exports** live under
    `webui/src/design-system/*`: the one centered `LoadingState`/`LoadingGlyph`
    feedback grammar, original theme-adaptive `SourceMark` asset catalog, and the
    JSON-serializable `DESIGN_SYSTEM_CATALOG`. Import from `@/design-system`; do not
    invent a page-local blocking loader or source mark. The catalog is an input for
    future agent/MCP tooling—version 0.1.13 does **not** ship an MCP server.
  - **SOC-domain components** live in `webui/src/soc/components/*`
    (`PageHeader`, `KpiTile`/`StatCard`, `DataTable`, `EmptyState`, `RiskGauge`,
    `CaseHoverCard`, `ChatPanel`, `ChatHistoryRail`, `badges.tsx`, `charts.tsx`,
    `Can.tsx` RBAC guard,
    `LoadingBar`/`Stagger` motion, `HelpTip`, editors for sources/notifications/
    branding/MFA). Pages are `webui/src/soc/pages/*`; shell/nav/router/theme/auth in
    `webui/src/soc/{AppShell,nav,router,theme,auth}.tsx`. Compose these everywhere so
    the console stays consistent (8px grid, WCAG AA).
  - The enforceable visual contract is `docs/development/ui-standard.md`; package
    boundaries, asset rules, and catalog evolution are in
    `docs/development/design-system.md`.
- **Backend↔webui contract:** additive request/response fields are safe (the nginx
  `/api` proxy forwards arbitrary JSON). Keep `webui/src/lib/types.ts` in sync with
  `models.py`.
- **Secrets:** env only; UI shows booleans (`configured ✓`) never values.
- **Tests:** add/keep offline tests; `pytest -q` green (latest recorded full run: 2,306) +
  `npm run build` clean + `npm run test:strict` (latest recorded full run: 1,935/1,935 passed / 286 files) +
  `npm run lint` (0 errors, jsx-a11y at error) before
  every commit. (Counts rise each round — see `Journal.md` for the exact current totals.)
- **Git:** active branch `Testing`. Commit focused changes; push when asked. The
  canonical remote branches are `Testing` for integration and default `main` for
  Stable promotion. Keep the documented pull-request gates and the required
  `CI passed` aggregate enforced through repository settings; branch names alone
  do not prove acceptance.
- **CI/CD acceptance (non-negotiable):** `.github/workflows/ci.yml` exposes eighteen
  independently diagnosable quality lanes plus the fail-closed `CI passed`
  aggregate. The aggregate must be required on both `Testing` and `main`, and the
  exact candidate must pass it on `Testing`, on the resulting `main` commit, and on
  the immutable release tag. Stable application artifacts and versioned documentation
  both wait for that exact tag's successful `CI passed` result. Never merge, tag, or publish with a required lane
  failed, pending, skipped, or cancelled. Never remove, soften, mark
  `continue-on-error`, or bypass a gate merely to make a release green; fix the
  underlying contract. Workflow-policy/ShellCheck validation, fatal Python static
  correctness, deploy/updater contracts, real PostgreSQL+pgvector/Redis acceptance,
  and all three shipping image builds remain independent so an early failure cannot
  hide a later release blocker. External actions use reviewed immutable commit SHAs;
  service and Dockerfile base images use reviewed multi-platform digests; every job has an explicit timeout and least-
  privilege permissions. When a supported runtime, artifact, or release contract is
  added, extend the gate, fail-closed aggregate, and documentation in the same candidate.
- **Release identity and update UI:** the shell always shows `vX.Y.Z · Testing|Stable`; its
  popover reconciles the immutable Console stamp with public backend build-info.
  Any known version/channel/SHA mismatch downgrades to Testing. `run-demo.sh`
  derives Stable only for literal `main`; Docker release builds explicitly stamp
  `TLSOC_RELEASE_CHANNEL`, SHA, and date. On the separately bootstrapped reference
  PostgreSQL Compose deployment, a built-in super-admin may authorize a newer
  compatible Stable release only after the backend and isolated updater return a
  signed, digest-pinned, rollback-capable preflight. Progress is durable through the
  planned backend/Web reconnect; backup, identity/readiness verification, and
  automatic in-flight rollback are updater responsibilities. Known unsaved drafts
  block the action. The browser and ordinary backend never receive the Docker socket,
  host commands, registry credentials, arbitrary artifacts, or migration logic.
  Older deployments need one manual bootstrap, which may reuse a compatible idle
  supervisor or replace only an inspectable idle incompatible one. Active/unreadable
  supervisor state fails closed. The updater never transports the base Compose file.
  The 0.1.x protocol freezes its version-invariant bytes through
  `deploy/update-base-v1.sha256`; release versions and digests belong only in the
  signed generated override. Any base edit requires a new protocol/bootstrap path.
  Target release pins remain in a private pending override through self-handoff,
  backend-writer quiescence, and verified backup. They are promoted to updater-private
  and host-visible active overrides only after cancellation closes at the switch
  boundary. `scripts/agentic-soc-compose.sh` shares the updater lifecycle lock: it
  permits inspection but refuses mutating or unknown Compose commands while a durable
  job is active. Startup clears a leftover marker only when it names an exact durable
  terminal job; unknown or malformed state remains fail-closed.
  Bootstrap restores preserved pins only before `/v1/jobs`; ownership passes to the
  supervisor before submission, and one private unpredictable per-release start key is
  reused until the exact job is observed terminal. Preflight/job records embed their
  idempotency keys and startup repairs missing lookup indexes from durable truth.
  Its restartable, idempotent self-replacement helper resumes or restores the exact
  prior supervisor after ordinary helper-process, Docker-daemon, and host restarts;
  loss of the trusted host or Docker metadata/storage remains manual. Unsupported
  stacks, non-durable secrets, or unsupported state transitions fail closed as
  manual-upgrade-required.
  PostgreSQL and Redis infrastructure versions remain operator-managed. A separate
  same-origin `/release.json` compatibility fallback only activates a coherent pair
  that an external deployment system has already installed; it is not an alternate
  pull, restart, backup, or rollback path.
  A separate amber source notice may come from cached `GET /api/releases/upstream`
  metadata for the operator-configured public GitHub repository and Stable/Testing
  refs. Stable branch HEAD is observation-only; the exact annotated `vVERSION` tag
  commit is the candidate identity. Discovery is a review link only, suppresses
  downgrades, and can never authorize an install or change the updater's host-pinned
  publisher identity.
- **Release discipline:** every supported release is cut from a fully verified
  `main` commit and receives exactly one immutable annotated `vX.Y.Z` tag matching
  the root `VERSION`. A Testing candidate is never tagged Stable. Before promotion,
  update `VERSION`, `[Unreleased]`/release notes, compatibility/deployment guidance,
  the matching `docs/releases/` page, and all generated/build metadata in the same
  candidate. Re-run the complete gate on the resulting `main` commit, then create and
  push the tag from that exact SHA. Never move or reuse a published tag; issue a new
  patch version for corrections. Documentation publication follows the same tag and
  major.minor release line. Keep exactly one active top-level `[Unreleased]` section
  in `CHANGELOG.md`. In the final frozen release-preparation change, convert its
  contents to the intended version/date and immediately open a fresh `[Unreleased]`;
  promote, verify, and tag that exact prepared tree without leaving a Testing snapshot
  presented as an already-published release. The full checklist is
  `docs/releases/channels.md`.

## 9. Sub-agent workflow (how we parallelize)

- Delegate context-heavy or isolated work to Opus sub-agents (builds, tests, docs,
  isolated modules). Give each agent: the exact files, interfaces, acceptance, and
  "run pytest/tsc until green." Sequence agents that touch shared files
  (`models.py`, `config.py`, `routes.py`, plugin `app.tsx`) to avoid edit
  conflicts; parallelize only non-overlapping work.
- Each sub-agent MUST end its report with a **Journal entry** (see format) for the
  orchestrator to append, since sub-agents don't commit.
- The orchestrator owns cross-cutting contracts and integration, reviews diffs,
  runs the final build + tests, and updates the Journal. It commits or publishes
  only when that repository mutation is explicitly authorized.
- Agents may use the ignored root `memory.md` only as temporary task scratch; the
  orchestrator deletes it before handoff. Local-runtime questions are answered to the
  user directly and are not converted into Journal milestones.

## 10. Current status & roadmap

**Round 10 is the newest feature round — a behavior change, not just a UI/UX
pass.** It is committed on `Testing` (including `9010443`). On top of it, a **backend
deep-audit hardening pass (2026-07-14/15)** fixed **47 verified findings** (0 crit / 10
high / 24 med / 13 low) from a 24-auditor + adversarial-verify Workflow — one atomic
commit per finding on `Testing` (`c5516e5`→`abd0385`), local only, not tagged or pushed.
See the "Deep-audit hardening" bullet in the round summary and the 2026-07-15 `Journal.md`
entry. The product candidate is now Version **`0.1.13`**: changes must integrate and pass acceptance on
`Testing`, then the exact accepted commit promotes to the Stable `main` branch and receives
the immutable `v0.1.13` tag. Use `git log -1`, `VERSION`, and the latest `Journal.md` entry for the
exact current snapshot rather than an embedded HEAD hash. Round 9c (`559ce88`, PR
#27) is historical;
`feature/round7-ui-overhaul` (Rounds 7–8) merged via PR #23/#24, Round 9 via PR #25,
Round 9b via PR #26. Round 10 ("Autopilot & Comprehensive Ingestion + motion.dev")
flips the suite from "opt-in automation" to **comprehensive ingestion + smart-
autopilot defaults ON out of the box** — see the Round-10 bullet below.

**Release topology:** the remote now exposes canonical `Testing` and `main`, uses
`main` as its default, and has `v0.1.1` as the last verified installable Stable tag.
The immutable `v0.1.4` and `v0.1.5` tags are failed, non-installable publication
records. The immutable `v0.1.6` and `v0.1.7` tags are fully published and signed
artifact records, but their canonical bootstrap acceptance failed before a usable
supervisor was established: 0.1.6 at the macOS Bash 3.2 host path and 0.1.7 at the
Docker Desktop dropped-capability control-socket boundary. Both are superseded and
are not supported bootstrap sources. The immutable `v0.1.8` publication corrected
the control-socket boundary but canonical bootstrap failed when cosign 3 tried to
initialize its default TUF cache beneath the updater's read-only `/root`; it too is
bootstrap-blocked and superseded. The immutable `v0.1.9` tag passed exact-tag CI and
its release workflow built, pushed, signed, and anonymously read all three image
digests, but its capability-free supervisor could not traverse the runner's mode-0700
signed-plan fixture. The workflow therefore failed closed before attestations, GitHub
Release assets, Stable convenience tags, or documentation publication; `v0.1.9` is
historical and non-installable and must never be moved or reused. The immutable
`v0.1.10` tag passed protected source and exact-tag CI, but its release job timed
out while target emulation ran the architecture-neutral Web Console builder; no
complete signed artifact set, canonical plan assets, GitHub Release, Stable tags,
or Stable documentation were published. It is historical, non-installable, and
must never be moved or reused. The immutable `v0.1.11` tag passed all image and
signed-plan verification, including inside the constrained updater, but post-verification
fixture cleanup failed before attestations, canonical Release assets, Stable aliases,
or Stable documentation; it is historical, non-installable, and must never be moved
or reused. The immutable `v0.1.12` tag then passed protected source and exact-tag
CI, published the complete public signed release (all three dual-platform digest
images, attestations, canonical plan and bundle, GitHub Release, Stable aliases,
and Stable documentation), and verified anonymous reads and keyless signatures.
Canonical v0.1.1 bootstrap nevertheless failed closed before application mutation
because both legacy application images omit the state-schema label and the updater
compared one normalized absence with one raw absence. It is cryptographically valid
but bootstrap-blocked, superseded, and not a supported installation source.
`v0.1.13` is created only from the fully verified promoted 0.1.13 commit
and becomes installable only after its signed plan, public GitHub Release, anonymous
digest reads, and canonical runtime acceptance pass. Version 0.1.13 changes no state schema, updater protocol, publisher
identity, process privilege, or frozen-base bytes. Repository-level branch
protection, required-check, and `github-pages` environment policy remain administrator
controls and must be verified independently of source changes.

**Current baseline (2026-08-05):** backend **2,306 pytest** passed (0 failures);
webui **1,935/1,935 Vitest** specs / 286 files with zero stderr or captured console output,
full docs+app build clean (3,189 modules;
motion remains lazy and off the entry path); eslint **0 errors, 0 warnings**; **zero new webui runtime
deps except the deliberate lazy `motion`** (12.42.2). Version 0.1 adds only the
explicitly pinned connector/SQL packaging dependencies required by its advertised
`full` image; the `core` image remains available. `engine/case_manager.py` `decide()` stays **byte-identical** to
the pre-Round-5 baseline `27f0983`; `engine/risk.py` / `engine/signatures.py`
**untouched** by Round 10 (the new risk gate is routing-only, #3); every round's
router/Settings decomposition kept all API paths byte-identical. The 12
non-negotiables (§5) held through every round — **#10 "sane defaults" now explicitly
means smart-autopilot-ON by default** (see §5, item 10). Test counts rise each
round — treat the figures above as the current verified snapshot and check
`Journal.md` for the current one before citing a different number.

### Round-by-round summary

Full prose detail for every round lives in `CHANGELOG.md` (append-only) and
`Journal.md` (append-only); design rationale for a round lives in its
`docs/research/2026-0X-roundN/` folder where one exists. This is a pointer index, not
a retelling — do not re-derive round detail from here.

- **Rounds 1–2** — the vendor-agnostic pivot (OCSF canonical schema, connector SPI,
  SQL `StateStore`, Wazuh, the standalone webui) + the 7-wave SOC overhaul (multi-user
  RBAC/OOBE, MFA/SSO, case status+disposition taxonomy, pluggable notifications,
  multi-source Auto-Correlate, threshold automation + threat-context, consolidated
  Settings) + Round 2 (account self-service, sessions + token policy, Settings-centric
  IA, Demo Mode, per-feed sources, Resend/SES + templates, per-user customization,
  command palette / global search / bulk actions / audit viewer). See `CHANGELOG.md`
  ("Waves 1–7", "Round 2") + `docs/research/2026-06-overhaul/` +
  `docs/research/2026-06-round2/`.
- **Round 3** (`bffe4b8`→`3610147`) — 12 requests: expandable nav, richer Settings,
  deeper branding/material, per-case human+AI collaboration, a posture dashboard +
  MITRE coverage, fine-grained custom-role RBAC, **+17 new enrichment providers (19
  total)**, in-app notifications, a standardized Models page, a forward-looking
  Standup, clearer cases + a ReAct trace timeline — plus a shipped security fix (RAG
  fencing inverted to a TRUSTED allowlist: `runbook`/`mitre`/`suppression` only,
  imported docs stay UNTRUSTED-fenced, OWASP LLM01). `docs/research/2026-06-round3/`.
- **Round 4** (`068ede4`→`1df27ac`) — "fix the logic, fine-tune the product": 3
  confirmed bugs fixed (single-source poller → `poller_manager.py` now fans out over
  every enabled PULL source; `Codex-opus-4-8` mispriced $15/$75 → corrected $5/$25 +
  cache/batch pricing applied; `acknowledge` now sets `INVESTIGATING`) + 12 requests
  (two-tier ALERT/EVENT ingestion, adaptive threshold auto-tuning, daily campaign
  correlation, entity baselining, LLM batch/flex pricing, a unified log view, tiered
  reset + fresh OOBE, login white-label). A 16-dimension audit found 16 confirmed
  issues, all fixed. `docs/research/2026-07-round4/`.
- **Round 5** (`5ab7c05`→`05552c7`) — "UI/UX overhaul + rules customization + custom
  dashboards + loose coupling": 9 goals G1–G9 — a cohesive measured-WCAG-AA color
  system (G1), ONE shadcn/Radix/Tailwind design standard (G2), a decluttered
  data-driven Settings (G3, 2673→575 LOC, 6→5 nav groups), a wide-real-estate
  dashboard (G4) with a compact ~52 px header (G5), a **Detection & Rules** editor
  with a version ledger + a pure-what-if preview that never bills the LLM (G6),
  **custom per-user dashboards** (G7), a single `FEATURES[]` registry + restored code
  splitting (G8, entry 537→264 kB), and an accessibility pass + 16-dimension audit
  (G9, 9 must-fix resolved). `docs/research/2026-07-round5/`.
- **Round 6** (one commit, 2026-07-02) — "fleet glitch-hunt + integration polish": a
  ~500-agent Opus fleet audited every webui file → 464 real findings, 423 fixed (47
  verified-not-real): custom-dashboard view-mode packing, `PageContainer` as the
  single width authority, the rules version ledger actually recording, one unified
  `SecretField` everywhere, WCAG-AA contrast fixes in both themes, an
  `AutomationNudge` beginner journey. `docs/research/2026-07-round6/`.
- **Round 7** (`850600f`→`7355a9a`, PR #23) — Overview became the **Security Command
  Center** (Active Risk Index + honest MTTA/MTTR/Dwell + live-delta KPIs); a
  durable-counter **Noise-Reduction** funnel (`GET /api/metrics/noise-reduction` +
  `stores/noise_counters.py`); a shared `source|ai|code` provenance tag; CaseDetail
  retold 8→5 tabs as a story ending in the pinned deterministic `DecisionCard`.
  `docs/research/2026-07-round7/`.
- **Round 8** (`58745fa`→`91aae40`, PR #24) — UI cleanup + glitch fixes: the risk
  index in its own card, the Cases sticky-header double-nested-overflow bug fixed, a
  horizontal QRadar-style Sankey ribbon for Noise-Reduction (superseded twice since —
  see Round 9/9b below), a de-carded plain header, reinvestigate rebuilding from
  stored evidence when the log window aged out. `docs/research/2026-07-round8/`.
- **Round 9** (`709e758`→`26c4266`, PR #25, 2026-07-05) — an 11-ask UI/UX overhaul:
  removed the redundant in-page tab strips that duplicated the left nav; Overview
  dropped LLM Spend from the hero (→5 alert/case KPIs) with a bigger Active Risk Index
  card; Noise-Reduction redesigned to horizontal aligned stage bars (a Sankey is wrong
  for a linear reduction); **Sources** rebuilt as a QRadar-style "Log Source
  Management" DataTable; CaseDetail's Investigation tab split into **Timeline**
  (what-happened + trace) and Investigation; Login/Wizard jank fixed; a **local /
  self-hosted LiteLLM (OpenAI-compatible) model provider** shipped
  (`POST/DELETE /api/llm/models/custom`, `POST /api/llm/providers/test`, $0 pricing,
  `litellm_api_key` secret). Also fixed a pre-existing bug: `POST /api/sources`
  dropped `configured_secrets`/`created_at` on every toggle/bulk/make-primary (now
  carried forward, regression-tested). No `docs/research/` folder (done
  efficiency-first) — see `Journal.md`'s 2026-07-05 Round-9 entry + git log
  `709e758..26c4266`.
- **Round 9b** (`71153f2`→`b0d8747`, PR #26, 2026-07-05 later) — hover-to-expand
  sidebar; Noise-Reduction reverted flat-bars→ribbon (prettier, per-stage hover
  detail); CaseDetail redesign (Timeline = "what happened" only; Investigation = AI
  assessment + pinned `DecisionCard` + full trace); Sheet widened to
  `max-w-[min(98vw,1400px)]` + "Open in new tab"; Overview → a Decision-Brief hero +
  a SOURCE SAYS/AGENT FOUND/CODE DECIDED provenance row. No research folder — see
  `Journal.md`'s Round-9b entry.
- **Round 9c** (`20118a7`→`2cc94c5`, PR #27, 2026-07-06, historical) — the dashboard
  rebuilt from scratch (Prisma/XSIAM-style); real **MTTD** (`Case.first_seen_millis` →
  case creation) and first-human-response from the **ACK/MTTA clock** (NOT dwell — a
  same-round bug caught and fixed so an AI auto-close is never counted as a human
  response); a burndown chart; noise-counters gained a terminal "closed by human"
  stage; the Cases list rebuilt (6-tile summary strip, monogram Assignee column). No
  research folder — see `Journal.md`'s Round-9c entry.
- **Round 10** (2026-07-09, committed to `Testing`) —
  "Autopilot & Comprehensive Ingestion + motion.dev": a **behavior change** — the
  suite now reads+reasons over everything and observes/recommends tuning **by default**;
  tuning writes are review-first unless confirmed-evidence auto-apply is explicitly enabled.
  **Comprehensive ingestion** — `background_scan_enabled` default TRUE; every event
  from every source is correlated + risk-scored + made visible; EVENTS-role clusters
  auto-forward to investigation via a deterministic risk gate at
  `risk_score >= auto_investigate_risk_floor` (default 70; below-floor stays a $0
  candidate, never dropped, #4); ALERTS-role feeds bypass the gate and correlate
  `mode=EVERY`; one concurrency-safe global per-tick budget
  (`caps.max_auto_investigations_per_tick=25`) is shared across concurrent pull sources
  in the manager fan-out; each direct push batch enforces the same configured cap
  locally. Cap-deferred candidates drain on later ticks and investigations remain
  sequential within each handler; the daily budget is the GLOBAL spend bound. **Autopilot smart
  defaults** (default-ON, $0/#3-safe) — threshold tuning (shadow-eval forced on),
  campaigns, cross-source correlation, SLA policy, priority matrix, realtime SSE, the
  threshold-automation engine (empty rule set), baseline (producer + a new
  silent-source detector); a new `Preferences.autopilot_profile` dial
  (conservative/balanced/aggressive, default balanced) scales risk-floor/daily-budget/
  cap together; batch, warning-only budget mode, and default notify/playbook rules stay
  opt-in. **Default budget backstop** — `BudgetConfig` is enabled by default
  ($10/day, 80% soft-warn, `on_exceed="block"`; an over-budget call routes to
  NEEDS_HUMAN, never closes, #3). **Migration** — a stored pre-overhaul config
  auto-adopts the new ON defaults behind an `autopilot_config_version` marker + a
  one-time banner; the `AutomationNudge` inverted into an "autopilot is on — here's
  what it's doing" reassurance card; pre-existing explicit opt-outs preserved.
  **Coverage observability** — a per-source last-poll snapshot + a new
  `GET /api/sources/coverage` rollup + `AuditDoc.source_id` filtering + a Sources
  coverage banner/Overview tile/Noise-Reduction "awaiting" stage. **motion.dev** —
  ONE new lazy runtime dep (`motion` 12.42.2, replacing the Round-5-removed
  `framer-motion`) behind `LazyMotion`/`domAnimation`, landing in an ~83.85 kB lazy
  chunk (entry stays 281.44 kB), animating route transitions, CaseDetail tabs, Cases
  bulk-bar/row reflow, the nav rail, and KPI count-ups — reduced-motion honored.
  Built research(vendor+standards) → code (5 batches) → adversarial verify (5 major +
  6 minor found) → fix (all) → re-verify. No research folder (efficiency-first) — see
  `Journal.md`'s Round-10 entry.
- **Deep-audit hardening** (`c5516e5`→`abd0385`, 2026-07-14/15, on `Testing`, local/not
  pushed) — a 24-subsystem-auditor Workflow over the whole backend (~200 files) with
  every finding adversarially re-verified → **47 fixes, one atomic commit each** (no
  co-author). Clusters: `#9` fence provenance-label injection; authZ on setup-secrets /
  investigate / overview / chat / case-thread edit-delete; OIDC browser-bound state +
  verified-email linking; KV lost-update CAS (`kv_mutate` + real `put_if`); durable
  object-store/Kinesis cursors; non-PIT pagination cap; poller no-duplicate-closed-cluster
  + drain fairness; MTTA human-ack-only; timestamp/ModSec/severity-scale/batch-cache
  correctness; SSE + cache + rate-limit + lock-registry bounds. **#3 verified clean —
  `decide()` untouched.** Green: 1942 pytest / webui 1349 Vitest unchanged. See the
  2026-07-15 `Journal.md` entry + the matching `CHANGELOG.md` Development snapshot.

**Auth is DEFAULT OFF** (`Secrets.auth_enabled`) so the no-auth profile and the
offline test suite keep working unchanged; `TLSOC_AUTH_ENABLED=true` turns on the
full built RBAC/MFA/SSO/session stack and seeds **Admin / Admin@123** (change it
immediately for any real deployment).

**Remaining work / backlog:** see `ROADMAP.md` for the live tracker. Known open items:
the opt-in row-level data-scope hook (`can_object()`, shipped OFF), the OCSF
classification/observables surfacing + a 1.4→1.8 version bump, ARQ workers + KEDA
scale-out + a Helm chart + OTEL/Grafana (Epoch E — see
`docs/AGNOSTIC_ARCHITECTURE.md`), and native Splunk / Sentinel / QRadar / Chronicle /
CrowdStrike / SentinelOne / Defender pull connectors (reserved in the `SourceType`
enum, not yet built).

Every item ends with: `pytest -q` green (keep the count current), `webui` build
clean, docs updated, and **Journal updated**. Commit or publish only when the user
or maintainer has intentionally authorized publication.

---

## Journal entry format (copy into Journal.md)

```
### YYYY-MM-DD HH:MMZ — <agent/role> — <short title>
- Context: <what you set out to do / which roadmap item>
- Did: <concrete changes: files, endpoints, decisions>
- Tests: <pytest/tsc/build results>
- Status: <done | in-progress | blocked: why>
- Next: <handoff for the next agent>
```
