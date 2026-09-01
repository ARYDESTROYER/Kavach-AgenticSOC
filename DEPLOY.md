# DEPLOY.md — Deploying Agentic SOC

This is the deployment guide for the **vendor-agnostic, self-hosted Agentic SOC**.
The product is a read-only triage layer that consumes alerts from
**any** SIEM / EDR / XDR and turns raw alert volume into audited, cost-metered,
human-reviewable cases.

The current source version is `0.1.13` (documentation line `0.1`). Source builds
default to `TLSOC_RELEASE_CHANNEL=testing`; set `stable` only while building the
exact accepted `main` commit from its immutable `v0.1.13` tag. Version and channel
are independent, so a Testing candidate cannot report itself as Stable merely
because it already carries the final SemVer.

> **Release topology:** the remote uses `Testing` for integration and default
> `main` for accepted Stable source. Version 0.1.13 is Stable only when its exact
> verified `main` commit has the immutable `v0.1.13` tag and matching artifacts. Branch
> protections, required checks, and release-environment policies are repository
> administration controls; verify them independently rather than inferring
> acceptance from a branch or tag name.

> **Do not deploy or bootstrap from `v0.1.4` or `v0.1.5`.** Those immutable
> publication attempts did not produce a canonical signed plan and public GitHub
> Release, so neither is an installation source. Use `v0.1.13` only when the complete
> publication gate, canonical signed Release,
> anonymous digest-pull evidence, and canonical PostgreSQL Compose runtime acceptance
> verify; otherwise use a previously verified
> Stable release.
>
> **Do not deploy or bootstrap from `v0.1.6`.** Its immutable signed images, plan,
> bundle, and GitHub Release published successfully, but canonical macOS Bash 3.2
> bootstrap acceptance failed before supervisor installation. The immutable
> `v0.1.7` publication also completed every signed/public artifact gate, but its
> updater could not publish the private control socket under `cap_drop: ALL` on
> Docker Desktop. The separately published `v0.1.8` correction reached signed-plan
> verification, where cosign 3 attempted to write its default TUF cache beneath the
> read-only `/root` filesystem. The immutable `v0.1.9` attempt corrected that cache
> boundary, then its constrained supervisor could not traverse the runner-owned
> verification directory; it published no GitHub Release or installable plan. All
> four are preserved as evidence. The immutable `v0.1.10` tag later passed source
> and exact-tag CI but timed out while target emulation ran the Web Console builder;
> it published no GitHub Release or installable signed plan. The immutable
> `v0.1.11` workflow then built, signed, anonymously proved, and verified all three
> images and the plan, but failed during post-verification fixture cleanup before
> attestations, GitHub Release, canonical assets, Stable tags, or Stable
> documentation. The immutable `v0.1.12` release subsequently completed the entire
> signed/public publication gate, including anonymous reads and Stable documentation,
> but canonical v0.1.1 bootstrap failed closed before application mutation because
> two matching missing legacy state-schema labels were normalized asymmetrically.
> These historical attempts are superseded by the separately gated `v0.1.13`
> correction and are not supported installation sources.

> **The SIEM is NOT baked into the stack.** You connect your log source(s) from
> the **first-run wizard** ("add a source") AFTER the stack is up — not in a
> compose file. One deployment can read from Elasticsearch, OpenSearch, Wazuh, a
> webhook, syslog, Kafka, and more.

> **New here?** Start with **[`docs/HANDOFF.md`](docs/HANDOFF.md)** — the
> onboarding map (repo layout, the green baseline, how to run it) — then return
> here to deploy.

> **Just want a guided demo?** See **[`DEMO.md`](DEMO.md)** — `./scripts/run-demo.sh`
> brings the suite up locally with **auth enabled** (login + RBAC + MFA + SSO live)
> and the seeded `Admin` / `Admin@123` super_admin, then walks every headline
> feature in order.

---

## 1. Overview — two deployment modes

| | **Mode A — Agnostic stack (RECOMMENDED)** | **Mode B — Existing ELK attachment (optional)** |
|---|---|---|
| What runs | A self-contained stack: Postgres (+pgvector), Redis, the backend, the standalone React + Tailwind + shadcn web UI (nginx), and the isolated update supervisor. | The backend (+Redis) attached to an existing ELK stack; run the supported standalone web UI separately. |
| Own state | PostgreSQL — **no Elasticsearch required** for the app's own bookkeeping. | The suite's own `tlsoc-agent-*` Elasticsearch indices. |
| UI | Standalone SPA at `http://localhost:8080`. | The same standalone SPA; the old Kibana plugin is archived and unsupported. |
| Log source | Connected from the wizard (pull or push). | Connected from the wizard (pull or push). |
| When to use | New deployments; any SIEM/EDR/XDR; no Kibana dependency. | You already operate compatible Elasticsearch and want Agentic SOC state in dedicated ES indices. |
| Compose file | `deploy/docker-compose.agnostic.yml` | `deploy/docker-compose.tlsoc.yml` (a service block to merge) |

In **both** modes the agent's log-reading surface is the **connector layer**
configured in the wizard — the product reads from any source, and the state
backend choice is independent of where logs come from.

---

## 2. Prerequisites

- **Docker** and **Docker Compose v2** (`docker compose`, not the legacy
  `docker-compose`).
- **Recommended for full live triage:** an OpenAI key for the fresh-install GPT-5.6
  Luna completion defaults, or another supported provider key plus explicit role
  reassignment. The deployment can launch with the built-in `mock` runtime, but
  setup truthfully labels that live state as limited. Synthetic demo always forces
  the isolated `$0` mock runtime.
- **For a PULL log source** (Elasticsearch / OpenSearch / Wazuh): a **read-only**
  credential (an ES-compatible API key) and the cluster URL. PUSH sources
  (webhook/HEC/syslog/Kafka/…) need no log-source credential at all.
- Outbound network access for: pulling base images (`pgvector/pgvector:pg16`,
  `redis:7-alpine`, `python:3.11-slim`, `node:22-alpine`, `nginx:1.27-alpine`),
  building the three local application images, and reaching your LLM provider's API.

---

## 3. Mode A — Agnostic stack (primary)

`deploy/docker-compose.agnostic.yml` brings up five services:

| Service | Image | Role |
|---|---|---|
| `tlsoc-postgres` | `pgvector/pgvector:pg16` | The app's OWN state (cases/audit/usage/config/cursor + RAG vectors). Replaces the `tlsoc-agent-*` ES indices. |
| `tlsoc-redis` | `redis:7-alpine` | Enrichment + dedup cache (recommended; backend falls back to in-memory without it). |
| `tlsoc-backend` | built from `backend/Dockerfile` | FastAPI + LangGraph agent. Started with `STATE_BACKEND=postgres`. Listens on `:8088`. |
| `tlsoc-webui` | built from `webui/Dockerfile` with the repository-root context | The standalone React Console plus version-matched MkDocs Help Center, served by nginx on `:80` and published as `:8080`. Serves `/docs/<major.minor>/` locally and proxies `/api/*` to the backend. |
| `agentic-soc-updater` | built from `updater/Dockerfile` | Private Unix-socket supervisor for signed, digest-pinned application updates. It alone mounts the Docker socket. |

