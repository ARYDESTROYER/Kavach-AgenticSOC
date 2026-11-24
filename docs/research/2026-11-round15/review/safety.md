Round 15 SPEC review. Lens: safety, the non-negotiables and statistics integrity. I checked every finding below in the code at `1793843`. I edited no files.

## Findings, most severe first

### 1. D4.4 and D4.1: the grading population and the ground-truth label (HIGH)

**What is wrong**
- "No rating, no grade (as today when the grade is skipped)" is false. Today every close, resolve or set_disposition of a case that has a verdict posts a feedback entry with the derived assessment, with no stars needed. There is no skip.
- Limiting the grade to closes with a rating would collapse the agreement signal that `agent_improvement` needs (`_QUALITY_MIN=30`). That contradicts the SPEC's own "the grading population does not shift".
- Deriving `actual_outcome` from the disposition is redundant. The declared close already labels the case through `classified_disposition` (the G1 "Channel B" path).
- It moves the tuner's provenance from `disposition_labels` to `feedback_labels`.
- It makes the label sticky. `_confirmation` returns a feedback label before any classification, whatever the timestamps, so a later explicit reclassification (`set_disposition` to true positive) no longer changes the ground truth.

**Evidence**
- `webui/src/soc/pages/CaseDetail.tsx:1257-1282`: `if (freshAssessment || isGradingDirty(...))`.
- `casedetail/shared.tsx:186,202,270,291`: these actions include `'grading'`.
- `CaseDetail.grading.test.tsx:114-155` pins it: "closing a VERDICT-bearing case issues BOTH the action POST and a derived feedback POST" with no stars.
- `engine/analyst_outcomes.py:135-175` (feedback first).
- `engine/threshold_tuner.py:368-371`.

**Correction**
"The Console keeps today's rule: on a close, resolve or set_disposition whose disposition matches or overrides the AI verdict, it posts one feedback entry with the derived assessment, with or without stars. Stars are optional. The Console never sets `actual_outcome` from the disposition: the declared disposition already labels the case. `CaseDetail.grading.test.tsx:114` keeps passing."

### 2. §3.5 and D5.10: review notes do reach a prompt (HIGH, #9)

**What is wrong**
- D6.6 says the review route "indexes the resolved case exactly as the feedback route does". The feedback route calls `index_resolved_case(case, note=body.comment)`.
- The note is rendered into the precedent chunk ("Analyst note: ..."), and the bulk projection re-reads the latest feedback comment.
- Resolved-case precedent is retrieved into investigator prompts, fenced as untrusted.
- So "review notes never reach a prompt" is false.

**Evidence**
- `api/routes.py:7593-7597`.
- `tools/rag.py:2829-2870` (`_resolved_case_item`), `:2786-2827` (`_resolved_case_text`), `_case_analyst_note`.
- A second path: the `audit_search` chat tool forwards each row's `result_summary` to the model, fenced (`agents/chat_tools/ops.py:534-536`, `:574-582`).

**Correction**
- "The review note is stored as `FeedbackEntry.comment` and becomes fenced untrusted precedent text, exactly as grading comments do today."
- "The `result_summary` of `case.file_attached`, `case.file_deleted`, `case.review_requested` and `case.review_recorded` rows carries only ids and codes, never a caption, filename or note, because `audit_search` forwards `result_summary`."
- Fix §3.5 and D5.10 to match.

### 3. D6.6 and D6.7: `is_review_grade` would flag ordinary grades (HIGH, statistics)

**What is wrong**
- D6.6 always appends the `auto_close_review` history event, also when the case is not in the ledger. In that case `review_id` is empty and the grade is meant to be "an ordinary grade".
- The history branch of `is_review_grade` then returns true, so the ordinary grade is wrongly left out of `feedback_stats` and `agent_improvement`.

**Correction**
"Append the history event only when `review_id` is set. The history branch of `is_review_grade` requires a non-empty `review_id` that matches."

### 4. D6.10: the reinvestigation carry-over is incomplete (HIGH, ground truth)

