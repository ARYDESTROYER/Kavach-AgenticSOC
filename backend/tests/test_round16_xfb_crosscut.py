"""Round 16 XFB: the confirmed backend findings of the cross-cutting review.

1. Automated case writers hold the case write lock from their re-read to their save:
   the cross-source link write (``engine.ingest._save_links_fresh``), threshold
   automation (``ThresholdAutomation.run``, wired from the pipeline and the Demo seed)
   and the notifier (``NotificationService.notify``). A person's action holds the same
   lock across its own read and save, so a close made between a writer's read and its
   save is never erased. Neither automation nor the notifier holds the lock while it
   sends. The link write takes the case lock alone, so it no longer waits for a whole
   investigation on the linked case, and a link written during automation's re-read
   and save survives.
2. The event-detection re-entry names the candidate it registered
   (``known_case_id``), and a run on it that finds the candidate closed by a person
   returns it unchanged instead of minting a second case for its events (#4).
3. (In ``test_round15_wp1_carry.py``.) The analyst-policy close carries the
   cross-source links and the sent-notification record.
4. ``GET /api/standup`` withholds the summary's AI spend without ``cost:view``.

Each regression fails on the tree before its fix. ``decide()`` and ``engine/risk.py``
are untouched; no model call is added. Offline: fake Elasticsearch, mock model.
"""

from __future__ import annotations

import asyncio
import gc
import time
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

import app.agents.pipeline as pipeline_mod
from app.config import AutomationRule, ThresholdAutomationConfig
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.ingest import _save_links_fresh
from app.models import Case, Cluster, Entity, VerdictResult
from app.utils import iso_now
from tests.test_round16_security import ADMIN, PW, T1, _app, _login, _new_user

SIG = "sig-xfb"
CASE_ID = "case-xfb"
LINK_ID = "a" * 32


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _cluster(sig: str = SIG, ids: tuple[str, ...] = ("e1",)) -> Cluster:
    return Cluster(signature=sig, entity=Entity(type=EntityType.IP, value="192.0.2.91"),
                   group_by=EntityType.IP, rule_values=["linux_auth"], risk_score=40.0,
                   member_event_ids=[f"{sig}-{i}" for i in ids])


def _case(sig: str = SIG, case_id: str = CASE_ID, **extra: Any) -> Case:
    fields: dict[str, Any] = {
        "case_id": case_id, "cluster_signature": sig,
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="192.0.2.91"),
        "member_event_ids": [f"{sig}-e1"], "status": CaseStatus.OPEN, "risk_score": 40.0,
        "created_at": iso_now(), "updated_at": iso_now(),
    }
    fields.update(extra)
    return Case(**fields)


def _needs_human(**extra: Any) -> Case:
    return _case(verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN, confidence=0.3, **extra)


def _prefs(app_state, *rules: AutomationRule, **caps: Any):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.enrichment.enabled = False
    for key, value in caps.items():
        setattr(prefs.caps, key, value)
    if rules:
        prefs.threshold_automation = ThresholdAutomationConfig(enabled=True, rules=list(rules))
    return prefs


_TAG = AutomationRule(id="tag-auto", action="tag", payload={"tag": "auto"})
_NOTIFY = AutomationRule(id="notify-soc", action="notify", payload={"trigger": "soc"})


async def _close_as(app_state, case_id: str = CASE_ID, who: str = "bob") -> None:
    from app.api.routes import CaseAction, _perform_case_action

    await _perform_case_action(case_id, CaseAction(action="close", note="done"), who, app_state)


def _assert_close_kept(stored: Case, who: str = "bob") -> None:
    assert stored.status == CaseStatus.CLOSED, "the person's close was erased"
    assert stored.decision_by == DecisionBy.ANALYST
    last = stored.status_history[-1]
    assert (last.to_status, last.by) == ("closed", who)
    assert any(h.get("event") == "analyst_action" and h.get("action") == "close"
               for h in stored.history)


