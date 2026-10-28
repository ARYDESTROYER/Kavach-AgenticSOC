"""Authenticated durable operator Jobs API.

Submission validates one explicit registered kind, stores an actor-scoped raw-key
hash plus request fingerprint, and returns immediately. Execution is wholly owned by
the server runner; list/detail/cancel/artifact remain self-scoped.

Round 14 (SPEC §3.6, §4.5.4, §4.5.6): the submit of an audit export, a reset or a
data export is audited before the job exists (``audit.export_requested``,
``reset.requested``, ``export.requested``, with who asked and from where), and every
artifact download is audited before a byte is streamed.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from ..audit.context import audit_context
from ..audit.write import AuditUnavailableError, audited_write
from ..constants import ActionType, CaseStatus, JobKind, ResetScope
from ..engine import audit_export
from ..engine.jobs import account_generation, data_export_audit_target, reset_audit_target
from ..engine.replay.params import ReplayExperimentParams
from ..models import (
    AUDIT_SEARCH_MAX_CHARS,
    AuditTarget,
    Job,
    JobArtifact,
    JobListResponse,
    JobPermission,
    JobProgress,
    JobPublic,
    JobTransition,
    RelatedBatchJobPublic,
    RelatedJobsPublic,
    SchedulerHealthPublic,
)
from ..state import AppState
from ..stores.jobs import (
    FACTORY_RECOVERY_REFUSAL,
    JobBusy,
    JobCapacityError,
    JobConflict,
    idempotency_hash,
    public_job,
)
from ..utils import iso_now, parse_es_timestamp
from .deps import (
    _enforce,
    current_username,
    get_state,
    has_permission,
    require_permission,
)

router = APIRouter(prefix="/api", tags=["jobs"])
logger = logging.getLogger("tlsoc.api.jobs")

_SENSITIVE_KEYS = {
    "password", "password_hash", "secret", "token", "authorization", "cookie",
    "api_key", "access_key", "private_key", "credential", "credentials",
}
_FRESH_KINDS = {
    JobKind.DATA_EXPORT_ARCHIVE,
    JobKind.DATA_EXPORT_SEGMENT,
    JobKind.TIERED_RESET,
    JobKind.STORAGE_LIFECYCLE_APPLY,
    # Round 14 D6: an audit export asks for a fresh sign-in.
    JobKind.AUDIT_EXPORT,
}
#: Job kinds whose submit request is audited before the job exists (Round 14 SPEC
#: §3.6, E16; §4.5.4 exports and resets). The requested row is the only row of such a
#: job that records who asked and from where (client, session reference, role at the
#: time, request id): the worker's own rows are keyed, appended again on a resumed
#: attempt, and so carry none of those (``JobRunner._job_record_fields``).
_REQUEST_AUDITED_KINDS = frozenset({
    JobKind.AUDIT_EXPORT,
    JobKind.TIERED_RESET,
    JobKind.DATA_EXPORT_ARCHIVE,
    JobKind.DATA_EXPORT_SEGMENT,
})


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _CaseIds(_Strict):
    case_ids: list[str] = Field(min_length=1, max_length=5000)

    @field_validator("case_ids")
    @classmethod
    def _canonical_case_ids(cls, value: list[str]) -> list[str]:
        normalized = [str(item).strip() for item in value]
        if any(not item or len(item) > 200 for item in normalized):
            raise ValueError("case_ids must contain non-empty identifiers up to 200 characters")
        # The logical intent is a set. Canonical ordering/dedup makes reordered or
        # repeated client retries bind the same fingerprint, progress, and item map.
        return sorted(set(normalized))


class CaseReinvestigateParams(_CaseIds):
    model: str | None = Field(default=None, max_length=200)


class CaseLifecycleParams(_CaseIds):
    action: Literal[
        "close", "reopen", "escalate", "confirm_fp", "acknowledge", "hold",
        "resume", "resolve", "set_disposition", "deescalate", "set_status",
    ]
    note: str = Field(default="", max_length=4000)
    reason: str = Field(default="", max_length=1000)
    resolution: str | None = Field(default=None, max_length=4000)
    disposition: str | None = Field(default=None, max_length=80)
    # Round 12 (WP-CM / SPEC §3.2): a bulk Close or Resolve carries the analyst's chosen
    # disposition. ``True`` ONLY when a human operated the disposition picker for this
    # submission — the same ground-truth intent flag as the single-case action (G1); it
    # is forwarded verbatim to ``_perform_case_action``, which applies-vs-classifies.
    disposition_declared: bool = False
    status: CaseStatus | None = None

    @model_validator(mode="after")
    def _targets(self) -> "CaseLifecycleParams":
        if self.action == "set_status" and self.status is None:
            raise ValueError("set_status requires status")
        if self.action == "set_disposition" and not self.disposition:
            raise ValueError("set_disposition requires disposition")
        return self


class CaseAssignParams(_CaseIds):
    assignee: str = Field(max_length=80)

    @field_validator("assignee")
    @classmethod
    def _assignee(cls, value: str) -> str:
        clean = value.strip()
        if not clean or any(ord(char) < 32 for char in clean):
            raise ValueError("assignee must be non-empty plain text")
        return clean


class CaseTagParams(_CaseIds):
    tag: str = Field(min_length=1, max_length=40)

    @field_validator("tag")
    @classmethod
    def _tag(cls, value: str) -> str:
        clean = value.strip()
        if not clean or any(ord(char) < 32 for char in clean):
            raise ValueError("tag must be non-empty plain text")
        return clean


class ExportArchiveParams(_Strict):
    scopes: list[Literal[
        "all", "cases", "audit", "usage", "configuration", "automation", "knowledge"
    ]] = Field(default_factory=lambda: ["all"], min_length=1, max_length=7)


class ExportSegmentParams(ExportArchiveParams):
    page_size: int = Field(default=1000, ge=1, le=5000)


class PrecedentParams(_Strict):
    acknowledgement: str
    limit: int = Field(default=200, ge=1, le=1000)
    batch_id: str = Field(default="", max_length=64)
    dry_run: bool = False


class RunbookParams(_Strict):
    runbook_id: str | None = Field(default=None, max_length=160)


class RagDocument(_Strict):
    title: str = Field(min_length=1, max_length=512)
    text: str = Field(min_length=1, max_length=1_000_000)
    source: str = Field(default="imported", max_length=160)
    tags: list[str] = Field(default_factory=list, max_length=25)

    @field_validator("title", "source")
    @classmethod
    def _plain_metadata(cls, value: str) -> str:
        clean = value.strip()
        if not clean or any(ord(char) < 32 for char in clean):
            raise ValueError("document metadata must be non-empty plain text")
        return clean

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str]) -> list[str]:
        tags = [str(tag).strip() for tag in value]
        if any(not tag or len(tag) > 80 or any(ord(char) < 32 for char in tag) for tag in tags):
            raise ValueError("tags must be non-empty plain text up to 80 characters")
        return sorted(set(tags))


class RagImportParams(_Strict):
    documents: list[RagDocument] = Field(min_length=1, max_length=20)


class RagRebuildParams(_Strict):
    """No parameters: the rebuild always reconciles the WHOLE enabled projection.

    Deliberately empty rather than offering a per-source selector. The failure this
    action exists to recover from is "the corpus is gone / partial and nothing will
    bring it back"; asking an operator to first work out WHICH sources are missing
    would reintroduce the diagnosis step that took three days.
    """


class ResetParams(_Strict):
    scope: ResetScope
    confirm: str


class StoragePolicy(_Strict):
    enabled: bool = True
    hot_days: int = Field(ge=1, le=3650)
    warm_days: int = Field(ge=1, le=3650)
    archive_target: Literal["aws_glacier"] = "aws_glacier"
    glacier_storage_class: Literal["GLACIER", "DEEP_ARCHIVE"] = "GLACIER"
    delete_after_archive: Literal[False] = False


class StorageParams(_Strict):
    acknowledge: Literal[True]
    policy: StoragePolicy


def _blank_to_none(value: Any) -> Any:
    """A filter sent as an empty or blank string is the same as one not sent, so a
    retry with a blank field binds the same request fingerprint."""
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _strip_text(value: Any) -> Any:
    """A closed-vocabulary value is read as the read API reads it: surrounding spaces
    do not count (``"people "`` is ``people``)."""
    return value.strip() if isinstance(value, str) else value


class AuditExportFilters(_Strict):
    """The audit log page's structured filters, with the read API's names and
    meanings (``GET /api/audit``): ``action`` is the legacy ``action_type``, ``actor``
    is exact, ``actor_contains`` is a case-insensitive contains, ``event`` is the
    structured action, a category id or an event family, ``target`` a target id and
    ``ip`` one client address. The vocabularies (``actor_kind``, ``outcome``) are
    plain text here, as in the read API, so the read API's own validation refuses a
    bad value with its coded ``422 audit_invalid_filter``."""

    action: str | None = Field(default=None, max_length=64)
    event: str | None = Field(default=None, max_length=65)
    actor: str | None = Field(default=None, max_length=160)
    actor_contains: str | None = Field(default=None, max_length=128)
    actor_kind: str | None = Field(default=None, max_length=32)
    outcome: str | None = Field(default=None, max_length=32)
    surface: str | None = Field(default=None, max_length=80)
    case_id: str | None = Field(default=None, max_length=200)
    source_id: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, max_length=256)
    ip: str | None = Field(default=None, max_length=64)

    _blank = field_validator("*", mode="before")(_blank_to_none)


class AuditExportParams(_Strict):
    """``audit_export`` (Round 14 SPEC §4.5.6): one plain CSV or JSON Lines file of the
    audit rows the page shows for ``scope``, the search text ``q`` and ``filters``,
    between ``from`` and ``to``: the absolute ISO 8601 instants (with a zone) the
    export dialog showed and counted. Exports are always oldest first, so ``order``
    accepts only ``asc``."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    format: Literal["csv", "jsonl"]
    scope: Literal["people", "agent", "all"]
    from_: str = Field(alias="from", min_length=1, max_length=40)
    to: str = Field(min_length=1, max_length=40)
    order: Literal["asc"] = "asc"
    q: str | None = Field(default=None, max_length=AUDIT_SEARCH_MAX_CHARS)
    filters: AuditExportFilters = Field(default_factory=AuditExportFilters)

    _blank_q = field_validator("q", mode="before")(_blank_to_none)
    _trimmed = field_validator("format", "scope", "order", mode="before")(_strip_text)


