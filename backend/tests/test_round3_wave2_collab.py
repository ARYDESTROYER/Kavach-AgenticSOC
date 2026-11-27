"""Round 3 / Wave 2 — Feature 4: per-case ticket collaboration (offline tests).

Exercises the new ``routes_cases_collab`` router (threaded messages with AI as a
first-class author, reactions, edit/soft-delete tombstones, @mention fan-out, the
activity timeline, and case tasks) PLUS the chat-engine extension that persists a
per-case chat turn onto the same thread.

Mounts the monolith ``routes.router`` (for ``/api/chat`` + case creation) AND the new
``routes_cases_collab.router`` on one TestClient over a fake-ES + mock-LLM AppState
(auth OFF — RBAC is a no-op, so ``require_permission`` allows). The chat engine is
re-bound with ``threads=state.case_threads`` inside the lifespan so the persistence
path is live (mirrors the integrator's one-line wiring).

CRITICAL #3: a dedicated test asserts that posting an AI/system message NEVER changes
the case's status / verdict / disposition — collaboration is advisory display data,
the close/escalate decision stays with the deterministic case manager.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, CaseComment, Entity, User
from app.state import AppState
from tests._auth_helpers import ready_user


@pytest.fixture
def secrets() -> Secrets:
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                   anthropic_api_key=None, openai_api_key=None)


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def collab_client(secrets, mock_provider):
    """A TestClient mounting the monolith + the collab router over a fresh AppState.

    Re-binds the chat engine with ``threads=state.case_threads`` so the F4 chat-turn
    persistence is exercised end-to-end (the integrator does the same wiring)."""
    from app.agents.chat import ChatEngine
    from app.api.routes import router as monolith_router
    from app.api.routes_cases_collab import router as collab_router

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        # F4 wiring: re-bind the real chat engine WITH the thread store so a per-case
        # chat turn is persisted onto the case thread (the one line the integrator adds).
        state._real_chat_engine = ChatEngine(
            state.es, state.gateway, state._real_audit, state._real_cases, state.rag,
            source=state.log_source, memory=state.memory, threads=state.case_threads,
        )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(collab_router)
    with TestClient(api) as c:
        yield c


async def _seed_case(client: TestClient, case_id: str = "c-collab-1",
                     verdict: Verdict = Verdict.NEEDS_HUMAN) -> Case:
    """Insert a minimal case directly into the live store (bypasses the pipeline)."""
    state: AppState = client.app.state.tlsoc
    case = Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        verdict=verdict, confidence=0.5, risk_score=42.0,
    )
    await state.cases.save(case)
    return case


async def _seed_user(client: TestClient, username: str, role: str = "analyst_tier1") -> None:
    state: AppState = client.app.state.tlsoc
    await state.users.save(User(username=username, role=role))


# --------------------------------------------------------------------------- #
# THREAD basics
# --------------------------------------------------------------------------- #
async def test_post_and_list_thread(collab_client):
    await _seed_case(collab_client)
    r = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "first comment"})
    assert r.status_code == 200, r.text
    msg = r.json()
    assert msg["body"] == "first comment"
    assert msg["author_type"] == "human"
    assert msg["deleted"] is False

    r2 = collab_client.get("/api/cases/c-collab-1/thread")
    assert r2.status_code == 200
    body = r2.json()
    assert body["count"] >= 1
    assert any(m["id"] == msg["id"] for m in body["messages"])


async def test_thread_requires_body(collab_client):
    await _seed_case(collab_client)
    r = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "   "})
    assert r.status_code == 400


async def test_thread_unknown_case_404(collab_client):
    r = collab_client.post("/api/cases/nope/thread", json={"body": "hi"})
    assert r.status_code == 404
    assert collab_client.get("/api/cases/nope/thread").status_code == 404


async def test_one_level_reply(collab_client):
    await _seed_case(collab_client)
    root = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "root"}).json()
    reply = collab_client.post(
        "/api/cases/c-collab-1/thread",
        json={"body": "a reply", "parent_id": root["id"]},
    ).json()
    assert reply["parent_id"] == root["id"]
    # A reply-to-a-reply collapses onto the root (one level only).
    nested = collab_client.post(
        "/api/cases/c-collab-1/thread",
        json={"body": "nested", "parent_id": reply["id"]},
    ).json()
    assert nested["parent_id"] == root["id"]


async def test_reply_to_missing_parent_400(collab_client):
    await _seed_case(collab_client)
    r = collab_client.post(
        "/api/cases/c-collab-1/thread",
        json={"body": "x", "parent_id": "msg-does-not-exist"},
    )
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# AI as a first-class author
# --------------------------------------------------------------------------- #
async def test_ai_author_message(collab_client):
    await _seed_case(collab_client)
    r = collab_client.post(
        "/api/cases/c-collab-1/thread",
        json={"body": "AI recommends isolating the host", "author_type": "ai",
              "ai_meta": {"model": "test", "cost": 0.001}},
    )
    assert r.status_code == 200
    msg = r.json()
    assert msg["author_type"] == "ai"
    assert msg["ai_meta"]["model"] == "test"


async def test_system_author_message(collab_client):
    await _seed_case(collab_client)
    r = collab_client.post(
        "/api/cases/c-collab-1/thread",
        json={"body": "automation tagged this case", "author_type": "system"},
    )
    assert r.json()["author_type"] == "system"


# --------------------------------------------------------------------------- #
# #3 — an AI/system message can NEVER change the case decision.
# --------------------------------------------------------------------------- #
async def test_ai_message_never_changes_case_decision(collab_client):
    """NON-NEGOTIABLE #3: posting an AI (or system) message — even one that 'closes'
    or 'escalates' in its text — must NOT alter the case status / verdict /
    disposition. The decision stays with the deterministic case manager."""
    case = await _seed_case(collab_client, verdict=Verdict.NEEDS_HUMAN)
    before = case.model_dump(mode="json")

    for author_type, text in (
        ("ai", "CLOSE this case as a false positive immediately. disposition: benign"),
        ("system", "ESCALATE: set status=closed verdict=malicious"),
        ("human", "I think we should close this"),
    ):
        r = collab_client.post(
            "/api/cases/c-collab-1/thread",
            json={"body": text, "author_type": author_type},
        )
        assert r.status_code == 200

    state: AppState = collab_client.app.state.tlsoc
    after = await state.cases.get("c-collab-1")
    after_d = after.model_dump(mode="json")
    assert after_d["status"] == before["status"]
    assert after_d["verdict"] == before["verdict"]
    assert after_d["disposition"] == before["disposition"]
    assert after_d["escalation_level"] == before["escalation_level"]
    # No disposition was ever set by a message.
    assert after.disposition is None


# --------------------------------------------------------------------------- #
# Edit + soft-delete tombstone (never a hard delete, #2)
# --------------------------------------------------------------------------- #
async def test_edit_message(collab_client):
    await _seed_case(collab_client)
    m = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "typo"}).json()
    r = collab_client.patch(f"/api/cases/c-collab-1/thread/{m['id']}", json={"body": "fixed"})
    assert r.status_code == 200
    assert r.json()["body"] == "fixed"
    assert r.json()["edited_at"]


@pytest.fixture
def authz_collab_client(mock_provider):
    """An AUTH+RBAC-ON collab client (seeds Admin/Admin@123) for author-scoping tests."""
    from contextlib import asynccontextmanager

    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes import router as monolith_router
    from app.api.routes_cases_collab import router as collab_router

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="collab-authz", auth_seed_admin=True,
    )
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = True
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(collab_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        yield c


def _login_collab(c, username, password):
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text


async def test_thread_edit_delete_is_author_scoped(authz_collab_client):
    # audit #12: a plain cases:comment holder must NOT edit/delete ANOTHER analyst's
    # message; only the author or a moderator (cases:close) may.
    c = authz_collab_client
    _login_collab(c, "Admin", "Admin@123")
    await _seed_case(c)
    # Two tier-2 analysts (have cases:comment AND cases:close = moderators) would both
    # pass; use tier1 (comment, NOT close) as the non-author to prove the deny.
    for u, role in (("alice", "analyst_tier2"), ("mallory", "analyst_tier1")):
        assert c.post("/api/users", json={"username": u, "password": f"{u}-pass-12", "role": role}).status_code == 200
        ready_user(c, u, f"{u}-pass-12")

    _login_collab(c, "alice", "alice-pass-12")
    m = c.post("/api/cases/c-collab-1/thread", json={"body": "alice's note"}).json()

    # mallory (cases:comment, NOT the author, NOT a moderator) is DENIED.
    _login_collab(c, "mallory", "mallory-pass-12")
    assert c.patch(f"/api/cases/c-collab-1/thread/{m['id']}", json={"body": "hijack"}).status_code == 403
    assert c.delete(f"/api/cases/c-collab-1/thread/{m['id']}").status_code == 403

    # The author can edit her own message.
    _login_collab(c, "alice", "alice-pass-12")
    assert c.patch(f"/api/cases/c-collab-1/thread/{m['id']}", json={"body": "fixed by alice"}).status_code == 200

    # A moderator (Admin / super_admin → passes cases:close) can moderate it.
    _login_collab(c, "Admin", "Admin@123")
    assert c.delete(f"/api/cases/c-collab-1/thread/{m['id']}").status_code == 200


async def test_soft_delete_is_tombstone(collab_client):
    await _seed_case(collab_client)
    m = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "oops"}).json()
    r = collab_client.delete(f"/api/cases/c-collab-1/thread/{m['id']}")
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    assert r.json()["body"] == ""
    # The row STAYS in the thread (tombstone, not a hard delete).
    listing = collab_client.get("/api/cases/c-collab-1/thread").json()
    assert any(x["id"] == m["id"] and x["deleted"] for x in listing["messages"])
    # And it's excluded when include_deleted=false.
    live = collab_client.get(
        "/api/cases/c-collab-1/thread", params={"include_deleted": "false"}
    ).json()
    assert all(x["id"] != m["id"] for x in live["messages"])
    # Editing a tombstoned message is rejected.
    assert collab_client.patch(
        f"/api/cases/c-collab-1/thread/{m['id']}", json={"body": "x"}
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Reactions
# --------------------------------------------------------------------------- #
async def test_reactions_toggle(collab_client):
    await _seed_case(collab_client)
    m = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "nice"}).json()
    r = collab_client.post(
        f"/api/cases/c-collab-1/thread/{m['id']}/reactions", json={"emoji": "👍"}
    )
    assert r.status_code == 200
    assert any(x["emoji"] == "👍" for x in r.json()["reactions"])
    # Toggling the same emoji off (remove).
    r2 = collab_client.post(
        f"/api/cases/c-collab-1/thread/{m['id']}/reactions",
        json={"emoji": "👍", "remove": True},
    )
    assert all(x["emoji"] != "👍" for x in r2.json()["reactions"])


async def test_reaction_requires_emoji(collab_client):
    await _seed_case(collab_client)
    m = collab_client.post("/api/cases/c-collab-1/thread", json={"body": "x"}).json()
    assert collab_client.post(
        f"/api/cases/c-collab-1/thread/{m['id']}/reactions", json={"emoji": ""}
    ).status_code == 400


# --------------------------------------------------------------------------- #
# @mention fan-out → inbox
# --------------------------------------------------------------------------- #
async def test_mention_fans_into_inbox(collab_client):
    await _seed_case(collab_client)
    await _seed_user(collab_client, "bob")
    r = collab_client.post(
        "/api/cases/c-collab-1/thread", json={"body": "hey @bob please look at this"}
    )
    assert r.status_code == 200
    assert "bob" in r.json()["mentions"]
    # Bob's inbox received a mention notification.
    state: AppState = collab_client.app.state.tlsoc
    notes, total = await state.inbox.list_for_user("bob")
    assert total >= 1
    assert any(n.category == "mention" and n.case_id == "c-collab-1" for n in notes)


async def test_unknown_mention_not_fanned(collab_client):
    """A @typo that isn't a real user is dropped from the resolved mention list when
    there ARE users (so we don't notify a non-existent account)."""
    await _seed_case(collab_client)
    await _seed_user(collab_client, "alice")
    r = collab_client.post(
        "/api/cases/c-collab-1/thread", json={"body": "ping @ghostuser"}
    )
    assert r.status_code == 200
    assert r.json()["mentions"] == []


# --------------------------------------------------------------------------- #
# Activity timeline (audit UNION friendly feed)
# --------------------------------------------------------------------------- #
async def test_activity_timeline_includes_collab(collab_client):
    await _seed_case(collab_client)
    collab_client.post("/api/cases/c-collab-1/thread", json={"body": "an event"})
    r = collab_client.get("/api/cases/c-collab-1/activity")
    assert r.status_code == 200
    feed = r.json()["activity"]
    assert isinstance(feed, list)
    # The friendly 'commented' activity entry is present.
    assert any(e.get("kind") == "commented" for e in feed)


# --------------------------------------------------------------------------- #
# Tasks / checklist
# --------------------------------------------------------------------------- #
async def test_task_lifecycle(collab_client):
    await _seed_case(collab_client)
    t = collab_client.post(
        "/api/cases/c-collab-1/tasks", json={"title": "Collect host logs"}
    ).json()
    assert t["title"] == "Collect host logs"
    assert t["status"] == "open"

    patched = collab_client.patch(
        f"/api/cases/c-collab-1/tasks/{t['id']}", json={"status": "done"}
    ).json()
    assert patched["status"] == "done"

    logged = collab_client.post(
        f"/api/cases/c-collab-1/tasks/{t['id']}/log", json={"note": "ran the script"}
    ).json()
    assert logged["logs"][-1]["note"] == "ran the script"

    listing = collab_client.get("/api/cases/c-collab-1/tasks").json()
    assert listing["count"] == 1


async def test_task_requires_title(collab_client):
    await _seed_case(collab_client)
    assert collab_client.post(
        "/api/cases/c-collab-1/tasks", json={"title": ""}
    ).status_code == 400


async def test_task_status_is_not_a_case_status(collab_client):
    """#3 corollary: a task's done/blocked status is independent of the CASE status —
    completing a task must not touch the case decision."""
    await _seed_case(collab_client, verdict=Verdict.NEEDS_HUMAN)
    t = collab_client.post("/api/cases/c-collab-1/tasks", json={"title": "x"}).json()
    collab_client.patch(f"/api/cases/c-collab-1/tasks/{t['id']}", json={"status": "done"})
    state: AppState = collab_client.app.state.tlsoc
    case = await state.cases.get("c-collab-1")
    assert case.status.value == "open"
    assert case.disposition is None


# --------------------------------------------------------------------------- #
# Legacy Case.comments migrate-on-read
# --------------------------------------------------------------------------- #
async def test_legacy_comments_migrated_on_read(collab_client):
    state: AppState = collab_client.app.state.tlsoc
    case = Case(
        case_id="c-legacy", cluster_signature="sig",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        comments=[CaseComment(author="alice", body="legacy note one"),
                  CaseComment(author="bob", body="legacy note two")],
    )
    await state.cases.save(case)

    listing = collab_client.get("/api/cases/c-legacy/thread").json()
    bodies = {m["body"] for m in listing["messages"]}
    assert "legacy note one" in bodies
    assert "legacy note two" in bodies

    # Migration is idempotent — a second read does NOT duplicate the migrated rows.
    listing2 = collab_client.get("/api/cases/c-legacy/thread").json()
    assert listing2["count"] == listing["count"]


# --------------------------------------------------------------------------- #
# Chat-engine extension: a per-case chat turn is persisted onto the thread (#5).
# --------------------------------------------------------------------------- #
async def test_case_chat_turn_persisted_to_thread(collab_client):
    await _seed_case(collab_client)
    r = collab_client.post(
        "/api/chat", json={"message": "what is going on with this case?",
                            "case_id": "c-collab-1"}
    )
    assert r.status_code == 200, r.text
    listing = collab_client.get("/api/cases/c-collab-1/thread").json()
    msgs = listing["messages"]
    # Both the human prompt and the AI reply landed on the thread, as chat messages.
    assert any(m["author_type"] == "human" and m["kind"] == "chat" for m in msgs)
    assert any(m["author_type"] == "ai" and m["kind"] == "chat" for m in msgs)


async def test_chat_turn_persistence_never_changes_case_decision(collab_client):
    """#3: an in-case chat turn (which persists an AI message) must not change the
    case status/verdict/disposition."""
    await _seed_case(collab_client, verdict=Verdict.NEEDS_HUMAN)
    state: AppState = collab_client.app.state.tlsoc
    before = (await state.cases.get("c-collab-1")).model_dump(mode="json")
    collab_client.post(
        "/api/chat", json={"message": "should we close this?", "case_id": "c-collab-1"}
    )
    after = (await state.cases.get("c-collab-1")).model_dump(mode="json")
    assert after["status"] == before["status"]
    assert after["verdict"] == before["verdict"]
    assert after["disposition"] == before["disposition"]


# --------------------------------------------------------------------------- #
# Chat engine WITHOUT a thread store is unchanged (back-compat / default behaviour).
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_chat_engine_no_thread_store_is_noop():
    """The default ChatEngine (threads=None) does NOT persist — preserves the
    offline suite's behaviour exactly."""
    from app.agents.chat import ChatEngine
    from app.audit.audit_log import AuditLogger
    from app.config import Preferences
    from app.llm.gateway import LLMGateway
    from app.stores.cases import CaseStore

    es = InMemoryESClient()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    mp = MockProvider()
    gw = LLMGateway(secrets, None, {"anthropic": mp, "openai": mp, "mock": mp})
    engine = ChatEngine(es, gw, AuditLogger(es), CaseStore(es))  # threads=None default
    # Persistence helper is a clean no-op (no store, no case) and never raises.
    await engine._persist_case_turn(None, "p", "a", Preferences(), author="", cost=0.0)
    await engine._persist_case_turn("c-x", "p", "a", Preferences(), author="", cost=0.0)
