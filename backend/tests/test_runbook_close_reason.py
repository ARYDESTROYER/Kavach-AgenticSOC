"""Closing with required runbook steps open (Round 14 SPEC §4.10.15, D34) and the
re-evaluation hooks on the human case paths (§4.10.4).

Closing by hand never blocks: an old-shape close returns 200 exactly as before and
writes ``case.closed_with_open_steps`` with ``reason: null``; only
``require_open_steps_reason: true`` (the Console's flag) without a reason answers
``409 runbook_steps_open``. Every human terminal transition records how it was made
(``via``). Automatic closes never read runbook state, and ``decide()`` /
``AutoClosePolicy`` are untouched (#3). Reopening, escalating and changing tags
re-evaluate attachment on the single, bulk and job paths.
"""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes as routes_mod
from app.api import routes_case_runbooks as case_routes
from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine import case_manager
from app.engine import runbook_runs as R
from app.engine.jobs import JobRunner
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, LookupResult
from app.state import AppState

from tests.conftest import mount_moved_routers

GENERIC = "generic-incident"
BRUTE = "brute-force-password-spray"


@pytest.fixture(autouse=True)
def _no_lookups(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by)

    monkeypatch.setattr(R, "execute_lookup", fake_execute)


def _case(case_id: str, *, rule: str = "nothing_matches_this", status: CaseStatus = CaseStatus.NEEDS_HUMAN) -> Case:
    return Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=[rule], entity=Entity(type=EntityType.IP, value="198.51.100.4"), status=status,
        case_number=f"CASE-{case_id[-3:]}",
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
    mount_moved_routers(api)
    with TestClient(api) as c:
        yield c


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _seed_with_run(client: TestClient, case_id: str, runbook_id: str = GENERIC) -> AppState:
    state = _state(client)
    client.portal.call(state.cases.save, _case(case_id))
    r = client.post(f"/api/cases/{case_id}/runbooks", json={"runbook_id": runbook_id})
    assert r.status_code in (200, 201), r.text
    return state


def _rows(client: TestClient, case_id: str, action: str = "case.closed_with_open_steps") -> list[dict[str, Any]]:
    rows = client.portal.call(_state(client).audit.records_for_case, case_id)
    return [r for r in rows if isinstance(r, dict) and r.get("action") == action]


