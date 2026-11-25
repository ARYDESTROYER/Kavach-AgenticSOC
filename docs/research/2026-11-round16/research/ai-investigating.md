# Showing when the AI is investigating a case (report key: ai-investigating)

Research agent report for Round 16. Repository `/home/user/Kavach-AgenticSOC`, branch
`claude/round16` (HEAD `3cd362c`, "Journal: Round 16 start"). I worked read-only. The only
code I ran was a throwaway pytest probe and an ASGI disconnect simulation, both kept in the
scratchpad (`.../scratchpad/exp/`). Nothing in the repository was edited.

## 1. Summary

Today an AI investigation is nearly invisible in the Console. The only live signal is the
`agent.step` narration in the Collaboration tab's Activity section. It shows only frames that
arrive while that tab is open. It never clears, and a run that fails never sends a final frame.
Nobody can ask the server "is a run in flight for this case?", because no such state exists.
Runs waiting for an investigation slot are invisible, and new clusters have no case until
their run ends.

The proposal:

1. **A process-local `InvestigationRegistry`.** It sits on `AppState` next to
   `investigation_gate`, and the Demo stack gets its own. The pipeline registers each run
   before it waits for a gate permit and clears it in a `finally`. That covers success, the
   fail-to-human path, cancellation and shutdown. A restart empties it, and no field is
   written to the case, so nothing can stay "investigating" forever.
2. **One new SSE frame, `case.investigation`.** It goes on the existing `cases` topic and the
   `cases:{id}` room, carries ids and enums only, and is not retained. A new
   `GET /api/investigations/active` lets a client reconcile.
3. **Four Console placements that add no vertical space and no new EventSource:**
   - an "AI working" mark on the queue row;
   - an "AI working" chip with an explanatory popover on the case header's meta row;
   - a warning in the close dialog saying the run's result will replace a close made now;
   - a finish signal: an Inbox item for the person who asked for the run, and an Inbox item
     for a person whose close was replaced.
4. **Two fixes that the indicator depends on:**
   - Reinvestigating a closed case should update it in place. Today it creates a second case
     (verified, and a known Round 15 follow-up).
   - Single-case Reinvestigate should return `202` at once instead of holding the HTTP request
     for the whole run.

