"""Repository interfaces for the suite's OWN management state (Epoch A).

The suite's bookkeeping — cases, audit, usage, config, cursor and RAG vectors —
is persisted behind these abstract repositories so the SAME callers (pipeline,
chat, standup, poller, routes, state) work unchanged whether the backend is
Elasticsearch (the default) or a SQL database (SQLite for dev/test, PostgreSQL
+pgvector for production).

The method signatures here mirror the existing ES-backed stores EXACTLY, so the
ES classes (``CaseStore``/``AuditLogger``/``UsageStore``/``ConfigStore``/
``CursorStore``) already satisfy them — they simply declare the contract their
SQL counterparts (``SqlCaseRepository``/...) must reproduce.

Non-negotiable #2 (audit is append-only) is encoded in the interface: an audit
repository exposes ONLY ``write``/``record``/``records_for_case`` — there is no
update or delete on a recorded action, in any backend.
"""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..build_identity import stamp_new_record
from ..config import Preferences
from ..constants import (
    OPEN_CASE_STATUSES,
    TERMINAL_CASE_STATUSES,
    ActionType,
)
from ..models import AuditDoc, Case, Cursor, UsageDoc
from ..utils import parse_millis_strict, relative_to_millis_strict, truncate

logger = logging.getLogger("tlsoc.stores.base")

# The compare-and-set revision field a :meth:`KVStore.mutate` stamps into the
# stored value so concurrent read-modify-write writers can detect a lost update
# and retry instead of silently clobbering each other. It rides INSIDE the value
# dict so the contract is backend-agnostic and needs no schema change. Native
# backends may additionally fence the physical write (Elasticsearch uses
# ``_seq_no``/``_primary_term``; SQL uses a revision predicate). A stored doc that
# predates this field reads as rev 0 (back-compat).
KV_REV_FIELD = "_rev"

# How many times :func:`kv_mutate` re-runs the load→mutate→save cycle when a
# concurrent writer bumped the revision under it. Small + bounded: at operator
# scale (collaboration / notification writes, NOT log volume) contention is rare,
# and the per-key lock already serialises same-process writers so a retry is only
# needed for a genuine multi-process / multi-replica race.
_KV_MUTATE_RETRIES = 8