**What is wrong**
- `_fail_to_human_case` also rebuilds the case without `feedback`, `assignee`, `comments`, `status_history` or `disposition`. A reinvestigation that fails (provider outage, timeout) still erases the review grade.
- `status` is not carried. `apply()` uses `prev_status = case.status` (default OPEN), so a carried timeline gains an "open → X" entry after, for example, "investigating".
- "analyst-set disposition" is not defined.

**Evidence**
- `agents/pipeline.py:1748-1810`.
- `case_manager.py:146,171-180`.
- Precedent for a carry-over: `pipeline.py:1429-1432` (the analyst-policy path already carries `feedback`, `tags`, `comments` and `assignee`).

**Correction**
"Apply the same carry-over in `_fail_to_human_case`. Carry `status` (`existing.status`) so the appended transition names the real previous status. Carry the disposition only when `analyst_outcomes.standing_analyst_disposition(existing)` is not None."

### 5. D4.7: bulk actions still flip `decision_by` (HIGH, #3 statistics)

**What is wrong**
- Hiding the single-case Set disposition does not close the path. The bulk "Set disposition" and "Set status" actions in Case Manager and Cases still run on agent-closed cases, and on sampled ones.
- Every one stamps `decision_by = ANALYST`. A bulk flip also makes the ledger entry unreviewable under "terminal agent-decided".

**Evidence**
- `CaseManager.tsx:1645-1653`.
- `Cases.tsx:2163-2165`.
- `routes.py:7284`.

**Correction**
"The Console leaves agent-decided terminal cases out of bulk set_disposition and set_status (stated in the bulk help text). A review stays accepted while the first decision record (`metrics.decision_record`, first anchor) is an agent close." Alternatively, document the gap.

### 6. D1.3 overstates what it closes (HIGH, RBAC)

**What is wrong**
- `PUT /api/settings` still writes `rbac.roles`, `resources`, `denies`, `custom_roles` and `default_role` with only `settings:manage` and no fresh auth.
- A SOC manager can grant every role `*`, which has the same effect as turning role-based access off. The "Super admin only" rule therefore holds only for the on/off bit.

**Evidence**
- `routes.py:1937-1943`.
- `tests/test_runbook_permissions.py:294-314`.

**Correction**
Either:
- (a) "Any `rbac.*` change in `PUT /api/settings` also needs `roles:manage` and `require_fresh_auth()`." The test at :308 runs with sign-in off, so it still passes. Or:
- (b) state that D1.3 protects only `enabled`, and list matrix edits as a follow-up.

### 7. D6.5 and D7.5 contradict each other on scope

**What is wrong**
- Under D7.5, `case.review_requested` gets category `case_work`.
- Every `case_work` row is in People and settings whatever its `actor_type`, so the row cannot be in Agent activity as D6.5 says.

**Evidence**
- `audit/events.py:45` (`PEOPLE_CATEGORIES`), `:313-318`.
- `audit/query.py` `scope_predicate`.

**Correction**
"`case.review_requested` and `case.review_request_failed` get exact catalog entries with category `system`." Or remove "Agent activity scope" from D6.5.

### 8. Rollback gaps the SPEC does not acknowledge

**What is wrong**
- (a) The pinned previous release `45a4c31` has no preferences forward contract. `backend/app/preferences_roundtrip.py` is absent at that commit and the pin says `forward_contract: false`. Its shutdown rewrites the preferences document (`scripts/rollback_lane.py` docstring). So `team_activity` and `auto_close_review` are dropped. After roll-forward both are back on by default, which silently re-enables per-person monitoring an operator had turned off.
- (b) The D6.7 and D5.8 lane plants cannot work as written. The lane creates no cases (it has no log source). The previous release performs no case save. `_plant_future` runs only when `forward_contract` is true. `scripts/rollback_lane.py` has no owner in §4.6, yet WP4 and WP5 both plant in it.

