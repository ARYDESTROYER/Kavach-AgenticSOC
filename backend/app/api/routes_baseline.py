"""Anomaly-BASELINE routes (Round 4, Wave 4).

READ-ONLY surfaces over the streaming anomaly-baseline sketches
(:mod:`app.engine.baseline` + :mod:`app.stores.baseline`) so the webui can render
the "improves over time" WARM-UP GAUGE and the live p50/p95/p99 percentiles:

* ``GET /api/baseline/stats``          — the warm-up + coverage overview across every
                                         signature with a persisted baseline.
* ``GET /api/baseline/{signature}``    — one signature's per-bucket warm-up state +
                                         robust p50/p95/p99 for the UI gauge.

A SEPARATE router module (the integrator mounts it with the SAME ``require_auth``
mount the monolith uses). Both routes are GET + read-only and gate on ``settings:read``
(the baseline is operator anomaly-tuning config, alongside the models/budget read
grants). They mutate NOTHING.

⛔ NON-NEGOTIABLE #3: nothing here imports ``case_manager`` / calls ``decide()`` or
reads risk weights. The baseline is a PURE advisory PRODUCER; these routes only READ
its sketches. A warm-up state can never close/escalate a case.

⛔ NON-NEGOTIABLE #4: the sketch is keyed BY ``cluster_signature`` but never
recomputes / mutates one — it only references it as a bucket key.

⛔ NON-NEGOTIABLE #9: a signature is source-derived (it can embed rule/entity text) —
it is returned as bounded PLAIN DATA the UI render-escapes, never interpolated into a
prompt. Percentiles / counts are numbers.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..audit.context import audit_context
from ..audit.settings_write import audited_settings_write
from ..config import BaselineConfig
from ..constants import ActionType
from ..engine.baseline import SEASONAL_PERIODS, SKETCH_VERSION, _TDigest
from ..models import AuditTarget
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.baseline")

router = APIRouter(prefix="/api")


def _actor(request: Request) -> str:
    """The authenticated username, or ``""`` when no principal resolves (sign-in off,
    or a caller without one): the row is then written anonymously, never refused."""
    try:
        return current_username(request) or ""
    except Exception:  # noqa: BLE001 (no resolvable principal; audit anonymously)
        return ""


def _safe(value: Any) -> str:
    """A bounded plain string for the client (#9): a signature can carry source-derived
    rule/entity text, so we cap it and the UI render-escapes it; never a prompt."""
    return str(value)[:2000]


def _deep_update(dst: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    """In-place recursive merge of ``src`` INTO ``dst`` — a PUT deep-merges only the
    keys the caller sent (mirrors ``routes.py:_deep_update`` + the ``PUT /api/settings``
    contract). Absent keys keep their current value; a nested dict is merged, not
    replaced."""
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            dst[key] = _deep_update(dst[key], value)
        else:
            dst[key] = value
    return dst


def _warmup_target(state: AppState) -> int:
    """``warmup_multiplier × seasonal_period`` — the observations a bucket needs to be
    WARM, derived from the live ``Preferences.baseline`` config (default weekly = 168 →
    3 × 168 = 504). Guarded so a malformed config can never divide-by-zero the gauge."""
    cfg = getattr(state.execution_prefs, "baseline", None)
    seasonality = str(getattr(cfg, "seasonality", "hour_of_week"))
    period = SEASONAL_PERIODS.get(seasonality, 168)
    mult = int(getattr(cfg, "warmup_multiplier", 3) or 3)
    return max(1, mult) * max(1, period)


def _bucket_percentiles(state, compression: float) -> tuple[float, float, float]:
    """Robust ``(p50, p95, p99)`` for one bucket's persisted t-digest (all 0.0 when the
    bucket is empty). Reads-only — rebuilds the sketch from its centroids, never mutates
    the stored state."""
    if not getattr(state, "tdigest", None):
        return 0.0, 0.0, 0.0
    td = _TDigest.from_list(state.tdigest, compression)
    return td.quantile(0.5), td.quantile(0.95), td.quantile(0.99)


# --------------------------------------------------------------------------- #
# GET /api/baseline/stats — warm-up + coverage overview
# --------------------------------------------------------------------------- #
@router.get("/baseline/stats")
async def baseline_stats(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """The tenant-wide warm-up + coverage overview.

    Reports how many signatures have a baseline, how many per-signature buckets are WARM
    vs still warming, and the config knobs that drive the gauge (``warmup_target``,
    ``seasonality``). NEVER raises — a store glitch degrades to an empty overview.
    Read-only advisory (#3/#4)."""
    cfg = getattr(state.execution_prefs, "baseline", None)
    target = _warmup_target(state)
    try:
        series = await state.baseline_store.snapshot()
    except Exception as exc:  # noqa: BLE001 — baseline is best-effort
        logger.warning("baseline snapshot failed (%s); empty overview", exc)
        series = {}

    signatures: list[dict[str, Any]] = []
    total_buckets = 0
    warm_buckets = 0
    for sig, buckets in (series or {}).items():
        n_warm = sum(1 for st in buckets.values() if getattr(st, "warm", False))
        n_buckets = len(buckets)
        total_buckets += n_buckets
        warm_buckets += n_warm
        max_n = max((getattr(st, "n_samples", 0) for st in buckets.values()), default=0)
        signatures.append({
            "signature": _safe(sig),
            "buckets": n_buckets,
            "warm_buckets": n_warm,
            "max_samples": int(max_n),
            "fully_warm": n_buckets > 0 and n_warm == n_buckets,
        })
    signatures.sort(key=lambda s: (-s["warm_buckets"], s["signature"]))

    return {
        "enabled": bool(getattr(cfg, "enabled", False)),
        "signature_count": len(signatures),
        "total_buckets": total_buckets,
        "warm_buckets": warm_buckets,
        "warmup_target": target,
        "seasonality": _safe(getattr(cfg, "seasonality", "hour_of_week")),
        "half_life_days": float(getattr(cfg, "half_life_days", 14.0) or 14.0),
        "modified_z_threshold": float(getattr(cfg, "modified_z_threshold", 3.5) or 3.5),
        "sketch_version": SKETCH_VERSION,
        "signatures": signatures,
    }


# --------------------------------------------------------------------------- #
# GET / PUT /api/baseline/config — read/update Preferences.baseline
# (mirrors routes_tuning's GET/PUT /tuning/config; deep-merge PUT semantics)
#
# NB registered BEFORE the ``/baseline/{signature}`` catch-all so the literal
# ``config`` path is not swallowed as a signature (FastAPI matches in order).
# --------------------------------------------------------------------------- #
@router.get("/baseline/config")
async def get_baseline_config(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """Read ``Preferences.baseline`` (the anomaly-baseline policy). Read-only, no
    secrets — the baseline block carries only tuning knobs (#10)."""
    cfg = getattr(state.execution_prefs, "baseline", None) or BaselineConfig()
    return {"config": cfg.model_dump(mode="json")}


@router.put("/baseline/config")
async def put_baseline_config(
    body: dict[str, Any],
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    """Update the ``baseline`` policy, DEEP-MERGING only the keys the caller sent onto
    the live config (mirrors the ``PUT /api/settings`` contract). Additive + validated
    by the Pydantic model; never touches ``decide()`` (#3) — the baseline is a pure
    advisory producer.

    Audited before it is saved (#2, Round 14 SPEC §3.6): a ``settings.updated`` row
    naming every changed field is appended first, and a failed append answers ``503
    audit_unavailable`` with nothing saved. The baseline policy follows the active
    execution stack, so in Demo Mode the edit stays in the Demo sandbox and its row goes
    to the Demo audit (SPEC §3.5)."""
    saved: dict[str, BaselineConfig] = {}

    def _apply(current):
        cfg_now = (getattr(current, "baseline", None) or BaselineConfig()).model_dump(mode="json")
        merged = _deep_update(cfg_now, body or {})
        try:
            cfg = BaselineConfig.model_validate(merged)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Invalid baseline config: {exc}") from exc
        saved["cfg"] = cfg
        return current.model_copy(update={"baseline": cfg})

    def _summary(_changes, _total) -> str:
        cfg = saved["cfg"]
        return (
            "baseline_config_update: "
            f"enabled={cfg.enabled} seasonality={cfg.seasonality} "
            f"half_life_days={cfg.half_life_days} warmup_multiplier={cfg.warmup_multiplier} "
            f"modified_z_threshold={cfg.modified_z_threshold} "
            f"tdigest_compression={cfg.tdigest_compression}"
        )[:500]

    await audited_settings_write(
        state, transform=_apply, scope="execution", actor=_actor(request),
        context=audit_context(request), summary=_summary,
        action_type=ActionType.USER_MGMT, surface="baseline",
        target=AuditTarget(type="setting", id="baseline", label="Baseline"),
    )
    return {"ok": True, "config": saved["cfg"].model_dump(mode="json")}


# --------------------------------------------------------------------------- #
# GET /api/baseline/{signature} — per-signature warm-up + p50/p95/p99 gauge
# --------------------------------------------------------------------------- #
@router.get("/baseline/{signature}")
async def baseline_for_signature(
    signature: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """One signature's per-bucket warm-up state + robust p50/p95/p99 (the UI gauge).

    Each bucket reports ``(n, target)`` for its warm-up gauge, whether it is WARM yet,
    and its live percentiles read from the persisted t-digest. NEVER 404s — an unseen
    signature returns an empty-but-renderable shell. Read-only advisory (#3/#4)."""
    sig = (signature or "").strip()
    cfg = getattr(state.execution_prefs, "baseline", None)
    target = _warmup_target(state)
    compression = float(getattr(cfg, "tdigest_compression", 100) or 100)
    try:
        buckets = await state.baseline_store.get(sig)
    except Exception as exc:  # noqa: BLE001
        logger.warning("baseline get(%s) failed (%s)", sig, exc)
        buckets = {}

    rows: list[dict[str, Any]] = []
    for bucket, st in sorted((buckets or {}).items()):
        n = int(getattr(st, "n_samples", 0))
        p50, p95, p99 = _bucket_percentiles(st, compression)
        rows.append({
            "bucket": int(bucket),
            "n": n,
            "target": target,
            "warm": bool(getattr(st, "warm", False)),
            "progress": min(1.0, n / target) if target > 0 else 0.0,
            "p50": p50,
            "p95": p95,
            "p99": p99,
        })

    warm_buckets = sum(1 for r in rows if r["warm"])
    return {
        "signature": _safe(sig),
        "found": len(rows) > 0,
        "warmup_target": target,
        "buckets": len(rows),
        "warm_buckets": warm_buckets,
        "seasonality": _safe(getattr(cfg, "seasonality", "hour_of_week")),
        "series": rows,
    }
