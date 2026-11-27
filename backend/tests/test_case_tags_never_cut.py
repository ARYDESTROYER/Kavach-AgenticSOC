"""Case tags are never cut to fit (Round 12 polish).

A tag longer than the limit used to be stored cut to 40 characters, so a sentence typed
into the close dialog's Tags field became the tag "Scheduled vendor API sync from the
known". Both write paths, a lifecycle action's additive ``tags`` and the dedicated
``/tags`` route, now refuse a NEW over-long tag with a 422 that says why, and change
nothing on the case. A tag the case already carries passes unchanged.

The same holds for the 25-tag count (final polish): new tags past it are refused with
the reason (the route answers 422, the bulk tag job fails that case's item with it) and
never left off silently. Case automation's ``tag`` action reads the Rule editor's
``tags`` list (it used to read only ``tag``/``value``, so editor rules never tagged) and
records a tag it could not add instead of cutting it. The rules live in
``app/engine/case_tags.py``.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from app.api.routes import CASE_TAG_MAX_CHARS, CASE_TAG_MAX_COUNT, _merge_case_tags
from app.engine.case_tags import CaseTagError, automation_tags, merge_case_tags
from tests.test_case_actions_reinvestigate import _create_case

LONG = "Scheduled vendor API sync from the known service account"  # 56 characters


def test_limit_is_forty_characters():
    assert CASE_TAG_MAX_CHARS == 40
    assert len(LONG) > CASE_TAG_MAX_CHARS


def test_action_refuses_an_over_long_tag_and_leaves_the_case_open(client, mock_provider):
    case_id = _create_case(client, mock_provider, "192.0.2.71")
    before = client.get(f"/api/cases/{case_id}").json()

    r = client.post(f"/api/cases/{case_id}/action", json={
        "action": "close", "disposition": "false_positive", "disposition_declared": True,
        "tags": ["vendor-sync", LONG],
    })
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "up to 40 characters" in detail and f"has {len(LONG)}" in detail

    after = client.get(f"/api/cases/{case_id}").json()
    # Nothing changed: not closed, no tag added, and no cut copy stored.
    assert after["status"] == before["status"]
    assert after["tags"] == before["tags"]
    assert not any(t.startswith("Scheduled vendor") for t in after["tags"])


def test_action_keeps_a_tag_at_the_limit_whole(client, mock_provider):
    case_id = _create_case(client, mock_provider, "192.0.2.72")
    exact = "x" * CASE_TAG_MAX_CHARS
    r = client.post(f"/api/cases/{case_id}/action", json={"action": "acknowledge", "tags": [exact]})
    assert r.status_code == 200, r.text
    assert exact in r.json()["tags"]


def test_tags_route_refuses_an_over_long_tag(client, mock_provider):
    case_id = _create_case(client, mock_provider, "192.0.2.73")
    client.post(f"/api/cases/{case_id}/tags", json={"tags": ["existing"]})

    r = client.post(f"/api/cases/{case_id}/tags", json={"tags": ["existing", LONG]})
    assert r.status_code == 422, r.text
    assert client.get(f"/api/cases/{case_id}").json()["tags"] == ["existing"]


def test_a_tag_already_on_the_case_passes_unchanged():
    # A case automation rule may have added a longer tag; editing the other tags must
    # neither refuse nor cut it.
    legacy = "y" * (CASE_TAG_MAX_CHARS + 5)
    assert _merge_case_tags([legacy, "a"], [legacy, "a", "b"], replace=True) == [legacy, "a", "b"]
    assert _merge_case_tags([legacy], ["  b  ", "b", ""], replace=False) == [legacy, "b"]


# --------------------------------------------------------------------------- #
# The count bound (final polish): a case holds up to 25 tags. A change that would add
# tags past that answers 422 with the reason; nothing is left off silently.
# --------------------------------------------------------------------------- #
FULL = [f"t{i:02d}" for i in range(CASE_TAG_MAX_COUNT)]


def test_count_limit_is_twenty_five():
    assert CASE_TAG_MAX_COUNT == 25


def test_merge_refuses_new_tags_past_the_count_and_drops_none():
    with pytest.raises(CaseTagError) as raised:
        merge_case_tags(FULL[:24], ["a", "b", "c"], replace=False)
    message = str(raised.value)
    assert "up to 25 tags" in message and "would give it 27" in message
    assert "remove 2" in message
    # Up to the bound is fine, whole.
    assert merge_case_tags(FULL[:24], ["a"], replace=False) == [*FULL[:24], "a"]
    # Replacing a tag on a full case is not "past the bound".
    assert merge_case_tags(FULL, [*FULL[:24], "new"], replace=True) == [*FULL[:24], "new"]


def test_merge_keeps_a_case_already_over_the_count_whole():
    # A case that already carries more than the bound (written before the bound, or by
    # Demo Mode's own tags) keeps every tag: nothing is cut on an unrelated edit.
    legacy = [f"x{i:02d}" for i in range(CASE_TAG_MAX_COUNT + 2)]
    assert merge_case_tags(legacy, legacy[1:], replace=True) == legacy[1:]
    assert merge_case_tags(legacy, [legacy[0]], replace=False) == legacy
    with pytest.raises(CaseTagError):
        merge_case_tags(legacy, [*legacy, "one-more"], replace=True)


def test_action_refuses_tags_past_the_count_and_leaves_the_case_open(client, mock_provider):
    case_id = _create_case(client, mock_provider, "192.0.2.74")
    seeded = client.post(f"/api/cases/{case_id}/tags", json={"tags": FULL[:24]})
    assert seeded.status_code == 200, seeded.text
    before = client.get(f"/api/cases/{case_id}").json()
    assert len(before["tags"]) == 24

    r = client.post(f"/api/cases/{case_id}/action", json={
        "action": "close", "disposition": "false_positive", "disposition_declared": True,
        "tags": ["a", "b", "c"],
    })
    assert r.status_code == 422, r.text
    assert "up to 25 tags" in r.json()["detail"]
    after = client.get(f"/api/cases/{case_id}").json()
    assert after["status"] == before["status"]
    assert after["tags"] == before["tags"]

    ok = client.post(f"/api/cases/{case_id}/action", json={"action": "acknowledge", "tags": ["a"]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["tags"] == [*FULL[:24], "a"]


def test_tags_route_refuses_a_26th_tag(client, mock_provider):
    case_id = _create_case(client, mock_provider, "192.0.2.75")
    assert client.post(f"/api/cases/{case_id}/tags", json={"tags": FULL}).status_code == 200
    r = client.post(f"/api/cases/{case_id}/tags", json={"tags": [*FULL, "one-more"]})
    assert r.status_code == 422, r.text
    assert "would give it 26" in r.json()["detail"]
    assert client.get(f"/api/cases/{case_id}").json()["tags"] == FULL


@pytest.mark.asyncio
async def test_bulk_tag_job_fails_a_full_case_with_the_reason(app_state):
    """The bulk tag job adds one tag per case through ``/tags``: a full case is a failed
    item that says why, not a silent success with the tag left off."""
    from app.constants import CaseStatus, EntityType, JobKind, JobStatus, SourceSurface
    from app.models import Case, Entity, Job, JobProgress, JobTransition
    from app.stores.jobs import idempotency_hash

    await app_state.job_runner.stop()
    app_state.job_runner.notify = lambda: None
    for case_id, tags in (("case-full", FULL), ("case-room", ["one"])):
        await app_state.real_cases.save(Case(
            case_id=case_id, cluster_signature=f"sig-{case_id}",
            source_surface=SourceSurface.AUTOMATED_SCAN,
            entity=Entity(type=EntityType.IP, value="203.0.113.9"),
            status=CaseStatus.OPEN, tags=list(tags),
        ))
    params = {"case_ids": ["case-full", "case-room"], "tag": "bulk-added"}
    stored, _, _ = await app_state.jobs.create(Job(
        kind=JobKind.CASE_TAG, actor="", actor_generation="",
        progress=JobProgress(total=2, unit="cases"),
        request_fingerprint=hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest(),
        idempotency_key_hash=idempotency_hash("", "bulk-tag-count", ""),
        params=params, item_states={"case-full": "pending", "case-room": "pending"},
        transitions=[JobTransition(seq=1, name="submitted")], transition_seq=1,
    ))
    claimed = await app_state.jobs.claim_next("tag-worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await app_state.job_runner._execute(running, token)  # noqa: SLF001

    terminal = await app_state.jobs.get(stored.job_id)
    assert terminal is not None and terminal.status == JobStatus.PARTIAL
    assert [f.item_ref for f in terminal.failures] == ["case-full"]
    assert "up to 25 tags" in terminal.failures[0].reason
    full = await app_state.real_cases.get("case-full")
    room = await app_state.real_cases.get("case-room")
    assert full is not None and full.tags == FULL
    assert room is not None and room.tags == ["one", "bulk-added"]


# --------------------------------------------------------------------------- #
# Case automation's tag action: reads the editor's ``tags`` list and never cuts.
# --------------------------------------------------------------------------- #
def test_automation_tags_reads_the_editor_list_and_the_single_value():
    assert automation_tags({"tags": ["auto-triaged", " watch ", "auto-triaged", ""]}) == [
        "auto-triaged", "watch",
    ]
    assert automation_tags({"tag": "legacy"}) == ["legacy"]
    assert automation_tags({"value": "legacy-value"}) == ["legacy-value"]
    # The editor's list wins; an empty list falls back to the single value.
    assert automation_tags({"tags": ["new"], "tag": "old"}) == ["new"]
    assert automation_tags({"tags": [], "tag": "old"}) == ["old"]
    assert automation_tags({}) == []
    # Never cut here: the caller refuses an over-long one.
    assert automation_tags({"tags": [LONG]}) == [LONG]


def _automation_rule(payload):
    from app.config import AutomationRule
    return AutomationRule(id="tagger", action="tag", payload=payload)


def _automation_prefs(rules):
    from app.config import Preferences, ThresholdAutomationConfig
    return Preferences(threshold_automation=ThresholdAutomationConfig(enabled=True, rules=rules))


def _automation_case(case_id, tags=None):
    from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
    from app.models import Case, Entity
    return Case(
        case_id=case_id, cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.5"),
        rule_ids=["r1"], risk_score=80.0, verdict=Verdict.TRUE_POSITIVE, confidence=0.9,
        status=CaseStatus.NEEDS_HUMAN, tags=list(tags or []),
    )


@pytest.mark.asyncio
async def test_automation_applies_the_tags_saved_by_the_rule_editor(app_state):
    from app.engine.threshold_automation import ThresholdAutomation

    case = _automation_case("auto-editor")
    await app_state.cases.save(case)
    prefs = _automation_prefs([_automation_rule({"tags": ["auto-triaged", "watchlist"]})])
    await ThresholdAutomation(app_state.proposals, app_state.audit).run(
        case, prefs, save=app_state.cases.save,
    )
    assert case.tags == ["auto-triaged", "watchlist"]
    assert case.automation_actions[-1]["detail"] == "tag=auto-triaged, watchlist"
    reloaded = await app_state.cases.get("auto-editor")
    assert reloaded is not None and reloaded.tags == ["auto-triaged", "watchlist"]


@pytest.mark.asyncio
async def test_automation_never_cuts_or_silently_drops_a_tag(app_state):
    from app.engine.threshold_automation import ThresholdAutomation

    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    # Over the length bound: left off whole, and the record says so.
    case = _automation_case("auto-long")
    await app_state.cases.save(case)
    await automation.run(case, _automation_prefs([_automation_rule({"tags": [LONG, "ok"]})]),
                         save=app_state.cases.save)
    assert case.tags == ["ok"]
    assert not any(t.startswith("Scheduled vendor") for t in case.tags)
    detail = case.automation_actions[-1]["detail"]
    assert f'"{LONG}" is longer than 40 characters' in detail

    # A full case: the tag is not added, and the record says why (no silent [:25]).
    full = _automation_case("auto-full", FULL)
    await app_state.cases.save(full)
    await automation.run(full, _automation_prefs([_automation_rule({"tag": "late"})]),
                         save=app_state.cases.save)
    assert full.tags == FULL
    assert '"late", the case already has 25 tags' in full.automation_actions[-1]["detail"]