def _interleave(app_state, monkeypatch, writer_task_name: str) -> asyncio.Event:
    """Model one store round trip between a re-read and a save.

    The person's save (task ``person``) waits until the writer task has read the case
    (or 0.3 s, when the writer is held out by the person's lock), and the writer's own
    save is a little slower, so an unlocked writer reads before the person saves and
    writes after. Returns the event set when the writer read."""
    es = app_state.cases._es  # noqa: SLF001
    writer_read = asyncio.Event()
    orig_search = es.search
    orig_get_doc_strict = es.get_doc_strict

    async def search(index, body):
        out = await orig_search(index, body)
        task = asyncio.current_task()
        if task is not None and task.get_name() == writer_task_name:
            writer_read.set()
        return out

    async def get_doc_strict(index, doc_id):
        task = asyncio.current_task()
        name = task.get_name() if task is not None else ""
        if name == "person":
            try:
                await asyncio.wait_for(writer_read.wait(), 0.3)
            except asyncio.TimeoutError:
                pass  # a writer held out by the person's lock never reads first
        elif name == writer_task_name:
            await asyncio.sleep(0.05)
        return await orig_get_doc_strict(index, doc_id)

    monkeypatch.setattr(es, "search", search)
    monkeypatch.setattr(es, "get_doc_strict", get_doc_strict)
    return writer_read


def _send_notifications(app_state, monkeypatch, record: dict[str, Any], seen: list | None = None):
    """Make the notifier due for one trigger and 'send' ``record`` without network I/O."""
    svc = app_state.notifications

    async def _dispatch(case, trigger, **_kw):
        if seen is not None:
            seen.append(app_state.case_lock(case.case_id).locked())
        return [dict(record, trigger=trigger)]

    monkeypatch.setattr(svc, "dispatch", _dispatch)
    monkeypatch.setattr(svc, "_safe_prefs", lambda: SimpleNamespace(notifications=SimpleNamespace(enabled=True)))
    monkeypatch.setattr(svc, "_passes_floors", lambda case, cfg: True)
    monkeypatch.setattr(svc, "_triggers_for_case", lambda case, cfg: ["needs_human"])
    return svc


async def _drain_mutation_tasks(app_state) -> None:
    for _ in range(5):
        tasks = [t for t in list(app_state._mutation_tasks) if not t.done()]  # noqa: SLF001
        if not tasks:
            return
        await asyncio.gather(*tasks)


async def _wait_for(predicate, *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


def _verdict_run(delay: float = 0.0):
    async def _run(*_args, **_kwargs):
        if delay:
            await asyncio.sleep(delay)
        return VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3, recommended_action="look"), 0.0

    return _run


_SENT = {"channel_id": "c1", "type": "webhook", "ok": True, "detail": "sent"}


# --------------------------------------------------------------------------- #
# 1. Automated writers hold the case write lock from re-read to save
# --------------------------------------------------------------------------- #
async def test_a_cross_source_link_write_keeps_a_persons_close(app_state, monkeypatch) -> None:
    await app_state.cases.save(_needs_human())
    pooled = await app_state.cases.get(CASE_ID)
    _interleave(app_state, monkeypatch, "link")
    person = asyncio.create_task(_close_as(app_state), name="person")
    await asyncio.sleep(0.01)  # the person has read the case and is saving it
    link = asyncio.create_task(_save_links_fresh(
        app_state.cases, app_state.pipeline, pooled,
        component_id=LINK_ID, related=["case-y"], breakdown={"src-a": 1, "src-b": 1},
    ), name="link")
    _, saved = await asyncio.gather(person, link)
    stored = await app_state.cases.get(CASE_ID)
    _assert_close_kept(stored)
    assert saved is True
    assert (stored.related_case_ids, stored.cross_source_cluster_id, stored.source_breakdown) == (
        ["case-y"], LINK_ID, {"src-a": 1, "src-b": 1},
    )


async def test_post_decision_automation_keeps_a_persons_close(app_state, monkeypatch) -> None:
    await app_state.cases.save(_needs_human())
    decided = await app_state.cases.get(CASE_ID)
    prefs = _prefs(app_state, _TAG)
    _interleave(app_state, monkeypatch, "automation")
    person = asyncio.create_task(_close_as(app_state), name="person")
    await asyncio.sleep(0.01)
    automation = asyncio.create_task(
        app_state.pipeline._maybe_automate(decided, prefs), name="automation",  # noqa: SLF001
    )
    await asyncio.gather(person, automation)
    stored = await app_state.cases.get(CASE_ID)
    _assert_close_kept(stored)
    assert "auto" in stored.tags
    assert [a["rule_id"] for a in stored.automation_actions] == ["tag-auto"]


async def test_the_notifier_keeps_a_persons_close(app_state, monkeypatch) -> None:
    await app_state.cases.save(_needs_human())
    decided = await app_state.cases.get(CASE_ID)
    _send_notifications(app_state, monkeypatch, _SENT)
    _interleave(app_state, monkeypatch, f"case-notify:{CASE_ID}")
    person = asyncio.create_task(_close_as(app_state), name="person")
    await asyncio.sleep(0.01)
    app_state.pipeline._maybe_notify(decided)  # noqa: SLF001 - the detached task
    await person
    await _drain_mutation_tasks(app_state)
    stored = await app_state.cases.get(CASE_ID)
    _assert_close_kept(stored)
    assert stored.notifications_sent == [dict(_SENT, trigger="needs_human")]


