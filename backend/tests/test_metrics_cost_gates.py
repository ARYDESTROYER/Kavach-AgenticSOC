"""Round 14 roles-04 and roles-11: one rule for store-wide metrics and for AI spend.

* ``GET /api/metrics`` needs ``metrics:view``, like every other metrics read
  (posture, trends, noise reduction, the breakdown), so a role without it is refused
  rather than shown store-wide figures beside refused panels.
* ``GET /api/usage/summary`` needs ``cost:view``: AI spend is gated the same way on
  the Cost page as on the Executive board, the usage breakdown and chat.
* ``GET /api/metrics`` carries a ``cost`` part (AI spend over the window): without
  ``cost:view`` it is ``{}``, the shape the payload already uses when spend cannot be
  read, so a metrics viewer never reads spend through the back door.
* The no-auth profile is unchanged.

Offline: fake Elasticsearch, mock LLM, the real dependency chain.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import UsageDoc
from app.state import AppState

T1 = UserRole.ANALYST_TIER1.value


def _client(*, auth: bool = True, denies: dict[str, list[str]] | None = None) -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=auth, auth_jwt_secret="metrics-cost-gates-secret",
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
            "enabled": True, "denies": {T1: denies or {}},
        })})
        await state.update_prefs(prefs)
        await state.usage_store.write_strict(UsageDoc(
            surface="investigation", role="investigator", model="mock-1",
            prompt_tokens=1200, completion_tokens=300, total_tokens=1500, cost=0.0213,
        ))
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)] if auth else [])
    return TestClient(api)


def _login(client: TestClient, username: str, password: str) -> None:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _as_tier1(client: TestClient) -> None:
    _login(client, "Admin", "Admin@123")
    created = client.post("/api/users", json={"username": "tier1", "password": "tier1-pass-1234", "role": T1})
    assert created.status_code == 200, created.text
    client.cookies.clear()
    _login(client, "tier1", "tier1-pass-1234")


def test_metrics_need_metrics_view():
    with _client(denies={"metrics": ["view"]}) as client:
        assert client.get("/api/metrics").status_code == 401
        _as_tier1(client)
        refused = client.get("/api/metrics", params={"window_hours": 24})
        assert refused.status_code == 403
        assert refused.json()["detail"] == "permission denied: metrics:view"
        # The feedback agreement figures are a metrics read too.
        assert client.get("/api/feedback/stats").status_code == 403
        # Spend is a separate grant the role still holds.
        assert client.get("/api/usage/summary", params={"window_hours": 24}).status_code == 200


def test_usage_summary_needs_cost_view_and_metrics_leave_spend_out():
    with _client(denies={"cost": ["view"]}) as client:
        assert client.get("/api/usage/summary").status_code == 401
        _as_tier1(client)
        refused = client.get("/api/usage/summary", params={"window_hours": 24})
        assert refused.status_code == 403
        assert refused.json()["detail"] == "permission denied: cost:view"
        # A single case's spend is spend too.
        assert client.get("/api/usage/summary", params={"case_id": "case-1"}).status_code == 403
        metrics = client.get("/api/metrics", params={"window_hours": 24})
        assert metrics.status_code == 200, metrics.text
        assert metrics.json()["cost"] == {}
        assert "total_cases" in metrics.json()


def test_a_role_with_both_grants_reads_both():
    with _client() as client:
        _as_tier1(client)
        assert client.get("/api/feedback/stats").status_code == 200
        usage = client.get("/api/usage/summary", params={"window_hours": 24})
        assert usage.status_code == 200, usage.text
        assert usage.json()["total_cost"] > 0
        metrics = client.get("/api/metrics", params={"window_hours": 24})
        assert metrics.status_code == 200
        assert metrics.json()["cost"]["total_cost"] == usage.json()["total_cost"]


def test_the_no_auth_profile_is_unchanged():
    with _client(auth=False) as client:
        assert client.get("/api/usage/summary").status_code == 200
        body = client.get("/api/metrics").json()
        assert body["cost"]["total_cost"] > 0
