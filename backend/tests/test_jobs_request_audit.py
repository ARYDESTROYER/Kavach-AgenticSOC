"""Round 14 SPEC §3.6, §4.5.4: the request that submits a reset or a data export job
is audited before the job exists, like an audit export's.

``POST /api/jobs`` appends the requested row first (``reset.requested`` for a
``tiered_reset``, ``export.requested`` for a ``data_export_archive`` or
``data_export_segment``), then creates the job. That row is the only row of the job
that records who asked and from where: the client (the socket peer, never a forged
``X-Forwarded-For``), the session reference, the role at the time and the request id.
The worker's own rows (``reset.started``, ``export.created``) are keyed, appended again
when a job resumes, and so keep carrying none of those fields. Every row of one job,
the requested row, the worker rows and each download of the job's file, names the job
as its target, so a reader sees one job (``GET /api/audit?target=<job id>``). A failed
append creates nothing (``503 audit_unavailable``); a create that fails after its row
gets the ``<resource>.request_failed`` row; a client retry writes no second row; a
racing duplicate closes its row with the job it joined; while a failed factory reset
holds the recovery fence, any request but a factory retry is refused before its row.
Every row goes to the control audit. Offline: fake Elasticsearch, SQLite, mock LLM.
"""

from __future__ import annotations

import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_audit import router as audit_router
from app.api.routes_jobs import router as jobs_router
from app.audit.query import AuditFilters, build_predicate
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.state import AppState
from app.stores.jobs import FACTORY_RECOVERY_REFUSAL, JobCapacityError

TERMINAL = {"succeeded", "failed", "cancelled", "partial"}
PEER = "203.0.113.9"
FORGED = "1.1.1.1"
#: The request-driven fields a worker row never carries (SPEC §4.5.3).
REQUEST_FIELDS = ("client", "request_id", "session_ref", "actor_role")
SESSION_REF = re.compile(r"^[0-9a-f]{16}$")