**Correction**
- Add to known limitations and the rollback docs: "a rollback to 0.1.13-era builds resets both new settings to their defaults".
- Plant in `phase_n` (unconditional):
  1. Write a terminal agent case through the SQL case repository.
  2. Post `/api/cases/{id}/review`.
  3. Have the previous release make a full save (`POST /api/cases/{id}/comment`).
  4. In `phase_return`, assert through `/api/feedback/stats` that the grade stays excluded.
- One package owns `scripts/rollback_lane.py` and `scripts/test_rollback_lane.py`.

### 9. Review time: two definitions and no field (statistics)

**What is wrong**
- D6.11 says the time from opening the card to submitting is recorded. D3.8 says median review time is sample to completion, taken from the ledger.
- Neither the POST body nor the ledger entry has a duration field.
- Sample-to-completion measures queue latency and cannot reveal rubber-stamping.

**Correction**
- Add `elapsed_ms: int | None` (client-measured, 0 to 86,400,000) to the body and to the ledger entry.
- Team activity shows "Time spent reviewing" (median `elapsed_ms`) and, separately labelled, "Time to review" (sampled to completed).

### 10. D6.8 leaves out `_agent_reopen_summary` (statistics)

**What is wrong**
- `_agent_reopen_summary` counts every human reopen within 24 hours of an agent terminal decision. Review-driven reopens shift the period comparison.
- `via` lives on `history` and in the audit row, not on `StatusHistoryEntry`, which has no extra field.

**Evidence**
- `engine/agent_improvement.py:491-536`.
- `models.py:483-495`.

**Correction**
Decide which one:
- exclude a reopen whose same-timestamp `analyst_action` history entry carries the review marker, or
- keep it, and document that the reopen rate now includes sampled-review findings.

### 11. D6.9: `via` already exists inside the action code

**What is wrong**
- `_perform_case_action(..., via=None)` already takes a `via` parameter. Its values are `bulk`, `proposal`, `console` and `api`, and it is written on `case.closed_with_open_steps` rows.
- A body field with the same name invites wiring `body.via` into it, which would let a caller pass `"bulk"` and fake the bulk marker.

**Evidence**
- `routes.py:7141-7166`, `:7362-7368`.
- `engine/jobs.py:771`.

**Correction**
"New field `CaseAction.review_via: Literal['auto_close_review'] | None`. It is written to the history entry and audit row only and never sets the internal `via` parameter."

### 12. An existing audit-writer guard the SPEC does not mention

**What is wrong**
- `tests/test_audit_writer_outcomes.py:1371-1397` requires every writer to name `outcome`.
- Every `**row` splat must be registered in `_SPLAT_PRODUCERS` (`:1272-1278`), exactly one per scope, with a runtime-pinned producer (`:1400-1424`).
- The D3.12 and D6.13 Demo seeding of backdated rows, and every new writer, must comply.

**Correction**
Add to WP3, WP4 and WP5: "every new audit call passes `outcome` and `actor_type`; Demo seeders register in `_SPLAT_PRODUCERS` and `test_the_splat_producers_supply_an_outcome`."

### 13. D3.9 and D3.12: Demo analysts would show as "Deleted account"

**What is wrong**
- The seeded rows use `DEMO_SOC_ANALYSTS`, who are not in the real user store. The user store is not Demo-swapped.
- The roster rule therefore labels them "Deleted account".

**Evidence**
- `engine/demo_generator.py:791`.
- `state.py:649-720`.

**Correction**
"While Demo Mode is on, the roster adds `DEMO_SOC_ANALYSTS` as active Demo accounts labelled 'Demo analyst'."

### 14. D5.2 and D5.11: Demo uploads live in process memory

**What is wrong**
- The Demo KV is `EsKVStore(InMemoryESClient())`, so the 2 GiB organisation cap is RAM.
- The same applies to the in-memory store fallback (`Secrets.es_store_enabled`).

**Evidence**
- `engine/demo_runtime.py:217,237`.

