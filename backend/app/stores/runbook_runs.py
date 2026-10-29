"""Per-case runbook RUNS and the run LEDGER (Round 14 SPEC §4.10.6, §4.10.7).

Storage shape (KV only: no new index, table or migration, #12). Namespace
``runbook_runs`` (:data:`app.constants.RUNBOOK_RUNS_NS`):

* ``case:<case_id>``: every run on one case (:class:`app.models.RunbookRun`, at most
  :data:`app.models.MAX_RUNS_PER_CASE`), with live step progress, under the opaque
  ``runbook_runs_json`` string. At most :data:`RUNBOOK_CASE_DOC_MAX_BYTES` (1 MiB), of
  which kept lookup tables at most :data:`RUNBOOK_CASE_EVIDENCE_MAX_BYTES` (512 KiB).
* ``ledger:<yyyy-mm>``: one compact row per run (:class:`RunbookLedgerRow`), keyed
  on the UTC month the run STARTED, written only on run-level transitions (attach,
  complete, abandon, version switch). At most
  :data:`RUNBOOK_LEDGER_MONTH_MAX_BYTES` (512 KiB) per month: a row past the cap is
  counted in ``evicted`` and the month reads ``partial``. Months older than
  :data:`RUNBOOK_LEDGER_MONTHS_KEPT` (13) are deleted on write.

Every top-level field is ``runbook_``-prefixed and the content is one opaque
canonical-JSON string (the reports-store rule), so run content never grows the shared
Elasticsearch mapping; ``runbook_store`` names the namespace so a cases reset can
find every run document (``engine.reset``). No top-level field holds a raw identifier:
the config index maps new fields dynamically with date detection on, so a first case
id shaped like a date (``2026-10-28``) would map the field as a date and refuse every
later write. ``runbook_case_id`` therefore holds ``case:<case_id>``, and
``runbook_month`` is always a ``yyyy-mm`` month.

Write traffic: a step update, an evidence write and an AI draft write touch only that
case's document; no step-level write touches the ledger, so analysts on different
cases never contend. Writes are strict compare-and-set on ``_rev`` with a confirming
read. A caller that read revision ``n`` and passes ``expected_revision=n`` is refused
with :class:`RunConflict` on any other revision and never retried (a person's stale
edit, ``409 runbook_conflict``). A write that does not depend on the conflicting field
(a background lookup result, a completion stamp) is retried on a fresh read up to
:data:`CAS_RETRIES` times, then :class:`RunbookStoreUnavailable`
(``503 runbook_store_unavailable``).

Evidence budget (§4.10.6): :meth:`RunbookRunStore.record_lookup_result` measures the
case's lookup evidence before it writes; a re-run of a lookup REPLACES the step's
earlier automatic result; a result whose table would take the kept lookup tables past
the 512 KiB budget (or the document past 1 MiB) is stored with its ``table`` dropped
and the note :data:`EVIDENCE_LIMIT_NOTE` (count, facts and parameters kept), so a case
document stays under 1 MiB. The budget is measured on the kept TABLES, the only part
the drop rule can shed: a result without its table is always stored, and only the
1 MiB document bound can refuse it, so a case at its evidence limit keeps recording
the count and facts of every later lookup.

Demo Mode (SPEC §3.5): runs are Demo-swapped. ``AppState.runbook_runs`` hands out the
Demo stack's store (over the Demo KV) while Demo Mode is on, so Demo cases have Demo
runs that vanish with the Demo.

Runs are human workflow: nothing here feeds ``case_manager.decide()`` or
``AutoClosePolicy`` (#3), and no write here changes a case. Run engine logic (attach,
steps, approvals, lookups, AI drafts) is ``engine.runbook_runs``'s; this module
enforces only the storage bounds.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import re
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

from ..constants import (
    RUNBOOK_RUNS_CASE_KEY_PREFIX,
    RUNBOOK_RUNS_LEDGER_KEY_PREFIX,
    RUNBOOK_RUNS_NS,
)
from ..models import (
    MAX_RUNS_PER_CASE,
    RUNBOOK_CASE_DOC_MAX_BYTES,
    RUNBOOK_CASE_EVIDENCE_MAX_BYTES,
    RUNBOOK_LEDGER_MONTH_MAX_BYTES,
    RUNBOOK_LEDGER_MONTHS_KEPT,
    RUNBOOK_STEP_MAX_EVIDENCE,
    LookupResult,
    RunbookRun,
    StepEvidence,
    StepState,
)
from ..utils import now_utc
from .runbook_library import RunbookStoreUnavailable

logger = logging.getLogger("tlsoc.stores.runbook_runs")

_T = TypeVar("_T")

#: How often a write that does not depend on what changed is retried on a lost race.
CAS_RETRIES = 3
_SCHEMA_VERSION = 1
#: The note a lookup result carries when its table could not be kept (§4.10.6).
EVIDENCE_LIMIT_NOTE = "Table not kept: this case has reached its evidence limit."
#: How far back (in months, past the retention) a ledger sweep looks for old months.
LEDGER_SWEEP_MONTHS = 24
#: Case ids this store accepts as a key part (no control characters, bounded).
CASE_ID_MAX_CHARS = 200
#: The longest KV key every backend stores (the SQL ``kv.key`` column).
KV_KEY_MAX_CHARS = 128
_CASE_ID_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,%d}$" % CASE_ID_MAX_CHARS)
_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

SCHEMA_FIELD = "runbook_schema"
STORE_FIELD = "runbook_store"
CASE_FIELD = "runbook_case_id"
RUNS_FIELD = "runbook_runs_json"
LEDGER_FIELD = "runbook_ledger_json"
MONTH_FIELD = "runbook_month"
DELETED_FIELD = "runbook_deleted"
REV_FIELD = "_rev"


# --------------------------------------------------------------------------- #
# Errors.
# --------------------------------------------------------------------------- #
class RunbookRunsError(RuntimeError):
    """Base class of the run store's refusals."""


