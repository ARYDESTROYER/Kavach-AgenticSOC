"""Answer quality fixes from the chat revamp's browser QA (wave 5, section D).

* D1 — a Help Center link label is the section title alone: the client adds the
  presentation prefix ("Read: …"), so the server never sends one, and a title or
  link already listed is not repeated.
* D3 — the materialiser never emits a block with zero rows, points or items; such a
  ref is left out silently (no notice line), while every other notice rule holds.
* D4 — a ``kpis`` block that only restates the entity card of the same tool call is
  suppressed (live refs, stored refs, report leaves and the header-less default).
* D5/D6 — the agent prompt tells real models to keep a report answer to a short lead
  and to name things by human names rather than machine ids.
* D8 — duration KPIs and series carry the unit they are actually in (minutes), and a
  KPI delta is expressed in its tile's own unit.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.agents import blocks as B
from app.agents.blocks import (
    MaterialiseOptions,
    TurnArtifact,
    drop_restated_kpis,
    is_empty_block,
    kpis_restate_entity,
    materialise_final_blocks,
    parse_final_block_requests,
    to_blocks,
)
from app.agents.chat_tools.base import Artifact
from app.agents.chat_tools.metrics import SocMetricsTool
from app.agents.prompts import CHAT_AGENT_SYSTEM
from app.api.metrics_shared import invalidate_case_page_cache
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import Case, Entity
from app.stores.cases import CaseStore
from app.utils import now_utc

from tests.test_chat_tools_support import make_ctx


def _final(raw: list[Any], **kw: Any) -> B.MaterialisedFinal:
    requests, dropped = parse_final_block_requests(raw)
    assert dropped == []
    return materialise_final_blocks(requests, **kw)


def _turn(**entries: tuple[Artifact, int]) -> dict[str, TurnArtifact]:
    return {ref.replace("_", "."): TurnArtifact(ref=ref.replace("_", "."), artifact=art, from_step=step)
            for ref, (art, step) in entries.items()}


# --------------------------------------------------------------------------- #
# D1: no server "Read:" prefix.
# --------------------------------------------------------------------------- #
async def test_help_center_guide_links_carry_the_section_title_only() -> None:
    from app.agents.chat_tools.app_help import AppHelpTool

    out = await AppHelpTool().run(make_ctx(), query="noise reduction funnel")
    assert out.ok, out.summary
    (guide,) = [a for a in out.artifacts if a.kind == "guide"]
    links = guide.data["links"]
    doc_links = [link for link in links if "doc" in link["ref"]]
    assert doc_links, links
    assert not any(link["label"].startswith("Read") for link in links), links
    titles = {c.doc: c.title for c in out.citations}
    for link in doc_links:
        assert link["label"] == titles[link["ref"]["doc"]]
    labels = [link["label"] for link in links]
    docs = [link["ref"].get("doc") for link in doc_links]
    assert len(labels) == len(set(labels)) and len(docs) == len(set(docs))   # each listed once


def test_the_deterministic_help_answer_sends_no_read_prefix_either() -> None:
    from app.knowledge.answer import answer_app_question

    answer = answer_app_question("How do I connect a new log source?",
                                 grants=frozenset({("sources", "read"), ("sources", "manage")}))
    assert answer is not None
    guides = [b for b in answer.blocks if b.get("type") == "guide"]
    assert guides and all(not link["label"].startswith("Read") for g in guides for link in g["links"])


# --------------------------------------------------------------------------- #
# D3: never an empty block.
# --------------------------------------------------------------------------- #
EMPTY_ARTIFACTS = {
    "table": Artifact(id="a1", kind="table", title="Matching events", provenance="source", data={
        "columns": [{"key": "host", "label": "Host", "type": "text"}], "rows": []}),
    "categories": Artifact(id="a1", kind="categories", title="Top", provenance="code", data={
        "labels": [], "values": [], "unit": "count"}),
    "series": Artifact(id="a1", kind="series", title="Over time", provenance="code", data={
        "x": ["2026-10-08T00:00:00Z", "2026-10-08T01:00:00Z"], "unit": "minutes",
        "series": [{"key": "s", "label": "S", "values": [None, None]}]}),
    "kpis": Artifact(id="a1", kind="kpis", title="Figures", provenance="code", data={"items": []}),
    "case_list": Artifact(id="a1", kind="case_list", title="Cases", provenance="code", data={"items": []}),
    "timeline": Artifact(id="a1", kind="timeline", title="History", provenance="code", data={"events": []}),
    "mitre": Artifact(id="a1", kind="mitre", title="ATT&CK", provenance="code", data={"techniques": []}),
    "heatmap": Artifact(id="a1", kind="heatmap", title="Hours", provenance="code", data={
        "x": ["Mon"], "y": ["00"], "cells": [[None]], "unit": "count"}),
    "funnel": Artifact(id="a1", kind="funnel", title="Noise", provenance="code", data={
        "stages": ["Ingested", "Cases"], "values": [None, None], "unit": "count"}),
    "guide": Artifact(id="a1", kind="guide", title="Steps", provenance="code", data={"steps": [], "links": []}),
}


@pytest.mark.parametrize("kind", sorted(EMPTY_ARTIFACTS))
def test_an_artifact_without_data_yields_no_block_in_any_view(kind: str) -> None:
    artifact = EMPTY_ARTIFACTS[kind]
    for view in artifact.views():
        assert to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view)) == [], (kind, view)
        made, outcome = B._materialise(artifact, MaterialiseOptions(block_id="b1", view=view))
        assert made == [] and outcome == "empty", (kind, view)


def test_emptiness_is_judged_on_the_whole_artifact_not_a_clipped_view() -> None:
    """A view whose clipped slice holds nothing is never mistaken for an empty
    result: another view that shows the data is used, else the data could not be
    shown (counted, with that notice), never left out silently and never called
    "not available": it WAS in this turn's results."""
    # A long time series measured only in its OLDEST points: every view keeps the
    # newest MAX_POINTS/MAX_TABLE_ROWS, so no view can show them.
    points = B.MAX_TABLE_ROWS + 20
    x = [f"2026-10-0{1 + i // 200}T{(i // 60) % 24:02d}:{i % 60:02d}:00Z" for i in range(points)]
    old_only = Artifact(id="a1", kind="series", title="Over time", provenance="code", data={
        "x": x, "unit": "count",
        "series": [{"key": "s", "label": "S", "values": [5] * 10 + [None] * (points - 10)}]})
    assert B._artifact_has_data(old_only)
    for view in ("table", "line"):
        made, outcome = B._materialise(old_only, MaterialiseOptions(block_id="b1", view=view))
        assert made == [] and outcome == "unshowable", view
    out = _final([{"ref": "t1.a1", "view": "table"}], artifacts=_turn(t1_a1=(old_only, 1)))
    assert out.empty == [] and out.unresolved == [] and out.unshowable == ["t1.a1"]
    assert [b["text"] for b in out.blocks] == [B.UNUSABLE_NOTICE_ONE]
    # A heatmap measured only below its drawn rows: the grid slice is empty, so the
    # table view (every measured cell) shows the data instead.
    rows = B.MAX_HEATMAP_Y + 2
    deep = Artifact(id="a1", kind="heatmap", title="Hours", provenance="code", data={
        "x": ["Mon"], "y": [f"{h:02d}" for h in range(rows)],
        "cells": [[None]] * (rows - 1) + [[4]], "unit": "count"})
    (block,) = to_blocks(deep, MaterialiseOptions(block_id="b1", view="heatmap"))
    assert block["type"] == "table" and block["rows"] == [[f"{rows - 1:02d}", "Mon", 4]]


