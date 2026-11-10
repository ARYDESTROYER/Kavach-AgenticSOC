"""Strict-CAS durable registry for server-owned operator jobs.

The registry uses one document in the existing state-backend KV.  It deliberately
does not add an Elasticsearch index, SQL table, or migration.  Every mutation is a
confirmed compare-and-set, including worker leases, per-item completion, cancellation,
and transition-audit reconciliation.

Forward compatibility (an N to N-1 rollback): a well-formed row whose ``kind`` this
build does not know was written by a newer build. It is tolerated and preserved
byte-stable through every write, never run, listed or cancelled here, counted toward
capacity, and pruned like any other row once terminal (:func:`_is_forward_record`).
Only a corrupt row (not an object, or missing what makes it a job) still makes the
registry fail closed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from collections.abc import Callable
from typing import Any, TypeVar

from ..constants import JOBS_KEY, JOBS_NS, JobKind, JobStatus
from ..models import (
    Job,
    JobArtifact,
    JobFailure,
    JobPublic,
    JobResult,
    JobTransition,
)
from ..utils import iso_now
from .base import KVStore, kv_mutate_strict

_T = TypeVar("_T")

MAX_JOBS = 1000
MAX_FAILURES = 20
MAX_REGISTRY_PARAM_BYTES = 8 * 1024 * 1024
MAX_RETAINED_ARTIFACTS = 50
TERMINAL_STATUSES = frozenset(
    {JobStatus.SUCCEEDED, JobStatus.PARTIAL, JobStatus.FAILED, JobStatus.CANCELLED}
)
_RETRY_SAFE_KINDS = frozenset(
    {
        JobKind.DATA_EXPORT_ARCHIVE,
        JobKind.DATA_EXPORT_SEGMENT,
        JobKind.PRECEDENT_BOOTSTRAP,
        JobKind.RUNBOOK_REINDEX,
        # A corpus rebuild is genuinely idempotent: it is staged-then-verified,
        # uses stable document ids (so a repeat converges on the identical corpus
        # rather than duplicating it), and preserves the existing corpus on failure.
        JobKind.RAG_REBUILD,
        # A read-only audit export rewrites its whole file under a fresh artifact
        # reservation on every attempt (Round 14 SPEC §4.5.6).
        JobKind.AUDIT_EXPORT,
    }
)
#: Kinds a person may have only one of queued or running at a time (Round 14 SPEC
#: §4.5.6: an audit export answers ``429 job_busy`` while the actor already has one).
ONE_ACTIVE_PER_ACTOR_KINDS = frozenset({JobKind.AUDIT_EXPORT})
#: Kinds whose progress the handler reports itself (events written, not items done),
#: so the item journal never overwrites it.
_HANDLER_PROGRESS_KINDS = frozenset({JobKind.AUDIT_EXPORT})
#: The file types a job artifact may be: the data export ZIPs and the plain audit
#: export files (CSV and JSON Lines, never zipped).
ARTIFACT_SUFFIXES = frozenset({".zip", ".csv", ".ndjson"})
#: The refusal of any job but a fresh factory reset retry while a failed factory
#: reset holds the recovery fence (the submit route answers it before writing an
#: audit row; the create below stays the authority for a racing submit).
FACTORY_RECOVERY_REFUSAL = (
    "factory reset recovery is in progress; only a fresh factory reset retry may be "
    "submitted"
)


#: The job kinds this build knows. A stored row of any other kind is a FORWARD record
#: (written by a newer build) when it is otherwise well formed (:func:`_is_forward_record`).
_KNOWN_KIND_VALUES = frozenset(kind.value for kind in JobKind)
_TERMINAL_STATUS_VALUES = frozenset(status.value for status in TERMINAL_STATUSES)


def _is_forward_record(job_id: str, payload: Any) -> bool:
    """Whether ``payload`` is a well-formed job record of a kind this build does not
    know: a FORWARD record a newer build wrote (an N to N-1 rollback finds them).

    Well formed means it is a job at all: an object whose ``job_id`` is its registry
    key and whose ``kind``, ``status`` and ``created_at`` are non-empty strings, with
    the optional envelope fields this build reads for capacity, pruning, artifact
    protection and idempotency of the right type. The kind, the status and every
    other field are the newer build's business and are never interpreted further.

    A forward record is carried byte-stable through every registry write, never run,
    listed or cancelled by this build, counted toward capacity, and pruned like any
    other row once its status is terminal. A row that fails this test and does not
    validate as a :class:`Job` is CORRUPT, and a registry holding one still fails
    closed."""
    if not isinstance(payload, dict):
        return False
    kind = payload.get("kind")
    if not isinstance(kind, str) or not kind or kind in _KNOWN_KIND_VALUES:
        return False
    if payload.get("job_id") != job_id or not job_id:
        return False
    for name in ("status", "created_at"):
        value = payload.get(name)
        if not isinstance(value, str) or not value:
            return False
    for name in ("actor", "actor_generation", "idempotency_key_hash"):
        if not isinstance(payload.get(name, ""), str):
            return False
    for name in ("finished_at", "pending_artifact_id"):
        if payload.get(name) is not None and not isinstance(payload.get(name), str):
            return False
    for name in ("artifact", "params"):
        if payload.get(name) is not None and not isinstance(payload.get(name), dict):
            return False
    return True


def _forward_terminal(payload: dict[str, Any]) -> bool:
    """Whether a forward record's status is one this build knows to be terminal (an
    unknown status is never assumed finished, so it is never pruned)."""
    return str(payload.get("status") or "") in _TERMINAL_STATUS_VALUES


def _forward_artifact(payload: dict[str, Any]) -> JobArtifact | None:
    """A forward record's attached artifact as this build's metadata, or ``None``
    (absent, or a shape this build cannot read; the orphan sweep then owns it)."""
    raw = payload.get("artifact")
    if not isinstance(raw, dict):
        return None
    try:
        return JobArtifact.model_validate(raw)
    except Exception:  # noqa: BLE001 - a newer artifact shape is not this build's file
        return None


def _forward_artifact_ids(payload: dict[str, Any]) -> set[str]:
    """The artifact identities a forward record holds (attached and reserved), so the
    orphan sweep never deletes a newer build's file."""
    out: set[str] = set()
    artifact = payload.get("artifact")
    if isinstance(artifact, dict) and isinstance(artifact.get("artifact_id"), str):
        out.add(artifact["artifact_id"])
    pending = payload.get("pending_artifact_id")
    if isinstance(pending, str):
        out.add(pending)
    return {value for value in out if value}


