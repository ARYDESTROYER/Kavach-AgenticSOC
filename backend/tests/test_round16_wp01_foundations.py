"""Round 16 WP01: the shared contracts and foundations (SPEC §4.3 WP01, §3.4).

* ``engine/risk_explain.explain_risk`` against ``engine/risk.compute_risk`` over a
  property grid: equal factors, the total re-derived from full-precision factors within
  0.005 and from the stored 2-dp factors within 0.01 (SPEC Appendix C, C23);
* ``RiskBreakdown.inputs`` bounds, and an unreadable stored record reads "not recorded"
  instead of failing the case;
* ``EventBus.publish_many``: one event, one id, one frame per subscriber, and a replay
  after a reconnect does not repeat it; ``publish_case_investigation``'s exact key set
  and topics;
* the investigation registry: lifecycle, frames, pruning of done tasks, the recent ring
  bound and TTL, the viewer-scoped requester, and errors never raised into a run;
* the What's new prefs normaliser; ``round_half_up``; ``Citation.case_number``;
* the store methods ``UsageRepository.records_for_case`` and
  ``AuditRepository.count_for_case`` on the Elasticsearch fake and on SQLite;
* the two new audit actions in the one event table.
"""

from __future__ import annotations

import asyncio
import itertools
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.audit import events
from app.config import AssetNetwork, Preferences, RiskWeights
from app.constants import ActionType, EntityType
from app.engine.investigation_registry import InvestigationRegistry
from app.engine.risk import compute_risk
from app.engine.risk_explain import explain_risk, factors_from_inputs
from app.models import (
    INVESTIGATION_VIEWER_FIELDS,
    Case,
    Citation,
    Cluster,
    Entity,
    InvestigationView,
    RiskBreakdown,
    RiskInputs,
    UsageDoc,
    UserPrefs,
)
from app.realtime import (
    CASE_INVESTIGATION_EVENT,
    CASE_INVESTIGATION_FRAME_KEYS,
    EventBus,
    publish_case_investigation,
)
from app.utils import round_half_up

BASE = 1_700_000_000_000
SCORED_AT = "2026-11-24T10:00:00+00:00"
FACTORS = ("volume", "velocity", "reputation", "diversity", "asset_criticality")


def _cluster(count: int, span_s: float, rules: int, entity: str = "10.0.4.12") -> Cluster:
    return Cluster(
        signature="sig-grid",
        entity=Entity(type=EntityType.IP, value=entity),
        group_by=EntityType.IP,
        rule_values=[f"rule-{i}" for i in range(rules)],
        count=count,
        first_seen_millis=BASE,
        last_seen_millis=BASE + int(span_s * 1000),
    )


# --------------------------------------------------------------------------- #
# explain_risk against compute_risk
# --------------------------------------------------------------------------- #
WEIGHT_SETS = (
    RiskWeights(),
    RiskWeights(volume=0, velocity=0, reputation=0, diversity=0, asset_criticality=0),
    RiskWeights(volume=0.5, velocity=0.1, reputation=0.2, diversity=0.1, asset_criticality=0.1),
    RiskWeights(volume=2, velocity=1, reputation=1, diversity=0, asset_criticality=0),
)


