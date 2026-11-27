"""Severity breakdowns in chat answers (Round 14 SPEC §4.7.2).

"Show events by severity" answers with the five named levels in fixed order (Critical,
High, Medium, Low, Info), zeros included, each with its count, its share (one decimal),
the raw source values it holds, its trend, its rules and the Logs (or Cases) view of
exactly that level. Raw values are projected through EACH source's own
``severity_scale_max`` before sources are merged, so a 0 to 15 and a 0 to 10 source land
in the same levels as a 0 to 100 one. The basis is honest: a sentence states the sample
only when the bars do not cover the stated total, and says both halves when some sources
counted exactly and others were sampled. Cases count exactly through the case
aggregator, and a case without a readable severity is said, never folded into Info.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest

from app.agents import blocks as B
from app.agents.chat_tools.common import (
    SEVERITY_LEVELS,
    SeverityLevelCounts,
    coarsen_counts,
    severity_categories,
    severity_sample_caption,
    shares_one_decimal,
)
from app.agents.chat_tools.logs import LogStatsTool
from app.agents.chat_tools.metrics import SocMetricsTool
from app.agents.chat_tools.stats import CaseStatsTool
from app.api.metrics_shared import invalidate_case_page_cache
from app.connectors.base import StructuredQuery
from app.connectors.elastic import ElasticConnector
from app.constants import CASES_WRITE_ALIAS, CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.log_rows import BrowseTarget
from app.es.fake import InMemoryESClient
from app.models import Case, Entity
from app.stores.cases import CaseStore
from app.utils import now_utc, to_millis

from tests.conftest import make_log_event
from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

NAMES = ["Critical", "High", "Medium", "Low", "Info"]
WINDOW_KEYS = {"from", "to"}


def _severity(out: Any) -> Any:
    return next(a for a in out.artifacts if a.kind == "categories" and a.data.get("kind") == "severity")


def _level(data: dict[str, Any], level: str) -> dict[str, Any]:
    return next(lv for lv in data["levels"] if lv["level"] == level)


# --------------------------------------------------------------------------- #
# The builder.
# --------------------------------------------------------------------------- #
def test_the_five_levels_appear_in_fixed_order_with_zeros_and_one_decimal_shares() -> None:
    data = severity_categories({"high": SeverityLevelCounts(count=2), "low": SeverityLevelCounts(count=1)},
                               subject="events")
    assert data["kind"] == "severity" and data["subject"] == "events"
    assert data["labels"] == NAMES and data["values"] == [0, 2, 0, 1, 0]
    assert [lv["level"] for lv in data["levels"]] == list(SEVERITY_LEVELS)
    assert [lv["share"] for lv in data["levels"]] == [0.0, 66.7, 0.0, 33.3, 0.0]
    assert data["ordered"] is True and data["dimension"] == "Severity"
    # Nothing counted: every share is zero, never a division by zero.
    empty = severity_categories({}, subject="cases")
    assert empty["values"] == [0] * 5 and all(lv["share"] == 0.0 for lv in empty["levels"])
    assert shares_one_decimal([1, 1, 1]) == [33.3, 33.3, 33.3]


def test_rules_splits_and_raw_values_are_bounded_and_ranked() -> None:
    rules = {f"rule-{i:02d}": 100 - i for i in range(30)}
    sources = {f"src-{i}": 10 + i for i in range(8)}
    raws = [{"value": float(v), "scale_max": 100.0} for v in range(80, 90)]
    data = severity_categories(
        {"critical": SeverityLevelCounts(count=sum(rules.values()), rules=rules, sources=sources, raw_values=raws),
         "high": SeverityLevelCounts(count=5, rules={"rule-00": 5})},
        subject="events", rule_drill_of=lambda rule: {"page": "rule", "opts": {"rule": rule}},
    )
    critical = _level(data, "critical")
    assert len(critical["rules"]) == 20 and critical["rules_total"] == 30
    assert critical["rules"][0] == {"key": "rule-00", "count": 100, "drill": {"page": "rule", "opts": {"rule": "rule-00"}}}
    assert len(critical["raw_values"]) == 5
    rule_split = data["splits"]["rule"]["critical"]
    assert len(rule_split["top"]) == 5 and rule_split["other"] == sum(sorted(rules.values())[:-5])
    source_split = data["splits"]["source"]["critical"]
    assert [t["key"] for t in source_split["top"]] == ["src-7", "src-6", "src-5", "src-4", "src-3"]
    assert source_split["other"] == 10 + 11 + 12
    # rule-00 shows at two levels: the breakdown says how many rules do.
    assert data["multi_level_rules"] == 1


def test_a_trend_is_coarsened_to_at_most_24_points_without_losing_a_count() -> None:
    hourly = list(range(1, 73))  # three days of hours
    coarse = coarsen_counts(hourly)
    assert len(coarse) <= 24 and sum(coarse) == sum(hourly)
    assert coarse[-1] == sum(hourly[-3:])  # the newest point is a whole group
    assert coarsen_counts([1, 2, 3]) == [1, 2, 3]


def test_the_sample_sentence_appears_only_when_the_bars_do_not_cover_the_total() -> None:
    assert severity_sample_caption(1000, 1000, cap=200, sampled_sources=0, exact_sources=3) is None
    assert severity_sample_caption(1000, 2500, cap=200, sampled_sources=5, exact_sources=0) == (
        "1,000 of 2,500 events sampled, newest 200 per source")
    assert severity_sample_caption(200, 900, cap=200, sampled_sources=1, exact_sources=0) == (
        "200 of 900 events sampled, newest 200 from the source")
    assert severity_sample_caption(1400, 2900, cap=200, sampled_sources=3, exact_sources=2) == (
        "1,400 of 2,900 events counted: 2 sources exactly, 3 sampled at the newest 200 each")
    assert severity_sample_caption(200, 10_000, cap=200, sampled_sources=1, exact_sources=0, total_bound=True) == (
        "200 of at least 10,000 events sampled, newest 200 from the source")
    assert severity_sample_caption(200, None, cap=200, sampled_sources=1, exact_sources=0) == (
        "200 of an unknown number of events sampled, newest 200 from the source")


# --------------------------------------------------------------------------- #
# log_stats: projection per source, honest basis.
# --------------------------------------------------------------------------- #
def _target(sid: str, severities: list[float], *, total: int | None = None, scale_max: float = 100.0,
            rule: str = "r1") -> BrowseTarget:
    ts = now_utc().isoformat()
    rows = [{"id": f"{sid}-{i}", "ts": ts, "source_ip": "198.51.100.7", "user": "u", "host": "h",
             "rule": rule, "severity": sev, "message": "m", "_raw": {}} for i, sev in enumerate(severities)]

    async def read(sq: StructuredQuery) -> Any:
        return rows[: sq.size], (len(rows) if total is None else total)

    return BrowseTarget(sid, f"Source {sid}", "search", read, scale_max=scale_max)


async def test_each_source_is_projected_through_its_own_scale_before_merging() -> None:
    targets = [
        _target("wide", [80, 50], scale_max=100, rule="web scan"),    # Critical, High
        _target("wazuh", [12, 8], scale_max=15, rule="ssh brute"),    # 80 Critical, 53.3 High
        _target("qradar", [5, 1], scale_max=10, rule="ssh brute"),    # 50 High, 10 Low
    ]
    out = await LogStatsTool().run(make_ctx(browse_sources=lambda: targets), group_by=["severity"],
                                   window="now-24h")
    assert out.ok
    data = _severity(out).data
    assert data["labels"] == NAMES and data["values"] == [2, 3, 0, 1, 0]
    assert sum(lv["share"] for lv in data["levels"]) == pytest.approx(100.0, abs=0.2)
    high = _level(data, "high")
    assert {(r["value"], r["scale_max"]) for r in high["raw_values"]} == {(50.0, 100.0), (8.0, 15.0), (5.0, 10.0)}
    assert {r["key"]: r["count"] for r in high["rules"]} == {"ssh brute": 2, "web scan": 1}
    # Exact: every source's rows are its whole match, so no sample sentence.
    assert data["sample"]["exact"] is True and "basis_caption" not in data
    assert out.observation["severity"]["basis"] == "exact"
    # Every level opens the Logs page at that level over every source; each source's
    # share opens that source alone.
    assert high["drill"]["page"] == "logs" and high["drill"]["opts"]["severity"] == "high"
    assert "sourceId" not in high["drill"]["opts"]
    by_source = {t["key"]: t for t in data["splits"]["source"]["high"]["top"]}
    assert by_source["Source wazuh"]["drill"]["opts"]["sourceId"] == "wazuh"
    # Each level's trend sums to its count.
    for lv in data["levels"]:
        assert len(lv["trend"]) <= 24 and sum(lv["trend"]) == lv["count"]
    # The plain table names the levels with their raw values, never a bare number.
    table = B.to_blocks(_severity(out), B.MaterialiseOptions(block_id="b1"))[0]
    assert table["type"] == "table" and [row[0] for row in table["rows"]][:2] == ["Critical (80, 12)",
                                                                                   "High (50, 8, 5)"]
    assert table["rows"][2][0] == "Medium" and table["severity"]["levels"][1]["count"] == 3
    assert len(table["drill"]) == 5 and table["drill"][1]["opts"]["severity"] == "high"
    assert_artifacts_render(out)
    # The model reads levels, never raw numbers.
    assert [lv["level"] for lv in out.observation["severity"]["levels"]] == list(SEVERITY_LEVELS)
    assert "severity" not in out.observation["top"]


async def test_mixed_exact_and_sampled_sources_say_both() -> None:
    targets = [_target("a", [80, 30]), _target("b", [60, 60, 5], total=500)]
    out = await LogStatsTool().run(make_ctx(browse_sources=lambda: targets), group_by=["severity"],
                                   window="now-24h")
    data = _severity(out).data
    caption = "5 of 502 events counted: 1 source exactly, 1 sampled at the newest 200 each"
    assert data["basis_caption"] == caption
    assert data["sample"] == {"counted": 5, "total": 502, "per_source_cap": 200, "exact": False,
                              "sources_exact": 1, "sources_sampled": 1}
    assert caption in (out.coverage or "")
    assert out.observation["severity"]["basis"] == "sample" and out.observation["severity"]["sample"] == caption
    block = B.to_blocks(_severity(out), B.MaterialiseOptions(block_id="b1"))[0]
    assert caption in block["caption"]


def _es(severities: list[float], rule: str = "r1") -> InMemoryESClient:
    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i, sev in enumerate(severities):
        es.add_log("all-logs-x", make_log_event(rule=rule if i % 2 else f"{rule}-b", severity=sev,
                                                ts_millis=now - i * 1000))
    return es


async def test_an_aggregate_source_counts_every_level_and_rule_exactly() -> None:
    conn = ElasticConnector(_es([90, 80, 60, 30, 30, 10, 2, 2]))
    out = await LogStatsTool().run(make_ctx(log_source=conn, source_id="elastic-1"), group_by=["severity"],
                                   window="now-3d")
    data = _severity(out).data
    assert data["values"] == [2, 1, 2, 1, 2]
    assert data["sample"]["exact"] is True and data["sample"]["per_source_cap"] is None
    assert "basis_caption" not in data and "severity levels" not in (out.coverage or "")
    # The rules of every level add up to the level (one rule per event).
    for lv in data["levels"]:
        assert sum(r["count"] for r in lv["rules"]) == lv["count"]
    critical = _level(data, "critical")
    assert critical["drill"]["opts"]["sourceId"] == "elastic-1"
    assert critical["rules"][0]["drill"]["page"] == "rule"


class _NoComposite(ElasticConnector):
    """A source whose composite cannot count every combination (a cap reached)."""

    async def aggregate_composite(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        class _Partial:
            complete = False
            rows: list[Any] = []
            total = 0

        return _Partial()


async def test_an_incomplete_composite_falls_back_to_a_stated_sample() -> None:
    conn = _NoComposite(_es([80.0] * 205))
    out = await LogStatsTool().run(make_ctx(log_source=conn), group_by=["severity"], window="now-3d")
    data = _severity(out).data
    # The newest 200 of the 205 matching events, said so.
    assert data["values"][0] == 200
    assert data["basis_caption"] == "200 of 205 events sampled, newest 200 from the source"
    assert data["sample"]["exact"] is False and data["sample"]["per_source_cap"] == 200
    # The match total itself stays exact (the count did not sample).
    kpis = next(a for a in out.artifacts if a.kind == "kpis")
    assert kpis.data["items"][0]["value"] == 205


def _parity_elastic() -> dict[str, Any]:
    """An aggregate-capable source (terms for the rule table, composite for the levels)."""
    es = InMemoryESClient()
    now = to_millis(now_utc())
    plan = [("ssh brute", 90), ("ssh brute", 60), ("ssh brute", 60), ("web scan", 30), ("web scan", 90),
            ("dns tunnel", 10), ("dns tunnel", 10), ("dns tunnel", 2)]
    for i, (rule, sev) in enumerate(plan):
        es.add_log("all-logs-x", make_log_event(rule=rule, severity=sev, ts_millis=now - i * 1000))
    return {"log_source": ElasticConnector(es), "source_id": "elastic-1"}


def _parity_sampled() -> dict[str, Any]:
    """Sources read without ``aggregate()``: the counts come from the bounded sample."""
    targets = [
        _target("a", [90, 60, 60], rule="ssh brute", scale_max=100),
        _target("b", [12, 2], rule="web scan", scale_max=15),
        _target("c", [1, 1, 0], rule="dns tunnel", scale_max=10),
    ]
    return {"browse_sources": lambda: targets}


@pytest.mark.parametrize("fixture", ["aggregate", "sampled"])
async def test_a_rules_count_is_the_same_in_the_rule_table_and_the_severity_table(fixture: str) -> None:
    """[P-C4] and [P-C5] read one population: per rule, the rule table's count equals the
    sum of that rule's counts across the levels, and both answers link the same rule."""
    ctx_kw = _parity_elastic() if fixture == "aggregate" else _parity_sampled()
    by_rule = await LogStatsTool().run(make_ctx(**ctx_kw), group_by=["rule"], window="now-24h")
    by_level = await LogStatsTool().run(make_ctx(**ctx_kw), group_by=["severity"], window="now-24h")
    assert by_rule.ok and by_level.ok
    def target(drill: dict[str, Any]) -> tuple[Any, ...]:
        # The two answers ran a moment apart, so their window instants may differ by a
        # millisecond: the destination is the page, the rule and the source.
        assert WINDOW_KEYS <= set(drill["opts"])
        return drill["page"], drill["opts"]["rule"], drill["opts"].get("sourceId")

    table = next(a for a in by_rule.artifacts if a.kind == "categories").data
    rule_counts = {d["opts"]["rule"]: v for d, v in zip(table["drill"], table["values"])}
    rule_drills = {d["opts"]["rule"]: target(d) for d in table["drill"]}
    levels = _severity(by_level).data["levels"]
    summed: dict[str, int] = {}
    for lv in levels:
        assert lv["rules_total"] == len(lv["rules"])  # every rule of the fixture is listed
        for r in lv["rules"]:
            rule = r["drill"]["opts"]["rule"]
            summed[rule] = summed.get(rule, 0) + r["count"]
            assert target(r["drill"]) == rule_drills[rule]
    assert summed == rule_counts == {"ssh brute": 3, "web scan": 2, "dns tunnel": 3}
    # Both read the whole population (the composite, or a sample that held every event).
    assert _severity(by_level).data["sample"]["exact"] is True


