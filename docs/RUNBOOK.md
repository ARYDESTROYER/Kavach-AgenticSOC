# RUNBOOK.md — Day-2 operations

Operating **Agentic SOC** after it is deployed. This is the
day-2 companion to [`DEPLOY.md`](../DEPLOY.md) (cold deploy),
[`docs/USAGE.md`](USAGE.md) (how to use the surfaces),
[`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) (symptom → fix playbook), and
[`SECURITY.md`](../SECURITY.md) (posture).

The suite is **vendor-agnostic**. It owns its **own state** in one of three
backends (`STATE_BACKEND`): `elasticsearch` (default), `postgres`, or `sqlite`. It
reads alerts from any number of configured **sources** (pull + push). Many ops
below are therefore **backend-conditional** — the section flags which.

> The suite is a **read-only consumer** of every log source. None of the
> operations here write to a source; they touch only the suite's own state store
> and the running backend.

## 1. Health checks & monitoring

### 1.1 Backend health

```bash
# Direct (the agnostic stack publishes :8088; or exec into the container)
curl -s localhost:8088/api/health ; echo
#   -> {"status":"ok","version":"0.1.13","es_connected":...,"store_type":"...","setup_complete":true}

# THROUGH the web UI's nginx (proves the SPA → backend path end-to-end)
curl -fsS http://localhost:8080/api/health ; echo
```

Watch these fields (`api/routes.py:health`):

| Field | Healthy | If wrong |
|---|---|---|
| `es_connected` | `true` **iff** a pull log source (Elasticsearch/OpenSearch/Wazuh) is reachable | With `postgres`/`sqlite` state and no ES/OpenSearch/Wazuh pull source at all, `false` is **expected and benign** — it says nothing about your own-state store. |
| `store_type` | `RealESClient` **when `STATE_BACKEND=elasticsearch` and it's reachable** | This field is **not** the state-backend name — it is always `type(state.es).__name__`, the class of the **log-surface ES client** (`RealESClient`/`InMemoryESClient`), built from whether an ES key is configured. It **never** reports `STATE_BACKEND`. On `postgres`/`sqlite` with no ES pull source, `InMemoryESClient` here is **expected/benign, not a Postgres/SQLite outage**. It only signals a durability problem when `STATE_BACKEND=elasticsearch` and it unexpectedly reads `InMemoryESClient` (the ES connection failed). |
| `setup_complete` | `true` | Wizard not finished; polling/receivers have not started. |
| `version` | matches the deployed release | Stale container. |

### 1.2 Watch spend & degradation

Every LLM call writes a usage row (`cost`, `total_tokens`, `latency_ms`, `role`,
`model`, `outcome` ∈ `ok`/`error`/`capped`). Read it via the API regardless of
state backend:

```bash
curl -s "localhost:8088/api/usage/summary?window_hours=24"
```

- Rising **`error`** outcome = a **degraded LLM or enrichment** provider (the
  gateway records the failure then fails safe; embeddings fall back to local
  hashing). Cross-check provider egress.
- Rising **spend** = investigate the cost driver (model mix, volume) → §4 / §5.

> On the **ES** state backend the same data is in `tlsoc-agent-usage-*` and the
> bundled **Cost & Tokens** dashboard; on **Postgres/SQLite** it lives in the
> usage table — use `GET /api/usage/summary` (and the Cost surface) as the
> backend-neutral view.

## 2. State-backend operations

The chosen `STATE_BACKEND` decides where cases/audit/usage/config/cursor/RAG live.
Switching backends does **not** migrate data — pick one and operate it.

### 2.1 Postgres (`STATE_BACKEND=postgres`)

Own-state in PostgreSQL + pgvector. In the agnostic stack the volume is
`tlsoc-pgdata` on the `tlsoc-postgres` service.

The Compose project slug `tlsoc-agentic-soc` is retained as a compatibility-stable
machine identifier, so the effective volume name remains
`tlsoc-agentic-soc_tlsoc-pgdata`. Renaming the project requires an explicit volume
migration; changing display nomenclature does not rename stored state.

```bash
# Backup
docker exec tlsoc-postgres pg_dump -U tlsoc -d tlsoc -Fc > tlsoc-$(date +%F).dump

# Restore (into a fresh, empty db)
docker exec -i tlsoc-postgres pg_restore -U tlsoc -d tlsoc --clean --if-exists < tlsoc-YYYY-MM-DD.dump

# Volume-level backup (cold): stop the backend first to quiesce writes
./scripts/agentic-soc-compose.sh stop tlsoc-backend
docker run --rm -v tlsoc-agentic-soc_tlsoc-pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/tlsoc-pgdata-$(date +%F).tgz -C /data .
```

- `STATE_DB_URL` must be the async URL
  `postgresql+asyncpg://user:pass@host:5432/tlsoc`.
- pgvector is **best-effort**: if `CREATE EXTENSION vector` fails the suite logs a
  warning and uses JSON+Python cosine for RAG (functional, slower). Use the
  `pgvector/pgvector:pg16` image to get native kNN.
- Schema is created idempotently on startup (`SQL state schema ensured`).

### 2.2 SQLite (`STATE_BACKEND=sqlite`)

Own-state in a single file (default `./tlsoc.db`, overridable via
`STATE_DB_URL=sqlite+aiosqlite:///<path>`). Zero services — good for a single-node
demo. **Back it up by copying the file** (quiesce the backend first); keep it on a
**persistent volume** or it is lost on container recreate.

### 2.3 Elasticsearch (`STATE_BACKEND=elasticsearch`, default)

Own-state in five `tlsoc-agent-*` indices, created on first boot with the
management key:

| Index pattern | Type | Growth |
|---|---|---|
| `tlsoc-agent-cases-*` | time-suffixed, write alias | per investigated cluster |
| `tlsoc-agent-audit-*` | time-suffixed, write alias | **highest** (every action) |
| `tlsoc-agent-usage-*` | time-suffixed, write alias | high (every LLM call) |
| `tlsoc-agent-config` | single-doc (`preferences`) | constant |
| `tlsoc-agent-cursor` | single-doc (`primary`) | constant |

- Use **Settings → Organization → Storage & retention** to preview and explicitly
  apply the owned-state ILM policy. In 0.1.13 it applies only to the append-only audit
  and usage aliases; mutable cases and live metadata remain Hot. The desired default
  is 180 days Hot + 90 days Warm, with deletion always off. Do not attach a blanket
  ILM policy to every `tlsoc-agent-*` alias.
- **ES snapshots** for backup:
  ```
  PUT /_snapshot/<repo>/tlsoc-<date>?wait_for_completion=true
  { "indices": "tlsoc-agent-*", "include_global_state": false }
  ```
  The two single-doc indices (`config`, `cursor`) are small but **operationally
  critical** — `config` holds tuned preferences, `cursor` the durable poll
  position. Restoring `cursor` avoids a cold-start re-scan.

### 2.4 Switching backends

Stop the backend, set the new `STATE_BACKEND` (+ `STATE_DB_URL` for SQL), redeploy.
Data does **not** carry over — export from the old store (pg_dump / ES snapshot /
copy the SQLite file) and, if you need history in the new store, re-ingest. The
agent's read-only **log source** access is unaffected by this choice.

## 3. Source & receiver lifecycle

### 3.1 Pull sources

Polled by the single in-process poller (`engine/poller_manager.py`) on
`poll_interval_seconds` (and on a manual `POST /api/poll`). It fans out over
**every enabled pull source**, each with its own durable cursor keyed
`{source.id}:{feed.id}` (a single-source deployment keeps the legacy
`{source.id}:primary` key), so a fast alert feed and a slow event feed never skip
or dup each other, and a per-cluster-signature in-flight lock keeps two concurrent
sources from double-casing the same signature. Pause/resume by setting
`polling_enabled` (Settings); re-enabling it (with `setup_complete` true and kill
switch off) restarts the poller.

### 3.2 Push receivers

- **Background receivers** (syslog / Kafka / SQS / Kinesis / Event Hub / Pub/Sub /
  RabbitMQ / NATS / MQTT / Redis Streams / S3 / GCS / Azure Blob / file) **start on
  app startup** and on source save (`state._start_receivers`), and `emit` batches
  into the shared ingest path. A receiver that can't start (missing optional dep,
  bad config) is logged and skipped — it never breaks startup. Restart the backend
  to re-attempt after fixing the cause.
