"""Rollback forward compatibility against a REAL PostgreSQL server.

The forward direction of the N to N-1 rollback contract (``test_rollback_forward_compat``
covers the same rules offline): THIS build, booted on a PostgreSQL state store that a
NEWER build wrote, stays healthy. The synthetic future data is exactly what a newer
release introduces:

* a job registry with a record of a kind this build does not know;
* a preferences document with sections and keys this build does not model, a chat
  value above this build's ceiling and a newer migration stamp;
* a runbook corpus written under a newer document-id scheme, with the corpus-migration
  marker that newer build records.

Asserted: no safe-stop; ``/api/health`` and ``/api/health/ready`` answer 200 with no
RAG degradation; the forward job record survives a registry write byte-stable; the
projection replaces the marked corpus instead of refusing it, and later retrievals do
not re-embed; a settings write and a graceful stop keep every unknown preference key.

The JSON, CAS and KV specifics are PostgreSQL's here (SQLite is the offline suite). The
local server may lack pgvector; the vector store then uses its JSON fallback, which is
what these tests need. Without ``POSTGRES_TEST_DB_URL`` (or a postgresql
``STATE_DB_URL``) the module SKIPS. Each test creates and drops its own scratch
database; nothing is written to the database the URL names.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import uuid
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.api.deps import require_auth
from app.api.routes import router
from app.config import Preferences, Secrets
from app.constants import JOBS_KEY, JOBS_NS, RAG_CORPUS_MIGRATION_NS, JobKind
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider, _hash_embed
from app.main import discover_feature_routers
from app.middleware.mutation_admission import MutationAdmissionMiddleware
from app.models import Job, JobProgress, JobTransition
from app.state import AppState
from app.stores.jobs import idempotency_hash
from app.stores.rag_corpus_migration import encode_marker
from app.stores.sql import SqlKVStore, SqlVectorStore, build_async_engine
from app.tools.rag import LEGACY_RUNBOOK_DOCUMENT_PREFIXES, RUNBOOK_DOCUMENT_PREFIX
from app.tools.vectorstore import StoredChunk


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
        "STATE_DB_URL) to run the real-PostgreSQL rollback compatibility tests"
    ),
)

FUTURE_KIND = "a_kind_only_a_newer_build_has"
FOREIGN_SCHEME = "runbook-v2:"
FOREIGN_CHUNKS = 400


@pytest_asyncio.fixture
async def pg_url():
    """The URL of a dedicated scratch database, created and dropped around each test."""
    admin = create_async_engine(POSTGRES_URL, isolation_level="AUTOCOMMIT")
    database = f"tlsoc_rollback_{uuid.uuid4().hex[:16]}"
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{database}"'))
        yield make_url(POSTGRES_URL).set(database=database).render_as_string(hide_password=False)
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
    finally:
        await admin.dispose()


def _secrets(url: str) -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, state_backend="postgres", state_db_url=url,
    )


def _state(url: str) -> AppState:
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    return AppState.create(secrets=_secrets(url), es=InMemoryESClient(), provider_overrides=overrides)


def _client(state: AppState) -> httpx.AsyncClient:
    """The real API surface over ``state``: the mutation admission gate (the boundary a
    safe-stop closes) and every router, as ``app.main`` mounts them."""
    api = FastAPI()
    api.add_middleware(MutationAdmissionMiddleware)
    api.include_router(router, dependencies=[Depends(require_auth)])
    for _name, feature in discover_feature_routers():
        api.include_router(feature, dependencies=[Depends(require_auth)])
    api.state.tlsoc = state
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=api), base_url="http://test")


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _forward_record(job_id: str) -> dict[str, Any]:
    return {
        "job_id": job_id,
        "kind": FUTURE_KIND,
        "actor": "",
        "actor_generation": "",
        "created_at": "2026-11-01T00:00:00+00:00",
        "finished_at": "2026-11-01T00:00:05+00:00",
        "status": "succeeded",
        "request_fingerprint": _hash(f"fp-{job_id}"),
        "idempotency_key_hash": idempotency_hash("", f"key-{job_id}"),
        "params": {"future_param": {"nested": [1, 2, 3]}},
        "a_field_only_a_newer_build_has": "kept",
        "transitions": [{"seq": 1, "name": "submitted", "audited": True}],
    }


def _future_preferences() -> dict[str, Any]:
    doc = Preferences().model_dump(mode="json")
    doc["setup_complete"] = True
    doc["a_section_only_a_newer_build_has"] = {"enabled": True, "level": 3}
    doc["runbooks"]["a_switch_only_a_newer_build_has"] = "on"
    doc["runbooks"]["investigator_guidance"] = False
    doc["runbooks"]["auto_attach"] = False
    doc["chat_agent"]["max_parallel"] = 40
    doc["chat_agent"]["chat_limits_version"] = 3
    # Only the runbook source in the projection, so the retention comparison is the
    # runbook source alone (the realistic mix is covered offline).
    for name in ("use_mitre", "use_suppression_rules", "use_resolved_cases", "use_threat_context"):
        doc["rag"][name] = False
    return doc


def _foreign_chunks() -> list[StoredChunk]:
    model = Preferences().model_for("embedding").model
    out: list[StoredChunk] = []
    for index in range(FOREIGN_CHUNKS):
        body = f"a newer build's runbook passage {index}"
        document_id = f"{FOREIGN_SCHEME}doc-{index // 4}"
        out.append(StoredChunk(
            text=body, source="runbook",
            metadata={"document_id": document_id, "title": "Newer runbook"},
            embedding=_hash_embed(body), embedding_model=model, dim=256,
            doc_id=f"{document_id}:{index % 4}",
        ))
    return out


async def _plant_future_data(url: str) -> dict[str, Any]:
    """Write what a newer build leaves behind, while no application runs."""
    engine = build_async_engine(url)
    try:
        kv = SqlKVStore(engine)
        registry = await kv.get(JOBS_NS, JOBS_KEY) or {"jobs": {}, "idempotency": {}, "factory_fence": ""}
        forward = _forward_record("job-from-a-newer-build")
        registry["jobs"]["job-from-a-newer-build"] = forward
        registry["idempotency"][forward["idempotency_key_hash"]] = "job-from-a-newer-build"
        await kv.put(JOBS_NS, JOBS_KEY, registry)
        await kv.put("config", "preferences", _future_preferences())
        await kv.put(RAG_CORPUS_MIGRATION_NS, "runbook", encode_marker({
            "contract": 2,
            "source": "runbook",
            "scheme": FOREIGN_SCHEME,
            "replaced": [RUNBOOK_DOCUMENT_PREFIX, *LEGACY_RUNBOOK_DOCUMENT_PREFIXES],
            "app_version": "9.9.9",
        }))
        store = SqlVectorStore(engine)
        for document in await store.list_documents():
            if document.get("source") == "runbook":
                await store.delete_document(str(document["document_id"]))
        await store.add(_foreign_chunks())
        return forward
    finally:
        await engine.dispose()


async def _stored(url: str, namespace: str, key: str) -> dict[str, Any] | None:
    engine = build_async_engine(url)
    try:
        return await SqlKVStore(engine).get(namespace, key)
    finally:
        await engine.dispose()


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


async def _first_boot(url: str) -> None:
    """Create the schema and let this build's own startup work (the runbook migration
    and its background projection) finish, so the data planted next is what the
    following boot finds."""
    first = _state(url)
    await first.startup(start_poller=False)
    task = getattr(first, "_runbook_projection_task", None)
    if task is not None:
        await task
    await first.shutdown()


async def test_this_build_booted_on_a_newer_builds_data_stays_healthy(pg_url) -> None:
    # A first boot creates the schema (and this build's own runbook corpus).
    await _first_boot(pg_url)
    forward = await _plant_future_data(pg_url)

    state = _state(pg_url)
    await state.startup(start_poller=False)
    try:
        # R1: no safe-stop; the API answers.
        assert state.mutation_gate.closed is False
        async with _client(state) as client:
            ready = await client.get("/api/health/ready")
            assert ready.status_code == 200 and ready.json()["ready"] is True
            health = await client.get("/api/health")
            assert health.status_code == 200
            assert health.json()["status"] == "ok"

            # A registry write keeps the forward record byte-stable.
            known = Job(
                kind=JobKind.CASE_TAG,
                progress=JobProgress(total=1, unit="cases"),
                request_fingerprint=_hash("known"),
                idempotency_key_hash=idempotency_hash("", "known-key"),
                params={"case_ids": ["case-1"], "tag": "x"},
                item_states={"case-1": "pending"},
                transitions=[JobTransition(seq=1, name="submitted")],
                transition_seq=1,
            )
            await state.job_runner.stop()
            await state.jobs.create(known)
            listed = await client.get("/api/jobs")
            assert listed.status_code == 200
            assert FUTURE_KIND not in json.dumps(listed.json())
            registry = await state.kv.get(JOBS_NS, JOBS_KEY)
            assert _canonical(registry["jobs"]["job-from-a-newer-build"]) == _canonical(forward)

            # R2: the marked newer corpus is replaced, not refused, and never re-embedded.
            calls: list[int] = []
            real = state.rag._gateway.embed_with_provenance

            async def _spy(texts, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
                calls.append(len(texts))
                return await real(texts, *args, **kwargs)

            state.rag._gateway.embed_with_provenance = _spy  # type: ignore[method-assign]
            await state.rag.ensure_seeded()
            assert state.rag.last_refusal is None and state.rag._seeded is True
            runbook_docs = [
                d for d in await state.rag.store.list_documents() if d.get("source") == "runbook"
            ]
            assert runbook_docs
            assert all(str(d["document_id"]).startswith(RUNBOOK_DOCUMENT_PREFIX) for d in runbook_docs)
            assert state.rag.last_projection["runbook"]["migration_replaced"] == FOREIGN_CHUNKS
            embedded = sum(calls)
            for _ in range(3):
                await state.rag.ensure_seeded()
                await state.rag.retrieve("password spray against our accounts")
            assert sum(calls) - embedded <= 3
            health = await client.get("/api/health")
            assert "rag_projection_refused" not in health.json()["degraded_reasons"]

            # R3: the newer build's settings survive a settings write.
            assert state.prefs.runbooks.investigator_guidance is False
            written = await client.put("/api/settings", json={"runbooks": {"fallback": False}})
            assert written.status_code == 200, written.text
    finally:
        await state.shutdown()

    # ... and a graceful stop.
    stored = await _stored(pg_url, "config", "preferences")
    assert stored is not None
    assert stored["a_section_only_a_newer_build_has"] == {"enabled": True, "level": 3}
    assert stored["runbooks"]["a_switch_only_a_newer_build_has"] == "on"
    assert stored["runbooks"]["investigator_guidance"] is False
    assert stored["runbooks"]["auto_attach"] is False
    assert stored["runbooks"]["fallback"] is False
    assert stored["chat_agent"]["max_parallel"] == 40
    assert stored["chat_agent"]["chat_limits_version"] == 3
    marker = await _stored(pg_url, RAG_CORPUS_MIGRATION_NS, "runbook")
    assert marker is not None and FOREIGN_SCHEME in json.dumps(marker)


async def test_a_corrupt_registry_still_fails_closed_on_postgres(pg_url) -> None:
    await _first_boot(pg_url)
    engine = build_async_engine(pg_url)
    try:
        kv = SqlKVStore(engine)
        registry = await kv.get(JOBS_NS, JOBS_KEY) or {"jobs": {}, "idempotency": {}, "factory_fence": ""}
        registry["jobs"]["job-corrupt"] = "not a job"
        await kv.put(JOBS_NS, JOBS_KEY, registry)
    finally:
        await engine.dispose()

    state = _state(pg_url)
    await state.startup(start_poller=False)
    try:
        assert state.mutation_gate.closed is True
    finally:
        await state.shutdown()


async def test_the_forward_record_round_trips_through_a_postgres_cas_write(pg_url) -> None:
    """Store level: the strict CAS write path (``kv_mutate_strict`` over PostgreSQL JSON)
    carries the forward record through unchanged."""
    await _first_boot(pg_url)
    forward = _forward_record("job-forward")
    engine = build_async_engine(pg_url)
    try:
        kv = SqlKVStore(engine)
        await kv.put(JOBS_NS, JOBS_KEY, {
            "jobs": {"job-forward": copy.deepcopy(forward)},
            "idempotency": {forward["idempotency_key_hash"]: "job-forward"},
            "factory_fence": "",
        })
        from app.stores.jobs import JobStore

        store = JobStore(kv)
        assert await store.factory_fence_owner() == ""
        for index in range(3):
            await store.create(Job(
                kind=JobKind.CASE_TAG,
                progress=JobProgress(total=1, unit="cases"),
                request_fingerprint=_hash(f"k{index}"),
                idempotency_key_hash=idempotency_hash("", f"key-{index}"),
                params={"case_ids": ["case-1"], "tag": "x"},
                item_states={"case-1": "pending"},
                transitions=[JobTransition(seq=1, name="submitted")],
                transition_seq=1,
            ))
        doc = await kv.get(JOBS_NS, JOBS_KEY)
        assert _canonical(doc["jobs"]["job-forward"]) == _canonical(forward)
        assert doc["idempotency"][forward["idempotency_key_hash"]] == "job-forward"
        assert len(doc["jobs"]) == 4
    finally:
        await engine.dispose()
