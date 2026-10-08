"""``GET /api/chat/context``, ``GET /api/chat/topics/{id}`` and the tool-context
builder (chat revamp SPEC §8, §10.5, §10.7, §5.1, §2).

Covers the meter's shape, RBAC on money fields (a ``cases:read``-only principal
sees tokens and the budget state, never rates or spend), zero audit writes while
resolving a restricted caller's grants, the per-principal cache, history and
calibration estimates, Demo and production starters (never literal indicators), the
topic templates, and ``AppState.build_chat_tool_context`` with its Demo overlays.
"""

from __future__ import annotations

import asyncio
import re
import sys
import types
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator

import pytest
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_chat import chat_context, run_chat_turn
from app.api.routes_chat import router as chat_router
from app.config import Secrets
from app.constants import EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, ChatRequest, ChatStarter, Entity
from app.state import AppState, ChatSourceUnavailable, chat_grant_pairs

STARTER_IDS = ["investigate", "hunt", "posture", "shift_brief", "explain_metric", "learn_app"]
# Literal indicators a starter must never carry (§10.5): addresses, hashes, mail, URLs.
IOC_PATTERNS = [
    re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"),
    re.compile(r"\b[a-fA-F0-9]{32,64}\b"),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),
    re.compile(r"https?://"),
    re.compile(r"\b[a-z0-9-]+\.(?:com|net|org|io|ru|cn|example)\b", re.I),
]


def _secrets(**over: Any) -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, **over,
    )


@contextmanager
def _client(provider: MockProvider | None = None, **secret_over: Any) -> Iterator[TestClient]:
    provider = provider or MockProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=_secrets(**secret_over), es=InMemoryESClient(),
                                provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if secret_over.get("auth_enabled") else []
    api.include_router(base_router, dependencies=deps)
    api.include_router(chat_router, dependencies=deps)
    with TestClient(api) as client:
        yield client


def _request(state: AppState) -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    return Request({
        "type": "http", "method": "GET", "path": "/api/chat/context", "headers": [],
        "query_string": b"", "app": app, "client": ("127.0.0.1", 9),
    })


async def _context(state: AppState, **params: Any):
    return await chat_context(
        _request(state), conversation_id=params.get("conversation_id"),
        model=params.get("model"), case_id=params.get("case_id"), state=state, _=None,
    )


def _grant(state: AppState, monkeypatch: pytest.MonkeyPatch, *pairs: tuple[str, str]) -> None:
    async def _fixed(_request: Any) -> frozenset[tuple[str, str]]:
        return frozenset(pairs)

    monkeypatch.setattr(state, "chat_grants", _fixed)


async def _seed_case(state: AppState, case_id: str = "case-0042") -> None:
    await state.cases.save(Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"), confidence=0.5, risk_score=42.0,
    ))


# --------------------------------------------------------------------------- #
# Shape, starters and topics.
# --------------------------------------------------------------------------- #
def test_context_shape_tools_bounds_and_production_starters() -> None:
    with _client() as client:
        state = client.app.state.tlsoc
        response = client.get("/api/chat/context")
        assert response.status_code == 200
        body = response.json()
        assert body["model"] == state.prefs.chat_model.model
        assert body["chars_per_token"] == 4 and body["static_prompt_tokens"] > 500
        assert body["max_output_tokens"] >= state.prefs.chat_agent.final_max_tokens
        assert body["bounds"]["max_model_calls"] == state.prefs.chat_agent.max_model_calls
        assert "internal_domains" not in body["bounds"]
        names = [t["name"] for t in body["tools"]]
        assert {"search_logs", "soc_metrics", "app_help"} <= set(names)
        assert all(t["allowed"] for t in body["tools"])           # auth off: everything granted
        assert body["text_streaming"] == {"available": False, "reason": "model_does_not_stream"}
        assert body["budget_state"] == "ok"
        assert body["rates"]["input_per_million"] > 0 and body["simulated"] is False
        assert body["budget"]["enabled"] is True and body["spent_today"] == 0
        assert body["history_tokens"] == 0 and body["calibration"] is None
        starters = body["starters"]
        assert [s["id"] for s in starters] == STARTER_IDS
        assert starters[0]["tools"] == ["search_cases"]           # no open case yet
        for starter in starters:
            ChatStarter.model_validate(starter)
            assert not any(p.search(starter["prompt"]) for p in IOC_PATTERNS), starter
        assert "last 24h" in starters[1]["prompt"] and "all connected sources" in starters[1]["prompt"]


def test_production_starters_name_the_newest_open_case() -> None:
    with _client() as client:
        state = client.app.state.tlsoc
        client.portal.call(_seed_case, state, "case-0042")
        starters = client.get("/api/chat/context").json()["starters"]
        assert starters[0]["tools"] == ["get_case", "explain_decision"]
        assert "case-0042" in starters[0]["prompt"]
        assert not any(p.search(starters[0]["prompt"]) for p in IOC_PATTERNS)


