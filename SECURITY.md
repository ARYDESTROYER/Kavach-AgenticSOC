# SECURITY.md — Threat model & security posture

This document describes the security posture of **Agentic SOC** —
a vendor-agnostic, LLM-driven SOC triage tool that runs **next to** your existing
security telemetry as a **read-only consumer**. Because the suite reads
attacker-influenced event data (from any source) and drives Large Language Models
with it, its design treats every external surface as hostile and makes its safety
guarantees **deterministic code**, not model behaviour.

Every claim below is enforced somewhere in the tree; the enforcement point is cited
inline. See also the 12 non-negotiables in [`AGENTS.md`](AGENTS.md) §5,
[`README.md`](README.md), and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (rotation).
New here? Start with [`docs/HANDOFF.md`](docs/HANDOFF.md).

> **Security-relevant additions since Round 2 (running summary — see
> [`CHANGELOG.md`](CHANGELOG.md) / [`Journal.md`](Journal.md) for full detail).**
> **Round 2** (2026-06-30): a server-side **session registry**
> (`stores/sessions.py`) with explicit revocation, per-user **token-version**
> invalidation, and idle/absolute/refresh **token policy**
> (`Preferences.session_policy`); a refresh route that no sign-in can reach (see
> "Refresh tokens" below); step-up re-auth; a fully **isolated** Demo Mode (synthetic data in a
> separate in-memory store with a `$0` deterministic mock LLM, never touching the
> real workload stores or durable poll cursor; lifecycle actions intentionally leave
> a real append-only audit record); auto-escaping/CRLF-safe email
> templates (`notifications/templates.py`); and a **CI-verified** RBAC gate
> (`tests/test_route_auth_coverage.py` fails if any non-GET `/api` route lacks an
> authZ dependency). **Round 3**: the RAG **TRUSTED-knowledge allowlist** was
> inverted to default-deny (§4.3) — operator-imported documents and resolved-case
> text are now UNTRUSTED-fenced instead of trusted verbatim (an OWASP LLM01 fix);
> **19 enrichment providers** (§7) replaced the original 2; fine-grained **custom
> RBAC roles** (inheritance + explicit DENY) layered on the 6 built-in roles.
> **Round 9**: an optional **local/self-hosted LLM provider**
> (`openai_compatible`, e.g. LiteLLM/vLLM/Ollama) lets a deployment run with no
> third-party LLM egress at all (§7). Remaining hardening TODOs (session-store
> optimistic concurrency, multi-generation refresh-reuse detection, MFA-secret
> envelope encryption, `id_token` signature verification) are called out inline
> below and tracked in
> [`docs/research/2026-06-round2/ROUND2_AUDIT.md`](docs/research/2026-06-round2/ROUND2_AUDIT.md).

## 1. Trust boundaries

The suite spans these tiers. Each arrow crosses a trust boundary; the suite
**never** holds a write credential to any log source, and **never** uses a source's
superuser/admin credential at runtime.

```
┌──────────────┐   TLS reverse proxy   ┌──────────────┐                ┌──────────────────┐
│  Analyst     │   (nginx serves the   │  Standalone  │   relative     │  tlsoc-backend   │
│  browser     │ ──SPA + proxies /api─▶│  web UI      │ ──/api/* call─▶ │  (FastAPI +      │
│(React/Tailwind)                      │  (nginx)     │   server-side   │   LangGraph)     │
└──────────────┘                       └──────────────┘                 └───────┬──────────┘
        ▲  booleans only,                                                       │
        │  never secret values            TRUST BOUNDARY 2                      │
   TRUST BOUNDARY 1                        (proxy: no secret in browser)        │
   (untrusted client)                                                          ▼
        ┌──────────────────────────── TRUST BOUNDARY 3 ───────────────────────────────┐
        │  per-source read-only creds      state-backend creds      egress (HTTPS)      │
        │           │                            │                        │             │
        ▼           ▼                            ▼                        ▼             │
  ┌──────────────────────────┐   ┌────────────────────────┐   ┌──────────────────────┐ │
  │ LOG SOURCES (READ-ONLY)  │   │ OWN STATE              │   │ LLM (7 providers)     │ │
  │  pull: ES/OpenSearch/    │   │  ES tlsoc-agent-* OR   │   │ Enrich: 19 providers  │ │
  │   Wazuh; push: webhook/  │   │  Postgres+pgvector OR  │   │  (AbuseIPDB, VT, ...) │ │
  │   HEC/syslog/queues/…    │   │  SQLite                │   │ Cache:  Redis         │ │
  │  — UNTRUSTED DATA        │   │  — suite bookkeeping   │   └──────────────────────┘ │
  └──────────────────────────┘   └────────────────────────┘                            │
        └──────────────────────────────────────────────────────────────────────────────┘
```

| # | Boundary | Posture |
|---|----------|---------|
| 1 | Analyst browser ↔ web UI | The standalone SPA should sit **behind a TLS reverse proxy** with your own auth (the SPA itself is a thin viewer). The UI sees **booleans only** for secrets (`configured ✓`), never values (`config.py:configured_status`). |
| 2 | Web UI ↔ backend | The browser calls **relative** `/api/*` paths; nginx reverse-proxies them to `tlsoc-backend:8088` server-side (`webui/nginx.conf`). The browser bundle contains **no** backend URL or secret (no CORS, no embedded host). |
| 3 | Backend ↔ sources / state / LLM / enrichment | Per-source **read-only** credentials for every log source; a single least-privilege credential for the chosen state backend; outbound HTTPS to LLM/enrichment. **All inbound event data is treated as UNTRUSTED** (§4). |

