"""Section 5 — make the SILENT failures observable.

Every defect in the precedent/auto-close incident was invisible: no warning, no
metric, no UI signal. These tests pin the three signals that turn each of them into a
DIAGNOSABLE STATE, and — just as importantly — pin the honesty rules that keep them
trustworthy:

* a starved precedent corpus (0 analyst-confirmed precedents) raises the flag;
* a healthy corpus does not;
* the not-yet-projected state is reported as UNKNOWN, never as a collapse;
* a failed SQL schema migration surfaces (strict audit writes are broken);
* an auto-close rate that falls to ~0 **while volume holds steady** is distinguishable
  from a quiet period with no cases; and
* the diagnostics endpoint requires authentication.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_diagnostics import (
    _build_alerts,
    _projection_block,
    _schema_migration_block,
    router as diagnostics_router,
)
from app.api.routes_metrics import router as metrics_router
from app.config import AutoClosePolicy, Preferences, Secrets, VerdictAutoClose
from app.constants import (
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.metrics import (
    AUTO_CLOSE_MIN_DECIDED,
    auto_close_health,
    precedent_ground_truth,
)
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, FeedbackEntry
from app.state import AppState

NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
def _case(
    cid: str,
    *,
    decided_hours_ago: float,
    verdict: Verdict | None = Verdict.FALSE_POSITIVE,
    decision_by: DecisionBy | None = DecisionBy.AGENT,
    status: CaseStatus = CaseStatus.CLOSED,
    feedback_outcome: str | None = None,
) -> Case:
    """A case whose deterministic DECISION landed ``decided_hours_ago`` hours before
    ``NOW`` (the anchor the rolling auto-close rate uses)."""
    at = (NOW - timedelta(hours=decided_hours_ago)).isoformat()
    case = Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        created_at=at,
        updated_at=at,
        verdict=verdict,
        confidence=0.95,
        status=status,
        decision_by=decision_by,
    )
    case.history.append(
        {
            "ts": at,
            "event": "decision",
            "status": status.value,
            "decision_by": decision_by.value if decision_by else "",
            "escalate": False,
            "rationale": "test",
        }
    )
    if feedback_outcome:
        case.feedback.append(
            FeedbackEntry(ts=at, analyst="ana", assessment="agree", actual_outcome=feedback_outcome)
        )
    return case


def _auto_closed(n: int, *, hours_ago: float, prefix: str) -> list[Case]:
    return [_case(f"{prefix}{i}", decided_hours_ago=hours_ago) for i in range(n)]


def _routed_to_human(n: int, *, hours_ago: float, prefix: str) -> list[Case]:
    return [
        _case(
            f"{prefix}{i}",
            decided_hours_ago=hours_ago,
            decision_by=DecisionBy.SYSTEM,
            status=CaseStatus.NEEDS_HUMAN,
        )
        for i in range(n)
    ]


# A precedent block with nothing wrong with it, for the alert-builder unit tests.
_HEALTHY_PRECEDENT = {
    "known": True,
    "starved": False,
    "status_reason": "",
    "reason": "",
    "projection": {"available": True, "collapsed_sources": [], "shrank_sources": []},
}

_ENABLED_POLICY = AutoClosePolicy(false_positive=VerdictAutoClose(enabled=True))
_DISABLED_POLICY = AutoClosePolicy(
    false_positive=VerdictAutoClose(enabled=False),
    true_positive=VerdictAutoClose(enabled=False),
)


# --------------------------------------------------------------------------- #
# Auto-close rate as a first-class health signal
# --------------------------------------------------------------------------- #
def test_auto_close_collapse_with_steady_volume_is_detected() -> None:
    """The outage: the rate falls to ~0 while investigation volume holds steady."""
    cases = (
        # Baseline window (24-48h ago): 20 decided, 18 auto-closed.
        _auto_closed(18, hours_ago=36, prefix="base-auto-")
        + _routed_to_human(2, hours_ago=36, prefix="base-human-")
        # Current window (0-24h): SAME volume, zero auto-closes.
        + _routed_to_human(20, hours_ago=6, prefix="now-human-")
    )
    out = auto_close_health(cases, window_hours=24, policy=_ENABLED_POLICY, now=NOW)

    assert out["status"] == "collapsed"
    assert out["collapsed"] is True
    assert out["needs_attention"] is True
    assert out["volume_steady"] is True
    assert out["current"]["decided"] == 20
    assert out["current"]["rate"] == 0.0
    assert out["baseline"]["rate"] == 0.9
    assert "held steady" in out["reason"]


def test_quiet_period_with_no_cases_is_not_a_collapse() -> None:
    """A quiet window must read as ``no_volume`` — the distinction the report asks for."""
    cases = _auto_closed(18, hours_ago=36, prefix="base-auto-") + _routed_to_human(
        2, hours_ago=36, prefix="base-human-"
    )
    out = auto_close_health(cases, window_hours=24, policy=_ENABLED_POLICY, now=NOW)

    assert out["status"] == "no_volume"
    assert out["collapsed"] is False
    assert out["needs_attention"] is False
    assert out["volume_steady"] is False
    assert out["current"]["decided"] == 0
    # Insufficient evidence never becomes a healthy-looking number.
    assert out["current"]["rate"] == "—"
    assert out["current"]["available"] is False
    assert "investigation-volume gap" in out["reason"]


def test_low_volume_window_reports_insufficient_evidence_not_a_rate() -> None:
    """Two samples must not become a rate — the window is explicitly insufficient."""
    cases = _auto_closed(20, hours_ago=36, prefix="base-auto-") + _routed_to_human(
        2, hours_ago=6, prefix="now-human-"
    )
    out = auto_close_health(cases, window_hours=24, policy=_ENABLED_POLICY, now=NOW)

    assert out["status"] == "insufficient_evidence"
    assert out["collapsed"] is False
    assert out["current"]["available"] is False
    assert out["current"]["rate"] == "—"
    assert str(AUTO_CLOSE_MIN_DECIDED) in out["current"]["reason"]


def test_healthy_auto_close_rate_is_ok() -> None:
    cases = (
        _auto_closed(18, hours_ago=36, prefix="base-auto-")
        + _routed_to_human(2, hours_ago=36, prefix="base-human-")
        + _auto_closed(17, hours_ago=6, prefix="now-auto-")
        + _routed_to_human(3, hours_ago=6, prefix="now-human-")
    )
    out = auto_close_health(cases, window_hours=24, policy=_ENABLED_POLICY, now=NOW)

    assert out["status"] == "ok"
    assert out["collapsed"] is False
    assert out["needs_attention"] is False
    assert out["current"]["rate"] == 0.85


def test_configured_off_auto_close_is_not_reported_as_an_outage() -> None:
    """A zero rate the operator asked for is ``disabled``, never a collapse."""
    cases = _routed_to_human(30, hours_ago=6, prefix="now-human-")
    out = auto_close_health(cases, window_hours=24, policy=_DISABLED_POLICY, now=NOW)

    assert out["status"] == "disabled"
    assert out["collapsed"] is False
    assert out["needs_attention"] is False
    assert out["policy"]["any_enabled"] is False


def test_enabled_auto_close_that_never_fired_is_surfaced() -> None:
    """"Auto-close stopped forever" stays visible after both windows are already 0."""
    cases = _routed_to_human(40, hours_ago=6, prefix="now-human-")
    out = auto_close_health(cases, window_hours=24, policy=_ENABLED_POLICY, now=NOW)

    assert out["status"] == "never_fired"
    assert out["needs_attention"] is True
    assert out["lifetime"]["auto_closed"] == 0


def test_auto_close_health_never_influences_the_decision(monkeypatch) -> None:
    """#3 — the derivation is read-only and must not touch ``decide()``."""
    from app.engine import case_manager

    def _boom(*args, **kwargs):  # pragma: no cover - only runs on a regression
        raise AssertionError("auto_close_health must never call decide()")

    monkeypatch.setattr(case_manager, "decide", _boom)
    out = auto_close_health(
        _auto_closed(12, hours_ago=6, prefix="c-"), window_hours=24, policy=_ENABLED_POLICY, now=NOW
    )
    assert out["status"] in ("ok", "insufficient_evidence")


