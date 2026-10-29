"""Per-case runbook RUNS (Round 14 SPEC §4.10.4, §4.10.7, §4.10.8, §4.10.10, §4.10.15).

This module is the run engine behind ``api/routes_case_runbooks.py`` and every
re-evaluation hook. It owns:

* **Attachment** (§4.10.4): :func:`reevaluate_case` attaches the matching runbook to a
  case that needs a person (``runbooks.auto_attach``, D32), once per ``(case_id,
  runbook_id)`` (#4). A re-evaluation attaches another runbook only when its tier is
  higher than every run already on the case; it never removes or replaces a run. The
  Generic incident fallback attaches only when nothing else matched and the case has
  no run (D33). Auto-closed cases (and a pending automatic close) never get a run. A
  person attaches by hand (:func:`attach_by_person`); an automation rule attaches
  through :func:`attach_by_automation`.
* **Steps** (§4.10.3, §4.10.7): status, assignee, note, evidence links, decisions
  (which mark only later steps still To do as Not applicable), recorded actions and
  the optional second-person approval (``runbooks.step_approvals``, D35). A run
  completes when every required step is Done or Not applicable; completing or
  abandoning a run never changes the case (#3).
* **Lookups** (§4.10.8): read-only execution of a bound lookup through the read-only
  log paths (#1), the cached enrichment path (#8), the case and campaign stores and
  the bundled ATT&CK data, with a 45-second bound and at most 2 lookups at once per
  run. Results are untrusted plain text (#9) and are redacted per viewer by the grant
  each tool needs (:func:`redact_run`).
* **The AI's help** (§4.10.10): "Draft note" and "Suggest a runbook", each ONE gateway
  call (#6), ledgered and budget-gated (surface ``runbook``, so the daily AI budget
  applies). A model receives only a lookup's count, facts and aggregate tables; a raw
  ``log_search`` row table is reduced by code first (:func:`reduce_lookup_for_prompt`,
  #7). The AI never marks a step, never attaches and never touches the verdict.
* **The close reason** (D34): :func:`open_required_steps` and
  :func:`record_closed_with_open_steps` serve the human close paths in ``routes.py``.

Every run change is audited before it becomes visible (``audit.write.audited_write``,
§3.6) into the ACTIVE execution audit (runs are Demo-swapped, §3.5), and only then is
the ``case.runbook`` frame published on the ``runbooks`` topic (progress only, to
holders of ``runbooks:read`` and ``cases:read``).

Nothing here reads or writes ``case_manager.decide()`` or ``AutoClosePolicy`` (#3).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
import time
import unicodedata
import weakref
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Sequence

from fastapi import HTTPException

from ..audit.write import audited_write
from ..constants import (
    ActionType,
    CaseStatus,
    DecisionBy,
    IndicatorKind,
    Role,
    RUNBOOK_SELECTOR_ACTOR,
)
from ..models import (
    MAX_RUNS_PER_CASE,
    RUNBOOK_AI_DRAFT_MAX_CHARS,
    RUNBOOK_LOOKUP_MAX_FACTS,
    RUNBOOK_LOOKUP_TABLE_MAX_CELL_CHARS,
    RUNBOOK_LOOKUP_TABLE_MAX_COLUMNS,
    RUNBOOK_LOOKUP_TABLE_MAX_ROWS,
    RUNBOOK_STEP_MAX_EVIDENCE,
    RUNBOOK_SYSTEM_RUNNER,
    AuditChange,
    AuditTarget,
    LookupResult,
    LookupTemplate,
    MatchExplanation,
    ReportSummaryEstimate,
    RunbookAttachResult,
    RunbookCandidate,
    RunbookDefinition,
    RunbookProgress,
    RunbookRun,
    RunbookRunUpdate,
    RunbookStep,
    RunbookStepDraftResult,
    RunbookStepsOpen,
    RunbookStepUpdate,
    RunbookSuggestion,
    StepEvidence,
    StepState,
)
from ..stores.runbook_library import RunbookStoreUnavailable
from ..stores.runbook_runs import (
    CaseRuns,
    RunbookLedgerRow,
    RunConflict,
    RunDocumentFull,
    RunLimitReached,
    RunNotFound,
    StepNotFound,
    check_case_runs,
)
from ..utils import dotted_get, extract_json, iso_now, new_id, now_utc
from . import runbook_lookup as lookups
from .runbook_match import (
    CaseFacts,
    MatchableRunbook,
    case_facts_from_case,
    describe_explanation,
    match,
    matchable_catalog,
)
from .runbook_model import load_builtin_runbooks

logger = logging.getLogger("tlsoc.engine.runbook_runs")

__all__ = [
    "ATTACHABLE_STATUSES",
    "CASE_RUNBOOK_SURFACE",
    "LOOKUP_TOOL_GRANTS",
    "NO_ACCESS_SENTENCES",
    "RunbookCatalog",
    "RunbookRunError",
    "attach_by_automation",
    "attach_by_person",
    "attachment_blocked",
    "candidates_for_case",
    "case_progress",
    "case_runbooks_view",
    "confirm_draft",
    "decide_approval",
    "draft_step",
    "execute_lookup",
    "load_catalog",
    "next_step",
    "open_required_steps",
    "plan_attachment",
    "preview_lookup",
    "record_closed_with_open_steps",
    "redact_run",
    "reduce_lookup_for_prompt",
    "reevaluate_case",
    "run_lookup_now",
    "run_progress",
    "run_summary",
    "abandon_run",
    "suggest_runbook",
    "switch_version",
    "update_step",
]

#: The ledger surface of every runbook model call (budget-gated: only ``chat`` is
#: outside the daily AI budget, ``llm.gateway.BUDGET_EXEMPT_SURFACES``).
CASE_RUNBOOK_SURFACE = "runbook"
#: The audit surface of every run change.
_AUDIT_SURFACE = "runbook"

#: Case statuses that need a person: a run attaches only to these. ``new`` is a
#: candidate the pipeline has not decided yet; ``resolved`` and ``closed`` are terminal.
ATTACHABLE_STATUSES: frozenset[str] = frozenset({
    CaseStatus.OPEN.value,
    CaseStatus.NEEDS_HUMAN.value,
    CaseStatus.INVESTIGATING.value,
    CaseStatus.ESCALATED.value,
    CaseStatus.ON_HOLD.value,
})
_TERMINAL_CASE_STATUSES = frozenset({CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value})
_FINISHED_STEP = frozenset({"done", "not_applicable"})
#: Why an automation rule attached nothing to a case that does not need a person
#: (:func:`attachment_blocked`), on its ``run.attach_skipped`` row.
AUTOMATION_SKIP_REASONS: dict[str, str] = {
    "status": "The case does not need a person (it is new, resolved or closed).",
    "pending_auto_close": "The case is closing automatically (its objection window is open).",
}

#: What a viewer must hold to SEE (and a person to RUN) each lookup tool (§4.8).
LOOKUP_TOOL_GRANTS: dict[str, tuple[str, str]] = {
    "log_stats": ("sources", "read"),
    "log_search": ("sources", "read"),
    "enrich": ("enrichment", "read"),
    "related_cases": ("cases", "read"),
    "campaign": ("cases", "read"),
    "mitre": ("runbooks", "read"),
}
#: What a viewer without the tool's grant sees in place of the evidence.
NO_ACCESS_SENTENCES: dict[tuple[str, str], str] = {
    ("sources", "read"): "You do not have access to log data.",
    ("enrichment", "read"): "You do not have access to enrichment results.",
    ("cases", "read"): "You do not have access to cases.",
    ("runbooks", "read"): "You do not have access to runbooks.",
}

#: How long a lookup may run (seconds); read at call time so a test can shorten it.
LOOKUP_TIMEOUT_S: float = float(lookups.LOOKUP_TIMEOUT_S)
#: How long the member events of a case may take to load for a lookup (seconds).
CASE_EVENTS_TIMEOUT_S: float = 10.0
#: Newest events read per source when a lookup cannot be counted natively.
LOG_SAMPLE_ROWS = 200
#: At most this many prior lookups feed one AI draft.
DRAFT_MAX_EVIDENCE = 8
#: At most this many runbooks are offered to the AI as suggestion candidates.
SUGGEST_MAX_CANDIDATES = 40
#: How long the last AI suggestion on a case is remembered for "accepted by" (seconds).
SUGGESTION_TTL_S = 3600.0
_SUGGESTION_MEMORY_MAX = 1000
_SUGGEST_REASON_MAX_CHARS = 280
#: The AI calls' answer budget (tokens) and the report-summary wait rule (2 x the
#: chat model step timeout, at most 280 s, below the Web UI proxy's 300 s).
_AI_MIN_OUTPUT_TOKENS = 300
_AI_MAX_OUTPUT_TOKENS = 900
_AI_EXPECTED_OUTPUT_TOKENS = 400
_AI_TIMEOUT_CEILING_S = 280.0

_NOTE_EMPTY_MESSAGE = "Add a note before marking this step done."
_WAITING_MESSAGE = "This step waits for approval. An approver approves or rejects it first."
_PERFORMED_AT_MESSAGE = "Give the time the action was performed as a date and time, not in the future."
#: How far ahead of the server's clock a recorded action's time may be (a person's
#: clock running a little fast is not a future time).
_ACTION_TIME_SKEW = timedelta(minutes=5)
_DATE_LIKE_RE = re.compile(r"^\s*\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?(?:[T ][\d:.+\-Z ]*)?\s*$")


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class RunbookRunError(HTTPException):
    """A refusal of the run API: ``{"detail": {"code", "message", ...}}`` with the
    §4.10.15 error codes (``run_not_found``, ``step_state``, ``runbook_conflict``...)."""

    def __init__(self, status_code: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(status_code=status_code, detail={"code": code, "message": message, **extra})
        self.code = code
        self.message = message


def _conflict_error(current: int) -> RunbookRunError:
    """``409 runbook_conflict``: the step changed since the person read it (the route
    adds the run as it is now, ``latest``)."""
    return RunbookRunError(409, "runbook_conflict",
                           "This step changed since you opened it. Showing the latest.",
                           step_revision=current)


class _StepConflict(Exception):
    """The step changed since the person read it (their ``expected_revision``)."""

    def __init__(self, current: int) -> None:
        super().__init__("This step changed since you opened it.")
        self.current = current


def map_store_error(exc: BaseException) -> RunbookRunError:
    """The HTTP refusal for a run-store error."""
    if isinstance(exc, RunbookRunError):
        return exc
    if isinstance(exc, RunConflict):
        return RunbookRunError(409, "runbook_conflict",
                               "This runbook changed since you opened it. Showing the latest.",
                               revision=exc.current_revision)
    if isinstance(exc, RunLimitReached):
        return RunbookRunError(409, "run_limit", f"A case can hold at most {MAX_RUNS_PER_CASE} runbooks.")
    if isinstance(exc, RunDocumentFull):
        code = "step_state" if exc.reason == "evidence_count" else "runbook_limit"
        return RunbookRunError(409, code, str(exc))
    if isinstance(exc, RunNotFound):
        return RunbookRunError(404, "run_not_found", "That runbook is not on this case.")
    if isinstance(exc, StepNotFound):
        return RunbookRunError(404, "step_not_found", "That step is not in this runbook.")
    if isinstance(exc, RunbookStoreUnavailable):
        return RunbookRunError(503, "runbook_store_unavailable",
                               "Runbook runs could not be read or saved. Try again.")
    return RunbookRunError(503, "runbook_store_unavailable", "Runbook runs could not be saved. Try again.")


_STORE_ERRORS = (RunConflict, RunLimitReached, RunDocumentFull, RunNotFound, StepNotFound,
                 RunbookStoreUnavailable)


def _state_error(message: str) -> RunbookRunError:
    return RunbookRunError(409, "runbook_state", message)


def _step_error(message: str) -> RunbookRunError:
    return RunbookRunError(409, "step_state", message)


# --------------------------------------------------------------------------- #
# The catalog of published runbooks
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RunbookCatalog:
    """Every runbook a run may use: the built-ins (each at its release version) and
    the Published version of every operator runbook. ``matchable`` is what automatic
    attachment matches against (a built-in replaced by a Published copy is left out,
    §4.10.5); a person may still start any published runbook by hand."""

    builtins: tuple[MatchableRunbook, ...]
    operator: tuple[MatchableRunbook, ...]
    replaced: frozenset[str]
    matchable: tuple[MatchableRunbook, ...]

    def published(self, runbook_id: str) -> MatchableRunbook | None:
        """The live version of ``runbook_id`` (a built-in wins an id collision, as in
        :func:`runbook_match.matchable_catalog`), or ``None``."""
        for item in self.builtins:
            if item.id == runbook_id:
                return item
        for item in self.operator:
            if item.id == runbook_id:
                return item
        return None

    def everything(self) -> tuple[MatchableRunbook, ...]:
        """Every published runbook a person can start, built-ins first, each id once."""
        seen: set[str] = set()
        out: list[MatchableRunbook] = []
        for item in (*self.builtins, *self.operator):
            if item.id not in seen:
                seen.add(item.id)
                out.append(item)
        return tuple(out)


async def load_catalog(state: Any) -> RunbookCatalog:
    """The catalog over the bundled library and the (real, Demo read-only) operator
    library. A library read failure raises :class:`RunbookStoreUnavailable`: callers
    that attach skip rather than match against an incomplete catalog (a built-in an
    operator copy replaces must not attach)."""
    builtins = tuple(
        MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
        for b in load_builtin_runbooks()
    )
    # Demo Mode (D45): the active stack may map the synthetic Demo rule names onto the
    # built-ins that cover them (``AppState.runbook_catalog_overlay``), so a Demo case
    # gets the run its storyline calls for, the same runbook the Demo investigator was
    # guided by. The real stack returns the built-ins unchanged.
    overlay = getattr(state, "runbook_catalog_overlay", None)
    if callable(overlay):
        builtins = tuple(overlay(builtins))
    library = getattr(state, "runbook_library", None)
    published = await library.published_catalog() if library is not None else ()
    operator: list[MatchableRunbook] = []
    replaced: set[str] = set()
    for item in published:
        origin = "imported" if getattr(item.runbook, "origin", "operator") == "imported" else "operator"
        operator.append(MatchableRunbook(
            id=item.runbook.id, version=item.live.version, definition=item.live.definition,
            origin=origin, published_at=item.live.published_at,
        ))
        if item.runbook.replaces:
            replaced.add(item.runbook.replaces)
    return RunbookCatalog(
        builtins=builtins,
        operator=tuple(operator),
        replaced=frozenset(replaced),
        matchable=matchable_catalog(builtins, operator, replaced_builtin_ids=replaced),
    )


async def _library_has(state: Any, runbook_id: str) -> bool:
    library = getattr(state, "runbook_library", None)
    if library is None:
        return False
    try:
        return await library.get(runbook_id) is not None
    except Exception:  # noqa: BLE001 (an unreadable library says nothing about the id)
        return False


# --------------------------------------------------------------------------- #
# Pure run helpers
# --------------------------------------------------------------------------- #
def ordered_steps(definition: RunbookDefinition) -> list[RunbookStep]:
    """The steps in reading order: by phase (the runbook's phase order), then as
    written."""
    rank = {phase: i for i, phase in enumerate(definition.phases)}
    indexed = list(enumerate(definition.steps))
    indexed.sort(key=lambda pair: (rank.get(pair[1].phase, len(rank)), pair[0]))
    return [step for _i, step in indexed]


def _step_state(run: RunbookRun, step_id: str) -> StepState:
    state = run.steps.get(step_id)
    return state if state is not None else StepState()


def _waiting(state: StepState) -> bool:
    approval = state.approval
    return isinstance(approval, dict) and approval.get("status") == "pending"


def _approval_status(state: StepState) -> str | None:
    """The approval's status on a step (``pending``, ``approved``, ``rejected``) or
    ``None`` when the step carries no approval."""
    approval = state.approval
    if not isinstance(approval, dict):
        return None
    status = approval.get("status")
    return str(status) if status else None


def _run_untouched(run: RunbookRun) -> bool:
    """No step of ``run`` has been worked yet: every step is To do and none was
    started (a note, a decision or a recorded action starts a step). The first change
    that ends this is the run's ``run.started`` (§4.10.15)."""
    return all(
        st.started_at is None and st.status == "todo"
        for st in (_step_state(run, step.id) for step in run.snapshot.steps)
    )


def run_progress(run: RunbookRun) -> RunbookProgress:
    """Progress derived on read (§4.10.7): Done counts only ``done``; Not applicable is
    counted on its own; ``required_open`` are required steps not Done or Not
    applicable; ``waiting`` are recorded actions whose approval is pending."""
    out = RunbookProgress()
    for step in run.snapshot.steps:
        st = _step_state(run, step.id)
        out.total += 1
        if st.status == "done":
            out.done += 1
        elif st.status == "not_applicable":
            out.not_applicable += 1
        if st.status == "blocked":
            out.blocked += 1
        if _waiting(st):
            out.waiting += 1
        if step.required and st.status not in _FINISHED_STEP:
            out.required_open += 1
    return out


def case_progress(runs: Iterable[RunbookRun]) -> RunbookProgress | None:
    """One progress for a case: the sum over every run that is not abandoned (a case
    usually has one). ``None`` when the case has no such run."""
    total: RunbookProgress | None = None
    for run in runs:
        if run.status == "abandoned":
            continue
        progress = run_progress(run)
        if total is None:
            total = progress
            continue
        total = RunbookProgress(**{
            name: getattr(total, name) + getattr(progress, name)
            for name in RunbookProgress.model_fields
        })
    return total


def _is_complete(run: RunbookRun) -> bool:
    """§4.10.7: a run completes when every REQUIRED step is Done or Not applicable. A
    required step waiting for approval is still open (``in_progress``), so it is
    counted in ``required_open`` already; an optional step waiting for approval never
    keeps the run active."""
    return run_progress(run).required_open == 0


def next_step(run: RunbookRun) -> RunbookStep | None:
    """The step the Next step card shows: the first required step (in reading order)
    that is not Done or Not applicable, else the first such optional step."""
    open_steps = [s for s in ordered_steps(run.snapshot) if _step_state(run, s.id).status not in _FINISHED_STEP]
    for step in open_steps:
        if step.required:
            return step
    return open_steps[0] if open_steps else None


def _refresh_completion(run: RunbookRun, now: str) -> str | None:
    """Mark ``run`` completed (or active again) after a step change. Returns
    ``"completed"``, ``"reopened"`` or ``None`` (no run-level transition). An
    abandoned run is left alone."""
    if run.status == "abandoned":
        return None
    complete = _is_complete(run)
    if complete and run.status != "completed":
        run.status = "completed"
        run.completed_at = now
        return "completed"
    if not complete and run.status == "completed":
        run.status = "active"
        run.completed_at = None
        return "reopened"
    return None


def _new_run(
    case_id: str, entry: MatchableRunbook, *, attached_by: str, attached_reason: dict[str, Any],
    actor: str, now: str,
) -> RunbookRun:
    return RunbookRun(
        run_id=new_id("run-"),
        case_id=case_id,
        runbook_id=entry.id,
        version=entry.version,
        title=entry.definition.title,
        snapshot=entry.definition,
        attached_by=attached_by,  # type: ignore[arg-type]
        attached_reason=attached_reason,
        attached_at=now,
        attached_actor=actor,
        steps={step.id: StepState() for step in entry.definition.steps},
    )


def _find_run(runs: list[RunbookRun], run_id: str) -> RunbookRun:
    for run in runs:
        if run.run_id == run_id:
            return run
    raise RunNotFound(run_id)


def _find_step(run: RunbookRun, step_id: str) -> RunbookStep:
    for step in run.snapshot.steps:
        if step.id == step_id:
            return step
    raise StepNotFound(step_id)


def _same_person(a: Any, b: Any) -> bool:
    left = str(a or "").strip().casefold()
    right = str(b or "").strip().casefold()
    return bool(left) and left == right


def _audit_text(value: Any) -> str | None:
    """A free-text value for an audit ``changes`` entry. A value Elasticsearch's date
    detection would read as a date (``2026-10-28``) is written in double quotes, so an
    audit index that still detects dates never maps the field as a date (A4a's hand-off;
    the inspector shows the quotes)."""
    if value is None:
        return None
    text = str(value)
    return f'"{text}"' if _DATE_LIKE_RE.match(text) else text


def _target(case: Any) -> AuditTarget:
    case_id = str(getattr(case, "case_id", "") or "")
    label = str(getattr(case, "case_number", "") or "") or case_id
    return AuditTarget(type="case", id=case_id, label=label)


def _url_host(url: str | None) -> str:
    if not url:
        return ""
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    return f"{parts.scheme}://{parts.hostname}" if parts.hostname else ""


# --------------------------------------------------------------------------- #
# Audited writes, frames and the ledger
# --------------------------------------------------------------------------- #
@dataclass
class _Stack:
    """The execution stack one write binds at its start (§3.5): the run store, the
    audit repository and the event bus. Binding them once keeps a Demo toggle during
    a write (or a background lookup) from crossing between real and Demo state."""

    runs: Any
    audit: Any
    bus: Any
    prefs: Any


def _bind_stack(state: Any) -> _Stack:
    return _Stack(
        runs=state.runbook_runs,
        audit=getattr(state, "execution_audit", None) or state.audit,
        bus=getattr(state, "event_bus", None),
        prefs=getattr(state, "execution_prefs", None) or state.prefs,
    )


def _publish_frames(stack: _Stack, case_id: str, runs: Iterable[RunbookRun], revision: int) -> None:
    """``case.runbook`` frames (progress only) after a run write. Fire-and-forget."""
    if stack.bus is None:
        return
    from ..realtime import publish_case_runbook

    for run in runs:
        try:
            publish_case_runbook(stack.bus, case_id, run.run_id, run_progress(run).model_dump(), revision)
        except Exception as exc:  # noqa: BLE001 (realtime is advisory)
            logger.debug("case.runbook frame not published: %s", exc)


def _ledger_row(run: RunbookRun) -> RunbookLedgerRow:
    required_total = sum(1 for step in run.snapshot.steps if step.required)
    skipped: list[str] = []
    durations: dict[str, int] = {}
    if run.status == "completed":
        for step in run.snapshot.steps:
            st = _step_state(run, step.id)
            if st.status == "not_applicable":
                skipped.append(step.id)
            elif st.status == "done" and st.started_at and st.completed_at:
                seconds = _seconds_between(st.started_at, st.completed_at)
                if seconds is not None:
                    durations[step.id] = seconds
    return RunbookLedgerRow(
        run_id=run.run_id, case_id=run.case_id, runbook_id=run.runbook_id, version=run.version,
        attached_by=run.attached_by, started_at=run.attached_at or iso_now(),
        completed_at=run.completed_at, status=run.status, total=len(run.snapshot.steps),
        required_total=required_total, skipped_step_ids=skipped, step_durations=durations,
    )


def _seconds_between(start: str, end: str) -> int | None:
    try:
        a = datetime.fromisoformat(start.replace("Z", "+00:00"))
        b = datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError:
        return None
    if a.tzinfo is None:
        a = a.replace(tzinfo=timezone.utc)
    if b.tzinfo is None:
        b = b.replace(tzinfo=timezone.utc)
    seconds = int((b - a).total_seconds())
    return seconds if seconds > 0 else None


async def _write_ledger(stack: _Stack, run: RunbookRun) -> None:
    """The month ledger row of a run-level transition. A derived projection for the
    metrics: a failure is logged (the metrics read the month as it is), never turned
    into a failure of the person's change, which is saved and audited already."""
    try:
        await stack.runs.upsert_ledger_row(_ledger_row(run))
    except Exception as exc:  # noqa: BLE001
        logger.warning("runbook ledger row for run %s not written: %s", run.run_id[:80], exc)


ChangeFn = Callable[[list[RunbookRun]], tuple[list[RunbookRun] | None, Any]]


class _NoLongerApplies(Exception):
    """The change the pre-check approved had nothing left to do when the store wrote
    (another writer, in another process, got there first). The action row is already
    appended, so the write fails with this reason and ``audited_write`` appends the
    failure row: the trail never shows a change that did not happen."""

    def __init__(self, result: Any) -> None:
        super().__init__("Another change got there first; nothing was changed.")
        self.result = result
        self.detail = {"code": "no_change", "message": "Another change got there first; nothing was changed."}


async def _audited_runs_write(
    stack: _Stack,
    *,
    case: Any,
    action: str | Callable[[Any], str],
    actor: str,
    actor_type: str,
    context: Any,
    change: ChangeFn,
    result_summary: str,
    tool_input: Any = None,
    changes: Sequence[AuditChange] | Callable[[Any], Sequence[AuditChange]] | None = None,
    frame_runs: Callable[[Any, CaseRuns], Iterable[RunbookRun]] | None = None,
) -> tuple[Any, CaseRuns, bool]:
    """Apply ``change`` to the case's runs audit-first (§3.6).

    ``change`` receives copies of the stored runs and returns ``(new_runs, result)``
    (``new_runs is None`` = nothing to change). It runs once on a fresh read as the
    pre-check (a refusal writes no row) and again inside the store's compare-and-set
    write. ``action`` and ``changes`` may be functions of the pre-check's ``result``,
    so the row names exactly what the change does (every status, assignee and note
    change with its before and after). Returns ``(result, case_runs, written)``;
    nothing is audited or published when nothing changed, and a change that had
    nothing left to do when the store wrote is answered as not written (its action
    row is followed by a failure row)."""
    case_id = str(case.case_id)
    try:
        current = await stack.runs.get(case_id)
        proposed, result = change([r.model_copy(deep=True) for r in current.runs])
        if proposed is None:
            return result, current, False
        check_case_runs(proposed, case_id)
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    except _StepConflict as exc:
        raise _conflict_error(exc.current) from exc
    except ValueError as exc:
        raise _state_error(str(exc)) from exc
    row_action = action(result) if callable(action) else action
    row_changes = list(changes(result) if callable(changes) else (changes or []))

    def _write_change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, Any]:
        new_runs, res = change(runs)
        if new_runs is None:
            raise _NoLongerApplies(res)
        return new_runs, res

    async def _write() -> tuple[Any, CaseRuns]:
        return await stack.runs.mutate(case_id, _write_change)

    def _after(outcome: tuple[Any, CaseRuns]) -> None:
        res, case_runs = outcome
        runs = list(frame_runs(res, case_runs)) if frame_runs is not None else list(case_runs.runs)
        _publish_frames(stack, case_id, runs, case_runs.revision)

    try:
        result, case_runs = await audited_write(
            None,
            sink=stack.audit,
            action=row_action,
            target=_target(case),
            expected_revision=current.revision,
            changes=row_changes or None,
            write=_write,
            action_type=ActionType.RUNBOOK,
            actor=actor,
            actor_type=actor_type,
            surface=_AUDIT_SURFACE,
            context=context,
            case_id=case_id,
            result_summary=result_summary,
            tool_input=tool_input,
            after_write=_after,
        )
    except _NoLongerApplies as exc:
        try:
            latest = await stack.runs.get(case_id)
        except _STORE_ERRORS as read_exc:
            raise map_store_error(read_exc) from read_exc
        return exc.result, latest, False
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    except _StepConflict as exc:
        raise _conflict_error(exc.current) from exc
    return result, case_runs, True


