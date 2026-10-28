"""Round 5 / G7 (CD5) — custom-dashboard persistence routes (offline, fake ES + mock LLM).

Locks the ``routes_dashboards`` feature router so it cannot regress:

* CRUD round-trip — create / list / update / clone / remove — persisted per-user.
* Server-side widget-type ALLOWLIST — an unknown ``type`` is a hard 400 (never stored).
* NAME validation — a control-character / over-length name is rejected (#9).
* Coord clamp — an out-of-grid placement is clamped into the 12-column grid.
* Never-raise — a malformed store read degrades to a safe empty list.
* Per-user isolation (auth ON) — one user cannot see/mutate another's dashboards.
* Caps — the per-user dashboard limit is enforced; the widgets/dashboard cap is a 400.

NON-NEGOTIABLES exercised: #3 (a dashboard is advisory presentation state — nothing here
calls ``decide()``), #9 (widget type allowlist + plain-name validation), never-raise on
reads, bounded writes. Fully network-free.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as main_router
from app.api.routes_dashboards import (
    _MAX_DASHBOARDS_PER_USER,
    _MAX_WIDGETS_PER_DASHBOARD,
    router as dashboards_router,
)
from app.config import CustomizationConfig, Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState


# --------------------------------------------------------------------------- #
# Payload helpers
# --------------------------------------------------------------------------- #
def _widget(i: str = "w1", type: str = "kpi.needs_human", **kw: Any) -> dict[str, Any]:
    # Default to a REAL client-registry widget type (the ones the UI actually emits).
    # Using a server-only type here would pass the allowlist but never exercise a widget
    # the client can build — the exact gap that hid audit C1.
    w = {"i": i, "type": type, "x": 0, "y": 0, "w": 4, "h": 4}
    w.update(kw)
    return w


def _layout(name: str = "My board", *, id: str | None = None, widgets=None, **kw: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name, "widgets": widgets if widgets is not None else [_widget()]}
    if id is not None:
        body["id"] = id
    body.update(kw)
    return body


# --------------------------------------------------------------------------- #
# Harness — auth OFF (the default): all requests map to the shared 'default' bucket.
# --------------------------------------------------------------------------- #
@pytest.fixture
def client():
    holder: dict[str, Any] = {}

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
        holder["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(dashboards_router, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        c.state_holder = holder  # type: ignore[attr-defined]
        yield c


# --------------------------------------------------------------------------- #
# CRUD round-trip — create / list / update / remove
# --------------------------------------------------------------------------- #
def test_create_list_update_remove_roundtrip(client) -> None:
    # Empty to start.
    r0 = client.get("/api/dashboards")
    assert r0.status_code == 200
    assert r0.json()["dashboards"] == []

    # Create.
    r1 = client.post("/api/dashboards", json=_layout("Board A"))
    assert r1.status_code == 200, r1.text
    created = r1.json()
    did = created["id"]
    assert created["name"] == "Board A"
    assert len(created["widgets"]) == 1
    assert created["widgets"][0]["type"] == "kpi.needs_human"
    assert created["schema_version"] == 1

    # List reflects the create.
    lst = client.get("/api/dashboards").json()["dashboards"]
    assert len(lst) == 1 and lst[0]["id"] == did

    # Update (PUT, path id authoritative) — rename + add a widget.
    upd = _layout("Board A renamed", id=did, widgets=[
        _widget("w1"), _widget("w2", "chart.verdict_mix", x=4),
    ])
    r2 = client.put(f"/api/dashboards/{did}", json=upd)
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["id"] == did
    assert body["name"] == "Board A renamed"
    assert len(body["widgets"]) == 2

    # Still exactly one dashboard (replace, not add).
    assert len(client.get("/api/dashboards").json()["dashboards"]) == 1

    # Remove.
    rd = client.request("DELETE", f"/api/dashboards/{did}")
    assert rd.status_code == 200
    assert rd.json() == {"ok": True, "id": did}
    assert client.get("/api/dashboards").json()["dashboards"] == []

    # Deleting again → 404.
    assert client.request("DELETE", f"/api/dashboards/{did}").status_code == 404


def test_put_path_id_overrides_body_id(client) -> None:
    """The PUT path id is authoritative — a body carrying a different id is coerced."""
    created = client.post("/api/dashboards", json=_layout("X")).json()
    did = created["id"]
    r = client.put(f"/api/dashboards/{did}", json=_layout("X2", id="dash-attacker-supplied"))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == did
    # Only one dashboard exists (no phantom 'dash-attacker-supplied' created).
    ids = {b["id"] for b in client.get("/api/dashboards").json()["dashboards"]}
    assert ids == {did}


# --------------------------------------------------------------------------- #
# Clone — copies into the caller's set under a fresh id
# --------------------------------------------------------------------------- #
def test_clone_creates_a_fresh_copy(client) -> None:
    src = client.post("/api/dashboards", json=_layout("Original")).json()
    src_id = src["id"]

    r = client.post(f"/api/dashboards/{src_id}/clone")
    assert r.status_code == 200, r.text
    clone = r.json()
    assert clone["id"] != src_id
    assert clone["name"] == "Original (copy)"
    assert len(clone["widgets"]) == len(src["widgets"])

    # Both now exist.
    assert len(client.get("/api/dashboards").json()["dashboards"]) == 2

    # Cloning an unknown id → 404.
    assert client.post("/api/dashboards/dash-nope/clone").status_code == 404


def test_clone_from_org_role_default(client) -> None:
    """A read-only org/role DEFAULT (CustomizationConfig.default_dashboards) can be
    cloned into the caller's personal set (clone-to-customize)."""
    state: AppState = client.state_holder["state"]  # type: ignore[attr-defined]
    default_layout = {
        "id": "dash-role-default", "name": "Role default", "schema_version": 1,
        "columns": 12,
        "widgets": [_widget("w1", "kpi.lifecycle_timing"), _widget("w2", "mitre.heatmap", x=4)],
    }
    cust = CustomizationConfig(default_dashboards={"analyst": default_layout})
    client.portal.call(  # type: ignore[attr-defined]
        lambda: state.update_prefs(state.prefs.model_copy(update={"customization": cust}))
    )

    # It is NOT in the caller's personal set yet.
    assert client.get("/api/dashboards").json()["dashboards"] == []
    # Clone the role default by its id.
    r = client.post("/api/dashboards/dash-role-default/clone")
    assert r.status_code == 200, r.text
    clone = r.json()
    assert clone["id"] != "dash-role-default"
    assert clone["name"] == "Role default (copy)"
    assert {w["type"] for w in clone["widgets"]} == {"kpi.lifecycle_timing", "mitre.heatmap"}
    assert len(client.get("/api/dashboards").json()["dashboards"]) == 1


