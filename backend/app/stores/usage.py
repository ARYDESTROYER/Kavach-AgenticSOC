"""Token & cost ledger store (Section 7.3) + the in-plugin cost panel reader.

The ledger is WRITTEN in exactly one place — the LLM gateway — guaranteeing no
call escapes it (Non-negotiable #6). The window summary that feeds the cost panel
AND the BudgetGate is computed with a single ES ``sum`` aggregation so it is EXACT
regardless of row count: the old size-capped (10 000-doc) hit fetch silently
under-counted monthly / high-volume-daily spend, which defeated the budget
ceiling. On a backend whose ``search`` does not compute ``sum`` aggregations (the
in-memory test fake) the code transparently falls back to a *paginated* hit-scan
that has NO 10 000-row cap, so the two backends report identical totals.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from ..build_identity import stamp_new_record
from ..constants import CASE_PIPELINE_USAGE_ROLES, USAGE_READ_PATTERN, USAGE_WRITE_ALIAS
from ..es.base import BaseESClient
from ..models import UsageDoc
from ..utils import now_utc, parse_es_timestamp, to_millis
from .base import UsageRepository
from .cases import check_complete_response, window_clauses
from .ledger_claims import append_keyed_ledger_row

logger = logging.getLogger("tlsoc.usage")

# Page size for the fallback hit-scan (used only when the backend cannot compute
# the ``sum`` aggregation — i.e. the in-memory test fake). It must stay <= the ES
# ``max_result_window`` (10 000) so a real cluster taking this path (it never does
# — real ES always returns the aggregation) would still page legally.
_SCAN_PAGE = 10000

# Only these values are emitted by the bundled gateway today. Anything else (or
# a legacy row with no field) is deliberately reported as ``unconfirmed`` rather
# than guessed from provider/model/policy. In particular, a standard row does not
# prove whether Flex was never requested or requested and fell back.
_CONFIRMED_PROCESSING_TIERS = ("standard", "flex", "batch")
_UNCONFIRMED_PROCESSING_TIER = "unconfirmed"
_PROCESSING_TIER_ORDER = (*_CONFIRMED_PROCESSING_TIERS, _UNCONFIRMED_PROCESSING_TIER)


class UsageStore(UsageRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def write(self, doc: UsageDoc) -> None:
        try:
            await self.write_strict(doc)
        except Exception as exc:  # noqa: BLE001
            logger.error("USAGE WRITE FAILED (role=%s model=%s): %s", doc.role, doc.model, exc)

    async def write_strict(self, doc: UsageDoc) -> None:
        """Persist one authoritative ledger row or raise.

        A Batch fold supplies ``idempotency_key``; using it as the owned document id
        lets a retry confirm and retain the first logical ledger row rather than append
        another bill or replace its original build provenance. Ordinary live calls keep
        their generated document ids.
        """
        stamped = stamp_new_record(doc)
        if stamped.idempotency_key:
            await append_keyed_ledger_row(
                self._es,
                scope="usage",
                logical_id=stamped.idempotency_key,
                payload=stamped.model_dump(mode="json"),
                write_alias=USAGE_WRITE_ALIAS,
                read_pattern=USAGE_READ_PATTERN,
                reject_conflicting_retry=False,
            )
            return
        await self._es.index_doc(
            USAGE_WRITE_ALIAS,
            stamped.model_dump(mode="json"),
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
        resp = await self._es.search(
            USAGE_READ_PATTERN,
            {
                "size": cap,
                "query": {"match_all": {}},
                "sort": [{"ts": {"order": "desc"}}],
            },
        )
        return [h.get("_source", {}) or {} for h in resp.get("hits", {}).get("hits", [])]

    async def export_page(
        self, *, limit: int = 1000, cursor: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """PIT + ``_shard_doc`` page for an exact append-only ledger snapshot."""
        cap = max(1, min(int(limit or 1000), 5000))
        pit_id = str(cursor.get("pit", "")) if isinstance(cursor, dict) else ""
        after = cursor.get("after") if isinstance(cursor, dict) else None
        seen = max(0, int(cursor.get("seen", 0) or 0)) if isinstance(cursor, dict) else 0
        opened_here = False
        if not pit_id:
            pit_id = str(await self._es.open_state_pit(USAGE_READ_PATTERN, "10m") or "")
            opened_here = bool(pit_id)
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
        try:
            resp = await self._es.search(USAGE_READ_PATTERN, body)
            # A failed shard or a timed-out search is partial: never an exact page.
            check_complete_response(resp)
        except BaseException:
            # A snapshot THIS call opened is released before the error leaves it (the
            # cluster caps open PITs; a failing first page must not strand one per call).
            if opened_here and pit_id:
                try:
                    await self._es.close_state_pit(pit_id)
                except Exception:  # noqa: BLE001 — a PIT also expires on its own
                    pass
            raise
        if pit_id:
            pit_id = str(resp.get("pit_id") or pit_id)
        raw_hits = resp.get("hits", {}).get("hits", [])
        rows = [hit.get("_source", {}) or {} for hit in raw_hits]
        total_raw = resp.get("hits", {}).get("total", {})
        total = int(total_raw.get("value", len(rows))) if isinstance(total_raw, dict) else int(total_raw)
        if not pit_id:
            return rows, None, None, "unverified"
        marker = raw_hits[-1].get("sort") if raw_hits else after
        return rows, {"pit": pit_id, "after": marker, "seen": seen + len(rows)}, total, "point_in_time"

    async def close_export_cursor(self, cursor: Any) -> None:
        if isinstance(cursor, dict) and cursor.get("pit"):
            await self._es.close_state_pit(str(cursor["pit"]))

    async def scan_page(
        self,
        *,
        limit: int = 1000,
        cursor: Any = None,
        ts_from: Any = None,
        ts_to: Any = None,
    ) -> tuple[list[dict[str, Any]], Any | None, int | None, str]:
        """PIT + ``_shard_doc`` ledger page pre-filtered to ``[ts_from, ts_to)`` on ``ts``
        (the never-drop complement: a row whose ``ts`` cannot be placed is kept). A
        35-day report reads 35 days of the ledger, not its whole history.
        ``next_cursor`` is ``None`` once exhausted (the snapshot is then released); a
        partial response raises; a snapshot this call opened is closed on any error."""
        cap = max(1, min(int(limit or 1000), 5000))
        state = dict(cursor) if isinstance(cursor, dict) else {}
        pit_id = str(state.get("pit") or "")
        opened_here = False
        if not pit_id:
            pit_id = str(await self._es.open_state_pit(USAGE_READ_PATTERN, "10m") or "")
            opened_here = bool(pit_id)
        if not pit_id:
            # Without a snapshot the ledger cannot be paged consistently: one honest
            # unverified page (callers never present it as exact).
            rows, _nxt, _total, _consistency = await self.export_page(limit=cap)
            return rows, None, None, "unverified"
        try:
            from ..engine.case_aggregate import iso_bound

            outside: list[dict[str, Any]] = []
            lo, hi = iso_bound(ts_from), iso_bound(ts_to)
            if lo is not None:
                outside.append({"range": {"ts": {"lt": lo}}})
            if hi is not None:
                outside.append({"range": {"ts": {"gte": hi}}})
            query: dict[str, Any] = (
                {"bool": {"filter": [{"bool": {"must_not": outside}}]}} if outside
                else {"match_all": {}}
            )
            body: dict[str, Any] = {
                "size": cap, "track_total_hits": True, "query": query,
                "sort": ["_shard_doc"], "pit": {"id": pit_id, "keep_alive": "10m"},
            }
            after = state.get("after")
            if isinstance(after, list) and after:
                body["search_after"] = after
            resp = await self._es.search(USAGE_READ_PATTERN, body)
            check_complete_response(resp)
        except BaseException:
            if opened_here:
                try:
                    await self._es.close_state_pit(pit_id)
                except Exception:  # noqa: BLE001
                    pass
            raise
        pit_id = str(resp.get("pit_id") or pit_id)
        raw_hits = resp.get("hits", {}).get("hits", [])
        rows = [hit.get("_source", {}) or {} for hit in raw_hits]
        total_raw = resp.get("hits", {}).get("total", {})
        total = int(total_raw.get("value", len(rows))) if isinstance(total_raw, dict) else int(total_raw)
        if len(raw_hits) < cap:
            try:
                await self._es.close_state_pit(pit_id)
            except Exception:  # noqa: BLE001
                pass
            return rows, None, total, "point_in_time"
        return rows, {"pit": pit_id, "after": raw_hits[-1].get("sort")}, total, "point_in_time"

    async def close_scan_cursor(self, cursor: Any) -> None:
        await self.close_export_cursor(cursor)

    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        now = now_utc()
        from_millis = to_millis(now) - window_hours * 3600 * 1000
        today_start_millis = to_millis(now.replace(hour=0, minute=0, second=0, microsecond=0))

        filters: list[dict[str, Any]] = [
            {"range": {"ts": {"gte": from_millis, "format": "epoch_millis"}}}
        ]
        if case_id:
            filters.append({"term": {"case_id": case_id}})
        query = {"bool": {"filter": filters}}

        # Pass 1 — the exact, unbounded aggregation. ``size:0`` + ``sum`` aggs mean
        # the total is computed over EVERY matching row (no 10 000-doc truncation),
        # so a 30-day / high-volume window can no longer silently under-count spend
        # and defeat the BudgetGate. ``track_total_hits`` gives the exact call count.
        body = {
            "size": 0,
            "track_total_hits": True,
            "query": query,
            "aggs": {
                "total_cost": {"sum": {"field": "cost"}},
                "total_tokens": {"sum": {"field": "total_tokens"}},
                "today_cost": {
                    "filter": {"range": {"ts": {"gte": today_start_millis,
                                                "format": "epoch_millis"}}},
                    "aggs": {"cost": {"sum": {"field": "cost"}},
                             # Round 12 (D5): today's exact per-surface spend for the
                             # budget gate's chat exclusion and the chat daily cap.
                             "by_surface": _terms_agg("surface")},
                },
                "by_surface": _terms_agg("surface"),
                "by_model": _terms_agg("model"),
                "by_role": _terms_agg("role"),
                # Exact filters rather than a top-N terms aggregation: the Cost
                # surface must account for every matching ledger row when it
                # reports effective standard/Flex/Batch coverage.
                "by_processing_tier": _processing_tier_agg(),
                "cost_over_time": {
                    "date_histogram": {"field": "ts", "calendar_interval": "hour"},
                    "aggs": {"cost": {"sum": {"field": "cost"}}},
                },
            },
        }
        try:
            resp = await self._es.search(USAGE_READ_PATTERN, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary search failed: %s", exc)
            return _empty_summary(window_hours)

        aggs = resp.get("aggregations") or {}
        if _has_sum_aggs(aggs):
            return _summary_from_aggs(window_hours, resp, aggs)

        # Pass 2 — fallback for a backend whose ``search`` does not compute ``sum``
        # aggregations (the in-memory test fake). Page through EVERY matching row
        # (no 10 000-doc cap) and sum in Python — identical numbers, just slower.
        try:
            sources = await self._scan_all(query)
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary scan failed: %s", exc)
            return _empty_summary(window_hours)
        return _summary_from_sources(window_hours, sources, today_start_millis)

    async def total_pipeline_cost_for_case(self, case_id: str) -> float | None:
        """Return exact all-time pipeline spend for ``case_id``.

        This deliberately has no time window: ``Case.token_cost`` is cumulative for
        the lifetime of the case, but only router/investigator/formatter calls belong
        to that historical field. Case-scoped Chat and overview rows stay in the global
        ledger and are deliberately excluded here. Real Elasticsearch uses an
        unbounded sum aggregation; the in-memory fallback scans every matching row. A
        read failure returns ``None`` so the pipeline keeps its monotonic fail-soft total.
        """
        query = {
            "bool": {
                "filter": [
                    {"term": {"case_id": case_id}},
                    {"terms": {"role": list(CASE_PIPELINE_USAGE_ROLES)}},
                ]
            }
        }
        try:
            response = await self._es.search(
                USAGE_READ_PATTERN,
                {
                    "size": 0,
                    "track_total_hits": True,
                    "query": query,
                    "aggs": {"total_cost": {"sum": {"field": "cost"}}},
                },
            )
            aggregations = response.get("aggregations") or {}
            if _has_sum_aggs(aggregations):
                value = float(
                    (aggregations.get("total_cost") or {}).get("value", 0.0) or 0.0
                )
                return round(value, 6)
            sources = await self._scan_all(query)
            return round(
                sum(float(source.get("cost", 0.0) or 0.0) for source in sources),
                6,
            )
        except Exception as exc:  # noqa: BLE001 — accounting remains fail-soft
            logger.warning("case usage reconciliation failed for %s: %s", case_id, exc)
            return None

    async def aggregate_usage(self, spec: Any) -> Any | None:
        """Composite + ``sum`` push-down for :func:`engine.case_aggregate.aggregate_usage`.

        Groups by the mapped keywords ``role``/``model``/``surface``/``processing_tier``
        (``provider`` = group by model, folded with ``llm.pricing.provider_for``;
        ``service_tier`` folds a missing/unknown tier into ``unconfirmed`` exactly like
        the cost surface) and buckets ``ts`` with a ``calendar_interval`` date histogram
        in ``spec.window.tz``. Returns ``None`` — and the engine folds over
        :meth:`scan_page` — when the backend did not compute the ``sum`` metrics (the
        in-memory fake never does), for a ``provider``/``service_tier`` filter, or when
        the client has no point-in-time support. Every search runs inside ONE state PIT
        (totals equal the sum of their groups while calls are being recorded); a failed
        shard or a timed-out search raises and the engine folds. A bounded window is a
        positive ``ts`` range: an undatable row is disclosed, not counted."""
        return await _es_usage_pushdown(self._es, spec)

    async def _scan_all(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        """Page through every ``_source`` matching ``query`` with no row cap, ordered
        by ``ts`` asc. Only taken on the aggregation-less fallback backend."""
        sources: list[dict[str, Any]] = []
        frm = 0
        while True:
            page = await self._es.search(
                USAGE_READ_PATTERN,
                {"size": _SCAN_PAGE, "from": frm, "query": query,
                 "sort": [{"ts": {"order": "asc"}}]},
            )
            hits = page.get("hits", {}).get("hits", [])
            if not hits:
                break
            sources.extend(h.get("_source", {}) for h in hits)
            if len(hits) < _SCAN_PAGE:
                break
            frm += _SCAN_PAGE
        return sources


_ES_USAGE_GROUPS = {
    "role": "role",
    "model": "model",
    "surface": "surface",
    "provider": "model",
    "service_tier": "processing_tier",
}
_ES_USAGE_FILTERS = {"role": "role", "model": "model", "surface": "surface",
                     "case_id": "case_id"}
_USAGE_SUMS = {
    "cost": "cost",
    "total_tokens": "total_tokens",
    "input_tokens": "prompt_tokens",
    "output_tokens": "completion_tokens",
}
_USAGE_COMPOSITE_PAGE = 1000
_DATED_TS = {"range": {"ts": {"gte": "0001-01-01T00:00:00+00:00"}}}


def _usage_group_value(name: str, raw: Any) -> Any:
    """A composite key value → the fold's group value for usage field ``name``."""
    from ..engine.case_aggregate import usage_values

    field = "processing_tier" if name == "service_tier" else _ES_USAGE_GROUPS[name]
    return usage_values({field: raw}, name)


