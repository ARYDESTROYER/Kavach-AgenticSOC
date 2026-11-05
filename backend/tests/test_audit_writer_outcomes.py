"""Every Round 14 audit writer names how its step ended.

Round 14 SPEC §4.5.3: ``outcome`` (and ``actor_type``) are written by every writer of
a new row, and the Help Center promises "Not recorded" only for rows written before
Round 14 (``docs/administration/audit-log.md``). These tests drive one writer of each
family outside the investigation pipeline (whose rows ``RunStampedAudit`` stamps, see
``test_audit_engine_outcomes.py``) and read the stored rows back: the notification
service's sends, the durable reinvestigation, the runbook AI's model call, the
standup and event overview prompts, the chat assistant's model calls, tool calls and
refusals, the formatter, and one route row per router file. The investigator and the
pipeline keep a credential out of the case fields every case reader sees.

The last tests are a guard: a new ``record``/``record_strict`` call (or a call of the
chat turn's ``_audit``) that passes ``action_type`` and no ``outcome`` fails it, unless
it is one of the keyed rows whose retries must reproduce their first write byte for
byte. Old rows are never rewritten (#2); ``decide()`` is not involved (#3).
"""

from __future__ import annotations

import ast
import inspect
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncIterator

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request

from app.agents.chat_tools import registry
from app.agents.chat_tools.registry import build_toolbox, tool_audit_outcome
from app.agents.formatter import Formatter
from app.agents.pipeline import RunStampedAudit
from app.api.deps import record_chat_tool_denial
from app.api.routes_rag import batch_audit_outcome, repair_audit_outcome
from app.audit.query import AuditFilters, build_predicate, matches
from app.config import NotificationChannelConfig, NotificationConfig, Preferences, Secrets
from app.constants import ActionType, CaseStatus, EntityType, Role, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.llm.gateway import BudgetBlocked, GatewayError
from app.llm.providers import CompletionResult, MockProvider
from app.models import AUDIT_ACTOR_TYPES, AUDIT_OUTCOMES, Case, ChatRequest, Entity, User, VerdictResult
from app.state import AppState
from app.tools.base import ToolResult
from app.tools.es_query import EsQueryTool
from tests.conftest import mount_moved_routers
from tests.test_audit_engine_outcomes import _cluster, _escalate, _final, _investigator_raising
from tests.test_chat_engine_loop import (
    FAKE_TOOLS,
    FakeGateway,
    IndicatorTool,
    final,
    make_ctx as make_turn_ctx,
    make_engine,
    make_prefs,
    run as run_turn,
    tool_call,
)
from tests.test_chat_tools_support import RecordingAudit, make_ctx

_FAILED = build_predicate(AuditFilters(outcome="failure"))
_AGENT = build_predicate(AuditFilters(scope="agent"))
_PEOPLE = build_predicate(AuditFilters(scope="people"))

#: An exception text that carries a credential twice: an address with
#: ``user:password@`` and a basic credential header.
_SECRET_TEXT = "refused by https://user:secret@example.com/api (Authorization: Basic dXNlcjpzZWNyZXQ=)"


def _assert_no_secret(text: str) -> None:
    assert "user:secret" not in text and "secret@" not in text
    assert "dXNlcjpzZWNyZXQ=" not in text
    # The host stays, so the record still says what could not be reached.
    assert "https://example.com/api" in text and "[REDACTED]" in text


class _Recorder:
    """An audit sink that keeps every keyword it was given."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def record(self, **fields: Any) -> None:
        self.rows.append(fields)

    async def record_strict(self, **fields: Any) -> None:
        self.rows.append(fields)


def _value(field: Any) -> str:
    return str(getattr(field, "value", field) or "")


def _kind(row: dict[str, Any]) -> tuple[Any, Any]:
    return row.get("actor_type"), row.get("outcome")


def _case(case_id: str, **extra: Any) -> Case:
    fields: dict[str, Any] = dict(
        case_id=case_id, cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        rule_ids=["linux_auth"], risk_score=60.0,
        verdict=Verdict.NEEDS_HUMAN, confidence=0.4, status=CaseStatus.NEEDS_HUMAN,
    )
    fields.update(extra)
    return Case(**fields)


async def _rows(logger: Any) -> list[dict[str, Any]]:
    return await logger.records(limit=2000)


# --------------------------------------------------------------------------- #
# The notification service's own sends
# --------------------------------------------------------------------------- #
def _channels_prefs() -> Preferences:
    return Preferences(notifications=NotificationConfig(
        enabled=True, rate_limit_per_hour=10, dedup_window_seconds=0,
        channels=[
            NotificationChannelConfig(id="w-ok", type="webhook", config={"url": "https://hooks.example/ok"}),
            NotificationChannelConfig(id="w-down", type="webhook", config={"url": "https://hooks.example/down"}),
        ],
    ))


@pytest.fixture
def _webhooks(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.notifications.webhook as wh

    async def _poster(url: str, **_kwargs: Any) -> tuple[int, str]:
        return (200, "ok") if url.endswith("/ok") else (500, "upstream error")

    monkeypatch.setattr(wh, "_httpx_post", _poster)


@pytest.mark.usefixtures("_webhooks")
async def test_each_channel_send_is_a_system_row_whose_outcome_is_the_send() -> None:
    from app.notifications.dispatch import NotificationService

    prefs = _channels_prefs()
    audit = _Recorder()
    service = NotificationService(get_prefs=lambda: prefs, secrets=Secrets(_env_file=None), audit=audit)
    sent = await service.dispatch(_case("case-sends"), "escalated")
    assert {r["channel_id"]: r["ok"] for r in sent} == {"w-ok": True, "w-down": False}
    rows = {r["result_summary"].split()[0]: r for r in audit.rows
            if r["action_type"] == ActionType.NOTIFICATION}
    assert {k: _kind(v) for k, v in rows.items()} == {
        "channel=w-ok": ("system", "success"),
        "channel=w-down": ("system", "failure"),
    }
    # The failed send is listed under the audit log's Failed filter; the sent one is not.
    assert matches(_FAILED, rows["channel=w-down"]) and not matches(_FAILED, rows["channel=w-ok"])
    assert all(matches(_AGENT, r) for r in rows.values())


@pytest.mark.usefixtures("_webhooks")
async def test_a_send_test_row_records_whether_the_test_went_out() -> None:
    from app.notifications.dispatch import NotificationService

    prefs = _channels_prefs()
    audit = _Recorder()
    service = NotificationService(get_prefs=lambda: prefs, secrets=Secrets(_env_file=None), audit=audit)
    assert (await service.test_channel("w-down"))["ok"] is False
    assert (await service.test_channel("w-ok"))["ok"] is True
    assert [(r["result_summary"].split()[0], r["outcome"], r["actor_type"]) for r in audit.rows] == [
        ("channel=w-down", "failure", "system"),
        ("channel=w-ok", "success", "system"),
    ]


async def _wired_notify(app_state: AppState, case: Case, channels: list[NotificationChannelConfig]
                        ) -> list[dict[str, Any]]:
    """Run one notify rule through the application's real wiring (the automation, the
    notification service, its inbox) and return the case's stored rows."""
    from app.config import AutomationRule, ThresholdAutomationConfig

    notifications = _channels_prefs().notifications.model_copy(update={"channels": channels})
    await app_state.update_prefs(app_state.prefs.model_copy(update={"notifications": notifications}))
    await app_state.cases.save(case)
    rule = AutomationRule(id="page", action="notify", payload={"trigger": "escalated"})
    prefs = Preferences(threshold_automation=ThresholdAutomationConfig(enabled=True, rules=[rule]))
    await app_state.automation.run(case, prefs, save=app_state.cases.save)
    return [r for r in await _rows(app_state.audit) if r.get("case_id") == case.case_id]


def _sends(rows: list[dict[str, Any]]) -> list[tuple[str, tuple[Any, Any]]]:
    return sorted((r["result_summary"].split()[0], _kind(r)) for r in rows
                  if r.get("action_type") == ActionType.NOTIFICATION.value)


def _automation_rows(rows: list[dict[str, Any]]) -> list[tuple[tuple[Any, Any], str]]:
    return [(_kind(r), r["result_summary"]) for r in rows if r.get("actor") == "automation"]


@pytest.mark.usefixtures("_webhooks")
async def test_the_application_notifier_writes_one_row_per_send_and_a_truthful_automation_row(
    app_state: AppState,
) -> None:
    """End to end through the real wiring: the automation's notify action hands the
    case to the application's notification service. The case has no assignee, so the
    in-app inbox copy reached nobody: its own row reads ``success`` (nothing was due),
    but it is not a channel the notification went out on, so the automation row
    counts the two webhooks only."""
    rows = await _wired_notify(app_state, _case("case-wired-sends"), _channels_prefs().notifications.channels)
    assert _automation_rows(rows) == [(
        ("system", "partial"),
        "rule=page action=notify notify=escalated. Partly sent: 1 of 2 channels failed.",
    )]
    assert _sends(rows) == [
        ("channel=in_app", ("system", "success")),
        ("channel=w-down", ("system", "failure")),
        ("channel=w-ok", ("system", "success")),
    ]


