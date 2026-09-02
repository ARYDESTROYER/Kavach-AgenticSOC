"""The durable replay-experiment job handler.

One run replays a frozen fixture set through N named arm CONFIGURATIONS, now, against
one pinned corpus snapshot. All cells for one fixture run consecutively so provider
drift mid-run perturbs whole fixtures rather than one arm relative to the other, which
is what makes the paired design sound; within a fixture the ordering is repeat-major
and arm-minor so paired cells are adjacent in time.

Spend is bounded at three points: the run limiter is consulted BEFORE every completion
(through the gateway's own pre-flight, on an estimate that is worst-case in the OUTPUT
dimension) and before every embedding, and the accrued actual is re-read at every CELL
boundary. Exceeding the bound CANCELS the job cooperatively; it never truncates
silently, and no cell produced after the trip is scored — a blocked completion surfaces
as NEEDS_HUMAN, which is the very metric under study.

Cancellation, live authority and the lease are observed at the same CELL boundary,
because a cell — not a fixture — is the unit of billable work: a fixture-only
checkpoint would let up to ``arms * repeats`` full investigations run after an operator
pressed Cancel, and a single-fixture run would ignore Cancel entirely.

The bound is PER JOB, and a job spends in exactly one attempt. The run's accrual is
read from a run-scoped ledger mirror that a worker restart cannot reconstruct, so a
recovered replay is REFUSED rather than resumed with a fresh, untouched bound — which
would let one interruption spend the operator's ceiling twice.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import zipfile
from dataclasses import dataclass, field
from typing import Any

from ...constants import ActionType, DecisionBy, JobStatus
from ...models import JobResult
from ...utils import iso_now
from .fixtures import LoadedFixture, canonical_json
from .params import ReplayExperimentParams
from .scoring import (
    CellRecord,
    arm_comparison,
    arm_summary,
    corpus_fingerprint,
    corpus_row,
    noise_floor,
    offline_decision,
    paired_fixture_ids,
    paired_rows,
    policy_identity,
    retrieval_input_fingerprint,
)
from .stack import (
    REPLAY_LEDGER_SURFACE,
    ReplayGateway,
    ReplaySpendLimiter,
    ReplayStack,
    ReplayBudgetGate,
)
from .text import FIDELITY_NOTES, REPLAY_LIMITATIONS

logger = logging.getLogger("tlsoc.engine.replay.job")

REPORT_SCHEMA_VERSION = 2
_UNIT = "replay fixtures"


@dataclass
class ReplayRunContext:
    """Everything a run pins once and every cell shares."""

    state: Any
    job_id: str
    base_prefs: Any
    gateway: Any
    limiter: ReplaySpendLimiter
    mirror: Any
    corpus_chunks: list[Any]
    corpus_fingerprint: str
    memory_entries: list[Any] = field(default_factory=list)


class ReplayRefused(RuntimeError):
    """The run cannot be scored honestly and must not spend anything."""


def _resumed_attempt(job: Any) -> bool:
    """Whether this execution is a SECOND attempt at an already-spending job.

    ``begin_item`` runs before any cell, and the kind is deliberately not retry-safe,
    so a worker that died after spending anything leaves at least one terminal item
    behind. A terminal item at entry therefore means "this job already spent".
    """
    states = dict(getattr(job, "item_states", None) or {})
    return any(state in {"succeeded", "failed"} for state in states.values())


def _abort_fixture_cells(cells: list[CellRecord], fixture_id: str) -> None:
    """Drop a half-run fixture's cells from every denominator, in BOTH arms.

    Cells are appended incrementally, so a fixture that fails on its second arm would
    otherwise leave the first arm's cell scored — skewing that arm's summary against a
    paired table the fixture has already left.
    """
    for cell in cells:
        if cell.fixture_id == fixture_id and not cell.excluded:
            cell.excluded = True
            cell.exclusion_reason = "fixture_aborted"


async def run_replay_job(runner: Any, job: Any, token: str) -> None:
    """Execute one replay experiment. Called by :class:`app.engine.jobs.JobRunner`."""
    from ..jobs import JobAuthorityLost, JobCancelled

    state = runner.state
    params = ReplayExperimentParams.model_validate(dict(job.params))
    current = await runner.checkpoint(job.job_id, token)

    started_at = iso_now()
    resumed = _resumed_attempt(current)
    try:
        if resumed:
            # A billable kind cannot resume: the run's accrual lives in a run-scoped
            # ledger mirror that a new worker cannot reconstruct, so resuming would
            # hand the remaining fixtures a FRESH, untouched copy of the operator's
            # bound and let one interruption spend the ceiling twice.
            raise ReplayRefused(
                "this replay was interrupted after it began spending and cannot be "
                "resumed: its spend bound applies to the whole job and cannot be "
                "carried across a worker restart. The spend it already made is in the "
                "usage ledger and in its replay-spend audit row; submit a new run for "
                "the remaining fixtures."
            )
        run = await _build_run(state, job, params)
    except ReplayRefused as exc:
        current = await runner.checkpoint(job.job_id, token)
        await runner._finish(
            current, token, JobStatus.FAILED, error=str(exc),
            result=JobResult(kind="replay_experiment", counts={
                "succeeded": 0, "failed": 0, "total": len(params.fixture_ids),
            }),
        )
        return

    cells: list[CellRecord] = []
    excluded_counts: dict[str, int] = {}
    unavailable = 0
    failed = 0
    succeeded = 0
    cancelled: JobCancelled | None = None
    total = len(params.fixture_ids)
    done = 0

    for fixture_id in params.fixture_ids:
        try:
            await runner.checkpoint(
                job.job_id, token, done=done, total=total, unit=_UNIT, emit=True
            )
            await _guard_spend(run)
        except JobCancelled as exc:
            cancelled = exc
            break
        await runner.store.begin_item(job.job_id, token, fixture_id)
        fixture = await run.state.replay_fixtures.load(fixture_id)
        if fixture is None:
            unavailable += 1
            excluded_counts["fixture_unavailable"] = (
                excluded_counts.get("fixture_unavailable", 0) + 1
            )
            await runner.store.complete_item(
                job.job_id, token, fixture_id,
                error="fixture is unavailable; its stored body is missing or no longer "
                      "matches its catalogued content hash",
            )
            done += 1
            continue
        try:
            for repeat in range(params.repeats):
                for arm in params.arms:
                    cells.append(await _run_cell(run, fixture, arm, repeat))
                    # Observed at the CELL boundary — the unit of billable work — so an
                    # operator Cancel costs at most the cell already in flight.
                    await runner.checkpoint(job.job_id, token)
                    await _guard_spend(run)
        except JobCancelled as exc:
            cancelled = exc
            _abort_fixture_cells(cells, fixture_id)
            # ``str(exc)`` distinguishes an operator cancel from a spend-bound trip; a
            # hardcoded reason would put a false statement in the append-only record.
            await runner.store.complete_item(
                job.job_id, token, fixture_id, error=str(exc)
            )
            break
        except JobAuthorityLost:
            # Authority loss aborts the RUN; it is never one fixture's pipeline error.
            _abort_fixture_cells(cells, fixture_id)
            raise
        except Exception as exc:  # noqa: BLE001 — isolate one fixture
            logger.warning("replay fixture %s failed: %s", fixture_id, exc)
            # Its already-completed cells belong to a fixture that never finished, so
            # they leave BOTH arms' denominators: a half-run fixture would otherwise
            # skew the surviving arm's summary against the paired table.
            _abort_fixture_cells(cells, fixture_id)
            await runner.store.complete_item(
                job.job_id, token, fixture_id, error=runner._reason(exc)
            )
            failed += 1
            done += 1
            continue
        await runner.store.complete_item(job.job_id, token, fixture_id)
        succeeded += 1
        done += 1

    for cell in cells:
        if cell.excluded and cell.exclusion_reason:
            excluded_counts[cell.exclusion_reason] = (
                excluded_counts.get(cell.exclusion_reason, 0) + 1
            )

    # A run where nothing could be replayed is a FAILURE, not a success with an empty
    # table; anything partly replayed is truthfully PARTIAL.
    incomplete = unavailable + failed
    terminal = (
        JobStatus.CANCELLED if cancelled is not None
        else JobStatus.FAILED if succeeded == 0
        else JobStatus.PARTIAL if (incomplete or done < total)
        else JobStatus.SUCCEEDED
    )
    report = await _build_report(
        run, job, params, cells,
        started_at=started_at,
        terminal=terminal,
        excluded_counts=excluded_counts,
        unavailable=unavailable,
        loaded=succeeded,
    )
    await _audit_spend(run, job, params, report, terminal)

    path, artifact_id = await runner._reserve_artifact_path(job, token, ".zip")
    try:
        await asyncio.to_thread(_write_archive, str(path), report, cells, params)
        artifact = await runner._artifact_meta(
            path, artifact_id, f"replay-{job.job_id}.zip", "application/zip"
        )
        _attached, expired = await runner.store.attach_artifact(job.job_id, token, artifact)
        await runner.delete_artifacts(expired)
    except BaseException:
        runner._safe_unlink(path)
        try:
            await runner.store.clear_pending_artifact(job.job_id, token, artifact_id)
        except Exception:  # noqa: BLE001 — the primary error must survive
            pass
        stale = await runner.store.get(job.job_id)
        if stale is not None and stale.artifact is not None:
            await runner._discard_attached_artifact(stale)
        raise

    counts = {
        "succeeded": succeeded,
        "failed": incomplete,
        "total": total,
        "cells_run": len([cell for cell in cells]),
        "cells_scored": len([cell for cell in cells if not cell.excluded]),
    }
    current = await runner.store.get(job.job_id)
    await runner._finish(
        current, token, terminal,
        result=JobResult(
            kind="replay_experiment", artifact_id=artifact_id, counts=counts
        ),
        error=(str(cancelled) if cancelled is not None else None),
    )


# --------------------------------------------------------------------------- #
# Run construction
# --------------------------------------------------------------------------- #
async def _build_run(state: Any, job: Any, params: ReplayExperimentParams):
    from ...stores.usage import UsageStore
    from ...es.fake import InMemoryESClient
    from .stack import DualUsageStore

    chunks = await _pinned_corpus(state, params)
    mirror = UsageStore(InMemoryESClient())
    limiter = ReplaySpendLimiter(params.spend_bound_usd, mirror)
    usage = DualUsageStore(state._real_usage_store, mirror, job.job_id)
    gateway = ReplayGateway(
        state.secrets,
        usage,
        state._provider_overrides,
        limiter=limiter,
        price_overlay=getattr(state, "price_overlay", None),
        budget_gate=ReplayBudgetGate(getattr(state, "budget_gate", None), limiter),
        custom_models=getattr(state, "custom_models", None),
        discounted_policy=lambda: state.prefs.batch,
        # Deliberately NO provider_health: an experiment's provider failures must not
        # trip the live deployment's advisory circuit breaker and change how real
        # alerts are routed.
    )
    try:
        memory_entries = await state.real_memory.list(active_only=True)
    except Exception as exc:  # noqa: BLE001 — memory is advisory
        logger.warning("replay memory snapshot failed (%s); continuing without it", exc)
        memory_entries = []
    return ReplayRunContext(
        state=state,
        job_id=job.job_id,
        base_prefs=state.prefs,
        gateway=gateway,
        limiter=limiter,
        mirror=mirror,
        corpus_chunks=chunks,
        corpus_fingerprint=corpus_fingerprint(chunks),
        memory_entries=list(memory_entries),
    )


async def _pinned_corpus(state: Any, params: ReplayExperimentParams) -> list[Any]:
    """Snapshot the live corpus WITH its vectors, once, before any cell runs.

    ``ensure_seeded`` is deliberately NOT called: a replay must not trigger a billable
    production re-embed or a stale sweep as a side effect. An empty corpus is refused
    outright — a silent zero-knowledge experiment is worse than no experiment.
    """
    try:
        chunks = await state.rag.store.list_all_chunks()
    except Exception as exc:  # noqa: BLE001
        raise ReplayRefused(
            f"the knowledge corpus could not be read, so it cannot be pinned: {exc}"
        ) from exc
    if not chunks:
        raise ReplayRefused(
            "the knowledge corpus is empty; replay refuses to run against a corpus "
            "that does not represent this deployment (run a knowledge rebuild first)"
        )
    if len(chunks) > params.corpus_chunk_limit:
        raise ReplayRefused(
            f"the knowledge corpus holds {len(chunks)} chunks, above the "
            f"corpus_chunk_limit of {params.corpus_chunk_limit} for this run"
        )
    # A corpus embedded in a different space than the one queries will use is not
    # replayable: production recovers by clearing and reprojecting, which would
    # silently replace the pin mid-run. Refuse up front, having spent nothing, rather
    # than produce an experiment whose knowledge half is quietly absent.
    spaces = {str(getattr(chunk, "embedding_model", "") or "") for chunk in chunks}
    if len(spaces) > 1:
        raise ReplayRefused(
            "the knowledge corpus mixes embedding spaces "
            f"({', '.join(sorted(spaces))}); it cannot be pinned coherently"
        )
    configured = str(state.prefs.model_for("embedding").model)
    stored = next(iter(spaces))
    if stored and stored != configured:
        raise ReplayRefused(
            f"the knowledge corpus is embedded as {stored!r} but queries would use "
            f"{configured!r}; reproject the corpus before replaying against it"
        )
    # Sorted on exactly what ``corpus_fingerprint`` hashes. Neither persistent vector
    # store defines a read order, and the in-memory store's search is a STABLE sort, so
    # equal cosine scores are broken by INSERTION order: without this, two runs over a
    # byte-identical corpus could present different knowledge while reporting the same
    # fingerprint — and the fingerprint is the documented cross-run pairing gate.
    return sorted(chunks, key=corpus_row)


async def _guard_spend(run: ReplayRunContext) -> None:
    """Post-hoc bound check on ACTUALS, at every fixture and cell boundary."""
    from ..jobs import JobCancelled

    accrued = await run.limiter.accrued_usd()
    if run.limiter.tripped or accrued >= run.limiter.bound_usd:
        if not run.limiter.tripped:
            run.limiter.trip("replay_bound")
        raise JobCancelled(
            f"replay spend bound ${run.limiter.bound_usd:.4f} reached "
            f"(accrued ${accrued:.6f}); cancelling rather than overrunning"
        )


# --------------------------------------------------------------------------- #
# One cell
# --------------------------------------------------------------------------- #
async def _run_cell(
    run: ReplayRunContext, fixture: LoadedFixture, arm: Any, repeat: int
) -> CellRecord:
    tripped_before = run.limiter.tripped
    stack = ReplayStack(run=run, fixture=fixture, arm=arm)
    started = time.perf_counter()
    try:
        await stack.restore_corpus()
        case = await stack.investigate()
    finally:
        await stack.aclose()
    latency_ms = int((time.perf_counter() - started) * 1000)

    record = CellRecord(
        fixture_id=fixture.fixture_id,
        content_hash=fixture.content_hash,
        arm_id=arm.arm_id,
        repeat=repeat,
        replay_case_id=case.case_id,
        verdict=(case.verdict.value if case.verdict is not None else None),
        confidence=float(case.confidence),
        risk_score=float(case.risk_score),
        in_run_status=case.status.value,
        retrieval_observation_status=str(case.retrieval_observation_status),
        latency_ms=latency_ms,
    )
    # Close-eligibility is scored OFFLINE by the production decide(), against the
    # deployer's live policy — never read back from the isolated run's own status.
    record.decision, record.close_eligible = offline_decision(
        case.verdict, record.confidence, record.risk_score, run.base_prefs
    )
    record.knowledge_refs = [
        [
            str(entry.get("source") or ""),
            str(entry.get("document_id") or ""),
            str(entry.get("content_hash") or ""),
            str(entry.get("revision") if entry.get("revision") is not None else ""),
        ]
        for entry in (case.knowledge_used or [])
        if isinstance(entry, dict)
    ]
    if record.retrieval_observation_status == "measured":
        record.retrieval_input_fingerprint = retrieval_input_fingerprint(
            cluster_json=fixture.cluster_json,
            enrichment_json=fixture.enrichment_json,
            evidence_fields=list(fixture.evidence_fields),
            evidence_max_chars=fixture.evidence_max_chars,
            corpus_fingerprint=run.corpus_fingerprint,
            knowledge_refs=record.knowledge_refs,
        )
    record.evidence_render_sha256 = _evidence_render_hash(fixture)
    await _attach_cell_spend(run, record, case)

    if case.decision_by == DecisionBy.ANALYST_POLICY and case.verdict is None:
        record.excluded, record.exclusion_reason = True, "analyst_policy"
    elif tripped_before or run.limiter.tripped:
        # Produced while the bound was already tripped: a blocked completion becomes
        # NEEDS_HUMAN, which is the metric under study, so it must never be scored.
        record.excluded, record.exclusion_reason = True, "spend_bound"
    elif getattr(case, "error", None):
        record.excluded, record.exclusion_reason = True, "pipeline_error"
    return record


def _evidence_render_hash(fixture: LoadedFixture) -> str:
    """A hash of the PRODUCTION evidence render, recorded informationally only.

    Nothing asserts on it: it exists so a human can see that two cells rendered the
    same fenced evidence without the harness having to mirror a prompt call site.
    """
    from ...agents.prompts import render_cluster

    try:
        rendered = render_cluster(
            fixture.cluster(), fixture.enrichment(), [],
            evidence_fields=list(fixture.evidence_fields),
            evidence_max_chars=fixture.evidence_max_chars,
        )
    except Exception as exc:  # noqa: BLE001 — an observational hash never breaks a run
        logger.debug("replay evidence render hash skipped: %s", exc)
        return ""
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


async def _attach_cell_spend(run: ReplayRunContext, record: CellRecord, case: Any) -> None:
    """Read this cell's realised spend from the run-scoped ledger mirror."""
    try:
        summary = await run.mirror.summary(window_hours=24 * 30, case_id=case.case_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay cell spend read failed: %s", exc)
        return
    record.cost_usd = round(float(summary.get("total_cost", 0.0) or 0.0), 6)
    record.calls = int(summary.get("call_count", 0) or 0)
    record.tokens = int(summary.get("total_tokens", 0) or 0)
    tiers = [
        row for row in (summary.get("by_processing_tier") or [])
        if int(row.get("calls", 0) or 0) > 0
    ]
    tiers.sort(key=lambda row: int(row.get("calls", 0) or 0), reverse=True)
    record.processing_tier = str(tiers[0].get("key")) if tiers else ""


# --------------------------------------------------------------------------- #
# Report + artifact
# --------------------------------------------------------------------------- #
async def _build_report(
    run: ReplayRunContext,
    job: Any,
    params: ReplayExperimentParams,
    cells: list[CellRecord],
    *,
    started_at: str,
    terminal: JobStatus,
    excluded_counts: dict[str, int],
    unavailable: int,
    loaded: int,
) -> dict[str, Any]:
    arm_ids = [arm.arm_id for arm in params.arms]
    paired = paired_fixture_ids(cells, arm_ids) if len(arm_ids) > 1 else None
    floor = noise_floor(cells, arm_ids, params.repeats)
    # A PARTIAL run drops a whole fixture from BOTH arms, so the remaining pairs stay
    # symmetric and interpretable. A CANCELLED or FAILED run does not: it stopped
    # part-way through the cell order and its post-trip cells were discarded, so the
    # arms are no longer comparable and the result is insufficient evidence.
    run_incomplete = terminal in {JobStatus.CANCELLED, JobStatus.FAILED}
    comparison = arm_comparison(
        cells, arm_ids, floor, alpha=params.alpha, run_incomplete=run_incomplete
    )
    try:
        spend_summary = await run.mirror.summary(window_hours=24 * 30)
    except Exception:  # noqa: BLE001
        spend_summary = {}
    measured = [cell for cell in cells if cell.retrieval_observation_status == "measured"]
    by_source: dict[str, int] = {}
    for chunk in run.corpus_chunks:
        key = str(getattr(chunk, "source", "") or "unknown")
        by_source[key] = by_source.get(key, 0) + 1
    first = run.corpus_chunks[0] if run.corpus_chunks else None
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "job_id": job.job_id,
        "actor": job.actor,
        "started_at": started_at,
        "finished_at": iso_now(),
        "app_version": job.app_version,
        "build_sha": job.build_sha,
        "terminal_status": terminal.value,
        "params": {
            "fixture_count": len(params.fixture_ids),
            "arm_ids": arm_ids,
            "repeats": params.repeats,
            "spend_bound_usd": params.spend_bound_usd,
            "alpha": params.alpha,
            "corpus_chunk_limit": params.corpus_chunk_limit,
        },
        "corpus": {
            "fingerprint": run.corpus_fingerprint,
            "chunk_count": len(run.corpus_chunks),
            "embedding_model": str(getattr(first, "embedding_model", "") or ""),
            "dim": int(getattr(first, "dim", 0) or 0),
            "by_source": by_source,
        },
        "fixtures": {
            "requested": len(params.fixture_ids),
            "loaded": max(0, loaded),
            "unavailable": unavailable,
        },
        "cells": {
            "planned": len(params.fixture_ids) * len(arm_ids) * params.repeats,
            "run": len(cells),
            "scored": len([cell for cell in cells if not cell.excluded]),
            "excluded": len([cell for cell in cells if cell.excluded]),
        },
        "excluded": {
            key: int(excluded_counts.get(key, 0))
            for key in (
                "analyst_policy", "spend_bound", "pipeline_error",
                "fixture_aborted", "fixture_unavailable",
            )
        },
        "policy": policy_identity(run.base_prefs),
        "arms": [
            arm_summary(
                cells, arm.arm_id,
                {
                    role: override.model_dump(mode="json")
                    for role, override in (arm.models or {}).items()
                },
                arm_knobs=_arm_knobs(arm),
                paired_ids=paired,
            )
            for arm in params.arms
        ],
        "noise_floor": floor,
        "arm_comparison": comparison,
        "retrieval": _retrieval_identity(cells, arm_ids, params.repeats, measured),
        "spend": {
            "bound_usd": params.spend_bound_usd,
            "accrued_usd": round(float(spend_summary.get("total_cost", 0.0) or 0.0), 6),
            "cells_run": len(cells),
            "tripped": bool(run.limiter.tripped),
            "tripped_reason": run.limiter.tripped_reason,
            "ledger_surface": REPLAY_LEDGER_SURFACE,
            "by_role": spend_summary.get("by_role", []),
            "by_model": spend_summary.get("by_model", []),
        },
        "fidelity_notes": list(FIDELITY_NOTES),
        "limitations": REPLAY_LIMITATIONS,
    }


