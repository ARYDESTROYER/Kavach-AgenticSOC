# Round 16 synthesis: scope, work packages, backlog and open questions

Synthesis agent report. Repository `/home/user/Kavach-AgenticSOC`, branch `claude/round16`, HEAD
`3cd362c` ("Journal: Round 16 start", on top of `3cfd5c0`, the Round 15 merge into Testing). Read-only:
nothing in the repository was edited.

Inputs read in full: `competitors.md`, `oss-ecosystem.md`, `case-manager-ux.md`, `explainability.md`,
`ai-investigating.md`, `login.md`, `whats-new.md`, `release.md`, `backend-roadmap.md`,
`data-visibility.md` (all in this folder). The bug hunt (operator ask 4) is a separate workflow whose
output is still being written under `scratchpad/round16/bugs/`; this plan reserves WP15 for it.

Spot checks made for this synthesis (all confirmed in the tree at `3cd362c`):

- `OpenAIProvider` builds `httpx.AsyncClient(base_url=base_url)` and posts to `"/v1/chat/completions"`
  and `"/v1/embeddings"` (`backend/app/llm/providers.py:631, 886, 930, 1037`), so a base URL ending in
  `/v1` doubles the path (oss-ecosystem B1).
- `case_trace` (`routes.py:8498`), `case_rationale` (`:8517`), `case_export` (`:8191`), `scans`
  (`:8579`) and `standup` (`:8603`) declare no `require_permission` (data-visibility DV-1).
- The updater, bootstrap script and release discovery still default to `ARYDESTROYER/Agentic-Kibana`
  (`updater/agentic_soc_updater/__main__.py:21`, `scripts/bootstrap-updater.sh:45`,
  `backend/app/config.py:2408`) while `origin` is `ARYDESTROYER/Kavach-AgenticSOC` (release B1).
- The Remember me hint is `Stay signed in on this device for up to ${duration}`
  (`RememberMeControls.tsx:87-91`).
- `CASE_TABS` is `['overview','runbook','investigation','collab','chat']` (`webui/src/soc/case-tabs.ts`).
- `PRE_REVAMP_ENTRY_BYTES = 329_080` (`webui/src/soc/__tests__/bundle-first-paint.test.ts:185`).
- `_with_advisory_bands` returns a `Case` copy (`routes.py:6350`) and `GET /api/cases/{case_id}` has
  `response_model=Case` (`routes.py:7150`), so a read-time object that is not a `Case` field cannot ride
  that response. This is why the per-case SLA reading goes into `GET /api/cases/{id}/triage` below.

## 1. Summary

Round 16 should ship the operator's asks as nineteen work packages in four waves:

1. **Visible AI work.** A memory-only investigation registry, one new SSE frame and a reconcile route.
   On the Console: an "AI working" chip on the case header's existing meta line (no new row), a mark on
   the queue row, a count on the Case Manager navigation item, warnings in the close dialogs, and Inbox
   items when a manual run finishes or replaces a close. The run's result stays authoritative, and the
   Console now says so. Reinvestigate stops blocking and updates a closed case in place.
2. **A cleaner, segregated Case Manager.** The page title band goes and the header compacts to two rows
   plus tabs. First content moves from y = 324 to y ≤ 210 at 1440x900. The tabs become one lane each:
   Brief, Evidence, AI investigation, Response, Activity, and Chat for now. The facts rail becomes a
   six-section inspector that shows at 1440 px.
3. **Every number explainable.** One lazy `Explain` primitive: hover shows a one-line formula with the
   real numbers, click shows inputs, steps, rounding and provenance. It is fed by values recorded at
   scoring time by the same code paths. The risk inputs and weights in force are stored on new cases.
   The decision gate is recorded on the audit row. A server SLA reading, one rounding rule and a metrics
   samples route complete it. Eight drift defects are fixed first, because an explanation that disagrees
   with its number is worse than none.
4. **All data reachable.** Three ungated case read routes are gated (a security fix). New views show a
   case's raw events, per-call AI usage with the exact cost formula, and trace step details with honest
   step kinds. Also shown: full findings, the status reasons people typed, per-provider enrichment, the
   full grading record, and a "View all fields" sheet so every stored field is visible somewhere.
5. **A quiet sign-in page.** Console tokens, one 280 ms entrance and nothing moving afterwards.
   "Remember me" is shown with no duration. The SSO error vocabulary is closed. The prototype measured
   the entry chunk 7,170 B smaller.
6. **What's new and Communication.** Curated per-release notes with screenshots, compiled into a lazy
   Console page under a renamed "Communication" group. A once-per-update welcome dialog after sign-in is
   keyed by the newest update id, not the version, because the version does not bump per round.
7. **A release that can actually be installed.** Ship the repository-identity fix before tagging; without
   it a new tag fails canonical bootstrap like the last six. Add release-record guards, honest migration
   notes and a v0.1.1 rollback rehearsal. The operator decides the number (0.1.13 or 0.2.0), the license
   and the repository identity.
8. **A few high-value, low-risk extras.** The LIVE Overview stops re-reading up to 20,000 cases every 5 s.
   The review ledger is decoded once per request. RAG search uses pgvector, or a cached matrix on SQLite
   (1.2 to 1.5 s down to 0.2 ms at 2,000 chunks). The local-model `/v1` URL bug is fixed.

`decide()` and `engine/risk.py` stay byte-identical, no work package adds a model call, and storage
stays KV-only (one optional new KV namespace).

## 2. Where the reports disagreed, and the decision taken

| Topic | Positions | Decision for Round 16 | Why |
|---|---|---|---|
| Where the live AI signal sits in the case header | case-manager-ux 5.4: a 28 px live strip between meta and tabs. ai-investigating 4.6: a chip on the meta row, no new row | **Chip on the meta row** with a popover; a 6 s success tint and a polite announcement on finish | Operator ask 2 is to remove wasted space at the top; the chip adds no height |
| Copy for the AI state | "AI agent is working" (case-manager-ux) vs "AI working" (ai-investigating) | Chip and row: "AI working · m:ss", "AI queued". Popover title: "AI investigation running" or "AI investigation waiting". Announcement: "AI investigation finished: <status words>". Never "Investigating" alone | `CaseStatus.INVESTIGATING` is the human acknowledged status (ai-investigating F8) |
| How the risk inputs are recorded | explainability D-API-1: refactor `compute_risk` into `_risk_terms`, outputs identical. backend-roadmap R8 and competitors R2: a separate pure `explain_risk`, `engine/risk.py` untouched. case-manager-ux: a `weights` snapshot only | **New pure `engine/risk_explain.py::explain_risk`**, recorded as `RiskBreakdown.inputs` (inputs plus weights in one optional field), with a property test against `compute_risk` | AGENTS.md records `engine/risk.py` as untouched since Round 10; a separate module keeps that literal |
| Release-notes source | whats-new: one JSON per release plus a stdlib generator to a checked-in JSON under `webui/src`. release R13: front matter in `docs/releases/*.md`. backend-roadmap R9: a backend `GET /api/releases/notes` | **whats-new design** (JSON source, generator, checked-in generated JSON, no backend notes route) | The Docker Web stage cannot see `docs/` (whats-new F1); the notes are static content shipped with the Console |
| The What's new marker | version string (backend-roadmap R9, competitors R6) vs newest update id (whats-new) | **Newest update id** in `UserPrefs.misc.whats_new_seen` | Rounds 12 to 15 all ran as 0.1.13 (whats-new F2); a version key would never re-show on Testing |
| Case tabs | case-manager-ux R4: five lanes (Brief, Evidence, AI investigation, Response, Activity) plus Chat, which moves into the inspector next round. competitors R4: keep the Round 15 tabs, reorder content verdict-first | **Lanes**, with verdict-first ordering inside the Brief's AI and Decision lanes and key findings capped at five | The operator asked for "a lot more cleaner and segregated" from deep research; the lane design is that research. Six tabs this round (Q8) |
| Realtime connection budget | ai-investigating R9: one shared case-room stream. case-manager-ux 5.4: a page-level multiplexer in `useEventStream` | **Page-level multiplexer** (one EventSource per page, reference-counted topics), in WP09 | It fixes D6 and F7 for every page and lets new subscriptions cost nothing; verify the count in a browser |
| Shell-level "AI is investigating" | competitors R1: a shell glyph with a count. ai-investigating R12: optional, costs entry bytes | **Include** a count on the Case Manager navigation item, fed by a new low-volume `investigations` topic on the multiplexed shell stream | It is the literal "notification" the operator asked for; the sign-in page redesign frees about 7 KB of entry budget |
| Per-case SLA | explainability D-API-3: attach `case.sla` beside the advisory bands | **Serve the server reading in `GET /api/cases/{id}/triage`**, and fix the client formula to count the same human status moves, with shared vectors | `GET /api/cases/{id}` is `response_model=Case`; a non-field key would be filtered and a field would be persisted |
| Per-call price basis on `UsageDoc` | explainability R14: later. data-visibility R3: this round | **This round** (WP13), still one row per call written only by the gateway | Cost is the number a free deployment watches most |
| Explain triggers inside queue rows | case-manager-ux: a mouse-only HoverCard on "Risk N". explainability 5.1: no trigger in rows | Mouse-only HoverCard with **no focusable content**, the accessible name carries "risk 62", and the keyboard path is the header chip | No nested interactive content inside a row button |
| Version number | Task text: 0.1.13. release B6: the project's own `channels.md` rule says 0.2.0 | **Operator decision (Q1).** Every work package is written for version V | Both are defensible; see section 10 |

## 3. Round 16 scope at a glance

**In (operator asks):** WP01 to WP05 and WP07 to WP19 in section 6.

**In (extras, at most a few):** WP06 (LIVE Overview population TTL, review ledger memo, native or cached
vector search, optional loop-lag gauge), and the `/v1` local-model URL fix inside WP15.

