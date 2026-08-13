"""Round 4 / Wave 4 — the tiered operator RESET danger-zone endpoint + engine.

Proves, fully offline (fake ES + mock LLM, no network):

* each tier clears EXACTLY its scoped stores and NOTHING outside its scope;
* a wrong / empty confirm token is rejected 400 (and nothing is cleared);
* ⛔ the airtight rail: **env-provided secrets are byte-identical before/after every
  tier** (the reset engine never reads/writes Secrets; the route only clears the
  in-memory per-source connector bucket at tiers 2/3, never the env scalars);
* a factory reset flips ``setup_complete=False`` (→ fresh OOBE);
* the ``ActionType.RESET`` audit row is written BEFORE the destructive step (#2);
* #1 — the reset only ever touches the mgmt/StateStore side; it never reads the
  read-only log surface / the upstream ``all-logs-*`` key.

The AppState is built with auth OFF so the ``require_admin`` + ``require_fresh_auth``
gates are strict no-ops (the auth-ON gating is exercised by the route-auth-coverage
CI + the auth suite); these tests focus on the RESET SEMANTICS.
"""

from __future__ import annotations

import pytest

from app.config import Secrets, SourceInstance
from app.constants import (
    ActionType,
    CaseStatus,
    EntityType,
    ResetScope,
    SourceSurface,
    SourceType,
)
from app.engine.reset import reset_service
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Cursor, Entity
from app.state import AppState

asyncio = pytest.mark.asyncio


# The env-scalar secrets a reset must NEVER touch (the airtight rail). Set to sentinel
# values so a byte-compare before/after every tier is meaningful.
_ENV_SECRET_FIELDS = (
    "es_api_key",
    "es_mgmt_api_key",
    "openai_api_key",
    "anthropic_api_key",
    "state_db_url",
    "es_url",
    "redis_url",
)


def _secrets() -> Secrets:
    return Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="redis://sentinel:6379/0",
        anthropic_api_key="sk-ant-SENTINEL",
        openai_api_key="sk-oai-SENTINEL",
        es_api_key="ro-key-SENTINEL",
        es_mgmt_api_key="mgmt-key-SENTINEL",
        es_url="https://sentinel:9200",
        state_db_url="postgresql+asyncpg://sentinel/db",
    )