async def kv_mutate(
    kv: Any,
    namespace: str,
    key: str,
    mutator: Callable[[dict[str, Any] | None], Awaitable[dict[str, Any]] | dict[str, Any]],
    *,
    lock: asyncio.Lock,
) -> dict[str, Any]:
    """Atomic, lost-update-safe read-modify-write over a single KV document.

    Duck-typed on ``kv`` (anything exposing async ``get(ns, key)`` / ``put(ns,
    key, value)`` — the real ``KVStore`` subclasses AND the offline test fakes),
    so a store can route its mutations through this regardless of the concrete
    backend. The shared single-document KV stores (inbox, memory, case
    threads/activity/tasks, notif prefs, custom roles, price overlay, shift
    handoff, user prefs) all mutate ONE doc by load→mutate→save; two coroutines /
    processes that interleave that cycle silently drop one writer's change. This
    closes that WITHOUT a new index/column:

      1. the caller-owned ``lock`` (a per-store :class:`asyncio.Lock`) serialises
         writers in THIS process — the primary defence for the single-uvicorn
         deployment these stores target; and
      2. a ``_rev`` revision stamped INTO the value gives compare-and-set: each
         attempt re-reads, applies ``mutator`` to a FRESH snapshot and bumps
         ``_rev``; if the persisted ``_rev`` moved under us (a multi-process /
         multi-replica race the in-process lock can't see), the cycle retries on
         the new snapshot.

    ``mutator(current_value_or_None) -> new_value`` MUST be a pure function of its
    snapshot (it may run more than once). The fast path (no contention) is one
    get + one put + one verify-get — and the new value is byte-compatible with the
    old hand-rolled save except for the additive ``_rev`` bookkeeping key. NEVER
    raises: on a backend glitch / exhausted retries it logs and returns the last
    computed value so the store degrades rather than dropping the write.
    """
    async with lock:
        last: dict[str, Any] | None = None
        for attempt in range(_KV_MUTATE_RETRIES):
            try:
                current = await kv.get(namespace, key)
            except Exception as exc:  # noqa: BLE001 — degrade, never raise
                logger.warning("KV mutate get(%s/%s) failed: %s", namespace, key, exc)
                current = None
            base_rev = _rev_of(current)
            result = mutator(current)
            if asyncio.iscoroutine(result):
                result = await result  # type: ignore[assignment]
            new_value = dict(result or {})
            new_value[KV_REV_FIELD] = base_rev + 1
            last = new_value
            # Prefer an ATOMIC conditional write when the backend provides one
            # (``put_if`` writes ONLY if the stored ``_rev`` still equals ``base_rev``),
            # which genuinely serialises multi-process writers — a verify-after-write can
            # NOT (two writers at the same base both see the new rev and both "succeed",
            # silently losing one) (audit #27). Backends without ``put_if`` (or a raw
            # duck-typed fake) fall back to the best-effort put + verify — correct under
            # the per-key in-process lock (the single-uvicorn deployment).
            put_if = getattr(kv, "put_if", None)
            if put_if is not None:
                try:
                    ok = await put_if(namespace, key, new_value, base_rev)
                except Exception as exc:  # noqa: BLE001 — degrade, never raise
                    logger.warning("KV mutate put_if(%s/%s) failed: %s", namespace, key, exc)
                    return new_value
                if ok:
                    return new_value
                logger.debug(
                    "KV mutate(%s/%s) put_if conflict; retry %d", namespace, key, attempt + 1
                )
                continue
            try:
                await kv.put(namespace, key, new_value)
            except Exception as exc:  # noqa: BLE001 — degrade, never raise
                logger.warning("KV mutate put(%s/%s) failed: %s", namespace, key, exc)
                return new_value
            # Confirm no concurrent writer advanced the revision between our read
            # and write (the multi-process race the in-process lock can't cover).
            # The same-process lock makes this a no-op fast path.
            try:
                persisted = await kv.get(namespace, key)
            except Exception as exc:  # noqa: BLE001
                logger.warning("KV mutate verify(%s/%s) failed: %s", namespace, key, exc)
                return new_value
            if _rev_of(persisted) == base_rev + 1:
                return new_value
            logger.debug(
                "KV mutate(%s/%s) CAS retry %d (saw rev %d, expected %d)",
                namespace, key, attempt + 1, _rev_of(persisted), base_rev + 1,
            )
        logger.warning(
            "KV mutate(%s/%s) exhausted %d retries; best-effort write stands",
            namespace, key, _KV_MUTATE_RETRIES,
        )
        return last or {}


async def kv_mutate_strict(
    kv: Any,
    namespace: str,
    key: str,
    mutator: Callable[[dict[str, Any] | None], Awaitable[dict[str, Any]] | dict[str, Any]],
    *,
    lock: asyncio.Lock,
) -> dict[str, Any]:
    """Confirmed variant of :func:`kv_mutate` for durability boundaries.

    Most Console KV collections intentionally fail soft. Batch submission/result
    state is different: an ingest cursor, ledger fold, or case-pipeline handoff is
    only safe after its state transition is durably confirmed. This helper therefore
    propagates backend errors and raises after bounded CAS conflicts instead of
    returning an unpersisted candidate value.
    """
    async with lock:
        get = getattr(kv, "get_strict", None) or kv.get
        put_if = getattr(kv, "put_if_strict", None) or getattr(kv, "put_if", None)
        put = getattr(kv, "put_strict", None) or kv.put
        for attempt in range(_KV_MUTATE_RETRIES):
            current = await get(namespace, key)
            base_rev = _rev_of(current)
            result = mutator(current)
            if asyncio.iscoroutine(result):
                result = await result  # type: ignore[assignment]
            new_value = dict(result or {})
            new_value[KV_REV_FIELD] = base_rev + 1
            if put_if is not None:
                if await put_if(namespace, key, new_value, base_rev):
                    return new_value
                logger.debug(
                    "Strict KV mutate(%s/%s) conflict; retry %d",
                    namespace,
                    key,
                    attempt + 1,
                )
                continue
            await put(namespace, key, new_value)
            persisted = await get(namespace, key)
            if _rev_of(persisted) == base_rev + 1:
                return new_value
        raise RuntimeError(
            f"strict KV mutate conflict for {namespace}/{key} after "
            f"{_KV_MUTATE_RETRIES} attempts"
        )