def _sum_value(bucket: dict[str, Any], name: str) -> float | None:
    node = bucket.get(name)
    if not isinstance(node, dict) or "value" not in node:
        return None
    try:
        return float(node.get("value") or 0.0)
    except (TypeError, ValueError):
        return None


async def _es_usage_pushdown(es: BaseESClient, spec: Any) -> Any | None:
    """See :meth:`UsageStore.aggregate_usage`. Every search runs inside ONE state PIT
    (closed afterwards); a partial response raises (the engine folds)."""
    from datetime import datetime, timezone

    from ..engine.case_aggregate import (
        MISSING_USAGE_BUCKET,
        UsageRowSet,
        build_usage_result,
    )

    group_by = tuple(spec.group_by)
    if any(name not in _ES_USAGE_GROUPS for name in group_by):
        return None
    clauses: list[dict[str, Any]] = []
    for key, raw in (spec.filters or {}).items():
        if key not in _ES_USAGE_FILTERS:
            return None
        values = raw if isinstance(raw, (list, tuple, set)) else [raw]
        wanted = sorted({str(v).strip() for v in values if v is not None and str(v).strip()})
        if wanted:
            clauses.append({"terms": {_ES_USAGE_FILTERS[key]: wanted}})
    window = spec.window
    # A bounded window is a positive ``ts`` range: an undatable row is disclosed in
    # ``missing_created`` (counted below without the window), not counted.
    query = {"bool": {"filter": clauses + window_clauses(window, "ts")}}
    sources: list[dict[str, Any]] = [
        {f"g{i}": {"terms": {"field": _ES_USAGE_GROUPS[name], "missing_bucket": True}}}
        for i, name in enumerate(group_by)
    ]
    unit = spec.bucket
    if unit:
        sources.append({"cr": {"date_histogram": {
            "field": "ts", "calendar_interval": unit, "time_zone": window.tz,
            "missing_bucket": True,
        }}})
    sum_aggs = {name: {"sum": {"field": field}} for name, field in _USAGE_SUMS.items()}
    state = UsageRowSet()

    def record(bucket: dict[str, Any], gkey: tuple[Any, ...], bkey: Any) -> bool:
        sums = {name: _sum_value(bucket, name) for name in _USAGE_SUMS}
        if any(value is None for value in sums.values()):
            return False  # metric aggregations unsupported here: fold instead
        values = (int(bucket.get("doc_count", 0) or 0), int(sums["input_tokens"] or 0),
                  int(sums["output_tokens"] or 0), int(sums["total_tokens"] or 0),
                  float(sums["cost"] or 0.0))
        if values[0]:
            state.acc(gkey, bkey).add_sums(*values)
            state.totals.add_sums(*values)
        return True

    pit_id = str(await es.open_state_pit(USAGE_READ_PATTERN, "2m") or "")
    if not pit_id:
        return None

    async def search(body: dict[str, Any]) -> dict[str, Any]:
        nonlocal pit_id
        resp = await es.search(
            USAGE_READ_PATTERN, {**body, "pit": {"id": pit_id, "keep_alive": "2m"}},
        )
        check_complete_response(resp)
        pit_id = str(resp.get("pit_id") or pit_id)
        return resp

    try:
        if not sources:
            resp = await search({
                "size": 0, "track_total_hits": True, "query": query, "aggs": sum_aggs,
            })
            aggs = dict(resp.get("aggregations") or {})
            total = (resp.get("hits") or {}).get("total") or {}
            aggs["doc_count"] = int(total.get("value", 0) if isinstance(total, dict) else total or 0)
            if not record(aggs, (), None):
                return None
        after: dict[str, Any] | None = None
        while sources:
            composite: dict[str, Any] = {"size": _USAGE_COMPOSITE_PAGE, "sources": sources}
            if after:
                composite["after"] = after
            resp = await search({
                "size": 0, "query": query,
                "aggs": {"g": {"composite": composite, "aggs": sum_aggs}},
            })
            agg = (resp.get("aggregations") or {}).get("g")
            if not isinstance(agg, dict) or not isinstance(agg.get("buckets"), list):
                return None
            buckets = agg["buckets"]
            for bucket in buckets:
                key = bucket.get("key") or {}
                gkey = tuple(
                    _usage_group_value(name, key.get(f"g{i}")) for i, name in enumerate(group_by)
                )
                bkey: Any = None
                if unit:
                    created = key.get("cr")
                    bkey = (
                        MISSING_USAGE_BUCKET if created is None
                        else datetime.fromtimestamp(float(created) / 1000.0, tz=timezone.utc)
                    )
                if not record(bucket, gkey, bkey):
                    return None
            after = agg.get("after_key")
            if not buckets or not after or len(buckets) < _USAGE_COMPOSITE_PAGE:
                break
        missing = await search({
            "size": 0, "track_total_hits": True,
            "query": {"bool": {"filter": clauses, "must_not": [_DATED_TS]}},
        })
        total = (missing.get("hits") or {}).get("total") or {}
        state.missing = int(total.get("value", 0) if isinstance(total, dict) else total or 0)
        for order in ("asc", "desc"):
            edge = await search({
                "size": 1, "query": {"bool": {"filter": [*clauses, *window_clauses(window, "ts"),
                                                         _DATED_TS]}},
                "sort": [{"ts": {"order": order}}], "_source": ["ts"],
            })
            hits = (edge.get("hits") or {}).get("hits") or []
            stamp = parse_es_timestamp((hits[0].get("_source") or {}).get("ts")) if hits else None
            if stamp is not None:
                state.note_ts(stamp)
    finally:
        try:
            await es.close_state_pit(pit_id)
        except Exception:  # noqa: BLE001 — a PIT also expires on its own
            pass
    state.scanned = state.totals.calls
    return build_usage_result(
        spec, state, exact=True, consistency="point_in_time", method="pushdown",
        expected_total=state.totals.calls,
    )


