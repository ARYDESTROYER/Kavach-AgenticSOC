Round 15 SPEC review, backend contracts lens. I checked every claim below against the code at b49780c on claude/round15. I edited nothing and changed no git state.

## Findings, most severe first

### H1. D6.9: `CaseAction.via` collides with the existing `via` parameter and can bypass the open-steps guard
- **What is wrong:** `CaseAction` has no `via` field today (routes.py:6869-6950). `via` is a private parameter of `_perform_case_action` (routes.py:7141-7143). It takes "bulk", "proposal", "console" and "api".
  - When `via == "bulk"`, the 409 `runbook_steps_open` check is skipped (routes.py:7229: `and via != "bulk"`).
  - The same value names the `case.closed_with_open_steps` row (routes.py:7365).
  - If `via` becomes a free public field and the implementer forwards it, a single-case caller can send `via: "bulk"` and skip the guard.
- **Correction:** "Add `CaseAction.via: Literal["auto_close_review"] | None = None`. Any other value answers 422. Record it on the `analyst_action` history entry and in the audit row's `changes` or `tool_input`. Never pass it to the `via=` parameter of `_perform_case_action` and never use it in the open-steps logic. Bulk bodies (`BulkCaseAction`, `CaseLifecycleParams`) do not accept it."

### H2. D4.4: "No rating, no grade (as today), so the grading population does not shift" is false
- **What is wrong:** Today every Console close on a case with a TP or FP verdict already posts a feedback entry, even with no stars.
  - CaseDetail.tsx:1280 posts when `freshAssessment || isGradingDirty(...)`.
  - `freshAssessment` is set whenever `deriveAgreement` returns match or override (CaseDetail.tsx:1271-1279, grading.tsx `deriveAgreement`).
  - The close action carries the `grading` field (casedetail/shared.tsx:202).
- **Effect:** D4.4 would drop most of the agreement population in `feedback_stats` and `agent_improvement`.
- **Correction:** either keep today's rule ("post an assessment-only entry whenever the computed agreement is agree or disagree, and add stars only when given"), or keep D4.4 and state the population shift in the CHANGELOG and the metrics docs. Pick one.

### H3. D3.9 and D3.10: the roster join and the per-person events query are case-sensitive and mislabel accounts
1. **Actor case varies.** The audit actor is the token `sub` exactly as typed at sign-in.
   - auth/service.py:382 (`"sub": username`) and :483 (`principal()` keeps the typed name).
   - `audit_actor_key` keeps short names verbatim (stored_text.py:76-78).
   - The user store keys are lower case (stores/users.py:38-39), and the seeded admin is "Admin" (config.py:238).
   - So "Admin", "admin" and "ADMIN" are separate actors.
   - **Correction:** "The fold keys people by `actor.strip().lower()` (the user-store `_norm`). The events endpoint matches every spelling seen in the window (an `In("actor", ...)` over the observed variants), not `Eq`."
2. **The env admin would be labelled "Deleted account".** The environment administrator has no persisted record (routes.py:4614-4623 `env_managed`).
   - **Correction:** "Merge the AuthService base-layer accounts (`Secrets.auth_user_map()` keys) into the roster as 'Environment account'."
3. **Demo analysts would be labelled "Deleted account".** The Demo rows seeded by D3.12 use `DEMO_SOC_ANALYSTS` (demo_generator.py:791), which are not user-store accounts.
   - **Correction:** "In Demo Mode, label `DEMO_SOC_ANALYSTS` as 'Demo analyst'."
4. **Events link for "Not attributed".** Add: "No events link for the Not attributed group, or a reserved path value."

