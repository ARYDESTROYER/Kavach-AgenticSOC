# ENVIRONMENT.md — every environment, in detail

> **New here? Start with [`HANDOFF.md`](HANDOFF.md)** — the START-HERE onboarding
> doc (run commands, current status, what's done, what's next).

There are **two distinct environments**. Confusing them causes most build/deploy
pain, so they are documented separately.

> **Branch topology:** the remote uses `Testing` for integration and default
> `main` for accepted Stable source. Version 0.1.13 is Stable only when the exact
> verified `main` commit has the immutable `v0.1.13` tag and matching signed/public
> artifacts. The immutable `v0.1.10` and `v0.1.11` tags are superseded,
> non-installable failed-publication records. The immutable `v0.1.12` tag completed
> its signed/public publication but is bootstrap-blocked by its legacy installed-
> identity comparison and is also unsupported; never move, reuse, repair, install,
> or bootstrap from these records. Branch protection, required checks, Pages source selection, and environment
> policy are repository settings; administrators must verify them independently of
> this checkout.

> The suite is **vendor-agnostic**: the backend (FastAPI+LangGraph) plus a
> **standalone web UI** (`webui/`, Vite+React+TS+**Tailwind+shadcn/Radix** — EUI was
> removed in the UI overhaul) are the primary artifacts; the Kibana plugin is
> **archived** (`archive/kibana-plugin/`, frozen, not built/shipped). The suite's own
> state runs on a **selectable backend** (Elasticsearch, PostgreSQL, or SQLite).
> Optional auth (6-role RBAC + custom roles / MFA-TOTP / OIDC SSO + **server-enforced
> sessions** with idle/absolute/revocation and refresh rotation) is **fully built but
> DEFAULT OFF** — `TLSOC_AUTH_ENABLED=true` to turn it on. A reversible, $0 **Demo
> Mode** populates the product with synthetic data without any source wiring (see
> `DEMO.md`). See `COMPATIBILITY.md` for the full matrix.
>
> Environment-relevant additions since the vendor-agnostic pivot include optional
> **cloud LLM providers** (Azure OpenAI / AWS Bedrock / Google Vertex), a **local /
> self-hosted LiteLLM-compatible provider** (any OpenAI-compatible `base_url`), and
> **38 enrichment providers** behind an `EnrichmentProvider` SPI — all keyed via env
> (see §2.6 / §2.7). The quota-safe keyless enrichment providers are default-on; the
> caveated keyless ones and every keyed provider/model stay default-off, additive,
> and degrade gracefully. **Round 10**
> is the one deliberate exception on the *Preferences* (not env) side: comprehensive
> ingestion + a self-tuning autopilot now ship **ON** out of the box, bounded by a
> default $10/day budget backstop (see §2.8 — env surface unaffected). For the full
> round-by-round feature history, see `AGENTS.md` and `Journal.md` — this doc
> only tracks the environment/variable surface.

---

## 1. The build / development sandbox (Claude Code on the web)

Where the code is written, the backend tests run, the **web UI is built**, and — if
you choose to revive the **archived** Kibana plugin (`archive/kibana-plugin/`, not
built/tested/shipped by default) — where its zips can still be rebuilt manually.

### 1.1 Nature
- **Ephemeral, isolated cloud container.** The repo is cloned fresh when the
  session starts and the container is reclaimed on inactivity. **Anything not
  committed + pushed is lost.** Push to the active working branch (**`Testing`**
  for day-to-day work, or the session-specific branch you were handed — check
  `git status`/`git branch` before you push).
- ~252 GB volume, typically **18–22 GB free** (Kibana checkouts in `/tmp` are
  large — ~6 GB each). 15 GB RAM, 4 CPUs.

### 1.2 Tooling
| Tool | Where / version | Notes |
|---|---|---|
| Node (default) | `/opt/node22` → `node v22.x` on PATH | Fine for the **webui** build; WRONG for **plugin** builds (use the per-version pin) |
| nvm | `/opt/nvm/nvm.sh` | `nvm use "$(cat <checkout>/.nvmrc)"` for the Kibana plugin |
| Node for the webui | **22** | Vite+React+TS+Tailwind+shadcn/Radix; the default `/opt/node22` works |
| Node for Kibana 8.19.12 | `22.22.0` (repo `.nvmrc`/`.node-version`) | Bazel removed in 8.19 |
| Node for Kibana 8.12.2 | `18.18.2` | Bazel-based bootstrap |
| Python | `3.11` | backend venv at `backend/.venv` |
| Docker | daemon startable (`sudo dockerd &`) | **image registries blocked — see below** |
| git, jq, curl, unzip | present | |

### 1.3 Network egress policy (allowlist)
**Reachable (HTTP 200):** `github.com`, `pypi.org`, `registry.npmjs.org`,
`nodejs.org`.