def test_explain_risk_reproduces_compute_risk_over_a_property_grid() -> None:
    counts = (0, 1, 2, 3, 4, 7, 10, 25, 50, 51, 80, 120)
    spans = (0.0, 0.4, 1.0, 30.0, 59.9, 120.0, 600.0, 3600.0)
    reputations = (-5.0, 0.0, 37.5, 75.0, 100.0, 140.0)
    rule_counts = (0, 1, 3, 5, 7)
    checked = 0
    for weights in WEIGHT_SETS:
        prefs = Preferences()
        prefs.risk_weights = weights
        prefs.asset_criticality = {"10.0.4.12": 60.0}
        for count, span, reputation, rules in itertools.product(counts, spans, reputations, rule_counts):
            cluster = _cluster(count, span, rules)
            stored = compute_risk(cluster, prefs, reputation)
            inputs = explain_risk(
                cluster, prefs, reputation, reputation_source="enrichment", scored_at=SCORED_AT,
            )
            full = factors_from_inputs(inputs)
            for name in FACTORS:
                assert round(full[name], 2) == getattr(stored, name), (name, count, span, reputation, rules)
            assert abs(full["total"] - stored.total) <= 0.005 + 1e-9
            # From the stored 2-dp factors and the recorded weights: within 0.01.
            w = inputs.weights
            denominator = 1.0 if inputs.zero_weight_fallback else inputs.total_weight
            from_stored = sum(getattr(w, name) * getattr(stored, name) for name in FACTORS) / denominator
            assert abs(from_stored - stored.total) <= 0.01 + 1e-9
            assert inputs.event_count == count
            assert inputs.rule_type_count == len(cluster.rule_values)
            assert inputs.velocity_rule == ("rate" if count >= 3 else "below_min_events")
            assert (inputs.rate_per_minute is None) == (count < 3)
            checked += 1
    assert checked == len(WEIGHT_SETS) * 12 * 8 * 6 * 5


def test_explain_risk_records_the_asset_match_and_never_the_range() -> None:
    prefs = Preferences()
    prefs.asset_networks = [AssetNetwork(cidr="10.0.4.0/24", criticality=80)]
    prefs.asset_criticality = {"host-a": 40.0}
    network = explain_risk(_cluster(5, 60, 1), prefs, 0.0, reputation_source="enrichment", scored_at=SCORED_AT)
    assert (network.asset_match, network.asset_value) == ("network", 80.0)
    exact = explain_risk(_cluster(5, 60, 1, entity="host-a"), prefs, 0.0,
                         reputation_source="not_ip_entity", scored_at=SCORED_AT)
    assert (exact.asset_match, exact.asset_value) == ("exact", 40.0)
    none = explain_risk(_cluster(5, 60, 1, entity="192.0.2.9"), prefs, 0.0,
                        reputation_source="not_looked_up", scored_at=SCORED_AT)
    assert (none.asset_match, none.asset_value) == ("none", 0.0)
    assert "10.0.4.0/24" not in network.model_dump_json()
    # A caller's unknown source is recorded honestly, never raised into a run.
    odd = explain_risk(_cluster(5, 60, 1), prefs, float("nan"), reputation_source="guess", scored_at=SCORED_AT)
    assert (odd.reputation_source, odd.reputation_input) == ("not_looked_up", 100.0)
    assert compute_risk(_cluster(5, 60, 1), prefs, float("nan")).reputation == 100.0
    assert "cidr" not in RiskInputs.model_fields and "asset_cidr" not in RiskInputs.model_fields


@pytest.mark.parametrize("raw", [float("nan"), float("inf"), float("-inf"), 150.0, -20.0])
def test_a_non_finite_or_out_of_range_asset_value_records_the_factor_the_score_used(raw: float) -> None:
    """``Preferences.asset_criticality`` accepts any float, NaN and infinity included
    (a JSON body may carry ``NaN`` or ``Infinity``). ``compute_risk`` clamps it, so NaN
    and +infinity score asset criticality 100. The recorded input must re-derive that
    same factor and total, never a 0 that the score did not use."""
    prefs = Preferences()
    prefs.asset_criticality = {"10.0.4.12": raw}
    cluster = _cluster(10, 60, 2)
    stored = compute_risk(cluster, prefs, 50.0)
    inputs = explain_risk(cluster, prefs, 50.0, reputation_source="enrichment", scored_at=SCORED_AT)
    full = factors_from_inputs(inputs)
    assert round(full["asset_criticality"], 2) == stored.asset_criticality
    assert abs(full["total"] - stored.total) <= 0.005 + 1e-9
    # The record stays valid JSON that loads back with the same inputs.
    again = RiskBreakdown.model_validate({**stored.model_dump(), "inputs": inputs.model_dump(mode="json")})
    assert again.inputs == inputs


