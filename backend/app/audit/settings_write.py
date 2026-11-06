"""Audited settings writes for the curated settings routers (Round 14 SPEC §3.5, §3.6,
§4.5.4, package A4b-2).

:func:`app.audit.prefs_write.audited_prefs_write` saves the real settings document
audit-first with one fixed action. The curated settings routers need two more things,
which :func:`audited_settings_write` adds while keeping the same rules (the action row
with the change set is appended before the save, a failed append answers ``503
audit_unavailable`` with nothing saved, and the save is a compare-and-swap on the
recorded change set, retried from a fresh read when another save moved a recorded
field):

* **The active execution settings** (``scope="execution"``). Threshold tuning,
  anomaly baseline, discounted inference and campaign settings follow the active
  execution stack: in Demo Mode an edit stays in the Demo sandbox and vanishes with
  it, so its row goes to the Demo audit (the SPEC §3.5 rule: a change to Demo state is
  audited in the Demo audit). Off Demo Mode these are the real settings and the row
  goes to the real audit log, exactly as ``scope="real"``.
* **An action that depends on what the edit found** (``rule.created`` for a rule that
  did not exist, ``rule.updated`` for one that did). ``action`` may be a callable
  taking no arguments; it is evaluated right after the edit ran on the document the
  row describes, so it can read what the edit learnt (a ``nonlocal`` flag). A retry
  from a fresh read evaluates it again, so the action always matches the change set
  recorded beside it.

Every attempt that loses the race to another save is an action row and its failure
row; a retry's action row says which attempt it is in ``tool_input`` (``{"attempt": 2,
"of": 3}``, merged with the writer's own input), exactly as
:func:`app.audit.prefs_write.audited_prefs_write` marks it.

**One execution stack per write.** Demo Mode can be turned on or off by another request
while a write is in flight. An execution-scoped write is therefore bound to the stack it
was planned against (:class:`ExecutionStack`): the settings it read, the audit log its
rows go to and the generation of Demo Mode are taken in one synchronous step, and the
save checks the generation in the same synchronous step that picks the store it writes.
When Demo Mode moved in between, the save is refused with ``409 demo_mode_changed`` (the
failure row goes beside the action row, in the log of the stack the row described) and
is never retried: a Demo edit must never be re-applied to the real settings, nor a real
edit to the sandbox. The stack is bound once per call, so a retry after a racing save
is refused the same way (with no row) when Demo Mode moved before it. Writers outside this module that touch Demo-swapped stores (the
campaign re-correlation, threshold tuning apply and rollback) bind the same way.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Literal, Sequence, TypeVar

from fastapi import HTTPException

from ..constants import ActionType
from ..models import AuditTarget
from .changes import changed_values, count_changes, diff_changes
from .prefs_write import (
    SETTINGS_WRITE_ATTEMPTS,
    SettingsMovedError,
    Summary,
    _attempt_input,
    _dump,
    _summary_text,
    _Swap,
    settings_conflict,
    settings_target,
)
from .write import audited_write

logger = logging.getLogger("tlsoc.audit.settings_write")

SettingsScope = Literal["real", "execution"]
Action = str | Callable[[], str]
Target = AuditTarget | dict[str, Any] | Callable[[Sequence[Any]], Any] | None
T = TypeVar("T")

#: The error code of a write refused because Demo Mode was turned on or off while it ran.
DEMO_MODE_CHANGED = "demo_mode_changed"
_DEMO_MODE_CHANGED_MESSAGE = (
    "Demo Mode was turned on or off while saving, so nothing was saved. Try again."
)


def demo_mode_changed(message: str = _DEMO_MODE_CHANGED_MESSAGE) -> HTTPException:
    """``409 demo_mode_changed``: Demo Mode was turned on or off between the moment a
    write was planned (and its row described) and its save, so the save was refused."""
    return HTTPException(status_code=409, detail={"code": DEMO_MODE_CHANGED, "message": message})


def _demo_generation(state: Any) -> int:
    return int(getattr(state, "demo_generation", 0) or 0)


class ExecutionStack:
    """The execution stack (the real state, or the Demo sandbox while Demo Mode is on)
    one write was planned against, bound once (module doc, "One execution stack per
    write").

    Built in one synchronous step: the generation of Demo Mode and the audit log of the
    active stack are read together, so :attr:`audit` is always the log of that
    generation. A writer reads the stores it uses in the same step (``state.cases``,
    ``state.campaign_store``, ``state.tuning_store``, ``state.execution_prefs``) and
    passes :attr:`audit` as the ``sink`` of its rows. Before it writes a store it calls
    :meth:`check`, or writes through :meth:`guard`, so the check and the store choice
    run with no await between them."""

    __slots__ = ("_state", "generation", "audit")

    def __init__(self, state: Any) -> None:
        self._state = state
        self.generation = _demo_generation(state)
        self.audit = getattr(state, "execution_audit", None) or state.audit

    def moved(self) -> bool:
        """Whether Demo Mode was turned on or off since this stack was bound."""
        return _demo_generation(self._state) != self.generation

    def check(self, message: str = _DEMO_MODE_CHANGED_MESSAGE) -> None:
        """Raise ``409 demo_mode_changed`` when Demo Mode moved since the bind."""
        if self.moved():
            raise demo_mode_changed(message)

    def guard(self, write: Callable[..., Awaitable[T]],
              message: str = _DEMO_MODE_CHANGED_MESSAGE) -> Callable[..., Awaitable[T]]:
        """``write`` (a method that picks the active stack's store when it is called,
        such as ``state.mutate_execution_prefs``) behind :meth:`check`: the check and
        the call run in one synchronous step, so the store it picks is this stack's."""

        async def _guarded(*args: Any, **kwargs: Any) -> T:
            self.check(message)
            return await write(*args, **kwargs)

        return _guarded


def _snapshot(state: Any, scope: SettingsScope) -> Any:
    return state.execution_prefs if scope == "execution" else state.prefs


def _mutator(state: Any, scope: SettingsScope) -> Callable[[Callable[[Any], Any]], Any]:
    return state.mutate_execution_prefs if scope == "execution" else state.mutate_prefs


async def audited_settings_write(
    state: Any,
    *,
    transform: Callable[[Any], Any],
    actor: str,
    context: Any,
    summary: Summary,
    action: Action = "settings.updated",
    scope: SettingsScope = "real",
    action_type: ActionType = ActionType.STATUS,
    surface: str = "settings",
    actor_type: str = "human",
    target: Target = None,
    tool_input: Any = None,
    secret_fields: Sequence[str] = (),
    failure: str | None = None,
    attempts: int = SETTINGS_WRITE_ATTEMPTS,
) -> tuple[Any, Any]:
    """Apply ``transform`` to the settings of ``scope``, audit-first (module doc).

    ``transform`` is the pure edit (``current -> new``); an ``HTTPException`` it raises
    (a refused edit, an unknown rule) is a pre-check and writes no row. ``action`` is
    the row's action, or a callable evaluated after the edit. ``target`` is the row's
    target, a callable over the recorded changes, or ``None`` for the changed settings
    sections. ``summary`` is the row's text (or a callable over the changes and their
    full count). ``failure`` names the failure row's action when the default
    (:func:`app.audit.write.failure_action`) would not read well. Returns ``(before,
    after)``: the document the edit was applied to and the saved one. A save that
    keeps racing another save of the same fields gives up after ``attempts`` with
    ``409 settings_conflict``. An execution-scoped save whose Demo Mode was turned on
    or off after its row was appended answers ``409 demo_mode_changed`` (module doc)."""
    mutate = _mutator(state, scope)
    total = max(1, attempts)
    # Bound once for every attempt: the rows' log and the generation each save checks
    # name one stack, and a retry after a racing save never crosses into another one.
    stack = ExecutionStack(state) if scope == "execution" else None
    for attempt in range(total):
        if stack is not None:
            # In the same synchronous step as the snapshot below, so the settings this
            # attempt describes are the bound stack's.
            stack.check()
        snapshot = _snapshot(state, scope)
        # The stored document is read BEFORE the edit runs, so the recorded "before"
        # is the stored value even if an edit were to touch a shared object in place.
        before_doc = _dump(snapshot)
        after = transform(snapshot)
        after_doc = _dump(after)
        changes = diff_changes(before_doc, after_doc, secret_fields=tuple(secret_fields))
        swap = _Swap(transform, snapshot, after, changed_values(before_doc, after_doc))
        if callable(target):
            row_target = target(changes)
        else:
            row_target = target if target is not None else settings_target(changes)
        save = (
            (lambda swap=swap: mutate(swap)) if stack is None
            else (lambda swap=swap, guarded=stack.guard(mutate): guarded(swap))
        )
        try:
            saved = await audited_write(
                state,
                sink=stack.audit if stack is not None else "control",
                action=action() if callable(action) else action,
                target=row_target,
                expected_revision=None,
                changes=changes,
                write=save,
                action_type=action_type,
                actor=actor,
                actor_type=actor_type,
                surface=surface,
                context=context,
                result_summary=_summary_text(
                    summary, changes, count_changes(before_doc, after_doc)
                ),
                tool_input=_attempt_input(tool_input, attempt + 1, total),
                failure=failure,
            )
        except SettingsMovedError:
            logger.info("Settings save raced another save (attempt %d of %d)",
                        attempt + 1, total)
            continue
        return swap.before, saved
    raise settings_conflict()


__all__ = [
    "DEMO_MODE_CHANGED",
    "ExecutionStack",
    "SettingsScope",
    "audited_settings_write",
    "demo_mode_changed",
]