@pytest.mark.usefixtures("_webhooks")
async def test_a_notify_whose_only_channel_failed_reads_failure_in_the_real_wiring(
    app_state: AppState,
) -> None:
    """The one configured webhook failed and the inbox copy reached nobody: nothing
    went out, so the automation row is ``failure`` and listed under Failed."""
    down = [c for c in _channels_prefs().notifications.channels if c.id == "w-down"]
    rows = await _wired_notify(app_state, _case("case-wired-down"), down)
    (automation,) = [r for r in rows if r.get("actor") == "automation"]
    assert (_kind(automation), automation["result_summary"]) == (
        ("system", "failure"),
        "rule=page action=notify notify=escalated. Not sent: 1 of 1 channel failed.",
    )
    assert matches(_FAILED, automation)
    assert _sends(rows) == [("channel=in_app", ("system", "success")), ("channel=w-down", ("system", "failure"))]


@pytest.mark.usefixtures("_webhooks")
async def test_an_inbox_copy_that_reached_the_assignee_counts_as_sent(app_state: AppState) -> None:
    down = [c for c in _channels_prefs().notifications.channels if c.id == "w-down"]
    await app_state.users.save(User(username="bob", role="analyst_tier1"))
    rows = await _wired_notify(app_state, _case("case-wired-assigned", assignee="bob"), down)
    assert _automation_rows(rows) == [(
        ("system", "partial"),
        "rule=page action=notify notify=escalated. Partly sent: 1 of 2 channels failed.",
    )]
    (inapp,) = [r for r in rows if r["result_summary"].startswith("channel=in_app")]
    assert "fanned out to 1 recipient(s)" in inapp["result_summary"] and _kind(inapp) == ("system", "success")


async def test_the_inbox_details_the_notify_wiring_treats_as_not_due_are_the_channels_own() -> None:
    """``AppState._automation_notify`` leaves out an inbox copy that was due for nobody
    by its detail; these are the details ``InAppChannel.send`` really returns."""
    from app.notifications.channel import NotificationEvent
    from app.notifications.inapp import InAppChannel

    event = NotificationEvent(case=_case("case-inapp-pin"), trigger="escalated", subject="s", html="", text="t",
                              meta={})

    async def _nobody(_event: Any) -> list[str]:
        return []

    assert (await InAppChannel().send(event)).detail == "no inbox wired"
    unaddressed = await InAppChannel(inbox=object(), resolve_recipients=_nobody).send(event)
    assert (unaddressed.ok, unaddressed.detail) == (True, "no recipients")
    source = inspect.getsource(AppState._automation_notify)  # noqa: SLF001
    assert '"no recipients"' in source and '"no inbox wired"' in source


# --------------------------------------------------------------------------- #
# The durable reinvestigation, the runbook AI, the standup and the overview
# --------------------------------------------------------------------------- #
async def test_a_durable_reinvestigation_row_reads_as_the_direct_route_row(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The job's DECISION row matches ``POST /api/cases/{id}/reinvestigate``
    (``test_audit_route_outcomes.py``): the agent pipeline's token, in Agent
    activity, ``success``; the person who asked is named in the summary."""
    runner = app_state.job_runner
    case = _case("case-durable-rerun")
    await app_state.real_cases.save(case)
    investigated: list[str] = []

    async def _cluster_for(_case: Case) -> Any:
        return SimpleNamespace(signature=_case.cluster_signature)

    async def _investigate(cluster: Any, *_args: Any, **_kwargs: Any) -> None:
        investigated.append(cluster.signature)

    async def _items(job: Any, _token: str, run: Any, *, result_kind: str) -> None:
        assert result_kind == "case_reinvestigation"
        for item in job.item_states:
            await run(item)

    monkeypatch.setattr(app_state, "cluster_for_case", _cluster_for)
    monkeypatch.setattr(app_state.real_pipeline, "investigate_cluster", _investigate)
    monkeypatch.setattr(runner, "_item_loop", _items)
    job = SimpleNamespace(job_id="job-rerun-1", actor="asha", params={},
                          item_states={"case-durable-rerun": "pending"})
    await runner._case_reinvestigate(job, "token")  # noqa: SLF001
    assert investigated == ["sig:case-durable-rerun"]
    (row,) = [r for r in await _rows(app_state.control_audit)
              if r.get("case_id") == "case-durable-rerun" and r.get("actor") == "reinvestigate"]
    assert row["action_type"] == ActionType.DECISION.value
    assert _kind(row) == ("agent", "success")
    assert row["result_summary"] == "durable job job-rerun-1 requested by asha"
    assert matches(_AGENT, row) and not matches(_PEOPLE, row)


async def test_a_runbook_ai_model_call_row_is_an_agent_success(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.engine import runbook_runs as R

    class _Gateway:
        async def complete(self, role: Any, messages: Any, model_cfg: Any, **kwargs: Any) -> CompletionResult:
            receipt = kwargs.get("usage_receipt")
            if receipt is not None:
                receipt.prompt_tokens, receipt.completion_tokens, receipt.model = 10, 5, "gpt-test"
            return CompletionResult(text="Draft note.", prompt_tokens=10, completion_tokens=5, model="gpt-test")

    monkeypatch.setattr(R, "_gateway", lambda _state: _Gateway())
    text, model = await R._ai_call(  # noqa: SLF001
        app_state, [{"role": "user", "content": "draft"}], app_state.prefs.chat_model,
        case_id="case-runbook-ai", actor="asha", purpose="draft",
    )
    assert (text, model) == ("Draft note.", "gpt-test")
    (row,) = [r for r in await _rows(app_state.audit)
              if r.get("case_id") == "case-runbook-ai" and r.get("action_type") == ActionType.PROMPT.value]
    assert row["actor"] == "asha" and row["surface"] == "runbook"
    # The AI help ran for the asking analyst: an Agent activity row, as before Round 14.
    assert _kind(row) == ("agent", "success")
    assert matches(_AGENT, row)


async def test_a_refused_runbook_ai_call_writes_no_prompt_row(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.engine import runbook_runs as R

    class _Blocked:
        async def complete(self, *_args: Any, **_kwargs: Any) -> Any:
            raise BudgetBlocked("budget ceiling exceeded: daily")

    monkeypatch.setattr(R, "_gateway", lambda _state: _Blocked())
    with pytest.raises(R.RunbookRunError):
        await R._ai_call(  # noqa: SLF001
            app_state, [{"role": "user", "content": "draft"}], app_state.prefs.chat_model,
            case_id="case-runbook-refused", actor="asha", purpose="draft",
        )
    assert [r for r in await _rows(app_state.audit) if r.get("case_id") == "case-runbook-refused"] == []


async def test_the_standup_and_overview_prompt_rows_are_agent_successes(app_state: AppState) -> None:
    await app_state.standup_service.generate(app_state.prefs)
    # No source address, so no enrichment lookup runs.
    await app_state.overview_service.overview({"message": "x"}, app_state.prefs)
    rows = [r for r in await _rows(app_state.audit) if r.get("action_type") == ActionType.PROMPT.value]
    by_actor = {r["actor"]: r for r in rows if r.get("actor") in ("standup", "overview")}
    assert {k: _kind(v) for k, v in by_actor.items()} == {
        "standup": ("agent", "success"), "overview": ("agent", "success"),
    }
    assert all(matches(_AGENT, r) for r in by_actor.values())


class _Raising:
    """A gateway whose every call raises ``error``."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    async def complete(self, *_args: Any, **_kwargs: Any) -> Any:
        raise self.error


#: A provider fault and the AI budget's refusal, each carrying a credential in its text.
_MODEL_FAILURES = pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (GatewayError(f"provider down: {_SECRET_TEXT}"), "failure"),
        # The AI budget refusing the call is a policy refusal, not a fault.
        (BudgetBlocked(f"budget ceiling exceeded: daily {_SECRET_TEXT}"), "denied"),
    ],
    ids=["provider-failure", "budget-refusal"],
)


