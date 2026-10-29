"""The runbook library API (Round 14 SPEC §4.10.5, §4.10.12, §4.10.13, §4.10.15,
§4.10.16; package A7b).

Covers the library list and its filters, the detail and version reads and their
visibility rule, create, the draft save, discard, duplicate, import, validate and
export, route order and reserved ids, Demo Mode, the audit-before-visible order of
every write (SPEC §3.6) and the grants. Governance transitions are in
``test_runbook_governance.py``, the match preview in ``test_runbook_match_preview.py``,
the metrics in ``test_runbook_metrics.py`` and the one-release compatibility shapes
in ``test_runbook_management.py``. Every test runs offline on the in-memory store.

This module also holds the small harness the other A7b test modules import.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_runbooks import router as runbooks_router
from app.config import Secrets
from app.constants import EntityType, SourceSurface
from app.engine.runbook_model import (
    BUILTIN_RUNBOOK_IDS,
    builtin_runbook,
    export_runbook_markdown,
    load_builtin_runbooks,
)
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, RunbookDefinition, RunbookDetail, RunbookLibrary, RunbookVersionDoc
from app.state import AppState
from app.stores.runbook_library import RunbookStoreUnavailable

BASE_BUILTIN = "brute-force-password-spray"
ADMIN = ("Admin", "Admin@123")


# --------------------------------------------------------------------------- #
# Harness (imported by the other A7b test modules).
# --------------------------------------------------------------------------- #
def make_secrets(**overrides: Any) -> Secrets:
    base: dict[str, Any] = dict(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None, openai_api_key=None,
    )
    base.update(overrides)
    return Secrets(**base)


def make_app(box: dict[str, Any], *, secrets: Secrets | None = None, auth: bool = False,
             rbac: dict[str, Any] | None = None, prefs_update: dict[str, Any] | None = None) -> FastAPI:
    """A focused app with the monolith (sign-in, users) and the runbooks router. With
    ``auth`` the RBAC matrix is on, and ``rbac`` is merged into ``prefs.rbac``."""
    mock = MockProvider()
    box["mock"] = mock
    secrets = secrets or make_secrets()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True, **(prefs_update or {})})
        if auth:
            prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True, **(rbac or {})})})
        await state.update_prefs(prefs)
        api.state.tlsoc = state
        box["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else []
    api.include_router(monolith_router, dependencies=deps)
    api.include_router(runbooks_router, dependencies=deps)
    return api


def auth_secrets() -> Secrets:
    return make_secrets(auth_enabled=True, auth_jwt_secret="runbook-library-secret", auth_seed_admin=True)


def login(client: TestClient, username: str, password: str) -> None:
    client.post("/api/auth/logout")
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def add_user(client: TestClient, username: str, role: str, password: str = "user-pass-12345") -> None:
    login(client, *ADMIN)
    response = client.post("/api/users", json={"username": username, "password": password, "role": role})
    assert response.status_code == 200, response.text
    client.post("/api/auth/logout")


def _definition_model(runbook_id: str, base: str, update: dict[str, Any]) -> RunbookDefinition:
    item = builtin_runbook(base)
    assert item is not None
    data = item.definition.model_dump(mode="json")
    for key, value in update.items():
        data[key] = value.model_dump(mode="json") if hasattr(value, "model_dump") else (
            [v.model_dump(mode="json") if hasattr(v, "model_dump") else v for v in value]
            if isinstance(value, list) else value)
    data["id"] = runbook_id
    return RunbookDefinition.model_validate(data)


def definition(runbook_id: str, *, base: str = BASE_BUILTIN, **update: Any) -> dict[str, Any]:
    """A definition (a built-in's, under another id, with ``update`` applied) as JSON."""
    return _definition_model(runbook_id, base, update).model_dump(mode="json")


def source(runbook_id: str, *, base: str = BASE_BUILTIN, version: int | None = 1, **update: Any) -> str:
    return export_runbook_markdown(_definition_model(runbook_id, base, update), version=version)


def create(client: TestClient, runbook_id: str, **update: Any) -> dict[str, Any]:
    response = client.post("/api/runbooks", json={"definition": definition(runbook_id, **update)})
    assert response.status_code == 201, response.text
    return response.json()


def publish(client: TestClient, runbook_id: str) -> dict[str, Any]:
    detail = client.get(f"/api/runbooks/{runbook_id}").json()
    working = detail["draft"] or detail["in_review"]
    response = client.post(f"/api/runbooks/{runbook_id}/publish", json={
        "version": working["version"], "expected_revision": detail["revision"],
        "content_hash": working["content_hash"],
    })
    assert response.status_code == 200, response.text
    return response.json()


def audit_rows(state: AppState, *, action: str | None = None, prefix: str = "runbook") -> list[dict[str, Any]]:
    """Every runbook audit row in the in-memory store (control audit), oldest first."""
    rows = [
        doc for bucket in state.es.docs.values() for doc in bucket.values()
        if isinstance(doc, dict) and doc.get("action_type") == "runbook"
        and isinstance(doc.get("action"), str) and doc["action"].startswith(prefix)
    ]
    if action is not None:
        rows = [r for r in rows if r.get("action") == action]
    return sorted(rows, key=lambda r: str(r.get("ts") or ""))


def kv_snapshot(state: AppState) -> dict[str, Any]:
    """Every document the in-memory store holds (a before/after equality check)."""
    import copy

    return copy.deepcopy({index: dict(bucket) for index, bucket in state.es.docs.items()})


def make_case(cid: str, *, hours_ago: float = 2.0, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "case_number": f"CASE-{cid[-4:].zfill(6)}",
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.AUTOMATED_SCAN,
        "entity": Entity(type=EntityType.IP, value="198.51.100.23"),
        "created_at": (datetime.now(UTC) - timedelta(hours=hours_ago)).isoformat(),
        "title": f"Case {cid}",
    }
    base.update(kw)
    return Case(**base)


def seed_cases(client: TestClient, state: AppState, cases: list[Case]) -> None:
    async def run() -> None:
        for case in cases:
            await state.cases.save(case)

    client.portal.call(run)


@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        yield holder


# --------------------------------------------------------------------------- #
# The library list.
# --------------------------------------------------------------------------- #
def test_the_library_lists_the_twelve_built_ins_and_is_never_empty(box) -> None:
    body = box["client"].get("/api/runbooks").json()
    RunbookLibrary.model_validate(body)
    ids = {row["id"] for row in body["runbooks"]}
    assert ids == set(BUILTIN_RUNBOOK_IDS)
    for row in body["runbooks"]:
        item = builtin_runbook(row["id"])
        assert row["origin"] == "builtin" and row["state"] == "published"
        assert row["live_version"] == item.version
        assert row["step_count"] == len(item.definition.steps)
        assert row["runs_30d"] == 0  # auth off: every grant, so the column is a number
    titles = [row["title"].casefold() for row in body["runbooks"]]
    assert titles == sorted(titles)
    assert body["migration"] is None


def test_the_list_filters_by_search_state_and_origin(box) -> None:
    client = box["client"]
    create(client, "acme-lockout", title="Acme lockout review")
    create(client, "acme-other", title="Acme other")
    publish(client, "acme-other")
    hits = client.get("/api/runbooks", params={"q": "acme lockout"}).json()["runbooks"]
    assert [r["id"] for r in hits] == ["acme-lockout"]
    drafts = client.get("/api/runbooks", params={"state": "draft"}).json()["runbooks"]
    assert [r["id"] for r in drafts] == ["acme-lockout"]
    published = {r["id"] for r in client.get("/api/runbooks", params={"state": "published"}).json()["runbooks"]}
    assert "acme-other" in published and "acme-lockout" not in published
    operator = client.get("/api/runbooks", params={"origin": "operator"}).json()["runbooks"]
    assert {r["id"] for r in operator} == {"acme-lockout", "acme-other"}
    assert client.get("/api/runbooks", params={"state": "nonsense"}).status_code == 422


def test_a_published_copy_hides_the_built_in_it_replaces_until_asked(box) -> None:
    client = box["client"]
    copy = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate")
    assert copy.status_code == 201, copy.text
    copy_id = copy.json()["summary"]["id"]
    assert copy_id == f"{BASE_BUILTIN}-custom"
    assert copy.json()["summary"]["replaces"] == BASE_BUILTIN
    # A draft copy replaces nothing yet.
    listed = {r["id"] for r in client.get("/api/runbooks").json()["runbooks"]}
    assert BASE_BUILTIN in listed
    publish(client, copy_id)
    listed = {r["id"] for r in client.get("/api/runbooks").json()["runbooks"]}
    assert BASE_BUILTIN not in listed and copy_id in listed
    shown = {r["id"]: r for r in client.get("/api/runbooks", params={"show_replaced": True}).json()["runbooks"]}
    assert shown[BASE_BUILTIN]["replaced_by"] == copy_id
    assert client.get(f"/api/runbooks/{BASE_BUILTIN}").json()["summary"]["replaced_by"] == copy_id


# --------------------------------------------------------------------------- #
# Detail and versions.
# --------------------------------------------------------------------------- #
def test_a_built_in_detail_is_one_published_version_with_its_source(box) -> None:
    body = box["client"].get(f"/api/runbooks/{BASE_BUILTIN}").json()
    detail = RunbookDetail.model_validate(body)
    item = builtin_runbook(BASE_BUILTIN)
    assert detail.revision == 0 and detail.draft is None and detail.in_review is None
    assert detail.live.version == item.version and detail.live.content_hash == item.content_hash
    assert detail.live.source.startswith("---\n") and f"id: {BASE_BUILTIN}" in detail.live.source
    assert [v.state for v in detail.versions] == ["published"]
    version = box["client"].get(f"/api/runbooks/{BASE_BUILTIN}/versions/{item.version}")
    assert RunbookVersionDoc.model_validate(version.json()).definition.id == BASE_BUILTIN
    missing = box["client"].get(f"/api/runbooks/{BASE_BUILTIN}/versions/{item.version + 1}")
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "runbook_version_not_found"


def test_unknown_reserved_and_malformed_ids_are_not_found(box) -> None:
    for rid in ("does-not-exist", "readme", "index", "new", "Not_Valid", "x" * 200):
        response = box["client"].get(f"/api/runbooks/{rid}")
        assert response.status_code == 404, rid
        assert response.json()["detail"]["code"] == "runbook_not_found"


def test_route_order_metrics_never_reaches_the_detail_handler(box) -> None:
    response = box["client"].get("/api/runbooks/metrics")
    assert response.status_code == 200
    assert "window_label" in response.json() and "summary" not in response.json()
    paths = [getattr(r, "path", "") for r in runbooks_router.routes]
    detail_at = paths.index("/api/runbooks/{runbook_id}")
    for fixed in ("/api/runbooks/metrics", "/api/runbooks/validate", "/api/runbooks/match-preview",
                  "/api/runbooks/import", "/api/runbooks/reindex"):
        assert paths.index(fixed) < detail_at, fixed


# --------------------------------------------------------------------------- #
# Create.
# --------------------------------------------------------------------------- #
def test_create_from_a_definition_or_from_markdown_lands_a_version_one_draft(box) -> None:
    client = box["client"]
    made = create(client, "team-brute")
    assert made["summary"]["state"] == "draft" and made["summary"]["origin"] == "operator"
    assert made["summary"]["draft_version"] == 1 and made["live"] is None
    draft = made["draft"]
    assert draft["version"] == 1 and draft["state"] == "draft" and len(draft["content_hash"]) == 64
    assert draft["source"].startswith("---\nid: team-brute")
    from_source = client.post("/api/runbooks", json={"source": source("team-brute-md")})
    assert from_source.status_code == 201, from_source.text
    assert from_source.json()["draft"]["definition"]["id"] == "team-brute-md"
    # Same text, same canonical form, same hash.
    assert from_source.json()["draft"]["content_hash"] != draft["content_hash"]  # ids differ
    assert client.get("/api/runbooks/team-brute").json()["revision"] == made["revision"]


def test_a_draft_may_hold_content_problems_but_never_a_bad_id(box) -> None:
    client = box["client"]
    no_steps = client.post("/api/runbooks", json={"definition": definition("half-done", steps=[], phases=[])})
    assert no_steps.status_code == 201, no_steps.text
    # The 40-step limit binds drafts too (a storage limit, SPEC §4.10.5).
    item = builtin_runbook(BASE_BUILTIN)
    many = [item.definition.steps[0].model_copy(update={"id": f"s{i}"}) for i in range(41)]
    too_many = client.post("/api/runbooks", json={"definition": definition("too-long", steps=many)})
    assert too_many.status_code == 422 and too_many.json()["detail"]["code"] == "runbook_invalid"
    assert any(i["path"] == "steps" for i in too_many.json()["detail"]["issues"])
    for rid, code in (("new", "runbook_id_reserved"), ("metrics", "runbook_id_reserved"),
                      (BASE_BUILTIN, "runbook_id_reserved"), ("Bad Id", "runbook_invalid")):
        refused = client.post("/api/runbooks", json={"definition": definition(rid)})
        assert refused.status_code == 422, rid
        assert refused.json()["detail"]["code"] == code, rid
        assert refused.json()["detail"]["issues"]
    assert audit_rows(box["state"], action="runbook.created") and len(audit_rows(box["state"], action="runbook.created")) == 1


def test_markdown_with_an_unknown_key_is_refused_with_the_parser_issue(box) -> None:
    text = source("odd-keys").replace("priority:", "colour: blue\npriority:", 1)
    response = box["client"].post("/api/runbooks", json={"source": text})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "runbook_invalid"
    assert any("colour" in issue["message"] for issue in detail["issues"])
    assert box["client"].get("/api/runbooks/odd-keys").status_code == 404


def _loose_version(text: str, value: str) -> str:
    assert text.count("\nversion: 1\n") == 1
    return text.replace("\nversion: 1\n", f"\nversion: {value}\n", 1)


def test_a_front_matter_version_that_is_not_a_number_never_refuses_a_write(box) -> None:
    """The parser notes that such a version "is ignored", and every write does ignore
    it (the server numbers versions), so the note never refuses a create or a save.
    An unknown key still refuses (``test_markdown_with_an_unknown_key...``)."""
    client, state = box["client"], box["state"]
    text = _loose_version(source("loose-version"), "5-draft")
    made = client.post("/api/runbooks", json={"source": text})
    assert made.status_code == 201, made.text
    assert made.json()["draft"]["version"] == 1
    saved = client.put("/api/runbooks/loose-version/draft", json={
        "source": _loose_version(source("loose-version", title="Edited"), "abc"),
        "expected_revision": made.json()["revision"],
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["draft"]["version"] == 1 and saved.json()["draft"]["definition"]["title"] == "Edited"
    # Once published, the next draft takes the server's number whatever the text says.
    live = publish(client, "loose-version")
    following = client.put("/api/runbooks/loose-version/draft", json={
        "source": _loose_version(source("loose-version", title="Third"), "abc"),
        "expected_revision": live["revision"],
    })
    assert following.status_code == 200, following.text
    assert following.json()["draft"]["version"] == 2
    assert len(audit_rows(state, action="runbook.draft_updated")) == 2
    # The Source view still sees the note: validate reports it (and nothing else).
    checked = client.post("/api/runbooks/validate", json={"source": text}).json()
    assert [(i["path"], i["code"]) for i in checked["issues"]] == [("version", "parse")]
    # A note beside a real problem: the real problem alone refuses.
    both = _loose_version(source("both-notes"), "abc").replace("priority:", "colour: blue\npriority:", 1)
    refused = client.post("/api/runbooks", json={"source": both})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "runbook_invalid"
    issues = refused.json()["detail"]["issues"]
    assert any("colour" in i["message"] for i in issues) and all(i["path"] != "version" for i in issues)


def test_create_needs_exactly_one_of_definition_or_source(box) -> None:
    client = box["client"]
    both = client.post("/api/runbooks", json={"definition": definition("both"), "source": source("both")})
    assert both.status_code == 422 and both.json()["detail"]["code"] == "runbook_invalid"
    neither = client.post("/api/runbooks", json={"id": "nothing"})
    assert neither.status_code == 422 and neither.json()["detail"]["code"] == "runbook_invalid"
    unknown = client.post("/api/runbooks", json={"definition": definition("x1"), "colour": "blue"})
    assert unknown.status_code == 422


def test_creating_an_existing_id_is_a_conflict_with_the_latest(box) -> None:
    client = box["client"]
    create(client, "twice")
    again = client.post("/api/runbooks", json={"definition": definition("twice")})
    assert again.status_code == 409
    detail = again.json()["detail"]
    assert detail["code"] == "runbook_conflict" and detail["exists"] is True
    assert detail["latest"]["summary"]["id"] == "twice"


def test_an_oversized_body_is_refused_before_it_is_read(box) -> None:
    client, state = box["client"], box["state"]
    response = client.post(
        "/api/runbooks", content=b"{" + b" " * (600 * 1024) + b"}",
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "runbook_body_too_large"
    # Invalid JSON over the bound is refused too, not reported as bad JSON: the body
    # was never parsed (FastAPI parses before it solves any dependency, so the bound
    # sits in the route class, ahead of the parse).
    broken = client.post("/api/runbooks", content=b"{" + b"x" * (600 * 1024),
                         headers={"content-type": "application/json"})
    assert broken.status_code == 413 and broken.json()["detail"]["code"] == "runbook_body_too_large"

    # A body that declares no length (chunked) is read only until it passes the bound.
    def chunked() -> Any:
        yield b'{"source": "'
        for _ in range(700):
            yield b"a" * 1024
        yield b'"}'

    streamed = client.post("/api/runbooks", content=chunked(), headers={"content-type": "application/json"})
    assert streamed.status_code == 413 and streamed.json()["detail"]["code"] == "runbook_body_too_large"
    for path in ("/api/runbooks/validate", "/api/runbooks/import", "/api/runbooks/match-preview"):
        refused = client.post(path, content=b"{" + b"x" * (600 * 1024),
                              headers={"content-type": "application/json"})
        assert refused.status_code == 413, path
    made = create(client, "bounded")
    big_draft = client.put("/api/runbooks/bounded/draft", content=b"{" + b"x" * (600 * 1024),
                           headers={"content-type": "application/json"})
    assert big_draft.status_code == 413
    rows = len(audit_rows(state))
    # A body that fits is read once and reaches the handler unchanged.
    fits = client.put("/api/runbooks/bounded/draft", json={
        "source": source("bounded", title="Fits the bound"), "expected_revision": made["revision"]})
    assert fits.status_code == 200, fits.text
    assert fits.json()["draft"]["definition"]["title"] == "Fits the bound"
    # Nothing refused above wrote a row: only the one create (before) and this save did.
    assert [r["action"] for r in audit_rows(state)][rows:] == ["runbook.draft_updated"]
    assert len(audit_rows(state, action="runbook.created")) == 1


# --------------------------------------------------------------------------- #
# Draft save and discard.
# --------------------------------------------------------------------------- #
def test_saving_the_draft_edits_it_in_place_and_a_stale_revision_is_refused(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "edit-me")
    saved = client.put("/api/runbooks/edit-me/draft", json={
        "definition": definition("edit-me", title="Edited title"), "expected_revision": made["revision"],
    })
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["draft"]["version"] == 1 and body["draft"]["definition"]["title"] == "Edited title"
    assert body["revision"] == made["revision"] + 1
    rows_before = len(audit_rows(state))
    stale = client.put("/api/runbooks/edit-me/draft", json={
        "definition": definition("edit-me", title="Lost"), "expected_revision": made["revision"],
    })
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["code"] == "runbook_conflict" and detail["revision"] == body["revision"]
    assert detail["latest"]["draft"]["definition"]["title"] == "Edited title"
    # A refused pre-check writes no audit row.
    assert len(audit_rows(state)) == rows_before


def test_saving_the_same_text_again_writes_nothing(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "autosave")
    rows = len(audit_rows(state))
    again = client.put("/api/runbooks/autosave/draft", json={
        "definition": definition("autosave"), "expected_revision": made["revision"],
    })
    assert again.status_code == 200 and again.json()["revision"] == made["revision"]
    assert len(audit_rows(state)) == rows


def test_an_unchanged_save_keeps_a_version_in_review_and_writes_nothing(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "in-review")
    sent = client.post("/api/runbooks/in-review/submit", json={"version": 1, "expected_revision": made["revision"]})
    assert sent.status_code == 200
    before, rows = kv_snapshot(state), len(audit_rows(state))
    # An autosave of the text under review must not withdraw it from review.
    again = client.put("/api/runbooks/in-review/draft", json={
        "definition": sent.json()["in_review"]["definition"], "expected_revision": sent.json()["revision"],
    })
    assert again.status_code == 200, again.text
    assert again.json()["in_review"]["version"] == 1 and again.json()["draft"] is None
    assert kv_snapshot(state) == before and len(audit_rows(state)) == rows
    # A real edit still takes it back to draft.
    edited = client.put("/api/runbooks/in-review/draft", json={
        "definition": definition("in-review", title="Changed in review"),
        "expected_revision": sent.json()["revision"],
    })
    assert edited.status_code == 200 and edited.json()["draft"]["version"] == 1
    assert edited.json()["in_review"] is None


def test_an_unchanged_save_of_a_published_runbook_opens_no_draft(box) -> None:
    client, state = box["client"], box["state"]
    create(client, "steady")
    live = publish(client, "steady")
    rows = len(audit_rows(state))
    same = client.put("/api/runbooks/steady/draft", json={
        "definition": live["live"]["definition"], "expected_revision": live["revision"],
    })
    assert same.status_code == 200 and same.json()["draft"] is None
    assert same.json()["revision"] == live["revision"] and len(audit_rows(state)) == rows


def test_a_save_without_a_review_cadence_keeps_the_runbooks_own(box) -> None:
    client, state = box["client"], box["state"]

    async def ninety() -> None:
        prefs = state.prefs
        await state.update_prefs(prefs.model_copy(update={
            "runbooks": prefs.runbooks.model_copy(update={"review_every_days_default": 90})}))

    client.portal.call(ninety)
    bare = definition("cadence-kept")
    bare.pop("review_every_days")
    made = client.post("/api/runbooks", json={"definition": bare})
    assert made.status_code == 201 and made.json()["draft"]["definition"]["review_every_days"] == 90
    edited = dict(bare, summary="A changed summary.")
    saved = client.put("/api/runbooks/cadence-kept/draft", json={
        "definition": edited, "expected_revision": made.json()["revision"]})
    assert saved.status_code == 200 and saved.json()["draft"]["definition"]["review_every_days"] == 90
    # A runbook with its own cadence keeps it through an edit that leaves it out,
    # including an edit of the live version (the new draft starts from the live one).
    create(client, "own-cadence", review_every_days=45)
    live = publish(client, "own-cadence")
    text = definition("own-cadence", summary="Second text.")
    text.pop("review_every_days")
    second = client.put("/api/runbooks/own-cadence/draft", json={
        "definition": text, "expected_revision": live["revision"]})
    assert second.status_code == 200 and second.json()["draft"]["definition"]["review_every_days"] == 45
    # Stated explicitly, it is what the author wrote.
    stated = client.put("/api/runbooks/own-cadence/draft", json={
        "definition": definition("own-cadence", summary="Second text.", review_every_days=365),
        "expected_revision": second.json()["revision"]})
    assert stated.json()["draft"]["definition"]["review_every_days"] == 365


def test_a_new_runbook_of_a_discarded_id_audits_the_revision_it_writes(box) -> None:
    client, state = box["client"], box["state"]
    first = create(client, "again")
    assert client.delete("/api/runbooks/again/draft").status_code == 200
    # The discard left a tombstone at the next revision; the new runbook lands above it.
    second = create(client, "again")
    assert second["revision"] > first["revision"]
    rows = [r for r in audit_rows(state, action="runbook.created") if r["target"]["id"] == "again"]
    assert [r["target"]["revision"] for r in rows] == [first["revision"], second["revision"]]
    # The same holds for an import and a duplicate that take a freed id.
    assert client.delete("/api/runbooks/again/draft").status_code == 200
    imported = client.post("/api/runbooks/import", json={"source": source("again")}).json()
    assert imported["summary"]["id"] == "again"
    assert audit_rows(state, action="runbook.imported")[-1]["target"]["revision"] == imported["revision"]
    copy_id = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]["id"]
    assert client.delete(f"/api/runbooks/{copy_id}/draft").status_code == 200
    copied = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()
    assert copied["summary"]["id"] == copy_id
    assert audit_rows(state, action="runbook.duplicated")[-1]["target"]["revision"] == copied["revision"]


def test_the_draft_id_cannot_change_and_markdown_drafts_work(box) -> None:
    client = box["client"]
    made = create(client, "fixed-id")
    moved = client.put("/api/runbooks/fixed-id/draft", json={
        "definition": definition("other-id"), "expected_revision": made["revision"],
    })
    assert moved.status_code == 422 and moved.json()["detail"]["code"] == "runbook_invalid"
    via_source = client.put("/api/runbooks/fixed-id/draft", json={
        "source": source("fixed-id", title="From Markdown"), "expected_revision": made["revision"],
    })
    assert via_source.status_code == 200, via_source.text
    assert via_source.json()["draft"]["definition"]["title"] == "From Markdown"


def test_editing_a_published_runbook_creates_the_next_version_as_a_draft(box) -> None:
    client = box["client"]
    create(client, "live-one")
    live = publish(client, "live-one")
    edited = client.put("/api/runbooks/live-one/draft", json={
        "definition": definition("live-one", title="Second take"), "expected_revision": live["revision"],
    })
    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert body["live"]["version"] == 1 and body["draft"]["version"] == 2
    assert body["summary"]["state"] == "published" and body["summary"]["draft_version"] == 2
    # The library row still describes the live text.
    assert body["summary"]["title"] != "Second take"


def test_discarding_a_never_published_draft_removes_the_runbook(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "throwaway")
    gone = client.delete("/api/runbooks/throwaway/draft", params={"expected_revision": made["revision"]})
    assert gone.status_code == 200, gone.text
    assert gone.json() == {"id": "throwaway", "removed": True, "detail": None}
    assert client.get("/api/runbooks/throwaway").status_code == 404
    assert audit_rows(state, action="runbook.draft_discarded")


def test_discarding_a_draft_keeps_the_published_history(box) -> None:
    client = box["client"]
    create(client, "keep-live")
    live = publish(client, "keep-live")
    edited = client.put("/api/runbooks/keep-live/draft", json={
        "definition": definition("keep-live", title="Scrap this"), "expected_revision": live["revision"],
    }).json()
    kept = client.delete("/api/runbooks/keep-live/draft")
    assert kept.status_code == 200, kept.text
    body = kept.json()
    assert body["removed"] is False and body["detail"]["draft"] is None
    assert body["detail"]["live"]["version"] == 1 and body["detail"]["revision"] == edited["revision"] + 1
    nothing = client.delete("/api/runbooks/keep-live/draft")
    assert nothing.status_code == 409 and nothing.json()["detail"]["code"] == "runbook_state"


def test_built_ins_are_read_only(box) -> None:
    client = box["client"]
    for method, path, body in (
        ("put", f"/api/runbooks/{BASE_BUILTIN}/draft", {"definition": definition(BASE_BUILTIN), "expected_revision": 0}),
        ("delete", f"/api/runbooks/{BASE_BUILTIN}/draft", None),
        ("post", f"/api/runbooks/{BASE_BUILTIN}/retire", {}),
        ("post", f"/api/runbooks/{BASE_BUILTIN}/publish", {"version": 1, "expected_revision": 0}),
        ("post", f"/api/runbooks/{BASE_BUILTIN}/reviewed", {}),
    ):
        kwargs = {"json": body} if body is not None else {}
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 409, path
        assert response.json()["detail"]["code"] == "runbook_readonly", path


# --------------------------------------------------------------------------- #
# Duplicate and import.
# --------------------------------------------------------------------------- #
def test_duplicating_twice_takes_the_next_free_id(box) -> None:
    client = box["client"]
    first = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]
    second = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]
    assert first["id"] == f"{BASE_BUILTIN}-custom" and second["id"] == f"{BASE_BUILTIN}-custom-2"
    assert first["derived_from"] == {"id": BASE_BUILTIN, "version": builtin_runbook(BASE_BUILTIN).version}
    operator_copy = client.post(f"/api/runbooks/{first['id']}/duplicate")
    assert operator_copy.status_code == 201
    body = operator_copy.json()
    assert body["summary"]["replaces"] is None and body["summary"]["title"].endswith("(copy)")
    assert body["summary"]["derived_from"]["id"] == first["id"]
    assert client.post("/api/runbooks/no-such/duplicate").status_code == 404


def test_import_always_lands_as_a_draft_and_renames_a_clashing_id(box) -> None:
    client = box["client"]
    exported = builtin_runbook(BASE_BUILTIN).source
    imported = client.post("/api/runbooks/import", json={"source": exported})
    assert imported.status_code == 201, imported.text
    body = imported.json()
    assert body["summary"]["origin"] == "imported" and body["summary"]["state"] == "draft"
    assert body["summary"]["id"] == f"{BASE_BUILTIN}-custom" and body["summary"]["replaces"] == BASE_BUILTIN
    assert any("built-in" in note for note in body["draft"]["import_notes"])
    # The front matter version is ignored: an import is always version 1.
    assert body["draft"]["version"] == 1
    reserved = client.post("/api/runbooks/import", json={"source": source("index")}).json()
    assert reserved["summary"]["id"] == "index-imported"
    create(client, "team-x")
    taken = client.post("/api/runbooks/import", json={"source": source("team-x")}).json()
    assert taken["summary"]["id"] == "team-x-imported"


def test_an_import_is_due_for_review_at_once(box) -> None:
    client = box["client"]
    started = datetime.now(UTC)
    imported = client.post("/api/runbooks/import", json={"source": source("arrived")})
    assert imported.status_code == 201, imported.text
    due = datetime.fromisoformat(imported.json()["summary"]["review_due_at"])
    # D38: imported content is due immediately, not review_every_days from now.
    assert started - timedelta(seconds=5) <= due <= datetime.now(UTC) + timedelta(seconds=5)
    # A runbook written here is not due until it is published.
    assert create(client, "written-here")["summary"]["review_due_at"] is None


def test_import_keeps_problems_as_notes_and_refuses_unreadable_markdown(box) -> None:
    client = box["client"]
    text = source("noted", title="x" * 130).replace("priority:", "colour: blue\npriority:", 1)
    noted = client.post("/api/runbooks/import", json={"source": text})
    assert noted.status_code == 201, noted.text
    notes = noted.json()["draft"]["import_notes"]
    assert any("colour" in n for n in notes) and any("title" in n.lower() for n in notes)
    bad = client.post("/api/runbooks/import", json={"source": "no front matter here"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "runbook_invalid"
    assert client.post("/api/runbooks/import", json={"definition": definition("d1")}).status_code == 422


# --------------------------------------------------------------------------- #
# Validate and export.
# --------------------------------------------------------------------------- #
def test_validate_reports_issues_and_the_guidance_length_and_stores_nothing(box) -> None:
    client, state = box["client"], box["state"]
    before = kv_snapshot(state)
    ok = client.post("/api/runbooks/validate", json={"definition": definition("check-me")}).json()
    assert ok["issues"] == [] and ok["prompt_budget"] == 3000 and 0 < ok["prompt_chars"] <= 3000
    bad = client.post("/api/runbooks/validate", json={"definition": definition("check-me", steps=[])}).json()
    assert bad["issues"] and all({"path", "code", "message"} <= set(i) for i in bad["issues"])
    md = client.post("/api/runbooks/validate", json={"source": source("check-md").replace(
        "priority:", "colour: blue\npriority:", 1)}).json()
    assert any("colour" in i["message"] for i in md["issues"])
    assert kv_snapshot(state) == before


def test_validate_checks_a_built_ins_own_text_as_a_built_in(box) -> None:
    client = box["client"]
    item = builtin_runbook(BASE_BUILTIN)
    # The read-only Source view of a built-in is not told that its id is taken.
    own = client.post("/api/runbooks/validate", json={"source": item.source}).json()
    assert own["issues"] == [] and own["prompt_chars"] == item.prompt_chars
    as_definition = client.post("/api/runbooks/validate", json={
        "definition": item.definition.model_dump(mode="json")}).json()
    assert as_definition["issues"] == []
    # Any other text under a built-in's id is an operator runbook claiming a taken id.
    edited = client.post("/api/runbooks/validate", json={
        "definition": definition(BASE_BUILTIN, title="My own take")}).json()
    assert [i["code"] for i in edited["issues"] if i["path"] == "id"] == ["builtin_id"]


def test_export_is_markdown_and_audited_before_it_is_sent(box) -> None:
    client, state = box["client"], box["state"]
    response = client.get(f"/api/runbooks/{BASE_BUILTIN}/export")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    item = builtin_runbook(BASE_BUILTIN)
    assert response.headers["content-disposition"] == f'attachment; filename="{BASE_BUILTIN}-v{item.version}.md"'
    assert response.text.startswith("---\n") and f"version: {item.version}" in response.text
    rows = audit_rows(state, action="runbook.exported")
    assert len(rows) == 1 and rows[0]["target"]["id"] == BASE_BUILTIN and rows[0]["outcome"] == "success"
    create(client, "draft-export")
    draft = client.get("/api/runbooks/draft-export/export")
    assert draft.status_code == 200 and "id: draft-export" in draft.text


def test_an_export_whose_audit_row_cannot_be_written_is_refused(box, monkeypatch) -> None:
    async def refuse(**_kw: Any) -> None:
        raise RuntimeError("audit store down")

    monkeypatch.setattr(box["state"].control_audit, "record_strict", refuse)
    response = box["client"].get(f"/api/runbooks/{BASE_BUILTIN}/export")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "audit_unavailable"


# --------------------------------------------------------------------------- #
# Audit before visible (SPEC §3.6).
# --------------------------------------------------------------------------- #
def test_every_write_appends_its_row_to_the_control_audit_first(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "audited")
    rows = audit_rows(state, action="runbook.created")
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == "success" and row["actor_type"] == "human" and row["surface"] == "runbooks"
    assert row["target"] == {"type": "runbook", "id": "audited", "label": made["summary"]["title"], "revision": 1}
    assert {c["field"] for c in row["changes"]} >= {"title", "steps", "content_hash", "version 1 state"}
    # Every change value is the value itself, as text (or null when absent).
    by_field = {c["field"]: c for c in row["changes"]}
    assert by_field["title"] == {"field": "title", "before": None, "after": made["summary"]["title"], "secret": False}
    assert by_field["content_hash"]["after"] == made["draft"]["content_hash"]
    for change in row["changes"]:
        assert all(v is None or isinstance(v, str) for v in (change["before"], change["after"]))


def test_free_text_is_recorded_verbatim_in_the_audit_row(box) -> None:
    """The audit row holds what the person wrote: a title or a review note that starts
    with a date is kept as it is (the audit mapping stores ``changes`` unindexed with
    date detection off, so no value needs rewriting)."""
    client, state = box["client"], box["state"]
    made = create(client, "dated", title="2026-10-01 password spray review")
    created = audit_rows(state, action="runbook.created")[-1]
    title = next(c for c in created["changes"] if c["field"] == "title")
    assert title["after"] == "2026-10-01 password spray review" == made["summary"]["title"]
    sent = client.post("/api/runbooks/dated/submit", json={"version": 1, "expected_revision": made["revision"]})
    assert sent.status_code == 200, sent.text
    reason = "2026-10-01 rule changed, update step 2"
    rejected = client.post("/api/runbooks/dated/reject", json={"version": 1, "reason": reason})
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["draft"]["review_notes"][-1]["text"] == reason
    row = audit_rows(state, action="runbook.rejected")[-1]
    assert {"field": "review_note", "before": None, "after": reason, "secret": False} in row["changes"]


def test_a_failed_audit_append_changes_nothing(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]

    async def refuse(**_kw: Any) -> None:
        raise RuntimeError("audit store down")

    monkeypatch.setattr(state.control_audit, "record_strict", refuse)
    response = client.post("/api/runbooks", json={"definition": definition("never-stored")})
    assert response.status_code == 503 and response.json()["detail"]["code"] == "audit_unavailable"
    monkeypatch.undo()
    assert client.get("/api/runbooks/never-stored").status_code == 404


def test_a_failed_store_write_appends_a_paired_failure_row(box, monkeypatch) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "flaky")

    async def broken(*_a: Any, **_kw: Any) -> Any:
        raise RunbookStoreUnavailable("disk on fire")

    monkeypatch.setattr(state.runbook_library, "update", broken)
    response = client.put("/api/runbooks/flaky/draft", json={
        "definition": definition("flaky", title="Changed"), "expected_revision": made["revision"],
    })
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "runbook_store_unavailable"
    action = audit_rows(state, action="runbook.draft_updated")
    failure = audit_rows(state, action="runbook.draft_update_failed")
    assert len(action) == 1 and len(failure) == 1
    assert failure[0]["outcome"] == "failure" and failure[0]["request_id"] == action[0]["request_id"]
    assert "runbook_store_unavailable" in failure[0]["result_summary"]


# --------------------------------------------------------------------------- #
# Demo Mode (SPEC §3.5).
# --------------------------------------------------------------------------- #
def test_demo_mode_reads_the_real_library_and_refuses_every_write(box) -> None:
    client, state = box["client"], box["state"]
    made = create(client, "real-one")
    client.portal.call(lambda: state.enable_demo(mode="seeded", seed=7, history_days=1))
    try:
        rows = len(audit_rows(state))
        listed = {r["id"] for r in client.get("/api/runbooks").json()["runbooks"]}
        assert "real-one" in listed and BASE_BUILTIN in listed
        for method, path, body in (
            ("post", "/api/runbooks", {"definition": definition("demo-new")}),
            ("put", "/api/runbooks/real-one/draft", {"definition": definition("real-one"), "expected_revision": made["revision"]}),
            ("delete", "/api/runbooks/real-one/draft", None),
            ("post", f"/api/runbooks/{BASE_BUILTIN}/duplicate", {}),
            ("post", "/api/runbooks/import", {"source": source("demo-import")}),
            ("post", "/api/runbooks/real-one/publish", {"version": 1, "expected_revision": made["revision"]}),
        ):
            kwargs = {"json": body} if body is not None else {}
            response = getattr(client, method)(path, **kwargs)
            assert response.status_code == 409, path
            assert response.json()["detail"]["code"] == "runbook_demo_readonly", path
            assert response.json()["detail"]["message"] == "Runbooks cannot be edited in Demo Mode."
        assert len(audit_rows(state)) == rows
    finally:
        client.portal.call(state.disable_demo)


def test_an_export_in_demo_mode_is_audited_to_the_control_audit(box) -> None:
    """An export is a read of the REAL library, allowed in Demo Mode, and its row goes
    to the control audit, never to the Demo audit that Demo Mode swaps in for the
    workload (SPEC §3.5, §3.6)."""
    client, state = box["client"], box["state"]
    create(client, "demo-export")
    client.portal.call(lambda: state.enable_demo(mode="seeded", seed=7, history_days=1))
    try:
        demo_audit = state.demo_audit
        assert demo_audit is not None and demo_audit is not state.control_audit
        for runbook_id in (BASE_BUILTIN, "demo-export"):
            response = client.get(f"/api/runbooks/{runbook_id}/export")
            assert response.status_code == 200, runbook_id
        rows = audit_rows(state, action="runbook.exported")
        assert [r["target"]["id"] for r in rows] == [BASE_BUILTIN, "demo-export"]
        assert all(r["outcome"] == "success" and r["surface"] == "runbooks" for r in rows)
        in_demo = client.portal.call(lambda: demo_audit.records(action_type="runbook", limit=500))
        assert [r for r in in_demo if r.get("action") == "runbook.exported"] == []
    finally:
        client.portal.call(state.disable_demo)


# --------------------------------------------------------------------------- #
# Grants and visibility.
# --------------------------------------------------------------------------- #
@pytest.fixture
def rbac_box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True)) as client:
        holder["client"] = client
        add_user(client, "tier1", "analyst_tier1")
        add_user(client, "manager", "soc_manager")
        add_user(client, "auditor", "auditor")
        yield holder