**Correction**
"Demo store cap: 64 MiB in total and 5 images per case (`409 case_files_storage_full`). The in-memory store fallback uses the same cap."

### 15. D7.2 and D7.3: attribution and the bulk marker

**What is wrong**
- Bulk rows come from two paths:
  - `POST /api/cases/bulk`, with `batch_id=new_id("bulk-")` (`routes.py:7487-7500`).
  - The `case_lifecycle` job, with `batch_id=f"bulk-{job.job_id}"` (`jobs.py:756-772`).
- The assign and tag jobs call the routes with `request=None` and `analyst=job.actor` (`jobs.py:775-801`).
- "Body value only when sign-in is off" would drop the job actor when sign-in is on.
- The pipeline's `RunStampedAudit` already stamps `run_id` on agent rows (`pipeline.py:158-182`).

**Correction**
- "`_perform_case_action` stamps `run_id=batch_id` when set; the assign and tag job rows get `run_id='bulk-<job_id>'`."
- "The fold treats a row as bulk when `run_id` starts with `bulk-`."
- "Attribution follows `case_feedback`: the resolved principal, else the body value."

### 16. D1.2: switch refusals and fresh auth (RBAC)

**What is wrong**
- The in-body stored-role 403 writes no Access denied row. `_enforce` does write one (`deps.py:979-1006`).
- `require_fresh_auth` treats a missing sid, an unknown sid or a store glitch as fresh (`deps.py:1078-1099`), which is weak for a switch whose "off" escalates every account.

**Correction**
- "On `403 rbac_super_admin_only`, write `record_access_denied`."
- "`PUT /api/rbac` requires a registered session with a known recent re-authentication. A missing or unknown sid, or a store failure, answers `401 reauth_required`." Precedent: `require_system_update_operator`, `deps.py:1111-1180`.

### 17. D3.4: Team activity is open to everyone by default (privacy, decision)

**What is wrong**
- With role-based access off (the default), `team:view` is effectively held by every account.
- The stored role is still known when role-based access is off (`auth/service.py:619-630`).

**Recommendation**
"While role-based access is off, the team routes also require a stored role of `super_admin`, `soc_manager` or `auditor`, or the environment administrator." Otherwise state that the callout is the only protection.

### 18. D3.3: `team_activity` needs to be in `CURATED_SECTIONS`

**What is wrong**
- Only `auto_close_review` is added. The Advanced long tail would render `team_activity.enabled` as a second save path.

**Evidence**
- `advanced-schema.tsx:55-80`. Precedent test: `advanced-schema.test.tsx:129`.

**Correction**
Add `team_activity` to `CURATED_SECTIONS`, with a test.

### 19. D6.2: "rejected on write (422)" has no mechanism or owner

**What is wrong**
- A clamping validator repairs the merged document, so `PUT /api/settings` would clamp instead of rejecting.
- The rejection needs a check on the request body inside `put_settings._apply`, like `_reject_out_of_range_caps` (`routes.py:1979-1981`). That `routes.py` region is not assigned to any package.

**Correction**
Assign it to WP5 (or WP1) and name the precedent.

### 20. D4.5: what an average shows when nothing was rated

**What is wrong**
- The SPEC does not say what `avg_*` returns when no entry rated that sub-score.
- An API caller's explicit `0.0` becomes "unrated", which is not documented.

**Correction**
Either:
- keep `0.0`, add `rated_accuracy`, `rated_reasoning_quality` and `rated_action_appropriateness` counts, and have the chat feedback tool show "not rated" when the count is 0 (`chat_tools/metrics.py:1534`); or
- make the averages `null`, with a types mirror.

Either way, document that 0.0 means unrated.

### 21. D6.12: the `caseOutcome` feedback branch is under-specified

**What is wrong**
- "Exactly like the backend" also changes cases graded the ordinary way, for example the Demo-seeded `demo.analyst` grades on agent closes (`demo_generator.py:1330-1343`).
- No copy is given for a non-review feedback label, and there is no TypeScript mirror of `is_review_grade`.