def _arm_knobs(arm: Any) -> dict[str, Any]:
    """The arm's effective NON-default knobs, recorded so the report names them.

    Without this the artifact emits a full paired table for a factor it never
    identifies, and a reader cannot tell what distinguished one arm from the other.
    """
    knobs: dict[str, Any] = {}
    for name in (
        "rag_top_k", "caps_max_tool_calls", "playbooks_enabled",
        "personas_enabled", "memory_enabled", "precedent_enabled",
    ):
        value = getattr(arm, name, None)
        if value is not None:
            knobs[name] = value
    return knobs


def _retrieval_identity(
    cells: list[CellRecord], arm_ids: list[str], repeats: int, measured: list[CellRecord]
) -> dict[str, Any]:
    """Reference IDENTITY across repeats of one arm — never retrieval quality.

    A fixture only enters the denominator when BOTH of its compared cells reported a
    measured observation; an unmeasured cell is excluded rather than counted as a
    match, mirroring the retrieval-evidence contract elsewhere in the product.
    """
    identical = differing = 0
    for arm_id in arm_ids:
        by_repeat: dict[int, dict[str, CellRecord]] = {}
        for cell in cells:
            if cell.arm_id == arm_id and not cell.excluded:
                by_repeat.setdefault(cell.repeat, {})[cell.fixture_id] = cell
        for index in range(max(0, repeats - 1)):
            left = by_repeat.get(index, {})
            right = by_repeat.get(index + 1, {})
            for fixture_id in sorted(set(left) & set(right)):
                one, two = left[fixture_id], right[fixture_id]
                if (
                    one.retrieval_observation_status != "measured"
                    or two.retrieval_observation_status != "measured"
                ):
                    continue
                if one.retrieval_input_fingerprint == two.retrieval_input_fingerprint:
                    identical += 1
                else:
                    differing += 1
    return {
        "measured_cells": len(measured),
        "unmeasured_cells": len(cells) - len(measured),
        "identical_within_arm_repeat": identical,
        "differing_within_arm_repeat": differing,
    }