class RunConflict(RunbookRunsError):
    """``expected_revision`` no longer matches the case document
    (``409 runbook_conflict``); carries the current revision."""

    def __init__(self, case_id: str, current_revision: int) -> None:
        super().__init__("This runbook changed elsewhere. Reload it and try again.")
        self.case_id = case_id
        self.current_revision = current_revision


class RunLimitReached(RunbookRunsError):
    """A case already holds :data:`MAX_RUNS_PER_CASE` runs (``409 run_limit``)."""

    def __init__(self) -> None:
        super().__init__(f"A case can hold at most {MAX_RUNS_PER_CASE} runbooks.")


class RunDocumentFull(RunbookRunsError):
    """A write would take the case document past 1 MiB (``reason="size"``), its kept
    lookup tables past 512 KiB (``"evidence"``) or a step past
    :data:`RUNBOOK_STEP_MAX_EVIDENCE` evidence items (``"evidence_count"``).
    :meth:`RunbookRunStore.record_lookup_result` never raises ``"evidence"``: it
    drops the table instead."""

    _MESSAGES = {
        "size": "This case's runbook record has reached its 1 MiB storage limit.",
        "evidence": "This case has reached its evidence limit.",
        "evidence_count": f"A step holds at most {RUNBOOK_STEP_MAX_EVIDENCE} pieces of evidence.",
    }

    def __init__(self, reason: str) -> None:
        super().__init__(self._MESSAGES.get(reason, "This case's runbook record is full."))
        self.reason = reason


class RunNotFound(LookupError):
    """No run with that id on the case (``404 run_not_found``)."""


class StepNotFound(LookupError):
    """No step with that id in the run's pinned version (``404 step_not_found``)."""


# --------------------------------------------------------------------------- #
# Models.
# --------------------------------------------------------------------------- #
LedgerAttachedBy = Literal["rule", "fallback", "person", "suggestion"]
LedgerStatus = Literal["active", "completed", "abandoned"]