def _rev_of(value: Any) -> int:
    """The ``_rev`` of a stored value (0 when absent / pre-CAS / malformed)."""
    if isinstance(value, dict):
        try:
            return int(value.get(KV_REV_FIELD, 0) or 0)
        except (TypeError, ValueError):
            return 0
    return 0


def _parse_iso_utc(ts: Any) -> datetime | None:
    """Best-effort aware-UTC datetime for an ISO string (None when unparseable).

    Used by the :meth:`CaseRepository.count_created_since` compatibility fallback so
    the comparison is timestamp-correct across ``Z``/offset/naive formats rather than
    a fragile lexicographic string compare."""
    if not isinstance(ts, str) or not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


# How many rows the compatibility :meth:`CaseRepository.list_window` fallback scans
# before filtering in Python. Same bound (and same honesty) as the
# :meth:`CaseRepository.count_created_since` fallback: exact while the store holds
# fewer rows than this, a lower bound beyond it — which is precisely why that path
# reports ``exact=False``.
WINDOW_FALLBACK_SCAN = 10000


def case_in_created_window(case: Any, lo: int | None, hi: int | None) -> bool:
    """Is this case inside the inclusive ``[lo, hi]`` epoch-millis window?

    NEVER-DROP (#4): an empty, missing or UNPARSEABLE ``created_at`` returns ``True``.
    A record we cannot place in time is surfaced, never silently deleted from the
    operator's view of a window. "Unparseable" means exactly what
    :func:`~app.utils.parse_millis_strict` says it means — this function is the ONE
    definition of the contract, and both native push-downs are built to agree with it
    (``tests/test_case_window_store.py`` pins that agreement over a grid of unreadable
    spellings rather than one lucky literal)."""
    ts = getattr(case, "created_at", "") or ""
    if not ts:
        return True
    millis = parse_millis_strict(ts)
    if millis is None:
        return True
    if lo is not None and millis < lo:
        return False
    if hi is not None and millis > hi:
        return False
    return True


# A SCALAR name for a MULTI-status lifecycle set, resolved here from the product's own
# status constants rather than sent as a list by the caller. Two reasons it is a scalar:
#
#   * the console's query helper stringifies an array into ONE comma-joined term, which a
#     store applies as a single exact match and which therefore silently matches nothing —
#     no error is raised at any layer, so a multi-value status filter fails invisibly; and
#   * a set the SERVER owns cannot drift from the lifecycle taxonomy the rest of the suite
#     decides with. The membership below is `constants.OPEN_CASE_STATUSES` /
#     `constants.TERMINAL_CASE_STATUSES` verbatim, never a restated list.
#
# ``active`` rather than ``open`` deliberately: ``open`` is ALSO one concrete
# ``CaseStatus`` value, and a group whose name collides with a member of the very
# vocabulary it groups is a trap for both operators and readers.
CASE_STATUS_GROUPS: dict[str, tuple[str, ...]] = {
    "active": OPEN_CASE_STATUSES,
    "terminal": TERMINAL_CASE_STATUSES,
}


def status_group_statuses(group: str | None) -> tuple[str, ...] | None:
    """Resolve a status-group name to its statuses (``None`` when no group applies).

    An UNKNOWN name also resolves to ``None`` here. That is deliberate: this helper is
    the shared resolution step for the stores, and rejecting an unknown name is the
    HTTP boundary's job (a store that silently applied "no filter" for a typo would
    hand back the whole corpus and call it a lifecycle set)."""
    if not group:
        return None
    return CASE_STATUS_GROUPS.get(str(group))


