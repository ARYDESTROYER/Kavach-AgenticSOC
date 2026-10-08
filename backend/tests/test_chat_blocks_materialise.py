"""Answer-block materialisation (chat revamp SPEC §7.3, §4.1, BLOCKS.md G4/G5):
artifacts become blocks in every allowed view, numbers only ever come from the
artifact, series order is deterministic, limits and truncation are disclosed, a
stored block changes view without new numbers (``mK.bJ``), report envelopes are
validated, and unknown refs become one quiet notice line."""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.agents import blocks as B
from app.agents.blocks import (
    MaterialiseOptions,
    TurnArtifact,
    materialise_final_blocks,
    parse_final_block_requests,
    revise_view,
    to_blocks,
)
from app.agents.chat_tools.base import Artifact


def _numbers(value: Any) -> set[float]:
    out: set[float] = set()
    if isinstance(value, bool):
        return out
    if isinstance(value, (int, float)):
        out.add(float(value))
    elif isinstance(value, dict):
        for item in value.values():
            out |= _numbers(item)
    elif isinstance(value, list):
        for item in value:
            out |= _numbers(item)
    return out


def _cat(**over: Any) -> Artifact:
    data = {"labels": ["10.0.0.2", "10.0.0.1", "10.0.0.3"], "values": [7, 12, 7],
            "unit": "count", "dimension": "source.ip"}
    data.update(over.pop("data", {}))
    return Artifact(id="a1", kind="categories", title="Top values", data=data,
                    provenance="source", untrusted_labels=True, **over)


ARTIFACTS: dict[str, Artifact] = {
    "categories": _cat(),
    "series": Artifact(id="a1", kind="series", title="Over time", data={
        "x": ["2026-10-08T00:00:00Z", "2026-10-08T01:00:00Z", "2026-10-08T02:00:00Z"],
        "series": [{"key": "small", "label": "Small", "values": [1, None, 2]},
                   {"key": "other", "label": "Other", "values": [50, 50, 50]},
                   {"key": "big", "label": "Big", "values": [9, 8, 7]}],
        "unit": "count", "bucket": "1h"}),
    "funnel": Artifact(id="a1", kind="funnel", title="Noise", data={
        "stages": ["Raw", "Correlated", "Cases"], "values": [1000, 40, 4], "unit": "count"}),
    "kpis": Artifact(id="a1", kind="kpis", title="Posture", data={"items": [
        {"key": "risk", "label": "Active Risk Index", "value": 42, "unit": "score", "display": "gauge"},
        {"key": "mtta", "label": "MTTA", "value": None, "unit": "minutes"}]}),
    "table": Artifact(id="a1", kind="table", title="Rows", provenance="source", untrusted_labels=True,
                      data={"columns": [{"key": "host", "label": "Host"}, {"key": "n", "label": "N", "type": "number"}],
                            "rows": [["web-1", 3], ["db-1", 1]]}),
    "heatmap": Artifact(id="a1", kind="heatmap", title="Hour of week", data={
        "x": ["00", "01"], "y": ["Mon", "Tue"], "cells": [[1, None], [3, 4]], "unit": "count"}),
    "case_list": Artifact(id="a1", kind="case_list", title="Cases", data={"items": [
        {"case_id": "case-1", "title": "Brute force", "verdict": "TRUE_POSITIVE", "status": "open",
         "severity": "high", "risk": 80, "created_at": "2026-10-08T00:00:00Z"}]}),
    "timeline": Artifact(id="a1", kind="timeline", title="Timeline", data={"events": [
        {"at": "2026-10-08T01:00:00Z", "label": "second"}, {"at": "2026-10-08T00:00:00Z", "label": "first"}]}),
    "entity": Artifact(id="a1", kind="entity", title="Indicator", provenance="source", data={
        "entity": {"kind": "ip", "value": "203.0.113.9"}, "risk": 80}),
    "mitre": Artifact(id="a1", kind="mitre", title="Techniques", data={"techniques": [{"id": "T1110", "count": 3}]}),
    "guide": Artifact(id="a1", kind="guide", title="Guide", data={
        "steps": [{"text": "Open Settings"}],
        "links": [{"label": "Sources", "ref": {"page": "settings", "opts": {"section": "sources"}}}]}),
    "query": Artifact(id="a1", kind="query", title="Query", provenance="source",
                      data={"language": "kql", "query": "source.ip:10.0.0.1"}),
}

VIEWS = [(kind, view) for kind, artifact in ARTIFACTS.items() for view in artifact.views()]


