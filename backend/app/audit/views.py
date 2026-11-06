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

The row's summary is a plain sentence in the Console's words ("Searched the audit
log: People and settings, last 7 days."), because the inspector shows it as the
record's header sentence and the list as its Summary (SPEC §4.5.2, AU-7: shown as
stored, so the wording is the writer's job). It is built only from the known filter
fields; a value the caller typed is quoted and bounded, and the exact filter set is
kept in ``tool_input``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Mapping

from ..constants import ActionType
from ..models import AUDIT_TEXT_WRITE_CAP
from .events import TABLE, EventTable

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .query import AuditFilters

logger = logging.getLogger("tlsoc.audit.views")

#: One row per user and filter set within this many seconds.
COALESCE_SECONDS = 300.0
#: The most keys the process remembers.
COALESCE_MAX_KEYS = 10_000
#: The structured action of a view row (category Access and identity).
VIEW_ACTION = "audit.viewed"


# --------------------------------------------------------------------------- #
# The worded summary of a view row (SPEC §3.1, §4.5.2: the inspector's header
# sentence and the Summary column show it as stored). Built only from the read's
# known filter fields: a closed-vocabulary value reads as its Console label, and a
# value the caller typed is quoted, made printable and bounded, never interpreted.
# The exact filter set stays in the row's ``tool_input`` for reproduction.
# --------------------------------------------------------------------------- #
#: The scope as the page names it (``None``, no scope, reads every row as ``all``).
SCOPE_PHRASES: Mapping[str, str] = {
    "people": "People and settings",
    "agent": "Agent activity",
    "all": "all scopes",
}
#: The outcome filter as the Outcome column labels it.
OUTCOME_LABELS: Mapping[str, str] = {
    "success": "Success",
    "failure": "Failed",
    "denied": "Denied",
    "partial": "Partial",
    "unknown": "Not recorded",
}
#: The actor kind filter, as a phrase that completes "made by ...".
ACTOR_KIND_PHRASES: Mapping[str, str] = {
    "human": "people",
    "agent": "the AI agent",
    "system": "the system",
    "service": "services",
}
#: The longest part of a caller's value a summary quotes.
VALUE_MAX_CHARS = 120
_UNITS: Mapping[str, tuple[str, str]] = {
    "y": ("year", "years"),
    "M": ("month", "months"),
    "w": ("week", "weeks"),
    "d": ("day", "days"),
    "h": ("hour", "hours"),
    "H": ("hour", "hours"),
    "m": ("minute", "minutes"),
    "s": ("second", "seconds"),
}
#: ``now-7d``: the one relative window a summary words as "last 7 days".
_LAST_RE = re.compile(r"now-(\d{1,6})([yMwdhHms])")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def plain(value: Any, *, limit: int = VALUE_MAX_CHARS) -> str:
    """A caller's value as one line of plain text: every character that is not
    printable (control, format and line separator characters) becomes U+FFFD, and
    anything past ``limit`` characters is cut with an ellipsis."""
    text = "".join(ch if ch.isprintable() else "\ufffd" for ch in str(value))
    if len(text) > limit:
        text = text[: limit - 1] + "\u2026"
    return text


def quoted(value: Any, *, limit: int = VALUE_MAX_CHARS) -> str:
    """:func:`plain`, in double quotes, with a quote or a backslash inside it escaped
    so the value cannot appear to end early."""
    return '"' + plain(value, limit=limit).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _instant_text(instant: datetime) -> str:
    """``18 Oct 2026 15:10 UTC``; seconds only when they are not zero."""
    utc = instant.astimezone(timezone.utc)
    clock = f"{utc.hour:02d}:{utc.minute:02d}" + (f":{utc.second:02d}" if utc.second else "")
    return f"{utc.day} {_MONTHS[utc.month - 1]} {utc.year} {clock} UTC"


def _last_phrase(token: str | None) -> str | None:
    """``last 7 days`` for ``now-7d`` (``last day`` for one), else ``None``."""
    match = _LAST_RE.fullmatch(token or "")
    if match is None:
        return None
    amount = int(match.group(1))
    one, many = _UNITS[match.group(2)]
    return f"last {one}" if amount == 1 else f"last {amount:,} {many}"


def time_phrase(filters: "AuditFilters") -> str:
    """The read's time window in words: ``last 7 days`` for a window that ends now,
    otherwise the instants it resolved to (``since``, ``until`` or ``a to b``)."""
    to_now = filters.to_token in (None, "now")
    last = _last_phrase(filters.from_token) if to_now else None
    if last is not None:
        return last
    start = filters.ts_from
    end = None if filters.to_token in (None, "now") else filters.ts_to
    if start is not None and end is not None:
        return f"{_instant_text(start)} to {_instant_text(end)}"
    if start is not None:
        return f"since {_instant_text(start)}"
    if end is not None:
        return f"until {_instant_text(end)}"
    return "all time"


def event_phrase(event: str, table: EventTable = TABLE) -> str:
    """An ``event`` filter in words: a category or event family by its label
    (``Access and identity events``), one event by its friendly name (``event
    Signed in``), and a token the table does not know as quoted text."""
    if event in table.category_labels:
        return f"{table.category_labels[event]} events"
    if "." in event:
        entry = table.action_by_name.get(event)
        if entry is not None:
            return f"event {entry.label}"
        prefix, _dot, verb = event.partition(".")
        pentry = table.prefix_by_name.get(prefix)
        if pentry is not None:
            return f"event {pentry.label} {verb.replace('_', ' ')}".rstrip()
        return f"event {quoted(event)}"
    pentry = table.prefix_by_name.get(event)
    if pentry is not None:
        return f"{pentry.label} events"
    legacy = table.legacy_event(event, "*")
    if legacy is not None:
        return f"{legacy.label} events"
    return f"event {quoted(event)}"


def filter_phrases(filters: "AuditFilters", table: EventTable = TABLE) -> list[str]:
    """The read's filters in words, in a fixed order: scope, time, search text, then
    each structured filter. Absent filters say nothing."""
    parts = [SCOPE_PHRASES.get(filters.scope or "all", quoted(filters.scope)), time_phrase(filters)]
    if filters.q:
        parts.append(f"matching {quoted(filters.q)}")
    if filters.event:
        parts.append(event_phrase(filters.event, table))
    if filters.action_type:
        parts.append(f"action type {quoted(filters.action_type)}")
    if filters.actor:
        parts.append(f"actor {quoted(filters.actor)}")
    if filters.actor_contains:
        parts.append(f"actor containing {quoted(filters.actor_contains)}")
    if filters.actor_kind:
        parts.append(f"made by {ACTOR_KIND_PHRASES.get(filters.actor_kind, quoted(filters.actor_kind))}")
    if filters.outcome:
        parts.append(f"outcome {OUTCOME_LABELS.get(filters.outcome, quoted(filters.outcome))}")
    if filters.surface:
        parts.append(f"surface {quoted(filters.surface)}")
    if filters.case_id:
        parts.append(f"case {quoted(filters.case_id)}")
    if filters.source_id:
        parts.append(f"source {quoted(filters.source_id)}")
    if filters.target:
        parts.append(f"target {quoted(filters.target)}")
    if filters.ip:
        parts.append(f"client IP {filters.ip}")
    return parts


def _sentence(text: str) -> str:
    """One stored sentence, ending with a full stop, within the write cap."""
    text = text if text.endswith(".") else text + "."
    if len(text) > AUDIT_TEXT_WRITE_CAP:
        text = text[: AUDIT_TEXT_WRITE_CAP - 1] + "\u2026"
    return text


def view_summary(filters: "AuditFilters", order: str = "desc") -> str:
    """``Searched the audit log: People and settings, last 7 days.`` The summary of
    a list read or a count (the two share one view row)."""
    parts = filter_phrases(filters)
    if order == "asc":
        parts.append("oldest first")
    return _sentence("Searched the audit log: " + ", ".join(parts))


def record_open_summary(record_id: str, filters: "AuditFilters | None" = None) -> str:
    """``Opened audit record <id>.``, or, for a record the current view lists,
    ``Opened audit record <id> while viewing People and settings, last 7 days.``"""
    head = f"Opened audit record {plain(record_id, limit=AUDIT_TEXT_WRITE_CAP)}"
    if filters is None:
        return _sentence(head)
    return _sentence(f"{head} while viewing " + ", ".join(filter_phrases(filters)))


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