# --------------------------------------------------------------------------- #
# Analyst-confirmed ground truth behind the precedent corpus
# --------------------------------------------------------------------------- #
def test_ground_truth_counts_only_analyst_confirmed_outcomes() -> None:
    graded = _case("graded", decided_hours_ago=1, feedback_outcome="false_positive")
    ungraded = _case("ungraded", decided_hours_ago=1)  # terminal + AI verdict only
    out = precedent_ground_truth([graded, ungraded])

    assert out["analyst_confirmed_cases"] == 1
    assert out["terminal_cases"] == 2
    assert out["zero_analyst_confirmed_cases"] is False
    assert out["by_outcome"] == {"false_positive": 1}
    assert out["by_evidence_source"] == {"analyst_feedback": 1}


def test_ground_truth_zero_flag_is_explicit_when_nothing_is_graded() -> None:
    out = precedent_ground_truth(_auto_closed(5, hours_ago=1, prefix="c-"))
    assert out["analyst_confirmed_cases"] == 0
    assert out["zero_analyst_confirmed_cases"] is True


# --------------------------------------------------------------------------- #
# Projection honesty: not-yet-projected is UNKNOWN, not a collapse
# --------------------------------------------------------------------------- #
class _FakeRag:
    def __init__(self, last_projection=None, documents=None, fail: bool = False) -> None:
        self.last_projection = last_projection if last_projection is not None else {}
        self._documents = documents or []
        self._fail = fail

    async def snapshot_documents_strict(self):
        if self._fail:
            raise RuntimeError("vector store unavailable")
        return list(self._documents)