@pytest.mark.parametrize("kind,view", VIEWS)
def test_every_allowed_view_materialises_without_new_numbers(kind: str, view: str) -> None:
    artifact = ARTIFACTS[kind]
    blocks = to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view, from_step=2))
    assert len(blocks) == 1
    block = blocks[0]
    expected_view = "line" if (kind, view) == ("series", "sparkline") else view
    assert B.block_view(block) == expected_view
    assert block["provenance"] == artifact.provenance and block["artifact_kind"] == kind
    assert block["id"] == "b1" and block["from_step"] == 2
    assert expected_view in block["allowed_views"]
    # G5: every number in the block came from the artifact data.
    allowed = _numbers(artifact.data) | {2.0}  # from_step
    allowed |= {float(len(v)) for v in artifact.data.values() if isinstance(v, list)}
    assert _numbers({k: v for k, v in block.items() if k not in ("total", "from_step")}) <= allowed
    # The block re-validates as itself (canonical form).
    assert B.validate_blocks([block]) == ([block], [])


def test_categories_sorted_desc_ties_by_label_and_untrusted() -> None:
    block = to_blocks(ARTIFACTS["categories"], MaterialiseOptions(block_id="b1"))[0]
    assert block["kind"] == "hbar"
    assert block["x"]["values"] == ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    assert block["series"][0]["values"] == [12, 7, 7]
    assert block["untrusted"] is True and block["x"]["label"] == "source.ip"
    table = to_blocks(ARTIFACTS["categories"], MaterialiseOptions(block_id="b1", view="table"))[0]
    assert table["columns"][0]["untrusted"] is True
    assert table["rows"] == [["10.0.0.1", 12], ["10.0.0.2", 7], ["10.0.0.3", 7]]


def test_top_n_discloses_truncation_and_window_caption() -> None:
    artifact = _cat(window="last 24h", basis="newest_n")
    block = to_blocks(artifact, MaterialiseOptions(block_id="b1", top_n=2, title="Top source IPs"))[0]
    assert block["x"]["values"] == ["10.0.0.1", "10.0.0.2"]
    assert block["truncated"] is True and block["total"] == 3
    assert block["caption"] == "Top 2 of 3 · Sampled from the newest events · last 24h"
    assert block["title"] == "Top source IPs"


def test_tool_population_total_wins_over_shown_count() -> None:
    artifact = _cat(total=1240, truncated=True)
    block = to_blocks(artifact, MaterialiseOptions(block_id="b1"))[0]
    assert block["total"] == 1240 and block["caption"].startswith("Top 3 of 1,240")


def test_donut_only_for_a_complete_population() -> None:
    complete = to_blocks(_cat(), MaterialiseOptions(block_id="b1", view="donut"))[0]
    assert complete["kind"] == "donut" and "donut" in complete["allowed_views"]
    partial = to_blocks(_cat(truncated=True, total=10), MaterialiseOptions(block_id="b1", view="donut"))[0]
    assert partial["kind"] == "hbar" and "donut" not in partial["allowed_views"]
    folded = to_blocks(_cat(data={"other": 30}), MaterialiseOptions(block_id="b1", view="donut"))[0]
    assert folded["kind"] == "hbar"
    many = _cat(data={"labels": [f"h{i}" for i in range(8)], "values": list(range(8))})
    assert "donut" not in to_blocks(many, MaterialiseOptions(block_id="b1"))[0]["allowed_views"]


def _series(unit: str, rows: list[list[Any]], **over: Any) -> Artifact:
    """A category-axis series artifact: ``rows`` are the series' values."""
    width = max(len(r) for r in rows)
    return Artifact(id="a1", kind="series", title="t", data={
        "x": [f"x{i}" for i in range(width)], "x_kind": "category", "unit": unit,
        "series": [{"key": f"s{i}", "label": f"S{i}", "values": r} for i, r in enumerate(rows)]}, **over)