async def test_two_sources_that_share_a_name_keep_their_own_split_rows_and_views() -> None:
    targets = [replace(_target("wazuh-prod", [80, 80, 80]), source_name="Wazuh"),
               replace(_target("wazuh-lab", [80]), source_name="Wazuh")]
    out = await LogStatsTool().run(make_ctx(browse_sources=lambda: targets), group_by=["severity"],
                                   window="now-24h")
    top = _severity(out).data["splits"]["source"]["critical"]["top"]
    assert [(t["key"], t["count"], t["drill"]["opts"]["sourceId"]) for t in top] == [
        ("Wazuh (wazuh-prod)", 3, "wazuh-prod"), ("Wazuh (wazuh-lab)", 1, "wazuh-lab")]
    # A name no other source has stays plain.
    alone = await LogStatsTool().run(make_ctx(browse_sources=lambda: [_target("x", [80]), _target("y", [10])]),
                                     group_by=["severity"], window="now-24h")
    assert _severity(alone).data["splits"]["source"]["critical"]["top"][0]["key"] == "Source x"


async def test_a_severity_breakdown_draws_no_heatmap_of_raw_values() -> None:
    conn = ElasticConnector(_es([90, 30]))
    out = await LogStatsTool().run(make_ctx(log_source=conn), group_by=["severity"], window="now-3d",
                                   include_heatmap=True)
    assert not [a for a in out.artifacts if a.kind == "heatmap"]


