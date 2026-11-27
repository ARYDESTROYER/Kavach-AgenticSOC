"""AI investigation runs: what the AI is working on now (Round 16 SPEC §4.5 WP08, D10).

* ``GET /api/investigations/active?case_id=`` (``cases:read``): the queued and running
  runs whose case is known, the runs that finished in the last 120 seconds, the count
  of runs on new events that have no case yet, and the investigation slots in use. Read
  from memory only (``engine/investigation_registry.py``): no store read and no audit
  row. In Demo Mode it answers from the Demo stack's own registry (SPEC §3.2).
  ``process_local`` is always true: another backend replica's runs are not seen.

Every item says ``requested_by_you`` for its caller; only a holder of ``users:manage``
(the grant that lists accounts) also sees the requester's user name (SPEC D10). The
``case.investigation`` frames never carry a name.

The module also holds the two checks the manual reinvestigate routes and the bulk
reinvestigate job make before they write the "requested by" audit row or rebuild the
cluster: :func:`open_case_conflict` (``409 open_case_exists``: a closed case is
reinvestigated in place only when no open case holds its signature, #4) and
:func:`running_conflict` with :func:`reserve_manual_run` (``409 investigation_running``:
a second request while a run on the case, or on its signature, is queued or running).

Nothing here decides anything (#3), calls a model (#6) or reads a log (#1).
"""

from __future__ import annotations

import logging
import weakref
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..constants import OPEN_CASE_STATUSES
from ..models import InvestigationsActive, InvestigationView
from ..state import AppState
from .deps import current_username, get_state, require_permission, resolve_access

logger = logging.getLogger("tlsoc.api.investigations")

router = APIRouter(prefix="/api", tags=["investigations"])


async def _show_requester(request: Request) -> bool:
    """Whether this caller may see who started a run (``users:manage``, SPEC D10)."""
    try:
        return bool((await resolve_access(request)).allows("users", "manage"))
    except Exception:  # noqa: BLE001 - unknown means no name
        return False


@router.get("/investigations/active", response_model=InvestigationsActive)
async def investigations_active(
    request: Request,
    case_id: str | None = Query(default=None, max_length=200),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> InvestigationsActive:
    """The AI investigations queued or running now, and those that just finished."""
    registry = state.investigations
    gate = getattr(state, "investigation_gate", None)
    prefs = state.execution_prefs
    cap = max(1, int(getattr(prefs.caps, "max_concurrent", 3)))
    if state.demo_active or gate is None:
        # The Demo pipeline runs without the gate: its running runs are its slots.
        in_use = sum(1 for handle in registry.active() if handle.state == "running")
    else:
        in_use = int(getattr(gate, "active", 0) or 0)
    return registry.snapshot(
        case_id=(case_id or "").strip() or None,
        viewer=current_username(request) or None,
        show_requester=await _show_requester(request),
        slots_in_use=in_use,
        slots_cap=cap,
    )


# --------------------------------------------------------------------------- #
# Checks before a manual reinvestigation (shared by the routes and the job)
# --------------------------------------------------------------------------- #
async def open_case_conflict(cases: Any, case: Any) -> None:
    """``409 open_case_exists`` when ``case`` is closed and another open case holds
    its signature (new events arrived after the close): reinvestigating it in place
    would leave two open cases for one signature (#4). Checked before the audit row and
    the cluster rebuild. An open case, or a lookup that finds nothing, passes."""
    status = str(getattr(case.status, "value", case.status) or "")
    if status in OPEN_CASE_STATUSES or not getattr(case, "cluster_signature", ""):
        return
    holder = await cases.find_open_by_signature(case.cluster_signature)
    if holder is not None and holder.case_id != case.case_id:
        raise HTTPException(status_code=409, detail={
            "code": "open_case_exists",
            "message": "An open case already holds these events. Reinvestigate that case.",
            "case_id": holder.case_id,
        })


@dataclass
class _Reservation:
    """A manual run asked for and not yet ended (it may still wait for the signature
    lock, before the pipeline registers it)."""

    run_id: str
    case_id: str
    signature: str
    requested_by: str | None
    queued_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _owner: dict[str, "_Reservation"] | None = None

    def release(self) -> None:
        owner = self._owner
        if owner is not None and owner.get(self.run_id) is self:
            owner.pop(self.run_id, None)
        self._owner = None

    def view(self, *, viewer: str | None, show_requester: bool) -> InvestigationView:
        mine = bool(self.requested_by) and (viewer or "").strip().lower() == (
            self.requested_by or ""
        ).strip().lower()
        return InvestigationView(
            run_id=self.run_id, case_id=self.case_id, state="queued", phase="queued",
            trigger="manual", queued_at=self.queued_at.isoformat(), requested_by_you=mine,
            requested_by=(self.requested_by if show_requester else None),
        )


#: Per registry (the real one, or a Demo stack's), the manual runs asked for that have
#: not ended. Weakly keyed: a Demo stack's entry goes with it.
_RESERVATIONS: "weakref.WeakKeyDictionary[Any, dict[str, _Reservation]]" = weakref.WeakKeyDictionary()


def _reservations(registry: Any) -> dict[str, _Reservation]:
    try:
        return _RESERVATIONS.setdefault(registry, {})
    except TypeError:  # an object that cannot be weakly referenced: no reservations
        return {}


def running_conflict(
    registry: Any, case: Any, *, viewer: str | None = None, show_requester: bool = False,
) -> dict[str, Any] | None:
    """The queued or running run on ``case`` (by case id, or by its signature, so an
    automatic run that has not attached its case yet is found too), as the caller sees
    it, or ``None``. Memory only; never raises."""
    try:
        handle = registry.for_case(case.case_id) or registry.for_signature(case.cluster_signature)
        if handle is not None:
            return handle.view(viewer=viewer, show_requester=show_requester).model_dump(mode="json")
        for reservation in list(_reservations(registry).values()):
            if reservation.case_id == case.case_id or (
                reservation.signature and reservation.signature == case.cluster_signature
            ):
                return reservation.view(viewer=viewer, show_requester=show_requester).model_dump(
                    mode="json",
                )
    except Exception as exc:  # noqa: BLE001 - an unreadable registry never blocks a person
        logger.debug("investigation conflict check skipped: %s", exc)
    return None


async def reserve_manual_run(
    request: Request, registry: Any, case: Any, *, run_id: str, requested_by: str | None,
) -> _Reservation:
    """``409 investigation_running`` (with the run) when a run on ``case`` is queued or
    running; otherwise reserve this request's run until :meth:`_Reservation.release`,
    so a second click that arrives before this run is registered is refused too. No
    await between the check and the reservation."""
    show = await _show_requester(request) if request is not None else False
    viewer = (current_username(request) or None) if request is not None else None
    running = running_conflict(registry, case, viewer=viewer, show_requester=show)
    if running is not None:
        raise HTTPException(status_code=409, detail={
            "code": "investigation_running",
            "message": "An AI investigation is already running on this case.",
            "run": running,
        })
    owner = _reservations(registry)
    reservation = _Reservation(
        run_id=run_id, case_id=str(case.case_id),
        signature=str(getattr(case, "cluster_signature", "") or ""),
        requested_by=requested_by, _owner=owner,
    )
    owner[run_id] = reservation
    return reservation