def test_stacks_and_donuts_are_offered_only_for_values_that_add_up() -> None:
    """WP-INT item 2: a stack draws a slot total and a donut a centre total, so the
    server offers them only where that total means something, as the webui does."""
    # Additive units: always.
    assert "stacked_bar" in to_blocks(_series("tokens", [[1, 2], [3, 4]]), MaterialiseOptions(block_id="b1"))[0]["allowed_views"]
    # Percent parts reconcile to 100 per slot: a 100 % stack is honest.
    shares = _series("percent", [[60, 30], [40, 70]])
    assert "stacked_bar" in B.artifact_views(shares)
    stack = to_blocks(shares, MaterialiseOptions(block_id="b1", view="stacked_bar"))[0]
    assert stack["kind"] == "stacked_bar" and "stacked_bar" in stack["allowed_views"]
    # Rates, scores and durations never stack: the request falls back to the default.
    for unit, rows in (("percent", [[60, 30], [10, 10]]), ("score", [[40, 50], [60, 50]]),
                       ("minutes", [[12, 40], [3, 4]]), ("ms", [[1, 2], [3, 4]])):
        artifact = _series(unit, rows)
        assert "stacked_bar" not in B.artifact_views(artifact), unit
        block = to_blocks(artifact, MaterialiseOptions(block_id="b1", view="stacked_bar"))[0]
        assert block["kind"] == "line" and "stacked_bar" not in block["allowed_views"], unit
    # Donut: a share-of-total percentage or ratio is honest; a median is not.
    pct = _cat(data={"values": [50, 30, 20], "unit": "percent"})
    assert to_blocks(pct, MaterialiseOptions(block_id="b1", view="donut"))[0]["kind"] == "donut"
    ratio = _cat(data={"values": [0.5, 0.25, 0.25], "unit": "ratio"})
    assert "donut" in B.artifact_views(ratio)
    for data in ({"values": [50, 30, 30], "unit": "percent"}, {"values": [12, 7, 7], "unit": "minutes"},
                 {"values": [80, 60, 40], "unit": "score"}, {"values": [50, None, 50], "unit": "percent"}):
        block = to_blocks(_cat(data=data), MaterialiseOptions(block_id="b1", view="donut"))[0]
        assert block["kind"] == "hbar" and "donut" not in block["allowed_views"], data


def test_a_top_n_cut_that_breaks_the_whole_withdraws_the_total_views() -> None:
    """Judged on the block AS SHOWN, as the client's "Show as" menu judges it: the
    first two of three shares no longer make 100 %, and a donut of a clipped top-N is
    not a whole either (even for counts)."""
    three = _series("percent", [[50, 40], [30, 30], [20, 30]])
    assert "stacked_bar" in B.artifact_views(three)
    cut = to_blocks(three, MaterialiseOptions(block_id="b1", view="stacked_bar", top_n=2))[0]
    assert cut["kind"] == "line" and "stacked_bar" not in cut["allowed_views"]
    assert cut["truncated"] is True
    top = to_blocks(_cat(), MaterialiseOptions(block_id="b1", top_n=2))[0]
    assert top["kind"] == "hbar" and "donut" not in top["allowed_views"]
    assert revise_view(top, "donut", block_id="b2") is None
    # A TABLE view is judged on the data read back from it (what an mK.bJ change uses).
    shares = _cat(data={"values": [50, 30, 20], "unit": "percent"})
    whole = to_blocks(shares, MaterialiseOptions(block_id="b1", view="table"))[0]
    assert whole["type"] == "table" and "donut" in whole["allowed_views"]
    assert revise_view(whole, "donut", block_id="b2")["kind"] == "donut"
    clipped = to_blocks(shares, MaterialiseOptions(block_id="b1", view="table", top_n=2))[0]
    assert "donut" not in clipped["allowed_views"]
    table = to_blocks(three, MaterialiseOptions(block_id="b1", view="table", top_n=2))[0]
    assert table["type"] == "table" and "stacked_bar" not in table["allowed_views"]
    assert "stacked_bar" in to_blocks(three, MaterialiseOptions(block_id="b1", view="table"))[0]["allowed_views"]


def test_a_dishonest_stored_view_is_never_rebuilt() -> None:
    """``mK.bJ``: even a stored block that (wrongly) lists ``stacked_bar`` cannot be
    turned into a stack of values that do not add up."""
    stored = to_blocks(_series("minutes", [[12, 40], [3, 4]]), MaterialiseOptions(block_id="b1"))[0]
    forged = dict(stored, allowed_views=["line", "area", "bar", "stacked_bar", "table"])
    assert revise_view(forged, "stacked_bar", block_id="b2") is None
    assert revise_view(forged, "bar", block_id="b2")["allowed_views"] == ["line", "area", "bar", "table"]


