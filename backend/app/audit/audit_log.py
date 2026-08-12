"""The auditability backbone (Section 7.2 / Non-negotiable #2).

Every agent action is appended here, from the first commit. Writes are
best-effort and never raise into the caller: a failed audit write must not break
an investigation, but it is logged loudly. Audit is append-only — documents are
never updated or deleted.
"""

from __future__ import annotations

import logging
from typing import Any

from ..build_identity import stamp_new_record
from ..constants import AUDIT_READ_PATTERN, AUDIT_WRITE_ALIAS, ActionType
from ..es.base import BaseESClient
from ..models import AuditDoc
from ..stores.base import AuditRepository
from ..stores.ledger_claims import append_keyed_ledger_row
from ..utils import truncate

logger = logging.getLogger("tlsoc.audit")


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
