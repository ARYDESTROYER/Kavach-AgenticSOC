"""Rollback forward compatibility: this build tolerates and preserves what a newer build
wrote (the N to N-1 step of an image-only rollback).

Offline (fake ES, SQLite, mock LLM, local hash embeddings). Three contracts:

* R1, the job registry: a well-formed record of a kind this build does not know is a
  FORWARD record. It is carried byte-stable through every registry write, never run or
  listed, counted toward capacity and pruned like any other terminal row; startup never
  enters safe-stop because of it. A corrupt record still fails closed.
* R2, the RAG projection guard: a corpus-migration marker makes another build's
  deliberate id scheme for a source an expected state (in either direction), so the
  projection replaces it instead of refusing at the retention floor and re-embedding on
  every retrieval. Without a marker a real shrink still refuses, and a zero projection
  is refused whatever the marker says.
* R3, preferences: a save keeps keys this build does not model (top level and nested)
  and stored values it only clamped for its own use, never resurrects a key it retired,
  and an unknown key never fails validation.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
from typing import Any

import pytest
from pydantic import BaseModel, Field, model_validator

from app.config import Preferences, Secrets
from app.constants import JOBS_KEY, JOBS_NS, RAG_CORPUS_MIGRATION_NS, JobKind, JobStatus
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import MockProvider, _hash_embed
from app.models import Job, JobProgress, JobTransition
from app.preferences_roundtrip import CONSUMED_PREFERENCE_KEYS, preferences_document
from app.rbac.policy import RBAC_GRANTS_VERSION
from app.state import AppState
from app.stores import jobs as jobs_module
from app.stores.config_store import ConfigStore
from app.stores.jobs import JobCapacityError, JobConflict, JobStore, idempotency_hash
from app.stores.memory import EsKVStore
from app.stores.rag_corpus_migration import (
    MARKER_FIELD,
    RagCorpusMigrationStore,
    decode_marker,
    encode_marker,
    scheme_of,
)
from app.stores.runbook_library import RunbookLibraryStore
from app.stores.usage import UsageStore
from app.tools.rag import (
    LEGACY_RUNBOOK_DOCUMENT_PREFIXES,
    REFUSAL_EMPTY_PROJECTION,
    REFUSAL_RETENTION_FLOOR,
    RUNBOOK_DOCUMENT_PREFIX,
    ProjectionCollapsed,
    RagService,
)
from app.tools.vectorstore import StoredChunk

FUTURE_KIND = "future_kind_from_a_newer_build"


# --------------------------------------------------------------------------- #
# R1: the job registry
# --------------------------------------------------------------------------- #
def _hash(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode()).hexdigest()


def _known_job(key: str = "known-key", *, actor: str = "") -> Job:
    return Job(
        kind=JobKind.CASE_TAG,
        actor=actor,
        progress=JobProgress(total=1, unit="cases"),
        request_fingerprint=_hash(f"fingerprint-{key}"),
        idempotency_key_hash=idempotency_hash(actor, key),
        params={"case_ids": ["case-1"], "tag": "triaged"},
        item_states={"case-1": "pending"},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )


def _forward_record(
    job_id: str,
    *,
    status: str = "succeeded",
    created_at: str = "2026-01-01T00:00:00+00:00",
    finished_at: str | None = "2026-01-01T00:01:00+00:00",
    actor: str = "",
    key: str | None = None,
    artifact_id: str | None = None,
) -> dict[str, Any]:
    """A job record exactly as a NEWER build would write it: an unknown kind, plus a
    field and a status vocabulary this build has never seen."""
    record: dict[str, Any] = {
        "job_id": job_id,
        "kind": FUTURE_KIND,
        "actor": actor,
        "actor_generation": "",
        "created_at": created_at,
        "finished_at": finished_at,
        "status": status,
        "request_fingerprint": _hash(f"fp-{job_id}"),
        "idempotency_key_hash": idempotency_hash(actor, key or f"key-{job_id}"),
        "params": {"future_param": [1, 2, 3], "nested": {"deep": "value"}},
        "a_field_only_the_newer_build_has": {"x": 1},
        "transitions": [{"seq": 1, "name": "submitted", "audited": True}],
    }
    if artifact_id:
        record["artifact"] = {
            "artifact_id": artifact_id,
            "filename": "future.zip",
            "content_type": "application/zip",
            "size": 1,
            "sha256": "0" * 64,
            "created_at": created_at,
        }
    return record


async def _plant(kv: EsKVStore, rows: dict[str, dict[str, Any]], *, keys: dict[str, str] | None = None) -> None:
    await kv.put_strict(
        JOBS_NS,
        JOBS_KEY,
        {
            "jobs": rows,
            "idempotency": keys if keys is not None else {
                str(row.get("idempotency_key_hash")): job_id
                for job_id, row in rows.items()
                if isinstance(row, dict) and row.get("idempotency_key_hash")
            },
            "factory_fence": "",
        },
    )


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


async def test_a_forward_record_loads_and_survives_every_registry_write_byte_stable() -> None:
    kv = EsKVStore(InMemoryESClient())
    forward = _forward_record("job-forward-1", status="queued", finished_at=None)
    original = copy.deepcopy(forward)
    await _plant(kv, {"job-forward-1": forward})
    store = JobStore(kv)

    # Reads tolerate it and never surface it.
    assert await store.list_for_actor("") == []
    assert await store.get("job-forward-1") is None
    assert await store.factory_fence_owner() == ""
    # A queued forward record is never claimed: this build cannot run it.
    assert await store.claim_next("worker", lease_millis=30_000) is None

    # Writes of every kind carry it through untouched.
    created, is_new, _ = await store.create(_known_job())
    assert is_new
    claimed = await store.claim_next("worker", lease_millis=30_000)
    assert claimed is not None and claimed[0].job_id == created.job_id
    job, token = claimed
    await store.begin_item(job.job_id, token, "case-1")
    await store.complete_item(job.job_id, token, "case-1")
    await store.finish(job.job_id, token, JobStatus.SUCCEEDED)
    await store.mark_all_transitions_unaudited()

    doc = await kv.get_strict(JOBS_NS, JOBS_KEY)
    assert _canonical(doc["jobs"]["job-forward-1"]) == _canonical(original)
    assert doc["idempotency"][original["idempotency_key_hash"]] == "job-forward-1"
    assert [row.job_id for row in await store.list_for_actor("")] == [created.job_id]


async def test_a_corrupt_record_still_fails_closed() -> None:
    corrupt_rows: list[Any] = [
        "not an object",
        {"job_id": "job-x", "kind": "case_tag", "status": "queued"},  # known kind, invalid job
        {"job_id": "job-x", "kind": FUTURE_KIND, "created_at": "2026-01-01T00:00:00Z"},  # no status
        {"job_id": "other-id", "kind": FUTURE_KIND, "status": "queued",
         "created_at": "2026-01-01T00:00:00Z"},  # id does not match its registry key
        {"job_id": "job-x", "kind": FUTURE_KIND, "status": "queued",
         "created_at": "2026-01-01T00:00:00Z", "params": "not an object"},
    ]
    for row in corrupt_rows:
        kv = EsKVStore(InMemoryESClient())
        await _plant(kv, {"job-x": row}, keys={})
        store = JobStore(kv)
        with pytest.raises(ValueError, match="invalid record"):
            await store.list_for_actor("")
        with pytest.raises(ValueError, match="invalid record"):
            await store.factory_fence_owner()
        with pytest.raises(ValueError, match="invalid record"):
            await store.create(_known_job())
    kv = EsKVStore(InMemoryESClient())
    await kv.put_strict(JOBS_NS, JOBS_KEY, {"jobs": ["not", "a", "map"], "idempotency": {}})
    with pytest.raises(ValueError, match="invalid record"):
        await JobStore(kv).factory_fence_owner()


async def test_a_terminal_forward_record_is_pruned_like_any_terminal_row(monkeypatch) -> None:
    monkeypatch.setattr(jobs_module, "MAX_JOBS", 3)
    kv = EsKVStore(InMemoryESClient())
    rows = {
        "job-old-forward": _forward_record(
            "job-old-forward", created_at="2026-01-01T00:00:00+00:00",
            finished_at="2026-01-01T00:00:01+00:00", artifact_id="a" * 32,
        ),
        "job-new-forward": _forward_record(
            "job-new-forward", created_at="2026-02-01T00:00:00+00:00",
            finished_at="2026-02-01T00:00:01+00:00",
        ),
        "job-active-forward": _forward_record(
            "job-active-forward", status="a_status_this_build_does_not_know", finished_at=None,
        ),
    }
    await _plant(kv, rows)
    store = JobStore(kv)
    created, is_new, pruned = await store.create(_known_job())
    assert is_new
    doc = await kv.get_strict(JOBS_NS, JOBS_KEY)
    # The oldest terminal row went, whatever its kind; its binding and artifact too.
    assert "job-old-forward" not in doc["jobs"]
    assert rows["job-old-forward"]["idempotency_key_hash"] not in doc["idempotency"]
    assert [artifact.artifact_id for artifact in pruned] == ["a" * 32]
    # A status this build does not know is never assumed finished: never pruned.
    assert {"job-new-forward", "job-active-forward", created.job_id} == set(doc["jobs"])


async def test_forward_records_count_toward_capacity(monkeypatch) -> None:
    monkeypatch.setattr(jobs_module, "MAX_JOBS", 2)
    kv = EsKVStore(InMemoryESClient())
    await _plant(kv, {
        "job-a": _forward_record("job-a", status="running", finished_at=None),
        "job-b": _forward_record("job-b", status="queued", finished_at=None),
    })
    with pytest.raises(JobCapacityError):
        await JobStore(kv).create(_known_job())


async def test_an_idempotency_key_bound_to_a_forward_record_is_a_conflict() -> None:
    kv = EsKVStore(InMemoryESClient())
    forward = _forward_record("job-forward", key="shared-key")
    await _plant(kv, {"job-forward": forward})
    with pytest.raises(JobConflict):
        await JobStore(kv).create(_known_job("shared-key"))


async def test_forward_artifacts_are_protected_and_compaction_and_retirement_honour_them() -> None:
    kv = EsKVStore(InMemoryESClient())
    await _plant(kv, {
        "job-mine-done": _forward_record("job-mine-done", actor="alice", artifact_id="b" * 32),
        "job-mine-active": _forward_record(
            "job-mine-active", actor="alice", status="running", finished_at=None,
        ),
        "job-theirs": _forward_record("job-theirs", actor="bob", artifact_id="c" * 32),
    })
    store = JobStore(kv)
    # The orphan sweep never deletes a newer build's file.
    assert {"b" * 32, "c" * 32} <= await store.protected_artifact_ids()
    assert {"b" * 32, "c" * 32} <= await store.artifact_ids()
    # Deleting an account purges its terminal forward rows; an active one stays.
    artifacts, removed = await store.retire_actor("alice", "")
    assert removed == 1 and [a.artifact_id for a in artifacts] == ["b" * 32]
    doc = await kv.get_strict(JOBS_NS, JOBS_KEY)
    assert set(doc["jobs"]) == {"job-mine-active", "job-theirs"}


async def test_a_factory_compaction_clears_forward_records() -> None:
    kv = EsKVStore(InMemoryESClient())
    await _plant(kv, {"job-theirs": _forward_record("job-theirs", artifact_id="d" * 32)})
    store = JobStore(kv)
    reset = Job(
        kind=JobKind.TIERED_RESET,
        actor="admin",
        progress=JobProgress(total=1, unit="reset"),
        request_fingerprint=_hash("reset"),
        idempotency_key_hash=idempotency_hash("admin", "reset-key"),
        params={"scope": "factory", "confirm": "FACTORY RESET"},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )
    await store.create(reset)
    claimed = await store.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    job, token = claimed
    await store.begin_factory_fence(job.job_id, token)
    from app.models import JobResult

    receipt, artifacts = await store.factory_compact(
        job.job_id, token, status=JobStatus.SUCCEEDED,
        result=JobResult(kind="tiered_reset", counts={"attempted": 1, "cleared": 1, "failed": 0}),
        app_version="0.1.13", build_sha="unknown",
    )
    doc = await kv.get_strict(JOBS_NS, JOBS_KEY)
    assert set(doc["jobs"]) == {receipt.job_id}
    assert "d" * 32 in {a.artifact_id for a in artifacts}


async def test_a_fence_owned_by_a_forward_row_is_still_a_fence() -> None:
    kv = EsKVStore(InMemoryESClient())
    await kv.put_strict(JOBS_NS, JOBS_KEY, {
        "jobs": {"job-f": _forward_record("job-f", status="running", finished_at=None)},
        "idempotency": {},
        "factory_fence": "job-f",
    })
    assert await JobStore(kv).factory_fence_owner() == "job-f"


def _sql_secrets(path: str) -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{path}",
    )


async def _plant_sql(path: str, namespace: str, key: str, value: dict[str, Any]) -> None:
    """Write one KV document while no application runs (as another build left it)."""
    from app.stores.sql import SqlKVStore, build_async_engine

    engine = build_async_engine(f"sqlite+aiosqlite:///{path}")
    try:
        await SqlKVStore(engine).put(namespace, key, value)
    finally:
        await engine.dispose()


async def test_startup_on_a_registry_with_a_forward_record_does_not_enter_safe_stop() -> None:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    try:
        first = AppState.create(secrets=_sql_secrets(path), es=InMemoryESClient(), provider_overrides=overrides)
        await first.startup(start_poller=False)
        doc = await first.kv.get(JOBS_NS, JOBS_KEY) or {"jobs": {}, "idempotency": {}, "factory_fence": ""}
        await first.shutdown()
        forward = _forward_record("job-from-newer-build")
        doc["jobs"]["job-from-newer-build"] = forward
        doc["idempotency"][forward["idempotency_key_hash"]] = "job-from-newer-build"
        await _plant_sql(path, JOBS_NS, JOBS_KEY, doc)

        second = AppState.create(secrets=_sql_secrets(path), es=InMemoryESClient(), provider_overrides=overrides)
        await second.startup(start_poller=False)
        try:
            assert second.mutation_gate.closed is False
            assert second.mutation_gate.degraded is False
            stored = await second.kv.get(JOBS_NS, JOBS_KEY)
            assert _canonical(stored["jobs"]["job-from-newer-build"]) == _canonical(forward)
        finally:
            await second.shutdown()
    finally:
        os.remove(path)


# --------------------------------------------------------------------------- #
# R2: corpus-migration markers and the projection guard
# --------------------------------------------------------------------------- #
def _gateway() -> LLMGateway:
    mock = MockProvider()
    return LLMGateway(Secrets(_env_file=None), UsageStore(InMemoryESClient()),
                      provider_overrides={"openai": mock, "mock": mock})


def _runbook_only_prefs() -> Preferences:
    prefs = Preferences()
    prefs.rag.use_mitre = False
    prefs.rag.use_suppression_rules = False
    prefs.rag.use_resolved_cases = False
    prefs.rag.use_threat_context = False
    return prefs


def _chunks(prefs: Preferences, prefix: str, count: int) -> list[StoredChunk]:
    out: list[StoredChunk] = []
    for index in range(count):
        text = f"stored runbook passage {prefix} {index}"
        document_id = f"{prefix}doc-{index // 4}"
        out.append(StoredChunk(
            text=text, source="runbook",
            metadata={"document_id": document_id, "title": "Stored runbook"},
            embedding=_hash_embed(text), embedding_model=prefs.model_for("embedding").model,
            dim=256, doc_id=f"{document_id}:{index % 4}",
        ))
    return out


async def _service(prefs: Preferences, kv: EsKVStore) -> RagService:
    return RagService(
        _gateway(), prefs,
        library=RunbookLibraryStore(EsKVStore(InMemoryESClient())),
        corpus_migrations=RagCorpusMigrationStore(kv),
    )


def _embed_spy(rag: RagService) -> list[int]:
    calls: list[int] = []
    real = rag._gateway.embed_with_provenance

    async def _spy(texts, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        calls.append(len(texts))
        return await real(texts, *args, **kwargs)

    rag._gateway.embed_with_provenance = _spy  # type: ignore[method-assign]
    return calls


async def test_without_a_marker_a_real_shrink_still_refuses() -> None:
    prefs = _runbook_only_prefs()
    rag = await _service(prefs, EsKVStore(InMemoryESClient()))
    await rag._store.add(_chunks(prefs, "runbook-v2:", 400))
    await rag.ensure_seeded()
    assert rag._seeded is False
    assert rag.last_refusal is not None
    assert await rag._store.count() == 400  # the corpus was preserved


async def test_a_marked_newer_corpus_is_replaced_not_refused_and_never_re_embedded() -> None:
    """The rollback direction: a newer build migrated the runbook source to a scheme
    this build does not write, and recorded it. This build replaces that source with
    its own projection once and then serves it."""
    prefs = _runbook_only_prefs()
    kv = EsKVStore(InMemoryESClient())
    await kv.put(RAG_CORPUS_MIGRATION_NS, "runbook", encode_marker({
        "contract": 2,  # a newer contract: unknown fields are ignored
        "source": "runbook",
        "scheme": "runbook-v2:",
        "replaced": [RUNBOOK_DOCUMENT_PREFIX, *LEGACY_RUNBOOK_DOCUMENT_PREFIXES],
        "app_version": "9.9.9",
        "a_newer_field": True,
    }))
    rag = await _service(prefs, kv)
    await rag._store.add(_chunks(prefs, "runbook-v2:", 400))
    # Recording on this build keeps the newer marker: it already names this scheme.
    assert await rag.record_runbook_corpus_migration() is True
    stored_marker = json.loads((await kv.get(RAG_CORPUS_MIGRATION_NS, "runbook"))[MARKER_FIELD])
    assert stored_marker["scheme"] == "runbook-v2:" and stored_marker["a_newer_field"] is True

    calls = _embed_spy(rag)
    await rag.ensure_seeded()
    assert rag._seeded is True and rag.last_refusal is None
    documents = [d for d in await rag._store.list_documents() if d.get("source") == "runbook"]
    assert documents and all(str(d["document_id"]).startswith(RUNBOOK_DOCUMENT_PREFIX) for d in documents)
    row = rag.last_projection["runbook"]
    assert row["migration_replaced"] == 400 and row["shrank"] is False
    projection_embeds = sum(calls)
    assert projection_embeds > 1

    # No storm: later retrievals embed the query only, never the corpus again.
    for _ in range(3):
        await rag.ensure_seeded()
        await rag.retrieve("brute force password spray")
    assert sum(calls) - projection_embeds <= 3
    assert all(size == 1 for size in calls[len(calls) - 3:])


async def test_the_upgrade_direction_replaces_legacy_ids_under_this_builds_marker() -> None:
    prefs = _runbook_only_prefs()
    kv = EsKVStore(InMemoryESClient())
    rag = await _service(prefs, kv)
    await rag._store.add(_chunks(prefs, "runbook:", 400))
    assert await rag.record_runbook_corpus_migration() is True
    marker = decode_marker("runbook", await kv.get(RAG_CORPUS_MIGRATION_NS, "runbook"))
    assert marker is not None and marker.scheme == RUNBOOK_DOCUMENT_PREFIX
    assert set(LEGACY_RUNBOOK_DOCUMENT_PREFIXES) <= set(marker.replaced)
    await rag.ensure_seeded()
    assert rag._seeded is True and rag.last_refusal is None


async def test_a_marker_that_does_not_name_this_builds_scheme_grants_nothing() -> None:
    prefs = _runbook_only_prefs()
    kv = EsKVStore(InMemoryESClient())
    await kv.put(RAG_CORPUS_MIGRATION_NS, "runbook", encode_marker({
        "contract": 1, "source": "runbook", "scheme": "runbook-v3:", "replaced": ["runbook-v2:"],
    }))
    rag = await _service(prefs, kv)
    await rag._store.add(_chunks(prefs, "runbook-v2:", 400))
    await rag.ensure_seeded()
    assert rag._seeded is False and rag.last_refusal is not None


def test_a_zero_projection_is_refused_whatever_the_marker_says() -> None:
    rag = RagService(_gateway(), _runbook_only_prefs())
    with pytest.raises(ProjectionCollapsed) as raised:
        rag._guard_projection_collapse(
            {"runbook": 400}, [], scope=frozenset({"runbook"}), migrated={"runbook": 400}
        )
    assert raised.value.reason_code == REFUSAL_EMPTY_PROJECTION
    # And without the marker licence the same shrink is a retention-floor refusal.
    one = _chunks(_runbook_only_prefs(), RUNBOOK_DOCUMENT_PREFIX, 1)
    with pytest.raises(ProjectionCollapsed) as raised:
        rag._guard_projection_collapse({"runbook": 400}, one, scope=frozenset({"runbook"}))
    assert raised.value.reason_code == REFUSAL_RETENTION_FLOOR
    # With it, the replacement goes through.
    rag._guard_projection_collapse(
        {"runbook": 400}, one, scope=frozenset({"runbook"}), migrated={"runbook": 400}
    )


async def test_the_marker_store_supersedes_an_unrelated_marker_cumulatively() -> None:
    kv = EsKVStore(InMemoryESClient())
    store = RagCorpusMigrationStore(kv)
    await kv.put(RAG_CORPUS_MIGRATION_NS, "mitre", encode_marker({
        "contract": 1, "source": "mitre", "scheme": "mitre-v0:", "replaced": [],
    }))
    marker = await store.record("mitre", scheme="mitre-v1:", replaced=["seed:mitre"])
    assert marker is not None and marker.scheme == "mitre-v1:"
    assert set(marker.replaced) == {"seed:mitre", "mitre-v0:"}
    again = await store.record("mitre", scheme="mitre-v1:", replaced=["seed:mitre"])
    assert again is not None and again.raw == marker.raw
    assert decode_marker("mitre", {"rag_corpus_migration_json": "{not json"}) is None
    assert decode_marker("mitre", encode_marker({"source": "other", "scheme": "x:"})) is None
    assert scheme_of("runbook-library:a:v1-0", {"runbook:", "runbook-library:"}) == "runbook-library:"
    assert scheme_of("runbook:a", {"runbook:", "runbook-library:"}) == "runbook:"
    assert scheme_of("mitre:a", {"runbook:"}) is None


# --------------------------------------------------------------------------- #
# R3: preference round trips
# --------------------------------------------------------------------------- #
def _future_document() -> dict[str, Any]:
    """This build's document as a NEWER build would store it."""
    doc = Preferences().model_dump(mode="json")
    doc["a_section_only_a_newer_build_has"] = {"enabled": True, "level": 3}
    doc["runbooks"]["a_switch_only_a_newer_build_has"] = "on"
    doc["runbooks"]["investigator_guidance"] = False
    doc["runbooks"]["auto_attach"] = False
    doc["chat_agent"]["max_parallel"] = 40  # above this build's ceiling of 24
    doc["chat_agent"]["chat_limits_version"] = 3  # a newer migration's marker
    doc["chat_agent"]["limits_mode"] = "adaptive"  # a newer mode
    doc["rbac"]["rbac_grants_version"] = RBAC_GRANTS_VERSION + 1
    return doc


