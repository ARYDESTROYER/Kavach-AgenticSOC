"""Case store (Section 7.1).

Cases are keyed by ``case_id`` (the ES document id) so writes are idempotent
overwrites. Idempotency at the *investigation* level is enforced one layer up by
``find_open_by_signature`` (Section 6.2 / Non-negotiable #4): the same cluster
signature maps to the same open case, so re-polling never creates duplicates.
"""

from __future__ import annotations

import logging
from typing import Any

from ..build_identity import stamp_new_record
from ..constants import (
    CASES_READ_PATTERN,
    CASES_WRITE_ALIAS,
    OPEN_CASE_STATUSES,
    SourceSurface,
)
from ..es.base import BaseESClient
from ..models import Case
from ..utils import relative_to_iso_utc_strict
from .base import CaseRepository, status_group_statuses, window_bounds_proven

logger = logging.getLogger("tlsoc.cases")


class PartialSearchError(RuntimeError):
    """Elasticsearch answered HTTP 200 with PARTIAL results (a failed shard or a timed
    out search; ``allow_partial_search_results`` defaults to true). A scan treats it as
    a store failure (the result is then partial, never exact) and a push-down declines
    so the engine folds."""


def check_complete_response(resp: Any) -> None:
    """Raise :class:`PartialSearchError` when ``resp`` reports a failed shard or a
    timed-out search. A response without ``_shards`` (the in-memory backend, a mocked
    client) carries no such evidence and passes."""
    if not isinstance(resp, dict):
        return
    if resp.get("timed_out"):
        raise PartialSearchError("the search timed out, so its results are partial")
    shards = resp.get("_shards")
    if isinstance(shards, dict):
        try:
            failed = int(shards.get("failed") or 0)
        except (TypeError, ValueError):
            failed = 0
        if failed > 0:
            total = shards.get("total")
            raise PartialSearchError(
                f"{failed} of {total if total is not None else 'the'} shards failed, "
                "so the search results are partial"
            )

# Any NON-terminal lifecycle status counts as "open" for the signature idempotency
# lookup (#4) — including the F8 statuses (NEW/INVESTIGATING/ESCALATED/ON_HOLD), so
# an escalated/held case still attaches its new events instead of duplicating.
_OPEN_STATUSES = list(OPEN_CASE_STATUSES)

# The FINAL, UNIQUE sort key appended to every case listing. ``case_id`` is the
# Elasticsearch document id and is mapped ``keyword`` (``es/indices.CASES_MAPPING``), so
# it is both sortable and unique — which is exactly what a tiebreaker has to be.
#
# Why it is not optional: a one-element sort array leaves the order among EQUAL primary
# keys undefined. Real Elasticsearch resolves such ties per shard and is not obliged to
# resolve them the same way on the next search, so ``from``/``size`` paging over a tied
# key repeats some rows on the next page and skips others. ``risk_score`` ties hard (the
# risk engine emits a small set of round values) and ``created_at`` is second-resolution,
# so ties are the normal case here, not the exotic one. Neither offline backend can show
# this — :class:`~app.es.fake.InMemoryESClient` sorts with Python's STABLE sort — which is
# why the contract is asserted on the emitted sort SHAPE instead of on observed rows.
CASE_SORT_TIEBREAKER = "case_id"


def case_sort_clause(sort_field: str, sort_order: str) -> list[dict[str, dict[str, str]]]:
    """The Elasticsearch ``sort`` array for a case listing: primary key, then tiebreaker.

    ``sort_order`` is normalised to one of the two directions the DSL accepts rather
    than interpolated verbatim: this function is the boundary where a caller-supplied
    value becomes part of a query document, and a value real Elasticsearch cannot read
    is a 400 for the whole listing. (The HTTP surface allow-lists the field name for the
    same reason — the field becomes a query-document KEY, which no escaping can make
    safe after the fact.)"""
    order = "asc" if str(sort_order).lower() == "asc" else "desc"
    clause = [{sort_field: {"order": order}}]
    if sort_field != CASE_SORT_TIEBREAKER:
        clause.append({CASE_SORT_TIEBREAKER: {"order": order}})
    return clause