def test_items_validation_drops_could_not_be_shown_rather_than_empty() -> None:
    """Malformed data is counted under "could not be shown", never hidden silently
    and never "not available" (the artifact was in this turn's results)."""
    malformed = Artifact(id="a1", kind="kpis", title="Figures", provenance="code", data={
        "items": [{"key": "x"}, {"label": "no key"}]})
    assert B._artifact_has_data(malformed)
    made, outcome = B._materialise(malformed, MaterialiseOptions(block_id="b1"))
    assert made == [] and outcome == "unshowable"
    out = _final([{"ref": "t1.a1"}], artifacts=_turn(t1_a1=(malformed, 1)))
    assert out.empty == [] and out.unresolved == [] and out.unshowable == ["t1.a1"]
    assert [b["text"] for b in out.blocks] == [B.UNUSABLE_NOTICE_ONE]
    # Missing refs stay "not available"; both notices are counted apart.
    out = _final([{"ref": "t1.a1"}, {"ref": "t9.a1"}], artifacts=_turn(t1_a1=(malformed, 1)))
    assert out.unresolved == ["t9.a1"] and out.unshowable == ["t1.a1"]
    assert [b["text"] for b in out.blocks] == [f"{B.UNAVAILABLE_NOTICE_ONE} {B.UNUSABLE_NOTICE_ONE}"]


