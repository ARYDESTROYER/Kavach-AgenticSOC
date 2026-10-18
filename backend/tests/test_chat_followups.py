"""Anchored follow-up selection (Round 13 SPEC-chat §4.1, T4; audit A13).

The selector (``agents.chat_followups.select_follow_ups``) is pure: model chips are kept
only when anchored in what the answer shows, deterministic value-free chips come from
the artifacts, and the three slots are filled in/in/out. The engine runs it for every
answer, live and in Demo (the Demo planner is a provider behind the same engine).
"""

from __future__ import annotations

import pytest

from app.agents import chat as chat_module
from app.agents.chat_followups import (
    ArtifactInfo,
    answer_anchors,
    deterministic_chips,
    is_anchored,
    select_follow_ups,
)
from app.agents.chat_protocol import FallbackAnswer, PriorExchange
from tests.test_chat_engine_loop import (
    FakeGateway,
    FakeKnowledge,
    fake_catalogue,  # noqa: F401 -- autouse: the fake tool catalogue
    final,
    make_ctx,
    make_engine,
    make_prefs,
    run,
    tool_call,
)

ALL_TOOLS = frozenset({
    "search_logs", "log_stats", "search_cases", "case_stats", "get_case", "mitre_lookup",
    "soc_metrics", "cost_usage", "explain_decision",
})


def _select(chips, artifacts, *, question="q", earlier=(), allowed=ALL_TOOLS, kind="data"):
    return select_follow_ups(list(chips), artifacts, question=question, earlier_questions=list(earlier),
                             allowed_tools=allowed, answer_kind=kind)


def _mitre(*ids: str, tool: str = "mitre_lookup") -> ArtifactInfo:
    return ArtifactInfo(kind="mitre", tool=tool, data={"techniques": [
        {"id": i, "name": "Exploit Public-Facing Application" if i == "T1190" else "x"} for i in ids]})


def _ip_categories(window: str | None = "last 24 hours") -> ArtifactInfo:
    return ArtifactInfo(kind="categories", tool="log_stats", window=window, params={"group_by": ["ip"]},
                        data={"labels": ["203.0.113.7", "198.51.100.2"], "values": [9, 4], "unit": "count",
                              "dimension": "ip"})


def _case_stats(window: str = "44 cases · exact · last 7 days", **params) -> ArtifactInfo:
    return ArtifactInfo(kind="categories", tool="case_stats", window=window, params=params,
                        data={"labels": ["False positive", "True positive"], "values": [30, 14],
                              "unit": "count", "dimension": "Verdict", "ordered": True})


# --------------------------------------------------------------------------- #
# Anchoring.
# --------------------------------------------------------------------------- #
def test_off_topic_technique_chip_is_dropped_and_replaced_by_a_deterministic_chip() -> None:
    """A13: a T1110 chip after a T1190 answer is off topic, even when it also names a
    window the answer shows; the deterministic MITRE chip takes the slot."""
    artifacts = [_mitre("T1190"), _ip_categories()]
    chips = ["What is ATT&CK technique T1110, and how often do we see it?",
             "Hunt for T1110 brute force in the last 24 hours"]
    out = _select(chips, artifacts, question="Which cases show T1190?")
    assert not any("T1110" in c for c in out)
    assert out[0] == "Explain T1190 and whether other cases show it"
    assert "Investigate the top source IP in this answer" in out


def test_anchored_model_chips_lead_and_deterministic_chips_fill_in_in_out() -> None:
    artifacts = [_ip_categories()]
    chips = ["Which hosts did 203.0.113.7 reach?", "Show the source IP chart as a table",
             "How is our posture?"]
    out = _select(chips, artifacts)
    # slot 1 and 2: anchored model chips; slot 3: the deterministic "out" chip.
    assert out == ["Which hosts did 203.0.113.7 reach?", "Show the source IP chart as a table",
                   "Compare this with the previous 24 hours"]


def test_without_model_chips_the_slots_are_in_in_out() -> None:
    out = _select([], [_ip_categories()])
    assert out == ["Investigate the top source IP in this answer", "Break this down by user instead",
                   "Compare this with the previous 24 hours"]


def test_a_comparison_already_ran_offers_the_next_window_instead() -> None:
    compared = ArtifactInfo(kind="categories", tool="case_stats", window="12 cases · exact · last 7 days",
                            params={"group_by": ["severity"], "compare": "previous_period"},
                            data={"labels": ["High"], "values": [12], "unit": "count", "dimension": "Severity"})
    out = _select([], [compared])
    assert out[-1] == "Show the same for the last 30 days"
    assert "Break this down by rule instead" in out          # severity was used
    all_time = ArtifactInfo(kind="series", tool="case_stats", window="all time",
                            params={"compare": "previous_period"}, data={"x": [], "series": [], "unit": "count"})
    assert not any(c.direction == "out" for c in deterministic_chips([all_time]))