def _write_archive(
    path: str,
    report: dict[str, Any],
    cells: list[CellRecord],
    params: ReplayExperimentParams,
) -> None:
    """Assemble the verified ZIP. Members carry ids, hashes, enums and numbers ONLY.

    No raw log content, evidence text, prompt text, model output text, or secret is
    ever written here: a fixture holds attacker-influenceable data and the only place
    it may be rendered is inside a fenced prompt (#9).
    """
    members: list[tuple[str, str]] = [
        ("report.json", json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)),
        (
            "cells.ndjson",
            "\n".join(canonical_json(cell.as_json()) for cell in cells) + ("\n" if cells else ""),
        ),
        (
            "pairs.ndjson",
            _pairs_ndjson(cells, params),
        ),
        ("limitations.txt", REPLAY_LIMITATIONS + "\n"),
    ]
    manifest = {
        "artifact": "replay_experiment",
        "schema_version": REPORT_SCHEMA_VERSION,
        "job_id": report["job_id"],
        "actor": report["actor"],
        "created_at": report["started_at"],
        "finished_at": report["finished_at"],
        "app_version": report["app_version"],
        "build_sha": report["build_sha"],
        "corpus_fingerprint": report["corpus"]["fingerprint"],
        # Pairing two artifacts requires BOTH: the corpus is one causal input to a
        # replayed verdict, the auto-close policy is the other, and a routine Settings
        # edit between two runs flips ``close_eligible`` with no other trace.
        "policy_fingerprint": report["policy"]["fingerprint"],
        "members": [
            {
                "name": name,
                "size": len(body.encode("utf-8")),
                "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            }
            for name, body in members
        ],
        "limitations": REPLAY_LIMITATIONS,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, True) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False),
        )
        for name, body in members:
            archive.writestr(name, body)


