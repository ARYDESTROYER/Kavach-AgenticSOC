"""The runbook library API (Round 14 SPEC §4.10.5, §4.10.15, §4.10.16).

One Runbooks feature: phased response procedures that analysts work through as a
checklist and the investigator reads as trusted, advisory guidance once Published
(#9). A runbook never closes a case; the case policy does that (#3). This router
serves the LIBRARY (built-ins and operator runbooks, their versions and governance);
the per-case runs, ``POST /api/runbooks/progress`` and ``POST
/api/runbooks/lookup-test`` live in ``routes_case_runbooks.py``.

Grants: reads ``runbooks:read``; writing drafts, duplicating, importing, submitting,
retiring and restoring an old version as a draft ``runbooks:manage``; publishing,
rejecting, un-retiring and Mark reviewed ``runbooks:publish``; the match preview and
the metrics also ``cases:read``. Draft and in-review versions are visible only to a
holder of ``manage`` or ``publish``.

Every write is audited BEFORE it becomes visible (SPEC §3.6, E16): the pre-checks
(Demo Mode, the revision, the transition's legality) run first and write no row; the
action row is appended strictly to the control audit (the library is real state in
Demo Mode too, §3.5); then the strict compare-and-set store write runs, and a failed
write appends its ``<resource>.<verb>_failed`` row. A stale ``expected_revision``
answers ``409 runbook_conflict`` with the latest detail.

Route order: the fixed paths (``/metrics``, ``/validate``, ``/match-preview``,
``/import``, ``/reindex``) are declared before ``/{runbook_id}``; the reserved ids of
SPEC §4.10.2 keep a runbook from taking one of those names.

For one release (D44, E14): ``?shape=v1`` on the list and detail answers the old
runbook shape (Published text only) with ``Deprecation`` and ``Link`` headers, and an
old-shape write (``{id, content}`` on ``POST /api/runbooks``, ``PUT`` or ``DELETE
/api/runbooks/{id}``) answers ``410 runbooks_moved``: it cannot be honoured without
making unreviewed text trusted. The body check reads the raw JSON before the body is
validated, so an old-shape body answers ``410`` whatever else it carries.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.types import Message

from ..audit.context import audit_context
from ..audit.write import AuditUnavailableError, audited_write
from ..constants import ActionType
from ..engine import runbook_catalog as catalog
from ..engine.runbook_catalog import CatalogError
from ..engine.runbook_model import builtin_runbook, valid_runbook_id
from ..models import (
    RUNBOOK_STEP_MAX_REASON_CHARS,
    AuditTarget,
    MatchPreview,
    RunbookDetail,
    RunbookDiscardResult,
    RunbookDraftBody,
    RunbookIssue,
    RunbookLibrary,
    RunbookMetrics,
    RunbookPublishBody,
    RunbookRejectBody,
    RunbookRevisionBody,
    RunbookSourceBody,
    RunbookValidation,
    RunbookVersionBody,
    RunbookVersionDoc,
)
from ..state import AppState
from ..stores.runbook_library import (
    RunbookDemoReadOnly,
    RunbookDocumentInvalid,
    RunbookNotFound,
    RunbookStoreError,
    StoredRunbookRecord,
)
from ..utils import iso_now, now_utc
from .deps import current_user, current_username, get_state, require_permission, resolve_grants

logger = logging.getLogger("tlsoc.api.runbooks")


class _RunbooksMoved(Exception):
    """Raised by :func:`_old_shape_guard` before the body is validated; answered as
    ``410 runbooks_moved`` by :class:`_RunbookRoute`."""


#: The methods whose body this router reads (and bounds).
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})


def _body_too_large() -> JSONResponse:
    return JSONResponse(status_code=413, content={"detail": {
        "code": "runbook_body_too_large",
        "message": f"The request is larger than {catalog.RUNBOOK_BODY_MAX_BYTES // 1024:,} KiB.",
    }})


async def _bounded_request(request: Request) -> Request | None:
    """The request with its body read up to :data:`catalog.RUNBOOK_BODY_MAX_BYTES`, or
    ``None`` when the body is larger. A declared ``Content-Length`` over the bound is
    refused before a byte is read; a body without one (chunked) is read only until it
    passes the bound. The body that fits is replayed to the handler, so FastAPI parses
    it exactly once and never sees an oversized one."""
    declared = request.headers.get("content-length", "").strip()
    if declared.isdigit() and int(declared) > catalog.RUNBOOK_BODY_MAX_BYTES:
        return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > catalog.RUNBOOK_BODY_MAX_BYTES:
            return None
        chunks.append(chunk)
    body = b"".join(chunks)
    replayed = False

    async def receive() -> Message:
        nonlocal replayed
        if not replayed:
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await request.receive()

    return Request(request.scope, receive)


class _RunbookRoute(APIRoute):
    """The router's route class (``include_router`` keeps a route's class, so this holds
    wherever the router is mounted):

    * the body of a POST, PUT or PATCH is bounded BEFORE FastAPI reads and parses it
      (FastAPI reads the whole body before it solves any dependency, so a dependency
      cannot bound it): over :data:`catalog.RUNBOOK_BODY_MAX_BYTES` answers ``413
      runbook_body_too_large``, whatever the body holds and whether or not it declares
      its length;
    * :class:`_RunbooksMoved` is answered with the shared ``410 runbooks_moved`` body.

    Every other exception passes through unchanged."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def route(request: Request) -> Response:
            if request.method in _BODY_METHODS:
                bounded = await _bounded_request(request)
                if bounded is None:
                    return _body_too_large()
                request = bounded
            try:
                return await handler(request)
            except _RunbooksMoved:
                return catalog.runbooks_moved_response()

        return route


router = APIRouter(prefix="/api", route_class=_RunbookRoute)

#: One callable per grant, so a route that names a grant both in its decorator (to
#: run it before the body checks) and as a parameter resolves it once per request.
_READ = require_permission("runbooks", "read")
_MANAGE = require_permission("runbooks", "manage")
_PUBLISH = require_permission("runbooks", "publish")
_CASES_READ = require_permission("cases", "read")

_SURFACE = "runbooks"
_TITLE_LABEL_MAX = 200
#: The window token the metrics default to (SPEC §4.10.15).
_METRICS_WINDOW_MAX_CHARS = 64


# --------------------------------------------------------------------------- #
# Viewer, guards and error mapping.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _Viewer:
    """What this caller may see (resolved once, never audited: a missing grant here
    hides data, it does not refuse the request)."""

    can_manage: bool
    can_publish: bool
    can_read_cases: bool
    scoped: bool

    @property
    def can_see_unpublished(self) -> bool:
        return self.can_manage or self.can_publish

    @property
    def sees_case_figures(self) -> bool:
        return self.can_read_cases and not self.scoped


def _caller_role(request: Request) -> str:
    try:
        user = current_user(request)
    except Exception:  # noqa: BLE001 - the no-auth profile
        user = None
    role = getattr(user, "role", "") if user is not None else ""
    return str(getattr(role, "value", role) or "")


def _object_scoped(state: AppState, request: Request) -> bool:
    """Row-level data scope applies to this caller's case reads (the rule the chat
    starters, ``/auth/me`` and the metrics breakdown use, failing closed). Case-derived
    runbook figures do not respect row scope yet (SPEC D16), so a scoped caller gets
    none of them."""
    from ..engine.chat_starters import object_scoped

    return bool(object_scoped(state, _caller_role(request)))