# --------------------------------------------------------------------------- #
# Cases: exact through the case aggregator.
# --------------------------------------------------------------------------- #
def _case(i: int, band: str, *, rules: list[str], source: str) -> Case:
    created = (now_utc() - timedelta(hours=i + 1)).isoformat()
    return Case(
        case_id=f"case-{i:04d}", case_number=f"CASE-{i:06d}", cluster_signature=f"sig-{i}",
        source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        status=CaseStatus.OPEN, verdict=Verdict.NEEDS_HUMAN, confidence=0.8, risk_score=40.0,
        title=f"case {i}", created_at=created, updated_at=created, severity_band=band, rule_ids=rules,
        source_id=source,
    )


@pytest.fixture
async def cases() -> Any:
    invalidate_case_page_cache()
    es = InMemoryESClient()
    store = CaseStore(es)
    for i in range(3):
        await store.save(_case(i, "high", rules=["ssh brute"], source="wazuh"))
    await store.save(_case(10, "critical", rules=["ssh brute", "web scan"], source="elastic"))
    yield store, es
    invalidate_case_page_cache()


async def test_case_severity_is_exact_with_rules_sources_and_drills(cases: Any) -> None:
    store, _es = cases
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity"], window="now-24h")
    assert out.ok
    data = _severity(out).data
    assert data["subject"] == "cases" and data["values"] == [1, 3, 0, 0, 0]
    assert "basis_caption" not in data and "sample" not in data
    high = _level(data, "high")
    assert high["rules"] == [{"key": "ssh brute", "count": 3, "drill": high["rules"][0]["drill"]}]
    assert high["rules"][0]["drill"]["page"] == "rule"
    # A case under two rules counts under both; one rule spans two levels.
    critical = _level(data, "critical")
    assert {r["key"] for r in critical["rules"]} == {"ssh brute", "web scan"}
    assert data["multi_level_rules"] == 1
    assert data["splits"]["source"]["high"]["top"][0]["count"] == 3
    # Each level opens the Cases list at that level over the same trailing hours.
    assert high["drill"] == {"page": "cases", "opts": {"severity": "high", "window": 24}}
    assert sum(high["trend"]) == 3 and len(high["trend"]) <= 24
    assert_artifacts_render(out)
    # A window of whole days (its start snapped to midnight) is not one the Cases list
    # can show, so its levels carry no Cases link rather than a different population.
    days = _severity(await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity"],
                                               window="now-7d")).data
    assert days["values"] == [1, 3, 0, 0, 0] and all(lv["drill"] is None for lv in days["levels"])
    assert _level(days, "high")["rules"][0]["drill"]["page"] == "rule"