def test_text_streaming_reason_disabled_by_admin() -> None:
    with _client() as client:
        state = client.app.state.tlsoc
        cfg = state.prefs.chat_agent.model_copy(update={"allow_text_streaming": False})
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"chat_agent": cfg}))
        body = client.get("/api/chat/context").json()
        assert body["text_streaming"] == {"available": False, "reason": "disabled_by_admin"}


def test_configuration_disabled_tool_is_marked_unavailable_not_ungranted() -> None:
    # "What can the assistant access?" must agree with the prompt/answer ("turned off
    # on this deployment"): still allowed by grants, but not available.
    with _client() as client:
        assert all(t["available"] for t in client.get("/api/chat/context").json()["tools"])
    with _client() as client:                     # a fresh app: /chat/context is cached 30 s
        state = client.app.state.tlsoc
        cfg = state.prefs.chat_agent.model_copy(update={"max_indicator_lookups": 0})
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"chat_agent": cfg}))
        tools = {t["name"]: t for t in client.get("/api/chat/context").json()["tools"]}
        assert tools["lookup_indicator"]["available"] is False
        assert tools["lookup_indicator"]["allowed"] is True and tools["lookup_indicator"]["missing"] == []
        assert all(t["available"] for name, t in tools.items() if name != "lookup_indicator")


def test_topics_endpoint_returns_templates_only() -> None:
    with _client() as client:
        known = client.get("/api/chat/topics/kpi:mtta")
        assert known.status_code == 200
        assert known.json()["topic"] == "kpi:mtta" and known.json()["question"].endswith("?")
        assert client.get("/api/chat/topics/kpi:not_a_topic").status_code == 404
        assert client.get("/api/chat/topics/KPI:mtta").status_code == 422
        assert client.get("/api/chat/topics/no-colon").status_code == 422


def test_history_estimate_and_calibration_from_the_last_turn() -> None:
    with _client() as client:
        turn = client.post("/api/chat", json={
            "message": "how are we doing", "persist_conversation": True, "idempotency_key": "ctx-hist-0001",
        }).json()
        body = client.get("/api/chat/context", params={"conversation_id": turn["conversation_id"]}).json()
        assert body["history_exchanges"] == 1 and body["history_tokens"] > 0
        assert body["calibration"] is not None and 0.25 <= body["calibration"] <= 4.0
        # Someone else's (or a missing) conversation estimates nothing, never 404s.
        other = client.get("/api/chat/context", params={"conversation_id": "chat-unknown"}).json()
        assert other["history_exchanges"] == 0


# --------------------------------------------------------------------------- #
# RBAC on money fields and model choice.
# --------------------------------------------------------------------------- #
async def test_cases_read_only_principal_gets_no_money_fields(app_state: AppState, monkeypatch) -> None:
    _grant(app_state, monkeypatch, ("cases", "read"))
    info = await _context(app_state)
    assert info.rates is None and info.budget is None and info.simulated is None
    assert info.spent_today is None and info.remaining is None
    assert info.budget_state == "ok"                              # tokens + state only
    allowed = {t.name for t in info.tools if t.allowed}
    assert allowed <= {"mitre_lookup", "app_help", "search_cases", "get_case", "shift_report",
                       "list_campaigns", "explain_decision", "app_status"}
    assert "search_logs" not in allowed and "cost_usage" not in allowed


async def test_money_fields_follow_models_read_and_cost_view(app_state: AppState, monkeypatch) -> None:
    _grant(app_state, monkeypatch, ("cases", "read"), ("models", "read"))
    priced = await _context(app_state)
    assert priced.rates is not None and priced.budget is not None and priced.simulated is False
    assert priced.spent_today is None and priced.remaining is None
    _grant(app_state, monkeypatch, ("cases", "read"), ("models", "read"), ("cost", "view"))
    spend = await _context(app_state)
    assert spend.spent_today == 0 and spend.remaining == pytest.approx(app_state.prefs.budget.daily_usd)


async def test_non_default_model_needs_models_read(app_state: AppState, monkeypatch) -> None:
    _grant(app_state, monkeypatch, ("cases", "read"))
    with pytest.raises(HTTPException) as forbidden:
        await run_chat_turn(_request(app_state), ChatRequest(message="x", model="claude-opus-4-8"), app_state)
    assert forbidden.value.status_code == 403
    assert forbidden.value.detail["code"] == "chat_model_forbidden"
    # The configured default needs no grant; the context ignores a model it may not pick.
    info = await _context(app_state, model="claude-opus-4-8")
    assert info.model == app_state.prefs.chat_model.model
    _grant(app_state, monkeypatch, ("cases", "read"), ("models", "read"))
    assert (await _context(app_state, model="claude-opus-4-8")).model == "claude-opus-4-8"
    with pytest.raises(HTTPException) as unavailable:
        await run_chat_turn(_request(app_state), ChatRequest(message="x", model="text-embedding-3-small"), app_state)
    assert unavailable.value.status_code == 422