def test_window_labels_name_the_previous_period() -> None:
    def out_chip(window: str) -> str | None:
        art = ArtifactInfo(kind="kpis", tool="soc_metrics", window=window, data={"items": []})
        outs = [c.text for c in deterministic_chips([art]) if c.direction == "out"]
        return outs[0] if outs else None

    assert out_chip("last 90 days (since 15 Jul 2026)") == "Compare this with the previous 90 days"
    assert out_chip("last hour") == "Compare this with the previous hour"
    assert out_chip("this month") == "Compare this with the previous month"
    assert out_chip("past year") == "Compare this with the previous year"
    assert out_chip("today") == "Compare this with the previous day"
    assert out_chip("last 1,000 days") == "Compare this with the previous 1,000 days"
    assert out_chip("all time") is None
    assert out_chip("2026-09-01 00:00 → 2026-09-02 00:00 UTC") is None


def test_repeats_of_the_question_earlier_questions_and_other_chips_are_dropped() -> None:
    artifacts = [_ip_categories()]
    chips = ["Which hosts did 203.0.113.7 reach?", "which hosts did 203.0.113.7 reach",
             "Top source IPs?", "What did 198.51.100.2 do yesterday?"]
    out = _select(chips, artifacts, question="Top source IPs",
                  earlier=["What did 198.51.100.2 do yesterday"])
    assert out[0] == "Which hosts did 203.0.113.7 reach?"
    assert sum(1 for c in out if "203.0.113.7" in c) == 1
    assert "Top source IPs?" not in out and not any("198.51.100.2" in c for c in out)
    # A deterministic chip equal to an earlier question is dropped too.
    again = _select([], artifacts, earlier=["Investigate the top source IP in this answer"])
    assert "Investigate the top source IP in this answer" not in again


def test_no_data_artifacts_keep_at_most_two_model_chips_unchecked() -> None:
    chips = ["How do I connect a source?", "What does MTTA measure?", "Where are the models?"]
    assert _select(chips, [], kind="product_help") == chips[:2]
    assert _select(chips, [], kind="conversation") == chips[:2]
    guide = ArtifactInfo(kind="guide", tool="app_help", data={"links": []})
    assert _select(chips, [guide], kind="mixed") == chips[:2]
    # Product help never counts artifacts as data, whatever it was given.
    assert _select(chips, [_ip_categories()], kind="product_help") == chips[:2]


def test_a_disallowed_tool_drops_its_deterministic_chip() -> None:
    out = _select([], [_ip_categories()], allowed=frozenset({"log_stats"}))
    assert "Investigate the top source IP in this answer" not in out     # needs search_logs
    assert out[0] == "Break this down by user instead"
    assert _select([], [_ip_categories()], allowed=frozenset()) == []
    mitre = _select([], [_mitre("T1190")], allowed=frozenset({"mitre_lookup"}))
    assert mitre == []                                                  # also needs search_cases


def test_anchors_and_word_boundaries() -> None:
    anchors = answer_anchors([_ip_categories(), _case_stats()])
    assert "203.0.113.7" in anchors and "source ip" in anchors and "last 24 hours" in anchors
    assert "verdict" in anchors and "last 7 days" in anchors
    assert all(len(a) >= 3 for a in anchors)
    low = ArtifactInfo(kind="categories", tool="case_stats", data={"labels": ["Low"], "values": [1],
                                                                  "unit": "count", "dimension": "Severity"})
    lows = answer_anchors([low])
    assert is_anchored("Show the low cases", lows)
    assert is_anchored("Which verdicts?", answer_anchors([_case_stats()]))   # plural allowed
    assert not is_anchored("Anything below the line?", ["low"])
    # A technique the question named is not off topic.
    assert is_anchored("Explain T1110 in the last 24 hours", ["last 24 hours"], question="Do we see T1110?")
    assert not is_anchored("Explain T1110 in the last 24 hours", ["last 24 hours"], question="Top IPs")


def test_case_list_entity_and_mitre_chips() -> None:
    mixed = ArtifactInfo(kind="case_list", tool="search_cases", data={"items": [
        {"case_id": "case-0042", "status": "escalated"}, {"case_id": "case-0040", "status": "closed"}]})
    open_only = ArtifactInfo(kind="case_list", tool="search_cases", data={"items": [
        {"case_id": "case-0042", "status": "escalated"}]})
    assert "Which of these cases are still open, and who has them?" in [c.text for c in deterministic_chips([mixed])]
    assert deterministic_chips([open_only]) == []
    entity = ArtifactInfo(kind="entity", tool="get_case", data={"entity": {"kind": "ip", "value": "185.220.101.9"}})
    assert [c.text for c in deterministic_chips([entity])] == ["What else did this IP address do in the last 7 days?"]
    # Only an id that exists in the bundled ATT&CK corpus is ever named.
    assert deterministic_chips([_mitre("T9999")]) == []
    assert [c.text for c in deterministic_chips([_mitre("T9999", "T1190")])] == [
        "Explain T1190 and whether other cases show it"]