async def test_the_demo_hitl_seed_holds_the_shared_case_lock(app_state, monkeypatch) -> None:
    """``DemoStack.seed_hitl_proposals`` passes the shared case lock to automation."""
    from app.engine.demo_runtime import DemoStack

    seen: dict[str, Any] = {}

    class _Automation:
        async def run(self, case, prefs, **kwargs):
            seen.update(kwargs)
            return case

    async def _count():
        return 0

    def _shared_lock(case_id: str):
        return app_state.case_lock(case_id)

    stack = SimpleNamespace(
        pipeline=SimpleNamespace(automation=_Automation(), case_lock=_shared_lock),
        _demo_prefs=lambda: app_state.prefs, open_proposal_count=_count,
        cases=app_state.cases,
    )
    await DemoStack.seed_hitl_proposals(stack, [_needs_human()])
    assert seen["case_lock"] is _shared_lock
    assert seen["fetch"] == app_state.cases.get


# --------------------------------------------------------------------------- #
# 1. Lock order: no send under the lock, no deadlock inside the signature lock
# --------------------------------------------------------------------------- #
async def test_automation_sends_before_the_case_lock_and_saves_under_it(app_state, monkeypatch) -> None:
    """A notify action runs while a person holds the case lock (its send never waits
    for the lock); only the save waits, and it lands once the person is done."""
    await app_state.cases.save(_needs_human())
    decided = await app_state.cases.get(CASE_ID)
    sent: list[str] = []

    async def _notify(case, trigger):
        sent.append(trigger)
        return [{"ok": True, "detail": "sent"}]

    monkeypatch.setattr(app_state.automation, "_notify", _notify)
    prefs = _prefs(app_state, _NOTIFY, _TAG)
    lock = app_state.case_lock(CASE_ID)
    await lock.acquire()  # a person's action is between its read and its save

    async def _post_decision():
        async with app_state.pipeline.signature_lock(SIG):  # where the pipeline runs it
            await app_state.pipeline._maybe_automate(decided, prefs)  # noqa: SLF001

    task = asyncio.create_task(_post_decision())
    try:
        await _wait_for(lambda: sent == ["soc"])
        await asyncio.sleep(0.05)
        assert not task.done(), "automation saved without the case lock"
    finally:
        lock.release()
    await asyncio.wait_for(task, 2)
    stored = await app_state.cases.get(CASE_ID)
    assert "auto" in stored.tags
    assert [a["rule_id"] for a in stored.automation_actions] == ["notify-soc", "tag-auto"]


async def test_the_notifier_sends_before_the_case_lock_and_saves_under_it(app_state, monkeypatch) -> None:
    await app_state.cases.save(_needs_human())
    decided = await app_state.cases.get(CASE_ID)
    held_during_send: list[bool] = []
    svc = _send_notifications(app_state, monkeypatch, _SENT, seen=held_during_send)
    lock = app_state.case_lock(CASE_ID)
    await lock.acquire()
    task = asyncio.create_task(svc.notify(
        decided, save=app_state.cases.save, fetch=app_state.cases.get,
        case_lock=app_state.case_lock,
    ))
    try:
        await _wait_for(lambda: held_during_send == [True])  # sent while the lock was held
        await asyncio.sleep(0.05)
        assert not task.done(), "the notifier saved without the case lock"
    finally:
        lock.release()
    await asyncio.wait_for(task, 2)
    stored = await app_state.cases.get(CASE_ID)
    assert stored.notifications_sent == [dict(_SENT, trigger="needs_human")]


