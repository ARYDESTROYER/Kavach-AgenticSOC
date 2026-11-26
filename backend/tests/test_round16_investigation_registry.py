"""Round 16 WP08: AI run tracking (SPEC §4.5 WP08, D10; research ``ai-investigating``).

The server knows which investigations are queued or running and how each ended: the
pipeline registers a run before the investigation gate and ends it in a ``finally``; a
failed run now sends its terminal frame (probe F1); a closed case is reinvestigated in
place (probe F6) unless an open case holds its signature (``409 open_case_exists``); a
close made while the run was in flight is replaced by its result and reported (probe
F5: one Inbox item, one ``case.close_replaced`` row); a second Reinvestigate answers
``409 investigation_running``; ``wait=false`` answers ``202``; a deferred candidate a
person closed while its drain run waited is never re-run nor duplicated; a per-case
write lock keeps a person's action and a run's save from erasing each other, and the
attach path re-reads the case under it.

``decide()`` and ``engine/risk.py`` are untouched (``test_round16_spine_guards.py``); no
model call is added. Offline: fake Elasticsearch, mock model.
"""

from __future__ import annotations

import asyncio
import gc
import inspect
import json
import time
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import app.agents.pipeline as pipeline_mod
from app.agents.pipeline import CaseLocks, replaced_close
from app.api.deps import require_auth
from app.config import Secrets
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.ingest import attach_cluster
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Cluster, Entity, StatusHistoryEntry, VerdictResult
from app.realtime import AGENT_STEP_EVENT, CASE_INVESTIGATION_EVENT, CASE_INVESTIGATION_FRAME_KEYS
from app.state import AppState
from app.utils import iso_now
from tests._auth_helpers import ready_user
from tests.conftest import mount_moved_routers
from tests.test_case_actions_reinvestigate import _create_case, _final_verdict, _route_to_investigator


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
class _Bus:
    """Records every frame the registry and the pipeline publish."""

    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = []
        self.steps: list[dict[str, Any]] = []
        self.targeted: list[tuple[str, str, dict[str, Any], Any]] = []

    def publish_many(self, topics, event_type, data, *, audience=None, retain=True):
        self.frames.append({"topics": tuple(topics), "type": event_type, "data": dict(data),
                            "retain": retain, "audience": audience})
        return str(len(self.frames))

    def publish(self, topic, event_type, data, *, audience=None, retain=True):
        if event_type == AGENT_STEP_EVENT:
            self.steps.append(dict(data))
        else:
            self.targeted.append((topic, event_type, dict(data), audience))
        return "x"


@pytest.fixture
def bus(app_state, monkeypatch) -> _Bus:
    recorder = _Bus()
    monkeypatch.setattr(app_state.investigation_registry, "_bus_getter", lambda: recorder)
    monkeypatch.setattr(app_state.pipeline, "event_bus", recorder)
    return recorder


def _cluster(sig: str = "sig-r16-run", ip: str = "192.0.2.80") -> Cluster:
    return Cluster(signature=sig, entity=Entity(type=EntityType.IP, value=ip),
                   group_by=EntityType.IP, rule_values=["linux_auth"], risk_score=40.0,
                   member_event_ids=[f"{sig}-e1"])


def _quiet(app_state, **caps: Any):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.enrichment.enabled = False
    for key, value in caps.items():
        setattr(prefs.caps, key, value)
    return prefs


def _candidate(sig: str = "sig-r16-run", case_id: str = "case-r16", **extra: Any) -> Case:
    fields: dict[str, Any] = {
        "case_id": case_id, "case_number": "CASE-0042", "cluster_signature": sig,
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="192.0.2.80"),
        "member_event_ids": [f"{sig}-e1"], "status": CaseStatus.OPEN, "risk_score": 40.0,
        "created_at": iso_now(), "updated_at": iso_now(),
    }
    fields.update(extra)
    return Case(**fields)


def _verdict(kind: Verdict = Verdict.NEEDS_HUMAN) -> VerdictResult:
    return VerdictResult(verdict=kind, confidence=0.3, recommended_action="look")


def _patch_run(monkeypatch, fn) -> None:
    monkeypatch.setattr(pipeline_mod, "run_investigation", fn)


async def _no_model(*_args, **_kwargs):
    raise AssertionError("the run must not reach the investigation graph")


async def _close_as(app_state, case_id: str, who: str = "bob") -> None:
    from app.api.routes import CaseAction, _perform_case_action

    await _perform_case_action(case_id, CaseAction(action="close", note="done"), who, app_state)


async def _drain_notices(app_state) -> None:
    for _ in range(5):
        tasks = [t for t in list(app_state._mutation_tasks) if not t.done()]  # noqa: SLF001
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)


async def _cases_with_signature(app_state, sig: str) -> list[Case]:
    items, _total = await app_state.cases.list(limit=500)
    return [c for c in items if c.cluster_signature == sig]


async def _inbox(store, user: str) -> list[Any]:
    items, _unread = await store.list_for_user(user)
    return list(items)