@_MODEL_FAILURES
async def test_a_standup_model_failure_writes_a_redacted_error_row_after_its_prompt(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch, error: Exception, outcome: str,
) -> None:
    """The PROMPT row says the prompt was handed to the gateway; a refused or failed
    call adds one ERROR row, as the router's and the formatter's do, so the standup
    that fell back to its deterministic summary is listed under Failed or Denied."""
    monkeypatch.setattr(app_state.standup_service, "_gateway", _Raising(error))
    await app_state.standup_service.generate(app_state.prefs)
    rows = {r["action_type"]: r for r in await _rows(app_state.audit) if r.get("actor") == "standup"}
    assert {k: _kind(v) for k, v in rows.items()} == {
        ActionType.PROMPT.value: ("agent", "success"),
        ActionType.ERROR.value: ("agent", outcome),
    }
    error_row = rows[ActionType.ERROR.value]
    assert error_row["result_summary"].startswith("standup model unavailable: ")
    assert error_row["result_summary"].endswith("; the deterministic summary was used")
    _assert_no_secret(error_row["result_summary"])
    assert matches(build_predicate(AuditFilters(outcome=outcome)), error_row) and matches(_AGENT, error_row)


@_MODEL_FAILURES
async def test_an_overview_model_failure_writes_a_redacted_error_row_after_its_prompt(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch, error: Exception, outcome: str,
) -> None:
    monkeypatch.setattr(app_state.overview_service, "_gateway", _Raising(error))
    result = await app_state.overview_service.overview({"message": "x"}, app_state.prefs)
    assert "LLM overview unavailable" in result["overview"]       # the deterministic fallback
    rows = {r["action_type"]: r for r in await _rows(app_state.audit) if r.get("actor") == "overview"}
    assert {k: _kind(v) for k, v in rows.items()} == {
        ActionType.PROMPT.value: ("agent", "success"),
        ActionType.ERROR.value: ("agent", outcome),
    }
    error_row = rows[ActionType.ERROR.value]
    assert error_row["result_summary"].startswith("overview model unavailable: ")
    assert error_row["result_summary"].endswith("; the deterministic overview was used")
    _assert_no_secret(error_row["result_summary"])
    assert matches(build_predicate(AuditFilters(outcome=outcome)), error_row)


# --------------------------------------------------------------------------- #
# The chat assistant
# --------------------------------------------------------------------------- #
def test_every_chat_tool_status_maps_to_an_audit_outcome() -> None:
    assert {s: tool_audit_outcome(s) for s in ("ok", "error", "timeout", "denied", "skipped", "cancelled")} == {
        "ok": "success", "error": "failure", "timeout": "failure",
        "denied": "denied", "skipped": "denied", "cancelled": "unknown",
    }
    # A status the table does not know is never stored as a success.
    assert tool_audit_outcome("exploded") == "failure" and tool_audit_outcome(None) == "failure"
    assert all(tool_audit_outcome(s) in AUDIT_OUTCOMES for s in ("ok", "error", "skipped", "x"))


@pytest.fixture
def _probe_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    from tests.test_chat_tools_registry import _BoomTool, _EchoTool, _SlowTool

    monkeypatch.setattr(registry, "_CATALOGUE", registry.catalogue() + (_SlowTool(), _BoomTool(), _EchoTool()))


@pytest.mark.usefixtures("_probe_tools")
async def test_a_chat_tool_call_row_is_an_agent_row_whose_outcome_is_the_call() -> None:
    audit = RecordingAudit()
    box = build_toolbox(make_ctx(audit=audit))
    await box.execute("echo_probe", {"x": "v"}, turn_id="turn-1", step=1, ordinal=1)
    await box.execute("boom_probe", {}, turn_id="turn-1", step=2, ordinal=2)
    await box.execute("slow_probe", {}, turn_id="turn-1", step=3, ordinal=3, timeout_s=0.05)
    await box.execute("echo_probe", {"ctx": "evil"}, turn_id="turn-1", step=4, ordinal=4)
    assert [(r["tool_name"], r["actor_type"], r["outcome"]) for r in audit.calls] == [
        ("echo_probe", "agent", "success"),
        ("boom_probe", "agent", "failure"),     # the tool raised
        ("slow_probe", "agent", "failure"),     # the lookup timed out
        ("echo_probe", "agent", "failure"),     # refused input names
    ]
    assert all(r["actor"] == "alice" for r in audit.calls)
    errored = {**audit.calls[1], "action_type": _value(audit.calls[1]["action_type"])}
    assert matches(_FAILED, errored) and matches(_AGENT, errored)


async def test_a_chat_tool_denial_is_a_denied_access_row() -> None:
    control = RecordingAudit()
    assert await record_chat_tool_denial(control, actor="alice", tool_name="audit_search",
                                         missing=["audit:view"], turn_id="turn-9", step=3)
    (row,) = control.calls
    assert row["action_type"] == ActionType.ACCESS_DENIED and _kind(row) == ("human", "denied")
    assert matches(_PEOPLE, {**row, "action_type": _value(row["action_type"])})


@pytest.fixture
def _turn_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(registry, "_CATALOGUE", FAKE_TOOLS)
    IndicatorTool.dispatched = []


@pytest.mark.usefixtures("_turn_tools")
async def test_a_chat_turn_writes_agent_rows_and_a_refused_lookup_reads_denied() -> None:
    """The engine refuses a lookup of a private address before dispatch (#9): its
    TOOL_CALL row reads ``denied``; the model calls are ``success``."""
    audit, control = _Recorder(), _Recorder()
    gateway = FakeGateway([tool_call("lookup_indicator", indicator="10.20.3.4"), final()])
    prefs = make_prefs()
    _, resp, _ = await run_turn(make_engine(gateway), "Is 10.20.3.4 doing anything weird?", prefs,
                                make_turn_ctx(prefs, audit=audit, control=control), turn_id="turn-r")
    assert next(s for s in resp.steps if s.tool == "lookup_indicator").status == "denied"
    assert IndicatorTool.dispatched == []
    prompts = [r for r in audit.rows if r["action_type"] == ActionType.PROMPT]
    assert prompts and all(_kind(r) == ("agent", "success") for r in prompts)
    (refused,) = [r for r in audit.rows if r["action_type"] == ActionType.TOOL_CALL]
    assert refused["tool_name"] == "lookup_indicator" and _kind(refused) == ("agent", "denied")
    assert all(r.get("outcome") in AUDIT_OUTCOMES and r.get("actor_type") in AUDIT_ACTOR_TYPES
               for r in audit.rows)


@pytest.mark.usefixtures("_turn_tools")
@pytest.mark.parametrize("limits_mode", ["bounded", "unlimited"])
@pytest.mark.parametrize(
    ("error", "outcome", "wording"),
    [
        (GatewayError(f"provider down: {_SECRET_TEXT}"), "failure", "failed (GatewayError)"),
        (BudgetBlocked("budget ceiling exceeded: daily"), "denied", "refused (budget ceiling exceeded)"),
    ],
    ids=["provider-failure", "refused"],
)
async def test_a_chat_model_call_that_does_not_answer_writes_an_error_row(
    limits_mode: str, error: Exception, outcome: str, wording: str,
) -> None:
    """The step's PROMPT row was written before the call; the call that failed (or was
    refused) adds one ERROR row, listed under Failed (or Denied). Its wording is our
    own: a chat row never stores the provider's exception text."""
    audit, control = _Recorder(), _Recorder()
    prefs = make_prefs(limits_mode=limits_mode)
    _, _resp, outcome_ = await run_turn(make_engine(FakeGateway([error])), "hello", prefs,
                                        make_turn_ctx(prefs, audit=audit, control=control), turn_id="turn-f")
    assert outcome_.first_call_failed
    of = " of 5" if limits_mode == "bounded" else ""
    assert [(r["action_type"], _kind(r), r.get("result_summary")) for r in audit.rows] == [
        (ActionType.PROMPT, ("agent", "success"), f"turn=turn-f step=1 model call 1{of}"),
        (ActionType.ERROR, ("agent", outcome), f"turn=turn-f step=1 model call 1 {wording}"),
    ]
    stored = {**audit.rows[1], "action_type": ActionType.ERROR.value}
    assert matches(build_predicate(AuditFilters(outcome=outcome)), stored) and matches(_AGENT, stored)
    assert control.rows == []


@pytest.mark.usefixtures("_turn_tools")
async def test_a_chat_model_call_refused_by_the_chat_daily_cap_reads_denied() -> None:
    from tests.test_chat_budget_exemption import CapGate

    audit = _Recorder()
    prefs = make_prefs(chat_daily_cap_usd=5.0)
    gateway = FakeGateway([final("never")])
    _, resp, _ = await run_turn(make_engine(gateway), "hello", prefs,
                                make_turn_ctx(prefs, audit=audit, budget_gate=CapGate(spent=5.0)),
                                turn_id="turn-cap")
    assert gateway.calls == [] and resp.notice is not None and resp.notice.kind == "budget"
    assert [(r["action_type"], r["outcome"], r["result_summary"]) for r in audit.rows] == [
        (ActionType.PROMPT, "success", "turn=turn-cap step=1 model call 1 of 5"),
        (ActionType.ERROR, "denied", "turn=turn-cap step=1 model call 1 refused (chat daily limit)"),
    ]