def test_model_chips_are_sanitised_and_bounded() -> None:
    artifacts = [_ip_categories()]
    hostile = "Which hosts did 203.0.113.7‮ reach?"
    out = _select([hostile, "x" * 141, 42], artifacts)               # type: ignore[list-item]
    assert out[0] == "Which hosts did 203.0.113.7 reach?"            # invisible character removed
    assert not any(len(c) > 140 for c in out)


def test_ordered_categories_are_not_ranked_entities() -> None:
    assert not any(c.text.startswith("Investigate") for c in deterministic_chips([_case_stats()]))


# --------------------------------------------------------------------------- #
# The engine runs the selector for every answer.
# --------------------------------------------------------------------------- #
async def test_engine_anchors_follow_ups_in_the_shown_artifacts() -> None:
    gateway = FakeGateway([
        tool_call("log_stats", group_by="source.ip"),
        final("Top IPs.", blocks=[{"ref": "t1.a1", "view": "bar"}],
              follow_ups=["What is ATT&CK technique T1110?", "Is 10.0.0.2 in any open case?"],
              answer_kind="data"),
    ])
    prefs = make_prefs()
    _events, resp, _outcome = await run(make_engine(gateway), "top source IPs?", prefs, make_ctx(prefs))
    assert resp.follow_ups == ["Is 10.0.0.2 in any open case?", "Investigate the top source IP in this answer"]
    assert len(gateway.calls) == 2                                   # no extra model call (#6)


async def test_engine_prose_only_answer_is_anchored_in_every_artifact_of_the_turn() -> None:
    gateway = FakeGateway([
        tool_call("log_stats", group_by="source.ip"),
        final("10.0.0.1 leads.", follow_ups=["Same for 10.0.0.1 yesterday", "How is our posture?"],
              answer_kind="data"),
    ])
    prefs = make_prefs()
    _events, resp, _outcome = await run(make_engine(gateway), "top IPs", prefs, make_ctx(prefs))
    assert resp.follow_ups[0] == "Same for 10.0.0.1 yesterday"
    assert "How is our posture?" not in resp.follow_ups


async def test_engine_drops_a_chip_repeating_an_earlier_question() -> None:
    gateway = FakeGateway([final("Hello.", follow_ups=["What can I do here?", "Show the models"],
                                 answer_kind="conversation")])
    prefs = make_prefs()
    prior = [PriorExchange(user="What can I do here?", answer="A lot.")]
    _events, resp, _outcome = await run(make_engine(gateway), "hi", prefs, make_ctx(prefs),
                                        prior_exchanges=prior)
    assert resp.follow_ups == ["Show the models"]


async def test_engine_fallback_answer_goes_through_the_same_selector() -> None:
    from app.llm.gateway import GatewayError

    knowledge = FakeKnowledge(FallbackAnswer(
        answer="Models live in Settings.",
        follow_ups=["How do I add a model?", "Where is the budget?", "What is MTTA?"]))
    engine = make_engine(FakeGateway([GatewayError("down")]))
    engine.app_knowledge = knowledge
    prefs = make_prefs()
    _events, resp, _outcome = await run(engine, "where are the models?", prefs, make_ctx(prefs))
    assert resp.answer_kind == "product_help"
    assert resp.follow_ups == ["How do I add a model?", "Where is the budget?"]


async def test_engine_selector_failure_never_fails_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args, **_kwargs):
        raise RuntimeError("selector bug")

    monkeypatch.setattr(chat_module, "select_follow_ups", boom)
    gateway = FakeGateway([final("Done.", follow_ups=["x"])])
    prefs = make_prefs()
    _events, resp, _outcome = await run(make_engine(gateway), "hi", prefs, make_ctx(prefs))
    assert resp.answer == "Done." and resp.follow_ups == []