@pytest.mark.parametrize("window", ["now-12h", "now-72h", "now-2h", "now-48h"])
async def test_a_window_the_cases_list_cannot_show_has_no_cases_link(cases: Any, window: str) -> None:
    """The Cases list offers 1 hour, 24 hours, 7 days and 30 days; any other ``window`` is
    ignored there (the list shows all time), so such a level carries no link."""
    store, _es = cases
    data = _severity(await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity"], window=window)).data
    assert all(lv["drill"] is None for lv in data["levels"])
    assert any(lv["count"] for lv in data["levels"])


@pytest.mark.parametrize("filters", [{"status_group": "active"}, {"status": "open"}, {"verdict": "NEEDS_HUMAN"},
                                     {"rule": "ssh brute"}, {"text": "case"}, {"assignee": "alice"}])
async def test_a_filtered_case_count_has_no_wider_cases_link(cases: Any, filters: dict[str, Any]) -> None:
    """Each level was counted under the call's filters, which the Cases link does not
    carry: a link would open more cases than the figure, so there is none."""
    store, _es = cases
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity"], window="now-24h", **filters)
    assert out.ok
    assert all(lv["drill"] is None for lv in _severity(out).data["levels"])


async def test_a_severity_filter_keeps_the_link_of_its_own_level_only(cases: Any) -> None:
    store, _es = cases
    data = _severity(await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity"], window="now-24h",
                                               severity="high")).data
    assert _level(data, "high")["drill"] == {"page": "cases", "opts": {"severity": "high", "window": 24}}
    assert all(lv["drill"] is None for lv in data["levels"] if lv["level"] != "high")