async def _wait_for(predicate, *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


# --------------------------------------------------------------------------- #
# Probe F1: a failed run sends its terminal frame
# --------------------------------------------------------------------------- #
async def test_a_failed_run_sends_a_terminal_decision_frame(app_state, bus, monkeypatch) -> None:
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("provider fell over")

    _patch_run(monkeypatch, _boom)
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    assert case.status == CaseStatus.NEEDS_HUMAN and case.error
    last = bus.steps[-1]
    assert (last["step"], last["status"], last["detail"]) == ("decision", "failed", "needs_human")
    finished = app_state.investigation_registry.recent()[-1]
    assert (finished.outcome, finished.status_after, finished.case_id) == (
        "routed_to_person", "needs_human", case.case_id,
    )
    assert app_state.investigation_registry.active() == []


# --------------------------------------------------------------------------- #
# The run lifecycle and the frames
# --------------------------------------------------------------------------- #
async def test_a_run_is_registered_then_ended_with_exact_frames(app_state, bus, monkeypatch) -> None:
    seen: list[Any] = []

    async def _run(*_args, **_kwargs):
        seen.extend((h.state, h.phase, h.case_id, h.trigger)
                    for h in app_state.investigation_registry.active())
        return _verdict(), 0.0

    _patch_run(monkeypatch, _run)
    await app_state.cases.save(_candidate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), known_case_id="case-r16",
    )
    assert seen == [("running", "evidence", case.case_id, "automatic")]
    frames = [f for f in bus.frames if f["type"] == CASE_INVESTIGATION_EVENT]
    assert [f["data"]["state"] for f in frames] == ["running", "finished"]
    for frame in frames:
        assert set(frame["data"]) == set(CASE_INVESTIGATION_FRAME_KEYS)
        assert "requested_by" not in frame["data"] and "requested_by_you" not in frame["data"]
        assert frame["retain"] is False
        assert frame["topics"] == ("cases", f"cases:{case.case_id}", "investigations")
    end = frames[-1]["data"]
    assert (end["outcome"], end["status_after"], end["verdict_after"], end["active"]) == (
        "decided", "needs_human", "NEEDS_HUMAN", 0,
    )


async def test_a_running_frame_never_says_the_queued_phase(app_state, bus, monkeypatch) -> None:
    """``queued`` is the phase of a run waiting for a slot. Once the run holds a slot,
    its running frame names the first stage (triage), so a client that reads only the
    frames never shows a running run as queued."""
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    prefs = _quiet(app_state, max_concurrent=1)
    async with app_state.investigation_gate.permit(1):
        task = asyncio.create_task(app_state.pipeline.investigate_cluster(
            _cluster(), SourceSurface.AUTOMATED_SCAN, prefs, known_case_id="case-r16",
        ))
        await _wait_for(lambda: bool(app_state.investigation_registry.active()))
    await task
    states = [(f["data"]["state"], f["data"]["phase"]) for f in bus.frames]
    assert states[0] == ("queued", "queued")
    assert states[1] == ("running", "triage")
    assert all(phase != "queued" for state, phase in states if state != "queued")


async def test_a_run_on_new_events_attaches_its_case_late(app_state, bus, monkeypatch) -> None:
    async def _run(*_args, **_kwargs):
        handle = app_state.investigation_registry.active()[0]
        assert handle.case_id is None and app_state.investigation_registry.new_runs() == 1
        return _verdict(), 0.0

    _patch_run(monkeypatch, _run)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("sig-new-events"), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    frames = [f["data"] for f in bus.frames]
    assert [(f["state"], f["case_id"]) for f in frames] == [
        ("running", None), ("running", case.case_id), ("finished", case.case_id),
    ]
    assert frames[0]["new_runs"] == 1


async def test_the_run_id_is_the_audit_run_id(app_state, bus, monkeypatch) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), run_id="inv-fixed-run",
    )
    handle = app_state.investigation_registry.recent()[-1]
    assert handle.run_id == "inv-fixed-run"
    rows = await app_state.audit.records_for_case("case-r16")
    pipeline_rows = [r for r in rows if r.get("actor") in {"case_manager", "procedure_provenance"}]
    assert pipeline_rows and {r.get("run_id") for r in pipeline_rows} == {"inv-fixed-run"}


async def _async(value):
    return value


async def test_cancellation_ends_the_run_and_frees_the_case_lock(app_state, bus, monkeypatch) -> None:
    started = asyncio.Event()

    async def _forever(*_args, **_kwargs):
        started.set()
        await asyncio.Event().wait()

    _patch_run(monkeypatch, _forever)
    await app_state.cases.save(_candidate())
    task = asyncio.create_task(app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    ))
    await asyncio.wait_for(started.wait(), 2)
    assert len(app_state.investigation_registry.active()) == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert app_state.investigation_registry.active() == []
    assert app_state.investigation_registry.recent()[-1].outcome == "cancelled"
    assert not app_state.case_lock("case-r16").locked()