def test_risk_inputs_record_at_most_50_distinct_rule_values_but_count_them_all() -> None:
    cluster = _cluster(10, 60, 0)
    cluster.rule_values = [f"r{i}" for i in range(70)] + ["x" * 400]
    inputs = explain_risk(cluster, Preferences(), 0.0, reputation_source="enrichment", scored_at=SCORED_AT)
    assert len(inputs.rule_values) == 50
    assert inputs.rule_type_count == 71
    long = RiskInputs(rule_values=["y" * 400, "y" * 400, 7])
    assert long.rule_values == ["y" * 256]


def test_a_breakdown_without_inputs_or_with_an_unreadable_record_reads_not_recorded() -> None:
    assert RiskBreakdown.model_validate({"total": 50.0}).inputs is None
    broken = {"total": 50.0, "inputs": {"velocity_rule": "sideways", "event_count": "many"}}
    assert RiskBreakdown.model_validate(broken).inputs is None
    assert RiskBreakdown.model_validate({"total": 50.0, "inputs": "nope"}).inputs is None
    cluster = _cluster(40, 120, 3)
    rb = compute_risk(cluster, Preferences(), 75.0)
    rb.inputs = explain_risk(cluster, Preferences(), 75.0, reputation_source="enrichment", scored_at=SCORED_AT)
    case = Case(case_id="case-x", cluster_signature="sig", source_surface="automated_scan",
                entity=cluster.entity, risk_breakdown=rb)
    again = Case.model_validate(case.model_dump(mode="json"))
    assert again.risk_breakdown.inputs == rb.inputs
    # A legacy breakdown dump is unchanged apart from the null ``inputs``.
    assert compute_risk(cluster, Preferences(), 75.0).model_dump(exclude={"inputs"}) == {
        "volume": 94.45, "velocity": 100.0, "reputation": 75.0, "diversity": 60.0,
        "asset_criticality": 0.0, "total": 75.11,
    }


def test_unrecorded_fields_keep_the_earlier_stored_shape() -> None:
    """A breakdown without inputs and a ledger row without rates serialise exactly as
    before Round 16 (no null keys), so a reader that walks the factor map (the
    Investigate page's factor bars) never meets a new key until a value exists."""
    assert set(RiskBreakdown(total=12.0).model_dump(mode="json")) == set(FACTORS) | {"total"}
    assert "inputs" in RiskBreakdown(inputs=RiskInputs()).model_dump(mode="json")
    legacy = UsageDoc(model="gpt-4o").model_dump(mode="json")
    assert not {"price_basis", "input_rate_per_million", "cache_write_ttl"} & set(legacy)
    rated = UsageDoc(model="gpt-4o", price_basis="overlay", input_rate_per_million=3.0).model_dump(mode="json")
    assert (rated["price_basis"], rated["input_rate_per_million"]) == ("overlay", 3.0)
    assert "output_rate_per_million" not in rated
    assert UsageDoc.model_validate(rated).price_basis == "overlay"


def test_round_half_up() -> None:
    assert [round_half_up(v) for v in (80.5, 73.5, 73.6, 47.5, 21.5, 0.49, 0.0)] == [81, 74, 74, 48, 22, 0, 0]


# --------------------------------------------------------------------------- #
# EventBus.publish_many and the investigation frame
# --------------------------------------------------------------------------- #
async def _collect(gen: Any, n: int, timeout: float = 1.0) -> list[str]:
    out: list[str] = []

    async def run() -> None:
        async for chunk in gen:
            text = chunk.decode("utf-8")
            if text.startswith(":"):
                continue
            out.append(text)
            if len(out) >= n:
                break

    try:
        await asyncio.wait_for(run(), timeout)
    except asyncio.TimeoutError:
        pass
    return out


def _ids(frames: list[str]) -> list[str]:
    return [line.split(": ", 1)[1] for f in frames for line in f.splitlines() if line.startswith("id: ")]