async def _record_follow_up(
    stack: _Stack, *, case: Any, action: str, actor: str, actor_type: str, context: Any,
    result_summary: str, tool_input: Any = None,
) -> None:
    """A consequence row of a write that is already saved and audited (a run that
    completed, an approval a recorded action now waits for). Strict append, but a
    failure is only logged: the change itself has its row."""
    try:
        await stack.audit.record_strict(
            action_type=ActionType.RUNBOOK, surface=_AUDIT_SURFACE, actor=actor,
            actor_type=actor_type, action=action, outcome="success", case_id=str(case.case_id),
            target=_target(case), result_summary=result_summary, tool_input=tool_input,
            actor_role=_context_value(context, "actor_role"), client=_context_value(context, "client"),
            session_ref=_context_value(context, "session_ref"),
            request_id=_request_id(context),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("runbook follow-up audit row %s not written: %s", action, exc)


def _context_value(context: Any, name: str) -> Any:
    if context is None:
        return None
    if isinstance(context, Mapping):
        return context.get(name)
    return getattr(context, name, None)


def _request_id(context: Any) -> str | None:
    value = _context_value(context, "request_id")
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._-]{8,64}", value) else None


# --------------------------------------------------------------------------- #
# Attachment (§4.10.4)
# --------------------------------------------------------------------------- #
def _source_types(prefs: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for source in getattr(prefs, "sources", None) or []:
        value = getattr(getattr(source, "source_type", None), "value", getattr(source, "source_type", None))
        if getattr(source, "id", None) and value:
            out[str(source.id)] = str(value)
    return out


def case_facts(case: Any, prefs: Any) -> CaseFacts:
    """The facts a case gives the matcher (live prefs, so the severity band is read on
    the source's own ladder, A3's hand-off)."""
    return case_facts_from_case(case, prefs=prefs, source_types=_source_types(prefs))


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def attachment_blocked(case: Any, *, now: datetime | None = None) -> str | None:
    """Why a case gets no run automatically, or ``None`` when it needs a person:
    ``"status"`` (a candidate or a terminal case) or ``"pending_auto_close"`` (an
    automatic close still inside its objection window; if a person reopens or
    escalates it, that action's re-evaluation attaches then)."""
    status = getattr(getattr(case, "status", None), "value", getattr(case, "status", None))
    decision_by = getattr(getattr(case, "decision_by", None), "value", getattr(case, "decision_by", None))
    expires = _parse_iso(getattr(case, "objection_window_expires_at", None))
    if decision_by == DecisionBy.AGENT.value and expires is not None and expires > (now or now_utc()):
        if status in _TERMINAL_CASE_STATUSES:
            return "pending_auto_close"
    if str(status or "") not in ATTACHABLE_STATUSES:
        return "status"
    return None


def _existing_tier(run: RunbookRun) -> int:
    """The specificity a run already on the case stands for. A runbook a person (or a
    person accepting the AI's suggestion) chose counts as the most specific, so
    automation never stacks a runbook on top of a person's choice."""
    if run.attached_by in ("person", "suggestion"):
        return 3
    try:
        return int((run.attached_reason or {}).get("tier", 0))
    except (TypeError, ValueError):
        return 0


@dataclass(frozen=True)
class AttachmentPlan:
    entry: MatchableRunbook
    explanation: MatchExplanation
    tied: int = 0

    @property
    def tier(self) -> int:
        return self.explanation.tier


def plan_attachment(
    facts: CaseFacts, catalog: RunbookCatalog, existing: Sequence[RunbookRun], *, fallback: bool,
) -> AttachmentPlan | None:
    """Pure: the runbook automatic attachment adds to a case, or ``None``.

    The winner of :func:`runbook_match.match` attaches when the case has no run; with
    runs on the case it attaches only when its tier is higher than every run already
    there (never the fallback, which attaches only to a case with no run), and never
    a runbook the case already has, even an abandoned run of it (#4)."""
    result = match(facts, catalog.matchable, fallback=fallback)
    if result.winner is None or result.explanation is None:
        return None
    winner, explanation = result.winner, result.explanation
    if any(run.runbook_id == winner.id for run in existing):
        return None
    if existing:
        if explanation.tier == 0:
            return None
        if explanation.tier <= max(_existing_tier(run) for run in existing):
            return None
    return AttachmentPlan(entry=winner, explanation=explanation, tied=len(result.tied))


async def reevaluate_case(
    state: Any, case: Any, *, trigger: str, actor: str = RUNBOOK_SELECTOR_ACTOR,
) -> RunbookRun | None:
    """Attach the matching runbook to ``case`` when it needs a person (the second
    evaluation after the verdict, D43). Called after a pipeline decision (A8a), a
    status move, a tag change, a reopen or escalation (single, bulk and job paths) and
    by Demo seeding. Never raises: a refusal is logged and the caller's change stands.
    Returns the run attached, or ``None``."""
    try:
        return await _reevaluate(state, case, trigger=trigger, actor=actor)
    except Exception as exc:  # noqa: BLE001 (attachment never fails the caller)
        logger.warning("runbook attachment for case %s (%s) skipped: %s",
                       str(getattr(case, "case_id", ""))[:80], trigger, exc)
        return None


async def _reevaluate(state: Any, case: Any, *, trigger: str, actor: str) -> RunbookRun | None:
    stack = _bind_stack(state)
    cfg = getattr(stack.prefs, "runbooks", None)
    if cfg is None or not (cfg.enabled and cfg.auto_attach):
        return None
    if case is None or attachment_blocked(case) is not None:
        return None
    catalog = await load_catalog(state)
    facts = case_facts(case, stack.prefs)
    fallback = bool(cfg.fallback)
    # One attachment at a time per case in this process: the plan is made on the runs
    # as they are once the lock is held, so two triggers at once (the pipeline and a
    # person's reopen) never stack two runbooks the tier rule allows only one of.
    async with _attach_lock(stack, str(case.case_id)):
        try:
            existing = await stack.runs.get(str(case.case_id))
        except _STORE_ERRORS as exc:
            raise map_store_error(exc) from exc
        plan = plan_attachment(facts, catalog, existing.runs, fallback=fallback)
        if plan is None:
            return None

        def admit(runs: Sequence[RunbookRun]) -> bool:
            # The same rule again on the runs the store holds at write time (another
            # process may have attached in between).
            again = plan_attachment(facts, catalog, runs, fallback=fallback)
            return again is not None and again.entry.id == plan.entry.id

        attached_by = "fallback" if plan.tier == 0 else "rule"
        reason = plan.explanation.model_dump(mode="json")
        summary = describe_explanation(plan.explanation, tied=plan.tied)
        run, already, _case_runs = await _attach(
            state, stack, case, plan.entry, attached_by=attached_by, attached_reason=reason,
            actor=actor, actor_type="system", context=None,
            result_summary=f"Runbook {plan.entry.title} v{plan.entry.version} attached. {summary}",
            tool_input={"trigger": trigger, "tier": plan.tier}, admit=admit,
        )
    return None if already else run


#: Per case (and per run store, so real and Demo never share one), the lock that makes
#: attachments in this process one at a time. Weak values: a lock exists only while an
#: attachment holds or awaits it.
_ATTACH_LOCKS: "weakref.WeakValueDictionary[tuple[int, str], asyncio.Lock]" = weakref.WeakValueDictionary()


def _attach_lock(stack: _Stack, case_id: str) -> asyncio.Lock:
    key = (id(stack.runs), case_id)
    lock = _ATTACH_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _ATTACH_LOCKS[key] = lock
    return lock


async def _attach(
    state: Any, stack: _Stack, case: Any, entry: MatchableRunbook, *, attached_by: str,
    attached_reason: dict[str, Any], actor: str, actor_type: str, context: Any,
    result_summary: str, tool_input: dict[str, Any] | None = None,
    admit: Callable[[Sequence[RunbookRun]], bool] | None = None,
) -> tuple[RunbookRun | None, bool, CaseRuns]:
    """Attach ``entry`` to ``case`` (idempotent per case and runbook, #4). Returns
    ``(run, already_attached, case_runs)``: the existing run of the runbook when the
    case already has one, ``(None, True, ...)`` when ``admit`` (the automatic tier
    rule) no longer allows it. Only a new run is ledgered and gets its ``on_attach``
    lookups, so a lost race never runs them twice. The caller holds the case's
    attach lock."""
    now = iso_now()
    run = _new_run(str(case.case_id), entry, attached_by=attached_by, attached_reason=attached_reason,
                   actor=actor, now=now)

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, RunbookRun | None]:
        existing = next((r for r in runs if r.runbook_id == entry.id), None)
        if existing is not None:
            return None, existing
        if admit is not None and not admit(runs):
            return None, None
        if len(runs) >= MAX_RUNS_PER_CASE:
            raise RunLimitReached()
        return [*runs, run.model_copy(deep=True)], run

    info = {"run_id": run.run_id, "runbook_id": entry.id, "version": entry.version,
            "attached_by": attached_by, **(tool_input or {})}
    result, case_runs, written = await _audited_runs_write(
        stack, case=case, action="run.attached", actor=actor, actor_type=actor_type,
        context=context, change=change, result_summary=result_summary, tool_input=info,
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run.run_id],
    )
    if not written:
        # Already there (the existing run), or no longer admitted (nothing).
        existing = next((r for r in case_runs.runs if r.runbook_id == entry.id), None)
        return existing, True, case_runs
    stored = case_runs.run(run.run_id) or run
    await _write_ledger(stack, stored)
    schedule_on_attach_lookups(state, stack, case, stored)
    return stored, False, case_runs