def test_a_malformed_artifact_never_sinks_the_answer() -> None:
    """Judging or building a malformed artifact never raises out of the materialiser:
    the ref could not be shown, and the rest of the answer stands."""
    malformed = Artifact(id="a1", kind="series", title="Over time", provenance="code",
                         data={"x": ["a"], "series": 5})
    assert B._materialise(malformed, MaterialiseOptions(block_id="b1")) == ([], "unshowable")
    real = Artifact(id="a1", kind="categories", title="Top hosts", provenance="source", data={
        "labels": ["web-01"], "values": [3], "unit": "count"})
    out = _final([{"ref": "t1.a1"}, {"ref": "t2.a1"}], artifacts=_turn(t1_a1=(malformed, 1), t2_a1=(real, 2)))
    assert [b["type"] for b in out.blocks] == ["chart", "callout"] and out.unshowable == ["t1.a1"]
    assert out.blocks[-1]["text"] == B.UNUSABLE_NOTICE_ONE


def test_a_clipped_empty_requested_view_falls_back_to_the_default_view(monkeypatch: pytest.MonkeyPatch) -> None:
    """The requested ``table`` view of a series clips to nothing (here a table that
    holds fewer rows than a chart holds points), while the ``line`` default shows the
    data: the default view is returned rather than no block or a notice."""
    monkeypatch.setattr(B, "MAX_TABLE_ROWS", 5)
    x = [f"2026-10-08T{h:02d}:00:00Z" for h in range(12)]
    series = Artifact(id="a1", kind="series", title="Over time", provenance="code", data={
        "x": x, "unit": "count", "series": [{"key": "s", "label": "S", "values": [3, 4] + [None] * 10}]})
    (block,) = to_blocks(series, MaterialiseOptions(block_id="b1", view="table"))
    assert block["type"] == "chart" and block["kind"] == "line"
    assert block["series"][0]["values"][:2] == [3, 4]


def test_zero_is_data_and_an_entity_card_is_never_empty() -> None:
    zeros = Artifact(id="a1", kind="categories", title="By severity", provenance="code", data={
        "labels": ["critical", "high"], "values": [0, 0], "unit": "count"})
    (block,) = to_blocks(zeros, MaterialiseOptions(block_id="b1"))
    assert block["series"][0]["values"] == [0, 0] and not is_empty_block(block)
    entity = {"type": "entity", "entity": {"kind": "ip", "value": "203.0.113.9"}}
    assert not is_empty_block(entity)
    assert not is_empty_block({"type": "markdown", "text": "x"})
    assert is_empty_block({"type": "guide", "steps": [], "links": []})
    assert is_empty_block({"type": "chart", "x": {"values": []}, "series": [{"values": []}]})


