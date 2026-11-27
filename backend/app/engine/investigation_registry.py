"""Which AI investigations are queued or running, and how each ended (Round 16 SPEC
§4.3 WP01, §4.5 WP08; research ``ai-investigating`` §4.2).

A process-local, memory-only registry: no field on the Case document, nothing to go
stale after a crash (a restarted process starts empty and the Console reconciles
through ``GET /api/investigations/active``). The pipeline registers a run before the
investigation gate and ends it in a ``finally``; this module never imports the
pipeline, HTTP code or ``engine/case_manager.py`` (the §3.6 guard), and nothing reads
it to decide anything (#3).

Frames are nudges published through :func:`app.realtime.publish_case_investigation`:
ids, enums, ISO timestamps and integers only, never a title, entity, rule, model text
or a person's name (#7, #9). They are sent on :meth:`InvestigationRegistry.started`,
on :meth:`InvestigationRegistry.attach_case` when the case was unknown, on
:meth:`InvestigationRegistry.end`, and on :meth:`InvestigationRegistry.begin` only when
the caller says the gate is full (``announce_queued``).

Every public method swallows its own errors and logs them: the registry must never
raise into a run.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ..models import (
    INVESTIGATION_OUTCOMES,
    INVESTIGATION_PHASES,
    INVESTIGATION_TRIGGERS,
    InvestigationsActive,
    InvestigationSlots,
    InvestigationView,
)
from ..realtime import publish_case_investigation

logger = logging.getLogger("tlsoc.investigations")

#: The pipeline's ``_emit_step`` step names, mapped to the phase the Console shows.
STEP_PHASE: dict[str, str] = {
    "router": "triage",
    "persona": "specialist",
    "tools": "evidence",
    "verdict": "verdict",
    "decision": "decision",
}

#: How long a finished run stays in :meth:`InvestigationRegistry.recent`.
RECENT_TTL_SECONDS = 120
#: At most this many finished runs are kept for :meth:`InvestigationRegistry.recent`.
RECENT_MAX = 200
#: A defensive bound on queued and running handles (normally a few: the gate's cap
#: plus a tick's queue). Past it the oldest handle is dropped without a frame.
ACTIVE_MAX = 1000


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value is not None else None


def _enum_text(value: Any) -> str | None:
    """A ``CaseStatus`` or ``Verdict`` (or its string) as its wire value."""
    if value is None:
        return None
    value = getattr(value, "value", value)
    text = str(value).strip()
    return text or None


def _norm_user(name: Any) -> str:
    return str(name or "").strip().lower()


def _current_task() -> asyncio.Task[Any] | None:
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


@dataclass
class InvestigationHandle:
    """One run, from :meth:`InvestigationRegistry.begin` to its end.

    ``signature`` (the cluster signature) and ``requested_by`` (a user name) are kept
    for the server only: a view carries the requester only for a caller allowed to see
    it, and a frame never does. ``close_replaced`` is set by the pipeline when the run's
    result replaced a person's close (``{"by", "from_status", "to_status"}``)."""

    run_id: str
    signature: str
    case_id: str | None
    trigger: str
    requested_by: str | None
    queued_at: datetime
    state: str = "queued"
    phase: str = "queued"
    started_at: datetime | None = None
    deadline_at: datetime | None = None
    time_cap_seconds: int = 0
    finished_at: datetime | None = None
    outcome: str | None = None
    status_after: str | None = None
    verdict_after: str | None = None
    close_replaced: dict[str, Any] | None = None
    task: asyncio.Task[Any] | None = None

    def view(self, *, viewer: str | None = None, show_requester: bool = False) -> InvestigationView:
        """This run as :class:`InvestigationView`. ``requested_by_you`` is true when
        ``viewer`` started it; ``requested_by`` is the requester's name only with
        ``show_requester`` (a holder of ``users:manage``, SPEC D10)."""
        mine = bool(self.requested_by) and _norm_user(viewer) == _norm_user(self.requested_by)
        return InvestigationView(
            run_id=self.run_id,
            case_id=self.case_id,
            state=self.state,  # type: ignore[arg-type]
            phase=self.phase,  # type: ignore[arg-type]
            trigger=self.trigger,  # type: ignore[arg-type]
            queued_at=_iso(self.queued_at) or "",
            started_at=_iso(self.started_at),
            deadline_at=_iso(self.deadline_at),
            time_cap_seconds=int(self.time_cap_seconds),
            finished_at=_iso(self.finished_at),
            outcome=self.outcome,  # type: ignore[arg-type]
            status_after=self.status_after,
            verdict_after=self.verdict_after,
            requested_by_you=mine,
            requested_by=(self.requested_by if show_requester and self.requested_by else None),
        )