async def attach_by_person(
    state: Any, case: Any, runbook_id: str, *, note: str | None, actor: str, context: Any,
) -> RunbookAttachResult:
    """"Start runbook" (``POST /api/cases/{case_id}/runbooks``): any published runbook.
    Idempotent: an existing run of the runbook answers ``already_attached``. When the
    AI suggested this runbook for this case within the hour, the run records it as
    "Suggested by the AI, accepted by <person>"."""
    stack = _bind_stack(state)
    cfg = getattr(stack.prefs, "runbooks", None)
    if cfg is not None and not cfg.enabled:
        raise _state_error("Runbooks are turned off in Settings.")
    try:
        catalog = await load_catalog(state)
    except RunbookStoreUnavailable as exc:
        raise map_store_error(exc) from exc
    entry = catalog.published(runbook_id)
    if entry is None:
        if await _library_has(state, runbook_id):
            raise _state_error("Only a published runbook can be started.")
        raise RunbookRunError(404, "runbook_not_found", "That runbook does not exist.")
    suggestion = _recalled_suggestion(state, str(case.case_id), actor)
    accepted = suggestion is not None and suggestion[0] == entry.id
    clean_note = (note or "").strip() or None
    reason: dict[str, Any] = {"by": actor, "note": clean_note}
    if accepted:
        reason["suggestion"] = {"reason": suggestion[1]}
    async with _attach_lock(stack, str(case.case_id)):
        run, already, case_runs = await _attach(
            state, stack, case, entry, attached_by="suggestion" if accepted else "person",
            attached_reason=reason, actor=actor, actor_type="human", context=context,
            result_summary=(f"Runbook {entry.title} v{entry.version} started by hand"
                            + (" (suggested by the AI)" if accepted else "") + "."),
        )
    if accepted and not already:
        _forget_suggestion(state, str(case.case_id), actor)
    if run is None:  # pragma: no cover (a person's attach has no tier rule to refuse it)
        raise RunbookRunError(503, "runbook_store_unavailable", "The runbook could not be started. Try again.")
    return RunbookAttachResult(
        already_attached=already, run=run, progress=run_progress(run), revision=case_runs.revision,
    )


async def attach_by_automation(
    state: Any, case: Any, runbook_id: str | None, *, rule_id: str = "", actor: str = "threshold_automation",
) -> RunbookRun | None:
    """A ``run_playbook`` automation rule attaches a runbook ($0, SPEC §4.10.16). The
    caller resolves the target at fire time; a target that is missing, unknown, a
    Draft or retired is skipped with ``run.attach_skipped`` (reason), and so is any
    target while runbooks are off or on a case that does not need a person (the
    attachment rule of §4.10.4: a candidate, a closed case, an automatic close in its
    objection window). Idempotent per case and runbook. Returns the run it attached,
    or ``None`` (skipped, or the case already has that runbook). Never raises."""
    stack = _bind_stack(state)
    try:
        reason: str | None = None
        entry: MatchableRunbook | None = None
        cfg = getattr(stack.prefs, "runbooks", None)
        blocked = attachment_blocked(case)
        if cfg is not None and not cfg.enabled:
            reason = "Runbooks are turned off in Settings."
        elif blocked is not None:
            # The rule that attaches by matching applies here too: a case that does not
            # need a person (a candidate, a closed case, an automatic close in its
            # objection window) never gets a run.
            reason = AUTOMATION_SKIP_REASONS[blocked]
        elif not runbook_id:
            reason = "The rule names no runbook."
        else:
            catalog = await load_catalog(state)
            entry = catalog.published(runbook_id)
            if entry is None:
                reason = ("The runbook is not published." if await _library_has(state, runbook_id)
                          else "The runbook does not exist.")
        if entry is None:
            await _record_follow_up(
                stack, case=case, action="run.attach_skipped", actor=actor, actor_type="system",
                context=None, result_summary=f"No runbook attached: {reason}",
                tool_input={"runbook_id": (runbook_id or "")[:64], "rule_id": rule_id[:128], "reason": reason},
            )
            return None
        async with _attach_lock(stack, str(case.case_id)):
            run, already, _cr = await _attach(
                state, stack, case, entry, attached_by="rule",
                attached_reason={"automation_rule": rule_id[:128], "tier": 3},
                actor=actor, actor_type="system", context=None,
                result_summary=f"Runbook {entry.title} v{entry.version} attached by an automation rule.",
                tool_input={"rule_id": rule_id[:128]},
            )
        return None if already else run
    except Exception as exc:  # noqa: BLE001 (automation never fails on a runbook)
        logger.warning("automation runbook attach for case %s skipped: %s",
                       str(getattr(case, "case_id", ""))[:80], exc)
        return None


# --------------------------------------------------------------------------- #
# Reading a case's runs
# --------------------------------------------------------------------------- #
def redact_lookup(result: LookupResult, allows: Callable[[str, str], bool]) -> LookupResult:
    """``result`` for a viewer: unchanged with the tool's grant, else the access
    sentence in ``reason`` and no parameters, count, facts or table (§4.8). The
    status is ``not_applicable`` and the clamp flag cleared whatever the lookup found,
    so a redacted result never tells the viewer whether matching data exists (``ok``
    versus ``empty``) or whether the lookup failed: every redacted result of a tool
    reads the same."""
    grant = LOOKUP_TOOL_GRANTS.get(result.tool, ("runbooks", "read"))
    if allows(*grant):
        return result
    return result.model_copy(update={
        "params": {}, "count": None, "count_relation": "eq", "facts": [], "table": None,
        "table_kind": None, "reason": NO_ACCESS_SENTENCES[grant], "status": "not_applicable",
        "window_clamped": False,
    })


def redact_run(run: RunbookRun, allows: Callable[[str, str], bool]) -> RunbookRun:
    """A run as one viewer may see it: every stored lookup result is redacted by the
    grant its tool needs; steps, statuses and notes are left as they are."""
    steps: dict[str, StepState] = {}
    changed = False
    for step_id, st in run.steps.items():
        evidence: list[StepEvidence] = []
        for item in st.evidence:
            if item.kind == "lookup_result" and item.lookup is not None:
                redacted = redact_lookup(item.lookup, allows)
                if redacted is not item.lookup:
                    changed = True
                    item = item.model_copy(update={"lookup": redacted})
            evidence.append(item)
        steps[step_id] = st.model_copy(update={"evidence": evidence})
    return run.model_copy(update={"steps": steps}) if changed else run


async def case_runbooks_view(state: Any, case: Any, allows: Callable[[str, str], bool]) -> dict[str, Any]:
    """The ``CaseRunbooks`` payload for one viewer."""
    stack = _bind_stack(state)
    try:
        case_runs = await stack.runs.get(str(case.case_id))
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    newer: dict[str, int] = {}
    if case_runs.runs:
        try:
            catalog = await load_catalog(state)
        except RunbookStoreUnavailable:
            catalog = None
        if catalog is not None:
            for run in case_runs.runs:
                live = catalog.published(run.runbook_id)
                if live is not None and live.version > run.version:
                    newer[run.run_id] = live.version
    tasks: list[Any] = []
    task_store = getattr(state, "case_tasks", None)
    if task_store is not None:
        try:
            tasks = list(await task_store.list_for_case(str(case.case_id)))
        except Exception as exc:  # noqa: BLE001 (other tasks are a side list)
            logger.warning("case tasks for %s unavailable: %s", str(case.case_id)[:80], exc)
    return {
        "runs": [redact_run(run, allows) for run in case_runs.runs],
        "progress": {run.run_id: run_progress(run) for run in case_runs.runs},
        "newer_versions": newer,
        "other_tasks": tasks,
        "revision": case_runs.revision,
    }


def _update_payload(case_runs: CaseRuns, run_id: str, allows: Callable[[str, str], bool] | None) -> RunbookRunUpdate:
    run = case_runs.run(run_id)
    if run is None:
        raise map_store_error(RunNotFound(run_id))
    shown = redact_run(run, allows) if allows is not None else run
    return RunbookRunUpdate(run=shown, progress=run_progress(run), revision=case_runs.revision)


async def latest_update(state: Any, case_id: str, run_id: str, allows: Callable[[str, str], bool]) -> RunbookRunUpdate | None:
    """The run as it is now (sent with a ``409 runbook_conflict``), or ``None``."""
    try:
        case_runs = await state.runbook_runs.get(case_id)
    except Exception:  # noqa: BLE001
        return None
    if case_runs.run(run_id) is None:
        return None
    return _update_payload(case_runs, run_id, allows)


# --------------------------------------------------------------------------- #
# Steps (§4.10.3, §4.10.7)
# --------------------------------------------------------------------------- #
def _approval_needed(step: RunbookStep, prefs: Any) -> bool:
    cfg = getattr(prefs, "runbooks", None)
    return bool(step.approval_role) and bool(getattr(cfg, "step_approvals", False)) and step.kind in ("action", "record")


def _evidence_ok(step: RunbookStep, st: StepState) -> bool:
    if step.evidence == "note":
        return bool(st.note.strip())
    if step.evidence == "note_or_attachment":
        return bool(st.note.strip()) or bool(st.evidence)
    return True


def _mark_started(st: StepState, now: str) -> None:
    if st.started_at is None:
        st.started_at = now


def _complete(st: StepState, actor: str, now: str) -> None:
    st.status = "done"
    st.completed_at = now
    st.completed_by = actor
    st.reason = None


@dataclass
class _StepOutcome:
    run_id: str
    action: str
    changes: list[AuditChange]
    run_transition: str | None
    approval_requested: bool
    first_activity: bool