def test_not_yet_projected_is_reported_as_unknown_not_a_collapse() -> None:
    block = _projection_block(_FakeRag())
    assert block["available"] is False
    assert block["state"] == "not_yet_projected"
    assert block["scope"] == "in_process"
    assert block["collapsed_sources"] == []
    assert block["shrank_sources"] == []
    assert "not evidence of an empty or collapsed corpus" in block["reason"]


def test_recorded_projection_surfaces_a_collapsed_enabled_source() -> None:
    rag = _FakeRag(
        last_projection={
            "resolved_case": {
                "source": "resolved_case", "before": 2000, "after": 0, "delta": -2000,
                "shrank": True, "collapsed": True, "source_enabled": True, "at": "t",
            },
            "mitre": {
                "source": "mitre", "before": 697, "after": 697, "delta": 0,
                "shrank": False, "collapsed": False, "source_enabled": True, "at": "t",
            },
        }
    )
    block = _projection_block(rag)
    assert block["available"] is True
    assert block["collapsed_sources"] == ["resolved_case"]
    assert block["shrank_sources"] == ["resolved_case"]


def test_a_disabled_source_going_to_zero_is_not_an_alert() -> None:
    """Turning a source OFF is expected to empty it — never a defect signal."""
    rag = _FakeRag(
        last_projection={
            "resolved_case": {
                "source": "resolved_case", "before": 2000, "after": 0, "delta": -2000,
                "shrank": True, "collapsed": True, "source_enabled": False, "at": "t",
            }
        }
    )
    block = _projection_block(rag)
    assert block["available"] is True
    assert block["collapsed_sources"] == []
    assert block["shrank_sources"] == []


# --------------------------------------------------------------------------- #
# Trust tiers: a lower-trust precedent tier must never inflate the CONFIRMED count
# --------------------------------------------------------------------------- #
class _FakeRagCfg:
    def __init__(self, *, unconfirmed: bool) -> None:
        self.enabled = True
        self.use_resolved_cases = True
        self.use_unconfirmed_resolved_cases = unconfirmed


class _FakePrefs:
    def __init__(self, *, unconfirmed: bool) -> None:
        self.rag = _FakeRagCfg(unconfirmed=unconfirmed)
        self.auto_close = _ENABLED_POLICY


class _FakeState:
    def __init__(self, rag, *, unconfirmed: bool) -> None:
        self.rag_service = rag
        self.prefs = _FakePrefs(unconfirmed=unconfirmed)


