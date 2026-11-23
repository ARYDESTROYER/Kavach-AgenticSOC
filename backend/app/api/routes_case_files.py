"""Screenshots on a case: the API (Round 15 SPEC D5.3, D5.5, D5.10, D5.11).

    GET    /api/cases/{case_id}/files                         cases:read
    POST   /api/cases/{case_id}/files                         cases:comment
    DELETE /api/cases/{case_id}/files/{file_id}               cases:comment, and the
                                                              uploader or cases:close
    GET    /api/cases/{case_id}/files/{file_id}/content       cases:read

An upload is a JSON body (base64; never multipart, which this stack does not parse):
``{content_type?, data_base64, thumbnail_base64?, filename?, caption?}``. Its body is
bounded at :data:`BODY_MAX_BYTES` (3 MiB) by this router's route class BEFORE FastAPI
reads it (``413 case_files_body_too_large``); the Web UI's nginx gives the path the
same bound. The image is validated and stripped of its metadata by
``engine.case_images`` (PNG, JPEG and WebP only, 2 MiB stored, 8,192 px a side, 40
megapixels; a thumbnail at most 48 KiB), its SHA-256 is checked against the case's
live screenshots (the same image again returns the existing entry, ``200``,
``deduplicated: true``, and writes nothing), and the case and storage bounds of
``stores.case_files`` apply (``409 case_files_case_full``, ``409
case_files_storage_full``). Each caller may make :data:`UPLOADS_PER_MINUTE` uploads a
minute and :data:`CONCURRENT_UPLOADS` at once (``429 case_files_busy`` with
``Retry-After``; process-local, like the chat suggestion bound).

Audit (#2), audit-first through ``audited_write``: ``case.file_attached`` and
``case.file_deleted`` (failures ``case.file_attach_failed`` and
``case.file_delete_failed``), the case as the target, ``changes`` naming the file by
its id, type and size. The ``result_summary`` carries ids and codes only, never a
filename or caption: the chat ``audit_search`` tool forwards ``result_summary`` to the
model. The rows go to the execution audit (the Demo audit in Demo Mode, where the
store is the Demo stack's, within the Demo caps).

Content is served only for a screenshot its case's index lists, with headers this
route sets itself: the sniffed ``Content-Type``, ``X-Content-Type-Options: nosniff``, a
server-generated ASCII filename (``<case number>-<n>.<ext>``, ``inline`` or with
``download=1`` ``attachment``), a ``sandbox`` content security policy, ``Cache-Control:
private, no-store``, ``Cross-Origin-Resource-Policy: same-origin`` and the length. A
storage outage is ``503``, never a false ``404``.

Never on the ``Case`` document, never a ``CaseActivity`` entry, never read by a chat
tool, report, standup, starter, RAG chunk or investigator prompt (#7, #9, the static
guard in the tests), and nothing here reads or changes a case's status, verdict or
disposition: uploads stay allowed on closed cases (#3). This module never imports the
decision core.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import math
import re
import secrets
import time
import weakref
from collections import OrderedDict, deque
from typing import Any, Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import Message

from ..audit.context import audit_context
from ..audit.write import audited_write
from ..constants import ActionType
from ..engine.case_images import (
    EXTENSIONS,
    MAX_PIXELS,
    MAX_SIDE_PX,
    MIME_TYPES,
    ImageRejected,
    ValidatedImage,
    validate_image,
)
from ..models import AuditTarget
from ..state import AppState
from ..stores.case_files import (
    CAPTION_MAX_CHARS,
    FILENAME_MAX_CHARS,
    CaseFileIndex,
    CaseFileRecord,
    CaseFilesError,
    CaseFileStore,
    valid_file_id,
)
from ..utils import iso_now
from .deps import current_username, get_state, has_permission, record_access_denied, require_permission

logger = logging.getLogger("tlsoc.api.case_files")

#: The largest request body an upload may send (the 2 MiB image as base64, its
#: thumbnail and the JSON around them).
BODY_MAX_BYTES = 3 * 1024 * 1024
#: Uploads one caller may make a minute, and at once (SPEC D5.3).
UPLOADS_PER_MINUTE = 30
UPLOAD_WINDOW_S = 60.0
CONCURRENT_UPLOADS = 2
MAX_TRACKED_OWNERS = 4096
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})
#: The clock of the rate bound (tests replace it).
_monotonic = time.monotonic

_DATA_URL_RE = re.compile(r"^data:(image/[a-z0-9.+-]+);base64,", re.I)
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


# --------------------------------------------------------------------------- #
# The bounded route class (the ``routes_runbooks`` precedent).
# --------------------------------------------------------------------------- #
def _body_too_large() -> JSONResponse:
    return JSONResponse(status_code=413, content={"detail": {
        "code": "case_files_body_too_large",
        "message": f"The upload is larger than {BODY_MAX_BYTES // (1024 * 1024):,} MiB.",
    }})


async def _bounded_request(request: Request) -> Request | None:
    """The request with its body read up to :data:`BODY_MAX_BYTES`, or ``None`` when
    it is larger. A declared ``Content-Length`` over the bound is refused before a
    byte is read; a body without one is read only until it passes the bound. The body
    that fits is replayed to the handler, so FastAPI parses it exactly once."""
    declared = request.headers.get("content-length", "").strip()
    if declared.isdigit() and int(declared) > BODY_MAX_BYTES:
        return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > BODY_MAX_BYTES:
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


class _CaseFilesRoute(APIRoute):
    """Bounds the body of a POST, PUT or PATCH before FastAPI reads and parses it
    (FastAPI reads the whole body before it solves any dependency, so a dependency
    cannot bound it): over :data:`BODY_MAX_BYTES` answers ``413
    case_files_body_too_large``. Every other request passes through unchanged."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def route(request: Request) -> Response:
            if request.method in _BODY_METHODS:
                bounded = await _bounded_request(request)
                if bounded is None:
                    return _body_too_large()
                request = bounded
            return await handler(request)

        return route


