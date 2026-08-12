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
from .base import CaseRepository

logger = logging.getLogger("tlsoc.cases")

# Any NON-terminal lifecycle status counts as "open" for the signature idempotency
# lookup (#4) — including the F8 statuses (NEW/INVESTIGATING/ESCALATED/ON_HOLD), so
# an escalated/held case still attaches its new events instead of duplicating.
_OPEN_STATUSES = list(OPEN_CASE_STATUSES)


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
            "sort": [{sort_field: {"order": sort_order}}],
        }
        resp = await self._es.search(CASES_READ_PATTERN, body)
        cases = [Case.model_validate(h["_source"]) for h in resp.get("hits", {}).get("hits", [])]
        total = int(resp.get("hits", {}).get("total", {}).get("value", len(cases)))
        return cases, total

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
