"""Durable NOISE-REDUCTION counters — raw-alert-by-severity ingest tallies (Round 7).

The Noise-Reduction funnel ("total alerts by severity → what the AI reduced it to")
needs a DURABLE count of how many raw alerts were ingested (by severity band) versus how
many survived correlation / actually reached a human — something the case store alone
cannot answer once low-value events are dropped/suppressed at ingest. This store persists
those small per-hour counters so the funnel reflects the TRUE inbound volume, not just the
cases that happened to be created.

Backend-agnostic by construction — the SAME single-KV-document pattern as
:mod:`app.stores.baseline`: the WHOLE set of hourly buckets is ONE KV document
(``ns="noise_counters"``, ``key="noise_counters"``) persisted through the existing
:class:`KVStore` abstraction, so it needs NO new ES index / SQL table / migration. The ES
backend stores it as a doc in the config index; the SQL backend uses the shared KV table.

The KV value is::

    {"buckets": {"<epoch_hour>": {"ingested": {band: int}, "clustered": {band: int},
                                  "suppressed": int, "ignored": int,
                                  "by_source": {"<source_id>": {"ingested": {band: int},
                                                "clustered": {band: int}, "suppressed": int,
                                                "ignored": int,
                                                "severity_scale_max": float|None}, ...}}, ...},
     "since": "<iso of first record>"}

``severity_scale_max`` records the severity-ladder CEILING the writer used to BAND that
source's counts in that hour. It lives ONLY on the per-source sub-block, never on the
pooled per-hour totals: one bucket pools every source that ticked that hour, so a single
number there would describe none of them. It is the only durable evidence of which ladder
a historical band split came from — the tallies are bucketed by band AT WRITE TIME and
retained for :data:`_RETENTION_HOURS`, so once written a band split can never be
re-projected onto a different ceiling. ``None`` (or an absent key) means "not provable":
either the counts predate this stamp, or two writes into the same hour+source declared
DIFFERENT ceilings, so that hour's split is a mixture. Readers must treat a ``None`` as
"this window's band split cannot be shown to share one ladder", never as a default.

The pooled per-hour totals are UNCHANGED (byte-identical) — the ``by_source`` nested map
(A5.4 coverage observability) is a purely additive dimension: an old doc that predates it
has no ``by_source`` key and reads as ``{}`` (``_norm_bucket`` defaults it), and a delta
without a ``source_id`` folds into the pooled totals only, exactly as before. A delta that
DOES carry ``source_id`` folds the SAME counts into both the pooled totals and that
source's sub-bucket, so the per-source breakdown always sums to the pooled total.

Writes go through :func:`app.stores.base.kv_mutate` (per-store lock + ``_rev`` CAS) so
concurrent poller children / push receivers can't silently clobber one another. Buckets
older than :data:`_RETENTION_HOURS` are pruned on every write, and a hard cap bounds the
document, so the doc stays small regardless of uptime.

Invariants: this store holds ONLY advisory presentation/accounting counters — it NEVER
imports ``case_manager``, calls ``decide()`` (#3), reads risk weights, or recomputes a
``cluster_signature`` (#4). Every method is fail-open: a load/save glitch degrades to an
empty tally / best-effort write and is logged, so a counter hiccup can never drop an event
or break the poll/ingest path.
"""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone
from typing import Any

from ..constants import NOISE_KEY, NOISE_NS, SEVERITY_BANDS
from ..utils import now_utc
from .base import KVStore, kv_mutate

logger = logging.getLogger("tlsoc.stores.noise_counters")

# Keep at most this many trailing hours of buckets (90 days). Pruned on every write so
# the single KV document stays bounded no matter how long the process runs. A dashboard
# window never exceeds a few days in practice; this leaves ample slack.
_RETENTION_HOURS = 24 * 90
# Defensive hard cap on distinct buckets (should never be hit given the retention prune,
# but guarantees the doc can never grow unbounded even under clock skew).
_MAX_BUCKETS = _RETENTION_HOURS + 48


def _zero_bands() -> dict[str, int]:
    """A fresh ``{band: 0}`` dict over the canonical 5-band severity ladder."""
    return {b: 0 for b in SEVERITY_BANDS}


def _zero_counts(*, with_scale: bool = False) -> dict[str, Any]:
    """A fresh zero ``{ingested, clustered, suppressed, ignored}`` count block (the shape of
    both a per-hour total and one per-source sub-bucket).

    ``with_scale`` adds the per-source ``severity_scale_max`` stamp (``None`` = not yet
    recorded). It is OFF by default so the pooled per-hour total keeps exactly its
    previous key set."""
    out: dict[str, Any] = {"ingested": _zero_bands(), "clustered": _zero_bands(),
                           "suppressed": 0, "ignored": 0}
    if with_scale:
        out["severity_scale_max"] = None
    return out


