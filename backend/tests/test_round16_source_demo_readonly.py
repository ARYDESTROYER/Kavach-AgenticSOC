"""Round 16 B43 (SPEC §3.2, §4.5 WP15E): the Demo overlay sources are read-only.

While Demo Mode is on, ``GET /api/sources`` lists only the Demo overlay rows. The setup
wizard used to offer Make primary, Edit and Remove on them, and ``POST /api/sources``
accepted the overlay row it sent: a real, enabled source with Demo-only config landed in
the live configuration, hidden until Demo Mode was turned off. The server now answers
``409 source_demo_readonly`` for a write to a Demo overlay id while Demo is active, on
``POST /api/sources``, ``DELETE /api/sources/{id}`` and ``POST /api/sources/{id}/secrets``.
Real-source adds stay allowed, and the refusal applies only while Demo is active.
"""

from __future__ import annotations

from typing import Any


def _enable_seeded(client) -> None:
    response = client.post(
        "/api/demo/enable",
        json={"mode": "seeded", "seed": 1337, "history_days": 2},
    )
    assert response.status_code == 200, response.text


def _live_sources(client) -> list[dict[str, Any]]:
    """The stored live source configuration, exactly as saved."""
    return [s.model_dump(mode="json") for s in client.app.state.tlsoc.prefs.sources]


def _source_rows(client) -> list[dict[str, Any]]:
    return client.portal.call(
        lambda: client.app.state.tlsoc.control_audit.records(limit=1000)
    )


def _wizard_make_primary_body(row: dict[str, Any]) -> dict[str, Any]:
    """The exact body the wizard's Make primary button sends for a listed row."""
    return {
        "id": row["id"],
        "source_type": row["source_type"],
        "display_name": row.get("display_name"),
        "enabled": row.get("enabled", True),
        "is_primary": True,
        "ingest_mode": row.get("ingest_mode"),
        "config": row.get("config") or {},
    }


def _assert_demo_readonly(response) -> None:
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "source_demo_readonly"
    assert detail["message"] == "Demo Mode manages this source. Turn Demo Mode off to change it."


def test_a_write_to_a_demo_overlay_id_is_refused_and_live_sources_are_unchanged(client) -> None:
    added = client.post(
        "/api/sources",
        json={"id": "real-webhook", "source_type": "webhook", "display_name": "Real webhook"},
    )
    assert added.status_code == 200, added.text
    before = _live_sources(client)

    _enable_seeded(client)
    overlay = client.get("/api/sources").json()["sources"]
    assert overlay and all(row.get("demo") is True for row in overlay)

    for row in overlay:
        _assert_demo_readonly(client.post("/api/sources", json=_wizard_make_primary_body(row)))
        # The wizard's Edit saves the same row with its own fields; the id alone decides.
        _assert_demo_readonly(client.post("/api/sources", json={
            "id": row["id"], "source_type": "webhook", "display_name": "Edited",
        }))
        _assert_demo_readonly(client.delete(f"/api/sources/{row['id']}"))
        _assert_demo_readonly(
            client.post(f"/api/sources/{row['id']}/secrets", json={"webhook_token": "t0ken"})
        )
        assert client.app.state.tlsoc.secrets.source_secrets(row["id"]) == {}

    # Nothing reached the live configuration while Demo was on, and no write was audited.
    assert _live_sources(client) == before
    demo_ids = {row["id"] for row in overlay}
    assert not [
        r for r in _source_rows(client)
        if str(r.get("action", "")).startswith("source.")
        and (r.get("target") or {}).get("id") in demo_ids
    ]

    disabled = client.post("/api/demo/disable")
    assert disabled.status_code == 200, disabled.text
    assert _live_sources(client) == before
    assert {row["id"] for row in client.get("/api/sources").json()["sources"]} == {"real-webhook"}


def test_real_source_writes_stay_allowed_while_demo_is_active(client) -> None:
    _enable_seeded(client)

    created = client.post(
        "/api/sources",
        json={"id": "lab-webhook", "source_type": "webhook", "display_name": "Lab webhook"},
    )
    assert created.status_code == 200, created.text
    secrets = client.post("/api/sources/lab-webhook/secrets", json={"webhook_token": "t0ken"})
    assert secrets.status_code == 200, secrets.text
    assert any(s["id"] == "lab-webhook" for s in _live_sources(client))
    deleted = client.delete("/api/sources/lab-webhook")
    assert deleted.status_code == 200, deleted.text
    assert not any(s["id"] == "lab-webhook" for s in _live_sources(client))

    assert client.post("/api/demo/disable").status_code == 200


def test_the_refusal_applies_only_while_demo_is_active(client) -> None:
    # With Demo off, an id that happens to match an overlay id is an ordinary source id.
    created = client.post(
        "/api/sources",
        json={"id": "demo-wazuh", "source_type": "webhook", "display_name": "Named like Demo"},
    )
    assert created.status_code == 200, created.text
    assert client.delete("/api/sources/demo-wazuh").status_code == 200
