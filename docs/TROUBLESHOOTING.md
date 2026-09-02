# TROUBLESHOOTING.md — Agentic SOC

A consolidated symptom → likely cause → fix → confirm playbook spanning deploy,
runtime, and usage of the **vendor-agnostic** suite. Each entry tells you how to
**confirm** the fix.

- How everything is supposed to behave: `docs/USAGE.md`.
- Day-2 operations: `docs/RUNBOOK.md`.
- Security posture: `SECURITY.md`.
- Archived Kibana-plugin build deep dive: [`archive/kibana-plugin/BUILD.md`](../archive/kibana-plugin/BUILD.md).

Quick triage:

```bash
# Backend health (the agnostic stack publishes :8088; or exec into the container)
curl -s localhost:8088/api/health ; echo
#   -> {"status":"ok","version":"0.1.13","es_connected":...,"store_type":"...","setup_complete":...}

# Same health THROUGH the web UI's nginx proxy (proves the SPA → backend path)
curl -fsS http://localhost:8080/api/health ; echo

# Backend logs (errors, schema bootstrap, poll lines, receiver start)
docker logs tlsoc-backend --tail=100

# Web UI (nginx) logs
docker logs tlsoc-webui --tail=50
```

> **`store_type` is not the state backend — read it carefully.** It is always
> `type(state.es).__name__` (`RealESClient` or `InMemoryESClient`), the class of
> the **log-surface ES client**, built from whether an ES key is configured. It
> **never** names `STATE_BACKEND` (`elasticsearch`/`postgres`/`sqlite`) or any SQL
> store. With `STATE_BACKEND=postgres`/`sqlite` and **no ES/OpenSearch/Wazuh pull
> source wired**, `store_type:InMemoryESClient` is **expected and benign** — not a
> Postgres/SQLite outage; `es_connected` there reflects only whether that optional
> pull source is reachable. Push-only deployments may have no ES at all. `store_type`
> only signals a durability problem when `STATE_BACKEND=elasticsearch` (see §C).

---

## A. State backend won't come up

### A1. Postgres unreachable / wrong `STATE_DB_URL`

**Symptom.** Backend exits or logs `connection refused` / `could not translate
host name` / `password authentication failed`; `GET /api/health` never responds.

**Likely cause.** `STATE_BACKEND=postgres` but `STATE_DB_URL` points at the wrong
host/port/db, the password is wrong, or Postgres isn't up yet.

**Fix.**
- The URL must be a **SQLAlchemy async** URL:
  `postgresql+asyncpg://<user>:<pass>@<host>:5432/<db>` (the `+asyncpg` driver is
  mandatory — a bare `postgresql://` URL won't load the async driver).
- In the agnostic compose the host is the service name `tlsoc-postgres`; the
  password comes from `TLSOC_PG_PASSWORD` in `.env` (compose fails fast if unset).
- The backend `depends_on: tlsoc-postgres: condition: service_healthy`, so a slow
  Postgres delays — not breaks — startup; check `docker logs tlsoc-postgres`.

**How to confirm.** `docker exec tlsoc-postgres pg_isready` → `accepting
connections`; backend logs `Built async SQL engine` + `SQL state schema ensured` +
`OWN-state backend: SQL (postgres)`; `GET /api/health` returns
`{"status":"ok",...}` (note: `store_type` there is the unrelated log-surface ES
client — see the callout above; it does not confirm Postgres).

### A2. pgvector extension missing

**Symptom.** Backend logs `Could not ensure pgvector extension (...); RAG uses
JSON cosine`; RAG works but native kNN does not.

**Likely cause.** The Postgres image lacks the `vector` extension or the role
can't `CREATE EXTENSION`.

**Fix.** Use the **`pgvector/pgvector:pg16`** image (the agnostic compose already
does) or install the extension package and grant create privilege. The suite is
**fail-safe**: without pgvector it degrades to JSON + Python cosine, so this is a
performance/quality note, not an outage.

**How to confirm.** Backend logs `pgvector extension ensured`;
`docker exec tlsoc-postgres psql -U tlsoc -d tlsoc -c '\dx'` lists `vector`.

### A3. Chose the wrong `STATE_BACKEND`

**Symptom.** "Where did my cases go?" after a redeploy; data that was there is
gone, or the backend insists on ES it doesn't have.

**Likely cause.** `STATE_BACKEND` changed between runs. The three backends are
**separate stores** — switching does **not** migrate data.

- `elasticsearch` (default) — own-state in `tlsoc-agent-*` indices (needs the mgmt
  key; see C).
- `postgres` — own-state in Postgres + pgvector (`STATE_DB_URL` required).
- `sqlite` — own-state in a local file (`./tlsoc.db` by default; zero services).

**Fix.** Pick one and keep it. `postgres` **requires** `STATE_DB_URL` (the suite
never guesses production credentials — it raises
`state_backend='postgres' requires state_db_url`). `sqlite` is fine for a
single-node demo but the file must be on a persistent volume to survive restarts.

**How to confirm.** Backend logs show the state backend you intended (`OWN-state
backend: SQL (postgres|sqlite)`, or the ES-backend bootstrap in §C) — **not**
`GET /api/health`'s `store_type`, which never names `STATE_BACKEND` (see the
callout at the top of this file); the data you expect is listed by
`GET /api/cases`.