def test_reads_need_a_session_and_writes_need_manage(rbac_box) -> None:
    client = rbac_box["client"]
    client.post("/api/auth/logout")
    assert client.get("/api/runbooks").status_code == 401
    login(client, "tier1", "user-pass-12345")
    assert client.get("/api/runbooks").status_code == 200
    assert client.post("/api/runbooks", json={"definition": definition("t1")}).status_code == 403
    assert client.post("/api/runbooks/import", json={"source": source("t1")}).status_code == 403
    assert client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").status_code == 403
    # Validate and export are reads.
    assert client.post("/api/runbooks/validate", json={"definition": definition("t1")}).status_code == 200
    assert client.get(f"/api/runbooks/{BASE_BUILTIN}/export").status_code == 200


def test_drafts_are_visible_only_to_manage_or_publish_holders(rbac_box) -> None:
    client = rbac_box["client"]
    login(client, "manager", "user-pass-12345")
    create(client, "secret-draft")
    create(client, "half-live")
    live = publish(client, "half-live")
    client.put("/api/runbooks/half-live/draft", json={
        "definition": definition("half-live", title="Unreviewed"), "expected_revision": live["revision"],
    })
    manager_ids = {r["id"] for r in client.get("/api/runbooks").json()["runbooks"]}
    assert {"secret-draft", "half-live"} <= manager_ids
    for user in ("tier1", "auditor"):
        login(client, user, "user-pass-12345")
        rows = {r["id"]: r for r in client.get("/api/runbooks").json()["runbooks"]}
        assert "secret-draft" not in rows and "half-live" in rows
        assert rows["half-live"]["draft_version"] is None and rows["half-live"]["title"] != "Unreviewed"
        assert client.get("/api/runbooks/secret-draft").status_code == 404
        detail = client.get("/api/runbooks/half-live").json()
        assert detail["draft"] is None and detail["in_review"] is None
        assert [v["state"] for v in detail["versions"]] == ["published"]
        hidden = client.get("/api/runbooks/half-live/versions/2")
        assert hidden.status_code == 404 and hidden.json()["detail"]["code"] == "runbook_version_not_found"
        assert client.get("/api/runbooks/half-live/versions/1").status_code == 200
        # The default export is the live version for them.
        assert "Unreviewed" not in client.get("/api/runbooks/half-live/export").text
        assert client.get("/api/runbooks/half-live/export", params={"version": 2}).status_code == 404


