"""High-fidelity five-source Demo Mode contracts and runtime cadence."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import random
import re

import pytest

from app.config import Preferences
from app.connectors.base import StructuredQuery
from app.engine import demo_generator as gen
from app.engine.demo_runtime import DemoSimulator
from app.engine.demo_sources import (
    DEMO_SOURCE_SPECS,
    NATIVE_RULE_TO_STORY,
    DemoSourceMap,
    NativeDemoSource,
)
from app.llm.providers import DemoMockProvider


TS = 1_783_785_600_000  # 2026-07-11T16:00:00.000Z
DOC_NETS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
)


def _story(story_id: str = "phishing_chain"):
    return gen._STORYLINE_BY_ID[story_id]


def test_five_source_contract_and_legacy_aliases_are_unambiguous() -> None:
    assert list(DEMO_SOURCE_SPECS) == ["splunk", "qradar", "wazuh", "syslog", "entra"]
    assert {spec.source_id for spec in DEMO_SOURCE_SPECS.values()} == {
        "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog", "demo-entra-id",
    }
    assert {spec.source_type.value for spec in DEMO_SOURCE_SPECS.values()} == {
        "splunk", "qradar", "wazuh", "syslog", "sentinel",
    }
    mapping = DemoSourceMap({
        key: NativeDemoSource(key) for key in DEMO_SOURCE_SPECS
    })
    assert list(mapping) == ["splunk", "qradar", "wazuh", "syslog", "entra"]
    assert mapping["siem"] is mapping["splunk"]
    assert mapping["xdr"] is mapping["qradar"]
    assert mapping["edr"] is mapping["wazuh"]


def test_splunk_hec_access_and_es_risk_events_use_production_parser() -> None:
    prefs = Preferences()
    source = NativeDemoSource("splunk")
    normal = source.benign_batch_raw(random.Random(4), TS, 1, prefs)[0]
    envelope = json.loads(normal.source["_demo_native"]["payload"])
    assert envelope["sourcetype"] == "access_combined"
    assert envelope["index"] == "security"
    assert isinstance(envelope["event"], str) and '"GET /api/v2/applications' in envelope["event"]
    assert envelope["fields"]["src_ip"] == normal.ip
    assert normal.timestamp_millis == TS
    assert normal.source_id == "demo-splunk" and normal.rule == "web_access"

    alert = source.storyline_raw(_story(), random.Random(5), TS + 10_000, prefs)[0]
    risk = json.loads(alert.source["_demo_native"]["payload"])
    assert risk["sourcetype"] == "stash" and risk["index"] == "risk"
    assert risk["event"]["risk_object_type"] == "user"
    assert risk["event"]["risk_score"] >= 90
    assert alert.index_role == "alerts" and alert.rule == "LP-ES-RISK-1001"
    assert alert.ip == "203.0.113.77" and alert.user == "pnair"


def test_qradar_leef_normals_and_offense_alerts_are_distinct_contracts() -> None:
    prefs = Preferences()
    source = NativeDemoSource("qradar")
    normal = source.benign_batch_raw(random.Random(6), TS, 1, prefs)[0]
    leef = normal.source["_demo_native"]["payload"]
    assert re.match(r"^<134>1 2026-07-11T16:00:00\.000Z qradar\.soc\.demo\.example ", leef)
    assert " LEEF:2.0|LumenPay|Agentic SOC Demo Sources|1.0|LP-QR-0001|^|" in leef
    assert "^devTime=2026-07-11T16:00:00.000Z^" in leef
    assert normal.ip and normal.user and normal.host and normal.rule == "LP-QR-0001"
    assert "_parse_error" not in normal.source
    # Native LEEF `sev` is a 1-10 magnitude and stays on the wire; the parallel
    # `demoSeverity` carries the same rating on the canonical 0-100 scale.
    assert "^sev=3^" in leef and "^demoSeverity=26.4^" in leef

    alert = source.storyline_raw(_story(), random.Random(7), TS + 10_000, prefs)[0]
    offense = json.loads(alert.source["_demo_native"]["payload"])
    assert isinstance(offense["offense_type"], int)
    assert offense["offense_source"] == "203.0.113.77"
    assert offense["status"] == "OPEN" and offense["magnitude"] >= 9
    assert offense["rules"][0]["type"] == "CRE_RULE"
    assert set(offense["rules"][0]) == {"id", "type"}
    assert offense["inactive"] is False and offense["protected"] is False
    assert offense["follow_up"] is True
    assert offense["source_address_ids"] and offense["local_destination_address_ids"]
    assert offense["log_sources"][0]["type_name"] == "Universal LEEF"
    assert "username" not in offense and "destination_host" not in offense
    assert alert.rule == "LP QRadar: account takeover and data access"
    assert alert.index_role == "alerts" and alert.severity >= 75
    # The headline storyline incident must never read the same as this source's own
    # benign noise — the regression that made both 10.0 (Informational).
    assert alert.severity > normal.severity

    # The native 1-10 magnitude stays on the wire exactly as an appliance sends it...
    assert offense["severity"] == 9 and offense["magnitude"] == 9
    # ...and a PARALLEL 0-100 field carries the same rating on the canonical scale, which
    # is what the receiver normalises through. The demo overlay is a read-time fixture
    # that never registers a SourceInstance (by design — see
    # ``state.demo_sources_overlay``), so it has nowhere to DECLARE a 0-10 ceiling; a
    # parallel honest field is how it normalises without one, the same way the Wazuh and
    # syslog demo fixtures already do. Without it the storyline offense would normalise
    # to 10.0 — byte-identical to this source's own benign noise.
    assert offense["_demo"]["severity"] == 91.0


def test_wazuh_archive_and_alert_json_preserve_native_rule_level() -> None:
    prefs = Preferences()
    source = NativeDemoSource("wazuh")
    normal = source.benign_batch_raw(random.Random(8), TS, 1, prefs)[0]
    archive = json.loads(normal.source["_demo_native"]["payload"])
    assert "rule" not in archive  # archives.json contains every event, not only alerts
    assert archive["agent"]["name"] == normal.host
    assert re.match(r"^2026-07-11T16:00:00\.000\+0000$", archive["timestamp"])
    assert normal.rule == "osquery_process_event" and normal.timestamp_millis == TS

    alert = source.storyline_raw(_story("ransomware_beacon"), random.Random(9), TS, prefs)[0]
    wazuh_alert = json.loads(alert.source["_demo_native"]["payload"])
    assert wazuh_alert["rule"]["id"] == "100125"
    assert 1 <= wazuh_alert["rule"]["level"] <= 16
    assert wazuh_alert["rule"]["mitre"]["id"] == ["T1071", "T1486"]
    assert wazuh_alert["rule"]["mitre"]["technique"] == [
        "Application Layer Protocol", "Data Encrypted for Impact",
    ]
    assert wazuh_alert["rule"]["mitre"]["tactic"] == [
        "Command and Control", "Impact",
    ]
    # Native level stays intact while the parallel decoded 0..100 score normalizes high.
    assert wazuh_alert["data"]["severity"] == 96.0
    assert alert.severity >= 75 and alert.index_role == "alerts"


def test_syslog_emits_both_rfc_variants_and_never_claims_native_alert() -> None:
    prefs = Preferences()
    source = NativeDemoSource("syslog")
    events = source.benign_batch_raw(random.Random(10), TS, 4, prefs)
    payloads = [event.source["_demo_native"]["payload"] for event in events]
    rfc3164 = next(payload for payload in payloads if re.match(r"^<\d+>[A-Z][a-z]{2} 11 ", payload))
    rfc5424 = next(payload for payload in payloads if re.match(r"^<\d+>1 2026-", payload))
    assert len(rfc3164.encode("utf-8")) <= 1024
    assert "sshd[" in rfc3164 and "Accepted publickey" in rfc3164
    assert "[event@32473 " in rfc5424
    assert all(event.source_id == "demo-syslog" for event in events)
    # RFC 3164 informational PRI must not be mistaken for a 6/10 threat score.
    rfc3164_event = next(
        event for event in events
        if event.source["_demo_native"]["payload"] == rfc3164
    )
    assert rfc3164_event.severity <= 25

    burst = source.storyline_raw(_story(), random.Random(11), TS + 20_000, prefs)
    assert len(burst) == 4
    assert {event.rule for event in burst} == {"AUTH-ANOMALY"}
    assert {event.index_role for event in burst} == {"events"}
    assert all(
        re.match(r"^<\d+>1 ", event.source["_demo_native"]["payload"])
        for event in burst
    )
    assert source.activity_snapshot()["alerts_total"] == 0


def test_entra_signin_and_identity_protection_alert_use_graph_fields() -> None:
    prefs = Preferences()
    source = NativeDemoSource("entra")
    normal = source.benign_batch_raw(random.Random(14), TS, 1, prefs)[0]
    signin = json.loads(normal.source["_demo_native"]["payload"])
    assert signin["createdDateTime"] == "2026-07-11T16:00:00.000Z"
    assert signin["userPrincipalName"].endswith("@lumenpay.example")
    assert signin["deviceDetail"]["trustType"] == "Microsoft Entra joined"
    assert signin["riskLevelAggregated"] == "none"
    assert normal.source_id == "demo-entra-id"
    assert normal.rule == "Entra sign-in"
    assert normal.ip == signin["ipAddress"]

    alert = source.storyline_raw(_story("impossible_travel"), random.Random(15), TS, prefs)[0]
    risky = json.loads(alert.source["_demo_native"]["payload"])
    assert risky["riskLevelAggregated"] == "high"
    assert risky["riskState"] == "atRisk"
    assert risky["_demo"]["rule_id"] == "Entra ID Protection: atypical travel sign-in"
    assert alert.index_role == "alerts"
    assert alert.rule == risky["_demo"]["rule_id"]


def test_source_health_distinguishes_static_streaming_silent_and_stopped() -> None:
    source = NativeDemoSource("splunk")
    source.prime(Preferences(), now_millis=TS, count=12)

    static = source.activity_snapshot(now_millis=TS, mode="seeded", running=False)
    assert static["healthy"] is True and static["state"] == "static"
    assert static["events_per_min"] == 0 and static["silent"] is False

    streaming = source.activity_snapshot(now_millis=TS, mode="live", running=True)
    assert streaming["healthy"] is True and streaming["state"] == "streaming"
    assert streaming["events_per_min"] > 0 and streaming["silent"] is False

    silent = source.activity_snapshot(
        now_millis=TS + 31_000, mode="live", running=True, tick_seconds=10,
    )
    assert silent["healthy"] is True and silent["state"] == "silent"
    assert silent["silent"] is True

    stopped = source.activity_snapshot(now_millis=TS, mode="live", running=False)
    assert stopped["healthy"] is False and stopped["state"] == "stopped"
    assert stopped["events_per_min"] == 0


def test_native_generation_is_seeded_and_recent_ring_is_bounded() -> None:
    prefs = Preferences()
    a = NativeDemoSource("splunk", seed=2026)
    b = NativeDemoSource("splunk", seed=2026)
    events_a = a.benign_batch_raw(random.Random(77), TS, 20, prefs)
    events_b = b.benign_batch_raw(random.Random(77), TS, 20, prefs)
    assert [event.model_dump(mode="json") for event in events_a] == [
        event.model_dump(mode="json") for event in events_b
    ]
    assert a.last_payload == b.last_payload

    # More than the 500-row bound cannot grow browse memory without limit.
    a.benign_batch_raw(random.Random(78), TS + 60_000, 520, prefs)
    snapshot = a.activity_snapshot()
    assert snapshot["buffer_depth"] == 500


@pytest.mark.asyncio
async def test_search_returns_exact_native_evidence_and_filters() -> None:
    prefs = Preferences()
    source = NativeDemoSource("qradar")
    source.benign_batch_raw(random.Random(12), TS, 8, prefs)
    result = await source.search(
        prefs, StructuredQuery(contains="LP-QR-0001", size=3, sort_desc=True)
    )
    assert result.total == 8 and len(result.events) == 3
    assert all(event.source["_demo_native"]["payload"] for event in result.events)
    assert all("LEEF:2.0" in event.source["_demo_native"]["payload"] for event in result.events)

    sample = result.events[0]
    exact = await source.search(prefs, StructuredQuery(
        ip=sample.ip, user=sample.user, host=sample.host, rule=sample.rule,
        severity_gte=max(0.0, sample.severity - 0.01), ids=[sample.id], size=10,
    ))
    assert [event.id for event in exact.events] == [sample.id]
    missing = await source.search(
        prefs, StructuredQuery(ip="203.0.113.254", size=200),
    )
    assert missing.total == 0 and missing.events == []


def test_all_native_public_indicators_are_rfc5737_and_names_are_reserved() -> None:
    prefs = Preferences()
    for source_key in DEMO_SOURCE_SPECS:
        source = NativeDemoSource(source_key)
        for story in gen.STORYLINES:
            for event in source.storyline_raw(story, random.Random(13), TS, prefs):
                if event.ip and not ipaddress.ip_address(event.ip).is_private:
                    assert any(ipaddress.ip_address(event.ip) in net for net in DOC_NETS)
    for value in (gen._C2_IP, gen._TOR_IP, gen._SQLI_IP, gen._TRAVEL_IP_A, gen._TRAVEL_IP_B):
        assert any(ipaddress.ip_address(value) in net for net in DOC_NETS)
    assert gen.build_org().domain.endswith(".example")
    assert gen._C2_DOMAIN.endswith(".example")


def test_native_provider_lookup_is_static_and_import_order_independent() -> None:
    assert NATIVE_RULE_TO_STORY == gen.NATIVE_RULE_TO_STORY
    assert all(gen._RULE_TO_STORY[rule] == story for rule, story in NATIVE_RULE_TO_STORY.items())
    for rule, story_id in NATIVE_RULE_TO_STORY.items():
        resolved = DemoMockProvider._resolve([{"role": "user", "content": f"rule={rule}"}])
        assert resolved is not None and resolved.id == story_id


@pytest.mark.asyncio
async def test_manual_incident_is_five_source_zero_network_and_cooldown_aware(
    app_state, monkeypatch,
) -> None:
    await app_state.update_prefs(app_state.prefs.model_copy(update={"setup_complete": True}))
    await app_state.enable_demo(
        mode="seeded", seed=1337, history_days=1,
        event_rate_per_second=0, tick_seconds=10,
    )
    simulator = DemoSimulator(app_state._demo, app_state.get_prefs, seed=1337)
    # Every investigation must query the adapter that produced its native record. This
    # proves the demo exercises the real structured-query/tool seam instead of merely
    # handing the mock model an already-normalised alert envelope.
    query_calls = {key: 0 for key in app_state._demo.sources}
    for key, source in app_state._demo.sources.items():
        original_search = source.search

        async def tracked_search(prefs, query, *, _key=key, _search=original_search):
            query_calls[_key] += 1
            return await _search(prefs, query)

        monkeypatch.setattr(source, "search", tracked_search)

    result = await simulator.trigger_incident("phishing_chain")
    assert result["triggered"] is True and result["events"] == 8
    assert result["native_alerts"] == 4
    assert result["system_detections"] >= 1
    assert set(result["sources"]) == {"splunk", "qradar", "wazuh", "syslog", "entra"}
    assert result["sources"]["syslog"]["native_alerts"] == 0
    assert result["sources"]["syslog"]["system_detections"] >= 1
    assert all(
        result["sources"][key]["investigated"] >= 1
        for key in ("splunk", "qradar", "wazuh", "syslog", "entra")
    )
    assert all(query_calls[key] >= 1 for key in query_calls)

    cases, _ = await app_state.cases.list(limit=300)
    incident_rules = {
        gen.NATIVE_STORY_RULE_IDS[key]["phishing_chain"]
        for key in ("splunk", "qradar", "wazuh", "syslog", "entra")
    }
    incident_cases = [case for case in cases if incident_rules.intersection(case.rule_ids)]
    assert len(incident_cases) >= 5
    for case in incident_cases:
        assert case.verdict.value == "TRUE_POSITIVE"
        assert "contain" in case.recommended_action.lower()
        assert case.evidence
        assert all("benign baseline" not in item.summary.lower() for item in case.evidence)

    again = await simulator.trigger_incident("ransomware_beacon")
    assert again["triggered"] is False and again["cooldown_seconds"] > 0
    snapshot = simulator.runtime_snapshot()
    assert len(snapshot["sources"]) == 5
    assert all(row["buffer_depth"] > 0 for row in snapshot["sources"])
    assert all(row["last_event_millis"] > 0 for row in snapshot["sources"])
    syslog = next(row for row in snapshot["sources"] if row["key"] == "syslog")
    assert syslog["system_detections_total"] >= 1


@pytest.mark.asyncio
async def test_retrying_identical_native_alert_is_idempotent(app_state) -> None:
    """At-least-once delivery may replay; the same alert must not mint a second case."""
    await app_state.update_prefs(app_state.prefs.model_copy(update={"setup_complete": True}))
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=0)
    stack = app_state._demo
    source = stack.sources["splunk"]
    prefs = stack._demo_prefs()
    story = _story("ransomware_beacon")

    first_events = source.storyline_raw(story, random.Random(99), TS, prefs)
    await stack.ingest_service.ingest(
        first_events,
        prefs,
        source_id=source.connector_id,
    )
    first_id = first_events[0].id
    cases, _ = await stack.cases.list(limit=300)
    matching = [
        case for case in cases
        if case.source_id == "demo-splunk" and "LP-ES-RISK-1005" in case.rule_ids
    ]
    assert len(matching) == 1
    first_case_id = matching[0].case_id
    first_members = list(matching[0].member_event_keys or matching[0].member_event_ids)

    retry_events = source.storyline_raw(story, random.Random(12345), TS, prefs)
    await stack.ingest_service.ingest(
        retry_events,
        prefs,
        source_id=source.connector_id,
    )
    assert retry_events[0].id == first_id
    cases_after, _ = await stack.cases.list(limit=300)
    matching_after = [
        case for case in cases_after
        if case.source_id == "demo-splunk" and "LP-ES-RISK-1005" in case.rule_ids
    ]
    assert len(matching_after) == 1
    assert matching_after[0].case_id == first_case_id
    assert list(
        matching_after[0].member_event_keys or matching_after[0].member_event_ids
    ) == first_members


@pytest.mark.asyncio
async def test_concurrent_manual_incident_requests_emit_exactly_once(app_state) -> None:
    await app_state.update_prefs(app_state.prefs.model_copy(update={"setup_complete": True}))
    await app_state.enable_demo(mode="seeded", seed=9001, history_days=0)
    simulator = DemoSimulator(app_state._demo, app_state.get_prefs, seed=9001)
    results = await asyncio.gather(
        simulator.trigger_incident("phishing_chain"),
        simulator.trigger_incident("phishing_chain"),
    )
    assert sum(bool(result["triggered"]) for result in results) == 1
    assert sum(int(result["events"]) for result in results) == 8
    assert simulator.runtime_snapshot()["first_incident_fired"] is True


@pytest.mark.asyncio
async def test_seeded_manual_incident_cooldown_expires_on_monotonic_time(app_state) -> None:
    await app_state.update_prefs(app_state.prefs.model_copy(update={"setup_complete": True}))
    await app_state.enable_demo(mode="seeded", seed=2026, history_days=0)
    clock = [100.0]
    simulator = DemoSimulator(
        app_state._demo,
        app_state.get_prefs,
        seed=2026,
        monotonic=lambda: clock[0],
    )
    first = await simulator.trigger_incident("phishing_chain")
    blocked = await simulator.trigger_incident("ransomware_beacon")
    assert first["triggered"] is True
    assert blocked["triggered"] is False and blocked["cooldown_seconds"] == 5.0

    clock[0] += 5.001
    after = await simulator.trigger_incident("ransomware_beacon")
    assert after["triggered"] is True
    assert after["scenario_id"] == "ransomware_beacon"


@pytest.mark.asyncio
async def test_first_coherent_incident_is_guaranteed_on_default_third_tick(app_state) -> None:
    await app_state.update_prefs(app_state.prefs.model_copy(update={"setup_complete": True}))
    await app_state.enable_demo(
        mode="seeded", seed=4242, history_days=0,
        event_rate_per_second=0, tick_seconds=10, alert_interval_seconds=120,
        incident_rate=0,
    )
    simulator = DemoSimulator(app_state._demo, app_state.get_prefs, seed=4242)
    first = await simulator.tick_once()
    second = await simulator.tick_once()
    third = await simulator.tick_once()
    assert first["story"] == 0 and second["story"] == 0
    assert third["story"] == 1
    assert third["alerts"] == 4 and third["system_detections"] >= 1
    assert simulator.runtime_snapshot()["first_incident_fired"] is True


@pytest.mark.asyncio
async def test_due_tick_racing_manual_trigger_emits_one_incident(app_state) -> None:
    await app_state.update_prefs(app_state.prefs.model_copy(update={"setup_complete": True}))
    await app_state.enable_demo(
        mode="seeded", seed=5150, history_days=0,
        event_rate_per_second=0, tick_seconds=10, incident_rate=0,
    )
    simulator = DemoSimulator(app_state._demo, app_state.get_prefs, seed=5150)
    simulator._logical_elapsed = 20.0  # noqa: SLF001 — put the next tick on the due edge
    before = sum(
        row["events_total"] for row in simulator.runtime_snapshot()["sources"]
    )
    tick, manual = await asyncio.gather(
        simulator.tick_once(), simulator.trigger_incident("phishing_chain"),
    )
    after = sum(
        row["events_total"] for row in simulator.runtime_snapshot()["sources"]
    )
    assert int(tick["story"]) + int(bool(manual["triggered"])) == 1
    assert after - before == 8
