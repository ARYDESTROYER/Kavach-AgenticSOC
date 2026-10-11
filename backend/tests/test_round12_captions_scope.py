"""Round 12 final review, L2 (blocks, report scope, captions): nothing a person reads
under a block or in a report header is clipped or misnamed.

* A comparison tile's context ("<baseline>: <value> · <change> · n < 20") keeps every
  figure: only the period's name gives way, and the name is in the same human words as
  the subject period (never an ISO range with "(UTC)").
* A block caption is bounded only by the caption limit, so the tool's scope statement
  (with its zone and the "a case can count under several rules" disclosure) is whole.
* "Top N of M" counts one thing: M is the categories' own population, never the cases
  and never the log events (a log field's M is its distinct values, when known exactly;
  else "Top N shown"). A one-line events-over-time chart is never a "Top" cut.
* A report item's scope window is the window its own blocks state, in Round 12 words
  ("last 90 days", "all time (since …)", "Q3 2026"), and a step's raw input
  ("now-90d", '{"from":"2026-09-01"}', "{'from': '2026-09-01'}") is never shown as a
  window. Model-written text with no lookup behind it (a "Next steps" section) and a
  whole Brief speak for every window they cover; one window is never listed twice in
  two spellings ("last 24h; last 24 hours").
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
from app.agents.chat_tools.cases import SearchCasesTool
from app.agents.chat_tools.common import align_to_bucket, resolve_window
from app.agents.chat_tools.logs import LogStatsTool
from app.agents.chat_tools.metrics import CostUsageTool, SocMetricsTool
from app.agents.chat_tools.periods import comparison_caption, range_label, resolve_periods
from app.agents.chat_tools.stats import CaseStatsTool
from app.api.metrics_shared import invalidate_case_page_cache
from app.api.routes_reports import _caption_window, _join_windows, _window_of, save_answer_as_report
from app.connectors.elastic import ElasticConnector
from app.config import Preferences
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import REPORT_SCOPE_WINDOW_CHARS, Case, Entity, ReportItemScope
from app.stores.cases import CaseStore

from app.utils import now_utc, to_millis

from tests.conftest import make_log_event
from tests.test_chat_tools_logs import RecordingConnector, _named_events
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
    # A truncated artifact's ``total`` IS its population (here 1,240 rules); a tool
    # that does not know how many categories there are leaves it unset ("Top 3 shown").
    clipped = Artifact(
        id="a3", kind="categories", title="Top rules", provenance="code", total=1240, truncated=True,
        data={"labels": ["a", "b", "c"], "values": [3, 2, 1], "unit": "count", "dimension": "rule"},
    )
    assert _materialise(clipped)["caption"].startswith("Top 3 of 1,240")
    unknown = Artifact(
        id="a4", kind="categories", title="Top rules", provenance="code", truncated=True,
        data={"labels": ["a", "b", "c"], "values": [3, 2, 1], "unit": "count", "dimension": "rule"},
    )
    assert _materialise(unknown)["caption"].startswith("Top 3 shown")


def _log_blocks(out: Any) -> dict[str, dict[str, Any]]:
    assert out.ok, out.error
    return {a.kind: _materialise(a) for a in out.artifacts}


async def test_log_stats_top_values_never_count_events_as_their_population() -> None:
    """60 events over 12 IPs, counted by the source: the IPs are "Top 3" of 12 values
    the backend only approximates, so "Top 3 shown", never "Top 3 of 60" (events)."""
    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i in range(60):
        es.add_log("all-logs-x", make_log_event(ip=f"203.0.113.{i % 12}", user="u", host="h",
                                                ts_millis=now - i * 30_000))
    out = await LogStatsTool().run(make_ctx(log_source=ElasticConnector(es)), group_by=["ip"], top_n=3)
    blocks = _log_blocks(out)
    categories = blocks["categories"]
    assert categories["caption"].startswith("Top 3 shown · ") and categories.get("total") is None
    assert "60" not in categories["caption"]
    # The event count stays where it belongs: the Matching events figure.
    events = next(i for i in blocks["kpis"]["items"] if i["key"] == "events")
    assert events["value"] == 60
    # One line over every bucket: no "Top" or "Latest" cut at all.
    series = blocks["series"]
    assert not series.get("truncated") and not series["caption"].startswith(("Top", "Latest"))


async def test_log_stats_complete_sample_states_its_value_population() -> None:
    """A sample that holds every match counts its values exactly: "Top 2 of 4"."""
    conn = RecordingConnector(events=_named_events(["alice", "bob", "carol", "dave"] * 3))
    blocks = _log_blocks(await LogStatsTool().run(make_ctx(log_source=conn), group_by=["user"], top_n=2))
    assert blocks["categories"]["caption"].startswith("Top 2 of 4 · ")
    assert blocks["categories"]["total"] == 4


async def test_log_stats_sampled_source_says_sampled_not_top_of_the_event_total() -> None:
    """A source that returns the newest 12 of an exact 5,000 matches: the top values
    are "Top 2 shown" of a sample and the series is a sampled line, neither "of 5,000"."""
    conn = RecordingConnector(events=_named_events(["alice", "bob", "carol", "dave"] * 3), total=5_000)
    out = await LogStatsTool().run(make_ctx(log_source=conn), group_by=["user"], top_n=2)
    blocks = _log_blocks(out)
    categories, series = blocks["categories"], blocks["series"]
    assert categories["caption"].startswith("Top 2 shown · Sampled from the newest events · ")
    assert series["caption"].startswith("Sampled from the newest events · ")
    for block in (categories, series):
        assert "5,000" not in block["caption"] and block.get("total") is None
    assert not series.get("truncated") and not series.get("allowed_rebin")
    assert out.observation["total"] == 5_000  # the match count itself is still stated


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
    "2026-10-01 00:00 → 2026-10-02 00:00 UTC", "all time",
    "2026-07-26 20:45 – 2026-09-03 05:30 (UTC)",
    "3 Sep 2026 05:30 – 11 Oct 2026 14:15 (Asia/Kolkata) vs 2026-07-26 20:45 – 2026-09-03 05:30 (Asia/Kolkata)",
    "past month", "last 1,000 days", "Sep 2026 (2)",
])
def test_earlier_caption_forms_still_read(label: str) -> None:
    assert _caption_window({"caption": f"12 cases · exact · {label}"}) == label


@pytest.mark.parametrize(("legacy", "words"), [
    ("last 24h", "last 24 hours"), ("last 12h", "last 12 hours"), ("last 72h", "last 3 days"),
    ("last 7d", "last 7 days"), ("last 1d", "last 24 hours"), ("last 6M", "last 6 months"),
])
def test_an_earlier_trailing_window_reads_in_round12_words(legacy: str, words: str) -> None:
    assert _caption_window({"caption": f"Shift headline · {legacy}"}) == words


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


def _stored_params(tool: Any, inp: dict[str, Any]) -> dict[str, Any]:
    """A step's params exactly as the run log stores them (the tool's display form)."""
    return tool.display_params(inp)


def _narrative_brief(*, window_label: str | None = None) -> list[dict[str, Any]]:
    """A Brief whose leaves carry no caption (so each reads its step's input) and a
    "Next steps" section the model wrote, which no lookup produced."""
    scope: dict[str, Any] = {"generated_at": "2026-10-11T00:00:00Z"}
    if window_label:
        scope["window_label"] = window_label
    return [
        {"id": "r1", "type": "report", "provenance": "ai", "title": "SOC performance report",
         "template": "executive", "scope": scope,
         "sections": [
             {"id": "s1", "heading": "Volume", "blocks": [_chart("k1", None, 1)]},
             {"id": "s2", "heading": "AI cost", "blocks": [_chart("k2", None, 2)]},
             {"id": "s3", "heading": "Open work", "blocks": [
                 _chart("k3", "Top 5 of 19 · 19 cases · exact · all time", 3)]},
             {"id": "s4", "heading": "Next steps", "blocks": [
                 {"id": "m1", "type": "markdown", "provenance": "ai",
                  "text": "- Work the 19 open cases.\n- Tune the noisiest rule."}]},
         ]},
    ]


def _range_steps() -> list[dict[str, Any]]:
    """Range windows in the forms the tools store them: compact JSON (case_stats) and
    a Python-repr dict (soc_metrics, cost_usage)."""
    stats = _stored_params(CaseStatsTool(), {"window": {"from": "2026-09-01"}})
    cost = _stored_params(CostUsageTool(), {"window": {"from": "2026-09-01", "to": "2026-10-01"}})
    assert stats["window"] == '{"from":"2026-09-01"}' and cost["window"] == "{'from': '2026-09-01', 'to': '2026-10-01'}"
    return [_step(1, "case_stats", stats), _step(2, "cost_usage", cost),
            _step(3, "search_cases", _stored_params(SearchCasesTool(), {"window": "all"}))]


async def test_range_inputs_and_narrative_sections_never_show_a_raw_input() -> None:
    async with harness() as h:
        cid, mid = await seed_answer(h.state, blocks=_narrative_brief(), answer="Volume held; 19 open.",
                                     steps=_range_steps())
        saved = await save_answer_as_report(h.state, "", conversation_id=cid, message_id=mid,
                                            title="SOC performance report", idempotency_key="scope-range")
        assert saved is not None
        report = (await h.client.get(f"/api/reports/{saved.id}")).json()
        windows = {item["block"].get("title"): item["scope"]["window"] for item in report["items"]}
        everything = "since 1 Sep 2026; 1 Sep – 1 Oct 2026; all time"
        assert windows == {
            "Summary": everything,
            "Volume": "since 1 Sep 2026",
            "AI cost": "1 Sep – 1 Oct 2026",
            "Open work": "all time",
            # Written by the model from the whole answer: every window, never the
            # first lookup's alone.
            "Next steps": everything,
        }
        assert not any("{" in (w or "") for w in windows.values())
        # The whole Brief, added by its card's "Add to report": every leaf's window.
        body = (await add(h.client, cid, mid, block_id="r1")).json()
        item = next(i for i in body["report"]["items"] if i["block"].get("id") == "r1")
        assert item["scope"]["window"] == everything


async def test_a_whole_brief_lists_each_leaf_window() -> None:
    async with harness() as h:
        blocks = [{
            "id": "r1", "type": "report", "provenance": "ai", "title": "SOC performance report",
            "template": "executive", "scope": {"generated_at": "2026-10-11T00:00:00Z"},
            "sections": [
                {"id": "s1", "heading": "Volume", "blocks": [_chart("k1", "62 cases · exact · last 90 days", 1)]},
                {"id": "s2", "heading": "Open work", "blocks": [
                    _chart("k2", "Top 5 of 19 · 19 cases · exact · all time", 2)]},
                {"id": "s3", "heading": "Next steps", "blocks": [
                    {"id": "m1", "type": "markdown", "provenance": "ai", "text": "Tune rule X."}]},
            ]}]
        cid, mid = await seed_answer(h.state, blocks=blocks, steps=[
            _step(1, "case_stats", {"window": "now-90d"}), _step(2, "search_cases", {"window": "all"})])
        body = (await add(h.client, cid, mid, block_id="r1")).json()
        item = next(i for i in body["report"]["items"] if i["block"].get("id") == "r1")
        assert item["scope"]["window"] == "last 90 days; all time"


async def test_a_narrative_section_without_any_window_uses_the_briefs_turn_window() -> None:
    """No caption and no step input names a window: the window the Brief recorded for
    its turn (the composer window then), never nothing and never a raw input."""
    async with harness() as h:
        cid, mid = await seed_answer(
            h.state, blocks=_narrative_brief(window_label="last 7 days"),
            steps=[_step(1, "case_stats", {}), _step(2, "cost_usage", {}), _step(3, "search_cases", {})],
        )
        saved = await save_answer_as_report(h.state, "", conversation_id=cid, message_id=mid,
                                            title="SOC performance report", idempotency_key="scope-brief")
        assert saved is not None
        report = (await h.client.get(f"/api/reports/{saved.id}")).json()
        windows = {item["block"].get("title"): item["scope"]["window"] for item in report["items"]}
        assert windows["Volume"] == "last 7 days" and windows["AI cost"] == "last 7 days"
        assert windows["Next steps"] == "all time"  # the one window the answer states


async def test_one_window_in_two_spellings_is_listed_once() -> None:
    """A shift headline stored by an earlier build ("last 24h") next to a Round 12
    caption ("last 24 hours"): the report lists "last 24 hours" once."""
    async with harness() as h:
        blocks = [_chart("k1", "Shift headline · last 24h", 1), _chart("k2", "40 cases · exact · last 24 hours", 2)]
        cid, mid = await seed_answer(h.state, blocks=blocks, steps=[
            _step(1, "shift_report", {}), _step(2, "soc_metrics", {"kind": "posture"})])
        saved = await save_answer_as_report(h.state, "", conversation_id=cid, message_id=mid,
                                            title="Shift brief", idempotency_key="scope-shift")
        assert saved is not None
        report = (await h.client.get(f"/api/reports/{saved.id}")).json()
        assert {item["scope"]["window"] for item in report["items"]} == {"last 24 hours"}


NOON = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize(("params", "expected"), [
    ({"window": '{"from":"2026-09-01"}'}, "since 1 Sep 2026"),
    ({"window": '{"from":"2026-09-01","to":"2026-10-01"}'}, "1 Sep – 1 Oct 2026"),
    ({"window": "{'from': '2026-09-01'}"}, "since 1 Sep 2026"),
    ({"window": "{'from': '2026-09-01', 'to': '2026-10-01'}"}, "1 Sep – 1 Oct 2026"),
    ({"window": {"from": "2026-09-01", "to": "2026-10-01"}}, "1 Sep – 1 Oct 2026"),
    ({"window": "2026-09-01..2026-10-01"}, "1 Sep – 1 Oct 2026"),
    ({"window": "now-90d"}, "last 90 days"),
    ({"window": "", "time_from": "now-7d"}, "last 7 days"),
    ({"window_hours": 48}, "last 48 hours"),
    # Unreadable inputs name no window (the next fallback applies), never themselves.
    ({"window": "garbage"}, None),
    ({"window": '{"from":"2026-09-0'}, None),          # cut short for display
    ({"window": "{'from': '2026-09-01', 'to': '20"}, None),
    ({"window": "{1, 2}"}, None),                       # a literal, but not a range
    ({"window": "{'from': __import__('os')}"}, None),   # never evaluated
    ({"window": '{"from":"not a date"}'}, None),
    ({"time_from": "yesterday-ish", "time_to": "now"}, None),
])
def test_a_step_window_input_reads_back_in_caption_words(params: dict[str, Any], expected: str | None) -> None:
    assert _window_of(params, now=NOON) == expected


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
