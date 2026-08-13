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
from typing import Any, Awaitable, Callable

from ..build_identity import stamp_new_record
from ..config import Preferences
from ..constants import ActionType
from ..models import AuditDoc, Case, Cursor, UsageDoc
from ..utils import truncate

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
