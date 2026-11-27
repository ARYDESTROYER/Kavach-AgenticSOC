"""Round 16 WP12: metrics explained (SPEC §4.5 WP12; research explainability R8, R9, D10).

* ``GET /api/metrics/explain`` lists the cases behind a dashboard figure. Its figure
  is computed by the same code as the figure it explains: for a window, the explained
  p50 equals the posture p50 and ``sample_count`` equals the stat block's count; the
  FP rate and the SLA attainment equal posture's; the Active Risk Index equals
  ``GET /api/metrics``. At most 200 rows, centred on the median rank. Object scope
  filters rows (never the figure). A caller without ``cases:read`` gets no rows.
* ``mttr_by_decider`` splits the MTTR samples by recorded decider and sums to the total.
  The Analytics MTTR (``compute_metrics.mttr_lifecycle``) equals the posture p50 on the
  same population.
* ``feedback_stats`` reports no agreement rate (``None``) when nothing was graded (D10).
* All-time metric payloads say when their cases were read (``generated_at`` and
  ``case_population``), not when the route answered.

Offline: fake Elasticsearch and the mock model. Nothing here touches ``decide()``.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from app.config import SlaPolicy, SlaTarget
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import metrics as M
from app.models import Case, Entity, FeedbackEntry, StatusHistoryEntry
from tests.test_round16_wp06_performance import Clock, clock  # noqa: F401  (the clock fixture)

UTC = timezone.utc


def _case(
    cid: str,
    *,
    created: datetime,
    status: CaseStatus = CaseStatus.OPEN,
    history: list[tuple[str, str, datetime]] | None = None,
    acknowledged: datetime | None = None,
    risk: float = 10.0,
    decision_by: DecisionBy | None = None,
    verdict: Verdict | None = None,
    first_seen: datetime | None = None,
    priority: str | None = "P3",
) -> Case:
    return Case(
        case_id=cid,
        case_number=f"CASE-{cid}",
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="10.0.0.1"),
        title=f"Case {cid}",
        created_at=created.isoformat(),
        updated_at=created.isoformat(),
        status=status,
        risk_score=risk,
        decision_by=decision_by,
        verdict=verdict,
        acknowledged_at=acknowledged,
        priority_level=priority,
        first_seen_millis=int(first_seen.timestamp() * 1000) if first_seen else 0,
        status_history=[
            StatusHistoryEntry(from_status="open", to_status=to, by=by, at=at.isoformat())
            for to, by, at in (history or [])
        ],
    )


def _population(now: datetime) -> list[Case]:
    """A varied window: human acks, status moves, agent and analyst closes, first-event
    times, verdicts, plus one case outside the 24 hour window."""
    out: list[Case] = []
    for i in range(12):
        created = now - timedelta(hours=1 + i)
        kind = i % 4
        if kind == 0:
            out.append(_case(
                f"agent-{i}", created=created, status=CaseStatus.CLOSED,
                history=[("closed", "agent", created + timedelta(minutes=2 + i))],
                decision_by=DecisionBy.AGENT, verdict=Verdict.FALSE_POSITIVE, risk=12.0 + i,
                first_seen=created - timedelta(minutes=5 + i),
            ))
        elif kind == 1:
            out.append(_case(
                f"human-{i}", created=created, status=CaseStatus.RESOLVED,
                history=[("investigating", "Admin", created + timedelta(minutes=7 + i)),
                         ("resolved", "Admin", created + timedelta(minutes=40 + 3 * i))],
                decision_by=DecisionBy.ANALYST, verdict=Verdict.TRUE_POSITIVE, risk=70.0 + i,
            ))
        elif kind == 2:
            out.append(_case(
                f"ack-{i}", created=created, acknowledged=created + timedelta(minutes=11 + i),
                history=[("investigating", "Admin", created + timedelta(minutes=13 + i))],
                verdict=Verdict.NEEDS_HUMAN, risk=55.0 + i,
                first_seen=created - timedelta(minutes=2),
            ))
        else:
            out.append(_case(f"open-{i}", created=created, risk=30.0 + i, verdict=Verdict.FALSE_POSITIVE))
    out.append(_case(
        "old", created=now - timedelta(days=5), status=CaseStatus.CLOSED,
        history=[("closed", "agent", now - timedelta(days=5) + timedelta(minutes=1))],
        decision_by=DecisionBy.AGENT, verdict=Verdict.FALSE_POSITIVE,
    ))
    return out


async def _client(app_state) -> AsyncClient:
    from app.api.deps import require_auth
    from app.api.routes_metrics import router as metrics_router

    api = FastAPI()
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    api.state.tlsoc = app_state
    return AsyncClient(transport=ASGITransport(app=api), base_url="http://test")


async def _seed(app_state, cases: list[Case]) -> None:
    for case in cases:
        await app_state.cases.save(case)


async def _with_sla(app_state) -> None:
    sla = SlaPolicy(enabled=True, targets={"P3": SlaTarget(response_minutes=10, resolve_minutes=60)})
    await app_state.update_prefs(app_state.prefs.model_copy(update={"sla": sla}))


# =========================================================================== #
# The explained figure is the figure shown
# =========================================================================== #
@pytest.mark.parametrize("window_hours", [24, 0])
async def test_explained_medians_equal_the_posture_medians(app_state, window_hours) -> None:
    await _seed(app_state, _population(datetime.now(UTC)))
    async with await _client(app_state) as client:
        posture = (await client.get("/api/metrics/posture", params={"window_hours": window_hours})).json()
        for metric, field in M.EXPLAIN_TIMINGS.items():
            response = await client.get("/api/metrics/explain", params={"metric": metric, "window_hours": window_hours})
            assert response.status_code == 200, response.text
            body = response.json()
            block = posture["lifecycle"][field]
            assert body["stat"] == block, metric
            assert body["value"] == block["p50"]
            assert body["sample_count"] == block["count"] == len(body["samples"]), metric
            minutes = [row["minutes"] for row in body["samples"]]
            assert minutes == sorted(minutes)
            # The listed samples reproduce the median, to the block's rounding.
            assert round(M.percentile(minutes, 50) or 0.0, 1) == block["p50"]
            assert body["samples_truncated"] is False and body["hidden_by_scope"] == 0


async def test_explained_rates_equal_posture_and_the_risk_index_equals_metrics(app_state) -> None:
    from app.api.routes_metrics import legacy_metrics_payload

    await _with_sla(app_state)
    await _seed(app_state, _population(datetime.now(UTC)))
    async with await _client(app_state) as client:
        posture = (await client.get("/api/metrics/posture", params={"window_hours": 24})).json()
        fp = (await client.get("/api/metrics/explain", params={"metric": "fp_rate"})).json()
        sla = (await client.get("/api/metrics/explain", params={"metric": "sla_attainment"})).json()
        ari = (await client.get("/api/metrics/explain", params={"metric": "active_risk_index"})).json()
    quality = posture["quality"]
    assert fp["value"] == quality["false_positive_rate"]
    assert (fp["numerator"], fp["denominator"]) == (quality["false_positive_cases"], quality["verdicted_cases"])
    assert sum(1 for row in fp["samples"] if row["counted"]) == fp["numerator"]
    assert sla["value"] == posture["sla"]["attainment_pct"]
    assert sla["denominator"] == posture["sla"]["evaluated"] == sla["sample_count"]
    assert round(100.0 * sla["numerator"] / sla["denominator"], 1) == sla["value"]
    legacy = await legacy_metrics_payload(app_state, 24)
    assert ari["value"] == legacy["active_risk_index"]
    assert ari["denominator"] == legacy["active_risk_case_count"]
    assert round(ari["numerator"] / ari["denominator"], 1) == ari["value"]
    risks = [row["value"] for row in ari["samples"]]
    assert risks == sorted(risks, reverse=True) and ari["window_hours"] == 0


async def test_an_unknown_metric_is_refused(app_state) -> None:
    async with await _client(app_state) as client:
        response = await client.get("/api/metrics/explain", params={"metric": "nonsense"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "explain_metric_unknown"


async def test_an_unreadable_store_is_a_503_not_a_zero(app_state, monkeypatch) -> None:
    from app.api import metrics_shared

    async def broken(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("store down")

    monkeypatch.setattr(app_state.cases, "scan_page", broken, raising=False)
    monkeypatch.setattr(app_state.cases, "list", broken, raising=False)
    metrics_shared.invalidate_case_population_cache()
    async with await _client(app_state) as client:
        response = await client.get("/api/metrics/explain", params={"metric": "mttr"})
    assert response.status_code == 503


# =========================================================================== #
# Bounds: 200 rows centred on the median; truncation markers; scope; grants
# =========================================================================== #
def test_more_than_200_samples_list_the_run_around_the_median() -> None:
    now = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
    cases = [
        _case(
            f"c{i:03d}", created=now - timedelta(hours=1), status=CaseStatus.CLOSED,
            history=[("closed", "agent", now - timedelta(hours=1) + timedelta(minutes=i + 1))],
            decision_by=DecisionBy.AGENT,
        )
        for i in range(251)
    ]
    out = M.explain_metric(cases, "mttr", window_hours=24, now=now)
    assert out["sample_count"] == 251 and len(out["samples"]) == 200
    assert out["samples_truncated"] is True
    offset = out["samples_offset"]
    # The median rank (125) and its neighbours are listed, and the offset says where.
    ranks = range(offset, offset + 200)
    assert 125 in ranks and 124 in ranks and 126 in ranks
    assert out["samples"][125 - offset]["minutes"] == pytest.approx(out["stat"]["p50"])


async def test_a_truncated_population_says_so(app_state, monkeypatch) -> None:
    from app.api import routes_metrics

    monkeypatch.setattr(routes_metrics, "_STORE_FETCH_LIMIT", 4)
    await _seed(app_state, _population(datetime.now(UTC)))
    async with await _client(app_state) as client:
        body = (await client.get("/api/metrics/explain", params={"metric": "mttr"})).json()
    assert body["truncated"] is True and body["fetched"] == 4 and body["store_total"] > 4


async def test_object_scope_filters_rows_never_the_figure(app_state, monkeypatch) -> None:
    from app.engine import chat_starters
    from app.rbac import policy

    await _seed(app_state, _population(datetime.now(UTC)))
    async with await _client(app_state) as client:
        open_view = (await client.get("/api/metrics/explain", params={"metric": "mttr"})).json()
        monkeypatch.setattr(chat_starters, "object_scoped", lambda _state, _role: True)
        monkeypatch.setattr(
            policy, "can_object",
            lambda _user, _res, _act, case, **_k: not str(case.case_id).startswith("agent-"),
        )
        scoped = (await client.get("/api/metrics/explain", params={"metric": "mttr"})).json()
    assert scoped["stat"] == open_view["stat"]
    assert scoped["sample_count"] == open_view["sample_count"]
    agents = sum(1 for row in open_view["samples"] if row["case_id"].startswith("agent-"))
    assert agents > 0 and scoped["hidden_by_scope"] == agents
    assert all(not row["case_id"].startswith("agent-") for row in scoped["samples"])
    assert scoped["visible_count"] == len(scoped["samples"]) == open_view["sample_count"] - agents


async def test_without_cases_read_the_rows_are_withheld(app_state, monkeypatch) -> None:
    from app.api import routes_metrics

    async def grants(_request: Any, resource: str, action: str) -> bool:
        return not (resource == "cases" and action == "read")

    monkeypatch.setattr(routes_metrics, "has_permission", grants)
    await _seed(app_state, _population(datetime.now(UTC)))
    async with await _client(app_state) as client:
        body = (await client.get("/api/metrics/explain", params={"metric": "mtta"})).json()
    assert body["samples"] == [] and body["sample_count"] > 0
    assert body["samples_withheld"] == routes_metrics.EXPLAIN_SAMPLES_WITHHELD
    assert body["stat"]["available"] is True


async def test_demo_mode_explains_the_demo_cases(app_state) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        async with await _client(app_state) as client:
            posture = (await client.get("/api/metrics/posture", params={"window_hours": 168})).json()
            body = (await client.get("/api/metrics/explain", params={"metric": "mttr", "window_hours": 168})).json()
        assert body["stat"] == posture["lifecycle"]["mttr_minutes"]
        ids = {row["case_id"] for row in body["samples"]}
        assert ids and all(cid.startswith("demo-") for cid in ids)
    finally:
        await app_state.disable_demo()


# =========================================================================== #
# MTTR by decider; one MTTR on Analytics
# =========================================================================== #
def test_mttr_by_decider_sums_to_the_total() -> None:
    now = datetime.now(UTC)
    cases = _population(now) + [
        _case("legacy", created=now - timedelta(hours=2), status=CaseStatus.CLOSED,
              history=[("closed", "Admin", now - timedelta(hours=1))]),
        _case("policy", created=now - timedelta(hours=2), status=CaseStatus.CLOSED,
              history=[("closed", "analyst_policy", now - timedelta(minutes=110))],
              decision_by=DecisionBy.ANALYST_POLICY),
    ]
    life = M.lifecycle_intervals(cases)
    split = life["mttr_by_decider"]
    assert set(split) == set(M.MTTR_DECIDERS)
    assert sum(block["count"] for block in split.values()) == life["mttr_minutes"]["count"]
    assert split["unrecorded"]["count"] == 1 and split["analyst_policy"]["count"] == 1
    assert split["agent"]["count"] > 0 and split["analyst"]["count"] > 0
    metrics = M.compute_metrics(cases)
    assert sum(b["count"] for b in metrics["mttr_by_decider"].values()) == metrics["resolved_count"]


async def test_analytics_mttr_equals_the_overview_p50(app_state) -> None:
    from app.api.routes_metrics import legacy_metrics_payload

    await _seed(app_state, _population(datetime.now(UTC)))
    legacy = await legacy_metrics_payload(app_state, 24)
    async with await _client(app_state) as client:
        posture = (await client.get("/api/metrics/posture", params={"window_hours": 0})).json()
    assert legacy["mttr_lifecycle"] == posture["lifecycle"]["mttr_minutes"]
    assert legacy["mttr_lifecycle"]["count"] == legacy["resolved_count"]
    assert legacy["mttr_by_decider"] == posture["lifecycle"]["mttr_by_decider"]


def test_lifecycle_samples_keep_the_rollup_floats() -> None:
    """The detail samples are the very floats the rollup counts."""
    cases = _population(datetime.now(UTC))
    plain = M.lifecycle_samples(cases)
    rich = M.lifecycle_samples(cases, detail=True)
    for key in ("mtta", "mttr", "dwell", "mttd"):
        assert plain[key] == [s.minutes for s in rich[key]]
    anchors = {s.end_anchor for s in rich["mtta"]}
    assert anchors == {"acknowledged_at", "status_history"}


# =========================================================================== #
# D10: no agreement rate when nothing was graded
# =========================================================================== #
def test_no_grades_means_no_agreement_rate() -> None:
    now = datetime.now(UTC)
    stats = M.feedback_stats([_case("x", created=now)])
    assert stats["agreement_rate"] is None
    assert stats["agreement_signals"] == 0 and stats["agreement_agreed"] == 0


def test_the_agreement_population_prints_its_arithmetic() -> None:
    now = datetime.now(UTC)
    graded = _case("g", created=now)
    graded.feedback = [
        FeedbackEntry(assessment="agree"), FeedbackEntry(assessment="partial"),
        FeedbackEntry(assessment="disagree"), FeedbackEntry(assessment=""),
    ]
    stats = M.feedback_stats([graded])
    assert (stats["agreement_agreed"], stats["agreement_partial"], stats["agreement_disagreed"]) == (1, 1, 1)
    assert stats["agreement_signals"] == 3 and stats["feedback_count"] == 4
    assert stats["agreement_rate"] == pytest.approx(round((1 + 0.5 * 1) / 3, 4))


# =========================================================================== #
# All-time payloads say when their cases were read
# =========================================================================== #
async def test_all_time_payloads_carry_the_population_read_time(app_state, clock) -> None:  # noqa: F811
    from app.api.routes_metrics import legacy_metrics_payload

    await _seed(app_state, _population(datetime.now(UTC)))
    first = await legacy_metrics_payload(app_state, 24)
    read_at = first["case_population"]["read_at"]
    assert read_at and first["generated_at"] == read_at
    time.sleep(0.05)
    clock.now = 1030.0  # 30 s later the same population answers
    later = await legacy_metrics_payload(app_state, 24)
    assert later["generated_at"] == read_at and later["case_population"]["read_at"] == read_at
    async with await _client(app_state) as client:
        for path, params in (
            ("/api/metrics/posture", {"window_hours": 0}),
            ("/api/metrics/auto-close-health", {"window_hours": 24}),
            ("/api/metrics/auto-close-health/recorded", {"window_hours": 24}),
            ("/api/metrics/agent-improvement", {}),
            ("/api/metrics/noise-reduction", {"window_hours": 0}),
            ("/api/mitre/coverage", {"window_hours": 0}),
            ("/api/metrics/explain", {"metric": "active_risk_index"}),
        ):
            body = (await client.get(path, params=params)).json()
            assert body["generated_at"] == read_at, path
            assert body["case_population"]["read_at"] == read_at, path
        windowed = (await client.get("/api/metrics/posture", params={"window_hours": 24})).json()
    # A windowed rollup keeps its own instant (its population lives 5 s).
    assert "case_population" not in windowed
