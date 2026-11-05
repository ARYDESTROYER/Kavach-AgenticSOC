"""Every row the investigation pipeline and the engine write records how it ended.

Round 14 SPEC §4.5.3: ``outcome`` and ``actor_type`` are written by every writer of a
new row, so the audit log's Outcome column and its Failed filter work for Agent
activity, and §11.1: rows from ``case_manager``, ``analyst_policy`` and the poller are
system rows. These tests drive the real writers (an investigation through the
pipeline, ``Poller.poll_once``, ``IngestService.ingest``, threshold automation and
the tuner), never only the stamping wrapper, and check the stored rows. Old rows are
never rewritten (#2); ``decide()`` is not involved (#3).
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.agents.investigator import (
    GUIDANCE_FALLBACK,
    GUIDANCE_LIBRARY_UNAVAILABLE,
    GUIDANCE_MATCHED,
    GUIDANCE_NO_MATCH,
    GUIDANCE_OFF,
    GUIDANCE_OVER_BUDGET,
    GUIDANCE_RUNBOOKS_OFF,
    GUIDANCE_SELECTION_FAILED,
    RunbookGuidance,
)
from app.agents.pipeline import RunStampedAudit, default_audit_outcome
from app.agents.router import Router
from app.audit.query import AuditFilters, build_predicate, matches
from app.config import AutomationRule, Preferences, ThresholdAutomationConfig
from app.connectors.elastic import ElasticConnector
from app.constants import (
    ActionType,
    CaseStatus,
    EntityType,
    Role,
    SourceSurface,
    ToolTier,
    TriageBucket,
    Verdict,
)
from app.engine.case_tags import CASE_TAG_MAX_COUNT
from app.engine.ingest import IngestBatchError
from app.engine.poller import Poller
from app.engine.threshold_automation import ThresholdAutomation
from app.es.fake import InMemoryESClient
from app.llm.gateway import BudgetBlocked, GatewayError
from app.models import AUDIT_ACTOR_TYPES, AUDIT_OUTCOMES, Case, Entity
from app.state import AppState
from app.stores.cursor_store import CursorStore
from app.tools.base import ToolResult
from app.tools.es_query import EsQueryTool
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event, make_raw_event


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


def _cluster(ip: str):
    from app.engine.correlation import cluster_from_events

    base = 1_700_000_000_000
    events = [make_raw_event(id=f"{ip}-{i}", ip=ip, ts_millis=base + i * 1000) for i in range(3)]
    return cluster_from_events(EntityType.IP, ip, events)


def _final(verdict: str = "TRUE_POSITIVE") -> str:
    return json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": 0.9,
            "evidence": [{"summary": "scripted", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block", "reproduce_query": "x",
        },
    })


def _escalate() -> str:
    return json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "x"})


async def _case_rows(state: AppState, case_id: str) -> list[dict[str, Any]]:
    return [r for r in await state.audit.records(limit=2000) if r.get("case_id") == case_id]


def _failed_agent_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The rows the audit log's Agent activity scope lists under the Failed filter."""
    predicate = build_predicate(AuditFilters(scope="agent", outcome="failure"))
    return [r for r in rows if matches(predicate, r)]