async def test_case_turn_without_comment_grant_is_not_saved(app_state: AppState, monkeypatch) -> None:
    await _seed_case(app_state, "case-no-comment")
    _grant(app_state, monkeypatch, ("cases", "read"))
    start = await run_chat_turn(_request(app_state), ChatRequest(
        message="summarise", case_id="case-no-comment", idempotency_key="case-nc-0001",
    ), app_state)
    await asyncio.wait_for(start.handle.finished.wait(), 10)
    response = start.handle.response
    assert response.notice is not None and response.notice.kind == "not_saved"
    assert response.notice.retryable is False
    assert await app_state.case_threads.list_for_case("case-no-comment") == []


def test_restricted_role_context_writes_no_audit_rows() -> None:
    with _client(auth_enabled=True, auth_jwt_secret="ctx-test-secret", auth_seed_admin=True) as client:
        state = client.app.state.tlsoc
        rbac = state.prefs.rbac.model_copy(update={
            "enabled": True, "denies": {"analyst_tier1": {"models": ["read"], "cost": ["view"]}},
        })
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"rbac": rbac}))
        assert client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"}).status_code == 200
        created = client.post("/api/users", json={
            "username": "restricted", "password": "restricted-pass-12345", "role": "analyst_tier1",
        })
        assert created.status_code == 200, created.text
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "restricted", "password": "restricted-pass-12345",
        }).status_code == 200
        before = len(client.portal.call(_control_rows, state))
        body = client.get("/api/chat/context").json()
        assert len(client.portal.call(_control_rows, state)) == before   # zero audit writes
        assert body["rates"] is None and body["budget"] is None and body["spent_today"] is None
        assert body["budget_state"] in ("ok", "approaching", "reached")
        cost = next(t for t in body["tools"] if t["name"] == "cost_usage")
        assert cost["allowed"] is False and "cost:view" in cost["missing"]
        refused = client.post("/api/chat", json={"message": "x", "model": "claude-opus-4-8"})
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "chat_model_forbidden"


async def _control_rows(state: AppState) -> list[dict]:
    return await state.control_audit.records(limit=1000)


async def _store_role(state: AppState, role: Any) -> None:
    await state.custom_roles.put(role)


def _denials(rows: list[dict]) -> list[dict]:
    return [r for r in rows if str(r.get("action_type")) == "access_denied"]


def test_real_custom_role_reader_sees_no_money_and_its_turn_writes_no_denials() -> None:
    """A REAL custom role (in the custom-roles store, assigned at user creation and
    resolved by ``resolve_access``) that grants only ``cases:read``, on a base role
    stripped of money grants: ``/chat/context`` carries no rates, budget or spend, and
    a turn that only uses tools the principal holds writes no ``access_denied`` row
    (SPEC §5.1: grants are resolved once, without audit rows)."""
    from app.models import CustomRole

    provider = MockProvider()
    provider.push("chat", '{"action": "tool", "tool": "mitre_lookup", "input": {"ids": ["T1110"]}}')
    provider.push("chat", '{"action": "final", "answer_kind": "data"}\n---ANSWER---\nBrute force is T1110.')
    with _client(provider, auth_enabled=True, auth_jwt_secret="ctx-role-secret", auth_seed_admin=True) as client:
        state = client.app.state.tlsoc
        rbac = state.prefs.rbac.model_copy(update={
            "enabled": True,
            "denies": {"analyst_tier1": {"models": ["read"], "cost": ["view"]}},
        })
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"rbac": rbac}))
        client.portal.call(_store_role, state, CustomRole(name="chat-reader", grants={"cases": ["read"]}))
        assert client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"}).status_code == 200
        created = client.post("/api/users", json={
            "username": "reader", "password": "reader-pass-123456", "role": "analyst_tier1",
            "custom_roles": ["chat-reader"],
        })
        assert created.status_code == 200, created.text
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "reader", "password": "reader-pass-123456",
        }).status_code == 200
        # The custom role really is assigned and resolves (not just the base role).
        from app.api.deps import _assigned_custom_roles

        assert client.portal.call(_assigned_custom_roles, state, "reader") == ["chat-reader"]
        before = len(client.portal.call(_control_rows, state))
        context = client.get("/api/chat/context")
        assert context.status_code == 200
        body = context.json()
        assert body["rates"] is None and body["budget"] is None
        assert body["spent_today"] is None and body["remaining"] is None and body["simulated"] is None
        assert len(client.portal.call(_control_rows, state)) == before    # resolving grants: no rows
        events = [line for line in client.post("/api/chat/stream", json={
            "message": "what is brute force", "persist_conversation": True,
            "idempotency_key": "role-turn-0001",
        }).text.splitlines() if line.strip()]
        assert '"turn.done"' in events[-1]
        rows = client.portal.call(_control_rows, state)
        assert not _denials(rows)                                         # no refusal was audited
        assert len(rows) > before                                         # the turn itself was audited


