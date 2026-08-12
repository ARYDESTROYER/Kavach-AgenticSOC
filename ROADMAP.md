# ROADMAP.md — live work tracking

> **New here? Start with [`docs/HANDOFF.md`](docs/HANDOFF.md)** — the START-HERE
> onboarding doc (run commands, current status, what's done, what's next).

Status legend: ☐ todo · ◐ in-progress · ☑ done. Update this + `Journal.md` as you
work. The Console is the primary surface (Vite + React + **Tailwind + shadcn/radix**;
the Kibana plugin is archived). Every item ends with: `pytest -q` green (keep the
count current), full `npm run build` (version-matched Help Center + tsc + Vite) and
Vitest clean, **#3 `decide()` byte-identical**, and
docs + Journal updated. Commit or publish only after the user or maintainer
intentionally authorizes that repository mutation.

**Current baseline (Version `0.1.13`; `Testing` integration and default `main`
Stable source):** the canonical branches exist; 0.1.13 is a Stable release only when
the exact accepted commit has the immutable `v0.1.13` tag and matching signed/public
artifacts. The immutable `v0.1.4` and `v0.1.5` tags are historical and
non-installable because neither completed a canonical signed GitHub Release. The
immutable `v0.1.6` tag is a published and signed artifact record whose canonical
macOS Bash 3.2 bootstrap acceptance failed before supervisor installation; it is
superseded and not a supported bootstrap source. The immutable `v0.1.7` publication
also completed its signed/public artifact gate, but canonical Docker Desktop
acceptance found that its updater could not publish the private control socket under
the dropped-capability runtime. The immutable `v0.1.8` publication corrected that
socket boundary but canonical bootstrap then failed when cosign 3 tried to initialize
its default TUF cache beneath the updater's read-only `/root`. It too is superseded
and not a supported bootstrap source. The immutable `v0.1.9` publication built,
signed, and anonymously proved all three images, but its constrained supervisor could
not traverse the runner-owned verification directory; it published no GitHub Release
or installable plan. Version 0.1.10 carried the traversal correction through source
and exact-tag CI, then its signed-release workflow timed out while the Web Console's
architecture-neutral builder ran under target emulation. It published no complete
three-image set, canonical plan, GitHub Release, Stable tags, or Stable documentation
and is immutable, superseded, and non-installable. Version 0.1.11 retained the updater
trust and traversal corrections while moving architecture-neutral Console builder
work to BuildKit's native platform; its release built, signed, anonymously proved,
and verified all three images and the plan, including inside the constrained updater,
but post-verification cleanup failed before canonical publication. It is immutable,
superseded, and non-installable. Version 0.1.12 restored the runner-owned verification
fixture to private mode only after verifier exit, then removed it, and completed the
entire signed/public publication. Canonical v0.1.1 bootstrap then failed closed
before application mutation because matching absent legacy state-schema labels were
normalized asymmetrically. It is also immutable, bootstrap-blocked, and unsupported.
Version 0.1.13 corrects only that legacy identity comparison. It changes no
schema, protocol, identity, privilege, trust predicate, or frozen-base bytes and
remains a candidate until every publication and canonical runtime acceptance gate
passes. Branch
protections, required checks, Pages source selection, and `github-pages` environment
policy remain repository-administration controls and must be verified independently;
source files cannot attest to those settings. The current console adds the polished
selected-window Security Command Center and an additive split-pane **Case Manager** (Active/All queue, six-tab
workspace, selection and permission-gated Acknowledge/Assign/Add tag/Set status/
Set disposition/Reinvestigate/Resolve) while the legacy Cases table remains. The
always-visible `vX.Y.Z · Testing|Stable` badge reconciles Console/backend stamps and
fails mismatches down to Testing.
The current Console-standardization pass removes Automated Scans from primary
navigation while preserving compatibility, clarifies the targeted Entity investigation
workflow, adds a persisted three-mode appearance control and a same-origin,
version-matched installed Help Center,
and migrates Settings plus the shared shell/loading states to the flat command-center
grammar documented in `docs/development/ui-standard.md`.
Cases remains the full-width table for broad list work, but opening a case now hands
the exact record to Case Manager, whose desktop queue divider is accessible,
bounded, and persisted. The dashboard defaults to visibility-aware LIVE refresh and
adds an expanded aggregate Noise Reduction view. Threat Context explains persisted
alert-to-cluster-to-case formation; Demo Mode now has five sources including Entra;
and privileged operators can page every record in selected supported safe export
scopes through bounded, resumable files (still an analysis artifact, not a backup).
Compatible official OpenAI alert/case work prefers live Flex with truthful standard
fallback, independently of the still-opt-in asynchronous Batch event funnel.
Agent Effectiveness now preserves its established quality/turnaround headline while
adding separate aggregate outcomes for recorded case-linked AI cost, observed closure
elapsed difference, confirmed-positive case rate, durable ingress/clustering volume,
and true week-over-week plus rolling-28 comparisons. Tuning chronology is explicitly
non-causal; unlike-unit TP/raw-alert yield remains unavailable rather than fabricated.
**Round 10** ("Autopilot & Comprehensive Ingestion + motion.dev" — a **behavior change**:
`background_scan_enabled` default TRUE + a deterministic risk gate + an `autopilot_profile`
smart-defaults dial + a default-enabled $10/day budget ceiling + per-source coverage
observability + lazy `motion.dev` animation) is committed on `Testing`. The current
release-readiness work layers source-safe ingest, pull correctness, packaging, versioning,
health, CI, and public documentation on top. **Round 9c** ("dashboard rebuilt
from scratch" — real MTTD + first-human-response from the ACK/MTTA clock, a cleaner Cases list; PR #27,
`559ce88`) was on top of **Round 9** (an 11-ask UI/UX overhaul + a local LiteLLM model
provider; PR #25) and **Round 9b** (dashboard reimagine + case redesign; PR #26) — all
three developed on `claude/ui-ux-improvements-7nq5be` (created off `Testing` `1ab98f2`) —
and **Round 8** (UI cleanup + glitch fixes; PR #24), **Round 7** (Security Command Center
overhaul + Noise-Reduction funnel; PR #23), and **Round 6** (a ~500-agent glitch-hunt, 464
findings fixed) before them. On top of all of them, a **backend deep-audit hardening
pass** (`c5516e5`→`abd0385`, 2026-07-14/15, now present on `origin/Testing`) fixed **47 verified findings**
(0 crit / 10 high / 24 med / 13 low) from a 24-auditor + adversarial-verify Workflow —
    one atomic commit per finding, no co-author, each with a regression test. The current 0.1
    candidate was re-verified on 2026-08-05: backend **2,306 pytest** (0 failures);
    Console **1,935/1,935 Vitest** across 286 files under the strict zero-stderr/zero-console-output
    gate; full version-matched Help Center + app build clean at **3,189 modules**; and
    zero-warning ESLint plus all five design-system gates clean. `engine/case_manager.py`
    `decide()` remains **byte-identical** (verified clean), and the generated-contract,
    distribution, version, Compose, and strict-docs gates pass. See `CHANGELOG.md`
    `[Unreleased]` plus its dated Development snapshots for the
audit fixes and full Round 6–10 narrative,
and the "Progress" log below for the per-round summary (Round 10 first).

## Remaining / backlog

Rounds 1 through 9c are complete and shipped (see "Progress" below and
`CHANGELOG.md`). The tracks below are the genuinely still-open items.

**A. Round-3 follow-ups (still open):** the opt-in row-level data scope (the `can_object()`
hook shipped OFF) · the OCSF classification/observables surfacing + the 1.4→1.8 version bump.
(Live SSE wiring end-to-end + `PUT /api/branding` server-side contrast computation shipped in
the Round-3 W4 wave.)

**B. Pre-Round-3 backlog still open (scoped in `docs/research/2026-06-round2/`):**

**B-1. Deferred / low (from the audit — `ROUND2_AUDIT.md`):** session-KV optimistic
concurrency · multi-generation refresh-reuse detection · ES-only `CONFIG_INDEX`
nested-type collision.

**B-2. Best-of-best Tier 2/3 (`ROUND2_BEST_OF_BEST.md`).** Round 2 already shipped the
whole Tier-1 productivity tier EXCEPT API keys: **saved views** (W7b), **bulk case
actions** (W7c), **Cmd-K command palette** (W7c), **global search** `GET /api/search`
(W7c), and the **audit-log viewer** `GET /api/audit` (W7c). Remaining, in recommended
order:

- ☐ **API keys / tokens management UI** (Tier-1 #5) — scoped, revocable keys on the
  existing JWT/PBKDF2 auth (prefix + last-used); the vendor-agnostic open-API
  requirement. Builds cleanly on the W3 SessionStore + token model.
- ◐ **SLA timers** (Tier-2 #8) — policy controls plus aggregate breached/at-risk
  analytics have shipped. Persisted per-case `sla_due_at`/`sla_state` and the Cases
  at-risk badge/filter remain open (display + filter only, NO enforcement of
  `decide()`); pairs with saved views.
- ☐ **Watchlists** (Tier-2 #10) — VIP users / crown-jewel assets / known-good IPs as
  TRUSTED operator context boosters in correlation/risk + a triage chip; matched log
  values stay UNTRUSTED (#9). Extends the HITL suppression/asset proposals.
- ☑ **Dashboards builder** (Tier-3 #11) — DONE in **Round 5 (G7)**: a widget registry
  reusing the existing tiles/charts, a per-user drag/resize grid, a zero-migration
  `DashboardStore` (`stores/dashboards.py`, KV-doc), per-role defaults + clone-to-customize
  (`UserPrefs.dashboards` + `CustomizationConfig.default_dashboards`). `react-grid-layout`
  was the deliberate NEW runtime dep — loaded LAZILY in edit-mode only; on net the webui
  shed a dep (removed `framer-motion`). See "Progress → Round 5" below.
- ☐ **Scheduled reports** (Tier-3 #12) — cron MD/PDF digests via the standup
  aggregator → existing notification channels (reuses aggregate-then-summarise, #7).
- ☐ **Hunting / saved-query builder** (Tier-3 #13) — named reusable read-only queries
  over sources (Stellar Query-Library parity); builds on the `es_query` tool +
  per-source browse.

**C. Newer backlog** (surfaced in `docs/ROADMAP_RESEARCH.md`; re-verify before citing
competitively — it is a dated research snapshot):

- ☐ **Observability / tracing** — OTEL spans across the pipeline + a Grafana
  dashboard; pairs naturally with Epoch E's scale-out below.
- ☐ **SOAR / response actions** — real containment/response actions (isolate a host,
  block an IP/hash, disable an account, …) gated behind HITL action approval + a
  pre-flight `$`-budget ceiling. The groundwork is already in place (`ToolTier.
  requires_approval`, the read-only pre-flight `BudgetGate` — **now default-enabled
  as a $10/day backstop, Round 10**, see the Vigil-overhaul Wave-2 leftovers note
  above); this closes the loop with actual write-side actions.
- ☐ **A formal eval / detection-quality harness** — golden-set replay, precision/
  recall against known-good verdicts, prompt/model regression gating.
- ☑ **Governed telemetry-gap recommendations (bounded v1)** —
  `GET /api/tuning/source-recommendations` accepts only versioned stored query/tool
  evidence for three allow-listed gaps (outbound DNS, endpoint process, identity
  authentication), exposes bounded proofs/case scope, and ignores connector absence or
  free-form prose. Post-addition causal outcome measurement remains future work.
- ☐ **Sigma / detection-as-code import** — an import path into the Detection & Rules
  editor (shipped in Round 5 G6) for Sigma-format rules.
- ☐ **An MCP transport** — expose the existing MCP-shaped tools (`tools/base.py`)
  over a real Model Context Protocol server, not just in-process.
- ☐ **Scale-out** — see **Epoch E** below (ARQ workers + KEDA scale-out; a Helm chart).
- ☐ **More pull connectors** — Splunk / Microsoft Sentinel / QRadar / Chronicle /
  CrowdStrike / SentinelOne / Microsoft Defender are `SourceType` enum members with
  **no connector class built yet** (roadmap slots only, alongside the 3 shipped pull
  connectors — Elastic/OpenSearch/Wazuh).

**D. Round-10 follow-ups (still open):** now that comprehensive ingestion + autopilot
smart defaults have shipped (see "Progress → Round 10" below), the genuinely open
threads from that round are:

- ☑ **Global per-tick investigation cap threading** — `caps.max_auto_investigations_per_tick`
  (default 25) is enforced once across every source in a `PollerManager` fan-out tick
  through a shared concurrency-safe budget. Eligible work beyond the allowance remains
  a durable deferred candidate and drains on a later tick.
- ☐ **Reputation-in-routing-gate opt-in** — enrichment/IOC reputation is currently
  advisory/display-only; letting it *influence* the risk-gate's `auto_investigate_risk_floor`
  (not just the case view) is scoped but not built, and must stay opt-in (#3/#9 —
  reputation data is source-controlled and would need the same UNTRUSTED treatment).
- ☐ **Async Batch as an autopilot default** — the provider Batch EVENT funnel remains
  explicit opt-in and still needs a latency-tolerance story. Compatible live OpenAI
  case/alert calls already prefer Flex independently and fall back truthfully to
  standard service when allowed; do not conflate that in-band path with async Batch.
- ☐ **OTEL / scale-out** — unchanged by Round 10; see **Observability / tracing** and
  **Scale-out** above (Section C) / **Epoch E** below.

**E. Pre-Stable Intelligence evidence hardening (live-export audit, 2026-08-02):**
the components execute, but the product still avoids an outcome-supervised
continuous-improvement claim. The audited evidence boundaries are now closed as follows:

- ☑ **Human-ground threshold tuning** — only latest-valid independent analyst outcomes
  enter FP/confirmed-TP learning evidence; all other observations remain unconfirmed.
  Tuning writes are review-first through Approvals, confirmed-evidence auto-apply is
  opt-in, and suppression is always approval-only. Historical applied rows remain
  visible for review/rollback.
- ☑ **Prevent self-reinforcing resolved-case knowledge** — only independently
  analyst-confirmed terminal cases enter resolved-case RAG; inferred/model-only and
  auto-closed outcomes are excluded and retrieved text remains UNTRUSTED-fenced.
- ☑ **Fix memory authorization and trust** — Chat mutations obey `memory:manage`;
  agent-authored memory starts pending and only active+approved memory is trusted.
- ☑ **Validate embedding-role capability and provenance** — capability validation,
  vector cardinality/dimension checks, explicit local-fallback provenance, and
  embedding-space clear/reseed prevent mixed or falsely labelled vectors.
- ☑ **Make Intelligence use measurable** — durable strict-CAS operator playbooks,
  exact dry-run, bounded coverage/no-match reporting, selected-versus-consulted
  persona/playbook/knowledge provenance, RAG source reconciliation, and
  independently-confirmed resolved-case reuse are shipped.
- ☑ **Preserve producing-build and retrieval-history evidence** — cases keep immutable
  creation-build provenance; append-only audit/usage rows keep first-writer build
  provenance; legacy values are not backfilled. `retrieval_history_status` is the
  authoritative lifetime-completeness marker, `knowledge_used` remains an array for wire
  compatibility, and `retrieval_observation_status` alone distinguishes measured-empty
  retrieval from a skipped, failed, or unavailable observation. Base metrics expose
  case-level reference coverage only.
  Mixed legacy/instrumented or truncated cohorts remain `null`; an otherwise complete
  cohort with no measured observation remains insufficient evidence, while individual
  `not_measured` cases are excluded. No version bump or SQL migration is required, and
  existing Elasticsearch templates/indices are not auto-remapped.
- ☑ **Expose loop health and lifecycle** — the Console/API exposes worker
  enabled/gated/running and last attempt/success/error, tuner confirmed/unconfirmed
  sample eligibility, and query-backed telemetry opportunities; campaigns enforce
  cadence and full-set active reconciliation. Agent Effectiveness still preserves
  `insufficient_evidence` until real analyst outcome/timing cohorts qualify.

Remaining scale-out work is intentionally separate: schedulers still need distributed
leases/ownership and campaigns do not retain an immutable split/merge lifecycle history.

**F. Ranked post-0.1.13 hardening sequence (release-gap audit, 2026-08-05):** keep the
0.1.13 Stable candidate focused on the truthful legacy-bootstrap identity correction and complete
release acceptance. The next
engineering sequence is ordered by data safety and measurable outcomes, not screen count:

- ☐ **P0 — complete external Stable acceptance.** Verify branch protection and Pages
  administration, publish the first supported installable immutable signed release, make all required
  GHCR artifacts readable, and run clean/interrupted/cancel/automatic-rollback/operator-
  rollback acceptance against an isolated PostgreSQL Compose deployment. The project
  also needs an explicit maintainer license decision before it can make redistribution
  promises.
- ☐ **P0 — durable ingest and operations.** Give push/queue/object receivers durable
  receipt IDs, replay checkpoints, idempotency, bounded dead-letter handling, and an
  operator recovery workflow. Move runtime secrets to a durable secret-manager
  integration and introduce versioned, rollback-aware SQL migrations before multi-node
  production use.
- ☐ **P1 — measurable learning quality.** Add stable case-episode identity and complete
  alert-to-cluster-to-case lineage; then build a golden-set replay harness with precision,
  recall, cost, latency, and post-tuning holdout comparisons. Never infer causal
  improvement from chronology alone.
- ☐ **P1 — governed tenant and response boundaries.** Finish scoped/revocable API keys,
  opt-in row-level object scope, and HITL-approved response actions with preflight,
  receipts, rollback where supported, and the deterministic case decision kept outside
  playbooks and model output.
- ☐ **P2 — distributed observability and history.** Add scheduler leases/ownership,
  durable realtime replay, immutable campaign split/merge lineage, OpenTelemetry spans,
  and a typed expansion path for evidence-backed telemetry-gap producers.

Each item ends with: `pytest -q` green (keep the count current), full docs+app
`npm run build` + `npm run test:strict` clean, **#3 `decide()` byte-identical**, additive + zero new runtime deps
where possible, and docs + Journal updated. Commit or publish only after intentional,
explicit authorization.

## Shipped (Phase 1)
- ☑ Backend spine + 5 surfaces + tests (49 green); both plugin zips; full docs.
- ☑ 8.19.12 plugin build (legacy `kibana.json`, Node 22.22.0, import-alias port).
- ☑ AGENTS.md (with CLAUDE.md forwarder), Journal.md, docs/ENVIRONMENT.md, this ROADMAP.

## Progress (this cycle, newest first)
- ☑ **Pre-Stable Intelligence evidence hardening** — review-first analyst-grounded
  tuning + Approvals RBAC; pending/approved memory trust; confirmed-only resolved-case
  reuse; RAG toggle/embedding reconciliation; durable CAS playbooks with dry-run and
  coverage; exact selected/consulted procedure provenance; scheduler health; cadence-
  reconciled campaigns; and query-proven telemetry-source recommendations. Aggregate
  Effectiveness remains non-causal and preserves insufficient evidence.
- ☑ **Backend deep-audit hardening — 47 findings fixed** (`c5516e5`→`abd0385`,
  2026-07-14/15, on `Testing`, **local / not pushed**). A 24-subsystem-auditor Workflow
  over the whole backend, every finding adversarially re-verified against the source →
  47 verified (0 crit / 10 high / 24 med / 13 low). All fixed **one atomic commit per
  finding, no co-author**, each with a regression test. Security (fence `#9` injection,
  route authZ, OIDC hardening, key-leak), concurrency (KV CAS + real `put_if`), ingestion
  durability (durable receiver cursors, pagination cap, no duplicate closed clusters,
  drain fairness), correctness (MTTA human-ack, timestamps, ModSec, batch cache, severity
  scale, campaigns, tuner), and resource bounds (SSE/cache/rate-limit/lock/demo). **#3
  verified clean — `decide()` untouched.** Green: **1942 pytest** (0 fail; +55 tests),
  webui **1349 Vitest / 240 files** unchanged, build + lint clean. See `CHANGELOG.md`
  `[Unreleased]` + the 2026-07-15 `Journal.md` entry.
- ☑ **Round 10 — "Autopilot & Comprehensive Ingestion + motion.dev"** (committed on
  `Testing`; after the deep-audit hardening pass the candidate verifies **1942 backend
  tests** green + webui **1349 Vitest** green / 240 files + build clean (entry **285.91 kB**,
  a lazy `motion` chunk **83.85 kB**, never modulepreloaded) + eslint **0 errors**
  (0 warnings); `engine/case_manager.py` `decide()` **byte-identical**;
  `risk.py`/`signatures.py` **untouched**; **zero new runtime deps except the
  deliberate `motion` 12.42.2**). A **behavior change**: the suite now reads +
  reasons over everything and runs tuning observation/recommendation **by default**;
  the current governance layer keeps preference writes review-first unless
  confirmed-evidence auto-apply is explicitly enabled.
  - **Comprehensive ingestion** — `background_scan_enabled` is now **default TRUE**:
    every event from every source is correlated + risk-scored (0–100) + made visible.
    `events`-role clusters auto-forward to the strong-LLM investigation via a
    **deterministic risk gate** at `risk_score >= auto_investigate_risk_floor`
    (default **70** — below-floor stays a **$0 candidate, never dropped, #4**);
    `alerts`-role feeds bypass the gate AND correlate `mode=EVERY` so every alert
    becomes exactly one case (same-signature bursts still coalesce onto one open
    case). A per-source per-tick cap (`caps.max_auto_investigations_per_tick=25`)
    throttles volume — cap-deferred candidates **drain** to investigation on later
    ticks as headroom frees; investigations run **sequentially**; the push path is
    symmetric with pull; **the daily budget is the global spend bound**.
  - **Smart defaults / autopilot** (default-ON, $0/#3-safe) — `ThresholdTuning`
    (`shadow_eval` forced on), Campaigns, CrossSourceCorrelation, SlaPolicy,
    PriorityMatrix, realtime SSE, the ThresholdAutomation engine (empty ruleset),
    and Baseline (producer + a silent-source detector) all flip ON. **Still opt-in:**
    Batch, warning-only budget behavior, default notify/run-playbook rules,
    baseline-driving investigation. A new `Preferences.autopilot_profile` dial
    (`conservative` / `balanced` / `aggressive`, default `balanced`) scales
    `(risk_floor, daily_usd, cap)`: conservative **90 / $5 / 10** · balanced
    **70 / $10 / 25** · aggressive **40 / $50 / 100**.
  - **Default budget backstop** — `BudgetConfig` default `enabled=True`,
    `daily_usd=$10`, `soft_warn_pct=0.80`, `on_exceed="block"` (over-budget →
    `NEEDS_HUMAN`, never a close, #3) — so "read everything by default" can't
    become "spend everything." (Closes the long-standing Wave-2 leftover; see
    above.)
  - **Migration** — auto-adopt + a one-time banner: a stored pre-overhaul config
    adopts the new ON defaults (an `autopilot_config_version` marker) and sets
    `show_autopilot_banner=True`; the `AutomationNudge` card is **inverted** into
    an "autopilot is ON — here's what it's doing / turn off" reassurance card;
    explicit opt-outs set *after* the marker are preserved; tuner `shadow_eval`
    is force-on for migrated tenants.
  - **Coverage observability** — a per-source last-poll snapshot
    (`last_poll_at`/`last_poll_ok`/`last_poll_error`/`events_per_min`/`silent`) on
    `GET /api/sources/health` (additive fields) + multi-feed failure detection (a
    source whose feeds all raise now reports `ok=False`); `AuditDoc.source_id`
    (+ the ES `AUDIT_MAPPING` keyword) enables `GET /api/audit?source_id=`; a new
    `GET /api/sources/coverage` rollup (`sources_total`/`sources_enabled`/
    `sources_silent`/`events_per_min`/`alerts_triaged_24h`/`worst_last_event_seconds`).
    Webui: a Sources coverage banner + server-truth per-row status, an Overview
    coverage tile, and an honest "awaiting/candidate" stage in the Noise-Reduction
    funnel.
  - **motion.dev** — one new runtime dep, `motion` 12.42.2 (`framer-motion` was
    removed in Round 5), LAZY behind `LazyMotion` + `m` + `domAnimation` +
    `MotionConfig reducedMotion="user"` — lands in a lazy **~83.85 kB** chunk while
    the entry chunk holds at **281.44 kB** (< 400 kB ceiling, never
    modulepreloaded). Animates route/page transitions, the CaseDetail tab enter,
    the Cases bulk-bar exit + row reflow, the NavSidebar rail, and dashboard KPI
    count-ups (`AnimatedNumber` dynamically imported into `KpiTile` so it stays
    lazy); reduced-motion honored (count-ups snap instead of animating).
  - **Standards cited** (industry-grounded, not invented): risk floor **70** = the
    Elastic entity-risk "High" band start (cross-vendor High midpoint ~70); tuner
    `min_samples=30` / Wilson 0.95 lower-bound / modified-z 3.5 / bounded ±1 nudge /
    `target_fp_rate=0.10`; baseline warm-up **14d** (Sentinel UEBA) / modified-z 3.5;
    anomaly alert threshold **75** (Elastic ML); `daily_usd` **$10** ≈ a coffee
    budget, ~10× below AI-SOC entry pricing.
  - **Process** — research (vendor + standards) → code (5 batches) → adversarial
    verify (found **5 major + 6 minor**) → fix (all) → re-verify.
  - **12 non-negotiables held** throughout. Note: #10 ("sane defaults") now *means*
    smart-autopilot-on — that is the point of this round. #3 (`decide()` is the sole
    close/escalate authority) still holds without exception: the risk gate is
    **routing only** (it reads `compute_risk()`'s existing output; it never changes
    scoring or `decide()` itself).
  - **Open follow-ups:** see "Remaining / backlog → D. Round-10 follow-ups" above
    (global per-tick cap threading, the reputation-in-routing-gate opt-in, batch
    staying opt-in, OTEL/scale-out unchanged).
- ☑ **Round 9c — dashboard rebuilt from scratch + cleaner Cases + real MTTD/first-
  response MTTR** (`20118a7 → ceba59d → c4d1bb6 → 2cc94c5`, PR #27; backend **1708
  pytest** green + webui **1268 Vitest** green / 229 files + build clean (entry
  **279.32 kB**, gzip 82.55 kB) + eslint **0 errors** (3 warnings); `engine/
  case_manager.py` `decide()` **byte-identical**; **zero new runtime deps**). Overview
  rebuilt Prisma/XSIAM-style: a 5-tile alert/case KPI micro-strip → a hero row (Active
  Risk Index + a resolved-cases donut + an open-cases donut, each with a real
  previous-window trend delta) → the full-width Noise-Suppression ribbon now flowing
  `ingested → clustered → cases → auto_cleared → escalated → closed` with a new
  terminal **"closed by human"** stage → a burndown/timing/top-open-cases row. Real
  **Mean Time To Detect** (`Case.first_seen_millis` → case creation) and **Mean Time
  To Respond as the first HUMAN response** (the ACK clock — assigning/investigating/
  escalating/on-hold all count — NOT the dwell-to-resolution clock, which a same-round
  validation pass caught crediting an AI auto-close as a "human response" and fixed).
  Cases list rebuilt (a 6-tile incident-summary strip, monogram Assignee column). All
  advisory/read-time — `decide()` never reads the new timing fields (#3). Developed on
  `claude/ui-ux-improvements-7nq5be` (off `Testing` `1ab98f2`); merged into `Testing`
  via **PR #27** (`559ce88`, current HEAD). No `docs/research/` folder (done
  efficiency-first) — see `Journal.md:1474-1482` and `CHANGELOG.md`.
- ☑ **Round 9b — dashboard reimagine + hover-to-expand sidebar + CaseDetail Timeline/
  Investigation split** (`71153f2 → 283aa59 → b0d8747`, PR #26; webui **1264 Vitest**
  green / 228 files + build clean (entry **279.3 kB**); backend pytest unchanged from
  Round 9; `decide()` byte-identical; zero new deps). Hover-to-expand sidebar
  (collapsed rail hover/focus-expands to a floating drawer, no reflow); Noise-Reduction
  reverted Round 9's flat stage-bars back to a flow ribbon (per user preference,
  with per-stage hover detail) and dropped the "LLM Spend" tagline; the Overview
  reorganized into a dense multi-zone grid (KPIs → response timing → noise →
  attention-queue/severity/outcome-donut → top lists); CaseDetail — Timeline = "what
  happened" only, a separate Investigation tab holds the AI assessment + pinned
  `DecisionCard` + full trace, the Sheet widened to `max-w-[min(98vw,1400px)]` with an
  "Open in new tab" button, and the Overview redone as a Decision-Brief hero + a
  SOURCE SAYS/AGENT FOUND/CODE DECIDED provenance row. Merged into `Testing` via
  **PR #26** (`749bce6`). See `Journal.md:1467-1472` and `CHANGELOG.md`.
- ☑ **Round 9 — 11-ask UI/UX overhaul + a local LiteLLM model provider**
  (`709e758 → d13b6f0 → 1adc5ce → 26c4266`, PR #25; backend **1696 pytest** green +
  webui **1252 Vitest** green / 227 files + build clean (entry **278.7 kB**) + eslint
  **0 errors** (3 warnings); `decide()` byte-identical; zero new deps). A 12-agent
  research + codebase-mapping fan-out → design briefs → disjoint-file implementation
  agents → 3 full test passes → a 4-agent adversarial validation → a fix pass. Removed
  the redundant in-page tab strips duplicating the left nav; Overview — LLM Spend off
  the hero (→ 5 alert/case KPIs), a bigger notched Active Risk Index card; Noise-
  Reduction redesigned as clean horizontal stage bars + a disposition row; Sources
  rebuilt as a QRadar-style "Log Source Management" `DataTable` (backed by a new
  `api.sourcesHealth()` over the existing `GET /api/sources/health`); CaseDetail —
  Investigation → Timeline (what-happened + collapsible trace) and Overview split into
  "Reported by source" vs. "Our assessment"; Login/Wizard polish; a new **local/
  self-hosted LiteLLM (OpenAI-compatible) model provider** (zero-migration custom-
  models KV store, `POST/DELETE /api/llm/models/custom`, a non-metered `POST
  /api/llm/providers/test` probe, $0 pricing, an optional `litellm_api_key` secret).
  The validation pass also fixed a **pre-existing bug**: the shared `POST
  /api/sources` dropped `configured_secrets`/`created_at` on every toggle/bulk/
  make-primary call (now carried forward + regression-tested). Developed on
  `claude/ui-ux-improvements-7nq5be` (off `Testing` `1ab98f2`); merged into `Testing`
  via **PR #25** (`a69233b`). No `docs/research/` folder (done efficiency-first) —
  see `Journal.md:1457-1466` and `CHANGELOG.md`.
- ☑ **Round 8 — UI cleanup + glitch fixes (user feedback)** (`58745fa → 91aae40`,
  PR #24; backend **1678 pytest** green + webui **1238 Vitest** green / 223 files +
  build clean (entry **~282 kB**) + eslint **0 errors** (3 warnings); `decide()`
  byte-identical; zero new deps). The Active Risk Index back in its own card; the
  Cases sticky-header glitch fixed (a double-nested-overflow root cause); the
  Noise-Reduction funnel redesigned as a horizontal QRadar-style Sankey ribbon; the
  Security Command Center header de-carded to a plain big title; CaseDetail Overview/
  Threat tabs deduped and Chat rebuilt on the shared `ChatPanel`; reinvestigate fixed
  to rebuild from stored case evidence when the log window has aged out. See
  `docs/research/2026-07-round8/IMPLEMENTATION.md`.
- ☑ **Round 7 — Security Command Center overhaul + Noise-Reduction funnel**
  (`850600f → 1b9ac90 → e40f0bc → 7355a9a`, PR #23; webui **1238 Vitest** green;
  `decide()` byte-identical; zero new deps). Overview reborn as the **Security
  Command Center** (Active Risk Index with a `(?)` explainer, honest MTTA/MTTR/Dwell
  tiles, live-delta KPIs, Top-Contributors); a durable-counter Noise-Reduction
  alerts→cases funnel (`GET /api/metrics/noise-reduction`); the Cases severity-column
  bug fixed + a shared `source|ai|code` `ProvenanceTag`; CaseDetail retold 8→5 tabs
  (facts → AI assessment → pinned deterministic `DecisionCard`); feedback folded into
  the close dialog; an Auto-closed-by-AI badge; a motion system. A 14-agent
  adversarial QA caught + fixed 8 real bugs (2 funnel-correctness). See
  `docs/research/2026-07-round7/`.
- ☑ **Round 6 — fleet glitch-hunt + integration polish (464 adversarially-verified
  findings fixed)** (one commit on `Testing`; backend **1613 pytest** green + webui
  **1051 Vitest** green / 199 files + build clean (entry **281.6 kB**) + eslint
  **0 errors** (3 warnings); `decide()` byte-identical; zero new deps). A ~500-agent
  Opus fleet audited every webui source file (155 units incl. 12 thematic deep-dives +
  4 API-contract audits); every finding adversarially verified (466 claimed → 464
  confirmed → 423 fixed, 47 refuted) across 30 conflict-free fix batches + a closer
  wave. Flagship: the custom-dashboard view-mode stacking bug (`packWidgets` + curated
  per-role default layouts), `PageContainer` as the ONE width authority, CaseDetail
  PATCH 405s fixed, the rules version ledger made real (rollback live), `SecretField`
  unification (per-source connector secrets no longer dropped), honest KPI deltas,
  WCAG-AA contrast in both themes, and the beginner `AutomationNudge` (one-click
  recommended automation, #3-safe). See `docs/research/2026-07-round6/
  IMPLEMENTATION.md`.
- ☑ **Round 5 — "UI/UX overhaul + rules customization + custom dashboards + loose coupling"
  (9 goals G1–G9 + a 16-dimension adversarial audit)** (branch `Testing`; backend **1461 →
  1601 pytest** green + webui tsc/vite clean (entry chunk **537 → 264 kB**) + **273 → 625
  Vitest** green; eslint **0 errors** (4 warnings; `jsx-a11y` 48 → 0); **`engine/case_manager.py`
  `decide()` byte-identical vs the pre-Round-5 baseline `27f0983` (#3)**, #6 one-ledger-write-per-
  call preserved (no preview/what-if/dashboard path bills the LLM), #2/#9/#10 upheld, `PUT
  /api/settings` deep-MERGE intact, **all API paths byte-identical**; on net the webui shed a
  runtime dep (removed `framer-motion`, added LAZY-only `react-grid-layout`) and the backend
  added **zero new runtime deps**. Design + what-shipped: `docs/research/2026-07-round5/`
  (`PROPOSAL.md` + `DESIGN_STANDARD.md` + the `understand/` maps + `RESEARCH_*.md` +
  `IMPLEMENTATION.md` + `AUDIT_FINDINGS.md`). 12 commits `5ab7c05 → 0e99c76 → 9854c36 →
  7c86706 → f50e0b2 → 3e447da → b661bc8 → 830e836 → d3801f9 → a9e2b49 → 8b91fc0 → 05552c7`.
  Since merged + pushed to `origin/Testing` (superseded by Rounds 6–9c above).
  - ☑ **G1 cohesive color & type system** (`0e99c76`) — a single **Radix slate + blue**
    foundation + **3 orthogonal semantic axes** (severity / status / verdict), each a
    `token`/`-foreground`/`-text` triple with **MEASURED WCAG-AA in both themes**; Okabe-Ito
    chart ramps + viridis; self-hosted **Inter** + **JetBrains Mono**. `label → token`
    authority (components consume the token, never a raw hex).
  - ☑ **G2 ONE design standard** (`9854c36`, `3e447da`) — shadcn/Radix/Tailwind enforced
    end-to-end (shared primitives + ONE card grammar + the `label → token` authority) adopted
    by a **codemod**; ~15 new shared components/primitives (`Field`/`SegmentedControl`/
    `ConfirmDialog`/`NumberField`/`LabeledSlider`/`SecretField`/`TagInput`/`IconButton`/
    `PageContainer`/`TimeRangePicker`/`DashboardGroup`/`collapsible`/`typography`); the
    **CaseDetail god-file split 4210 → 1529** LOC (no contract change; the unified Close-with-
    disposition still posts the existing close → `decide()`, #3).
  - ☑ **G3 Settings decluttered** (`7c86706`) — the **2673-line god-file → a data-driven
    registry + `pages/settings/*` section files** (**575** LOC of shell); **6 → 5** groups;
    **Security promoted to top-level**; **≤2 nesting levels**; **33 redirect tests** preserving
    every deep link + anchor; `PUT /api/settings` deep-MERGE intact. Fixed the **auto-close
    dead-field** bug (the flagship toggle wrote a field `decide()` never read → now writes
    `prefs.auto_close`, the exact field `decide()` reads; `decide()` byte-identical).
  - ☑ **G4/G5 denser wide dashboard + compact hero** (`f50e0b2`) — a `PageContainer`
    wide/fluid mode killed the `max-w-[1400px]` cap → a **three-zone** layout (G4); the ~176px
    `HeroPanel` merged into a **~52px `PageHeader`** (G5); `KpiTile` delta-by-sign fix.
  - ☑ **G6 rules customization** (`b661bc8`) — a **Detection & Rules** home over **3 tiers**
    (detection-match/threshold · anomaly/baseline · case-automation), a **polymorphic editor**
    + flat condition builder, a **Test/Preview vs. recent data** that **NEVER calls `decide()`
    / NEVER bills the LLM** (backed by the new read-only `POST /api/triage/preview-decision`
    wrapper over the pure `decide()`), a **version ledger + rollback** (`stores/rule_versions.py`),
    threshold `NumberField`/`LabeledSlider`, asset/SLA/priority/suppression editors. Backend
    `api/routes_rules.py`; new webui `soc/rules/*`.
  - ☑ **G7 custom dashboards** (`830e836`) — a **widget registry reusing the existing
    tiles/charts**, a per-user drag/resize grid (**`react-grid-layout`, LAZY edit-mode only**),
    a **zero-migration `DashboardStore`** (`stores/dashboards.py`, KV-doc), per-role defaults +
    clone-to-customize (`UserPrefs.dashboards` + `CustomizationConfig.default_dashboards`).
    Backend `api/routes_dashboards.py`; new webui `soc/dashboard/*` + `pages/Dashboards.tsx`.
    (Delivers the Tier-3 #11 "Dashboards builder" backlog item.)
  - ☑ **G8 loose coupling** (`d3801f9`) — a single **`FEATURES[]` registry** (`soc/registry.ts`)
    deriving **nav + routes + palette**; `useNavigate()` replaces the `onNavigate` prop-drill;
    **`React.lazy` code-splitting restored** (entry **537 → 264 kB**); `routes.py` **decomposed
    into domain routers — paths byte-identical**; a generic `EntryPointRegistry`, `Protocol`
    narrowing, and **`openapi-typescript` type generation**; typed config endpoints (baseline/
    campaign/batch); new `soc/hooks/*`.
  - ☑ **G9 a11y + adversarial audit** (`a9e2b49`, `8b91fc0`, `05552c7`) — `SEMANTIC_ICON`
    non-color signalling, **WCAG-2.2** criteria, **`jest-axe`**, **20 `jsx-a11y` rules at
    error** (findings **48 → 0**), `Field` labels associated, flaky tests stabilized. A
    **16-dimension adversarial audit → 23 findings, 9 must-fix, ALL resolved + regression-
    tested** (C1 dashboards couldn't persist · H2 rules verdict case-bug · H3 a dashboards
    path billed the LLM · H4 19 unnamed comboboxes · M1–M4) + a polish sweep (P1–P18).
  - ☑ **Bugs fixed (from the maps + audit)** — beyond auto-close/KpiTile above: wizard
    cosmetic demo toggle · clipboard-over-http · misc-prefs clobber · automation impossible-
    verdict · roles perm mismatch · no-confirm destructive close (now `ConfirmDialog`-gated) ·
    campaigns read-perm gate · dead `initAdmin` stub · `request_approval` dead-end · tuning
    row always-"Active" · a SQL sort no-op · a `derive_priority` disagreement.
  - ☑ **Deps** — **removed `framer-motion`** (zero importers); **added `react-grid-layout
    ^2.2.3`** (runtime, LAZY edit-mode only); dev-only `@fontsource-variable/inter`,
    `@fontsource/jetbrains-mono`, `@tailwindcss/container-queries`, `openapi-typescript`,
    `jest-axe`/`@axe-core`, `eslint-plugin-jsx-a11y`. Backend **zero new runtime deps**.
- ☑ **Round 4 — "fix the logic, fine-tune the product" (3 bugs + 12 requests, Waves 0–6)**
  (branch `Testing`; backend **1234 → 1461 pytest** green (W0 1235 · W1 1253 · W2 1263 ·
  W3 1371 · W4 1437 · W6 1461) + webui tsc/vite clean + **205 → 273 Vitest** green; eslint
  **0 `react-hooks/rules-of-hooks` errors**; **additive + default-OFF, zero new runtime deps,
  `engine/case_manager.py` byte-identical throughout (#3)**, #6 one-ledger-write-per-call
  preserved, the 12 non-negotiables held. Design + what-shipped:
  `docs/research/2026-07-round4/`. Commits `3aeab6c → 41ee54b → f7509a3 → b07f172 →
  11ea46e → 3c68cf5 → 1df27ac` (+ the docs wave `068ede4`). Since merged + pushed to
  `origin/Testing` (superseded by Rounds 5–9c above).
  - ☑ **3 bug fixes** — (1) **single-source poller** → NEW `engine/poller_manager.py`
    fans out over EVERY enabled PULL source (per `{source.id}:{feed.id}` cursor + legacy-
    `"primary"`-cursor-collision guard + per-`cluster_signature` in-flight lock so concurrent
    sources never duplicate a case, #4); (2) `claude-opus-4-8` mispriced $15/$75 → **$5/$25**
    + cache/batch rates now applied + wired the dead `providers.with_retry()`; (3) `acknowledge`
    → `CaseStatus.INVESTIGATING` (was `None`).
  - ☑ **Adaptive threshold auto-tuning** — `engine/threshold_tuner.py` + `stores/tuning.py`:
    nightly deterministic observer (Wilson-LB + min-samples + EWMA + shadow-eval), bounded +1
    rule-`n` / feed `severity_floor` with `ActionType.TUNING` audit + rollback; DROPs → HITL
    Proposal; config-writer only, NEVER imports `decide()`/risk/signature; **default OFF**.
    *(Round 10: flipped the observer to **default ON** as part of the autopilot bundle,
    with `shadow_eval` force-on. The current policy additionally learns only from
    analyst-confirmed outcomes and routes changes to Approvals by default.)*
  - ☑ **Two-tier alert/event ingestion** — `engine/event_detection.py` (EVENT-feed cheap-first
    funnel: pre-aggregate → rules → anomaly → batched Haiku detection) whose survivors re-enter
    the SAME correlate/decide pipeline (#3/#4), #9-fenced, #7 aggregate-only; ALERT feeds stay
    realtime per-alert. Gated default-OFF (engages only when batch + baseline both enabled).
    *(Round 10: `background_scan_enabled` flipped to **default TRUE** — comprehensive
    ingestion now runs this funnel on every EVENT-role feed by default, risk-gated at
    `auto_investigate_risk_floor` [default 70] before it reaches the strong LLM; ALERT
    feeds still bypass the gate entirely and correlate in `mode=EVERY`.)*
  - ☑ **Daily campaign correlation** — `engine/campaigns.py` + `stores/campaigns.py`:
    deterministic shared-entity graph → `Campaign` objects that only REFERENCE `case_ids`,
    never re-clusters/closes (#4). *(Round 10: **default ON** via the autopilot bundle.)*
  - ☑ **Entity baseline** — `engine/baseline.py` + `stores/baseline.py`: online EWMA/EWMV +
    168 hour-of-week buckets + bounded t-digest + modified-z |M|>3.5 (warm-up 3× period,
    H=14d); pure producer, never reads `decide()`. *(Round 10: the producer + a new
    silent-source detector are **default ON**; baseline still only *drives* investigation
    as an explicit opt-in.)*
  - ☑ **Batch/flex + broadened model catalog** — `llm/batch.py` (`BatchProvider` SPI:
    Anthropic Message Batches + OpenAI Batch + `flex`; custom_id-keyed idempotent) +
    `stores/batch_jobs.py`; cache-rate application in `pricing.cost_for` + provider cache-token
    extraction (one UsageDoc/result, #6); corrected pricing + cache/batch columns in Models.
  - ☑ **Unified logs** — `GET /api/logs` scatter-gather over browse-capable sources
    (per-source provenance, secret-free, read-only #1) + a webui `UnifiedLogsSheet`.
  - ☑ **Reset + OOBE** — `engine/reset.py` + `routes_reset.py` (tiered cases/sources/factory,
    admin + fresh-auth, type-to-confirm; env secrets byte-identical across ALL tiers,
    airtight-tested; ledger + audit survive the cases tier) + `routes_setup.py` OOBE
    first-super_admin (strong-pw, self-locking).
  - ☑ **Login white-label** — `BrandingConfig.login_*` bounded plain-text hero/illustration
    (no raw HTML/SVG, #9) + a webui `BrandHero`.
  - ☑ **Terminology cleanup** (UI/docs only; wire keys + aliases kept) — event/detection/
    alert/case/campaign; "correlate" → Auto-investigate/clustering/campaign-correlation;
    "rule" → detection-rule/case-automation (`AutomationRule` → `CaseAutomationRule` alias,
    wire key `threshold_automation` unchanged).
  - ☑ **UI consolidation + surfaces** — cleaner CaseDetail (single primary CTA + unified
    Close-with-disposition, posts the existing close → `decide()`, #3); analytics declutter
    (Cost as the single home); new tuning/campaigns/baseline/batch surfaces + a DangerZone
    reset panel. 6 new API routers mounted under `require_auth` (routes_tuning/campaigns/
    baseline/batch/reset/setup); gated background schedulers (nightly tuner / daily campaign /
    batch poller) spawn-but-sleep when disabled (byte-identical default-off boot).
  - ☑ **W6 adversarial audit + harden** — a 16-dimension audit → **16 confirmed / 4 refuted**,
    all fixed + regression-tested (+24 tests). 2 HIGH: a per-`cluster_signature` `asyncio.Lock`
    on the ONE pipeline serialises find-open→save so concurrent sources create exactly one
    case (#4); the EVENT-detection funnel now REALLY creates cases (survivors persist as
    `BatchJob.candidates` and re-enter via `register_candidate` + `investigate_cluster`).
    Others: OpenAI prompt-cache no longer double-billed; legacy public `/api/setup/init-admin`
    removed (bypassed the strong-pw policy); batch dedup made an atomic CAS claim-before-bill
    (#6); t-digest centroid count bounded. **Deferred:** admin-page consolidation-redirects (#4)
    + the dead `api.setup.initAdmin` webui stub.
- ☑ **Round 3 — "useful, distinctive, fine-grained" overhaul (12 requests, Waves 0–4)**
  (branch `Testing`; **1109 backend tests green** (794→802→900→1074→1109 across the
  waves) + webui tsc/vite clean + **175 Vitest** green (86→175); **additive, zero new
  runtime deps, #3 `decide()` byte-identical, #6 one-ledger-write-per-call preserved**,
  the 12 non-negotiables held — #9 untrusted-fencing upheld on every new
  user/source/AI-influenceable field). Design: `docs/research/2026-06-round3/PROPOSAL.md`;
  what-shipped: `docs/research/2026-06-round3/IMPLEMENTATION.md`. Commits
  `bffe4b8 → 59c2999 → 2295363 → 8b25ca2 → 3610147` + the live-wiring/security/docs wave.
  - ☑ **W0 hot-file foundations** (`bffe4b8`) — additive `Case` advisory axes (severity/
    impact/urgency/priority bands + sources) + SLA datetimes; 11 model classes + 4 enums
    + 8 KV-namespace triples + 4 Preferences blocks (sla/priority_matrix/budget/realtime)
    + `BrandingConfig` material/theme tokens + `EnrichmentConfig`/`RBACConfig` carriers +
    13 optional `Secrets` provider slots; webui route code-split (`React.lazy` + manual
    chunks; entry 444 KB → 63.75 KB gz). `case_manager.py` byte-identical (guard test).
  - ☑ **W1 shared substrate** (`59c2999`) — 8 KV stores; the `EnrichmentProvider` SPI
    (`enrichment/`) with AbuseIPDB+VirusTotal refactored behind it (`enrich_ip()` alias +
    `max()` aggregation byte-identical, weighted `fusion` opt-in); the multiplexed SSE
    `EventBus` (`realtime.py`) + `GET /api/events` (default OFF) + nginx location; the
    RBAC resource-vocab split + `effective_matrix()` custom-role/inheritance/DENY-wins +
    the opt-in `can_object()` row-scope hook (OFF).
  - ☑ **W2 backend feature logic** (`2295363`) — #5 posture (`engine/metrics` MTTA/MTTR/
    dwell + `engine/mitre_coverage`; `routes_metrics`); #11 standup (`engine/shift_report`
    folded into `StandupService`, #7 intact; `routes_standup`); #7 enrichment (17 providers
    + multi-indicator + rate guard; `routes_enrichment`); #9 models (provider registry +
    `model_registry.json` + `PriceOverlayStore` + `engine/budget` BudgetGate; `routes_models`);
    #8 in-app (`InAppChannel` → `InboxStore`; `routes_inapp`); #4 collaboration (threaded
    human/ai/system messages + reactions + tasks + @mentions; `routes_cases_collab`); #12
    triage (`engine/priority` + a typed ReAct timeline w/ a distinct deterministic DECISION
    step; `routes_triage`); #6 roles (`routes_roles` CRUD + preview/simulate + assign).
  - ☑ **W2.5 backend gap-closure** (`8b25ca2`) — cloud LLM providers first-class
    (`Provider` widened to azure/bedrock/vertex/openai_compatible; `ModelConfig.base_url/
    api_version/region` + 12 cloud/enrichment `Secrets`; gateway SigV4 for Bedrock); the
    `ProjectHoneypotProvider` + abuse.ch Auth-Key; server-side custom-role enforcement in
    `deps._enforce` (`can_for_roles`); an autouse `conftest` network guard (offline tests).
  - ☑ **W3 webui surfaces** (`3610147`) — hamburger `NavSidebar` (2 width states, Cmd/Ctrl+B,
    disclosure children) + `NotificationBell`; Settings card-grid + sticky save +
    `BrandingEditor` (tokens/presets/material); Roles matrix editor (grants/denies/inherits
    + preview/simulate + lockout guard); a standalone **Models** admin page (capabilities +
    price edit + test-call + cost estimator + budget burn-down); Metrics Operational/
    Performance/Posture tabs + MITRE heatmap; Standup attention queue + acks; CaseDetail 4
    honest chips + `TraceTimeline` + threaded collaboration; Inbox + NotificationPrefs;
    `EnrichmentProvidersEditor`. ONE theme-tokens precedence resolver; `GlassSurface`
    (reduced-transparency fallback). #9 audit PASS (no `dangerouslySetInnerHTML` on data).
  - ☑ **Security fix (ship-regardless)** — inverted RAG-knowledge fencing to a TRUSTED
    allowlist: only built-in/verified corpus is trusted, operator-imported docs are fenced
    UNTRUSTED before any prompt (closes an OWASP-LLM01 prompt-injection gap; no behavior
    change for legitimate content).
  - ◐ **W4 live wiring + polish (in progress this wave)** — publish SSE frames from the
    poller/dispatch/pipeline (webui `EventSource` w/ polling fallback), `PUT /api/branding`
    contrast computation, distinctive-UI polish + WCAG 2.2 pass, docs sync (this entry).
- ☑ **Round 2 — 7 waves (W1–W7c) + audit/remediation** (branch `Testing`; **794
  backend tests green** (649→772 across the waves, then →794 with the audit
  remediation) + webui tsc/vite clean + **86 Vitest** green; **additive, zero new
  runtime deps, #3 `decide()` byte-identical** — Demo Mode uses a sandboxed policy
  copy — and #9 untrusted-fencing held on every new user/source-influenceable field).
  Design + audit: `docs/research/2026-06-round2/`.
  - ☑ **Final — adversarial audit + remediation** — a 16-agent audit fleet
    (`ROUND2_AUDIT.md`) → 8 confirmed RBAC/poller/gauge fixes (`aae7a76`) + a
    HIGH/MEDIUM remediation pass (`763ded9`, +22 tests: #4 feed-cursor starvation,
    demo-chat isolation, env single-admin token-version lockout, `set_status→RESOLVED`
    RBAC gap, email `text_safe`/`{{{ }}}`/branding-SVG hardening) and a strengthened
    authZ-coverage CI test (fails if any non-GET `/api` route lacks an authZ gate).
  - ☑ **W1 Bug fixes** — RiskGauge Active-Risk-Index glitch, MFA-QR copy, duplicate
    close X, chat framing, store-degraded UX; presentational + optional additive
    `/api/health.persistent`. No data-model change.
  - ☑ **W2 Login redesign + account self-service** — 2-column split login (the
    existing 4-mode form + handlers verbatim) + self-service profile
    (`display_name`/`alias`/`avatar`/`alt_email`/`timezone`/`locale`/`prefs`) on the
    `User` model (all defaulted → no migration; `User.public()` still hides secrets).
    Avatar validator (png/webp/jpeg data-url, magic-byte sniff, ≤64 KB). Endpoints
    `GET/PUT /api/account/me`, `PUT /api/me/avatar` (env-managed → 400).
  - ☑ **W3 Sessions + access policy** — ACCESS token gains `sid`+`tv`; a KV-backed
    `SessionStore` (`stores/sessions.py`, survives `_wire()`) enforces idle/absolute/
    revocation in the async `require_auth` (NOT the sync `verify()`); refresh rotation
    + replay/theft detection; token policy on Preferences; `require_fresh_auth(window)`
    step-up. Endpoints `POST /api/auth/{refresh,reauth}`, `GET /api/sessions`,
    `POST /api/sessions/{sid}/revoke`, `POST /api/sessions/revoke-others`, admin
    `GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`,
    `POST /api/admin/users/{username}/revoke-all`; logout revokes current sid; session
    created at all 3 cookie-set sites (login/mfa/sso).
  - ☑ **W4 Settings IA consolidation** — two-scope (Personal Account / Organization)
    Settings tree; Users/Security/SSO + Profile/Account/Preferences/Sessions moved INTO
    Settings (RBAC-aware); standalone admin rail group dropped; near-duplicate pages
    folded into tabs (Investigate→Chat segmented control [ONE chat engine]; Cost→Metrics;
    Standup→Overview) under ≤5 nav groups. Pure IA; no new endpoints.
  - ☑ **W5 Demo Mode + Experimental Settings** — reversible tenant state
    (`off|seeded|live`) on `Preferences.demo`; `DemoPullConnector` (`connectors/demo.py`)
    feeds seeded OCSF (`engine/demo_generator.py`) through the REAL pipeline but writes
    to a SEPARATE in-memory store + a deterministic mock LLM (`engine/demo_runtime.py`)
    — **$0, isolated, one-flip reversible**; FP runs the REAL `decide()` against a
    SANDBOXED policy copy, NEEDS_HUMAN stays open. Endpoints `POST /api/demo/{enable,
    incident,reset,disable}`, `GET /api/demo/status` (`demo:manage` for mutations);
    DemoBanner + `SAMPLE` badges + "(simulated)" cost. The version 0.1 live-demo upgrade
    adds bounded Splunk/QRadar/Wazuh/syslog adapters and a guaranteed first incident.
  - ☑ **W6 Source multi-feed** — `IndexPattern`→richer per-feed model (wire key kept) +
    new `ignore` role + per-feed query/field-mapping/`message_field`/`severity_floor`/
    schedule; overloaded `auto_correlate` split into `correlate`+`auto_investigate`
    (behavior-preserving migration); per-feed durable cursor (`{source.id}:{feed.id}`,
    fast vs slow never skip, #4); `severity_floor` blocks auto-forward but NEVER drops
    a candidate (#4). Loose JSON, no migration; `/api/sources` round-trips it.
  - ☑ **W7a Email — Resend + SES + templates** — `ResendChannel`
    (`notifications/resend.py`, HTTPS API, idempotency, retry-only-429/5xx) + an SES
    SMTP preset with an IAM-key→SMTP-password HMAC ladder in `notifications/email.py`;
    stdlib mustache-subset renderer (`notifications/templates.py`, auto-escape +
    `header_safe`/`text_safe`) + 5 preloaded overridable templates;
    `POST /api/notifications/preview?trigger=`.
  - ☑ **W7b Per-user customization** — org Preferences + per-user `UserPrefsStore`
    (`stores/user_prefs.py` over KV; `'default'` when auth off); saved views, table
    column state, terminology overrides, theme. Endpoints `GET /api/prefs/effective`,
    `GET/PUT /api/prefs/user`, `GET/PUT /api/prefs/org` (admin), `GET/POST /api/views`,
    `PUT /api/prefs/user/tables/{table_id}`, `GET/PUT /api/terminology` (PUT admin).
  - ☑ **W7c UX — command palette + global search + bulk actions + audit viewer** —
    Cmd-K palette + global search (`GET /api/search`), multi-select bulk case actions,
    audit-log viewer (`GET /api/audit`).
- ☑ **SOC overhaul — 7 waves (W1–W7)** (branch `Testing`; **649 backend tests green**
  (395→481→527→554→571→600→638→649) + webui tsc/vite clean + **27 Vitest** green;
  **additive, zero new deps, non-negotiable #3 `decide()` byte-identical, auth DEFAULT OFF**):
  - ☑ **W1 Identity** — persisted multi-user (`stores/users.py` over the KV doc store,
    no new index/table) + **6-role RBAC** (super_admin/soc_manager/analyst_tier2/
    analyst_tier1/responder/auditor) + permission matrix + `require_permission` deps +
    React `<Can>` guards; OOBE first-run; seed **Admin/Admin@123** (super_admin) when
    auth enabled. (481)
  - ☑ **W2 MFA + SSO** — stdlib **RFC-6238 TOTP** (vs the official vectors) + inline-SVG
    QR + single-use recovery codes + two-phase login (`auth/mfa.py`,
    `/api/auth/mfa/*`); **OIDC SSO** Google/Microsoft/generic via server-side
    code-exchange + userinfo + group→role provisioning (`auth/oidc.py`,
    `/api/auth/sso/*`). (527)
  - ☑ **W3 Cases** — extended `CaseStatus` (NEW/INVESTIGATING/ESCALATED/ON_HOLD/RESOLVED,
    keeps open/needs_human/closed) + `Disposition` taxonomy + lifecycle actions +
    transition guard + `status_history`; **`decide()` byte-identical**; customizable
    `case-XXXX` nomenclature (`engine/case_id.py` template + KV sequence + preview). (554)
  - ☑ **W4 Notifications** — pluggable `NotificationChannel` + email (stdlib SMTP, 13
    presets) + Slack/Teams/webhook/PagerDuty/Telegram; per-condition triggers +
    dedup/rate-limit/digest; fire-and-forget after `apply()`+save; channel secrets in
    the secret tier (`notifications/`, `/api/notifications/*`). (571)
  - ☑ **W5 Multi-source** — Auto-Correlate toggle per source AND per sub-source
    (`IndexPattern`); opt-in cross-source correlation linking RELATED cases by shared
    entity (ip/host/user/file_hash/domain); per-source mapping overrides + connector
    `setup_help` + `HelpTip`s + analyze-sample. (600) *(Round 10: cross-source
    correlation flipped to **default ON** via the autopilot bundle; the toggle itself
    is unchanged, only its factory value.)*
  - ☑ **W6 Automation + Threat-context** — **#3-safe** threshold automation
    (`engine/threshold_automation.py`: tag/recommend/notify/run_playbook/request_approval
    → HITL proposal; **never sets status**); run-a-playbook (context-only
    re-investigation); threat-context panel (`engine/threat_context.py`: IOC reputation
    + bundled **MITRE ATT&CK 697 techniques** in `threat/` + related cases, fail-open);
    resolved-case → RAG knowledge loop. (638) *(Round 10: the threshold-automation
    engine itself is now **default ON** with an empty ruleset — the HITL
    tag/recommend/notify/run-playbook/request-approval machinery runs by default, it
    just has no rules to match until an operator adds one; default notify/run-playbook
    rules stay explicit opt-in.)*
  - ☑ **W7 Settings + UI** — consolidated Settings (13 sections / 4 nav groups) +
    `GET /api/settings/schema`; RiskGauge redesign (fixes Active-Risk-Index glitch);
    skeleton/shimmer loading + staggered reveals; 8px grid; WCAG AA. (649)
- ☑ **Browse a source's logs + read-only Test-connection & per-source TLS fixes**
  (branch `Testing`; **349 tests green** (+9, `test_browse_and_connection.py`);
  webui clean, no new deps; additive, spine + the 12 non-negotiables intact):
  - ☑ **Browse logs per source:** `GET /api/sources/{id}/logs?limit=&query=&from=&to=`
    (auth-protected) — pull = bounded (≤200) read-only field-mapping/TLS-aware scoped
    search; push = in-memory live-tail ring buffer (≤500/source) in `IngestService`.
    Rows `{ts,source_ip,user,host,rule,severity,message,_raw}`, secrets never
    returned; `capabilities:["browse"]` on pull manifests + auto-applied to receivers.
    webui `SourceLogsFlyout` (table + expandable `_raw`, search, `EuiSuperDatePicker`,
    10s live-tail) behind a capability-gated "Logs" button.
  - ☑ **Read-only Test-connection:** `ElasticConnector.test_connection` runs the
    scoped read first (authoritative); `ping()` is only the extra `cluster_monitor`
    signal. `ConnectionTest` +`mode`/`cluster_monitor`; webui read-only/full success
    callout.
  - ☑ **Per-source TLS:** `AppState.es_client_for_source()` builds a per-source ES
    client honoring `es_verify_certs`/`es_ca_cert`/`es_url`/`es_api_key` (mgmt key
    dropped); used by the primary log source + browse endpoint.
- ☑ **Explainability + RAG management + agent memory + dashboards/collaboration**
  (branch `Testing`; **340 tests green**; webui clean, 2330 modules; additive,
  spine + the 12 non-negotiables intact). Three additive backend features + a webui
  surface pass:
  - ☑ **RAG ingest + management + visibility** ("see the RAG"): `engine/chunking.py`
    (`chunk_text`); `VectorStore` ABC `list_documents/list_chunks/delete_document/
    stats` (InMemory + ES `dense_vector` + SQL); `RagService.import_document/
    list_documents/get_document/delete_document/rag_stats` (seed sources
    `runbook/mitre/suppression/resolved_case` guarded unless `force=true`); routes
    `GET /rag/stats`, `GET /rag/documents`, `GET /rag/documents/{id}`,
    `POST /rag/import`, `DELETE /rag/documents/{id}?force=`, `GET /rag/search`.
    `test_rag_management.py` (11).
  - ☑ **Agent memory (Claude.ai-style durable operator facts):** `stores/memory.py`
    `MemoryStore` over the existing KVStore (no new index/migration; `EsKVStore` /
    `SqlKVStore` adapters), `MemoryEntry` model; injected into investigations + chat
    as a DISTINCT `<<<MEMORY>>>` TRUSTED block (precedence
    policy>base>playbook>MEMORY>untrusted; `fence()` neutralises forged markers);
    never overrides the deterministic CaseManager. Edit via REST
    (`GET/POST/PUT/DELETE /memory`, human) or chat ("remember:"/"forget", agent,
    audited); chat gained `memory_action` + `memory_suggestion`.
    `test_memory.py` (14).
  - ☑ **Case explainability:** `ActionType.CONTEXT` audit record (persona/playbook/
    memory/knowledge/enrichment) + reasoning excerpt on VERDICT; `GET /cases/{id}/
    rationale` returns the pure "why" object incl. the DETERMINISTIC
    `decision_rationale`. `test_explainability.py` (5).
  - ☑ **webui:** new **Knowledge** + **Memory** pages (new Platform nav); case
    **"Why"** tab; chat memory action/suggestion UI; Metrics "Knowledge base &
    memory" section + Overview RAG/memory tiles; Cases-list collaboration (sortable
    assignee, tags + comment-count badges, filters). UNTRUSTED-safe (#9); no new deps.
- ☑ **Wave 3 — analytics + eval loop + collaboration + white-label UI + CI** (branch
  `Testing`; 310 tests green; webui clean). Metrics dashboard (`engine/metrics.py`,
  `GET /api/metrics`); AI-decision feedback/grading (`/cases/{id}/feedback`,
  `/feedback/stats`); case collaboration (tags/comments/assignee); org branding
  white-label (`BrandingConfig`, runtime-themeable accent, logo upload, branded
  shell/login); case export (json/md); case hover preview; broad UI polish; and a
  GitHub Actions CI merge gate (`.github/workflows/ci.yml`).
- ☑ **Vigil-inspired overhaul — Wave 2** (additive; 300 tests green; webui clean).
  Markdown playbook engine (`app/playbooks/` + `backend/playbooks/*.md`,
  deterministic selection, atomic reload, `<<<PLAYBOOK>>>` injection distinct from
  fenced evidence, 3 seed playbooks, `GET/POST /api/playbooks*`); Case-Manager
  `AutoClosePolicy` (per-verdict-class; TP opt-in off by default; NEEDS_HUMAN never;
  `fp_auto_close` migrated); optional auth (default OFF — no-auth version preserved):
  `app/auth/` (PBKDF2 + stdlib HS256) + `app/middleware/` + router-level
  `require_auth` + CI route-coverage test; webui login gate + Playbooks/Agents catalog.
  - ☑ Wave-2 leftovers: approval workflow ☑ DONE (HITL `Proposal` + admin approve;
    extended by W6 threshold `request_approval`). Pre-flight projected-cost gate +
    `$`-budget ceiling ☑ DONE (Round 10) — `BudgetConfig` is now `enabled=True` by
    default (`daily_usd=$10`, `soft_warn_pct=0.80`, `on_exceed="block"`) so every tenant
    gets a hard preflight spend backstop out of the box; warning-only behavior is opt-in.
- ☑ **Vigil-inspired overhaul — Wave 1** (additive, spine intact; 244 tests green;
  webui clean). Multi-agent persona roster (`agents/personas.py`, `GET /personas`),
  plain-text runbooks (`runbooks/*.md` + `engine/runbooks.py`, `GET /runbooks`),
  hybrid BM25+vector RAG (`tools/rag.py`), tool safety tiers (`ToolTier`), hardened
  fencing + `pricing_source` provenance. Legacy Kibana plugin archived →
  `archive/kibana-plugin/`. Full study + multi-wave plan in `docs/VIGIL_STUDY.md`.
  - ☑ **Wave 2:** ☑ CI route-coverage test; CSRF/headers/rate-limit; ☑ auth-on
    profile available (DEFAULT OFF, `TLSOC_AUTH_ENABLED=true` → RBAC/MFA/SSO +
    Admin/Admin@123 seed — SOC overhaul W1/W2); ☑ approval workflow (HITL proposals);
    ☑ pre-flight projected-cost gate + `$`-budget ceiling (Round 10 — see the Wave-2
    leftovers note above; default-enabled now, `on_exceed="block"` still opt-in).
  - ☑ **Wave 3:** durable operator memory + case explainability + RAG management/
    visibility DONE. Also DONE via the SOC overhaul: a real bundled **MITRE ATT&CK**
    module (`threat/mitre_techniques.json`, 697 techniques) + **HITL / Auto-Ops webui
    surfaces** (Approvals/Users/Security pages + threshold automation). Still ☐:
    temporal KG + cross-case memory linkage; a detection-rule RAG corpus.
  - ☐ **Wave 4 / Epoch E:** ARQ workers + KEDA; Helm chart; OTEL + Grafana.
- ☑ **UI redesign** — new shared design system (`public/lib/format.ts`,
  `public/components/ui.tsx`, expanded `public/index.scss`) and a presentation-only
  refresh of every surface: Case Board (drag handle + per-card actions menu fix the
  "can't move cards" issue; scroll lane; accented cards), Automated Scans (KPI strip
  + card grid), Cost & Tokens (KPI tiles + weighted breakdowns + bar list), Settings
  (section icons + EuiHealth credentials, all fields preserved), app shell (per-tab
  icons + nomenclature), and Standup/Investigate/Case-detail/Verdict-card
  consistency. No new deps, no logic/contract change. 6 parallel sub-agents +
  orchestrator review; tsc clean + 8.19.12 zip rebuilt + verified.
- ☑ **Cycle 3 features** (C3-1..C3-7): config-driven rule catalog (13 event.module
  + 5 ModSec sub-rules, version-guarded seed), Board Kanban tab, agent trace
  (`GET /cases/{id}/trace`), re-investigate-in-place (`POST /cases/{id}/investigate`),
  resolved-case RAG baseline on close (note textarea), expanded OpenAI catalog +
  per-rule model overrides, merged case-history timeline — committed on
  `claude/epic-cannon-p5z5ha`.
- ☑ **Cycle 2 bug fixes** (BUG-1..BUG-5 + provenance IMPROVEMENT): chat 2-turn
  analysis; investigate lookback pref + auto-widen ladder + neutral empty-state;
  Standup `cases` object + error boundary; native header chat button; sliding
  correlation look-back; manual-investigation TriggerReason/origin_surface/
  normalized reproduce_query — committed.
- ☑ Offline verification: 124 backend tests green, plugin `tsc` clean, 8.19.12 zip
  rebuilt + verified (~68 KB). No live-stack validation.
- ☑ Docs updated for Cycle 2/3 (USAGE, BUILD, CHANGELOG, ROADMAP + migration note).
- ☑ Coordination + extra docs: CLAUDE/Journal/ENVIRONMENT/ROADMAP, SECURITY,
  RUNBOOK, CONTRIBUTING, CHANGELOG.
- ☑ **P0** (plugin case detail + lifecycle), **P1** (stability/provenance),
  **P2** (risk/timeout/normalize/CIDR) — committed, 60 tests green.
- ☑ **Backend** Features 1-4 (chat context, /api/overview, trigger-reason,
  /api/models) — committed (c572069), tested.
- ☑ **Frontend** Feature 1 (header chat button + context flyout), Feature 4
  (comprehensive settings + per-role models), Feature 3 (trigger-reason render),
  `common/index.ts` sync — committed; **8.19.12 zip rebuilt + verified** (bundle
  present, manifest 8.19.12, header navControl compiled in, 0 backend-URL leak).
- ☑ **Backend P1 RAG** — resolved-case memory, ES dense_vector store, embedding
  guard, min-cosine, richer query, chat grounding — committed (260a170), 69 tests.
- ☑ **Feature 2** — per-log AI overview (Discover doc-viewer tab + in-app button
  → POST /api/overview) — committed; 8.19.12 zip rebuilt + verified.
- ☐ **Historical Feature 5** (archived Kibana-plugin wizard rewrite) — DEFERRED and
  superseded: this item targeted a live 8.19 Kibana-specific flow. The plugin is now
  archived; the standalone Console setup workspace below is the supported path.
- Note: 4 frontend sub-agent runs hit infra failures (rate-limit/watchdog); the
  contract-critical + Feature-2 work was authored directly to guarantee tested
  results.

## EPIC — Vendor-agnostic, self-hosted agentic SOC (approved direction 2026-06-20)

Full design: [`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md).
Locked decisions: canonical schema **OCSF**; internal state **decoupled from ES
(Postgres + pgvector)**; first new connector after ELK+OpenSearch = **Wazuh**;
UI = **standalone web app** (retire the Kibana plugin). The reasoning/agent layer
is already ~90% source-agnostic (`RawEvent` projection + configurable field maps +
MCP-shaped tools); the work is concentrated in 3 seams: query/log-access, internal
storage, and the Kibana-bound UI.

- ☑ **Epoch A — Decouple internal state.** DONE: `StateStore` repositories (Cases/
  Audit/Usage/KV) + a RAG vector store behind ABCs; a SQL backend (`stores/sql/`:
  engine/models/repositories/vectorstore) via SQLAlchemy — **SQLite** for dev/test,
  **PostgreSQL + pgvector** for prod (asyncpg/pgvector imported lazily, only when
  `STATE_BACKEND=postgres`); Elasticsearch remains the default behind the same
  abstraction, selected via `STATE_BACKEND` (`elasticsearch` | `postgres` | `sqlite`).
  A self-hosted deploy can run entirely on Postgres with NO Elasticsearch for the
  app's own state (see `deploy/docker-compose.agnostic.yml`).
- ☑ **Epoch B — Connector SPI + query IR + OCSF.** DONE: `OCSFEvent` (version-
  pinned) + ECS/generic→OCSF mappers; `RawEvent.from_ocsf`; `StructuredQuery` IR;
  `PullConnector`/`PushReceiver` SPI + `ConnectorManifest`/`AuthField`; registry
  with `tlsoc.connectors` entry-point discovery; **Elastic + OpenSearch** pull
  connectors (byte-parity); **es_query tool + poller rewired live through the
  connector** (behaviour-preserving); **16 push receivers** (webhook/HEC/syslog +
  Kafka/SQS/Kinesis/EventHub/PubSub/RabbitMQ/NATS/MQTT/Redis/S3/GCS/Blob/file,
  lazy-dep) + format parsers; **push RUNTIME** (POST `/api/ingest/{id}` + asyncio
  receiver lifecycle + shared `IngestService`); per-source secrets; multi-source
  config (`SourceInstance`) + wizard backend; `docs/INGESTION.md`. 192 tests green.
  REMAINING: standup-aggregation + routes entity-path onto the connector; TLS
  syslog; S3 Parquet.
- ☑ **Epoch C — Wazuh connector.** DONE: `WazuhConnector` (`connectors/wazuh.py`)
  reuses the OpenSearch connector plus a Wazuh-alert→OCSF mapper.
- ☑ **Epoch D — Standalone web UI.** DONE: `webui/` (Vite + React + TypeScript +
  **Tailwind + shadcn/Radix** — the sole primary surface; EUI was fully removed in
  the Round-5 UI overhaul) is the standalone SPA. The **first-run setup workspace**
  is four stages (**Workspace → Data sources → AI runtime → Review & launch**) driven
  by connector manifests. It distinguishes Synthetic demo from Live, guards source
  and write-only key drafts, reports full versus limited readiness, and supports a
  non-destructive Settings re-run; the reusable dynamic source form is `SourceEditor` +
  `ConnectorPicker`; a full Sources manager, sectioned Settings (5 groups × 26
  sections), and every analytics surface (Cases/Chat/Investigate/Automated Scans/
  Standup/Cost/Metrics/Dashboards/Detection & Rules/…) are built out — not preview
  stubs. Served as a static `dist/` bundle behind nginx (`tlsoc-webui`, container
  port 8080) with an `/api` proxy to the backend. The legacy Kibana plugin is
  **archived** (`archive/kibana-plugin/`, frozen 2026-06-21, not built/tested/
  shipped) — the standalone webui is the sole primary surface going forward.
- ☐ **Epoch E — Scale-out (as needed):** Kafka/Redpanda buffer; stateless workers;
  semantic cache; batch API; per-tenant keys/budgets; ClickHouse analytics.
