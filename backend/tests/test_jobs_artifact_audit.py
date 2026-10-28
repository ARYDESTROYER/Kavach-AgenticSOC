"""Round 14 SPEC §4.5.6: every job artifact download is audited before it streams.

``GET /api/jobs/{id}/artifact`` appends one row per download to the control audit,
whatever the Demo state (§3.5), naming the job, its kind, the artifact and the
verified size and SHA-256, with the request's context (request id, client). An audit
export's download is ``audit.export_downloaded``; every other kind's is
``job.artifact_downloaded``. The row names the target every other row of the job
names (an ``export`` target whose id is the job), so a download reads as part of its
job. A failed append refuses the download with ``503 audit_unavailable``; a refused
download (gone, corrupt, grant lost) writes no row.
Two kinds are exercised end to end: ``audit_export`` and ``data_export_archive``.
Offline: fake Elasticsearch, SQLite, mock LLM.
"""

from __future__ import annotations

import hashlib
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes_jobs import router as jobs_router
from app.audit.query import AuditFilters, build_predicate
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import AuditDoc
from app.state import AppState

FROM = "2026-10-18T15:10:00Z"
TO = "2026-10-25T15:10:00Z"
TERMINAL = {"succeeded", "failed", "cancelled", "partial"}
DOWNLOAD_ACTIONS = ("job.artifact_downloaded", "audit.export_downloaded")

#: The two kinds exercised: (kind, params, download action, file type, the target
#: label: the file name of an audit export, the exported scopes of a data export).
KINDS = {
    "audit_export": (
        {"format": "csv", "scope": "all", "from": FROM, "to": TO, "order": "asc", "filters": {}},
        "audit.export_downloaded",
        "text/csv",
        "agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv",
    ),
    "data_export_archive": (
        {"scopes": ["configuration"]},
        "job.artifact_downloaded",
        "application/zip",
        "Application data: configuration",
    ),
}
#: The job rows a download pairs with (the worker row that made the file).
WORKER_ACTIONS = {"audit_export": "audit.exported", "data_export_archive": "export.created"}


def _app(tmp_path: Path, backend: str) -> FastAPI:
    extra: dict[str, Any] = {}
    if backend == "sql":
        extra = {"state_backend": "sqlite", "state_db_url": f"sqlite+aiosqlite:///{tmp_path}/state.db"}
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        jobs_artifact_dir=str(tmp_path / "artifacts"),
        **extra,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(jobs_router)
    api.add_middleware(RequestIdMiddleware)
    return api


@pytest.fixture(params=["es", "sql"])
def api(request, tmp_path):
    with TestClient(_app(tmp_path, request.param)) as client:
        yield client


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _seed(client: TestClient, n: int = 6) -> None:
    async def write() -> None:
        for i in range(n):
            await _state(client).control_audit.write_strict(AuditDoc.model_validate({
                "ts": f"2026-10-19T10:00:{i:02d}+00:00", "action_type": "status", "surface": "r14",
                "actor": f"user{i}", "result_summary": f"row {i}",
            }))

    client.portal.call(write)


def _finished_job(client: TestClient, kind: str, key: str = "download-0001") -> dict[str, Any]:
    params = KINDS[kind][0]
    accepted = client.post("/api/jobs", json={"kind": kind, "idempotency_key": key, "params": params})
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in TERMINAL:
            assert body["status"] == "succeeded", body
            return body
        time.sleep(0.05)
    raise AssertionError(f"{kind} job did not finish")


def _rows(client: TestClient, action: str) -> list[dict[str, Any]]:
    state = _state(client)
    page = client.portal.call(lambda: state.control_audit.search_page(
        build_predicate(AuditFilters(event=action)), order="asc", limit=100))
    return [hit.doc for hit in page.hits]


def _download_rows(client: TestClient) -> list[dict[str, Any]]:
    return [row for action in DOWNLOAD_ACTIONS for row in _rows(client, action)]


def job_artifact_name(client: TestClient, job_id: str) -> str:
    job = client.portal.call(_state(client).jobs.get, job_id)
    assert job is not None and job.artifact is not None
    return job.artifact.filename