### 1.1 Privileged update-supervisor boundary

The reference PostgreSQL Compose profile adds one deliberate host-level boundary:
`agentic-soc-updater`. It alone mounts `/var/run/docker.sock`; Docker-socket access
is effectively root-equivalent on the host. The ordinary backend receives only the
private Unix control socket and can request a fixed set of typed operations. The Web
container and browser receive neither socket, registry credentials, host paths,
Compose fragments, image references, nor shell authority
(`deploy/docker-compose.agnostic.yml`, `updater/agentic_soc_updater/service.py`).

The supervisor is part of the trusted computing base. Deploy only the reviewed image,
keep its control socket private to the backend container, restrict host access, and
protect `.env`, updater state, backup, and host-runtime override volumes. Never expose
the control socket or Docker API over TCP. After bootstrap, run Compose only through
`scripts/agentic-soc-compose.sh`; the wrapper preserves the supervisor-written,
digest-pinned active-release override.

Release discovery and installation authority are separate. The configurable Stable
branch is mutable, read-only observation and may only identify a candidate. The
supervisor authorizes installation only after verifying the canonical immutable
GitHub Release plan and Sigstore bundle, tag-bound workflow identity, repository,
commit, signed digest-pinned component images, compatibility, local topology,
durable secrets, backup capacity, and current deployment identity. The plan is
schema-limited data and cannot contain commands, host paths, arbitrary URLs, Compose
fragments, registry credentials, or browser-selected images
(`scripts/build_upgrade_plan.py`, `updater/agentic_soc_updater/contract.py`).

The official supervisor intentionally stores no registry credential. Official
`backend`, `webui`, and `updater` GHCR packages must therefore be public and
anonymously pullable by exact digest; release publication fails closed if that proof
fails, and an update job pulls and inspects every image before changing the running
application. Automatic failure after application switching restores the exact prior
application images but never rewrites PostgreSQL. The verified quiesced dump is
retained solely for explicit break-glass recovery, because automatic restore could
discard a post-snapshot write. V1 plans consequently require
`migration.strategy=none`.

## 2. Read-only, scoped source credentials (generalised principle #1)

The #1 non-negotiable — *a read-only, scoped credential for the agent's log
access* — now applies to **every** connector, not just Elasticsearch:

- **Pull connectors** (Elasticsearch / OpenSearch / Wazuh, future SIEMs) require a
  **read-only** API key/token scoped to the log index/pattern. The Elastic
  connector's manifest spells this out: *"a READ-ONLY API key scoped to the log
  index pattern only (never kibana_system or the elastic superuser)"*
  (`connectors/elastic.py`). The agent's `es_query`/search tools read only — they
  never write a source, and the prompts state the agent can ONLY read data.
- **Push receivers** never hold a source credential at all — the source authenticates
  **to us** (§3.1); the suite has no write path back to the source.

**ES state backend (default) keeps the two-key split.** When `STATE_BACKEND` is
`elasticsearch`, the suite still uses **two physically separate least-privilege
keys** for ES (`es/client.py` `_ro` + `_mgmt`): a read-only key for `all-logs-*`
and a management key for `tlsoc-agent-*`. Neither is `kibana_system` nor the
`elastic` superuser; a missing key yields a clear error, never a silent fallback to
a write credential.

| Key (env var) | Scope | Privileges |
|---|---|---|
| `ES_API_KEY` (read-only log source) | the log index pattern | `read`, `view_index_metadata` |
| `ES_MGMT_API_KEY` (ES state backend only) | `tlsoc-agent-*` | Index: `read`, `write`, `create_index`, `view_index_metadata`, `manage`; cluster: `manage_ilm`, `manage_index_templates`, `monitor` for explicit lifecycle preview/apply |

