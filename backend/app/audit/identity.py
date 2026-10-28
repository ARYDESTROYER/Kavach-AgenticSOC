"""Identity rows: sign-in, sign-out, second-factor and session events (Round 14 SPEC
§4.5.3, §4.5.4).

These rows record an event that already happened or a protective action, so they are
**best-effort with a signal**, not audit-first:

* A sign-out or a session revocation must never be blocked by an audit outage (a
  protective action has to work exactly when something is wrong).
* A sign-in, a failed sign-in, a second-factor challenge or failure, a step-up and a
  session start or refresh are recorded with the same structured fields, but an
  audit outage does not stop a person signing in (NIST SP 800-53 AU-5 lets a system
  alert instead of halting).

What makes the trade-off safe is that a dropped row is never silent: the append is
strict (``record_strict``, which raises when it cannot be confirmed), a failure is
logged at error level, and it is counted in this process by action
(:func:`dropped_count`, :func:`dropped_by_action`, named ``audit_identity_dropped``
beside the view recorder's ``audit_view_dropped``; to be surfaced in diagnostics, so
today the error log is the signal an operator sees). A change to an account, a
role or the settings (a password change, turning a second factor on or off, a user
created, changed or deleted) is NOT written here: it goes through ``audited_write`` and
is refused with ``503 audit_unavailable`` when its row cannot be appended.

Every row goes to ``state.control_audit`` (the real log, never the Demo one, SPEC
§3.5).
"""

from __future__ import annotations

import logging
import threading
from collections import Counter
from typing import Any

from ..constants import ActionType
from .context import audit_context

logger = logging.getLogger("tlsoc.audit.identity")

#: Distinct actions the counter keeps (the identity actions are a closed set; this
#: bound only guards against a programming error minting new ones without end).
_MAX_COUNTED_ACTIONS = 64
_OTHER = "other"


class IdentityDrops:
    """Identity rows that could not be appended since the process started, by action."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_action: Counter[str] = Counter()

    def note(self, action: str) -> int:
        """Count one dropped row; returns the new total."""
        with self._lock:
            key = action if (action in self._by_action
                             or len(self._by_action) < _MAX_COUNTED_ACTIONS) else _OTHER
            self._by_action[key] += 1
            return sum(self._by_action.values())

    def total(self) -> int:
        with self._lock:
            return sum(self._by_action.values())

    def by_action(self) -> dict[str, int]:
        with self._lock:
            return dict(sorted(self._by_action.items()))

    def reset(self) -> None:
        with self._lock:
            self._by_action.clear()


DROPS = IdentityDrops()


def dropped_count() -> int:
    """``audit_identity_dropped``: identity rows that could not be appended since start."""
    return DROPS.total()


def dropped_by_action() -> dict[str, int]:
    """The dropped identity rows by action (``{"auth.login": 2}``)."""
    return DROPS.by_action()


async def record_identity_event(
    state: Any,
    request: Any,
    *,
    action: str,
    actor: str,
    summary: str,
    outcome: str = "success",
    surface: str = "auth",
    actor_type: str = "human",
    user: Any = None,
    token: str | None = None,
    sid: str | None = None,
    target: Any = None,
    tool_input: Any = None,
    from_request: bool = True,
) -> bool:
    """Append one identity row to the real audit log; returns whether it was written.
    Never raises: a failed append is logged at error level and counted.

    ``user``/``token``/``sid`` name the principal and the session the row is about
    when they are not the request's own (a sign-in that has just minted its session).
    ``from_request=False`` is for a row written before its actor has signed in (see
    :func:`app.audit.context.audit_context`): the credential the request carries is
    never read, so another account's cookie never lends its role or session."""
    try:
        context = audit_context(request, user=user, token=token, sid=sid,
                                from_request=from_request)
        await state.control_audit.record_strict(
            action_type=ActionType.AUTH_EVENT,
            surface=surface,
            actor=actor or "",
            result_summary=summary,
            action=action,
            outcome=outcome,
            actor_type=actor_type,
            target=target,
            tool_input=tool_input,
            **context.record_fields(),
        )
    except Exception as exc:  # noqa: BLE001 (best effort with a signal, see the module doc)
        total = DROPS.note(action)
        logger.error("Identity audit row %s could not be appended (%d dropped since start): %s",
                     action, total, exc)
        return False
    return True


__all__ = [
    "DROPS",
    "IdentityDrops",
    "dropped_by_action",
    "dropped_count",
    "record_identity_event",
]
