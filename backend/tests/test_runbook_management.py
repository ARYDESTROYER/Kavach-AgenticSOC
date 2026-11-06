"""Runbook management: the one-release compatibility contract of the library API
(Round 14 SPEC §4.10.16, D44, E14; package A7b, rewritten from the pre-Round-14 suite).

Before Round 14 this suite pinned the plain-text reference-runbook catalog
(``engine/runbooks.py``, ``engine/runbook_service.py``): its authoring standard, its
revisioned create/update/delete routes and its RAG projection. Those modules are
retired (SPEC §4.10.16) and each of those contracts now lives with its replacement:

* the authoring rules, the Markdown format and the bundled library are
  ``test_runbook_model.py`` and ``test_runbook_library.py`` (A3);
* creating, editing, versions, governance and the library list are
  ``test_runbook_library_api.py`` and ``test_runbook_governance.py`` (A7b);
* the Published-only retrieval projection is the RAG suite's (A8b).

What this suite still pins is what an OLD client sees for one release:

* ``GET /api/runbooks?shape=v1`` and ``GET /api/runbooks/{id}?shape=v1`` answer the
  old runbook shape from the new library, Published text only, with ``Deprecation``
  and ``Link`` headers;
* every old-shape WRITE (``{id, content}`` on ``POST /api/runbooks``, ``PUT`` or
  ``DELETE /api/runbooks/{id}``) answers ``410 runbooks_moved``, because honouring it
  would make unreviewed text trusted (#9), and it changes nothing;
* the reindex routes are kept as they were (``POST /api/runbooks/reindex`` is the
  deprecated full reconciliation; ``POST /api/runbooks/{id}/reindex`` stays).

None of this invokes the deterministic case decision engine (#3).
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engine.runbook_model import BUILTIN_RUNBOOK_IDS, builtin_runbook
from tests.test_runbook_library_api import (
    ADMIN,
    BASE_BUILTIN,
    add_user,
    audit_rows,
    auth_secrets,
    create,
    definition,
    kv_snapshot,
    login,
    make_app,
    publish,
    source,
)

V1_ITEM_KEYS = {
    "id", "title", "summary", "persona", "applies_to_rules", "applies_to_techniques",
    "applies_to_entities", "keywords", "body_characters", "source_type", "protected", "editable",
    "file_name", "revision", "created_at", "updated_at", "created_by", "updated_by", "index_status",
    "indexed_revision", "last_indexed_at", "index_error",
}


@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        yield holder


def _deprecated(response: Any) -> None:
    assert response.headers["deprecation"] == "true"
    assert response.headers["link"] == '</api/runbooks>; rel="successor-version"'


# --------------------------------------------------------------------------- #
# Read aliases.
# --------------------------------------------------------------------------- #
def test_the_old_list_shape_lists_published_runbooks_only(box) -> None:
    client = box["client"]
    create(client, "team-live")
    publish(client, "team-live")
    create(client, "team-draft")
    response = client.get("/api/runbooks", params={"shape": "v1"})
    assert response.status_code == 200
    _deprecated(response)
    body = response.json()
    assert set(body) == {"enabled", "retrieval_enabled", "count", "runbooks"}
    assert body["enabled"] is True and isinstance(body["retrieval_enabled"], bool)
    ids = [item["id"] for item in body["runbooks"]]
    assert set(ids) == set(BUILTIN_RUNBOOK_IDS) | {"team-live"} and body["count"] == len(ids)
    assert "team-draft" not in ids
    for item in body["runbooks"]:
        assert set(item) == V1_ITEM_KEYS
        assert item["editable"] is False  # old-shape writes answer 410
        assert "content" not in item and "body" not in item
    by_id = {item["id"]: item for item in body["runbooks"]}
    bundled = by_id[BASE_BUILTIN]
    item = builtin_runbook(BASE_BUILTIN)
    assert bundled["source_type"] == "bundled" and bundled["protected"] is True
    assert bundled["file_name"] == item.file_name and bundled["revision"] == item.version
    assert bundled["applies_to_rules"] == list(item.definition.applies_when.rule_ids)
    assert "T1110" in bundled["applies_to_techniques"]
    operator = by_id["team-live"]
    assert operator["source_type"] == "operator" and operator["protected"] is False
    # The old shape's types hold for the old clients the alias exists for: a file name
    # (an operator runbook's was ``<id>.md``), never null.
    assert operator["revision"] == 1 and operator["file_name"] == "team-live.md"


def _old_types(item: dict[str, Any]) -> None:
    """The old item's field types (``ManagedRunbook.payload`` before Round 14): the
    index revision is an integer (0 when unindexed) and every time is a string ("" when
    never), never null."""
    assert isinstance(item["indexed_revision"], int) and not isinstance(item["indexed_revision"], bool)
    assert item["last_indexed_at"] == "" and item["index_error"] == ""
    for key in ("id", "title", "summary", "persona", "source_type", "file_name", "created_at",
                "updated_at", "created_by", "updated_by", "index_status"):
        assert isinstance(item[key], str), key
    assert isinstance(item["revision"], int) and isinstance(item["body_characters"], int)
    for key in ("applies_to_rules", "applies_to_techniques", "applies_to_entities", "keywords"):
        assert isinstance(item[key], list), key


def test_the_old_shape_keeps_the_old_field_types(box) -> None:
    client = box["client"]
    create(client, "typed")
    publish(client, "typed")
    # A publish reprojects the runbook into the knowledge index (SPEC §4.10.18) in the
    # background; wait for that projection deterministically before reading.
    state = box["state"]
    projected = client.portal.call(state.rag.reindex_runbooks, {"typed"})
    assert projected["ok"] is True
    listed = {i["id"]: i for i in client.get("/api/runbooks", params={"shape": "v1"}).json()["runbooks"]}
    for item in listed.values():
        _old_types(item)
    # Projected: "ready" at the Published revision, the old integer type, never null.
    assert (listed["typed"]["index_status"], listed["typed"]["indexed_revision"]) == ("ready", 1)
    detail = client.get("/api/runbooks/typed", params={"shape": "v1"}).json()
    _old_types(detail)
    assert detail["indexed_revision"] == 1 and detail["file_name"] == "typed.md"


@pytest.fixture
def auth_box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True)) as client:
        holder["client"] = client
        add_user(client, "tier1", "analyst_tier1")
        add_user(client, "manager", "soc_manager")
        yield holder


def test_the_old_shape_never_shows_who_touched_a_hidden_draft_or_when(auth_box) -> None:
    """The alias serves Published text to any ``runbooks:read`` holder, so its
    ``updated_at`` and ``updated_by`` describe the published record, as the new shape
    does for a reader: a save, a submit or a discard of a hidden version is draft
    activity, visible only to holders of ``manage`` or ``publish`` (SPEC §4.10.15)."""
    client = auth_box["client"]
    login(client, "manager", "user-pass-12345")
    create(client, "quiet-v1")
    live = publish(client, "quiet-v1")
    published_at = live["live"]["published_at"]
    assert live["summary"]["last_reviewed_at"] == published_at

    def reader_view() -> tuple[tuple[Any, Any], tuple[Any, Any]]:
        login(client, "tier1", "user-pass-12345")
        listed = {i["id"]: i for i in client.get("/api/runbooks", params={"shape": "v1"}).json()["runbooks"]}
        # A built-in has no stored record: the old empty strings, never null.
        assert (listed[BASE_BUILTIN]["updated_at"], listed[BASE_BUILTIN]["updated_by"]) == ("", "")
        detail = client.get("/api/runbooks/quiet-v1", params={"shape": "v1"}).json()
        item = listed["quiet-v1"]
        return (item["updated_at"], item["updated_by"]), (detail["updated_at"], detail["updated_by"])

    before = reader_view()
    # Publishing records its publisher as the reviewer: the last public change.
    assert before == ((published_at, "manager"), (published_at, "manager"))
    login(client, *ADMIN)
    saved = client.put("/api/runbooks/quiet-v1/draft", json={
        "definition": definition("quiet-v1", title="Unreviewed wording"), "expected_revision": live["revision"],
    })
    assert saved.status_code == 200, saved.text
    # The writer sees the draft work in the new shape; the alias does not move.
    assert saved.json()["summary"]["updated_by"] == "Admin"
    assert reader_view() == before
    login(client, *ADMIN)
    detail = client.get("/api/runbooks/quiet-v1").json()
    sent = client.post("/api/runbooks/quiet-v1/submit", json={"version": 2, "expected_revision": detail["revision"]})
    assert sent.status_code == 200, sent.text
    assert reader_view() == before
    login(client, *ADMIN)
    assert client.delete("/api/runbooks/quiet-v1/draft").status_code == 200
    assert reader_view() == before
    # The alias reads the same for a holder of manage: it lists Published text only.
    login(client, "manager", "user-pass-12345")
    as_manager = client.get("/api/runbooks/quiet-v1", params={"shape": "v1"}).json()
    assert (as_manager["updated_at"], as_manager["updated_by"]) == (published_at, "manager")
    # A public change (Mark reviewed) is seen, with who did it.
    reviewed = client.post("/api/runbooks/quiet-v1/reviewed")
    assert reviewed.status_code == 200, reviewed.text
    stamp = reviewed.json()["summary"]["last_reviewed_at"]
    assert stamp > published_at
    assert reader_view() == ((stamp, "manager"), (stamp, "manager"))


def test_the_old_shape_index_status_per_projection() -> None:
    """Retrieval on: not yet projected is "pending" with revision 0 (the old unindexed
    value); projected at the live version is "ready"; at another one, "stale"."""
    from app.engine import runbook_catalog as catalog

    item = builtin_runbook(BASE_BUILTIN)
    version = catalog.builtin_version_doc(item)

    def shaped(projection: dict[str, int], enabled: bool = True) -> dict[str, Any]:
        out = catalog.v1_item(runbook_id=BASE_BUILTIN, version=version, builtin=item, doc=None,
                              enabled=enabled, projection=projection, include_content=False)
        _old_types(out)
        return out

    assert (shaped({})["index_status"], shaped({})["indexed_revision"]) == ("pending", 0)
    ready = shaped({BASE_BUILTIN: item.version})
    assert (ready["index_status"], ready["indexed_revision"]) == ("ready", item.version)
    stale = shaped({BASE_BUILTIN: item.version + 2})
    assert (stale["index_status"], stale["indexed_revision"]) == ("stale", item.version + 2)
    off = shaped({BASE_BUILTIN: item.version}, enabled=False)
    assert (off["index_status"], off["indexed_revision"]) == ("disabled", 0)


def test_the_old_detail_shape_carries_the_markdown(box) -> None:
    client = box["client"]
    response = client.get(f"/api/runbooks/{BASE_BUILTIN}", params={"shape": "v1"})
    assert response.status_code == 200
    _deprecated(response)
    body = response.json()
    assert set(body) == V1_ITEM_KEYS | {"content", "body"}
    assert body["content"].startswith("---\n") and f"id: {BASE_BUILTIN}" in body["content"]
    assert not body["body"].startswith("---") and body["body_characters"] == len(body["body"])
    create(client, "not-yet")
    hidden = client.get("/api/runbooks/not-yet", params={"shape": "v1"})
    assert hidden.status_code == 404 and hidden.json()["detail"]["code"] == "runbook_not_found"
    assert client.get("/api/runbooks/nope", params={"shape": "v1"}).status_code == 404


def test_without_shape_the_new_shape_answers_and_is_not_deprecated(box) -> None:
    response = box["client"].get("/api/runbooks")
    assert "deprecation" not in response.headers
    # Round 14 FX3b2: the list also maps each migrated legacy procedure to its runbook.
    assert set(response.json()) == {"runbooks", "migration", "migrated_procedures"}
    assert box["client"].get("/api/runbooks", params={"shape": "v2"}).status_code == 422


# --------------------------------------------------------------------------- #
# Old-shape writes answer 410.
# --------------------------------------------------------------------------- #
def _moved(response: Any) -> None:
    assert response.status_code == 410
    assert response.json() == {"detail": "Playbooks are now runbooks.", "code": "runbooks_moved",
                               "see": "/api/runbooks"}
    _deprecated(response)


def test_every_old_shape_write_answers_410_and_changes_nothing(box) -> None:
    client, state = box["client"], box["state"]
    create(client, "existing")
    before = kv_snapshot(state)
    rows = len(audit_rows(state))
    _moved(client.post("/api/runbooks", json={"id": "legacy_doc", "content": source("legacy_doc")}))
    _moved(client.post("/api/runbooks", json={"id": "legacy_doc", "content": ""}))
    _moved(client.put("/api/runbooks/existing", json={"content": "x", "expected_revision": 1}))
    _moved(client.put("/api/runbooks/existing", json={}))
    _moved(client.delete("/api/runbooks/existing", params={"expected_revision": 1}))
    _moved(client.post("/api/runbooks/validate", json={"content": "x"}))
    _moved(client.post("/api/runbooks/import", json={"content": "x"}))
    assert kv_snapshot(state) == before
    assert len(audit_rows(state)) == rows
    assert client.get("/api/runbooks/existing").status_code == 200


def test_an_old_shape_body_answers_410_whatever_else_it_carries(box) -> None:
    """The old client learns that the route moved, never that its fields are wrong:
    the raw body is read before the new model validates it (E14)."""
    client, state = box["client"], box["state"]
    before = kv_snapshot(state)
    rows = len(audit_rows(state))
    for body in (
        {"id": "x" * 80, "content": "an id the new model refuses"},
        {"id": "legacy_doc", "content": {"not": "text"}},
        {"id": "legacy_doc", "content": "x", "expected_revision": 1, "title": "an unknown key"},
        {"content": None},
    ):
        _moved(client.post("/api/runbooks", json=body))
        _moved(client.post("/api/runbooks/import", json=body))
        _moved(client.post("/api/runbooks/validate", json=body))
    assert kv_snapshot(state) == before and len(audit_rows(state)) == rows
    # A body without the old key is validated as the new shape (422 for a bad one).
    assert client.post("/api/runbooks", json={"id": "x" * 80}).status_code == 422


def test_the_old_shape_answer_comes_after_the_grant_check() -> None:
    from tests.test_runbook_library_api import add_user, auth_secrets, login

    holder: dict[str, Any] = {}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True)) as client:
        add_user(client, "tier1", "analyst_tier1")
        client.post("/api/auth/logout")
        legacy = {"id": "legacy_doc", "content": "x"}
        assert client.post("/api/runbooks", json=legacy).status_code == 401
        login(client, "tier1", "user-pass-12345")
        # A reader without runbooks:manage is refused for what it is not allowed to do.
        assert client.post("/api/runbooks", json=legacy).status_code == 403
        assert client.post("/api/runbooks/import", json=legacy).status_code == 403
        assert client.post("/api/runbooks/validate", json=legacy).status_code == 410


def test_the_new_create_shape_is_not_mistaken_for_the_old_one(box) -> None:
    client = box["client"]
    new = client.post("/api/runbooks", json={"definition": definition("new-shape")})
    assert new.status_code == 201
    from_source = client.post("/api/runbooks", json={"source": source("new-source")})
    assert from_source.status_code == 201


# --------------------------------------------------------------------------- #
# Reindex routes, kept.
# --------------------------------------------------------------------------- #
def test_the_reindex_routes_are_kept(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]
    calls: list[Any] = []

    async def reindex(ids: set[str] | None = None) -> dict[str, Any]:
        calls.append(ids)
        return {"ok": True, "indexed": 3, "deleted": 0, "failed": 0, "errors": []}

    monkeypatch.setattr(state.rag, "reindex_runbooks", reindex)
    create(client, "to-index")
    full = client.post("/api/runbooks/reindex")
    assert full.status_code == 200 and full.json()["indexed"] == 3
    one = client.post("/api/runbooks/to-index/reindex")
    assert one.status_code == 200
    built_in = client.post(f"/api/runbooks/{BASE_BUILTIN}/reindex")
    assert built_in.status_code == 200
    assert client.post("/api/runbooks/missing/reindex").status_code == 404
    assert calls == [None, {"to-index"}, {BASE_BUILTIN}]
    rows = [
        doc for bucket in state.es.docs.values() for doc in bucket.values()
        if isinstance(doc, dict) and doc.get("action_type") == "runbook"
        and "reindexed" in str(doc.get("result_summary") or "")
    ]
    assert len(rows) == 3 and all(r["surface"] == "runbooks" for r in rows)
    # The kept rows carry the structured fields of every new row (SPEC §4.5.3).
    assert {r["action"] for r in rows} == {"runbook.reindexed"}
    assert {r["outcome"] for r in rows} == {"success"} and {r["actor_type"] for r in rows} == {"human"}
    assert sorted(r["target"]["id"] for r in rows) == sorted(["all", "to-index", BASE_BUILTIN])


def test_a_full_reindex_keeps_every_unrelated_knowledge_document() -> None:
    """The real full reconciliation (no stub): ``POST /api/runbooks/reindex`` rebuilds
    the runbook projection and never touches another corpus document, such as one an
    operator imported. Pinned before the retrieval projection is rewritten (A8b),
    where a regression would delete operator-imported knowledge."""
    from app.api.routes_rag import router as rag_router

    holder: dict[str, Any] = {}
    api = make_app(holder)
    api.include_router(rag_router)
    with TestClient(api) as client:
        state = holder["state"]

        async def retrieval_on() -> None:
            prefs = state.prefs
            await state.update_prefs(prefs.model_copy(update={"rag": prefs.rag.model_copy(update={"enabled": True})}))

        client.portal.call(retrieval_on)
        imported = client.post("/api/rag/import", json={
            "title": "Operator network note",
            "text": "A separately imported corpus document that must survive runbook reconciliation.",
            "tags": ["qa"],
        })
        assert imported.status_code == 200, imported.text
        document_id = imported.json()["document_id"]
        create(client, "net-triage")
        publish(client, "net-triage")
        reindex = client.post("/api/runbooks/reindex")
        assert reindex.status_code == 200, reindex.text
        result = reindex.json()
        assert result["failed"] == 0 and result["indexed"] >= 1
        kept = client.get(f"/api/rag/documents/{document_id}")
        assert kept.status_code == 200, kept.text
        assert kept.json()["title"] == "Operator network note"
        # Run twice: the reconciliation is idempotent for the unrelated document too.
        assert client.post("/api/runbooks/reindex").json()["failed"] == 0
        assert client.get(f"/api/rag/documents/{document_id}").status_code == 200


def test_the_full_reindex_route_is_marked_deprecated(box) -> None:
    from app.api.routes_runbooks import router

    deprecated = {
        (getattr(r, "path", ""), next(iter(getattr(r, "methods", {"?"}))))
        for r in router.routes if getattr(r, "deprecated", False)
    }
    assert ("/api/runbooks/reindex", "POST") in deprecated
    assert ("/api/runbooks/{runbook_id}", "PUT") in deprecated
    assert ("/api/runbooks/{runbook_id}", "DELETE") in deprecated
    assert ("/api/runbooks/{runbook_id}/reindex", "POST") not in deprecated
