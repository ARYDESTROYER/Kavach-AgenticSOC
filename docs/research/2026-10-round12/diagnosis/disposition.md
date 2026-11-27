# D5: a case closed as false positive still shows "Needs human review — closed" and "Undetermined"

Scope: diagnosis only. No repository file was changed. Repo `Testing` @ `6769207`. Live demo: web UI at :5173, backend at :8088.

## TL;DR

There are two separate defects. Together they produce what the analyst saw in screenshot 5.png.

1. **Persistence (the "Undetermined" chip). This is the root cause on the analyst's build.**
   - Every published build drops the disposition the analyst picks in "Close case". That covers `origin/main` = `c3f1fa3` = 0.1.12 and every `v0.1.x` tag.
   - The Console posts `{"action":"close","disposition":"false_positive"}`. The v0.1.12 backend assigns `case.disposition` only for `set_disposition` (and `confirm_fp`), so the close keeps the value `case_manager.apply()` set at triage. For a NEEDS_HUMAN verdict that value is `UNDETERMINED`.
   - Evidence: `git show v0.1.12:backend/app/api/routes.py` lines 4493-4506. The verdict-to-disposition map is in `backend/app/engine/case_manager.py:35-39` and is applied at `:163-168`.
   - Testing fixed this in `b957dfc` (2026-08-31, #104), which added `_DISPOSITION_ACTIONS = {"set_disposition","close"}` (`routes.py:5076`) and applies it at `routes.py:5216-5222`.
   - `git merge-base --is-ancestor b957dfc` returns **false** for `v0.1.1`…`v0.1.12` and for `origin/main`. The fix is not in any shipped build.
   - The analyst's UI matches that era. Its labels are uppercase and tracked (IMPACT, RISK SCORE, RECORDED RISK FACTORS). Testing replaced those with sentence case in `05a40d1` (2026-10-06).
2. **Presentation (the "Needs human review — closed" title). This is still present on Testing HEAD and reproduced live.**
   - Even when the disposition persists, the decision headline uses only the AI verdict plus the lifecycle status: `decisionHeadline(c.verdict, c.status)` in `webui/src/soc/pages/casedetail/OverviewPanel.tsx:132-156`, called at `:1068`.
   - Several other surfaces also show only the AI verdict (see the surface audit below).
   - This is not a cache or SSE problem. `commitCase` (`CaseDetail.tsx:374-380`) writes the POST response into both the detail view and the queue, and a page reload shows the same state.

## Live reproduction (Testing HEAD, Case Manager, Take Action → Close case → False positive)

Screenshots are in `r12/shots/`. The script is `r12/diag/scripts/disp_repro.mjs`.

- `diag-disp-1-before.png`: case `demo-00000539-0005`, AI verdict NEEDS_HUMAN, status on hold. The headline reads "Needs human review — on hold" with chips **On hold** and **Undetermined**. The `Undetermined` value comes from apply(), not from an analyst.
- `diag-disp-3-dialog.png`: the Close dialog with the disposition picker set to False positive.
- Wire request: `POST /api/cases/demo-00000539-0005/action {"action":"close","disposition":"false_positive","disposition_declared":true}` returned 200. The response carried `status=closed verdict=NEEDS_HUMAN disposition=false_positive decision_by=analyst`. The history entry is stamped `classified_disposition: "false_positive"`.
- A second, best-effort call followed: `POST .../feedback {"assessment":"disagree"}` with `actual_outcome: "unknown"`.
- `diag-disp-4-after.png` (after the action) and `diag-disp-5-after-reload.png` (after reload) show the same thing:
  - **The headline still reads "Needs human review — closed".**
  - The chips now read **Closed** and **False positive**. Persistence works on HEAD.
  - The AI recommended action, "Contain and monitor.", is still the prominent block.
- `diag-disp-10-legacy-equivalent.png` reproduces the 0.1.12 server behaviour: a `close` posted without the disposition, which is what the v0.1.12 server effectively did after discarding it, on `demo-00000539-0013`. The result is "Needs human review — closed" with **Closed** and **Undetermined**, which matches 5.png exactly.
- `diag-disp-6-cm-provenance.png`: the "Code decided" lane shows "Deterministic decision authority `case_manager`", then "Authority: Analyst", then "The close / escalate call is made by deterministic code … never by raw model output". These contradict each other on a case a human closed.
- `diag-disp-7-cases-list.png`: in the Cases list, the case's VERDICT column reads "Needs human". The Disposition column is hidden by default. The **NEEDS HUMAN 13** pill still counts this closed case.
- `diag-disp-8-hovercard.png`: the hover card shows Closed, Needs human, Risk 55 and 75%. It has no disposition and no analyst outcome.

## Close flow, end to end

### Web UI

- `actionPlanForStatus` (`webui/src/soc/pages/casedetail/shared.tsx:331-391`) offers `close_disposition` for every non-terminal status. It maps to the wire verb `close` through `wireAction`, and its fields are disposition (required), resolution, tags and grading (`:195-206`).
- The picker opens empty (`CaseDetail.tsx:1043-1056`). In v0.1.12 it was pre-seeded from `c.disposition` (`v0.1.12 CaseDetail.tsx:925-928`).
- The submit button stays disabled until a disposition is chosen (`ConfirmActionDialog.tsx:318`).
- `runAction` (`CaseDetail.tsx:1064-1171`) sends `disposition`, plus `disposition_declared` when the analyst operated the picker (`:1083-1091`). It then calls `commitCase(next)`.
- After that it sends a separate, best-effort grading POST. The agree/override value comes from `deriveAgreement(verdict, disposition)` (`grading.tsx:169`), where `NEEDS_HUMAN` maps to {suspicious, undetermined}. An FP close on a NEEDS_HUMAN case is therefore recorded as **"disagree"**.
- On a closed case, Take Action offers Reopen and **Set disposition** (`shared.tsx:336-341`). That is the workaround available on 0.1.12 today.
- Case Manager bulk actions cannot close a case:
  - `set_status=closed` is rejected (`routes.py:5104-5108`).
  - Bulk resolve sends no disposition (`CaseManager.tsx:779-786`).
  - Bulk "Set disposition" uses `set_disposition`, which classifies the case (`CaseManager.tsx:765-770`).

### API

- The single-case endpoint is `POST /api/cases/{id}/action` (`routes.py:5131-5150`). Bulk actions go through `POST /api/cases/bulk` (`routes.py:5376+`) and the `case_lifecycle` Job.
- All three paths run `_perform_case_action` (`routes.py:5153-5368`), which is the human analyst layer and never calls `decide()` (#3).
- That function applies the disposition (`:5216-5222`) and sets `decision_by=ANALYST` (`:5233`).
- It appends to `status_history` (`:5258-5265`) and to `history` with `classified_disposition` (`:5275-5283`), then writes the audit record (`:5290-5303`).
- It triggers the resolved-case RAG index and drafts a suppression proposal (`:5307-5341`). It dispatches the `TRIGGER_CLOSED` notification (`:5345-5366`).

### Model and ground truth

- The Case model carries `verdict` (AI), `disposition` (applied, which may be apply()-derived), `decision_by` (last writer), `status_history`, `history[]` (classification entries) and `feedback[]` (`actual_outcome`).
- `engine/analyst_outcomes.py:81-160` decides what counts as ground truth:
  - A disposition counts only if a classification entry exists (`set_disposition`/`confirm_fp`, or `classified_disposition`) and `decision_by` is analyst.
  - Feedback counts if `actual_outcome` is binary.
- The disposition value on its own is not evidence. The UI must follow the same rule, or a model-derived `true_positive` echoed back by a human close would be shown as the analyst's call.

## Surface audit: what each surface reads after an analyst FP close (HEAD)

| Surface | Reads | Result | Evidence |
|---|---|---|---|
| Overview headline (CM and sheet) | `c.verdict` + `c.status` | "Needs human review — closed" (wrong) | OverviewPanel.tsx:132-156, 1068, 1216 |
| Brief chips | status + `c.disposition` | correct on HEAD; "Undetermined" on 0.1.12 | OverviewPanel.tsx:1228-1229, 1338-1339 |
| Sheet brief `briefChips` "Verdict" | `c.verdict` | AI only | OverviewPanel.tsx:1074-1081 |
| "Code decided" lane | static copy | claims deterministic code closed it while Authority = Analyst | OverviewPanel.tsx:1619-1660, 1676-1697 |
| `autoCloseSummary` | verdict + policy | "Held for a human" on a case a human already closed (policy enabled) | OverviewPanel.tsx:167-212 |
| Recommended action | AI `recommended_action` | still the primary block on a closed FP case | OverviewPanel.tsx:1244-1260 |
| DecisionCard (sheet) | `d.verdict ?? rationale.verdict ?? c.verdict` | AI only (correct as AI provenance, but nothing shows the analyst outcome) | DecisionCard.tsx:118, 217 |
| Cases list | Verdict column visible; Disposition column hidden by default | shows "Needs human" | Cases.tsx:138-139, 1134-1139, 1229-1235 |
| Cases "Needs human" pill and filter | `status==needs_human` OR `verdict==NEEDS_HUMAN`, terminal included | closed FP case still counted (13) | Cases.tsx:201-206, 385, 911 |
| CaseHoverCard | `VerdictBadge` only | "Needs human" on a closed FP case | CaseHoverCard.tsx:111-133 |
| Case Manager queue row | status only | no outcome on terminal rows | CaseManager.tsx:256+ |
| FP-rate KPI / trend | `verdict == FALSE_POSITIVE` / verdicted | analyst-adjudicated FP never counts | engine/metrics.py:662, 696, 1361, 1409; Overview.tsx:1870, 2270; Metrics.tsx:1038 |
| `analyst_confirmed_outcome` / precedent / RAG | classification entry + disposition | correct on HEAD; **lost on 0.1.12**, where the close never classified | analyst_outcomes.py:103-160 |
| Notifications | verdict + disposition fields | correct once persistence is fixed; 0.1.12 sends "Disposition: undetermined" | notifications/templates.py:256-270, 347-381 |
| Export | full Case document | carries both fields | routes_export |

## Proposed fix (#3-safe: presentation and an additive read model only; `decide()`, `risk.py` and `signatures.py` untouched)

### F1. Ship the persistence fix to Stable

- Promote `b957dfc` in 0.1.13, or cut a patch release.
- Regression coverage already exists: `backend/tests/test_g1_ground_truth_intake.py:119` (declared close produces ground truth) and `:152` (an undeclared close produces none).
- Until then, operators on 0.1.12 can fix closed cases with Take Action → **Set disposition**. `set_disposition` is the only verb that persists on 0.1.12, and it also classifies the case.

### F2. Headline rule: the analyst's classification wins once a human resolves the case

1. Add one pure helper, `analystOutcome(c)`, in `webui/src/soc/components/outcome.ts`. It mirrors `is_classification_entry`:
   - Scan `c.history` newest-first for `event==='analyst_action'` with `action ∈ {set_disposition, confirm_fp}` or a non-empty `classified_disposition`.
   - Return `{disposition, by: entry.analyst, at: entry.ts}`, using `classified_disposition`, else `'false_positive'` for `confirm_fp`, else `c.disposition`.
   - Return `null` unless `c.decision_by === 'analyst'`.
   - `/api/cases` already returns `history` per case (verified live), so this needs no backend change. Optionally, add an additive read-only `analyst_outcome` to the Case response computed server-side by the same `_confirmation` core, so the Console and the backend share one authority.
2. Rule, in priority order:
   - **Analyst classified** (helper is non-null): the headline comes from the analyst disposition and the lifecycle status. Examples: "Closed as false positive", "Resolved — true positive", "Closed as benign", "Closed as duplicate".
     - A caption below it reads "Analyst Admin · 2m ago · AI verdict: Needs human review (75%)", so the AI verdict stays visible as provenance.
     - The disposition chip gets an "Analyst" provenance tag. That needs a new `'analyst'` member in `Provenance` (`webui/src/lib/types.ts:4170`) and in the ProvenanceTag meta.
   - **Terminal + `decision_by==='analyst'` + no classification**: "Closed by analyst — outcome not recorded", plus an inline "Set disposition" call to action and the AI verdict caption. This stays honest because there is no ground truth.
   - **Otherwise** (open, agent auto-close, system routing): the current `decisionHeadline` output, unchanged. Examples: "Needs human review — on hold", "Likely a false positive — closed".
3. Apply the same helper to the related surfaces:
   - `CaseHoverCard`: add the outcome badge with its analyst tag next to the AI verdict.
   - Cases list: either show the Disposition column by default (remove it from `CASES_DEFAULT_HIDDEN`), or add an "Outcome" column that shows the analyst value or, failing that, the AI verdict with its provenance icon.
   - `needsHumanCase` (Cases.tsx:201): count only `isActiveCase(c)`.
   - Case Manager `QueueRow`: add an outcome chip for terminal rows.
   - "Code decided" lane: when the case is terminal and `decision_by==='analyst'`, replace the deterministic-close copy with "Closed by an analyst (human lifecycle action) — the deterministic policy did not close this case", and title the block "Analyst resolved".
   - `autoCloseSummary`: return `null` when the case is terminal and a human closed it.
   - Recommended action: on terminal cases, retitle it "AI recommendation at triage" and demote it.

### F3. Metrics (separate decision)

- Keep `false_positive_rate` byte-identical, because it is a shipped series, and label it honestly as "AI-verdict FP rate".
- Optionally add an additive `analyst_confirmed_false_positive_cases` from `analyst_confirmed_outcome` (already imported at `metrics.py:43`).

### F4. Grading derivation (optional)

- An analyst resolving a NEEDS_HUMAN verdict is not overriding the AI. Treat NEEDS_HUMAN → any concrete outcome as "resolved, no comparison", the same way `duplicate` is handled (`grading.tsx:169`), so agent-effectiveness stops counting it as "disagree".

### Tests to add or adjust

- Webui:
  - `OverviewPanel.test.tsx:186-193` keeps its AI-only cases.
  - Add: a classified FP close → "Closed as false positive" plus the AI caption.
  - Add: an undeclared analyst close → "outcome not recorded".
  - Add: an agent auto-close is unchanged.
  - Add: the Cases needs-human pill excludes terminal cases.
  - Add: the hover card shows the analyst outcome.
- Backend: existing `test_g1_ground_truth_intake.py`. If the optional `analyst_outcome` field is added, test it in parity with `analyst_confirmed_outcome`.

## Demo mutations made during diagnosis

- `demo-00000539-0005`: on hold → closed, disposition `false_positive`, through the UI.
- `demo-00000539-0013`: on hold → closed, through the API with no disposition, to reproduce the 0.1.12 state.
- Both are demo cases. Reopen them if a clean demo is needed.
