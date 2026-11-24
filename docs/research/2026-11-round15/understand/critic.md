# Round 15 completeness critique (reader: critic)

Read only. Branch `claude/round15` at `b49780c` ("Journal: Round 15 start"), which is
`origin/Testing` `c4227bd` plus one Journal commit, so line numbers cited by maps at either
commit agree. Inputs: the seven maps in this folder (rbac-wizard, activity-data,
casemanager-ui, close-flow, qa-sampling, storage-attachments, platform). Every settled claim
below was re-checked in the tree; the one item I could not verify here (a live
Elasticsearch field limit) is marked UNVERIFIED.

---

## 0. Headline: what the SPEC must not miss

1. **The QA review's ground truth can be destroyed by a reinvestigation.** `_assemble_case`
   (`backend/app/agents/pipeline.py:1555-1678`) rebuilds the Case without `feedback`,
   `assignee`, `comments`, `status_history`, `disposition`, `acknowledged_at`. A reviewer who
   disagrees, reopens and then reinvestigates erases the review grade they just recorded.
   Reinvestigating a still-closed case mints a second case instead (`pipeline.py:816-824`,
   `signatures.py:33-57` match OPEN cases only). Fix the carry-over in Round 15 or block
   reinvestigation from the review flow. No map connects these two defects to the review feature.
2. **Adding structured `case.*` actions to lifecycle, collab and feedback rows silently breaks
   the Audit log's existing filters.** The family filter `status` resolves to
   `Prefix(action,"status.") OR (missing(action) AND action_type=="status")`
   (`backend/app/audit/query.py:318-326`). A new lifecycle row with `action="case.closed"` and
   `action_type="status"` no longer matches "Case status changed" (the menu offers that
   legacy family, `webui/src/soc/components/audit/events.ts:333-355`). The same applies to
   "Case updated" (`collab`) and "Verdict graded" (`feedback`). activity-data recommends the
   actions but does not mention this regression.
3. **A previous build drops new `FeedbackEntry` fields on rollback.** `FeedbackEntry`
   (`backend/app/models.py:456-471`) has no `model_config`, so pydantic ignores unknown keys.
   The rollback lane's build (`45a4c31`) loads a case carrying `origin="auto_close_review"`,
   then its next full save (`stores/cases.py:105-131`, full replace) deletes the marker. After
   roll-forward, that review grade reads as an ordinary grade and contaminates
   `feedback_stats` and Agent effectiveness, which is exactly what the marker exists to
   prevent. close-flow and qa-sampling both recommend the marker without this caveat.
4. **The Elasticsearch config index shares one dynamic mapping (default limit 1,000 fields),
   and that budget is already heavily used.** The default `Preferences` document alone maps
   to about 514 fields, `.keyword` multi-fields included (measured from
   `Preferences().model_dump()`). `case_activity` and `case_tasks` are single KV documents
   keyed by case id (`stores/case_activity.py:10-15`, `stores/case_tasks.py:9-13`), written
   raw by `EsKVStore.put` (`stores/memory.py:100-106`) into `{"dynamic": true}`
   (`es/indices.py:405-408`), so every case id becomes new mapping fields. `case_thread` moved
   to opaque rows on ES for exactly this "unbounded mapping growth" (`stores/case_thread.py:71-80`);
   these two stores did not. The in-memory fake ES does not enforce the limit, so no test can
   see it. UNVERIFIED on a live ES, but every Round 15 namespace, Preferences block and
   activity writer spends from this budget.
5. **The existing "Set disposition" path on an auto-closed case competes with the new review
   form and corrupts last-writer statistics.** `actionPlanForStatus` offers Set disposition on
   every closed case (casemanager-ui §3.3 table), and `_perform_case_action` stamps
   `decision_by = ANALYST` unconditionally (`backend/app/api/routes.py:7284`). If both stay
   visible, analysts will "confirm" a sampled auto-close the old way, and the case moves to
   the human column of every last-writer metric. The SPEC must choose one path.
