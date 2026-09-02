"""Shared offline scaffolding for the replay-harness tests (not collected itself)."""

from __future__ import annotations

import hashlib
import json
import uuid
import zipfile
from pathlib import Path
from typing import Any

from app.constants import EntityType, JobKind, JobStatus, SourceSurface
from app.engine.correlation import cluster_from_events
from app.engine.replay.fixtures import build_fixture
from app.llm.providers import _hash_embed
from app.models import Job, JobProgress, JobTransition
from app.stores.jobs import idempotency_hash
from app.tools.vectorstore import StoredChunk

from tests.conftest import make_raw_event


async def seed_corpus(state, count: int = 3) -> list[StoredChunk]:
    """Put a small, deterministic, vector-carrying corpus in the live RAG store.

    A replay REFUSES an empty corpus, so every run-level test needs this. Each chunk's
    text is grounded in the SAME cluster query the pipeline will issue, so retrieval
    actually clears ``rag.min_score`` and the "identical retrieval inputs" assertions
    are non-vacuous. The stored space must equal the space a query resolves to, or the
    run is refused (production would clear and reproject, discarding the pin).
    """
    from app.agents.common import rag_query

    model = state.prefs.model_for("embedding").model
    grounding = rag_query(make_cluster())
    chunks = [
        StoredChunk(
            text=f"{grounding} runbook step {index}: verify and record the outcome",
            source="runbook",
            metadata={"document_id": f"doc-{index}", "content_hash": f"hash-{index}"},
            embedding=_hash_embed(f"{grounding} runbook step {index}"),
            embedding_model=model,
            dim=256,
            doc_id=f"doc-{index}",
        )
        for index in range(count)
    ]
    await state.rag.store.add(chunks)
    return chunks


def make_cluster(*, ip: str = "203.0.113.10", events: int = 3, ts_millis: int | None = None):
    members = [
        make_raw_event(id=f"rev{index}", ip=ip, ts_millis=ts_millis)
        for index in range(events)
    ]
    return cluster_from_events(EntityType.IP, ip, members)


def capture_candidate(cluster, prefs, *, case_id: str = "case-origin") -> dict[str, Any]:
    """The exact shape ``InvestigationPipeline`` hands its fixture sink."""
    source_ids = cluster.contributing_source_ids()
    return {
        "cluster": cluster.model_dump(mode="json"),
        "enrichment": None,
        "evidence_fields": list(prefs.evidence_fields_for(source_ids)),
        "evidence_max_chars": prefs.evidence_budget_for(source_ids),
        "origin_case_id": case_id,
        "source_surface": SourceSurface.AUTOMATED_SCAN.value,
    }


def fixture_id_for(candidate: dict[str, Any]) -> str:
    return build_fixture(candidate)["fixture_id"]


async def capture(state, *, ip: str = "203.0.113.10", events: int = 3) -> str:
    """Capture one fixture through the production sink and return its id."""
    cluster = make_cluster(ip=ip, events=events)
    candidate = capture_candidate(cluster, state.prefs)
    await state.replay_fixtures.sink(candidate)
    return fixture_id_for(candidate)


def replay_params(
    fixture_ids: list[str],
    *,
    arms: list[dict[str, Any]] | None = None,
    repeats: int = 2,
    spend_bound_usd: float = 5.0,
    alpha: float = 0.05,
) -> dict[str, Any]:
    return {
        "fixture_ids": sorted(fixture_ids),
        "arms": arms or [{"arm_id": "a"}, {"arm_id": "b"}],
        "repeats": repeats,
        "spend_bound_usd": spend_bound_usd,
        "alpha": alpha,
    }


async def submit(state, params: dict[str, Any], *, actor: str = "") -> tuple[Job, str]:
    """Create and claim a replay job directly, bypassing the HTTP submit path."""
    body = json.loads(json.dumps(params, sort_keys=True))
    job = Job(
        kind=JobKind.REPLAY_EXPERIMENT,
        actor=actor,
        actor_generation="",
        progress=JobProgress(total=len(body["fixture_ids"]), unit="replay fixtures"),
        request_fingerprint=hashlib.sha256(
            json.dumps(body, sort_keys=True).encode()
        ).hexdigest(),
        idempotency_key_hash=idempotency_hash(actor, uuid.uuid4().hex, ""),
        params=body,
        item_states={fixture_id: "pending" for fixture_id in body["fixture_ids"]},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )
    stored, _created, _pruned = await state.jobs.create(job)
    claimed = await state.jobs.claim_next("worker-replay", lease_millis=300_000)
    assert claimed is not None
    return claimed


async def run_replay(state, params: dict[str, Any], *, actor: str = "") -> Job:
    """Run one replay job to terminal and return the durable row."""
    job, token = await submit(state, params, actor=actor)
    await state.job_runner._execute(job, token)
    final = await state.jobs.get(job.job_id)
    assert final is not None
    return final


def artifact_members(state, job: Job) -> dict[str, str]:
    assert job.result is not None and job.result.artifact_id
    path = Path(state.secrets.jobs_artifact_dir) / f"{job.result.artifact_id}.zip"
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name).decode("utf-8") for name in archive.namelist()}


def report_of(state, job: Job) -> dict[str, Any]:
    return json.loads(artifact_members(state, job)["report.json"])


def cells_of(state, job: Job) -> list[dict[str, Any]]:
    raw = artifact_members(state, job)["cells.ndjson"].strip()
    return [json.loads(line) for line in raw.splitlines() if line]


async def quiet(state) -> None:
    """Stop the background worker so tests drive the handler deterministically."""
    await state.job_runner.stop()
    state.job_runner.notify = lambda: None


TERMINAL = {
    JobStatus.SUCCEEDED, JobStatus.PARTIAL, JobStatus.FAILED, JobStatus.CANCELLED,
}