def test_an_unknown_key_never_fails_validation() -> None:
    loaded = Preferences.model_validate(_future_document())
    assert loaded.runbooks.investigator_guidance is False
    assert loaded.runbooks.auto_attach is False
    assert loaded.chat_agent.max_parallel == 24  # clamped for this build's own use


def test_a_save_keeps_unknown_keys_and_unchanged_clamped_values() -> None:
    stored = _future_document()
    loaded = Preferences.model_validate(copy.deepcopy(stored))
    saved = preferences_document(loaded, stored)
    assert saved["a_section_only_a_newer_build_has"] == {"enabled": True, "level": 3}
    assert saved["runbooks"]["a_switch_only_a_newer_build_has"] == "on"
    assert saved["runbooks"]["investigator_guidance"] is False
    assert saved["chat_agent"]["max_parallel"] == 40
    assert saved["chat_agent"]["chat_limits_version"] == 3
    assert saved["chat_agent"]["limits_mode"] == "adaptive"
    assert saved["rbac"]["rbac_grants_version"] == RBAC_GRANTS_VERSION + 1
    # A reload reads the same as the first load: nothing drifted.
    assert Preferences.model_validate(saved).model_dump() == loaded.model_dump()


def test_a_value_the_operator_changed_is_saved_as_changed() -> None:
    stored = _future_document()
    loaded = Preferences.model_validate(copy.deepcopy(stored))
    loaded.chat_agent.max_parallel = 6
    saved = preferences_document(loaded, stored)
    assert saved["chat_agent"]["max_parallel"] == 6
    assert saved["chat_agent"]["chat_limits_version"] == 3  # untouched siblings kept


