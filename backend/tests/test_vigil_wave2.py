"""Wave-2 integration tests: runbook selection/injection into the investigator (with
the safety guarantees) and the optional auth gate. All offline (fake ES + mock LLM).

Round 14 (SPEC §4.10.9) replaced the Markdown playbook block with the TRUSTED active
runbook: the deterministic matcher picks one Published runbook (a built-in here) per
cluster and its investigator rendering enters the ``<<<RUNBOOK>>>`` block. These
tests pin that contract through the real pipeline; the pure selection rules are in
``test_playbook_selection.py`` and ``test_runbook_prompt.py``."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.agents.pipeline import builtin_runbook_catalog
from app.agents.prompts import RUNBOOK_CLOSE, RUNBOOK_HEADING, RUNBOOK_OPEN
from app.api.deps import require_auth
from app.api.routes import router
from app.config import Secrets
from app.constants import UNTRUSTED_OPEN, EntityType, SourceSurface
from app.engine.correlation import cluster_from_events
from app.engine.runbook_model import BUILTIN_RUNBOOK_IDS
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


def _script(mock_provider) -> None:
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", _final())


def _investigator_messages(mock_provider) -> tuple[str, str]:
    inv_calls = [c for c in mock_provider.calls if c["role"] == "investigator"]
    return inv_calls[0]["messages"][0]["content"], inv_calls[0]["messages"][1]["content"]


async def _set_runbooks(app_state: AppState, **changes) -> None:
    p = app_state.prefs.model_copy(deep=True)
    p.runbooks = p.runbooks.model_copy(update=changes)
    await app_state.update_prefs(p)


# --------------------------------------------------------------------------- #
# Runbook selection + injection through the real pipeline
# --------------------------------------------------------------------------- #
async def test_matching_runbook_selected_and_injected(app_state: AppState, mock_provider) -> None:
    _script(mock_provider)
    # 'mail_auth' is one of the brute force built-in's rules (it merged the retired
    # brute_force_login playbook), so that built-in is chosen on its rules (tier 3).
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert case.runbook_id == "brute-force-password-spray"
    assert case.runbook_version == 1
    assert case.playbook_id == ""  # never written by new code

    system, user_msg = _investigator_messages(mock_provider)
    # The delimited TRUSTED runbook block is present and the precedence line is set.
    assert RUNBOOK_HEADING in user_msg
    assert RUNBOOK_OPEN in user_msg and RUNBOOK_CLOSE in user_msg
    assert "<<<PLAYBOOK>>>" not in user_msg
    assert "PRECEDENCE" in system and RUNBOOK_OPEN in system

    # Fence integrity: the runbook block must NOT contain the UNTRUSTED markers; the
    # cluster's sample events ARE fenced (so the markers appear elsewhere).
    block = user_msg.split(RUNBOOK_OPEN)[1].split(RUNBOOK_CLOSE)[0]
    assert block.strip().startswith("Brute force and password spray (v1)")
    assert UNTRUSTED_OPEN not in block
    assert UNTRUSTED_OPEN in user_msg  # sample events still fenced


async def test_runbook_selection_audited(app_state: AppState, mock_provider) -> None:
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    records = await app_state.audit.records_for_case(case.case_id)
    selectors = [
        r for r in records
        if r.get("actor") == "runbook_selector" and r.get("action_type") == "decision"
    ]
    assert len(selectors) == 1, "runbook selection must be audited once per investigation"
    row = selectors[0]
    assert row.get("action") == "runbook.selected"
    assert "brute-force-password-spray" in row.get("result_summary", "")
    selection = row["tool_input"]["runbook_selection"]
    assert selection["id"] == "brute-force-password-spray" and selection["version"] == 1
    assert selection["used"] is True and selection["tier"] == 3
    assert selection["explanation"]["matched"][0] == {"criterion": "rule_ids", "value": ["mail_auth"]}
    assert selection["reason"].startswith("Matched rule mail_auth")
    # No retired actor is written by new code.
    assert not [r for r in records if r.get("actor") == "playbook_selector"]


async def test_unmatched_cluster_gets_the_fallback(app_state: AppState, mock_provider) -> None:
    _script(mock_provider)
    # 'mail_fim' is in the rule catalog but no built-in lists it, so the Generic
    # incident runbook is the guidance (D33, fallback on by default).
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_fim", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert case.runbook_id == "generic-incident"
    _system, user_msg = _investigator_messages(mock_provider)
    assert RUNBOOK_OPEN in user_msg
    block = user_msg.split(RUNBOOK_OPEN)[1].split(RUNBOOK_CLOSE)[0]
    assert "Generic incident" in block


async def test_unmatched_cluster_without_fallback_gets_no_runbook(app_state: AppState, mock_provider) -> None:
    await _set_runbooks(app_state, fallback=False)
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_fim", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    assert case.runbook_id is None and case.runbook_version is None
    _system, user_msg = _investigator_messages(mock_provider)
    assert RUNBOOK_OPEN not in user_msg


@pytest.mark.parametrize("setting", ["investigator_guidance", "enabled"])
async def test_guidance_off_uses_no_runbook(app_state: AppState, mock_provider, setting) -> None:
    await _set_runbooks(app_state, **{setting: False})
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth", n=6), SourceSurface.INVESTIGATE, app_state.prefs
    )
    # Switched off: no runbook, even for a matching cluster.
    assert case.runbook_id is None
    _system, user_msg = _investigator_messages(mock_provider)
    assert RUNBOOK_OPEN not in user_msg


def test_runbook_cannot_grant_tools_outside_registry(app_state: AppState) -> None:
    # The pipeline's tool registry is fixed regardless of any runbook: a runbook's
    # lookups run in the run engine, never as investigator tools, so a runbook can
    # never add a tool.
    investigator, _enrich = app_state.pipeline._build_investigator(app_state.prefs)
    assert set(investigator._tools.names()) == {"es_query", "enrich", "rag_retrieve"}


def test_default_catalog_is_the_bundled_library() -> None:
    # A pipeline built without a catalog provider guides from the 12 built-ins.
    catalog = builtin_runbook_catalog()
    assert {entry.id for entry in catalog} == set(BUILTIN_RUNBOOK_IDS)
    assert all(entry.origin == "builtin" for entry in catalog)


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
