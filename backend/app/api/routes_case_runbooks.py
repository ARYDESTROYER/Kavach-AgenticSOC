"""Runbook RUNS on cases (Round 14 SPEC §4.10.7, §4.10.8, §4.10.10, §4.10.15).

The per-case half of the one Runbooks feature: the library itself (built-ins, operator
runbooks, versions, governance) is ``routes_runbooks.py``. This router serves:

* ``GET /api/cases/{case_id}/runbooks``: the case's runs, each step's lookup evidence
  redacted for this viewer by the grant its tool needs (§4.8), progress, newer
  Published versions and the case's other tasks (``runbooks:read`` and ``cases:read``).
* ``GET .../candidates``: the Start runbook picker list with the match explanation.
* ``POST /api/cases/{case_id}/runbooks``: start a Published runbook by hand
  (``runbooks:run``); idempotent per case and runbook (#4): ``201`` new, ``200``
  ``already_attached``.
* ``POST .../suggest`` and ``POST .../steps/{step_id}/draft``: the AI's help, ONE
  gateway call each (#6), budget-gated on the ``runbook`` surface; ``dry_run=true``
  returns the estimate only. The AI never attaches, never marks a step and never
  touches the verdict (#3). Besides the shared errors of §4.10.15 they answer
  ``429 runbook_ai_budget`` ("The AI budget for today is used up."), ``504
  runbook_ai_timeout``, ``503 runbook_ai_unavailable`` and ``502 runbook_ai_invalid``
  (no draft text); nothing changes on any of them.
* ``PATCH .../steps/{step_id}`` and the step actions (lookup, approval, draft
  confirmation), ``switch-version`` and ``abandon`` (``runbooks:run``). The PATCH
  ``expected_revision`` is the STEP's revision (``runs[i].steps[step_id].revision``),
  never the run's or the case document's ``revision``: a background lookup or a
  change to another step never conflicts. A stale one is ``409 runbook_conflict``
  with the latest run (``latest``); so is confirming an AI draft after the step
  changed since the draft was made. Every run write answers ``409 runbook_state``
  while runbooks are turned off in Settings; an unknown case is ``404
  case_not_found``.
* ``POST /api/runbooks/progress``: progress per case for the queue chips
  (``cases:read``), at most 100 ids, at most 8 reads at once.
* ``POST /api/runbooks/lookup-test``: a draft lookup run against one case for the
  editor's "Test with a case" (``runbooks:manage``, ``sources:read``, ``cases:read``
  and the tool's grant); read-only, nothing stored, not audited (a read).

Every run change is audited before it becomes visible (``engine.runbook_runs``,
§3.6) and then published as a ``case.runbook`` frame on the ``runbooks`` topic.
Lookups read through the read-only paths only (#1, #8), and their results are
untrusted data (#9). Nothing here reads or writes ``case_manager.decide()`` or
``AutoClosePolicy`` (#3).
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from ..audit.context import audit_context
from ..engine import runbook_runs as runs_engine
from ..engine.runbook_runs import LOOKUP_TOOL_GRANTS, RunbookRunError
from ..models import (
    CaseRunbooks,
    LookupResult,
    RunAbandonBody,
    RunbookAttachBody,
    RunbookAttachResult,
    RunbookCandidates,
    RunbookLookupTestBody,
    RunbookProgress,
    RunbookProgressBody,
    RunbookRunUpdate,
    RunbookStepDraftResult,
    RunbookStepUpdate,
    RunbookSuggestion,
    RunSwitchVersionBody,
    StepApprovalBody,
    StepDraftConfirmBody,
)
from ..state import AppState
from .deps import AccessView, _enforce, current_username, get_state, require_permission, resolve_access

logger = logging.getLogger("tlsoc.api.case_runbooks")

router = APIRouter(prefix="/api")

#: At most this many case documents are read at once by the progress endpoint.
PROGRESS_READ_CONCURRENCY = 8


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def _case_or_404(state: AppState, case_id: str) -> Any:
    case = await state.cases.get(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail={"code": "case_not_found", "message": "Case not found."})
    return case


def _actor(request: Request) -> str:
    return current_username(request) or "analyst"


async def _view(request: Request) -> AccessView:
    return await resolve_access(request)


async def _require_tool_grant(request: Request, tool: str) -> None:
    """The grant a lookup tool needs (§4.10.8), enforced with the audited 403."""
    resource, action = LOOKUP_TOOL_GRANTS.get(tool, ("runbooks", "read"))
    await _enforce(request, resource, action)


def _role_key(value: Any) -> str:
    return re.sub(r"[\s-]+", "_", str(value or "").strip()).casefold()


def holds_approval_role(view: AccessView, role: str | None) -> bool:
    """True when the caller may approve a step whose ``approval_role`` is ``role``:
    auth or RBAC off (unrestricted), the super admin, the base role itself or one of
    the caller's assigned custom roles (compared without case, spaces or hyphens)."""
    if not role:
        return True
    if view.unrestricted:
        return True
    wanted = _role_key(role)
    held = {_role_key(view.role), *(_role_key(r) for r in view.assigned)}
    return wanted in held or _role_key(view.role) == "super_admin"