def test_a_retired_key_is_not_resurrected() -> None:
    assert ("playbooks", "llm_select") in CONSUMED_PREFERENCE_KEYS
    stored = Preferences().model_dump(mode="json")
    stored["playbooks"]["llm_select"] = True
    saved = preferences_document(Preferences.model_validate(copy.deepcopy(stored)), stored)
    assert "llm_select" not in saved["playbooks"]


def test_a_stored_document_that_does_not_validate_still_keeps_unknown_keys() -> None:
    stored = {"a_section_only_a_newer_build_has": {"x": 1}, "auto_close": "not an object"}
    saved = preferences_document(Preferences(), stored)
    assert saved["a_section_only_a_newer_build_has"] == {"x": 1}
    assert isinstance(saved["auto_close"], dict)


# A miniature OLD and NEW build: the same mechanism, played by two schemas, proves the
# new -> old -> new round trip of the report (an older build has no ``runbooks``
# section, still models a retired key, and clamps a chat value lower).
class _OldChat(BaseModel):
    max_parallel: int = Field(default=8, ge=1, le=8)

    @model_validator(mode="before")
    @classmethod
    def _clamp(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("max_parallel"), int):
            data = {**data, "max_parallel": max(1, min(8, data["max_parallel"]))}
        return data


class _OldPlaybooks(BaseModel):
    enabled: bool = True
    llm_select: bool = False


