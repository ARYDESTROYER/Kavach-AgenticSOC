"""Round 14 roles-09 (backend half): a job file needs, at download time, the grants the
job needed.

An audit export needs ``audit:export`` and ``audit:view``. Once ``audit:export`` is
taken away, its file is refused with a ``403`` the Console can word
(``job_artifact_permission_lost``, a plain message, the grants the job needs and the
ones the caller lacks), nothing is downloaded and no download row is written, and the
refusal is one Access denied row naming the export (a refused read, so a repeated
press inside five minutes adds no second row).

When the strict live check refuses while the caller still holds every grant the job
needs (its read of the account or custom-role records failed), nothing was refused for
lack of a permission: the answer is ``503 job_permission_unverifiable`` and no Access
denied row is written, since one would name grants the caller holds (#2).

Offline: fake Elasticsearch, mock LLM, the real job runner.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from pathlib import Path
from typing import Any

import pytest
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.api import routes_jobs
from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_audit import router as audit_router
from app.api.routes_jobs import ARTIFACT_PERMISSION_LOST, ARTIFACT_PERMISSION_UNVERIFIABLE
from app.api.routes_jobs import router as jobs_router
from app.audit.query import AuditFilters, build_predicate
from app.config import Secrets
from app.constants import JobKind
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import AuditDoc, Job, JobArtifact, JobPermission
from app.state import AppState

FROM = "2026-10-18T15:10:00Z"
TO = "2026-10-25T15:10:00Z"
TERMINAL = {"succeeded", "failed", "cancelled", "partial"}


def _app(tmp_path: Path) -> FastAPI:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, jobs_artifact_dir=str(tmp_path / "artifacts"),
        auth_enabled=True, auth_jwt_secret="job-artifact-permission-secret", auth_seed_admin=True,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = True
        await state.update_prefs(prefs)
        for i in range(5):
            await state.control_audit.write_strict(AuditDoc.model_validate({
                "ts": f"2026-10-19T10:0{i}:00+00:00", "action_type": "auth", "surface": "r14",
                "actor": f"user{i}", "result_summary": f"row {i}",
            }))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, jobs_router, audit_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    api.add_middleware(RequestIdMiddleware)
    return api


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _login(client: TestClient, username: str, password: str) -> None:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _rows(client: TestClient, **filters: Any) -> list[dict[str, Any]]:
    state = _state(client)
    page = client.portal.call(lambda: state.control_audit.search_page(
        build_predicate(AuditFilters(**filters)), order="asc", limit=200))
    return [hit.doc for hit in page.hits]


def _denials(client: TestClient) -> list[dict[str, Any]]:
    state = _state(client)
    return client.portal.call(lambda: state.control_audit.records(action_type="access_denied", limit=200))


def _finished_export(client: TestClient) -> dict[str, Any]:
    accepted = client.post("/api/jobs", json={
        "kind": "audit_export", "idempotency_key": "export-0001",
        "params": {"format": "csv", "scope": "all", "from": FROM, "to": TO, "order": "asc", "filters": {}},
    })
    assert accepted.status_code == 202, accepted.text
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        body = client.get(f"/api/jobs/{accepted.json()['job_id']}").json()
        if body["status"] in TERMINAL:
            assert body["status"] == "succeeded", body
            return body
        time.sleep(0.05)
    raise AssertionError("the export did not finish")


@pytest.fixture
def auditor(tmp_path):
    with TestClient(_app(tmp_path)) as client:
        _login(client, "Admin", "Admin@123")
        created = client.post("/api/users", json={"username": "aud", "password": "auditor-pass-12345",
                                                  "role": "auditor"})
        assert created.status_code == 200, created.text
        client.cookies.clear()
        _login(client, "aud", "auditor-pass-12345")
        yield client


def _deny(client: TestClient, resource: str, action: str) -> None:
    state = _state(client)

    async def apply() -> None:
        prefs = state.prefs.model_copy(deep=True)
        prefs.rbac.denies.setdefault("auditor", {})[resource] = [action]
        await state.update_prefs(prefs)

    client.portal.call(apply)


def test_a_removed_export_grant_refuses_the_file_with_a_worded_code(auditor):
    job = _finished_export(auditor)
    assert auditor.get(f"/api/jobs/{job['job_id']}/artifact").status_code == 200
    assert len(_rows(auditor, event="audit.export_downloaded")) == 1

    _deny(auditor, "audit", "export")
    for _ in range(2):
        refused = auditor.get(f"/api/jobs/{job['job_id']}/artifact")
        assert refused.status_code == 403
        assert "content-disposition" not in refused.headers
        assert refused.json()["detail"] == {
            "code": ARTIFACT_PERMISSION_LOST,
            "message": "You no longer have permission to download audit exports.",
            "required": ["audit:export", "audit:view"],
            "missing": ["audit:export"],
        }
    # Nothing left the server, so there is no second download row.
    assert len(_rows(auditor, event="audit.export_downloaded")) == 1
    # The refusal is one Access denied row naming the export (a refused read).
    rows = _denials(auditor)
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["actor"] == "aud" and row["outcome"] == "denied"
    assert row["result_summary"] == (
        "denied audit:export for role auditor on GET /api/jobs/{job_id}/artifact"
    )
    assert row["target"]["type"] == "export" and row["target"]["id"] == job["job_id"]
    assert row["tool_input"]["repeats_since_previous"] == 0
    assert row["request_id"] and row["actor_role"] == "auditor"


def test_both_grants_are_checked_at_download_time(auditor):
    job = _finished_export(auditor)
    _deny(auditor, "audit", "view")
    refused = auditor.get(f"/api/jobs/{job['job_id']}/artifact")
    assert refused.status_code == 403
    assert refused.json()["detail"]["missing"] == ["audit:view"]


def test_a_live_check_that_cannot_confirm_held_grants_is_no_refusal_row(auditor):
    """The strict live check fails closed (here: its account read failed) while the
    auditor still holds both grants. Nothing was refused for a missing permission, so
    the answer is the retryable 503 and no Access denied row names grants the caller
    holds; nothing is downloaded."""
    job = _finished_export(auditor)
    state = _state(auditor)

    async def unconfirmed(_job: Job) -> bool:
        return False

    state.job_runner.permission_alive = unconfirmed
    for _ in range(2):
        refused = auditor.get(f"/api/jobs/{job['job_id']}/artifact")
        assert refused.status_code == 503
        assert "content-disposition" not in refused.headers
        assert refused.json()["detail"] == {
            "code": ARTIFACT_PERMISSION_UNVERIFIABLE,
            "message": "The download could not be checked just now. Try again.",
        }
    assert _denials(auditor) == []
    assert _rows(auditor, event="audit.export_downloaded") == []


def test_a_role_changed_in_the_stored_account_is_a_refusal_for_that_role(auditor):
    """The stored account's role changed (by another process, so this process's
    session copy still says auditor). The live check reads the stored role and
    refuses; the refusal is the 403 naming what the STORED role lacks, and its row
    names that role, not a 503 and not a row claiming the auditor lacks anything."""
    job = _finished_export(auditor)
    state = _state(auditor)
    from app.constants import UserRole

    client_role = UserRole.ANALYST_TIER1.value
    auditor.portal.call(lambda: state.users.update("aud", role=client_role))
    assert state.auth.principal("aud").role == "auditor"  # the session's copy trails
    refused = auditor.get(f"/api/jobs/{job['job_id']}/artifact")
    assert refused.status_code == 403, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == ARTIFACT_PERMISSION_LOST
    assert "audit:export" in detail["missing"]
    rows = _denials(auditor)
    assert len(rows) == 1, rows
    assert rows[0]["result_summary"].startswith(f"denied {', '.join(detail['missing'])} for role {client_role}")
    assert rows[0]["actor"] == "aud"
    assert _rows(auditor, event="audit.export_downloaded") == []


def test_a_lost_grant_row_names_only_the_missing_grant(auditor):
    """With one of the two grants gone and the live check refusing, the row and the
    body name the missing grant, never the one the caller still holds."""
    job = _finished_export(auditor)
    _deny(auditor, "audit", "view")
    refused = auditor.get(f"/api/jobs/{job['job_id']}/artifact")
    assert refused.status_code == 403
    assert refused.json()["detail"]["missing"] == ["audit:view"]
    rows = _denials(auditor)
    assert len(rows) == 1, rows
    assert rows[0]["tool_input"]["permission"] == "audit:view"
    assert "audit:export" not in rows[0]["result_summary"]


def _request(state: AppState) -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    return Request({"type": "http", "method": "GET", "path": "/api/jobs/job-1/artifact", "headers": [],
                    "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})


def _job(kind: JobKind, params: dict[str, Any], grants: list[tuple[str, str]]) -> Job:
    return Job(
        kind=kind, params=params, request_fingerprint="0" * 64, idempotency_key_hash="1" * 64,
        required_permissions=[JobPermission(resource=r, action=a) for r, a in grants],
        artifact=JobArtifact(artifact_id="a-1", filename="file.zip", content_type="application/zip",
                             size=1, sha256="2" * 64),
    )


class _NoGrants:
    """A resolved access that holds none of the job's grants."""

    user = SimpleNamespace(username="tina", role="analyst_tier1")
    role = "analyst_tier1"

    def allows(self, resource: str, action: str) -> bool:
        return False


