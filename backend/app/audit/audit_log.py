"""The auditability backbone (Section 7.2 / Non-negotiable #2).

Every agent action is appended here, from the first commit. Writes are
best-effort and never raise into the caller: a failed audit write must not break
an investigation, but it is logged loudly. Audit is append-only — documents are
never updated or deleted.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import AUDIT_READ_PATTERN, AUDIT_WRITE_ALIAS, ActionType
from ..es.base import BaseESClient
from ..models import AuditDoc
from ..stores.base import AuditRepository
from ..utils import truncate

logger = logging.getLogger("tlsoc.audit")


class AuditLogger(AuditRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def write(self, doc: AuditDoc) -> None:
        try:
            await self._es.index_doc(AUDIT_WRITE_ALIAS, doc.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001
            logger.error("AUDIT WRITE FAILED (action=%s case=%s): %s",
                         doc.action_type, doc.case_id, exc)

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
                # Tool outputs are evidence a human reviews (e.g. a decoded ACL) — give
                # them more room than a one-line summary so the full detail survives for
                # the case UI. Still bounded so a pathological tool can't bloat the audit.
                tool_output_summary=truncate(tool_output_summary, 8000) if tool_output_summary else None,
                result_summary=truncate(result_summary, 1000) if result_summary else None,
            )
        )

    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """Read all audit rows for a case, OLDEST first (C3-3 trace timeline).

        Read-only on the management-scoped audit index. Never raises — returns an
        empty list on any error so the trace endpoint NEVER 404s/500s."""
        try:
            resp = await self._es.search(
                AUDIT_READ_PATTERN,
                {
                    "query": {"term": {"case_id": case_id}},
                    "sort": [{"ts": {"order": "asc"}}],
                    "size": limit,
                },
            )
            return [h.get("_source", {}) or {} for h in resp.get("hits", {}).get("hits", [])]
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