def _terms_agg(field: str) -> dict[str, Any]:
    """A terms bucket over ``field`` with per-bucket cost + token sums. ``size`` is
    generous so the top-N slice in ``_top()`` (10/5) is computed from a complete set
    of high-cost buckets, not a truncated one."""
    return {
        "terms": {"field": field, "size": 1000, "missing": "unknown"},
        "aggs": {
            "cost": {"sum": {"field": "cost"}},
            "tokens": {"sum": {"field": "total_tokens"}},
        },
    }


def _processing_tier_agg() -> dict[str, Any]:
    """Exact fixed-bucket aggregation for actual recorded execution tiers.

    Missing and future/unknown tier values are grouped into ``unconfirmed``. We
    intentionally do not derive a tier from model/provider or requested policy.
    """
    return {
        "filters": {
            "filters": {
                tier: {"term": {"processing_tier": tier}}
                for tier in _CONFIRMED_PROCESSING_TIERS
            }
            | {
                _UNCONFIRMED_PROCESSING_TIER: {
                    "bool": {
                        "must_not": [
                            {"terms": {"processing_tier": list(_CONFIRMED_PROCESSING_TIERS)}}
                        ]
                    }
                }
            }
        },
        "aggs": {
            "cost": {"sum": {"field": "cost"}},
            "tokens": {"sum": {"field": "total_tokens"}},
        },
    }