router = APIRouter(prefix="/api", route_class=_CaseFilesRoute)

_READ = require_permission("cases", "read")
_COMMENT = require_permission("cases", "comment")


# --------------------------------------------------------------------------- #
# The per-caller upload bound (process-local, bounded; nothing is persisted).
# --------------------------------------------------------------------------- #
class _UploadRuntime:
    def __init__(self) -> None:
        self.windows: OrderedDict[str, deque[float]] = OrderedDict()
        self.running: dict[str, int] = {}

    def admit(self, owner: str) -> float | None:
        """``None`` when an upload may start (and its slot is taken), else the seconds
        to wait before the next one may."""
        now = _monotonic()
        window = self.windows.get(owner)
        if window is None:
            window = self.windows[owner] = deque()
        while window and now - window[0] >= UPLOAD_WINDOW_S:
            window.popleft()
        self.windows.move_to_end(owner)
        while len(self.windows) > MAX_TRACKED_OWNERS:
            self.windows.popitem(last=False)
        if self.running.get(owner, 0) >= CONCURRENT_UPLOADS:
            return 1.0
        if len(window) >= UPLOADS_PER_MINUTE:
            return max(0.0, UPLOAD_WINDOW_S - (now - window[0]))
        window.append(now)
        self.running[owner] = self.running.get(owner, 0) + 1
        return None

    def release(self, owner: str) -> None:
        left = self.running.get(owner, 0) - 1
        if left > 0:
            self.running[owner] = left
        else:
            self.running.pop(owner, None)


_RUNTIMES: "weakref.WeakKeyDictionary[Any, _UploadRuntime]" = weakref.WeakKeyDictionary()


def upload_runtime(state: AppState) -> _UploadRuntime:
    runtime = _RUNTIMES.get(state)
    if runtime is None:
        runtime = _RUNTIMES[state] = _UploadRuntime()
    return runtime


