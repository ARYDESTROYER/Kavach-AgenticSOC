"""Dashboard-performance backend work: the bucketed trends endpoint, the shared
short-TTL case-page cache, and the ``count_created_since`` COUNT push-down.

Offline (fake ES + SQLite; no LLM). Locks:

1. **GET /api/metrics/trends** — the FROZEN hover-trendline contract: bucket-width
   ladder + UTC-aligned zero-filled buckets, window clamping (1..720), cohort counts
   that reuse the exact ``quality_metrics`` semantics (policy-closed excluded),
   fp_rate null-vs-zero honesty, alerts from the durable noise counters (null when
   warming up / pre-coverage), the truncated/store_total/fetched marker, and the
   ``metrics:view`` permission gate.
2. **api/metrics_shared.fetch_case_page** — one store scan per TTL window shared
   across the posture/noise/auto-close/diagnostics fan-out; keyed by fetch limit,
   guarded by store identity (Demo Mode's store swap self-invalidates); TTL expiry
   refetches; errors propagate and are never cached; callers get their own list.
3. **CaseRepository.count_created_since** — ES (fake) count push-down, the SQL
   (SQLite) COUNT, and the abstract-base list() fallback — plus the
   ``/api/sources/coverage`` wiring that consumes it.

Everything here is read-time reporting — nothing touches ``decide()``/risk/
signatures (#3).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import metrics_shared
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import metrics as M
from app.models import Case, Entity

NOW = datetime(2026, 8, 20, 12, 30, 0, tzinfo=timezone.utc)


def _case(
    cid: str,
    *,
    created: str,
    verdict: Verdict | None = None,
    status: CaseStatus = CaseStatus.OPEN,
    decision_by: DecisionBy | None = None,
    escalation_level: int = 0,
) -> Case:
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        created_at=created,
        updated_at=created,
        verdict=verdict,
        status=status,
        decision_by=decision_by,
        escalation_level=escalation_level,
        confidence=0.9,
        risk_score=50.0,
    )


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# --------------------------------------------------------------------------- #
# trend_metrics — pure function
# --------------------------------------------------------------------------- #
def test_trend_bucket_minutes_frozen_ladder() -> None:
    assert M._trend_bucket_minutes(1) == 60
    assert M._trend_bucket_minutes(24) == 60
    assert M._trend_bucket_minutes(25) == 180
    assert M._trend_bucket_minutes(72) == 180
    assert M._trend_bucket_minutes(73) == 360
    assert M._trend_bucket_minutes(168) == 360
    assert M._trend_bucket_minutes(169) == 1440
    assert M._trend_bucket_minutes(720) == 1440


def test_trend_metrics_bucket_math_and_zero_fill() -> None:
    out = M.trend_metrics([], window_hours=24, now=NOW)
    assert out["window_hours"] == 24
    assert out["bucket_minutes"] == 60
    assert out["generated_at"] == NOW.isoformat()
    rows = out["buckets"]
    # Hour-aligned buckets covering [NOW-24h, NOW]: floor(NOW-24h) .. floor(NOW) → 25.
    assert len(rows) == 25
    first = datetime.fromisoformat(rows[0]["t"])
    last = datetime.fromisoformat(rows[-1]["t"])
    assert first == datetime(2026, 8, 19, 12, 0, 0, tzinfo=timezone.utc)
    assert last == datetime(2026, 8, 20, 12, 0, 0, tzinfo=timezone.utc)
    # Monotonic, evenly spaced starts.
    stamps = [datetime.fromisoformat(r["t"]) for r in rows]
    assert all(
        (b - a) == timedelta(minutes=60) for a, b in zip(stamps, stamps[1:])
    )
    # Zero-filled empties: zeros for every count, null fp_rate + alerts.
    for row in rows:
        assert row["new_cases"] == 0 and row["closed"] == 0
        assert row["auto_closed"] == 0 and row["false_positives"] == 0
        assert row["needs_human"] == 0 and row["escalated"] == 0
        assert row["fp_rate"] is None and row["alerts"] is None
    # The honesty marker rides along.
    assert out["truncated"] is False and out["store_total"] == 0 and out["fetched"] == 0


def test_trend_metrics_clamps_window() -> None:
    assert M.trend_metrics([], window_hours=100000, now=NOW)["window_hours"] == 720
    assert M.trend_metrics([], window_hours=100000, now=NOW)["bucket_minutes"] == 1440
    assert M.trend_metrics([], window_hours=0, now=NOW)["window_hours"] == 1
    assert M.trend_metrics([], window_hours=-5, now=NOW)["window_hours"] == 1
    # 72h → 180-minute buckets, aligned to 3h boundaries.
    out = M.trend_metrics([], window_hours=72, now=NOW)
    assert out["bucket_minutes"] == 180
    assert all(
        datetime.fromisoformat(r["t"]).timestamp() % (180 * 60) == 0
        for r in out["buckets"]
    )


def test_trend_metrics_cohort_counts_reconcile_with_quality_semantics() -> None:
    bucket_a = NOW - timedelta(minutes=30)   # lands in the newest (partial) bucket
    bucket_b = NOW - timedelta(minutes=150)  # two buckets earlier
    cases = [
        # Newest bucket: 1 FP auto-close + 1 TP analyst close → fp_rate 50.0.
        _case("fp-auto", created=_iso(bucket_a), verdict=Verdict.FALSE_POSITIVE,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT),
        _case("tp-human", created=_iso(bucket_a), verdict=Verdict.TRUE_POSITIVE,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST),
        # A policy close: counted as arrival volume, EXCLUDED from every tallied
        # outcome (exactly like quality_metrics).
        _case("policy", created=_iso(bucket_a), verdict=None,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST_POLICY),
        # Earlier bucket: unverdicted open case → fp_rate stays null (not 0.0).
        _case("open", created=_iso(bucket_b)),
        # Earlier bucket: NEEDS_HUMAN + escalated.
        _case("nh-esc", created=_iso(bucket_b), verdict=Verdict.NEEDS_HUMAN,
              status=CaseStatus.ESCALATED, escalation_level=1),
    ]
    out = M.trend_metrics(cases, window_hours=24, now=NOW, store_total=5)
    rows = {r["t"]: r for r in out["buckets"]}
    newest = rows[
        bucket_a.replace(minute=0, second=0, microsecond=0).isoformat()
    ]
    assert newest["new_cases"] == 3          # policy close counts as arrival
    assert newest["closed"] == 2             # policy close excluded (quality semantics)
    assert newest["auto_closed"] == 1
    assert newest["false_positives"] == 1
    assert newest["fp_rate"] == 50.0         # 1 FP of 2 verdicted, 0-100 scale
    earlier = rows[
        bucket_b.replace(minute=0, second=0, microsecond=0).isoformat()
    ]
    assert earlier["new_cases"] == 2
    assert earlier["needs_human"] == 1
    assert earlier["escalated"] == 1
    assert earlier["fp_rate"] == 0.0         # 0 FP of 1 verdicted → a real 0, not null
    # Reconciliation with the posture tiles: bucket sums equal quality_metrics tallies.
    quality = M.quality_metrics(cases)
    assert sum(r["false_positives"] for r in out["buckets"]) == quality["false_positive_cases"]
    assert sum(r["auto_closed"] for r in out["buckets"]) == quality["auto_closed_cases"]
    assert sum(r["closed"] for r in out["buckets"]) == quality["terminal_cases"]
    assert sum(r["escalated"] for r in out["buckets"]) == quality["escalated_cases"]
    assert sum(r["needs_human"] for r in out["buckets"]) == quality["needs_human_cases"]


def test_trend_metrics_alerts_from_counters_and_honest_nulls() -> None:
    hour = int(NOW.timestamp() // 3600)
    counters = {
        "available": True,
        "since": (NOW - timedelta(hours=3)).isoformat(),
        "hours": {hour: 7, hour - 1: 2, hour - 2: 1},
    }
    out = M.trend_metrics([], window_hours=24, now=NOW, alert_counters=counters)
    rows = out["buckets"]
    assert rows[-1]["alerts"] == 7      # the current partial bucket
    assert rows[-2]["alerts"] == 2
    assert rows[-3]["alerts"] == 1
    # A covered-but-quiet hour is a REAL zero...
    assert rows[-4]["alerts"] == 0      # since (NOW-3h) falls inside this bucket
    # ...while buckets that END before the first observation stay null (honest gap).
    assert rows[0]["alerts"] is None
    assert rows[-5]["alerts"] is None
    # No counters at all → alerts null everywhere.
    out_none = M.trend_metrics([], window_hours=24, now=NOW, alert_counters=None)
    assert all(r["alerts"] is None for r in out_none["buckets"])
    out_warm = M.trend_metrics(
        [], window_hours=24, now=NOW, alert_counters={"available": False}
    )
    assert all(r["alerts"] is None for r in out_warm["buckets"])


def test_trend_metrics_truncation_marker() -> None:
    cases = [_case("t1", created=_iso(NOW - timedelta(hours=1)))]
    out = M.trend_metrics(cases, window_hours=24, now=NOW, store_total=50)
    assert out["truncated"] is True and out["store_total"] == 50 and out["fetched"] == 1
    full = M.trend_metrics(cases, window_hours=24, now=NOW, store_total=1)
    assert full["truncated"] is False


# --------------------------------------------------------------------------- #
# GET /api/metrics/trends — endpoint level
# --------------------------------------------------------------------------- #
@pytest.fixture
def metrics_client(app_state):
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


async def test_trends_endpoint_contract_shape(metrics_client, app_state) -> None:
    await app_state.cases.save(
        _case("ep-t1", created=_iso(datetime.now(timezone.utc) - timedelta(hours=1)),
              verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.AGENT)
    )
    r = metrics_client.get("/api/metrics/trends?window_hours=24")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {
        "window_hours", "bucket_minutes", "generated_at", "buckets",
        "truncated", "store_total", "fetched",
    }
    assert body["window_hours"] == 24 and body["bucket_minutes"] == 60
    assert len(body["buckets"]) == 25
    for row in body["buckets"]:
        assert set(row) == {
            "t", "new_cases", "closed", "auto_closed", "false_positives",
            "needs_human", "escalated", "fp_rate", "alerts",
        }
    assert sum(r_["false_positives"] for r_ in body["buckets"]) == 1
    assert sum(r_["auto_closed"] for r_ in body["buckets"]) == 1
    assert body["truncated"] is False and body["store_total"] == 1


async def test_trends_endpoint_clamps_window(metrics_client) -> None:
    body = metrics_client.get("/api/metrics/trends?window_hours=99999").json()
    assert body["window_hours"] == 720 and body["bucket_minutes"] == 1440
    body = metrics_client.get("/api/metrics/trends?window_hours=0").json()
    assert body["window_hours"] == 1 and body["bucket_minutes"] == 60


async def test_trends_endpoint_flags_truncation(metrics_client, app_state, monkeypatch) -> None:
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 2)
    now = datetime.now(timezone.utc)
    for i in range(3):
        await app_state.cases.save(_case(f"tr-{i}", created=_iso(now - timedelta(minutes=i))))
    body = metrics_client.get("/api/metrics/trends?window_hours=24").json()
    assert body["truncated"] is True
    assert body["store_total"] == 3 and body["fetched"] == 2


async def test_trends_endpoint_alerts_from_seeded_counters(metrics_client, app_state) -> None:
    now = datetime.now(timezone.utc)
    await app_state.noise_counters.record(
        {"ingested": {"high": 5, "low": 2}, "clustered": {"high": 1}}, now=now
    )
    body = metrics_client.get("/api/metrics/trends?window_hours=24").json()
    rows = body["buckets"]
    # The bucket holding "now" carries the recorded raw-alert total...
    assert rows[-1]["alerts"] == 7
    # ...and buckets predating the counters' first observation are null, not 0.
    assert rows[0]["alerts"] is None


async def test_trends_endpoint_alerts_null_when_counters_empty(metrics_client) -> None:
    body = metrics_client.get("/api/metrics/trends?window_hours=24").json()
    assert all(r["alerts"] is None for r in body["buckets"])


def test_trends_route_registered_on_the_real_app() -> None:
    from fastapi.routing import APIRoute

    from app.main import app

    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    assert "/api/metrics/trends" in paths


def test_trends_endpoint_enforces_metrics_view_permission() -> None:
    """RBAC parity with /metrics/posture: a role denied ``metrics:view`` gets 403."""
    from contextlib import asynccontextmanager

    from app.api.deps import require_auth
    from app.api.routes import router as monolith_router
    from app.api.routes_metrics import router as metrics_router
    from app.config import Preferences, Secrets
    from app.constants import UserRole
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="trends-rbac-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    t1 = UserRole.ANALYST_TIER1.value

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides
        )
        await state.startup(start_poller=False)
        prefs: Preferences = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={
            "rbac": prefs.rbac.model_copy(
                update={"enabled": True, "denies": {t1: {"metrics": ["view"]}}}
            )
        })
        await state.update_prefs(prefs)
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        # Unauthenticated → 401.
        assert client.get("/api/metrics/trends").status_code == 401
        login = client.post(
            "/api/auth/login", json={"username": "Admin", "password": "Admin@123"}
        )
        assert login.status_code == 200, login.text
        assert client.get("/api/metrics/trends").status_code == 200
        created = client.post(
            "/api/users",
            json={"username": "nometrics", "password": "nometrics-pass-1", "role": t1},
        )
        assert created.status_code == 200, created.text
        client.post("/api/auth/logout")
        low = client.post(
            "/api/auth/login",
            json={"username": "nometrics", "password": "nometrics-pass-1"},
        )
        assert low.status_code == 200, low.text
        assert client.get("/api/metrics/trends").status_code == 403
        # Same gate as the sibling posture rollup (contract parity).
        assert client.get("/api/metrics/posture").status_code == 403


# --------------------------------------------------------------------------- #
# The shared short-TTL case-page cache
# --------------------------------------------------------------------------- #
class _SpyStore:
    """Counts ``list`` calls; delegates to a fixed page."""

    def __init__(self, cases: list[Case], total: int | None = None) -> None:
        self.cases = cases
        self.total = total if total is not None else len(cases)
        self.calls = 0

    async def list(self, *, limit: int = 50, **_kw):
        self.calls += 1
        return list(self.cases[:limit]), self.total


async def test_cache_second_call_within_ttl_does_not_hit_the_store() -> None:
    store = _SpyStore([_case("c1", created=_iso(NOW))], total=1)
    a_cases, a_total = await metrics_shared.fetch_case_page(store, 5000)
    b_cases, b_total = await metrics_shared.fetch_case_page(store, 5000)
    assert store.calls == 1
    assert a_total == b_total == 1
    assert [c.case_id for c in a_cases] == [c.case_id for c in b_cases] == ["c1"]
    # Callers get their OWN list (mutation isolation).
    assert a_cases is not b_cases
    a_cases.clear()
    again, _ = await metrics_shared.fetch_case_page(store, 5000)
    assert [c.case_id for c in again] == ["c1"]


async def test_cache_is_keyed_by_fetch_limit() -> None:
    store = _SpyStore([_case(f"c{i}", created=_iso(NOW)) for i in range(3)], total=3)
    full, _ = await metrics_shared.fetch_case_page(store, 5000)
    assert len(full) == 3 and store.calls == 1
    # A different limit (the monkeypatched-_STORE_FETCH_LIMIT scenario) must NOT be
    # served from the limit-5000 entry — the truncation contract depends on it.
    small, total = await metrics_shared.fetch_case_page(store, 2)
    assert len(small) == 2 and total == 3
    assert store.calls == 2


async def test_cache_store_object_swap_bypasses_the_entry() -> None:
    # The Demo Mode pattern: state.cases swaps to a DIFFERENT store object while
    # demo is active (and back on disable) — identity guards the entry.
    real = _SpyStore([_case("real", created=_iso(NOW))])
    demo = _SpyStore([_case("demo", created=_iso(NOW))])
    first, _ = await metrics_shared.fetch_case_page(real, 5000)
    assert [c.case_id for c in first] == ["real"]
    swapped, _ = await metrics_shared.fetch_case_page(demo, 5000)
    assert [c.case_id for c in swapped] == ["demo"]
    assert real.calls == 1 and demo.calls == 1
    back, _ = await metrics_shared.fetch_case_page(real, 5000)
    assert [c.case_id for c in back] == ["real"]
    assert real.calls == 2  # the demo fetch overwrote the limit entry → refetch


async def test_cache_ttl_expiry_refetches(monkeypatch) -> None:
    store = _SpyStore([_case("c1", created=_iso(NOW))])
    monkeypatch.setattr(metrics_shared, "CASE_PAGE_TTL_SECONDS", 0.0)
    await metrics_shared.fetch_case_page(store, 5000)
    await metrics_shared.fetch_case_page(store, 5000)
    assert store.calls == 2


async def test_cache_errors_propagate_and_are_never_cached() -> None:
    class _FlakyStore:
        def __init__(self) -> None:
            self.calls = 0

        async def list(self, *, limit: int = 50, **_kw):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("store hiccup")
            return [], 0

    store = _FlakyStore()
    with pytest.raises(RuntimeError):
        await metrics_shared.fetch_case_page(store, 5000)
    cases, total = await metrics_shared.fetch_case_page(store, 5000)
    assert cases == [] and total == 0
    assert store.calls == 2  # the failure was not cached


async def test_cache_collapses_the_endpoint_fanout_to_one_scan(app_state, monkeypatch) -> None:
    """Posture + noise-reduction + auto-close-health + diagnostics/health in one
    refresh burst → ONE store.list scan."""
    from app.api.deps import require_auth
    from app.api.routes_diagnostics import router as diagnostics_router
    from app.api.routes_metrics import router as metrics_router

    await app_state.cases.save(
        _case("fan-1", created=_iso(datetime.now(timezone.utc) - timedelta(hours=1)))
    )
    inner = app_state._real_cases
    spy_calls = {"n": 0}
    real_list = inner.list

    async def _counting_list(**kw):
        spy_calls["n"] += 1
        return await real_list(**kw)

    monkeypatch.setattr(inner, "list", _counting_list)

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    api.include_router(diagnostics_router, dependencies=[Depends(require_auth)])
    client = TestClient(api)

    assert client.get("/api/metrics/posture?window_hours=24").status_code == 200
    assert client.get("/api/metrics/noise-reduction?window_hours=24").status_code == 200
    assert client.get("/api/metrics/auto-close-health?window_hours=24").status_code == 200
    assert client.get("/api/diagnostics/health?window_hours=24").status_code == 200
    assert client.get("/api/metrics/trends?window_hours=24").status_code == 200
    assert spy_calls["n"] == 1


# --------------------------------------------------------------------------- #
# count_created_since — ES (fake), SQLite, and the base-class fallback
# --------------------------------------------------------------------------- #
async def test_count_created_since_on_the_fake_es(app_state) -> None:
    now = datetime.now(timezone.utc)
    await app_state.cases.save(_case("in-1", created=_iso(now - timedelta(hours=1))))
    await app_state.cases.save(_case("in-2", created=_iso(now - timedelta(hours=2))))
    await app_state.cases.save(_case("out-1", created=_iso(now - timedelta(hours=30))))
    since = _iso(now - timedelta(hours=24))
    assert await app_state.cases.count_created_since(since) == 2
    assert await app_state.cases.count_created_since(_iso(now - timedelta(hours=48))) == 3


async def test_count_created_since_on_sqlite() -> None:
    from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        repo = SqlCaseRepository(engine)
        now = datetime.now(timezone.utc)
        await repo.save(_case("sql-in", created=_iso(now - timedelta(hours=1))))
        await repo.save(_case("sql-out", created=_iso(now - timedelta(hours=30))))
        since = _iso(now - timedelta(hours=24))
        assert await repo.count_created_since(since) == 1
        assert await repo.count_created_since(_iso(now - timedelta(hours=48))) == 2
    finally:
        await engine.dispose()


async def test_count_created_since_base_class_fallback() -> None:
    from app.stores.base import CaseRepository

    now = datetime.now(timezone.utc)
    page = [
        _case("fb-in", created=_iso(now - timedelta(hours=1))),
        _case("fb-out", created=_iso(now - timedelta(hours=30))),
        _case("fb-corrupt", created="not-a-timestamp"),
    ]

    class _MinimalRepo(CaseRepository):
        async def save(self, case): ...
        async def get(self, case_id): return None
        async def find_open_by_signature(self, signature): return None

        async def list(self, *, status=None, source_surface=None, entity_value=None,
                       limit=50, offset=0, sort_field="created_at", sort_order="desc"):
            return list(page[:limit]), len(page)

        async def list_scans(self, limit=50): return [], 0
        async def count_new_scans(self, since_iso): return 0

    repo = _MinimalRepo()
    # Inclusive window; the corrupt-timestamp case is skipped, never counted.
    assert await repo.count_created_since(_iso(now - timedelta(hours=24))) == 1
    assert await repo.count_created_since(_iso(now - timedelta(hours=48))) == 2
    # An unparseable boundary degrades to an honest 0.
    assert await repo.count_created_since("garbage") == 0
    # Z-suffix boundaries parse too.
    z_since = (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert await repo.count_created_since(z_since) == 1


async def test_sources_coverage_uses_the_count_pushdown(app_state, monkeypatch) -> None:
    from app.api.routes import sources_coverage

    now = datetime.now(timezone.utc)
    await app_state.cases.save(_case("cov-in", created=_iso(now - timedelta(hours=2))))
    await app_state.cases.save(_case("cov-out", created=_iso(now - timedelta(hours=48))))

    inner = app_state._real_cases
    list_calls = {"n": 0}
    real_list = inner.list

    async def _counting_list(**kw):
        list_calls["n"] += 1
        return await real_list(**kw)

    monkeypatch.setattr(inner, "list", _counting_list)
    cov = await sources_coverage(state=app_state, _=None)
    assert cov["alerts_triaged_24h"] == 1
    # The count is answered WITHOUT fetching any full case documents.
    assert list_calls["n"] == 0
