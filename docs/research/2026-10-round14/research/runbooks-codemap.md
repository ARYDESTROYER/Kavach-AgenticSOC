# Round 14, ask 9: playbooks and runbooks, codebase map

Research brief for the operator ask: "Can we please merge playbooks and runbooks pls, too
complicated, just remove both and redo runbooks from scratch ... per the best cybersecurity
and how others do it standards."

Scope of this brief: everything in the repository that implements or depends on
Playbooks or Runbooks today, how each reaches the model and under which trust level,
what removing both would break, and how to carry stored operator content forward. It is
a code map, not the industry study (that is a separate brief). Every code claim cites
`file:line` at commit `c00deef` (branch `claude/round12`, fresh from `Testing`).

Screenshots of today's surfaces (shared demo, 1440x900, light) are listed in section 12.

---

## 0. Summary

1. **Two features cover the same ground with two engines, two dialects, two stores, two
   permission resources and two Console pages.** The 9 bundled Playbooks and the 9
   bundled Runbooks describe the same detection families (brute force, cloud identity,
   data exfiltration, web attack, scanning, mail, outbound/C2, malware, ransomware). The
   operator sees "Reference runbooks" and "Response playbooks" as sibling nav items
   under Intelligence, each with its own editor, validator and vocabulary
   (`webui/src/soc/registry.tsx:301-345`).
2. **The real difference is the delivery path, not the content.**
   - A Playbook is **selected deterministically per cluster** (exact rule id, entity
     type, minimum event count, then priority/version/id) and its body is **injected
     whole** into the investigator prompt as a TRUSTED `<<<PLAYBOOK>>>` block, plus its
     `rag_queries` are added as extra retrieval queries
     (`backend/app/playbooks/registry.py:180-256`, `backend/app/agents/prompts.py:479-494`,
     `backend/app/agents/graph.py:160-168`).
   - A Runbook is **never selected**. It is chunked into the RAG corpus (source
     `runbook`) and only reaches the model if vector/BM25 retrieval happens to rank it,
     rendered as a TRUSTED line under "Retrieved knowledge"
     (`backend/app/engine/runbooks.py:185-237`, `backend/app/tools/rag.py:596`,
     `backend/app/agents/prompts.py:571-590`). It is also visible to Workspace chat
     through `search_knowledge` (`backend/app/agents/chat_tools/intel.py:427-520`).
3. **Both are TRUSTED and both are advisory only.** Neither can reach
   `case_manager.decide()`; the playbook block is explicitly ranked below the
   deterministic policy in the investigator system prompt
   (`backend/app/agents/prompts.py:656-662`). Non-negotiable #3 is not at stake in a
   merge, but #9 (trust boundary), #2 (audit), #6 (cost of a "run"), #10 (defaults) and
   #12 (cold-deployable, no migration) are.
4. **Real defects found while mapping** (detail in section 8): three bundled Playbooks
   exceed the 2,400-character prompt budget and are silently truncated before the model
   sees their final section; `suggested_tools` and `llm_select` never reach any model or
   code path; "Run a playbook" in Demo Mode re-investigates without the playbook (the
   demo pipeline has no registry) while the toast says it was applied; a fresh "Create
   runbook" sheet opens with "17 fixes" outstanding; the Help Center says operator
   playbooks live in a directory when they actually live in the KV store.
5. **Blast radius is wide but shallow.** About 3,600 lines of backend core
   (`playbooks/`, `stores/playbooks.py`, `stores/runbooks.py`, `engine/runbooks.py`,
   `engine/runbook_service.py`, `api/routes_runbooks.py`), roughly 300 lines of
   playbook routes in `api/routes.py`, about 3,800 lines of dedicated Console code
   (`Catalog.tsx` 1,415 of which roughly half is playbooks, `Runbooks.tsx` 1,581,
   `runbookAuthoring.ts` 624, `runbookExamples.ts` 42, `Intelligence.tsx` 100) plus
   touches in about 20 other Console files, 16 HTTP operations on 11 paths, 2 KV namespaces, 2
   RBAC resources, 1 Job kind, 1 automation action, 1 Case field, 1 metrics series, 1
   export group pair, 2 chat-tool kinds, about 40 backend and 54 Console test files, and
   about 40 documentation pages.