async def _conflict_with_latest(
    exc: RunbookRunError, state: AppState, case_id: str, run_id: str, allows: Callable[[str, str], bool],
) -> RunbookRunError:
    """A ``409 runbook_conflict`` carries the run as it is now (``latest``)."""
    if exc.status_code == 409 and exc.code == "runbook_conflict":
        latest = await runs_engine.latest_update(state, case_id, run_id, allows)
        if latest is not None:
            detail = dict(exc.detail) if isinstance(exc.detail, dict) else {}
            detail["latest"] = latest.model_dump(mode="json")
            return RunbookRunError(409, "runbook_conflict", exc.message,
                                   **{k: v for k, v in detail.items() if k not in ("code", "message")})
    return exc


async def _run_write(
    state: AppState, case_id: str, run_id: str, allows: Callable[[str, str], bool], call: Any,
) -> Any:
    try:
        return await call
    except RunbookRunError as exc:
        raise await _conflict_with_latest(exc, state, case_id, run_id, allows) from exc


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/runbooks", response_model=CaseRunbooks)
async def get_case_runbooks(
    case_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
    __=Depends(require_permission("cases", "read")),
) -> CaseRunbooks:
    """The case's runs with every lookup result redacted for this viewer."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    payload = await runs_engine.case_runbooks_view(state, case, view.allows)
    return CaseRunbooks.model_validate(payload)


@router.get("/cases/{case_id}/runbooks/candidates", response_model=RunbookCandidates)
async def get_runbook_candidates(
    case_id: str,
    request: Request,
    q: str | None = Query(default=None, max_length=200),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
    __=Depends(require_permission("cases", "read")),
) -> RunbookCandidates:
    """The Start runbook picker: the AI's last suggestion to this person, the best
    match with its explanation, other matches, the fallback, then every other
    Published runbook."""
    case = await _case_or_404(state, case_id)
    return RunbookCandidates(candidates=await runs_engine.candidates_for_case(
        state, case, q, actor=_actor(request),
    ))


@router.post("/runbooks/progress", response_model=dict[str, RunbookProgress])
async def runbook_progress(
    body: RunbookProgressBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, RunbookProgress]:
    """Progress per case (every run not abandoned, summed). A case with no run, or
    whose runs cannot be read, is absent from the answer."""
    ids = list(dict.fromkeys(body.case_ids))
    store = state.runbook_runs
    gate = asyncio.Semaphore(PROGRESS_READ_CONCURRENCY)

    async def one(case_id: str) -> tuple[str, RunbookProgress | None]:
        async with gate:
            try:
                case_runs = await store.get(case_id)
            except Exception as exc:  # noqa: BLE001 (a chip is advisory)
                logger.info("runbook progress for %s unavailable: %s", case_id[:80], exc)
                return case_id, None
        return case_id, runs_engine.case_progress(case_runs.runs)

    out: dict[str, RunbookProgress] = {}
    for case_id, progress in await asyncio.gather(*(one(cid) for cid in ids)):
        if progress is not None:
            out[case_id] = progress
    return out


# --------------------------------------------------------------------------- #
# Attaching and the AI suggestion
# --------------------------------------------------------------------------- #
@router.post("/cases/{case_id}/runbooks", response_model=RunbookAttachResult, status_code=201)
async def attach_case_runbook(
    case_id: str,
    body: RunbookAttachBody,
    request: Request,
    response: Response,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookAttachResult:
    """Start a Published runbook on the case. An existing run of it answers ``200``
    with ``already_attached`` (#4)."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    result = await runs_engine.attach_by_person(
        state, case, body.runbook_id, note=body.note, actor=_actor(request), context=audit_context(request),
    )
    if result.already_attached:
        response.status_code = 200
    if result.run is not None:
        result = result.model_copy(update={"run": runs_engine.redact_run(result.run, view.allows)})
    return result