@pytest.mark.parametrize(("kind", "params", "grants", "message"), [
    (JobKind.AUDIT_EXPORT, {}, [("audit", "export"), ("audit", "view")],
     "You no longer have permission to download audit exports."),
    (JobKind.DATA_EXPORT_ARCHIVE, {"scopes": ["cases"]}, [("data_export", "export")],
     "You no longer have permission to download data exports."),
    (JobKind.DATA_EXPORT_SEGMENT, {"scopes": ["cases"]}, [("data_export", "export")],
     "You no longer have permission to download data exports."),
    (JobKind.RAG_IMPORT, {}, [("rag", "manage")], "You no longer have permission to download this file."),
])
async def test_the_refusal_names_the_kind_of_file(app_state, monkeypatch, kind, params, grants, message):
    async def no_grants(_request: Request) -> _NoGrants:
        return _NoGrants()

    monkeypatch.setattr(routes_jobs, "resolve_access", no_grants)
    refusal = await routes_jobs._artifact_permission_refusal(  # noqa: SLF001
        _request(app_state), _job(kind, params, grants))
    assert isinstance(refusal, HTTPException) and refusal.status_code == 403
    assert refusal.detail["code"] == ARTIFACT_PERMISSION_LOST
    assert refusal.detail["message"] == message
    assert refusal.detail["required"] == [f"{r}:{a}" for r, a in grants]
    assert refusal.detail["missing"] == [f"{r}:{a}" for r, a in grants]