async def _viewer(state: AppState, request: Request) -> _Viewer:
    granted = await resolve_grants(request, [
        ("runbooks", "manage"), ("runbooks", "publish"), ("cases", "read"),
    ])
    return _Viewer(
        can_manage=("runbooks", "manage") in granted,
        can_publish=("runbooks", "publish") in granted,
        can_read_cases=("cases", "read") in granted,
        scoped=_object_scoped(state, request),
    )


def _http(err: CatalogError) -> HTTPException:
    return HTTPException(status_code=err.status, detail=err.detail())


def _store_error(exc: BaseException) -> CatalogError | None:
    """The catalog error a library store refusal answers (SPEC §4.10.15)."""
    from ..stores.runbook_library import (
        RunbookConflict,
        RunbookExists,
        RunbookLimitReached,
        RunbookStoreUnavailable,
    )

    if isinstance(exc, RunbookNotFound):
        return catalog.not_found()
    if isinstance(exc, RunbookConflict):
        return CatalogError(409, "runbook_conflict",
                            "Someone else changed this runbook. Reload it to see their changes.",
                            revision=exc.current_revision)
    if isinstance(exc, RunbookExists):
        return CatalogError(409, "runbook_conflict",
                            f"A runbook with the id '{exc.runbook_id}' already exists. Choose another id.",
                            exists=True)
    if isinstance(exc, RunbookLimitReached):
        return CatalogError(409, "runbook_limit", str(exc), limit=exc.kind)
    if isinstance(exc, RunbookDemoReadOnly):
        return catalog.demo_readonly()
    if isinstance(exc, RunbookStoreUnavailable):
        return CatalogError(503, "runbook_store_unavailable",
                            "The runbook library could not be read or saved right now. Try again.")
    if isinstance(exc, RunbookDocumentInvalid):
        return CatalogError(422, "runbook_invalid", str(exc))
    return None


async def _conflict_detail(state: AppState, viewer: _Viewer, runbook_id: str, err: CatalogError) -> CatalogError:
    """``409 runbook_conflict`` carries the latest state (SPEC §4.10.15), as this viewer
    may see it, so the editor can show it without another round trip."""
    if err.code != "runbook_conflict" or "latest" in err.extra:
        return err
    try:
        latest = await _detail(state, viewer, runbook_id)
    except Exception:  # noqa: BLE001 - the conflict itself is the answer
        return err
    extra = dict(err.extra)
    extra.setdefault("revision", latest.revision)
    extra["latest"] = latest.model_dump(mode="json")
    return CatalogError(err.status, err.code, err.message, **extra)


async def _raise(state: AppState, viewer: _Viewer, runbook_id: str, exc: BaseException) -> None:
    """Re-raise ``exc`` as the HTTP error it answers (unknown errors propagate)."""
    if isinstance(exc, HTTPException):
        raise exc
    err = exc if isinstance(exc, CatalogError) else _store_error(exc)
    if err is None:
        raise exc
    err = await _conflict_detail(state, viewer, runbook_id, err)
    raise _http(err) from exc


async def _guarded(state: AppState, viewer: _Viewer, runbook_id: str, call: Callable[[], Awaitable[Any]]) -> Any:
    """Run ``call`` and answer any catalog or store refusal with its HTTP error."""
    try:
        return await call()
    except (CatalogError, RunbookStoreError, RunbookNotFound, RunbookDocumentInvalid) as exc:
        await _raise(state, viewer, runbook_id, exc)
        raise AssertionError("unreachable")  # pragma: no cover


def _demo_guard(state: AppState) -> None:
    """Every library write is refused in Demo Mode (SPEC §3.5), before any audit row."""
    if state.demo_active:
        raise _http(catalog.demo_readonly())


def _readonly_guard(runbook_id: str) -> None:
    if builtin_runbook(runbook_id) is not None:
        raise _http(catalog.readonly_builtin())


def _content_guard(body: RunbookSourceBody) -> JSONResponse | None:
    """The old write shape (``{id, content}``) answers ``410 runbooks_moved`` (E14)."""
    if "content" in body.model_fields_set:
        return catalog.runbooks_moved_response()
    return None


async def _old_shape_guard(request: Request) -> None:
    """``410 runbooks_moved`` for any JSON object carrying the old write shape's
    ``content`` key, read from the raw body BEFORE the body is validated: an old client
    whose body would also fail the new model (an id over 64 characters, a key the new
    shape does not take) still learns that the route moved, not that its fields are
    wrong (E14). Runs after the grant check (it is listed after it)."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - no JSON body: the body validation answers
        return
    if isinstance(body, dict) and "content" in body:
        raise _RunbooksMoved()


async def _reject_reason_guard(request: Request) -> None:
    """A rejection's reason is required and at most
    :data:`RUNBOOK_STEP_MAX_REASON_CHARS` characters, read from the raw body BEFORE the
    body is validated, so a missing, empty, blank or overlong reason gets the package's
    own ``422 runbook_invalid`` (issue path ``reason``) and never the framework's
    generic list: one mistake, one error contract. Runs after the grant check (it is
    listed after it), so a caller without ``runbooks:publish`` learns nothing more."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - no JSON object: the body validation answers
        return
    if not isinstance(body, dict):
        return
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise _http(catalog.invalid([RunbookIssue(
            path="reason", code="required", message="Give a reason so the author knows what to change.",
        )]))
    if len(reason) > RUNBOOK_STEP_MAX_REASON_CHARS:
        raise _http(catalog.invalid([RunbookIssue(
            path="reason", code="too_long",
            message=f"Keep the reason to {RUNBOOK_STEP_MAX_REASON_CHARS:,} characters or fewer.",
        )]))


def _actor(request: Request) -> str:
    return current_username(request) or ""


def _target(runbook_id: str, label: str = "") -> AuditTarget:
    return AuditTarget(type="runbook", id=runbook_id, label=(label or runbook_id)[:_TITLE_LABEL_MAX])


def _check_document(planned: Any) -> None:
    """The storage bounds a write would hit (100 versions, 2 MiB, the stored-document
    invariants), checked as a pre-check so a refusal writes no audit row (SPEC §3.6)."""
    import json

    from ..stores.runbook_library import (
        RUNBOOK_DOC_MAX_BYTES,
        RunbookLimitReached,
        check_stored_runbook,
        encode_runbook,
    )

    try:
        check_stored_runbook(planned)
        size = len(json.dumps(encode_runbook(planned), ensure_ascii=False,
                              separators=(",", ":")).encode("utf-8", "surrogatepass"))
        if size + 32 > RUNBOOK_DOC_MAX_BYTES:
            raise RunbookLimitReached("size")
    except (RunbookStoreError, RunbookDocumentInvalid) as exc:
        err = _store_error(exc)
        if err is None:  # pragma: no cover - every storage refusal maps
            raise
        raise _http(err) from exc


async def _stored_revision(state: AppState, viewer: _Viewer, runbook_id: str) -> int:
    """The revision a new runbook's document is written over (a discarded runbook of
    that id leaves a tombstone), so the create's action row names the revision the
    write creates (SPEC §3.6). Read as a pre-check: a failure writes no row."""
    return int(await _guarded(state, viewer, runbook_id,
                              lambda: catalog.stored_revision(state.runbook_library, runbook_id)))