def test_open_in_travels_from_the_artifact_through_every_view() -> None:
    """"Open in Logs": the tool-side exact view rides on the artifact data, lands on
    the block in every view, survives an ``mK.bJ`` view change and dumps ``from``
    under its wire name."""
    ref = {"page": "logs", "opts": {"logQuery": "failed password", "from": "now-24h", "to": "now",
                                    "sourceId": "wazuh-prod"}}
    artifact = _cat(data={"open_in": ref})
    for view in ("hbar", "bar", "donut", "table"):
        block = to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view))[0]
        assert block["open_in"] == ref, view
    stored = to_blocks(artifact, MaterialiseOptions(block_id="b1"))[0]
    assert revise_view(stored, "table", block_id="b2")["open_in"] == ref
    query = Artifact(id="a2", kind="query", title="Query", provenance="source",
                     data={"language": "kql", "query": "failed password", "open_in": ref})
    assert to_blocks(query, MaterialiseOptions(block_id="b3"))[0]["open_in"] == ref
    # An invalid ref never sinks the block; it is just not offered.
    broken = to_blocks(_cat(data={"open_in": {"page": "logs", "opts": {"sourceId": "a b"}}}),
                       MaterialiseOptions(block_id="b1"))[0]
    assert "open_in" not in broken and broken["kind"] == "hbar"


def test_series_order_is_deterministic_with_other_last() -> None:
    block = to_blocks(ARTIFACTS["series"], MaterialiseOptions(block_id="b1"))[0]
    assert [s["key"] for s in block["series"]] == ["big", "small", "other"]
    assert block["x"]["kind"] == "time" and block["x"]["bucket"] == "1h"
    assert block["series"][1]["values"] == [1, None, 2]  # null = not measured, never 0
    assert "sparkline" not in block["allowed_views"]


def test_series_point_limit_keeps_the_newest_points() -> None:
    x = [f"2026-10-0{1 + i // 100}T{(i // 4) % 24:02d}:{(i % 4) * 15:02d}:00Z" for i in range(260)]
    artifact = Artifact(id="a1", kind="series", title="t", data={
        "x": x, "series": [{"key": "a", "label": "A", "values": list(range(260))}], "unit": "count"})
    block = to_blocks(artifact, MaterialiseOptions(block_id="b1"))[0]
    assert len(block["x"]["values"]) == B.MAX_POINTS and block["series"][0]["values"][-1] == 259
    assert block["truncated"] is True and block["caption"].startswith("Latest 200 of 260")


def test_kpi_items_clip_to_six_and_keep_not_measured() -> None:
    items = [{"key": f"k{i}", "label": f"K{i}", "value": i, "unit": "count"} for i in range(8)]
    block = to_blocks(Artifact(id="a1", kind="kpis", title="K", data={"items": items}),
                      MaterialiseOptions(block_id="b1"))[0]
    assert len(block["items"]) == 6 and block["truncated"] is True
    mtta = to_blocks(ARTIFACTS["kpis"], MaterialiseOptions(block_id="b1"))[0]["items"][1]
    assert mtta["value"] is None


def test_view_limits_are_disclosed_like_top_n() -> None:
    # Review finding (G4): 300 labels without top_n came back as 200 shown with
    # truncated=True but no total and no caption.
    many = _cat(data={"labels": [f"h{i:03d}" for i in range(300)], "values": list(range(300, 0, -1))})
    for view in ("hbar", "table"):
        block = to_blocks(many, MaterialiseOptions(block_id="b1", view=view))[0]
        shown = len(block["rows"]) if view == "table" else len(block["x"]["values"])
        assert shown == 200 and block["truncated"] is True and block["total"] == 300
        assert block["caption"].startswith("Top 200 of 300")


def test_table_column_clipping_and_invalid_kpis_are_disclosed() -> None:
    columns = [{"key": f"c{i}", "label": f"C{i}", "type": "text"} for i in range(15)]
    table = Artifact(id="a1", kind="table", title="Wide", provenance="code",
                     data={"columns": columns, "rows": [[f"v{i}" for i in range(15)]] * 3})
    block = to_blocks(table, MaterialiseOptions(block_id="b1"))[0]
    assert len(block["columns"]) == 12 and all(len(r) == 12 for r in block["rows"])
    assert block["truncated"] is True and "First 12 of 15 columns" in block["caption"]
    items = [{"key": "a", "label": "A", "value": 1, "unit": "count"},
             {"key": "b", "label": "B", "value": 2, "unit": "parsecs"}]
    block = to_blocks(Artifact(id="a1", kind="kpis", title="K", data={"items": items}),
                      MaterialiseOptions(block_id="b1"))[0]
    assert [i["key"] for i in block["items"]] == ["a"]
    assert block["truncated"] is True and block["total"] == 2 and block["caption"].startswith("Showing 1 of 2")