# --------------------------------------------------------------------------- #
# Widget-type ALLOWLIST — an unknown type is a hard 400 (#9)
# --------------------------------------------------------------------------- #
def test_unknown_widget_type_rejected_on_create(client) -> None:
    bad = _layout("Bad", widgets=[_widget("w1", "kpi.needs_human"), _widget("w2", "evil.exfil")])
    r = client.post("/api/dashboards", json=bad)
    assert r.status_code == 400, r.text
    assert "unknown widget type" in r.json()["detail"].lower()
    # Nothing was stored.
    assert client.get("/api/dashboards").json()["dashboards"] == []


def test_unknown_widget_type_rejected_on_update(client) -> None:
    did = client.post("/api/dashboards", json=_layout("Good")).json()["id"]
    r = client.put(f"/api/dashboards/{did}", json=_layout("Good", id=did, widgets=[_widget("w1", "not.a.widget")]))
    assert r.status_code == 400
    assert "unknown widget type" in r.json()["detail"].lower()
    # The original dashboard is untouched (still 1 good widget).
    stored = client.get("/api/dashboards").json()["dashboards"][0]
    assert stored["widgets"][0]["type"] == "kpi.needs_human"


# --------------------------------------------------------------------------- #
# NAME validation — control chars / over-length are rejected (#9)
# --------------------------------------------------------------------------- #
def test_control_char_name_rejected(client) -> None:
    r = client.post("/api/dashboards", json=_layout("evil\nname\r</text>"))
    assert r.status_code == 400, r.text
    assert "control character" in r.json()["detail"].lower()


