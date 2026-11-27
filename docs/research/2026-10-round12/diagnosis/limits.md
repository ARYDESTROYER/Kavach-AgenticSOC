# D1 — Every limit/truncation that can make a chat answer partial (diagnosis only)

Repo: `/home/user/Kavach-AgenticSOC` @ `Testing`. No repo file was modified.
Live checks: demo backend `:8088` (`GET /api/chat/context`, two `POST /api/chat/stream` turns).

Operator ask: chat is an explicit exception — **no token/step limits, no truncation, no
"Continue where this stopped"**, full-population answers (lifetime / 90 days / custom,
month/week/day grouping). Must keep #6 (one gateway + ledger), #7 (aggregates-only to the
model), #9 (fencing), and fit the model context window (compaction instead of hard caps).

---

## 0. What produced the operator's screenshots (root causes)

| Screenshot symptom | Root cause (file:line) |
|---|---|
| 1/3: "metrics were capped to 30 days" although 90 asked | `chat_tools/common.py:158` `MAX_WINDOW_HOURS = 720`; `chat_tools/metrics.py:136-158` `metric_window` caps every soc_metrics/cost_usage span at 720 h; `SocMetricsInput.window_hours le=720` (`metrics.py:178`; CostUsageInput `:834`) |
| 1/2/3: "store contained 6,438 cases but only 5,000 were fetched" / "dataset truncated" | `chat_tools/cases.py:54` `CASE_SCAN_LIMIT = 5_000` → `api/metrics_shared.py:124` `store.list(limit=5000)` newest-first page; every soc_metrics kind + memory-filtered search_cases runs over that page only |
| 1: "253 open now … lower bound because older open cases were not fully counted" | `chat_tools/metrics.py:345-352` (`:349`) `open_now.complete = load_ok and not truncated` — open_case_count runs over the 5,000 page (`engine/metrics.py:964-974`) |
| 2: "SLA attainment was 0% because no cases were evaluated" | bug: `engine/metrics.py:847` returns `0.0` (not `null`) when `evaluated == 0` |
| 3: "Partial · 12 lookups · 30.8k tokens" + "Continue where this stopped (≈ +4.4k tokens)" | `cap` notice: `agents/chat.py:1292-1298` (token ceiling) / `:1535-1537` (tool cap) / `:1339-1347` (call cap) → `chat.py:2055-2056` → `webui/src/soc/chat/message/Message.tsx:365-377` (chip) + `:85-93` (`Partial` word) |
| 1: "lifetime performance" → "Not something this assistant can do" (unsupported) | no tool can express lifetime: `soc_metrics` always windows (default 24 h, max 720 h), `resolve_window` caps at 90 d (`common.py:281-283`); prompt rule `prompts.py:823,855-857` tells the model to set `unsupported:true` when no lookup covers the ask |
| 4: "open cases … month wise" → unsupported + KPI "Still open ≥… in the returned …" | no group-by-created-month tool exists; `search_cases` with `status_group=active` takes the native path (`cases.py:259-273`) returning ≤ `limit` (≤ 50, `cases.py:108`) rows, `breakdown_cases=None` (`:273`), so "Still open" is computed over the returned page and flagged `bound` with context "in the returned page" (`cases.py:312-315`) |
| (live demo) "Create a report of lifetime performance" → "I can't change that from chat: the assistant is read-only" | demo planner (`engine/demo_chat.py`) classifies "Create …" as a mutation request — demo-only routing miss, separate from limits |

Live `/api/chat/context` (demo): `turn_token_ceiling 60000`, `final_max_tokens 4000`,
`observation_chars 6000`, `max_model_calls 5`, `max_tool_calls 10`, `turn_timeout_s 90`,
`context_window 1,050,000` (default chat model `gpt-5.6-luna`, registry `max_output 128,000`,
`llm/model_registry.json`). The hard caps use **< 6 %** of the model's context and **3 %** of its
output capacity.

---

## 1. Inventory

Legend — **Class**: L = loop/step limit, T = token/char limit, W = time window, P = population
(sampling/paging), R = row/top-N presentation, S = storage, U = UI. **Keep?**: what to do for chat.

### 1A. Agent loop budgets (`backend/app/agents/chat.py`, `config.py` ChatAgentConfig)