def _safe_int(value: Any) -> int | None:
    """Coerce a bucket key / count to int, or None when it can't be (skip corrupt)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_scale_max(value: Any) -> float | None:
    """Coerce a recorded severity ceiling to a POSITIVE FINITE float, else ``None``.

    A bool, a non-number, ``nan``, ``±inf`` and a non-positive value are all "not a
    ceiling" and read as ``None`` — the same fail-closed reading the projection itself
    uses. ``inf`` is rejected as deliberately as ``0``: it survives every ``> 0`` test but
    can only ever have produced an all-informational band split."""
    if value is None or isinstance(value, bool):
        return None
    try:
        ceiling = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(ceiling) or ceiling <= 0:
        return None
    return ceiling


def _norm_counts(raw: Any, *, with_scale: bool = False) -> dict[str, Any]:
    """Parse a ``{ingested, clustered, suppressed, ignored}`` count block (NO nested
    ``by_source``) — the shape of both a whole-bucket total and one per-source sub-bucket.
    Coerces every band to a non-negative int, drops unknown bands, never raises.

    ``with_scale`` additionally preserves the per-source ``severity_scale_max`` stamp.
    It is OFF by default, so the POOLED per-hour total is byte-identical to before (the
    stamp is meaningless there — one bucket pools every source that ticked that hour) AND
    so a caller that only wants counts cannot accidentally carry a ceiling forward. It
    MUST be on wherever a stored sub-block is re-normalised, or the stamp is silently
    stripped on the next tick."""
    ingested = _zero_bands()
    clustered = _zero_bands()
    suppressed = 0
    ignored = 0
    scale_max: float | None = None
    if isinstance(raw, dict):
        for band, n in (raw.get("ingested") or {}).items():
            if band in ingested:
                ingested[band] = max(0, _safe_int(n) or 0)
        for band, n in (raw.get("clustered") or {}).items():
            if band in clustered:
                clustered[band] = max(0, _safe_int(n) or 0)
        suppressed = max(0, _safe_int(raw.get("suppressed")) or 0)
        ignored = max(0, _safe_int(raw.get("ignored")) or 0)
        scale_max = _safe_scale_max(raw.get("severity_scale_max"))
    out: dict[str, Any] = {"ingested": ingested, "clustered": clustered,
                           "suppressed": suppressed, "ignored": ignored}
    if with_scale:
        out["severity_scale_max"] = scale_max
    return out


def _norm_bucket(raw: Any) -> dict[str, Any]:
    """Parse one stored bucket into a well-formed ``{ingested, clustered, suppressed,
    ignored, by_source}`` dict, coercing every band count to a non-negative int and
    dropping any unknown band. The ``by_source`` map (A5.4) is additive — a pre-migration
    bucket with no ``by_source`` key reads as ``{}``. Each sub-block additionally keeps
    its ``severity_scale_max`` stamp (``None`` when it predates the stamp or the hour is a
    mixture); the POOLED total deliberately has no such key. Never raises — a corrupt
    bucket reads as all-zero with no per-source rows."""
    out = _norm_counts(raw)
    by_source: dict[str, Any] = {}
    if isinstance(raw, dict):
        raw_by_source = raw.get("by_source")
        if isinstance(raw_by_source, dict):
            for sid, sub in raw_by_source.items():
                if sid is None:
                    continue
                by_source[str(sid)] = _norm_counts(sub, with_scale=True)
    out["by_source"] = by_source
    return out


def _delta_is_empty(delta: dict[str, Any]) -> bool:
    """True when a delta carries no ingested/clustered/suppressed/ignored activity — an
    empty tick is a NO-OP (no write, no bucket created), so a quiet deployment never
    churns the KV doc and ``since`` marks the first REAL observation."""
    if not isinstance(delta, dict):
        return True
    for key in ("ingested", "clustered"):
        for n in (delta.get(key) or {}).values():
            if (_safe_int(n) or 0) > 0:
                return False
    return (_safe_int(delta.get("suppressed")) or 0) <= 0 and \
           (_safe_int(delta.get("ignored")) or 0) <= 0


def _fold_counts(out: dict[str, Any], delta: dict[str, Any]) -> None:
    """Fold ``delta``'s ingested/clustered/suppressed/ignored into a normalised counts
    block ``out`` IN PLACE (unknown bands ignored, counts clamped non-negative)."""
    for band, n in (delta.get("ingested") or {}).items():
        if band in out["ingested"]:
            out["ingested"][band] += max(0, _safe_int(n) or 0)
    for band, n in (delta.get("clustered") or {}).items():
        if band in out["clustered"]:
            out["clustered"][band] += max(0, _safe_int(n) or 0)
    out["suppressed"] += max(0, _safe_int(delta.get("suppressed")) or 0)
    out["ignored"] += max(0, _safe_int(delta.get("ignored")) or 0)


def _merge_scale_max(
    stored: Any, incoming: float | None, *, had_counts: bool
) -> float | None:
    """Reconcile the severity ceiling recorded on ONE (hour, source) sub-block.

    The counts in a sub-block are already bucketed BY BAND, so once two writes into the
    same hour+source used different ceilings that hour's split is an unreconstructable
    mixture. The rules are therefore fail-closed:

    * nothing stored yet, and the sub-block carried no counts → adopt ``incoming``
      (including ``None``, which honestly means "the writer did not record one");
    * stored == incoming → unchanged;
    * anything else (a missing incoming over existing counts, or a genuine disagreement)
      → ``None``, i.e. "this hour's split cannot be shown to come from one ladder".

    Never raises. Pure."""
    stored_ceiling = _safe_scale_max(stored)
    if not had_counts and stored_ceiling is None:
        return incoming
    if stored_ceiling is not None and incoming is not None and stored_ceiling == incoming:
        return stored_ceiling
    return None


def _merge_delta(bucket: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    """Fold ``delta`` into a normalised ``bucket`` (returns a fresh dict). Unknown bands
    are ignored; counts are clamped non-negative. The pooled totals are folded exactly as
    before (byte-identical); when ``delta`` carries a ``source_id`` the SAME counts are
    ALSO folded into ``by_source[source_id]`` (A5.4) so the per-source breakdown always
    sums to the pooled total. An optional ``delta["severity_scale_max"]`` records the
    ceiling that banded those counts onto that SUB-BLOCK only (see
    :func:`_merge_scale_max`); the pooled totals never carry it."""
    out = _norm_bucket(bucket)
    _fold_counts(out, delta)
    sid = delta.get("source_id")
    if sid is not None and str(sid):
        key = str(sid)
        sub = out["by_source"].get(key) or _zero_counts(with_scale=True)
        had_counts = not _delta_is_empty(sub)
        _fold_counts(sub, delta)
        sub["severity_scale_max"] = _merge_scale_max(
            sub.get("severity_scale_max"),
            _safe_scale_max(delta.get("severity_scale_max")),
            had_counts=had_counts,
        )
        out["by_source"][key] = sub
    return out


def _parse_iso_ts(value: Any) -> float | None:
    """Best-effort epoch seconds for an ISO ``since`` string (None when unparseable)."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


