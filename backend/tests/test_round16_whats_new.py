"""Round 16 WP07: What's new on the backend (SPEC D7, §3.2, §3.4, §4.4 WP07).

Covers, offline (fake Elasticsearch, mock model):

* ``app.whats_new.latest_update_id`` reads the generated ``whats_new_latest.json`` (the
  same id the Console notes name) and fails open to ``None``;
* the acknowledgement ``misc.whats_new_seen`` is an audited preference change: one
  ``user.preferences_updated`` row before it is saved, none for a no-op resend or for the
  personal switch ``whats_new_auto``, ``503 audit_unavailable`` with nothing saved when
  the audit cannot be written, and the row goes to the real audit log with Demo Mode on
  and off (the marker is a real preference, never a Demo one);
* the creation stamp in each of the three create paths (``POST /api/users``, the create
  branch of single sign-on provisioning, ``POST /api/setup/account``), and a stamp that
  fails never fails the create;
* the wheel and the CI wheel check carry ``app/whats_new_latest.json``.
"""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import whats_new
from app.api import routes as routes_mod
from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_prefs import router as prefs_router
from app.api.routes_setup import router as setup_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import WHATS_NEW_AUTO_PREF_KEY, WHATS_NEW_SEEN_PREF_KEY
from app.state import AppState

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
WEB_NOTES = REPO / "webui/src/soc/whats-new/release-notes.gen.json"
STRONG = "Str0ng-OOBE-Pass!"
OLDER = "0.2.0.2026-11-25"


@pytest.fixture(autouse=True)
def _fresh_latest_cache():
    whats_new.latest_update_id.cache_clear()
    yield
    whats_new.latest_update_id.cache_clear()


def _secrets(**overrides: Any) -> Secrets:
    values: dict[str, Any] = dict(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="round16-whats-new-secret", auth_seed_admin=True,
    )
    values.update(overrides)
    return Secrets(**values)


def _client(*, setup_complete: bool = True, **secret_overrides: Any) -> tuple[TestClient, FastAPI]:
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=_secrets(**secret_overrides), es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": setup_complete}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (monolith_router, prefs_router, setup_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api), api


def _state(api: FastAPI) -> AppState:
    return api.state.tlsoc


def _admin(client: TestClient) -> dict[str, str]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _rows(client: TestClient, repo: Any) -> list[dict[str, Any]]:
    return client.portal.call(lambda: repo.records(limit=1000))


def _pref_rows(client: TestClient, repo: Any) -> list[dict[str, Any]]:
    return [r for r in _rows(client, repo) if r.get("action") == "user.preferences_updated"]


def _misc(client: TestClient, api: FastAPI, username: str) -> dict[str, Any]:
    prefs = client.portal.call(_state(api).user_prefs.get, username)
    return dict(prefs.misc or {})


# --------------------------------------------------------------------------- #
# The newest update id
# --------------------------------------------------------------------------- #
def test_latest_update_id_is_the_newest_id_the_console_notes_name() -> None:
    latest = whats_new.latest_update_id()
    assert latest is not None
    notes = json.loads(WEB_NOTES.read_text(encoding="utf-8"))
    assert latest == notes["latest"] == notes["releases"][0]["updates"][0]["id"]
    data = json.loads(whats_new.LATEST_FILE.read_text(encoding="utf-8"))
    assert data["version"] == (REPO / "VERSION").read_text(encoding="utf-8").strip()


@pytest.mark.parametrize("content", [None, "not json", "[]", '{"latest_update_id": 7}',
                                     '{"latest_update_id": "Bad Id!"}', '{"latest_update_id": ""}'])
def test_latest_update_id_fails_open_to_none(tmp_path: Path, monkeypatch, content) -> None:
    target = tmp_path / "whats_new_latest.json"
    if content is not None:
        target.write_text(content, encoding="utf-8")
    monkeypatch.setattr(whats_new, "LATEST_FILE", target)
    whats_new.latest_update_id.cache_clear()
    assert whats_new.latest_update_id() is None


async def test_a_stamp_without_an_id_or_a_name_writes_nothing() -> None:
    calls: list[Any] = []

    class _Prefs:
        async def patch(self, *args: Any, **kwargs: Any) -> None:
            calls.append((args, kwargs))

    state = type("S", (), {"user_prefs": _Prefs()})()
    await whats_new.stamp_new_account(state, "")
    assert calls == []
    await whats_new.stamp_new_account(state, "ana")
    assert calls == [(("ana",), {"misc": {WHATS_NEW_SEEN_PREF_KEY: whats_new.latest_update_id()}})]


