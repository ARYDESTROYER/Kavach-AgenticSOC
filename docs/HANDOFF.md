# Developer & Agent Handoff — START HERE

> **If you are a new chat session or a developer picking this up cold, read this file first,
> then [`AGENTS.md`](../AGENTS.md) (the canonical rulebook).** `CLAUDE.md` is only a
> forwarding entry point so Claude and Codex load the same instructions. This is the single
> source of truth for *where we are*, *how to run it*, *what's done*, and *what's next*.
> Everything in here is verified against the repo as of the date below — not from memory.

- **Repo:** `ARYDESTROYER/Agentic-Kibana`  ·  **Integration target:** `Testing`  ·  **Date:** 2026-08-13
- **Status:** Round 10 and the additive Cyber Defence Center (the landing dashboard,
  renamed from Security Command Center) / Case Manager work are
  integrated on `Testing`. A **backend deep-audit hardening pass
  (2026-07-14/15)** fixed **47 verified findings** (0 crit / 10 high / 24 med / 13 low)
  from a 24-auditor + adversarial-verify Workflow — **one atomic commit per finding, no
  co-author**, on `Testing` (`c5516e5`→`abd0385`).
  The current source version is **`0.1.13`**. It is a Stable patch candidate on
  `Testing` and a Stable release only when the exact accepted `main` commit has the
  immutable `v0.1.13` tag and matching artifacts. `Testing` is the permanent integration and
  acceptance branch; accepted changes are promoted through a pull request to the Stable
  `main` branch and re-verified there. The remote now uses `main` as its default, retains
  `Testing` for integration. The immutable `v0.1.13` tag is created only from the
  fully verified promoted commit. The immutable `v0.1.4` attempt passed exact-tag CI,
  Help Center assembly, and Pages publication but stopped before every release
  artifact; it has no GitHub Release, signed plan, signature, digest, or GHCR release
  image and is not installable. The immutable `v0.1.5` attempt built and signed
  candidate image digests but stopped in its anonymous multi-platform pull gate
  before the canonical plan, bundle, GitHub Release, or Stable tags; it is also not
  installable and must never be moved or reused. The immutable `v0.1.6` publication
  completed exact-tag CI, public signed images, plan, bundle, Release, and Help
  Center, but canonical macOS Bash 3.2 bootstrap acceptance failed before supervisor
  installation. The immutable `v0.1.7` publication completed exact-tag CI, public
  signed images, plan, bundle, Release, and Help Center, but canonical Docker Desktop
  acceptance failed when `cap_drop: ALL` denied the updater's unconditional control-
  socket ownership change. The immutable `v0.1.8` publication corrected that
  boundary, then canonical bootstrap failed during signed-plan verification because
  cosign 3 defaulted its TUF cache to `/root/.sigstore` beneath the updater's
  read-only root filesystem. The immutable `v0.1.9` publication corrected that
  trust-state boundary and built, signed, and anonymously proved all three images,
  but its constrained supervisor could not traverse the runner-owned verification
  directory. It published no GitHub Release or installable signed plan. Version
  0.1.10 carried that traversal correction through protected source and exact-tag CI,
  then its signed-release job timed out while the architecture-neutral Web Console
  builder ran under target emulation. It produced no complete three-image set,
  canonical signed plan, GitHub Release, Stable tags, or Stable Help Center and is
  immutable, superseded, and non-installable. Version 0.1.11 then passed protected
  source and exact-tag CI, built, signed, anonymously proved, and verified all three
  images and the canonical plan on the host and inside the constrained updater. Its
  post-verification cleanup trap failed before attestations, GitHub Release,
  canonical asset, Stable-tag, or Stable-documentation publication. It is immutable,
  superseded, and non-installable. Version 0.1.12 subsequently completed every
  protected source, exact-tag, signed-publication, public-image, attestation, Release,
  Stable-tag, and documentation gate. Canonical v0.1.1 acceptance then failed closed
  before application mutation because both legacy images omit the state-schema label
  and its supervisor compared one normalized absence with one raw absence. It is
  immutable, bootstrap-blocked, and superseded. Version 0.1.13 retains the writable
  updater-state trust cache and least-privilege verification assets, and moves only
  the Python documentation and Node application builder stages to BuildKit's native
  build platform; the final nginx runtime remains target-platform-specific. Its
  cleanup restores the runner-owned verification fixture to private mode only after
  the constrained verifier exits, then removes it. It symmetrically normalizes
  matching absent legacy schema labels while mixed labels and unmanaged later
  releases remain blocked. It changes
  no schema, updater protocol 1, publisher identity, process privilege, trust predicate,
  or frozen-base bytes. Version 0.1.13 is not installable until every signed-publication
  and canonical runtime acceptance gate passes. See
  `docs/releases/channels.md`. Repository administrators remain responsible for enforcing
  the documented branch and environment protections.
- **Current CI contract:** every candidate exposes eighteen independent quality lanes
  plus the fail-closed **CI passed** aggregate. In addition to the complete backend,
  Console, contract, design, package, and documentation checks, CI boots the supported
  PostgreSQL+pgvector/Redis state path, runs fail-closed workflow/ShellCheck and fatal
  Python static checks separately from deploy/updater contracts, and builds the
  shipping backend, Console/Help Center, and updater images without publishing them.
  Require **CI passed** on `Testing` and
  `main`; do not merge, tag, publish, skip, or soften a red/pending/cancelled lane.
- **Release identity and supervised updates:** the top-right badge always reads
  `v0.1.13 · Testing|Stable`; its popover reconciles build-time Console and public backend
  build-info. Any known version/channel/SHA mismatch downgrades to Testing. Local demo auto-
  derives Stable only on literal `main`; Docker release builds must stamp channel/SHA/date.
  The reference standalone PostgreSQL Compose deployment can install a compatible,
  immutable Stable release through a separately bootstrapped updater. The top bar exposes
  server-derived preflight, durable progress, planned reconnect, verification, and rollback
  state; it requires a built-in super-admin, a registered current session, recent reauth,
  verified backup capacity, and a signed digest-pinned release plan. The job creates
  and catalog-verifies the backup before application switching. Target pins remain a
  private pending handoff input until writer quiescence, verified backup, and the
  durable no-cancel switch boundary; only then are they published to the active host
  override. The supported Compose wrapper shares the updater lifecycle lock, keeps
  inspection available, and refuses mutations for the whole transaction. Startup
  removes a leftover marker only for an exact durable terminal job; unknown state
  fails closed. The browser and
  ordinary backend never receive the Docker socket, host commands, arbitrary artifact
  coordinates, or registry credentials. The supported canonical `v0.1.1` deployment
  requires one manual updater bootstrap to install the strictly newer signed 0.1.13
  release after its canonical Release, signature, and public images verify. A
  Testing/source-built 0.1.3 deployment, either non-installable 0.1.4/0.1.5
  publication attempt, or the published-but-
  bootstrap-blocked 0.1.6/0.1.7/0.1.8/0.1.12 artifact records, or failed-publication
  0.1.9/0.1.10/0.1.11 records must instead be reconciled
  according to their actual installed state; none can be relabelled Stable. An
  earlier failed bootstrap that left an inspectable idle older supervisor on an unchanged
  v0.1.1 application is repaired by the v0.1.13 bootstrap, which replaces the
  version-mismatched supervisor before signature verification. An already-running
  0.1.13 deployment cannot bootstrap itself from the same-version plan. Bootstrap
  safely reuses or replaces only inspectable idle supervisor state; an active/unreadable
  state fails closed. Bootstrap transfers
  lifecycle ownership before job submission and reuses a private per-release start key
  until the exact job is terminal, so client interruption cannot restore pins behind
  the supervisor. The updater does not
  transport the base Compose file. Its self-replacement helper is restartable and its
  name-swap transaction is idempotent across ordinary helper, Docker-daemon, and host
  restarts; loss of the trusted host or Docker metadata/storage remains manual. SQLite,
  Elasticsearch-owned state, legacy merged ELK, Kubernetes,
  customized Compose, missing durable secrets, or unsupported migrations fail closed as
  manual upgrade required. PostgreSQL and Redis infrastructure stay operator-managed.
  The existing same-origin coherent-pair check remains only as an activation fallback when
  an external deployment already installed both application components.
  A separate amber source notice may come from the cached, authenticated
  `/api/releases/upstream` observation. Fresh preferences watch the public Agentic SOC
  repository at Stable `main` and Testing `Testing`; forks can change that repository
  and either branch in Settings. Stable branch HEAD is review metadata; an update
  candidate uses the immutable commit from the exact annotated `vVERSION` tag. This
  observation suppresses downgrades,
  and cannot authorize installation or change the updater's host-pinned trust policy.