class _OldBuild(BaseModel):
    chat_agent: _OldChat = Field(default_factory=_OldChat)
    playbooks: _OldPlaybooks = Field(default_factory=_OldPlaybooks)


def test_new_old_new_preserves_runbooks_and_the_unclamped_value() -> None:
    new_document = Preferences().model_dump(mode="json")
    new_document["runbooks"]["investigator_guidance"] = False
    new_document["runbooks"]["auto_attach"] = False
    new_document["chat_agent"]["max_parallel"] = 12

    # The old build loads and saves (its graceful stop rewrites the document).
    old = _OldBuild.model_validate(copy.deepcopy(new_document))
    assert old.chat_agent.max_parallel == 8
    after_old = preferences_document(old, new_document)
    assert after_old["runbooks"] == new_document["runbooks"]
    assert after_old["chat_agent"]["max_parallel"] == 12

    # Back on the new build: the operator's runbook choices and the value are intact.
    again = Preferences.model_validate(copy.deepcopy(after_old))
    assert again.runbooks.investigator_guidance is False
    assert again.runbooks.auto_attach is False
    assert again.chat_agent.max_parallel == 12


async def test_the_elasticsearch_config_store_round_trips_unknown_keys() -> None:
    es = InMemoryESClient()
    store = ConfigStore(es)
    from app.constants import CONFIG_DOC_ID, CONFIG_INDEX

    await es.index_doc(CONFIG_INDEX, _future_document(), doc_id=CONFIG_DOC_ID, refresh=True)
    loaded = await store.load()
    await store.save(loaded)
    stored = await es.get_doc(CONFIG_INDEX, CONFIG_DOC_ID)
    assert stored["a_section_only_a_newer_build_has"] == {"enabled": True, "level": 3}
    assert stored["chat_agent"]["max_parallel"] == 40
    assert (await store.load()).runbooks.investigator_guidance is False


