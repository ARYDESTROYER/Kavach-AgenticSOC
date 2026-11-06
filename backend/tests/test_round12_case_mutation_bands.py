"""Round 12 final review (L4): every single-case MUTATION returns the same shape as
``GET /api/cases/{id}``, read-time advisory bands included.

The Case Manager header renders the case a lifecycle action returns. Those responses
used to be the stored case without the read-time bands (``severity_band: null``), so
the header fell back to a risk-score band and a source-asserted Critical case read as
Info after Acknowledge, Hold or Close until a reload. Each mutation now returns
``_case_view`` (the stored case plus ``_with_advisory_bands`` under
``execution_prefs``), the exact projection ``GET /cases/{id}`` returns.

Offline: fake Elasticsearch and the mock LLM. ``decide()`` is never reached (#3): the
bands are display-only and never stored (asserted below).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import PriorityMatrix, Secrets, SourceInstance
from app.constants import CaseStatus, EntityType, SourceSurface, SourceType, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, TriggerReason
from app.state import AppState

DECLARED_SOURCE_ID = "src-0-10"
BAND_FIELDS = ("severity_band", "severity_source", "impact_band", "urgency_band", "priority_level")


def _declared_source() -> SourceInstance:
    return SourceInstance(
        id=DECLARED_SOURCE_ID,
        source_type=SourceType.ELASTICSEARCH,
        display_name="declared native ladder",
        severity_scale_max=10.0,
    )


def _critical_low_risk_case(case_id: str) -> Case:
    """A source-asserted CRITICAL (9 on a declared 0-10 ladder) whose deterministic risk
    total is low (7.41): the risk-score ladder alone would read it as Info."""
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.50"),
        risk_score=7.41,
        verdict=Verdict.NEEDS_HUMAN,
        confidence=0.75,
        status=CaseStatus.ESCALATED,
        source_id=DECLARED_SOURCE_ID,
        trigger_reason=TriggerReason(rule_value="r", severity_max=9.0),
    )


@pytest.fixture
def client():
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
        await state.update_prefs(state.prefs.model_copy(update={
            "setup_complete": True,
            "asset_criticality": {"203.0.113.50": 90.0},
            "priority_matrix": PriorityMatrix(enabled=True),
            "sources": [_declared_source()],
        }))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from app.api.routes import router as monolith_router

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    with TestClient(api) as test_client:
        yield test_client


def _seed(client: TestClient, case: Case) -> None:
    client.portal.call(client.app.state.tlsoc.cases.save, case)


def _bands(body: dict[str, Any]) -> dict[str, Any]:
    return {field: body.get(field) for field in BAND_FIELDS}


def _get_bands(client: TestClient, case_id: str) -> dict[str, Any]:
    res = client.get(f"/api/cases/{case_id}")
    assert res.status_code == 200, res.text
    return _bands(res.json())


def test_the_fixture_case_is_critical_on_get_and_info_by_risk_alone(client) -> None:
    """Guards the fixture itself: GET says critical, and the risk total alone would not."""
    _seed(client, _critical_low_risk_case("case-fixture"))
    bands = _get_bands(client, "case-fixture")
    assert bands["severity_band"] == "critical"
    assert bands["severity_source"] == "source_asserted"
    assert bands["priority_level"] is not None


@pytest.mark.parametrize(
    "payload",
    [
        {"action": "acknowledge"},
        {"action": "hold", "reason": "waiting on the asset owner"},
        {"action": "resume"},
        {"action": "escalate"},
        {"action": "deescalate"},
        {"action": "set_disposition", "disposition": "false_positive", "disposition_declared": True},
        {"action": "confirm_fp"},
        {"action": "close", "disposition": "false_positive", "disposition_declared": True},
        {"action": "resolve", "disposition": "true_positive", "disposition_declared": True},
        {"action": "close", "disposition": "false_positive"},
    ],
    ids=lambda p: p["action"] + ("+declared" if p.get("disposition_declared") else ""),
)
def test_a_lifecycle_action_returns_the_get_bands(client, payload: dict[str, Any]) -> None:
    case_id = f"case-{payload['action']}"
    _seed(client, _critical_low_risk_case(case_id))
    res = client.post(f"/api/cases/{case_id}/action", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["severity_band"] == "critical", body.get("severity_band")
    assert _bands(body) == _get_bands(client, case_id)


def test_reopen_after_close_returns_the_get_bands(client) -> None:
    _seed(client, _critical_low_risk_case("case-reopen"))
    closed = client.post(
        "/api/cases/case-reopen/action",
        json={"action": "close", "disposition": "false_positive", "disposition_declared": True},
    )
    assert closed.status_code == 200, closed.text
    reopened = client.post("/api/cases/case-reopen/action", json={"action": "reopen"})
    assert reopened.status_code == 200, reopened.text
    assert _bands(reopened.json()) == _get_bands(client, "case-reopen")
    assert reopened.json()["severity_band"] == "critical"


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("tags", {"tags": ["phishing", "vip"]}),
        ("assign", {"assignee": "alice"}),
        ("comment", {"author": "alice", "body": "Looked at the sign-in logs."}),
        ("feedback", {"assessment": "agree", "accuracy": 0.9, "actual_outcome": "true_positive"}),
    ],
)
def test_a_collaboration_edit_returns_the_get_bands(client, path: str, payload: dict[str, Any]) -> None:
    case_id = f"case-{path}"
    _seed(client, _critical_low_risk_case(case_id))
    res = client.post(f"/api/cases/{case_id}/{path}", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["severity_band"] == "critical"
    assert _bands(body) == _get_bands(client, case_id)


def test_a_reinvestigation_returns_bands_for_the_updated_case(client, monkeypatch) -> None:
    """Investigate and reinvestigate return the case the pipeline produced, banded like
    GET (bands recomputed from the new case, not copied from the old one).

    The retired ``run-playbook`` route (Round 14 SPEC §4.10.16) answers ``410
    runbooks_moved`` and leaves the case exactly as it was: no pipeline run, no band."""
    import app.api.routes as routes_mod

    state = client.app.state.tlsoc
    for cid in ("case-inv", "case-reinv", "case-pb"):
        _seed(client, _critical_low_risk_case(cid))

    async def _cluster(_state, case, **_kw):  # noqa: ANN001, ANN202
        return object()

    monkeypatch.setattr(routes_mod, "_cluster_for_case", _cluster)

    current: dict[str, str] = {}
    pipeline_runs: list[str] = []

    async def _pipeline(_cluster_arg, _surface, _prefs, **_kw):  # noqa: ANN001, ANN202
        pipeline_runs.append(current["id"])
        case = await state.cases.get(current["id"])
        # The re-run changed the evidence: the source now asserts 3/10 (medium).
        case.trigger_reason = TriggerReason(rule_value="r", severity_max=3.0)
        await state.cases.save(case)
        return case

    monkeypatch.setattr(state.pipeline, "investigate_cluster", _pipeline)

    for cid, path, payload in (
        ("case-inv", "investigate", None),
        ("case-reinv", "reinvestigate", {}),
    ):
        current["id"] = cid
        res = client.post(f"/api/cases/{cid}/{path}", json=payload)
        assert res.status_code == 200, (path, res.text)
        body = res.json()
        assert body["severity_band"] == "medium", (path, body.get("severity_band"))
        assert _bands(body) == _get_bands(client, cid), path
    assert pipeline_runs == ["case-inv", "case-reinv"]

    current["id"] = "case-pb"
    before = client.portal.call(state.cases.get, "case-pb").model_dump(mode="json")
    res = client.post("/api/cases/case-pb/run-playbook", json={"playbook_id": "any"})
    assert res.status_code == 410, res.text
    assert res.json()["code"] == "runbooks_moved"
    assert pipeline_runs == ["case-inv", "case-reinv"]
    after = client.portal.call(state.cases.get, "case-pb").model_dump(mode="json")
    assert after == before
    assert _get_bands(client, "case-pb")["severity_band"] == "critical"


def test_the_bands_are_never_stored(client) -> None:
    """Display only (#3): the response carries the bands, the stored case does not."""
    _seed(client, _critical_low_risk_case("case-clean"))
    res = client.post("/api/cases/case-clean/action", json={"action": "acknowledge"})
    assert res.json()["severity_band"] == "critical"
    stored = client.portal.call(client.app.state.tlsoc.cases.get, "case-clean")
    assert stored.severity_band is None
    assert stored.priority_level is None


def test_a_band_failure_still_returns_the_case(client, monkeypatch) -> None:
    """Fail-open like GET: a derivation error never fails the action itself."""
    import app.api.routes as routes_mod

    def _boom(_case, _prefs):  # noqa: ANN001, ANN202
        raise RuntimeError("boom")

    _seed(client, _critical_low_risk_case("case-boom"))
    monkeypatch.setattr(routes_mod, "advisory_bands", _boom)
    res = client.post("/api/cases/case-boom/action", json={"action": "acknowledge"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == CaseStatus.INVESTIGATING.value
    assert res.json()["severity_band"] is None