def case_in_status_group(case: Any, statuses: tuple[str, ...] | None) -> bool:
    """Is this case's status inside ``statuses``? ``None`` means "no group asked for".

    The ONE in-Python definition of the group predicate, so the bundled push-downs have
    something to be proven equal to rather than something to be assumed equal to."""
    if statuses is None:
        return True
    value = getattr(case, "status", None)
    value = getattr(value, "value", value)
    return str(value or "") in statuses


def window_bounds_proven(
    created_from: Any, created_to: Any, lo: Any, hi: Any
) -> bool:
    """Did EVERY bound the caller actually asked for resolve to a usable value?

    The ``exact`` flag of :meth:`CaseRepository.list_window` claims that ``total`` is
    the PROVEN count for the REQUESTED window, so it may only be ``True`` when the
    window the store applied IS the window that was requested. A bound that was
    supplied but could not be read is dropped (never silently resolved to ``now()``,
    which would empty the window) — the resulting answer is still useful, but it
    answers a WIDER question than the caller asked, so it is not proof.

    Without this the requested-but-unreadable case is indistinguishable from the
    windowless one: both leave ``lo``/``hi`` at ``None``, and stamping that shared
    branch ``True`` reported the WHOLE-CORPUS total as a proven windowed count."""
    return (not created_from or lo is not None) and (not created_to or hi is not None)