def test_an_empty_ref_is_left_out_silently_while_other_notices_still_apply() -> None:
    real = Artifact(id="a1", kind="categories", title="Top hosts", provenance="source", data={
        "labels": ["web-01"], "values": [3], "unit": "count"})
    artifacts = _turn(t1_a1=(EMPTY_ARTIFACTS["table"], 1), t2_a1=(real, 2))
    out = _final([{"ref": "t1.a1", "view": "table"}, {"ref": "t2.a1"}], artifacts=artifacts)
    assert [b["type"] for b in out.blocks] == ["chart"]          # no empty shell, no notice
    assert out.empty == ["t1.a1"] and out.unresolved == [] and out.resolved_refs == ["t2.a1"]
    # An unknown ref is still "not available", and counted alone.
    out = _final([{"ref": "t1.a1"}, {"ref": "t9.a1"}, {"ref": "t2.a1"}], artifacts=artifacts)
    assert [b["type"] for b in out.blocks] == ["chart", "callout"]
    assert out.blocks[-1]["text"] == B.UNAVAILABLE_NOTICE_ONE


def test_a_report_keeps_its_real_leaves_and_still_reports_a_brief_with_none() -> None:
    real = Artifact(id="a1", kind="categories", title="Top hosts", provenance="source", data={
        "labels": ["web-01"], "values": [3], "unit": "count"})
    artifacts = _turn(t1_a1=(EMPTY_ARTIFACTS["table"], 1), t2_a1=(real, 2))
    raw = [{"type": "report", "title": "Hunt", "sections": [
        {"heading": "Sightings", "items": [{"ref": "t1.a1"}]},
        {"heading": "Hosts", "items": [{"ref": "t2.a1"}]}]}]
    out = _final(raw, artifacts=artifacts, generated_at="2026-10-08T10:00:00Z")
    (report,) = out.blocks
    assert [s["heading"] for s in report["sections"]] == ["Hosts"] and out.empty == ["t1.a1"]
    # Nothing at all to show: the existing rule (the brief could not be built) holds.
    only_empty = [{"type": "report", "title": "Hunt", "sections": [
        {"heading": "Sightings", "items": [{"ref": "t1.a1"}]}]}]
    out = _final(only_empty, artifacts=artifacts)
    assert [b["text"] for b in out.blocks] == [B.REPORT_EMPTY_NOTICE]


def test_a_stored_empty_shell_from_an_older_build_is_not_shown_again() -> None:
    shell = {"id": "b1", "type": "table", "provenance": "source", "artifact_kind": "table",
             "allowed_views": ["table"], "columns": [{"key": "host", "label": "Host", "type": "text"}], "rows": []}
    out = _final([{"ref": "m2.b1", "view": "table"}], stored={"m2": [shell]})
    assert out.blocks == [] and out.empty == ["m2.b1"]


# --------------------------------------------------------------------------- #
# D4: one figure shown once.
# --------------------------------------------------------------------------- #
def _reputation(score: float = 87.0) -> tuple[Artifact, Artifact]:
    entity = Artifact(id="a1", kind="entity", title="Indicator reputation", provenance="source",
                      untrusted_labels=True, data={
                          "entity": {"kind": "ip", "value": "203.0.113.93"}, "risk": score,
                          "facts": [{"label": "Kind", "value": "ip"},
                                    {"label": "Providers", "value": "1 of 1 answered"},
                                    {"label": "Country", "value": "7 seas", "untrusted": True}],
                          "reputation": [{"provider": "demo", "verdict": "malicious", "score": score}]})
    kpis = Artifact(id="a2", kind="kpis", title="Reputation figures", provenance="source", data={"items": [
        {"key": "score", "label": "Reputation score", "value": score, "unit": "score", "display": "gauge"},
        {"key": "providers", "label": "Providers answered", "value": 1, "unit": "count",
         "context": "of 1 queried"}]})
    return entity, kpis


