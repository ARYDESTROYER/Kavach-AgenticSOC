"""Wave-2 integration tests: Markdown playbook selection/injection (with the
safety guarantees) and the optional auth gate. All offline (fake ES + mock LLM)."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.config import Secrets
from app.constants import UNTRUSTED_OPEN, EntityType, SourceSurface
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from tests.conftest import make_raw_event


def _cluster(rule: str, n: int = 6, ip: str = "1.2.3.4"):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def _final(verdict: str = "NEEDS_HUMAN", confidence: float = 0.2) -> str:
    return json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {"verdict": verdict, "confidence": confidence, "evidence": [],
                    "mitre": [], "recommended_action": "review", "reproduce_query": ""},
    })


# --------------------------------------------------------------------------- #
# Playbook selection + injection through the real pipeline
# --------------------------------------------------------------------------- #
async def test_matching_playbook_selected_and_injected(app_state: AppState, mock_provider) -> None:
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final())
    # 'mail_auth' (>=5 events) matches the brute_force_login seed playbook.
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert case.playbook_id == "brute_force_login"

    inv_calls = [c for c in mock_provider.calls if c["role"] == "investigator"]
    system = inv_calls[0]["messages"][0]["content"]
    user_msg = inv_calls[0]["messages"][1]["content"]
    # The delimited TRUSTED playbook block is present and the precedence line is set.
    assert "<<<PLAYBOOK>>>" in user_msg and "<<<END_PLAYBOOK>>>" in user_msg
    assert "PRECEDENCE" in system

    # Fence integrity: the playbook block must NOT contain the UNTRUSTED markers;
    # the cluster's sample events ARE fenced (so the markers appear elsewhere).
    block = user_msg.split("<<<PLAYBOOK>>>")[1].split("<<<END_PLAYBOOK>>>")[0]
    assert UNTRUSTED_OPEN not in block
    assert UNTRUSTED_OPEN in user_msg  # sample events still fenced


async def test_playbook_selection_audited(app_state: AppState, mock_provider) -> None:
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    records = await app_state.audit.records_for_case(case.case_id)
    selectors = [
        r for r in records
        if (r.get("actor") if isinstance(r, dict) else getattr(r, "actor", "")) == "playbook_selector"
    ]
    assert selectors, "playbook selection must be audited"
    summary = selectors[0].get("result_summary") if isinstance(selectors[0], dict) else selectors[0].result_summary
    assert "brute_force_login" in summary


async def test_unmatched_cluster_uses_generic(app_state: AppState, mock_provider) -> None:
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final())
    # 'mail_fim' is in the rule catalog but matches no seed playbook.
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_fim", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert case.playbook_id == ""
    inv_calls = [c for c in mock_provider.calls if c["role"] == "investigator"]
    assert "<<<PLAYBOOK>>>" not in inv_calls[0]["messages"][1]["content"]


async def test_playbooks_disabled_uses_generic(app_state: AppState, mock_provider) -> None:
    p = app_state.prefs.model_copy(deep=True)
    p.playbooks.enabled = False
    await app_state.update_prefs(p)
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert case.playbook_id == ""  # flag off → generic, even for a matching cluster


def test_playbook_cannot_grant_tools_outside_registry(app_state: AppState) -> None:
    # The pipeline's tool registry is fixed regardless of any playbook's
    # suggested_tools (advisory only) — a playbook can never add a tool.
    investigator, _enrich = app_state.pipeline._build_investigator(app_state.prefs)
    assert set(investigator._tools.names()) == {"es_query", "enrich", "rag_retrieve", "decode_acl"}


def test_hot_reload_loads_seed_playbooks(app_state: AppState) -> None:
    summary = app_state.reload_playbooks()
    assert summary["loaded"] >= 3
    assert "brute_force_login" in summary["ids"]


# --------------------------------------------------------------------------- #
# Auth gate — disabled (default) vs enabled
# --------------------------------------------------------------------------- #
def test_auth_disabled_is_open(client) -> None:
    # Default conftest client: auth off → endpoints open; /auth/me reports disabled.
    assert client.get("/api/cases").status_code == 200
    me = client.get("/api/auth/me").json()
    assert me["auth_enabled"] is False and me["authenticated"] is True


def _auth_client():
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="test-secret-xyz",
        auth_admin_username="admin", auth_admin_password="s3cret-pw",
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])  # mirror main.py
    return TestClient(api)


def test_auth_enabled_requires_login_then_allows() -> None:
    with _auth_client() as c:
        # Public endpoints work without a session.
        assert c.get("/api/health").status_code == 200
        me = c.get("/api/auth/me").json()
        assert me["auth_enabled"] is True and me["authenticated"] is False
        # A protected endpoint is 401 without a token.
        assert c.get("/api/cases").status_code == 401
        # Bad credentials → 401.
        assert c.post("/api/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401
        # Good credentials → 200 + cookie (TestClient persists it).
        r = c.post("/api/auth/login", json={"username": "admin", "password": "s3cret-pw"})
        assert r.status_code == 200 and r.json()["token"]
        # Now the protected endpoint is reachable.
        assert c.get("/api/cases").status_code == 200
        assert c.get("/api/auth/me").json()["authenticated"] is True
        # Logout clears the session.
        c.post("/api/auth/logout")
        assert c.get("/api/cases").status_code == 401


def test_auth_enabled_accepts_bearer_token() -> None:
    with _auth_client() as c:
        r = c.post("/api/auth/login", json={"username": "admin", "password": "s3cret-pw"})
        token = r.cookies.get("tlsoc_token")
        assert token
        c.cookies.clear()  # drop the cookie; use the Authorization header instead
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {token}"}).status_code == 200


@pytest.mark.parametrize("path", ["/api/playbooks", "/api/personas"])
def test_catalog_endpoints(client, path) -> None:
    r = client.get(path)
    assert r.status_code == 200
