"""Round 14 A4b-2: the audit record fields of every other writer.

SPEC §4.5.3 (record additions), §4.5.4 (the A4b-2 writers), §3.5 (sinks), §3.6 (audit
before visible) and §7.10 (a settings change, an export and a reset each produce a row
with every applicable new field; secrets and webhook URLs never appear in ``changes``;
a forged forwarded header never becomes ``client.ip``).

Covers, offline (fake Elasticsearch, mock model):

* the curated settings routers (threshold tuning, baseline, discounted inference,
  campaigns, the AI budget) write one ``settings.updated`` row with the changed fields,
  the request's context and the setting as target, before the save;
* the execution settings (tuning, baseline, batch, campaigns) follow Demo Mode: their
  rows go to the Demo audit while it is on, the real settings and the real log stay
  untouched, while real state (the budget, rules, models, dashboards) is audited in the
  real log whatever the Demo state;
* tuning apply and rollback, campaign re-correlation, model pricing and self-hosted
  models, a notification channel credential, the first-run account, personal
  dashboards, detection, correlation and case-automation rules (create, update, enable,
  disable, delete, rollback) and analyst rule policies each write their structured row;
* audit-first: when the row cannot be appended the change answers ``503
  audit_unavailable`` and nothing changes; a refused store write appends its
  ``*_failed`` row paired by request id;
* data exports (legacy, archive job, segment), the operator's system update rows
  (intent, result, with who asked from where) and reset job rows (started, completed,
  failed; the factory receipt sanitized) carry the new fields;
* keyed rows stay retry-safe: a same-key update retry as a new request appends its own
  rows (an exact resend confirms its first ones), the supervisor's terminal rows keep
  their pre-Round-14 shape so any build can replay them, and a resumed reset repeats
  its rows even when the actor's role changed in between;
* every writer's row lands in the audit log its state belongs to, with Demo Mode on
  and off (SPEC §3.5), and Demo Mode turned on or off while a write of Demo-swapped
  state runs never lets the change cross into the other stack (``409
  demo_mode_changed``, the rows paired in the log the action row was written to);
* a settings save that lost a race marks its retry row (``{"attempt": 2, "of": 3}``);
* every new action is categorised by the event table (People and settings scope).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import (
    routes_analyst_policy,
    routes_baseline,
    routes_batch,
    routes_campaigns,
    routes_dashboards,
    routes_export,
    routes_models,
    routes_notifications,
    routes_rules,
    routes_setup,
    routes_tuning,
    routes_updates,
)
from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.audit import events
from app.audit.context import REQUEST_ID_HEADER, configure_trusted_proxies
from app.audit.write import failure_action
from app.config import NotificationChannelConfig, Secrets
from app.constants import ActionType, JobKind, ResetScope, UserRole
from app.engine.jobs import account_generation, reset_audit_target
from app.engine.update_audit import audit_terminal_job
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import Job, JobProgress, JobTransition
from app.state import AppState
from app.stores.jobs import idempotency_hash
from tests.test_round4_wave4_tuning_batch_routes import _TUNE_CFG, _fp_case
from tests.test_system_updates import _IDEMPOTENCY, _FakeUpdateService, _job, _status

_JWT_SECRET = "a4b2-record-fields-secret"
# The fields only a request-driven writer records (SPEC §4.5.3). A keyed row is appended
# again by every retry or resumed job, so it never carries one of them.
_PER_REQUEST_FIELDS = ("request_id", "client", "session_ref", "actor_role")
_PEER_HEADER = "x-test-peer"
_DIRECT_PEER = "203.0.113.7"
_ROUTERS = (
    routes_analyst_policy, routes_baseline, routes_batch, routes_campaigns,
    routes_dashboards, routes_export, routes_models, routes_notifications, routes_rules,
    routes_setup, routes_tuning, routes_updates,
)


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #
class _PeerShim:
    """Test-only ASGI wrapper: a request may name its socket peer in ``x-test-peer``
    (the TestClient's own peer is the non-address ``testclient``)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope.get("type") == "http":
            for key, value in scope.get("headers") or []:
                if key == _PEER_HEADER.encode():
                    scope = dict(scope)
                    scope["client"] = (value.decode(), 40000)
                    break
        await self.app(scope, receive, send)


@pytest.fixture(autouse=True)
def _trusted_proxies():
    """The proxies these tests trust: one address range (no DNS)."""
    from app.audit import context as audit_context_module

    previous = audit_context_module._TRUSTED
    configure_trusted_proxies("172.30.0.0/16")
    yield
    audit_context_module._TRUSTED = previous


def _app(*, seed_admin: bool = True, setup_complete: bool = True) -> tuple[FastAPI, Any]:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret=_JWT_SECRET, auth_seed_admin=seed_admin,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={
            "setup_complete": setup_complete, "threshold_tuning": _TUNE_CFG,
        })
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    for module in _ROUTERS:
        api.include_router(module.router, dependencies=[Depends(require_auth)])
    api.add_middleware(RequestIdMiddleware)
    return api, _PeerShim(api)


def _client(**kwargs: Any) -> tuple[TestClient, FastAPI]:
    api, shim = _app(**kwargs)
    return TestClient(shim), api


def _state(api: FastAPI) -> AppState:
    return api.state.tlsoc


def _rows(client: TestClient, api: FastAPI, *, repo: Any = None) -> list[dict[str, Any]]:
    store = repo if repo is not None else _state(api).control_audit
    return client.portal.call(lambda: store.records(limit=1000))


def _by_action(rows: list[dict[str, Any]], action: str) -> list[dict[str, Any]]:
    return [r for r in rows if r.get("action") == action]


def _one(rows: list[dict[str, Any]], action: str) -> dict[str, Any]:
    found = _by_action(rows, action)
    assert len(found) == 1, (action, [r.get("action") for r in rows])
    return found[0]