# --------------------------------------------------------------------------- #
# The investigation pipeline
# --------------------------------------------------------------------------- #
async def test_every_row_of_an_investigation_records_an_outcome_and_a_failed_tool_call_is_failed(
    app_state: AppState, mock_provider, monkeypatch,
) -> None:
    async def _failing_query(self: EsQueryTool, **_kwargs: Any) -> ToolResult:
        return ToolResult(ok=False, error="index missing", summary="es_query error: index missing")

    monkeypatch.setattr(EsQueryTool, "run", _failing_query)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", json.dumps({"action": "tool", "tool": "es_query", "input": {"ip": "1.2.3.4"}}))
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("1.2.3.4"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    rows = [r for r in await _case_rows(app_state, case.case_id) if r.get("run_id")]
    assert rows, "the investigation wrote its rows"
    for row in rows:
        assert row.get("outcome") in AUDIT_OUTCOMES, row
        assert row.get("actor_type") in AUDIT_ACTOR_TYPES, row
    by_kind = {(r["actor"], r["action_type"]): r for r in rows}
    tool_call = by_kind[("investigator", ActionType.TOOL_CALL.value)]
    assert tool_call["outcome"] == "failure" and tool_call["actor_type"] == "agent"
    assert by_kind[("investigator", ActionType.VERDICT.value)]["outcome"] == "success"
    assert by_kind[("router", ActionType.DECISION.value)]["outcome"] == "success"
    assert by_kind[("router", ActionType.PROMPT.value)]["outcome"] == "success"
    decision = by_kind[("case_manager", ActionType.DECISION.value)]
    assert decision["outcome"] == "success" and decision["actor_type"] == "system"
    selected = next(r for r in rows if r.get("action") == "runbook.selected")
    assert selected["outcome"] == "success"
    # The Failed filter of Agent activity now finds the failed tool call, and only it.
    assert _failed_agent_rows(rows) == [tool_call]


async def test_a_run_that_stops_short_of_a_verdict_records_a_partial_verdict(
    app_state: AppState, mock_provider,
) -> None:
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.caps.max_tool_calls = 1
    mock_provider.push("router", _escalate())
    for _ in range(prefs.caps.max_tool_calls + 3):  # never a final answer
        mock_provider.push("investigator", "not json at all")
    case = await app_state.pipeline.investigate_cluster(
        _cluster("2.3.4.5"), SourceSurface.INVESTIGATE, prefs,
    )
    assert case.verdict == Verdict.NEEDS_HUMAN
    verdicts = [r for r in await _case_rows(app_state, case.case_id)
                if r.get("action_type") == ActionType.VERDICT.value]
    assert [r["outcome"] for r in verdicts] == ["partial"]


async def test_a_blocked_tool_is_recorded_as_denied(app_state: AppState, mock_provider, monkeypatch) -> None:
    monkeypatch.setattr(EsQueryTool, "tier", ToolTier.FORBIDDEN)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", json.dumps({"action": "tool", "tool": "es_query", "input": {}}))
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("3.4.5.6"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    blocked = [r for r in await _case_rows(app_state, case.case_id)
               if r.get("tool_name") == "es_query" and r.get("action_type") == ActionType.DECISION.value]
    assert len(blocked) == 1 and blocked[0]["outcome"] == "denied"


async def test_an_investigator_model_error_writes_a_failure_row(
    app_state: AppState, mock_provider, monkeypatch,
) -> None:
    gateway = app_state.pipeline._gateway
    real_complete = gateway.complete

    async def _complete(role: Role, *args: Any, **kwargs: Any):
        if role == Role.INVESTIGATOR:
            error = GatewayError("provider said no")
            error.failure_class = "unauthenticated"
            raise error
        return await real_complete(role, *args, **kwargs)

    monkeypatch.setattr(gateway, "complete", _complete)
    mock_provider.push("router", _escalate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("4.5.6.7"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    assert case.verdict == Verdict.NEEDS_HUMAN
    rows = await _case_rows(app_state, case.case_id)
    errors = [r for r in rows if r.get("actor") == "investigator"
              and r.get("action_type") == ActionType.ERROR.value]
    assert len(errors) == 1
    assert errors[0]["outcome"] == "failure" and errors[0]["run_id"]
    assert errors[0]["result_summary"].startswith("investigator model error [unauthenticated]")
    assert errors[0] in _failed_agent_rows(rows)


async def test_the_pipeline_error_row_is_a_failure(app_state: AppState, mock_provider, monkeypatch) -> None:
    async def _boom(*_args: Any, **_kwargs: Any):
        raise RuntimeError("store down")

    monkeypatch.setattr(app_state.pipeline, "_allocate_case_number", _boom)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("5.6.7.8"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    errors = [r for r in await _case_rows(app_state, case.case_id)
              if r.get("actor") == "pipeline" and r.get("action_type") == ActionType.ERROR.value]
    assert [(r["outcome"], r["actor_type"]) for r in errors] == [("failure", "agent")]


def test_the_wrapper_default_is_failure_for_errors_and_success_otherwise() -> None:
    from app.audit.events import DERIVED_OUTCOMES

    assert default_audit_outcome(ActionType.ERROR) == "failure"
    assert default_audit_outcome("error") == "failure"
    # An access-denied row is denied, never stamped success over what the reader
    # would derive (the access-denied view and the Denied filter would miss it).
    assert default_audit_outcome(ActionType.ACCESS_DENIED) == "denied"
    # One table: a stamped row reads exactly as the reader derives an unstamped one.
    for action_type, derived in DERIVED_OUTCOMES.items():
        assert default_audit_outcome(action_type) == derived
    for action_type in (ActionType.PROMPT, ActionType.DECISION, ActionType.CONTEXT, ActionType.POLL):
        assert default_audit_outcome(action_type) == "success"


async def test_the_wrapper_stamps_an_outcome_and_keeps_a_writers_own() -> None:
    inner = _Recorder()
    audit = RunStampedAudit(inner)
    await audit.record(action_type=ActionType.PROMPT, actor="router")
    await audit.record(action_type=ActionType.ERROR, actor="pipeline")
    await audit.record(action_type=ActionType.TOOL_CALL, actor="investigator", outcome="failure")
    await audit.record_strict(action_type=ActionType.DECISION, actor="case_manager", outcome="partial")
    assert [r["outcome"] for r in inner.rows] == ["success", "failure", "failure", "partial"]
    assert inner.rows[3]["actor_type"] == "system"


@pytest.mark.parametrize(
    ("status", "outcome"),
    [
        (GUIDANCE_MATCHED, "success"),
        (GUIDANCE_FALLBACK, "success"),
        (GUIDANCE_NO_MATCH, "success"),
        (GUIDANCE_OFF, "success"),
        (GUIDANCE_RUNBOOKS_OFF, "success"),
        (GUIDANCE_OVER_BUDGET, "partial"),
        (GUIDANCE_LIBRARY_UNAVAILABLE, "failure"),
        (GUIDANCE_SELECTION_FAILED, "failure"),
    ],
)
def test_the_runbook_selection_row_outcome_follows_what_happened(status: str, outcome: str) -> None:
    assert RunbookGuidance(status=status).audit_outcome == outcome


# --------------------------------------------------------------------------- #
# The router
# --------------------------------------------------------------------------- #
class _FailingGateway:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def complete(self, *_args: Any, **_kwargs: Any):
        raise self._error


class _Reply:
    def __init__(self, text: str) -> None:
        self.text, self.cost = text, 0.0


class _ReplyGateway:
    def __init__(self, text: str) -> None:
        self._text = text

    async def complete(self, *_args: Any, **_kwargs: Any) -> _Reply:
        return _Reply(self._text)


async def test_a_router_outage_is_a_failure_row_and_a_budget_refusal_is_denied() -> None:
    cluster = _cluster("6.7.8.9")
    prefs = Preferences()
    outage = GatewayError("upstream 503")
    outage.failure_class = "unavailable"
    for error, outcome in ((outage, "failure"), (BudgetBlocked("budget ceiling exceeded: daily"), "denied")):
        audit = _Recorder()
        triage = await Router(_FailingGateway(error), audit).triage(  # type: ignore[arg-type]
            cluster, None, prefs, surface="investigate", case_id="case-r",
        )
        assert triage.bucket == TriageBucket.UNCERTAIN  # never a dismissal
        assert [_value(r["action_type"]) for r in audit.rows] == ["prompt", "error"]
        assert audit.rows[1]["outcome"] == outcome
        assert "triage defaulted to uncertain" in audit.rows[1]["result_summary"]


@pytest.mark.parametrize(
    ("reply", "outcome"),
    [
        (json.dumps({"bucket": "obviously_benign", "confidence": 0.9, "reason": "noise"}), "success"),
        (json.dumps({"bucket": "something else"}), "partial"),
        ("not json", "partial"),
    ],
)
async def test_a_router_reply_without_a_known_bucket_is_partial(reply: str, outcome: str) -> None:
    audit = _Recorder()
    await Router(_ReplyGateway(reply), audit).triage(  # type: ignore[arg-type]
        _cluster("7.8.9.10"), None, Preferences(), surface="investigate", case_id="case-b",
    )
    decision = [r for r in audit.rows if _value(r["action_type"]) == "decision"]
    assert [r["outcome"] for r in decision] == [outcome]


# --------------------------------------------------------------------------- #
# The poller and push ingest (system rows)
# --------------------------------------------------------------------------- #
def _feeds_poller(state: AppState) -> tuple[Poller, Preferences]:
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    for i in range(2):
        es.add_log("logs-alerts", make_log_event(ip="1.1.1.1", rule="a", severity=8.0,
                   ts_millis=base + i * 1000), doc_id=f"al{i}")
        es.add_log("logs-events", make_log_event(ip="2.2.2.2", rule="e", severity=8.0,
                   ts_millis=base + i * 1000), doc_id=f"ev{i}")
    config = {"index_patterns": [
        {"pattern": "logs-alerts*", "role": "alerts"},
        {"pattern": "logs-events*", "role": "events"},
    ]}
    conn = ElasticConnector(es, config=config, connector_id="src-feeds")
    poller = Poller(state.es, state.cases, CursorStore(InMemoryESClient()), state.audit,
                    state.pipeline, state.get_prefs, source=conn)
    prefs = state.prefs.model_copy(deep=True)
    prefs.cold_start_lookback_minutes = 60
    return poller, prefs


async def _poll_rows(state: AppState, source_id: str) -> list[dict[str, Any]]:
    return [r for r in await state.audit.records(limit=2000)
            if r.get("actor") == "poller" and r.get("action_type") == ActionType.POLL.value
            and r.get("source_id") == source_id and not r.get("case_id")]


async def test_a_poll_tick_is_a_system_row_with_its_outcome(app_state: AppState, monkeypatch) -> None:
    poller, prefs = _feeds_poller(app_state)
    await poller.poll_once(prefs)
    ticks = await _poll_rows(app_state, "src-feeds")
    assert [(r["outcome"], r["actor_type"]) for r in ticks] == [("success", "system")]
    assert "failed=" not in ticks[0]["result_summary"]

    real_scan = poller._poll_feed_scan

    async def _one_feed_down(prefs_: Any, feed: Any, *args: Any):
        if feed.id == "logs-events":
            raise ConnectionError("events index unreachable")
        return await real_scan(prefs_, feed, *args)

    monkeypatch.setattr(poller, "_poll_feed_scan", _one_feed_down)
    await poller.poll_once(prefs)
    partial = [r for r in await _poll_rows(app_state, "src-feeds") if r["outcome"] == "partial"]
    assert len(partial) == 1 and partial[0]["result_summary"].endswith(" failed=1")

    async def _all_feeds_down(*_args: Any):
        raise ConnectionError("cluster unreachable")

    monkeypatch.setattr(poller, "_poll_feed_scan", _all_feeds_down)
    await poller.poll_once(prefs)
    ticks = await _poll_rows(app_state, "src-feeds")
    assert sorted(r["outcome"] for r in ticks) == ["failure", "partial", "success"]
    assert {r["actor_type"] for r in ticks} == {"system"}


async def test_a_poll_that_raises_writes_a_failure_row_and_still_raises(app_state: AppState, monkeypatch) -> None:
    conn = ElasticConnector(InMemoryESClient(), connector_id="src-legacy")
    poller = Poller(app_state.es, app_state.cases, CursorStore(InMemoryESClient()), app_state.audit,
                    app_state.pipeline, app_state.get_prefs, source=conn)

    async def _down(*_args: Any, **_kwargs: Any):
        raise ConnectionError("connection refused")

    monkeypatch.setattr(poller, "_poll_source_scan", _down)
    with pytest.raises(ConnectionError):
        await poller.poll_once(app_state.prefs)
    rows = await _poll_rows(app_state, "src-legacy")
    assert [(r["outcome"], r["actor_type"]) for r in rows] == [("failure", "system")]
    assert rows[0]["result_summary"] == "poll failed: ConnectionError: connection refused"
    assert _failed_agent_rows(rows) == rows


async def test_push_ingest_rows_are_system_rows_with_their_outcome(app_state: AppState, monkeypatch) -> None:
    events = [make_raw_event(id=f"push-{i}", ip="8.8.4.4") for i in range(2)]
    await app_state.ingest_service.ingest(events, app_state.prefs, source_id="push-src")
    rows = [r for r in await app_state.audit.records(limit=2000)
            if r.get("actor") == "ingest" and r.get("source_id") == "push-src"]
    assert [(r["action_type"], r["outcome"], r["actor_type"]) for r in rows] == [
        (ActionType.POLL.value, "success", "system"),
    ]

    def _broken(*_args: Any, **_kwargs: Any):
        raise RuntimeError("correlation exploded")

    monkeypatch.setattr("app.engine.correlation.correlate", _broken)
    with pytest.raises(IngestBatchError):
        await app_state.ingest_service.ingest(events, app_state.prefs, source_id="push-src")
    errors = [r for r in await app_state.audit.records(limit=2000)
              if r.get("actor") == "ingest" and r.get("source_id") == "push-src"
              and r.get("action_type") == ActionType.ERROR.value]
    assert [(r["outcome"], r["actor_type"]) for r in errors] == [("failure", "system")]


# --------------------------------------------------------------------------- #
# Threshold automation and the tuner
# --------------------------------------------------------------------------- #
def _case(case_id: str) -> Case:
    return Case(
        case_id=case_id, cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.5"),
        rule_ids=["modsec_sqli"], source_id="src-1", risk_score=80.0,
        verdict=Verdict.TRUE_POSITIVE, confidence=0.9, status=CaseStatus.NEEDS_HUMAN,
    )


def _prefs(*rules: AutomationRule) -> Preferences:
    return Preferences(threshold_automation=ThresholdAutomationConfig(enabled=True, rules=list(rules)))


async def _automation_rows(state: AppState, case_id: str) -> list[dict[str, Any]]:
    return [r for r in await _case_rows(state, case_id) if r.get("actor") == "automation"]


async def test_automation_rows_are_system_rows_whose_outcome_follows_each_action(app_state: AppState) -> None:
    case = _case("case-auto")
    case.tags = [f"t{i}" for i in range(CASE_TAG_MAX_COUNT - 1)]  # room for one more
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = (
        AutomationRule(id="rec", action="recommend", priority=1, payload={"text": "isolate the host"}),
        AutomationRule(id="two-tags", action="tag", priority=2, payload={"tags": ["fits", "no-room"]}),
        AutomationRule(id="too-long", action="tag", priority=3, payload={"tags": ["x" * 500]}),
        AutomationRule(id="ask", action="request_approval", priority=4, payload={}),
    )
    await automation.run(case, _prefs(*rules), save=app_state.cases.save)
    by_rule = {r["result_summary"].split()[0]: r for r in await _automation_rows(app_state, "case-auto")
               if r["action_type"] == ActionType.AUTOMATION.value}
    assert {k: v["outcome"] for k, v in by_rule.items()} == {
        "rule=rec": "success", "rule=two-tags": "partial", "rule=too-long": "failure", "rule=ask": "success",
    }
    assert all(r["actor_type"] == "system" for r in await _automation_rows(app_state, "case-auto"))


async def test_an_automation_action_that_raises_writes_a_failure_row(app_state: AppState) -> None:
    class _BrokenProposals:
        async def add(self, _proposal: Any) -> None:
            raise RuntimeError("proposal store down")

    case = _case("case-auto-fail")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(_BrokenProposals(), app_state.audit)
    await automation.run(case, _prefs(AutomationRule(id="ask", action="request_approval", payload={})),
                         save=app_state.cases.save)
    rows = await _automation_rows(app_state, "case-auto-fail")
    assert [(r["outcome"], r["actor_type"]) for r in rows] == [("failure", "system")]
    # A plain sentence, not the ``rule=<id> action=<action>`` shape of an action that
    # ran: the Console words that shape as done ("Automation requested approval").
    assert rows[0]["result_summary"] == "Automation rule ask could not request approval: proposal store down"
    assert matches(build_predicate(AuditFilters(outcome="failure")), rows[0])


async def _notify_rows(state: AppState, case_id: str, notify: Any) -> tuple[list[dict[str, Any]], Case]:
    case = _case(case_id)
    await state.cases.save(case)
    automation = ThresholdAutomation(state.proposals, state.audit, notify=notify)
    rule = AutomationRule(id="page", action="notify", payload={"trigger": "escalated"})
    await automation.run(case, _prefs(rule), save=state.cases.save)
    return await _automation_rows(state, case_id), case


async def _sent_quietly(_case: Case, _trigger: str) -> None:
    return None


def _sent_sync(_case: Case, _trigger: str) -> None:
    return None


async def _no_channel(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return []  # notifications off, no channel for the trigger, or a repeat in the dedup window


async def _all_sent(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return [{"channel_id": "c1", "ok": True}, {"channel_id": "c2", "ok": True}]


async def _one_failed(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return [{"channel_id": "c1", "ok": True}, {"channel_id": "c2", "ok": False, "detail": "smtp refused"}]


async def _every_failed(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return [{"channel_id": "c1", "ok": False, "detail": "smtp refused"}]


# The notification service's own entry for a channel over its hourly rate limit.
_LIMITED = {"channel_id": "c9", "ok": False, "detail": "rate limit exceeded"}


async def _one_rate_limited(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return [{"channel_id": "c1", "ok": True}, dict(_LIMITED)]


async def _every_rate_limited(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return [dict(_LIMITED), dict(_LIMITED, channel_id="c8")]


async def _failed_and_rate_limited(_case: Case, _trigger: str) -> list[dict[str, Any]]:
    return [{"channel_id": "c1", "ok": False, "detail": "smtp refused"}, dict(_LIMITED)]


async def _raises(_case: Case, _trigger: str) -> None:
    raise RuntimeError("POST https://hooks.slack.com/services/T0/B0/SECRET failed")


@pytest.mark.parametrize(
    ("notify", "outcome", "note"),
    [
        # A notifier that reports no per-channel results claims neither way.
        (_sent_quietly, "unknown", ""),
        (_sent_sync, "unknown", ""),
        (_no_channel, "success", ""),
        (_all_sent, "success", ""),
        (_one_failed, "partial", ". Partly sent: 1 of 2 channels failed."),
        (_every_failed, "failure", ". Not sent: 1 of 1 channel failed."),
        (_one_rate_limited, "partial", ". Partly sent: 1 of 2 channels was rate limited."),
        # The configured rate limit refused every send: a policy refusal, not a fault.
        (_every_rate_limited, "denied", ". Not sent: 2 of 2 channels were rate limited."),
        (_failed_and_rate_limited, "failure", ". Not sent: 1 of 2 channels failed and 1 was rate limited."),
        (_raises, "failure", ". Not sent: the notification service failed (RuntimeError)."),
        # No notifier by design (the Demo stack wires none): nothing failed.
        (None, "success", ". Not sent: no notification service is connected."),
    ],
)
async def test_a_notify_action_records_whether_the_notification_went_out(
    app_state: AppState, notify: Any, outcome: str, note: str,
) -> None:
    rows, case = await _notify_rows(app_state, f"case-notify-{getattr(notify, '__name__', 'none')}", notify)
    assert [(r["outcome"], r["actor_type"]) for r in rows] == [(outcome, "system")]
    # ``notify=<trigger>`` keeps its spelling; a notification that did not (all) go
    # out says why, on the audit row and on the case's own automation record.
    assert rows[0]["result_summary"] == f"rule=page action=notify notify=escalated{note}"
    assert case.automation_actions[-1]["detail"] == f"notify=escalated{note}"
    # A channel's URL in the exception text never reaches the record.
    assert "hooks.slack.com" not in rows[0]["result_summary"]
    failed = matches(build_predicate(AuditFilters(outcome="failure")), rows[0])
    assert failed is (outcome == "failure")


async def test_the_notification_services_own_results_drive_the_notify_outcome(
    app_state: AppState, monkeypatch,
) -> None:
    """The real dispatcher's per-channel results, including its rate-limit entry, so a
    change to that shape fails here rather than misreporting in production."""
    import app.notifications.webhook as wh
    from app.config import NotificationChannelConfig, NotificationConfig
    from app.notifications.dispatch import NotificationService

    async def _poster(url: str, **_kwargs: Any) -> tuple[int, str]:
        return (200, "ok") if url.endswith("/ok") else (500, "upstream error")

    monkeypatch.setattr(wh, "_httpx_post", _poster)
    prefs = Preferences(notifications=NotificationConfig(
        enabled=True, rate_limit_per_hour=1, dedup_window_seconds=0,
        channels=[
            NotificationChannelConfig(id="w-ok", type="webhook", config={"url": "https://x/ok"}),
            NotificationChannelConfig(id="w-down", type="webhook", config={"url": "https://x/down"}),
        ],
    ))
    service = NotificationService(get_prefs=lambda: prefs, secrets=app_state.secrets, cache=None, audit=None)
    first, _ = await _notify_rows(app_state, "case-real-first", service.dispatch)
    # Each channel has now used its one send this hour.
    second, _ = await _notify_rows(app_state, "case-real-second", service.dispatch)
    assert [(r["outcome"], r["result_summary"]) for r in first + second] == [
        ("partial", "rule=page action=notify notify=escalated. Partly sent: 1 of 2 channels failed."),
        ("denied", "rule=page action=notify notify=escalated. Not sent: 2 of 2 channels were rate limited."),
    ]


@pytest.mark.parametrize(
    ("results", "outcome", "note"),
    [
        ([{"channel_id": "c1", "type": "email", "ok": False, "detail": "smtp refused"}],
         "failure", ". Not sent: 1 of 1 channel failed."),
        ([{"channel_id": "c1", "type": "email", "ok": True, "detail": "sent"},
          {"channel_id": "c2", "type": "webhook", "ok": True, "detail": "200"}],
         "success", ""),
    ],
    ids=["every-channel-failed", "every-channel-sent"],
)
async def test_the_application_wiring_records_the_notification_services_results(
    app_state: AppState, monkeypatch, results: list[dict[str, Any]], outcome: str, note: str,
) -> None:
    """Through ``app_state.automation`` (the notifier the application wires), the
    notification service's per-channel results reach the notify action's audit row:
    a notification whose every channel failed reads ``failure`` with the note the
    direct tests above pin (and is listed under Failed), one that every channel took
    reads ``success`` with no note. The wiring never drops the results, which would
    leave every production notify row reading ``unknown``."""
    async def _dispatch(_case: Any, _trigger: str, **_kwargs: Any) -> list[dict[str, Any]]:
        return [dict(r) for r in results]

    monkeypatch.setattr(app_state.notifications, "dispatch", _dispatch)
    case_id = f"case-wired-notify-{outcome}"
    case = _case(case_id)
    await app_state.cases.save(case)
    rule = AutomationRule(id="page", action="notify", payload={"trigger": "escalated"})
    await app_state.automation.run(case, _prefs(rule), save=app_state.cases.save)
    rows = await _automation_rows(app_state, case_id)
    assert len(rows) == 1 and rows[0]["actor_type"] == "system"
    assert rows[0]["outcome"] == outcome
    assert rows[0]["result_summary"] == f"rule=page action=notify notify=escalated{note}"
    assert matches(build_predicate(AuditFilters(outcome="failure")), rows[0]) is (outcome == "failure")


async def test_the_application_notifier_returns_the_dispatch_results(
    app_state: AppState, monkeypatch,
) -> None:
    """``AppState._automation_notify`` hands back what the notification service
    returned, less an in-app inbox copy that was due for nobody (it went out to no
    one, so it is not a channel the notification was sent on), and ``None`` only when
    no service is wired. An inbox copy that reached someone, or that failed, stays."""
    email = {"channel_id": "c1", "type": "email", "ok": True, "detail": "sent"}
    nobody = {"channel_id": "in_app", "type": "in_app", "ok": True, "detail": "no recipients"}
    reached = {"channel_id": "in_app", "type": "in_app", "ok": True, "detail": "fanned out to 2 recipient(s)"}
    broken = {"channel_id": "in_app", "type": "in_app", "ok": False, "detail": "inbox fanout failed: KeyError"}
    returned: list[list[dict[str, Any]]] = [[email, nobody], [email, reached], [broken]]

    async def _dispatch(_case: Any, _trigger: str, **_kwargs: Any) -> list[dict[str, Any]]:
        return returned.pop(0)

    monkeypatch.setattr(app_state.notifications, "dispatch", _dispatch)
    notify = app_state._automation_notify  # noqa: SLF001
    assert await notify(_case("case-notify-direct"), "escalated") == [email]
    assert await notify(_case("case-notify-reached"), "escalated") == [email, reached]
    assert await notify(_case("case-notify-broken"), "escalated") == [broken]
    monkeypatch.setattr(app_state, "notifications", None)
    assert await notify(_case("case-notify-none"), "escalated") is None


async def test_a_demo_notify_rule_is_not_a_failure(app_state: AppState) -> None:
    """The Demo stack wires no notifier on purpose (it never sends): its notify
    actions say nothing went out, and are not listed under Failed."""
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    demo = app_state._demo  # noqa: SLF001
    try:
        case = _case("demo-notify-case")
        await demo.cases.save(case)
        rule = AutomationRule(id="page", action="notify", payload={"trigger": "escalated"})
        await demo.pipeline.automation.run(case, _prefs(rule), save=demo.cases.save)
        rows = [r for r in await demo.audit.records(limit=2000)
                if r.get("case_id") == "demo-notify-case" and r.get("actor") == "automation"]
        assert [(r["outcome"], r["result_summary"]) for r in rows] == [(
            "success",
            "rule=page action=notify notify=escalated. Not sent: no notification service is connected.",
        )]
        assert _failed_agent_rows(rows) == []
    finally:
        await app_state.disable_demo()


#: An error text that carries a credential twice: an address with ``user:password@``
#: and a basic credential header.
_CREDENTIAL_TEXT = (
    "refused by https://elastic:s3cr3t-pass@es.example:9200/ "
    "(Authorization: Basic dXNlcjpwYXNzd29yZA==)"
)


def _assert_redacted(summary: str) -> None:
    assert "s3cr3t-pass" not in summary and "elastic:" not in summary
    assert "dXNlcjpwYXNzd29yZA==" not in summary
    # The host stays, so the record still says what could not be reached.
    assert "https://es.example:9200/" in summary and "[REDACTED]" in summary


async def test_an_automation_failure_row_never_stores_a_credential(app_state: AppState) -> None:
    class _BrokenProposals:
        async def add(self, _proposal: Any) -> None:
            raise RuntimeError(f"proposal store {_CREDENTIAL_TEXT}")

    case = _case("case-auto-secret")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(_BrokenProposals(), app_state.audit)
    await automation.run(case, _prefs(AutomationRule(id="ask", action="request_approval", payload={})),
                         save=app_state.cases.save)
    rows = await _automation_rows(app_state, "case-auto-secret")
    assert [r["outcome"] for r in rows] == ["failure"]
    assert rows[0]["result_summary"].startswith("Automation rule ask could not request approval: ")
    _assert_redacted(rows[0]["result_summary"])


async def test_a_poll_failure_row_never_stores_a_credential(app_state: AppState, monkeypatch) -> None:
    conn = ElasticConnector(InMemoryESClient(), connector_id="src-secret")
    poller = Poller(app_state.es, app_state.cases, CursorStore(InMemoryESClient()), app_state.audit,
                    app_state.pipeline, app_state.get_prefs, source=conn)

    async def _down(*_args: Any, **_kwargs: Any):
        raise ConnectionError(_CREDENTIAL_TEXT)

    monkeypatch.setattr(poller, "_poll_source_scan", _down)
    with pytest.raises(ConnectionError):
        await poller.poll_once(app_state.prefs)
    rows = await _poll_rows(app_state, "src-secret")
    assert [r["outcome"] for r in rows] == ["failure"]
    assert rows[0]["result_summary"].startswith("poll failed: ConnectionError: refused by ")
    _assert_redacted(rows[0]["result_summary"])


async def test_a_poll_failure_propagates_unchanged_when_its_audit_row_cannot_be_written(
    app_state: AppState, monkeypatch,
) -> None:
    class _DownAudit:
        async def record(self, **_fields: Any) -> None:
            raise RuntimeError("audit store down")

    conn = ElasticConnector(InMemoryESClient(), connector_id="src-no-audit")
    poller = Poller(app_state.es, app_state.cases, CursorStore(InMemoryESClient()), _DownAudit(),
                    app_state.pipeline, app_state.get_prefs, source=conn)

    async def _down(*_args: Any, **_kwargs: Any):
        raise ConnectionError("connection refused")

    monkeypatch.setattr(poller, "_poll_source_scan", _down)
    # The source's own error reaches the loop and the source health surface, never
    # the audit store's.
    with pytest.raises(ConnectionError, match="connection refused"):
        await poller.poll_once(app_state.prefs)


async def test_an_ingest_error_row_never_stores_a_credential(app_state: AppState, monkeypatch) -> None:
    def _broken(*_args: Any, **_kwargs: Any):
        raise RuntimeError(_CREDENTIAL_TEXT)

    monkeypatch.setattr("app.engine.correlation.correlate", _broken)
    events = [make_raw_event(id=f"secret-{i}", ip="8.8.8.8") for i in range(2)]
    with pytest.raises(IngestBatchError):
        await app_state.ingest_service.ingest(events, app_state.prefs, source_id="push-secret")
    errors = [r for r in await app_state.audit.records(limit=2000)
              if r.get("actor") == "ingest" and r.get("source_id") == "push-secret"
              and r.get("action_type") == ActionType.ERROR.value]
    assert [r["outcome"] for r in errors] == ["failure"]
    _assert_redacted(errors[0]["result_summary"])


async def test_a_router_error_row_never_stores_a_credential() -> None:
    audit = _Recorder()
    await Router(_FailingGateway(GatewayError(_CREDENTIAL_TEXT)), audit).triage(  # type: ignore[arg-type]
        _cluster("9.9.9.9"), None, Preferences(), surface="investigate", case_id="case-rs",
    )
    errors = [r for r in audit.rows if _value(r["action_type"]) == "error"]
    assert len(errors) == 1
    _assert_redacted(errors[0]["result_summary"])


def _investigator_raising(gateway: Any, error: Exception) -> Any:
    """``gateway.complete`` with every investigator call raising ``error``."""
    real_complete = gateway.complete

    async def _complete(role: Role, *args: Any, **kwargs: Any):
        if role == Role.INVESTIGATOR:
            raise error
        return await real_complete(role, *args, **kwargs)

    return _complete


async def _error_rows(state: AppState, case_id: str, actor: str) -> list[dict[str, Any]]:
    return [r for r in await _case_rows(state, case_id)
            if r.get("actor") == actor and r.get("action_type") == ActionType.ERROR.value]


async def test_an_investigator_model_error_row_never_stores_a_credential(
    app_state: AppState, mock_provider, monkeypatch,
) -> None:
    gateway = app_state.pipeline._gateway
    monkeypatch.setattr(gateway, "complete", _investigator_raising(gateway, GatewayError(_CREDENTIAL_TEXT)))
    mock_provider.push("router", _escalate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.8.1"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    errors = await _error_rows(app_state, case.case_id, "investigator")
    assert [r["outcome"] for r in errors] == ["failure"]
    assert errors[0]["result_summary"].startswith("investigator model error: refused by ")
    _assert_redacted(errors[0]["result_summary"])


async def test_an_investigator_crash_row_never_stores_a_credential(
    app_state: AppState, mock_provider, monkeypatch,
) -> None:
    gateway = app_state.pipeline._gateway
    # Not a gateway error, so the investigator's crash guard writes the row.
    monkeypatch.setattr(gateway, "complete", _investigator_raising(gateway, RuntimeError(_CREDENTIAL_TEXT)))
    mock_provider.push("router", _escalate())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.8.2"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    assert case.verdict == Verdict.NEEDS_HUMAN
    errors = await _error_rows(app_state, case.case_id, "investigator")
    assert [r["outcome"] for r in errors] == ["failure"]
    assert errors[0]["result_summary"].startswith("investigator crash: refused by ")
    _assert_redacted(errors[0]["result_summary"])


async def test_a_pipeline_error_row_never_stores_a_credential(
    app_state: AppState, mock_provider, monkeypatch,
) -> None:
    async def _boom(*_args: Any, **_kwargs: Any):
        raise RuntimeError(f"case store {_CREDENTIAL_TEXT}")

    monkeypatch.setattr(app_state.pipeline, "_allocate_case_number", _boom)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.8.3"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    errors = await _error_rows(app_state, case.case_id, "pipeline")
    assert [(r["outcome"], r["actor_type"]) for r in errors] == [("failure", "agent")]
    assert errors[0]["result_summary"].startswith("pipeline error: case store refused by ")
    _assert_redacted(errors[0]["result_summary"])


async def test_a_long_pipeline_error_is_cut_to_the_record_bound(
    app_state: AppState, mock_provider, monkeypatch,
) -> None:
    async def _boom(*_args: Any, **_kwargs: Any):
        raise RuntimeError("x" * 5000)

    monkeypatch.setattr(app_state.pipeline, "_allocate_case_number", _boom)
    mock_provider.push("router", _escalate())
    mock_provider.push("investigator", _final())
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.8.4"), SourceSurface.INVESTIGATE, app_state.prefs,
    )
    errors = await _error_rows(app_state, case.case_id, "pipeline")
    assert len(errors) == 1 and len(errors[0]["result_summary"]) <= 1000


async def test_a_failed_runbook_attachment_is_a_failure_but_a_skip_is_not(app_state: AppState) -> None:
    async def _raises(*_args: Any) -> Any:
        raise RuntimeError("runbook store down")

    async def _skips(*_args: Any) -> Any:
        return None

    rule = AutomationRule(id="attach", action="run_playbook", payload={"runbook_id": "rb-1"})
    for case_id, attacher, outcome in (("case-att-raise", _raises, "failure"), ("case-att-skip", _skips, "success")):
        case = _case(case_id)
        await app_state.cases.save(case)
        automation = ThresholdAutomation(app_state.proposals, app_state.audit, attach_runbook=attacher)
        await automation.run(case, _prefs(rule), save=app_state.cases.save)
        rows = await _automation_rows(app_state, case_id)
        assert [r["outcome"] for r in rows] == [outcome]
        # The Console words this detail by its exact ``attached=True|False`` spelling.
        assert rows[0]["result_summary"].endswith("attached=False")


async def test_tuner_rows_are_system_rows() -> None:
    from app.engine import threshold_tuner

    audit = _Recorder()
    await threshold_tuner._audit_inert_correlation(audit, [{"rule_id": "r1", "reason": "alerts_role"}])
    assert [(r["actor"], r["actor_type"], r["outcome"]) for r in audit.rows] == [("tuner", "system", "success")]


async def test_existing_rows_are_never_rewritten(app_state: AppState) -> None:
    """A row stored before Round 14 keeps reading as it did: nothing backfills it (#2)."""
    from app.audit import events

    await app_state.audit.record(action_type=ActionType.POLL, surface="poller", actor="poller",
                                 result_summary="written without the Round 14 fields")
    legacy = next(r for r in await app_state.audit.records(limit=2000)
                  if r.get("result_summary") == "written without the Round 14 fields")
    assert legacy.get("outcome") is None
    assert events.derive_outcome(legacy) == (None, False)
    assert events.derive_actor_type(legacy) == ("system", True)