---

## B. Web UI build / serve issues

**Symptom.** `npm run build` fails; the SPA shows a blank page or 502s on `/api`.

**Likely cause / fix.**
- **Help Center build errors** — `npm run build` generates the version-matched
  MkDocs bundle before the SPA. Run `npm run docs:bundle` for the focused failure.
  The wrapper reuses `TLSOC_DOCS_PYTHON` when explicitly set, then a compatible
  `backend/.venv` or current Python; otherwise it creates and reuses the ignored
  root `.docs-venv` from `docs/requirements.txt`. If an explicit
  `TLSOC_DOCS_PYTHON` lacks MkDocs Material, unset it or point it at the compatible
  interpreter named in the error.
- **Type errors at build** — after the documentation bundle, `npm run build` runs
  `tsc --noEmit`. Run `npm run typecheck` to see the errors; fix and rebuild.
- **Blank page in production** — the nginx image serves `dist/`; confirm the build
  stage ran (`docker logs tlsoc-webui` shows nginx, not a build error) and that
  `dist/index.html` exists.
- **`/api` 502 from the SPA** — nginx proxies `/api/` to `http://tlsoc-backend:8088`
  (`webui/nginx.conf`). Confirm the backend container is named **`tlsoc-backend`**
  and healthy; LLM calls can be slow, so the proxy uses 300s read/send timeouts.
- **Dev `/api` not reaching the backend** — `npm run dev` proxies `/api` → `:8088`;
  point it elsewhere with `BACKEND_URL=http://my-backend:8088 npm run dev`.

**How to confirm.** `curl -fsS http://localhost:8080/api/health` returns
`{"status":"ok",...}`; the SPA loads and the wizard/console renders.

### B1. Setup shows "Can't verify setup state"

**Symptom.** First run shows a recovery screen with **Retry** instead of either the
setup workspace or the operational console.

**Likely cause.** `GET /api/setup/status` could not be read through the SPA's
`/api` proxy. This fail-closed screen is intentional: the console does not assume
setup is complete when the authoritative state is unavailable.

**Fix.** Confirm the backend is healthy, then test the setup endpoint through the
same web-UI proxy. Repair the proxy/backend path, authentication session, or backend
error shown in the response; then choose **Retry**.

```bash
curl -fsS http://localhost:8080/api/health ; echo
curl -fsS http://localhost:8080/api/setup/status ; echo
# -> {"setup_complete":false|true,"configured":{...}}
```

**How to confirm.** Retry opens **Workspace** when `setup_complete:false`, or the
console when `setup_complete:true`; it never briefly exposes the wrong surface.

### B2. Setup will not leave AI runtime

**Symptom.** Back, Continue, a progress-stage link, Launch, or Close on a setup
re-run leaves you on **AI runtime** with a key-save error.

**Likely cause.** A newly typed Anthropic/OpenAI/embedding key could not be written
to the runtime secret tier through `POST /api/setup/secrets`. Navigation is guarded
so it does not silently discard or pretend to save that credential.

**Fix.** Restore the backend connection and retry the same navigation action. Do
not blank an existing configured field to clear it: blank means unchanged; explicit
secret removal belongs in the security/settings workflow.

**How to confirm.** The stage reports the provider as configured, clears the typed
draft, and the requested navigation completes. No secret value is returned in the
status response.

### B3. "Discard this source draft?" appears during setup