class _Registry:
    """One decoded registry document: the jobs this build knows, the idempotency
    bindings (of known and forward rows), the forward records (kept raw, written back
    verbatim) and the factory fence."""

    __slots__ = ("jobs", "keys", "forward", "fence")

    def __init__(
        self,
        jobs: dict[str, Job],
        keys: dict[str, str],
        forward: dict[str, dict[str, Any]],
        fence: str,
    ) -> None:
        self.jobs = jobs
        self.keys = keys
        self.forward = forward
        self.fence = fence


class JobConflict(RuntimeError):
    """An idempotency key is bound to a materially different request."""


class JobCapacityError(RuntimeError):
    """The registry is full and contains no terminal record safe to prune."""


class JobBusy(RuntimeError):
    """The actor already has a queued or running job of a one-at-a-time kind."""


def idempotency_hash(
    actor: str, idempotency_key: str, actor_generation: str = ""
) -> str:
    material = (
        f"{(actor or '').strip().lower()}\0{actor_generation}\0{idempotency_key}"
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _json_size(value: Any) -> int:
    return len(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    )


#: The structured filter keys an audit export carries (the read API's names).
_AUDIT_EXPORT_FILTER_KEYS: tuple[str, ...] = (
    "action", "event", "actor", "actor_contains", "actor_kind", "outcome", "surface",
    "case_id", "source_id", "target", "ip",
)


def _audit_export_params(raw: dict[str, Any]) -> dict[str, Any]:
    """The audit export's own question, bounded: format, scope, the absolute range,
    the order, the structured filters and the search text. All of it is the actor's
    own input (the projection is self-scoped); nothing is secret."""
    filters_in = raw.get("filters") if isinstance(raw.get("filters"), dict) else {}
    filters = {
        key: str(filters_in[key])[:256]
        for key in _AUDIT_EXPORT_FILTER_KEYS
        if isinstance(filters_in.get(key), str) and filters_in.get(key)
    }
    out: dict[str, Any] = {
        "format": str(raw.get("format") or "")[:8],
        "scope": str(raw.get("scope") or "")[:8],
        "from": str(raw.get("from") or "")[:40],
        "to": str(raw.get("to") or "")[:40],
        "order": str(raw.get("order") or "asc")[:4],
        "filters": filters,
    }
    if isinstance(raw.get("q"), str) and raw.get("q"):
        out["q"] = str(raw["q"])[:200]
    return out


def public_job(job: Job) -> JobPublic:
    """Return the bounded, secret-free/self-scoped wire projection."""
    params: dict[str, Any]
    kind = job.kind.value
    raw = job.params
    if kind == "case_reinvestigate":
        ids = list(raw.get("case_ids") or [])
        params = {
            "case_count": int(raw.get("case_count", len(ids)) or 0),
            "model": raw.get("model"),
        }
    elif kind == "case_lifecycle":
        ids = list(raw.get("case_ids") or [])
        params = {
            "case_count": int(raw.get("case_count", len(ids)) or 0),
            "action": raw.get("action"),
        }
    elif kind == "case_assign":
        params = {
            "case_count": int(
                raw.get("case_count", len(list(raw.get("case_ids") or []))) or 0
            ),
            "assignee": raw.get("assignee"),
        }
    elif kind == "case_tag":
        params = {
            "case_count": int(
                raw.get("case_count", len(list(raw.get("case_ids") or []))) or 0
            ),
            "tag": raw.get("tag"),
        }
    elif kind in {"data_export_archive", "data_export_segment"}:
        params = {
            "scopes": list(raw.get("scopes") or []),
            **({"page_size": raw.get("page_size")} if raw.get("page_size") else {}),
        }
    elif kind == "precedent_bootstrap":
        params = {
            "limit": raw.get("limit"),
            "dry_run": bool(raw.get("dry_run")),
        }
    elif kind == "runbook_reindex":
        params = {"runbook_id": raw.get("runbook_id")}
    elif kind == "rag_import":
        params = {
            "document_count": int(
                raw.get("document_count", len(list(raw.get("documents") or [])))
            )
        }
    elif kind == "rag_rebuild":
        params = {}
    elif kind == "tiered_reset":
        params = {"scope": raw.get("scope")}
    elif kind == "storage_lifecycle_apply":
        params = {"acknowledge": bool(raw.get("acknowledge"))}
    elif kind == "replay_experiment":
        params = {
            "fixture_count": len(list(raw.get("fixture_ids") or [])),
            "arm_ids": [
                str(arm.get("arm_id") or "")
                for arm in (raw.get("arms") or [])
                if isinstance(arm, dict)
            ],
            "repeats": raw.get("repeats"),
            "spend_bound_usd": raw.get("spend_bound_usd"),
        }
    elif kind == "audit_export":
        params = _audit_export_params(raw)
    else:  # pragma: no cover - JobKind makes this unreachable
        params = {}
    return JobPublic(
        job_id=job.job_id,
        kind=job.kind,
        actor=job.actor,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        status=job.status,
        progress=job.progress,
        failures=list(job.failures),
        failure_count=job.failure_count,
        failures_truncated=job.failures_truncated,
        request_fingerprint=job.request_fingerprint,
        result=job.result,
        params=params,
        cancel_requested=job.cancel_requested,
    )


def _compact_params(job: Job) -> dict[str, Any]:
    """Preserve only the bounded display summary after resumable input is spent."""
    raw = job.params
    kind = job.kind
    if kind == JobKind.CASE_REINVESTIGATE:
        return {
            "case_count": int(raw.get("case_count", len(raw.get("case_ids") or []))),
            "model": raw.get("model"),
        }
    if kind == JobKind.CASE_LIFECYCLE:
        return {
            "case_count": int(raw.get("case_count", len(raw.get("case_ids") or []))),
            "action": raw.get("action"),
        }
    if kind == JobKind.CASE_ASSIGN:
        return {
            "case_count": int(raw.get("case_count", len(raw.get("case_ids") or []))),
            "assignee": str(raw.get("assignee") or "")[:80],
        }
    if kind == JobKind.CASE_TAG:
        return {
            "case_count": int(raw.get("case_count", len(raw.get("case_ids") or []))),
            "tag": str(raw.get("tag") or "")[:40],
        }
    if kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        out: dict[str, Any] = {"scopes": list(raw.get("scopes") or [])[:20]}
        if raw.get("page_size"):
            out["page_size"] = int(raw["page_size"])
        return out
    if kind == JobKind.PRECEDENT_BOOTSTRAP:
        return {"limit": int(raw.get("limit") or 0), "dry_run": bool(raw.get("dry_run"))}
    if kind == JobKind.RUNBOOK_REINDEX:
        return {"runbook_id": str(raw.get("runbook_id") or "")[:160] or None}
    if kind == JobKind.RAG_IMPORT:
        return {
            "document_count": int(
                raw.get("document_count", len(list(raw.get("documents") or [])))
            )
        }
    if kind == JobKind.RAG_REBUILD:
        return {}
    if kind == JobKind.TIERED_RESET:
        return {"scope": str(raw.get("scope") or "")[:20]}
    if kind == JobKind.STORAGE_LIFECYCLE_APPLY:
        return {"acknowledge": bool(raw.get("acknowledge"))}
    if kind == JobKind.REPLAY_EXPERIMENT:
        return {
            "fixture_count": len(list(raw.get("fixture_ids") or [])),
            "arm_ids": [
                str(arm.get("arm_id") or "")[:40]
                for arm in (raw.get("arms") or [])
                if isinstance(arm, dict)
            ][:2],
            "repeats": int(raw.get("repeats") or 0),
            "spend_bound_usd": float(raw.get("spend_bound_usd") or 0.0),
        }
    if kind == JobKind.AUDIT_EXPORT:
        return _audit_export_params(raw)
    return {}


def _compact_terminal(job: Job, *, result: JobResult | None = None) -> None:
    """Drop every large/replayable input while retaining truthful aggregate output."""
    JobStore._recount(job)
    succeeded = sum(1 for value in job.item_states.values() if value == "succeeded")
    failed_items = sum(1 for value in job.item_states.values() if value == "failed")
    job_errors = max(0, job.failure_count - failed_items)
    if result is not None:
        counts = dict(result.counts)
        if job_errors:
            counts["job_errors"] = job_errors
        job.result = result.model_copy(update={"counts": counts})
    elif job.result is None:
        job.result = JobResult(
            kind=job.kind.value,
            counts={
                "succeeded": succeeded,
                "failed": failed_items,
                "total": job.progress.total,
                **({"job_errors": job_errors} if job_errors else {}),
            },
        )
    job.params = _compact_params(job)
    job.item_states = {}
    job.pending_artifact_id = None
    job.pending_artifact_suffix = None


class JobStore:
    """Durable CRUD, leases, item journal, and audit acknowledgement."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode_registry(doc: dict[str, Any] | None) -> tuple[_Registry, bool]:
        """Partition a registry document into known jobs, forward records and corrupt
        rows. Returns the registry and whether any row (or the jobs map itself) is
        corrupt; a forward record is never corrupt (:func:`_is_forward_record`)."""
        raw_jobs = doc.get("jobs", {}) if isinstance(doc, dict) else {}
        raw_keys = doc.get("idempotency", {}) if isinstance(doc, dict) else {}
        # An idempotency map that is present but not an object is corrupt too: treating
        # it as empty would silently drop every binding, so a retried submit with a
        # used key would start a second job. Absent (or null) still means none.
        corrupt = not isinstance(raw_jobs, dict) or (
            raw_keys is not None and not isinstance(raw_keys, dict)
        )
        jobs: dict[str, Job] = {}
        forward: dict[str, dict[str, Any]] = {}
        for job_id, payload in (raw_jobs if isinstance(raw_jobs, dict) else {}).items():
            key = str(job_id)
            if _is_forward_record(key, payload):
                forward[key] = payload  # kept as stored and written back verbatim
                continue
            try:
                jobs[key] = Job.model_validate(payload)
            except Exception:  # corrupt rows are excluded, never executed
                corrupt = True
        keys = {
            str(key): str(value)
            for key, value in (raw_keys if isinstance(raw_keys, dict) else {}).items()
            if str(value) in jobs or str(value) in forward
        }
        fence = str((doc or {}).get("factory_fence") or "") if isinstance(doc, dict) else ""
        return _Registry(jobs, keys, forward, fence), corrupt

    @staticmethod
    def _decode(doc: dict[str, Any] | None) -> tuple[dict[str, Job], dict[str, str]]:
        """The known jobs and the idempotency bindings (forward records excluded)."""
        registry, _corrupt = JobStore._decode_registry(doc)
        return registry.jobs, registry.keys

    @staticmethod
    def _decode_strict(doc: Any) -> _Registry:
        """Decode a registry document, failing closed on a corrupt one: a document
        that is not an object, a jobs map that is not an object, or a row that is
        neither a valid job nor a well-formed forward record."""
        if doc is not None and not isinstance(doc, dict):
            raise ValueError("job registry is not a JSON object")
        registry, corrupt = JobStore._decode_registry(doc)
        if corrupt:
            raise ValueError("job registry contains an invalid record")
        return registry

    @staticmethod
    def _encode(
        jobs: dict[str, Job],
        keys: dict[str, str],
        factory_fence: str = "",
        forward: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        rows: dict[str, Any] = {
            job_id: job.model_dump(mode="json") for job_id, job in jobs.items()
        }
        for job_id, payload in (forward or {}).items():
            rows.setdefault(job_id, payload)
        return {
            "jobs": rows,
            "idempotency": {key: value for key, value in keys.items() if value in rows},
            "factory_fence": factory_fence,
        }

    async def _load_strict(self) -> tuple[dict[str, Job], dict[str, str]]:
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        registry = self._decode_strict(await getter(JOBS_NS, JOBS_KEY))
        return registry.jobs, registry.keys

    async def _load_registry_strict(self) -> _Registry:
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        return self._decode_strict(await getter(JOBS_NS, JOBS_KEY))

    async def _mutate_registry(self, change: Callable[[_Registry], _T]) -> _T:
        """Strict mutation over the whole decoded registry (forward records and the
        factory fence included). ``change`` edits ``registry`` in place."""
        box: dict[str, _T] = {}

        def mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            registry = self._decode_strict(current)
            box["value"] = change(registry)
            return self._encode(
                registry.jobs, registry.keys, registry.fence, registry.forward
            )

        await kv_mutate_strict(
            self._kv, JOBS_NS, JOBS_KEY, mutate, lock=self._lock
        )
        return box["value"]

    async def _mutate(
        self, change: Callable[[dict[str, Job], dict[str, str]], _T]
    ) -> _T:
        return await self._mutate_registry(
            lambda registry: change(registry.jobs, registry.keys)
        )

    async def _mutate_meta(
        self,
        change: Callable[
            [dict[str, Job], dict[str, str], str], tuple[_T, str]
        ],
    ) -> _T:
        """Strict mutation that can atomically inspect/update the factory fence."""

        def apply(registry: _Registry) -> _T:
            value, fence = change(registry.jobs, registry.keys, registry.fence)
            registry.fence = fence
            return value

        return await self._mutate_registry(apply)

    async def create(self, job: Job) -> tuple[Job, bool, list[JobArtifact]]:
        """Reserve an actor-scoped idempotency key and prune oldest terminal rows."""

        def change(registry: _Registry) -> tuple[Job, bool, list[JobArtifact]]:
            jobs, keys, forward, fence = (
                registry.jobs, registry.keys, registry.forward, registry.fence
            )
            bound = keys.get(job.idempotency_key_hash)
            if bound:
                existing = jobs.get(bound)
                if existing is None and bound in forward:
                    # The key names a job of a kind this build does not know, so it
                    # cannot be this request (which this build validated as one of
                    # its own kinds).
                    raise JobConflict(
                        "idempotency key is already bound to a different job request"
                    )
                if existing is None:
                    raise RuntimeError("job idempotency registry is inconsistent")
                if existing.request_fingerprint != job.request_fingerprint:
                    raise JobConflict(
                        "idempotency key is already bound to a different job request"
                    )
                # A raw idempotency key names one operator intent for the complete
                # lifetime of its retained row. Delayed clients and network retries
                # can arrive arbitrarily late, so a wall-clock release would permit a
                # duplicate side effect. A deliberate repeat mints a new key; normal
                # terminal-row pruning removes the old binding atomically.
                return existing, False, []

            if job.kind in ONE_ACTIVE_PER_ACTOR_KINDS:
                actor = job.actor.strip().lower()
                if any(
                    row.kind == job.kind
                    and row.actor.strip().lower() == actor
                    and row.actor_generation == job.actor_generation
                    and row.status not in TERMINAL_STATUSES
                    for row in jobs.values()
                ):
                    raise JobBusy(
                        f"{job.kind.value} is already queued or running for this actor"
                    )

            recovery = False
            if fence:
                fenced_job = jobs.get(fence)
                has_factory_grant = any(
                    grant.resource == "users" and grant.action == "manage"
                    for grant in job.required_permissions
                )
                fresh_enough = (
                    not job.actor
                    or job.actor_generation == ""
                    or int(job.fresh_authorized_until_millis or 0)
                    > int(time.time() * 1000)
                )
                recovery = bool(
                    fenced_job is not None
                    and fenced_job.kind == JobKind.TIERED_RESET
                    and fenced_job.params == {"scope": "factory"}
                    and (
                        fenced_job.status == JobStatus.FAILED
                        or (
                            fenced_job.actor == ""
                            and not fenced_job.request_fingerprint
                            and not fenced_job.idempotency_key_hash
                            and fenced_job.status in TERMINAL_STATUSES
                        )
                    )
                    and job.kind == JobKind.TIERED_RESET
                    and job.params.get("scope") == "factory"
                    and has_factory_grant
                    and fresh_enough
                )
                if not recovery:
                    raise JobCapacityError(FACTORY_RECOVERY_REFUSAL)

            pruned: list[JobArtifact] = []
            # Forward records (kinds a newer build wrote) count toward capacity and
            # are pruned like any other row once terminal.
            while len(jobs) + len(forward) >= MAX_JOBS:
                terminal: list[tuple[tuple[str, str], str]] = [
                    ((row.finished_at or row.created_at, row.job_id), row.job_id)
                    for row in jobs.values()
                    if row.status in TERMINAL_STATUSES
                ] + [
                    (
                        (
                            str(payload.get("finished_at") or payload.get("created_at")),
                            job_id,
                        ),
                        job_id,
                    )
                    for job_id, payload in forward.items()
                    if _forward_terminal(payload)
                ]
                if not terminal:
                    raise JobCapacityError(
                        "job registry is full of active work; retry after a job finishes"
                    )
                victim_id = min(terminal)[1]
                if victim_id in forward:
                    payload = forward.pop(victim_id)
                    hashed = str(payload.get("idempotency_key_hash") or "")
                    if keys.get(hashed) == victim_id:
                        keys.pop(hashed, None)
                    forward_artifact = _forward_artifact(payload)
                    if forward_artifact is not None:
                        pruned.append(forward_artifact)
                    continue
                victim = jobs.pop(victim_id)
                if keys.get(victim.idempotency_key_hash) == victim.job_id:
                    keys.pop(victim.idempotency_key_hash, None)
                if victim.artifact is not None:
                    pruned.append(victim.artifact)
            # Artifact payloads live outside the registry in the private persistent
            # root. Keep a much tighter bound than the metadata registry itself: old
            # jobs remain visible, but their expired artifact link is removed and the
            # file is returned to the caller for safe deletion. Active jobs are never
            # candidates.
            artifact_rows = sorted(
                (
                    row
                    for row in jobs.values()
                    if row.status in TERMINAL_STATUSES and row.artifact is not None
                ),
                key=lambda row: (
                    row.finished_at or row.created_at,
                    row.job_id,
                ),
                reverse=True,
            )
            for expired in artifact_rows[MAX_RETAINED_ARTIFACTS - 1 :]:
                assert expired.artifact is not None
                pruned.append(expired.artifact)
                expired.artifact = None
                if expired.result is not None:
                    expired.result.artifact_id = None
                jobs[expired.job_id] = expired
            active_param_bytes = sum(
                _json_size(row.params)
                for row in jobs.values()
                if row.status not in TERMINAL_STATUSES
            ) + sum(
                _json_size(payload.get("params") or {})
                for payload in forward.values()
                if not _forward_terminal(payload)
            )
            if active_param_bytes + _json_size(job.params) > MAX_REGISTRY_PARAM_BYTES:
                raise JobCapacityError(
                    "active job parameters exceed the bounded registry capacity"
                )
            jobs[job.job_id] = job
            keys[job.idempotency_key_hash] = job.job_id
            # A failed privacy boundary remains globally fenced. Only an explicitly
            # fresh, permission-stamped factory retry can atomically take ownership;
            # ordinary submissions and claims remain stopped throughout recovery.
            registry.fence = job.job_id if recovery else fence
            return job, True, pruned

        return await self._mutate_registry(change)

    async def get(self, job_id: str) -> Job | None:
        jobs, _ = await self._load_strict()
        return jobs.get((job_id or "").strip())

    async def find_by_idempotency(self, key_hash: str) -> Job | None:
        """The retained job an idempotency key hash is bound to, or ``None``. A read:
        a submit route uses it to recognise a client retry before its own pre-checks
        (a retry is never "busy" with itself and never audited twice)."""
        jobs, keys = await self._load_strict()
        bound = keys.get(key_hash or "")
        return jobs.get(bound) if bound else None

    async def active_for_actor(
        self, actor: str, generation: str, kind: JobKind
    ) -> Job | None:
        """The actor's queued or running job of ``kind``, if any (a read; the create
        CAS enforces :data:`ONE_ACTIVE_PER_ACTOR_KINDS` atomically)."""
        jobs, _ = await self._load_strict()
        needle = (actor or "").strip().lower()
        for row in jobs.values():
            if (
                row.kind == kind
                and row.actor.strip().lower() == needle
                and row.actor_generation == generation
                and row.status not in TERMINAL_STATUSES
            ):
                return row
        return None

    async def factory_cache_epoch(self) -> str:
        """Stable cache namespace derived from the latest sanitized reset receipt."""

        jobs, _ = await self._load_strict()
        receipts = [
            row
            for row in jobs.values()
            if row.kind == JobKind.TIERED_RESET
            and row.actor == ""
            and row.params == {"scope": "factory"}
            and not row.request_fingerprint
            and row.status in TERMINAL_STATUSES
        ]
        if not receipts:
            return "legacy"
        return max(
            receipts, key=lambda row: (row.finished_at or row.created_at, row.job_id)
        ).job_id

    async def factory_fence_owner(self) -> str:
        """Strictly return the durable factory owner, or ``""`` when unfenced."""

        # SqlKVStore.get is already authoritative/raising; ES exposes the explicit
        # strict read. Keep the same bundled-store abstraction used by _load_strict.
        # A forward record (a kind a newer build wrote) is neither corruption nor a
        # reset in progress, so it never puts startup into safe-stop; only a corrupt
        # registry or a fence without an owning row does. A fence a newer build's row
        # owns is still a fence (this build cannot prove that reset finished).
        registry = await self._load_registry_strict()
        fence = registry.fence
        if fence and fence not in registry.jobs and fence not in registry.forward:
            raise ValueError("job registry factory fence has no owning row")
        return fence

    async def factory_recovery_fence_matches(self, owner: str) -> bool:
        """Prove ``owner`` is a fenced factory job/receipt eligible for recovery."""

        owner = str(owner or "").strip()
        if not owner:
            return False
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(JOBS_NS, JOBS_KEY)
        if not isinstance(doc, dict) or str(doc.get("factory_fence") or "") != owner:
            return False
        jobs, _keys = self._decode(doc)
        row = jobs.get(owner)
        return bool(
            row is not None
            and row.kind == JobKind.TIERED_RESET
            and row.params == {"scope": "factory"}
            and (
                row.status == JobStatus.FAILED
                or (
                    row.actor == ""
                    and not row.request_fingerprint
                    and row.status in TERMINAL_STATUSES
                )
            )
        )

    async def list_for_actor(self, actor: str, generation: str | None = None) -> list[Job]:
        jobs, _ = await self._load_strict()
        needle = (actor or "").strip().lower()
        rows = [
            j
            for j in jobs.values()
            if j.actor.strip().lower() == needle
            and (generation is None or j.actor_generation == generation)
        ]
        # ISO timestamps emitted by iso_now are canonical and lexically sortable.
        # Stable sorts make the primary active-first partition explicit.
        rows.sort(key=lambda j: (j.created_at, j.job_id), reverse=True)
        rows.sort(key=lambda j: 0 if j.status not in TERMINAL_STATUSES else 1)
        return rows

    @staticmethod
    def _transition(job: Job, name: str, summary: str = "") -> None:
        job.transition_seq += 1
        job.transitions.append(
            JobTransition(seq=job.transition_seq, name=name, summary=summary[:500])
        )

    async def claim_next(
        self, owner: str, *, lease_millis: int
    ) -> tuple[Job, str] | None:
        now_ms = int(time.time() * 1000)

        # An idle worker must be read-only. In particular, SQLite's in-memory test
        # engine uses one physical connection; continuously CAS-writing an unchanged
        # empty registry can interleave with readiness sentinels and roll back their
        # transaction. A new job created after this snapshot is picked up by the
        # in-process wake signal (or the bounded cross-replica idle poll). The actual
        # claim below remains one strict CAS, so this admission hint grants nothing.
        snapshot, _snapshot_keys = await self._load_strict()
        raw = await (getattr(self._kv, "get_strict", None) or self._kv.get)(
            JOBS_NS, JOBS_KEY
        )
        fence = str((raw or {}).get("factory_fence") or "") if isinstance(raw, dict) else ""
        if not any(
            (not fence or job.job_id == fence)
            and (
                job.status == JobStatus.QUEUED
                or (
                    job.status == JobStatus.RUNNING
                    and int(job.lease_expires_at_millis or 0) <= now_ms
                )
            )
            for job in snapshot.values()
        ):
            return None

        def change(
            jobs: dict[str, Job], _keys: dict[str, str], fence: str
        ) -> tuple[tuple[Job, str] | None, str]:
            candidates = [
                job
                for job in jobs.values()
                if (not fence or job.job_id == fence)
                and (
                    job.status == JobStatus.QUEUED
                    or (
                        job.status == JobStatus.RUNNING
                        and int(job.lease_expires_at_millis or 0) <= now_ms
                    )
                )
            ]
            if not candidates:
                return None, fence
            job = min(candidates, key=lambda row: (row.created_at, row.job_id))
            token = uuid.uuid4().hex
            recovering = job.status == JobStatus.RUNNING
            job.status = JobStatus.RUNNING
            job.inbox_synced = False
            job.lease_owner = owner
            job.lease_token = token
            job.lease_expires_at_millis = now_ms + max(30_000, lease_millis)
            if job.started_at is None:
                job.started_at = iso_now()
                self._transition(job, "started", "server worker claimed queued job")
            elif recovering:
                # An interrupted archive has an ambiguous partial private file.
                # Rotate the durable reservation; old unreferenced bytes age out.
                if job.pending_artifact_id:
                    job.pending_artifact_id = None
                    job.pending_artifact_suffix = None
                ambiguous = [
                    ref for ref, state in job.item_states.items() if state == "processing"
                ]
                for ref in ambiguous:
                    if job.kind in _RETRY_SAFE_KINDS:
                        job.item_states[ref] = "pending"
                    else:
                        job.item_states[ref] = "failed"
                        self._append_failure(
                            job,
                            ref,
                            "worker interrupted after execution began; item was not retried to avoid duplicate effects",
                        )
                self._recount(job)
                self._transition(job, "resumed", "expired worker lease recovered")
            jobs[job.job_id] = job
            return (job, token), fence

        return await self._mutate_meta(change)

    async def release_claim(self, job_id: str, token: str) -> Job:
        """Return an unexecuted claim to the queue (for example, audit outage)."""

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            job.status = JobStatus.QUEUED
            job.lease_owner = None
            job.lease_token = None
            job.lease_expires_at_millis = 0
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def renew(self, job_id: str, token: str, *, lease_millis: int) -> Job:
        now_ms = int(time.time() * 1000)

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            job.lease_expires_at_millis = now_ms + max(30_000, lease_millis)
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def begin_item(self, job_id: str, token: str, item_ref: str) -> Job:
        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            if job.item_states.get(item_ref) == "pending":
                job.item_states[item_ref] = "processing"
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def ensure_items(
        self,
        job_id: str,
        token: str,
        item_refs: list[str],
        *,
        unit: str = "items",
    ) -> Job:
        """Add newly-discovered resumable items without replacing prior outcomes."""

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            for item_ref in item_refs:
                ref = str(item_ref)[:200]
                if ref:
                    job.item_states.setdefault(ref, "pending")
            self._recount(job)
            job.progress.unit = str(unit or "items")[:40]
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def set_progress(
        self,
        job_id: str,
        token: str,
        *,
        done: int,
        total: int,
        unit: str,
    ) -> Job:
        """Persist handler-specific bounded progress while retaining lease ownership."""

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            bounded_total = max(0, int(total))
            job.progress.done = min(max(0, int(done)), bounded_total)
            job.progress.total = bounded_total
            job.progress.unit = str(unit or "items")[:40]
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def complete_item(
        self, job_id: str, token: str, item_ref: str, *, error: str | None = None
    ) -> Job:
        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            current = job.item_states.get(item_ref)
            if current in {"succeeded", "failed"}:
                return job
            job.item_states[item_ref] = "failed" if error else "succeeded"
            if error:
                self._append_failure(job, item_ref, error)
            self._recount(job)
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def request_cancel(
        self, job_id: str, actor: str, generation: str | None = None
    ) -> Job | None:
        needle = (actor or "").strip().lower()

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job | None:
            job = jobs.get(job_id)
            if (
                job is None
                or job.actor.strip().lower() != needle
                or (generation is not None and job.actor_generation != generation)
            ):
                return None
            if job.status in TERMINAL_STATUSES:
                return job
            if not job.cancel_requested:
                job.cancel_requested = True
                job.inbox_synced = False
                self._transition(job, "cancel_requested", "cooperative cancellation requested")
            if job.status == JobStatus.QUEUED:
                job.status = JobStatus.CANCELLED
                job.finished_at = iso_now()
                _compact_terminal(job)
                self._transition(job, "cancelled", "cancelled before execution")
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def retire_actor(
        self, actor: str, generation: str
    ) -> tuple[list[JobArtifact], int]:
        """Cancel active work and purge terminal rows for a deleted account generation."""
        needle = actor.strip().lower()

        def change(registry: _Registry) -> tuple[list[JobArtifact], int]:
            jobs, keys = registry.jobs, registry.keys
            artifacts: list[JobArtifact] = []
            removed = 0
            # A terminal forward record of the deleted account generation is purged
            # like any other terminal row; an active one is left to the build that
            # understands it (this build cannot cancel what it cannot run).
            for job_id, payload in list(registry.forward.items()):
                if (
                    str(payload.get("actor") or "").lower() != needle
                    or str(payload.get("actor_generation") or "") != generation
                    or not _forward_terminal(payload)
                ):
                    continue
                forward_artifact = _forward_artifact(payload)
                if forward_artifact is not None:
                    artifacts.append(forward_artifact)
                registry.forward.pop(job_id, None)
                hashed = str(payload.get("idempotency_key_hash") or "")
                if keys.get(hashed) == job_id:
                    keys.pop(hashed, None)
                removed += 1
            for job_id, job in list(jobs.items()):
                if job.actor.lower() != needle or job.actor_generation != generation:
                    continue
                if job.status == JobStatus.RUNNING:
                    job.cancel_requested = True
                    job.retired = True
                    job.inbox_synced = True  # deleted principal receives no projection
                    jobs[job_id] = job
                    continue
                if job.artifact is not None:
                    artifacts.append(job.artifact)
                jobs.pop(job_id, None)
                if keys.get(job.idempotency_key_hash) == job_id:
                    keys.pop(job.idempotency_key_hash, None)
                removed += 1
            return artifacts, removed

        return await self._mutate_registry(change)

    async def purge_retired_terminal(
        self, job_id: str
    ) -> list[JobArtifact]:
        """Remove a fully-audited terminal row for a deleted account generation."""

        def change(
            jobs: dict[str, Job], keys: dict[str, str]
        ) -> list[JobArtifact]:
            job = jobs.get(job_id)
            if (
                job is None
                or not job.retired
                or job.status not in TERMINAL_STATUSES
                or any(not transition.audited for transition in job.transitions)
            ):
                return []
            artifacts = [job.artifact] if job.artifact is not None else []
            jobs.pop(job_id, None)
            if keys.get(job.idempotency_key_hash) == job_id:
                keys.pop(job.idempotency_key_hash, None)
            return artifacts

        return await self._mutate(change)

    async def set_inbox_synced(self, job_id: str, synced: bool) -> Job | None:
        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job | None:
            job = jobs.get(job_id)
            if job is None:
                return None
            job.inbox_synced = bool(synced)
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def unsynced_jobs(self) -> list[Job]:
        jobs, _ = await self._load_strict()
        raw = await (getattr(self._kv, "get_strict", None) or self._kv.get)(
            JOBS_NS, JOBS_KEY
        )
        fence = str((raw or {}).get("factory_fence") or "") if isinstance(raw, dict) else ""
        return [
            job
            for job in jobs.values()
            if not job.inbox_synced
            # Auth-disabled work uses the empty/default identity bucket and still
            # needs durable Inbox reconciliation. The sole actorless row excluded is
            # the sanitized factory receipt, which is privileged list/audit-only.
            and not (
                job.kind == JobKind.TIERED_RESET
                and job.actor == ""
                and not job.request_fingerprint
                and not job.idempotency_key_hash
                and job.params == {"scope": "factory"}
            )
            and (not fence or job.job_id == fence)
        ]

    async def finish(
        self,
        job_id: str,
        token: str,
        status: JobStatus,
        *,
        result: JobResult | None = None,
        job_error: str | None = None,
    ) -> Job:
        if status not in TERMINAL_STATUSES:
            raise ValueError("finish requires a terminal status")

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            if job_error:
                self._append_failure(job, "job", job_error)
            self._recount(job)
            job.status = status
            job.finished_at = iso_now()
            job.inbox_synced = False
            terminal_summary = self._terminal_summary(job)
            _compact_terminal(job, result=result)
            job.lease_owner = None
            job.lease_token = None
            job.lease_expires_at_millis = 0
            self._transition(job, status.value, terminal_summary)
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def reserve_artifact(
        self, job_id: str, token: str, *, suffix: str
    ) -> tuple[Job, str]:
        if suffix not in ARTIFACT_SUFFIXES:
            raise ValueError("unsupported artifact suffix")

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> tuple[Job, str]:
            job = self._owned(jobs, job_id, token)
            if not job.pending_artifact_id:
                job.pending_artifact_id = uuid.uuid4().hex
                job.pending_artifact_suffix = suffix
            jobs[job_id] = job
            return job, job.pending_artifact_id

        return await self._mutate(change)

    async def clear_pending_artifact(
        self, job_id: str, token: str, artifact_id: str
    ) -> Job:
        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job:
            job = self._owned(jobs, job_id, token)
            if job.pending_artifact_id == artifact_id:
                job.pending_artifact_id = None
                job.pending_artifact_suffix = None
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def attach_artifact(
        self, job_id: str, token: str, artifact: JobArtifact
    ) -> tuple[Job, list[JobArtifact]]:
        def change(
            jobs: dict[str, Job], _keys: dict[str, str]
        ) -> tuple[Job, list[JobArtifact]]:
            job = self._owned(jobs, job_id, token)
            if job.pending_artifact_id != artifact.artifact_id:
                raise RuntimeError("artifact identity was not reserved by this job")
            previous = job.artifact
            job.artifact = artifact
            job.pending_artifact_id = None
            job.pending_artifact_suffix = None
            jobs[job_id] = job
            retained = sorted(
                (
                    row
                    for row in jobs.values()
                    if row.artifact is not None and row.job_id != job_id
                ),
                key=lambda row: (row.finished_at or row.created_at, row.job_id),
                reverse=True,
            )
            expired_meta: list[JobArtifact] = (
                [previous]
                if previous is not None and previous.artifact_id != artifact.artifact_id
                else []
            )
            # The newly attached artifact plus at most 49 existing ones.
            for expired in retained[MAX_RETAINED_ARTIFACTS - 1 :]:
                assert expired.artifact is not None
                expired_meta.append(expired.artifact)
                expired.artifact = None
                if expired.result is not None:
                    expired.result.artifact_id = None
                jobs[expired.job_id] = expired
            return job, expired_meta

        return await self._mutate(change)

    async def expire_artifact(self, job_id: str, artifact_id: str) -> Job | None:
        """Clear corrupt/missing artifact metadata without exposing its path."""

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job | None:
            job = jobs.get(job_id)
            if (
                job is None
                or job.artifact is None
                or job.artifact.artifact_id != artifact_id
            ):
                return job
            job.artifact = None
            if job.result is not None:
                job.result.artifact_id = None
            jobs[job_id] = job
            return job

        return await self._mutate(change)

    async def unaudited_transitions(self) -> list[tuple[Job, JobTransition]]:
        jobs, _ = await self._load_strict()
        raw = await (getattr(self._kv, "get_strict", None) or self._kv.get)(
            JOBS_NS, JOBS_KEY
        )
        fence = str((raw or {}).get("factory_fence") or "") if isinstance(raw, dict) else ""
        return [
            (job, transition)
            for job in jobs.values()
            if not fence or job.job_id == fence
            for transition in job.transitions
            if not transition.audited
        ]

    async def artifact_ids(self) -> set[str]:
        registry = await self._load_registry_strict()
        return {
            job.artifact.artifact_id
            for job in registry.jobs.values()
            if job.artifact is not None
        } | {
            payload["artifact"]["artifact_id"]
            for payload in registry.forward.values()
            if isinstance(payload.get("artifact"), dict)
            and isinstance(payload["artifact"].get("artifact_id"), str)
            and payload["artifact"]["artifact_id"]
        }

    async def protected_artifact_ids(self) -> set[str]:
        """Attached plus durably reserved in-progress artifact identities (a forward
        record's included, so the orphan sweep never deletes a newer build's file)."""
        registry = await self._load_registry_strict()
        protected = {
            value
            for job in registry.jobs.values()
            for value in (
                job.artifact.artifact_id if job.artifact is not None else None,
                job.pending_artifact_id,
            )
            if value
        }
        for payload in registry.forward.values():
            protected |= _forward_artifact_ids(payload)
        return protected

    async def mark_transition_audited(self, job_id: str, seq: int) -> None:
        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> None:
            job = jobs.get(job_id)
            if job is None:
                return
            for transition in job.transitions:
                if transition.seq == seq:
                    transition.audited = True
                    break
            jobs[job_id] = job

        await self._mutate(change)

    async def mark_all_transitions_unaudited(self, job_id: str | None = None) -> Job | None:
        """Invalidate transition acknowledgements after an audit-store reset."""

        def change(jobs: dict[str, Job], _keys: dict[str, str]) -> Job | None:
            selected = jobs.get(job_id) if job_id else None
            for key, job in jobs.items():
                if job_id is None or key == job_id:
                    for transition in job.transitions:
                        transition.audited = False
                    jobs[key] = job
            return selected

        return await self._mutate(change)

    async def begin_factory_fence(
        self, job_id: str, token: str
    ) -> tuple[Job, list[JobArtifact]]:
        """Fence submissions/claims and cooperatively stop every other job."""

        def change(
            jobs: dict[str, Job], _keys: dict[str, str], fence: str
        ) -> tuple[tuple[Job, list[JobArtifact]], str]:
            current = self._owned(jobs, job_id, token)
            if fence and fence != job_id:
                raise RuntimeError("another factory reset owns the job registry fence")
            artifacts: list[JobArtifact] = []
            for other_id, other in jobs.items():
                if other_id == job_id or other.status in TERMINAL_STATUSES:
                    continue
                other.cancel_requested = True
                # The fence is itself a durable projection change.  If factory
                # quiescence later times out, Inbox reconciliation must still replace
                # a stale queued/running note with the cancellation state.
                other.inbox_synced = False
                if other.status == JobStatus.QUEUED:
                    other.status = JobStatus.CANCELLED
                    other.finished_at = iso_now()
                    _compact_terminal(other)
                    self._transition(
                        other, "cancelled", "cancelled by factory reset fence"
                    )
                    if other.artifact is not None:
                        artifacts.append(other.artifact)
                jobs[other_id] = other
            return (current, artifacts), job_id

        return await self._mutate_meta(change)

    async def factory_quiescent(self, job_id: str, token: str) -> bool:
        jobs, _ = await self._load_strict()
        self._owned(jobs, job_id, token)
        return not any(
            other.job_id != job_id and other.status == JobStatus.RUNNING
            for other in jobs.values()
        )

    async def release_factory_fence(self, job_id: str) -> None:
        def change(
            jobs: dict[str, Job], keys: dict[str, str], fence: str
        ) -> tuple[None, str]:
            del jobs, keys
            return None, "" if fence == job_id else fence

        await self._mutate_meta(change)

    async def factory_compact(
        self,
        job_id: str,
        token: str,
        *,
        status: JobStatus,
        result: JobResult,
        app_version: str,
        build_sha: str,
    ) -> tuple[Job, list[JobArtifact]]:
        """Replace all pre-reset personal state with one sanitized system receipt."""
        if status not in TERMINAL_STATUSES:
            raise ValueError("factory receipt must be terminal")

        def change(registry: _Registry) -> tuple[Job, list[JobArtifact]]:
            jobs, _keys, fence = registry.jobs, registry.keys, registry.fence
            current = self._owned(jobs, job_id, token)
            if fence != job_id:
                raise RuntimeError("factory reset fence ownership changed")
            artifacts = [
                row.artifact
                for row in jobs.values()
                if row.artifact is not None
            ]
            # A factory reset clears every personal record, forward ones included.
            for payload in registry.forward.values():
                forward_artifact = _forward_artifact(payload)
                if forward_artifact is not None:
                    artifacts.append(forward_artifact)
            registry.forward.clear()
            receipt = Job(
                job_id=current.job_id,
                kind=JobKind.TIERED_RESET,
                actor="",
                created_at=current.created_at,
                started_at=current.started_at,
                finished_at=iso_now(),
                status=status,
                progress=current.progress.model_copy(
                    update={"done": 1, "total": 1, "unit": "reset"}
                ),
                request_fingerprint="",
                idempotency_key_hash="",
                result=result,
                params={"scope": "factory"},
                app_version=app_version,
                build_sha=build_sha,
            )
            self._transition(
                receipt,
                "factory_receipt",
                (
                    f"status={status.value} attempted={result.counts.get('attempted', 0)} "
                    f"cleared={result.counts.get('cleared', 0)} "
                    f"failed={result.counts.get('failed', 0)}"
                ),
            )
            jobs.clear()
            _keys.clear()
            jobs[receipt.job_id] = receipt
            # The privacy boundary is not complete merely because the old registry
            # was compacted. Keep admission fenced until the sanitized reset receipt
            # and this transition are both durably audited by the runner.
            registry.fence = job_id
            return receipt, artifacts

        receipt, artifacts = await self._mutate_registry(change)
        return receipt, [artifact for artifact in artifacts if artifact is not None]

    @staticmethod
    def _owned(jobs: dict[str, Job], job_id: str, token: str) -> Job:
        job = jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.lease_token != token or job.status != JobStatus.RUNNING:
            raise RuntimeError("job worker lease ownership changed")
        return job

    @staticmethod
    def _append_failure(job: Job, item_ref: str, reason: str) -> None:
        job.failure_count += 1
        if len(job.failures) < MAX_FAILURES:
            job.failures.append(
                JobFailure(item_ref=str(item_ref)[:200], reason=str(reason)[:500])
            )
        job.failures_truncated = max(0, job.failure_count - len(job.failures))

    @staticmethod
    def _recount(job: Job) -> None:
        if job.kind in _HANDLER_PROGRESS_KINDS:
            # Progress counts what the handler wrote (events), not journal items.
            return
        job.progress.done = sum(
            1 for state in job.item_states.values() if state in {"succeeded", "failed"}
        )
        job.progress.total = len(job.item_states)

    @staticmethod
    def _terminal_summary(job: Job) -> str:
        succeeded = sum(1 for state in job.item_states.values() if state == "succeeded")
        failed = sum(1 for state in job.item_states.values() if state == "failed")
        job_errors = max(0, job.failure_count - failed)
        return (
            f"status={job.status.value} done={job.progress.done}/{job.progress.total} "
            f"succeeded={succeeded} failed={failed} job_errors={job_errors}"
        )