6. **Recommended migration for stored operator content: convert forward, keep the
   originals read-only for one release, and include both in export.** Operator data is
   bounded (at most 100 playbooks in 2 MiB and 100 runbooks in 8 MiB,
   `backend/app/stores/playbooks.py:20-21`, `backend/app/stores/runbooks.py:21-22`), so a
   one-shot, idempotent, audited conversion is cheap; keeping the legacy KV documents
   untouched gives a rollback path without a schema migration (#12). Several wire
   identifiers must stay accepted as aliases (section 10.3).

---

## 1. Today's two concepts side by side

| Aspect | Playbook | Runbook |
|---|---|---|
| Stated purpose | "Operator procedures selected deterministically to guide an investigation" (`webui/src/soc/pages/Intelligence.tsx:53-57`) | "Trusted investigation guidance retrieved as reference knowledge; never executable authority" (`webui/src/soc/pages/Intelligence.tsx:43-47`) |
| Format | YAML-ish front matter (`id, name, version, description, match{rule_ids, entity_types, mitre, min_event_count, any_tags}, priority, suggested_tools, rag_queries, escalate_if, suggested_verdict_bias`) + free Markdown body (headings, bold, lists allowed) (`backend/app/playbooks/manifest.py:32-79`, `backend/playbooks/brute_force_login.md`) | Front matter (`id, title, summary, applies_to_rules, applies_to_entities, keywords`, optional `persona, applies_to_techniques`) + **plain text only** body with 7 fixed labels (SIGNAL, EVIDENCE REQUIRED, INVESTIGATION STEPS, TRUE POSITIVE SIGNALS, FALSE POSITIVE SIGNALS, NEEDS HUMAN WHEN, RECOMMENDED NEXT ACTION, optional LIMITATIONS); Markdown is rejected (`backend/app/engine/runbooks.py:63-81`, `:358-404`) |
| Shared parser | `parse_playbook` reuses `engine.runbooks.parse_frontmatter` (`backend/app/playbooks/loader.py:16`) | `parse_frontmatter` (`backend/app/engine/runbooks.py:257-295`) |
| Size limits | 256 KiB document, **2,400-char prompt budget** for name+body+advisory (`backend/app/playbooks/registry.py:50`, `backend/app/playbooks/manifest.py:28`) | 128 KiB document, **1,800-char body**, 1,200-char retrieval descriptor, title 120, summary 280, 12 list items of 64 chars (`backend/app/engine/runbooks.py:46-62`) |
| Bundled content | 9 files in `backend/playbooks/` (listed in `backend/app/playbooks/registry.py:36-48`), plus a 12 KB README | 9 files in `backend/app/runbooks/`, plus 6 in-code fallback snippets `SEED_RUNBOOKS` (`backend/app/tools/rag.py:788-846`) |
| Operator storage | KV namespace `playbooks`, key `documents`, one JSON doc `{documents: {id: {content, revision, created_at/by, updated_at/by}}}`; max 100 docs, 2 MiB aggregate (`backend/app/constants.py:55-60`, `backend/app/stores/playbooks.py:20-207`) | KV namespace `runbooks`, key `documents`, `{documents: {id: {content, revision, created/updated, index_status, indexed_revision, last_indexed_at, index_error}}, pending_deletes: [...]}`; max 100 docs, 8 MiB (`backend/app/constants.py:48-53`, `backend/app/stores/runbooks.py:21-318`) |
| Legacy file mode | `Preferences.playbooks.dir` override switches to a writable directory registry (atomic temp-file replace) (`backend/app/state.py:1303-1342`, `backend/app/playbooks/registry.py:369-427`) | None |
| CAS / concurrency | `kv_mutate_strict` + optional `expected_revision` on PUT (`backend/app/stores/playbooks.py:117-132`, `backend/app/api/routes.py:2698-2702`) | `kv_mutate_strict` + mandatory `expected_revision` on PUT and DELETE (`backend/app/engine/runbook_service.py:193-243`) |
| Delete | **No delete API** for playbooks | `DELETE /api/runbooks/{id}` with tombstone `pending_deletes` until the RAG projection is cleaned (`backend/app/stores/runbooks.py:272-318`) |
| Hot reload | In-memory snapshot, validate-then-swap, refreshed on every list/read (`backend/app/playbooks/durable.py:65-126`, `backend/app/state.py:2571-2578`) | No cache for operator layer; bundled files cached once (`backend/app/engine/runbooks.py:1368-1400`); RAG projection reindexed per id or as a Job |
| Bundled vs operator id clash | Bundled wins; operator row reported as `shadowed_by_bundled` (`backend/app/playbooks/durable.py:65-117`) | Bundled wins; operator row ignored with a warning (`backend/app/engine/runbook_service.py:126-167`) |
| How it reaches the model | Selected per cluster, body injected as `<<<PLAYBOOK>>>` TRUSTED block in the strong investigator only; `rag_queries` added as retrieval groups | Only via RAG retrieval (investigator) or `search_knowledge` (chat); rendered as TRUSTED reference line |
| Manual trigger | "Run a playbook" on a case: synchronous `POST /api/cases/{id}/run-playbook` re-investigation with `force_playbook_id` (`backend/app/api/routes.py:6838-6888`) | None (no per-case use) |
| Automation | `CaseAutomationRule.action = "run_playbook"` with `payload.playbook_id` queues a detached forced re-investigation (`backend/app/config.py:1388-1411`, `backend/app/state.py:1143-1162`, `backend/app/engine/threshold_automation.py:295-298`) | None |
| Case record | `Case.playbook_id` (`backend/app/models.py:1726-1728`) | `Case.knowledge_used[]` entries whose source is `runbook` |
| Permissions | `playbooks:read`, `playbooks:run`, `playbooks:manage` | `runbooks:read`, `runbooks:manage` |
| Console page | Intelligence, Response playbooks (`Catalog.tsx`), plus coverage, dry run, worker health | Intelligence, Reference runbooks (`Runbooks.tsx`), plus authoring standard, examples, reindex |
| Metrics | `playbook_usage` counter by `Case.playbook_id` (`backend/app/engine/metrics.py:289`, `:351`) | Knowledge reference coverage (shared with all retrieval) |

---

## 2. How each reaches the model, and at which trust level (#9)

### 2.1 Playbook path (automated investigation)

1. `InvestigationPipeline` holds `self._playbooks` (`backend/app/agents/pipeline.py:119`, `:144`),
   wired from `AppState` (`backend/app/state.py:1026-1028`).
2. Per cluster, after enrichment: if `force_playbook_id` is set it is looked up,
   otherwise if `prefs.playbooks.enabled` the registry selects
   (`backend/app/agents/pipeline.py:652-671`).
3. Selection is pure (`backend/app/playbooks/registry.py:180-256`): hard criteria are
   `rule_ids` (exact match after trimming against `cluster.rule_values` plus
   `primary_rule()`), `entity_types`, `min_event_count`; `mitre` and `any_tags` are
   soft signals that can only match against rule names because clusters carry no MITRE
   or tags before investigation (`:221-245`). Ties: priority desc, version desc, id asc.
4. The choice is audited as a `DECISION` row by actor `playbook_selector` with
   `tool_input.playbook_selection` and `persona_selection`
   (`backend/app/agents/pipeline.py:673-697`). A live `agent.step` frame carries the
   `playbook_id` (`:698-702`).
5. Only the **strong investigator** path consumes it. The cheap router never sees a
   playbook or RAG (`backend/app/agents/router.py:53-61`). On the router benign
   shortcut, kill switch or timeout the playbook is "selected only", never consulted
   (`backend/app/agents/graph.py:127-137`, `backend/app/agents/pipeline.py:717-737`).
6. Retrieval: the cluster query plus each `rag_queries` entry become query groups
   `cluster`, `playbook:1..n`, interleaved so the base query cannot starve the playbook
   queries (`backend/app/agents/graph.py:160-200`).
7. Prompt: `render_playbook_prompt` builds `name (vN) + body + advisory escalate_if /
   suggested_verdict_bias` (`backend/app/playbooks/manifest.py:99-117`); the
   investigator passes it to `render_cluster` (`backend/app/agents/investigator.py:145-160`),
   which emits it **unfenced** inside `<<<PLAYBOOK>>> ... <<<END_PLAYBOOK>>>` under the
   heading "Active playbook (TRUSTED operator procedure ...)", truncated to 2,400 chars
   (`backend/app/agents/prompts.py:479-494`).
8. System prompt precedence: deterministic policy > base role rules > playbook >
   operator MEMORY > untrusted evidence (`backend/app/agents/prompts.py:656-662`).
9. Provenance: a `CONTEXT` audit row by actor `procedure_provenance` records selected
   versus consulted (`backend/app/agents/pipeline.py:838-879`); `Case.playbook_id` is
   assembled (`:891`); the investigator audit also records `playbook_detail`
   (`backend/app/agents/investigator.py:172-191`).

### 2.2 Runbook path (retrieval only)

1. `RagService(runbooks=RunbookService)` (`backend/app/state.py:2701-2729`).
2. Seeding: when `rag.use_runbooks` and `runbooks.enabled`, the merged bundled+operator
   catalog is chunked into documents `runbook:<id>:<n>`, source `runbook`, metadata
   `trust_class` `bundled_runbook` or `operator_runbook`; if loading fails the 6 in-code
   `SEED_RUNBOOKS` are used (`backend/app/tools/rag.py:1273-1291`,
   `backend/app/engine/runbooks.py:185-237`). Each chunk is prefixed with a descriptor
   (title, summary, keywords, rules, MITRE, entities) and embedded on that descriptor
   only.
3. The investigator renders retrieved chunks under "Retrieved knowledge"; a chunk is
   TRUSTED (unfenced, truncated to 400 chars) only if its source is in
   `TRUSTED_KNOWLEDGE_SOURCES = {"runbook", "mitre", "suppression"}`
   (`backend/app/tools/rag.py:596-604`, `backend/app/agents/prompts.py:571-590`).
   **Operator runbooks share source `runbook`, so they are TRUSTED exactly like bundled
   ones**; the `trust_class` metadata distinguishes them but nothing renders
   differently.
4. Reserved source labels stop an import from claiming `runbook`
   (`backend/app/tools/rag.py:658-676`).
5. Workspace chat: `search_knowledge` returns runbook chunks as `TRUSTED K<n>` lines
   (`backend/app/agents/chat.py:178-195`, `:1096-1116`, `:3900`), and can list the
   catalogs (`kind=list_runbooks|list_playbooks`, gated by `runbooks:read` /
   `playbooks:read`) (`backend/app/agents/chat_tools/intel.py:427-700`).

### 2.3 Trust summary

| Content | Rendered | Fence | Who can author |
|---|---|---|---|
| Bundled playbook body | TRUSTED instruction context | `<<<PLAYBOOK>>>` markers, not fenced | Release |
| Operator playbook body | TRUSTED instruction context | same | `playbooks:manage` (super_admin, soc_manager) |
| Bundled runbook chunk | TRUSTED reference line | none | Release |
| Operator runbook chunk | TRUSTED reference line | none | `runbooks:manage` (super_admin, soc_manager) |
| Imported RAG doc, resolved case precedent | UNTRUSTED | `fence()` | `rag:manage` / pipeline |

The marker normaliser neutralises **any** `<<<NAME>>>` shaped token in untrusted text, so
a new fence name (for example `RUNBOOK`) is covered on day one
(`backend/app/agents/prompts.py:66-127`). The historical neutral tag for `PLAYBOOK` is
`<pb>` (`:117`) and is pinned by tests (`backend/tests/test_marker_normaliser.py:122-195`).
The chat protocol also recognises `end_playbook` as a forged-marker token
(`backend/app/agents/chat_protocol.py:1635`).

---

## 3. Backend map, file by file

### 3.1 Playbook engine (`backend/app/playbooks/`)

- `__init__.py` re-exports the public API (`:1-25`).
- `manifest.py`: `PlaybookMatch`, `PlaybookManifest` (slug id, `extra="ignore"`),
  `Playbook` dataclass, `MAX_PLAYBOOK_PROMPT_CHARS = 2400`, `render_playbook_prompt`
  (`:28`, `:32-117`).
- `loader.py`: `parse_playbook` (flat or nested `match`, never raises, logs unknown
  keys), `load_playbooks(dir)` skipping README/index (`:60-156`).
- `registry.py`: `DEFAULT_BUNDLED_PLAYBOOK_FILES` (9), `MAX_PLAYBOOK_BYTES` 256 KiB,
  errors, `diagnose_playbook` and `selection_diagnostics` for dry run/coverage,
  `select_playbook`, file-backed `PlaybookRegistry` with atomic create/update/rollback
  and path containment, and `run()` which forces a playbook into
  `pipeline.investigate_cluster` (`:36-565`).
- `durable.py`: `DurablePlaybookRegistry` merges bundled files with the KV operator
  layer, tracks shadowed ids, `refresh()`, `create_durable`, `update_durable`
  (`:28-233`). No delete.

### 3.2 Runbook engine

- `backend/app/engine/runbooks.py` (1,413 lines): constants, validation issue types,
  `Runbook` dataclass with `retrieval_descriptor`, `embedding_descriptor`,
  `as_corpus_items`; `parse_frontmatter` (shared with playbooks); the strict authoring
  standard (Markdown detection regexes `:423-446`, body structure `:770-940`,
  `_collect_submission_issues` `:941`); `runbook_authoring_standard()` contract served to
  the Console (`:358-404`); `parse_runbook_document` with legacy wide limits for
  already-stored rows (`:1291-1365`); `load_runbooks` cache, `corpus_items`. Comment at
  `:1411-1413` records that per-cluster selection moved to playbooks ("there is no
  `select_runbook` anymore").
- `backend/app/engine/runbook_service.py`: `ManagedRunbook.payload()` (index status
  fields), `RunbookService.list/get/create/update/delete/corpus_items/mark_indexed/
  pending_deletes/mark_delete_projected` (`:39-266`).
- `backend/app/stores/runbooks.py`: strict KV store with tombstones and index state
  (`:21-318`).
- `backend/app/runbooks/*.md`: 9 bundled runbooks (body 1,195 to 1,575 chars).

### 3.3 Wiring (`backend/app/state.py`)

- Build: `self.playbooks = self._build_playbooks()` and
  `self.runbooks = self._build_runbooks()` (`:982-988`); pipeline gets
  `playbooks=self.playbooks` (`:1026-1028`); RAG gets `runbooks=self.runbooks`
  (`:2701-2729`).
- Registry choice: packaged default dir uses `DurablePlaybookRegistry`; an override dir
  uses the legacy file registry (`:1303-1342`).
- Reload/refresh/create/update helpers (`:2547-2613`); startup rebuild and durable
  refresh (`:2821-2827`).
- Automation callback `_automation_queue_playbook` launches a detached forced
  re-investigation task (`:1143-1162`), passed as `queue_playbook_run` (`:1087`).
- Chat tool context exposes `runbooks` and `playbooks` (`:845-846`).

### 3.4 Configuration, constants, models

- `PlaybookConfig {enabled=True, dir=None, llm_select=False}` (`backend/app/config.py:730-741`).
- `RunbookConfig {enabled=True}` (`backend/app/config.py:1347-1357`); `RagConfig.use_runbooks=True` (`:1280`).
- `Preferences.runbooks`, `Preferences.playbooks` (`backend/app/config.py:3882-3886`).
- `CaseAutomationRule.action` literal includes `run_playbook` (`backend/app/config.py:1410`).
- `settings_schema` labels "Runbooks", "Playbooks" (`backend/app/api/settings_schema.py:81-82`).
  The curated Settings UI exposes only `rag.use_runbooks`
  (`webui/src/soc/pages/settings/knowledge.tsx:286`); `playbooks.enabled` and
  `runbooks.enabled` have no curated control.
- Constants: KV namespaces (`backend/app/constants.py:48-60`), `ActionType.PLAYBOOK`,
  `ActionType.RUNBOOK` (`:516-517`), `JobKind.RUNBOOK_REINDEX` (`:682`).
- Models: `Case.playbook_id` (`backend/app/models.py:1726-1728`).

### 3.5 HTTP API

| Method and path | Permission | Code | Console caller |
|---|---|---|---|
| GET `/api/playbooks` | `playbooks:read` | `backend/app/api/routes.py:2725` | Catalog, CaseDetail picker |
| POST `/api/playbooks` | `playbooks:manage` | `:2739` | Catalog |
| POST `/api/playbooks/reload` | `playbooks:manage` | `:2770` | none |
| POST `/api/playbooks/dry-run` | `playbooks:read` | `:2791` | Catalog |
| GET `/api/playbooks/coverage` (scans up to 20,000 cases) | `playbooks:read` | `:2810` | Catalog |
| GET `/api/playbooks/selection/{case_id}` | `cases:read` | `:2872` | none |
| GET `/api/playbooks/{id}` | `playbooks:read` | `:2897` | Catalog |
| PUT `/api/playbooks/{id}` | `playbooks:manage` | `:2913` | Catalog |
| POST `/api/cases/{id}/run-playbook` | `playbooks:run` | `:6846` | CaseDetail |
| GET `/api/runbooks` | `runbooks:read` | `backend/app/api/routes_runbooks.py:132` | Runbooks |
| GET `/api/runbooks/{id}` | `runbooks:read` | `:151` | Runbooks |
| POST `/api/runbooks` | `runbooks:manage` | `:195` | Runbooks |
| PUT `/api/runbooks/{id}` | `runbooks:manage` | `:212` | Runbooks |
| DELETE `/api/runbooks/{id}` | `runbooks:manage` | `:239` | Runbooks |
| POST `/api/runbooks/reindex` (deprecated) | `runbooks:manage` | `:257` | none (Console uses the Job) |
| POST `/api/runbooks/{id}/reindex` | `runbooks:manage` | `:277` | Runbooks |
| POST `/api/jobs` kind `runbook_reindex` | `runbooks:manage` | `backend/app/api/routes_jobs.py:145`, `:213`, `:297` | Runbooks |

Audit rows: `ActionType.PLAYBOOK` surface `playbooks` for create/reload/update
(`backend/app/api/routes.py:2761-2788`, `:2932-2937`); `ActionType.RUNBOOK` via
`routes_runbooks._audit` (`:171`); manual run audits actor `run_playbook`
(`backend/app/api/routes.py:6877-6883`). Markdown case report prints
`**Playbook:** case.playbook_id` (`:6699`).

### 3.6 Other backend consumers

- Case rationale (`/api/cases/{id}/rationale`): reads `playbook_selector`,
  `procedure_provenance` and investigator rows to build `playbook {id, version, reason,
  consulted}` (`backend/app/engine/case_rationale.py:37-353`).
- Case stage timeline: a `playbook` note in the triage stage
  (`backend/app/api/routes_triage.py:652-699`).
- Metrics: `playbook_usage` (`backend/app/engine/metrics.py:289`, `:351`).
- Threshold automation `run_playbook` (`backend/app/engine/threshold_automation.py:10`,
  `:186-204`, `:295-298`, `:402-411`); rules editor docs (`backend/app/api/routes_rules.py:20`, `:424`).
- Jobs: handler `_runbook_reindex` and Inbox link `#/runbooks`
  (`backend/app/engine/jobs.py:87-88`, `:255`, `:1039-1060`); stored-row param decoding
  and retry-safe set (`backend/app/stores/jobs.py:40-50`, `:120-121`, `:197-198`).
- Export, `knowledge` scope: `operator_runbooks`, `operator_playbooks`,
  `bundled_runbooks`, `bundled_playbooks` groups plus a catalog manifest; operator
  content is exported in full, bundled as references
  (`backend/app/api/routes_export.py:44-46`, `:340-344`, `:550-760`, `:815`, `:873`).
- Chat tools: `search_knowledge` kinds and grants (`backend/app/agents/chat_tools/intel.py:427-700`);
  context slots (`backend/app/agents/chat_tools/base.py:272-275`); case rationale tool
  exposes `playbook` id (`backend/app/agents/chat_tools/cases.py:885-920`); follow-up
  selector treats runbooks/playbooks as reference-only tools
  (`backend/app/agents/chat_followups.py:61`, `:797`); citation kind `runbook`
  (`backend/app/agents/blocks.py:178`).
- Demo: the demo pipeline is built **without** a playbook registry and the demo RAG
  without a runbook service, so it falls back to bundled runbook files
  (`backend/app/engine/demo_runtime.py:227-249`, `:261`); demo chat context sets
  `runbooks=None, playbooks=None` (`:288-298`); the Demo chat planner recognises
  runbook/playbook questions (`backend/app/engine/demo_chat.py:1302`, `:2942`, `:3235`,
  `:3861`, `:6369`, `:7812`).
- Replay: arm parameter `playbooks_enabled` (`backend/app/engine/replay/params.py:62`,
  `extra="forbid"` at `:29`), applied in `backend/app/engine/replay/stack.py:478-481`;
  the replay pipeline uses the **live** registry `state.playbooks` (`:546`), not a frozen
  snapshot, while the RAG corpus is frozen (`_FrozenRagService`, `:278`, `:508`).
- Search palette entries (`backend/app/api/routes_search.py:70-71`).
- Diagnostics wording about running "with no runbook" (`backend/app/api/routes_diagnostics.py:1488-1501`).
- Reset: only the factory tier wipes the whole KV surface, which includes both
  namespaces (`backend/app/engine/reset.py:243-272`); cases/sources tiers keep them.
- RBAC: resources `playbooks: [read, run, manage]`, `runbooks: [read, manage]` and the
  six built-in roles (`backend/app/rbac/policy.py:57-58`, `:133-195`). Custom roles
  resolve against `RESOURCES` and silently drop unknown resources/actions
  (`backend/app/api/routes_roles.py:111`, `:198`, `:330`).
- Packaging: `pyproject.toml` includes the top-level `playbooks` package and
  `runbooks/*.md` (`backend/pyproject.toml:18`, `:25`, `:29`); `MANIFEST.in:4`;
  Dockerfile copies `playbooks` as a sibling of `app` (`backend/Dockerfile:44-47`); CI
  asserts both are in the wheel (`.github/workflows/ci.yml:108-109`); distribution
  contract test (`backend/tests/test_distribution_contract.py:52-121`); portability lint
  of bundled playbooks (`backend/tests/test_portability_contract.py`).

---

## 4. Console map (`webui/`)

- Registry and routes: PageIds `catalog`, `runbooks`, `playbooks`, `knowledge`,
  `memory`, `personas` (`webui/src/soc/registry.tsx:84-96`); Intelligence nav children
  (`:301-345`); hidden deep-link features (`:447-492`); `playbooks` and `personas`
  routes force the Intelligence tab (`:630-633`). The legacy `catalog` alias opens
  Playbooks (`webui/src/soc/pages/Intelligence.tsx:70-79`).
- `Intelligence.tsx` (100 lines): host with five sub-views and header copy (`:37-63`).
- `Catalog.tsx` (1,415 lines): personas plus playbooks; template (`:334`); coverage and
  selection test panel with scheduler "continuous-improvement workers" health
  (`:771-940`); load path calls `getPlaybooks`, `getPlaybookCoverage`,
  `getSchedulerHealth`, and `getSettings` to count `run_playbook` automation rules per
  playbook (`:1123-1178`); open/create/update (`:1191-1260`).
- `Runbooks.tsx` (1,581 lines), `runbookAuthoring.ts` (624 lines, client mirror of the
  authoring standard), `runbookExamples.ts` (42 lines, three downloadable examples);
  reindex submits a `runbook_reindex` Job (`webui/src/soc/pages/Runbooks.tsx:1279-1285`).
- Case surfaces: "Run a playbook" item in Take action and its dialog, gated by
  `playbooks:run`, synchronous call, success toast "Playbook applied"
  (`webui/src/soc/pages/CaseDetail.tsx:430-434`, `:931-971`, `:1632-1643`, `:2123-2175`);
  WhyPanel procedure block and "Runbook references" group
  (`webui/src/soc/pages/casedetail/WhyPanel.tsx:115-139`, `:236-260`, `:310-353`,
  `:524-575`); Investigation inputs chips Runbook and Playbook
  (`webui/src/soc/pages/casedetail/InvestigationInputs.tsx:40-173`); Overview panel
  automation label and Playbook chip (`webui/src/soc/pages/casedetail/OverviewPanel.tsx:584`,
  `:1841`); Facts rail (`webui/src/soc/pages/casedetail/FactsRail.tsx:386`).
- Cases list: hidden-by-default `playbooks` column (`webui/src/soc/pages/Cases.tsx:188-199`,
  `:297-299`, `:1332-1340`); stored per-user column state may reference it.
- Analytics: "Playbook usage" chart (`webui/src/soc/pages/Metrics.tsx:370-371`, `:753-757`).
- Settings: Advanced "Suppression & response playbooks" link
  (`webui/src/soc/pages/settings/advanced.tsx:187-213`); Knowledge "Use runbooks" switch
  and "Corpus & procedures" links (`webui/src/soc/pages/settings/knowledge.tsx:286`,
  `:395-428`); search keywords (`webui/src/soc/pages/settings/settings-sections-meta.ts:331`,
  `:373-377`, `:564`).
- Rules: `run_playbook` action and free-text `playbook_id` field
  (`webui/src/soc/rules/RuleEditor.tsx:596-602`, `webui/src/soc/rules/constants.ts:45`,
  `:114-116`).
- Misc: Audit filters `playbook`, `runbook` (`webui/src/soc/pages/Audit.tsx:79-80`);
  access copy (`webui/src/soc/chat/composer/access-copy.ts:77-78`); role matrix
  (`webui/src/soc/pages/Roles.api.ts:138-139`); Docs hub card "Playbooks and approvals"
  (`webui/src/soc/pages/Docs.tsx:149-152`); Knowledge source tones
  (`webui/src/soc/pages/Knowledge.tsx:152-177`, `:1495`); chat blocks citation kind
  `runbook` (`webui/src/soc/chat/blocks/schema.ts`, `labels.ts`,
  `answer-blocks.contract.json`); report exporter (`webui/src/soc/chat/report/export/walker.ts`).
- Types and client: `Playbook*` (`webui/src/lib/types.ts:501-610`), `Runbook*` (`:624-710`),
  automation payload (`:1786`), `Case.playbook_id` (`:2572`), `playbook_usage` (`:4099`),
  `RationalePlaybook` (`:5478`); client methods (`webui/src/lib/api.ts:749-807`,
  `:1073-1080`, `:1122-1175`); generated `api-types.gen.ts` and `webui/openapi.json`
  (16 operations across 11 paths).

---

## 5. Documentation and generated knowledge

- Help Center pages: `docs/intelligence/runbooks.md` (41 mentions),
  `docs/automation/playbooks-approvals.md` (18), `docs/intelligence/knowledge-memory.md`,
  `docs/analyst/investigation.md`, `docs/analyst/cases.md`, `docs/analyst/case-manager.md`,
  `docs/automation/index.md`, `docs/automation/rules.md`,
  `docs/concepts/deterministic-decisions.md`, `docs/concepts/terminology.md`,
  `docs/reference/permissions.md:33-50`, `docs/reference/security.md`,
  `docs/reference/api.md` (31), `docs/reference/configuration.md`,
  `docs/operations/background-jobs.md`, `docs/operations/health-backup.md:71-72`,
  `docs/development/extensions.md:117-134`, `docs/development/ui-standard.md`,
  `docs/development/testing.md`, `docs/TROUBLESHOOTING.md`, `docs/index.md`,
  release notes and known limitations.
- Top-level: `docs/USAGE.md` (50), `docs/HANDOFF.md` (15), `docs/VIGIL_STUDY.md`,
  `AGENTS.md` repository layout lines, `README.md`, `DEPLOY.md`, `ROADMAP.md`,
  `CHANGELOG.md` (about 77 mentions across these).
- `backend/playbooks/README.md` (12 KB author guide).
- Generated product knowledge for chat: `backend/app/knowledge/app_docs.json` (73
  playbook, 121 runbook mentions), `console_map.json` (`page:playbooks`,
  `playbooks:read`), `aliases.json:142-172`. These regenerate from docs via
  `npm run gen:console-map` and `scripts/build_app_knowledge.py`, and a manifest check
  fails closed if they drift.

---

## 6. Tests

Backend (core files and test counts): `test_playbook_management.py` (8),
`test_playbook_run.py` (4), `test_playbook_selection.py` (8), `test_playbook_loader.py`
(9), `test_runbook_management.py` (22), `test_intelligence_hardening.py` (11),
`test_portability_contract.py` (6), `test_vigil_wave1.py` (20), `test_vigil_wave2.py`
(10), `test_explainability.py` (14), plus about 30 more that touch the subject:
`test_round3_wave4_rag_fencing.py`, `test_round3_wave5_prompt_fencing.py`,
`test_marker_normaliser.py`, `test_discounted_inference_export.py`,
`test_distribution_contract.py`, `test_case_stages.py`, `test_threshold_automation.py`,
`test_rbac_policy.py`, `test_rbac_users.py`, `test_round3_wave1_rbac.py`,
`test_round3_wave2_roles.py`, `test_chat_tools_ops.py`, `test_chat_tools_knowledge.py`,
`test_chat_tools_registry.py`, `test_chat_followups.py`, `test_chat_engine_loop.py`,
`test_rag_p1.py`, `test_precedent_corpus*.py`, `test_pipeline.py`,
`test_embedding_probe_and_composition.py`, `test_corpus_loss_provider_outage.py`,
`test_trace_rag.py`, `test_demo_chat_round12.py`, `test_durable_jobs_adversarial.py`,
`test_settings_roundtrip.py`, `test_round4_wave3_eventdetect.py`,
`test_round12_case_mutation_bands.py`, `test_app_knowledge.py`, `replay_support.py`.

Console: 54 test files mention one or both, the heaviest being
`Runbooks.management.test.tsx` (146 mentions), `Catalog.playbooks-management.test.tsx`
(80), `runbookExamples.test.ts`, `intelligence-playbooks-label.round6.test.tsx`,
`WhyPanel.test.tsx`, `InvestigationInputs.test.tsx`, `api-client-behavior.test.ts`,
`roles-matrix.test.tsx`, `nav-derivation.test.ts`, `console-map.contract.test.ts`,
`route-registry.test.tsx`, `settings-redirects.test.ts`, and many Overview/CaseDetail
fixtures that carry `playbook_id` in sample data.

---

## 7. Non-negotiables touched

| # | How the two features touch it | What a rebuild must keep |
|---|---|---|
| 2 | Selection, consultation, create/update/delete/reindex and manual runs are audited (`playbook_selector`, `procedure_provenance`, `run_playbook`, `ActionType.PLAYBOOK/RUNBOOK`). Case rationale and the triage timeline read these rows. | Keep an append-only selection row and a selected-versus-consulted provenance row; old rows must still render in rationale. |
| 3 | Both are advisory. Playbook block sits below the policy in the precedence string; `run_playbook` automation never sets status. | No runbook field may feed `decide()`; "escalate_if" and "verdict bias" stay hints. |
| 6 | A manual or automated run is a full re-investigation through the one gateway. | A "run" must stay one pipeline call, ledgered, and budget-gated. Consider making it a Job. |
| 7 | Playbooks inject operator text, never raw logs. | Keep. |
| 9 | Both are TRUSTED. Operator-authored text becomes instruction context without review. The marker normaliser covers new fence names automatically. | Decide the trust model for operator runbooks explicitly (see open questions); keep imported docs UNTRUSTED; keep reserved source labels. |
| 10 | Both default ON (`PlaybookConfig.enabled`, `RunbookConfig.enabled`, `rag.use_runbooks`). | New default should be ON with bundled content, and degrade to the generic prompt when nothing matches. |
| 11 | Selection is pure and tested (spine); UI is breadth. | Keep selection pure and covered by offline tests. |
| 12 | Both stores reuse the KV table/index; no migration. Bundled content ships in the package. | New store must reuse KV (no new index/table), and old KV docs must stay readable. |

---

## 8. Defects and inconsistencies found today

1. **Bundled playbooks silently truncated.** `render_playbook_prompt` lengths:
   `brute_force_login` 2,934, `phishing_reported_email` 3,113,
   `suspicious_outbound_connection` 3,014 characters, all above the 2,400 budget, so
   `truncate()` drops their tail (the "Reproduce" and part of the "Decide" sections)
   (`backend/app/agents/prompts.py:492`). Operator authoring rejects the same overage
   because "silently accepting a large document and then dropping its final
   instructions is unsafe" (`backend/app/playbooks/manifest.py:23-27`). Measured with
   `load_playbooks` + `render_playbook_prompt` in the backend venv.
2. **Two dialects for the same idea.** Playbook bodies are Markdown with headings and
   bold; runbook bodies forbid Markdown and require seven labels. Both use the same
   front-matter parser.
3. **Dead fields.** `suggested_tools` is parsed, displayed and exported but never
   reaches the model or tool selection (only `backend/app/api/routes.py:2679` and
   `backend/app/api/routes_export.py:571` read it), yet the Console shows it as
   "Suggested tools" chips in every Selection context (screenshot
   `runbooks-05c-playbook-selection-context.png`). `PlaybookConfig.llm_select` is
   unused (`backend/app/config.py:736-741`).
4. **Soft criteria rarely work.** `mitre` and `any_tags` can only match rule names
   (`backend/app/playbooks/registry.py:221-245`), so selection is effectively exact
   rule id plus entity type. Live coverage in the demo is 11.6% (10 of 86 cases),
   uncovered families listed in the screenshot `runbooks-05-playbooks-coverage.png`.
5. **Demo Mode "Run a playbook" does nothing but says it did.** The route validates the
   id against the real registry and calls `state.playbooks.run(state.pipeline, ...)`
   (`backend/app/api/routes.py:6863-6887`); in Demo Mode `state.pipeline` is the demo
   pipeline (`backend/app/state.py:574-575`), built without `playbooks=`
   (`backend/app/engine/demo_runtime.py:240-244`), so `pipeline.py:659-671` selects no
   playbook (reason `playbooks_disabled`). The Console still toasts "Playbook applied"
   (`webui/src/soc/pages/CaseDetail.tsx:963`). Inferred from code, not executed against
   the shared demo to avoid mutating it.
6. **Demo analytics show a useless chart.** "Playbook usage: None 87 (100%)" because
   demo cases never get a playbook (screenshot `runbooks-14-analytics-playbook-usage.png`).
7. **First-run friction in runbook authoring.** Opening "New runbook" shows "17 fixes"
   before the operator types anything (screenshot `runbooks-03-runbook-new.png`).
8. **Synchronous run.** "Run a playbook" is a request-bound re-investigation, while
   "Reinvestigate" is a durable Job (`JobKind.CASE_REINVESTIGATE`). Navigation can lose
   the result.
9. **No delete for operator playbooks**, unlike runbooks.
10. **Unused endpoints.** `POST /api/playbooks/reload` and
    `GET /api/playbooks/selection/{case_id}` have no Console caller; the client method
    for the deprecated full runbook reindex exists but is unused.
11. **Docs drift.** `docs/automation/playbooks-approvals.md` says operator procedures
    "live in the configured playbook directory"; by default they live in KV.
12. **Replay is not hermetic for playbooks.** Replay freezes the RAG corpus but uses the
    live playbook registry (`backend/app/engine/replay/stack.py:546`), so editing a
    playbook between replay cells changes results.
13. **Settings gap.** `playbooks.enabled` and `runbooks.enabled` have no curated
    Settings control.

---

## 9. Blast radius of removing both

| Area | What breaks or must change | Severity |
|---|---|---|
| Investigator prompt | `render_cluster(playbook=)`, `<<<PLAYBOOK>>>` block, precedence wording, `MAX_PLAYBOOK_PROMPT_CHARS` import (`backend/app/agents/prompts.py:27`, `:479-494`, `:656-662`); investigator and graph signatures (`investigator.py:29`, `:114-191`; `graph.py:88-168`) | High: core path, needs a replacement injection |
| RAG | `use_runbooks`, `_runbook_seed_items`, `SEED_RUNBOOKS`, `reindex_runbooks`, `runbook_projection_revisions`, rebuild marking, `TRUSTED_KNOWLEDGE_SOURCES` (`backend/app/tools/rag.py`) | High: existing vector docs `runbook:<id>:<n>` and `seed:runbook` must be removed or re-projected |
| Pipeline and state | `force_playbook_id` plumbing, selection, provenance, `Case.playbook_id` assembly, automation callback, registry/service construction | High |
| HTTP API | 16 operations (section 3.5); OpenAPI and generated types; external API clients | Medium: keep aliases or 410 for one release |
| Console | `Catalog.tsx` playbooks half, `Runbooks.tsx`, `runbookAuthoring.ts`, `runbookExamples.ts`, Intelligence host, nav children, deep links `#/playbooks`, `#/catalog`, `#/runbooks`, Case run dialog, WhyPanel, InvestigationInputs, Cases column, Analytics chart, Settings links, Rules action, Audit filters, Docs card | High effort, low risk |
| Stored operator data | KV `playbooks/documents`, KV `runbooks/documents` (+ `pending_deletes`) | High: needs conversion (section 10) |
| Stored cases | `Case.playbook_id` on every historical case; `knowledge_used` entries with source `runbook` | Medium: keep field readable; history must not be rewritten (provenance contract, AGENTS.md section 5) |
| Audit history | Rows by `playbook_selector`, `procedure_provenance` (`tool_input.playbook`), `run_playbook`, `ActionType.PLAYBOOK/RUNBOOK` | Medium: rationale/timeline readers must accept old shapes forever (append-only #2) |
| Automation rules | `threshold_automation.rules[*].action == "run_playbook"` with `payload.playbook_id` in Preferences and in the rule version ledger | High: the Literal would reject stored config on load unless aliased |
| RBAC | `playbooks:*` and `runbooks:*` in built-in roles; custom roles referencing them silently lose the grant when the resource disappears | Medium: map grants |
| Jobs | Terminal rows with kind `runbook_reindex` in the strict job registry; enum removal would break decoding | Medium: keep the wire value |
| Export | `knowledge` scope groups and manifest counts; backup consumers | Medium: keep group names or version the manifest |
| Chat | `search_knowledge` kinds `list_runbooks/list_playbooks`, grants, stored transcripts with guide links to pages `runbooks`/`playbooks` and citation kind `runbook`; demo planner intents; golden-set questions | Medium: keep kinds as aliases and keep page refs routable |
| Metrics | `playbook_usage` series and its chart | Low |
| Replay | `playbooks_enabled` arm field under `extra="forbid"`; stored replay job params | Low: keep field accepted, map to new flag |
| Demo | Bundled runbook fallback path; demo planner wording | Low |
| Packaging/CI | `pyproject.toml`, `MANIFEST.in`, Dockerfile COPY, ci.yml wheel assertions, distribution and portability contract tests | Medium: a missed COPY silently disables bundled content (`backend/Dockerfile:44-45` warns of exactly this) |
| Docs and knowledge corpus | about 40 pages, README, `app_docs.json`, `console_map.json`, `aliases.json` | Medium: regenerate, the manifest check fails closed |
| Tests | about 40 backend and 54 Console test files | High effort |

---

## 10. Migration recommendation for stored operator content

### 10.1 Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Export only, then delete | Simplest code | Operators lose live procedures on upgrade; violates "never silently discard operator state" that motivated the durable stores (`backend/app/constants.py:55-58`) |
| B. Keep both read-only forever | Zero conversion risk | The operator explicitly asked to remove both; two dead pages remain |
| **C. Convert forward, keep originals read-only for one release, export both** | No data loss, one feature in the UI, rollback possible | Needs a converter and a "legacy" view |

### 10.2 Recommended (option C)

1. **One-shot, idempotent conversion at startup** (or as a Job so it is visible in the
   Inbox), audited per document. Read `playbooks/documents` with `list_strict()` and
   `runbooks/documents` with `list_strict()`; never rewrite the source documents.
2. **Mapping.**
   - Operator playbook to new runbook: `id`, `name` to title, `description` to summary,
     `match.rule_ids/entity_types/min_event_count` to the new trigger, `mitre` and
     `any_tags` to techniques and tags, `priority` and `version` kept, body kept as the
     procedure, `escalate_if` and `suggested_verdict_bias` into advisory fields,
     `rag_queries` kept if the new design keeps companion retrieval, `suggested_tools`
     dropped (it never had an effect).
   - Operator runbook to new runbook: `title`, `summary`, `applies_to_rules` to trigger
     rules, `applies_to_entities`, `applies_to_techniques`, `keywords`, `persona`; the
     seven labelled sections map directly to structured sections (signal, evidence,
     steps, TP signals, FP signals, needs human, next action, limitations).
   - Id collisions between a playbook and a runbook with the same id: keep the playbook
     id, suffix the runbook (`<id>-reference`), and report it in the migration audit.
   - Rows that fail today's validation (the stores already keep invalid rows) migrate as
     **draft / not active** with the validation message, never dropped.
3. **Mark migration done** with a small marker document in the new namespace (the same
   pattern as `autopilot_config_version` and `chat_limits_version`), so a restart does
   not convert twice and a downgrade still finds the untouched legacy documents.
4. **Legacy view for one release.** A read-only "Imported from Playbooks / Runbooks"
   filter or badge in the new Runbooks page, showing the original Markdown, so an
   operator can verify the conversion. Remove the legacy namespaces only in a later
   release, after an export prompt.
5. **Export.** Keep `operator_playbooks`, `operator_runbooks`, `bundled_*` groups in the
   `knowledge` export scope for the transition release (backup completeness), and add
   the new group; bump the manifest version so consumers can tell.
6. **Bundled content.** Do not migrate bundled files; ship a new bundled set authored in
   the new format (merging each playbook/runbook pair), with prompt lengths validated by
   a test so finding 8.1 cannot recur.

### 10.3 Wire identifiers to keep accepted (aliases, not renames)

AGENTS.md section 1 forbids renaming existing literal contracts in a branding edit; these
are the ones a merge touches:

- `Case.playbook_id`: keep the field (historical cases and exports); add the new
  `runbook_id` alongside, and have readers prefer the new field.
- `CaseAutomationRule.action = "run_playbook"` and `payload.playbook_id`: keep accepting
  them on load and map to the new action, or stored Preferences fail validation.
- `JobKind.RUNBOOK_REINDEX = "runbook_reindex"`: keep the value.
- Permission resources: keep `runbooks:read/manage`; map `playbooks:read` to
  `runbooks:read`, `playbooks:manage` to `runbooks:manage`, `playbooks:run` to a new
  `runbooks:run` (or to `cases:reinvestigate`), including in custom roles, so no role
  silently loses a grant.
- Audit actors `playbook_selector`, `procedure_provenance`, `run_playbook` and
  `ActionType.PLAYBOOK/RUNBOOK`: readers must accept them forever; new writers may add a
  new actor, but rationale must read both.
- Chat `search_knowledge` kinds `list_playbooks`/`list_runbooks` and page refs
  `playbooks`/`runbooks`/`catalog`: keep routable (redirect to the new page) because
  stored transcripts and Inbox items link to them.
- Replay arm `playbooks_enabled`: keep accepted under `extra="forbid"`.
- Neutral marker tag `<pb>` for forged `PLAYBOOK` markers: keep (tests pin it).
- HTTP: keep `/api/runbooks*` as the new home; make `/api/playbooks*` and
  `/api/cases/{id}/run-playbook` deprecated aliases (or `410` with a pointer) for one
  release, mirroring how `routes_reset` handled its retired route.

---

## 11. Constraints any rebuild inherits from today's code

1. One deterministic, pure selection function with a dry-run explainer (the coverage
   and "Test match" tools are the most useful part of the playbook page).
2. Selected-versus-consulted provenance on every run, and `Case` provenance that never
   rewrites history.
3. One prompt budget used both for authoring validation and prompt truncation, enforced
   for bundled content by a test.
4. Trusted injection through a named fence pair; untrusted data still fenced; reserved
   source labels for retrieval.
5. Strict-CAS KV storage with revision checks, bounded catalog size, bundled content as
   immutable package data, shadowing rules reported, never silent.
6. Durable Jobs for anything that re-investigates or reindexes; Inbox links that keep
   working.
7. Demo parity: the demo pipeline and demo chat must see the same bundled runbooks and
   honour a forced run (or the button must be hidden in Demo Mode).
8. Replay should freeze the runbook catalog like it freezes the corpus.

---

## 12. Screenshots (shared demo, 1440x900, light)

All under `<scratch>/r14/shots/research/`:

| File | Shows |
|---|---|
| `runbooks-00-intelligence-nav.png` | Intelligence group expanded: Knowledge corpus, Reference runbooks, Operator memory, Response playbooks, Agent personas |
| `runbooks-01-runbooks-list.png`, `runbooks-01b-runbooks-list-full.png` | Reference runbooks list: 9 bundled, Reindex all, New runbook, per-row Reindex/Open |
| `runbooks-02-runbook-open.png` | Runbook detail sheet: rules, MITRE, entities, keywords, revision, raw source |
| `runbooks-03-runbook-new.png` | Create runbook sheet: examples, "17 fixes" readiness panel, 1,800/1,200 budgets |
| `runbooks-04-playbooks-list.png`, `runbooks-04b-playbooks-list-full.png` | Response playbooks list: Package, priority, Runnable badges |
| `runbooks-05-playbooks-coverage.png`, `runbooks-05b-playbooks-coverage-full.png` | Coverage 11.6% (10 of 86), uncovered rule families, Test deterministic matching, worker health |
| `runbooks-05c-playbook-selection-context.png` | Expanded "Selection context" (match criteria, suggested tools) |
| `runbooks-06-playbook-open-source.png` | Playbook source sheet: Markdown body with headings and bold |
| `runbooks-06b-playbook-new.png` | New playbook editor |
| `runbooks-07-knowledge.png` | Knowledge corpus page |
| `runbooks-08-case-manager-case.png` | Case Manager case CASE-000082 overview |
| `runbooks-09-case-take-action-menu.png` | Take action menu with "Run a playbook" |
| `runbooks-10-case-run-playbook-dialog.png` | Run a playbook dialog with cost warning |
| `runbooks-11-case-investigation-tab.png`, `runbooks-11b-case-investigation-tab-full.png` | Investigation inputs: Knowledge 1, Runbook 3 retrieved references, Persona |
| `runbooks-12-case-review-inputs.png` | Assessment evidence and "Investigation procedure" section |
| `runbooks-13-settings-knowledge.png`, `runbooks-13b-settings-corpus-procedures.png` | Settings, Knowledge: Corpus & procedures links to both pages |
| `runbooks-14-analytics-playbook-usage.png` | Analytics "Playbook usage: None 87 (100%)" in Demo Mode |

The capture script is
`<scratch>/r14/notes/rb-shoot.mjs`
(steps `explore`, `detail`, `pb`, `case`, `misc`).

---

## 13. Open questions for the operator

1. **Trust of operator-authored runbooks.** Today any `runbooks:manage` or
   `playbooks:manage` holder can put TRUSTED instruction text in front of the model
   without review. Should a new or edited operator runbook go through an approval step
   (like agent-authored memory, which starts pending) before it is injected?
2. **Execution scope.** Should the new Runbook stay "guidance for the AI and the
   analyst" (today's model, never executes actions), or should it grow analyst-facing
   checklist steps that are tracked per case (case tasks already exist in
   `case_tasks`)? Automated response actions would be a much larger change and touch #3.
3. **Selection model.** Keep exact rule-id plus entity matching, or allow MITRE
   technique and tag triggers once the case has them (that requires a second selection
   after the verdict, or selection on enrichment)?
4. **Transition length.** Keep the legacy read-only view and API aliases for one
   release (recommended) or remove them immediately?
5. **Demo behaviour.** Should Demo Mode show and honour runbook selection (needs a demo
   registry) or hide the manual run?
