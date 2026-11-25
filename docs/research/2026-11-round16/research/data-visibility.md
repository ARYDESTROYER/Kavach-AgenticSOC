# Round 16 research: data visibility audit (data-model side)

Report key: `data-visibility`. Repository: `/home/user/Kavach-AgenticSOC`, branch `claude/round16`
(HEAD `3cd362c`, "Journal: Round 16 start", on top of `3cfd5c0`). Read-only: nothing in the
repository was edited. Five throwaway probe tests were written to the scratchpad
(`.../scratchpad/round16/dv-probe/test_dv_probe*.py`) and run against the existing offline test
harness (`tests/test_round3_wave5_rbac._client`, auth on, RBAC on, in-memory ES, mock LLM).

Companion report: `explainability.md` (same folder) covers "every number explainable" (risk 81
worked example, the `Explain` popover pattern, metric definitions). This report does not repeat it;
where the two overlap it says so (for example its D1, D5 and D-API-1).

## 1. Summary

The backend records far more than the Console shows. Most case facts have a home in the facts
rail or a tab, but six classes of data are either hidden or unreachable for an analyst:

1. **The raw events behind a case cannot be seen from the case at all.** The Case stores only
   member event ids. There is no `GET /api/cases/{id}/events`, `GET /api/logs` has no id filter,
   the clustering diagram deliberately hashes the ids, and the evidence `event_ids` the model cited
   are never rendered. For the 16 push receivers there is no re-fetch path at all
   (`fetch_by_ids` exists only on pull connectors), so the raw record is gone once the live-tail
   ring rolls.
2. **Per-call AI usage is not reachable anywhere.** Every model call writes one `UsageDoc` with
   model, input, output and cache tokens, tier, latency, pricing source, attempts, failure class
   and an "estimated" flag. The only read is the aggregate `GET /api/usage/summary`. The case
   trace divides each role's total evenly across that role's steps and shows the quotient as if it
   were that step's cost; `latency_ms` is always `null`.
3. **Trace step details are missing in the case.** `tool_input`, the full tool output summary,
   the prompt excerpt and per-row build provenance exist on the audit row, and
   `GET /api/cases/{id}/trace` returns them, but the Console never calls that route. The only path
   is "View in audit log", which needs `audit:view`, a grant that Tier 1 and Tier 2 analysts do not
   hold by default.
4. **Analyst-entered text is stored and never shown back.** The status reason the Hold and
   De-escalate dialogs collect (`Case.status_reason`, `StatusHistoryEntry.reason`) and the
   `resolution` note on a history entry are never rendered. "New events attached" history entries
   are dropped too.
5. **Findings are cut to their first sentence** with no way to expand
   (`InvestigationPanel.tsx`, `firstSentence(finding.summary)`).
6. **Enrichment, grading and precedent are shown as one headline number** while the record
   carries the breakdown: per-provider results for an indicator, the three grading scores, the
   AI verdict that was graded, and the precedent counts and thresholds.

Confirmed defects found on the way (section 5):

- **DV-1 (high, security):** `GET /api/cases/{id}/trace`, `/rationale` and `/export` (and
  `/api/scans`, `/api/standup`) have no permission dependency. A user whose `cases:read` is denied
  gets 403 on `GET /api/cases/{id}` and 200 with the whole case on `/export`. Reproduced.
- **DV-2 (medium):** the investigation trace projects every audit row of the case, so a person's
  Acknowledge, tag and comment and a case-chat question appear as `invoke_agent` spans named after
  the person. The "Agent" filter lists them as AI steps. Reproduced.
- **DV-3 (high, already D1 in `explainability.md`):** the Decision card reports a read-time
  re-run of `decide()` under today's policy. Independent reproduction by changing the policy:
  a case auto-closed by the agent then reads "needs_human, decided by system, auto-close off".
- **DV-4 (medium):** per-step cost and tokens in the trace are an even split, unlabelled.
- **DV-5 (low):** the trace silently drops audit rows past the newest 500, and its cost totals
  read only the last 365 days of the ledger while `Case.token_cost` is lifetime.

The recommendations (section 6) are ordered by analyst value. The top five fit Round 16:
gate the three routes (S), a case **Events** view with Table and JSON tabs (M), a per-case
**AI usage** popover with the exact cost formula (M), inline **step details** in the trace with
spans classified by `actor_type` (M), and the small "show what is already stored" fixes for
findings, reasons, attach events, grading and enrichment (S each).

## 2. Method

- Read `AGENTS.md` sections 1, 4, 5 and 10, `backend/app/models.py` (Case, AuditDoc, UsageDoc,
  FeedbackEntry, StatusHistoryEntry, ThreatContextPanel, ProviderResult, runbook run models,
  Campaign, BaselineState), the case routes (`api/routes.py`, `routes_triage.py`,
  `routes_auto_close_review.py`, `routes_campaigns.py`), `engine/case_rationale.py`,
  `engine/threat_context.py`, `engine/clustering_explain.py`, `engine/risk.py`,
  `engine/case_cluster.py`, `llm/pricing.py`, `stores/usage.py`, `rbac/policy.py`.
- Read the Console's case surfaces: `CaseDetail.tsx`, `casedetail/FactsRail.tsx`,
  `InvestigationPanel.tsx`, `DecisionCard.tsx`, `WhyPanel.tsx`, `InvestigationInputs.tsx`,
  `OverviewPanel.tsx`, `SignalProfile.tsx`, `StageTimeline.tsx`, `ThreatContextPanel.tsx`,
  `CaseHistory.tsx`, `grading.tsx`, `components/TraceTimeline.tsx`, `components/audit/*`,
  `lib/api.ts`, `CaseDetail.api.ts`, `Cost.tsx`.
