"""Round 16 FXD2: explainable numbers on Standup, Agent effectiveness, Team activity and
"Why was this investigated?".

* The forwarding explainer prints the routing score with two decimals (32.63, never the
  integer cut "32") and returns the terms behind it, so the Console can print arithmetic
  that gives the score exactly. It stays a read-only narrator: the gate it explains is
  untouched (#3).
* The Standup report carries the inputs its explanations need: each attention row's
  risk breakdown and the instant its age counts from, and each SLA row's clock elapsed
  time and whether it still runs. The standup model's aggregate leaves them out.
* Team activity returns the sorted times around its median, so the median can be
  recomputed.
* Agent effectiveness definitions use plain words, never engine names.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.config import Preferences, SlaPolicy, SlaTarget
from app.constants import CaseStatus, EntityType
from app.engine import shift_report
from app.engine.correlation import cluster_from_events
from app.engine.forwarding import explain_forwarding
from app.engine.risk import compute_routing_risk
from app.models import Case, Entity, RiskBreakdown
from tests.conftest import make_raw_event
from tests.test_round3_wave2_standup import standup_client  # noqa: F401  (the route fixture)

BASE = 1_795_000_000_000


def _events_cluster(n: int, *, ip: str = "203.0.113.50", rules: tuple[str, ...] = ("linux_auth",), gap_ms: int = 1000):
    events = [
        make_raw_event(id=f"e{i}", ip=ip, rule=rules[i % len(rules)], ts_millis=BASE + i * gap_ms)
        for i in range(n)
    ]
    cluster = cluster_from_events(EntityType.IP, ip, events)
    cluster.is_alert = False
    return cluster


# --------------------------------------------------------------------------- #
# Forwarding: the routing score text and its terms
# --------------------------------------------------------------------------- #
def test_the_routing_score_is_never_cut_to_an_integer() -> None:
    prefs = Preferences(background_scan_enabled=True, auto_forward_allowlist=[])
    cluster = _events_cluster(7, gap_ms=12_000)
    out = explain_forwarding(cluster, prefs).to_dict()
    total = compute_routing_risk(cluster, prefs, reputation=None).total
    assert out["gate"] == "risk_floor"
    assert total != int(total), "the fixture must give a score with decimals"
    shown = f"{total:.2f}".rstrip("0").rstrip(".")
    assert f"routing score {shown} is below the configured floor 70." in out["sentence"]
    assert f"routing score {int(total)} " not in out["sentence"]


def test_the_routing_terms_reproduce_the_routing_score() -> None:
    prefs = Preferences(background_scan_enabled=True, auto_forward_allowlist=[])
    cluster = _events_cluster(7, gap_ms=12_000, rules=("r1", "r2"))
    out = explain_forwarding(cluster, prefs).to_dict()
    terms = out["routing_terms"]
    assert [t["factor"] for t in terms] == ["volume", "velocity", "diversity"]
    assert out["routing_weight_total"] == round(sum(t["weight"] for t in terms), 6)
    recomputed = sum(t["weight"] * t["value"] for t in terms) / out["routing_weight_total"]
    assert round(recomputed, 2) == out["routing_total"]


def test_asset_context_adds_its_term() -> None:
    prefs = Preferences(
        background_scan_enabled=True, auto_forward_allowlist=[],
        asset_criticality={"203.0.113.50": 80.0},
    )
    out = explain_forwarding(_events_cluster(5), prefs).to_dict()
    factors = [t["factor"] for t in out["routing_terms"]]
    assert factors[-1] == "asset_criticality"
    recomputed = sum(t["weight"] * t["value"] for t in out["routing_terms"]) / out["routing_weight_total"]
    assert round(recomputed, 2) == out["routing_total"]


def test_no_terms_when_an_earlier_gate_decided() -> None:
    out = explain_forwarding(_events_cluster(3), Preferences(background_scan_enabled=False)).to_dict()
    assert out["gate"] == "background_scan"
    assert out["routing_terms"] == [] and out["routing_weight_total"] is None


def test_a_forwarded_cluster_prints_the_score_with_decimals() -> None:
    prefs = Preferences(background_scan_enabled=True, auto_forward_allowlist=[], auto_investigate_risk_floor=10)
    cluster = _events_cluster(7, gap_ms=12_000)
    out = explain_forwarding(cluster, prefs).to_dict()
    total = out["routing_total"]
    assert out["gate"] == "forwarded"
    shown = f"{total:.2f}".rstrip("0").rstrip(".")
    assert f"routing score {shown} reaches the configured floor 10" in out["sentence"]


# --------------------------------------------------------------------------- #
# Standup: the inputs behind the risk chip, the age and the SLA overage
# --------------------------------------------------------------------------- #
NOW = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)


def _case(cid: str, *, created_minutes_ago: float, priority: str = "P3", detected_minutes_ago: float | None = None) -> Case:
    created = NOW - timedelta(minutes=created_minutes_ago)
    detected = NOW - timedelta(minutes=detected_minutes_ago) if detected_minutes_ago is not None else None
    return Case(
        case_id=cid,
        case_number=f"CASE-{cid}",
        cluster_signature=f"sig-{cid}",
        source_surface="investigate",
        title="t",
        entity=Entity(type=EntityType.IP, value="10.0.0.5"),
        status=CaseStatus.OPEN,
        risk_score=26.33,
        risk_breakdown=RiskBreakdown(volume=52.89, velocity=50.52, reputation=0.0, diversity=20.0,
                                     asset_criticality=0.0, total=26.33),
        priority_level=priority,
        created_at=created.isoformat(),
        detected_at=detected.isoformat() if detected else None,
    )


SLA = SlaPolicy(enabled=True, targets={"P3": SlaTarget(response_minutes=120, resolve_minutes=1440)})


def test_the_standup_rows_carry_their_explanation_inputs() -> None:
    cases = [_case("a", created_minutes_ago=600.25, detected_minutes_ago=610.5)]
    report = shift_report.build_shift_report(cases, [], sla=SLA, now=NOW, explain=True, needs_human_verdict=True)
    row = report["attention_queue"][0]
    assert row["risk_breakdown"]["total"] == 26.33
    assert row["age_from"] == "detected_at"
    assert row["age_from_at"] == (NOW - timedelta(minutes=610.5)).isoformat()
    assert row["age_minutes"] == 610.5
    breached = report["sla_aging"]["breached"][0]
    assert breached["elapsed_minutes"] == 610.5
    assert breached["running"] is True
    assert breached["start_at"] == (NOW - timedelta(minutes=610.5)).isoformat()
    assert round(breached["elapsed_minutes"] - breached["target_minutes"], 1) == breached["overdue_minutes"]


def test_the_standup_route_sends_the_explanation_inputs(standup_client) -> None:  # noqa: F811
    # The page's report asks for them; the model's aggregate (below) never does.
    body = standup_client.get("/api/standup/report").json()
    row = next(r for r in body["attention_queue"] if r["case_id"] == "alpha")
    assert "risk_breakdown" in row and row["age_from"] == "created_at" and row["age_from_at"]
    breached = body["sla_aging"]["breached"]
    assert breached and all("elapsed_minutes" in b and "running" in b for b in breached)


def test_the_model_aggregate_leaves_the_explanation_inputs_out() -> None:
    cases = [_case("a", created_minutes_ago=600.25)]
    report = shift_report.build_shift_report(cases, [], sla=SLA, now=NOW)
    row = report["attention_queue"][0]
    assert "risk_breakdown" not in row and "age_from_at" not in row
    breached = report["sla_aging"]["breached"][0]
    assert "elapsed_minutes" not in breached and "running" not in breached


# --------------------------------------------------------------------------- #
# Team activity: the times behind the median
# --------------------------------------------------------------------------- #
def test_the_median_run_holds_the_middle_times() -> None:
    import statistics

    from app.engine import team_activity as ta

    assert ta._median_run([720.0, 120.0]) == ([120.0, 720.0], 0)

    odd = [float(v) for v in range(1, 1002)]  # 1001 times: the median is the middle one
    run, offset = ta._median_run(odd)
    assert len(run) == ta.ACK_SAMPLE_LIMIT and run == odd[offset:offset + len(run)]
    middle = (len(odd) - 1) // 2
    assert run[middle - offset] == statistics.median(odd)

    even = [float(v) for v in range(1000, 0, -1)]  # 1000 times, unsorted: the mean of two
    run, offset = ta._median_run(even)
    lo, hi = (len(even) - 1) // 2, len(even) // 2
    assert offset <= lo and hi < offset + len(run)
    assert (run[lo - offset] + run[hi - offset]) / 2 == statistics.median(even)


def test_the_team_summary_lists_the_times_behind_its_median() -> None:
    import statistics

    from app.api.routes_team import TeamTotals
    from app.engine import team_activity as ta
    from tests.test_round15_wp3_team_activity import NOW as TEAM_NOW
    from tests.test_round15_wp3_team_activity import _case as team_case
    from tests.test_round15_wp3_team_activity import _lifecycle, _window

    opened = TEAM_NOW - timedelta(hours=5)
    acked = {
        "c1": opened + timedelta(minutes=2),
        "c2": opened + timedelta(minutes=12),
    }
    cases = {cid: team_case(cid, created=opened, acknowledged=at) for cid, at in acked.items()}
    fold = ta.TeamActivityFold(_window("today"))
    for cid, at in acked.items():
        fold.add_row(_lifecycle("nia", "acknowledge", "open", "investigating", ts=at, case_id=cid))
    fold.add_acknowledged_cases(cases)
    team = fold.result([])["team"]
    assert team["median_ack_seconds"] == 420.0
    assert team["ack_sample_seconds"] == [120.0, 720.0] and team["ack_sample_offset"] == 0
    assert statistics.median(team["ack_sample_seconds"]) == team["median_ack_seconds"]
    # The response model carries the times through to the Console (an undeclared field
    # would be dropped on the way out).
    wire = TeamTotals.model_validate(team).model_dump()
    assert wire["ack_sample_seconds"] == [120.0, 720.0] and wire["ack_sample_offset"] == 0

    unmeasured = fold.result([], ack_status="too_many_cases")["team"]
    assert unmeasured["ack_sample_seconds"] == [] and unmeasured["ack_sample_offset"] == 0


# --------------------------------------------------------------------------- #
# Agent effectiveness: definitions in plain words
# --------------------------------------------------------------------------- #
def _definition_texts(node, path: str = "") -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else str(key)
            if key == "definition":
                if isinstance(value, str):
                    out.append((here, value))
                elif isinstance(value, dict):
                    for part, text in value.items():
                        texts = text if isinstance(text, (list, tuple)) else [text]
                        out.extend((f"{here}.{part}", t) for t in texts if isinstance(t, str))
            else:
                out.extend(_definition_texts(value, here))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            out.extend(_definition_texts(value, f"{path}[{i}]"))
    return out


def test_effectiveness_definitions_use_plain_words() -> None:
    import re
    from datetime import date

    from app.engine.agent_improvement import agent_improvement_metrics

    result = agent_improvement_metrics([], as_of=date(2026, 11, 26), usage_available=True)
    texts = _definition_texts(result)
    assert texts, "the report carries its metric definitions"
    engine_word = re.compile(r"UsageDoc|\b[a-z]+_[a-z_]+\b|\b[A-Z]{3,}_[A-Z_]+\b")
    offenders = [(where, text) for where, text in texts if engine_word.search(text)]
    assert offenders == [], offenders
