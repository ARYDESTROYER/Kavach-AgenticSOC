"""FXD1: ``GET /api/metrics/trends`` adds up to the window it names.

The trends grid starts on an aligned bucket edge, up to one bucket before the window
does. The route reads a population that reaches back that far, so before this fix the
first bucket also counted the cases (and alert hours) created between its aligned start
and the window's start: the Detection board read "57 cases in the last 7 days" beside
four panels that counted 56. The route now clips the first bucket to the window, keeps
the scope total honest (a clip is never a truncated read), and sums the alert hours the
noise funnel sums (from the hour the window starts in).

Offline (fake ES, no model). Read-time reporting only; nothing here touches
``decide()``, risk or signatures (#3).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.constants import CaseStatus, EntityType, SourceSurface
from app.models import Case, Entity

SIX_HOURS = 6 * 3600


def _case(cid: str, created: datetime) -> Case:
    iso = created.isoformat()
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        created_at=iso,
        updated_at=iso,
        status=CaseStatus.OPEN,
        confidence=0.9,
        risk_score=50.0,
    )


@pytest.fixture
def frozen(monkeypatch):
    """A route clock 3.5 hours into a 6-hour bucket, so a 7-day window starts 3.5 hours
    after the first bucket's aligned edge (168 hours is a whole number of buckets)."""
    from app.api import routes_metrics

    real = datetime.now(timezone.utc)
    edge = int(real.timestamp() // SIX_HOURS) * SIX_HOURS
    now = datetime.fromtimestamp(edge, tz=timezone.utc) - timedelta(hours=6) + timedelta(hours=3, minutes=30)

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # noqa: D401 -- the frozen route clock
            return now if tz is None else now.astimezone(tz)

    from app.engine import metrics as engine_metrics

    # The route and the engine read one clock, so the grid is the frozen one either way.
    monkeypatch.setattr(routes_metrics, "datetime", FrozenDatetime)
    monkeypatch.setattr(engine_metrics, "datetime", FrozenDatetime)
    return now


@pytest.fixture
def client(app_state):
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


async def test_first_bucket_counts_only_the_window(client, app_state, frozen) -> None:
    since = frozen - timedelta(hours=168)
    first_edge = datetime.fromtimestamp(int(since.timestamp() // SIX_HOURS) * SIX_HOURS, tz=timezone.utc)
    assert since - first_edge == timedelta(hours=3, minutes=30)
    # Inside the first bucket but before the window: not one of the window's cases.
    await app_state.cases.save(_case("before-window", first_edge + timedelta(hours=2)))
    # Inside the window.
    await app_state.cases.save(_case("in-window", frozen - timedelta(hours=2)))

    body = client.get("/api/metrics/trends?window_hours=168").json()

    assert body["buckets"][0]["t"] == first_edge.isoformat()
    assert sum(b["new_cases"] for b in body["buckets"]) == 1
    # The case left out lies before the window, so the scope shrinks with it.
    assert body["store_total"] == 1 and body["fetched"] == 1
    assert body["truncated"] is False


async def test_first_bucket_alerts_start_at_the_window_hour(client, app_state, frozen) -> None:
    since = frozen - timedelta(hours=168)
    first_edge = datetime.fromtimestamp(int(since.timestamp() // SIX_HOURS) * SIX_HOURS, tz=timezone.utc)
    # An alert hour wholly before the window, inside the first bucket.
    await app_state.noise_counters.record({"ingested": {"high": 5}}, now=first_edge + timedelta(hours=1))
    # The hour the window starts in: summed, as the noise funnel's read_window sums it.
    await app_state.noise_counters.record({"ingested": {"high": 2}}, now=since + timedelta(minutes=10))
    # An hour inside the window.
    await app_state.noise_counters.record({"ingested": {"low": 3}}, now=frozen - timedelta(hours=1))

    body = client.get("/api/metrics/trends?window_hours=168").json()

    alerts = [b["alerts"] for b in body["buckets"] if b["alerts"] is not None]
    assert sum(alerts) == 5
    assert body["buckets"][0]["alerts"] == 2