# --------------------------------------------------------------------------- #
# Wire models (feature-local, SPEC §4.3: never in ``models.py``).
# --------------------------------------------------------------------------- #
class CaseFileUploadBody(BaseModel):
    """One screenshot upload. ``data_base64`` is the image as base64 (a ``data:``
    URL is accepted too); ``content_type`` the type the client claims (it must match
    the image's magic bytes). A thumbnail is optional (at most 48 KiB once decoded)."""

    model_config = ConfigDict(extra="forbid")

    data_base64: str = Field(min_length=1, max_length=BODY_MAX_BYTES)
    content_type: str | None = Field(default=None, max_length=64)
    thumbnail_base64: str | None = Field(default=None, max_length=128 * 1024)
    filename: str = Field(default="", max_length=1024)
    caption: str = Field(default="", max_length=CAPTION_MAX_CHARS)


class CaseFileEntry(BaseModel):
    """One screenshot as the API lists it (metadata only, never the bytes)."""

    id: str
    case_id: str
    position: int = Field(description="1-based number of the screenshot on its case (upload order).")
    content_type: str
    bytes: int
    width: int
    height: int
    sha256: str
    caption: str = ""
    filename: str = ""
    uploaded_by: str = ""
    uploaded_at: str = ""
    has_thumbnail: bool = False
    thumbnail_bytes: int | None = None
    deleted: bool = False
    deleted_at: str | None = None
    deleted_by: str | None = None
    can_delete: bool = False


class CaseFileLimitsInfo(BaseModel):
    max_files: int
    max_case_bytes: int
    max_file_bytes: int
    max_thumbnail_bytes: int
    max_side_px: int
    max_pixels: int
    max_caption_chars: int
    max_filename_chars: int
    accepted_types: list[str]


class CaseFileList(BaseModel):
    case_id: str
    files: list[CaseFileEntry]
    deleted: list[CaseFileEntry]
    count: int
    bytes: int
    can_upload: bool
    limits: CaseFileLimitsInfo


class CaseFileUploadResult(BaseModel):
    file: CaseFileEntry
    deduplicated: bool = False


class CaseFileDeleteResult(BaseModel):
    file: CaseFileEntry
    deleted: bool = True


# --------------------------------------------------------------------------- #
# Helpers.
# --------------------------------------------------------------------------- #
def _error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message}, headers=headers)


def _store_error(exc: CaseFilesError) -> HTTPException:
    return _error(exc.status, exc.code, exc.message)


def _store(state: AppState) -> CaseFileStore:
    store = getattr(state, "case_files", None)
    if store is None:
        raise _error(503, "case_files_unavailable", "Screenshots are temporarily unavailable.")
    return store


async def _require_case(state: AppState, case_id: str) -> Any:
    try:
        case = await state.cases.get(case_id)
    except Exception as exc:  # noqa: BLE001
        raise _error(503, "case_files_unavailable", "The case could not be read.") from exc
    if not case:
        raise _error(404, "case_not_found", "Case not found.")
    return case


def _case_target(case: Any, case_id: str) -> AuditTarget:
    label = str(getattr(case, "case_number", "") or "") or case_id
    return AuditTarget(type="case", id=case_id, label=label)


def _actor(request: Request) -> str:
    """The verified principal, else ``analyst`` (sign-in off; SPEC D7.2)."""
    return current_username(request) or "analyst"


def _same_person(a: str, b: str) -> bool:
    return bool(a) and a.strip().lower() == (b or "").strip().lower()


def _size_text(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):,.1f} MiB"
    return f"{max(1, math.ceil(n / 1024)):,} KiB"


def _decode_base64(raw: str, *, what: str) -> tuple[bytes, str | None]:
    """The bytes of a base64 field (a ``data:`` URL allowed) and the type a data URL
    names, or ``422 case_files_invalid_base64``."""
    text = raw.strip()
    declared: str | None = None
    match = _DATA_URL_RE.match(text)
    if match:
        declared = match.group(1)
        text = text[match.end():]
    try:
        return base64.b64decode(text, validate=True), declared
    except (binascii.Error, ValueError) as exc:
        raise _error(422, "case_files_invalid_base64", f"The {what} is not valid base64.") from exc