- **Webhook / HEC are route-driven** — they have no background task; a source POSTs
  to `POST /api/ingest/{source_id}`, the route verifies auth + normalises + feeds
  the pipeline. Nothing to start/stop.
- **Socket receivers (syslog) need their port published** in your compose file
  (the agnostic compose leaves push ports commented — add e.g. `- "1514:1514/udp"`
  and recreate the backend).

Manage sources at runtime via the **Sources** screen or the API
(`GET/POST/DELETE /api/sources`, `POST /api/sources/{id}/secrets`).

## 4. Routine operations

### 4.1 Rotating keys

| Key | Durable path (recommended) | Runtime path (ephemeral) |
|---|---|---|
| LLM keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) | Edit `.env` → recreate the backend | Wizard / `POST /api/setup/secrets` → **in-memory only, lost on restart** |
| Enrichment / embedding keys | Edit `.env` → recreate | Wizard / `POST /api/setup/secrets` → in-memory only |
| **Per-source** credentials (read-only source key, webhook token, HMAC secret, cloud creds) | Bake into source config env or re-set after restart | `POST /api/sources/{id}/secrets` → **secret tier, in-memory only, never persisted** |
| State-backend creds (`STATE_DB_URL` / ES mgmt key) | Edit `.env` → recreate | n/a |