class InvestigationRegistry:
    """The memory-only registry of AI investigation runs.

    ``bus_getter`` returns the event bus to publish frames on (or ``None``: no frames),
    read at each publish so a Demo stack can bind its own bus. ``on_finished`` is
    called with each handle after :meth:`end` (synchronously; a caller that does I/O
    spawns a task). ``clock`` returns the current UTC time (tests inject one).
    Single event loop, no awaits inside a method: no lock is needed."""

    def __init__(
        self,
        bus_getter: Callable[[], Any] | None = None,
        *,
        on_finished: Callable[[InvestigationHandle], Any] | None = None,
        recent_max: int = RECENT_MAX,
        recent_ttl_s: int = RECENT_TTL_SECONDS,
        active_max: int = ACTIVE_MAX,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._bus_getter = bus_getter
        self._on_finished = on_finished
        self._recent_ttl = timedelta(seconds=max(0, int(recent_ttl_s)))
        self._active_max = max(1, int(active_max))
        self._clock = clock or _utc_now
        self._active: dict[str, InvestigationHandle] = {}
        self._recent: deque[InvestigationHandle] = deque(maxlen=max(1, int(recent_max)))

    # --- lifecycle ----------------------------------------------------------- #
    def begin(
        self,
        *,
        run_id: str,
        signature: str,
        case_id: str | None = None,
        trigger: str = "automatic",
        requested_by: str | None = None,
        announce_queued: bool = False,
    ) -> InvestigationHandle | None:
        """Register a run before it waits for the investigation gate. ``trigger`` is
        one of ``automatic``, ``manual``, ``job``, ``drain`` or ``detection`` (anything
        else is recorded as ``automatic``). ``announce_queued`` publishes a queued frame
        (the caller saw the gate full). Returns the handle, or ``None`` on an error."""
        try:
            handle = InvestigationHandle(
                run_id=str(run_id),
                signature=str(signature or ""),
                case_id=(str(case_id) if case_id else None),
                trigger=trigger if trigger in INVESTIGATION_TRIGGERS else "automatic",
                requested_by=(str(requested_by).strip() or None) if requested_by else None,
                queued_at=self._clock(),
                task=_current_task(),
            )
            self._active.pop(handle.run_id, None)
            self._active[handle.run_id] = handle
            while len(self._active) > self._active_max:
                self._active.pop(next(iter(self._active)))
            if announce_queued:
                self._publish(handle)
            return handle
        except Exception as exc:  # noqa: BLE001 (the registry never raises into a run)
            logger.warning("investigation registry begin failed: %s", exc)
            return None

    def started(self, handle: InvestigationHandle | None, *, time_cap_seconds: int) -> None:
        """The run holds a gate permit and is running; publishes a running frame."""
        if handle is None:
            return
        try:
            if handle.state == "finished":
                return
            now = self._clock()
            cap = max(0, int(time_cap_seconds or 0))
            handle.state = "running"
            handle.started_at = now
            handle.time_cap_seconds = cap
            handle.deadline_at = now + timedelta(seconds=cap)
            self._publish(handle)
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry started failed: %s", exc)

    def attach_case(self, handle: InvestigationHandle | None, case_id: str | None) -> None:
        """The run found or minted its case. Publishes a frame only when the case was
        unknown until now (a run on new events)."""
        if handle is None or not case_id:
            return
        try:
            if handle.case_id == str(case_id):
                return
            was_unknown = handle.case_id is None
            handle.case_id = str(case_id)
            if was_unknown and handle.state != "finished":
                self._publish(handle)
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry attach_case failed: %s", exc)

    def phase(self, handle: InvestigationHandle | None, step: str | None) -> None:
        """Record the run's current phase from a pipeline step name (``router``,
        ``persona``, ``tools``, ``verdict``, ``decision``) or a phase name. No frame:
        the phase is served by the route and carried on the next frame."""
        if handle is None or not step:
            return
        try:
            name = STEP_PHASE.get(str(step), str(step))
            if name in INVESTIGATION_PHASES and handle.state != "finished":
                handle.phase = name
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry phase failed: %s", exc)

    def end(
        self,
        handle: InvestigationHandle | None,
        *,
        outcome: str,
        status: Any = None,
        verdict: Any = None,
    ) -> None:
        """The run ended. ``outcome`` is one of ``decided``, ``routed_to_person``,
        ``closed_by_policy``, ``unchanged``, ``cancelled`` or ``failed`` (anything else
        is recorded as ``failed``); ``status`` and ``verdict`` are the case's status and
        verdict after the run, when it saved one. Moves the run to :meth:`recent`,
        publishes a finished frame and calls ``on_finished``. A second call is a no-op."""
        if handle is None:
            return
        try:
            if handle.state == "finished":
                return
            handle.state = "finished"
            handle.outcome = outcome if outcome in INVESTIGATION_OUTCOMES else "failed"
            if status is not None:
                handle.status_after = _enum_text(status)
            if verdict is not None:
                handle.verdict_after = _enum_text(verdict)
            handle.finished_at = self._clock()
            handle.task = None
            if self._active.get(handle.run_id) is handle:
                self._active.pop(handle.run_id, None)
            self._recent.append(handle)
            self._publish(handle)
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry end failed: %s", exc)
            return
        if self._on_finished is not None:
            try:
                self._on_finished(handle)
            except Exception as exc:  # noqa: BLE001
                logger.warning("investigation registry on_finished failed: %s", exc)

    # --- reads --------------------------------------------------------------- #
    def active(self) -> list[InvestigationHandle]:
        """Queued and running runs, oldest first. A handle whose task already ended
        without calling :meth:`end` (defensive) is dropped here, without a frame."""
        try:
            for run_id, handle in list(self._active.items()):
                task = handle.task
                if task is not None and task.done():
                    self._active.pop(run_id, None)
            return list(self._active.values())
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry active failed: %s", exc)
            return []

    def for_case(self, case_id: str | None) -> InvestigationHandle | None:
        """The newest queued or running run on ``case_id``, or ``None``."""
        if not case_id:
            return None
        try:
            for handle in reversed(self.active()):
                if handle.case_id == case_id:
                    return handle
            return None
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry for_case failed: %s", exc)
            return None

    def for_signature(self, signature: str | None) -> InvestigationHandle | None:
        """The newest queued or running run on a cluster signature, or ``None``: a run
        that has not attached its case yet is found this way (SPEC §4.5 WP08)."""
        if not signature:
            return None
        try:
            for handle in reversed(self.active()):
                if handle.signature == signature:
                    return handle
            return None
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry for_signature failed: %s", exc)
            return None

    def recent(self) -> list[InvestigationHandle]:
        """Runs that finished within the last :data:`RECENT_TTL_SECONDS`, oldest first,
        at most :data:`RECENT_MAX`."""
        try:
            cutoff = self._clock() - self._recent_ttl
            return [h for h in self._recent if h.finished_at is not None and h.finished_at >= cutoff]
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry recent failed: %s", exc)
            return []

    def new_runs(self) -> int:
        """How many queued or running runs have no case yet (a count only)."""
        try:
            return sum(1 for h in self.active() if h.case_id is None)
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry new_runs failed: %s", exc)
            return 0

    def snapshot(
        self,
        *,
        case_id: str | None = None,
        viewer: str | None = None,
        show_requester: bool = False,
        slots_in_use: int = 0,
        slots_cap: int = 0,
    ) -> InvestigationsActive:
        """The ``GET /api/investigations/active`` body: ``items`` (queued or running,
        case known) and ``recent``, narrowed to ``case_id`` when given, as seen by
        ``viewer``. Never raises (an error answers an empty snapshot)."""
        try:
            def wanted(handle: InvestigationHandle) -> bool:
                return handle.case_id is not None and (case_id is None or handle.case_id == case_id)

            def view(handle: InvestigationHandle) -> InvestigationView:
                return handle.view(viewer=viewer, show_requester=show_requester)

            return InvestigationsActive(
                items=[view(h) for h in self.active() if wanted(h)],
                recent=[view(h) for h in self.recent() if wanted(h)],
                new_runs=self.new_runs(),
                slots=InvestigationSlots(in_use=max(0, int(slots_in_use)), cap=max(0, int(slots_cap))),
                generated_at=_iso(self._clock()) or "",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry snapshot failed: %s", exc)
            return InvestigationsActive()

    def clear(self) -> None:
        """Forget every run (factory reset; the caller cancels the tasks first)."""
        try:
            self._active.clear()
            self._recent.clear()
        except Exception as exc:  # noqa: BLE001
            logger.warning("investigation registry clear failed: %s", exc)

    # --- frames -------------------------------------------------------------- #
    def _publish(self, handle: InvestigationHandle) -> None:
        if self._bus_getter is None:
            return
        try:
            bus = self._bus_getter()
        except Exception:  # noqa: BLE001
            return
        if bus is None:
            return
        active = self.active()
        publish_case_investigation(
            bus,
            handle.view(),
            active=len(active),
            new_runs=sum(1 for h in active if h.case_id is None),
        )
