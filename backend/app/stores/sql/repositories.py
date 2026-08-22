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
from ...utils import now_utc, parse_es_timestamp, to_millis, truncate
from ..base import (
    AuditRepository,
    CaseRepository,
    ConfigRepository,
    CursorRepository,
    KVStore,
    UsageRepository,
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
                created_at=persisted.created_at or "",
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

        # Sortable fields. The timestamp columns are materialised; ``risk_score`` is
        # NOT a column (it lives inside the JSON ``doc``), so it is sorted via a numeric
        # JSON extraction — a plain ``getattr(CaseRow, 'risk_score')`` returns None and
        # SILENTLY no-ops the sort (BUG #13). Any other/unknown field falls back to
        # created_at so the query never errors (matching ES tolerance of a missing
        # sort field).
        if sort_field == "risk_score":
            # cast to Float so ordering is NUMERIC (2 < 10), not lexicographic, on both
            # SQLite (json_extract) and Postgres (->>) via the JSON accessor.
            col = cast(CaseRow.doc["risk_score"].as_float(), Float)
        elif sort_field in {"created_at", "updated_at"}:
            col = getattr(CaseRow, sort_field)
        else:
            col = CaseRow.created_at
        stmt = stmt.order_by(col.desc() if sort_order == "desc" else col.asc())
        stmt = stmt.limit(limit).offset(offset)

        async with self._sm() as session:
            rows = (await session.execute(stmt)).scalars().all()
            total = int((await session.execute(count_stmt)).scalar() or 0)
        cases = [Case.model_validate(r.doc) for r in rows]
        return cases, total

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