- **Current durable-work contract:** long-running case bulk work, Data export,
  precedent bootstrap, Runbook reindex, Knowledge import, tiered reset, and Storage
  apply submit to one strict-CAS application-job registry. The in-process runner uses
  renewable five-minute leases, rechecks authority, publishes actor-scoped Inbox/SSE
  progress with polling fallback, and supports cooperative cancellation, restart
  recovery, bounded failures, terminal compaction, and verified persistent ZIP
  artifacts. The unified **Analytics → Jobs** surface always shows self-scoped
  application work; `models:read` adds related LLM Batch rows and `automation:read`
  adds list-only worker health for threshold tuning, campaign correlation, Batch, and
  the event-driven `baseline_producer` (`cadence=on_ingest`; independent of the
  cadence-loop runtime flag). Newly accepted local LLM Batch rows freeze a strict,
  generation-bound audience of at most 200 active effective-`models:read` recipients and
  reconcile one stable safe Inbox row per recipient. Strict audience-store outages stay
  pending/retryable; permission or account-generation loss revokes/fail-closed filters
  the note. Later grants/users and legacy rows without a snapshot remain list-only. The
  audience/outbox path is regression-backed across strict-store outage, permission loss,
  account deletion/recreation, stable retry, and factory-reset fencing. CAS job claims do not remove
  the application-wide single-replica boundary: investigation/export concurrency,
  receivers, schedulers, and realtime delivery retain process-local authorities.
  Factory reset leaves only a privileged actorless sanitized system receipt in the
  replaced registry. In the supported single-backend-process profile it closes and
  drains HTTP mutation admission and SSE, quiesces tenant producers and detached writers,
  strictly clears tenant KV/cases/cursors/RAG/usage/audit plus runtime overlays, and
  releases its durable fences only after the new receipt lineage is audited. A factory
  privacy-boundary failure keeps the application fenced/degraded, blocks ordinary work,
  and admits only a new freshly authorized factory retry. Submission/retry and cancel
  `202` responses, plus terminal Inbox/SSE projection, wait for their transition audit;
  durable reconciliation repairs audit gaps before projection. The updater's
  private supervisor jobs are separate and unchanged. See
  `docs/operations/background-jobs.md`.
- **Long-operation compatibility boundary:** Console/user workflows use
  `POST /api/jobs`. Direct archive/segment export, precedent bootstrap, RAG import, and
  full-catalog Runbook reindex remain executable, explicitly OpenAPI-deprecated,
  request-bound compatibility primitives; targeted Runbook reindex remains direct.
  Direct reset and Storage apply mutations are different: they return 410 and have no
  synchronous bypass.
- **Dashboard integrity contract:** Overview posture values are keyed to the selected
  range/comparison, superseded requests abort, response windows are validated, and old
  posture data is hidden during a range transition. False Positive Rate and
  Auto-resolved therefore cannot repaint from an older request. Full Agent health now
  lives above **Analytics → Effectiveness** and follows its 24h/7d/30d range; Overview
  consumes the same reducer but renders only a degradation warning, with a stable
  `#/metrics?tab=effectiveness` drill-through. Healthy/unauthorized states cost no
  Overview space, while unknown evidence stays distinct from healthy.
- **Current Console contract:** the shared rail and route-loading states follow
  `docs/development/ui-standard.md`; `webui/src/design-system/` now exposes the one
  centered loading grammar, original source marks, and a serializable catalog for
  future tooling (not a shipped MCP server). Automated Scans is a hidden compatibility route,
  the targeted Workspace job is **Entity investigation**, Settings uses the flat
  searchable command-center frame, and the bottom Documentation utility opens the
  same-origin, version-matched Help Center at `/docs/<major.minor>/`. Installed docs
  are authoritative for that build; Latest Stable/GitHub are secondary upgrade or
  source views, and Development remains preview-only. First run uses the same flat
  Console grammar in a responsive four-stage setup workspace: **Workspace → Data
  sources → AI runtime → Review & launch**. It guards source/key drafts, reports
  limited readiness honestly, and fails closed with Retry when setup status is
  unavailable; Settings re-runs end with **Apply changes** rather than resetting the
  deployment. Workspace Chat now follows the same flat Console grammar with a
  searchable desktop history rail, mobile History Sheet, top-aligned transcript, one
  live thread status, one bottom composer, consolidated **Evidence & execution**, and
  restore/error states that preserve the workspace instead of replacing it. It keeps
  an unsent draft per visited thread, refreshes history on focus, treats history access
  failures as failures rather than an empty account, and marks bounded history as
  incomplete when older material has been removed.
- **Intelligence** now exposes five direct jobs: **Knowledge corpus**, **Reference
  runbooks**, **Operator memory**, **Response playbooks**, and **Agent personas**.
  Analysts can
  search and open protected bundled references, while authorized managers can create,
  edit, delete, and reindex durable operator Markdown. Full guidance is chunked into
  stable per-runbook RAG documents, optimistic revisions reject stale writes, and
  targeted reconciliation preserves imported knowledge, MITRE guidance, suppression
  guidance, and resolved-case memory. Runbooks remain reference knowledge only;
  Playbooks are the separate selected procedure layer and deterministic case policy is
  still the sole close/escalate authority.
- **Intelligence evidence contract:** the threshold tuner observes by default but
  learns only from independently analyst-confirmed outcomes and sends eligible writes
  to Approvals by default; confirmed-evidence auto-apply is an explicit opt-in and
  suppression always requires approval. Agent-authored memory starts pending and is
  fenced until an authorized human approves it. Resolved-case RAG excludes inferred
  model-only/auto-close outcomes, RAG source toggles reconcile their managed projections,
  and embedding changes validate capability/dimension before replacing a vector space.
  Operator Playbooks are durable strict-CAS StateStore records layered over immutable
  bundled procedures, with deterministic dry-run and bounded coverage reporting.
  `/api/schedulers/health` reports process-local worker state. Telemetry-source advice
  accepts only versioned query/tool evidence—never merely an absent connector—and the
  current release reports capture unavailable until that controlled producer exists.
- **Build and retrieval evidence contract:** newly created cases preserve immutable
  creation-build `app_version`/`build_sha`, while each new append-only audit and usage
  row preserves its first append-build. Legacy provenance values remain `null` with no
  backfill.
  `retrieval_history_status` is the authoritative Case lifetime marker and legacy cases
  remain `unavailable`. `knowledge_used` keeps its array wire shape, while
  `retrieval_observation_status` alone makes `[]` a measured empty result; skipped,
  failed, partial, or historically unavailable retrieval is not converted to zero.
  Fail-soft last-known-good/partial context may still be consulted without qualifying as
  a measured observation. Base metrics expose case-level reference coverage only—not
  quality or per-run hit rate—and keep incomplete-lifetime or truncated cohorts `null`.
  This is additive under `0.1.13`, needs no SQL migration, and does not auto-remap
  existing Elasticsearch templates or indices.
