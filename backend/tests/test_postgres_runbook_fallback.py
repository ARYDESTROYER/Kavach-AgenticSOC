"""The Generic incident fallback on a REAL PostgreSQL state store, read as an operator reads it.

The operator checklist for the fallback fix reads the PostgreSQL ``audit`` and ``kv``
tables with JSON operators. This proves, on PostgreSQL, what those reads show after
one investigation that only the fallback matches and one that a specific built-in
matches:

* the ``runbook.selected`` row names ``generic-incident`` with ``runbook_status``
  ``fallback`` and ``used`` false, and the specific match names its runbook with
  ``matched``, ``used`` true and tier 3;
* the fallback investigation's ``procedure_provenance`` row has only the ``cluster``
  retrieval group (no ``runbook:1..n``), and the specific one has its runbook groups;
* the stored ``runbooks`` preference block keeps exactly the keys it had: the fix adds
  no preference key (an older build would drop it).

The local server may lack pgvector; the vector store then uses its JSON fallback. Without
``POSTGRES_TEST_DB_URL`` (or a postgresql ``STATE_DB_URL``) the module SKIPS. Each test
creates and drops its own scratch database; nothing is written to the database the URL
names.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import RunbookConfig, Secrets
from app.constants import EntityType, SourceSurface
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from tests.conftest import make_raw_event


def _configured_postgres_url() -> str:
    for name in ("POSTGRES_TEST_DB_URL", "STATE_DB_URL"):
        candidate = (os.environ.get(name) or "").strip()
        if candidate.startswith("postgresql"):
            return candidate
    return ""


POSTGRES_URL = _configured_postgres_url()

pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason=(
        "no PostgreSQL configured; set POSTGRES_TEST_DB_URL (or a postgresql "
        "STATE_DB_URL) to run the real-PostgreSQL runbook fallback tests"
    ),
)


@pytest_asyncio.fixture
async def pg_url():
    """The URL of a dedicated scratch database, created and dropped around each test."""
    admin = create_async_engine(POSTGRES_URL, isolation_level="AUTOCOMMIT")
    database = f"tlsoc_fallback_{uuid.uuid4().hex[:16]}"
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{database}"'))
        yield make_url(POSTGRES_URL).set(database=database).render_as_string(hide_password=False)
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
    finally:
        await admin.dispose()


def _cluster(rule: str, ip: str):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"{rule}-e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000) for i in range(5)]
    return cluster_from_events(EntityType.IP, ip, events)


def _script(mock: MockProvider) -> None:
    mock.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {"verdict": "NEEDS_HUMAN", "confidence": 0.3, "evidence": [], "mitre": [],
                    "recommended_action": "review", "reproduce_query": ""},
    }))


async def test_the_operator_checklist_reads_show_the_fallback_was_not_given(pg_url) -> None:
    mock = MockProvider()
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, state_backend="postgres", state_db_url=pg_url,
    )
    state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    await state.startup(start_poller=False)
    try:
        task = getattr(state, "_runbook_projection_task", None)
        if task is not None and not task.done():
            await asyncio.wait_for(asyncio.shield(task), timeout=60)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        _script(mock)
        fallback = await state.pipeline.investigate_cluster(
            _cluster("lms_ajax_service_call", "198.51.100.11"), SourceSurface.INVESTIGATE, state.prefs,
        )
        _script(mock)
        specific = await state.pipeline.investigate_cluster(
            _cluster("mail_auth", "198.51.100.81"), SourceSurface.INVESTIGATE, state.prefs,
        )
    finally:
        await state.shutdown()

    engine = create_async_engine(pg_url)
    try:
        async with engine.connect() as conn:
            # Checklist step 2, as the operator runs it (without the time window).
            selected = (await conn.execute(text(
                "select doc->>'case_id', doc->'tool_input'->'runbook_selection'->>'id', "
                "doc->'tool_input'->>'runbook_status', "
                "doc->'tool_input'->'runbook_selection'->>'used', "
                "doc->'tool_input'->'runbook_selection'->>'tier' "
                "from audit where (doc->>'action') = 'runbook.selected'"
            ))).all()
            groups = (await conn.execute(text(
                "select doc->>'case_id', doc->'tool_input'->'retrieval_query_groups' "
                "from audit where (doc->>'actor') = 'procedure_provenance'"
            ))).all()
            # Checklist step 1: the served runbooks preference block.
            stored = (await conn.execute(text(
                "select value::text from kv where namespace = 'config' and key = 'preferences'"
            ))).scalar_one()
    finally:
        await engine.dispose()

    by_case = {row[0]: tuple(row[1:]) for row in selected}
    assert by_case[fallback.case_id] == ("generic-incident", "fallback", "false", "0")
    assert by_case[specific.case_id] == ("brute-force-password-spray", "matched", "true", "3")

    group_names = {}
    for case_id, raw in groups:
        value = json.loads(raw) if isinstance(raw, str) else raw
        group_names[case_id] = [g["group"] for g in value]
    assert group_names[fallback.case_id] == ["cluster"]
    assert group_names[specific.case_id][0] == "cluster" and len(group_names[specific.case_id]) > 1
    assert all(g.startswith("runbook:") for g in group_names[specific.case_id][1:])

    runbooks = json.loads(stored)["runbooks"]
    assert set(runbooks) == set(RunbookConfig.model_fields)
    assert runbooks["investigator_guidance"] is True and runbooks["fallback"] is True
