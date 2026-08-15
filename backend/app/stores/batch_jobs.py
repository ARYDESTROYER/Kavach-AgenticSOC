"""BATCH-JOB store — durable, resume-safe tracking of async LLM batch jobs (Round 4).

An LLM batch job (Anthropic Message Batches / OpenAI ``/v1/batches``) is submitted,
polled, and retrieved OUT-OF-BAND — potentially across a process restart. This store
persists each :class:`app.models.BatchJob` so a fresh process can reload the open
jobs and finish polling + folding their results back through the ONE gateway ledger
(#6). It is the batch-side analogue of the durable poller cursor: nothing is lost,
nothing is double-billed.

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.price_overlay` / :mod:`app.stores.user_prefs`): the WHOLE job set is
ONE KV document (``ns=BATCH_JOBS_NS``, ``key=BATCH_JOBS_KEY``) whose value is
``{"jobs": {"<job_id>": <BatchJob json>, ...}}`` — so it needs NO new ES index / SQL
table / migration. All mutations go through
:func:`app.stores.base.kv_mutate_strict` (confirmed compare-and-set,
lost-update safe). Batch state is a durability boundary; it never reports an
unpersisted transition as successful.

Idempotent ledger semantics (#6): :meth:`process_results` writes one logical
``UsageDoc`` per returned result — at the 0.5× batch rate (``batch=True``) — and marks
that result's ``custom_id`` ``retrieved`` only after the write. Detection re-entry
has a separate durable lease/state so a temporary pipeline failure retries without
another ledger row.
The store NEVER calls ``case_manager.decide()`` (#3) — it only produces the ledger
rows + hands verdict text back to the caller; folding into cases is the pipeline's job.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Iterable, TypeVar

from ..constants import (
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    JOBS_KEY,
    JOBS_NS,
    BatchJobState,
    UsageOutcome,
)
from ..models import BatchInboxAudience, BatchJob
from .base import KVStore, kv_mutate_strict

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.batch_jobs")

_RECORDING_LEASE_MILLIS = 5 * 60 * 1000
_SUBMISSION_LEASE_MILLIS = 5 * 60 * 1000
_MAX_JOBS = 500
_FACTORY_FENCE_FIELD = "factory_fence"
_RESET_EPOCH_FIELD = "reset_epoch"


def _tracked(job: BatchJob) -> dict[str, dict[str, Any]]:
    return {key: value for key, value in (job.custom_ids or {}).items() if key != "__meta__"}


def _refresh_summary(job: BatchJob) -> None:
    tracked = _tracked(job)
    job.summary_total = max(job.summary_total, len(tracked), len(job.requests or []))
    job.summary_retrieved = max(
        job.summary_retrieved,
        sum(1 for value in tracked.values() if isinstance(value, dict) and value.get("retrieved")),
    )
    job.summary_failed = max(
        job.summary_failed,
        sum(
            1
            for value in tracked.values()
            if isinstance(value, dict)
            and value.get("retrieved")
            and str(value.get("result_state") or "succeeded") != "succeeded"
        ),
    )


def _compact_terminal(job: BatchJob) -> None:
    """Scrub resumable payload only after this provider job is irreversibly terminal."""
    terminal = job.state in {BatchJobState.ERRORED, BatchJobState.EXPIRED}
    terminal = terminal or (
        job.state == BatchJobState.RETRIEVED and BatchJobStore._all_complete(job)
    )
    if not terminal or job.terminal_compacted:
        return
    _refresh_summary(job)
    if job.state in {BatchJobState.ERRORED, BatchJobState.EXPIRED}:
        job.summary_failed = max(job.summary_failed, job.summary_total - job.summary_retrieved)
    job.custom_ids = {}
    job.requests = []
    job.candidates = {}
    job.submission_lease_token = None
    job.submission_lease_at_millis = 0
    job.terminal_compacted = True


class BatchJobStore:
    """CRUD + resume-safe result folding over the batch-job set, persisted as one KV
    doc. Reads used by operator views remain best-effort; every write/state transition
    is strict and raises unless persistence is confirmed."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    # -- (de)serialisation --------------------------------------------------- #
    @staticmethod
    def _decode(doc: dict | None) -> dict[str, BatchJob]:
        raw = doc.get("jobs", {}) if isinstance(doc, dict) else {}
        out: dict[str, BatchJob] = {}
        for jid, item in (raw or {}).items():
            try:
                out[str(jid)] = BatchJob.model_validate(item)
            except Exception:  # noqa: BLE001 — skip a corrupt job, keep the rest
                continue
        return out

    async def _load_all(self) -> dict[str, BatchJob]:
        try:
            doc = await self._kv.get(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        except Exception as exc:  # noqa: BLE001 — best-effort load
            logger.warning("Loading batch jobs failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _load_all_strict(self) -> dict[str, BatchJob]:
        """Confirmed registry read for operator/API and durability boundaries."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        if doc is None:
            return {}
        if not isinstance(doc, dict):
            raise ValueError("batch-job registry is not a JSON object")
        raw = doc.get("jobs", {})
        if not isinstance(raw, dict):
            raise ValueError("batch-job registry entries are not an object")
        decoded = self._decode(doc)
        if len(decoded) != len(raw):
            raise ValueError("batch-job registry contains an invalid entry")
        return decoded

    @staticmethod
    def _meta(doc: dict | None) -> tuple[str, int]:
        if not isinstance(doc, dict):
            return "", 0
        fence = str(doc.get(_FACTORY_FENCE_FIELD) or "")
        try:
            epoch = max(0, int(doc.get(_RESET_EPOCH_FIELD, 0) or 0))
        except (TypeError, ValueError) as exc:
            raise ValueError("batch-job reset epoch is invalid") from exc
        return fence, epoch

    @staticmethod
    def _encode(
        jobs: dict[str, BatchJob], *, factory_fence: str, reset_epoch: int
    ) -> dict[str, Any]:
        return {
            "jobs": {
                jid: job.model_dump(mode="json") for jid, job in jobs.items()
            },
            _FACTORY_FENCE_FIELD: factory_fence,
            _RESET_EPOCH_FIELD: max(0, int(reset_epoch)),
        }

    async def _mutate(self, change: Callable[[dict[str, BatchJob]], _T]) -> _T:
        box: dict[str, _T] = {}

        # Factory reset owns a strict cross-process fence in the operator Jobs
        # registry. Check it before every Batch mutation, then re-check after the CAS:
        # a worker that loaded a pre-reset Batch row may never recreate it after the
        # destructive clear. The second check detects a fence acquired in the narrow
        # cross-document window; its write is then erased by the factory Batch clear,
        # while surfacing an error prevents the stale caller from claiming success.
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        jobs_fence_before = await getter(JOBS_NS, JOBS_KEY)
        if isinstance(jobs_fence_before, dict) and str(
            jobs_fence_before.get("factory_fence") or ""
        ):
            raise RuntimeError("factory reset is in progress; Batch mutation is fenced")

        admitted_doc = await getter(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        admitted_fence, admitted_epoch = self._meta(admitted_doc)
        if admitted_fence:
            raise RuntimeError("factory reset is in progress; Batch mutation is fenced")

        def _mutator(current: dict | None) -> dict:
            current_fence, current_epoch = self._meta(current)
            if current_fence or current_epoch != admitted_epoch:
                raise RuntimeError(
                    "factory reset changed the Batch registry before mutation"
                )
            jobs = self._decode(current)
            # Any confirmed mutation opportunistically migrates historical terminal
            # rows to the bounded aggregate shape and trims oldest terminal history.
            # Active rows are never evicted.
            for existing in jobs.values():
                _compact_terminal(existing)
            if len(jobs) > _MAX_JOBS:
                terminal = sorted(
                    (
                        row
                        for row in jobs.values()
                        if row.terminal_compacted
                    ),
                    key=lambda row: (row.submitted_at or "", row.id),
                )
                for old in terminal[: len(jobs) - _MAX_JOBS]:
                    jobs.pop(old.id, None)
            box["r"] = change(jobs)
            return self._encode(
                jobs,
                factory_fence=current_fence,
                reset_epoch=current_epoch,
            )

        await kv_mutate_strict(
            self._kv, BATCH_JOBS_NS, BATCH_JOBS_KEY, _mutator, lock=self._lock
        )
        jobs_fence_after = await getter(JOBS_NS, JOBS_KEY)
        if isinstance(jobs_fence_after, dict) and str(
            jobs_fence_after.get("factory_fence") or ""
        ):
            raise RuntimeError("factory reset began during Batch mutation")
        return box.get("r")  # type: ignore[return-value]

    async def begin_factory_fence(self, owner: str) -> int:
        """Atomically fence Batch writes and invalidate every admitted old mutator."""
        owner = str(owner or "").strip()
        if not owner:
            raise ValueError("factory fence owner is required")
        box: dict[str, int] = {}

        def _mutator(current: dict | None) -> dict[str, Any]:
            fence, epoch = self._meta(current)
            if fence != owner:
                # The Jobs runner transfers this only after its own registry fence
                # points at ``owner``. Bump the generation so every closure admitted
                # by the prior reset attempt becomes stale.
                epoch += 1
            box["epoch"] = epoch
            return self._encode(
                self._decode(current),
                factory_fence=owner,
                reset_epoch=epoch,
            )

        await kv_mutate_strict(
            self._kv,
            BATCH_JOBS_NS,
            BATCH_JOBS_KEY,
            _mutator,
            lock=self._lock,
        )
        return box["epoch"]

    async def clear_all_strict(self, *, factory_owner: str | None = None) -> int:
        """Clear Batch rows and bump the same-document reset generation.

        A mutator admitted before this CAS carries the previous epoch and therefore
        fails inside its own CAS instead of recreating pre-reset provider state.
        Factory callers must own the durable Batch fence; cases/sources resets use an
        unfenced epoch bump and remain safe against an already-admitted mutation.
        """
        owner = str(factory_owner or "").strip()
        box: dict[str, int] = {}

        def _mutator(current: dict | None) -> dict[str, Any]:
            fence, epoch = self._meta(current)
            if owner:
                if fence != owner:
                    raise RuntimeError("factory Batch fence ownership changed")
            elif fence:
                raise RuntimeError("factory reset owns the Batch registry fence")
            box["removed"] = len(self._decode(current))
            return self._encode(
                {},
                factory_fence=fence,
                reset_epoch=epoch + 1,
            )

        await kv_mutate_strict(
            self._kv,
            BATCH_JOBS_NS,
            BATCH_JOBS_KEY,
            _mutator,
            lock=self._lock,
        )
        return box["removed"]

    async def release_factory_fence(self, owner: str) -> None:
        """Release only the caller-owned fence while retaining the reset epoch."""
        owner = str(owner or "").strip()
        if not owner:
            raise ValueError("factory fence owner is required")

        def _mutator(current: dict | None) -> dict[str, Any]:
            fence, epoch = self._meta(current)
            if fence != owner:
                raise RuntimeError("factory Batch fence ownership changed")
            return self._encode(
                self._decode(current),
                factory_fence="",
                reset_epoch=epoch,
            )

        await kv_mutate_strict(
            self._kv,
            BATCH_JOBS_NS,
            BATCH_JOBS_KEY,
            _mutator,
            lock=self._lock,
        )

    # -- CRUD ---------------------------------------------------------------- #
    async def save(self, job: BatchJob) -> BatchJob:
        """Upsert a job (submit / after a poll). Returns the stored job."""
        def _change(jobs: dict[str, BatchJob]) -> BatchJob:
            _compact_terminal(job)
            jobs[job.id] = job
            return job
        return await self._mutate(_change)

    async def create_if_absent(self, job: BatchJob) -> tuple[BatchJob, bool]:
        """Atomically persist a new outbox intent.

        Returns ``(stored_job, created)``. The single-document strict CAS makes
        concurrent identical submitters converge before either calls the provider.
        """
        def _change(jobs: dict[str, BatchJob]) -> tuple[BatchJob, bool]:
            existing = jobs.get(job.id)
            if existing is not None:
                return existing, False
            if len(jobs) >= _MAX_JOBS:
                terminal = sorted(
                    (
                        row
                        for row in jobs.values()
                        if row.state
                        in {
                            BatchJobState.RETRIEVED,
                            BatchJobState.ERRORED,
                            BatchJobState.EXPIRED,
                        }
                        and (row.terminal_compacted or self._all_complete(row))
                    ),
                    key=lambda row: (row.submitted_at or "", row.id),
                )
                for old in terminal[: max(0, len(jobs) - _MAX_JOBS + 1)]:
                    jobs.pop(old.id, None)
            if len(jobs) >= _MAX_JOBS:
                raise RuntimeError("batch-job registry capacity is exhausted")
            jobs[job.id] = job
            return job, True

        return await self._mutate(_change)

    async def claim_submission(self, job_id: str) -> tuple[BatchJob | None, str | None]:
        """Atomically lease one unresolved local outbox for provider submission.

        Immediate ``submit()`` and scheduler ``poll()`` both enter through this
        transition.  Exactly one active claimant receives a token; every other worker
        receives the current durable row and performs no provider call.  A process
        crash leaves a bounded lease that a later scheduler pass may reclaim.
        ``submit_attempts`` counts actual leased provider attempts, not contenders.
        """
        jid = (job_id or "").strip()
        now_ms = int(time.time() * 1000)

        def _change(
            jobs: dict[str, BatchJob],
        ) -> tuple[BatchJob | None, str | None]:
            job = jobs.get(jid)
            if job is None or job.provider_batch_id or not job.requests:
                return job, None
            leased_at = int(job.submission_lease_at_millis or 0)
            active = bool(job.submission_lease_token) and (
                now_ms - leased_at < _SUBMISSION_LEASE_MILLIS
            )
            if active:
                return job, None
            token = uuid.uuid4().hex
            job.submission_lease_token = token
            job.submission_lease_at_millis = now_ms
            job.submit_attempts = int(job.submit_attempts or 0) + 1
            jobs[jid] = job
            return job, token

        return await self._mutate(_change)

    async def fail_submission(
        self, job_id: str, token: str, error: str
    ) -> BatchJob | None:
        """Release an owned submission lease after a provider failure.

        The outbox remains scheduler-open and the bounded error remains visible.  A
        stale worker cannot clear or overwrite a newer claimant's lease.
        """
        jid = (job_id or "").strip()
        message = str(error or "batch provider submission failed")[:500]

        def _change(jobs: dict[str, BatchJob]) -> BatchJob | None:
            job = jobs.get(jid)
            if job is None:
                return None
            if job.submission_lease_token != token:
                raise RuntimeError(
                    "batch submission lease ownership changed before failure was recorded"
                )
            job.state = BatchJobState.SUBMITTED
            job.last_error = message
            job.submission_lease_token = None
            job.submission_lease_at_millis = 0
            jobs[jid] = job
            return job

        return await self._mutate(_change)

    async def complete_submission(
        self, job_id: str, token: str, remote: BatchJob
    ) -> BatchJob | None:
        """Persist provider acceptance only for the worker owning ``token``.

        Provider state is merged into the latest durable outbox inside the same strict
        compare-and-set, preserving any tracking metadata added while the network call
        was in flight.  Storage errors propagate; an unconfirmed provider id is never
        reported as a successful local transition.
        """
        jid = (job_id or "").strip()

        def _change(jobs: dict[str, BatchJob]) -> BatchJob | None:
            job = jobs.get(jid)
            if job is None:
                return None
            if job.submission_lease_token != token:
                raise RuntimeError(
                    "batch submission lease ownership changed before acceptance was recorded"
                )
            job.provider = remote.provider or job.provider
            job.provider_batch_id = remote.provider_batch_id
            job.model = remote.model or job.model
            job.state = remote.state
            job.discount = remote.discount
            job.submitted_at = remote.submitted_at or job.submitted_at
            job.polled_at = remote.polled_at or job.polled_at
            merged_tracking: dict[str, dict[str, Any]] = {}
            for cid in set(job.custom_ids) | set(remote.custom_ids):
                merged_tracking[cid] = {
                    **dict(job.custom_ids.get(cid) or {}),
                    **dict(remote.custom_ids.get(cid) or {}),
                }
            job.custom_ids = merged_tracking
            job.last_error = None
            job.submission_lease_token = None
            job.submission_lease_at_millis = 0
            jobs[jid] = job
            return job

        return await self._mutate(_change)

    async def get(self, job_id: str) -> BatchJob | None:
        return (await self._load_all()).get((job_id or "").strip())

    async def get_strict(self, job_id: str) -> BatchJob | None:
        """Confirmed read for submission/re-entry decisions; errors propagate."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        return self._decode(doc).get((job_id or "").strip())

    async def list(self) -> list[BatchJob]:
        return list((await self._load_all()).values())

    async def list_strict(self) -> list[BatchJob]:
        """List jobs or propagate storage failure; never confuse outage with empty."""
        return list((await self._load_all_strict()).values())

    async def set_inbox_audience(
        self,
        job_id: str,
        audience: list[BatchInboxAudience],
        *,
        truncated: int = 0,
    ) -> BatchJob | None:
        """Persist the first strict audience snapshot for a new Batch job.

        ``legacy`` rows are deliberately immutable/list-only. A retry may fill only a
        ``pending`` row, so newly granted users can never be added after the original
        snapshot succeeded.
        """

        def _change(jobs: dict[str, BatchJob]) -> BatchJob | None:
            job = jobs.get(job_id)
            if job is None or job.inbox_audience_state != "pending":
                return job
            job.inbox_audience = list(audience)[:200]
            job.inbox_audience_truncated = max(0, int(truncated))
            job.inbox_audience_state = "ready"
            jobs[job_id] = job
            return job

        return await self._mutate(_change)

    async def mark_inbox_projection(
        self,
        job_id: str,
        username: str,
        account_generation: str,
        *,
        state: str,
        signature: str = "",
    ) -> BatchJob | None:
        """Acknowledge one confirmed Inbox upsert/removal inside the Batch outbox."""
        if state not in {"pending", "projected", "revoked"}:
            raise ValueError("invalid Batch Inbox projection state")
        needle = username.strip().lower()

        def _change(jobs: dict[str, BatchJob]) -> BatchJob | None:
            job = jobs.get(job_id)
            if job is None or job.inbox_audience_state != "ready":
                return job
            for index, member in enumerate(job.inbox_audience):
                if (
                    member.username.strip().lower() == needle
                    and member.account_generation == account_generation
                ):
                    job.inbox_audience[index] = member.model_copy(
                        update={
                            "state": state,
                            "projection_signature": signature if state == "projected" else "",
                        }
                    )
                    jobs[job_id] = job
                    return job
            return job

        return await self._mutate(_change)

    async def delete(self, job_id: str) -> bool:
        jid = (job_id or "").strip()

        def _change(jobs: dict[str, BatchJob]) -> bool:
            if jid not in jobs:
                return False
            del jobs[jid]
            return True
        return await self._mutate(_change)

    async def load_open_jobs(self) -> list[BatchJob]:
        """Every job NOT yet fully retrieved — i.e. still ``submitted``/``polling``/
        ``retrieving`` OR ``retrieved`` but with a custom_id still un-retrieved. This
        is the resume seam: a fresh process reloads these and continues polling +
        folding results. A job whose state is a terminal ``retrieved`` with every
        custom_id retrieved (or ``errored``/``expired``) is considered closed."""
        open_jobs: list[BatchJob] = []
        for job in (await self._load_all()).values():
            if job.state in (BatchJobState.ERRORED, BatchJobState.EXPIRED):
                continue
            if job.state == BatchJobState.RETRIEVED and self._all_complete(job):
                continue
            open_jobs.append(job)
        return open_jobs

    @staticmethod
    def _all_complete(job: BatchJob) -> bool:
        if job.terminal_compacted and job.state == BatchJobState.RETRIEVED:
            return True
        tracked = {k: v for k, v in job.custom_ids.items() if k != "__meta__"}
        if not tracked:
            return False
        return all(
            bool(v.get("retrieved"))
            and str(v.get("reentry_state") or "not_required")
            not in {"pending", "processing"}
            for v in tracked.values()
        )

    _all_retrieved = _all_complete

    async def is_retrieved(self, job_id: str, custom_id: str) -> bool:
        job = await self.get(job_id)
        if job is None:
            return False
        entry = job.custom_ids.get(custom_id) or {}
        return bool(entry.get("retrieved"))

    # -- result folding (exactly-once ledger, #6) ---------------------------- #
    async def process_results(
        self,
        job: BatchJob,
        results: Iterable[Any],
        gateway: Any,
        *,
        role: str = "investigator",
        surface: str = "batch",
    ) -> list[Any]:
        """Fold a batch's results back through the ONE gateway ledger, exactly once.

        For each result (a :class:`app.llm.batch.BatchResult`-shaped object keyed by
        ``custom_id``): if its ``custom_id`` is already marked ``retrieved`` on THIS
        job it is SKIPPED (dedup → exactly-once #6); otherwise ``gateway._record`` is
        called ONCE — OK rows at the 0.5× batch rate (``batch=True``) with the result's
        token + cache counts, error/expired rows as an ERROR outcome. Returns the list of
        results that were newly recorded (skipped duplicates excluded) so the caller can
        fold verdict text into cases. NEVER calls ``decide()`` (#3).

        LEASED CLAIM (FINDING #3, #6): each unresolved id receives a short recording
        lease inside one KV compare-and-set. Crucially, ``retrieved`` remains False until
        the gateway's strict, idempotent ledger write succeeds. A write failure releases
        the lease so the result retries; a process crash leaves a bounded stale lease that
        can be reclaimed. Concurrent workers cannot record the same active lease, while
        the ledger idempotency key makes a post-write/pre-finalize retry safe."""
        # Index this batch's results by custom_id (first occurrence wins), so a claimed id
        # maps back to exactly one result to bill.
        by_id: dict[str, Any] = {}
        for res in results:
            cid = str(getattr(res, "custom_id", "")).strip()
            if cid and cid not in by_id:
                by_id[cid] = res
        if not by_id:
            return []

        states = {cid: str(getattr(res, "result_type", "succeeded")) for cid, res in by_id.items()}
        leases = await self._lease_claim(job.id, states)

        recorded: list[Any] = []
        for cid, lease_token in leases.items():
            res = by_id.get(cid)
            if res is None:
                await self._fail_ledger_lease(
                    job.id,
                    cid,
                    lease_token,
                    "provider result disappeared before ledger fold",
                )
                continue
            rtype = states.get(cid, "succeeded")
            case_id = self._case_id_for(job, cid)
            ledger_key = f"batch:{job.id}:{cid}"
            try:
                if rtype == "succeeded":
                    await gateway._record(
                        role, surface, case_id, getattr(res, "model", "") or job.model,
                        int(getattr(res, "prompt_tokens", 0) or 0),
                        int(getattr(res, "completion_tokens", 0) or 0),
                        0, UsageOutcome.OK, None,
                        cache_read_tokens=int(getattr(res, "cache_read_tokens", 0) or 0),
                        cache_write_tokens=int(getattr(res, "cache_write_tokens", 0) or 0),
                        batch=True,
                        idempotency_key=ledger_key,
                        require_persistence=True,
                    )
                else:
                    # errored / expired is still one resolved, metered outcome.
                    await gateway._record(
                        role, surface, case_id, getattr(res, "model", "") or job.model,
                        0, 0, 0, UsageOutcome.ERROR, 0.0,
                        batch=True,
                        idempotency_key=ledger_key,
                        require_persistence=True,
                    )
            except Exception as exc:  # noqa: BLE001 - leave unretrieved for retry
                logger.warning(
                    "Batch usage persistence failed (job=%s custom_id=%s): %s",
                    job.id,
                    cid,
                    exc,
                )
                await self._fail_ledger_lease(
                    job.id, cid, lease_token, f"usage persistence failed: {exc}"
                )
                continue
            finalised = await self._finalize_lease(
                job.id, cid, lease_token, rtype
            )
            if finalised and rtype == "succeeded":
                recorded.append(res)
        return recorded

    @staticmethod
    def _case_id_for(job: BatchJob, custom_id: str) -> str | None:
        """The case_id a batch request maps to, if the submit recorded one under the
        custom_id tracking meta (``{case_id: ...}``). None otherwise — the ledger row
        is still written, just not case-scoped."""
        entry = job.custom_ids.get(custom_id) or {}
        cid = entry.get("case_id")
        return str(cid) if cid else None

    async def _lease_claim(self, job_id: str, states: dict[str, str]) -> dict[str, str]:
        """Lease unresolved ids without marking them retrieved."""
        now_ms = int(time.time() * 1000)

        def _change(jobs: dict[str, BatchJob]) -> dict[str, str]:
            job = jobs.get(job_id)
            # A fully folded terminal row intentionally scrubs its potentially huge
            # custom-id map. The aggregate marker is authoritative: provider retries
            # after compaction are already accounted for and must not recreate a
            # tracking entry or re-enter the ledger/pipeline.
            if job is None or job.terminal_compacted:
                return {}
            tracking = dict(job.custom_ids)
            claimed: dict[str, str] = {}
            for cid, rstate in states.items():
                entry = dict(tracking.get(cid) or {})
                if entry.get("retrieved"):
                    continue
                leased_at = int(entry.get("recording_at_millis", 0) or 0)
                active = bool(entry.get("recording_token")) and (
                    now_ms - leased_at < _RECORDING_LEASE_MILLIS
                )
                if active:
                    continue
                token = uuid.uuid4().hex
                entry["recording_token"] = token
                entry["recording_at_millis"] = now_ms
                entry["pending_result_state"] = rstate
                tracking[cid] = entry
                claimed[cid] = token
            if not claimed:
                return {}
            job.custom_ids = tracking
            jobs[job_id] = job
            return claimed
        return await self._mutate(_change)

    async def _release_lease(self, job_id: str, custom_id: str, token: str) -> bool:
        """Release only the lease owned by ``token``; leave the result retryable."""
        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("recording_token") != token or entry.get("retrieved"):
                return False
            entry.pop("recording_token", None)
            entry.pop("recording_at_millis", None)
            entry.pop("pending_result_state", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def _fail_ledger_lease(
        self, job_id: str, custom_id: str, token: str, error: str
    ) -> bool:
        """Release a failed ledger lease and expose the bounded failure on the job."""
        message = str(error or "batch ledger persistence failed")[:500]

        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("recording_token") != token or entry.get("retrieved"):
                return False
            entry.pop("recording_token", None)
            entry.pop("recording_at_millis", None)
            entry.pop("pending_result_state", None)
            entry["last_error"] = message
            tracking[custom_id] = entry
            job.custom_ids = tracking
            job.last_error = message
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def _finalize_lease(
        self, job_id: str, custom_id: str, token: str, result_state: str
    ) -> bool:
        """Mark retrieval complete only after the strict ledger write succeeded."""
        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("recording_token") != token or entry.get("retrieved"):
                return False
            entry["retrieved"] = True
            entry["result_state"] = result_state
            entry.pop("last_error", None)
            if result_state == "succeeded" and custom_id in job.candidates:
                entry["reentry_state"] = "pending"
            else:
                entry["reentry_state"] = "not_required"
            entry.pop("recording_token", None)
            entry.pop("recording_at_millis", None)
            entry.pop("pending_result_state", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            # A retry that succeeds must clear the operator-visible failure. Preserve
            # another result's outstanding error, if any, instead of leaving this
            # job permanently red after recovery.
            job.last_error = next(
                (
                    str(item.get("last_error"))[:500]
                    for item in tracking.values()
                    if isinstance(item, dict) and item.get("last_error")
                ),
                None,
            )
            if BatchJobStore._all_complete(job):
                job.state = BatchJobState.RETRIEVED
                _compact_terminal(job)
            else:
                job.state = BatchJobState.RETRIEVING
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def claim_reentries(
        self, job_id: str, custom_ids: Iterable[str]
    ) -> dict[str, str]:
        """Lease ledger-recorded detection results that still need case re-entry."""
        wanted = {str(cid).strip() for cid in custom_ids if str(cid).strip()}
        now_ms = int(time.time() * 1000)

        def _change(jobs: dict[str, BatchJob]) -> dict[str, str]:
            job = jobs.get(job_id)
            if job is None:
                return {}
            tracking = dict(job.custom_ids)
            claimed: dict[str, str] = {}
            for cid in wanted:
                entry = dict(tracking.get(cid) or {})
                if not entry.get("retrieved") or cid not in job.candidates:
                    continue
                state = str(entry.get("reentry_state") or "pending")
                if state == "complete":
                    continue
                leased_at = int(entry.get("reentry_at_millis", 0) or 0)
                active = bool(entry.get("reentry_token")) and (
                    now_ms - leased_at < _RECORDING_LEASE_MILLIS
                )
                if active:
                    continue
                token = uuid.uuid4().hex
                entry["reentry_state"] = "processing"
                entry["reentry_token"] = token
                entry["reentry_at_millis"] = now_ms
                tracking[cid] = entry
                claimed[cid] = token
            if claimed:
                job.custom_ids = tracking
                jobs[job_id] = job
            return claimed

        return await self._mutate(_change)

    async def fail_reentry(
        self, job_id: str, custom_id: str, token: str, error: str
    ) -> bool:
        """Return an owned re-entry lease to pending and retain a visible error."""
        message = str(error or "detection re-entry failed")[:500]

        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("reentry_token") != token:
                return False
            entry["reentry_state"] = "pending"
            entry["last_error"] = message
            entry.pop("reentry_token", None)
            entry.pop("reentry_at_millis", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            job.last_error = message
            job.state = BatchJobState.RETRIEVING
            jobs[job_id] = job
            return True

        return await self._mutate(_change)

    async def complete_reentry(
        self, job_id: str, custom_id: str, token: str
    ) -> bool:
        """Confirm case-pipeline handoff completion for one leased detection result."""
        def _change(jobs: dict[str, BatchJob]) -> bool:
            job = jobs.get(job_id)
            if job is None:
                return False
            tracking = dict(job.custom_ids)
            entry = dict(tracking.get(custom_id) or {})
            if entry.get("reentry_token") != token:
                return False
            entry["reentry_state"] = "complete"
            entry.pop("reentry_token", None)
            entry.pop("reentry_at_millis", None)
            entry.pop("last_error", None)
            tracking[custom_id] = entry
            job.custom_ids = tracking
            if BatchJobStore._all_complete(job):
                job.state = BatchJobState.RETRIEVED
                job.last_error = None
                _compact_terminal(job)
            jobs[job_id] = job
            return True

        return await self._mutate(_change)
