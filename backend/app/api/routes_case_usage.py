"""The AI spend of one case, call by call (Round 16 SPEC §4.5 WP13, [dv] R3 and R14).

    GET /api/cases/{case_id}/usage    cases:read and cost:view

Every ledger row written with the case's id, newest first, at most
:data:`app.models.CASE_USAGE_MAX_ROWS` (500): the investigation pipeline's calls and the
case chat's alike. Each row is the stored :class:`app.models.UsageDoc` as the gateway
wrote it, so a row from this release carries the inputs of its price (the four
undiscounted per-million rates, ``cache_write_ttl`` and ``price_basis``) and its cost
re-derives as ``round((prompt * input + completion * output + cache_read * cache_read
rate + cache_write * cache_write rate) / 1e6 * (0.5 if batch else 1), 8)``. That
equals the stored cost, or differs from it by one unit of the 8th decimal when the value
lies on a rounding half-way point, because ``pricing.cost_for`` adds the same terms in
another order. A row written before the rates existed omits them ("rate not recorded").

Totals (:class:`app.models.CaseUsageTotals`), in USD:

* ``pipeline``: the router, investigator and formatter calls
  (``constants.CASE_PIPELINE_USAGE_ROLES``), the calls ``Case.token_cost`` records;
* ``chat``: case chat on this case, never part of the investigation cost;
* ``runbook``: runbook AI help on this case (the step drafts and suggestions, surface
  ``runbook``), never part of the investigation cost and never case chat;
* ``other``: anything else written with the case id.

When every row of the case fit on the page (``truncated`` false), ``rows_total`` is their
exact count and the four totals are exact lifetime sums of those rows. When the read
filled its bound, older rows may exist: ``truncated`` is true, ``rows_total`` is null,
``pipeline`` is the ledger's own exact lifetime sum
(``UsageRepository.total_pipeline_cost_for_case``) and ``chat``, ``runbook`` and
``other`` count the returned rows only, so they read "at least". ``reconciles`` says
whether ``pipeline`` equals the case's recorded ``token_cost`` within the one
micro-dollar it is displayed to (null when the ledger could not prove a lifetime
pipeline sum).

Read-only over the ledger (#6: the gateway stays its only writer), Demo-switched through
``state.usage_store`` (SPEC §3.2), and spend, so it needs ``cost:view`` as every other
spend figure does. No audit row: it reads no log data.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from ..constants import CASE_PIPELINE_USAGE_ROLES, Role
from ..models import CASE_USAGE_MAX_ROWS, CaseUsagePage, CaseUsageTotals, UsageDoc
from ..state import AppState
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.case_usage")

router = APIRouter(prefix="/api")

_READ_CASES = require_permission("cases", "read")
_VIEW_COST = require_permission("cost", "view")

#: ``Case.token_cost`` is displayed to six places: a ledger sum may differ from it by
#: one micro-dollar (the pipeline's own tolerance, ``agents.pipeline``).
RECONCILE_EPSILON = 0.000001
_PIPELINE_ROLES = frozenset(CASE_PIPELINE_USAGE_ROLES)
_CHAT_ROLE = Role.CHAT.value
#: The surface of runbook AI help (``engine.runbook_runs.CASE_RUNBOOK_SURFACE``): a chat
#: role call on it is a step draft or a suggestion, never case chat.
_RUNBOOK_SURFACE = "runbook"


def _cost(row: dict[str, Any]) -> float:
    try:
        return float(row.get("cost") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _totals(rows: list[dict[str, Any]]) -> CaseUsageTotals:
    """The spend split by what the call was for: the investigation roles, then the
    runbook surface (its calls use the chat role), then case chat, then the rest."""
    pipeline = chat = runbook = other = 0.0
    for row in rows:
        role = str(row.get("role") or "")
        if role in _PIPELINE_ROLES:
            pipeline += _cost(row)
        elif str(row.get("surface") or "") == _RUNBOOK_SURFACE:
            runbook += _cost(row)
        elif role == _CHAT_ROLE:
            chat += _cost(row)
        else:
            other += _cost(row)
    return CaseUsageTotals(
        pipeline=round(pipeline, 8), chat=round(chat, 8), runbook=round(runbook, 8),
        other=round(other, 8),
    )


def _reconciles(pipeline: float, token_cost: float) -> bool:
    return abs(round(pipeline, 6) - round(float(token_cost or 0.0), 6)) <= RECONCILE_EPSILON + 1e-12


@router.get("/cases/{case_id}/usage", response_model=CaseUsagePage)
async def case_usage(
    case_id: str,
    state: AppState = Depends(get_state),
    _cases=Depends(_READ_CASES),
    _cost_view=Depends(_VIEW_COST),
) -> CaseUsagePage:
    """The case's ledger rows and its spend split (see the module docstring). 404 for an
    unknown case; 503 ``case_usage_unavailable`` when the ledger cannot be read (never a
    false "no spend"); 501 ``case_usage_unsupported`` for a ledger that has no per-case
    read."""
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    store = state.usage_store
    try:
        raw = await store.records_for_case(case_id, limit=CASE_USAGE_MAX_ROWS)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail={
            "code": "case_usage_unsupported",
            "message": "This ledger cannot list the calls of one case.",
        }) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("case usage read failed for %s: %s", case_id, exc)
        raise HTTPException(status_code=503, detail={
            "code": "case_usage_unavailable",
            "message": "The usage ledger could not be read.",
        }) from exc
    raw = [row for row in (raw or []) if isinstance(row, dict) and row.get("case_id") == case_id]

    rows: list[UsageDoc] = []
    for row in raw:
        try:
            rows.append(UsageDoc.model_validate(row))
        except ValidationError as exc:
            logger.warning("case usage row skipped for %s: %s", case_id, exc)

    truncated = len(raw) >= CASE_USAGE_MAX_ROWS
    totals = _totals(raw)
    reconciles: bool | None
    if truncated:
        lifetime = None
        try:
            lifetime = await store.total_pipeline_cost_for_case(case_id)
        except Exception as exc:  # noqa: BLE001 (the page still answers, unproven)
            logger.warning("case pipeline total failed for %s: %s", case_id, exc)
        if lifetime is not None:
            totals.pipeline = round(float(lifetime), 8)
            reconciles = _reconciles(totals.pipeline, case.token_cost)
        else:
            reconciles = None
    else:
        reconciles = _reconciles(totals.pipeline, case.token_cost)

    return CaseUsagePage(
        case_id=case_id,
        rows=rows,
        returned=len(rows),
        rows_total=None if truncated else len(raw),
        truncated=truncated,
        totals=totals,
        token_cost=float(case.token_cost or 0.0),
        reconciles=reconciles,
    )