def test_an_explicit_caption_keeps_the_truncation_phrase() -> None:
    # A stored caption predates storage compaction: the re-view must still say the
    # data is partial instead of silently reusing the old caption.
    stored = to_blocks(_cat(window="last 24h"), MaterialiseOptions(block_id="b1"))[0]
    assert stored["caption"] == "last 24h"
    compact = dict(stored, downsampled_for_storage=True)
    revised = revise_view(compact, "table", block_id="b2")
    assert revised["truncated"] is True and revised["caption"].endswith("last 24h")
    assert revised["caption"] != "last 24h"
    clipped = to_blocks(_cat(), MaterialiseOptions(block_id="b1", top_n=1, caption="Night shift"))[0]
    assert clipped["caption"] == "Top 1 of 3 · Night shift"


def test_timeline_keeps_the_newest_ascending() -> None:
    block = to_blocks(ARTIFACTS["timeline"], MaterialiseOptions(block_id="b1"))[0]
    assert [e["label"] for e in block["events"]] == ["first", "second"]


def test_invalid_view_falls_back_and_bad_artifacts_yield_nothing() -> None:
    block = to_blocks(ARTIFACTS["funnel"], MaterialiseOptions(block_id="b1", view="donut"))[0]
    assert block["kind"] == "funnel"
    broken = Artifact(id="a1", kind="kpis", title="K", data={"items": []})
    assert to_blocks(broken, MaterialiseOptions(block_id="b1")) == []

    class Fake:
        kind, data, provenance = "categories", {"labels": ["a"], "values": [1], "unit": "count"}, "ai"

    assert to_blocks(Fake(), MaterialiseOptions(block_id="b1")) == []  # G5


# --------------------------------------------------------------------------- #
# mK.bJ view changes.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", ["categories", "series", "funnel", "kpis", "heatmap", "case_list", "timeline"])
def test_revise_view_round_trips_through_every_view(kind: str) -> None:
    artifact = ARTIFACTS[kind]
    stored = to_blocks(artifact, MaterialiseOptions(block_id="b1"))[0]
    for view in stored["allowed_views"]:
        revised = revise_view(stored, view, block_id="b9")
        assert revised is not None, view
        assert B.block_view(revised) == view and revised["id"] == "b9"
        assert revised["provenance"] == artifact.provenance
        assert _numbers({k: v for k, v in revised.items() if k != "total"}) <= (
            _numbers(stored) | {float(len(v)) for v in artifact.data.values() if isinstance(v, list)})
        back = revise_view(revised, B.block_view(stored), block_id="b1")
        assert back is not None and B.block_view(back) == B.block_view(stored)


def test_revise_view_chart_to_table_and_back_keeps_values() -> None:
    stored = to_blocks(ARTIFACTS["categories"], MaterialiseOptions(block_id="b1"))[0]
    table = revise_view(stored, "table", block_id="b2", title="As a table")
    assert table["title"] == "As a table" and table["rows"][0] == ["10.0.0.1", 12]
    donut = revise_view(table, "donut", block_id="b3")
    assert donut["kind"] == "donut" and donut["series"][0]["values"] == [12, 7, 7]


def test_revise_view_refuses_what_it_cannot_do() -> None:
    stored = to_blocks(ARTIFACTS["categories"], MaterialiseOptions(block_id="b1"))[0]
    assert revise_view(stored, "line", block_id="b2") is None          # not an allowed view
    assert revise_view(B.expire_block(stored), "bar", block_id="b2") is None
    markdown = {"id": "m1", "type": "markdown", "provenance": "ai", "text": "x"}
    assert revise_view(markdown, "markdown", block_id="b2") is None
    compact = dict(stored, downsampled_for_storage=True)
    revised = revise_view(compact, "bar", block_id="b2")
    assert revised["truncated"] is True and "donut" not in revised["allowed_views"]


# --------------------------------------------------------------------------- #
# Final-header resolution.
# --------------------------------------------------------------------------- #
def _turn(ref: str = "t2.a1", artifact: Artifact | None = None) -> dict[str, TurnArtifact]:
    return {ref: TurnArtifact(ref=ref, artifact=artifact or ARTIFACTS["categories"], from_step=3)}


def _final(raw: list[Any], **kw: Any) -> B.MaterialisedFinal:
    requests, dropped = parse_final_block_requests(raw)
    assert dropped == []
    return materialise_final_blocks(requests, **kw)