### 3.1 Configure `.env`

From the **repo root**:

```bash
cp .env.example .env
```

For Mode A you must fill in:

- **`TLSOC_PG_PASSWORD`** — required; the Postgres password. The compose file
  refuses to start without it.
- **At least one LLM key** — `TLSOC_ANTHROPIC_API_KEY` and/or
  `TLSOC_OPENAI_API_KEY`.

Optional for Mode A:

- `TLSOC_ES_URL` + `TLSOC_ES_API_KEY` — pre-seed an Elasticsearch / OpenSearch /
  Wazuh **pull** log source so it's wired at boot (you can instead add it in the
  wizard). `TLSOC_ES_CA_CERT` + `TLSOC_ES_VERIFY_CERTS` if that cluster uses a
  private CA.
- `TLSOC_ABUSEIPDB_API_KEY`, `TLSOC_VIRUSTOTAL_API_KEY` — enrichment (degrades
  gracefully if absent).
- **Cloud LLM providers (Round 3, optional, default-off):** `TLSOC_AZURE_OPENAI_API_KEY`
  (+ `_ENDPOINT` / `_API_VERSION`) for Azure OpenAI; `TLSOC_AWS_ACCESS_KEY_ID` /
  `TLSOC_AWS_SECRET_ACCESS_KEY` / `TLSOC_AWS_REGION` for AWS Bedrock (stdlib SigV4, no
  `boto3`); `TLSOC_VERTEX_PROJECT` / `_LOCATION` / `_API_KEY` for Google Vertex. Any
  OpenAI-compatible endpoint (vLLM/Ollama/OpenRouter/Together/Groq) needs no new key —
  set the model's `base_url` in Settings → Models. See `docs/ENVIRONMENT.md` §2.6.
- **Local / self-hosted models — LiteLLM-compatible (Round 9, optional):** a
  self-hosted LiteLLM proxy / vLLM / Ollama / LM Studio endpoint reuses the
  `openai_compatible` provider path and needs **no new key at all** if it's
  unauthenticated — just set the model's `base_url` in **Settings → Models → "Add
  local model"** (`POST /api/llm/models/custom`). If your endpoint *does* require a
  key, the optional secret is `litellm_api_key` (env `LITELLM_API_KEY`), with three
  supply paths: (a) set `TLSOC_LITELLM_API_KEY` in `.env` **and** add a matching
  `- LITELLM_API_KEY=${TLSOC_LITELLM_API_KEY:-}` line to the `tlsoc-backend`
  `environment:` block yourself — **the agnostic compose does not forward it yet**;
  (b) push it at runtime through the "Add local model" dialog; or (c) omit it
  entirely and let the gateway fall back to `OPENAI_API_KEY`. See
  `docs/ENVIRONMENT.md` §2.6.
- **More enrichment providers (Round 3, optional):** 17 providers behind an
  `EnrichmentProvider` SPI. Keyless ones (Shodan InternetDB, IPinfo Lite, abuse.ch
  URLhaus/MalwareBazaar/ThreatFox, RDAP/DoH) are **default-on, no key**. Keyed +
  default-off: `TLSOC_GREYNOISE_API_KEY`, `TLSOC_SHODAN_API_KEY`, `TLSOC_CENSYS_API_ID`/
  `_SECRET`, `TLSOC_BINARYEDGE_API_KEY`, `TLSOC_IPINFO_TOKEN`, `TLSOC_OTX_API_KEY`,
  `TLSOC_PULSEDIVE_API_KEY`, `TLSOC_SPUR_API_KEY`, `TLSOC_XFORCE_API_KEY`/`_PASSWORD`,
  `TLSOC_URLSCAN_API_KEY`, `TLSOC_HIBP_API_KEY`, `TLSOC_HONEYPOT_ACCESS_KEY`,
  `TLSOC_ABUSECH_AUTH_KEY`. Toggle each in Settings → Enrichment. See
  `docs/ENVIRONMENT.md` §2.7. (When running under Compose, add the matching unprefixed
  `- AZURE_OPENAI_API_KEY=${TLSOC_AZURE_OPENAI_API_KEY:-}` line to the `tlsoc-backend`
  `environment:` block for each provider you enable.)
- `TLSOC_EMBEDDING_API_KEY` — embeddings for RAG (falls back to the OpenAI key,
  then to local hashing embeddings).
- `TLSOC_PG_USER` / `TLSOC_PG_DB` (default `tlsoc` / `tlsoc`), `TLSOC_REDIS_URL`,
  `TLSOC_LOG_LEVEL`.

> **`TLSOC_ES_MGMT_API_KEY` is NOT used in Mode A** — that key is only for the
> legacy Elasticsearch state backend (Mode B). Postgres holds the app's state here.

### 3.2 The env-var mapping (READ THIS — it trips everyone up)

**The backend reads UNPREFIXED env names** (`config.py` `Secrets`): `ES_API_KEY`,
`ES_URL`, `STATE_BACKEND`, `STATE_DB_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`REDIS_URL`, etc. **Your `.env` uses `TLSOC_*` names.** The **compose file** is
what maps one onto the other — you never set the unprefixed names yourself.

In `deploy/docker-compose.agnostic.yml` specifically:

- It hard-codes **`STATE_BACKEND=postgres`** itself.
- It **builds `STATE_DB_URL` for you** from the `TLSOC_PG_*` vars:
  `postgresql+asyncpg://${TLSOC_PG_USER}:${TLSOC_PG_PASSWORD}@tlsoc-postgres:5432/${TLSOC_PG_DB}`.
- It maps `TLSOC_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY`, `TLSOC_ES_API_KEY →
  ES_API_KEY`, `TLSOC_REDIS_URL → REDIS_URL`, and so on.

So in Mode A you only ever edit `TLSOC_*` in `.env`; the compose file translates.

### 3.3 Bring it up

From the **repo root**:

```bash
./scripts/agentic-soc-compose.sh up -d --build
```

> **Always redeploy through the wrapper — and if you script your own recipe, pass
> BOTH `TLSOC_BUILD_SHA` and `TLSOC_BUILD_DATE`.** Compose expands them into the
> backend/Web/updater build arguments with an `:-unknown` fallback, and the
> Dockerfiles bake the result into `org.opencontainers.image.revision`, the running
> process environment, and therefore the `build_sha` of every case, audit, and usage
> record the deployment writes. `scripts/agentic-soc-compose.sh` derives both from
> the checkout (`scripts/lib/build-identity.sh`) so a plain source build is stamped
> honestly; a raw `docker compose build` is not, and a half-stamped pair — one value
> supplied, the other left to fall through — is worse than neither, because
> `/api/health/build-info` then reports a build nothing can reproduce. The two cases
> surface on different channels, so read both: an **unstamped** build is reported by
> `/api/health/build-info` as `provenance_complete: false`, naming the absent fields
> in `provenance_missing`; a **half-stamped or otherwise unpinnable** identity is
> additionally logged as a startup warning and listed in `provenance_advisories`.
> Before it builds, `scripts/agentic-soc-compose.sh` also prints one stderr line
> whenever the identity it resolved is degraded — an `unknown` SHA or date, or a
> `<sha>-dirty` suffix.

