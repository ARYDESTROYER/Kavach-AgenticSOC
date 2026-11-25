"""Pervasive customization (Wave 7) — offline tests.

Covers: UserPrefsStore CRUD (over the fake-ES KV); the ORG←USER cascade resolver
precedence; the /api/prefs/* + /api/views/* + /api/terminology route round-trips
(no-auth profile → the 'default' bucket); and CustomizationConfig bounds. The
admin-gate on /api/prefs/org + /api/terminology is asserted in
test_route_auth_coverage.py.
"""

from __future__ import annotations

from app.config import CustomizationConfig
from app.models import ColumnState, SavedView, UserPrefs
from app.state import AppState
from app.stores.user_prefs import (
    UserPrefsStore,
    normalize_user_id,
    resolve_effective_prefs,
)


# --------------------------------------------------------------------------- #
# UserPrefsStore CRUD
# --------------------------------------------------------------------------- #
async def test_user_prefs_store_crud(app_state: AppState) -> None:
    store: UserPrefsStore = app_state.user_prefs

    # An unseen user → an empty default bucket.
    empty = await store.get(None)
    assert isinstance(empty, UserPrefs)
    assert empty.saved_views == [] and empty.theme_mode == "system"

    # Patch a top-level field (theme).
    patched = await store.patch("alice", theme_mode="dark")
    assert patched.theme_mode == "dark"
    assert (await store.get("alice")).theme_mode == "dark"

    # Buckets are isolated per user; auth-off "default" bucket is its own.
    assert (await store.get("bob")).theme_mode == "system"

    # Add / update / delete a saved view.
    v = await store.add_view("alice", SavedView(name="My open cases", scope="cases"))
    assert (await store.get_view("alice", v.id)) is not None
    upd = await store.update_view("alice", v.id, name="Renamed")
    assert upd is not None and upd.name == "Renamed"
    assert await store.delete_view("alice", v.id) is True
    assert await store.delete_view("alice", v.id) is False  # already gone

    # Per-table column state set + clear.
    cs = await store.set_table_state("alice", "cases", {"order": ["case_id", "title"], "hidden": ["risk"]})
    assert cs.hidden == ["risk"]
    cleared = await store.set_table_state("alice", "cases", None)
    assert cleared.hidden == []
    assert (await store.get("alice")).tables == {}


async def test_patch_revalidates_typed_lists(app_state: AppState) -> None:
    # The route patches with dicts (model_dump); patch() must re-validate so the
    # returned/stored object holds real SavedView/ColumnState instances (else the
    # cascade resolver would choke on a raw dict).
    store: UserPrefsStore = app_state.user_prefs
    up = await store.patch(
        "dave",
        saved_views=[SavedView(name="raw").model_dump(mode="json")],
        tables={"cases": {"hidden": ["risk"]}},
    )
    assert isinstance(up.saved_views[0], SavedView)
    assert isinstance(up.tables["cases"], ColumnState)
    # And it resolves cleanly through the cascade (the original failure mode).
    eff = resolve_effective_prefs(None, up)
    assert len(eff["saved_views"]) == 1


async def test_patch_deep_merges_misc_bag(app_state: AppState) -> None:
    # Round-5 #5 fix: patching one key of the ``misc`` bag must NOT clobber the
    # sibling keys the user already has. Previously ``patch(misc=...)`` replaced the
    # whole bag; now it deep-merges (each top-level key replaces only its own entry).
    store: UserPrefsStore = app_state.user_prefs
    await store.patch("erin", misc={"terminology": {"case": "ticket"}, "density": "cozy"})
    # A follow-up patch touching only ONE misc key keeps the others.
    await store.patch("erin", misc={"density": "compact"})
    got = await store.get("erin")
    assert got.misc == {"terminology": {"case": "ticket"}, "density": "compact"}

    # last_list_state + tables deep-merge the same way (add a surface, keep the rest).
    await store.patch("erin", last_list_state={"cases": {"sort": "-created_at"}})
    await store.patch("erin", last_list_state={"sources": {"sort": "name"}})
    got = await store.get("erin")
    assert set(got.last_list_state) == {"cases", "sources"}

    # A scalar/list field still REPLACES wholesale (the caller sends the full value).
    await store.patch("erin", theme_mode="dark")
    await store.patch("erin", pinned_view_ids=["a", "b"])
    await store.patch("erin", pinned_view_ids=["c"])
    got = await store.get("erin")
    assert got.theme_mode == "dark" and got.pinned_view_ids == ["c"]
    # ...and the deep-merged misc survived all the unrelated patches.
    assert got.misc == {"terminology": {"case": "ticket"}, "density": "compact"}