- **Current feature integration:** Cases is still the table-oriented list, but an
  opened row hands the exact case to the canonical Case Manager detail workspace;
  its desktop split is accessible and persisted. Case Manager Overview now
  conditionally summarizes the latest investigation run's actual inputs—operator
  memory consulted, RAG knowledge and runbook references retrieved, a playbook only
  when injected/consulted, and an immutable deterministic platform threshold-tuning
  snapshot—with details in Investigation. It never infers provenance from current
  feature settings, never calls threshold tuning model fine-tuning, and leaves final
  close/escalate routing to deterministic case policy. Overview defaults to
  visibility-aware LIVE refresh and has an expanded Noise Reduction view with a lazy,
  bounded redacted alert→cluster→case→outcome drill-down beneath the aggregate flow.
  Threat Context exposes a redacted persisted cluster-formation explanation. Demo
  Mode has five sources including Entra ID. The API also provides audited,
  permission-gated portable analysis export with actor/scope/snapshot-bound signed
  continuations; its Intelligence scope carries exact catalog counts, sanitized
  operator runbook/playbook source, and safe bundled references. It also provides
  guarded default-preference OpenAI
  Flex for supported live case/alert work, with truthful standard fallback. Fresh
  workspaces now assign the bundled OpenAI model ID `gpt-5.6-luna` to router, investigator,
  formatter, standup, Workspace chat, and overview; embeddings remain on
  `text-embedding-3-small`, while persisted assignments and alternate providers stay
  authoritative. The release catalog configures the short-context Luna Standard rate
  at $0.20/M input, $0.02/M cached input, and $1.20/M output; Batch/Flex is recorded
  only from provider-confirmed execution and applies the configured half-rate. Cost now
  reports the execution tier actually recorded by the gateway in fixed Standard,
  Flex, Batch, and Unconfirmed buckets; it never infers that a standard row was a
  Flex fallback when the ledger cannot prove that history. Storage
  & retention now records a deletion-free 180-day Hot + 90-day Warm desired policy;
  explicit preview/apply can enforce only append-only Elasticsearch audit/usage ILM,
  while Glacier stays unconfigured pending an independent verified archive path. Workspace
  Chat conversations are now bounded, per-user partitions in the selected StateStore:
  newest-first list/detail/rename/delete are additive to the existing chat route, and a
  draft becomes saved only after its first response is durably committed. Stable
  `idempotency_key` retries return the one committed turn without a duplicate model bill;
  explicit source selection fails closed, and every saved assistant turn records its
  effective source/model. Legacy shared history is lazily migrated through a
  backward-compatible read path, with no operator reset. Saved server history is
  authoritative on resume. Case Manager chat remains case-scoped and never enters
  personal Workspace history; browser-only chats from before this feature cannot be
  recovered. **Analytics → Agent effectiveness** (reload-safe at
  `#/metrics?tab=effectiveness`) renders the additive
  `GET /api/metrics/agent-improvement` report. It compares the last seven complete UTC days with the
  preceding 28 using weighted analyst-reported agreement, material correction rate,
  and human review turnaround, while exposing two-sided cohort coverage, truncation,
  and evaluable fixed-horizon safety guardrails. It returns no synthetic composite,
  source/case identifiers, raw evidence, or model calls, makes no causal "learning"
  claim, and explicitly shows collecting/insufficient/unavailable states rather than
  turning missing evidence into zero. Agreement and correction form one
  graded-case quality domain rather than two independent headline votes; improvement
  also requires the separate review-turnaround domain to improve. Auto-tuning reuses
  this contract in a dedicated **Outcomes** tab beside its default **Operations** and
  **Policy & history** workspaces; its separate `metrics:view` load cannot block
  tuning controls, and **View full evidence** opens the canonical Analytics
  effectiveness tab. The Outcomes view plots one selected metric at a time and keeps
  tuning changes in a non-causal disclosure. The report now also carries a separate
  outcome layer: recorded case-linked AI processing cost; observed case-open-to-close
  elapsed-time difference between agent-terminal and human-terminal cohorts (not active
  labor or a human-only benchmark); confirmed-positive rate among outcome-graded cases;
  durable ingested-versus-after-clustering volume; and applied-tuning context with
  `causal_claim=false`. It exposes true 7-day versus prior-7-day and rolling-28-day
  versus prior-28-day trends without calling the latter a calendar month. A
  true-positive/raw-alert yield is explicitly unavailable because cases and alerts are
  different units. That aggregate report still returns source guidance as unavailable;
  separately, Auto-tuning can aggregate a deliberately narrow v1 set of query-proven
  telemetry gaps (outbound DNS, endpoint process, or identity-authentication evidence).
  Missing connectors and free-form model prose never create a recommendation.
  Every missing or undersized cohort remains insufficient/unavailable rather than zero.
  Operations groups recommendations by rule, separates **Collecting**, **Within
  target**, and **Needs attention**, and replaces the wide rules table with a
  searchable diagnosis-first list plus contextual inspector. Every attention row now
  states the evidence minimum, conservative estimate, policy gap in percentage points,
  recommended action, expected effect, and replay status before supporting statistics.
  Processing is represented at its real rule scope: eligible bounded changes are
  rechecked and routed to Approvals by default, while Policy & history shows policy
  before the append-only ledger. An authorized operator can explicitly enable
  `auto_apply_confirmed`, but only independently confirmed evidence that passes the
  sample and shadow gates qualifies; suppression remains approval-only. These are Console
  changes only; deterministic tuning and `decide()` authority remain unchanged.
- **Verification:** the latest fully recorded suites are green; the exact frozen
  acceptance receipt is in `docs/development/testing.md` and the latest `Journal.md`
  milestone. Production build, lint/design gates, packaging, version, Compose, and strict docs
  checks passing. Read the latest `Journal.md` entry, the active `CHANGELOG.md`
  `[Unreleased]` section, and the dated Development snapshots for command-level
  evidence + the finding list. The
  deterministic `decide()` authority was verified clean by the audit and remains untouched;
  the 12 non-negotiables remain mandatory.

---

## 1. What this is (30-second orientation)

**Agentic SOC** is a vendor-agnostic agentic SOC triage system: it ingests
security alerts from pluggable sources, normalises to OCSF, correlates + risk-scores
deterministically, runs a two-tier LLM investigation, and turns the result into audited,
cost-metered, human-reviewable **cases** — with a deterministic close/escalate policy that an LLM
can never override.

- **Backend** (`backend/`) — FastAPI + LangGraph. All agentic logic, connectors, auth/RBAC/MFA/SSO,
  sessions, notifications, demo mode, stores. Python stdlib-first (zero heavy deps).
- **WebUI** (`webui/`) — the **primary** surface: Vite + React + **Tailwind + shadcn/radix**
  (NOTE: the old `@elastic/eui` UI is retired — do not reintroduce it). Talks to the backend via an
  `/api` proxy.
- **Kibana plugin** (`archive/kibana-plugin/`) — **archived**; not built/shipped. Ignore unless reviving.

---

## 2. Quick start (verified commands)

### Backend tests (offline; fake ES + mock LLM; must stay green)
```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt        # greenlet is pinned, so a fresh install is green
python -m pytest -q                         # latest recorded full run: 2,306 passed; see Journal.md
```

### WebUI build + tests + lint
```bash
cd webui
npm ci
npm run check:types # hard-fail API drift in CI with TLSOC_REQUIRE_TYPEGEN=1
npm run gates       # tokens, contrast, CVD, and raw-style regression guards
npm run test:strict # latest recorded full run: 1,935/1,935 passed / 286 files; CI-parity quiet-output gate
npm run lint -- --max-warnings=0
npm run build      # version-matched MkDocs Help Center + tsc --noEmit + Vite
npm run docs:check # verify the generated docs artifact matches VERSION
npm run build:app  # app-only typecheck + Vite when docs are intentionally unchanged
```
The docs wrapper first honors `TLSOC_DOCS_PYTHON`, then reuses a compatible existing
Python environment when available, and otherwise bootstraps the ignored
`.docs-venv/` from pinned `docs/requirements.txt`; a normal build does not require a
manual MkDocs install.

### Run the demo locally (the fastest way to SEE everything)
```bash
./scripts/run-demo.sh
# Preflights both ports, then starts the backend (:8088) + webui (:5173) on 127.0.0.1.
# AUTH is enabled. Open http://127.0.0.1:5173 and log in as Admin / Admin@123.
# The script completes local setup and enables the deterministic, isolated, $0 live
# five-source demo (Splunk, QRadar, Wazuh, syslog, Entra ID) with a forced mock LLM.
# Keys are unused until demo exit.
# Set DEMO_MODE=seeded for a static run.
# "Exit & clear" in Demo Mode reverts it.
```
- **Auth is default-OFF** for the library/tests (the no-auth profile stays the out-of-the-box
  default). Direct runs use `AUTH_ENABLED=true` (`run-demo.sh` exports it); Compose maps
  `TLSOC_AUTH_ENABLED=true` to that backend variable. When enabled and the user store is empty, the
  backend seeds **`Admin` / `Admin@123`** (super_admin). Change this for any real deployment
  (`backend/app/config.py` `auth_seed_admin_*`; see `SECURITY.md`).
- Full deploy (Docker) in `DEPLOY.md`; the guided product tour in `DEMO.md`.

---

## 3. Repo map (where to look)

