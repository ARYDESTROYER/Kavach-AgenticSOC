"""Global-search routes: Round 5 (Coupling-E extraction).

A cohesive slice carved OUT of the ``routes.py`` monolith with **byte-identical
paths, methods, auth dependencies, request/response bodies**. Handlers moved verbatim
(imports re-homed); the router is mounted in ``main.py`` under the SAME ``require_auth``
gate the monolith uses, so ``test_route_auth_coverage`` stays green.

It owns one read-only operator surface:

* ``GET /api/search`` — the command-palette / top-bar fuzzy jump (cases + sources +
  static nav targets). Gated on ``cases:read``.

The audit log read API (``GET /api/audit`` and its record and count routes) moved to
``routes_audit.py`` in Round 14 with every old parameter keeping its meaning.

NON-NEGOTIABLES held: #9, all matched case/source text carries operator/log data and
is returned VERBATIM for the UI to render as PLAIN text.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..state import AppState
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.search")

router = APIRouter(prefix="/api")


class SearchResponse(BaseModel):
    """The command-palette search envelope. Result rows are loose typed dicts (each
    carries operator/log DATA rendered PLAIN by the UI, #9)."""

    query: str
    cases: list[dict[str, Any]] = Field(default_factory=list)
    sources: list[dict[str, Any]] = Field(default_factory=list)
    nav: list[dict[str, Any]] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Global search (W7c) — the command-palette / top-bar fuzzy jump.
# --------------------------------------------------------------------------- #

# Static jump targets the command palette can navigate to. ``page`` is the webui
# route id (#/<page>); ``settings`` rows deep-link into a settings section. Kept in
# the backend so the palette gets a consistent result set; matched case-insensitively
# against the query over the searchable text.
_NAV_TARGETS: list[dict[str, str]] = [
    {"type": "page", "id": "overview", "label": "Overview", "keywords": "home dashboard posture"},
    {"type": "page", "id": "cases", "label": "Cases", "keywords": "triage queue alerts incidents"},
    {"type": "page", "id": "chat", "label": "Workspace", "keywords": "chat investigate assistant"},
    {"type": "page", "id": "investigate", "label": "Investigate", "keywords": "entity hunt"},
    {"type": "page", "id": "scans", "label": "Automated scans", "keywords": "auto scan queue"},
    {"type": "page", "id": "approvals", "label": "Approvals", "keywords": "proposals hitl pending"},
    {"type": "page", "id": "intelligence", "label": "Intelligence", "keywords": "knowledge memory rag playbooks agents"},
    {"type": "page", "id": "knowledge", "label": "Knowledge", "keywords": "rag corpus documents runbooks"},
    {"type": "page", "id": "memory", "label": "Memory", "keywords": "agent memory facts"},
    {"type": "page", "id": "metrics", "label": "Analytics", "keywords": "metrics dashboard charts"},
    {"type": "page", "id": "cost", "label": "Cost & usage", "keywords": "cost ledger tokens spend budget"},
    {"type": "page", "id": "standup", "label": "Standup", "keywords": "daily summary digest"},
    {"type": "page", "id": "sources", "label": "Sources", "keywords": "connectors siem edr ingest data"},
    {"type": "page", "id": "catalog", "label": "Integrations", "keywords": "catalog connectors marketplace"},
    {"type": "page", "id": "settings", "label": "Settings", "keywords": "preferences configuration"},
    {"type": "settings", "id": "account", "label": "Account", "keywords": "settings profile me"},
    {"type": "settings", "id": "security", "label": "Security", "keywords": "settings auth mfa password"},
    {"type": "settings", "id": "sessions", "label": "Sessions", "keywords": "settings devices logout"},
    {"type": "settings", "id": "users", "label": "Users & roles", "keywords": "settings rbac members"},
]


@router.get("/search", response_model=SearchResponse)
async def global_search(
    q: str = Query("", description="free-text query"),
    limit: int = 20,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Lightweight global search for the command palette / top-bar jump (W7c).

    Returns typed results — ``cases`` (matched on case_id / case_number / title /
    entity value / tags / source_name), ``sources`` (name/type), and static ``nav``
    targets (pages + settings sections) — so the palette can jump ANYWHERE.

    Reuses the ACTIVE case store (``state.cases``), so it works in demo mode too.
    Bounded (``limit`` default ~20, hard-capped). All matched text is operator/log
    data and is returned verbatim for the UI to render as PLAIN text (#9)."""
    term = (q or "").strip().lower()
    cap = max(1, min(int(limit or 20), 50))

    # --- cases: pull a bounded recent window from the ACTIVE store, filter in code.
    case_hits: list[dict[str, Any]] = []
    try:
        cases, _total = await state.cases.list(limit=200, offset=0)
    except Exception as exc:  # noqa: BLE001 — search must degrade gracefully
        logger.warning("search: case listing failed: %s", exc)
        cases = []
    for c in cases:
        hay = " ".join(
            str(x or "").lower()
            for x in (
                c.case_id, c.case_number, c.title,
                getattr(c.entity, "value", ""),
                c.source_name, c.source_id,
                " ".join(c.tags or []),
            )
        )
        if not term or term in hay:
            case_hits.append({
                "type": "case",
                "id": c.case_id,
                "case_number": c.case_number,
                "title": c.title,
                "status": c.status.value if c.status else "",
                "verdict": c.verdict.value if c.verdict else "",
                "entity": getattr(c.entity, "value", ""),
                "source_name": c.source_name or "",
            })
            if len(case_hits) >= cap:
                break

    # --- sources: match name / type over the operator-configured source list.
    source_hits: list[dict[str, Any]] = []
    for s in state.prefs.sources:
        st = s.source_type.value if hasattr(s.source_type, "value") else str(s.source_type)
        hay = f"{s.display_name} {st} {s.id}".lower()
        if not term or term in hay:
            source_hits.append({
                "type": "source", "id": s.id,
                "label": s.display_name or s.id, "source_type": st,
            })
        if len(source_hits) >= cap:
            break

    # --- nav targets: static pages + settings sections.
    nav_hits: list[dict[str, Any]] = []
    for t in _NAV_TARGETS:
        hay = f"{t['label']} {t['id']} {t.get('keywords', '')}".lower()
        if not term or term in hay:
            nav_hits.append({
                "type": t["type"], "id": t["id"], "label": t["label"],
            })
        if len(nav_hits) >= cap:
            break

    return {
        "query": q or "",
        "cases": case_hits,
        "sources": source_hits,
        "nav": nav_hits,
    }
