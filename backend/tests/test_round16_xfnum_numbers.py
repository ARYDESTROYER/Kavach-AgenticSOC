"""Round 16 cross-cutting numbers review (package XFNUM): the backend half.

Each test pins one confirmed finding and fails before its fix:

* **standup-sla-rules-diverge.** Standup SLA aging (``shift_report.sla_aging``) runs
  the one shared clock rule, ``metrics.sla_case_reading``: breached only when the
  elapsed time is over the target, at risk from 0.8 of it, and no invented 120-minute
  target for a case whose priority has none. It agrees with posture
  (``metrics.sla_metrics``) and with every contract SLA vector.
* **urgency-band-raw-vs-shown-risk.** Urgency and a derived severity band the SHOWN
  risk integer (rounded half up), the integer the risk chip bands. A source-asserted
  severity keeps its own projection.
* **dwell-definition-omits-person.** The dwell explanation names a person's response;
  an automatic close is not a sample.
* **numbers-without-explanation (Average risk).** ``compute_metrics`` reports how many
  scored cases the mean divides by.

Advisory only: nothing here touches ``decide()`` or ``engine/risk.py`` (#3)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from app.config import Preferences, PriorityMatrix, SlaPolicy, SlaTarget
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface
from app.engine import metrics as M
from app.engine import shift_report
from app.engine.priority import advisory_bands, derive_triage, severity_band_from_events, urgency_band
from app.models import Case, Entity, StatusHistoryEntry, TriggerReason
from app.utils import round_half_up

UTC = timezone.utc
NOW = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)
CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "webui" / "src" / "lib" / "explain" / "explain.contract.json")
    .read_text(encoding="utf-8")
)


def _case(
    cid: str = "c1",
    *,
    created: datetime,
    status: CaseStatus = CaseStatus.OPEN,
    priority: str | None = "P1",
    risk: float = 10.0,
    entity: str = "198.51.100.7",
    history: list[tuple[str, str, datetime]] | None = None,
    decision_by: DecisionBy | None = None,
) -> Case:
    return Case(
        case_id=cid, case_number=f"CASE-{cid}", cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=entity), title=f"Case {cid}",
        created_at=created.isoformat(), updated_at=created.isoformat(),
        status=status, priority_level=priority, risk_score=risk, decision_by=decision_by,
        status_history=[
            StatusHistoryEntry(from_status="new", to_status=to, by=by, at=at.isoformat())
            for to, by, at in (history or [])
        ],
    )


def _posture_response(case: Case, sla: SlaPolicy, prefs: Any = None) -> tuple[int, int, int]:
    out = M.sla_metrics([case], sla, now=NOW, prefs=prefs)
    if not out.get("enabled"):
        return 0, 0, 0
    return out["evaluated"], out["response_breached"], out["response_at_risk"]


# --------------------------------------------------------------------------- #
# standup-sla-rules-diverge
# --------------------------------------------------------------------------- #
def test_a_p1_case_at_11_5_minutes_is_not_about_to_breach() -> None:
    case = _case(created=NOW - timedelta(minutes=11.5))
    aging = shift_report.sla_aging([case], SlaPolicy(), now=NOW)
    assert aging["totals"] == {"open": 1, "breached": 0, "about_to_breach": 0}
    assert _posture_response(case, SlaPolicy()) == (1, 0, 0)


def test_a_p1_case_at_exactly_its_target_is_at_risk_not_breached() -> None:
    case = _case(created=NOW - timedelta(minutes=15))
    aging = shift_report.sla_aging([case], SlaPolicy(), now=NOW)
    assert aging["totals"]["breached"] == 0
    assert aging["totals"]["about_to_breach"] == 1
    assert _posture_response(case, SlaPolicy()) == (1, 0, 1)


def test_a_priority_with_no_target_is_not_classified() -> None:
    sla = SlaPolicy()
    del sla.targets["P4"]
    case = _case(created=NOW - timedelta(minutes=180), priority="P4")
    aging = shift_report.sla_aging([case], sla, now=NOW)
    assert aging["totals"] == {"open": 1, "breached": 0, "about_to_breach": 0}
    assert aging["by_priority"]["P4"]["open"] == 1
    assert M.sla_metrics([case], sla, now=NOW)["evaluated"] == 0


def test_a_response_target_of_zero_is_not_classified() -> None:
    sla = SlaPolicy()
    sla.targets["P4"] = SlaTarget(response_minutes=0, resolve_minutes=4320)
    case = _case(created=NOW - timedelta(minutes=180), priority="P4")
    aging = shift_report.sla_aging([case], sla, now=NOW)
    assert aging["totals"]["breached"] == 0 and aging["totals"]["about_to_breach"] == 0
    posture = M.sla_metrics([case], sla, now=NOW)
    assert posture["response_breached"] == 0 and posture["response_at_risk"] == 0


def test_with_the_priority_matrix_off_standup_counts_no_breach() -> None:
    prefs = Preferences()
    prefs.priority_matrix = PriorityMatrix(enabled=False)
    case = _case(created=NOW - timedelta(hours=9), priority=None, risk=90.0)
    aging = shift_report.sla_aging([case], prefs.sla, now=NOW, prefs=prefs)
    assert aging["totals"] == {"open": 1, "breached": 0, "about_to_breach": 0}
    assert set(aging["by_priority"]) == {"unprioritized"}
    assert M.sla_metrics([case], prefs.sla, now=NOW, prefs=prefs)["evaluated"] == 0
    report = shift_report.build_shift_report([case], sla=prefs.sla, now=NOW, prefs=prefs)
    assert report["headline_counts"]["sla_breached"] == 0


def test_the_warn_fraction_key_reports_the_shared_fraction() -> None:
    aging = shift_report.sla_aging([], SlaPolicy(), now=NOW)
    assert aging["warn_fraction"] == M.SLA_AT_RISK_FRACTION == CONTRACT["sla"]["at_risk_fraction"]


def test_a_late_breach_row_carries_the_target_and_the_overdue_time() -> None:
    case = _case(created=NOW - timedelta(minutes=40))
    (row,) = shift_report.sla_aging([case], SlaPolicy(), now=NOW)["breached"]
    assert row["target_minutes"] == 15 and row["overdue_minutes"] == 25.0


@pytest.mark.parametrize(
    "vector", CONTRACT["sla"]["vectors"],
    ids=lambda v: f"{v['elapsed_minutes']}m-{'responded' if v['responded'] else 'open'}",
)
def test_every_contract_sla_vector_reads_the_same_on_standup(vector: dict[str, Any]) -> None:
    created = NOW - timedelta(minutes=vector["elapsed_minutes"])
    case = _case(created=created, priority=vector["priority"])
    if vector["responded"]:
        case.first_response_at = NOW
    aging = shift_report.sla_aging([case], SlaPolicy(), now=NOW)
    state = (
        "breached" if aging["totals"]["breached"]
        else "at_risk" if aging["totals"]["about_to_breach"]
        else "ok"
    )
    assert state == vector["state"]


def test_standup_and_posture_agree_over_a_grid() -> None:
    sla = SlaPolicy()
    cases = []
    for i, minutes in enumerate((5, 11.5, 12, 15, 15.01, 24, 30, 96, 120, 121, 384, 480, 481)):
        for prio in ("P1", "P2", "P3", "P4"):
            cases.append(_case(f"g{i}-{prio}", created=NOW - timedelta(minutes=minutes), priority=prio))
    aging = shift_report.sla_aging(cases, sla, now=NOW)
    posture = M.sla_metrics(cases, sla, now=NOW)
    assert aging["totals"]["breached"] == posture["response_breached"]
    assert aging["totals"]["about_to_breach"] == posture["response_at_risk"]


# --------------------------------------------------------------------------- #
# urgency-band-raw-vs-shown-risk
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("risk", "urgency", "severity"),
    [
        (47.49, "medium", "medium"),
        (47.5, "high", "high"),
        (47.74, "high", "high"),
        (48.0, "high", "high"),
        (21.49, "low", "low"),
        (21.5, "medium", "medium"),
        (21.6, "medium", "medium"),
        (73.49, "high", "high"),
        (73.5, "high", "critical"),
        (7.49, "low", "info"),
        (7.5, "low", "low"),
    ],
)
def test_urgency_and_derived_severity_band_the_shown_integer(risk: float, urgency: str, severity: str) -> None:
    prefs = Preferences()
    case = _case(created=NOW, risk=risk, priority=None)
    shown = round_half_up(risk)
    triage = derive_triage(case, prefs)
    # The risk chip bands the same shown integer.
    assert triage["risk"]["display"] == shown
    got = urgency_band(case, prefs)
    assert got["band"] == urgency and got["display"] == shown and got["value"] == round(risk, 2)
    sev = severity_band_from_events(case, prefs)
    assert sev["source"] == "derived" and sev["band"] == severity and sev["display"] == shown
    assert advisory_bands(case, prefs)["urgency_band"] == urgency
    assert triage["priority"]["urgency"]["band"] == urgency


def test_risk_47_74_is_high_urgency_and_p3() -> None:
    prefs = Preferences()
    case = _case(created=NOW, risk=47.74, priority=None)
    triage = derive_triage(case, prefs)
    assert triage["risk"]["band"] == "high"
    assert triage["priority"]["urgency"]["band"] == "high"
    assert triage["priority"]["level"] == "P3"
    assert triage["severity"]["band"] == "high"


def test_a_source_asserted_severity_keeps_its_projection() -> None:
    prefs = Preferences()
    case = _case(created=NOW, risk=10.0, priority=None)
    case.trigger_reason = TriggerReason(severity_max=47.6)
    sev = severity_band_from_events(case, prefs)
    assert sev["source"] == "source_asserted" and sev["band"] == "medium"


@pytest.mark.parametrize("vector", CONTRACT["priority"]["vectors"], ids=lambda v: f"{v['asset']}/{v['risk']}")
def test_the_contract_priority_vectors_read_through_the_case(vector: dict[str, Any]) -> None:
    prefs = Preferences()
    case = _case(created=NOW, risk=float(vector["risk"]), priority=None, entity="198.51.100.9")
    prefs.asset_criticality = {"198.51.100.9": float(vector["asset"])} if vector["asset"] else {}
    triage = derive_triage(case, prefs)
    assert triage["impact"]["band"] == vector["impact"]
    assert triage["priority"]["urgency"]["band"] == vector["urgency"]
    assert triage["priority"]["level"] == vector["level"]


def test_the_contract_holds_the_rounding_edge_priority_vectors() -> None:
    risks = {float(v["risk"]) for v in CONTRACT["priority"]["vectors"]}
    assert {47.5, 47.74, 21.5} <= risks


# --------------------------------------------------------------------------- #
# dwell-definition-omits-person
# --------------------------------------------------------------------------- #
def test_dwell_counts_a_person_response_only_and_says_so() -> None:
    created = NOW - timedelta(hours=5)
    agent = _case("agent", created=created, status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
                  history=[("closed", "agent", created + timedelta(minutes=1))])
    analyst = _case("analyst", created=created, status=CaseStatus.CLOSED,
                    history=[("closed", "alice", created + timedelta(minutes=20))])
    out = M.explain_metric([agent, analyst], "dwell", window_hours=24, now=NOW)
    assert out["sample_count"] == 1
    assert "person" in out["population"]
    assert "Automatic" in out["population"]


# --------------------------------------------------------------------------- #
# numbers-without-explanation: Average risk carries its count
# --------------------------------------------------------------------------- #
def test_compute_metrics_reports_how_many_scored_cases_average_risk_divides_by() -> None:
    cases = [_case(f"r{i}", created=NOW, risk=r) for i, r in enumerate((10.0, 20.0, 40.75))]
    out = M.compute_metrics(cases)
    assert out["avg_risk_case_count"] == 3
    assert out["avg_risk_score"] == round((10.0 + 20.0 + 40.75) / 3, 1)
    assert M.compute_metrics([])["avg_risk_case_count"] == 0