**BLOCKED (403 / not in allowlist):**
- Container image registries: `docker.elastic.co`, `pgvector/pgvector` & other
  Docker Hub blob CDN (`production.cloudfront.docker.com`). → **You cannot pull
  Elasticsearch/Kibana/Postgres images or run any Docker stack in this sandbox.**
  Building/running the agnostic or legacy compose is a **deploy-time** step.
- Browser binaries during Kibana bootstrap: `edgedl.me.gvt1.com` (Chrome),
  `cdn.playwright.dev` / `playwright.download.prss.microsoft.com` (Playwright). The
  webui build needs **no browser** — `vite build` is a static bundle, no headless
  Chromium.
- `ci-stats.kibana.dev` (Kibana build telemetry — harmless).

### 1.4 Consequences for verification
- **Backend:** fully testable offline — `cd backend && . .venv/bin/activate &&
  pytest -q` uses the in-memory fake ES and the mock LLM provider. A fully green run
  (see `Journal.md` for the exact current count) is the primary correctness gate
  (auth DEFAULT OFF, so the suite runs unauthenticated). A `conftest` autouse
  **network guard** blocks non-loopback egress
  so the new enrichment-provider tests stay deterministic and offline (opt out per
  test with `@pytest.mark.allow_network`). The **SQL state backend is tested offline
  on SQLite** (`sqlalchemy`+`aiosqlite`); `asyncpg`/`pgvector` are imported lazily,
  so no Postgres is needed in the sandbox.
- **Web UI (primary surface):** builds fully (the npm registry is reachable).
  ```bash
  cd webui && npm install && npm run build
  # Builds the installed /docs/<major.minor>/ Help Center first, then tsc + Vite.
  # The docs wrapper reuses backend/.venv or bootstraps ignored .docs-venv/ from
  # docs/requirements.txt. Use npm run build:app only for an app-only check.
  ```
  The clean documentation + `tsc + vite` build (one `dist/` artifact) **is the
  check** here — there is
  no browser to render it in this sandbox. A dev-only **Vitest** harness
  (`npm run test`; see `Journal.md` for the current spec count) covers
  render/regression of every major surface (Settings, Demo Mode, command palette,
  customization, the nav sidebar, Roles editor, Models page, Metrics tabs, CaseDetail
  tabs + trace timeline, Inbox, Detection & Rules, custom dashboards, and more) and
  runs in the CI gate. The only deliberate runtime addition since the Round-5
  baseline is the lazy `motion` package used for route/tab/KPI animation; it is
  split out of the entry chunk.
- **Plugin (archived, opt-in revival only):** still buildable manually if you
  revive it — see `archive/kibana-plugin/BUILD.md`. Verify **statically**:
  `tsc --noEmit` clean, `unzip -l` shows
  `target/public/tlsocAgenticTriage.plugin.js`, manifest `kibanaVersion` correct,
  `grep -c tlsoc-backend` in the browser bundle = 0.
- **Live install / running stacks are NOT possible here** (no images). They are
  deploy-time steps with a checklist in `DEPLOY.md`.

### 1.5 Plugin build env vars (archived plugin revival only — export before bootstrap AND build)
```bash
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 BROWSERSLIST_IGNORE_OLD_DATA=true \
       NODE_OPTIONS=--max-old-space-size=4096
# 8.12.2 only, if releases.bazel.build 403s:
#   BAZELISK_BASE_URL=https://github.com/bazelbuild/bazel/releases/download (+ cached bazel binary)
```
- `BROWSERSLIST_IGNORE_OLD_DATA=true` is **mandatory at build time** or the
  optimizer silently drops the browser bundle.
- Running as **root** trips 8.19's kbn root guard inside `buildWebpackPackages`
  (it calls `yarn kbn build-shared` without `--allow-root`). Fix without patching
  Kibana: put a `yarn` shim first on PATH that appends `--allow-root` to
  `yarn kbn …` subcommands. (Non-root dev users do not hit this.)
- Warm checkouts live in `/tmp` (e.g. `/tmp/kibana-8.19`). `rm -rf` an unused one
  to free disk. (None of this applies to the webui build.)

---

## 2. The deploy target (the SOC server)

Where the suite actually runs in production. Two supported shapes (see
`COMPATIBILITY.md` §E and the compose files under `deploy/`).

### 2.1 Shape A — the agnostic stack (recommended, `deploy/docker-compose.agnostic.yml`)
Self-contained; **no Elasticsearch required for the app's own state.** Brings up:
- `tlsoc-postgres` — PostgreSQL + **pgvector** (`pgvector/pgvector:pg16`): the
  app's OWN state (cases/audit/usage/config/cursor/RAG), replacing the
  `tlsoc-agent-*` ES indices. Backend runs with `STATE_BACKEND=postgres`.