class CaseStore(CaseRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def save(self, case: Case) -> None:
        # The repository is the final immutability boundary, including for internal
        # direct callers that submit a complete but changed pair.  New records may
        # carry an explicit producer hand-off; every update restores the persisted
        # creation identity (including legacy nulls) before the upsert.
        existing = await self._es.get_doc_strict(CASES_WRITE_ALIAS, case.case_id)
        if existing is None:
            persisted = stamp_new_record(case)
        else:
            persisted = case.model_copy(
                update={
                    "app_version": existing.get("app_version"),
                    "build_sha": existing.get("build_sha"),
                }
            )
        await self._es.index_doc(
            CASES_WRITE_ALIAS,
            persisted.model_dump(mode="json"),
            doc_id=persisted.case_id,
            refresh=True,
        )

    async def get(self, case_id: str) -> Case | None:
        body = {"size": 1, "query": {"term": {"case_id": case_id}}}
        resp = await self._es.search(CASES_READ_PATTERN, body)
        return _first_case(resp)

    async def find_open_by_signature(self, signature: str) -> Case | None:
        """Return an OPEN/NEEDS_HUMAN case for this cluster signature, if any.

        This is the idempotency lookup: events for an already-open cluster attach
        to it rather than spawning a duplicate case."""
        body = {
            "size": 1,
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"cluster_signature": signature}},
                        {"terms": {"status": _OPEN_STATUSES}},
                    ]
                }
            },
            "sort": [{"updated_at": {"order": "desc"}}],
        }
        resp = await self._es.search(CASES_READ_PATTERN, body)
        return _first_case(resp)

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
        filters: list[dict[str, Any]] = []
        if status:
            filters.append({"term": {"status": status}})
        if source_surface:
            filters.append({"term": {"source_surface": source_surface}})
        if entity_value:
            filters.append({"term": {"entity.value": entity_value}})
        body = {
            "size": limit,
            "from": offset,
            "query": {"bool": {"filter": filters}} if filters else {"match_all": {}},
            "sort": case_sort_clause(sort_field, sort_order),
        }
        resp = await self._es.search(CASES_READ_PATTERN, body)
        cases = [Case.model_validate(h["_source"]) for h in resp.get("hits", {}).get("hits", [])]
        total = int(resp.get("hits", {}).get("total", {}).get("value", len(cases)))
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

        The window is a real Elasticsearch clause, so the returned page is drawn from
        the WHOLE matching set (page 2 of a 30d window is the middle of that window,
        not the tail of the newest N rows) and ``total`` is a true ``_count`` over the
        whole corpus rather than the length of one fetched page.

        NEVER-DROP (#4) is expressed as the COMPLEMENT of the window —
        ``must_not: [created_at < lo, created_at > hi]`` — rather than a
        ``should`` union of "in range OR empty". A range clause cannot match a document
        whose ``created_at`` cannot be placed on the time axis, so the complement keeps
        exactly those documents while dropping only the ones provably outside the
        window. The union form cannot do this: ``created_at`` is mapped as a ``date``
        (``es/indices.py``), and a ``term``/``range`` probe for the empty string against
        a date field is rejected outright by real Elasticsearch, which would 400 the
        whole listing. ``NOT(x < lo) AND NOT(x > hi)`` is exactly ``lo <= x <= hi`` for
        every document that HAS a readable date, so nothing else changes.

        The complement only satisfies never-drop while "cannot be placed" really does
        yield no match. On a real cluster that is structural: ``created_at`` is a
        ``date`` field with no ``ignore_malformed``, so an unreadable value is rejected
        at index time and cannot exist. On :class:`~app.es.fake.InMemoryESClient` —
        which is a SHIPPED backend, not only a test double (``state._build_es_client``
        falls back to it whenever no ES key is configured, and Demo Mode runs on it) —
        it holds because ``es/fake._to_comparable`` reports an unreadable string as
        ``None`` instead of mining a number out of it. That is a contract between the
        two files, so it is pinned from both ends.

        Bounds are normalised to one ISO-8601 UTC spelling first (the strict parser: an
        unreadable bound is reported, not silently resolved to ``now()``); an
        unresolvable bound is treated as absent rather than as "right now", and
        ``exact`` then reports ``False`` because the applied window is WIDER than the
        one the caller asked for (see :func:`~app.stores.base.window_bounds_proven`).

        ``status_group`` pushes a MULTI-status lifecycle set down as a real ``terms``
        clause, resolved from the product's own status constants
        (:data:`~app.stores.base.CASE_STATUS_GROUPS`). It is a genuine backend filter, so
        the page is drawn from the whole matching set and ``total`` counts it — the
        window's ``exact`` contract is untouched, because the group narrows WHICH rows
        match, never how well the requested time bounds could be resolved."""
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

        filters: list[dict[str, Any]] = []
        if status:
            filters.append({"term": {"status": status}})
        if source_surface:
            filters.append({"term": {"source_surface": source_surface}})
        if entity_value:
            filters.append({"term": {"entity.value": entity_value}})
        if group is not None:
            filters.append({"terms": {"status": list(group)}})
        outside: list[dict[str, Any]] = []
        if lo is not None:
            outside.append({"range": {"created_at": {"lt": lo}}})
        if hi is not None:
            outside.append({"range": {"created_at": {"gt": hi}}})
        filters.append({"bool": {"must_not": outside}})
        query = {"bool": {"filter": filters}}

        body = {
            "size": limit,
            "from": offset,
            "query": query,
            "sort": case_sort_clause(sort_field, sort_order),
        }
        resp = await self._es.search(CASES_READ_PATTERN, body)
        cases = [Case.model_validate(h["_source"]) for h in resp.get("hits", {}).get("hits", [])]
        # ``hits.total`` is capped at 10 000 by default, so the authoritative windowed
        # count comes from a dedicated _count (the same idiom as count_created_since).
        total = await self._es.count(CASES_READ_PATTERN, {"query": query})
        return cases, int(total), proven

    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        """Surface 3: the automated-scans queue."""
        return await self.list(
            source_surface=SourceSurface.AUTOMATED_SCAN.value, limit=limit
        )

    async def count_new_scans(self, since_iso: str) -> int:
        body = {
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"source_surface": SourceSurface.AUTOMATED_SCAN.value}},
                        {"range": {"created_at": {"gt": since_iso}}},
                    ]
                }
            }
        }
        return await self._es.count(CASES_READ_PATTERN, body)

    async def count_created_since(self, since_iso: str) -> int:
        """Native COUNT push-down: cases created at/after ``since_iso`` (inclusive),
        across every surface/status — one ``_count`` request, zero documents fetched.
        Same idiom as :meth:`count_new_scans` (which is exclusive + scan-scoped)."""
        body = {"query": {"range": {"created_at": {"gte": since_iso}}}}
        return await self._es.count(CASES_READ_PATTERN, body)

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[Case], Any | None, int | None, str]:
        """PIT + ``_shard_doc`` page for a fixed, lifetime-safe case snapshot."""
        cap = max(1, min(int(limit or 1000), 5000))
        pit_id = str(cursor.get("pit", "")) if isinstance(cursor, dict) else ""
        after = cursor.get("after") if isinstance(cursor, dict) else None
        seen = max(0, int(cursor.get("seen", 0) or 0)) if isinstance(cursor, dict) else 0
        opened_here = False
        if not pit_id:
            pit_id = str(await self._es.open_state_pit(CASES_READ_PATTERN, "10m") or "")
            opened_here = bool(pit_id)
        if pit_id:
            body: dict[str, Any] = {
                "size": cap,
                "track_total_hits": True,
                "query": {"match_all": {}},
                "pit": {"id": pit_id, "keep_alive": "10m"},
                "sort": ["_shard_doc"],
            }
            if isinstance(after, list) and len(after) == 1:
                body["search_after"] = after
            consistency = "point_in_time"
        else:
            # Compatibility clients without PIT keep a stable immutable-field order,
            # but case values may change between pages; the API labels that honestly.
            body = {
                "size": cap,
                "track_total_hits": True,
                "query": {"match_all": {}},
                "sort": [
                    {"created_at": {"order": "asc", "missing": "_first"}},
                    {"case_id": {"order": "asc"}},
                ],
            }
            if isinstance(cursor, list) and len(cursor) == 2:
                body["search_after"] = cursor
            consistency = "bounded_at_start"
        try:
            resp = await self._es.search(CASES_READ_PATTERN, body)
            # A failed shard or a timed-out search is partial: never an exact page.
            check_complete_response(resp)
            if pit_id:
                pit_id = str(resp.get("pit_id") or pit_id)
            raw_hits = resp.get("hits", {}).get("hits", [])
            rows = [Case.model_validate(hit.get("_source", {})) for hit in raw_hits]
        except BaseException:
            # A snapshot THIS call opened is released before the error leaves it.
            if opened_here and pit_id:
                try:
                    await self._es.close_state_pit(pit_id)
                except Exception:  # noqa: BLE001 — a PIT also expires on its own
                    pass
            raise
        total_raw = resp.get("hits", {}).get("total", {})
        total = int(total_raw.get("value", len(rows))) if isinstance(total_raw, dict) else int(total_raw)
        marker = raw_hits[-1].get("sort") if raw_hits else after
        next_cursor: Any | None
        if pit_id:
            # Return the handle even on the last page. The API closes it only after
            # the serialized segment is known to fit, allowing adaptive page shrink.
            next_cursor = {"pit": pit_id, "after": marker, "seen": seen + len(rows)}
        else:
            next_cursor = marker if raw_hits and len(raw_hits) >= cap else None
        return rows, next_cursor, total, consistency

    async def close_export_cursor(self, cursor: Any) -> None:
        if isinstance(cursor, dict) and cursor.get("pit"):
            await self._es.close_state_pit(str(cursor["pit"]))

    # -- Round 12 exact aggregates -------------------------------------------- #
    async def scan_page(
        self,
        *,
        limit: int = 1000,
        cursor: Any = None,
        created_from: Any = None,
        created_to: Any = None,
        raw: bool = False,
        statuses: Any = None,
        newest_first: bool = False,
    ) -> tuple[list[Case], Any | None, int | None, str]:
        """PIT scan page with the ``created_at`` window pushed down as the never-drop
        complement (see :meth:`list_window`), half-open ``[created_from, created_to)``,
        and an optional ``statuses`` ``terms`` pre-filter. ``newest_first`` orders by
        ``created_at`` desc (a missing date last), then ``case_id``; otherwise the
        cheapest ``_shard_doc`` order. ``next_cursor`` is ``None`` once exhausted, and
        the snapshot is then already released.

        A partial response (a failed shard, a timed-out search) raises
        :class:`PartialSearchError` rather than being read as the last page. A snapshot
        THIS call opened is closed before any error leaves it (a failed first page or an
        undecodable document must never strand a PIT: the cluster caps open PITs)."""
        cap = max(1, min(int(limit or 1000), 5000))
        state = dict(cursor) if isinstance(cursor, dict) else {}
        pit_id = str(state.get("pit") or "")
        opened_here = False
        if not pit_id and not state.get("nopit"):
            pit_id = str(await self._es.open_state_pit(CASES_READ_PATTERN, "10m") or "")
            opened_here = bool(pit_id)
            if not pit_id:
                state["nopit"] = True
        try:
            query = _window_query(created_from, created_to)
            if statuses is not None:
                wanted = sorted({str(v) for v in statuses})
                query = {"bool": {"filter": [query, {"terms": {"status": wanted}}]}}
            after = state.get("after")
            if newest_first:
                sort: list[Any] = [
                    {"created_at": {"order": "desc", "missing": "_last"}},
                    {CASE_SORT_TIEBREAKER: {"order": "desc"}},
                ]
                if pit_id:
                    sort.append({"_shard_doc": "desc"})
            elif pit_id:
                sort = ["_shard_doc"]
            else:
                sort = [
                    {"created_at": {"order": "asc", "missing": "_first"}},
                    {CASE_SORT_TIEBREAKER: {"order": "asc"}},
                ]
            body: dict[str, Any] = {
                "size": cap, "track_total_hits": True, "query": query, "sort": sort,
            }
            if pit_id:
                body["pit"] = {"id": pit_id, "keep_alive": "10m"}
                consistency = "point_in_time"
            else:
                consistency = "bounded_at_start"
            if isinstance(after, list) and after:
                body["search_after"] = after
            resp = await self._es.search(CASES_READ_PATTERN, body)
            check_complete_response(resp)
            if pit_id:
                pit_id = str(resp.get("pit_id") or pit_id)
            raw_hits = resp.get("hits", {}).get("hits", [])
            rows: list[Any] = (
                [hit.get("_source", {}) or {} for hit in raw_hits] if raw
                else [Case.model_validate(hit.get("_source", {})) for hit in raw_hits]
            )
            total_raw = resp.get("hits", {}).get("total", {})
            total = (int(total_raw.get("value", len(rows))) if isinstance(total_raw, dict)
                     else int(total_raw))
        except BaseException:
            if opened_here and pit_id:
                try:
                    await self._es.close_state_pit(pit_id)
                except Exception:  # noqa: BLE001 — a PIT also expires on its own
                    pass
            raise
        if len(raw_hits) < cap:
            if pit_id:
                try:
                    await self._es.close_state_pit(pit_id)
                except Exception:  # noqa: BLE001 — a PIT also expires on its own
                    pass
            return rows, None, total, consistency
        nxt: dict[str, Any] = {"after": raw_hits[-1].get("sort")}
        if pit_id:
            nxt["pit"] = pit_id
        else:
            nxt["nopit"] = True
        return rows, nxt, total, consistency

    async def aggregate(self, spec: Any) -> Any | None:
        """Native composite push-down for COUNT-style specs; ``None`` otherwise.

        Answers only what the bundled mapping makes aggregatable with EXACTLY the
        fold's semantics (``es/indices.CASES_MAPPING``): the keyword fields ``status``,
        ``verdict``, ``decision_by``, ``source_surface``, ``rule_ids`` and
        ``entity.value``, bucketed by a ``date_histogram`` over the ``created_at`` date
        (``calendar_interval`` + ``time_zone``), for the metrics ``count`` and
        ``open_now``. Everything else — derived bands, analyst-confirmed outcomes,
        lifecycle percentiles, fields the bootstrap never mapped (``assignee``,
        ``disposition``, ``source_id``) and case-insensitive filters — returns ``None``
        and the engine folds. The bootstrap never remaps an existing index, so a field
        is never assumed aggregatable.

        Consistency: every search (composite pages, total, missing-date count, edges,
        open stock) runs inside ONE state point-in-time, so the result is
        ``point_in_time`` and its total equals the sum of its groups even while cases
        are being written. A failed shard or a timed-out search raises (the engine then
        folds), and a client without PIT support returns ``None``. A bounded window is
        a positive ``created_at`` range: a case without a readable date is disclosed in
        ``missing_created``, not counted (the dashboards' membership rule)."""
        return await _es_case_pushdown(self._es, spec)


def _window_query(created_from: Any, created_to: Any) -> dict[str, Any]:
    """``match_all`` or the never-drop complement of ``[created_from, created_to)``."""
    from ..engine.case_aggregate import iso_bound

    lo = iso_bound(created_from)
    hi = iso_bound(created_to)
    outside: list[dict[str, Any]] = []
    if lo is not None:
        outside.append({"range": {"created_at": {"lt": lo}}})
    if hi is not None:
        outside.append({"range": {"created_at": {"gte": hi}}})
    if not outside:
        return {"match_all": {}}
    return {"bool": {"filter": [{"bool": {"must_not": outside}}]}}


# Group fields / filters the bundled mapping makes aggregatable with EXACTLY the fold's
# semantics → the mapped keyword field. ``status_group`` is folded from ``status`` in
# Python (exact: the group is a pure function of the status).
_ES_GROUP_FIELDS = {
    "verdict": "verdict",
    "status": "status",
    "status_group": "status",
    "surface": "source_surface",
    "decided_by": "decision_by",
    "rule": "rule_ids",
}
_ES_FILTER_FIELDS = {
    "status": "status",
    "status_group": "status",
    "verdict": "verdict",
    "entity": "entity.value",
    "surface": "source_surface",
    "decided_by": "decision_by",
}
_ES_PUSHDOWN_METRICS = frozenset({"count", "open_now"})
_COMPOSITE_PAGE = 1000
# A readable ``created_at`` is at or after this; a missing one (or, on the in-memory
# backend, an unreadable string) is not — the complement counts "no creation date".
_DATED = {"range": {"created_at": {"gte": "0001-01-01T00:00:00+00:00"}}}


class _Snapshot:
    """One state PIT shared by every search of a push-down, so the composite pages, the
    total, the missing-date count, the edges and the open stock all read ONE snapshot
    (the totals then always equal the sum of their groups, even under live ingest)."""

    def __init__(self, es: BaseESClient, pit_id: str) -> None:
        self.es = es
        self.pit_id = pit_id

    async def search(self, body: dict[str, Any]) -> dict[str, Any]:
        resp = await self.es.search(
            CASES_READ_PATTERN, {**body, "pit": {"id": self.pit_id, "keep_alive": "2m"}},
        )
        check_complete_response(resp)
        self.pit_id = str(resp.get("pit_id") or self.pit_id)
        return resp


async def _es_count(snap: _Snapshot, query: dict[str, Any]) -> int:
    resp = await snap.search({"size": 0, "track_total_hits": True, "query": query})
    total = resp.get("hits", {}).get("total", {})
    return int(total.get("value", 0) if isinstance(total, dict) else total or 0)


async def _es_edge_created(snap: _Snapshot, query: dict[str, Any], order: str) -> Any:
    resp = await snap.search({
        "size": 1,
        "query": {"bool": {"filter": [query, _DATED]}},
        "sort": [{"created_at": {"order": order}}, {CASE_SORT_TIEBREAKER: {"order": order}}],
        "_source": ["created_at"],
    })
    hits = resp.get("hits", {}).get("hits", [])
    if not hits:
        return None
    from ..utils import parse_es_timestamp

    return parse_es_timestamp((hits[0].get("_source") or {}).get("created_at"))


async def _es_composite(
    snap: _Snapshot, query: dict[str, Any], sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Every bucket of one composite aggregation, paged with ``after`` (no truncation)."""
    out: list[dict[str, Any]] = []
    after: dict[str, Any] | None = None
    while True:
        composite: dict[str, Any] = {"size": _COMPOSITE_PAGE, "sources": sources}
        if after:
            composite["after"] = after
        resp = await snap.search({
            "size": 0, "query": query, "aggs": {"g": {"composite": composite}},
        })
        agg = (resp.get("aggregations") or {}).get("g")
        if not isinstance(agg, dict) or not isinstance(agg.get("buckets"), list):
            raise RuntimeError("the backend did not return a composite aggregation")
        buckets = agg["buckets"]
        out.extend(buckets)
        after = agg.get("after_key")
        if not buckets or not after or len(buckets) < _COMPOSITE_PAGE:
            return out


def window_clauses(window: Any, field: str = "created_at") -> list[dict[str, Any]]:
    """The positive ``[start, end)`` range of a BOUNDED window (no clause for all
    time). A record whose date cannot be placed in time matches no range, which is the
    aggregate's membership rule: a bounded window does not count it (it is disclosed)."""
    from ..engine.case_aggregate import iso_bound

    bounds: dict[str, Any] = {}
    if window.start is not None:
        bounds["gte"] = iso_bound(window.start)
    if not window.open_end:
        bounds["lt"] = iso_bound(window.end)
    return [{"range": {field: bounds}}] if bounds else []


async def _es_case_pushdown(es: BaseESClient, spec: Any) -> Any | None:
    """See :meth:`CaseStore.aggregate`. Every search runs inside ONE state PIT (closed
    afterwards); a partial response raises (the engine then folds); no PIT support
    returns ``None`` (fold) rather than claiming a consistency it cannot prove."""
    from datetime import datetime, timezone

    from ..engine.case_aggregate import (
        MISSING_BUCKET,
        RowSet,
        build_case_result,
        normalise_case_filters,
    )
    from .base import CASE_STATUS_GROUPS

    metrics = set(spec.metrics)
    if not metrics <= _ES_PUSHDOWN_METRICS:
        return None
    if any(field not in _ES_GROUP_FIELDS for field in spec.group_by):
        return None
    try:
        filters = normalise_case_filters(spec.filters or {})
    except ValueError:
        return None  # the fold raises the visible error
    if any(key not in _ES_FILTER_FIELDS for key in filters):
        return None

    clauses: list[dict[str, Any]] = []
    for key, values in filters.items():
        if key == "status_group":
            statuses = sorted({s for v in values for s in CASE_STATUS_GROUPS.get(v, ())})
            clauses.append({"terms": {"status": statuses}})
        else:
            clauses.append({"terms": {_ES_FILTER_FIELDS[key]: list(values)}})
    window = spec.window
    query = {"bool": {"filter": clauses + window_clauses(window)}}

    group_by = tuple(spec.group_by)
    want_open = "open_now" in metrics
    unit = spec.bucket
    sources: list[dict[str, Any]] = [
        {f"g{i}": {"terms": {"field": _ES_GROUP_FIELDS[name], "missing_bucket": True}}}
        for i, name in enumerate(group_by)
    ]
    if want_open:
        sources.append({"st": {"terms": {"field": "status", "missing_bucket": True}}})
    if unit:
        sources.append({"cr": {"date_histogram": {
            "field": "created_at", "calendar_interval": unit,
            "time_zone": window.tz, "missing_bucket": True,
        }}})

    active = set(CASE_STATUS_GROUPS["active"])
    terminal = set(CASE_STATUS_GROUPS["terminal"])

    def value(name: str, raw: Any) -> Any:
        if raw is None:
            return None
        text = str(raw)
        if name == "status_group":
            return "active" if text in active else "terminal" if text in terminal else None
        return text

    pit_id = str(await es.open_state_pit(CASES_READ_PATTERN, "2m") or "")
    if not pit_id:
        return None
    snap = _Snapshot(es, pit_id)
    try:
        state = RowSet()
        if sources:
            for bucket in await _es_composite(snap, query, sources):
                key = bucket.get("key") or {}
                count = int(bucket.get("doc_count", 0) or 0)
                gkey = tuple(value(name, key.get(f"g{i}")) for i, name in enumerate(group_by))
                if unit:
                    created = key.get("cr")
                    bkey: Any = (
                        MISSING_BUCKET if created is None
                        else datetime.fromtimestamp(float(created) / 1000.0, tz=timezone.utc)
                    )
                else:
                    bkey = None
                opened = count if want_open and str(key.get("st")) in active else 0
                state.acc(gkey, bkey).add_counts(count, opened)
        state.total = await _es_count(snap, query)
        state.totals.add_counts(state.total, 0)
        # Matching cases with no readable creation date: inside an all-time total,
        # disclosed beside a bounded one. A distinct count: summing the null-date
        # composite rows would count a case with two rules twice.
        state.missing = await _es_count(
            snap, {"bool": {"filter": clauses, "must_not": [_DATED]}}
        )
        state.earliest = await _es_edge_created(snap, query, "asc")
        state.latest = await _es_edge_created(snap, query, "desc")
        if want_open:
            open_query = {"bool": {"filter": clauses + [{"terms": {"status": sorted(active)}}]}}
            state.open_total = await _es_count(snap, open_query)
            if not unit and group_by:
                group_sources = [
                    {f"g{i}": {"terms": {"field": _ES_GROUP_FIELDS[name], "missing_bucket": True}}}
                    for i, name in enumerate(group_by)
                ]
                for bucket in await _es_composite(snap, open_query, group_sources):
                    key = bucket.get("key") or {}
                    gkey = tuple(value(name, key.get(f"g{i}")) for i, name in enumerate(group_by))
                    state.open_by_group[gkey] = (
                        state.open_by_group.get(gkey, 0) + int(bucket.get("doc_count", 0) or 0)
                    )
    finally:
        try:
            await es.close_state_pit(snap.pit_id)
        except Exception:  # noqa: BLE001 — a PIT also expires on its own
            pass
    state.scanned = state.total
    return build_case_result(
        spec, state, exact=True, consistency="point_in_time", method="pushdown",
        expected_total=state.total,
    )


def _first_case(resp: dict[str, Any]) -> Case | None:
    hits = resp.get("hits", {}).get("hits", [])
    if not hits:
        return None
    return Case.model_validate(hits[0]["_source"])