def test_a_reader_never_learns_who_touched_a_hidden_draft_or_when(rbac_box) -> None:
    """``updated_at`` and ``updated_by`` describe the last change a viewer may see: a
    save, a submit or a rejection of a hidden version is work on unpublished text, so
    a viewer without ``manage`` or ``publish`` keeps seeing the last public change."""
    client = rbac_box["client"]
    login(client, "manager", "user-pass-12345")
    create(client, "quiet-edit")
    live = publish(client, "quiet-edit")

    def reader_view() -> tuple[tuple[Any, Any], tuple[Any, Any]]:
        login(client, "tier1", "user-pass-12345")
        listed = next(r for r in client.get("/api/runbooks").json()["runbooks"] if r["id"] == "quiet-edit")
        detail = client.get("/api/runbooks/quiet-edit").json()["summary"]
        return (listed["updated_at"], listed["updated_by"]), (detail["updated_at"], detail["updated_by"])

    before_list, before_detail = reader_view()
    assert before_list == before_detail == (live["summary"]["last_reviewed_at"], "manager")
    assert live["summary"]["last_reviewed_at"] == live["live"]["published_at"]
    login(client, *ADMIN)
    saved = client.put("/api/runbooks/quiet-edit/draft", json={
        "definition": definition("quiet-edit", title="Unreviewed wording"), "expected_revision": live["revision"],
    })
    assert saved.status_code == 200, saved.text
    # The writer and the publishers see the draft work.
    assert saved.json()["summary"]["updated_by"] == "Admin"
    assert saved.json()["summary"]["updated_at"] > live["summary"]["updated_at"]
    after_list, after_detail = reader_view()
    assert after_list == after_detail == before_list
    # Submitting it for review stays hidden too.
    login(client, *ADMIN)
    detail = client.get("/api/runbooks/quiet-edit").json()
    sent = client.post("/api/runbooks/quiet-edit/submit", json={"version": 2, "expected_revision": detail["revision"]})
    assert sent.status_code == 200, sent.text
    assert reader_view() == (before_list, before_detail)
    # A public change (Mark reviewed) is seen, with who did it.
    login(client, "manager", "user-pass-12345")
    reviewed = client.post("/api/runbooks/quiet-edit/reviewed")
    assert reviewed.status_code == 200, reviewed.text
    stamp = reviewed.json()["summary"]["last_reviewed_at"]
    assert reader_view() == ((stamp, "manager"), (stamp, "manager"))