async def test_publish_many_delivers_one_frame_with_one_id_to_a_subscriber_on_all_topics() -> None:
    bus = EventBus(heartbeat_seconds=60)
    topics = ["cases", "cases:case-1", "investigations"]
    gen = bus.subscribe(topics, user=None)
    first = await gen.__anext__()  # ": connected"
    assert first.startswith(b":")
    event_id = bus.publish_many(topics, "case.investigation", {"run_id": "inv-1"})
    bus.publish("cases", "case.changed", {"case_id": "case-1"})
    frames = await _collect(gen, 2, timeout=0.5)
    await gen.aclose()
    assert [f.split("\n", 2)[1] for f in frames] == ["event: case.investigation", "event: case.changed"]
    assert _ids(frames)[0] == event_id
    # A subscriber on one of the topics receives it too, once.
    solo = bus.subscribe(["cases:case-1"], user=None)
    await solo.__anext__()
    bus.publish_many(["cases", "cases:case-1"], "case.review", {"case_id": "case-1"})
    got = await _collect(solo, 2, timeout=0.3)
    await solo.aclose()
    assert len(got) == 1


async def test_a_replay_after_a_reconnect_does_not_repeat_a_frame_published_on_several_topics() -> None:
    bus = EventBus(heartbeat_seconds=60)
    topics = ["cases", "cases:case-1"]
    first = bus.publish("cases", "case.changed", {"case_id": "case-0"})
    shared = bus.publish_many(topics, "case.review", {"case_id": "case-1"})
    replayed = bus.replay(frozenset(topics), None, first)
    assert [e.id for e in replayed] == [shared]
    gen = bus.subscribe(topics, user=None, last_event_id=first)
    await gen.__anext__()
    frames = await _collect(gen, 2, timeout=0.3)
    await gen.aclose()
    assert _ids(frames) == [shared]
    # ``retain=False`` keeps it out of every ring; an empty topic list publishes nothing.
    hidden = bus.publish_many(topics, "case.investigation", {"run_id": "inv-2"}, retain=False)
    assert hidden is not None and bus.replay(frozenset(topics), None, shared) == []
    assert bus.publish_many([], "case.investigation", {}) is None


async def test_publish_case_investigation_sends_exactly_the_frame_keys_on_three_topics() -> None:
    bus = EventBus(heartbeat_seconds=60)
    sent: list[tuple[tuple[str, ...], str, dict[str, Any], bool]] = []
    original = bus.publish_many

    def record(topics: Any, event_type: str, data: Any, **kw: Any) -> Any:
        sent.append((tuple(topics), event_type, data, kw.get("retain", True)))
        return original(topics, event_type, data, **kw)

    bus.publish_many = record  # type: ignore[method-assign]
    view = InvestigationView(run_id="inv-1", case_id="case-7", state="running", phase="evidence",
                             trigger="manual", queued_at=SCORED_AT, requested_by_you=True,
                             requested_by="alice")
    assert publish_case_investigation(bus, view, active=2, new_runs=1) is not None
    ((topics, event_type, payload, retain),) = sent
    assert topics == ("cases", "cases:case-7", "investigations")
    assert event_type == CASE_INVESTIGATION_EVENT == "case.investigation"
    assert retain is False
    assert tuple(payload) == CASE_INVESTIGATION_FRAME_KEYS
    # The SPEC's literal list (§4.5 WP08 "The frame"), so the constant and the model
    # cannot drift together away from the contract.
    assert set(payload) == {
        "run_id", "case_id", "state", "phase", "trigger", "queued_at", "started_at",
        "deadline_at", "time_cap_seconds", "finished_at", "outcome", "status_after",
        "verdict_after", "active", "new_runs",
    }
    assert not INVESTIGATION_VIEWER_FIELDS & set(payload)
    assert "alice" not in str(payload)
    assert (payload["active"], payload["new_runs"]) == (2, 1)
    # The frame keys are the view's fields without the viewer fields, plus two counts.
    assert set(CASE_INVESTIGATION_FRAME_KEYS) == (
        set(InvestigationView.model_fields) - INVESTIGATION_VIEWER_FIELDS
    ) | {"active", "new_runs"}
    sent.clear()
    publish_case_investigation(bus, InvestigationView(run_id="inv-2", queued_at=SCORED_AT),
                               active=1, new_runs=1)
    assert sent[0][0] == ("cases", "investigations")


