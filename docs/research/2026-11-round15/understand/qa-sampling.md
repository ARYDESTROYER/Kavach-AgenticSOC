# Round 15 map: auto-close review sampling ("send some auto-closed cases to an analyst")

Reader: QA sampling. Read-only map of everything a "randomly send a share of automatically
closed cases to an analyst for manual review and collect their feedback" feature must
integrate with. All paths are relative to `/home/user/Kavach-AgenticSOC`. Branch
`claude/round15` at `b49780c` ("Journal: Round 15 start"), working tree clean.

Working name used below: **auto-close review** (a sample, a review, a reviewer). Avoid
the word "playbook" (AGENTS.md naming contract) and do not mint `tlsoc_*` identifiers.

---

## 0. The ten facts that decide the design

1. `decide()` is the only producer of an agent close, it has exactly one production call
   site (`agents/pipeline.py:1161`), and it is pinned by source-text tests. A sampler must
   run AFTER `apply()` + `save()` like the existing post-decision hooks, and never import
   `case_manager`.
2. There is **no pending-close state**. An auto-close sets `status=closed` immediately; the
   objection window is only a timestamp (`Case.objection_window_expires_at`). Nothing acts
   when it expires. "Objecting" today means the generic `reopen` action (`cases:close`).
3. **`analyst_confirmed_outcome` already accepts a `FeedbackEntry.actual_outcome` as
   independent ground truth regardless of `decision_by`** (`engine/analyst_outcomes.py:143-156`).
   So a review recorded through the existing feedback channel becomes ground truth for the
   threshold tuner, the precedent corpus (analyst-confirmed tier) and `ground_truth_supply`
   with zero new plumbing. That is mostly the point (see §c), but it changes the label mix.
4. **Every analyst lifecycle action stamps `decision_by = ANALYST`** (`api/routes.py:7284`),
   including `acknowledge` and a same-status move. If a review were implemented as a case
   action, every auto-closed case reviewed would silently migrate from "auto-closed" to
   "human-closed" in the legacy metrics, the noise funnel and the futility tally. The review
   write must not touch `status`, `decision_by` or `disposition` unless the reviewer
   explicitly reopens.
5. The Effectiveness page's agreement and correction rates (`engine/agent_improvement.py`)
   use the latest grade per case with a (source, severity) mix adjustment only. Adding a
   stream of grades on easy, high-confidence auto-closes shifts the graded population and
   would make the headline read "improving" when nothing improved. Review-origin grades
   need their own stratum or exclusion there and in `feedback_stats`.
6. No assignment rules exist (manual `/cases/{id}/assign` only), and the inbox
   `assignment` category exists with **no producer** (`constants.py:681`,
   `webui/src/soc/pages/Inbox.api.ts:161`). The review feature would be its first producer.
7. Analyst tier 1 holds `cases:write` but not `cases:close` (`rbac/policy.py:466-479`): it can
   record a review (feedback is `cases:write`) but cannot reopen. RBAC is OFF by default
   (`config.py:3411`), so out of the box every signed-in account can do everything.
8. Case saves are last-writer-wins with no CAS (`stores/cases.py:105`). Queue state (who is
   asked to review what, quota counters) belongs in a strict-CAS KV document, not on the
   Case.
9. Config: a new `Preferences` block gets its field defaults on old stored documents with
   no migration. Never bump `CURRENT_AUTOPILOT_CONFIG_VERSION` (it re-runs the whole
   Round 10 autopilot migration). Use a per-block stamp (the `chat_limits_version`
   pattern) and register it in `MIGRATION_STAMP_KEYS`.
10. Entry bundle headroom is about 77 B (AGENTS.md Round 14 baseline: 337,163 B against a
    337,240 B budget). `registry.tsx` (nav) and `settings-sections-meta.ts` (command palette)
    are both in the entry chunk, so even one new nav row or Settings section meta costs
    entry bytes. The review UI itself must be lazy.

---

## (a) Where auto-close happens

### a.1 `decide()` (must stay byte-identical)

`backend/app/engine/case_manager.py:59-67`, verbatim:

```python
def decide(
    verdict: Verdict | None,
    confidence: float,
    risk_score: float,
    policy: AutoClosePolicy,
    *,
    escalation_confidence: float = 0.6,
    critical_severity: float = 7.0,
) -> Decision:
    """Pure, deterministic, side-effect-free decision over the auto-close policy."""
```

- `Decision` dataclass `case_manager.py:42-48`: `status`, `decision_by`,
  `objection_window_expires_at: str | None`, `escalate`, `rationale`.
- `_entry_for` `case_manager.py:51-56`: only `FALSE_POSITIVE` and `TRUE_POSITIVE` map to a
  policy entry; `NEEDS_HUMAN`/`None` return `None` (never closable, whatever
  `policy.needs_human.enabled` says).
- Close branch `case_manager.py:78-94`: `confidence >= entry.min_confidence and
  risk_score <= entry.max_risk_score` → `CaseStatus.CLOSED`, `DecisionBy.AGENT`,
  `objection_window_expires_at = now + objection_window_minutes`. Rationale text, which the
  chat display regex parses (`agents/chat_tools/common.py:1174`,
  `webui/src/soc/chat/display.ts:346`): `"{VERDICT} auto-closed: confidence {c:.2f} >=
  {min} and risk {r:.1f} <= {max}; objection window {m}m."`
