"""Round 16 WP13 (SPEC §4.5 WP13, §3.2, §3.3, [dv] R2, R3 and R7): case records reachable.

* ``GET /api/cases/{case_id}/events`` (cases:read and sources:read): the raw records of
  a case, read again through the source's ``fetch_by_ids`` and kept only for the case's
  own member keys; honest about push sources, aged-out events and failed sources; values
  that look like HTML stay plain strings; one coalesced ``case.events_viewed`` row per
  viewer and case, in the Demo audit while Demo Mode is on.
* ``GET /api/cases/{case_id}/usage`` (cases:read and cost:view): the case's ledger rows
  with their rates, the pipeline, chat and other totals, and whether the pipeline total
  reconciles with ``Case.token_cost``.
* Every ``GET /api/cases/{case_id}/...`` route declares a permission dependency.
* The threat context's IP and domain rows both list their providers, the fusion method
  and the provider errors.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.api import routes_case_events as rce
from app.api.deps import require_auth
from app.config import Secrets, SourceInstance
from app.constants import (
    EntityType,
    IngestMode,
    IndicatorKind,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import (
    Case,
    Entity,
    EvidenceItem,
    ProviderResult,
    UsageDoc,
    make_cursor_event_key,
)
from app.state import AppState
from tests._auth_helpers import ready_user
from tests.conftest import make_log_event, make_raw_event

INDEX = "all-logs-2026.06.16"
OTHER_INDEX = "all-logs-2026.06.17"
HOSTILE = '<img src=x onerror="alert(1)">'


def _secrets(**extra: Any) -> Secrets:
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                   anthropic_api_key=None, openai_api_key=None, **extra)


def _app(*, auth: bool = False, denies: dict | None = None) -> FastAPI:
    from app.api.routes import router as monolith_router
    from app.api.routes_case_events import router as events_router
    from app.api.routes_case_usage import router as usage_router
    from tests.conftest import mount_moved_routers

    secrets = _secrets(**({"auth_enabled": True, "auth_jwt_secret": "wp13-case-records",
                           "auth_seed_admin": True} if auth else {}))
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        if auth:
            prefs.rbac.enabled = True
            if denies is not None:
                prefs.rbac.denies = denies
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else None
    for router in (monolith_router, events_router, usage_router):
        api.include_router(router, **({"dependencies": deps} if deps else {}))
    mount_moved_routers(api, dependencies=deps)
    return api


@pytest.fixture(autouse=True)
def _fresh_view_rows():
    rce.RECORDER.reset()
    yield
    rce.RECORDER.reset()


@pytest.fixture
def client():
    with TestClient(_app()) as c:
        yield c


def _state(c: TestClient) -> AppState:
    return c.app.state.tlsoc


def _es(c: TestClient) -> InMemoryESClient:
    return _state(c).es


def _save(c: TestClient, case: Case) -> Case:
    c.portal.call(_state(c).cases.save, case)
    return case


def _case(case_id: str = "case-ev-1", **fields: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": case_id, "cluster_signature": f"sig-{case_id}", "case_number": "SOC-0007",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="203.0.113.9"),
        "verdict": Verdict.NEEDS_HUMAN, "confidence": 0.5, "risk_score": 40.0,
    }
    base.update(fields)
    return Case(**base)


def _seed(c: TestClient, doc_id: str, *, index: str = INDEX, **fields: Any) -> str:
    _es(c).add_log(index, make_log_event(ip="203.0.113.9", **fields), doc_id=doc_id)
    return make_cursor_event_key(index, doc_id)


def _view_rows(c: TestClient, *, repo: Any = None) -> list[dict[str, Any]]:
    store = repo if repo is not None else _state(c).audit
    rows = c.portal.call(lambda: store.records(limit=1000))
    return [r for r in rows if r.get("action") == "case.events_viewed"]


# --------------------------------------------------------------------------- #
# Every case read declares its grant (the B01 rule, per case route).
# --------------------------------------------------------------------------- #
def test_every_case_get_route_declares_a_permission() -> None:
    from app.main import app
    from tests.test_route_auth_coverage import _enforces_in_body, _has_authz_dependency

    case_gets = [
        r for r in app.routes
        if isinstance(r, APIRoute) and "GET" in r.methods and r.path.startswith("/api/cases/{case_id}/")
    ]
    paths = {r.path for r in case_gets}
    assert {"/api/cases/{case_id}/events", "/api/cases/{case_id}/usage"} <= paths
    ungated = [r.path for r in case_gets if not (_has_authz_dependency(r) or _enforces_in_body(r))]
    assert ungated == []


# --------------------------------------------------------------------------- #
# GET /api/cases/{case_id}/events
# --------------------------------------------------------------------------- #
def test_events_keep_only_the_case_member_keys(client) -> None:
    a = _seed(client, "ev-a", rule="ssh_fail")
    b = _seed(client, "ev-b", rule="ssh_ok")
    # The same _id in another index: an ids query answers it too, but it is not a member.
    _seed(client, "ev-a", index=OTHER_INDEX, rule="unrelated_rule")
    _save(client, _case(member_event_ids=["ev-a", "ev-b"], member_event_keys=[a, b],
                        evidence=[EvidenceItem(summary="first", event_ids=["ev-b"]),
                                  EvidenceItem(summary="second", event_ids=["ev-a", "ev-b"])]))

    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and page["reason"] is None
    assert (page["expected"], page["returned"], page["truncated"]) == (2, 2, False)
    assert page["next_cursor"] is None and page["limit"] == 50
    assert [(r["id"], r["index"]) for r in page["rows"]] == [("ev-a", INDEX), ("ev-b", INDEX)]
    assert all(r["rule"] != "unrelated_rule" for r in page["rows"])
    assert [r["in_evidence"] for r in page["rows"]] == [[1], [0, 1]]
    # The /api/logs row contract.
    assert {"id", "ts", "source_ip", "user", "host", "rule", "severity", "message", "_raw"} <= set(page["rows"][0])


def test_html_looking_values_stay_plain_strings(client) -> None:
    key = _seed(client, "ev-x", rule=HOSTILE, action=HOSTILE)
    _es(client).docs[INDEX]["ev-x"]["message"] = HOSTILE
    _save(client, _case(member_event_ids=["ev-x"], member_event_keys=[key]))
    row = client.get("/api/cases/case-ev-1/events").json()["rows"][0]
    assert row["message"] == HOSTILE and row["rule"] == HOSTILE
    assert row["_raw"]["event"]["action"] == HOSTILE
    assert row["_raw"]["message"] == HOSTILE


def test_events_page_through_the_member_list(client) -> None:
    keys = [_seed(client, f"ev-{i}") for i in range(3)]
    _save(client, _case(member_event_ids=[f"ev-{i}" for i in range(3)], member_event_keys=keys))

    first = client.get("/api/cases/case-ev-1/events", params={"limit": 2}).json()
    assert [r["id"] for r in first["rows"]] == ["ev-0", "ev-1"]
    assert first["truncated"] is True and first["next_cursor"] == "2"
    second = client.get("/api/cases/case-ev-1/events",
                        params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [r["id"] for r in second["rows"]] == ["ev-2"]
    assert second["truncated"] is False and second["next_cursor"] is None


def test_a_legacy_case_with_bare_ids_still_reads_its_events(client) -> None:
    _seed(client, "ev-legacy")
    _save(client, _case(member_event_ids=["ev-legacy"], member_event_keys=[]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and [r["id"] for r in page["rows"]] == ["ev-legacy"]


def test_events_that_aged_out_say_so(client) -> None:
    _save(client, _case(member_event_ids=["gone-1"], member_event_keys=[make_cursor_event_key(INDEX, "gone-1")]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert page == {**page, "available": False, "reason": "aged_out", "returned": 0, "expected": 1, "rows": []}


def test_a_case_without_members_has_nothing_to_read(client) -> None:
    _save(client, _case())
    page = client.get("/api/cases/case-ev-1/events").json()
    assert page["available"] is True and page["expected"] == 0 and page["rows"] == []


def test_a_push_source_case_is_not_retrievable(client) -> None:
    state = _state(client)
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = [SourceInstance(id="push-1", source_type=SourceType.WEBHOOK,
                                    ingest_mode=IngestMode.PUSH_HTTP, display_name="Webhook")]
    client.portal.call(state.update_prefs, prefs)
    _save(client, _case(source_id="push-1", member_event_ids=["p1"], member_event_keys=["webhook\x1fp1"]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"], page["expected"]) == (False, "push_source_not_retrievable", 1)


def test_a_deleted_or_failing_source_is_unavailable(client, monkeypatch) -> None:
    state = _state(client)
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = [SourceInstance(id="other", source_type=SourceType.WEBHOOK, ingest_mode=IngestMode.PUSH_HTTP)]
    client.portal.call(state.update_prefs, prefs)
    _save(client, _case(source_id="deleted-src", member_event_ids=["d1"]))
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"]) == (False, "source_unavailable")

    class _Broken:
        async def fetch_by_ids(self, prefs, ids, size):  # noqa: ANN001
            raise RuntimeError("connection refused")

    monkeypatch.setattr(state, "active_source_for_id", lambda source_id: _Broken())
    page = client.get("/api/cases/case-ev-1/events").json()
    assert (page["available"], page["reason"]) == (False, "source_unavailable")


def test_events_bounds_and_unknown_case(client) -> None:
    _save(client, _case(member_event_ids=["x"]))
    assert client.get("/api/cases/nope/events").status_code == 404
    assert client.get("/api/cases/case-ev-1/events", params={"limit": 0}).status_code == 422
    assert client.get("/api/cases/case-ev-1/events", params={"limit": 201}).status_code == 422
    assert client.get("/api/cases/case-ev-1/events", params={"limit": 200}).status_code == 200
    bad = client.get("/api/cases/case-ev-1/events", params={"cursor": "abc"})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "case_events_bad_cursor"


def test_the_events_read_only_touches_the_read_only_log_client(client, monkeypatch) -> None:
    key = _seed(client, "ev-ro")
    _save(client, _case(member_event_ids=["ev-ro"], member_event_keys=[key]))
    calls: list[str] = []
    es = _es(client)
    real = es.search_logs

    async def _spy(index, body):  # noqa: ANN001
        calls.append(index)
        return await real(index, body)

    monkeypatch.setattr(es, "search_logs", _spy)
    assert client.get("/api/cases/case-ev-1/events").json()["returned"] == 1
    assert calls and all(name.startswith("all-logs") for name in calls)


def test_one_view_row_per_viewer_and_case_in_ten_minutes(client) -> None:
    key = _seed(client, "ev-v")
    _save(client, _case(member_event_ids=["ev-v"], member_event_keys=[key]))
    for _ in range(3):
        assert client.get("/api/cases/case-ev-1/events").json()["returned"] == 1
    rows = _view_rows(client)
    assert len(rows) == 1
    row = rows[0]
    assert row["case_id"] == "case-ev-1" and row["actor_type"] == "human"
    assert row["target"]["type"] == "case" and row["target"]["id"] == "case-ev-1"
    assert row["result_summary"] == "Viewed the raw events of case SOC-0007."
    assert row["outcome"] == "success"
    # A read that showed nothing writes no row.
    _save(client, _case("case-ev-2", member_event_ids=["gone"]))
    client.get("/api/cases/case-ev-2/events")
    assert [r["case_id"] for r in _view_rows(client)] == ["case-ev-1"]


def test_demo_mode_reads_the_demo_source_and_audits_to_the_demo_sink(client) -> None:
    from app.connectors.base import StructuredQuery
    from app.engine.demo_sources import DEMO_SOURCE_SPECS

    state = _state(client)
    client.portal.call(lambda: state.enable_demo(mode="live", seed=1337, history_days=1))
    try:
        source_id = next(iter(DEMO_SOURCE_SPECS.values())).source_id
        adapter = state.demo_source_connector(source_id)
        events = client.portal.call(lambda: adapter.search(state.execution_prefs, StructuredQuery(size=3)))
        held = [ev for ev in events.events if ev.id][:2]
        assert held, "the demo adapter holds events"
        _save(client, _case("demo-case-1", source_id=source_id,
                            member_event_ids=[ev.id for ev in held],
                            member_event_keys=[ev.event_key() for ev in held]))
        page = client.get("/api/cases/demo-case-1/events").json()
        assert page["available"] is True
        assert [r["id"] for r in page["rows"]] == [ev.id for ev in held]
        assert len(_view_rows(client)) == 1  # the Demo audit (state.audit is Demo-swapped)
        assert _view_rows(client, repo=state.control_audit) == []
    finally:
        client.portal.call(state.disable_demo)
    # Off Demo, the same read path writes to the real execution audit.
    key = _seed(client, "ev-real")
    _save(client, _case("real-case-1", member_event_ids=["ev-real"], member_event_keys=[key]))
    client.get("/api/cases/real-case-1/events")
    assert [r["case_id"] for r in _view_rows(client)] == ["real-case-1"]


def test_resolver_names_each_reason() -> None:
    push = SourceInstance(id="push-1", source_type=SourceType.WEBHOOK, ingest_mode=IngestMode.PUSH_HTTP)
    pull = SourceInstance(id="pull-1", source_type=SourceType.ELASTICSEARCH, enabled=False)
    legacy = SimpleNamespace(connector_id="elastic-default")

    def state(*, sources, source=None, demo=False):  # noqa: ANN001
        from app.config import Preferences

        prefs = Preferences().model_copy(update={"sources": sources})
        return SimpleNamespace(prefs=prefs, demo_active=demo, log_source=legacy,
                               active_source_for_id=lambda _sid: source)

    assert rce._resolve_source(state(sources=[push]), _case(source_id="push-1")) == (
        None, "push_source_not_retrievable")
    assert rce._resolve_source(state(sources=[pull]), _case(source_id="pull-1")) == (None, "source_unavailable")
    assert rce._resolve_source(state(sources=[push]), _case(source_id="gone")) == (None, "source_unavailable")
    # The implicit legacy connector of an environment-only deployment.
    assert rce._resolve_source(state(sources=[]), _case(source_id="elastic-default")) == (legacy, None)
    assert rce._resolve_source(state(sources=[], demo=True), _case(source_id="x")) == (None, "source_unavailable")


# --------------------------------------------------------------------------- #
# GET /api/cases/{case_id}/usage
# --------------------------------------------------------------------------- #
def _cluster(ip: str = "8.8.4.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"u{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def test_usage_lists_the_case_calls_and_reconciles_on_a_multi_run_case(client) -> None:
    state = _state(client)
    cluster = _cluster()
    first = client.portal.call(lambda: state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, state.prefs))
    second = client.portal.call(lambda: state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, state.prefs, force=True))
    assert second.case_id == first.case_id and second.token_cost > first.token_cost > 0
    # Case chat on the same case: its own total, never part of the investigation cost.
    client.portal.call(state.usage_store.write, UsageDoc(
        surface="chat", case_id=first.case_id, role="chat", model="gpt-4o", cost=0.0021,
        total_tokens=10))
    client.portal.call(state.usage_store.write, UsageDoc(
        surface="rag", case_id=first.case_id, role="embedding", model="mock-embed", cost=0.0))
    # Another case's spend never appears.
    client.portal.call(state.usage_store.write, UsageDoc(
        surface="investigate", case_id="someone-else", role="investigator", model="gpt-4o", cost=9.0))

    page = client.get(f"/api/cases/{first.case_id}/usage").json()
    assert page["case_id"] == first.case_id
    assert {r["case_id"] for r in page["rows"]} == {first.case_id}
    assert page["returned"] == len(page["rows"]) == page["rows_total"] and page["truncated"] is False
    pipeline_rows = [r for r in page["rows"] if r["role"] in ("router", "investigator", "formatter")]
    assert len(pipeline_rows) >= 2
    assert page["totals"]["pipeline"] == pytest.approx(second.token_cost, abs=1e-6)
    assert page["token_cost"] == pytest.approx(second.token_cost)
    assert page["reconciles"] is True
    assert page["totals"]["chat"] == pytest.approx(0.0021)
    assert page["totals"]["other"] == 0.0
    # Newest first, and each pipeline row carries the inputs of its price.
    stamps = [r["ts"] for r in page["rows"]]
    assert stamps == sorted(stamps, reverse=True)
    for row in pipeline_rows:
        assert row["price_basis"] == "catalog" and row["cache_write_ttl"] == "5m"
        assert row["input_rate_per_million"] > 0


def test_a_legacy_row_has_no_rate_fields(client) -> None:
    state = _state(client)
    _save(client, _case("case-us-1", token_cost=0.5))
    client.portal.call(state.usage_store.write, UsageDoc(
        surface="investigate", case_id="case-us-1", role="investigator", model="gpt-4o", cost=0.5))
    page = client.get("/api/cases/case-us-1/usage").json()
    row = page["rows"][0]
    assert "price_basis" not in row and "input_rate_per_million" not in row
    assert page["reconciles"] is True


def test_a_full_page_reads_the_lifetime_pipeline_sum(client, monkeypatch) -> None:
    state = _state(client)
    _save(client, _case("case-us-big", token_cost=12.5))
    rows = [UsageDoc(surface="chat", case_id="case-us-big", role="chat", model="m", cost=0.01,
                     ts=f"2026-11-01T00:{i // 60:02d}:{i % 60:02d}+00:00").model_dump(mode="json")
            for i in range(500)]

    async def _records(case_id, limit=500):  # noqa: ANN001
        return rows[:limit]

    async def _lifetime(case_id):  # noqa: ANN001
        return 12.5

    monkeypatch.setattr(state.usage_store, "records_for_case", _records)
    monkeypatch.setattr(state.usage_store, "total_pipeline_cost_for_case", _lifetime)
    page = client.get("/api/cases/case-us-big/usage").json()
    assert page["truncated"] is True and page["rows_total"] is None and page["returned"] == 500
    assert page["totals"]["pipeline"] == 12.5 and page["reconciles"] is True
    assert page["totals"]["chat"] == pytest.approx(5.0)

    async def _unproven(case_id):  # noqa: ANN001
        return None

    monkeypatch.setattr(state.usage_store, "total_pipeline_cost_for_case", _unproven)
    assert client.get("/api/cases/case-us-big/usage").json()["reconciles"] is None


def test_usage_never_answers_no_spend_when_the_ledger_fails(client, monkeypatch) -> None:
    state = _state(client)
    _save(client, _case("case-us-2"))

    async def _boom(case_id, limit=500):  # noqa: ANN001
        raise RuntimeError("ledger down")

    monkeypatch.setattr(state.usage_store, "records_for_case", _boom)
    r = client.get("/api/cases/case-us-2/usage")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "case_usage_unavailable"

    async def _unsupported(case_id, limit=500):  # noqa: ANN001
        raise NotImplementedError

    monkeypatch.setattr(state.usage_store, "records_for_case", _unsupported)
    r = client.get("/api/cases/case-us-2/usage")
    assert r.status_code == 501 and r.json()["detail"]["code"] == "case_usage_unsupported"
    assert client.get("/api/cases/nope/usage").status_code == 404


def test_demo_mode_reads_the_demo_ledger(client) -> None:
    state = _state(client)
    client.portal.call(state.usage_store.write, UsageDoc(
        surface="investigate", case_id="shared-id", role="investigator", model="gpt-4o", cost=3.0))
    client.portal.call(lambda: state.enable_demo(mode="live", seed=1337, history_days=1))
    try:
        _save(client, _case("shared-id", token_cost=0.25))
        client.portal.call(state.usage_store.write, UsageDoc(
            surface="investigate", case_id="shared-id", role="investigator", model="mock",
            cost=0.25, price_basis="demo_simulated"))
        page = client.get("/api/cases/shared-id/usage").json()
        assert [r["cost"] for r in page["rows"]] == [0.25]
        assert page["rows"][0]["price_basis"] == "demo_simulated" and page["reconciles"] is True
    finally:
        client.portal.call(state.disable_demo)


# --------------------------------------------------------------------------- #
# Permissions with role-based access on.
# --------------------------------------------------------------------------- #
def _login(c: TestClient, username: str, password: str) -> None:
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text


def _rbac_client(denies: dict) -> TestClient:
    return TestClient(_app(auth=True, denies=denies))


def _tier1(c: TestClient) -> None:
    _login(c, "Admin", "Admin@123")
    ready_user(c, "Admin", "Admin@123")
    _login(c, "Admin", "Admin@123")
    r = c.post("/api/users", json={"username": "t1", "password": "t1-pass-123456", "role": "analyst_tier1"})
    assert r.status_code == 200, r.text
    ready_user(c, "t1", "t1-pass-123456")
    _save(c, _case("case-perm", member_event_ids=["x"]))
    _login(c, "t1", "t1-pass-123456")


def test_events_need_sources_read_and_usage_needs_cost_view() -> None:
    with _rbac_client({"analyst_tier1": {"sources": ["read"], "cost": ["view"]}}) as c:
        _tier1(c)
        assert c.get("/api/cases/case-perm").status_code == 200  # still a case reader
        assert c.get("/api/cases/case-perm/events").status_code == 403
        assert c.get("/api/cases/case-perm/usage").status_code == 403


def test_a_default_role_reads_both() -> None:
    with _rbac_client({}) as c:
        _tier1(c)
        assert c.get("/api/cases/case-perm/events").status_code == 200
        assert c.get("/api/cases/case-perm/usage").status_code == 200


def test_both_need_cases_read() -> None:
    with _rbac_client({"analyst_tier1": {"cases": ["read"]}}) as c:
        _tier1(c)
        assert c.get("/api/cases/case-perm/events").status_code == 403
        assert c.get("/api/cases/case-perm/usage").status_code == 403


# --------------------------------------------------------------------------- #
# Threat context: providers, method and errors on the IP and domain paths ([dv] R7).
# --------------------------------------------------------------------------- #
class _Cache:
    def __init__(self) -> None:
        self.data: dict[str, Any] = {}

    async def get_json(self, key):  # noqa: ANN001
        return self.data.get(key)

    async def set_json(self, key, value, ttl):  # noqa: ANN001
        self.data[key] = json.loads(json.dumps(value))


def _results(value: str, kind: IndicatorKind) -> list[ProviderResult]:
    return [
        ProviderResult(provider="abuseipdb", indicator=value, indicator_kind=kind.value, score=87,
                       malicious=True, confidence=0.9, tags=[HOSTILE], raw={"note": HOSTILE}),
        ProviderResult(provider="greynoise", indicator=value, indicator_kind=kind.value, score=10,
                       confidence=0.4),
    ]


def _enrich_tool(monkeypatch, results_for, calls: list[str]):  # noqa: ANN001
    from app.config import Preferences
    from app.tools import enrich as enrich_mod

    async def _dispatch(value, kind, cfg, secrets, cache=None):  # noqa: ANN001
        calls.append(value)
        return results_for(value, kind)

    monkeypatch.setattr(enrich_mod, "_dispatch_enrich", _dispatch)
    return enrich_mod.EnrichTool(_secrets(), Preferences(), _Cache())


async def test_the_ip_path_lists_its_providers_without_asking_twice(monkeypatch) -> None:
    from app.agents.prompts import UNTRUSTED_OPEN
    from app.config import Preferences
    from app.engine import threat_context as tc

    calls: list[str] = []
    tool = _enrich_tool(monkeypatch, _results, calls)
    case = _case(entity=Entity(type=EntityType.IP, value="8.8.8.8"))
    row = (await tc._ioc_section(case, Preferences(), tool))[0]
    assert calls == ["8.8.8.8"]  # one dispatch for the score and the providers alike
    assert row["score"] == 87.0 and row["is_malicious"] is True and row["cached"] is False
    assert row["sources"] == {"abuseipdb": 87, "greynoise": 10}
    assert [p["provider"] for p in row["providers"]] == ["abuseipdb", "greynoise"]
    assert row["method"] == "max" and row["errors"] == {} and row["providers_status"] == "checked"
    assert row["providers"][0]["tags"][0].startswith(UNTRUSTED_OPEN)  # fenced (#9)
    assert row["providers"][0]["raw"]["note"].startswith(UNTRUSTED_OPEN)
    assert row["providers"][0]["cached"] is False

    # A second reading is the cached answer, with the providers kept beside it.
    again = (await tc._ioc_section(case, Preferences(), tool))[0]
    assert calls == ["8.8.8.8"]
    assert again["cached"] is True and again["providers_status"] == "cached"
    assert [p["provider"] for p in again["providers"]] == ["abuseipdb", "greynoise"]
    assert all(p["cached"] for p in again["providers"])
    assert again["score"] == row["score"] and again["method"] == "max"


async def test_a_cached_answer_from_an_earlier_build_reads_not_recorded(monkeypatch) -> None:
    from app.config import Preferences
    from app.engine import threat_context as tc
    from app.models import EnrichmentResult

    tool = _enrich_tool(monkeypatch, _results, [])
    tool._cache.data["enrich:8.8.8.8"] = EnrichmentResult(
        ip="8.8.8.8", reputation_score=40, sources={"abuseipdb": 40}).model_dump(mode="json")
    row = (await tc._ioc_section(_case(entity=Entity(type=EntityType.IP, value="8.8.8.8")),
                                 Preferences(), tool))[0]
    assert row["score"] == 40.0 and row["cached"] is True
    assert row["providers"] == [] and row["method"] is None and row["providers_status"] == "not_recorded"


async def test_a_failed_provider_shows_its_error_fenced(monkeypatch) -> None:
    from app.agents.prompts import UNTRUSTED_OPEN
    from app.config import Preferences
    from app.engine import threat_context as tc

    def _with_error(value, kind):  # noqa: ANN001
        return [*_results(value, kind)[:1],
                ProviderResult(provider="virustotal", indicator=value, indicator_kind=kind.value,
                               ok=False, error="virustotal: timeout")]

    row = (await tc._ioc_section(_case(entity=Entity(type=EntityType.IP, value="8.8.8.8")),
                                 Preferences(), _enrich_tool(monkeypatch, _with_error, [])))[0]
    assert set(row["errors"]) == {"virustotal"}
    assert row["errors"]["virustotal"].startswith(UNTRUSTED_OPEN)
    failed = next(p for p in row["providers"] if p["provider"] == "virustotal")
    assert failed["ok"] is False and "timeout" in failed["error"]


async def test_a_private_address_asks_no_provider(monkeypatch) -> None:
    from app.config import Preferences
    from app.engine import threat_context as tc

    calls: list[str] = []
    row = (await tc._ioc_section(_case(entity=Entity(type=EntityType.IP, value="10.0.0.5")),
                                 Preferences(), _enrich_tool(monkeypatch, _results, calls)))[0]
    assert calls == [] and row["providers"] == [] and row["providers_status"] == "skipped"


async def test_the_domain_path_lists_providers_method_and_errors() -> None:
    from app.config import EnrichmentConfig, Preferences
    from app.engine import threat_context as tc

    class _Enrich:
        async def enrich_indicator(self, value, kind):  # noqa: ANN001
            return [*_results(value, kind),
                    ProviderResult(provider="urlhaus", indicator=value, indicator_kind=kind.value,
                                   ok=False, error="urlhaus: 503")]

    case = _case(entity=Entity(type=EntityType.DOMAIN, value="evil.example"))
    row = (await tc._ioc_section(case, Preferences(), _Enrich()))[0]
    assert [p["provider"] for p in row["providers"]] == ["abuseipdb", "greynoise", "urlhaus"]
    assert row["method"] == "max" and set(row["errors"]) == {"urlhaus"}
    assert row["providers_status"] == "checked"
    weighted = Preferences().model_copy(update={"enrichment": EnrichmentConfig(fusion_enabled=True)})
    assert (await tc._ioc_section(case, weighted, _Enrich()))[0]["method"] == "weighted"


async def test_the_enrich_ip_answer_is_unchanged_by_the_detail(monkeypatch) -> None:
    """The pipeline's reading (``enrich_ip`` with no detail) is the same result as the
    panel's: the detail is filled beside it, never in place of it."""
    from app.tools.enrich import IpEnrichmentDetail

    plain_tool = _enrich_tool(monkeypatch, _results, [])
    plain = await plain_tool.enrich_ip("8.8.8.8")
    detail = IpEnrichmentDetail()
    detailed = await _enrich_tool(monkeypatch, _results, []).enrich_ip("8.8.8.8", detail=detail)
    assert plain.model_dump() == detailed.model_dump()
    assert [p.provider for p in detail.providers] == ["abuseipdb", "greynoise"]
    # The cached answer keeps its legacy key and shape.
    assert plain_tool._cache.data["enrich:8.8.8.8"]["sources"] == {"abuseipdb": 87, "greynoise": 10}

