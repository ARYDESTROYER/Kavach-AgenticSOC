"""Audit before visible: the one helper every new state change goes through
(Round 14 SPEC §3.6, E16).

``audited_write`` runs a write in a fixed order so that success is never returned
without its audit row and no row claims a change that was refused before it began:

1. **Pre-checks** (``precheck``): the grant, validation and the stale-revision check
   against a fresh read. They cost nothing and change nothing, so a pre-check failure
   returns its own error and writes **no** row.
2. **The action row** is appended strictly (``outcome="success"``, the structured
   ``action``, the ``target`` with the revision the write will create, the request
   id). If the append fails, nothing has changed: the caller gets
   ``503 audit_unavailable`` (:class:`AuditUnavailableError`) and ``write`` never runs.
3. **The store write** runs. If it fails, a failure row
   (``<resource>.<verb>_failed``, ``outcome="failure"``, the same request id and the
   reason) is appended and the store's own error propagates (``409 runbook_conflict``,
   ``503 runbook_store_unavailable`` and so on). Readers pair the two rows by request
   id: the inspector shows the action row as "Not applied (see the next record)".
4. Only then does ``after_write`` run (publish the SSE frame; frames are published
   after save, the Round 3 rule) and the result return.

Steps 2 and 3 run as one shielded unit: a cancelled request (a client that
disconnects through the HTTP middleware, a shutdown) cannot split them, so the write
always runs to its real outcome once its action row is appended, and a failure still
gets its failure row. The caller sees the cancellation; the change and its rows are
complete. Step 4 runs for every write that completed, after the save, whether or not
the caller is still there: a change saved after its requester left still reaches the
other consoles that follow it. A write that failed publishes nothing. Only a shutdown
that cancels the write itself while it runs ends it early; its follow-up row then has
outcome ``unknown`` ("whether it was saved is unknown"), never a false "failed".

Known limit (documented in ``docs/administration/audit-log.md``): a process crash
between steps 2 and 3 leaves an action row whose target revision was never written;
the inspector shows that revision and a reader can see it does not exist.

The sink decides where the rows go (SPEC §3.5): a change to real state is audited in
``state.control_audit`` (``sink="control"``), a change to Demo-swapped state in the
active execution audit (``sink="execution"``, the Demo audit while Demo Mode is on).
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
import re
import uuid
from typing import Any, Awaitable, Callable, Mapping, Sequence, TypeVar

from fastapi import HTTPException

from ..constants import ActionType
from ..models import (
    AUDIT_ACTION_MAX_CHARS,
    AUDIT_REQUEST_ID_PATTERN,
    _AUDIT_ACTION_RE,
    AuditChange,
    AuditTarget,
)

logger = logging.getLogger("tlsoc.audit.write")

T = TypeVar("T")

_REQUEST_ID_RE = re.compile(AUDIT_REQUEST_ID_PATTERN)

#: Past-tense verbs as their base form, so ``runbook.published`` fails as
#: ``runbook.publish_failed`` (SPEC §3.6). A verb not listed keeps its spelling.
_BASE_VERBS: dict[str, str] = {
    "abandoned": "abandon", "applied": "apply", "approved": "approve", "assigned": "assign",
    "attached": "attach", "changed": "change", "collected": "collect", "completed": "complete",
    "confirmed": "confirm", "created": "create", "deleted": "delete", "denied": "deny",
    "disabled": "disable", "discarded": "discard", "downloaded": "download", "drafted": "draft",
    "duplicated": "duplicate", "enabled": "enable", "enrolled": "enrol", "exported": "export",
    "hidden": "hide", "imported": "import", "migrated": "migrate", "moved": "move",
    "published": "publish", "recorded": "record", "rejected": "reject", "renamed": "rename",
    "requested": "request", "reset": "reset", "restored": "restore", "retired": "retire",
    "revoked": "revoke", "reviewed": "review", "saved": "save", "selected": "select",
    "started": "start", "submitted": "submit", "switched": "switch", "updated": "update",
}


class AuditUnavailableError(HTTPException):
    """The audit row could not be appended, so nothing was changed (SPEC §3.6 step 2).
    An ``HTTPException`` so a route that lets it propagate answers
    ``503 {"code": "audit_unavailable"}``; engine code may catch it by type."""

    def __init__(self, message: str = "The audit log could not be written, so nothing was changed.") -> None:
        super().__init__(status_code=503, detail={"code": "audit_unavailable", "message": message})


def failure_action(action: str) -> str:
    """``<resource>.<verb>_failed`` for a success ``action`` (``runbook.published`` →
    ``runbook.publish_failed``; ``user.role_changed`` → ``user.role_change_failed``).
    Always a valid action of at most 64 characters."""
    resource, _, verb = action.partition(".")
    words = verb.split("_") if verb else ["write"]
    words[-1] = _BASE_VERBS.get(words[-1], words[-1])
    suffix = "_failed"
    tail = "_".join(words)
    budget = AUDIT_ACTION_MAX_CHARS - len(resource) - 1 - len(suffix)
    if budget < 1:
        return "audit.write_failed"
    candidate = f"{resource}.{tail[:budget].rstrip('_') or 'write'}{suffix}"
    return candidate if _AUDIT_ACTION_RE.fullmatch(candidate) else "audit.write_failed"


def _resolve_sink(state: Any, sink: Any) -> Any:
    if sink == "control":
        return state.control_audit
    if sink == "execution":
        return getattr(state, "execution_audit", None) or state.audit
    if isinstance(sink, str):
        raise ValueError(f"unknown audit sink {sink!r}; use 'control', 'execution' or a repository")
    return sink


def _context_value(context: Any, name: str) -> Any:
    if context is None:
        return None
    if isinstance(context, Mapping):
        return context.get(name)
    return getattr(context, name, None)


def _request_id(context: Any) -> str:
    value = _context_value(context, "request_id")
    if isinstance(value, str) and _REQUEST_ID_RE.fullmatch(value):
        return value
    # Without the request-id middleware the pair of rows still needs one id.
    return str(uuid.uuid4())


def _target_with_revision(target: Any, expected_revision: int | None) -> AuditTarget | None:
    if target is None:
        return None
    model = target if isinstance(target, AuditTarget) else AuditTarget.model_validate(target)
    if model.revision is None and expected_revision is not None:
        model = model.model_copy(update={"revision": int(expected_revision) + 1})
    return model


def _reason(exc: BaseException) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, Mapping):
        code = detail.get("code")
        message = detail.get("message") or detail.get("reason")
        text = ": ".join(str(x) for x in (code, message) if x)
        if text:
            return text
    elif isinstance(detail, str) and detail:
        return detail
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


#: The failure row of a write that was itself cancelled (only at process shutdown:
#: a cancelled request cannot reach it through the shield).
CANCELLED_REASON = "cancelled before the write finished; whether it was saved is unknown"


async def _append_failure(repo: Any, common: dict[str, Any], failure: str, exc: BaseException,
                          action: str) -> None:
    """Step 3's failure row. A store error is a ``failure``; a write cancelled while
    it ran has an ``unknown`` outcome (it may have been saved). The store error is
    what the caller reports; a failed append of this row is only logged."""
    cancelled = isinstance(exc, asyncio.CancelledError)
    try:
        await repo.record_strict(
            **common,
            action=failure,
            outcome="unknown" if cancelled else "failure",
            result_summary=CANCELLED_REASON if cancelled else _reason(exc),
        )
    except Exception as audit_exc:  # noqa: BLE001 (the store error is the one to report)
        logger.error("Audit failure row for %s could not be appended: %s", action, audit_exc)


#: Step 4 of writes whose request was cancelled (kept so they are not collected
#: before they run).
_DETACHED_PUBLISHES: set["asyncio.Future[Any]"] = set()


async def _run_after_write(action: str, after_write: Callable[[Any], Any], result: Any) -> None:
    """Step 4: publish after the save. The change is saved and audited, so a failure
    here is only logged."""
    try:
        await _maybe_await(after_write(result))
    except Exception as exc:  # noqa: BLE001 (the change is saved and audited)
        logger.warning("After-write step for %s failed: %s", action, exc)


def _settle_detached(action: str, after_write: Callable[[Any], Any] | None,
                     unit: "asyncio.Future[Any]") -> None:
    """The end of a shielded write whose request was cancelled: retrieve its outcome
    (so it is logged here instead of being reported as "never retrieved") and, when it
    completed, run step 4 so the saved change is still published."""
    if unit.cancelled():
        logger.warning("Audit-first write %s was cancelled after its request ended", action)
        return
    exc = unit.exception()
    if exc is not None:
        logger.info("Audit-first write %s failed after its request was cancelled: %s", action, exc)
        return
    logger.info("Audit-first write %s completed after its request was cancelled", action)
    if after_write is None:
        return
    publish = asyncio.ensure_future(_run_after_write(action, after_write, unit.result()))
    _DETACHED_PUBLISHES.add(publish)
    publish.add_done_callback(_DETACHED_PUBLISHES.discard)


async def audited_write(
    state: Any,
    *,
    sink: Any,
    action: str,
    target: AuditTarget | Mapping[str, Any] | None,
    expected_revision: int | None,
    changes: Sequence[AuditChange | Mapping[str, Any]] | None,
    write: Callable[[], Awaitable[T]],
    action_type: ActionType,
    actor: str,
    actor_type: str = "human",
    surface: str = "",
    context: Any = None,
    case_id: str | None = None,
    source_id: str | None = None,
    result_summary: str | None = None,
    tool_input: Any = None,
    precheck: Callable[[], Awaitable[None] | None] | None = None,
    after_write: Callable[[T], Awaitable[None] | None] | None = None,
    failure: str | None = None,
) -> T:
    """Run ``write`` audit-first (see the module docstring for the four steps).

    ``sink`` is ``"control"`` (real state, ``state.control_audit``), ``"execution"``
    (Demo-swapped state, the active audit) or an audit repository. ``context`` is the
    request's audit context (``client``, ``session_ref``, ``actor_role``,
    ``request_id``; an object or a mapping, ``app.audit.context.audit_context`` builds
    it). ``expected_revision`` is the revision the pre-check read; the action row
    names ``expected_revision + 1`` as the revision the write creates unless ``target``
    already carries one. ``failure`` overrides the failure row's action
    (default :func:`failure_action`). Returns what ``write`` returned."""
    if not _AUDIT_ACTION_RE.fullmatch(action) or len(action) > AUDIT_ACTION_MAX_CHARS:
        raise ValueError(f"not an audit action: {action!r}")
    repo = _resolve_sink(state, sink)

    # 1. Pre-checks: nothing attempted yet, so a refusal writes no row.
    if precheck is not None:
        await _maybe_await(precheck())

    request_id = _request_id(context)
    audited_target = _target_with_revision(target, expected_revision)
    common: dict[str, Any] = {
        "action_type": action_type,
        "surface": surface,
        "actor": actor or "",
        "actor_type": actor_type,
        "actor_role": _context_value(context, "actor_role"),
        "client": _context_value(context, "client"),
        "session_ref": _context_value(context, "session_ref"),
        "request_id": request_id,
        "case_id": case_id,
        "source_id": source_id,
        "target": audited_target,
    }

    action_changes = list(changes) if changes is not None else None

    async def append_then_write() -> T:
        # 2. The action row, strictly. A failed append changes nothing.
        try:
            await repo.record_strict(
                **common,
                action=action,
                outcome="success",
                changes=action_changes,
                result_summary=result_summary,
                tool_input=tool_input,
            )
        except Exception as exc:  # noqa: BLE001 (every append failure means "not audited")
            logger.error("Audit-first write refused (%s): the audit append failed: %s", action, exc)
            raise AuditUnavailableError() from exc

        # 3. The store write. A failure appends a failure row, then propagates.
        try:
            return await write()
        except (Exception, asyncio.CancelledError) as exc:
            await _append_failure(repo, common, failure or failure_action(action), exc, action)
            raise

    # Steps 2 and 3 are one unit a cancelled caller cannot split (see the module doc).
    unit = asyncio.ensure_future(append_then_write())
    try:
        result = await asyncio.shield(unit)
    except asyncio.CancelledError:
        # The write goes on to its real outcome; step 4 follows it there.
        unit.add_done_callback(functools.partial(_settle_detached, action, after_write))
        raise

    # 4. Publish (frames after save), then return.
    if after_write is not None:
        await _run_after_write(action, after_write, result)
    return result