This builds the backend, Web, and updater images and starts all five services. Then open:

```
http://localhost:8080
```

You land on the **first-run wizard**.

### 3.4 The first-run wizard

The setup workspace has four stages:

1. **Workspace** — choose **Live environment** or **Synthetic demo**. Demo seeds
   isolated sample activity and uses the deterministic `$0` mock runtime; it never
   calls a configured live provider.
2. **Data sources** — pick a connector and configure it (see §3.5 / §3.6). The
   wizard lists every available connector and its field schema from
   `GET /api/connectors`. **Test connection** evaluates the current draft through
   `POST /api/connectors/test` without saving it. If you navigate away while the
   editor is open, setup asks before discarding that draft.
3. **AI runtime** — add an OpenAI key for the default GPT-5.6 Luna runtime, or an
   alternate provider key if you will change the role assignments. Keys are write-only:
   setup shows configured state, never the value. Newly typed keys save through
   `POST /api/setup/secrets` whenever you leave this stage; a failed save keeps you
   on the stage. Model registration, per-role assignment, and budgets remain in
   **Settings → Models** after launch.
4. **Review & launch** — reports **Ready**, **Needs attention**, or **Optional**
   for the workspace, sources, and AI runtime. A live workspace without a source or
   provider may launch, but is explicitly labelled **Ready with limited
   capabilities**. The Automation posture notes that adaptive routing and related-
   case grouping are on by default while detailed control remains in Settings;
   deterministic close/escalate authority is unchanged. **Launch Agentic SOC**
   calls `POST /api/setup/complete`, which flips `setup_complete`, starts pull
   polling, and reconciles enabled receivers.

The first-run app does not fail open. If `GET /api/setup/status` is unavailable,
it shows **Can't verify setup state** with **Retry** rather than exposing the
operational console. Administrators can later re-run setup from Settings; its final
action is **Apply changes**, and existing sources and credentials remain unless
explicitly changed or removed.

After finishing, trigger an immediate poll for the demo with **`POST /api/poll`**
(or the Settings page button).

### 3.5 Connecting a PULL source (Elasticsearch / OpenSearch / Wazuh)

A pull source is one ES-API-compatible cluster the poller queries on a durable
cursor. In the wizard, for the chosen connector, provide:

- the cluster **URL** (e.g. `https://elasticsearch:9200`),
- a **read-only API key** (least-privilege; see §8),
- a private-CA cert path if the cluster uses one,
- the **per-source field mapping** (defaults: data view `all-logs-*`, time field
  `@timestamp`, `source.ip` / `user.name` / `host.name`, rule field
  `event.module`, severity field `event.severity`).

You can also pre-seed one pull source at boot via `TLSOC_ES_URL` +
`TLSOC_ES_API_KEY` (mapped to `ES_URL` / `ES_API_KEY`).

> **Honesty about scope.** Today's **pull** connectors are **Elasticsearch,
> OpenSearch, and Wazuh** (Wazuh via its indexer). `PollerManager` fans out across
> every enabled pull-source/feed pair with an independent durable cursor and
> in-flight signature lock, so one deployment can poll multiple configured pull
> clusters. Native PULL for Splunk / Microsoft Sentinel / QRadar / Chronicle /
> EDR-XDR vendors remains outside 0.1; those vendors can push to the suite today
> through the generic receivers below.

### 3.6 Connecting a PUSH source (webhook / HEC / syslog / queues / object stores)

A push source forwards events **to** the suite; no log-source credential needed.

**HTTP push (webhook / HEC)** — the simplest path. After adding a webhook/HEC
source in the wizard, the source POSTs alerts to:

```
POST /api/ingest/{source_id}
```

The receiver verifies auth, parses (JSON/NDJSON/CEF/LEEF/syslog/GELF/kv —
auto-detected), normalises to OCSF, and the events flow into the **same**
correlate → case pipeline the poller feeds.

Set the per-source auth secret (bearer token / HMAC key) via the secrets endpoint
— it goes to the **secret tier (in memory), never to the persisted config**:

```bash
# Set a bearer token for a source whose id is "my-webhook":
curl -X POST http://localhost:8080/api/sources/my-webhook/secrets \
  -H 'Content-Type: application/json' \
  -d '{"token": "REPLACE_WITH_A_LONG_RANDOM_SECRET"}'

# The source then pushes alerts (one or many, JSON/NDJSON/CEF/LEEF/…):
curl -X POST http://localhost:8080/api/ingest/my-webhook \
  -H 'Authorization: Bearer REPLACE_WITH_A_LONG_RANDOM_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"event.module":"web_auth","source.ip":"203.0.113.7","user.name":"alice"}'
```

(The web UI proxies `/api/*` to the backend, so you can hit either
`http://localhost:8080/api/...` through nginx or `http://localhost:8088/api/...`
directly.)

**Listener / queue / object-store receivers** run as background drivers inside the
backend container. **For socket-based receivers (e.g. syslog) you must publish the
listener port** by editing the `ports:` of `tlsoc-backend` in
`deploy/docker-compose.agnostic.yml` (the file ships with the lines commented):

```yaml
    ports:
      - "8088:8088"
      - "1514:1514/udp"   # syslog UDP
      - "1514:1514/tcp"   # syslog TCP
```

Then `./scripts/agentic-soc-compose.sh up -d` to apply.

For encrypted Syslog, set the source protocol to `tls`, mount the server certificate
and private key into the backend container, and configure their **container paths** as
`tls_cert_file` and `tls_key_file`. A private-key password, when required, is supplied
through the source's write-only `tls_key_password` secret. To require client
certificates, also set `tls_client_ca_file` and `tls_require_client_cert=true`.
The listener requires TLS 1.2 or newer and refuses to start if any configured material
is missing or unreadable; it never falls back to plaintext TCP.

The **16 built-in push receivers** (`SourceType` → optional pip dependency):