async def test_a_run_waiting_for_a_full_gate_is_queued(app_state, bus, monkeypatch) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    prefs = _quiet(app_state, max_concurrent=1)
    gate = app_state.investigation_gate
    async with gate.permit(1):
        task = asyncio.create_task(app_state.pipeline.investigate_cluster(
            _cluster(), SourceSurface.AUTOMATED_SCAN, prefs,
        ))
        await _wait_for(lambda: bool(app_state.investigation_registry.active()))
        handle = app_state.investigation_registry.active()[0]
        assert (handle.state, handle.phase, handle.case_id) == ("queued", "queued", None)
        await asyncio.sleep(0.05)
        assert app_state.investigation_registry.active()[0].state == "queued"
    await task
    assert [f["data"]["state"] for f in bus.frames] == ["queued", "running", "running", "finished"]


async def test_the_registry_never_raises_into_a_run(app_state, monkeypatch) -> None:
    def _broken_bus():
        raise RuntimeError("bus down")

    monkeypatch.setattr(app_state.investigation_registry, "_bus_getter", _broken_bus)
    monkeypatch.setattr(app_state.investigation_registry, "_on_finished", lambda _h: 1 / 0)
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    case = await app_state.pipeline.investigate_cluster(
        _cluster("sig-robust"), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    assert case.status == CaseStatus.NEEDS_HUMAN


# --------------------------------------------------------------------------- #
# Probe F6 and R5: a closed case is reinvestigated in place
# --------------------------------------------------------------------------- #
async def test_reinvestigating_a_closed_case_updates_it_in_place(app_state, bus, monkeypatch) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    closed = _candidate(status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
                        decision_by=DecisionBy.AGENT)
    await app_state.cases.save(closed)
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), force=True,
        trigger="manual", requested_by="alice", known_case_id=closed.case_id,
        target_case_id=closed.case_id,
    )
    assert case.case_id == closed.case_id
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert [c.case_id for c in await _cases_with_signature(app_state, closed.cluster_signature)] == [
        closed.case_id,
    ]
    last = case.status_history[-1]
    assert (last.from_status, last.to_status) == ("closed", "needs_human")
    # A close made long before the run was asked for is not a replaced close.
    assert app_state.investigation_registry.recent()[-1].close_replaced is None


async def test_a_closed_target_is_not_reopened_when_an_open_case_holds_its_signature(
    app_state, bus, monkeypatch,
) -> None:
    _patch_run(monkeypatch, _no_model)
    closed = _candidate(status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE, case_id="case-x")
    holder = _candidate(case_id="case-y", case_number="CASE-0043")
    await app_state.cases.save(closed)
    await app_state.cases.save(holder)
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), force=True,
        trigger="manual", known_case_id="case-x", target_case_id="case-x",
    )
    assert (case.case_id, case.status) == ("case-x", CaseStatus.CLOSED)
    assert (await app_state.cases.get("case-x")).status == CaseStatus.CLOSED
    assert app_state.investigation_registry.recent()[-1].outcome == "unchanged"
    open_ones = [c for c in await _cases_with_signature(app_state, closed.cluster_signature)
                 if c.status != CaseStatus.CLOSED]
    assert [c.case_id for c in open_ones] == ["case-y"]


async def _job_outcomes(app_state, monkeypatch, case_ids: list[str]) -> dict[str, str]:
    from types import SimpleNamespace

    runner = app_state.job_runner
    outcomes: dict[str, str] = {}

    async def _items(job, _token, run, *, result_kind):
        for item in job.item_states:
            try:
                await run(item)
                outcomes[item] = "succeeded"
            except Exception as exc:  # noqa: BLE001 - the real loop isolates each item
                outcomes[item] = runner._reason(exc)  # noqa: SLF001

    async def _cluster_for(case):
        return _cluster(case.cluster_signature)

    monkeypatch.setattr(app_state, "cluster_for_case", _cluster_for)
    monkeypatch.setattr(runner, "_item_loop", _items)
    job = SimpleNamespace(job_id="job-r16", actor="ann", params={},
                          item_states={cid: "pending" for cid in case_ids})
    await runner._case_reinvestigate(job, "token")  # noqa: SLF001
    return outcomes


async def test_the_reinvestigate_job_fails_an_item_whose_signature_has_an_open_case(
    app_state, bus, monkeypatch,
) -> None:
    _patch_run(monkeypatch, _no_model)
    await app_state.cases.save(_candidate(status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
                                          case_id="case-x"))
    await app_state.cases.save(_candidate(case_id="case-y", case_number="CASE-0043"))
    outcomes = await _job_outcomes(app_state, monkeypatch, ["case-x"])
    assert outcomes["case-x"].startswith("open_case_exists: ")
    rows = await app_state.audit.records_for_case("case-x")
    assert not [r for r in rows if r.get("actor") == "reinvestigate"]


async def test_the_reinvestigate_job_tracks_its_runs_as_job_runs(app_state, bus, monkeypatch) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate(status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE))
    outcomes = await _job_outcomes(app_state, monkeypatch, ["case-r16"])
    assert outcomes == {"case-r16": "succeeded"}
    handle = app_state.investigation_registry.recent()[-1]
    assert (handle.trigger, handle.requested_by, handle.case_id) == ("job", "ann", "case-r16")
    assert (await app_state.cases.get("case-r16")).status == CaseStatus.NEEDS_HUMAN
    assert len(await _cases_with_signature(app_state, "sig-r16-run")) == 1