async def test_a_full_run_with_automation_and_notify_finishes_without_deadlock(
    app_state, monkeypatch,
) -> None:
    """Post-decision automation (tag and notify) runs inside the signature lock and takes
    the case lock after the run released it; the detached notifier takes it alone. The
    run ends, every write lands, and no lock is left behind."""
    monkeypatch.setattr(pipeline_mod, "run_investigation", _verdict_run())
    _send_notifications(app_state, monkeypatch, _SENT)
    await app_state.cases.save(_case())
    prefs = _prefs(app_state, _NOTIFY, _TAG)
    case = await asyncio.wait_for(app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, prefs,
    ), 5)
    await asyncio.wait_for(_drain_mutation_tasks(app_state), 5)
    stored = await app_state.cases.get(case.case_id)
    assert stored.status == CaseStatus.NEEDS_HUMAN and stored.verdict == Verdict.NEEDS_HUMAN
    assert "auto" in stored.tags
    assert [a["rule_id"] for a in stored.automation_actions] == ["notify-soc", "tag-auto"]
    assert stored.notifications_sent == [dict(_SENT, trigger="needs_human")]
    assert not app_state.case_lock(case.case_id).locked()
    assert not app_state.pipeline.signature_lock(SIG).locked()
    gc.collect()
    assert len(app_state.case_locks) == 0


# --------------------------------------------------------------------------- #
# 1. The link write takes the case lock alone (link-write-waits-for-run)
# --------------------------------------------------------------------------- #
async def test_a_link_write_does_not_wait_for_a_run_on_the_linked_case(app_state, monkeypatch) -> None:
    """A run holds the signature lock for its whole life (the gate and every model
    call). The link write waits at most for one save, and the run's rebuild carries the
    links it finds when it re-reads the case."""
    monkeypatch.setattr(pipeline_mod, "run_investigation", _verdict_run(delay=0.6))
    await app_state.cases.save(_case())
    pooled = await app_state.cases.get(CASE_ID)
    run = asyncio.create_task(app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _prefs(app_state), force=True,
    ))
    await _wait_for(lambda: app_state.pipeline.signature_lock(SIG).locked())
    started = time.monotonic()
    saved = await _save_links_fresh(app_state.cases, app_state.pipeline, pooled,
                                    component_id=LINK_ID, related=["case-y"], breakdown={"s": 1})
    waited = time.monotonic() - started
    assert not run.done()
    case = await run
    assert saved is True
    assert waited < 0.3, f"the link write waited {waited:.2f}s for the run on the linked case"
    stored = await app_state.cases.get(CASE_ID)
    assert case.verdict == Verdict.NEEDS_HUMAN and stored.verdict == Verdict.NEEDS_HUMAN
    assert (stored.related_case_ids, stored.cross_source_cluster_id) == (["case-y"], LINK_ID)


async def test_a_link_written_during_automations_read_and_save_survives(app_state, monkeypatch) -> None:
    """Guards the order of the two changes: with the link write on the case lock alone,
    a link written while automation is between its re-read and its save waits for that
    save, so automation's save never erases it (the one-sided link B09 fixed)."""
    await app_state.cases.save(_needs_human())
    decided = await app_state.cases.get(CASE_ID)
    pooled = await app_state.cases.get(CASE_ID)
    prefs = _prefs(app_state, _TAG)
    automation_read = _interleave(app_state, monkeypatch, "automation")

    async def _post_decision():
        async with app_state.pipeline.signature_lock(SIG):
            await app_state.pipeline._maybe_automate(decided, prefs)  # noqa: SLF001

    automation = asyncio.create_task(_post_decision(), name="automation")
    await asyncio.wait_for(automation_read.wait(), 2)  # automation re-read; its save is slow
    link = asyncio.create_task(_save_links_fresh(
        app_state.cases, app_state.pipeline, pooled,
        component_id=LINK_ID, related=["case-y"], breakdown={"s": 1},
    ), name="link")
    await asyncio.gather(automation, link)
    stored = await app_state.cases.get(CASE_ID)
    assert "auto" in stored.tags
    assert (stored.related_case_ids, stored.cross_source_cluster_id) == (["case-y"], LINK_ID)