def _apply_step_update(
    runs: list[RunbookRun], *, run_id: str, step_id: str, body: RunbookStepUpdate, fields: frozenset[str],
    actor: str, now: str, prefs: Any,
) -> tuple[list[RunbookRun], _StepOutcome]:
    run = _find_run(runs, run_id)
    if run.status == "abandoned":
        raise _state_error("This runbook was abandoned, so its steps cannot change.")
    step = _find_step(run, step_id)
    st = run.steps.get(step_id) or StepState()
    if st.revision != body.expected_revision:
        raise _StepConflict(st.revision)
    before = st.model_copy(deep=True)
    untouched_before = _run_untouched(run)
    changes: list[AuditChange] = []
    action = "step.updated"
    approval_requested = False
    path = f"steps.{step_id}"

    if "assignee" in fields:
        assignee = (body.assignee or "").strip() or None
        if assignee != st.assignee:
            changes.append(AuditChange(field=f"{path}.assignee", before=_audit_text(st.assignee),
                                       after=_audit_text(assignee)))
            st.assignee = assignee
    if body.note is not None and body.note != st.note:
        changes.append(AuditChange(field=f"{path}.note", before=_audit_text(st.note) or None,
                                   after=_audit_text(body.note) or None))
        st.note = body.note
        _mark_started(st, now)
    if body.evidence_link is not None:
        if len(st.evidence) >= RUNBOOK_STEP_MAX_EVIDENCE:
            raise _step_error(f"A step holds at most {RUNBOOK_STEP_MAX_EVIDENCE} pieces of evidence.")
        link = body.evidence_link
        if not link.url and not (link.label or "").strip():
            raise _step_error("Give a link or a ticket reference.")
        st.evidence = [*st.evidence, StepEvidence(kind=link.kind, url=link.url, label=(link.label or "").strip() or None)]
        changes.append(AuditChange(field=f"{path}.evidence", before=None,
                                   after=_audit_text(_url_host(link.url) or (link.label or "").strip())))
    if body.decision is not None:
        if step.kind != "decision":
            raise _step_error("Only a Decision step records a decision.")
        option = next((o for o in step.options if o.id == body.decision.option_id), None)
        if option is None:
            raise _step_error("That option is not one of this decision's options.")
        if st.status == "done" and isinstance(st.decision, dict):
            raise _step_error("This decision is already recorded. Reopen the step to change it.")
        st.decision = {"option_id": option.id, "label": option.label, "by": actor, "at": now}
        _mark_started(st, now)
        _complete(st, actor, now)
        changes.append(AuditChange(field=f"{path}.decision", before=None, after=_audit_text(option.label)))
        skipped_reason = f"Skipped by the decision '{option.label}'"
        later = {s.id for s in ordered_steps(run.snapshot)[ordered_steps(run.snapshot).index(step) + 1:]}
        for target_id in option.marks_not_applicable:
            if target_id not in later:
                continue
            target_state = run.steps.get(target_id) or StepState()
            if target_state.status != "todo":
                continue
            target_state.status = "not_applicable"
            target_state.reason = skipped_reason[:500]
            target_state.completed_at = now
            target_state.completed_by = actor
            target_state.revision += 1
            run.steps[target_id] = target_state
            changes.append(AuditChange(field=f"steps.{target_id}.status", before="todo", after="not_applicable"))
        action = "step.decision_recorded"
    if body.action_record is not None:
        if step.kind not in ("action", "record"):
            raise _step_error("Only an Action or Record step records an action.")
        if _waiting(st):
            raise _step_error("This step already waits for approval.")
        if st.status == "done":
            raise _step_error("This step is done. Reopen it to record the action again.")
        record = body.action_record
        st.action_record = {
            "performed_by": actor,
            "performed_at": _performed_at(record.performed_at, now),
            "where": record.where.strip(),
            "outcome": record.outcome.strip(),
        }
        _mark_started(st, now)
        changes.append(AuditChange(field=f"{path}.action_record",
                                   before=_audit_text(_record_label(before.action_record)),
                                   after=_audit_text(_record_label(st.action_record))))
        if _approval_needed(step, prefs):
            st.approval = {"required_role": step.approval_role, "status": "pending",
                           "by": None, "at": None, "reason": None}
            st.status = "in_progress"
            approval_requested = True
        else:
            st.approval = None
            _complete(st, actor, now)
        action = "step.action_recorded"
    if body.status is not None and body.status != st.status:
        target = body.status
        reason = (body.reason or "").strip()
        if target == "done":
            if step.kind == "decision":
                raise _step_error("Record a decision to finish this step.")
            if _waiting(st):
                raise _step_error(_WAITING_MESSAGE)
            if _approval_needed(step, prefs) and not (isinstance(st.approval, dict)
                                                      and st.approval.get("status") == "approved"):
                raise _step_error("Record the action first; a second person approves it.")
            if not _evidence_ok(step, st):
                raise _step_error(_NOTE_EMPTY_MESSAGE if step.evidence == "note"
                                  else "Add a note or evidence before marking this step done.")
            _mark_started(st, now)
            _complete(st, actor, now)
        elif target in ("not_applicable", "blocked"):
            if not reason:
                raise _step_error("Give a reason.")
            if target == "not_applicable":
                # D35: a recorded action waiting for a second person is decided by an
                # approver; marking it Not applicable would finish the step without
                # that approval (whoever asks, the recorder included).
                if _waiting(st):
                    raise _step_error(_WAITING_MESSAGE)
                st.completed_at = now
                st.completed_by = actor
                st.approval = None
            else:
                st.completed_at = None
                st.completed_by = None
                _mark_started(st, now)
            st.status = target
            st.reason = reason[:500]
        elif target == "in_progress":
            if st.status in _FINISHED_STEP:
                raise _step_error("Reopen the step first.")
            st.status = "in_progress"
            st.reason = None
            _mark_started(st, now)
        elif target == "todo":
            st.status = "todo"
            st.completed_at = None
            st.completed_by = None
            st.reason = None
            if step.kind == "decision":
                st.decision = None
            if step.kind in ("action", "record"):
                st.action_record = None
                st.approval = None
        if target in ("not_applicable", "blocked"):
            changes.append(AuditChange(field=f"{path}.reason", before=_audit_text(before.reason),
                                       after=_audit_text(st.reason)))
        if before.action_record is not None and st.action_record is None:
            changes.append(AuditChange(field=f"{path}.action_record",
                                       before=_audit_text(_record_label(before.action_record)), after=None))
        if before.decision is not None and st.decision is None:
            changes.append(AuditChange(field=f"{path}.decision",
                                       before=_audit_text((before.decision or {}).get("label")), after=None))
    elif body.reason is not None and st.status in ("not_applicable", "blocked"):
        reason = body.reason.strip()
        if not reason:
            raise _step_error("Give a reason.")
        if reason != st.reason:
            changes.append(AuditChange(field=f"{path}.reason", before=_audit_text(st.reason), after=_audit_text(reason)))
            st.reason = reason[:500]

    # Whatever moved the step (a status, a decision or a recorded action), the row
    # names the status and the approval with their before and after (§4.10.15): a
    # pending or decided approval a change drops (Not applicable, a reopen to To do)
    # is on the trail as well as the one a recorded action requests.
    if st.status != before.status:
        changes.append(AuditChange(field=f"{path}.status", before=before.status, after=st.status))
    if _approval_status(st) != _approval_status(before):
        changes.append(AuditChange(field=f"{path}.approval", before=_approval_status(before),
                                   after=_approval_status(st)))
    if not changes:
        return runs, _StepOutcome(run_id, "none", [], None, False, False)
    st.revision = before.revision + 1
    run.steps[step_id] = st
    run.revision += 1
    transition = _refresh_completion(run, now)
    first = untouched_before and not _run_untouched(run)
    return runs, _StepOutcome(run_id, action, changes, transition, approval_requested, first)


def _record_label(record: Any) -> str | None:
    """What an audit row names a recorded action by: where, else the outcome."""
    if not isinstance(record, dict):
        return None
    return (str(record.get("where") or "").strip() or str(record.get("outcome") or "").strip()) or None


def _performed_at(value: str | None, now: str) -> str:
    """The time a person says the recorded action happened, as a UTC ISO timestamp.
    Absent means now; a value that is not a date and time, or that lies in the future
    (beyond a small clock skew), is refused (``409 step_state``). So is a time that
    cannot be expressed in UTC at all (``0001-01-01T00:00:00+05:00`` falls before the
    first representable instant), which would otherwise surface as an unhandled
    ``OverflowError``."""
    text = (value or "").strip()
    if not text:
        return now
    moment = _parse_iso(text)
    if moment is None:
        raise _step_error(_PERFORMED_AT_MESSAGE)
    try:
        stamped = lookups.iso_utc(moment)
    except (OverflowError, ValueError):
        raise _step_error(_PERFORMED_AT_MESSAGE) from None
    if moment > now_utc() + _ACTION_TIME_SKEW:
        raise _step_error(_PERFORMED_AT_MESSAGE)
    return stamped


async def update_step(
    state: Any, case: Any, run_id: str, step_id: str, body: RunbookStepUpdate, *,
    actor: str, context: Any, allows: Callable[[str, str], bool] | None = None,
) -> RunbookRunUpdate:
    """``PATCH .../steps/{step_id}``: status, assignee, note, reason, a decision, a
    recorded action or an evidence link. ``body.expected_revision`` is the STEP's
    revision as the person read it: a stale one is ``409 runbook_conflict`` and is
    never retried; a background lookup on the step, or a change to another step, never
    conflicts with it."""
    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    fields = frozenset(body.model_fields_set)
    now = iso_now()

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, _StepOutcome]:
        new_runs, outcome = _apply_step_update(
            runs, run_id=run_id, step_id=step_id, body=body, fields=fields, actor=actor, now=now,
            prefs=stack.prefs,
        )
        return (None if outcome.action == "none" else new_runs), outcome

    outcome, case_runs, written = await _audited_runs_write(
        stack, case=case, action=lambda res: res.action, actor=actor, actor_type="human",
        context=context, change=change, changes=lambda res: res.changes,
        result_summary=f"Runbook step {step_id[:64]} updated.",
        tool_input={"run_id": run_id, "step_id": step_id},
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run_id],
    )
    if written:
        await _after_step_write(stack, case, case_runs, outcome, actor=actor, context=context)
    return _update_payload(case_runs, run_id, allows)


async def _after_step_write(
    stack: _Stack, case: Any, case_runs: CaseRuns, outcome: _StepOutcome, *, actor: str, context: Any,
) -> None:
    run = case_runs.run(outcome.run_id)
    if run is None:
        return
    if outcome.approval_requested:
        await _record_follow_up(
            stack, case=case, action="step.approval_requested", actor=actor, actor_type="human",
            context=context, result_summary="A recorded action waits for a second person's approval.",
            tool_input={"run_id": run.run_id},
        )
    if outcome.first_activity:
        await _record_follow_up(
            stack, case=case, action="run.started", actor=actor, actor_type="human", context=context,
            result_summary=f"Work started on runbook {run.title}.", tool_input={"run_id": run.run_id},
        )
    if outcome.run_transition == "completed":
        await _record_follow_up(
            stack, case=case, action="run.completed", actor=actor, actor_type="human", context=context,
            result_summary=f"Runbook {run.title} completed: every required step is done or not applicable.",
            tool_input={"run_id": run.run_id},
        )
    if outcome.run_transition is not None:
        await _write_ledger(stack, run)


def _require_enabled(prefs: Any) -> None:
    cfg = getattr(prefs, "runbooks", None)
    if cfg is not None and not cfg.enabled:
        raise _state_error("Runbooks are turned off in Settings.")


async def decide_approval(
    state: Any, case: Any, run_id: str, step_id: str, *, decision: str, reason: str | None,
    actor: str, context: Any, allows: Callable[[str, str], bool] | None = None,
) -> RunbookRunUpdate:
    """Approve or reject a recorded action waiting for approval. The person who
    recorded the action can never approve it (``403 runbook_distinct_approver``); the
    route has already checked the step's ``approval_role``."""
    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    now = iso_now()
    clean_reason = (reason or "").strip() or None

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, _StepOutcome]:
        run = _find_run(runs, run_id)
        if run.status == "abandoned":
            raise _state_error("This runbook was abandoned, so its steps cannot change.")
        _find_step(run, step_id)
        st = run.steps.get(step_id) or StepState()
        if not _waiting(st):
            raise _step_error("This step is not waiting for approval.")
        recorder = (st.action_record or {}).get("performed_by")
        if decision == "approve" and _same_person(recorder, actor):
            role = str((st.approval or {}).get("required_role") or "approver")
            raise RunbookRunError(403, "runbook_distinct_approver",
                                  f"Only a {role} other than {recorder} can approve.")
        untouched_before = _run_untouched(run)
        prior_status = st.status
        approval = dict(st.approval or {})
        approval.update(by=actor, at=now, reason=clean_reason)
        if decision == "approve":
            approval["status"] = "approved"
            st.approval = approval
            _complete(st, actor, now)
            action = "step.approved"
        else:
            approval["status"] = "rejected"
            st.approval = approval
            st.status = "in_progress"
            action = "step.rejected"
        path = f"steps.{step_id}"
        changes = [AuditChange(field=f"{path}.approval", before="pending", after=approval["status"])]
        if st.status != prior_status:
            changes.append(AuditChange(field=f"{path}.status", before=prior_status, after=st.status))
        st.revision += 1
        run.steps[step_id] = st
        run.revision += 1
        transition = _refresh_completion(run, now)
        first = untouched_before and not _run_untouched(run)
        return runs, _StepOutcome(run_id, action, changes, transition, False, first)

    action = "step.approved" if decision == "approve" else "step.rejected"
    outcome, case_runs, _written = await _audited_runs_write(
        stack, case=case, action=action, actor=actor, actor_type="human", context=context,
        change=change, changes=lambda res: res.changes,
        result_summary=("Recorded action approved." if decision == "approve" else "Recorded action rejected."),
        tool_input={"run_id": run_id, "step_id": step_id, "reason": clean_reason},
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run_id],
    )
    if _written:
        await _after_step_write(stack, case, case_runs, outcome, actor=actor, context=context)
    return _update_payload(case_runs, run_id, allows)


async def switch_version(
    state: Any, case: Any, run_id: str, version: int, *, actor: str, context: Any,
    allows: Callable[[str, str], bool] | None = None,
) -> RunbookRunUpdate:
    """"Switch to v5": the run moves to the live version, keeping the state of every
    step whose id exists in both versions and resetting the rest."""
    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    now = iso_now()
    try:
        catalog = await load_catalog(state)
        current = await stack.runs.get(str(case.case_id))
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    run_now = current.run(run_id)
    if run_now is None:
        raise map_store_error(RunNotFound(run_id))
    live = catalog.published(run_now.runbook_id)
    if live is None or live.version != version:
        raise _state_error(f"Version {version} is not the published version of this runbook.")

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, dict[str, Any]]:
        run = _find_run(runs, run_id)
        if run.status == "abandoned":
            raise _state_error("This runbook was abandoned.")
        if run.version == live.version:
            return None, {"from": run.version}
        old_ids = {s.id for s in run.snapshot.steps}
        previous = run.version
        steps = {s.id: (run.steps.get(s.id) or StepState()) if s.id in old_ids else StepState()
                 for s in live.definition.steps}
        run.snapshot = live.definition
        run.version = live.version
        run.title = live.definition.title
        run.steps = steps
        run.revision += 1
        transition = _refresh_completion(run, now)
        return runs, {"from": previous, "transition": transition}

    result, case_runs, written = await _audited_runs_write(
        stack, case=case, action="run.version_switched", actor=actor, actor_type="human",
        context=context, change=change,
        changes=[AuditChange(field="version", before=str(run_now.version), after=str(version))],
        result_summary=f"Runbook {run_now.title} switched from v{run_now.version} to v{version}.",
        tool_input={"run_id": run_id, "from": run_now.version, "to": version},
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run_id],
    )
    if written:
        stored = case_runs.run(run_id)
        if stored is not None:
            # The new version can finish the run (its open steps are gone) or reopen it
            # (new required steps): the run-level change gets its own row.
            await _after_step_write(
                stack, case, case_runs,
                _StepOutcome(run_id, "run.version_switched", [], (result or {}).get("transition"), False, False),
                actor=actor, context=context,
            )
            if (result or {}).get("transition") is None:
                await _write_ledger(stack, stored)
    return _update_payload(case_runs, run_id, allows)