**Symptom.** Back, a progress-stage link, or Close on a setup re-run asks whether to
discard a source draft.

**Likely cause.** The manifest-driven source editor is still open. This is a data-
loss guard, not a setup error.

**Fix.** Choose **Cancel** to keep editing, save the source, or choose **Discard and
continue** when abandoning the draft is intentional.

**How to confirm.** Cancel keeps the editor and its current values; discard closes
the editor and completes the requested navigation.

---

## C. Backend can't reach / own its Elasticsearch state (ES backend only)

> Skip this whole section if `STATE_BACKEND` is `postgres`/`sqlite`.

**Symptom.** With `STATE_BACKEND=elasticsearch`, `health` returns
`es_connected:false`, or `tlsoc-agent-*` indices never appear.

**Likely cause / fix.**
- **Read-only key** `ES_API_KEY` (or `TLSOC_ES_API_KEY`) present + scoped to the
  log indices (`read`, `view_index_metadata`).
- **Management key** `ES_MGMT_API_KEY` present + scoped to `tlsoc-agent-*`
  (`read`, `write`, `create_index`, `view_index_metadata`, `manage`) — an
  under-scoped mgmt key means indices never get created. Storage-lifecycle
  preview/apply additionally needs cluster `manage_ilm`, `manage_index_templates`,
  and `monitor`; without
  those, ordinary owned-state writes can still work while lifecycle reports Blocked.
- **CA cert** mounted and `ES_CA_CERT`/`ES_VERIFY_CERTS` set; **ES URL** correct
  (container-name DNS on the shared network).

**How to confirm.** `GET /api/health` → `es_connected:true`,
`store_type:RealESClient`; `_cat/indices/tlsoc-agent-*` lists the five indices.

> If `es_store_enabled` is on but ES is unreachable, the backend falls back to an
> **in-memory** store so the spine still runs — data is not durable until fixed.

---

## D. Connector "Test connection" fails

**Symptom.** The wizard / Sources screen "Test connection"
(`POST /api/connectors/test`) returns `ok:false` with a message.