def test_publish_case_investigation_never_raises() -> None:
    class Broken:
        def publish_many(self, *_a: Any, **_k: Any) -> Any:
            raise RuntimeError("down")

    assert publish_case_investigation(Broken(), {"run_id": "x"}, active=0, new_runs=0) is None  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# The investigation registry
# --------------------------------------------------------------------------- #
class _Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now


class _Bus:
    def __init__(self) -> None:
        self.frames: list[tuple[tuple[str, ...], dict[str, Any]]] = []

    def publish_many(self, topics: Any, event_type: str, data: Any, **_kw: Any) -> str:
        assert event_type == "case.investigation"
        self.frames.append((tuple(topics), dict(data)))
        return str(len(self.frames))


def _registry(**kw: Any) -> tuple[InvestigationRegistry, _Bus, _Clock, list[Any]]:
    bus, clock, finished = _Bus(), _Clock(), []
    reg = InvestigationRegistry(lambda: bus, on_finished=finished.append, clock=clock, **kw)
    return reg, bus, clock, finished


def test_a_run_goes_from_queued_to_running_to_finished_with_three_frames() -> None:
    reg, bus, clock, finished = _registry()
    handle = reg.begin(run_id="inv-1", signature="sig-a", trigger="manual", requested_by="Alice")
    assert handle is not None and bus.frames == []  # no queued frame unless the gate is full
    reg.started(handle, time_cap_seconds=600)
    assert handle.state == "running" and handle.deadline_at == clock.now + timedelta(seconds=600)
    reg.phase(handle, "router")
    assert handle.phase == "triage"
    reg.phase(handle, "persona")
    reg.phase(handle, "not-a-step")
    assert handle.phase == "specialist"
    assert reg.new_runs() == 1 and reg.for_case("case-1") is None
    assert reg.for_signature("sig-a") is handle
    reg.attach_case(handle, "case-1")
    reg.attach_case(handle, "case-1")  # the same case again: no frame
    assert reg.for_case("case-1") is handle and reg.new_runs() == 0
    clock.now += timedelta(seconds=30)
    reg.end(handle, outcome="decided", status="needs_human", verdict="NEEDS_HUMAN")
    reg.end(handle, outcome="failed")  # a second end is a no-op
    states = [(f["state"], f["case_id"], f["active"], f["new_runs"]) for _t, f in bus.frames]
    assert states == [("running", None, 1, 1), ("running", "case-1", 1, 0), ("finished", "case-1", 0, 0)]
    assert [t for t, _f in bus.frames] == [
        ("cases", "investigations"),
        ("cases", "cases:case-1", "investigations"),
        ("cases", "cases:case-1", "investigations"),
    ]
    last = bus.frames[-1][1]
    assert (last["outcome"], last["status_after"], last["verdict_after"]) == ("decided", "needs_human", "NEEDS_HUMAN")
    assert finished == [handle] and reg.active() == [] and reg.recent() == [handle]
    for _topics, frame in bus.frames:
        assert tuple(frame) == CASE_INVESTIGATION_FRAME_KEYS and "Alice" not in str(frame)


def test_a_queued_frame_only_when_announced_and_unknown_values_are_normalised() -> None:
    reg, bus, _clock, _finished = _registry()
    handle = reg.begin(run_id="inv-q", signature="s", case_id="case-9", trigger="weird", announce_queued=True)
    assert handle is not None and handle.trigger == "automatic"
    assert [(f["state"], f["phase"]) for _t, f in bus.frames] == [("queued", "queued")]
    reg.end(handle, outcome="exploded")
    assert handle.outcome == "failed"