def test_artifact_refs_resolve_with_view_title_and_top_n() -> None:
    out = _final([{"ref": "t2.a1", "view": "bar", "title": "IPs", "top_n": 1}], artifacts=_turn())
    (block,) = out.blocks
    assert block["kind"] == "bar" and block["title"] == "IPs" and block["x"]["values"] == ["10.0.0.1"]
    assert block["from_step"] == 3 and out.resolved_refs == ["t2.a1"] and out.unresolved == []


def test_unknown_refs_become_one_quiet_notice_never_numbers() -> None:
    out = _final([{"ref": "t9.a1"}, {"ref": "t2.a1"}, {"ref": "m4.b1"}], artifacts=_turn())
    assert [b["type"] for b in out.blocks] == ["chart", "callout"]
    notice = out.blocks[-1]
    assert notice["provenance"] == "code" and notice["tone"] == "info"
    assert notice["text"] == "2 requested items were not available from this turn's results."
    assert _numbers(notice) == set()


def test_stored_ref_changes_view_only() -> None:
    stored = {"m3": [{"id": "b1", "type": "markdown", "provenance": "ai", "text": "x"},
                     to_blocks(ARTIFACTS["categories"], MaterialiseOptions(block_id="b2"))[0]]}
    out = _final([{"ref": "m3.b2", "view": "donut"}, {"ref": "m3.b2", "view": "line"}], stored=stored)
    first, second = out.blocks
    assert first["kind"] == "donut" and first["series"][0]["values"] == [12, 7, 7]
    assert second["kind"] == "hbar"  # a disallowed view keeps the stored view
    assert first["id"] != second["id"]


def test_expired_stored_ref_says_so() -> None:
    stub = B.expire_block(to_blocks(ARTIFACTS["categories"], MaterialiseOptions(block_id="b1"))[0])
    out = _final([{"ref": "m1.b1", "view": "bar"}], stored={"m1": [stub]})
    assert out.expired == ["m1.b1"] and out.blocks[-1]["text"] == B.EXPIRED_NOTICE


def test_model_written_blocks_are_ai_and_numbers_are_rejected() -> None:
    raw = [
        {"type": "callout", "tone": "warning", "text": "Partial data", "provenance": "code", "id": "x"},
        {"type": "markdown", "text": "**Note**"},
        {"type": "chart", "kind": "bar", "unit": "count", "x": {"values": ["a"]},
         "series": [{"key": "s", "label": "S", "values": [99]}]},
    ]
    requests, dropped = parse_final_block_requests(raw)
    assert len(requests) == 2 and dropped[0].type == "chart"
    out = materialise_final_blocks(requests)
    assert [b["provenance"] for b in out.blocks] == ["ai", "ai"]
    assert 99.0 not in _numbers(out.blocks)


def test_report_envelope_resolves_leaves_and_counts_as_one_block() -> None:
    raw = [{"type": "report", "title": "Shift brief", "template": "shift", "sections": [
        {"heading": "Summary", "items": [{"type": "markdown", "text": "Quiet."}]},
        {"heading": "Top IPs", "items": [{"ref": "t2.a1", "view": "table"}, {"ref": "t7.a1"}]},
        {"heading": "Empty", "items": [{"ref": "t8.a1"}]},
    ]}]
    out = _final(raw, artifacts=_turn(), generated_at="2026-10-08T10:00:00Z", window_label="last 24h",
                 sources=["Primary", ""])
    report = out.blocks[0]
    assert report["type"] == "report" and report["provenance"] == "ai" and report["template"] == "shift"
    assert report["scope"] == {"window_label": "last 24h", "sources": ["Primary"],
                               "generated_at": "2026-10-08T10:00:00Z"}
    assert [s["heading"] for s in report["sections"]] == ["Summary", "Top IPs"]
    assert report["sections"][1]["blocks"][0]["type"] == "table"
    assert out.unresolved == ["t7.a1", "t8.a1"] and out.blocks[-1]["type"] == "callout"
    ids = [report["id"]] + [b["id"] for s in report["sections"] for b in s["blocks"]]
    assert len(ids) == len(set(ids))


def test_report_without_any_resolved_leaf_is_replaced_by_a_notice() -> None:
    raw = [{"type": "report", "title": "Brief", "sections": [{"heading": "x", "items": [{"ref": "t5.a1"}]}]}]
    out = _final(raw)
    assert [b["type"] for b in out.blocks] == ["callout"]
    assert "could not be built" in out.blocks[0]["text"] or "not available" in out.blocks[0]["text"]


