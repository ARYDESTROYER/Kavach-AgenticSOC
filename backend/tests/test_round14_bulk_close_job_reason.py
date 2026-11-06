"""A bulk close submitted as a ``case_lifecycle`` job carries ONE shared reason for
cases whose active runbook still has required steps open (Round 14 SPEC §4.10.15, D34).

``POST /api/jobs`` accepts ``open_steps_reason`` (at most 500 characters) on the job's
params. The runner forwards it to every item, and each ``case.closed_with_open_steps``
row records it with ``via: "bulk"``. The reason is optional: a bulk close never fails
an item for open steps, so the job contract has no ``require_open_steps_reason`` flag
and refuses one. The reason is cleaned at submit like the single-case action (runs of
whitespace collapse, blank is absent), so a retry of the same intent with different
spacing binds the same request fingerprint instead of conflicting.

Offline: fake Elasticsearch, the mock LLM, no lookups. ``decide()`` is never reached
(#3): the analyst layer closes the cases.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes as routes_mod
from app.api import routes_case_runbooks as case_routes
from app.api.routes_jobs import CaseLifecycleParams
from app.api.routes_jobs import router as jobs_router
from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine import case_manager
from app.engine import runbook_runs as R
from app.es.fake import InMemoryESClient
from app.models import OPEN_STEPS_REASON_MAX_CHARS, Case, Entity, LookupResult
from app.state import AppState

GENERIC = "generic-incident"
TERMINAL = {"succeeded", "failed", "cancelled", "partial"}


@pytest.fixture(autouse=True)
def _no_lookups(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):  # noqa: ANN001, ANN202
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by)

    monkeypatch.setattr(R, "execute_lookup", fake_execute)


@pytest.fixture(autouse=True)
def _decide_is_never_called(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("a bulk close is an analyst move and never calls decide() (#3)")

    monkeypatch.setattr(case_manager, "decide", forbidden)


def _case(case_id: str) -> Case:
    return Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=["nothing_matches_this"], entity=Entity(type=EntityType.IP, value="198.51.100.4"),
        status=CaseStatus.NEEDS_HUMAN, case_number=f"CASE-{case_id[-3:]}",
    )


@pytest.fixture
def client(secrets, mock_provider):
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(routes_mod.router)
    api.include_router(case_routes.router)
    api.include_router(jobs_router)
    with TestClient(api) as c:
        yield c


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _seed_with_run(client: TestClient, case_id: str) -> None:
    client.portal.call(_state(client).cases.save, _case(case_id))
    res = client.post(f"/api/cases/{case_id}/runbooks", json={"runbook_id": GENERIC})
    assert res.status_code in (200, 201), res.text


def _open_steps_rows(client: TestClient, case_id: str) -> list[dict[str, Any]]:
    rows = client.portal.call(_state(client).audit.records_for_case, case_id)
    return [r for r in rows if isinstance(r, dict) and r.get("action") == "case.closed_with_open_steps"]


def _submit(client: TestClient, params: dict[str, Any], *, key: str = "bulk-close-0001") -> Any:
    return client.post("/api/jobs", json={"kind": "case_lifecycle", "idempotency_key": key, "params": params})


def _wait(client: TestClient, job_id: str, timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in TERMINAL:
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def test_a_bulk_close_job_records_the_shared_reason_on_every_case(client: TestClient) -> None:
    for cid in ("case-r01", "case-r02"):
        _seed_with_run(client, cid)

    res = _submit(client, {"case_ids": ["case-r01", "case-r02"], "action": "close",
                           "open_steps_reason": "  Shift   clean-up "})
    assert res.status_code == 202, res.text
    done = _wait(client, res.json()["job_id"])
    assert done["status"] == "succeeded", done

    state = _state(client)
    for cid in ("case-r01", "case-r02"):
        assert client.portal.call(state.cases.get, cid).status == CaseStatus.CLOSED
        rows = _open_steps_rows(client, cid)
        assert len(rows) == 1, rows
        info = rows[0]["tool_input"]
        assert info["via"] == "bulk"
        assert info["reason"] == "Shift clean-up"


def test_a_bulk_close_job_without_a_reason_still_closes_and_records_null(client: TestClient) -> None:
    _seed_with_run(client, "case-n01")
    res = _submit(client, {"case_ids": ["case-n01"], "action": "close", "open_steps_reason": "   "})
    assert res.status_code == 202, res.text
    assert _wait(client, res.json()["job_id"])["status"] == "succeeded"
    assert client.portal.call(_state(client).cases.get, "case-n01").status == CaseStatus.CLOSED
    info = _open_steps_rows(client, "case-n01")[0]["tool_input"]
    assert info["via"] == "bulk" and info["reason"] is None


def test_a_reason_over_500_characters_is_refused_before_a_job_exists(client: TestClient) -> None:
    _seed_with_run(client, "case-l01")
    res = _submit(client, {"case_ids": ["case-l01"], "action": "close",
                           "open_steps_reason": "x" * (OPEN_STEPS_REASON_MAX_CHARS + 1)})
    assert res.status_code == 422, res.text
    assert "open_steps_reason" in res.text
    assert client.get("/api/jobs").json()["jobs"] == []
    assert client.portal.call(_state(client).cases.get, "case-l01").status == CaseStatus.NEEDS_HUMAN
    exactly = _submit(client, {"case_ids": ["case-l01"], "action": "close",
                               "open_steps_reason": "x" * OPEN_STEPS_REASON_MAX_CHARS}, key="bulk-close-0002")
    assert exactly.status_code == 202, exactly.text


def test_the_job_contract_has_no_require_flag(client: TestClient) -> None:
    """Items of a bulk close never fail for open steps, so the Console's single-case
    ``require_open_steps_reason`` flag is not part of the job params (extra fields are
    refused)."""
    res = _submit(client, {"case_ids": ["case-x01"], "action": "close", "open_steps_reason": "Shift clean-up",
                           "require_open_steps_reason": True})
    assert res.status_code == 422, res.text
    assert client.get("/api/jobs").json()["jobs"] == []


def test_a_retry_with_different_spacing_is_the_same_job(client: TestClient) -> None:
    """The cleaned reason is what the request fingerprint binds."""
    state = _state(client)
    # Keep the job queued, so each submit sees only the request it binds.
    client.portal.call(state.job_runner.stop)
    state.job_runner.notify = lambda: None
    first = _submit(client, {"case_ids": ["case-s01"], "action": "close", "open_steps_reason": "Shift  clean-up"})
    again = _submit(client, {"case_ids": ["case-s01"], "action": "close", "open_steps_reason": " Shift clean-up "})
    assert first.status_code == 202, first.text
    assert again.status_code == 202, again.text
    assert again.json()["job_id"] == first.json()["job_id"]
    different = _submit(client, {"case_ids": ["case-s01"], "action": "close", "open_steps_reason": "Other reason"})
    assert different.status_code == 409, different.text


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        (None, None),
        ("", None),
        ("   \n\t ", None),
        ("Shift clean-up", "Shift clean-up"),
        ("  Shift\n\nclean-up  ", "Shift clean-up"),
    ],
)
def test_the_params_model_cleans_the_reason_like_the_case_action(raw: str | None, cleaned: str | None) -> None:
    params = CaseLifecycleParams.model_validate({"case_ids": ["c-1"], "action": "close", "open_steps_reason": raw})
    assert params.open_steps_reason == cleaned
    dumped = params.model_dump(mode="json", exclude_none=True)
    assert ("open_steps_reason" in dumped) is (cleaned is not None)
    # The runner builds ``CaseAction`` from the stored params; the value survives as is.
    action = routes_mod.CaseAction.model_validate({k: v for k, v in dumped.items() if k != "case_ids"})
    assert action.open_steps_reason == cleaned


def test_the_params_bound_matches_the_case_action_bound() -> None:
    lifecycle = CaseLifecycleParams.model_fields["open_steps_reason"].metadata
    single = routes_mod.CaseAction.model_fields["open_steps_reason"].metadata
    assert [getattr(m, "max_length", None) for m in lifecycle] == [OPEN_STEPS_REASON_MAX_CHARS]
    assert [getattr(m, "max_length", None) for m in single] == [OPEN_STEPS_REASON_MAX_CHARS]
