"""Round 5 audit C1/H1 — the server↔client widget-type ALLOWLIST contract + round-trips.

C1 was a shipping regression: the server ``WIDGET_TYPES`` frozenset and the client
``registry.ts`` ``WidgetType`` union were authored independently and drifted, so EVERY
Edit→Save of a real (client-built) dashboard 400'd in ``_clean_widget``. H1 was the
gap that hid it: no test crossed the two allowlists (backend tests used server-only
types the UI can't emit; webui tests used only client types).

This module closes both:

* CONTRACT — the server ``WIDGET_TYPES`` frozenset EXACTLY equals the committed
  canonical set (``webui/src/soc/dashboard/widget-types.contract.json``), the same file
  the webui contract test pins the client registry to. A one-sided widget addition fails
  CI on whichever side forgot to update.
* ROUND-TRIP — every REAL client widget type POSTs through ``POST /api/dashboards`` and
  gets a 200 (never a 400 from the allowlist). This is the end-to-end proof C1 asked for.
* ROLE-DEFAULT — a full super_admin role-default dashboard (the set most likely to be
  100%-rejected at the time of C1) POSTs 200.
* ENDPOINT — ``GET /api/dashboards/widget-types`` returns the same canonical set.

Fully offline (fake ES + mock LLM); no network, no live server.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes_dashboards import WIDGET_TYPES, router as dashboards_router
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

# The committed single source of truth both allowlists pin to (repo-root relative:
# backend/tests/<file> → parents[2] == repo root).
_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "webui"
    / "src"
    / "soc"
    / "dashboard"
    / "widget-types.contract.json"
)


def _canonical_types() -> set[str]:
    data = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    return set(data["widget_types"])


# --------------------------------------------------------------------------- #
# CONTRACT — the server frozenset EXACTLY equals the canonical committed set
# --------------------------------------------------------------------------- #
def test_server_allowlist_matches_canonical_contract() -> None:
    """The server ``WIDGET_TYPES`` must be byte-for-byte the canonical set (C1/H1).

    If this fails, the server allowlist drifted from the committed contract; the webui
    ``dashboard-widget-types.contract.test.ts`` guards the client registry against the
    SAME file, so between the two, the server and client can never silently diverge."""
    canonical = _canonical_types()
    server = set(WIDGET_TYPES)
    assert server == canonical, (
        "server WIDGET_TYPES diverged from the canonical contract — "
        f"server-only={sorted(server - canonical)} contract-only={sorted(canonical - server)}"
    )


def test_contract_file_is_the_expected_twenty_five() -> None:
    """A tripwire so adding/removing a widget forces a conscious update of the contract
    (and thus both allowlists). Mirrors the webui contract test's expected list. Round 14
    (SPEC §4.4.3) added the sixteen modules of the built-in boards."""
    assert _canonical_types() == {
        "kpi.needs_human",
        "kpi.cost_budget",
        "chart.verdict_mix",
        "chart.autonomous_vs_human",
        "kpi.lifecycle_timing",
        "table.connector_health",
        "table.recent_cases",
        "mitre.heatmap",
        "gauge.active_risk",
        # Round 14
        "kpi.strip",
        "kpi.auto_close_health",
        "kpi.agent_quality",
        "chart.case_trend",
        "chart.case_breakdown",
        "chart.severity_trend",
        "chart.backlog_aging",
        "chart.noise_funnel",
        "table.attention_queue",
        "table.workload",
        "table.sla_breaches",
        "table.top_rules",
        "table.noisy_rules",
        "table.top_techniques",
        "table.campaigns",
        "table.telemetry_gaps",
    }


def test_contract_file_lists_each_type_once() -> None:
    """A duplicate in the committed list could hide a one-sided divergence."""
    data = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    assert len(data["widget_types"]) == len(set(data["widget_types"]))


def test_every_client_registry_entry_matches_the_contract() -> None:
    """The client union in ``registry.ts`` names exactly the contract set (the webui
    contract test checks the runtime registry; this reads the source so a backend-only
    run also catches a one-sided edit of the union)."""
    import re

    registry = (_CONTRACT_PATH.parent / "registry.ts").read_text(encoding="utf-8")
    union = registry.split("export type WidgetType =", 1)[1].split(";", 1)[0]
    assert set(re.findall(r"\|\s*'([a-z_.]+)'", union)) == _canonical_types()


# --------------------------------------------------------------------------- #
# Harness — auth OFF (shared 'default' bucket), like test_round5_dashboards_routes
# --------------------------------------------------------------------------- #
@pytest.fixture
def client():
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
        )
        mock = MockProvider()
        overrides = {"anthropic": mock, "openai": mock, "mock": mock}
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(dashboards_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        yield c


def _widget(i: str, type: str, **kw: Any) -> dict[str, Any]:
    w = {"i": i, "type": type, "x": 0, "y": 0, "w": 4, "h": 4}
    w.update(kw)
    return w


# --------------------------------------------------------------------------- #
# ROUND-TRIP — every REAL client widget type POSTs 200 (the C1 end-to-end proof)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("wtype", sorted(_canonical_types()))
def test_each_client_widget_type_posts_200(client, wtype: str) -> None:
    """Each widget type the UI can actually build must survive the server allowlist —
    the exact write path C1 broke (every Save 400'd)."""
    body = {"name": f"board-{wtype}", "widgets": [_widget("w1", wtype)]}
    r = client.post("/api/dashboards", json=body)
    assert r.status_code == 200, f"{wtype} was rejected: {r.text}"
    assert r.json()["widgets"][0]["type"] == wtype


def test_a_full_client_dashboard_of_all_types_posts_200(client) -> None:
    """A single dashboard placing EVERY real widget type at once round-trips (no widget
    aborts the whole PUT/POST as C1's ``_sanitize_layout`` iteration did)."""
    widgets = [_widget(f"w{n}", t, y=n) for n, t in enumerate(sorted(_canonical_types()))]
    r = client.post("/api/dashboards", json={"name": "everything", "widgets": widgets})
    assert r.status_code == 200, r.text
    stored = {w["type"] for w in r.json()["widgets"]}
    assert stored == _canonical_types()


# --------------------------------------------------------------------------- #
# ROLE-DEFAULT — the super_admin default set (100%-rejected at C1) POSTs 200
# --------------------------------------------------------------------------- #
def test_super_admin_role_default_dashboard_posts_200(client) -> None:
    """The super_admin role default (``ROLE_DEFAULT_WIDGETS.super_admin`` in registry.ts)
    was entirely rejected by the pre-fix server allowlist. It must POST 200 now."""
    super_admin_default = [
        "kpi.cost_budget", "table.connector_health", "kpi.needs_human", "kpi.lifecycle_timing",
    ]
    widgets = [_widget(f"w{n}", t, y=n) for n, t in enumerate(super_admin_default)]
    r = client.post("/api/dashboards", json={"name": "Admin default", "widgets": widgets})
    assert r.status_code == 200, r.text
    assert [w["type"] for w in r.json()["widgets"]] == super_admin_default


# --------------------------------------------------------------------------- #
# ENDPOINT — GET /api/dashboards/widget-types returns the canonical set
# --------------------------------------------------------------------------- #
def test_widget_types_endpoint_returns_the_canonical_set(client) -> None:
    r = client.get("/api/dashboards/widget-types")
    assert r.status_code == 200, r.text
    assert set(r.json()["widget_types"]) == _canonical_types()
