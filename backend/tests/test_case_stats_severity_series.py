"""A case severity chart over time draws all five levels (Round 14 SPEC §4.7.1, §4.7.2).

``case_stats`` grouped by severity and bucketed ("Trend of cases by severity over the last
30 days") draws one series per level, Critical to Info, zeros included, in that fixed order
and in each level's palette colour, as the Executive board and the rule sheet do: a level
with no case is a flat line at zero, never a missing one, and a level is never ranked away
or folded into "Other". A case with no readable severity is not a level (it is never
folded into Info); it follows the levels while it has cases. A ``top_n`` request never
cuts a level from the chart: the series is read on its own, every level an exact count,
as the same question asked without a bucket is. (A series builder handed rows a cut
already folded leaves out a level it has no row for rather than drawing it at zero.)
Every other grouping keeps its ranking by volume, and over two groupings the first one's
lines are exact under a ``top_n`` cut too.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from app.agents import blocks as B
from app.agents.chat_tools.common import SEVERITY_LEVELS, resolve_window
from app.agents.chat_tools.stats import _MAX_SERIES, CaseStatsTool, _series_artifacts
from app.api.metrics_shared import invalidate_case_page_cache
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.case_aggregate import AggregateResult
from app.es.fake import InMemoryESClient
from app.models import Case, Entity
from app.stores.cases import CaseStore
from app.utils import now_utc

from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

LEVEL_NAMES = ["Critical", "High", "Medium", "Low", "Info"]


def _case(i: int, band: str, *, hours_ago: int, verdict: Verdict = Verdict.NEEDS_HUMAN) -> Case:
    created = (now_utc() - timedelta(hours=hours_ago)).isoformat()
    return Case(
        case_id=f"case-{i:04d}", case_number=f"CASE-{i:06d}", cluster_signature=f"sig-{i}",
        source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        status=CaseStatus.OPEN, verdict=verdict, confidence=0.8, risk_score=40.0,
        title=f"case {i}", created_at=created, updated_at=created, severity_band=band,
        rule_ids=["ssh brute"], source_id="wazuh",
    )


@pytest.fixture
async def store() -> Any:
    """Six cases over three days: high, critical and medium only (no low, no info)."""
    invalidate_case_page_cache()
    cases = CaseStore(InMemoryESClient())
    bands = ["high", "high", "high", "critical", "medium", "medium"]
    for i, band in enumerate(bands):
        await cases.save(_case(i, band, hours_ago=2 + 20 * i,
                               verdict=Verdict.FALSE_POSITIVE if i % 2 else Verdict.NEEDS_HUMAN))
    yield cases
    invalidate_case_page_cache()


def _series(out: Any) -> Any:
    return next(a for a in out.artifacts if a.kind == "series")


async def test_a_severity_series_draws_all_five_levels_with_zeros(store: Any) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="severity", bucket="day", window="now-7d")
    assert out.ok, out.summary
    artifact = _series(out)
    data = artifact.data
    series = data["series"]
    # Critical to Info, in that order, each in its own palette colour.
    assert [s["label"] for s in series] == LEVEL_NAMES
    assert [s["semantic"] for s in series] == list(SEVERITY_LEVELS)
    assert data["ordered"] is True
    points = len(data["x"])
    assert points >= 7 and all(len(s["values"]) == points for s in series)
    by_label = {s["label"]: s["values"] for s in series}
    # Low and Info had no case: drawn as flat lines at zero, never missing.
    assert by_label["Low"] == [0] * points and by_label["Info"] == [0] * points
    assert [sum(by_label[name]) for name in LEVEL_NAMES] == [1, 3, 2, 0, 0]
    # No "Other" and no "No severity" line: every case has a readable level.
    assert {s["key"] for s in series}.isdisjoint({"other"})
    assert artifact.total == 6
    assert_artifacts_render(out)
    # The chart a person reads keeps the five levels in order, Info included.
    block = B.to_blocks(artifact, B.MaterialiseOptions(block_id="b1"))[0]
    assert block["type"] == "chart"
    assert [s["label"] for s in block["series"]] == LEVEL_NAMES


async def test_a_window_with_no_case_still_draws_the_five_levels(store: Any) -> None:
    """Nothing to count is five flat lines, not one "Cases" line: the levels a person
    reads never depend on what the window happened to hold."""
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="severity", bucket="day",
                                    window="2020-01-01/2020-01-05")
    assert out.ok, out.summary
    series = _series(out).data["series"]
    assert [s["label"] for s in series] == LEVEL_NAMES
    assert all(not any(s["values"]) for s in series)


async def test_a_top_n_request_still_draws_every_level_with_its_exact_count(store: Any) -> None:
    """``top_n=2`` keeps High and Medium in the request's rows, and Critical's case is in
    their "Other" remainder. The chart still draws the five levels, Critical's case on
    Critical's line and no "Other" line, exactly as the same question without a bucket
    lists the five levels."""
    ctx = make_ctx(cases=store)
    out = await CaseStatsTool().run(ctx, group_by="severity", bucket="day", window="now-7d", top_n=2)
    assert out.ok, out.summary
    artifact = _series(out)
    series = artifact.data["series"]
    assert [s["label"] for s in series] == LEVEL_NAMES
    assert [s["semantic"] for s in series] == list(SEVERITY_LEVELS)
    assert [sum(s["values"]) for s in series] == [1, 3, 2, 0, 0]
    assert all(s["key"] != "other" for s in series)
    assert artifact.total == 6
    # The request's own rows keep the cut for the answer's figures.
    assert out.observation["other"]["metrics"]["count"] == 1
    assert_artifacts_render(out)
    unbucketed = await CaseStatsTool().run(ctx, group_by="severity", window="now-7d", top_n=2)
    assert unbucketed.ok, unbucketed.summary
    table = next(a for a in unbucketed.artifacts if a.kind == "categories")
    assert len(table.data["levels"]) == len(LEVEL_NAMES)


async def test_a_top_n_over_two_groupings_never_draws_a_level_short(store: Any) -> None:
    """Over severity and verdict, ``top_n=2`` keeps the two busiest PAIRS: summing them
    would draw High as 2 of its 3 cases and hide the rest in "Other". The series reads the
    levels on their own instead."""
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["severity", "verdict"], bucket="day",
                                    window="now-7d", top_n=2)
    assert out.ok, out.summary
    series = _series(out).data["series"]
    assert [(s["label"], sum(s["values"])) for s in series] == list(zip(LEVEL_NAMES, [1, 3, 2, 0, 0]))
    assert_artifacts_render(out)


async def test_another_first_grouping_is_exact_under_a_top_n_over_two_groupings(store: Any) -> None:
    """The same holds for any first grouping: three false positives and three Needs human
    cases are drawn as 3 and 3, never as the parts of them the busiest pairs held."""
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["verdict", "severity"], bucket="day",
                                    window="now-7d", top_n=2)
    assert out.ok, out.summary
    series = _series(out).data["series"]
    assert [(s["label"], sum(s["values"])) for s in series] == [("False positive", 3), ("Needs human", 3)]


async def test_a_top_n_over_one_other_grouping_keeps_its_cut(store: Any) -> None:
    """Only severity is drawn whole: a ``top_n`` over one verdict grouping keeps the
    busiest values and folds the rest into "Other", as asked."""
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="verdict", bucket="day", window="now-7d",
                                    top_n=1)
    assert out.ok, out.summary
    series = _series(out).data["series"]
    assert [s["label"] for s in series][-1] == "Other"
    assert len(series) == 2 and [sum(s["values"]) for s in series] == [3, 3]


async def test_another_grouping_keeps_its_ranking_and_draws_no_zero_series(store: Any) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="verdict", bucket="day", window="now-7d")
    assert out.ok, out.summary
    series = _series(out).data["series"]
    # Only the verdicts that have cases, in the verdict order; no zero line is added.
    assert [s["label"] for s in series] == ["False positive", "Needs human"]
    assert all(sum(s["values"]) > 0 for s in series)


# --------------------------------------------------------------------------- #
# The series builder on aggregator rows a store push-down can return (an unreadable
# severity, more values than one chart draws).
# --------------------------------------------------------------------------- #
_DAYS = ["2026-11-01", "2026-11-02", "2026-11-03"]


def _rows(counts: dict[Any, list[int]], *, other: bool = False) -> list[dict[str, Any]]:
    return [
        {"key": {"severity": key}, "bucket": day, "bucket_start": f"{day}T00:00:00+00:00",
         "metrics": {"count": values[i]}, **({"other": True} if other else {})}
        for key, values in counts.items() for i, day in enumerate(_DAYS)
    ]


def _build(rows: list[dict[str, Any]], other_rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    result = AggregateResult(total=0, groups=rows + (other_rows or []), buckets=[(d, False) for d in _DAYS],
                             exact=True, consistency="point_in_time", scanned=0)
    window = resolve_window(make_ctx(), window="2026-11-01/2026-11-04")
    assert not isinstance(window, str)
    ids = (f"a{n}" for n in range(1, 100))
    built, _info = _series_artifacts(lambda: next(ids), result, window, "day", rows, other_rows or [],
                                     ["severity"], ("count",), "caption", "exact", False, 0)
    return built[0].data["series"]


def test_an_unreadable_severity_follows_the_five_levels_only_while_it_has_cases() -> None:
    series = _build(_rows({"high": [1, 0, 2], None: [0, 1, 0]}))
    assert [s["label"] for s in series] == [*LEVEL_NAMES, "No severity"]
    # It is not a level: it wears no severity colour and is never folded into Info.
    assert "semantic" not in series[-1] and series[-1]["values"] == [0, 1, 0]
    assert next(s for s in series if s["label"] == "Info")["values"] == [0, 0, 0]
    # With no case it is not drawn at all.
    assert [s["label"] for s in _build(_rows({"high": [1, 0, 2], None: [0, 0, 0]}))] == LEVEL_NAMES


def test_the_levels_are_never_folded_and_extra_values_share_the_remaining_room() -> None:
    """Five levels plus more unreadable values than the chart has room for: the levels
    stay, the busiest extra values fill the room left, the rest fold into "Other"."""
    extras = {f"sev{i}": [10 + i, 0, 0] for i in range(4)}
    series = _build(_rows({"info": [0, 0, 1], **extras}))
    labels = [s["label"] for s in series]
    room = _MAX_SERIES - len(LEVEL_NAMES)
    assert labels[:5] == LEVEL_NAMES
    assert labels[5:] == ["Sev3", "Sev2"][:room] + ["Other"]
    assert series[-1]["values"] == [10 + 11, 0, 0]
    assert len(series) <= B.MAX_SERIES


def test_a_level_with_a_row_under_a_top_n_cut_is_drawn_even_at_zero() -> None:
    """A level the cut kept a row for is a known count, zero included; only a level the
    cut left no row for is unknown."""
    series = _build(_rows({"high": [1, 0, 2], "low": [0, 0, 0]}),
                    _rows({"__other__": [0, 3, 0]}, other=True))
    assert [s["label"] for s in series] == ["High", "Low", "Other"]
    assert series[1]["values"] == [0, 0, 0] and series[-1]["values"] == [0, 3, 0]