# --------------------------------------------------------------------------- #
# Probe F5 and R8: a close made during the run is replaced and reported
# --------------------------------------------------------------------------- #
async def test_a_close_made_during_the_run_is_replaced_and_reported(app_state, bus, monkeypatch) -> None:
    async def _run(*_args, **_kwargs):
        await _close_as(app_state, "case-r16", "bob")
        return _verdict(), 0.0

    _patch_run(monkeypatch, _run)
    await app_state.cases.save(_candidate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    await _drain_notices(app_state)
    assert case.status == CaseStatus.NEEDS_HUMAN
    moves = [(e.from_status, e.to_status, e.by) for e in case.status_history]
    assert ("open", "closed", "bob") in moves and moves[-1] == ("closed", "needs_human", "system")
    handle = app_state.investigation_registry.recent()[-1]
    assert handle.close_replaced == {"by": "bob", "from_status": "closed", "to_status": "needs_human"}
    items = await _inbox(app_state.inbox, "bob")
    assert len(items) == 1
    assert items[0].category == "assignment"
    assert items[0].title == "An AI investigation replaced your close of case CASE-0042"
    assert "Needs a person" in items[0].body and "Open, awaiting analyst" in items[0].body
    rows = [r for r in await app_state.audit.records_for_case("case-r16")
            if r.get("action") == "case.close_replaced"]
    assert len(rows) == 1
    assert rows[0]["tool_input"]["closed_by"] == "bob" and rows[0]["run_id"] == handle.run_id
    # An automatic run has no requester: nobody else gets an item.
    assert await _inbox(app_state.inbox, "alice") == []


async def test_job_and_automatic_runs_get_no_finish_notice(app_state, bus, monkeypatch) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), force=True,
        trigger="job", requested_by="alice", known_case_id="case-r16", target_case_id="case-r16",
    )
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), force=True,
    )
    await _drain_notices(app_state)
    assert await _inbox(app_state.inbox, "alice") == []
    assert [h.trigger for h in app_state.investigation_registry.recent()] == ["job", "automatic"]


async def test_the_requester_of_a_manual_run_gets_one_finish_notice(app_state, bus, monkeypatch) -> None:
    import app.realtime as realtime

    monkeypatch.setattr(realtime, "get_event_bus", lambda: bus)
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state), force=True,
        trigger="manual", requested_by="alice", known_case_id="case-r16", target_case_id="case-r16",
    )
    await _drain_notices(app_state)
    items = await _inbox(app_state.inbox, "alice")
    assert [(i.category, i.title, i.body) for i in items] == [(
        "system", "AI investigation finished on case CASE-0042",
        "Verdict: Needs a person. Status: Open, awaiting analyst.",
    )]
    assert items[0].ref == {"kind": "investigation", "run_id": app_state.investigation_registry.recent()[-1].run_id}
    assert [t for t in bus.targeted if t[0] == "notifications"][-1][3] == ["alice"]


def test_replaced_close_needs_a_person_and_a_close_made_while_the_run_was_asked_for() -> None:
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    stored = _candidate(status=CaseStatus.CLOSED, status_history=[StatusHistoryEntry(
        from_status="open", to_status="closed", by="bob", at=now.isoformat(),
    )])
    decided = stored.model_copy(update={"status": CaseStatus.NEEDS_HUMAN})
    assert replaced_close(stored, decided, since=now - timedelta(seconds=5)) == {
        "by": "bob", "from_status": "closed", "to_status": "needs_human",
    }
    assert replaced_close(stored, decided, since=now + timedelta(seconds=5)) is None
    assert replaced_close(stored, stored, since=now - timedelta(seconds=5)) is None
    by_code = stored.model_copy(update={"status_history": [StatusHistoryEntry(
        from_status="open", to_status="closed", by="analyst_policy", at=now.isoformat(),
    )]})
    assert replaced_close(by_code, decided, since=now - timedelta(seconds=5)) is None


# --------------------------------------------------------------------------- #
# R11: the per-case write lock
# --------------------------------------------------------------------------- #
async def test_a_close_injected_during_the_ledger_read_survives(app_state, bus, monkeypatch) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    gateway = app_state.pipeline._gateway  # noqa: SLF001
    original = gateway.recorded_case_pipeline_cost
    closes: list[asyncio.Task] = []

    async def _ledger_read(case_id):
        closes.append(asyncio.create_task(_close_as(app_state, case_id, "bob")))
        await asyncio.sleep(0.05)
        return await original(case_id)

    monkeypatch.setattr(gateway, "recorded_case_pipeline_cost", _ledger_read)
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    await asyncio.gather(*closes)
    stored = await app_state.cases.get("case-r16")
    assert ("needs_human", "closed", "bob") in [
        (e.from_status, e.to_status, e.by) for e in stored.status_history
    ]
    assert stored.status == CaseStatus.CLOSED