> A source's superuser/admin credential is used by an operator **once**, to mint
> the read-only key, then never at runtime (non-negotiable #1).

**Connection-test + log-browse stay within the read-only scope.** A pull source's
"Test connection" (`POST /api/connectors/test`) and the per-source **log browse**
(`GET /api/sources/{id}/logs`) both exercise only the **scoped, read-only search** —
the test no longer requires `cluster_monitor`/`ping()`, so a least-privilege
read-only key suffices and nothing needs a broader credential. The browse endpoint
is **auth-protected** (subject to the optional API-auth gate below) and returns
**log data only** — its rows (`ts`/`source_ip`/`user`/`host`/`rule`/`severity`/
`message`/`_raw`) are read from the source via the **per-source read-only ES
client** (honoring that source's `es_verify_certs`/`es_ca_cert`), are **bounded**
(pull: hard-cap 200; push: an in-memory ≤500/source live-tail buffer), and **never
include secret values**. The returned `_raw` document and every field are
attacker-influenceable, so the webui renders them strictly as plain text via
`CodeBlock`/`InlineCode` (`webui/src/soc/components/CodeBlock.tsx`), never
`dangerouslySetInnerHTML` (non-negotiable #9).

## 3. Secrets handling

| Property | Behaviour | Where |
|---|---|---|
| Source | **Environment / `.env`** for global keys; the **secret tier** for runtime/wizard-pushed and per-source values. | `config.py:Secrets` (`SettingsConfigDict(env_file=".env")`) |
| UI exposure | The UI sees **booleans only** (`configured ✓`); secret **values are never returned**. | `config.py:configured_status`; `routes.py` `/setup/status`, `/settings`, `/models` |
| Wizard-pushed global keys | Kept **in process memory only — lost on backend restart** (`state.apply_secrets`); `.env` is the durable path. | `routes.py:setup_secrets` |
| Clearing a key | An explicit `null` **revokes** a key (`exclude_unset`, not `exclude_none`). | `routes.py:setup_secrets` |
| Never persisted | Nothing secret is written to the **state store**, to **git**, or to **logs**. | `config.py` docstring |

### 3.1 Per-source secrets (the secret tier)

A source's secrets — a pull connector's read-only key, a webhook **bearer token**,
an **HMAC shared secret**, a cloud/broker credential — go to a dedicated
**in-memory secret tier** keyed by source id (`Secrets.connector_secrets`,
`set_source_secret`). They are **never persisted** to Preferences or any state
store; only the configured field **names** are recorded on the source
(`SourceInstance.configured_secrets`) and shown in the UI as configured-only
(non-negotiable #10). `POST /api/sources/{id}/secrets` sets/clears them; an empty
value revokes. Because they are in-memory, they must be re-set after a backend
restart (or supplied via env).

> Roadmap: an optional persisted **encrypted** secret store so wizard/per-source
> keys survive a restart. Until then, set durable secrets in `.env`.

## 4. Prompt-injection posture: inbound events are untrusted

All event data is **attacker-influenceable** — and with push receivers, an attacker
may even **POST directly** to an ingest endpoint. The suite treats every
event-derived value as **UNTRUSTED DATA** in prompts:

- Every event normalises to **OCSF** first (`ocsf/`). Whatever a connector cannot
  map deterministically lands in the first-class **`unmapped`** catch-all, and the
  original source record is kept in **`raw_data`** for audit/repro
  (`ocsf/model.py`). **Both `unmapped` and `raw_data` are attacker-influenceable**
  and are treated as untrusted data exactly like any mapped field.
- Every value placed in a prompt is wrapped in labelled, delimited fences
  `<<<UNTRUSTED_LOG_DATA>>> … <<<END_UNTRUSTED_LOG_DATA>>>`
  (`constants.UNTRUSTED_OPEN`/`CLOSE`) via `fence()` in `agents/prompts.py`.
- **Every** system prompt carries the security note telling the model to treat
  fenced content strictly as DATA and **never** follow instructions, URLs, or
  commands inside the fences (`prompts._INJECTION_NOTE`).
- Fencing applies to **everything attacker-influenceable**: entity values, rule
  names, sample event JSON (including `unmapped`/`raw_data`), enrichment, standup
  aggregate keys, and — for chat — screen-context, selection, and query inputs
  (non-negotiable #9).

### 4.1 Inbound push authentication

Push receivers authenticate the sender before parsing a single byte
(`connectors/receivers/webhook.py`, `verify_auth`):

- **`bearer`** — requires `Authorization: Bearer <token>` (also accepts `Splunk
  <token>` / a bare token) to equal the source's `token` secret, compared with
  **`hmac.compare_digest`** (constant-time) to avoid timing oracles. An unset token
  rejects everything.
- **`hmac`** — requires a hex **HMAC-SHA256 of the exact request body** in the
  configured `signature_header` (a `sha256=` prefix is tolerated), keyed by the
  source's `shared_secret`, again compared constant-time.
- **`none`** — accepts anything reachable; use **only** behind a trusted proxy.

A failed check raises `PermissionError`, mapped to **HTTP 401** by the route; the
secret never leaves the secret tier. Parsing of an authenticated body never raises
(malformed bodies become best-effort events) — but the parsed content is still
fenced as untrusted (§4).

### 4.2 The model never auto-acts

The verdict is **advisory only**; the consequential decision is deterministic code:

- The **verdict** (`TRUE_POSITIVE`/`FALSE_POSITIVE`/`NEEDS_HUMAN`) is an LLM
  *recommendation* (`constants.Verdict`).
- The **close/escalate decision** is a pure function, `decide()`, in
  `engine/case_manager.py`, over `(verdict, confidence, risk_score, policy)` —
  never raw LLM output, never playbook text.
- **Only `NEEDS_HUMAN` (or a missing verdict) is the code-enforced,
  non-tunable never-auto-close case.** `CaseManager.apply()` carries a
  defence-in-depth assertion that raises if anything tries to close one:
  `AssertionError("Invariant violated: attempted to auto-close a NEEDS_HUMAN
  case")`. This guard protects `NEEDS_HUMAN`, not `TRUE_POSITIVE` (see below).
- **FALSE_POSITIVE auto-close is ON by default.** The live `AutoClosePolicy`
  (`config.py`, `Preferences.auto_close`) auto-closes a FALSE_POSITIVE when
  `false_positive.enabled` (default **true**) AND `confidence >=
  min_confidence` (default **0.85**) AND `risk_score <= max_risk_score`
  (default **30**), then only with an `objection_window_minutes` (default
  **1440**, i.e. 24h) during which a human can reopen it. This is the live
  knob — the deprecated `FpAutoCloseConfig` is migrated forward into it
  automatically for old persisted preferences.
- **TRUE_POSITIVE auto-close is a real, opt-in policy knob — OFF by
  default**, not "never." An operator can enable
  `auto_close.true_positive` (default `enabled=false`, `min_confidence=0.95`,
  `max_risk_score=10`, `objection_window_minutes=4320`); while disabled (the
  default), every TRUE_POSITIVE routes to a human. Unlike `NEEDS_HUMAN`, there
  is no code-level ban on auto-closing a TRUE_POSITIVE — the protection is a
  conservative default-off *policy*, tunable by an operator who accepts the
  trade-off.
- Anything else — `NEEDS_HUMAN`, a missing verdict, or any LLM/source/tool failure —
  **fails safe to a human**: an alert is never dropped.

### 4.3 TRUSTED operator context (memory + RAG) — informs, never decides

**Agent memory** (durable operator facts, `stores/memory.py`) is injected as
**TRUSTED** context in a `<<<MEMORY>>>` block, distinct from the fenced
UNTRUSTED evidence. RAG knowledge is **not** uniformly trusted — it is split by
an explicit, default-deny allowlist:

- **The TRUSTED-knowledge allowlist is `runbook` / `mitre` / `suppression`
  ONLY** (`tools/rag.py:TRUSTED_KNOWLEDGE_SOURCES`, `is_trusted_knowledge()`) —
  the system-verified seed corpus: shipped operator runbooks, the bundled
  MITRE ATT&CK technique descriptions, and the suite's own suppression
  guidance. These are rendered as TRUSTED reference material because they are
  authored/verified by the system, not reachable by an attacker or an
  arbitrary operator upload.
- **Everything else retrieved by RAG is UNTRUSTED and fenced exactly like log
  evidence**, including operator-**imported** documents (`source="imported"`,
  `RagService.import_document`) and **resolved-case** text
  (`source="resolved_case"`, prior-case baselines/notes) — both are
  default-deny under the allowlist and wrapped in the same
  `<<<UNTRUSTED_...>>>` fences (§4) before reaching a prompt. This closes an
  **OWASP LLM01** (prompt-injection) gap: an operator-imported threat-intel
  document, or text an attacker can influence via a prior case's notes,
  cannot smuggle instructions into the model as "trusted" text.
- **They inform the LLM only; they can NEVER override the deterministic Case
  Manager.** Memory and TRUSTED knowledge can shape the model's *verdict
  recommendation*, but the consequential close/escalate decision is still the
  pure function in `engine/case_manager.py:decide` (§4.2, non-negotiable #3).
  No operator fact and no retrieved snippet — trusted or not — can auto-close
  a case.
- **Precedence is fixed and explicit:** `policy > base-prompt > playbook >
  MEMORY > untrusted`. TRUSTED knowledge sits above the fenced UNTRUSTED
  evidence but below the immutable policy/base prompt.
- **Forged TRUSTED markers in event data are neutralised.** `fence()` in
  `agents/prompts.py` escapes any attacker-planted `<<<MEMORY>>>` (and
  `<<<PLAYBOOK>>>`) markers in log-derived data, so untrusted content cannot
  smuggle itself into a TRUSTED block.
- **Provenance is preserved.** Memory carries its `source` (`human` for
  explicit REST edits, `agent` for chat "remember:" actions — which only
  store user-directed text and are audited); agent-authored memory text and
  UNTRUSTED RAG chunk text are rendered in the UI as plain text via
  `CodeBlock`/`InlineCode` (never `dangerouslySetInnerHTML`), so a poisoned
  fact/snippet cannot inject markup into the analyst's browser
  (non-negotiable #9). The `/api/cases/{id}/rationale` "Why" view surfaces
  exactly which memory/knowledge a case used and presents the
  **deterministic** decision rationale prominently.

## 5. Read-only guarantee, audit, cost ledger, caps & kill switch

| Control | Guarantee | Where |
|---|---|---|
| Read-only sources | The suite **never writes to a log source**. Pull tools read only; push receivers have no write path back. | `connectors/*`, `tools/es_query.py`, `prompts.INVESTIGATOR_SYSTEM` |
| Audit trail (append-only) | Every agent action is audited, append-only. Action types: prompt, es_query, tool_call, context, verdict, decision, error, poll, scan (+ explicit memory edits). | `audit/audit_log.py`, `constants.ActionType` |
| Cost ledger | **100% of LLM calls** flow through one gateway, which writes a usage/cost row for **every** call (including failures, `outcome=error`). | `llm/gateway.py`; non-negotiable #6 |
| Per-case caps | `max_tool_calls` (8), `max_tokens` (20000), `timeout_seconds` (120). | `config.CapsConfig` |
| Kill switch | A global `caps.kill_switch` stops all investigations; polling is not (re)started while set. | `config.CapsConfig.kill_switch`; `routes.put_settings` |
| Cost gate | Runs **before** the expensive model so cheap/benign clusters never reach the strong investigator. | `engine/cost_gate.py` |

## 6. State-backend security

The suite's own state (cases/audit/usage/config/cursor/RAG) lives in the
`STATE_BACKEND` you choose — secure it like any datastore:

- **Postgres** — supply the async URL via `STATE_DB_URL` with a **dedicated,
  least-privilege role** (it needs DML + `CREATE EXTENSION vector` only the first
  time). Keep the credential in `.env`/the container env, never in the SPA. Place
  Postgres on an **internal network** (the agnostic compose does not publish 5432);
  use TLS for any cross-host connection. Back it up (`docs/RUNBOOK.md` §2.1).
- **SQLite** — a local file; protect it with filesystem permissions on a persistent
  volume. Fine for single-node; no network exposure.
- **Elasticsearch** — the management key is scoped to `tlsoc-agent-*` and can never
  read the log surface (§2); use TLS and verify certs.

Nothing secret is ever written to any of these — they hold **non-secret**
preferences and operational data only.

## 7. Data handling / privacy

**What is sent to the LLM.** Only **fenced, compact** OCSF fields and computed
context — never raw event dumps. The investigator prompt sends a deterministic
context block plus up to ~12 compacted sample events and any enrichment, all
fenced (`prompts.render_cluster`). The standup writer gets a **pre-aggregated**
JSON summary only — aggregate-then-summarise, never raw logs to a model
(non-negotiable #7).

**Enrichment egress.** When enabled, the suite sends **IPs/indicators** to one or
more of **19 registered providers** across 17 files (`enrichment/providers/`,
dispatched via `enrichment/dispatch.py` and the `tools/enrich.py` tool):
AbuseIPDB, VirusTotal, GreyNoise, Shodan, Shodan InternetDB, Censys, BinaryEdge,
IPinfo, OTX, Pulsedive, Spur, XForce, URLScan, HIBP, ProjectHoneypot, RDAP,
URLhaus, ThreatFox, and MalwareBazaar. Every call is Redis-cached to protect
free-tier limits and reduce egress (non-negotiable #8). Each provider is
independently toggleable; several **keyless** ones (Shodan InternetDB, IPinfo,
the abuse.ch trio, RDAP) default ON, the rest are opt-in per-key. GeoIP already
present in the event is read as-is (no egress).

**Running fully local.** The single LLM gateway is the abstraction seam: a
local/self-hosted model server (LiteLLM / vLLM / Ollama / LM Studio) registers as
an `openai_compatible` provider behind `llm/gateway.py` with no caller change —
either supply a `litellm_api_key` (env `LITELLM_API_KEY`, or push one at runtime
via `POST /api/llm/models/custom`) or omit it for a no-auth local endpoint driven
by `base_url` alone. Disabling enrichment removes all provider egress. Together
these let a deployment run with **no third-party network egress at all**.

## 8. Responsible disclosure

To report a security issue, contact the maintainers privately (do **not** open a
public issue with exploit detail). Include: affected component (web UI / backend /
connector / deploy), version (`/api/health` reports `version`), and reproduction
steps. We aim to acknowledge promptly and coordinate a fix before public
disclosure.

## 9. Hardening checklist (deploy-time)

- [ ] **TLS reverse proxy in front of the web UI**, with your own authentication —
      the SPA is a thin viewer and ships no auth of its own. Terminate TLS at the
      proxy; the SPA → backend hop stays on the internal network.
- [ ] **Read-only, scoped credential for every log source.** No source superuser at
      runtime; pull keys read-only and pattern-scoped. Verify push receivers have no
      write path back.
- [ ] **ES state backend: two scoped keys only** (read-only log key + mgmt
      `tlsoc-agent-*` key); verify the mgmt key cannot read `all-logs-*`.
- [ ] **State backend hardened** — Postgres on an internal network with a
      least-privilege role; SQLite file permissions; backups configured (§6).
- [ ] **Inbound push auth on.** Set `auth_mode` to `bearer` or `hmac` (never `none`
      on an exposed endpoint); set the per-source `token`/`shared_secret`.
- [ ] **Network egress allowlist for the backend.** Restrict outbound to exactly the
      configured LLM + enrichment endpoints (or a local vLLM gateway). Without LLM
      egress, investigations fail safe to NEEDS_HUMAN — never dropped.
- [ ] **Key rotation.** Rotate source/LLM/enrichment keys via `.env` + backend
      restart (durable) — wizard / per-source pushes are in-memory only
      (`docs/RUNBOOK.md` §4.1).
- [ ] **`read_only_settings_mode=true`** to freeze Settings after configuration.
- [ ] **No secrets in git / state store.** Confirm `.env` is git-ignored and that
      nothing secret lands in preferences or the state store.
- [ ] **Caps + kill switch reachable** from Settings.

---

## API authentication, RBAC, MFA & SSO

API auth ships **disabled by default** — the no-auth deployment (the original
model, where the network/reverse-proxy is the trust boundary) remains fully
supported and behaviourally unchanged out of the box. Enabling it
(`TLSOC_AUTH_ENABLED=true`) turns on a **login screen, persisted multi-user
accounts, 6-role RBAC, MFA (TOTP), and SSO (OIDC)**. Deploy steps + IdP redirect
URIs are in `DEPLOY.md` §9; a guided demo is in `DEMO.md`.

```bash
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<32+ random bytes>     # stable secret (else ephemeral, sessions die on restart)
TLSOC_AUTH_ADMIN_USERNAME=admin
TLSOC_AUTH_ADMIN_PASSWORD=<plaintext, hashed in memory at startup, never stored>
# or a multi-user map of username -> PBKDF2 hash:
# TLSOC_AUTH_USERS={"alice":"pbkdf2_sha256$...","bob":"pbkdf2_sha256$..."}
TLSOC_AUTH_COOKIE_SECURE=true                # REQUIRED behind TLS (HTTPS-only cookie)
```

When enabled, every `/api/*` route requires a valid session **except** the tiny
public allowlist (`/api/health`, `/api/auth/{login,me,logout}`, the SSO
authorize/callback) and the self-authenticating `/api/ingest/<source>` receivers.
Deny-by-default is enforced by a router-level dependency and a CI test
(`tests/test_route_auth_coverage.py`) that fails if any route slips the gate. The
webui shows a login screen and gates the app automatically (it is a strict no-op
when auth is off).

### First-run seed (OOBE)

When auth is enabled **and the user store is empty**, the backend auto-seeds a
demo **super_admin**: **`Admin` / `Admin@123`** (`config.auth_seed_admin*`). It
exists only to make a fresh, auth-on deployment usable — **change it
immediately** (create real accounts, then delete/disable the seed). The store
blocks removing the **last** active super_admin to prevent lockout
(`stores/users.py:count_active_super_admins`).

### RBAC — 6 roles + permission matrix

Accounts are persisted (a KV-doc in the state store — no new index/table). Each
user has exactly one role: `super_admin` · `soc_manager` · `analyst_tier2` ·
`analyst_tier1` · `responder` · `auditor`. Every privileged `/api` route is gated
by a `require_permission` dependency against the permission matrix (server-side,
deny-by-default); the webui mirrors it with `<Can>` guards purely for UX. When
auth is **OFF**, every authenticated principal is treated as `super_admin` for
back-compat with the original single-admin deployment.

### MFA (TOTP)

Per-user, opt-in **RFC-6238 TOTP** (verified against the official RFC test
vectors), enrolled from the UI with a **browser-rendered inline-SVG QR** (no
external QR service / no egress) and **single-use recovery codes**; login is
two-phase (password → 6-digit code).

> **Hardening TODO — MFA secret at rest.** The per-user TOTP seed is stored
> **obfuscated** with `Secrets.mfa_server_key()` (`TLSOC_MFA_OBFUSCATION_KEY`, or
> derived from the JWT secret when blank) — this is stdlib **obfuscation, not a
> KMS/HSM-backed envelope encryption** (`auth/mfa.py`). Treat the obfuscation key
> (and the JWT secret it can derive from) as sensitive, and prefer a future
> KMS-backed secret store. Recovery codes are single-use and stored hashed.

### SSO (OIDC — Google / Microsoft / generic)

Providers are configured in Settings (issuer, client id, group→role mapping);
the **client secret stays in the SECRET tier** (`Secrets.sso_client_secrets`, env
`TLSOC_SSO_CLIENT_SECRETS` or runtime `POST /api/auth/sso/providers/{id}/secret`,
never the config store). Login uses **server-side authorization-code exchange +
the userinfo endpoint**, with `state`/`nonce` for CSRF/replay defence; IdP groups
are provisioned onto the 6 roles. Register the redirect URI
`<base-url>/api/auth/sso/callback` with the IdP (`DEPLOY.md` §9.5).

> **Hardening TODO — id_token signature verification.** To avoid adding a
> JWKS/JWT-verify dependency, the current flow trusts the **server-side
> code-exchange + userinfo** result over TLS rather than independently verifying
> the `id_token`'s signature. This is safe given the confidential-client,
> back-channel exchange, but a JWKS-based `id_token` signature + `aud`/`iss`/`nonce`
> verification is a planned hardening step.

### Sessions, revocation & the token-version model

A valid JWT signature is necessary but **no longer sufficient** when auth is on. On
login the suite mints a short-lived **access token** carrying a 128-bit `sid` and a
per-user `token_version` (`tv`) claim, and registers a row in a backend-agnostic
**`SessionStore`** (`stores/sessions.py`, a KV doc in the chosen state backend — no
new index/table). `require_auth` (`api/deps.py`) does an **async** session check
**after** the sync, I/O-free `verify()`: it loads the session by `sid` and rejects
the request when the session is **missing, revoked, `tv`-stale, idle-expired**
(`now > last_active + idle_timeout`), or **absolute-expired** (`now > created_at +
absolute_lifetime`), bumping `last_active` lazily. The lifetimes are the
operator-tunable `session_policy` block (`DEPLOY.md` §9.4); they only **add**
revocation/expiry semantics on top of the JWT signature, never weaken it.

- **Revocation is real and immediate.** Revoking a single `sid`
  (`POST /api/sessions/{sid}/revoke`, or admin `POST
  /api/admin/sessions/{sid}/revoke`) marks the row revoked with `revoked_by` /
  `revoke_reason`; the next request on that token 401s. **Revoke-all** for a user
  (`POST /api/admin/users/{username}/revoke-all`, and the
  `/api/sessions/revoke-others` self-service) **bumps the user's `token_version`**,
  so *every* still-valid JWT carrying the old `tv` is rejected at once — a global
  sign-out with no need to wait for the access token's `exp`. Logout revokes the
  current `sid`. Every session create / revoke is **audited** (non-negotiable #2).
- **Step-up (`require_fresh_auth`).** Sensitive operations can require a recent
  authentication; a request whose `last_authn` is older than `sudo_reauth_window`
  401s with `{code:'reauth_required'}`, prompting a re-auth (`POST /api/auth/reauth`,
  which re-stamps `last_authn`).
- **Survives restart, dies on secret loss.** Sessions are persisted, so they outlive
  a backend restart and the internal `_wire()` rebuild — **provided
  `TLSOC_AUTH_JWT_SECRET` is stable**. An ephemeral JWT secret still invalidates
  every token on restart (the session rows load, but their JWTs no longer verify);
  set a stable secret in `.env`.
- **No-auth is unchanged.** When auth is OFF the whole session/step-up path is a
  strict no-op (every principal is treated as `super_admin`, as before).

### Refresh tokens

No sign-in issues a refresh token. A session lasts until its access token expires
(`AUTH_TOKEN_HOURS`, or the Remember me duration), within the session policy's idle
and absolute limits; after that the person signs in again. `POST /api/auth/refresh`
is kept for older clients, marked deprecated in the API description, and always
answers `401` with code `session_invalid` and reason `unknown_refresh`. No credential
that browser JavaScript can read is added for it.

The rotation code behind the route (hashed refresh tokens, reuse detection that
revokes every session of the account) stays in place but cannot run while no sign-in
issues a token.

### Account security checks

- **Forced password change.** An account an administrator creates, or whose password
  an administrator resets, must change its temporary password before anything else.
  Until it does, every `/api` route answers `403` with code `password_change_required`,
  except signing out, the change itself, and the reads the sign-in screen needs
  (`/api/auth/me`, `/api/account/me`, `/api/account/permissions`,
  `/api/prefs/effective`, `/api/prefs/user`). The seeded demo `Admin` account is not
  flagged; change its password yourself, or set `AUTH_SEED_ADMIN=false` on the backend.
- **Password changes end other sessions.** Changing your own password signs out your
  other sessions (this one stays). An administrator's reset signs the account out
  everywhere. Both write `session.revoked` audit rows.
- **Second-factor attempts are bounded.** Ten wrong codes in a row lock second-factor
  checks for the account for 5 minutes, doubling for each further run of ten up to an
  hour, with a `429` answer and an `auth.mfa_locked` audit row. This covers the
  sign-in check, both enrolment confirms and turning MFA off. A pending sign-in token
  is refused after 5 wrong codes or once it has signed in. A correct code resets the
  count, and so does an administrator turning MFA off for the account. Each code is
  consumed inside the user store's compare-and-swap, so a code sent twice at once
  signs in once.
- **Replacing an authenticator.** An enrolled account cannot start a new enrolment
  from a session; it turns MFA off with a current code first. Enrolling and turning
  MFA off both ask for a recent sign-in.
- **Hashing off the event loop.** Password and recovery-code hashing run in worker
  threads under a small semaphore, so a burst of sign-ins never stalls other requests.
- **Session addresses.** The session list and new-device notices record the client
  address the audit trail records: a forwarded header is believed only from a peer in
  `TRUSTED_PROXIES`.
- **Single sign-on.** A verified email links only to an account of the same provider
  that has no subject yet; an account of another provider, or one already bound to a
  different subject, is refused. Only a Google provider's `hd` claim names a domain;
  otherwise the domain is the verified email's, and an unverified email has none.
  Every change to the single sign-on settings, and every provider client secret, needs
  a stored Super admin with a fresh sign-in (anyone else gets `403 super_admin_only`,
  "Only a Super admin can change single sign-on."), and role values must name a
  built-in or custom role. A group map never changes a Super admin's role.

### Demo Mode isolation guarantees

Demo Mode (`DEPLOY.md` §11.1) is capability-gated: status requires `demo:read`,
while enable / manual incident / reset / disable require `demo:manage`. The default
`super_admin` and `soc_manager` roles have `demo:manage`; custom roles can be
granted it explicitly. It is engineered so demo-generated data cannot contaminate
real cases/events/RAG/usage, advance real cursors, or incur provider cost:

- **Separate store.** Demo events flow through the *real* pipeline for fidelity, but
  every demo-generated workload write lands in a **throwaway in-memory store** built
  per-enable and GC'd on disable, tagged with a unique `run_id`. A **write-guard**
  (`state.py` `_write_guard`) asserts that a demo-tagged row only ever reaches the
  demo store and a real row only ever reaches the real store — a mismatch raises,
  so the two can never cross.
- **Zero cost, deterministic.** While demo is active the LLM gateway uses a
  deterministic **mock provider**; usage rows are `pricing_source='zero'` (the cost
  page shows "(simulated)"), so a demo never spends a real token or hits a provider,
  even when valid provider keys are configured.
- **The deterministic gate still rules (#3).** FP cases still run through the real
  `engine/case_manager.decide()` against a **sandboxed `AutoClosePolicy` copy** — the
  live policy is untouched and #3 is byte-identical; NEEDS_HUMAN stays open as an
  HITL showcase.
- **Real source untouched, fully reversible.** Demo gating happens **before** the
  real `source.poll`, so the durable polling cursor (#4) is never advanced or
  corrupted. `POST /api/demo/disable` **hard-deletes** all demo data by `run_id`
  (cases/audit/usage/events) and flips the tenant back to `off` in one reversible
  step.
- **Deliberate persistent audit.** `POST /api/demo/{enable,incident,reset,disable}`
  appends the authenticated operator and outcome to the **real** append-only audit
  trail. While Demo Mode is active, `/api/audit` serves the isolated demo trail like
  the other swapped surfaces; the persistent lifecycle records become visible there
  after exit.
- **Scoped UI protections, not an administration freeze.** The Sources UI disables
  real connector controls and outbound notification tests are refused during a demo.
  Other organization/admin settings remain live and are not part of the demo
  sandbox; presenters should leave them unchanged unless they intend a real
  configuration change.

### Email-notification rendering: escaping & header-safety

The 5 built-in (operator-overridable) email templates render through a tiny stdlib
mustache-subset engine (`notifications/templates.py`) designed so a case field an
attacker can influence (rule name, entity, message) can never break out of the
email — the rendered body is still attacker-influenceable **data**:

- **Auto-escaped by default.** `{{var}}` interpolations pass through `html.escape`,
  so injected markup renders as inert text. The unescaped `{{{var}}}` form exists
  **only** for trusted, operator-authored header HTML, never for case-derived values.
- **Header-injection safe.** The Subject and every email header value go through
  `header_safe()` (strips CR/LF + control chars, length-capped), closing the classic
  CRLF header-injection vector; the synthetic `Message-Id` / threading headers are
  deterministic and case-derived. Untrusted vars in the plain-text part go through
  `text_safe()` (newlines stripped).
- **Channel isolation (#3).** A channel's `send()` never raises and never blocks or
  alters triage — delivery is fire-and-forget **after** the case is saved, so a
  failing email cannot change a case's status. The channel **secret** (SMTP password
  / SES IAM secret / Resend API key) stays in the SECRET tier and never appears in
  the audited `SendResult.detail`.

### Hardening notes (middleware)

- Set `TLSOC_AUTH_COOKIE_SECURE=true` in production (TLS); the session cookie is
  always `HttpOnly` + `SameSite=Lax`.
- Passwords are hashed with **PBKDF2-HMAC-SHA256** (`auth/passwords.py`). The
  iteration count is a fixed default — **review/raise it** (and migrate hashes) as
  hardware improves; consider a memory-hard KDF (argon2/scrypt) for a hardened
  profile.
- Security headers (CSP/HSTS/nosniff/frame-deny) are on by default. The Redis-free
  in-process **rate limiter** (`TLSOC_RATE_LIMIT_ENABLED`, default **off**) and
  **CSRF** (`TLSOC_CSRF_ENABLED`, default **off**) are opt-in.
- `csrf_enabled` currently expects API clients to send `X-CSRF-Token` matching a
  `tlsoc_csrf` cookie; the standalone webui does not yet issue/echo that token, so
  enable CSRF only for header-setting API clients (or after wiring the webui).
  `SameSite=Lax` already blocks the common cross-site POST CSRF vector.
- The rate limiter only trusts `X-Forwarded-For` when constructed with
  `trust_forwarded_for=True` (behind a known proxy); otherwise it keys on the
  socket peer to prevent header-spoofed bucket rotation.

> **Hardening TODO — session-store cardinality.** `SessionStore` keeps sessions as a
> single JSON list in the KV doc (read-modify-write); this is correct and durable but
> O(n) per check at high session counts. Prune revoked/expired rows (or move to
> per-`sid` keys / a Redis hot path) for a large, long-lived multi-user deployment.

> **Hardening TODO — encrypted secret store.** Wizard / per-source / runtime-pushed
> secrets (including session refresh material is *not* affected — refresh tokens are
> stored hashed) remain in the **in-memory** secret tier and must be re-set after a
> restart unless supplied via `.env`. An optional persisted **envelope-encrypted**
> secret store is planned; until then `.env` is the durable path. (Also see the MFA
> obfuscation and `id_token`-verification TODOs above.)

### Notification-channel secrets

Notification delivery (email via SMTP / SES / Resend, Slack/Teams/webhook/
PagerDuty/Telegram) keeps each channel's credential (SMTP password, SES IAM secret,
Resend API key, webhook URL, or API token) in the **SECRET tier**
(`Secrets.notification_secrets`, env `TLSOC_NOTIFICATION_SECRETS` or runtime
`POST /api/notifications/channels/{id}/secret`) — never the config store; the UI
shows `configured ✓` only. Channels fire **fire-and-forget after** a case is
saved, so a failing/slow channel never blocks or alters triage, and a
notification **cannot change a case's status** (non-negotiable #3 is untouched).