def _has_sum_aggs(aggs: dict[str, Any]) -> bool:
    """True when the backend actually computed the ``sum`` aggregations (real ES).
    The in-memory fake returns no aggregations for ``sum``/nested aggs, so this is
    False there and the caller takes the paginated-scan fallback."""
    total = aggs.get("total_cost")
    return isinstance(total, dict) and "value" in total


def _summary_from_aggs(window_hours: int, resp: dict[str, Any],
                       aggs: dict[str, Any]) -> dict[str, Any]:
    """Build the panel summary from the exact ES aggregation result (no row cap)."""
    total_cost = float((aggs.get("total_cost") or {}).get("value", 0.0) or 0.0)
    total_tokens = int((aggs.get("total_tokens") or {}).get("value", 0) or 0)
    today_cost = float(((aggs.get("today_cost") or {}).get("cost") or {}).get("value", 0.0) or 0.0)
    call_count = int(resp.get("hits", {}).get("total", {}).get("value", 0) or 0)

    over_time = [
        {"ts": int(b.get("key", 0)), "cost": round(float((b.get("cost") or {}).get("value", 0.0) or 0.0), 6)}
        for b in (aggs.get("cost_over_time") or {}).get("buckets", [])
    ]
    return {
        "window_hours": window_hours,
        "total_cost": round(total_cost, 6),
        "total_tokens": total_tokens,
        "today_cost": round(today_cost, 6),
        "call_count": call_count,
        "currency": "USD",
        "by_surface": _top_from_buckets(aggs.get("by_surface")),
        "by_model": _top_from_buckets(aggs.get("by_model")),
        "by_role": _top_from_buckets(aggs.get("by_role")),
        "today_by_surface": _top_from_buckets(
            (aggs.get("today_cost") or {}).get("by_surface"), limit=1000),
        **_processing_tier_summary_from_agg(
            aggs.get("by_processing_tier"),
            total_cost=total_cost,
            total_tokens=total_tokens,
            call_count=call_count,
        ),
        "cost_over_time": over_time,
        "top_cost_drivers": _top_from_buckets(aggs.get("by_model"), limit=5),
    }