def _artifact_path(client: TestClient, job_id: str) -> Path:
    state = _state(client)
    job = client.portal.call(state.jobs.get, job_id)
    assert job is not None and job.artifact is not None
    return state.job_runner.artifact_path(job.artifact.artifact_id, job.artifact.filename)


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_every_download_is_audited_with_its_file_and_request(api, kind):
    _seed(api)
    job = _finished_job(api, kind)
    _params, action, content_type, label = KINDS[kind]
    download = api.get(f"/api/jobs/{job['job_id']}/artifact")
    assert download.status_code == 200
    assert download.headers["content-type"].startswith(content_type)
    rows = _download_rows(api)
    assert len(rows) == 1
    row = rows[0]
    assert row["action"] == action
    assert row["action_type"] == "data_export" and row["surface"] == "jobs"
    assert row["outcome"] == "success" and row["actor_type"] == "human"
    target = {k: row["target"].get(k) for k in ("type", "id", "label")}
    assert target == {"type": "export", "id": job["job_id"], "label": label}
    # The same target as the worker row that made the file: one job, one target.
    [worker] = _rows(api, WORKER_ACTIONS[kind])
    assert worker["target"] == row["target"]
    digest = hashlib.sha256(download.content).hexdigest()
    assert row["tool_input"] == {
        "job_id": job["job_id"],
        "kind": kind,
        "artifact_id": job["result"]["artifact_id"],
        "bytes": len(download.content),
        "sha256": digest,
    }
    filename = job_artifact_name(api, job["job_id"])
    assert filename in download.headers["content-disposition"]
    assert row["result_summary"].startswith(f"downloaded {filename} (")
    assert f"SHA-256 {digest}" in row["result_summary"]
    assert row["request_id"] == download.headers["x-request-id"]
    assert row["client"]["ip_source"] == "peer"
    # Each download is its own row.
    again = api.get(f"/api/jobs/{job['job_id']}/artifact")
    assert again.status_code == 200
    assert len(_download_rows(api)) == 2


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_download_that_cannot_be_audited_is_refused(api, kind, monkeypatch):
    _seed(api)
    job = _finished_job(api, kind)
    state = _state(api)
    real = state.control_audit.record_strict

    async def failing(**kwargs: Any) -> Any:
        if kwargs.get("action") in DOWNLOAD_ACTIONS:
            raise RuntimeError("audit store down")
        return await real(**kwargs)

    monkeypatch.setattr(state.control_audit, "record_strict", failing)
    refused = api.get(f"/api/jobs/{job['job_id']}/artifact")
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "audit_unavailable"
    assert "content-disposition" not in refused.headers
    assert refused.content != _artifact_path(api, job["job_id"]).read_bytes()


def test_a_corrupt_artifact_is_refused_without_a_download_row(api):
    _seed(api)
    job = _finished_job(api, "audit_export")
    path = _artifact_path(api, job["job_id"])
    path.write_bytes(path.read_bytes() + b"tampered")
    refused = api.get(f"/api/jobs/{job['job_id']}/artifact")
    assert refused.status_code == 410
    assert _download_rows(api) == []


def test_a_lost_grant_is_refused_without_a_download_row(api, monkeypatch):
    _seed(api)
    job = _finished_job(api, "audit_export")
    state = _state(api)

    async def gone(_job: Any) -> bool:
        return False

    monkeypatch.setattr(state.job_runner, "permission_alive", gone)
    refused = api.get(f"/api/jobs/{job['job_id']}/artifact")
    assert refused.status_code == 403
    assert _download_rows(api) == []


def test_downloads_are_audited_in_the_control_store_in_demo_mode(api):
    _seed(api)
    job = _finished_job(api, "data_export_archive")
    state = _state(api)
    demo_calls: list[dict[str, Any]] = []

    async def demo_record(**kwargs: Any) -> None:
        demo_calls.append(kwargs)

    demo_audit = SimpleNamespace(record_strict=demo_record, record=demo_record)
    state._demo = SimpleNamespace(audit=demo_audit, run_id="demo-download")  # noqa: SLF001
    try:
        download = api.get(f"/api/jobs/{job['job_id']}/artifact")
    finally:
        state._demo = None  # noqa: SLF001
    assert download.status_code == 200
    assert demo_calls == []
    rows = _download_rows(api)
    assert [row["action"] for row in rows] == ["job.artifact_downloaded"]