@pytest.mark.asyncio
async def test_lower_trust_precedent_does_not_count_as_analyst_confirmed() -> None:
    """Both tiers share the ``resolved_case`` source; only the graded one is ground truth."""
    from app.api.routes_diagnostics import _precedent_corpus_block

    graded = _case("c-graded", decided_hours_ago=1, feedback_outcome="false_positive")
    ungraded = _case("c-model", decided_hours_ago=1)
    docs = [
        {"document_id": "resolved_case:c-graded", "source": "resolved_case", "chunk_count": 1},
        {"document_id": "resolved_case:c-model", "source": "resolved_case", "chunk_count": 1},
    ]
    rag = _FakeRag(documents=docs)

    block = await _precedent_corpus_block(_FakeState(rag, unconfirmed=True), [graded, ungraded], 2)
    assert block["unconfirmed_tier_enabled"] is True
    assert block["precedent_documents"] == 2
    assert block["analyst_confirmed_precedent_documents"] == 1
    assert block["analyst_confirmed_count_exact"] is True
    assert block["zero_analyst_confirmed_precedents"] is False
    assert block["status"] == "ok"


@pytest.mark.asyncio
async def test_only_lower_trust_precedent_still_reads_as_starved() -> None:
    """A corpus of nothing but model-closed precedent has zero analyst-confirmed ground truth."""
    from app.api.routes_diagnostics import _precedent_corpus_block

    ungraded = _case("c-model", decided_hours_ago=1)
    docs = [
        {"document_id": "resolved_case:c-model", "source": "resolved_case", "chunk_count": 1}
    ]
    block = await _precedent_corpus_block(
        _FakeState(_FakeRag(documents=docs), unconfirmed=True), [ungraded], 1
    )
    assert block["precedent_documents"] == 1
    assert block["analyst_confirmed_precedent_documents"] == 0
    assert block["zero_analyst_confirmed_precedents"] is True
    assert block["starved"] is True


@pytest.mark.asyncio
async def test_bounded_case_read_reports_unknown_not_a_false_starvation() -> None:
    """A partial case fetch makes the confirmed count a lower bound — say so, don't alarm."""
    from app.api.routes_diagnostics import _precedent_corpus_block

    docs = [
        {"document_id": "resolved_case:old", "source": "resolved_case", "chunk_count": 1}
    ]
    block = await _precedent_corpus_block(
        # store_total (9999) far exceeds the fetched page (1 case).
        _FakeState(_FakeRag(documents=docs), unconfirmed=True),
        [_case("recent", decided_hours_ago=1)],
        9999,
    )
    assert block["analyst_confirmed_count_exact"] is False
    assert block["known"] is False
    assert block["status"] == "unknown"
    assert block["zero_analyst_confirmed_precedents"] is False
    assert block["starved"] is False


# --------------------------------------------------------------------------- #
# SQL schema-migration state
# --------------------------------------------------------------------------- #
def test_failed_sql_migration_surfaces_with_remediation(monkeypatch) -> None:
    from app.stores.sql import engine as sql_engine

    monkeypatch.setitem(sql_engine.SCHEMA_MIGRATION_STATUS, "state", "failed")
    monkeypatch.setitem(sql_engine.SCHEMA_MIGRATION_STATUS, "detail", "permission denied")
    monkeypatch.setitem(
        sql_engine.SCHEMA_MIGRATION_STATUS, "remediation", "ALTER TABLE audit ..."
    )

    class _S:
        state_backend = "postgres"

    class _State:
        secrets = _S()

    block = _schema_migration_block(_State())
    assert block["available"] is True
    assert block["state"] == "failed"
    assert block["failed"] is True
    assert block["remediation"] == "ALTER TABLE audit ..."

    alerts, _unknowns = _build_alerts(
        _HEALTHY_PRECEDENT,
        block,
        {"status": "ok", "reason": ""},
    )
    ids = [a["id"] for a in alerts]
    assert "sql_schema_migration_failed" in ids
    failed = next(a for a in alerts if a["id"] == "sql_schema_migration_failed")
    assert failed["severity"] == "critical"
    assert "ALTER TABLE audit" in failed["remediation"]


def test_ok_sql_migration_raises_no_alert(monkeypatch) -> None:
    from app.stores.sql import engine as sql_engine

    monkeypatch.setitem(sql_engine.SCHEMA_MIGRATION_STATUS, "state", "ok")

    class _S:
        state_backend = "postgres"

    class _State:
        secrets = _S()

    block = _schema_migration_block(_State())
    assert block["failed"] is False
    alerts, _ = _build_alerts(
        _HEALTHY_PRECEDENT,
        block,
        {"status": "ok", "reason": ""},
    )
    assert alerts == []


