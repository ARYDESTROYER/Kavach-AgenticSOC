"""Read-only replay fixture catalog + the operator purge control.

No endpoint anywhere returns a fixture BODY. A fixture holds raw, attacker-influenceable
log records — strictly more than a Case retains — and the only place it may be rendered
is inside a fenced prompt through the production ``render_cluster`` path (#9). What is
exposed here is identity and shape: ids, hashes, counts and bytes.

Running a replay is a durable Job (``JobKind.REPLAY_EXPERIMENT``), not an endpoint here:
it spends real provider money and needs the Jobs subsystem's lease, cancellation,
progress and verified-artifact guarantees.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Request

from ..constants import ActionType
from ..engine.replay.text import REPLAY_LIMITATIONS
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.replay")

router = APIRouter(prefix="/api", tags=["replay"])


@router.get("/replay/fixtures")
async def list_replay_fixtures(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Catalog metadata only, plus the storage bound and the honesty statement."""
    cfg = state.prefs.replay_capture
    doc = await state.replay_fixtures.catalog()
    entries = list(doc["entries"])
    stored = sum(int(entry.get("bytes", 0) or 0) for entry in entries)
    return {
        "capture": {
            "enabled": bool(cfg.enabled),
            "ring_size": int(cfg.ring_size),
            "max_fixture_bytes": int(cfg.max_fixture_bytes),
            "max_events_per_fixture": int(cfg.max_events_per_fixture),
        },
        "ring": {
            "used": len(entries),
            "capacity": int(cfg.ring_size),
            "bytes": stored,
            # The going-forward ceiling, never understated: lowering EITHER bound
            # applies to future captures, and bodies already stored are neither
            # re-checked against a tightened per-fixture cap nor re-counted against a
            # smaller ring, so the truthful ceiling is at least what is stored now.
            "max_bytes": max(
                int(cfg.ring_size) * int(cfg.max_fixture_bytes), stored
            ),
            "next_seq": int(doc["next_seq"]),
            "skipped_oversize": int(doc["skipped_oversize"]),
            "skipped_too_many_events": int(doc["skipped_too_many_events"]),
            # Sources that disagree on a field mapping have no single faithful frozen
            # replay surface, so such a cluster is not captured at all.
            "skipped_mapping_conflict": int(doc["skipped_mapping_conflict"]),
        },
        "fixtures": [{**entry, "available": True} for entry in entries],
        "notice": REPLAY_LIMITATIONS,
    }


@router.delete("/replay/fixtures")
async def purge_replay_fixtures(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    """Clear the catalog and overwrite every body slot.

    Capture is on by default and fixtures hold raw records, so an operator needs an
    immediate purge that does not require a factory reset.
    """
    removed = await state.replay_fixtures.clear()
    try:
        await state.control_audit.record(
            action_type=ActionType.JOB,
            surface="settings",
            actor=current_username(request) or "admin",
            result_summary=f"cleared {removed} replay fixtures",
        )
    except Exception:  # noqa: BLE001 — mirrors the general settings audit path
        logger.warning("Could not audit the replay fixture purge", exc_info=True)
    return {"status": "cleared", "removed": removed}