| ID | file:line | Trigger | User-visible symptom | Proposal |
|---|---|---|---|---|
| L1 | `config.py:1551-1554` `max_model_calls=5 (1..12)`; enforced `chat.py:1382` (`_must_finish` "calls"), `:1136` (`max_model_calls>1` gates tools), `:1341,1356` (corrective only while calls remain) | 4th model call → final-only | "Partial", Continue chip, answer from incomplete lookups | Chat-unbounded mode: `max_model_calls=None` = no cap. Loop ends only on `final`, Stop, provider failure, or the **no-progress guard** (same tool+input repeated N times / 3 consecutive invalid replies → final-only). Keep a hard *safety* fuse (e.g. 200 steps) that is not user-facing and audited |
| L2 | `config.py:1555-1557` `max_tool_calls=10 (1..40)`; `chat.py:1384`, `:1535-1537` (`_SKIPPED_CAP` "Lookup limit for this question reached"), legacy `:1836-1845` | 11th lookup skipped, `cap_hit` | run-log row "Lookup limit … reached", `cap` notice | None = unlimited; duplicate-call memo (return cached outcome for identical `(tool, canonical input)` within the turn) prevents loops cheaply |
| L3 | `config.py:1558-1560` `max_parallel=4 (1..8)`; `chat.py:1530` `_SKIPPED_PARALLEL` | 5th call in one batch skipped | "Too many lookups in one step" | Do not skip: **queue** extra calls into the same batch with a concurrency semaphore of `max_parallel` (it becomes a concurrency knob, never a refusal) |
| L4 | `chat.py:1524` `if self.ordinal >= 999: break` | >999 calls in a turn | calls silently dropped | Raise with unbounded mode; ordinal also bounded by regexes (see S8) |
| L5 | `config.py:1568-1571` `turn_timeout_s=90 (10..600)`; `chat.py:1285-1291`, `:1332-1339` | wall clock passes 90 s | "Stopped at the time limit; this shows what was found so far." (`chat_protocol.py:898`), `Partial` | Remove for chat (only Stop/cancel ends a turn). Long turns need: progress events (already streamed), the **lease heartbeat** (R2) and the client recovery window (U6) to stop deriving from `turn_timeout_s` |
| L6 | `config.py:1565-1567` `model_step_timeout_s=30 (5..300)`; `chat.py:1428` `asyncio.wait_for(call, timeout=…)` | one model call > 30 s (a long final answer will exceed this once output caps go) | `timeout` notice / `partial` | Replace total-duration timeout with an **inactivity timeout** on the stream (no token/heartbeat for e.g. 120 s) + a generous absolute fuse (e.g. 30 min). Non-streaming providers: absolute fuse only |
| L7 | `config.py:1561-1564` `tool_timeout_s=15 (1..120)`; `chat.py:1674`, `:1878`; `chat_tools/registry.py:311-334` | slow lookup (full-population scan of a large store, multi-source log fan-out) | "Lookup timed out after 15 s" | Per-tool timeout default raised for aggregate tools (scan tools 300 s) and made a *progress* timeout for streaming scans (scan emits page progress → `step.progress` event); keep per-source fan-out timeouts but report partial sources (already) |
| T1 | `config.py:1572-1575` `turn_token_ceiling=60_000`; `chat.py:1386-1388` (`_must_finish` "ceiling"), `:1298` sets `cap_hit` | cumulative + projected + reserve > 60k | `cap` notice, Continue chip (screenshot 3) | Delete the ceiling for chat. Replace with **context-window management** (§2.2): before each step, if `estimate(messages) + max_out > 0.8 × context_window`, compact older observations/history; never stop |
| T2 | `config.py:1576-1579` `final_reserve_tokens=12_000`; `_coherent` `:1690-1691` | part of T1 | — | Remove with T1 (compaction reserves headroom instead) |
| T3 | `config.py:1584-1587` `final_max_tokens=4_000 (256..32_000)`; `chat.py:1130`; `config.py:3523-3525` `chat_model.max_tokens=1500` | answer > 4k tokens | `length` notice "Answer cut at the output limit" (`chat_protocol.py:897`, `chat.py:2057-2058`) | `max_tokens` = model's **registry `max_output`** (128k for the default; `_context_window` sibling helper in `chat.py:409-416` already reads the registry). Anthropic requires a value, so "unlimited" = provider maximum. Plus **auto-continuation**: on `finish_reason == "length"` the engine appends the partial answer as the assistant turn and asks "continue exactly where you stopped", stitches text, repeats until `stop` — never surfaces `length` |
| T4 | `chat.py:167` `_MAX_ECHO_CHARS = 4_000`; `:1393` (`_echo`), `:1759`, `:1835` | model's own tool request / invalid reply > 4k chars | model loses its own plan → repeated lookups | Echo verbatim (it is the model's own text, neutralised) |
| T5 | `config.py:1580-1583` `observation_chars=6_000`; `chat_protocol.py:660-662` `observation_budget` (÷ calls, 1,500 floor); `chat.py:1762,1779,1798`; `shrink_observation` `chat_protocol.py:822-885` (halves ranked lists, drops `sample_rows`, oldest series points; last resort `"Observation omitted: too large for one prompt"`) | any tool result > 6,000/n chars (4 parallel calls → 1,500 chars each) | model sees top-N halves, `_shrunk_for_prompt`, writes "data was partial", or cannot answer | Send the **whole** observation (#7 still holds — observations are tool-built aggregates, never raw rows). Only when the *prompt* would exceed the context budget, compaction (§2.2) summarises the **oldest** observations first; current-step observations stay whole |
| T6 | `prompts.py:51` `_FENCE_BLOCK_MAX_CHARS = 16000`; `prompts.py:333-338` cuts `body[:max_chars-1]+"…"` | any fenced payload > 16k chars (an unshrunk observation, a long prior answer in replay `chat_protocol.py:625`, case seed) | silently cut mid-JSON (invalid JSON to the model) | For chat pass `max_chars=None` (keep the #9 marker scrub; the size bound moves to compaction). Never cut JSON mid-structure |
| T7 | `prompts.py:253` `fence()` → `truncate(text, 600)`; used by `chat.py` `_render_context` (`chat.py:2280-2294`) and compatibility-mode RAG | on-screen context JSON > 600 chars | model loses the selection/query defaults | Use `fence_block` for the screen context (same #9 treatment, no 600 cut) |
| T8 | `prompts.py:55-56` `_MEMORY_MAX_ENTRIES=20`, `_MEMORY_MAX_CHARS=2000` | > 20 approved memory facts | later facts invisible | Raise for chat (all approved entries); compaction can drop memory last |
| T9 | `chat_protocol.py:64` `MAX_TOOL_INPUT_CHARS = 4_000` → `INPUT_TOO_LARGE` refusal | model-chosen tool input > 4k | lookup refused | Keep a bound but raise (64k): this guards tools/audit rows from runaway model output, not answer completeness |
| T10 | `chat.py:768` seed `evidence[:5]`; `chat.py:807` RAG `truncate(c.text, 400)`; `chat.py:137` `_RAG_TOP_K=3` (compat mode) | case-scoped chat | model sees 5 evidence summaries only | Seed all evidence summaries (they are summaries, #7-safe), compaction-managed |

### 1B. History replay / continue

| ID | file:line | Trigger | Symptom | Proposal |
|---|---|---|---|---|
| H1 | `chat_events.py:126-127` `HISTORY_MAX_EXCHANGES=12`, `HISTORY_MAX_CHARS=24_000`; `chat_protocol.py:529-544` `select_replay` (oldest dropped first); used `chat.py:1139`, `routes_chat.py:1308-1327` | > 12 exchanges or > 24k chars of history | model forgets earlier turns ("as I said before" fails), `mK.bJ` refs to dropped turns invalid | Replay **all** exchanges; when over the context budget, replace the oldest exchanges with a **rolling conversation summary** (§2.2) stored on the conversation (`summary_json`, CAS-updated) so it is computed once, not per turn |
| H2 | `chat_events.py:128` `HISTORY_DIGEST_MAX_CHARS=600`; `chat_protocol.py:555-576` `lookup_digest` (summary `display_text(…,160)`) | prior turn with many lookups | model cannot reuse earlier lookups | Full digest; compaction handles size |
| H3 | `chat_protocol.py:579-594` `block_listing(limit=12)` | > 12 data blocks in a prior answer | later blocks not re-viewable | No limit |
| H4 | `webui/src/soc/chat/useChatEngine.ts:85,246-253,265-282` `CHAT_HISTORY_EXCHANGES=12`, `CHAT_HISTORY_MAX_CHARS=24_000` (client mirror for stateless/case composer + meter) | same | meter and client history disagree once server is unbounded | Mirror server: send all; take the bound from `/chat/context` |
| H5 | `chat.py:1241-1247` continue note; `ChatRequest.continue_of` (`models.py:2522`); `useChatEngine.ts:87` `CONTINUE_PROMPT`, `continueAnswer` (`:642-643`) | `cap` notice | separate billed "continue" turn the user must click | Becomes dead path once L1/L2/T1/T3 are gone; keep wire field for compat (old rows), stop offering it |

### 1C. Tool population/window/top-N limits (`backend/app/agents/chat_tools/*`)

| ID | file:line | Trigger | Symptom | Proposal |
|---|---|---|---|---|
| P1 | `cases.py:54` `CASE_SCAN_LIMIT = 5_000`; `cases.py:67-80` `load_case_page`; `api/metrics_shared.py:91-144` (`store.list(limit)` newest-first, 5 s cache) | store > 5,000 cases | every soc_metrics kind: `truncated`, `basis: sample`, `newest 5,000 of N cases read`, open-now lower bound, `window_covered=false` for long windows | Replace with full-population aggregation (§3): push-down aggregates + streaming scan fold. No page cap |
| P2 | `metrics.py` (tool) `:178`, `:834` `window_hours le=720`; `metrics.py:136-158` `metric_window` (`capped`, note "figures cover the 30 days ending at its end") | any window > 30 d, any "lifetime" | screenshot 1 "capped to 30 days"; lifetime → unsupported | Accept `window: "all_time"` and absolute `time_from/time_to` of any length; engine functions get `start`/`end` instants instead of `window_hours` (see §3.4) |
| P3 | `common.py:156` `MAX_WINDOW_DAYS = 90`; `common.py:281-283` (start moved, `clamped=True`); `models.py:2238,2264` `TimeRange.MAX_SPAN_DAYS = 90` (422 for a chip > 90 d) | > 90-day request (tool or composer chip) | silently narrowed / 422 | Chat: no span cap; `all_time` sentinel (`time_from="*"`); composer chip gains "All time"/custom unlimited. Log tools may keep a per-source safety cap only where the backend cannot aggregate (state it as coverage, not a clamp) |
| P4 | `common.py:155` `_RELATIVE_RE now-(\d{1,5})` | — | fine | keep |
| P5 | `cases.py:108` `SearchCasesInput.limit le=50` (default 20); `cases.py:55` `_OBS_CASES=10` (rows to the model); `cases.py:56` `_CASE_LIST_MAX=25` (block rows) | > 25/50 matches | case list cut, "Still open … in the returned page", `bound` KPI (screenshot 4) | Counts/breakdowns always from an exact aggregate (§3) independent of `limit`; list rows paginated (artifact carries the full id list + server-side "View all" paging), model gets ≤ N rows **plus** exact counts/group-bys |
| P6 | `cases.py:105` `window_hours le=720` | > 30 d | 422-style input error to the model | lift with P2/P3 |
| P7 | `cases.py:259-273` native path: `breakdown_cases = page if count <= len(page) else None` → no by_verdict/by_status | count > limit | breakdowns omitted | exact `aggregate()` for by_status/by_verdict/by_month |
| P8 | `cases.py:246-258` memory-filter path (`text/verdict/severity/priority/assignee/rule`) over the 5,000 page; `exact = store_total <= scanned` | store > 5,000 | "lower bound; 5,000 newest cases scanned" | push verdict/assignee/rule/text to the store (ES term/match; SQL JSON extract), severity/priority (read-time derived) via streaming fold |
| P9 | `cases.py:442` get_case `evidence[:5]`, `:462` `mitre[:20]`, `:542` tool_calls `[:10]`, `:567` rules `[:5]`, `:581` related `[:5]`, `:598` status history `truncated=len>50` | big case | evidence/timeline cut | All items to the artifact; model observation keeps all evidence summaries (#7: summaries not raw logs) |
| P10 | `cases.py:624-625` shift_report `window_hours le=168`, `attention_limit le=25`; `:693` `min(168, …)`; `:725,732,738,743,780` `[:limit]`/`[:5]`/`[:10]`/`[:25]` | > 7 d shift / > 25 queue | queue truncated | lift; queue fully listed in the artifact, full counts to the model |
| P11 | `cases.py:803` list_campaigns `limit le=25`; `:848-850,865` `[:5]`/`[:3]` | > 25 campaigns | truncated | lift / paginate |
| P12 | `metrics.py:680-690` mitre_coverage `ranked[:60]` (artifact), `[:15]` (observation) | > 60 techniques | cut | lift |
| P13 | `metrics.py:737,745,752` agent_improvement `records_strict(limit=5000)` usage, tuning `[:1000]`; `stores/usage.py:87-89` caps 5000 | ledger > 5,000 rows | `usage_records_truncated`, insufficient evidence | push-down aggregation (usage already has an exact `summary` aggregation, `stores/usage.py:136+`) |
| P14 | `metrics.py:843-848` `_top_rows(n=5)` cost by role/model/surface; `metrics.py:879-887` cost_usage refuses non-trailing windows; window via `metric_window` (720 h cap) | > 5 models; past/90-day range | top-5 only; "can only be read for a window that ends now" | all rows; `usage.summary(start,end)` with absolute bounds |
| P15 | `metrics.py:759` agent_improvement `list(metrics.items())[:8]` | > 8 metrics | cut | lift |
| P16 | `logs.py:78-81` `_SAMPLE_ROWS=5`, `_TOP_FACETS=5`, `_STATS_SAMPLE=200`, `_MAX_SERIES_POINTS=200`; `:82-83` heatmap 48×10; `:87` `ES_TOTAL_CAP=10_000` (recount via size:0 exists `:605-627`); `:123` search `size le=200`; `:138-139` group_by ≤3, `top_n le=20`; fallback sample path `:911,949` | non-aggregating source / big result | `basis newest_n`, "newest 200 sampled", top values lower bounds | **#7 boundary — keep sample rows ≤ 5 to the model.** Lift `top_n` (≤ 1,000 via `composite`/terms `size`) and the group_by count; series points via adaptive interval (no cap, downsample only for display). Non-aggregating push sources: stream the ring fully (they are bounded rings anyway) instead of 200 |
| P17 | `ops.py:529-531` audit_search `_AUDIT_READ_LIMIT=500`, `_AUDIT_OBS_ROWS=10`, `:543` `limit le=100`, `:615-617` `most_common(15/10/10)`, `:639` timeline `[:50]` | > 500 audit rows in window | "newest 500 rows", counts over the 500 only | exact `aggregate` on audit (ES terms/composite on `action_type`/`actor`/`surface`; SQL GROUP BY on `AuditRow.action_type` + JSON extract) and `count` |
| P18 | `ops.py:137,153,161` sources `projected[:30]`/`[:200]`/`[:20]`; `ops.py:192` automation `limit le=50`, `:414,504` `[:10]` | many sources/rules | cut | lift |
| P19 | `intel.py:441` search_knowledge `top_k le=8`, chunk `text(body, 600)` (`:571`), `chat.py:150` `_KNOWLEDGE_TRUSTED_CHARS=600`; `intel.py:322` mitre_lookup `limit le=20`; `intel.py:233,244` reputation rows `[:12]`; `app_help.py:47-49` `MAX_TOP_K=6` | long runbook chunk | chunk cut at 600 chars | send whole chunk (chunks are already chunker-bounded); raise top_k |
| P20 | `common.py:99` `MAX_CITATIONS_PER_CALL = 9`; `chat.py:171` `_MAX_CITATIONS=40`; `models.py:2073` | > 9 hits per call | citation ids collapse to index 9 (`common.py:109`) | widen id grammar (S8) and lift |
| P21 | `taint.py` / `config.py:1594-1600` `max_indicator_lookups=3` per turn, `10` per conversation | > 3 third-party lookups | "Indicator lookup limit reached" | **Recommend KEEP** (egress/privacy and third-party quota control, §4.8 / #9 spirit) but default configurable to unlimited if the operator insists; it never truncates internal data. Flag for operator decision |

### 1D. Engine / store population limits behind the tools

| ID | file:line | Trigger | Symptom | Proposal |
|---|---|---|---|---|
| E1 | `api/metrics_shared.py:124` `store.list(limit=limit)` (ES `from/size` — `stores/cases.py:133-141`) | limit > 10,000 on ES | would 400 (`index.max_result_window`) — so simply raising 5,000 is NOT a fix | use `export_page` PIT/search_after (`stores/cases.py:266-315`) or aggregations |
| E2 | `routes_metrics.py:65`, `routes_diagnostics.py:86` `_STORE_FETCH_LIMIT = 5000` (dashboards; same page cache) | same as P1 | dashboard tiles share the truncation; chat promises "never disagree" (`metrics.py:5-7`) | move the dashboard rollups to the same aggregator (§3) so parity holds |
| E3 | `engine/metrics.py:1240-1260` `trend_metrics` clamps `window_hours` to [1,720]; buckets ≤ 1 day (`_trend_bucket_minutes` `:1230-1237`) | > 30 d / month grouping | no week/month buckets | add calendar buckets `1w`, `1M` (UTC, ISO week) |
| E4 | `engine/metrics.py:906-920` `truncation_marker`, `:977-1063` `_window_coverage` | page < store | honesty flags `truncated`, `window_covered=false` | stay as honesty flags, but become always-false once full scans exist |
| E5 | `engine/metrics.py:847` `attainment_pct … if evaluated else 0.0`; `:848` `breaching[:25]` | 0 SLA-scorable cases (e.g. `priority_level` unset) | "SLA attainment was 0%" (screenshot 2) — **wrong** | return `None` + reason; breaching list unbounded in artifact |
| E6 | `stores/base.py:230` `WINDOW_FALLBACK_SCAN = 10000`; `:433-440` third-party `list_window` fallback; `:370` `count_created_since` `list(limit=10000)` | third-party repo, > 10k | lower bound | fallback via `export_page` loop (already a non-abstract method `:445`) |
| E7 | `stores/sql/repositories.py` has no `export_page` override for cases (base offset fallback `stores/base.py:445-470`) | SQL full scan | OFFSET paging O(n²) | add keyset `export_page` on `(created_at, case_id)` |
| E8 | `es/fake.py:611-617` `_interval_to_ms`: `"1M"`/`"month"`/`"week"` → ValueError → silently **1 h** buckets; `:566-577` `terms size` default 10; no `composite`, no `min/max/avg/percentiles` aggs | month/week date_histogram or composite on the in-memory backend (Demo Mode, no-ES installs) | wrong buckets on fake | implement calendar intervals (`month`, `week`, `day`, `1M`, `1w`, `1d`) + `composite` (with `after`) + `missing_bucket` in the fake, or route the in-memory store to the Python fold (§3.3) |

### 1E. Persistence / presentation truncation

| ID | file:line | Trigger | Symptom | Proposal |
|---|---|---|---|---|
| S1 | `stores/chat_conversations.py:107` `MAX_ASSISTANT_MESSAGE_CHARS=24_000`, `:106` user 12,000; `_clip` `:1325-1328` | long answer/report | reload shows a clipped answer + "Trimmed to fit storage" | store full text; move each assistant presentation to its **own KV record** (`chatmsg:{id}` opaque JSON) so the per-user partition stays small; raise per-message cap to ≥ 1 MB (ES doc limit is ~100 MB, Postgres JSON unbounded) |
| S2 | `chat_conversations.py:122` `MAX_PRESENTATION_BYTES=16_384` (blocks expired, steps stripped `:403-460`); `blocks.py:121-123` `STORED_TABLE_ROWS=25`, `STORED_SERIES_POINTS=100`, `STORED_QUERY_CHARS=1_000` | any rich answer | restored answers lose tables/charts → `answer-trimmed-hint` (`Message.tsx:176,406-412`) | lift with per-message records |
| S3 | `chat_conversations.py:104-105` `MAX_MESSAGES_PER_CONVERSATION=100`, `MAX_CONVERSATION_BYTES=256_000`; `_trim_messages` `:619+`; `:103` `MAX_CONVERSATIONS_PER_USER=50` | long conversation | oldest exchanges dropped from the transcript (and so from replay) | messages in per-message records; conversation doc holds ids + rolling summary; caps become retention policy, not 100 |
| S4 | `models.py:2072` `_MAX_STEPS=64` (`:2154-2160` drops low-rank steps) ; `:2068-2069` params 12 / sources 20; summaries 600 (`:2062`) | > 64 steps | run log incomplete | lift / store run-log in the per-message record |
| S5 | `blocks.py:77-118` live caps: 12 blocks/message, report 12 sections/40 leaves, 48 kB serialized, 8 series, 200 points, donut 6, table 12 cols × 200 rows, case_list 25, timeline 50, KPI 6, MITRE 60, markdown 12,000, callout 600; `prompts.py:813` "At most 12 blocks"; `chat.py:2098` | big report | trailing blocks dropped, rows cut, "+N more" | presentation: raise blocks/leaves (e.g. 50/200), tables virtualised with server-side paging of the artifact (full rows retrievable via `GET /api/chat/artifacts/{turn}/{ref}?page=`), markdown 200k. Keep donut/series *visual* limits but fold the remainder into "Other" with the exact total (already done for series) |
| S6 | `chat.py:135` `_TABLE_PREVIEW=50` (legacy table), `:2246-2247` | legacy clients | — | keep (compat only) |
| S7 | `chat.py:169` `_MAX_CASE_MESSAGE=8_000` (case-thread copy) | long case-scoped answer | case thread copy cut | raise to the case-thread store's own bound |
| S8 | id grammars: `models.py:2086` `^[A-Z][0-9]{1,3}$` citations; `common.py:94` `call_ordinal` 1..99 (citation ids fall back to un-ordinal'd `K1` above 99 → collisions); `blocks.py:1920-1921` `t[1-9][0-9]{0,2}` / `m…` refs; `chat_events.py:151-158` header regex; `chat_tools/base.py:453-454` ordinal 1..999 | > 99 calls / > 999 messages | refs collide / reject | widen to `{0,5}` digits everywhere in one change (server + `webui` `blocks/schema.ts` + `chat-stream-events.contract.json`) |
| S9 | `chat_protocol.py:1078-1080` report summary `MAX_EXECUTIVE_SUMMARY=1_200`, `MAX_NEXT_STEPS=5`, `MAX_NEXT_STEP_CHARS=300`; report 40 items (`chat-api.ts:827` `report_full`) | long report summary | cut | lift for chat reports |

### 1F. Budget gate (BudgetConfig) as it applies to chat

| ID | file:line | Trigger | Symptom | Proposal |
|---|---|---|---|---|
| B1 | `config.py:1524-1528` `enabled=True, daily_usd=10, on_exceed="block"`; `llm/gateway.py:1281-1310` `_budget_preflight` raises `BudgetBlocked` for **every role including chat**; `chat_protocol.py:892,941-942` `budget` notice | daily AI spend ≥ $10 (shared with investigations) | "The AI budget limit has been reached, so no answer was generated." `Failed` | Add `BudgetConfig.chat_on_exceed: Literal["warn","block"] = "warn"` (or `chat_exempt=True`): the gateway still runs the pre-flight and still writes the ledger row (#6), the chat turn proceeds with a `budget` *warning* event; investigations keep blocking (#10 backstop preserved). The pre-flight's projected cost uses `max_tokens`; with T3 = 128k the projection is large — compute the projection on `min(max_tokens, expected)` for the warn path |
| B2 | `webui/.../composer/BudgetAlert.tsx`, `format.ts:252-260` `budgetPausesAnswers`, `BudgetRing` (`TokenMeter.tsx`) | budget approaching/reached | amber/red banner "AI answers are paused" | With B1, chat banner becomes informational ("over budget; chat continues, investigations paused") |

### 1G. Routes / leases / concurrency (`backend/app/api/routes_chat.py`)

| ID | file:line | Trigger | Symptom | Proposal |
|---|---|---|---|---|
| R1 | `routes_chat.py:691-692` `max_concurrent_turns_per_user=2`, `_global=8` (`config.py:1588-1593`); 429 `chat_busy` | 3rd simultaneous question | "busy" | **Keep** (admission control, not truncation); optionally raise global |
| R2 | `routes_chat.py:569-595` `turn_lease_seconds = turn_timeout + step + max(step, tool) + 120` | an unbounded turn outlives its idempotency lease | a retry could double-run / the reservation expires mid-turn | **heartbeat-renewed lease**: the turn task renews the reservation every 60 s while running (store already uses leases for jobs: `stores/jobs` 5 m renewable leases pattern) |
| R3 | `routes_chat.py:112` `CHARS_PER_TOKEN=4`; `:1405` `max_output_tokens = max(chat_model.max_tokens, final_max_tokens)` in `/chat/context` | — | meter shows 4,000 | report registry max_output / "model maximum" |

### 1H. Web UI (`webui/src/soc/chat/**`)

| ID | file:line | Symptom | Proposal |
|---|---|---|---|
| U1 | `message/Message.tsx:365-377` "Continue where this stopped (≈ +N tokens)" for `notice.kind==='cap'` | screenshot 3 | Remove the chip for new answers (no `cap` notices will be produced); keep rendering for legacy stored rows only behind `response.notice.kind==='cap' && item.restored` (or drop entirely) |
| U2 | `message/Message.tsx:85-93` `OUTCOME` maps `partial/timeout/cap → 'Partial'`; `message/MetaRow.tsx:31` | "Partial · 12 lookups" | `Partial` only for genuine failures (a lookup failed / source down), with the reason inline, never for budgets |
| U3 | `message/Message.tsx:176,406-412` `ANSWER_TRIMMED_HINT='Trimmed to fit storage'` | restored answers trimmed | disappears with S1-S3 |
| U4 | `composer/TokenMeter.tsx:10-11,193` "Per-question limit" row + "up to ≈ M"; `display.ts:163-177` `projectTurnMaxTokens` uses `max_model_calls/max_tool_calls/observation_chars/turn_token_ceiling`; `chat-api.ts:198-206` `DEFAULT_CHAT_BOUNDS` | meter advertises a 60k per-question limit | meter shows **context usage** (prompt estimate ÷ `context_window`, which the context endpoint already returns: `TokenMeter.tsx` `windowShare`) and turn spend so far; drop the projection/ceiling rows (or show "no per-question limit") |
| U5 | composer ring "0%" = `budgetMeterValue` (`composer/format.ts:233-243`) daily-budget share | confusing "0%" next to the estimate | ring = context-window fill of the next request (Claude/ChatGPT pattern); budget moves to the hover card |
| U6 | `useChatEngine.ts:97-115` `recoveryWindowMs = (turn_timeout_s + model_step_timeout_s)*1000 + slack` | an unbounded turn would be declared lost after ~2 min of a dropped stream | recovery polls `GET /chat/turns/{id}` status / the reservation heartbeat instead of a fixed window |
| U7 | `blocks/renderers/KpiGroupView.tsx:59-62` lower-bound `≥` + ellipsised context (screenshot 4 "≥…  in the returned …") | value column too narrow; bound KPIs | with exact aggregates `bound` disappears; independently fix KPI value/caption overflow (min-width, wrap caption) |
| U8 | `pages/settings/chat-agent.tsx:42-77,117-118` editor exposes ceilings | — | Settings → Chat assistant: replace numeric caps with "No limits (chat)" default + optional advanced safety fuses |

---

## 2. Proposal — "chat is the exception" without breaking the non-negotiables

### 2.1 Configuration shape (backward compatible)

- `ChatAgentConfig.limits_mode: Literal["unbounded","bounded"] = "unbounded"`. In
  `unbounded` the engine ignores `max_model_calls`, `max_tool_calls`, `turn_timeout_s`,
  `turn_token_ceiling`, `final_reserve_tokens`, `observation_chars`, `final_max_tokens`; the
  fields stay (stored configs keep validating; `_repair` untouched). `bounded` keeps today's
  behaviour byte-identical (tests pin it).
- Kept as hard **safety fuses** (never user-visible as a "limit", audited when tripped, and
  generous): `safety_max_steps=200`, `safety_turn_seconds=1800`, `stream_idle_timeout_s=120`,
  no-progress guard (identical call repeated 3×, 3 invalid replies in a row).
- `max_parallel` becomes a concurrency width (queue, never skip). Concurrency admission (R1)
  and indicator egress (P21) unchanged unless the operator decides otherwise.
- `max_tokens` per step = `registry.max_output(model)` (fallback 32k when unknown) — the
  provider maximum; `finish_reason == "length"` triggers **engine auto-continuation** (same
  turn, same gateway, each continuation a ledger row): append the partial text as the
  assistant message, user message "Continue exactly where you stopped; do not repeat", stitch,
  loop (fuse 8). The `length` notice is never emitted in unbounded mode.

### 2.2 Context-window management instead of hard caps (auto-compaction)

Budget = `context_window(model)` (registry; `chat.py:409-416`) minus `max_out` minus 10 %
margin. Before every model step:

1. `estimate_message_tokens(messages)` (chars/4, same arithmetic as the gateway) ≤ budget → send.
2. Else compact, oldest first, until it fits:
   a. Prior-turn observations already summarised in the replay digest → keep digest only.
   b. Current-turn observations older than the last 2 batches → replace with a **deterministic
      engine digest** (tool header line + `summary` + artifact manifest + top-level scalar
      counts) — no LLM needed, #7/#9 preserved (still fenced, still aggregates). The full
      observation remains referenceable by artifact ref (`tN.aK`) for blocks.
   c. Older history exchanges → **rolling conversation summary**: one extra gateway call
      (`Role.CHAT`, surface `chat_compaction`, metered in the ledger #6) over the fenced prior
      answers; the summary output is model-written → stored and replayed **inside the
      UNTRUSTED fence** (`source=conversation_summary`), never as trusted context (#9). Cached
      on the conversation (CAS) and extended incrementally.
   d. Only if a single current observation alone exceeds the budget: structural
      `shrink_observation` (existing, valid JSON) with an explicit coverage note — this is the
      only remaining shrink and it is context-driven, not a fixed 6,000.
3. Emit a `step.start`-style "Compacting earlier context" step so the UI shows it (no notice).

With a 1.05 M-token model this practically never fires; with small models (gpt-4o 128k,
local 8k) it is what keeps answers complete.

### 2.3 Non-negotiables preserved

| # | How |
|---|---|
| #6 | Every step, continuation and compaction call goes through `LLMGateway.complete` with `UsageReceipt` → ledger; meter and `turn.usage` unchanged; budget pre-flight still runs for chat (warn mode) |
| #7 | Tools still hand the model aggregates (counts, group-bys, top-N, ≤ 5 sample rows of the identity projection). Lifting `observation_chars` does not add raw rows — observation *builders* stay the gate. Full row tables remain artifacts the model never receives |
| #9 | All observations/history/summaries stay inside `fence_block` (marker scrub kept; only the 16k char cut is removed for chat). Compaction summaries are model output of fenced data → re-fenced. Screen context moves from `fence()` to `fence_block()` |
| #3/#5 | Read-only tools unchanged; one engine; nothing feeds `decide()` |
| #10 | Investigation budget backstop unchanged (block); chat turns warn only |

---

## 3. Full-population case aggregates (no sampling) for every state backend

### 3.1 Two mechanisms

1. **Push-down aggregate** (exact counts/group-bys on stored fields) —
   `CaseStore.aggregate(query: CaseAggQuery) -> CaseAggResult`, non-abstract default (§3.3) so
   third-party repos keep working.
   ```
   CaseAggQuery(
     created_from: str|None, created_to: str|None,        # None/None = lifetime
     status: str|None, status_group: "active"|"terminal"|None,
     verdict, entity_value, rule, assignee, source_surface, text,  # optional filters
     group_by: list["status"|"verdict"|"rule"|"assignee"|"entity_type"|"source_surface"
                    |"created:day"|"created:week"|"created:month"|"created:year"
                    |"updated:month"|"decision_by"|"disposition"],
     tz: "UTC",
   ) -> CaseAggResult(total:int, exact:bool, buckets:[{key:{…}, count:int}],
                      missing_created:int, min_created, max_created, consistency:str)
   ```
2. **Streaming scan fold** for metrics that need per-case Python logic (lifecycle MTTA/MTTR/
   dwell percentiles from `status_history`, SLA, severity/priority — read-time derived via
   `engine/priority`, quality/automation rates, MITRE, recorded auto-close): iterate the whole
   population page by page via `export_page` (already exists for ES PIT; add SQL keyset) and feed
   **accumulators** (`add(case)` / `result()`), never materialising all Case objects.
   Percentiles stay **exact**: keep only the float durations (8 B each; 1 M cases ≈ 8 MB) and
   reuse `engine/metrics.percentile`. Refactor `posture_metrics`/`quality_metrics`/
   `lifecycle_intervals`/`sla_metrics`/`trend_metrics`/`compute_metrics` into accumulator
   classes whose `result()` is byte-identical to today's function on the same input (golden
   tests run both on the same fixture).

### 3.2 Per backend

**Elasticsearch / OpenSearch (`stores/cases.py`, index `CASES_READ_PATTERN`, `created_at` is `date`, `status`/`verdict`/`rule_ids`/`entity.*`/`source_surface`/`decision_by` are `keyword` — `es/indices.py:25-73`; `assignee` dynamic → `assignee.keyword`)**
- Body: `{"size":0, "track_total_hits":true, "query":<same filter builder as list_window incl. the must_not never-drop complement>, "aggs":{"g":{"composite":{"size":1000,"sources":[{"created":{"date_histogram":{"field":"created_at","calendar_interval":"month","time_zone":"UTC","missing_bucket":true}}},{"status":{"terms":{"field":"status","missing_bucket":true}}}]}}, "min_c":{"min":{"field":"created_at"}}, "max_c":{"max":{"field":"created_at"}}}}`
- Page with `after_key` until exhausted → **no bucket truncation** (terms `size` limits avoided).
  `missing_bucket` keeps cases with no `created_at` (#4 never-drop) and reports them as
  `missing_created`.
- Consistency: open a state PIT (`open_state_pit`, `es/client.py:157`) and pass `pit` so all
  composite pages + the fold scan see one snapshot (`consistency="point_in_time"`); close after.
- Fold scan: `export_page` (`stores/cases.py:266-315`, `_shard_doc` + PIT, 1,000–5,000/page).
  `_source` filtering (`created_at, status, status_history, verdict, risk_score, priority_level,
  decision_by, disposition, mitre, rule_ids, entity, first_seen_millis, history`) cuts transfer.
- Never use `from/size` > 10,000 (E1).

**PostgreSQL + pgvector / SQLite (`stores/sql/repositories.py`, `CaseRow` columns `status`,
`created_at` (ISO string), `entity_value`, `source_surface`, `updated_at` + `doc` JSON; index
`ix_cases_status_created`)**
- Group by created period from the ISO string (stored `…Z` UTC per `_ISO_CREATED_AT_UTC_TAIL`):
  month `substr(created_at,1,7)`, day `substr(created_at,1,10)`, year `substr(…,1,4)` — portable
  across SQLite/Postgres and index-friendly; week: Postgres
  `to_char(created_at::timestamptz,'IYYY-"W"IW')`, SQLite `strftime('%G-W%V', created_at)` is not
  available in older SQLite → compute ISO week via `date(created_at, 'weekday 0', '-6 days')`
  (Monday) or fold in Python for week only.
- `SELECT <period>, status, count(*) FROM cases WHERE <filters> GROUP BY 1,2` — `status`
  uses the existing column/index; JSON fields (`verdict`, `assignee`, `rule_ids`, `decision_by`)
  via `doc->>'verdict'` (Postgres) / `json_extract(doc,'$.verdict')` (SQLite); `rule_ids` is an
  array → Postgres `jsonb_array_elements_text`, SQLite `json_each` (or fold).
- Unparseable/empty `created_at` → `CASE WHEN created_at LIKE '____-__-__T%' THEN … ELSE NULL`
  bucket = `missing_created` (#4).
- Fold scan: keyset `export_page` on `(created_at, case_id)`:
  `WHERE (created_at, case_id) > (:c, :id) ORDER BY created_at, case_id LIMIT :n` (E7); wrap in
  one `REPEATABLE READ` transaction on Postgres for a consistent snapshot; SQLite single read txn.
- Optional (later, additive, needs a migration — avoid now): generated columns for `verdict`,
  `assignee`. Not required: JSON extract + GROUP BY is exact.

**In-memory (`es/fake.py` `InMemoryESClient` — Demo Mode and no-key installs — and
`stores/base.py` default for third-party repos)**
- Base default `aggregate()`: loop `export_page` (non-abstract, `stores/base.py:445`) and fold
  in Python with the same bucket-key functions the ES/SQL paths use (shared
  `case_period_key(created_at, "month")`), so results are identical across backends. Exact,
  just slower.
- Fake ES: either (a) make `CaseStore.aggregate` detect `InMemoryESClient` and use the Python
  fold, or (b) teach the fake `calendar_interval` month/week/day, `composite` with `after`, and
  `missing_bucket` (E8). (a) is less code and avoids silently wrong 1-hour buckets.

### 3.3 Arbitrary windows

- Lifetime: `created_from=None, created_to=None` (`window: "all_time"`); label "all time
  (first case YYYY-MM-DD)" from `min_created`.
- 90 days / custom: absolute ISO instants, no span cap; label from the window as today.
- "Open cases by created month" = `status_group="active"`, no created window (open is a
  *stock*), `group_by=["created:month"]` — exact for every backend.
- Period-over-period compare: same query on the previous equal-length window.

### 3.4 Chat tool surface (new + changed)

- **New `case_stats`** (`cases:read`): `case_stats(group_by=[status|verdict|severity|priority|
  assignee|rule|entity_type|source|created:day|created:week|created:month|created:year],
  status?, status_group?, verdict?, severity?, priority?, assignee?, rule?, window?=all_time|
  last_Nd|{from,to}, metric?=count|avg_risk|mtta|mttr)` → exact `basis:"exact"` buckets, a
  `series`/`categories`/`table` artifact, `missing_created` disclosed. Severity/priority/MTTA/
  MTTR group-bys use the fold. Observation = buckets only (#7).
- `soc_metrics`: accept `window="all_time"` and `time_from/time_to` of any length; compute
  over the full population (fold) — drops `truncated`, `window_capped`, `newest N of M` notes;
  trend buckets gain `1w`/`1M` for long windows.
- `search_cases`: counts and breakdowns from `aggregate()` (always exact), rows still paged
  (`limit` default 20, but `total` exact and "View all" pages server-side).
- Prompt (`prompts.py:915`): replace "lookups default to the last 24 hours" with "default to
  the last 24 hours for logs; case and metric questions without a window mean all time" and add
  a line: "case_stats answers any grouping/count over all cases; never mark such a question
  unsupported".

### 3.5 Performance notes

- Dashboard parity (E2): move `routes_metrics`/`routes_diagnostics` to the same aggregator
  and keep the 5 s single-flight cache keyed by `(store, query)`.
- Scans are I/O bound: page size 2,000 with `_source` filter; 100k cases ≈ 50 pages.
  Emit tool progress (`step.progress` with pages/rows) so long scans are visible rather than
  timing out (L7).

---

## 4. Incidental defects found (not limits, but they produce wrong/partial answers)

1. `engine/metrics.py:847` SLA attainment `0.0` when nothing was evaluated (should be `None`
   + reason) — screenshot 2.
2. `es/fake.py:611-617` calendar `month`/`week` intervals silently become 1 h buckets.
3. `search_cases` "Still open" KPI computed over the returned page and rendered `≥…` with a
   clipped caption (`cases.py:312-315`, `KpiGroupView.tsx:59-62`) — screenshot 4.
4. Demo planner routes "Create a report of lifetime performance" to the read-only refusal
   (live check) — "Create" is a report request, not a mutation.
5. `metric_window` caption says "figures cover the 30 days ending at its end" while the model
   writes "last 720 hours (30 days)" — once P2 is lifted both go away.

---

## 5. Tests to add with the change (offline)

- Engine: unbounded mode never emits `cap`/`length`/`timeout` notices; auto-continuation
  stitches 3 `length` chunks into one answer with 3 ledger rows; no-progress guard trips on
  a repeated identical call; compaction triggers when `context_window` is tiny (mock registry
  entry 8k) and keeps current observations whole; compaction summary is fenced.
- `bounded` mode: existing chat tests byte-identical.
- Aggregates: same fixture (≥ 12,000 cases incl. empty/unparseable `created_at`) → identical
  `case_stats` buckets on ES fake, SQLite, base default; ES path asserts `composite` +
  `after_key` paging and PIT; SQL asserts GROUP BY (no Python fold) for status/month.
- Accumulators: golden equality vs current `posture_metrics`/`sla_metrics`/`trend_metrics`
  on ≤ 5,000-case fixtures.
- Persistence: a 200 KB answer with 300-row table round-trips without `truncated`.
- Budget: chat over budget in warn mode answers + ledger row; investigation still blocked.
- UI: no Continue chip for new answers; meter shows context share; recovery uses turn status.