class RunbookLedgerRow(BaseModel):
    """One run in the month ledger (SPEC §4.10.6): written on attach and on every
    run-level transition, never on a step change. ``skipped_step_ids`` and
    ``step_durations`` (seconds per step id, Done steps only) are filled when the run
    completes, from the case document. Rule values and titles are never stored here;
    the metrics read cases for those."""

    model_config = ConfigDict(extra="allow")

    run_id: str
    case_id: str
    runbook_id: str
    version: int = Field(ge=1)
    attached_by: LedgerAttachedBy
    started_at: str
    completed_at: str | None = None
    status: LedgerStatus = "active"
    total: int = Field(default=0, ge=0)
    required_total: int = Field(default=0, ge=0)
    skipped_step_ids: list[str] = Field(default_factory=list)
    step_durations: dict[str, int] = Field(default_factory=dict)


@dataclass(frozen=True)
class CaseRuns:
    """Every run on one case and the case document's CAS revision
    (``CaseRunbooks.revision``; 0 before the first run)."""

    case_id: str
    runs: tuple[RunbookRun, ...]
    revision: int

    def run(self, run_id: str) -> RunbookRun | None:
        for run in self.runs:
            if run.run_id == run_id:
                return run
        return None


@dataclass(frozen=True)
class LookupWrite:
    """What :meth:`RunbookRunStore.record_lookup_result` stored: the result as kept
    (``table_dropped`` when its table did not fit the evidence budget), whether an
    earlier automatic result on the step was replaced, and the case's new state."""

    result: LookupResult
    replaced: bool
    table_dropped: bool
    case: CaseRuns


@dataclass(frozen=True)
class LedgerMonth:
    """One month of the ledger: its rows, how many were evicted at the cap, and
    ``partial`` (some row is missing, so a metric over this month is a lower bound)."""

    month: str
    rows: tuple[RunbookLedgerRow, ...]
    evicted: int = 0

    @property
    def partial(self) -> bool:
        return self.evicted > 0


@dataclass(frozen=True)
class LedgerWrite:
    """What :meth:`RunbookRunStore.upsert_ledger_row` did: ``stored`` (the row is in
    its month) or ``evicted`` (the month reached its cap; counted, metrics partial).
    ``stored`` is False and ``evicted`` False when the row's month is past retention."""

    month: str
    stored: bool
    evicted: bool


# --------------------------------------------------------------------------- #
# Codec helpers.
# --------------------------------------------------------------------------- #
def case_key(case_id: str) -> str:
    """The KV key of one case's runs: ``case:<case_id>``. The SQL KV key column holds
    at most :data:`KV_KEY_MAX_CHARS` characters, so a case id too long for that (an
    operator case-id template allows 200) is keyed on its SHA-256 instead
    (``case:~<hex>``); the document still names the case, as ``case:<case_id>`` in
    ``runbook_case_id`` and in every run it holds."""
    key = f"{RUNBOOK_RUNS_CASE_KEY_PREFIX}{case_id}"
    if len(key) <= KV_KEY_MAX_CHARS:
        return key
    digest = hashlib.sha256(case_id.encode("utf-8", "surrogatepass")).hexdigest()
    return f"{RUNBOOK_RUNS_CASE_KEY_PREFIX}~{digest}"


def ledger_key(month: str) -> str:
    """The KV key of one ledger month: ``ledger:<yyyy-mm>``."""
    return f"{RUNBOOK_RUNS_LEDGER_KEY_PREFIX}{month}"


def valid_case_id(case_id: Any) -> bool:
    return isinstance(case_id, str) and bool(_CASE_ID_RE.fullmatch(case_id)) and case_id.strip() == case_id


def _require_case_id(case_id: Any) -> str:
    if not valid_case_id(case_id):
        raise ValueError("A case id is required.")
    return case_id


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "surrogatepass"))


def _rev(doc: Any) -> int:
    if not isinstance(doc, dict):
        return 0
    try:
        return max(0, int(doc.get(REV_FIELD, 0) or 0))
    except (TypeError, ValueError):
        return 0