def _admin(client: TestClient) -> dict[str, str]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _fresh(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post("/api/auth/reauth", json={"password": "Admin@123"}, headers=auth)
    assert response.status_code == 200, response.text


def _headers(auth: dict[str, str], request_id: str, **extra: str) -> dict[str, str]:
    """The admin's credential, a request id and a direct peer that sends a forged
    forwarded header (which must never become the recorded address)."""
    return {**auth, REQUEST_ID_HEADER: request_id, _PEER_HEADER: _DIRECT_PEER,
            "X-Forwarded-For": "6.6.6.6", "User-Agent": "a4b2-test/1.0", **extra}


def _assert_request_fields(row: dict[str, Any], request_id: str, *, outcome: str = "success",
                           peer: str = _DIRECT_PEER) -> None:
    """Every request-driven field of SPEC §4.5.3 on an admin's row."""
    assert row["outcome"] == outcome
    assert row["actor"] == "Admin" and row["actor_type"] == "human"
    assert row["actor_role"] == "super_admin"
    assert isinstance(row.get("session_ref"), str) and len(row["session_ref"]) == 16
    assert row["request_id"] == request_id
    assert row["client"]["ip"] == peer and row["client"]["ip_source"] == "peer"
    assert row["client"]["peer"] == peer
    assert row["client"]["user_agent"] == "a4b2-test/1.0"


def _break_strict_appends(monkeypatch: pytest.MonkeyPatch, state: AppState) -> None:
    """Every strict audit append fails (the audit store is down)."""

    async def _down(**_kwargs: Any) -> None:
        raise RuntimeError("audit store unreachable")

    monkeypatch.setattr(state.control_audit, "record_strict", _down)


def _target(row: dict[str, Any]) -> dict[str, Any]:
    """The row's target without an unset revision (these targets have none)."""
    target = dict(row.get("target") or {})
    if target.get("revision") is None:
        target.pop("revision", None)
    return target


_MATCH = {"field": "event.action", "op": "equals", "value": "login_failed"}


def _field(row: dict[str, Any], name: str) -> dict[str, Any]:
    match = [c for c in row.get("changes") or [] if c["field"] == name]
    assert match, (name, [c["field"] for c in row.get("changes") or []])
    return match[0]


# --------------------------------------------------------------------------- #
# Curated settings routers
# --------------------------------------------------------------------------- #
def test_curated_settings_writes_record_what_changed_with_the_request_context() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        writes = [
            ("PUT", "/api/tuning/config", {**_TUNE_CFG.model_dump(mode="json"), "min_samples": 9},
             "settings-tuning-1", "threshold_tuning", "tuning", ActionType.TUNING.value,
             "threshold_tuning.min_samples", "tuning_config_update: "),
            ("PUT", "/api/baseline/config", {"half_life_days": 21.0},
             "settings-baseline-1", "baseline", "baseline", ActionType.USER_MGMT.value,
             "baseline.half_life_days", "baseline_config_update: "),
            ("PUT", "/api/batch/config", {"severity_floor": 4},
             "settings-batch-1", "batch", "batch", ActionType.USER_MGMT.value,
             "batch.severity_floor", "batch_config_update: "),
            ("PUT", "/api/campaigns/config", {"cadence": "weekly"},
             "settings-campaign-1", "campaign", "campaigns", ActionType.USER_MGMT.value,
             "campaign.cadence", "campaign_config_update: "),
            ("PUT", "/api/budget", {"enabled": True, "daily_usd": 25.0, "monthly_usd": 400.0,
                                    "on_exceed": "block"},
             "settings-budget-1", "budget", "models", ActionType.USER_MGMT.value,
             "budget.daily_usd", "budget_update: budget enabled=True daily=$25.0"),
        ]
        for method, path, body, rid, target_id, surface, action_type, field, summary in writes:
            response = client.request(method, path, json=body, headers=_headers(auth, rid))
            assert response.status_code == 200, (path, response.text)
            assert response.headers[REQUEST_ID_HEADER] == rid
        rows = _rows(client, api)
    settings_rows = {r["request_id"]: r for r in _by_action(rows, "settings.updated")}
    for _m, path, _b, rid, target_id, surface, action_type, field, summary in writes:
        row = settings_rows[rid]
        _assert_request_fields(row, rid)
        assert row["surface"] == surface and row["action_type"] == action_type, path
        assert row["target"]["type"] == "setting" and row["target"]["id"] == target_id
        _field(row, field)
        assert row["result_summary"].startswith(summary), row["result_summary"]
        # Real tenant settings off Demo Mode: the real audit log.
        assert row["client"]["forwarded_for"] == "6.6.6.6"
    assert settings_rows["settings-budget-1"]["changes"][0]["before"] is not None


def test_a_forged_forwarded_header_counts_only_through_a_trusted_proxy() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        direct = client.put("/api/rules/detection/brute_force", json={"name": "brute_force", "match": _MATCH},
                            headers=_headers(auth, "forged-direct-1"))
        proxied = client.put(
            "/api/rules/detection/brute_force",
            json={"name": "brute_force", "match": _MATCH, "priority": 3},
            headers={**auth, REQUEST_ID_HEADER: "forged-proxy-1", _PEER_HEADER: "172.30.0.4",
                     "X-Forwarded-For": "6.6.6.6, 198.51.100.9"},
        )
        assert direct.status_code == 200 and proxied.status_code == 200
        rows = _rows(client, api)
    by_rid = {r.get("request_id"): r for r in rows}
    assert by_rid["forged-direct-1"]["client"]["ip"] == _DIRECT_PEER
    assert by_rid["forged-direct-1"]["client"]["ip_source"] == "peer"
    assert by_rid["forged-proxy-1"]["client"]["ip"] == "198.51.100.9"
    assert by_rid["forged-proxy-1"]["client"]["ip_source"] == "trusted_proxy"
    for row in rows:
        assert (row.get("client") or {}).get("ip") != "6.6.6.6"


def test_execution_settings_follow_demo_mode_and_real_state_stays_in_the_real_log() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        real_min_samples = state.prefs.threshold_tuning.min_samples
        real_budget = state.prefs.budget.daily_usd
        client.portal.call(state.enable_demo)
        try:
            demo_audit = state.demo_audit
            tuning = client.put(
                "/api/tuning/config",
                json={**_TUNE_CFG.model_dump(mode="json"), "min_samples": 11},
                headers=_headers(auth, "demo-tuning-1"),
            )
            budget = client.put(
                "/api/budget",
                json={"enabled": True, "daily_usd": real_budget + 5, "monthly_usd": 500.0,
                      "on_exceed": "block"},
                headers=_headers(auth, "demo-budget-1"),
            )
            board = client.post(
                "/api/dashboards",
                json={"id": "dash-demo-era", "name": "Shift board", "widgets": []},
                headers=_headers(auth, "demo-board-1"),
            )
            assert tuning.status_code == budget.status_code == board.status_code == 200
            demo_rows = _rows(client, api, repo=demo_audit)
            real_rows = _rows(client, api)
            sandbox_min_samples = state.execution_prefs.threshold_tuning.min_samples
        finally:
            client.portal.call(state.disable_demo)
        after_rows = _rows(client, api)
        # The Demo-only tuning edit never reached the real settings.
        assert state.prefs.threshold_tuning.min_samples == real_min_samples
        assert sandbox_min_samples == 11
        assert state.prefs.budget.daily_usd == real_budget + 5
    demo_ids = {r.get("request_id") for r in demo_rows}
    real_ids = {r.get("request_id") for r in real_rows}
    assert "demo-tuning-1" in demo_ids and "demo-tuning-1" not in real_ids
    for rid in ("demo-budget-1", "demo-board-1"):
        assert rid in real_ids and rid not in demo_ids
        # Real rows outlive Demo Mode (the Demo store is dropped when it ends).
        assert rid in {r.get("request_id") for r in after_rows}


#: Every request-driven A4b-2 writer and the audit log its row belongs in (SPEC §3.5):
#: ``execution`` rows follow the active execution stack (the Demo audit while Demo Mode
#: is on, the real log otherwise); ``control`` rows record real state and always go to
#: the real log. ``body(n)`` varies the request so every call is a real change.
_SINK_WRITERS: list[tuple[str, str, str, Any, str]] = [
    ("tuning-config", "PUT", "/api/tuning/config",
     lambda n: {**_TUNE_CFG.model_dump(mode="json"), "min_samples": 11 + n}, "execution"),
    ("tuning-apply", "POST", "/api/tuning/noisy_rule/apply", lambda n: None, "execution"),
    ("tuning-rollback", "POST", "/api/tuning/noisy_rule/rollback", lambda n: None, "execution"),
    ("baseline-config", "PUT", "/api/baseline/config",
     lambda n: {"half_life_days": 21.0 + n}, "execution"),
    ("batch-config", "PUT", "/api/batch/config", lambda n: {"severity_floor": 3 + n}, "execution"),
    ("campaign-config", "PUT", "/api/campaigns/config",
     lambda n: {"cadence": ("weekly", "daily")[n]}, "execution"),
    ("campaign-recorrelate", "POST", "/api/campaigns/recorrelate", lambda n: None, "execution"),
    ("budget", "PUT", "/api/budget",
     lambda n: {"enabled": True, "daily_usd": 25.0 + n, "monthly_usd": 400.0,
                "on_exceed": "block"}, "control"),
    ("detection-rule", "PUT", "/api/rules/detection/brute_force",
     lambda n: {"name": "brute_force", "match": _MATCH, "priority": 2 + n}, "control"),
    ("analyst-policy", "PUT", "/api/rules/analyst-policies/new",
     lambda n: {"rule_id": f"noisy-{n}", "reason": "lab"}, "control"),
    ("model-pricing", "PUT", "/api/llm/models/gpt-x/pricing",
     lambda n: {"input_per_million": 1.0 + n, "output_per_million": 2.0}, "control"),
    ("custom-model", "POST", "/api/llm/models/custom",
     lambda n: {"model_id": f"local-llama-{n}", "base_url": "http://litellm:4000/v1"}, "control"),
    ("notification-secret", "POST", "/api/notifications/channels/ops/secret",
     lambda n: {"field": "secret", "value": f"hook-secret-{n}"}, "control"),
    ("dashboard", "POST", "/api/dashboards",
     lambda n: {"id": f"dash-sink-{n}", "name": "Shift board", "widgets": []}, "control"),
    ("export", "POST", "/api/admin/export", lambda n: {"scopes": ["configuration"]}, "control"),
]


@pytest.mark.parametrize("name, method, path, body, sink", _SINK_WRITERS,
                         ids=[w[0] for w in _SINK_WRITERS])
def test_every_writer_audits_in_the_log_its_state_belongs_to(
    monkeypatch, name: str, method: str, path: str, body: Any, sink: str,
) -> None:
    """SPEC §3.5: a change to Demo-swapped state is audited in the Demo audit while
    Demo Mode is on and leaves the real settings untouched; a change to real state is
    audited in the real log whatever the Demo state. Off Demo Mode both go to the real
    log. Each row is found by its request id."""
    # The tuning writers read a window of closed false positives for the rule.
    async def _window(_state: Any) -> list[Any]:
        return [_fp_case(i) for i in range(5)]

    monkeypatch.setattr(routes_tuning, "_window_cases", _window)
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        prefs = state.prefs
        channel = NotificationChannelConfig(id="ops", type="slack", name="Ops")
        client.portal.call(lambda: state.update_prefs(prefs.model_copy(update={
            "notifications": prefs.notifications.model_copy(update={"channels": [channel]}),
        })))

        def _call(n: int, rid: str) -> None:
            if name == "tuning-rollback":  # something applied to roll back
                applied = client.post("/api/tuning/noisy_rule/apply", headers=auth)
                assert applied.status_code == 200, applied.text
            response = client.request(method, path, json=body(n), headers=_headers(auth, rid))
            assert response.status_code == 200, (name, response.status_code, response.text)

        client.portal.call(state.enable_demo)
        try:
            real_prefs = state.prefs.model_dump(mode="json")
            _call(0, f"sink-{name}-demo")
            demo_ids = {r.get("request_id") for r in _rows(client, api, repo=state.demo_audit)}
            real_ids = {r.get("request_id") for r in _rows(client, api)}
            if sink == "execution":
                assert state.prefs.model_dump(mode="json") == real_prefs, name
        finally:
            client.portal.call(state.disable_demo)
        _call(1, f"sink-{name}-real")
        after_ids = {r.get("request_id") for r in _rows(client, api)}
    demo_rid = f"sink-{name}-demo"
    if sink == "execution":
        assert demo_rid in demo_ids and demo_rid not in real_ids, name
        assert demo_rid not in after_ids, name  # the Demo trail ended with Demo Mode
    else:
        assert demo_rid in real_ids and demo_rid not in demo_ids, name
        assert demo_rid in after_ids, name  # real rows outlive Demo Mode
    assert f"sink-{name}-real" in after_ids, name


#: Every writer of Demo-swapped state: (name, method, path, body, its action row, that
#: row's failure row). Demo Mode may be turned on or off by another request while one
#: of them runs (module doc of ``app.audit.settings_write``, "One execution stack per
#: write").
_EXECUTION_RACES: list[tuple[str, str, str, Any, str, str]] = [
    ("tuning-config", "PUT", "/api/tuning/config",
     {**_TUNE_CFG.model_dump(mode="json"), "min_samples": 17},
     "settings.updated", "settings.update_failed"),
    ("baseline-config", "PUT", "/api/baseline/config", {"half_life_days": 33.0},
     "settings.updated", "settings.update_failed"),
    ("batch-config", "PUT", "/api/batch/config", {"severity_floor": 4},
     "settings.updated", "settings.update_failed"),
    ("campaign-config", "PUT", "/api/campaigns/config", {"cadence": "weekly"},
     "settings.updated", "settings.update_failed"),
    ("campaign-recorrelate", "POST", "/api/campaigns/recorrelate", None,
     "campaign.recorrelated", "campaign.recorrelate_failed"),
    ("tuning-apply", "POST", "/api/tuning/noisy_rule/apply", None,
     "rule.tuning_requested", "rule.tuning_request_failed"),
    ("tuning-rollback", "POST", "/api/tuning/noisy_rule/rollback", None,
     "rule.tuning_rolled_back", "rule.tuning_rollback_failed"),
]


async def _noisy_window(_state: Any) -> list[Any]:
    """The closed false positives the tuning writers read for ``noisy_rule``."""
    return [_fp_case(i) for i in range(5)]


async def _stack_snapshot(prefs: Any, campaigns: Any, ledger: Any, approvals: Any) -> dict[str, Any]:
    """What a writer of Demo-swapped state can change in one stack: the settings (less
    the Demo switch itself), the campaigns, the tuning ledger and the approval queue."""
    settings = prefs.model_dump(mode="json")
    settings.pop("demo", None)
    page, _total = await campaigns.list()
    return {
        "settings": settings,
        "campaigns": sorted(c.id for c in page),
        "ledger": sorted((r.id, r.rolled_back) for r in await ledger.list_strict()),
        "approvals": sorted(x.id for x in await approvals.list()),
    }


async def _real_snapshot(state: AppState) -> dict[str, Any]:
    return await _stack_snapshot(state.prefs, state._real_campaign_store,  # noqa: SLF001
                                 state._real_tuning_store, state._real_proposals)  # noqa: SLF001


async def _sandbox_snapshot(state: AppState) -> dict[str, Any]:
    assert state.demo_active
    return await _stack_snapshot(state.execution_prefs, state.campaign_store,
                                 state.tuning_store, state.proposals)


def _refused_for_demo_mode(response: Any) -> None:
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "demo_mode_changed"
    assert detail["message"].startswith("Demo Mode was turned on or off while ")
    assert detail["message"].endswith("Try again.") and "\u2014" not in detail["message"]


@pytest.mark.parametrize("name, method, path, body, action, failure", _EXECUTION_RACES,
                         ids=[w[0] for w in _EXECUTION_RACES])
def test_demo_mode_turned_off_after_a_demo_row_changes_no_real_state(
    monkeypatch, name: str, method: str, path: str, body: Any, action: str, failure: str,
) -> None:
    """A Demo edit whose action row is in the Demo audit when another admin turns Demo
    Mode off: the save is refused (``409 demo_mode_changed``), never made in the real
    settings, campaigns, tuning ledger or approval queue, and nothing is said about it
    in the real log. Its rows are the action row and its failure row, both in the Demo
    audit, which ends with Demo Mode."""
    monkeypatch.setattr(routes_tuning, "_window_cases", _noisy_window)
    rid = f"demo-off-{name}"
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        client.portal.call(state.enable_demo)
        demo_rows: list[dict[str, Any]] = []
        try:
            if name == "tuning-rollback":  # something applied in the sandbox to roll back
                applied = client.post("/api/tuning/noisy_rule/apply", headers=auth)
                assert applied.status_code == 200 and applied.json()["applied"], applied.text
            real_before = client.portal.call(lambda: _real_snapshot(state))
            demo_audit = state.demo_audit
            appended = demo_audit.record_strict

            async def _append_then_turn_demo_off(**kwargs: Any) -> Any:
                demo_rows.append(kwargs)
                result = await appended(**kwargs)
                if kwargs.get("request_id") == rid and kwargs.get("action") == action:
                    await state.disable_demo()  # another admin, right after the row
                return result

            monkeypatch.setattr(demo_audit, "record_strict", _append_then_turn_demo_off)
            response = client.request(method, path, json=body, headers=_headers(auth, rid))
        finally:
            if state.demo_active:
                client.portal.call(state.disable_demo)
        _refused_for_demo_mode(response)
        assert client.portal.call(lambda: _real_snapshot(state)) == real_before, name
        assert not [r for r in _rows(client, api) if r.get("request_id") == rid]
    mine = [(r["action"], r["outcome"]) for r in demo_rows if r.get("request_id") == rid]
    assert mine == [(action, "success"), (failure, "failure")], name
    refusal = [r for r in demo_rows if r.get("request_id") == rid][1]
    assert refusal["result_summary"].startswith("demo_mode_changed: ")


@pytest.mark.parametrize("name, method, path, body, action, failure", _EXECUTION_RACES,
                         ids=[w[0] for w in _EXECUTION_RACES])
def test_demo_mode_turned_on_after_a_real_row_changes_nothing_in_either_stack(
    monkeypatch, name: str, method: str, path: str, body: Any, action: str, failure: str,
) -> None:
    """A real edit whose action row is in the real log when another admin turns Demo
    Mode on: the save is refused (``409 demo_mode_changed``) rather than landing in the
    sandbox. The real state is as it was, the sandbox is as Demo Mode made it, and the
    real log pairs the action row with its failure row under the request id."""
    monkeypatch.setattr(routes_tuning, "_window_cases", _noisy_window)
    rid = f"demo-on-{name}"
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        if name == "tuning-rollback":  # something applied to roll back
            applied = client.post("/api/tuning/noisy_rule/apply", headers=auth)
            assert applied.status_code == 200 and applied.json()["applied"], applied.text
        real_before = client.portal.call(lambda: _real_snapshot(state))
        sandbox: dict[str, Any] = {}
        appended = state.control_audit.record_strict

        async def _append_then_turn_demo_on(**kwargs: Any) -> Any:
            result = await appended(**kwargs)
            if (kwargs.get("request_id") == rid and kwargs.get("action") == action
                    and "at_enable" not in sandbox):
                await state.enable_demo()  # another admin, right after the row
                sandbox["at_enable"] = await _sandbox_snapshot(state)
            return result

        monkeypatch.setattr(state.control_audit, "record_strict", _append_then_turn_demo_on)
        try:
            response = client.request(method, path, json=body, headers=_headers(auth, rid))
            sandbox["after"] = client.portal.call(lambda: _sandbox_snapshot(state))
        finally:
            if state.demo_active:
                client.portal.call(state.disable_demo)
        _refused_for_demo_mode(response)
        real_after = client.portal.call(lambda: _real_snapshot(state))
        rows = sorted((r for r in _rows(client, api) if r.get("request_id") == rid),
                      key=lambda r: r["ts"])  # oldest first
    assert real_after == real_before, name
    assert sandbox["after"] == sandbox["at_enable"], name
    assert [(r["action"], r["outcome"]) for r in rows] == [
        (action, "success"), (failure, "failure"),
    ], name
    _assert_request_fields(rows[0], rid)
    assert rows[1]["result_summary"].startswith("demo_mode_changed: ")


@pytest.mark.asyncio
async def test_an_execution_stack_binds_its_log_and_refuses_a_write_once_demo_mode_moved() -> None:
    """The primitive every Demo-swapped writer uses: the audit log is the one of the
    generation it was bound in, and a guarded write checks the generation before it
    calls through, so the store the write picks is always the bound stack's."""
    from fastapi import HTTPException

    from app.audit.settings_write import ExecutionStack

    class _State:
        demo_generation = 4
        execution_audit = "real audit"

    state = _State()
    stack = ExecutionStack(state)
    state.execution_audit = "demo audit"
    assert stack.audit == "real audit" and not stack.moved()
    calls: list[int] = []

    async def _write(value: int) -> int:
        calls.append(value)
        return value

    guarded = stack.guard(_write)
    assert await guarded(1) == 1
    state.demo_generation = 5  # Demo Mode turned on (or off)
    assert stack.moved()
    with pytest.raises(HTTPException) as refused:
        await guarded(2)
    assert refused.value.status_code == 409
    assert refused.value.detail["code"] == "demo_mode_changed"
    assert calls == [1]  # the write never ran against the other stack
    with pytest.raises(HTTPException):
        stack.check()


def test_demo_mode_turned_off_while_proposals_are_processed_moves_no_real_threshold(
    monkeypatch,
) -> None:
    """Demo Mode ends after a sandbox apply has worked out its change and before the
    change is saved: the settings writer it calls picks the stack only when called, so
    it first checks that the stack is still the sandbox and refuses. No threshold moves
    in the real settings and the real ledger stays empty."""
    monkeypatch.setattr(routes_tuning, "_window_cases", _noisy_window)
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        handle = routes_tuning.tuner._handle_proposal

        async def _handle_then_turn_demo_off(*args: Any, **kwargs: Any) -> Any:
            result = await handle(*args, **kwargs)
            if state.demo_active:
                await state.disable_demo()
            return result

        monkeypatch.setattr(routes_tuning.tuner, "_handle_proposal", _handle_then_turn_demo_off)
        client.portal.call(state.enable_demo)
        try:
            real_before = client.portal.call(lambda: _real_snapshot(state))
            response = client.post("/api/tuning/noisy_rule/apply",
                                   headers=_headers(auth, "demo-mid-apply-1"))
        finally:
            if state.demo_active:
                client.portal.call(state.disable_demo)
        _refused_for_demo_mode(response)
        assert client.portal.call(lambda: _real_snapshot(state)) == real_before
        assert not [r for r in _rows(client, api) if r.get("request_id") == "demo-mid-apply-1"]


def test_demo_mode_turned_on_while_a_rollback_reads_its_record_restores_nothing(
    monkeypatch,
) -> None:
    """Demo Mode starts after a real rollback has read its ledger record and before it
    restores the threshold: the restore is refused, the real threshold and ledger stay
    as they were and the sandbox is untouched."""
    monkeypatch.setattr(routes_tuning, "_window_cases", _noisy_window)
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        applied = client.post("/api/tuning/noisy_rule/apply", headers=auth)
        assert applied.status_code == 200 and applied.json()["applied"], applied.text
        real_before = client.portal.call(lambda: _real_snapshot(state))
        ledger = state._real_tuning_store  # noqa: SLF001
        read = ledger.get_strict
        sandbox: dict[str, Any] = {}

        async def _read_then_turn_demo_on(*args: Any, **kwargs: Any) -> Any:
            record = await read(*args, **kwargs)
            if not state.demo_active and "at_enable" not in sandbox:
                await state.enable_demo()
                sandbox["at_enable"] = await _sandbox_snapshot(state)
            return record

        monkeypatch.setattr(ledger, "get_strict", _read_then_turn_demo_on)
        try:
            response = client.post("/api/tuning/noisy_rule/rollback",
                                   headers=_headers(auth, "demo-mid-rollback-1"))
            sandbox["after"] = client.portal.call(lambda: _sandbox_snapshot(state))
        finally:
            if state.demo_active:
                client.portal.call(state.disable_demo)
        _refused_for_demo_mode(response)
        assert client.portal.call(lambda: _real_snapshot(state)) == real_before
        rows = [r for r in _rows(client, api) if r.get("request_id") == "demo-mid-rollback-1"]
    assert sandbox["after"] == sandbox["at_enable"]
    assert sorted(r["action"] for r in rows) == [
        "rule.tuning_rollback_failed", "rule.tuning_rolled_back",
    ]


def test_system_update_rows_stay_in_the_real_log_in_demo_mode(monkeypatch) -> None:
    client, api, _service = _update_client(monkeypatch)
    with client:
        auth = _admin(client)
        state = _state(api)
        client.portal.call(state.enable_demo)
        try:
            response = client.post(
                "/api/system-updates/preflight", headers=_headers(auth, "sink-update-demo"),
                json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
            )
            assert response.status_code == 200, response.text
            demo_rows = _rows(client, api, repo=state.demo_audit)
        finally:
            client.portal.call(state.disable_demo)
        real_rows = _rows(client, api)
    for action in ("update.preflight_requested", "update.preflight_accepted"):
        assert not _by_action(demo_rows, action)
        _one(real_rows, action)


def test_settings_and_store_writes_are_refused_when_the_audit_cannot_be_written(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        before = state.prefs.model_dump(mode="json")
        _break_strict_appends(monkeypatch, state)
        attempts = [
            ("PUT", "/api/tuning/config", {**_TUNE_CFG.model_dump(mode="json"), "min_samples": 4}),
            ("PUT", "/api/baseline/config", {"half_life_days": 30.0}),
            ("PUT", "/api/batch/config", {"enabled": True}),
            ("PUT", "/api/campaigns/config", {"cadence": "weekly"}),
            ("PUT", "/api/budget", {"enabled": True, "daily_usd": 99.0, "monthly_usd": 99.0,
                                    "on_exceed": "block"}),
            ("PUT", "/api/rules/detection/new_rule", {"name": "new_rule", "match": _MATCH}),
            ("PUT", "/api/rules/correlation/new_rule", {"n": 4}),
            ("PUT", "/api/rules/analyst-policies/new", {"rule_id": "noisy", "reason": "lab"}),
            ("PUT", "/api/llm/models/gpt-x/pricing", {"input_per_million": 1.0,
                                                      "output_per_million": 2.0}),
            ("POST", "/api/llm/models/custom", {"model_id": "local-llama",
                                                "base_url": "http://litellm:4000/v1"}),
            ("POST", "/api/notifications/channels/ops/secret", {"field": "secret",
                                                                "value": "hook-secret"}),
            ("POST", "/api/dashboards", {"id": "dash-down", "name": "Down", "widgets": []}),
            ("POST", "/api/campaigns/recorrelate", None),
        ]
        for method, path, body in attempts:
            response = client.request(method, path, json=body, headers=auth)
            assert response.status_code == 503, (path, response.status_code, response.text)
            assert response.json()["detail"]["code"] == "audit_unavailable", path
        monkeypatch.undo()
        assert state.prefs.model_dump(mode="json") == before
        assert client.portal.call(lambda: state.price_overlay.get_model("gpt-x")) is None
        assert client.portal.call(lambda: state.custom_models.get_model("local-llama")) is None
        assert state.secrets.notification_channel_secrets("ops") == {}
        assert client.portal.call(lambda: state.dashboards.list_for_user("Admin")) == []


# --------------------------------------------------------------------------- #
# Tuning apply / rollback, campaigns
# --------------------------------------------------------------------------- #
def test_tuning_apply_and_rollback_are_audited_before_the_threshold_moves() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        for i in range(5):
            client.portal.call(lambda i=i: state.cases.save(_fp_case(i)))
        before_n = state.prefs.correlation_for("noisy_rule").n
        applied = client.post("/api/tuning/noisy_rule/apply", headers=_headers(auth, "tune-apply-1"))
        assert applied.status_code == 200, applied.text
        assert state.prefs.correlation_for("noisy_rule").n == before_n + 1
        rolled = client.post("/api/tuning/noisy_rule/rollback",
                             headers=_headers(auth, "tune-rollback-1"))
        assert rolled.status_code == 200, rolled.text
        refused = client.post("/api/tuning/noisy_rule/rollback",
                              headers=_headers(auth, "tune-rollback-2"))
        assert refused.status_code == 404  # nothing active: a pre-check, no row
        rows = _rows(client, api)
    apply_row = _one(rows, "rule.tuning_requested")
    _assert_request_fields(apply_row, "tune-apply-1")
    assert _target(apply_row) == {"type": "rule", "id": "noisy_rule", "label": "noisy_rule"}
    assert apply_row["action_type"] == ActionType.TUNING.value
    assert apply_row["result_summary"].startswith("tuning_apply: rule=noisy_rule proposals=")
    assert apply_row["tool_input"]["proposals"][0]["kind"] == "correlation_n"
    rollback_row = _one(rows, "rule.tuning_rolled_back")
    _assert_request_fields(rollback_row, "tune-rollback-1")
    assert rollback_row["changes"] == [{
        "field": "correlation_rules.noisy_rule.n", "before": str(before_n + 1),
        "after": str(before_n), "secret": False,
    }]
    assert not [r for r in rows if r.get("request_id") == "tune-rollback-2"]


def test_a_refused_rollback_pairs_its_failure_row_with_the_action_row(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        for i in range(5):
            client.portal.call(lambda i=i: state.cases.save(_fp_case(i)))
        assert client.post("/api/tuning/noisy_rule/apply", headers=auth).status_code == 200

        async def _stale(*_args: Any, **_kwargs: Any) -> bool:
            return False

        monkeypatch.setattr(routes_tuning.tuner, "rollback", _stale)
        response = client.post("/api/tuning/noisy_rule/rollback",
                               headers=_headers(auth, "tune-stale-1"))
        assert response.status_code == 409
        rows = [r for r in _rows(client, api) if r.get("request_id") == "tune-stale-1"]
    actions = sorted(r["action"] for r in rows)
    assert actions == ["rule.tuning_rollback_failed", "rule.tuning_rolled_back"]
    failed = _by_action(rows, "rule.tuning_rollback_failed")[0]
    assert failed["outcome"] == "failure" and "rollback could not be applied" in failed["result_summary"]


def test_a_review_first_tuning_request_is_not_recorded_as_an_applied_change() -> None:
    """Under the default review-first policy nothing is applied: the proposal only
    enters the approval queue. The operator's row says what was asked
    (``rule.tuning_requested``), never that a threshold moved."""
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        review_first = _TUNE_CFG.model_copy(update={"auto_apply_confirmed": False})
        client.portal.call(lambda: state.update_prefs(
            state.prefs.model_copy(update={"threshold_tuning": review_first})
        ))
        for i in range(5):
            client.portal.call(lambda i=i: state.cases.save(_fp_case(i)))
        before_n = state.prefs.correlation_for("noisy_rule").n
        response = client.post("/api/tuning/noisy_rule/apply", headers=_headers(auth, "tune-review-1"))
        assert response.status_code == 200, response.text
        assert response.json()["applied"] == [] and response.json()["queued_proposals"]
        assert state.prefs.correlation_for("noisy_rule").n == before_n
        rows = _rows(client, api)
    row = _one(rows, "rule.tuning_requested")
    _assert_request_fields(row, "tune-review-1")
    assert row["result_summary"] == "tuning_apply: rule=noisy_rule proposals=1"
    assert not [r for r in rows if "applied" in str(r.get("action") or "")]


def test_campaign_recorrelation_is_audited_and_a_failed_store_write_is_paired(monkeypatch) -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        ok = client.post("/api/campaigns/recorrelate", headers=_headers(auth, "recorrelate-1"))
        assert ok.status_code == 200, ok.text

        async def _store_down(_campaigns: Any) -> Any:
            raise RuntimeError("campaign store unavailable")

        monkeypatch.setattr(state.campaign_store, "replace_all", _store_down)
        failed = client.post("/api/campaigns/recorrelate", headers=_headers(auth, "recorrelate-2"))
        assert failed.status_code == 503
        rows = _rows(client, api)
    row = [r for r in _by_action(rows, "campaign.recorrelated") if r["request_id"] == "recorrelate-1"][0]
    _assert_request_fields(row, "recorrelate-1")
    assert row["result_summary"].startswith("campaigns_recorrelate: built 0 campaign(s)")
    assert row["tool_input"] == {"campaigns": 0, "case_links": 0}
    pair = [r for r in rows if r.get("request_id") == "recorrelate-2"]
    assert sorted(r["action"] for r in pair) == ["campaign.recorrelate_failed", "campaign.recorrelated"]
    # Every campaign row names the campaign settings (as the settings rows do), so one
    # target filter finds the settings changes and every rebuild, applied or not.
    for each in (row, *pair):
        assert _target(each) == {"type": "setting", "id": "campaign", "label": "Campaigns"}, \
            each["action"]


# --------------------------------------------------------------------------- #
# Models, notification credentials, first-run account
# --------------------------------------------------------------------------- #
def test_model_pricing_and_self_hosted_models_never_record_a_key() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        assert client.put("/api/llm/models/gpt-x/pricing", headers=_headers(auth, "price-0001"),
                          json={"input_per_million": 1.5, "output_per_million": 6.0}).status_code == 200
        assert client.delete("/api/llm/models/gpt-x/pricing",
                             headers=_headers(auth, "price-0002")).status_code == 200
        # Clearing an override that does not exist changes nothing and writes no row.
        assert client.delete("/api/llm/models/gpt-x/pricing",
                             headers=_headers(auth, "price-0003")).json()["removed"] is False
        added = client.post("/api/llm/models/custom", headers=_headers(auth, "model-0001"), json={
            "model_id": "local-llama", "base_url": "http://lab:hunter2@litellm:4000/v1",
            "label": "Lab Llama", "api_key": "sk-live-SECRETSECRETSECRET",
        })
        assert added.status_code == 200, added.text
        assert client.delete("/api/llm/models/custom/local-llama",
                             headers=_headers(auth, "model-0002")).status_code == 200
        assert state.secrets.litellm_api_key == "sk-live-SECRETSECRETSECRET"
        rows = _rows(client, api)
    priced = _one(rows, "model.pricing_updated")
    _assert_request_fields(priced, "price-0001")
    assert _target(priced) == {"type": "setting", "id": "model:gpt-x", "label": "gpt-x"}
    assert _field(priced, "pricing.input")["after"] == "1.5"
    cleared = _one(rows, "model.pricing_cleared")
    assert _field(cleared, "pricing.output")["before"] == "6.0"
    assert not [r for r in rows if r.get("request_id") == "price-0003"]
    model_row = _one(rows, "model.added")
    _assert_request_fields(model_row, "model-0001")
    assert _field(model_row, "secrets.litellm_api_key") == {
        "field": "secrets.litellm_api_key", "before": None, "after": None, "secret": True,
    }
    # An endpoint is recorded as scheme, host and port; the user:password@ and the
    # path are left out, which the entry says.
    assert _field(model_row, "custom_model.base_url") == {
        "field": "custom_model.base_url", "before": None, "after": "http://litellm:4000",
        "secret": True,
    }
    removed_row = _one(rows, "model.removed")
    assert _field(removed_row, "custom_model.base_url")["before"] == "http://litellm:4000"
    stored = json.dumps(rows)
    for leaked in ("SECRETSECRETSECRET", "hunter2", "lab:"):
        assert leaked not in stored


def test_a_model_endpoint_key_in_the_path_or_query_is_never_recorded() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        endpoint = "https://proxy.example.com/keys/pathsecret77/v1?api-key=abcd1234secret&x=1"
        added = client.post("/api/llm/models/custom", headers=_headers(auth, "endpoint-1"), json={
            "model_id": "proxy-llama", "base_url": endpoint,
        })
        assert added.status_code == 200, added.text
        # Rotating only the key in the query is still recorded as an endpoint change.
        rotated = client.post("/api/llm/models/custom", headers=_headers(auth, "endpoint-2"), json={
            "model_id": "proxy-llama", "base_url": endpoint.replace("abcd1234", "efgh5678"),
        })
        assert rotated.status_code == 200, rotated.text
        assert client.delete("/api/llm/models/custom/proxy-llama",
                             headers=_headers(auth, "endpoint-3")).status_code == 200
        rows = _rows(client, api)
    by_rid = {r.get("request_id"): r for r in rows}
    assert _field(by_rid["endpoint-1"], "custom_model.base_url") == {
        "field": "custom_model.base_url", "before": None,
        "after": "https://proxy.example.com", "secret": True,
    }
    assert by_rid["endpoint-1"]["result_summary"].startswith(
        "custom_model_add: added proxy-llama @ https://proxy.example.com (")
    assert by_rid["endpoint-2"]["action"] == "model.updated"
    assert _field(by_rid["endpoint-2"], "custom_model.base_url") == {
        "field": "custom_model.base_url", "before": "https://proxy.example.com",
        "after": "https://proxy.example.com", "secret": True,
    }
    assert _field(by_rid["endpoint-3"], "custom_model.base_url")["before"] == (
        "https://proxy.example.com")
    stored = json.dumps(rows)
    for leaked in ("abcd1234secret", "efgh5678secret", "api-key", "pathsecret77"):
        assert leaked not in stored, leaked


def test_a_notification_channel_credential_is_recorded_by_name_only() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        prefs = state.prefs
        channel = NotificationChannelConfig(id="slack-ops", type="slack", name="Ops alerts")
        client.portal.call(lambda: state.update_prefs(prefs.model_copy(update={
            "notifications": prefs.notifications.model_copy(update={"channels": [channel]}),
        })))
        response = client.post(
            "/api/notifications/channels/slack-ops/secret", headers=_headers(auth, "secret-1"),
            json={"field": "secret", "value": "https://hooks.slack.com/services/T0/B0/XSECRET"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["configured_secrets"] == ["secret"]
        assert state.prefs.notifications.channels[0].configured_secrets == ["secret"]
        rows = _rows(client, api)
    row = _one(rows, "notification.secrets_updated")
    _assert_request_fields(row, "secret-1")
    assert _target(row) == {"type": "setting", "id": "notifications.channels[slack-ops]",
                             "label": "Ops alerts"}
    assert row["changes"] == [{"field": "notifications.channels[slack-ops].secrets.secret",
                               "before": None, "after": None, "secret": True}]
    assert "XSECRET" not in json.dumps(rows) and "hooks.slack.com" not in json.dumps(rows)


def test_the_first_run_account_is_audited_before_it_exists_and_borrows_no_credential(monkeypatch) -> None:
    client, api = _client(seed_admin=False, setup_complete=False)
    with client:
        state = _state(api)
        _break_strict_appends(monkeypatch, state)
        down = client.post("/api/setup/account", json={
            "username": "founder", "password": "Correct-Horse-9", "display_name": "Founder",
        })
        assert down.status_code == 503 and down.json()["detail"]["code"] == "audit_unavailable"
        assert client.portal.call(state.users.has_any) is False
        monkeypatch.undo()
        made = client.post(
            "/api/setup/account",
            json={"username": "founder", "password": "Correct-Horse-9", "display_name": "Founder"},
            headers={REQUEST_ID_HEADER: "oobe-0001", _PEER_HEADER: _DIRECT_PEER,
                     # A credential the request happens to carry is never read.
                     "Authorization": "Bearer not-a-token-of-this-server"},
        )
        assert made.status_code == 200, made.text
        rows = _rows(client, api)
    row = _one(rows, "user.created")
    assert row["actor"] == "founder" and row["actor_type"] == "human"
    assert row["outcome"] == "success" and row["surface"] == "setup"
    assert "session_ref" not in row and "actor_role" not in row
    assert row["request_id"] == "oobe-0001" and row["client"]["ip"] == _DIRECT_PEER
    assert _target(row) == {"type": "user", "id": "founder", "label": "Founder"}
    assert _field(row, "role")["after"] == "super_admin"
    assert _field(row, "password") == {"field": "password", "before": None, "after": None,
                                       "secret": True}
    assert "Correct-Horse-9" not in json.dumps(rows)


# --------------------------------------------------------------------------- #
# Dashboards
# --------------------------------------------------------------------------- #
def test_personal_dashboard_writes_record_the_board_shape() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        widget = {"i": "w-1", "type": "kpi.needs_human", "x": 0, "y": 0, "w": 3, "h": 2}
        created = client.post("/api/dashboards", headers=_headers(auth, "board-0001"), json={
            "id": "dash-ops", "name": "Ops board", "widgets": [widget],
        })
        assert created.status_code == 200, created.text
        moved = client.put("/api/dashboards/dash-ops", headers=_headers(auth, "board-0002"), json={
            "id": "dash-ops", "name": "Ops board", "widgets": [{**widget, "x": 6}],
            "default_window": "now-7d",
        })
        assert moved.status_code == 200, moved.text
        copied = client.post("/api/dashboards", headers=_headers(auth, "board-0003"), json={
            "id": "dash-copy", "name": "SOC operations (copy)", "widgets": [widget],
            "derived_from": "builtin:soc-operations",
        })
        assert copied.status_code == 200, copied.text
        cloned = client.post("/api/dashboards/dash-ops/clone", headers=_headers(auth, "board-0004"))
        assert cloned.status_code == 200, cloned.text
        deleted = client.delete("/api/dashboards/dash-ops", headers=_headers(auth, "board-0005"))
        assert deleted.status_code == 200, deleted.text
        missing = client.delete("/api/dashboards/dash-ops", headers=_headers(auth, "board-0006"))
        assert missing.status_code == 404
        rows = _rows(client, api)
    by_rid = {r["request_id"]: r for r in rows if r.get("request_id", "").startswith("board-000")}
    created_row = by_rid["board-0001"]
    assert created_row["action"] == "dashboard.created"
    _assert_request_fields(created_row, "board-0001")
    assert created_row["action_type"] == ActionType.CONTEXT.value
    assert _target(created_row) == {"type": "dashboard", "id": "dash-ops", "label": "Ops board"}
    assert _field(created_row, "widgets.w-1")["after"] == "kpi.needs_human at 0,0 size 3x2"
    updated = by_rid["board-0002"]
    assert updated["action"] == "dashboard.updated"
    assert _field(updated, "widgets.w-1") == {
        "field": "widgets.w-1", "before": "kpi.needs_human at 0,0 size 3x2",
        "after": "kpi.needs_human at 6,0 size 3x2", "secret": False,
    }
    assert _field(updated, "default_window")["after"] == "now-7d"
    assert by_rid["board-0003"]["action"] == "dashboard.duplicated"
    assert _field(by_rid["board-0003"], "derived_from")["after"] == "builtin:soc-operations"
    assert by_rid["board-0004"]["action"] == "dashboard.duplicated"
    assert by_rid["board-0004"]["tool_input"] == {"duplicated_from": "dash-ops"}
    assert by_rid["board-0005"]["action"] == "dashboard.deleted"
    assert _field(by_rid["board-0005"], "name") == {"field": "name", "before": "Ops board",
                                                 "after": None, "secret": False}
    assert "board-0006" not in by_rid  # an unknown board is a pre-check: no row


def test_a_duplicated_built_in_board_records_every_widget() -> None:
    """A 12-widget copy of a built-in board (Duplicate to customise) records each widget
    as one change, so none is cut by the row's 50-change cap."""
    client, api = _client()
    with client:
        auth = _admin(client)
        widgets = [
            {"i": f"w-{n:02d}", "type": "kpi.needs_human", "x": (n % 4) * 3, "y": (n // 4) * 2,
             "w": 3, "h": 2}
            for n in range(12)
        ]
        created = client.post("/api/dashboards", headers=_headers(auth, "board-big-1"), json={
            "id": "dash-big", "name": "SOC operations (copy)", "widgets": widgets,
            "derived_from": "builtin:soc-operations",
        })
        assert created.status_code == 200, created.text
        rows = _rows(client, api)
    row = [r for r in rows if r.get("request_id") == "board-big-1"][0]
    recorded = {c["field"] for c in row["changes"]}
    assert {f"widgets.w-{n:02d}" for n in range(12)} <= recorded
    assert _field(row, "widgets.w-11")["after"] == "kpi.needs_human at 9,4 size 3x2"
    assert "fields changed" not in row["result_summary"]


# --------------------------------------------------------------------------- #
# Detection, correlation and case-automation rules; analyst policies
# --------------------------------------------------------------------------- #
def test_rule_lifecycle_rows_name_the_rule_and_every_changed_field() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        calls = [
            ("PUT", "/api/rules/detection/brute_force",
             {"name": "brute_force", "match": _MATCH, "priority": 2}, "rule-0001"),
            ("PUT", "/api/rules/detection/brute_force",
             {"name": "brute_force", "match": _MATCH, "priority": 5}, "rule-0002"),
            ("POST", "/api/rules/detection/brute_force/enabled", {"enabled": False}, "rule-0003"),
            ("PUT", "/api/rules/correlation/brute_force", {"n": 3, "window_seconds": 600}, "rule-0004"),
            ("PUT", "/api/rules/case-automation/auto-1",
             {"id": "auto-1", "name": "Tag noisy", "action": "tag",
              "conditions": {"verdict": "FALSE_POSITIVE"}},
             "rule-0005"),
            ("DELETE", "/api/rules/correlation/brute_force", None, "rule-0006"),
            ("POST", "/api/rules/detection/missing/enabled", {"enabled": True}, "rule-0007"),
        ]
        for method, path, body, rid in calls:
            response = client.request(method, path, json=body, headers=_headers(auth, rid))
            expected = 404 if rid == "rule-0007" else 200
            assert response.status_code == expected, (path, response.text)
        versions = client.get("/api/rules/detection/brute_force/versions", headers=auth).json()
        first = [v for v in versions["versions"] if v["action"] == "create"][0]
        rolled = client.post(f"/api/rules/detection/brute_force/rollback/{first['id']}",
                             headers=_headers(auth, "rule-0008"))
        assert rolled.status_code == 200, rolled.text
        rows = _rows(client, api)
    by_rid = {r["request_id"]: r for r in rows if r.get("request_id", "").startswith("rule-000")}
    expected_actions = {
        "rule-0001": "rule.created", "rule-0002": "rule.updated", "rule-0003": "rule.disabled",
        "rule-0004": "rule.created", "rule-0005": "rule.created", "rule-0006": "rule.deleted",
        "rule-0008": "rule.rolled_back",
    }
    for rid, action in expected_actions.items():
        row = by_rid[rid]
        assert row["action"] == action, rid
        _assert_request_fields(row, rid)
        assert row["surface"] == "rules" and row["action_type"] == ActionType.STATUS.value
        assert row["target"]["type"] == "rule"
    assert "rule-0007" not in by_rid  # an unknown rule is refused before any row
    assert by_rid["rule-0001"]["result_summary"].startswith("detection_create: name=brute_force")
    assert by_rid["rule-0002"]["result_summary"].startswith("detection_update: name=brute_force")
    assert _field(by_rid["rule-0002"], "rule_catalog[brute_force].priority") == {
        "field": "rule_catalog[brute_force].priority", "before": "2", "after": "5", "secret": False,
    }
    assert by_rid["rule-0003"]["tool_input"] == {"kind": "detection"}
    assert _field(by_rid["rule-0004"], "correlation_rules.brute_force.n")["after"] == "3"
    assert _target(by_rid["rule-0005"]) == {"type": "rule", "id": "auto-1", "label": "Tag noisy"}
    assert by_rid["rule-0006"]["result_summary"] == "correlation_delete: key=brute_force"
    assert _field(by_rid["rule-0008"], "rule_catalog[brute_force].priority")["after"] == "2"


@pytest.mark.parametrize("path, body, rid, gone, kind", [
    ("/api/rules/detection/r1", {"name": "r1", "match": _MATCH},
     "r1", lambda p: {"rule_catalog": [r for r in p.rule_catalog if r.name != "r1"]},
     "detection"),
    ("/api/rules/case-automation/auto-r1",
     {"id": "auto-r1", "name": "Tag noisy", "action": "tag",
      "conditions": {"verdict": "FALSE_POSITIVE"}},
     "auto-r1", lambda p: {"threshold_automation": p.threshold_automation.model_copy(update={
         "rules": [r for r in p.threshold_automation.rules if r.id != "auto-r1"]})},
     "case_automation"),
])
def test_an_upsert_racing_a_delete_of_the_same_rule_creates_it_again(
    monkeypatch, path: str, body: dict[str, Any], rid: str, gone: Any, kind: str,
) -> None:
    """The rule exists when the edit is recorded and is deleted before the save. The
    write re-runs the edit on the stored document: the rule is created again, the
    response says so and the last action row is ``rule.created`` (the first,
    ``rule.updated``, is paired with its failure row). The retry's action row says
    which attempt it is, beside the rule's kind, so it is never read as the one that
    failed."""
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        assert client.put(path, json=body, headers=auth).status_code == 200
        real = state.control_audit.record_strict
        fired = {"done": False}

        async def _racing_delete(**kwargs: Any) -> Any:
            result = await real(**kwargs)
            if kwargs.get("action") == "rule.updated" and not fired["done"]:
                fired["done"] = True
                await state.mutate_prefs(lambda p: p.model_copy(update=gone(p)))
            return result

        monkeypatch.setattr(state.control_audit, "record_strict", _racing_delete)
        response = client.put(path, json={**body, "priority": 7} if "detection" in path else
                              {**body, "name": "Tag noisy again"},
                              headers=_headers(auth, "rule-race-1"))
        monkeypatch.undo()
        assert response.status_code == 200, response.text
        assert response.json()["created"] is True
        stored = ([r.name for r in state.prefs.rule_catalog] if "detection" in path
                  else [r.id for r in state.prefs.threshold_automation.rules])
        assert rid in stored
        rows = sorted((r for r in _rows(client, api) if r.get("request_id") == "rule-race-1"),
                      key=lambda r: r["ts"])  # oldest first
    assert [r["action"] for r in rows] == ["rule.updated", "rule.update_failed", "rule.created"]
    assert rows[-1]["outcome"] == "success" and rows[-1]["changes"]
    assert rows[0]["tool_input"] == {"kind": kind}
    assert rows[-1]["tool_input"] == {"kind": kind, "attempt": 2, "of": 3}


def test_a_settings_save_that_lost_a_race_marks_its_retry(monkeypatch) -> None:
    """A curated settings save whose recorded field another save moves after its row:
    the rows of the request are action, failure, action, and only the retry's action
    row carries the attempt marker (the first row is left as it always was), the same
    shape ``PUT /api/settings`` records."""
    client, api = _client()
    with client:
        auth = _admin(client)
        state = _state(api)
        real = state.control_audit.record_strict
        fired = {"done": False}

        async def _racing_save(**kwargs: Any) -> Any:
            result = await real(**kwargs)
            if kwargs.get("action") == "settings.updated" and not fired["done"]:
                fired["done"] = True
                prefs = state.prefs
                await state.update_prefs(prefs.model_copy(update={
                    "budget": prefs.budget.model_copy(update={"daily_usd": 77.0}),
                }))
            return result

        monkeypatch.setattr(state.control_audit, "record_strict", _racing_save)
        response = client.put(
            "/api/budget", headers=_headers(auth, "budget-race-1"),
            json={"enabled": True, "daily_usd": 25.0, "monthly_usd": 400.0, "on_exceed": "block"},
        )
        monkeypatch.undo()
        assert response.status_code == 200, response.text
        assert state.prefs.budget.daily_usd == 25.0
        rows = sorted((r for r in _rows(client, api) if r.get("request_id") == "budget-race-1"),
                      key=lambda r: r["ts"])  # oldest first
    assert [r["action"] for r in rows] == [
        "settings.updated", "settings.update_failed", "settings.updated",
    ]
    assert rows[0].get("tool_input") is None
    assert rows[1]["outcome"] == "failure"
    assert rows[2]["tool_input"] == {"attempt": 2, "of": 3}
    assert _field(rows[2], "budget.daily_usd")["before"] == "77.0"


def test_analyst_policy_rows_name_the_rule_and_the_declaration() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        made = client.put("/api/rules/analyst-policies/new", headers=_headers(auth, "arp-0001"),
                          json={"rule_id": "Lab Scanner", "reason": "Authorised lab scanner"})
        assert made.status_code == 200, made.text
        pid = made.json()["policy"]["id"]
        edited = client.put(f"/api/rules/analyst-policies/{pid}", headers=_headers(auth, "arp-0002"),
                            json={"rule_id": "Lab Scanner", "reason": "Authorised lab scanner, VLAN 40"})
        off = client.post(f"/api/rules/analyst-policies/{pid}/enabled",
                          headers=_headers(auth, "arp-0003"), json={"enabled": False})
        gone = client.delete(f"/api/rules/analyst-policies/{pid}", headers=_headers(auth, "arp-0004"))
        assert edited.status_code == off.status_code == gone.status_code == 200
        rows = _rows(client, api)
    by_rid = {r["request_id"]: r for r in rows if r.get("request_id", "").startswith("arp-000")}
    rule_id = made.json()["policy"]["rule_id"]
    for rid, action in (("arp-0001", "analyst_policy.created"), ("arp-0002", "analyst_policy.updated"),
                        ("arp-0003", "analyst_policy.disabled"), ("arp-0004", "analyst_policy.deleted")):
        row = by_rid[rid]
        assert row["action"] == action, rid
        _assert_request_fields(row, rid)
        assert _target(row) == {"type": "rule", "id": rule_id, "label": rule_id}
        assert row["tool_input"] == {"policy_id": pid}
        assert row["surface"] == "analyst_policy"
    assert by_rid["arp-0001"]["result_summary"].startswith(f"analyst_policy.upsert: id={pid} created")
    assert _field(by_rid["arp-0002"], f"analyst_rule_policies[{pid}].reason")["after"] == (
        "Authorised lab scanner, VLAN 40"
    )
    assert _field(by_rid["arp-0003"], f"analyst_rule_policies[{pid}].enabled")["after"] == "false"


# --------------------------------------------------------------------------- #
# Exports, system updates, resets
# --------------------------------------------------------------------------- #
def test_data_export_deliveries_carry_the_record_fields() -> None:
    client, api = _client()
    with client:
        auth = _admin(client)
        legacy = client.post("/api/admin/export", headers=_headers(auth, "export-1"),
                             json={"scopes": ["configuration", "cases"]})
        assert legacy.status_code == 200, legacy.text
        _fresh(client, auth)
        segment = client.post("/api/admin/export/segment", headers=_headers(auth, "export-2"),
                              json={"scope": "configuration"})
        assert segment.status_code == 200, segment.text
        rows = _rows(client, api)
    row = _one(rows, "export.downloaded")
    _assert_request_fields(row, "export-1")
    assert row["action_type"] == ActionType.DATA_EXPORT.value
    assert _target(row) == {"type": "export", "id": "cases,configuration",
                             "label": "Application data: cases, configuration"}
    assert row["tool_input"]["format"] == "json" and row["tool_input"]["bytes"] > 0
    assert row["result_summary"].startswith("exported scopes=")
    seg = _one(rows, "export.segment_downloaded")
    _assert_request_fields(seg, "export-2")
    assert seg["target"]["id"] == "configuration"
    assert seg["tool_input"]["part"] == 1 and seg["tool_input"]["filename"].endswith(".json")


def _update_client(monkeypatch: pytest.MonkeyPatch, service: _FakeUpdateService | None = None):
    service = service or _FakeUpdateService()
    monkeypatch.setattr(routes_updates, "_service", lambda _state: service)
    client, api = _client()
    return client, api, service


#: Every operator update operation: (operation, path, body without the key).
_UPDATE_OPERATIONS = [
    ("preflight", "/api/system-updates/preflight", {"release_id": "v0.1.3"}),
    ("start", "/api/system-updates/jobs",
     {"release_id": "v0.1.3", "preflight_token": "preflight_token_1234567890"}),
    ("cancel", "/api/system-updates/jobs/update-123/cancel", {}),
    ("rollback", "/api/system-updates/jobs/update-123/rollback", {}),
]


def test_system_update_rows_name_the_operation_its_outcome_and_target(monkeypatch) -> None:
    client, api, _service = _update_client(monkeypatch)
    with client:
        auth = _admin(client)
        body = {"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY}
        ok = client.post("/api/system-updates/preflight", json=body,
                         headers=_headers(auth, "update-1"))
        assert ok.status_code == 200, ok.text
        rows = _rows(client, api)
    intent = _one(rows, "update.preflight_requested")
    assert intent["outcome"] == "success" and intent["actor_type"] == "human"
    assert intent["actor"] == "Admin"
    assert _target(intent) == {"type": "setting", "id": "release:v0.1.3", "label": "Release v0.1.3"}
    assert intent["result_summary"] == "intent operation=preflight target=v0.1.3"
    assert intent["event_id"].startswith("system-update:r14:intent:preflight:v0.1.3:")
    result = _one(rows, "update.preflight_accepted")
    assert result["outcome"] == "success" and result["actor_type"] == "human"
    assert result["event_id"].startswith("system-update:r14:result-accepted:preflight:")
    # Who asked, from where (SPEC §4.5.3): every request-driven field, the forged
    # forwarded header never the address. The request and its result pair by request id.
    for row in (intent, result):
        _assert_request_fields(row, "update-1")


@pytest.mark.parametrize("operation, path, body", [
    ("cancel", "/api/system-updates/jobs/update-123/cancel", {}),
    ("rollback", "/api/system-updates/jobs/update-123/rollback", {}),
])
def test_job_update_rows_name_the_job_and_who_asked(
    monkeypatch, operation: str, path: str, body: dict[str, Any],
) -> None:
    client, api, _service = _update_client(monkeypatch)
    with client:
        auth = _admin(client)
        response = client.post(path, json={**body, "idempotency_key": _IDEMPOTENCY},
                               headers=_headers(auth, f"job-{operation}-1"))
        assert response.status_code == 200, response.text
        rows = _rows(client, api)
    for action in (f"update.{operation}_requested", f"update.{operation}_accepted"):
        row = _one(rows, action)
        _assert_request_fields(row, f"job-{operation}-1")
        assert row["target"]["type"] == "job" and row["target"]["id"] == "update-123"


def test_a_refused_update_records_who_asked_beside_the_refusal(monkeypatch) -> None:
    from app.engine.update_supervisor import SupervisorRejected

    service = _FakeUpdateService()

    async def _reject(_release_id: str, *, idempotency_key: str):
        del idempotency_key
        raise SupervisorRejected(409, "release_not_newer", "Not newer than the running release.")

    service.preflight = _reject  # type: ignore[method-assign]
    client, api, _service = _update_client(monkeypatch, service)
    with client:
        auth = _admin(client)
        response = client.post(
            "/api/system-updates/preflight", headers=_headers(auth, "update-refused-1"),
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 409, response.text
        rows = _rows(client, api)
    _assert_request_fields(_one(rows, "update.preflight_requested"), "update-refused-1")
    refused = _one(rows, "update.preflight_rejected")
    _assert_request_fields(refused, "update-refused-1", outcome="failure")


@pytest.mark.parametrize("operation, path, body", _UPDATE_OPERATIONS)
def test_a_same_key_update_retry_records_each_request_with_its_own_context(
    monkeypatch, operation: str, path: str, body: dict[str, Any],
) -> None:
    """The production stack gives every request its own id. A retry with the same
    idempotency key as a new request (the browser's retry, a double click, what the 503
    message asks for) is never refused as an id collision: it appends its own rows,
    recorded with its own request id, while the first request's rows keep theirs. The
    same request sent again exactly (its id, session and address) confirms its first
    rows instead of adding any."""
    client, api, service = _update_client(monkeypatch)
    with client:
        auth = _admin(client)
        payload = {**body, "idempotency_key": _IDEMPOTENCY}
        first = client.post(path, json=payload, headers=_headers(auth, f"{operation}-try-1"))
        second = client.post(path, json=payload, headers=_headers(auth, f"{operation}-try-2"))
        again = client.post(path, json=payload, headers=_headers(auth, f"{operation}-try-1"))
        assert first.status_code in {200, 202}, first.text
        assert second.status_code == again.status_code == first.status_code, second.text
        rows = _rows(client, api)
    assert len(service.calls) == 3  # every request reached the (idempotent) supervisor
    for action in (f"update.{operation}_requested", f"update.{operation}_accepted"):
        found = _by_action(rows, action)
        assert sorted(r["request_id"] for r in found) == [
            f"{operation}-try-1", f"{operation}-try-2",
        ], action
        for row in found:
            _assert_request_fields(row, row["request_id"])
        assert len({r["event_id"] for r in found}) == 2
    by_request = {(r["action"], r["request_id"]): r["event_id"] for r in rows
                  if str(r.get("action") or "").startswith("update.")}
    assert by_request[(f"update.{operation}_requested", f"{operation}-try-1")] != by_request[
        (f"update.{operation}_accepted", f"{operation}-try-1")]


def test_an_update_row_id_names_the_request_and_never_loses_its_digests() -> None:
    """The event id of an operator's update row is fixed by the operation, its target,
    the idempotency key and the request's own context; a long job id is cut so the
    two digests that tell requests apart always remain."""
    from app.audit.context import AuditContext
    from app.models import AuditClient

    def _ctx(request_id: str, ip: str = "203.0.113.7") -> AuditContext:
        return AuditContext(client=AuditClient(ip=ip, peer=ip, user_agent="ua"),
                            session_ref="0123456789abcdef", actor_role="super_admin",
                            request_id=request_id)

    def _id(target: str, ctx: AuditContext, key: str = _IDEMPOTENCY) -> str:
        return routes_updates._audit_event_id(  # noqa: SLF001
            phase="intent", operation="cancel", target=target, idempotency_key=key,
            context=ctx,
        )

    same = _id("job-1", _ctx("req-00000001"))
    assert same == _id("job-1", _ctx("req-00000001"))
    assert same != _id("job-1", _ctx("req-00000002"))
    assert same != _id("job-1", _ctx("req-00000001", ip="203.0.113.8"))
    assert same != _id("job-1", _ctx("req-00000001"), key="another-key-00000001")
    long_a, long_b = _id("j" * 2000, _ctx("req-00000001")), _id("j" * 2000, _ctx("req-00000002"))
    assert len(long_a) <= 512 and long_a != long_b
    key_digest, context_digest = long_a.rsplit(":", 2)[-2:]
    assert re.fullmatch(r"[0-9a-f]{32}", key_digest)
    assert re.fullmatch(r"[0-9a-f]{16}", context_digest)


def _legacy_terminal_row(job) -> dict[str, Any]:
    """The terminal row exactly as a pre-Round-14 build appends it."""
    return {
        "action_type": ActionType.SYSTEM_UPDATE,
        "event_id": f"system-update:terminal:{job.job_id}:{job.status}",
        "ts": job.updated_at,
        "surface": "system_updates",
        "actor": "update_supervisor",
        "result_summary": (
            f"terminal job_id={job.job_id} release_id={job.release_id} status={job.status}"
        ),
    }


@pytest.mark.asyncio
async def test_terminal_rows_keep_their_pre_round14_shape_in_both_directions(
    app_state: AppState,
) -> None:
    for status in ("succeeded", "failed", "rolled_back", "cancelled"):
        # Upgrade: an earlier build audited this job; this build's replay confirms it.
        old = _job(status=status, stage="completed").model_copy(update={"job_id": f"old-{status}"})
        await app_state.control_audit.record_strict(**_legacy_terminal_row(old))
        before = len(await app_state.control_audit.records(limit=500))
        assert await audit_terminal_job(app_state.control_audit, old) is True
        assert len(await app_state.control_audit.records(limit=500)) == before
        # Rollback: this build audits a job first; an earlier build's replay confirms it.
        new = _job(status=status, stage="completed").model_copy(update={"job_id": f"new-{status}"})
        assert await audit_terminal_job(app_state.control_audit, new) is True
        await app_state.control_audit.record_strict(**_legacy_terminal_row(new))
        rows = [r for r in await app_state.control_audit.records(limit=500)
                if r.get("event_id") == f"system-update:terminal:new-{status}:{status}"]
        assert len(rows) == 1, status
        assert not {"action", "outcome", "actor_type", "target"} & set(rows[0]), rows[0]
        # The log still names it and its actor (the legacy event table).
        assert events.classify(rows[0]) == events.EventInfo("config", "System update")
        assert events.derive_actor_type(rows[0]) == ("system", True)


def test_status_answers_for_a_job_an_earlier_build_audited(monkeypatch) -> None:
    service = _FakeUpdateService()
    done = _job(status="succeeded", stage="completed")
    service.status_result = _status(last_job=done)
    client, api, _service = _update_client(monkeypatch, service)
    with client:
        auth = _admin(client)
        state = _state(api)
        client.portal.call(lambda: state.control_audit.record_strict(**_legacy_terminal_row(done)))
        response = client.get("/api/system-updates/status", headers=auth)
        assert response.status_code == 200, response.text
        assert client.get("/api/system-updates/status", headers=auth).status_code == 200


def _rotate_session_ref_key(state: AppState, secret: str = "a4b2-restarted-secret") -> None:
    """What a restart with another signing secret does to session references: a blank
    ``AUTH_JWT_SECRET`` (the Compose default) draws a new ephemeral secret on every
    start, and an operator may rotate a configured one. The key is derived exactly as
    ``AuthService`` derives it at start-up."""
    from app.auth import service as auth_service

    before = state.auth.session_ref("sid-reset-1")
    state.auth._session_ref_key = hmac.new(  # noqa: SLF001 (a restart, simulated)
        secret.encode("utf-8"), auth_service._SESSION_REF_LABEL, hashlib.sha256,  # noqa: SLF001
    ).digest()
    assert state.auth.session_ref("sid-reset-1") != before  # every reference changed


async def _actor_generation(state: AppState, actor: str = "Admin") -> str:
    """The account generation a job of ``actor`` must carry to keep its authority."""
    user = await state.users.get(actor)
    return account_generation(user.username, user.created_at) if user else "env-admin"


def _reset_job(scope: str, generation: str, *, actor: str = "Admin",
               sid: str | None = "sid-reset-1") -> Job:
    """A reset job as the jobs route stores it. The step-up deadline is left unset
    (the session store is not under test here); ``fresh_session_id`` names the step-up
    session, which the worker's rows never reference (they are keyed, see
    ``_PER_REQUEST_FIELDS``)."""
    confirm = {"cases": "RESET CASES", "sources": "RESET SOURCES", "factory": "FACTORY RESET"}[scope]
    return Job(
        kind=JobKind.TIERED_RESET, actor=actor, actor_generation=generation,
        progress=JobProgress(total=1, unit="reset"),
        request_fingerprint="a" * 64,
        idempotency_key_hash=idempotency_hash(actor, f"reset-{scope}-{time.time_ns()}", generation),
        params={"scope": scope, "confirm": confirm}, item_states={"reset": "pending"},
        transitions=[JobTransition(seq=1, name="submitted")], transition_seq=1,
        fresh_session_id=sid,
    )


def test_a_cases_reset_records_who_started_it_and_how_it_ended() -> None:
    client, api = _client()
    with client:
        _admin(client)
        state = _state(api)

        async def _run() -> Job:
            await state.job_runner.stop()
            created, _, _ = await state.jobs.create(
                _reset_job("cases", await _actor_generation(state))
            )
            claimed = await state.jobs.claim_next("a4b2-worker", lease_millis=30_000)
            assert claimed is not None and claimed[0].job_id == created.job_id
            await state.job_runner._tiered_reset(claimed[0], claimed[1])  # noqa: SLF001
            return created

        job = client.portal.call(_run)
        rows = _rows(client, api)
    started = _one(rows, "reset.started")
    assert started["event_id"] == f"job:{job.job_id}:reset-started"
    assert started["actor"] == "Admin" and started["actor_type"] == "human"
    # A worker row records only what the job fixes. The request-driven fields (the
    # session reference, the live role, the request id, the client) are not on it.
    for per_request in _PER_REQUEST_FIELDS:
        assert per_request not in started, per_request
    assert started["outcome"] == "success" and started["tool_input"] == {"scope": "cases"}
    assert _target(started) == {"type": "job", "id": job.job_id, "label": "Cases reset"}
    assert started["result_summary"] == f"reset scope=cases confirm=ok job={job.job_id}"
    completed = _one(rows, "reset.completed")
    assert completed["outcome"] in {"success", "partial"}
    assert completed["tool_input"]["scope"] == "cases"
    assert completed["tool_input"]["attempted"] >= 1
    assert completed["target"]["id"] == job.job_id
    for per_request in _PER_REQUEST_FIELDS:
        assert per_request not in completed, per_request


@pytest.mark.parametrize("scope, label", [
    (ResetScope.CASES, "Cases reset"),
    (ResetScope.SOURCES, "Sources reset"),
    (ResetScope.FACTORY, "Factory reset"),
])
def test_every_row_about_a_reset_names_the_job_by_what_it_resets(scope: ResetScope, label: str) -> None:
    """One public target for every row about a reset (the worker's rows and the row of
    the request that submitted it), so they read as one job in the log."""
    target = reset_audit_target("job-1", scope)
    assert target.model_dump(exclude_none=True) == {"type": "job", "id": "job-1", "label": label}


def test_an_interrupted_reset_resumes_after_a_role_change_and_records_no_failure(monkeypatch) -> None:
    """A shutdown or a lost lease cancels the handler; the next worker resumes it and
    appends the keyed rows again. The interruption writes no ``reset.failed`` row, and
    the resumed run is not refused although the actor's role changed in between (the
    rows record nothing read live). An earlier build's ``reset-intent`` row for the
    same job does not get in the way either."""
    from app.audit.context import effective_role
    from app.engine import reset as reset_module

    client, api = _client()
    with client:
        _admin(client)
        state = _state(api)
        real_reset = reset_module.reset_service

        async def _interrupted(*_args: Any, **_kwargs: Any) -> Any:
            raise asyncio.CancelledError()

        async def _first_run() -> tuple[Job, str]:
            await state.job_runner.stop()
            created, _, _ = await state.jobs.create(
                _reset_job("cases", await _actor_generation(state))
            )
            claimed = await state.jobs.claim_next("a4b2-worker", lease_millis=60_000)
            assert claimed is not None and claimed[0].job_id == created.job_id
            # What a pre-Round-14 build appended when it began this job.
            await state.control_audit.record_strict(
                action_type=ActionType.RESET, event_id=f"job:{created.job_id}:reset-intent",
                surface="admin", actor=created.actor,
                result_summary=f"reset scope=cases confirm=ok job={created.job_id}",
            )
            monkeypatch.setattr(reset_module, "reset_service", _interrupted)
            try:
                await state.job_runner._tiered_reset(claimed[0], claimed[1])  # noqa: SLF001
            except asyncio.CancelledError:
                pass
            else:  # pragma: no cover - the interruption must propagate
                raise AssertionError("the interruption was swallowed")
            return claimed

        job, token = client.portal.call(_first_run)
        assert not _by_action(_rows(client, api), "reset.failed")

        async def _change_role() -> tuple[str | None, str | None]:
            before = effective_role(state, await state.users.get("Admin"))
            prefs = state.prefs.model_copy(deep=True)
            prefs.rbac.enabled = True
            await state.update_prefs(prefs)
            await state.users.update("Admin", role=UserRole.SOC_MANAGER)
            return before, effective_role(state, await state.users.get("Admin"))

        before_role, after_role = client.portal.call(_change_role)
        assert before_role != after_role  # the live role really changed

        monkeypatch.setattr(reset_module, "reset_service", real_reset)
        current = client.portal.call(lambda: state.jobs.get(job.job_id))
        client.portal.call(lambda: state.job_runner._tiered_reset(current, token))  # noqa: SLF001
        rows = _rows(client, api)
    started = _one(rows, "reset.started")  # the resumed run confirmed the first row
    assert started["target"]["id"] == job.job_id
    completed = _one(rows, "reset.completed")
    assert completed["outcome"] in {"success", "partial"}
    assert not _by_action(rows, "reset.failed")
    assert len([r for r in rows if r.get("event_id") == f"job:{job.job_id}:reset-intent"]) == 1


def test_a_reset_interrupted_by_a_restart_with_a_new_signing_secret_resumes(monkeypatch) -> None:
    """A restart draws a new ephemeral signing secret (a blank ``AUTH_JWT_SECRET``) or
    picks up a rotated one, and every session reference changes with it. The resuming
    worker appends the keyed ``reset-started`` row again; the row carries no session
    reference, so it confirms the first append, and the reset runs to its end."""
    from app.engine import reset as reset_module

    client, api = _client()
    with client:
        _admin(client)
        state = _state(api)
        real_reset = reset_module.reset_service

        async def _interrupted(*_args: Any, **_kwargs: Any) -> Any:
            raise asyncio.CancelledError()

        async def _first_run() -> tuple[Job, str]:
            await state.job_runner.stop()
            created, _, _ = await state.jobs.create(
                _reset_job("cases", await _actor_generation(state))
            )
            claimed = await state.jobs.claim_next("a4b2-worker", lease_millis=60_000)
            assert claimed is not None and claimed[0].job_id == created.job_id
            monkeypatch.setattr(reset_module, "reset_service", _interrupted)
            with pytest.raises(asyncio.CancelledError):
                await state.job_runner._tiered_reset(claimed[0], claimed[1])  # noqa: SLF001
            return claimed

        job, token = client.portal.call(_first_run)
        assert len(_by_action(_rows(client, api), "reset.started")) == 1

        _rotate_session_ref_key(state)
        monkeypatch.setattr(reset_module, "reset_service", real_reset)
        current = client.portal.call(lambda: state.jobs.get(job.job_id))
        client.portal.call(lambda: state.job_runner._tiered_reset(current, token))  # noqa: SLF001
        rows = _rows(client, api)
        finished = client.portal.call(lambda: state.jobs.get(job.job_id))
    started = _one(rows, "reset.started")
    assert started["event_id"] == f"job:{job.job_id}:reset-started"
    completed = _one(rows, "reset.completed")
    assert completed["event_id"] == f"job:{job.job_id}:reset-result"
    assert completed["outcome"] in {"success", "partial"}
    assert not _by_action(rows, "reset.failed")
    for row in (started, completed):
        assert "session_ref" not in row
    assert finished is not None and finished.status.value in {"succeeded", "partial"}


def test_a_reset_outcome_appended_again_after_a_restart_confirms_its_first_row(caplog) -> None:
    """The outcome rows are keyed too. An attempt that recorded how the reset ended and
    then lost its lease before finishing is resumed by a worker with a new signing
    secret; its second ``reset.completed`` (or ``reset.failed``) append confirms the
    first one instead of colliding and being dropped with a warning."""
    from app.constants import JobStatus, ResetScope

    client, api = _client()
    with client:
        _admin(client)
        state = _state(api)
        job = _reset_job("sources", "generation", sid="sid-reset-2")
        runner = state.job_runner

        async def _record_both() -> None:
            await runner._audit_reset_result(  # noqa: SLF001
                job, ResetScope.SOURCES, JobStatus.SUCCEEDED, attempted=2, cleared=2, failed=0,
            )
            await runner._audit_reset_failure(  # noqa: SLF001
                job, ResetScope.SOURCES, RuntimeError("store unreachable"),
            )

        client.portal.call(_record_both)
        _rotate_session_ref_key(state)
        with caplog.at_level("WARNING", logger="tlsoc.engine.jobs"):
            client.portal.call(_record_both)
        rows = _rows(client, api)
    assert not [r for r in caplog.records if "audit for job" in r.getMessage()]
    for action in ("reset.completed", "reset.failed"):
        row = _one(rows, action)
        assert row["target"]["id"] == job.job_id and row["actor_type"] == "human"
        assert "session_ref" not in row


def test_a_reset_that_stops_with_an_error_records_a_failure_row(monkeypatch) -> None:
    client, api = _client()
    with client:
        _admin(client)
        state = _state(api)
        from app.engine import reset as reset_module

        async def _boom(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("store unreachable")

        monkeypatch.setattr(reset_module, "reset_service", _boom)

        async def _run() -> None:
            await state.job_runner.stop()
            await state.jobs.create(_reset_job("sources", await _actor_generation(state)))
            claimed = await state.jobs.claim_next("a4b2-worker", lease_millis=30_000)
            assert claimed is not None
            with pytest.raises(RuntimeError, match="store unreachable"):
                await state.job_runner._tiered_reset(claimed[0], claimed[1])  # noqa: SLF001

        client.portal.call(_run)
        rows = _rows(client, api)
    failed = _one(rows, "reset.failed")
    assert failed["outcome"] == "failure" and failed["actor_type"] == "human"
    assert "some data may already be cleared" in failed["result_summary"]
    assert not _by_action(rows, "reset.completed")


def test_the_export_job_row_names_its_scopes_and_its_submitter() -> None:
    client, api = _client()
    with client:
        _admin(client)
        state = _state(api)
        job = Job(
            kind=JobKind.DATA_EXPORT_ARCHIVE, actor="Admin", actor_generation="generation",
            progress=JobProgress(total=1, unit="records"), request_fingerprint="b" * 64,
            idempotency_key_hash=idempotency_hash("Admin", "export-key", "generation"),
            params={"scopes": ["configuration"]}, fresh_session_id="sid-export-1",
        )
        client.portal.call(lambda: state.job_runner._audit_export(job, ["configuration"], 2048))  # noqa: SLF001
        # A resumed job appends the same keyed row again: it confirms the first one.
        client.portal.call(lambda: state.job_runner._audit_export(job, ["configuration"], 2048))  # noqa: SLF001
        # A restart with a new signing secret changes every session reference; the
        # resumed job still confirms its first row because the row carries none.
        _rotate_session_ref_key(state)
        client.portal.call(lambda: state.job_runner._audit_export(job, ["configuration"], 2048))  # noqa: SLF001
        rows = _rows(client, api)
    row = _one(rows, "export.created")
    assert row["event_id"] == f"job:{job.job_id}:export-created"
    assert row["actor"] == "Admin"
    assert row["outcome"] == "success" and row["actor_type"] == "human"
    for per_request in _PER_REQUEST_FIELDS:
        assert per_request not in row, per_request
    # One target per data export job: the request, this row and every download of the
    # file name the job, labelled with the exported scopes
    # (app.engine.jobs.data_export_audit_target).
    assert row["target"]["type"] == "export" and row["target"]["id"] == job.job_id
    assert row["target"]["label"] == "Application data: configuration"
    assert row["tool_input"] == {"job_id": job.job_id, "kind": "data_export_archive", "bytes": 2048}
    assert row["result_summary"].endswith("delivery=pending")


# --------------------------------------------------------------------------- #
# Event categories
# --------------------------------------------------------------------------- #
#: Every structured action the A4b-2 writers append (success rows and the failure rows a
#: writer names itself), with the category the event table gives it.
_A4B2_ACTIONS: dict[str, str] = {
    "settings.updated": "config",
    "rule.created": "config", "rule.updated": "config", "rule.enabled": "config",
    "rule.disabled": "config", "rule.deleted": "config", "rule.rolled_back": "config",
    "rule.rollback_failed": "config",
    "rule.tuning_requested": "config", "rule.tuning_request_failed": "config",
    "rule.tuning_rolled_back": "config", "rule.tuning_rollback_failed": "config",
    "analyst_policy.created": "config", "analyst_policy.updated": "config",
    "analyst_policy.enabled": "config", "analyst_policy.disabled": "config",
    "analyst_policy.deleted": "config",
    "campaign.recorrelated": "config", "campaign.recorrelate_failed": "config",
    "model.pricing_updated": "config", "model.pricing_cleared": "config",
    "model.pricing_clear_failed": "config",
    "model.added": "config", "model.add_failed": "config",
    "model.updated": "config", "model.update_failed": "config",
    "model.removed": "config", "model.remove_failed": "config",
    "notification.secrets_updated": "config",
    "dashboard.created": "config", "dashboard.updated": "config",
    "dashboard.deleted": "config", "dashboard.duplicated": "config",
    "export.downloaded": "config", "export.segment_downloaded": "config",
    "export.created": "config",
    "reset.started": "config", "reset.completed": "config", "reset.failed": "config",
    # The rows of the request that submits a reset or a data export job: the only rows
    # of those jobs that can record who asked and from where (the worker rows above are
    # keyed and carry no request field).
    "reset.requested": "config", "export.requested": "config",
    **{
        f"update.{operation}_{verb}": "config"
        for operation in ("preflight", "start", "cancel", "rollback")
        for verb in ("requested", "accepted", "rejected")
    },
    "user.created": "access",
}

#: The source files of the A4b-2 writers (SPEC §7, the A4b-2 row).
_A4B2_WRITER_SOURCES = (
    "app/api/routes_analyst_policy.py", "app/api/routes_baseline.py",
    "app/api/routes_batch.py", "app/api/routes_campaigns.py",
    "app/api/routes_dashboards.py", "app/api/routes_export.py",
    "app/api/routes_models.py", "app/api/routes_notifications.py",
    "app/api/routes_rules.py", "app/api/routes_setup.py", "app/api/routes_tuning.py",
    "app/api/routes_updates.py", "app/engine/update_audit.py", "app/engine/jobs.py",
    "app/audit/settings_write.py",
)
#: A dotted token of a resource the A4b-2 writers own, written as a plain literal.
_A4B2_ACTION_LITERAL = re.compile(
    r'"((?:settings|rule|analyst_policy|campaign|model|notification|dashboard|export'
    r'|reset|update|user)\.[a-z][a-z_]*)"'
)
#: Unchanged legacy ``result_summary`` prefixes that look like an action but are not
#: one (SPEC §4.5.3 keeps every legacy summary string as it was).
_LEGACY_SUMMARY_TOKENS = frozenset({"analyst_policy.upsert", "analyst_policy.update"})


@pytest.mark.parametrize("action, category", sorted(_A4B2_ACTIONS.items()))
def test_every_new_action_is_categorised_and_shown_to_people(action: str, category: str) -> None:
    info = events.classify({"action": action, "actor_type": "human"})
    assert info.category == category, action
    assert info.label and "_" not in info.label, info.label
    assert info.label != action
    assert events.in_people_scope({"action": action, "actor_type": "human"})


@pytest.mark.parametrize("action, category", sorted(
    (action, category) for action, category in _A4B2_ACTIONS.items()
    if not action.endswith("_failed") and action != "reset.failed"
))
def test_the_failure_row_of_every_action_reads_in_its_action_rows_category(
    action: str, category: str,
) -> None:
    """``audited_write`` pairs a refused write with ``<resource>.<verb>_failed`` (SPEC
    §3.6); that row must read as the same kind of event, named in words."""
    failed = failure_action(action)
    info = events.classify({"action": failed, "actor_type": "human", "outcome": "failure"})
    assert info.category == category, failed
    assert info.label and "_" not in info.label, info.label
    assert events.in_people_scope({"action": failed, "actor_type": "human"})


@pytest.mark.parametrize("action, label", [
    ("campaign.recorrelated", "Campaigns rebuilt"),
    ("campaign.recorrelate_failed", "Campaign rebuild failed"),
    ("notification.secrets_updated", "Notification channel credentials changed"),
    ("settings.updated", "Settings changed"),
    ("dashboard.created", "Dashboard created"),
    ("user.created", "User created"),
    ("reset.requested", "Reset requested"),
    ("export.requested", "Export requested"),
])
def test_actions_the_event_table_names_exactly_read_with_that_name(action: str, label: str) -> None:
    """Campaign re-correlation rows were the last A4b-2 rows without a table entry; they
    now read as Configuration and data with their own names, like the others here."""
    assert events.classify({"action": action, "actor_type": "human"}) == events.EventInfo(
        _A4B2_ACTIONS[action], label,
    )


@pytest.mark.parametrize("action, label", [
    ("reset.requested", "Reset request failed"),
    ("export.requested", "Export request failed"),
])
def test_a_refused_job_request_reads_as_a_failed_request(action: str, label: str) -> None:
    """A reset or data export request whose job could not be created closes its
    requested row with ``<resource>.request_failed`` (SPEC §3.6), named in words."""
    failed = failure_action(action)
    assert failed == action.replace(".requested", ".request_failed")
    assert events.classify(
        {"action": failed, "actor_type": "human", "outcome": "failure"}
    ) == events.EventInfo(_A4B2_ACTIONS[action], label)


def test_every_action_the_writers_name_is_in_the_categorised_set() -> None:
    """A source scan: a new action literal in an A4b-2 writer without a category entry
    above (and so without a check that the event table names it) fails here."""
    root = Path(__file__).resolve().parents[1]
    found: set[str] = set()
    for relative in _A4B2_WRITER_SOURCES:
        found.update(_A4B2_ACTION_LITERAL.findall((root / relative).read_text(encoding="utf-8")))
    assert found, "the scan found no action literal; the pattern or the file list is stale"
    unknown = sorted(found - set(_A4B2_ACTIONS) - _LEGACY_SUMMARY_TOKENS)
    assert unknown == [], unknown
    # The legacy summary prefixes are still only summary text, never a recorded action.
    assert not (_LEGACY_SUMMARY_TOKENS & set(_A4B2_ACTIONS))
