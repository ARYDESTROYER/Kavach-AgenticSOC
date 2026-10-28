"""Auditing who reads the audit log (Round 14 SPEC §4.5.5, D8; PCI DSS 10.2.1.3).

Searching or opening the audit log writes one ``audit_view`` row per user per
distinct normalised filter set per five minutes. A "Load more" with the same filters,
a refresh, or the same record opened again inside the window adds nothing.

Viewing is a read, so the row is **best-effort**: a failed append is logged and
counted (:func:`dropped_count`, ``audit_view_dropped``) and never fails the read. The
row always goes to ``state.control_audit`` whatever the Demo state (SPEC §3.5).

The coalescing map is process-local and bounded (10,000 keys, least recently written
evicted first); a restart, or another replica, may therefore write one extra row for
a filter set. That limit is documented with the audit log.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict
from typing import Any, Callable, Mapping

from ..constants import ActionType

logger = logging.getLogger("tlsoc.audit.views")

#: One row per user and filter set within this many seconds.
COALESCE_SECONDS = 300.0
#: The most keys the process remembers.
COALESCE_MAX_KEYS = 10_000
#: The structured action of a view row (category Access and identity).
VIEW_ACTION = "audit.viewed"


class ViewRecorder:
    """The coalescing map and the dropped-row counter (one per process)."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic,
                 window: float = COALESCE_SECONDS, max_keys: int = COALESCE_MAX_KEYS) -> None:
        self._clock = clock
        self._window = window
        self._max_keys = max_keys
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._pending: set[str] = set()
        self.dropped = 0
        self.written = 0

    @staticmethod
    def key(actor: str, view: Mapping[str, Any]) -> str:
        raw = json.dumps({"actor": actor, "view": dict(view)}, sort_keys=True,
                         separators=(",", ":"), ensure_ascii=True, default=str)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _due(self, key: str, now: float) -> bool:
        if key in self._pending:
            return False
        last = self._seen.get(key)
        return last is None or now - last >= self._window

    def _remember(self, key: str, now: float) -> None:
        self._seen[key] = now
        self._seen.move_to_end(key)
        while len(self._seen) > self._max_keys:
            self._seen.popitem(last=False)

    async def note(
        self,
        audit: Any,
        *,
        actor: str,
        view: Mapping[str, Any],
        summary: str,
        context: Any = None,
    ) -> bool:
        """Write the view row unless the same user wrote one for the same view within
        the window. Returns whether a row was written. Never raises."""
        key = self.key(actor, view)
        now = self._clock()
        if not self._due(key, now):
            return False
        self._pending.add(key)
        try:
            await audit.record_strict(
                action_type=ActionType.AUDIT_VIEW,
                surface="audit",
                actor=actor,
                actor_type="human",
                action=VIEW_ACTION,
                outcome="success",
                result_summary=summary,
                tool_input=dict(view),
                actor_role=_context_value(context, "actor_role"),
                client=_context_value(context, "client"),
                session_ref=_context_value(context, "session_ref"),
                request_id=_context_value(context, "request_id"),
            )
        except Exception as exc:  # noqa: BLE001 (viewing is a read; never fail it)
            self.dropped += 1
            logger.warning("audit_view row dropped (%d so far): %s", self.dropped, exc)
            return False
        finally:
            self._pending.discard(key)
        self.written += 1
        self._remember(key, now)
        return True

    def reset(self) -> None:
        self._seen.clear()
        self._pending.clear()
        self.dropped = 0
        self.written = 0


def _context_value(context: Any, name: str) -> Any:
    if context is None:
        return None
    if isinstance(context, Mapping):
        return context.get(name)
    return getattr(context, name, None)


RECORDER = ViewRecorder()


def dropped_count() -> int:
    """``audit_view_dropped``: view rows that could not be appended since start."""
    return RECORDER.dropped
