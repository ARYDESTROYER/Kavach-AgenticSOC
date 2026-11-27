"""The chat scope chip's hint names every lookup that does not follow the general window
rule (Round 12 WP-FIX1, SPEC D7). These tests pin the tool behaviour the hint describes,
and that the console copy (``webui/src/soc/chat/composer/format.ts`` ``timeRangeHint``)
and the Help Center still name each exception, so the copy cannot drift from the tools:

* Auto (no range): case counts and case searches and ATT&CK coverage cover all time;
  log, metric, cost and audit lookups and the shift brief the last 24 hours.
* A chosen range is the default window of every lookup, except that the shift brief
  covers at most 7 days of it.
* Agent improvement always compares its own fixed periods.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.agents.chat_tools.cases import ShiftReportTool
from app.agents.chat_tools.metrics import SocMetricsTool
from app.api.metrics_shared import invalidate_case_page_cache
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, TimeRange
from app.stores.cases import CaseStore
from app.utils import now_utc

from tests.test_chat_tools_support import make_ctx

REPO = Path(__file__).resolve().parents[2]
FORMAT_TS = REPO / "webui" / "src" / "soc" / "chat" / "composer" / "format.ts"
CHAT_MD = REPO / "docs" / "analyst" / "chat.md"


def _case(i: int, created: datetime, mitre: list[str]) -> Case:
    iso = created.isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"), status=CaseStatus.OPEN,
        verdict=Verdict.NEEDS_HUMAN, confidence=0.8, risk_score=40.0, title=f"case {i}",
        created_at=iso, updated_at=iso, mitre=mitre,
    )


@pytest.fixture
async def store() -> CaseStore:
    """One case a year ago (T1110), one an hour ago (T1078)."""
    invalidate_case_page_cache()
    cases = CaseStore(InMemoryESClient())
    now = now_utc()
    await cases.save(_case(1, now - timedelta(days=365), ["T1110"]))
    await cases.save(_case(2, now - timedelta(hours=1), ["T1078"]))
    yield cases
    invalidate_case_page_cache()


async def test_attack_coverage_is_all_time_without_a_window_and_follows_a_chosen_range(store: CaseStore) -> None:
    auto = await SocMetricsTool().run(make_ctx(cases=store), kind="mitre_coverage")
    assert auto.ok and auto.observation["covered_techniques"] == 2
    assert auto.observation["window"] == "all cases"
    # Every other soc_metrics kind defaults to the last 24 hours (the general rule).
    posture = await SocMetricsTool().run(make_ctx(cases=store), kind="posture")
    assert posture.ok and posture.observation["case_count"] == 1

    week = make_ctx(cases=store, time_range=TimeRange(**{"from": "now-7d"}))
    chosen = await SocMetricsTool().run(week, kind="mitre_coverage")
    assert chosen.ok and chosen.observation["covered_techniques"] == 1
    assert chosen.observation["window"] != "all cases"


async def test_agent_improvement_never_follows_the_selected_range(store: CaseStore) -> None:
    label = "last 7 complete UTC days vs the 28 before"
    auto = await SocMetricsTool().run(make_ctx(cases=store), kind="agent_improvement")
    assert auto.ok and auto.observation["window"] == label
    for spec in ("now-24h", "now-90d", "all"):
        ctx = make_ctx(cases=store, time_range=TimeRange(**{"from": spec}))
        out = await SocMetricsTool().run(ctx, kind="agent_improvement")
        assert out.ok and out.observation["window"] == label, spec
        assert "the selected range does not apply" in (out.coverage or ""), spec


class _Standup:
    def __init__(self) -> None:
        self.calls: list[int] = []

    async def shift_snapshot(self, prefs, window_hours: int = 24):
        self.calls.append(window_hours)
        return {"headline_counts": {}, "deltas": {}, "attention_queue": [], "sla_aging": {},
                "workload": [], "action_items": []}


@pytest.mark.parametrize(("spec", "hours", "narrowed"), [
    (None, 24, False),          # Auto: the last 24 hours
    ("now-24h", 24, False),     # a week or less: the whole range
    ("now-7d", 168, False),
    ("now-90d", 168, True),     # longer: at most 7 days, and it says so
    ("now-12M", 168, True),
    ("all", 168, True),         # All time too
])
async def test_shift_brief_covers_at_most_seven_days_of_any_range(spec: str | None, hours: int,
                                                                  narrowed: bool) -> None:
    standup = _Standup()
    ctx = make_ctx(standup=standup, time_range=TimeRange(**{"from": spec}) if spec else None)
    out = await ShiftReportTool().run(ctx)
    assert out.ok and standup.calls == [hours]
    assert ("at most the last 7 days" in (out.coverage or "")) is narrowed


def test_the_console_hint_and_help_center_name_every_exception() -> None:
    hint = FORMAT_TS.read_text(encoding="utf-8")
    start = hint.index("export function timeRangeHint")
    body = hint[start:hint.index("\n}\n", start)]
    assert "No outer limit." in body
    assert "case counts, case searches and ATT&CK coverage" in body and "cover all time" in body
    assert "log, metric, cost and audit lookups and the shift brief cover the last 24 hours" in body
    assert "the shift brief covers at most 7 days" in body
    assert "Agent improvement always compares fixed periods" in body
    assert "agent improvement compares fixed periods" in body
    # The old, wrong default copy never comes back.
    assert "unless your question names another window" not in hint
    docs = CHAT_MD.read_text(encoding="utf-8")
    assert "| ATT&CK coverage | All time |" in docs
    assert "| Agent improvement | Always its own fixed periods" in docs
    assert "the shift brief covers at most 7 days" in docs


# --------------------------------------------------------------------------- #
# The Demo planner's window note when the question names the chip's own window.
# --------------------------------------------------------------------------- #
def test_demo_planner_reads_a_question_window_equal_to_the_chip_as_the_chip() -> None:
    from app.engine.demo_chat import Win, _canonical_window, _same_as_chip

    assert _canonical_window("now-1y") == _canonical_window("now-12M") == "now-12M"
    assert _canonical_window("now-1d") == _canonical_window("now-24h")
    assert _canonical_window("now-1w") == _canonical_window("now-7d")
    assert _canonical_window("now-6m") != _canonical_window("now-6M")  # minutes are not months
    assert _canonical_window("last_month") is None and _canonical_window(None) is None
    all_time = Win(spec="all", phrase="all time", all_time=True)
    six = Win(spec="now-6M", phrase="the last 6 months")
    year = Win(spec="now-12M", phrase="the past year")
    assert _same_as_chip(all_time, "all time")
    assert not _same_as_chip(all_time, "last 6 months") and not _same_as_chip(six, "all time")
    assert _same_as_chip(six, "last 6 months") and not _same_as_chip(six, "last 90 days")
    assert _same_as_chip(year, "last 12 months") and _same_as_chip(year, "past year")
    assert not _same_as_chip(six, None)


def test_demo_window_note_with_the_all_time_chip(demo_client) -> None:
    """Live through ``POST /api/chat/stream`` in Demo Mode: a question naming the
    chip's own window says the chip applies; a narrower question says it replaced it;
    the All time chip reads as a range, never "the all time you selected"."""
    from tests.test_chat_golden_set import _stream

    same = _stream(demo_client, "How many cases have we had in total?", time_range={"from": "all"})["answer"]
    assert "Window: the all-time range you selected applies to the windowed lookups above." in same
    assert "instead of" not in same.split("Window:", 1)[1]
    six = _stream(demo_client, "How many cases were opened in the last 6 months?", time_range={"from": "now-6M"})["answer"]
    assert "Window: the last 6 months you selected applies to the windowed lookups above." in six
    narrower = _stream(demo_client, "How many cases were opened in the last 6 months?", time_range={"from": "all"})["answer"]
    assert ("your question named the last 6 months, so the lookups used that window instead of the "
            "all-time range you selected") in narrower
    for answer in (same, six, narrower):
        assert "the all time you selected" not in answer


@pytest.fixture(scope="module")
def demo_client():
    from tests.test_chat_golden_set import client as golden_client

    yield from golden_client.__wrapped__()