6. **The Case Manager queue scopes cannot show review work.** Sampled cases are terminal, so
   they never appear in Active. Mine is assignee-based, and review ownership belongs in KV,
   not `assignee`. A review queue needs its own scope or chip, a server filter backed by the
   KV ledger, and probably a router deep-link key, which costs entry bytes.
7. **Asks 3 and 4 are probably one surface**, the user's two descriptions of "who did what,
   daily". Building an "activity tracker" and a separate "admin work page" would break the
   navigation rule "distinct operator jobs, not alternate reports over the same objects"
   (`docs/development/ui-standard.md:1197-1396`). It would also spend entry bytes twice.
8. **With RBAC off (the default), a team-activity page shows every colleague's activity to
   every signed-in account.** Asks 1 and 3/4 are coupled. The page should state this and
   link to the new switch, and the SPEC should decide whether the page needs RBAC on.
9. **The redesigned close dialog must not starve the grading supply.** Agent effectiveness
   needs at least 30 grades (`engine/agent_improvement.py:51`), and `feedback_stats` already
   averages unrated stars as 0.0 (`engine/metrics.py:160-162`; the Console omits unrated
   stars, `webui/src/soc/pages/casedetail/grading.tsx:245-248`, and `FeedbackBody` defaults
   them to 0.0, `routes.py:7511-7519`). Review grades without stars deepen that distortion.
10. **A known provenance bug sits inside the redesign scope and no map lists it.** The "AI
    assessment" card falls back to the code's `decision_rationale`
    (`webui/src/soc/pages/casedetail/InvestigationPanel.tsx:157-158`), so code text is shown
    as the model's reading. The Journal 2026-11-12 follow-up list already names it.

---

## 1. Contradictions between maps, settled

| # | Maps | Claim A | Claim B | Settled (evidence) |
|---|---|---|---|---|
| C1 | qa-sampling vs platform | qa-sampling: `settings-sections-meta.ts` "is in the entry chunk, so a new Settings section meta costs entry bytes" (cites `:62-70`) | platform: the module is LAZY | **Lazy.** The comment at `settings-sections-meta.ts:66-68` ("This module ships in the first-paint entry chunk") is stale. `bundle-first-paint.test.ts:245-266` asserts no modulepreload, no static entry import and no section keyword in the entry (Round 12 WP-GEN-A). A new Settings section or anchor costs no entry bytes. It still changes `console_map.json`, the knowledge manifest and `settings-sections.test.ts`. Fix the stale comment while there. |
| C2 | activity-data vs close-flow, qa-sampling | `decision_by = ANALYST` at `routes.py:7290` | at `routes.py:7284` | **7284** (grep). Cosmetic, but the SPEC should cite 7284. |
| C3 | qa-sampling vs close-flow | qa-sampling: reinvestigating a still-CLOSED case "appears to mint a new case id ... (verify before relying on it)" | close-flow: probe-confirmed | **Confirmed by code.** `_investigate_cluster_run` starts from `case_id = new_id("case-")` and reuses an id only from `find_open_case_for_cluster` (`pipeline.py:816-824`), which matches open statuses only (`signatures.py:33-57`). `tests/test_case_actions_reinvestigate.py:80,156` assert "in place" for OPEN cases only. The reinvestigate route passes `force=True` and no case id (`routes.py:7853-7912`). |
| C4 | rbac-wizard, activity-data vs others | base `c4227bd` | base `b49780c` | **Same code.** `b49780c` = `c4227bd` + the Journal commit. |
| C5 | rbac-wizard vs activity-data vs platform | three options for the team-activity gate (reuse `audit:view`, a new narrow resource, a new role) | activity-data: `audit:view` is the "minimum consistent gate" | **Not a contradiction but undecided.** `audit:view` = {super_admin, soc_manager, auditor} (`rbac/policy.py:434-520`). Consequence nobody spells out: an auditor holds `audit:view` but not `users:manage`, and `GET /api/users` needs `users:manage` (`routes.py:5784-5790`). For an auditor the page can only list people who appear in audit rows, so idle users are invisible and display names are unavailable. Needs a decision (§3 D4). |
| C6 | storage-attachments vs platform | storage: 2 MiB per image, a new nginx location with `client_max_body_size`, a bounded route class | platform: "either an nginx change or client-side downscaling below 1 MiB" | **Compatible; a decision.** nginx is free to change: `deploy/update-base-v1.sha256` is exactly the sha256 of `deploy/docker-compose.agnostic.yml` (`e3f7ecbb…`), not of `webui/nginx.conf`. The backend port 8088 is published directly, so the backend body cap is required in either case. |
| C7 | close-flow, qa-sampling | review verdict as a `FeedbackEntry` with an additive origin marker | (same) | **Agreed, but incomplete.** Neither map says the marker is lost on rollback (headline 3), or that `/feedback` save is last-writer with no CAS while the pipeline also re-saves cases. |
| C8 | activity-data vs platform | activity-data: the audit log is the source of truth for per-analyst work | platform: seeded Demo human closes are NOT audit rows (`engine/demo_generator.py:1638-1794` writes Demo audit rows only for runbook runs) | **Both true, so the tracker is near-empty in Demo** unless seeding adds backdated Demo audit rows for seeded human work (`record_strict` accepts `ts=`, `stores/base.py:800-860`), or the tracker also folds `status_history`. Decide (§3 D6). |
| C9 | qa-sampling | inline (decision-time) sampler or daily batch sampler | (internal) | **A decision.** Inline needs only the post-decision hook (`pipeline.py:1201-1214`) and lands inside the 24 h objection window. The analyst-policy path returns at `pipeline.py:1458` without hooks. |
| C10 | casemanager-ui vs AGENTS.md / docs | docs claim "each fact has one home" (`docs/analyst/case-manager.md:157`) and a footer CTA | owner editable in 3 places, actions in the header | **The map is right; the docs and comments are stale** (`CaseDetail.tsx:17-18,28`; the test is still named `CaseDetail.footer.test.tsx`). |