def _load_json(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def month_of(timestamp: Any, *, default: datetime | None = None) -> str:
    """The UTC ``yyyy-mm`` of an ISO timestamp (the ledger month of a run). An
    unreadable timestamp falls back to ``default`` (now)."""
    when: datetime | None = None
    if isinstance(timestamp, str) and timestamp:
        try:
            when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            when = None
    if when is None:
        when = default or now_utc()
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    when = when.astimezone(timezone.utc)
    return f"{when.year:04d}-{when.month:02d}"


def shift_month(month: str, delta: int) -> str:
    """``month`` moved by ``delta`` months (negative goes back)."""
    year, mon = int(month[:4]), int(month[5:7])
    index = year * 12 + (mon - 1) + delta
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def retained_months(now: datetime | None = None) -> list[str]:
    """The ledger months kept: the current UTC month and the 12 before it (13)."""
    current = month_of(None, default=now or now_utc())
    return [shift_month(current, -i) for i in range(RUNBOOK_LEDGER_MONTHS_KEPT)]


def evidence_bytes(runs: Iterable[RunbookRun]) -> int:
    """The serialised size of every piece of step evidence on a case (lookup results,
    links and tickets; reported, the document bound limits it)."""
    total = 0
    for run in runs:
        for state in run.steps.values():
            for item in state.evidence:
                total += _bytes(item.model_dump(mode="json"))
    return total


def lookup_table_bytes(runs: Iterable[RunbookRun]) -> int:
    """The serialised size of every lookup TABLE a case keeps: what the 512 KiB
    lookup-evidence budget (:data:`RUNBOOK_CASE_EVIDENCE_MAX_BYTES`) bounds. A lookup
    result without its table is not counted, so it can always be stored."""
    total = 0
    for run in runs:
        for state in run.steps.values():
            for item in state.evidence:
                if item.kind == "lookup_result" and item.lookup is not None and item.lookup.table is not None:
                    total += _bytes(item.lookup.table)
    return total


def stored_case_label(case_id: str) -> str:
    """The value of the top-level ``runbook_case_id`` field: ``case:<case_id>``,
    never the raw id (see the module docstring on date detection)."""
    return f"{RUNBOOK_RUNS_CASE_KEY_PREFIX}{case_id}"


def encode_case(case_id: str, runs: Iterable[RunbookRun]) -> dict[str, Any]:
    return {
        SCHEMA_FIELD: _SCHEMA_VERSION,
        STORE_FIELD: RUNBOOK_RUNS_NS,
        CASE_FIELD: stored_case_label(case_id),
        DELETED_FIELD: False,
        RUNS_FIELD: _canonical([run.model_dump(mode="json") for run in runs]),
    }


def _document_bytes(case_id: str, runs: Iterable[RunbookRun]) -> int:
    """The stored size of a case document holding ``runs`` (with room for ``_rev``)."""
    doc = encode_case(case_id, runs)
    doc[REV_FIELD] = 2**53
    return _bytes(doc)


def decode_case(doc: Any) -> tuple[RunbookRun, ...]:
    """The runs of a stored case document (``()`` when absent, cleared or deleted).
    A document that cannot be decoded raises :class:`RunbookStoreUnavailable`: it is
    never read as "no runs", which would let a write replace it."""
    if not isinstance(doc, dict) or doc.get(DELETED_FIELD) is True:
        return ()
    raw = doc.get(RUNS_FIELD)
    if raw is None:
        return ()
    data = _load_json(raw)
    if not isinstance(data, list):
        raise RunbookStoreUnavailable("A case's runbook record could not be read.")
    try:
        return tuple(RunbookRun.model_validate(item) for item in data)
    except Exception as exc:  # noqa: BLE001 - damaged, never silently empty
        raise RunbookStoreUnavailable("A case's runbook record could not be read.") from exc


def _decode_ledger(doc: Any) -> tuple[list[RunbookLedgerRow], int]:
    if not isinstance(doc, dict) or doc.get(DELETED_FIELD) is True:
        return [], 0
    data = _load_json(doc.get(LEDGER_FIELD))
    if data is None:
        return [], 0
    if not isinstance(data, dict):
        raise RunbookStoreUnavailable("A runbook ledger month could not be read.")
    rows: list[RunbookLedgerRow] = []
    for item in data.get("rows") or []:
        try:
            rows.append(RunbookLedgerRow.model_validate(item))
        except Exception as exc:  # noqa: BLE001
            raise RunbookStoreUnavailable("A runbook ledger month could not be read.") from exc
    try:
        evicted = max(0, int(data.get("evicted", 0) or 0))
    except (TypeError, ValueError):
        evicted = 0
    return rows, evicted


def _encode_ledger(month: str, rows: list[RunbookLedgerRow], evicted: int) -> dict[str, Any]:
    return {
        SCHEMA_FIELD: _SCHEMA_VERSION,
        STORE_FIELD: RUNBOOK_RUNS_NS,
        MONTH_FIELD: month,
        DELETED_FIELD: False,
        LEDGER_FIELD: _canonical({
            "rows": [r.model_dump(mode="json") for r in rows],
            "evicted": evicted,
        }),
    }


def check_case_runs(runs: list[RunbookRun], case_id: str) -> None:
    """Raise when ``runs`` breaks a storage bound: at most
    :data:`MAX_RUNS_PER_CASE` runs (:class:`RunLimitReached`), unique run ids, each
    run on ``case_id`` and at most one run per runbook (#4), at most
    :data:`RUNBOOK_STEP_MAX_EVIDENCE` evidence items per step and at most
    :data:`RUNBOOK_CASE_EVIDENCE_MAX_BYTES` of kept lookup tables
    (:class:`RunDocumentFull`). The 1 MiB document bound is checked by the writer on
    the encoded document."""
    if len(runs) > MAX_RUNS_PER_CASE:
        raise RunLimitReached()
    run_ids = [r.run_id for r in runs]
    if len(set(run_ids)) != len(run_ids):
        raise ValueError("Two runs on a case share one run id.")
    runbook_ids = [r.runbook_id for r in runs]
    if len(set(runbook_ids)) != len(runbook_ids):
        raise ValueError("A runbook attaches to a case at most once.")
    for run in runs:
        if run.case_id != case_id:
            raise ValueError("A run belongs to another case.")
        for state in run.steps.values():
            if len(state.evidence) > RUNBOOK_STEP_MAX_EVIDENCE:
                raise RunDocumentFull("evidence_count")
    if lookup_table_bytes(runs) > RUNBOOK_CASE_EVIDENCE_MAX_BYTES:
        raise RunDocumentFull("evidence")


# --------------------------------------------------------------------------- #
# The store.
# --------------------------------------------------------------------------- #
class RunbookRunStore:
    """Strict read-modify-write over per-case run documents and the run ledger
    (``RunbookRunStore(kv)``: the real store over the shared KV, or the Demo
    stack's over its own KV)."""

    def __init__(self, kv: Any) -> None:
        self._kv = kv
        # One lock per case document and per ledger month, so in-process writers never
        # fight (across processes the ``_rev`` compare-and-set is the arbiter). Weak
        # values bound the registries: a lock exists only while a writer holds or
        # awaits it (its ``async with`` keeps a strong reference), so a long-running
        # process does not keep one lock per case it ever wrote.
        self._case_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()
        self._ledger_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()
        self._swept_for: str | None = None

    @property
    def kv(self) -> Any:
        return self._kv

    # ----- strict KV primitives ------------------------------------------- #
    def _case_lock(self, case_id: str) -> asyncio.Lock:
        lock = self._case_locks.get(case_id)
        if lock is None:
            lock = self._case_locks[case_id] = asyncio.Lock()
        return lock

    def _ledger_lock(self, month: str) -> asyncio.Lock:
        lock = self._ledger_locks.get(month)
        if lock is None:
            lock = self._ledger_locks[month] = asyncio.Lock()
        return lock

    async def _get(self, key: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None)
        try:
            value = (
                await getter(RUNBOOK_RUNS_NS, key) if callable(getter)
                else await self._kv.get(RUNBOOK_RUNS_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise RunbookStoreUnavailable("Runbook runs could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise RunbookStoreUnavailable("Runbook runs storage returned an invalid document.")
        return copy.deepcopy(value)

    async def _put_if(self, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        try:
            ok = bool(
                await writer(RUNBOOK_RUNS_NS, key, value, expected_rev) if callable(writer)
                else await self._kv.put_if(RUNBOOK_RUNS_NS, key, value, expected_rev)
            )
        except Exception as exc:  # noqa: BLE001
            raise RunbookStoreUnavailable("Runbook runs could not be saved.") from exc
        if not ok:
            return False
        confirmed = await self._get(key)
        if _rev(confirmed) < int(value.get(REV_FIELD, 0)):
            raise RunbookStoreUnavailable("Runbook runs storage did not confirm the write.")
        return True

    # ----- case documents ------------------------------------------------- #
    async def get(self, case_id: str) -> CaseRuns:
        """Every run on ``case_id`` (an empty tuple and revision 0 before the first)."""
        case_id = _require_case_id(case_id)
        doc = await self._get(case_key(case_id))
        return CaseRuns(case_id=case_id, runs=decode_case(doc), revision=_rev(doc))

    async def get_many(self, case_ids: Iterable[str], *, concurrency: int = 8) -> dict[str, CaseRuns]:
        """:meth:`get` for several cases with at most ``concurrency`` reads at once
        (``POST /api/runbooks/progress`` reads at most 8 at once). Unknown or invalid
        ids are skipped; a storage failure raises."""
        ids = [c for c in dict.fromkeys(case_ids) if valid_case_id(c)]
        gate = asyncio.Semaphore(max(1, int(concurrency)))

        async def _one(case_id: str) -> CaseRuns:
            async with gate:
                return await self.get(case_id)

        results = await asyncio.gather(*(_one(c) for c in ids))
        return {r.case_id: r for r in results}

    async def mutate(
        self,
        case_id: str,
        change: Callable[[list[RunbookRun]], tuple[list[RunbookRun] | None, _T]],
        *,
        expected_revision: int | None = None,
    ) -> tuple[_T, CaseRuns]:
        """Read-modify-write one case's runs. ``change`` receives a deep copy of the
        stored runs and returns ``(new_runs, result)``; ``new_runs is None`` is a
        no-op. It may raise a domain error, and nothing is written. Bounds are
        checked on the new runs (:func:`check_case_runs`) and the 1 MiB document size.

        With ``expected_revision`` (a person's edit made against what they saw), a
        document at another revision is :class:`RunConflict` and never retried.
        Without it the write is retried on a lost race up to :data:`CAS_RETRIES`
        times, re-running ``change`` on the fresh runs, then
        :class:`RunbookStoreUnavailable`."""
        case_id = _require_case_id(case_id)
        async with self._case_lock(case_id):
            for _attempt in range(CAS_RETRIES + 1):
                current = await self._get(case_key(case_id))
                revision = _rev(current)
                runs = decode_case(current)
                if expected_revision is not None and int(expected_revision) != revision:
                    raise RunConflict(case_id, revision)
                proposed_runs, result = change([r.model_copy(deep=True) for r in runs])
                if proposed_runs is None:
                    return result, CaseRuns(case_id=case_id, runs=runs, revision=revision)
                check_case_runs(proposed_runs, case_id)
                proposed = encode_case(case_id, proposed_runs)
                proposed[REV_FIELD] = revision + 1
                if _bytes(proposed) > RUNBOOK_CASE_DOC_MAX_BYTES:
                    raise RunDocumentFull("size")
                if await self._put_if(case_key(case_id), proposed, revision):
                    return result, CaseRuns(
                        case_id=case_id, runs=tuple(proposed_runs), revision=revision + 1,
                    )
                if expected_revision is not None:
                    latest = await self._get(case_key(case_id))
                    raise RunConflict(case_id, _rev(latest))
            raise RunbookStoreUnavailable("This case's runbook changed too quickly; try again.")

    async def record_lookup_result(
        self, case_id: str, run_id: str, step_id: str, result: LookupResult,
    ) -> LookupWrite:
        """Store a lookup result as the step's evidence (``kind="lookup_result"``,
        SPEC §4.10.6, §4.10.8).

        The step's earlier lookup result, if any, is REPLACED (a re-run replaces the
        automatic result; links and tickets stay). Before writing, the case's kept
        lookup tables are measured: a result whose table would take them past
        :data:`RUNBOOK_CASE_EVIDENCE_MAX_BYTES`, or the document past
        :data:`RUNBOOK_CASE_DOC_MAX_BYTES`, is stored with its ``table`` dropped and
        ``reason`` set to :data:`EVIDENCE_LIMIT_NOTE` (count, relation, facts and
        parameters kept). A result without a table is not measured against the
        evidence budget, so a case at its evidence limit keeps recording later
        lookups; only a document that would pass 1 MiB even without the table raises
        :class:`RunDocumentFull` (``"size"``). The write does not depend on what
        another writer changed, so a lost race is retried on a fresh read. It never
        changes a step's status or ``revision`` (it changes nothing a person wrote, so
        a person's pending edit of that step never conflicts with it). Raises
        :class:`RunNotFound` or :class:`StepNotFound`."""
        holder: dict[str, Any] = {}

        def _change(runs: list[RunbookRun]) -> tuple[list[RunbookRun], None]:
            run = next((r for r in runs if r.run_id == run_id), None)
            if run is None:
                raise RunNotFound(run_id)
            if not any(step.id == step_id for step in run.snapshot.steps):
                raise StepNotFound(step_id)
            state = run.steps.get(step_id) or StepState()
            kept = [e for e in state.evidence if e.kind != "lookup_result"]
            replaced = len(kept) != len(state.evidence)
            # The case's tables without this step's earlier lookup result (which the
            # new one replaces), then the new result on top.
            run.steps[step_id] = state.model_copy(update={"evidence": kept})
            base_tables = lookup_table_bytes(runs)
            stored = result.model_copy(deep=True)
            dropped = False
            if stored.table is not None:
                run.steps[step_id] = state.model_copy(update={
                    "evidence": [*kept, StepEvidence(kind="lookup_result", lookup=stored)],
                })
                over_budget = base_tables + _bytes(stored.table) > RUNBOOK_CASE_EVIDENCE_MAX_BYTES
                if over_budget or _document_bytes(case_id, runs) > RUNBOOK_CASE_DOC_MAX_BYTES:
                    stored = stored.model_copy(update={
                        "table": None, "table_kind": None, "reason": EVIDENCE_LIMIT_NOTE,
                    })
                    dropped = True
            run.steps[step_id] = state.model_copy(update={
                "evidence": [*kept, StepEvidence(kind="lookup_result", lookup=stored)],
            })
            holder.update(result=stored, replaced=replaced, dropped=dropped)
            return runs, None

        _, case = await self.mutate(case_id, _change)
        return LookupWrite(
            result=holder["result"], replaced=bool(holder["replaced"]),
            table_dropped=bool(holder["dropped"]), case=case,
        )

    async def delete_case(self, case_id: str) -> bool:
        """Remove every run of one case (a tombstone; the KV contract has no delete).
        Returns False when the case had no run document."""
        case_id = _require_case_id(case_id)
        async with self._case_lock(case_id):
            for _attempt in range(CAS_RETRIES + 1):
                current = await self._get(case_key(case_id))
                if current is None or current.get(DELETED_FIELD) is True:
                    return False
                revision = _rev(current)
                tomb = {
                    SCHEMA_FIELD: _SCHEMA_VERSION, STORE_FIELD: RUNBOOK_RUNS_NS,
                    CASE_FIELD: stored_case_label(case_id), DELETED_FIELD: True, RUNS_FIELD: None,
                    REV_FIELD: revision + 1,
                }
                if await self._put_if(case_key(case_id), tomb, revision):
                    return True
            raise RunbookStoreUnavailable("This case's runbook changed too quickly; try again.")

    # ----- the ledger ----------------------------------------------------- #
    async def upsert_ledger_row(self, row: RunbookLedgerRow, *, now: datetime | None = None) -> LedgerWrite:
        """Write one run's ledger row into the month it started (replacing its earlier
        row for the same ``run_id``). Called only on run-level transitions. A row that
        does not fit the 512 KiB month is not stored and is counted in ``evicted``
        (an existing row that no longer fits is removed and counted); the month then
        reads ``partial``. A row for a month past retention is not written. Months
        older than retention are swept once per process per month."""
        month = month_of(row.started_at, default=now)
        keep = retained_months(now)
        await self._sweep_old_months(keep[0], keep)
        if month not in keep:
            if month > keep[0]:
                month = keep[0]  # a start time in the future is filed this month
            else:
                logger.info("runbook ledger: run %s started past retention; not written", row.run_id[:80])
                return LedgerWrite(month=month, stored=False, evicted=False)
        key = ledger_key(month)
        async with self._ledger_lock(month):
            for _attempt in range(CAS_RETRIES + 1):
                current = await self._get(key)
                rows, evicted = _decode_ledger(current)
                others = [r for r in rows if r.run_id != row.run_id]
                had_row = len(others) != len(rows)
                candidate = _encode_ledger(month, [*others, row], evicted)
                candidate[REV_FIELD] = _rev(current) + 1
                stored = True
                if _bytes(candidate) > RUNBOOK_LEDGER_MONTH_MAX_BYTES:
                    stored = False
                    candidate = _encode_ledger(month, others, evicted + 1)
                    candidate[REV_FIELD] = _rev(current) + 1
                    if had_row:
                        logger.info("runbook ledger %s: row %s no longer fits; evicted", month, row.run_id[:80])
                if await self._put_if(key, candidate, _rev(current)):
                    return LedgerWrite(month=month, stored=stored, evicted=not stored)
            raise RunbookStoreUnavailable("The runbook ledger changed too quickly; try again.")

    async def read_ledger(self, months: Iterable[str]) -> list[LedgerMonth]:
        """The ledger months named (``yyyy-mm``), oldest first; a month without a
        document reads as empty."""
        wanted = sorted({m for m in months if isinstance(m, str) and _MONTH_RE.fullmatch(m)})
        out: list[LedgerMonth] = []
        for month in wanted:
            rows, evicted = _decode_ledger(await self._get(ledger_key(month)))
            out.append(LedgerMonth(month=month, rows=tuple(rows), evicted=evicted))
        return out

    async def read_ledger_window(self, start: datetime, end: datetime) -> list[LedgerMonth]:
        """Every retained ledger month that overlaps ``[start, end]``."""
        first, last = month_of(start.isoformat()), month_of(end.isoformat())
        months: list[str] = []
        cursor = first
        while cursor <= last and len(months) <= RUNBOOK_LEDGER_MONTHS_KEPT + 1:
            months.append(cursor)
            cursor = shift_month(cursor, 1)
        keep = set(retained_months())
        return await self.read_ledger(m for m in months if m in keep)

    async def _sweep_old_months(self, current: str, keep: list[str]) -> None:
        """Delete the ledger months past retention, at most once per process per
        month: the :data:`LEDGER_SWEEP_MONTHS` months before the oldest kept one are
        read and any that holds rows is tombstoned. Best-effort: a failure is logged
        and retried on a later write."""
        if self._swept_for == current:
            return
        oldest = keep[-1]
        try:
            for back in range(1, LEDGER_SWEEP_MONTHS + 1):
                month = shift_month(oldest, -back)
                key = ledger_key(month)
                doc = await self._get(key)
                if doc is None or doc.get(DELETED_FIELD) is True:
                    continue
                tomb = {
                    SCHEMA_FIELD: _SCHEMA_VERSION, STORE_FIELD: RUNBOOK_RUNS_NS,
                    MONTH_FIELD: month, DELETED_FIELD: True, LEDGER_FIELD: None,
                    REV_FIELD: _rev(doc) + 1,
                }
                await self._put_if(key, tomb, _rev(doc))
            self._swept_for = current
        except RunbookStoreUnavailable as exc:
            logger.warning("runbook ledger sweep failed (%s); retried on a later write", exc)