async def test_concurrent_patches_are_cas_safe(app_state: AppState) -> None:
    # Two interleaved writers to DIFFERENT keys must both land (no lost update). The
    # store routes every mutation through the kv_mutate CAS helper (per-store lock +
    # _rev retry), so a concurrent theme patch and a misc patch can't clobber each
    # other even when scheduled together.
    import asyncio

    store: UserPrefsStore = app_state.user_prefs
    await asyncio.gather(
        store.patch("frank", theme_mode="dark"),
        store.patch("frank", misc={"density": "compact"}),
        store.add_view("frank", SavedView(name="Concurrent view", scope="cases")),
    )
    got = await store.get("frank")
    assert got.theme_mode == "dark"
    assert got.misc == {"density": "compact"}
    assert any(v.name == "Concurrent view" for v in got.saved_views)


def test_normalize_user_id() -> None:
    assert normalize_user_id(None) == "default"
    assert normalize_user_id("") == "default"
    assert normalize_user_id("  Alice ") == "alice"  # trimmed + lowercased


# --------------------------------------------------------------------------- #
# Cascade resolver — ORG defaults ← USER overrides
# --------------------------------------------------------------------------- #
def test_cascade_resolver_precedence() -> None:
    org = CustomizationConfig(
        terminology={"case": "incident", "cases": "incidents"},
        default_theme="dark",
        default_saved_views=[{"id": "view-org", "name": "Org triage", "scope": "cases"}],
        default_pinned_view_ids=["view-org"],
    )
    user = UserPrefs(
        theme_mode="light",  # a user's explicit non-system choice wins over org
        saved_views=[SavedView(id="view-me", name="Mine", scope="cases")],
        misc={"terminology": {"case": "ticket"}},  # user label wins over org
        tables={"cases": ColumnState(hidden=["risk"])},
    )
    eff = resolve_effective_prefs(org, user)

    # USER terminology wins over ORG; ORG fills the rest.
    assert eff["terminology"]["case"] == "ticket"
    assert eff["terminology"]["cases"] == "incidents"
    # USER theme wins.
    assert eff["theme_mode"] == "light"
    # Org-shared view (shared=True) UNION the user's own.
    ids = {v["id"] for v in eff["saved_views"]}
    assert {"view-org", "view-me"} <= ids
    org_view = next(v for v in eff["saved_views"] if v["id"] == "view-org")
    assert org_view["shared"] is True
    # Personal table state passes through.
    assert eff["tables"]["cases"]["hidden"] == ["risk"]
    # The misc bag never leaks the terminology sub-key back out.
    assert "terminology" not in eff["misc"]


def test_cascade_theme_system_defers_to_branding_not_the_legacy_org_value() -> None:
    # Round 16 B45: "system" stays "system" so the Console resolves it against Branding,
    # the one organization default; the legacy customization value no longer wins.
    org = CustomizationConfig(default_theme="dark")
    eff = resolve_effective_prefs(org, UserPrefs(theme_mode="system"))
    assert eff["theme_mode"] == "system"
    assert eff["org"]["default_theme"] == "dark"  # still echoed, never applied


