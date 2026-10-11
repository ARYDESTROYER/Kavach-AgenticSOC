"""Round 12 final review, L2 (blocks, report scope, captions): nothing a person reads
under a block or in a report header is clipped or misnamed.

* A comparison tile's context ("<baseline>: <value> · <change> · n < 20") keeps every
  figure: only the period's name gives way, and the name is in the same human words as
  the subject period (never an ISO range with "(UTC)").
* A block caption is bounded only by the caption limit, so the tool's scope statement
  (with its zone and the "a case can count under several rules" disclosure) is whole.
* "Top N of M" counts one thing: M is the categories' own population, never the cases.
* A report item's scope window is the window its own blocks state, in Round 12 words
  ("last 90 days", "all time (since …)", "Q3 2026"), and a step's raw input
  ("now-90d") is never shown as a window.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.agents.blocks import (
    MAX_CAPTION,
    MAX_LABEL,
    SMALL_SAMPLE_N,
    MaterialiseOptions,
    format_change_pct,
    format_unit_value,
    to_blocks,
    validate_blocks,
)
from app.agents.chat_tools.base import Artifact
from app.agents.chat_tools.common import align_to_bucket, resolve_window
from app.agents.chat_tools.metrics import SocMetricsTool
from app.agents.chat_tools.periods import comparison_caption, range_label, resolve_periods
from app.agents.chat_tools.stats import CaseStatsTool
from app.api.metrics_shared import invalidate_case_page_cache
from app.api.routes_reports import _caption_window, _join_windows, save_answer_as_report
from app.config import Preferences
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import REPORT_SCOPE_WINDOW_CHARS, Case, Entity, ReportItemScope
from app.stores.cases import CaseStore

from tests.test_chat_tools_support import make_ctx
from tests.test_reports_routes import add, harness, seed_answer

NOW = datetime.now(timezone.utc).replace(second=0, microsecond=0)
LONG_ZONE = "America/Argentina/Buenos_Aires"
ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _prefs(tz: str) -> Preferences:
    prefs = Preferences()
    prefs.sla.timezone = tz
    return prefs


def _case(i: int, days: float, rules: list[str], verdict: Verdict | None = Verdict.FALSE_POSITIVE) -> Case:
    created = (NOW - timedelta(days=days)).isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=f"203.0.113.{i % 250}"), status=CaseStatus.CLOSED,
        verdict=verdict, confidence=0.8, risk_score=40.0, title=f"Case {i}", rule_ids=rules,
        created_at=created, updated_at=created, member_event_ids=[f"evt-{i}"],
    )


@pytest.fixture
async def store() -> CaseStore:
    """39 cases over 7 rules (each case under two of them), spread over 70 days."""
    invalidate_case_page_cache()
    cases = CaseStore(InMemoryESClient())
    rules = [f"rule_{n}" for n in range(7)]
    for i in range(39):
        verdict = Verdict.TRUE_POSITIVE if i % 3 == 0 else Verdict.FALSE_POSITIVE
        await cases.save(_case(i, 1 + (i * 1.7), [rules[i % 7], rules[(i + 3) % 7]], verdict))
    yield cases
    invalidate_case_page_cache()


def _materialise(artifact: Artifact, view: str | None = None, **options: Any) -> dict[str, Any]:
    made = to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view, **options))
    kept, dropped = validate_blocks(made)
    assert kept and not dropped, [d.reason for d in dropped]
    return kept[0]


def _artifact(out: Any, kind: str) -> Artifact:
    return next(a for a in out.artifacts if a.kind == kind)


def _time_of_day_window() -> dict[str, str]:
    """A window to the minute that is not midnight-aligned in any zone tested."""
    start = (NOW - timedelta(days=38)).replace(hour=5, minute=37)
    end = (NOW - timedelta(hours=1)).replace(minute=13)
    return {"from": start.strftime("%Y-%m-%dT%H:%M"), "to": end.strftime("%Y-%m-%dT%H:%M")}


def _expected_tail(row: dict[str, Any]) -> str:
    tail = f": {format_unit_value(row['values'][-2], row['unit'])}"
    change = format_change_pct(row.get("delta_pct"), row.get("new"))
    if change != "—":
        tail += f" · {change}"
    if row.get("small_sample"):
        tail += f" · n < {SMALL_SAMPLE_N}"
    return tail


# --------------------------------------------------------------------------- #
# 1. Comparison tiles keep every figure; period names are human and zone-free.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("tz", ["UTC", "Asia/Kolkata", LONG_ZONE])
async def test_comparison_tiles_keep_baseline_change_and_flag(store: CaseStore, tz: str) -> None:
    ctx = make_ctx(cases=store, prefs=_prefs(tz))
    outs = [
        await CaseStatsTool().run(ctx, window=_time_of_day_window(), metrics=["count", "fp_rate"],
                                  compare="previous_period"),
        await SocMetricsTool().run(ctx, kind="posture", window=_time_of_day_window(), compare="previous_period"),
    ]
    for out in outs:
        assert out.ok, out.error
        artifact = _artifact(out, "comparison")
        periods = artifact.data["periods"]
        for period in periods:
            # Human words for both periods, never the ISO fallback or a zone per name.
            assert not ISO_DAY.search(period["label"]), period["label"]
            assert "(" not in period["label"] and len(period["label"]) <= MAX_LABEL
        baseline = periods[-2]["label"]
        # The zone is named once, at the end of the caption, and never clipped.
        caption = artifact.window
        assert caption.endswith(f"({tz})") == (tz != "UTC") and "…" not in caption
        tiles = _materialise(artifact, "kpi_group")
        assert tiles["caption"].endswith(caption)
        rows = {r["key"]: r for r in artifact.data["rows"]}
        flagged = 0
        for item in tiles["items"]:
            row = rows[item["key"]]
            context = item["context"]
            assert len(context) <= MAX_LABEL
            assert context.endswith(_expected_tail(row)), (context, _expected_tail(row))
            assert context.startswith(baseline) or context.startswith(baseline[:10])
            flagged += context.endswith(f"n < {SMALL_SAMPLE_N}")
            if "delta" in item:
                assert item["delta"]["period_label"] == f"vs {baseline}"
        # A small sample is flagged in full on at least one tile (the FP rate).
        assert flagged >= 1


def test_comparison_tile_clips_only_the_period_name() -> None:
    long_name = "a period with a name far longer than any tile can show in full"
    artifact = Artifact(
        id="a1", kind="comparison", title="Comparison", data={
            "periods": [{"label": long_name}, {"label": "this period"}],
            "rows": [{"key": "cost", "label": "AI spend", "unit": "usd", "values": [1234567.89, 2345678.91],
                      "small_sample": True}],
        }, provenance="code", window="this period vs earlier",
    )
    tiles = _materialise(artifact, "kpi_group")
    item = tiles["items"][0]
    tail = _expected_tail({**artifact.data["rows"][0], "delta_pct": (2345678.91 - 1234567.89) / 1234567.89 * 100})
    assert item["context"].endswith(tail) and "…" in item["context"]
    assert len(item["context"]) == MAX_LABEL
    assert item["delta"]["period_label"].startswith("vs a period") and len(item["delta"]["period_label"]) <= MAX_LABEL


def test_range_label_fallback_is_human_and_names_no_zone() -> None:
    start = datetime(2026, 7, 26, 23, 45, tzinfo=timezone.utc)
    end = datetime(2026, 9, 3, 8, 30, tzinfo=timezone.utc)
    assert range_label(start, end, "UTC") == "26 Jul 23:45 – 3 Sep 2026 08:30"
    assert range_label(start, end, LONG_ZONE) == "26 Jul 20:45 – 3 Sep 2026 05:30"
    assert range_label(start - timedelta(days=365), end, "UTC") == "26 Jul 2025 23:45 – 3 Sep 2026 08:30"
    assert range_label(start, start + timedelta(minutes=30), "UTC") == "26 Jul 23:45 – 27 Jul 2026 00:15"
    morning = datetime(2026, 7, 26, 10, 0, tzinfo=timezone.utc)
    assert range_label(morning, morning + timedelta(minutes=30), "UTC") == "26 Jul 2026 10:00 – 10:30"


def test_comparison_caption_names_the_zone_only_when_a_period_was_cut_in_it() -> None:
    kolkata = make_ctx(prefs=_prefs("Asia/Kolkata"))
    trailing = resolve_window(kolkata, window="now-90d")
    periods = resolve_periods(kolkata, trailing, "previous_period")
    assert comparison_caption(periods) == "last 90 days vs previous 90 days"
    month = resolve_window(kolkata, window="2026-09")
    periods = resolve_periods(kolkata, month, "previous_period")
    assert comparison_caption(periods) == "Sep 2026 vs Aug 2026 (Asia/Kolkata)"
    aligned = align_to_bucket(resolve_window(kolkata, window="now-6M"), "month")
    periods = resolve_periods(kolkata, aligned, "previous_period")
    assert [p.label for p in periods][-1].endswith(")") and "Asia/Kolkata" not in periods[-1].label
    assert comparison_caption(periods).endswith(" (Asia/Kolkata)")


# --------------------------------------------------------------------------- #
# 2. Captions are bounded by the caption limit only: disclosures stay whole.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("tz", ["UTC", "Asia/Kolkata"])
async def test_multi_valued_grouping_caption_keeps_the_overlap_disclosure(store: CaseStore, tz: str) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store, prefs=_prefs(tz)), group_by=["rule"], top_n=5,
                                    window="all")
    assert out.ok, out.error
    block = _materialise(_artifact(out, "categories"))
    assert block["caption"].endswith("a case can count under several rules"), block["caption"]
    assert "…" not in block["caption"] and len(block["caption"]) <= MAX_CAPTION
    if tz != "UTC":
        assert f"({tz})" in block["caption"]


async def test_kpi_caption_keeps_a_long_zone_name(store: CaseStore) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store, prefs=_prefs(LONG_ZONE)), window=_time_of_day_window())
    assert out.ok, out.error
    block = _materialise(out.artifacts[0])
    assert block["caption"].endswith(f"({LONG_ZONE})") and "…" not in block["caption"]


# --------------------------------------------------------------------------- #
# 3. "Top N of M": M is the population of what is shown.
# --------------------------------------------------------------------------- #
async def test_case_stats_top_n_counts_categories_not_cases(store: CaseStore) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["rule"], top_n=5, window="all")
    artifact = _artifact(out, "categories")
    assert artifact.total == 7 and artifact.truncated is True     # 7 rules, not 39 cases
    block = _materialise(artifact)
    assert block["total"] == 7
    assert block["caption"].startswith("Top 5 of 7 · 39 cases · exact · ")
    # Complete groupings keep their own population too.
    whole = await CaseStatsTool().run(make_ctx(cases=store), group_by=["verdict"], window="all")
    verdicts = _artifact(whole, "categories")
    assert verdicts.truncated is False and verdicts.total == len(verdicts.data["labels"])


def test_a_clip_of_a_complete_artifact_is_n_of_what_it_holds() -> None:
    """A complete severity breakdown whose ``total`` is the case count: a top_n view
    of it reads "Top 3 of 5" (severities), never "Top 3 of 95" (cases)."""
    artifact = Artifact(
        id="a2", kind="categories", title="Cases by severity", provenance="code", total=95,
        data={"labels": ["critical", "high", "medium", "low", "info"], "values": [5, 20, 40, 20, 10],
              "unit": "count", "dimension": "severity"},
        window="95 cases · exact · last 90 days",
    )
    block = _materialise(artifact, "hbar", top_n=3)
    assert block["total"] == 5 and block["caption"].startswith("Top 3 of 5 · 95 cases")
    clipped = Artifact(
        id="a3", kind="categories", title="Top IPs", provenance="source", total=1240, truncated=True,
        data={"labels": ["a", "b", "c"], "values": [3, 2, 1], "unit": "count"},
    )
    assert _materialise(clipped)["caption"].startswith("Top 3 of 1,240")


# --------------------------------------------------------------------------- #
# 4. Report item scope windows.
# --------------------------------------------------------------------------- #
def _labels_for(tz: str) -> list[str]:
    ctx = make_ctx(prefs=_prefs(tz))
    specs: list[Any] = [
        "now-90d", "now-24h", "now-6M", "now-1M", "now-1h", "now-400d", "all", "today", "yesterday",
        "this_week", "last_week", "this_month", "last_month", "this_quarter", "last_quarter", "ytd",
        "this_year", "last_year", "2026", "2026-09", "2026-Q3", "2026-W40", "2026-09-14",
        {"from": "2026-09-03T05:30", "to": "2026-10-11T14:15"}, {"from": "2026-03-01", "to": "2026-10-10"},
        {"from": "2025-12-01", "to": "2026-02-10"}, {"from": "2026-09-03T05:30"},
    ]
    labels: list[str] = []
    for spec in specs:
        window = resolve_window(ctx, window=spec)
        assert not isinstance(window, str), (spec, window)
        labels.append(window.label)
        for unit in ("month", "week", "day", "hour"):
            labels.append(align_to_bucket(window, unit).label)
        for compare in ("previous_period", "same_period_last_year"):
            periods = resolve_periods(ctx, window, compare)
            if not isinstance(periods, str):
                labels.append(comparison_caption(periods))
    return list(dict.fromkeys(labels))


@pytest.mark.parametrize("tz", ["UTC", "Asia/Kolkata", LONG_ZONE])
def test_every_window_label_a_tool_writes_is_read_back_from_its_caption(tz: str) -> None:
    for label in _labels_for(tz):
        for caption in (
            label,
            f"62 cases · exact · {label}",
            f"Top 5 of 7 · 95 cases · exact · {label} · a case can count under several rules",
            f"Latest 25 of 1,240 · Sampled from the newest events · {label}",
        ):
            assert _caption_window({"caption": caption}) == label, (caption,)


@pytest.mark.parametrize("label", [
    "last 24h", "2026-10-01 00:00 → 2026-10-02 00:00 UTC", "all time",
    "2026-07-26 20:45 – 2026-09-03 05:30 (UTC)",
    "3 Sep 2026 05:30 – 11 Oct 2026 14:15 (Asia/Kolkata) vs 2026-07-26 20:45 – 2026-09-03 05:30 (Asia/Kolkata)",
    "past month", "last 1,000 days", "Sep 2026 (2)",
])
def test_earlier_caption_forms_still_read(label: str) -> None:
    assert _caption_window({"caption": f"12 cases · exact · {label}"}) == label


@pytest.mark.parametrize("caption", [
    "Top 5 of 7 · 39 cases · exact", "Partial result", "Sampled from the newest events",
    "a case can count under several rules", "120 cases counted · partial", "Cached result",
])
def test_captions_without_a_window_name_none(caption: str) -> None:
    assert _caption_window({"caption": caption}) is None


def _step(index: int, tool: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"index": index, "ordinal": index, "kind": "tool", "tool": tool, "label": f"Step {index}",
            "params": params, "status": "ok", "duration_ms": 5, "summary": "ok", "sources": []}


def _chart(block_id: str, caption: str | None, from_step: int) -> dict[str, Any]:
    block: dict[str, Any] = {
        "id": block_id, "type": "chart", "kind": "bar", "unit": "count", "provenance": "code",
        "artifact_kind": "categories", "allowed_views": ["bar", "hbar", "table"], "from_step": from_step,
        "title": "Cases by verdict",
        "x": {"kind": "category", "values": ["False positive", "True positive"]},
        "series": [{"key": "value", "label": "Cases", "values": [40, 22]}],
    }
    if caption is not None:
        block["caption"] = caption
    return block


def _brief_answer() -> list[dict[str, Any]]:
    return [
        {"id": "r1", "type": "report", "provenance": "ai", "title": "SOC performance report",
         "template": "executive", "scope": {"generated_at": "2026-10-11T00:00:00Z"},
         "sections": [
             {"id": "s1", "heading": "Volume", "blocks": [_chart("k1", "62 cases · exact · last 90 days", 1)]},
             {"id": "s2", "heading": "Verdicts", "blocks": [_chart("k2", None, 1)]},
         ]},
        {"id": "t1", "type": "table", "provenance": "code", "artifact_kind": "table", "allowed_views": ["table"],
         "title": "Latest cases", "from_step": 2, "caption": "Top 5 of 19 · 19 cases · exact · all time",
         "columns": [{"key": "case", "label": "Case", "type": "text"}],
         "rows": [[f"case-{i}"] for i in range(5)]},
    ]


async def test_saved_report_scopes_each_item_by_its_own_blocks() -> None:
    async with harness() as h:
        cid, mid = await seed_answer(
            h.state, blocks=_brief_answer(), answer="Volume rose; verdicts held.",
            steps=[_step(1, "case_stats", {"window": "now-90d"}), _step(2, "search_cases", {"window": "all"})],
        )
        saved = await save_answer_as_report(h.state, "", conversation_id=cid, message_id=mid,
                                            title="SOC performance report", idempotency_key="scope-1")
        assert saved is not None
        report = (await h.client.get(f"/api/reports/{saved.id}")).json()
        windows = {item["block"].get("title") or item["block"].get("id"): item["scope"]["window"]
                   for item in report["items"]}
        # The answer's own text covers the whole answer: both windows, each once.
        assert windows["Summary"] == "last 90 days; all time"
        # A Brief section is scoped by its own leaves, never by another block's caption.
        assert windows["Volume"] == "last 90 days"
        # A leaf with no caption: the window its step asked for, in caption words.
        assert windows["Verdicts"] == "last 90 days"
        assert windows["Latest cases"] == "all time"
        assert not any(w in ("now-90d", "all") for w in windows.values())


async def test_a_leaf_without_a_caption_reads_its_step_window_in_the_operator_zone() -> None:
    async with harness() as h:
        prefs = h.state.prefs.model_copy(deep=True)
        prefs.sla.timezone = "Asia/Kolkata"
        await h.state.update_prefs(prefs)
        blocks = [_chart("k1", None, 1), _chart("k2", None, 2), _chart("k3", None, 3)]
        cid, mid = await seed_answer(h.state, blocks=blocks, steps=[
            _step(1, "case_stats", {"window": "2026-Q3"}),
            _step(2, "case_stats", {"time_from": "now-90d"}),
            _step(3, "case_stats", {"window_hours": 48}),
        ])
        got = []
        for block_id in ("k1", "k2", "k3"):
            body = (await add(h.client, cid, mid, block_id=block_id)).json()
            got.append(next(i for i in body["report"]["items"] if i["block"]["id"] == block_id)["scope"]["window"])
        assert got == ["Q3 2026 (Asia/Kolkata)", "last 90 days", "last 48 hours"]


def test_scope_windows_are_listed_whole_never_cut_mid_word() -> None:
    windows = ["last 90 days", "last 90 days vs previous 90 days", "last 90 days (since 14 Jul 2026)",
               "all time (since 28 Mar 2026) (America/Argentina/Buenos_Aires)"]
    joined = _join_windows(windows)
    assert joined == "; ".join(windows) and len(joined) > 80
    # The stored scope keeps it whole (the old 80-character bound clipped it).
    assert ReportItemScope.model_validate({"window": joined}).window == joined
    many = [f"{n} Sep 2026 05:30 – {n} Oct 2026 14:15 (America/Argentina/Buenos_Aires)" for n in range(1, 12)]
    capped = _join_windows(many)
    assert len(capped) <= REPORT_SCOPE_WINDOW_CHARS and "…" not in capped
    kept = capped.split("; ")[:-1]
    assert kept == many[:len(kept)] and capped.endswith(f"; and {len(many) - len(kept)} more")
    assert _join_windows([]) is None