def test_a_reader_sees_the_last_public_change() -> None:
    from app.engine import runbook_catalog as catalog
    from app.stores.runbook_library import RunbookIndexRow

    published_at = "2026-10-01T09:00:00+00:00"
    row = RunbookIndexRow(id="migrated", title="Migrated", live_version=1, draft_version=2,
                          published_at=published_at, updated_at="2026-10-20T10:00:00+00:00",
                          updated_by="someone")
    reader = catalog.summary_from_row(row, can_see_unpublished=False)
    assert (reader.updated_at, reader.updated_by) == (published_at, None)
    writer = catalog.summary_from_row(row, can_see_unpublished=True)
    assert (writer.updated_at, writer.updated_by) == ("2026-10-20T10:00:00+00:00", "someone")
    # After the draft is discarded the row's last touch is the discard: still hidden.
    discarded = row.model_copy(update={"draft_version": None})
    shown = catalog.summary_from_row(discarded, can_see_unpublished=False)
    assert (shown.updated_at, shown.updated_by) == (published_at, None)
    # A later review is a public change, with who did it.
    reviewed = discarded.model_copy(update={"last_reviewed_at": "2026-10-25T08:00:00+00:00",
                                            "last_reviewed_by": "lee"})
    shown = catalog.summary_from_row(reviewed, can_see_unpublished=False)
    assert (shown.updated_at, shown.updated_by) == ("2026-10-25T08:00:00+00:00", "lee")