# --------------------------------------------------------------------------- #
# CustomizationConfig bounds (terminology is plain data, bounded — #9/#10)
# --------------------------------------------------------------------------- #
def test_terminology_bounds() -> None:
    # A reasonable map validates.
    ok = CustomizationConfig(terminology={"case": "incident"})
    assert ok.terminology == {"case": "incident"}

    # Too many keys rejected.
    big = {f"k{i}": "x" for i in range(201)}
    try:
        CustomizationConfig(terminology=big)
        assert False, "expected too-many-terms to raise"
    except Exception:
        pass

    # An over-long label rejected.
    try:
        CustomizationConfig(terminology={"case": "x" * 121})
        assert False, "expected over-long label to raise"
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Route round-trips (no-auth profile → the 'default' bucket)
# --------------------------------------------------------------------------- #
def test_prefs_routes_roundtrip(client) -> None:
    # effective is hydratable on a fresh tenant.
    r = client.get("/api/prefs/effective")
    assert r.status_code == 200
    body = r.json()
    assert body["theme_mode"] == "system"
    assert body["saved_views"] == []

    # Patch personal theme.
    r = client.put("/api/prefs/user", json={"theme_mode": "dark"})
    assert r.status_code == 200 and r.json()["theme_mode"] == "dark"
    assert client.get("/api/prefs/effective").json()["theme_mode"] == "dark"

    # Create + clone + delete a saved view.
    r = client.post("/api/views", json={"name": "Open", "scope": "cases", "filters": {"status": "open"}})
    assert r.status_code == 200
    vid = r.json()["id"]
    assert client.get("/api/views").json()["count"] == 1

    r = client.post(f"/api/views/{vid}/clone")
    assert r.status_code == 200 and r.json()["name"].endswith("(copy)")
    assert client.get("/api/views").json()["count"] == 2

    r = client.put(f"/api/views/{vid}", json={"name": "Renamed open"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed open"

    r = client.delete(f"/api/views/{vid}")
    assert r.status_code == 200
    assert client.delete(f"/api/views/{vid}").status_code == 404

    # Per-table column state.
    r = client.put("/api/prefs/user/tables/cases", json={"order": ["case_id"], "hidden": ["risk"]})
    assert r.status_code == 200 and r.json()["state"]["hidden"] == ["risk"]
    assert client.get("/api/prefs/user").json()["tables"]["cases"]["hidden"] == ["risk"]


def test_org_terminology_routes_roundtrip(client) -> None:
    # Auth off → require_admin is a no-op, so the admin routes are reachable (the
    # admin-GATE itself is asserted in test_route_auth_coverage.py).
    r = client.put("/api/terminology", json={"terminology": {"case": "incident"}})
    assert r.status_code == 200 and r.json()["terminology"]["case"] == "incident"
    assert client.get("/api/terminology").json()["terminology"]["case"] == "incident"
    # It surfaces through the effective cascade.
    assert client.get("/api/prefs/effective").json()["terminology"]["case"] == "incident"

    r = client.put("/api/prefs/org", json={"default_theme": "dark", "terminology": {"cases": "incidents"}})
    assert r.status_code == 200 and r.json()["default_theme"] == "dark"
    assert client.get("/api/prefs/org").json()["terminology"]["cases"] == "incidents"


def test_clone_org_view_into_personal_set(client) -> None:
    # Seed an ORG-shared default view, then clone it into the caller's PERSONAL set.
    org_view = {"id": "view-org-seed", "name": "Org open cases", "scope": "cases",
                "filters": {"status": "open"}}
    r = client.put("/api/prefs/org", json={"default_saved_views": [org_view]})
    assert r.status_code == 200

    # The org view surfaces (shared=True) in the caller's /views.
    listed = client.get("/api/views").json()["views"]
    org = next(v for v in listed if v["id"] == "view-org-seed")
    assert org["shared"] is True

    # Clone it → a fresh, personal, non-shared, owned copy with a new id.
    r = client.post("/api/views/view-org-seed/clone")
    assert r.status_code == 200
    clone = r.json()
    assert clone["id"] != "view-org-seed"
    assert clone["shared"] is False
    assert clone["filters"] == {"status": "open"}
    assert clone["name"].endswith("(copy)")
    # The clone is now in the personal set and is independently deletable.
    assert client.delete(f"/api/views/{clone['id']}").status_code == 200
    # The org view itself is NOT deletable via the personal route (404).
    assert client.delete("/api/views/view-org-seed").status_code == 404


# --------------------------------------------------------------------------- #
# Admin-gate on the ORG routes: 401 (no session) + 403 (non-admin) when auth +
# RBAC are ON. The deny-by-default coverage is asserted separately in
# test_route_auth_coverage.py; here we exercise the live gate end-to-end.
# --------------------------------------------------------------------------- #
def _auth_client():
    from contextlib import asynccontextmanager

    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes import router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="prefs-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        # Turn RBAC ON so a non-admin is actually denied (not treated as super_admin),
        # and create a tier-1 analyst account to exercise the 403 path.
        from app.auth.passwords import hash_password
        from app.constants import UserRole

        await state.users.create(
            username="analyst", password_hash=hash_password("analyst-pass-1"),
            role=UserRole.ANALYST_TIER1.value,
        )
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac = prefs.rbac.model_copy(update={"enabled": True})
        await state.update_prefs(prefs)
        await state.refresh_users()
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from tests.conftest import mount_moved_routers

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    return TestClient(api)


def test_org_routes_admin_gate_401_403() -> None:
    with _auth_client() as c:
        # 401 — no session.
        assert c.put("/api/terminology", json={"terminology": {"case": "x"}}).status_code == 401
        assert c.put("/api/prefs/org", json={"default_theme": "dark"}).status_code == 401

        # 403 — a signed-in NON-admin lacks users:manage.
        login = c.post("/api/auth/login", json={"username": "analyst", "password": "analyst-pass-1"})
        assert login.status_code == 200, login.text
        assert c.put("/api/terminology", json={"terminology": {"case": "x"}}).status_code == 403
        assert c.put("/api/prefs/org", json={"default_theme": "dark"}).status_code == 403
        # ...but the analyst CAN read + edit their OWN personal prefs (self-scoped).
        assert c.get("/api/prefs/effective").status_code == 200
        assert c.put("/api/prefs/user", json={"theme_mode": "dark"}).status_code == 200

        # The admin CAN write the org defaults.
        c.post("/api/auth/logout")
        admin = c.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
        assert admin.status_code == 200, admin.text
        assert c.put("/api/terminology", json={"terminology": {"case": "incident"}}).status_code == 200
        assert c.put("/api/prefs/org", json={"default_theme": "dark"}).status_code == 200


def test_auth_off_uses_default_bucket(client) -> None:
    # With auth OFF, every personal pref lands in the shared 'default' bucket and
    # round-trips fully — the no-auth profile is a first-class customization user.
    assert client.put("/api/prefs/user", json={"theme_mode": "light"}).status_code == 200
    assert client.get("/api/prefs/user").json()["theme_mode"] == "light"
    assert client.post("/api/views", json={"name": "Default-bucket view"}).status_code == 200
    assert client.get("/api/views").json()["count"] == 1


# --------------------------------------------------------------------------- #
# SQL state backend (SQLite) — the SAME UserPrefsStore over SqlKVStore. Proves the
# store is backend-agnostic with no new table (it reuses the shared KV table).
# --------------------------------------------------------------------------- #
async def test_user_prefs_store_on_sqlite() -> None:
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    try:
        store = UserPrefsStore(SqlKVStore(eng))

        # Empty → default bucket; patch theme; round-trips through SQLite.
        assert (await store.get("carol")).theme_mode == "system"
        # Seed a misc key, then a second patch with a DIFFERENT misc key must DEEP-MERGE
        # (Round-5 #5 fix) — the earlier key survives instead of being clobbered.
        await store.patch("carol", misc={"terminology": {"case": "ticket"}})
        await store.patch("carol", theme_mode="dark", misc={"density": "compact"})
        got = await store.get("carol")
        assert got.theme_mode == "dark"
        assert got.misc == {"terminology": {"case": "ticket"}, "density": "compact"}

        # Saved-view CRUD persists across reloads (a fresh store over the same engine).
        v = await store.add_view("carol", SavedView(name="Sqlite view", scope="cases"))
        store2 = UserPrefsStore(SqlKVStore(eng))
        assert (await store2.get_view("carol", v.id)) is not None
        assert await store2.delete_view("carol", v.id) is True

        # Per-table state + bucket isolation + the 'default' (auth-off) bucket.
        await store.set_table_state("carol", "cases", {"hidden": ["risk"]})
        assert (await store.get("carol")).tables["cases"].hidden == ["risk"]
        assert (await store.get(None)).theme_mode == "system"  # default bucket untouched
        assert await store.delete("carol") is True
        assert (await store.get("carol")).theme_mode == "system"
    finally:
        await eng.dispose()