@pytest.mark.usefixtures("_turn_tools")
async def test_a_stalled_chat_model_call_reads_failure_for_each_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unlimited chat retries a stalled call once: each attempt is its own PROMPT and
    ERROR pair, so the audit log shows both."""
    import asyncio

    audit = _Recorder()
    prefs = make_prefs(limits_mode="unlimited", model_step_timeout_s=0.05)
    gateway = FakeGateway([final("never"), final("never")], delay=1.0)
    _, resp, _ = await run_turn(make_engine(gateway), "hello", prefs,
                                make_turn_ctx(prefs, audit=audit), turn_id="turn-s")
    await asyncio.sleep(0)
    assert [s.status for s in resp.steps if s.kind == "model"] == ["timeout", "timeout"]
    assert [(r["action_type"], r["outcome"], r["result_summary"]) for r in audit.rows] == [
        (ActionType.PROMPT, "success", "turn=turn-s step=1 model call 1"),
        (ActionType.ERROR, "failure", "turn=turn-s step=1 model call 1 timed out"),
        (ActionType.PROMPT, "success", "turn=turn-s step=2 model call 2"),
        (ActionType.ERROR, "failure", "turn=turn-s step=2 model call 2 timed out"),
    ]


@pytest.mark.usefixtures("_turn_tools")
async def test_stop_is_not_a_failed_chat_model_call() -> None:
    """Pressing Stop abandons the call: the analyst's choice, not a failure, so no
    ERROR row is written."""
    import asyncio

    audit = _Recorder()
    cancel = asyncio.Event()
    prefs = make_prefs(limits_mode="unlimited")

    async def _press() -> None:
        await asyncio.sleep(0.1)
        cancel.set()

    presser = asyncio.ensure_future(_press())
    _, resp, outcome = await run_turn(make_engine(FakeGateway([final("never")], delay=5)), "hello", prefs,
                                      make_turn_ctx(prefs, audit=audit), cancel=cancel, turn_id="turn-x")
    await presser
    assert outcome.cancelled and [s.status for s in resp.steps if s.kind == "model"] == ["cancelled"]
    assert [(r["action_type"], r["outcome"]) for r in audit.rows] == [(ActionType.PROMPT, "success")]


@pytest.mark.usefixtures("_turn_tools")
async def test_a_failed_compaction_call_writes_an_error_row() -> None:
    from app.agents.chat_protocol import PriorExchange

    audit = _Recorder()
    prefs = make_prefs(limits_mode="unlimited")
    gateway = FakeGateway([GatewayError(f"provider down: {_SECRET_TEXT}")])
    exchanges = [PriorExchange(user=f"question {i}", answer=f"Answer {i}.", message_id=f"msg-{i}")
                 for i in (1, 2, 3)]
    _, resp, outcome = await run_turn(make_engine(gateway), "/compact", prefs, make_turn_ctx(prefs, audit=audit),
                                      prior_exchanges=exchanges, conversation_id="conv-1", turn_id="turn-c")
    # The extractive summary keeps the turn going.
    assert outcome.summary_text
    assert [(r["action_type"], r["outcome"], r["result_summary"]) for r in audit.rows] == [
        (ActionType.PROMPT, "success", "turn=turn-c step=1 compaction: summarising 3 earlier exchange(s)"),
        (ActionType.ERROR, "failure",
         "turn=turn-c step=1 compaction model call failed (GatewayError); the extractive summary was used"),
    ]


def test_every_row_of_the_chat_turn_names_its_outcome() -> None:
    """``_AgentTurn._audit`` takes ``outcome`` as a required keyword: a new row of the
    turn cannot be written without naming how it ended."""
    from app.agents.chat import _AgentTurn

    param = inspect.signature(_AgentTurn._audit).parameters["outcome"]  # noqa: SLF001
    assert param.kind is inspect.Parameter.KEYWORD_ONLY and param.default is inspect.Parameter.empty


async def test_the_compatibility_chat_rows_name_their_outcome(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    async def _failed(self: EsQueryTool, **_kwargs: Any) -> ToolResult:
        return ToolResult(ok=False, error="index missing", summary="es_query error: index missing")

    monkeypatch.setattr(EsQueryTool, "run", _failed)
    mock_provider.push("chat", json.dumps({"answer": "Looking.", "needs_query": True, "query": {"ip": "10.0.0.9"}}))
    await app_state.chat_engine.chat("show 10.0.0.9", app_state.prefs, case_id="case-legacy-chat")
    rows = [r for r in await _rows(app_state.audit) if r.get("case_id") == "case-legacy-chat"]
    assert sorted((r["action_type"], _kind(r)) for r in rows) == [
        (ActionType.ES_QUERY.value, ("agent", "failure")),
        (ActionType.PROMPT.value, ("agent", "success")),
    ]


@_MODEL_FAILURES
async def test_a_compatibility_chat_model_failure_writes_an_error_row(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch, error: Exception, outcome: str,
) -> None:
    monkeypatch.setattr(app_state.chat_engine, "_gateway", _Raising(error))
    resp = await app_state.chat_engine.chat("show 10.0.0.9", app_state.prefs, case_id="case-legacy-down")
    assert resp.answer.startswith("The assistant is unavailable")
    rows = {r["action_type"]: r for r in await _rows(app_state.audit) if r.get("case_id") == "case-legacy-down"}
    assert {k: _kind(v) for k, v in rows.items()} == {
        ActionType.PROMPT.value: ("agent", "success"),
        ActionType.ERROR.value: ("agent", outcome),
    }
    # Our own wording: a chat row never stores the provider's exception text.
    wording = "refused (budget ceiling exceeded)" if outcome == "denied" else "failed (GatewayError)"
    assert rows[ActionType.ERROR.value]["result_summary"] == (
        f"chat model call {wording}; the assistant answered that it is unavailable")


# --------------------------------------------------------------------------- #
# The formatter, the investigator and the pipeline
# --------------------------------------------------------------------------- #
@_MODEL_FAILURES
async def test_a_formatter_model_failure_writes_one_redacted_error_row(error: Exception, outcome: str) -> None:
    audit = _Recorder()
    draft = VerdictResult(verdict=Verdict.TRUE_POSITIVE, confidence=0.9, recommended_action="block")
    verdict, cost = await Formatter(_Raising(error), audit).format(  # type: ignore[arg-type]
        draft, "reasoning", Preferences(), surface="investigate", case_id="case-fmt",
    )
    # The investigator's draft stands; the case path goes on.
    assert verdict == draft and cost == 0.0
    (row,) = audit.rows
    assert row["action_type"] == ActionType.ERROR and row["actor"] == Role.FORMATTER.value
    assert row["case_id"] == "case-fmt" and row["outcome"] == outcome
    assert row["result_summary"].startswith("formatter unavailable: ")
    assert row["result_summary"].endswith("; the investigator's draft verdict was kept")
    _assert_no_secret(row["result_summary"])
    assert len(row["result_summary"]) <= 1000


async def test_a_formatter_failure_inside_an_investigation_carries_the_run_id(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = app_state.pipeline._gateway  # noqa: SLF001
    real_complete = gateway.complete

    async def _complete(role: Role, *args: Any, **kwargs: Any) -> Any:
        if role == Role.FORMATTER:
            raise GatewayError(_SECRET_TEXT)
        return await real_complete(role, *args, **kwargs)

    monkeypatch.setattr(gateway, "complete", _complete)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.7.1"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    rows = [r for r in await _rows(app_state.audit) if r.get("case_id") == case.case_id]
    (error,) = [r for r in rows if r.get("actor") == "formatter" and r.get("action_type") == "error"]
    assert _kind(error) == ("agent", "failure") and str(error.get("run_id") or "").startswith("inv-")
    _assert_no_secret(error["result_summary"])
    # The investigator's verdict was kept.
    assert case.verdict == Verdict.TRUE_POSITIVE


async def test_an_investigator_model_error_never_puts_a_credential_in_the_case(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = app_state.pipeline._gateway  # noqa: SLF001
    monkeypatch.setattr(gateway, "complete", _investigator_raising(gateway, GatewayError(_SECRET_TEXT)))
    mock_provider.push("router", _escalate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.7.2"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.recommended_action.startswith("investigator model error: refused by ")
    _assert_no_secret(case.recommended_action)


async def test_an_investigator_crash_never_puts_a_credential_in_the_case(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = app_state.pipeline._gateway  # noqa: SLF001
    monkeypatch.setattr(gateway, "complete", _investigator_raising(gateway, RuntimeError(_SECRET_TEXT)))
    mock_provider.push("router", _escalate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.7.3"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    assert case.recommended_action.startswith("investigator error: refused by ")
    _assert_no_secret(case.recommended_action)


async def test_a_pipeline_failure_never_puts_a_credential_in_the_case_error(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"case store {_SECRET_TEXT}")

    monkeypatch.setattr(app_state.pipeline, "_allocate_case_number", _boom)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.7.4"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    assert case.status == CaseStatus.NEEDS_HUMAN and case.error.startswith("case store refused by ")
    _assert_no_secret(case.error)
    stored = await app_state.cases.get(case.case_id)
    assert stored is not None and stored.error == case.error


async def test_text_without_a_credential_reaches_the_case_unchanged(
    app_state: AppState, mock_provider: MockProvider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = app_state.pipeline._gateway  # noqa: SLF001
    monkeypatch.setattr(gateway, "complete", _investigator_raising(gateway, GatewayError("upstream 503")))
    mock_provider.push("router", _escalate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.7.5"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    assert case.recommended_action == "investigator model error: upstream 503"


# --------------------------------------------------------------------------- #
# One route row per router file
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def _routes() -> AsyncIterator[SimpleNamespace]:
    """The routers whose rows these tests read, auth off (the actor is the default)."""
    from app.api.routes import router as main_router
    from app.api.routes_cases_collab import router as collab_router
    from app.api.routes_chat import router as chat_router
    from app.api.routes_chat_library import router as chat_library_router
    from app.api.routes_replay import router as replay_router
    from app.api.routes_reports import router as reports_router
    from app.api.routes_storage import router as storage_router

    mock = MockProvider()
    state = AppState.create(
        secrets=Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                        anthropic_api_key=None, openai_api_key=None),
        es=InMemoryESClient(), provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
    )
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    api = FastAPI()
    api.state.tlsoc = state
    api.include_router(main_router)
    mount_moved_routers(api)
    for router in (collab_router, chat_router, chat_library_router, replay_router, reports_router,
                   storage_router):
        api.include_router(router)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api), base_url="http://test") as client:
            yield SimpleNamespace(client=client, state=state, mock=mock)
    finally:
        await state.shutdown()


def _one(rows: list[dict[str, Any]], *, prefix: str = "", **where: Any) -> dict[str, Any]:
    """The one row whose fields equal ``where`` and whose summary starts with
    ``prefix``."""
    found = [r for r in rows
             if str(r.get("result_summary") or "").startswith(prefix)
             and all(r.get(k) == v for k, v in where.items())]
    assert len(found) == 1, (prefix, where, found)
    return found[0]


async def test_case_collaboration_rows() -> None:
    async with _routes() as h:
        await h.state.cases.save(_case("case-collab"))
        await h.state.users.save(User(username="bob", role="analyst_tier1"))
        posted = await h.client.post("/api/cases/case-collab/thread", json={"body": "look @bob"})
        assert posted.status_code == 200, posted.text
        labelled = await h.client.post("/api/cases/case-collab/thread",
                                       json={"body": "AI summary", "author_type": "ai"})
        assert labelled.status_code == 200, labelled.text
        rows = [r for r in await _rows(h.state.audit) if r.get("case_id") == "case-collab"]
        human = _one(rows, prefix="thread post (human) mentions=1")
        assert _kind(human) == ("human", "success") and matches(_PEOPLE, human)
        # With no person signed in, an AI-labelled post is the agent's.
        ai = _one(rows, prefix="thread post (ai)")
        assert ai["actor"] == "ai" and _kind(ai) == ("agent", "success")
        # The mention's delivery is the system's, as the notification service's sends are.
        mention = _one(rows, prefix="mention -> bob")
        assert _kind(mention) == ("system", "success") and matches(_AGENT, mention)
        task = await h.client.post("/api/cases/case-collab/tasks", json={"title": "Check the host"})
        assert task.status_code == 200, task.text
        rows = [r for r in await _rows(h.state.audit) if r.get("case_id") == "case-collab"]
        assert _kind(_one(rows, prefix="task add: ")) == ("human", "success")


async def test_a_signed_in_person_named_like_an_actor_kind_is_still_a_person(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Usernames are free text, so a person may be called ``ai`` or ``system``. Their
    post is theirs: the actor kind comes from the principal, never from the name."""
    from app.api import routes_cases_collab as collab
    from app.api.routes_cases_collab import _post_actor_type

    assert [_post_actor_type(t, True) for t in ("ai", "system", "human")] == ["human"] * 3
    assert [_post_actor_type(t, False) for t in ("ai", "system", "human")] == ["agent", "system", "human"]

    async with _routes() as h:
        await h.state.cases.save(_case("case-named-ai"))
        for name in ("ai", "system"):
            monkeypatch.setattr(collab, "current_username", lambda _request, _name=name: _name)
            posted = await h.client.post("/api/cases/case-named-ai/thread",
                                         json={"body": f"from {name}", "author_type": name})
            assert posted.status_code == 200, posted.text
        rows = [r for r in await _rows(h.state.audit) if r.get("case_id") == "case-named-ai"]
        for name in ("ai", "system"):
            row = _one(rows, prefix=f"thread post ({name})")
            assert row["actor"] == name and _kind(row) == ("human", "success") and matches(_PEOPLE, row)


