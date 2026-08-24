"""API contract tests for the isolated five-source native Demo Mode.

These tests stay at the public route boundary: source identity, live health,
coverage, bounded browsing, unified provenance, secret non-disclosure, and teardown
isolation. Native rendering/parser details belong to ``test_demo_native_sources.py``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from app.config import DemoConfig


SOURCE_CONTRACT = {
    "demo-splunk": ("splunk", "push_http", "HEC / HTTPS", "Splunk HEC JSON"),
    "demo-qradar": ("qradar", "push_http", "LEEF 2.0 + REST", "LEEF 2.0 events"),
    "demo-wazuh": ("wazuh", "push_http", "Wazuh JSON", "archives.json events"),
    "demo-syslog": ("syslog", "push_syslog", "RFC 5424 / RFC 3164", "RFC 5424"),
    "demo-entra-id": (
        "sentinel", "push_http", "Microsoft Graph / HTTPS", "Entra ID auditLogs/signIns",
    ),
}


def test_demo_mutations_use_the_dedicated_manage_permission() -> None:
    from app.api.routes import router

    expected = {
        "/api/demo/enable", "/api/demo/reset", "/api/demo/disable",
        "/api/demo/incident",
    }
    seen: set[str] = set()
    for route in router.routes:
        if getattr(route, "path", "") not in expected:
            continue
        if "POST" not in getattr(route, "methods", set()):
            continue
        grants: set[tuple[str, str]] = set()
        for dependency in route.dependant.dependencies:
            call = dependency.call
            cells = {
                name: cell.cell_contents
                for name, cell in zip(
                    (
                        getattr(call, "__code__", None).co_freevars
                        if hasattr(call, "__code__") else ()
                    ),
                    getattr(call, "__closure__", None) or (),
                )
            }
            if "resource" in cells and "action" in cells:
                grants.add((str(cells["resource"]), str(cells["action"])))
        assert ("demo", "manage") in grants, route.path
        seen.add(route.path)
    assert seen == expected

    status_route = next(
        route for route in router.routes
        if getattr(route, "path", "") == "/api/demo/status"
    )
    grants: set[tuple[str, str]] = set()
    for dependency in status_route.dependant.dependencies:
        call = dependency.call
        cells = {
            name: cell.cell_contents
            for name, cell in zip(
                getattr(getattr(call, "__code__", None), "co_freevars", ()),
                getattr(call, "__closure__", None) or (),
            )
        }
        if "resource" in cells and "action" in cells:
            grants.add((str(cells["resource"]), str(cells["action"])))
    assert ("demo", "read") in grants


def _enable_seeded(client):
    response = client.post(
        "/api/demo/enable",
        json={"mode": "seeded", "seed": 1337, "history_days": 2},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_demo_enable_rejects_typos_and_unbounded_public_work(client) -> None:
    assert client.post("/api/demo/enable", json={"mode": "lvie"}).status_code == 422
    for field, value in (
        ("tick_seconds", 61),
        ("tick_jitter", 1.01),
        ("incident_rate", 1.01),
        ("alert_interval_seconds", 3601),
        ("event_rate_per_second", 201),
        ("preseed_event_count", 2001),
    ):
        response = client.post("/api/demo/enable", json={field: value})
        assert response.status_code == 422, (field, response.text)

    # Persisted pre-hardening documents remain loadable; request bounds and the
    # simulator's per-tick cap protect new work without breaking upgrades.
    legacy = DemoConfig.model_validate({
        "tick_seconds": 300,
        "alert_interval_seconds": 7200,
        "event_rate_per_second": 500,
    })
    assert legacy.tick_seconds == 300
    assert legacy.alert_interval_seconds == 7200
    assert legacy.event_rate_per_second == 500


def test_demo_source_api_is_absent_off_demo(client) -> None:
    sources = client.get("/api/sources")
    assert sources.status_code == 200
    assert not any(row.get("demo") for row in sources.json()["sources"])

    health = client.get("/api/sources/health")
    assert health.status_code == 200
    assert not any(row.get("demo") for row in health.json()["sources"])

    coverage = client.get("/api/sources/coverage")
    assert coverage.status_code == 200
    # Off-demo response remains the existing six-field contract byte-for-byte.
    assert set(coverage.json()) == {
        "sources_total", "sources_enabled", "sources_silent", "events_per_min",
        "alerts_triaged_24h", "worst_last_event_seconds",
    }
    assert coverage.json()["sources_total"] == 0

    unified = client.get("/api/logs")
    assert unified.status_code == 200
    # Off demo with no configured sources: nothing to fan out over. The envelope also
    # carries the additive honest-bound fields (R12) — the effective cap and a
    # `truncated` flag — so a caller can say "most recent N" rather than "everything".
    assert unified.json() == {
        "logs": [], "count": 0, "sources": [], "partial": False,
        "limit": 100, "truncated": False,
    }
    for source_id in SOURCE_CONTRACT:
        assert client.get(f"/api/sources/{source_id}/logs").status_code == 404
    assert client.get("/api/sources/demo/logs").status_code == 404


def test_demo_sources_health_and_coverage_are_truthful(client) -> None:
    status = _enable_seeded(client)
    assert status["sources"] == list(SOURCE_CONTRACT)
    assert {row["source_id"] for row in status["source_activity"]} == set(SOURCE_CONTRACT)

    listed = client.get("/api/sources")
    assert listed.status_code == 200, listed.text
    rows = {row["id"]: row for row in listed.json()["sources"] if row.get("demo")}
    assert set(rows) == set(SOURCE_CONTRACT)
    for source_id, (source_type, mode, protocol, format_fragment) in SOURCE_CONTRACT.items():
        row = rows[source_id]
        assert row["source_type"] == source_type
        assert row["ingest_mode"] == mode
        assert row["protocol"] == protocol
        assert format_fragment in row["format"]
        assert row["config"] == {"protocol": protocol, "format": row["format"]}
        assert row["configured_secrets"] == []
        assert row["can_browse"] is True

    health_response = client.get("/api/sources/health")
    assert health_response.status_code == 200, health_response.text
    health = {
        row["source_id"]: row
        for row in health_response.json()["sources"]
        if row.get("demo")
    }
    assert set(health) == set(SOURCE_CONTRACT)
    for source_id, (source_type, mode, protocol, format_fragment) in SOURCE_CONTRACT.items():
        row = health[source_id]
        assert row["source_type"] == source_type
        assert row["ingest_mode"] == mode
        assert row["kind"] == "push"
        assert row["protocol"] == protocol and format_fragment in row["format"]
        assert row["can_browse"] is True
        assert row["healthy"] is True and row["state"] == "static"
        assert row["events_received"] >= 12
        assert row["buffer_depth"] >= 12
        assert row["last_event_millis"] > 0
        assert row["events_per_min"] == 0
        # Health is an operational projection, never a secret/config dump (#10).
        assert not any("secret" in key or "api_key" in key for key in row)

    coverage = client.get("/api/sources/coverage")
    assert coverage.status_code == 200, coverage.text
    data = coverage.json()
    assert data["demo"] is True
    assert data["sources_total"] == data["sources_enabled"] == 5
    assert data["sources_silent"] == 0
    assert data["events_per_min"] == 0
    assert data["alerts_triaged_24h"] > 0
    assert data["worst_last_event_seconds"] >= 0


def test_demo_per_source_and_unified_logs_are_bounded_and_provenanced(client) -> None:
    _enable_seeded(client)
    assert client.get("/api/sources/demo/logs").status_code == 404

    for source_id in SOURCE_CONTRACT:
        response = client.get(f"/api/sources/{source_id}/logs?limit=5")
        assert response.status_code == 200, (source_id, response.text)
        data = response.json()
        assert data["source_id"] == source_id
        # A demo adapter runs a REAL filtered search over its ring (the query/window
        # below demonstrably apply), so the honest mode is "search", not "buffer".
        assert data["mode"] == "search"
        assert 0 < data["count"] <= 5
        assert data["total"] >= data["count"]
        assert all(row["source_id"] == source_id for row in data["logs"])
        assert all(row["source_name"] and isinstance(row["_raw"], dict) for row in data["logs"])
        assert all(row["message"] for row in data["logs"])

        # The real SourceLogsSheet sends ES-style date math, not ISO timestamps.
        # Keep the demo adapter aligned with every production StructuredQuery caller.
        ranged = client.get(
            f"/api/sources/{source_id}/logs",
            params={"limit": 5, "from": "now-15m", "to": "now"},
        )
        assert ranged.status_code == 200, (source_id, ranged.text)
        assert 0 < ranged.json()["count"] <= 5

        empty = client.get(
            f"/api/sources/{source_id}/logs",
            params={"limit": 5, "query": "definitely-not-in-a-demo-record"},
        )
        assert empty.status_code == 200 and empty.json()["logs"] == []

    unified = client.get("/api/logs?limit=100")
    assert unified.status_code == 200, unified.text
    data = unified.json()
    assert data["partial"] is False
    assert 0 < data["count"] <= 100
    assert {row["source_id"] for row in data["sources"]} == set(SOURCE_CONTRACT)
    assert {row["source_id"] for row in data["logs"]} == set(SOURCE_CONTRACT)
    assert all(row["source_name"] for row in data["logs"])
    timestamps = [row["ts"] for row in data["logs"]]
    assert timestamps == sorted(timestamps, reverse=True)


def test_demo_browse_reports_the_honest_mode_and_the_filters_it_applies(client) -> None:
    """Regression: a demo adapter was badged ``mode="buffer"`` on both browse routes,
    and the contract defines "buffer" as a ring where ``from``/``to``/``query`` are
    IGNORED. Its read is a real filtered search over that ring — the filters
    demonstrably apply below — so the honest mode is "search". ``mode`` describes the
    filters, never the durability of the backing store."""
    _enable_seeded(client)
    source_id = next(iter(SOURCE_CONTRACT))

    baseline = client.get(f"/api/sources/{source_id}/logs?limit=100").json()
    assert baseline["mode"] == "search"
    assert baseline["count"] > 0

    # The `query` filter really applies...
    empty = client.get(
        f"/api/sources/{source_id}/logs",
        params={"limit": 100, "query": "definitely-not-in-a-demo-record"},
    ).json()
    assert empty["mode"] == "search" and empty["count"] == 0 and empty["logs"] == []
    # ...and so does the time window (a year-old window matches nothing).
    narrowed = client.get(
        f"/api/sources/{source_id}/logs",
        params={"limit": 100, "from": "now-52w", "to": "now-51w"},
    ).json()
    assert narrowed["mode"] == "search" and narrowed["count"] == 0

    # The unified fan-out reports the same honest mode for EVERY demo target, and the
    # very same filters cut the merged result.
    unified = client.get("/api/logs?limit=100").json()
    assert {row["mode"] for row in unified["sources"]} == {"search"}
    assert unified["count"] > 0
    filtered = client.get(
        "/api/logs", params={"limit": 100, "query": "definitely-not-in-a-demo-record"},
    ).json()
    assert filtered["count"] == 0
    assert {row["mode"] for row in filtered["sources"]} == {"search"}
    ranged = client.get(
        "/api/logs", params={"limit": 100, "from": "now-52w", "to": "now-51w"},
    ).json()
    assert ranged["count"] == 0


def test_demo_overlay_never_queries_persists_or_discloses_tenant_data(
    client, monkeypatch,
) -> None:
    assert client.post("/api/sources", json={
        "id": "real-webhook",
        "source_type": "webhook",
        "display_name": "Real tenant webhook",
        "enabled": True,
    }).status_code == 200
    secret_value = "TOP-SECRET-DEMO-ISOLATION-SENTINEL"
    saved = client.post(
        "/api/sources/real-webhook/secrets", json={"webhook_token": secret_value},
    )
    assert saved.status_code == 200, saved.text

    before = client.get("/api/sources").json()["sources"]
    real_before = next(row for row in before if row["id"] == "real-webhook")
    assert real_before["configured_secrets"] == ["webhook_token"]
    assert secret_value not in json.dumps(before)

    _enable_seeded(client)
    during = client.get("/api/sources").json()["sources"]
    assert {row["id"] for row in during} == set(SOURCE_CONTRACT)
    assert all(row.get("demo") for row in during)
    assert secret_value not in json.dumps(during)
    # Every default source read is deliberately demo-scoped while active; the real
    # connector/config is neither shown nor invoked.
    assert client.get("/api/sources/coverage").json()["sources_total"] == 5

    def _real_read_would_be_a_bug(*_args, **_kwargs):
        raise AssertionError("a real source was queried while Demo Mode was active")

    monkeypatch.setattr(
        client.app.state.tlsoc.ingest_service,
        "recent_events_for_source",
        _real_read_would_be_a_bug,
    )
    hidden = client.get("/api/sources/real-webhook/logs")
    assert hidden.status_code == 404
    unified = client.get("/api/logs?limit=100")
    assert unified.status_code == 200, unified.text
    assert {row["source_id"] for row in unified.json()["sources"]} == set(SOURCE_CONTRACT)
    # The optional `source_id` scope obeys the SAME isolation: a demo adapter is
    # readable, and a real tenant id is indistinguishable from an unknown one (404) so
    # the demo session never confirms that a live source exists behind it.
    demo_id = next(iter(SOURCE_CONTRACT))
    scoped = client.get("/api/logs", params={"limit": 10, "source_id": demo_id})
    assert scoped.status_code == 200, scoped.text
    assert {row["source_id"] for row in scoped.json()["sources"]} == {demo_id}
    assert scoped.json()["sources"][0]["mode"] == "search"
    assert client.get(
        "/api/logs", params={"source_id": "real-webhook"},
    ).status_code == 404
    assert client.get("/api/logs", params={"source_id": "nope"}).status_code == 404

    disabled = client.post("/api/demo/disable")
    assert disabled.status_code == 200, disabled.text
    after = client.get("/api/sources").json()["sources"]
    assert not any(row.get("demo") for row in after)
    real_after = next(row for row in after if row["id"] == "real-webhook")
    assert real_after["configured_secrets"] == ["webhook_token"]
    assert secret_value not in json.dumps(after)
    for source_id in SOURCE_CONTRACT:
        assert client.get(f"/api/sources/{source_id}/logs").status_code == 404


def test_manual_demo_incident_is_cooldown_aware_audited_and_isolated(client) -> None:
    assert client.post("/api/demo/incident").status_code == 409
    status = _enable_seeded(client)
    assert status["ticking"] is False

    first = client.post("/api/demo/incident", json={})
    assert first.status_code == 200, first.text
    result = first.json()
    assert result["triggered"] is True
    assert result["scenario_id"] and result["scenario_name"]
    assert result["events"] >= 8
    assert result["native_alerts"] == 4
    assert set(result["sources"]) == {"splunk", "qradar", "wazuh", "syslog", "entra"}
    assert {
        row["source_id"] for row in result["sources"].values()
    } == set(SOURCE_CONTRACT)

    # Seeded/manual controls share a simulator, so an immediate repeat cannot bypass
    # the runtime's cooldown by constructing a fresh control object.
    second = client.post("/api/demo/incident", json={})
    assert second.status_code == 200
    assert second.json()["triggered"] is False
    assert second.json()["cooldown_seconds"] > 0

    health = {
        row["source_id"]: row
        for row in client.get("/api/sources/health").json()["sources"]
    }
    assert health["demo-splunk"]["alerts_emitted"] >= 1
    assert health["demo-qradar"]["alerts_emitted"] >= 1
    assert health["demo-wazuh"]["alerts_emitted"] >= 1
    assert health["demo-entra-id"]["alerts_emitted"] >= 1
    assert health["demo-syslog"]["alerts_emitted"] == 0
    assert health["demo-syslog"]["system_detections_total"] >= 1

    # Invalid source-controlled scenario ids are rejected by the request contract.
    assert client.post(
        "/api/demo/incident", json={"scenario_id": "<script>"},
    ).status_code == 422

    assert client.post("/api/demo/disable").status_code == 200
    audit = client.get("/api/audit", params={"surface": "demo", "limit": 20})
    assert audit.status_code == 200, audit.text
    assert any(
        "demo incident trigger triggered=True" in row.get("result_summary", "")
        for row in audit.json()["records"]
    )
    summaries = [row.get("result_summary", "") for row in audit.json()["records"]]
    assert any(summary.startswith("demo enabled mode=seeded") for summary in summaries)
    assert any(summary.startswith("demo disabled run_id=") for summary in summaries)
    cases = client.get("/api/cases?limit=200")
    assert cases.status_code == 200
    assert not any(
        str(row.get("case_id", "")).startswith("demo-")
        for row in cases.json()["cases"]
    )


def test_demo_never_dispatches_external_enrichment(client, monkeypatch) -> None:
    calls: list[str] = []

    async def forbidden(*args, **kwargs):
        calls.append(str(args[0] if args else "unknown"))
        raise AssertionError("demo attempted external enrichment")

    monkeypatch.setattr("app.tools.enrich._dispatch_enrich", forbidden)
    _enable_seeded(client)
    state = client.app.state.tlsoc
    assert state.prefs.enrichment.enabled is True
    assert state.execution_prefs.enrichment.enabled is False

    incident = client.post(
        "/api/demo/incident", json={"scenario_id": "phishing_chain"},
    )
    assert incident.status_code == 200, incident.text
    overview = client.post(
        "/api/overview",
        json={"source": {"source": {"ip": "8.8.8.8"}, "message": "demo event"}},
    )
    assert overview.status_code == 200, overview.text
    assert calls == []


def test_demo_capability_stores_are_visible_through_public_routes(client) -> None:
    from app.api.routes_campaigns import router as campaigns_router
    from app.api.routes_tuning import router as tuning_router

    client.app.include_router(campaigns_router)
    client.app.include_router(tuning_router)
    _enable_seeded(client)
    proposals = client.get("/api/proposals")
    campaigns = client.get("/api/campaigns")
    tuning = client.get("/api/tuning/recommendations")
    assert proposals.status_code == 200, proposals.text
    assert campaigns.status_code == 200, campaigns.text
    assert tuning.status_code == 200, tuning.text
    assert proposals.json()["count"] > 0
    assert campaigns.json()["total"] > 0
    assert len(tuning.json()["applied"]) > 0

    # A decision updates only the throwaway proposal store. The real queue remains
    # empty and returns after exit.
    proposal_id = proposals.json()["proposals"][0]["id"]
    approved = client.post(f"/api/proposals/{proposal_id}/approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["proposal"]["status"] == "approved"
    assert client.app.state.tlsoc.real_proposals is not client.app.state.tlsoc.proposals
    assert client.portal.call(client.app.state.tlsoc.real_proposals.list) == []

    assert client.post("/api/demo/disable").status_code == 200
    assert client.get("/api/proposals").json()["count"] == 0
    assert client.get("/api/campaigns").json()["total"] == 0


def test_demo_batch_surface_hides_real_jobs_and_sandboxes_config(client) -> None:
    from app.api.routes_batch import router as batch_router
    from app.models import BatchJob

    client.app.include_router(batch_router)
    state = client.app.state.tlsoc
    original_floor = state.prefs.batch.severity_floor
    awaitable(
        client,
        state.real_batch_job_store.save,
        BatchJob(id="batch-real-hidden", provider="openai", model="gpt-test"),
    )

    _enable_seeded(client)
    jobs = client.get("/api/batch/jobs")
    config = client.get("/api/batch/config")
    assert jobs.status_code == 200 and jobs.json() == {"jobs": [], "count": 0}
    assert config.status_code == 200 and config.json()["config"]["enabled"] is True

    demo_floor = 6 if original_floor != 6 else 5
    changed = client.put("/api/batch/config", json={"severity_floor": demo_floor})
    assert changed.status_code == 200, changed.text
    assert client.get("/api/batch/config").json()["config"]["severity_floor"] == demo_floor
    assert state.prefs.batch.severity_floor == original_floor
    assert awaitable(client, state.real_audit.records, surface="batch", limit=20) == []
    assert len(awaitable(client, state.audit.records, surface="batch", limit=20)) == 1

    assert client.post("/api/demo/disable").status_code == 200
    restored = client.get("/api/batch/jobs").json()
    assert restored["count"] == 1
    assert restored["jobs"][0]["id"] == "batch-real-hidden"
    assert client.get("/api/batch/config").json()["config"]["severity_floor"] == original_floor


def test_demo_case_notify_never_dispatches_real_channels(client, monkeypatch) -> None:
    _enable_seeded(client)
    case_id = client.get("/api/cases?limit=1").json()["cases"][0]["case_id"]

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("demo case attempted a real notification dispatch")

    monkeypatch.setattr(client.app.state.tlsoc.notifications, "dispatch", forbidden)
    response = client.post(
        f"/api/cases/{case_id}/notify", json={"channel_id": None},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "ok": False,
        "sent": [],
        "simulated": True,
        "detail": "Demo mode is active — outbound case notifications are disabled.",
    }


def test_demo_case_lifecycle_keeps_notifications_and_rag_isolated(client, monkeypatch) -> None:
    _enable_seeded(client)
    state = client.app.state.tlsoc
    rows = client.get("/api/cases?limit=200").json()["cases"]
    case = next(
        row for row in rows
        if row["status"] in {"new", "open", "investigating", "escalated", "on_hold"}
    )

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("demo lifecycle attempted a real notification")

    monkeypatch.setattr(state.notifications, "dispatch", forbidden)
    real_before = awaitable(client, state.rag.list_documents)
    response = client.post(
        f"/api/cases/{case['case_id']}/action",
        json={"action": "close", "note": "synthetic resolution"},
    )
    assert response.status_code == 200, response.text
    real_after = awaitable(client, state.rag.list_documents)
    assert real_after == real_before
    assert state.rag_service is not state.rag


def test_real_http_ingest_survives_demo_teardown(client) -> None:
    created = client.post(
        "/api/sources",
        json={"id": "real-ingest", "source_type": "webhook", "config": {}},
    )
    assert created.status_code == 200, created.text
    _enable_seeded(client)

    now = datetime.now(timezone.utc).isoformat()
    alerts = [
        {
            "src_ip": "203.0.113.211",
            "user": "real-sender",
            "severity": "high",
            "signature": "real_alert_during_demo",
            "@timestamp": now,
            "id": f"real-demo-boundary-{idx}",
        }
        for idx in range(6)
    ]
    accepted = client.post("/api/ingest/real-ingest", json=alerts)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["received"] == 6
    # The active demo view remains isolated, so the real entity is intentionally hidden.
    assert not any(
        row["entity"]["value"] == "203.0.113.211"
        for row in client.get("/api/cases?limit=200").json()["cases"]
    )

    assert client.post("/api/demo/disable").status_code == 200
    assert any(
        row["entity"]["value"] == "203.0.113.211"
        for row in client.get("/api/cases?limit=200").json()["cases"]
    )


def test_demo_selected_source_chat_and_investigate_are_truthful(client) -> None:
    _enable_seeded(client)
    state = client.app.state.tlsoc
    qradar = client.get("/api/sources/demo-qradar/logs?limit=1").json()["logs"][0]

    state._demo._provider.push("chat", json.dumps({
        "answer": "Fetching QRadar records.",
        "needs_query": True,
        "query": {"rule": qradar["rule"], "time_from": "now-24h", "time_to": "now"},
    }))
    state._demo._provider.push("chat", json.dumps({
        "answer": "Analysed the selected QRadar feed.",
        "needs_query": False,
    }))
    chat = client.post("/api/chat", json={
        "message": "Show this QRadar rule", "source_id": "demo-qradar",
    })
    assert chat.status_code == 200, chat.text
    assert chat.json()["table"] is not None
    columns = chat.json()["table"]["columns"]
    rule_idx = columns.index("rule")
    assert all(
        row[rule_idx] == qradar["rule"] for row in chat.json()["table"]["rows"]
    )

    investigated = client.post("/api/investigate", json={
        "source_id": "demo-qradar",
        "entity": {"type": "ip", "value": qradar["source_ip"]},
    })
    assert investigated.status_code == 200, investigated.text
    assert investigated.json()["source_id"] == "demo-qradar"
    assert investigated.json()["entity"]["value"] == qradar["source_ip"]

    missing = client.post("/api/investigate", json={
        "source_id": "demo-qradar",
        "entity": {"type": "ip", "value": "203.0.113.254"},
    })
    assert missing.status_code == 400
    assert "No events found" in str(missing.json()["detail"])


def awaitable(client, func, *args, **kwargs):
    """Call one async store method on TestClient's owning event-loop portal."""
    if kwargs:
        async def invoke_with_kwargs():
            return await func(*args, **kwargs)

        return client.portal.call(invoke_with_kwargs)
    return client.portal.call(func, *args, **kwargs)