def test_the_cases_link_carries_only_the_windows_the_list_offers() -> None:
    from app.agents.chat_tools.common import CASES_LIST_WINDOW_HOURS, case_severity_drill, resolve_window

    assert CASES_LIST_WINDOW_HOURS == (1, 24, 168, 720)
    for hours in CASES_LIST_WINDOW_HOURS:
        window = resolve_window(make_ctx(), window_hours=hours)
        assert not isinstance(window, str)
        assert case_severity_drill("low", window) == {"page": "cases", "opts": {"severity": "low", "window": hours}}
    for hours in (2, 6, 12, 48, 72, 169, 719):
        window = resolve_window(make_ctx(), window_hours=hours)
        assert not isinstance(window, str) and case_severity_drill("low", window) is None
    every = resolve_window(make_ctx(), window="all")
    assert not isinstance(every, str)
    assert case_severity_drill("low", every) == {"page": "cases", "opts": {"severity": "low"}}
    assert case_severity_drill("low", every, {"verdict": "TRUE_POSITIVE"}) is None
    assert case_severity_drill("low", every, {"severity": "low"}) == {"page": "cases", "opts": {"severity": "low"}}
    assert case_severity_drill("high", every, {"severity": "low"}) is None


async def test_a_case_without_a_readable_severity_is_said_not_counted_as_info(cases: Any) -> None:
    store, es = cases
    created = (now_utc() - timedelta(hours=2)).isoformat()
    # A stored document that no longer validates: the aggregator reads it as unknown.
    await es.index_doc(CASES_WRITE_ALIAS, {"case_id": "case-broken", "status": "open", "created_at": created,
                                           "updated_at": created}, doc_id="case-broken", refresh=True)
    invalidate_case_page_cache()
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity"], window="now-7d")
    data = _severity(out).data
    assert data["values"] == [1, 3, 0, 0, 0]  # Info stays a real level
    assert data["basis_caption"] == "1 case has no readable severity and is not shown"
    assert data["sample"] == {"counted": 4, "total": 5, "exact": False}