#: The kinds whose submit is audited here, with params, the requested action, the
#: worker row that follows it and that row's target.
KINDS: dict[str, dict[str, Any]] = {
    "tiered_reset": {
        "params": {"scope": "cases", "confirm": "RESET CASES"},
        "requested": "reset.requested",
        "worker": "reset.started",
        "action_type": "reset",
        "surface": "admin",
    },
    "data_export_archive": {
        "params": {"scopes": ["configuration"]},
        "requested": "export.requested",
        "worker": "export.created",
        "action_type": "data_export",
        "surface": "settings",
    },
    "data_export_segment": {
        "params": {"scopes": ["configuration"], "page_size": 1000},
        "requested": "export.requested",
        "worker": "export.created",
        "action_type": "data_export",
        "surface": "settings",
    },
}
REQUESTED_ACTIONS = ("reset.requested", "export.requested")


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #
class _PeerShim:
    """Test-only ASGI wrapper that gives every request a real socket peer address
    (the TestClient's own peer is the non-address ``testclient``). The peer is not a
    trusted proxy, so a forwarded header it sends must never become the client IP."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope.get("type") == "http":
            scope = dict(scope)
            scope["client"] = (PEER, 40000)
        await self.app(scope, receive, send)


def _secrets(tmp_path: Path, backend: str, **extra: Any) -> Secrets:
    more: dict[str, Any] = {}
    if backend == "sql":
        more = {"state_backend": "sqlite", "state_db_url": f"sqlite+aiosqlite:///{tmp_path}/state.db"}
    return Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        jobs_artifact_dir=str(tmp_path / "artifacts"),
        **more,
        **extra,
    )


def _app(secrets: Secrets) -> FastAPI:
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
    deps = [Depends(require_auth)] if secrets.auth_enabled else []
    api.include_router(base_router, dependencies=deps)
    api.include_router(jobs_router, dependencies=deps)
    api.include_router(audit_router, dependencies=deps)
    api.add_middleware(RequestIdMiddleware)
    return api


class _Harness:
    """A client plus the application whose state it drives."""

    def __init__(self, api: FastAPI, client: TestClient) -> None:
        self.api = api
        self.client = client

    @property
    def state(self) -> AppState:
        return self.api.state.tlsoc

    def call(self, fn, *args: Any) -> Any:
        return self.client.portal.call(fn, *args)


@pytest.fixture(params=["es", "sql"])
def h(request, tmp_path):
    api = _app(_secrets(tmp_path, request.param))
    with TestClient(_PeerShim(api)) as client:
        yield _Harness(api, client)


@pytest.fixture(params=["es", "sql"])
def signed_in(request, tmp_path):
    """Sign-in on, the seeded super admin signed in (so the sign-in is fresh)."""
    secrets = _secrets(tmp_path, request.param, auth_enabled=True,
                       auth_jwt_secret="job-request-audit-secret", auth_seed_admin=True)
    api = _app(secrets)
    with TestClient(_PeerShim(api)) as client:
        login = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
        assert login.status_code == 200, login.text
        yield _Harness(api, client)


def _submit(h: _Harness, kind: str, *, key: str = "job-request-0001",
            params: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> Any:
    return h.client.post(
        "/api/jobs",
        json={"kind": kind, "idempotency_key": key, "params": params or KINDS[kind]["params"]},
        headers=headers or {},
    )


def _wait(h: _Harness, job_id: str, timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = h.client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in TERMINAL:
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def _rows(h: _Harness, action: str) -> list[dict[str, Any]]:
    page = h.call(lambda: h.state.control_audit.search_page(
        build_predicate(AuditFilters(event=action)), order="asc", limit=200))
    return [hit.doc for hit in page.hits]


def _jobs(h: _Harness) -> list[dict[str, Any]]:
    return h.client.get("/api/jobs").json()["jobs"]


def _stop_runner(h: _Harness) -> None:
    """Keep submitted jobs queued, so a test sees only what the submit wrote."""
    h.call(h.state.job_runner.stop)


# --------------------------------------------------------------------------- #
# Who asked and from where
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", sorted(KINDS))
def test_the_request_row_records_who_asked_and_from_where(signed_in, kind):
    """The acceptance of A4b-2's export and reset rows (SPEC §7.10): a direct caller
    forges ``X-Forwarded-For``; the requested row records the socket peer, the
    request id it sent, the super admin's role and a session reference. The worker
    row that follows names the same target and none of those fields."""
    spec = KINDS[kind]
    accepted = _submit(signed_in, kind, headers={
        "X-Request-ID": f"{kind}-request-0001", "X-Forwarded-For": FORGED,
    })
    assert accepted.status_code == 202, accepted.text
    assert accepted.headers["x-request-id"] == f"{kind}-request-0001"
    job_id = accepted.json()["job_id"]
    final = _wait(signed_in, job_id)
    assert final["status"] == "succeeded", final

    requested = _rows(signed_in, spec["requested"])
    assert len(requested) == 1
    row = requested[0]
    assert row["actor"] == "Admin" and row["actor_type"] == "human"
    assert row["actor_role"] == "super_admin"
    assert row["outcome"] == "success"
    assert row["action_type"] == spec["action_type"] and row["surface"] == spec["surface"]
    assert row["request_id"] == f"{kind}-request-0001"
    assert SESSION_REF.fullmatch(row["session_ref"]), row["session_ref"]
    # A direct peer's forwarded header is kept as untrusted text, never believed.
    assert row["client"]["ip"] == PEER and row["client"]["ip_source"] == "peer"
    assert row["client"]["peer"] == PEER
    assert row["client"]["forwarded_for"] == FORGED
    assert row["tool_input"]["job_id"] == job_id

    worker = _rows(signed_in, spec["worker"])
    assert len(worker) == 1
    for field in REQUEST_FIELDS:
        assert field not in worker[0], field
    # One job: the request row and the worker row name the same target.
    assert {k: row["target"][k] for k in ("type", "id", "label")} == {
        k: worker[0]["target"][k] for k in ("type", "id", "label")
    }


def test_a_reset_request_names_the_reset_job_by_what_it_resets(signed_in):
    _stop_runner(signed_in)
    labels = {"cases": "Cases reset", "sources": "Sources reset", "factory": "Factory reset"}
    confirms = {"cases": "RESET CASES", "sources": "RESET SOURCES", "factory": "FACTORY RESET"}
    job_ids: dict[str, str] = {}
    for scope in ("cases", "sources", "factory"):
        accepted = _submit(signed_in, "tiered_reset", key=f"reset-label-{scope}",
                           params={"scope": scope, "confirm": confirms[scope]})
        assert accepted.status_code == 202, accepted.text
        job_ids[scope] = accepted.json()["job_id"]
    rows = {row["tool_input"]["scope"]: row for row in _rows(signed_in, "reset.requested")}
    assert sorted(rows) == ["cases", "factory", "sources"]
    for scope, row in rows.items():
        assert row["target"]["type"] == "job"
        assert row["target"]["id"] == job_ids[scope]
        assert row["target"]["label"] == labels[scope]
        assert row["tool_input"] == {"job_id": job_ids[scope], "scope": scope}
        assert row["result_summary"] == f"reset requested scope={scope} job={job_ids[scope]}"


def _target(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row["target"].get(k) for k in ("type", "id", "label")}


def test_a_data_export_request_names_its_job_and_the_exported_scopes(signed_in):
    _stop_runner(signed_in)
    accepted = _submit(signed_in, "data_export_archive", params={"scopes": ["audit", "cases"]})
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    [row] = _rows(signed_in, "export.requested")
    # The job (never the scope list, which every export of those scopes shares),
    # labelled with the scopes in the export's own order.
    assert _target(row) == {
        "type": "export", "id": job_id, "label": "Application data: cases, audit",
    }
    assert row["tool_input"] == {
        "job_id": job_id, "kind": "data_export_archive", "scopes": ["cases", "audit"],
    }


def test_two_exports_of_the_same_scopes_name_two_targets(signed_in):
    _stop_runner(signed_in)
    first = _submit(signed_in, "data_export_archive", key="export-same-0001")
    second = _submit(signed_in, "data_export_archive", key="export-same-0002")
    assert first.status_code == second.status_code == 202
    rows = _rows(signed_in, "export.requested")
    assert sorted(r["target"]["id"] for r in rows) == sorted(
        [first.json()["job_id"], second.json()["job_id"]]
    )
    assert {r["target"]["label"] for r in rows} == {"Application data: configuration"}


def test_an_export_of_all_is_labelled_scope_by_scope(signed_in):
    accepted = _submit(signed_in, "data_export_archive", params={"scopes": ["all"]})
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    assert _wait(signed_in, job_id)["status"] == "succeeded"
    [requested] = _rows(signed_in, "export.requested")
    [created] = _rows(signed_in, "export.created")
    # The request and the worker name the same scopes, never "all" on one row and the
    # list on the other.
    assert _target(requested) == _target(created)
    assert _target(created)["id"] == job_id
    assert _target(created)["label"] == (
        "Application data: cases, audit, usage, configuration, automation, knowledge"
    )


def _job_story(h: _Harness, job_id: str) -> list[dict[str, Any]]:
    page = h.client.get("/api/audit", params={"scope": "people", "target": job_id, "order": "asc"})
    assert page.status_code == 200, page.text
    return page.json()["records"]


def test_the_request_and_worker_rows_read_as_one_job_in_the_audit_log(signed_in):
    accepted = _submit(signed_in, "tiered_reset")
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    assert _wait(signed_in, job_id)["status"] == "succeeded"
    records = _job_story(signed_in, job_id)
    assert [r["action"] for r in records] == ["reset.requested", "reset.started", "reset.completed"]
    assert records[0]["event_label"] == "Reset requested"
    assert {r["category"] for r in records} == {"config"}


@pytest.mark.parametrize("kind", ["data_export_archive", "data_export_segment"])
def test_a_data_export_reads_as_one_job_from_request_to_download(signed_in, kind):
    """Who asked and from where, what the worker made and each download of the file,
    found together by the job id (the inspector's "All events for this target")."""
    accepted = _submit(signed_in, kind, headers={"X-Request-ID": f"{kind}-story-0001"})
    assert accepted.status_code == 202, accepted.text
    job_id = accepted.json()["job_id"]
    assert _wait(signed_in, job_id)["status"] == "succeeded", job_id
    download = signed_in.client.get(f"/api/jobs/{job_id}/artifact")
    assert download.status_code == 200, download.text
    records = _job_story(signed_in, job_id)
    assert [r["action"] for r in records] == [
        "export.requested", "export.created", "job.artifact_downloaded",
    ]
    assert len({(r["target"]["type"], r["target"]["label"]) for r in records}) == 1
    assert records[0]["request_id"] == f"{kind}-story-0001"
    assert records[2]["request_id"] == download.headers["x-request-id"]
    assert records[1].get("request_id") is None  # the worker row has no request


# --------------------------------------------------------------------------- #
# Audit before visible
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_request_that_cannot_be_audited_creates_no_job(h, kind, monkeypatch):
    real = h.state.control_audit.record_strict

    async def failing(**kwargs: Any) -> Any:
        if kwargs.get("action") in REQUESTED_ACTIONS:
            raise RuntimeError("audit store down")
        return await real(**kwargs)

    monkeypatch.setattr(h.state.control_audit, "record_strict", failing)
    refused = _submit(h, kind)
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "audit_unavailable"
    assert _jobs(h) == []
    assert h.call(h.state.jobs.list_for_actor, "") == []


@pytest.mark.parametrize("kind", ["tiered_reset", "data_export_archive"])
def test_a_create_that_fails_after_its_row_gets_a_request_failed_row(h, kind, monkeypatch):
    spec = KINDS[kind]

    async def full(_job: Any) -> Any:
        raise JobCapacityError("job registry is full")

    monkeypatch.setattr(h.state.jobs, "create", full)
    refused = _submit(h, kind, headers={"X-Request-ID": "refused-create-0001"})
    assert refused.status_code == 503
    assert refused.json()["detail"] == "job registry is full"
    failed_action = spec["requested"].replace(".requested", ".request_failed")
    [requested] = _rows(h, spec["requested"])
    [failed] = _rows(h, failed_action)
    assert requested["outcome"] == "success" and failed["outcome"] == "failure"
    assert requested["request_id"] == failed["request_id"] == "refused-create-0001"
    assert "job registry is full" in failed["result_summary"]
    assert failed["target"] == requested["target"]
    assert _jobs(h) == []


def test_a_retry_writes_no_second_row_and_another_request_on_the_key_is_refused(h):
    _stop_runner(h)
    first = _submit(h, "tiered_reset", key="reset-retry-0001")
    assert first.status_code == 202
    real_create = h.state.jobs.create

    async def no_create(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a retry must not create a job")

    h.state.jobs.create = no_create  # type: ignore[method-assign]
    try:
        retry = _submit(h, "tiered_reset", key="reset-retry-0001")
        other = _submit(h, "tiered_reset", key="reset-retry-0001",
                        params={"scope": "sources", "confirm": "RESET SOURCES"})
    finally:
        h.state.jobs.create = real_create  # type: ignore[method-assign]
    assert retry.status_code == 202, retry.text
    assert retry.json()["job_id"] == first.json()["job_id"]
    assert other.status_code == 409
    assert other.json()["detail"] == "idempotency key is already bound to a different job request"
    [row] = _rows(h, "reset.requested")
    assert row["tool_input"]["scope"] == "cases"
    assert _rows(h, "reset.request_failed") == []


def test_a_racing_duplicate_closes_its_requested_row_with_the_job_it_joined(h):
    """A double click: both submits pass the retry check before the first create
    commits. The second answers with the first job, and its requested row, which names
    a job that was never made, is closed by an ``export.request_failed`` row."""
    _stop_runner(h)
    first = _submit(h, "data_export_archive", key="export-dup-0001")
    assert first.status_code == 202
    real_find = h.state.jobs.find_by_idempotency

    async def none(*args: Any, **kwargs: Any) -> None:
        return None

    h.state.jobs.find_by_idempotency = none  # type: ignore[method-assign]
    try:
        second = _submit(h, "data_export_archive", key="export-dup-0001",
                         headers={"X-Request-ID": "export-dup-second"})
    finally:
        h.state.jobs.find_by_idempotency = real_find  # type: ignore[method-assign]
    assert second.status_code == 202, second.text
    job_id = first.json()["job_id"]
    assert second.json()["job_id"] == job_id
    assert [job["job_id"] for job in _jobs(h)] == [job_id]
    requested = _rows(h, "export.requested")
    [failed] = _rows(h, "export.request_failed")
    assert len(requested) == 2
    phantom = next(r for r in requested if r["tool_input"]["job_id"] != job_id)
    assert phantom["request_id"] == failed["request_id"] == "export-dup-second"
    assert failed["result_summary"].startswith("job_already_accepted: ")
    assert f"already accepted as job {job_id}" in failed["result_summary"]


def _degrade(h: _Harness) -> None:
    """A failed factory reset's safe stop: admission closed and degraded, so only a
    fresh factory reset retry may be submitted."""
    gate = h.state.mutation_gate
    h.call(gate.close, "failed-factory-reset")
    h.call(gate.mark_degraded, "failed-factory-reset")


def _reopen(h: _Harness) -> None:
    h.call(h.state.mutation_gate.open, "failed-factory-reset")


def _audit_export_params() -> dict[str, Any]:
    return {"format": "csv", "scope": "all", "from": "2026-10-18T15:10:00Z",
            "to": "2026-10-25T15:10:00Z", "order": "asc", "filters": {}}


@pytest.mark.parametrize(("kind", "params"), [
    ("tiered_reset", {"scope": "cases", "confirm": "RESET CASES"}),
    ("tiered_reset", {"scope": "sources", "confirm": "RESET SOURCES"}),
    ("data_export_archive", {"scopes": ["configuration"]}),
    ("data_export_segment", {"scopes": ["configuration"], "page_size": 1000}),
    ("audit_export", _audit_export_params()),
])
def test_factory_recovery_refuses_other_requests_before_any_row(h, kind, params, monkeypatch):
    """While a failed factory reset holds the recovery fence, a request that the job
    store would refuse anyway is refused before its requested row: no
    ``*.requested`` row claiming success and no ``*.request_failed`` row."""
    _stop_runner(h)

    async def no_create(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a refused request must not reach the create")

    _degrade(h)
    try:
        monkeypatch.setattr(h.state.jobs, "create", no_create)
        refused = _submit(h, kind, key=f"recovery-{kind}-{len(params)}", params=params)
    finally:
        _reopen(h)
    assert refused.status_code == 503, refused.text
    assert refused.json()["detail"] == FACTORY_RECOVERY_REFUSAL
    for action in (*REQUESTED_ACTIONS, "audit.export_requested"):
        assert _rows(h, action) == []
        assert _rows(h, action.replace(".requested", ".request_failed")
                     .replace("export_requested", "export_request_failed")) == []


def test_a_factory_retry_during_recovery_is_still_requested_and_audited(h, monkeypatch):
    _stop_runner(h)

    async def held(*args: Any, **kwargs: Any) -> None:
        return None

    # The retry would start the recovery worker; keep the job queued for the test.
    monkeypatch.setattr(h.state.job_runner, "start", held)
    _degrade(h)
    try:
        accepted = _submit(h, "tiered_reset", key="recovery-factory-0001",
                           params={"scope": "factory", "confirm": "FACTORY RESET"})
    finally:
        _reopen(h)
    assert accepted.status_code == 202, accepted.text
    [row] = _rows(h, "reset.requested")
    assert row["tool_input"] == {"job_id": accepted.json()["job_id"], "scope": "factory"}
    assert _rows(h, "reset.request_failed") == []


def test_a_retry_of_an_accepted_request_is_answered_during_recovery(h):
    """The store answers an idempotent retry before its fence; the route keeps that
    order, so a retry of an accepted job gets the job even while recovering."""
    _stop_runner(h)
    first = _submit(h, "data_export_archive", key="recovery-retry-0001")
    assert first.status_code == 202
    _degrade(h)
    try:
        retry = _submit(h, "data_export_archive", key="recovery-retry-0001")
    finally:
        _reopen(h)
    assert retry.status_code == 202, retry.text
    assert retry.json()["job_id"] == first.json()["job_id"]
    assert len(_rows(h, "export.requested")) == 1


def test_jobs_are_refused_in_demo_mode_before_any_request_row(h):
    demo_calls: list[dict[str, Any]] = []

    async def demo_record(**kwargs: Any) -> None:
        demo_calls.append(kwargs)

    demo_audit = SimpleNamespace(record_strict=demo_record, record=demo_record)
    h.state._demo = SimpleNamespace(audit=demo_audit, run_id="demo-request")  # noqa: SLF001
    try:
        refused = [_submit(h, kind, key=f"demo-{kind}") for kind in sorted(KINDS)]
    finally:
        h.state._demo = None  # noqa: SLF001
    assert [r.status_code for r in refused] == [409, 409, 409]
    assert demo_calls == []
    for action in REQUESTED_ACTIONS:
        assert _rows(h, action) == []


def test_other_job_kinds_write_no_request_row(h):
    _stop_runner(h)
    accepted = h.client.post("/api/jobs", json={
        "kind": "case_tag", "idempotency_key": "tag-request-0001",
        "params": {"case_ids": ["case-1"], "tag": "triaged"},
    })
    assert accepted.status_code == 202, accepted.text
    for action in REQUESTED_ACTIONS:
        assert _rows(h, action) == []