class CaseRepository(ABC):
    """Persists :class:`Case` documents (Section 7.1).

    Writes are idempotent overwrites keyed by ``case_id``; investigation-level
    idempotency is enforced one layer up via ``find_open_by_signature``.
    """

    @abstractmethod
    async def save(self, case: Case) -> None: ...

    @abstractmethod
    async def get(self, case_id: str) -> Case | None: ...

    @abstractmethod
    async def find_open_by_signature(self, signature: str) -> Case | None:
        """Return an OPEN/NEEDS_HUMAN case for this cluster signature, if any."""

    @abstractmethod
    async def list(
        self,
        *,
        status: str | None = None,
        source_surface: str | None = None,
        entity_value: str | None = None,
        limit: int = 50,
        offset: int = 0,
        sort_field: str = "created_at",
        sort_order: str = "desc",
    ) -> tuple[list[Case], int]:
        """Filtered, sorted, paged listing → (cases, total_matching)."""

    @abstractmethod
    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        """Surface 3: the automated-scans queue."""

    @abstractmethod
    async def count_new_scans(self, since_iso: str) -> int:
        """Count automated-scan cases created strictly after ``since_iso``."""

    async def count_created_since(self, since_iso: str) -> int:
        """Count cases created at/after ``since_iso`` (inclusive), across every
        surface/status.

        A pure COUNT push-down for callers that only need the number (e.g. the
        sources-coverage "alerts triaged in 24h" tile) — fetching and validating
        thousands of full Case documents just to ``len()`` a window is the exact
        cost this avoids. Modeled on :meth:`count_new_scans`; the bundled ES/SQL
        repositories override it with a native backend count.

        This NON-abstract default keeps third-party repositories source-compatible:
        it falls back to counting over one bounded ``list()`` page (a correct
        lower bound; exact whenever the store holds fewer rows than the page)."""
        floor = _parse_iso_utc(since_iso)
        if floor is None:
            return 0
        cases, _total = await self.list(limit=10000)
        count = 0
        for case in cases:
            created = _parse_iso_utc(getattr(case, "created_at", None))
            if created is not None and created >= floor:
                count += 1
        return count

    async def list_window(
        self,
        *,
        created_from: str | None = None,
        created_to: str | None = None,
        status_group: str | None = None,
        **kw: Any,
    ) -> tuple[list[Case], int, bool]:
        """:meth:`list`, additionally windowed on ``created_at`` → (cases, total, exact).

        ``created_from``/``created_to`` are OPTIONAL inclusive bounds accepting either an
        absolute ISO timestamp or a relative ``now-24h`` expression (whatever the console
        time-range picker emits). ``**kw`` is forwarded to :meth:`list` verbatim, so every
        existing filter/sort/page argument keeps working.

        ``total`` is the count of rows matching the filters AND the window across the WHOLE
        corpus, and ``exact`` says whether the repository could prove that number FOR THE
        REQUESTED WINDOW. The bundled Elasticsearch/SQL repositories push the window into
        the backend and report ``exact=True`` whenever every supplied bound resolved; this
        NON-abstract default keeps third-party repositories
        source-compatible (adding a keyword to the abstract :meth:`list` would break them
        with a ``TypeError``) by scanning one bounded :meth:`list` page and filtering in
        Python, which is a correct lower bound — exact only when the store holds fewer rows
        than the scan — so it honestly reports ``exact=False``. Modeled on
        :meth:`count_created_since`.

        NEVER-DROP (#4): a case whose ``created_at`` is empty, missing or UNPARSEABLE is
        KEPT rather than silently excluded from every historical window. The parse uses
        :func:`~app.utils.parse_millis_strict`, which REPORTS failure — the lenient
        :func:`~app.utils.relative_to_millis` resolves an unreadable timestamp to ``now()``,
        which looks like a successful parse and drops the row.

        With no window requested this is exactly :meth:`list`, and ONLY that case reports
        ``exact=True`` here. A bound that was requested but could not be read also leaves
        both bounds ``None`` and falls into the same plain-:meth:`list` branch — but the
        answer is then the whole corpus, not the requested window, so it reports
        ``exact=False`` (see :func:`window_bounds_proven`).

        ``status_group`` is an OPTIONAL scalar naming a multi-status lifecycle set
        (:data:`CASE_STATUS_GROUPS`). It is an explicit NAMED parameter here and is
        consumed here — deliberately never forwarded into ``**kw`` and never added to
        the abstract :meth:`list`, because a new keyword on an abstract method breaks
        every third-party repository with a ``TypeError``. A repository that implements
        only the abstract surface therefore keeps working: it takes this same bounded
        scan, filters the group in Python against the same constants the push-downs
        use, and says so by reporting ``exact=False`` even when NO time window was
        requested. "Windowless but not exact" is a real state a client must be able to
        read; it must never be presented as a complete page."""
        lo = relative_to_millis_strict(created_from) if created_from else None
        hi = relative_to_millis_strict(created_to) if created_to else None
        proven = window_bounds_proven(created_from, created_to, lo, hi)
        group = status_group_statuses(status_group)
        if lo is None and hi is None and group is None:
            cases, total = await self.list(**kw)
            return cases, total, proven
        limit = max(0, int(kw.pop("limit", 50) or 0))
        offset = max(0, int(kw.pop("offset", 0) or 0))
        scanned, _total = await self.list(limit=WINDOW_FALLBACK_SCAN, offset=0, **kw)
        kept = [
            c for c in scanned
            if case_in_created_window(c, lo, hi) and case_in_status_group(c, group)
        ]
        page = kept[offset: offset + limit] if limit else []
        return page, len(kept), False

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[Case], Any | None, int | None, str]:
        """One deterministic oldest-first page for a full-history export.

        ``cursor`` is repository-private continuation state; callers must treat it as
        opaque.  The compatibility implementation uses the existing offset listing so
        third-party repositories gain a correct, if less efficient, export path without
        implementing a new abstract method.  Bundled Elasticsearch stores override this
        with ``search_after`` so exports can pass the result-window ceiling.

        Returns ``(rows, next_cursor, snapshot_total, consistency)``. ``snapshot_total`` is the
        exact matching count observed while this page was read when the backend can
        prove it, otherwise ``None``.
        """
        try:
            offset = max(0, int(cursor or 0))
        except (TypeError, ValueError):
            offset = 0
        rows, total = await self.list(
            limit=max(1, int(limit)),
            offset=offset,
            sort_field="created_at",
            sort_order="asc",
        )
        next_cursor = offset + len(rows) if offset + len(rows) < total else None
        return rows, next_cursor, int(total), "bounded_at_start"

    async def close_export_cursor(self, cursor: Any) -> None:
        """Release an optional repository-owned export snapshot handle."""
        return None


