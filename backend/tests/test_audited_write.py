"""Round 14 SPEC §3.6 (E16): audit before visible.

``audited_write`` never returns success without its row, writes no row for a refused
pre-check, refuses with ``503 audit_unavailable`` and changes nothing when the audit
append fails, pairs a failed store write with a failure row (same request id), and
publishes only after both. The sink follows SPEC §3.5 with Demo Mode on and off.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.audit.write import CANCELLED_REASON, AuditUnavailableError, audited_write, failure_action
from app.config import Secrets
from app.constants import ActionType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import AuditTarget
from app.state import AppState


class _Repo:
    """An audit store that records appends in order and can be told to fail."""

    def __init__(self, journal: list[tuple[str, Any]], *, fail_on: str | None = None) -> None:
        self.journal = journal
        self.fail_on = fail_on
        self.rows: list[dict[str, Any]] = []

    async def record_strict(self, **kwargs: Any) -> None:
        if self.fail_on and (self.fail_on == "*" or kwargs.get("outcome") == self.fail_on):
            raise RuntimeError("audit store down")
        self.rows.append(kwargs)
        self.journal.append(("audit", kwargs.get("action")))


class _Store:
    """A revisioned document store (the shape of a strict-CAS KV write)."""

    def __init__(self, journal: list[tuple[str, Any]]) -> None:
        self.journal = journal
        self.doc: dict[str, Any] = {"name": "v1", "_rev": 3}

    async def put(self, value: dict[str, Any], expected: int) -> dict[str, Any]:
        if self.doc["_rev"] != expected:
            raise HTTPException(status_code=409, detail={"code": "runbook_conflict", "message": "stale"})
        self.doc = {**value, "_rev": expected + 1}
        self.journal.append(("write", self.doc["_rev"]))
        return self.doc


class _State:
    def __init__(self, control: Any, execution: Any) -> None:
        self.control_audit = control
        self.execution_audit = execution
        self.audit = execution


async def _publish(journal: list[tuple[str, Any]], result: dict[str, Any]) -> None:
    journal.append(("publish", result["_rev"]))


async def test_the_action_row_lands_before_the_write_and_the_frame_after():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)
    result = await audited_write(
        _State(repo, repo), sink="control", action="runbook.published",
        target={"type": "runbook", "id": "rb-1", "label": "Brute force"}, expected_revision=3,
        changes=[{"field": "state", "before": "in_review", "after": "published"}],
        write=lambda: store.put({"name": "v2"}, 3), action_type=ActionType.RUNBOOK,
        actor="trao", context={"request_id": "req-abcdef01", "actor_role": "soc_manager"},
        after_write=lambda r: _publish(journal, r),
    )
    assert result["name"] == "v2"
    assert journal == [("audit", "runbook.published"), ("write", 4), ("publish", 4)]
    row = repo.rows[0]
    assert row["outcome"] == "success" and row["actor_type"] == "human"
    assert row["target"] == AuditTarget(type="runbook", id="rb-1", label="Brute force", revision=4)
    assert row["request_id"] == "req-abcdef01" and row["actor_role"] == "soc_manager"
    assert row["changes"][0]["after"] == "published"


async def test_a_refused_precheck_writes_no_row_and_changes_nothing():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)

    def deny() -> None:
        raise HTTPException(status_code=403, detail="permission denied: runbooks:publish")

    with pytest.raises(HTTPException) as caught:
        await audited_write(
            _State(repo, repo), sink="control", action="runbook.published",
            target={"type": "runbook", "id": "rb-1"}, expected_revision=3, changes=None,
            write=lambda: store.put({"name": "v2"}, 3), action_type=ActionType.RUNBOOK,
            actor="trao", precheck=deny,
        )
    assert caught.value.status_code == 403
    assert journal == [] and store.doc == {"name": "v1", "_rev": 3}


async def test_a_failed_append_is_503_and_nothing_changes():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal, fail_on="*"), _Store(journal)
    published: list[Any] = []
    with pytest.raises(AuditUnavailableError) as caught:
        await audited_write(
            _State(repo, repo), sink="control", action="runbook.published",
            target={"type": "runbook", "id": "rb-1"}, expected_revision=3, changes=None,
            write=lambda: store.put({"name": "v2"}, 3), action_type=ActionType.RUNBOOK,
            actor="trao", after_write=published.append,
        )
    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "audit_unavailable"
    # The store never saw the would-be version, and nothing was published.
    assert store.doc == {"name": "v1", "_rev": 3}
    assert journal == [] and published == []


async def test_a_failed_store_write_appends_a_paired_failure_row_and_keeps_its_error():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)
    store.doc["_rev"] = 5  # someone else published meanwhile
    with pytest.raises(HTTPException) as caught:
        await audited_write(
            _State(repo, repo), sink="control", action="runbook.published",
            target={"type": "runbook", "id": "rb-1"}, expected_revision=3, changes=None,
            write=lambda: store.put({"name": "v2"}, 3), action_type=ActionType.RUNBOOK, actor="trao",
        )
    assert caught.value.status_code == 409
    success, failure = repo.rows
    assert (success["action"], success["outcome"]) == ("runbook.published", "success")
    assert (failure["action"], failure["outcome"]) == ("runbook.publish_failed", "failure")
    assert failure["request_id"] == success["request_id"]  # minted once, pairs the rows
    assert "runbook_conflict" in failure["result_summary"]
    assert store.doc["_rev"] == 5


async def test_a_lost_failure_row_still_reports_the_store_error():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal, fail_on="failure"), _Store(journal)
    store.doc["_rev"] = 9
    with pytest.raises(HTTPException) as caught:
        await audited_write(
            _State(repo, repo), sink="control", action="settings.updated",
            target={"type": "setting", "id": "auto_close"}, expected_revision=3, changes=None,
            write=lambda: store.put({"x": 1}, 3), action_type=ActionType.STATUS, actor="a",
        )
    assert caught.value.status_code == 409
    assert [r["outcome"] for r in repo.rows] == ["success"]


async def test_a_failing_publish_does_not_undo_a_saved_and_audited_change():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)

    def broken(_result: Any) -> None:
        raise RuntimeError("bus down")

    result = await audited_write(
        _State(repo, repo), sink="control", action="dashboard.created",
        target={"type": "dashboard", "id": "d1", "label": "Mine"}, expected_revision=None,
        changes=None, write=lambda: store.put({"n": 1}, 3), action_type=ActionType.STATUS,
        actor="a", after_write=broken,
    )
    assert result["_rev"] == 4 and repo.rows[0]["target"].revision is None


async def test_the_sink_is_named_and_an_invalid_action_is_refused_first():
    journal: list[tuple[str, Any]] = []
    control, execution, store = _Repo(journal), _Repo(journal), _Store(journal)
    await audited_write(
        _State(control, execution), sink="execution", action="step.updated",
        target={"type": "case", "id": "case-1"}, expected_revision=None, changes=None,
        write=lambda: store.put({"n": 1}, 3), action_type=ActionType.TASK_UPDATE, actor="a",
    )
    assert execution.rows and not control.rows
    with pytest.raises(ValueError):
        await audited_write(
            _State(control, execution), sink="elsewhere", action="step.updated",
            target=None, expected_revision=None, changes=None,
            write=lambda: store.put({"n": 1}, 4), action_type=ActionType.TASK_UPDATE, actor="a",
        )
    with pytest.raises(ValueError):
        await audited_write(
            _State(control, execution), sink="control", action="Step Updated",
            target=None, expected_revision=None, changes=None,
            write=lambda: store.put({"n": 1}, 4), action_type=ActionType.TASK_UPDATE, actor="a",
        )
    assert store.doc["_rev"] == 4  # only the first write ran


async def test_a_request_id_outside_the_grammar_is_replaced():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)

    class Ctx:
        request_id = "bad id with spaces"
        client = None
        session_ref = None
        actor_role = None

    await audited_write(
        _State(repo, repo), sink=repo, action="user.updated", target=None, expected_revision=None,
        changes=None, write=lambda: store.put({}, 3), action_type=ActionType.USER_MGMT, actor="a",
        context=Ctx(),
    )
    rid = repo.rows[0]["request_id"]
    assert rid != Ctx.request_id and len(rid) == 36


async def _settle() -> None:
    """Let a shielded unit whose caller was cancelled run to its end."""
    for _ in range(50):
        await asyncio.sleep(0)


async def test_a_cancelled_request_cannot_split_the_row_from_its_write():
    """A client that disconnects while the write is in flight cancels the request,
    not the unit: the write finishes, so the success row never names a revision that
    was not written. Step 4 (publish) still follows the save: the other consoles that
    follow the change learn of it though its requester left."""
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)
    entered, release = asyncio.Event(), asyncio.Event()
    published: list[Any] = []

    async def slow_write() -> dict[str, Any]:
        entered.set()
        await release.wait()
        return await store.put({"name": "v2"}, 3)

    call = asyncio.ensure_future(audited_write(
        _State(repo, repo), sink="control", action="runbook.published",
        target={"type": "runbook", "id": "rb-1"}, expected_revision=3, changes=None,
        write=slow_write, action_type=ActionType.RUNBOOK, actor="trao",
        after_write=published.append,
    ))
    await entered.wait()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    release.set()
    await _settle()
    assert journal == [("audit", "runbook.published"), ("write", 4)]
    assert store.doc == {"name": "v2", "_rev": 4}
    assert published == [{"name": "v2", "_rev": 4}]


async def test_a_cancelled_request_publishes_after_the_save_and_survives_a_failing_publish():
    """Step 4 of a detached write runs after the save (never before it), and a publish
    that fails is only logged: the change stays saved and audited."""
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow_write() -> dict[str, Any]:
        entered.set()
        await release.wait()
        return await store.put({"name": "v2"}, 3)

    async def publish(result: dict[str, Any]) -> None:
        journal.append(("publish", result["_rev"]))
        raise RuntimeError("event bus down")

    call = asyncio.ensure_future(audited_write(
        _State(repo, repo), sink="control", action="runbook.published",
        target={"type": "runbook", "id": "rb-1"}, expected_revision=3, changes=None,
        write=slow_write, action_type=ActionType.RUNBOOK, actor="trao", after_write=publish,
    ))
    await entered.wait()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert ("publish", 4) not in journal  # nothing is published before the save
    release.set()
    await _settle()
    assert journal == [("audit", "runbook.published"), ("write", 4), ("publish", 4)]
    assert store.doc == {"name": "v2", "_rev": 4}


async def test_a_cancelled_request_still_records_a_failed_write():
    journal: list[tuple[str, Any]] = []
    repo, store = _Repo(journal), _Store(journal)
    entered, release = asyncio.Event(), asyncio.Event()
    published: list[Any] = []

    async def slow_conflicting_write() -> dict[str, Any]:
        entered.set()
        await release.wait()
        return await store.put({"name": "v2"}, 2)  # stale: a conflict

    call = asyncio.ensure_future(audited_write(
        _State(repo, repo), sink="control", action="runbook.published",
        target={"type": "runbook", "id": "rb-1"}, expected_revision=2, changes=None,
        write=slow_conflicting_write, action_type=ActionType.RUNBOOK, actor="trao",
        after_write=published.append,
    ))
    await entered.wait()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    release.set()
    await _settle()
    success, failure = repo.rows
    assert (failure["action"], failure["outcome"]) == ("runbook.publish_failed", "failure")
    assert failure["request_id"] == success["request_id"]
    assert "runbook_conflict" in failure["result_summary"]
    assert store.doc == {"name": "v1", "_rev": 3}
    assert published == []  # a write that failed publishes nothing


async def test_a_request_cancelled_during_the_append_still_writes():
    """Cancelled while the action row is being appended: the row and the write land
    together (never a row for a write that was then skipped)."""
    journal: list[tuple[str, Any]] = []
    store = _Store(journal)
    entered, release = asyncio.Event(), asyncio.Event()

    class SlowRepo(_Repo):
        async def record_strict(self, **kwargs: Any) -> None:
            entered.set()
            await release.wait()
            await super().record_strict(**kwargs)

    repo = SlowRepo(journal)
    call = asyncio.ensure_future(audited_write(
        _State(repo, repo), sink="control", action="settings.updated",
        target={"type": "setting", "id": "auto_close"}, expected_revision=3, changes=None,
        write=lambda: store.put({"x": 1}, 3), action_type=ActionType.STATUS, actor="a",
    ))
    await entered.wait()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    release.set()
    await _settle()
    assert journal == [("audit", "settings.updated"), ("write", 4)]


async def test_a_write_cancelled_while_it_runs_has_an_unknown_outcome():
    """Only a shutdown cancels the write itself. Whether it was saved is unknown, so
    its follow-up row says exactly that rather than claiming a failure."""
    journal: list[tuple[str, Any]] = []
    repo = _Repo(journal)

    async def cancelled_write() -> None:
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await audited_write(
            _State(repo, repo), sink="control", action="runbook.published",
            target={"type": "runbook", "id": "rb-1"}, expected_revision=3, changes=None,
            write=cancelled_write, action_type=ActionType.RUNBOOK, actor="trao",
        )
    success, follow_up = repo.rows
    assert follow_up["action"] == "runbook.publish_failed"
    assert follow_up["outcome"] == "unknown"
    assert follow_up["result_summary"] == CANCELLED_REASON
    assert follow_up["request_id"] == success["request_id"]


@pytest.mark.parametrize(
    ("action", "failed"),
    [
        ("runbook.published", "runbook.publish_failed"),
        ("user.role_changed", "user.role_change_failed"),
        ("auth.login", "auth.login_failed"),
        ("settings.updated", "settings.update_failed"),
        ("audit.exported", "audit.export_failed"),
        ("step.ai_draft_confirmed", "step.ai_draft_confirm_failed"),
        ("r" * 40 + "." + "v" * 23, "r" * 40 + "." + "v" * 16 + "_failed"),
    ],
)
def test_failure_action_names(action, failed):
    assert failure_action(action) == failed
    assert len(failed) <= 64


# --------------------------------------------------------------------------- #
# Real stores: Demo Mode on and off, and a route answering 503
# --------------------------------------------------------------------------- #
def _app() -> FastAPI:
    mock = MockProvider()
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    stored: dict[str, Any] = {"doc": {"name": "v1"}, "rev": 1}

    @api.post("/demo-write")
    async def demo_write() -> dict[str, Any]:
        state = api.state.tlsoc

        async def write() -> dict[str, Any]:
            stored["doc"], stored["rev"] = {"name": "v2"}, stored["rev"] + 1
            return stored["doc"]

        return await audited_write(
            state, sink="control", action="settings.updated",
            target={"type": "setting", "id": "branding"}, expected_revision=stored["rev"],
            changes=None, write=write, action_type=ActionType.STATUS, actor="admin",
            surface="settings",
        )

    api.state.stored = stored
    return api


def _rows(client: TestClient, repo: Any) -> list[dict[str, Any]]:
    return client.portal.call(lambda: repo.records(surface="settings", limit=50))


def test_control_and_execution_sinks_with_demo_mode_on_and_off():
    with TestClient(_app()) as client:
        state: AppState = client.app.state.tlsoc

        async def run(sink: str, surface: str) -> None:
            async def write() -> None:
                return None

            await audited_write(
                state, sink=sink, action="case.closed_with_open_steps",
                target={"type": "case", "id": "case-1"}, expected_revision=None, changes=None,
                write=write, action_type=ActionType.STATUS, actor="analyst", surface=surface,
            )

        client.portal.call(run, "control", "off-control")
        client.portal.call(run, "execution", "off-execution")
        real = state.control_audit
        assert client.portal.call(lambda: real.records(surface="off-control"))
        assert client.portal.call(lambda: real.records(surface="off-execution"))

        client.portal.call(state.enable_demo)
        client.portal.call(run, "control", "on-control")
        client.portal.call(run, "execution", "on-execution")
        demo = state.demo_audit
        assert client.portal.call(lambda: real.records(surface="on-control"))
        assert not client.portal.call(lambda: real.records(surface="on-execution"))
        assert client.portal.call(lambda: demo.records(surface="on-execution"))
        assert not client.portal.call(lambda: demo.records(surface="on-control"))


def test_a_route_answers_503_and_changes_nothing_when_the_audit_cannot_be_written():
    with TestClient(_app()) as client:
        state: AppState = client.app.state.tlsoc
        ok = client.post("/demo-write")
        assert ok.status_code == 200 and ok.json() == {"name": "v2"}
        row = _rows(client, state.control_audit)[0]
        assert row["action"] == "settings.updated" and row["target"]["revision"] == 2

        client.app.state.stored.update({"doc": {"name": "v2"}, "rev": 2})
        original = state.control_audit.record_strict

        async def down(**_: Any) -> None:
            raise RuntimeError("audit index unavailable")

        state.control_audit.record_strict = down  # type: ignore[method-assign]
        try:
            refused = client.post("/demo-write")
        finally:
            state.control_audit.record_strict = original  # type: ignore[method-assign]
        assert refused.status_code == 503
        assert refused.json()["detail"]["code"] == "audit_unavailable"
        assert client.app.state.stored == {"doc": {"name": "v2"}, "rev": 2}