def test_over_length_name_rejected(client) -> None:
    r = client.post("/api/dashboards", json=_layout("A" * 300))
    assert r.status_code == 400
    assert "too long" in r.json()["detail"].lower()


def test_widget_title_control_char_rejected(client) -> None:
    """A control char smuggled into a widget option ``title`` is rejected too (#9)."""
    bad = _layout("ok", widgets=[_widget("w1", options={"title": "line1\nline2"})])
    r = client.post("/api/dashboards", json=bad)
    assert r.status_code == 400
    assert "control character" in r.json()["detail"].lower()


# --------------------------------------------------------------------------- #
# Coord clamp — an out-of-grid placement is clamped into the 12-column grid
# --------------------------------------------------------------------------- #
def test_out_of_grid_coords_are_clamped(client) -> None:
    wide = _layout("wide", widgets=[_widget("w1", "kpi.needs_human", x=99, y=-5, w=99, h=-3)])
    r = client.post("/api/dashboards", json=wide)
    assert r.status_code == 200, r.text
    w = r.json()["widgets"][0]
    assert w["w"] == 12            # clamped to the 12-column width
    assert 0 <= w["x"] <= 12 - w["w"]
    assert w["x"] == 0             # x can't push a full-width widget off-canvas
    assert w["y"] == 0             # negative y clamped up
    assert w["h"] >= 1             # negative height clamped to the minimum


# --------------------------------------------------------------------------- #
# Caps — per-user dashboard limit + widgets/dashboard cap
# --------------------------------------------------------------------------- #
def test_widgets_per_dashboard_cap(client) -> None:
    too_many = [_widget(f"w{n}", "kpi.needs_human") for n in range(_MAX_WIDGETS_PER_DASHBOARD + 1)]
    r = client.post("/api/dashboards", json=_layout("huge", widgets=too_many))
    assert r.status_code == 400
    assert "too many widgets" in r.json()["detail"].lower()


def test_dashboards_per_user_cap(client) -> None:
    for n in range(_MAX_DASHBOARDS_PER_USER):
        assert client.post("/api/dashboards", json=_layout(f"b{n}")).status_code == 200
    # One over the cap → 400.
    over = client.post("/api/dashboards", json=_layout("over"))
    assert over.status_code == 400
    assert "limit reached" in over.json()["detail"].lower()


# --------------------------------------------------------------------------- #
# Never-raise on a malformed store read — degrades to an empty list, not a 500
# --------------------------------------------------------------------------- #
def test_list_never_raises_on_store_error(client, monkeypatch) -> None:
    state: AppState = client.state_holder["state"]  # type: ignore[attr-defined]

    async def _boom(_user):
        raise RuntimeError("kv exploded")

    monkeypatch.setattr(state.dashboards, "list_for_user", _boom)
    r = client.get("/api/dashboards")
    assert r.status_code == 200
    assert r.json() == {"dashboards": []}


# --------------------------------------------------------------------------- #
# Auth ON — per-user isolation: one user cannot see/mutate another's dashboards
# --------------------------------------------------------------------------- #
def _auth_client():
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="dash-test-secret", auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    # Mount the MAIN router too so /api/auth/login + /api/users are available.
    api.include_router(main_router, dependencies=[Depends(require_auth)])
    api.include_router(dashboards_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c, username, password):
    return c.post("/api/auth/login", json={"username": username, "password": password})