@router.post("/cases/{case_id}/runbooks/suggest", response_model=RunbookSuggestion)
async def suggest_case_runbook(
    case_id: str,
    request: Request,
    dry_run: bool = Query(default=False),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookSuggestion:
    """Ask the AI which Published runbook fits (one gateway call; never attaches).
    ``dry_run=true`` returns the estimate (its cost only to a holder of ``models:read``)."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    return await runs_engine.suggest_runbook(
        state, case, actor=_actor(request), dry_run=dry_run, can_see_cost=view.allows("models", "read"),
    )


# --------------------------------------------------------------------------- #
# Steps
# --------------------------------------------------------------------------- #
@router.patch("/cases/{case_id}/runbooks/{run_id}/steps/{step_id}", response_model=RunbookRunUpdate)
async def update_runbook_step(
    case_id: str,
    run_id: str,
    step_id: str,
    body: RunbookStepUpdate,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookRunUpdate:
    """Status, assignee, note, reason, a decision, a recorded action or an evidence
    link. ``expected_revision`` is the STEP's revision; a stale one is ``409``."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.update_step(
        state, case, run_id, step_id, body, actor=_actor(request), context=audit_context(request),
        allows=view.allows,
    ))


async def _step_or_error(state: AppState, case_id: str, run_id: str, step_id: str) -> Any:
    try:
        case_runs = await state.runbook_runs.get(case_id)
    except Exception as exc:  # noqa: BLE001
        raise runs_engine.map_store_error(exc) from exc
    run = case_runs.run(run_id)
    if run is None:
        raise RunbookRunError(404, "run_not_found", "That runbook is not on this case.")
    step = next((s for s in run.snapshot.steps if s.id == step_id), None)
    if step is None:
        raise RunbookRunError(404, "step_not_found", "That step is not in this runbook.")
    return step


@router.post("/cases/{case_id}/runbooks/{run_id}/steps/{step_id}/lookup", response_model=RunbookRunUpdate)
async def run_runbook_lookup(
    case_id: str,
    run_id: str,
    step_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookRunUpdate:
    """Run the step's lookup now (read-only), replacing its previous result. Needs
    the grant the lookup's tool needs (§4.10.8); a lookup that cannot run is ``503
    lookup_unavailable`` and replaces nothing."""
    case = await _case_or_404(state, case_id)
    step = await _step_or_error(state, case_id, run_id, step_id)
    if step.lookup is not None:
        await _require_tool_grant(request, step.lookup.tool)
    view = await _view(request)
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.run_lookup_now(
        state, case, run_id, step_id, actor=_actor(request), context=audit_context(request),
        allows=view.allows,
    ))