- For each of the 67 `Case` fields, grepped `webui/src` (excluding tests, `types.ts` and the
  generated `api-types.gen.ts`) to find the rendering site, then read that site.
- Ran five probes (outputs quoted in section 5). Commands:
  `cd backend && . .venv/bin/activate && PYTHONPATH=$PWD python -m pytest -q -s -p no:cacheprovider --rootdir=$PWD <scratchpad>/dv-probe/test_dv_probeN.py`.

## 3. Case field coverage (what the model carries vs what the Console renders)

Legend: **Shown** (visible on the case), **Partly** (some of it, or only a derived form),
**Never** (no Console rendering outside JSON or Markdown export), **Intentional** (hidden on
purpose by an earlier decision).

| Case field | Status | Where today | Gap |
|---|---|---|---|
| `case_id`, `case_number` | Shown | Rail, Record | none |
| `cluster_signature` | Shown | Overview, What happened, Correlate stage step | none |
| `app_version`, `build_sha` | Shown | Rail, Record "Creation build" | per-run build not shown (audit rows carry it) |
| `created_at`, `updated_at` | Shown | Rail, Times | none |
| `source_surface`, `origin_surface`, `source_id`, `source_name`, `detection_source` | Shown | Rail, Source | none |
| `rule_ids` | Shown | Rail, Source (RuleLink opens the rule sheet) | none |
| `entity` | Shown | Rail, Overview Key entities | only the primary entity exists on the model |
| `member_event_ids`, `member_event_keys` | Partly | a count in `SignalProfile.tsx:271`; hashed refs in the clustering diagram | **the events themselves are unreachable** (R2) |
| `risk_score`, `risk_breakdown` | Partly | rail meter, factor bars, Risk stage arithmetic with today's weights | scoring inputs not persisted (explainability D5, D-API-1) |
| `verdict`, `confidence`, `decision_by`, `objection_window_expires_at` | Shown | header, rail Outcome | Decision card can contradict (DV-3) |
| `evidence[].summary` | Partly | Findings show **only the first sentence** (`InvestigationPanel.tsx:243`) | R5 |
| `evidence[].event_ids` | Never | (Investigate page counts them only) | R5 with R2 |
| `evidence[].query` | Shown | Findings, InlineCode | none |
| `mitre`, `recommended_action`, `reproduce_query` | Shown | Threat context, Overview, AI assessment | none |
| `status`, `disposition` | Shown | header, rail | none |
| `status_reason` | Never | written by `hold`, `resolve`, `set_status` (`routes.py:7701`) | R6 |
| `status_history` | Partly | only to derive the Closed clock (`caseFacts.ts:131`) | `reason` and `by` per move never shown (R6) |
| `history` | Partly | `CaseHistory.tsx:101` renders 5 event kinds | `attach` and `resolution` dropped (R6) |
| `verdict_history` | Shown | rail Record | none |
| `feedback` | Partly | `GradingHistory` (`grading.tsx:436`): assessment, outcome, minutes saved, comment | three scores, graded verdict snapshot, origin not shown (R8) |
| `tags`, `comments`, `assignee` | Shown | rail, Collaboration | none |
| `title`, `summary`, `error` | Shown | header, Overview | none |
| `awaiting_reason` | Partly | only inside the candidate's summary sentence | R13 (also explainability) |
| `token_cost` | Partly | rail "Investigation cost" (cost:view) | no breakdown; case-chat spend excluded and shown nowhere (R3) |
| `agent_persona`, `runbook_id`, `runbook_version`, `playbook_id` | Shown | rail Record | none |
| `severity_band`, `severity_source`, `impact_band`, `urgency_band`, `priority_level` | Shown | rail Signal | see explainability D7, D9 |
| `detected_at`, `acknowledged_at`, `first_response_at` | Shown | rail Times (when set) | none |
| `first_seen_millis` | Never | used only by posture metrics | show "First event" with MTTD (explainability) |
| `campaign_id` | Shown | rail campaign chip | none |
| `trigger_reason` | Shown | Overview sentence, clustering diagram (mode, n, window, group by) | none |
| `notifications_sent` | Partly | rail, last 5 only, `channel_id` not shown (`FactsRail.tsx:529`) | R15 |
| `related_case_ids`, `cross_source_cluster_id`, `source_breakdown` | Shown | Overview Related cases, clustering diagram | none |
| `automation_actions` | Shown | `AutomationApplied.tsx` | none |
| `knowledge_used` (lifetime) | Partly | the latest run's knowledge via `/rationale` | lifetime list not shown (low) |
| `retrieval_history_status`, `retrieval_observation_status` | Partly | latest-run `retrieval_status` in `WhyPanel` | the lifetime markers are never shown (low) |
| `precedent_signal` | Partly | one sentence only when `qualifies` (`DecisionCard.tsx`) | counts, thresholds, reason never shown (R9) |
| `analyst_policy` | Shown | Decision card, History | none |
| `escalation_level` | Intentional | deprecated, never displayed | none |

## 4. Records beyond the Case

### 4.1 Audit rows of the case (`AuditDoc`)

Three routes project the same `records_for_case` rows (newest 500, oldest first):

- `GET /api/cases/{id}/timeline` (`routes_triage.py:208`) is what the Console uses. `_row_to_span`
  (`routes_triage.py:316`) keeps only `actor`, `action_type`, `model`, `tool_name`, a summary
  (`tool=... · query=...` for tool rows, `result_summary` otherwise) and a cost slice. Its own
  docstring says "the heavy payload is left in the audit doc (referenced by `payload_ref`)", but
  `payload_ref` carries no record id, so nothing can fetch it.