def _top_from_buckets(agg: Any, limit: int = 10) -> list[dict[str, Any]]:
    buckets = (agg or {}).get("buckets", []) if isinstance(agg, dict) else []
    rows = [
        {
            "key": str(b.get("key", "unknown")),
            "cost": round(float((b.get("cost") or {}).get("value", 0.0) or 0.0), 6),
            "tokens": int((b.get("tokens") or {}).get("value", 0) or 0),
            "calls": int(b.get("doc_count", 0) or 0),
        }
        for b in buckets
    ]
    rows.sort(key=lambda r: r["cost"], reverse=True)
    return rows[:limit]


def _processing_tier_key(value: Any) -> str:
    """Return a confirmed actual tier or the explicit unconfirmed bucket."""
    tier = str(value or "").strip().lower()
    return tier if tier in _CONFIRMED_PROCESSING_TIERS else _UNCONFIRMED_PROCESSING_TIER


def _new_processing_tier_bucket() -> dict[str, dict[str, float]]:
    return {
        tier: {"cost": 0.0, "tokens": 0.0, "calls": 0.0}
        for tier in _PROCESSING_TIER_ORDER
    }


def _processing_tier_summary_from_agg(
    agg: Any,
    *,
    total_cost: float,
    total_tokens: int,
    call_count: int,
) -> dict[str, Any]:
    bucket = _new_processing_tier_bucket()
    buckets = (agg or {}).get("buckets", {}) if isinstance(agg, dict) else {}
    if isinstance(buckets, dict):
        for tier in _PROCESSING_TIER_ORDER:
            src = buckets.get(tier) or {}
            bucket[tier]["cost"] = float((src.get("cost") or {}).get("value", 0.0) or 0.0)
            bucket[tier]["tokens"] = float((src.get("tokens") or {}).get("value", 0) or 0)
            bucket[tier]["calls"] = float(src.get("doc_count", 0) or 0)
    # A partial/older ES adapter may compute the global sums but omit the new nested
    # filters aggregation. Keep totals truthful by assigning any unattributed
    # remainder to ``unconfirmed`` rather than silently reporting zero-tier calls.
    attributed_cost = sum(values["cost"] for values in bucket.values())
    attributed_tokens = sum(values["tokens"] for values in bucket.values())
    attributed_calls = sum(values["calls"] for values in bucket.values())
    unknown = bucket[_UNCONFIRMED_PROCESSING_TIER]
    unknown["cost"] += max(0.0, total_cost - attributed_cost)
    unknown["tokens"] += max(0.0, float(total_tokens) - attributed_tokens)
    unknown["calls"] += max(0.0, float(call_count) - attributed_calls)
    return _processing_tier_summary(bucket)