# --------------------------------------------------------------------------- #
# 2. The event-detection re-entry names its candidate
# --------------------------------------------------------------------------- #
async def test_a_person_closes_a_detection_candidate_while_its_run_waits(app_state, monkeypatch) -> None:
    """``_reenter_detections`` registers a candidate and runs it. A person closes the
    candidate while the run waits for a full gate: the run returns the closed case
    unchanged, the queued run showed on the case, and no second case is minted."""
    from app.config import BaselineConfig, BatchConfig
    from app.engine import event_detection as evdet

    model_calls: list[int] = []

    async def _run(*_args, **_kwargs):
        model_calls.append(1)
        return VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3, recommended_action="look"), 0.0

    monkeypatch.setattr(pipeline_mod, "run_investigation", _run)
    prefs = _prefs(app_state, max_concurrent=1)
    prefs.batch = BatchConfig(enabled=True)
    prefs.baseline = BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1)
    await app_state.update_prefs(prefs)
    cluster = _cluster()
    monkeypatch.setattr(evdet, "candidate_from_json", lambda raw: object())
    monkeypatch.setattr(evdet, "results_to_candidates", lambda cands, results: [(cluster, None)])
    registry = app_state.investigation_registry

    async with app_state.investigation_gate.permit(1):  # another investigation holds the slot
        task = asyncio.create_task(app_state._reenter_detections(  # noqa: SLF001
            SimpleNamespace(id="batch-xfb", candidates={"c": {}}), [],
        ))
        await _wait_for(lambda: bool(registry.active()))
        items, _ = await app_state.cases.list(limit=50)
        (candidate,) = [c for c in items if c.cluster_signature == SIG]
        queued = registry.for_case(candidate.case_id)
        assert queued is not None and queued.trigger == "detection"
        await _close_as(app_state, candidate.case_id)
    assert await task == 1
    items, _ = await app_state.cases.list(limit=50)
    same = [c for c in items if c.cluster_signature == SIG]
    assert [(c.case_id, c.status) for c in same] == [(candidate.case_id, CaseStatus.CLOSED)]
    assert registry.recent()[-1].outcome == "unchanged"
    assert model_calls == []


async def test_a_detection_run_on_an_open_candidate_still_runs(app_state, monkeypatch) -> None:
    """Naming the candidate changes nothing when nobody closed it: the run investigates
    it in place."""
    monkeypatch.setattr(pipeline_mod, "run_investigation", _verdict_run())
    candidate = await app_state.pipeline.register_candidate(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _prefs(app_state),
    )
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _prefs(app_state),
        trigger="detection", known_case_id=candidate.case_id,
    )
    assert case.case_id == candidate.case_id and case.verdict == Verdict.NEEDS_HUMAN
    assert app_state.investigation_registry.recent()[-1].outcome == "decided"


async def test_the_demo_event_batch_names_its_candidate(app_state, monkeypatch) -> None:
    from app.engine import event_detection as evdet
    from app.engine.demo_runtime import DemoStack

    calls: list[dict[str, Any]] = []
    prefs = _prefs(app_state)
    cluster = _cluster()

    async def _investigate(_cluster, *_args, **kwargs):
        calls.append(kwargs)

    async def _baseline():
        return object()

    async def _flush(_baseline, _summaries):
        return None

    monkeypatch.setattr(evdet, "pre_aggregate", lambda events, p: [])
    monkeypatch.setattr(evdet, "funnel", lambda events, p, baseline: [object()])
    monkeypatch.setattr(evdet, "shape_candidate_cluster", lambda cand: cluster)
    monkeypatch.setattr(app_state.pipeline, "investigate_cluster", _investigate)
    stack = SimpleNamespace(
        _demo_event_prefs=lambda: prefs, _ensure_funnel_baseline=_baseline,
        _flush_funnel_baseline=_flush, sources={}, pipeline=app_state.pipeline,
    )
    assert await DemoStack.route_event_batch(stack, [object()], "xdr") == 1
    items, _ = await app_state.cases.list(limit=50)
    (candidate,) = [c for c in items if c.cluster_signature == SIG]
    assert calls[0]["trigger"] == "detection" and calls[0]["known_case_id"] == candidate.case_id


# --------------------------------------------------------------------------- #
# 4. The standup's AI spend follows cost:view
# --------------------------------------------------------------------------- #
def test_the_standup_withholds_its_spend_without_cost_view() -> None:
    denies = {T1: {"cost": ["view"]}}
    with TestClient(_app(denies=denies)) as c:
        _login(c, *ADMIN)
        own = c.get("/api/standup")
        assert own.status_code == 200, own.text
        assert isinstance(own.json()["cost"], (int, float))  # the grant holder sees it
        _new_user(c, "tess")
        _login(c, "tess", PW)
        assert c.get("/api/usage/summary").status_code == 403
        r = c.get("/api/standup")
        assert r.status_code == 200, r.text
        body = r.json()
        assert "cost" in body and body["cost"] is None
        assert body["enabled"] is True and "summary" in body


async def test_a_degraded_standup_withholds_its_spend_too(app_state, monkeypatch) -> None:
    from app.api import routes as routes_mod

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("aggregation down")

    async def _no_cost_view(_request):
        return False

    monkeypatch.setattr(app_state.standup_service, "generate", _boom)
    monkeypatch.setattr(routes_mod, "_case_spend_visible", _no_cost_view)
    body = await routes_mod.standup(window_hours=None, state=app_state, request=object())
    assert body["degraded"] is True and body["cost"] is None