def test_the_requester_is_named_only_to_a_permitted_viewer() -> None:
    reg, _bus, _clock, _finished = _registry()
    handle = reg.begin(run_id="inv-1", signature="s", case_id="case-1", trigger="manual", requested_by="Alice")
    assert handle is not None
    mine = handle.view(viewer=" alice ")
    assert (mine.requested_by_you, mine.requested_by) == (True, None)
    other = handle.view(viewer="bob")
    assert (other.requested_by_you, other.requested_by) == (False, None)
    manager = handle.view(viewer="carol", show_requester=True)
    assert (manager.requested_by_you, manager.requested_by) == (False, "Alice")
    automatic = reg.begin(run_id="inv-2", signature="s2", case_id="case-2")
    assert automatic is not None and automatic.view(viewer="", show_requester=True).requested_by is None
    snap = reg.snapshot(case_id="case-1", viewer="alice", slots_in_use=1, slots_cap=3)
    assert [v.run_id for v in snap.items] == ["inv-1"] and snap.items[0].requested_by_you is True
    assert snap.slots.model_dump() == {"in_use": 1, "cap": 3} and snap.process_local is True
    assert [v.run_id for v in reg.snapshot().items] == ["inv-1", "inv-2"]


async def test_active_drops_a_handle_whose_task_ended_without_end() -> None:
    reg, bus, _clock, _finished = _registry()

    async def run() -> None:
        reg.begin(run_id="inv-leak", signature="s", case_id="case-1")

    await asyncio.create_task(run())
    assert reg.active() == [] and bus.frames == []
    assert reg.for_case("case-1") is None


def test_the_recent_ring_is_bounded_and_expires() -> None:
    reg, _bus, clock, _finished = _registry(recent_max=3, recent_ttl_s=120)
    for i in range(5):
        handle = reg.begin(run_id=f"inv-{i}", signature="s", case_id=f"case-{i}")
        reg.end(handle, outcome="unchanged")
        clock.now += timedelta(seconds=10)
    assert [h.run_id for h in reg.recent()] == ["inv-2", "inv-3", "inv-4"]
    clock.now += timedelta(seconds=101)  # inv-3 finished 121 s ago, inv-4 111 s ago
    assert [h.run_id for h in reg.recent()] == ["inv-4"]
    reg.clear()
    assert reg.recent() == [] and reg.active() == []


def test_the_registry_never_raises_into_a_run() -> None:
    def broken_bus() -> Any:
        raise RuntimeError("no bus")

    def broken_hook(_handle: Any) -> None:
        raise RuntimeError("hook down")

    reg = InvestigationRegistry(broken_bus, on_finished=broken_hook)
    handle = reg.begin(run_id="inv-1", signature="s", announce_queued=True)
    reg.started(handle, time_cap_seconds="not a number")  # type: ignore[arg-type]
    reg.attach_case(handle, "case-1")
    reg.phase(handle, None)
    reg.end(handle, outcome="cancelled")
    assert handle is not None and handle.outcome == "cancelled"
    reg.started(None, time_cap_seconds=1)
    reg.attach_case(None, "x")
    reg.phase(None, "x")
    reg.end(None, outcome="decided")
    assert reg.for_case(None) is None and reg.for_signature("") is None


# --------------------------------------------------------------------------- #
# Prefs, citations, audit table
# --------------------------------------------------------------------------- #
def test_the_whats_new_keys_are_normalised_on_load_never_coerced() -> None:
    good = UserPrefs(misc={"whats_new_seen": "0.2.0.case-manager", "whats_new_auto": False, "density": "compact"})
    assert good.misc == {"whats_new_seen": "0.2.0.case-manager", "whats_new_auto": False, "density": "compact"}
    assert (good.whats_new_seen, good.whats_new_auto) == ("0.2.0.case-manager", False)
    bad = UserPrefs(misc={"whats_new_seen": "Bad Id!", "whats_new_auto": "false"})
    assert bad.misc == {} and bad.whats_new_seen is None and bad.whats_new_auto is True
    assert UserPrefs(misc={"whats_new_seen": 7}).misc == {}
    assert UserPrefs().whats_new_auto is True and UserPrefs().whats_new_seen is None
    assert UserPrefs(misc={"whats_new_seen": " 0.2.0.a"}).misc == {}  # never trimmed into shape


def test_a_case_citation_carries_its_display_number_as_text() -> None:
    cited = Citation(id="C1", kind="case", title="Login burst", case_id="case-1",
                     case_number="CASE-000043\u200b\n")
    assert cited.case_number == "CASE-000043"
    assert Citation(id="C1", kind="case", title="t", case_id="case-1").case_number is None
    assert Citation(id="C1", kind="case", title="t", case_id="case-1", case_number=12).case_number is None
    long = Citation(id="C1", kind="case", title="t", case_id="case-1", case_number="N" * 900)
    assert long.case_number is not None and len(long.case_number) <= 200