# --------------------------------------------------------------------------- #
# Cache (per principal, 30 s, dropped when the caller's turn ends).
# --------------------------------------------------------------------------- #
async def test_context_is_cached_per_principal_and_dropped_after_a_turn(app_state: AppState) -> None:
    first = await _context(app_state)
    assert await _context(app_state) is first
    start = await run_chat_turn(_request(app_state), ChatRequest(
        message="hi", persist_conversation=True, idempotency_key="ctx-cache-0001",
    ), app_state)
    await asyncio.wait_for(start.handle.finished.wait(), 10)
    assert await _context(app_state) is not first


# --------------------------------------------------------------------------- #
# Demo Mode: starters, simulated rates, the builder's overlays.
# --------------------------------------------------------------------------- #
async def test_demo_context_uses_demo_starters_and_simulated_money(app_state: AppState, monkeypatch) -> None:
    fake = types.ModuleType("app.engine.demo_chat")
    fake.DEMO_STARTERS = [
        {"id": "posture", "label": "Posture now", "prompt": "How are we doing?", "tools": ["soc_metrics"]},
        {"id": "bad id", "label": "x", "prompt": "y"},                 # invalid → dropped
    ]
    monkeypatch.setitem(sys.modules, "app.engine.demo_chat", fake)
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        info = await _context(app_state)
        assert [s.id for s in info.starters] == ["posture"]
        assert info.simulated is True
        assert info.rates.input_per_million == pytest.approx(3.0)
        assert info.rates.output_per_million == pytest.approx(15.0)
        assert info.budget.enabled is False and info.spent_today is None
        assert info.text_streaming.available is True                # the demo provider streams
        monkeypatch.setitem(sys.modules, "app.engine.demo_chat", None)
        app_state.chat_turns.context_cache.clear()
        assert (await _context(app_state)).starters == []            # planner absent → none
    finally:
        await app_state.disable_demo()


async def test_build_chat_tool_context_real_and_demo(app_state: AppState) -> None:
    body = ChatRequest(message="x", scopes=["logs", "cases"], time_range={"from": "now-7d"}, case_id="case-9")
    request = _request(app_state)
    real = await app_state.build_chat_tool_context(request, body)
    assert real.user == "default" and real.case_id == "case-9" and real.demo_active is False
    assert real.scopes == frozenset({"logs", "cases"}) and real.time_range.label() == "last 7d"
    assert real.grants == frozenset(chat_grant_pairs())                 # auth off: all granted
    assert real.cases is app_state.cases and real.budget_gate is app_state.budget_gate
    assert callable(real.enrich) and real.cluster_for_case is not None
    status = real.secrets_status()
    assert status and all(isinstance(v, (bool, dict)) for v in status.values())
    assert real.browse_sources() == []                                  # no configured sources
    assert isinstance(await real.source_health_rows(), list)
    assert real.log_source is app_state.chat_engine._source
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        demo = await app_state.build_chat_tool_context(request, body)
        assert demo.demo_active is True and demo.enrich is None and demo.budget_gate is None
        assert demo.secrets_status is None and demo.runbooks is None and demo.rule_versions is None
        assert demo.cases is app_state._demo.cases and demo.audit is app_state._demo.audit
        assert demo.log_source is app_state._demo.sources["splunk"]
        targets = demo.browse_sources()
        assert {t.source_id for t in targets} == {r["id"] for r in app_state.demo_sources_overlay()}
        assert await demo.source_health_rows() == app_state.demo_source_health_overlay()
        connector, owned, sid, name = demo.source_resolver("demo-qradar")
        assert connector is not None and owned is None and sid == "demo-qradar" and name
        with pytest.raises(ChatSourceUnavailable):
            demo.source_resolver("not-a-demo-source")
        assert app_state.reports is app_state._demo.reports
    finally:
        await app_state.disable_demo()
    assert app_state.reports is app_state._real_reports


def test_chat_grant_pairs_cover_tools_console_and_routes() -> None:
    from app.agents.chat_tools.registry import catalogue_grant_pairs
    from app.knowledge import console_grant_pairs

    pairs = chat_grant_pairs()
    assert catalogue_grant_pairs() <= pairs and console_grant_pairs() <= pairs
    assert {("cases", "comment"), ("memory", "manage"), ("models", "read"), ("cost", "view")} <= pairs