def _processing_tier_summary(
    bucket: dict[str, dict[str, float]],
) -> dict[str, Any]:
    """Build the additive execution-tier and coverage contract.

    Coverage denominators include unconfirmed rows, so historical/unknown data can
    never silently inflate the reported discounted share. The current UsageDoc has
    no requested-tier/fallback marker, therefore fallback counts remain ``None`` and
    the API says attribution is unavailable instead of inferring it from a standard
    result.
    """
    rows = [
        {
            "key": tier,
            "cost": round(float(bucket.get(tier, {}).get("cost", 0.0) or 0.0), 6),
            "tokens": int(bucket.get(tier, {}).get("tokens", 0) or 0),
            "calls": int(bucket.get(tier, {}).get("calls", 0) or 0),
        }
        for tier in _PROCESSING_TIER_ORDER
    ]
    by_key = {row["key"]: row for row in rows}
    discounted = [by_key["flex"], by_key["batch"]]
    discounted_calls = sum(row["calls"] for row in discounted)
    discounted_tokens = sum(row["tokens"] for row in discounted)
    discounted_cost = round(sum(row["cost"] for row in discounted), 6)
    total_calls = sum(row["calls"] for row in rows)
    total_tokens = sum(row["tokens"] for row in rows)
    total_cost = round(sum(row["cost"] for row in rows), 6)
    unconfirmed_calls = by_key[_UNCONFIRMED_PROCESSING_TIER]["calls"]

    return {
        "by_processing_tier": rows,
        "discounted_tier_coverage": {
            "calls": discounted_calls,
            "tokens": discounted_tokens,
            "cost": discounted_cost,
            "call_ratio": round(discounted_calls / total_calls, 6) if total_calls else 0.0,
            "token_ratio": round(discounted_tokens / total_tokens, 6) if total_tokens else 0.0,
            "cost_ratio": round(discounted_cost / total_cost, 6) if total_cost else 0.0,
        },
        "processing_tier_attribution": {
            "confirmed_calls": total_calls - unconfirmed_calls,
            "unconfirmed_calls": unconfirmed_calls,
            "fallback_calls": None,
            "fallback_attribution_available": False,
            "requested_policy_inferred": False,
        },
    }


