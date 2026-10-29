"""The chat case card links each of its rules (Round 14 SPEC §4.6.5).

The case entity card's "Rules" fact keeps its one-line ``value`` (what exporters and
earlier clients read) and adds ``items``: each rule exactly as the case stores it, with
a ``rule`` page ref built by code (``common.rule_drill``) over the case's own window,
never the rule sheet's default of three days. A value the ref cannot carry exactly is
plain text with no link; the block validator keeps a ref only when it names a rule and
never on a model-written (``ai``) block (G5). Rule values are untrusted data (#9) and
never reach the model's observation through this card.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.agents import blocks as B
from app.agents.chat_tools import cases as C
from app.agents.chat_tools.cases import GetCaseTool
from app.agents.chat_tools.common import nav_instant
from app.constants import CaseStatus, DecisionBy, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, TriggerReason
from app.stores.cases import CaseStore
from app.utils import to_millis

from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

pytestmark = pytest.mark.asyncio

GERMAN = "Fehlgeschlagene Anmeldung über SSH"
TOO_LONG = "r" * (B.MAX_RULE_CHARS + 1)
CONTROL = "rule\u0007bell"

# A case first seen on 10 October whose last batch of events merged in two days later:
# its rules open over those two days, not over the last three, and not up to the close
# an analyst recorded weeks afterwards.
FIRST = datetime(2026, 10, 10, 8, 14, 3, tzinfo=timezone.utc)
CREATED = FIRST + timedelta(minutes=7)
TRIGGER_START = FIRST + timedelta(minutes=2)
TRIGGER_END = FIRST + timedelta(hours=1, milliseconds=250)
ATTACHED = FIRST + timedelta(days=2, hours=3)
UPDATED = FIRST + timedelta(days=18)


def _case(case_id: str = "case-0000000000000001", *, rules: list[str] | None = None, **kw) -> Case:
    base = dict(
        case_id=case_id, case_number="CASE-000301", title="Password spray against the VPN",
        source_surface=SourceSurface.INVESTIGATE, cluster_signature=f"sig-{case_id}",
        entity=Entity(type="ip", value="198.51.100.23"), status=CaseStatus.ESCALATED,
        verdict=Verdict.TRUE_POSITIVE, decision_by=DecisionBy.SYSTEM, risk_score=61.0,
        rule_ids=list(rules if rules is not None else ["5710", GERMAN]),
        first_seen_millis=to_millis(FIRST), created_at=CREATED.isoformat(), updated_at=UPDATED.isoformat(),
        trigger_reason=TriggerReason(rule_value="5710", window_start=to_millis(TRIGGER_START),
                                     window_end=to_millis(TRIGGER_END)),
        # One merged batch (``engine.ingest.attach_cluster``), then an analyst's later
        # assignment, which moved ``updated_at`` but brought no event.
        history=[{"ts": ATTACHED.isoformat(), "event": "attach", "added_events": 4},
                 {"ts": UPDATED.isoformat(), "event": "assigned", "assignee": "asha"}],
    )
    base.update(kw)
    return Case(**base)


async def _entity(case: Case):
    store = CaseStore(InMemoryESClient())
    await store.save(case)
    out = await GetCaseTool().run(make_ctx(cases=store), case_id=case.case_id)
    assert out.ok, out.error
    return out, next(a for a in out.artifacts if a.kind == "entity")


def _rules(entity) -> dict:
    return next(f for f in entity.data["facts"] if f["label"] == "Rules")


async def test_each_rule_opens_its_sheet_over_the_cases_own_window() -> None:
    out, entity = await _entity(_case())
    fact = _rules(entity)
    assert fact["value"] == f"5710, {GERMAN}"          # unchanged for exporters and earlier clients
    assert fact["untrusted"] is True
    window = {"from": nav_instant(FIRST, round_up=True), "to": nav_instant(ATTACHED, round_up=False)}
    assert window == {"from": "2026-10-10T08:14:03Z", "to": "2026-10-12T11:14:03Z"}
    assert fact["items"] == [
        {"value": "5710", "drill": {"page": "rule", "opts": {"rule": "5710", **window}}},
        {"value": GERMAN, "drill": {"page": "rule", "opts": {"rule": GERMAN, **window}}},
    ]
    assert_artifacts_render(out)


async def test_the_window_runs_from_the_earliest_to_the_latest_moment_events_reached_the_case() -> None:
    # The triggering window ends after the last merged batch: it is the window's end.
    late = FIRST + timedelta(days=3)
    case = _case(trigger_reason=TriggerReason(window_start=to_millis(TRIGGER_START), window_end=to_millis(late)))
    window = C.case_rule_window(case)
    assert window is not None and (window.start, window.end) == (FIRST, late)
    # No first member event recorded (an older case): the triggering window starts it.
    case = _case(first_seen_millis=0)
    window = C.case_rule_window(case)
    assert window is not None and (window.start, window.end) == (TRIGGER_START, ATTACHED)
    # The newest of several merged batches ends it.
    later = ATTACHED + timedelta(hours=5)
    case = _case(history=[{"ts": ATTACHED.isoformat(), "event": "attach"},
                          {"ts": later.isoformat(), "event": "attach"},
                          {"ts": "not a time", "event": "attach"}])
    window = C.case_rule_window(case)
    assert window is not None and window.end == later


async def test_an_analyst_action_weeks_later_never_widens_the_window() -> None:
    """``updated_at`` moves on every analyst action (a comment, a tag, an assignment, a
    close): a case handled weeks after its events still opens its rules over its own
    span, not over weeks of hits unrelated to it."""
    case = _case(history=[{"ts": UPDATED.isoformat(), "event": "assigned", "assignee": "asha"},
                          {"ts": UPDATED.isoformat(), "event": "status", "to": "closed"}])
    window = C.case_rule_window(case)
    assert window is not None and (window.start, window.end) == (FIRST, TRIGGER_END)
    _out, entity = await _entity(case)
    opts = _rules(entity)["items"][0]["drill"]["opts"]
    assert (opts["from"], opts["to"]) == ("2026-10-10T08:14:03Z", "2026-10-10T09:14:03.250Z")
    # An older case with no history at all ends at its triggering window too.
    assert C.case_rule_window(_case(history=[])).end == TRIGGER_END


async def test_a_case_whose_moments_coincide_opens_on_one_minute() -> None:
    case = _case(first_seen_millis=0, trigger_reason=None, created_at=CREATED.isoformat(), history=[])
    window = C.case_rule_window(case)
    assert window is not None
    assert (window.start, window.end) == (CREATED, CREATED + C.CASE_RULE_WINDOW_MIN)
    _out, entity = await _entity(case)
    opts = _rules(entity)["items"][0]["drill"]["opts"]
    assert (opts["from"], opts["to"]) == ("2026-10-10T08:21:03Z", "2026-10-10T08:22:03Z")


async def test_a_case_with_no_readable_moment_names_its_rules_without_links() -> None:
    case = _case().model_copy(update={"first_seen_millis": 0, "trigger_reason": None,
                                      "created_at": "not a time", "updated_at": "", "history": []})
    assert C.case_rule_window(case) is None
    fact = C.rules_fact(case)
    assert fact["items"] == [{"value": "5710"}, {"value": GERMAN}]


async def test_a_rule_the_ref_cannot_carry_is_plain_text() -> None:
    _out, entity = await _entity(_case(rules=["5710", TOO_LONG, CONTROL]))
    items = _rules(entity)["items"]
    assert [("drill" in item) for item in items] == [True, False, False]
    assert items[1]["value"] == TOO_LONG and items[2]["value"] == CONTROL


async def test_the_card_names_at_most_five_rules_one_by_one() -> None:
    rules = [f"rule-{i}" for i in range(8)]
    _out, entity = await _entity(_case(rules=rules))
    fact = _rules(entity)
    assert fact["value"] == ", ".join(rules[:5])
    assert [item["value"] for item in fact["items"]] == rules[:5]
    assert C.CASE_CARD_RULES == B.MAX_ENTITY_FACT_ITEMS


async def test_the_refs_survive_materialisation_and_validation() -> None:
    out, entity = await _entity(_case(rules=["5710", CONTROL]))
    blocks, dropped = B.validate_blocks(B.to_blocks(entity, B.MaterialiseOptions(block_id="b1")))
    assert dropped == []
    fact = next(f for f in blocks[0]["facts"] if f["label"] == "Rules")
    assert fact["items"][0]["drill"]["page"] == "rule"
    assert fact["items"][0]["drill"]["opts"]["rule"] == "5710"
    assert "drill" not in fact["items"][1]                    # the value is plain text
    assert fact["items"][1]["value"] == "rulebell"            # sanitised like any fact value
    # Re-validating the stored form is a no-op (live and replay converge on the same bytes).
    again, _ = B.validate_blocks(blocks)
    assert again == blocks
    # The model's observation is unchanged: no link (and no second copy of a rule) is added.
    assert "drill" not in str(out.observation)


def _entity_block(provenance: str, items: list) -> dict:
    return {"type": "entity", "id": "b1", "provenance": provenance, "entity": {"kind": "ip", "value": "1.2.3.4"},
            "facts": [{"label": "Rules", "value": "a", "untrusted": True, "items": items}]}


async def test_only_a_code_built_rule_ref_is_kept() -> None:
    rule_ref = {"page": "rule", "opts": {"rule": "a", "from": "2026-10-10T08:00:00Z", "to": "2026-10-11T08:00:00Z"}}
    items = [
        {"value": "a", "drill": rule_ref},
        {"value": "b", "drill": {"page": "logs", "opts": {"rule": "b"}}},      # not the rule sheet
        {"value": "c", "drill": {"page": "rule", "opts": {}}},                 # names no rule
        {"value": "d", "drill": "javascript:alert(1)"},                        # not a ref at all
        {"value": "e", "unknown": True},                                       # an unknown key: dropped
    ]
    blocks, _ = B.validate_blocks([_entity_block("code", items)])
    kept = blocks[0]["facts"][0]["items"]
    assert kept == [{"value": "a", "drill": rule_ref}, {"value": "b"}, {"value": "c"}, {"value": "d"}]
    # A model-written card never links (G5), even where its block is allowed.
    ai = B.EntityBlock.model_validate(_entity_block("ai", items[:1]))
    assert ai.facts[0].items is not None and ai.facts[0].items[0].drill is None
    # Older answers carry no items: the fact is the plain value it always was.
    plain, _ = B.validate_blocks([{**_entity_block("code", []), "facts": [{"label": "Rules", "value": "a"}]}])
    assert plain[0]["facts"] == [{"label": "Rules", "value": "a"}]