> **A read-only key now reports SUCCESS, not a scary "unreachable".** For a pull
> source the test runs the cheap **scoped read-only search first** and treats *that*
> read as the authoritative gate — it no longer requires `ping()` (`HEAD /`), which
> a least-privilege read-only key cannot do. A correctly-scoped read-only key
> returns **`ok:true, mode:"read_only"`** with a green *"Read-only access verified —
> N events readable in `<pattern>`. Cluster-monitor privilege not granted (expected
> for a read-only key)."* If the key *also* has `cluster_monitor`, you get
> **`ok:true, mode:"full", cluster_monitor:true`** ("Connection verified"). A failed
> `ping()` alone is **no longer** a failure. (See `docs/USAGE.md` §2 "Test
> connection".)

**Likely cause / fix (by source type) — when it genuinely returns `ok:false`:**
- **Bad URL / unreachable** — for a pull source, the `es_url` (or equivalent) is
  wrong or not routable from the backend container. Use the in-cluster container
  name, not `localhost`.
- **Bad key / auth** — the read-only API key is wrong, revoked, or under-scoped (a
  `401`/`403` on the index when the scoped read runs). Re-mint it scoped to the log
  pattern (read-only: `read`, `view_index_metadata`).
- **TLS / cert** — a private CA isn't trusted: supply the CA PEM (`es_ca_cert`) or,
  for a self-signed lab only, turn **"Verify TLS certificates" off** on the source
  (`es_verify_certs:false`). This per-source setting now **actually applies** — the
  backend builds a **per-source ES client** from the source's own
  `es_verify_certs` / `es_ca_cert` / `es_url` / `es_api_key` (it used to fall back
  to the global client, so a source-level `es_verify_certs:false` was ignored and
  you'd see `CERTIFICATE_VERIFY_FAILED` despite it). The same per-source client
  backs the **Browse logs** endpoint (§D2), so a TLS fix there fixes both.
- **Field-mapping mismatch → connection OK but NO events.** "Test connection"
  proves the scoped read is reachable + authorised; it does **not** prove your
  `source_ip_field` / `user_field` / `host_field` / `rule_field` / `time_field`
  match the source's actual fields. If the mapping is wrong, polling returns rows
  but correlation/scope find nothing → no cases. Verify the field names against a
  real document in the source and fix them on the source (`POST /api/sources`).

**How to confirm.** Test returns `ok:true` (with `mode:"read_only"` or `"full"`); a
manual `POST /api/poll` returns non-zero `polled`/`new`, and `GET /api/cases`
populates.

### D2. "Browse logs" for a source is empty or errors

**Symptom.** The Sources → **Logs** flyout (`GET /api/sources/{id}/logs`) shows no
rows, or returns `501` / `502`.

**Likely cause / fix.**
- **`501` (unsupported)** — the connector doesn't advertise the `browse`
  capability; the "Logs" button only appears for connectors that do (all pull
  connectors + every push receiver).
- **`502` (read failure)** — a **pull** source's scoped read failed: same root
  causes as §D (bad URL, under-scoped key, or **TLS** — set `es_verify_certs:false`
  / supply `es_ca_cert` on the source; the browse endpoint uses the per-source ES
  client, so the source-level TLS setting applies).
- **Empty but `200`** — for a **pull** source, nothing matched the (bounded ≤200)
  scoped search in the chosen time range / `query`; widen the time-range picker
  window or clear the search box. For a **push** source, the in-memory live-tail
  buffer (≤500/source) is empty until events arrive — and it is **reset on a backend
  restart** (it is not persisted).

**How to confirm.** A pull source shows rows that match a known document; a push
source shows new events as you send them (turn on the 10s **live tail**).

---

## E. Webhook / HEC push returns 401

**Symptom.** A source POSTing to `POST /api/ingest/{source_id}` gets `401`
(`{"detail":"webhook authentication failed"}`).

**Likely cause.** The receiver's `auth_mode` and the presented credential don't
match.

**Fix.**
- **`auth_mode: bearer`** — the sender must send
  `Authorization: Bearer <token>` (a `Splunk <token>` or bare token are also
  accepted), and the source's `token` secret (set via
  `POST /api/sources/{id}/secrets`) must match. If `token` is unset, bearer mode
  rejects everything.
- **`auth_mode: hmac`** — the sender must send the hex HMAC-SHA256 of the **exact
  body** in `signature_header` (default `X-Signature`; a `sha256=` prefix is
  tolerated), keyed by the source's `shared_secret`. A different body, encoding, or
  secret fails the constant-time compare.
- **`auth_mode: none`** — accepts anything; use **only** behind a trusted proxy.

Remember per-source secrets live in the **in-memory** tier — after a backend
restart re-set them (`POST /api/sources/{id}/secrets`) or supply them via env.

**How to confirm.** A correctly-signed/bearered POST returns `{"ok":true,...}`
with a non-zero ingest count; the 401s stop.

---

## F. A queue receiver raises `ConnectionError: pip install <lib>`

**Symptom.** A configured Kafka/SQS/Kinesis/Event Hub/Pub-Sub/RabbitMQ/NATS/
MQTT/Redis-Streams/object-store receiver fails to start; logs show
`<module> is required for this connector. Install it with: pip install <lib>`.

**Likely cause.** That receiver's optional client library isn't installed. The
suite imports broker/cloud clients **lazily** (only when the receiver starts), so
the base image ships **without** them — a deployment that uses none of these stays
slim and importable.

**Fix.** Install the library named in the error (it's also in the manifest's
`requires_pip`), then restart the backend:

| Source type | `requires_pip` |
|---|---|
| `kafka` | `confluent-kafka` |
| `aws_sqs`, `aws_kinesis`, `s3` | `boto3` |
| `azure_event_hub` | `azure-eventhub` |
| `gcp_pubsub` | `google-cloud-pubsub` |
| `rabbitmq` | `aio-pika` |
| `nats` | `nats-py` |
| `mqtt` | `paho-mqtt` |
| `redis_streams` | `redis` |
| `gcs` | `google-cloud-storage` |
| `azure_blob` | `azure-storage-blob` |

Add it to a derived backend image (recommended) or `pip install` into the running
container for a quick test. `webhook`, `hec`, `syslog`, and `file` are stdlib-only
(`requires_pip: []`).

**How to confirm.** Backend logs `Started push receiver <id> (<type>)` with no
`Could not start receiver` error.

---

## G. A push / syslog receiver isn't receiving

**Symptom.** A configured syslog/Kafka/queue source shows no events; webhook posts
work but socket/syslog forwarding doesn't.

**Likely cause / fix.**
- **Port not published.** Socket receivers (syslog) bind a port **inside** the
  container (default `514`, configurable `bind_host`/`port`/`protocol`). Docker
  must **publish** that port for external forwarders to reach it — the agnostic
  compose leaves push ports commented; add e.g. `- "1514:1514/udp"` (and/or
  `/tcp`) and recreate the backend. Privileged ports (<1024) need
  `CAP_NET_BIND_SERVICE` or a high host port.
- **Receiver didn't start.** Background receivers start on app startup and on
  source save; a missing optional dep (section F) or a config error stops them —
  check `docker logs tlsoc-backend` for `Started push receiver` vs `Could not
  start receiver`.
- **Webhook/HEC are route-driven, not background tasks** — they only receive via
  `POST /api/ingest/{id}`; there is no port to publish for them.

**How to confirm.** Send a test datagram/message; `GET /api/cases` (or the poll
stats) shows new activity; logs show the receiver emitting batches.

---

## H. No cases appear

**Symptom.** Cases / Scans are empty after deploy.

**Likely cause / fix.**
- **Nothing in scope.** Lower `severity_threshold` (a high value filters
  everything); check `in_scope_rules` (empty = all) and `excluded_rules`; confirm
  `suppression_rules` aren't dropping the events.
- **Correlation threshold not met.** The default correlation is `threshold`, `n=5`
  in a 120s window — a handful of stray events won't form a cluster. Lower `n`,
  widen `window_seconds`, or use `every` for rare/high-sev rules.
- **Source field-mapping wrong** (pull) — see D: rows arrive but the entity/rule
  fields don't resolve, so nothing correlates. Verify the mapping.
- **No poll / no push yet.** For pull sources run `POST /api/poll`; for push
  sources confirm the receiver is up (F/G) and the source is sending.

**How to confirm.** `POST /api/poll` returns non-zero counts; `GET /api/cases`
lists cases.

---

## I. Duplicate cases (this should not happen)

Cases are keyed by an **entity-centric cluster signature** (one open case per
`(entity_type, entity_value)`). Re-polling **attaches** new events to the existing
open case instead of creating a duplicate; the durable cursor uses an inclusive
lower bound + boundary-id dedup. **With multiple enabled pull sources**, the poller
also holds a per-cluster-signature in-flight lock during a fan-out tick, so two
sources polled in the same tick can never both create a case for the same signature.
If you genuinely see two *open* cases for the same entity, confirm the entity values
are byte-identical (a closed historical case does not block a new open case for
later activity).

---

## J. Enrichment / RAG / Standup "degraded"

**Symptom.** Thin enrichment, weak RAG, or the deterministic standup fallback.

**Likely cause (by design these degrade gracefully).**
- **Enrichment** (19 registered providers behind the `EnrichmentProvider` SPI;
  e.g. AbuseIPDB/VirusTotal are two of the keyed ones): without a given provider's
  key, that provider's context is unavailable, but the keyless ones (Shodan
  InternetDB, IPinfo Lite, the abuse.ch trio, RDAP) still run, and GeoIP already in
  the source is still read.
