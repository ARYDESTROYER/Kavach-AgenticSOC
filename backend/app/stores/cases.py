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
        if not pit_id:
            pit_id = str(await self._es.open_state_pit(CASES_READ_PATTERN, "10m") or "")
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
        resp = await self._es.search(CASES_READ_PATTERN, body)
        if pit_id:
            pit_id = str(resp.get("pit_id") or pit_id)
        raw_hits = resp.get("hits", {}).get("hits", [])
        rows = [Case.model_validate(hit.get("_source", {})) for hit in raw_hits]
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


def _first_case(resp: dict[str, Any]) -> Case | None:
    hits = resp.get("hits", {}).get("hits", [])
    if not hits:
        return None
    return Case.model_validate(hits[0]["_source"])
