"""Offline tests for the DETERMINISTIC selection of the investigator's runbook.

Round 14 (SPEC §4.10.4, §4.10.9) retired the playbook selector: the investigator's
guidance is now the winner of the runbook matcher (``engine.runbook_match``) over the
matchable catalog, chosen by ``agents.investigator.select_investigator_runbook``. The
file keeps its name so the history of the selection contract stays in one place.

Clusters are built via ``cluster_from_events`` + ``make_raw_event`` (no ES/LLM) and
runbooks either come from the bundled library or are built directly as
``MatchableRunbook`` entries (no store needed).
"""

from __future__ import annotations

import pytest

from app.agents.investigator import (
    GUIDANCE_FALLBACK,
    GUIDANCE_LIBRARY_UNAVAILABLE,
    GUIDANCE_MATCHED,
    GUIDANCE_NO_MATCH,
    GUIDANCE_OFF,
    GUIDANCE_OVER_BUDGET,
    GUIDANCE_RUNBOOKS_OFF,
    select_investigator_runbook,
)
from app.agents.pipeline import builtin_runbook_catalog
from app.config import Preferences
from app.constants import EntityType
from app.engine.correlation import cluster_from_events
from app.engine.runbook_match import MatchableRunbook
from app.engine.runbook_model import (
    GENERIC_INCIDENT_RUNBOOK_ID,
    MAX_RUNBOOK_PROMPT_CHARS,
    builtin_runbook,
    render_runbook_prompt,
)
from app.models import AppliesWhen, RunbookDefinition, RunbookStep
from tests.conftest import make_raw_event


def _cluster(rule: str = "mail_auth", n: int = 5, entity_type: EntityType = EntityType.IP,
             value: str = "203.0.113.10"):
    base = 1_700_000_000_000
    events = [
        make_raw_event(id=f"e{i}", ip=value, rule=rule, ts_millis=base + i * 1000)
        for i in range(n)
    ]
    return cluster_from_events(entity_type, value, events)


def _rb(id_: str, *, priority: int = 50, published_at: str | None = None, focus: str = "Look here.",
        **applies) -> MatchableRunbook:
    definition = RunbookDefinition(
        id=id_,
        title=f"Runbook {id_}",
        summary="A test runbook.",
        applies_when=AppliesWhen(**applies),
        priority=priority,
        phases=["triage"],
        steps=[RunbookStep(id="check", phase="triage", kind="check", title="Is it real?", focus=focus)],
    )
    return MatchableRunbook(id=id_, version=1, definition=definition, origin="operator",
                            published_at=published_at)


def _prefs(**runbooks) -> Preferences:
    prefs = Preferences()
    prefs.runbooks = prefs.runbooks.model_copy(update=runbooks)
    return prefs


def test_brute_force_runbook_selected_for_mail_cluster() -> None:
    guidance = select_investigator_runbook(_cluster(rule="mail_auth"), _prefs(), builtin_runbook_catalog())
    assert guidance.status == GUIDANCE_MATCHED and guidance.selected
    assert guidance.runbook_id == "brute-force-password-spray" and guidance.version == 1
    assert guidance.explanation is not None and guidance.explanation.tier == 3
    assert guidance.reason == "Matched rule mail_auth and entity type ip."
    # The text is exactly the investigator rendering of that version.
    builtin = builtin_runbook("brute-force-password-spray")
    assert guidance.text == render_runbook_prompt(builtin.definition, builtin.version)
    assert guidance.retrieval_queries == tuple(builtin.definition.retrieval_queries)


def test_no_match_falls_back_to_generic_incident_or_nothing() -> None:
    cluster = _cluster(rule="ml_stats_unknown")
    guidance = select_investigator_runbook(cluster, _prefs(), builtin_runbook_catalog())
    assert guidance.status == GUIDANCE_FALLBACK
    assert guidance.runbook_id == GENERIC_INCIDENT_RUNBOOK_ID and guidance.selected
    assert guidance.reason == "Fallback: no other runbook matched this case."

    off = select_investigator_runbook(cluster, _prefs(fallback=False), builtin_runbook_catalog())
    assert off.status == GUIDANCE_NO_MATCH and not off.selected
    assert off.runbook_id is None and off.text is None
    assert off.reason == "No runbook matched this case."


def test_min_event_count_below_threshold_no_match() -> None:
    rb = _rb("mail-brute", rule_ids=["mail_auth"], min_event_count=3)
    assert select_investigator_runbook(_cluster(n=2), _prefs(fallback=False), [rb]).runbook_id is None
    assert select_investigator_runbook(_cluster(n=3), _prefs(fallback=False), [rb]).runbook_id == "mail-brute"


def test_entity_type_constrains() -> None:
    # A USER cluster must not match a runbook scoped to ip/host only.
    cluster = _cluster(rule="mail_auth", entity_type=EntityType.USER, value="alice")
    only_ip = _rb("ip-only", rule_ids=["mail_auth"], entity_types=["ip", "host"])
    also_user = _rb("user-ok", rule_ids=["mail_auth"], entity_types=["user"])
    prefs = _prefs(fallback=False)
    assert select_investigator_runbook(cluster, prefs, [only_ip]).runbook_id is None
    assert select_investigator_runbook(cluster, prefs, [also_user]).runbook_id == "user-ok"