async def test_posture_cases_by_severity_reads_as_named_levels(cases: Any) -> None:
    store, _es = cases
    out = await SocMetricsTool().run(make_ctx(cases=store), kind="posture", window="now-7d")
    assert out.ok
    by_severity = next(a for a in out.artifacts if a.title == "Cases by severity")
    assert by_severity.data["kind"] == "severity" and by_severity.data["labels"] == NAMES
    assert by_severity.data["values"] == [1, 3, 0, 0, 0]
    assert_artifacts_render(out)


def test_severity_rows_are_read_once_unreadable_kept_apart_and_same_level_rows_added() -> None:
    """The one reading of severity rows: a row with no readable band is in no level
    (never Info), and two rows naming the same level add up rather than one replacing
    the other."""
    from types import SimpleNamespace

    from app.agents.chat_tools.stats import case_severity_counts, unreadable_severity_note

    result = SimpleNamespace(groups=[
        {"key": {"severity": "info"}, "metrics": {"count": 2}},
        {"key": {"severity": None}, "metrics": {"count": 3}},
        {"key": {"severity": "Info"}, "metrics": {"count": 1}},
        {"key": {"severity": "unknown"}, "metrics": {"count": 1}},
        {"key": {"severity": "high"}, "metrics": {"count": 4}},
        {"other": True, "key": {}, "metrics": {"count": 9}},
    ])
    counts, unreadable = case_severity_counts(result)
    assert counts == {"critical": 0, "high": 4, "medium": 0, "low": 0, "info": 3}
    assert list(counts) == ["critical", "high", "medium", "low", "info"]
    assert unreadable == 4
    assert case_severity_counts(SimpleNamespace(groups=None)) == (dict.fromkeys(counts, 0), 0)
    assert unreadable_severity_note(0) is None
    assert unreadable_severity_note(1) == "1 case has no readable severity and is not shown"
    assert unreadable_severity_note(1234) == "1,234 cases have no readable severity and are not shown"