- `CaseManager.apply` `case_manager.py:131-190`: runs `decide`, asserts the NEEDS_HUMAN
  invariant (`:143-144`), sets `status`, `decision_by`, `objection_window_expires_at`,
  maps escalate to `ESCALATED` in the non-close branch (`:158-161`), fills `disposition`
  from the verdict only when unset (`:165-168`), appends a `StatusHistoryEntry(by=
  decision_by)` when the status moved (`:171-180`) and ALWAYS appends
  `{"ts","event":"decision","status","decision_by","escalate","rationale"}` to
  `case.history` (`:182-189`). That `decision` history event is the durable,
  non-erasable record that "the agent closed this" (see a.4).

Pinning tests (a change to `case_manager.py` breaks them):
- `backend/tests/test_wave6_decide_guard.py:27-48` (source snapshot: required substrings,
  `"automation" not in src`), `:55-78` (decide is the only producer of CLOSED).
- `backend/tests/test_case_manager.py:134-156` (truth table).
- `backend/tests/test_round3_wave0_foundations.py:113-127` (advisory Case field names must
  not appear in `case_manager.py`). A new review field name should be added to an
  equivalent guard.
- `backend/tests/test_p1_severity_ladder_contract.py:760-783` (banned imports/symbols in
  `case_manager.py`).

### a.2 The policy

`backend/app/config.py:711-747`:
- `VerdictAutoClose`: `enabled=False`, `min_confidence=0.9 (0..1)`, `max_risk_score=20.0
  (0..100)`, `objection_window_minutes=1440 (ge=0)` ("reopen window before true close").
- `AutoClosePolicy` defaults: `false_positive` enabled, 0.85, 30.0, **1440 min**;
  `true_positive` disabled, 0.95, 10.0, **4320 min**; `needs_human` disabled (ignored).
- `Preferences.auto_close` at `config.py:4237`; also `escalation_confidence=0.6`,
  `critical_severity=7.0`. Legacy `fp_auto_close` migrated by `_migrate_fp_auto_close`.
- Settings editor: `webui/src/soc/pages/settings/detection.tsx:299-397` (per-class group,
  copy "How long before an auto-close takes effect, so a person can object."; note that
  copy over-promises: the close takes effect immediately, see a.3).

### a.3 The objection window: there is no pending-close state

- Only writers: `case_manager.py:81-86,150`. No sweeper, scheduler or expiry handler reads
  it to act (grep of `objection_window` in `backend/app`: case_manager, runbook_runs,
  routes_triage display, replay scoring exclusion, chat tool display, ES mapping
  `es/indices.py:70`).
- The case is terminal at once: `engine/runbook_catalog.py:1352-1359` `human_handled`:
  "automatic closes are terminal at once, even inside their objection window".
- `engine/runbook_runs.py:1089-1103` `attachment_blocked` returns `"pending_auto_close"`
  for an agent close whose window is still open, so no runbook attaches; copy at
  `runbook_runs.py:187` "The case is closing automatically (its objection window is open)."
- Objecting = the generic `reopen` case action (`api/routes.py:6952`, grant `cases:close`
  via `_CLOSE_ACTIONS` `:6969`). There is no objection endpoint and no record that a reopen
  was an objection.
