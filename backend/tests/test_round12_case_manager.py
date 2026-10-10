"""Round 12 WP-CM backend: disposition on every terminal path, the live ``cases``
topic, and the Case Manager queue's server-side search / owner / severity filters.

Offline: fake Elasticsearch, SQLite and the in-process EventBus. ``decide()`` is never
reached by any path exercised here (#3): every mutation below is the analyst layer
(``_perform_case_action``) or a plain repository save.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import (
    CASE_QUEUE_SEVERITIES,
    CaseAction,
    _DISPOSITION_ACTIONS,
    _perform_case_action,
)
from app.api.routes_jobs import CaseLifecycleParams
from app.config import Secrets
from app.constants import (
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.analyst_outcomes import CLASSIFIED_DISPOSITION_KEY, analyst_confirmed_outcome
from app.engine.jobs import JobRunner
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.realtime import (
    CASE_CHANGED_EVENT,
    CASES_TOPIC,
    SSE_EVENT_TYPES,
    EventBus,
    publish_case_changed,
)
from app.state import AppState
from app.stores.cases import CaseStore
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _case(
    i: int,
    now: datetime,
    *,
    status: CaseStatus = CaseStatus.OPEN,
    verdict: Verdict = Verdict.NEEDS_HUMAN,
    assignee: str = "",
    title: str | None = None,
    risk: float = 10.0,
    severity_band: str | None = None,
) -> Case:
    return Case(
        case_id=f"case-{i:04d}",
        cluster_signature=f"sig-{i:04d}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        status=status,
        verdict=verdict,
        disposition=Disposition.UNDETERMINED,
        entity=Entity(type=EntityType.HOST, value=f"host-{i:04d}"),
        title=title if title is not None else f"Case number {i:04d}",
        created_at=_iso(now - timedelta(minutes=i)),
        updated_at=_iso(now - timedelta(minutes=i)),
        risk_score=risk,
        assignee=assignee,
        source_name="Splunk Enterprise",
        **({"severity_band": severity_band} if severity_band else {}),
    )


@pytest.fixture
def now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def client(now):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
        )
        mock = MockProvider()
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(),
            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
        )
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from app.api.routes import router as monolith_router

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    with TestClient(api) as test_client:
        yield test_client


def _seed(client: TestClient, cases: list[Case]) -> None:
    state = client.app.state.tlsoc

    async def go() -> None:
        for case in cases:
            await state.cases.save(case)

    client.portal.call(go)


def _get(client: TestClient, case_id: str) -> Case:
    state = client.app.state.tlsoc
    return client.portal.call(state.cases.get, case_id)


# --------------------------------------------------------------------------- #
# 1. A disposition is captured on every terminal path (SPEC D15 / §3.2).
# --------------------------------------------------------------------------- #
def test_resolve_is_a_disposition_action() -> None:
    assert "resolve" in _DISPOSITION_ACTIONS
    assert {"close", "set_disposition"} <= _DISPOSITION_ACTIONS


def test_declared_resolve_applies_and_classifies(client, now) -> None:
    _seed(client, [_case(1, now)])
    res = client.post(
        "/api/cases/case-0001/action",
        json={"action": "resolve", "disposition": "false_positive",
              "disposition_declared": True},
    )
    assert res.status_code == 200, res.text
    stored = _get(client, "case-0001")
    assert stored.status == CaseStatus.RESOLVED
    assert stored.disposition == Disposition.FALSE_POSITIVE
    assert stored.decision_by == DecisionBy.ANALYST
    assert stored.history[-1][CLASSIFIED_DISPOSITION_KEY] == "false_positive"
    assert analyst_confirmed_outcome(stored) == (
        "false_positive", "explicit_analyst_disposition",
    )


def test_undeclared_resolve_applies_without_classifying(client, now) -> None:
    _seed(client, [_case(2, now)])
    res = client.post(
        "/api/cases/case-0002/action",
        json={"action": "resolve", "disposition": "benign"},
    )
    assert res.status_code == 200, res.text
    stored = _get(client, "case-0002")
    assert stored.disposition == Disposition.BENIGN
    assert CLASSIFIED_DISPOSITION_KEY not in stored.history[-1]
    assert analyst_confirmed_outcome(stored) == (None, None)


def test_resolve_rejects_an_unknown_disposition(client, now) -> None:
    _seed(client, [_case(3, now)])
    res = client.post(
        "/api/cases/case-0003/action",
        json={"action": "resolve", "disposition": "maybe"},
    )
    assert res.status_code == 400


def test_bulk_close_with_declared_disposition_classifies_each_case(client, now) -> None:
    _seed(client, [_case(10, now), _case(11, now)])
    res = client.post(
        "/api/cases/bulk",
        json={"ids": ["case-0010", "case-0011"], "action": "close",
              "disposition": "false_positive", "disposition_declared": True},
    )
    assert res.status_code == 200, res.text
    assert all(r["ok"] for r in res.json()["results"])
    batches = set()
    for cid in ("case-0010", "case-0011"):
        stored = _get(client, cid)
        assert stored.status == CaseStatus.CLOSED
        assert stored.disposition == Disposition.FALSE_POSITIVE
        assert stored.history[-1][CLASSIFIED_DISPOSITION_KEY] == "false_positive"
        batches.add(stored.history[-1]["batch"])
    assert len(batches) == 1  # one operator transaction


def test_lifecycle_job_params_accept_the_declaration_flag() -> None:
    params = CaseLifecycleParams.model_validate({
        "case_ids": ["b", "a"], "action": "resolve",
        "disposition": "true_positive", "disposition_declared": True,
    })
    assert params.disposition_declared is True
    assert params.case_ids == ["a", "b"]
    # Default stays False so an old client's job is not a declaration.
    legacy = CaseLifecycleParams.model_validate({"case_ids": ["a"], "action": "close"})
    assert legacy.disposition_declared is False


def test_lifecycle_job_stamps_one_transaction_and_classifies(client, now) -> None:
    _seed(client, [_case(20, now), _case(21, now)])
    state = client.app.state.tlsoc
    captured: dict[str, Any] = {}

    async def item_loop(job, token, run, result_kind):  # noqa: ANN001
        captured["kind"] = result_kind
        for cid in job.params["case_ids"]:
            await run(cid)

    runner = SimpleNamespace(state=state, _item_loop=item_loop)
    job = SimpleNamespace(
        job_id="job-abc123",
        actor="alice",
        params=CaseLifecycleParams.model_validate({
            "case_ids": ["case-0020", "case-0021"], "action": "close",
            "disposition": "true_positive", "disposition_declared": True,
        }).model_dump(),
    )
    client.portal.call(JobRunner._case_lifecycle, runner, job, "token")
    assert captured["kind"] == "case_lifecycle"
    for cid in ("case-0020", "case-0021"):
        stored = _get(client, cid)
        entry = stored.history[-1]
        assert entry["batch"] == "bulk-job-abc123"
        assert entry["analyst"] == "alice"
        assert entry[CLASSIFIED_DISPOSITION_KEY] == "true_positive"
        assert stored.disposition == Disposition.TRUE_POSITIVE


def test_perform_case_action_never_calls_decide(client, now, monkeypatch) -> None:
    import app.engine.case_manager as case_manager

    def forbidden(*_a, **_k):
        raise AssertionError("the analyst layer must never call decide() (#3)")

    monkeypatch.setattr(case_manager, "decide", forbidden)
    _seed(client, [_case(30, now)])
    state = client.app.state.tlsoc
    body = CaseAction(action="resolve", disposition="benign", disposition_declared=True)
    out = client.portal.call(_perform_case_action, "case-0030", body, "bob", state)
    assert out["status"] == "resolved"


# --------------------------------------------------------------------------- #
# 2. The live ``cases`` topic.
# --------------------------------------------------------------------------- #
def test_case_changed_is_a_registered_channel() -> None:
    assert CASE_CHANGED_EVENT == "case.changed"
    assert CASE_CHANGED_EVENT in SSE_EVENT_TYPES
    assert CASES_TOPIC == "cases"


def _frames(bus: EventBus) -> list[dict[str, Any]]:
    import json

    return [json.loads(ev.payload) for ev in bus.replay(frozenset({CASES_TOPIC}), None, "0")]


def test_publish_case_changed_carries_ids_status_and_times_only(now) -> None:
    bus = EventBus()
    case = _case(40, now, title="ip:203.0.113.9 — secret log text")
    publish_case_changed(case, created=True, bus=bus)
    frames = _frames(bus)
    assert frames == [{
        "case_id": "case-0040", "status": "open",
        "updated_at": case.updated_at, "created": True,
    }]
    # #7/#9: nothing log-derived rides on the frame.
    assert "secret" not in str(frames)


def test_publish_case_changed_never_raises() -> None:
    class Broken(EventBus):
        def publish(self, *a, **k):  # noqa: ANN002, ANN003
            raise RuntimeError("bus down")

    assert publish_case_changed(SimpleNamespace(case_id="x", status="open"), bus=Broken()) is None
    assert publish_case_changed(SimpleNamespace(case_id=""), bus=EventBus()) is None


def test_es_store_publishes_created_then_updated(now) -> None:
    import asyncio

    bus = EventBus()
    store = CaseStore(InMemoryESClient())
    store.case_event_bus = bus
    case = _case(41, now)

    async def go() -> None:
        await store.save(case)
        case.status = CaseStatus.CLOSED
        await store.save(case)

    asyncio.run(go())
    frames = _frames(bus)
    assert [(f["case_id"], f["status"], f["created"]) for f in frames] == [
        ("case-0041", "open", True), ("case-0041", "closed", False),
    ]


def test_sql_store_publishes_after_commit(now) -> None:
    import asyncio

    async def go() -> list[dict[str, Any]]:
        engine = build_async_engine("sqlite+aiosqlite:///:memory:")
        await create_all(engine)
        bus = EventBus()
        repo = SqlCaseRepository(engine)
        repo.case_event_bus = bus
        case = _case(42, now)
        await repo.save(case)
        case.status = CaseStatus.RESOLVED
        await repo.save(case)
        await engine.dispose()
        return _frames(bus)

    frames = asyncio.run(go())
    assert [(f["status"], f["created"]) for f in frames] == [("open", True), ("resolved", False)]


def test_replay_store_never_publishes(now) -> None:
    import asyncio

    from app.engine.replay.stack import _ReplayCaseStore

    bus = EventBus()
    es = InMemoryESClient()
    store = _ReplayCaseStore(es, "job-replay")
    store.case_event_bus = bus
    asyncio.run(store.save(_case(43, now)))
    assert _frames(bus) == []


def test_demo_store_publishes_on_the_demo_bus(now) -> None:
    import asyncio

    from app.engine.demo_runtime import DemoStack
    from app.config import Preferences
    from app.realtime import get_event_bus, reset_event_bus

    reset_event_bus()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="")
    stack = DemoStack(secrets, lambda: Preferences(), run_id="run-demo-1")
    assert stack.cases.case_event_bus is stack.event_bus
    asyncio.run(stack.cases.save(_case(44, now)))
    # The demo bus is history-free; what matters is that the GLOBAL ring stays clean.
    assert _frames(get_event_bus()) == []


def test_analyst_action_publishes_a_frame(client, now) -> None:
    from app.realtime import get_event_bus

    _seed(client, [_case(45, now)])
    res = client.post(
        "/api/cases/case-0045/action",
        json={"action": "close", "disposition": "false_positive", "disposition_declared": True},
    )
    assert res.status_code == 200
    frames = [f for f in _frames(get_event_bus()) if f["case_id"] == "case-0045"]
    assert frames[-1]["status"] == "closed"


# --------------------------------------------------------------------------- #
# 3. The server-backed queue: search / owner / severity / title order.
# --------------------------------------------------------------------------- #
def _queue(client: TestClient, **params: Any) -> dict[str, Any]:
    res = client.get("/api/cases", params=params)
    assert res.status_code == 200, res.text
    return res.json()


def test_active_queue_counts_open_cases_older_than_the_newest_page(client, now) -> None:
    """The analyst's deployment: more cases than one page, open ones among the OLD."""
    cases = [
        _case(i, now, status=CaseStatus.CLOSED if i < 230 else CaseStatus.OPEN)
        for i in range(260)
    ]
    _seed(client, cases)
    body = _queue(client, status_group="active", limit=200, sort_field="updated_at")
    assert body["total"] == 30
    assert {c["case_id"] for c in body["cases"]} == {f"case-{i:04d}" for i in range(230, 260)}
    # Searching finds an open case far older than the newest 200 rows.
    found = _queue(client, status_group="active", q="case-0259", limit=50)
    assert [c["case_id"] for c in found["cases"]] == ["case-0259"]
    assert found["total"] == 1
    assert found["search_applied"] == "case-0259"