async def _check_room(state: AppState, viewer: _Viewer) -> None:
    """A new runbook needs room in the library (200 operator runbooks, SPEC §4.10.5)."""
    from ..models import MAX_OPERATOR_RUNBOOKS
    from ..stores.runbook_library import RunbookLimitReached

    rows = await _guarded(state, viewer, "", lambda: state.runbook_library.list_rows())
    if len(rows) >= MAX_OPERATOR_RUNBOOKS:
        raise _http(_store_error(RunbookLimitReached("runbooks")))  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Reads shared by routes.
# --------------------------------------------------------------------------- #
async def _record(state: AppState, runbook_id: str) -> StoredRunbookRecord | None:
    """The stored operator runbook, or ``None``. An id outside the operator grammar
    (or a reserved one) can name no stored runbook, so it is never looked up."""
    if not valid_runbook_id(runbook_id, "operator"):
        return None
    try:
        return await state.runbook_library.get(runbook_id)
    except (RunbookStoreError, RunbookNotFound) as exc:
        err = _store_error(exc)
        if err is None:
            raise
        raise _http(err) from exc


async def _require_record(state: AppState, runbook_id: str) -> StoredRunbookRecord:
    record = await _record(state, runbook_id)
    if record is None:
        raise _http(catalog.not_found(runbook_id))
    return record


async def _runs_30d(state: AppState, viewer: _Viewer) -> dict[str, int] | None:
    """Runs started in the last 30 days per runbook, or ``None`` when the viewer may
    not read case figures (or the ledger cannot be read right now)."""
    if not viewer.sees_case_figures:
        return None
    try:
        return await catalog.runs_started_since(
            state.runbook_runs, now_utc() - timedelta(days=catalog.RUNS_30D_DAYS),
        )
    except Exception as exc:  # noqa: BLE001 - the column degrades alone
        logger.warning("runbook runs (30 days) not read: %s", exc)
        return None


async def _run_figures(state: AppState, viewer: _Viewer, runbook_id: str) -> tuple[int | None, dict[int, int]]:
    """One runbook's runs started in the last 30 days and its active runs pinned to
    each version ("3 open cases stay on v4"), from ONE read of the run ledger per
    request (every retained month, read at once: an active run can have started in
    any of them). Both are case figures, so a viewer who may not read them (no
    ``cases:read``, or row-level scope on) gets ``(None, {})``, like the list's
    ``runs_30d``; a ledger that cannot be read right now degrades both alone."""
    if not viewer.sees_case_figures:
        return None, {}
    try:
        rows = await catalog.ledger_rows(state.runbook_runs)
        since = now_utc() - timedelta(days=catalog.RUNS_30D_DAYS)
        started = await catalog.runs_started_since(state.runbook_runs, since, rows=rows)
        open_runs = await catalog.open_runs_by_version(state.runbook_runs, runbook_id, rows=rows)
    except Exception as exc:  # noqa: BLE001 - the figures degrade alone
        logger.warning("runbook run figures not read for %s: %s", runbook_id[:80], exc)
        return None, {}
    return started.get(runbook_id, 0), open_runs


async def _detail(state: AppState, viewer: _Viewer, runbook_id: str,
                  record: StoredRunbookRecord | None = None) -> RunbookDetail:
    """One runbook's detail as ``viewer`` may see it (a built-in or an operator
    runbook); ``404 runbook_not_found`` when nothing of it is visible. The run figures
    are read only once the runbook is known to be visible."""
    item = builtin_runbook(runbook_id)
    if item is not None:
        snap = await catalog.snapshot(state.runbook_library)
        runs_30d, open_runs = await _run_figures(state, viewer, runbook_id)
        return catalog.builtin_detail(
            item, replaced_by=snap.replaced_by.get(item.id), runs_30d=runs_30d, open_runs=open_runs,
        )
    if record is None:
        record = await _require_record(state, runbook_id)
    if catalog.summary_from_row(_row(record), can_see_unpublished=viewer.can_see_unpublished) is None:
        raise _http(catalog.not_found(runbook_id))
    runs_30d, open_runs = await _run_figures(state, viewer, runbook_id)
    try:
        return catalog.operator_detail(
            record.runbook, record.revision, can_see_unpublished=viewer.can_see_unpublished,
            runs_30d=runs_30d, open_runs=open_runs,
        )
    except CatalogError as err:
        raise _http(err) from err


def _visible_version(doc: Any, number: int, viewer: _Viewer) -> RunbookVersionDoc:
    version = doc.version(int(number))
    if version is None or (version.state in ("draft", "in_review") and not viewer.can_see_unpublished):
        raise _http(catalog.version_not_found(int(number)))
    return version


def _default_version(doc: Any, viewer: _Viewer) -> RunbookVersionDoc | None:
    """The version an export or a preview reads by default: the working version for a
    viewer who may see it, else the live one, else the retired one."""
    if viewer.can_see_unpublished:
        working = catalog.working_version(doc)
        if working is not None:
            return working
    return doc.live or doc.retired_version


# --------------------------------------------------------------------------- #
# The audited write.
# --------------------------------------------------------------------------- #
async def _audited(
    state: AppState,
    request: Request,
    viewer: _Viewer,
    *,
    runbook_id: str,
    label: str,
    action: str,
    expected_revision: int | None,
    changes: list[dict[str, Any]],
    write: Callable[[], Awaitable[Any]],
    result_summary: str,
    tool_input: dict[str, Any] | None = None,
    reproject: set[str] | None = None,
) -> Any:
    """``audited_write`` for one library change (control audit, SPEC §3.5, §3.6). The
    store write's refusals become their HTTP errors inside the write, so the failure
    row records the code. After a publish, retire or restore the retrieval index is
    asked to reproject the ``reproject`` ids in the background (the runbook, and the
    built-in a copy replaces, whose own projection changes with it)."""

    async def run_write() -> Any:
        return await _guarded(state, viewer, runbook_id, write)

    async def after(_result: Any) -> None:
        if not reproject:
            return
        try:
            state.spawn_mutation_task(catalog.reproject(getattr(state, "rag", None), set(reproject)),
                                      name=f"runbook-reproject-{runbook_id[:40]}")
        except Exception as exc:  # noqa: BLE001 - the change is saved; retrieval catches up
            logger.warning("runbook reprojection not started for %s: %s", runbook_id[:80], exc)

    return await audited_write(
        state,
        sink="control",
        action=action,
        target=_target(runbook_id, label),
        expected_revision=expected_revision,
        changes=changes,
        write=run_write,
        action_type=ActionType.RUNBOOK,
        actor=_actor(request),
        actor_type="human",
        surface=_SURFACE,
        context=audit_context(request),
        result_summary=result_summary[:500],
        tool_input={"runbook_id": runbook_id, **(tool_input or {})},
        after_write=after,
    )