- `tlsoc-redis` — enrichment/dedup cache (optional; degrades to in-memory).
- `tlsoc-backend` — FastAPI+LangGraph agent on `8088`.
- `tlsoc-webui` — the standalone React/Tailwind SPA (nginx) on `8080`; talks to the
  backend via an `/api` proxy. This is the first-run wizard + console.
- `agentic-soc-updater` — private Unix-socket supervisor for signed, digest-pinned
  application updates. It alone mounts `/var/run/docker.sock`; the backend receives
  only the bounded control socket.

Your SIEM/EDR/XDR is **not** part of this stack — connect to it from the UI's
first-run wizard ("add a source"). Pull sources today: Elasticsearch / OpenSearch
/ Wazuh (point `ES_URL` + a read-only `ES_API_KEY` at that cluster). Push sources
(webhook/HEC/syslog/Kafka/SQS/…) need no ES at all; publish the inbound port(s)
you configure in the wizard (e.g. `1514/udp` for syslog).

```bash
cp .env.example .env   # fill TLSOC_PG_PASSWORD + at least one LLM key
./scripts/agentic-soc-compose.sh up -d --build
# open http://localhost:8080 and complete the setup wizard
```

The wrapper is required for every lifecycle command after the one-time supervisor
bootstrap because it layers the host-visible digest override in
`.agentic-soc-runtime/active-release.compose.yml`. Raw Compose commands bypass that
override. Docker-socket access is effectively root-equivalent on the host: treat the
updater image, private socket, `.env`, state volume, and backup volume as a privileged
host boundary and never expose the socket over TCP.

### 2.2 Shape B — the legacy ELK merge (`deploy/docker-compose.tlsoc.yml`)
Attach to an existing ELK stack (e.g. `sankettaware16/TLSOCDockerDeploy`,
containers `elasticsearch`/`kibana`/`logstash`/`kafka`, 8.19.12, TLS via a local
CA under `./certs/`) as a **read-only consumer**:
- `tlsoc-backend` joins the existing default Compose network, reaches
  `https://elasticsearch:9200` by container-name DNS, mounts `./certs/ca/ca.crt:ro`,
  listens on `8088`, and runs `STATE_BACKEND=elasticsearch` (own-state in
  `tlsoc-agent-*` via `ES_MGMT_API_KEY`).
- `tlsoc-redis` (optional) — enrichment cache.
- Run the supported standalone web UI separately. The archived Kibana plugin is
  frozen and is not built, tested, or shipped; reviving it is an unsupported local
  exercise.
- Logs land in `all-logs-*` (the wizard default data view may be
  `fosstlsoc-logs-*` — confirm on the live stack and set it in Settings).

### 2.3 Environment-variable surface (the `.env` → backend mapping)
Backend env names are **UNPREFIXED** (`ES_API_KEY`, `STATE_BACKEND`, …). The
compose blocks read **`TLSOC_`-prefixed** names from `.env` and map them onto the
unprefixed backend vars, so the suite's `.env` cannot clash with the host stack's
`ELASTIC_PASSWORD`/`KIBANA_PASSWORD`/etc.

Release identity is the deliberate exception. These non-secret values remain
prefixed Docker build/runtime metadata rather than `Secrets` fields:

| Build/runtime value | Default | Purpose |
|---|---|---|
| `TLSOC_VERSION` | `0.1.13` in Compose | Machine SemVer for images and API identity |
| `TLSOC_RELEASE_CHANNEL` | `testing` | Independent promotion stamp; use `stable` only for the accepted main/tag build |
| `TLSOC_BUILD_SHA` | `unknown` | Exact source revision |
| `TLSOC_BUILD_DATE` | `unknown` | Reproducible-build timestamp supplied by the builder |
| `TLSOC_SOURCE_URL` | repository URL in each Dockerfile | Canonical source URL embedded in OCI image metadata; the reference Compose files do not map an `.env` override |
| `AGENTIC_SOC_UPDATE_REPOSITORY` | `ARYDESTROYER/Agentic-Kibana` | Repository whose tag-bound release workflow the host supervisor trusts; configure before bootstrap, not per browser request |

The Console compiles the same version/channel/SHA/date stamp and always displays
`vX.Y.Z · Testing|Stable` in the shell. Its popover reconciles that immutable
Console identity with `/api/health/build-info`; a version, channel, or known-SHA
mismatch fails safe to Testing. `scripts/run-demo.sh` derives Stable only for a
literal `main` checkout and defaults every other branch/detached state to Testing
unless an explicit release-build override is supplied.

`AGENTIC_SOC_UPDATE_REPOSITORY` is host trust configuration, not the repository URL
saved under **Settings → Updates & releases**. The latter controls mutable public
branch observation only. Configure the trusted repository before the one-time
supervisor bootstrap; changing the UI value cannot retarget signed installation
authority. The official updater keeps no registry credential, so its release's three
GHCR packages must be public and anonymously pullable by exact digest. See
[`operations/upgrades.md`](operations/upgrades.md).