### H4. D5.6: the "extend_audit_mapping precedent" does nothing on a real cluster
- **What is wrong:** `extend_audit_mapping` needs `get_index_template`, `get_index_mapping` and `put_index_mapping` (es/indices.py:305). Without them it logs a warning and returns (es/indices.py:327-331).
  - The real `ESClient` implements none of the three (es/client.py, methods at 109-727; only es/fake.py:237-253 has them).
  - The Round 14 SPEC already records this (docs/research/2026-10-round14/SPEC.md:3892-3893: "RealESClient does not yet").
  - So on an upgraded Elasticsearch install, `case_file_data` maps dynamically as analysed text with a `.keyword` sub-field. That is roughly 11,000 tokens per 2 MiB image.
- **Correction:**
  - "Fresh installs: create CONFIG_INDEX with `{"mappings": {"dynamic": true, "properties": {"case_file_data": {"type": "binary"}}}}` (es/indices.py:405-407)."
  - "Upgrades: WP4 adds `get_index_mapping` and `put_index_mapping` to `BaseESClient` and `ESClient` (es/base.py, es/client.py; add both files to WP4's ownership), then puts the new-field mapping before the first write. If that fails or the field already exists as text, writes still work and the cost is stated in the docs."

### H5. D2.1: readiness cannot be computed from `Secrets.configured_status`, and the payload question is already settled
1. **Use the helper that already exists.** `Secrets.provider_key(provider)` (config.py:374-389) is the right input, but it is not sufficient on its own.
   - `openai_compatible` needs no key when a base URL resolves (gateway.py:770-777). The base URL comes from `ModelConfig.base_url`, then the registry `base_url_for(model)`, then `CustomModelStore.base_url_for` (gateway.py:1254-1264). A keyless self-hosted LiteLLM install would wrongly read "No usable AI provider yet".
   - Azure needs a key (`azure_openai_api_key` or `openai_api_key`) and an endpoint (gateway.py:785-797).
   - Bedrock needs `aws_access_key_id` and `aws_secret_access_key` (gateway.py:798-806).
   - Vertex needs `vertex_api_key` and `vertex_project` (gateway.py:807-815).
   - `provider_key("mock")` returns "mock" (config.py:389).
   - **Correction:** "`ai_runtime_ready` is true when both `prefs.router_model` and `prefs.investigator_model` (config.py:4613-4623 `model_for`) satisfy:
     - anthropic and openai: their key is set;
     - openai_compatible: `litellm_api_key` or `openai_api_key`, or a resolvable base URL;
     - azure: a key and an endpoint;
     - bedrock: access key id and secret;
     - vertex: token and project;
     - mock: never ready in live mode."
2. **The wizard reads only the public route.** It reads `configured` from public `GET /api/setup/status` (api.ts:1111; Wizard.tsx:196, 221, 352; routes.py:578). The only authenticated payload carrying `configured` is the `POST /api/setup/secrets` response (routes.py:730).
   - So the D2.2 row "key present but not for the default models ... {provider}" cannot be rendered under the "no provider on a public route" rule.
   - **Correction:**
     - "Add `ai_runtime_ready` to `/api/setup/status`."
     - "Add `ai_runtime_ready` and `ai_runtime_provider` to the `POST /api/setup/secrets` response."
     - "The wizard reads the provider from `GET /api/settings` (`prefs.investigator_model.provider`). That route is authenticated and has no grant (routes.py:1726-1732)."
   - Also say all three `hasProvider` sites change: Wizard.tsx:275, 1313 and 1397.

### M1. D6.5 contradicts D7.5 on the category of `case.review_requested`
- **What is wrong:** D6.5 says Agent activity scope. D7.5 gives every new action category `case_work`.
  - `case_work` is a People scope category (event_categories.json categories; events.py:45 `PEOPLE_CATEGORIES`).
  - `scope_predicate` puts any case_work row in People whatever its `actor_type` (query.py:296-316).
  - Without an exact entry, the `case` prefix already maps to case_work.
- **Correction:** "`case.review_requested` has an exact entry in category `system`. All other Round 15 actions are `case_work`, and `team.viewed` is `access`."