| SourceType | Mode | Optional pip dep |
|---|---|---|
| `webhook` | PUSH_HTTP | none (stdlib; the FastAPI app owns the port) |
| `hec` | PUSH_HTTP | none |
| `syslog` | PUSH_SYSLOG / PUSH_SOCKET | none (stdlib asyncio + TLS) |
| `kafka` | QUEUE | `confluent-kafka` |
| `aws_sqs` | QUEUE | `boto3` |
| `aws_kinesis` | QUEUE / STREAM | `boto3` |
| `azure_event_hub` | QUEUE | `azure-eventhub` |
| `gcp_pubsub` | QUEUE | `google-cloud-pubsub` |
| `rabbitmq` | QUEUE | `aio-pika` |
| `nats` | QUEUE | `nats-py` |
| `mqtt` | QUEUE | `paho-mqtt` |
| `redis_streams` | QUEUE | `redis` |
| `s3` | OBJECT_STORE | `boto3` |
| `gcs` | OBJECT_STORE | `google-cloud-storage` |
| `azure_blob` | OBJECT_STORE | `azure-storage-blob` |
| `file` | OBJECT_STORE / PUSH_SOCKET | none (stdlib tail) |

Every optional client is imported **lazily**. The shipped Dockerfile's default
`full` target installs the complete receiver dependency set; the deliberately
smaller `core` target does not. A custom core-based deployment that configures a
missing receiver gets a clear error with the exact `pip install` hint. If your
organization deliberately publishes the `core` target under a site-specific image
name, add only the required clients in a derived image, for example:

```dockerfile
FROM registry.example/tlsoc-backend-core:0.1.13
RUN pip install --no-cache-dir confluent-kafka boto3   # only what you need
```

…then point the `tlsoc-backend` service's `image:`/`build:` at it and rebuild.

### 3.7 Verify

```bash
# Backend health (directly, or through the UI proxy at :8080/api/health):
curl -s http://localhost:8088/api/health
#   -> {"status":"ok","version":"...","es_connected":...,"store_type":"...","setup_complete":...}
```

> **Reading `store_type` and `es_connected` correctly.** `store_type` is always
> `type(state.es).__name__` — `RealESClient` or `InMemoryESClient`, the **log-surface
> ES client class** — it **never** reports which `STATE_BACKEND` you chose. In
> **Mode A** (Postgres/SQLite own-state) **with no Elasticsearch/OpenSearch/Wazuh
> pull source wired**, `store_type:InMemoryESClient` is **expected and benign**, not
> a Postgres/SQLite outage. `es_connected` is the pull-source connection — `false`
> until you add and test one, also expected at this point. `store_type` only matters
> for durability when `STATE_BACKEND=elasticsearch` (Mode B): there, `RealESClient`
> means own-state writes land in real Elasticsearch, while `InMemoryESClient` means
> the ES connection failed and data is not durable.

```bash
# Service status + logs:
./scripts/agentic-soc-compose.sh ps
./scripts/agentic-soc-compose.sh logs -f tlsoc-backend

# The wizard's "Test connection" (or directly):
curl -s -X POST http://localhost:8088/api/connectors/test -H 'Content-Type: application/json' -d '{}'

# After a poll, the first cases:
curl -s -X POST http://localhost:8088/api/poll
curl -s http://localhost:8088/api/cases
```

---

## 4. State backend choice