def test_a_kpi_row_restating_the_entity_card_of_the_same_call_is_suppressed() -> None:
    entity, kpis = _reputation()
    artifacts = _turn(t2_a1=(entity, 2), t2_a2=(kpis, 2))
    out = _final([{"ref": "t2.a1"}, {"ref": "t2.a2", "view": "kpi_group"}], artifacts=artifacts)
    assert [b["type"] for b in out.blocks] == ["entity"]          # no notice either
    assert out.restated == ["t2.a2"] and out.resolved_refs == ["t2.a1"]
    # In its table view the row restates the same figures.
    out = _final([{"ref": "t2.a1"}, {"ref": "t2.a2", "view": "table"}], artifacts=artifacts)
    assert [b["type"] for b in out.blocks] == ["entity"]
    # Alone, the KPI row is the only place the figures appear: it is shown.
    out = _final([{"ref": "t2.a2"}], artifacts=artifacts)
    assert [b["type"] for b in out.blocks] == ["kpi_group"]


def test_a_kpi_row_with_its_own_figures_or_from_another_call_is_kept() -> None:
    entity, kpis = _reputation()
    other_call = _turn(t2_a1=(entity, 2), t3_a2=(kpis, 3))
    out = _final([{"ref": "t2.a1"}, {"ref": "t3.a2"}], artifacts=other_call)
    assert [b["type"] for b in out.blocks] == ["entity", "kpi_group"]
    richer = Artifact(id="a2", kind="kpis", title="Case figures", provenance="code", data={"items": [
        {"key": "risk", "label": "Risk score", "value": 87, "unit": "score"},
        {"key": "confidence", "label": "Confidence", "value": 99, "unit": "percent"}]})
    out = _final([{"ref": "t2.a1"}, {"ref": "t2.a2"}], artifacts=_turn(t2_a1=(entity, 2), t2_a2=(richer, 2)))
    assert [b["type"] for b in out.blocks] == ["entity", "kpi_group"]
    # A log-derived (untrusted) fact never supplies a figure.
    seas = Artifact(id="a2", kind="kpis", title="Seas", provenance="code", data={"items": [
        {"key": "seas", "label": "Seas", "value": 7, "unit": "count"}]})
    out = _final([{"ref": "t2.a1"}, {"ref": "t2.a2"}], artifacts=_turn(t2_a1=(entity, 2), t2_a2=(seas, 2)))
    assert [b["type"] for b in out.blocks] == ["entity", "kpi_group"]


def test_stored_blocks_are_matched_within_their_own_earlier_answer() -> None:
    entity, kpis = _reputation()
    card = to_blocks(entity, MaterialiseOptions(block_id="b1", from_step=2))[0]
    row = to_blocks(kpis, MaterialiseOptions(block_id="b2", from_step=2))[0]
    same = _final([{"ref": "m2.b1"}, {"ref": "m2.b2"}], stored={"m2": [card, row]})
    assert [b["type"] for b in same.blocks] == ["entity"] and same.restated == ["m2.b2"]
    # Step 2 of two different answers is two different calls.
    apart = _final([{"ref": "m1.b1"}, {"ref": "m3.b1"}], stored={"m1": [card], "m3": [row]})
    assert [b["type"] for b in apart.blocks] == ["entity", "kpi_group"] and apart.restated == []


def test_restated_kpis_are_dropped_across_a_report_and_empty_sections_go() -> None:
    entity, kpis = _reputation()
    artifacts = _turn(t2_a1=(entity, 2), t2_a2=(kpis, 2))
    raw = [{"type": "report", "title": "IOC report", "sections": [
        {"heading": "Indicator", "items": [{"ref": "t2.a1"}]},
        {"heading": "Details", "items": [{"ref": "t2.a2"}]}]}]
    out = _final(raw, artifacts=artifacts, generated_at="2026-10-08T10:00:00Z")
    (report,) = out.blocks
    assert [s["heading"] for s in report["sections"]] == ["Indicator"] and out.restated == ["t2.a2"]