### M2. §3.5 and D6.6: review notes do reach prompts as written
- **What is wrong:** D6.6 says the review route "indexes the resolved case exactly as the feedback route does".
  - The feedback route passes the comment into `index_resolved_case` (routes.py:7595).
  - `_case_analyst_note` reads `FeedbackEntry.comment` (tools/rag.py:2757-2783) into `"Analyst note: ..."` (rag.py:2823), and that chunk is replayed into investigator prompts, fenced (rag.py:619-630).
  - So a review note stored as `FeedbackEntry.comment` becomes untrusted precedent text in prompts. §3.5 says review notes never reach a prompt.
- **Correction:** either:
  - "The review note is stored as `FeedbackEntry.comment` and is fenced untrusted precedent text like any grading comment (#9)", and fix §3.5; or
  - "The note is stored only in the ledger entry, and `index_resolved_case(case, note="")` is called."

### M3. D5.9 and D5.10: a filename or caption in `result_summary` reaches a model
- **What is wrong:** The chat tool `audit_search` sends `result_summary` to the model, fenced and cut to 200 characters (agents/chat_tools/ops.py:534-537, 574-583).
- **Correction:** "`case.file_attached`, `case.file_deleted` and `case.review_recorded` rows never put the filename, caption or review note in `result_summary`. They go in `changes` or `target` only (both dropped by the chat whitelist). The sentinel test also runs `audit_search` over these rows."

### M4. D6.10: the carry-over list is incomplete and partly inconsistent
1. **`status` is not carried, so the trail is wrong.** `_assemble_case` builds a Case whose `status` defaults to OPEN (models.py:1846). `apply()` takes `prev_status = case.status` (case_manager.py:146) and records `from_status` from it (:175). Carrying `status_history` without `status` appends a false "open → X" entry.
   - **Correction:** "Also carry `status`, used only as `apply()`'s previous status, as the analyst-policy path does (pipeline.py:1382-1383)."
2. **`escalation_level` without status is contradictory.** Any value above 0 counts as escalated in metrics.py:736, 1564, noise_counters.py:210 and priority.py:393. Carrying it while `apply()` sets NEEDS_HUMAN or CLOSED leaves an escalated flag on a non-escalated or closed case.
   - **Correction:** drop it from the list, or "clear it when `apply()` closes".
3. **"An analyst-set disposition" needs a definition.** Use `analyst_outcomes.standing_analyst_disposition(existing)` (analyst_outcomes.py:103).
4. **Two other builders drop the same work.** `_fail_to_human_case` (pipeline.py:1748) and `_register_candidate_locked` (pipeline.py:1482) drop assignee, comments and feedback in the same way. The analyst-policy path already carries them (pipeline.py:1429-1432).
   - **Correction:** "Apply one shared carry helper in all three."
5. **No test pins the old drop behaviour.** I grepped test_case_actions_reinvestigate.py, test_precedent_*, test_case_status_transitions.py and test_unconfirmed_precedent_tier.py.

### M5. D7.3: run_id plumbing is unspecified and could become a client-settable query parameter
- **What is wrong:**
  - Bulk rows come from four places: the `case_lifecycle` job (jobs.py:748-774), the `case_assign` and `case_tag` jobs (jobs.py:776-800), and the synchronous `POST /api/cases/bulk`, which is not a job (routes.py:7448-7509).
  - The jobs call the route functions `case_assign` and `case_tags` directly with `request=None`. Adding a `run_id` keyword to those signatures would expose it as a FastAPI query parameter, so any client could mark rows as bulk.
- **Correction:** "`run_id` = the existing `batch_id` (`bulk-<job_id>` at jobs.py:760, `bulk-<id>` at routes.py:7490) for all four sources. It is carried through a private helper or contextvar, never a route parameter. Legacy rows are never bulk. Update the `AuditDoc.run_id` comment (models.py:2268): run ids are now `inv-`, `run-` or `bulk-`."