# --------------------------------------------------------------------------- #
# The acknowledgement is an audited preference change
# --------------------------------------------------------------------------- #
def test_the_acknowledgement_is_audited_once_and_the_switch_is_not() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        repo = _state(api).control_audit
        before = len(_pref_rows(client, repo))
        seen = client.put("/api/prefs/user", headers=auth, json={"misc": {WHATS_NEW_SEEN_PREF_KEY: OLDER}})
        assert seen.status_code == 200, seen.text
        assert seen.json()["misc"][WHATS_NEW_SEEN_PREF_KEY] == OLDER
        again = client.put("/api/prefs/user", headers=auth, json={"misc": {WHATS_NEW_SEEN_PREF_KEY: OLDER}})
        assert again.status_code == 200
        switch = client.put("/api/prefs/user", headers=auth, json={"misc": {WHATS_NEW_AUTO_PREF_KEY: False}})
        assert switch.status_code == 200
        assert switch.json()["misc"][WHATS_NEW_AUTO_PREF_KEY] is False
        # One row so far: the no-op resend and the switch wrote none.
        assert len(_pref_rows(client, repo)) - before == 1
        latest = whats_new.latest_update_id()
        newer = client.put("/api/prefs/user", headers=auth, json={"misc": {WHATS_NEW_SEEN_PREF_KEY: latest}})
        assert newer.status_code == 200
        rows = _pref_rows(client, repo)
    assert len(rows) - before == 2
    changes = [change for row in rows for change in row["changes"] if change["field"] == "misc.whats_new_seen"]
    assert {(c["before"], c["after"]) for c in changes} == {(None, OLDER), (OLDER, latest)}
    assert all(row["target"]["id"] == "Admin" for row in rows if row["changes"][0]["field"] == "misc.whats_new_seen")


def test_an_invalid_marker_is_dropped_and_writes_no_row() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        repo = _state(api).control_audit
        before = len(_pref_rows(client, repo))
        bad = client.put("/api/prefs/user", headers=auth,
                         json={"misc": {WHATS_NEW_SEEN_PREF_KEY: "Not An Id!", WHATS_NEW_AUTO_PREF_KEY: "no"}})
        assert bad.status_code == 200, bad.text
        assert WHATS_NEW_SEEN_PREF_KEY not in bad.json()["misc"]
        assert WHATS_NEW_AUTO_PREF_KEY not in bad.json()["misc"]
        assert len(_pref_rows(client, repo)) == before


def test_the_acknowledgement_is_refused_with_503_when_the_audit_is_down(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        repo = _state(api).control_audit

        async def _down(**_kwargs: Any) -> None:
            raise RuntimeError("audit store unreachable")

        monkeypatch.setattr(repo, "record_strict", _down)
        response = client.put("/api/prefs/user", headers=auth, json={"misc": {WHATS_NEW_SEEN_PREF_KEY: OLDER}})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "audit_unavailable"
        monkeypatch.undo()
        assert WHATS_NEW_SEEN_PREF_KEY not in _misc(client, api, "Admin")


def test_the_acknowledgement_row_goes_to_the_real_log_with_demo_mode_on_and_off() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        client.portal.call(state.enable_demo)
        try:
            on = client.put("/api/prefs/user", headers=auth, json={"misc": {WHATS_NEW_SEEN_PREF_KEY: OLDER}})
            assert on.status_code == 200, on.text
            demo_rows = _pref_rows(client, state.demo_audit)
            real_rows = _pref_rows(client, state.control_audit)
        finally:
            client.portal.call(state.disable_demo)
        # The marker is a real preference: it outlives Demo Mode.
        assert _misc(client, api, "Admin")[WHATS_NEW_SEEN_PREF_KEY] == OLDER
        off = client.put("/api/prefs/user", headers=auth,
                         json={"misc": {WHATS_NEW_SEEN_PREF_KEY: whats_new.latest_update_id()}})
        assert off.status_code == 200
        after_rows = _pref_rows(client, state.control_audit)
    assert [r["changes"][0]["after"] for r in real_rows] == [OLDER]
    assert demo_rows == []
    assert len(after_rows) == 2


# --------------------------------------------------------------------------- #
# The creation stamp, in each of the three create paths
# --------------------------------------------------------------------------- #
def test_post_users_stamps_the_new_account_and_leaves_the_creator_alone() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        made = client.post("/api/users", headers=auth, json={"username": "new-analyst", "password": "new-analyst-pass"})
        assert made.status_code == 200, made.text
        assert _misc(client, api, "new-analyst")[WHATS_NEW_SEEN_PREF_KEY] == whats_new.latest_update_id()
        # The administrator who created it has not seen What's new: nothing is stamped for them.
        assert WHATS_NEW_SEEN_PREF_KEY not in _misc(client, api, "Admin")
        # The stamp writes no audit row of its own; ``user.created`` records the create.
        assert [r for r in _pref_rows(client, _state(api).control_audit)
                if r.get("target", {}).get("id") == "new-analyst"] == []


def test_a_failed_stamp_never_fails_the_create(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)

        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("prefs store down")

        monkeypatch.setattr(state.user_prefs, "patch", _broken)
        made = client.post("/api/users", headers=auth, json={"username": "unlucky", "password": "unlucky-pass-1"})
        assert made.status_code == 200, made.text
        assert client.portal.call(state.users.get, "unlucky") is not None
        monkeypatch.undo()
        assert WHATS_NEW_SEEN_PREF_KEY not in _misc(client, api, "unlucky")


def test_a_missing_notes_file_creates_the_account_without_a_stamp(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(whats_new, "LATEST_FILE", tmp_path / "absent.json")
    whats_new.latest_update_id.cache_clear()
    client, api = _client()
    with client:
        auth = _admin(client)
        made = client.post("/api/users", headers=auth, json={"username": "no-notes", "password": "no-notes-pass"})
        assert made.status_code == 200, made.text
        assert WHATS_NEW_SEEN_PREF_KEY not in _misc(client, api, "no-notes")


def test_setup_account_stamps_the_first_super_admin() -> None:
    client, api = _client(setup_complete=False, auth_seed_admin=False)
    with client:
        response = client.post("/api/setup/account", json={"username": "root", "password": STRONG})
        assert response.status_code == 200, response.text
        assert _misc(client, api, "root")[WHATS_NEW_SEEN_PREF_KEY] == whats_new.latest_update_id()


def test_setup_account_still_creates_when_the_stamp_fails(monkeypatch) -> None:
    client, api = _client(setup_complete=False, auth_seed_admin=False)
    with client:
        state = _state(api)

        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("prefs store down")

        monkeypatch.setattr(state.user_prefs, "patch", _broken)
        response = client.post("/api/setup/account", json={"username": "root", "password": STRONG})
        assert response.status_code == 200, response.text
        assert client.portal.call(state.users.get, "root") is not None


def _sso_request(state: AppState) -> Request:
    api = FastAPI()
    api.state.tlsoc = state
    return Request({"type": "http", "method": "GET", "path": "/api/auth/sso/callback",
                    "headers": [], "client": ("192.0.2.10", 443), "query_string": b"", "app": api})


async def _sso_state() -> AppState:
    from app.config import SSOConfig, SSOProvider

    mock = MockProvider()
    state = AppState.create(secrets=_secrets(), es=InMemoryESClient(),
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    await state.startup(start_poller=False)
    sso = SSOConfig(enabled=True, providers=[SSOProvider(
        id="corp", type="generic", client_id="a", auto_create_users=True,
        discovery_url="https://idp.corp.test/.well-known/openid-configuration")])
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True, "sso": sso}))
    return state


