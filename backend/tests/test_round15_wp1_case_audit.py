"""Round 15 WP1: structured audit rows for human case work, attribution, the bulk
marker, ``actions_taken`` and ``review_via`` (SPEC D4.2, D6.9, D7.1 to D7.3).

Offline: fake Elasticsearch, mock model. Sign-in on (seeded ``Admin``) where the rule
is about the verified principal, off (the conftest ``client`` and ``app_state``)
where it is about the body or caller value.

* every lifecycle, collaboration and grading row carries its structured ``action``,
  the case as ``target`` (labelled by its number) and the request context, while
  ``action_type``, ``surface`` and the positional ``result_summary`` stay as before;
* comment, tags and assign rows name the verified principal, never the name a body
  claims (the job path keeps its caller value); the reinvestigation row names the
  principal in its summary and stays the agent's own row;
* a bulk action's rows carry ``run_id`` = its ``batch_id`` (``bulk-<id>``) on every
  path (``POST /api/cases/bulk`` and the ``case_lifecycle``, ``case_assign`` and
  ``case_tag`` jobs), a single action's rows carry none, and no client can set it;
* ``actions_taken`` is a fixed vocabulary of at most 8 values, stored on the history
  entry, in the row's ``changes`` and in the Markdown export;
* ``review_via`` accepts only ``"auto_close_review"``, is recorded on the history
  entry and in ``changes`` only, never reaches the internal ``via`` of
  ``_perform_case_action`` or the open-steps check, and no bulk body accepts it.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import routes as routes_mod
from app.api.deps import require_auth
from app.api.routes import (
    AssignBody,
    BulkCaseAction,
    CaseAction,
    TagsBody,
    _bulk_audit_run,
    _perform_case_action,
    case_assign,
    case_tags,
    router as monolith_router,
)
from app.api.routes_jobs import CaseLifecycleParams
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import Case, Entity, RunbookStepsOpen
from app.state import AppState
from tests.conftest import mount_moved_routers

_JWT_SECRET = "round15-wp1-case-audit-secret"
_REQUEST_ID = "req-r15-wp1-0001"


def _case(cid: str, *, status: CaseStatus = CaseStatus.OPEN, number: str = "",
          verdict: Verdict | None = Verdict.TRUE_POSITIVE) -> Case:
    return Case(
        case_id=cid, case_number=number, cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.7"), verdict=verdict, confidence=0.9,
        risk_score=40.0, status=status,
        created_at="2026-11-20T00:00:00+00:00", updated_at="2026-11-20T01:00:00+00:00",
    )


# --------------------------------------------------------------------------- #
# Sign-in on harness
# --------------------------------------------------------------------------- #
def _auth_client() -> tuple[TestClient, FastAPI]:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret=_JWT_SECRET, auth_seed_admin=True,
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
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    api.add_middleware(RequestIdMiddleware)
    return TestClient(api), api


@pytest.fixture
def auth():
    client, api = _auth_client()
    with client:
        response = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
        assert response.status_code == 200, response.text
        headers = {"Authorization": f"Bearer {response.json()['token']}", "X-Request-ID": _REQUEST_ID}
        yield client, api.state.tlsoc, headers


def _save(client: TestClient, state: AppState, case: Case) -> None:
    client.portal.call(state.cases.save, case)


def _rows(client: TestClient, state: AppState, case_id: str) -> list[dict[str, Any]]:
    return client.portal.call(lambda: state.audit.records_for_case(case_id))


def _human_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in rows if r.get("actor_type") == "human"]


def _target(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in (row.get("target") or {}).items() if v is not None}


def _changes(row: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["field"]: c for c in row.get("changes") or []}


# --------------------------------------------------------------------------- #
# D7.1: lifecycle rows
# --------------------------------------------------------------------------- #
def test_a_lifecycle_row_carries_action_target_and_request_context(auth) -> None:
    client, state, headers = auth
    _save(client, state, _case("case-r15-ack", number="CASE-0042"))
    response = client.post("/api/cases/case-r15-ack/action", json={"action": "acknowledge"}, headers=headers)
    assert response.status_code == 200, response.text
    (row,) = [r for r in _rows(client, state, "case-r15-ack") if r.get("action_type") == "status"]
    assert row["action"] == "case.acknowledged"
    assert _target(row) == {"type": "case", "id": "case-r15-ack", "label": "CASE-0042"}
    assert row["request_id"] == _REQUEST_ID
    assert row["actor"] == "Admin" and row["actor_role"] == "super_admin"
    assert row.get("session_ref")
    assert (row["outcome"], row["actor_type"]) == ("success", "human")
    # The positional summary is byte-identical to the pre-Round-15 row.
    assert row["result_summary"] == "action=acknowledge status open→investigating disposition=none"
    changes = _changes(row)
    assert changes["status"]["before"] == "open" and changes["status"]["after"] == "investigating"
    assert changes["acknowledged_at"]["before"] is None and changes["acknowledged_at"]["after"]
    assert "run_id" not in row


def test_a_declared_close_records_disposition_and_actions_taken(auth) -> None:
    client, state, headers = auth
    _save(client, state, _case("case-r15-close"))
    body = {"action": "close", "disposition": "false_positive", "disposition_declared": True,
            "note": "scanner", "actions_taken": ["tuned_detection", "notified_owner", "tuned_detection"]}
    response = client.post("/api/cases/case-r15-close/action", json=body, headers=headers)
    assert response.status_code == 200, response.text
    case = client.portal.call(state.cases.get, "case-r15-close")
    entry = [h for h in case.history if h.get("event") == "analyst_action"][-1]
    assert entry["actions_taken"] == ["tuned_detection", "notified_owner"]  # kept once, in order
    assert "review_via" not in entry
    (row,) = [r for r in _rows(client, state, "case-r15-close") if r.get("action_type") == "status"]
    assert row["action"] == "case.closed"
    assert row["result_summary"] == (
        "action=close status open→closed disposition=false_positive reason=scanner classified=false_positive"
    )
    changes = _changes(row)
    assert changes["disposition"]["before"] is None and changes["disposition"]["after"] == "false_positive"
    assert changes["classified_disposition"]["after"] == "false_positive"
    assert json.loads(changes["actions_taken"]["after"]) == ["tuned_detection", "notified_owner"]
    assert "review_via" not in changes


@pytest.mark.parametrize("verb, start, extra, action", [
    ("acknowledge", CaseStatus.OPEN, {}, "case.acknowledged"),
    ("close", CaseStatus.OPEN, {}, "case.closed"),
    ("confirm_fp", CaseStatus.OPEN, {}, "case.fp_confirmed"),
    ("resolve", CaseStatus.OPEN, {}, "case.resolved"),
    ("reopen", CaseStatus.CLOSED, {}, "case.reopened"),
    ("escalate", CaseStatus.OPEN, {}, "case.escalated"),
    ("deescalate", CaseStatus.ESCALATED, {}, "case.deescalated"),
    ("hold", CaseStatus.OPEN, {}, "case.held"),
    ("resume", CaseStatus.ON_HOLD, {}, "case.resumed"),
    ("set_disposition", CaseStatus.OPEN, {"disposition": "benign"}, "case.disposition_set"),
    ("set_status", CaseStatus.OPEN, {"status": "investigating"}, "case.status_set"),
])
async def test_every_lifecycle_verb_writes_its_structured_action(
    app_state: AppState, verb: str, start: CaseStatus, extra: dict[str, Any], action: str,
) -> None:
    cid = f"case-r15-verb-{verb}"
    await app_state.cases.save(_case(cid, status=start))
    await _perform_case_action(cid, CaseAction(action=verb, **extra), "ann", app_state)
    rows = [r for r in await app_state.audit.records_for_case(cid) if r.get("action_type") == "status"]
    (row,) = rows
    assert row["action"] == action
    assert row["surface"] == "case" and row["actor"] == "ann"
    assert row["result_summary"].startswith(f"action={verb} status {start.value}→")
    assert row["target"]["type"] == "case" and row["target"]["id"] == cid
    # A direct (job) call has no request context and is never bulk.
    assert "request_id" not in row and "run_id" not in row


# --------------------------------------------------------------------------- #
# D7.1, D7.2: collaboration and grading rows, attribution
# --------------------------------------------------------------------------- #
def test_collab_rows_name_the_principal_not_the_body(auth) -> None:
    client, state, headers = auth
    _save(client, state, _case("case-r15-collab", number="CASE-0007"))
    assert client.post("/api/cases/case-r15-collab/comment",
                       json={"author": "mallory", "body": "looks bad"}, headers=headers).status_code == 200
    assert client.post("/api/cases/case-r15-collab/tags",
                       json={"tags": ["brute"], "analyst": "mallory"}, headers=headers).status_code == 200
    assert client.post("/api/cases/case-r15-collab/assign",
                       json={"assignee": "carol", "analyst": "mallory"}, headers=headers).status_code == 200
    rows = {r["action"]: r for r in _rows(client, state, "case-r15-collab") if r.get("action_type") == "collab"}
    assert set(rows) == {"case.commented", "case.tagged", "case.assigned"}
    for row in rows.values():
        assert row["actor"] == "Admin", row
        assert _target(row) == {"type": "case", "id": "case-r15-collab", "label": "CASE-0007"}
        assert row["request_id"] == _REQUEST_ID and row["actor_role"] == "super_admin"
        assert (row["outcome"], row["actor_type"], row["surface"]) == ("success", "human", "case")
    assert rows["case.commented"]["result_summary"] == "comment added"
    assert rows["case.tagged"]["result_summary"] == "tags set (1)"
    assert rows["case.assigned"]["result_summary"] == "assigned to carol"
    assert _changes(rows["case.assigned"])["assignee"]["after"] == "carol"
    assert json.loads(_changes(rows["case.tagged"])["tags"]["after"]) == ["brute"]
    case = client.portal.call(state.cases.get, "case-r15-collab")
    assigned = [h for h in case.history if h.get("event") == "assigned"]
    assert assigned[-1]["analyst"] == "Admin"
    # The stored comment names the principal too, never the name the body claims.
    assert case.comments[-1].author == "Admin"


def test_a_grading_row_carries_the_structured_fields(auth) -> None:
    client, state, headers = auth
    _save(client, state, _case("case-r15-grade"))
    response = client.post("/api/cases/case-r15-grade/feedback",
                           json={"assessment": "agree", "analyst": "mallory"}, headers=headers)
    assert response.status_code == 200, response.text
    (row,) = [r for r in _rows(client, state, "case-r15-grade") if r.get("action_type") == "feedback"]
    assert row["action"] == "case.graded" and row["actor"] == "Admin"
    assert row["target"]["id"] == "case-r15-grade" and row["request_id"] == _REQUEST_ID
    assert row["result_summary"] == "assessment=agree outcome=unknown accuracy=0.0"


def test_without_sign_in_the_body_value_is_the_actor(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-noauth"))
    client.post("/api/cases/case-r15-noauth/comment", json={"author": "bob", "body": "x"})
    client.post("/api/cases/case-r15-noauth/tags", json={"tags": ["t"], "analyst": "bob"})
    client.post("/api/cases/case-r15-noauth/assign", json={"assignee": "carol"})
    actors = {r["action"]: r["actor"] for r in _rows(client, state, "case-r15-noauth")
              if r.get("action_type") == "collab"}
    assert actors == {"case.commented": "bob", "case.tagged": "bob", "case.assigned": "analyst"}
    case = client.portal.call(state.cases.get, "case-r15-noauth")
    assert case.comments[-1].author == "bob"  # without sign-in, the body value as before


def test_a_reinvestigation_names_the_principal_and_stays_the_agent_row(
    auth, monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, state, headers = auth
    case = _case("case-r15-rerun")
    _save(client, state, case)

    async def _cluster(*_args: Any, **_kwargs: Any) -> Any:
        return SimpleNamespace(signature=case.cluster_signature)

    async def _investigate(*_args: Any, **_kwargs: Any) -> Case:
        return case

    monkeypatch.setattr(routes_mod, "_cluster_for_case", _cluster)
    monkeypatch.setattr(state.pipeline, "investigate_cluster", _investigate)
    response = client.post("/api/cases/case-r15-rerun/reinvestigate", json={"analyst": "mallory"},
                           headers=headers)
    assert response.status_code == 200, response.text
    (row,) = [r for r in _rows(client, state, "case-r15-rerun") if r.get("actor") == "reinvestigate"]
    assert row["result_summary"] == "manual reinvestigation requested by Admin"
    assert row["actor_type"] == "agent" and row["outcome"] == "success"


# --------------------------------------------------------------------------- #
# D7.3: the bulk marker
# --------------------------------------------------------------------------- #
def test_a_bulk_action_stamps_its_batch_id_as_run_id(client) -> None:
    state: AppState = client.app.state.tlsoc
    for cid in ("case-r15-bulk-a", "case-r15-bulk-b"):
        _save(client, state, _case(cid))
    response = client.post("/api/cases/bulk", json={"ids": ["case-r15-bulk-a", "case-r15-bulk-b"],
                                                    "action": "acknowledge"})
    assert response.status_code == 200, response.text
    run_ids = set()
    for cid in ("case-r15-bulk-a", "case-r15-bulk-b"):
        (row,) = [r for r in _rows(client, state, cid) if r.get("action_type") == "status"]
        case = client.portal.call(state.cases.get, cid)
        batch = [h for h in case.history if h.get("event") == "analyst_action"][-1]["batch"]
        assert row["run_id"] == batch and batch.startswith("bulk-")
        run_ids.add(row["run_id"])
    assert len(run_ids) == 1  # one bulk move, one marker


def test_no_client_can_mark_its_own_rows_as_bulk(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-forge"))
    client.post("/api/cases/case-r15-forge/assign?run_id=bulk-forged",
                json={"assignee": "carol", "run_id": "bulk-forged"})
    client.post("/api/cases/case-r15-forge/action?run_id=bulk-forged",
                json={"action": "acknowledge", "run_id": "bulk-forged", "batch_id": "bulk-forged"})
    rows = _human_rows(_rows(client, state, "case-r15-forge"))
    assert len(rows) == 2 and all("run_id" not in r for r in rows)


async def _job_rows(state: AppState, case_id: str) -> list[dict[str, Any]]:
    return _human_rows(await state.audit.records_for_case(case_id))


@pytest.fixture
def no_item_loop(app_state: AppState, monkeypatch: pytest.MonkeyPatch):
    async def _items(job: Any, _token: str, run: Any, *, result_kind: str) -> None:
        for item in job.item_states:
            await run(item)

    monkeypatch.setattr(app_state.job_runner, "_item_loop", _items)
    return app_state.job_runner


async def test_the_bulk_jobs_stamp_bulk_job_id(app_state: AppState, no_item_loop: Any) -> None:
    runner = no_item_loop
    for cid in ("case-r15-job-life", "case-r15-job-assign", "case-r15-job-tag"):
        await app_state.cases.save(_case(cid))
    life = SimpleNamespace(job_id="job-life-1", actor="asha", item_states={"case-r15-job-life": "pending"},
                           params={"case_ids": ["case-r15-job-life"], "action": "acknowledge"})
    await runner._case_lifecycle(life, "token")  # noqa: SLF001
    assign = SimpleNamespace(job_id="job-assign-1", actor="asha", item_states={"case-r15-job-assign": "pending"},
                             params={"assignee": "carol"})
    await runner._case_assign(assign, "token")  # noqa: SLF001
    tag = SimpleNamespace(job_id="job-tag-1", actor="asha", item_states={"case-r15-job-tag": "pending"},
                          params={"tag": "bulk-tag"})
    await runner._case_tag(tag, "token")  # noqa: SLF001

    (life_row,) = await _job_rows(app_state, "case-r15-job-life")
    assert (life_row["action"], life_row["run_id"], life_row["actor"]) == ("case.acknowledged", "bulk-job-life-1", "asha")
    (assign_row,) = await _job_rows(app_state, "case-r15-job-assign")
    assert (assign_row["action"], assign_row["run_id"], assign_row["actor"]) == ("case.assigned", "bulk-job-assign-1", "asha")
    (tag_row,) = await _job_rows(app_state, "case-r15-job-tag")
    assert (tag_row["action"], tag_row["run_id"], tag_row["actor"]) == ("case.tagged", "bulk-job-tag-1", "asha")

    # The marker never outlives its job: a later direct call is not bulk.
    await case_assign("case-r15-job-assign", AssignBody(assignee="dan", analyst="ann"), app_state, request=None)
    rows = await _job_rows(app_state, "case-r15-job-assign")
    assert rows[-1]["actor"] == "ann" and "run_id" not in rows[-1]


async def test_the_bulk_marker_needs_the_bulk_prefix(app_state: AppState) -> None:
    await app_state.cases.save(_case("case-r15-prefix"))
    with _bulk_audit_run("job-without-prefix"):
        await case_tags("case-r15-prefix", TagsBody(tags=["x"], analyst="ann"), app_state, request=None)
    with _bulk_audit_run("bulk-ok"):
        await case_tags("case-r15-prefix", TagsBody(tags=["x", "y"], analyst="ann"), app_state, request=None)
    first, second = await _job_rows(app_state, "case-r15-prefix")
    assert "run_id" not in first and second["run_id"] == "bulk-ok"


# --------------------------------------------------------------------------- #
# D4.2: actions taken
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("values", [
    ["blocked_indicator", "made_it_up"],
    ["blocked_indicator"] * 9,
    "blocked_indicator",
])
def test_an_unknown_or_overlong_actions_taken_answers_422(client, values: Any) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-taken-bad"))
    response = client.post("/api/cases/case-r15-taken-bad/action",
                           json={"action": "close", "actions_taken": values})
    assert response.status_code == 422, response.text
    assert client.portal.call(state.cases.get, "case-r15-taken-bad").status == CaseStatus.OPEN


def test_eight_actions_taken_are_accepted_and_exported(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-taken"))
    values = ["no_action_needed", "blocked_indicator", "isolated_host", "disabled_account",
              "reset_credentials", "removed_malware", "patched_or_hardened", "other"]
    response = client.post("/api/cases/case-r15-taken/action", json={"action": "resolve", "actions_taken": values})
    assert response.status_code == 200, response.text
    md = client.get("/api/cases/case-r15-taken/export?format=md").json()["content"]
    assert "## Actions taken" in md
    assert ("(resolve): No action needed, Blocked an indicator, Isolated a host, Disabled an account, "
            "Reset credentials, Removed malware, Patched or hardened, Other") in md
    assert "\u2014" not in md.split("## Actions taken", 1)[1]


def test_a_case_without_actions_taken_has_no_section(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-no-taken"))
    client.post("/api/cases/case-r15-no-taken/action", json={"action": "close"})
    md = client.get("/api/cases/case-r15-no-taken/export?format=md").json()["content"]
    assert "## Actions taken" not in md


def test_a_bulk_action_may_carry_actions_taken(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-bulk-taken"))
    response = client.post("/api/cases/bulk", json={"ids": ["case-r15-bulk-taken"], "action": "close",
                                                    "actions_taken": ["blocked_indicator"]})
    assert response.status_code == 200 and response.json()["results"][0]["ok"] is True
    case = client.portal.call(state.cases.get, "case-r15-bulk-taken")
    assert case.history[-1]["actions_taken"] == ["blocked_indicator"]


# --------------------------------------------------------------------------- #
# D6.9: review_via
# --------------------------------------------------------------------------- #
def test_review_via_accepts_only_its_one_value() -> None:
    assert CaseAction(action="reopen", review_via="auto_close_review").review_via == "auto_close_review"
    assert CaseAction(action="reopen").review_via is None
    for bad in ("bulk", "console", "api", "proposal", ""):
        with pytest.raises(ValidationError):
            CaseAction(action="reopen", review_via=bad)


def test_review_via_is_recorded_on_the_history_and_the_row_only(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-review", status=CaseStatus.CLOSED))
    response = client.post("/api/cases/case-r15-review/action",
                           json={"action": "reopen", "review_via": "auto_close_review"})
    assert response.status_code == 200, response.text
    case = client.portal.call(state.cases.get, "case-r15-review")
    assert case.history[-1]["review_via"] == "auto_close_review"
    assert case.status == CaseStatus.OPEN
    (row,) = [r for r in _rows(client, state, "case-r15-review") if r.get("action_type") == "status"]
    assert row["action"] == "case.reopened"
    assert _changes(row)["review_via"]["after"] == "auto_close_review"
    assert "review_via" not in row["result_summary"]
    bad = client.post("/api/cases/case-r15-review/action", json={"action": "escalate", "review_via": "bulk"})
    assert bad.status_code == 422


def test_no_bulk_body_accepts_review_via(client) -> None:
    state: AppState = client.app.state.tlsoc
    _save(client, state, _case("case-r15-bulk-review", status=CaseStatus.CLOSED))
    response = client.post("/api/cases/bulk", json={"ids": ["case-r15-bulk-review"], "action": "reopen",
                                                    "review_via": "auto_close_review"})
    assert response.status_code == 422, response.text
    assert client.portal.call(state.cases.get, "case-r15-bulk-review").status == CaseStatus.CLOSED
    assert "review_via" not in BulkCaseAction.model_fields
    with pytest.raises(ValidationError):
        CaseLifecycleParams.model_validate({"case_ids": ["c1"], "action": "reopen",
                                            "review_via": "auto_close_review"})


async def test_review_via_never_reaches_the_internal_via_or_the_open_steps_check(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.engine import runbook_runs

    open_step = RunbookStepsOpen(run_id="run-1", step_id="s1", title="Contain")
    recorded: list[str] = []

    async def _open(_state: Any, _case_id: str) -> list[RunbookStepsOpen]:
        return [open_step]

    async def _record(_state: Any, _case: Any, *, via: str, **_kwargs: Any) -> None:
        recorded.append(via)

    monkeypatch.setattr(runbook_runs, "open_required_steps", _open)
    monkeypatch.setattr(runbook_runs, "record_closed_with_open_steps", _record)
    await app_state.cases.save(_case("case-r15-steps"))
    # The open-steps check still answers 409: review_via does not skip it.
    with pytest.raises(routes_mod.HTTPException) as refused:
        await _perform_case_action(
            "case-r15-steps",
            CaseAction(action="close", review_via="auto_close_review", require_open_steps_reason=True),
            "ann", app_state,
        )
    assert refused.value.status_code == 409
    # Without the Console flag the close goes through and names how it was made from
    # the request ("api"), never from review_via.
    await _perform_case_action("case-r15-steps", CaseAction(action="close", review_via="auto_close_review"),
                               "ann", app_state)
    assert recorded == ["api"]