def test_kpis_restate_entity_compares_figures_not_labels() -> None:
    entity = to_blocks(_reputation()[0], MaterialiseOptions(block_id="b1", from_step=2))[0]
    kpis = to_blocks(_reputation()[1], MaterialiseOptions(block_id="b2", from_step=2))[0]
    assert kpis_restate_entity(kpis, entity)
    moved = {**kpis, "items": [{**kpis["items"][0], "delta": {"value": 3, "period_label": "vs prior",
                                                               "good_direction": "down"}}]}
    assert not kpis_restate_entity(moved, entity)                # a delta is new information
    other = to_blocks(_reputation(42.0)[1], MaterialiseOptions(block_id="b3", from_step=2))[0]
    assert not kpis_restate_entity(other, entity)
    kept, dropped = drop_restated_kpis([entity, {**kpis, "from_step": 5}])
    assert dropped == [] and len(kept) == 2


async def test_the_reputation_lookup_shows_its_score_once_end_to_end() -> None:
    """The real ``lookup_indicator`` artifacts (Demo Mode result) referenced together."""
    from app.agents.chat_tools.registry import build_toolbox
    from app.agents.chat_tools.taint import TaintLedger

    box = build_toolbox(make_ctx(demo_active=True))
    out = await box.execute("lookup_indicator", {"indicator": "198.51.100.77"}, ordinal=1, step=1,
                            taint=TaintLedger(["is 198.51.100.77 malicious?"]))
    assert out.ok, out.summary
    artifacts = {f"t1.{a.id}": TurnArtifact(ref=f"t1.{a.id}", artifact=a, from_step=1) for a in out.artifacts}
    final = _final([{"ref": ref} for ref in artifacts], artifacts=artifacts)
    assert [b["type"] for b in final.blocks] == ["entity"], [b["type"] for b in final.blocks]


async def test_the_header_less_default_shows_neither_an_empty_shell_nor_a_restated_row(
        monkeypatch: pytest.MonkeyPatch) -> None:
    """A prose-only final (no protocol header) shows every artifact of the turn in its
    default view (``_AgentTurn._default_blocks``): a zero-match log search adds no
    table shell, and the reputation KPI row that only restates the entity card of the
    same call is left out."""
    from typing import ClassVar

    from app.agents.chat_tools import registry
    from app.agents.chat_tools.base import ChatTool, ChatToolContext, ToolOutcome
    from tests.test_chat_engine_loop import FakeGateway, make_engine, make_prefs, run, tool_calls
    from tests.test_chat_engine_loop import make_ctx as loop_ctx

    class NoMatchLogs(ChatTool):
        name: ClassVar[str] = "search_logs"
        label: ClassVar[str] = "Searched logs"
        scope: ClassVar[str] = "logs"
        requires: ClassVar[tuple] = (("sources", "read"),)
        signature: ClassVar[str] = "search_logs(query) -- rows"

        async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
            return ToolOutcome(ok=True, summary="0 events", observation={"total": 0},
                               artifacts=[EMPTY_ARTIFACTS["table"]], rows=0)

    class Reputation(ChatTool):
        name: ClassVar[str] = "lookup_indicator"
        label: ClassVar[str] = "Looked up an indicator"
        scope: ClassVar[str] = "intel"
        requires: ClassVar[tuple] = (("enrichment", "read"),)
        signature: ClassVar[str] = "lookup_indicator(indicator) -- reputation"

        async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
            entity, kpis = _reputation()
            return ToolOutcome(ok=True, summary="reputation 87", observation={"score": 87},
                               artifacts=[entity, kpis])

    monkeypatch.setattr(registry, "_CATALOGUE", (NoMatchLogs(), Reputation()))
    question = "Hunt 185.220.101.4 in the logs"
    gateway = FakeGateway([
        tool_calls(("search_logs", {"query": "185.220.101.4"}), ("lookup_indicator", {"indicator": "185.220.101.4"})),
        "It matched no log event; its reputation is 87/100.",
    ])
    prefs = make_prefs()
    ctx = loop_ctx(prefs, grants=frozenset({("sources", "read"), ("enrichment", "read")}))
    _, response, _ = await run(make_engine(gateway), question, prefs, ctx)
    assert [s.status for s in response.steps if s.kind == "tool"] == ["ok", "ok"]
    assert response.answer == "It matched no log event; its reputation is 87/100."
    assert [b["type"] for b in response.blocks] == ["entity"], [b.get("title") for b in response.blocks]
    assert not any(b.get("title") == "Reputation figures" for b in response.blocks)