async def abandon_run(
    state: Any, case: Any, run_id: str, reason: str, *, actor: str, context: Any,
    allows: Callable[[str, str], bool] | None = None,
) -> RunbookRunUpdate:
    """Abandon a run with a reason. It stays readable and is never removed; the case
    is not changed (#3). Like every other run write it is refused while runbooks are
    turned off in Settings."""
    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    clean = reason.strip()
    if not clean:
        raise _state_error("Give a reason.")

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, None]:
        run = _find_run(runs, run_id)
        if run.status == "abandoned":
            raise _state_error("This runbook is already abandoned.")
        if run.status == "completed":
            raise _state_error("A completed runbook cannot be abandoned.")
        run.status = "abandoned"
        run.abandoned_reason = clean[:500]
        run.revision += 1
        return runs, None

    _result, case_runs, _written = await _audited_runs_write(
        stack, case=case, action="run.abandoned", actor=actor, actor_type="human", context=context,
        change=change, result_summary="Runbook abandoned.",
        changes=[AuditChange(field="status", before="active", after="abandoned")],
        tool_input={"run_id": run_id, "reason": clean[:500]},
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run_id],
    )
    stored = case_runs.run(run_id)
    if stored is not None:
        await _write_ledger(stack, stored)
    return _update_payload(case_runs, run_id, allows)


# --------------------------------------------------------------------------- #
# The close reason (D34)
# --------------------------------------------------------------------------- #
def required_open_in(runs: Iterable[RunbookRun]) -> list[RunbookStepsOpen]:
    """Every required step still open on the case's ACTIVE runs (an abandoned run is
    no longer worked; a completed run has none)."""
    out: list[RunbookStepsOpen] = []
    for run in runs:
        if run.status != "active":
            continue
        for step in ordered_steps(run.snapshot):
            st = _step_state(run, step.id)
            if step.required and st.status not in _FINISHED_STEP:
                out.append(RunbookStepsOpen(run_id=run.run_id, step_id=step.id, title=step.title,
                                            status=st.status))
    return out