async def test_demo_answers_go_through_the_same_selector(app_state, monkeypatch: pytest.MonkeyPatch) -> None:
    """A Demo turn (the Demo planner as the provider, behind the same engine) runs the
    selector, and the response carries exactly what it chose."""
    from fastapi import FastAPI, Request

    from app.api.routes_chat import run_chat_turn
    from app.models import ChatRequest

    seen: list[list[str]] = []
    real = chat_module.select_follow_ups

    def spy(*args, **kwargs):
        chosen = real(*args, **kwargs)
        seen.append(list(chosen))
        return chosen

    monkeypatch.setattr(chat_module, "select_follow_ups", spy)
    from app.agents.chat_tools import registry

    monkeypatch.setattr(registry, "_CATALOGUE", None)              # the real catalogue, not the fakes
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        app = FastAPI()
        app.state.tlsoc = app_state
        request = Request({"type": "http", "method": "POST", "path": "/api/chat", "headers": [],
                           "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})
        start = await run_chat_turn(request, ChatRequest(
            message="How is our security posture right now?", idempotency_key="demo-fu-0001",
        ), app_state)
        import asyncio

        await asyncio.wait_for(start.handle.finished.wait(), 30)
        response = start.handle.response
    finally:
        await app_state.disable_demo()
    assert seen, "the Demo answer did not go through the selector"
    assert any(s.kind == "tool" and s.status == "ok" for s in response.steps)   # a real Demo data answer
    assert response.follow_ups == seen[-1] and 1 <= len(response.follow_ups) <= 3


# --------------------------------------------------------------------------- #
# Review fixes (Round 13 WP-ENGINE13 fixer).
# --------------------------------------------------------------------------- #
def _many_case_lists(lists: int, per_list: int = 20) -> list[ArtifactInfo]:
    return [ArtifactInfo(kind="case_list", tool="search_cases", data={"items": [
        {"case_id": f"case-{t}-{i}", "status": "open"} for i in range(per_list)]},
        case_numbers={f"case-{t}-{i}": f"CASE-{t:03d}{i:03d}" for i in range(per_list)})
        for t in range(lists)]


def test_selection_is_bounded_whatever_the_header_and_the_turn_hold() -> None:
    """A prompt-injected header with hundreds of chips over a turn with hundreds of
    anchors costs about what three chips cost: the selector checks at most
    MAX_MODEL_CHIPS chips against at most MAX_ANCHORS anchors through ONE pattern."""
    from app.agents.chat_followups import MAX_ANCHORS, MAX_MODEL_CHIPS

    artifacts = _many_case_lists(30)                       # 1,200 anchor candidates
    assert len(answer_anchors(artifacts)) == MAX_ANCHORS
    chips = [f"Question {i} about something unrelated to anything shown here at all, really {i}?"
             for i in range(200)]
    best = min(_timed(lambda: _select(chips, artifacts)) for _ in range(3))
    assert best < 0.05, best
    # The bound is real: a matching chip past the checked ones is never read.
    late = [*chips[:MAX_MODEL_CHIPS], "Why is CASE-000000 still open?"]
    assert "Why is CASE-000000 still open?" not in _select(late, artifacts)
    assert "Why is CASE-000000 still open?" in _select(late[-1:], artifacts)


def _timed(fn) -> float:
    import time

    start = time.perf_counter()
    fn()
    return time.perf_counter() - start


async def _tool_info(tool, ctx, **inp) -> list[ArtifactInfo]:
    """ArtifactInfos exactly as the engine builds them from a REAL tool's outcome."""
    out = await tool.run(ctx, **inp)
    assert out.ok, out.summary
    numbers = chat_module._case_numbers(out.observation)
    return [ArtifactInfo.from_artifact(a, tool=tool.name, params=inp, case_numbers=numbers)
            for a in out.artifacts]


@pytest.fixture
async def numbered_cases():
    from tests.test_chat_tools_cases import _case
    from app.constants import CaseStatus, Verdict
    from app.es.fake import InMemoryESClient
    from app.stores.cases import CaseStore

    store = CaseStore(InMemoryESClient())
    await store.save(_case(42, status=CaseStatus.ESCALATED, verdict=Verdict.NEEDS_HUMAN, risk=82,
                           rule="rule-5710", assignee="jdoe", case_number="CASE-000042",
                           source_name="Wazuh"))
    await store.save(_case(40, status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE, risk=12,
                           case_number="CASE-000040"))
    return store


async def test_get_case_anchors_the_case_number_rules_source_and_assignee(numbered_cases) -> None:
    """The case an answer is about is an anchor: its number, rule ids, source and
    assignee (the entity card's facts), not just the entity value."""
    from app.agents.chat_tools.cases import GetCaseTool
    from tests.test_chat_tools_support import make_ctx as tools_ctx

    infos = await _tool_info(GetCaseTool(), tools_ctx(cases=numbered_cases), case_id="case-0042")
    anchors = answer_anchors(infos)
    assert {"case-000042", "rule-5710", "wazuh", "jdoe"} <= set(anchors)
    out = _select(["What evidence would settle CASE-000042?", "Has rule-5710 fired on other hosts?",
                   "How is our posture?"], infos, question="Why does case CASE-000042 need a person?")
    assert out[:2] == ["What evidence would settle CASE-000042?", "Has rule-5710 fired on other hosts?"]
    assert "How is our posture?" not in out


async def test_a_case_list_anchors_case_numbers_from_the_observation(numbered_cases) -> None:
    """The case_list artifact carries only the internal id; the number (what the
    analyst and the model see) comes from the same call's observation."""
    from app.agents.chat_tools.cases import SearchCasesTool
    from tests.test_chat_tools_support import make_ctx as tools_ctx

    infos = await _tool_info(SearchCasesTool(), tools_ctx(cases=numbered_cases), window="all")
    lists = [i for i in infos if i.kind == "case_list"]
    assert lists and "case-000042" in answer_anchors(lists)
    out = _select(["Why is CASE-000042 rated so risky?", "Who is working on case CASE-000042?"], lists)
    assert out[:2] == ["Why is CASE-000042 rated so risky?", "Who is working on case CASE-000042?"]
    assert chat_module._case_numbers({"cases": [{"case_id": "c-1", "case_number": "CASE-1"},
                                                 {"case_id": "c-2", "case_number": ""}]}) == {"c-1": "CASE-1"}


async def test_a_technique_shown_in_a_table_is_on_topic() -> None:
    """A technique in a table cell (list_campaigns' Techniques column) is shown, so a
    chip naming it is anchored; campaign names anchor too."""
    from app.agents.chat_tools.cases import ListCampaignsTool
    from app.es.fake import InMemoryESClient
    from app.models import Campaign, CampaignEntity
    from app.stores.campaigns import CampaignStore
    from app.stores.memory import EsKVStore
    from tests.test_chat_tools_support import make_ctx as tools_ctx

    camps = CampaignStore(EsKVStore(InMemoryESClient()))
    await camps.upsert(Campaign(id="campaign-1", name="VPN brute force", case_ids=["case-1", "case-2"],
                                entities=[CampaignEntity(entity_type="user", value="pnair")],
                                mitre=["T1110", "T1078"], severity_rollup="high"))
    infos = await _tool_info(ListCampaignsTool(), tools_ctx(campaigns=camps))
    anchors = answer_anchors(infos)
    assert {"t1110", "t1078", "vpn brute force"} <= set(anchors)
    chips = ["Explain T1110 and which campaigns show it", "What links the cases in VPN brute force?",
             "Explain T1190 and which campaigns show it"]
    out = _select(chips, infos, question="Which campaigns are open?")
    assert out[:2] == chips[:2] and chips[2] not in out


def test_a_host_name_that_looks_like_a_technique_is_not_a_technique() -> None:
    hosts = ArtifactInfo(kind="categories", tool="log_stats", window="last 24 hours", params={"group_by": ["host"]},
                         data={"labels": ["t1000-web01", "db-02"], "values": [9, 4], "dimension": "host"})
    chip = "What else did t1000-web01 do yesterday?"
    assert _select([chip], [hosts], question="Top hosts")[0] == chip
    # A real, standalone technique id the answer does not show is still off topic.
    assert _select(["Did t1000-web01 show T1110?"], [hosts], question="Top hosts")[0] != "Did t1000-web01 show T1110?"
    # An id the bundled corpus does not hold is not a technique.
    assert _select(["Did t1000-web01 show T9999?"], [hosts], question="Top hosts")[0] == "Did t1000-web01 show T9999?"


def test_a_knowledge_only_answer_keeps_model_chips_like_product_help() -> None:
    """Runbook and knowledge results are reference, not data: an answer that shows
    only them keeps its model chips unchecked (at most two), never none."""
    table = ArtifactInfo(kind="table", tool="search_knowledge", data={"columns": [
        {"key": "ref", "label": "Ref", "type": "text"}, {"key": "title", "label": "Title", "type": "text"}],
        "rows": [["K1", "Phishing response runbook"]]})
    guide = ArtifactInfo(kind="guide", tool="search_knowledge", data={"links": []})
    chips = ["What does the phishing runbook say about MFA resets?", "Which playbook covers ransomware?",
             "Where are runbooks edited?"]
    assert _select(chips, [table, guide], question="What do our runbooks say about phishing?") == chips[:2]
    # With data beside it, reference still anchors (a runbook id or technique cell) and
    # the data decides the rest.
    runbooks = ArtifactInfo(kind="table", tool="search_knowledge", data={"columns": [
        {"key": "id", "label": "Id", "type": "code"}, {"key": "title", "label": "Title", "type": "text"},
        {"key": "techniques", "label": "Techniques", "type": "code"}],
        "rows": [["rb-phishing", "Phishing response", "T1566, T1078"]]})
    mixed = _select(["Which cases match rb-phishing?", "How is our posture?"], [runbooks, _ip_categories()])
    assert "Which cases match rb-phishing?" in mixed and "How is our posture?" not in mixed


def test_a_dated_window_anchors_its_bare_label() -> None:
    posture = ArtifactInfo(kind="kpis", tool="soc_metrics", window="last 7 days (since 11 Oct 2026)",
                           data={"items": [{"label": "Open now", "value": 5}]})
    caption = ArtifactInfo(kind="categories", tool="case_stats",
                           window="42 cases · exact · last 7 days (since 11 Oct 2026)",
                           data={"labels": ["High"], "values": [42], "dimension": "Severity", "ordered": True})
    for info in (posture, caption):
        assert "last 7 days" in answer_anchors([info])
        chip = "Which analysts handled the most work in the last 7 days?"
        assert _select([chip], [info])[0] == chip


def test_placeholder_labels_never_anchor() -> None:
    from app.agents.chat_followups import PLACEHOLDER_LABELS
    from app.agents.chat_tools.stats import group_label

    series = ArtifactInfo(kind="series", tool="case_stats", window="last 30 days", data={"series": [
        {"key": "brute-force-ssh", "label": "brute-force-ssh", "values": [3]},
        {"key": "other", "label": "Other", "values": [9]}], "x": ["d1"], "dimension": "rule"})
    cats = ArtifactInfo(kind="categories", tool="case_stats", window="last 30 days",
                        data={"labels": ["Unassigned", "dana"], "values": [5, 2], "dimension": "assignee"})
    anchors = answer_anchors([series, cats])
    assert "other" not in anchors and "unassigned" not in anchors and "brute-force-ssh" in anchors
    out = _select(["Do other SOC teams see this kind of noise?", "What other log sources should we connect?"],
                  [series, cats])
    assert not any(c.startswith(("Do other", "What other")) for c in out)
    # Every missing-value label the case tools write is a placeholder here.
    for field in ("assignee", "closed_by", "verdict", "disposition", "severity", "priority", "rule", "source",
                  "mitre_technique", "mitre_tactic", "anything_else"):
        assert group_label(field, None).casefold() in PLACEHOLDER_LABELS, field


def test_the_empty_and_missing_value_labels_never_anchor() -> None:
    # Round 13 T36: the worded labels that replaced the em dash for an empty log value
    # and a label-less category are engine words, not something an answer is about.
    from app.agents.chat_followups import PLACEHOLDER_LABELS
    from app.agents.chat_tools.common import EMPTY_VALUE_LABEL, MISSING_LABEL

    assert EMPTY_VALUE_LABEL.casefold() in PLACEHOLDER_LABELS and MISSING_LABEL.casefold() in PLACEHOLDER_LABELS
    cats = ArtifactInfo(kind="categories", tool="log_stats", window="last 24 hours",
                        data={"labels": [EMPTY_VALUE_LABEL, "alice"], "values": [6, 3], "dimension": "user"})
    anchors = answer_anchors([cats])
    assert "(empty)" not in anchors and "empty" not in anchors and "alice" in anchors


def test_suggestion_questions_keep_the_label_case() -> None:
    from app.agents.chat_followups import suggestion_question

    assert suggestion_question("Without the source IP filter") == "Show the same without the source IP filter"
    assert suggestion_question("Last 7 days") == "Show the same for the last 7 days"
    assert suggestion_question("All time") == "Show the same for all time"
    assert suggestion_question("ALL SOURCES") == "Show the same across all sources"
    assert suggestion_question("Open and closed cases") == "Show the same for open and closed cases"


def test_the_prompt_example_follow_up_is_anchored_in_its_own_example_answer() -> None:
    """The protocol example teaches a chip the selector keeps for that answer (an
    hbar of source IPs over the last 24 hours), and the never-end rule names the
    clarify exception."""
    import json
    import re

    from app.agents.chat_tools.base import render_tool_signatures
    from app.agents.chat_tools.registry import catalogue
    from app.agents.prompts import render_chat_agent_system

    system = render_chat_agent_system(render_tool_signatures(catalogue()))
    header = next(line.strip() for line in system.splitlines() if '"follow_ups": [' in line)
    example = json.loads(header)["follow_ups"]
    assert _select(example, [_ip_categories()], question="failed logins by source IP")[0] == example[0]
    assert re.search(r"Never end the answer with a question or an offer; suggestions go in follow_ups\. "
                     r"A clarify answer is the one exception\.", system)
    assert "2 to 6 words naming what this conversation is about, in sentence case" in system


async def test_engine_zero_result_lookup_still_drops_an_off_topic_chip(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hunt whose log search matched nothing has no artifact to show, but it is a
    data answer: the off-topic T1110 chip is dropped (A13), the lookup's own value and
    its zero-result widening stay."""
    from typing import Any, ClassVar

    from app.agents.chat_tools import registry
    from app.agents.chat_tools.base import ChatTool, ChatToolContext, ToolOutcome
    from tests.test_chat_engine_loop import FAKE_TOOLS

    class ZeroLogs(ChatTool):
        name: ClassVar[str] = "search_logs"
        label: ClassVar[str] = "Searched logs"
        scope: ClassVar[str] = "logs"
        requires: ClassVar[tuple] = (("sources", "read"),)
        signature: ClassVar[str] = "search_logs(ip, window) -- rows"

        async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
            return ToolOutcome(ok=True, summary="0 events", observation={
                "total": 0, "window": "last 24 hours", "suggestions": [
                    {"label": "Last 7 days", "tool": "search_logs", "input": {"window": "now-7d"}},
                    {"label": "Without the source IP filter", "tool": "search_logs", "input": {}}]})

    monkeypatch.setattr(registry, "_CATALOGUE", tuple(t for t in FAKE_TOOLS if t.name != "search_logs") + (ZeroLogs(),))
    gateway = FakeGateway([
        tool_call("search_logs", ip="203.0.113.250", window="now-24h"),
        final("No log event matched 203.0.113.250 in the last 24 hours.", answer_kind="data",
              follow_ups=["Hunt for T1110 brute force across all sources",
                          "Show the same for the last 7 days",
                          "Is 203.0.113.250 in any open case?",
                          "What is ATT&CK technique T1110 and how often do we see it?"]),
    ])
    prefs = make_prefs()
    _events, resp, _outcome = await run(make_engine(gateway),
                                        "Hunt for activity from 203.0.113.250 tied to T1190 in the last 24 hours",
                                        prefs, make_ctx(prefs))
    assert not any("T1110" in c for c in resp.follow_ups)
    assert resp.follow_ups == ["Show the same for the last 7 days", "Is 203.0.113.250 in any open case?"]


async def test_engine_failed_lookup_is_a_data_answer_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """A data lookup that failed shows nothing, yet the answer is about it: model chips
    are anchored (never kept unchecked as if no lookup had run)."""
    from typing import Any, ClassVar

    from app.agents.chat_tools import registry
    from app.agents.chat_tools.base import ChatTool, ChatToolContext, ToolOutcome
    from tests.test_chat_engine_loop import FAKE_TOOLS

    class BrokenStats(ChatTool):
        name: ClassVar[str] = "case_stats"
        label: ClassVar[str] = "Counted cases"
        scope: ClassVar[str] = "cases"
        requires: ClassVar[tuple] = (("cases", "read"),)
        signature: ClassVar[str] = "case_stats(rule) -- counts"

        async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
            return ToolOutcome.failure("The case store did not answer")

    monkeypatch.setattr(registry, "_CATALOGUE", FAKE_TOOLS + (BrokenStats(),))
    gateway = FakeGateway([
        tool_call("case_stats", rule="brute-force-ssh"),
        final("The case count could not be read.", answer_kind="data",
              follow_ups=["How do I add a model?", "Retry the brute-force-ssh count for the last 7 days"]),
    ])
    prefs = make_prefs()
    _events, resp, _outcome = await run(make_engine(gateway), "How many brute-force-ssh cases?", prefs,
                                        make_ctx(prefs))
    assert resp.follow_ups == ["Retry the brute-force-ssh count for the last 7 days"]


def test_a_chip_naming_a_zero_result_suggestion_is_anchored() -> None:
    """The zero-result chips sit in the same row, so a model chip that names one of
    them ("Same for the last 7 days", "…without the source IP filter") is anchored."""
    zero = ArtifactInfo.from_lookup("search_logs", {"contains": "zzqq", "window": "now-24h"},
                                    window="last 24 hours")
    widening = ["Show the same for the last 7 days", "Show the same without the source IP filter"]
    out = select_follow_ups(["Same for the last 7 days", "Try it with no source IP filter", "How is our posture?"],
                            [zero], question="Search logs for zzqq", earlier_questions=[],
                            allowed_tools=ALL_TOOLS, answer_kind="data", widening=widening)
    assert out == ["Same for the last 7 days", "Try it with no source IP filter"]


def test_a_sub_technique_of_a_shown_technique_is_on_topic() -> None:
    shown = [_mitre("T1110"), _ip_categories()]
    assert is_anchored("Which hosts show T1110.001 in the last 24 hours?", answer_anchors(shown))
    assert not is_anchored("Which hosts show T1190 in the last 24 hours?", answer_anchors(shown))


# --------------------------------------------------------------------------- #
# Final review fixes (Round 13 WP-ENGINE13 final fixer).
# --------------------------------------------------------------------------- #
async def test_get_case_asked_by_internal_id_keeps_chips_naming_that_id(numbered_cases) -> None:
    """A numbered case asked by its internal id (a needs-human starter for a case past
    the number-scan cutoff, an Ask AI case chip's fallback, a pasted id): the card shows
    the number, the same call's observation pairs it with the id, so chips naming
    either are anchored; another case's id is not."""
    from app.agents.chat_tools.cases import GetCaseTool
    from tests.test_chat_tools_support import make_ctx as tools_ctx

    infos = await _tool_info(GetCaseTool(), tools_ctx(cases=numbered_cases), case_id="case-0042")
    assert {"case-0042", "case-000042"} <= set(answer_anchors(infos))
    chips = ["What evidence would settle case-0042?", "Who else should review case-0042?"]
    out = _select(chips, infos, question="Why does case case-0042 need a person, and what would settle it?")
    assert out[:2] == chips
    assert not is_anchored("What happened in case-0099?", answer_anchors(infos))
    # An answer that shows only the case's figures (no entity card) still names the case.
    figures = [i for i in infos if i.kind == "kpis"]
    assert figures and is_anchored("What evidence would settle case-0042?", answer_anchors(figures))
    assert is_anchored("What evidence would settle CASE-000042?", answer_anchors(figures))


def test_case_pairs_anchor_a_bounded_number_of_cases() -> None:
    from app.agents.chat_followups import _CASE_PAIRS

    pairs = {f"case-{i:04d}": f"CASE-{i:06d}" for i in range(60)}
    info = ArtifactInfo(kind="kpis", tool="get_case", data={"items": []}, case_numbers=pairs)
    anchors = answer_anchors([info])
    assert "case-0000" in anchors and f"case-{_CASE_PAIRS - 1:06d}" in anchors
    assert f"case-{_CASE_PAIRS:04d}" not in anchors and len(anchors) == 2 * _CASE_PAIRS


def test_calendar_window_labels_are_windows_and_name_their_period() -> None:
    def out_chip(window: str) -> str | None:
        art = ArtifactInfo(kind="kpis", tool="case_stats", window=window, data={"items": []})
        outs = [c.text for c in deterministic_chips([art]) if c.direction == "out"]
        return outs[0] if outs else None

    assert out_chip("6 cases · exact · October 2026") == "Compare this with the previous month"
    assert out_chip("September 2026 (Asia/Kolkata)") == "Compare this with the previous month"
    assert out_chip("0 cases · exact · Q3 2026") == "Compare this with the previous quarter"
    assert out_chip("0 cases · exact · 2025") == "Compare this with the previous year"
    assert out_chip("W14 2026") == "Compare this with the previous week"
    assert out_chip("14 Sep 2026") == "Compare this with the previous day"
    # A year to date and an explicit range have no previous period of the same shape.
    for window in ("6 cases · exact · 2026 to date", "0 cases · exact · 1 Sep – 30 Sep 2026",
                   "1 Sep 2025 14:00 – 2 Sep 2026 10:00", "until 10 Oct 2026"):
        assert out_chip(window) is None, window
        assert answer_anchors([ArtifactInfo(kind="kpis", tool="case_stats", window=window)]), window
    # Engine caption parts that are not windows never become window anchors.
    assert answer_anchors([ArtifactInfo(kind="kpis", tool="soc_metrics",
                                        window="12,345 cases · exact · alerts counted from 1 Oct 2026")]) == []


@pytest.mark.parametrize("window, period", [
    ("this_month", "month"), ("2026-10", "month"), ("last_quarter", "quarter"), ("2026-Q3", "quarter"),
    ("last_year", "year"), ("ytd", None), ({"from": "2026-09-01", "to": "2026-09-30"}, None),
])
async def test_case_stats_calendar_windows_anchor_and_offer_the_previous_period(
    numbered_cases, window, period,
) -> None:
    """The real case_stats labels a calendar window "October 2026", "Q3 2026", "2025",
    "2026 to date" or "1 Sep – 30 Sep 2026": the label anchors a chip that names it,
    and a whole calendar period gets "Compare this with the previous {period}" (the
    monthly report starter, "how did last month go")."""
    from app.agents.chat_tools.stats import CaseStatsTool
    from tests.test_chat_tools_support import make_ctx as tools_ctx

    tool = CaseStatsTool()
    out = await tool.run(tools_ctx(cases=numbered_cases), window=window, group_by="severity")
    assert out.ok, out.summary
    label = out.observation["window"]
    infos = [ArtifactInfo.from_artifact(a, tool=tool.name, params={"window": window, "group_by": "severity"})
             for a in out.artifacts]
    assert " ".join(label.casefold().split()) in answer_anchors(infos)
    chip = f"What drove the change in {label}?"
    selected = _select([chip], infos, question=f"How did {label} go?")
    assert selected[0] == chip
    outs = [c.text for c in deterministic_chips(infos) if c.direction == "out"]
    if period is None:
        assert not any(c.startswith("Compare this with the previous") for c in outs), outs
    else:
        assert f"Compare this with the previous {period}" in outs
        assert f"Compare this with the previous {period}" in selected