```
backend/app/
  config.py        Secrets (env-only) + Preferences (UI-editable). EVERY new setting lands here.
  constants.py     enums (CaseStatus/Disposition, Verdict, UserRole, IndexRole incl. ignore, ...)
  models.py        Pydantic contracts (Case, User(+profile/MFA/SSO), Session, SavedView,
                   MemoryEntry with approved/pending review state, ...)
  api/routes.py    THE base FastAPI router (incl. /sources, /auth+/users, /sessions,
                   /account/me, /demo/*, /proposals, /settings/schema, `/chat`, and
                   per-user `/chat/conversations` list/detail/rename/delete).
                   api/deps.py =
                   auth/RBAC gates (+ custom-role union). **29 feature routers total**,
                   ALL auto-discovered at boot
                   (`main.py::discover_feature_routers()` walks `app.api.routes_*`, needs
                   only a top-level `router: APIRouter` — no manual registration):
                   Round 3 added 8: routes_metrics · routes_standup · routes_enrichment ·
                   routes_models · routes_inapp · routes_cases_collab · routes_triage ·
                   routes_roles
                   Round 4 added 6 more: routes_tuning · routes_campaigns · routes_baseline
                   · routes_batch · routes_reset · routes_setup — plus GET /api/logs
                   (unified scatter-gather), /api/cases/{id}/forwarding +
                   /api/sources/health in routes.py
                   Round 5 added routes_rules + routes_dashboards + POST /api/triage/
                   preview-decision (pure what-if over decide() — never bills the LLM) +
                   typed config endpoints (baseline/campaign/batch), and DECOMPOSED
                   routes.py into domain routers with byte-identical paths — including
                   **4 routers commonly missed in docs**: routes_notifications
                   (`/notifications/*`), routes_prefs (`/branding`, `/prefs/*`,
                   `/terminology`, `/views*`), routes_rag (`/rag/*`, `/memory*`),
                   routes_search (`/search`, `/audit`). None of those paths remain in
                   `routes.py`, and there is no `/branding/presets` endpoint. Current
                   integration adds routes_export (legacy bounded `POST
                   /api/admin/export`, default fresh-auth server-assembled single ZIP at
                   `/api/admin/export/archive`, plus advanced resumable
                   `/api/admin/export/segment` + `/cancel`, all under
                   `data_export:export`) + routes_storage (desired own-state lifecycle
                   and pure capability preview; direct apply returns 410 and canonical
                   fresh-auth Elasticsearch apply is a Job)
                   + routes_runbooks (durable runbook catalog/reconciliation) +
                   routes_releases (public source discovery) + routes_schedulers
                   (read-only threshold/campaign/Batch cadence-loop health plus
                   event-driven baseline-producer health) + routes_telemetry (query-backed telemetry
                   gaps; connector absence is never evidence) + routes_diagnostics
                   (read-only precedent/migration/auto-close health) + routes_jobs
                   (self-scoped application job submit/list/detail/cancel/artifact plus
                   permission-scoped LLM Batch and scheduler projections; bounded,
                   generation-bound new-Batch Inbox outbox). Direct reset mutation also
                   returns 410; canonical tiered reset is a Job.
  auth/            passwords (PBKDF2) · tokens (stdlib HS256 JWT, sid/tv claims) · service ·
                   mfa (RFC-6238 TOTP) · oidc (SSO code-exchange)
  rbac/policy.py   the role->resource->action permission matrix + can()
  stores/          backend-agnostic KV-doc stores: users · sessions · user_prefs · memory
                   (strict-CAS; only approved active entries become trusted context) ·
                   chat_conversations (bounded, idempotent, per-user-partitioned Workspace
                   transcripts + lazy migration from the legacy shared document) ·
                   cases/usage/config/cursor · proposals · runbooks · playbooks
                   (strict-CAS durable operator catalogs) · sql/ (SQLite/Postgres) +
                   Round-3: case_thread/case_activity/case_tasks · inbox · notif_prefs ·
                   custom_roles · price_overlay · shift_handoff +
                   Round-4: tuning · campaigns (full-set active reconciliation + durable
                   success anchor) · baseline · batch_jobs +
                   Round-5: dashboards (per-user custom-dashboard layouts) · rule_versions
                   (detection-rule version ledger + rollback) — NO new index/table needed
  notifications/   channel SPI · email (SMTP+SES) · resend · webhook/slack/teams · templates · dispatch ·
                   InAppChannel (Round 3 — fan-out to InboxStore, no network) · jobs
                   (one strict-CAS bounded registry, renewable leases, intent
                   idempotency, bounded failures, terminal compaction, sanitized
                   factory receipt; no new index/table)
  enrichment/      Round 3 — EnrichmentProvider SPI: base/registry/dispatch/aggregate +
                   providers/ (38 registered classes: +17 in Round 3 — abuseipdb/virustotal/
                   greynoise/shodan(+internetdb)/censys/binaryedge/ipinfo/otx/pulsedive/spur/
                   xforce/urlscan/hibp/projecthoneypot/abusech[urlhaus+threatfox+malwarebazaar=3]/rdap —
                   +19 in Round 11: keyless circl_hashlookup/dshield/onionoo [default-on] +
                   spamhaus/cymru_mhr/robtex/crt_sh [default-off]; keyed crowdsec/
                   google_safebrowsing/ipqualityscore/ipdata/apivoid/maltiverse/securitytrails/
                   criminalip/netlas/hybrid_analysis/metadefender/emailrep; manifests carry
                   setup_steps + example rendered by the Settings provider cards)
  realtime.py      Round 3 — multiplexed SSE EventBus (GET /api/events, default ON, polling fallback)
  connectors/      SPI + registry · elastic/opensearch/wazuh · demo.py · receivers/
  engine/          correlation · risk · case_manager (decide()/apply() — #3) · case_id · poller ·
                   poller_manager (Round-4 — fans out over EVERY enabled PULL source) · ingest ·
                   metrics (+ Round-3 posture + evidence-qualified case-level knowledge-reference
                   coverage; unavailable lifetime history/truncation stay null,
                   not-measured cases stay out of the denominator) · mitre_coverage ·
                   shift_report · priority ·
                   budget (BudgetGate) · threshold_automation · threat_context · mitre · demo_generator/runtime +
                   Round-4: threshold_tuner (nightly deterministic observer, default ON;
                   analyst-confirmed evidence only and review-first writes) · campaigns
                   (cadence-enforced, full-set reconciled shared-entity graph) · baseline
                   (online EWMA/EWMV entity baseline) ·
                   event_detection (EVENT-feed batched agent-driven detection funnel) ·
                   forwarding (explain_forwarding) · reset (tiered danger-zone reset) ·
                   storage_lifecycle (capability-aware append-only ledger ILM; no deletion) ·
                   jobs (in-process durable runner, actor-scoped Inbox/SSE, cooperative
                   cancellation, restart recovery, verified ZIP artifacts) ·
                   investigation_gate (process-local ingest-priority concurrency) ·
                   agent_improvement (pure aggregate complete-day quality headline +
                   additive cost/closure/outcome/volume trends; reporting only)
  agents/          router · investigator · formatter · chat · standup · overview · personas · pipeline
  threat/          bundled compact MITRE ATT&CK technique map (+ refresh script)
webui/src/
  soc/pages/       Login, Cases (Round-9c: 6-tile summary strip + monogram Assignee column),
                   CaseManager (additive Active/All split-pane queue using the shared
                   CaseDetail orchestrator in embedded mode; reference-matched top-right
                   Share/Take Action/close controls; selection + permission-gated bulk work;
                   Acknowledge/Assign/Add tag/Set status/Set disposition/Reinvestigate/Resolve;
                   successes deselect, failures remain selected; accessible persisted
                   desktop queue resize; the Cases table hands opened rows to this
                   canonical detail workspace; operator contract in
                   `docs/analyst/case-manager.md`),
                   CaseDetail (Round-5 split from a 4210-line god-file into ~1529 LOC +
                   sub-components; **6 tabs**: overview | timeline | investigation | threat |
                   collab | chat — Round 9/9b split the old Investigation tab into a
                   "Timeline" [ONLY the what-happened narrative: input → correlate → Risk
                   Assigned → triage → investigate → Decision; current-weight reconstruction
                   from persisted factors with mismatch warning; Case Manager terminal marker
                   alone pulses] and "Investigation" [the AI's assessment +
                   the pinned deterministic `DecisionCard` + a collapsible full ReAct trace];
                   there is NO standalone "Why" tab or "Agent trace" tab — both live inside
                   Investigation),
                   Dashboards (Round-5 custom dashboards), Settings (Round-5 data-driven registry;
                   the 2673-line hub -> a section-registry + pages/settings/* files, 5 groups,
                   Security promoted to top-level), Account, Sessions, Users, Security, Audit,
                   Workspace(Chat with searchable desktop history rail/mobile Sheet,
                   durable per-user transcripts, and one docked composer + Entity
                   investigation), Analytics(Operational+Performance+Posture+
                   Effectiveness+Cost), Jobs (personal application jobs + permission-
                   scoped related LLM Batch and scheduler projections),
                   Home(Overview+Standup), Intelligence(Knowledge corpus+Reference
                   runbooks+Operator memory+Response playbooks+Agent personas),
                   Docs + a hidden legacy Scans compatibility route + Round-3 Models,
                   Roles, Inbox, ...
  soc/pages/settings/  Round-5 — one file per Settings section (general/security/models/detection/
                   cases/automation/enrichment/knowledge/keys/standup/storage/advanced/...) driven by
                   settings-sections.ts (the registry) — replaces the old god-file
  soc/rules/       Round-5 — Detection & Rules editor: DetectionRulesHome · RuleEditor (polymorphic
                   over the 3 tiers) · ConditionBuilder (flat) · lifecycle/ (Test/Preview + version
                   ledger) · adapter/api/types — Preview NEVER calls decide() and NEVER bills the LLM
  soc/dashboard/   Round-5 — custom dashboards: WidgetGrid/EditableGrid (LAZY react-grid-layout) ·
                   WidgetGallery/WidgetConfigSheet · registry (reuses existing tiles/charts) ·
                   DashboardBuilder/DashboardDataProvider
  soc/registry.tsx Round-5 — the SINGLE FEATURES[] registry that DERIVES nav + routes + the command
                   palette (one source of truth; useNavigate() replaced the onNavigate prop-drill)
  soc/hooks/       Round-5 — useAsync · useDirtyDraft · usePosture · useLiveAnnouncer (a11y) ·
                   usePrefersReducedMotion · useMediaQuery
  soc/components/  RiskGauge, QRCode, CommandPalette, SavedViewsBar, DataTable, NotificationsEditor,
                   SourceEditor (feeds), DemoIndicator, badges, charts, HelpTip + Round-3 NavSidebar,
                   NotificationBell, GlassSurface, SettingsGrid/Card, theme-tokens resolver,
                   MitreHeatmap/BurnDownChart, CaseThread, EnrichmentProvidersEditor, BrandingEditor +
                   Round-5 ~15 shared primitives (Field, SegmentedControl, ConfirmDialog, NumberField,
                   LabeledSlider, SecretField, TagInput, IconButton, PageContainer, TimeRangePicker,
                   DashboardGroup, collapsible, typography) + shared ComparisonMetric/
                   MetricDefinition evidence presentation, ...
  ui/              shadcn/radix primitives (button, dialog, command, table, ...)
  lib/             api.ts (client) · types.ts (keep in sync with backend models) · format · cn
```

---

## 4. The rules you must not break (the 12 non-negotiables)

Full text in `AGENTS.md` §5. The ones that bite hardest:
- **#3 — the deterministic decision.** `engine/case_manager.py` `decide()`/`apply()` decision logic
  is **byte-identical** and is the ONLY producer of CLOSED/auto-close. No LLM, playbook, automation,
  bulk action, or demo path may set a case's status/disposition outside `apply()` or the
  human analyst action path. There is a guard test (`test_wave6_decide_guard` / the bulk + automation
  tests) that fails if `decide()` changes or is bypassed. **Keep it byte-identical.**
- **#9 — untrusted fencing.** Any log/source/user-influenceable text (case fields, session UA/IP,
  display names, avatars, terminology, email vars, search results) renders as **plain text** and is
  **fenced** before any LLM prompt. Email templates auto-escape; `{{{raw}}}` is whitelisted to trusted keys only.
- **#10 — secrets.** Env/in-memory secret tier only; the UI shows `configured ✓` booleans, never values.
- **#1 read-only scoped log key**, **#2 append-only audit**, **#4 durable cursor (no skip/dup)**.

### Engineering conventions (how this codebase stays green)
- **Deps are added only by deliberate decision.** The backend stays **zero-new-runtime-dep**
  (stdlib-first) through all five rounds. The webui composes the already-installed
  radix/shadcn/recharts/lucide/cmdk; Round 5 added exactly ONE webui runtime dep
  (`react-grid-layout`, lazy-loaded only in dashboard edit-mode) and **removed `framer-motion`**
  (zero importers). New dev-only deps in Round 5: self-hosted fonts (`@fontsource-variable/inter`,
  `@fontsource/jetbrains-mono`), `@tailwindcss/container-queries`, `openapi-typescript` (type
  generation), and the a11y tooling (`eslint-plugin-jsx-a11y`, `jest-axe`/`@axe-core`). If you think
  you need a dep, look for an existing one first.
- **Additive + back-compatible.** New stores are KV-doc (no new index/table/migration). New model
  fields are defaulted so old persisted docs load unchanged.
- **eslint `react-hooks/rules-of-hooks` is enforced as an error** (`npm run lint`). All hooks go
  ABOVE any `if (loading) return ...` early return (this caused a real `#310` crash; it's now locked).
- **Auth gates are no-ops when auth is OFF**, so adding a `require_permission(...)` never regresses the
  default profile or the offline tests. **`test_route_auth_coverage.py` now fails CI if any non-GET
  `/api` route lacks an authZ gate** — add the gate when you add a state-changing route.
- **Keep `webui/src/lib/types.ts` in sync with the backend pydantic models.**

---

## 5. What's been built

### Round 1 (commits up to `3e55887`) — the agentic suite + first overhaul
RBAC/OOBE, MFA(TOTP)+SSO(OIDC), status+disposition taxonomy + customizable case-`XXXX` nomenclature +
case overview panel, pluggable notifications (email + slack/teams/webhook), multi-source
Auto-Correlate, playbook automation + threat-context + resolved-case knowledge loop, consolidated
Settings, UI cleanup. (See `CHANGELOG.md` "Waves 1–7" + `docs/research/2026-06-overhaul/`.)

### Round 2 (commits `9ab2954` → `3cd7eec`) — this session
| Commit | Wave | What |
|---|---|---|
| `9ab2954` | W1 | Bug fixes: RiskGauge (dasharray ring), MFA QR (ISO format-info) + clipboard, duplicate close X, chat framing, store-degraded tooltip |
| `317bd5a` | W2 | Login redesign (brand hero + aurora, OTP, SSO icons) + account self-service (profile/avatar/alt-email/timezone) |
| `88cb3c6` | W3 | Sessions registry + revocation + token policy (TTL/idle/absolute), admin terminate (±notify), user activity |
| `9eb7d57` | W4 | **Settings IA**: Account/Users/Security/SSO/Sessions folded under Settings; near-duplicate pages consolidated |
| `93ac735` | W5 | **Demo Mode**: reversible, isolated separate store, $0 mock LLM, hides real data, live-sim + historical spread |
| `2ada050` | W6 | Source **multi-feed**: events/alerts/**ignore** per-feed config + per-feed cursors (back-compatible) |
| `f0909af` | W7a | Email **Resend + SES** + stdlib template engine (5 preloaded, customizable) + preview |
| `36ff656` | W7b | **Customization**: UserPrefsStore + saved views + table columns + terminology + per-user theme (org↔user cascade) |
| `5869f13` | W7c | **Cmd-K command palette** + global search + **bulk case actions** + **audit-log viewer** |
| `aae7a76` | Final | 16-agent adversarial audit + docs refresh + 8 confirmed fixes (RBAC gates, poller isolation, gauge band) |
| `763ded9` | Remediation | Fixed confirmed HIGH/MEDIUM audit findings (+22 regression tests) — see §6 |

Design blueprints (read these before extending a feature): `docs/research/2026-06-round2/ROUND2_DESIGN.md`
(per-wave designs with file:line anchors), `ROUND2_BUGS.md`, `ROUND2_BEST_OF_BEST.md`, `ROUND2_AUDIT.md`,
`ROUND2_PLAN.md` (the live tracker + status log).

### Round 3 (commits `bffe4b8` → `3610147` + the live-wiring/security/docs wave) — "useful, distinctive, fine-grained"
12 user requests delivered across Waves 0–4 (additive, zero new deps, #3 byte-identical, the 12
non-negotiables held). Design: `docs/research/2026-06-round3/PROPOSAL.md`; what-shipped (per-wave
+ endpoints + commit chain): `docs/research/2026-06-round3/IMPLEMENTATION.md`.

| Commit | Wave | What |
|---|---|---|
| `bffe4b8` | W0 | Hot-file foundations: additive `Case` advisory axes + SLA datetimes, 11 model classes + 4 enums + 8 KV namespaces + 4 Preferences blocks + 13 optional `Secrets` provider slots; webui route code-split (`React.lazy` + manual chunks) |
| `59c2999` | W1 | Shared substrate: 8 KV stores · `EnrichmentProvider` SPI (`enrichment/`) · SSE `EventBus` (`realtime.py`, `GET /api/events` default-OFF) · RBAC resource split + custom-role/inheritance/DENY `effective_matrix()` |
| `2295363` | W2 | Backend features: posture metrics + MITRE coverage · shift report · +17 new enrichment providers (19 registered) + multi-indicator · models registry + `BudgetGate` · in-app channel · case collaboration · triage/priority · custom-role CRUD (8 `routes_*.py`) |
| `8b25ca2` | W2.5 | Gap-closure: cloud LLM providers first-class (Azure/Bedrock-SigV4/Vertex/OpenAI-compatible) · server-side custom-role enforcement · `conftest` network guard (offline enrichment tests) |
| `3610147` | W3 | Webui surfaces: hamburger `NavSidebar` + `NotificationBell` · Settings card-grid + `BrandingEditor` · Roles matrix editor · standalone **Models** page · Metrics tabs + MITRE heatmap · Standup attention queue · CaseDetail 4 chips + `TraceTimeline` + collaboration · Inbox · `EnrichmentProvidersEditor` |
| (this wave) | W4 + sec | Live SSE wiring + branding contrast + WCAG 2.2 polish; the **RAG-fencing TRUSTED-allowlist security fix** (operator-imported docs no longer reach the model unfenced — OWASP LLM01); docs sync |

### Round 4 (commits `3aeab6c` → `1df27ac`) — "fix the logic, fine-tune the product"
All **12 user requests + 3 confirmed bugs** delivered across 7 waves (additive, default-OFF,
**zero new deps**, `engine/case_manager.py` **byte-identical** throughout). Design +
what-shipped: `docs/research/2026-07-round4/`.

**The 3 bug fixes:**
1. **Single-source poller** — the poller only ever polled the primary source. NEW
   `engine/poller_manager.py` (`PollerManager` *is* `state.poller`) fans out over EVERY
   enabled PULL source, each on its own `{source.id}:{feed.id}` cursor (with a legacy-`"primary"`-
   cursor-collision guard) and a per-`cluster_signature` in-flight lock so concurrent sources
   never duplicate a case (#4).
2. **`claude-opus-4-8` mispriced** $15/$75 → corrected **$5/$25**; prompt-cache rates now
   applied (read 0.1×, write 1.25× 5m / 2× 1h) + batch 0.5×; wired the previously-dead
   `providers.with_retry()`.
3. **`acknowledge`** now transitions a case to `CaseStatus.INVESTIGATING` (was leaving it `None`).

**The 12 requests (new engine modules, all default-OFF):**
- **Adaptive threshold auto-tuning** — `engine/threshold_tuner.py` + `stores/tuning.py`: a
  nightly deterministic observer over independent analyst-confirmed outcomes (Wilson
  lower-bound + min-samples + EWMA + shadow-eval). Bounded `n` / `severity_floor`
  changes route to a HITL Proposal by default; suppression always does, while explicit
  confirmed-evidence auto-apply is opt-in. Every applied change is audited and reversible.
  It is a config-writer only — it **never** imports `decide()` / risk / signatures.
- **Two-tier alert/event ingestion** — ALERT feeds run realtime per-alert; EVENT feeds run a
  cheap-first `engine/event_detection.py` funnel (pre-aggregate → rules → anomaly → batched
  Haiku detection) whose survivors **re-enter the SAME correlate/decide pipeline** (#3/#4),
  #9-fenced, #7 aggregate-only.
- **Daily campaign correlation** — `engine/campaigns.py` + `stores/campaigns.py`: a
  deterministic shared-entity graph producing full-set reconciled `Campaign` objects
  that only *reference* `case_ids` (never re-clusters or closes, #4).
- **Entity baseline** — `engine/baseline.py` + `stores/baseline.py`: online EWMA/EWMV over
  168 hour-of-week buckets + a bounded t-digest + modified-z |M|>3.5 (warm-up 3× period,
  H=14d); a pure producer.
- **Batch/flex + broadened model catalog** — `llm/batch.py` (`BatchProvider` SPI: Anthropic
  Message Batches + OpenAI Batch; custom_id-keyed idempotent) + separate live OpenAI
  Flex routing + `stores/batch_jobs.py`;
  corrected pricing + cache/batch columns in the Models catalog.
- **Unified logs** — `GET /api/logs` scatter-gather across browse-capable sources + a
  webui `UnifiedLogsSheet`.
- **Reset + OOBE** — `engine/reset.py` (tiered cases / sources / factory reset that **never**
  wipes env secrets) + `routes_reset.py` (deprecated direct mutation returns 410;
  canonical reset is a Job); `routes_setup.py` OOBE first-admin (strong-pw, self-locking).
- **Login white-label** — `BrandingConfig.login_*` bounded plain-text hero/illustration.
- **Terminology cleanup** (UI/docs only; wire keys + aliases kept): event / detection / alert
  / case / campaign; "correlate" → Auto-investigate / clustering / campaign-correlation;
  "rule" → detection-rule / case-automation (`AutomationRule` → `CaseAutomationRule` alias,
  wire key `threshold_automation` unchanged).
- Plus a cleaner **CaseDetail** (single primary CTA + unified Close-with-disposition),
  **analytics declutter** (Cost is the single home), and the new tuning / campaigns /
  baseline / batch / DangerZone-reset webui surfaces.

**Audit/harden:** a 16-dimension adversarial audit found **16 confirmed issues** (2 HIGH), all
fixed + regression-tested — the two HIGH were poller concurrency (a per-`cluster_signature`
lock now serialises find-open→save so concurrent sources create exactly one case) and the
EVENT-detection funnel now really creates cases (survivors re-enter via `register_candidate` +
`investigate_cluster`). Others: OpenAI prompt-cache double-bill, the legacy public
`/api/setup/init-admin` (bypassed the strong-pw policy) removed, batch dedup made an atomic
CAS claim-before-bill (#6).

| Commit | Wave | What |
|---|---|---|
| `3aeab6c` | W0 | Price fix (`claude-opus-4-8` $5/$25 + broadened Anthropic family) + wired `with_retry()` + 3 UI glitches + risk-help |
| `41ee54b` | W1 | Hot-file contracts: `UsageDoc` cache/batch fields · Campaign/BaselineState/BatchJob/DetectionRule models · new enums + KV namespaces · Preferences blocks (default OFF) · `AutomationRule`→`CaseAutomationRule` alias |
| `f7509a3` | W2 | **`PollerManager`** — THE multi-source bug fix (per-feed cursor + collision guard + in-flight guard) |
| `b07f172` | W3 | Engine capabilities: threshold_tuner · campaigns · baseline · batch (`BatchProvider`) · event_detection + cache-rate application |
| `11ea46e` | W4 | API surface + runtime wiring: 6 routers + `GET /api/logs` + acknowledge→INVESTIGATING + gated schedulers + EVENT-feed routing |
| `3c68cf5` | W5 | Webui: unified logs · tuning/campaigns/baseline/batch surfaces · cleaner CaseDetail · analytics declutter · login white-label + OOBE · Models cache/batch pricing · DangerZone reset |
| `1df27ac` | W6 | 16-dimension adversarial audit (16 confirmed) + harden (+24 regression tests) |

### Round 5 (commits `5ab7c05` → `05552c7`) — "UI/UX overhaul + rules customization + custom dashboards + loose coupling"
9 delivered goals (G1–G9), additive, `engine/case_manager.py` `decide()` **byte-identical** to the
pre-Round-5 baseline `27f0983`, +1 lazy webui runtime dep (`react-grid-layout`), `framer-motion`
removed. Design + what-shipped: `docs/research/2026-07-round5/` (`PROPOSAL.md` · `DESIGN_STANDARD.md`
· `IMPLEMENTATION.md` · the `RESEARCH_*.md` studies + `AUDIT_FINDINGS.md` + `understand/` maps).

**The goals delivered:**
- **G1 — a cohesive color scheme.** A Radix slate + blue base with **three orthogonal semantic axes**
  (severity / status / verdict), each split into `token` / `-foreground` / `-text` with **measured
  WCAG-AA contrast in both light and dark themes**; Okabe-Ito colour-blind-safe chart ramps + viridis;
  self-hosted **Inter + JetBrains Mono**.
- **G2 — ONE consistent design standard.** A single shadcn / Radix / Tailwind grammar enforced
  end-to-end: shared primitives + one card grammar + a label→token authority + a **codemod** that
  adopted the primitives across the pages. (Blueprint: `DESIGN_STANDARD.md`.)
- **G3 — a decluttered Settings.** The **2673-line** Settings god-file became a **data-driven section
  registry** + `pages/settings/*` section files; **6 → 5** nav groups; **Security promoted to
  top-level**; ≤2 nesting levels; 33 redirect tests keep deep-links working.
- **G4 — a dashboard that uses the real-estate.** A `PageContainer` (wide / fluid) killed the
  `max-w-[1400px]` cap; a three-zone dashboard layout.
- **G5 — a compact hero.** The old ~176 px HeroPanel merged into a ~52 px `PageHeader`.
- **G6 — rules customization.** A **Detection & Rules** home over **3 rule tiers** (detection-match /
  threshold · anomaly / baseline · case-automation); a polymorphic editor + a flat condition builder;
  **Test/Preview against recent data that NEVER calls `decide()` and NEVER bills the LLM** (a pure
  what-if via `POST /api/triage/preview-decision`); a version ledger + rollback; threshold
  `NumberField` / `LabeledSlider`; asset / SLA / priority / suppression editors.
- **G7 — custom dashboards.** A widget registry that **reuses the existing tiles/charts**; a per-user
  drag/resize grid (LAZY `react-grid-layout`, edit-mode only); a zero-migration `DashboardStore`;
  per-role defaults + clone-to-customize.
- **G8 — loose coupling.** A single `FEATURES[]` registry (`soc/registry.tsx`) **derives nav + routes +
  the command palette**; `useNavigate()` replaced the `onNavigate` prop-drill; `React.lazy`
  code-splitting restored (**entry chunk 537 → 264 kB**); `routes.py` decomposed into domain routers
  with **byte-identical paths**; a generic `EntryPointRegistry`; `Protocol` narrowing; and
  `openapi-typescript` type generation.
- **G9 — accessibility + audit.** A non-color signalling pass (`SEMANTIC_ICON`), WCAG-2.2 criteria,
  `jest-axe`, **20 `jsx-a11y` rules at error (48 → 0 violations)**; plus a 16-dimension adversarial
  audit (23 findings, **9 must-fix all resolved** with regression tests).

**Bugs fixed** (from the subsystem maps + audit): the **auto-close dead-field** (the flagship
auto-close toggle did nothing), KpiTile delta-by-sign, the cosmetic wizard demo toggle,
clipboard-over-http, a misc-prefs clobber, an automation impossible-verdict, a roles perm mismatch, a
no-confirm destructive close, a campaigns read-perm gate, the dead `initAdmin` stub, a
`request_approval` dead-end, a tuning row always showing "Active", a SQL sort no-op, a
`derive_priority` disagreement — plus audit **C1** (dashboards couldn't persist), **H2** (a rules
verdict case-bug), **H3** (dashboards billed the LLM), **H4** (19 unnamed comboboxes), and **M1–M4**.

| Commit | Wave | What |
|---|---|---|
| `5ab7c05` | docs | Round-5 research + plan: `understand/` maps + the `RESEARCH_*.md` studies + `PROPOSAL.md` / `DESIGN_STANDARD.md` / `IMPLEMENTATION.md` |
| `0e99c76` | W0.1 | Foundations pt1 — test-anchoring + the color / token system (G1) |
| `9854c36` | W0.2 | Foundations pt2 — primitives · shell width · compact header · coupling infra (G2/G4/G5/G8) |
| `7c86706` | Settings | Settings IA overhaul (2673 → 575 LOC, 5 groups, Security promoted) + the **auto-close bug fix** (G3, bug #1/#7) |
| `f50e0b2` | Dashboard | Dashboard density + hero compaction + three-zone + wide width (G4/G5) |
| `3e447da` | Codemod | Codemod primitives across pages + split the CaseDetail god-file (4210 → 1529) (G2/G8) |
| `b661bc8` | G6 | Rules customization — Detection & Rules home + polymorphic editor + Preview + versioning (bugs #6/#9/#12) |
| `830e836` | G7 | Custom dashboards — widget registry + drag/resize grid + per-user persistence |
| `d3801f9` | G8 | Loose coupling — registry routing + code-splitting (bundle 537 → 264 kB) + router decomposition (bugs #3/#11/#13/#14) |
| `a9e2b49` | G9 | Accessibility pass — `jsx-a11y` 48 → 0, `Field` labels, `jest-axe`, flaky tests stabilized |
| `8b91fc0` | G9 | Resolve all 9 adversarial-audit must-fix findings |
| `05552c7` | Polish | Audit polish items P1–P18 + a page-consistency sweep |

### Round 6 (one commit, 2026-07-02) — "fleet glitch-hunt + integration polish"
A ~500-agent Opus fleet audited **every** webui file (155 units: file groups + 12 thematic +
4 API-contract auditors, each adversarially verified) → 464 real findings; 30 conflict-free
fix batches + a handoff/closer wave resolved 423 of them (47 verified-not-real). `decide()`
untouched; API paths byte-identical (additive only: optional `GET /api/cases` `from`/`to`,
`GET /api/roles` raw defs, a per-provider SSO configured map, `CaseAutomationRule.name`).
Headlines: custom-dashboard VIEW-mode packing (dashboards no longer stack at `(0,0)`);
`PageContainer` as the single width authority; the rules version ledger actually recording;
ONE `SecretField` everywhere (an empty save can never clobber a stored secret); WCAG-AA
contrast fixes in both themes; an `AutomationNudge` beginner journey. See
`docs/research/2026-07-round6/IMPLEMENTATION.md`.

**GREEN (2026-07-02):** backend **1613 pytest** · webui **1051 vitest** / 199 files · build
clean (entry 281.6 kB) · eslint 0 errors (3 warnings) · `decide()` byte-identical · zero new
deps.

### Round 7 (`850600f` → `7355a9a`, PR #23) — Security Command Center + Noise-Reduction funnel
Overview became a **Security Command Center**: an Active Risk Index with a `(?)` explainer,
honest MTTA/MTTR/Dwell tiles, live-delta KPIs, and Top-Contributors; a durable-counter
**Noise-Reduction** funnel (`GET /api/metrics/noise-reduction` + `stores/noise_counters.py` +
`engine/noise_counters.py`); a shared `source|ai|code` `ProvenanceTag`; the Cases
severity-column bug fixed; CaseDetail retold 8→5 tabs as a story (facts → AI assessment →
the pinned deterministic `DecisionCard`); feedback-at-close; an Auto-closed-by-AI badge; a
motion system. See `docs/research/2026-07-round7/`.

**GREEN (2026-07-06):** backend **1678 pytest** · webui **1238 vitest** / 223 files · build
clean (entry ~282 kB) · eslint 0 errors (3 warnings) · `decide()` byte-identical · zero new
deps in Rounds 7–8.

### Round 8 (`58745fa` → `91aae40`, PR #24) — UI cleanup + glitch fixes
The risk index moved into its own card; the Cases sticky-header glitch fixed (root cause: a
double-nested overflow trapping the sticky `<thead>`); a horizontal QRadar-style Sankey
ribbon for Noise-Reduction (superseded twice since — see Round 9/9b below); a de-carded
plain header; reinvestigate rebuilding from a case's stored evidence when the log window has
aged out; chat/collab tidy. See `docs/research/2026-07-round8/`.

### Round 9 (`709e758` → `26c4266`, PR #25, 2026-07-05) — 11-ask UI/UX overhaul
Removed the redundant in-page tab strips that duplicated the left nav; Overview dropped LLM
Spend from the hero (→5 alert/case KPIs) with a bigger Active Risk Index card and tightened
rhythm; Noise-Reduction redesigned to horizontal aligned stage bars (a Sankey is wrong for a
linear reduction); **Sources** rebuilt as a QRadar-style "Log Source Management" `DataTable`
(over the existing `GET /api/sources/health`); CaseDetail's Investigation tab split into
**Timeline** (what-happened + full trace) and Investigation, with the Overview split into
"Reported by source" vs "Our assessment" provenance sections; Login/Wizard jank fixed; a
**local/self-hosted LiteLLM (OpenAI-compatible) model provider** shipped
(`POST/DELETE /api/llm/models/custom`, `POST /api/llm/providers/test`, $0 pricing, a
`litellm_api_key` secret). Adversarial validation also fixed a pre-existing bug: the shared
`POST /api/sources` dropped `configured_secrets`/`created_at` on every toggle/bulk/
make-primary (now carried forward, regression-tested). **No `docs/research/` folder** (done
efficiency-first) — see `Journal.md`'s 2026-07-05 Round-9 entry + git log `709e758..26c4266`.

**GREEN (2026-07-05):** backend **1696 pytest** · webui **1252 vitest** / 227 files · build
clean (entry ~278.7 kB) · eslint 0 errors (3 warnings) · `decide()` byte-identical · zero new
deps.

### Round 9b (`71153f2` → `b0d8747`, PR #26, 2026-07-05 later) — dashboard/case feedback pass
Hover-to-expand sidebar (the collapsed rail now expands to a floating drawer on hover/focus);
Noise-Reduction reverted flat-bars→ribbon (prettier, with per-stage hover detail); the main
dashboard reorganized into a dense multi-zone grid with Response timing (MTTA/MTTR/Dwell) and
only a shallow "Deeper analytics" fold; CaseDetail redesign (Timeline = "what happened" only;
Investigation = AI assessment + the pinned `DecisionCard` + the full trace); the case Sheet
widened to `max-w-[min(98vw,1400px)]` + an "Open in new tab" button; Overview → a
Decision-Brief hero + a SOURCE SAYS/AGENT FOUND/CODE DECIDED provenance row. No research
folder — see `Journal.md`'s Round-9b entry.

**GREEN:** webui **1264 vitest** / 228 files · build clean (entry 279.3 kB); no backend
change this round.

### Round 9c (`20118a7` → `2cc94c5`, PR #27, 2026-07-06, historical) — dashboard from scratch + honest timing
The dashboard rebuilt from scratch (Prisma/XSIAM-style): real **MTTD**
(`Case.first_seen_millis` → case creation) and first-human-response from the **ACK/MTTA
clock** — NOT dwell; a same-round bug where an AI auto-close was miscounted as a human response
was caught and fixed); a burndown chart; the Noise-Reduction ribbon extended with a terminal
"closed by human" stage; the Cases list rebuilt (a 6-tile summary strip, a monogram Assignee
column). No research folder — see `Journal.md`'s Round-9c entry.

**GREEN (2026-07-07):** backend **1708 pytest** · webui **1268 vitest** / 229 files · build
clean (entry 279.32 kB, gzip 82.55 kB) · eslint 0 errors (3 warnings) · all 5 design gates
pass · `decide()` byte-identical · zero new deps.

---

## 6. Known issues / deferred (next-round candidates)

Found by the adversarial audit, **deliberately deferred** (low severity or needs a deliberate
architectural decision). Full detail + file:line in `docs/research/2026-06-round2/ROUND2_AUDIT.md`:
- **Session KV optimistic concurrency** — the session store is lock-free read-modify-write; a revoke
  racing a touch/create could be lost under high concurrency (single-process is fine today).
- **Multi-generation refresh-reuse detection** — only the last rotation generation is tracked.
- **Shared `CONFIG_INDEX` nested-type collision** (ES-only, speculative).

**Round 4 loose ends — now CLOSED in Round 5:**
- The **admin-page consolidation** landed with the Settings IA overhaul (data-driven registry +
  redirect tests; Security promoted to top-level).
- The **dead `api.setup.initAdmin` stub** was removed (one of the Round-5 bug fixes).

**Round 3 follow-ups (still open):** the opt-in row-level data scope (`can_object()` hook
shipped OFF) · OCSF classification/observables surfacing + the 1.4→1.8 version bump. (Live SSE
wiring + `PUT /api/branding` server-side contrast computation shipped in the Round-3 W4 wave.)
See `ROADMAP.md`.

**Best-of-best roadmap (Tier 2/3)** — `ROUND2_BEST_OF_BEST.md`: the dashboard builder
has shipped. SLA policy and aggregate breached/at-risk analytics have also shipped;
persisted per-case deadlines and the Cases at-risk badge/filter remain open. Other
open items include API keys/programmatic access, scheduled reports, watchlists, a
hunting/query builder, case linking/merge, and an integrations marketplace.

---

## 7. Documentation index (what to read for what)

| You want to… | Read |
|---|---|
| Get the rules + current status | `AGENTS.md` (`CLAUDE.md` forwards to it) |
| Onboard / hand off (this) | `docs/HANDOFF.md` |
| Use a feature (how-to + curl) | `docs/USAGE.md` |
| Deploy (Docker, auth, SMTP/SSO env) | `DEPLOY.md` · `docs/ENVIRONMENT.md` · `.env.example` |
| Run a live demo / give a tour | `DEMO.md` · `scripts/run-demo.sh` |
| Security posture + hardening TODOs | `SECURITY.md` |
| What changed, when | `CHANGELOG.md` · `Journal.md` |
| Round-2 design intent (extend a feature) | `docs/research/2026-06-round2/ROUND2_DESIGN.md` |
| Round-3 design + what-shipped (extend a feature) | `docs/research/2026-06-round3/PROPOSAL.md` · `IMPLEMENTATION.md` |
| Round-4 design + what-shipped (extend a feature) | `docs/research/2026-07-round4/PROPOSAL.md` · `IMPLEMENTATION.md` |
| Round-5 design + what-shipped (UI/UX + rules + dashboards + coupling) | `docs/research/2026-07-round5/PROPOSAL.md` · `DESIGN_STANDARD.md` · `IMPLEMENTATION.md` |
| The current Console UI contract — READ before touching webui | `docs/development/ui-standard.md` |
| Durable background jobs, cancellation, recovery, and artifacts | `docs/operations/background-jobs.md` |
| Round-5 design history (color/token/primitives rationale) | `docs/research/2026-07-round5/DESIGN_STANDARD.md` |
| Round-6 what-shipped (fleet glitch-hunt, 464 findings) | `docs/research/2026-07-round6/IMPLEMENTATION.md` |
| Round-7 design + what-shipped (Security Command Center + Noise-Reduction funnel) | `docs/research/2026-07-round7/` |
| Round-8 what-shipped (UI cleanup + glitch fixes) | `docs/research/2026-07-round8/` |
| Round-9 / 9b / 9c what-shipped | **no `docs/research/` folder** (done efficiency-first) — see `Journal.md`'s 2026-07-05/2026-07-06 entries + §5 above |
| Audit findings + dispositions | `docs/research/2026-06-round2/ROUND2_AUDIT.md` · `docs/research/2026-07-round5/AUDIT_FINDINGS.md` |
| What's next | `ROADMAP.md` · `ROUND2_BEST_OF_BEST.md` |

---

## 8. For a new AI chat session specifically

1. `AGENTS.md` is canonical — it has the non-negotiables, module map, and status. `CLAUDE.md` forwards to it. Trust it,
   but **verify any file/function/flag it names still exists before acting** (the codebase moves).
2. The memory files (auto-recalled) point back here. The Round-2/Round-3 design docs are the implementation blueprint.
3. **Before committing anything:** `pytest -q` green, `npm run build` clean,
   `npm run test:strict` green, `npm run lint -- --max-warnings=0` clean, and
   `git diff backend/app/engine/case_manager.py` **empty** (decision logic unchanged —
   byte-identical to `27f0983`). The `route_auth_coverage` + `design-gate` tests must also stay
   green. Commit focused changes; **don't push** unless asked.
4. This repo was built with review-gated, self-verifying waves (research → implement → pytest/build/
   vitest/lint → fix-loop → independent re-verify → commit). Keep that rhythm.