async def test_single_sign_on_provisioning_stamps_only_a_created_account() -> None:
    state = await _sso_state()
    analyst = UserRole.ANALYST_TIER1.value
    try:
        name, refusal = await routes_mod._provision_sso_user(
            state, _sso_request(state), "corp",
            {"sub": "ana-sub", "email": "ana@corp.test", "email_verified": True}, analyst)
        assert (name, refusal) == ("ana@corp.test", None)
        stamped = await state.user_prefs.get("ana@corp.test")
        assert stamped.misc[WHATS_NEW_SEEN_PREF_KEY] == whats_new.latest_update_id()
        # A returning sign-in is not a create: a marker the person moved is left alone.
        await state.user_prefs.patch("ana@corp.test", misc={WHATS_NEW_SEEN_PREF_KEY: OLDER})
        again, _ = await routes_mod._provision_sso_user(
            state, _sso_request(state), "corp",
            {"sub": "ana-sub", "email": "ana@corp.test", "email_verified": True}, analyst)
        assert again == "ana@corp.test"
        assert (await state.user_prefs.get("ana@corp.test")).misc[WHATS_NEW_SEEN_PREF_KEY] == OLDER
    finally:
        await state.shutdown()


async def test_single_sign_on_provisioning_survives_a_failed_stamp(monkeypatch) -> None:
    state = await _sso_state()
    try:
        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("prefs store down")

        monkeypatch.setattr(state.user_prefs, "patch", _broken)
        name, refusal = await routes_mod._provision_sso_user(
            state, _sso_request(state), "corp",
            {"sub": "bo-sub", "email": "bo@corp.test", "email_verified": True},
            UserRole.ANALYST_TIER1.value)
        assert (name, refusal) == ("bo@corp.test", None)
        assert await state.users.get("bo@corp.test") is not None
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# Packaging: the wheel carries the id
# --------------------------------------------------------------------------- #
def test_the_package_data_and_the_ci_wheel_check_name_the_file() -> None:
    import tomllib

    data = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    assert "whats_new_latest.json" in data["tool"]["setuptools"]["package-data"]["app"]
    workflow = (REPO / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert '"app/whats_new_latest.json",' in workflow
    assert "python scripts/build_release_notes.py --check" in workflow
    assert "python scripts/test_build_release_notes.py" in workflow


def test_the_built_wheel_contains_the_newest_update_id(tmp_path: Path) -> None:
    from tests.test_distribution_contract import _offline_build_env, _pristine_source_tree

    out = tmp_path / "dist"
    source = _pristine_source_tree(tmp_path)
    subprocess.run(
        [sys.executable, "-m", "build", "--wheel", "--no-isolation", "--outdir", str(out)],
        cwd=source, env=_offline_build_env(tmp_path), check=True, capture_output=True, text=True,
    )
    wheels = list(out.glob("*.whl"))
    assert len(wheels) == 1
    with zipfile.ZipFile(wheels[0]) as archive:
        assert "app/whats_new_latest.json" in archive.namelist()
        shipped = json.loads(archive.read("app/whats_new_latest.json"))
    assert shipped["latest_update_id"] == whats_new.latest_update_id()