No map contradicted another on RBAC semantics, the feedback grant (`cases:write`, inline
`_enforce`), `decide()` call sites (one production site, `pipeline.py:1161`, re-grepped: no
other `CaseManager(...).apply`), or the attachment grants (`cases:comment`; delete by uploader
or `cases:close`, matching `_require_author_or_moderator`, `routes_cases_collab.py:577-605`).

---

## 2. Gaps no map covers

### G1. Audit filter regression from structured case actions (see headline 2)
- Evidence: `audit/query.py:318-326`; legacy families in the Event menu
  (`components/audit/events.ts:340-344`); legacy entries `status/*`, `collab/*`, `feedback/*`
  (`audit/event_categories.json`, `legacy_events`).
- Also affected: saved links such as `#/audit?event=status`, the Audit export job filter, and
  the chat ops audit tool if it filters by family.
- Options: (a) extend `event_predicate` with a family-to-actions alias table so `status` also
  matches the new lifecycle actions, and `collab` and `feedback` likewise, in the Python
  reference, the ES compile and the SQL compile together; (b) keep the legacy family as the
  menu label but resolve it to `Prefix("action","case.")` plus legacy, which over-matches;
  (c) leave `action` unset and add the verb elsewhere, which defeats the tracker. (a) is the
  only one that keeps old filters exact. Add a test with one old-shape and one new-shape row
  per family.

### G2. Reinvestigation erases review and analyst work (see headline 1)
- Fixing `_assemble_case` to carry `feedback`, `assignee`, `comments`, `status_history`,
  `disposition`, `acknowledged_at`, `escalation_level` and `status_reason` touches the
  pipeline, not `decide()`. `apply()` overwrites `decision_by` and fills `disposition` only
  when `None` (`case_manager.py:162-167`), so a carried analyst disposition survives. That is
  a behaviour change for re-verdicting, so state it in the SPEC.
- Tests: `test_case_actions_reinvestigate.py`, `test_analyst_classification_wins.py`, the
  `decide()` source guards (unchanged).