async def test_chat_route_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.api.routes_chat import _effective_prefs

    async with _routes() as h:
        monkeypatch.setattr(h.state.chat_turns, "request_stop", lambda *_args, **_kwargs: True)
        stopped = await h.client.post("/api/chat/turns/turn-stop-1/cancel")
        assert stopped.status_code == 200, stopped.text
        row = _one(await _rows(h.state.execution_audit), prefix="turn=turn-stop-1 stop requested")
        # The person pressed Stop.
        assert _kind(row) == ("human", "success")

        app = FastAPI()
        app.state.tlsoc = h.state
        request = Request({"type": "http", "method": "POST", "path": "/api/chat", "headers": [],
                           "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})
        with pytest.raises(HTTPException) as refused:
            await _effective_prefs(h.state, request, ChatRequest(message="x", model="claude-opus-4-8"),
                                   frozenset({("cases", "read")}))
        assert refused.value.status_code == 403
        row = _one(await _rows(h.state.control_audit), prefix="denied a non-default chat model")
        assert _kind(row) == ("human", "denied")


async def test_chat_feedback_and_prompt_library_rows() -> None:
    from tests.test_reports_routes import seed_answer

    async with _routes() as h:
        conversation_id, message_id = await seed_answer(h.state)
        rated = await h.client.post("/api/chat/feedback", json={
            "conversation_id": conversation_id, "message_id": message_id, "rating": "up"})
        assert rated.status_code == 204, rated.text
        row = _one(await _rows(h.state.audit), prefix="chat answer rated up")
        assert _kind(row) == ("human", "success")

        saved = await h.client.put("/api/prefs/user", json={
            "chat_prompts": [{"id": "p1", "title": "Top talkers", "text": "Top source IPs today"}]})
        assert saved.status_code == 200, saved.text
        row = _one(await _rows(h.state.control_audit), prefix="chat prompt library updated")
        assert _kind(row) == ("human", "success")


async def test_replay_and_storage_rows() -> None:
    async with _routes() as h:
        purged = await h.client.delete("/api/replay/fixtures")
        assert purged.status_code == 200, purged.text
        row = _one(await _rows(h.state.control_audit), prefix="cleared ", action_type=ActionType.JOB.value)
        assert row["result_summary"].endswith(" replay fixtures") and _kind(row) == ("human", "success")

        policy = h.state.prefs.storage_lifecycle.model_dump(mode="json")
        saved = await h.client.put("/api/storage/lifecycle", json=policy)
        assert saved.status_code == 200, saved.text
        row = _one(await _rows(h.state.control_audit), prefix="saved own-state lifecycle policy")
        assert _kind(row) == ("human", "success")


async def test_report_rows_name_their_outcome() -> None:
    from tests.test_reports_routes import _report_with_item, summary_reply

    async with _routes() as h:
        created = await h.client.post("/api/reports", json={"title": "Shift"})
        assert created.status_code in (200, 201), created.text
        report = await _report_with_item(h)
        h.mock.push("chat", summary_reply())
        assert (await h.client.post(f"/api/reports/{report['id']}/summary", json={})).status_code == 200

        gateway = h.state.chat_engine._gateway  # noqa: SLF001
        real_complete = gateway.complete

        async def _blocked(*_args: Any, **_kwargs: Any) -> Any:
            raise BudgetBlocked("budget ceiling exceeded: daily")

        async def _broken(*_args: Any, **_kwargs: Any) -> Any:
            raise GatewayError("upstream exploded")

        for failing in (_blocked, _broken):
            gateway.complete = failing  # type: ignore[method-assign]
            assert (await h.client.post(f"/api/reports/{report['id']}/summary", json={})).status_code == 503
        gateway.complete = real_complete  # type: ignore[method-assign]

        rows = [r for r in await _rows(h.state.audit) if r.get("surface") == "report"]
        created_rows = [r for r in rows if r["result_summary"].startswith("report created: ")]
        assert len(created_rows) == 2 and all(_kind(r) == ("human", "success") for r in created_rows)
        assert _kind(_one(rows, prefix="report item added: ")) == ("human", "success")
        assert _kind(_one(rows, prefix="report summary generated: ")) == ("human", "success")
        # The summary's model call was the agent's.
        prompt = _one(rows, action_type=ActionType.PROMPT.value)
        assert _kind(prompt) == ("agent", "success") and matches(_AGENT, prompt)
        failed = sorted(_kind(r) for r in rows if "report summary failed" in r["result_summary"])
        assert failed == [("human", "denied"), ("human", "failure")]


async def test_rag_route_rows() -> None:
    async with _routes() as h:
        imported = await h.client.post("/api/rag/import", json={"title": "Note", "text": "A runbook note."})
        assert imported.status_code == 200, imported.text
        document_id = imported.json()["document_id"]
        deleted = await h.client.delete(f"/api/rag/documents/{document_id}")
        assert deleted.status_code == 200, deleted.text
        row = _one(await _rows(h.state.audit), surface="rag_document_delete")
        assert _kind(row) == ("human", "success")

        repaired = await h.client.post("/api/rag/precedent/repair", json={"dry_run": False})
        assert repaired.status_code == 200, repaired.text
        assert repaired.json()["complete"] is True
        row = _one(await _rows(h.state.audit), surface="rag_precedent_repair", tool_name="precedent_repair")
        # A clean run over an empty corpus finished: the person's action succeeded.
        assert _kind(row) == ("human", "success")


def test_a_batch_outcome_follows_what_went_through() -> None:
    assert batch_audit_outcome(done=3, failed=0) == "success"
    assert batch_audit_outcome(done=0, failed=0) == "success"   # a dry run, an empty batch
    assert batch_audit_outcome(done=2, failed=1) == "partial"
    assert batch_audit_outcome(done=0, failed=2) == "failure"


def test_every_repair_refusal_code_is_a_guard_or_a_fault() -> None:
    """A new refusal code must be placed: under Denied (a guard) or Failed (a fault)."""
    from app.api.routes_rag import REPAIR_FAULT_REFUSALS, REPAIR_GUARD_REFUSALS
    from app.tools import rag as rag_module

    codes = {v for k, v in vars(rag_module).items() if k.startswith("REPAIR_REFUSAL_")}
    assert codes == REPAIR_GUARD_REFUSALS | REPAIR_FAULT_REFUSALS
    assert not REPAIR_GUARD_REFUSALS & REPAIR_FAULT_REFUSALS
    for code in REPAIR_GUARD_REFUSALS:
        assert repair_audit_outcome({"ok": False, "refused": True, "reason_code": code}) == "denied"
    for code in REPAIR_FAULT_REFUSALS:
        assert repair_audit_outcome({"ok": False, "refused": True, "reason_code": code}) == "failure"


class TestRepairOutcomeFromRealRuns:
    """``repair_audit_outcome`` over the reports ``repair_precedent_projection``
    really returns, driven through the scenarios of
    ``test_precedent_corpus_repair.py``."""

    @staticmethod
    async def _seeded(state: AppState, *case_ids: str) -> None:
        from tests.test_precedent_corpus_repair import _enable_precedent, _seed_one

        _enable_precedent(state)
        for case_id in case_ids:
            await _seed_one(state, case_id)

    @staticmethod
    def _missing(state: AppState, *gone: str) -> None:
        real_get = state.rag._cases.get  # noqa: SLF001

        async def _get(case_id: str) -> Any:
            return None if case_id in gone else await real_get(case_id)

        state.rag._cases.get = _get  # type: ignore[assignment]  # noqa: SLF001

    @staticmethod
    async def _record(_payload: dict[str, Any]) -> None:
        return None

    async def test_a_clean_run_and_a_verified_repair_succeed(self, app_state: AppState) -> None:
        from tests.test_precedent_corpus_repair import _STALE_TEXT, _overwrite_text

        await self._seeded(app_state, "out-clean")
        report = await app_state.rag.repair_precedent_projection(dry_run=False)
        assert report["complete"] is True and repair_audit_outcome(report) == "success"
        await _overwrite_text(app_state, "out-clean", _STALE_TEXT)
        report = await app_state.rag.repair_precedent_projection(dry_run=False)
        assert report["repaired"] == 1 and repair_audit_outcome(report) == "success"

    async def test_an_unreadable_case_stops_the_run_short(self, app_state: AppState) -> None:
        await self._seeded(app_state, "out-undetermined")

        async def _boom(_case_id: str) -> Any:
            raise RuntimeError("case store unavailable")

        app_state.rag._cases.get = _boom  # type: ignore[assignment]  # noqa: SLF001
        report = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=self._record)
        assert report["undetermined"] == 1 and report["mutated"] == 0 and not report["refused"]
        # Nothing it attempted failed: it could only not check everything.
        assert repair_audit_outcome(report) == "partial"

    async def test_a_truncated_read_with_nothing_stale_is_partial(
        self, app_state: AppState, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.tools import rag as rag_module
        from app.tools.vectorstore import ESVectorStore
        from tests.test_precedent_corpus_repair import _enable_precedent, _seed_one

        _enable_precedent(app_state)
        app_state.rag._store = ESVectorStore(app_state.es)  # noqa: SLF001
        app_state.rag._seeded = False  # noqa: SLF001
        await _seed_one(app_state, "out-trunc")
        monkeypatch.setattr(rag_module, "_CORPUS_SCAN_TRUNCATION_HINT", 1)
        report = await app_state.rag.repair_precedent_projection(dry_run=False)
        assert report["truncated"] is True and report["stale"] == 0 and report["mutated"] == 0
        assert repair_audit_outcome(report) == "partial"

    async def test_a_repair_the_read_back_cannot_show_is_a_failure(self, app_state: AppState) -> None:
        from app.tools.vectorstore import StoredChunk
        from tests.test_precedent_corpus_repair import _STALE_TEXT, _overwrite_text

        await self._seeded(app_state, "out-unverified")
        await _overwrite_text(app_state, "out-unverified", _STALE_TEXT)
        store = app_state.rag._store  # noqa: SLF001
        real_add = store.add

        async def _drops(_chunks: list[StoredChunk]) -> None:
            return None

        store.add = _drops  # type: ignore[assignment]
        report = await app_state.rag.repair_precedent_projection(dry_run=False)
        store.add = real_add  # type: ignore[assignment]
        assert report["unverified_repairs"] and report["mutated"] == 0 and not report["refused"]
        # The repair counts it outstanding, never repaired: nothing it set out to do landed.
        assert repair_audit_outcome(report) == "failure"

    async def test_every_eviction_that_did_not_land_is_a_failure(self, app_state: AppState) -> None:
        await self._seeded(app_state, "out-stuck-0", "out-stuck-1", "out-stuck-2")
        self._missing(app_state, "out-stuck-0")

        async def _no_op(_document_id: str) -> int:
            return 1

        app_state.rag._store.delete_document = _no_op  # type: ignore[assignment]  # noqa: SLF001
        report = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=self._record)
        assert report["incomplete_evictions"] and report["mutated"] == 0
        assert repair_audit_outcome(report) == "failure"

    async def test_an_eviction_whose_payload_was_not_recorded_is_a_failure(self, app_state: AppState) -> None:
        await self._seeded(app_state, "out-norec-0", "out-norec-1")
        self._missing(app_state, "out-norec-0")

        async def _fails(_payload: dict[str, Any]) -> None:
            raise RuntimeError("the audit trail is unavailable")

        report = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=_fails)
        assert report["evictions_unrecorded"] == 1 and report["mutated"] == 0
        assert repair_audit_outcome(report) == "failure"

    async def test_a_verified_change_beside_a_failed_one_is_partial(self, app_state: AppState) -> None:
        from tests.test_precedent_corpus_repair import _STALE_TEXT, _overwrite_text

        await self._seeded(app_state, "out-mix-0", "out-mix-1", "out-mix-2")
        await _overwrite_text(app_state, "out-mix-1", _STALE_TEXT)
        self._missing(app_state, "out-mix-0")

        async def _no_op(_document_id: str) -> int:
            return 1

        app_state.rag._store.delete_document = _no_op  # type: ignore[assignment]  # noqa: SLF001
        report = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=self._record)
        assert report["repaired"] == 1 and report["incomplete_evictions"]
        assert repair_audit_outcome(report) == "partial"

    async def test_a_safety_guard_refusal_is_denied(self, app_state: AppState) -> None:
        await self._seeded(app_state, *(f"out-mass-{i}" for i in range(4)))
        self._missing(app_state, *(f"out-mass-{i}" for i in range(4)))
        report = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=self._record)
        assert report["refused"] is True and report["reason_code"] == "repair_tier_emptied"
        assert repair_audit_outcome(report) == "denied"

    async def test_an_unreadable_corpus_is_a_failure_not_a_denial(self, app_state: AppState) -> None:
        await self._seeded(app_state, "out-unreadable")

        async def _boom() -> list[Any]:
            raise RuntimeError("store unavailable")

        app_state.rag._store.list_all_chunks = _boom  # type: ignore[assignment]  # noqa: SLF001
        report = await app_state.rag.repair_precedent_projection(dry_run=False)
        assert report["refused"] is True and report["reason_code"] == "repair_corpus_unreadable"
        assert repair_audit_outcome(report) == "failure"

    async def test_a_degraded_embedding_provider_is_a_failure(self, app_state: AppState) -> None:
        from app.llm.gateway import EmbeddingBatch
        from tests.test_precedent_corpus_repair import _STALE_TEXT, _overwrite_text

        await self._seeded(app_state, "out-degraded")
        await _overwrite_text(app_state, "out-degraded", _STALE_TEXT)

        async def _degraded(texts: Any, *_args: Any, **_kwargs: Any) -> EmbeddingBatch:
            return EmbeddingBatch(vectors=[[0.5, 0.5, 0.5] for _ in texts], model="local-hash",
                                  provider="local", fallback=True, fallback_reason="provider_error")

        app_state.rag._gateway.embed_with_provenance = _degraded  # type: ignore[assignment]  # noqa: SLF001
        report = await app_state.rag.repair_precedent_projection(dry_run=False)
        assert report["refused"] is True and report["reason_code"] == "repair_embedding_degraded"
        assert repair_audit_outcome(report) == "failure"