**Correction**
Add an `isReviewGrade` TypeScript mirror. Review grades get the "Reviewed: ..." and "Review disagreed: ..." copy. Ordinary feedback labels get "Confirmed by an analyst: {label}". Add a test for each.

### 22. D5.10 and D6.3: static guards are too narrow and too vague

**What is wrong**
- The ban covers only the files store, so team counts (#7) are not guarded.
- "Guards updated" names no test. The existing `decide()` guards scan only `case_manager.py`.

**Correction**
- Also ban `engine/team_activity` and `stores/auto_close_review` from `app/agents/**`, `app/tools/**`, `engine/report_digest.py`, `engine/chat_starters.py` and `agents/standup.py`.
- Allow `engine/auto_close_review` only from `agents/pipeline.py`.
- Add an import guard against `case_manager` for `engine/auto_close_review.py`, `engine/review_origin.py`, `engine/team_activity.py`, `engine/case_images.py`, `routes_auto_close_review.py` and `routes_case_files.py` (pattern: `test_overhaul_b2_autopilot.py:307-316`).

### 23. D6.6: idempotency and write order are unspecified

**Correction**
- "Order: audit row, then re-fetch and case save, then ledger CAS. A failed ledger CAS after the save is logged and retried once; the review stands."
- "A second review on a completed ledger entry answers `409 review_already_recorded`."
- "A case whose first decision record is not an agent close answers `409 review_not_agent_closed`."

### 24. D6.12 and D3.8: what the review rates can claim (statistics)

**What is wrong**
- The daily and per-rule caps make the sample stratified and unweighted. The eligible count is taken by creation day while samples are taken by decision day.
- The per-reviewer agreement rate on Team activity has no minimum sample.

**Correction**
- "The module states that agreement describes the sampled cases only, unweighted, and is not an estimate of auto-close precision."
- "The eligible count uses the first agent decision day (`metrics.decision_record`)."
- "Per-person agreement shows 'N of M' counts, and a rate only when M is at least 30."

### 25. D3.8: median time to acknowledge is a second definition

**What is wrong**
- It differs from the metrics MTTA: `_created_dt` prefers `detected_at`, and only human acknowledgements count (`metrics.py:395-432`).
- It needs case creation times, which the audit rows do not carry.

**Correction**
Reuse `metrics._created_dt` and the human-only rule. Name the case-store read, bounded at 5,000 cases.

### 26. Reset and export of the review ledger are unspecified

**Correction**
"The cases-tier reset clears `auto_close_review` (receipt `kv:auto_close_review:<n>`); factory reset purges it; data export includes the ledger metadata."

### 27. D3.11: the client CSV must defuse formulas

**What is wrong**
- Display names are user text.

**Correction**
Name `webui/src/lib/csv.ts` (the shared formula-defusing encoder) for the export.

### 28. D3.10: limit the person events timeline

**Correction**
- Only the D3.8 kinds appear.
- `detail` is built from structured fields only (case number, disposition, actions taken), never from `result_summary` or `client`.
- Otherwise a custom role with `team:view` but without `audit:view` reads sign-in and settings rows.

## Claims checked and found correct

- `decide()` has one production call site (`pipeline.py:1161`). The post-decision hooks run after `apply()` and `save()` (`:1161-1214`), and the analyst-policy path returns before them.
- `engine/case_manager.py` has MD5 `212873cd13d822a7b64752635285ff1f` and contains none of the words origin, review or feedback.
- The guards in `test_wave6_decide_guard.py`, `test_round3_wave0_foundations.py` and `test_p1_severity_ladder_contract.py` inspect only `case_manager.py`, so no new module trips them.
- `apply()` fills `disposition` only when it is None (`case_manager.py:165-168`).
- `FeedbackEntry` has no `model_config`, so unknown keys are dropped on load (`models.py:456-471`). `Case.history` is `list[dict]` (`models.py:1947`).
- `analyst_confirmed_outcome` reads feedback first, whatever `decision_by` is (`analyst_outcomes.py:135-175`). `benign` maps to false positive.
- `PROVENANCE_COUNT_KEYS` is at `stores/proposals.py:104`; `PrecedentWindowConfig` is at `config.py:2821`.
- `feedback_stats` averages over all entries (`metrics.py:160-162`). `FeedbackBody` defaults the stars to 0.0 (`routes.py:7511-7519`). Console stars map to 0.2 to 1.0.
- `case_aggregate._ANALYST_FIELDS` includes `feedback` and `history`, so `is_review_grade` can work on that projection.
- `_perform_case_action` stamps ANALYST at `routes.py:7284`. Lifecycle rows are best-effort after the save, and `result_summary` is positional (G1 test `:303`).
- The backend G1 tests post feedback directly and are not affected by a Console-side change.
- The `event_predicate` family resolution in `audit/query.py:318-326` behaves as the SPEC says.
- `failure_action` derives the failure names the SPEC lists from `_BASE_VERBS` (`write.py:70-80`).
- `PUT /api/settings` protects `demo` the same way (`routes.py:1991`).
- `test_runbook_permissions.py:308` writes `rbac.roles` through PUT. The full round trip (`test_settings_roundtrip.py:50-57`) sends an equal `rbac.enabled`, so D1.3 keeps both passing.
- No other preferences writer touches `rbac`: setup/complete, sources, branding, prefs/org and terminology were checked; factory reset restores the defaults.
- `audited_prefs_write` writes `settings.updated` to `control_audit`, with 503 and 409 semantics (`prefs_write.py:185-235`).
- `AuthService.verify` returns the current stored role (`service.py:599-630`).
- `rbac` is already in `CURATED_SECTIONS`.
- `_merge_grants(additive=False)` replaces per resource, so upgraded installs get the `team` default.
- The `RESOURCE_ACTIONS` ratchet is at `test_round14_contracts.py:1136-1170`.
- Route auth coverage counts `require_fresh_auth` as an authorisation gate.
- `_RunbookRoute` is the precedent for bounding a request body (`routes_runbooks.py:132-159`).
- nginx `/api/` is a plain prefix location, so a regex location wins over it (`nginx.conf:58`).
- `extend_audit_mapping` is the precedent for an additive mapping (`es/indices.py:308-360`).
- The audit export defuses formulas (`engine/audit_export.py:48`).
- `audit_search` exposes no `changes` or `target` field and fences `result_summary`.
- The chat case tools never carry history or comments, and the chat engine's case context has no comments or feedback.
- `rag_service`, the inbox, the audit log and the cases are Demo-swapped (`state.py:649-720,1069-1072`).
- Preferences migration stamps and repaired values are carried automatically on save (`preferences_roundtrip.py:65-140`).
- No test pins the full set of Preferences keys. `test_overhaul_b2_autopilot.py:75` and `test_settings_roundtrip._NESTED_BLOCKS` list named blocks only, so the two new blocks break no snapshot apart from the generated console map and knowledge corpus.
- Every test file the SPEC cites exists.

## Journal entry

### 2026-11-23, reviewer (safety, non-negotiables, statistics), Round 15 SPEC review
- Context: adversarial review of `docs/research/2026-11-round15/SPEC.md` for #2, #3, #7 and #9, RBAC security, uploads, rollback, Demo Mode and statistics integrity.
- Did: read-only check against the code at `1793843`. Found 28 issues. The top six are D4.4 grading population and label stickiness, review notes reaching precedent prompts, false positives in `is_review_grade`, the missing `_fail_to_human_case` carry-over, bulk flips of `decision_by`, and the overstated D1.3 bypass closure. Corrections for every item are in the report.
- Tests: none run (review only).
- Status: done.
- Next: the orchestrator amends the SPEC (D4.4, D6.6, D6.7, D6.10, D4.7, D1.3, D6.5, D6.9 and D6.11, §3.5, ownership of `scripts/rollback_lane.py`) before WP1 starts.