# --------------------------------------------------------------------------- #
# The close reason
# --------------------------------------------------------------------------- #
def test_old_shape_close_still_200_and_records_a_null_reason(client: TestClient) -> None:
    _seed_with_run(client, "case-c01")
    r = client.post("/api/cases/case-c01/action", json={"action": "close"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "closed"
    rows = _rows(client, "case-c01")
    assert len(rows) == 1
    info = rows[0]["tool_input"]
    assert info["via"] == "api" and info["reason"] is None
    assert info["required_open"] == len(info["steps"]) > 0
    assert {"run_id", "step_id", "title", "status"} <= set(info["steps"][0])
    assert rows[0]["actor_type"] == "human"


def test_open_steps_row_is_a_runbook_event_with_the_request_context(client: TestClient) -> None:
    _seed_with_run(client, "case-ctx")
    r = client.post("/api/cases/case-ctx/action", json={"action": "close"},
                    headers={"X-Request-ID": "req-close-0001"})
    assert r.status_code == 200, r.text
    row = _rows(client, "case-ctx")[0]
    assert row["action_type"] == "runbook"
    assert row["target"]["type"] == "case" and row["target"]["id"] == "case-ctx"
    # The request's own context, as on every other row the request wrote.
    assert row.get("client")
    status_rows = [r for r in client.portal.call(_state(client).audit.records_for_case, "case-ctx")
                   if isinstance(r, dict) and r.get("action_type") == "status"]
    assert status_rows


def test_bulk_close_rows_carry_the_request_context(client: TestClient) -> None:
    _seed_with_run(client, "case-bctx")
    r = client.post("/api/cases/bulk", json={"action": "close", "ids": ["case-bctx"]})
    assert r.status_code == 200 and r.json()["results"][0]["ok"]
    row = _rows(client, "case-bctx")[0]
    assert row["action_type"] == "runbook" and row["tool_input"]["via"] == "bulk"
    assert row.get("client")


def test_console_flag_without_reason_is_409_and_changes_nothing(client: TestClient) -> None:
    state = _seed_with_run(client, "case-c02")
    r = client.post("/api/cases/case-c02/action", json={"action": "close", "require_open_steps_reason": True})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "runbook_steps_open"
    assert detail["required_open"] == len(detail["steps"]) > 0
    assert client.portal.call(state.cases.get, "case-c02").status == CaseStatus.NEEDS_HUMAN
    assert _rows(client, "case-c02") == []
    blank = client.post("/api/cases/case-c02/action", json={
        "action": "close", "require_open_steps_reason": True, "open_steps_reason": "   "})
    assert blank.status_code == 409


def test_console_close_with_reason_records_it(client: TestClient) -> None:
    _seed_with_run(client, "case-c03")
    r = client.post("/api/cases/case-c03/action", json={
        "action": "close", "require_open_steps_reason": True, "open_steps_reason": "  Handled by the vendor.  "})
    assert r.status_code == 200, r.text
    info = _rows(client, "case-c03")[0]["tool_input"]
    assert info["via"] == "console" and info["reason"] == "Handled by the vendor."


def test_reason_longer_than_500_characters_is_422(client: TestClient) -> None:
    _seed_with_run(client, "case-c04")
    r = client.post("/api/cases/case-c04/action", json={"action": "close", "open_steps_reason": "x" * 501})
    assert r.status_code == 422


@pytest.mark.parametrize("body", [
    {"action": "resolve"},
    {"action": "confirm_fp"},
    {"action": "set_status", "status": "resolved"},
])
def test_every_human_terminal_transition_writes_its_row(client: TestClient, body: dict[str, Any]) -> None:
    case_id = f"case-t-{body['action']}"
    _seed_with_run(client, case_id)
    r = client.post(f"/api/cases/{case_id}/action", json=body)
    assert r.status_code == 200, r.text
    rows = _rows(client, case_id)
    assert len(rows) == 1 and rows[0]["tool_input"]["via"] == "api"


def test_resolve_then_close_writes_one_row(client: TestClient) -> None:
    _seed_with_run(client, "case-c05")
    assert client.post("/api/cases/case-c05/action", json={"action": "resolve"}).status_code == 200
    assert client.post("/api/cases/case-c05/action", json={"action": "close"}).status_code == 200
    assert len(_rows(client, "case-c05")) == 1


def test_mark_duplicate_never_prompts_and_notes_duplicate(client: TestClient) -> None:
    _seed_with_run(client, "case-c06")
    r = client.post("/api/cases/case-c06/action", json={
        "action": "close", "disposition": "duplicate", "disposition_declared": True,
        "require_open_steps_reason": True})
    assert r.status_code == 200, r.text
    row = _rows(client, "case-c06")[0]
    assert row["tool_input"]["via"] == "console" and row["tool_input"]["reason"] is None
    assert row["tool_input"]["note"] == "Duplicate"
    assert "(Duplicate)" in row["result_summary"]


def test_a_reason_given_with_a_duplicate_is_recorded(client: TestClient) -> None:
    _seed_with_run(client, "case-c07")
    r = client.post("/api/cases/case-c07/action", json={
        "action": "close", "disposition": "duplicate", "disposition_declared": True,
        "require_open_steps_reason": True, "open_steps_reason": "Merged into CASE-7"})
    assert r.status_code == 200, r.text
    info = _rows(client, "case-c07")[0]["tool_input"]
    assert info["via"] == "console" and info["reason"] == "Merged into CASE-7" and info["note"] == "Duplicate"


def test_a_standing_duplicate_disposition_never_drops_the_typed_reason(client: TestClient) -> None:
    """The prompt and the row decide "duplicate" from the same request: a case that
    already carries DUPLICATE but is closed without it gets the dialog, and the reason
    typed there is the row's reason."""
    state = _seed_with_run(client, "case-c08")
    assert client.post("/api/cases/case-c08/action", json={
        "action": "set_disposition", "disposition": "duplicate"}).status_code == 200
    prompt = client.post("/api/cases/case-c08/action", json={"action": "close", "require_open_steps_reason": True})
    assert prompt.status_code == 409 and prompt.json()["detail"]["code"] == "runbook_steps_open"
    r = client.post("/api/cases/case-c08/action", json={
        "action": "close", "require_open_steps_reason": True, "open_steps_reason": "Merged into CASE-7 by hand"})
    assert r.status_code == 200, r.text
    assert client.portal.call(state.cases.get, "case-c08").disposition.value == "duplicate"
    info = _rows(client, "case-c08")[0]["tool_input"]
    assert info["via"] == "console" and info["reason"] == "Merged into CASE-7 by hand"
    assert info["note"] is None


@pytest.mark.parametrize("body", [
    {"action": "close", "disposition": "not_a_disposition", "require_open_steps_reason": True},
    {"action": "resolve", "disposition": "not_a_disposition", "require_open_steps_reason": True},
])
def test_an_invalid_request_is_400_before_the_open_steps_check(client: TestClient, body: dict[str, Any]) -> None:
    state = _seed_with_run(client, "case-c09")
    r = client.post("/api/cases/case-c09/action", json=body)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "unknown disposition: not_a_disposition"
    assert client.portal.call(state.cases.get, "case-c09").status == CaseStatus.NEEDS_HUMAN
    assert _rows(client, "case-c09") == []


def test_bulk_close_never_fails_an_item_for_open_steps(client: TestClient) -> None:
    _seed_with_run(client, "case-b01")
    _seed_with_run(client, "case-b02")
    r = client.post("/api/cases/bulk", json={
        "action": "close", "ids": ["case-b01", "case-b02"], "require_open_steps_reason": True,
        "open_steps_reason": "Shift clean-up"})
    assert r.status_code == 200
    assert all(item["ok"] for item in r.json()["results"])
    for cid in ("case-b01", "case-b02"):
        info = _rows(client, cid)[0]["tool_input"]
        assert info["via"] == "bulk" and info["reason"] == "Shift clean-up"


def test_case_lifecycle_job_closes_with_via_bulk(client: TestClient) -> None:
    state = _seed_with_run(client, "case-j01")
    runner = SimpleNamespace(state=state)

    async def item_loop(job, token, run, result_kind):
        for cid in job.params["case_ids"]:
            await run(cid)

    runner._item_loop = item_loop
    job = SimpleNamespace(job_id="job-1", actor="asha", params={"case_ids": ["case-j01"], "action": "close"})
    client.portal.call(JobRunner._case_lifecycle, runner, job, "token")
    assert client.portal.call(state.cases.get, "case-j01").status == CaseStatus.CLOSED
    assert _rows(client, "case-j01")[0]["tool_input"]["via"] == "bulk"


def test_no_row_without_open_required_steps(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-n01"))
    assert client.post("/api/cases/case-n01/action", json={
        "action": "close", "require_open_steps_reason": True}).status_code == 200
    assert _rows(client, "case-n01") == []
    # An abandoned run is no longer worked: it never asks for a reason.
    run = _seed_with_run(client, "case-n02")
    run_id = client.get("/api/cases/case-n02/runbooks").json()["runs"][0]["run_id"]
    client.post(f"/api/cases/case-n02/runbooks/{run_id}/abandon", json={"reason": "Not needed"})
    assert client.post("/api/cases/case-n02/action", json={
        "action": "close", "require_open_steps_reason": True}).status_code == 200
    assert _rows(client, "case-n02") == []
    assert run is state


def test_unreadable_runs_never_block_a_close(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    state = _seed_with_run(client, "case-u01")
    store = state.runbook_runs

    async def broken(_case_id: str):
        raise RuntimeError("store down")

    monkeypatch.setattr(store, "get", broken)
    r = client.post("/api/cases/case-u01/action", json={"action": "close", "require_open_steps_reason": True})
    assert r.status_code == 200
    assert _rows(client, "case-u01") == []


@pytest.mark.asyncio
async def test_proposal_close_records_via_proposal(app_state: AppState) -> None:
    case = _case("case-p01")
    await app_state.cases.save(case)
    result = await R.attach_by_person(app_state, case, GENERIC, note=None, actor="asha", context=None)
    steps = R.required_open_in([result.run])
    await R.record_closed_with_open_steps(app_state, case, actor="ben", via="proposal", reason=None, steps=steps)
    rows = [r for r in await app_state.audit.records_for_case("case-p01")
            if r.get("action") == "case.closed_with_open_steps"]
    assert rows[0]["tool_input"]["via"] == "proposal" and rows[0]["tool_input"]["reason"] is None


# --------------------------------------------------------------------------- #
# Automatic closes never read runbook state (#3)
# --------------------------------------------------------------------------- #
def test_decide_and_the_case_manager_never_read_runbooks() -> None:
    source = inspect.getsource(case_manager)
    assert "runbook" not in source.casefold()
    signature = inspect.signature(case_manager.decide)
    assert list(signature.parameters)[:4] == ["verdict", "confidence", "risk_score", "policy"]


@pytest.mark.asyncio
async def test_an_automatic_close_writes_no_open_steps_row(app_state: AppState) -> None:
    case = _case("case-auto")
    await app_state.cases.save(case)
    await R.attach_by_person(app_state, case, GENERIC, note=None, actor="asha", context=None)
    # The deterministic case manager closes by policy; the analyst path never ran.
    case.status = CaseStatus.CLOSED
    await app_state.cases.save(case)
    rows = await app_state.audit.records_for_case("case-auto")
    assert not any(r.get("action") == "case.closed_with_open_steps" for r in rows)


# --------------------------------------------------------------------------- #
# Re-evaluation hooks on the human paths (§4.10.4)
# --------------------------------------------------------------------------- #
def _runbooks(client: TestClient, case_id: str) -> list[str]:
    return [r["runbook_id"] for r in client.get(f"/api/cases/{case_id}/runbooks").json()["runs"]]


def test_reopen_after_close_attaches(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h01", rule="mail_auth", status=CaseStatus.CLOSED))
    assert _runbooks(client, "case-h01") == []
    assert client.post("/api/cases/case-h01/action", json={"action": "reopen"}).status_code == 200
    assert _runbooks(client, "case-h01") == [BRUTE]


def test_escalate_attaches(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h02", rule="mail_auth", status=CaseStatus.NEW))
    assert client.post("/api/cases/case-h02/action", json={"action": "escalate"}).status_code == 200
    assert _runbooks(client, "case-h02") == [BRUTE]


def test_bulk_reopen_attaches(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h03", rule="mail_auth", status=CaseStatus.CLOSED))
    r = client.post("/api/cases/bulk", json={"action": "reopen", "ids": ["case-h03"]})
    assert r.status_code == 200 and r.json()["results"][0]["ok"]
    assert _runbooks(client, "case-h03") == [BRUTE]


def test_job_reopen_attaches(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h04", rule="mail_auth", status=CaseStatus.CLOSED))
    runner = SimpleNamespace(state=state)

    async def item_loop(job, token, run, result_kind):
        for cid in job.params["case_ids"]:
            await run(cid)

    runner._item_loop = item_loop
    job = SimpleNamespace(job_id="job-2", actor="asha", params={"case_ids": ["case-h04"], "action": "reopen"})
    client.portal.call(JobRunner._case_lifecycle, runner, job, "token")
    assert _runbooks(client, "case-h04") == [BRUTE]


def test_tag_change_attaches(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h05", rule="mail_auth", status=CaseStatus.NEW))
    # A candidate gets no run; once a person moves it, a tag change re-evaluates.
    client.portal.call(state.cases.save, _case("case-h05", rule="mail_auth"))
    assert _runbooks(client, "case-h05") == []
    assert client.post("/api/cases/case-h05/tags", json={"tags": ["phish"]}).status_code == 200
    assert _runbooks(client, "case-h05") == [BRUTE]
    # The same tags again change nothing and attach nothing new.
    assert client.post("/api/cases/case-h05/tags", json={"tags": ["phish"]}).status_code == 200
    assert _runbooks(client, "case-h05") == [BRUTE]


def test_tags_sent_with_an_action_attach(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h07", rule="mail_auth", status=CaseStatus.INVESTIGATING))
    # Same status (acknowledge on an investigating case) but new tags: re-evaluated.
    r = client.post("/api/cases/case-h07/action", json={"action": "acknowledge", "tags": ["spray"]})
    assert r.status_code == 200, r.text
    assert _runbooks(client, "case-h07") == [BRUTE]


def test_case_tag_job_attaches(client: TestClient) -> None:
    state = _state(client)
    client.portal.call(state.cases.save, _case("case-h06", rule="mail_auth"))
    runner = SimpleNamespace(state=state)

    async def item_loop(job, token, run, result_kind):
        for cid in job.params["case_ids"]:
            await run(cid)

    runner._item_loop = item_loop
    job = SimpleNamespace(job_id="job-3", actor="asha", params={"case_ids": ["case-h06"], "tag": "spray"})
    client.portal.call(JobRunner._case_tag, runner, job, "token")
    assert _runbooks(client, "case-h06") == [BRUTE]