async def _build_state() -> AppState:
    mp = MockProvider()
    overrides = {"anthropic": mp, "openai": mp, "mock": mp}
    state = AppState.create(secrets=_secrets(), es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    await state.update_prefs(prefs)
    return state


def _make_case(cid: str, sig: str) -> Case:
    return Case(
        case_id=cid,
        cluster_signature=sig,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.10"),
        member_event_ids=[f"{cid}-e1"],
        status=CaseStatus.OPEN,
    )


async def _seed_everything(state: AppState) -> None:
    """Seed one row into every store a reset can touch, so a scope assertion is real."""
    await state._real_cases.save(_make_case("c1", "sig:1"))
    await state._real_cases.save(_make_case("c2", "sig:2"))
    # Case-adjacent KV stores (cases tier).
    await state.campaign_store._kv.put("campaigns", "campaigns", {"x": 1})
    await state.baseline_store._kv.put("baseline", "baseline", {"x": 1})
    await state.inbox._kv.put("inbox", "items", {"x": 1})
    await state.case_threads._kv.put("case_thread", "threads", {"x": 1})
    await state.case_activity._kv.put("case_activity", "activity", {"x": 1})
    await state.case_tasks._kv.put("case_tasks", "tasks", {"x": 1})
    await state.batch_job_store._kv.put("batch_jobs", "jobs", {"x": 1})
    # Live-tail rings (cases tier).
    state._real_ingest_service._recent["src-x"] = __import__("collections").deque(["ev"])
    # Cursor + sources (sources tier).
    await state.cursor_store.save(Cursor(timestamp_millis=123, boundary_ids=["e1"]))
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = [
        SourceInstance(id="src-1", source_type=SourceType.ELASTICSEARCH, display_name="ES-1")
    ]
    await state.update_prefs(prefs)
    state.secrets.set_source_secret("src-1", "token", "SECRET-TOKEN")
    # Identity / personalisation KV (factory tier).
    await state.users._kv.put("users", "entries", {"x": 1})
    await state.sessions._kv.put("sessions", "entries", {"x": 1})
    await state.user_prefs._kv.put("user_prefs", "buckets", {"x": 1})
    await state.custom_roles._kv.put("custom_roles", "roles", {"x": 1})
    await state.proposals._kv.put("proposals", "entries", {"x": 1})
    await state.memory._kv.put("memory", "entries", {"x": 1})
    await state.chat_conversations.append_exchange(
        "reset-user",
        conversation_id=None,
        user_content="saved before factory reset",
        assistant_content="durable reply",
        response={"answer": "durable reply"},
    )
    # An audit row (factory tier resets the audit index).
    await state._real_audit.record(
        action_type=ActionType.DECISION, surface="test", actor="seed",
        result_summary="a pre-existing audit row",
    )


async def _seed_factory_control_anchors(state: AppState) -> None:
    """Direct engine tests model the durable Jobs-owned factory boundary.

    Production reaches ``reset_service(factory)`` only after the runner installs
    both strict control documents. The wholesale privacy purge correctly refuses to
    run without them, so legacy engine-level tests seed canonical empty anchors.
    """

    await state.kv.put(
        "jobs",
        "jobs",
        {"jobs": {}, "idempotency": {}, "factory_fence": ""},
    )


async def _reset_direct(state: AppState, scope: ResetScope):
    if scope == ResetScope.FACTORY:
        await _seed_factory_control_anchors(state)
    return await reset_service(state, scope)
    await state.kv.put(
        "batch_jobs",
        "jobs",
        {"jobs": {}, "factory_fence": "", "reset_epoch": 0},
    )


async def _kv_nonempty(kv, ns: str, key: str) -> bool:
    doc = await kv.get(ns, key)
    if not doc:
        return False
    # Revision and Batch reset-fence metadata are bookkeeping. A cleared Batch
    # registry intentionally retains its epoch so stale cross-process mutators fail.
    ignored = {"_rev", "factory_fence", "reset_epoch"}
    return any(
        key not in ignored and not (key == "jobs" and value == {})
        for key, value in doc.items()
    )


async def _case_count(state: AppState) -> int:
    _cases, total = await state._real_cases.list(limit=1000)
    return total


def _snapshot_env_secrets(state: AppState) -> dict:
    return {f: getattr(state.secrets, f) for f in _ENV_SECRET_FIELDS}


# --------------------------------------------------------------------------- #
# Scope semantics — each tier clears exactly its scope.
# --------------------------------------------------------------------------- #
@asyncio
async def test_cases_tier_clears_only_cases_scope():
    state = await _build_state()
    try:
        await _seed_everything(state)
        result = await reset_service(state, ResetScope.CASES)

        # Cleared: cases + case-adjacent KV + live-tail rings.
        assert await _case_count(state) == 0
        for ns, key in (
            ("campaigns", "campaigns"), ("baseline", "baseline"),
            ("case_thread", "threads"), ("case_activity", "activity"),
            ("case_tasks", "tasks"),
        ):
            assert not await _kv_nonempty(state._kv, ns, key), f"{ns} should be cleared"
        batch_doc = await state._kv.get("batch_jobs", "jobs")
        assert (batch_doc or {}).get("jobs") == {}
        assert int((batch_doc or {}).get("reset_epoch", 0)) >= 1
        assert not (batch_doc or {}).get("factory_fence")
        # The cases tier preserves durable operator-Job Inbox projections. This seed
        # contains no valid Job notification, so the canonical bucket map is empty.
        inbox_doc = await state._kv.get("inbox", "items")
        assert (inbox_doc or {}).get("items", {}) == {}
        assert state._real_ingest_service._recent == {}

        # KEPT: sources, settings, users, cursors, memory, proposals, audit.
        assert len(state.prefs.sources) == 1
        assert state.prefs.setup_complete is True
        assert await _kv_nonempty(state._kv, "users", "entries")
        assert await _kv_nonempty(state._kv, "memory", "entries")
        assert await _kv_nonempty(state._kv, "proposals", "entries")
        cursor = await state.cursor_store.load()
        assert cursor.timestamp_millis == 123
        audit = await state._real_audit.records(limit=50)
        assert any(r.get("surface") == "test" for r in audit), "seed audit row must survive"

        assert result["scope"] == "cases"
        assert "cases:2" in result["cleared"]
    finally:
        await state.shutdown()


@asyncio
async def test_cases_reset_clears_noise_reduction_counters_and_baseline():
    """A cases-scope reset drops the durable Noise-Reduction ingest counters (+ the
    anomaly baseline) so the funnel stops over-reporting inbound volume from a purged
    period. Both are advisory (#3-safe) and cleared at the cases tier."""
    state = await _build_state()
    try:
        # Seed the durable per-hour ingest counters + an anomaly-baseline sketch.
        await state.noise_counters.record(
            {"ingested": {"critical": 3, "high": 2}, "clustered": {"critical": 1},
             "suppressed": 1, "ignored": 0}
        )
        seeded = await state.noise_counters.read_window(0)
        assert seeded["available"] is True
        assert sum(seeded["ingested"].values()) == 5
        await state.baseline_store._kv.put("baseline", "baseline", {"x": 1})

        await reset_service(state, ResetScope.CASES)

        # The funnel counters are EMPTY after a cases-scope reset — no stale inbound volume.
        cleared = await state.noise_counters.read_window(0)
        assert cleared["available"] is False
        assert sum(cleared["ingested"].values()) == 0
        assert not await _kv_nonempty(state._kv, "noise_counters", "noise_counters")
        # ...and the anomaly baseline is cleared too (case-tier KV clear).
        assert not await _kv_nonempty(state._kv, "baseline", "baseline")
    finally:
        await state.shutdown()


@asyncio
async def test_sources_tier_clears_cases_plus_sources_and_cursors():
    state = await _build_state()
    try:
        await _seed_everything(state)
        await reset_service(state, ResetScope.SOURCES)

        # Cleared: cases (tier-1) + sources + cursors.
        assert await _case_count(state) == 0
        assert state.prefs.sources == []
        cursor = await state.cursor_store.load()
        assert cursor.timestamp_millis == 0  # cold cursor

        # KEPT: users, settings (setup flag), memory, proposals, audit.
        assert state.prefs.setup_complete is True
        assert await _kv_nonempty(state._kv, "users", "entries")
        assert await _kv_nonempty(state._kv, "memory", "entries")
        audit = await state._real_audit.records(limit=50)
        assert any(r.get("surface") == "test" for r in audit), "seed audit row must survive"
    finally:
        await state.shutdown()


@asyncio
async def test_factory_tier_clears_everything_and_flips_setup_complete():
    state = await _build_state()
    try:
        await _seed_everything(state)
        await _seed_factory_control_anchors(state)
        # Give branding a non-default value to prove factory drops it.
        prefs = state.prefs.model_copy(deep=True)
        prefs.branding.org_name = "AcmeCorp"
        await state.update_prefs(prefs)

        await reset_service(state, ResetScope.FACTORY)

        # Cleared: cases + sources + cursors + identity KV + branding + prefs→defaults.
        assert await _case_count(state) == 0
        assert state.prefs.sources == []
        assert state.prefs.setup_complete is False  # → fresh OOBE
        assert state.prefs.branding.org_name == "Agentic SOC"  # back to the shipped default
        for ns, key in (
            ("users", "entries"), ("sessions", "entries"), ("user_prefs", "buckets"),
            ("custom_roles", "roles"), ("proposals", "entries"), ("memory", "entries"),
        ):
            assert not await _kv_nonempty(state._kv, ns, key), f"{ns} should be cleared"
        chat_page = await state.chat_conversations.list_page("reset-user")
        assert chat_page.total == 0, "Workspace chat history should be cleared"

        # Audit index reset at the factory tier — the seed row is gone.
        audit = await state._real_audit.records(limit=50)
        assert not any(r.get("surface") == "test" for r in audit), "audit must be reset at factory"
    finally:
        await state.shutdown()


@asyncio
async def test_factory_privacy_clear_failure_does_not_open_oobe_or_erase_audit(monkeypatch):
    state = await _build_state()
    try:
        await _seed_everything(state)
        await _seed_factory_control_anchors(state)

        async def fail_factory_purge():
            raise RuntimeError("injected identity-store outage")

        monkeypatch.setattr(state.kv, "factory_purge_strict", fail_factory_purge)
        result = await reset_service(state, ResetScope.FACTORY)

        assert result["privacy_boundary_confirmed"] is False
        assert "kv:tenant" in result["failed"]
        assert "audit" not in result["attempted"]
        assert "preferences" not in result["attempted"]
        assert state.prefs.setup_complete is True
        rows = await state._real_audit.records(limit=50)
        assert any(row.get("surface") == "test" for row in rows)
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# ⛔ Airtight rail: env secrets are byte-identical before/after EVERY tier.
# --------------------------------------------------------------------------- #
@asyncio
@pytest.mark.parametrize("scope", [ResetScope.CASES, ResetScope.SOURCES, ResetScope.FACTORY])
async def test_env_secrets_byte_identical_across_every_tier(scope):
    state = await _build_state()
    try:
        await _seed_everything(state)
        if scope == ResetScope.FACTORY:
            await _seed_factory_control_anchors(state)
        before = _snapshot_env_secrets(state)
        # The full Secrets object dump too (belt-and-braces: no field mutates except the
        # in-memory per-source connector bucket the ROUTE clears — the ENGINE never
        # touches Secrets at all).
        before_full = state.secrets.model_dump()

        await reset_service(state, scope)

        after = _snapshot_env_secrets(state)
        after_full = state.secrets.model_dump()
        assert after == before, f"env scalar secrets changed at tier {scope.value}: {before} != {after}"
        # The reset ENGINE must leave the ENTIRE Secrets object untouched (the route,
        # not the engine, clears connector_secrets at tiers 2/3).
        assert after_full == before_full, f"Secrets object mutated by the reset engine at {scope.value}"
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# The ActionType.RESET audit is written BEFORE acting (#2) — exercised via the ROUTE
# (the engine is audit-free; the route owns the audit-before-acting contract).
# --------------------------------------------------------------------------- #
def _client(state: AppState):
    from contextlib import asynccontextmanager

    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes_reset import router

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.tlsoc = state
        yield

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


@asyncio
async def test_legacy_reset_route_requires_a_durable_job_and_does_not_mutate():
    state = await _build_state()
    try:
        await _seed_everything(state)
        await _seed_factory_control_anchors(state)
        with _client(state) as c:
            resp = c.post("/api/admin/reset", json={"scope": "cases", "confirm": "RESET CASES"})
        assert resp.status_code == 410, resp.text
        assert resp.json()["detail"]["code"] == "durable_job_required"
        assert await _case_count(state) == 2
        rows = await state._real_audit.records(action_type=ActionType.RESET.value, limit=50)
        assert not rows, "the disabled legacy route must not record a fake reset action"
    finally:
        await state.shutdown()


@asyncio
async def test_legacy_reset_route_cannot_clear_connector_secrets():
    state = await _build_state()
    try:
        await _seed_everything(state)
        await _seed_factory_control_anchors(state)
        assert state.secrets.source_secrets("src-1") == {"token": "SECRET-TOKEN"}
        env_before = _snapshot_env_secrets(state)

        with _client(state) as c:
            r1 = c.post("/api/admin/reset", json={"scope": "cases", "confirm": "RESET CASES"})
            assert r1.status_code == 410, r1.text
        assert state.secrets.source_secrets("src-1") == {"token": "SECRET-TOKEN"}

        with _client(state) as c:
            r2 = c.post("/api/admin/reset", json={"scope": "sources", "confirm": "RESET SOURCES"})
            assert r2.status_code == 410, r2.text
        assert state.secrets.source_secrets("src-1") == {"token": "SECRET-TOKEN"}
        assert _snapshot_env_secrets(state) == env_before
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# Wrong / empty confirm token → 400, nothing cleared.
# --------------------------------------------------------------------------- #
@asyncio
@pytest.mark.parametrize(
    "scope,confirm",
    [
        ("cases", "reset cases"),        # wrong case
        ("cases", "RESET SOURCES"),      # right phrase, wrong scope
        ("sources", ""),                 # empty
        ("factory", "FACTORY"),          # partial
        ("bogus", "FACTORY RESET"),      # invalid scope
    ],
)
async def test_legacy_reset_route_is_gone_regardless_of_body(scope, confirm):
    state = await _build_state()
    try:
        await _seed_everything(state)
        before = await _case_count(state)
        with _client(state) as c:
            resp = c.post("/api/admin/reset", json={"scope": scope, "confirm": confirm})
        assert resp.status_code == 410, resp.text
        # Nothing was cleared — cases survive.
        assert await _case_count(state) == before
        # No RESET audit row was written (validation failed before the audit step).
        rows = await state._real_audit.records(action_type=ActionType.RESET.value, limit=50)
        assert not rows, "a rejected reset must not write a RESET audit row"
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# #1 — the reset never reads the read-only log surface / upstream all-logs-*.
# --------------------------------------------------------------------------- #
@asyncio
async def test_reset_never_touches_the_readonly_log_surface():
    state = await _build_state()
    try:
        # Seed a log doc into the read-only surface (what upstream would have written).
        state.es.add_log("all-logs-2026.07.01", {"message": "an upstream log"}, doc_id="log-1")
        await _seed_everything(state)
        await _seed_factory_control_anchors(state)

        await reset_service(state, ResetScope.FACTORY)

        # The upstream log doc is UNTOUCHED — reset only operates on tlsoc-agent-* state.
        assert state.es.docs.get("all-logs-2026.07.01", {}).get("log-1") is not None
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# SQL state backend — the ``_sql_delete_all`` branch (cases/audit table truncate +
# cursor KV-row delete). Proves the backend-dispatched clears + the airtight secret
# rail hold on SQLite too (asyncpg/pgvector are lazily imported → SQLite needs neither).
# --------------------------------------------------------------------------- #
async def _build_sql_state(tmp_path):
    import os
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".db", dir=str(tmp_path))
    os.close(fd)
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="redis://sentinel:6379/0",
        anthropic_api_key="sk-ant-SENTINEL", openai_api_key="sk-oai-SENTINEL",
        es_api_key="ro-key-SENTINEL", es_mgmt_api_key="mgmt-key-SENTINEL",
        es_url="https://sentinel:9200",
        state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{path}",
    )
    mp = MockProvider()
    overrides = {"anthropic": mp, "openai": mp, "mock": mp}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    return state