# --------------------------------------------------------------------------- #
# The endpoint — with auth OFF (the default profile) and ON
# --------------------------------------------------------------------------- #
def _make_client(
    *,
    auth: bool,
    rag_config_update: dict | None = None,
    rag=None,
    denies: dict | None = None,
):
    secrets_kwargs = dict(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    if auth:
        secrets_kwargs.update(
            auth_enabled=True,
            auth_jwt_secret="diagnostics-observability-secret",
            auth_seed_admin=True,
        )
    secrets = Secrets(**secrets_kwargs)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides
        )
        await state.startup(start_poller=False)
        prefs: Preferences = state.prefs.model_copy(update={"setup_complete": True})
        if denies is not None:
            prefs = prefs.model_copy(
                update={"rbac": prefs.rbac.model_copy(update={"enabled": True, "denies": denies})}
            )
        if rag_config_update:
            prefs = prefs.model_copy(
                update={"rag": prefs.rag.model_copy(update=rag_config_update)}
            )
        await state.update_prefs(prefs)
        if rag is not None:
            state.rag = rag
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else []
    api.include_router(monolith_router, dependencies=deps)
    api.include_router(diagnostics_router, dependencies=deps)
    api.include_router(metrics_router, dependencies=deps)
    return TestClient(api)


def test_diagnostics_endpoint_requires_auth() -> None:
    with _make_client(auth=True) as client:
        r = client.get("/api/diagnostics/health")
        assert r.status_code == 401, r.text
        r = client.get("/api/metrics/auto-close-health")
        assert r.status_code == 401, r.text

        login = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
        assert login.status_code == 200, login.text

        r = client.get("/api/diagnostics/health")
        assert r.status_code == 200, r.text
        assert "precedent_corpus" in r.json()


def test_diagnostics_endpoint_enforces_its_permission_not_just_authentication() -> None:
    """Authenticated is not enough: the existing read grants are actually enforced."""
    from app.constants import UserRole

    t1 = UserRole.ANALYST_TIER1.value
    denies = {t1: {"settings": ["read"], "metrics": ["view"]}}
    with _make_client(auth=True, denies=denies) as client:
        admin = client.post(
            "/api/auth/login", json={"username": "Admin", "password": "Admin@123"}
        )
        assert admin.status_code == 200, admin.text
        # super_admin is lockout-proof and still sees the diagnostics.
        assert client.get("/api/diagnostics/health").status_code == 200
        created = client.post(
            "/api/users",
            json={"username": "lowread", "password": "lowread-pass-1", "role": t1},
        )
        assert created.status_code == 200, created.text
        client.post("/api/auth/logout")

        low = client.post(
            "/api/auth/login", json={"username": "lowread", "password": "lowread-pass-1"}
        )
        assert low.status_code == 200, low.text
        assert client.get("/api/diagnostics/health").status_code == 403
        assert client.get("/api/metrics/auto-close-health").status_code == 403


def test_diagnostics_endpoint_is_not_the_public_health_endpoint() -> None:
    """The precedent/corpus detail must NOT leak onto the unauthenticated route."""
    with _make_client(auth=True) as client:
        r = client.get("/api/health")
        assert r.status_code == 200, r.text
        body = r.json()
        for leaked in ("precedent_corpus", "auto_close", "schema_migration", "alerts"):
            assert leaked not in body, f"/api/health must not expose {leaked}"


def test_starved_corpus_raises_the_flag_through_the_endpoint() -> None:
    """A fresh deployment has an empty corpus: the state is diagnosable, not silent."""
    with _make_client(auth=False, rag=_FakeRag(documents=[])) as client:
        r = client.get("/api/diagnostics/health")
        assert r.status_code == 200, r.text
        corpus = r.json()["precedent_corpus"]
        assert corpus["known"] is True
        assert corpus["precedent_documents"] == 0
        assert corpus["zero_analyst_confirmed_precedents"] is True
        assert corpus["starved"] is True
        assert corpus["status"] == "starved"
        ids = [a["id"] for a in r.json()["alerts"]]
        assert "precedent_corpus_starved" in ids