# --------------------------------------------------------------------------- #
# D5/D6: guidance for real models.
# --------------------------------------------------------------------------- #
def test_the_agent_prompt_asks_for_a_short_report_lead_and_human_names() -> None:
    style = CHAT_AGENT_SYSTEM.split("## Style", 1)[1].split("## This conversation", 1)[0]
    assert "With a report in blocks, the answer text is a lead of 1 to 3 sentences" in style
    assert "never repeat its sections in the text" in style
    # The lead never swallows a disclosure (what failed, was denied or partial, the window).
    assert ("Notes about failed, denied or partial lookups and the time window still follow the lead."
            in " ".join(style.split()))
    assert "change_unit" in style and "relative_change_pct is a percent of the previous value" in style
    assert "a campaign by its name or the entity its cases share" in style
    assert "Long machine ids" in style and "belong in blocks and links" in style
    assert "Show each figure once" in style
    assert "Durations keep the unit their result states" in style


# --------------------------------------------------------------------------- #
# D8: durations in the unit they are in; deltas in the tile's unit.
# --------------------------------------------------------------------------- #
def _case(i: int, created: datetime, *, minutes_to_close: int | None, verdict: Verdict) -> Case:
    closed = minutes_to_close is not None
    updated = created + timedelta(minutes=minutes_to_close or 0)
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        status=CaseStatus.CLOSED if closed else CaseStatus.OPEN, verdict=verdict, confidence=0.8,
        risk_score=40.0, title=f"case {i}", created_at=created.isoformat(), updated_at=updated.isoformat(),
    )


@pytest.fixture
async def timed_store() -> CaseStore:
    """Six cases in the last 24h (four closed after 30 minutes, three of them false
    positives) and three in the 24h before (one closed after 90 minutes)."""
    invalidate_case_page_cache()
    store = CaseStore(InMemoryESClient())
    now = now_utc().astimezone(timezone.utc)
    for i in range(6):
        closes = 30 if i < 4 else None
        verdict = Verdict.FALSE_POSITIVE if i < 3 else Verdict.TRUE_POSITIVE
        await store.save(_case(i, now - timedelta(hours=10, minutes=i), minutes_to_close=closes, verdict=verdict))
    for i in range(10, 13):
        closes = 90 if i == 10 else None
        await store.save(_case(i, now - timedelta(hours=30, minutes=i), minutes_to_close=closes,
                               verdict=Verdict.TRUE_POSITIVE))
    yield store
    invalidate_case_page_cache()