- UI: `webui/src/soc/components/badges.tsx:646-685` ("· reopen before {time}"),
  `webui/src/soc/pages/casedetail/FactsRail.tsx:219-270` ("Reopen before " / "Objection
  window open until "), `casedetail/DecisionCard.tsx:134-296`,
  `casedetail/OverviewPanel.tsx:1522-1525`, `components/TraceTimeline.tsx:236-238`.
- Consequence for the design: the default FP window is 24 h. A review requested at
  decision time lands inside the window; a daily batch sampler over yesterday's closes
  usually lands after it. Neither matters mechanically (reopen works any time), but the
  "reopen before" copy only makes sense inside it.

### a.4 Where the decision is applied and saved (`agents/pipeline.py`)

`_investigate_cluster_run` (`pipeline.py:807-1259`):
1. `find_open_case_for_cluster` (`:822`, `engine/signatures.py:33-57`): finds only OPEN
   cases by signature. A closed case is never re-entered; a new alert opens a fresh case.
2. Analyst policy gate (`:831-836`, see a.5).
3. P1 verdict-stability gate (`:843-869`): an investigated open case with no new member
   events and no `force` is returned unchanged with a `pipeline` DECISION audit row.
4. Investigation, then `case = self._assemble_case(...)` (`:1122-1140`).
5. **`CaseManager(prefs).apply(case)` then `await self._cases.save(case)` (`:1161-1162`).**
6. DECISION audit row, actor `case_manager` (`:1174-1185`): `result_summary` is
   `verdict=… status=… decision_by=… risk=… cost=… confidence=… auto_close_gate=…`, with
   `classify_auto_close_gate` (`engine/metrics.py:2180`). This string is append-only and
   read positionally; new tokens may only be appended.
7. Terminal `decision` live frame (`:1190-1196`).
8. Post-decision hooks, in order: `_maybe_attach_runbook` (`:1201`), `_maybe_automate`
   (`:1206`), `_maybe_index_resolved` (`:1210`, RAG for terminal cases), `_maybe_notify`
   (`:1214`, detached task with fetch-fresh merge, `:504-526`). Each is error-isolated.
   **This is where a sampler belongs** (after `_maybe_automate`, before or beside
   `_maybe_notify`), injected like `notifier`/`automation`/`runbook_attacher` (ctor kwargs
   at `:267-289`, post-settable).
9. Failure path (`:1216-1259`) fails to a human; never closes.

Durable "the agent closed it" predicate: `engine/metrics.py:2128-2178`
`decision_records(case)` / `decision_record(case, anchor=DECISION_ANCHOR_FIRST)` read the
`{"event":"decision"}` history entries; the FIRST record keeps its original `status` and
`decision_by` whatever later analyst moves do. A sampler (or a backfill/batch sampler)
should select on that, not on mutable `case.decision_by`.

All `decide()` call sites (grep): production `pipeline.py:1161` only; read-only
explanation in `agents/chat_tools/cases.py:1848`; offline replay scoring
`engine/replay/scoring.py:22`. Demo seeds write agent-closed cases directly
(`engine/demo_generator.py:1300-1350`).

### a.5 Analyst-policy ("declared benign") closes

`pipeline.py:1261-1458` `_close_by_analyst_policy`:
- Runs BEFORE any model call; `verdict=None`, `confidence=0.0`, `status=CLOSED`,
  `disposition=FALSE_POSITIVE`, `decision_by=DecisionBy.ANALYST_POLICY`,
  `analyst_policy=match.as_dict()`.
- History event `{"event":"analyst_policy","action":"close_false_positive",...}`
  (`:1371-1380`), deliberately NOT `analyst_action` ("that is what
  `analyst_confirmed_outcome` reads as independent ground truth").
- Status history `by="analyst_policy"`; audit actor `analyst_policy` (`:1449-1457`).
- **This path returns at `:1458` without the runbook/automation/RAG/notify hooks**, so a
  sampler covering policy closes needs its own call there.
- `DecisionBy.ANALYST_POLICY` docstring (`constants.py:501-515`): not agent, not analyst,
  not system. Single predicate `engine/precedent.py:715-735` `is_policy_closed` (reads the
  durable `analyst_policy` payload too because `decision_by` is erasable).
- A grade on a policy-closed case IS ground truth for the tuner and precedent
  (`threshold_tuner.py:331-341`, `metrics.feedback_stats` docstring `metrics.py:125-129`)
  but is excluded from every agent-agreement view. Reviewing policy closes is useful
  (validates a declaration) but is a separate stratum from agent auto-closes.

### a.6 Demo runtime

- `engine/demo_runtime.py:196-204` `sandbox_policy(base)` = deep copy of the real policy;
  the Demo pipeline calls the same untouched `decide()` through its own `DemoStack`.
- `AppState` swaps every case-adjacent store while Demo Mode is on (`state.py:649-715`:
  `cases`, `audit`, `proposals`, `inbox`, `case_tasks`, `tuning_store`, …). Pattern for a
  new KV store with a Demo split: `state.py:533-560` `runbook_runs` (Demo gets a store over
  `demo.kv`, gone when Demo ends).
- Demo seeds synthetic analyst feedback on agent-closed cases so the tuner has
  independent labels (`demo_generator.py:1330-1343`, `analyst="demo.analyst"`). A Demo
  should seed a few sampled-for-review cases so the feature is visible.
- Human case actions in Demo hit the demo store; lifecycle notifications are skipped in
  Demo (`routes.py:7430`).

---

## (b) Existing review / approval queues

### b.1 Approvals page and the proposals store (not a fit for case review)

- Model `models.py:545-600` `Proposal`: `kind: Literal["suppression","memory","tuning",
  "automation_ack"]`, `status: pending|applying|approved|rejected|expired`, `expires_at`,
  `evidence_fingerprint`.
- Store `stores/proposals.py:1-60`: ONE KV list (`ns="proposals"`, `key="entries"`),
  strict CAS for approve/reject, bulk limit 200, `sweep_expired`.
- Routes `api/routes.py:2403-2848`: `GET /api/proposals` (`proposals:read`),
  `POST /api/proposals/{id}/approve|reject`, `/proposals/bulk-reject` (`proposals:approve`).
- Nav: `webui/src/soc/registry.tsx:331-337` "Approvals", perm `proposals:read`.
- Proposals are configuration changes; approving one is the single write path to config.
  A case review is case work. Reusing `Proposal` would put case-work into the
  config-approval queue and its audit category; a separate queue is cleaner. The one useful
  reuse: a review disagreement rate could draft an `automation_ack` proposal ("consider
  raising the FP auto-close confidence bar"), never an applied change.

### b.2 Inbox fan-out

- `InAppNotification` `models.py:1440-1467` (`category`, `title`, `body`, `case_id`, `url`,
  `state`, `ref`, job fields). Categories `constants.py:676-684`: `case_new`,
  `case_escalated`, `case_resolved`, `mention`, `assignment`, `approval`, `system`,
  `digest`. Webui ordering/copy `webui/src/soc/pages/Inbox.api.ts:146-167`
  (`assignment: "A case was assigned to you."`). **No backend producer of `assignment`
  exists today** (grep).
- Store `stores/inbox.py`: ONE KV document for all users, bounded ring of 200 per user
  (`_MAX_PER_USER`), `append`, `fanout(recipients, build)` (`:187`), never raises.
- Direct fan-out pattern to copy: `api/routes_cases_collab.py:224-283` `_fanout_mentions`
  (build per recipient, audit one `INAPP_NOTIFY` row per delivery with
  `actor_type="system"`, publish `notifications`/`inapp` SSE with `audience=[…]`).
- Trigger-based in-app routing: `notifications/inapp.py:58-73` `_TRIGGER_CATEGORY`;
  `notifications/dispatch.py:324-380` `_resolve_inapp_recipients` (assignee + mentions
  always, role members per `NotificationPref`).

### b.3 Assignment rules

- None. `POST /api/cases/{id}/assign` (`routes.py:7666`, grant `cases:assign`) and the
  action `assignee` field (`routes.py:7290-7298`, history `assignee` key) are manual.
  `threshold_automation` actions are only `tag`, `recommend`, `notify`, `run_playbook`
  (attach a runbook), `request_approval` (`engine/threshold_automation.py:1-30`); none
  assigns.
- Audience resolution precedent: `engine/batch_inbox.py:51-114`
  `eligible_batch_audience` (strict read of `USERS_NS` + custom roles, `can_for_roles(...,
  "models","read")`, `not rbac.enabled` → everyone, env admin included, sorted). A reviewer
  pool ("users who can `cases:write`") would follow it, capped like
  `MAX_BATCH_INBOX_AUDIENCE = 200`.

### b.4 Notification dispatch triggers

- `notifications/dispatch.py:41-47`: `case_created`, `escalated`, `true_positive`,
  `needs_human`, `closed`, `manual`, `test`. `_triggers_for_case` `:167-192` maps the saved
  case; an auto-close fires `closed` when `on_closed` is set.
- Human lifecycle actions notify `escalated`/`closed` (`routes.py:7419-7436`).
- A review request could use a new trigger (for example `review_requested`) mapped to the
  `assignment` category, and a disagreement could fire `escalated`-style routing to
  managers. New trigger ids need `notifications/templates.py` labels and webui template
  copy.

### b.5 The feedback channel a review should reuse

- `POST /api/cases/{case_id}/feedback` `routes.py:7543-7590`, grant `cases:write`
  (inline `_enforce`). Analyst = verified principal. Appends `FeedbackEntry`, bumps
  `updated_at`, saves, then audits `ActionType.FEEDBACK` best-effort
  (`result_summary="assessment=… outcome=… accuracy=…"`), then refreshes RAG for terminal
  cases. It never touches `status`, `decision_by` or `disposition`.
- `FeedbackBody` `routes.py:7511-7519` and `FeedbackEntry` `models.py:456-471`: `ts`,
  `analyst`, `assessment` (agree|partial|disagree), `accuracy`, `reasoning_quality`,
  `action_appropriateness`, `actual_outcome` (`FeedbackOutcome`,
  `constants.py:477-490`: true_positive, false_positive, true_negative, false_negative,
  unknown), `time_saved_minutes`, `comment`, `ai_verdict`, `ai_confidence`. No origin
  field today.
- `GET /api/feedback/stats` `routes.py:3261-3269` (`metrics:view`).
- Console: grading is folded into the close dialog (`webui/src/soc/pages/CaseDetail.tsx:
  1242-1300`), library `webui/src/soc/pages/casedetail/grading.tsx` (`OutcomeField`,
  `GradingFields`, `deriveAgreement`, `gradingToFeedbackInput`, `GradingHistory`). The
  agree/override assessment is DERIVED from outcome vs verdict at submit time, which is
  the right shape for a review form too (ask "what actually happened", derive agreement).
- `caseOutcome` (`webui/src/soc/components/outcome.ts:231-318`) shows an agent close as
  "Auto-closed as false positive" and ignores feedback; a reviewed auto-close needs a new
  line (and `outcome.test` updates).

### b.6 Case Manager hooks

- "Closed by" filter: `webui/src/soc/pages/CaseManager.tsx:627-661` (`CLOSED_BY_LABEL.agent
  = 'Closed by the AI agent'`); server `closed_by` query on `/api/cases`
  (`routes.py:6295-6307,6595-6685`). `#/scans` redirects here (`registry.tsx:320-330`).
  A "Sampled for review" queue/filter would sit beside it; the server would need a
  review-state filter backed by the review KV store (a case-id set), not a Case field scan.

---

## (c) Statistics a review verdict feeds or must not distort

| Consumer (file:line) | What it reads | Effect of a review written as `FeedbackEntry(actual_outcome=…)` | Effect of a reviewer reopen | Recommendation |
|---|---|---|---|---|
| `analyst_outcomes._confirmation` `engine/analyst_outcomes.py:135-175`; `analyst_confirmed_outcome` `:178-192` | latest feedback with a binary `actual_outcome` wins, any `decision_by`; else explicit classification only when `decision_by == analyst` | becomes ground truth (FP or TP) | none on the label | Intended. This is the independent signal. `unknown` stays no-label (`GROUND_TRUTH_FEEDBACK_OUTCOMES` `:17-22`). |
| `ground_truth_supply` `analyst_outcomes.py:204-290` | qualifying = confirmed AND terminal; feedback-without-label share | qualifying precedents rise, days-since falls | reopened case is not terminal → leaves supply | Intended; the feature directly fixes the supply gap. |
| RAG precedent projection `tools/rag.py:2829-2880` `_resolved_case_item`; tiers `rag.py:245-258` | `analyst_confirmed_outcome`; writes `trust_class="analyst_confirmed"`, `outcome`, `rule_identity`, `ground_truth_source` | auto-closed case moves from the optional `model_unconfirmed` tier to `analyst_confirmed`; note text enters precedent (fenced, #9) | not terminal → not projected | Intended, but feedback loop risk: confirmed FP precedent → promotion (`PrecedentPromotionConfig`, default OFF, `config.py:2794-2818`) → more FP verdicts. A TP review makes the rule "conflicting" (never promoted, `max_conflicting=0`), which is the safety valve. Rubber-stamping is the main risk (see §d). |
| Precedent window `config.py:2821-2886`; admission key `rag.py:3225-3262` | stratify by `rule_identity`, `outcome`, `verdict`; cap per transaction (batch id, else 1 h time bucket of the confirming feedback) | reviews made in the same hour share one admission bucket (`max_transaction_fraction=0.5`) |, | Fine. Do NOT add fields to `PrecedentWindowConfig`: they change the corpus source signature and force a billable re-embed (`rag.py:229-235`, pinned in `tests/test_precedent_authority.py`). |
| Precedent distribution / promotion `engine/precedent.py:201-241,326-470` | analyst-confirmed chunks only | counts rise for sampled rules |, | Intended. |
| Threshold tuner `engine/threshold_tuner.py:317-380` `_accumulate_rule_stats`; rails `:1-50` | per rule: `observed` terminal cases; `total/fp/tp` only from independent labels; `feedback_labels` vs `disposition_labels`; `bulk_ratified` visibility only | QA labels enter `total`/`fp`/`tp` as `analyst_feedback`. Auto-closed cases are mostly FP, so per-rule FP rate rises → more tuning proposals (raise n / severity floor). Shadow-eval (`threshold_tuner.py` rail 5) blocks a change that would hide a confirmed TP, and a TP found by review is exactly such a TP. | reopened case leaves the terminal window until re-closed | Reviews make the label set MORE representative (today labels come almost only from human-routed cases), but unweighted. Report review-origin labels beside `feedback_labels` for visibility. **Do not add a key to `PROVENANCE_COUNT_KEYS` (`stores/proposals.py:104`)**: `evidence_fingerprint` (`:160-181`) hashes every key, so every pending tuning proposal would fail verification and be refused. Add visibility outside the fingerprint. |
| `feedback_stats` `engine/metrics.py:122-165` (Metrics feedback part, `/api/feedback/stats`) | all feedback except policy closes; `agreement_rate` over agree/partial/disagree only | review grades flood agreement with easy auto-closes |, | Split by origin (`by_origin`) or exclude review-origin from the headline; keep counts. |
| Agent effectiveness `engine/agent_improvement.py:134-184` `_select_feedback`, `:201-245` `_quality_summary`, `:285-404` mix strata (source, severity) | latest valid grade per case; agreement, material corrections, false-negative rate (AI said FP, outcome TP) | population shift from human-routed to auto-closed cases moves agreement/correction with no agent change; the mix adjustment has no decision-path axis | `_agent_reopen_summary` `:491-536`: a human reopen within 24 h of an agent terminal decision counts; review-driven reopens inflate it vs a pre-review baseline | Add a decision-path stratum (auto-closed vs routed) or exclude review-origin grades from the period comparison and report the review as its own module. Tag review-driven reopens (history key) so they can be split. |
| `quality_metrics` `engine/metrics.py:670-773` | `false_positive_rate` = AI FP verdicts / verdicted (verdict only); `analyst_confirmed_fp` (count); auto/human/system partition by mutable `decision_by` (caveat `:695-708`) | FP rate unaffected; `analyst_confirmed_fp` rises (label it) | reopen moves the case from auto to human partition (last-writer) | Fine if the review write never stamps `decision_by`. |
| `auto_close_health` (legacy) `metrics.py:1765-` and `recorded_auto_close_health` `metrics.py:2833-` | legacy: mutable `decision_by`, last decision; recorded: FIRST decision entry | none | legacy moves, recorded does not | Use the recorded series and `decision_record` for any review analytics. |
| Noise funnel `engine/noise_counters.py:215-243` | `_is_auto_cleared` = terminal + `decision_by == AGENT` + verdict FP | none | reopen removes it from Auto-cleared | Fine. |
| Futility `precedent.py:738-851` `rule_outcome_tally` | mutable `decision_by` | none | reopen → analyst_closed | Fine. |
| Unconfirmed tier `config.py:1246-1297`, `RagConfig.use_unconfirmed_resolved_cases=False` `:1341` | agent's own closes, guarded | reviewed cases leave this tier for the confirmed one |, | The docstring states the problem the feature solves: "auto-close depends on precedent, precedent depends on analyst labels, and analyst labels only exist if somebody works a queue the product exists to keep empty." |
| P1 verdict-stability gate `pipeline.py:843-869` | new member event keys / `force` | none (feedback adds no events) | after reopen, new alerts for the signature re-attach to the reopened case | A review must never call `force`/re-investigate implicitly. |
| Replay harness `engine/replay/text.py:9-35`, `scoring.py:1-24` | arm vs arm on frozen fixtures; comparisons against logged history are inexpressible | none |, | Review labels must never become replay labels; no change. |

### c.1 How a review verdict should be recorded so it is a genuine, independent signal

1. **Write it through the existing feedback channel** as one `FeedbackEntry` (same
   validation, same `cases:write` grant, verified principal as `analyst`, snapshot
   `ai_verdict`/`ai_confidence`), with `actual_outcome` required to be one of
   true_positive / false_positive / unknown (unknown = "could not tell", recorded but no
   label). Derive `assessment` from outcome vs verdict (as `grading.tsx` does) rather
   than asking "do you agree", which anchors the reviewer on the model.
2. **Mark its origin additively** on the entry (new optional fields, for example
   `origin="auto_close_review"` and `review_id`), defaulting empty so every stored entry
   and every existing consumer reads unchanged. The marker is what lets each consumer in
   the table above choose include / stratify / exclude. ES maps `feedback` dynamically
   (`es/indices.py:40-84` declares no `feedback` mapping); SQL stores the Case as a JSON
   doc (`stores/sql/repositories.py:229-248`). Keep `webui/src/lib/types.ts` and
   `api-types.gen.ts` in sync (`check:types`).
3. **Never use the `analyst_action` history shape** and never stamp `decision_by`,
   `status` or `disposition` in the review write. A separate history event (for example
   `{"event":"auto_close_review", …}`) is safe: `history` is `enabled: False` in ES
   (`es/indices.py:76`) and only `analyst_action` entries are classification evidence
   (`analyst_outcomes.py:81-100`).
4. Keep the per-case review STATE (requested, by whom, due, completed, skipped, expired)
   in a strict-CAS KV document, not on the Case (case saves are last-writer, and the
   pipeline re-saves cases).
5. Excluded from the agent-quality views by default (or stratified): `feedback_stats`,
   `agent_improvement` comparisons. Included as ground truth: tuner, precedent,
   `ground_truth_supply`. A review of a policy-closed case stays out of agent agreement
   exactly as today (`agent_improvement.py:145-151`).
6. Independence caveat to document: a reviewer who only clicks "confirm" is not
   independent evidence. Mitigations that need no new dependency: require an outcome
   (not just agree), record time-to-review, show per-reviewer agreement and median review
   time on the admin work tracker, and allow a manager to see reviews that took seconds.

### c.2 Where agreement / disagreement rates could be shown

- Agent effectiveness page (`webui/src/soc/pages/AgentEffectiveness.tsx`, backend
  `GET /api/metrics/agent-improvement` `api/routes_metrics.py:799`): a new "Auto-close
  review" module: sampled, reviewed, pending, expired; agreement with Wilson interval
  (helper `_wilson` `agent_improvement.py:186-198`); missed threats (reviewer said TP on an
  auto-closed FP); by rule; insufficient-evidence states (minimum like `_QUALITY_MIN=30`).
  Never a composite score.
- Overview Agent health diagnostics (degradation only): "auto-close review found N
  threats" as a degradation.
- Settings → Detection next to the FP/TP auto-close bars: read-only calibration line
  ("last 30 days: 48 of 50 reviewed auto-closes confirmed").
- Case Manager: a "Sampled for review" queue or chip, and the reviewed/disagreed state in
  the facts rail and `caseOutcome`.
- The new admin work tracker (ask 4): reviews completed per analyst per day.
- Auto-tuning page: tuner provenance line for review-origin labels.
- Weighting: a daily cap makes inclusion probability vary by day. Record per day
  `eligible` and `sampled` so an estimate can be weighted (sampled/eligible) or at least
  disclosed. Rates over the sample describe auto-close precision for the sampled
  population only.

---

## (d) Determinism, audit, bounds, RBAC, disagreement

### d.1 Selection

- Recommended: deterministic score `sha256("auto-close-review:v1:" + case_id)` → first 8
  bytes / 2^64; selected when `score < rate` and the day's quota and per-rule quota are not
  used up. `case_id` is server-minted (`new_id("case-")`), not attacker-controllable, so
  the selection is reproducible and cannot be steered by crafted alerts. Cluster
  signatures and entity values ARE attacker-influenced, so never hash those.
- Quota ordering depends on arrival order; make it auditable by writing one row per
  selection (and optionally per quota skip) with the score, rate, quota used and the day.
- Per-rule cap per day (rule identity from `engine/precedent.py:91-118`
  `case_rule_identity`) stops one noisy rule consuming the quota; or a daily batch sampler
  that ranks the previous day's FIRST-decision agent closes by score and round-robins by
  rule with `precedent.stratified_selection` (`precedent.py:590-655`). The batch form is
  fully reproducible from durable data but lands after the 24 h window and needs a
  scheduler (see e.4); the inline form lands inside the window and needs only the
  post-decision hook.
- Once per case: a reopened, re-investigated and re-closed case must not be sampled twice
  (key the ledger by `case_id`).
- "Day" choice: UTC complete days are what `agent_improvement` uses; operator-facing
  "daily" elsewhere uses `SlaPolicy.timezone` (`config.py:1717`, `engine/time_windows.py`).
  State which.
- Strata: agent auto-close FP, agent auto-close TP (opt-in class), analyst-policy close
  (separate, optional).

### d.2 Audit (#2)

- `AuditLogger.record` (best-effort) and `record_strict` (raises; audit-first writers)
  `stores/base.py:775-840`; Round 14 fields `action`, `actor_type`, `target`, `changes`,
  `request_id`, `run_id`.
- Structured action tokens are categorised by `backend/app/audit/event_categories.json`
  (read by `audit/events.py` and, through a contract test, by
  `webui/src/soc/components/audit/events.ts`). Prefix `case` → Case work. New tokens (for
  example `case.review_requested`, `case.review_recorded`, `case.review_expired`) need
  entries there so they get labels. Scope partition: the sampler's row is system/agent
  (Agent activity); the reviewer's row is a person (People and settings).
- Existing writers save then audit (feedback `routes.py:7579-7586`, case action
  `:7340-7355`); Round 14 runbook writes are audit-first (`engine/runbook_runs.py:1036,
  1985`). New writers should follow the Round 14 audit-first rule.
- Append a DECISION-row token? No: the `case_manager` row's `result_summary` is
  positional and owned by the decision; a separate row for the sample is cleaner.

### d.3 RBAC (`backend/app/rbac/policy.py`)

- Resources `:51-100`: `cases: read, write, close, assign, comment, reinvestigate`;
  `metrics: view`; `settings: read, manage`; `automation: read, manage`; `proposals: read,
  approve`; `audit: view, export`.
- Defaults `:434-511`: soc_manager `cases:*`; analyst_tier2 `cases` read, write, close,
  assign, comment, reinvestigate; **analyst_tier1 and responder `cases` read, write,
  comment, assign (no close, no reinvestigate)**; auditor read only.
- Natural grants: record a review `cases:write` (same as feedback); reopen `cases:close`;
  reinvestigate `cases:reinvestigate`; assign/reassign reviews `cases:assign`; configure
  sampling `settings:manage` (as `case_policy`/`cases` sections) or `automation:manage`;
  view review stats `metrics:view`.
- A NEW action (for example `cases:review`) means: add to `RESOURCES`, every default role,
  and think through stored `rbac.roles` overrides, which REPLACE a role/resource action
  list (`policy.py:684-696`), so an operator override written before the change lacks it.
  Round 14 needed `RBAC_GRANTS_VERSION`, `ROUND14_ONLY_ACTIONS` and once-only legacy rules
  for exactly this (`policy.py:122-131,344-396`). Reusing `cases:write` avoids all of it.
- RBAC is off by default (`config.py:3403-3411`); `eligible_batch_audience` treats
  "RBAC off" as everyone (`batch_inbox.py:90-96`).

### d.4 When the reviewer disagrees

| Option | Mechanism today | Consequence |
|---|---|---|
| Record only (always) | feedback entry + review state + audit | ground truth for tuner/precedent; no case change |
| Reopen | `reopen` action, `cases:close` (`routes.py:6952,6969,7023-7048`) | stamps `decision_by=ANALYST`, status `open`, status-history `by=<user>`; legacy auto/human partition moves; runbook re-evaluation attaches a runbook (`routes.py:7374-7378`); future alerts for the signature join the reopened case (`signatures.py:40`); `agent_improvement` counts a human reopen within 24 h |
| Escalate | `escalate` needs a non-terminal case; from closed `_guard_transition` returns 400 "reopen the case first" (`routes.py:7036-7040`) | two steps: reopen then escalate |
| Reinvestigate | `POST /api/cases/{id}/reinvestigate`, `cases:reinvestigate`, `force=True` (`routes.py:7853-7912`) | re-runs `decide()` and LLM spend; because `find_open_case_for_cluster` only finds OPEN cases, reinvestigating a still-CLOSED case appears to mint a new case id instead of updating in place (verify before relying on it); reopen first |
| Notify managers | new trigger or direct inbox fan-out | tier 1 cannot reopen, so a disagreement from tier 1 must reach someone with `cases:close` |

Recommendation: record always; offer "Reopen" (and "Reopen and escalate") to holders of
`cases:close`; for others, route the disagreement to managers. Never reopen, escalate or
reinvestigate automatically from a review: those are human moves, and automatic
reinvestigation spends budget. Tag review-driven reopens in history (for example
`entry["via"]="auto_close_review"`) so effectiveness can split them.

### d.5 Storage (#12, KV only) and lifecycle

- `KVStore` API `stores/base.py:1116-1195`: `get`, `put`, `put_if(expected_rev)`, `mutate`
  (`kv_mutate` with per-key lock + `_rev` CAS); `kv_mutate_strict` `:166`. No
  list-namespace primitive.
- Opaque-field rule for Elasticsearch KV docs: store one canonical-JSON string field, as
  `stores/chat_starters.py:1-45` does (`chat_starters_json`), so attacker- or user-named
  keys never become ES field names.
- Shape options: (1) ONE bounded document (`ns="auto_close_review"`, `key="ledger"`) with a
  ring of recent requests (for example ≤ 1,000) plus per-day counters for the last 90 days:
  trivially cleared by the cases-tier reset (`engine/reset.py:121-134` `_CASES_KV`, a
  `put(ns,key,{})`) and exported as one row; contention is low at tens per day.
  (2) One document per case: needs a namespace purge like runbook runs
  (`reset.py:461-500`, separate SQL and ES code) and a data-export catalog entry.
- Factory reset purges the KV wholesale; the data export manifest (Round 14 schema 2,
  `api/routes_export.py`) should list the new namespace.
- Demo split: build the store over `demo.kv` while Demo Mode is on (pattern
  `state.py:533-560`).

### d.6 Concurrency

- Case store has no CAS (`stores/cases.py:105`); the feedback endpoint is get/append/save.
  A detached sampler that writes onto the case must re-fetch first (the notifier pattern,
  `pipeline.py:516-519`, `dispatch.py:648-660`). Better: write nothing onto the case at
  sampling time (KV + inbox + audit only); the case changes only when the reviewer
  records feedback.

---

## (e) Config placement, defaults and migrations

### e.1 Where the block sits

- `Preferences` (`config.py:3865-4420`). Neighbours: `auto_close` (`:4237`),
  `analyst_rule_policies` (`:4275`), `threshold_automation`, `threshold_tuning`
  (`:4379`, class `:2540-2590`, `auto_apply_confirmed=False`), `precedent`, `rag`,
  `notifications`, `sla`.
- Settings sections (`webui/src/soc/pages/settings/settings-sections-meta.ts`):
  `detection` owns `auto_close` (`:262-285`), `case_policy` owns
  `sla, priority_matrix, suppression_rules, analyst_rule_policies` (`:329-354`,
  `settings:manage`), `automation` owns `threshold_automation` (`:356-367`,
  `settings:manage`), `knowledge` owns `rag, threat_context, precedent`.
  Natural homes: the Detection section beside the auto-close bars (calibration), or a new
  section. A new section id breaks `settings/__tests__/settings-sections.test.ts`
  (`EXPECTED_IDS` `:43-67`, group order `:113-150`, `SECTION_KEYS` `:187-224`), needs a
  console-map regeneration (`npm run gen:console-map`, `scripts/build_app_knowledge.py
  --check`), and adds entry bytes (the meta module is in the entry chunk,
  `settings-sections-meta.ts:62-70`).
- If the block gets a curated editor, add its key to `CURATED_SECTIONS`
  (`settings/advanced-schema.tsx:55-87`) so it is not also editable in Advanced.

### e.2 Defaults (#10)

- A new block gets its field defaults on every stored document that lacks it (pydantic
  default), so "ON by default" applies to existing installs silently unless a stamp and
  banner are added. The feature creates human work (inbox items), so the SPEC should
  decide explicitly: default ON at a small rate with a hard daily cap (in the spirit of
  #10 smart defaults, $0, `decide()`-safe) or default OFF.
- Bounds must repair on load and reject on write: `_clamp_caps` (`config.py:3868-3931`)
  and `routes._reject_out_of_range_caps` show the pattern. A validation error on load
  makes BOTH config loaders return a full default `Preferences()` (docstring
  `config.py:3871-3881`), which would reset `auto_close` itself.

### e.3 Version markers

- `CURRENT_AUTOPILOT_CONFIG_VERSION = 1` (`config.py:3855`), migration
  `_migrate_autopilot` (`:3936-4020`), fires only for full persisted dumps
  (`_PERSISTED_CONFIG_MARKERS` `:3862`). **Do not bump**: it re-applies `_merge_enabled`
  to tuner, campaign, cross-source, SLA, priority matrix, realtime, automation and
  baseline, overriding opt-outs saved after v1.
- Per-block stamp pattern: `ChatAgentConfig.chat_limits_version`
  (`CURRENT_CHAT_LIMITS_VERSION = 2`, `config.py:1770-1925`, staged steps
  `_CHAT_LIMITS_STEPS`), `runbooks.runbooks_config_version`, `rbac.rbac_grants_version`.
- Every stamp must be listed in `backend/app/preferences_roundtrip.py:65-73`
  `MIGRATION_STAMP_KEYS` so a rollback keeps a newer build's stamp; unknown keys are
  carried on save (`preferences_roundtrip.py:1-33`).

### e.4 If a scheduler is added

- Loops start in `state.py:2306-2324` `_run_schedulers`; health map `state.py:158-170`
  (`threshold_tuner`, `campaign_correlation`, `baseline_producer`, `batch_jobs`) and
  `scheduler_health` `state.py:2450-2500`; route `GET /api/schedulers/health`
  (`automation:read`, `api/routes_schedulers.py:16-27`). An inline (decision-time) sampler
  can report like `baseline_producer` (`cadence: "on_ingest"`-style, for example
  `"on_decision"`). Gates: `_schedulers_gated_off()` and Demo.

---

## Tests that pin behaviour a change here touches

Backend:
- `tests/test_wave6_decide_guard.py`, `tests/test_case_manager.py`,
  `tests/test_round3_wave0_foundations.py`, `tests/test_p1_severity_ladder_contract.py`
  (decide/apply/case_manager source guards).
- `tests/test_analyst_classification_wins.py`, `tests/test_g1_ground_truth_intake.py`
  (ground-truth rules), `tests/test_precedent_authority.py` (window signature literal),
  `tests/test_precedent_corpus.py`, `tests/test_precedent_corpus_repair.py`,
  `tests/test_precedent_observability.py`, `tests/test_unconfirmed_precedent_tier.py`.
- `tests/test_round4_wave3_tuner.py`, `tests/test_proposal_lifecycle.py` (fingerprint).
- `tests/test_agent_improvement.py`, `tests/test_recorded_auto_close.py`,
  `tests/test_round3_wave2_metrics.py`, `tests/test_vigil_wave3.py` (feedback stats),
  `tests/test_round12_case_aggregate.py`, `tests/test_kpi_strip_bindings.py`,
  `tests/test_metrics_breakdown.py`.
- `tests/test_case_actions_reinvestigate.py` (action semantics), `tests/test_runbook_runs.py`
  (pending_auto_close).
- Audit category contract tests reading `audit/event_categories.json`.

Webui:
- `src/soc/pages/settings/__tests__/settings-sections.test.ts`,
  `detection-autoclose.test.tsx`, `automation.render.test.tsx`,
  `case-policy.render.test.tsx`, `advanced-schema.test.tsx`.
- `src/soc/__tests__/bundle-first-paint.test.ts:158-243` (entry budget),
  `src/soc/__tests__/console-map.contract.test.ts`.
- `outcome` / FactsRail / DecisionCard tests if review state is shown; Inbox category
  tests if a category or trigger is added; `components/audit/events.ts` contract.

---

## Risks

1. Implementing the review as a case action (or stamping `decision_by`) silently moves
   every reviewed auto-close into "human-closed" across metrics, noise funnel and futility.
2. Mixing review grades into `feedback_stats` and the Effectiveness comparison manufactures
   an "improving" headline from a population change.
3. Adding a tuner provenance count to `PROVENANCE_COUNT_KEYS` invalidates every pending
   tuning proposal's fingerprint.
4. Adding fields to `PrecedentWindowConfig` or `UnconfirmedPrecedentConfig` changes the
   corpus source signature and forces a billable re-embed.
5. Bumping `CURRENT_AUTOPILOT_CONFIG_VERSION` re-applies the Round 10 migration.
6. A config bound that rejects on load resets the whole `Preferences` document, including
   `auto_close`.
7. Rubber-stamp reviews feed confirmed FP precedent back into the agent; independence
   needs an outcome question, timing and per-reviewer visibility.
8. Tier 1 analysts cannot reopen; a disagreement must reach someone with `cases:close`.
9. Entry bundle headroom (~77 B) is consumed by any new nav row or Settings meta.
10. The policy close path skips all post-decision hooks; covering it needs a second hook.
11. "How long before an auto-close takes effect, so a person can object" (detection.tsx)
    misdescribes the window: the close is immediate. Worth correcting if the review copy
    leans on the window.
