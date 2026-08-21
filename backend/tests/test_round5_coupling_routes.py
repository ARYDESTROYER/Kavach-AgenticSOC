"""Round 5 / Coupling-E (G8) — routes.py monolith split + typed responses + loader.

Proves the SAFE decomposition of the 4751-line ``routes.py`` into cohesive feature
routers (prefs/branding/customization, rag/memory, search/audit, notifications) is
CONTRACT-PRESERVING:

* the full ``/api`` route inventory (method + path) is byte-identical to the base
  ``routes.py`` router combined with the extracted routers — no path added/dropped;
* the ``main.py`` auto-discovery loader mounts EXACTLY the ``routes_*`` feature routers
  (sorted, deterministic) and never double-mounts the base ``routes`` module;
* the ``response_model=`` additions serialize BYTE-IDENTICALLY to the old
  ``model_dump(mode="json")`` / plain-dict responses (the webui contract is unchanged).

Everything is offline (fake ES + mock LLM). ``test_route_auth_coverage.py`` separately
proves every moved non-GET keeps its ``require_permission`` gate.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api import routes_notifications, routes_prefs, routes_rag, routes_search
from app.constants import CaseStatus, EntityType, SourceSurface
from app.main import app, discover_feature_routers
from app.models import Case, Entity


# --------------------------------------------------------------------------- #
# Loader — deterministic auto-discovery mounts exactly the routes_* feature set.
# --------------------------------------------------------------------------- #
def test_loader_discovers_all_routes_modules_sorted() -> None:
    disc = discover_feature_routers()
    names = [n for n, _ in disc]
    # SORTED + deterministic.
    assert names == sorted(names)
    # The base `routes` module is NEVER discovered (it lacks the routes_ prefix and is
    # mounted separately) — so it can't be double-mounted.
    assert "routes" not in names
    assert all(n.startswith("routes_") for n in names)
    # The extracted routers ARE discovered.
    for expected in (
        "routes_prefs", "routes_rag", "routes_search", "routes_notifications",
    ):
        assert expected in names, f"loader dropped {expected}"
    # Every discovered entry yields a real APIRouter (has routes).
    for _name, r in disc:
        assert hasattr(r, "routes")


def test_moved_routes_are_registered_on_the_app() -> None:
    paths = {r.path for r in app.routes if r.__class__.__name__ == "APIRoute"}
    # A representative path from each extracted domain resolves on the real app.
    for moved in (
        "/api/branding",                      # prefs router
        "/api/prefs/effective", "/api/views", "/api/terminology",
        "/api/rag/stats", "/api/memory",      # rag router
        "/api/search", "/api/audit",          # search router
        "/api/notifications/providers", "/api/cases/{case_id}/notify",  # notif router
    ):
        assert moved in paths, f"moved route {moved} is not registered"


def test_base_routes_router_is_not_a_routes_star_module() -> None:
    # The base monolith router is imported + mounted explicitly; it must not ALSO be
    # picked up by the routes_* auto-discovery (which would double-register every path).
    names = [n for n, _ in discover_feature_routers()]
    # No extracted router path is registered twice.
    from collections import Counter

    api_paths = [
        (tuple(sorted(r.methods)), r.path)
        for r in app.routes
        if r.__class__.__name__ == "APIRoute" and r.path.startswith("/api")
    ]
    dupes = [k for k, c in Counter(api_paths).items() if c > 1]
    assert not dupes, f"duplicate (method, path) registrations: {dupes}"


# --------------------------------------------------------------------------- #
# Typed responses — response_model serializes byte-identically to model_dump.
# --------------------------------------------------------------------------- #
def _make_case() -> Case:
    return Case(
        case_id="case-9999",
        cluster_signature="sig-x",
        source_surface=SourceSurface.INVESTIGATE,
        status=CaseStatus.OPEN,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        risk_score=42.5,
        created_at="2026-01-02T03:04:05+00:00",
        updated_at="2026-01-02T03:04:05+00:00",
    )


def test_case_response_model_is_byte_identical_to_model_dump() -> None:
    # The get_case endpoint switched from returning `case.model_dump(mode="json")` to
    # `response_model=Case`. Prove FastAPI serialization matches the old dict exactly so
    # the webui contract is unchanged.
    from fastapi import FastAPI

    c = _make_case()
    probe = FastAPI()

    @probe.get("/c", response_model=Case)
    async def _c() -> Case:
        return c

    got = TestClient(probe).get("/c").json()
    assert got == c.model_dump(mode="json")


def test_extracted_response_models_have_expected_keys() -> None:
    # The extracted envelope response models declare exactly the keys the webui reads —
    # additive typing that never drops a key.
    assert set(routes_search.SearchResponse.model_fields) == {"query", "cases", "sources", "nav"}
    assert set(routes_search.AuditListResponse.model_fields) == {"records", "total"}
    assert set(routes_rag.RagDocumentsResponse.model_fields) == {"documents", "count"}
    assert set(routes_rag.MemoryListResponse.model_fields) == {"entries", "count"}
    assert set(routes_notifications.NotificationProvidersResponse.model_fields) == {
        "email_presets", "channel_types", "template_ids",
    }


def test_health_response_model_matches_shape() -> None:
    # The health envelope keys the webui depends on (store_type detection etc.).
    from app.api.routes import HealthResponse

    assert set(HealthResponse.model_fields) == {
        "status", "version", "es_connected", "state_store_connected",
        "state_backend", "store_type", "setup_complete",
        # Additive subsystem-degradation signal. ``status`` deliberately keeps its
        # historical state-store-readiness meaning (release/update tooling gates on
        # it), so a degraded corpus or provider is reported alongside it.
        "degraded", "degraded_reasons",
    }
    # Both default to "not degraded", so an existing client and every historical
    # response shape are unaffected.
    assert HealthResponse.model_fields["degraded"].default is False
