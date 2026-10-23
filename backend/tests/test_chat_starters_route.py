"""``GET /api/chat/starters`` and ``POST /api/chat/starters/events`` (Round 13 SPEC-chat
§3.2.2, §3.2.3, §3.12, §3.13, §3.15 ``test_chat_starters_route.py``).

RBAC matrix (no card lists a tool the caller cannot run; budget, silent-source and
approval cards never appear without their grants); ownership 404s; no model call and no
UsageDoc; the per-caller cache and its invalidation by a dismissal; event validation and
the rate bound; the bounded state document; the user-delete purge; Demo cards from the
seeded data within the time bound; ``/chat/context`` no longer reads the case store; the
starter value fenced on the live turn and on replay.
"""

from __future__ import annotations

import inspect
import json
from collections import OrderedDict
import random
import tempfile
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.agents import chat_starter_text as text
from app.agents.chat_events import extract_user_turn
from app.api import routes_chat_starters as route_module
from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_chat import router as chat_router
from app.api.routes_chat_starters import router as starters_router
from app.auth.service import AuthService
from app.config import Secrets
from app.constants import UNTRUSTED_CLOSE, UNTRUSTED_OPEN, CaseStatus, EntityType, SourceSurface
from app.engine import chat_starters as cs
from app.es.fake import InMemoryESClient
from app.llm import providers
from app.llm.gateway import LLMGateway
from app.llm.providers import MockProvider
from app.models import Case, Entity, Proposal
from app.state import AppState
from app.stores.chat_conversations import partition_key_for_user
from app.stores.chat_starters import CHAT_STARTERS_NS, STARTERS_FIELD

UTC = timezone.utc
FINAL = (
    json.dumps({"action": "final", "blocks": [], "follow_ups": [], "answer_kind": "conversation"})
    + "\n---ANSWER---\nNoted."
)


def _secrets(**extra: Any) -> Secrets:
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
                   openai_api_key=None, **extra)


def _case(cid: str, *, created: datetime, status: CaseStatus = CaseStatus.OPEN, risk: float = 50.0,
          number: str = "", assignee: str = "") -> Case:
    return Case(case_id=cid, cluster_signature=f"sig-{cid}", source_surface=SourceSurface.INVESTIGATE,
                entity=Entity(type=EntityType.IP, value="10.0.0.1"), created_at=created.isoformat(),
                updated_at=created.isoformat(), status=status, risk_score=risk, case_number=number,
                assignee=assignee)


@contextmanager
def _client(provider: MockProvider | None = None, *, auth: bool = False, demo: bool = False,
            configure: Callable[[AppState], Any] | None = None, secrets: Secrets | None = None) -> Iterator[TestClient]:
    provider = provider or MockProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    secrets = secrets or (_secrets(auth_enabled=True, auth_jwt_secret="r13-starters-secret", auth_seed_admin=True)
                          if auth else _secrets())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        update: dict[str, Any] = {"setup_complete": True}
        if auth:
            update["rbac"] = state.prefs.rbac.model_copy(update={"enabled": True})
        await state.update_prefs(state.prefs.model_copy(update=update))
        if demo:
            await state.enable_demo(mode="seeded", seed=1337, history_days=30)
        if configure is not None:
            result = configure(state)
            if inspect.isawaitable(result):
                await result
        app.state.tlsoc = state
        yield
        await cs.settle_slow_signals(state)
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else []
    for router in (base_router, chat_router, starters_router):
        api.include_router(router, dependencies=deps)
    with TestClient(api) as client:
        yield client