The AI run's result stays authoritative over a close a person makes during the run. That is
today's behaviour (verified, section 3, F5), and this design only makes it visible. `decide()`
is untouched (#3). No model call is added (#6). Frames carry no log-derived text (#7, #9).
Storage is unchanged, with no KV namespace, index or table (#12).

## 2. How an investigation runs today

### 2.1 Entry points (every one ends in `InvestigationPipeline.investigate_cluster` or its `_locked` twin)

| Trigger | Caller (file:line) | Case exists while it runs? | Priority |
|---|---|---|---|
| Poll / push ingest, eligible new cluster | `engine/ingest.py:415` (`handle_clusters` calls `_investigate_cluster_locked`; the signature lock is already held) | No. `case_id` is minted at `pipeline.py:875` and saved only at `:1225` | ingest |
| Poll / push ingest, candidate that became eligible | same, `existing.verdict is None` | Yes (the candidate) | ingest |
| Cap-deferred drain | `engine/poller_manager.py:503` (`_drain_deferred`) | Yes (the candidate) | ingest |
| Event-detection re-entry (Batch) | `state.py:2143-2146` (`register_candidate`, then `investigate_cluster`) | Yes (registered first) | ingest |
| Demo event routing | `engine/demo_runtime.py:760-761` | Yes | ingest |
| Manual Reinvestigate | `api/routes.py:8421` (`POST /api/cases/{id}/reinvestigate`, `force=True`) | Yes, if still open. A closed case gets a NEW case (F6) | ingest |
| Manual legacy investigate | `api/routes.py:8347` (`POST /api/cases/{id}/investigate`), `routes.py:2447` (`POST /api/investigate`) | Same as above / No | ingest |
| Bulk reinvestigate job | `engine/jobs.py:705-742` (`_case_reinvestigate`, `investigation_priority="background"`) | Same as manual | background |
| Replay harness | `engine/replay/stack.py:580` | Isolated stack; must stay untracked | n/a |

### 2.2 Stages inside one run (`agents/pipeline.py`)

1. `investigate_cluster` (`:795`) takes the per-signature lock (`signature_lock`, `:391`) for
   the whole run.
2. `_investigate_cluster_locked` (`:817`) waits for `InvestigationGate.permit`
   (`engine/investigation_gate.py`, cap `caps.max_concurrent`, default 3). **This wait has no
   time limit and no visible state.**
3. `_investigate_cluster_effect` (`:848`) sets the run id `inv-<hex>` (`:858`). Every audit
   row of the run carries it.
4. `_investigate_cluster_run` (`:867`):
   - `find_open_case_for_cluster` (`:882`) runs. It only finds statuses in
     `OPEN_CASE_STATUSES` (`constants.py:540`).
   - The analyst-policy close runs next (`:891`): $0, no frames.
   - The P1 "no material change" return follows (`:918`): no frames.
   - Then `_emit_step("router")` (`:931`), enrichment and risk, the runbook and persona
     selection, and `_emit_step("persona")` (`:985`).
   - Then `_emit_step("tools")` (`:1030`) and `asyncio.wait_for(run_investigation, timeout=caps.timeout_seconds)`
     (`:1064`, default 120 s, `config.py:648`), followed by `_emit_step("verdict")` (`:1179`).
5. The re-read happens next. `_latest_stored_case` (`:1184`, Round 15 D6.10) reads the stored
   case again, and `_carry_case_work` (`:1759`) carries the people's work:
   - `assignee`, comments, feedback and `status_history`;
   - `acknowledged_at` and `status_reason`;
   - the analyst disposition.
   `status` is NOT carried. It is only the previous status that `apply()` reads.
6. Assembly and the decision:
   - the ledger cost read (`:1215`);
   - `CaseManager(prefs).apply(case)` (`:1224`), then `save` (`:1225`);
   - the `case_manager` audit row;
   - `_emit_step("decision", status="done")` (`:1254`).
7. The post-decision hooks run in this order: runbook attach, automation, RAG indexing,
   `notify` (detached), and the review sampler.
8. On any exception (`:1283`) the pipeline re-reads the case and calls `_fail_to_human_case`,
   then saves and writes an audit row. **No terminal `agent.step` frame is sent.**
   - `CancelledError` is not caught there, so a cancelled run saves nothing.

### 2.3 What reaches the Console today

- **`agent.step` frames** go to `cases:{case_id}` (`pipeline.py:406-439`). They are
  `retain=True`, but a new subscriber only gets a replay when it sends `Last-Event-ID`, so a
  case opened mid-run shows nothing until the next frame.
- **`CaseActivityFeed`** (`webui/src/soc/components/CaseActivityFeed.tsx:142-226`) is the only
  consumer. It is mounted only in the Collaboration tab (`CaseDetail.tsx:2416`; Radix
  `TabsContent` unmounts inactive tabs). Its list is cleared only when the case id changes, so
  "Investigation in progress" stays after the run ends.
- **`useAgentSteps`** (`lib/useEventStream.ts:471`) has no production caller.
- **`case.changed`** goes to topic `cases` on every save (`realtime.py:324`,
  `stores/cases.py:128`). The Case Manager queue consumes it (`CaseManager.tsx:1393-1404`).
  It says a case changed, not that a run is in flight.
- **The single-case Reinvestigate** in the case header (`CaseDetail.tsx:1579-1597`, dialog
  `:2556-2615`) is a blocking `POST`. The dialog says "may take a few seconds", its Cancel
  button is disabled while the request runs, and the result arrives only in the HTTP response.
- **Bulk reinvestigate** is a durable job. Only the console that submitted it shows row
  spinners (`RowJobState.pending`, `CaseManager.tsx:406-414`), plus the job toast in
  `JobMonitor`.

## 3. Findings (verified unless marked)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | A failed run sends no terminal frame. The Activity narration stays "Investigation in progress", with the last row "Tools running". | Probe `test_failed_run_emits_no_terminal_step`: the frames were router, persona and tools, with no `done` frame. Code: the except path `pipeline.py:1283-1330` has no `_emit_step` | Medium |
| F2 | The narration heading never changes after `decision done`. It is only visible in Collaboration, Activity, and a viewer who opens mid-run sees no state. | `CaseActivityFeed.tsx:144-147`, `:200-224` | Medium |
| F3 | The queued state is invisible. The gate wait (`pipeline.py:836`) is not bounded by `caps.timeout_seconds`, so a blocking Reinvestigate can outlast nginx's `proxy_read_timeout 300s` (`webui/nginx.conf`, `location /api/`). The browser then shows "The reinvestigation could not be started." while the run goes on. | Code reading. I checked separately that a client disconnect does NOT cancel the handler on this stack: a local ASGI simulation on Starlette 0.37.2 with a `BaseHTTPMiddleware` showed the handler ran to completion. The real uvicorn plus nginx path was not exercised (unverified) | Medium |
| F4 | The Reinvestigate dialog copy "may take a few seconds" is wrong for a run capped at 120 s plus queueing. Cancel is disabled for the whole run. | `CaseDetail.tsx:2565-2567`, `:2602` | Low |
| F5 | A close a person makes during a run is replaced by the run's decision. The close is kept in `status_history`, and the status moves on. | Probe `test_close_mid_run_is_replaced`: final status `needs_human`, history `('escalated','closed','bob'), ('closed','needs_human','system')` | By design; must be shown (brief) |
| F5b | **Lost-update window.** Between the re-read (`:1184`) and `save` (`:1225`) the pipeline awaits the ledger read (`:1215`), and `save` itself does a get then an index. A close, comment or assignment written in that window is overwritten whole: neither carried nor kept in history. Neither the case action path (`routes.py:7578`) nor the pipeline holds a per-case write lock, and the case stores have no compare-and-set. | Code reading; the window is narrow (one store round trip or more) | Medium (pre-existing) |
| F6 | Reinvestigating a CLOSED case mints a second case. A close made while a run is still QUEUED gives the same result, because the run's `find_open_case_for_cluster` no longer finds the case. | Probe `test_reinvestigating_closed_case_mints_new`; Round 15 SPEC §7 lists "Reinvestigating a closed case updates it in place (today it creates a second case)" as a follow-up | High for this feature (the indicator would point at the wrong case) |
| F7 | Connection budget. nginx serves the Console over HTTP/1.1 (`listen 80`, no `http2`), and browsers allow 6 connections per host for HTTP/1.1. With a case open on the Collaboration tab, the Case Manager holds about six EventSources: JobMonitor, NotificationBell, the Case Manager stream, runbook live, and the two `cases:{id}` streams (CaseThread `:667` and CaseActivityFeed `:164`). Any further fetch can then queue. The code already knows this (`soc/runbooks/run/live.ts:5-9`, `soc/chat/turn-runner.ts:33`). | Code reading; the limit is per MDN (section 8). I did not reproduce the stall in a browser (unverified) | Medium |
| F8 | Naming collision. `CaseStatus.INVESTIGATING` is the human "acknowledged" status (Round 4). An AI chip that says "Investigating" next to the status would read as the same thing. | `constants.py:540`; `caseFacts.ts:191` | Copy risk |
| F9 | New clusters run with no case, and their `agent.step` frames go to a room nobody can subscribe to. The queue cannot show them. | `pipeline.py:875`, `:931` | Low (by design); handled by a count |

Probe file: `/tmp/claude-0/-home-user-Kavach-AgenticSOC/2fc24c44-3228-5bc2-8fb3-56e1bc548beb/scratchpad/exp/t/test_probe_inflight.py`.
I ran it from `backend/` with
`python -m pytest -q -s -p tests.conftest -c pyproject.toml --rootdir=. -p no:cacheprovider <file>`.
All three probe tests passed, which confirms F1, F5 and F6.

## 4. Design

### 4.1 Principles

- **No field on the Case document.** A stored "in flight" flag would need an extra save at
  run start and would go stale after a crash. The registry is memory only, and the client
  reconciles with the server.
- **Register before the gate, clear in `finally`.** One context manager, one place.
- **Frames are nudges.** Ids, enums and timestamps only, never title, entity, rule or model
  text (#7, #9). They are not retained in the replay ring, so the `cases` ring keeps its
  `case.changed` history. Clients reconcile with `GET /api/investigations/active`.
- **No new EventSource.** Ride the existing `cases` stream (Case Manager) and one shared
  per-case room (R9).
- **Hold off the indicator for about 1 s.** Most Demo and policy runs end almost at once, and
  NN/g advises not showing a busy indicator for the first second (section 8).

### 4.2 Backend: `engine/investigation_registry.py` (new, pure, no HTTP imports)

```python
TRIGGERS = ("automatic", "manual", "job", "drain", "detection")
PHASES = ("queued", "triage", "specialist", "evidence", "verdict", "decision")
OUTCOMES = ("decided", "routed_to_person", "closed_by_policy", "unchanged", "cancelled", "failed")
STEP_PHASE = {"router": "triage", "persona": "specialist", "tools": "evidence",
              "verdict": "verdict", "decision": "decision"}

@dataclass
class InvestigationHandle:
    run_id: str                  # the same inv-<hex> the audit rows carry
    signature: str               # internal only, never served
    case_id: str | None
    trigger: str
    requested_by: str | None     # normalized username, internal; served only as requested_by_me
    state: str = "queued"        # queued | running
    phase: str = "queued"
    queued_at: str
    started_at: str | None = None
    deadline_at: str | None = None   # started_at + caps.timeout_seconds (the model-call cap)
    time_cap_seconds: int = 0
    task: asyncio.Task | None = None # asyncio.current_task() at begin
    outcome: str | None = None
    status_after: str | None = None
    verdict_after: str | None = None
    close_replaced: dict | None = None   # {"by", "from_status", "to_status"} (4.5)

class InvestigationRegistry:
    def __init__(self, bus_getter, *, on_finished=None, recent_max=200, recent_ttl_s=120): ...
    def begin(self, *, run_id, signature, case_id, trigger, requested_by) -> InvestigationHandle
    def started(self, h, *, time_cap_seconds) -> None        # publish (state=running)
    def attach_case(self, h, case_id) -> None                 # publish if it was unknown
    def phase(self, h, step) -> None                          # update only, no frame
    def end(self, h, *, outcome, status=None, verdict=None) -> None   # publish finished, call on_finished
    def active(self) -> list[InvestigationHandle]             # prunes handles whose task is done
    def for_case(self, case_id) -> InvestigationHandle | None
    def recent(self) -> list[InvestigationHandle]             # finished within TTL, bounded
    def new_runs(self) -> int                                 # active handles with case_id None
    def clear(self) -> None                                   # factory reset
```

Wiring:

- **`AppState.__init__`** (next to `self.investigation_gate`, `state.py:208-210`): build
  `self.investigation_registry = InvestigationRegistry(lambda: self.event_bus,
  on_finished=self._investigation_finished)`. The registry lives on `AppState` so that a
  credential-driven `_wire()` rebuild of the pipeline (`state.py:1327`) keeps it.
- **The pipeline constructor** (`pipeline.py:270`) gets a new keyword
  `investigation_registry: Any = None`, post-settable like `review_sampler`. The real
  pipeline is given the AppState registry.
- **The Demo stack** (`demo_runtime.py:400-413`) builds its own registry bound to the Demo bus
  (`self.event_bus`). A property `AppState.investigations` returns the Demo or the real one,
  like `AppState.pipeline` (`state.py:852`).
- **The replay stack** passes none, so its runs are untracked.
- **Factory reset** calls `investigation_registry.clear()` after `cancel_mutation_tasks()`
  and `poller.stop()`. Shutdown needs nothing, because the process ends.

Pipeline changes (`agents/pipeline.py`):

- `investigate_cluster` and `_investigate_cluster_locked` gain keyword arguments:
  `trigger: str = "automatic"`, `requested_by: str | None = None`,
  `known_case_id: str | None = None`, `target_case_id: str | None = None` and
  `run_id: str | None = None`.
  - `ingest.handle_clusters` needs no change. It passes no new arguments, so the defaults
    apply. It already builds its call through `inspect.signature`, so stub pipelines keep
    working.
- `_investigate_cluster_locked` wraps the gate and the run:

  ```python
  reg = self.investigation_registry
  handle = reg.begin(run_id=run_id or new_id(INVESTIGATION_RUN_PREFIX), signature=cluster.signature,
                     case_id=known_case_id, trigger=trigger, requested_by=requested_by) if reg else None
  token = _CURRENT_INVESTIGATION.set(handle)
  try:
      async with gate.permit(...):            # unchanged
          if handle: reg.started(handle, time_cap_seconds=prefs.caps.timeout_seconds)
          case = await self._investigate_cluster_effect(..., run_id=handle.run_id if handle else None)
      if handle and handle.outcome is None:
          handle.outcome = "decided"
      return case
  except asyncio.CancelledError:
      if handle: handle.outcome = "cancelled"
      raise
  except Exception:
      if handle: handle.outcome = "failed"      # only the fail-to-human persist error propagates
      raise
  finally:
      if handle: reg.end(handle, outcome=handle.outcome or "failed")
      _CURRENT_INVESTIGATION.reset(token)
  ```

  `_investigate_cluster_effect` takes the `run_id` and sets `_INVESTIGATION_RUN_ID` to it
  (`:858`). The registry run id and the audit `run_id` are then the same value.
- In `_investigate_cluster_run`:
  - After `find_open_case_for_cluster` (`:882`), apply `target_case_id` (R5), then call
    `reg.attach_case(handle, case_id)`.
  - Set `handle.outcome` at the early returns: `"closed_by_policy"` (`:891`) and
    `"unchanged"` (`:918`).
  - After `save` (`:1225`), set `handle.status_after` and `handle.verdict_after`.
  - In the except path (`:1283`), set `handle.outcome = "routed_to_person"` and send the
    missing terminal frame: `self._emit_step(case_id, "decision", status="failed",
    detail=case.status.value)` (fixes F1).
- `_emit_step` (`:406`) also calls `reg.phase(_CURRENT_INVESTIGATION.get(), step)`. It sends
  no extra frame; the phase is served by GET and carried on the next state frame.
- Callers pass the trigger:
  - **`case_reinvestigate`** (`routes.py:8421`) and **`case_investigate`** (`:8347`):
    `trigger="manual"`, `requested_by=<principal username>`, `known_case_id=case_id` and
    `target_case_id=case_id`.
  - **`_case_reinvestigate`** (`jobs.py:737`): `trigger="job"`, `requested_by=job.actor`,
    `known_case_id=target_case_id=case_id`.
  - **`_drain_deferred`** (`poller_manager.py:503`): `trigger="drain"` and
    `known_case_id=case.case_id`.
  - **`_reenter_detections`** (`state.py:2145`): `trigger="detection"`.
  - **`handle_clusters`**: the default `automatic`. A known candidate's id can be passed as
    `known_case_id=existing.case_id if existing else None` (optional, through the same
    `inspect` guard).

**How a handle ends, for every way a run can end:**

| How the run ends | Who clears the handle | Outcome sent |
|---|---|---|
| Decision saved | `finally` in `_investigate_cluster_locked` | `decided` + `status_after`, `verdict_after` |
| Time cap (`asyncio.TimeoutError` at `:1067`) | same (the run returns NEEDS_HUMAN) | `decided` (verdict NEEDS_HUMAN) |
| Exception, routed to a person (`:1283`) | same | `routed_to_person` |
| Fail-to-human save failed (`RuntimeError` re-raised) | same | `failed` |
| Analyst policy close (`:891`) | same | `closed_by_policy` |
| No material change (`:918`) | same; never announced if it ends within the hold-off | `unchanged` |
| Cancelled: poller stop (`poller_manager.stop`), factory reset (`cancel_mutation_tasks`), job cancel at an item boundary, shutdown | same (`CancelledError` passes through `finally`) | `cancelled` |
| Process crash or restart | nothing to clear: the registry is memory only; the Console's reconcile GET returns empty | none (the client also expires a handle at `deadline_at + 60 s`, then re-reads GET) |
| Task ended without its `finally` (defensive) | `active()` drops any handle whose `task.done()` | none |

### 4.3 API

**`GET /api/investigations/active`**: a new router `api/routes_investigations.py`,
auto-discovered by `main.py::discover_feature_routers()`.

- It requires `cases:read`. It reads only memory: no audit row and no store read.
- It takes an optional `case_id` that narrows `items` and `recent`.
- In Demo Mode it reads the Demo registry.

```python
class InvestigationView(BaseModel):
    run_id: str
    case_id: str | None = None
    state: Literal["queued", "running", "finished"]
    phase: Literal["queued", "triage", "specialist", "evidence", "verdict", "decision"]
    trigger: Literal["automatic", "manual", "job", "drain", "detection"]
    queued_at: str
    started_at: str | None = None
    deadline_at: str | None = None
    time_cap_seconds: int
    requested_by_me: bool = False
    outcome: Literal["decided", "routed_to_person", "closed_by_policy", "unchanged", "cancelled", "failed"] | None = None
    finished_at: str | None = None
    status_after: str | None = None      # CaseStatus value
    verdict_after: str | None = None     # Verdict value

class InvestigationSlots(BaseModel):
    in_use: int                          # InvestigationGate.active
    cap: int                             # caps.max_concurrent

class InvestigationsActive(BaseModel):
    items: list[InvestigationView]       # queued or running, case known
    recent: list[InvestigationView]      # finished in the last 120 s (reconnect, toasts)
    new_runs: int                        # runs whose case does not exist yet (count only)
    slots: InvestigationSlots
    process_local: bool = True
    generated_at: str
```

**`POST /api/cases/{id}/reinvestigate`** (`routes.py:8363`), additive:

- Body `ReinvestigateRequest` gains `wait: bool = True`. The default keeps today's blocking
  contract for scripts and tests.
- If `investigations.for_case(case_id)` is active, answer
  `409 {"code": "investigation_running", "run": <InvestigationView>}`. This is checked before
  the audit row and before the cluster rebuild. Today a second click queues a second paid run
  behind the signature lock.
- With `wait=false`:
  1. rebuild the cluster in the request, as today, so "no stored evidence" is still a `400`;
  2. write the existing "manual reinvestigation requested by ..." audit row;
  3. mint the `run_id`;
  4. start `pipeline.investigate_cluster(...)` with
     `state.spawn_mutation_task(coro, name=f"case-reinvestigate:{case_id}")`
     (`state.py:320`), so factory reset can cancel it;
  5. answer `202 {"run_id", "case_id", "state": "queued"}`.
- The same `wait` flag can be added to `POST /api/cases/{id}/investigate` (optional).

**`_case_view`** (`routes.py:6390`, used by the single-case mutation responses, which have no
`response_model`):

- It adds a read-time key `"investigation": InvestigationView | None` to the returned dict. A
  Close response then says at once that a run is in flight.
- `GET /api/cases/{id}` has `response_model=Case`, so it is left alone. A dict key would be
  filtered out there, and a field on `Case` would be persisted by `save`. The detail view uses
  the GET above instead.

### 4.4 SSE frame

- **Registry and constants.** In `realtime.py`, add `CASE_INVESTIGATION_EVENT =
  "case.investigation"` to `SSE_EVENT_TYPES` (`realtime.py:93-115`) together with a
  `publish_case_investigation(bus, view)` helper.
- **Client and tests.** The client channel list `STREAM_CHANNELS`
  (`webui/src/lib/useEventStream.ts`, after `'case.review'`) and both registry tests
  (`backend/tests/test_sse_agent_step_channel.py`, `webui/src/lib/__tests__/useEventStream.test.tsx`)
  are updated together.
- **Topics.** Frames go on `cases` (served only with `cases:read`, `routes.py:451-455`), and
  on `cases:{case_id}` when the case is known. They are published with `retain=False`.
- **Payload.** The `InvestigationView` fields above minus `requested_by_me` (a broadcast
  cannot be personal), plus `active` (the number of queued or running runs) and `new_runs`.
  - Values are ids, enums, ISO timestamps and integers only.
  - A test pins the exact key set.
- **When frames are sent:**
  - on `started`;
  - on `attach_case` when the case was unknown;
  - on `end`.
  - A `queued` frame is sent only when the gate was saturated at `begin`
    (`gate.active >= cap`), so ordinary runs send two frames.
  - The volume is bounded by `caps.max_auto_investigations_per_tick` (25) and
    `caps.max_concurrent` (3).

### 4.5 Notifications and audit

`AppState._investigation_finished(handle)` is started with `spawn_mutation_task`, so it never
blocks the pipeline and factory reset can cancel it. It writes:

1. **To the requester of a manual run** (`trigger == "manual"` and `requested_by` set), when
   `_inapp_allows(state, name)` permits (the same check as `routes_auto_close_review.py:426`):
   - one Inbox item, category `system`, `case_id` and `url=f"/cases/{case_id}"`,
     `ref={"kind": "investigation", "run_id": ...}`;
   - a targeted `inapp` frame on `notifications`, then an `INAPP_NOTIFY` audit row (the
     pattern at `routes_auto_close_review.py:452-475`).

   Copy, built from enums only:
   - title: "AI investigation finished on case CASE-0042";
   - body: "Verdict: Needs a person. Status: Open, awaiting analyst.";
   - body for `routed_to_person`: "The investigation could not finish, so the case was routed
     to a person. Status: Open, awaiting analyst.";
   - body for `cancelled`: "The investigation was stopped before it finished. The case was
     not changed."

   Job runs are skipped, because the job's own Inbox row already reports completion.
   Automatic runs are skipped too, because the existing dispatcher triggers (`case_created`,
   `escalated`, `needs_human`) already cover them and more items would be noise.
2. **To a person whose close was replaced.** In `_investigate_cluster_run`, keep the status
   read when the run began. After the re-read at `:1184`, check:
   - the stored status is now terminal, and it was not terminal when the run began;
   - the newest `status_history` entry naming that status has a `by` that is not
     `agent`/`system`/`analyst_policy`;
   - after `apply()`, `case.status` differs from it.

   When all three hold, set
   `handle.close_replaced = {"by", "from_status", "to_status"}`. The hook then writes:
   - one audit row `action="case.close_replaced"`, actor `pipeline`, `actor_type="system"`,
     `case_id`, `tool_input={"run_id", "closed_by", "from_status", "to_status"}`. Add it to
     `backend/app/audit/event_categories.json` under `case_work`, label "Close replaced by an
     AI investigation".
   - one Inbox item to `by`, category `assignment` (the category the review-disagreement
     notice uses, so no new preference row is needed):
     - title: "An AI investigation replaced your close of case CASE-0042";
     - body: "It was already running when you closed the case. It finished with the verdict
       Needs a person and set the status to Open, awaiting analyst. Your disposition and
       note are kept."

   This runs after `apply()` and `save`, and it reads only decided values (#3).

### 4.6 Console placements and copy

All new UI code lives in lazy case-page modules:

- `lib/api-investigations.ts`;
- `lib/types-investigations.ts`;
- `soc/investigations/store.ts`, a small `useSyncExternalStore` store keyed by case id that
  also holds `newRuns` and `slots`.

The only entry-chunk cost is the channel string in `STREAM_CHANNELS` (about 25 B). The
headroom over the 329,080 B baseline is about 1,011 B (AGENTS.md §10).

The store is fed by three sources:

- **On load and reconnect:** `GET /api/investigations/active` runs on mount, on stream
  reconnect, and on an `overflow` frame.
- **Frames:** `case.investigation` frames relayed from the Case Manager's existing
  `useEventStream(['cases','jobs'])` (`CaseManager.tsx:1421`), and from the shared case room
  (R9).
- **Polling fallback:** without a live stream, it polls every 5 s while any run is known.

A handle expires on the client at `deadline_at + 60 s`, and the store then re-reads.

1. **Queue row** (`CaseManager.tsx` `QueueRow`, status node `:406-414`):
   - While the row's case is queued or running (after the 1 s hold-off), the status glyph is
     replaced with the existing turning `ActivityGlyph status="running"`
     (`soc/chat-activity/glyph.tsx`), and short text follows the status: "AI working", or
     "AI queued".
   - The accessible name gains ", AI investigation running, started 40 seconds ago".
   - The row stays clickable, and no width is added (the text truncates like the status).
2. **Queue control band:**
   - When `newRuns > 0`, one quiet, polite line: "AI is investigating 2 new alerts. They join
     the queue when the investigation finishes."
   - Hidden at 0. No new band height when the band can hold it inline.
3. **Case header meta row** (`casedetail/CaseHeaderMeta.tsx:138`, after the AI verdict chip):
   an `AiRunChip` with the turning glyph and "AI working · 0:42" (elapsed since `started_at`,
   ticking each second). The operator asked for less wasted space at the top of the case
   pane, and this adds no row. While a run is in flight, the existing verdict chip is dimmed
   (`opacity-60`) with the tooltip "Previous verdict. The running investigation replaces it."

   Clicking the chip opens a popover:
   - **Title:** "AI investigation running" (queued: "AI investigation waiting").
   - **Step list** with the current step marked:
     1. Triage
     2. Specialist and runbook
     3. Looking up evidence
     4. Verdict
     5. Deciding
   - **Origin line,** depending on the trigger:
     - "You started it."
     - "Started automatically for new events on this case."
     - "Part of a bulk reinvestigation."
     - "Started when an investigation slot came free."
     - "Started by event detection."
   - **Time line:** "Started 42 s ago. The time cap for an investigation is 2 min." This uses
     `time_cap_seconds` and states the cap, not a promised end time. The post-decision hooks
     run after the cap.
   - **Queued line:** "Waiting for a free slot: 3 of 3 investigations are running. The time
     cap starts when it begins."
   - **If you act now:** "If you close or change the status before it finishes, its result
     sets the status again. Your disposition, note, actions taken, comments and screenshots
     are kept."
   - **Link:** "See its steps in the audit log" goes to the audit page filtered to this case
     with the Agent activity scope (needs `audit:view`). `GET /api/audit` has no `run_id`
     filter today, so an exact run link needs R13.
4. **Take action menu** (`CaseDetail.tsx:2041-2056`): Reinvestigate is disabled while a run is
   in flight, with the hint "An AI investigation is already running."
5. **Reinvestigate dialog** (`CaseDetail.tsx:2556-2615`):
   - It sends `wait: false`, closes on the `202`, and shows the chip right away.
   - Its description becomes "Runs a fresh AI investigation. It can take up to the
     investigation time cap (2 min). You can keep working; the result appears on the case
     when it finishes."
   - A `409 investigation_running` answer shows the toast "An AI investigation is already
     running on this case."
6. **Close dialog** (`casedetail/ConfirmActionDialog.tsx:168`): a new prop
   `aiRun?: InvestigationView | null`.
   - **When the action moves the status** (close, resolve, confirm FP, escalate, hold,
     reopen, set status), show a warning `Alert` at the top:
     - Title: "The AI is still investigating this case"
     - Body: "When the investigation finishes, its result sets the status again, so this
       close may not last. Your disposition, note, actions taken and screenshots are kept.
       You can close now or wait for the result."
   - **Nothing is blocked.** The submit stays enabled, as the brief requires.
   - **If the run finishes while the dialog is open,** the Alert becomes an info note: "The AI
     investigation finished. The verdict is now Needs a person. Check it before you close."
7. **Bulk close** (`casedetail/BulkCloseDialog.tsx` and the Case Manager bulk confirm): "2 of
   the selected cases have an AI investigation running. Their results replace this close when
   they finish."
8. **On finish, in the console where the case is open:**
   - A polite live-region announcement: "AI investigation finished: Needs a person."
   - A toast only for the viewer's own manual run, or when the status changed under the
     viewer: "AI investigation finished on CASE-0042: Needs a person."
   - The case itself refreshes through the existing `case.changed` path.
   - On other pages, the Inbox item and the bell count (NotificationBell already refreshes on
     `inapp`) carry the news.
9. **Activity narration** (`CaseActivityFeed.tsx:200-224`):
   - The heading becomes "Investigation finished" after a `decision` frame (`done` or
     `failed`).
   - The steps clear on the next `router` frame.

### 4.7 Multi-replica limits (honest)

The registry, the gate and the SSE bus are all process-local. The project already documents
this as a single-replica requirement: DEPLOY.md:818-822 for chat turns, and
`docs/operations/background-jobs.md:214-219` ("Investigation concurrency, the
background-versus-ingest priority gate ... realtime fan-out ... remain process-local. Operate
one backend replica."). With two replicas:

- a Console served by replica B shows no indicator for a run on replica A;
- the `409` duplicate guard cannot see A's run;
- A's frames never reach B's subscribers.

The response carries `process_local: true` so a client or operator can see this. A
cross-replica design would need a KV lease document per case with a heartbeat (like the chat
reservation lease), written at run start and renewed while it runs. That belongs with the
Epoch E scale-out work, not this round.

## 5. Recommendations

| ID | Title | What and where | Value | Effort | Risks | How to test |
|---|---|---|---|---|---|---|
| R1 | Investigation registry and pipeline lifecycle | New `engine/investigation_registry.py`; `AppState.__init__` builds it; pipeline keywords and the `_investigate_cluster_locked` wrapper (4.2); Demo registry in `demo_runtime.py:400`; `clear()` on factory reset | High | M | Touches the pipeline spine. Keep it additive: every new keyword defaults so `handle_clusters` and stubs are unchanged. The registry must never raise into the run (wrap each call) | Unit: begin, started, end; `active()` prunes done tasks; recent ring bound and TTL. Pipeline: outcomes for decided, routed_to_person (monkeypatch `run_investigation` to raise), cancelled (cancel a task blocked in `run_investigation`; registry empty afterwards), unchanged (P1 path), closed_by_policy. Queued: cap 1, hold a permit, assert `state == "queued"`, then running. Run id equals the audit `run_id`. Existing `decide()` byte-identity guards stay green |
| R2 | `case.investigation` SSE frame and `GET /api/investigations/active` | `realtime.py` constant and helper; `routes_investigations.py`; typed models; `npm run gen:types` | High | S | Leaks case ids and triggers to `cases:read` holders, the same exposure as `case.changed`. Under the opt-in object scope (`rbac/policy.py` `can_object`, OFF) both should filter later | Exact payload key set; topics `cases` and `cases:{id}`; not retained; 403 without `cases:read` (RBAC on); Demo split; `process_local` true; registry-list tests on both ends |
| R3 | Terminal frame on failure and a narration that ends | `pipeline.py` except path `_emit_step("decision", status="failed")`; `CaseActivityFeed` heading and clearing | Medium | S | None | Backend: frame list ends with `decision` `failed` (flip probe F1). Vitest: heading after a `decision` frame |
| R4 | Non-blocking Reinvestigate with a duplicate guard | `ReinvestigateRequest.wait`, `202` through `spawn_mutation_task`, `409 investigation_running` (`routes.py:8363-8424`); dialog copy and behaviour (`CaseDetail.tsx:1579`, `:2556`) | High | M | A failure after the `202` arrives as a fail-to-human case plus an Inbox item, never as an HTTP error. The `wait=true` default keeps old callers | `202` shape; a second call answers `409` with the run; audit "requested by" row is written before the run; factory reset cancels the spawned run and empties the registry; Vitest: the dialog closes on `202` and the toast fires on `409` |
| R5 | Reinvestigate a closed case in place | `target_case_id`: after `find_open_case_for_cluster` (`pipeline.py:882`), when the target is given and not returned, `await self._cases.get(target)` and use it if its `cluster_signature` matches the cluster's signature or legacy signature. Callers: the reinvestigate routes and the job | High | S | Behaviour change (CHANGELOG): a reinvestigated closed case may reopen. `apply()` decides as for any run (#3). Closes the Round 15 follow-up | Flip probe F6: same `case_id`, a `closed -> ...` transition appended; no second case in the store; the queued-then-closed race keeps one case |
| R6 | Queue row mark and header chip with popover | `soc/investigations/store.ts`; `QueueRow` status node; `CaseHeaderMeta` `AiRunChip`; verdict chip dimming; copy from 4.6 | High | M | Copy must not say "Investigating" alone (F8). 1 s hold-off to avoid flicker in Demo | Vitest: the row's accessible name; chip text and timer; popover per trigger and queued; reduced motion keeps a static ring; screenshot in light and dark |
| R7 | Close-dialog and bulk-close warning | `ConfirmActionDialog` `aiRun` prop; `BulkCloseDialog`; the Case Manager bulk confirm | High | S | Must not block the action | Vitest: the Alert shows for status-moving actions only; it switches to the finished note when the store ends the run; the submit stays enabled |
| R8 | Finish notifications and the close-replaced record | `AppState._investigation_finished`; Inbox items through `inbox.fanout`; `inapp` frame; `case.close_replaced` audit action and `event_categories.json` entry | High | M | Inbox noise; limited to manual requesters and replaced closes. Respect `_inapp_allows` | Close mid-run (as in probe F5): one Inbox item to `bob`, one `case.close_replaced` row, no item for automatic runs, no item for job runs; audit categories JSON test |
| R9 | One shared case-room stream | A leader module like `soc/runbooks/run/live.ts`: one `cases:{id}` subscription per open case, mounted by `CaseDetail` regardless of tab, fanning frames to CaseThread, CaseActivityFeed and the chip | Medium | M | Refactors two live consumers; keep their props | Vitest: one EventSource per case while Thread and Activity are both mounted; frames still reach both; chip works on the Overview tab in the Cases page sheet |
| R10 | "New alerts under investigation" count | Case Manager control band, from `new_runs` | Medium | S | None | Vitest: hidden at 0, the line at N, polite live region |
| R11 | Close the lost-update window (F5b) | A process-local per-case `asyncio.Lock` registry on `AppState`: the pipeline holds it from the re-read (`:1184`) to `save` (`:1225`), and `_perform_case_action` and the collaboration writers hold it across read and save. Durable optimistic concurrency (Elasticsearch `if_seq_no`/`if_primary_term`, a revision field on SQL JSON rows) is the multi-replica answer and is L | Medium | M | Lock ordering with the signature lock: take the case lock only inside it, never the reverse | A concurrent close injected during the ledger read (monkeypatch `recorded_case_pipeline_cost` to await a close) survives in `status_history` |
| R12 | Navigation glyph | The Case Manager nav item shows the turning glyph while any run is active | Low | S | Needs a shell-level source (JobMonitor's stream has no `cases` topic); costs entry bytes. Optional | Vitest on the nav item; bundle-first-paint budget |
| R13 | Audit deep link to one run | `GET /api/audit` `run_id` filter (`api/routes_audit.py:466`); popover link `#/audit?run_id=` | Low | S | None | Route test; link test |
| R14 | Cross-replica lease | KV lease per case with heartbeat | Low now | L | Out of scope for the single-replica profile | n/a this round |
| R15 | Stop an AI run | A "Stop" in the popover that cancels the task | Low | L | Partial spend is ledgered but not added to `Case.token_cost` on cancel; needs its own design | n/a this round |

## 6. Test plan (gates)

- **Backend.** A new `backend/tests/test_round16_investigation_registry.py` covers R1 to R5,
  R8 and R11, built from the probes in section 3, with their assertions flipped where a fix
  lands (F1, F6). The registry update in `test_sse_agent_step_channel.py` is pinned, and the
  existing `test_round15_wp1_carry.py` stays green. `decide()` byte-identity and
  `engine/risk.py` untouched guards stay green. Run `pytest -q` in full.
- **Webui.**
  - Vitest for the store reducer: a frame, a finish, an expiry at `deadline_at + 60 s`, and
    reconcile with GET.
  - Vitest for QueueRow, CaseHeaderMeta, ConfirmActionDialog, CaseActivityFeed and the
    Reinvestigate dialog.
  - The `useEventStream.test.tsx` channel registry.
  - `npm run gen:types` then `check:types`; `npm run test:strict`; `npm run lint`;
    `npm run build`, including the bundle-first-paint budget.
- **Manual, in seeded Demo Mode.**
  - Open a case.
  - Reinvestigate, then confirm all of these:
    - the dialog closes;
    - the chip shows the phases;
    - the close dialog warns;
    - closing during the run is replaced;
    - the replaced-close Inbox item arrives.
  - Restart the backend mid-run and check that the chip clears within one reconcile.

## 7. Open decisions for the SPEC

1. **Queued-then-closed.** With R5, a manual or job run rebuilds the target case even if a
   person closed it while the run was queued, so the AI result is authoritative. For an
   automatic drain of a candidate that a person closed before it started, I recommend
   skipping the run instead: no spend, outcome `unchanged`, recorded as "closed by a person
   before the run started".
2. **A toast for the requester on other pages.** The Inbox item plus the bell is the
   proposal. A toast there would need NotificationBell (entry chunk) to read an
   `inapp` `kind: "investigation"` field, about 150 B.
3. **Exposing the requester's name.** The proposal serves only `requested_by_me`. The audit
   row already names the requester for `audit:view` holders.

## 8. External references

- **Microsoft Defender automated investigations** use explicit states: "Starting" ("The
  investigation has been triggered and is waiting to start running"), "Running", "Pending
  action" and "Terminated by system". This supports separate queued and running states.
  <https://learn.microsoft.com/en-us/defender-office-365/air-view-investigation-results>,
  <https://learn.microsoft.com/en-us/defender-endpoint/autoir-investigation-results>
- **The Google Security Operations Triage and Investigation Agent** has a case banner that
  "indicates progress" while a run is in flight and shows a verdict summary when it finishes.
  In-progress investigations can be found "from anywhere" through a navigation panel. The page
  states "There's no investigation queue". My fetch of the page read "an average of 60 seconds
  and runs for a maximum of 20 minutes", while a search summary of a different version said
  3 to 5 minutes, so the typical duration is unverified.
  <https://docs.cloud.google.com/chronicle/docs/secops/triage-agent>
- **Splunk SOAR** run statuses are "failed, pending, running, success", and starting a run
  through the API "will only queue the playbook to run".
  <https://docs.splunk.com/Documentation/SOAR/current/PlatformAPI/RESTRunPlaybook>
- **Response-time limits (0.1 s, 1 s, 10 s).** Show progress for waits over 10 s, and
  Nielsen's later advice is to hold a busy indicator back for about the first second (from a
  search summary; I did not read the full article).
  <https://www.nngroup.com/articles/website-response-times/>,
  <https://www.nngroup.com/videos/3-response-time-limits-interaction-design/>
- **SSE over HTTP/1.1** is limited to 6 open connections per browser and domain; HTTP/2
  negotiates about 100 streams.
  <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>;
  the Mozilla bug asking to exempt EventSource was closed WONTFIX:
  <https://bugzilla.mozilla.org/show_bug.cgi?id=906896>
- **Elasticsearch optimistic concurrency** (`if_seq_no`/`if_primary_term`, which answer 409
  on conflict) is the durable fix for F5b.
  <https://www.elastic.co/guide/en/elasticsearch/reference/8.19/optimistic-concurrency-control.html>