def test_report_envelope_limits_clip_and_count_instead_of_dropping_the_brief() -> None:
    # 50 leaves over 10 sections: the first 40 are kept (the 40-leaf budget), the
    # other 10 are counted in the one notice instead of the whole brief vanishing.
    too_many = [{"type": "report", "title": "Big", "sections": [
        {"heading": f"S{i}", "items": [{"type": "markdown", "text": "x"}] * 5} for i in range(10)]}]
    requests, dropped = parse_final_block_requests(too_many)
    assert dropped == [] and requests[0].invalid_items == 10
    assert sum(len(s.items) for s in requests[0].sections) == B.MAX_REPORT_LEAVES
    out = materialise_final_blocks(requests)
    leaves = [leaf for s in out.blocks[0]["sections"] for leaf in s["blocks"]]
    assert len(leaves) == B.MAX_REPORT_LEAVES
    assert out.blocks[-1]["text"] == B.UNUSABLE_NOTICE_MANY.format(n=10)
    # More than 12 sections: the extra sections' leaves are counted too.
    sections = [{"heading": f"S{i}", "items": [{"type": "markdown", "text": "x"}]} for i in range(14)]
    requests, _ = parse_final_block_requests([{"type": "report", "title": "Long", "sections": sections}])
    assert len(requests[0].sections) == B.MAX_REPORT_SECTIONS and requests[0].invalid_items == 2


def test_report_envelope_tolerates_extra_keys_and_the_blocks_alias() -> None:
    # Review finding: BLOCKS.md's own report keys (subtitle, id, section summary,
    # section ``blocks``) made the envelope fail ``extra_forbidden`` and the brief
    # vanished with no notice. They are now read (subtitle/summary) or ignored (id).
    raw = [{"type": "report", "id": "r1", "title": "Shift brief", "subtitle": "Night shift",
            "template": "shift", "provenance": "code", "invalid_items": -5, "sections": [
                {"id": "s9", "heading": "Summary", "summary": "Quiet night.",
                 "blocks": [{"type": "markdown", "text": "Nothing urgent."}]},
                {"heading": "Top IPs", "items": [{"ref": "t2.a1", "id": "zz", "provenance": "source"}]},
            ]}]
    requests, dropped = parse_final_block_requests(raw)
    assert dropped == [] and requests[0].invalid_items == 0  # the model's claim is overwritten
    out = materialise_final_blocks(requests, artifacts=_turn())
    (report,) = out.blocks
    assert report["provenance"] == "ai" and report["subtitle"] == "Night shift"
    assert [s["heading"] for s in report["sections"]] == ["Summary", "Top IPs"]
    assert report["sections"][0]["summary"] == "Quiet night."
    assert report["sections"][0]["blocks"][0]["text"] == "Nothing urgent."
    assert report["sections"][1]["blocks"][0]["type"] == "chart"


@pytest.mark.parametrize("blank", ["", "   ", "\n\t", None])
def test_blank_optional_report_text_becomes_none_instead_of_losing_the_brief(blank: Any) -> None:
    # A provider model may send ``subtitle: ""``/``null`` or a blank section summary.
    # The length bound used to run on the ``None`` the sanitiser returned and fail with
    # "NoneType has no len()", losing the WHOLE envelope (or the section).
    raw = [{"type": "report", "title": "Brief", "subtitle": blank, "sections": [
        {"heading": "Summary", "summary": blank, "items": [{"type": "markdown", "text": "Quiet."}]}]}]
    requests, dropped = parse_final_block_requests(raw)
    assert dropped == [] and len(requests) == 1
    assert requests[0].subtitle is None and requests[0].sections[0].summary is None
    out = materialise_final_blocks(requests)
    (report,) = out.blocks
    assert report["type"] == "report" and report["sections"][0]["blocks"][0]["text"] == "Quiet."
    assert "subtitle" not in report or report["subtitle"] is None
    direct = B.ReportEnvelopeRequest.model_validate(raw[0])
    assert direct.subtitle is None


def test_blank_or_invalid_optional_block_fields_never_fail_the_block() -> None:
    # Every ``_opt_text_type`` field (and the optional timestamp) shares the fix: an
    # explicit null, a blank value or an unparseable timestamp is simply absent.
    block = {"type": "markdown", "id": "b1", "provenance": "ai", "text": "hello",
             "title": None, "caption": "  ", "fallback_text": "", "as_of": "not-a-time"}
    blocks, _ = B.validate_blocks([block])
    assert len(blocks) == 1 and blocks[0]["text"] == "hello"
    assert all(blocks[0].get(key) is None for key in ("title", "caption", "fallback_text", "as_of"))
    over = B.ReportEnvelopeRequest.model_validate({"type": "report", "title": "T", "subtitle": "x" * 500,
                                                   "sections": [{"heading": "H", "items": [
                                                       {"type": "markdown", "text": "y"}]}]})
    assert over.subtitle is not None and len(over.subtitle) <= 200


