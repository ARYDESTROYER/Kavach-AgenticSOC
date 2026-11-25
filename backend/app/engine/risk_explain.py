"""What a risk score was computed from (Round 16 SPEC §2.2 S3, §4.3 WP01, B13).

``engine/risk.py::compute_risk`` returns the five rounded factors and the total, and
stays byte-identical (#3). This module records, beside it, the inputs those numbers
came from, so an explanation can re-derive every factor and the total from the stored
record alone, after the case attached more events or the weights changed:

* volume     = ``min(100, 100 * ln(1 + event_count) / ln(1 + refs.volume))``
  (0 for no events);
* velocity   = ``min(100, 100 * rate_per_minute / refs.velocity)`` when
  ``velocity_rule == "rate"``, else 0 (fewer than 3 events), where
  ``rate_per_minute = event_count / (effective_window_seconds / 60)`` and
  ``effective_window_seconds = max(span_seconds, 1)``;
* reputation = ``reputation_input`` clamped to 0..100;
* diversity  = ``min(100, 100 * rule_type_count / refs.diversity)``;
* asset      = ``asset_value`` clamped to 0..100;
* total      = ``sum(weight_i * factor_i) / total_weight``, or divided by 1 when the
  weights sum to 0 (``zero_weight_fallback``).

Pure and synchronous: no I/O, no clock (the caller passes ``scored_at``), no model
call (#6). It reads the same reference points and the same asset policy function as
``compute_risk``, so the two cannot disagree; a property test holds them together.
Nothing reads these inputs to decide anything (#3), and this module imports nothing
from ``engine/case_manager.py`` (the §3.6 guard).
"""

from __future__ import annotations

import ipaddress
import math
from typing import Any

from ..config import Preferences
from ..models import (
    RISK_INPUTS_VERSION,
    RISK_REPUTATION_SOURCES,
    Cluster,
    RiskInputs,
    RiskReferences,
    RiskWeightsSnapshot,
)
from .risk import _DIVERSITY_REF, _VELOCITY_REF, _VOLUME_REF, _asset_criticality

#: The fewest events at which velocity counts (``compute_risk``'s ``count >= 3``).
VELOCITY_MIN_EVENTS = 3


def _asset_match(entity_value: str, prefs: Preferences) -> str:
    """How the asset policy matched ``entity_value``, in ``_asset_criticality``'s
    order: any configured network range that contains the IP wins (``network``), then
    an exact entry (``exact``), otherwise ``none`` (criticality 0)."""
    if prefs.asset_networks:
        try:
            addr = ipaddress.ip_address(entity_value)
        except ValueError:
            addr = None
        if addr is not None:
            for net in prefs.asset_networks:
                try:
                    cidr = ipaddress.ip_network(net.cidr, strict=False)
                except ValueError:
                    continue
                if addr in cidr:
                    return "network"
    if entity_value in prefs.asset_criticality:
        return "exact"
    return "none"


def _finite(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def explain_risk(
    cluster: Cluster,
    prefs: Preferences,
    reputation: float,
    *,
    reputation_source: str,
    scored_at: str,
) -> RiskInputs:
    """The :class:`RiskInputs` of ``compute_risk(cluster, prefs, reputation)``.

    ``reputation_source`` is one of ``enrichment``, ``not_ip_entity``,
    ``enrichment_off`` or ``not_looked_up`` (the caller knows how it obtained the
    reputation; any other value is recorded as ``not_looked_up``, so a caller's mistake
    never raises into a run); ``scored_at`` is an ISO timestamp. ``reputation_input``
    and ``asset_value`` are the values before clamping; one that is not a finite number
    is recorded as the clamped factor ``compute_risk`` used, so the record stays valid
    JSON and still re-derives the score."""
    if reputation_source not in RISK_REPUTATION_SOURCES:
        reputation_source = "not_looked_up"
    weights = prefs.risk_weights
    count = int(cluster.count)
    span = float(cluster.window_seconds)
    effective = max(span, 1.0)
    if count >= VELOCITY_MIN_EVENTS:
        rate: float | None = count / (effective / 60.0)
        velocity_rule = "rate"
    else:
        rate = None
        velocity_rule = "below_min_events"

    clamped_reputation = max(0.0, min(100.0, reputation))
    reputation_input = _finite(reputation, clamped_reputation)

    entity_value = cluster.entity.value
    # The same clamp as ``compute_risk``: a NaN or +infinity criticality scores 100 there
    # (``min(100.0, nan)`` is 100.0), so a value that is not finite is recorded as that
    # clamped factor, never as a 0 the score did not use.
    raw_asset = _asset_criticality(entity_value, prefs)
    asset_value = _finite(raw_asset, max(0.0, min(100.0, raw_asset)))

    # The same terms, in the same order, as ``compute_risk``'s denominator, so the sum
    # is bit-identical to the one the score divided by.
    total_weight = (
        weights.volume + weights.velocity + weights.reputation
        + weights.diversity + weights.asset_criticality
    )
    return RiskInputs(
        event_count=count,
        span_seconds=span,
        effective_window_seconds=effective,
        rate_per_minute=rate,
        velocity_rule=velocity_rule,
        rule_values=list(cluster.rule_values),
        rule_type_count=len(cluster.rule_values),
        reputation_input=reputation_input,
        reputation_source=reputation_source,
        asset_value=asset_value,
        asset_match=_asset_match(entity_value, prefs),
        weights=RiskWeightsSnapshot(
            volume=weights.volume,
            velocity=weights.velocity,
            reputation=weights.reputation,
            diversity=weights.diversity,
            asset_criticality=weights.asset_criticality,
        ),
        total_weight=total_weight,
        zero_weight_fallback=total_weight == 0,
        refs=RiskReferences(volume=_VOLUME_REF, velocity=_VELOCITY_REF, diversity=_DIVERSITY_REF),
        scored_at=str(scored_at or ""),
        inputs_version=RISK_INPUTS_VERSION,
    )


def factors_from_inputs(inputs: RiskInputs) -> dict[str, float]:
    """The five full-precision factors and the total, re-derived from ``inputs`` alone
    with the formulas in this module's docstring. ``compute_risk`` rounds each factor
    and the total to 2 decimals; the total here is from the unrounded factors."""
    refs = inputs.refs
    count = inputs.event_count
    volume = 0.0 if count <= 0 else min(100.0, 100.0 * math.log1p(count) / math.log1p(refs.volume))
    if inputs.velocity_rule == "rate" and inputs.rate_per_minute is not None:
        velocity = min(100.0, 100.0 * inputs.rate_per_minute / refs.velocity)
    else:
        velocity = 0.0
    reputation = max(0.0, min(100.0, inputs.reputation_input))
    diversity = min(100.0, 100.0 * inputs.rule_type_count / refs.diversity)
    asset = max(0.0, min(100.0, inputs.asset_value))
    w = inputs.weights
    denominator = 1.0 if inputs.zero_weight_fallback else inputs.total_weight
    total = (
        w.volume * volume
        + w.velocity * velocity
        + w.reputation * reputation
        + w.diversity * diversity
        + w.asset_criticality * asset
    ) / denominator
    return {
        "volume": volume,
        "velocity": velocity,
        "reputation": reputation,
        "diversity": diversity,
        "asset_criticality": asset,
        "total": total,
    }