#: The plain refusal for each audit export parameter the model rejects (the read
#: API's wording where it has one). Every refusal is the read API's coded ``422``.
_AUDIT_EXPORT_PARAM_MESSAGES: dict[str, str] = {
    "format": "'format' must be csv or jsonl.",
    "scope": "'scope' must be people, agent or all.",
    "order": "Exports are always oldest first, so 'order' must be asc.",
    "q": f"'q' must be 1 to {AUDIT_SEARCH_MAX_CHARS} printable characters.",
    "filters": "'filters' must be an object of filter values.",
}


def _audit_export_invalid(exc: ValidationError) -> HTTPException:
    """The coded ``422`` for audit export params the model refused, in the read API's
    codes (``audit_invalid_time`` for ``from`` and ``to``, ``audit_invalid_filter``
    for the rest) and plain words: never the validator's own text."""
    from .routes_audit import _invalid, _invalid_time

    errors = exc.errors()
    first = errors[0] if errors else {}
    loc = [str(part) for part in first.get("loc", ())]
    name = loc[0] if loc else ""
    if name in {"from", "from_", "to"}:
        side = "to" if name == "to" else "from"
        return _invalid_time(
            f"'{side}' must be an absolute ISO 8601 time with a zone, such as "
            "2026-10-18T15:10:00Z."
        )
    if first.get("type") == "extra_forbidden":
        if name == "filters" and len(loc) > 1:
            return _invalid(f"'{loc[-1]}' is not an audit log filter.")
        return _invalid(f"'{name}' is not an audit export setting.")
    if name == "filters" and len(loc) > 1:
        return _invalid(f"'{loc[1]}' is not a valid filter value.")
    return _invalid(
        _AUDIT_EXPORT_PARAM_MESSAGES.get(name, "The export settings are not valid.")
    )


