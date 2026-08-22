"""Durable RAG corpus-health record — the trace a corpus collapse never left.

Twice in production the knowledge corpus was destroyed by a failed reprojection, and
both times the ONLY trace in the entire system was ``RAG seeded with N chunk(s)`` at
INFO — a line that reads identically whether N is 2,000 or 0. The per-source
before/after outcome the service already computes lives on ``RagService.last_projection``,
which is IN-PROCESS state: it is empty until the first projection of a process and it
dies on restart. A restart is exactly what an operator does when something looks wrong,
so the evidence was being erased by the first troubleshooting step.

This store persists that record. It is the same single-KV-document pattern as
:mod:`app.stores.noise_counters` — one JSON document under ``rag_health/rag_health``
through the existing :class:`KVStore` abstraction — so it needs **no new ES index, no
SQL table and no migration**. The ES backend stores it in the config index; the SQL
backend uses the shared KV table.

The document is::

    {"last_projection": {"<source>": {...}},        # per-source before/after outcome
     "last_projection_at": "<iso>",
     "last_refusal": {"reason": str, "collapsed": bool, "outgoing_total": int,
                      "at": "<iso>"} | None,
     "healthy_at": "<iso>"}                         # last projection that succeeded

Invariants: advisory observability ONLY. Nothing here is read by
``case_manager.decide()`` (#3) or by any scoring/signature path (#4), no chunk text,
case id, prompt, secret or provider response text is ever stored (#9), and every read
and write is fail-open — a store glitch must never be able to break seeding, which is
the very thing this record exists to protect.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import RAG_HEALTH_KEY, RAG_HEALTH_NS
from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.rag_health")

# Bound the persisted per-source map so a pathological source explosion cannot grow
# the config document without limit. Real deployments have a handful of sources.
_MAX_SOURCES = 64


def _clean_sources(raw: Any) -> dict[str, Any]:
    """Keep only JSON-safe scalar rows, bounded. Never raises."""
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    for name, row in sorted(raw.items())[:_MAX_SOURCES]:
        if not isinstance(row, dict):
            continue
        out[str(name)] = {
            key: value
            for key, value in row.items()
            if isinstance(value, (str, int, float, bool)) or value is None
        }
    return out


class RagHealthStore:
    """Fail-open persistence for the last RAG projection outcome and refusal."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def load(self) -> dict[str, Any]:
        try:
            doc = await self._kv.get(RAG_HEALTH_NS, RAG_HEALTH_KEY)
        except Exception as exc:  # noqa: BLE001 — observability never raises
            logger.warning("RAG health record could not be read: %s", exc)
            return {}
        return dict(doc or {})

    async def _save(self, doc: dict[str, Any]) -> None:
        try:
            await self._kv.put(RAG_HEALTH_NS, RAG_HEALTH_KEY, doc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG health record could not be written: %s", exc)

    async def record_projection(self, outcome: dict[str, Any]) -> None:
        """Persist a SUCCESSFUL projection outcome and clear any standing refusal."""
        doc = await self.load()
        at = iso_now()
        doc["last_projection"] = _clean_sources(outcome)
        doc["last_projection_at"] = at
        doc["healthy_at"] = at
        doc["last_refusal"] = None
        await self._save(doc)

    async def record_refusal(
        self, *, reason: str, collapsed: bool, outgoing_total: int
    ) -> None:
        """Persist a REFUSED/failed projection.

        ``collapsed`` distinguishes the corpus-destroying class (an empty or
        drastically shrunken rebuild that was refused) from an ordinary transient
        seeding failure, so a health surface can escalate only the former.
        ``reason`` is our own message text — never provider or document content.
        """
        doc = await self.load()
        doc["last_refusal"] = {
            "reason": str(reason)[:500],
            "collapsed": bool(collapsed),
            "outgoing_total": max(0, int(outgoing_total or 0)),
            "at": iso_now(),
        }
        await self._save(doc)
