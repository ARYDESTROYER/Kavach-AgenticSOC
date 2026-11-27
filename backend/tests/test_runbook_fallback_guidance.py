"""The Generic incident fallback is a checklist for people, never investigator guidance.

A staging A/B found that giving the investigator the always-matching Generic
incident runbook as trusted guidance (and its two retrieval queries) moved about
half of the FALSE_POSITIVE verdicts to NEEDS_HUMAN. Since then only a specific
(tier 1 or higher) runbook guides the investigator; the fallback is still chosen,
recorded and attached to a case that needs a person. ``decide()`` is untouched (#3).

Offline (fake Elasticsearch, mock model). The verdict-mix gate itself is
``test_verdict_stability_gate.py``.
"""

from __future__ import annotations

import json

from app.agents.investigator import (
    FALLBACK_NOT_GIVEN_SENTENCE,
    GUIDANCE_FALLBACK,
    GUIDANCE_MATCHED,
    select_investigator_runbook,
)
from app.agents.pipeline import builtin_runbook_catalog
from app.agents.prompts import (
    INVESTIGATOR_SYSTEM,
    MEMORY_OPEN,
    RUNBOOK_CLOSE,
    RUNBOOK_HEADING,
    RUNBOOK_OPEN,
    render_cluster,
)
from app.config import Preferences
from app.constants import UNTRUSTED_OPEN, EntityType, SourceSurface
from app.engine.case_rationale import build_rationale
from app.engine.correlation import cluster_from_events
from app.engine.runbook_model import (
    GENERIC_INCIDENT_RUNBOOK_ID,
    builtin_runbook,
    render_runbook_prompt,
)
from app.models import MemoryEntry
from tests.conftest import make_raw_event


def _cluster(rule: str, n: int = 5, ip: str = "198.51.100.40"):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def _script(mock_provider) -> None:
    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"}))
    mock_provider.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {"verdict": "NEEDS_HUMAN", "confidence": 0.3, "evidence": [], "mitre": [],
                    "recommended_action": "review", "reproduce_query": ""},
    }))


def _user_prompt(mock_provider) -> str:
    return [c for c in mock_provider.calls if c["role"] == "investigator"][-1]["messages"][1]["content"]


async def _rows(state, case_id: str):
    rows = await state.audit.records_for_case(case_id)
    selector = [r for r in rows if r.get("action") == "runbook.selected"][-1]
    procedure = [r for r in rows if r.get("actor") == "procedure_provenance"][-1]
    return rows, selector, procedure