def test_search_matches_every_term_case_insensitively(client, now) -> None:
    _seed(client, [
        _case(1, now, title="Impossible travel for pnair"),
        _case(2, now, title="Brute force on vpn"),
        _case(3, now, title="Impossible travel for vpatel"),
    ])
    body = _queue(client, q="IMPOSSIBLE pnair")
    assert [c["case_id"] for c in body["cases"]] == ["case-0001"]
    by_entity = _queue(client, q="host-0002")
    assert [c["case_id"] for c in by_entity["cases"]] == ["case-0002"]
    by_source = _queue(client, q="splunk")
    assert by_source["total"] == 3


def test_assignee_filter_is_exact_and_case_insensitive(client, now) -> None:
    _seed(client, [
        _case(1, now, assignee="Alice"),
        _case(2, now, assignee="alice2"),
        _case(3, now, assignee=""),
    ])
    body = _queue(client, assignee="alice", status_group="active")
    assert [c["case_id"] for c in body["cases"]] == ["case-0001"]
    assert body["assignee_applied"] == "alice"


def test_severity_filter_uses_the_displayed_band(client, now) -> None:
    _seed(client, [
        _case(1, now, risk=90.0),
        _case(2, now, risk=50.0),
        _case(3, now, risk=5.0),
    ])
    critical = _queue(client, severity="critical")
    assert [c["case_id"] for c in critical["cases"]] == ["case-0001"]
    high = _queue(client, severity="high")
    assert [c["case_id"] for c in high["cases"]] == ["case-0002"]
    assert set(CASE_QUEUE_SEVERITIES) == {"critical", "high", "medium", "low", "info"}