def _rejected(exc: ImageRejected, *, thumbnail: bool = False) -> HTTPException:
    if thumbnail:
        return _error(exc.status, exc.code, f"Thumbnail: {exc.message}")
    return _error(exc.status, exc.code, exc.message)


def _entry(record: CaseFileRecord, position: int, *, can_delete: bool) -> CaseFileEntry:
    return CaseFileEntry(
        id=record.id,
        case_id=record.case_id,
        position=position,
        content_type=MIME_TYPES.get(record.type, "application/octet-stream"),
        bytes=record.bytes,
        width=record.width,
        height=record.height,
        sha256=record.sha256,
        caption=record.caption,
        filename=record.filename,
        uploaded_by=record.uploaded_by,
        uploaded_at=record.uploaded_at,
        has_thumbnail=record.thumb is not None,
        thumbnail_bytes=record.thumb.bytes if record.thumb is not None else None,
        deleted=not record.live,
        deleted_at=record.deleted_at,
        deleted_by=record.deleted_by,
        can_delete=can_delete and record.live,
    )


def _position(index: CaseFileIndex, file_id: str) -> int:
    for number, item in enumerate(index.entries, start=1):
        if item.id == file_id:
            return number
    return len(index.entries) + 1


async def _deleter(request: Request, actor: str) -> Callable[[CaseFileRecord], bool]:
    """Who may delete what: a ``cases:comment`` holder their own uploads, a
    ``cases:close`` holder anyone's (side-effect free: asking writes no row)."""
    if not await has_permission(request, "cases", "comment"):
        return lambda _record: False
    if await has_permission(request, "cases", "close"):
        return lambda _record: True
    signed_in = current_username(request)
    return lambda record: bool(signed_in) and _same_person(record.uploaded_by, actor)


def _limits_info(store: CaseFileStore) -> CaseFileLimitsInfo:
    limits = store.limits
    return CaseFileLimitsInfo(
        max_files=limits.max_files_per_case,
        max_case_bytes=limits.max_case_bytes,
        max_file_bytes=limits.max_file_bytes,
        max_thumbnail_bytes=limits.max_thumbnail_bytes,
        max_side_px=MAX_SIDE_PX,
        max_pixels=MAX_PIXELS,
        max_caption_chars=CAPTION_MAX_CHARS,
        max_filename_chars=FILENAME_MAX_CHARS,
        accepted_types=sorted(MIME_TYPES.values()),
    )


def _publish(state: AppState, case_id: str, kind: str, actor: str, file_id: str) -> None:
    """A ``case.activity`` nudge on the case's room after the save (ids only, #9); the
    Console refetches the list. Best-effort."""
    bus = getattr(state, "event_bus", None)
    if bus is None:
        return
    try:
        bus.publish(f"cases:{case_id}", "case.activity", {
            "case_id": case_id, "kind": kind, "actor": actor, "ref": {"file_id": file_id},
        })
    except Exception:  # noqa: BLE001 - realtime is advisory
        pass


def _download_name(case: Any, case_id: str, position: int, kind: str) -> str:
    base = _SAFE_NAME_RE.sub("-", str(getattr(case, "case_number", "") or case_id)).strip("-.")[:60]
    return f"{base or 'case'}-{position}.{EXTENSIONS.get(kind, 'img')}"


# --------------------------------------------------------------------------- #
# Routes.
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/files", response_model=CaseFileList)
async def list_case_files(
    case_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(_READ),
) -> CaseFileList:
    """The case's screenshots (metadata only, upload order), its deleted ones (their
    metadata kept), what they take and the bounds that apply."""
    await _require_case(state, case_id)
    store = _store(state)
    try:
        index = await store.index(case_id)
    except CaseFilesError as exc:
        raise _store_error(exc) from exc
    actor = _actor(request)
    may_delete = await _deleter(request, actor)
    entries = [_entry(item, n, can_delete=may_delete(item)) for n, item in enumerate(index.entries, start=1)]
    return CaseFileList(
        case_id=case_id,
        files=[e for e in entries if not e.deleted],
        deleted=[e for e in entries if e.deleted],
        count=len(index.live),
        bytes=index.live_bytes,
        can_upload=await has_permission(request, "cases", "comment"),
        limits=_limits_info(store),
    )