# --------------------------------------------------------------------------- #
# Selection and the investigator prompt
# --------------------------------------------------------------------------- #
async def test_a_case_only_the_fallback_matches_gets_no_guidance_and_no_runbook_queries(
    app_state, mock_provider,
) -> None:
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("lms_ajax_service_call"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    user = _user_prompt(mock_provider)
    assert RUNBOOK_OPEN not in user and RUNBOOK_HEADING not in user
    generic = builtin_runbook(GENERIC_INCIDENT_RUNBOOK_ID)
    for step in generic.definition.steps:
        if step.escalate_if:
            assert step.escalate_if not in user
    assert UNTRUSTED_OPEN in user  # the evidence is still fenced (#9)
    assert case.runbook_id is None and case.runbook_version is None

    rows, selector, procedure = await _rows(app_state, case.case_id)
    selection = selector["tool_input"]["runbook_selection"]
    assert selector["tool_input"]["runbook_status"] == GUIDANCE_FALLBACK
    assert (selection["id"], selection["used"], selection["tier"]) == (GENERIC_INCIDENT_RUNBOOK_ID, False, 0)
    assert selection["prompt_chars"] == 0
    assert selector["result_summary"].startswith("runbook=generic-incident v")
    groups = [g["group"] for g in procedure["tool_input"]["retrieval_query_groups"]]
    assert groups == ["cluster"]
    assert procedure["tool_input"]["runbook"]["consulted"] is False
    assert procedure["tool_input"]["runbook"]["selected_id"] is None
    context = [r for r in rows if r.get("actor") == "context"][-1]["tool_input"]
    assert context["runbook"] is None and context["runbook_detail"] is None


async def test_a_specific_runbook_still_guides_with_its_block_and_queries(app_state, mock_provider) -> None:
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("mail_auth"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    user = _user_prompt(mock_provider)
    winner = builtin_runbook("brute-force-password-spray")
    block = user.split(RUNBOOK_OPEN + "\n")[1].split("\n" + RUNBOOK_CLOSE)[0]
    assert block == render_runbook_prompt(winner.definition, winner.version)
    assert case.runbook_id == winner.id and case.runbook_version == winner.version
    _rows_, selector, procedure = await _rows(app_state, case.case_id)
    assert selector["tool_input"]["runbook_status"] == GUIDANCE_MATCHED
    assert selector["tool_input"]["runbook_selection"]["used"] is True
    groups = [g["group"] for g in procedure["tool_input"]["retrieval_query_groups"]]
    assert groups == ["cluster", *[f"runbook:{i + 1}" for i in range(len(winner.definition.retrieval_queries))]]
    assert procedure["tool_input"]["runbook"]["consulted"] is True


async def test_the_fallback_still_attaches_to_a_case_that_needs_a_person(app_state, mock_provider) -> None:
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("lms_session_key_reuse"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    runs = (await app_state.runbook_runs.get(case.case_id)).runs
    assert [(r.runbook_id, r.attached_by) for r in runs] == [(GENERIC_INCIDENT_RUNBOOK_ID, "fallback")]


async def test_the_rationale_says_the_fallback_was_selected_only(app_state, mock_provider) -> None:
    _script(mock_provider)
    case = await app_state.pipeline.investigate_cluster(
        _cluster("lms_path_not_found"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    rows = await app_state.audit.records_for_case(case.case_id)
    runbook = build_rationale(case.case_id, case, rows)["runbook"]
    assert runbook["id"] in ("", None) and runbook["consulted"] is False
    assert (runbook["selected_id"], runbook["status"], runbook["tier"]) == (
        GENERIC_INCIDENT_RUNBOOK_ID, GUIDANCE_FALLBACK, 0,
    )
    assert runbook["reason"].endswith(FALLBACK_NOT_GIVEN_SENTENCE)


def test_every_bundled_runbook_but_the_fallback_can_guide() -> None:
    # The library's only ``always`` runbook is Generic incident; every other built-in
    # names rules, so each one guides the investigator on a cluster of its rule.
    catalog = builtin_runbook_catalog()
    for entry in catalog:
        rules = list(entry.definition.applies_when.rule_ids or [])
        if entry.definition.applies_when.always:
            assert entry.id == GENERIC_INCIDENT_RUNBOOK_ID and not rules
            continue
        assert rules, entry.id
        guidance = select_investigator_runbook(_cluster(rules[0]), Preferences(), catalog)
        assert guidance.status == GUIDANCE_MATCHED and guidance.selected, entry.id


# --------------------------------------------------------------------------- #
# Prompt assembly and the precedence sentence
# --------------------------------------------------------------------------- #
def test_the_runbook_block_sits_between_trusted_context_and_the_evidence() -> None:
    memory = [MemoryEntry(id="m1", text="10.0.0.0/8 is internal", category="network")]
    cluster = _cluster("mail_auth")
    text = render_runbook_prompt(builtin_runbook("brute-force-password-spray").definition, 1)
    guided = render_cluster(cluster, None, None, runbook=text, memory=memory)
    assert guided.index(MEMORY_OPEN) < guided.index(RUNBOOK_OPEN) < guided.index(UNTRUSTED_OPEN)
    # The fallback gives no text, so the prompt has no block at all.
    unguided = render_cluster(cluster, None, None, runbook=None, memory=memory)
    assert RUNBOOK_OPEN not in unguided and RUNBOOK_HEADING not in unguided
    assert unguided.index(MEMORY_OPEN) < unguided.index(UNTRUSTED_OPEN)


def test_the_precedence_sentence_keeps_the_runbook_advisory_and_below_the_policy() -> None:
    sentence = INVESTIGATOR_SYSTEM.split("PRECEDENCE (highest to lowest):", 1)[1].split("Available tools", 1)[0]
    order = ["deterministic close/escalate policy", "base role rules", "active runbook",
             "operator MEMORY", "untrusted evidence"]
    positions = [sentence.index(part) for part in order]
    assert positions == sorted(positions)
    assert "advisory" in sentence and "code decides the case outcome" in sentence


# --------------------------------------------------------------------------- #
# The Generic incident checklist's escalation lines
# --------------------------------------------------------------------------- #
def test_generic_incident_escalates_on_evidence_not_on_the_default_state_of_an_alert() -> None:
    generic = builtin_runbook(GENERIC_INCIDENT_RUNBOOK_ID)
    assert generic.version == 2  # its text changed, so it is a new built-in version
    lines = {step.id: step.escalate_if for step in generic.definition.steps if step.escalate_if}
    assert lines == {
        "what-happened": (
            "the evidence shows compromise or harm, such as a privileged account used without "
            "approval, sensitive data exposed, or malicious activity that continues after a block."
        ),
        "scope": "confirmed spread to other hosts or accounts, or data sent out of the network without approval.",
        "decide": "confirmed malicious activity, or impact on production systems or data.",
    }
    rendered = render_runbook_prompt(generic.definition, generic.version)
    for retired in ("production systems, sensitive data or a privileged account is involved",
                    "or the activity continues", "more than one host or account", "data leaving the network"):
        assert retired not in rendered
    assert "\u2014" not in rendered  # no em dash in the rendered checklist
