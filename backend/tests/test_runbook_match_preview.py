"""The runbook editor's match preview (Round 14 SPEC §4.10.12, §4.10.15; package A7b).

``POST /api/runbooks/match-preview`` answers "Which cases would this match?" over the
last 500 cases of the last 30 days, with the same pure matcher the attachment uses
(``engine.runbook_match``): "Gets it" (it would win), "Another wins" (it matches but
another runbook ranks higher, named) and "Near misses" (one criterion failed). It is a
read: nothing is attached, no metric changes, no audit row is written and no model is
called (#6). Counts are exact; each list holds at most 50.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.constants import EntityType
from app.models import Entity, MatchPreview
from tests.test_runbook_library_api import (
    BASE_BUILTIN,
    add_user,
    auth_secrets,
    create,
    definition,
    kv_snapshot,
    login,
    make_app,
    make_case,
    seed_cases,
    source,
)

PREVIEWED = "acme-preview"


def _preview_definition(**update: Any) -> dict[str, Any]:
    applies = {"rule_ids": ["acme_rule", "sshd"], "entity_types": ["ip"]}
    applies.update(update.pop("applies_when", {}))
    return definition(PREVIEWED, applies_when=applies, priority=10, **update)


def _seed(box: dict[str, Any]) -> None:
    seed_cases(box["client"], box["state"], [
        # Matches on its rule and wins (no built-in names acme_rule): Gets it.
        make_case("c-0001", hours_ago=1, rule_ids=["acme_rule"]),
        # Matches, but the brute force built-in (rule sshd, priority 50) ranks higher.
        make_case("c-0002", hours_ago=2, rule_ids=["sshd"]),
        # The rule matches, the entity type does not: a near miss.
        make_case("c-0003", hours_ago=3, rule_ids=["acme_rule"],
                  entity=Entity(type=EntityType.USER, value="asha")),
        # Older than 30 days: never considered.
        make_case("c-0004", hours_ago=24 * 40, rule_ids=["acme_rule"]),
        # Another detection with the same entity type: only the rule failed, which is
        # not "almost" this runbook's case, so it is not a near miss.
        make_case("c-0005", hours_ago=4, rule_ids=["zzz_rule"]),
    ])


@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        _seed(holder)
        yield holder


def _post(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/api/runbooks/match-preview", json=body)
    assert response.status_code == 200, response.text
    MatchPreview.model_validate(response.json())
    return response.json()


def test_the_three_groups_name_the_cases_and_why(box) -> None:
    body = _post(box["client"], {"definition": _preview_definition()})
    assert body["considered"] == 4 and body["window_label"] == "Last 30 days"
    assert [c["case_id"] for c in body["gets_it"]] == ["c-0001"]
    gets = body["gets_it"][0]
    assert gets["case_number"] == "CASE-000001" and gets["title"] == "Case c-0001"
    assert gets["explanation"]["tier"] == 3
    assert {"criterion": "rule_ids", "value": ["acme_rule"]} in gets["explanation"]["matched"]
    assert [(c["case_id"], c["winner_id"]) for c in body["another_wins"]] == [("c-0002", BASE_BUILTIN)]
    assert body["another_wins"][0]["winner_title"] == "Brute force and password spray"
    near = {c["case_id"]: c for c in body["near_misses"]}
    assert set(near) == {"c-0003"}
    assert [f["criterion"] for f in near["c-0003"]["failed"]] == ["entity_types"]
    assert near["c-0003"]["failed"][0]["expected"] == ["ip"]
    assert body["counts"] == {"gets_it": 1, "another_wins": 1, "near_misses": 1}
    assert body["truncated"] is False


def test_the_preview_changes_nothing_and_calls_no_model(box) -> None:
    client, state = box["client"], box["state"]
    before = kv_snapshot(state)
    _post(client, {"definition": _preview_definition()})
    _post(client, {"source": source(PREVIEWED, applies_when={"rule_ids": ["acme_rule"]})})
    assert kv_snapshot(state) == before
    assert box["mock"].calls == []


def test_a_stored_runbook_is_previewed_by_id(box) -> None:
    client = box["client"]
    create(client, PREVIEWED, applies_when={"rule_ids": ["acme_rule", "sshd"], "entity_types": ["ip"]},
           priority=10)
    by_id = _post(client, {"id": PREVIEWED})
    assert [c["case_id"] for c in by_id["gets_it"]] == ["c-0001"]
    built_in = _post(client, {"id": BASE_BUILTIN})
    assert [c["case_id"] for c in built_in["gets_it"]] == ["c-0002"]
    missing = client.post("/api/runbooks/match-preview", json={"id": "nope"})
    assert missing.status_code == 404


def test_a_copy_that_replaces_a_built_in_is_previewed_in_its_place(box) -> None:
    client = box["client"]
    copy_id = client.post(f"/api/runbooks/{BASE_BUILTIN}/duplicate").json()["summary"]["id"]
    # The copy's rules equal the built-in's; once published the built-in stops matching,
    # so the preview shows the copy getting the sshd case rather than losing it.
    body = _post(client, {"id": copy_id})
    assert [c["case_id"] for c in body["gets_it"]] == ["c-0002"]
    assert body["another_wins"] == []


def test_the_fallback_gets_only_what_nothing_else_matched(box) -> None:
    body = _post(box["client"], {"id": "generic-incident"})
    gets = {c["case_id"] for c in body["gets_it"]}
    assert gets == {"c-0001", "c-0003", "c-0005"}  # sshd goes to brute force
    assert all(c["explanation"]["tier"] == 0 for c in body["gets_it"])


def test_the_population_is_the_last_500_cases_and_lists_stop_at_50() -> None:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        seed_cases(client, holder["state"], [
            make_case(f"m-{i:04d}", hours_ago=1 + i / 100, rule_ids=["acme_rule"]) for i in range(505)
        ])
        body = _post(client, {"definition": _preview_definition()})
    assert body["considered"] == 500
    assert body["window_label"] == "The last 500 cases of the last 30 days"
    assert body["counts"]["gets_it"] == 500 and len(body["gets_it"]) == 50 and body["truncated"] is True
    # Newest first: the oldest five are the ones left out.
    assert body["gets_it"][0]["case_id"] == "m-0000"


def test_bad_bodies_are_refused(box) -> None:
    client = box["client"]
    both = client.post("/api/runbooks/match-preview", json={"definition": _preview_definition(), "source": "x"})
    assert both.status_code == 422
    nothing = client.post("/api/runbooks/match-preview", json={})
    assert nothing.status_code == 422
    old = client.post("/api/runbooks/match-preview", json={"id": "x", "content": "y"})
    assert old.status_code == 410 and old.json()["code"] == "runbooks_moved"


def test_row_level_scope_hides_the_preview(box, monkeypatch) -> None:
    import app.engine.chat_starters as starters

    monkeypatch.setattr(starters, "object_scoped", lambda _state, _role: True)
    response = box["client"].post("/api/runbooks/match-preview", json={"definition": _preview_definition()})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "runbook_scope_unsupported"


def test_the_preview_needs_cases_read_as_well_as_runbooks_read() -> None:
    holder: dict[str, Any] = {}
    rbac = {"denies": {"auditor": {"cases": ["read"]}}}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True, rbac=rbac)) as client:
        add_user(client, "auditor", "auditor")
        add_user(client, "tier1", "analyst_tier1")
        login(client, "auditor", "user-pass-12345")
        assert client.post("/api/runbooks/match-preview", json={"id": BASE_BUILTIN}).status_code == 403
        login(client, "tier1", "user-pass-12345")
        assert client.post("/api/runbooks/match-preview", json={"id": BASE_BUILTIN}).status_code == 200


def test_a_read_only_viewer_previews_the_live_version_not_the_draft() -> None:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True)) as client:
        add_user(client, "manager", "soc_manager")
        add_user(client, "tier1", "analyst_tier1")
        seed_cases(client, holder["state"], [make_case("v-0001", rule_ids=["acme_rule"]),
                                             make_case("v-0002", rule_ids=["beta_rule"])])
        login(client, "manager", "user-pass-12345")
        made = create(client, PREVIEWED, applies_when={"rule_ids": ["acme_rule"]})
        live = client.post(f"/api/runbooks/{PREVIEWED}/publish", json={
            "version": 1, "expected_revision": made["revision"], "content_hash": made["draft"]["content_hash"],
        }).json()
        client.put(f"/api/runbooks/{PREVIEWED}/draft", json={
            "definition": definition(PREVIEWED, applies_when={"rule_ids": ["beta_rule"]}),
            "expected_revision": live["revision"],
        })
        manager_view = _post(client, {"id": PREVIEWED})
        assert [c["case_id"] for c in manager_view["gets_it"]] == ["v-0002"]
        login(client, "tier1", "user-pass-12345")
        reader_view = _post(client, {"id": PREVIEWED})
        assert [c["case_id"] for c in reader_view["gets_it"]] == ["v-0001"]