### M6. D7.2: "principal when sign-in is on, else body" breaks the job path
- **What is wrong:** Jobs call `case_assign`, `case_tags` and `_perform_case_action` with no request while sign-in is on (jobs.py:770, 781-783, 795-800). They pass `job.actor`, which was verified at submit.
- **Correction:** "Use the verified principal when the request has one, else the body or caller value (jobs pass the verified submitter)."
- **For reinvestigate:** "Only the name inside `result_summary` changes. `actor` stays `reinvestigate` (Agent activity, routes.py:7896-7905)."

### M7. Ownership gaps and parallel edits not listed in §4.6
1. **`engine/demo_runtime.py`.** The Demo pipeline and stores are built there (demo_runtime.py:207-300, pipeline built near :397 with `runbook_attacher` passed from state.py:3480). WP4 and WP5 both need Demo instances and the Demo sampler hook.
2. **`engine/reset.py` and `api/routes_export.py`.** Both WP4 and WP5 edit them in Wave 2.
3. **`engine/demo_generator.py`.** WP3 (D3.12) and WP5 (D6.13) both edit it.
4. **`audit/views.py`.** `ViewRecorder.note` hard-codes `action="audit.viewed"`, `AUDIT_VIEW` and surface "audit" with a 300 s window (views.py:44-48, 259-288). WP3 cannot edit audit/*.
   - **Correction:** "WP1 adds `action`, `surface` and `window` parameters, or a second recorder instance."
5. **Replay must not sample.** The replay stack builds its own pipeline (engine/replay/stack.py:563).
   - **Correction:** "The sampler is a post-settable pipeline attribute like `runbook_attacher` (pipeline.py:316). It is None in the replay stack."

### M8. Router-count doc pins fail every WP2 to WP5 worktree
- **What is wrong:** test_docs_round13_records.py:51-54 and :174-180 require AGENTS.md "**N `routes_*.py` feature routers**" and HANDOFF "**N feature routers total**", and that every `routes_*` module is named. Those files are WP8-only, but WP2 to WP5 add `routes_rbac`, `routes_team`, `routes_case_files` and `routes_auto_close_review`.
- **Correction:** "Each package updates the two counts and names in AGENTS.md and HANDOFF.md, owned by region; or the integration acceptance lists this test as expected-red until WP8."

### M9. D5.1, D5.4 and D5.8: the KV store has no delete
- **What is wrong:**
  - `KVStore` has get, put, put_if, factory_purge and mutate only (stores/base.py:1116-1200). `SqlKVStore` is the same (sql/repositories.py:1925-1990).
  - Removing a namespace today is backend-specific: SQL deletes by namespace; ES searches a tag field such as `runbook_store` and deletes by id (reset.py:460-500).
- **Correction:**
  - "WP4 adds `delete_strict(namespace, key)` to EsKVStore (memory.py) and SqlKVStore. DELETE removes the `blob:` and `thumb:` documents and updates the usage doc."
  - "Every case_files document carries `case_file_store: "case_files"` (counts toward the six fields) so the cases-tier reset can enumerate it on ES, following `_clear_runbook_runs`."

### M10. D6.6 and D6.7: the history event on an ordinary grade would misclassify it
- **What is wrong:** `is_review_grade` falls back to "a history event with the same `feedback_ts` and analyst". If the `auto_close_review` history event is also written for an "ordinary grade" (a case not in the ledger), that grade is excluded from `feedback_stats`.
- **Correction:** "The history event, `origin` and `review_id` are written only when the case is in the ledger."
- **Also state the write order and recovery:** audit row first, then case save (re-fetched), then ledger completion with strict CAS. A failed ledger write after the case save is repaired on the next read from the case's history event.

### M11. D3.5: the 250,000-row fold is costly in a request
- SQL `search_page` runs an exact `COUNT` on every page (sql/repositories.py:1556-1558). A 250-page fold means 250 counts.
- ES falls back to offset paging capped at 10,000 rows when point-in-time cannot be opened (audit_log.py:285-294).
- The third-party fallback scans 10,000 rows (base.py:649, 898-906).
- The only precedent stream (the audit export) caps at 100,000 rows and runs as a durable Job (engine/audit_export.py:20, 618-623).
- **Correction:**
  - "Add a `count=False` option to `search_page`, or fold over `count_matching` once."
  - "Mark `partial` when the page cursor is offset-based and reaches 10,000."
  - "Cache the result per window for a short time, or lower the bound."

### M12. D6.11 and D3.8: review time has two definitions and one is never recorded
- **What is wrong:** D6.11 says the card "records the time from opening the card to submitting". The D6.6 body and the D6.4 ledger entry have no field for it. D3.8 defines review time as "sample to completion".
- **Correction:** add `elapsed_ms: int | None` (0 to 86,400,000) to the review body and an `open_to_submit_ms` field to the ledger entry, and say which one Team activity shows.

### L1. D1.2 rule 2 and rule 4: "environment administrator" is redundant and ambiguous
- **What is wrong:**
  - `verify()` returns the synced stored role (auth/service.py:599-630).
  - The env admin's base record is already `super_admin` (auth/service.py:170-178), so rule 2 reduces to `principal.role == "super_admin"`.
  - A username-based env-admin clause would wrongly admit a store account that overlays the env admin name with a lower role.
  - The only existing env-admin helper counts `auth_admin_username` even when no password is configured (batch_inbox.py:104-113; the name defaults to "admin").
- **Correction:**
  - "Rule 2: the verified principal's `role` is `super_admin`."
  - "Rule 4: a configured environment administrator means `auth_admin_username in secrets.auth_user_map()` and no persisted user of that name."
  - "A rule 2 refusal records an Access denied row (`record_access_denied`, deps.py:902)."
- **Rule 5:** `audited_prefs_write` appends a row even when nothing changes (prefs_write.py:160-176), so the no-change check runs before calling it.
- **Rule 3:** the refusal is `403 "Settings are in read-only mode"` (routes.py:1976-1980). PUT /api/rbac has no unlock body.

### L2. D1.3: guard placement and comparison
- **Correction:** "Inside `_apply`, after the read-only gate. Compare the validated merged `rbac.enabled` with `current.rbac.enabled`, not the raw body value (`1` or `"true"` coerce to True)."

### L3. D7.4: the alias table belongs in one place, and the chat tool does not use it
- **What is wrong:**
  - Elasticsearch, SQL and the Python reference all interpret one predicate tree (query.py:477, 570; sql/repositories.py:1263-1296). The alias belongs only in `event_predicate` (query.py:318-326), with a test per store.
  - The chat `audit_search` tool does not use the predicate. It filters on `action_type` through `records()` (ops.py:612-627). It is unaffected because `action_type` stays the same.
- **Correction:** drop "the chat ops audit tool inherits it".

### L4. D6.12: `?review=` has no store-level id filter
- **What is wrong:** No repository list method takes ids. The real precedent is `get_many` (ES `terms` at stores/cases.py:137-150; SQL `IN` at sql/repositories.py:277-287), used through `_queue_cases_by_id` (routes.py:6450-6470).
- **Correction:** "Fetch the ledger ids through `_queue_cases_by_id`, apply the other queue filters in Python, then sort, page and count. Echo `review_applied`."

### L5. D3.8: runbook steps and time to acknowledge
- **Runbook steps completed:** completion is a row whose `changes` hold `steps.<id>.status` with after "done", across `step.updated`, `step.decision_recorded`, `step.action_recorded` and `step.approved` (runbook_runs.py:1512-1600). Say so.
- **Median time to acknowledge:** this needs each case's `created_at`. Today that means a `get_many` of up to 5,000 cases.
  - **Correction:** "New `case.acknowledged` rows carry `changes=[{field: "acknowledged_at", before: null, after: <ts>}]` and the case `created_at` in `tool_input`; legacy rows use `get_many`."

### L6. D4.5: unrated values
- Console stars map to 0.2 to 1.0, and unrated fields are omitted (grading.tsx:149-152, 245-250). The backend default is 0.0 (models.py:464-466, routes.py:7510-7517). So 0.0 means unrated for the Console.
- An API caller sending 0.0 is now read as unrated. Say so, and make the review body bound `gt=0, le=1`.
- When no entry rated a sub-score, keep `avg_* = 0.0` (a float; Metrics.tsx:959 reads `|| 0`) and add `*_rated` counts.

### L7. D6.2: where write rejection lives
- `Preferences` validators repair values, so a merged write is clamped before `ge`/`le` can fire (routes.py:1981-1985).
- **Correction:** "Add a body-level `_reject_out_of_range_auto_close_review(body)` in `put_settings`, beside `_reject_out_of_range_caps` (WP1, routes.py)."

### L8. D6.9 "Reopen and escalate" is two calls
- Escalate from CLOSED answers 400 "reopen the case first" (routes.py:7035-7040). So it is reopen, then escalate. If the second call fails, the case stays reopened.

### L9. D6.9: the Inbox audience needs a new function
- `eligible_batch_audience` is hard-wired to `models:read` (batch_inbox.py:51-113). It needs a parameterised `eligible_audience(state, resource, action)`.
- Delivery through `inbox.fanout` (stores/inbox.py:187) skips per-category mutes. State whether that is intended.

### L10. D2.2: "every case waits as Needs human" is too broad
- Clusters below the risk floor stay OPEN $0 candidates (pipeline.py:1482-1547). They are not Needs human.
- **Correction:** "every cluster sent to investigation waits ...".

### L11. §3.2: Team activity in Demo Mode mixes real and Demo work
- `_sources(None)` reads the control store's People rows plus every Demo row (routes_audit.py:515-531). Team activity in Demo Mode therefore mixes real historical case work with Demo work, and real case links 404 in Demo. State this or filter it.

### L12. D3.3: `team_activity` needs a curated home
- Add `team_activity` to `CURATED_SECTIONS` (webui advanced-schema.tsx:54-80). Otherwise it is editable both in the Security row and in All settings.

### L13. D5.1: `put_if(expected_rev=0)` is not create-only
- **What is wrong:** It overwrites an existing document whose `_rev` is missing.
  - On ES, an existing document with `current_rev == 0` is replaced (es/client.py:350-371).
  - On SQL, the `UPDATE ... WHERE coalesce(_rev, 0) == 0` matches it (sql/repositories.py:1961-1977).
- **Correction:** "Content documents are written with `_rev: 1` through `put_if_strict(..., expected_rev=0)`, so a second create fails."

## Claims checked and found correct
- `audited_prefs_write(state, *, transform, actor, context, summary, action="settings.updated", ...)`: the target label "RBAC" comes from `settings_target` and `_SECTION_TITLES` (prefs_write.py:100-111; settings_schema.py:68). It is audit-first, 409 `settings_conflict` after 3 attempts, 503 `audit_unavailable`, sink control.
- `PUT /api/settings` is gated by `settings:manage` only, with the read-only gate inside `_apply`. `test_runbook_permissions.py:308` sends only `rbac.roles`, so it stays green. No backend or webui test PUTs `rbac.enabled`.
- `require_fresh_auth()` exists, is a no-op with auth off, and treats an unknown sid as fresh. Sign-in stamps `last_authn_at` (sessions.py:180).
- `require_fresh_auth`, `require_permission` and in-body `_enforce` all satisfy `test_state_changing_routes_declare_authz`. GET routes are only authentication-checked, so explicit `require_permission` on each GET is needed, as the SPEC says.
- `MutationAdmissionMiddleware` is generic. New routes need no change, and closed mode blocks the view-writing GETs too.
- Feature routers are auto-discovered and mounted with `require_auth` (main.py:35-68, 162-163).
- `RESOURCES` and the role matrices are as described. A stored `rbac.roles` override replaces only the resources it names (`_merge_grants(additive=False)`, policy.py:567-590), and super_admin gets `team` automatically.
- §3.3 grant table matches `DEFAULT_MATRIX` (`cases:comment`, `cases:close`, `cases:write`, `cases:read`, `metrics:view`, `settings:manage`, `roles:read`).
- `Secrets.configured_status` has every key named (Azure, AWS, Vertex, LiteLLM).
- `FeedbackEntry` ignores extra fields (models.py:456-471), so a previous build drops `origin` and `review_id` and keeps history dicts. ES `history` is `enabled: false` (indices.py:76).
- `apply()` fills `disposition` only when it is None (case_manager.py:165).
- `CaseManager(...).apply` is called only at pipeline.py:1161. The post-decision hooks follow at :1203-1222, and analyst-policy closes return earlier (:831-835).
- `find_open_case_for_cluster` means `existing` is always an open case (pipeline.py:822). A closed-case reinvestigation creates a new case, as §7 says.
- `precedent.case_rule_identity` exists (precedent.py:113).
- `kv_mutate_strict` exists (stores/base.py:166).
- `NotificationCategory.ASSIGNMENT` exists and has no producer.
- `case_aggregate` supports `closed_by` and `auto_closed`.
- `_RunbookRoute` body-cap precedent exists (routes_runbooks.py:132-162).
- `factory_purge_strict` loads every value on both backends (memory.py:148-242; sql/repositories.py:1990-2050), so D5.7's premise holds.
- `record_strict` accepts `ts=` (stores/base.py:800-806). The Demo stack has its own KV and audit (demo_runtime.py:207-268).
- `time_windows.resolve_window` accepts today, yesterday, now-Nd and "a..b" ranges. `SlaPolicy.timezone` exists (as `Preferences.sla`).
- `AuditDoc` has `actor`, `actor_type`, `action`, `target`, `changes`, `request_id` and `run_id`. `audit_context(request).record_fields()` returns client, session_ref, actor_role and request_id (context.py:608-615).
- `AuditTarget` type "case" is valid, and every proposed action name matches `^[a-z_]+\.[a-z_]+$`.
- `_BASE_VERBS` already covers attached, deleted, recorded and requested, so the failure names `case.file_attach_failed`, `case.file_delete_failed` and `case.review_record_failed` derive correctly.
- The search_page snapshot semantics are as described: ES point-in-time with `search_after`, SQL keyset plus high-water mark, and the fake supports point-in-time.
- The cases list route has no `review` parameter and no route-path conflicts for the new paths.
- Only `feedback_stats` and `agent_improvement` read `FeedbackEntry.assessment` (metrics.py:151, agent_improvement.py:122-224).
- `PROVENANCE_COUNT_KEYS` (stores/proposals.py:104) and `PrecedentWindowConfig` (config.py:2821) exist.
- `test_audit_route_outcomes.py` and `test_g1_ground_truth_intake.py:303` assert only `result_summary` prefixes, which D7.1 keeps unchanged.
- The data export `_EXCLUDED` list exists (routes_export.py:95-102) and is not pinned by a test.
- `webui/nginx.conf` is not in the frozen base; `check_version.py:246-266` checks only its markers.

## Journal entry (for the orchestrator)
### 2026-11-23, reviewer (backend contracts), Round 15 SPEC review
- Context: Adversarial read of docs/research/2026-11-round15/SPEC.md (D1, D2.1, D3, D4.2, D4.5, D5, D6, D7, D6.10) against code at b49780c.
- Did: Verified claims in deps, auth service, prefs_write, routes.py, pipeline.py, case_manager, analyst_outcomes, audit query, write and views, stores (base, memory, sql), es client and indices, rag, chat ops tool, batch_inbox, reset, export and webui grading. Read only; no files changed.
- Tests: none run (read-only review).
- Status: done. 5 high, 12 medium and 13 low findings with SPEC corrections, plus a coverage list.
- Next: The orchestrator folds the corrections into the SPEC before Wave 1. The most urgent are H1 to H5 (CaseAction.via, the D4.4 grading claim, roster case and labels, the ES mapping client gap, the readiness computation) and M7 to M8 (ownership and doc-pin conflicts).