The suite's OWN bookkeeping — cases, audit log, usage/cost ledger, preferences,
the durable polling cursor, and RAG vectors — is stored in a **state backend**,
chosen with `STATE_BACKEND` (and `STATE_DB_URL` for SQL backends). This is
**independent** of where your logs come from (that's always the connector layer).

| `STATE_BACKEND` | `STATE_DB_URL` | What it needs | When to pick it |
|---|---|---|---|
| `postgres` | `postgresql+asyncpg://user:pass@host:5432/db` | PostgreSQL **with pgvector** (for RAG) | **Mode A default.** Production self-hosting with no Elasticsearch dependency; durable, scalable. |
| `sqlite` | `sqlite+aiosqlite:////data/tlsoc.db` (blank → `./tlsoc.db`) | nothing extra | Single-node / evaluation / smallest footprint. |
| `elasticsearch` (default in `config.py`) | n/a | The suite's `tlsoc-agent-*` indices + a management ES key | **Mode B.** You already run Elasticsearch and want the app's state there too. |

Notes:
- **pgvector** is required for RAG on Postgres — Mode A's `pgvector/pgvector:pg16`
  image provides it. Without a vector backend, RAG retrieval degrades gracefully.
- For Postgres/sqlite, `ES_MGMT_API_KEY` is **not** required (no `tlsoc-agent-*`
  indices). For the `elasticsearch` state backend it **is** (see Mode B).
- In `.env`, the equivalents are `TLSOC_STATE_BACKEND` and `TLSOC_STATE_DB_URL`,
  but **Mode A's compose sets `STATE_BACKEND=postgres` and builds `STATE_DB_URL`
  itself** — leave those `.env` lines alone for Mode A.

---

## 5. Secrets model

- **All secrets live in the env / secret tier only** — never in any persisted
  config document, never returned to a UI, never logged. The UI shows boolean
  `configured ✓` status only (`config.py` `configured_status()`).
- **Provider + connection secrets** come from the environment (mapped by compose
  from `TLSOC_*`), and the wizard can also push them at runtime
  (`POST /api/setup/secrets`) — runtime-pushed values are **in process memory
  only** and lost on a backend restart. **`.env` is the durable path.**
- **Per-source secrets** (a webhook bearer token, an HMAC key, a vendor API
  token) are set via `POST /api/sources/{id}/secrets` (or the wizard). They go to
  the secret tier keyed by source id, are **never persisted to the config store**,
  and only the secret field **names** are recorded on the source
  (`configured_secrets`) so the UI can show which are set without revealing them.

---

## 6. Operations

**Start / stop / restart / logs / health** (Mode A; for Mode B use your stack's
compose file and the service names):

```bash
cd <repo-root>
./scripts/agentic-soc-compose.sh up -d            # start
./scripts/agentic-soc-compose.sh ps               # status
./scripts/agentic-soc-compose.sh logs -f tlsoc-backend
./scripts/agentic-soc-compose.sh restart tlsoc-backend
./scripts/agentic-soc-compose.sh down             # stop (keeps volumes)
curl -s http://localhost:8088/api/health
```

**Backups.**

- *Postgres state backend (Mode A):* dump the database (the `tlsoc-pgdata` named
  volume holds everything):
  ```bash
  docker exec tlsoc-postgres pg_dump -U tlsoc tlsoc > tlsoc-backup-$(date +%F).sql
  # restore:
  cat tlsoc-backup-YYYY-MM-DD.sql | docker exec -i tlsoc-postgres psql -U tlsoc -d tlsoc
  ```
- *sqlite backend:* back up the `.db` file (copy the bind-mount / volume path you
  set in `STATE_DB_URL`).
- *Elasticsearch state backend (Mode B):* use Elasticsearch **snapshots** of the
  `tlsoc-agent-*` indices via your stack's snapshot repository.

  Keep every Elasticsearch snapshot-repository object directly readable by
  Elasticsearch. **Do not attach an S3 lifecycle rule that moves the repository
  prefix to Glacier**; archived repository objects can make the snapshot repository
  unusable. A Glacier copy must instead be an independent, immutable application
  export with its own manifest, checksums, catalog, and tested restore procedure.

**Upgrades.** Deploy an exact accepted tag or digest; do not run a generic
`git pull` and assume the resulting checkout is an accepted release. The canonical
`main` branch carries Stable source, while `Testing` carries the next integration
candidate, but repository protections and required checks must still be verified
independently. Back up first and follow
[`docs/operations/upgrades.md`](docs/operations/upgrades.md):

```bash
cd <repo-root>
git fetch --tags origin
git checkout v0.1.13   # replace with the exact accepted release tag
./scripts/agentic-soc-compose.sh up -d --build
```

Once its immutable publication gate completes, version 0.1.13 is the supported
bootstrap boundary for supervised updates. The supported v0.1.1→v0.1.13 transition must run
from the clean, exact annotated v0.1.13 tag whose commit remains contained in
`origin/main`, while the reference v0.1.1 PostgreSQL stack is still running:

```bash
./scripts/bootstrap-updater.sh
```

That host-authorized step installs the private Unix-socket supervisor transport, then
has it verify, preflight, and apply the signed, digest-pinned v0.1.13 release. The
bootstrap transition therefore uses the same pull-first, quiesce, PostgreSQL backup,
identity/readiness, receipt, and automatic rollback state machine as later Console
updates. After bootstrap, a freshly authenticated built-in super administrator can
install a later compatible Stable release from the top-bar **Update vX.Y.Z** action.
Bootstrap restores a preserved override only before durable job submission. Before
the `/v1/jobs` request it transfers ownership to the supervisor, so an interrupted
client never races the accepted job by rewriting active pins. Its mode-0600,
per-release start key is reused across interruptions and retired only after the exact
job is observed terminal.

A Testing/source-built 0.1.3 deployment, the non-installable `v0.1.4` and `v0.1.5`
publication attempts, the published-but-bootstrap-blocked `v0.1.6` through
`v0.1.8` records, the failed-publication `v0.1.9` through `v0.1.11` records, and the
fully published but bootstrap-blocked `v0.1.12` record cannot be relabeled Stable.
If an earlier attempt left an inspectable idle supervisor
while the application remained on v0.1.1, the 0.1.13
bootstrap replaces that version-mismatched supervisor before signature verification.
Reconcile other states only through the documented 0.1.13 path appropriate to their
actual installed release. Bootstrap requires a strictly newer target, so an already
running 0.1.13 deployment cannot bootstrap itself from the same plan.

The supported one-click profile is intentionally narrow: the reference standalone,
single-replica Docker Compose deployment with the signed canonical base-file hash,
canonical project/network/service and PostgreSQL-volume identity, coherent installed
schema labels, PostgreSQL-owned state, durable `.env` configuration, no database
migration, and a compatible updater protocol. SQLite,
Elasticsearch-owned state, external PostgreSQL, the legacy ELK attachment,
Kubernetes, horizontal replicas, custom Compose topologies, infrastructure-image
changes, and migration-bearing releases remain manual and appear as explicit
blockers. PostgreSQL and Redis are never silently upgraded by the application updater.

The browser submits only an opaque server-advertised release ID, preflight token, and
idempotency key. It never receives Docker access, registry credentials, host paths,
commands, Compose fragments, image references, or backup contents. After the
supervisor verifies the new pair, the existing same-origin manifest/readiness checks
reload the open tab while preserving its hash route; known unsaved drafts block that
reload.

The Stable-branch check is mutable discovery only. It can show an update candidate,
but selecting the candidate must still pass immutable signed-release preflight before
confirmation. The branch HEAD is observation-only; Stable candidates are bound to the
immutable commit dereferenced from the exact annotated `vVERSION` tag. The official
supervisor holds no registry credentials, so the
release's `backend`, `webui`, and `updater` GHCR packages must be publicly and
anonymously pullable by exact digest.

Only the update supervisor receives `/var/run/docker.sock`; that access is
effectively root-equivalent on the host. Keep the reviewed supervisor image, private
control socket, `.env`, updater state, and backup volumes inside the trusted host
boundary. The ordinary backend receives only the bounded Unix control socket, and
the Web container/browser receive no host authority.

After bootstrap, always use `./scripts/agentic-soc-compose.sh` for manual lifecycle
commands. It layers `.agentic-soc-runtime/active-release.compose.yml`; a raw Compose
invocation can bypass the selected digest pins and is unsupported.

The wrapper also shares an advisory lifecycle lock with the supervisor. Read-only
inspection remains available during an update, but mutating and unknown Compose
commands are refused until the durable update is terminal. Target digest pins remain
private through updater handoff, backend-writer quiescence, and verified backup; the
host-visible active override is published only at the deployment switch boundary.
After a restart, only a marker naming an exact durable terminal job is reconciled
automatically. Unknown or malformed lifecycle state remains fail-closed.

The updater never transports or replaces the base Compose file. The 0.1.x update
protocol pins its version-invariant bytes in `deploy/update-base-v1.sha256`; release
images and versions live only in the signed generated override. Compatible patch
releases must preserve that exact base, which permits sequential N→N+1→N+2 updates.
Any topology/base edit requires an explicitly versioned updater protocol and manual
bootstrap rather than silently stranding an installed host.

Automatic in-flight failure, cancellation, and deliberate post-success rollback all
restore application images only; none rewrites PostgreSQL. The verified quiesced dump
is retained solely for explicit break-glass recovery so rollback cannot erase a
post-snapshot write. V1 therefore accepts only `migration.strategy=none` plans.

Durable job state survives browser/backend reconnects and ordinary supervisor-process
restarts. Updater self-replacement uses a restartable helper with an idempotent
name-swap transaction: after an ordinary helper-process, Docker-daemon, or host restart,
it resumes replacement or restores the exact prior supervisor from immutable image
identity. A failure that prevents Docker and all of its containers from running, or
destroys Docker metadata/storage, remains an operator-owned host recovery event.

The safe development/Compose defaults use `unknown` provenance. Those deployments
remain usable but intentionally never expose browser activation; release automation
must stamp the Web and backend images with the same immutable SHA and build time.

Serve `/release.json` and `/index.html` with `no-store, no-cache, must-revalidate`;
hashed assets may remain immutable. The supervised flow replaces the single
reference Web container only after backend verification, so an open tab can briefly
lose an old lazy-loaded chunk while the service restarts. Save or discard drafts
before updating; custom zero-downtime or blue-green asset retention remains an
operator-owned deployment concern outside the supported single-replica profile.

**Resource notes.** The backend image is small (pure-Python on
`python:3.11-slim`). Postgres+pgvector and Redis are modest. The heaviest cost is
LLM API usage — watch the in-app **Cost** panel (`GET /api/usage/summary`) and the
per-case caps (`caps.max_tokens`, `caps.max_tool_calls`, `caps.timeout_seconds`,
and the `kill_switch`). LLM investigations can run for a while; the web-UI nginx
proxy is configured with 300s read/send timeouts for that reason.

---

## 7. Mode B — Existing ELK attachment (optional)

Use this only if you already operate a compatible Elasticsearch stack and want
the suite's state in dedicated Elasticsearch indices. The supported interface is
still the standalone web UI; add/run its service separately from the legacy merge
block.

### 7.1 Add the backend to the existing stack

Clone this repo next to your stack's `docker-compose.yml` so the build context
resolves (the merge block expects `./agentic-kibana/backend`), then **copy the
`tlsoc-backend` and optional `tlsoc-redis` entries from
`deploy/docker-compose.tlsoc.yml` into the `services:` map of your existing
`docker-compose.yml`** — do not modify any existing service. The block:

- joins the existing default network and reaches `https://elasticsearch:9200` by
  container name,
- mounts the existing CA read-only (`./certs/ca/ca.crt:/certs/ca.crt:ro`),
- reads its **secrets** from `TLSOC_*` env vars (mapped to `ES_API_KEY`,
  `ES_MGMT_API_KEY`, `ANTHROPIC_API_KEY`, …). The ES **connection** fields
  (`ES_URL=https://elasticsearch:9200`, `ES_CA_CERT=/certs/ca.crt`,
  `ES_VERIFY_CERTS=true`) are **hard-coded literals in the shipped merge block**, not
  `.env`-driven — they assume a container named `elasticsearch` and a CA mounted at
  that exact path. If your topology differs, edit those three lines directly in the
  block rather than looking for a `TLSOC_*` override.

### 7.2 Two scoped Elasticsearch API keys (NEVER the superuser)

Mode B uses the `elasticsearch` state backend, which needs **two** least-privilege
keys (this is non-negotiable #1 — never `kibana_system` or the `elastic`
superuser). Mint them once with the superuser, then never use it again. The role
descriptors are documented in `.env.example`:

**Read-only key** → `TLSOC_ES_API_KEY` (`ES_API_KEY`): scoped to your log indices.

```json
{ "tlsoc_agent_readonly": {
    "indices": [ { "names": ["all-logs-*"], "privileges": ["read","view_index_metadata"] } ] } }
```

**Management key** → `TLSOC_ES_MGMT_API_KEY` (`ES_MGMT_API_KEY`): scoped to the
suite's own indices only. The cluster privileges are required only for the explicit
own-state lifecycle capability probe/apply; they do not grant access to upstream log
indices.

```json
{ "tlsoc_agent_mgmt": {
    "cluster": ["manage_ilm", "manage_index_templates", "monitor"],
    "indices": [ { "names": ["tlsoc-agent-*"],
      "privileges": ["read","write","create_index","view_index_metadata","manage"] } ] } }
```

Mint via Kibana → **Stack Management → Security → API keys → Create API key →
Restrict privileges**, or via the `_security/api_key` API. Put the `encoded`
values into `.env`. Then bring up the backend:

```bash
docker compose up -d --build tlsoc-backend tlsoc-redis
docker exec tlsoc-backend curl -fsS http://localhost:8088/api/health ; echo
```

### 7.3 Capability-aware own-state lifecycle

After deployment, open **Settings → Organization → Storage & retention**. The
desired default is:

- Hot: the first 180 days;
- Warm: the next 90 days, until day 270;
- desired archive: AWS S3 Glacier Flexible Retrieval from day 270; and
- deletion: always off.

Saving that preference does not move data. **Preview** first, then use the explicit,
freshly authenticated **Apply supported lifecycle** action. For Mode B, the backend
installs Elasticsearch ILM only for append-only `tlsoc-agent-audit-*` and
`tlsoc-agent-usage-*`; the probe requires cluster `manage_ilm` +
`manage_index_templates` + `monitor` and
usable Hot/Warm roles. ILM rollover is bounded independently (30 days or 50 GiB),
and phase age is measured from rollover, so the exact backing-index wall-clock
transition can occur after the displayed desired boundary.

Mutable cases and configuration/cursor/user/session/collaboration metadata stay Hot.
Mode A PostgreSQL reports the desired policy as advisory until timestamp partitioning
and an operator-managed scheduler/tablespace/archive workflow exist. SQLite reports
export-only. Connected source indices and buckets are always external/read-only.

The 0.1.13 Apply operation does not configure Glacier and never adds an ILM delete
phase. To archive safely, write a separate immutable export, manifest and checksums,
verify restore, then apply S3 lifecycle to that **independent archive prefix**. Never
transition the Elasticsearch snapshot-repository prefix itself.

### 7.4 Unsupported archived-plugin revival

The plugin is **archived** (`archive/kibana-plugin/`) and is no longer built,
tested, version-stamped, or shipped as a supported 0.1 surface. Existing committed
zips are historical artifacts, not release deliverables. A site that elects to
revive one owns compatibility and verification; never compile on a production
server. The old matching artifacts were:

| Running Kibana | Install this committed zip |
|---|---|
| 8.12.2 | `archive/kibana-plugin/dist/tlsocAgenticTriage-8.12.2.zip` |
| 8.19.12 | `archive/kibana-plugin/dist/tlsocAgenticTriage-8.19.12.zip` |

```bash
docker cp archive/kibana-plugin/dist/tlsocAgenticTriage-8.19.12.zip kibana:/tmp/
docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.19.12.zip
docker restart kibana
```

The archived plugin talks to the backend through a Kibana server-side proxy and defaults to
`http://tlsoc-backend:8088` (resolves on the shared Docker network because the
container is named `tlsoc-backend`). Override with `tlsocAgenticTriage.backendUrl`
in `kibana.yml` if needed. Then open the archived **Agentic SOC** app in Kibana
and complete the same wizard described in §3.4. This does not make the revived
plugin part of the supported release.

> The Kibana plugin folder is ephemeral; a `compose down/up` or image pull removes
> it — just re-run the install + restart. (See `archive/kibana-plugin/BUILD.md`
> for reviving + building the zip in a separate session; never run
> `yarn kbn bootstrap` on a production server.)

---

## 8. Production hardening

- **TLS / reverse proxy in front of the UI.** The web UI serves plain HTTP on
  `:8080` (nginx). In production, place it behind a TLS terminator / reverse proxy
  (e.g. nginx, Caddy, Traefik). The suite now ships **built-in API auth + RBAC +
  MFA + SSO** (default OFF — enable per §9); enable it (and set
  `TLSOC_AUTH_COOKIE_SECURE=true` behind TLS), and/or add proxy-level auth in
  front. A site that revives the unsupported archived Kibana plugin must assess
  and own that plugin's separate session/proxy boundary; it is not part of the
  supported production posture.
- **Restrict the `:8088` backend port.** The compose files publish `8088:8088`
  for direct API access / debugging. In production, remove that mapping (the UI
  reaches the backend over the internal Docker network at
  `http://tlsoc-backend:8088`) or firewall it to trusted hosts only.
- **Network policy for push receivers.** Only publish the listener ports you
  actually use (e.g. syslog `1514`), and firewall them to your forwarders.
  Require auth on HTTP push (`POST /api/ingest/{id}` with a per-source bearer/HMAC
  secret) and prefer TLS in front of it.
- **Least-privilege source keys.** A pull source's key must be **read-only** and
  scoped to the log indices it needs — never a superuser, never write-capable.
  In Mode B keep the read-only ↔ management key split intact.
- **Secrets stay in `.env` / the secret tier**; never commit a real `.env`, never
  expose secret values through the UI.
- For the full threat model and posture, see **`SECURITY.md`**.

---

## 9. Authentication, RBAC, MFA & SSO

API auth ships **disabled by default** — the no-auth deployment (network /
reverse-proxy as the trust boundary) is fully supported and unchanged out of the
box. Enable it per-deploy to get a **login screen, persisted multi-user accounts,
6-role RBAC, MFA (TOTP), and SSO (OIDC)**. See `SECURITY.md` for the full posture.

> All knobs below use the `.env` `TLSOC_*` names. The **agnostic compose maps
> them** onto the backend's unprefixed names (`AUTH_ENABLED`, `AUTH_JWT_SECRET`,
> `MFA_OBFUSCATION_KEY`, `SSO_CLIENT_SECRETS`, …). A **direct uvicorn** run reads
> the **unprefixed** names directly (see `DEMO.md` Option B).