class AuditRepository(ABC):
    """Append-only audit log (Section 7.2 / Non-negotiable #2).

    There is intentionally NO update/delete here: a recorded action is immutable
    in every backend.
    """

    @abstractmethod
    async def write(self, doc: AuditDoc) -> None: ...

    async def write_strict(self, doc: AuditDoc) -> None:
        """Persist an audit row or raise when durability cannot be confirmed.

        Normal investigation telemetry remains fail-soft through :meth:`write`.
        Privileged data delivery uses this explicit boundary so a successful HTTP
        response cannot bypass the append-only audit invariant.
        """
        raise NotImplementedError("audit repository does not implement strict persistence")

    @abstractmethod
    async def record(
        self,
        *,
        action_type: ActionType,
        surface: str = "",
        actor: str = "",
        case_id: str | None = None,
        source_id: str | None = None,
        model: str | None = None,
        prompt_excerpt: str | None = None,
        query_text: str | None = None,
        tool_name: str | None = None,
        tool_input: Any = None,
        tool_output_summary: str | None = None,
        result_summary: str | None = None,
    ) -> None: ...

    async def record_strict(
        self,
        *,
        action_type: ActionType,
        event_id: str | None = None,
        ts: str | None = None,
        surface: str = "",
        actor: str = "",
        case_id: str | None = None,
        source_id: str | None = None,
        model: str | None = None,
        prompt_excerpt: str | None = None,
        query_text: str | None = None,
        tool_name: str | None = None,
        tool_input: Any = None,
        tool_output_summary: str | None = None,
        result_summary: str | None = None,
    ) -> None:
        """Build and strictly persist one append-only audit document."""
        await self.write_strict(
            stamp_new_record(
                AuditDoc(
                    event_id=event_id,
                    **({"ts": ts} if ts else {}),
                    action_type=action_type,
                    surface=surface,
                    actor=actor,
                    case_id=case_id,
                    source_id=source_id,
                    model=model,
                    prompt_excerpt=truncate(prompt_excerpt, 1000) if prompt_excerpt else None,
                    query_text=query_text,
                    tool_name=tool_name,
                    tool_input=tool_input,
                    tool_output_summary=(
                        truncate(tool_output_summary, 1000)
                        if tool_output_summary
                        else None
                    ),
                    result_summary=(
                        truncate(result_summary, 1000) if result_summary else None
                    ),
                )
            )
        )

    @abstractmethod
    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """All audit rows for a case, OLDEST first. Never raises."""

    async def records_for_actor(self, actor: str, limit: int = 50) -> list[dict[str, Any]]:
        """Recent audit rows attributed to ``actor`` (NEWEST first) — the per-user
        account-activity feed (Wave 3). NON-abstract with a safe default ([]) so a
        third-party AuditRepository keeps working; the bundled ES/SQL stores override
        it. Never raises."""
        return []

    async def records(
        self,
        *,
        actor: str | None = None,
        action_type: str | None = None,
        surface: str | None = None,
        case_id: str | None = None,
        source_id: str | None = None,
        ts_from: str | None = None,
        ts_to: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Filtered, bounded, read-only listing of the append-only audit (the admin
        audit viewer, W7c). NEWEST first. NON-abstract with a safe default ([]) so a
        third-party AuditRepository keeps working; the bundled ES/SQL stores override
        it. Read-only (#2 — never mutates). Never raises. ``source_id`` (A5.3 coverage
        observability) filters to a single source's poll history."""
        return []

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """One oldest-first audit page for the portable full-history export.

        The default is deliberately conservative: legacy repositories can return one
        bounded page, but cannot claim that it is complete when the page fills.  The
        bundled Elasticsearch and SQL repositories provide resumable, exact-count
        implementations.
        """
        if cursor not in (None, 0, "", []):
            return [], None, None, "unverified"
        rows = list(reversed(await self.records(limit=max(1, int(limit)))))
        total = len(rows) if len(rows) < max(1, int(limit)) else None
        return rows, None, total, "unverified" if total is None else "bounded_at_start"

    async def close_export_cursor(self, cursor: Any) -> None:
        return None


class UsageRepository(ABC):
    """Token & cost ledger (Section 7.3). Written ONLY by the LLM gateway (#6)."""

    @abstractmethod
    async def write(self, doc: UsageDoc) -> None: ...

    async def write_strict(self, doc: UsageDoc) -> None:
        """Durably write ``doc`` or raise.

        Bundled stores override this with idempotent persistence for async Batch
        folding. A third-party repository must opt into this contract explicitly;
        falling back to ``write`` would be unsafe because the legacy method is allowed
        to fail soft. Batch result folding therefore fails closed until implemented.
        """
        raise NotImplementedError("usage repository does not implement strict persistence")

    @abstractmethod
    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        """Windowed cost/token summary for the in-plugin cost panel."""

    async def total_pipeline_cost_for_case(self, case_id: str) -> float | None:
        """Return the all-time investigation-pipeline total for one case.

        The safe default keeps third-party repositories source-compatible. Bundled
        repositories override it with an exact, unbounded aggregation restricted to
        router/investigator/formatter usage so a case can reconcile its rounded display
        total without absorbing case-scoped Chat or overview spend.
        ``None`` means the ledger could not prove a total; callers must preserve their
        existing fail-soft accounting in that case.
        """
        return None

    async def records(self, *, limit: int = 1000) -> list[dict[str, Any]]:
        """Newest-first, bounded ledger export. The safe default keeps third-party
        repositories source-compatible; bundled ES/SQL repositories override it."""
        return []

    async def records_strict(self, *, limit: int = 1000) -> list[dict[str, Any]]:
        """Newest-first bounded rows, raising when availability cannot be proven.

        Reporting surfaces that distinguish a genuinely empty ledger from a failed or
        unsupported read use this opt-in contract. Existing export callers keep the
        fail-open :meth:`records` behavior. Third-party repositories must implement the
        strict projection explicitly rather than silently turning failure into ``[]``.
        """
        raise NotImplementedError("usage repository does not implement strict record reads")

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """One oldest-first usage page for the portable full-history export.

        Third-party repositories remain source-compatible and return one conservative
        page.  Bundled stores override this with resumable pagination and an exact
        snapshot count.
        """
        if cursor not in (None, 0, "", []):
            return [], None, None, "unverified"
        rows = list(reversed(await self.records(limit=max(1, int(limit)))))
        total = len(rows) if len(rows) < max(1, int(limit)) else None
        return rows, None, total, "unverified" if total is None else "bounded_at_start"

    async def close_export_cursor(self, cursor: Any) -> None:
        return None


class KVStore(ABC):
    """Single-document key/value persistence for config + cursor.

    Config (``Preferences``) and cursor (``Cursor``) are each a single document;
    a KV row is namespaced (``config``/``cursor``) and holds the JSON body. The
    ES-backed ``ConfigStore``/``CursorStore`` keep their richer load/save APIs;
    the SQL backend exposes generic get/put used by SQL config/cursor stores.
    """

    @abstractmethod
    async def get(self, namespace: str, key: str) -> dict[str, Any] | None: ...

    @abstractmethod
    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None: ...

    async def put_if(
        self, namespace: str, key: str, value: dict[str, Any], expected_rev: int
    ) -> bool:
        """Conditional write for :func:`kv_mutate`: persist ``value`` ONLY if the stored
        document's ``_rev`` still equals ``expected_rev``; return ``False`` on a mismatch
        (a concurrent writer moved it) so the caller retries on a fresh snapshot.

        The DEFAULT is non-atomic (get→check→put) — correct under the per-key in-process
        lock ``kv_mutate`` holds (the single-uvicorn deployment), but a genuine
        multi-process race can still slip through the read→write gap. A backend with
        native optimistic concurrency (e.g. :class:`EsKVStore` or
        :class:`SqlKVStore`) OVERRIDES this with a compare-and-set that is safe
        across processes (audit #27)."""
        current = await self.get(namespace, key)
        if _rev_of(current) != int(expected_rev):
            return False
        await self.put(namespace, key, value)
        return True

    async def factory_purge_strict(self) -> int:
        """Purge tenant KV state while retaining the factory-control anchors.

        Bundled backends implement this as a fail-closed privacy boundary.  The
        exact Jobs and Batch registry documents plus system-update operation rows
        survive byte-for-byte; every other row must be absent on return.  Missing
        protected registries and unsupported compatibility stores raise.
        """
        raise NotImplementedError("KV backend does not implement strict factory purge")

    # -- optimistic-concurrency read-modify-write -------------------------- #
    # The shared single-document KV stores route their load→mutate→save through
    # :func:`kv_mutate` (above), which serialises same-process writers on a
    # per-key lock and uses a ``_rev`` compare-and-set to retry on a multi-process
    # race — closing the lost-update window WITHOUT a new index/column. The store
    # owns the lock and calls ``kv_mutate`` directly (it works on any get/put
    # backend, incl. the offline test fakes). This convenience method lets a
    # KVStore subclass be mutated directly with the SAME guarantees.

    # A lazily-created lock per (namespace, key); see :meth:`_lock_for`.
    _locks: dict[tuple[str, str], asyncio.Lock]

    def _lock_for(self, namespace: str, key: str) -> asyncio.Lock:
        locks = getattr(self, "_locks", None)
        if locks is None:
            locks = {}
            # Set on the instance (the ABC declares the attribute but never assigns
            # it, so a subclass __init__ that doesn't call super() still works).
            object.__setattr__(self, "_locks", locks)
        lk = locks.get((namespace, key))
        if lk is None:
            lk = asyncio.Lock()
            locks[(namespace, key)] = lk
        return lk

    async def mutate(
        self,
        namespace: str,
        key: str,
        mutator: Callable[[dict[str, Any] | None], Awaitable[dict[str, Any]] | dict[str, Any]],
    ) -> dict[str, Any]:
        """Atomically read-modify-write the (namespace, key) document via
        :func:`kv_mutate` (per-key lock + ``_rev`` CAS retry). ``mutator`` receives
        the current value (or None) and returns the new value to persist; it must
        be a pure function of its snapshot (it can run more than once on a retry).
        Never raises."""
        return await kv_mutate(self, namespace, key, mutator, lock=self._lock_for(namespace, key))


class ConfigRepository(ABC):
    """Preference store contract (Section 8.5)."""

    @abstractmethod
    async def load(self) -> Preferences: ...

    @abstractmethod
    async def save(self, prefs: Preferences) -> None: ...

    @abstractmethod
    async def seed_rule_catalog(self, prefs: Preferences) -> Preferences: ...


class CursorRepository(ABC):
    """Durable polling cursor contract (Section 6.1).

    ``load``/``save`` operate on the PRIMARY cursor (the legacy single source).
    ``load_keyed``/``save_keyed`` (Wave 6) persist an INDEPENDENT cursor per key —
    e.g. ``f'{source.id}:{feed.id}'`` — so a fast alerts feed and a slow events feed
    never share/skip a cursor (#4). A concrete store overrides the keyed variants for
    true isolation; the default here routes the primary key to ``load``/``save`` and
    raises for any other key (so a store that hasn't opted in fails loudly rather than
    silently sharing one cursor)."""

    @abstractmethod
    async def load(self) -> Cursor: ...

    @abstractmethod
    async def save(self, cursor: Cursor) -> None: ...

    async def load_keyed(self, key: str) -> Cursor:
        if key in ("", "primary"):
            return await self.load()
        raise NotImplementedError("keyed cursors not supported by this store")

    async def save_keyed(self, key: str, cursor: Cursor) -> None:
        if key in ("", "primary"):
            await self.save(cursor)
            return
        raise NotImplementedError("keyed cursors not supported by this store")