def test_runs_30d_is_null_without_cases_read(rbac_box) -> None:
    client = rbac_box["client"]
    state = rbac_box["state"]

    async def deny_cases() -> None:
        prefs = state.prefs
        rbac = prefs.rbac.model_copy(update={"denies": {"auditor": {"cases": ["read"]}}})
        await state.update_prefs(prefs.model_copy(update={"rbac": rbac}))

    client.portal.call(deny_cases)
    login(client, "auditor", "user-pass-12345")
    rows = client.get("/api/runbooks").json()["runbooks"]
    assert rows and all(r["runs_30d"] is None for r in rows)
    login(client, "tier1", "user-pass-12345")
    assert all(r["runs_30d"] == 0 for r in client.get("/api/runbooks").json()["runbooks"])


def test_open_runs_per_version_are_case_figures(rbac_box, monkeypatch) -> None:
    """"3 open cases stay on v4" is read from case runs: like runs_30d it is hidden
    from a viewer without cases:read (and under row-level scope)."""
    client, state = rbac_box["client"], rbac_box["state"]
    from app.engine import runbook_catalog

    async def pinned(_store: Any, runbook_id: str, **_kw: Any) -> dict[int, int]:
        return {1: 3}

    monkeypatch.setattr(runbook_catalog, "open_runs_by_version", pinned)

    async def deny_cases() -> None:
        prefs = state.prefs
        rbac = prefs.rbac.model_copy(update={"denies": {"auditor": {"cases": ["read"]}}})
        await state.update_prefs(prefs.model_copy(update={"rbac": rbac}))

    client.portal.call(deny_cases)
    login(client, "tier1", "user-pass-12345")
    assert client.get(f"/api/runbooks/{BASE_BUILTIN}").json()["open_runs_by_version"] == {"1": 3}
    login(client, "auditor", "user-pass-12345")
    hidden = client.get(f"/api/runbooks/{BASE_BUILTIN}").json()
    assert hidden["open_runs_by_version"] == {} and hidden["summary"]["runs_30d"] is None
    login(client, "tier1", "user-pass-12345")
    monkeypatch.setattr("app.api.routes_runbooks._object_scoped", lambda _state, _request: True)
    scoped = client.get(f"/api/runbooks/{BASE_BUILTIN}").json()
    assert scoped["open_runs_by_version"] == {} and scoped["summary"]["runs_30d"] is None


