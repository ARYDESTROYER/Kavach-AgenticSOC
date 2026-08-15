"""Anomaly-BASELINE sketch store — persists the streaming statistics (Round 4 Wave 3).

The baseline engine (:mod:`app.engine.baseline`) keeps a compact per-(cluster
signature, hour-of-week bucket) sketch (Welford ``M/S/n`` + two EWMAs + a t-digest).
This store persists ONLY that small sketch state so each EVENTS batch updates the
baseline INCREMENTALLY — never a full-history rescan — and so a restart resumes the
warmed baseline instead of cold-starting.

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory` / :mod:`app.stores.shift_handoff`): the WHOLE set of series
is ONE KV document (``ns="baseline"``, ``key="baseline"``) persisted through the
existing :class:`KVStore` abstraction — so it needs NO new ES index / SQL table /
migration. The SQL backend uses ``SqlKVStore`` (the shared KV table); the ES backend
uses the thin :class:`app.stores.memory.EsKVStore` adapter (a doc in the existing
config index — the generic ``<ns>:<key>`` fallback yields a distinct doc id).

The KV value is::

    {"series": {"<signature>": {"<bucket>": <BaselineState json>, ...}, ...}}

Writes go through :func:`app.stores.base.kv_mutate` (per-store lock + ``_rev``
compare-and-set) so a concurrent EVENTS batch can't silently clobber another. The
store NEVER raises: a load/save failure degrades to an empty set / best-effort write
and is logged, so a baseline glitch can never drop an event or break the pipeline.

Invariants: this store only reads/writes the mgmt/state side (#1); it holds pure
math sketches — it NEVER imports ``case_manager``, calls ``decide()``, or reads risk
weights (#3); and the sketch state is versioned SEPARATELY from — and can never
mutate — the byte-identical ``cluster_signature`` (#4)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..constants import BASELINE_KEY, BASELINE_NS
from ..models import BaselineState
from .base import KVStore, kv_mutate, kv_mutate_strict

logger = logging.getLogger("tlsoc.stores.baseline")


def _decode_series(doc: dict | None) -> dict[str, dict[int, BaselineState]]:
    """Parse the persisted KV value into ``{signature: {bucket: BaselineState}}``.

    Skips a single corrupt series / bucket rather than failing the whole load, so one
    bad document can never blank the entire baseline."""
    if not doc or not isinstance(doc, dict):
        return {}
    raw = doc.get("series", {})
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[int, BaselineState]] = {}
    for sig, buckets in raw.items():
        if not isinstance(buckets, dict):
            continue
        parsed: dict[int, BaselineState] = {}
        for bucket, state in buckets.items():
            try:
                parsed[int(bucket)] = BaselineState.model_validate(state)
            except Exception:  # noqa: BLE001 — skip a corrupt bucket, keep the rest
                continue
        out[str(sig)] = parsed
    return out


def _encode_series(series: dict[str, dict[int, BaselineState]]) -> dict[str, Any]:
    """Serialise ``{signature: {bucket: BaselineState}}`` back to the KV value.

    Buckets are written in ASCENDING integer-bucket order so the persisted JSON is
    stable across runs (determinism: the same in-memory state always serialises to the
    same document)."""
    return {
        "series": {
            str(sig): {
                str(b): buckets[b].model_dump(mode="json")
                for b in sorted(buckets)
            }
            for sig, buckets in sorted(series.items())
        }
    }


class BaselineStore:
    """CRUD over the anomaly-baseline sketch state, persisted as one KV document.

    Methods are read-modify-write over the single ``series`` dict — fine at our scale
    (a compact sketch per signature × ≤168 buckets, NOT log volume). None raises: a
    failure logs and returns a safe default. Mirrors :mod:`app.stores.user_prefs`."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    async def _load(self) -> dict[str, dict[int, BaselineState]]:
        try:
            doc = await self._kv.get(BASELINE_NS, BASELINE_KEY)
        except Exception as exc:  # noqa: BLE001 — baseline is best-effort
            logger.warning("Loading baseline failed (%s); using empty set", exc)
            return {}
        return _decode_series(doc)

    async def _save(self, series: dict[str, dict[int, BaselineState]]) -> None:
        payload = _encode_series(series)

        def _mutator(_current: dict | None) -> dict:
            # A full overwrite of the series doc; the CAS ``_rev`` guards against a
            # concurrent writer, and the caller passes the already-merged full set.
            return payload

        try:
            await kv_mutate(self._kv, BASELINE_NS, BASELINE_KEY, _mutator, lock=self._lock)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting baseline failed (%s); continuing", exc)

    # ---- whole-series (per signature) get/put ---------------------------- #
    async def get(self, signature: str) -> dict[int, BaselineState]:
        """The per-bucket sketch states for one ``cluster_signature`` (empty when
        unseen). Keyed by integer bucket (0–167 for hour-of-week)."""
        series = await self._load()
        return dict(series.get(str(signature), {}))

    async def put(self, signature: str, buckets: dict[int, BaselineState]) -> None:
        """Replace one signature's per-bucket sketch states (read-modify-write over the
        shared series doc, CAS-safe so a concurrent signature's write survives)."""
        sig = str(signature)

        def _change(current: dict | None) -> dict:
            series = _decode_series(current)
            series[sig] = {int(b): st for b, st in (buckets or {}).items()}
            return _encode_series(series)

        try:
            await kv_mutate(self._kv, BASELINE_NS, BASELINE_KEY, _change, lock=self._lock)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting baseline (%s) failed (%s); continuing", sig, exc)

    async def put_strict(
        self, signature: str, buckets: dict[int, BaselineState]
    ) -> None:
        """Confirmed sibling of :meth:`put` for operator-health accounting.

        The ingest producer still catches this at its fail-open boundary; exposing the
        failure here merely prevents the Jobs/worker-health surface from calling an
        unconfirmed baseline write successful.
        """
        sig = str(signature)

        def _change(current: dict | None) -> dict:
            series = _decode_series(current)
            series[sig] = {int(b): st for b, st in (buckets or {}).items()}
            return _encode_series(series)

        await kv_mutate_strict(
            self._kv, BASELINE_NS, BASELINE_KEY, _change, lock=self._lock
        )

    async def list_signatures(self) -> list[str]:
        """Every signature that has a persisted baseline (sorted, stable)."""
        return sorted((await self._load()).keys())

    async def signature_count(self) -> int:
        """How many distinct series are persisted (used to assert the engine-side
        ``max_series`` LRU bound keeps the durable set bounded)."""
        return len(await self._load())

    async def delete(self, signature: str) -> bool:
        """Drop one signature's whole baseline (e.g. on a cases/logs reset). Returns
        whether anything was removed."""
        sig = str(signature)
        removed = {"any": False}

        def _change(current: dict | None) -> dict:
            series = _decode_series(current)
            removed["any"] = series.pop(sig, None) is not None
            return _encode_series(series)

        await kv_mutate(self._kv, BASELINE_NS, BASELINE_KEY, _change, lock=self._lock)
        return removed["any"]

    async def delete_strict(self, signature: str) -> bool:
        """Confirmed eviction used by the realtime producer health projection."""
        sig = str(signature)
        removed = {"any": False}

        def _change(current: dict | None) -> dict:
            series = _decode_series(current)
            removed["any"] = series.pop(sig, None) is not None
            return _encode_series(series)

        await kv_mutate_strict(
            self._kv, BASELINE_NS, BASELINE_KEY, _change, lock=self._lock
        )
        return removed["any"]

    async def clear(self) -> None:
        """Drop ALL baseline sketches (a logs/cases-tier reset). Never raises."""
        def _change(_current: dict | None) -> dict:
            return _encode_series({})

        await kv_mutate(self._kv, BASELINE_NS, BASELINE_KEY, _change, lock=self._lock)

    # ---- snapshot / restore (whole-store bridge for the engine) ---------- #
    async def snapshot(self) -> dict[str, dict[int, BaselineState]]:
        """The ENTIRE persisted baseline (all signatures), typed. Used to warm a fresh
        :class:`app.engine.baseline.BaselineEngine` on startup."""
        return await self._load()

    async def restore(self, series: dict[str, dict[int, BaselineState]]) -> None:
        """Overwrite the ENTIRE persisted baseline (e.g. flush an engine's in-memory
        state back to durable KV). Never raises."""
        await self._save(series)