@router.post("/cases/{case_id}/runbooks/{run_id}/steps/{step_id}/approval", response_model=RunbookRunUpdate)
async def decide_runbook_approval(
    case_id: str,
    run_id: str,
    step_id: str,
    body: StepApprovalBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookRunUpdate:
    """Approve or reject a recorded action waiting for approval. Needs the step's
    ``approval_role``; the person who recorded the action can never approve it."""
    case = await _case_or_404(state, case_id)
    step = await _step_or_error(state, case_id, run_id, step_id)
    view = await _view(request)
    if not holds_approval_role(view, step.approval_role):
        raise RunbookRunError(403, "runbook_approval_role",
                              f"Only a {step.approval_role} can approve this step.")
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.decide_approval(
        state, case, run_id, step_id, decision=body.decision, reason=body.reason,
        actor=_actor(request), context=audit_context(request), allows=view.allows,
    ))


@router.post("/cases/{case_id}/runbooks/{run_id}/steps/{step_id}/draft",
             response_model=RunbookStepDraftResult)
async def draft_runbook_step(
    case_id: str,
    run_id: str,
    step_id: str,
    request: Request,
    dry_run: bool = Query(default=False),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookStepDraftResult:
    """"Draft note" on a Check step: one gateway call; the draft is stored as "AI
    draft" until a person confirms it. ``dry_run=true`` returns the estimate."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.draft_step(
        state, case, run_id, step_id, actor=_actor(request), context=audit_context(request),
        dry_run=dry_run, can_see_cost=view.allows("models", "read"), allows=view.allows,
    ))


@router.post("/cases/{case_id}/runbooks/{run_id}/steps/{step_id}/draft/confirm",
             response_model=RunbookRunUpdate)
async def confirm_runbook_step_draft(
    case_id: str,
    run_id: str,
    step_id: str,
    body: StepDraftConfirmBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookRunUpdate:
    """The draft as the person edited it becomes the step's note and the step is Done.
    When the step changed after the draft was made (a note written since, for one),
    the answer is ``409 runbook_conflict`` with the latest run and nothing changes."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.confirm_draft(
        state, case, run_id, step_id, body.text, actor=_actor(request), context=audit_context(request),
        allows=view.allows,
    ))


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #
@router.post("/cases/{case_id}/runbooks/{run_id}/switch-version", response_model=RunbookRunUpdate)
async def switch_runbook_run_version(
    case_id: str,
    run_id: str,
    body: RunSwitchVersionBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookRunUpdate:
    """Move the run to the Published version, keeping each step whose id exists in
    both versions."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.switch_version(
        state, case, run_id, body.version, actor=_actor(request), context=audit_context(request),
        allows=view.allows,
    ))


@router.post("/cases/{case_id}/runbooks/{run_id}/abandon", response_model=RunbookRunUpdate)
async def abandon_runbook_run(
    case_id: str,
    run_id: str,
    body: RunAbandonBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "run")),
) -> RunbookRunUpdate:
    """Abandon the run with a reason. It stays readable; the case is not changed (#3)."""
    case = await _case_or_404(state, case_id)
    view = await _view(request)
    return await _run_write(state, case_id, run_id, view.allows, runs_engine.abandon_run(
        state, case, run_id, body.reason, actor=_actor(request), context=audit_context(request),
        allows=view.allows,
    ))


# --------------------------------------------------------------------------- #
# The editor's "Test with a case"
# --------------------------------------------------------------------------- #
@router.post("/runbooks/lookup-test", response_model=LookupResult)
async def lookup_test(
    body: RunbookLookupTestBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
    __=Depends(require_permission("sources", "read")),
    ___=Depends(require_permission("cases", "read")),
) -> LookupResult:
    """Run a draft lookup against one case, read-only: nothing is stored and nothing
    is audited (a read). The same bounds and 45-second limit as a run's lookup."""
    await _require_tool_grant(request, body.lookup.tool)
    case = await _case_or_404(state, body.case_id)
    return await runs_engine.preview_lookup(state, case, body.lookup, actor=_actor(request))