def test_report_envelope_counts_bad_leaves_and_names_missing_headings() -> None:
    raw = [{"type": "report", "title": "", "sections": [
        {"items": [{"type": "markdown", "text": "kept"}, {"ref": "t01.a1"}, {"type": "chart", "kind": "bar"}]},
    ]}]
    requests, dropped = parse_final_block_requests(raw)
    assert dropped == [] and requests[0].invalid_items == 2
    out = materialise_final_blocks(requests)
    report, notice = out.blocks
    assert report["title"] == "Report" and report["sections"][0]["heading"] == "Details"
    assert notice["provenance"] == "code" and notice["text"] == B.UNUSABLE_NOTICE_MANY.format(n=2)


def test_parse_level_drops_reach_the_notice() -> None:
    # A malformed ref (``t01.a1``) or a model-written data block is dropped by the
    # parser; passing the drops in makes the same quiet callout say so.
    raw = [{"ref": "t2.a1"}, {"ref": "t01.a1"}, {"type": "report", "title": "Brief", "sections": []}]
    requests, dropped = parse_final_block_requests(raw)
    assert len(requests) == 1 and [d.type for d in dropped] == [None, "report"]
    out = materialise_final_blocks(requests, artifacts=_turn(), dropped_requests=dropped)
    assert [b["type"] for b in out.blocks] == ["chart", "callout"]
    assert out.blocks[-1]["text"] == f"{B.UNUSABLE_NOTICE_ONE} {B.REPORT_EMPTY_NOTICE}"
    assert _numbers(out.blocks[-1]) == set()


def test_repeated_identical_refs_materialise_once() -> None:
    out = _final([{"ref": "t2.a1"}] * 12 + [{"ref": "t2.a1", "view": "table"}], artifacts=_turn())
    assert [B.block_view(b) for b in out.blocks] == ["hbar", "table"]
    report = [{"type": "report", "title": "R", "sections": [
        {"heading": "A", "items": [{"ref": "t2.a1"}, {"ref": "t2.a1"}]}, {"heading": "B", "items": [{"ref": "t2.a1"}]}]}]
    out = _final(report, artifacts=_turn())
    assert [len(s["blocks"]) for s in out.blocks[0]["sections"]] == [1]


def test_block_limit_and_size_cap() -> None:
    raw = [{"ref": "t2.a1", "top_n": i + 1} for i in range(15)]
    requests, dropped = parse_final_block_requests(raw)
    assert len(requests) == B.MAX_BLOCKS_PER_MESSAGE and len(dropped) == 3
    out = materialise_final_blocks(requests, artifacts=_turn())
    assert len(out.blocks) == B.MAX_BLOCKS_PER_MESSAGE
    assert len(json.dumps(out.blocks)) <= B.MAX_BLOCKS_BYTES


def test_tool_call_header_offers_only_the_views_to_blocks_would_keep() -> None:
    """``Artifact.views`` IS ``blocks.artifact_views`` (SPEC A15), so the TRUSTED
    header never invites the model into a view the materialiser would refuse."""
    from app.agents.chat_tools.base import render_tool_call_header

    minutes = Artifact(id="a1", kind="series", title="Response times", data={
        "x": ["2026-10-08T00:00:00Z", "2026-10-08T01:00:00Z"],
        "series": [{"key": "mtta", "label": "MTTA", "values": [12, 9]},
                   {"key": "mttr", "label": "MTTR", "values": [40, 31]}],
        "unit": "minutes"})
    truncated = _cat(truncated=True, total=40)
    for artifact in (minutes, truncated):
        assert artifact.views() == B.artifact_views(artifact)
    assert "stacked_bar" not in minutes.views() and "sparkline" not in minutes.views()
    assert "donut" not in truncated.views()
    header = render_tool_call_header(3, "soc_metrics", "ok", "done", [minutes, truncated])
    assert "t3.a1 series" in header and "stacked_bar" not in header and "donut" not in header
    # Whatever the header lists, the materialiser keeps.
    for artifact in (minutes, truncated):
        for view in artifact.views():
            (block,) = to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view))[:1]
            assert B.block_view(block) == view
    complete = _cat()
    assert "donut" in complete.views()  # a complete count population still offers it
