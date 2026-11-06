"""Seeded Demo cases carry rules their Demo sources raise, and those sources hold the
cases' own rows (Round 14 FX3b2, SPEC §3.5, §4.6.2).

Seeded cases are saved straight to the Demo store. They used to carry Demo-only rule
names (``demo_phishing_chain``, ``identity_signin``) that no Demo log row ever
carried, so a seeded case's rule sheet showed no alerts. Now:

* each seeded case's rule is the value its Demo source raises for the case's
  detection (a storyline's source-native rule, a low-confidence native alert, or
  routine telemetry), and its title names that rule as the pipeline's titles do;
* each Demo source keeps the seeded cases' own rows (one per member event, dated
  inside the case's window, carrying the case's entity and one internal address and
  host per case) beside its live ring: Logs and the rule sheet read them, the
  pipeline never polls them and source health ignores them;
* a person's case on Entra ID names the person by the user principal name Entra's
  sign-in records carry, so a read filtered on any seeded case's entity finds its
  rows (Logs, the runbook lookups, a chat hunt);
* a template that lists its fitting sources takes each of them in turn, and the
  capability seed's HITL pair carries its sources' impossible-travel rule;
* through ``GET /api/rules/summary`` (the rule sheet's own read), every seeded case's
  first rule has at least one alert inside the case's window.

Offline and deterministic.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes_rule_summary
from app.api.routes import router as monolith_router
from app.api.routes_rule_summary import router as summary_router
from app.config import Preferences
from app.connectors.base import StructuredQuery
from app.engine import demo_generator as gen
from app.engine import demo_sources as DS
from app.engine import runbook_runs
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Cursor, RuleSummary
from app.state import AppState

SEED = 1337
NOW = 1_761_700_000_000  # 2025-10-29T01:06:40Z, a fixed clock for the pure checks
KEY_BY_SOURCE = {spec.source_id: key for key, spec in DS.DEMO_SOURCE_SPECS.items()}


def _seeded(history_days: int = 60, *, hitl: bool = False) -> list[Case]:
    org = gen.build_org(SEED)
    cases = gen.generate_historical_cases(SEED, org, history_days=history_days, run_id="run", now_millis=NOW)
    recent, _hits = gen.generate_recent_preseed(SEED, org, run_id="run", now_millis=NOW)
    pair = gen.generate_capability_seed_cases(SEED, org, run_id="run", now_millis=NOW)[0] if hitl else []
    return [*cases, *recent, *pair]


def _iso_second(millis: int, *, up: bool = False) -> str:
    moment = datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc).replace(microsecond=0)
    if up:
        moment += timedelta(seconds=1)
    return moment.isoformat()


def _created_ms(case: Case) -> int:
    return int(datetime.fromisoformat(case.created_at).timestamp() * 1000)


# --------------------------------------------------------------------------- #
# The rules (pure)
# --------------------------------------------------------------------------- #
def test_every_seeded_rule_is_one_its_source_raises() -> None:
    cases = _seeded(hitl=True)
    assert cases
    for case in cases:
        key = KEY_BY_SOURCE[case.source_id]
        assert len(case.rule_ids) == 1
        rule = case.rule_ids[0]
        assert DS.describe_seeded_rule(key, rule) is not None, (case.case_id, case.source_id, rule)
        assert not rule.startswith("demo_"), rule
        # The pipeline's machine title: "<entity type>:<value> · <rules>".
        assert case.title == f"{case.entity.type.value}:{case.entity.value} · {rule}"


def test_storyline_cases_carry_the_storylines_source_native_rule() -> None:
    by_name = {c.summary.split(" (")[0]: c for c in _seeded(history_days=1)}
    phishing = next(c for c in _seeded(history_days=1)
                    if c.case_id.startswith("demo-recent-") and "Phishing" in c.summary)
    assert phishing.rule_ids == [gen.NATIVE_STORY_RULE_IDS[KEY_BY_SOURCE[phishing.source_id]]["phishing_chain"]]
    rdp = by_name["RDP brute-force attempt"]
    assert rdp.rule_ids == [gen.NATIVE_STORY_RULE_IDS[KEY_BY_SOURCE[rdp.source_id]]["rdp_bruteforce"]]
    # Every storyline rule still resolves to its storyline (the Demo model's verdicts).
    for case in _seeded():
        kind, _name, story = DS.describe_seeded_rule(KEY_BY_SOURCE[case.source_id], case.rule_ids[0])
        if kind == DS.SEEDED_SIGNAL_STORY:
            assert gen.resolve_story_verdict(case.rule_ids)[3] == story


def test_seeded_case_sources_still_cover_every_demo_source() -> None:
    assert {c.source_id for c in _seeded(history_days=1)} == set(gen.DEMO_SOURCE_IDS)
    assert {c.source_id for c in _seeded()} == set(gen.DEMO_SOURCE_IDS)


def test_a_template_takes_each_of_its_sources_in_turn() -> None:
    """FX3b2 review: a template's ``sources`` rotate on its own ordinal, never on the
    case's place in the spread, which pinned a template whose position shares a factor
    with the length of its ``sources`` to some of them forever (the borrower-portal
    template only ever reached Entra)."""
    spread = gen.generate_historical_cases(SEED, gen.build_org(SEED), history_days=60, run_id="run",
                                           now_millis=NOW)
    for position, tmpl in enumerate(gen._HIST_TEMPLATES):  # noqa: SLF001
        mine = spread[position::len(gen._HIST_TEMPLATES)]  # noqa: SLF001
        assert mine and all(c.summary.startswith(tmpl["rname"]) for c in mine)
        reached = {KEY_BY_SOURCE[c.source_id] for c in mine}
        expected = set(tmpl.get("sources") or DS.DEMO_SOURCE_SPECS)
        assert reached == expected, (tmpl["rname"], reached, expected)
    # The ordinal drives it: the first case of a template takes its first source.
    tmpl = next(t for t in gen._HIST_TEMPLATES if len(t.get("sources") or ()) > 1)  # noqa: SLF001
    for ordinal, key in enumerate(tmpl["sources"]):
        got_key, source_id, _rule = gen.seeded_case_detection(tmpl, 7, ordinal=ordinal)
        assert got_key == key and source_id == DS.DEMO_SOURCE_SPECS[key].source_id


def test_a_person_on_entra_is_named_by_the_user_principal_name() -> None:
    """Entra ID's sign-in records name a person by the user principal name, and the
    Entra receiver maps that field to the user, so a live Entra case for a person
    carries it. A seeded Entra case does too; every other source keeps the account
    name (FX3b2 review)."""
    cases = [c for c in _seeded(hitl=True) if c.entity.type.value == "user"]
    entra = [c for c in cases if c.source_id == "demo-entra-id"]
    others = [c for c in cases if c.source_id != "demo-entra-id"]
    assert entra and others
    assert all(c.entity.value.endswith("@lumenpay.example") for c in entra), [c.entity.value for c in entra]
    assert all("@" not in c.entity.value for c in others), [c.entity.value for c in others]
    for case in entra:
        assert case.title.startswith(f"user:{case.entity.value} · ")
    assert DS.source_user_name("entra", "dsingh") == "dsingh@lumenpay.example"
    assert DS.source_user_name("entra", "dsingh@lumenpay.example") == "dsingh@lumenpay.example"
    assert DS.source_user_name("splunk", "dsingh") == "dsingh"


def test_the_hitl_pair_carries_its_sources_impossible_travel_rule() -> None:
    """The capability seed's HITL pair (two open NEEDS_HUMAN cases on user pnair, the
    most visible open Demo cases) carries the impossible-travel rule each one's source
    raises, never the Demo-only ``demo_impossible_travel`` that no Demo row carries."""
    hitl, tuner = gen.generate_capability_seed_cases(SEED, gen.build_org(SEED), run_id="run", now_millis=NOW)
    assert len(hitl) == 2
    for case in hitl:
        key = KEY_BY_SOURCE[case.source_id]
        assert case.rule_ids == [gen.NATIVE_STORY_RULE_IDS[key]["impossible_travel"]]
        assert case.entity.value == "pnair" and case.title == f"user:pnair · {case.rule_ids[0]}"
    assert len({c.source_id for c in hitl}) == 2 and len({c.title for c in hitl}) == 2
    # Both still resolve to the impossible-travel storyline (the mock model's verdicts).
    assert all(gen.resolve_story_verdict(c.rule_ids)[3] == "impossible_travel" for c in hitl)
    # The tuner's rule stays unique to its noise, so its observation is unchanged.
    assert {r for c in tuner for r in c.rule_ids} == {gen.DEMO_TUNER_RULE}
    assert gen.DEMO_TUNER_RULE not in {r for c in hitl for r in c.rule_ids}


def test_a_template_never_asks_a_source_for_a_signal_it_cannot_raise() -> None:
    templates = [*gen._HIST_TEMPLATES, *(t for t, _status in gen._PRESEED_TEMPLATES)]  # noqa: SLF001
    for tmpl in templates:
        keys = tmpl.get("sources") or tuple(DS.DEMO_SOURCE_SPECS)
        for key in keys:
            rule, name = DS.seeded_detection_rule(tmpl["signal"], key, tmpl.get("story"))
            assert rule and name
    with pytest.raises(ValueError):
        DS.seeded_detection_rule(DS.SEEDED_SIGNAL_ALERT, "syslog")
    with pytest.raises(ValueError):
        DS.seeded_detection_rule(DS.SEEDED_SIGNAL_STORY, "splunk", "no_such_story")


def test_each_seeded_case_is_matched_to_the_runbook_its_rule_maps_to() -> None:
    """The runbook automatic attachment picks for each seeded case, through the Demo
    overlay (``demo_runtime.overlay_demo_runbooks``), as the Demo pipeline does: a
    storyline case its storyline's runbook (``DEMO_STORY_RUNBOOKS``), a native alert
    the runbook the overlay maps that alert to, and routine telemetry the runbook the
    overlay maps its rule to, else the generic incident runbook (FX3b2 review: the
    rule ids each template carries decide this, so it is pinned here)."""
    from types import SimpleNamespace

    from app.agents.pipeline import builtin_runbook_catalog
    from app.engine.demo_runtime import DEMO_STORY_RUNBOOKS, demo_rule_runbooks, overlay_demo_runbooks
    from app.engine.runbook_runs import case_facts, plan_attachment

    prefs = Preferences()
    view = SimpleNamespace(matchable=tuple(overlay_demo_runbooks(builtin_runbook_catalog())))
    mapped = demo_rule_runbooks()
    picked: dict[str, set[str]] = {}
    for case in _seeded(hitl=True):
        plan = plan_attachment(case_facts(case, prefs), view, (), fallback=True)
        assert plan is not None, case.case_id
        kind, _name, story = DS.describe_seeded_rule(KEY_BY_SOURCE[case.source_id], case.rule_ids[0])
        if kind == DS.SEEDED_SIGNAL_STORY:
            expected = DEMO_STORY_RUNBOOKS[story]
        elif kind == DS.SEEDED_SIGNAL_ALERT:
            expected = mapped[case.rule_ids[0]]
        else:
            expected = mapped.get(case.rule_ids[0], "generic-incident")
        assert plan.entry.id == expected, (case.case_id, case.rule_ids, plan.entry.id, expected)
        picked.setdefault(case.summary.split(" (")[0], set()).add(plan.entry.id)
    # A template's cases agree, whichever source raised them.
    assert all(len(ids) == 1 for ids in picked.values()), picked


def test_member_event_ids_are_unique_across_the_whole_seed() -> None:
    """The historical spread and the recent pre-seed both number their cases from 0, so
    member ids named by that number alone collided; each id is now also the id of a
    row its source keeps, so it is unique across the seed."""
    ids = [m for c in _seeded(hitl=True) for m in c.member_event_ids]
    assert ids and len(ids) == len(set(ids))


def test_the_seeded_spread_is_deterministic() -> None:
    first = [(c.case_id, c.source_id, c.rule_ids, c.title) for c in _seeded()]
    again = [(c.case_id, c.source_id, c.rule_ids, c.title) for c in _seeded()]
    assert first == again


# --------------------------------------------------------------------------- #
# A source keeps the seeded cases' own rows
# --------------------------------------------------------------------------- #
def _source_for(case: Case) -> DS.NativeDemoSource:
    return DS.NativeDemoSource(KEY_BY_SOURCE[case.source_id], seed=SEED)


@pytest.mark.asyncio
async def test_a_source_keeps_one_row_per_member_inside_the_case_window() -> None:
    prefs = Preferences()
    for case in _seeded(history_days=3, hitl=True):
        source = _source_for(case)
        source.prime(prefs, now_millis=NOW, count=3)
        ring_before = len(source._recent)  # noqa: SLF001
        health_before = source.activity_snapshot(now_millis=NOW)
        recorded = source.record_case_history(case, prefs)
        assert recorded == len(case.member_event_ids)
        # Idempotent: a second seeding keeps one copy.
        assert source.record_case_history(case, prefs) == 0
        created = _created_ms(case)
        result = await source.search(prefs, StructuredQuery(
            rule=case.rule_ids[0], time_from=_iso_second(case.first_seen_millis),
            time_to=_iso_second(created, up=True), size=50,
        ))
        assert result.total == recorded, case.case_id
        for event in result.events:
            assert case.first_seen_millis <= event.timestamp_millis <= created
            assert case.entity.value in {event.ip, event.user, event.host}, (case.case_id, case.entity)
        # One internal address and one host for the whole case: its rows agree.
        assert len({e.ip for e in result.events}) == 1 and len({e.host for e in result.events}) == 1
        # A read filtered on the case's entity (Logs, a runbook lookup, a chat hunt)
        # finds every one of the case's rows.
        field = {"ip": "ip", "user": "user", "host": "host"}[case.entity.type.value]
        by_entity = await source.search(prefs, StructuredQuery(
            **{field: case.entity.value}, rule=case.rule_ids[0], time_from=_iso_second(case.first_seen_millis),
            time_to=_iso_second(created, up=True), size=50,
        ))
        assert by_entity.total == recorded, (case.case_id, case.entity)
        # Each row is one of the case's member events: re-fetching the members by id
        # (as Logs opens a row, and as a lookup binds the case's span) returns exactly
        # the case's own rows, never newer live rows of the same entity.
        assert sorted(e.id for e in result.events) == sorted(case.member_event_ids)
        found = await source.fetch_by_ids(prefs, list(case.member_event_ids), size=len(case.member_event_ids))
        assert sorted(e.id for e in found.events) == sorted(case.member_event_ids)
        assert all(case.first_seen_millis <= e.timestamp_millis <= created for e in found.events)
        # The live ring, the poll and source health are untouched.
        assert len(source._recent) == ring_before  # noqa: SLF001
        polled = await source.poll(prefs, Cursor(source_id=case.source_id), 0)
        assert all(e.rule != case.rule_ids[0] or e.timestamp_millis > created for e in polled)
        health_after = source.activity_snapshot(now_millis=NOW)
        for field in ("events_total", "alerts_total", "buffer_depth", "last_event_millis"):
            assert health_after[field] == health_before[field], field


def test_a_rule_the_source_never_raises_records_nothing() -> None:
    _hitl, tuner = gen.generate_capability_seed_cases(SEED, gen.build_org(SEED), run_id="run", now_millis=NOW)
    prefs = Preferences()
    # The tuner's noise keeps its Demo-only rule (its observation depends on it).
    for case in tuner[:3]:
        assert _source_for(case).record_case_history(case, prefs) == 0


def test_the_kept_rows_are_bounded() -> None:
    prefs = Preferences()
    case = next(c for c in _seeded() if c.source_id == "demo-splunk")
    source = _source_for(case)
    source._HISTORY_MAX = 5  # noqa: SLF001 - a small bound for the test
    copies = [case.model_copy(update={"case_id": f"{case.case_id}-{i}"}) for i in range(10)]
    for copy in copies:
        source.record_case_history(copy, prefs)
    assert len(source._history) <= 5 + DS.NativeDemoSource._HISTORY_ROWS_PER_CASE  # noqa: SLF001


# --------------------------------------------------------------------------- #
# Demo Mode end to end: the rule sheet's own read
# --------------------------------------------------------------------------- #
def _app(box: dict[str, Any], secrets: Any) -> FastAPI:
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        api.state.tlsoc = state
        box["state"] = state
        yield
        if state.demo_active:
            await state.disable_demo()
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(summary_router)
    return api


def test_every_seeded_cases_rule_has_alerts_in_its_window_on_the_rule_sheet(secrets) -> None:
    routes_rule_summary.invalidate_summary_views()
    box: dict[str, Any] = {}
    with TestClient(_app(box, secrets)) as client:
        state: AppState = box["state"]
        client.portal.call(lambda: state.enable_demo(mode="seeded", seed=SEED, history_days=2))
        try:
            cases, _total, _exact = client.portal.call(lambda: state.cases.list_window(limit=1000))
            seeded = [c for c in cases if c.case_id.startswith(("demo-0", "demo-recent-", "demo-hitl-"))]
            assert seeded, [c.case_id for c in cases]
            assert any(c.case_id.startswith("demo-hitl-") for c in seeded)
            for case in seeded:
                window = (f"{_iso_second(case.first_seen_millis)}.."
                          f"{_iso_second(_created_ms(case), up=True)}")
                response = client.get("/api/rules/summary", params={"rule": case.rule_ids[0], "window": window})
                assert response.status_code == 200, response.text
                body = RuleSummary.model_validate(response.json())
                assert body.alerts.status == "ok", (case.case_id, body.alerts)
                assert (body.alerts.count or 0) >= 1, (case.case_id, case.rule_ids, window)
                # The source the case came from is among the ones that answered.
                assert case.source_id in {s.id for s in body.alerts.sources}
            # The same rows are what Logs browses for the rule.
            first = seeded[0]
            logs = client.get("/api/logs", params={
                "rule": first.rule_ids[0], "source_id": first.source_id,
                "from": _iso_second(first.first_seen_millis), "to": _iso_second(_created_ms(first), up=True),
            })
            assert logs.status_code == 200, logs.text
            rows = logs.json().get("logs") or []
            assert rows and all(row.get("rule") == first.rule_ids[0] for row in rows), logs.json()
            assert all(row.get("source_id") == first.source_id for row in rows)
            # The seeded runs' log lookups bind the case's own span (its member events)
            # and its entity, so each finds the case's rows: none comes back empty or
            # "starts after now" because newer live rows stood in for the members.
            client.portal.call(lambda: runbook_runs.wait_for_background_lookups(60))
            log_lookups = []
            for case in seeded:
                stored = client.portal.call(lambda c=case: state.runbook_runs.get(c.case_id))
                for run in stored.runs:
                    for step_id, step in run.steps.items():
                        for evidence in step.evidence:
                            if evidence.kind == "lookup_result" and evidence.lookup is not None \
                                    and evidence.lookup.tool in ("log_stats", "log_search"):
                                log_lookups.append((case.case_id, step_id, evidence.lookup))
            assert log_lookups
            for case_id, step_id, lookup in log_lookups:
                assert lookup.status == "ok" and (lookup.count or 0) >= 1, (case_id, step_id, lookup.status,
                                                                            lookup.reason)
        finally:
            client.portal.call(state.disable_demo)
    routes_rule_summary.invalidate_summary_views()