async def test_attach_racing_a_persons_close_keeps_the_close(app_state) -> None:
    await app_state.cases.save(_candidate(verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN))
    stale = await app_state.cases.get("case-r16")
    await _close_as(app_state, "case-r16", "bob")
    more = _cluster().model_copy(update={"member_event_ids": ["sig-r16-run-e1", "sig-r16-run-e2"]})
    attached = await attach_cluster(app_state.cases, stale, more, pipeline=app_state.pipeline)
    stored = await app_state.cases.get("case-r16")
    assert attached is True
    assert stored.status == CaseStatus.CLOSED
    assert "sig-r16-run-e2" in stored.member_event_ids
    assert stale.status == CaseStatus.CLOSED  # the caller's copy is what was saved


def test_every_attach_call_site_passes_the_pipeline() -> None:
    import app.engine.ingest as ingest_mod
    import app.engine.poller as poller_mod

    ingest_src = inspect.getsource(ingest_mod.handle_clusters)
    assert ingest_src.count("attach_cluster(") == 2
    assert ingest_src.count("pipeline=pipeline") >= 2
    assert "pipeline=self._pipeline" in inspect.getsource(poller_mod.Poller._attach)


async def test_the_case_lock_registry_holds_no_lock_after_its_users_finish(
    app_state, bus, monkeypatch,
) -> None:
    _patch_run(monkeypatch, lambda *_a, **_k: _async((_verdict(), 0.0)))
    await app_state.cases.save(_candidate())
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    await _close_as(app_state, "case-r16", "bob")
    gc.collect()
    assert len(app_state.case_locks) == 0
    locks = CaseLocks()
    first = locks.lock("a")
    assert locks.lock("a") is first and len(locks) == 1
    del first
    gc.collect()
    assert len(locks) == 0


# --------------------------------------------------------------------------- #
# D10: a drain run skips a candidate a person closed while it waited
# --------------------------------------------------------------------------- #
async def test_a_person_closes_a_deferred_candidate_while_its_drain_run_waits(
    app_state, bus, monkeypatch,
) -> None:
    _patch_run(monkeypatch, _no_model)
    candidate = _candidate(awaiting_reason="deferred: per-tick auto-investigation cap reached")
    await app_state.cases.save(candidate)
    prefs = _quiet(app_state, max_concurrent=1)
    async with app_state.investigation_gate.permit(1):
        task = asyncio.create_task(app_state.pipeline.investigate_cluster(
            _cluster(), SourceSurface.AUTOMATED_SCAN, prefs,
            trigger="drain", known_case_id=candidate.case_id,
        ))
        await _wait_for(lambda: bool(app_state.investigation_registry.active()))
        await _close_as(app_state, candidate.case_id, "bob")
    case = await task
    assert (case.case_id, case.status) == (candidate.case_id, CaseStatus.CLOSED)
    assert [c.case_id for c in await _cases_with_signature(app_state, candidate.cluster_signature)] == [
        candidate.case_id,
    ]
    assert app_state.investigation_registry.recent()[-1].outcome == "unchanged"


async def test_the_drain_passes_its_trigger_and_known_case(app_state, monkeypatch) -> None:
    from types import SimpleNamespace

    calls: list[dict[str, Any]] = []
    candidate = _candidate(awaiting_reason="deferred: per-tick auto-investigation cap reached",
                           created_at="2026-11-01T00:00:00+00:00", updated_at="2026-11-01T00:00:00+00:00")
    await app_state.real_cases.save(candidate)

    async def _cluster_for(case):
        return SimpleNamespace(signature=case.cluster_signature)

    async def _investigate(cluster, *_args, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(app_state, "cluster_for_case", _cluster_for)
    monkeypatch.setattr(app_state.real_pipeline, "investigate_cluster", _investigate)
    await app_state.poller._drain_deferred(  # noqa: SLF001
        app_state.prefs, older_than="2026-11-03T00:00:00+00:00", limit=1,
    )
    assert calls and calls[0]["trigger"] == "drain" and calls[0]["known_case_id"] == candidate.case_id


def test_event_detection_reentry_is_tracked_as_detection() -> None:
    assert 'trigger="detection"' in inspect.getsource(AppState._reenter_detections)  # noqa: SLF001


# --------------------------------------------------------------------------- #
# Factory reset and Demo Mode
# --------------------------------------------------------------------------- #
async def test_factory_reset_cancels_a_spawned_run_and_empties_the_registry(
    app_state, bus, monkeypatch,
) -> None:
    started = asyncio.Event()

    async def _forever(*_args, **_kwargs):
        started.set()
        await asyncio.Event().wait()

    _patch_run(monkeypatch, _forever)
    await app_state.cases.save(_candidate())
    task = app_state.spawn_mutation_task(app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    ), name="test-run")
    await asyncio.wait_for(started.wait(), 2)
    await app_state.cancel_mutation_tasks()
    assert task.cancelled()
    assert app_state.investigation_registry.active() == []
    assert app_state.investigation_registry.recent() == []
    assert len(app_state.case_locks) == 0


