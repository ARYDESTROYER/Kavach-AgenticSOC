"""Isolation contract: what a replay may touch, and what it must never touch."""

from __future__ import annotations

import fnmatch
import hashlib
import json
from typing import Any

import pytest

from app.constants import (
    AUDIT_INDEX,
    CASES_INDEX,
    CONFIG_INDEX,
    USAGE_INDEX,
    SourceSurface,
)
from app.engine.replay.stack import REPLAY_LEDGER_SURFACE, _ReplayCaseStore
from app.es.fake import InMemoryESClient

from tests.replay_support import (
    capture,
    make_cluster,
    quiet,
    replay_params,
    run_replay,
    seed_corpus,
)


def _ids(es: InMemoryESClient, prefix: str) -> set[tuple[str, str]]:
    return {
        (index, doc_id)
        for index, docs in es.docs.items()
        if fnmatch.fnmatch(index, f"{prefix}*")
        for doc_id in docs
    }


def _rows(es: InMemoryESClient, prefix: str) -> list[dict[str, Any]]:
    return [
        source
        for index, docs in es.docs.items()
        if fnmatch.fnmatch(index, f"{prefix}*")
        for source in docs.values()
    ]


@pytest.mark.asyncio
async def test_replay_writes_no_production_case_or_pipeline_audit_row(app_state, tmp_path):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.40")

    # POSITIVE CONTROL: the same work through the REAL pipeline must move both stores,
    # so the absence asserted below is proven detectable rather than merely observed.
    before_cases = _ids(app_state.es, CASES_INDEX)
    before_audit = _ids(app_state.es, AUDIT_INDEX)
    await app_state._real_pipeline.investigate_cluster(
        make_cluster(ip="203.0.113.40"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert len(_ids(app_state.es, CASES_INDEX)) == len(before_cases) + 1
    control_audit = _ids(app_state.es, AUDIT_INDEX)
    assert len(control_audit) > len(before_audit)
    assert any(
        row.get("action_type") == "decision"
        for row in _rows(app_state.es, AUDIT_INDEX)
    )

    baseline_cases = _ids(app_state.es, CASES_INDEX)
    baseline_audit = _ids(app_state.es, AUDIT_INDEX)

    job = await run_replay(app_state, replay_params([fixture_id], repeats=1))
    assert job.status.value in {"succeeded", "partial"}

    assert _ids(app_state.es, CASES_INDEX) == baseline_cases
    new_audit = _ids(app_state.es, AUDIT_INDEX) - baseline_audit
    assert new_audit, "the job's own lifecycle rows must exist"
    by_id = {
        (index, doc_id): source
        for index, docs in app_state.es.docs.items()
        if fnmatch.fnmatch(index, f"{AUDIT_INDEX}*")
        for doc_id, source in docs.items()
    }
    for key in new_audit:
        row = by_id[key]
        assert row.get("surface") == "jobs", row
        assert row.get("action_type") == "job", row
        assert not row.get("case_id"), row


@pytest.mark.asyncio
async def test_replay_case_store_write_guard_raises_on_misbinding(app_state):
    """A mis-bound store must fail loudly rather than upsert a real case by signature."""
    store = _ReplayCaseStore(InMemoryESClient(), "job-1")
    store._es = app_state.es  # simulate a refactor that re-points the store
    case = (await app_state._real_pipeline.investigate_cluster(
        make_cluster(ip="203.0.113.41"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    ))
    with pytest.raises(RuntimeError, match="isolated replay ES"):
        await store.save(case)


@pytest.mark.asyncio
async def test_replay_usage_rows_land_in_the_real_ledger_tagged(app_state, tmp_path):
    """Real money must be visible (#6) AND attributable to this exact run (R5)."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.42")
    before = _ids(app_state.es, USAGE_INDEX)

    job = await run_replay(app_state, replay_params([fixture_id], repeats=1))

    new_usage = _ids(app_state.es, USAGE_INDEX) - before
    assert new_usage
    by_id = {
        (index, doc_id): source
        for index, docs in app_state.es.docs.items()
        if fnmatch.fnmatch(index, f"{USAGE_INDEX}*")
        for doc_id, source in docs.items()
    }
    assert {by_id[key]["surface"] for key in new_usage} == {REPLAY_LEDGER_SURFACE}
    # ONE stable bucket, never one per run: ``UsageStore.summary`` keeps only the ten
    # most expensive surfaces, so a per-run key would evict real production surfaces
    # from the operator's cost view. Per-run spend comes from the job record instead.
    assert job.result is not None
    assert job.job_id not in json.dumps(
        [by_id[key]["surface"] for key in new_usage]
    )


@pytest.mark.asyncio
async def test_each_cell_gets_its_own_stack_so_arms_cannot_attach(app_state, tmp_path):
    """A run-lived stack would let arm B inherit arm A's verdict for free."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.43")

    job = await run_replay(app_state, replay_params([fixture_id], repeats=1))
    from tests.replay_support import cells_of

    cells = cells_of(app_state, job)
    assert len(cells) == 2
    assert len({cell["replay_case_id"] for cell in cells}) == 2
    assert all(cell["calls"] > 0 for cell in cells)


@pytest.mark.asyncio
async def test_replay_leaves_the_tenant_preferences_untouched(app_state, tmp_path):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.44")
    before = app_state.prefs.model_dump(mode="json")

    calls: list[Any] = []
    original = app_state.update_prefs

    async def spy(*args, **kwargs):
        calls.append(args)
        return await original(*args, **kwargs)

    app_state.update_prefs = spy  # type: ignore[method-assign]
    try:
        await run_replay(app_state, replay_params([fixture_id], repeats=1))
    finally:
        app_state.update_prefs = original  # type: ignore[method-assign]
    assert calls == []
    assert app_state.prefs.model_dump(mode="json") == before


@pytest.mark.asyncio
async def test_replay_makes_no_outbound_network_call(app_state, tmp_path):
    """The autouse socket guard is live; enrichment stays ENABLED and frozen."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    assert app_state.prefs.enrichment.enabled is True
    fixture_id = await capture(app_state, ip="203.0.113.45")
    job = await run_replay(app_state, replay_params([fixture_id], repeats=1))
    assert job.status.value == "succeeded"


def _kv_digest(es: InMemoryESClient) -> dict[str, str]:
    """A content hash of every shared-KV document (all KV stores live in one index).

    Content-hashed rather than compared as an id set: on a deployment that already has
    operator memory the ``memory`` document id already exists, so an id diff would miss
    a leak that only mutates its body.
    """
    return {
        f"{index}/{doc_id}": hashlib.sha256(
            json.dumps(source, sort_keys=True, default=str).encode()
        ).hexdigest()
        for index, docs in es.docs.items()
        if fnmatch.fnmatch(index, f"{CONFIG_INDEX}*")
        for doc_id, source in docs.items()
    }


@pytest.mark.asyncio
async def test_replay_mutates_no_shared_kv_store_and_no_live_corpus(app_state, tmp_path):
    """R6 names threads, activity, tasks, proposals, memory and the vector store.

    Asserting only on the case and audit indices would let a future collaborator reach
    a KV-backed production store with the whole isolation suite still green.
    """
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.46")
    corpus_before = await app_state.rag.store.count()
    before = _kv_digest(app_state.es)

    await run_replay(app_state, replay_params([fixture_id], repeats=1))

    after = _kv_digest(app_state.es)
    changed = {key for key in set(before) | set(after) if before.get(key) != after.get(key)}
    # The ONLY deliberate exceptions (R5/R6): the job's own registry row, its actor
    # Inbox fan-out, and the keyed ledger claims backing the tagged usage rows.
    allowed = ("jobs:", "inbox:", "ledger-claim:")
    leaked = sorted(
        key for key in changed if not key.split("/", 1)[1].startswith(allowed)
    )
    assert leaked == [], leaked
    # A replayed terminal case must not write a precedent chunk into the live corpus.
    assert await app_state.rag.store.count() == corpus_before
