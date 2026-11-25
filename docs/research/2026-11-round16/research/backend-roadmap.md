# Backend and platform roadmap (research key: backend-roadmap)

Branch `claude/round16`, commit `3cd362c` (one Journal commit after Round 15's merge to `Testing`). Read-only research: nothing in the repository was edited. Measurements ran offline on SQLite in the session scratchpad, against copies of the bundled demo cases.

## 1. Summary

Agentic SOC's backend is careful about correctness, but at real scale three code paths do far more work than they need. All three can be fixed in Round 16 without touching `decide()`, the risk scorer, or the storage layout (#3, #12):

1. **The PostgreSQL profile never uses pgvector.** The documentation and the Compose image advertise PostgreSQL + pgvector. In the code, `SqlVectorStore.search` reads every RAG chunk and every 1,536-float embedding from the database, then scores cosine similarity in pure Python. At 2,000 chunks one query takes 1.2 to 1.5 s. A numpy matrix cache answers the same query in 0.2 ms once warm (numpy is already a pinned transitive dependency of `pgvector`). On PostgreSQL, the `<=>` operator can score the existing JSON column with no schema change.
2. **The Overview reloads the whole case store every 5 seconds.** It defaults to LIVE (a 5 s poll). Each tick calls `GET /api/metrics`, which reads the all-time case population: up to 20,000 whole Case documents. The cache lifetime is also 5 s. At 20,000 cases on SQLite one reload took 2.5 to 3.0 s, peaked at 714 MB of memory, and stalled the event loop for up to 356 ms at a time. One open Overview tab can keep the backend roughly half busy.
3. **On SQL, every filtered Case Manager view reads every whole case.** That covers Mine, search, assignee, severity, verdict, rule and the priority sorts. The SQL `scan_page` discards the field projection the queue asks for. At 20,000 cases: All took 1.9 s, Active 0.65 s and a search 2.5 s, on every request.

The operator's Round 16 asks also need backend work:

- a global "AI is investigating" frame plus a snapshot of active investigations;
- the risk score's inputs and the weights in force, stored on the case at scoring time, so "81" can be explained exactly;
- a per-user "What's new seen" marker read from bundled release notes.

Everything larger goes to Round 17 or later: durable push receipt, multi-replica leases, the first new pull connector (Splunk), Sigma import, a free local-model preset, observability export and a backup command. Each still has a concrete plan below.

## 2. Measurements (read-only, offline)

Environment: `backend/.venv` (Python 3.11.18), SQLite file stores built in the scratchpad. The cases are copies of `generate_historical_cases(1337, ...)` demo cases, which average **2,685 bytes of JSON**. Real investigated cases carry evidence and traces and are larger, so these figures are a floor.

| What | Where in code | Result |
|---|---|---|
| All-time dashboard population, 20,000 cases, cold | `api/metrics_shared.py:431` `fetch_case_population(limit=20000)` | 2,507 to 2,977 ms; peak RSS 714 MB |
| Same, event-loop health during the load | worker-thread validation at `metrics_shared.py:711` | worst stall 356 ms; 976 ms of summed lateness |
| Same, 7-day window (2,338 cases) | same | 511 ms |
| Exact headline counts (SQL GROUP BY push-down) | `metrics_shared.fetch_case_breakdown` | 415 ms cold |
| Case Manager queue, All / Active / search "ssh" | `api/routes.py:6686` `_scan_case_queue` | 1,942 / 652 / 2,489 ms |
| Review scope batch read of 2,000 cases | `api/routes.py:6663` `_queue_cases_by_id` | 285 ms |
| Review ledger at its 2,000-entry bound | `stores/auto_close_review.py:372` `load()` | document about 758 KB; 15.5 ms per load on SQLite (about 9 ms of that is JSON decode on the loop) |
| RAG vector search, 2,000 chunks of 1,536 dimensions | `stores/sql/vectorstore.py:74` | 1,205 to 1,460 ms per query; 62 MB database |
| Same with a cached, normalised numpy matrix | prototype in the scratchpad | 0.20 ms warm; 1.9 ms change-fingerprint query; 1,117 ms one-off cold load |
| Plain indexed reads | `SqlCaseRepository.list(limit=50)`, `get`, `count_created_since` | 14.9 / 2.0 / 4.1 ms |

The benchmark scripts are in `/tmp/claude-0/-home-user-Kavach-AgenticSOC/2fc24c44-3228-5bc2-8fb3-56e1bc548beb/scratchpad/round16/bench/` (`bench_pop.py`, `bench_lag.py`, `bench_queue.py`, `bench_getmany.py`, `bench_vec.py`, `bench_vec_np.py`, `bench_ledger_kv.py`). Elasticsearch and PostgreSQL could not run here because container registries are blocked. The ES figures are therefore not measured. The PostgreSQL claims rest on code reading and pgvector's documentation.

## 3. Bugs and mismatches found

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| BG1 | pgvector is installed, the extension is created, and it is never used. Search loads every row and scores cosine in Python on PostgreSQL as well as SQLite. `_is_pg` is set and never read. The docs say "pgvector `<=>` when available". | `stores/sql/vectorstore.py:41-47`, `:74-98`; `stores/sql/engine.py:152-161`; `requirements.txt` pins `pgvector==0.4.2` but nothing in `app/` imports it; `stores/sql/models.py:116` stores `embedding` as JSON | High (performance; documentation claims more than the code does) |
| BG2 | LIVE Overview reloads the all-time population on every 5 s tick | `webui/src/soc/components/TimeRangePicker.tsx:119-129` (`live: 5_000`); `webui/src/soc/pages/Overview.tsx:2142` (default `'live'`), `:2282` (`api.getMetrics`); `api/routes.py:3400-3425`; `api/routes_metrics.py:157-180` (`_population(state, None)`); `api/metrics_shared.py:66,212` (5 s TTL); invalidation is TTL-only | High at scale |
| BG3 | The Case Manager queue docstring says the scan "reads only `CASE_QUEUE_SCAN_FIELDS` ... never the evidence-bearing whole documents". On SQL and PostgreSQL that is false: `scan_page` deletes `fields` and reads whole documents. | `api/routes.py:6707-6713`; `stores/sql/repositories.py:469-500` (`del fields` at `:500`) | Medium (performance; misleading docstring) |
| BG4 | `POST /api/ingest/{source_id}` holds the HTTP request open through every investigation it triggers, one after another. One webhook batch can hold a connection for many minutes. Senders with short timeouts retry, which multiplies load. Correctness holds, because attach is idempotent (#4). | `api/routes.py:1295`, `:1327`; `engine/ingest.py:424-426` (`await fn(cluster, ...)` inside the per-cluster loop); `webui/nginx.conf:83` (300 s) | Medium |
| BG5 | Opening an agent-closed case reads and decodes the whole review ledger. The repair path reads it again. The summary badge can read it three times per request. | `api/routes_auto_close_review.py:692`, `:321`, `:731/:750`; `stores/auto_close_review.py:191-196` (linear `entry_for_case`) | Low to medium (already in ROADMAP J) |
| BG6 | `Preferences.match_rule` re-sorts the whole rule catalog on every event, then evaluates every enabled rule. This is harmless with today's few dozen rules, but quadratic-feeling with a Sigma pack of thousands. | `config.py:4731-4746` | Low now; a blocker for Sigma |
| BG7 | The investigator ignores a custom model's declared `context_window`. Only chat reads it. A small local model (8k to 32k tokens) can overflow on later ReAct steps. The overflow is plausible, not reproduced. | `stores/custom_models.py:98`; `grep context_window` hits only `agents/chat.py`, `agents/chat_protocol.py` and `llm/pricing.py`; `agents/prompts.py:491` (`max_events=12`), `evidence_fields.py:134` (1,200 chars each) | Medium for the "free local model" goal |
| BG8 | Investigation progress (`agent.step`) goes only to the per-case room `cases:{id}`. No global frame exists, so the shell cannot say "AI is investigating" unless that case is open. | `agents/pipeline.py:405-438`; `realtime.py:93-117` | Feature gap (operator ask) |
| BG9 | The risk explanation the API offers recomputes with the **current** weights. The case stores only the five factor scores, never the inputs (event count, window, rate, rule count, reference points) or the weights used. Exact "show me the math" is therefore impossible after a weight change. | `models.py:282-288` (`RiskBreakdown`); `engine/risk.py:18-21`, `:77-119`; `api/routes_triage.py:550-600` (`matches_displayed_score`) | Feature gap (operator ask) |

## 4. Recommendations, ranked

Each item lists what to build, where, effort, value, risks, tests and Round 16 fit. Effort: S is about a day, M is two to four days, L is a week or more.

### R1. Make RAG vector search native on PostgreSQL and cached on SQLite (BG1)

- **What:** On PostgreSQL, score in the database with pgvector and keep the existing JSON column:
  ```sql
  SELECT id, text, source, metadata, embedding_model, dim,
         1 - (CAST(CAST(embedding AS TEXT) AS vector) <=> CAST(:q AS vector)) AS score
  FROM rag_chunks WHERE dim = :dim ORDER BY score DESC LIMIT :k
  ```
  pgvector's text parser skips whitespace around elements, so the JSON text `[0.1, 0.2]` that SQLAlchemy writes parses as a vector. On SQLite, and as the PostgreSQL fallback when the extension is missing, keep an in-process float32 matrix of normalised embeddings plus row ids. Validate the cache with `SELECT count(*), max(id)`, invalidate it on `add`, `delete_document` and `clear`, then load the text and metadata for the top-k ids only.
- **Where:** `stores/sql/vectorstore.py` (`search`, `add`, `clear`, `delete_document`; use `self._is_pg`); probe `pg_extension` once at engine start in `stores/sql/engine.py:152`.
- **Effort:** M. **Value:** high. Every investigation (the `rag_retrieve` tool and threat context, `engine/threat_context.py:136`) and every chat knowledge lookup (`agents/chat.py:1134`) calls this. Measured: 1.2 to 1.5 s drops to 0.2 ms warm at 2,000 chunks. The corpus is the 697 MITRE techniques, the runbooks, suppression text, and up to 5,000 analyst-confirmed resolved cases (`tools/rag.py:211`), so production stores can be larger.
- **#12 check:** no new table, column or index. A real HNSW index (`vector(dim)` column plus `vector_cosine_ops`) can wait for R18 (migrations). Exact sequential search needs no index.
- **Risks:**
  - pgvector stores float4, so scores differ from the Python float64 cosine by about 1e-7. A borderline `min_score` gate can flip; pin the parity test with a tolerance.
  - `<=>` raises on mismatched dimensions. Keep the `embedding_space()` check that `tools/rag.py:5233-5238` already does, and add the `dim` filter.
  - The numpy cache costs memory: 2,000 × 1,536 × 4 bytes is 12 MB, and 6,000 chunks is 37 MB.
- **Tests:**
  - parity of top-k ids and scores between the Python, numpy and pgvector paths, in the existing real-PostgreSQL CI lane;
  - cache invalidation after add, delete and clear, and after a write by another process (fingerprint change);
  - dimension mismatch still raises `EmbeddingSpaceMismatch`;
  - an offline SQLite timing guard, for example 2,000 chunks under 50 ms warm.
- **Round 16:** yes. It is self-contained and fixes a documented claim.

### R2. Stop re-reading the all-time population on each LIVE tick (BG2)

- **What, in three layers, smallest first:**
  1. **Backend:** give the all-time population its own TTL, 60 s for example, with stale-while-revalidate: serve the last value while one background refresh runs. Keep 5 s for windowed reads. The figures that need all time (average risk, burndown, MTTR, persona usage, feedback) change slowly, and the response already carries `generated_at`.
  2. **Backend:** move the `GET /api/metrics` figures that the Overview shows for the selected window onto the window-scoped population (`_population(state, window_hours)`). The 7-day read took 511 ms against 2.7 s all-time; 24 hours is smaller still.
  3. **Frontend, a one-line follow-up:** on a LIVE tick, refresh `getMetrics` at most every 30 to 60 s instead of every 5 s.
- **Where:** `api/metrics_shared.py:212` (`POPULATION_TTL_SECONDS`) and `:431-500` (`fetch_case_population`); `api/routes_metrics.py:157-200` (`legacy_metrics_payload`); `webui/src/soc/pages/Overview.tsx:2282`.
- **Effort:** S for layers 1 and 3, M for layer 2 (each moved figure must keep its "truncated" and "exact" semantics). **Value:** high. It removes a continuous 2.5 to 3 s, 714 MB load per open Overview at 20,000 cases.
- **Risks:**
  - A figure up to 60 s stale. Say so with the existing `generated_at`; never present a stale value as fresh.
  - The single-flight lock must not let a background refresh starve a foreground request.
  - Moving figures to the window changes their meaning; keep names and tests explicit.
- **Tests:**
  - a fake store counts reads: across N LIVE ticks inside the TTL there is at most one all-time read;
  - stale-while-revalidate returns the previous population while the refresh is in flight;
  - the existing parity tests for `/api/metrics` truncation and counts still pass.
- **Round 16:** yes, layers 1 and 3. Layer 2 if time allows.

### R3. Project fields and push queue filters down on SQL (BG3)

- **What:**
  1. Make SQL `scan_page` honour `fields` when `raw=True`. On PostgreSQL select `json_build_object('k1', doc->'k1', ...)`; on SQLite select `json_object('k1', json_extract(doc,'$.k1'), ...)`. Decode only that small object in the worker thread.
  2. Push the cheap equality filters (assignee, severity band, verdict) into `WHERE`. The helper `_sql_json_text(key)` already exists at `stores/sql/repositories.py:900`. The free-text term match stays in Python on the projected fields.
- **Where:** `stores/sql/repositories.py:469-560` (`scan_page`, `_scan_newest_page`); `api/routes.py:6686-6780` (`_scan_case_queue`, which already passes `fields=list(CASE_QUEUE_SCAN_FIELDS)`); fix the docstring at `:6707` either way.
- **Effort:** M. **Value:** high for the operator's "cleaner Case Manager" goal, because each view switch costs 0.65 to 2.5 s at 20,000 cases today. Real cases are several times larger than the 2.7 KB demo cases, so the saving from projection grows with case size.
- **Risks:**
  - JSON path semantics differ between SQLite and PostgreSQL (nulls, arrays, the `json` versus `jsonb` type; `CaseRow.doc` is generic `JSON`).
  - The never-drop rule (#4) for unparseable `created_at` must keep its behaviour.
  - Search must still match exactly what it matches today.
- **Tests:**
  - parity: each queue filter combination returns the same ids and total with and without the projection, on SQLite and in the PostgreSQL lane;
  - a timing guard at 20,000 cases;
  - the existing Round 12 L1 bounded-memory tests.
- **Round 16:** yes for the projection. The push-down is a stretch.

### R4. Read one review entry, not the whole ledger, per case open (BG5, ROADMAP J)

- **What:**
  - Memoise the decoded `ReviewLedger` inside `AutoCloseReviewStore`, keyed by the document's `_rev`. After a local `update()`, replace the cached value. Read the rev cheaply where the backend allows; otherwise compare the raw string length and hash before decoding.
  - Build a `case_id -> entry` dict once per decoded ledger, which removes the linear `entry_for_case`.
  - In `case_review_state` and `auto_close_review_summary`, pass the already-loaded ledger into `_repair` instead of loading it again.
- **Where:** `stores/auto_close_review.py:191-196`, `:346-410`; `api/routes_auto_close_review.py:313-337`, `:679-762`.
- **Effort:** S. **Value:** medium. About 15 ms and 758 KB per case open at the bound today, and two or three loads per summary request.
- **Risks:** a stale cache on another replica. The deployment is single replica, and the rev check bounds staleness to one read. The strict compare-and-set write stays authoritative.
- **Tests:**
  - load-count assertions (one decode per rev);
  - a repaired entry is visible on the next read;
  - a write by another store instance invalidates the cache.
- **Round 16:** yes, a small and contained change.

### R5. Event-loop lag gauge in diagnostics

- **What:** a 100 ms ticker task that records the worst and 99th-percentile loop lateness over the last minute, exposed in `GET /api/diagnostics/health` (and in the R16 exporter). The population load stalled the loop for 356 ms even with its worker-thread offload (`metrics_shared.py:711-716`). CPU-bound Pydantic validation in a thread still holds the GIL, and SSE heartbeats, chat streams and receivers share that loop.
- **Where:** `state.py` startup tasks (near `:2442`); `api/routes_diagnostics.py`.
- **Effort:** S. **Value:** medium. It makes R2 and R3 measurable in the field.
- **Risks:** negligible overhead.
- **Tests:** a unit test with a deliberately blocking coroutine shows the gauge rise.
- **Round 16:** yes.

### R6. Precompile the rule catalog order (BG6)

- **What:** cache the enabled, priority-sorted catalog on `Preferences`, invalidated when `rule_catalog` changes. This is required before R14 (Sigma) can add thousands of rules.
- **Where:** `config.py:4731-4746` (`match_rule`).
- **Effort:** S. **Value:** low today, a prerequisite later.
- **Risks:** a stale cache after a rules edit. Invalidate in the `rule_catalog` setter and the Preferences reload path.
- **Tests:** match results stay identical across edits; a micro-benchmark.
- **Round 16:** optional.

### R7. Global "AI is investigating" signal (operator ask, BG8)

- **What:**
  - Publish a new `case.investigation` SSE frame on the global `cases` topic when an investigation is queued, starts, finishes or fails. The payload holds `case_id`, `case_number`, `phase` and `started_at`. Never log or AI text (#9).
  - Add a small process-local `InvestigationTracker` (`case_id -> started_at, step`), fed by the same `_emit_step` call sites.
  - Add `GET /api/investigations/active` (`cases:read`) so the shell can rebuild the indicator after a reload, the same way chat rejoins a running turn.
  - Register the event name in `SSE_EVENT_TYPES` and mirror it in `webui/src/lib/useEventStream.ts`; a test asserts the two lists agree.
- **Where:** `agents/pipeline.py:405-438` (next to `_emit_step`); `realtime.py:93-117`; a new route in an existing router (for example `api/routes_triage.py`).
- **Effort:** S to M. **Value:** high, because it is an explicit operator ask.
- **Risks:**
  - Frame volume under burst ingest. Coalesce per case and publish phase changes only.
  - Process-local truth. Document it as single replica, like the chat registry.
  - Object-scope RBAC: when `can_object()` scope is on, filter frames per subscriber or send counts only.
- **Tests:**
  - frames on start, finish and failure, in order;
  - a failure leaves no ghost entry (`finally:` cleanup);
  - the snapshot route agrees with the frames;
  - the event-name parity test with the client.
- **#3:** the frames narrate the work and decide nothing.
- **Round 16:** yes.

### R8. Store the risk score's inputs and weights at scoring time (operator ask, BG9)

- **What:**
  - Add an additive, defaulted `RiskExplanation` to `Case`: inputs (event count, window seconds, computed rate, distinct rule count, reputation value and its source, asset-criticality value and its source: network CIDR or named asset), the reference points (`_VOLUME_REF=50`, `_VELOCITY_REF=10.0`, `_DIVERSITY_REF=5`), the weights in force, and a `formula_version`.
  - Build it with a new pure `explain_risk(cluster, prefs, reputation)` next to `compute_risk`, at the three pipeline call sites. **Do not change `compute_risk` itself.**
  - `_risk_calculation` then shows the stored weights and inputs, and keeps the current-weights recomputation as a second, labelled line.
- **Where:** `models.py:282` (beside `RiskBreakdown`); a new pure function in `engine/risk_explain.py` (keeps `engine/risk.py` byte-identical); `agents/pipeline.py:942`, `:1415`, `:1564`; `api/routes_triage.py:550-600`; `webui/src/lib/types.ts`.
- **Effort:** S to M. **Value:** high. It directly serves "hover 81, see the exact numbers and the math".
- **Risks:**
  - `explain_risk` must reproduce `compute_risk` exactly. Add a property test asserting equal factor values and total over random clusters.
  - Legacy cases have no explanation; show "inputs not recorded for this case" rather than inventing them.
  - Payload size is about 300 bytes per case.
- **Tests:**
  - a property test of `explain_risk` against `compute_risk`;
  - the triage response carries the stored weights;
  - a legacy case reads as unavailable;
  - `engine/risk.py` and `case_manager.decide()` byte-identical (the existing gate).
- **Round 16:** yes.

### R9. "What's new" backend support (operator ask)

- **What:**
  - At build time, generate `releases_manifest.json` from `docs/releases/*.md`: version, date, headline items and screenshot paths. Follow the pattern of `scripts/build_app_knowledge.py`.
  - Serve it at `GET /api/releases/notes`; it is public build data.
  - Store the per-user `misc.whats_new_seen` (the version string) in `UserPrefs.misc` (`models.py:1047`), which needs no new storage.
  - The Console shows the screen once, when the running version is newer than the stored marker.
- **Where:** `scripts/`, `backend/app/knowledge/` or `api/routes_releases.py` (which already exists for upstream discovery); `stores/user_prefs.py`.
- **Effort:** S (backend). **Value:** high (operator ask).
- **Risks:** with auth off there is no per-user marker. Fall back to browser storage and say so. Screenshots must ship inside the bundle: no remote fetch, cold-deployable (#12).
- **Tests:** manifest generation `--check` in CI, as `build_app_knowledge --check` does; the marker round-trips; a first login on a new version returns "unseen".
- **Round 16:** yes. The release page itself is mostly docs and frontend work.

### R10. Answer HTTP push before investigating (BG4); durable receipt later (R11)

- **What:** for `POST /api/ingest/{id}`, give the request an investigation allowance of 0. Eligible clusters become the existing durable `deferred:` candidates. The `PollerManager._drain_deferred` loop (`engine/poller_manager.py:457`) already reads those from the case store and investigates them on a later tick within the shared per-tick cap. Return `202` with the counts after correlation and case save.
- **Where:** `engine/ingest.py:287-430` (`handle_clusters`; the `investigation_budget.try_claim()` path at about `:404`); `api/routes.py:1295-1340`.
- **Effort:** M. **Value:** medium to high for webhook, HEC and Splunk alert-action sources.
- **Risks:**
  - Latency rises by up to one poll interval.
  - The drain runs only when the manager ticks. Verify it runs with zero pull sources; if not, start a small drain loop for push-only deployments.
  - `cluster_for_case` must rebuild push clusters from stored evidence. Verify this before relying on it.
  - The response field `investigated` changes meaning. Keep it present and add `deferred`.
- **Tests:**
  - an HTTP push returns before a stub investigator that sleeps 30 s;
  - the drain picks the candidate up on the next tick;
  - restart during the window loses nothing;
  - the cap is honoured across push and pull.
- **Round 16:** a stretch. Fits only if the drain checks out quickly.

### R11. Durable push receipt (ROADMAP F P0)

- **What:**
  - Before acknowledging, write each HTTP or syslog-TCP batch as one KV document in an `ingest_inbox` namespace: an opaque string field holding the batch, plus source id, receipt id and received time.
  - Track the documents in a bounded strict-CAS ring index document, the pattern of `stores/jobs.py` (`MAX_JOBS=1000` at `:40`).
  - A worker claims receipts with `put_if` leases, processes them, and deletes them. After N attempts a receipt moves to a bounded dead-letter ring with a replay route.
- **Effort:** L. **Value:** high (an honest no-loss claim).
- **Risks:**
  - The KV has no namespace listing (`stores/base.py:1131-1210`), so the ring index is mandatory.
  - On Elasticsearch, use opaque fields only, to avoid the config-index mapping growth ROADMAP G already tracks.
  - Throughput depends on per-batch KV writes, not per-event writes.
- **Round 16:** no. Design it in Round 16 and build it in Round 17.

### R12. Path to more than one replica

- **What (staged):**
  1. A leader lease in KV: one `runtime/leader` document renewed every 10 s through `put_if`. Only the leader runs the pollers, receivers and scheduler loops (`state.py:2442-2444`), so a standby replica can take over (active-passive).
  2. A cross-process signature claim: a create-only `put_if` on `open_signature/<sha256>` before a case is created. The in-process `pipeline.signature_lock` (`agents/pipeline.py:387-403`) and the non-unique SQL index (`stores/sql/models.py:33`) cannot stop duplicate cases across processes.
  3. Realtime fan-out over PostgreSQL `LISTEN/NOTIFY` (asyncpg is already pinned) or Redis pub/sub. The Redis cache is fail-open (`cache.py:1-60`), so it cannot be the only authority.
  4. The chat turn registry (`api/routes_chat.py:657`) and the investigation gate move last.
- **Effort:** L overall (stage 1 is M). **Value:** medium for small free deployments, high for "the world at scale".
- **Risks:** clock skew on lease expiry (use the store's revision, not wall time, where possible); split-brain during failover; the factory-reset quiescence guarantees are process-local today (known limitations, "Single replica only").
- **Round 16:** no.

### R13. First new pull connector: Splunk, then Microsoft (Sentinel and Defender) and CrowdStrike

- **Why Splunk first:** it is the most common SIEM behind "we already have alerts". There is already a Splunk HEC push receiver (`SourceType.HEC`). The search API is simple: `/services/search/jobs/export` streams JSON results with `earliest_time`/`latest_time`.
- **What:**
  - A `SplunkConnector(PullConnector)` implementing `ping`, `poll`, `search` and `fetch_by_ids` (`connectors/base.py:261-298`). It compiles `StructuredQuery` (`connectors/base.py:108-126`) to SPL with escaped field values (operator-scoped index and sourcetype, never LLM-written SPL).
  - The cursor is `_indextime` plus a `_cd` tie-breaker with the five-minute late overlap the poller already applies.
  - Map records to OCSF in `to_ocsf`. Optional `aggregate` via `stats count by`.
  - Ship it as a built-in or as an entry-point package (`tlsoc.connectors`; `connectors/registry.py`).
- **Next:**
  - Microsoft Graph `GET /security/alerts_v2` covers Defender XDR (and Sentinel incidents once the workspace is onboarded to the Defender portal), with `$filter` on `lastUpdateDateTime` and `@odata.nextLink` paging; it needs `SecurityAlert.Read.All`.
  - Sentinel raw tables through the Log Analytics query API.
  - CrowdStrike Alerts with `after`-token paging.
- **Effort:** M per connector for alert pull; L with full search parity. **Value:** high for adoption.
- **Risks:**
  - SPL injection through values: compile with strict quoting and unit-test hostile values.
  - Vendor test tenants are not available in CI: build recorded-fixture tests.
  - Microsoft documents that client credentials against the direct Log Analytics endpoint may fail and recommends the ARM endpoint. A community report says `createdDateTime` filters on alerts_v2 returned a subset. Both need live verification.
  - #1: document a least-privilege, read-only role per vendor.
- **Tests:**
  - recorded-response fixtures for paging, cursor, late arrival, the same timestamp across pages, and an auth failure that routes to NEEDS_HUMAN without dropping;
  - SPL escaping property tests.
- **Round 16:** no; Round 17 candidate.

### R14. Sigma detection-as-code import (review-first)

- **What:**
  - Accept Sigma YAML through `POST /api/rules/sigma/validate` and `/import`, which create Draft detection rules that need the existing Detection & Rules review.
  - Evaluate a supported subset in-engine over the raw `_source`: field modifiers `contains`, `startswith`, `endswith`, `re` (bounded), `cidr`, `all`, list OR; conditions with `and`/`or`/`not`/`1 of`/`all of`.
  - Add `RuleMatch.op = "sigma"`, carrying a compiled tree (`config.py:513-548`; `RuleDefinition.match` is a single predicate at `:606`).
  - Map Sigma `event_count` correlations onto `CorrelationRule(mode=threshold, n, window_seconds, group_by)`. Report every unsupported construct (for example `value_count`, `temporal`, `value_*` and unknown modifiers) as "not imported" with a reason; never approximate it.
  - Index rules by `logsource` product and category to keep per-event cost bounded (R6).
- **Where:** a new `engine/sigma.py` (pure parser and evaluator); `config.py` `RuleMatch`; `api/routes_rules.py` (`:209-760` is the current surface; the preview at `:732` can dry-run a Sigma rule against recent logs).
- **Dependency decision:** PyYAML 6.0.3 is already installed transitively by `langchain-core`; pin it explicitly. pySigma is LGPL-2.1, which is acceptable as an optional extra, but an own evaluator avoids shipping it. The `pySigma-pipeline-ocsf` package (SigmaHQ) shows a logsource-to-OCSF mapping exists; its maturity was not verified.
- **Licensing of content:** SigmaHQ rules are under DRL 1.1. Do not bundle the rule set; import from the operator's copy, with attribution kept in the rule metadata.
- **Effort:** L. **Value:** high (the community expects it).
- **Risks:**
  - ReDoS through `re`: compile with length and time bounds, or support a safe subset only.
  - Field-name mismatch: Sigma fields are log-native, so imported rules need the source's field mapping.
  - Rule volume per event (R6).
  - #3 holds: rules classify and correlate, never decide.
- **Tests:** a golden set of public Sigma test cases (spec examples); every unsupported construct rejected with a reason; a per-event cost benchmark at 3,000 rules (the SigmaHQ rule count is unverified; one fork claims more than 3,000).
- **Round 16:** no; Round 17 candidate.

### R15. A genuinely free AI path: local model preset

- **What:**
  - An optional `local-llm` Compose profile that runs Ollama.
  - A backend `POST /api/llm/presets/local` (fresh sign-in, audited) that registers a router model, an investigator model and an embedding model as custom models. The store and routes exist (`stores/custom_models.py`, `api/routes_models.py:672-790`). It runs the existing empirical embedding probe (`api/routes_models.py:292`).
  - Make the investigator budget-aware: when the role's model declares a `context_window`, scale `max_events` and the per-event evidence budget down (`agents/prompts.py:491`, `evidence_fields.py:134`) and trim the ReAct history (BG7).
- **Effort:** M. **Value:** high for "absolutely free"; there is no per-call cost.
- **Risks:**
  - Ollama's OpenAI compatibility is documented as experimental, and tool-call output from weaker models can be malformed. Parse defensively; on failure route to NEEDS_HUMAN, as today.
  - Small models give weaker verdicts. Present this honestly in the wizard, and keep auto-close conservative under a local profile; the policy stays the operator's (#3).
  - Image size and GPU requirements are operator-owned.
- **Tests:** with a mock OpenAI-compatible server, the preset registers models and the readiness check (`llm/readiness.py`) reports ready; prompt-budget tests at 8k, 16k and 32k windows; malformed tool output is routed safely.
- **Round 16:** partial. The context-window fix (S to M) fits; the Compose profile and the preset fit Round 17.

### R16. Observability export without new mandatory dependencies

- **What:**
  1. `GET /api/health/metrics` in Prometheus text format, behind a bearer token or `diagnostics` permission. It exposes poll lag per source, receiver restarts, deferred-candidate count, investigations per hour, LLM spend today, job queue depth, SSE subscribers and loop lag (R5).
  2. `LOG_FORMAT=json` in `logging_setup.py:8-12`, which today is a plain format string.
  3. Optional OpenTelemetry, lazily imported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (an extra in the `full` image), with spans around poll, correlate, investigate, gateway call and the store calls.
- **Effort:** S for layers 1 and 2, M for layer 3. **Value:** medium to high for operators.
- **Risks:**
  - Metric cardinality: never label by entity or case id.
  - The exporter must not leak secrets or log values (#9).
  - OpenTelemetry adds packages; keep it out of the `core` image.
- **Tests:** an exposition format test; label allowlist; JSON log lines parse; with OTEL unset, nothing is imported.
- **Round 16:** layers 1 and 2 optional; layer 3 later.

### R17. One-command backup and restore for the PostgreSQL profile

- **What:** `scripts/agentic-soc-compose.sh backup` and `restore`. Reuse the updater's proven approach (`updater/agentic_soc_updater/runtime.py:888-916`: `pg_dump --format=custom`, then a `pg_restore --list` verification), with a retention count. Document a quarterly restore drill and add a restore test to the PostgreSQL CI lane.
- **Effort:** S to M. **Value:** high. "Portable export is not backup" is a stated limitation.
- **Risks:**
  - Secrets entered in the UI live in memory only and are not in the dump (known limitation); say so in the output.
  - Respect the lifecycle lock: the script already refuses mutating commands during an update job.
- **Tests:** the script lane (ShellCheck); a backup-then-restore round trip in CI.
- **Round 16:** optional. Independent of the code changes.

### R18. Versioned SQL migrations (decision)

- **What:** introduce Alembic, or a small in-house ordered migration ledger in KV, before any schema change. Unlocks: a `vector(dim)` column with an HNSW index (R1 phase 2), a partial unique index on open signatures (R12), PostgreSQL time partitioning for audit and usage (storage lifecycle), and generated columns for the queue filters (R3 phase 2).
- **Effort:** M to L. **Value:** high long term.
- **Risks:** a new backend dependency needs a deliberate decision (#12 cold-deploy); rollback paths (the updater's frozen protocol) must stay compatible.
- **Round 16:** no; decide in Round 16, build in Round 17.

### R19. Smaller items worth tracking

- **Jobs registry is one strict-CAS document** (up to 1,000 jobs and 8 MiB of parameters, `stores/jobs.py:40-42`), rewritten on every transition and lease renewal. Fine today; measure before bulk-heavy features grow it.
- **API keys** (ROADMAP B-2): scoped, revocable, prefix plus last-used, on the existing session and token model. M effort. High value for a free platform people integrate with.
- **OCSF 1.4 to 1.8 bump** (ROADMAP A): low urgency.
- **Storage growth telemetry**: report row counts and bytes per StateStore family in the storage lifecycle preview, because deletion stays off by design.

## 5. Suggested Round 16 backend package

These fit next to the operator's asks with low risk to #3, #6, #7, #9 and #12:

1. R1 native or cached vector search (M)
2. R2 layers 1 and 3: all-time TTL with stale-while-revalidate, and a slower `getMetrics` on LIVE (S)
3. R3 projection on SQL `scan_page` (M)
4. R4 ledger memo and single load (S)
5. R5 loop-lag gauge (S)
6. R7 investigation frames and active snapshot (S to M), for the "AI is investigating" ask
7. R8 risk explanation stored at scoring time (S to M), for the "explain 81" ask
8. R9 release-notes manifest and per-user seen marker (S), for the What's new ask
9. Stretch: R10 (ack before investigating), BG7 context-window budget, R16 layers 1 and 2

Gates for each item: `pytest -q` green; `decide()` and `engine/risk.py` byte-identical; parity tests across the ES fake, SQLite and the PostgreSQL lane; no new runtime dependency (numpy is already present through `pgvector`).

## 6. Sources (external claims)

- pgvector text input and operators: https://sources.debian.org/src/pgvector/0.8.2-1/README.md , https://neon.tech/docs/extensions/pgvector ; whitespace handling in the parser, read from the source: https://raw.githubusercontent.com/pgvector/pgvector/master/src/vector.c
- Sigma correlation types and keys: https://sigmahq.io/docs/meta/correlations.html
- pySigma licence (LGPL-2.1): https://github.com/SigmaHQ/pySigma/wiki , https://libraries.io/pypi/pysigma-backend-splunk/0.3.3
- pySigma OCSF pipeline (exists; details not verified, the page did not load): https://pypi.org/project/pysigma-pipeline-ocsf/
- SigmaHQ rules licence (DRL 1.1): https://github.com/sigmahq/sigma (the rule count is unverified)
- Splunk export endpoint: https://help.splunk.com/en/splunk-cloud-platform/search/search-manual/10.3.2512/export-search-results/export-data-using-the-splunk-rest-api , https://help-preview.splunk.com/en/splunk-enterprise/leverage-rest-apis/rest-api-tutorials/10.2/rest-api-tutorials/creating-searches-using-the-rest-api
- Log Analytics query API: https://learn.microsoft.com/azure/azure-monitor/logs/api/overview , https://learn.microsoft.com/en-us/AZURE/AZURE-MONITOR/logs/api/access-api , client-credential caveat: https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/timeouts
- Microsoft Graph alerts_v2: https://learn.microsoft.com/graph/api/security-list-alerts_v2 , https://learn.microsoft.com/graph/alertsv1-alertsv2-migration ; subset report (community, unverified): https://learn.microsoft.com/en-us/answers/questions/1367946/legacy-and-v2-list-alerts-endpoints-return-differe
- CrowdStrike Alerts API: https://developer.crowdstrike.com/api-reference/collections/alerts/ , https://github.com/CrowdStrike/falconpy/wiki/Alerts (the exact combined-alerts path is not verified)
- OpenTelemetry with FastAPI: https://fastapi.tiangolo.com/advanced/opentelemetry/ ; exporter variables (secondary): https://oneuptime.com/integrations/opentelemetry/fastapi
- Ollama OpenAI compatibility (marked experimental): https://docs.ollama.com/api/openai-compatibility
- Landscape (secondary sources, unverified): Tracecat AGPL core with paid enterprise features: https://dev.co/observability/open-source/tracecat ; TheHive licensing reported inconsistently: https://aimultiple.com/open-source-soar

## 7. Journal entry (for the orchestrator to append)

```
### 2026-11-24 - research agent (backend-roadmap) - Round 16 backend and platform research
- Context: Round 16 discovery; backend hot spots, multi-replica, connectors, Sigma, local models, observability, backups.
- Did: read ROADMAP (A to J), AGNOSTIC_ARCHITECTURE, known-limitations and the backend; ran offline SQLite benchmarks (20,000 demo cases; 2,000 RAG chunks of 1,536 dimensions). Found: pgvector unused on PostgreSQL (vector search scans every row in Python, 1.2 to 1.5 s per query at 2,000 chunks; a numpy cache answers in 0.2 ms); LIVE Overview reloads the all-time population every 5 s (2.5 to 3.0 s, 714 MB peak, 356 ms loop stalls at 20,000 cases); SQL scan_page ignores the Case Manager projection (0.65 to 2.5 s per filtered view); HTTP push holds the request through inline investigations; the review ledger is decoded per case open; investigation frames are per-case only; risk inputs and weights are not stored.
- Tests: none changed; benchmarks only (scripts in the scratchpad bench folder).
- Status: done (report backend-roadmap.md).
- Next: SPEC candidates R1, R2, R3, R4, R5, R7, R8, R9 for Round 16; R10 and the BG7 context-window budget as stretch; R11 to R18 to Round 17 and later.
```