def test_unknown_severity_is_refused(client) -> None:
    res = client.get("/api/cases", params={"severity": "urgent"})
    assert res.status_code == 400


def test_title_order_pages_over_the_whole_corpus(client, now) -> None:
    _seed(client, [_case(i, now, title=f"T{(37 * i) % 50:02d}") for i in range(50)])
    first = _queue(client, sort_field="title", sort_order="asc", limit=20, offset=0)
    second = _queue(client, sort_field="title", sort_order="asc", limit=20, offset=20)
    titles = [c["title"] for c in first["cases"] + second["cases"]]
    assert titles == sorted(titles)
    assert first["total"] == 50 and first["sort_field"] == "title"
    assert len(set(titles)) == 40


def test_requests_without_queue_filters_keep_their_envelope(client, now) -> None:
    _seed(client, [_case(1, now)])
    body = _queue(client)
    assert set(body) == {"cases", "total", "window_total_exact"}
    sorted_only = _queue(client, sort_field="risk_score")
    assert "search_applied" not in sorted_only and "assignee_applied" not in sorted_only
    assert "title" not in sorted_only["sortable_fields"]


def test_queue_scan_failure_is_a_503_not_a_short_list(client, now, monkeypatch) -> None:
    _seed(client, [_case(1, now)])
    state = client.app.state.tlsoc

    async def broken(**_kw):
        raise RuntimeError("store down")

    monkeypatch.setattr(state._real_cases, "scan_page", broken)
    res = client.get("/api/cases", params={"q": "case"})
    assert res.status_code == 503


def test_case_topics_need_cases_read(client, monkeypatch) -> None:
    """A principal without ``cases:read`` never receives the case nudges."""
    import app.api.deps as deps

    state = client.app.state.tlsoc
    realtime = state.prefs.realtime.model_copy(update={"enabled": True})
    client.portal.call(state.update_prefs, state.prefs.model_copy(update={"realtime": realtime}))

    class Denied:
        def allows(self, resource: str, action: str) -> bool:
            return resource != "cases"

    async def resolve(_request):  # noqa: ANN001
        return Denied()

    monkeypatch.setattr(deps, "resolve_access", resolve)
    res = client.get("/api/events", params={"topics": "cases,cases:case-1"})
    assert res.status_code == 204