def _pairs_ndjson(cells: list[CellRecord], params: ReplayExperimentParams) -> str:
    arm_ids = [arm.arm_id for arm in params.arms]
    if len(arm_ids) < 2:
        return ""
    rows = paired_rows(cells, arm_ids[0], arm_ids[1])
    return "\n".join(canonical_json(row) for row in rows) + ("\n" if rows else "")


async def _audit_spend(
    run: ReplayRunContext,
    job: Any,
    params: ReplayExperimentParams,
    report: dict[str, Any],
    terminal: JobStatus,
) -> None:
    """One keyed, idempotent accountability row: who spent how much, and on what.

    Real money is never spent without an audit row naming it (#2 + #6). This is the
    ONLY audit row the replay adds beyond the job's own lifecycle transitions; every
    pipeline audit row from every cell lands in that cell's isolated log and is
    discarded with it.
    """
    spend = report["spend"]
    try:
        await run.state.control_audit.record_strict(
            action_type=ActionType.JOB,
            event_id=f"job:{job.job_id}:replay-spend",
            surface="jobs",
            actor=job.actor,
            result_summary=(
                f"replay experiment job={job.job_id} "
                f"fixtures={len(params.fixture_ids)} arms={len(params.arms)} "
                f"repeats={params.repeats} cells_run={spend['cells_run']} "
                f"spend_usd={spend['accrued_usd']:.6f} "
                f"bound_usd={spend['bound_usd']:.6f} outcome={terminal.value}"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — never lose the artifact over the row
        logger.error("replay spend audit row failed for %s: %s", job.job_id, exc)