def test_per_user_isolation_auth_on() -> None:
    with _auth_client() as c:
        _login(c, "Admin", "Admin@123")
        # Admin creates a second, non-admin user.
        r = c.post("/api/users", json={
            "username": "bob", "password": "bob-pass-12", "role": UserRole.ANALYST_TIER1.value,
        })
        assert r.status_code == 200, r.text

        # Admin saves a dashboard.
        admin_board = c.post("/api/dashboards", json=_layout("Admin board")).json()
        assert c.get("/api/dashboards").status_code == 200
        assert len(c.get("/api/dashboards").json()["dashboards"]) == 1

        # Bob logs in — sees NONE of Admin's dashboards.
        c.cookies.clear()
        _login(c, "bob", "bob-pass-12")
        assert c.get("/api/dashboards").json()["dashboards"] == []

        # Bob creates his own.
        bob_board = c.post("/api/dashboards", json=_layout("Bob board")).json()
        assert len(c.get("/api/dashboards").json()["dashboards"]) == 1
        assert bob_board["id"] != admin_board["id"]

        # Bob cannot delete Admin's dashboard (it isn't in his set → 404).
        assert c.request("DELETE", f"/api/dashboards/{admin_board['id']}").status_code == 404

        # Admin logs back in — still has exactly his own board, untouched by Bob.
        c.cookies.clear()
        _login(c, "Admin", "Admin@123")
        admin_boards = c.get("/api/dashboards").json()["dashboards"]
        assert len(admin_boards) == 1 and admin_boards[0]["id"] == admin_board["id"]


def test_non_get_route_rejected_when_auth_on_without_token() -> None:
    """Deny-by-default: a write route is 401'd with auth ON and no token presented."""
    with _auth_client() as c:
        # No cookie / bearer → 401 on reads and writes alike.
        assert c.get("/api/dashboards").status_code == 401
        assert c.post("/api/dashboards", json=_layout("x")).status_code == 401
        assert c.put("/api/dashboards/dash-1", json=_layout("x", id="dash-1")).status_code == 401
        assert c.request("DELETE", "/api/dashboards/dash-1").status_code == 401
        assert c.post("/api/dashboards/dash-1/clone").status_code == 401


# --------------------------------------------------------------------------- #
# Round 14 (SPEC §2.2 item 4, §4.4.1): reserved ids, default_window, derived_from
# --------------------------------------------------------------------------- #
def _stored_ids(client) -> set[str]:
    return {b["id"] for b in client.get("/api/dashboards").json()["dashboards"]}


def _seed(client, board_id: str, name: str = "Older board") -> None:
    """Store a board directly, as a release before Round 14 could have (free-string id)."""
    from app.models import DashboardLayout, DashboardWidget

    state: AppState = client.state_holder["state"]  # type: ignore[attr-defined]
    layout = DashboardLayout(
        id=board_id, name=name,
        widgets=[DashboardWidget(i="w1", type="kpi.needs_human", x=0, y=0, w=4, h=4)],
    )
    client.portal.call(lambda: state.dashboards.save("default", layout))  # type: ignore[attr-defined]


@pytest.mark.parametrize("board_id", [
    "new", "builtin:soc-operations", "builtin:cyber-defence-center", "builtin:x", "u:1a2b3c4d", "u:",
])
def test_creating_a_board_under_a_reserved_id_is_refused(client, board_id: str) -> None:
    for response in (
        client.post("/api/dashboards", json=_layout("Mine", id=board_id)),
        client.put(f"/api/dashboards/{board_id}", json=_layout("Mine", id=board_id)),
    ):
        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "dashboard_id_reserved"
        assert board_id not in detail["message"]  # the refusal never echoes the id
    assert _stored_ids(client) == set()


@pytest.mark.parametrize("board_id", ["news", "overview", "builtin", "dash-builtin:x", "U:1a2b3c4d", "my:board"])
def test_ids_that_only_look_reserved_can_be_created(client, board_id: str) -> None:
    r = client.post("/api/dashboards", json=_layout("Mine", id=board_id))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == board_id


def test_a_minted_id_is_never_reserved(client) -> None:
    body = _layout("Mine")
    body.pop("id", None)
    created = client.post("/api/dashboards", json=body).json()
    assert created["id"].startswith("dash-")


