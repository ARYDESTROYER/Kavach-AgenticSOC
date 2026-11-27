# Round 15 map: backend case lifecycle and close flow

Reader: close-flow. Read-only map of `claude/round15` at `b49780c` ("Journal: Round 15 start").
Every claim cites file:line. Two claims were confirmed with throwaway probes run from the
scratchpad against the repo's own `tests/conftest.py` fixtures (fake ES + mock LLM); no
repository file was written. Probe sources:
`/tmp/claude-0/-home-user-Kavach-AgenticSOC/2fc24c44-3228-5bc2-8fb3-56e1bc548beb/scratchpad/round15/probe/`.

---

## 0. The ten facts that matter most

1. **`decision_by` is last-writer, and every analyst lifecycle action stamps it.**
   `_perform_case_action` sets `case.decision_by = DecisionBy.ANALYST` unconditionally
   (`backend/app/api/routes.py:7284`). A same-status move is legal
   (`_guard_transition` returns early when `target is None or target == current`,
   `routes.py:7023-7027`), so `set_disposition` (target `None`, `routes.py:6965`) on an
   AI auto-closed case, or `close`/`confirm_fp` on an already closed case, silently moves
   that case from "auto-closed" to "closed by a human" in every last-writer statistic:
   `quality_metrics` automation_rate (`engine/metrics.py:740-741`), `trend_metrics`
   (`metrics.py:1555-1556`), `auto_close_health` (`metrics.py:1703-1705`), the noise
   funnel (`engine/noise_counters.py:215-240`), `case_aggregate` `closed_by`
   (`engine/case_aggregate.py:579-588`), the Case Manager "Closed by the AI agent" filter
   (`routes.py:6242-6250`, `CASE_QUEUE_CLOSED_BY`), and precedent futility
   (`engine/precedent.py:738-779`). **A QA review verdict must therefore NOT be written
   through `_perform_case_action`** (or through any path that touches `decision_by`).
2. **Ground truth = `engine/analyst_outcomes.py::analyst_confirmed_outcome`, not
   `precedent.py`.** Rule (`analyst_outcomes.py:135-175`): the latest `FeedbackEntry`
   whose `actual_outcome` is one of `false_positive|true_negative|true_positive|false_negative`
   wins, **regardless of `decision_by`**; otherwise the disposition counts only when
   `decision_by == "analyst"` AND the newest classification entry exists in
   `case.history` (`action in {"set_disposition","confirm_fp"}` or a non-empty
   `classified_disposition` key, `analyst_outcomes.py:81-100`) AND the disposition is
   `false_positive|benign` (FP) or `true_positive` (TP). `assessment` (agree/disagree)
   is never a label.
3. **The safe home for a QA verdict is a `FeedbackEntry`** (`models.py:456-471`),
   written by a path that does not touch `decision_by`/`status` (like
   `POST /api/cases/{id}/feedback`, `routes.py:7543-7598`, which never changes either).
   That makes the verdict independent ground truth without moving any agent-performance
   series. But a QA `FeedbackEntry` is ALSO read by the agent-quality views
   (`engine/agent_improvement.py:134-183`, `engine/metrics.py:122-165`), the tuner
   (`engine/threshold_tuner.py:317-385`) and the precedent corpus
   (`tools/rag.py:2829-2880`), so it needs a provenance marker (additive field) and a
   rule that `actual_outcome` is only ever what the reviewer affirmatively chose (never
   defaulted to the AI verdict: the historical "2062 model verdicts looked like analyst
   ground truth" failure, `tools/rag.py:335-345`).
4. **The close "reason" fields that exist today are thin and free text.** No Case field
   holds a resolution; `CaseAction.resolution`/`priority` land only on the history entry
   (`routes.py:7315-7336`); `status_reason` is written only for `hold|resolve|set_status`
   (`routes.py:7286-7288`); the close `note` goes to `history[].note` and the
   `status_history[].reason` (500 chars, `routes.py:7286`, `7300-7307`) **and becomes
   model-facing precedent text** (`tools/rag.py:2757-2783`, 500-char cap `rag.py:354`,
   UI disclosure `DURABLE_CONTEXT_NOTE`, `webui/src/soc/pages/casedetail/shared.tsx:64-65`).
5. **Lifecycle audit rows are best-effort, written after the save, with no structured
   `action`, no `target`, no request context** (`routes.py:7340-7359`). Only
   `case.closed_with_open_steps` is a structured, strict row
   (`engine/runbook_runs.py:1973-2002`). Three legacy writers take the audit actor from
   the request BODY, not the principal: comment (`actor=body.author or "analyst"`,
   `routes.py:7623`), tags (`body.analyst`, `routes.py:7653`), assign (`body.analyst`,
   `routes.py:7697`, also the `history[].analyst` of the "assigned" entry, `routes.py:7688-7689`).
   Any "user activity" feature built on these rows inherits spoofable / "analyst" actors.
6. **Verified pre-existing defect: re-investigating an OPEN case wipes analyst work.**
   `_assemble_case` (`agents/pipeline.py:1555-1678`) rebuilds `Case(...)` carrying
   `history`, tags, verdict trail and provenance but NOT `assignee`, `comments`,
   `feedback`, `status_history`, `disposition`, `acknowledged_at`, `escalation_level`,
   `status_reason`, `notifications_sent`; the stores do a full-document replace
   (`stores/cases.py:105-131`, `stores/sql/repositories.py:229-270`). Probe: after
   acknowledge + assign + comment + feedback(TP), `POST /reinvestigate` returned
   `assignee ''`, `comments 0`, `feedback 0`, `status_history 2→1`,
   `acknowledged_at None`, `decision_by system`. The analyst's feedback label (ground
   truth) is destroyed. (The analyst-policy close path does carry them,
   `pipeline.py:1418-1434`.)