### 9.1 Enable auth + RBAC

In `.env`:

```bash
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=$(openssl rand -hex 32)   # STABLE — else sessions die on restart
TLSOC_AUTH_COOKIE_SECURE=true                    # REQUIRED behind TLS
```

Then `./scripts/agentic-soc-compose.sh up -d` to apply.

- **First-run seed.** When auth is enabled **and the user store is empty**, the
  backend auto-seeds a demo **super_admin**: **`Admin` / `Admin@123`**. **Change it
  immediately** — create real users and delete/disable the seed (the suite blocks
  removing the *last* super_admin to avoid lockout). The seed is controlled by
  backend `Secrets` fields (`auth_seed_admin` / `auth_seed_admin_username` /
  `auth_seed_admin_password`), but **neither compose file nor `.env.example` maps
  them today** — to disable seeding or change the seeded username/password, add the
  corresponding `AUTH_SEED_ADMIN*` line(s) directly to the `tlsoc-backend`
  `environment:` block yourself.
- **6 roles:** `super_admin` · `soc_manager` · `analyst_tier2` · `analyst_tier1` ·
  `responder` · `auditor`. Enforced **server-side** (every `/api` route is gated by
  `require_permission`, deny-by-default + a CI coverage test) **and** in the UI
  (`<Can>` guards). When auth is OFF, every user is treated as `super_admin`.