- `GET /api/cases/{id}/trace` (`routes.py:8498`) returns `tool_input`, `tool_output_summary`,
  `prompt_excerpt` (when `prefs.trace.include_prompts`), `query_text`, `app_version`, `build_sha`.
  **No Console caller** (`grep` of `webui/src` finds none).
- `GET /api/cases/{id}/rationale` (`routes.py:8517`) shows, for the latest run only, the tools
  with their query and output summary, knowledge, memory, three enrichment scalars and the
  decision line.

Not reachable from the case for an analyst: `tool_input` (the structured arguments the agent
passed), `prompt_excerpt` (what the model was actually shown, fenced), the Round 14 fields
`outcome`, `actor_type`, `run_id`, `request_id`, per-row build, and every row of earlier runs
except through the audit log. The audit log inspector (`AuditInspector.tsx`) does show all of
them with a JSON tree, but only for `audit:view`, which `_ANALYST_TIER1` and `_ANALYST_TIER2`
(`rbac/policy.py`) do not grant. The trace's "View in audit log" link is hidden for them
(`AuditLink.tsx`, `useCan('audit','view')`).

### 4.2 Usage ledger (`UsageDoc`)

Fields: `model`, `role`, `surface`, `prompt_tokens`, `completion_tokens`, `cache_read_tokens`,
`cache_write_tokens`, `cost`, `latency_ms`, `processing_tier`, `batch`, `pricing_source`,
`attempts`, `failure_class`, `usage_estimated`, `outcome`, build provenance.

- Only aggregate reads exist: `GET /api/usage/summary` (`routes.py:8642`, `cost:view`) and the
  exact pipeline total used to reconcile `Case.token_cost`. There is no endpoint that lists rows,
  for a case or at all (`grep "@router.get(\"/usage"` finds only `/usage/summary`). The Cost
  page's "detailed ledger" is the by-model, by-role and by-surface aggregate. Per-call rows reach
  a person only through the admin data export (usage NDJSON, `data_export:export`).