async def test_demo_mode_has_its_own_registry_and_notice_sinks(app_state, monkeypatch) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=0)
    demo = app_state._demo  # noqa: SLF001
    assert app_state.investigations is demo.investigation_registry
    assert app_state.investigations is not app_state.investigation_registry
    assert demo.pipeline.investigation_registry is demo.investigation_registry
    assert demo.pipeline.case_lock("c") is app_state.case_lock("c")

    async def _run(*_args, **_kwargs):
        await _close_as(app_state, "case-demo-r16", "bob")
        return _verdict(), 0.0

    _patch_run(monkeypatch, _run)
    await demo.cases.save(_candidate(case_id="case-demo-r16", cluster_signature="sig-demo-r16"))
    await demo.pipeline.investigate_cluster(
        _cluster("sig-demo-r16"), SourceSurface.AUTOMATED_SCAN, demo._demo_prefs(),  # noqa: SLF001
    )
    await _drain_notices(app_state)
    assert [h.case_id for h in demo.investigation_registry.recent()] == ["case-demo-r16"]
    assert app_state.investigation_registry.recent() == []
    demo_rows = [r for r in await demo.audit.records_for_case("case-demo-r16")
                 if r.get("action") == "case.close_replaced"]
    real_rows = [r for r in await app_state.real_audit.records_for_case("case-demo-r16")
                 if r.get("action") == "case.close_replaced"]
    assert len(demo_rows) == 1 and real_rows == []
    assert len(await _inbox(demo.inbox, "bob")) == 1
    assert await _inbox(app_state._real_inbox, "bob") == []  # noqa: SLF001
    await app_state.disable_demo()


async def test_a_real_run_notice_goes_to_the_real_sinks(app_state, bus, monkeypatch) -> None:
    async def _run(*_args, **_kwargs):
        await _close_as(app_state, "case-r16", "bob")
        return _verdict(), 0.0

    _patch_run(monkeypatch, _run)
    await app_state.cases.save(_candidate())
    await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet(app_state),
    )
    await _drain_notices(app_state)
    rows = [r for r in await app_state.real_audit.records_for_case("case-r16")
            if r.get("action") == "case.close_replaced"]
    assert len(rows) == 1
    assert len(await _inbox(app_state._real_inbox, "bob")) == 1  # noqa: SLF001


# --------------------------------------------------------------------------- #
# The routes
# --------------------------------------------------------------------------- #
def _app(secrets: Secrets, mock: MockProvider, *, rbac_denies: dict[str, list[str]] | None = None,
         auth: bool = False) -> FastAPI:
    from app.api.routes import router as monolith_router
    from app.api.routes_investigations import router as investigations_router

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        if rbac_denies is not None:
            prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={
                "enabled": True, "denies": {"analyst_tier1": rbac_denies},
            })})
        await state.update_prefs(prefs)
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else None
    api.include_router(monolith_router, **({"dependencies": deps} if deps else {}))
    api.include_router(investigations_router, **({"dependencies": deps} if deps else {}))
    mount_moved_routers(api, dependencies=deps)
    return api


@pytest.fixture
def api_client(secrets, mock_provider):
    with TestClient(_app(secrets, mock_provider)) as c:
        yield c


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _stored(client: TestClient, ip: str) -> list[Case]:
    items, _total = client.portal.call(
        lambda: _state(client).cases.list(entity_value=ip, limit=100),
    )
    return items


def _settle(client: TestClient) -> None:
    """Wait until no tracked background writer (``AppState.spawn_mutation_task``: the
    read-only lookups a runbook run starts on attach, the run notices) is pending, so an
    audit count taken next holds only rows already written. Under a loaded machine such a
    writer can still be adding ``step.evidence_collected`` rows after the request that
    started it has answered."""

    async def _drain() -> list[str]:
        state = _state(client)
        for _ in range(50):
            tasks = [t for t in list(state._mutation_tasks) if not t.done()]  # noqa: SLF001
            if not tasks:
                return []
            await asyncio.gather(*tasks, return_exceptions=True)
        return [t.get_name() for t in list(state._mutation_tasks) if not t.done()]  # noqa: SLF001

    assert client.portal.call(_drain) == []


def test_reinvestigating_a_closed_case_over_the_route_keeps_one_case(api_client, mock_provider) -> None:
    case_id = _create_case(api_client, mock_provider, "192.0.2.61")
    r = api_client.post(f"/api/cases/{case_id}/action", json={"action": "close"})
    assert r.status_code == 200, r.text
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.3))
    r = api_client.post(f"/api/cases/{case_id}/reinvestigate")
    assert r.status_code == 200, r.text
    assert r.json()["case_id"] == case_id and r.json()["status"] == "needs_human"
    assert [c.case_id for c in _stored(api_client, "192.0.2.61")] == [case_id]