- **Env fallback admin** (optional, separate from the seed):
  `TLSOC_AUTH_ADMIN_USERNAME` + `TLSOC_AUTH_ADMIN_PASSWORD` (plaintext, hashed in
  memory at startup, never stored; granted super_admin), or a boot-time map
  `TLSOC_AUTH_USERS={"alice":"pbkdf2_sha256$..."}`.
- Manage users/roles in **Settings → Users / Access** after logging in.

### 9.2 MFA (TOTP)

Per-user, opt-in **RFC-6238 TOTP** — enrolled from the UI (**Settings → Security →
My MFA**), with an **inline-SVG QR code** (no external calls) and **single-use
recovery codes**. Login becomes two-phase (password → 6-digit code).

```bash
# Optional: key used to obfuscate the per-user TOTP secret at rest.
# Blank -> derived from TLSOC_AUTH_JWT_SECRET.
TLSOC_MFA_OBFUSCATION_KEY=$(openssl rand -hex 32)
```

> This is stdlib **obfuscation, not a KMS** — a documented hardening TODO (see
> `SECURITY.md`). Treat the obfuscation key (or the JWT secret it derives from) as
> sensitive.

### 9.3 Session & token policy (revocation, idle / absolute lifetime, step-up)

With auth enabled, the stdlib HS256 JWT is the short-lived **access token**; every
login also registers a **session** (a `sid` + per-user `token_version` claim) in a
backend-agnostic `SessionStore` (persisted in the state backend, so sessions survive
a backend restart **as long as `TLSOC_AUTH_JWT_SECRET` is stable**). This is what
makes a session **revocable** — a valid-looking JWT is rejected once its `sid` is
revoked or the user's `token_version` is bumped. See `SECURITY.md` for the model.

The lifetimes are a UI-editable tuning block (**Settings → Organization → Security &
SSO → token policy**), also settable on Preferences. Defaults are **deliberately
generous** so an existing auth-on deployment never expires mid-session:

| Knob (Preferences `session_policy.*`) | Default | Meaning |
|---|---|---|
| `access_ttl` | `3600` (1h) | Access-token lifetime; a refresh rotates within this window. |
| `idle_timeout` | `43200` (12h) | Reject a session idle longer than this (`now > last_active + idle_timeout`). |
| `absolute_lifetime` | `2592000` (30d) | Reject a session older than this regardless of activity. |
| `refresh_ttl` | `2592000` (30d) | Refresh-token lifetime. |
| `sudo_reauth_window` | `600` (10m) | How recently the user must have re-authenticated for a step-up-gated action (`require_fresh_auth`). |
| `notify_on_new_device` / `notify_on_terminate` | `false` | Best-effort operator notification on a first-seen device / a termination. |

These are tuned in the UI, not `.env` (they carry no secret). Endpoints:
`POST /api/auth/refresh` (rotate + **reuse detection** — see `SECURITY.md`),
`POST /api/auth/reauth` (step-up), `GET /api/sessions` + `POST
/api/sessions/{sid}/revoke` + `POST /api/sessions/revoke-others` (own devices), and
the admin console `GET /api/admin/sessions` + `POST /api/admin/sessions/{sid}/revoke`
+ `POST /api/admin/users/{username}/revoke-all`. Users manage their own signed-in
devices in **Settings → Account → Security / Sessions**.

> **Keep `TLSOC_AUTH_JWT_SECRET` stable.** It signs the access token AND is the
> default derivation source for the MFA obfuscation key. If it is unset/ephemeral,
> every restart invalidates all tokens (the persisted session rows still load, but
> their JWTs no longer verify).

### 9.4 SSO (OIDC — Google / Microsoft / generic)

Configure providers in **Settings → Security → SSO** (issuer, client id, the
group→role mapping). The **client secret** stays in the SECRET tier — set it via
`.env` or at runtime:

```bash
# .env (JSON map of provider id -> client secret):
TLSOC_SSO_CLIENT_SECRETS={"google":"GOCSPX-...","corp":"..."}
# …or push at runtime (super_admin):
#   POST /api/auth/sso/providers/{id}/secret
```

The suite uses **server-side code exchange + userinfo** (no `id_token`
signature-verify dependency — a documented hardening TODO in `SECURITY.md`).
Group→role provisioning maps IdP groups onto the 6 roles.