def test_a_runbook_without_criteria_is_never_chosen_automatically() -> None:
    # Unlike the retired playbooks, a runbook that states no criterion is attached by
    # a person only; it never becomes the investigator's guidance by itself.
    wild = _rb("catch-all")
    guidance = select_investigator_runbook(_cluster(rule="anything", n=1), _prefs(fallback=False), [wild])
    assert guidance.runbook_id is None and guidance.status == GUIDANCE_NO_MATCH


def test_higher_priority_wins_and_a_tie_is_reported() -> None:
    cluster = _cluster(rule="mail_auth")
    low = _rb("a-low", rule_ids=["mail_auth"], priority=10)
    high = _rb("b-high", rule_ids=["mail_auth"], priority=50)
    assert select_investigator_runbook(cluster, _prefs(), [low, high]).runbook_id == "b-high"

    # Equal on every rule up to the id: the first by id wins, and the tie is said.
    z = _rb("z-id", rule_ids=["mail_auth"], priority=50)
    a = _rb("a-id", rule_ids=["mail_auth"], priority=50)
    tied = select_investigator_runbook(cluster, _prefs(), [z, a])
    assert tied.runbook_id == "a-id" and tied.tied == 2
    assert tied.reason.endswith("2 runbooks matched equally; the first by name was chosen.")


def test_a_technique_only_runbook_waits_for_the_verdict() -> None:
    # A cluster carries no technique before its investigation, so a runbook that
    # names only techniques is not the investigator's guidance; it can attach after
    # the verdict (D43). Rule names are never read as techniques.
    by_technique = _rb("technique-only", mitre=["T1110"])
    cluster = _cluster(rule="T1110")
    assert select_investigator_runbook(cluster, _prefs(fallback=False), [by_technique]).runbook_id is None


def test_an_outcome_conditioned_runbook_never_guides_the_verdict() -> None:
    # A runbook that applies only to a verdict would steer the very verdict it is
    # conditioned on (#3, #9): it is never chosen before the investigation.
    fp_only = _rb("fp-only", rule_ids=["mail_auth"], verdicts=["FALSE_POSITIVE"])
    assert select_investigator_runbook(_cluster(), _prefs(fallback=False), [fp_only]).runbook_id is None


def test_severity_from_the_caller_is_respected() -> None:
    high_only = _rb("high-only", rule_ids=["mail_auth"], severity_at_least="high")
    prefs = _prefs(fallback=False)
    assert select_investigator_runbook(_cluster(), prefs, [high_only], severity="low").runbook_id is None
    assert select_investigator_runbook(_cluster(), prefs, [high_only], severity="critical").runbook_id == "high-only"


@pytest.mark.parametrize("setting,status", [
    ("investigator_guidance", GUIDANCE_OFF),
    ("enabled", GUIDANCE_RUNBOOKS_OFF),
])
def test_switched_off_means_no_runbook(setting: str, status: str) -> None:
    guidance = select_investigator_runbook(_cluster(), _prefs(**{setting: False}), builtin_runbook_catalog())
    assert guidance.status == status and not guidance.selected and guidance.runbook_id is None


def test_an_unreadable_library_means_no_runbook() -> None:
    # Fail closed: never a partial catalog in which a replaced built-in could stand in
    # for the operator copy that replaces it.
    guidance = select_investigator_runbook(_cluster(), _prefs(), None)
    assert guidance.status == GUIDANCE_LIBRARY_UNAVAILABLE and guidance.runbook_id is None
    assert guidance.reason.startswith("The runbook library could not be read")


def test_an_over_budget_rendering_is_named_but_never_sent_or_truncated() -> None:
    # Publishing refuses such a version; this is the defence behind it.
    long_focus = "word " * 59 + "end."
    steps = [
        RunbookStep(id=f"s{i}", phase="triage", kind="check", title=f"Question {i}?", focus=long_focus)
        for i in range(15)
    ]
    rb = _rb("too-long", rule_ids=["mail_auth"])
    rb = MatchableRunbook(
        id=rb.id, version=1, origin="operator",
        definition=rb.definition.model_copy(update={"steps": steps}),
    )
    assert len(render_runbook_prompt(rb.definition, 1)) > MAX_RUNBOOK_PROMPT_CHARS
    guidance = select_investigator_runbook(_cluster(), _prefs(fallback=False), [rb])
    assert guidance.status == GUIDANCE_OVER_BUDGET
    assert guidance.runbook_id == "too-long" and guidance.text is None and not guidance.selected
    assert guidance.prompt_chars > MAX_RUNBOOK_PROMPT_CHARS
    payload = guidance.selection_payload()
    assert payload is not None and payload["used"] is False


def test_bundled_cloud_data_and_ransomware_runbooks_select_exactly() -> None:
    expected = {
        "cloud_iam_anomaly": "cloud-identity-keys",
        "data_exfiltration": "data-exfiltration",
        "ransomware_behavior": "ransomware-destructive",
    }
    for rule_id, runbook_id in expected.items():
        guidance = select_investigator_runbook(_cluster(rule=rule_id), _prefs(), builtin_runbook_catalog())
        assert guidance.runbook_id == runbook_id, rule_id
        assert guidance.status == GUIDANCE_MATCHED
        assert rule_id in guidance.reason

    unrelated = select_investigator_runbook(
        _cluster(rule="unrelated_custom_rule"), _prefs(), builtin_runbook_catalog()
    )
    assert unrelated.runbook_id == GENERIC_INCIDENT_RUNBOOK_ID
    assert unrelated.status == GUIDANCE_FALLBACK