class _AlreadyAccepted(Exception):
    """A racing duplicate of an accepted request of a kind whose submit is audited
    (:data:`_REQUEST_AUDITED_KINDS`; the same idempotency key and request, both past
    the retry check): the create returned the existing job instead of a new one.
    ``audited_write`` closes the duplicate's requested row with its
    ``<resource>.request_failed`` row (``audit.export_request_failed``,
    ``reset.request_failed``, ``export.request_failed``) naming the job it folded
    into, and the caller answers with that job."""

    def __init__(self, job: Job) -> None:
        super().__init__(f"the same request was already accepted as job {job.job_id}")
        self.job = job
        self.detail = {
            "code": "job_already_accepted",
            "message": f"The same request was already accepted as job {job.job_id}.",
        }


_PARAM_MODELS: dict[JobKind, type[BaseModel]] = {
    JobKind.CASE_REINVESTIGATE: CaseReinvestigateParams,
    JobKind.CASE_LIFECYCLE: CaseLifecycleParams,
    JobKind.CASE_ASSIGN: CaseAssignParams,
    JobKind.CASE_TAG: CaseTagParams,
    JobKind.DATA_EXPORT_ARCHIVE: ExportArchiveParams,
    JobKind.DATA_EXPORT_SEGMENT: ExportSegmentParams,
    JobKind.PRECEDENT_BOOTSTRAP: PrecedentParams,
    JobKind.RUNBOOK_REINDEX: RunbookParams,
    JobKind.RAG_IMPORT: RagImportParams,
    JobKind.RAG_REBUILD: RagRebuildParams,
    JobKind.TIERED_RESET: ResetParams,
    JobKind.STORAGE_LIFECYCLE_APPLY: StorageParams,
    JobKind.REPLAY_EXPERIMENT: ReplayExperimentParams,
    JobKind.AUDIT_EXPORT: AuditExportParams,
}


class JobSubmit(_Strict):
    kind: JobKind
    idempotency_key: str = Field(min_length=8, max_length=200)
    params: dict[str, Any]