@pytest.mark.parametrize("board_id", ["new", "builtin:x", "u:deadbeef"])
def test_a_board_stored_under_a_reserved_id_keeps_working(client, board_id: str) -> None:
    """Rejected on CREATE only: a board stored before Round 14 under an id that is now
    reserved is still listed, updated, renamed, replaced, cloned and deleted."""
    _seed(client, board_id)
    assert _stored_ids(client) == {board_id}

    renamed = client.put(f"/api/dashboards/{board_id}", json=_layout("Renamed", id=board_id))
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Renamed"

    replaced = client.post("/api/dashboards", json=_layout("Replaced", id=board_id, default_window="now-7d"))
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["default_window"] == "now-7d"

    clone = client.post(f"/api/dashboards/{board_id}/clone")
    assert clone.status_code == 200, clone.text
    assert clone.json()["id"].startswith("dash-")
    assert clone.json()["default_window"] == "now-7d"

    gone = client.request("DELETE", f"/api/dashboards/{board_id}")
    assert gone.status_code == 200
    assert _stored_ids(client) == {clone.json()["id"]}


@pytest.mark.parametrize("window", ["now-24h", "now-7d", "now-30d", "now-90d"])
def test_default_window_is_stored_and_returned(client, window: str) -> None:
    created = client.post("/api/dashboards", json=_layout("Windowed", default_window=window))
    assert created.status_code == 200, created.text
    assert created.json()["default_window"] == window
    stored = client.get("/api/dashboards").json()["dashboards"][0]
    assert stored["default_window"] == window


def test_an_absent_default_window_is_null(client) -> None:
    created = client.post("/api/dashboards", json=_layout("Plain")).json()
    assert created["default_window"] is None and created["derived_from"] is None


@pytest.mark.parametrize("window", ["now-1d", "now-24H", "24", "all", "", "last 7 days", 7])
def test_a_bad_default_window_is_refused_not_dropped(client, window: Any) -> None:
    r = client.post("/api/dashboards", json=_layout("Bad window", default_window=window))
    assert r.status_code == 422, r.text
    assert _stored_ids(client) == set()

    did = client.post("/api/dashboards", json=_layout("Good", default_window="now-30d")).json()["id"]
    r = client.put(f"/api/dashboards/{did}", json=_layout("Good", id=did, default_window=window))
    assert r.status_code == 422, r.text
    stored = client.get("/api/dashboards").json()["dashboards"][0]
    assert stored["default_window"] == "now-30d"  # the update changed nothing


def test_derived_from_is_stored_as_plain_data(client) -> None:
    body = _layout("SOC operations (copy)", derived_from="builtin:soc-operations", default_window="now-24h")
    created = client.post("/api/dashboards", json=body)
    assert created.status_code == 200, created.text
    assert created.json()["derived_from"] == "builtin:soc-operations"
    did = created.json()["id"]
    # An update that omits it clears it (PUT replaces the board).
    cleared = client.put(f"/api/dashboards/{did}", json=_layout("Mine now", id=did))
    assert cleared.json()["derived_from"] is None


@pytest.mark.parametrize("value", ["builtin soc", "../../etc", "a" * 65, "builtin:<b>", "", 3])
def test_a_bad_derived_from_is_refused(client, value: Any) -> None:
    r = client.post("/api/dashboards", json=_layout("Copy", derived_from=value))
    assert r.status_code == 422, r.text
    assert _stored_ids(client) == set()


def test_round14_widget_types_round_trip(client) -> None:
    """The built-in boards' modules are allowlisted, so Duplicate to customise saves."""
    types = ["kpi.strip", "chart.case_trend", "table.top_rules", "kpi.agent_quality"]
    widgets = [_widget(f"w{n}", t, y=n, options={"preset": "operations"}) for n, t in enumerate(types)]
    r = client.post("/api/dashboards", json=_layout("Copy", widgets=widgets))
    assert r.status_code == 200, r.text
    assert [w["type"] for w in r.json()["widgets"]] == types