class TestAnEvictionTheReReadStillFinds:
    """An eviction's payload row is written BEFORE the delete (no record, no removal),
    so on its own it would say the chunk was evicted while the re-read still finds it
    in the corpus. The repair route follows it with one failure row, under the same
    case, listed under the audit log's Failed filter."""

    @staticmethod
    async def _repair(app_state: AppState, *case_ids: str, gone: str, delete_lands: bool) -> list[dict[str, Any]]:
        from tests.test_precedent_corpus_repair import _api

        await TestRepairOutcomeFromRealRuns._seeded(app_state, *case_ids)
        TestRepairOutcomeFromRealRuns._missing(app_state, gone)
        if not delete_lands:
            async def _no_op(_document_id: str) -> int:
                return 1  # claims success, removes nothing

            app_state.rag._store.delete_document = _no_op  # type: ignore[assignment]  # noqa: SLF001
        with _api(app_state) as client:
            out = client.post("/api/rag/precedent/repair", json={"dry_run": False})
            assert out.status_code == 200, out.text
            report = out.json()
        assert report["incomplete_evictions"] == ([] if delete_lands else [f"resolved_case:{gone}"])
        assert report["evicted"] == (1 if delete_lands else 0)
        # Oldest first, as written.
        return list(reversed(await app_state.audit.records(surface="rag_precedent_repair", limit=50)))

    async def test_it_writes_a_failure_row_after_the_payload_row(self, app_state: AppState) -> None:
        rows = await self._repair(app_state, "land-0", "land-1", "land-2", gone="land-0", delete_lands=False)
        assert [r.get("tool_name") for r in rows] == [
            "precedent_evicted_chunk", "precedent_eviction_incomplete", "precedent_repair",
        ]
        payload, failed, summary = rows
        assert _kind(payload) == ("human", "success")
        assert _kind(failed) == ("human", "failure")
        assert matches(_FAILED, failed) and matches(_PEOPLE, failed)
        assert failed["case_id"] == payload["case_id"] == "land-0"
        assert failed["action_type"] == ActionType.CONTEXT.value
        assert failed["tool_input"] == {"document_id": "resolved_case:land-0"}
        assert failed["result_summary"] == (
            "eviction did not land document_id=resolved_case:land-0: the chunk is still "
            "in the corpus ground_truth_unchanged=true"
        )
        # Document ids only: the payload row stays the one place the chunk's text is.
        text = payload["tool_input"]["text"]
        assert text and text not in repr(failed) and text not in repr(summary)
        assert summary["outcome"] == "failure"

    async def test_an_eviction_that_landed_writes_no_failure_row(self, app_state: AppState) -> None:
        rows = await self._repair(app_state, "landed-0", "landed-1", gone="landed-0", delete_lands=True)
        assert [r.get("tool_name") for r in rows] == ["precedent_evicted_chunk", "precedent_repair"]
        assert [_kind(r) for r in rows] == [("human", "success"), ("human", "success")]
        assert not [r for r in rows if matches(_FAILED, r)]

    async def test_a_failure_row_that_cannot_be_written_never_hides_the_summary(
        self, app_state: AppState, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        real_record = app_state.audit.record

        async def _record(**fields: Any) -> None:
            if fields.get("tool_name") == "precedent_eviction_incomplete":
                raise RuntimeError("the audit store is unavailable")
            await real_record(**fields)

        monkeypatch.setattr(app_state.audit, "record", _record)
        rows = await self._repair(app_state, "nolog-0", "nolog-1", "nolog-2", gone="nolog-0", delete_lands=False)
        assert [r.get("tool_name") for r in rows] == ["precedent_evicted_chunk", "precedent_repair"]
        assert rows[-1]["outcome"] == "failure"
        assert rows[-1]["tool_input"]["incomplete_evictions"] == ["resolved_case:nolog-0"]


async def test_an_rbac_denial_is_a_denied_human_row(app_state: AppState, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.api import deps

    async def _view(_request: Any) -> Any:
        return SimpleNamespace(allows=lambda *_a: False, user=SimpleNamespace(username="tier1"), role="analyst_tier1")

    monkeypatch.setattr(deps, "resolve_access", _view)
    app = FastAPI()
    app.state.tlsoc = app_state
    request = Request({"type": "http", "method": "GET", "path": "/api/audit", "headers": [],
                       "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})
    with pytest.raises(HTTPException) as denied:
        await deps._enforce(request, "audit", "view")  # noqa: SLF001
    assert denied.value.status_code == 403
    row = _one(await _rows(app_state.control_audit), prefix="denied audit:view for role analyst_tier1")
    assert row["actor"] == "tier1" and _kind(row) == ("human", "denied")
    assert matches(_PEOPLE, row)


# --------------------------------------------------------------------------- #
# The guard
# --------------------------------------------------------------------------- #
_APP = Path(__file__).resolve().parents[1] / "app"

#: The calls an audit row is written through: the store's two entry points and the
#: chat turn's one writer (``_AgentTurn._audit``).
_WRITERS = frozenset({"record", "record_strict", "_audit"})

#: Rows keyed by ``event_id`` and the legacy lazy ``session_register`` row, written
#: exactly as before Round 14: a keyed row's retry must reproduce its first write byte
#: for byte, and a first write made before Round 14 carries neither field (SPEC §11.3).
#: ``(path under app/, enclosing function): number of calls``.
_EXEMPT: dict[tuple[str, str], int] = {
    ("api/deps.py", "_audit_session"): 1,
    ("api/routes.py", "approve_proposal"): 1,
    ("api/routes.py", "_reject_one"): 1,
    ("engine/jobs.py", "JobRunner._storage_apply"): 2,
    ("engine/jobs.py", "JobRunner.reconcile_audits"): 1,
    ("engine/replay/job.py", "_audit_spend"): 1,
    ("engine/update_audit.py", "audit_terminal_job"): 1,
}

#: The investigation pipeline's writers: every call goes through ``self._audit``, the
#: pipeline's ``RunStampedAudit``, which stamps the outcome a writer leaves out.
_STAMPED: dict[str, str] = {
    "agents/pipeline.py": "InvestigationPipeline",
    "agents/router.py": "Router",
    "agents/investigator.py": "Investigator",
}


def _name(func: ast.expr) -> str | None:
    if isinstance(func, ast.Attribute):
        return func.attr
    return func.id if isinstance(func, ast.Name) else None


#: Writes whose every field arrives through a bare ``**mapping`` (no ``action_type``
#: keyword, so the scan cannot read the row), each with the producer that guarantees
#: the row its ``outcome``: ``(path under app/, enclosing function): producer``. Each
#: producer is pinned at runtime below (``test_the_splat_producers_supply_an_outcome``).
_SPLAT_PRODUCERS: dict[tuple[str, str], str] = {
    # The investigation pipeline's stamper: every row it forwards gains an outcome.
    ("agents/pipeline.py", "RunStampedAudit.record"): "RunStampedAudit._stamp",
    ("agents/pipeline.py", "RunStampedAudit.record_strict"): "RunStampedAudit._stamp",
    # The Demo seed writes the rows ``demo_runbook_audit_rows`` builds.
    ("engine/demo_generator.py", "seed_demo_runbook_runs"): "demo_runbook_audit_rows",
}


def _own_returns(function: ast.AST) -> list[ast.Return]:
    """The ``return`` statements of ``function`` itself, not of a function nested in it."""
    found: list[ast.Return] = []

    def walk(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                continue
            if isinstance(child, ast.Return):
                found.append(child)
            walk(child)

    walk(function)
    return found


def _returns_outcome(name: str, functions: dict[str, ast.AST], depth: int = 0) -> bool:
    """Whether every value the same-file function ``name`` returns is a mapping literal
    with an ``"outcome"`` key, directly or through another same-file function it returns
    the call of (``demo_evidence_audit_row`` returns ``_demo_audit_row(...)``). A helper
    with one branch that leaves the key out does not qualify."""
    helper = functions.get(name)
    if helper is None or depth > 3:
        return False
    values = [r.value for r in _own_returns(helper) if r.value is not None]
    if not values:
        return False
    for value in values:
        if isinstance(value, ast.Dict):
            if not any(isinstance(k, ast.Constant) and k.value == "outcome" for k in value.keys):
                return False
        elif isinstance(value, ast.Call):
            if not _returns_outcome(_name(value.func) or "", functions, depth + 1):
                return False
        else:
            return False
    return True


def _splat_supplies_outcome(call: ast.Call, functions: dict[str, ast.AST]) -> bool:
    """``**helper(...)`` whose call passes ``outcome``, or whose returned mappings all
    carry an ``"outcome"`` key (the export, update and Demo rows' field helpers), or a
    ``**{...}`` literal that names it."""
    for kw in call.keywords:
        if kw.arg is not None:
            continue
        if isinstance(kw.value, ast.Dict) and any(
            isinstance(k, ast.Constant) and k.value == "outcome" for k in kw.value.keys
        ):
            return True
        if not isinstance(kw.value, ast.Call):
            continue
        if any(inner.arg == "outcome" for inner in kw.value.keywords):
            return True
        if _returns_outcome(_name(kw.value.func) or "", functions):
            return True
    return False


def _unnamed_outcome_writers(root: Path = _APP) -> list[tuple[str, str, str, int, str]]:
    """``(path, enclosing function, call target, line, kind)`` of every audit write
    under ``root`` that may leave ``outcome`` out: ``kind`` is ``"named"`` for a call
    that passes ``action_type`` and no ``outcome``, and ``"splat"`` for one whose
    fields all arrive through a ``**`` mapping the scan cannot read (no
    ``action_type`` and no ``outcome`` keyword, and no field helper that supplies it)."""
    found: list[tuple[str, str, str, int, str]] = []
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        rel = path.relative_to(root).as_posix()
        functions = {n.name: n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

        def visit(node: ast.AST, scope: list[str]) -> None:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    visit(child, [*scope, child.name])
                    continue
                if isinstance(child, ast.Call) and _name(child.func) in _WRITERS:
                    names = {kw.arg for kw in child.keywords if kw.arg}
                    splat = any(kw.arg is None for kw in child.keywords)
                    kind = ("named" if "action_type" in names else "splat" if splat else "")
                    if (kind and "outcome" not in names
                            and not _splat_supplies_outcome(child, functions)):
                        target = ast.unparse(child.func.value) if isinstance(child.func, ast.Attribute) else ""
                        found.append((rel, ".".join(scope), target, child.lineno, kind))
                visit(child, scope)

        visit(tree, [])
    return found


def test_every_new_audit_row_names_its_outcome() -> None:
    """Outside the keyed rows and the pipeline's stamped logger, no audit write may
    leave ``outcome`` out: its row would read "Not recorded" in the audit log, a state
    the Help Center keeps for rows written before Round 14. A write whose fields all
    arrive through a ``**`` mapping must name the producer that supplies it."""
    exempt: Counter[tuple[str, str]] = Counter()
    splats: Counter[tuple[str, str]] = Counter()
    unexpected: list[str] = []
    for path, scope, target, line, kind in _unnamed_outcome_writers():
        if kind == "splat":
            if (path, scope) in _SPLAT_PRODUCERS:
                splats[(path, scope)] += 1
                continue
            unexpected.append(f"{path}:{line} {scope} {target} writes a ** mapping with no known outcome")
            continue
        owner = _STAMPED.get(path)
        if owner is not None and target == "self._audit" and scope.split(".")[0] == owner:
            continue
        if (path, scope) in _EXEMPT:
            exempt[(path, scope)] += 1
            continue
        unexpected.append(f"{path}:{line} {scope} {target} names no outcome")
    assert unexpected == [], "\n".join(unexpected)
    # Both lists stay exact: a keyed row that gains its fields, or a write that moves,
    # is taken off its list rather than silently kept.
    assert dict(exempt) == _EXEMPT
    assert set(splats) == set(_SPLAT_PRODUCERS) and set(splats.values()) == {1}


def test_the_splat_producers_supply_an_outcome() -> None:
    """The producers ``_SPLAT_PRODUCERS`` names, run: every row the Demo seed's two
    builders return and every row the pipeline's stamper forwards carries an outcome
    in the vocabulary."""
    from app.engine import demo_generator as gen
    from app.engine.demo_runtime import demo_builtin_catalog
    from app.models import RUNBOOK_SYSTEM_RUNNER, LookupResult
    from app.utils import now_utc, to_millis
    from tests.test_demo_runbooks import _seeded

    now_ms = to_millis(now_utc())
    cases = _seeded(1337, now_ms=now_ms)
    runs = gen.plan_demo_runbook_runs(cases, demo_builtin_catalog(), prefs=Preferences(), seed=1337,
                                      now_millis=now_ms)
    by_id = {c.case_id: c for c in cases}
    rows = [row for run in runs for row in gen.demo_runbook_audit_rows(run, by_id.get(run.case_id))]
    assert runs and rows
    lookup = LookupResult(tool="log_stats", status="ok", count=1, ran_at="2026-10-28T10:00:05Z",
                          ran_by=RUNBOOK_SYSTEM_RUNNER)
    rows.append(gen.demo_evidence_audit_row(runs[0], by_id.get(runs[0].case_id), "step", lookup))
    assert all(r.get("outcome") in AUDIT_OUTCOMES and r.get("actor_type") in AUDIT_ACTOR_TYPES for r in rows)

    for action_type in ActionType:
        stamped = RunStampedAudit._stamp({"action_type": action_type, "actor": "router"})  # noqa: SLF001
        assert stamped["outcome"] in AUDIT_OUTCOMES and stamped["actor_type"] in AUDIT_ACTOR_TYPES


def test_the_stamped_writers_only_run_with_the_pipelines_logger(app_state: AppState) -> None:
    """The exemption of the pipeline's own writers holds only while the router, the
    investigator and the formatter are built by the pipeline, with its stamped
    logger, and nowhere else."""
    builders: list[str] = []
    for path in sorted(_APP.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Call) and _name(node.func) in {"Router", "Investigator", "Formatter"}:
                builders.append(f"{path.relative_to(_APP).as_posix()}:{_name(node.func)}")
    assert sorted(set(builders)) == [
        "agents/pipeline.py:Formatter", "agents/pipeline.py:Investigator", "agents/pipeline.py:Router",
    ]
    pipeline = app_state.pipeline
    assert isinstance(pipeline._audit, RunStampedAudit)  # noqa: SLF001
    assert pipeline._router._audit is pipeline._audit  # noqa: SLF001


def test_the_guard_catches_a_writer_that_names_no_outcome(tmp_path: Path) -> None:
    """The scan itself: a plain row without ``outcome`` is found, one with it or with
    a field helper that supplies it in every branch is not; a row written through a
    bare ``**mapping``, or a helper with one branch that drops the key, is found."""
    module = tmp_path / "writers.py"
    module.write_text(
        "def _fields():\n"
        "    return {'outcome': 'success'}\n"
        "def _via():\n"
        "    return _fields()\n"
        "def _sometimes(flag):\n"
        "    unrelated = {'outcome': 'success'}\n"
        "    if flag:\n"
        "        return {'outcome': 'success', 'action_type': 'x'}\n"
        "    return {'action_type': 'x'}\n"
        "async def plain(audit):\n"
        "    await audit.record(action_type='x', result_summary='y')\n"
        "async def named(audit):\n"
        "    await audit.record(action_type='x', outcome='success')\n"
        "async def helper(audit):\n"
        "    await audit.record_strict(action_type='x', **_fields())\n"
        "async def chained(audit):\n"
        "    await audit.record_strict(**_via())\n"
        "async def literal(audit):\n"
        "    await audit.record_strict(**{'action_type': 'x', 'outcome': 'success'})\n"
        "async def bare(audit, fields):\n"
        "    await audit.record_strict(**fields)\n"
        "async def branchy(audit):\n"
        "    await audit.record(**_sometimes(True))\n",
        encoding="utf-8",
    )
    assert [(p, scope, kind) for p, scope, _t, _l, kind in _unnamed_outcome_writers(tmp_path)] == [
        ("writers.py", "plain", "named"),
        ("writers.py", "bare", "splat"),
        ("writers.py", "branchy", "splat"),
    ]