def _contains_sensitive(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            if normalized in _SENSITIVE_KEYS or normalized.endswith(
                ("_secret", "_token", "_password", "_api_key")
            ):
                return True
            if _contains_sensitive(item):
                return True
    elif isinstance(value, list):
        return any(_contains_sensitive(item) for item in value)
    return False


def _fingerprint(kind: JobKind, params: dict[str, Any]) -> str:
    raw = json.dumps(
        {"kind": kind.value, "params": params},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _items(kind: JobKind, params: dict[str, Any]) -> tuple[dict[str, str], str]:
    if "case_ids" in params:
        return {case_id: "pending" for case_id in params["case_ids"]}, "cases"
    if kind == JobKind.RAG_IMPORT:
        return {str(i): "pending" for i in range(len(params["documents"]))}, "documents"
    if kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        from .routes_export import _select_scopes

        scopes = _select_scopes(list(params.get("scopes") or ["all"]))
        params["scopes"] = scopes
        return {scope: "pending" for scope in scopes}, "scopes"
    if kind == JobKind.PRECEDENT_BOOTSTRAP:
        return ({"bootstrap": "pending"} if params.get("dry_run") else {}), "cases"
    if kind == JobKind.RAG_REBUILD:
        return {"rebuild": "pending"}, "items"
    if kind == JobKind.REPLAY_EXPERIMENT:
        return (
            {fixture_id: "pending" for fixture_id in params["fixture_ids"]},
            "replay fixtures",
        )
    if kind == JobKind.AUDIT_EXPORT:
        # No item journal: the handler reports progress in events written and
        # rewrites its whole file on a resumed attempt.
        return {}, "events"
    key = "reindex" if kind == JobKind.RUNBOOK_REINDEX else (
        "reset" if kind == JobKind.TIERED_RESET else "apply"
    )
    return {key: "pending"}, "items"


def _grants(kind: JobKind, params: dict[str, Any]) -> list[tuple[str, str]]:
    if kind == JobKind.CASE_REINVESTIGATE:
        return [("cases", "reinvestigate")]
    if kind == JobKind.CASE_ASSIGN:
        return [("cases", "assign")]
    if kind == JobKind.CASE_TAG:
        return [("cases", "write")]
    if kind == JobKind.CASE_LIFECYCLE:
        from .routes import CaseAction, _grant_for_body

        action = CaseAction.model_validate(
            {key: value for key, value in params.items() if key != "case_ids"}
        )
        return [("cases", _grant_for_body(action))]
    if kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        return [("data_export", "export")]
    if kind == JobKind.PRECEDENT_BOOTSTRAP:
        return [("rag", "manage"), ("cases", "write")]
    if kind == JobKind.RUNBOOK_REINDEX:
        return [("runbooks", "manage")]
    if kind in {JobKind.RAG_IMPORT, JobKind.RAG_REBUILD}:
        return [("rag", "manage")]
    if kind == JobKind.TIERED_RESET:
        return [("users", "manage")]
    if kind == JobKind.REPLAY_EXPERIMENT:
        # Overriding per-role model configuration and spending real provider money IS
        # the models grant; the fixtures are case-derived alert evidence and the report
        # enumerates per-case outcomes, hence cases:read alongside it.
        return [("models", "manage"), ("cases", "read")]
    if kind == JobKind.AUDIT_EXPORT:
        # Round 14 D5: ``audit:export`` (super admin, SOC manager and auditor by
        # default), and ``audit:view`` too: a person exports only what they may read.
        # Both are re-checked at every page boundary and at download.
        return [("audit", "export"), ("audit", "view")]
    return [("settings", "manage")]


async def _fresh_fields(
    request: Request, state: AppState, kind: JobKind
) -> tuple[int, str | None, int | None]:
    if kind not in _FRESH_KINDS or not state.auth.is_enabled:
        return 0, None, None
    authorization = request.headers.get("authorization", "")
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    token = request.cookies.get("tlsoc_token") or bearer
    claims = state.auth.claims_of(token) if token else None
    sid = str((claims or {}).get("sid", "") or "")
    try:
        tv = int((claims or {}).get("tv", -1))
    except (TypeError, ValueError):
        tv = -1
    if not sid or tv < 0:
        raise HTTPException(401, detail={"code": "reauth_required"})
    policy = state.prefs.session_policy
    # Standard + remembered limits for the actor's live role (Round 12, one builder
    # for every site; an excluded role is never remembered).
    from ..auth.session_limits import limits_for_username

    username = current_username(request)
    try:
        expires_at = await state.sessions.strict_deferred_authority_expires_at(
            sid=sid,
            username=username,
            token_version=tv,
            sudo_window=int(policy.sudo_reauth_window or 600),
            **limits_for_username(state, username).kwargs(),
        )
    except Exception as exc:
        raise HTTPException(503, detail="session authority registry unavailable") from exc
    if expires_at is None:
        raise HTTPException(
            401,
            detail={
                "code": "reauth_required",
                "reason": "stale_or_revoked_authority",
                "window": int(policy.sudo_reauth_window or 600),
            },
        )
    return expires_at, sid, tv


def _job_busy() -> HTTPException:
    return HTTPException(
        429,
        detail={
            "code": "job_busy",
            "message": (
                "An audit export is already running. Wait for it to finish, then "
                "export again."
            ),
        },
    )


async def _accepted_retry(state: AppState, key_hash: str, fingerprint: str) -> Job | None:
    """The job a client retry names, before anything is written (SPEC §3.6 step 1).

    For a kind whose submit is audited, a retry with the same idempotency key and
    the same request is answered with the job already accepted: it writes no second
    requested row and never reaches the create (so it never makes a job that no row
    names, even if the accepted job was pruned meanwhile). The same key bound to a
    different request is ``409`` with no row. ``None`` means a new request."""
    bound = await state.jobs.find_by_idempotency(key_hash)
    if bound is None:
        return None
    if bound.request_fingerprint != fingerprint:
        raise HTTPException(
            409, detail="idempotency key is already bound to a different job request"
        )
    return bound


def _request_audit(
    kind: JobKind, job: Job, params: dict[str, Any], *, export_count: int | None
) -> dict[str, Any]:
    """The requested row of a job whose submit is audited (:data:`_REQUEST_AUDITED_KINDS`):
    its action, target, summary and inputs, in the vocabulary of the job's own worker
    rows so the request and what the worker did read as one job.

    * ``audit.export_requested`` (SPEC §4.5.6): the export target and file name, the
      question (format, scope, range, order, filters, search text) and the count.
    * ``reset.requested``: the reset job named by what it resets, the target of the
      worker's ``reset.started``, ``reset.completed`` and ``reset.failed`` rows.
    * ``export.requested`` (a data export archive or segment job): the export job,
      labelled with the exported scopes, the target of the worker's
      ``export.created`` row and of each download of the job's file
      (``job.artifact_downloaded``).

    Every row of one job names the job, so ``GET /api/audit?target=<job id>`` lists
    the request, what the worker did and each download together."""
    if kind == JobKind.AUDIT_EXPORT:
        ts_from, ts_to = audit_export.export_range(params)
        return {
            "action": "audit.export_requested",
            "target": audit_export.export_target(
                job.job_id, audit_export.export_file_name(params["format"], ts_from, ts_to)
            ),
            "action_type": ActionType.DATA_EXPORT,
            "surface": "audit",
            "result_summary": audit_export.describe_request(params, export_count or 0),
            "tool_input": {
                "job_id": job.job_id,
                "format": params["format"],
                "scope": params["scope"],
                "from": params["from"],
                "to": params["to"],
                "order": params.get("order", "asc"),
                "filters": dict(params.get("filters") or {}),
                "q": params.get("q"),
                "events": export_count,
            },
        }
    if kind == JobKind.TIERED_RESET:
        scope = ResetScope(params["scope"])
        return {
            "action": "reset.requested",
            "target": reset_audit_target(job.job_id, scope),
            "action_type": ActionType.RESET,
            "surface": "admin",
            "result_summary": f"reset requested scope={scope.value} job={job.job_id}",
            "tool_input": {"job_id": job.job_id, "scope": scope.value},
        }
    scopes = [str(scope) for scope in params.get("scopes") or []]
    return {
        "action": "export.requested",
        "target": data_export_audit_target(job.job_id, scopes),
        "action_type": ActionType.DATA_EXPORT,
        "surface": "settings",
        "result_summary": (
            f"export requested kind={kind.value} scopes={','.join(scopes)} job={job.job_id}"
        ),
        "tool_input": {"job_id": job.job_id, "kind": kind.value, "scopes": scopes},
    }


def _refuse_during_factory_recovery(
    state: AppState, kind: JobKind, params: dict[str, Any]
) -> None:
    """While a failed factory reset holds the recovery fence (the mutation gate is
    degraded), only a fresh factory reset retry may be submitted; the admission
    middleware lets ``POST /api/jobs`` through for that retry alone. Any other new
    request is refused here, before its requested row is written (SPEC §3.6 step 1: a
    pre-check that changes nothing writes no row), with the job store's own refusal.
    The store's create stays the authority for a submit that races the fence."""
    gate = getattr(state, "mutation_gate", None)
    if gate is None or not gate.degraded:
        return
    if kind == JobKind.TIERED_RESET and params.get("scope") == "factory":
        return
    raise HTTPException(503, detail=FACTORY_RECOVERY_REFUSAL)


async def _audit_export_precheck(
    state: AppState,
    params: dict[str, Any],
    *,
    actor: str,
    generation: str,
    created: str,
) -> int:
    """The checks a new audit export passes before anything is written (SPEC §3.6
    step 1: a refusal here writes no row). Returns the count of matching events. A
    client retry of an accepted request never gets here (:func:`_accepted_retry`).

    Refusals: ``429 job_busy`` while this person already has an export queued or
    running, the read API's coded ``422`` for a bad filter or time
    (``audit_invalid_filter``, ``audit_invalid_time``; ``from`` and ``to`` must be
    absolute instants), ``422 audit_export_too_large`` over 100,000 events, ``422
    audit_export_unverifiable`` when the store cannot count exactly and ``503
    audit_unavailable`` when it cannot be counted at all."""
    # The request itself first (a bad filter is a 422 whatever else is running).
    filters = audit_export.export_filters(params, read_until=parse_es_timestamp(created))
    if await state.jobs.active_for_actor(actor, generation, JobKind.AUDIT_EXPORT) is not None:
        raise _job_busy()
    try:
        count, relation = await audit_export.count_events(state, filters)
    except audit_export.AuditExportUnreadable as exc:
        logger.warning("Audit export count failed: %s", exc.__cause__ or exc)
        raise HTTPException(
            503,
            detail={"code": "audit_unavailable", "message": "The audit log could not be counted."},
        ) from exc
    try:
        audit_export.refuse_unless_exportable(count, relation)
    except audit_export.AuditExportError as exc:
        raise HTTPException(422, detail={"code": exc.code, "message": exc.message}) from exc
    return count


@router.post("/jobs", status_code=202, response_model=JobPublic)
async def submit_job(
    body: JobSubmit,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobPublic:
    if state.demo_active:
        if body.kind == JobKind.AUDIT_EXPORT:
            # Durable jobs never run in Demo Mode (the runner fails closed), and a
            # JSON Lines file could not label Demo rows without changing them.
            raise HTTPException(
                409,
                detail={
                    "code": "audit_export_demo_mode",
                    "message": (
                        "Audit exports are not available in Demo Mode. Turn Demo Mode "
                        "off to export the audit log."
                    ),
                },
            )
        raise HTTPException(409, detail="durable jobs are unavailable in Demo Mode")
    if _contains_sensitive(body.params):
        raise HTTPException(422, detail="job parameters contain a secret-like key")
    try:
        model = _PARAM_MODELS[body.kind].model_validate(body.params)
    except ValidationError as exc:
        if body.kind == JobKind.AUDIT_EXPORT:
            raise _audit_export_invalid(exc) from exc
        raise HTTPException(422, detail=f"invalid {body.kind.value} parameters: {exc}") from exc
    except Exception as exc:
        raise HTTPException(422, detail=f"invalid {body.kind.value} parameters: {exc}") from exc
    # ``by_alias`` keeps wire names such as the audit export's ``from``.
    params = model.model_dump(mode="json", exclude_none=True, by_alias=True)
    canonical_size = len(
        json.dumps(
            params,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    if canonical_size > 8 * 1024 * 1024:
        raise HTTPException(413, detail="job parameters exceed the 8 MiB active payload limit")
    if body.kind == JobKind.PRECEDENT_BOOTSTRAP:
        from ..tools.rag import PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT

        if params["acknowledgement"] != PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT:
            raise HTTPException(400, detail="explicit precedent acknowledgement is required")
    if body.kind == JobKind.TIERED_RESET:
        expected = {
            "cases": "RESET CASES", "sources": "RESET SOURCES", "factory": "FACTORY RESET"
        }[params["scope"]]
        if params["confirm"] != expected:
            raise HTTPException(400, detail=f"confirmation phrase must be exactly '{expected}'")
    if body.kind == JobKind.STORAGE_LIFECYCLE_APPLY:
        saved = state.prefs.storage_lifecycle.model_dump(mode="json")
        if params["policy"] != saved:
            raise HTTPException(409, detail="policy must match the currently saved lifecycle policy")
    grants = _grants(body.kind, params)
    for resource, action in grants:
        await _enforce(request, resource, action)
    actor = current_username(request)
    generation = await _request_generation(request, state)
    fresh_until, fresh_sid, fresh_tv = await _fresh_fields(request, state, body.kind)
    items, unit = _items(body.kind, params)
    created = iso_now()
    key_hash = idempotency_hash(actor, body.idempotency_key, generation)
    fingerprint = _fingerprint(body.kind, params)
    audited = body.kind in _REQUEST_AUDITED_KINDS
    export_count: int | None = None
    accepted: Job | None = None
    if audited:
        # The pre-checks of a submit that is audited, before its requested row (SPEC
        # §3.6 step 1: a refusal here writes no row). A client retry of an accepted
        # request is answered with that job first, as the store's create would.
        accepted = await _accepted_retry(state, key_hash, fingerprint)
        if accepted is None:
            _refuse_during_factory_recovery(state, body.kind, params)
            if body.kind == JobKind.AUDIT_EXPORT:
                export_count = await _audit_export_precheck(
                    state, params, actor=actor, generation=generation, created=created
                )
    job = Job(
        kind=body.kind,
        actor=actor,
        actor_generation=generation,
        created_at=created,
        progress=JobProgress(
            done=0,
            total=export_count if export_count is not None else len(items),
            unit=unit,
        ),
        request_fingerprint=fingerprint,
        idempotency_key_hash=key_hash,
        params=params,
        required_permissions=[
            JobPermission(resource=resource, action=action) for resource, action in grants
        ],
        fresh_authorized_until_millis=fresh_until,
        fresh_session_id=fresh_sid,
        fresh_token_version=fresh_tv,
        item_states=items,
        transitions=[JobTransition(seq=1, name="submitted", summary="validated and queued")],
        transition_seq=1,
    )

    async def create() -> tuple[Job, bool, list[Any]]:
        try:
            created = await state.jobs.create(job)
        except JobConflict as exc:
            raise HTTPException(409, detail=str(exc)) from exc
        except JobCapacityError as exc:
            raise HTTPException(503, detail=str(exc)) from exc
        except JobBusy as exc:
            raise _job_busy() from exc
        if audited and not created[1]:
            # The requested row just appended names a job that was never made.
            raise _AlreadyAccepted(created[0])
        return created

    if accepted is not None:
        # A client retry of an accepted request: the same job, no second row.
        stored, pruned = accepted, []
    elif audited:
        # A new audit export, reset or data export is audited before it exists (SPEC
        # §3.6, E16): its requested row, with who asked and from where, comes first,
        # and a create that then fails, or that a racing duplicate of the same request
        # already won, gets its ``<resource>.request_failed`` row. All of them change
        # or read real state, so the rows go to the control audit (§3.5).
        try:
            stored, _is_new, pruned = await audited_write(
                state,
                sink="control",
                expected_revision=None,
                changes=None,
                write=create,
                actor=actor,
                actor_type="human",
                context=audit_context(request),
                **_request_audit(body.kind, job, params, export_count=export_count),
            )
        except _AlreadyAccepted as exc:
            # A duplicate that lost the race: its rows are closed, the job is the one
            # the first request created.
            stored, pruned = exc.job, []
    else:
        stored, _is_new, pruned = await create()
    await state.job_runner.delete_artifacts(pruned)
    if not await state.job_runner.reconcile_audits():
        raise HTTPException(
            503,
            detail="job is durable but its transition audit is unavailable",
        )
    if (
        body.kind == JobKind.TIERED_RESET
        and params.get("scope") == "factory"
        and state.mutation_gate.degraded
    ):
        # A restart during a failed privacy boundary intentionally starts no tenant
        # writer. The only exception is this freshly authorized durable recovery
        # intent, after JobStore atomically transferred the persistent fence to it.
        await state.job_runner.start()
    # Reconciliation updates the durable row, not the stale local transition copy.
    stored = await state.jobs.get(stored.job_id) or stored
    await state.job_runner.publish(stored, force=True)
    state.job_runner.notify()
    return public_job(stored)


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobListResponse:
    generation = await _request_generation(request, state)
    rows = await state.jobs.list_for_actor(current_username(request), generation)
    system_receipts: list[Job] = []
    if await has_permission(request, "users", "manage"):
        system_receipts = [
            row
            for row in await state.jobs.list_for_actor("")
            if row.kind == JobKind.TIERED_RESET and row.params == {"scope": "factory"}
        ]
    rows.extend(system_receipts)
    rows.sort(key=lambda row: (row.created_at, row.job_id), reverse=True)
    rows.sort(key=lambda row: 0 if row.status.value not in {
        "succeeded", "partial", "failed", "cancelled"
    } else 1)
    total = len(rows)
    selected = rows[offset : offset + limit]
    related: RelatedJobsPublic | None = None
    if await has_permission(request, "models", "read"):
        batches = await state.real_batch_job_store.list_strict()
        batches.sort(key=lambda row: (row.submitted_at or "", row.id), reverse=True)
        safe_batches: list[RelatedBatchJobPublic] = []
        for row in batches[:100]:
            tracked = {
                key: value
                for key, value in (row.custom_ids or {}).items()
                if key != "__meta__"
            }
            live_retrieved = sum(
                1
                for value in tracked.values()
                if isinstance(value, dict) and value.get("retrieved")
            )
            request_count = max(int(row.summary_total or 0), len(tracked))
            safe_batches.append(
                RelatedBatchJobPublic(
                    id=str(row.id)[:2000],
                    provider=str(row.provider)[:2000],
                    state=str(getattr(row.state, "value", row.state))[:80],
                    model=str(row.model)[:2000],
                    discount=float(row.discount),
                    # Terminal compaction intentionally clears per-request state.
                    # Preserve truthful unified-list totals from its bounded summary,
                    # while still accepting a larger live map during active work.
                    requests=request_count,
                    retrieved=min(
                        max(int(row.summary_retrieved or 0), live_retrieved),
                        request_count,
                    ),
                    submitted_at=row.submitted_at,
                    polled_at=row.polled_at,
                )
            )
        related = RelatedJobsPublic(
            llm_batches=safe_batches,
            total=len(batches),
            truncated=len(batches) > len(safe_batches),
        )
    system_workers: SchedulerHealthPublic | None = None
    if await has_permission(request, "automation", "read"):
        system_workers = SchedulerHealthPublic.model_validate(
            await state.scheduler_health()
        )
    return JobListResponse(
        jobs=[public_job(row) for row in selected],
        total=total,
        limit=limit,
        offset=offset,
        related=related,
        system_workers=system_workers,
    )


async def _owned(job_id: str, request: Request, state: AppState) -> Job:
    job = await state.jobs.get(job_id)
    if (
        job is not None
        and not job.actor
        and job.kind == JobKind.TIERED_RESET
        and job.params == {"scope": "factory"}
        and await has_permission(request, "users", "manage")
    ):
        return job
    generation = await _request_generation(request, state)
    if (
        job is None
        or job.actor.strip().lower() != current_username(request).strip().lower()
        or job.actor_generation != generation
    ):
        raise HTTPException(404, detail="job not found")
    return job


async def _request_generation(request: Request, state: AppState) -> str:
    actor = current_username(request)
    if not state.auth.is_enabled:
        return ""
    from ..constants import USERS_KEY, USERS_NS
    from ..models import User

    getter = getattr(state.kv, "get_strict", None) or state.kv.get
    try:
        doc = await getter(USERS_NS, USERS_KEY)
        if doc is not None and not isinstance(doc, dict):
            raise ValueError("invalid user registry")
        raw = (doc or {}).get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("invalid user registry")
        users = [User.model_validate(row) for row in raw]
    except Exception as exc:
        raise HTTPException(503, detail="durable actor registry unavailable") from exc
    persisted = next(
        (user for user in users if user.username.strip().lower() == actor.lower()),
        None,
    )
    if persisted is not None and persisted.active:
        return account_generation(persisted.username, persisted.created_at)
    if actor.lower() == state.secrets.auth_admin_username.lower():
        return "env-admin"
    raise HTTPException(403, detail="active account identity is unavailable")


@router.get("/jobs/{job_id}", response_model=JobPublic)
async def get_job(
    job_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobPublic:
    return public_job(await _owned(job_id, request, state))


@router.post("/jobs/{job_id}/cancel", status_code=202, response_model=JobPublic)
async def cancel_job(
    job_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobPublic:
    job = await state.jobs.request_cancel(
        job_id,
        current_username(request),
        await _request_generation(request, state),
    )
    if job is None:
        raise HTTPException(404, detail="job not found")
    if not await state.job_runner.reconcile_audits():
        raise HTTPException(
            503,
            detail="cancellation is durable but its transition audit is unavailable",
        )
    job = await state.jobs.get(job.job_id) or job
    await state.job_runner.publish(job, force=True)
    state.job_runner.notify()
    return public_job(job)


def _download_target(job: Job, artifact: JobArtifact) -> AuditTarget:
    """The target of a job file's download row: the target the job's other rows name,
    so the download reads as part of that job (``?target=<job id>``). An audit
    export's ``export`` target (its file name), a data export job's ``export`` target
    (its scopes), and the ``job`` itself for any other kind."""
    if job.kind == JobKind.AUDIT_EXPORT:
        return audit_export.export_target(job.job_id, artifact.filename)
    if job.kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        return data_export_audit_target(job.job_id, list(job.params.get("scopes") or []))
    return AuditTarget(type="job", id=job.job_id, label=artifact.filename)


async def _audit_download(state: AppState, request: Request, job: Job) -> None:
    """Record a job artifact download before a byte is streamed (Round 14 SPEC
    §4.5.6): one row per download, always in the control audit (§3.5), naming the
    job, its kind, the artifact and the verified size and SHA-256. An audit export's
    download is ``audit.export_downloaded``; every other kind's is
    ``job.artifact_downloaded``. The row names the job's own target
    (:func:`_download_target`), so it pairs with the job's requested and worker rows.
    A failed append refuses the download with ``503 audit_unavailable``: an unaudited
    copy never leaves the server."""
    artifact = job.artifact
    if artifact is None:
        raise HTTPException(404, detail="job artifact not found")
    is_audit_export = job.kind == JobKind.AUDIT_EXPORT
    target = _download_target(job, artifact)
    context = audit_context(request)
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.DATA_EXPORT,
            surface="jobs",
            actor=current_username(request) or job.actor,
            actor_type="human",
            action="audit.export_downloaded" if is_audit_export else "job.artifact_downloaded",
            outcome="success",
            target=target,
            result_summary=(
                f"downloaded {artifact.filename} ({artifact.size:,} bytes, "
                f"SHA-256 {artifact.sha256})"
            ),
            tool_input={
                "job_id": job.job_id,
                "kind": job.kind.value,
                "artifact_id": artifact.artifact_id,
                "bytes": artifact.size,
                "sha256": artifact.sha256,
            },
            **context.record_fields(),
        )
    except Exception as exc:  # noqa: BLE001 (every append failure means "not audited")
        logger.error("Job %s artifact download refused: the audit append failed: %s", job.job_id, exc)
        raise AuditUnavailableError(
            "The audit log could not be written, so the file was not downloaded."
        ) from exc


_ARTIFACT_BINARY = {"schema": {"type": "string", "format": "binary"}}


@router.get(
    "/jobs/{job_id}/artifact",
    responses={
        200: {
            "description": (
                "The verified artifact: a ZIP for a data export, a CSV or JSON Lines "
                "file for an audit export. Every download is audited first."
            ),
            "content": {
                "application/zip": _ARTIFACT_BINARY,
                "text/csv": _ARTIFACT_BINARY,
                "application/x-ndjson": _ARTIFACT_BINARY,
            },
        },
        503: {"description": "audit_unavailable: the download could not be audited"},
    },
)
async def job_artifact(
    job_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
):
    job = await _owned(job_id, request, state)
    if job.artifact is None:
        raise HTTPException(404, detail="job artifact not found")
    if not await state.job_runner.permission_alive(job):
        raise HTTPException(403, detail="job artifact permission is no longer active")
    try:
        path = await state.job_runner.verify_artifact(job.artifact)
    except (FileNotFoundError, ValueError):
        await state.jobs.expire_artifact(job.job_id, job.artifact.artifact_id)
        raise HTTPException(410, detail="job artifact expired or failed integrity verification") from None
    # Audited before streaming; the row describes the verified file.
    await _audit_download(state, request, job)
    return FileResponse(
        path,
        media_type=job.artifact.content_type,
        filename=job.artifact.filename,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Length": str(job.artifact.size),
        },
    )
