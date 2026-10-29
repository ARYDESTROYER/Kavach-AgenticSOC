"""Drill targets in chat answers (Round 14 SPEC §4.6.3, F7).

Every value of an answer a person may want to open carries a ``drill`` ref built by
CODE from a validated value, never by a model or the client (#9, G5):

* a rule (or rule name) label opens the rule sheet (``{"page": "rule"}``) of exactly that
  rule over the answer's window, with the source when the answer read one;
* the table view of a ``categories`` artifact keeps the drill refs and gains a per-row
  trend, aligned with the rows through sorting, clipping, storage and view changes;
* a value a ref cannot carry (an invisible character, a line break, over 256 code points)
  gets no link, and a block the model wrote never carries one;
* a rule filter in a chat lookup matches what the Logs page's "Rule is" matches, so a
  rule-filtered answer keeps its exact "Open in Logs" view;
* the case entity block names a case by its number and its status moves in plain words.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from app.agents import blocks as B
from app.agents.chat_tools.base import Artifact
from app.agents.chat_tools.cases import GetCaseTool
from app.agents.chat_tools import cases as cases_module
from app.agents.chat_tools.common import (
    CASE_STATUS_WORDS,
    rule_drill,
    severity_drill,
    status_change_detail,
    status_change_label,
    status_reason_text,
)
from app.agents.chat_tools.logs import LogStatsTool, SearchLogsTool
from app.config import Preferences
from app.connectors.base import AggregateBucket, StructuredQuery
from app.connectors.elastic import ElasticConnector, LogFilterQuery
from app.constants import CaseStatus, DecisionBy, SourceSurface, Verdict
from app.engine.log_rows import BrowseTarget, FilteredRead
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, StatusHistoryEntry
from app.stores.cases import CaseStore
from app.utils import now_utc, to_millis

from tests.conftest import make_log_event
from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

WINDOW_KEYS = {"from", "to"}


def _es(rows: list[tuple[str, float]], *, name_of: dict[str, str] | None = None) -> InMemoryESClient:
    """One log per ``(rule, severity)``, newest first; ``name_of`` gives a rule a
    different ``rule.name`` than its ``event.module`` (the default rule field)."""
    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i, (rule, severity) in enumerate(rows):
        doc = make_log_event(rule=rule, severity=severity, ts_millis=now - i * 60_000)
        if name_of and rule in name_of:
            doc["rule"]["name"] = name_of[rule]
        es.add_log("all-logs-x", doc)
    return es


def _categories(data: dict[str, Any], **kw: Any) -> Artifact:
    return Artifact(id="a1", kind="categories", title="Top rules", data=data, provenance="source",
                    untrusted_labels=True, **kw)


def _ref(rule: str) -> dict[str, Any]:
    return {"page": "rule", "opts": {"rule": rule, "from": "2026-10-25T00:00:00Z", "to": "2026-10-28T00:00:00Z"}}


# --------------------------------------------------------------------------- #
# The ref grammar.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("value", ["Web scanner user agent detected", "Fehlgeschlagene Anmeldung über SSH",
                                   "trailing space ", "x" * 256])
def test_a_rule_ref_carries_the_value_byte_for_byte(value: str) -> None:
    ref = B.parse_ref({"page": "rule", "opts": {"rule": value, "from": "now-3d", "to": "now"}})
    assert ref is not None and ref.opts is not None and ref.opts.rule == value
    assert B.clean_nav_opts({"rule": value}) == {"rule": value}


@pytest.mark.parametrize("value", ["", "x" * 257, "a​b", "line\nbreak", "bidi‮override"])
def test_a_rule_a_ref_cannot_carry_gets_no_link(value: str) -> None:
    assert B.parse_ref({"page": "rule", "opts": {"rule": value}}) is None
    window = _window("now-3d")
    assert rule_drill(value, window) is None
    assert severity_drill("high", window, rule=value) is None


def test_a_severity_ref_is_a_named_level_on_logs() -> None:
    window = _window("now-3d")
    ref = severity_drill("high", window, "wazuh-prod")
    assert ref is not None and ref["page"] == "logs"
    assert ref["opts"]["severity"] == "high" and ref["opts"]["sourceId"] == "wazuh-prod"
    assert WINDOW_KEYS <= set(ref["opts"])
    assert B.parse_ref(ref) is not None
    assert severity_drill("severe", window) is None
    # The Logs page reads at most 90 days: a longer window has no exact Logs view, while
    # the rule sheet (any window) still opens.
    assert severity_drill("high", _window("now-120d")) is None
    assert rule_drill("r1", _window("now-120d")) is not None
    # All time has no bounds: the sheet opens on its own window.
    assert rule_drill("r1", _window("all")) == {"page": "rule", "opts": {"rule": "r1"}}


def _window(spec: str) -> Any:
    from app.agents.chat_tools.common import resolve_window

    window = resolve_window(make_ctx(), window=spec)
    assert not isinstance(window, str)
    return window


# --------------------------------------------------------------------------- #
# Materialisation: the table view keeps the drill refs and gains a trend.
# --------------------------------------------------------------------------- #
def test_the_table_view_keeps_drill_and_trend_aligned_with_its_sorted_rows() -> None:
    data = {"labels": ["b", "a", "c"], "values": [2, 5, 1], "unit": "count", "dimension": "Rule",
            "drill": [_ref("b"), _ref("a"), None], "trend": [[1, 1], [2, 3], None]}
    table = B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b1", view="table"))[0]
    assert [row[0] for row in table["rows"]] == ["a", "b", "c"]
    assert table["drill"] == [_ref("a"), _ref("b"), None]
    assert table["trend"] == [[2, 3], [1, 1], None]
    assert table["columns"][0]["label"] == "Rule"
    clipped = B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b1", view="table", top_n=1))[0]
    assert clipped["drill"] == [_ref("a")] and clipped["trend"] == [[2, 3]]
    chart = B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b2", view="hbar"))[0]
    assert chart["drill"] == [_ref("a"), _ref("b"), None] and "trend" not in chart


def test_a_view_change_keeps_every_destination() -> None:
    data = {"labels": ["a", "b"], "values": [5, 2], "unit": "count", "drill": [_ref("a"), _ref("b")],
            "trend": [[1, 4], [2, 0]]}
    table = B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b1", view="table"))[0]
    chart = B.revise_view(table, "hbar", block_id="b2")
    assert chart is not None and chart["drill"] == [_ref("a"), _ref("b")]
    back = B.revise_view(table, "table", block_id="b3")
    assert back is not None and back["drill"] == table["drill"] and back["trend"] == table["trend"]
    again = B.revise_view(chart, "table", block_id="b4")
    assert again is not None and again["drill"] == [_ref("a"), _ref("b")]


def test_a_storage_clip_never_misaligns_a_row_and_its_destination() -> None:
    from app.stores.chat_conversations import _compact_block

    rows = [[f"r{i}", 100 - i] for i in range(40)]
    table = {"id": "b1", "type": "table", "provenance": "source", "artifact_kind": "categories",
             "columns": [{"key": "label", "label": "Rule"}, {"key": "value", "label": "Count", "type": "number"}],
             "rows": rows, "drill": [_ref(f"r{i}") for i in range(40)], "trend": [[i] for i in range(40)]}
    stored = B.parse_persisted_blocks([_compact_block(B.validate_blocks([table])[0][0],
                                                      (B.STORED_TABLE_ROWS, 100, 25, 25, 1000))])[0]
    assert len(stored["rows"]) == B.STORED_TABLE_ROWS
    assert [d["opts"]["rule"] for d in stored["drill"]] == [row[0] for row in stored["rows"]]
    assert stored["trend"] == [[i] for i in range(B.STORED_TABLE_ROWS)]


#: Two distinct rule values that share one shown label: past the 200-character label
#: limit they agree on the first 199 characters (the label ends in "…"), and two values
#: differing only in a leading space both show as "lead".
_SHARED_PREFIX = "ModSecurity: Inbound anomaly score exceeded " + "y" * 160
_LONG_A, _LONG_B = _SHARED_PREFIX + "AAAA", _SHARED_PREFIX + "BBBB"


def _row_targets(block: dict[str, Any]) -> list[tuple[str, Any, str | None]]:
    """``(shown label, count, drilled rule)`` per row of a table or bar block."""
    if block["type"] == "table":
        labels, counts = [r[0] for r in block["rows"]], [r[1] for r in block["rows"]]
    else:
        labels, counts = block["x"]["values"], block["series"][0]["values"]
    drills = block.get("drill") or [None] * len(labels)
    return [(str(label), count, d and d["opts"]["rule"]) for label, count, d in zip(labels, counts, drills)]


def test_rows_that_share_a_shown_label_keep_their_own_destination_and_trend() -> None:
    """A label is display text, never an identity: two values that show the same label
    each keep their own drill and trend through the sort, a clip, every view and a view
    change (Round 14 SPEC §4.6.3: a drill names exactly the value events carry)."""
    own = {(_LONG_A, 4): _LONG_A, (_LONG_B, 1): _LONG_B, ("lead", 2): "lead", (" lead", 1): " lead"}
    stored = [_LONG_B, " lead", _LONG_A, "lead"]  # the producer's order, not the shown one
    counts = [1, 1, 4, 2]
    data = {"labels": stored, "values": counts, "unit": "count", "dimension": "Rule",
            "drill": [_ref(v) for v in stored], "trend": [[0, c] for c in counts]}
    shown_label = {v: B._label_text(v) for v in stored}
    assert shown_label[_LONG_A] == shown_label[_LONG_B] and shown_label["lead"] == shown_label[" lead"]

    def assert_own(block: dict[str, Any]) -> None:
        rows = _row_targets(block)
        assert len(rows) == len(block.get("drill") or rows)
        for label, count, rule in rows:
            # The row's own stored value: the one with this shown label AND this count.
            expected = next(v for (v, c), _ in own.items() if shown_label[v] == label and c == count)
            assert rule == expected, (label, count, rule)
        if block["type"] == "table" and block.get("trend") is not None:
            assert [t[-1] for t in block["trend"]] == [count for _label, count, _rule in rows]

    table = B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b1", view="table"))[0]
    assert [r[1] for r in table["rows"]] == [4, 2, 1, 1]
    assert_own(table)
    for view in ("hbar", "bar"):
        assert_own(B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b2", view=view))[0])
    clipped = B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b3", view="table", top_n=3))[0]
    assert len(clipped["rows"]) == 3
    assert_own(clipped)
    for start in (table, B.to_blocks(_categories(data), B.MaterialiseOptions(block_id="b4", view="hbar"))[0]):
        for view in ("table", "hbar", "table"):
            revised = B.revise_view(start, view, block_id="b5")
            assert revised is not None and revised.get("drill") is not None
            assert_own(revised)
            start = revised


async def test_log_stats_rows_that_share_a_label_open_their_own_rule() -> None:
    """End to end on the sample path: two long rules that agree on their first 199
    characters and "lead" / " lead" each open their own rule sheet and draw their own
    trend, in the table, in the bar chart and after a view change."""
    rules_a = [_LONG_A, _LONG_A, _LONG_A, _LONG_B, "lead", "lead", " lead"]
    ctx = make_ctx(browse_sources=lambda: [_sampled_target("a", rules_a), _sampled_target("b", [_LONG_A])])
    out = await LogStatsTool().run(ctx, group_by=["rule"], window="now-3d")
    assert out.ok
    artifact = next(a for a in out.artifacts if a.kind == "categories")
    expected = {(B._label_text(v), c): v for v, c in ((_LONG_A, 4), (_LONG_B, 1), ("lead", 2), (" lead", 1))}
    assert len(expected) == 4

    def assert_own(block: dict[str, Any]) -> None:
        rows = _row_targets(block)
        assert {(label, count) for label, count, _rule in rows} == set(expected)
        for label, count, rule in rows:
            assert rule == expected[(label, count)], (label, count, rule)
        if block.get("trend") is not None:
            assert [sum(t) for t in block["trend"]] == [count for _label, count, _rule in rows]

    table = B.to_blocks(artifact, B.MaterialiseOptions(block_id="b1", view="table"))[0]
    chart = B.to_blocks(artifact, B.MaterialiseOptions(block_id="b2", view="hbar"))[0]
    # The table shows each row's own trend (a chart carries none, so a table made from a
    # chart has none either: no trend rather than a borrowed one).
    assert table.get("trend") is not None and "trend" not in chart
    again = B.revise_view(table, "table", block_id="b5")
    assert again is not None and again.get("trend") == table["trend"]
    for block in (table, chart, B.revise_view(table, "hbar", block_id="b3"),
                  B.revise_view(chart, "table", block_id="b4"), again):
        assert block is not None
        assert_own(block)


def test_a_block_the_model_wrote_never_carries_a_destination() -> None:
    callout = {"id": "c1", "type": "callout", "tone": "info", "text": "t", "provenance": "code",
               "drill": [_ref("a")]}
    # Code-side callouts have no drill field at all (a stray key is dropped with the block).
    assert B.validate_blocks([callout])[0] == []
    # Whatever provenance a model claims, a drill list never survives on what it wrote.
    kept, _dropped = B.validate_blocks([dict(callout, provenance="code")], model_authored=True)
    assert all("drill" not in block for block in kept)


# --------------------------------------------------------------------------- #
# The log tools build the refs.
# --------------------------------------------------------------------------- #
class _MatrixElastic(ElasticConnector):
    """The offline fake answers no ``terms`` sub-aggregation, so this source adds the
    first group's split over time a real cluster returns: every value in the newest
    bucket (the fixture's events all fall in the last minutes)."""

    async def aggregate(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        agg = await super().aggregate(*args, **kwargs)
        group_by = args[2] if len(args) > 2 else kwargs.get("group_by")
        if not agg.over_time or not group_by:
            return agg
        newest = agg.over_time[-1].key
        first = list(group_by)[0]
        matrix = {b.key: [AggregateBucket(key=newest, count=b.count)] for b in agg.groups.get(first, [])}
        return agg.model_copy(update={"matrix": matrix})


async def test_rule_labels_open_the_rule_sheet_of_that_rule_over_the_window() -> None:
    ctx = make_ctx(log_source=_MatrixElastic(_es([("ssh brute", 80), ("ssh brute", 80), ("web scan", 30)])),
                   source_id="wazuh-prod")
    out = await LogStatsTool().run(ctx, group_by=["rule"], window="now-3d")
    assert out.ok
    rules = next(a for a in out.artifacts if a.kind == "categories")
    assert rules.data["dimension"] == "Rule"
    drills = dict(zip(rules.data["labels"], rules.data["drill"]))
    for label, ref in drills.items():
        assert ref["page"] == "rule" and ref["opts"]["rule"] == label
        assert ref["opts"]["sourceId"] == "wazuh-prod" and WINDOW_KEYS <= set(ref["opts"])
    assert_artifacts_render(out)
    table = B.to_blocks(rules, B.MaterialiseOptions(block_id="b1", view="table"))[0]
    assert [d["opts"]["rule"] for d in table["drill"]] == [row[0] for row in table["rows"]]
    # The rows' own trend: one count series per rule over the window.
    assert table["trend"] and all(isinstance(t, list) and len(t) <= B.MAX_ROW_TREND_POINTS for t in table["trend"])
    # Each row's series sums to that row's count (coarsened only past 24 points).
    counts = {row[0]: row[1] for row in table["rows"]}
    for row, series in zip(table["rows"], table["trend"]):
        assert sum(series) == counts[row[0]]


async def test_a_rule_value_a_ref_cannot_carry_is_shown_but_not_linked() -> None:
    ctx = make_ctx(log_source=ElasticConnector(_es([("bad​rule", 30), ("good", 30)])))
    out = await LogStatsTool().run(ctx, group_by=["rule"], window="now-24h")
    rules = next(a for a in out.artifacts if a.kind == "categories")
    by_label = dict(zip(rules.data["labels"], rules.data["drill"]))
    assert by_label["good"]["opts"]["rule"] == "good"
    shown = next(label for label in rules.data["labels"] if label != "good")
    assert "\\u200b" in shown and by_label[shown] is None


#: Rule values the bounded display copy changes: past its 160 code points, a tab, a line
#: break and edge whitespace. A ref names the STORED value byte for byte or there is none.
_LONG_RULE = "Inbound anomaly score exceeded " + "x" * 170   # 201 code points
_EDGE_RULES = {_LONG_RULE: True, " leading space": True, "trailing space ": True, "rule\twith tab": False,
               "first line\nsecond line": False}


def _sampled_target(sid: str, rules: list[str]) -> BrowseTarget:
    """A fan-out source read without ``aggregate()`` (the sample path every push ring,
    Demo target and aggregate-less source takes)."""
    async def read(sq: StructuredQuery) -> Any:
        rows = [{"id": f"{sid}-{i}", "ts": now_utc().isoformat(), "source_ip": "198.51.100.1", "user": "u",
                 "host": "h", "rule": rule, "severity": 80.0, "message": "m", "_raw": {}}
                for i, rule in enumerate(rules)]
        return rows[: sq.size], len(rows)

    return BrowseTarget(sid, f"Source {sid}", "search", read)


def _assert_exact_or_none(drills: list[Any]) -> set[str]:
    linked = {d["opts"]["rule"] for d in drills if d is not None}
    for value in linked:
        assert value in _EDGE_RULES and _EDGE_RULES[value], repr(value)
    assert linked == {value for value, carried in _EDGE_RULES.items() if carried}
    return linked


async def test_sampled_rule_drills_name_the_stored_value_byte_for_byte_or_nothing() -> None:
    """The sample path groups a rule by the value events carry, never by its bounded
    display copy (cut at 160, whitespace trimmed, a tab folded): every drill equals a
    stored value exactly, and a value no ref can carry (a tab, a line break) is shown
    without a link, in the rule table and in the severity breakdown alike."""
    rules = list(_EDGE_RULES)
    ctx = make_ctx(browse_sources=lambda: [_sampled_target("a", rules), _sampled_target("b", [_LONG_RULE])])
    out = await LogStatsTool().run(ctx, group_by=["rule"], window="now-3d")
    assert out.ok
    table = next(a for a in out.artifacts if a.kind == "categories")
    assert len(table.data["labels"]) == len(rules)  # one row per stored value
    counts = dict(zip(table.data["drill"] and [d and d["opts"]["rule"] for d in table.data["drill"]],
                      table.data["values"]))
    assert counts[_LONG_RULE] == 2  # both sources' copies of the long rule are one row
    _assert_exact_or_none(table.data["drill"])
    severity = await LogStatsTool().run(ctx, group_by=["severity"], window="now-3d")
    critical = next(lv for lv in next(a for a in severity.artifacts if a.kind == "categories").data["levels"]
                    if lv["level"] == "critical")
    assert critical["rules_total"] == len(rules)
    _assert_exact_or_none([r["drill"] for r in critical["rules"]])


async def test_a_live_tail_ring_matches_the_stored_rule_value_not_its_display_copy() -> None:
    """A ring ignores the query, so its rows are filtered here: on the value the event
    carries, so a rule the display copy cuts (past 160 code points) still matches, and a
    value that only shares the copy's prefix does not."""
    ts = now_utc().isoformat()
    rows = [{"id": f"r-{i}", "ts": ts, "source_ip": "198.51.100.1", "user": "u", "host": "h", "rule": rule,
             "severity": 80.0, "message": "m", "_raw": {}}
            for i, rule in enumerate([_LONG_RULE, _LONG_RULE[:160] + "y" * 41, "other"])]

    async def read(sq: StructuredQuery) -> Any:
        return rows, None

    ring = BrowseTarget("ring", "Live tail", "buffer", read)
    out = await SearchLogsTool().run(make_ctx(browse_sources=lambda: [ring]), rule=_LONG_RULE, window="now-3d")
    assert out.ok and out.observation["returned"] == 1
    # No private row key ever leaves the tool (model samples or the table).
    assert not any(k.startswith("_") for r in out.observation["sample_rows"] for k in r)


class _NoAggregate(ElasticConnector):
    """A connector read by ``search`` alone (its counts come from the newest events)."""

    aggregate = None  # type: ignore[assignment]
    aggregate_composite = None  # type: ignore[assignment]


async def test_a_single_sampled_source_keeps_the_stored_rule_value_too() -> None:
    conn = _NoAggregate(_es([(_LONG_RULE, 80), (" leading space", 80), ("rule\twith tab", 30)]))
    out = await LogStatsTool().run(make_ctx(log_source=conn), group_by=["rule"], window="now-3d")
    table = next(a for a in out.artifacts if a.kind == "categories")
    linked = {d["opts"]["rule"] for d in table.data["drill"] if d is not None}
    assert linked == {_LONG_RULE, " leading space"}
    assert sum(d is None for d in table.data["drill"]) == 1
    # The model reads the bounded copy, never a 201-character value.
    assert all(len(v["value"]) <= 200 for v in out.observation["top"]["rule"])


class _RefusedRuleClause(Exception):
    """What the driver raises when a cluster refuses a clause (a ``prefix`` on a numeric
    field is a 400)."""

    status_code = 400


class _RefusesRuleIdentity(ElasticConnector):
    """A cluster that answers 400 to the suite rules' catalog clause: every read that
    carries a rule-identity filter is refused, every other read answers."""

    async def search(self, prefs: Any, query: Any) -> Any:  # type: ignore[override]
        if isinstance(query, LogFilterQuery) and query.rule_any is not None:
            raise _RefusedRuleClause("400 search_phase_execution_exception")
        return await super().search(prefs, query)

    async def aggregate(self, prefs: Any, query: Any, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        if isinstance(query, LogFilterQuery) and query.rule_any is not None:
            raise _RefusedRuleClause("400 search_phase_execution_exception")
        return await super().aggregate(prefs, query, *args, **kwargs)


async def test_a_refused_rule_clause_is_retried_with_the_rule_matched_here() -> None:
    """As the Logs page's own reader does: the newest events of the window, kept when
    one of their rule identities is the rule; exact only when that read held the whole
    window, else a floor."""
    es = _es([("linux_auth", 80), ("web", 30), ("linux_auth", 80), ("web", 30), ("linux_auth", 60)],
             name_of={"linux_auth": "SSH brute force"})
    conn = _RefusesRuleIdentity(es)
    whole = await SearchLogsTool().run(make_ctx(log_source=conn), rule="SSH brute force", window="now-3d")
    assert whole.ok and whole.observation["total"] == 3 and whole.observation["total_is_lower_bound"] is False
    part = await SearchLogsTool().run(make_ctx(log_source=conn), rule="SSH brute force", window="now-3d", size=2)
    assert part.ok and part.observation["total_is_lower_bound"] is True
    assert part.observation["returned"] == part.observation["total"] <= 2
    stats = await LogStatsTool().run(make_ctx(log_source=conn), rule="SSH brute force", group_by=["severity"],
                                     window="now-3d")
    assert stats.ok and stats.observation["total"] == 3
    levels = next(a for a in stats.artifacts if a.kind == "categories").data["levels"]
    assert sum(lv["count"] for lv in levels) == 3
    # Any other failure is still a failure, never a silent unfiltered answer.

    class _Down(ElasticConnector):
        async def search(self, prefs: Any, query: Any) -> Any:  # type: ignore[override]
            raise ConnectionError("down")

    down = await SearchLogsTool().run(make_ctx(log_source=_Down(es)), rule="SSH brute force")
    assert not down.ok


async def test_rule_filtered_answers_match_every_rule_identity_and_keep_open_in_logs() -> None:
    """The chat ``rule`` filter is the Logs page's "Rule is": a value that is an event's
    rule NAME (not its rule field) matches too, natively through a ``LogFilterQuery``."""
    es = _es([("linux_auth", 80), ("linux_auth", 80), ("web", 30)], name_of={"linux_auth": "SSH brute force"})
    conn = ElasticConnector(es)
    seen: list[StructuredQuery] = []
    original = conn.search

    async def search(prefs: Any, query: StructuredQuery) -> Any:
        seen.append(query)
        return await original(prefs, query)

    conn.search = search  # type: ignore[method-assign]
    out = await SearchLogsTool().run(make_ctx(log_source=conn), rule="SSH brute force")
    assert out.ok and out.observation["total"] == 2
    assert isinstance(seen[0], LogFilterQuery) and seen[0].rule_any == "SSH brute force" and seen[0].rule is None
    stats = await LogStatsTool().run(make_ctx(log_source=conn), rule="SSH brute force", group_by=["severity"])
    assert stats.ok and stats.observation["total"] == 2


async def test_a_fan_out_rule_filter_reads_through_each_sources_filtered_reader() -> None:
    calls: list[tuple[str | None, str | None]] = []

    def target(sid: str) -> BrowseTarget:
        async def read(sq: StructuredQuery) -> Any:  # the unfiltered read must not be used
            raise AssertionError("a rule filter reads through the filtered reader")

        async def filtered(sq: StructuredQuery, log_filter: Any) -> FilteredRead:
            calls.append((sq.rule, log_filter.rule))
            row = {"id": f"{sid}-1", "ts": now_utc().isoformat(), "source_ip": "198.51.100.1", "user": "u",
                   "host": "h", "rule": "Brute force", "severity": 80.0, "message": "m", "_raw": {}}
            return FilteredRead([row], 1, True)

        return BrowseTarget(sid, f"Source {sid}", "search", read, filtered=filtered)

    ctx = make_ctx(browse_sources=lambda: [target("a"), target("b")])
    out = await SearchLogsTool().run(ctx, rule="Brute force", window="now-3d")
    assert out.ok and out.observation["total"] == 2
    assert calls == [(None, "Brute force"), (None, "Brute force")]


async def test_level_drills_carry_the_call_filters_or_none() -> None:
    """A level opens the Logs page with the same filters the count ran with; a filter the
    page cannot express (an IP) means no Logs view rather than a wider one."""
    es = _es([("r1", 80), ("r1", 30)])
    ctx = make_ctx(log_source=ElasticConnector(es), source_id="src-1")
    out = await LogStatsTool().run(ctx, group_by=["severity"], rule="r1", window="now-3d")
    levels = next(a for a in out.artifacts if a.kind == "categories").data["levels"]
    critical = next(lv for lv in levels if lv["level"] == "critical")
    assert critical["drill"]["opts"]["rule"] == "r1" and critical["drill"]["opts"]["severity"] == "critical"
    narrowed = await LogStatsTool().run(ctx, group_by=["severity"], ip="203.0.113.10", window="now-3d")
    levels = next(a for a in narrowed.artifacts if a.kind == "categories").data["levels"]
    assert all(lv["drill"] is None for lv in levels)
    assert all(r["drill"]["page"] == "rule" for lv in levels for r in lv["rules"])


# --------------------------------------------------------------------------- #
# F7: the case entity block in plain words.
# --------------------------------------------------------------------------- #
def test_status_moves_and_engine_reasons_read_in_plain_words() -> None:
    assert status_change_label("open", "escalated") == "Open to Escalated"
    assert status_change_label("", "new") == "Created as New"
    # One name per status (D25): the Console's own badge wording, as the Status fact.
    assert status_change_label("needs_human", "closed") == "Open · awaiting analyst to Closed"
    assert CASE_STATUS_WORDS is cases_module._STATUS_LABELS
    assert status_reason_text("True positive routed to human: tp auto-close disabled.") == (
        "Automatic close of a confirmed threat is off")
    assert status_change_detail("system", "False positive routed to human: fp auto-close disabled.") == (
        "Automatic close of a false positive is off (by the system)")
    bar = status_reason_text("TRUE_POSITIVE routed to human: did not clear the auto-close bar "
                             "(confidence 0.83 vs 0.9, risk 37.4 vs 30.0).")
    assert bar == ("Did not clear the automatic close bar for a confirmed threat: confidence 0.83 against 0.9, "
                   "risk 37.4 against 30.0")
    # An analyst's own words are stored data: kept as written, never reworded.
    assert status_change_detail("alice", "Checked with the owner, expected scan") == (
        "Checked with the owner, expected scan (by alice)")
    assert status_change_detail("agent", "") == "By the AI agent"


async def _case_store(*cases: Case) -> CaseStore:
    store = CaseStore(InMemoryESClient())
    for case in cases:
        await store.save(case)
    return store


def _case(case_id: str, number: str | None, *, title: str = "Automated vulnerability scanning from 87.120.104.29",
          status: CaseStatus = CaseStatus.ESCALATED, history: list[StatusHistoryEntry] | None = None,
          related: list[str] | None = None) -> Case:
    now = now_utc()
    return Case(
        case_id=case_id, case_number=number or "", title=title,
        source_surface=SourceSurface.INVESTIGATE,
        cluster_signature=f"sig-{case_id}", entity=Entity(type="ip", value="87.120.104.29"),
        status=status, verdict=Verdict.TRUE_POSITIVE, decision_by=DecisionBy.SYSTEM,
        risk_score=37.4, created_at=(now - timedelta(hours=2)).isoformat(), updated_at=now.isoformat(),
        status_history=history if history is not None else [
            StatusHistoryEntry(from_status="open", to_status="escalated", by="system", at=now.isoformat(),
                               reason="True positive routed to human: tp auto-close disabled.")],
        related_case_ids=list(related or []),
    )


async def test_the_case_entity_names_the_case_by_number_and_its_moves_in_words() -> None:
    store = await _case_store(_case("case-95928c251fb6495e8437078b684528ce", "CASE-000214"))
    out = await GetCaseTool().run(make_ctx(cases=store), case_id="case-95928c251fb6495e8437078b684528ce",
                                  include=["timeline"])
    assert out.ok
    entity = next(a for a in out.artifacts if a.kind == "entity")
    facts = {f["label"]: f["value"] for f in entity.data["facts"]}
    assert facts["Case"] == "CASE-000214"
    assert "case-95928c" not in str(entity.data["facts"])
    timeline = next(a for a in out.artifacts if a.kind == "timeline")
    event = timeline.data["events"][0]
    assert event["label"] == "Open to Escalated"
    assert event["detail"] == "Automatic close of a confirmed threat is off (by the system)"
    assert "->" not in event["label"] and "tp auto-close" not in event["detail"]


async def test_a_case_without_a_number_is_named_by_its_title_never_its_id() -> None:
    related = ["case-aaaa000000000001", "case-aaaa000000000002", "case-aaaa000000000003",
               "case-aaaa000000000004"]
    store = await _case_store(
        _case("case-0123456789abcdef", None, related=related),
        _case(related[0], "CASE-000301"),
        _case(related[1], None, title=""),
        _case(related[3], None),
    )
    original = store.get

    async def get(case_id: str) -> Any:
        if case_id == related[3]:
            raise ConnectionError("store down")
        return await original(case_id)

    store.get = get  # type: ignore[method-assign]
    out = await GetCaseTool().run(make_ctx(cases=store), case_id="case-0123456789abcdef")
    entity = next(a for a in out.artifacts if a.kind == "entity")
    named = next(f for f in entity.data["facts"] if f["label"] == "Case")
    assert named["value"].startswith("Automated vulnerability scanning") and named["untrusted"] is True
    assert "case-0123456789abcdef" not in str(entity.data["facts"])
    # A related case's internal id is its link target, never its visible name: a number
    # and title when read, else a fixed name saying why there is none.
    shown = {r["case_id"]: (r.get("case_number"), r["title"]) for r in entity.data["related_cases"]}
    assert shown[related[0]] == ("CASE-000301", "Automated vulnerability scanning from 87.120.104.29")
    assert shown[related[1]] == (None, "Untitled case")
    assert shown[related[2]] == (None, "Related case, not found")
    assert shown[related[3]] == (None, "Related case, not readable")
    assert all(not title.startswith("case-") for _number, title in shown.values())
    assert_artifacts_render(out)


async def test_the_status_fact_and_the_status_history_name_a_status_the_same_way() -> None:
    now = now_utc().isoformat()
    store = await _case_store(_case(
        "case-0000000000000abc", "CASE-000215", status=CaseStatus.NEEDS_HUMAN,
        history=[StatusHistoryEntry(from_status="new", to_status="needs_human", by="system", at=now,
                                    reason="No confident close decision; routing to human (fail-safe).")],
    ))
    out = await GetCaseTool().run(make_ctx(cases=store), case_id="case-0000000000000abc", include=["timeline"])
    entity = next(a for a in out.artifacts if a.kind == "entity")
    status = next(f["value"] for f in entity.data["facts"] if f["label"] == "Status")
    move = next(a for a in out.artifacts if a.kind == "timeline").data["events"][0]
    assert status == "Open · awaiting analyst"
    assert move["label"] == f"New to {status}"
    assert move["detail"] == "No confident close decision, so a person decides (by the system)"


def test_prefs_default_rule_fields_are_the_ones_these_tests_split() -> None:
    """The identity test above gives ``rule.name`` a value the rule field does not hold."""
    prefs = Preferences()
    assert prefs.rule_field == "event.module" and prefs.rule_name_field == "rule.name"