@pytest.mark.parametrize(("action", "label"), [
    ("case.close_replaced", "Close replaced by an AI investigation"),
    ("case.events_viewed", "Case events viewed"),
])
def test_the_new_audit_actions_are_case_work(action: str, label: str) -> None:
    info = events.classify({"action": action, "action_type": "status"})
    assert (info.category, info.label) == ("case_work", label)


# --------------------------------------------------------------------------- #
# Store methods (Elasticsearch fake and SQLite)
# --------------------------------------------------------------------------- #
def _usage(case_id: str | None, minute: int, role: str = "investigator", surface: str = "investigate") -> UsageDoc:
    ts = (datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc) + timedelta(minutes=minute)).isoformat()
    return UsageDoc(ts=ts, case_id=case_id, role=role, surface=surface, model="gpt-4o", cost=0.01 * (minute + 1),
                    input_rate_per_million=2.5, output_rate_per_million=10.0, price_basis="catalog")


async def _fill_usage(store: Any) -> None:
    for minute in range(4):
        await store.write_strict(_usage("case-a", minute))
    await store.write_strict(_usage("case-a", 9, role="chat", surface="chat"))
    await store.write_strict(_usage("case-ab", 5))
    await store.write_strict(_usage(None, 6))


async def _check_usage(store: Any) -> None:
    rows = await store.records_for_case("case-a")
    assert [r["ts"][11:16] for r in rows] == ["10:09", "10:03", "10:02", "10:01", "10:00"]
    assert {r["case_id"] for r in rows} == {"case-a"}
    assert rows[0]["role"] == "chat" and rows[1]["price_basis"] == "catalog"
    assert rows[1]["input_rate_per_million"] == 2.5
    assert len(await store.records_for_case("case-a", limit=2)) == 2
    assert await store.records_for_case("case-none") == []
    assert await store.records_for_case("") == []


async def _fill_audit(store: Any) -> None:
    for i in range(5):
        await store.record_strict(action_type=ActionType.TOOL_CALL, surface="investigate", actor="investigator",
                                  case_id="case-a", result_summary=f"step {i}")
    await store.record_strict(action_type=ActionType.TOOL_CALL, surface="investigate", actor="investigator",
                              case_id="case-ab", result_summary="other")


async def _check_audit(store: Any) -> None:
    assert await store.count_for_case("case-a", cap=100) == (5, "eq")
    assert await store.count_for_case("case-a", cap=3) == (3, "gte")
    assert await store.count_for_case("case-none", cap=10) == (0, "eq")
    assert await store.count_for_case("", cap=10) == (0, "eq")


async def test_the_store_methods_on_the_elasticsearch_fake() -> None:
    from app.audit.audit_log import AuditLogger
    from app.es.fake import InMemoryESClient
    from app.es.indices import bootstrap_indices
    from app.stores.usage import UsageStore

    es = InMemoryESClient()
    await bootstrap_indices(es)
    usage = UsageStore(es)
    await _fill_usage(usage)
    await _check_usage(usage)
    audit = AuditLogger(es)
    await _fill_audit(audit)
    await _check_audit(audit)


async def test_the_store_methods_on_sqlite() -> None:
    from app.stores.sql import SqlAuditRepository, SqlUsageRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        usage = SqlUsageRepository(engine)
        await _fill_usage(usage)
        await _check_usage(usage)
        audit = SqlAuditRepository(engine)
        await _fill_audit(audit)
        await _check_audit(audit)
    finally:
        await engine.dispose()


async def test_a_third_party_usage_store_must_opt_into_per_case_reads() -> None:
    from app.stores.base import UsageRepository

    class Legacy(UsageRepository):
        async def write(self, doc: UsageDoc) -> None:
            return None

        async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
            return {}

    with pytest.raises(NotImplementedError):
        await Legacy().records_for_case("case-a")
