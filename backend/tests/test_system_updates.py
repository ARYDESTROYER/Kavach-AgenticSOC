"""Supervised update control-plane contracts and fail-closed mutation gates."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import routes_updates
from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_updates import router as updates_router
from app.config import ReleaseUpdateConfig, Secrets
from app.constants import ActionType
from app.engine.release_discovery import (
    ReleaseCacheStatus,
    ReleaseChannelStatus,
    ReleaseDiscoveryResponse,
)
from app.engine.update_service import UpdateCapabilityError, UpdateService
from app.engine.update_supervisor import (
    CurrentReleaseIdentity,
    ObservedStableRelease,
    SupervisorIdentity,
    SupervisorRejected,
    SupervisorStatus,
    SupervisorTerminalPage,
    SupervisorUnavailable,
    UpdateBackup,
    UpdateCapability,
    UpdateCheck,
    UpdateComponent,
    UpdateJob,
    UpdatePreflight,
    UpdateRelease,
    UpdateReleaseDiscovery,
    UpdateReceipt,
    UpdateRollback,
    UpdateScope,
    UpdateStatus,
    UpdateSupervisorClient,
)
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.state import AppState
from app.stores.sql import SqlKVStore, build_async_engine, create_all
from app.stores.update_operations import (
    UpdateOperationConflict,
    UpdateOperationStore,
)

_SHA = "a" * 40
_IDEMPOTENCY = "request-key-0000000000000001"
_STATE: dict[str, AppState] = {}


def _release() -> UpdateRelease:
    return UpdateRelease(
        release_id="v0.1.3",
        version="0.1.3",
        tag="v0.1.3",
        commit_sha=_SHA,
        repository_url="https://github.com/ARYDESTROYER/Agentic-Kibana",
    )


def _job(*, status: str = "running", stage: str = "observing") -> UpdateJob:
    return UpdateJob(
        job_id="update-123",
        release_id="v0.1.3",
        status=status,
        stage=stage,
        progress=100 if status in {"succeeded", "failed", "rolled_back", "cancelled"} else 92,
        message="Synthetic supervisor job",
        started_at="2026-08-03T00:00:00Z",
        updated_at="2026-08-03T00:01:00Z",
    )


def _preflight() -> UpdatePreflight:
    return UpdatePreflight(
        preflight_token="preflight_token_1234567890",
        expires_at="2026-08-03T01:00:00Z",
        release=_release(),
        checks=[
            UpdateCheck(
                code="signed_release",
                label="Signed release",
                status="pass",
                detail="The immutable Stable release is verified.",
            )
        ],
        components=[
            UpdateComponent(
                id="updater",
                label="Update supervisor",
                target_version="0.1.3",
                scope="updated",
                will_update=True,
            )
        ],
        backup=UpdateBackup(
            required=True,
            kind="postgres_custom_format",
            state="planned",
            description="A verified PostgreSQL backup is required before switching.",
        ),
        rollback=UpdateRollback(
            automatic=True,
            supported=True,
            state="planned",
            description="Prior digest-pinned images and owned state can be restored.",
        ),
    )


def _status(*, last_job: UpdateJob | None = None) -> UpdateStatus:
    return UpdateStatus(
        capability=UpdateCapability(
            supported=True,
            scope=UpdateScope(state_backend="postgres"),
            supervisor=SupervisorIdentity(
                available=True, protocol_version="1", updater_version="0.1.0"
            ),
        ),
        current=CurrentReleaseIdentity(
            version="0.1.2", channel="stable", commit_sha="b" * 40
        ),
        release_discovery=UpdateReleaseDiscovery(
            state="candidate_observed",
            checked_at="2026-08-03T00:00:00Z",
            branch="main",
            observed_release=ObservedStableRelease(
                release_id="v0.1.3", version="0.1.3"
            ),
        ),
        last_job=last_job,
    )


class _FakeUpdateService:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.status_result = _status()
        self.job_result = _job()

    async def status(self) -> UpdateStatus:
        self.calls.append("status")
        return self.status_result

    async def preflight(self, release_id: str, *, idempotency_key: str) -> UpdatePreflight:
        self.calls.append(f"preflight:{release_id}:{idempotency_key}")
        return _preflight()

    async def start(
        self, release_id: str, *, preflight_token: str, idempotency_key: str
    ) -> UpdateJob:
        self.calls.append(f"start:{release_id}:{idempotency_key}")
        return self.job_result

    async def job(self, job_id: str) -> UpdateJob:
        self.calls.append(f"job:{job_id}")
        return self.job_result

    async def cancel(self, job_id: str, *, idempotency_key: str) -> UpdateJob:
        self.calls.append(f"cancel:{job_id}:{idempotency_key}")
        return self.job_result

    async def rollback(self, job_id: str, *, idempotency_key: str) -> UpdateJob:
        self.calls.append(f"rollback:{job_id}:{idempotency_key}")
        return self.job_result


def _client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    rbac_enabled: bool = False,
    auth_enabled: bool = True,
):
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        auth_enabled=auth_enabled,
        auth_jwt_secret="system-update-test-secret",
        # The supervisor service is mocked in these API-gate tests. Keep the
        # in-memory ES state store so no external PostgreSQL is required.
        state_backend="elasticsearch",
    )
    provider = MockProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    service = _FakeUpdateService()
    monkeypatch.setattr(routes_updates, "_service", lambda _state: service)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac_enabled
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        _STATE["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(base_router, dependencies=[Depends(require_auth)])
    api.include_router(updates_router, dependencies=[Depends(require_auth)])
    # The production stack (main.py): every request gets its own request id, so the
    # same-key retries below run exactly as they do in a deployment.
    api.add_middleware(RequestIdMiddleware)
    return TestClient(api), service


def _login(client: TestClient, username: str = "Admin", password: str = "Admin@123"):
    response = client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    return response


def test_browser_update_bodies_are_minimal_and_forbid_artifact_inputs() -> None:
    with pytest.raises(ValidationError):
        routes_updates.UpdatePreflightRequest.model_validate(
            {
                "release_id": "v0.1.3",
                "idempotency_key": _IDEMPOTENCY,
                "plan_url": "https://attacker.invalid/plan.json",
            }
        )
    assert "updater" in UpdateScope(state_backend="postgres").components_updated
    assert UpdateComponent(
        id="updater",
        label="Updater",
        scope="updated",
        will_update=True,
    ).id == "updater"


def test_explicit_login_super_admin_can_preflight_and_each_request_is_audited_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The audit is idempotent per request: the same request sent again (its request
    id, session and address) confirms its rows, while a retry as a new request (a new
    request id) is recorded with its own rows (Round 14 SPEC §4.5.3: who asked, from
    where). The supervisor is idempotent on the key either way."""
    client, service = _client(monkeypatch, rbac_enabled=True)
    with client:
        _login(client)
        body = {"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY}
        same = {"X-Request-ID": "update-request-0001"}
        first = client.post("/api/system-updates/preflight", json=body, headers=same)
        resent = client.post("/api/system-updates/preflight", json=body, headers=same)
        assert first.status_code == resent.status_code == 200
        state = _STATE["state"]
        # The actual append-only store is queried below with a tiny event-loop helper.
        import asyncio

        def _rows() -> list[dict]:
            return asyncio.run(
                state.control_audit.records(
                    action_type=ActionType.SYSTEM_UPDATE.value, limit=50
                )
            )

        rows = _rows()
        assert len(rows) == 2
        assert {r["request_id"] for r in rows} == {"update-request-0001"}
        retry = client.post("/api/system-updates/preflight", json=body)
        assert retry.status_code == 200
        rows = _rows()
        assert len(rows) == 4
        assert sorted(r["action"] for r in rows) == [
            "update.preflight_accepted", "update.preflight_accepted",
            "update.preflight_requested", "update.preflight_requested",
        ]
        assert len({r["request_id"] for r in rows}) == 2
        assert len(service.calls) == 3


def test_direct_mint_lazy_session_is_not_deployment_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch)
    with client:
        state = _STATE["state"]
        minted = state.auth.mint_session("Admin")
        assert minted is not None
        token, _ = minted
        response = client.post(
            "/api/system-updates/preflight",
            headers={"Authorization": f"Bearer {token}"},
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 401
        assert response.json()["detail"]["reason"] == "registered_session_required"
        assert service.calls == []


def test_auth_disabled_is_a_hard_mutation_blocker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch, auth_enabled=False)
    with client:
        response = client.post(
            "/api/system-updates/preflight",
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "update_auth_required"
        assert service.calls == []


def test_non_owner_is_denied_even_when_rbac_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch, rbac_enabled=False)
    with client:
        _login(client)
        created = client.post(
            "/api/users",
            json={
                "username": "analyst",
                "password": "Analyst-pass-123!",
                "role": "analyst_tier2",
            },
        )
        assert created.status_code == 200, created.text
        client.cookies.clear()
        _login(client, "analyst", "Analyst-pass-123!")
        response = client.post(
            "/api/system-updates/preflight",
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "update_owner_required"
        assert service.calls == []


@pytest.mark.parametrize(
    "failure",
    [
        "store",
        "token_version",
        "session_token_version",
        "identity",
        "malformed_session",
        "inactive",
        "stale",
        "unknown_age",
        "reauth_store",
    ],
)
def test_session_and_reauthentication_failures_deny_before_supervisor(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    client, service = _client(monkeypatch)
    with client:
        login = _login(client)
        state = _STATE["state"]
        if failure == "store":
            async def broken_get(_sid: str):
                raise RuntimeError("synthetic session-store failure")

            monkeypatch.setattr(state.sessions, "get", broken_get)
        elif failure == "token_version":
            async def newer_version(_username: str) -> int:
                return 1

            monkeypatch.setattr(state.sessions, "token_version_for", newer_version)
        elif failure == "malformed_session":
            async def malformed_session(_sid: str):
                return ["not", "a", "session", "record"]

            monkeypatch.setattr(state.sessions, "get", malformed_session)
        elif failure in {"session_token_version", "identity"}:
            original_get = state.sessions.get

            async def changed_session(sid: str):
                row = dict(await original_get(sid) or {})
                if failure == "session_token_version":
                    row["token_version"] = 99
                else:
                    row["username"] = "different-operator"
                return row

            monkeypatch.setattr(state.sessions, "get", changed_session)
        elif failure == "inactive":
            monkeypatch.setattr(state.sessions, "is_active", lambda *_args, **_kwargs: "revoked")
        elif failure == "stale":
            monkeypatch.setattr(state.sessions, "reauth_age_seconds", lambda _row: 99_999)
        elif failure == "unknown_age":
            monkeypatch.setattr(state.sessions, "reauth_age_seconds", lambda _row: None)
        else:
            def broken_reauth_age(_row):
                raise RuntimeError("synthetic reauthentication-store failure")

            monkeypatch.setattr(state.sessions, "reauth_age_seconds", broken_reauth_age)

        response = client.post(
            "/api/system-updates/preflight",
            headers={"Authorization": f"Bearer {login.json()['token']}"},
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code in {401, 503}
        assert service.calls == []


def test_audit_intent_failure_prevents_supervisor_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch)
    with client:
        _login(client)
        state = _STATE["state"]

        async def unavailable(**_kwargs):
            raise RuntimeError("synthetic audit outage")

        monkeypatch.setattr(state.control_audit, "record_strict", unavailable)
        response = client.post(
            "/api/system-updates/preflight",
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "update_audit_unavailable"
        assert service.calls == []


def test_strict_intent_precedes_supervisor_and_result_follows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch)
    with client:
        _login(client)
        state = _STATE["state"]
        original_record = state.control_audit.record_strict
        events: list[str] = []

        async def ordered_record(**kwargs):
            summary = str(kwargs.get("result_summary", ""))
            events.append("intent" if summary.startswith("intent ") else "result")
            await original_record(**kwargs)

        async def ordered_preflight(
            release_id: str, *, idempotency_key: str
        ) -> UpdatePreflight:
            events.append("supervisor")
            return _preflight()

        monkeypatch.setattr(state.control_audit, "record_strict", ordered_record)
        monkeypatch.setattr(service, "preflight", ordered_preflight)
        response = client.post(
            "/api/system-updates/preflight",
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 200, response.text
        assert events == ["intent", "supervisor", "result"]


def test_result_audit_failure_never_returns_supervisor_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch)
    with client:
        _login(client)
        state = _STATE["state"]
        original_record = state.control_audit.record_strict

        async def fail_result(**kwargs):
            if str(kwargs.get("result_summary", "")).startswith("result "):
                raise RuntimeError("synthetic result-audit outage")
            await original_record(**kwargs)

        monkeypatch.setattr(state.control_audit, "record_strict", fail_result)
        response = client.post(
            "/api/system-updates/preflight",
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "update_result_audit_unavailable"
        assert service.calls == [f"preflight:v0.1.3:{_IDEMPOTENCY}"]


def test_supervisor_rejection_is_curated_and_strictly_audited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch)
    with client:
        _login(client)

        async def reject(_release_id: str, *, idempotency_key: str):
            del idempotency_key
            raise SupervisorRejected(409, "preflight_blocked", "Preflight is blocked.")

        monkeypatch.setattr(service, "preflight", reject)
        response = client.post(
            "/api/system-updates/preflight",
            json={"release_id": "v0.1.3", "idempotency_key": _IDEMPOTENCY},
        )
        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "preflight_blocked",
            "message": "Preflight is blocked.",
        }

        import asyncio

        rows = asyncio.run(
            _STATE["state"].control_audit.records(
                action_type=ActionType.SYSTEM_UPDATE.value, limit=50
            )
        )
        assert len(rows) == 2
        result = next(
            row for row in rows if str(row.get("result_summary", "")).startswith("result ")
        )
        assert "SupervisorRejected:preflight_blocked" in result["result_summary"]


def test_terminal_job_poll_is_strictly_audited_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = _client(monkeypatch)
    service.job_result = _job(status="succeeded", stage="completed")
    with client:
        _login(client)
        assert client.get("/api/system-updates/jobs/update-123").status_code == 200
        assert client.get("/api/system-updates/jobs/update-123").status_code == 200
        import asyncio

        rows = asyncio.run(
            _STATE["state"].control_audit.records(
                action_type=ActionType.SYSTEM_UPDATE.value, limit=50
            )
        )
        terminal = [
            row for row in rows
            if str(row.get("result_summary", "")).startswith("terminal job_id=")
        ]
        assert len(terminal) == 1


@pytest.mark.asyncio
async def test_terminal_jobs_reconcile_without_browser_and_replay_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secrets = Secrets(
        _env_file=None,
        auth_enabled=False,
        state_backend="elasticsearch",
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
    )
    provider = MockProvider()
    state = AppState.create(
        secrets=secrets,
        es=InMemoryESClient(),
        provider_overrides={"anthropic": provider, "openai": provider, "mock": provider},
    )
    await state.startup(start_poller=False)
    current = [_job(status="succeeded", stage="completed")]

    monkeypatch.setattr(
        UpdateSupervisorClient, "socket_is_available", lambda _self: True
    )

    async def terminal_page(_self, *, limit: int = 64):
        assert limit == 64
        return SupervisorTerminalPage(jobs=list(current))

    monkeypatch.setattr(UpdateSupervisorClient, "terminals", terminal_page)
    try:
        assert await state.reconcile_system_update_audit() == 1
        assert await state.reconcile_system_update_audit() == 1
        rows = await state.control_audit.records(
            action_type=ActionType.SYSTEM_UPDATE.value, limit=50
        )
        terminal = [
            row
            for row in rows
            if str(row.get("result_summary", "")).startswith("terminal job_id=")
        ]
        assert len(terminal) == 1
        assert terminal[0]["result_summary"].endswith("status=succeeded")

        current[0] = _job(status="rolled_back", stage="completed").model_copy(
            update={"updated_at": "2026-08-03T00:02:00Z"}
        )
        assert await state.reconcile_system_update_audit() == 1
        rows = await state.control_audit.records(
            action_type=ActionType.SYSTEM_UPDATE.value, limit=50
        )
        terminal = [
            row
            for row in rows
            if str(row.get("result_summary", "")).startswith("terminal job_id=")
        ]
        assert len(terminal) == 2
        assert {row["result_summary"].rsplit("=", 1)[-1] for row in terminal} == {
            "succeeded",
            "rolled_back",
        }
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_terminal_reconciliation_recovers_unobserved_success_before_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Receipt history must not depend on a browser polling between transitions."""

    secrets = Secrets(
        _env_file=None,
        auth_enabled=False,
        state_backend="elasticsearch",
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
    )
    provider = MockProvider()
    state = AppState.create(
        secrets=secrets,
        es=InMemoryESClient(),
        provider_overrides={"anthropic": provider, "openai": provider, "mock": provider},
    )
    await state.startup(start_poller=False)
    terminal = _job(status="rolled_back", stage="completed").model_copy(
        update={
            "updated_at": "2026-08-03T00:03:00Z",
            "receipt": UpdateReceipt(
                job_id="update-123",
                release_id="v0.1.3",
                status="succeeded",
                before={"version": "0.1.2", "commit_sha": "b" * 40},
                after={"version": "0.1.3", "commit_sha": _SHA},
                components=["updater", "backend", "webui", "help_center"],
                backup_id="update-123",
                rollback_performed=False,
                started_at="2026-08-03T00:00:00Z",
                completed_at="2026-08-03T00:01:00Z",
            ),
            "rollback_receipt": UpdateReceipt(
                job_id="update-123",
                release_id="v0.1.3",
                status="rolled_back",
                before={"version": "0.1.2", "commit_sha": "b" * 40},
                after={"version": "0.1.2", "commit_sha": "b" * 40},
                components=["backend", "webui", "help_center"],
                backup_id="update-123",
                rollback_performed=True,
                started_at="2026-08-03T00:00:00Z",
                completed_at="2026-08-03T00:02:00Z",
            ),
        }
    )

    monkeypatch.setattr(
        UpdateSupervisorClient, "socket_is_available", lambda _self: True
    )

    async def terminal_page(_self, *, limit: int = 64):
        assert limit == 64
        return SupervisorTerminalPage(jobs=[terminal])

    monkeypatch.setattr(UpdateSupervisorClient, "terminals", terminal_page)
    try:
        assert await state.reconcile_system_update_audit() == 1
        assert await state.reconcile_system_update_audit() == 1
        rows = await state.control_audit.records(
            action_type=ActionType.SYSTEM_UPDATE.value, limit=50
        )
        transitions = sorted(
            (
                row["ts"],
                row["result_summary"].rsplit("=", 1)[-1],
            )
            for row in rows
            if str(row.get("result_summary", "")).startswith("terminal job_id=")
        )
        assert transitions == [
            ("2026-08-03T00:01:00Z", "succeeded"),
            ("2026-08-03T00:02:00Z", "rolled_back"),
        ]
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_terminal_reconciliation_is_noop_without_supervisor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secrets = Secrets(
        _env_file=None,
        auth_enabled=False,
        state_backend="elasticsearch",
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
    )
    provider = MockProvider()
    state = AppState.create(
        secrets=secrets,
        es=InMemoryESClient(),
        provider_overrides={"anthropic": provider, "openai": provider, "mock": provider},
    )
    await state.startup(start_poller=False)
    monkeypatch.setattr(
        UpdateSupervisorClient, "socket_is_available", lambda _self: False
    )
    try:
        assert await state.reconcile_system_update_audit() == 0
        rows = await state.control_audit.records(
            action_type=ActionType.SYSTEM_UPDATE.value, limit=50
        )
        assert rows == []
    finally:
        await state.shutdown()


class _RetrySupervisor:
    def __init__(self) -> None:
        self.preflight_payloads: list[dict] = []
        self.start_payloads: list[dict] = []

    async def preflight(self, payload: dict) -> UpdatePreflight:
        self.preflight_payloads.append(payload)
        return _preflight()

    async def start(self, payload: dict) -> UpdateJob:
        self.start_payloads.append(payload)
        return _job()


@pytest.mark.asyncio
async def test_preflight_then_start_uses_distinct_operation_keys(
    app_state: AppState,
) -> None:
    preflight_key = "preflight-request-key-000000000001"
    start_key = "start-request-key-0000000000000001"
    supervisor = _RetrySupervisor()
    service = UpdateService(app_state)
    service.client = supervisor

    async def authorized(_release_id: str) -> UpdateRelease:
        return _release()

    service.require_release = authorized  # type: ignore[method-assign]
    checked = await service.preflight(
        "v0.1.3", idempotency_key=preflight_key
    )
    started = await service.start(
        "v0.1.3",
        preflight_token=checked.preflight_token,
        idempotency_key=start_key,
    )

    assert preflight_key != start_key
    assert checked.release.release_id == "v0.1.3"
    assert started.release_id == "v0.1.3"
    assert len(supervisor.preflight_payloads) == 1
    assert len(supervisor.start_payloads) == 1


@pytest.mark.asyncio
async def test_exact_preflight_retry_survives_discovery_drift(
    app_state: AppState,
) -> None:
    first = UpdateService(app_state)
    supervisor = _RetrySupervisor()
    first.client = supervisor

    async def initially_authorized(_release_id: str) -> UpdateRelease:
        return _release()

    first.require_release = initially_authorized  # type: ignore[method-assign]
    result = await first.preflight("v0.1.3", idempotency_key=_IDEMPOTENCY)
    assert result.release.release_id == "v0.1.3"

    # Simulate a replaced backend whose mutable Stable observation is now current
    # or unavailable. The exact persisted request remains replayable.
    retry = UpdateService(app_state)
    retry.client = supervisor

    async def discovery_drifted(_release_id: str) -> UpdateRelease:
        raise AssertionError("exact retry must not reopen mutable discovery")

    retry.require_release = discovery_drifted  # type: ignore[method-assign]
    replay = await retry.preflight("v0.1.3", idempotency_key=_IDEMPOTENCY)
    assert replay.release.release_id == "v0.1.3"
    assert len(supervisor.preflight_payloads) == 2
    assert supervisor.preflight_payloads[0] == supervisor.preflight_payloads[1]

    with pytest.raises(UpdateCapabilityError) as changed_release:
        await retry.preflight("v0.1.4", idempotency_key=_IDEMPOTENCY)
    assert changed_release.value.code == "idempotency_conflict"

    with pytest.raises(AssertionError):
        await retry.preflight(
            "v0.1.3", idempotency_key="new-request-key-000000000000001"
        )


@pytest.mark.asyncio
async def test_exact_start_retry_binds_preflight_token(
    app_state: AppState,
) -> None:
    key = "start-request-key-00000000000001"
    token = "preflight_token_1234567890"
    supervisor = _RetrySupervisor()
    first = UpdateService(app_state)
    first.client = supervisor

    async def initially_authorized(_release_id: str) -> UpdateRelease:
        return _release()

    first.require_release = initially_authorized  # type: ignore[method-assign]
    await first.start(
        "v0.1.3", preflight_token=token, idempotency_key=key
    )

    retry = UpdateService(app_state)
    retry.client = supervisor

    async def discovery_drifted(_release_id: str) -> UpdateRelease:
        raise AssertionError("exact retry must use the durable release binding")

    retry.require_release = discovery_drifted  # type: ignore[method-assign]
    await retry.start(
        "v0.1.3", preflight_token=token, idempotency_key=key
    )
    assert len(supervisor.start_payloads) == 2
    assert supervisor.start_payloads[0] == supervisor.start_payloads[1]

    with pytest.raises(UpdateCapabilityError) as changed_token:
        await retry.start(
            "v0.1.3",
            preflight_token="different_preflight_token_123",
            idempotency_key=key,
        )
    assert changed_token.value.code == "idempotency_conflict"
    assert len(supervisor.start_payloads) == 2


@pytest.mark.asyncio
async def test_update_journal_failure_prevents_supervisor_mutation(
    app_state: AppState,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = UpdateService(app_state)
    supervisor = _RetrySupervisor()
    service.client = supervisor

    async def initially_authorized(_release_id: str) -> UpdateRelease:
        return _release()

    async def unavailable_reservation(**_kwargs):
        raise RuntimeError("synthetic state backend failure")

    service.require_release = initially_authorized  # type: ignore[method-assign]
    monkeypatch.setattr(service.operations, "reserve", unavailable_reservation)
    with pytest.raises(UpdateCapabilityError) as failure:
        await service.preflight(
            "v0.1.3", idempotency_key="journal-failure-key-00000000001"
        )
    assert failure.value.code == "update_journal_unavailable"
    assert failure.value.status_code == 503
    assert supervisor.preflight_payloads == []


@pytest.mark.asyncio
async def test_update_operation_binding_is_durable_and_strict_on_sql() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        first = UpdateOperationStore(SqlKVStore(engine))
        fingerprint = "a" * 64
        record = await first.reserve(
            operation="preflight",
            release=_release(),
            idempotency_key=_IDEMPOTENCY,
            request_fingerprint=fingerprint,
        )
        assert record.release.release_id == "v0.1.3"

        restarted = UpdateOperationStore(SqlKVStore(engine))
        replay = await restarted.find_exact(
            operation="preflight",
            release_id="v0.1.3",
            idempotency_key=_IDEMPOTENCY,
            request_fingerprint=fingerprint,
        )
        assert replay is not None
        assert replay.authorized_at == record.authorized_at

        with pytest.raises(UpdateOperationConflict):
            await restarted.find_exact(
                operation="start",
                release_id="v0.1.3",
                idempotency_key=_IDEMPOTENCY,
                request_fingerprint=fingerprint,
            )
    finally:
        await engine.dispose()


class _Discovery:
    async def discover(self, _config):
        return ReleaseDiscoveryResponse(
            enabled=True,
            repository_url="https://github.com/ARYDESTROYER/Agentic-Kibana",
            checked_at="2026-08-03T00:00:00Z",
            cache=ReleaseCacheStatus(hit=False, stale=False, max_age_seconds=3600),
            channels={
                "stable": ReleaseChannelStatus(
                    channel="stable",
                    branch="main",
                    state="available",
                    version="0.1.3",
                    commit_sha=_SHA,
                    release_commit_sha=_SHA,
                    checked_at="2026-08-03T00:00:00Z",
                ),
                "testing": ReleaseChannelStatus(
                    channel="testing",
                    branch="Testing",
                    state="available",
                    version="99.0.0",
                    commit_sha="b" * 40,
                    checked_at="2026-08-03T00:00:00Z",
                ),
            },
        )


class _StaticDiscovery:
    def __init__(self, response: ReleaseDiscoveryResponse | Exception) -> None:
        self.response = response

    async def discover(self, _config):
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class _SupervisorClient:
    def socket_is_available(self) -> bool:
        return True

    async def status(self) -> SupervisorStatus:
        return SupervisorStatus(
            available=True,
            protocol_version="1",
            updater_version="0.1.0",
            state="ready",
            capabilities={
                "preflight": True,
                "start": True,
                "cancel": True,
                "rollback": True,
            },
            message="Ready",
        )


def _policy_service(
    monkeypatch: pytest.MonkeyPatch,
    discovery,
    *,
    config: ReleaseUpdateConfig | None = None,
) -> UpdateService:
    secrets = Secrets(
        _env_file=None,
        auth_enabled=True,
        auth_jwt_secret="durable",
        state_backend="postgres",
        es_store_enabled=False,
        redis_url="",
    )
    state = SimpleNamespace(
        secrets=secrets,
        prefs=SimpleNamespace(release_updates=config or ReleaseUpdateConfig()),
        release_discovery=discovery,
    )
    monkeypatch.setattr("app.engine.update_service.__version__", "0.1.2")
    monkeypatch.setenv("TLSOC_RELEASE_CHANNEL", "stable")
    monkeypatch.setenv("TLSOC_BUILD_SHA", "b" * 40)
    monkeypatch.setattr("app.engine.update_service._auth_secret_is_durable", lambda _s: True)
    monkeypatch.setattr("app.engine.update_service._dynamic_secret_fields", lambda _s: [])
    service = UpdateService(state)
    service.client = _SupervisorClient()
    return service


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("channel", "build_sha", "expected_code"),
    [
        ("testing", "b" * 40, "stable_release_required"),
        ("stable", "unknown", "immutable_build_identity_required"),
    ],
)
async def test_source_or_unstamped_build_requires_host_bootstrap(
    monkeypatch: pytest.MonkeyPatch,
    channel: str,
    build_sha: str,
    expected_code: str,
) -> None:
    service = _policy_service(monkeypatch, _Discovery())
    monkeypatch.setenv("TLSOC_RELEASE_CHANNEL", channel)
    monkeypatch.setenv("TLSOC_BUILD_SHA", build_sha)

    status = await service.status()

    assert status.capability.supported is False
    assert status.capability.bootstrap_required is True
    assert expected_code in {
        issue.code for issue in status.capability.blockers
    }


@pytest.mark.asyncio
async def test_capability_uses_stable_only_and_truthfully_includes_updater(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _policy_service(monkeypatch, _Discovery())

    status = await service.status()
    assert status.capability.supported is True
    assert status.release_discovery.state == "candidate_observed"
    assert status.release_discovery.observed_release is not None
    assert status.release_discovery.observed_release.version == "0.1.3"
    assert "updater" in status.capability.scope.components_updated
    public_status = status.model_dump(mode="json")
    assert "installable_release" not in public_status
    serialized = status.model_dump_json()
    assert "repository_url" not in serialized
    assert "commit_sha\":\"aaaaaaaa" not in serialized
    assert "plan_url" not in serialized
    assert "bundle_url" not in serialized

    release = await service.require_release("v0.1.3")
    payload = service._supervisor_release(release)
    assert payload["plan_url"].endswith("/v0.1.3/upgrade-plan.json")
    assert payload["bundle_url"].endswith(
        "/v0.1.3/upgrade-plan.sigstore.json"
    )


@pytest.mark.asyncio
async def test_candidate_uses_immutable_annotated_tag_when_main_advances(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tag_sha = "c" * 40
    response = ReleaseDiscoveryResponse(
        enabled=True,
        repository_url="https://github.com/ARYDESTROYER/Agentic-Kibana",
        checked_at="2026-08-03T00:00:00Z",
        cache=ReleaseCacheStatus(hit=False, stale=False, max_age_seconds=3600),
        channels={
            "stable": ReleaseChannelStatus(
                channel="stable",
                branch="main",
                state="available",
                version="0.1.3",
                commit_sha="d" * 40,
                release_commit_sha=tag_sha,
                checked_at="2026-08-03T00:00:00Z",
            ),
            "testing": ReleaseChannelStatus(
                channel="testing", branch="Testing", state="disabled"
            ),
        },
    )
    service = _policy_service(monkeypatch, _StaticDiscovery(response))

    candidate = await service.require_release("v0.1.3")

    assert candidate.commit_sha == tag_sha
    assert candidate.commit_sha != response.channels["stable"].commit_sha
    assert service._supervisor_release(candidate)["commit_sha"] == tag_sha


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("expected_state", "stable", "cache_stale", "has_observation", "has_issue"),
    [
        (
            "current",
            ReleaseChannelStatus(
                channel="stable",
                branch="main",
                state="available",
                version="0.1.2",
                commit_sha=_SHA,
                release_commit_sha=_SHA,
                checked_at="2026-08-03T00:00:00Z",
            ),
            False,
            True,
            False,
        ),
        (
            "candidate_observed",
            ReleaseChannelStatus(
                channel="stable",
                branch="main",
                state="available",
                version="0.1.3",
                commit_sha=_SHA,
                release_commit_sha=_SHA,
                checked_at="2026-08-03T00:00:00Z",
            ),
            False,
            True,
            False,
        ),
        (
            "unavailable",
            ReleaseChannelStatus(
                channel="stable",
                branch="main",
                state="unavailable",
                checked_at="2026-08-03T00:00:00Z",
                error_code="unreachable",
                error_message="GitHub could not be reached.",
            ),
            False,
            False,
            True,
        ),
        (
            "stale",
            ReleaseChannelStatus(
                channel="stable",
                branch="main",
                state="available",
                version="0.1.3",
                commit_sha=_SHA,
                release_commit_sha=_SHA,
                checked_at="2026-08-02T00:00:00Z",
                stale=True,
                error_code="timeout",
                error_message="Latest check failed.",
            ),
            True,
            True,
            True,
        ),
        (
            "error",
            ReleaseChannelStatus(
                channel="stable",
                branch="main",
                state="available",
                version="0.1.3",
                commit_sha="not-a-commit",
                checked_at="2026-08-03T00:00:00Z",
            ),
            False,
            False,
            True,
        ),
    ],
)
async def test_release_discovery_projection_is_explicit_and_untrusted(
    monkeypatch: pytest.MonkeyPatch,
    expected_state: str,
    stable: ReleaseChannelStatus,
    cache_stale: bool,
    has_observation: bool,
    has_issue: bool,
) -> None:
    response = ReleaseDiscoveryResponse(
        enabled=True,
        repository_url="https://github.com/ARYDESTROYER/Agentic-Kibana",
        checked_at="2026-08-03T00:00:00Z",
        cache=ReleaseCacheStatus(
            hit=False, stale=cache_stale, max_age_seconds=3600
        ),
        channels={
            "stable": stable,
            "testing": ReleaseChannelStatus(
                channel="testing", branch="Testing", state="disabled"
            ),
        },
    )
    service = _policy_service(monkeypatch, _StaticDiscovery(response))

    status = await service.status()
    projection = status.release_discovery.model_dump(mode="json")

    assert projection["state"] == expected_state
    assert (projection["observed_release"] is not None) is has_observation
    assert (projection["issue"] is not None) is has_issue
    assert set(projection) == {
        "state",
        "checked_at",
        "branch",
        "observed_release",
        "issue",
    }
    encoded = status.release_discovery.model_dump_json()
    assert "github.com" not in encoded
    assert _SHA not in encoded
    assert "plan_url" not in encoded
    assert "bundle_url" not in encoded
    if projection["observed_release"] is not None:
        assert projection["observed_release"]["provenance"] == (
            "mutable_stable_branch_metadata"
        )
        assert projection["observed_release"]["verification"] == (
            "signed_supervisor_preflight_required"
        )


@pytest.mark.asyncio
async def test_release_discovery_not_checked_and_unexpected_error_are_distinct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    disabled = _policy_service(
        monkeypatch,
        _StaticDiscovery(AssertionError("disabled discovery must not be called")),
        config=ReleaseUpdateConfig(enabled=False),
    )
    assert (await disabled.status()).release_discovery.state == "not_checked"

    failed = _policy_service(
        monkeypatch,
        _StaticDiscovery(RuntimeError("provider detail must stay private")),
    )
    failed_status = await failed.status()
    assert failed_status.release_discovery.state == "error"
    assert failed_status.release_discovery.issue is not None
    assert failed_status.release_discovery.issue.code == "release_discovery_error"
    assert "provider detail" not in failed_status.model_dump_json()


@pytest.mark.asyncio
async def test_capability_reports_fail_closed_blockers_without_secrets(
    app_state: AppState,
) -> None:
    service = UpdateService(app_state)
    status = await service.status()
    codes = {issue.code for issue in status.capability.blockers}
    assert {"auth_required", "postgres_state_required", "supervisor_unavailable"} <= codes
    assert status.capability.supported is False
    serialized = status.model_dump_json()
    assert "api_key" not in serialized
    assert "password" not in serialized


@pytest.mark.asyncio
async def test_supervisor_client_rejects_malformed_wire_payloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = UpdateSupervisorClient("/run/unused-test.sock")

    async def malformed_status(*_args, **_kwargs):
        return {
            "available": True,
            "protocol_version": "1",
            "updater_version": "0.1.0",
            "state": "busy",
            "active_job": {
                "job_id": "update-123",
                "release_id": "v0.1.3",
                "status": "invented",
                "stage": "observing",
                "progress": 92,
            },
        }

    monkeypatch.setattr(client, "_request", malformed_status)
    with pytest.raises(ValidationError):
        await client.status()

    async def drifted_status(*_args, **_kwargs):
        return {
            "available": True,
            "protocol_version": "1",
            "updater_version": "0.1.0",
            "state": "ready",
            "capabilities": {"start": True},
            "unexpected_protocol_field": True,
        }

    monkeypatch.setattr(client, "_request", drifted_status)
    with pytest.raises(ValidationError):
        await client.status()


@pytest.mark.asyncio
async def test_supervisor_terminal_page_is_strict_and_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = UpdateSupervisorClient("/run/unused-test.sock")

    async def drifted_page(*_args, **_kwargs):
        return {
            "jobs": [_job(status="succeeded", stage="completed").model_dump()],
            "unexpected_protocol_field": True,
        }

    monkeypatch.setattr(client, "_request", drifted_page)
    with pytest.raises(ValidationError):
        await client.terminals()
    with pytest.raises(ValueError):
        await client.terminals(limit=0)
    with pytest.raises(ValueError):
        await client.terminals(limit=65)


@pytest.mark.asyncio
async def test_missing_supervisor_socket_fails_closed(tmp_path) -> None:
    client = UpdateSupervisorClient(str(tmp_path / "missing.sock"))
    assert client.socket_is_available() is False
    with pytest.raises(SupervisorUnavailable):
        await client.status()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "error_type"),
    [
        (
            httpx.Response(200, headers={"content-type": "text/plain"}, content=b"{}"),
            SupervisorUnavailable,
        ),
        (
            httpx.Response(
                200,
                headers={"content-type": "application/json"},
                content=b"not-json",
            ),
            SupervisorUnavailable,
        ),
        (
            httpx.Response(
                200,
                headers={
                    "content-type": "application/json",
                    "content-length": str(1024 * 1024 + 1),
                },
                content=b"{}",
            ),
            SupervisorUnavailable,
        ),
        (
            httpx.Response(
                302,
                headers={"content-type": "application/json"},
                json={"code": "redirect", "message": "Redirect rejected"},
            ),
            SupervisorRejected,
        ),
    ],
)
async def test_supervisor_transport_rejects_invalid_or_redirected_responses(
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response,
    error_type: type[Exception],
) -> None:
    transport = httpx.MockTransport(lambda _request: response)
    monkeypatch.setattr(
        "app.engine.update_supervisor.httpx.AsyncHTTPTransport",
        lambda **_kwargs: transport,
    )
    client = UpdateSupervisorClient("/run/unused-test.sock")
    monkeypatch.setattr(client, "socket_is_available", lambda: True)
    with pytest.raises(error_type):
        await client.status()


@pytest.mark.asyncio
async def test_malformed_supervisor_status_becomes_capability_blocker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secrets = Secrets(
        _env_file=None,
        auth_enabled=True,
        auth_jwt_secret="durable",
        state_backend="postgres",
        es_store_enabled=False,
        redis_url="",
    )
    state = SimpleNamespace(
        secrets=secrets,
        prefs=SimpleNamespace(release_updates=ReleaseUpdateConfig()),
        release_discovery=_Discovery(),
    )
    monkeypatch.setattr("app.engine.update_service._auth_secret_is_durable", lambda _s: True)
    monkeypatch.setattr("app.engine.update_service._dynamic_secret_fields", lambda _s: [])

    class _MalformedClient:
        def socket_is_available(self) -> bool:
            return True

        async def status(self):
            return SupervisorStatus.model_validate(
                {
                    "available": True,
                    "state": "busy",
                    "active_job": {
                        "job_id": "update-123",
                        "release_id": "v0.1.3",
                        "status": "invented",
                        "stage": "observing",
                        "progress": 92,
                    },
                }
            )

    service = UpdateService(state)
    service.client = _MalformedClient()
    result = await service.status()
    assert result.capability.supported is False
    assert "supervisor_unavailable" in {
        blocker.code for blocker in result.capability.blockers
    }

    class _RejectedClient:
        def socket_is_available(self) -> bool:
            return True

        async def status(self):
            raise SupervisorRejected(500, "supervisor_error", "Synthetic rejection")

    service.client = _RejectedClient()
    rejected = await service.status()
    assert rejected.capability.supported is False
    assert "supervisor_unavailable" in {
        blocker.code for blocker in rejected.capability.blockers
    }


@pytest.mark.asyncio
async def test_incomplete_supervisor_capabilities_are_explicitly_unsupported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = _policy_service(monkeypatch, _Discovery())

    class _IncompleteClient(_SupervisorClient):
        async def status(self) -> SupervisorStatus:
            return SupervisorStatus(
                available=True,
                protocol_version="1",
                updater_version="0.1.0",
                state="ready",
                capabilities={"preflight": True, "start": True},
            )

    service.client = _IncompleteClient()
    status = await service.status()

    assert status.capability.supported is False
    assert status.capability.bootstrap_required is True
    issue = next(
        item
        for item in status.capability.blockers
        if item.code == "supervisor_capabilities_incomplete"
    )
    assert "cancel" in issue.message
    assert "rollback" in issue.message