7. **Verified pre-existing defect: re-investigating a CLOSED case creates a second case.**
   `find_open_case_for_cluster` only matches open statuses (`engine/signatures.py:33-57`,
   `OPEN_CASE_STATUSES` `constants.py:446-453`), so `_investigate_cluster_run` mints
   `new_id("case-")` (`pipeline.py:816-824`). Probe: closed TP case, reinvestigate → new
   `case_id`, original stays `closed/analyst`.
8. **Human close notifications ignore `triggers.on_closed`.** `_perform_case_action`
   calls `notifier.dispatch(case, TRIGGER_CLOSED)` for `close|confirm_fp|resolve`
   (`routes.py:7419-7437`); `dispatch()` checks only `notifications.enabled` and
   dedup/rate limits (`notifications/dispatch.py:535-625`), never `_triggers_for_case`
   (where `on_closed` defaults `False`, `config.py:3749`). The inbox fan-out goes to the
   assignee, @mentions and every active user whose prefs allow `case_resolved`
   (`dispatch.py:324-379`, `410-431`). No test pins this.
9. **The objection window is display-only.** `decide()` stamps
   `objection_window_expires_at` (`engine/case_manager.py:78-92`); nothing enforces it
   (only display: `webui/.../DecisionCard.tsx:135`, `FactsRail.tsx:219-221`,
   `badges.tsx:646-685`) except runbook auto-attach, which skips a terminal AGENT case
   still inside the window (`engine/runbook_runs.py:1090-1102`). Reopen is allowed at
   any time (`cases:close`).
10. **The webui `caseOutcome` is NOT an exact mirror of the backend authority.** It
    reads only the classification-entry branch (`webui/src/soc/components/outcome.ts:239-262`)
    and ignores the feedback branch that the backend checks FIRST. A QA review stored as
    `FeedbackEntry` on an auto-closed case would be ground truth server-side but still
    render "Auto-closed as false positive" (`outcome.ts:293-309`).

---

## 1. Case model (backend/app/models.py)

`class Case` starts at `models.py:1815`. Lifecycle-relevant fields:

| Field | Line | Type / default | Notes |
|---|---|---|---|
| `status` | 1846 | `CaseStatus = OPEN` | lifecycle axis |
| `disposition` | 1850 | `Disposition \| None = None` | outcome axis; filled from verdict by `apply()` when `None` (`case_manager.py:31-35`, `162-167`) |
| `status_reason` | 1852 | `str = ""` | written only by `hold`/`resolve`/`set_status` (`routes.py:7287`) |
| `escalation_level` | 1856-1864 | `int = 0`, deprecated | any positive = escalated |
| `status_history` | 1866 | `list[StatusHistoryEntry]` | append-only transitions |
| `case_number` | 1870 | `str = ""` | display id |
| `decision_by` | 1871 | `DecisionBy \| None` | LAST-WRITER |
| `objection_window_expires_at` | 1872 | `str \| None` | set only by `decide()` close branch |
| `playbook_id` / `runbook_id` / `runbook_version` | 1880-1887 | | advisory provenance |
| `feedback` | 1889 | `list[FeedbackEntry]` | append-only grades |
| `tags` / `comments` / `assignee` | 1891-1893 | | legacy collaboration |
| `acknowledged_at` / `first_response_at` | 1929-1930 | `datetime \| None` | `acknowledged_at` set on first `acknowledge` (`routes.py:7199-7200`); `first_response_at` has NO writer anywhere (grep) |
| `history` | 1947 | `list[dict]` | append-only free-form events: `decision`, `analyst_action`, `assigned`, `analyst_policy`, `precedent_ratification` |
| `verdict_history` | 1950 | `list[dict]` | per investigation |
| `notifications_sent` | 1956 | `list[dict]` | |
| `automation_actions` | 1972 | | never sets status (#3) |
| `precedent_signal` | 2000 | `dict \| None` | evidence only |
| `analyst_policy` | 2004 | `dict \| None` | durable marker of a declared-benign close |

Sub-models:
- `FeedbackEntry` (`models.py:456-471`): `ts, analyst, assessment` (agree|partial|disagree),
  `accuracy, reasoning_quality, action_appropriateness` (0..1), `actual_outcome`
  (free `str` on the model; validated at the HTTP edge by `FeedbackOutcome`),
  `time_saved_minutes, comment, ai_verdict, ai_confidence`. No provenance/source field today.
- `CaseComment` (`models.py:474-480`): `ts, author, body`.
- `StatusHistoryEntry` (`models.py:483-495`): `from_status, to_status, by, at, reason`.
  `by` is a username for human moves, `agent`/`system` (DecisionBy value) for `apply()`
  (`case_manager.py:172-178`), `analyst_policy` for policy closes (`pipeline.py:1387-1393`).

Storage: ES `CASES_MAPPING` (`es/indices.py:40-83`) is dynamic (no `dynamic: strict`);
`history`, `verdict_history`, `trigger_reason` are `enabled: False` (opaque). A NEW
top-level Case string field is dynamically mapped (date detection on by default for
this index), so free text that looks like a date can fix the field type on first write.
Anything large (screenshots) must not live in the Case document. SQL keeps the whole
case in a JSON `doc` column plus a few indexed columns (`stores/sql/repositories.py:248-259`).
Writes are full replace, no revision / CAS (`stores/cases.py:105-131`): concurrent
read-modify-write paths can lose an update (the notifier re-fetches to avoid this,
`notifications/dispatch.py:648-665`).

## 2. Enums (backend/app/constants.py)

- `Verdict` (`constants.py:413-418`): `FALSE_POSITIVE`, `TRUE_POSITIVE`, `NEEDS_HUMAN`.
- `CaseStatus` (`constants.py:421-440`): `new, open, needs_human, investigating,
  escalated, on_hold, resolved, closed`. `OPEN_CASE_STATUSES` (`446-453`) = first six;
  `TERMINAL_CASE_STATUSES` (`455-458`) = `resolved, closed`.
- `Disposition` (`constants.py:463-474`): `true_positive, false_positive, benign,
  suspicious, duplicate, undetermined`.
- `FeedbackOutcome` (`constants.py:477-490`): `true_positive, false_positive,
  true_negative, false_negative, unknown` (HTTP contract for `actual_outcome`).
- `DecisionBy` (`constants.py:501-515`): `agent, analyst, system, analyst_policy`
  (the docstring explains why `analyst_policy` is its own owner).
- `ActionType` (`constants.py:540-581`): case work uses `STATUS`, `FEEDBACK`, `COLLAB`,
  `DECISION`, `PROPOSAL`, `RUNBOOK`, `THREAD_POST`, `REACTION`, `TASK_UPDATE`,
  `INAPP_NOTIFY`, `NOTIFICATION`.
- `NotificationCategory` (`constants.py:676-684`): `case_new, case_escalated,
  case_resolved, mention, assignment, approval, system, digest`.
- `JobKind` (`constants.py:717-735`): `case_reinvestigate, case_lifecycle, case_assign, case_tag, ...`.

## 3. The automatic path (decide / apply / pipeline)

- `decide()` (`engine/case_manager.py:59-123`) pure over `(verdict, confidence,
  risk_score, policy)`; close branch returns `CLOSED`, `DecisionBy.AGENT`, objection
  window (`78-92`); else `NEEDS_HUMAN`, `DecisionBy.SYSTEM`. Policy defaults
  (`config.py:726-747`): FP auto-close ON (0.85 conf, risk ≤30, 1440 min window), TP OFF
  (0.95, ≤10, 4320 min), NEEDS_HUMAN never.
- `CaseManager.apply()` (`case_manager.py:135-190`): sets status/decision_by/window,
  remaps escalate → `ESCALATED` only on non-close, fills disposition from verdict only
  when `None` (FP→false_positive, TP→true_positive, NEEDS_HUMAN→undetermined, `31-35`),
  appends `status_history` (`by=decision_by.value`) and `history {"event":"decision", ts,
  status, decision_by, escalate, rationale}` (`180-189`).
- Pipeline (`agents/pipeline.py:1124-1212`): `_assemble_case` → ledger cost reconcile →
  `CaseManager(prefs).apply(case)` (`1161`) → `save` (`1162`, publishes `case.changed`) →
  audit `ActionType.DECISION`, `actor="case_manager"`, summary
  `verdict=… status=… decision_by=… risk=… cost=… confidence=… auto_close_gate=…`
  (`1177-1185`, append-only token order) → `agent.step` "decision" frame (`1191-1197`) →
  runbook attach (`1201`) → threshold automation (`1206`) → `_maybe_index_resolved`
  (`1210`) → `_maybe_notify` (`1214`, which DOES evaluate triggers through
  `notifier.notify()`, `pipeline.py:518`, `dispatch.py:627-668`).
- Policy close (no LLM): `_close_by_analyst_policy` (`pipeline.py:1261-1450`), history
  event `analyst_policy` (deliberately not `analyst_action`, `1371-1381`),
  `decision_by=ANALYST_POLICY`, `disposition=FALSE_POSITIVE`; refuses any existing case
  with a verdict or `decision_by == ANALYST` (`1330-1334`) or `force` (`1342-1343`).

## 4. The analyst action path: `POST /api/cases/{case_id}/action`

Endpoint `routes.py:7107-7128`; worker `_perform_case_action` `routes.py:7141-7437`
(shared by single, bulk and the `case_lifecycle` job). Body `CaseAction` (`routes.py:6869-6940`):
`action, note, analyst="analyst", reason, resolution, assignee, priority, tags,
disposition, status, disposition_declared=False, level (deprecated),
open_steps_reason (≤500, whitespace-collapsed), require_open_steps_reason=False`.

Action → status table `_ACTION_STATUS` (`routes.py:6949-6964`):

| action | target | grant (`_case_action_grant`, `routes.py:7050-7068`) | disposition? |
|---|---|---|---|
| `close` | CLOSED | `cases:close` | applies `body.disposition`; classifies only with `disposition_declared` |
| `confirm_fp` | CLOSED | `cases:close` | self-classifies FP (keeps `benign`), `routes.py:7277-7280` |
| `resolve` | RESOLVED | `cases:close` | like close (Round 12 D15) |
| `reopen` | OPEN | `cases:close` | none |
| `escalate` | ESCALATED | `cases:write` | sets `escalation_level ≥1` |
| `deescalate` | OPEN | `cases:write` | `escalation_level=0` |
| `hold` | ON_HOLD | `cases:write` | `status_reason` |
| `resume` | OPEN | `cases:write` | |
| `acknowledge` | INVESTIGATING | `cases:write` | stamps `acknowledged_at` once |
| `set_disposition` | None (status kept) | `cases:write` | self-declaring classification |
| `set_status` | `body.status` | `cases:write`, upgraded to `cases:close` for a terminal target; can never reach CLOSED (`routes.py:7043-7047`) | |

Sets: `_CLOSE_ACTIONS` (`6969`), `_DISPOSITION_ACTIONS = {set_disposition, close, resolve}`
(`6996`), `_SELF_DECLARING_ACTIONS = {set_disposition}` (`7009`), `_TERMINAL` (`7013`),
`_FINAL_CLOSE_ACTIONS = {close, confirm_fp}` (RESOLVED→CLOSED allowed, `7020`).
Guard `_guard_transition` (`7023-7047`): moving out of a terminal status needs `reopen`
(400 `"illegal transition: … reopen the case first"`); `set_status` to CLOSED is 400
`"use the close action to close a case"`.

Order of operations in `_perform_case_action`:
1. 404 / unknown action 400; tags pre-validated (422 on over-length / >25 tags).
2. Escalation level / acknowledge stamp (`7189-7200`), then the guard (`7202`).
3. `set_disposition` without disposition → 400; unknown disposition → 400 (`7207-7214`).
4. Open runbook steps (Round 14 D34, `7220-7240`): only on the FIRST terminal move of a
   non-terminal case; 409 `{"code":"runbook_steps_open", message, required_open, steps}`
   only when `require_open_steps_reason` is set, no reason, not bulk, not a duplicate.
5. Apply vs classify (`7242-7280`): declared → `case.disposition` + `classified_disposition`;
   undeclared → applied only if `standing_analyst_disposition(case) is None`
   (`analyst_outcomes.py:103-132`); `confirm_fp` → FP class.
6. `case.status = target`, `decision_by = ANALYST`, `updated_at` (`7282-7285`);
   `reason = (body.reason or body.note)[:500]` (`7286`).
7. assignee (if changed) / merged tags (`7289-7300`).
8. `status_history` entry if status moved, `by=actor` (`7302-7310`).
9. `history` entry `{"ts","event":"analyst_action","action","analyst","note", [batch],
   [classified_disposition], [resolution], [priority], [assignee]}` (`7312-7338`).
10. `save` (`7340`) → SSE `case.changed`.
11. Audit (best-effort, `7341-7359`): `ActionType.STATUS, surface="case", actor,
    actor_type="human", outcome="success"`, summary
    `action=<a> status <from>→<to> disposition=<d|none>[ reason=…][ classified=<d>]`
    (positional; "never reordered").
12. `case.closed_with_open_steps` row if steps were open (`7362-7370`, via
    `console|api|bulk|proposal`).
13. Runbook re-evaluation for non-terminal moves / tag changes (`7375-7378`).
14. For `close`/`confirm_fp` only: `rag_service.index_resolved_case(case, note=body.note)`
    (`7382-7386`; `resolve` does NOT index) and `draft_suppression_proposal` → pending
    `Proposal` + `ActionType.PROPOSAL` audit, `actor="agent"` (`7389-7413`).
15. Notification dispatch (detached, skipped in Demo) for `escalate` and
    `close|confirm_fp|resolve` (`7414-7437`).
16. Returns `_case_view(case, state)` (`routes.py:6177-6196`); `token_cost` withheld
    without `cost:view`.

Actor: principal username when auth is on, else `body.analyst or "analyst"` (`7125`).

## 5. Every other endpoint that changes a case

| Route | File:line | Grant | Writes | Audit |
|---|---|---|---|---|
| `POST /api/cases/bulk` | `routes.py:7448-7508` | per `_grant_for_body`, once | ≤500 ids, de-duped, one `batch_id = new_id("bulk-")` on every history entry, `via="bulk"` | per case, same STATUS row |
| `POST /api/cases/{id}/feedback` | `routes.py:7543-7598` | `cases:write` (inline) | appends `FeedbackEntry` (analyst = principal), `updated_at`; status/decision_by untouched; re-indexes RAG if terminal | `FEEDBACK`, `actor_type human`, `assessment=… outcome=… accuracy=…` |
| `POST /api/cases/{id}/comment` | `routes.py:7601-7627` | `cases:comment` | `CaseComment(author=body.author)` | `COLLAB`, actor **from body** |
| `POST /api/cases/{id}/tags` | `routes.py:7630-7663` | `cases:write` | replace tags, runbook re-eval | `COLLAB`, actor **from body** |
| `POST /api/cases/{id}/assign` | `routes.py:7666-7700` | `cases:assign` | assignee + history `assigned` | `COLLAB`, actor **from body** |
| `POST /api/cases/{id}/investigate` | `routes.py:7803-7841` | `cases:reinvestigate` | pipeline `force=True` | pipeline rows |
| `POST /api/cases/{id}/reinvestigate` | `routes.py:7853-7912` | `cases:reinvestigate` | pipeline `force=True` (see defects 6, 7) | `DECISION`, `actor="reinvestigate"`, `actor_type agent`, "requested by {body.analyst}" |
| `POST /api/cases/{id}/run-playbook` | `routes.py:7915-7925` | `runbooks:run` | 410 `runbooks_moved` | |
| `POST /api/cases/{id}/notify` | `routes_notifications.py:226` | `cases:write` | `notifications_sent` | NOTIFICATION |
| Runbook runs | `routes_case_runbooks.py:209-398` | `runbooks:*` | KV run store, never the case status (#3) | `run.*` / `step.*` actions |
| Thread / reactions / tasks | `routes_cases_collab.py:486-821` | `cases:comment` / `cases:write` | KV stores, author from principal (`_resolve_author`) | THREAD_POST / REACTION / TASK_UPDATE + `case.activity` SSE |
| Jobs `case_lifecycle` | `engine/jobs.py:748-774` | `_grant_for_body` (`routes_jobs.py:470-476`) | `_perform_case_action(..., batch_id=f"bulk-{job_id}", via="bulk")`, actor `job.actor` | per case |
| Jobs `case_assign` / `case_tag` | `engine/jobs.py:776-806` | `cases:assign` / `cases:write` (`routes_jobs.py:466-469`) | calls the legacy endpoints with `analyst=job.actor` | COLLAB |

Job params: `CaseLifecycleParams` (`routes_jobs.py:126-164`) carries `action, note, reason,
resolution, disposition, disposition_declared, status, open_steps_reason`; NOT
`require_open_steps_reason` (pinned by `webui/src/lib/types-contract-pins.ts:358-363`).

Other case writers: ingest attaches (`engine/ingest.py:273,446,678`), RAG precedent
bootstrap (`api/routes_rag.py:383,423`, history `precedent_ratification`), demo seeding
(`state.py:3552-3582`), automation `save` (`pipeline.py:538`), notifier re-fetch save.

## 6. RBAC for case work (backend/app/rbac/policy.py)

`RESOURCES["cases"] = ["read","write","close","assign","comment","reinvestigate"]`
(`policy.py:52`). Defaults (`policy.py:435-521`):
- `super_admin`: all; `soc_manager`: `cases:*`, `audit:view,export`, `users:manage`.
- `analyst_tier2`: read, write, close, assign, comment, reinvestigate.
- `analyst_tier1` and `responder`: read, write, comment, assign (**no `close`** and no
  reinvestigate) but `set_disposition` (classification) needs only `cases:write`.
- `auditor`: `cases:read` only; `audit:view,export`.
No role-specific "QA reviewer" grant exists; no `audit:view` for analysts. RBAC is a
no-op when disabled (the "rbac switch" is another reader's scope).
Webui mirror: `ACTION_PERMISSION` (`webui/src/soc/pages/casedetail/shared.tsx:106-118`).

## 7. Audit vocabulary for case work

Category table `backend/app/audit/event_categories.json`: legacy `(status,*)` → "Case
status changed", `(collab,*)` → "Case updated", `(feedback,*)` → "Verdict graded",
thread_post/reaction/task_update/proposal/report → case_work (lines 32-39); structured
prefixes `case`, `run`, `step`, `report` → case_work (lines 81-84); exact
`case.closed_with_open_steps` → "Case closed with open steps" (line 175); actor lists for
derived actor_type (lines 188-198: agent `reinvestigate`, `agent`, …; system
`case_manager`, `analyst_policy`, `automation`, `notification`, …). A new structured
`case.<verb>` action lands in "Case work" automatically via the prefix; an exact label
needs a row in this JSON (a contract test reads it from the webui side too).
`AuditDoc` (`models.py:2223-2324`) supports `action` (`^[a-z_]+\.[a-z_]+$`, ≤64),
`target`, `changes`, `client`, `session_ref`, `request_id`; `audited_write`
(`audit/write.py:218`) is the audit-first helper. `state.audit.record` signature
`audit/audit_log.py:103-158`.

## 8. SSE frames

- `case.changed` on topic `cases` after EVERY successful save, payload
  `{case_id, status, updated_at, created}` only (`realtime.py:521-550`, producers
  `stores/cases.py:126-131`, `stores/sql/repositories.py:268-270`). Gated by `cases:read`
  (`routes.py:439-455`).
- `agent.step` on `cases:{id}` (pipeline, `pipeline.py:427`).
- `case.activity` on `cases:{id}` (collab only, `routes_cases_collab.py:291-315`);
  lifecycle actions publish no `case.activity`.
- `case.runbook` on `runbooks` (`realtime.py:553-577`).
- `inapp` on `notifications` (audience = recipient, `dispatch.py:482-490`).
Event names are mirrored in `webui/src/lib/useEventStream.ts` (`realtime.py:80-113`).

## 9. Notifications and inbox on close

- Human: `dispatch(case, "closed")` for close/confirm_fp/resolve, `"escalated"` for
  escalate (`routes.py:7419-7437`); requires `notifications.enabled` (default `False`,
  `config.py:3806`); bypasses trigger booleans and risk floors (fact 8).
- Automatic: `notify()` evaluates `_triggers_for_case` (`dispatch.py:167-192`) and floors.
- Category map: `closed` → `case_resolved` (`notifications/inapp.py:56-66`).
- Recipients: assignee + @mentions always; every active user (role tier) filtered by
  per-category `NotificationPref`, quiet hours / digest defer (`dispatch.py:324-475`).
- `InboxStore` (`stores/inbox.py:76-560`, ring of 200 per user, `append`, `fanout`,
  `defer`); `InAppNotification` (`models.py:1440-1468`). A QA "review requested" item can
  use category `assignment` and `append` directly (no need for the dispatch path).

## 10. Noise counters "Closed by human"

`engine/noise_counters.py`: `_is_auto_cleared` = terminal + AGENT + FP verdict (`215-221`);
`_is_policy_closed` (`224-226`); `_is_human_closed` = terminal + `decision_by == ANALYST`
(`229-240`); stage `_stage("closed", "Closed by human", …)` (`458`). Webui mirror
`isHumanClosedNoiseCase` (`webui/src/soc/pages/Cases.tsx:239-244`). Both last-writer.

## 11. Runbook open steps on close

`open_required_steps` (`engine/runbook_runs.py:1962-1970`, unreadable store → `None`,
never blocks); `record_closed_with_open_steps` (`1973-2002`, strict row,
`ActionType.RUNBOOK`, `action="case.closed_with_open_steps"`, `tool_input {via, reason,
note, required_open, steps[:40]}`, summary `Closed with N required runbook step(s) open[ (Duplicate)].`).
The Console sends `require_open_steps_reason` (`webui/src/soc/pages/CaseDetail.tsx:1171-1185`);
bulk sends one optional shared reason (`BulkCloseDialog.tsx:53-62,144-147`). `decide()` /
`case_manager.py` must never mention "runbook" (`tests/test_runbook_close_reason.py:311-315`).

## 12. Where human closes and AI auto-closes are distinguished

Backend (all LAST-WRITER on `decision_by` unless noted):
- `quality_metrics` auto/human/system partition (`metrics.py:670-785`, caveat 696-710).
- `trend_metrics` (`metrics.py:1429-1560`), `_auto_close_tally`/`auto_close_health`
  (`metrics.py:1671-1930`).
- **Non-erasable** `recorded_auto_close_health` from `history[event=decision]`
  (`metrics.py:2000-2160`, `decision_records` `2128-2155`): immune to later analyst
  actions. Prefer this for any new "AI vs human" surface.
- `case_aggregate` `closed_by` (`case_aggregate.py:80-82,579-588`), queue filter values
  `CASE_QUEUE_CLOSED_BY = ("agent","analyst","analyst_policy","system")` (`routes.py:6250`).
- MTTA/MTTR human anchors skip `by in {"system","agent","analyst_policy"}`
  (`metrics.py:383-421`, `_CaseTimings` 446-505). With auth off the actor `"analyst"` counts as human.
- `precedent.rule_outcome_tally` (`precedent.py:738-779`) and `is_policy_closed`
  (`715-735`, reads the durable payload because `decision_by` is erasable).

Webui (`webui/src/soc/components/outcome.ts`):
- `caseOutcome` precedence (`239-327`): `analyst` (decision_by analyst + classification
  entry) → `analyst_policy` → `analyst_unrecorded` (terminal, analyst, no entry:
  "Closed by analyst: outcome not recorded") → `agent_auto` ("Auto-closed as false
  positive") → `pending` (AI headline). `CLASSIFICATION_ACTIONS` mirror at line 73.
- `isHumanClosed` (`398-401`: terminal and analyst|analyst_policy), `isHumanSettled`
  (`393-395`), `outcomeCellText` (`335-366`), `pendingDispositionNote` (`382-391`).
- Consumers: `CaseHoverCard.tsx:91`, `CaseDetail.tsx:1543`, `OverviewPanel.tsx:93,169,844-845`,
  `InvestigationPanel.tsx:43,153-155`, `Cases.tsx:1414-1416`, `CaseManager.tsx:360`,
  `Overview.tsx:1187`.

Close dialog today (`webui/src/soc/pages/casedetail/shared.tsx`): `close_disposition`
("Close with a disposition", wire `close`, fields disposition/resolution/tags/grading,
`192-205`), `confirm_fp` (`177-190`), `resolve` (disposition/reason/tags/grading,
`259-272`), `set_disposition` (`282-293`), `DISPOSITION_OPTIONS` pinned to the generated
schema (`132-150`), `RESOLUTION_OPTIONS` handled|benign|duplicate|no_action|other
(`295-301`, stored only on `history[].resolution`, read by nothing server-side).
Picker opens EMPTY; `disposition_declared` only when operated (`CaseDetail.tsx:1116-1133,
1162-1168`). Grading is a separate best-effort `caseFeedback` POST after the close; the
assessment is derived agree/override at submit, `actual_outcome` only when stated
(`CaseDetail.tsx:1240-1300`, `grading.tsx:144-262`). Toast offers Reopen for 8 s.

## 13. Ground-truth consumers (what a QA verdict would feed)

`analyst_confirmed_outcome` / `_confirmation` (`analyst_outcomes.py:135-192`) is read by:
- **Threshold tuner** `_accumulate_rule_stats` (`threshold_tuner.py:317-385`): reads
  TERMINAL cases only (`terminal_case_reader` `1028-1078`, window `_WINDOW_DAYS`
  nightly 14 d); per rule `observed`, `total` (= independent labels), `fp`, `tp`,
  `feedback_labels` vs `disposition_labels`, `bulk_ratified` (visibility only);
  ungraded policy closes skipped (`339-340`); `fp_lower_bound = wilson_lower_bound(fp,
  total, z)` (`158-173`, `380`). Proposals review-first; shadow-eval forces review if a
  change would hide a confirmed TP (`837-868`). Provenance payload `246-270`.
- **RAG precedent** `_resolved_case_item` (`tools/rag.py:2829-2880`): only confirmed
  cases; trust `analyst_confirmed`; note from feedback comment or last
  `analyst_action.note` (`2757-2783`); `index_resolved_case` on close/confirm_fp/feedback
  when terminal (`3899-3936`). Unconfirmed tier requires `decision_by == AGENT` and no
  label (`2998-3025`); a label moves the case to the confirmed tier. Admission cap groups
  by `history[].batch`, else the hour bucket of the classification/feedback ts
  (`rag.py:3220-3260`, `_ADMISSION_TIME_BUCKET_SECONDS = 3600`).
- **Precedent promotion** `evaluate_precedent_signal` (`precedent.py:326-470`) reads the
  corpus metadata (`analyst_confirmed` tier only, `PROMOTABLE_TRUST_CLASS` line 69):
  unanimity + count bar. So QA-confirmed FPs on auto-closed cases raise future
  promotion for that rule: a self-reinforcing loop if reviewers rubber-stamp.
- `metrics.analyst_confirmed_fp_count` (`metrics.py:652-667`), `case_aggregate`
  `analyst_fp/tp` (`case_aggregate.py:1025-1038`; push-down projections list the fields
  the rule reads, `_ANALYST_FIELDS = ("feedback","history","decision_by","disposition",
  "analyst_policy", …)` at `1603-1607`: **a ground-truth input stored anywhere else is
  invisible to exact aggregates**), `ground_truth_supply` (`analyst_outcomes.py:204-290`),
  diagnostics (`routes_diagnostics.py:462,2022`).

Agent effectiveness (`engine/agent_improvement.py`, `GET /api/metrics/agent-improvement`
`routes_metrics.py:799`, page `webui/src/soc/pages/AgentEffectiveness.tsx`):
- `_select_feedback` (`134-183`): latest valid grade per case; requires assessment in
  agree|partial|disagree; policy closes excluded. Quality = agreement, material
  corrections (disagree or outcome conflicts with `ai_verdict`, `111-123`), false-negative
  rate (`201-245`), Wilson interval (`186-198`), minimum sample 30 (`_QUALITY_MIN`, line 51).
- `_turnaround_samples` (`406-477`): human ack (`investigating|escalated|on_hold`) to
  human terminal, actors outside `_NON_HUMAN_ACTORS` (`30-48`).
- `_agent_reopen_summary` (`491-536`): a human reopen within 24 h of a terminal
  `status_history` entry `by == "agent"`. A QA reviewer reopening a sampled case inside
  24 h raises this rate.
- `_closure_samples` (`652-710`): agent vs human-owned by terminal `by` / `decision_by`.
- `feedback_stats` (`metrics.py:122-165`, `GET /api/feedback/stats` `routes.py:3261`):
  agreement over agree/partial/disagree signals, outcome distribution.
A QA cohort drawn only from auto-closed cases changes the population these read
(selection bias toward FP-predicted cases); without a provenance marker it cannot be
reported separately.

## 14. Design constraints for a structured close form and a post-close QA review

Structured close form:
- Keep the existing wire: `close`/`resolve` with `disposition` + `disposition_declared`
  is the only path that classifies; the picker must stay empty until operated.
- New structured fields (e.g. root cause category, actions taken, resolution summary)
  are additive. Safe homes: the `analyst_action` history entry (opaque in ES), or a new
  KV store (#12). A new top-level Case field is dynamically mapped on ES.
- Free text a person types into the close note is model-facing precedent (500 chars)
  and is fenced as UNTRUSTED when retrieved; new free-text fields should NOT be fed to
  the precedent text unless intended and disclosed (`DURABLE_CONTEXT_NOTE`, pinned by
  `soc/pages/casedetail/__tests__/analyst-note-disclosure.test.tsx`).
- Add the structured `action` (e.g. `case.closed`) only if the existing positional
  `result_summary` stays byte-identical (tests read it,
  `tests/test_g1_ground_truth_intake.py:303` "appends the classification without reordering").
- Resolve the actor from the principal for every new writer (do not copy the
  body-actor pattern of comment/tags/assign).

Post-close QA review:
- Never call `_perform_case_action`, never set `status`/`decision_by`/`disposition` on
  the reviewed case unless the reviewer explicitly reopens (a separate, normal action).
- Record the verdict as `FeedbackEntry` (or a parallel structure the ground-truth rule
  is extended to read, in BOTH `analyst_outcomes._confirmation` and
  `case_aggregate._ANALYST_FIELDS` and the webui `caseOutcome`). Add an additive
  provenance field (e.g. `source="qa_review"`, `sample_id`) so `agent_improvement`,
  `feedback_stats` and the tuner provenance can report the QA cohort separately.
- `actual_outcome` only from an explicit reviewer choice; `unknown` default must stay
  "no label" (`analyst_outcomes.py:18-22`, `tests/test_g1_ground_truth_intake.py:352`).
- Sampling must sit outside `decide()`/`apply()` and must not read or write anything
  `decide()` reads (#3); persist sample state in KV (#12); prefer a deterministic,
  seeded sampler (hash of case id) so the selection is auditable and replay-safe; audit
  sample creation and review (#2) with structured actions (`case.*` prefix → Case work).
- Sample only `decision_by == AGENT` terminal cases (or the recorded first decision
  `decision_records(...)[0].auto_closed`), exclude policy closes (`is_policy_closed`).
- Feedback on a terminal case triggers `index_resolved_case` (`routes.py:7590-7596`):
  a QA-confirmed FP becomes analyst-confirmed precedent and feeds promotion.

## 15. Tests that pin current behaviour (update if renamed or redesigned)

Backend (`backend/tests/`):
- `test_g1_ground_truth_intake.py` (lines 119-513: declared close labels, echo is not a
  label, flag inert without disposition, audit summary order, unknown default, supply).
- `test_analyst_classification_wins.py` (83-272: confirm_fp semantics, standing
  disposition, bulk confirm_fp, precedent learns).
- `test_case_status_transitions.py` (51-268: hold/resume/resolve, set_status cannot
  close, terminal needs reopen, RESOLVED→CLOSED, legacy enum load).
- `test_runbook_close_reason.py` (98-397), `test_round14_bulk_close_job_reason.py`,
  `test_round14_runbook_event_labels.py`, `test_audited_write.py`.
- `test_case_actions_reinvestigate.py` (reinvestigate in place, provenance, audit).
- `test_wave6_decide_guard.py` (decide source snapshot, NEEDS_HUMAN never closed,
  decide is the only producer of CLOSED), `test_overhaul_b3_observability.py`,
  `test_round4_wave3_wiring.py`, `test_round5_w0f_preview_decision.py` (source guards).
- `test_round7_noise_counters.py` (421, 441: closed stage needs ANALYST),
  `test_round12_case_aggregate.py`, `test_p3_kpi_populations.py`,
  `test_metrics_trends_and_cache.py`, `test_recorded_auto_close.py`.
- `test_precedent_authority.py`, `test_precedent_corpus*.py`,
  `test_unconfirmed_precedent_tier.py`, `test_proposal_lifecycle.py`.
- `test_agent_improvement.py`, `test_round12_case_manager.py`,
  `test_round12_case_mutation_bands.py`, `test_case_tags_never_cut.py`,
  `test_metrics_breakdown.py`, `test_notifications.py`.

Webui (`webui/src/`): `soc/components/__tests__/outcome.test.ts`,
`soc/pages/casedetail/__tests__/{ConfirmActionDialog,ConfirmActionDialog.tags,BulkCloseDialog,
FactsRail,OverviewPanel,CaseHeaderMeta.tags,analyst-note-disclosure}.test.tsx`,
`soc/pages/casedetail/__tests__/case-copy.punctuation.test.ts`,
`soc/pages/__tests__/{CaseManager,CaseDetail.resolved,CaseDetail.grading,CaseDetail.footer}.test.tsx`,
`soc/runbooks/run/__tests__/{close-with-open-steps,case-surfaces}.test.tsx`,
`soc/__tests__/cases.round14.test.tsx`, `lib/types-contract-pins.ts`,
`lib/__tests__/api-types-gen.test.ts` (generated wire types).

## 16. Pre-existing defects found (candidates for fixes or spawned tasks)

1. Reinvestigate of an open case drops assignee/comments/feedback/status_history/
   acknowledged_at/escalation_level/disposition (probe-confirmed; `pipeline.py:1555-1678`).
2. Reinvestigate of a closed case creates a new case (probe-confirmed; `pipeline.py:816-824`).
3. Audit actor from the request body on comment/tags/assign (`routes.py:7623,7653,7697`)
   and the reinvestigate summary (`routes.py:7894-7905`).
4. Lifecycle notifications ignore `triggers.on_closed`/`on_escalated` and risk floors
   (`routes.py:7419-7437` vs `dispatch.py:535-625`).
5. `set_disposition` / same-status close on an AI auto-closed case moves it into the human
   column of every last-writer metric (fact 1).
6. Webui `caseOutcome` ignores feedback ground truth (fact 10).
7. `first_response_at` is never written (`models.py:1930`); `resolution` is stored but
   never read server-side (`routes.py:7332-7333`).