async def _transition(
    state: AppState,
    request: Request,
    viewer: _Viewer,
    runbook_id: str,
    *,
    action: str,
    expected_revision: int | None,
    apply: Callable[[Any, str], Any],
    summary: Callable[[Any], str],
    extra_changes: Callable[[Any, Any], list[dict[str, Any]]] | None = None,
    tool_input: dict[str, Any] | Callable[[Any, Any], dict[str, Any]] | None = None,
    reproject: bool = False,
) -> RunbookDetail:
    """One governance transition: pre-checks (no row), the action row, the strict
    compare-and-set write, then the viewer's detail of the result. ``tool_input`` may
    be computed from the document before and after the change."""
    _demo_guard(state)
    _readonly_guard(runbook_id)
    record = await _require_record(state, runbook_id)
    if expected_revision is not None and int(expected_revision) != record.revision:
        await _raise(state, viewer, runbook_id, CatalogError(
            409, "runbook_conflict", "Someone else changed this runbook. Reload it to see their changes.",
            revision=record.revision))
    now = iso_now()
    try:
        planned = apply(record.runbook.model_copy(deep=True), now)
    except CatalogError as err:
        # A refusal of the transition itself; a conflict (the version changed after
        # the publisher reviewed it) carries the latest state like every other one.
        await _raise(state, viewer, runbook_id, err)
        raise AssertionError("unreachable") from err  # pragma: no cover
    _check_document(planned)
    changes = catalog.state_changes(record.runbook, planned)
    if extra_changes is not None:
        changes += extra_changes(record.runbook, planned)
    inputs = tool_input(record.runbook, planned) if callable(tool_input) else tool_input

    async def write() -> StoredRunbookRecord:
        return await state.runbook_library.update(
            runbook_id, lambda doc: apply(doc, now), expected_revision=record.revision,
        )

    updated = await _audited(
        state, request, viewer, runbook_id=runbook_id, label=_title(planned), action=action,
        expected_revision=record.revision, changes=changes, write=write,
        result_summary=summary(planned), tool_input=inputs,
        reproject=_reproject_ids(record.runbook) if reproject else None,
    )
    return await _detail(state, viewer, runbook_id, updated)


def _reproject_ids(doc: Any) -> set[str]:
    """The runbook, and the built-in it replaces (a Published copy takes the
    built-in's place in matching and retrieval, so both projections change)."""
    ids = {doc.id}
    if doc.replaces and builtin_runbook(doc.replaces) is not None:
        ids.add(doc.replaces)
    return ids


def _title(doc: Any) -> str:
    shown = doc.display_version() if hasattr(doc, "display_version") else None
    return shown.definition.title if shown is not None else getattr(doc, "id", "")


def _review_default(state: AppState) -> int:
    return int(getattr(getattr(state.prefs, "runbooks", None), "review_every_days_default", 180) or 180)