@asyncio
async def test_sql_backend_factory_reset_truncates_tables_and_preserves_env_secrets(tmp_path):
    state = await _build_sql_state(tmp_path)
    try:
        await _seed_everything(state)
        await _seed_factory_control_anchors(state)
        before = _snapshot_env_secrets(state)
        assert await _case_count(state) == 2

        await reset_service(state, ResetScope.FACTORY)

        # SQL cases + audit truncated; cursor KV rows + identity KV cleared.
        assert await _case_count(state) == 0
        cursor = await state.cursor_store.load()
        assert cursor.timestamp_millis == 0
        for ns, key in (("users", "entries"), ("memory", "entries"), ("proposals", "entries")):
            assert not await _kv_nonempty(state._kv, ns, key), f"{ns} should be cleared"
        chat_page = await state.chat_conversations.list_page("reset-user")
        assert chat_page.total == 0, "Workspace chat history should be cleared"
        assert state.prefs.setup_complete is False
        audit = await state._real_audit.records(limit=50)
        assert not any(r.get("surface") == "test" for r in audit), "SQL audit must reset at factory"

        # ⛔ env scalar secrets byte-identical (incl. STATE_DB_URL — never rewritten).
        assert _snapshot_env_secrets(state) == before
    finally:
        await state.shutdown()