async def test_unrestricted_access_is_unverifiable_not_a_refusal(app_state):
    """With sign-in off the request's access holds everything, so a live check that
    refused could only have failed to confirm: a 503 and no Access denied row."""
    job = _job(JobKind.DATA_EXPORT_ARCHIVE, {"scopes": ["cases"]}, [("data_export", "export")])
    refusal = await routes_jobs._artifact_permission_refusal(_request(app_state), job)  # noqa: SLF001
    assert isinstance(refusal, HTTPException) and refusal.status_code == 503
    assert refusal.detail == {
        "code": ARTIFACT_PERMISSION_UNVERIFIABLE,
        "message": "The download could not be checked just now. Try again.",
    }
    assert await app_state.control_audit.records(action_type="access_denied", limit=10) == []


async def test_unresolvable_access_is_unverifiable_not_a_refusal(app_state, monkeypatch):
    """An access resolution that breaks (not a 401) confirms nothing: 503, no row."""
    async def broken(_request: Request) -> Any:
        raise RuntimeError("custom role store unreadable")

    monkeypatch.setattr(routes_jobs, "resolve_access", broken)
    job = _job(JobKind.AUDIT_EXPORT, {}, [("audit", "export"), ("audit", "view")])
    refusal = await routes_jobs._artifact_permission_refusal(_request(app_state), job)  # noqa: SLF001
    assert refusal.status_code == 503
    assert refusal.detail["code"] == ARTIFACT_PERMISSION_UNVERIFIABLE
    assert await app_state.control_audit.records(action_type="access_denied", limit=10) == []
