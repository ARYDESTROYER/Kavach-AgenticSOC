"""A compact report digest keeps the chart lines that carry cases (Round 14 FX6c).

A case severity trend draws Critical to Info, zeros included (SPEC §4.7.2), so its first
lines can be flat zero. When a digest level has room for fewer lines than the chart
draws, the lines with a non-zero figure are kept first, in the chart's own order, and
the zero lines it leaves out are named, so the AI summary never describes only empty
levels while the ones holding every case go unnamed.
"""

from __future__ import annotations

from typing import Any

from app.engine import report_digest as RD

LEVELS = ["Critical", "High", "Medium", "Low", "Info"]


def _severity_trend(values: dict[str, list[int | None]]) -> dict[str, Any]:
    return {
        "type": "chart", "kind": "stacked_bar", "title": "Cases by severity and day", "unit": "count",
        "x": {"kind": "time", "values": ["1 Nov", "2 Nov", "3 Nov"]},
        "series": [{"key": f"s{i + 1}", "label": name, "values": values.get(name, [0, 0, 0])}
                   for i, name in enumerate(LEVELS)],
    }


BLOCK = _severity_trend({"Medium": [4, 9, 12], "Low": [20, 18, 30]})


def _lines(digest: dict[str, Any]) -> list[str]:
    return [s["series"] for s in digest["series"]]


def test_every_line_in_chart_order_when_the_level_has_room() -> None:
    digest = RD._chart(BLOCK, RD._LEVELS[0])
    assert _lines(digest) == LEVELS
    assert "series_omitted" not in digest and "zero_series" not in digest


def test_a_cut_keeps_the_lines_with_cases_in_chart_order_and_names_the_zero_ones() -> None:
    # Room for four lines: the one zero line left out is Info, and the summary is told
    # it measured zero.
    digest = RD._chart(BLOCK, RD._LEVELS[1])
    assert _lines(digest) == ["Critical", "High", "Medium", "Low"]
    assert digest["series_omitted"] == 1 and digest["zero_series"] == ["Info"]
    # Room for two lines: Medium and Low, never two flat zeros.
    digest = RD._chart(BLOCK, RD._LEVELS[2])
    assert _lines(digest) == ["Medium", "Low"]
    assert digest["series"][1] == {"series": "Low", "min": 18, "max": 30, "last": 30, "trend": "up"}
    assert digest["series_omitted"] == 3 and digest["zero_series"] == ["Critical", "High"]


def test_the_smallest_figure_level_keeps_the_first_line_with_cases() -> None:
    digest = RD._chart(BLOCK, RD._LEVELS[RD._RICHEST_COMPACT_LEVEL])
    assert _lines(digest) == ["Medium"]
    assert digest["series_omitted"] == 4
    # That level lists no labels, so it names no zero line either.
    assert "zero_series" not in digest


def test_a_line_that_was_not_measured_is_never_called_zero() -> None:
    block = _severity_trend({"Critical": [None, None, None], "Medium": [4, 9, 12]})
    digest = RD._chart(block, RD._LEVELS[2])
    # Medium carries cases; the room left goes to the next line in chart order.
    assert _lines(digest) == ["Critical", "Medium"]
    assert digest["series"][0]["max"] == "not measured"
    # The unmeasured line is shown as such; only measured zeros are named as zero.
    assert digest["zero_series"] == ["High", "Low"]
    left_out = RD._chart(_severity_trend({"Critical": [None, None, None], "Low": [1, 0, 0], "Info": [2, 0, 0]}),
                         RD._LEVELS[2])
    assert _lines(left_out) == ["Low", "Info"]
    assert left_out["zero_series"] == ["High", "Medium"]


def test_a_stacked_category_chart_lists_the_lines_with_cases_first() -> None:
    block = {**BLOCK, "x": {"kind": "category", "values": ["web-01", "web-02", "db-01"]}, "kind": "stacked_bar"}
    digest = RD._chart(block, RD._LEVELS[2])
    assert digest["series"] == ["Medium", "Low"]
    assert digest["categories"][0] == {"label": "db-01", "value": 42}