def test_close_x_new_events_open_y_then_reinvestigate_x_answers_open_case_exists(
    api_client, mock_provider,
) -> None:
    x = _create_case(api_client, mock_provider, "192.0.2.62")
    assert api_client.post(f"/api/cases/{x}/action", json={"action": "close"}).status_code == 200
    y = _create_case(api_client, mock_provider, "192.0.2.62")
    assert y != x
    # X's runbook run may still be writing its on-attach lookup rows in the background:
    # count only once every background writer has finished, so the count holds only rows
    # written before the refused request.
    _settle(api_client)
    audit_before = len(api_client.portal.call(lambda: _state(api_client).audit.records_for_case(x)))
    r = api_client.post(f"/api/cases/{x}/reinvestigate")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "open_case_exists"
    assert r.json()["detail"]["case_id"] == y
    # The refused request writes no audit row, now or from a writer it left behind.
    _settle(api_client)
    assert len(api_client.portal.call(lambda: _state(api_client).audit.records_for_case(x))) == audit_before
    r = api_client.post(f"/api/cases/{x}/investigate")
    assert r.status_code == 409 and r.json()["detail"]["case_id"] == y
    mine = {c.case_id: c.status for c in _stored(api_client, "192.0.2.62")}
    assert set(mine) == {x, y} and mine[x] == CaseStatus.CLOSED
    assert sum(1 for status in mine.values() if status != CaseStatus.CLOSED) == 1


def test_a_second_reinvestigate_while_an_unattached_run_holds_the_signature_answers_409(
    api_client, mock_provider,
) -> None:
    case_id = _create_case(api_client, mock_provider, "192.0.2.63")
    case = api_client.portal.call(_state(api_client).cases.get, case_id)
    registry = _state(api_client).investigation_registry
    handle = registry.begin(run_id="inv-auto-unattached", signature=case.cluster_signature)
    try:
        r = api_client.post(f"/api/cases/{case_id}/reinvestigate", json={"wait": False})
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert detail["code"] == "investigation_running"
        assert (detail["run"]["run_id"], detail["run"]["case_id"], detail["run"]["trigger"]) == (
            "inv-auto-unattached", None, "automatic",
        )
    finally:
        registry.end(handle, outcome="cancelled")


def test_wait_false_answers_202_and_a_second_request_answers_409(
    api_client, mock_provider, monkeypatch,
) -> None:
    case_id = _create_case(api_client, mock_provider, "192.0.2.64")
    release = {"event": None}

    async def _hold(*_args, **_kwargs):
        release["event"] = asyncio.Event()
        await release["event"].wait()
        return _verdict(), 0.0

    monkeypatch.setattr(pipeline_mod, "run_investigation", _hold)
    r = api_client.post(f"/api/cases/{case_id}/reinvestigate", json={"wait": False})
    assert r.status_code == 202, r.text
    body = r.json()
    assert set(body) == {"run_id", "case_id", "state"}
    assert body["case_id"] == case_id and body["state"] == "queued" and body["run_id"].startswith("inv-")
    second = api_client.post(f"/api/cases/{case_id}/reinvestigate", json={"wait": False})
    assert second.status_code == 409 and second.json()["detail"]["run"]["run_id"] == body["run_id"]
    for _ in range(100):
        active = api_client.get("/api/investigations/active", params={"case_id": case_id}).json()
        if active["items"] and active["items"][0]["state"] == "running":
            break
        time.sleep(0.02)
    assert active["items"][0]["run_id"] == body["run_id"]
    assert active["items"][0]["trigger"] == "manual" and active["process_local"] is True
    api_client.portal.call(lambda: _async(release["event"].set()))
    for _ in range(100):
        active = api_client.get("/api/investigations/active", params={"case_id": case_id}).json()
        if active["recent"]:
            break
        time.sleep(0.02)
    assert active["items"] == [] and active["recent"][-1]["outcome"] == "decided"
    rows = api_client.portal.call(lambda: _state(api_client).audit.records_for_case(case_id))
    requested = [r for r in rows if r.get("actor") == "reinvestigate"]
    assert requested[-1]["run_id"] == body["run_id"]


def test_a_background_run_cancelled_before_it_starts_frees_its_reservation(
    api_client, mock_provider, monkeypatch,
) -> None:
    """A ``wait=false`` run cancelled before its first step (a factory reset or a
    shutdown right after the 202) never runs its own ``finally``. Its reservation must
    still end, or every later Reinvestigate on the case, and on any case with the same
    signature, answers ``409 investigation_running`` until a restart."""
    from app.api.routes_investigations import _reservations

    case_id = _create_case(api_client, mock_provider, "192.0.2.66")
    state = _state(api_client)
    original = state.spawn_mutation_task

    def _spawn_then_cancel(coro, *, name=None):
        task = original(coro, name=name)
        task.cancel()
        return task

    monkeypatch.setattr(state, "spawn_mutation_task", _spawn_then_cancel)
    r = api_client.post(f"/api/cases/{case_id}/reinvestigate", json={"wait": False})
    assert r.status_code == 202, r.text
    for _ in range(100):
        if not _reservations(state.investigations):
            break
        time.sleep(0.01)
    assert _reservations(state.investigations) == {}
    again = api_client.post(f"/api/cases/{case_id}/reinvestigate", json={"wait": False})
    assert again.status_code == 202, again.text


