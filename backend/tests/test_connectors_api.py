"""API tests for the connector registry + multi-source wizard endpoints."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.es.fake import InMemoryESClient
from app.state import AppState


@pytest.fixture
def client(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def test_list_connectors_exposes_pull_and_push(client):
    r = client.get("/api/connectors")
    assert r.status_code == 200
    conns = {c["source_type"]: c for c in r.json()["connectors"]}
    # pull SIEMs + universal push transports are all discoverable for the wizard
    for expected in ("elasticsearch", "opensearch", "webhook", "syslog", "kafka", "s3"):
        assert expected in conns, f"{expected} missing from connector list"
    elastic = conns["elasticsearch"]
    assert "pull" in elastic["ingest_modes"]
    auth_keys = {f["key"] for f in elastic["auth_fields"]}
    assert {"es_url", "es_api_key"} <= auth_keys
    # the api_key field must be flagged secret (UI shows configured-only)
    assert next(f for f in elastic["auth_fields"] if f["key"] == "es_api_key")["secret"] is True


def test_get_connector_manifest_and_404(client):
    r = client.get("/api/connectors/elasticsearch")
    assert r.status_code == 200
    assert r.json()["display_name"]
    assert client.get("/api/connectors/not-a-real-source").status_code == 404


def test_connector_test_uses_live_primary(client):
    # The fake ES pings True, so the wired primary source tests OK.
    r = client.post("/api/connectors/test", json={})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_connector_test_uses_exact_draft_without_persisting(client, monkeypatch):
    state = client.app.state.tlsoc
    draft_es = InMemoryESClient()
    draft_es.add_log(
        "draft-events-2026",
        {"@timestamp": "2026-07-11T12:00:00Z", "message": "draft sample"},
        "draft-1",
    )
    captured = {}

    def client_for_source(source):
        captured["source"] = source
        return draft_es, False

    monkeypatch.setattr(state, "es_client_for_source", client_for_source)
    before_sources = list(state.prefs.sources)
    before_secrets = dict(state.secrets.connector_secrets)

    response = client.post(
        "/api/connectors/test",
        json={
            "source_type": "elasticsearch",
            "config": {"data_view_pattern": "draft-events-*"},
            "secrets": {"es_api_key": "request-only-key"},
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["sample_count"] == 1
    assert captured["source"].config["data_view_pattern"] == "draft-events-*"
    assert captured["source"].config["es_api_key"] == "request-only-key"
    assert state.prefs.sources == before_sources
    assert state.secrets.connector_secrets == before_secrets


def test_connector_test_push_receiver_is_honestly_unsupported(client):
    response = client.post(
        "/api/connectors/test",
        json={"source_type": "webhook", "config": {"auth_mode": "none"}},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["mode"] == "push"
    assert response.json()["detail"]["supported"] is False


def test_source_crud_roundtrip(client):
    assert client.get("/api/sources").json()["sources"] == []

    body = {
        "id": "elk-prod",
        "source_type": "elasticsearch",
        "display_name": "Prod ELK",
        "is_primary": True,
        "config": {"data_view_pattern": "all-logs-*"},
    }
    r = client.post("/api/sources", json=body)
    assert r.status_code == 200
    sources = r.json()["sources"]
    assert len(sources) == 1
    assert sources[0]["id"] == "elk-prod" and sources[0]["is_primary"] is True
    assert sources[0]["ingest_mode"] == "pull"  # defaulted from the manifest

    # adding a second primary unsets the first
    r2 = client.post("/api/sources", json={
        "id": "os-dev", "source_type": "opensearch", "is_primary": True,
    })
    by_id = {s["id"]: s for s in r2.json()["sources"]}
    assert by_id["os-dev"]["is_primary"] is True
    assert by_id["elk-prod"]["is_primary"] is False

    # delete
    assert client.delete("/api/sources/elk-prod").status_code == 200
    remaining = {s["id"] for s in client.get("/api/sources").json()["sources"]}
    assert remaining == {"os-dev"}
    assert client.delete("/api/sources/does-not-exist").status_code == 404


def test_upsert_rejects_unknown_source_type(client):
    r = client.post("/api/sources", json={"id": "x", "source_type": "frobnicator"})
    assert r.status_code == 400


def test_upsert_preserves_configured_secrets_and_created_at(client):
    """Regression (validation F1/F2): a bare re-upsert — the Enabled toggle / bulk
    enable-disable / make-primary path — must NOT wipe the source's `configured_secrets`
    NAMES or reset its `created_at`. `SourceUpsert` carries neither field, so `upsert_source`
    carries them forward from the existing source; without that fix every toggle emptied the
    secret-name list (the "N secrets" subline + delete warning) and re-stamped the creation
    date, which the new Log Sources table surfaces as an Enabled toggle + a Creation Date col."""
    body = {
        "id": "elk-x",
        "source_type": "elasticsearch",
        "display_name": "ELK",
        "enabled": True,
        "config": {},
    }
    assert client.post("/api/sources", json=body).status_code == 200

    # record a secret NAME on the source (values go to the in-memory secret tier)
    r = client.post("/api/sources/elk-x/secrets", json={"es_api_key": "s3cr3t"})
    assert r.status_code == 200 and r.json()["configured_secrets"] == ["es_api_key"]
    created0 = next(
        s for s in client.get("/api/sources").json()["sources"] if s["id"] == "elk-x"
    )["created_at"]

    # a bare re-upsert that does NOT re-send the secret (an enable/disable toggle)
    r2 = client.post("/api/sources", json={**body, "enabled": False})
    assert r2.status_code == 200
    src = next(s for s in r2.json()["sources"] if s["id"] == "elk-x")
    assert src["configured_secrets"] == ["es_api_key"]  # secret-name metadata survives (F1)
    assert src["created_at"] == created0  # creation date unchanged (F2)
    assert src["enabled"] is False


def test_upsert_carries_forward_declared_severity_scale_max(client):
    """Regression: a bare re-upsert must NOT wipe the DECLARED severity-ladder ceiling.

    `severity_scale_max` is set from the source editor, but the Enabled toggle / bulk
    enable-disable / make-primary paths post a body WITHOUT it — exactly the shape that
    silently emptied `configured_secrets` before Round 9. Wiping the ceiling would
    re-band every one of that source's cases against the 100 identity, so omission must
    carry the stored value forward while an explicit `null` still clears it on purpose.
    """
    body = {
        "id": "sev-x",
        "source_type": "elasticsearch",
        "display_name": "ELK",
        "enabled": True,
        "config": {},
    }
    # declare a native 0-10 ladder
    r = client.post("/api/sources", json={**body, "severity_scale_max": 10})
    assert r.status_code == 200
    src = next(s for s in r.json()["sources"] if s["id"] == "sev-x")
    assert src["severity_scale_max"] == 10.0

    # a bare re-upsert (enable/disable toggle) OMITS the key -> the declaration survives
    r2 = client.post("/api/sources", json={**body, "enabled": False})
    assert r2.status_code == 200
    src2 = next(s for s in r2.json()["sources"] if s["id"] == "sev-x")
    assert src2["severity_scale_max"] == 10.0
    assert src2["enabled"] is False

    # an EXPLICIT null is a deliberate clear -> undeclared (identity projection)
    r3 = client.post("/api/sources", json={**body, "severity_scale_max": None})
    assert r3.status_code == 200
    src3 = next(s for s in r3.json()["sources"] if s["id"] == "sev-x")
    assert src3["severity_scale_max"] is None

    # a non-positive ceiling can never divide -> rejected at the API boundary
    assert client.post(
        "/api/sources", json={**body, "severity_scale_max": 0}
    ).status_code == 422
    assert client.post(
        "/api/sources", json={**body, "severity_scale_max": -5}
    ).status_code == 422
    # ...and so is a NON-FINITE one. `1e309` is a legal JSON number that parses to `inf`,
    # which passes every `> 0` test, divides without raising, would read every severity
    # from this source as Informational while still calling the band source-asserted, and
    # would re-serialize into the stored config as the non-standard token `Infinity`.
    # (the literal is spliced in as TEXT: Python's own json encoder refuses to emit it)
    overflowing = json.dumps(body)[:-1] + ', "severity_scale_max": 1e309}'
    assert client.post(
        "/api/sources", content=overflowing,
        headers={"Content-Type": "application/json"},
    ).status_code == 422
    # the earlier explicit clear is still what is stored — nothing leaked through
    after = client.get("/api/sources").json()["sources"]
    assert next(s for s in after if s["id"] == "sev-x")["severity_scale_max"] is None


def test_upsert_seeds_then_respects_declared_ceiling(client):
    """A connector we ship knowledge of is SEEDED with a ceiling the operator may edit.

    The seed is written into the source's own editable field at creation (never consulted
    as a runtime per-vendor branch), and a declaration always wins over it."""
    r = client.post("/api/sources", json={
        "id": "wz-1", "source_type": "wazuh", "config": {},
    })
    assert r.status_code == 200
    seeded = next(s for s in r.json()["sources"] if s["id"] == "wz-1")
    assert seeded["severity_scale_max"] == 16.0

    r2 = client.post("/api/sources", json={
        "id": "wz-2", "source_type": "wazuh", "config": {}, "severity_scale_max": 15,
    })
    assert r2.status_code == 200
    declared = next(s for s in r2.json()["sources"] if s["id"] == "wz-2")
    assert declared["severity_scale_max"] == 15.0


def test_pull_secret_rotation_rebuilds_live_clients(client, monkeypatch):
    """A pull key saved after source upsert must affect the live poller immediately."""
    state = client.app.state.tlsoc
    created = client.post(
        "/api/sources",
        json={
            "id": "rotating-pull",
            "source_type": "elasticsearch",
            "is_primary": True,
            "config": {"data_view_pattern": "rotating-*"},
        },
    )
    assert created.status_code == 200

    observed: list[dict[str, str]] = []

    def client_for_source(source):
        observed.append(dict(state.secrets.source_secrets(source.id)))
        return InMemoryESClient(), False

    monkeypatch.setattr(state, "es_client_for_source", client_for_source)
    rotated = client.post(
        "/api/sources/rotating-pull/secrets",
        json={"es_api_key": "rotated-key"},
    )

    assert rotated.status_code == 200
    assert observed and observed[-1]["es_api_key"] == "rotated-key"