@router.post("/cases/{case_id}/files", response_model=CaseFileUploadResult, status_code=201)
async def upload_case_file(
    case_id: str,
    body: CaseFileUploadBody,
    request: Request,
    response: Response,
    state: AppState = Depends(get_state),
    _=Depends(_COMMENT),
) -> CaseFileUploadResult:
    """Attach one screenshot to the case (see the module docstring). Allowed on a
    closed case; never changes the case."""
    actor = _actor(request)
    owner = (current_username(request) or "").strip().lower() or "anonymous"
    runtime = upload_runtime(state)
    wait = runtime.admit(owner)
    if wait is not None:
        raise _error(
            429, "case_files_busy", "Too many uploads at once. Try again shortly.",
            headers={"Retry-After": str(max(1, math.ceil(wait)))},
        )
    try:
        return await _upload(case_id, body, request, response, state, actor)
    finally:
        runtime.release(owner)


async def _upload(
    case_id: str,
    body: CaseFileUploadBody,
    request: Request,
    response: Response,
    state: AppState,
    actor: str,
) -> CaseFileUploadResult:
    case = await _require_case(state, case_id)
    store = _store(state)
    raw, url_type = _decode_base64(body.data_base64, what="image")
    declared = body.content_type or url_type
    try:
        image = await asyncio.to_thread(validate_image, raw, declared=declared, max_bytes=store.limits.max_file_bytes)
    except ImageRejected as exc:
        raise _rejected(exc) from exc
    thumb: ValidatedImage | None = None
    if body.thumbnail_base64:
        thumb_raw, thumb_type = _decode_base64(body.thumbnail_base64, what="thumbnail")
        try:
            thumb = validate_image(thumb_raw, declared=thumb_type, max_bytes=store.limits.max_thumbnail_bytes)
        except ImageRejected as exc:
            raise _rejected(exc, thumbnail=True) from exc
    try:
        index = await store.index(case_id)
        duplicate = next((e for e in index.live if e.sha256 == image.sha256), None)
        may_delete = await _deleter(request, actor)
        if duplicate is not None:
            # The same image is already on the case: an idempotent retry, nothing written.
            response.status_code = 200
            return CaseFileUploadResult(
                file=_entry(duplicate, _position(index, duplicate.id), can_delete=may_delete(duplicate)),
                deduplicated=True,
            )
        total = image.size + (thumb.size if thumb is not None else 0)
        store.check_room(index, await store.usage(), total)
    except CaseFilesError as exc:
        raise _store_error(exc) from exc

    file_id = secrets.token_hex(16)
    uploaded_at = iso_now()

    async def write() -> CaseFileRecord:
        try:
            return await store.add(
                case_id, image, thumb, file_id=file_id, filename=body.filename,
                caption=body.caption, uploaded_by=current_username(request) or "",
                uploaded_at=uploaded_at,
            )
        except CaseFilesError as exc:
            raise _store_error(exc) from exc

    record = await audited_write(
        state,
        sink="execution",
        action="case.file_attached",
        target=_case_target(case, case_id),
        expected_revision=None,
        changes=[{"field": "files", "before": None,
                  "after": f"{file_id} ({image.kind.upper()}, {_size_text(image.size)})"}],
        write=write,
        action_type=ActionType.COLLAB,
        actor=actor,
        actor_type="human",
        surface="case",
        context=audit_context(request),
        case_id=case_id,
        result_summary=f"file_attached file={file_id} type={image.kind} bytes={image.size}",
        after_write=lambda rec: _publish(state, case_id, "file_attached", actor, rec.id),
    )
    try:
        position = _position(await store.index(case_id), record.id)
    except CaseFilesError:
        position = 0
    return CaseFileUploadResult(file=_entry(record, position, can_delete=True), deduplicated=False)