- **RAG embeddings**: without an embedding/OpenAI key, the gateway **falls back to
  local hashing embeddings**; on Postgres without pgvector, to JSON cosine.
- **Standup**: if the summariser model is unavailable, it returns the
  **deterministic** summary.

**Fix.** Add the relevant provider keys you need (e.g. `ABUSEIPDB_API_KEY`,
`VIRUSTOTAL_API_KEY`, `EMBEDDING_API_KEY` / `OPENAI_API_KEY` — see
`docs/ENVIRONMENT.md` §2.7 for the full 19-provider list), or accept
degraded-but-working behaviour.

**How to confirm.** The usage ledger records provider failures as `outcome: error`
(visible in the **Cost** summary). A standup summary that is *not* the
deterministic fallback means the model is reachable.

---

## K. Cost panel empty

**Symptom.** `GET /api/usage/summary` shows zeros.

**Likely cause / fix.** No LLM calls in the window yet, or the usage store isn't
being written (ES backend not connected / mgmt-key issue; on SQL, a DB write
failure). Run something that calls a model (investigate, chat, standup), then
re-check. Candidate cases registered by the poller cost **nothing** (deterministic
risk only), so a queue of candidates with an empty Cost panel is expected.

**How to confirm.** `GET /api/usage/summary?window_hours=24` returns non-zero
`call_count`/`total_tokens`.

---