def _summary_from_sources(window_hours: int, sources: list[dict[str, Any]],
                          today_start_millis: int) -> dict[str, Any]:
    """Sum every scanned ``_source`` in Python (aggregation-less fallback backend).
    Byte-equivalent to the old hit loop, just without the 10 000-doc truncation."""
    total_cost = 0.0
    total_tokens = 0
    today_cost = 0.0
    by_surface: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    by_model: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    by_role: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    today_by_surface: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    by_processing_tier = _new_processing_tier_bucket()
    over_time: dict[int, float] = defaultdict(float)

    for src in sources:
        cost = float(src.get("cost", 0.0) or 0.0)
        tokens = int(src.get("total_tokens", 0) or 0)
        total_cost += cost
        total_tokens += tokens
        ts = parse_es_timestamp(src.get("ts"))
        ts_millis = to_millis(ts) if ts else 0
        if ts_millis >= today_start_millis:
            today_cost += cost
            today = today_by_surface[src.get("surface", "unknown")]
            today["cost"] += cost
            today["tokens"] += tokens
            today["calls"] += 1
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
        "call_count": len(sources),
        "currency": "USD",
        "by_surface": _top(by_surface),
        "by_model": _top(by_model),
        "by_role": _top(by_role),
        "today_by_surface": _top(today_by_surface, limit=1000),
        **_processing_tier_summary(by_processing_tier),
        "cost_over_time": [
            {"ts": k, "cost": round(v, 6)} for k, v in sorted(over_time.items())
        ],
        "top_cost_drivers": _top(by_model, limit=5),
    }


def _top(bucket: dict[str, dict[str, float]], limit: int = 10) -> list[dict[str, Any]]:
    rows = [
        {"key": k, "cost": round(v["cost"], 6), "tokens": int(v["tokens"]), "calls": int(v["calls"])}
        for k, v in bucket.items()
    ]
    rows.sort(key=lambda r: r["cost"], reverse=True)
    return rows[:limit]


def _empty_summary(window_hours: int) -> dict[str, Any]:
    return {
        "window_hours": window_hours,
        "total_cost": 0.0,
        "total_tokens": 0,
        "today_cost": 0.0,
        "call_count": 0,
        "currency": "USD",
        "by_surface": [],
        "by_model": [],
        "by_role": [],
        "today_by_surface": [],
        **_processing_tier_summary(_new_processing_tier_bucket()),
        "cost_over_time": [],
        "top_cost_drivers": [],
    }
