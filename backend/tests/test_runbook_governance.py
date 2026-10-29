"""Runbook governance: states, versions, transitions and their grants (Round 14 SPEC
§4.10.5, §4.10.15, D35, D39; package A7b).

The transitions are pure functions in ``engine.runbook_catalog`` (tested first, on
documents built in memory) and are served by ``api/routes_runbooks.py`` (tested
through the API with the grants of SPEC §3.7: ``runbooks:manage`` writes and
submits, ``runbooks:publish`` publishes, rejects, restores and marks reviewed).
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engine import runbook_catalog as catalog
from app.engine.runbook_catalog import CatalogError
from app.engine.runbook_model import MAX_RUNBOOK_PROMPT_CHARS, builtin_runbook
from app.models import RunbookDefinition
from tests.test_runbook_library_api import (
    ADMIN,
    BASE_BUILTIN,
    add_user,
    audit_rows,
    auth_secrets,
    create,
    definition,
    login,
    make_app,
    publish,
)

NOW = "2026-10-28T12:00:00+00:00"
LATER = "2026-10-29T12:00:00+00:00"


def _defn(runbook_id: str = "gov", **update: Any) -> RunbookDefinition:
    return RunbookDefinition.model_validate(definition(runbook_id, **update))


def _doc(runbook_id: str = "gov", **update: Any) -> Any:
    return catalog.new_operator_runbook(_defn(runbook_id, **update), actor="asha", now=NOW)


def _states(doc: Any) -> list[tuple[int, str]]:
    return [(v.version, v.state) for v in doc.versions]


def _code(exc: pytest.ExceptionInfo[CatalogError]) -> tuple[int, str]:
    return exc.value.status, exc.value.code


# --------------------------------------------------------------------------- #
# Pure transitions.
# --------------------------------------------------------------------------- #
def test_a_new_runbook_is_one_draft_in_canonical_form() -> None:
    doc = _doc(title="  Spaced title  ")
    assert _states(doc) == [(1, "draft")]
    version = doc.versions[0]
    assert version.definition.title == "Spaced title"
    assert version.author == "asha" and version.created_at == NOW
    assert version.source.startswith("---\nid: gov") and "version: 1" in version.source
    assert len(version.content_hash) == 64 and version.prompt_chars > 0
    assert doc.origin == "operator" and doc.created_by == "asha" and doc.review_due_at is None


def test_publishing_a_draft_makes_it_live_and_sets_the_next_review() -> None:
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    assert _states(live) == [(1, "published")]
    version = live.versions[0]
    assert version.published_by == "ravi" and version.published_at == NOW
    assert live.last_reviewed_by == "ravi" and live.last_reviewed_at == NOW
    due = datetime.fromisoformat(live.review_due_at)
    assert due == datetime.fromisoformat(NOW) + timedelta(days=version.definition.review_every_days)


def test_editing_a_published_runbook_creates_the_next_version_as_a_draft() -> None:
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    edited = catalog.t_save_draft(live, _defn(title="Second"), actor="asha", now=LATER)
    assert _states(edited) == [(1, "published"), (2, "draft")]
    again = catalog.t_save_draft(edited, _defn(title="Third"), actor="mo", now=LATER)
    assert _states(again) == [(1, "published"), (2, "draft")]
    assert again.draft.definition.title == "Third" and again.draft.author == "mo"
    second = catalog.t_publish(again, 2, actor="ravi", now=LATER, expected_hash=None,
                               require_distinct_approver=False)
    assert _states(second) == [(1, "superseded"), (2, "published")]
    assert second.versions[0].superseded_at == LATER


def test_editing_a_version_in_review_takes_it_back_to_draft() -> None:
    submitted = catalog.t_submit(_doc(), 1, actor="asha", now=NOW)
    assert _states(submitted) == [(1, "in_review")]
    assert submitted.versions[0].submitted_by == "asha"
    withdrawn = catalog.t_save_draft(submitted, _defn(title="Fixed"), actor="asha", now=LATER)
    assert _states(withdrawn) == [(1, "draft")]


def test_submit_needs_a_valid_draft_and_one_review_at_a_time() -> None:
    with pytest.raises(CatalogError) as invalid:
        catalog.t_submit(_doc(steps=[], phases=[]), 1, actor="asha", now=NOW)
    assert _code(invalid) == (422, "runbook_invalid") and invalid.value.extra["issues"]
    submitted = catalog.t_submit(_doc(), 1, actor="asha", now=NOW)
    with pytest.raises(CatalogError) as twice:
        catalog.t_submit(submitted, 1, actor="asha", now=NOW)
    assert _code(twice) == (409, "runbook_state")
    with pytest.raises(CatalogError) as missing:
        catalog.t_submit(_doc(), 9, actor="asha", now=NOW)
    assert _code(missing) == (404, "runbook_version_not_found")


def test_reject_sends_a_review_back_with_the_reason() -> None:
    submitted = catalog.t_submit(_doc(), 1, actor="asha", now=NOW)
    rejected = catalog.t_reject(submitted, 1, "  Add the lockout step.  ", actor="ravi", now=LATER)
    assert _states(rejected) == [(1, "draft")]
    note = rejected.versions[0].review_notes[0]
    assert (note.by, note.at, note.text) == ("ravi", LATER, "Add the lockout step.")
    with pytest.raises(CatalogError) as not_in_review:
        catalog.t_reject(rejected, 1, "again", actor="ravi", now=LATER)
    assert _code(not_in_review) == (409, "runbook_state")
    # A rejected draft keeps its review note through the next edit.
    edited = catalog.t_save_draft(rejected, _defn(title="With lockout"), actor="asha", now=LATER)
    assert edited.versions[0].review_notes[0].text == "Add the lockout step."


def test_only_a_draft_or_a_version_in_review_can_be_published() -> None:
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    with pytest.raises(CatalogError) as again:
        catalog.t_publish(live, 1, actor="ravi", now=NOW, expected_hash=None, require_distinct_approver=False)
    assert _code(again) == (409, "runbook_state")


def test_publish_is_bound_to_the_reviewed_text() -> None:
    doc = _doc()
    with pytest.raises(CatalogError) as moved:
        catalog.t_publish(doc, 1, actor="ravi", now=NOW, expected_hash="0" * 64,
                          require_distinct_approver=False)
    assert _code(moved) == (409, "runbook_conflict")
    ok = catalog.t_publish(doc, 1, actor="ravi", now=NOW, expected_hash=doc.versions[0].content_hash,
                           require_distinct_approver=False)
    assert ok.live is not None


def _publish_as(doc: Any, number: int, actor: str) -> Any:
    return catalog.t_publish(doc, number, actor=actor, now=LATER, expected_hash=None,
                             require_distinct_approver=True)


def test_a_second_approver_must_differ_from_everyone_who_wrote_the_version() -> None:
    doc = _doc()  # written by asha
    with pytest.raises(CatalogError) as own:
        _publish_as(doc, 1, "asha")
    assert _code(own) == (403, "runbook_distinct_approver")
    with pytest.raises(CatalogError) as anonymous:
        _publish_as(doc, 1, "")
    assert _code(anonymous) == (403, "runbook_distinct_approver")
    assert _publish_as(doc, 1, "ravi").live is not None
    # Off (the default): the author may publish their own draft directly.
    assert catalog.t_publish(doc, 1, actor="asha", now=NOW, expected_hash=None,
                             require_distinct_approver=False).live is not None
    # Ravi changes one word of asha's draft: the text now has two writers, and
    # neither may approve it. Asha cannot launder her own text through ravi's edit
    # (the version's author is now ravi), and ravi cannot approve his own change.
    edited = catalog.t_save_draft(doc, _defn(title="Ravi's edit"), actor="ravi", now=LATER)
    assert edited.draft.author == "ravi"
    assert catalog.version_editors(edited, 1) == ("asha", "ravi")
    for writer in ("asha", "ravi"):
        with pytest.raises(CatalogError) as refused:
            _publish_as(edited, 1, writer)
        assert _code(refused) == (403, "runbook_distinct_approver"), writer
    assert _publish_as(edited, 1, "lee").live.published_by == "lee"
    # The record of writers survives the store's encoding (an additive field).
    stored = type(edited).model_validate(edited.model_dump(mode="json"))
    assert catalog.version_editors(stored, 1) == ("asha", "ravi")


def test_the_writers_of_a_version_follow_it_through_review_and_into_a_new_draft() -> None:
    doc = _doc()
    sent = catalog.t_submit(doc, 1, actor="asha", now=NOW)
    back = catalog.t_reject(sent, 1, "Add the edge block step.", actor="lee", now=NOW)
    # The reviewer who sent it back wrote nothing, so the reviewer may still publish.
    assert catalog.version_editors(back, 1) == ("asha",)
    live = _publish_as(back, 1, "lee")
    # Editing the live runbook opens version 2, written by its editor alone: the
    # text it starts from was approved, so asha may approve ravi's change.
    two = catalog.t_save_draft(live, _defn(title="Two"), actor="ravi", now=LATER)
    assert catalog.version_editors(two, 2) == ("ravi",)
    two_live = _publish_as(two, 2, "asha")
    assert two_live.live.version == 2
    # Restoring an old version as a draft makes the restorer its only writer (the
    # restored text was approved once).
    restored = catalog.t_restore_version(two_live, 1, actor="nia", now=LATER)
    assert catalog.version_editors(restored, 3) == ("nia",)
    # Discarding a draft forgets its writers.
    edited = catalog.t_save_draft(live, _defn(title="Scrap"), actor="ravi", now=LATER)
    kept, _removed = catalog.t_discard_draft(edited, actor="ravi", now=LATER)
    assert "2" not in (kept.model_extra or {}).get(catalog.EDITORS_FIELD, {})


def test_duplicating_unapproved_text_keeps_its_writers() -> None:
    draft_doc = _doc("origin")  # asha's draft, never approved
    plan = catalog.duplicate_plan("origin", draft_doc, {"origin"})
    copy = catalog.new_operator_runbook(plan.definition, actor="ravi", now=NOW, editors=plan.editors)
    # Ravi's copy of asha's draft is still asha's text: neither may approve it.
    assert catalog.version_editors(copy, 1) == ("asha", "ravi")
    with pytest.raises(CatalogError):
        _publish_as(copy, 1, "asha")
    # A copy of approved (live) text, or of a built-in, is written by its copier only.
    live = _publish_as(_doc("approved"), 1, "lee")
    approved = catalog.duplicate_plan("approved", live, {"approved"})
    assert approved.editors == ()
    assert catalog.duplicate_plan(BASE_BUILTIN, None, set()).editors == ()


def test_a_rejection_needs_a_reason() -> None:
    sent = catalog.t_submit(_doc(), 1, actor="asha", now=NOW)
    for blank in ("", "   ", "\n\t"):
        with pytest.raises(CatalogError) as refused:
            catalog.t_reject(sent, 1, blank, actor="lee", now=NOW)
        assert _code(refused) == (422, "runbook_invalid")
        assert refused.value.extra["issues"][0]["path"] == "reason"


def test_an_over_budget_version_cannot_be_published() -> None:
    item = builtin_runbook(BASE_BUILTIN)
    steps = []
    for step in item.definition.steps:
        if step.phase in ("triage", "investigate"):
            update: dict[str, Any] = {"focus": "x" * 299}
            if step.kind in ("check", "decision"):
                update.update(escalate_if="y" * 299, benign_if="z" * 299)
            step = step.model_copy(update=update)
        steps.append(step)
    doc = _doc(steps=steps)
    assert catalog.validate_runbook(doc.versions[0].definition, version=1)[0].code == "prompt_budget"
    with pytest.raises(CatalogError) as over:
        catalog.t_publish(doc, 1, actor="ravi", now=NOW, expected_hash=None, require_distinct_approver=False)
    assert _code(over) == (422, "runbook_prompt_budget")
    assert over.value.extra["length"] > MAX_RUNBOOK_PROMPT_CHARS == over.value.extra["budget"]


def test_retire_and_restore() -> None:
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    retired = catalog.t_retire(live, actor="mo", now=LATER)
    assert _states(retired) == [(1, "retired")] and retired.retired
    assert retired.versions[0].retired_by == "mo"
    with pytest.raises(CatalogError) as twice:
        catalog.t_retire(retired, actor="mo", now=LATER)
    assert _code(twice) == (409, "runbook_state")
    restored = catalog.t_restore(retired, actor="ravi", now=LATER)
    assert _states(restored) == [(1, "published")] and restored.versions[0].retired_by is None
    with pytest.raises(CatalogError) as not_retired:
        catalog.t_restore(restored, actor="ravi", now=LATER)
    assert _code(not_retired) == (409, "runbook_state")


def test_publishing_a_new_version_of_a_retired_runbook_supersedes_the_retired_one() -> None:
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    retired = catalog.t_retire(live, actor="mo", now=NOW)
    edited = catalog.t_save_draft(retired, _defn(title="Back"), actor="asha", now=LATER)
    assert _states(edited) == [(1, "retired"), (2, "draft")]
    back = catalog.t_publish(edited, 2, actor="ravi", now=LATER, expected_hash=None,
                             require_distinct_approver=False)
    assert _states(back) == [(1, "superseded"), (2, "published")] and not back.retired


def test_mark_reviewed_moves_the_due_date_without_a_new_version() -> None:
    live = catalog.t_publish(_doc(review_every_days=30), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    reviewed = catalog.t_reviewed(live, actor="lee", now=LATER)
    assert _states(reviewed) == _states(live)
    assert reviewed.last_reviewed_by == "lee" and reviewed.last_reviewed_at == LATER
    assert datetime.fromisoformat(reviewed.review_due_at) == datetime.fromisoformat(LATER) + timedelta(days=30)
    with pytest.raises(CatalogError) as draft_only:
        catalog.t_reviewed(_doc(), actor="lee", now=LATER)
    assert _code(draft_only) == (409, "runbook_state")


def test_restore_an_old_version_as_a_new_draft() -> None:
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    edited = catalog.t_save_draft(live, _defn(title="Two"), actor="asha", now=NOW)
    two = catalog.t_publish(edited, 2, actor="ravi", now=NOW, expected_hash=None,
                            require_distinct_approver=False)
    restored = catalog.t_restore_version(two, 1, actor="asha", now=LATER)
    assert _states(restored) == [(1, "superseded"), (2, "published"), (3, "draft")]
    assert restored.draft.definition.title == live.live.definition.title
    with pytest.raises(CatalogError) as busy:
        catalog.t_restore_version(restored, 2, actor="asha", now=LATER)
    assert _code(busy) == (409, "runbook_state")
    with pytest.raises(CatalogError) as missing:
        catalog.t_restore_version(two, 7, actor="asha", now=LATER)
    assert _code(missing) == (404, "runbook_version_not_found")


def test_discarding_the_working_version() -> None:
    gone, removed = catalog.t_discard_draft(_doc(), actor="asha", now=NOW)
    assert gone is None and removed.version == 1
    live = catalog.t_publish(_doc(), 1, actor="ravi", now=NOW, expected_hash=None,
                             require_distinct_approver=False)
    edited = catalog.t_save_draft(live, _defn(title="Scrap"), actor="asha", now=NOW)
    kept, removed = catalog.t_discard_draft(edited, actor="asha", now=NOW)
    assert _states(kept) == [(1, "published")] and removed.version == 2
    with pytest.raises(CatalogError) as nothing:
        catalog.t_discard_draft(kept, actor="asha", now=NOW)
    assert _code(nothing) == (409, "runbook_state")


# --------------------------------------------------------------------------- #
# Through the API.
# --------------------------------------------------------------------------- #
@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        yield holder


def test_the_whole_life_of_a_runbook_through_the_api(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "lifecycle")
    submitted = client.post("/api/runbooks/lifecycle/submit", json={"version": 1, "expected_revision": made["revision"]})
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["summary"]["state"] == "in_review" and submitted.json()["in_review"]["version"] == 1
    rejected = client.post("/api/runbooks/lifecycle/reject", json={"version": 1, "reason": "Too short."})
    assert rejected.status_code == 200 and rejected.json()["draft"]["review_notes"][0]["text"] == "Too short."
    live = publish(client, "lifecycle")
    assert live["summary"]["state"] == "published" and live["live"]["version"] == 1
    assert live["summary"]["review_due_at"] and live["summary"]["last_reviewed_at"]
    retired = client.post("/api/runbooks/lifecycle/retire", json={})
    assert retired.status_code == 200 and retired.json()["summary"]["state"] == "retired"
    restored = client.post("/api/runbooks/lifecycle/restore")
    assert restored.status_code == 200 and restored.json()["summary"]["state"] == "published"
    reviewed = client.post("/api/runbooks/lifecycle/reviewed", json={"expected_revision": restored.json()["revision"]})
    assert reviewed.status_code == 200
    as_draft = client.post("/api/runbooks/lifecycle/versions/1/restore")
    assert as_draft.status_code == 200 and as_draft.json()["draft"]["version"] == 2
    history = client.get("/api/runbooks/lifecycle").json()["versions"]
    assert [(v["version"], v["state"]) for v in history] == [(2, "draft"), (1, "published")]
    actions = [row["action"] for row in audit_rows(state)]
    for expected in ("runbook.created", "runbook.submitted", "runbook.rejected", "runbook.published",
                     "runbook.retired", "runbook.restored", "runbook.reviewed"):
        assert expected in actions, expected
    published_row = audit_rows(state, action="runbook.published")[0]
    assert {"field": "version 1 state", "before": "draft", "after": "published"} in [
        {k: c.get(k) for k in ("field", "before", "after")} for c in published_row["changes"]]


def test_publish_requires_the_reviewed_revision_and_refuses_a_stale_one(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "bound")
    assert client.post("/api/runbooks/bound/publish", json={"version": 1}).status_code == 422
    edited = client.put("/api/runbooks/bound/draft", json={
        "definition": definition("bound", title="Changed after review"), "expected_revision": made["revision"],
    }).json()
    rows = len(audit_rows(state))
    stale = client.post("/api/runbooks/bound/publish", json={"version": 1, "expected_revision": made["revision"]})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "runbook_conflict"
    assert stale.json()["detail"]["latest"]["draft"]["definition"]["title"] == "Changed after review"
    other_text = client.post("/api/runbooks/bound/publish", json={
        "version": 1, "expected_revision": edited["revision"], "content_hash": made["draft"]["content_hash"],
    })
    assert other_text.status_code == 409 and other_text.json()["detail"]["code"] == "runbook_conflict"
    # Every conflict carries the latest state, this one too (the text changed after
    # the publisher reviewed it), so the editor's one conflict handler can reload it.
    conflict = other_text.json()["detail"]
    assert conflict["revision"] == edited["revision"] and conflict["latest"]["revision"] == edited["revision"]
    assert conflict["latest"]["draft"]["content_hash"] == edited["draft"]["content_hash"]
    assert len(audit_rows(state)) == rows
    ok = client.post("/api/runbooks/bound/publish", json={
        "version": 1, "expected_revision": edited["revision"], "content_hash": edited["draft"]["content_hash"],
    })
    assert ok.status_code == 200, ok.text


def test_an_invalid_draft_cannot_be_submitted_or_published(box) -> None:
    client = box["client"]
    made = client.post("/api/runbooks", json={"definition": definition("broken", steps=[], phases=[])}).json()
    submit = client.post("/api/runbooks/broken/submit", json={"version": 1})
    assert submit.status_code == 422 and submit.json()["detail"]["code"] == "runbook_invalid"
    pub = client.post("/api/runbooks/broken/publish", json={"version": 1, "expected_revision": made["revision"]})
    assert pub.status_code == 422 and pub.json()["detail"]["issues"]
    assert client.get("/api/runbooks/broken").json()["live"] is None


def test_retiring_stops_matching_and_publishing_a_copy_replaces_the_built_in(box) -> None:
    client, state = box["client"], box["state"]

    def matchable_ids() -> set[str]:
        return {m.id for m in client.portal.call(catalog.matchable, state.runbook_library)}

    assert BASE_BUILTIN in matchable_ids()
    copy_id = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]["id"]
    assert copy_id not in matchable_ids() and BASE_BUILTIN in matchable_ids()
    publish(client, copy_id)
    ids = matchable_ids()
    assert copy_id in ids and BASE_BUILTIN not in ids
    client.post(f"/api/runbooks/{copy_id}/retire")
    ids = matchable_ids()
    assert copy_id not in ids and BASE_BUILTIN in ids


def test_publish_retire_and_restore_ask_retrieval_to_reproject(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]
    calls: list[set[str]] = []

    async def reindex(ids: set[str] | None = None) -> dict[str, Any]:
        calls.append(set(ids or ()))
        return {"ok": True}

    async def project(**_kw: Any) -> bool:
        return True

    monkeypatch.setattr(state.rag, "reindex_runbooks", reindex)
    monkeypatch.setattr(state.rag, "project_runbook_corpus", project, raising=False)
    create(client, "projected")
    publish(client, "projected")
    client.post("/api/runbooks/projected/retire")
    client.post("/api/runbooks/projected/restore")
    deadline = time.monotonic() + 5
    while len(calls) < 3 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert calls == [{"projected"}] * 3


def test_without_the_published_only_projection_no_reindex_is_asked(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]
    calls: list[Any] = []

    async def reindex(ids: set[str] | None = None) -> dict[str, Any]:
        calls.append(ids)
        return {"ok": True}

    monkeypatch.setattr(state.rag, "reindex_runbooks", reindex)
    if hasattr(state.rag, "project_runbook_corpus"):
        monkeypatch.delattr(type(state.rag), "project_runbook_corpus", raising=False)
        monkeypatch.delattr(state.rag, "project_runbook_corpus", raising=False)
    create(client, "legacy-safe")
    publish(client, "legacy-safe")
    time.sleep(0.2)
    assert calls == []


def test_a_copy_that_replaces_a_built_in_reprojects_the_built_in_too(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]
    calls: list[set[str]] = []

    async def reindex(ids: set[str] | None = None) -> dict[str, Any]:
        calls.append(set(ids or ()))
        return {"ok": True}

    async def project(**_kw: Any) -> bool:
        return True

    monkeypatch.setattr(state.rag, "reindex_runbooks", reindex)
    monkeypatch.setattr(state.rag, "project_runbook_corpus", project, raising=False)
    copy_id = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]["id"]
    publish(client, copy_id)
    client.post(f"/api/runbooks/{copy_id}/retire")
    deadline = time.monotonic() + 5
    while len(calls) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert calls == [{copy_id, BASE_BUILTIN}] * 2


def test_a_blank_rejection_reason_is_refused_before_any_row(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "needs-why")
    sent = client.post("/api/runbooks/needs-why/submit", json={"version": 1, "expected_revision": made["revision"]})
    assert sent.status_code == 200
    rows = len(audit_rows(state))
    # Whitespace, empty, missing or not text: one error contract (the package's own
    # 422 runbook_invalid on the path "reason"), never the framework's generic list.
    for body in ({"version": 1, "reason": "   "}, {"version": 1, "reason": ""}, {"version": 1},
                 {"version": 1, "reason": None}, {"version": 1, "reason": 7}):
        blank = client.post("/api/runbooks/needs-why/reject", json=body)
        assert blank.status_code == 422, body
        detail = blank.json()["detail"]
        assert detail["code"] == "runbook_invalid", body
        assert [(i["path"], i["code"]) for i in detail["issues"]] == [("reason", "required")], body
    too_long = client.post("/api/runbooks/needs-why/reject", json={"version": 1, "reason": "x" * 501})
    assert too_long.status_code == 422 and too_long.json()["detail"]["code"] == "runbook_invalid"
    assert [(i["path"], i["code"]) for i in too_long.json()["detail"]["issues"]] == [("reason", "too_long")]
    assert len(audit_rows(state)) == rows
    assert client.get("/api/runbooks/needs-why").json()["in_review"]["version"] == 1
    # The longest reason allowed is accepted.
    longest = client.post("/api/runbooks/needs-why/reject", json={"version": 1, "reason": "y" * 500})
    assert longest.status_code == 200, longest.text


def test_the_publish_row_names_the_hash_of_the_text_made_trusted(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "hashed")
    stored = made["draft"]["content_hash"]
    # The publisher sends no hash (it is optional): the row still names the text.
    live = client.post("/api/runbooks/hashed/publish", json={"version": 1, "expected_revision": made["revision"]})
    assert live.status_code == 200, live.text
    row = audit_rows(state, action="runbook.published")[-1]
    assert row["tool_input"]["content_hash"] == stored == live.json()["live"]["content_hash"]
    assert row["tool_input"]["reviewed_hash"] is None
    assert {"field": "live content_hash", "before": None, "after": stored} in [
        {k: c.get(k) for k in ("field", "before", "after")} for c in row["changes"]]


def test_restoring_an_old_version_is_audited_as_a_draft_not_as_a_restore(box) -> None:
    client, state = box["client"], box["state"]
    create(client, "rewind")
    publish(client, "rewind")
    detail = client.get("/api/runbooks/rewind").json()
    client.put("/api/runbooks/rewind/draft", json={
        "definition": definition("rewind", summary="Second text."), "expected_revision": detail["revision"]})
    publish(client, "rewind")
    restored = client.post("/api/runbooks/rewind/versions/1/restore")
    assert restored.status_code == 200 and restored.json()["draft"]["version"] == 3
    # ``runbook.restored`` means a retired runbook went live again; a restored draft
    # trusts nothing, so it reads as a draft change and names where it came from.
    assert audit_rows(state, action="runbook.restored") == []
    row = audit_rows(state, action="runbook.draft_updated")[-1]
    assert row["tool_input"]["from_version"] == 1 and row["tool_input"]["version"] == 3
    assert row["tool_input"]["content_hash"] == restored.json()["draft"]["content_hash"]
    assert row["target"]["revision"] == restored.json()["revision"]
    fields = {c["field"]: c for c in row["changes"]}
    assert fields["restored_from"]["after"] == "version 1"
    assert fields["version 3 state"]["after"] == "draft"


# --------------------------------------------------------------------------- #
# Grants: manage writes and submits, publish publishes (SPEC §3.7, §4.10.5).
# --------------------------------------------------------------------------- #
@pytest.fixture
def split_box() -> Any:
    """``writer`` (a SOC manager without publish) and ``approver`` (a tier 2 analyst
    granted publish)."""
    holder: dict[str, Any] = {}
    rbac = {
        "denies": {"soc_manager": {"runbooks": ["publish"]}},
        "resources": {"analyst_tier2": {"runbooks": ["read", "run", "publish"]}},
    }
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True, rbac=rbac)) as client:
        holder["client"] = client
        add_user(client, "writer", "soc_manager")
        add_user(client, "approver", "analyst_tier2")
        add_user(client, "tier1", "analyst_tier1")
        yield holder


def test_manage_writes_and_submits_and_publish_approves(split_box) -> None:
    client = split_box["client"]
    login(client, "writer", "user-pass-12345")
    made = create(client, "split")
    assert client.post("/api/runbooks/split/publish", json={"version": 1, "expected_revision": made["revision"]}).status_code == 403
    submitted = client.post("/api/runbooks/split/submit", json={"version": 1})
    assert submitted.status_code == 200
    assert client.post("/api/runbooks/split/reject", json={"version": 1, "reason": "no"}).status_code == 403
    # The grant comes first: a caller without publish learns nothing about the body.
    assert client.post("/api/runbooks/split/reject", json={"version": 1, "reason": ""}).status_code == 403

    login(client, "approver", "user-pass-12345")
    # A publisher sees what it approves.
    detail = client.get("/api/runbooks/split").json()
    assert detail["in_review"]["version"] == 1
    assert client.post("/api/runbooks", json={"definition": definition("nope")}).status_code == 403
    assert client.post("/api/runbooks/split/submit", json={"version": 1}).status_code == 403
    live = client.post("/api/runbooks/split/publish", json={
        "version": 1, "expected_revision": detail["revision"], "content_hash": detail["in_review"]["content_hash"],
    })
    assert live.status_code == 200, live.text
    assert client.post("/api/runbooks/split/retire").status_code == 403
    assert client.post("/api/runbooks/split/reviewed").status_code == 200

    login(client, "writer", "user-pass-12345")
    assert client.post("/api/runbooks/split/retire").status_code == 200
    assert client.post("/api/runbooks/split/restore").status_code == 403
    login(client, "approver", "user-pass-12345")
    assert client.post("/api/runbooks/split/restore").status_code == 200

    login(client, "tier1", "user-pass-12345")
    for path in ("submit", "publish", "reject", "retire", "restore", "reviewed"):
        assert client.post(f"/api/runbooks/split/{path}", json={"version": 1, "expected_revision": 0,
                                                               "reason": "x"}).status_code == 403, path


@pytest.fixture
def distinct_box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True)) as client:
        holder["client"] = client
        add_user(client, "manager", "soc_manager")
        add_user(client, "lead", "soc_manager")
        state = holder["state"]

        async def turn_on() -> None:
            prefs = state.prefs
            await state.update_prefs(prefs.model_copy(update={
                "runbooks": prefs.runbooks.model_copy(update={"require_distinct_approver": True}),
            }))

        client.portal.call(turn_on)
        yield holder


def test_with_a_second_approver_the_author_cannot_publish(distinct_box) -> None:
    client = distinct_box["client"]
    login(client, "manager", "user-pass-12345")
    made = create(client, "four-eyes")
    own = client.post("/api/runbooks/four-eyes/publish", json={
        "version": 1, "expected_revision": made["revision"], "content_hash": made["draft"]["content_hash"],
    })
    assert own.status_code == 403 and own.json()["detail"]["code"] == "runbook_distinct_approver"
    login(client, *ADMIN)
    other = client.post("/api/runbooks/four-eyes/publish", json={
        "version": 1, "expected_revision": made["revision"], "content_hash": made["draft"]["content_hash"],
    })
    assert other.status_code == 200, other.text
    assert other.json()["live"]["published_by"] == "Admin" and other.json()["live"]["author"] == "manager"


def test_with_a_second_approver_an_edit_by_another_writer_binds_both(distinct_box) -> None:
    client, state = distinct_box["client"], distinct_box["state"]
    login(client, "manager", "user-pass-12345")
    create(client, "sod")
    # Admin, who also holds publish, fixes one word of manager's draft.
    login(client, *ADMIN)
    detail = client.get("/api/runbooks/sod").json()
    edited = client.put("/api/runbooks/sod/draft", json={
        "definition": definition("sod", summary="Fixed a typo."), "expected_revision": detail["revision"]})
    assert edited.status_code == 200, edited.text
    body = {"version": 1, "expected_revision": edited.json()["revision"],
            "content_hash": edited.json()["draft"]["content_hash"]}
    rows = len(audit_rows(state))
    for writer in ("manager", ADMIN[0]):
        login(client, writer, "user-pass-12345" if writer == "manager" else ADMIN[1])
        refused = client.post("/api/runbooks/sod/publish", json=body)
        assert refused.status_code == 403, (writer, refused.text)
        assert refused.json()["detail"]["code"] == "runbook_distinct_approver"
    assert len(audit_rows(state)) == rows  # a refusal is a pre-check: no row
    login(client, "lead", "user-pass-12345")
    live = client.post("/api/runbooks/sod/publish", json=body)
    assert live.status_code == 200, live.text
    assert live.json()["live"]["published_by"] == "lead"


def test_the_review_due_date_follows_the_published_cadence(box) -> None:
    client = box["client"]
    create(client, "cadence", review_every_days=45)
    live = publish(client, "cadence")
    due = datetime.fromisoformat(live["summary"]["review_due_at"])
    expected = datetime.now(UTC) + timedelta(days=45)
    assert abs((due - expected).total_seconds()) < 120
