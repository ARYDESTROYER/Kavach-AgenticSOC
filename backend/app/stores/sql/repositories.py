"""SQL implementations of the OWN-state repositories (Epoch A).

Each class reproduces the EXACT method signatures + query semantics of its
Elasticsearch counterpart (``CaseStore``/``AuditLogger``/``UsageStore``/
``ConfigStore``/``CursorStore``) so callers need no change. Rich docs are stored
as JSON; only the filter/sort columns are materialised + indexed.

Non-negotiable #2: :class:`SqlAuditRepository` is APPEND-ONLY — it exposes no
update/delete and never mutates a prior row.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
from datetime import timezone
from typing import Any

from sqlalchemy import (
    Float,
    Integer,
    and_,
    cast,
    delete,
    func,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from ...build_identity import stamp_new_record
from ...config import Preferences
from ...constants import (
    ActionType,
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    CASE_PIPELINE_USAGE_ROLES,
    CaseStatus,
    JOBS_KEY,
    JOBS_NS,
    OPEN_CASE_STATUSES,
    SourceSurface,
)
from ...models import AuditDoc, Case, Cursor, UsageDoc
from ...utils import (
    now_utc,
    parse_es_timestamp,
    relative_to_iso_utc_strict,
    to_millis,
    truncate,
)
from ..base import (
    AuditRepository,
    CaseRepository,
    ConfigRepository,
    CursorRepository,
    KVStore,
    UsageRepository,
    status_group_statuses,
    window_bounds_proven,
)
from ..usage import (
    _empty_summary,
    _new_processing_tier_bucket,
    _processing_tier_key,
    _processing_tier_summary,
    _top,
)  # reuse the ES summary aggregation helpers
from ..update_operations import UPDATE_OPERATIONS_NS
from .models import AuditRow, CaseRow, KVRow, UsageRow

logger = logging.getLogger("tlsoc.stores.sql")

# Any NON-terminal lifecycle status counts as "open" for signature idempotency (#4),
# including the F8 statuses (NEW/INVESTIGATING/ESCALATED/ON_HOLD).
_OPEN_STATUSES = list(OPEN_CASE_STATUSES)

# Config/cursor namespaces + keys for the KV store (mirror the ES doc ids).
_CONFIG_NS = "config"
_CONFIG_KEY = "preferences"
_CURSOR_NS = "cursor"
_CURSOR_KEY = "primary"


def _sessionmaker(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)


def _entity_value(case: Case) -> str:
    try:
        return case.entity.value or ""
    except Exception:  # noqa: BLE001
        return ""


# The ONE spelling the materialised ``created_at`` COLUMN is allowed to hold:
# ``YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00``, i.e. what ``iso_now()`` emits. Written by
# :func:`_canonical_created_at` on every save, and tested with two LIKE patterns (``_``
# is the single-character wildcard in both SQLite and PostgreSQL) as the never-drop
# escape hatch in :meth:`SqlCaseRepository.list_window`.
#
# BOTH halves matter. The shape alone would admit ``2026-03-02T00:00:00Z`` and
# ``2026-03-01T04:00:00+05:30``, which are perfectly readable timestamps that
# lexicographic order places WRONG — ``'Z'`` (0x5A) sorts after ``'+'`` (0x2B), so a
# row sitting exactly on the inclusive upper bound is dropped, and a non-UTC offset is
# compared as local wall-clock, up to a 14-hour error with inclusion inverted in both
# directions. Requiring the ``+00:00`` tail routes any such legacy row into the
# never-drop branch instead of mis-placing it.
#
# LIKE is character-wise and therefore collation-independent, unlike a
# ``< '0' OR >= ':'`` bracket, which an ICU collation that ignores punctuation would
# evaluate differently per deployment.
_ISO_CREATED_AT_SHAPE = "____-__-__T__:__:__%"
_ISO_CREATED_AT_UTC_TAIL = "%+00:00"


def _canonical_created_at(value: Any) -> str:
    """The materialised ``created_at`` COLUMN value for one case.

    The column is an INDEX, not the record: the authoritative ``created_at`` always
    stays byte-identical inside the JSON ``doc``, which is what :meth:`get`/:meth:`list`
    read back. Its job is to be LEXICOGRAPHICALLY comparable, and it can only do that
    job if every non-empty value shares one spelling — so this normalises a readable
    timestamp to UTC ``+00:00`` (fixing ``...Z`` and non-UTC offsets, which string
    order places wrong) and collapses an UNREADABLE one to ``""``.

    Collapsing to ``""`` is what makes the never-drop contract (#4) EXACT here rather
    than a shape heuristic. A LIKE pattern cannot tell ``2026-13-45T99:99:99+00:00``
    from a real timestamp — both are ISO-shaped — so such a row used to fall through
    to the lexicographic comparison, sort as a far-future date, and vanish from every
    historical window while the store still reported an exact count. Marking it
    "cannot be placed in time" at write time makes it agree with
    :func:`~app.stores.base.case_in_created_window`, the single definition of the
    contract, on every value.

    Microseconds are preserved (``datetime.isoformat()`` omits the fraction only when
    it is zero, on both sides of every comparison), so sort stability between two
    cases created in the same millisecond is unchanged.

    One visible side effect, and it is a convergence rather than a regression: a row
    whose ``created_at`` cannot be read now sorts at the ``""`` end of the default
    created_at-DESC listing (last) instead of wherever its raw bytes happened to fall.
    That is already what the Elasticsearch path does — ``es/fake._sort_key`` maps an
    incomparable value to ``-inf`` — so the two backends now order such a row the same
    way rather than each inventing its own answer.

    NO MIGRATION, NO BACKFILL (#12): this is a write-path change only. A pre-existing
    row keeps whatever it holds and self-heals on its next save; until then the two
    LIKE patterns above still route a non-canonical legacy value into never-drop. The
    one residual is a legacy row that is ISO-shaped, ``+00:00``-tailed AND unreadable,
    which no in-tree writer has ever produced (every ``Case.created_at`` comes from
    ``iso_now()``)."""
    dt = parse_es_timestamp(value)
    return dt.astimezone(timezone.utc).isoformat() if dt is not None else ""


def _case_sort_column(sort_field: str) -> Any:
    """The ORDER BY expression for a case listing.

    The timestamp columns are materialised; ``risk_score`` is NOT a column (it lives
    inside the JSON ``doc``), so it is sorted via a numeric JSON extraction — a plain
    ``getattr(CaseRow, 'risk_score')`` returns None and SILENTLY no-ops the sort
    (BUG #13). Any other/unknown field falls back to created_at so the query never
    errors (matching ES tolerance of a missing sort field)."""
    if sort_field == "risk_score":
        # cast to Float so ordering is NUMERIC (2 < 10), not lexicographic, on both
        # SQLite (json_extract) and Postgres (->>) via the JSON accessor.
        return cast(CaseRow.doc["risk_score"].as_float(), Float)
    if sort_field in {"created_at", "updated_at"}:
        return getattr(CaseRow, sort_field)
    return CaseRow.created_at


def _case_order_by(sort_field: str, sort_order: str) -> list[Any]:
    """The full ORDER BY term list for a case listing: primary key, then TIEBREAKER.

    ``case_id`` is the table's primary key, so it is unique and totally orders any set
    of rows that tie on the primary key. Without it the SQL standard promises nothing
    about the order of equal keys, so ``LIMIT``/``OFFSET`` paging over a tied column
    (``risk_score`` clusters on a handful of round values; ``created_at`` is
    second-resolution) can repeat rows on one page and skip them on the next. SQLite
    usually falls back to rowid order and hides this in every offline test, which is why
    the contract is asserted on the emitted ORDER BY SHAPE, not on observed rows."""
    descending = sort_order == "desc"
    column = _case_sort_column(sort_field)
    tiebreaker = CaseRow.case_id
    return [
        column.desc() if descending else column.asc(),
        tiebreaker.desc() if descending else tiebreaker.asc(),
    ]


class SqlCaseRepository(CaseRepository):
    """Cases persisted as JSON with materialised filter/sort columns."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def save(self, case: Case) -> None:
        async with self._sm() as session:
            row = await session.get(CaseRow, case.case_id)
            # Product constructors stamp at creation and preserve the original values
            # on reconstruction.  This insert-only fallback covers direct repository
            # clients without attributing a legacy update to the process that touched it.
            if row is None:
                persisted = stamp_new_record(case)
            else:
                # Always restore the first row's pair. This covers an unchanged,
                # unstamped caller object as well as a direct caller that submits two
                # non-empty but changed values; historical nulls remain null.
                existing_doc = dict(row.doc or {})
                persisted = case.model_copy(
                    update={
                        "app_version": existing_doc.get("app_version"),
                        "build_sha": existing_doc.get("build_sha"),
                    }
                )
            doc = persisted.model_dump(mode="json")
            values = dict(
                cluster_signature=persisted.cluster_signature,
                status=persisted.status.value if persisted.status else "",
                source_surface=(
                    persisted.source_surface.value if persisted.source_surface else ""
                ),
                entity_value=_entity_value(persisted),
                # The COLUMN is a normalised index; ``doc`` keeps the raw value.
                created_at=_canonical_created_at(persisted.created_at),
                updated_at=persisted.updated_at or "",
                doc=doc,
            )
            if row is None:
                session.add(CaseRow(case_id=case.case_id, **values))
            else:
                for k, v in values.items():
                    setattr(row, k, v)
            await session.commit()

    async def get(self, case_id: str) -> Case | None:
        async with self._sm() as session:
            row = await session.get(CaseRow, case_id)
            return Case.model_validate(row.doc) if row else None

    async def find_open_by_signature(self, signature: str) -> Case | None:
        stmt = (
            select(CaseRow)
            .where(CaseRow.cluster_signature == signature)
            .where(CaseRow.status.in_(_OPEN_STATUSES))
            .order_by(CaseRow.updated_at.desc())
            .limit(1)
        )
        async with self._sm() as session:
            row = (await session.execute(stmt)).scalars().first()
            return Case.model_validate(row.doc) if row else None

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
        stmt = select(CaseRow)
        count_stmt = select(func.count()).select_from(CaseRow)
        if status:
            stmt = stmt.where(CaseRow.status == status)
            count_stmt = count_stmt.where(CaseRow.status == status)
        if source_surface:
            stmt = stmt.where(CaseRow.source_surface == source_surface)
            count_stmt = count_stmt.where(CaseRow.source_surface == source_surface)
        if entity_value:
            stmt = stmt.where(CaseRow.entity_value == entity_value)
            count_stmt = count_stmt.where(CaseRow.entity_value == entity_value)

        stmt = stmt.order_by(*_case_order_by(sort_field, sort_order))
        stmt = stmt.limit(limit).offset(offset)

        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
            total = int((await session.execute(count_stmt)).scalar() or 0)
        cases = [Case.model_validate(r.doc) for r in rows]
        return cases, total

    async def list_window(
        self,
        *,
        created_from: str | None = None,
        created_to: str | None = None,
        status: str | None = None,
        source_surface: str | None = None,
        entity_value: str | None = None,
        status_group: str | None = None,
        limit: int = 50,
        offset: int = 0,
        sort_field: str = "created_at",
        sort_order: str = "desc",
    ) -> tuple[list[Case], int, bool]:
        """Native ``created_at`` window push-down → (cases, total, exact).

        WHERE + COUNT on the materialised, indexed ``created_at`` column, so the page
        is drawn from the WHOLE matching set (page 2 of a 30d window is the middle of
        that window, not the tail of the newest N rows) and ``total`` is a true count
        over the whole corpus rather than the length of one fetched page.

        The comparison is LEXICOGRAPHIC, the same idiom as :meth:`count_new_scans` /
        :meth:`count_created_since`. That is only sound while BOTH sides share one
        spelling, so both sides are normalised to it: the bounds by
        ``relative_to_iso_utc_strict``, and the COLUMN by :func:`_canonical_created_at`
        on every save (the raw value stays untouched in the JSON ``doc``). Without the
        write-side half the assumption was merely asserted — ``save`` stored whatever
        string it was handed — and a ``...Z`` or non-UTC-offset value was silently
        mis-placed by up to fourteen hours.

        NEVER-DROP (#4): a row whose ``created_at`` is NULL, empty, or not in that one
        canonical spelling is KEPT. Lexicographic comparison always yields an answer,
        so a value we cannot place in time would otherwise be silently dropped from
        every historical window; the two LIKE tests are what make "I cannot place this"
        visible instead. Because ``save`` writes ``""`` for an unreadable timestamp,
        this now agrees value-for-value with
        :func:`~app.stores.base.case_in_created_window` rather than approximating it
        with a shape heuristic. It costs the index on the OR branch; correctness over
        the plan.

        The residual, stated rather than glossed: a row written BEFORE the write-side
        normalisation and never re-saved may hold a readable but non-canonical spelling
        (``...Z``, a non-UTC offset). Such a row falls into the never-drop branch, so it
        is over-KEPT — it may appear in a window it does not belong to. That is the
        deliberate direction of the error (never-drop, never never-filter), it is
        strictly better than the silent mis-placement it replaces, and it disappears the
        first time the case is saved.

        An unresolvable BOUND is treated as absent rather than as "right now", and
        ``exact`` then reports ``False``: the applied window is wider than the one that
        was requested (see :func:`~app.stores.base.window_bounds_proven`).

        ``status_group`` pushes a MULTI-status lifecycle set down as a real ``IN``
        predicate over the materialised, indexed ``status`` column, resolved from the
        product's own status constants
        (:data:`~app.stores.base.CASE_STATUS_GROUPS`). It narrows WHICH rows match and
        therefore leaves the window's ``exact`` contract alone."""
        lo = relative_to_iso_utc_strict(created_from) if created_from else None
        hi = relative_to_iso_utc_strict(created_to) if created_to else None
        proven = window_bounds_proven(created_from, created_to, lo, hi)
        group = status_group_statuses(status_group)
        if lo is None and hi is None and group is None:
            cases, total = await self.list(
                status=status, source_surface=source_surface, entity_value=entity_value,
                limit=limit, offset=offset, sort_field=sort_field, sort_order=sort_order,
            )
            return cases, total, proven

        stmt = select(CaseRow)
        count_stmt = select(func.count()).select_from(CaseRow)
        for clause in (
            CaseRow.status == status if status else None,
            CaseRow.source_surface == source_surface if source_surface else None,
            CaseRow.entity_value == entity_value if entity_value else None,
            CaseRow.status.in_(list(group)) if group is not None else None,
        ):
            if clause is not None:
                stmt = stmt.where(clause)
                count_stmt = count_stmt.where(clause)

        inside = [c for c in (
            CaseRow.created_at >= lo if lo is not None else None,
            CaseRow.created_at <= hi if hi is not None else None,
        ) if c is not None]
        # Only a request that actually carries a TIME bound gets the never-drop window
        # clause. A group-only request reaches this branch with no bounds at all, and
        # emitting the clause there would be an empty ``AND`` — a no-op at best and a
        # deprecation at worst — dressed up as a window that was never asked for.
        if inside:
            keep = or_(
                CaseRow.created_at.is_(None),
                CaseRow.created_at == "",
                ~CaseRow.created_at.like(_ISO_CREATED_AT_SHAPE),
                ~CaseRow.created_at.like(_ISO_CREATED_AT_UTC_TAIL),
                and_(*inside),
            )
            stmt = stmt.where(keep)
            count_stmt = count_stmt.where(keep)

        stmt = stmt.order_by(*_case_order_by(sort_field, sort_order))
        stmt = stmt.limit(limit).offset(offset)

        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
            total = int((await session.execute(count_stmt)).scalar() or 0)
        return [Case.model_validate(r.doc) for r in rows], total, proven

    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        return await self.list(
            source_surface=SourceSurface.AUTOMATED_SCAN.value, limit=limit
        )

    async def count_new_scans(self, since_iso: str) -> int:
        stmt = (
            select(func.count())
            .select_from(CaseRow)
            .where(CaseRow.source_surface == SourceSurface.AUTOMATED_SCAN.value)
            .where(CaseRow.created_at > since_iso)
        )
        async with self._sm() as session:
            return int((await session.execute(stmt)).scalar() or 0)

    async def count_created_since(self, since_iso: str) -> int:
        """Native COUNT push-down on the materialized ``created_at`` column: cases
        created at/after ``since_iso`` (inclusive), across every surface/status. Same
        ISO-string comparison idiom as :meth:`count_new_scans` (the column stores the
        app's own consistently-formatted ISO timestamps)."""
        stmt = (
            select(func.count())
            .select_from(CaseRow)
            .where(CaseRow.created_at >= since_iso)
        )
        async with self._sm() as session:
            return int((await session.execute(stmt)).scalar() or 0)


class SqlAuditRepository(AuditRepository):
    """Append-only audit log. INSERT only — no update/delete path exists."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def write(self, doc: AuditDoc) -> None:
        try:
            await self.write_strict(doc)
        except Exception as exc:  # noqa: BLE001
            logger.error("AUDIT WRITE FAILED (action=%s case=%s): %s",
                         doc.action_type, doc.case_id, exc)

    async def write_strict(self, doc: AuditDoc) -> None:
        """Append one row and propagate failure for privileged durability gates.

        Privileged events may supply a deterministic ``event_id``. Map it to a
        negative surrogate key (ordinary autoincrement rows are positive) so the
        database primary key provides cross-process exactly-once insertion without
        a schema migration. A duplicate is accepted only when the stored semantic
        payload is equivalent (the first append retains its timestamp); a hash
        collision fails closed.
        """
        payload = stamp_new_record(doc).model_dump(mode="json")
        row_id: int | None = None
        if doc.event_id:
            digest = hashlib.sha256(doc.event_id.encode("utf-8")).digest()
            row_id = -(int.from_bytes(digest[:8], "big") & ((1 << 63) - 1) or 1)
        async with self._sm() as session:
            session.add(
                AuditRow(
                    **({"id": row_id} if row_id is not None else {}),
                    ts=payload.get("ts", "") or "",
                    case_id=payload.get("case_id"),
                    action_type=payload.get("action_type", "") or "",
                    doc=payload,
                )
            )
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                if row_id is None:
                    raise
                existing = await session.get(AuditRow, row_id)
                existing_payload = dict(existing.doc or {}) if existing else {}
                retry_metadata = {"ts", "app_version", "build_sha"}
                existing_semantic = {
                    key: value
                    for key, value in existing_payload.items()
                    if key not in retry_metadata
                }
                payload_semantic = {
                    key: value
                    for key, value in payload.items()
                    if key not in retry_metadata
                }
                if existing is None or existing_semantic != payload_semantic:
                    raise RuntimeError(
                        f"audit event id collision: {doc.event_id}"
                    )

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
    ) -> None:
        await self.write(
            AuditDoc(
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
                tool_output_summary=truncate(tool_output_summary, 1000) if tool_output_summary else None,
                result_summary=truncate(result_summary, 1000) if result_summary else None,
            )
        )

    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """Newest bounded audit rows, returned oldest-first for the trace timeline."""
        cap = max(1, min(int(limit or 500), 500))
        stmt = (
            select(AuditRow)
            .where(AuditRow.case_id == case_id)
            .order_by(AuditRow.ts.desc(), AuditRow.id.desc())
            .limit(cap)
        )
        try:
            async with self._sm() as session:
                rows = list((await session.execute(stmt)).scalars().all())
            rows.reverse()
            return [r.doc or {} for r in rows]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit read for case %s failed: %s", case_id, exc)
            return []

    async def records_for_actor(self, actor: str, limit: int = 50) -> list[dict[str, Any]]:
        """Recent audit rows attributed to ``actor`` (NEWEST first) — the per-user
        account-activity feed (Wave 3). ``actor`` lives inside the JSON ``doc`` (not a
        column), so we scan a bounded recent window (ts desc) and filter in Python —
        cross-dialect + correct on SQLite + Postgres. Never raises."""
        if not actor:
            return []
        scan = max(limit * 20, 500)
        stmt = (
            select(AuditRow)
            .order_by(AuditRow.ts.desc(), AuditRow.id.desc())
            .limit(scan)
        )
        try:
            async with self._sm() as session:
                rows = (await session.execute(stmt)).scalars().all()
            out: list[dict[str, Any]] = []
            for r in rows:
                doc = r.doc or {}
                if str(doc.get("actor", "")) == actor:
                    out.append(doc)
                    if len(out) >= limit:
                        break
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit read for actor %s failed: %s", actor, exc)
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
        """Filtered, bounded listing for the admin audit viewer (W7c), NEWEST first.

        ``action_type`` + ``case_id`` are real columns (pushed into SQL); ``actor`` +
        ``surface`` + ``source_id`` (A5.3) live inside the JSON ``doc``, so we bound-scan a
        recent ts window and filter those in Python (cross-dialect, correct on SQLite +
        Postgres). The ``ts`` range is applied in SQL on the column. Read-only; never
        raises."""
        base = select(AuditRow)
        if action_type:
            base = base.where(AuditRow.action_type == action_type)
        if case_id:
            base = base.where(AuditRow.case_id == case_id)
        if ts_from:
            base = base.where(AuditRow.ts >= ts_from)
        if ts_to:
            base = base.where(AuditRow.ts <= ts_to)
        base = base.order_by(AuditRow.ts.desc(), AuditRow.id.desc())

        # actor/surface/source_id live inside the JSON doc → filtered in Python. A single
        # fixed scan window could return FEWER than ``limit`` matches even when more exist
        # further back (a sparse actor's rows fall outside the window), silently
        # under-returning (audit #40). PAGE the ts-descending scan until ``limit`` matches
        # are collected or the (ts-bounded) table is exhausted; a page-count backstop
        # bounds a pathological scan.
        json_filtered = bool(actor or surface or source_id)
        page_size = max(limit * 20, 500) if json_filtered else limit
        max_pages = 200
        out: list[dict[str, Any]] = []
        offset = 0
        try:
            async with self._sm() as session:
                for _ in range(max_pages):
                    rows = (await session.execute(
                        base.limit(page_size).offset(offset)
                    )).scalars().all()
                    if not rows:
                        break
                    for r in rows:
                        doc = r.doc or {}
                        if actor and str(doc.get("actor", "")) != actor:
                            continue
                        if surface and str(doc.get("surface", "")) != surface:
                            continue
                        if source_id and str(doc.get("source_id", "")) != source_id:
                            continue
                        out.append(doc)
                        if len(out) >= limit:
                            return out
                    if len(rows) < page_size:
                        break  # table exhausted within the ts window
                    offset += len(rows)
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit records read failed: %s", exc)
            return []

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """Oldest-first bounded page plus an exact ledger snapshot count."""
        cap = max(1, min(int(limit or 1000), 5000))
        try:
            offset = max(0, int(cursor or 0))
        except (TypeError, ValueError):
            offset = 0
        stmt = (
            select(AuditRow)
            .order_by(AuditRow.ts.asc(), AuditRow.id.asc())
            .limit(cap)
            .offset(offset)
        )
        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
            total = int(
                (await session.execute(select(func.count()).select_from(AuditRow))).scalar()
                or 0
            )
        next_cursor = offset + len(rows) if offset + len(rows) < total else None
        return [dict(row.doc or {}) for row in rows], next_cursor, total, "bounded_at_start"


class SqlUsageRepository(UsageRepository):
    """Cost/token ledger. Summary aggregates in Python (same as the ES store)."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)
        # SQLite's in-memory shape can multiplex async sessions over one physical
        # connection. Serialise this tiny claim+insert transaction locally; the unique
        # KV claim below remains the cross-process guarantee on SQLite/PostgreSQL.
        self._strict_write_lock = asyncio.Lock()

    async def write(self, doc: UsageDoc) -> None:
        try:
            await self.write_strict(doc)
        except Exception as exc:  # noqa: BLE001
            logger.error("USAGE WRITE FAILED (role=%s model=%s): %s", doc.role, doc.model, exc)

    async def write_strict(self, doc: UsageDoc) -> None:
        """Persist a Batch ledger row retry-safely or raise on failure.

        For an idempotent Batch row, reserve a hash in the existing KV table (whose
        namespace/key pair is already a unique primary key) and insert the UsageRow in
        the SAME transaction. ``ON CONFLICT DO NOTHING`` makes concurrent workers pick
        one winner on both supported SQL dialects without a schema migration; rollback
        removes the reservation if the UsageRow insert fails. Ordinary live calls (no
        key) remain append-only.
        """
        if doc.idempotency_key:
            async with self._strict_write_lock:
                await self._write_strict_once(doc)
            return
        await self._write_strict_once(doc)

    async def _write_strict_once(self, doc: UsageDoc) -> None:
        payload = stamp_new_record(doc).model_dump(mode="json")
        key = str(doc.idempotency_key or "").strip()
        async with self._sm() as session:
            async with session.begin():
                if key:
                    claim_key = hashlib.sha256(key.encode("utf-8")).hexdigest()
                    values = {
                        "namespace": "usage_idempotency",
                        "key": claim_key,
                        "value": {"idempotency_key": key},
                    }
                    dialect = self._engine.dialect.name
                    if dialect == "sqlite":
                        from sqlalchemy.dialects.sqlite import insert as dialect_insert
                    elif dialect == "postgresql":
                        from sqlalchemy.dialects.postgresql import insert as dialect_insert
                    else:
                        raise NotImplementedError(
                            f"strict usage idempotency is unsupported on {dialect}"
                        )
                    claim = (
                        dialect_insert(KVRow)
                        .values(**values)
                        .on_conflict_do_nothing(index_elements=["namespace", "key"])
                        .returning(KVRow.key)
                    )
                    inserted = (await session.execute(claim)).scalar_one_or_none()
                    if inserted is None:
                        return
                session.add(
                    UsageRow(
                        ts=payload.get("ts", "") or "",
                        case_id=payload.get("case_id"),
                        surface=payload.get("surface", "") or "",
                        role=payload.get("role", "") or "",
                        model=payload.get("model", "") or "",
                        cost=float(payload.get("cost", 0.0) or 0.0),
                        total_tokens=int(payload.get("total_tokens", 0) or 0),
                        doc=payload,
                    )
                )

    async def records(self, *, limit: int = 1000) -> list[dict[str, Any]]:
        """Newest-first bounded ledger rows for the privileged data export."""
        try:
            return await self.records_strict(limit=limit)
        except Exception as exc:  # noqa: BLE001 — export degrades per scope
            logger.warning("usage records read failed: %s", exc)
            return []

    async def records_strict(self, *, limit: int = 1000) -> list[dict[str, Any]]:
        """Newest-first bounded rows, raising when the ledger cannot be read."""
        cap = max(1, min(int(limit or 1000), 5000))
        stmt = select(UsageRow).order_by(UsageRow.ts.desc(), UsageRow.id.desc()).limit(cap)
        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
        return [dict(row.doc or {}) for row in rows]

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """Oldest-first bounded page plus an exact usage-ledger snapshot count."""
        cap = max(1, min(int(limit or 1000), 5000))
        try:
            offset = max(0, int(cursor or 0))
        except (TypeError, ValueError):
            offset = 0
        stmt = (
            select(UsageRow)
            .order_by(UsageRow.ts.asc(), UsageRow.id.asc())
            .limit(cap)
            .offset(offset)
        )
        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
            total = int(
                (await session.execute(select(func.count()).select_from(UsageRow))).scalar()
                or 0
            )
        next_cursor = offset + len(rows) if offset + len(rows) < total else None
        return [dict(row.doc or {}) for row in rows], next_cursor, total, "bounded_at_start"

    async def total_pipeline_cost_for_case(self, case_id: str) -> float | None:
        """Return all-time router/investigator/formatter spend for one case."""
        statement = select(func.sum(UsageRow.cost)).where(
            UsageRow.case_id == case_id,
            UsageRow.role.in_(CASE_PIPELINE_USAGE_ROLES),
        )
        try:
            async with self._sm() as session:
                value = (await session.execute(statement)).scalar_one_or_none()
        except Exception as exc:  # noqa: BLE001 — accounting remains fail-soft
            logger.warning("case usage reconciliation query failed for %s: %s", case_id, exc)
            return None
        return round(float(value or 0.0), 6)

    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        from collections import defaultdict

        now = now_utc()
        from_millis = to_millis(now) - window_hours * 3600 * 1000
        today_start_millis = to_millis(now.replace(hour=0, minute=0, second=0, microsecond=0))

        # Push the window lower bound into SQL on the indexed ISO ``ts`` column (mirrors
        # AuditRow above), so the budget-gate hot path scans ~the window instead of the
        # ENTIRE usage ledger (audit #10). Use a small buffer BEFORE from_millis so an ISO
        # format edge case can never exclude a boundary row; the exact millis filter in the
        # Python loop below still trims to [from_millis, now], keeping totals byte-identical.
        from datetime import timezone as _tz
        from datetime import datetime as _dt

        iso_from = _dt.fromtimestamp(max(0, from_millis - 1000) / 1000.0, tz=_tz.utc).isoformat()
        stmt = select(UsageRow).where(UsageRow.ts >= iso_from).order_by(UsageRow.ts.asc())
        if case_id:
            stmt = stmt.where(UsageRow.case_id == case_id)
        try:
            async with self._sm() as session:
                rows = (await session.execute(stmt)).scalars().all()
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary query failed: %s", exc)
            return _empty_summary(window_hours)

        total_cost = 0.0
        total_tokens = 0
        today_cost = 0.0
        call_count = 0
        by_surface: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_model: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_role: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_processing_tier = _new_processing_tier_bucket()
        over_time: dict[int, float] = defaultdict(float)

        for row in rows:
            src = row.doc or {}
            ts = parse_es_timestamp(src.get("ts"))
            ts_millis = to_millis(ts) if ts else 0
            # Apply the window filter in Python over the ISO timestamp (ts column is
            # ISO text; we keep the exact ES semantics: ts >= from_millis).
            if ts_millis and ts_millis < from_millis:
                continue
            cost = float(src.get("cost", 0.0) or 0.0)
            tokens = int(src.get("total_tokens", 0) or 0)
            total_cost += cost
            total_tokens += tokens
            call_count += 1
            if ts_millis >= today_start_millis:
                today_cost += cost
            for bucket, key in (
                (by_surface, src.get("surface", "unknown")),
                (by_model, src.get("model", "unknown")),
                (by_role, src.get("role", "unknown")),
            ):
                bucket[key]["cost"] += cost
                bucket[key]["tokens"] += tokens
                bucket[key]["calls"] += 1
            tier = _processing_tier_key(src.get("processing_tier"))
            by_processing_tier[tier]["cost"] += cost
            by_processing_tier[tier]["tokens"] += tokens
            by_processing_tier[tier]["calls"] += 1
            hour = (ts_millis // 3_600_000) * 3_600_000
            over_time[hour] += cost

        return {
            "window_hours": window_hours,
            "total_cost": round(total_cost, 6),
            "total_tokens": total_tokens,
            "today_cost": round(today_cost, 6),
            "call_count": call_count,
            "currency": "USD",
            "by_surface": _top(by_surface),
            "by_model": _top(by_model),
            "by_role": _top(by_role),
            **_processing_tier_summary(by_processing_tier),
            "cost_over_time": [
                {"ts": k, "cost": round(v, 6)} for k, v in sorted(over_time.items())
            ],
            "top_cost_drivers": _top(by_model, limit=5),
        }


class SqlKVStore(KVStore):
    """Single-document key/value persistence (config + cursor)."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine
        self._sm = _sessionmaker(engine)

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        async with self._sm() as session:
            row = await session.get(KVRow, (namespace, key))
            return dict(row.value) if row and row.value is not None else None

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        async with self._sm() as session:
            row = await session.get(KVRow, (namespace, key))
            if row is None:
                session.add(KVRow(namespace=namespace, key=key, value=value))
            else:
                row.value = value
            await session.commit()

    async def put_if(
        self, namespace: str, key: str, value: dict[str, Any], expected_rev: int
    ) -> bool:
        """Atomic compare-and-set (audit #27) across SQL sessions/processes.

        The revision predicate is part of the UPDATE itself. This matters on SQLite,
        where ``SELECT … FOR UPDATE`` is ignored: two independent Batch schedulers
        could otherwise both read the same revision and both believe they acquired a
        provider-submission lease. An absent-row expected-revision-zero write uses the
        composite primary key as the atomic arbiter.
        """
        from sqlalchemy.exc import IntegrityError

        revision = func.coalesce(
            cast(KVRow.value["_rev"].as_string(), Integer), 0
        )
        stmt = (
            update(KVRow)
            .where(
                KVRow.namespace == namespace,
                KVRow.key == key,
                revision == int(expected_rev),
            )
            .values(value=value)
        )
        async with self._sm() as session:
            async with session.begin():
                result = await session.execute(stmt)
            if int(result.rowcount or 0) == 1:
                return True

        if int(expected_rev) != 0:
            return False
        try:
            async with self._sm() as session:
                async with session.begin():
                    session.add(KVRow(namespace=namespace, key=key, value=value))
            return True
        except IntegrityError:
            # Lost the absent-row INSERT race; the caller reloads the winning revision.
            return False

    async def factory_purge_strict(self) -> int:
        """Atomically purge tenant KV rows and verify protected state in-transaction."""
        jobs_pk = (JOBS_NS, JOBS_KEY)
        batch_pk = (BATCH_JOBS_NS, BATCH_JOBS_KEY)
        async with self._sm() as session:
            async with session.begin():
                if self._engine.dialect.name == "postgresql":
                    # Existing-row FOR UPDATE locks do not fence inserts into a
                    # namespace that was absent from the snapshot.  Factory reset
                    # is rare and already globally quiescent, so take the explicit
                    # table lock that makes this one transaction the whole KV
                    # privacy boundary. SQLite's first DELETE obtains its database
                    # write lock and needs no unsupported LOCK TABLE statement.
                    await session.execute(
                        text("LOCK TABLE kv IN ACCESS EXCLUSIVE MODE")
                    )
                rows = (
                    await session.execute(
                        select(KVRow).with_for_update()
                    )
                ).scalars().all()
                before = {
                    (str(row.namespace), str(row.key)): copy.deepcopy(row.value)
                    for row in rows
                }
                if jobs_pk not in before or batch_pk not in before:
                    raise RuntimeError(
                        "factory purge requires durable Jobs and Batch fence rows"
                    )
                protected = {
                    key: value
                    for key, value in before.items()
                    if key in {jobs_pk, batch_pk}
                    or key[0] == UPDATE_OPERATIONS_NS
                }
                keep = or_(
                    and_(KVRow.namespace == JOBS_NS, KVRow.key == JOBS_KEY),
                    and_(
                        KVRow.namespace == BATCH_JOBS_NS,
                        KVRow.key == BATCH_JOBS_KEY,
                    ),
                    KVRow.namespace == UPDATE_OPERATIONS_NS,
                )
                result = await session.execute(delete(KVRow).where(~keep))
                await session.flush()
                remaining = (
                    await session.execute(select(KVRow))
                ).scalars().all()
                after = {
                    (str(row.namespace), str(row.key)): copy.deepcopy(row.value)
                    for row in remaining
                }
                if after != protected:
                    retained = len(set(after) - set(protected))
                    missing = len(set(protected) - set(after))
                    changed = sum(
                        after[key] != protected[key]
                        for key in set(after).intersection(protected)
                    )
                    raise RuntimeError(
                        "factory KV purge verification failed "
                        f"(retained={retained}, missing={missing}, changed={changed})"
                    )
                return int(result.rowcount or 0)


class SqlConfigStore(ConfigRepository):
    """Preference store over the KV table (mirrors ``ConfigStore``)."""

    def __init__(self, kv: SqlKVStore) -> None:
        self._kv = kv

    async def load(self) -> Preferences:
        try:
            doc = await self._kv.get(_CONFIG_NS, _CONFIG_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading preferences failed (%s); using defaults", exc)
            return Preferences()
        if not doc:
            return Preferences()
        try:
            return Preferences.model_validate(doc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Stored preferences invalid (%s); using defaults", exc)
            return Preferences()

    async def save(self, prefs: Preferences) -> None:
        await self._kv.put(_CONFIG_NS, _CONFIG_KEY, prefs.model_dump(mode="json"))

    async def seed_rule_catalog(self, prefs: Preferences) -> Preferences:
        """First-run seeding of the built-in rule catalog (C3-1). Idempotent."""
        changed = prefs.maybe_seed_rule_catalog()
        if changed:
            logger.info("Seeded built-in rule catalog (%d rules)", len(prefs.rule_catalog))
            try:
                await self.save(prefs)
            except Exception as exc:  # noqa: BLE001 — seeding is best-effort
                logger.warning("Persisting seeded rule catalog failed (%s); continuing", exc)
        return prefs


class SqlCursorStore(CursorRepository):
    """Durable polling cursor over the KV table (mirrors ``CursorStore``)."""

    def __init__(self, kv: SqlKVStore) -> None:
        self._kv = kv

    @staticmethod
    def _key(key: str) -> str:
        """KV key for a per-feed cursor; the primary maps to the legacy key (no
        migration — an existing single-source cursor is read unchanged)."""
        return _CURSOR_KEY if key in ("", "primary") else f"feed:{key}"

    async def load(self) -> Cursor:
        return await self.load_keyed("primary")

    async def save(self, cursor: Cursor) -> None:
        await self.save_keyed("primary", cursor)

    async def load_keyed(self, key: str) -> Cursor:
        try:
            doc = await self._kv.get(_CURSOR_NS, self._key(key))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading cursor failed (%s); starting cold", exc)
            return Cursor()
        if not doc:
            return Cursor()
        try:
            return Cursor.model_validate(doc)
        except Exception:  # noqa: BLE001
            return Cursor()

    async def save_keyed(self, key: str, cursor: Cursor) -> None:
        await self._kv.put(_CURSOR_NS, self._key(key), cursor.model_dump(mode="json"))