async def test_a_second_request_before_the_first_run_is_registered_is_refused() -> None:
    """The reservation refuses a second click that arrives while the first request is
    still rebuilding its cluster (before the pipeline registers the run)."""
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.api.routes_investigations import reserve_manual_run
    from app.engine.investigation_registry import InvestigationRegistry

    registry = InvestigationRegistry()
    case = SimpleNamespace(case_id="case-twice", cluster_signature="sig-twice")
    first = await reserve_manual_run(None, registry, case, run_id="inv-first", requested_by="ann")
    with pytest.raises(HTTPException) as refused:
        await reserve_manual_run(None, registry, case, run_id="inv-second", requested_by="ann")
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "investigation_running"
    assert (refused.value.detail["run"]["run_id"], refused.value.detail["run"]["state"]) == (
        "inv-first", "queued",
    )
    same_signature = SimpleNamespace(case_id="case-other", cluster_signature="sig-twice")
    with pytest.raises(HTTPException):
        await reserve_manual_run(None, registry, same_signature, run_id="inv-third", requested_by="bo")
    first.release()
    again = await reserve_manual_run(None, registry, case, run_id="inv-fourth", requested_by="ann")
    again.release()


def test_the_active_route_answers_the_shape(api_client) -> None:
    r = api_client.get("/api/investigations/active")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"items", "recent", "new_runs", "slots", "process_local", "generated_at"}
    assert body["process_local"] is True and body["slots"]["cap"] >= 1


def _rbac_client(denies: dict[str, list[str]]) -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret="wp08-rbac-secret",
        auth_seed_admin=True,
    )
    return TestClient(_app(secrets, MockProvider(), rbac_denies=denies, auth=True))


def _sign_in(client: TestClient, user: str, password: str) -> None:
    client.post("/api/auth/logout")
    r = client.post("/api/auth/login", json={"username": user, "password": password})
    assert r.status_code == 200, r.text


def test_the_active_route_needs_cases_read_and_names_only_for_users_manage() -> None:
    with _rbac_client({"cases": ["read"]}) as client:
        _sign_in(client, "Admin", "Admin@123")
        assert client.post("/api/users", json={
            "username": "tier1", "password": "tier1-pass-1234", "role": "analyst_tier1",
        }).status_code == 200
        ready_user(client, "tier1", "tier1-pass-1234")
        _sign_in(client, "tier1", "tier1-pass-1234")
        assert client.get("/api/investigations/active").status_code == 403
    with _rbac_client({}) as client:
        _sign_in(client, "Admin", "Admin@123")
        assert client.post("/api/users", json={
            "username": "tier1", "password": "tier1-pass-1234", "role": "analyst_tier1",
        }).status_code == 200
        ready_user(client, "tier1", "tier1-pass-1234")
        registry = client.app.state.tlsoc.investigation_registry
        handle = registry.begin(run_id="inv-named", signature="s", case_id="case-named",
                                trigger="manual", requested_by="Admin")
        try:
            seen = client.get("/api/investigations/active").json()["items"][0]
            assert (seen["requested_by"], seen["requested_by_you"]) == ("Admin", True)
            _sign_in(client, "tier1", "tier1-pass-1234")
            seen = client.get("/api/investigations/active").json()["items"][0]
            assert (seen["requested_by"], seen["requested_by_you"]) == (None, False)
        finally:
            registry.end(handle, outcome="cancelled")


def test_the_investigations_topic_needs_cases_read() -> None:
    from app.api.routes import _REALTIME_TOPICS, gate_realtime_topics

    assert "investigations" in _REALTIME_TOPICS
    assert gate_realtime_topics(["investigations", "jobs"], lambda r, a: (r, a) != ("cases", "read")) == [
        "jobs",
    ]


# --------------------------------------------------------------------------- #
# Carry-forward items in owned files
# --------------------------------------------------------------------------- #
async def test_seeding_the_first_admin_hashes_off_the_event_loop(app_state, monkeypatch) -> None:
    import app.auth.passwords as passwords

    calls: list[str] = []

    async def _recording(password, **_kwargs):
        calls.append(password)
        return passwords.hash_password(password, iterations=1000)

    monkeypatch.setattr(passwords, "ahash_password", _recording)
    monkeypatch.setattr(app_state.secrets, "auth_enabled", True)
    monkeypatch.setattr(app_state.secrets, "auth_seed_admin", True)
    monkeypatch.setattr(app_state.secrets, "auth_admin_password", None)
    await app_state.seed_users()
    assert calls == [app_state.secrets.auth_seed_admin_password]


def test_the_leftmost_forwarded_address_helper_is_gone() -> None:
    import app.state as state_mod

    assert not hasattr(state_mod, "client_ip_from")


def test_no_new_model_call_and_no_case_field() -> None:
    from app.models import Case as CaseModel

    assert "investigation" not in CaseModel.model_fields
    source = inspect.getsource(pipeline_mod.InvestigationPipeline._investigate_cluster_locked)  # noqa: SLF001
    assert "gateway" not in source and "decide(" not in source
    json.dumps(list(CASE_INVESTIGATION_FRAME_KEYS))
