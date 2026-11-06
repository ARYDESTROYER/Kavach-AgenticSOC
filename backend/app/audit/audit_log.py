"""The auditability backbone (Section 7.2 / Non-negotiable #2).

Every agent action is appended here, from the first commit. Writes are
best-effort and never raise into the caller: a failed audit write must not break
an investigation, but it is logged loudly. Audit is append-only — documents are
never updated or deleted.

Round 14 (SPEC §4.5.5) adds the read API's store calls: point-in-time pages with
``search_after`` on ``(ts, _shard_doc)``, totals tracked up to 10,000 (beyond it a
lower bound), exact counts up to a cap, per-run totals counted inside the page's
point-in-time and the read of one record by its id. Every read is limited to the audit
indices, so a crafted record id can never reach another index.
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
from typing import Any

from ..build_identity import stamp_new_record
from ..constants import AUDIT_READ_PATTERN, AUDIT_WRITE_ALIAS, ActionType
from ..es.base import BaseESClient
from ..models import AuditChange, AuditClient, AuditDoc, AuditRecordRef, AuditTarget
from ..stores.base import (
    AuditCursorExpired,
    AuditHit,
    AuditRepository,
    AuditSearchPage,
    build_audit_doc_best_effort,
)
from ..stores.ledger_claims import append_keyed_ledger_row

logger = logging.getLogger("tlsoc.audit")

#: How long a read page's point-in-time snapshot lives between "Load more" calls, in
#: seconds (the read route ages its open-read registry by the same figure).
AUDIT_PIT_KEEP_ALIVE_SECONDS = 300
#: The same keep-alive as Elasticsearch takes it.
AUDIT_PIT_KEEP_ALIVE = f"{AUDIT_PIT_KEEP_ALIVE_SECONDS}s"
#: Totals are counted exactly up to this many rows, then reported as a lower bound.
AUDIT_TRACK_TOTAL = 10_000
#: Snapshot closes started after their request was cancelled (kept so they are not
#: collected before they run).
_DETACHED_CLOSES: set["asyncio.Future[None]"] = set()
_PIT_GONE_MARKERS = (
    "point-in-time", "point in time", "search_context_missing", "no search context",
)


def _pit_gone(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    return any(marker in text for marker in _PIT_GONE_MARKERS)


def _total_of(resp: dict[str, Any], fallback: int) -> tuple[int, str]:
    raw = (resp.get("hits") or {}).get("total")
    if isinstance(raw, dict):
        value = int(raw.get("value", fallback) or 0)
        relation = "gte" if raw.get("relation") == "gte" else "eq"
        return value, relation
    if isinstance(raw, (int, float)):
        return int(raw), "eq"
    return fallback, "eq"


class AuditLogger(AuditRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def write(self, doc: AuditDoc) -> None:
        try:
            await self.write_strict(doc)
        except Exception as exc:  # noqa: BLE001
            logger.error("AUDIT WRITE FAILED (action=%s case=%s): %s",
                         doc.action_type, doc.case_id, exc)

    async def write_strict(self, doc: AuditDoc) -> None:
        """Append one row and propagate failure for privileged durability gates.

        A deterministic ``event_id`` is reserved for retryable privileged events.
        Confirm an existing semantically equivalent row before returning (the first
        append retains its timestamp); otherwise write it under that id so
        concurrent/retried privileged decisions converge on one immutable evidence
        document.
        """
        payload = stamp_new_record(doc).model_dump(mode="json")
        if doc.event_id:
            await append_keyed_ledger_row(
                self._es,
                scope="audit",
                logical_id=doc.event_id,
                payload=payload,
                write_alias=AUDIT_WRITE_ALIAS,
                read_pattern=AUDIT_READ_PATTERN,
                reject_conflicting_retry=True,
                retry_metadata=frozenset({"ts", "app_version", "build_sha"}),
            )
            return
        await self._es.index_doc(AUDIT_WRITE_ALIAS, payload)

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
        outcome: str | None = None,
        actor_type: str | None = None,
        action: str | None = None,
        actor_role: str | None = None,
        client: AuditClient | dict[str, Any] | None = None,
        session_ref: str | None = None,
        target: AuditTarget | dict[str, Any] | None = None,
        changes: list[AuditChange | dict[str, Any]] | None = None,
        request_id: str | None = None,
        run_id: str | None = None,
    ) -> None:
        try:
            doc = build_audit_doc_best_effort(
                action_type=action_type,
                surface=surface,
                actor=actor,
                case_id=case_id,
                source_id=source_id,
                model=model,
                prompt_excerpt=prompt_excerpt,
                query_text=query_text,
                tool_name=tool_name,
                tool_input=tool_input,
                tool_output_summary=tool_output_summary,
                result_summary=result_summary,
                outcome=outcome,
                actor_type=actor_type,
                action=action,
                actor_role=actor_role,
                client=client,
                session_ref=session_ref,
                target=target,
                changes=changes,
                request_id=request_id,
                run_id=run_id,
            )
        except Exception as exc:  # noqa: BLE001 (best effort: never raise into the caller)
            logger.error("AUDIT WRITE FAILED (action=%s case=%s): invalid row: %s",
                         action_type, case_id, exc)
            return
        await self.write(doc)

    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """Read the newest bounded audit rows, returned OLDEST first (C3-3 trace).

        Read-only on the management-scoped audit index. Never raises — returns an
        empty list on any error so the trace endpoint NEVER 404s/500s."""
        try:
            cap = max(1, min(int(limit or 500), 500))
            resp = await self._es.search(
                AUDIT_READ_PATTERN,
                {
                    "query": {"term": {"case_id": case_id}},
                    "sort": [{"ts": {"order": "desc"}}],
                    "size": cap,
                },
            )
            newest_first = [
                h.get("_source", {}) or {}
                for h in resp.get("hits", {}).get("hits", [])
            ]
            newest_first.reverse()
            return newest_first
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit read for case %s failed: %s", case_id, exc)
            return []

    async def records_for_actor(self, actor: str, limit: int = 50) -> list[dict[str, Any]]:
        """Recent audit rows attributed to ``actor`` (NEWEST first) — the per-user
        account-activity feed (Wave 3). Read-only; never raises."""
        if not actor:
            return []
        try:
            resp = await self._es.search(
                AUDIT_READ_PATTERN,
                {
                    "query": {"term": {"actor": actor}},
                    "sort": [{"ts": {"order": "desc"}}],
                    "size": limit,
                },
            )
            return [h.get("_source", {}) or {} for h in resp.get("hits", {}).get("hits", [])]
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
        """Filtered, bounded listing of the append-only audit for the admin audit
        viewer (W7c). NEWEST first. A term/range bool query; absent filters are
        omitted. Read-only on the management-scoped audit index; never raises.

        ``source_id`` (A5.3 coverage observability) filters to the append-only poll
        history of a single source (e.g. ``GET /api/audit?source_id=elk-a``)."""
        filters: list[dict[str, Any]] = []
        if actor:
            filters.append({"term": {"actor": actor}})
        if action_type:
            filters.append({"term": {"action_type": action_type}})
        if surface:
            filters.append({"term": {"surface": surface}})
        if case_id:
            filters.append({"term": {"case_id": case_id}})
        if source_id:
            filters.append({"term": {"source_id": source_id}})
        if ts_from or ts_to:
            rng: dict[str, str] = {}
            if ts_from:
                rng["gte"] = ts_from
            if ts_to:
                rng["lte"] = ts_to
            filters.append({"range": {"ts": rng}})
        query: dict[str, Any] = (
            {"bool": {"filter": filters}} if filters else {"match_all": {}}
        )
        try:
            resp = await self._es.search(
                AUDIT_READ_PATTERN,
                {
                    "query": query,
                    "sort": [{"ts": {"order": "desc"}}],
                    "size": limit,
                },
            )
            return [h.get("_source", {}) or {} for h in resp.get("hits", {}).get("hits", [])]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit records read failed: %s", exc)
            return []

    # ------------------------------------------------------------------ #
    # Round 14 read API (SPEC §4.5.5)
    # ------------------------------------------------------------------ #
    async def search_page(
        self,
        predicate: Any,
        *,
        order: str = "desc",
        limit: int = 50,
        cursor: Any = None,
        track_total: int = AUDIT_TRACK_TOTAL,
    ) -> AuditSearchPage:
        """One page through a point-in-time snapshot (``search_after`` on ``ts`` then
        ``_shard_doc``), so "Load more" never skips or repeats a row while new rows
        arrive. Without point-in-time support the page falls back to ``from`` paging
        inside the first 10,000 rows. The first page opens the snapshot; a later page
        whose snapshot has expired raises :class:`AuditCursorExpired`."""
        from .query import to_es_query

        size = max(1, min(int(limit or 50), 1000))
        direction = "asc" if order == "asc" else "desc"
        state = cursor if isinstance(cursor, dict) else {}
        continuing = bool(state)
        pit_id = str(state.get("pit") or "")
        if not continuing:
            try:
                pit_id = str(await self._es.open_state_pit(AUDIT_READ_PATTERN, AUDIT_PIT_KEEP_ALIVE) or "")
            except Exception as exc:  # noqa: BLE001 (a store without point-in-time pages by offset)
                logger.info("Audit read: point-in-time unavailable, paging by offset: %s", exc)
                pit_id = ""
        body: dict[str, Any] = {
            "query": to_es_query(predicate),
            "size": size + 1,
            "track_total_hits": int(track_total) if track_total else True,
        }
        offset = 0
        if pit_id:
            body["pit"] = {"id": pit_id, "keep_alive": AUDIT_PIT_KEEP_ALIVE}
            body["sort"] = [{"ts": {"order": direction}}, {"_shard_doc": {"order": direction}}]
            after = state.get("after")
            if isinstance(after, list) and after:
                body["search_after"] = after
        else:
            try:
                offset = max(0, int(state.get("offset", 0) or 0))
            except (TypeError, ValueError):
                offset = 0
            if offset >= AUDIT_TRACK_TOTAL:
                return AuditSearchPage(hits=[], total=offset, relation="gte", exhausted=True,
                                       start={"offset": offset})
            body["sort"] = [{"ts": {"order": direction}}]
            body["from"] = offset
            body["size"] = min(size + 1, AUDIT_TRACK_TOTAL - offset)
        try:
            resp = await self._es.search(AUDIT_READ_PATTERN, body)
        except asyncio.CancelledError:
            # The request went away after this page opened its snapshot: nothing will
            # ever continue it, so close it in the background.
            if pit_id and not continuing:
                self._close_detached({"pit": pit_id})
            raise
        except Exception as exc:
            if continuing and pit_id and _pit_gone(exc):
                raise AuditCursorExpired(str(exc)) from exc
            if pit_id and not continuing:
                await self.close_search_cursor({"pit": pit_id})
            raise
        if continuing and pit_id and not resp.get("pit_id"):
            # Elasticsearch answers a search on an expired point-in-time with 404,
            # which the client turns into an empty result without a ``pit_id``.
            raise AuditCursorExpired("the point-in-time snapshot has expired")
        live_pit = str(resp.get("pit_id") or pit_id)
        raw_hits = list(resp.get("hits", {}).get("hits", []) or [])
        more = len(raw_hits) > size
        hits: list[AuditHit] = []
        for i, hit in enumerate(raw_hits[:size]):
            source = hit.get("_source") or {}
            position: dict[str, Any] = (
                {"pit": live_pit, "after": hit.get("sort")} if pit_id else {"offset": offset + i + 1}
            )
            hits.append(AuditHit(
                "es", str(hit.get("_id") or ""), str(hit.get("_index") or ""),
                dict(source) if isinstance(source, dict) else {}, position,
            ))
        if not pit_id and offset + len(hits) >= AUDIT_TRACK_TOTAL:
            more = False
        total, relation = _total_of(resp, len(hits))
        start: dict[str, Any] = (
            {"pit": live_pit, "after": state.get("after")} if pit_id else {"offset": offset}
        )
        return AuditSearchPage(hits=hits, total=total, relation=relation, exhausted=not more,
                               start=start)

    async def count_matching(self, predicate: Any, *, cap: int) -> tuple[int, str]:
        """Exact up to ``cap`` (``track_total_hits: cap``), then ``(cap, "gte")``."""
        from .query import to_es_query

        cap = max(1, int(cap))
        resp = await self._es.search(
            AUDIT_READ_PATTERN,
            {"query": to_es_query(predicate), "size": 0, "track_total_hits": cap},
        )
        total, relation = _total_of(resp, 0)
        if total >= cap and relation == "gte":
            return cap, "gte"
        return min(total, cap), relation

    async def run_totals(
        self, predicate: Any, run_ids: list[str], *, snapshot: Any = None,
    ) -> dict[str, int]:
        """One ``filters`` aggregation, a bucket per run id (query-based, so it works
        whether ``run_id`` is mapped as a keyword or dynamically as text).

        With the page's ``snapshot`` (a position carrying its point-in-time) the
        aggregation runs inside that point-in-time, so a run's total counts exactly
        the rows the read can page to, however many rows the investigation writes
        meanwhile. Without one (offset paging) it counts the live index."""
        from .query import Eq, all_of, run_ids_filter, to_es_query

        wanted = sorted({r for r in run_ids if isinstance(r, str) and r})
        if not wanted:
            return {}
        body: dict[str, Any] = {
            "query": to_es_query(all_of(predicate, run_ids_filter(wanted))),
            "size": 0,
            "aggs": {
                "runs": {
                    "filters": {
                        "filters": {run: to_es_query(Eq("run_id", run)) for run in wanted}
                    }
                }
            },
        }
        pit_id = str(snapshot.get("pit") or "") if isinstance(snapshot, dict) else ""
        if pit_id:
            body["pit"] = {"id": pit_id, "keep_alive": AUDIT_PIT_KEEP_ALIVE}
        resp = await self._es.search(AUDIT_READ_PATTERN, body)
        buckets = (resp.get("aggregations") or {}).get("runs", {}).get("buckets") or {}
        out: dict[str, int] = {}
        if isinstance(buckets, dict):
            for run, bucket in buckets.items():
                count = int((bucket or {}).get("doc_count") or 0)
                if count:
                    out[str(run)] = count
        return out

    async def get_record(self, ref: AuditRecordRef) -> AuditHit | None:
        """The row ``ref`` names, read through the audit index pattern only."""
        if ref.store != "es" or not ref.index or not fnmatch.fnmatchcase(ref.index, AUDIT_READ_PATTERN):
            return None
        resp = await self._es.search(
            AUDIT_READ_PATTERN,
            {
                "query": {"bool": {"filter": [
                    {"ids": {"values": [str(ref.ref)]}},
                    {"term": {"_index": ref.index}},
                ]}},
                "size": 1,
            },
        )
        for hit in resp.get("hits", {}).get("hits", []) or []:
            if str(hit.get("_id")) == str(ref.ref) and str(hit.get("_index")) == ref.index:
                source = hit.get("_source") or {}
                return AuditHit("es", str(ref.ref), ref.index,
                                dict(source) if isinstance(source, dict) else {}, None)
        return None

    def _close_detached(self, cursor: Any) -> None:
        task = asyncio.ensure_future(self.close_search_cursor(cursor))
        _DETACHED_CLOSES.add(task)
        task.add_done_callback(_DETACHED_CLOSES.discard)

    async def close_search_cursor(self, cursor: Any) -> None:
        if isinstance(cursor, dict) and cursor.get("pit"):
            try:
                await self._es.close_state_pit(str(cursor["pit"]))
            except Exception as exc:  # noqa: BLE001 (the snapshot expires on its own)
                logger.debug("Audit read: closing a point-in-time failed: %s", exc)

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """PIT + ``_shard_doc`` page for an exact append-only ledger snapshot."""
        cap = max(1, min(int(limit or 1000), 5000))
        pit_id = str(cursor.get("pit", "")) if isinstance(cursor, dict) else ""
        after = cursor.get("after") if isinstance(cursor, dict) else None
        seen = max(0, int(cursor.get("seen", 0) or 0)) if isinstance(cursor, dict) else 0
        if not pit_id:
            pit_id = str(await self._es.open_state_pit(AUDIT_READ_PATTERN, "10m") or "")
        body: dict[str, Any] = {
            "size": cap,
            "track_total_hits": True,
            "query": {"match_all": {}},
            "sort": ["_shard_doc"] if pit_id else [{"ts": {"order": "asc", "missing": "_first"}}],
        }
        if pit_id:
            body["pit"] = {"id": pit_id, "keep_alive": "10m"}
            if isinstance(after, list) and len(after) == 1:
                body["search_after"] = after
        resp = await self._es.search(AUDIT_READ_PATTERN, body)
        if pit_id:
            pit_id = str(resp.get("pit_id") or pit_id)
        raw_hits = resp.get("hits", {}).get("hits", [])
        rows = [hit.get("_source", {}) or {} for hit in raw_hits]
        total_raw = resp.get("hits", {}).get("total", {})
        total = int(total_raw.get("value", len(rows))) if isinstance(total_raw, dict) else int(total_raw)
        if not pit_id:
            # ``_id`` is not sortable by default on modern Elasticsearch. Without
            # PIT there is no safe unique lifetime cursor, so do not pretend this
            # compatibility page can continue or has a proven total.
            return rows, None, None, "unverified"
        marker = raw_hits[-1].get("sort") if raw_hits else after
        return rows, {"pit": pit_id, "after": marker, "seen": seen + len(rows)}, total, "point_in_time"

    async def close_export_cursor(self, cursor: Any) -> None:
        if isinstance(cursor, dict) and cursor.get("pit"):
            await self._es.close_state_pit(str(cursor["pit"]))
