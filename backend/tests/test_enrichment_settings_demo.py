"""The Enrichment settings read and write the same settings, with Demo Mode on and off
(Round 14 second acceptance pass, wro-01 and its FX7d review fixes; SPEC §3.5, §3.6,
§4.5.4, §4.9.6).

Before this fix the Settings page's switches were read from the Demo execution copy
(``enabled`` forced off, frozen once the Demo tuner wrote its override) while each
switch saved the real settings, so in Demo Mode a saved change looked undone after a
reload and "Enrichment enabled" always read Off. Now:

* ``GET /api/enrichment/providers`` and ``PUT /api/enrichment/config`` use the active
  stack's enrichment settings (``AppState.enrichment_settings``): the real settings off
  Demo Mode, the Demo sandbox's own copy while it is on;
* a Demo save never reaches the real settings, its row goes to the Demo audit, and the
  copy vanishes when Demo Mode ends; a real save is audited in the real log first;
* the sandbox still never queries a provider: the execution copy keeps lookups forced
  off and the listing says so with ``demo_active`` instead of reporting the forced
  value as the setting;
* the write is strict (unknown fields, coerced types and lifetimes outside 0 to 30
  days are refused with no row, and the edit runs the model's own validation), a no-op
  writes nothing, a racing save is retried, and Demo Mode turned on or off during the
  save answers ``409 demo_mode_changed``;
* the settings lock refuses the write with Demo Mode on or off, as ``PUT /api/settings``
  did for these saves, also when it is turned on after the action row;
* the listing and the save name the Demo run (``demo_run_id``), so a page can tell a
  reset's fresh copy from the run it read, and the save answers a typed contract;
* a provider key is a real secret in both stacks, audited first in the real log with
  its name and never its value.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.api import routes_enrichment
from app.config import Preferences, Secrets
from app.engine.demo_runtime import DemoStack


def _mount(client) -> Any:
    client.app.include_router(routes_enrichment.router)
    return client.app.state.tlsoc


def _enable_seeded(client) -> None:
    response = client.post(
        "/api/demo/enable", json={"mode": "seeded", "seed": 1337, "history_days": 2},
    )
    assert response.status_code == 200, response.text


def _listing(client) -> dict[str, Any]:
    response = client.get("/api/enrichment/providers")
    assert response.status_code == 200, response.text
    return response.json()


def _switches(listing: dict[str, Any]) -> dict[str, bool]:
    return {p["config_key"]: p["enabled_by_config"] for p in listing["providers"]}


def _put(client, body: Any):
    return client.put("/api/enrichment/config", json=body)


def _rows(client, repo: Any) -> list[dict[str, Any]]:
    return client.portal.call(lambda: repo.records(limit=1000))


def _settings_rows(client, repo: Any) -> list[dict[str, Any]]:
    return [
        r for r in _rows(client, repo)
        if str(r.get("action", "")).startswith("settings.")
        and (r.get("target") or {}).get("id") == "enrichment"
    ]


# --------------------------------------------------------------------------- #
# Off Demo Mode: the real settings, audited in the real log
# --------------------------------------------------------------------------- #
def test_real_save_changes_the_real_settings_and_the_listing_shows_it(client) -> None:
    state = _mount(client)
    before = _listing(client)
    assert before["demo_active"] is False
    assert before["enrichment_enabled"] is state.prefs.enrichment.enabled
    assert before["fusion_enabled"] is state.prefs.enrichment.fusion_enabled
    assert before["cache_ttl_seconds"] == state.prefs.enrichment.cache_ttl_seconds
    assert _switches(before)["use_spamhaus"] is False

    response = _put(client, {"use_spamhaus": True, "cache_ttl_seconds": 600})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True and body["changed"] is True and body["demo_active"] is False
    assert body["config"]["use_spamhaus"] is True
    assert state.prefs.enrichment.use_spamhaus is True
    assert state.prefs.enrichment.cache_ttl_seconds == 600

    after = _listing(client)
    assert _switches(after)["use_spamhaus"] is True
    assert after["cache_ttl_seconds"] == 600
    # The same value GET /api/settings reads (what the rest of the page shows).
    stored = client.get("/api/settings").json()["prefs"]["enrichment"]
    assert stored["use_spamhaus"] is True and stored["cache_ttl_seconds"] == 600

    rows = _settings_rows(client, state.control_audit)
    assert len(rows) == 1
    row = rows[0]
    assert row["action"] == "settings.updated" and row["outcome"] == "success"
    assert row["target"]["type"] == "setting" and row["target"]["label"] == "Enrichment"
    fields = {c["field"]: (c["before"], c["after"]) for c in row["changes"]}
    assert fields == {
        "enrichment.cache_ttl_seconds": ("21600", "600"),
        "enrichment.use_spamhaus": ("false", "true"),
    }
    assert row["result_summary"] == (
        "updated enrichment settings: cache_ttl_seconds, use_spamhaus"
    )


def test_a_save_that_changes_nothing_writes_no_row(client) -> None:
    state = _mount(client)
    response = _put(client, {"use_rdap": state.prefs.enrichment.use_rdap})
    assert response.status_code == 200, response.text
    assert response.json()["changed"] is False
    assert _settings_rows(client, state.control_audit) == []


@pytest.mark.parametrize("body, detail", [
    ({}, "Send at least one enrichment setting"),
    ([], ""),  # not an object: FastAPI's own body validation answers 422
    ({"use_spamhuas": True}, "Unknown enrichment setting(s): ['use_spamhuas']."),
    ({"use_spamhaus": "true"}, "use_spamhaus must be true or false."),
    ({"use_spamhaus": 1}, "use_spamhaus must be true or false."),
    ({"enabled": None}, "enabled must be true or false."),
    ({"cache_ttl_seconds": -1}, "cache_ttl_seconds must be a whole number of seconds"),
    ({"cache_ttl_seconds": True}, "cache_ttl_seconds must be a whole number of seconds"),
    ({"cache_ttl_seconds": 1.5}, "cache_ttl_seconds must be a whole number of seconds"),
    ({"cache_ttl_seconds": "600"}, "cache_ttl_seconds must be a whole number of seconds"),
])
def test_a_refused_body_changes_nothing_and_writes_no_row(client, body: Any, detail: str) -> None:
    state = _mount(client)
    before = state.prefs.enrichment.model_dump(mode="json")
    response = _put(client, body)
    assert response.status_code == 422, response.text
    assert detail in str(response.json()["detail"])
    assert state.prefs.enrichment.model_dump(mode="json") == before
    assert _settings_rows(client, state.control_audit) == []


def test_every_enrichment_field_is_editable_through_the_route() -> None:
    """The editable table is derived from the model, so a provider added later is
    editable with no change in the route (and nothing else is)."""
    from app.config import EnrichmentConfig

    fields = routes_enrichment._editable_fields()  # noqa: SLF001
    assert set(fields) == set(EnrichmentConfig.model_fields)
    assert fields["cache_ttl_seconds"] is int
    assert {t for k, t in fields.items() if k != "cache_ttl_seconds"} == {bool}


def test_the_write_requires_enrichment_manage() -> None:
    route = next(
        r for r in routes_enrichment.router.routes
        if getattr(r, "path", "") == "/api/enrichment/config" and "PUT" in r.methods
    )
    grants: set[tuple[str, str]] = set()
    for dependency in route.dependant.dependencies:
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
    assert grants == {("enrichment", "manage")}


def test_audit_first_a_failed_append_saves_nothing(client, monkeypatch) -> None:
    state = _mount(client)

    async def _down(**_kwargs: Any) -> None:
        raise RuntimeError("audit store unreachable")

    monkeypatch.setattr(state.control_audit, "record_strict", _down)
    response = _put(client, {"use_spamhaus": True})
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "audit_unavailable"
    assert state.prefs.enrichment.use_spamhaus is False


def test_a_save_racing_another_save_of_the_same_field_is_retried(client, monkeypatch) -> None:
    """Another save sets the same field between the row and the save: the row would no
    longer be true, so this attempt fails (its failure row beside it) and the fresh
    attempt finds nothing left to change."""
    state = _mount(client)
    appended = state.control_audit.record_strict
    raced: dict[str, bool] = {}

    async def _append_then_race(**kwargs: Any) -> Any:
        result = await appended(**kwargs)
        if kwargs.get("outcome") == "success" and not raced:
            raced["done"] = True
            current = state.prefs
            await state.update_prefs(current.model_copy(update={
                "enrichment": current.enrichment.model_copy(update={"use_spamhaus": True}),
            }))
        return result

    monkeypatch.setattr(state.control_audit, "record_strict", _append_then_race)
    response = _put(client, {"use_spamhaus": True})
    assert response.status_code == 200, response.text
    assert response.json()["changed"] is False
    rows = sorted(_settings_rows(client, state.control_audit), key=lambda r: r["ts"])
    assert [(r["action"], r["outcome"]) for r in rows] == [
        ("settings.updated", "success"), ("settings.update_failed", "failure"),
    ]
    assert rows[0]["request_id"] == rows[1]["request_id"]
    assert state.prefs.enrichment.use_spamhaus is True


def test_a_save_racing_an_unrelated_save_keeps_both(client, monkeypatch) -> None:
    state = _mount(client)
    appended = state.control_audit.record_strict
    raced: dict[str, bool] = {}

    async def _append_then_race(**kwargs: Any) -> Any:
        result = await appended(**kwargs)
        if kwargs.get("outcome") == "success" and not raced:
            raced["done"] = True
            current = state.prefs
            await state.update_prefs(current.model_copy(update={
                "enrichment": current.enrichment.model_copy(update={"fusion_enabled": True}),
            }))
        return result

    monkeypatch.setattr(state.control_audit, "record_strict", _append_then_race)
    response = _put(client, {"use_spamhaus": True})
    assert response.status_code == 200, response.text
    assert response.json()["changed"] is True
    assert state.prefs.enrichment.use_spamhaus is True
    assert state.prefs.enrichment.fusion_enabled is True  # the other save survived


# --------------------------------------------------------------------------- #
# Demo Mode on: the sandbox's copy, read and written alike
# --------------------------------------------------------------------------- #
def test_demo_listing_shows_the_stored_switches_not_the_forced_lookup_off(client) -> None:
    """Right after a seeded enable (the Demo tuner has already written its override),
    the page shows the stored settings: "Enrichment enabled" reads On while the
    execution copy keeps every lookup off."""
    state = _mount(client)
    _enable_seeded(client)
    try:
        assert state.prefs.enrichment.enabled is True
        assert state.execution_prefs.enrichment.enabled is False
        listing = _listing(client)
        assert listing["demo_active"] is True
        assert listing["enrichment_enabled"] is True
        assert listing["fusion_enabled"] is state.prefs.enrichment.fusion_enabled
        assert listing["cache_ttl_seconds"] == state.prefs.enrichment.cache_ttl_seconds
        # Every provider switch is the stored one, as GET /api/settings reads it.
        real = state.prefs.enrichment
        assert _switches(listing) == {
            cls.manifest().config_key: cls.enabled_by_config(real)
            for cls in state.enrichment_registry.classes()
        }
    finally:
        client.post("/api/demo/disable")


def test_demo_save_changes_the_sandbox_only_and_the_listing_shows_it(client) -> None:
    state = _mount(client)
    _enable_seeded(client)
    real_before = state.prefs.enrichment.model_dump(mode="json")
    try:
        stack = state._demo  # noqa: SLF001
        # The frozen-override case the finding saw: the Demo tuner (or any execution
        # write) has stored its snapshot, with lookups forced off inside it.
        client.portal.call(lambda: stack.mutate_execution_prefs(lambda p: p))
        assert stack._prefs_override is not None  # noqa: SLF001

        for body in ({"use_spamhaus": True}, {"fusion_enabled": True},
                     {"use_cymru_mhr": True}, {"use_cymru_mhr": False},
                     {"cache_ttl_seconds": 120}):
            response = _put(client, body)
            assert response.status_code == 200, (body, response.text)
            assert response.json()["changed"] is True and response.json()["demo_active"] is True
        listing = _listing(client)
        switches = _switches(listing)
        assert switches["use_spamhaus"] is True and switches["use_cymru_mhr"] is False
        assert listing["fusion_enabled"] is True
        assert listing["cache_ttl_seconds"] == 120

        # The real settings never moved, and lookups stay off in the sandbox.
        assert state.prefs.enrichment.model_dump(mode="json") == real_before
        stored = client.get("/api/settings").json()["prefs"]["enrichment"]
        assert stored == real_before
        execution = state.execution_prefs.enrichment
        assert execution.enabled is False
        assert execution.use_spamhaus is True and execution.fusion_enabled is True

        # Rows: in the Demo audit, none in the real log.
        demo_rows = _settings_rows(client, state.demo_audit)
        assert len(demo_rows) == 5
        assert all(r["action"] == "settings.updated" for r in demo_rows)
        assert _settings_rows(client, state.control_audit) == []
    finally:
        client.post("/api/demo/disable")
    # Demo Mode ended: the sandbox copy is gone and the page shows the real settings.
    listing = _listing(client)
    assert listing["demo_active"] is False
    assert _switches(listing)["use_spamhaus"] is real_before["use_spamhaus"]
    assert listing["fusion_enabled"] is real_before["fusion_enabled"]
    assert state.prefs.enrichment.model_dump(mode="json") == real_before


def test_demo_master_switch_round_trips_while_lookups_stay_off(client) -> None:
    """The master switch that always read Off: turning it off and on again in Demo Mode
    shows each saved value, and no save is a no-op that claims an update."""
    state = _mount(client)
    _enable_seeded(client)
    try:
        off = _put(client, {"enabled": False})
        assert off.status_code == 200 and off.json()["changed"] is True, off.text
        assert _listing(client)["enrichment_enabled"] is False
        on = _put(client, {"enabled": True})
        assert on.status_code == 200 and on.json()["changed"] is True, on.text
        assert _listing(client)["enrichment_enabled"] is True
        assert state.execution_prefs.enrichment.enabled is False
        rows = _settings_rows(client, state.demo_audit)
        assert [
            {c["field"]: (c["before"], c["after"]) for c in r["changes"]} for r in
            sorted(rows, key=lambda r: r["ts"])
        ] == [
            {"enrichment.enabled": ("true", "false")},
            {"enrichment.enabled": ("false", "true")},
        ]
        assert state.prefs.enrichment.enabled is True
    finally:
        client.post("/api/demo/disable")


def test_demo_lookup_says_no_provider_is_queried(client, monkeypatch) -> None:
    state = _mount(client)

    async def forbidden(*_args: Any, **_kwargs: Any) -> list[Any]:
        raise AssertionError("Demo Mode must never query a provider")

    monkeypatch.setattr(routes_enrichment, "_dispatch", forbidden)
    _enable_seeded(client)
    try:
        # Even with every switch on in the sandbox.
        assert _put(client, {"enabled": True, "use_rdap": True}).status_code == 200
        response = client.get("/api/enrichment/lookup", params={"indicator": "8.8.8.8"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["queried"] == 0 and body["not_queried"] == "demo_mode"
    finally:
        client.post("/api/demo/disable")
    assert state.demo_active is False


def test_lookup_with_the_master_switch_off_says_so(client, monkeypatch) -> None:
    _mount(client)

    async def forbidden(*_args: Any, **_kwargs: Any) -> list[Any]:
        raise AssertionError("a disabled enrichment must not query a provider")

    monkeypatch.setattr(routes_enrichment, "_dispatch", forbidden)
    assert _put(client, {"enabled": False}).status_code == 200
    body = client.get("/api/enrichment/lookup", params={"indicator": "8.8.8.8"}).json()
    assert body["queried"] == 0 and body["not_queried"] == "disabled"


def test_lookup_that_queries_reports_no_reason(client, monkeypatch) -> None:
    _mount(client)

    async def none_found(*_args: Any, **_kwargs: Any) -> list[Any]:
        return []

    monkeypatch.setattr(routes_enrichment, "_dispatch", none_found)
    body = client.get("/api/enrichment/lookup", params={"indicator": "8.8.8.8"}).json()
    assert body["not_queried"] is None


def test_demo_mode_turned_off_after_a_demo_row_saves_nothing_real(client, monkeypatch) -> None:
    """A Demo edit whose action row is in the Demo audit when Demo Mode ends: refused
    with ``409 demo_mode_changed``, never re-applied to the real settings."""
    state = _mount(client)
    _enable_seeded(client)
    real_before = state.prefs.enrichment.model_dump(mode="json")
    demo_audit = state.demo_audit
    appended = demo_audit.record_strict
    seen: list[tuple[str, str]] = []

    async def _append_then_turn_demo_off(**kwargs: Any) -> Any:
        if str(kwargs.get("action", "")).startswith("settings."):
            seen.append((kwargs.get("action"), kwargs.get("outcome")))
        result = await appended(**kwargs)
        if kwargs.get("action") == "settings.updated":
            await state.disable_demo()
        return result

    monkeypatch.setattr(demo_audit, "record_strict", _append_then_turn_demo_off)
    try:
        response = _put(client, {"use_spamhaus": True})
    finally:
        if state.demo_active:
            client.post("/api/demo/disable")
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "demo_mode_changed"
    assert state.prefs.enrichment.model_dump(mode="json") == real_before
    assert seen == [("settings.updated", "success"), ("settings.update_failed", "failure")]
    assert _settings_rows(client, state.control_audit) == []


def test_demo_mode_turned_on_after_a_real_row_changes_nothing(client, monkeypatch) -> None:
    """A real edit whose action row is in the real log when Demo Mode starts: refused,
    so it lands neither in the real settings nor in the new sandbox."""
    state = _mount(client)
    real_before = state.prefs.enrichment.model_dump(mode="json")
    appended = state.control_audit.record_strict
    started: dict[str, bool] = {}

    async def _append_then_turn_demo_on(**kwargs: Any) -> Any:
        result = await appended(**kwargs)
        if kwargs.get("action") == "settings.updated" and not started:
            started["done"] = True
            await state.enable_demo(history_days=2)
        return result

    monkeypatch.setattr(state.control_audit, "record_strict", _append_then_turn_demo_on)
    try:
        response = _put(client, {"use_spamhaus": True})
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "demo_mode_changed"
        assert state.enrichment_settings.use_spamhaus is False  # the new sandbox
    finally:
        if state.demo_active:
            client.post("/api/demo/disable")
    assert state.prefs.enrichment.model_dump(mode="json") == real_before
    rows = sorted(_settings_rows(client, state.control_audit), key=lambda r: r["ts"])
    assert [(r["action"], r["outcome"]) for r in rows] == [
        ("settings.updated", "success"), ("settings.update_failed", "failure"),
    ]


# --------------------------------------------------------------------------- #
# The DemoStack primitive
# --------------------------------------------------------------------------- #
def _stack(real: dict[str, Preferences]) -> DemoStack:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="")
    return DemoStack(secrets, lambda: real["prefs"], run_id="enrichment-test")


@pytest.mark.asyncio
async def test_sandbox_settings_follow_the_real_block_until_the_first_demo_edit() -> None:
    real = {"prefs": Preferences()}
    stack = _stack(real)
    assert stack.enrichment_settings() is real["prefs"].enrichment

    # A real change before any Demo edit is followed live.
    real["prefs"] = real["prefs"].model_copy(update={
        "enrichment": real["prefs"].enrichment.model_copy(update={"use_crt_sh": True}),
    })
    assert stack.enrichment_settings().use_crt_sh is True

    saved = await stack.mutate_enrichment_settings(
        lambda cfg: cfg.model_copy(update={"use_robtex": True}))
    assert saved.use_robtex is True and saved.use_crt_sh is True
    # The real settings are untouched; the sandbox keeps its own copy from now on.
    assert real["prefs"].enrichment.use_robtex is False
    real["prefs"] = real["prefs"].model_copy(update={
        "enrichment": real["prefs"].enrichment.model_copy(update={"use_crt_sh": False}),
    })
    assert stack.enrichment_settings().use_crt_sh is True
    assert stack.enrichment_settings().use_robtex is True


@pytest.mark.asyncio
async def test_execution_copy_derives_from_the_sandbox_settings_with_lookups_off() -> None:
    real = {"prefs": Preferences()}
    stack = _stack(real)
    # An execution write freezes ``_prefs_override`` (with lookups forced off in it).
    await stack.mutate_execution_prefs(lambda p: p)
    assert stack._prefs_override is not None  # noqa: SLF001
    assert stack._prefs_override.enrichment.enabled is False  # noqa: SLF001
    # The settings the page shows are not that forced value.
    assert stack.enrichment_settings().enabled is True

    await stack.mutate_enrichment_settings(
        lambda cfg: cfg.model_copy(update={"fusion_enabled": True, "use_spamhaus": True}))
    execution = stack._demo_prefs().enrichment  # noqa: SLF001
    assert execution.enabled is False  # isolation: never a lookup in Demo Mode
    assert execution.fusion_enabled is True and execution.use_spamhaus is True

    # Turning the master switch on in the sandbox still never enables a lookup.
    await stack.mutate_enrichment_settings(
        lambda cfg: cfg.model_copy(update={"enabled": True}))
    assert stack.enrichment_settings().enabled is True
    assert stack._demo_prefs().enrichment.enabled is False  # noqa: SLF001
    assert stack._demo_event_prefs().enrichment.enabled is False  # noqa: SLF001


# --------------------------------------------------------------------------- #
# FX7d review fixes: the settings lock, the lifetime bound, model validation, the
# Demo run identity, the typed contract and audited provider keys
# --------------------------------------------------------------------------- #
def _lock(client, on: bool) -> None:
    response = client.put("/api/settings", json={"read_only_settings_mode": on})
    assert response.status_code == 200, response.text


def test_the_settings_lock_refuses_a_real_save_with_no_row(client) -> None:
    """These saves went through PUT /api/settings before Round 14, which refuses them
    while the lock is on; the dedicated route keeps that rule (a pre-check: no row)."""
    state = _mount(client)
    _lock(client, True)
    before = state.prefs.enrichment.model_dump(mode="json")
    for body in ({"use_spamhaus": True}, {"enabled": False}, {"cache_ttl_seconds": 60}):
        response = _put(client, body)
        assert response.status_code == 403, (body, response.text)
        assert response.json()["detail"] == "Settings are in read-only mode"
    assert state.prefs.enrichment.model_dump(mode="json") == before
    assert _settings_rows(client, state.control_audit) == []

    # Lifting the lock lets the next save through.
    _lock(client, False)
    response = _put(client, {"use_spamhaus": True})
    assert response.status_code == 200, response.text
    assert state.prefs.enrichment.use_spamhaus is True


def test_the_settings_lock_also_holds_in_demo_mode(client) -> None:
    """The lock is real state and can be turned on while Demo Mode runs: the sandbox's
    copy cannot be changed under it either, and no row is written in either log."""
    state = _mount(client)
    _enable_seeded(client)
    try:
        _lock(client, True)
        sandbox_before = state.enrichment_settings.model_dump(mode="json")
        response = _put(client, {"use_spamhaus": True})
        assert response.status_code == 403, response.text
        assert state.enrichment_settings.model_dump(mode="json") == sandbox_before
        assert _settings_rows(client, state.demo_audit) == []
        assert _settings_rows(client, state.control_audit) == []
        _lock(client, False)
        assert _put(client, {"use_spamhaus": True}).status_code == 200
        assert state.enrichment_settings.use_spamhaus is True
    finally:
        client.post("/api/demo/disable")


def test_a_lock_turned_on_after_the_row_refuses_the_save(client, monkeypatch) -> None:
    """The lock is read again in the store's own step: turned on between the action row
    and the save, it refuses the save, and the failure row says it was not applied."""
    state = _mount(client)
    appended = state.control_audit.record_strict
    locked: dict[str, bool] = {}

    async def _append_then_lock(**kwargs: Any) -> Any:
        result = await appended(**kwargs)
        if kwargs.get("action") == "settings.updated" and not locked:
            locked["done"] = True
            await state.mutate_prefs(
                lambda p: p.model_copy(update={"read_only_settings_mode": True}))
        return result

    monkeypatch.setattr(state.control_audit, "record_strict", _append_then_lock)
    response = _put(client, {"use_spamhaus": True})
    assert response.status_code == 403, response.text
    assert state.prefs.enrichment.use_spamhaus is False
    rows = sorted(_settings_rows(client, state.control_audit), key=lambda r: r["ts"])
    assert [(r["action"], r["outcome"]) for r in rows] == [
        ("settings.updated", "success"), ("settings.update_failed", "failure"),
    ]


@pytest.mark.parametrize("value", [
    10 ** 30, routes_enrichment.CACHE_TTL_MAX_SECONDS + 1,
])
def test_a_cache_lifetime_beyond_the_bound_is_refused(client, value: int) -> None:
    state = _mount(client)
    before = state.prefs.enrichment.cache_ttl_seconds
    response = _put(client, {"cache_ttl_seconds": value})
    assert response.status_code == 422, response.text
    assert "from 0 to 2592000 (30 days)" in response.json()["detail"]
    assert state.prefs.enrichment.cache_ttl_seconds == before
    assert _settings_rows(client, state.control_audit) == []


def test_the_longest_cache_lifetime_saves(client) -> None:
    state = _mount(client)
    bound = routes_enrichment.CACHE_TTL_MAX_SECONDS
    assert bound == 30 * 24 * 3600
    response = _put(client, {"cache_ttl_seconds": bound})
    assert response.status_code == 200, response.text
    assert state.prefs.enrichment.cache_ttl_seconds == bound


def test_the_edit_runs_the_models_own_validation(client, monkeypatch) -> None:
    """The edit is built through ``EnrichmentConfig.model_validate``, so a constraint
    the model declares is enforced by this route too (422, no row)."""
    from pydantic import Field

    from app.config import EnrichmentConfig

    class _Stricter(EnrichmentConfig):
        cache_ttl_seconds: int = Field(default=21600, le=3600)

    state = _mount(client)
    monkeypatch.setattr(routes_enrichment, "EnrichmentConfig", _Stricter)
    response = _put(client, {"cache_ttl_seconds": 7200})
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith("Invalid enrichment settings:")
    assert state.prefs.enrichment.cache_ttl_seconds == 21600
    assert _settings_rows(client, state.control_audit) == []


def test_the_listing_and_the_save_name_the_demo_run(client) -> None:
    """A reset keeps Demo Mode on but starts a new run with a fresh copy: the run id in
    the listing and in a save tells a page which run its switches belong to."""
    state = _mount(client)
    assert _listing(client)["demo_run_id"] is None
    off_save = _put(client, {"use_robtex": True})
    assert off_save.json()["demo_run_id"] is None
    real_robtex = state.prefs.enrichment.use_robtex
    _enable_seeded(client)
    try:
        first = state.demo_run_id
        assert first
        listing = _listing(client)
        assert listing["demo_active"] is True and listing["demo_run_id"] == first
        saved = _put(client, {"use_spamhaus": True})
        assert saved.status_code == 200, saved.text
        assert saved.json()["demo_run_id"] == first
        assert _switches(_listing(client))["use_spamhaus"] is True

        reset = client.post("/api/demo/reset")
        assert reset.status_code == 200, reset.text
        second = state.demo_run_id
        assert second and second != first
        listing = _listing(client)
        assert listing["demo_run_id"] == second
        # The new run's copy follows the real settings again.
        assert _switches(listing)["use_spamhaus"] is state.prefs.enrichment.use_spamhaus
        assert _switches(listing)["use_robtex"] is real_robtex
    finally:
        client.post("/api/demo/disable")


def test_the_save_answers_its_typed_contract(client) -> None:
    """``PUT /api/enrichment/config`` documents its body (one boolean per switch, the
    bounded lifetime, nothing else) and answers ``EnrichmentConfigSaveResult``."""
    from app.config import EnrichmentConfig

    _mount(client)
    spec = client.app.openapi()
    operation = spec["paths"]["/api/enrichment/config"]["put"]
    body = operation["requestBody"]["content"]["application/json"]["schema"]
    assert body["additionalProperties"] is False and body["minProperties"] == 1
    assert set(body["properties"]) == set(EnrichmentConfig.model_fields)
    assert body["properties"]["cache_ttl_seconds"] == {
        "type": "integer", "minimum": 0,
        "maximum": routes_enrichment.CACHE_TTL_MAX_SECONDS,
    }
    assert body["properties"]["use_spamhaus"] == {"type": "boolean"}
    answer = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert answer["$ref"].endswith("/EnrichmentConfigSaveResult")
    result = spec["components"]["schemas"]["EnrichmentConfigSaveResult"]
    assert set(result["properties"]) == {"ok", "changed", "demo_active", "demo_run_id", "config"}
    response = _put(client, {"use_spamhaus": True})
    assert set(response.json()) == {"ok", "changed", "demo_active", "demo_run_id", "config"}


# --------------------------------------------------------------------------- #
# Provider keys: real secrets, audited first in the real log (SPEC §3.5, §3.6)
# --------------------------------------------------------------------------- #
def _secret_rows(client, repo: Any) -> list[dict[str, Any]]:
    return [r for r in _rows(client, repo)
            if str(r.get("action", "")).startswith("enrichment.secrets")]


def _set_keys(client, name: str, secrets: dict[str, Any]):
    return client.post(f"/api/enrichment/providers/{name}/secrets", json={"secrets": secrets})


@pytest.mark.parametrize("demo", [False, True])
def test_a_provider_key_is_audited_first_in_the_real_log(client, demo: bool) -> None:
    state = _mount(client)
    if demo:
        _enable_seeded(client)
    try:
        response = _set_keys(client, "virustotal", {"virustotal_api_key": "vt-SECRET-123"})
        assert response.status_code == 200, response.text
        assert state.secrets.virustotal_api_key == "vt-SECRET-123"
        cleared = _set_keys(client, "virustotal", {"virustotal_api_key": None})
        assert cleared.status_code == 200, cleared.text
        assert state.secrets.virustotal_api_key is None
        rows = sorted(_secret_rows(client, state.control_audit), key=lambda r: r["ts"])
        assert [(r["action"], r["outcome"]) for r in rows] == [
            ("enrichment.secrets_updated", "success"),
            ("enrichment.secrets_updated", "success"),
        ]
        row = rows[0]
        assert row["target"]["type"] == "setting"
        assert row["target"]["id"] == "enrichment.providers[virustotal]"
        assert row["target"]["label"] == "VirusTotal"
        assert row["changes"] == [{
            "field": "enrichment.providers[virustotal].secrets.virustotal_api_key",
            "before": None, "after": None, "secret": True,
        }]
        assert row["result_summary"] == (
            "credentials of enrichment provider 'virustotal': virustotal_api_key set")
        assert rows[1]["result_summary"].endswith("virustotal_api_key cleared")
        # Never the value, anywhere in either row.
        assert all("vt-SECRET-123" not in str(r) for r in rows)
        if demo:
            assert _secret_rows(client, state.demo_audit) == []
    finally:
        if demo:
            client.post("/api/demo/disable")
    # A key saved while Demo Mode was on is real: it outlives Demo Mode.
    assert state.secrets.virustotal_api_key is None


def test_a_provider_key_is_not_changed_when_its_row_cannot_be_written(client, monkeypatch) -> None:
    state = _mount(client)

    async def _down(**_kwargs: Any) -> None:
        raise RuntimeError("audit store unreachable")

    monkeypatch.setattr(state.control_audit, "record_strict", _down)
    response = _set_keys(client, "virustotal", {"virustotal_api_key": "vt-key"})
    assert response.status_code == 503, response.text
    assert response.json()["detail"]["code"] == "audit_unavailable"
    assert state.secrets.virustotal_api_key in (None, "")


def test_a_provider_key_body_with_no_key_writes_no_row(client) -> None:
    state = _mount(client)
    response = _set_keys(client, "virustotal", {})
    assert response.status_code == 200, response.text
    assert _secret_rows(client, state.control_audit) == []


def test_a_refused_provider_key_writes_no_row(client) -> None:
    state = _mount(client)
    assert _set_keys(client, "virustotal", {"bogus": "x"}).status_code == 400
    assert _set_keys(client, "nope", {"x": "y"}).status_code == 404
    assert _secret_rows(client, state.control_audit) == []


def test_a_provider_key_is_not_refused_by_the_settings_lock(client) -> None:
    """Provider keys are credentials, handled like source and notification channel
    credentials: the server does not check the settings lock for them, and only the
    Console disables the key fields while the lock is on. The SPEC §11.1 FX7d record
    and the permissions reference say exactly this, so a change that starts locking
    keys on the server must update both records with this test. The key save stays
    audited under the lock."""
    state = _mount(client)
    _lock(client, True)
    try:
        response = _set_keys(client, "virustotal", {"virustotal_api_key": "vt-locked"})
        assert response.status_code == 200, response.text
        assert state.secrets.virustotal_api_key == "vt-locked"
        rows = _secret_rows(client, state.control_audit)
        assert [(r["action"], r["outcome"]) for r in rows] == [
            ("enrichment.secrets_updated", "success"),
        ]
        assert "vt-locked" not in str(rows)
        # The switches stay locked meanwhile: only the credential route is outside it.
        assert _put(client, {"use_spamhaus": True}).status_code == 403
    finally:
        assert _set_keys(client, "virustotal", {"virustotal_api_key": None}).status_code == 200
        _lock(client, False)
    assert state.secrets.virustotal_api_key is None