| `.env` (compose) | Backend env (`Secrets`) | Purpose |
|---|---|---|
| `TLSOC_ES_URL` | `ES_URL` | log cluster URL (pull source) |
| `TLSOC_ES_API_KEY` | `ES_API_KEY` | **read-only** key for the log surface (the agent's only path to logs) |
| `TLSOC_ES_MGMT_API_KEY` | `ES_MGMT_API_KEY` | own-state key for `tlsoc-agent-*`; explicit lifecycle preview/apply also needs cluster `manage_ilm` + `manage_index_templates` + `monitor` (only when `STATE_BACKEND=elasticsearch`) |
| `TLSOC_ES_CA_CERT` / `TLSOC_ES_VERIFY_CERTS` | `ES_CA_CERT` / `ES_VERIFY_CERTS` | private-CA path + TLS verification toggle |
| `TLSOC_STATE_BACKEND` | `STATE_BACKEND` | `elasticsearch` (default) \| `postgres` \| `sqlite` |
| `TLSOC_STATE_DB_URL` | `STATE_DB_URL` | SQLAlchemy async URL for SQL backends (agnostic compose derives it from the PG vars below) |
| `TLSOC_PG_USER` / `TLSOC_PG_PASSWORD` / `TLSOC_PG_DB` | (compose builds `STATE_DB_URL`) | Postgres creds for the agnostic stack (`TLSOC_PG_PASSWORD` REQUIRED there) |
| `TLSOC_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | LLM provider key |
| `TLSOC_OPENAI_API_KEY` | `OPENAI_API_KEY` | LLM provider key |
| `TLSOC_ABUSEIPDB_API_KEY` | `ABUSEIPDB_API_KEY` | enrichment key (AbuseIPDB) |
| `TLSOC_VIRUSTOTAL_API_KEY` | `VIRUSTOTAL_API_KEY` | enrichment key (VirusTotal) |
| `TLSOC_AZURE_OPENAI_API_KEY` / `_ENDPOINT` / `_API_VERSION` | `AZURE_OPENAI_API_KEY` / `_ENDPOINT` / `_API_VERSION` | **Round 3** — Azure OpenAI cloud LLM (optional) |
| `TLSOC_AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `TLSOC_AWS_REGION` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | **Round 3** — AWS Bedrock cloud LLM (stdlib SigV4, no boto3) (optional) |
| `TLSOC_VERTEX_PROJECT` / `_LOCATION` / `_API_KEY` | `VERTEX_PROJECT` / `VERTEX_LOCATION` / `VERTEX_API_KEY` | **Round 3** — Google Vertex cloud LLM (short-lived OAuth Bearer) (optional) |
| `TLSOC_GREYNOISE_API_KEY` · `TLSOC_SHODAN_API_KEY` · `TLSOC_CENSYS_API_ID`/`_SECRET` · `TLSOC_BINARYEDGE_API_KEY` · `TLSOC_IPINFO_TOKEN` · `TLSOC_OTX_API_KEY` · `TLSOC_PULSEDIVE_API_KEY` · `TLSOC_SPUR_API_KEY` · `TLSOC_XFORCE_API_KEY`/`_PASSWORD` · `TLSOC_URLSCAN_API_KEY` · `TLSOC_HIBP_API_KEY` · `TLSOC_HONEYPOT_ACCESS_KEY` · `TLSOC_ABUSECH_AUTH_KEY` | the same names unprefixed | **Round 3** — the 17-provider enrichment SPI (§2.7); all optional + default-off; keyless providers (Shodan InternetDB / IPinfo Lite / abuse.ch trio / RDAP-DoH) need no key and are default-on |
| `TLSOC_CROWDSEC_API_KEY` · `TLSOC_GOOGLE_SAFEBROWSING_API_KEY` · `TLSOC_IPQUALITYSCORE_API_KEY` · `TLSOC_IPDATA_API_KEY` · `TLSOC_APIVOID_API_KEY` · `TLSOC_MALTIVERSE_API_KEY` · `TLSOC_SECURITYTRAILS_API_KEY` · `TLSOC_CRIMINALIP_API_KEY` · `TLSOC_NETLAS_API_KEY` · `TLSOC_HYBRID_ANALYSIS_API_KEY` · `TLSOC_METADEFENDER_API_KEY` · `TLSOC_EMAILREP_API_KEY` | the same names unprefixed | **Round 11** — 12 more keyed enrichment providers (§2.7; registry now 38 total); all optional + default-off. The 7 new keyless providers need no env var at all: CIRCL hashlookup / DShield / Onionoo are default-on; Spamhaus / Cymru MHR (need the host's own resolver) and Robtex / crt.sh (slow) are default-off toggles in Settings → Enrichment |
| `TLSOC_LITELLM_API_KEY` | `LITELLM_API_KEY` | **Round 9** — optional key for a self-hosted LiteLLM-proxy / vLLM / Ollama / LM Studio endpoint (the `openai_compatible` provider path). **Not forwarded by the agnostic compose today** — add a matching `- LITELLM_API_KEY=${TLSOC_LITELLM_API_KEY:-}` line to `tlsoc-backend`'s `environment:` block yourself if you need it. Also settable at runtime via the "Add local model" dialog (`POST /api/llm/models/custom`), or omit entirely for a no-auth local endpoint (falls back to `OPENAI_API_KEY`). |
| `TLSOC_EMBEDDING_API_KEY` | `EMBEDDING_API_KEY` | embeddings (falls back to the OpenAI key) |
| `TLSOC_REDIS_URL` | `REDIS_URL` | enrichment cache (degrades to in-memory) |
| `TLSOC_LOG_LEVEL` | `LOG_LEVEL` | backend log level |
| `TLSOC_SECURITY_HEADERS_ENABLED` | `SECURITY_HEADERS_ENABLED` | HTTP security headers on backend-served responses. Default **`true`** (harmless; no behavior change for existing clients). |
| `TLSOC_RATE_LIMIT_ENABLED` | `RATE_LIMIT_ENABLED` | per-client token-bucket rate limiting. Default **`false`** so the no-auth "old version" is unchanged out of the box; enable for a hardened profile. |
| `TLSOC_CSRF_ENABLED` | `CSRF_ENABLED` | double-submit CSRF-token enforcement on state-changing requests. Default **`false`** — the standalone webui does not yet echo the CSRF cookie on login, so enable this only for API clients that set `X-CSRF-Token` themselves (see `SECURITY.md`). |
| `TLSOC_AUTH_ENABLED` | `AUTH_ENABLED` | **DEFAULT OFF.** `true` turns on login + 6-role RBAC + MFA/SSO and (on first run, no users) seeds **Admin / Admin@123** (super_admin). Leaving it unset preserves the no-auth "old version" + the offline test path. |
| `TLSOC_AUTH_JWT_SECRET` | `AUTH_JWT_SECRET` | HS256 signing secret for the session/access JWTs (auto-generated per process if unset → **all sessions invalidated on restart**; set a stable 32+ byte value in prod, e.g. `openssl rand -hex 32`, so sessions survive restarts). |
| `TLSOC_AUTH_TOKEN_HOURS` | `AUTH_TOKEN_HOURS` | session-cookie / access-token lifetime in **hours** (default `12`). NOTE: the *richer* session policy below (idle / absolute / refresh / step-up) is **UI-editable Preferences**, not env. |
| `TLSOC_AUTH_COOKIE_SECURE` | `AUTH_COOKIE_SECURE` | set `true` behind TLS so the session cookie is HTTPS-only (default `false`). |
| `TLSOC_AUTH_ADMIN_USERNAME` / `TLSOC_AUTH_ADMIN_PASSWORD` | `AUTH_ADMIN_USERNAME` / `AUTH_ADMIN_PASSWORD` | optional env single-admin (hashed in memory at boot, never stored; granted super_admin) — separate from the auto-seeded `Admin/Admin@123`. |
| `TLSOC_MFA_OBFUSCATION_KEY` | `MFA_OBFUSCATION_KEY` | obfuscation key for per-user TOTP secrets at rest (blank → derived from `AUTH_JWT_SECRET`; stdlib, not a KMS). |
| `TLSOC_SSO_CLIENT_SECRETS` | `SSO_CLIENT_SECRETS` | JSON map `provider_id → client_secret` for OIDC SSO (Google / Microsoft / generic); the rest of each provider (issuer / client-id / redirect / group→role) is configured in **Settings**. May also be pushed at runtime via `POST /api/auth/sso/providers/{id}/secret`. Redirect/callback URI to register with the IdP: `<base-url>/api/auth/sso/callback`. |
| `TLSOC_NOTIFICATION_SECRETS` | `NOTIFICATION_SECRETS` | JSON map `channel_id → {field: value}` seeding the per-channel **secret tier** at boot — covers the **SMTP password**, the **Resend API key**, the **SES IAM secret**, and Slack/Teams/webhook URLs + PagerDuty/Telegram tokens. The rest of each channel (provider/host/port/region/from/recipients) is **non-secret config set in Settings**. May also be pushed at runtime via `POST /api/notifications/channels/{id}/secret`. |

> **Most auth/MFA/SSO/notification/session settings are configured in the UI**, not
> env. In particular, the **session & access policy** (idle timeout, absolute
> lifetime, refresh TTL, step-up "sudo" re-auth window, new-device/terminate
> notify toggles) lives in **UI-editable Preferences** (`session_policy`), enforced
> by the async session check in `require_auth` — there are **no env vars** for those
> values; only `AUTH_JWT_SECRET` + `AUTH_TOKEN_HOURS` above bootstrap them.
> Channel + SSO **secrets** can also be pushed via the API into the in-memory secret
> tier (`POST /api/notifications/channels/{id}/secret`,
> `POST /api/auth/sso/providers/{id}/secret`) — durable only when set via env
> (`TLSOC_NOTIFICATION_SECRETS` / `TLSOC_SSO_CLIENT_SECRETS`). The env vars above are
> the durable/bootstrap path; the only one usually needed to turn the platform "on"
> is `TLSOC_AUTH_ENABLED=true`.

> **Email channels (Round 2):** alongside the stdlib **`email`** SMTP channel
> (13 provider presets), the suite now ships a **`resend`** channel (Resend HTTPS
> API — secret = the Resend API key) and an **SES** SMTP preset
> (`email-smtp.{region}.amazonaws.com`; the channel's `region` + optional AWS
> access-key-id are non-secret config, the SES SMTP/IAM secret is the channel
> secret). All three put their credential in the **secret tier**
> (`TLSOC_NOTIFICATION_SECRETS` at boot, or the runtime push above) — never in the
> config store, never in the UI bundle. Email bodies use 5 preloaded,
> operator-overridable **templates** rendered server-side with HTML-escaping of
> every interpolated variable (#9).

### 2.4 Secrets model (read this)
- **Global secrets** live in the deploy `.env` (`TLSOC_*`) / container environment —
  **never** in the UI bundle, **never** in a state index/table, **never**
  committed. The settings UI only ever sees a boolean `configured ✓` status, never
  values.
- **Two scoped ES API keys** (never the superuser): `ES_API_KEY` (read-only log
  surface) and `ES_MGMT_API_KEY` (read/write/create/manage `tlsoc-agent-*`, plus
  cluster `manage_ilm` + `manage_index_templates` + `monitor` for explicit own-state lifecycle preview/apply;
  only for the ES state backend).
- **Per-source connector secrets** (a webhook bearer token, an HMAC secret, a
  Splunk API token, …) are set per source via the first-run wizard or
  `POST /api/sources/{id}/secrets`. They live in the **in-memory secret tier**
  keyed `<source_id>.<field>`; the UI sees only the configured field *names*
  (`SourceInstance.configured_secrets`), never values.
- The wizard can push global keys at runtime too, but `state.apply_secrets` keeps
  them **in process memory only — lost on backend restart.** `.env` is the durable
  path for global secrets. (Roadmap: optional persisted encrypted secret store.)

### 2.5 Connectivity map (agnostic stack)
```
analyst browser ─ webui:80 (nginx) ─ /api proxy ─ tlsoc-backend:8088
                                                    │
        own state ── postgresql+asyncpg ── tlsoc-postgres:5432 (cases/audit/usage/config/cursor/RAG via pgvector)
        log source ── pull: https://<your-cluster>:9200 (read-only ES_API_KEY)  [Elastic/OpenSearch/Wazuh]
                    ── push: webhook/HEC :8088 · syslog :1514 · queues/object-stores (egress)
        enrichment ── Redis(tlsoc-redis:6379) + AbuseIPDB/VirusTotal (egress)
        LLM ────────── api.anthropic.com / api.openai.com (egress)
```

> A production deploy needs **outbound HTTPS** from `tlsoc-backend` to the
> configured LLM + enrichment providers (or a local/vLLM gateway). Without LLM
> egress, investigations fail safe to NEEDS_HUMAN (never dropped).

### 2.6 Cloud + local LLM providers (Rounds 3 & 9 — optional, default-off)

The single LLM gateway (`llm/gateway.py`, #6 — one ledger write per call) is
provider-agnostic across **7 providers**: `anthropic`, `openai`, `azure`,
`bedrock`, `vertex`, `openai_compatible`, `mock` (offline tests only). `anthropic` +
`openai` remain the default; Round 3 added three first-class cloud providers plus
any OpenAI-compatible endpoint, and Round 9 added a first-class **local / self-hosted
LiteLLM-compatible** provider on that same `openai_compatible` path — all keyed via
env and all **default-off** (no behavior change unless you wire a model to one in
**Settings → Models**). Keys are booleans in the UI (`configured ✓`), never values.

| Provider | Backend env | Notes |
|---|---|---|
| **Azure OpenAI** | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` (`https://<resource>.openai.azure.com`), `AZURE_OPENAI_API_VERSION` (e.g. `2024-10-21`) | falls back to `OPENAI_API_KEY` if the Azure key is blank |
| **AWS Bedrock** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | the gateway signs requests with a **stdlib SigV4** ladder (the same HMAC pattern as the SES email preset) — **no `boto3` dependency** |
| **Google Vertex** | `VERTEX_PROJECT`, `VERTEX_LOCATION` (e.g. `us-central1`), `VERTEX_API_KEY` | `VERTEX_API_KEY` is a **short-lived OAuth access token** carried as a Bearer (mint with your own credential flow / `gcloud auth print-access-token`) |
| **OpenAI-compatible** (vLLM / Ollama / OpenRouter / Together / Groq) | reuses `OPENAI_API_KEY` | no new key — set the model's **`base_url`** (+ optional `api_version`/`region`) in Settings → Models; one generalized client class drives them all |
| **Local / self-hosted (LiteLLM-compatible, Round 9)** | `LITELLM_API_KEY` (optional; falls back to `OPENAI_API_KEY`, or omit for a no-auth endpoint) | register via **Settings → Models → "Add local model"** (`POST/DELETE /api/llm/models/custom`); $0 pricing by default; a non-metered `POST /api/llm/providers/test` probes the endpoint without billing the ledger; see §2.3 for the three secret-supply paths |

A bundled `llm/model_registry.json` carries context-window / max-output / modality /
capability + input/output/cache pricing for the catalog; operators override prices
per model via the `PriceOverlayStore` (KV, no migration). An optional pre-flight
**`BudgetGate`** (daily/monthly ceilings on `Preferences.budget`, default on with a
$10/day blocking backstop) checks
`estimate_cost` BEFORE the call; over budget it raises so the investigator fails safe
to **NEEDS_HUMAN** — never a silent close (#3), and the ledger still writes exactly
once per real call (#6).

### 2.7 Enrichment providers (Rounds 3 & 11 — the EnrichmentProvider SPI)

Enrichment was generalized into an `EnrichmentProvider` SPI (`backend/app/enrichment/`)
mirroring the connector registry: an ABC + manifest (indicator types, auth fields,
free-tier note) + `tlsoc.enrichers` entry-point + type-routed parallel dispatch
(fail-open, Redis-cached) + a weighted aggregate. AbuseIPDB + VirusTotal were
refactored as the first two providers; `enrich_ip()` stays a byte-identical alias and
the default aggregation stays `max()` (weighted `fusion` is opt-in) so the risk-scorer
call site + the `EnrichmentResult` contract are unchanged (#3).

- **Keyless, default-on** (no env needed): **Shodan InternetDB**, **IPinfo Lite**,
  the **abuse.ch trio** (URLhaus / MalwareBazaar / ThreatFox), **RDAP** + **DoH**.
- **Keyed, optional + default-off** (toggle in **Settings → Enrichment**; the env key
  only enables it): `GREYNOISE_API_KEY`, `SHODAN_API_KEY`, `CENSYS_API_ID` +
  `CENSYS_API_SECRET`, `BINARYEDGE_API_KEY`, `IPINFO_TOKEN`, `OTX_API_KEY`,
  `PULSEDIVE_API_KEY`, `SPUR_API_KEY`, `XFORCE_API_KEY` + `XFORCE_API_PASSWORD`,
  `URLSCAN_API_KEY`, `HIBP_API_KEY`, `HONEYPOT_ACCESS_KEY` (Project Honeypot http:BL —
  also set `EnrichmentConfig.use_honeypot`), and `ABUSECH_AUTH_KEY` (an optional
  abuse.ch Auth-Key that lifts the keyless rate caps).
- **Multi-indicator**: `enrich_indicator(value, kind)` routes IP / domain / hash / url
  / email to the providers that support each kind. Free tiers are tiny (Shodan ~1 req/s,
  Censys ~1 req/2.5s, GreyNoise 50/week) so each provider carries a per-provider TTL +
  rate guard. Every provider string (PTR/banner/tags/reputation text) is treated as
  **UNTRUSTED** and fenced before any prompt / escaped in the UI (#9); enrichment is
  **advisory only** and never feeds the deterministic `decide()` (#3).

**Round 11** grew the registry from 19 to **38 providers** (19 new):

- **Keyless, default-on** (no env needed): **CIRCL hashlookup** (known-good file
  hashes), **SANS ISC DShield** (IP sensor sightings), **Onionoo** (Tor relay/exit
  context).
- **Keyless, default-off** (opt in via **Settings → Enrichment**): **Spamhaus
  ZEN/DBL** and **Team Cymru MHR** (DNS lookups — they need the host's OWN recursive
  resolver; public resolvers are refused), **Robtex** and **crt.sh** (slow free
  tiers).
- **Keyed, default-off** (the env key only enables the toggle — 12 new keys, all
  `TLSOC_`-prefixed in `.env`, see §2.3): `CROWDSEC_API_KEY` (CrowdSec CTI),
  `GOOGLE_SAFEBROWSING_API_KEY`, `IPQUALITYSCORE_API_KEY`, `IPDATA_API_KEY`,
  `APIVOID_API_KEY`, `MALTIVERSE_API_KEY`, `SECURITYTRAILS_API_KEY`,
  `CRIMINALIP_API_KEY`, `NETLAS_API_KEY`, `HYBRID_ANALYSIS_API_KEY`,
  `METADEFENDER_API_KEY`, `EMAILREP_API_KEY`.

Every provider manifest now carries `setup_steps` (ordered operator steps naming the
exact env var to set) and an `example` blurb ("how this source helps triage");
`GET /api/enrichment/providers` serialises both and the Settings → Enrichment
provider cards render them as per-provider "How to set up" guidance. Score
discipline is unchanged (#3): verdict feeds score 80–90, graded reputations map onto
0..100, and context-only sources cap at ≤40 with `malicious=False`, so no context
provider alone can cross the default `max()` fusion cut.

> Compose note: both reference compose files (agnostic + legacy) map every cloud-LLM
> and enrichment key above (`TLSOC_*` → the unprefixed backend names) — no manual
> `environment:` edits are needed for these. The one exception is `LITELLM_API_KEY`
> (§2.3), which is not forwarded today. Running the backend directly, it reads the
> unprefixed names from the environment as-is.

### 2.8 Autopilot defaults (Round 10 — UI-editable Preferences, not env)

Round 10 flipped the suite's out-of-the-box posture from "wait for an operator to opt
in" to **comprehensive ingestion + a self-tuning autopilot**: every event from every
source is now correlated + risk-scored by default, and the $0/#3-safe advisory engines
(threshold tuning, campaigns, cross-source correlation, SLA/priority, baseline,
realtime SSE) ship **ON**. None of this is an env var — it all lives on
**`Preferences`** (`GET`/`PUT /api/settings`), so it is operator-tunable at runtime,
no restart required. See `docs/USAGE.md` §33 for the full behavioral explanation and
the industry-standard citations behind the numbers; this is just the knob reference.

| Preference | Default | Notes |
|---|---|---|
| `background_scan_enabled` | **`true`** (was `false`) | comprehensive ingestion — every source is correlated + risk-scored, not just what's on the auto-forward allowlist |
| `auto_investigate_risk_floor` | **`70`** | the deterministic risk-gate floor: an `events`-role cluster auto-forwards to the strong-LLM investigation once `risk_score >= floor`; below-floor clusters stay `$0` OPEN candidates — risk-scored, visible, never dropped (#4) |
| `autopilot_profile` | `"balanced"` (`conservative` \| `balanced` \| `aggressive`) | one dial that moves the three rows above/below together — see the profile table in `docs/USAGE.md` §33 |
| `caps.max_auto_investigations_per_tick` | **`25`**, **GLOBAL PER POLL TICK** | one concurrency-safe ceiling shared across every concurrently polled source in the manager fan-out; each direct push batch enforces the same configured cap locally. Cap-deferred candidates drain later once headroom frees. The **daily USD budget below remains the global spend bound** — this cap smooths *when* spend happens |
| `budget.{enabled,daily_usd,soft_warn_pct,on_exceed}` | `true` / `10.0` / `0.8` / `"block"` | the default spend backstop (pairs with §2.6's per-model pricing); the provider call is stopped before spend and the case fails safe to `NEEDS_HUMAN`, never a silent drop or close (#3/#4). Warning-only mode is an explicit operator choice. |
| `baseline.{enabled,warmup_days,max_series}` | `true` / `14` / `50000` | the entity-baseline producer now runs from day one (silent-source + volume-flood detection); `warmup_days` is the advisory wall-clock warm-up target shown in the UI gauge, `max_series` LRU-bounds cardinality (`0` = unbounded) |
| `threshold_tuning.enabled` (+ `shadow_eval` forced `true`) · `campaign.enabled` · `cross_source_correlation.enabled` · `sla.enabled` · `priority_matrix.enabled` · `realtime.enabled` · `threshold_automation.enabled` (ships with `rules: []`) | all **`true`** | the default-ON $0/#3-safe smart engines — full behavior + what's still opt-in in `docs/USAGE.md` §33 |

**Migration, not a fork.** A `Preferences` document **persisted before this round**
auto-adopts the new ON defaults exactly once (an internal `autopilot_config_version`
marker) and sets `show_autopilot_banner=true` so the change is announced in the UI,
never silent. An explicit opt-out an operator saved **after** that marker is preserved
byte-for-byte — the migration never re-overwrites a deliberate choice. A **fresh
install** simply starts at the defaults above with no banner at all.

**Still opt-in (unchanged defaults):** `batch.enabled` (§2.6 covers the batch/flex LLM
paths), changing the default blocking budget to warning-only, any
`run_playbook`/`notify` action on a
case-automation rule, and baseline-driven auto-investigation — baseline stays a pure
advisory producer that never calls `decide()` or forwards to investigation by itself
(#3/#4).