- If not fixed, the review UI must not offer Reinvestigate, and the docs must say why.

### G3. Rollback drops the review marker (see headline 3)
- Options: (a) accept and document it; the rollback lane plants a review grade and the
  docs name the contamination; (b) make the KV review ledger the authority for "this grade
  is a review", keyed by case id, feedback `ts` and analyst. The old build never writes that
  namespace, but consumers (`agent_improvement`, `feedback_stats`) would then need a KV read;
  (c) both: the marker on the entry, and the ledger used to re-mark after a rollback.
- The same applies to any new Case field (storage-attachments §4.5 already says so for
  attachments).

### G4. Elasticsearch config-index field budget (see headline 4), UNVERIFIED live
- Measure first: `GET tlsoc-agent-config/_mapping`, then count fields on a real
  deployment, in the deploy session (registries are blocked here, AGENTS.md §6a).
- Rules for Round 15: every new KV document uses a fixed, namespace-prefixed set of at most
  about 6 top-level fields, with the payload in one opaque JSON string (the `chat_starters`,
  `reports` and `runbook_runs` pattern). Never key a dict by case id, user, date or rule.
  qa-sampling's "per-day counters for the last 90 days" must be opaque, because date-named
  keys would add fields every day forever. Keep a new Preferences block small; every field
  spends from the same mapping.
- Round 15 must not add attachment or review entries to `case_activity` on ES until that
  store moves to opaque rows (the `case_thread` precedent). Otherwise it feeds the explosion,
  and `kv_mutate` swallows the failure, so the feed silently stops.
- A mapping-limit failure is not local to the activity doc. Once the shared mapping is full,
  any config document that introduces a NEW field fails to index, including a Preferences
  save with a new Round 15 block.

### G5. Two disposition paths on auto-closed cases (see headline 5)
- Options: (a) on an agent auto-closed case, hide Set disposition while a review is
  pending and offer the review form; (b) route Set disposition on an agent-decided terminal
  case through the feedback channel, with no `decision_by` stamp, which changes a Round 12
  wire behaviour and needs tests; (c) fix `set_disposition` to keep `decision_by` when status
  does not move. Option (c) is the most general and also fixes close-flow defect 5, but it
  changes the ground-truth rule: `analyst_outcomes.py:81-100` counts a disposition only when
  `decision_by == "analyst"`. Pick explicitly.

### G6. Queue model for review work (see headline 6)
- Needs: a scope or chip, a `GET /api/cases` query parameter resolved from the KV ledger's
  case-id set (ES `terms` on `case_id`, SQL `IN`, bounded by the ring size), loaded-vs-total
  semantics, a `DEEP_LINK_KEYS` entry (`router.tsx:160-198`, about 20-60 B of entry), and live
  update. Sampling does not save the case, so no `case.changed` fires and the queue will not
  refresh on its own. Use the `inapp` frame or polling.
- Mine is assignee-based. Either show review requests in Mine through the ledger, or say they
  are only under the review scope.