def _login(client: TestClient, username: str, password: str) -> None:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _starters(client: TestClient, **params: Any) -> dict[str, Any]:
    response = client.get("/api/chat/starters", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _families(info: dict[str, Any]) -> list[str]:
    return [s["id"] for s in info["starters"]]


def _event(client: TestClient, kind: str, keys: list[str], **extra: Any):
    return client.post("/api/chat/starters/events", json={"type": kind, "keys": keys, **extra})


# --------------------------------------------------------------------------- #
# RBAC matrix
# --------------------------------------------------------------------------- #
async def _established(state: AppState) -> None:
    """Not a fresh install: one closed case from 60 days ago, so the signal families run
    (a fresh install serves the onboarding cards alone, §3.11)."""
    await state.cases.save(_case("c-established", created=datetime.now(UTC) - timedelta(days=60),
                                 status=CaseStatus.CLOSED))


def _platform_data(state: AppState) -> None:
    """Signals for every grant-gated family: a quiet source, a warning budget and two
    pending approvals."""
    now = datetime.now(UTC)
    quiet = int((now - timedelta(hours=2)).timestamp() * 1000)
    state._chat_source_health_rows = lambda: [  # type: ignore[method-assign]
        {"source_id": "wz-1", "source_name": "Wazuh", "enabled": True, "silent": True, "last_event_millis": quiet}]

    async def status(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {"enabled": True, "soft_warn_pct": 0.8, "daily": {"spent": 9.0, "cap": 10.0, "fraction": 0.9}}

    state.budget_gate.status = status  # type: ignore[method-assign]
    pending = [Proposal(kind="suppression", created_at=(now - timedelta(hours=h)).isoformat(),
                        expires_at=(now + timedelta(days=2)).isoformat()) for h in (1, 3)]

    async def proposals(status: str | None = None) -> list[Proposal]:
        return list(pending) if status == "pending" else []

    state.proposals.list = proposals  # type: ignore[method-assign]


_DENY_CASES = [
    ("metrics", "view", "analyst_tier2"),
    ("sources", "read", "responder"),
    ("cost", "view", "soc_manager"),
    ("proposals", "read", "analyst_tier2"),
]


def _allowed(client: TestClient) -> tuple[set[str], dict[str, set[str]], dict[str, dict[str, str]]]:
    context = client.get("/api/chat/context")
    assert context.status_code == 200, context.text
    tools = context.json()["tools"]
    allowed = {t["name"] for t in tools if t["allowed"] and t.get("available", True)}
    kinds = {t["name"]: set(t.get("kinds_allowed") or []) for t in tools}
    requires = {t["name"]: dict(t.get("kind_requires") or {}) for t in tools}
    return allowed, kinds, requires


def _check_cards(client: TestClient, info: dict[str, Any]) -> None:
    allowed, kinds, requires = _allowed(client)
    for starter in info["starters"]:
        for tool in starter["tools"]:
            assert tool in allowed, (starter["id"], tool)
        spec = text.template(starter["template"])
        for tool, kind in spec.kinds.items():
            assert kind not in requires.get(tool, {}) or kind in kinds.get(tool, set()), (starter["id"], kind)


@pytest.mark.parametrize(("resource", "action", "role"), _DENY_CASES)
def test_cards_follow_the_callers_grants(resource: str, action: str, role: str) -> None:
    async def configure(state: AppState) -> None:
        await _established(state)
        _platform_data(state)
        rbac = state.prefs.rbac.model_copy(update={"denies": {role: {resource: [action]}}})
        await state.update_prefs(state.prefs.model_copy(update={"rbac": rbac}))

    with _client(auth=True, configure=configure) as client:
        _login(client, "Admin", "Admin@123")
        admin = _starters(client)
        # The positive control: the super_admin sees every grant-gated card.
        assert {"silent_source", "budget", "approvals"} <= set(_families(admin)) | set(
            s["id"] for s in admin["starters"])
        _check_cards(client, admin)
        assert client.post("/api/users", json={"username": "riley", "password": "riley-pass-12345",
                                               "role": role}).status_code == 200
        _login(client, "riley", "riley-pass-12345")
        info = _starters(client)
        _check_cards(client, info)
        families = set(_families(info))
        gated = {("sources", "read"): "silent_source", ("cost", "view"): "budget",
                 ("proposals", "read"): "approvals", ("metrics", "view"): "posture"}
        assert gated[(resource, action)] not in families
        if (resource, action) != ("metrics", "view"):
            assert "posture" in families or len(info["starters"]) == 6


@pytest.mark.parametrize("role", ["analyst_tier1", "auditor"])
def test_built_in_roles_see_only_cards_they_can_run(role: str) -> None:
    async def configure(state: AppState) -> None:
        # Not a fresh install: one closed case, so the evergreen set (not onboarding) fills.
        await state.cases.save(_case("c-old", created=datetime.now(UTC) - timedelta(days=3),
                                     status=CaseStatus.CLOSED))

    with _client(auth=True, configure=configure) as client:
        _login(client, "Admin", "Admin@123")
        assert client.post("/api/users", json={"username": "uma", "password": "uma-pass-123456",
                                               "role": role}).status_code == 200
        _login(client, "uma", "uma-pass-123456")
        info = _starters(client)
        _check_cards(client, info)
        assert info["starters"]
        evergreen = [f for f in _families(info) if f in cs.EVERGREEN_FAMILIES]
        order = cs.EVERGREEN_ORDER_AUDITOR if role == "auditor" else cs.EVERGREEN_ORDER
        assert evergreen == [f for f in order if f in evergreen] and evergreen
        if role == "auditor":
            assert evergreen[0] == "posture" and "triage" not in evergreen


# --------------------------------------------------------------------------- #
# Ownership
# --------------------------------------------------------------------------- #
def test_thread_surface_is_owner_only_and_case_surface_needs_a_case() -> None:
    provider = MockProvider()
    provider.push("chat", FINAL)
    with _client(provider, auth=True) as client:
        _login(client, "Admin", "Admin@123")
        assert client.post("/api/users", json={"username": "olive", "password": "olive-pass-12345",
                                               "role": "analyst_tier1"}).status_code == 200
        answer = client.post("/api/chat", json={"message": "hello there", "persist_conversation": True,
                                                "idempotency_key": "r13-starter-thread-1"})
        assert answer.status_code == 200, answer.text
        cid = answer.json()["conversation_id"]
        mine = _starters(client, surface="thread", conversation_id=cid)
        assert mine["surface"] == "thread" and mine["starters"] == []
        assert mine["catch_up"] is None  # the answer has not settled 30 minutes yet
        _login(client, "olive", "olive-pass-12345")
        other = client.get("/api/chat/starters", params={"surface": "thread", "conversation_id": cid})
        assert other.status_code == 404
        assert client.get("/api/chat/starters", params={"surface": "thread"}).status_code == 404
        assert client.get("/api/chat/starters", params={"surface": "case", "case_id": "nope"}).status_code == 404
        assert client.get("/api/chat/starters", params={"surface": "case"}).status_code == 404
        assert client.get("/api/chat/starters", params={"surface": "bogus"}).status_code == 422


def test_case_surface_chips_for_a_readable_case() -> None:
    async def configure(state: AppState) -> None:
        await state.cases.save(_case("case-r13-1", created=datetime.now(UTC), status=CaseStatus.ESCALATED))

    with _client(configure=configure) as client:
        info = _starters(client, surface="case", case_id="case-r13-1")
        assert [s["id"] for s in info["starters"]] == ["case_needs_person", "case_entity", "case_handoff"]
        assert all(s["ref"] is None for s in info["starters"]) and info["catch_up"] is None


# --------------------------------------------------------------------------- #
# A pure read: no model call, no UsageDoc
# --------------------------------------------------------------------------- #
def test_no_model_call_and_no_usage_doc(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    for name in ("complete", "embed", "embed_with_provenance"):
        original = getattr(LLMGateway, name)

        def spy(self: Any, *a: Any, _name: str = name, _original: Any = original, **k: Any) -> Any:
            calls.append(_name)
            return _original(self, *a, **k)

        monkeypatch.setattr(LLMGateway, name, spy)
    provider = MockProvider()

    async def configure(state: AppState) -> None:
        now = datetime.now(UTC)
        for i in range(5):
            await state.cases.save(_case(f"c-{i}", created=now - timedelta(hours=i + 1), risk=40 + i))
        _platform_data(state)

    with _client(provider, configure=configure) as client:
        state: AppState = client.app.state.tlsoc
        usage_before = len(client.portal.call(lambda: state.usage_store.records(limit=1000)))
        audit_before = len(client.portal.call(lambda: state.audit.records(limit=1000)))
        control_before = len(client.portal.call(lambda: state.control_audit.records(limit=1000)))
        info = _starters(client)
        assert info["starters"]
        keys = [s["key"] for s in info["starters"]]
        assert _event(client, "viewed", keys[:4]).status_code == 204
        assert _event(client, "used", keys[:1]).status_code == 204
        assert _event(client, "dismissed", keys[1:2]).status_code == 204
        _starters(client, surface="case", case_id="c-1")
        client.portal.call(lambda: cs.settle_slow_signals(state))
        _starters(client)
        assert calls == [] and provider.calls == []
        assert len(client.portal.call(lambda: state.usage_store.records(limit=1000))) == usage_before
        assert len(client.portal.call(lambda: state.audit.records(limit=1000))) == audit_before
        assert len(client.portal.call(lambda: state.control_audit.records(limit=1000))) == control_before


# --------------------------------------------------------------------------- #
# The per-caller cache
# --------------------------------------------------------------------------- #
def test_the_cache_holds_for_60_seconds_and_a_dismissal_shows_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(route_module, "_monotonic", lambda: clock[0])
    with _client() as client:
        first = _starters(client)
        assert _starters(client)["as_of"] == first["as_of"]  # served from the cache
        clock[0] += 59
        assert _starters(client)["as_of"] == first["as_of"]
        clock[0] += 2
        refreshed = _starters(client)
        assert refreshed["as_of"] != first["as_of"]
        assert refreshed["expires_at"] > refreshed["as_of"]
        as_of = datetime.fromisoformat(refreshed["as_of"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(refreshed["expires_at"].replace("Z", "+00:00"))
        assert expires - as_of == timedelta(seconds=120)
        target = refreshed["starters"][0]
        assert _event(client, "dismissed", [target["key"]]).status_code == 204
        after = _starters(client)  # within the minute: the state revision changed
        assert target["id"] not in _families(after)


def test_a_degraded_answer_is_served_but_never_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    builds = [0]
    real = route_module.build_starters

    async def counting(*args: Any, **kwargs: Any):
        builds[0] += 1
        return await real(*args, **kwargs)

    async def boom(_b: Any):
        raise RuntimeError("a transient overrun")

    monkeypatch.setattr(route_module, "build_starters", counting)
    families = dict(cs.FAMILIES)
    families["shift"] = boom
    monkeypatch.setattr(cs, "FAMILIES", families)
    with _client(configure=_established) as client:
        first = _starters(client)
        assert first["starters"] and "shift" not in _families(first)  # served
        _starters(client)
        assert builds[0] == 2  # the degraded answer was not pinned for 60 seconds
        monkeypatch.setattr(cs, "FAMILIES", dict(cs.FAMILIES, shift=cs._family_shift))
        healthy = _starters(client)
        _starters(client)
        assert builds[0] == 3 and "shift" in _families(healthy)  # a whole answer is cached


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #
def test_event_validation_is_422() -> None:
    with _client() as client:
        ok = "0123456789abcdef"
        bad = [
            {"type": "viewed", "keys": [ok], "extra": 1},
            {"type": "viewed", "keys": ["0123456789ABCDEF"]},
            {"type": "viewed", "keys": ["0123456789abcde"]},
            {"type": "viewed", "keys": [ok + "\n"]},
            {"type": "viewed", "keys": [ok] * 7},
            {"type": "clicked", "keys": [ok]},
            {"type": "viewed", "surface": "elsewhere"},
            {"keys": [ok]},
        ]
        for body in bad:
            assert client.post("/api/chat/starters/events", json=body).status_code == 422, body
        assert client.post("/api/chat/starters/events", json={"type": "viewed", "keys": [ok]}).status_code == 204
        assert client.post("/api/chat/starters/events", json={"type": "viewed", "surface": "thread"}).status_code == 204


def test_the_31st_event_in_a_minute_is_429(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [5000.0]
    monkeypatch.setattr(route_module, "_monotonic", lambda: clock[0])
    with _client() as client:
        for _ in range(30):
            assert _event(client, "viewed", []).status_code == 204
        busy = _event(client, "viewed", [])
        assert busy.status_code == 429 and int(busy.headers["Retry-After"]) >= 1
        clock[0] += 61
        assert _event(client, "viewed", []).status_code == 204


def test_unknown_keys_are_ignored_and_known_ones_resolve_server_side() -> None:
    with _client() as client:
        state: AppState = client.app.state.tlsoc
        info = _starters(client)
        served = info["starters"][0]
        assert _event(client, "dismissed", ["ffffffffffffffff"]).status_code == 204
        doc = client.portal.call(lambda: state.chat_starters.load(""))
        assert doc.dismissed == {}
        assert _event(client, "dismissed", [served["key"]]).status_code == 204
        doc = client.portal.call(lambda: state.chat_starters.load(""))
        assert set(doc.dismissed) == {served["id"]}


def test_a_use_that_arrives_before_its_view_is_kept() -> None:
    # The client posts "used" on the first send, possibly before "viewed" lands, and a
    # catch-up clause's key is never in a home "viewed" event (review A-1).
    with _client(configure=_established) as client:
        state: AppState = client.app.state.tlsoc
        info = _starters(client)
        card = info["starters"][0]
        assert _event(client, "used", [card["key"]]).status_code == 204
        for _ in range(3):
            assert _event(client, "viewed", [card["key"]]).status_code == 204
        doc = client.portal.call(lambda: state.chat_starters.load(""))
        stats = doc.key_stats(card["key"])
        assert stats is not None and stats.views == 3 and stats.used_at is not None
        assert stats.family == card["id"]


def test_the_state_document_stays_within_64_keys_and_8_kb() -> None:
    with _client() as client:
        state: AppState = client.app.state.tlsoc
        runtime = route_module.starter_runtime(state)
        owner = route_module.normalize_user_id("")
        keys = [f"{i:016x}" for i in range(102)]
        for start in range(0, len(keys), 6):
            batch = keys[start:start + 6]
            # As if the server had served these cards to this caller.
            runtime.served.setdefault(owner, OrderedDict()).update({k: "needs_human" for k in batch})
            assert _event(client, "viewed", batch).status_code == 204
        raw = client.portal.call(lambda: state.kv.get(CHAT_STARTERS_NS, partition_key_for_user("")))
        stored = raw[STARTERS_FIELD]
        assert len(stored.encode("utf-8")) <= cs.STATE_MAX_BYTES
        parsed = json.loads(stored)
        assert len(parsed["keys"]) <= cs.STATE_MAX_KEYS and parsed["schema"] == 1
        assert set(parsed) == {"schema", "last_seen_at", "visit_started_at", "catchup_since", "shift_started_at",
                               "keys", "dismissed"}
        # Opaque keys, family ids, counters and times only: no question text.
        assert "?" not in stored and "case" not in stored.replace("needs_human", "")


# --------------------------------------------------------------------------- #
# The user delete purges the state (and the parity with the ratings)
# --------------------------------------------------------------------------- #
def test_the_purge_hook_clears_starters_wherever_ratings_are_cleared() -> None:
    params = inspect.signature(AuthService.purge_user_side_state).parameters
    assert "chat_starters" in params and "chat_feedback" in params
    import app.api.routes as routes

    source = inspect.getsource(routes.delete_user)
    assert "chat_feedback=" in source and "chat_starters=" in source


def test_deleting_a_user_purges_their_starter_state() -> None:
    with _client(auth=True, configure=_established) as client:
        state: AppState = client.app.state.tlsoc
        _login(client, "Admin", "Admin@123")
        assert client.post("/api/users", json={"username": "carol", "password": "carol-pass-12345",
                                               "role": "analyst_tier1"}).status_code == 200
        _login(client, "carol", "carol-pass-12345")
        info = _starters(client)
        assert _event(client, "viewed", [s["key"] for s in info["starters"][:3]]).status_code == 204
        assert _event(client, "dismissed", [info["starters"][0]["key"]]).status_code == 204
        key = partition_key_for_user("carol")
        before = client.portal.call(lambda: state.kv.get(CHAT_STARTERS_NS, key))
        assert before and before.get(STARTERS_FIELD)
        _login(client, "Admin", "Admin@123")
        assert client.delete("/api/users/carol").status_code == 200
        after = client.portal.call(lambda: state.kv.get(CHAT_STARTERS_NS, key))
        assert not (after or {}).get(STARTERS_FIELD)
        assert client.post("/api/users", json={"username": "carol", "password": "carol-new-pass-999",
                                               "role": "analyst_tier1"}).status_code == 200
        _login(client, "carol", "carol-new-pass-999")
        fresh = _starters(client)
        assert info["starters"][0]["id"] in _families(fresh) or len(fresh["starters"]) == 6
        shift = next((s for s in fresh["starters"] if s["id"] == "shift"), None)
        assert shift is not None and shift["reason"] == "Start of your day"


# --------------------------------------------------------------------------- #
# Demo: dynamic cards from the seeded stores, within the time bound
# --------------------------------------------------------------------------- #
def test_demo_returns_dynamic_cards_from_the_seeded_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    with _client(demo=True) as client:
        state: AppState = client.app.state.tlsoc
        warm = client.get("/api/chat/starters", params={"surface": "thread", "conversation_id": "x"})
        assert warm.status_code == 404
        best = float("inf")
        info: dict[str, Any] = {}
        for _ in range(3):
            route_module._RUNTIMES.clear()
            started = time.perf_counter()
            info = _starters(client)
            best = min(best, time.perf_counter() - started)
        assert best < 0.6, best
        families = _families(info)
        # The Demo card takes slot 4 (among the cards a wide lane shows), except that a
        # shift-start card ranked fourth keeps slot 4 on the visit that starts a shift
        # and the Demo card follows it in slot 5 (Round 13 polish decision, §10.2).
        templates = [c.get("template") for c in info["starters"]]
        if templates[3:4] == ["shift_start"]:
            assert families[4] == "demo", families
        else:
            assert "demo" in families[:4], families
        signals = [f for f in families if f in cs.BASE and f != "demo"]
        assert signals, families
        # A catch-up line on the first Demo visit (the Demo anchor stands in for a baseline).
        assert info["catch_up"] is not None and info["catch_up"]["clauses"]
        for clause in info["catch_up"]["clauses"]:
            assert clause["starter"]["action"] == "send" and len(clause["text"]) <= 60
        for starter in info["starters"]:
            assert len(starter["prompt"]) <= 120 and len(starter["reason"]) <= 60
            if starter["action"] == "send" and starter["template"] not in ("demo",):
                assert text.parse_starter_question(starter["prompt"]) is not None, starter["prompt"]
        assert state.demo_active


def test_the_20000_case_sqlite_fixture_answers_within_the_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.stores.sql.models import CaseRow
    from app.stores.sql.repositories import _canonical_created_at, _entity_value

    rng = random.Random(13)
    now = datetime.now(UTC)
    statuses = list(CaseStatus)

    def build(i: int) -> Case:
        created = now - timedelta(seconds=rng.randint(0, 60 * 86_400))
        status = rng.choice(statuses) if rng.random() < 0.06 else CaseStatus.CLOSED
        case = _case(f"c{i:06d}", created=created, status=status, risk=rng.randint(0, 100), number=f"CASE-{i:06d}")
        return case.model_copy(update={"rule_ids": [f"rule-{rng.randint(1, 30)}"],
                                       "mitre": [rng.choice(["T1078", "T1110", "T1190"])]})

    async def configure(state: AppState) -> None:
        cases = [build(i) for i in range(20_000)]
        async with state.cases._sm() as session:
            session.add_all([CaseRow(
                case_id=c.case_id, cluster_signature=c.cluster_signature, status=c.status.value,
                source_surface=c.source_surface.value, entity_value=_entity_value(c),
                created_at=_canonical_created_at(c.created_at), updated_at=c.updated_at or "",
                doc=c.model_dump(mode="json"),
            ) for c in cases])
            await session.commit()

    with tempfile.TemporaryDirectory() as folder:
        secrets = _secrets(state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{folder}/s.db")
        with _client(configure=configure, secrets=secrets) as client:
            assert client.get("/api/chat/starters", params={"surface": "case", "case_id": "c000001"}).status_code == 200
            best = float("inf")
            for _ in range(3):
                route_module._RUNTIMES.clear()
                started = time.perf_counter()
                info = _starters(client)
                best = min(best, time.perf_counter() - started)
            assert best < 0.6, best
            assert "sla" in _families(info) or "needs_human" in _families(info)
            # Every request on its own, while a background reading (hunt, platform) is in
            # flight: the reading reads off the event loop and gives way between pages,
            # so it never pushes a reply past the bound or drops a case family (review A-2).
            # Made deterministic: the give-way cap is raised so a reading waits for the
            # whole build however slow this machine is (the production cap, and that a
            # reading gives way at all, have their own engine test), so a reply competes
            # with at most the page in flight when it starts, and a reply that waited for
            # the reading would park both for the raised cap and fail. Every reply must
            # keep its case families; the time bound is the best of three replies with a
            # reading in flight, measured like the plain builds above (one reply timed on
            # a CPU shared with other work measures the machine, not the route).
            state: AppState = client.app.state.tlsoc
            memo = cs.slow_signals(state)
            client.portal.call(lambda: cs.settle_slow_signals(state))  # the earlier readings
            pages: list[int] = []
            give_way = memo.give_way

            async def counting_give_way() -> None:
                pages.append(memo.active_builds)
                await give_way()

            monkeypatch.setattr(cs, "GIVE_WAY_MAX_S", 60.0)
            monkeypatch.setattr(memo, "give_way", counting_give_way)
            samples: list[float] = []
            for _ in range(3):
                if not memo.running:  # no reading in flight: start one (after this response)
                    memo.entries.clear()
                    route_module._RUNTIMES.clear()
                    _starters(client)
                assert memo.running
                route_module._RUNTIMES.clear()
                started = time.perf_counter()
                info = _starters(client)
                samples.append(time.perf_counter() - started)
                assert "sla" in _families(info) or "needs_human" in _families(info)
            client.portal.call(lambda: cs.settle_slow_signals(state))
            assert pages, "the readings never gave way between pages"
            assert min(samples) < 0.6, samples


# --------------------------------------------------------------------------- #
# /chat/context and the fence
# --------------------------------------------------------------------------- #
def test_chat_context_no_longer_reads_the_case_store() -> None:
    with _client() as client:
        state: AppState = client.app.state.tlsoc
        reads: list[str] = []
        store = state.cases
        for name in ("list", "scan_page", "get", "get_many", "list_window", "aggregate", "export_page"):
            original = getattr(store, name, None)
            if original is None:
                continue

            async def spy(*a: Any, _name: str = name, _original: Any = original, **k: Any) -> Any:
                reads.append(_name)
                return await _original(*a, **k)

            setattr(store, name, spy)
        response = client.get("/api/chat/context")
        assert response.status_code == 200, response.text
        assert reads == []
        starters = response.json()["starters"]
        assert [s["id"] for s in starters] == ["triage", "posture", "report", "explain_metric", "learn_app"]


def _outside_fences(content: str) -> str:
    out: list[str] = []
    inside = False
    for line in content.split("\n"):
        if inside:
            inside = line.strip() != UNTRUSTED_CLOSE
            continue
        if line.startswith(UNTRUSTED_OPEN):
            inside = True
            continue
        out.append(line)
    return "\n".join(out)


def test_a_starter_value_is_fenced_live_and_on_replay() -> None:
    provider = MockProvider()
    for _ in range(4):
        provider.push("chat", FINAL)
    value = "demo_noisy_scanner"
    question = text.render_question("noisy_rule", {"rule": value, "n": 30, "m": 36})
    with _client(provider) as client:
        first = client.post("/api/chat/stream", json={
            "message": question, "origin": "starter", "persist_conversation": True,
            "idempotency_key": "r13-starter-fence-0001"})
        assert first.status_code == 200, first.text
        events = [json.loads(line) for line in first.text.splitlines() if line.strip()]
        response = [e for e in events if e.get("type") == "turn.done"][-1]["response"]
        conversation = response["conversation_id"]
        calls = [c for c in provider.calls if c["role"] == "chat"]
        assert calls
        expected = text.render_starter_turn(question)
        for call in calls:
            users = [extract_user_turn(m["content"]) for m in call["messages"] if m["role"] == "user"]
            live = [u for u in users if u is not None][-1]
            assert live == expected
            assert value not in _outside_fences(live)
        before = len(provider.calls)
        second = client.post("/api/chat/stream", json={
            "message": "Thanks, summarise that in one line.", "origin": "user", "conversation_id": conversation,
            "persist_conversation": True, "idempotency_key": "r13-starter-fence-0002"})
        assert second.status_code == 200, second.text
        calls = [c for c in provider.calls[before:] if c["role"] == "chat"]
        assert calls
        for call in calls:
            users = [m["content"] for m in call["messages"] if m["role"] == "user"]
            assert expected in users
            assert not [u for u in users if value in _outside_fences(u)], users