# --------------------------------------------------------------------------- #
# Library (fixed paths first).
# --------------------------------------------------------------------------- #
@router.get("/runbooks", response_model=RunbookLibrary)
async def list_runbooks(
    request: Request,
    q: str = Query("", max_length=200, description="Search the id, title, summary and rule chips."),
    state_filter: Literal["draft", "in_review", "published", "retired"] | None = Query(None, alias="state"),
    origin: Literal["builtin", "operator", "imported"] | None = Query(None),
    show_replaced: bool = Query(False, description="Also list built-ins a Published copy replaces."),
    shape: Literal["v1"] | None = Query(None, description="v1: the old runbook shape, for one release."),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> Any:
    """The runbook library: every built-in and operator runbook the caller may see.
    ``runs_30d`` is null without ``cases:read``. ``shape=v1`` answers the old shape
    (Published runbooks only) with deprecation headers."""
    if shape == "v1":
        return await _v1_list(state)
    viewer = await _viewer(state, request)
    try:
        snap = await catalog.snapshot(state.runbook_library)
    except (RunbookStoreError, RunbookNotFound) as exc:
        await _raise(state, viewer, "", exc)
        raise AssertionError("unreachable")  # pragma: no cover
    try:
        notice = await state.runbook_library.migration_notice()
    except Exception as exc:  # noqa: BLE001 - the intro degrades alone
        logger.warning("runbook migration notice not read: %s", exc)
        notice = None
    return catalog.library(
        snap,
        can_see_unpublished=viewer.can_see_unpublished,
        runs_30d=await _runs_30d(state, viewer),
        q=q, state=state_filter, origin=origin, show_replaced=show_replaced,
        migration=notice,
    )


@router.get("/runbooks/metrics", response_model=RunbookMetrics)
async def runbook_metrics(
    request: Request,
    window: str = Query(catalog.METRICS_DEFAULT_WINDOW, max_length=_METRICS_WINDOW_MAX_CHARS),
    state: AppState = Depends(get_state),
    _read=Depends(require_permission("runbooks", "read")),
    _cases=Depends(require_permission("cases", "read")),
) -> RunbookMetrics:
    """Runs, completion times, skipped steps, coverage of human-handled cases, rules
    with no runbook and the with and without cohorts (a comparison, not a cause). Each
    figure states its population; ``partial`` marks lower bounds."""
    from ..agents.chat_tools.common import operator_tz
    from ..engine.time_windows import resolve_window
    from types import SimpleNamespace

    if _object_scoped(state, request):
        raise HTTPException(status_code=409, detail={
            "code": "runbook_scope_unsupported",
            "message": "Runbook figures are hidden while row-level data scope is on.",
        })
    prefs = state.execution_prefs
    try:
        resolved = resolve_window(window, tz=operator_tz(SimpleNamespace(prefs=prefs)), now=now_utc(),
                                  default=catalog.METRICS_DEFAULT_WINDOW)
    except ValueError:
        raise HTTPException(status_code=400, detail={
            "code": "runbook_window_invalid",
            "message": ("window is not a time window this endpoint understands; use all, a relative "
                        "window such as now-30d, a calendar period such as this_month, or a range "
                        "such as 2026-10-01..2026-10-26"),
        }) from None
    viewer = await _viewer(state, request)
    try:
        return await catalog.metrics(
            library_store=state.runbook_library, runs_store=state.runbook_runs,
            cases_store=state.cases, prefs=prefs, window=resolved,
        )
    except (RunbookStoreError, RunbookNotFound) as exc:
        await _raise(state, viewer, "", exc)
        raise AssertionError("unreachable")  # pragma: no cover


@router.post("/runbooks/validate", response_model=RunbookValidation,
             dependencies=[Depends(_READ), Depends(_old_shape_guard)])
async def validate_runbook_route(
    body: RunbookSourceBody,
    state: AppState = Depends(get_state),
    _=Depends(_READ),
) -> Any:
    """Every issue of a definition or Markdown source and the investigator guidance
    length against its budget. Nothing is written. A built-in's own bundled text is
    checked as a built-in (its Source view is not told its id is taken)."""
    moved = _content_guard(body)
    if moved is not None:
        return moved
    try:
        parsed = catalog.definition_from_body(body.definition, body.source)
    except CatalogError as err:
        raise _http(err) from err
    origin = catalog.validation_origin(parsed.definition)
    return catalog.validation(parsed.definition, parsed.parse_issues, origin=origin,
                              version=parsed.version if origin == "builtin" else None)


@router.post("/runbooks/match-preview", response_model=MatchPreview,
             dependencies=[Depends(_READ), Depends(_CASES_READ), Depends(_old_shape_guard)])
async def match_preview_route(
    body: RunbookSourceBody,
    request: Request,
    state: AppState = Depends(get_state),
    _read=Depends(_READ),
    _cases=Depends(_CASES_READ),
) -> Any:
    """Which of the last 500 cases of the last 30 days a definition (or a stored
    runbook, by ``id``) would get. Nothing is attached and no metric changes."""
    moved = _content_guard(body)
    if moved is not None:
        return moved
    if _object_scoped(state, request):
        raise HTTPException(status_code=409, detail={
            "code": "runbook_scope_unsupported",
            "message": "The match preview is hidden while row-level data scope is on.",
        })
    viewer = await _viewer(state, request)
    origin: Literal["builtin", "operator", "imported"] = "operator"
    replaces: str | None = None
    if body.definition is None and body.source is None and body.id:
        item = builtin_runbook(body.id)
        if item is not None:
            definition, origin = item.definition, "builtin"
        else:
            record = await _require_record(state, body.id)
            version = _default_version(record.runbook, viewer)
            if version is None:
                raise _http(catalog.not_found(body.id))
            definition, origin, replaces = version.definition, record.runbook.origin, record.runbook.replaces
    else:
        try:
            definition = catalog.definition_from_body(body.definition, body.source).definition
        except CatalogError as err:
            raise _http(err) from err
        if builtin_runbook(definition.id) is not None:
            origin = "builtin"
        else:
            record = await _record(state, definition.id)
            if record is not None:
                origin, replaces = record.runbook.origin, record.runbook.replaces
    prefs = state.execution_prefs
    try:
        return await catalog.match_preview(
            library_store=state.runbook_library, cases_store=state.cases, prefs=prefs,
            definition=definition, origin=origin, replaces=replaces,
            fallback=bool(getattr(getattr(prefs, "runbooks", None), "fallback", True)),
        )
    except (RunbookStoreError, RunbookNotFound) as exc:
        await _raise(state, viewer, definition.id, exc)
        raise AssertionError("unreachable")  # pragma: no cover


@router.post("/runbooks/import", status_code=201, response_model=RunbookDetail,
             dependencies=[Depends(_MANAGE), Depends(_old_shape_guard)])
async def import_runbook(
    body: RunbookSourceBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(_MANAGE),
) -> Any:
    """Import Markdown (SPEC §4.10.13). It always lands as a new Draft (#9): a
    clashing id is renamed, and every problem is kept as an import note. Imported
    content is due for review at once (D38)."""
    moved = _content_guard(body)
    if moved is not None:
        return moved
    if body.definition is not None or body.source is None:
        raise _http(catalog.invalid([RunbookIssue(
            path="source", code="required", message="Send the runbook's Markdown source to import it.",
        )]))
    _demo_guard(state)
    viewer = await _viewer(state, request)
    snap = await _guarded(state, viewer, "", lambda: catalog.snapshot(state.runbook_library))
    try:
        plan = catalog.import_plan(body.source, snap.taken_ids(), review_default=_review_default(state))
    except CatalogError as err:
        raise _http(err) from err
    await _check_room(state, viewer)
    now, actor = iso_now(), _actor(request)
    doc = catalog.new_operator_runbook(plan.definition, actor=actor, now=now, origin="imported",
                                       replaces=plan.replaces, import_notes=plan.notes, review_due_at=now)
    _check_document(doc)
    version = doc.versions[0]
    record = await _audited(
        state, request, viewer, runbook_id=doc.id, label=version.definition.title,
        action="runbook.imported", expected_revision=await _stored_revision(state, viewer, doc.id),
        changes=[c for c in [catalog.audit_change("version 1 state", None, "draft")] if c],
        write=lambda: state.runbook_library.create(doc),
        result_summary=(f"Imported a runbook as a draft ({len(plan.notes):,} "
                        f"note{'' if len(plan.notes) == 1 else 's'})."),
        tool_input={"version": 1, "content_hash": version.content_hash, "replaces": plan.replaces,
                    "notes": len(plan.notes)},
    )
    return await _detail(state, viewer, doc.id, record)


@router.post("/runbooks/reindex", deprecated=True)
async def reindex_runbooks(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    """Deprecated request-bound full reconciliation of the runbook retrieval
    projection, kept as it was. New workflows submit ``runbook_reindex`` through
    ``POST /api/jobs`` so the full reconciliation survives navigation."""
    result = await state.rag.reindex_runbooks()
    await _reindex_audit(
        state, request,
        f"reindexed runbooks indexed={result.get('indexed', 0)} failed={result.get('failed', 0)}",
        result=result, target=AuditTarget(type="runbook", id="all", label="Every runbook"),
    )
    return result


@router.post("/runbooks", status_code=201, response_model=RunbookDetail,
             dependencies=[Depends(_MANAGE), Depends(_old_shape_guard)])
async def create_runbook(
    body: RunbookSourceBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(_MANAGE),
) -> Any:
    """Create a runbook as a version 1 Draft from ``{definition}`` or ``{source}``.
    The old write shape (``{id, content}``) answers ``410 runbooks_moved``, whatever
    else the body carries."""
    moved = _content_guard(body)
    if moved is not None:
        return moved
    _demo_guard(state)
    viewer = await _viewer(state, request)
    try:
        parsed = catalog.definition_from_body(body.definition, body.source)
        refused = catalog.blocking_parse_issues(parsed)
        if refused:
            raise catalog.invalid(refused)
        definition = catalog.with_review_default(parsed.definition, _review_default(state))
        blocking = catalog.draft_blocking_issues(definition, origin="operator")
        if blocking:
            raise catalog.issues_error(blocking, definition, None)
    except CatalogError as err:
        raise _http(err) from err
    existing = await _record(state, definition.id)
    if existing is not None:
        await _raise(state, viewer, definition.id, CatalogError(
            409, "runbook_conflict",
            f"A runbook with the id '{definition.id}' already exists. Choose another id.", exists=True))
    await _check_room(state, viewer)
    now, actor = iso_now(), _actor(request)
    doc = catalog.new_operator_runbook(definition, actor=actor, now=now)
    _check_document(doc)
    version = doc.versions[0]
    record = await _audited(
        state, request, viewer, runbook_id=doc.id, label=version.definition.title,
        action="runbook.created", expected_revision=await _stored_revision(state, viewer, doc.id),
        changes=catalog.definition_changes(None, version.definition)
        + [c for c in [catalog.audit_change("version 1 state", None, "draft")] if c],
        write=lambda: state.runbook_library.create(doc),
        result_summary="Created a runbook as a draft.",
        tool_input={"version": 1, "content_hash": version.content_hash},
    )
    return await _detail(state, viewer, doc.id, record)


# --------------------------------------------------------------------------- #
# One runbook.
# --------------------------------------------------------------------------- #
@router.get("/runbooks/{runbook_id}", response_model=RunbookDetail)
async def get_runbook(
    runbook_id: str,
    request: Request,
    shape: Literal["v1"] | None = Query(None, description="v1: the old runbook shape, for one release."),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> Any:
    """One runbook: its summary, live version, version list and (to a holder of
    ``runbooks:manage`` or ``runbooks:publish``) its draft and in-review versions."""
    if shape == "v1":
        return await _v1_detail(state, runbook_id)
    viewer = await _viewer(state, request)
    return await _detail(state, viewer, runbook_id)


@router.put("/runbooks/{runbook_id}", deprecated=True, status_code=410)
async def update_runbook_old_shape(
    runbook_id: str,
    _=Depends(require_permission("runbooks", "manage")),
) -> JSONResponse:
    """Retired old-shape write: answers ``410 runbooks_moved`` (E14). Edit the draft
    with ``PUT /api/runbooks/{id}/draft``."""
    del runbook_id
    return catalog.runbooks_moved_response()


@router.delete("/runbooks/{runbook_id}", deprecated=True, status_code=410)
async def delete_runbook_old_shape(
    runbook_id: str,
    _=Depends(require_permission("runbooks", "manage")),
) -> JSONResponse:
    """Retired old-shape write: answers ``410 runbooks_moved`` (E14). Discard a draft
    with ``DELETE /api/runbooks/{id}/draft``; retire a published runbook with
    ``POST /api/runbooks/{id}/retire``."""
    del runbook_id
    return catalog.runbooks_moved_response()


@router.get("/runbooks/{runbook_id}/versions/{version}", response_model=RunbookVersionDoc)
async def get_runbook_version(
    runbook_id: str,
    version: int,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> RunbookVersionDoc:
    """One version with its Markdown source. A draft or in-review version is
    ``404 runbook_version_not_found`` without ``manage`` or ``publish``."""
    viewer = await _viewer(state, request)
    item = builtin_runbook(runbook_id)
    if item is not None:
        if int(version) != item.version:
            raise _http(catalog.version_not_found(int(version)))
        return catalog.builtin_version_doc(item)
    record = await _require_record(state, runbook_id)
    if catalog.summary_from_row(_row(record), can_see_unpublished=viewer.can_see_unpublished) is None:
        raise _http(catalog.not_found(runbook_id))
    return _visible_version(record.runbook, version, viewer)


def _row(record: StoredRunbookRecord) -> Any:
    from ..stores.runbook_library import index_row_for

    return index_row_for(record.runbook, record.revision)


@router.put("/runbooks/{runbook_id}/draft", response_model=RunbookDetail)
async def save_runbook_draft(
    runbook_id: str,
    body: RunbookDraftBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> RunbookDetail:
    """Save the draft. Editing a Published runbook creates the next version as a
    draft (D39); editing a version in review takes it back to draft. A draft may hold
    content problems (the editor lists them); its id and size must be valid. A stale
    ``expected_revision`` answers ``409 runbook_conflict`` with the latest."""
    _demo_guard(state)
    _readonly_guard(runbook_id)
    viewer = await _viewer(state, request)
    record = await _require_record(state, runbook_id)
    if int(body.expected_revision) != record.revision:
        await _raise(state, viewer, runbook_id, CatalogError(
            409, "runbook_conflict", "Someone else changed this draft. Reload it to see their changes.",
            revision=record.revision))
    now, actor = iso_now(), _actor(request)
    try:
        parsed = catalog.definition_from_body(body.definition, body.source)
        refused = catalog.blocking_parse_issues(parsed)
        if refused:
            raise catalog.invalid(refused)
        definition = catalog.with_review_carried(parsed.definition, record.runbook, _review_default(state))
        if catalog.unchanged_save(record.runbook, definition):
            # Nothing changed (an autosave, Save pressed twice): no write and no audit
            # row, and a version in review stays in review.
            return await _detail(state, viewer, runbook_id, record)
        planned = catalog.t_save_draft(record.runbook.model_copy(deep=True), definition, actor=actor, now=now)
        blocking = catalog.draft_blocking_issues(definition, origin=record.runbook.origin)
        if blocking:
            raise catalog.issues_error(blocking, definition, None)
    except CatalogError as err:
        raise _http(err) from err
    before = catalog.working_version(record.runbook) or record.runbook.live or record.runbook.retired_version
    after = catalog.working_version(planned)
    assert after is not None  # the transition always leaves a draft
    _check_document(planned)
    changes = catalog.state_changes(record.runbook, planned) + catalog.definition_changes(
        before.definition if before is not None else None, after.definition)

    async def write() -> StoredRunbookRecord:
        return await state.runbook_library.update(
            runbook_id, lambda doc: catalog.t_save_draft(doc, definition, actor=actor, now=now),
            expected_revision=record.revision,
        )

    updated = await _audited(
        state, request, viewer, runbook_id=runbook_id, label=after.definition.title,
        action="runbook.draft_updated", expected_revision=record.revision, changes=changes, write=write,
        result_summary=f"Saved the draft of version {after.version:,}.",
        tool_input={"version": after.version, "content_hash": after.content_hash},
    )
    return await _detail(state, viewer, runbook_id, updated)


@router.delete("/runbooks/{runbook_id}/draft", response_model=RunbookDiscardResult)
async def discard_runbook_draft(
    runbook_id: str,
    request: Request,
    expected_revision: int | None = Query(None, ge=0),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> RunbookDiscardResult:
    """Discard the draft (or the version in review). A runbook that was never
    published disappears; published history is never deleted."""
    _demo_guard(state)
    _readonly_guard(runbook_id)
    viewer = await _viewer(state, request)
    record = await _require_record(state, runbook_id)
    if expected_revision is not None and int(expected_revision) != record.revision:
        await _raise(state, viewer, runbook_id, CatalogError(
            409, "runbook_conflict", "Someone else changed this runbook. Reload it to see their changes.",
            revision=record.revision))
    now, actor = iso_now(), _actor(request)
    try:
        remaining, removed = catalog.t_discard_draft(record.runbook.model_copy(deep=True), actor=actor, now=now)
    except CatalogError as err:
        raise _http(err) from err
    changes = catalog.state_changes(record.runbook, remaining)
    summary = f"Discarded the draft of version {removed.version:,}."

    if remaining is None:
        await _audited(
            state, request, viewer, runbook_id=runbook_id, label=removed.definition.title,
            action="runbook.draft_discarded", expected_revision=record.revision, changes=changes,
            write=lambda: state.runbook_library.discard(runbook_id, expected_revision=record.revision),
            result_summary=summary + " The runbook was never published, so it is gone.",
            tool_input={"version": removed.version, "removed": True},
        )
        return RunbookDiscardResult(id=runbook_id, removed=True)

    def change(doc: Any) -> Any:
        left, _gone = catalog.t_discard_draft(doc, actor=actor, now=now)
        if left is None:
            raise catalog.state_error("This runbook changed. Reload it and try again.")
        return left

    updated = await _audited(
        state, request, viewer, runbook_id=runbook_id, label=removed.definition.title,
        action="runbook.draft_discarded", expected_revision=record.revision, changes=changes,
        write=lambda: state.runbook_library.update(runbook_id, change, expected_revision=record.revision),
        result_summary=summary, tool_input={"version": removed.version, "removed": False},
    )
    return RunbookDiscardResult(id=runbook_id, removed=False,
                                detail=await _detail(state, viewer, runbook_id, updated))


@router.post("/runbooks/{runbook_id}/duplicate", status_code=201, response_model=RunbookDetail)
async def duplicate_runbook(
    runbook_id: str,
    request: Request,
    body: RunbookRevisionBody | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> RunbookDetail:
    """Copy a built-in or operator runbook into a new draft (``<id>-custom``). A
    built-in's copy replaces the built-in once it is Published."""
    _demo_guard(state)
    viewer = await _viewer(state, request)
    source_doc = None
    if builtin_runbook(runbook_id) is None:
        record = await _require_record(state, runbook_id)
        if body is not None and body.expected_revision is not None and body.expected_revision != record.revision:
            await _raise(state, viewer, runbook_id, CatalogError(
                409, "runbook_conflict", "Someone else changed this runbook. Reload it to see their changes.",
                revision=record.revision))
        source_doc = record.runbook
    snap = await _guarded(state, viewer, runbook_id, lambda: catalog.snapshot(state.runbook_library))
    try:
        plan = catalog.duplicate_plan(runbook_id, source_doc, snap.taken_ids())
    except CatalogError as err:
        raise _http(err) from err
    await _check_room(state, viewer)
    now, actor = iso_now(), _actor(request)
    doc = catalog.new_operator_runbook(plan.definition, actor=actor, now=now, replaces=plan.replaces,
                                       derived_from=plan.derived_from, editors=plan.editors)
    _check_document(doc)
    version = doc.versions[0]
    record = await _audited(
        state, request, viewer, runbook_id=doc.id, label=version.definition.title,
        action="runbook.duplicated", expected_revision=await _stored_revision(state, viewer, doc.id),
        changes=[c for c in [catalog.audit_change("version 1 state", None, "draft")] if c],
        write=lambda: state.runbook_library.create(doc),
        result_summary=f"Duplicated version {plan.derived_from.version:,} of '{plan.derived_from.id}' as a draft.",
        tool_input={"version": 1, "derived_from": plan.derived_from.model_dump(mode="json"),
                    "replaces": plan.replaces, "content_hash": version.content_hash},
    )
    return await _detail(state, viewer, doc.id, record)


@router.post("/runbooks/{runbook_id}/submit", response_model=RunbookDetail)
async def submit_runbook(
    runbook_id: str,
    body: RunbookVersionBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> RunbookDetail:
    """Send a valid draft for review."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.submitted",
        expected_revision=body.expected_revision,
        apply=lambda doc, now: catalog.t_submit(doc, body.version, actor=actor, now=now),
        summary=lambda _doc: f"Sent version {body.version:,} for review.",
        tool_input={"version": body.version},
    )


@router.post("/runbooks/{runbook_id}/publish", response_model=RunbookDetail)
async def publish_runbook(
    runbook_id: str,
    body: RunbookPublishBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "publish")),
) -> RunbookDetail:
    """Make a draft or in-review version live: it becomes trusted investigator
    guidance and starts matching cases. The body names the revision (and the
    version's content hash) the publisher reviewed, so text changed since is never
    published unseen (``409 runbook_conflict``). Fresh sign-in is not required."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    distinct = bool(getattr(getattr(state.prefs, "runbooks", None), "require_distinct_approver", False))
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.published",
        expected_revision=body.expected_revision,
        apply=lambda doc, now: catalog.t_publish(
            doc, body.version, actor=actor, now=now, expected_hash=body.content_hash,
            require_distinct_approver=distinct),
        summary=lambda doc: f"Published version {body.version:,}.",
        extra_changes=lambda before, after: [c for c in [
            catalog.audit_change("live content_hash", _live_hash(before), _live_hash(after)),
            catalog.audit_change("last_reviewed_by", before.last_reviewed_by, after.last_reviewed_by)] if c],
        # The hash of the text that became trusted, whether or not the request named
        # one (``reviewed_hash`` is what the publisher sent, ``None`` when nothing).
        tool_input=lambda _before, after: {
            "version": body.version, "content_hash": _live_hash(after), "reviewed_hash": body.content_hash,
            "distinct_approver": distinct,
        },
        reproject=True,
    )


def _live_hash(doc: Any) -> str | None:
    live = doc.live if doc is not None else None
    return catalog.stored_hash(live) if live is not None else None


@router.post("/runbooks/{runbook_id}/reject", response_model=RunbookDetail,
             dependencies=[Depends(_PUBLISH), Depends(_reject_reason_guard)])
async def reject_runbook(
    runbook_id: str,
    body: RunbookRejectBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(_PUBLISH),
) -> RunbookDetail:
    """Send a version in review back to draft with a reason (required: a missing or
    blank one answers ``422 runbook_invalid`` before any audit row)."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.rejected",
        expected_revision=body.expected_revision,
        apply=lambda doc, now: catalog.t_reject(doc, body.version, body.reason, actor=actor, now=now),
        summary=lambda _doc: f"Sent version {body.version:,} back to draft.",
        extra_changes=lambda _b, _a: [c for c in [catalog.audit_change("review_note", None, body.reason)] if c],
        tool_input={"version": body.version},
    )


@router.post("/runbooks/{runbook_id}/retire", response_model=RunbookDetail)
async def retire_runbook(
    runbook_id: str,
    request: Request,
    body: RunbookRevisionBody | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> RunbookDetail:
    """Retire the live version: the runbook stops matching and stops guiding the
    investigator; runs that use it keep working."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.retired",
        expected_revision=body.expected_revision if body is not None else None,
        apply=lambda doc, now: catalog.t_retire(doc, actor=actor, now=now),
        summary=lambda _doc: "Retired the runbook.",
        reproject=True,
    )


@router.post("/runbooks/{runbook_id}/restore", response_model=RunbookDetail)
async def restore_runbook(
    runbook_id: str,
    request: Request,
    body: RunbookRevisionBody | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "publish")),
) -> RunbookDetail:
    """Republish the last live version of a retired runbook."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.restored",
        expected_revision=body.expected_revision if body is not None else None,
        apply=lambda doc, now: catalog.t_restore(doc, actor=actor, now=now),
        summary=lambda _doc: "Restored the runbook.",
        reproject=True,
    )


@router.post("/runbooks/{runbook_id}/reviewed", response_model=RunbookDetail)
async def mark_runbook_reviewed(
    runbook_id: str,
    request: Request,
    body: RunbookRevisionBody | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "publish")),
) -> RunbookDetail:
    """Mark reviewed: records the reviewer and the time without a new version; the
    next review falls due ``review_every_days`` from now."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.reviewed",
        expected_revision=body.expected_revision if body is not None else None,
        apply=lambda doc, now: catalog.t_reviewed(doc, actor=actor, now=now),
        summary=lambda _doc: "Marked the runbook reviewed.",
        extra_changes=lambda before, after: [c for c in [
            catalog.audit_change("last_reviewed_by", before.last_reviewed_by, after.last_reviewed_by)] if c],
    )


@router.post("/runbooks/{runbook_id}/versions/{version}/restore", response_model=RunbookDetail)
async def restore_runbook_version(
    runbook_id: str,
    version: int,
    request: Request,
    body: RunbookRevisionBody | None = None,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> RunbookDetail:
    """A new draft from an earlier version (its text is checked again at publish)."""
    viewer = await _viewer(state, request)
    actor = _actor(request)
    # Audited as a draft change, never as ``runbook.restored`` (which makes a retired
    # runbook live again): the restored text is a draft and trusts nothing until it
    # is published.
    return await _transition(
        state, request, viewer, runbook_id, action="runbook.draft_updated",
        expected_revision=body.expected_revision if body is not None else None,
        apply=lambda doc, now: catalog.t_restore_version(doc, version, actor=actor, now=now),
        summary=lambda doc: (f"Restored version {version:,} as a new draft "
                             f"(version {_draft_number(doc):,})."),
        extra_changes=lambda before, after: [c for c in [
            catalog.audit_change("restored_from", None, f"version {version}"),
            catalog.audit_change("content_hash", None, _draft_hash(after))] if c],
        tool_input=lambda _before, after: {"from_version": version, "as_draft": True,
                                           "version": _draft_number(after),
                                           "content_hash": _draft_hash(after)},
    )


def _draft_number(doc: Any) -> int:
    draft = doc.draft if doc is not None else None
    return int(draft.version) if draft is not None else 0


def _draft_hash(doc: Any) -> str | None:
    draft = doc.draft if doc is not None else None
    return catalog.stored_hash(draft) if draft is not None else None


@router.get("/runbooks/{runbook_id}/export", response_class=Response,
            responses={200: {"content": {"text/markdown": {}}}})
async def export_runbook(
    runbook_id: str,
    request: Request,
    version: int | None = Query(None, ge=1, description="Default: the version the caller would open."),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> Response:
    """One version as a ``text/markdown`` attachment (SPEC §4.10.13). Every export is
    recorded in the audit log before the file is sent; a failed append refuses it
    (``503 audit_unavailable``)."""
    viewer = await _viewer(state, request)
    item = builtin_runbook(runbook_id)
    if item is not None:
        if version is not None and version != item.version:
            raise _http(catalog.version_not_found(version))
        doc_version = catalog.builtin_version_doc(item)
    else:
        record = await _require_record(state, runbook_id)
        if catalog.summary_from_row(_row(record), can_see_unpublished=viewer.can_see_unpublished) is None:
            raise _http(catalog.not_found(runbook_id))
        if version is not None:
            doc_version = _visible_version(record.runbook, version, viewer)
        else:
            found = _default_version(record.runbook, viewer)
            if found is None:
                raise _http(catalog.not_found(runbook_id))
            doc_version = found
    text = catalog.export_markdown(doc_version)
    payload = text.encode("utf-8")
    file_name = catalog.export_file_name(runbook_id, doc_version.version)
    context = audit_context(request)
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.RUNBOOK,
            surface=_SURFACE,
            actor=_actor(request),
            actor_type="human",
            action="runbook.exported",
            outcome="success",
            target=_target(runbook_id, doc_version.definition.title),
            result_summary=f"Exported version {doc_version.version:,} as Markdown ({len(payload):,} bytes).",
            tool_input={"runbook_id": runbook_id, "version": doc_version.version, "state": doc_version.state,
                        "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()},
            **context.record_fields(),
        )
    except Exception as exc:  # noqa: BLE001 - every append failure means "not audited"
        logger.error("Runbook export refused: the audit append failed: %s", exc)
        raise AuditUnavailableError(
            "The audit log could not be written, so the runbook was not exported.") from exc
    return Response(
        content=payload,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"',
                 "Cache-Control": "no-store"},
    )


@router.post("/runbooks/{runbook_id}/reindex")
async def reindex_runbook(
    runbook_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    """Reproject one runbook in the retrieval index (kept from the earlier API)."""
    if builtin_runbook(runbook_id) is None:
        await _require_record(state, runbook_id)
    result = await state.rag.reindex_runbooks({runbook_id})
    await _reindex_audit(
        state, request,
        (f"reindexed runbook {runbook_id} indexed={result.get('indexed', 0)} "
         f"failed={result.get('failed', 0)}"),
        result=result, target=_target(runbook_id),
    )
    return result


def _reindex_outcome(result: Any) -> str:
    """``success`` when every document was reprojected, ``partial`` when some failed,
    ``failure`` when the reprojection reported itself not done."""
    if not isinstance(result, dict):
        return "unknown"
    failed = int(result.get("failed", 0) or 0)
    if result.get("ok") is False and not int(result.get("indexed", 0) or 0):
        return "failure"
    return "partial" if failed else "success"


async def _reindex_audit(state: AppState, request: Request, summary: str, *, result: Any,
                         target: AuditTarget) -> None:
    """The reindex routes keep their earlier best-effort row (a reprojection rebuilds a
    derived index and changes no runbook), now with the structured fields every new
    row carries (SPEC §4.5.3): the action, its outcome, the target and the request."""
    try:
        await state.control_audit.record(
            action_type=ActionType.RUNBOOK,
            surface=_SURFACE,
            actor=_actor(request) or "operator",
            actor_type="human",
            action="runbook.reindexed",
            outcome=_reindex_outcome(result),
            target=target,
            result_summary=summary,
            **audit_context(request).record_fields(),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("runbook reindex audit row not written: %s", exc)


# --------------------------------------------------------------------------- #
# The old runbook shape (``?shape=v1``), for one release.
# --------------------------------------------------------------------------- #
def _retrieval_enabled(state: AppState) -> bool:
    runbooks = getattr(state.prefs, "runbooks", None)
    rag = getattr(state.prefs, "rag", None)
    return bool(getattr(runbooks, "enabled", True) and getattr(rag, "enabled", False)
                and getattr(runbooks, "rag_corpus", True))


async def _projection(state: AppState, enabled: bool) -> dict[str, int]:
    if not enabled:
        return {}
    reader = getattr(getattr(state, "rag", None), "runbook_projection_revisions", None)
    if not callable(reader):
        return {}
    try:
        return await asyncio.wait_for(reader(), timeout=10.0)
    except Exception as exc:  # noqa: BLE001 - the status degrades to "pending"
        logger.warning("runbook projection status not read: %s", exc)
        return {}


async def _v1_list(state: AppState) -> JSONResponse:
    viewer_free = _Viewer(False, False, False, False)
    try:
        items = await catalog.published_versions(state.runbook_library)
    except (RunbookStoreError, RunbookNotFound) as exc:
        await _raise(state, viewer_free, "", exc)
        raise AssertionError("unreachable")  # pragma: no cover
    enabled = _retrieval_enabled(state)
    projection = await _projection(state, enabled)
    runbooks = [
        catalog.v1_item(runbook_id=rid, version=version, builtin=builtin, doc=doc, enabled=enabled,
                        projection=projection, include_content=False)
        for rid, version, builtin, doc in items
    ]
    return JSONResponse(
        content={
            "enabled": bool(getattr(getattr(state.prefs, "runbooks", None), "enabled", True)),
            "retrieval_enabled": enabled,
            "count": len(runbooks),
            "runbooks": runbooks,
        },
        headers=dict(catalog.DEPRECATION_HEADERS),
    )


async def _v1_detail(state: AppState, runbook_id: str) -> JSONResponse:
    item = builtin_runbook(runbook_id)
    builtin = item
    doc = None
    if item is not None:
        version = catalog.builtin_version_doc(item)
    else:
        record = await _record(state, runbook_id)
        live = record.runbook.live if record is not None else None
        if record is None or live is None:
            raise _http(catalog.not_found(runbook_id))
        version, doc = live, record.runbook
    enabled = _retrieval_enabled(state)
    payload = catalog.v1_item(runbook_id=runbook_id, version=version, builtin=builtin, doc=doc,
                              enabled=enabled, projection=await _projection(state, enabled),
                              include_content=True)
    return JSONResponse(content=payload, headers=dict(catalog.DEPRECATION_HEADERS))