### G7. Close dialog plus screenshots ordering
- If screenshots can be added in the close dialog, that is two requests (uploads, then
  close). Uploads must stay independent of the close: allowed on closed cases, never
  blocking or rolling back a close. Any "evidence required to close" rule would be a new
  close gate. Like the open-steps reason, it must never be read by `decide()` (#3) and must be
  skipped for automatic closes. `BulkCloseDialog` has no attachments; say so.

### G8. Grading supply and star averages (see headline 9)
- If the redesign removes the explicit "What actually happened?" select, decide whether the
  close still posts a grade derived from disposition against the AI verdict. G1 says
  `actual_outcome` comes only from an explicit choice; a disposition is an explicit choice,
  but mapping it would move labels from `disposition_labels` to `feedback_labels` in the
  tuner's provenance (`threshold_tuner.py:317-385`).
- Make unrated stars absent rather than 0.0. This is an additive nullable change, or the
  aggregation can skip zeros. Otherwise exclude review-origin grades from the star averages.

### G9. People analytics: privacy and incentives
- No map discusses that per-person work counts are employee monitoring. The SPEC should:
  show counts with context and no ranking, leaderboard or composite productivity score (the
  `agent_improvement` "never a composite score" precedent); never show IP or user agent there
  (that stays in the Audit log under `audit:view`); state that retention follows audit
  retention; and consider an operator switch to turn the page off, since some jurisdictions
  and works councils restrict this.
- Incentive coupling with QA: counting closes per person rewards speed. Pair counts with
  review outcomes per reviewer and time to review, as qa-sampling c.1.6 suggests, so
  rubber-stamping is visible rather than rewarded.

### G10. What "daily" means
- Operator zone (`SlaPolicy.timezone`, the case_aggregate rule) or viewer zone? SOC night
  shifts cross midnight, so a calendar day splits one shift. The Standup already has shift
  windows. Decide day buckets in the operator zone, and possibly a shift view later.

### G11. Bulk work inflates per-person counts
- A bulk close of 500 cases writes 500 lifecycle rows by `job.actor` (`engine/jobs.py:748-774`),
  and the row carries no `via` or batch id (`routes.py:7342-7356`; the batch id lives only in
  `case.history`). The tracker cannot separate one considered close from one click on 500.
  Add a bulk marker to new rows (for example `run_id="bulk-<job>"` or a `tool_input.via`), or
  count bulk jobs separately.

### G12. Roster, names and deleted users
- Display names need `users:manage`. Audit actors are usernames. Deleted users keep their
  historical rows (`auth/service.py:289-361` intentionally leaves the audit). Decide: a narrow
  read projection (username, display name, role, active) under the tracker's grant, or
  usernames only.

### G13. RBAC switch side effects nobody listed
- Running jobs re-check live grants per item (`engine/jobs.py:518-616`, `job_permission_lost`).
  Turning RBAC on can therefore cancel a running bulk job started by a Tier 1 account under
  RBAC off. Say so in the confirm dialog copy and the docs.
- Open SSE streams keep the topics granted at connect time (`gate_realtime_topics`,
  `routes.py:451-455`, evaluated once). Low impact for built-in roles, since all hold
  `cases:read` and `runbooks:read`, but custom roles may not.
- Session limits are live (`auth/session_limits.py:235-257`). Toggling RBAC while Super
  admin is excluded from Remember me changes every remembered session's eligibility at its
  next check. The confirm copy should name it.
- `PUT /api/settings` must protect `rbac.enabled` the way it protects `demo`
  (`routes.py:1991`), or the switch's stricter gate is bypassable
  (`settings:manage` holders, no fresh auth). Tests write `rbac.roles` through PUT
  (`test_runbook_permissions.py:267-308`), so protect only `enabled`. The documented curl
  recipe changes, which is a compatibility note for operator scripts.
- Read-only settings mode and Demo Mode: decide whether the switch honours
  `read_only_settings_mode` (the roles routes do not) and whether it is allowed in Demo Mode.
  It is real state written to `control_audit`.

### G14. "Fix the RBAC switch" means "add one"
- Verified: no switch exists. A grep of `webui/src` finds only the Posture status row
  (`pages/settings/security.tsx:50-55`), the Roles callout ("there is no switch for it on this
  page", `pages/Roles.tsx:348-355`) and the Remember-me note. The Journal of 2026-11-12 lists
  "No Console switch for `rbac.enabled`" as a product follow-up. Put the switch in one place
  (Roles & permissions, or the Security Posture row) and link from the other, so there are
  not two save paths (`ui-standard.md:2010-2016`).

### G15. Attachment details the storage map leaves open
- Queue or list indicator: the KV store cannot list keys, so a paperclip on queue rows means
  one index read per row (an N+1 over 50 rows). Leave it off the queue, or accept the cost.
- Attachments do not save the case, so other viewers learn of them only through
  `case.activity` on `cases:{id}` (and only once G4 is solved on ES).
- Exports: `_case_view` JSON and the Markdown report export (Take action) carry no
  attachments. State whether they list metadata.
- Alt text: use the caption as the accessible name; the lightbox must use Radix Dialog
  (jsx-a11y is at error).
- Duplicate case: reinvestigating a closed case leaves its screenshots on the old case (C3).

### G16. Review sampler details the qa map leaves open
- Hot-spot contention: counting `eligible` on every auto-close does a strict CAS on one
  document per close, and `kv_mutate_strict` raises after 8 conflicts. With 25 concurrent
  investigations per tick, prefer computing `eligible` at read time from the durable
  decision records (`metrics.py:2128-2178`), and write the ledger only for sampled cases.
- "Once per case" depends on the ledger ring. The hash score is deterministic, so after
  eviction a re-closed case is re-selected. Accept and document it, or keep an opaque
  sampled-id set bounded by days.
- No backfill: sampling starts with the first decision after upgrade. Say so.
- Who reviews: a shared pool queue, or a named reviewer chosen by round-robin over eligible
  users (`engine/batch_inbox.py:51-114` audience precedent)? With auth off there are no users
  to route to; the queue itself must be the surface.
- Notifications: it is the first producer of inbox `assignment` (`constants.py:681`, no
  current producer). Category preferences already exist.

### G17. One known UI provenance bug in scope (see headline 10)
- `InvestigationPanel.tsx:157-158`: `summary = reasoning || decision_rationale || c.summary`.
  The fallback to `decision_rationale` labels code text "AI assessment". Fix it within the
  redesign and pin it with a test.

### G18. UI evidence capture
- Task 4 needs screenshots. Chrome is present (`/usr/bin/google-chrome`); Playwright is not
  installed and its CDNs are blocked (AGENTS.md §6a). Plan headless Chrome screenshots
  against `./scripts/run-demo.sh` with Demo seeds that exercise each new surface (review
  queue, attachments, team page).

---

## 3. Decisions the SPEC must make (numbered for reference)

- D1 RBAC switch location (Roles page vs Security posture), its gate (stored `super_admin`
  only, or `roles:manage` checked against the post-enable matrix), fresh auth, and stricter
  rules for turning it OFF; protect `rbac.enabled` in `PUT /api/settings`; behaviour with auth
  off, in read-only mode and in Demo Mode; audit action name (`settings.updated` or a new
  `rbac.*`, which changes `event_categories.json` and its contract).
- D2 Wizard copy: exact strings; whether `hasProvider` keeps counting only OpenAI and
  Anthropic keys. An Anthropic-only workspace shows "Ready for live triage" while the
  default roles are OpenAI (`config.py:66` `DEFAULT_COMPLETION_MODEL = "gpt-5.6-luna"`); the
  byte delta must fit the entry.
- D3 One team surface or two (headline 7); placement (an Analytics child, a host tab of
  Audit log or Standup, or a new row) and its byte cost.
- D4 Gate: reuse `audit:view`, or a new narrow resource (for example `team:view` for
  soc_manager and auditor; `RESOURCES`, the matrix, `Roles.api.ts` ratchet, docs). Answer the
  user's "i hope we have a role for that": SOC manager, with Auditor read only.
- D5 Data source and exactness: audit push-down (ES composite, SQL GROUP BY) plus a fold,
  structured actions for new rows, the legacy-family compatibility of G1, the attribution fix,
  and whether lifecycle audit moves to audit-first, which changes failure semantics to 503 for
  every close.
- D6 Demo content for the team page (seed Demo audit rows, or fold `status_history`).
- D7 Close dialog shape: what stays (disposition required and empty, G1), what merges
  (Resolution overlaps Benign and Duplicate; "What actually happened" overlaps TP and FP),
  how grading supply is preserved (G8).
- D8 Review: inline or batch sampler; rate, daily cap, per-rule cap; default ON or OFF
  (#10: it creates human work); strata (agent FP, agent TP opt-in, policy closes);
  pool or named reviewer; expiry; disagreement routing (reopen needs `cases:close`; Tier 1
  cannot); where the review is recorded (FeedbackEntry plus marker, with G3); the Set
  disposition conflict (G5); exclusion from `feedback_stats` and Agent effectiveness;
  never `PROVENANCE_COUNT_KEYS` or `PrecedentWindowConfig`.
- D9 Attachments: per-image and per-case caps vs the nginx limit; content route headers;
  ES `binary` mapping exception or accept text indexing; the factory-purge memory fix as a
  prerequisite; Demo store; export metadata.
- D10 Case Manager redesign scope: which facts keep one home; tab set (CASE_TABS is entry and
  a deep-link contract; `tab=` redirects); delete the dead `'default'` presentation branches
  (tests loop both presentations); keep the Sheet host working (Overview, Investigate).
- D11 Pre-existing defects to fix in-round vs spawn as tasks: reinvestigate carry-over (G2,
  recommended in-round), duplicate case on closed reinvestigate, notifications ignoring
  `on_closed` (`routes.py:7419-7437`), `first_response_at` never written, `case_activity`
  and `case_tasks` opaque rows on ES (G4).

---

## 4. Top risks (ranked)

1. **Entry-bundle overflow.** 77 B of headroom locally and about 31 B in CI, where the build
   stamps 46 B more (`bundle-first-paint.test.ts:97-99`). Costs: Wizard copy 1 B per
   character, since it is eager; a nav row 66 B, a child 40 B, a standalone lazy page
   260-330 B, a host tab 120 B; a `DEEP_LINK_KEYS` entry 20-60 B; a `CASE_TABS` change 10 B;
   an `api.ts` method 60-120 B (new client calls go in lazy `api-*.ts` modules).
   Mitigations: shorten the wizard copy (it saves bytes); remove the 818 B of redundant hidden
   FEATURES entries (platform b.5; repoint `registry-router-round6.test.tsx:121`); or make one
   recorded orchestrator rebase. A rebase must update or repoint the record pinned by
   `test_docs_round12_records.py:239-263`.
2. **`decide()` drift and #3 leaks.** The sampler belongs after `apply()` + `save()` and
   must never import `case_manager` (source guards `test_wave6_decide_guard.py`,
   `test_round3_wave0_foundations.py:113-127` with a new review field name added to the
   banned list, `test_p1_severity_ladder_contract.py:760-783`). The review write must never
   stamp `status`, `decision_by` or `disposition`. The close redesign must keep `wireAction`
   (`close_disposition` to `close`) and an empty picker. A new "evidence required" gate must
   be human-path only.
3. **Statistics and tuner corruption.** Review grades in `feedback_stats` and Agent
   effectiveness (a population shift reads as "improving"); review-driven reopens inflating
   `_agent_reopen_summary` (`agent_improvement.py:491-536`); `PROVENANCE_COUNT_KEYS`
   (`stores/proposals.py:104`) invalidating every pending tuning proposal's fingerprint;
   `PrecedentWindowConfig` fields forcing a billable re-embed; rubber-stamped FP reviews
   feeding precedent promotion; star averages deflated by 0.0; the Set disposition
   last-writer migration (G5); marker loss on rollback (G3).
4. **Storage limits on Elasticsearch KV documents.** The shared 1,000-field mapping (G4,
   UNVERIFIED live); date detection on top-level fields (wrap ids as `case:<id>`); every ES
   CAS reads the whole document (`es/client.py:309-369`), so keep content documents
   write-once; `EsKVStore.get` fails soft (use `get_strict`, so 503 rather than 404); base64
   indexed as `text`; `factory_purge_strict` deep-copies every KV value on both backends (an
   OOM path once images are stored, a prerequisite fix); SQL key 128 characters; nginx 1 MiB
   default; no global backend body cap (copy `_RunbookRoute`).
5. **Test churn.** About 80 Case Manager test files, many of them source-text (★ in
   casemanager-ui §9); exact navigation tests (tab order, "16th tab stop", heading count,
   `nav-titles.round14`); the console map and knowledge corpus regeneration; the audit
   category contract on both sides; the `RESOURCE_ACTIONS` ratchet
   (`test_round14_contracts.py:1136-1170`) if a resource is added; router counts in AGENTS.md
   and HANDOFF.md (`test_docs_round13_records.py:51-54,175-180`); "Round 15 is the newest" if
   a research folder is created; `test_audit_route_outcomes.py` positional summaries;
   `test:strict` fails on any stderr byte.
6. **Ground-truth destruction and duplicate cases from reinvestigation** (G2, C3).
7. **Audit filter regression** (G1).
8. **RBAC switch hazards.** Turning it on can lock people out (the env admin is not
   counted by `count_active_super_admins`, `stores/users.py:318-324`); turning it off is a
   privilege escalation of every account; the PUT settings bypass; stale Console grants
   until `auth.refresh()`; cancelled jobs; Remember-me changes (G13).
9. **Privacy of the team page with RBAC off**, and people-analytics incentives (G9, headline 8).
10. **Image-upload security.** SVG and polyglots, decompression bombs (dimension caps from
    headers), no Pillow, multipart advisories on the pinned stack (avoid multipart; JSON
    base64). The server does not decode pixels, so a browser-decoder exploit is mitigated
    only by allowlist, structure validation, authentication and audit. State that limitation.
11. **Concurrency.** Case saves are last-writer with no CAS (`stores/cases.py:105-131`). Keep
    attachments and review state off the Case document; re-fetch before any detached case
    write (the notifier pattern); the sampler ledger is a hot spot (G16).
12. **Exactness of activity counts.** Lifecycle and collab audit rows are best-effort after
    the save (`routes.py:7341-7357`); older assignment and tag rows carry actor `"analyst"`
    (attribution bug, `routes.py:7623,7653,7697`) and cannot be re-attributed; `actor_role`
    is missing on old rows; the SQL `search_page` re-counts on every page (O(N²/1000) fold).
13. **Demo Mode coverage.** Every new store needs a Demo instance or an explicit 409. The team
    page, the review queue and attachments each need Demo seeds, or the evidence screenshots
    show empty states.
14. **Scope and time.** Six asks; the Case Manager redesign alone touches a 2,689-line page, a
    2,468-line orchestrator and about 30 panel files. Sequence the shared-file work
    (`models.py`, `routes.py`, `config.py`, `CaseDetail.tsx`) and do not run it in parallel.

---

## 5. What I verified and what remains open

Verified in the tree this session: C1 (`bundle-first-paint.test.ts:245-266`,
`settings-sections-meta.ts:66-68`); C2 (`routes.py:7284`); C3 (`pipeline.py:816-824`,
`signatures.py:33-57`, `routes.py:7853-7912`, the reinvestigate tests); the `_assemble_case`
carry list (`pipeline.py:1555-1678`); `FeedbackEntry` has no `model_config`
(`models.py:456-471`); the event-family predicate (`query.py:318-326`) and Event menu
(`events.ts:333-355`); `case_activity` and `case_tasks` single-document shapes and the
`case_thread` opaque-row precedent; `EsKVStore.put` writes raw values; the config index is
created `{"dynamic": true}`; Preferences live in the config index (`stores/config_store.py:29-52`);
default Preferences ≈ 514 dynamic fields (computed); `feedback_stats` star averaging
(`metrics.py:122-165`) and `FeedbackBody` defaults (`routes.py:7511-7519`); the lifecycle
audit row is best-effort with no via or batch (`routes.py:7338-7357`); jobs re-check live
grants (`engine/jobs.py:518-616`); session limits are live (`auth/session_limits.py:235-257`);
no RBAC switch in `webui/src`; the InvestigationPanel fallback (`:157-158`); the frozen base
covers only the Compose file; one production `CaseManager.apply` site; Chrome is installed.

Open (cannot verify in this sandbox): the live ES config-index field count and whether real
deployments already hit `index.mapping.total_fields.limit`; real nginx 413 behaviour behind
the Console; headless-Chrome rendering of the demo for the evidence pass.