Per-source secrets live in the **secret tier** and are **never written to the
state store** — only the configured field *names* are persisted on the source.
After a backend restart, re-set any wizard-pushed secret, or supply it via env.

Rotation procedure (zero source-write impact):
1. Mint the new credential, least-privilege (read-only for log sources).
2. Update `.env` (durable) **or** re-set via the wizard / `POST /api/sources/{id}/secrets`.
3. Recreate the backend container so the gateway/clients pick up the values.
4. Verify health + a test call, then revoke the old credential at the source.

### 4.2 Kill switch (emergency stop)

Set `caps.kill_switch=true` (Settings, or PUT). All investigations stop and polling
is not (re)started while it is set. Clear it (`false`) to resume.

```bash
curl -s -X PUT localhost:8088/api/settings \
  -H 'content-type: application/json' -d '{"caps":{"kill_switch":true}}'
```

### 4.3 Cost budget & caps

Each investigation is bounded by `caps.max_tool_calls` (8), `caps.max_tokens`
(20000), `caps.timeout_seconds` (120). Tighten these and switch a role to a cheaper
model (Settings → per-role models) to cap spend. The cost gate also keeps cheap/
benign clusters away from the strong investigator.

### 4.4 Tuning correlation / thresholds

All UI-editable (round-trip via `GET`/`PUT /api/settings`):
`severity_threshold`, `in_scope_rules`/`excluded_rules`, `default_correlation` +
per-rule `correlation_rules`, `risk_weights`, `asset_criticality`,
`asset_networks`, `escalation_confidence`, `auto_close.{false_positive,true_positive}`
(the live auto-close policy knob — `fp_auto_close` is deprecated and auto-migrated
into it), caps.

### 4.5 Repairing precedent whose stored text drifted

The precedent corpus (`resolved_case`) stores a rendered snippet per case. When the
renderer changes, chunks written by the older one keep serving their old wording — and
nothing surfaces it: the composition report compares metadata tallies, the collapse
guard is a size guard, and the per-rule distribution reads metadata with the text
discarded. No metadata key records which generation produced a chunk, so the only way
to detect drift is to render each case again and compare.

**1. Look, for free.** The dry run is the default: it embeds nothing, writes nothing
and deletes nothing.

```bash
curl -s -X POST localhost:8088/api/rag/precedent/repair \
  -H 'content-type: application/json' -d '{}' | jq '{complete, scanned, tiers}'
```

Read the per-tier counts (`analyst_confirmed` and `model_unconfirmed`):

| count | means |
|---|---|
| `current` | the stored text is exactly what the projector renders today. Nothing to do. |
| `stale` | the re-render differs. `would_repair` of these fit in this run's cap. |
| `undetermined` | the backing case could not be read, or the chunk has no case id / no durable chunk id. Never touched. |
| `not_projecting` | broken out as `excluded` / `withdrawn` / `absent`. Only `absent` is removable. |
| `complete` | `false` means this run could not cover everything — a truncated backend read, an undetermined chunk, or candidates past the cap. A `false` here is never "0 stale remain". |

`GET /api/diagnostics` publishes the same per-tier counts as
`precedent_corpus.stale_text_chunks` if you would rather watch it than poll the repair.

**2. Then repair.** Same route, `dry_run: false`, `rag:manage`, audited.

```bash
curl -s -X POST localhost:8088/api/rag/precedent/repair \
  -H 'content-type: application/json' -d '{"dry_run": false}' | jq '{repaired, evicted, remaining, complete}'
```