class NoiseCounterStore:
    """Durable per-hour raw-alert-by-severity counters, persisted as ONE KV document.

    Read-modify-write over the single ``buckets`` map — fine at our scale (a compact
    per-hour tally over a bounded retention window, NOT log volume). None raises: a
    failure logs and returns a safe default. Mirrors :class:`app.stores.baseline.BaselineStore`.
    """

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    async def _load_strict(self) -> dict[str, Any]:
        """Load the counter document or raise when persistence is unavailable.

        Ingest and the existing Noise Reduction surface intentionally use the
        fail-open projection below. Evidence reports that distinguish an empty
        counter set from a failed read use this strict projection instead.
        """
        doc = await self._kv.get(NOISE_NS, NOISE_KEY)
        return doc if isinstance(doc, dict) else {}

    async def _load(self) -> dict[str, Any]:
        try:
            return await self._load_strict()
        except Exception as exc:  # noqa: BLE001 — counters are best-effort
            logger.warning("Loading noise counters failed (%s); using empty tally", exc)
            return {}

    async def record(self, delta: dict[str, Any], now: datetime | None = None) -> None:
        """Fold one ingest/poll tick's counter ``delta`` into the current epoch-hour
        bucket (CAS-safe read-modify-write). ``delta`` is
        ``{"ingested": {band:int}, "clustered": {band:int}, "suppressed": int, "ignored":
        int}``. An empty delta is a NO-OP. Never raises — a persistence glitch degrades to
        a best-effort write, so a counter hiccup can never break the poll/ingest path."""
        if _delta_is_empty(delta):
            return
        moment = now or now_utc()
        try:
            hour = int(moment.timestamp() // 3600)
            stamp = moment.isoformat()
        except Exception:  # noqa: BLE001 — a bad clock never breaks ingest
            return

        def _change(current: dict | None) -> dict:
            doc = current if isinstance(current, dict) else {}
            raw_buckets = doc.get("buckets")
            buckets = dict(raw_buckets) if isinstance(raw_buckets, dict) else {}
            hkey = str(hour)
            buckets[hkey] = _merge_delta(buckets.get(hkey), delta)
            # Prune buckets older than the retention window (keeps the doc bounded).
            cutoff = hour - _RETENTION_HOURS
            buckets = {
                k: v for k, v in buckets.items()
                if (_safe_int(k) is not None and _safe_int(k) >= cutoff)
            }
            # Defensive hard cap: keep only the newest _MAX_BUCKETS by hour.
            if len(buckets) > _MAX_BUCKETS:
                newest = sorted(buckets, key=lambda k: _safe_int(k) or 0)[-_MAX_BUCKETS:]
                buckets = {k: buckets[k] for k in newest}
            since = doc.get("since") or stamp
            return {"buckets": buckets, "since": since}

        try:
            await kv_mutate(self._kv, NOISE_NS, NOISE_KEY, _change, lock=self._lock)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting noise counters failed (%s); continuing", exc)

    async def read_window(
        self,
        hours: int,
        now: datetime | None = None,
        *,
        end_exclusive: bool = False,
    ) -> dict[str, Any]:
        """Sum the counters over the trailing ``hours`` (``hours<=0`` → the WHOLE tally).

        Returns ``{available, since, incomplete, ingested{band:int}, clustered{band:int},
        suppressed, ignored}`` where:

        * ``available`` — whether ANY real observation has been recorded (False → the
          counters are "warming up"; the endpoint reports null ingested + degrades to a
          case-only funnel);
        * ``since`` — the ISO time of the first recorded observation (None when none);
        * ``incomplete`` — True when the requested window reaches BEFORE ``since`` (the
          counters cover only part of it, so the reduction% is a partial view).

        ``end_exclusive=True`` makes ``now`` an exact upper boundary. The default
        preserves the live dashboard behavior and includes the current hour.

        Never raises: a load glitch degrades to an empty (unavailable) tally."""
        return await self._read_window(
            hours,
            now=now,
            end_exclusive=end_exclusive,
            strict=False,
        )

    async def read_window_strict(
        self,
        hours: int,
        now: datetime | None = None,
        *,
        end_exclusive: bool = False,
    ) -> dict[str, Any]:
        """Read a bounded window while preserving storage failures for callers.

        This is used only by reporting surfaces whose availability state must not
        mistake a failed counter read for a genuinely empty/warming-up store.
        """
        return await self._read_window(
            hours,
            now=now,
            end_exclusive=end_exclusive,
            strict=True,
        )

    async def _read_window(
        self,
        hours: int,
        *,
        now: datetime | None,
        end_exclusive: bool,
        strict: bool,
    ) -> dict[str, Any]:
        moment = now or now_utc()
        doc = await self._load_strict() if strict else await self._load()
        since = doc.get("since")
        raw_buckets = doc.get("buckets")
        buckets = raw_buckets if isinstance(raw_buckets, dict) else {}
        available = bool(buckets) and isinstance(since, str) and bool(since)

        now_ts = moment.timestamp()
        hours = max(0, int(hours or 0))
        window_from_ts = (now_ts - hours * 3600.0) if hours > 0 else 0.0
        from_hour = int(window_from_ts // 3600) if hours > 0 else None
        # Complete-period reports request an exact ``[now-hours, now)`` boundary.
        # Live dashboards retain the historical behavior of including the current
        # (possibly just-started) hour while still excluding clock-skew/future buckets.
        to_hour_exclusive = (
            int(math.ceil(now_ts / 3600.0))
            if end_exclusive
            else int(now_ts // 3600) + 1
        )

        ingested = _zero_bands()
        clustered = _zero_bands()
        suppressed = 0
        ignored = 0
        by_source: dict[str, dict[str, Any]] = {}
        for k, raw in buckets.items():
            h = _safe_int(k)
            if h is None:
                continue
            if from_hour is not None and h < from_hour:
                continue
            if h >= to_hour_exclusive:
                continue
            nb = _norm_bucket(raw)
            for band in SEVERITY_BANDS:
                ingested[band] += nb["ingested"][band]
                clustered[band] += nb["clustered"][band]
            suppressed += nb["suppressed"]
            ignored += nb["ignored"]
            # Per-source breakdown (A5.4): sum each source's sub-bucket over the window.
            for sid, sub in (nb.get("by_source") or {}).items():
                agg = by_source.get(sid)
                if agg is None:
                    agg = _zero_counts(with_scale=True)
                    by_source[sid] = agg
                    agg["severity_scale_max"] = sub.get("severity_scale_max")
                else:
                    # Summing hours only preserves a band split when EVERY contributing
                    # hour banded on the same recorded ceiling. A missing or differing
                    # stamp makes the summed split a mixture — record that as None rather
                    # than picking a winner.
                    agg["severity_scale_max"] = _merge_scale_max(
                        agg.get("severity_scale_max"),
                        _safe_scale_max(sub.get("severity_scale_max")),
                        had_counts=True,
                    )
                for band in SEVERITY_BANDS:
                    agg["ingested"][band] += sub["ingested"][band]
                    agg["clustered"][band] += sub["clustered"][band]
                agg["suppressed"] += sub["suppressed"]
                agg["ignored"] += sub["ignored"]

        incomplete = False
        if available and hours > 0:
            since_ts = _parse_iso_ts(since)
            valid_hours = [
                hour for key in buckets if (hour := _safe_int(key)) is not None
            ]
            # ``since`` is intentionally the first-ever observation and survives
            # retention pruning. Bound it by the oldest hour the current retained
            # document could still cover; otherwise a long-running store would call
            # a 121-day report complete after its first 31 days had been pruned from
            # the 90-day ledger. Deriving the floor from the newest retained bucket
            # avoids treating quiet (missing) hours as a later coverage start.
            retention_floor_ts = (
                (max(valid_hours) - _RETENTION_HOURS) * 3600.0
                if valid_hours
                else None
            )
            coverage_start_ts = since_ts
            if retention_floor_ts is not None:
                coverage_start_ts = (
                    max(coverage_start_ts, retention_floor_ts)
                    if coverage_start_ts is not None
                    else retention_floor_ts
                )
            if coverage_start_ts is not None and coverage_start_ts > window_from_ts:
                incomplete = True

        return {
            "available": available,
            "since": since if available else None,
            "incomplete": incomplete,
            "ingested": ingested,
            "clustered": clustered,
            "suppressed": suppressed,
            "ignored": ignored,
            # A5.4 coverage observability — durable per-source ingest/clustered/drop
            # breakdown over the window (empty ``{}`` for pre-migration docs). Additive:
            # existing consumers (build_noise_reduction) read only the pooled keys above.
            # Each row also carries ``severity_scale_max``: the ONE severity ceiling every
            # contributing hour recorded for that source, or ``None`` when the summed band
            # split mixes ladders (or predates the stamp). It is the only evidence a
            # reader has that two windows' band splits are comparable at all.
            "by_source": by_source,
        }

    async def read_hourly_ingested(
        self, hours: int, now: datetime | None = None
    ) -> dict[str, Any]:
        """Per-epoch-hour TOTAL ingested-alert tallies over the trailing ``hours``.

        Additive read-only projection for the bucketed trends rollup
        (``GET /api/metrics/trends``): each retained hourly bucket's ``ingested``
        severity bands are summed into one integer, keyed by the epoch hour, so a
        consumer can re-bucket raw-alert volume onto arbitrary (whole-hour) trend
        buckets. Returns ``{"available": bool, "since": iso|None,
        "hours": {epoch_hour:int -> int}}`` — ``available`` has exactly the
        :meth:`read_window` semantics (False → warming up, the caller renders null,
        never a fake 0). Never raises: a load glitch degrades to unavailable."""
        moment = now or now_utc()
        doc = await self._load()
        since = doc.get("since")
        raw_buckets = doc.get("buckets")
        buckets = raw_buckets if isinstance(raw_buckets, dict) else {}
        available = bool(buckets) and isinstance(since, str) and bool(since)

        now_ts = moment.timestamp()
        hours = max(0, int(hours or 0))
        from_hour = int((now_ts - hours * 3600.0) // 3600) if hours > 0 else None
        to_hour_exclusive = int(now_ts // 3600) + 1  # incl. the current partial hour

        out: dict[int, int] = {}
        for key, raw in buckets.items():
            hour = _safe_int(key)
            if hour is None:
                continue
            if from_hour is not None and hour < from_hour:
                continue
            if hour >= to_hour_exclusive:
                continue
            counts = _norm_counts(raw)
            out[hour] = sum(counts["ingested"].values())
        return {
            "available": available,
            "since": since if available else None,
            "hours": out,
        }

    async def clear(self) -> None:
        """Drop ALL counters (a cases/logs-tier reset). Never raises."""
        def _change(_current: dict | None) -> dict:
            return {"buckets": {}, "since": None}

        try:
            await kv_mutate(self._kv, NOISE_NS, NOISE_KEY, _change, lock=self._lock)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Clearing noise counters failed (%s); continuing", exc)