async def _with_info_and_unreadable(store: Any, es: InMemoryESClient) -> None:
    """Two Info cases and three stored cases whose band cannot be read, all in the
    window: a fold into Info would read 5, an overwrite 2 or 3, so only the shared
    reading states 2 in both places."""
    for i in (20, 21):
        await store.save(_case(i, "info", rules=["dns probe"], source="wazuh"))
    created = (now_utc() - timedelta(hours=2)).isoformat()
    for n in range(3):
        # A stored document that no longer validates: the aggregator reads it as unknown.
        await es.index_doc(CASES_WRITE_ALIAS, {"case_id": f"case-broken-{n}", "status": "open",
                                               "created_at": created, "updated_at": created},
                           doc_id=f"case-broken-{n}", refresh=True)
    invalidate_case_page_cache()


_UNREADABLE_NOTE = "3 cases have no readable severity and are not shown"


async def test_posture_observation_and_severity_block_state_the_same_info_count(cases: Any) -> None:
    """The prose is written from the observation, the block from the breakdown: both read
    the same rows the same way, so an unreadable case never turns up as Info in one and
    not the other."""
    store, es = cases
    await _with_info_and_unreadable(store, es)
    out = await SocMetricsTool().run(make_ctx(cases=store), kind="posture", window="now-7d")
    assert out.ok
    block = next(a for a in out.artifacts if a.title == "Cases by severity")
    assert block.data["kind"] == "severity"
    observed = out.observation["severity_counts"]
    assert observed["info"] == _level(block.data, "info")["count"] == 2
    assert list(observed.values()) == block.data["values"] == [1, 3, 0, 0, 2]
    assert out.observation["severity_unreadable"] == 3
    assert block.data["basis_caption"] == _UNREADABLE_NOTE
    assert sum(observed.values()) + out.observation["severity_unreadable"] == out.observation["case_count"]
    assert_artifacts_render(out)


async def test_posture_says_no_unreadable_cases_when_every_band_is_read(cases: Any) -> None:
    store, _es = cases
    out = await SocMetricsTool().run(make_ctx(cases=store), kind="posture", window="now-7d")
    assert out.observation["severity_unreadable"] == 0
    assert sum(out.observation["severity_counts"].values()) == out.observation["case_count"]


