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
     "healthy_at": "<iso>",                         # last projection that succeeded
     "composition": [{"at": "<iso>", "rows": int,
                      "shares": {"<cell>": float}}]}  # bounded observation history

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

# --------------------------------------------------------------------------- #
# Composition observation history — the BASELINE a shift is measured against.
# --------------------------------------------------------------------------- #
# A corpus's class SHARES cannot be judged from one reading. "198 false_positive / 2
# true_positive" is not evidence of anything on its own; the same corpus at 60/40 a
# week ago and 99/1 today is. So a bounded series of observations is kept here, in the
# same single advisory document, and only when the shares actually MOVED — a repeated
# identical reading appends nothing, so a health surface that is polled every few
# seconds writes at most once per real change.
#
# Deliberately tiny: shares only, rounded, keyed by an opaque cell label. No chunk
# text, no case id, no rule name, no analyst identity (#9) — the series is a shape,
# not a corpus extract.
_MAX_COMPOSITION_OBSERVATIONS = 8
_MAX_COMPOSITION_CELLS = 40
#: Shares are rounded to this many decimals before comparison, so floating-point
#: noise on an unchanged corpus cannot masquerade as a movement.
_SHARE_PRECISION = 4


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

    async def observe_composition(
        self, shares: dict[str, float], *, rows: int
    ) -> dict[str, Any]:
        """Record a corpus-composition reading and return the BASELINE it is judged
        against.

        Returns ``{"previous": {...} | None, "recorded": bool, "observations": int}``.
        ``previous`` is the OLDEST reading still on file — never the newest — and is
        ``None`` on a deployment that has never been observed, which is a real "not
        measurable yet", never a zero.

        WHY THE OLDEST. Observation and alerting share this one call: the only caller
        is an operator-facing health READ. Comparing against the newest reading made
        the alarm one-shot — the poisoned reading became its own baseline, so the very
        first read after a poisoning consumed the finding for everybody and every later
        read reported a zero delta on a still-poisoned corpus. Comparing against the
        oldest retained reading keeps a real move visible for the width of the bounded
        series instead. It cannot accumulate into a false alarm from slow drift either:
        an append happens on every real change, so an actively changing corpus rolls
        the oldest entry forward and the comparison stays local; a corpus that stops
        changing appends nothing, which is exactly when the finding must persist.

        The write is conditional (an identical reading appends nothing), bounded, and
        routed through the KV compare-and-set helper where the backend offers one so
        two concurrent readers cannot drop each other's observation. Fail-open in every
        direction: a store outage returns ``previous: None`` rather than raising, and a
        health surface then reports the shift as unmeasured instead of breaking.
        """
        rounded = {
            str(key)[:120]: round(float(value), _SHARE_PRECISION)
            for key, value in sorted(shares.items())[:_MAX_COMPOSITION_CELLS]
        }
        entry = {"at": iso_now(), "rows": max(0, int(rows or 0)), "shares": rounded}
        previous: dict[str, Any] | None = None
        recorded = False
        observations = 0

        def _mutate(current: dict[str, Any] | None) -> dict[str, Any]:
            nonlocal previous, recorded, observations
            doc = dict(current or {})
            history = [
                row for row in (doc.get("composition") or []) if isinstance(row, dict)
            ]
            # The BASELINE is the oldest retained reading; the newest is only used to
            # decide whether this reading is a change worth appending.
            oldest = history[0] if history else None
            previous = dict(oldest) if isinstance(oldest, dict) else None
            newest = history[-1] if history else None
            if newest is not None and dict(newest.get("shares") or {}) == rounded:
                # Unchanged: append nothing, so a health surface polled every few
                # seconds cannot roll a real finding out of the bounded series just by
                # being read. The baseline handed back is the same oldest reading.
                recorded = False
                observations = len(history)
                return doc
            history.append(entry)
            doc["composition"] = history[-_MAX_COMPOSITION_OBSERVATIONS:]
            recorded = True
            observations = len(doc["composition"])
            return doc

        mutate = getattr(self._kv, "mutate", None)
        try:
            if mutate is not None:
                await mutate(RAG_HEALTH_NS, RAG_HEALTH_KEY, _mutate)
            else:
                # A KV backend (or offline fake) without the CAS helper: the
                # read-modify-write is still conditional, just not lost-update safe.
                doc = _mutate(await self.load())
                if recorded:
                    await self._save(doc)
        except Exception as exc:  # noqa: BLE001 — observability never raises
            logger.warning("RAG composition observation failed: %s", exc)
            return {"previous": None, "recorded": False, "observations": 0}
        return {
            "previous": previous,
            "recorded": recorded,
            "observations": int(observations),
        }