**Stretch (only if capacity remains):** SQL queue projection (backend-roadmap R3); HTTP push answered
before investigating (backend-roadmap R10); audit `run_id` filter (ai-investigating R13); condense on
scroll (case-manager-ux 5.3).

**Out (next rounds, section 9):** Ask AI in the inspector, a free local-model path, install and doctor,
source presets, offline intel, Sigma, response actions, MCP and API keys, new pull connectors,
multi-replica, passkeys, push evidence snapshots.

**Cut line if the round must shrink (drop in this order):**

1. WP06 vector search.
2. The WP12 samples route (keep the tile arithmetic lines).
3. The WP14 events view and usage popover. Keep the WP13 route gating and the WP14 fields sheet,
   findings and reasons.
4. The WP09 navigation count.
5. The WP07 install history (R5).
6. The WP08 per-case lock.

Never cut:

- the route gating;
- the release identity fix;
- the AI chip, queue mark and close warnings;
- the Case Manager header and lanes;
- the risk explanation;
- Remember me;
- What's new.

## 4. Rules every work package follows

- **Isolation.** Each WP builds in its own worktree from the round branch. It edits only the files it
  owns (section 5) plus the named hunks it is allowed in shared files. A finding in another WP's file is
  reported to that WP, not fixed in place.
- **Stub-first mount points.** WP01 creates every cross-package component with its final props and a
  no-op body. WP02 and WP03 mount the stubs while they restructure the pages. The feature WPs then
  replace the stub bodies, so almost no mounting is left for integration.
- **Generated files** (`webui/src/lib/api-types.gen.ts`, `webui/openapi.json`,
  `backend/app/knowledge/console_map.json`, the app knowledge corpus, `release-notes.gen.json`,
  `docs/releases/whats-new.md`) are resolved by re-running their generator, never by hand merging. WP16
  and WP18 regenerate them on the integrated tree.
- **CHANGELOG, Journal and Help Center text** are returned in each WP's final report. WP18 writes them,
  which avoids conflicts at one `[Unreleased]` spot. Every WP ends its report with a Journal entry in the
  AGENTS.md format.
- **Gates per WP before hand-off:**
  - `cd backend && python -m pytest -q`;
  - `cd webui && npm run typecheck && npm run lint && npm run gates && npm run test:strict && npm run check:types && npm run build`;
  - `python3 scripts/check_version.py`;
  - `python3 scripts/check_ci_contract.py`;
  - `python3 scripts/check_docs.py`;
  - `backend/.venv/bin/python scripts/build_app_knowledge.py --check`;
  - the `decide()` and `engine/risk.py` byte-identity guards.
- **Non-negotiables:**
  - #3: no WP edits `decide()` or `engine/risk.py`, and recorded gates and inputs are written after
    `apply()` or beside `compute_risk`, never read by a decision.
  - #6: no new model call anywhere.
  - #7: frames and explanations carry ids, enums and our own numbers only.
  - #9: every case, source, model or person derived string renders as a text node, `InlineCode`,
    `CodeBlock` or `JsonTree`, and provider `raw` and prompt excerpts stay fenced.
  - #12: no new index or table. The only new KV namespace is the optional `release_history` (WP07).
- **Entry budget.** The budget is shared: baseline 329,080 B plus 1,024 B. Every Console WP reports its
  measured entry delta. New UI lives in lazy chunks; only the AI store, the navigation glyph, the What's
  new gate and the channel strings may reach the entry. WP04 frees about 7 KB, and WP16 ratchets the
  baseline down to the merged measurement.
- **Copy.** No em dashes in public copy. Never "Round" in Console copy. Never "Investigating" for the AI.

## 5. File ownership for the hot files