Each repaired chunk costs exactly one embedding, through the single gateway and the
cost ledger. A byte-identical re-render costs nothing. Embeddings are metered but are
not pre-flight budget-gated, so the run carries its own bound — four times the
configured precedent window — and reports `remaining` when it hits it. **Re-run until
`remaining` is 0**; the pass is resumable and each run re-classifies from scratch.

**3. Refusals are answers, not errors.** A refusal reports `refused: true` with a
`reason_code` and changes nothing:

| `reason_code` | what to do |
|---|---|
| `repair_embedding_space_changed` | the embedding model changed; let the ordinary reseed run — it re-derives every chunk from the current builder anyway. |
| `repair_embedding_degraded` | the embedding provider is degraded. Fix it first; hash-space vectors must never become durable. |
| `repair_mass_eviction` / `repair_tier_emptied` | the case store says most (or all) of a tier's cases are gone. Treat that as a case-store problem, not corpus drift. Tier-emptying is refused unconditionally and cannot be configured away. |
| `repair_exclusion_set_unknown` | the precedent exclusion set could not be read and this process has never held it. Restore the state backend first. |

**4. Know what is and is not reversible.** A repair is **idempotent and re-derivable**
— running it again renders the same text from the same case — but it is **not
reversible to the prior render**. The store upserts, and the prior render is by
definition the stale one nobody wants back. For the **delete** path only, the evicted
document id, text and metadata are written to the append-only audit trail *before* the
removal, and **that record is the only reconstruction path**; if it cannot be written,
the removal does not happen. Find it with
`GET /api/audit?surface=rag_precedent_repair` (rows carrying
`tool_name=precedent_evicted_chunk`).

Ground truth is never touched: no feedback row, no disposition, no `decision_by`, no
status, no history rewrite. To remove a precedent *deliberately*, use the exclusion API
(§ `POST /api/rag/precedent/exclusions`) — that is the supported path, and it is the
only one that holds across a reprojection.

## 5. Scaling notes

- **The poller is single, in-process.** **Do not run two backend replicas** — there
  is no distributed lock on the cursor, so two pollers would race it and risk
  skip/dup. Scale **vertically** for now; stateless horizontally-scaled workers
  (queue-fed) are a later phase.
- **The funnel keeps cost bounded.** Most volume is dropped or registered as
  zero-cost candidates; only correlated, uncertain/serious clusters reach the
  strong model. Tune correlation/scope before adding capacity.
- **Redis** backs enrichment dedup/cache; without it the backend degrades to an
  in-memory cache. Keep TTLs generous to protect free-tier enrichment limits.
- **Embeddings / vector store** flow through the gateway (local-hashing fallback)
  and persist in the state backend (pgvector kNN on Postgres, JSON cosine
  otherwise).

## 6. Incident response (for the tool itself)

| Symptom | First action | Then |
|---|---|---|
| **Runaway spend** | `caps.kill_switch=true` (§4.2). | Tighten caps, review `GET /api/usage/summary` by model/role, switch a role to a cheaper model, then clear the kill switch. |
| **Bad / suspect verdicts** | Verdicts are **advisory** — no auto-action on TRUE_POSITIVE. Re-investigate the case. | Check the agent **trace** (`GET /api/cases/{id}/trace`); tune `risk_weights`/`escalation_confidence`/suppression; reopen a wrongly auto-closed FP within its objection window. |
| **Cursor stuck / no new cases** | Confirm scope + `polling_enabled` + kill switch off; `POST /api/poll`. | On ES, inspect/restore the cursor doc; on SQL, the cursor row. See TROUBLESHOOTING "No cases appear". |
| **LLM/enrichment degraded** | Rising `outcome=error` in usage (§1.2). | Investigations fail safe to NEEDS_HUMAN (never dropped); restore provider egress / rotate keys (§4.1). |
| **State store unreachable** | Backend can't reach Postgres/ES/SQLite. | Check `STATE_DB_URL`/creds/cert; see TROUBLESHOOTING §A/§C. Data is not durable while degraded to in-memory. |
| **A receiver won't start** | `docker logs tlsoc-backend` for `Could not start receiver`. | Install the optional dep (TROUBLESHOOTING §F), publish the port (§G), fix config, restart. |

Cross-reference: [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for the full
symptom → cause → fix → confirm matrix.