async def test_posture_plain_levels_also_keep_unreadable_cases_out_of_info(
    cases: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the named-level breakdown cannot be read, the plain levels stand: they hold
    the same figures as the observation and say what they leave out."""
    from app.agents.chat_tools import metrics as metrics_module

    async def _unavailable(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(metrics_module, "case_severity_breakdown", _unavailable)
    store, es = cases
    await _with_info_and_unreadable(store, es)
    out = await SocMetricsTool().run(make_ctx(cases=store), kind="posture", window="now-7d")
    assert out.ok
    block = next(a for a in out.artifacts if a.title == "Cases by severity")
    assert "kind" not in block.data and block.untrusted_labels is False
    assert block.data["labels"] == NAMES
    assert block.data["values"] == list(out.observation["severity_counts"].values()) == [1, 3, 0, 0, 2]
    assert out.observation["severity_unreadable"] == 3
    assert block.data["basis_caption"] == _UNREADABLE_NOTE
    assert_artifacts_render(out)
    rendered = B.to_blocks(block, B.MaterialiseOptions(block_id="b1"))[0]
    assert _UNREADABLE_NOTE in (rendered.get("caption") or "")


# --------------------------------------------------------------------------- #
# Stored answers.
# --------------------------------------------------------------------------- #
def test_an_old_stored_breakdown_without_kind_renders_unchanged() -> None:
    """A severity breakdown stored before Round 14 (raw values as labels, no ``kind``)
    replays exactly as it was stored, in its own view, with nothing added."""
    from app.agents.chat_tools.base import Artifact

    data = {"labels": ["80", "30"], "values": [4, 2], "unit": "count", "dimension": "Severity"}
    assert not B.is_severity_data(data)
    old = B.to_blocks(Artifact(id="a1", kind="categories", title="Events by severity", title_trusted=True,
                               data=data, provenance="source", untrusted_labels=True),
                      B.MaterialiseOptions(block_id="b1"))[0]
    assert old["type"] == "chart" and old["allowed_views"][0] != "table"
    stored = B.parse_persisted_blocks([old])[0]
    assert stored == old
    assert "severity" not in stored and "drill" not in stored and "trend" not in stored


def test_a_stored_severity_table_round_trips_and_changes_view() -> None:
    data = severity_categories(
        {"high": SeverityLevelCounts(count=3, rules={"ssh brute": 3},
                                     raw_values=[{"value": 8.0, "scale_max": 15.0}], trend=[1, 2]),
         "low": SeverityLevelCounts(count=1)},
        subject="events",
        level_drill=lambda level: {"page": "logs", "opts": {"severity": level, "from": "now-24h", "to": "now"}},
        basis_caption="4 of 9 events sampled, newest 200 from the source",
        sample={"counted": 4, "total": 9, "per_source_cap": 200, "exact": False, "sources_exact": 0,
                "sources_sampled": 1},
    )
    from app.agents.chat_tools.base import Artifact

    artifact = Artifact(id="a1", kind="categories", title="Events by severity", title_trusted=True, data=data,
                        provenance="source", untrusted_labels=True, basis="newest_n")
    table = B.to_blocks(artifact, B.MaterialiseOptions(block_id="b1"))[0]
    assert table["type"] == "table" and table["rows"][1][0] == "High (8)"
    assert "4 of 9 events sampled" in table["caption"]
    stored = B.parse_persisted_blocks([table])[0]
    assert stored["severity"]["levels"][1]["rules"][0]["key"] == "ssh brute"
    assert stored["drill"][1]["opts"]["severity"] == "high" and stored["trend"][1] == [1, 2]
    # A view change keeps the named levels, their counts and their drill targets. A chart
    # block holds no per-level rules or raw values, so back as a table it is the plain
    # named-level table (never raw numbers, never a different count).
    bar = B.revise_view(stored, "bar", block_id="b2")
    assert bar is not None and bar["type"] == "chart" and bar["kind"] == "bar"
    assert bar["x"]["values"] == NAMES and bar["series"][0]["values"] == [0, 3, 0, 1, 0]
    assert [d["opts"]["severity"] for d in bar["drill"]] == list(SEVERITY_LEVELS)
    back = B.revise_view(bar, "table", block_id="b3")
    assert back is not None and [row[0] for row in back["rows"]] == NAMES
    assert [row[1] for row in back["rows"]] == [0, 3, 0, 1, 0] and len(back["drill"]) == 5
