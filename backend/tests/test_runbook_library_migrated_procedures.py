"""``GET /api/runbooks`` carries ``migrated_procedures`` (Round 14 FX3b2, SPEC
§4.10.16, §4.10.17 step 6).

The library response maps each retired procedure id to the runbook id the one-shot
migration gave it, read from the migration marker through
``runbook_migration.migrated_procedure_ids``: the same map a "Run a runbook"
automation rule saved with a retired procedure id resolves through at fire time. Only
the procedure sources are in it (the configured folder and the stored procedure
documents, never the reference runbooks), a stored procedure that carried a retired
bundled id is left out, the read is fail-soft and it sits under the existing
``runbooks:read`` gate. It follows the library's visibility rule: a reader without
``runbooks:manage`` or ``runbooks:publish`` gets only the entries whose runbook it may
see, so a legacy procedure migrated as a Draft is never disclosed to it. Offline, on
the in-memory store.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.engine.runbook_migration import (
    LEGACY_BUNDLED_PLAYBOOK_IDS,
    NS_PROCEDURE_DIR,
    NS_PROCEDURES,
    NS_REFERENCE,
    migrated_procedure_ids,
)
from app.models import RunbookLibrary
from app.state import AppState
from app.stores.runbook_library import RunbookMigrationCounts, RunbookMigrationMarker

from tests.test_runbook_library_api import add_user, auth_secrets, create, login, make_app, publish

BUNDLED = sorted(LEGACY_BUNDLED_PLAYBOOK_IDS)[0]
ID_MAP = {
    f"{NS_PROCEDURES}:acme_vpn_lockout": "acme_vpn_lockout",
    f"{NS_PROCEDURE_DIR}:ransom_note": "ransom_note-imported",
    # A stored procedure document with a retired bundled id never ran from a rule.
    f"{NS_PROCEDURES}:{BUNDLED}": f"{BUNDLED}-imported",
    # A reference runbook is never a rule's target.
    f"{NS_REFERENCE}:phishing_reference": "phishing_reference-reference",
}
EXPECTED = {"acme_vpn_lockout": "acme_vpn_lockout", "ransom_note": "ransom_note-imported"}


def _write_marker(client: TestClient, state: AppState, id_map: dict[str, str]) -> None:
    async def run() -> None:
        library = state.runbook_library
        current = await library.read_marker()
        marker = RunbookMigrationMarker(
            completed_at="2026-10-28T09:00:00+00:00",
            counts=RunbookMigrationCounts(published=2, draft=1, skipped=0),
            id_map=id_map, projection_generation="gen-1",
            projection_completed_at="2026-10-28T09:00:05+00:00",
        )
        await library.write_marker(marker, expected_revision=current.revision if current is not None else None)

    client.portal.call(run)


@pytest.fixture
def box() -> Any:
    holder: dict[str, Any] = {}
    with TestClient(make_app(holder)) as client:
        holder["client"] = client
        yield holder


def test_a_library_without_migrated_procedures_answers_an_empty_map(box) -> None:
    body = box["client"].get("/api/runbooks").json()
    RunbookLibrary.model_validate(body)
    assert body["migrated_procedures"] == {}


def test_the_map_holds_the_procedure_sources_from_the_marker(box) -> None:
    _write_marker(box["client"], box["state"], ID_MAP)
    body = box["client"].get("/api/runbooks").json()
    assert body["migrated_procedures"] == EXPECTED
    # The same function the automation resolves through, so the two never disagree.
    assert body["migrated_procedures"] == migrated_procedure_ids({"id_map": ID_MAP})
    assert body["migration"]["published"] == 2 and body["migration"]["draft"] == 1


def test_the_map_ignores_the_list_filters(box) -> None:
    _write_marker(box["client"], box["state"], ID_MAP)
    body = box["client"].get("/api/runbooks", params={"q": "no runbook is called this", "origin": "imported"}).json()
    assert body["runbooks"] == []
    assert body["migrated_procedures"] == EXPECTED


def test_an_unreadable_marker_reads_as_an_empty_map_and_the_library_still_lists(box, monkeypatch) -> None:
    _write_marker(box["client"], box["state"], ID_MAP)

    async def broken() -> None:
        raise RuntimeError("store unavailable")

    monkeypatch.setattr(box["state"].runbook_library, "read_marker", broken)
    response = box["client"].get("/api/runbooks")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["migrated_procedures"] == {}
    assert body["migration"] is None
    assert len(body["runbooks"]) == 12


def test_the_published_schema_declares_a_map_of_strings() -> None:
    schema = RunbookLibrary.model_json_schema()
    field = schema["properties"]["migrated_procedures"]
    assert field["type"] == "object" and field["additionalProperties"] == {"type": "string"}
    assert "migrated_procedures" not in schema.get("required", [])


def test_a_reader_gets_only_the_targets_it_may_see_and_no_session_gets_nothing() -> None:
    """FX3b2 review: the map follows the library's visibility rule (SPEC §4.10.15). A
    legacy procedure the migration stored as a Draft (``<id>-imported``, §4.10.17), or
    an id that names no runbook any more, is never disclosed to a reader without
    ``runbooks:manage`` or ``runbooks:publish``; a Published runbook and a built-in are."""
    holder: dict[str, Any] = {}
    id_map = {
        **ID_MAP,
        f"{NS_PROCEDURE_DIR}:old_bruteforce": "brute-force-password-spray",
        f"{NS_PROCEDURES}:gone_procedure": "gone-runbook",
    }
    with TestClient(make_app(holder, secrets=auth_secrets(), auth=True)) as client:
        add_user(client, "tier1", "analyst_tier1")
        add_user(client, "auditor", "auditor")
        add_user(client, "manager", "soc_manager")
        login(client, "manager", "user-pass-12345")
        create(client, "acme_vpn_lockout")
        publish(client, "acme_vpn_lockout")
        create(client, "ransom_note-imported")  # a Draft, as a procedure that failed validation is stored
        _write_marker(client, holder["state"], id_map)
        manager = client.get("/api/runbooks").json()
        assert manager["migrated_procedures"] == {
            **EXPECTED, "old_bruteforce": "brute-force-password-spray", "gone_procedure": "gone-runbook",
        }
        assert "ransom_note-imported" in {r["id"] for r in manager["runbooks"]}

        client.post("/api/auth/logout")
        assert client.get("/api/runbooks").status_code == 401
        for user in ("tier1", "auditor"):
            login(client, user, "user-pass-12345")
            response = client.get("/api/runbooks")
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["migrated_procedures"] == {
                "acme_vpn_lockout": "acme_vpn_lockout", "old_bruteforce": "brute-force-password-spray",
            }
            # The Draft is hidden from the list and from the map alike.
            assert "ransom_note-imported" not in {r["id"] for r in body["runbooks"]}
            assert "ransom_note-imported" not in response.text and "gone-runbook" not in response.text