| File | Owner | Other WPs allowed a distinct hunk (merge order) |
|---|---|---|
| `backend/app/models.py` | WP01 | none |
| `backend/app/realtime.py` | WP01 | none |
| `backend/app/audit/event_categories.json` | WP01 (adds `case.close_replaced`, `case.events_viewed`) | none |
| `backend/app/agents/pipeline.py` | WP08 | WP10 (risk call sites near 942, 1415, 1564; DECISION audit `tool_input` near 1239); merge WP08 first |
| `backend/app/api/routes.py` | none (many owners by region) | WP08 (reinvestigate and investigate handlers 8347 to 8424, `_case_view`, topic permission map near 451, the case action lock); WP13 (permission dependencies at 8191, 8498, 8517, 8579, 8591, 8603) |
| `backend/app/api/routes_triage.py` | WP10 | none |
| `backend/app/engine/metrics.py` | WP12 | none (WP10's SLA reading imports `_CaseTimings` from it, read-only) |
| `backend/app/state.py` | WP08 | WP06 (loop-lag task), WP07 (optional install history at startup) |
| `backend/app/config.py` | WP05 (`ReleaseUpdateConfig`) | none |
| `backend/app/llm/gateway.py`, `llm/pricing.py` | WP13 | none |
| `backend/app/llm/providers.py` | WP15 | none |
| `scripts/check_version.py` | WP05 | none |
| `.github/workflows/ci.yml` | WP07 (docs lane step) | WP05's separate Dependabot PR (action pins) |
| `mkdocs.yml` | WP05 (URLs) | WP07 (nav entry) |
| `webui/src/lib/useEventStream.ts` | WP09 (multiplexer) | WP01 (`STREAM_CHANNELS` entry only, lands first) |
| `webui/src/soc/registry.tsx` | WP07 | none |
| `webui/src/soc/App.tsx` | WP07 (What's new gate, wizard stamp) | WP04 (`CenterSpinner` delayed reveal) |
| `webui/src/soc/AppShell.tsx` | WP07 (`ReleaseBadge` link) | WP09 only through `NavSidebar.tsx` (owned by WP09) |
| `webui/src/soc/pages/CaseManager.tsx` | WP02 | WP16 (final mounts only) |
| `webui/src/soc/pages/CaseDetail.tsx` and `casedetail/*` | WP03 | Exceptions owned elsewhere: `DecisionCard.tsx`, `StageTimeline.tsx`, `SignalProfile.tsx`, `caseFacts.ts` (WP11); `ConfirmActionDialog.tsx`, `BulkCloseDialog.tsx` (WP09); `CaseHistory.tsx`, `grading.tsx`, `ThreatContextPanel.tsx`, `WhyPanel.tsx` (WP14); new folders `casedetail/explain/**` (WP11) and `casedetail/records/**` (WP14) |
| `webui/src/soc/pages/Overview.tsx`, `Metrics.tsx`, `NoiseFunnel.tsx` | WP12 | none |
| `webui/src/soc/pages/Login.tsx`, `components/auth/*`, `styles/theme.css` login block | WP04 | none |
| `webui/src/soc/pages/Docs.tsx` | WP05 (URL constants) | WP07 (moves two helpers to `lib/docs-url.ts` and re-exports) |
| `docs/development/ui-standard.md` | WP16 (consolidation) | WP02 ("Queue and detail workspaces"), WP03 ("Case header", "Case tab bodies", G17), WP04 ("Identity surfaces", "Identity accents") |
| `webui/src/soc/__tests__/bundle-first-paint.test.ts` | WP16 (baseline ratchet) | WP04 (eager-chain list), WP07 and WP11 (not-in-entry assertions) |

## 6. Work packages

Format per package: goal; implements (research recommendation ids); files; contracts; tests;
acceptance; dependencies; effort (S about a day, M two to four days, L a week or more).

### Wave 0 (start at once; no contract dependency except WP01 stubs, which WP02, WP03 and WP07 pick up by rebasing)

#### WP01. Contracts and foundations (M; backend and client; no visible behaviour)

- **Goal.** Land every shared contract and stub so later packages run in parallel without touching
  shared files.
- **Implements.**
  - ai-investigating: the pure registry module of R1, and the R2 constants.
  - explainability: R1 (types and contract file), R7 (backend rounding helper).
  - backend-roadmap R8 (`explain_risk`).
  - case-manager-ux R2 (the weight snapshot, merged into the inputs).
  - data-visibility: the R3 and R14 store methods.
  - whats-new R3 (prefs keys).
- **Files.**
  - `backend/app/models.py`:
    - `RiskInputs`, and `RiskBreakdown.inputs: RiskInputs | None = None`;
    - `InvestigationView`, `InvestigationSlots`, `InvestigationsActive`;
    - `TraceSpanDetail`, plus optional `TraceSpan.detail` and `TraceSpan.cost_basis`;
    - optional `UsageDoc` fields `input_rate_per_million`, `output_rate_per_million`,
      `cache_read_rate_per_million`, `cache_write_rate_per_million`, `cache_write_ttl`, `price_basis`;
    - `CaseEventsPage` and `CaseUsagePage` response models;
    - `UserPrefs.misc` keys `whats_new_seen` (grammar `^[a-z0-9][a-z0-9_.:-]{0,63}$`) and
      `whats_new_auto` (bool, absent means on), normalised on load like `_ROUND14_LIST_PREFS`
      (invalid values removed, never coerced).
  - `backend/app/engine/risk_explain.py` (new, pure):
    `explain_risk(cluster, prefs, reputation, *, reputation_source, scored_at) -> RiskInputs`.
  - `backend/app/engine/investigation_registry.py` (new, pure): the ai-investigating 4.2 API (`begin`,
    `started`, `attach_case`, `phase`, `end`, `active`, `for_case`, `recent`, `new_runs`, `clear`).
    Every method swallows its own errors.
  - `backend/app/realtime.py`:
    - `CASE_INVESTIGATION_EVENT = "case.investigation"` in `SSE_EVENT_TYPES`;
    - `INVESTIGATIONS_TOPIC = "investigations"`;
    - `publish_case_investigation(bus, view, *, active, new_runs)` with `retain=False` on `cases`,
      `cases:{id}` and `investigations`.
  - `backend/app/utils.py`: `round_half_up(x) -> int` (`floor(x + 0.5)`).
  - `backend/app/audit/event_categories.json`: `case.close_replaced` ("Close replaced by an AI
    investigation") and `case.events_viewed`, both under `case_work`.
  - Store methods in `stores/base.py`, `stores/usage.py` and `stores/sql/repositories.py`:
    `UsageRepository.records_for_case(case_id, limit=500)` and an audit `count_for_case(case_id)`.
  - `webui/src/lib/useEventStream.ts`: the `'case.investigation'` channel string only.
  - `webui/src/lib/explain/types.ts`: the `Explanation` interface (explainability 5.3).
  - `webui/src/lib/explain/explain.contract.json`. Vectors:
    - rounding at 80.5, 73.5, 73.6, 47.5 and 21.5;
    - the risk worked example of explainability section 3, plus count 2, span 0 and all-zero weights;
    - Wilson 27/30 (0.7438 to 0.9654) and the 14/20 lower bound 0.4810;
    - percentile of [4, 9, 31, 62] (p50 20.0, p90 52.7);
    - priority lookups, including `low/high` = P3;
    - SLA states.
  - Stub components with final props and no-op bodies:
    - `soc/investigations/AiRunChip.tsx` `{caseId, compact?}`;
    - `AiRunMark.tsx` `{caseId}`;
    - `AiQueueNotice.tsx`;
    - `useAiRun.ts` `(caseId) => InvestigationView | null`;
    - `casedetail/explain/RiskExplain.tsx` `{caseId, score, breakdown, children}`;
    - `casedetail/explain/DecisionExplain.tsx` `{caseRecord, children}`;
    - `casedetail/explain/FactExplain.tsx` `{explanation, children}`;
    - `casedetail/records/CaseEvents.tsx` `{caseId}`;
    - `CaseUsageButton.tsx` `{caseId, totalCost}`;
    - `AllFieldsSheet.tsx` `{caseId, open, onOpenChange}`;
    - `FindingsList.tsx` `{findings}` (renders today's first-sentence form);
    - `AwaitingReason.tsx` `{caseRecord}`.
  - Regenerate `api-types.gen.ts` and `openapi.json`; update `webui/src/lib/types.ts`.
- **Contracts.** These are the field names the other packages rely on. `RiskInputs` holds:
  - the counts and window: `event_count`, `span_seconds`, `effective_window_seconds`,
    `rate_per_minute | null`, `velocity_rule` (`below_min_events | rate`), `rule_type_count`;
  - reputation: `reputation_input` and `reputation_source` (`enrichment | not_ip_entity |
    enrichment_off | not_looked_up`);
  - asset: `asset_value`, `asset_match` (`network | exact | none`), and `asset_cidr` (served only to
    `settings:read`);
  - weighting: `weights` (the five keys), `total_weight`, `zero_weight_fallback`;
  - `refs` (`volume 50`, `velocity 10.0`, `diversity 5`);
  - provenance: `scored_at`, `inputs_version: 1`.
- **Tests.**
  - A property grid with `explain_risk` against `compute_risk`: count 0 to 120, span 0 to 3,600 s,
    reputation, rules 0 to 7, and weights including all zero. Factor equality must hold, and the total
    must re-derive from the inputs within 0.005.
  - Registry lifecycle, pruning of done tasks, and the recent ring bound and TTL.
  - The SSE registry parity tests on both ends (`test_sse_agent_step_channel.py`,
    `useEventStream.test.tsx`).
  - The prefs normaliser.
  - The store methods, on the ES fake and on SQLite.
  - `backend/tests/test_explain_contract.py` for the existing functions (`compute_risk`, Wilson,
    percentile, `round_half_up`).
  - `check:types` with no drift.
- **Acceptance.**
  - All gates green.
  - No visible change.
  - Entry chunk within plus or minus 50 B.
  - `engine/risk.py` and `case_manager.py` byte-identical.
- **Depends on.** Nothing.

#### WP02. Case Manager queue and frame (M; Console)

- **Goal.** Reclaim the route's top band and calm the queue.
- **Implements.** case-manager-ux R1 (frame part, section 5.1), R7 (queue rows), the section 5.2 focus
  mode, and the section 5.9 empty pane.
- **Files.** `webui/src/soc/pages/CaseManager.tsx` and its tests (`CaseManager.test.tsx`,
  `route-visual-standard.test.ts` matched pair, the `console-grammar.guard.test.ts` exception modelled on
  Chat), plus the "Queue and detail workspaces" section of `ui-standard.md`.
- **Contracts.**
  - The page frame:
    - no routed `PageHeader`;
    - an `sr-only` h1 "Case Manager";
    - Live, Refresh and "About Case Manager" in band row 1;
    - `-my-2` and `h-[calc(100dvh-5.5rem)]`.
  - The queue row:
    - a 40 px leading slot that shows the severity glyph and becomes the checkbox on hover, focus, any
      selection, a running bulk job, and always under `(pointer: coarse)`;
    - "Risk N" in neutral `text-foreground/80 tabular-nums`;
    - the `AiRunMark` stub mounted before the age.
  - `AiQueueNotice` mounted in the band.
  - `[` collapses the queue to a 44 px strip. J and K keep working.
    `soc.caseManager.queueCollapsed` is stored with try/catch.
  - `responsiveQueueWidth` clamps to 340..520.
  - An empty pane reads "No case open", with up to three counted filter shortcuts.
  - `caseManagerShortcuts()` lists only the keys the viewer can use.
- **Tests.**
  - X toggles a row whose checkbox is hidden.
  - The checkbox is visible after one selection and under a coarse pointer (matchMedia mock).
  - The empty-state buttons apply the right filters.
  - The shortcuts dialog is truthful.
- **Acceptance.** At 1440x900 the split frame starts at y = 72 and the band is 92 px.
- **Depends on.** WP01 stubs (rebase before mounting).

#### WP03. Case detail structure: compact header, lanes, inspector (L; Console; critical path)

- **Goal.** One question per region. First content at y ≤ 210 at 1440x900 for every case.
- **Implements.**
  - case-manager-ux: R1 (header, section 5.3), R4 (lane tabs, 5.5), R5 (inspector phase 1, 5.6), and R8
    (humanised automation records, the Tasks pointer removed); also the keyboard model of 5.10 and the
    phone layout of 5.11.
  - competitors R4: verdict-first inside the Brief, with key findings capped at five.
- **Files.**
  - `CaseDetail.tsx` and `casedetail/*` (minus the exceptions in section 5).
  - The tab and routing pieces: `case-tabs.ts`, `router.tsx` (legacy tab rewrite only), `ui/tabs.tsx`
    (`density="compact"`).
  - The `casedetail/shared.tsx` padding constant, moved to container queries.
  - The new `casedetail/EvidencePanel.tsx`.
  - The panels and rail: `OverviewPanel.tsx` (the Brief), `InvestigationPanel.tsx`, `RunbookPanel.tsx`,
    `CollaborationPanel.tsx`, `FactsRail.tsx` (the inspector), `CaseHeaderMeta.tsx`,
    `AutomationApplied.tsx`, `review/ReviewBand.tsx` (it becomes a chip plus a Brief note).
  - The "Case header" and "Case tab bodies" sections and the G17 rule of `ui-standard.md`.
- **Contracts.**
  - **Tabs.**
    - Ids and labels: `['overview','evidence','investigation','runbook','collab','chat']`, labelled
      Brief, Evidence, AI investigation, Response, Activity, Chat, on Alt+1 to Alt+6.
    - Legacy rewrites:
      - `timeline` opens `evidence` at `what-happened`;
      - `threat` opens `evidence` at `threat-context`;
      - `tab=investigation&section=threat-context` opens `evidence`;
      - `section=related-cases` opens `evidence`.
    - `tab=investigation` is unchanged, for the audit "Open case trace" links.
    - Response is shown to everyone: tasks always, the runbook with `runbooks:read`.
  - **Header.**
    - Row 1, 44 px: title, primary action, Take action, Ask AI, More, the inspector toggle (`]`),
      Back.
    - Row 2, a 24 px meta strip that never wraps. Its items, in priority order, hide by container
      query:
      1. case number;
      2. severity;
      3. status or outcome;
      4. the Risk chip (wrapped in the `RiskExplain` stub);
      5. the AI verdict chip (wrapped in `DecisionExplain`), with `AiRunChip` right after it;
      6. owner;
      7. SLA;
      8. the review chip.
    - Tabs, 36 px.
    - Total height 118 px for every case, including review samples.
  - **The inspector.**
    - A column from `@[52rem]/case`, 272 px, or 304 px from `@[72rem]/case`.
    - `]` toggles it, persisted in `soc.caseManager.inspector`.
    - Six collapsible sections, open state persisted: Outcome, Signal, Times, Source and entity, Tags
      and campaign, and Record (collapsed).
    - Record mounts "View all fields" (`AllFieldsSheet`) and `CaseUsageButton`.
  - **The Brief.**
    - A 48 px Next step row.
    - Four lanes tagged with the existing `ProvenanceTag` kinds: Evidence (`source`), AI (`ai`), Decision
      (`code`, holding the `DecisionCard` and `AutomationApplied` disclosures), People (`analyst`).
    - A folded "How this case was built" (`StageTimeline`).
  - **Evidence.** What happened (fenced), the `CaseEvents` stub, entities, threat context, related cases,
    baseline.
  - **AI investigation.** Assessment (`FindingsList`), inputs, the trace (expanded while `useAiRun`
    reports a run), gradings, and one muted advisory line.
  - **Activity.** Discussion, files, history.
- **Tests.**
  - Update the existing suites: the `CaseDetail.*` header, tab and focus suites,
    `router-case-tabs.round15`, `router-deep-links.round14`, `OverviewPanel`, `InvestigationPanel`,
    `case-visual-dialect` and `FactsRail`.
  - A segregation guard: no `ProvenanceTag kind="code"` in the AI tab, and no `kind="ai"` in Evidence.
  - One deep-link test per legacy id.
  - The meta strip is `flex-nowrap` and carries its hide classes.
  - `[` and `]` honour `shortcutBlocked`.
  - jest-axe.
- **Acceptance.** Measured by the screenshot script:
  - at 1440x900, the first panel heading top is at most 210 px, and the header is at most 120 px for a
    normal case and for a pending review case;
  - at 390x844, the first heading is at most 200 px;
  - at 1440 px with the navigation collapsed, the inspector shows as a column.
- **Depends on.** WP01 stubs (rebase before mounting).

#### WP04. Sign-in page (M; Console)

- **Goal.** A quiet sign-in page on the Console's own tokens. "Remember me" without a duration.
- **Implements.** login R1 to R12 and R14 (R15 optional).
- **Files.**
  - `Login.tsx`, `loginParts.tsx`, `RememberMeControls.tsx`.
  - Delete `LoginAuthBackdrop.tsx`, `ShineButton.tsx` and `ThemeModePill.tsx` with their tests.
  - Styles: the `styles/theme.css` login block (deleted, plus a block of about 20 lines), and the unused
    Tailwind keyframes.
  - Gates:
    - delete `scripts/gate-login-accents.mjs` and its `.d.mts`;
    - drop step 6 in `scripts/gates.mjs`;
    - add the new pairs in `scripts/gate-contrast.mjs`;
    - drop the login blocks in `design-gates.test.ts` and `foundations.test.ts`.
  - `theme.tsx` (a `brandingFresh` flag), `App.tsx` (`CenterSpinner` delayed reveal only), and the
    `BrandingEditor.tsx` preview.
  - The login tests in login section 7.
  - The "Identity surfaces" and "Identity accents" sections of `ui-standard.md`, and the
    `docs/getting-started/first-run.md` text.
- **Contracts.**
  - **Remember me.** When available, the row is the label "Remember me" with no accessible description.
    The two unavailable states keep their one-line reason. The warning dialog keeps its facts (Q6).
  - **SSO errors.** The ten backend `sso_error` codes map to fixed sentences; anything else shows a
    generic sentence.
  - **Appearance.** A three-button group: "Use system theme", "Light theme", "Dark theme".
  - **Heading and fields.**
    - The H1 is "Sign in to {org_name}", or "Welcome back" when the device remembers a username.
    - Continue is always rendered, and an empty submit shows "Enter your username.".
    - OTP submits automatically, once, guarded by `busy`.
  - **Motion (A1 to A6).**
    - CSS only, `transform` and `opacity` only.
    - At most 300 ms (the brand wash at most 600 ms), `backwards` fill.
    - Inside `prefers-reduced-motion: no-preference`, with no `infinite`.
  - **Order.** The What's new dialog appears only after the hand-off into the Console.
- **Tests.**
  - The login R1 to R14 cases.
  - No timers or re-renders after first paint (fake timers, 60 s).
  - A `theme.css` keyframe source guard.
  - One `/api/branding` call on a cold load, two after a sign-out.
  - An arbitrary `sso_error` value never reaches the DOM.
- **Acceptance.**
  - The entry chunk shrinks by about 7 KB; the prototype measured 329,080 to 321,910 B.
  - The global CSS shrinks by about 13.9 KB.
  - The login field edges use `--input` (3.27:1).
  - No assertion is weakened except by subject removal, recorded as such.
- **Records.** This package reverses Round 14 D3 for the row, replaces the recorded Identity surfaces
  contract, and retires `gate-login-accents` as subject removal, with replacement contrast pairs.
- **Depends on.** Nothing.

#### WP05. Release identity, release guards and public URLs (M; scripts, backend, docs)

- **Goal.** A tag cut from this round can pass canonical bootstrap, and the release records cannot
  silently omit content again.
- **Implements.**
  - release: R1 (B1, Option A unless the operator renames back, Q2), R11 (guards), R14 (dead docs
    links), R15 (GHCR visibility runbook text), R17 (stale baselines in `testing.md`).
  - whats-new R10 (notes required per version).
  - release R7 as a separate small PR into Testing (forward-port the four Dependabot bumps and set
    `target-branch: Testing`), if authorized.
- **Files.**
  - The updater default and the three Dockerfiles' `TLSOC_SOURCE_URL` defaults.
  - `scripts/bootstrap-updater.sh`: the new default, and a fail-closed refusal with remediation text
    when `.env` lacks `AGENTIC_SOC_UPDATE_REPOSITORY` or names the old repository.
  - `config.py` `ReleaseUpdateConfig.repository_url`: the new default, plus a before-validator that maps
    exactly `https://github.com/ARYDESTROYER/Agentic-Kibana`.
  - Console URLs: the `Docs.tsx` URL constants and the `settings/release-updates.tsx` default.
  - `mkdocs.yml` URLs.
  - Operator docs: `.env.example`, `INSTALL.md`, `DEPLOY.md`, `docs/operations/upgrades.md` (bootstrap
    step 2).
  - `scripts/check_version.py` and its tests.
  - The tests that name the old repository: the updater tests, `test_release_discovery.py`,
    `test_system_updates.py`, and the 11 Console tests.
  - `docs/development/testing.md` line 13.
- **Contracts.**
  - The frozen `deploy/docker-compose.agnostic.yml` stays byte-identical (hash pin).
  - `check_version.py` guards, on `refs/heads/main`, a `v*` tag, or a PR into `main`:
    - the `[Unreleased]` body is exactly `No changes yet.`;
    - the marker plus the release page stay at most 100,000 characters;
    - `docs/releases/notes/<VERSION>.json` exists, with `status: released` and a `date` equal to the
      dated CHANGELOG heading.
- **Tests.**
  - The release B1 test list.
  - The bootstrap shell test refuses both bad `.env` cases.
  - The preference repair is exact (any other URL is kept).
  - `check_version` cases: missing notes, testing status on a release ref, date mismatch, non-empty
    `[Unreleased]` on main.
- **Acceptance.**
  - `sha256sum deploy/docker-compose.agnostic.yml` equals `deploy/update-base-v1.sha256`.
  - The branch-context `check_version` passes.
  - Simulated main and tag contexts fail only on the records that WP19 will write.
- **Depends on.** Q2. The notes path convention is fixed here as `docs/releases/notes/<version>.json`.

#### WP06. Performance extras (M; backend)

- **Goal.** Remove three measured hot spots without touching decisions or storage layout.
- **Implements.** backend-roadmap R2 layer 1, R4, R1, and R5 (optional).
- **Files.**
  - `api/metrics_shared.py`: an all-time population TTL of 60 s with stale-while-revalidate; windowed
    reads keep 5 s.
  - `stores/auto_close_review.py`: memo keyed by revision, plus a `case_id` to entry dict.
  - `api/routes_auto_close_review.py`: pass the loaded ledger into `_repair`.
  - `stores/sql/vectorstore.py`: pgvector `<=>` over the existing JSON column with a `dim` filter on
    PostgreSQL; a normalised float32 matrix cache on SQLite and as the fallback, fingerprinted by
    `count(*)` and `max(id)`.
  - `stores/sql/engine.py`: one `pg_extension` probe at start.
  - `state.py` (the loop-lag task hunk) and `api/routes_diagnostics.py`.
- **Tests.**
  - At most one all-time read across N LIVE ticks inside the TTL, and stale-while-revalidate serves the
    previous value during a refresh.
  - One ledger decode per revision.
  - Vector top-k parity across the Python, numpy and pgvector paths, with tolerance, in the PostgreSQL
    CI lane.
  - Cache invalidation on add, delete and clear, and on a foreign write.
  - A dimension mismatch still raises `EmbeddingSpaceMismatch`.
  - A SQLite guard: 2,000 chunks answer in under 50 ms warm.
  - The loop-lag gauge rises with a blocking coroutine.
- **Acceptance.**
  - The posture and metrics parity tests are unchanged.
  - Stale all-time figures are never presented as fresh (`generated_at`).
  - No new dependency: numpy already arrives through pgvector; confirm it with `pip check` in the final
    image.
- **Depends on.** Nothing.

#### WP07. What's new pipeline and the Communication page (M to L; scripts, Console, small backend)

- **Goal.** After an update, a user sees a short welcome once. Every release is documented with
  screenshots in Communication, What's new.
- **Implements.**
  - whats-new R1, R2, R3 (audited marker, Q7), R4, R6, R8 and R9, plus R5 if Q7 asks for it.
  - competitors R6, and backend-roadmap R9 (superseded design).
- **Files.**
  - Generator: `scripts/build_release_notes.py` and `scripts/test_build_release_notes.py`.
  - Notes: a `docs/releases/notes/0.1.13.json` skeleton (structure and the Round 16 update id; WP17
    writes the content), and the generated `docs/releases/whats-new.md`.
  - The `webui/src/soc/whats-new/**` package: the generated `release-notes.gen.json`, `decide.ts`,
    `WhatsNewHost.tsx`, `WhatsNewDialog.tsx`, the figure, the lightbox, the rows and the version rail.
  - The page `pages/WhatsNew.tsx`.
  - `registry.tsx`: the group label becomes "Communication", with children Inbox and What's new;
    `PageId 'whats_new'`; a lazy route.
  - Shell and prefs:
    - `App.tsx`: the gate beside `ReauthDialog`, and the stamp on wizard completion;
    - `vite.config.ts` define `__TLSOC_WHATS_NEW_LATEST__`, with `vite-env.d.ts`;
    - the `AppShell.tsx` `ReleaseBadge` link "What's new in vV";
    - a `prefs.tsx` `loaded` flag (whats-new F3);
    - a personal Settings switch "Show What's new after updates".
  - Helpers: `lib/docs-url.ts` (moved from `Docs.tsx` and re-exported), and `lib/semver.ts`.
  - Backend: `routes_prefs.py` adds `whats_new_seen` to `_AUDITED_MISC_KEYS`. Optionally
    `api/routes_whats_new.py` and `stores/release_history.py` (KV `release_history`), with a startup
    hunk in `state.py`.
  - Docs and CI: the `mkdocs.yml` nav entry, and a `ci.yml` docs lane step
    (`build_release_notes.py --check`).
  - Help and chat knowledge: the console-map keywords and regeneration, `GUIDE_EXACT` gains
    `releases/whats-new.md`, and the `docs/USAGE.md` "Notifications" group mentions.
- **Contracts.**
  - Notes schema 1 with every whats-new 4.1 rule:
    - plain text only;
    - closed `kind` and `area` lists;
    - `open.page` validated against `console_map.json`;
    - WebP screenshots at most 2,880 px wide and 250 KB, with dimensions read from the header;
    - alt text of at least 40 characters;
    - featured highlights need light and dark images.
  - The whats-new 4.2 show rule, keyed by the newest update id.
  - Never shown over:
    - sign-in, setup, a forced password change, the wizard or re-authentication;
    - another open dialog;
    - a deep link to a record. A deep link defers the dialog to the next landing page.
  - Any close writes the marker once. A `localStorage` mirror (`tlsoc_whats_new_seen:<user>`) is the
    fallback when the write fails.
  - The dialog (4.3): 40rem, focus on the title, closing focus to `#socMain`, at most 5 highlights, a
    theme-matched hero figure, "See all changes" and "Got it".
  - The page (4.4): `#/whats_new?v=&h=`, a version rail from 1,280 px, area and kind chips, Copy link,
    and an "Earlier release records" group.
  - With auth off, the marker is per installation, and this is documented.
- **Tests.** The whats-new section 8 list.
- **Acceptance.**
  - Seeded Demo admin sees the welcome once on a landing page after sign-in; a reload shows nothing.
  - An older marker lists the newer updates; a deep link defers.
  - Entry growth is at most 450 B measured, and the notes JSON and dialog title are not in the entry.
  - The generator `--check` runs in CI.
  - The WP05 guard passes with the skeleton.
- **Depends on.** WP01 (prefs keys) for the backend part; WP05 owns `check_version.py`.

### Wave 1 (after WP01 merges into the round branch)

#### WP08. AI run tracking: backend (M to L)

- **Goal.** The server knows, and says, which investigations are queued or running, and how each ended.
- **Implements.**
  - ai-investigating: R1 (wiring), R2 (route and frames), R3 (terminal frame), R4 (non-blocking
    Reinvestigate and `409`), R5 (reinvestigate a closed case in place), R8 (finish notices and the
    close-replaced record), R11 (narrow the lost-update window), and R13 (optional).
  - backend-roadmap R7, and the backend part of competitors R1.
- **Files.**
  - `agents/pipeline.py`:
    - the registry wrapper in `_investigate_cluster_locked`;
    - new keywords `trigger`, `requested_by`, `known_case_id`, `target_case_id` and `run_id`, all
      defaulted;
    - the `_emit_step` phase hook and outcomes at the early returns;
    - close-replaced detection;
    - the terminal `decision failed` frame in the except path;
    - a per-case lock from the re-read (`:1184`) to `save` (`:1225`), taken only inside the signature
      lock.
  - The new `api/routes_investigations.py`.
  - `api/routes.py`: the reinvestigate and investigate handlers; a read-time `investigation` key in
    `_case_view`; `investigations` added to the topic permission map (`cases:read`); the case lock around
    read and save on the case action path.
  - Callers: `engine/jobs.py` `_case_reinvestigate` and `engine/poller_manager.py` `_drain_deferred`.
  - `state.py`:
    - the registry on `AppState`, and an `investigations` property with the Demo split;
    - `_investigation_finished`, started with `spawn_mutation_task`;
    - the case-lock registry, and a clear on factory reset.
  - `engine/demo_runtime.py` (the Demo registry) and the collaboration writers in
    `routes_cases_collab.py` (lock only).
- **Contracts.**
  - **The frame.** `case.investigation` carries exactly:
    - identity: `run_id`, `case_id|null`;
    - state: `state` (`queued|running|finished`) and `phase` (`queued|triage|specialist|evidence|
      verdict|decision`);
    - `trigger` (`automatic|manual|job|drain|detection`);
    - times: `queued_at`, `started_at`, `deadline_at`, `time_cap_seconds`, `finished_at`;
    - the result: `outcome` (`decided|routed_to_person|closed_by_policy|unchanged|cancelled|failed`),
      `status_after`, `verdict_after`;
    - the counts: `active` and `new_runs`.
    It is sent on start, on a late case attach and on end; a queued frame only when the gate is full.
  - **`GET /api/investigations/active?case_id=`** (`cases:read`, memory only, Demo split) returns:
    - `items` and `recent` (the last 120 s);
    - `new_runs`;
    - `slots{in_use, cap}`;
    - `process_local: true` and `generated_at`.
  - **`POST /api/cases/{id}/reinvestigate`** body `wait: bool = True`:
    - `wait=false` answers `202 {run_id, case_id, state: "queued"}`;
    - a second request answers `409 {"code": "investigation_running", "run": ...}`, checked before the
      audit row and the cluster rebuild.
  - **Inbox notices, built from enums only** (ai-investigating 4.5 copy):
    - to the requester of a manual run;
    - to a person whose close was replaced, together with a `case.close_replaced` audit row.
    Job and automatic runs get no item.
  - **Q10.** An automatic drain of a candidate that a person closed before it started is skipped, with
    outcome `unchanged`.
- **Tests.** The new `test_round16_investigation_registry.py`:
  - flip probes F1 and F6;
  - F5 close-replaced: one Inbox item and one audit row;
  - no item for job or automatic runs;
  - cancellation empties the registry;
  - the queued state with a cap of 1;
  - the run id equals the audit `run_id`;
  - factory reset cancels a spawned run;
  - a close injected during the ledger read survives in `status_history`;
  - 403 without `cases:read`; the Demo split; the exact frame key set.
  `test_round15_wp1_carry.py` stays green.
- **Acceptance.**
  - All probes flipped.
  - No persistent field and no model call.
  - The registry never raises into a run.
- **Depends on.** WP01.

#### WP09. AI run Console and one stream per page (M to L)

- **Goal.** Anyone can see what the AI is doing now, from the queue, the case, the navigation and the
  close dialog.
- **Implements.**
  - ai-investigating: R3 (the narration UI), R6, R7, R9 (generalised into a page multiplexer), R10 and
    R12.
  - the UI parts of case-manager-ux R3, and the Console part of competitors R1.
- **Files.**
  - `lib/useEventStream.ts`, the multiplexer:
    - one EventSource per page, over a reference-counted topic union;
    - when the union changes it reopens with `Last-Event-ID`, fans frames out by topic, and dedupes by
      event id;
    - the hook API is unchanged.
  - The `investigations` client: `lib/api-investigations.ts`.
  - `soc/investigations/**`:
    - `store.ts` (`useSyncExternalStore`, keyed by case id, plus `newRuns` and `slots`);
    - the bodies of the WP01 stubs, and `AiRunPopover.tsx`;
    - a new non-blocking `ReinvestigateDialog.tsx`.
  - The dialogs: `casedetail/ConfirmActionDialog.tsx` (`aiRun` prop) and
    `casedetail/BulkCloseDialog.tsx`.
  - `CaseActivityFeed.tsx`: the "Investigation finished" heading, cleared on the next `router` frame.
  - `NavSidebar.tsx`: the Case Manager item shows the turning glyph and a count, from the `investigations`
    topic. It subscribes only for `cases:read` holders.
- **Contracts.**
  - The ai-investigating 4.6 copy.
  - A 1 s hold-off before showing anything.
  - Reconciliation through the route on mount, reconnect and `overflow`. A client expiry at
    `deadline_at + 60 s`, then a re-read. A 5 s polling fallback while a run is known and the stream is
    not live.
  - Announcements are polite, at most one per step change and one per 10 s.
  - Reduced motion shows a static ring.
  - The close and bulk-close warnings never block the submit.
- **Tests.**
  - The store reducer: frame, finish, expiry, reconcile.
  - The QueueRow accessible name ", AI investigation running, started 40 seconds ago".
  - The chip timer, and the popover per trigger and for the queued state.
  - The dialog alert appears only for status-moving actions, turns into the "finished" note, and leaves
    submit enabled.
  - The bulk count.
  - The multiplexer: N hooks share one EventSource; a union change reopens with `Last-Event-ID`; the
    last unsubscribe closes it.
  - The navigation count.
  - `bundle-first-paint`.
- **Acceptance.**
  - In a browser, Case Manager with a case open on Activity holds one EventSource per tab.
  - The seeded Demo manual Reinvestigate flow works end to end with WP08.
  - The entry delta is reported.
- **Depends on.** WP01. It is live with WP08; tests use fakes until then.

#### WP10. Case numbers explained: backend (M)

- **Goal.** Every case-level number has recorded inputs, and its explanation agrees with it.
- **Implements.**
  - explainability:
    - R2: record the inputs at the three `compute_risk` call sites with `reputation_source`;
      `_risk_calculation` prefers them, with `weight_basis: recorded_at_scoring`, and wording that fixes
      D5;
    - R3: D-API-2, the gate on the DECISION audit row; `_decision_span` reports the recorded decision
      plus `current_policy` and `policy_changed`, which fixes D1, the same defect as data-visibility
      DV-3 and R10;
    - R6 backend: D-API-3, served in `/triage` as `sla`, which fixes D2 together with WP11;
    - R7: `round_half_up` in the `routes_triage` headline and in `displayed_score`;
    - R16: D7, plus the triage route on `execution_prefs`;
    - R10: one Wilson in `engine/stats.py`.
  - data-visibility:
    - R4 backend: span kinds by `actor_type` (`person`, `chat`, `agent`, `system`), a bounded `detail`
      object, exact per-call cost and latency with `cost_basis`;
    - R14: `rows_total`, `truncated`, and a lifetime usage window.
  - competitors R3 backend (the routing total in `explain_forwarding`).
- **Files.**
  - `agents/pipeline.py` (only the call-site and DECISION hunks).
  - `api/routes_triage.py`.
  - The new `engine/sla_reading.py`, which imports `_CaseTimings` and `_sla_priority` read-only.
  - `engine/priority.py`.
  - The new `engine/stats.py`, used by `threshold_tuner.py`, `engine/auto_close_review.py` and
    `agent_improvement.py`.
  - `engine/forwarding.py`.
- **Contracts.**
  - **The DECISION gate.** `tool_input.gate` is `{verdict, confidence, risk_score, class_enabled,
    min_confidence, max_risk_score, objection_window_minutes, escalation_confidence, critical_severity,
    outcome, demo}`. The `result_summary` stays byte-identical. Legacy rows are labelled "re-derived with
    today's policy".
  - **The SLA reading.** `{clock, start_at, anchor (created|acknowledged|status_history), responded_at,
    target_minutes, due_at, elapsed_minutes, state, priority, priority_source}`.
  - **The trace.** A span `detail` holds `tool_input` (16 KB, with a `truncated` flag), `query_text`,
    `tool_output_summary` (8 KB), `prompt_excerpt` (only with `prefs.trace.include_prompts`),
    `result_summary`, `outcome`, `run_id`, `app_version` and `build_sha`.
- **Tests.**
  - The D1 reproduction fails before and passes after; the DV-3 policy-change scenario.
  - The same case through `sla_reading` and `sla_metrics` agrees on breach for response and resolution.
  - Escalate, then read: the resolution clock shows.
  - The contract SLA vectors.
  - Wilson golden vectors are identical at the three old call sites.
  - Person and chat span kinds.
  - A 40 KB tool input comes back truncated; `include_prompts=false` hides the excerpt.
  - 501 audit rows give `truncated`.
  - An investigator prompt snapshot is unchanged.
  - The byte-identity guards stay green.
- **Acceptance.**
  - The risk 81.11 worked example is reproduced from stored inputs.
  - A legacy case reports `not_recorded`.
- **Depends on.** WP01. It merges after WP08 on `pipeline.py`.

#### WP11. The Explain kit and the case explainers: Console (M)

- **Goal.** Hover any number for a one-line formula with real numbers; click for the full arithmetic.
- **Implements.**
  - explainability:
    - R1: the primitive, with a HoverCard (WCAG 1.4.13, Escape), a Popover on click, Enter, Space and
      touch, and "Copy calculation";
    - R2 UI: `RiskExplain`, from `RiskDerivation` extracted out of `StageTimeline`;
    - R3 UI: `DecisionCard` shows the recorded decision and a "policy changed since" note;
      `DecisionExplain` shows the comparison table;
    - R4: D8, both auto-close conditions;
    - R5: the priority, impact, urgency and severity explainers, and D9;
    - R6 client: `caseFacts.slaReading` counts the same human status moves and formats the server
      reading; a "First event" fact from `first_seen_millis` with the per-case MTTD;
    - R7 client: round half up, and band the displayed integer;
    - R10 UI: Wilson formula lines in the review and effectiveness modules, and the D6 Tuning fix;
    - R13: the Cost KPI arithmetic.
  - data-visibility R9 (the precedent line).
  - the case-manager-ux 5.7 small explainers.
  - the competitors R3 sentence ("Why was this investigated?").
- **Files.**
  - `design-system/explain/**`, a separate entry, never the barrel.
  - `lib/explain/**` builders (`risk`, `decision`, `priority`, `severity`, `sla`, `share`,
    `percentile`, `wilson`, `cost`) and `lib/format.ts`.
  - `casedetail/explain/**` (the WP01 stub bodies).
  - The case files `DecisionCard.tsx`, `StageTimeline.tsx`, `SignalProfile.tsx` and `caseFacts.ts`.
  - `components/badges.tsx` and `riskCopy.ts`.
  - The pages `Tuning.tsx` and `Cost.tsx`.
  - `effectiveness/AutoCloseReviewModule.tsx` and the Agent effectiveness quality popover.
- **Tests.**
  - Explain: hover line, click panel, Escape, touch tap, focus return, axe.
  - The builders print the `explain.contract.json` vectors exactly.
  - Risk: the recorded-weight sum equals the score; a legacy mismatch note; a case with no breakdown.
  - Decision: met and not met; NEEDS_HUMAN fixed by code; an analyst close "agrees".
  - The SLA vectors.
  - Tuning shows "not recorded" instead of fabricated counts.
  - The cost lines.
  - First paint has no `explain` module in the entry.
  - Hostile strings render literally.
- **Acceptance.**
  - The explainability section 3 hover line and click panel render exactly for the worked example.
  - Every number in the meta strip and the inspector has a trigger. Row buttons carry the accessible
    name only.
- **Depends on.** WP01, and WP10 for live data (fixtures until then).

#### WP12. Metrics explained (M; backend and Console)

- **Goal.** Dashboard numbers can be cross-checked against the cases behind them.
- **Implements.**
  - explainability:
    - R8: `GET /api/metrics/explain?metric&window` for `mtta`, `mttr`, `dwell`, `mttd`,
      `active_risk_index`, `fp_rate` and `sla_attainment`, with at most 200 samples and object scope
      per row;
    - R9: Analytics MTTR from the lifecycle p50, plus `mttr_by_decider`; the legacy field stays for
      one release;
    - R11: arithmetic lines on the share tiles and on Alert reduction;
    - D10: agreement is `None` when nothing is graded, and each panel names its population.
  - backend-roadmap R2 layer 3: a LIVE tick refreshes `getMetrics` at most once per 30 to 60 s.
  - competitors R5.
- **Files.**
  - Backend: `engine/metrics.py` and `api/routes_metrics.py`.
  - Pages: `pages/Overview.tsx`, `pages/Metrics.tsx`, `NoiseFunnel.tsx`.
  - The KPI drill-down and hover components, and the lifecycle widgets.
- **Tests.**
  - On a seeded population, the explain p50 equals the posture p50 for the window, and the sample count
    equals the stat-block count.
  - Truncation markers; object scope filters samples.
  - `mttr_by_decider` sums to the total.
  - The Analytics MTTR equals the Overview p50.
  - The tile lines show real counts.
  - The LIVE cadence test.
- **Acceptance.** Each Overview KPI opens formula, numerator, denominator, window and a filtered-list
  link. MTTA, MTTR and dwell show p50, p90, mean and count, plus "Show all N".
- **Depends on.** WP01, and WP11's primitive (it can start on the stub API).

#### WP13. Case records reachable: backend (M)

- **Goal.** Every stored case record can be read by the people entitled to it, and only by them.
- **Implements.**
  - data-visibility:
    - R1: `cases:read` on `case_trace`, `case_rationale`, `case_export`, `scans` and
      `scan_notifications`; `metrics:view` on `standup` (Q12); a route-scan test;
    - R2 backend: `GET /api/cases/{id}/events` under `cases:read` and `sources:read` (see Contracts);
    - R3 backend: `GET /api/cases/{id}/usage` under `cost:view`, with pipeline and chat totals and
      `reconciles`; the gateway writes the rate fields;
    - R7 backend: IP indicators also return `providers`, `method` and `errors`;
    - DV-6, the docstring.
- **Files.**
  - `api/routes.py` (only the permission hunks).
  - The new `api/routes_case_events.py` and `api/routes_case_usage.py`.
  - `llm/gateway.py` and `llm/pricing.py`, which expose the rates `cost_for` used without changing
    results.
  - `engine/threat_context.py`, and the IP path of the enrichment dispatch.
- **Contracts.**
  - **The events route** reads through `fetch_by_ids` on the read-only client and keeps only
    `member_event_keys`.
  - **The envelope** is `{available, reason: aged_out | push_source_not_retrievable |
    source_unavailable | null, returned, expected, truncated}`.
  - **Bounds.** A limit of 1 to 200.
  - **Audit.** One coalesced `case.events_viewed` row per viewer per case per 10 minutes.
  - **Usage.** Still exactly one UsageDoc per call (#6).
- **Tests.**
  - The DV-1 probe flips to 403.
  - Every `GET /api/cases/{case_id}/*` has a permission dependency.
  - The events route keeps only member keys, answers `push_source_not_retrievable` and `aged_out`, and
    leaves HTML-looking values as strings.
  - The pipeline total equals `token_cost` on a multi-run case.
  - `cost_for` recomputed from the stored rates equals the stored cost.
  - 403 without `cost:view`.
  - The IP and domain paths both return `providers`.
- **Acceptance.** The security fix needs no Console change.
- **Depends on.** WP01.

#### WP14. Case records reachable: Console (M)

- **Goal.** "All data visible in some way": one click or hover from the case.
- **Implements.** data-visibility:
  - R2 UI: the `CaseEvents` table; a side sheet with Table and JSON tabs, Copy and an NDJSON page
    download; "Open in Logs"; the signal event count links to the table.
  - R3 UI: the `CaseUsageButton` popover, one row per call, the formula with that call's own numbers,
    and a case chat footer.
  - R4 UI: `TraceTimeline` Details, cost-basis labels, People and Chat filters, and AI-only step counts.
  - R5: `FindingsList` "More" and "Cites N events".
  - R6: `CaseHistory` shows status reasons, resolution notes and attach entries, plus a hold-reason fact.
  - R7 UI: provider lines, labelled "Checked when you opened this case" against "At investigation".
  - R8: the full grading record.
  - R11: the `AllFieldsSheet`; `JsonTree` moves to `soc/components/JsonTree.tsx` with search, Copy and
    Download; cost is withheld without `cost:view`.
  - R13 UI: `AwaitingReason` from `/forwarding`.
  - R15: notifications "Show all", and the lifetime retrieval markers.
- **Files.**
  - `casedetail/records/**` (the WP01 stub bodies).
  - `components/TraceTimeline.tsx`.
  - `casedetail/CaseHistory.tsx`, `grading.tsx`, `ThreatContextPanel.tsx`, `WhyPanel.tsx`.
  - `components/audit/JsonTree.tsx`, which moves and is re-exported.
  - The new `lib/api-case-records.ts`.
- **Tests.**
  - The data-visibility Vitest lists.
  - A value `<img onerror>` renders literally.
  - The JSON tab copies the exact record.
  - The finding filter narrows the table.
  - The usage formula numbers and the "estimated" badge.
  - The Agent filter excludes person rows.
- **Acceptance.** Every field data-visibility section 3 marks "Never" or "Partly" has a visible path,
  except the intentional ones. The SPEC carries the checklist.
- **Depends on.** WP01, plus WP13 and WP10 for live data.

#### WP15. Bug-hunt fixes (S to M)

- **Goal.** Fix what the separate bug hunt confirms, plus two known local-model defects.
- **Implements.**
  - The bug-hunt workflow's confirmed findings.
  - oss-ecosystem B1 and R2: normalise one trailing `/v1` and slash in `_make_openai_compatible` and in
    the custom `base_url` branch, keeping the stored URL as typed.
  - oss-ecosystem B3: example URLs in `Models.tsx` that are correct inside Compose
    (`host.docker.internal`).
- **Routing.**
  - A finding in a file another WP owns goes to that WP while it is open, and to WP15 after it merges.
  - WP15 otherwise edits only files nobody owns.
  - Each fix ships with one regression test that fails before the fix.
- **Tests.** An httpx `MockTransport` records `request.url.path` for `http://h/v1`, `http://h/v1/`,
  `http://h` and `http://h/openai/v1`, for both `complete` and `embed`. A gateway-level test checks that
  a custom model with a `/v1` URL produces one completion and one $0 UsageDoc.
- **Depends on.** The bug-hunt report.

### Wave 2

#### WP16. Integration, entry budget and cross-cutting review (M)

- **Goal.** One tree in which the four operator flows work together, inside every budget.
- **Mounts.**
  - Swap the inline Reinvestigate dialog in `CaseDetail.tsx` for WP09's dialog.
  - Wire the leftovers: the hold-reason fact in the inspector, the events link on the signal count, and
    the trace People and Chat filters in `InvestigationPanel`.
- **Regeneration.** Regenerate every generated file on the merged tree.
- **Budget.**
  - Measure the entry chunk and set `PRE_REVAMP_ENTRY_BYTES` to the merged measurement (the Round 15
    ratchet practice).
  - Assert that `motion`, the Explain kit, the What's new page and the notes JSON are off the entry
    path.
- **Records.** Consolidate `ui-standard.md`.
- **Review.** Run the full gates, then a cross-cutting adversarial review of the integrated tree (the
  Round 15 practice).
- **Browser checks (Playwright 1.63, Chromium at `/opt/pw-browsers`, seeded Demo):**
  - the Case Manager geometry;
  - one EventSource per tab;
  - no timers on the sign-in page after paint;
  - What's new on first sign-in only;
  - the AI chip across a full Reinvestigate;
  - the risk popover numbers.
- **Acceptance.** All gates green, the entry inside the ratcheted budget, and zero unexplained console
  errors.

### Wave 3

#### WP17. Screenshots and What's new content (M)

- **Goal.** The release tracker is documented and screenshotted.
- **Notes content.** Fill `docs/releases/notes/0.1.13.json` from the whats-new section 6 backfill
  table:
  - dated updates from 2026-08-05 to the release date, newest first;
  - each one titled by user-visible change, never "Round";
  - the 0.1.1 entry;
  - the earlier records group.
- **Capture.** Light and dark, from seeded Demo only, at 1440x900 and DPR 2. WebP at most 250 KB with
  explicit dimensions and alt text.
- **Docs screenshots.** Also refresh the Case Manager, sign-in and What's new screenshots for the docs.
- **Acceptance.**
  - The generator passes.
  - An upgraded account sees the Round 16 update.
  - The page renders every release.

#### WP18. Records and docs (M)

- **Goal.** Every record says what shipped.
- **Changelog and Help Center.**
  - The CHANGELOG `[Unreleased]` Round 16 section, from the WP reports.
  - The Help Center pages for the Case Manager, sign-in, What's new, the AI indicator and explainable
    numbers.
- **Repository records.**
  - `docs/USAGE.md`.
  - AGENTS.md section 10: a Round 16 bullet, the baseline, the Communication group, and a new process
    rule: "every update that reaches users adds a What's new entry with screenshots, enforced by
    `check_version.py`".
  - `ROADMAP.md` (section 9 of this report), `HANDOFF.md`, `Journal.md`.
  - `docs/research/2026-11-round16/SPEC.md` "As built".
- **Testing and generated records.**
  - The `testing.md` browser matrix rows (release section 5.3).
  - The regenerated knowledge corpus.

#### WP19. Frozen release preparation and acceptance (M; release track, section 8)

- **Goal.** A candidate that becomes installable only after canonical runtime acceptance passes.
- **Records.** CHANGELOG release section and a fresh `[Unreleased]`, `docs/releases/V.md`, and the
  other files of release section 5.
- **Migration and rollback evidence.**
  - Measure the `audit.id` widening (release B4), and raise `--backend-timeout` if needed.
  - Document the large-table pre-step.
  - Rehearse the v0.1.1 rollback (B5) and record the result in `known-limitations.md`.
- **Receipts.** The local gates of release section 5.4, and the browser receipt of section 6.

## 7. Build order and parallelism

```
Wave 0 (now):      WP01 ──┐   WP02   WP03 (L, critical)   WP04   WP05   WP06   WP07 (scripts and page first)
                          │     │       │                                        │
                          ▼     ▼       ▼                                        ▼
Wave 1 (WP01 in):  WP08 → WP10 (pipeline.py order)   WP09   WP11 → WP12   WP13 → WP14   WP15 (bug report)
                          │
Wave 2:            WP16 integration (needs WP02, WP03, WP08 to WP14 merged)
Wave 3:            WP17 shots and notes   WP18 records   →   WP19 release prep (release track)
```

- WP02, WP03 and WP07 begin with structural work and rebase onto WP01 as soon as it merges, then mount
  the stubs.
- Merge order inside the round branch:
  1. WP01;
  2. WP05, WP04 and WP06 (independent);
  3. WP08 then WP10 (shared `pipeline.py`);
  4. WP13 (`routes.py` permission hunks), then WP08's `routes.py` hunks, in either order;
  5. WP02, then WP03;
  6. WP09, WP11, WP12, WP14, WP07, WP15;
  7. WP16.
- WP16 cannot start until WP03 lands; WP03 is the longest package and should start first.

## 8. Release track (owners: [A] agent, [M] maintainer on GitHub, [H] maintainer on a Docker host)

Condensed from release section 4; that report holds the commands.

1. **Decisions before the SPEC freezes.**
   - [M] Version V (Q1).
   - [M] Repository identity (Q2).
   - [M] License (Q3).
   - [M] Default branch (Q4).
2. **Bring Testing in line.**
   - [A] The Dependabot forward-port PR into Testing (release B7).
   - [A] The Round 16 PR, WP01 to WP18, into Testing, with `CI passed` green.
3. **PostgreSQL evidence** (the sandbox cannot pull images; Ubuntu `postgresql-16` and
   `postgresql-16-pgvector` packages are an untried fallback).
   - [H or A] The `audit.id` widening timings at 1, 5 and 10 million rows.
   - [H or A] The v0.1.1 rollback rehearsal with `scripts/rollback_lane.py --previous-release
     ba179651a7b63d6352ad346fd633e1460f3a4d39`.
4. **Freeze and accept.**
   - [A] WP19, the frozen prep PR.
   - [A] The browser receipt on the exact stamped build.
   - [H] Shipping-image acceptance.
   - [A] A journal-only PR. The resulting commit is the accepted candidate T'.
5. **Dress rehearsal** (strongly recommended after seven failed or blocked tags). [M, H] Tag, release,
   docs and a v0.1.1 bootstrap in a disposable test repository.
6. **Promotion.**
   - [M] Tree-replacement promotion of T' to `main`; the trees must be equal.
   - [A] A Stable rebuild and the full matrix on `main`.
7. **Immutable tag.**
   - [M] Verify the environments, push the annotated `vV`, and watch the three workflows.
   - [M] Make the three new GHCR packages Public when the anonymous-read step pauses (B2; irreversible).
   - [M] Verify signatures under the new identity.
8. **Canonical acceptance.**
   - [H] Bootstrap from v0.1.1 on PostgreSQL Compose, with `AGENTIC_SOC_UPDATE_REPOSITORY` set first.
     Only then is vV installable.
   - [A] Record it, and bump `scripts/rollback_previous_release.json`.

## 9. Next rounds backlog (ranked by value for a free agentic SOC)

| Rank | Item | Value | Effort | Source |
|---|---|---|---|---|
| 1 | A license file and packaging metadata (owner decision; without it the code cannot legally be used or shared) | high | S | oss R1, competitors R7, release B9 |
| 2 | A free local-model path from install to the first verdict | high | M | oss R3, backend-roadmap R15 and BG7 |
| 3 | One-command install, `doctor`, measured resource figures, a lite SQLite profile, a container demo and a devcontainer | high | M | oss R5, R15 |
| 4 | Source presets for the free stacks (Elastic Security alerts, Security Onion, OpenSearch Security Analytics, Graylog, Wazuh push, Suricata EVE, Zeek, osquery), the Wazuh Integrator push script, an inverted severity ladder, and a "free SOC stack in an afternoon" guide | high | M | oss R6, R10 |
| 5 | Restart-safe per-source secrets: document and forward `CONNECTOR_SECRETS` with a missing-secret banner, then opt-in sealed KV persistence after a security review | high | S then M | oss R4 and B2 |
| 6 | No-loss push: answer HTTP push before investigating, then a durable push receipt with a dead-letter ring | high | M then L | backend-roadmap R10, R11 |
| 7 | Teach the agent from a close: pending, scoped, expiring memory with origin case and usage counts, plus per-step and per-summary feedback | high | M | competitors R8, R9 |
| 8 | Offline threat intel: MISP warninglists, public MISP feeds, TAXII 2.1 and OpenCTI, and a MISP server, into a bounded KV IOC store | high | M to L | oss R7 |
| 9 | Hand-off to DFIR-IRIS (and TheHive), plus a STIX 2.1 case export | high | M | oss R8 |
| 10 | Ask AI beside the evidence: case chat in the inspector, which brings the tabs back to five | medium to high | M to L | case-manager-ux R6 |
| 11 | Sigma: metadata import with DRL attribution, then a matcher, with a precompiled rule catalog first | medium to high | M then L | oss R9, backend-roadmap R14, R6 |
| 12 | Approval-gated response actions and a per-case Resolution Center, with a separate write credential and never model-driven | high | L | competitors R11 |
| 13 | A read-only MCP server and scoped, revocable API keys (resolve the `ROADMAP.md` C versus G contradiction first) | medium to high | L | competitors R12, oss R14, backend-roadmap R19 |
| 14 | New pull connectors: Splunk, then Microsoft Graph `alerts_v2`, then CrowdStrike | high for adoption | M each | backend-roadmap R13 |
| 15 | SQL queue projection and filter push-down (0.65 to 2.5 s per filtered view at 20,000 cases today) | medium to high | M | backend-roadmap R3 |
| 16 | A global pause and resume of AI investigations; autonomy per rule with an optional settle delay | medium | S to M | competitors R10, R15 |
| 17 | Field anonymization before the model, with a reversible per-investigation map | high for regulated users | M to L | competitors R14 |
| 18 | A push-source evidence snapshot in KV, bounded and with a retention setting | medium | L | data-visibility R12 |
| 19 | Observability export (Prometheus text, JSON logs, optional OTEL) and a one-command backup and restore | medium to high | S to M each | backend-roadmap R16, R17 |
| 20 | An attack storyline on campaigns; CVE context (CISA KEV, EPSS); a model leaderboard from replay; scheduled digests and ticketing; a PDF case report | medium | M each (PDF S) | competitors R13, R16, R17, R18, oss R11 |
| 21 | Community runbook packs, a Cortex bridge provider, passkeys, admin announcements in Communication | medium | M to L | oss R12, R13, login R16, whats-new R12 |
| 22 | Platform depth: versioned SQL migrations, a multi-replica leader lease, cross-process signature claims, SBOM attestation | medium now, high at scale | M to L | backend-roadmap R12, R18, release R16 |
| 23 | Decide whether people with `sources:read` see real member event ids in the clustering diagram (reverses an earlier #9 decision) | low | S | data-visibility R16 |
| 24 | Explainability follow-ups: Standup urgency terms, campaign entity links, the anomaly detection signal on anomaly-born cases | low to medium | M | explainability R15 |

What not to copy (competitors section 5):

- model-written lessons placed in trusted context;
- autonomous response by default;
- browser recording of analysts;
- vendor-style headline accuracy figures;
- per-alert pricing logic.

## 10. Open questions for the operator

1. **Version number.**
   - The ask says this is the next release. The task text says 0.1.13, but the project's
     `docs/releases/channels.md` rule makes this content a MINOR, 0.2.0 (release B6).
   - Recommendation: keep **0.1.13** with a dated exception recorded in `channels.md` and the release
     page. It is what was asked, `VERSION` already says it, and 0.2.0 adds an M-sized package (about
     115 files, a `/docs/0.2/` line with redirects, plan range defaults).
   - Choose 0.2.0 if strict policy matters more than churn.
2. **Repository identity.** Adopt `ARYDESTROYER/Kavach-AgenticSOC` as the update trust root (Option A,
   recommended; WP05 implements it), or rename the repository back (Option B, S, with the README and
   INSTALL clone URLs reverted). Without one of the two, the next tag will fail canonical bootstrap.
3. **License.** Apache-2.0, for adoption and the patent grant, or AGPL-3.0, which keeps hosted forks
   open. Only the owner can choose. "Free for the world" is not legally true until a `LICENSE` exists.
4. **Default branch.** GitHub reports `Testing` while `channels.md` and `INSTALL.md` say `main`. Set it
   back to `main`, or correct the documents.
5. **The Communication group.** Replace the "Notifications" group label with "Communication", holding
   Inbox and What's new (recommended; the top-bar bell keeps the name "Notifications"), or add a
   separate group.
6. **Remember me.**
   - The row will say only "Remember me". Should the warning dialog, shown once after a deliberate
     click, keep stating the duration and the inactivity limit? Recommended: yes; it is the disclosure
     Round 14 D3 required.
   - Should the row be hidden when an administrator has turned it off? Recommended: keep it disabled
     with its reason.
7. **What's new eligibility.**
   - Show the welcome once to every account, including brand-new ones (simplest)? Or suppress it for
     fresh installs and new accounts, which needs the small `release_history` KV document (whats-new
     R5)?
   - Keep the acknowledgement as an audited preference change? Recommended: yes, consistent with
     `dismissed_intros`.
8. **Case tabs.**
   - Accept six tabs for this round, with Chat last, and Alt+2 and Alt+4 changing meaning (announced in
     What's new)? Moving Chat into the inspector next round brings it back to five.
   - Or do the inspector chat now, adding M to L to the critical path.
9. **The sign-in identity contract.** Approve replacing the recorded "Identity surfaces" and "Identity
   accents" design, and retiring `gate-login-accents` as subject removal, with replacement contrast
   pairs.
10. **A close during a run.** The AI result stays authoritative, as asked; the Console warns and the
    person is notified. Two details need confirmation:
    - Skip an automatic drain when a person closed the candidate before the run started (recommended)?
    - Show the requester's name to others, or only "You started it" (recommended)?
11. **Release-time actions only the maintainer can take.**
    - Make the three GHCR packages Public. This is irreversible.
    - Run the dress rehearsal in a disposable repository.
    - Run the PostgreSQL timing and the v0.1.1 rollback rehearsal on a Docker host.
    - Authorize the Dependabot forward-port PR and the promotion.
12. **Standup permission.** Gate `/api/standup` with `metrics:view` (recommended) or `cases:read`.
13. **The cut line.** Confirm the section 3 order if capacity runs short.

## 11. Risks across the round

- **Test churn in the Case Manager.** About 20 suites assert ids and structure. Plan a dedicated test
  pass in WP03; never weaken an assertion except where its subject is removed.
- **The spine.** The registry wrapper and the case lock sit in `pipeline.py`. Every new keyword has a
  default, the registry never raises, and the lock is taken only inside the signature lock.
- **The realtime client.** The multiplexer changes the transport of every live page. Gate it with fake
  EventSource tests and a browser connection count before merging.
- **Entry budget contention.** Three packages add entry bytes, and WP04 removes about 7 KB. WP16 owns the
  final measurement and the ratchet.
- **Behaviour changes users will notice.** These go in CHANGELOG and What's new:
  - Reinvestigate now updates a closed case in place;
  - Alt+2 and Alt+4 change meaning;
  - risk banding at exact .5 boundaries can move one band (round half up);
  - the Analytics MTTR changes definition;
  - three routes now return 403 to a denied role.
- **The Decision card.** It stops presenting a read-time re-run as the recorded decision. Older cases
  show "thresholds not recorded".
- **Release identity.** Hosts whose `.env` keeps the old repository fail closed. That is correct, but it
  adds support load, so it needs one prominent upgrade step.
- **Scope creep inside the freeze.** Code freezes before WP19. Every later fix restarts the receipt.
- **Screenshots.** Captured from seeded Demo only, with synthetic values.
- **Single replica.** The registry, the gate and the SSE bus remain process-local, and the route says
  `process_local: true`.

## Appendix A. Traceability (research recommendation to work package)

| Report | In Round 16 | Backlog or later |
|---|---|---|
| ai-investigating | R1 to R5, R8, R11 (WP08); R3 UI, R6, R7, R9, R10, R12 (WP09); R13 stretch | R14 (cross-replica lease), R15 (stop a run) |
| case-manager-ux | R1 (WP02, WP03); R3 UI parts (WP09, strip replaced by chip); R2 explainers (WP11); R4, R5, R8 (WP03); R7 (WP02) | R6 (Ask AI in the inspector) |
| explainability | R1 to R7, R10, R16 (WP10, WP11); R8, R9, R11 (WP12); R12 (WP14 `AllFieldsSheet`); R13 (WP11); R14 partly (rates in WP13) | R15 |
| data-visibility | R1, R2, R3, R7 backend (WP13); R2 to R8, R11, R13, R15 UI (WP14); R4 backend, R10, R14 (WP10) | R12, R16 |
| login | R1 to R12, R14 (WP04); R15 optional | R16 (passkeys) |
| whats-new | R1 to R4, R6, R8, R9 (WP07); R5 per Q7; R7 (WP17); R10 (WP05); R11 optional | R12 (announcements) |
| release | R1, R7, R11, R14, R15, R17 (WP05); R2 to R6, R10, R12 (WP19 and the release track); R8, R9 maintainer; R13 replaced by the whats-new design | R16 (SBOM) |
| backend-roadmap | R1, R2 layer 1, R4, R5 (WP06); R2 layer 3 (WP12); R7 (WP08); R8 (WP01, WP10); R9 superseded (WP07) | R3 (stretch), R6, R10 to R19 |
| competitors | R1 (WP08, WP09); R2 (WP01, WP10, WP11); R3 (WP10, WP11, WP14); R4 (WP03); R5 (WP12); R6 (WP07); R7 owner decision | R8 to R18 |
| oss-ecosystem | R2 and B1, B3 (WP15); R1 owner decision | R3 to R15 |