async def test_the_sql_config_store_round_trips_through_a_graceful_stop() -> None:
    """The report's path: a graceful stop (``disable_demo`` saves the document) on a
    build that does not model a key never erases it."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    try:
        first = AppState.create(secrets=_sql_secrets(path), es=InMemoryESClient(), provider_overrides=overrides)
        await first.startup(start_poller=False)
        await first.shutdown()
        await _plant_sql(path, "config", "preferences", _future_document())

        second = AppState.create(secrets=_sql_secrets(path), es=InMemoryESClient(), provider_overrides=overrides)
        await second.startup(start_poller=False)
        assert second.prefs.runbooks.investigator_guidance is False
        await second.update_prefs(second.prefs.model_copy(update={"setup_complete": True}))
        await second.shutdown()

        third = AppState.create(secrets=_sql_secrets(path), es=InMemoryESClient(), provider_overrides=overrides)
        await third.startup(start_poller=False)
        try:
            stored = await third.kv.get("config", "preferences")
            assert stored["a_section_only_a_newer_build_has"] == {"enabled": True, "level": 3}
            assert stored["runbooks"]["a_switch_only_a_newer_build_has"] == "on"
            assert stored["chat_agent"]["max_parallel"] == 40
            assert stored["setup_complete"] is True
            assert third.prefs.runbooks.investigator_guidance is False
        finally:
            await third.shutdown()
    finally:
        os.remove(path)


# --------------------------------------------------------------------------- #
# Review fixes: migration stamps, a corrupt idempotency map, strict reads before
# a marker record and before a preference save.
# --------------------------------------------------------------------------- #
def _persisted_document() -> dict[str, Any]:
    """A full stored dump (the autopilot migration reads only a persisted document)."""
    doc = Preferences().model_dump(mode="json")
    doc["setup_complete"] = True
    return doc


def test_a_malformed_autopilot_stamp_runs_its_migration_once_not_on_every_load() -> None:
    from app.config import CURRENT_AUTOPILOT_CONFIG_VERSION

    for malformed in (-1, "x"):
        stored = _persisted_document()
        stored["autopilot_config_version"] = malformed
        first = Preferences.model_validate(copy.deepcopy(stored))
        assert first.autopilot_config_version == CURRENT_AUTOPILOT_CONFIG_VERSION
        # The operator opts out of campaigns and dismisses the banner after the migration.
        first.campaign.enabled = False
        first.show_autopilot_banner = False
        saved = preferences_document(first, stored)
        assert saved["autopilot_config_version"] == CURRENT_AUTOPILOT_CONFIG_VERSION
        again = Preferences.model_validate(copy.deepcopy(saved))
        assert again.campaign.enabled is False
        assert again.show_autopilot_banner is False


def test_a_malformed_rbac_stamp_does_not_re_grant_a_removed_action() -> None:
    for malformed in ("x", -1):
        stored = _persisted_document()
        stored["rbac"]["rbac_grants_version"] = malformed
        stored["rbac"]["custom_roles"] = [{
            "name": "editor", "inherits": "analyst",
            "grants": {"runbooks": ["read", "manage"]}, "denies": {},
        }]
        loaded = Preferences.model_validate(copy.deepcopy(stored))
        roles = copy.deepcopy(loaded.rbac.custom_roles)
        assert "publish" in roles[0]["grants"]["runbooks"]  # the once-only rule ran
        # An administrator removes the grant the migration added.
        roles[0]["grants"]["runbooks"] = [a for a in roles[0]["grants"]["runbooks"] if a != "publish"]
        loaded.rbac = loaded.rbac.model_copy(update={"custom_roles": roles})
        saved = preferences_document(loaded, stored)
        assert saved["rbac"]["rbac_grants_version"] == RBAC_GRANTS_VERSION
        again = Preferences.model_validate(copy.deepcopy(saved))
        assert "publish" not in again.rbac.custom_roles[0]["grants"]["runbooks"]


def test_malformed_chat_and_runbook_stamps_are_saved_as_the_current_stamp() -> None:
    from app.config import CURRENT_CHAT_LIMITS_VERSION, CURRENT_RUNBOOKS_CONFIG_VERSION

    stored = _persisted_document()
    stored["chat_agent"]["chat_limits_version"] = -1
    stored["runbooks"]["runbooks_config_version"] = -1
    saved = preferences_document(Preferences.model_validate(copy.deepcopy(stored)), stored)
    assert saved["chat_agent"]["chat_limits_version"] == CURRENT_CHAT_LIMITS_VERSION
    assert saved["runbooks"]["runbooks_config_version"] == CURRENT_RUNBOOKS_CONFIG_VERSION


def test_a_newer_builds_valid_stamps_still_survive_a_save() -> None:
    from app.config import CURRENT_CHAT_LIMITS_VERSION

    stored = _persisted_document()
    stored["chat_agent"]["chat_limits_version"] = CURRENT_CHAT_LIMITS_VERSION + 1
    stored["rbac"]["rbac_grants_version"] = RBAC_GRANTS_VERSION + 1
    saved = preferences_document(Preferences.model_validate(copy.deepcopy(stored)), stored)
    assert saved["chat_agent"]["chat_limits_version"] == CURRENT_CHAT_LIMITS_VERSION + 1
    assert saved["rbac"]["rbac_grants_version"] == RBAC_GRANTS_VERSION + 1


async def test_a_corrupt_idempotency_map_fails_closed() -> None:
    for corrupt in (["x"], [["corrupt"]], "not a map", 7):
        kv = EsKVStore(InMemoryESClient())
        await kv.put_strict(JOBS_NS, JOBS_KEY, {"jobs": {}, "idempotency": corrupt, "factory_fence": ""})
        store = JobStore(kv)
        with pytest.raises(ValueError, match="invalid record"):
            await store.list_for_actor("")
        with pytest.raises(ValueError, match="invalid record"):
            await store.factory_fence_owner()
        with pytest.raises(ValueError, match="invalid record"):
            await store.create(_known_job())
        # Nothing was rewritten: the corrupt map is still there for an operator to see.
        assert (await kv.get_strict(JOBS_NS, JOBS_KEY))["idempotency"] == corrupt
    # Absent or null still means "no bindings".
    for doc in ({"jobs": {}, "factory_fence": ""}, {"jobs": {}, "idempotency": None}):
        kv = EsKVStore(InMemoryESClient())
        await kv.put_strict(JOBS_NS, JOBS_KEY, doc)
        _job, created, _ = await JobStore(kv).create(_known_job())
        assert created


def _newer_marker() -> dict[str, Any]:
    return encode_marker({
        "contract": 2, "source": "runbook", "scheme": "runbook-v3:",
        "replaced": ["runbook-library:", "runbook:", "seed:runbook"],
    })


async def test_a_failed_read_never_overwrites_a_newer_marker() -> None:
    es = InMemoryESClient()
    kv = EsKVStore(es)
    await kv.put_strict(RAG_CORPUS_MIGRATION_NS, "runbook", _newer_marker())
    before = await kv.get_strict(RAG_CORPUS_MIGRATION_NS, "runbook")

    # The real client's fail-soft get_doc turns any error into "absent"; the strict
    # read is what record() relies on, and here it raises once.
    calls = {"n": 0}
    real = es.get_doc_strict

    async def flaky(index: str, doc_id: str):  # noqa: ANN202
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("transient")
        return await real(index, doc_id)

    async def soft_absent(index: str, doc_id: str):  # noqa: ANN202
        return None

    es.get_doc_strict = flaky  # type: ignore[method-assign]
    es.get_doc = soft_absent  # type: ignore[method-assign]
    store = RagCorpusMigrationStore(kv)
    marker = await store.record(
        "runbook", scheme=RUNBOOK_DOCUMENT_PREFIX, replaced=LEGACY_RUNBOOK_DOCUMENT_PREFIXES
    )
    assert marker is None
    del es.get_doc_strict, es.get_doc  # back to the client's own methods
    assert await kv.get_strict(RAG_CORPUS_MIGRATION_NS, "runbook") == before

    # A readable newer marker that names this build's scheme is kept as it is.
    kept = await store.record(
        "runbook", scheme=RUNBOOK_DOCUMENT_PREFIX, replaced=LEGACY_RUNBOOK_DOCUMENT_PREFIXES
    )
    assert kept is not None and kept.scheme == "runbook-v3:"
    assert await kv.get_strict(RAG_CORPUS_MIGRATION_NS, "runbook") == before


async def test_the_elasticsearch_config_store_aborts_a_save_whose_read_fails() -> None:
    from app.constants import CONFIG_DOC_ID, CONFIG_INDEX

    es = InMemoryESClient()
    store = ConfigStore(es)
    await es.index_doc(CONFIG_INDEX, _future_document(), doc_id=CONFIG_DOC_ID, refresh=True)
    loaded = await store.load()
    before = copy.deepcopy(await es.get_doc(CONFIG_INDEX, CONFIG_DOC_ID))

    async def failing(index: str, doc_id: str):  # noqa: ANN202
        raise ConnectionError("timeout")

    async def soft_absent(index: str, doc_id: str):  # noqa: ANN202
        return None  # what the real client's get_doc does on a timeout or a 5xx

    es.get_doc_strict = failing  # type: ignore[method-assign]
    es.get_doc = soft_absent  # type: ignore[method-assign]
    with pytest.raises(ConnectionError):
        await store.save(loaded)
    del es.get_doc_strict, es.get_doc  # back to the client's own methods
    assert await es.get_doc(CONFIG_INDEX, CONFIG_DOC_ID) == before


async def test_the_sql_config_store_aborts_a_save_whose_read_fails() -> None:
    from app.stores.sql.repositories import SqlConfigStore

    class _FailingKV:
        def __init__(self) -> None:
            self.puts: list[Any] = []

        async def get(self, namespace: str, key: str) -> Any:
            raise ConnectionError("database unavailable")

        async def put(self, namespace: str, key: str, value: Any) -> None:
            self.puts.append(value)

    kv = _FailingKV()
    with pytest.raises(ConnectionError):
        await SqlConfigStore(kv).save(Preferences())  # type: ignore[arg-type]
    assert kv.puts == []