def test_no_console_copy_carries_an_em_dash_or_the_retired_word() -> None:
    """Every sentence this package can send to the Console (error messages, notes,
    summaries) is plain: no em dash, no en dash, never the retired word. The 410
    detail is the one place the old name is named, by the API contract (E14)."""
    import inspect
    import re

    from app.api import routes_runbooks
    from app.engine import runbook_catalog

    for module in (routes_runbooks, runbook_catalog):
        text = inspect.getsource(module)
        assert "\u2014" not in text and "\u2013" not in text, module.__name__
        strings = re.findall(r'"([^"\n]{12,})"', text)
        offenders = [s for s in strings if "playbook" in s.lower() and s != runbook_catalog.RUNBOOKS_MOVED_DETAIL]
        assert offenders == [], offenders


def test_the_builtin_loader_is_shared_with_the_catalog() -> None:
    assert [b.id for b in load_builtin_runbooks()] == list(BUILTIN_RUNBOOK_IDS)


def test_the_library_and_version_limits_are_checked_before_any_audit_row(box, monkeypatch) -> None:
    import app.models as models
    import app.stores.runbook_library as library_store

    client, state = box["client"], box["state"]
    create(client, "first-one")
    live = publish(client, "first-one")
    rows = len(audit_rows(state))
    monkeypatch.setattr(models, "MAX_OPERATOR_RUNBOOKS", 1)
    full = client.post("/api/runbooks", json={"definition": definition("second-one")})
    assert full.status_code == 409 and full.json()["detail"]["code"] == "runbook_limit"
    assert full.json()["detail"]["limit"] == "runbooks"
    assert client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").status_code == 409
    assert client.post("/api/runbooks/import", json={"source": source("third-one")}).status_code == 409
    monkeypatch.setattr(library_store, "MAX_RUNBOOK_VERSIONS", 1)
    more = client.put("/api/runbooks/first-one/draft", json={
        "definition": definition("first-one", title="Version two"), "expected_revision": live["revision"],
    })
    assert more.status_code == 409 and more.json()["detail"]["limit"] == "versions"
    assert len(audit_rows(state)) == rows