- The rates are not stored. `cost_for` (`llm/pricing.py:384`) computes
  `prompt/1e6 x in + completion/1e6 x out + cache_read/1e6 x 0.1 x in + cache_write/1e6 x 1.25 x in`
  (or the registry's cache rates, or 2.0x for a 1 hour write), then x 0.5 for Batch, rounded to
  8 places, with `in` and `out` from the registry or the per-model price overlay at call time. A
  later price change or overlay edit makes a stored cost impossible to re-derive.
- Case chat usage rows carry `case_id` (probe 5: `('chat', 'case-chat', 'chat')`) but
  `Case.token_cost` counts only router, investigator and formatter roles
  (`CASE_PIPELINE_USAGE_ROLES`), so chat spend on a case is shown nowhere on the case.

### 4.3 Enrichment and threat context

`engine/threat_context.py:_ioc_section` (line 46) returns, per indicator, `score`, `is_malicious`,
`country`, `cached`, `sources` (provider to score) and, for non-IP indicators, `providers` (every
`ProviderResult` with `score`, `malicious`, `confidence`, `tags`, `raw`, `ok`, `error`, fenced by
`fence_provider_result`). `ThreatContextPanel.tsx:60 iocSource` shows the **first provider name
only**; the per-provider list, errors, the fusion method (`max` by default, `weighted` opt-in) and
`raw` are dropped.

Two different reputation numbers exist and are not labelled: the threat-context panel calls the
enrichment tool **at view time**, while the risk factor `reputation` and the rationale's
`enrichment` come from the **investigation-time** CONTEXT row. A cache fill after triage can show
"Reputation 87, Malicious" next to a risk breakdown with `reputation 0`.

### 4.4 Grading, review and precedent

- `FeedbackEntry`: `accuracy`, `reasoning_quality`, `action_appropriateness` (0 to 1),
  `ai_verdict`, `ai_confidence` (what was graded), `origin`, `review_id` are not rendered by
  `GradingHistory`.
- Review ledger: `CaseReviewState` (`routes_auto_close_review.py:158`) is rendered (pending,
  completed, expired). Why the case was sampled (about 5%, daily cap, per-rule cap) is not said;
  low value.
- `precedent_signal` (`engine/precedent.py:300 as_dict`): `status`, `reason`, `rule_identity`,
  `confirmed_false_positive`, `confirmed_true_positive`, `retrieved_matching`, `top_score`,
  `min_confirmed`, `min_similarity`, `truncated`. The Console shows one sentence and only when it
  qualifies, so "3 confirmed benign of the 5 needed, did not qualify" is never visible.

### 4.5 Runbook runs, campaigns, baseline, tuning

These surfaces are recent and largely complete: `WhyAttached.tsx` shows the match explanation,
`LookupEvidence.tsx` the lookup table with `count_relation` and `window_clamped`, the Campaigns
page the shared entities, MITRE and severity rollup, and `BaselineGauge.tsx` warm-up and
percentiles. Small gaps only: an AI step draft does not show its model or cost (`ai_draft.model`,
`usage_id`); tuning counts are covered by explainability D6.

### 4.6 Where a person cannot reach the data at all

| Data | Reachable by whom today |
|---|---|
| Raw member events of a push-source case after the live-tail ring rolls | nobody |
| Raw member events of a pull-source case | only by leaving the case and searching Logs by entity and time (no id filter) |
| Per-call model, tokens, cache, tier, latency, attempts, estimated flag | nobody in the Console; admin data export only |
| The rate used to price a call | nobody (not stored) |
| Case-chat spend on a case | nobody per case |
| `tool_input`, `prompt_excerpt` of an investigation | `audit:view` holders through the audit log (not Tier 1 or Tier 2) |
| Status reason of a hold, resolution note | `audit:view` holders (audit `changes`), JSON export |
| Rest of a multi-sentence finding | JSON or Markdown export only |
| Per-provider enrichment results | nobody (IP path drops them; non-IP path returns them and the Console drops them) |

## 5. Defects (confirmed)

### DV-1. Three case read routes ignore `cases:read` (high, security)

`case_trace` (`routes.py:8498`), `case_rationale` (`routes.py:8517`) and `case_export`
(`routes.py:8191`) declare no `require_permission`; the router-level `require_auth` only
authenticates. The same holds for `scans` (`routes.py:8579`), `scan_notifications` (8591) and
`standup` (8603). With `Preferences.rbac.denies = {analyst_tier1: {cases: [read]}}`:

```
PROBE {'/api/cases/any-id': 403, '/api/cases/any-id/trace': 200, '/api/cases/any-id/rationale': 200,
       '/api/cases/any-id/export': 404, '/api/cases/any-id/timeline': 403, '/api/cases/any-id/stages': 403,
       '/api/scans': 200, '/api/standup': 200}
PROBE get 403
PROBE export 200 True ...            (an existing case: the full case JSON is returned)
PROBE rationale 200 ['case_id', 'confidence', 'decision_by', 'decision_rationale', 'enrichment', ...]
```

The trace carries prompt excerpts and tool output (log-derived data) and the export carries the
whole case, so a deny is not honoured. The existing test
`test_round3_wave5_rbac.test_read_routes_honor_cases_and_sources_read_deny` covers the list and
detail routes but not these. Fix in R1.

### DV-2. People and case chat appear as AI agent steps in the investigation trace (medium)

`_KIND_BY_ACTION.get(at, "invoke_agent")` (`routes_triage.py:299`) maps every action type it does
not know (`status`, `collab`, `feedback`, `thread_post`, and the chat `prompt` row) to
`invoke_agent`, and `name` is the actor. Probe 4 (Acknowledge, tag, comment) and probe 5 (one
case-chat question):

```
PROBE span invoke_agent Admin status True action=acknowledge status open→investigating ...
PROBE span invoke_agent Admin collab True tags set (1)
PROBE span invoke_agent Admin collab True comment added
PROBE span invoke_agent Admin prompt            (the case-chat question)
```

Under the trace's "Agent" filter (`InvestigationPanel.tsx`, `TRACE_ACTOR_KINDS.agent`) these read
as the AI's work, and the step count ("N steps · M tools") counts them. Rows since Round 14 carry
`actor_type` (`human`, `agent`, `system`, `service`); the projection ignores it. Fix in R4.

### DV-3. The Decision card shows a re-derivation under today's policy (high; same as explainability D1)

Independent reproduction: a case stored as `FALSE_POSITIVE`, confidence 0.97, risk 10, `closed`
by the agent. Timeline before and after disabling FP auto-close:

```
PROBE before closed 0.85 True
PROBE after needs_human system False
PROBE stored closed
```

`DecisionCard.tsx:126` prefers `d.decision_status`, so the "Result" fact and "Policy clause
evaluated" now say the case went to a person with auto-close off, while it was auto-closed. The
`case_manager` DECISION audit row (`pipeline.py:1242`) records
`verdict, status, decision_by, risk, cost, confidence, auto_close_gate` but not the thresholds
compared against. Fix: explainability D1 plus R10 here (record the clause on the row).

### DV-4. Per-step cost and tokens are an even split, shown as if exact (medium)

`_row_to_span` gives each PROMPT or VERDICT row of a role `role_total / rows_of_role`
(`routes_triage.py` around line 360). A ReAct run with one cheap and one expensive investigator
call shows two equal costs. `TraceTimeline.tsx:299` and `:404` render the value with no
qualifier, and `latency_ms` is hard-coded `None` (lines 379, 420) although every UsageDoc has
`latency_ms`. Fix in R3 and R4.

### DV-5. Silent bounds on the trace (low)

`records_for_case` returns the newest 500 rows (`stores/sql/repositories.py:1427`, same default on
Elasticsearch); `total` is the returned length, so a long-lived case's first runs vanish without a
note. `_usage_attribution` reads `summary(window_hours=24*365, ...)` (`routes_triage.py:482`), so
trace totals for a case older than a year are lower than `Case.token_cost`. Fix in R14.

### DV-6. Docstring drift (low)

`Case.notifications_sent` documents `{..., channel_id, channel_type, ...}` (`models.py:1962`); the
writer uses `type` (`notifications/dispatch.py:296`) and the Console reads `type`. Behaviour is
correct; correct the comment.

## 6. Recommendations (ordered by analyst value)

Common rules for every surface below:

- **Hover** gives a one-line answer; **click** opens a popover or side sheet with the numbers and
  their source; a **Raw data** view has two tabs, Table (field, value) and JSON (the existing
  `components/audit/JsonTree.tsx`, which renders every key and value as a text node), with Copy
  JSON and Download.
- **#9:** every source, model or person-derived value is a text node, an `InlineCode` or a
  `CodeBlock`, never `dangerouslySetInnerHTML`, never an `href` or CSS value except an
  `https_url`-validated link; log-derived blocks carry the existing "untrusted" caption.
- **RBAC:** case data needs `cases:read`; raw log records also need `sources:read` (the grant
  `GET /api/logs` uses); spend needs `cost:view`; the audit-log link keeps `audit:view`. Demo Mode
  reads demo stores only, as the existing routes do.
- No new index or table (#12): every addition below reads existing stores or adds optional fields
  to existing documents; the one new store (R12) is a KV namespace.

### R1. Gate the ungated case reads (S, high, this round)

- **What:** add `_=Depends(require_permission("cases", "read"))` to `case_trace`,
  `case_rationale`, `case_export`, `scans`, `scan_notifications`; `standup` needs `metrics:view`
  or `cases:read` (pick one and document it). In `case_export`, also apply the `cost:view`
  withholding already present and keep the Markdown free of spend.
- **Where:** `backend/app/api/routes.py` lines 8191, 8498, 8517, 8579, 8591, 8603.
- **Risks:** a custom role that relied on the hole loses access (intended). The chat `get_case`
  tool already applies its own grants.
- **Test:** extend `test_round3_wave5_rbac.test_read_routes_honor_cases_and_sources_read_deny`
  with the six paths (403 for the denied role, 200 or 404 for a default role). Add a route-scan
  test: every `GET /api/cases/{case_id}/*` route has a `require_permission` dependency.

### R2. A case "Events" view: the raw records behind the case (M, high, this round)

- **What:** `GET /api/cases/{case_id}/events?limit=50&cursor=` under `cases:read` and
  `sources:read`. It resolves `state.active_source_for_id(case.source_id)` and calls
  `fetch_by_ids(prefs, case.member_event_ids, size)` (the read-only path
  `engine/case_cluster.cluster_for_case` already uses), then keeps only rows whose
  `RawEvent.event_key()` is in `case.member_event_keys` (an Elasticsearch `_id` is unique only per
  index; `models.py:135`). Each row is `engine/log_rows.log_row(ev)` plus `index`, `source_id`,
  `in_evidence: [finding indexes]`, and the projection through `evidence_fields` with a
  `whole_record` toggle. The envelope says honestly what it could do:
  `{available, reason: "aged_out" | "push_source_not_retrievable" | "source_unavailable" | null,
  returned, expected, truncated}`. Bounded (limit 1 to 200, rows capped like `/api/logs`).
  Audit one coalesced `case.events_viewed` row per viewer per case per 10 minutes (like the
  Round 14 `audit_view` coalescing), with `actor_type="human"`.
- **Console:** an "Events (N)" section on the Overview (or a disclosure under What happened):
  a compact table (time, rule, severity, source IP, user, host, message) with a row click opening a
  side sheet with Table and JSON tabs, Copy JSON, Download NDJSON of the page, and "Open in Logs"
  (`pageHash('logs', {sourceId, from, to, rule})`). The signal rail's event count becomes a
  link to it. Each finding in the AI assessment gets "N cited events", which filters the table to
  `evidence[i].event_ids` (R5).
- **Where:** new handler in `backend/app/api/routes.py` beside `case_forwarding`, or a new
  `routes_case_events.py` (auto-discovered); `webui/src/soc/pages/casedetail/CaseEvents.tsx`,
  `lib/api.ts` (`caseEvents`), `lib/types.ts`.
- **Value:** the first question an analyst asks ("show me the actual events") is answered in the
  case. Elastic Security's alert flyout has Table and JSON tabs with copy
  ([Elastic docs](https://www.elastic.co/guide/en/security/current/view-alert-details.html));
  Microsoft Sentinel opens an incident's Events in a Logs panel inside the incident page
  ([Microsoft Learn](https://learn.microsoft.com/azure/sentinel/investigate-incidents)); Splunk ES
  has "contributing events" drilldowns and warns that a re-run can differ from the original
  because late events arrive and old ones age out
  ([Splunk docs](https://help.splunk.com/en/splunk-enterprise-security-7/administer/7.2/incident-review-and-investigations/use-drilldown-searches-in-splunk-enterprise-security-during-investigations),
  [Splunk community](https://community.splunk.com/t5/Splunk-Enterprise-Security/How-to-Get-Contributing-events-from-a-notable-event/m-p/387434)).
  The envelope's `reason` field is how we say the same thing truthfully.
- **Risks:** load on the source (bounded and only on demand); the `ids` query matching a
  same-named `_id` in another index (handled by the `member_event_keys` filter); push sources show
  "not retrievable" until R12. #7 is untouched (people only, never a prompt).
- **Test:** pytest with the in-memory ES and the `DemoPullConnector`: rows returned only for the
  case's keys; 403 without `sources:read`; push-source case answers `available=false,
  reason=push_source_not_retrievable`; aged-out case answers `aged_out`; values that look like
  HTML stay strings. Vitest: rows render as text nodes (a `<img onerror>` value appears literally),
  the JSON tab copies the exact record, the finding filter narrows the table.

### R3. Per-case AI usage with the exact cost formula (M, high, this round)

- **What (backend):** `GET /api/cases/{case_id}/usage` under `cost:view`: every UsageDoc with
  that `case_id` (bounded 500, newest first), plus totals split into `pipeline` (the roles in
  `CASE_PIPELINE_USAGE_ROLES`, which must equal `Case.token_cost` within the existing display
  epsilon) and `chat` (case chat), and a `reconciles: bool`. Add `records_for_case(case_id,
  limit)` to `UsageRepository` (`stores/base.py`), Elasticsearch (`stores/usage.py`) and SQL
  (`stores/sql/repositories.py`, `UsageRow.case_id ==`).
- **What (ledger, additive):** store the inputs of the price on each new UsageDoc:
  `input_rate_per_million`, `output_rate_per_million`, `cache_read_rate_per_million`,
  `cache_write_rate_per_million`, `cache_write_ttl`, `price_basis` (`registry`, `overlay`,
  `heuristic`, `mock`). Written in `llm/gateway.py` beside `cost`; old rows answer "rate not
  recorded". The usage mapping is dynamic, as the Round 4 resilience fields already were.
- **Console:** the rail's "Investigation cost" becomes a button opening a popover: one row per
  call (time, role, model, tier, input, output, cache read, cache write, latency, attempts,
  "estimated" badge, cost), and below it the formula with the row's own numbers, for example
  `1,240 in x $1.25/M + 310 out x $10/M + 0 cache = $0.00465 (Flex price)`. A footer separates
  "Case chat on this case: $0.0021 (not part of the investigation cost)". The trace spans then show
  the real call's cost and latency (R4).
- **Where:** `backend/app/api/routes.py` (or `routes_case_usage.py`), `llm/gateway.py`,
  `models.py:UsageDoc`; `webui/src/soc/pages/casedetail/CaseUsagePopover.tsx`, `FactsRail.tsx`.
- **Value:** "explain every number" for spend, the axis an operator of a free product watches most.
  It follows the per-generation token and cost model of LLM observability tools
  ([Langfuse](https://langfuse.com/docs/observability/best-practices)) and the OpenTelemetry GenAI
  attribute set, which names input, output, cache-read and cache-creation token counts separately
  ([OpenTelemetry registry](https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/);
  status: Development, so we use our own field names and map later).
- **Risks:** #6 unchanged (still one row per call, written only by the gateway). Without
  `cost:view` the route is 403 and the button is absent, matching `_withhold_case_spend`.
- **Test:** pytest: rows for the case only; pipeline total equals `token_cost` on a multi-run case;
  chat rows land in `chat`; 403 without `cost:view`; a new row carries the rates and
  `cost_for(...)` recomputed from them equals `cost`. Vitest: formula line renders the row's own
  numbers; the "estimated" badge shows when `usage_estimated`.

### R4. Inline step details in the trace, with honest step kinds (M, high, this round)

- **What (backend):** in `_row_to_span` (`routes_triage.py:316`):
  1. Classify by `actor_type` first (`human` to a new kind `person`, `agent` stays agent, and
     `system`), then by `action_type`; treat the case-chat `prompt` row (actor `chat` or a
     `surface == "chat"` row) as `chat`, which `TraceSpan.kind` already allows.
  2. Add an optional `detail` object: `tool_input` (bounded JSON, 16 KB, `truncated` flag),
     `query_text`, `tool_output_summary` (8 KB), `prompt_excerpt` (only when
     `prefs.trace.include_prompts`), `result_summary`, `outcome`, `run_id`, `app_version`,
     `build_sha`. Only for callers holding `cases:read` (the route already requires it).
  3. With R3, attribute each LLM row to its actual UsageDoc (match on role and nearest `ts`
     within the run, falling back to the even split with `cost_basis: "split"`), and fill
     `latency_ms`. Mark the basis in the span (`exact` or `split`).
  4. Return `rows_total` and `truncated` from the audit read (DV-5).
- **Console:** `TraceTimeline.tsx` gets a "Details" disclosure per span showing the tool input in
  `JsonTree`, the query and output in `CodeBlock` with the untrusted caption, the model, latency,
  the call's tokens and cost (with "estimated" or "split evenly across N steps" when that is the
  basis). The actor filter gains "People" and "Chat", and the step counter counts AI steps only.
  The trace link to the audit log stays for `audit:view` holders.
- **Where:** `backend/app/api/routes_triage.py`, `models.py:TraceSpan` (optional `detail`,
  `cost_basis`), `webui/src/soc/components/TraceTimeline.tsx`,
  `webui/src/soc/pages/casedetail/InvestigationPanel.tsx`, `CaseDetail.api.ts`.
- **Value:** analysts can verify what the agent ran and saw without an audit grant; the trace stops
  crediting people's work to the AI (DV-2).
- **Risks:** payload size (bounded, lazy: the trace loads when opened); prompt excerpts are log
  data, so they stay behind the existing `include_prompts` switch and in fenced blocks (#9).
- **Test:** pytest: human `status` and `collab` rows come back as `person`, the chat question as
  `chat`; `detail.prompt_excerpt` absent when `include_prompts` is false; a 40 KB tool input comes
  back truncated with the flag; per-span cost basis `exact` when one call per row. Vitest: the
  "Agent" filter excludes person rows; details render a hostile string literally.

### R5. Show the whole finding and the events it cites (S, high, this round)

- **What:** in the AI assessment Findings list, keep the first sentence as the line and add
  "More" (a disclosure) showing the full `evidence[i].summary` as plain text; show
  "Cites N events" from `evidence[i].event_ids`, which opens R2's table filtered to them (before
  R2 ships, show the ids in `InlineCode` with Copy).
- **Where:** `webui/src/soc/pages/casedetail/InvestigationPanel.tsx` (the `findings.map` at
  line 243).
- **Risks:** none beyond length (whitespace-pre-wrap, max height with scroll).
- **Test:** Vitest: a three-sentence finding shows the first sentence, and all three after "More";
  the ids render as text and copy exactly.

### R6. Show what people wrote: status reasons, resolution notes and attached events (S, medium, this round)

- **What:** in `CaseHistory.tsx:caseHistoryItems`:
  - pair each `analyst_action` entry with the `status_history` entry of the same `ts` and show its
    `reason` under the title ("Put on hold: waiting for the vendor"); show `entry.resolution`
    ("Resolution: patched the host");
  - render `attach` entries ("12 new events attached", actor `system`) and the
    `precedent_projection_ack` entry as a system line, or document why it is internal;
  - in the rail's Outcome, when the case is On hold, show `status_reason` ("On hold: ...").
- **Where:** `webui/src/soc/pages/casedetail/CaseHistory.tsx`, `FactsRail.tsx`.
- **Risks:** older cases have no reason (show nothing). Text is untrusted (plain text node).
- **Test:** Vitest: hold with a reason shows it in History and in the rail; an `attach` entry
  renders with its count; a hostile reason renders literally.

### R7. Indicator reputation, per provider, and when it was checked (S, medium, this round)

- **What:** each indicator row in Threat context gets a click-through popover: one line per
  provider (name, score, provider verdict, confidence, ok or error, cached), the fusion line
  ("Fused by maximum: 87 from abuseipdb" or "weighted average" when `fusion_enabled`), and the
  provider `raw` excerpt in a fenced `CodeBlock`. Label the panel "Checked when you opened this
  case" and show the investigation-time reputation beside it from the rationale's `enrichment`
  ("At investigation: 0"), so the two numbers explain each other.
- **Backend:** in `_ioc_section` (`engine/threat_context.py:46`) return `providers` for the IP
  path too (call `enrich_indicator` for IP or have `enrich_ip` keep the `ProviderResult` list) and
  add `method` and `errors` from `FusedReputation`.
- **Where:** `backend/app/engine/threat_context.py`, `webui/src/soc/pages/casedetail/ThreatContextPanel.tsx`.
- **Risks:** `raw` is attacker-influenceable; it is already fenced by `fence_provider_result` and
  must stay in a code block.
- **Test:** pytest: IP and domain paths both return `providers` and `method`; Vitest: popover
  lists every provider, an error provider shows its error, a hostile tag renders literally.

### R8. The full grading record (S, medium, this round)

- **What:** each entry in `GradingHistory` gets a hover or click popover: accuracy, reasoning
  quality and action appropriateness as percentages, "Graded the AI verdict: False positive at
  92%" from `ai_verdict` and `ai_confidence`, and "From the auto-close review" when `origin` is
  `auto_close_review` (link to the review state).
- **Where:** `webui/src/soc/pages/casedetail/grading.tsx:436`.
- **Test:** Vitest: values render; a review-origin grade is labelled.

### R9. Precedent facts behind the decision (S, medium, this round)

- **What:** in the Decision card, always show a "Precedent" line from `precedent_signal` (not only
  when it qualifies): "3 confirmed benign, 0 confirmed malicious for this rule; 5 needed; did not
  qualify (reason)". Click opens the full fields including `top_score` versus `min_similarity` and
  `truncated`.
- **Where:** `webui/src/soc/pages/casedetail/DecisionCard.tsx` (`precedentSignal`).
- **Test:** Vitest for qualifying, not qualifying, and `null` (older run: "not recorded").

### R10. Record the policy clause the decision used (S, high, this round; with explainability D1)

- **What:** append to the `case_manager` DECISION audit row (`agents/pipeline.py:1242`) a
  `tool_input` of `{policy_clause: {verdict_class, enabled, min_confidence, max_risk_score,
  objection_window_minutes}, inputs: {verdict, confidence, risk_score}, demo: bool}` (the
  `result_summary` string stays byte-identical; new rows only). `_decision_span` reads the recorded
  clause and status when present and labels a legacy row "re-derived with today's policy", with a
  `policy_changed` flag when today's result differs from the stored status.
- **Where:** `backend/app/agents/pipeline.py`, `backend/app/api/routes_triage.py:393`,
  `webui/src/soc/pages/casedetail/DecisionCard.tsx:126`.
- **Risks:** #3: the record is written after `apply()` and nothing branches on it; `decide()` is
  untouched.
- **Test:** the probe-3 scenario as a pytest: after a policy change the span still reports
  `closed`, `agent` and the old clause, with `policy_changed: true`.

### R11. A "Record" viewer for the whole case (S, medium, this round)

- **What:** the header's export menu gains "View record": a side sheet with the case as a JSON tree
  (`JsonTree`), a search box over keys, Copy JSON and the existing Download. It uses the same
  `GET /api/cases/{id}/export?format=json` (gated by R1), so `token_cost` is withheld without
  `cost:view`. This guarantees that every stored field is visible somewhere, including ones a
  future round adds before it gets a designed home.
- **Where:** `webui/src/soc/pages/CaseDetail.tsx` (`runExport` area, menu near line 2128), reuse
  `components/audit/JsonTree.tsx` (move it to `soc/components/JsonTree.tsx`).
- **Test:** Vitest: the tree shows `status_reason`, `history`, `precedent_signal`; Copy copies the
  exact JSON; no spend without `cost:view`.

### R12. Keep a bounded evidence snapshot for push sources (L, medium, next round)

- **What:** at case creation (and on attach, up to the bound), store the member events projected
  through `evidence_fields` (not the whole record) for push-source cases, at most 20 events and
  64 KB per case, as one opaque JSON string in a KV namespace `case_evidence` (the replay fixture
  pattern in `engine/replay/fixtures.py`: log-bearing data in one opaque field so attacker-named
  keys never become KV field names). R2 reads it when `fetch_by_ids` is not available and says
  "snapshot at creation".
- **Risks:** retention of personal data (needs a retention setting, factory reset and the user
  data export scopes must include it); storage growth (bounded); #12 kept (KV only).
- **Test:** pytest: webhook case gets a snapshot within bounds; oversize events are cut with a
  flag; factory reset clears the namespace; R2 serves it with `reason="snapshot"`.

### R13. "Why is this waiting?" for candidates (S, medium, this round)

- **What:** for a case with no verdict, show `awaiting_reason` as its own line in the rail Outcome
  with a popover from `GET /api/cases/{id}/forwarding` (exists, unused): the gate that decided,
  and for the risk floor the routing score arithmetic (`compute_routing_risk` normalises over the
  signals actually available, which is why it differs from the stored risk).
- **Where:** `FactsRail.tsx`, `lib/api.ts` (`caseForwarding`); backend unchanged except adding the
  routing score breakdown to `explain_forwarding` if absent.
- **Test:** Vitest for the `deferred:` cap, below-floor and disabled cases.

### R14. Say when the trace is incomplete (S, low, this round)

- **What:** return `rows_total` and `truncated` from `records_for_case` (count query) on
  `/timeline`, `/stages` and `/rationale`; show "Showing the newest 500 of 1,240 records. Open the
  audit log for the rest." Use a lifetime window in `_usage_attribution` (drop the 365 day bound,
  or use `total_pipeline_cost_for_case`).
- **Where:** `stores/base.py`, both audit stores, `routes_triage.py:482`, `TraceTimeline.tsx`.
- **Test:** pytest with 501 rows; a case with usage older than a year reconciles.

### R15. Small completeness items (S, low, this round)

- Notifications in the rail: "Show all (N)" and the channel id in each line (`FactsRail.tsx:529`).
- Show the case's lifetime retrieval markers in WhyPanel's provenance note
  (`retrieval_history_status`, `retrieval_observation_status`) so "unavailable" is explained.
- AI step drafts in runbooks: show the model and, for `cost:view`, the cost of `usage_id`.
- Correct the `notifications_sent` comment (DV-6).

### R16. Revisit the hashed event refs in the clustering diagram (S, low, decide first)

`engine/clustering_explain._safe_ref` hashes member ids "so the underlying source identifiers
remain private (#9)", but the same ids are in `GET /api/cases/{id}` and the JSON export. #9 is
about prompts, not about hiding ids from people. Proposal: show the real id (InlineCode, Copy) to
`sources:read` holders and keep the hash for others. This reverses an earlier decision, so it needs
an explicit SPEC decision.

## 7. Dashboards and analytics

KPI tiles already open drill-downs with definitions (`KpiDrilldownPanel.tsx`,
`ComparisonMetric.tsx` `MetricDefinitionDetails` with formula, numerator, denominator,
eligibility, caveats). The remaining number-level gaps (MTTR definitions, rounding, SLA reading,
agreement populations) are in `explainability.md` sections 4 and 6. From the data side, the one
addition is that every dashboard count that names cases should drill to the case list with the
same filter (it does for the Overview; check the four built-in boards in `dashboard/builtins.ts`
when building R2 to R4).

## 8. Non-negotiables check

- #1: R2 reads logs through the source's read-only client (`fetch_by_ids`), never the management
  client.
- #2: R2 adds a coalesced view audit row; R10 adds structured content to an append-only row on new
  rows only; nothing rewrites history.
- #3: nothing here is read by `decide()`; R10 is written after `apply()`; R13 only narrates.
- #4: no signature or cluster changes; R2 filters by existing keys.
- #6: R3 reads the ledger; the gateway stays the only writer (it gains rate fields).
- #7: R2, R4 and R12 show raw data to people only; nothing new reaches a prompt.
- #9: every new view renders untrusted values as text, `InlineCode`, `CodeBlock` or `JsonTree`;
  provider `raw` and prompt excerpts stay fenced and captioned.
- #12: no new index or table; R12 adds one KV namespace.

## 9. External references

- Elastic Security, view detection alert details (Table and JSON tabs, copy to clipboard):
  https://www.elastic.co/guide/en/security/current/view-alert-details.html and
  https://www.elastic.co/docs/solutions/security/detect-and-alert/view-detection-alert-details
- Microsoft Sentinel, navigate and investigate incidents (Evidence: Events, Alerts and Bookmarks
  in a Logs panel; incident timeline): https://learn.microsoft.com/azure/sentinel/investigate-incidents
  and https://learn.microsoft.com/en-us/azure/sentinel/incident-investigation
- Splunk Enterprise Security, drilldown searches and contributing events:
  https://help.splunk.com/en/splunk-enterprise-security-7/administer/7.2/incident-review-and-investigations/use-drilldown-searches-in-splunk-enterprise-security-during-investigations
- Splunk community, re-running a notable's search can differ from the original (late and aged-out
  events): https://community.splunk.com/t5/Splunk-Enterprise-Security/How-to-Get-Contributing-events-from-a-notable-event/m-p/387434
  (community answer, not official documentation)
- OpenTelemetry GenAI attribute registry (`gen_ai.usage.input_tokens`, `output_tokens`, cache read
  and cache creation input tokens; status Development):
  https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/
- Langfuse observability best practices (tokens and cost per generation, aggregated on parent
  spans): https://langfuse.com/docs/observability/best-practices and
  https://langfuse.com/changelog/2024-10-10-text-color-for-latency-and-costs

Not verified: the exact current Elastic 9.x flyout layout (docs differ by version) and whether
the OpenTelemetry GenAI conventions have moved past Development since the registry page was read.

## 10. Journal entry (for the orchestrator to append)

```
### 2026-11-24 00:00Z - research agent (data-visibility) - Round 16 data visibility audit
- Context: Round 16 discovery; operator asked that all data be visible by hover or click.
- Did: compared the 67 Case fields, AuditDoc, UsageDoc, FeedbackEntry, history, threat context,
  runbook runs, review, campaign and baseline records with the Console's case surfaces; ran five
  read-only probes against the offline harness. Report:
  scratchpad/round16/research/data-visibility.md.
- Findings: /cases/{id}/trace, /rationale, /export (and /scans, /standup) ignore cases:read
  (reproduced); the trace shows people's actions and case-chat questions as AI agent steps
  (reproduced); the Decision card re-derives under today's policy (reproduced, = explainability
  D1); per-step cost is an unlabelled even split and latency is always null; no way to see a
  case's raw events, per-call usage, tool inputs (without audit:view), status reasons, the rest of
  a finding, or per-provider enrichment.
- Tests: probes only (no repository change); backend suite not run.
- Status: done.
- Next: SPEC candidates R1 (gate routes), R2 (case Events view), R3 (per-case usage + formula),
  R4 (trace step details + step kinds), R5 to R11 (small "show what is stored" fixes); R12
  (push-source evidence snapshot in KV) for a later round.
```
