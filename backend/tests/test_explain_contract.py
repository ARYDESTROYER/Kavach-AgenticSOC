"""The explainability contract, server side (Round 16 SPEC §4.3 WP01; research
explainability §5.4).

``webui/src/lib/explain/explain.contract.json`` holds input vectors and expected
outputs. This module asserts the backend functions that compute each number produce
them exactly; the Console builders are held to the same file by a Vitest, so if
either side changes a number one suite fails.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.config import Preferences, PriorityMatrix, RiskWeights, SlaPolicy
from app.constants import EntityType, SourceSurface
from app.engine.auto_close_review import wilson_interval
from app.engine.metrics import percentile, sla_metrics
from app.engine.priority import _band_from_magnitude, _severity_band_from_magnitude, derive_priority
from app.engine.risk import compute_risk
from app.engine.risk_explain import explain_risk, factors_from_inputs
from app.engine.threshold_tuner import wilson_lower_bound
from app.models import Case, Cluster, Entity
from app.utils import round_half_up

CONTRACT_PATH = (
    Path(__file__).resolve().parents[2] / "webui" / "src" / "lib" / "explain" / "explain.contract.json"
)
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
BASE_MILLIS = 1_700_000_000_000


def _cluster(spec: dict) -> Cluster:
    count = int(spec["event_count"])
    return Cluster(
        signature="sig-contract",
        entity=Entity(type=EntityType.IP, value=spec["entity_value"]),
        group_by=EntityType.IP,
        rule_values=list(spec["rule_values"]),
        count=count,
        first_seen_millis=BASE_MILLIS,
        last_seen_millis=BASE_MILLIS + int(float(spec["span_seconds"]) * 1000),
    )


def _prefs(vector: dict) -> Preferences:
    prefs = Preferences()
    prefs.asset_criticality = {k: float(v) for k, v in vector["asset_criticality"].items()}
    if vector["weights"] is not None:
        prefs.risk_weights = RiskWeights(**vector["weights"])
    return prefs


def test_the_contract_file_names_every_section() -> None:
    assert set(CONTRACT) >= {"rounding", "risk", "wilson", "percentile", "priority", "sla"}


@pytest.mark.parametrize("vector", CONTRACT["rounding"]["vectors"], ids=lambda v: str(v["value"]))
def test_rounding_and_banding(vector: dict) -> None:
    display = round_half_up(vector["value"])
    assert display == vector["display"]
    # The band is of the DISPLAYED integer (73.5 shows 74 and reads Critical).
    assert _severity_band_from_magnitude(display) == vector["band"]


@pytest.mark.parametrize("vector", CONTRACT["risk"]["vectors"], ids=lambda v: v["name"])
def test_risk_vectors(vector: dict) -> None:
    cluster, prefs = _cluster(vector["cluster"]), _prefs(vector)
    expected = vector["expected"]
    breakdown = compute_risk(cluster, prefs, float(vector["reputation"]))
    assert breakdown.model_dump(exclude={"inputs"}) == expected["breakdown"]
    inputs = explain_risk(
        cluster, prefs, float(vector["reputation"]),
        reputation_source=vector["reputation_source"], scored_at=CONTRACT["risk"]["scored_at"],
    )
    assert inputs.model_dump(mode="json") == expected["inputs"]
    full = factors_from_inputs(inputs)
    assert abs(full["total"] - expected["breakdown"]["total"]) <= CONTRACT["risk"]["tolerance_full_precision"]
    assert round_half_up(breakdown.total) == expected["display"]
    assert _severity_band_from_magnitude(expected["display"]) == expected["band"] or (
        expected["band"] == "low" and expected["display"] < 8
    )


@pytest.mark.parametrize("vector", CONTRACT["wilson"]["vectors"], ids=lambda v: f"{v['successes']}/{v['total']}")
def test_wilson_vectors(vector: dict) -> None:
    interval = wilson_interval(vector["successes"], vector["total"])
    assert interval == {"low": vector["low"], "high": vector["high"]}
    lower = wilson_lower_bound(vector["successes"], vector["total"], z=CONTRACT["wilson"]["z"])
    assert round(lower, CONTRACT["wilson"]["decimals"]) == vector["low"]


@pytest.mark.parametrize("vector", CONTRACT["percentile"]["vectors"])
def test_percentile_vectors(vector: dict) -> None:
    assert percentile([float(v) for v in vector["values"]], 50) == vector["p50"]
    assert percentile([float(v) for v in vector["values"]], 90) == pytest.approx(vector["p90"], abs=1e-9)


@pytest.mark.parametrize("vector", CONTRACT["priority"]["vectors"], ids=lambda v: f"{v['impact']}/{v['urgency']}")
def test_priority_vectors(vector: dict) -> None:
    impact = _band_from_magnitude(float(vector["asset"]))
    urgency = _band_from_magnitude(float(vector["risk"]))
    assert (impact, urgency) == (vector["impact"], vector["urgency"])
    assert derive_priority(impact, urgency, PriorityMatrix())["level"] == vector["level"]


@pytest.mark.parametrize(
    "vector", CONTRACT["sla"]["vectors"],
    ids=lambda v: f"{v['elapsed_minutes']}m-{'responded' if v['responded'] else 'open'}",
)
def test_sla_vectors(vector: dict) -> None:
    now = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
    created = now - timedelta(minutes=vector["elapsed_minutes"])
    case = Case(
        case_id="case-sla-contract", cluster_signature="sig", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="10.0.4.12"), priority_level=vector["priority"],
        created_at=created.isoformat(),
        first_response_at=(now if vector["responded"] else None),
    )
    policy = SlaPolicy()
    assert policy.targets[vector["priority"]].response_minutes == vector["target_minutes"]
    reading = sla_metrics([case], policy, now=now)
    if reading["response_breached"]:
        state = "breached"
    elif reading["response_at_risk"]:
        state = "at_risk"
    else:
        state = "ok"
    assert state == vector["state"]