async def test_duration_kpis_and_series_are_in_minutes_end_to_end(timed_store: CaseStore) -> None:
    ctx = make_ctx(cases=timed_store)
    posture = await SocMetricsTool().run(ctx, kind="posture", window_hours=24)
    assert posture.ok
    items = {i["key"]: i for i in posture.artifacts[0].data["items"]}
    mttr = posture.observation["lifecycle_minutes"]["mttr_minutes"]
    assert items["mttr_p50"]["unit"] == "minutes" and items["mttr_p50"]["value"] == mttr["p50"] == 30
    (block,) = to_blocks(posture.artifacts[0], MaterialiseOptions(block_id="b1"))
    assert {i["key"]: i["unit"] for i in block["items"]}["mttr_p50"] == "minutes"
    timing = await SocMetricsTool().run(ctx, kind="timing", window_hours=24)
    assert timing.ok
    for item in timing.artifacts[0].data["items"]:
        assert item["unit"] == "minutes", item
    for artifact in timing.artifacts[1:]:
        assert artifact.data["unit"] == "minutes"


async def test_posture_deltas_are_in_each_tiles_unit(timed_store: CaseStore) -> None:
    ctx = make_ctx(cases=timed_store)
    posture = await SocMetricsTool().run(ctx, kind="posture", window_hours=24, compare_previous=True)
    assert posture.ok
    items = {i["key"]: i for i in posture.artifacts[0].data["items"]}
    compare = posture.observation["compare_previous"]
    cases = compare["case_count"]
    assert items["cases"]["delta"]["value"] == cases["value"] - cases["prev"]       # cases, not %
    fp = compare["false_positive_rate"]
    assert fp["value"] is not None and fp["prev"] is not None
    assert items["fp_rate"]["delta"]["value"] == round((fp["value"] - fp["prev"]) * 100, 2)       # points
    mttr = compare["mttr_p50"]
    assert items["mttr_p50"]["delta"]["value"] == round(mttr["value"] - mttr["prev"], 2)          # minutes
    for item in items.values():
        if item.get("delta"):
            assert item["delta"]["period_label"] == "vs previous window"
    (block,) = to_blocks(posture.artifacts[0], MaterialiseOptions(block_id="b1"))
    assert all("%" not in (i.get("delta") or {}).get("period_label", "") for i in block["items"])
    # The model reads the SAME change the tile shows, with its unit named, so prose and
    # tile agree; the engine's relative percent is labelled as such, never as the change.
    tile_of = {"case_count": "cases", "false_positive_rate": "fp_rate", "automation_rate": "automation_rate",
               "mttr_p50": "mttr_p50"}
    units = {"case_count": "cases", "false_positive_rate": "percentage points",
             "automation_rate": "percentage points", "mttr_p50": "minutes"}
    for key, tile in tile_of.items():
        entry = compare[key]
        assert entry["change_unit"] == units[key], key
        assert "delta_pct" not in entry and "relative_change_pct" in entry
        delta = items[tile].get("delta")
        assert entry["change"] == (delta["value"] if delta else None), key
    assert compare["period_label"] == "vs previous window"
    assert compare["escalation_rate"]["change_unit"] == "percentage points"


async def test_every_previous_window_delta_uses_one_label() -> None:
    """The shift headline and the posture KPIs sit together in a Shift brief: one
    period label for both."""
    from app.agents.chat_tools.cases import ShiftReportTool
    from app.agents.chat_tools.common import PREVIOUS_WINDOW_LABEL

    class Standup:
        async def shift_snapshot(self, prefs: Any, *, window_hours: Any = None, now: Any = None) -> dict[str, Any]:
            return {"headline_counts": {"open": 3, "escalated": 1},
                    "deltas": {"open": {"current": 3, "prior": 1, "delta": 2},
                               "escalated": {"current": 1, "prior": 2, "delta": -1}}}

    assert PREVIOUS_WINDOW_LABEL == "vs previous window"
    shift = await ShiftReportTool().run(make_ctx(standup=Standup()), window_hours=24)
    assert shift.ok, shift.summary
    headline = next(a for a in shift.artifacts if a.kind == "kpis")
    deltas = [i["delta"] for i in headline.data["items"] if i.get("delta")]
    assert deltas and {d["period_label"] for d in deltas} == {PREVIOUS_WINDOW_LABEL}