def test_healthy_corpus_does_not_raise_the_flag() -> None:
    docs = [
        {"document_id": "resolved_case:c1", "source": "resolved_case", "chunk_count": 1},
        {"document_id": "resolved_case:c2", "source": "resolved_case", "chunk_count": 1},
        {"document_id": "seed:mitre", "source": "mitre", "chunk_count": 697},
    ]
    with _make_client(auth=False, rag=_FakeRag(documents=docs)) as client:
        r = client.get("/api/diagnostics/health")
        assert r.status_code == 200, r.text
        corpus = r.json()["precedent_corpus"]
        assert corpus["precedent_documents"] == 2
        assert corpus["precedent_chunks"] == 2
        assert corpus["zero_analyst_confirmed_precedents"] is False
        assert corpus["starved"] is False
        assert corpus["status"] == "ok"
        assert corpus["chunks_by_source"]["mitre"] == 697
        ids = [a["id"] for a in r.json()["alerts"]]
        assert "precedent_corpus_starved" not in ids


def test_unreadable_corpus_is_unknown_not_a_confirmed_zero() -> None:
    with _make_client(auth=False, rag=_FakeRag(fail=True)) as client:
        r = client.get("/api/diagnostics/health")
        assert r.status_code == 200, r.text
        body = r.json()
        corpus = body["precedent_corpus"]
        assert corpus["known"] is False
        assert corpus["status"] == "unknown"
        # A store outage must never masquerade as a confirmed starvation.
        assert corpus["zero_analyst_confirmed_precedents"] is False
        assert corpus["starved"] is False
        unknown_ids = [u["id"] for u in body["unknowns"]]
        assert "precedent_corpus_unreadable" in unknown_ids
        assert "precedent_corpus_starved" not in [a["id"] for a in body["alerts"]]


def test_disabled_precedent_source_is_reported_as_configured_not_starved() -> None:
    with _make_client(
        auth=False, rag=_FakeRag(documents=[]), rag_config_update={"use_resolved_cases": False}
    ) as client:
        body = client.get("/api/diagnostics/health").json()
        corpus = body["precedent_corpus"]
        assert corpus["precedent_source_enabled"] is False
        assert corpus["status"] == "disabled"
        assert corpus["starved"] is False
        # The count itself is still reported honestly.
        assert corpus["zero_analyst_confirmed_precedents"] is True
        assert "precedent_corpus_starved" not in [a["id"] for a in body["alerts"]]


def test_auto_close_health_endpoint_returns_the_signal() -> None:
    with _make_client(auth=False) as client:
        r = client.get("/api/metrics/auto-close-health?window_hours=24")
        assert r.status_code == 200, r.text
        body = r.json()
        for key in ("status", "current", "baseline", "lifetime", "policy", "collapsed"):
            assert key in body
        # An empty deployment is honest about having nothing to measure.
        assert body["status"] == "no_volume"
        assert body["current"]["rate"] == "—"
        assert body["collapsed"] is False


def test_diagnostics_rollup_reports_counts_not_a_composite_score() -> None:
    with _make_client(auth=False, rag=_FakeRag(documents=[])) as client:
        body = client.get("/api/diagnostics/health").json()
        assert body["alert_count"] == len(body["alerts"])
        assert body["unknown_count"] == len(body["unknowns"])
        assert "score" not in body
        # not-yet-projected is carried as an UNKNOWN, never a detected collapse.
        assert "rag_projection_unknown" in [u["id"] for u in body["unknowns"]]


@pytest.mark.parametrize("path", ["/api/diagnostics/health", "/api/metrics/auto-close-health"])
def test_new_routes_are_registered_on_the_real_app(path: str) -> None:
    from app.main import app

    paths = {r.path for r in app.routes if r.__class__.__name__ == "APIRoute"}
    assert path in paths


def test_disposition_alone_is_not_analyst_confirmed_ground_truth() -> None:
    """A model-derived disposition must never inflate the precedent count."""
    case = _case("c", decided_hours_ago=1)
    case.disposition = Disposition.FALSE_POSITIVE
    out = precedent_ground_truth([case])
    assert out["analyst_confirmed_cases"] == 0
    assert out["zero_analyst_confirmed_cases"] is True