## L. Kill switch engaged

**Symptom.** Polling stopped; investigations return a `needs_human` case with
*"Kill switch engaged; investigation skipped."*

**Fix.** Settings → **Caps & kill switch** → uncheck **Kill switch** → Save (or
`PUT /api/settings -d '{"caps":{"kill_switch":false}}'`). With `setup_complete`
true and `polling_enabled` true, saving restarts the poller.

**How to confirm.** `GET /api/settings` shows `caps.kill_switch:false`; a
subsequent `POST /api/poll` runs normally.

---

## M. "Everything routes to NEEDS_HUMAN"

**Symptom.** Every case lands in `needs_human`, often with low/zero confidence.

**Likely cause.** No or invalid LLM key → the system **fails safe to a human**
(the router defaults to UNCERTAIN; any pipeline failure yields `needs_human`
rather than dropping the alert). Chat shows "assistant unavailable" in the same
situation.

**Fix.** Configure a valid provider key (Settings shows `anthropic_api_key:
configured ✓` and/or `openai_api_key: configured ✓`); confirm the per-role model
names are valid for that provider.

> **A registered local / self-hosted (LiteLLM-compatible) model behaves the same
> way.** If a role is pointed at a custom model whose `base_url` is unreachable,
> whose endpoint requires a key you didn't set (`litellm_api_key` / `LITELLM_API_KEY`
> blank), or that returns an incompatible response shape, the gateway call fails and
> the case (or chat turn) fails safe to `needs_human` / "assistant unavailable" —
> exactly like a missing cloud key. Use **Settings → Models → "Add local model" →
> Test** (`POST /api/llm/providers/test`, non-metered) to isolate a bad `base_url` /
> missing key from an unrelated pipeline issue before touching anything else.

**How to confirm.** The provider shows configured; the usage ledger stops logging
`outcome: error` for completions; new investigations produce real verdicts.

> This is fail-safe behaviour, not a bug: routing to a human beats silently
> dismissing an alert.

---

## M2. A rule never auto-closes and the agent reports "no context" for a field that is there

**Symptom.** One detection rule routes to `needs_human` on essentially every case,
and the case evidence says something like *"…alert from 10.97.3.201; no HTTP or
execution context."* — while a direct query against the index shows the record
plainly carries `url.path`, `http.request.method` and `user_agent.original`. Raising
`investigator_model.max_tokens` or `caps.timeout_seconds` changes nothing, and
growing the analyst-confirmed precedent corpus for that rule changes nothing either.

**Likely cause.** The agent is telling the truth about *its inputs*. Each sample
event reaches the model as a **bounded projection** of the record, not the whole
record, and the field that decides your rule is not in the projection. Before
0.1.13 that projection was a fixed seven keys with no way to widen it; since 0.1.13
it defaults to the ECS set that usually carries the verdict, but a source with a
non-ECS schema (a vendor prefix like `data.url`, a custom detection field) still
needs to name its own paths. The tell that it is this and not a model problem: the
verdict does not improve with more tokens, more time, or more precedent, because
none of those supply a missing per-case discriminator.

**Fix.** Add the deciding paths to the evidence projection.

1. **Find out what your alerts actually carry.** Open **Sources → your source →
   Advanced — field mapping**, paste one real alert record and press *Suggest
   mappings*. `POST /api/sources/{id}/analyze-sample` returns
   `suggested_evidence_fields` — which of the default evidence paths that record
   carries — alongside the full `fields` inventory of every path in it.
2. **Set the projection.** Deployment-wide in **Settings → General → Case evidence
   fields**; for a single source, through its `evidence_fields` config key on
   `POST /api/sources` (there is no per-source Console control for this yet). Paths
   are dotted and are read the same way as the field mapping, so `data.url` and
   `data.srcip` work. An empty list restores the pre-0.1.13 identity-only
   projection; `["*"]` sends the whole record, bounded only by the per-event
   character budget beside it.
3. **Re-investigate one case** and read the new verdict and evidence.

**How to confirm.** Ask the agent in **Chat** to query the source for the entity
(e.g. `ip:10.97.3.201`) and look at the result table: each row now carries the fields
you added. That is the direct check — the rows the agent sees are the rows you see.

