# Round 15 understand map: per-user activity data (reader "activity-data")

Branch `claude/round15` (up to date with `origin/Testing`, HEAD `c4227bd`). Read only.
Scope: every source of per-user activity the backend already holds, so the SPEC can design
(a) a user-activity tracker and (b) an admin "daily work done" view, exactly, on
Elasticsearch, PostgreSQL and SQLite, with no new index or table (#12).

---------------------------------------------------------------------------------------

## 0. Headline facts (read these first)

1. **The audit log is the only durable, append-only, per-actor, time-stamped record of
   human work.** Every other per-user store is a bounded KV document (rings, prune caps,
   one document for all tenants) or lives inside the case document.
2. **Human case-lifecycle rows carry no structured `action`.** `POST /api/cases/{id}/action`
   writes `action_type="status"`, `surface="case"`, and the verb only inside free text
   `result_summary="action=<verb> status <a>→<b> disposition=<d> [reason=…] [classified=…]"`
   (`backend/app/api/routes.py:7343-7358`). On Elasticsearch `result_summary` is analysed
   `text` (`backend/app/es/indices.py` AUDIT_MAPPING; `deploy/mappings/tlsoc-agent-audit.template.json`),
   so a push-down **cannot** split acknowledge / close / reopen / escalate / set_disposition.
   Comments, tags and assignments are `action_type="collab"` with summaries `"comment added"`,
   `"tags set (N)"`, `"assigned to X"` (`routes.py:7622-7626, 7652-7656, 7696-7700`).
3. **Attribution bug (must fix before any tracker):** `/cases/{id}/comment`, `/tags`, `/assign`
   take the audit actor from the request body (`body.author` / `body.analyst`, default
   `"analyst"`), not from the signed-in principal (`routes.py:7623, 7653, 7697`). The Console
   calls `api.caseAssign(c.case_id, value.trim())` and `api.caseTags(c.case_id, next)` with no
   analyst (`webui/src/soc/pages/casedetail/CollaborationPanel.tsx:85`,
   `CaseHeaderMeta.tsx:168, 191`; `webui/src/lib/api.ts:1383-1390`), so every single-case
   assignment and tag change from the Console is audited as actor **`"analyst"`**, and the
   "assigned" history entry records `"analyst": "analyst"` (`routes.py:7690-7691`). Feedback and
   lifecycle actions already use the principal (`routes.py:7569-7572, 7125-7128`). Bulk jobs
   pass `job.actor` (`backend/app/engine/jobs.py:776-804`).
4. **Case-work rows carry no request context.** `_perform_case_action`'s audit row and the
   collab `_audit` helper pass no `client`, `session_ref`, `actor_role` or `request_id`
   (`routes.py:7343-7358`; `routes_cases_collab.py:320-337`). "Work by role at the time" is
   therefore not recorded for case work; identity rows do carry it (`audit/identity.py:111-124`).
5. **Case work is audited best-effort after the case save** (`routes.py:7340-7360`,
   `try/except … logger.warning`). An audit outage leaves a changed case with no row. The
   case document's `status_history` / `history` are written in the same save and are the
   more reliable record of lifecycle moves (but not nested on ES, see §3).
6. **`case_aggregate` windows by `created_at` (case cohort), never by action time**, and has no
   group field for "who acted" (`closed_by` is the decider TYPE agent/analyst/system/
   analyst_policy, `backend/app/engine/case_aggregate.py:96-98`). It cannot answer "what did
   alice do on Tuesday".
7. **No per-user LLM usage.** `UsageDoc` has no user/actor field (`backend/app/models.py:2353-2410`);
   chat audit rows carry `actor=<username>` but `actor_type="agent"` and land in Agent
   activity (`backend/app/agents/chat.py:1683-1694`).
8. **Recommended computation: aggregate the audit log** (new optional `AuditRepository`
   push-down: ES composite + `date_histogram` in a PIT, SQL `GROUP BY` in one snapshot, exact
   Python fold over `search_page` as reference/fallback), after giving every human work row a
   structured `action`, a `case` target and the request context. Details in §7.

---------------------------------------------------------------------------------------

## 1. (a) The audit log

### 1.1 `AuditDoc` (`backend/app/models.py:2223-2324`)

| Field | Type / bound | Notes |
|---|---|---|
| `event_id` | `str|None` | deterministic idempotency key for privileged rows (proposal decisions) |
| `app_version`, `build_sha` | `str|None` | first-append build stamp |
| `ts` | ISO string, default `iso_now()` = `datetime.now(utc).isoformat()` (`backend/app/utils.py:17-18`) → `2026-11-23T10:00:00.123456+00:00`; writers may pass `ts=` explicitly (`record_strict`, `stores/base.py:800-860`) |
| `case_id` | `str|None` | |
| `source_id` | `str|None` | poll provenance |
| `surface` | `str` | e.g. `case`, `session`, `auth`, `chat`, `proposal`, `rules` |
| `actor` | `str`, bounded by `audit_actor_key` (160 chars, `backend/app/stored_text.py:47-71`) | username, agent token, or `"analyst"`/`"default"`/`""` when auth off |
| `action_type` | `ActionType` | coarse category (§1.2) |
| `model`, `prompt_excerpt`, `query_text`, `tool_name`, `tool_input`, `tool_output_summary`, `result_summary` | text capped at 1,000 chars (`AUDIT_TEXT_WRITE_CAP`, `models.py:2060`) |
| Round 14 (`AUDIT_ROUND14_FIELDS`, `models.py:2217-2220`), omitted when unset: | | |
| `outcome` | `success|failure|denied|partial|unknown` (`models.py:2032`) | legacy derivation `access_denied→denied`, `error→failure` (`audit/events.py:51`, `derive_outcome` :270-281) |
| `actor_type` | `human|agent|system|service` (`models.py:2034`) | legacy derivation by actor lists (`audit/events.py:284-302`) |
| `action` | `^[a-z_]+\.[a-z_]+$`, ≤64 (`models.py:2041-2043`) | structured `<resource>.<verb>` |
| `actor_role` | ≤64 | role at request time |
| `client` | `AuditClient{ip, ip_source, peer, forwarded_for, user_agent}` (`models.py:2110-2147`) | personal data |
| `session_ref` | 16 hex of an HMAC of the sid (`models.py:2047`) |
| `target` | `AuditTarget{type, id, label, revision}`; types `case,user,role,source,setting,job,rule,runbook,dashboard,export` (`models.py:2036-2039, 2150-2186`) |
| `changes` | ≤50 `AuditChange{field,before,after,secret}` (`models.py:2189-2214`) |
| `request_id` | `^[A-Za-z0-9._-]{8,64}$` (`models.py:2045`) |
| `run_id` | ≤128, investigation grouping |

Read-side projection `AuditRecord` (`models.py:4618-4660+`): adds `record_id`, `category`,
`event_label`, `outcome_derived`, `actor_type_derived`.

### 1.2 `ActionType` vocabulary (`backend/app/constants.py:540-581`)

`prompt, es_query, tool_call, verdict, decision, error, poll, scan, feedback, collab, status,
context, proposal, automation, playbook, runbook, notification, user_mgmt, auth,
access_denied, thread_post, reaction, task_update, inapp_notify, tuning, reset, data_export,
job, system_update, report, audit_view`.

### 1.3 Event table (`backend/app/audit/event_categories.json`, loaded by `audit/events.py:43-248`)

Categories: `access` "Access and identity", `config` "Configuration and data", `case_work`
"Case work" (People scope), `agent` "Agent pipeline", `system` "System" (Agent scope).
Classification (`audit/events.py:256-267`): a row with `action` → exact entry, then prefix
entry, else System; a row without → `(action_type, surface)` legacy key (specific surface
beats `*`).

Human-work-relevant entries today:

* Legacy (`legacy_events`): `status/*` "Case status changed" (case_work); `collab/*` "Case
  updated"; `feedback/*` "Verdict graded"; `thread_post/*` "Case message posted";
  `reaction/*` "Message reaction"; `task_update/*` "Case task updated"; `proposal/*`
  "Approval proposal"; `report/*` "Report changed"; `auth/*` "Sign-in event"; `audit_view/*`
  "Audit log viewed"; `user_mgmt/*` "User changed"; plus config writes (`status/settings`,
  `status/rules`, `status/storage`, `status/analyst_policy`, `context/rag`, …).
* Prefixes (`action_prefixes`): `case.` → case_work "Case", `run.` "Runbook run", `step.`
  "Runbook step", `report.`; `auth.`, `session.`, `user.`, `role.` → access; `settings.`,
  `rule.`, `runbook.`, `dashboard.`, `source.` … → config.
* Exact `actions`: `auth.login` "Signed in", `auth.login_failed`, `auth.logout` "Signed out",
  `auth.mfa_*`, `auth.password_changed`, `auth.reauthenticated`, `session.created`
  "Session started", `session.refreshed` "Session renewed", `session.revoked` "Session
  ended", `user.*`, `role.*`, `audit.viewed`, `audit.export_*`, `settings.updated`,
  `dashboard.*`, `source.*`, `runbook.*` (library), `run.attached|started|completed|
  abandoned|version_switched`, `step.updated|evidence_collected|decision_recorded|
  action_recorded|approval_requested|approved|rejected|ai_drafted|ai_draft_confirmed`,
  `case.closed_with_open_steps` "Case closed with open steps" (the ONLY existing exact
  `case.*` action), and the matching `*_failed` actions.
* `actors.agent`: `router, investigator, formatter, standup, chat, overview, embedding,
  pipeline, playbook_selector, runbook_selector, procedure_provenance, context, reinvestigate,
  agent`; `actors.system`: `system, case_manager, analyst_policy, poller, ingest, tuner,
  automation, update_supervisor, notification, run_playbook, runbook_migration`.

Contract tests that pin this table (a new `case.*` entry must update both sides):
`webui/src/soc/components/audit/__tests__/events.contract.test.ts` (reads the same JSON),
`webui/src/soc/components/audit/events.ts`, `backend/tests/test_audit_read_api.py`,
`backend/tests/test_audit_record_fields.py`, `backend/tests/test_round14_runbook_event_labels.py`.
Labels must be sentence case with no en/em dash (`audit/events.py:126-130`).

### 1.4 Who writes human work rows today (with exact shapes)

| Work | Route / writer | `action_type` / `surface` / `action` | actor | Context fields |
|---|---|---|---|---|
| Lifecycle (`close, confirm_fp, reopen, escalate, deescalate, hold, resume, resolve, acknowledge, set_disposition, set_status`; `_ACTION_STATUS`, `routes.py:6949-6965`) | `POST /api/cases/{id}/action` → `_perform_case_action` (`routes.py:7107-7128, 7141-7444`) | `status` / `case` / **none** | principal, else `body.analyst`, else `"analyst"` (`routes.py:7128`) | none; `actor_type="human", outcome="success"` |
| Bulk lifecycle | `POST /api/cases/bulk` (`routes.py:7448-7517`, ≤500 ids) and job `case_lifecycle` (`jobs.py:748-774`) | same rows, one per case; history entry carries `batch` | principal / `job.actor` | `via="bulk"` only on the open-steps row |
| Closed with open runbook steps | `runbook_runs.record_closed_with_open_steps` (`engine/runbook_runs.py:1973+`, called `routes.py:7364-7373`) | structured `case.closed_with_open_steps` | person | request context passed |
| Grade AI verdict | `POST /api/cases/{id}/feedback` (`routes.py:7543-7598`) | `feedback` / `case` / none; summary `assessment=… outcome=… accuracy=…` | principal (spoof-proof) | none |
| Legacy comment | `POST /api/cases/{id}/comment` (`routes.py:7601-7627`) | `collab` / `case`; `"comment added"` | **`body.author or "analyst"`** | none |
| Tags | `POST /api/cases/{id}/tags` (`routes.py:7630-7663`) | `collab`; `"tags set (N)"` | **`body.analyst or "analyst"`** | none |
| Assign | `POST /api/cases/{id}/assign` (`routes.py:7666-7701`) | `collab`; `"assigned to <x>"` | **`body.analyst or "analyst"`** | none |
| Thread post / edit / delete / reaction | `routes_cases_collab.py:486-605, 607-706` via `_audit` (:320-337) | `thread_post`, `reaction` / `case` | principal (`_resolve_author` :150-164) | none |
| Case tasks add / update / log | `routes_cases_collab.py:727-830` | `task_update` / `case` | principal | none |
| Runbook runs and steps | `engine/runbook_runs.py` (`run.*` :1251-1932, `step.*` :1512-3280), action_type `runbook` | structured | person, `actor_type` set | request context passed |
| Proposal approve / reject | `routes.py:2428, 2661-2670, 2764, 2917` | `proposal` / `proposal`; keyed `event_id`; summary `proposal_id=… action=approve …` | person (`decided_by`) | none |
| Reinvestigate | `routes.py:7853-7905` | `decision`; actor `"reinvestigate"`, `actor_type="agent"`; person only in summary from **`body.analyst`** | n/a | none |
| Chat Stop | `routes_chat.py:2425-2431` | `context` / `chat`; `actor_type="human"` | principal | none |
| Chat answer feedback | `routes_chat_library.py:160-161` | `feedback` / `chat` | principal or `"default"` | |
| Chat turn steps | `agents/chat.py:1683-1694` (`prompt`, `tool_call`, `es_query`, `error`) | `actor=<user>`, **`actor_type="agent"`** → Agent activity; summary `turn=<id> step=<n> …` | user | none |
| Reports | `routes_reports.py:260-275` | `report` | person | |
| Sign-in / out / MFA / sessions | `record_identity_event` (`audit/identity.py:85-131`), callers `routes.py:3796-4466, 4863-4992` | `auth` / `auth|session`; structured `auth.*`, `session.*` | person | full request context; `record_strict` to `control_audit`, drop counted |
| Settings / users / roles / rules / runbooks library | `audit/write.py` `audited_write` (audit before visible, :1-60), `settings_write.py`, `prefs_write.py` | structured | person | full |
| Audit reads | `audit/views.py` (one `audit_view` row per user per filter set per 300 s, `COALESCE_SECONDS`, :44) | `audit_view` | person | |
| Standup ack / action items | `routes_standup.py:186-248` | **not audited** (KV only) | | |

### 1.5 Read API: `backend/app/api/routes_audit.py`

* Gate: `_AUDIT_VIEW = require_permission("audit", "view")` (:1248), declared on every route.
* `GET /api/audit` (:1255-1329): params `scope` (`people|agent|all`), `q`, `action` (legacy =
  `action_type`), `event` (structured action, category id or family token), `actor` (exact),
  `actor_contains`, `actor_kind`, `outcome`, `surface`, `case_id`, `source_id`, `target`, `ip`,
  `from`/`to` (ES date math, ISO, epoch ms; ≤64 chars), `order` (`desc|asc`), `limit` (1-200;
  default 100 without scope, 50 with; `models.py:4610-4612`), `cursor` (signed, HMAC with
  `export_cursor_signing_key`, :552-553, ≤8,192 chars, carries the resolved window). Response
  `AuditPage{records,total,total_relation,next_cursor,run_totals,retention}`.
* `GET /api/audit/count` (:1332-1378): exact up to `cap` (≤ `AUDIT_COUNT_MAX_CAP` 100,001,
  `models.py:4616`), then `gte`. Sums over the store split.
* `GET /api/audit/records/{record_id}` (:1381-1420).
* Open-read registry: ≤8 open reads per caller, 128 total; PIT keep-alive 300 s
  (`audit/audit_log.py:39`).
* Demo split `_sources(state, scope)` (:515-533): Demo off → control store; Demo on →
  People = control People + demo People; Agent = demo only; All = control People + all demo.
* Every list/count/record read writes an `audit_view` row (`_note_view`, :1015).
* Retention projection `_retention` (:960-988): volatile for in-memory; days only on ES with
  an active lifecycle policy (Hot 180 d + Warm 90 d defaults; deletion off).

### 1.6 Predicate compiler: `backend/app/audit/query.py`

* Leaves `Eq, In, Present, Prefix, Contains, TsRange`, combinators `And, Or, Not`
  (:56-129); one meaning on every store.
* `AuditFilters` (:153-209) + `build_predicate` (:438-474); `scope_predicate` (:300-321):
  People = `actor_type ∈ {human, service}` OR category ∈ {access, config, case_work}.
* `actor_kind_predicate("human")` (:358-374) = recorded `human` OR (no `actor_type`, actor
  not in the agent/system lists and not empty, row in a People category).
* ES compile `to_es_query` (:549-587); keyword fields since first release:
  `action_type, surface, actor, case_id, source_id, model, tool_name, app_version, build_sha`
  (:136-139); Round 14 keyword fields `outcome, actor_type, action, actor_role, session_ref,
  request_id, run_id, target.type, target.id, client.ip, client.ip_source` (:143-146) are
  compiled for BOTH mappings via `_es_dual` (:509-529) because an index created before
  Round 14 may map them as dynamic `text` + `.keyword` until it rolls over.
* Python reference `matches` (:478-509). SQL compiler `_audit_sql` lives in
  `stores/sql/repositories.py:1263-1296`.

### 1.7 Storage

**Elasticsearch** (`backend/app/audit/audit_log.py`):
* Write alias `tlsoc-agent-audit`, read pattern `tlsoc-agent-audit-*`
  (`backend/app/constants.py:18, 28, 33`); `index_doc` append (:101); keyed rows via
  `append_keyed_ledger_row` (:85-99, first-writer authority in the config index,
  `stores/ledger_claims.py`).
* Mapping `AUDIT_MAPPING` (`backend/app/es/indices.py:86-140+`, exported to
  `deploy/mappings/tlsoc-agent-audit.template.json`): `date_detection: false`; `ts` date;
  `actor`, `action_type`, `surface`, `case_id`, `source_id`, `action`, `actor_type`,
  `actor_role`, `outcome`, `session_ref`, `request_id`, `run_id`, `target.type`, `target.id`
  keyword; `target.label` text + `.keyword`; `result_summary`, `tool_output_summary`,
  `prompt_excerpt` **text**; `tool_input`, `changes` `enabled: false`. 1 shard, 0 replicas.
* `extend_audit_mapping` (`es/indices.py:308-370`) adds missing properties to live indices
  at bootstrap; a property already mapped dynamically stays as is until rollover.
* Reads: `search_page` PIT + `search_after (ts, _shard_doc)`, `track_total_hits` 10,000
  (`AUDIT_TRACK_TOTAL`, :43), page ≤1,000 (:254-342); `count_matching` with
  `track_total_hits: cap` (:344-356); `run_totals` inside the PIT (:358-395);
  `records_for_actor` term on `actor`, newest first, raises on failure (:185-199);
  `export_page` (:430-465).
* Append-only: `AuditRepository` has no update/delete (`stores/base.py:751-757`).

**SQL** (`backend/app/stores/sql/models.py:41-67`, table `audit`): columns `id` BIGINT
(negative surrogate for keyed rows), `ts` String(64) **indexed**, `case_id` indexed,
`action_type` String(64) (not indexed alone), `doc` JSON (PostgreSQL `json`, not `jsonb`);
composite index `ix_audit_case_ts (case_id, ts)` (:117). Everything else (actor, surface,
action, actor_type …) is read from `doc` through `readable_json` (NUL/surrogate-safe,
`stores/sql/json_read.py:60-95`; PG rewrite only for rows containing escapes).
`SqlAuditRepository` (`repositories.py:1299-1634`): INSERT only; `records_for_actor`
pushes `Eq("actor")` into SQL (:1445-1463); `search_page` keyset on `(ts, id)` with a
high-water `hw` snapshot, **and a full `count(*)` on every page** (:1515-1566);
`count_matching` counts ≤ cap+1 (:1575-1583); `run_totals` already does a `GROUP BY`
on a JSON field (`run_id`) (:1585-1601), proving the pattern.

**Generic third-party repo** (`stores/base.py:898-1001`): every Round 14 read is a scan of
the newest `AUDIT_FALLBACK_SCAN = 10_000` rows (:646), honest `gte`.

**Demo Mode**: `DemoStack.audit = AuditLogger(InMemoryESClient())`
(`engine/demo_runtime.py:217-231`). `state.audit`/`execution_audit` = Demo store while Demo is
on; `state.control_audit` = real store always (`backend/app/state.py:652-672`). Case work in
Demo goes to the Demo store; sign-ins to the control store. The in-memory ES supports
`composite` (terms + `date_histogram` with `time_zone`) (`backend/app/es/fake.py:4-8,
884-1060`), so an audit composite push-down is testable offline.

---------------------------------------------------------------------------------------

## 2. (b) Case data

### 2.1 Fields (`backend/app/models.py`)

* `status_history: list[StatusHistoryEntry]` (:1866), `StatusHistoryEntry{from_status,
  to_status, by, at, reason}` (:483-497). Writers: analyst path `routes.py:7305-7313`
  (`by=actor`, the username when auth is on); `case_manager.apply()` `by=decision.decision_by`
  (`agent|system`, `engine/case_manager.py:170-180`); analyst-policy close
  `by="analyst_policy"` (`agents/pipeline.py:1383-1393`); demo generator
  (`engine/demo_generator.py:912-916, 1052, 1288, 1326`). Only written when the status
  CHANGES (a `set_disposition` or same-status action adds none).
* `history: list[dict]` (:1947): per action `{"ts","event":"analyst_action","action":<verb>,
  "analyst":<actor>,"note", "batch"?, "classified_disposition"?, "resolution"?, "priority"?,
  "assignee"?}` (`routes.py:7318-7339`); assignment `{"ts","event":"assigned","assignee",
  "analyst"}` (`routes.py:7690-7691`); decisions `{"event":"decision",…}`
  (`case_manager.py:182-189`). This is the only place the exact verb of EVERY analyst action
  survives on the case (including `set_disposition`, `acknowledge` of an already-investigating
  case).
* `assignee: str` (:1893); `disposition` (:1850); `decision_by: DecisionBy|None` (:1871) is
  LAST-WRITER: every analyst action stamps `ANALYST` (`routes.py:7290`), see
  `engine/metrics.py:2009-2040`.
* `DecisionBy` = `agent | analyst | system | analyst_policy` (`constants.py:501-520`).
* `feedback: list[FeedbackEntry{ts, analyst, assessment, accuracy, reasoning_quality,
  action_appropriateness, actual_outcome, time_saved_minutes, comment, ai_verdict,
  ai_confidence}]` (:456-471, :1889). The analyst is the verified principal.
* `comments: list[CaseComment{ts, author, body}]` (:474-480, :1892), legacy; the thread store
  supersedes it.
* Clock anchors: `detected_at`, `acknowledged_at` (set on the FIRST `acknowledge` only,
  `routes.py:7199-7200`), `first_response_at` (:1928-1930, `datetime`), `first_seen_millis`
  (:1937), `created_at`/`updated_at` ISO strings.
* **There is NO `acknowledged_by`, `closed_by` (username) or `resolved_by` field.** The
  acknowledger / closer is only derivable from `status_history[*].by` (human entries) or
  `history[*].analyst`.

### 2.2 MTTA / MTTR / dwell / MTTD (`backend/app/engine/metrics.py`)

* `_ACK_STATUSES = {investigating, escalated, on_hold}`, `_RESPONSE_STATUSES` adds
  `resolved, closed` (:383-391); `_NONHUMAN_ACTORS = {"system","agent","analyst_policy"}`
  (:398), a human is "anyone whose `by` is not one of these three strings" (a user literally
  named `system` or `agent` would be excluded; usernames are free text).
* `_CaseTimings` one-pass walk (:448-504); `lifecycle_intervals` (:521-586): MTTA = created →
  `acknowledged_at` or first human ACK transition; MTTR = created → first terminal transition
  (only if currently terminal, `_resolved_dt` :428-445); dwell = first human response; MTTD =
  `first_seen_millis` → `created_at`.
* **Per-analyst grouping does not exist.** `feedback_stats` (:122-165) is global;
  `shift_report.analyst_workload` (`engine/shift_report.py:314-336`) counts OPEN cases per
  CURRENT assignee only (`{"analyst", "open", "escalated", "needs_human"}`, unassigned →
  `"(unassigned)"`).
* `case_aggregate` metrics `mtta_*`, `mttr_*` can be grouped by `assignee` (current owner),
  never by who acknowledged/closed.

---------------------------------------------------------------------------------------

## 3. (c) `engine/case_aggregate.py` and `engine/time_windows.py`

### 3.1 case_aggregate (`backend/app/engine/case_aggregate.py`)

* Group fields `CASE_GROUP_FIELDS` (:154-157): `verdict, status, status_group, severity,
  priority, rule, assignee, source, surface, disposition, mitre_tactic, mitre_technique,
  decided_by, closed_by`; ≤2 (`MAX_GROUP_BY`, :195); bucket units `hour…year` over
  **`created_at`** (`CaseAggregateSpec.bucket`, :246); `MAX_RESULT_BUCKETS = 5000` (:199);
  `PAGE_SIZE = 1000` (:194).
* `closed_by` is the decider kind for terminal cases (`analyst_policy|agent|analyst|system`)
  (:96-98), not a username. `assignee` is the current owner.
* Push-downs (only `count` and `open_now`):
  * ES `_es_case_pushdown` (`stores/cases.py:633-758`): composite on mapped keyword fields
    `status, verdict, decision_by, source_surface, rule_ids` + `date_histogram` on
    `created_at` with `time_zone`, inside ONE state PIT (2 m), `check_complete_response`;
    **`assignee`, `disposition`, `source_id` are unmapped on ES** (dynamic) → fold
    (:493-512, :545-551).
  * SQL `_sql_case_pushdown` (`stores/sql/repositories.py:944-1105`): `GROUP BY` on columns
    plus JSON text (`verdict, decision_by, disposition, assignee, source_id`, :903-912) and
    `substr(created_at,1,13)` hours mapped to local buckets in Python; declines (fold) when
    any filtered row has a non-canonical `created_at` or an hour straddles a bucket edge
    (half-hour zones) (:1004-1022, :1036-1043); runs in `_begin_snapshot` (:839-863).
* Fold `fold_cases` (:1679+) via `scan_page(created_from, created_to, statuses, raw, fields)`
  (`stores/base.py:502-563`); **`scan_page` filters on `created_at` only**, there is no
  `updated_at` pre-filter, so "cases touched in a window" would scan the whole store.
* Honesty flags: `exact`, `partial`, `consistency`, `missing_created`, `unreadable`
  (:15-50, :252-290).
* **Can it group by an actor field?** Not today. A new derived group (e.g. "first human
  acknowledger", "human closer") would be fold-only: on ES `status_history`/`history`/
  `feedback` are dynamic object arrays, `history` is `enabled: false`
  (`es/indices.py:76`), `status_history` is not `nested`, so `by` and `at` of one entry cannot
  be correlated by a query; on SQL they are inside the JSON array.
* **Can it bucket by calendar day?** Yes, but of `created_at` (cohort), not of the action.

### 3.2 time_windows (`backend/app/engine/time_windows.py`)

Pure, stdlib, no I/O (:1-58). `resolve_window` (:371) accepts all time, `now-N<unit>`,
calendar tokens (`today, yesterday, this_week, last_week, this_month, …`), period literals
(`2026-09-14`, `2026-W14`), ranges; resolved in the OPERATOR zone (`SlaPolicy.timezone`,
default UTC); half-open `[start, end)` (`ResolvedWindow`, :93-137). Helpers `period_start`
(:228), `next_period_start` (:261), `period_label` (:290), `calendar_buckets` (:819, zero-
filled), `align_window` (:975), `bucket_count`/`auto_bucket` (:994-1010),
`MAX_GENERATED_BUCKETS = 200_000` (:69). **Reusable as is for any record type** (audit rows
included): it never reads a case.

---------------------------------------------------------------------------------------

## 4. (d) Stores with per-user records

All KV stores go through `KVStore` (`stores/base.py:1116-1197`): `get`, `put`, `put_if`,
`mutate`, `factory_purge_strict`, **no key listing / prefix scan**. ES: one doc per
`<namespace>:<key>` in the config index with ONE shared dynamic mapping
(`stores/memory.py:62-110`; field-explosion risk, hence the opaque-JSON-string pattern of
`reports`, `runbook_runs`, `chat_*`). SQL: table `kv` `(namespace String(64), key
String(128)) → value JSON` (`stores/sql/models.py:84-95`).

| Store | File | Shape | Per-user data | Limits / caveats |
|---|---|---|---|---|
| case_thread | `stores/case_thread.py` | ONE doc for all cases; keyed form on SQL, opaque rows on ES (:1-40) | `CaseMessage{author, author_type, created_at, edited_at, deleted_at, mentions, reactions[{emoji,user}]}` (`models.py:1190-1210`) | whole-doc RMW; all cases in one document |
| case_activity | `stores/case_activity.py` | ONE doc `{"activity":{case_id:[CaseActivity]}}` (:1-20) | `CaseActivity{kind, actor, ts, summary, ref}` (`models.py:1213-1226`); written only by thread/task/reaction routes (`routes_cases_collab.py:340-352`) | trimmed to 500/case (:38); not written by lifecycle actions |
| case_tasks | `stores/case_tasks.py` | ONE doc `{"tasks":{case_id:[CaseTask]}}` | `CaseTask{assignee, status, created_at, logs[{ts,by,note}]}` (`models.py:1229-1242`) | |
| inbox | `stores/inbox.py` | ONE doc `{"items":{user:[...]}}` | notifications delivered to a user, read state | ring 200/user (:40); not work |
| sessions | `stores/sessions.py` | ONE doc `{"entries":[row]}` (:1-27) | row `{sid, username, created_at, last_active_at, last_authn_at, revoked, revoked_at, revoked_by, revoke_reason, ip, ip_city, ip_country, ua_*, client_type, mfa_method, remember, …}` (:170-203) | `last_active_at` bumped at most every 60 s (`touch`, :452-475); rows pruned 7 d after revoke/expiry (:47); cap 2,000 rows (:50). **Not a login history**, the audit `auth.login`/`session.*` rows are. |
| users | `stores/users.py` | ONE doc | `User.last_login_at` (`models.py:680`), set on every sign-in path (`routes.py:3921, 4988, 5158, 5413`), shown on Users page "Last sign-in" (`webui/src/soc/pages/Users.tsx:305-309`) | current role only |
| user_prefs | `stores/user_prefs.py` | ONE doc of buckets | saved views, column state, misc switches | not activity |
| chat_conversations | `stores/chat_conversations.py` (3,975 lines) | per-user partitions (`user-<sha256>` keys), `x-`/`a-`/`s-`/`o-`/`v-` docs | conversations, `message_count`, `total_message_count`, timestamps | private per user; counting questions across users means reading every user's index |
| chat_feedback | `stores/chat_feedback.py` | one doc per user | answer ratings | ≤500/user (:40) |
| reports | `stores/reports.py` | one doc per report + per-user index | owner-scoped reports | |
| runbook_runs | `stores/runbook_runs.py` | `case:<id>` docs + `ledger:<yyyy-mm>` | `StepState{started_at, completed_at, completed_by, decision{by,at}, action_record{performed_by,performed_at}, approval}`; `RunbookRun{attached_by, attached_at, completed_at}` (`models.py:5240-5290`); ledger row `{run_id, case_id, runbook_id, version, attached_by, started_at, completed_at, status, …}` (`runbook_runs.py:176-196`) | ledger ≤512 KiB/month, 13 months kept; every step change is also an audit row |
| proposals | `stores/proposals.py` | ONE doc list | `Proposal{created_by, decided_by, decided_at, decision_actor, decision_intent, decision_reason}` (`models.py:545-600`) | decision audit rows exist (§1.4) |
| shift_handoff | `stores/shift_handoff.py` | ONE doc `{"action_items":[…],"acks":[…]}` | `ShiftAck{user, window, at, note}` (`models.py:1512-1520`), `ActionItem{owner, status, created_at}` (:1499-1509) | acks ≤1,000 (:41); **neither ack nor action-item changes is audited** (`routes_standup.py:186-248`) |
| usage | `stores/usage.py`, SQL `usage` table | per LLM call | **no user field** (`models.py:2353-2410`) | |
| noise_counters | `stores/noise_counters.py` | ONE doc of per-hour buckets, 90 d retention (:1-75) | none, but it is the existing pattern for durable hourly counters | |

---------------------------------------------------------------------------------------

## 5. (e) Existing Console surfaces showing user activity

* **Account activity**, `GET /api/account/activity?limit=1..200` (`routes.py:4391-4402`):
  the caller's own audit rows via `_records_for_actor` (`routes.py:4517-4538`, reads
  `control_audit` only, so Demo case work is not shown; `503 audit_unavailable` on failure).
  Console: Settings "Sessions & activity" section, `webui/src/soc/pages/Sessions.tsx:2-20,
  381-386, 450-512` (`activityRows`, aria label "Recent account activity", empty "No recent
  activity."). Tests: `webui/src/soc/__tests__/sessions.render.test.tsx`,
  `sessions.remember.test.tsx`, `sessions-guards.test.tsx`; backend `tests/test_sessions.py`,
  `test_audit_nul_hygiene.py`, `test_postgres_json_nul.py`.
* **Admin sessions**, `GET /api/admin/sessions` (`routes.py:4408-4425`), revoke
  (:4428-4475), gated `require_admin` = `users:manage` (`deps.py:1062+`); Console
  `webui/src/soc/pages/AdminSessions.tsx:1-60` (`ProtectedRoute resource="users"
  action="manage"`). The `sessions: ["read","manage"]` grant in `rbac/policy.py:83` is not
  enforced by any route.
* **Users page**, per-user row menu "Audit events" → `#/audit?scope=all&actor=<username>`
  when `audit:view` (`webui/src/soc/pages/Users.tsx:116, 197-203`); "Last sign-in" column
  (:305-309).
* **Audit log page**, `webui/src/soc/pages/Audit.tsx` (scopes People and settings default,
  Agent activity, All; search; Event/Actor/Outcome filters; inspector; export job
  `audit_export` with `audit:export`). Nav entry `id:'audit', label:'Audit log'`,
  `group:'platform'`, `perm audit:view` (`webui/src/soc/registry.tsx:433-439`).
* **Standup**, `GET /api/standup/report` (`routes_standup.py:104+`) → `workload` from
  `analyst_workload`; Console `WorkloadPanel` "Analyst workload" caption "open cases per
  assignee", testid `standup-workload` (`webui/src/soc/pages/Standup.tsx:495, 791-810`).
  Tests: `webui/src/soc/__tests__/standup-report.test.tsx`,
  `backend/tests/test_round3_wave2_standup.py`.
* **Dashboards / metrics**, `GET /api/metrics/breakdown?by=assignee` (current owner, fold on
  ES, `routes_metrics.py:1492-1600`; caches 5 s, ≤2 concurrent reads, 5,000 rows); KPI binding
  `by:'assignee', status_group:'open'` (`webui/src/soc/dashboard/kpi-bindings.ts:251`).
  Metrics "Analyst feedback quality" is global (`webui/src/soc/pages/Metrics.tsx:667, 932`).
  Overview "Case workload state" is by status, not by person (`Overview.tsx:2811-2836, 5062`).
* **No surface today shows what a person DID per day.**

---------------------------------------------------------------------------------------

## 6. (f) Volume and performance limits

### 6.1 Rough audit volume (derived from the writers above; estimates, not measured)

* Polls: one `poll` row per source per tick (`engine/poller.py:810-817`); default
  `poll_interval_seconds = 30` (`config.py:4202`) → 2,880 rows/day per pull source.
* Investigations: router + investigator ReAct steps (prompt, es_query, tool_call, context) +
  verdict + decision + formatter → roughly 10-40 rows each; with autopilot defaults
  (`caps.max_auto_investigations_per_tick = 25`) a busy deployment writes 10^4-10^6 agent rows
  a day.
* Chat: one `prompt` row per model call plus tool rows per turn, `actor=<user>`.
* Human rows: per analyst per shift, sign-in/session 2-10, per case worked 3-15 (ack, assign,
  thread, tasks, runbook steps, close, feedback) → ~100-1,000 rows/analyst/day; a 20-person
  SOC ≈ 2,000-20,000 People-scope rows a day. Human rows are a small minority of the audit,
  so any per-analyst read must be filtered to the People / human predicate before grouping.

### 6.2 Existing caps

* Audit pages ≤200 (API) / ≤1,000 (store); totals exact to 10,000 then `gte`
  (`AUDIT_TOTAL_TRACK_LIMIT`, `models.py:4613`); count exact to 100,001; export ≤100,000 rows
  (`AUDIT_EXPORT_MAX_ROWS`, `models.py:4614`; `engine/audit_export.py:1-40, 590-745`), never
  partial. ES PIT 300 s; open reads 8/caller, 128 total. SQL `search_page` re-counts the whole
  matching set on EVERY page, so a 1,000-row-page fold over N rows costs O(N²/1000) counting.
* Dashboards: `_STORE_FETCH_LIMIT = 20000` newest cases per window, beyond that `truncated`
  lower bounds (`api/routes_metrics.py:83-93`); rollups ≥2,000 cases run in a thread
  (`_OFFLOAD_AT`, :111). Breakdown: TTL 5 s, ≤2 concurrent reads, timeout, ≤5,000 rows per
  answer, 20,000 cached rows (`routes_metrics.py:924-962`); fold ≈ 50 µs per case.
* case_aggregate: page 1,000, ≤5,000 buckets, ≤2 group fields; ES composite page 1,000
  (`stores/cases.py:552`, `stores/usage.py:380`).
* Sessions KV doc ≤2,000 rows; case_activity 500/case; inbox 200/user; acks 1,000.

---------------------------------------------------------------------------------------

## 7. Recommendation: exact per-analyst daily work counts on ES, PostgreSQL and SQLite

**Source of truth: the append-only audit log** (control store, merged with the Demo store
under the Round 14 `_sources` split while Demo Mode is on). It already holds actor, kind,
time, case and outcome for every human action, survives case resets, and is read with one
predicate on all three stores. Do not build the numbers from a new KV counter projection:
it would drift from the audit on any crash or retry, `KVStore` cannot list keys, ES KV docs
share one dynamic mapping, and every write would add CAS contention. If a cache is wanted,
make it a recomputable cache of audit answers, never the authority.

Steps:

1. **Make every human work row self-describing (new rows only, no backfill, #2).**
   Add a structured `action` to the lifecycle row, e.g. `case.acknowledged`, `case.closed`,
   `case.fp_confirmed`, `case.resolved`, `case.reopened`, `case.escalated`,
   `case.deescalated`, `case.held`, `case.resumed`, `case.disposition_set`, `case.status_set`;
   to collab rows `case.assigned`, `case.tagged`, `case.commented`; to feedback
   `case.graded` (and Round 15 additions such as `case.attachment_added`,
   `case.review_completed`). Add `target={type:"case", id, label: case_number}` and the
   request context (`audit_context(request).record_fields()`: `actor_role`, `request_id`,
   `session_ref`, `client`) as `record_closed_with_open_steps` already does. Keep
   `action_type`, `surface` and the `result_summary` text byte-identical (they are read
   positionally, `routes.py:7350-7354`, and pinned by
   `tests/test_audit_route_outcomes.py:122-140`). Each new name needs an exact entry in
   `event_categories.json` (category `case_work`) and the webui contract test.
2. **Fix attribution:** comment/tags/assign (and the reinvestigate summary) take the actor
   from the verified principal when sign-in is on, falling back to the body only when it is
   off (the `case_feedback` pattern, `routes.py:7565-7572`). The auth-off contract test above
   keeps passing.
3. **Add an optional push-down `AuditRepository.aggregate(spec)`** (non-abstract, default
   `None`, exactly like `CaseRepository.aggregate`, `stores/base.py:492-500`) with a spec of
   `{predicate (People ∩ actor_kind human, minus audit_view and session.refreshed noise),
   window (time_windows), tz, group_by ⊆ (actor, event key), bucket = day}` and the
   case_aggregate honesty flags (`exact`, `partial`, `consistency`, `scanned`).
   * **ES:** inside one PIT, `composite` sources `terms actor` (keyword since the first
     release), `terms action_type`, `terms surface`, `terms action` (`missing_bucket: true`),
     `date_histogram ts calendar_interval=day time_zone=<operator tz>`, query
     `to_es_query(predicate)`; page with `after` (the `_es_composite` loop,
     `stores/cases.py:597-616`), `check_complete_response`. A `terms` on `action` fails on an
     older index that mapped it as text: treat any error as "fold instead" (the case
     aggregate rule) or detect the mapping once with `get_index_mapping`.
   * **SQL:** in `_begin_snapshot`, `SELECT readable_json(doc)['actor'], action_type,
     doc['surface'], doc['action'], substr(ts,1,13), count(*) … WHERE ts in window AND
     <_audit_sql(predicate)> GROUP BY …`; map UTC hours to local days in Python as
     `_sql_case_pushdown` does; for a zone whose offset is not a whole hour group by
     `substr(ts,1,16)` (minutes) instead of declining; decline (fold) when a matching row's
     `ts` is not the canonical `+00:00` shape (the `created_at` guard pattern,
     `repositories.py:977-1022`). `ts` is indexed, so the window bounds the scan.
   * **Fold (reference and fallback):** stream `search_page(predicate, order="asc",
     limit=1000)` inside its snapshot (the `audit_export` read loop), classify each row with
     `events.classify`, and for legacy rows without `action` read the verb from the leading
     `action=<verb>` token of `result_summary` (status/case rows) or the fixed collab
     summaries. Exact on ES and SQL; on a third-party repository it is limited to 10,000
     rows and must report `partial`. Avoid the SQL per-page re-count (add a count-free page
     variant or use the push-down).
   * **Legacy history before the upgrade:** the ES push-down puts legacy rows in one
     `(status, case)` bucket per actor-day; refine it with a fold over only
     `Eq(action_type,"status") ∧ Eq(surface,"case") ∧ missing(action)` rows in the window
     (small: human lifecycle rows only), so pre-Round-15 days stay exact too.
4. **Outcome and timing per analyst come from the case model, not the audit:** "closed as
   FP/TP/benign by alice", "alice's MTTA". Add fold-only derived fields (first human ACK
   transition `by`, human terminal transition `by`, `history[*].analyst` with
   `classified_disposition`) using `_CaseTimings` (`metrics.py:448-504`); exact on every
   backend, cost bounded by the case count (≈50 µs/case); window by transition time over a
   full scan, or by `created_at` cohort through `scan_page`. Exclude `_NONHUMAN_ACTORS`.
5. **Gate and audit the reads:** the tracker reads other people's audit rows, so its minimum
   consistent gate is `audit:view` (super_admin, soc_manager, auditor by default,
   `rbac/policy.py:436-519`); a person's own day can reuse `/api/account/activity`'s rule.
   Write `audit_view` rows like `routes_audit._note_view`. No model call (#6), aggregates only
   (#7), plain text (#9), nothing feeds `decide()` (#3).

Known limits to state in the SPEC:
* Sign-in off: actors are `"analyst"`, `"default"` or `""`; per-person tracking is not possible
  and the page must say so. RBAC off: every signed-in account is Super admin, so everyone can
  read everyone's activity.
* Case lifecycle and collab rows are best-effort; a failed append is logged only. For exact
  counts either move these writes to `record_strict`/`audited_write` (changes failure
  semantics to `503 audit_unavailable`) or cross-check against `status_history`.
* Assignments and tag changes made from the Console before the attribution fix are recorded
  as actor `"analyst"` and cannot be re-attributed (append-only).
* Chat work is Agent activity today (`actor_type="agent"`), one row per model call, with the
  turn id only in text; "questions asked per person" needs a human row per turn or a read of
  the per-user chat stores.
* Standup acknowledgements and action items are not audited.
* `actor_role` is absent on case-work rows before the fix, so "by role" uses the user's
  current role for older rows.
