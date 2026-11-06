"""Round 14 roles-11: AI spend follows one rule, ``cost:view``, on every route that
shows it beside other figures.

* ``GET /api/budget/status`` (``models:read``) keeps the caps and settings, but each
  window's ``spent``, ``fraction`` and ``band`` and ``excluded_today`` are ``null``
  without ``cost:view``, the rule chat's budget fields already follow.
* ``GET /api/cases/{id}/timeline`` (``cases:read``) keeps its steps, but without
  ``cost:view`` it does not read the usage ledger: every span's ``cost`` and
  ``tokens`` and both ``totals`` are ``null``.
* ``GET /api/metrics/agent-improvement`` (``metrics:view``) keeps its evidence, but
  without ``cost:view`` every ``recorded_case_cost`` block (the headline and each
  period comparison's) is ``unavailable`` with zero figures and says the grant is
  required.
* ``GET /api/cases``, ``GET /api/cases/{id}``, the case JSON export and every
  single-case response (an action, tags, a comment, an assignment) keep the case, but
  its own AI spend, ``token_cost``, is ``null`` without ``cost:view``.
* A role holding ``cost:view``, and the no-auth profile, read every figure as before.

Offline: fake Elasticsearch, mock LLM, the real dependency chain.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_metrics import COST_VIEW_REQUIRED_REASON
from app.api.routes_metrics import router as metrics_router
from app.api.routes_models import router as models_router
from app.api.routes_triage import router as triage_router
from app.config import Secrets
from app.constants import ActionType, CaseStatus, EntityType, SourceSurface, UserRole, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import AuditDoc, Case, Entity, UsageDoc
from app.state import AppState

T1 = UserRole.ANALYST_TIER1.value
SOC_MANAGER = UserRole.SOC_MANAGER.value
CASE_ID = "case-spend-1"
COST = 0.0213


def _client(*, auth: bool = True, role: str = T1, denies: dict[str, list[str]] | None = None) -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=auth, auth_jwt_secret="spend-gates-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={
            "enabled": True, "denies": {role: denies or {}},
        })})
        await state.update_prefs(prefs)
        await state.cases.save(Case(
            case_id=CASE_ID, cluster_signature=f"sig:{CASE_ID}", case_number="CASE-0007",
            source_surface=SourceSurface.INVESTIGATE,
            entity=Entity(type=EntityType.IP, value="203.0.113.9"),
            verdict=Verdict.TRUE_POSITIVE, confidence=0.9, status=CaseStatus.NEEDS_HUMAN,
            token_cost=COST,
        ))
        two_days_ago = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        await state.usage_store.write_strict(UsageDoc(
            ts=two_days_ago, surface="investigation", role="investigator", model="mock-1",
            case_id=CASE_ID, prompt_tokens=1200, completion_tokens=300, total_tokens=1500, cost=COST,
        ))
        await state.usage_store.write_strict(UsageDoc(
            surface="investigation", role="investigator", model="mock-1",
            prompt_tokens=10, completion_tokens=5, total_tokens=15, cost=0.0101,
        ))
        await state.audit.write(AuditDoc(
            case_id=CASE_ID, actor="investigator", action_type=ActionType.PROMPT, prompt_excerpt="p",
        ))
        await state.audit.write(AuditDoc(
            case_id=CASE_ID, actor="investigator", action_type=ActionType.VERDICT,
            result_summary="verdict=TRUE_POSITIVE",
        ))
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (monolith_router, metrics_router, models_router, triage_router):
        api.include_router(router, dependencies=[Depends(require_auth)] if auth else [])
    return TestClient(api)


def _sign_in_as(client: TestClient, role: str) -> None:
    def login(username: str, password: str) -> None:
        response = client.post("/api/auth/login", json={"username": username, "password": password})
        assert response.status_code == 200, response.text

    login("Admin", "Admin@123")
    created = client.post("/api/users", json={"username": "viewer", "password": "viewer-pass-1234", "role": role})
    assert created.status_code == 200, created.text
    client.cookies.clear()
    login("viewer", "viewer-pass-1234")


def _cost_blocks(report: dict[str, Any]) -> list[dict[str, Any]]:
    blocks = [report["outcomes"]["recorded_case_cost"]]
    blocks += [comparison["outcomes"]["recorded_case_cost"]
               for comparison in report["period_comparisons"].values()]
    assert len(blocks) == 3
    return blocks


# --------------------------------------------------------------------------- #
# GET /api/budget/status
# --------------------------------------------------------------------------- #
def test_budget_status_keeps_the_caps_and_withholds_the_spend_without_cost_view():
    with _client(role=SOC_MANAGER, denies={"cost": ["view"]}) as client:
        _sign_in_as(client, SOC_MANAGER)
        status = client.get("/api/budget/status")
        assert status.status_code == 200, status.text
        body = status.json()
        for window in ("daily", "monthly"):
            assert body[window]["spent"] is None
            assert body[window]["fraction"] is None
            assert body[window]["band"] is None
        assert body["daily"]["cap"] == 10.0
        assert body["excluded_today"] is None
        assert body["enabled"] is True and body["on_exceed"] == "block"


def test_budget_status_shows_the_spend_with_cost_view():
    with _client(role=SOC_MANAGER) as client:
        _sign_in_as(client, SOC_MANAGER)
        body = client.get("/api/budget/status").json()
        assert body["monthly"]["spent"] > 0
        assert body["daily"]["band"] == "ok"
        assert body["excluded_today"] == 0.0


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/timeline
# --------------------------------------------------------------------------- #
def test_the_case_timeline_leaves_cost_and_tokens_out_without_cost_view():
    with _client(denies={"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        timeline = client.get(f"/api/cases/{CASE_ID}/timeline")
        assert timeline.status_code == 200, timeline.text
        body = timeline.json()
        assert body["totals"] == {"cost": None, "tokens": None}
        llm_spans = [span for span in body["spans"] if span["name"] == "investigator"]
        assert len(llm_spans) == 2
        assert all(span["cost"] is None and span["tokens"] is None for span in llm_spans)


def test_the_case_timeline_shows_cost_and_tokens_with_cost_view():
    with _client() as client:
        _sign_in_as(client, T1)
        body = client.get(f"/api/cases/{CASE_ID}/timeline").json()
        assert abs(body["totals"]["cost"] - COST) < 1e-6
        assert body["totals"]["tokens"] == 1500


# --------------------------------------------------------------------------- #
# The case reads and single-case responses: ``Case.token_cost``
# --------------------------------------------------------------------------- #
def _case_spend_reads(client: TestClient) -> dict[str, Any]:
    """Every route that hands the Console a whole case, read back as the caller."""
    import json

    reads: dict[str, Any] = {}
    detail = client.get(f"/api/cases/{CASE_ID}")
    assert detail.status_code == 200, detail.text
    reads["detail"] = detail.json()
    for name, params in (("list", {}), ("list_sorted", {"sort_field": "created_at"})):
        listed = client.get("/api/cases", params=params)
        assert listed.status_code == 200, listed.text
        rows = [row for row in listed.json()["cases"] if row["case_id"] == CASE_ID]
        assert len(rows) == 1
        reads[name] = rows[0]
    exported = client.get(f"/api/cases/{CASE_ID}/export", params={"format": "json"})
    assert exported.status_code == 200, exported.text
    reads["export"] = json.loads(exported.json()["content"])
    tags = client.post(f"/api/cases/{CASE_ID}/tags", json={"tags": ["spend-probe"]})
    assert tags.status_code == 200, tags.text
    reads["tags"] = tags.json()
    comment = client.post(f"/api/cases/{CASE_ID}/comment", json={"body": "probe"})
    assert comment.status_code == 200, comment.text
    reads["comment"] = comment.json()
    assign = client.post(f"/api/cases/{CASE_ID}/assign", json={"assignee": "viewer"})
    assert assign.status_code == 200, assign.text
    reads["assign"] = assign.json()
    action = client.post(f"/api/cases/{CASE_ID}/action", json={"action": "acknowledge"})
    assert action.status_code == 200, action.text
    reads["action"] = action.json()
    return reads


def test_case_reads_leave_token_cost_out_without_cost_view():
    with _client(denies={"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        reads = _case_spend_reads(client)
        for name, case in reads.items():
            assert "token_cost" in case, name
            assert case["token_cost"] is None, name
            # Only the figure is withheld: the case itself is answered whole.
            assert case["case_id"] == CASE_ID, name
            assert case["verdict"] == "TRUE_POSITIVE", name


def test_case_reads_show_token_cost_with_cost_view():
    with _client() as client:
        _sign_in_as(client, T1)
        for name, case in _case_spend_reads(client).items():
            assert abs(case["token_cost"] - COST) < 1e-9, name


def test_the_stored_case_cost_is_unchanged_when_a_read_withholds_it():
    """Withholding is a view: the stored number survives a write made by a caller who
    cannot see it (tags, comment, assignment and an action all save the case)."""
    with _client(denies={"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        _case_spend_reads(client)
        state = client.app.state.tlsoc
        stored = client.portal.call(state.cases.get, CASE_ID)
        assert abs(stored.token_cost - COST) < 1e-9


# --------------------------------------------------------------------------- #
# GET /api/metrics/agent-improvement
# --------------------------------------------------------------------------- #
def test_agent_improvement_withholds_recorded_case_cost_without_cost_view():
    with _client(denies={"cost": ["view"]}) as client:
        _sign_in_as(client, T1)
        report = client.get("/api/metrics/agent-improvement")
        assert report.status_code == 200, report.text
        for block in _cost_blocks(report.json()):
            assert block["status"] == "unavailable"
            assert block["reason"] == COST_VIEW_REQUIRED_REASON
            for period in ("current", "baseline"):
                assert block[period]["total_cost"] == 0.0
                assert block[period]["call_count"] == 0
                assert block[period]["cost_per_costed_case"] is None


def test_agent_improvement_shows_recorded_case_cost_with_cost_view():
    with _client() as client:
        _sign_in_as(client, T1)
        report = client.get("/api/metrics/agent-improvement").json()
        current = report["outcomes"]["recorded_case_cost"]["current"]
        assert abs(current["total_cost"] - COST) < 1e-6
        assert current["costed_cases"] == 1
        assert all(block["reason"] != COST_VIEW_REQUIRED_REASON for block in _cost_blocks(report))


# --------------------------------------------------------------------------- #
# The no-auth profile
# --------------------------------------------------------------------------- #
def test_the_no_auth_profile_reads_every_spend_figure():
    with _client(auth=False) as client:
        assert client.get("/api/budget/status").json()["monthly"]["spent"] > 0
        assert client.get(f"/api/cases/{CASE_ID}/timeline").json()["totals"]["tokens"] == 1500
        assert abs(client.get(f"/api/cases/{CASE_ID}").json()["token_cost"] - COST) < 1e-9
        report = client.get("/api/metrics/agent-improvement").json()
        assert report["outcomes"]["recorded_case_cost"]["current"]["costed_cases"] == 1