> **Two things that will NOT confirm it.** The Investigation trace shows the audited
> prompt *excerpt*, which is truncated at 1,000 characters and begins with the
> memory/playbook/precedent blocks, so it usually ends before the sample events —
> its absence there proves nothing. And a free-text `contains` query is an analysed
> *term* match, not a substring scan: it matches a word in an analysed field
> (`message`, `event.original`) but matches an exact-value `keyword` field only
> against its whole value, so `contains: "editpdf"` will not find
> `/mod/assign/feedback/editpdf/ajax.php`. The projection is the fix; the search
> disclosure only stops a zero being misread as an absence.

> **Rules that genuinely have no per-alert context are a different problem.**
> Aggregation and ES|QL detections (excessive-404 enumeration, session-key reuse
> across IPs, request-rate credential stuffing) alert on a *count*, so no single URL
> or user agent exists to attach. Widening the projection correctly does nothing for
> them — they need analyst precedent (§ Settings → Detection → precedent) or a
> suppression/analyst policy, not more fields.

---

## N0. A replay experiment reports "insufficient evidence"

**Symptom.** A `replay_experiment` job succeeded, but `arm_comparison.verdict` is
`insufficient_evidence` or `indistinguishable_from_noise` and there is no number to
act on.

**Cause.** That is the answer, not a failure. The harness measures each arm's own
self-consistency first and refuses to call a difference real unless it clearly exceeds
that floor. Read `reason`: `noise_floor_not_measured` (`repeats < 2` cannot measure a
floor at all), `run_incomplete` (an interrupted or cancelled run), `no_paired_fixtures`,
`single_arm`, or `noise_floor_undersampled` (repeat cells were lost to exclusion, so the
floor rests on fewer comparisons than the table it would gate — `noise_floor_coverage`
shows the shortfall). An insufficient-evidence result carries its raw counts and NO
rate, difference or p-value: it is never converted into a score.

A separate verdict, `underpowered`, means the difference DID clear the floor but this
many discordant pairs cannot reach `alpha` under any split — add fixtures. Distinguish
it from `indistinguishable_from_noise` by reading `above_noise_floor` and
`significant_at_alpha`, which are reported separately from their conjunction
`exceeds_noise_floor`.

**Fix.** Run with `repeats >= 2`, enough fixtures for the paired table to be
informative (check `arm_comparison.n_pairs`, `b` and `c` — never read `p_exact`
without them), and a `spend_bound_usd` high enough that the run does not cancel.

**Also note.** The harness cannot answer a retrospective question about a change that
already shipped: the originating log events age out and the stored fallback strips
record content, so no fixture for a past build can be rebuilt. Capture runs forward.
See [`docs/development/replay-harness.md`](development/replay-harness.md).

**How to confirm.** `report.json` carries `noise_floor.measured: true`, a non-zero
`arm_comparison.n_pairs`, and `spend.tripped: false`.

---

## N0b. A replay experiment failed with "cannot be resumed"

**Symptom.** A `replay_experiment` job that was running when the worker restarted comes
back `failed`, with a failure reason saying the run cannot be resumed.

**Cause.** Deliberate. `spend_bound_usd` applies to the whole job, and a run's accrual
is read from a run-scoped ledger mirror a new worker cannot reconstruct. Resuming would
hand the remaining fixtures a fresh, untouched copy of the ceiling and let one
interruption spend it twice.

**Fix.** Submit a new run for the remaining fixtures. The first attempt's spend is
already visible in the usage ledger under `surface = "replay"` and in its keyed
`job:<id>:replay-spend` audit row; the refusal itself spends nothing.

---

## N. Settings won't save / read-only

**Symptom.** The Settings form is disabled, or a PUT returns `403 Settings are in
read-only mode`.

**Fix.** Disable `read_only_settings_mode` (the PUT that turns it off must set
`read_only_settings_mode: false`):
`curl -X PUT .../api/settings -d '{"read_only_settings_mode": false}'`.

**How to confirm.** `GET /api/settings` returns `"read_only": false`.

---

## O. Invalid `correlation_rules` JSON

**Symptom.** The per-rule correlation editor shows an invalid-JSON hint and
changes don't persist; a PUT returns `422 Invalid settings`.

**Fix.** Make it valid JSON — a map of rule value → `{ mode, n, window_seconds,
group_by }` (see `docs/USAGE.md` §9). A `422` means schema validation failed (e.g.
`n < 1`, unknown `mode`/`group_by`).

**How to confirm.** Save succeeds; `GET /api/settings` reflects your map.