**Register this redirect / callback URI with your IdP** (the suite derives it from
the request's base URL):

```
<your-base-url>/api/auth/sso/callback
# e.g. local demo:   http://localhost:5173/api/auth/sso/callback
#      docker stack:  http://localhost:8080/api/auth/sso/callback
#      production:    https://soc.example.com/api/auth/sso/callback
```

- **Google** — Google Cloud Console → APIs & Services → **Credentials** → *Create
  OAuth client ID* → *Web application* → add the callback above under **Authorized
  redirect URIs**. Copy the client id (→ Settings) + client secret (→
  `TLSOC_SSO_CLIENT_SECRETS["google"]`).
- **Microsoft (Entra ID)** — Azure Portal → **App registrations** → *New
  registration* → add the callback above as a **Web** *Redirect URI*. Copy the
  Application (client) ID + tenant/issuer (→ Settings) and a **client secret** from
  *Certificates & secrets* (→ `TLSOC_SSO_CLIENT_SECRETS["<provider-id>"]`).
- **Generic OIDC** — point the issuer at the provider's discovery document and
  register the same callback.

---

## 10. Notifications (email / Slack / Teams / webhook / PagerDuty / Telegram)

Notifications are **default OFF** and configured per-channel in **Settings →
Notifications**. Channels fire **fire-and-forget after** a case is saved, with
**per-condition triggers** and **dedup / rate-limit / digest** controls.

- **Email (SMTP)** is stdlib SMTP with provider presets (Gmail/Workspace,
  Microsoft 365/Outlook, **SES**, SendGrid, Mailgun, Postmark, …). Pick a preset, set
  the from/to addresses, and put the **SMTP password** in the SECRET tier.
- **Amazon SES** — pick the `ses` preset and set `config.region` (host is
  `email-smtp.{region}.amazonaws.com:587`, STARTTLS). Supply **either** a pre-made
  SES SMTP username (secret = the SMTP password) **or** `config.aws_access_key_id`
  as the username with the IAM **secret** access key as the channel secret — the
  suite derives the SES SMTP password from the IAM key via a stdlib HMAC ladder (no
  boto3, no console step).
- **Email (Resend)** is a separate channel `type: resend` over Resend's HTTPS API
  (`POST https://api.resend.com/emails`). The channel secret is the **Resend API
  key** (`Authorization: Bearer`); a deterministic `Idempotency-Key`
  (`case-notify/{case_id}/{trigger}`) de-dupes retries. Set the from/to addresses in
  config and the API key in the SECRET tier. (Resend retries only on 429/5xx, never
  on a 4xx config/quota error.)
- **Slack / Teams / webhook** use an incoming-webhook URL; **PagerDuty** uses a
  routing/integration key; **Telegram** a bot token + chat id.

**Email templates.** The 5 built-in templates (`case.new`, `case.escalation`,
`case.resolved`, `digest.daily`, `test`) are operator-overridable (**Settings →
Notifications → template editor**). They render through a tiny stdlib
mustache-subset engine with **mandatory HTML-escaping** of every interpolated
variable and **header-injection-safe** Subject/headers — see `SECURITY.md`.
Preview a rendered template server-side (escaping is authoritative) with
`POST /api/notifications/preview?trigger=<trigger>` before wiring it.

> **Verify the sending domain first.** For both SES and Resend, the From domain must
> be DNS-verified at the provider (SPF/DKIM, and DMARC if you enforce it) before
> mail will deliver. New SES accounts are also **sandboxed** (recipients must be
> verified, low send quota) until you request production access. Use the channel's
> **Send test** to confirm the domain is live before enabling triggers.

The channel **secret** (SMTP password / webhook URL / API token) lives in the
SECRET tier — never the config store. Set it via the UI, or:

```bash
# Runtime (the connector-secret pattern):
POST /api/notifications/channels/{id}/secret      # body: {"secret": "..."}

# …or seed at boot via .env (JSON map of channel id -> {field: value}):
TLSOC_NOTIFICATION_SECRETS={"email-ops":{"secret":"<smtp-password>"},"slack-soc":{"secret":"https://hooks.slack.com/services/..."}}
```

Use the channel's **Send test** button to verify delivery before wiring triggers.

---

## 11. Demo quick start

For a presenter-ready, copy-pasteable walkthrough that brings the suite up
**locally with auth enabled** and tours every headline feature, see
**[`DEMO.md`](DEMO.md)**. The fast path, from the repo root:

```bash
./scripts/run-demo.sh        # loopback-only backend :8088 + web UI :5173 (auth on)
# then open http://127.0.0.1:5173 and log in as  Admin / Admin@123
```

### 11.1 In-app Demo Mode (synthetic data, reversible, isolated)

Separate from the local demo *script* above, any running deployment has an in-app
**Demo Mode** — a reversible tenant state (`off` | `seeded` | `live`) that fills the
console with realistic synthetic cases, four protocol-compatible sources
(Splunk HEC, QRadar LEEF/offenses, Wazuh JSON, and RFC syslog), a benign baseline,
and cross-source MITRE ATT&CK storylines so you can show every surface without
touching a real source. It is
gated by dedicated permissions (`demo:read` for status; **`demo:manage`** for
enable / incident / reset / disable). The default `super_admin` and `soc_manager`
roles can manage it, and custom roles may be granted the capability. Demo-generated
work is isolated: synthetic events flow through the real pipeline, but all generated
workload writes land in a **separate throwaway in-memory store** under a `run_id`.
The LLM is a deterministic `$0` mock (cost tiles show "(simulated)"), and
a write-guard prevents demo data from ever reaching the real workload stores. A
configured provider key is never called while Demo Mode is active. Enable /
generate incident / reset / disable it from **Settings → Organization → Experimental
& Demo** or via `POST /api/demo/enable`,
`POST /api/demo/incident` (one cooldown-aware four-source storyline),
`POST /api/demo/reset`, `POST /api/demo/disable` (hard-deletes all demo data by
`run_id`), `GET /api/demo/status`. The real durable polling cursor (#4) is untouched
throughout, and disabling Demo Mode is a single reversible flip. The local
`./scripts/run-demo.sh` command enables `live` mode by default; set
`DEMO_MODE=seeded` for a static walkthrough. See `SECURITY.md`
for the isolation guarantees.

In live mode, `incident_rate` is a probability from 0 to 1 evaluated **once per
`alert_interval_seconds`**; it is not a per-event or per-tick rate. The guaranteed
first storyline and manual incident endpoint are independent of that roll. Demo
lifecycle actions intentionally persist in the real append-only audit trail (visible
through the Audit page after exit). The Sources UI disables real connector controls
and outbound notification tests are refused, but other organization/admin settings
remain live and should not be edited during a presentation unless the change is
intentional.

---

## 12. Troubleshooting

For runtime / usage / deploy failures (health checks, `es_connected:false`,
no cases after polling, connector errors, plugin install issues), see
**`docs/TROUBLESHOOTING.md`**.