@router.delete("/cases/{case_id}/files/{file_id}", response_model=CaseFileDeleteResult)
async def delete_case_file(
    case_id: str,
    file_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(_COMMENT),
) -> CaseFileDeleteResult:
    """Delete one screenshot: its bytes go, its metadata stays as a deleted entry. The
    uploader may delete their own; a ``cases:close`` holder anyone's (a refusal
    writes an Access denied row)."""
    case = await _require_case(state, case_id)
    store = _store(state)
    actor = _actor(request)
    if not valid_file_id(file_id):
        raise _error(404, "case_file_not_found", "That screenshot was not found.")
    try:
        index = await store.index(case_id)
        record = next((e for e in index.live if e.id == file_id), None)
    except CaseFilesError as exc:
        raise _store_error(exc) from exc
    if record is None:
        raise _error(404, "case_file_not_found", "That screenshot was not found.")
    position = _position(index, file_id)
    signed_in = current_username(request)
    if not (signed_in and _same_person(record.uploaded_by, actor)) and not await has_permission(request, "cases", "close"):
        await record_access_denied(request, [("cases", "close")], target=_case_target(case, case_id))
        raise _error(403, "case_files_delete_forbidden",
                     "Only the person who added a screenshot, or someone who can close cases, can delete it.")

    async def write() -> CaseFileRecord:
        try:
            return await store.delete(case_id, file_id, deleted_by=current_username(request) or "",
                                      deleted_at=iso_now())
        except CaseFilesError as exc:
            raise _store_error(exc) from exc

    deleted = await audited_write(
        state,
        sink="execution",
        action="case.file_deleted",
        target=_case_target(case, case_id),
        expected_revision=None,
        changes=[{"field": "files",
                  "before": f"{file_id} ({record.type.upper()}, {_size_text(record.bytes)})",
                  "after": None}],
        write=write,
        action_type=ActionType.COLLAB,
        actor=actor,
        actor_type="human",
        surface="case",
        context=audit_context(request),
        case_id=case_id,
        result_summary=f"file_deleted file={file_id}",
        after_write=lambda rec: _publish(state, case_id, "file_deleted", actor, rec.id),
    )
    return CaseFileDeleteResult(file=_entry(deleted, position, can_delete=False))


_IMAGE_BINARY = {"schema": {"type": "string", "format": "binary"}}


@router.get(
    "/cases/{case_id}/files/{file_id}/content",
    response_class=Response,
    responses={
        200: {
            "description": "The screenshot (or its thumbnail), as stored after validation.",
            "content": {mime: _IMAGE_BINARY for mime in sorted(MIME_TYPES.values())},
        },
        404: {"description": "case_not_found or case_file_not_found"},
        503: {"description": "case_files_unavailable: the store could not be read"},
    },
)
async def get_case_file_content(
    case_id: str,
    file_id: str,
    state: AppState = Depends(get_state),
    _=Depends(_READ),
    variant: Literal["full", "thumb"] = "full",
    download: bool = False,
) -> Response:
    """The image bytes with strict headers (see the module docstring). A thumbnail
    is served when asked for and present, else the full image."""
    case = await _require_case(state, case_id)
    store = _store(state)
    if not valid_file_id(file_id):
        raise _error(404, "case_file_not_found", "That screenshot was not found.")
    try:
        record, data, kind = await store.read_content(case_id, file_id, variant)
        position = _position(await store.index(case_id), record.id)
    except CaseFilesError as exc:
        raise _store_error(exc) from exc
    name = _download_name(case, case_id, position, kind)
    disposition = "attachment" if download else "inline"
    headers = {
        "Content-Disposition": f'{disposition}; filename="{name}"',
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Length": str(len(data)),
    }
    return Response(content=data, media_type=MIME_TYPES[kind], headers=headers)