async def open_required_steps(state: Any, case_id: str) -> list[RunbookStepsOpen] | None:
    """The required steps still open on a case, or ``None`` when its runs cannot be
    read (a close then proceeds unchanged: closing by hand never blocks, D34)."""
    try:
        case_runs = await state.runbook_runs.get(case_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("runbook steps for case %s unreadable at close: %s", str(case_id)[:80], exc)
        return None
    return required_open_in(case_runs.runs)


async def record_closed_with_open_steps(
    state: Any, case: Any, *, actor: str, via: str, reason: str | None,
    steps: Sequence[RunbookStepsOpen], note: str | None = None, context: Any = None,
) -> None:
    """``case.closed_with_open_steps`` (#2) after a person closed a case with required
    steps open: the reason given (``None`` when none), how (``console``, ``api``,
    ``bulk`` or ``proposal``) and the steps, with the request's audit context (client,
    session, role, request id) when there is one. A runbook event
    (``ActionType.RUNBOOK``, §4.10.15) written to the active execution audit (the
    case's own trail). Best-effort: the close already happened and is audited."""
    audit = getattr(state, "execution_audit", None) or state.audit
    try:
        await audit.record_strict(
            action_type=ActionType.RUNBOOK, surface="case", actor=actor or "analyst",
            actor_type="human", action="case.closed_with_open_steps", outcome="success",
            case_id=str(case.case_id), target=_target(case),
            actor_role=_context_value(context, "actor_role"), client=_context_value(context, "client"),
            session_ref=_context_value(context, "session_ref"), request_id=_request_id(context),
            result_summary=(
                f"Closed with {len(steps)} required runbook "
                f"{'step' if len(steps) == 1 else 'steps'} open"
                + (f" ({note})" if note else "") + "."
            ),
            tool_input={
                "via": via, "reason": reason, "note": note, "required_open": len(steps),
                "steps": [s.model_dump(mode="json") for s in steps[:40]],
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("case.closed_with_open_steps row for %s not written: %s", str(case.case_id)[:80], exc)


# --------------------------------------------------------------------------- #
# Lookups (§4.10.8): execution, storage and redaction
# --------------------------------------------------------------------------- #
def _iso(moment: datetime) -> str:
    return lookups.iso_utc(moment)


def _tz(prefs: Any) -> str:
    return str(getattr(getattr(prefs, "sla", None), "timezone", None) or "UTC")


async def _case_events(state: Any, case: Any) -> list[Any] | None:
    """The case's member events, read-only and bounded, so a lookup binds the case's
    real span and its other entity values (A3's hand-off). ``None`` when they cannot
    be read in time (the binding then uses the stored case values, a lower bound)."""
    from .case_cluster import cluster_for_case

    try:
        cluster = await asyncio.wait_for(
            cluster_for_case(
                case,
                es=getattr(state, "es", None),
                log_source=getattr(state, "log_source", None),
                prefs=state.execution_prefs,
                query_source=state.active_source_for_id(getattr(case, "source_id", None)),
            ),
            timeout=CASE_EVENTS_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001 (lookups degrade to the stored values)
        logger.info("member events for case %s unavailable: %s", str(case.case_id)[:80], exc)
        return None
    return list(getattr(cluster, "member_events", None) or []) if cluster is not None else None


def _upper_iso(binding: lookups.LookupBinding) -> str | None:
    """The window's end for a store or source query. The bound ISO strings carry whole
    seconds, so the end is rounded UP to the next second: a record written in the same
    second as the lookup ran is inside the window, never just past its end."""
    end = getattr(binding, "window_to", None)
    if not isinstance(end, datetime):
        return binding.window_to_iso or None
    if end.microsecond:
        end = end.replace(microsecond=0) + timedelta(seconds=1)
    return lookups.iso_utc(end)


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(v) for v in value[:5])
    text = str(value).replace("\r", " ").replace("\n", " ")
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    limit = RUNBOOK_LOOKUP_TABLE_MAX_CELL_CHARS
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _table(columns: list[str], rows: list[list[Any]]) -> dict[str, Any]:
    cols = [_cell(c) for c in columns[:RUNBOOK_LOOKUP_TABLE_MAX_COLUMNS]]
    body = [[_cell(v) for v in row[: len(cols)]] for row in rows[:RUNBOOK_LOOKUP_TABLE_MAX_ROWS]]
    return {"columns": cols, "rows": body}


def _facts(pairs: Iterable[tuple[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for label, value in pairs:
        if value is None or value == "":
            continue
        out.append({"label": _cell(label), "value": _cell(value)})
        if len(out) >= RUNBOOK_LOOKUP_MAX_FACTS:
            break
    return out


def _n(value: int) -> str:
    return f"{value:,}"


async def execute_lookup(
    state: Any, case: Any, template: LookupTemplate, *, ran_by: str, now: datetime | None = None,
    events: list[Any] | None = None, load_events: bool = True,
) -> LookupResult:
    """Run one lookup for ``case``, read-only, within :data:`LOOKUP_TIMEOUT_S`. Every
    value is bound as a structured parameter (never query text); the result is
    untrusted plain data. A missing case value makes it ``not_applicable``; a timeout or
    a read failure ``error``. Never raises."""
    moment = now or now_utc()
    started = time.monotonic()
    if events is None and load_events:
        # Inside the lookup's own bound: loading the case's member events counts
        # against the 45 seconds (one deadline per lookup, §4.10.8).
        events = await _case_events(state, case)
    values = lookups.case_values_from_case(case, events=events)
    binding = lookups.bind_lookup(template, values, now=moment, tz=_tz(state.execution_prefs))
    base: dict[str, Any] = {"tool": template.tool, "ran_at": _iso(moment), "ran_by": ran_by}
    if isinstance(binding, lookups.LookupNotApplicable):
        return LookupResult(**base, status="not_applicable", reason=binding.reason)
    base.update(params=dict(binding.params), window_from=binding.window_from_iso,
                window_to=binding.window_to_iso, window_clamped=binding.window_clamped)
    remaining = max(0.1, LOOKUP_TIMEOUT_S - (time.monotonic() - started))
    try:
        return await asyncio.wait_for(_dispatch(state, case, binding, base), timeout=remaining)
    except asyncio.TimeoutError:
        return LookupResult(**base, status="error",
                            reason=f"The lookup took longer than {int(LOOKUP_TIMEOUT_S)} seconds, so it stopped.")
    except Exception as exc:  # noqa: BLE001 (a lookup never fails the run)
        logger.warning("runbook lookup %s on case %s failed: %s", template.tool, str(case.case_id)[:80], exc)
        return LookupResult(**base, status="error", reason="The lookup could not run.")


async def _dispatch(state: Any, case: Any, binding: lookups.LookupBinding, base: dict[str, Any]) -> LookupResult:
    tool = binding.tool
    if tool in ("log_stats", "log_search"):
        return await _log_lookup(state, binding, base)
    if tool == "enrich":
        return await _enrich_lookup(state, binding, base)
    if tool == "related_cases":
        return await _related_cases_lookup(state, case, binding, base)
    if tool == "campaign":
        return await _campaign_lookup(state, case, binding, base)
    if tool == "mitre":
        return _mitre_lookup(case, binding, base)
    return LookupResult(**base, status="error", reason="This lookup uses a tool Agentic SOC does not have.")


# ---- log tools ------------------------------------------------------------ #
#: Logical filter names a source compiles natively (``StructuredQuery`` fields).
_NATIVE_FILTERS = ("ip", "user", "host", "rule")
#: The physical path of the projection a browse row carries for a logical name.
_ROW_PROJECTION = {"ip": "source_ip", "user": "user", "host": "host"}


@contextlib.asynccontextmanager
async def _source_connector(state: Any, source_id: str) -> AsyncIterator[Any]:
    """The read-only query connector of one source (the chat resolver: per-source
    TLS, management key dropped, Demo adapters in Demo Mode), or ``None``. An owned
    client is always closed."""
    owned = None
    conn = None
    try:
        resolved = state.chat_source_connector(source_id)
        if isinstance(resolved, tuple) and len(resolved) == 4:
            conn, owned = resolved[0], resolved[1]
    except Exception:  # noqa: BLE001 (a receiver-only or unknown source has no connector)
        conn = None
    try:
        yield conn
    finally:
        close = getattr(owned, "close", None)
        if callable(close):
            try:
                await close()
            except Exception:  # noqa: BLE001
                pass


def _effective(conn: Any, prefs: Any) -> Any:
    eff = getattr(conn, "_effective_prefs", None)
    if callable(eff):
        try:
            return eff(prefs)
        except Exception:  # noqa: BLE001
            return prefs
    return prefs


def _values(value: Any) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else [value]
    return [str(v) for v in items if v is not None and not isinstance(v, (dict, list, tuple)) and str(v) != ""]


def _row_values(row: Mapping[str, Any], name: str, logical: bool, eff: Any, scale_max: float,
                *, as_level: bool = False) -> list[str]:
    raw = row.get("_raw") if isinstance(row.get("_raw"), dict) else {}
    if not logical:
        return _values(dotted_get(raw, name))
    if name in _ROW_PROJECTION:
        values = _values(row.get(_ROW_PROJECTION[name]))
        if not values and eff is not None:
            from ..connectors.base import aggregate_field

            path = aggregate_field(eff, name)
            values = _values(dotted_get(raw, path)) if path else []
        return values
    if name == "rule":
        values = _values(row.get("rule"))
        if eff is not None:
            for path in (getattr(eff, "rule_field", None), getattr(eff, "rule_name_field", None)):
                if path:
                    values += _values(dotted_get(raw, path))
        return list(dict.fromkeys(values))
    if name == "rule_name":
        path = getattr(eff, "rule_name_field", None) if eff is not None else None
        values = _values(dotted_get(raw, path)) if path else []
        return values or _values(row.get("rule"))
    if name == "severity":
        values = _values(row.get("severity"))
        if as_level:
            from .severity_levels import level_of_raw

            return [level_of_raw(values[0], scale_max)] if values else []
        return values
    if name == "action":
        return _values(dotted_get(raw, "event.action"))
    return []


def _row_matches(row: Mapping[str, Any], filters: Sequence[lookups.BoundFilter], eff: Any, scale_max: float) -> bool:
    from .severity_levels import level_of_raw, normalise_level

    for flt in filters:
        if flt.logical and flt.key == "severity":
            level = normalise_level(flt.value)
            values = _values(row.get("severity"))
            if level is not None:
                if not values or level_of_raw(values[0], scale_max) != level:
                    return False
                continue
            if flt.value not in values:
                return False
            continue
        if flt.value not in _row_values(row, flt.key, flt.logical, eff, scale_max):
            return False
    return True


@dataclass
class _SourceRead:
    name: str
    ok: bool = True
    exact: bool = True
    count: int = 0
    rows: list[dict[str, Any]] | None = None
    groups: dict[str, dict[str, int]] | None = None
    not_recorded: list[str] | None = None
    sampled: bool = False
    #: Group-by fields whose distinct count here is a lower bound: the source returned
    #: only its top buckets, or the values were counted over a sample.
    distinct_floor: set[str] | None = None


def _in_window(row: Mapping[str, Any], start: datetime | None, end: datetime | None) -> bool:
    ts = _parse_iso(row.get("ts"))
    if ts is None:
        return start is None
    if start is not None and ts < start:
        return False
    return not (end is not None and ts > end)


async def _read_source(state: Any, target: Any, binding: lookups.LookupBinding) -> _SourceRead:
    from ..connectors.base import StructuredQuery, aggregate_field

    prefs = state.execution_prefs
    out = _SourceRead(name=str(target.source_name))
    native = {f.key: f.value for f in binding.filters if f.logical and f.key in _NATIVE_FILTERS}
    post = [f for f in binding.filters if not (f.logical and f.key in _NATIVE_FILTERS)]
    sq = StructuredQuery(
        ip=native.get("ip"), user=native.get("user"), host=native.get("host"), rule=native.get("rule"),
        time_from=binding.window_from_iso or None, time_to=_upper_iso(binding),
        size=LOG_SAMPLE_ROWS, sort_desc=True,
    )
    scale = float(getattr(target, "scale_max", 100.0) or 100.0)
    group_by = list(binding.group_by)
    async with _source_connector(state, target.source_id) if target.mode == "search" else _null_cm() as conn:
        eff = _effective(conn, prefs) if conn is not None else None
        # The native path: exact counts from the connector when every filter and every
        # group-by is something the source counts itself.
        if (binding.tool == "log_stats" and conn is not None and not post
                and callable(getattr(conn, "aggregate", None))
                and all(g in lookups.LOOKUP_LOGICAL_FIELDS for g in group_by)):
            missing = [g for g in group_by if eff is not None and aggregate_field(eff, g) is None]
            counted = [g for g in group_by if g not in missing]
            try:
                agg = await conn.aggregate(prefs, sq.model_copy(update={"size": 0}), counted, None,
                                           top_n=binding.limit)
            except Exception:  # noqa: BLE001 (degrade to the sample)
                agg = None
            if agg is not None:
                out.count = int(agg.total or 0)
                out.groups = {g: {b.key: int(b.count) for b in agg.groups.get(g, [])} for g in counted}
                # A field with matching events but no bucket is not recorded on this
                # source (``action`` on Wazuh): never a zero count.
                empty = [g for g in counted if out.count > 0 and not out.groups.get(g)]
                out.not_recorded = [*missing, *empty]
                # The source returns its top buckets only: a full page of them means
                # there may be more distinct values than it listed.
                out.distinct_floor = {g for g in counted if len(out.groups.get(g) or {}) >= binding.limit}
                return out
        rows, total = await target.read(sq.model_copy())
        start = _parse_iso(binding.window_from_iso)
        end = _parse_iso(_upper_iso(binding))
        kept: list[dict[str, Any]] = []
        all_filters = list(binding.filters)
        for row in rows or []:
            if target.mode == "buffer" and not _in_window(row, start, end):
                continue
            if _row_matches(row, all_filters, eff, scale):
                kept.append(row)
        complete = target.mode == "search" and total is not None and int(total) <= len(rows or [])
        out.sampled = not complete
        out.exact = complete
        if not post and target.mode == "search" and total is not None:
            # Every filter compiled natively: the source's match total stands, exact
            # when it counted all of it (the rows are its newest page).
            out.count = max(int(total), len(kept))
            out.exact = complete or binding.tool == "log_search" and int(total) == len(kept)
        else:
            out.count = len(kept)
        out.rows = kept
        if group_by:
            groups: dict[str, dict[str, int]] = {}
            unrecorded: list[str] = []
            for g in group_by:
                counter: dict[str, int] = {}
                logical = g in lookups.LOOKUP_LOGICAL_FIELDS
                for row in kept:
                    for value in _row_values(row, g, logical, eff, scale, as_level=(g == "severity"))[:1]:
                        counter[value] = counter.get(value, 0) + 1
                groups[g] = counter
                if kept and not counter:
                    unrecorded.append(g)
            out.groups = groups
            out.not_recorded = unrecorded
            if out.sampled:
                out.distinct_floor = set(group_by)
        return out


@contextlib.asynccontextmanager
async def _null_cm() -> AsyncIterator[None]:
    yield None


async def _log_lookup(state: Any, binding: lookups.LookupBinding, base: dict[str, Any]) -> LookupResult:
    targets_fn = getattr(state, "_chat_browse_targets", None)
    targets = list(targets_fn(state.execution_prefs) if callable(targets_fn) else [])
    if not targets:
        return LookupResult(**base, status="error", reason="No log source can be searched.")
    per_source = max(1.0, min(LOOKUP_TIMEOUT_S - 1.0, 20.0))

    async def guarded(target: Any) -> _SourceRead:
        try:
            return await asyncio.wait_for(_read_source(state, target, binding), timeout=per_source)
        except Exception as exc:  # noqa: BLE001 (partial success, #11)
            logger.info("runbook log lookup on %s failed: %s", str(getattr(target, "source_id", ""))[:80], exc)
            return _SourceRead(name=str(target.source_name), ok=False, exact=False)

    reads = list(await asyncio.gather(*(guarded(t) for t in targets)))
    answered = [r for r in reads if r.ok]
    failed = len(reads) - len(answered)
    if not answered:
        return LookupResult(**base, status="error", reason="No log source answered.")
    count = sum(r.count for r in answered)
    exact = failed == 0 and all(r.exact for r in answered)
    relation = "eq" if exact else "gte"
    reasons: list[str] = []
    if failed:
        reasons.append(f"{failed:,} of {len(reads):,} sources did not answer, so this is at least the count.")
    if any(r.sampled for r in answered):
        reasons.append(f"Counted from the newest {LOG_SAMPLE_ROWS:,} events of a source.")
    unrecorded = sorted({f"{g} on {r.name}" for r in answered for g in (r.not_recorded or [])})
    facts: list[tuple[str, Any]] = [
        ("Events", ("at least " if relation == "gte" else "") + _n(count)),
        ("Sources searched", _n(len(answered))),
    ]
    table: dict[str, Any] | None = None
    table_kind: str | None = None
    if binding.tool == "log_stats" and binding.group_by:
        merged: dict[str, dict[str, int]] = {}
        for r in answered:
            for g, counter in (r.groups or {}).items():
                bucket = merged.setdefault(g, {})
                for key, n in counter.items():
                    bucket[key] = bucket.get(key, 0) + n
        per_field = max(1, RUNBOOK_LOOKUP_TABLE_MAX_ROWS // max(1, len(binding.group_by)))
        unrecorded_fields = {g for r in answered for g in (r.not_recorded or [])}
        rows: list[list[Any]] = []
        for g in binding.group_by:
            values = merged.get(g, {})
            ranked = sorted(values.items(), key=lambda kv: (-kv[1], kv[0]))[: min(binding.limit, per_field)]
            if values or g not in unrecorded_fields:
                # A field no source records is named under "Not recorded", never as 0.
                # A count from a source's top buckets only, from a sample or with a
                # source that did not answer is a lower bound and says so.
                floor = bool(failed) or any(g in (r.distinct_floor or set()) for r in answered)
                facts.append((f"Distinct {g}", ("at least " if floor and values else "") + _n(len(values))))
            rows += [[g, key, _n(n)] for key, n in ranked]
        if rows:
            table, table_kind = _table(["Field", "Value", "Events"], rows), "aggregate"
    elif binding.tool == "log_search":
        merged_rows = sorted(
            [(r.name, row) for r in answered for row in (r.rows or [])],
            key=lambda pair: str(pair[1].get("ts") or ""), reverse=True,
        )[: min(binding.limit, RUNBOOK_LOOKUP_TABLE_MAX_ROWS)]
        rows = [[row.get("ts"), name, row.get("rule"), row.get("source_ip"), row.get("user"), row.get("message")]
                for name, row in merged_rows]
        facts.append(("Shown", f"{len(rows):,} newest"))
        if rows:
            table, table_kind = _table(["Time", "Source", "Rule", "Source IP", "User", "Message"], rows), "rows"
    if unrecorded:
        facts.append(("Not recorded", "; ".join(unrecorded)))
    status = "ok" if count > 0 else "empty"
    if relation == "gte" and (failed or any(r.sampled for r in answered)):
        status = "partial"
    return LookupResult(
        **base, status=status, reason=" ".join(reasons) or None, count=count, count_relation=relation,
        facts=_facts(facts), table=table, table_kind=table_kind,
    )


# ---- enrichment ----------------------------------------------------------- #
_INDICATOR_KINDS = {
    "ip": IndicatorKind.IP, "domain": IndicatorKind.DOMAIN, "url": IndicatorKind.URL,
    "hash": IndicatorKind.FILE_HASH, "email": IndicatorKind.EMAIL,
}


async def _enrich_lookup(state: Any, binding: lookups.LookupBinding, base: dict[str, Any]) -> LookupResult:
    from ..enrichment.dispatch import enrich_indicator

    indicator = binding.indicator
    if indicator is None or indicator.kind not in _INDICATOR_KINDS:
        return LookupResult(**base, status="not_applicable", reason="This case has no value to enrich.")
    prefs = state.execution_prefs
    cfg = getattr(prefs, "enrichment", None)
    if cfg is not None and not getattr(cfg, "enabled", True):
        return LookupResult(**base, status="not_applicable", reason="Enrichment is turned off in Settings.")
    results = await enrich_indicator(
        indicator.value, _INDICATOR_KINDS[indicator.kind], cfg, state.secrets, getattr(state, "cache", None),
        registry=getattr(state, "enrichment_registry", None),
    )
    answered = [r for r in results if getattr(r, "ok", False)]
    if not results:
        return LookupResult(**base, status="empty", count=0,
                            reason="No enrichment provider is set up for this kind of value.")
    scores = [int(r.score) for r in answered if isinstance(r.score, int)]
    malicious = sum(1 for r in answered if r.malicious)
    rows = [[r.provider, "" if r.score is None else r.score,
             "yes" if r.malicious else ("no" if r.malicious is False else ""), ", ".join(r.tags[:4])]
            for r in answered]
    status = "ok" if answered else "error"
    return LookupResult(
        **base, status=status, count=len(answered), count_relation="eq",
        reason=None if answered else "No enrichment provider answered.",
        facts=_facts([
            ("Providers answered", f"{len(answered):,} of {len(results):,}"),
            ("Highest score", max(scores) if scores else None),
            ("Called it malicious", f"{malicious:,} of {len(answered):,}" if answered else None),
        ]),
        table=_table(["Provider", "Score", "Malicious", "Tags"], rows) if rows else None,
        table_kind="aggregate" if rows else None,
    )


# ---- cases and campaigns -------------------------------------------------- #
_RELATED_SCAN_MAX = 500


async def _related_cases_lookup(state: Any, case: Any, binding: lookups.LookupBinding,
                                base: dict[str, Any]) -> LookupResult:
    entity = next((f.value for f in binding.filters if f.key == "entity"), None)
    rule = next((f.value for f in binding.filters if f.key == "rule"), None)
    store = state.cases
    found: list[Any] = []
    capped = False
    offset = 0
    while offset < _RELATED_SCAN_MAX:
        page, total, _exact = await store.list_window(
            created_from=binding.window_from_iso or None, created_to=_upper_iso(binding),
            entity_value=entity, limit=100, offset=offset,
        )
        if not page:
            break
        for other in page:
            if other.case_id == case.case_id:
                continue
            if rule is not None and rule not in (other.rule_ids or []):
                continue
            found.append(other)
        offset += len(page)
        if offset >= int(total or 0) or len(page) < 100:
            break
    else:
        capped = True
    shown = found[: min(binding.limit, 10)]
    rows = [[c.case_number or c.case_id, c.title, getattr(c.status, "value", c.status),
             getattr(c.verdict, "value", c.verdict) or "", (c.created_at or "")[:16].replace("T", " ")]
            for c in shown]
    return LookupResult(
        **base, status="ok" if found else "empty", count=len(found),
        count_relation="gte" if capped else "eq",
        reason=f"Only the {_RELATED_SCAN_MAX:,} newest cases in the window were read." if capped else None,
        facts=_facts([("Related cases", ("at least " if capped else "") + _n(len(found)))]),
        table=_table(["Case", "Title", "Status", "Verdict", "Created"], rows) if rows else None,
        table_kind="aggregate" if rows else None,
    )


async def _campaign_lookup(state: Any, case: Any, binding: lookups.LookupBinding,
                           base: dict[str, Any]) -> LookupResult:
    entity = next((f.value for f in binding.filters if f.key == "entity"), None)
    store = getattr(state, "campaign_store", None)
    if store is None:
        return LookupResult(**base, status="error", reason="Campaigns are not available.")
    # The strict read: a campaign registry that cannot be read is an error, never
    # "no campaigns".
    reader = getattr(store, "list_strict", None) or store.list
    try:
        campaigns, _total = await reader(limit=0)
    except Exception as exc:  # noqa: BLE001 (the lookup reports it; the run goes on)
        logger.info("campaign lookup on case %s could not read campaigns: %s", str(case.case_id)[:80], exc)
        return LookupResult(**base, status="error", reason="Campaigns could not be read.")
    if entity is not None:
        matched = [c for c in campaigns if any(e.value == entity for e in c.entities)]
    else:
        matched = [c for c in campaigns if case.case_id in (c.case_ids or [])]
    shown = matched[: binding.limit]
    rows = [[c.name or "Campaign", _n(len(c.case_ids)), (c.last_seen or "")[:16].replace("T", " "),
             c.severity_rollup or ""] for c in shown]
    return LookupResult(
        **base, status="ok" if matched else "empty", count=len(matched),
        facts=_facts([("Campaigns", _n(len(matched)))]),
        table=_table(["Campaign", "Cases", "Last seen", "Severity"], rows) if rows else None,
        table_kind="aggregate" if rows else None,
    )


def _mitre_lookup(case: Any, binding: lookups.LookupBinding, base: dict[str, Any]) -> LookupResult:
    from . import mitre

    technique = next((f.value for f in binding.filters if f.key == "technique"), None)
    wanted = [technique] if technique else list(getattr(case, "mitre", None) or [])
    known = mitre.map_many(wanted)[: binding.limit]
    if not known:
        reason = "That technique is not in the bundled ATT&CK data." if technique else "This case has no ATT&CK technique yet."
        return LookupResult(**base, status="empty", count=0, reason=reason)
    rows = [[m.get("id"), m.get("name"), ", ".join(m.get("tactics") or [])] for m in known]
    return LookupResult(
        **base, status="ok", count=len(known), facts=_facts([("Techniques", _n(len(known)))]),
        table=_table(["Technique", "Name", "Tactics"], rows), table_kind="aggregate",
    )


# ---- storing results ------------------------------------------------------ #
_RUN_GATES: "weakref.WeakValueDictionary[str, asyncio.Semaphore]" = weakref.WeakValueDictionary()
_BACKGROUND: set["asyncio.Task[Any]"] = set()
#: Process-wide bound on background (``on_attach``) work: at most this many runs read
#: for their lookups at once (each run at most 2 lookups at once), so a burst of
#: attachments (a bulk reopen, Demo seeding) never opens hundreds of log queries.
BACKGROUND_RUNS_AT_ONCE = 4
#: At most this many runs wait for their background lookups; past it a new run's
#: ``on_attach`` lookups are not started (its steps keep "Run lookup").
BACKGROUND_QUEUE_MAX = 500
_BACKGROUND_GATES: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


def _run_gate(run_id: str) -> asyncio.Semaphore:
    """At most :data:`runbook_lookup.LOOKUP_MAX_CONCURRENT_PER_RUN` lookups at once per
    run (a weak registry: a gate exists only while lookups hold it)."""
    gate = _RUN_GATES.get(run_id)
    if gate is None:
        gate = asyncio.Semaphore(lookups.LOOKUP_MAX_CONCURRENT_PER_RUN)
        _RUN_GATES[run_id] = gate
    return gate


def _background_gate() -> asyncio.Semaphore:
    """The process-wide background gate of the running event loop."""
    loop = asyncio.get_running_loop()
    gate = _BACKGROUND_GATES.get(loop)
    if gate is None:
        gate = asyncio.Semaphore(BACKGROUND_RUNS_AT_ONCE)
        _BACKGROUND_GATES[loop] = gate
    return gate


def _demo_identity(state: Any) -> tuple[int, str]:
    """Which real or Demo stack is active now: the Demo switch count and the Demo run
    id. Work that started on one stack never stores into, or reads for, another."""
    return int(getattr(state, "demo_generation", 0) or 0), str(getattr(state, "demo_run_id", None) or "")


async def _store_lookup(
    stack: _Stack, case: Any, run_id: str, step_id: str, result: LookupResult, *, actor: str,
    actor_type: str, context: Any,
) -> tuple[CaseRuns, bool]:
    """Store a lookup result audit-first (``step.evidence_collected``) and publish."""
    holder: dict[str, Any] = {}

    async def write() -> CaseRuns:
        written = await stack.runs.record_lookup_result(str(case.case_id), run_id, step_id, result)
        holder["replaced"] = written.replaced
        holder["dropped"] = written.table_dropped
        return written.case

    try:
        current = await stack.runs.get(str(case.case_id))
        run = current.run(run_id)
        if run is None:
            raise RunNotFound(run_id)
        _find_step(run, step_id)
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    try:
        case_runs = await audited_write(
            None, sink=stack.audit, action="step.evidence_collected", target=_target(case),
            expected_revision=current.revision, changes=None, write=write,
            action_type=ActionType.RUNBOOK, actor=actor, actor_type=actor_type, surface=_AUDIT_SURFACE,
            context=context, case_id=str(case.case_id),
            result_summary=f"Lookup {result.tool} collected evidence ({result.status}).",
            tool_input={"run_id": run_id, "step_id": step_id, "tool": result.tool, "status": result.status,
                        "count": result.count, "count_relation": result.count_relation},
            after_write=lambda cr: _publish_frames(stack, str(case.case_id),
                                                   [r for r in cr.runs if r.run_id == run_id], cr.revision),
        )
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    return case_runs, bool(holder.get("replaced"))


def schedule_on_attach_lookups(state: Any, stack: _Stack, case: Any, run: RunbookRun) -> "asyncio.Task[Any] | None":
    """Run the run's ``on_attach`` lookups in the background ($0, never a model call),
    as the system actor, at most 2 at once per run and :data:`BACKGROUND_RUNS_AT_ONCE`
    runs at once in the process. Each result is stored and audited. Work started on
    the real stack is dropped when Demo Mode switches (and the reverse) before it
    reads or stores anything more, so a Demo case's values never query the real
    sources and a result never lands on the other stack."""
    steps = [s for s in run.snapshot.steps
             if s.kind == "lookup" and s.lookup is not None and s.lookup.run == "on_attach"]
    if not steps:
        return None
    pending = sum(1 for t in _BACKGROUND if not t.done())
    if pending >= BACKGROUND_QUEUE_MAX:
        logger.warning("on-attach lookups for run %s not started: %d runs are already waiting",
                       run.run_id[:80], pending)
        return None
    snapshot = case.model_copy(deep=True) if hasattr(case, "model_copy") else case
    identity = _demo_identity(state)

    def _same_stack() -> bool:
        if _demo_identity(state) == identity:
            return True
        logger.info("on-attach lookups for run %s dropped: Demo Mode switched", run.run_id[:80])
        return False

    async def _one(step: RunbookStep, events: list[Any] | None) -> None:
        async with _run_gate(run.run_id):
            if not _same_stack():
                return
            result = await execute_lookup(state, snapshot, step.lookup, ran_by=RUNBOOK_SYSTEM_RUNNER,
                                          events=events, load_events=False)
            if not _same_stack():
                return
            try:
                await _store_lookup(stack, snapshot, run.run_id, step.id, result,
                                    actor=RUNBOOK_SYSTEM_RUNNER, actor_type="system", context=None)
            except Exception as exc:  # noqa: BLE001
                logger.warning("on-attach lookup %s for case %s not stored: %s",
                               step.id[:64], str(snapshot.case_id)[:80], exc)

    async def _all() -> None:
        async with _background_gate():
            if not _same_stack():
                return
            events = await _case_events(state, snapshot)
            await asyncio.gather(*(_one(step, events) for step in steps), return_exceptions=True)

    try:
        spawn = getattr(state, "spawn_mutation_task", None)
        task = spawn(_all(), name=f"runbook-lookups:{run.run_id}") if callable(spawn) else asyncio.ensure_future(_all())
    except Exception as exc:  # noqa: BLE001 (the mutation fence is closed during a reset)
        logger.info("on-attach lookups for run %s not started: %s", run.run_id[:80], exc)
        return None
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)
    return task


async def wait_for_background_lookups(timeout: float = 30.0) -> None:
    """Wait for every background lookup started in this process (tests, shutdown)."""
    pending = [t for t in list(_BACKGROUND) if not t.done()]
    if pending:
        await asyncio.wait(pending, timeout=timeout)


async def run_lookup_now(
    state: Any, case: Any, run_id: str, step_id: str, *, actor: str, context: Any,
    allows: Callable[[str, str], bool] | None = None,
) -> RunbookRunUpdate:
    """"Run lookup" (``on_demand``, or "Run again" after a clamped window): runs the
    step's lookup now and REPLACES the previous automatic result. A lookup that could
    not run is ``503 lookup_unavailable`` and replaces nothing."""
    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    try:
        current = await stack.runs.get(str(case.case_id))
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    run = current.run(run_id)
    if run is None:
        raise map_store_error(RunNotFound(run_id))
    if run.status == "abandoned":
        raise _state_error("This runbook was abandoned, so its steps cannot change.")
    try:
        step = _find_step(run, step_id)
    except StepNotFound as exc:
        raise map_store_error(exc) from exc
    if step.kind != "lookup" or step.lookup is None:
        raise _step_error("This step has no lookup.")
    identity = _demo_identity(state)
    # One deadline for the whole request: waiting for this run's other lookups (at
    # most 2 at once per run) counts against the lookup's 45 seconds.
    loop = asyncio.get_running_loop()
    deadline = loop.time() + LOOKUP_TIMEOUT_S
    gate = _run_gate(run_id)
    try:
        await asyncio.wait_for(gate.acquire(), timeout=LOOKUP_TIMEOUT_S)
    except asyncio.TimeoutError as exc:
        raise RunbookRunError(503, "lookup_unavailable",
                              "Other lookups on this runbook are still running. Try again shortly.") from exc
    try:
        remaining = max(0.1, deadline - loop.time())
        try:
            result = await asyncio.wait_for(execute_lookup(state, case, step.lookup, ran_by=actor or "analyst"),
                                            timeout=remaining)
        except asyncio.TimeoutError as exc:
            raise RunbookRunError(
                503, "lookup_unavailable",
                f"The lookup took longer than {int(LOOKUP_TIMEOUT_S)} seconds, so it stopped.",
            ) from exc
    finally:
        gate.release()
    if result.status == "error":
        raise RunbookRunError(503, "lookup_unavailable", result.reason or "The lookup could not run.")
    if _demo_identity(state) != identity:
        raise RunbookRunError(503, "lookup_unavailable", "Demo Mode changed while the lookup ran. Run it again.")
    case_runs, _replaced = await _store_lookup(stack, case, run_id, step_id, result, actor=actor,
                                               actor_type="human", context=context)
    return _update_payload(case_runs, run_id, allows)


async def preview_lookup(state: Any, case: Any, template: LookupTemplate, *, actor: str) -> LookupResult:
    """``POST /api/runbooks/lookup-test``: a draft lookup against one case, read-only,
    nothing stored and nothing audited (a read)."""
    issues = lookups.validate_lookup(template)
    if issues:
        raise RunbookRunError(422, "runbook_invalid", "This lookup has problems. Fix them and try again.",
                              issues=[issue.model_dump() for issue in issues])
    return await execute_lookup(state, case, template, ran_by=actor or "analyst")


# --------------------------------------------------------------------------- #
# What a model may read (#7, #9)
# --------------------------------------------------------------------------- #
def reduce_lookup_for_prompt(result: LookupResult) -> dict[str, Any]:
    """A lookup result as a prompt may carry it (§4.10.8): the tool, status, count,
    relation, window and facts, and an ``aggregate`` table as it is. A ``rows`` table
    (raw ``log_search`` rows) is reduced by code to its row count and, per column, the
    number of distinct values and the counts of the three most common ones; no cell
    text of a row table is kept. The caller fences the result as untrusted (#9)."""
    out: dict[str, Any] = {
        "tool": result.tool,
        "status": result.status,
        "count": result.count,
        "count_relation": result.count_relation,
        "window_from": result.window_from,
        "window_to": result.window_to,
        "facts": [dict(f) for f in result.facts],
    }
    if result.reason:
        out["note"] = result.reason
    table = result.table if isinstance(result.table, dict) else None
    if table is None:
        return out
    columns = [str(c) for c in (table.get("columns") or [])]
    rows = [r for r in (table.get("rows") or []) if isinstance(r, list)]
    if result.table_kind == "aggregate":
        out["table"] = {"columns": columns, "rows": rows}
        return out
    summary: list[dict[str, Any]] = []
    for index, column in enumerate(columns):
        counter: dict[str, int] = {}
        for row in rows:
            if index < len(row) and row[index] not in (None, ""):
                key = str(row[index])
                counter[key] = counter.get(key, 0) + 1
        top = sorted(counter.values(), reverse=True)[:3]
        summary.append({"column": column, "distinct": len(counter), "top_counts": top})
    out["rows_summary"] = {"row_count": len(rows), "columns": summary}
    return out


def run_summary(runs: Iterable[RunbookRun]) -> list[dict[str, Any]]:
    """The run summary the Case chat ``get_case`` tool returns (§4.10.10): title,
    version, status, progress, the next step's title and the required steps open, for
    every run that is not abandoned. No lookup result is included. The caller fences it."""
    out: list[dict[str, Any]] = []
    for run in runs:
        if run.status == "abandoned":
            continue
        progress = run_progress(run)
        nxt = next_step(run)
        out.append({
            "title": run.title,
            "version": run.version,
            "status": run.status,
            "progress": progress.model_dump(),
            "next_step": nxt.title if nxt is not None else None,
            "required_open": progress.required_open,
        })
    return out


# --------------------------------------------------------------------------- #
# Candidates for the Start runbook picker
# --------------------------------------------------------------------------- #
async def candidates_for_case(
    state: Any, case: Any, q: str | None = None, *, actor: str | None = None,
) -> list[RunbookCandidate]:
    """The picker list: the best match with its explanation, other matches, the
    fallback, then every other published runbook; and the AI's last suggestion to
    ``actor`` on the case first when it is still valid. Runbooks already on the case
    are left out, and so are built-ins a Published operator copy replaces (the
    library lists them only under "Show replaced built-ins")."""
    stack = _bind_stack(state)
    try:
        catalog = await load_catalog(state)
        current = await stack.runs.get(str(case.case_id))
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    left_out = {run.runbook_id for run in current.runs} | set(catalog.replaced)
    result = match(case_facts(case, stack.prefs), catalog.matchable, fallback=True)
    out: list[RunbookCandidate] = []
    listed: set[str] = set()

    def add(entry: MatchableRunbook, group: str, explanation: MatchExplanation | None = None,
            reason: str | None = None) -> None:
        if entry.id in left_out or entry.id in listed:
            return
        listed.add(entry.id)
        out.append(RunbookCandidate(
            id=entry.id, title=entry.definition.title, summary=entry.definition.summary,
            version=entry.version, origin=entry.origin, group=group,  # type: ignore[arg-type]
            phases=list(entry.definition.phases), explanation=explanation, reason=reason,
        ))

    suggestion = _recalled_suggestion(state, str(case.case_id), actor)
    if suggestion is not None:
        entry = catalog.published(suggestion[0])
        if entry is not None:
            add(entry, "suggested", reason=suggestion[1])
    first_specific = True
    for ranked in result.candidates:
        if ranked.tier == 0:
            add(ranked.runbook, "fallback", ranked.explanation)
        elif first_specific:
            add(ranked.runbook, "best", ranked.explanation)
            first_specific = False
        else:
            add(ranked.runbook, "other", ranked.explanation)
    for entry in sorted(catalog.everything(), key=lambda e: e.definition.title.casefold()):
        group = "fallback" if entry.definition.applies_when.always else "all"
        add(entry, group)
    needle = (q or "").strip().casefold()
    if needle:
        out = [c for c in out if needle in c.title.casefold() or needle in c.summary.casefold()
               or needle in c.id.casefold()]
    return out


# --------------------------------------------------------------------------- #
# The AI's help (§4.10.10): one gateway call each, ledgered and budget-gated
# --------------------------------------------------------------------------- #
#: The AI's last suggestion per (real or Demo identity, case, person who asked): only
#: the person who saw the suggestion can accept it, so another analyst who starts the
#: same runbook by hand is recorded as having chosen it themselves.
_SUGGESTIONS: "OrderedDict[tuple[str, str, str], tuple[str, str, float]]" = OrderedDict()


def _identity(state: Any) -> str:
    return str(getattr(state, "demo_run_id", None) or "real")


def _suggestion_key(state: Any, case_id: str, actor: str | None) -> tuple[str, str, str]:
    return (_identity(state), case_id, str(actor or "").strip().casefold())


def _remember_suggestion(state: Any, case_id: str, actor: str | None, runbook_id: str, reason: str) -> None:
    key = _suggestion_key(state, case_id, actor)
    _SUGGESTIONS[key] = (runbook_id, reason, time.monotonic())
    _SUGGESTIONS.move_to_end(key)
    while len(_SUGGESTIONS) > _SUGGESTION_MEMORY_MAX:
        _SUGGESTIONS.popitem(last=False)


def _recalled_suggestion(state: Any, case_id: str, actor: str | None) -> tuple[str, str] | None:
    if actor is None:
        return None
    key = _suggestion_key(state, case_id, actor)
    entry = _SUGGESTIONS.get(key)
    if entry is None:
        return None
    runbook_id, reason, at = entry
    if time.monotonic() - at > SUGGESTION_TTL_S:
        _SUGGESTIONS.pop(key, None)
        return None
    return runbook_id, reason


def _forget_suggestion(state: Any, case_id: str, actor: str | None) -> None:
    _SUGGESTIONS.pop(_suggestion_key(state, case_id, actor), None)


def _gateway(state: Any) -> Any:
    """The ACTIVE gateway: the chat engine's (Demo-switchable), so a Demo call runs on
    the $0 demo gateway and its ledger (the report summary's rule)."""
    engine = getattr(state, "chat_engine", None)
    return getattr(engine, "_gateway", None) or state.gateway


def _model_cfg(prefs: Any) -> Any:
    cfg = prefs.chat_model
    max_tokens = min(max(int(getattr(cfg, "max_tokens", 0) or 0), _AI_MIN_OUTPUT_TOKENS), _AI_MAX_OUTPUT_TOKENS)
    return cfg.model_copy(update={"max_tokens": max_tokens})


def _ai_timeout(prefs: Any) -> float:
    step = getattr(getattr(prefs, "chat_agent", None), "model_step_timeout_s", None)
    try:
        seconds = float(step)
    except (TypeError, ValueError):
        seconds = 90.0
    if not math.isfinite(seconds) or seconds <= 0:
        seconds = 90.0
    return min(2.0 * seconds, _AI_TIMEOUT_CEILING_S)


async def _estimate(state: Any, messages: list[dict[str, str]], model_cfg: Any, *, can_see_cost: bool) -> ReportSummaryEstimate:
    from ..llm.gateway import estimate_message_tokens

    demo = bool(getattr(state, "demo_active", False))
    prompt = estimate_message_tokens(messages)
    expected = min(int(model_cfg.max_tokens), _AI_EXPECTED_OUTPUT_TOKENS)
    cost: float | None = None
    if can_see_cost:
        cost = await _estimate_cost(_gateway(state), model_cfg.model, prompt, expected, demo=demo)
    return ReportSummaryEstimate(
        prompt_tokens=prompt, max_output_tokens=int(model_cfg.max_tokens),
        total_tokens=prompt + expected, cost=cost, simulated=demo, model=model_cfg.model,
    )


async def _estimate_cost(gateway: Any, model: str, prompt: int, completion: int, *, demo: bool) -> float | None:
    if demo:
        from ..llm import gateway as gateway_module

        synthetic = getattr(gateway_module, "_demo_synthetic_cost", None)
        return float(synthetic(prompt, completion)) if callable(synthetic) else 0.0
    from ..llm.pricing import cost_for

    overlay = None
    resolver = getattr(gateway, "_effective_price_tuple", None)
    if callable(resolver):
        try:
            overlay = await resolver(model)
        except Exception:  # noqa: BLE001
            overlay = None
    try:
        cost = float(cost_for(model, prompt, completion, overlay))
    except Exception:  # noqa: BLE001
        return None
    return cost if math.isfinite(cost) and cost >= 0 else None


async def _ai_call(
    state: Any, messages: list[dict[str, str]], model_cfg: Any, *, case_id: str, actor: str, purpose: str,
) -> tuple[str, str]:
    """ONE gateway call (#6) on the ``runbook`` surface, so the daily AI budget applies.
    Returns ``(text, model)``. A budget block, a provider failure and a timeout are
    refusals that change nothing."""
    from ..llm.gateway import BudgetBlocked, GatewayError, UsageReceipt

    receipt = UsageReceipt()
    prefs = state.execution_prefs
    try:
        result = await asyncio.wait_for(
            _gateway(state).complete(Role.CHAT, messages, model_cfg, surface=CASE_RUNBOOK_SURFACE,
                                     case_id=case_id, usage_receipt=receipt),
            timeout=_ai_timeout(prefs),
        )
    except BudgetBlocked as exc:
        raise RunbookRunError(429, "runbook_ai_budget", "The AI budget for today is used up.") from exc
    except asyncio.TimeoutError as exc:
        raise RunbookRunError(504, "runbook_ai_timeout", "The AI took too long to answer. Try again.") from exc
    except GatewayError as exc:
        raise RunbookRunError(503, "runbook_ai_unavailable", "The AI could not answer. Try again later.") from exc
    model = receipt.model or getattr(result, "model", None) or model_cfg.model
    try:
        await state.execution_audit.record(
            action_type=ActionType.PROMPT, surface=CASE_RUNBOOK_SURFACE, actor=actor or "analyst",
            case_id=case_id, model=model,
            result_summary=(f"runbook {purpose} model call tokens="
                            f"{receipt.prompt_tokens + receipt.completion_tokens} cost={receipt.cost:.6f}"),
        )
    except Exception as exc:  # noqa: BLE001 (the call is ledgered either way, #6)
        logger.warning("runbook %s prompt audit row not written: %s", purpose, exc)
    return str(getattr(result, "text", "") or ""), str(model)


def _plain(text: str, limit: int) -> str:
    """Model output as plain text: control and hidden characters removed, at most
    ``limit`` characters (never rendered as HTML by the Console)."""
    kept = "".join(ch for ch in str(text or "")
                   if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    kept = re.sub(r"\n{3,}", "\n\n", kept).strip()
    if len(kept) > limit:
        kept = kept[: limit - 3].rstrip() + "..."
    return kept


def _case_context(case: Any, prefs: Any) -> dict[str, Any]:
    """The case values a runbook prompt may carry, all untrusted (fenced by the
    caller, #9)."""
    from .priority import band_of_case

    entity = getattr(case, "entity", None)
    try:
        band = band_of_case(case, prefs)
    except Exception:  # noqa: BLE001
        band = None
    return {
        "case": str(getattr(case, "case_number", "") or getattr(case, "case_id", "")),
        "title": str(getattr(case, "title", "") or "")[:200],
        "rules": [str(r)[:256] for r in (getattr(case, "rule_ids", None) or [])[:5]],
        "entity": {
            "type": str(getattr(getattr(entity, "type", None), "value", getattr(entity, "type", "")) or ""),
            "value": str(getattr(entity, "value", "") or "")[:256],
        } if entity is not None else None,
        "severity": band,
        "verdict": getattr(getattr(case, "verdict", None), "value", None),
        "status": getattr(getattr(case, "status", None), "value", getattr(case, "status", None)),
        "tags": [str(t)[:64] for t in (getattr(case, "tags", None) or [])[:10]],
        "techniques": [str(t)[:16] for t in (getattr(case, "mitre", None) or [])[:10]],
    }


def _step_guidance(step: RunbookStep) -> dict[str, Any]:
    return {
        "title": step.title,
        "kind": step.kind,
        "focus": step.focus,
        "escalate_if": step.escalate_if,
        "benign_if": step.benign_if,
    }


def _draft_evidence(
    run: RunbookRun, step_id: str, allows: Callable[[str, str], bool] | None = None,
) -> list[dict[str, Any]]:
    """The lookup results a draft reads: the step's own, then the run's lookup steps,
    in reading order, at most :data:`DRAFT_MAX_EVIDENCE`, each reduced (#7). Only
    results the person asking may see feed it (``allows``, the grant each lookup tool
    needs, §4.10.8): a draft never tells a person what the redacted evidence held."""
    ordered: list[tuple[int, LookupResult, str]] = []
    for index, step in enumerate(ordered_steps(run.snapshot)):
        st = _step_state(run, step.id)
        for item in st.evidence:
            if item.kind != "lookup_result" or item.lookup is None:
                continue
            if allows is not None and not allows(*LOOKUP_TOOL_GRANTS.get(item.lookup.tool, ("runbooks", "read"))):
                continue
            ordered.append((0 if step.id == step_id else 1 + index, item.lookup, step.title))
    ordered.sort(key=lambda entry: entry[0])
    out: list[dict[str, Any]] = []
    for _rank, result, title in ordered[:DRAFT_MAX_EVIDENCE]:
        reduced = reduce_lookup_for_prompt(result)
        reduced["step"] = title
        out.append(reduced)
    return out


async def draft_step(
    state: Any, case: Any, run_id: str, step_id: str, *, actor: str, context: Any, dry_run: bool,
    can_see_cost: bool, allows: Callable[[str, str], bool] | None = None,
) -> RunbookStepDraftResult:
    """"Draft note" on a Check step: ONE gateway call over the step's published text
    (trusted) and the run's lookup results reduced by code and fenced (#7, #9). The
    draft is stored as ``ai_draft`` ("AI draft" until a person confirms it); the AI
    never sets a status. ``dry_run`` returns only the estimate."""
    from ..agents.prompts import build_runbook_step_draft_messages

    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    if not getattr(stack.prefs.runbooks, "ai_step_drafts", True):
        raise RunbookRunError(409, "runbook_ai_disabled", "AI drafts are turned off in Settings.")
    try:
        current = await stack.runs.get(str(case.case_id))
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    run = current.run(run_id)
    if run is None:
        raise map_store_error(RunNotFound(run_id))
    if run.status == "abandoned":
        raise _state_error("This runbook was abandoned, so its steps cannot change.")
    try:
        step = _find_step(run, step_id)
    except StepNotFound as exc:
        raise map_store_error(exc) from exc
    if step.kind != "check":
        raise _step_error("Drafts are offered on Check steps.")
    if _step_state(run, step_id).status in _FINISHED_STEP:
        raise _step_error("This step is already finished.")
    messages = build_runbook_step_draft_messages(
        guidance=_step_guidance(step), runbook_title=run.title,
        evidence=_draft_evidence(run, step_id, allows), case_context=_case_context(case, stack.prefs),
    )
    model_cfg = _model_cfg(stack.prefs)
    if dry_run:
        return RunbookStepDraftResult(estimate=await _estimate(state, messages, model_cfg, can_see_cost=can_see_cost))
    text, model = await _ai_call(state, messages, model_cfg, case_id=str(case.case_id), actor=actor,
                                 purpose="step draft")
    draft_text = _plain(text, RUNBOOK_AI_DRAFT_MAX_CHARS)
    if not draft_text:
        raise RunbookRunError(502, "runbook_ai_invalid", "The AI returned no draft. Try again.")
    now = iso_now()
    usage_ref = _request_id(context) or ""

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, None]:
        target = _find_run(runs, run_id)
        if target.status == "abandoned":
            raise _state_error("This runbook was abandoned, so its steps cannot change.")
        _find_step(target, step_id)
        st = target.steps.get(step_id) or StepState()
        # Re-checked at write time: the step may have been finished while the model
        # answered (up to the AI wait), and a draft is never offered on a finished step.
        if st.status in _FINISHED_STEP:
            raise _step_error("This step is already finished.")
        st.revision += 1
        # ``step_revision`` is the step's revision this draft creates: Confirm refuses
        # the draft once anything changed the step after it (a note another person
        # wrote is never overwritten by an older draft).
        st.ai_draft = {"text": draft_text, "created_at": now, "model": model, "usage_id": usage_ref,
                       "confirmed": False, "step_revision": st.revision}
        target.steps[step_id] = st
        target.revision += 1
        return runs, None

    _res, case_runs, _w = await _audited_runs_write(
        stack, case=case, action="step.ai_drafted", actor=actor, actor_type="human", context=context,
        change=change, result_summary="The AI drafted a note for a runbook step.",
        tool_input={"run_id": run_id, "step_id": step_id, "model": model, "chars": len(draft_text)},
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run_id],
    )
    return RunbookStepDraftResult(update=_update_payload(case_runs, run_id, allows))


async def confirm_draft(
    state: Any, case: Any, run_id: str, step_id: str, text: str, *, actor: str, context: Any,
    allows: Callable[[str, str], bool] | None = None,
) -> RunbookRunUpdate:
    """"Confirm note and mark done": the draft as the person edited it becomes the
    step's note and the step is Done. Only a person does this; the draft is marked
    confirmed. When the step changed after the draft was made (a note, a status, an
    assignee), Confirm is ``409 runbook_conflict`` with the latest run, so a note
    written after the draft is never overwritten; the row names the status and the
    note with their before and after."""
    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    clean = _plain(text, RUNBOOK_AI_DRAFT_MAX_CHARS)
    if not clean:
        raise _step_error("The note is empty.")
    now = iso_now()

    def change(runs: list[RunbookRun]) -> tuple[list[RunbookRun] | None, _StepOutcome]:
        run = _find_run(runs, run_id)
        if run.status == "abandoned":
            raise _state_error("This runbook was abandoned, so its steps cannot change.")
        step = _find_step(run, step_id)
        st = run.steps.get(step_id) or StepState()
        if not isinstance(st.ai_draft, dict):
            raise _step_error("There is no AI draft to confirm.")
        if st.status in _FINISHED_STEP:
            raise _step_error("This step is already finished.")
        if step.kind == "decision":
            raise _step_error("Record a decision to finish this step.")
        if st.ai_draft.get("confirmed"):
            raise _step_error("This AI draft is already confirmed.")
        if st.revision != st.ai_draft.get("step_revision"):
            raise _StepConflict(st.revision)
        untouched_before = _run_untouched(run)
        prior_status, prior_note = st.status, st.note
        st.note = clean
        st.ai_draft = {**st.ai_draft, "confirmed": True}
        _mark_started(st, now)
        _complete(st, actor, now)
        st.revision += 1
        run.steps[step_id] = st
        run.revision += 1
        transition = _refresh_completion(run, now)
        path = f"steps.{step_id}"
        changes = [AuditChange(field=f"{path}.status", before=prior_status, after=st.status)]
        if prior_note != st.note:
            changes.append(AuditChange(field=f"{path}.note", before=_audit_text(prior_note) or None,
                                       after=_audit_text(st.note) or None))
        first = untouched_before and not _run_untouched(run)
        return runs, _StepOutcome(run_id, "step.ai_draft_confirmed", changes, transition, False, first)

    outcome, case_runs, written = await _audited_runs_write(
        stack, case=case, action="step.ai_draft_confirmed", actor=actor, actor_type="human",
        context=context, change=change, changes=lambda res: res.changes,
        result_summary="An AI draft was confirmed as the step's note.",
        tool_input={"run_id": run_id, "step_id": step_id, "chars": len(clean)},
        frame_runs=lambda res, cr: [r for r in cr.runs if r.run_id == run_id],
    )
    if written:
        await _after_step_write(stack, case, case_runs, outcome, actor=actor, context=context)
    return _update_payload(case_runs, run_id, allows)


async def suggest_runbook(
    state: Any, case: Any, *, actor: str, dry_run: bool, can_see_cost: bool,
) -> RunbookSuggestion:
    """"Suggest a runbook": ONE gateway call over the published runbooks' titles,
    summaries and scope (trusted) and the case values (fenced). The suggestion is
    returned for a person to select; it is never attached."""
    from ..agents.prompts import build_runbook_suggest_messages

    stack = _bind_stack(state)
    _require_enabled(stack.prefs)
    if not getattr(stack.prefs.runbooks, "ai_suggest", True):
        raise RunbookRunError(409, "runbook_ai_disabled", "AI suggestions are turned off in Settings.")
    try:
        catalog = await load_catalog(state)
        current = await stack.runs.get(str(case.case_id))
    except _STORE_ERRORS as exc:
        raise map_store_error(exc) from exc
    attached = {run.runbook_id for run in current.runs}
    pool = [e for e in catalog.everything()
            if not e.definition.applies_when.always and e.id not in attached
            and not (e.origin == "builtin" and e.id in catalog.replaced)]
    pool.sort(key=lambda e: e.definition.title.casefold())
    pool = pool[:SUGGEST_MAX_CANDIDATES]
    if not pool:
        return RunbookSuggestion(candidate=None)
    payload = [{"id": e.id, "title": e.definition.title, "summary": e.definition.summary,
                "use_when": e.definition.use_when[:300]} for e in pool]
    messages = build_runbook_suggest_messages(candidates=payload, case_context=_case_context(case, stack.prefs))
    model_cfg = _model_cfg(stack.prefs)
    if dry_run:
        return RunbookSuggestion(estimate=await _estimate(state, messages, model_cfg, can_see_cost=can_see_cost))
    text, _model = await _ai_call(state, messages, model_cfg, case_id=str(case.case_id), actor=actor,
                                  purpose="suggestion")
    parsed = extract_json(text) or {}
    chosen = str(parsed.get("runbook_id") or "").strip()
    entry = next((e for e in pool if e.id == chosen), None)
    if entry is None:
        return RunbookSuggestion(candidate=None)
    reason = _plain(str(parsed.get("reason") or ""), _SUGGEST_REASON_MAX_CHARS).replace("\n", " ") or None
    _remember_suggestion(state, str(case.case_id), actor, entry.id, reason or "")
    return RunbookSuggestion(candidate=RunbookCandidate(
        id=entry.id, title=entry.definition.title, summary=entry.definition.summary, version=entry.version,
        origin=entry.origin, group="suggested", phases=list(entry.definition.phases), explanation=None,
        reason=reason,
    ))


def demo_runbook_ai_answer(messages: Sequence[Mapping[str, Any]]) -> str | None:
    """The deterministic Demo Mode answer to a runbook draft or suggestion prompt ($0).
    Built only from the prompt; ``None`` when the prompt is not a runbook prompt.

    It is meant for the Demo provider alone: ``DemoMockProvider._demo_chat_route`` in
    ``llm/providers.py`` is to route a prompt carrying either runbook marker here (a
    lazy import beside the report-summary and chat-agent markers), so a Demo runbook
    call still goes through the one gateway and is ledgered at $0 (#6). Until that
    route is wired, a Demo runbook call falls through to the generic Demo answer."""
    from ..agents.prompts import RUNBOOK_DRAFT_SYSTEM_MARKER, RUNBOOK_SUGGEST_SYSTEM_MARKER

    system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    user = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "user")
    if RUNBOOK_SUGGEST_SYSTEM_MARKER in system:
        ids = re.findall(r'"id":\s*"([a-z0-9][a-z0-9_-]{0,63})"', user)
        if not ids:
            return json.dumps({"runbook_id": "", "reason": ""})
        return json.dumps({"runbook_id": ids[0],
                           "reason": "Demo suggestion: the first published runbook that fits the case."})
    if RUNBOOK_DRAFT_SYSTEM_MARKER in system:
        counts = re.findall(r'"count":\s*(\d+)', user)
        if counts:
            total = sum(int(c) for c in counts)
            return (f"Demo draft: the lookups on this case found {total:,} matching "
                    "records. Review them against the step's focus before you confirm.")
        return "Demo draft: no lookup result is attached yet. Run the lookups, then draft again."
    return None
