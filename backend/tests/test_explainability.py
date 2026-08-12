"""Case EXPLAINABILITY: the CONTEXT audit record + the /cases/{id}/rationale
endpoint that assembles a human-readable "why" object from the case + its audit
records (no LLM). All offline (fake ES + mock LLM), mirroring conftest patterns.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from app.api.routes import _build_rationale, case_rationale, case_trace
from app.config import SourceInstance
from app.constants import ActionType, EntityType, SourceSurface, SourceType
from app.engine.correlation import cluster_from_events
from app.models import RagChunk, TriggerReason
from app.stores.tuning import TuningRecord
from app.tools.rag import RagRetrievalObservation

from tests.conftest import make_raw_event


def _cluster(rule: str = "linux_auth", n: int = 6, ip: str = "203.0.113.50"):
    base = 1_700_000_000_000
    events = [
        make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000)
        for i in range(n)
    ]
    cluster = cluster_from_events(EntityType.IP, ip, events)
    # Manual builder clusters do not normally carry the correlator's threshold
    # metadata.  Add the exact recorded trigger here so platform-tuning provenance
    # can be tested without changing the production manual-investigation contract.
    cluster.trigger_reason = TriggerReason(
        rule_value=rule,
        mode="threshold",
        n=n,
        observed_count=n,
    )
    return cluster


def _final(verdict: str = "TRUE_POSITIVE", confidence: float = 0.92) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "Repeated auth failures then a success — credential stuffing.",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "6 failed logins", "event_ids": ["e0", "e1"], "query": 'source.ip:"x"'}],
            "mitre": ["T1110"], "recommended_action": "isolate", "reproduce_query": "",
        },
    })


def _tool_step(query: str = 'source.ip:"203.0.113.50"') -> str:
    return json.dumps({
        "action": "tool", "tool": "es_query",
        "input": {"query": query, "language": "kuery"},
    })


async def _run_investigation(state, mock_provider, *, with_memory=True, with_rag=True):
    """Drive one scripted strong investigation through the real pipeline: router →
    needs_strong_model, investigator → es_query then final TRUE_POSITIVE."""
    if with_memory:
        await state.memory.add("10.0.0.0/8 is the internal corporate range", category="network")

    if with_rag:
        async def _fake_retrieve(query, top_k=None):
            return RagRetrievalObservation(
                [RagChunk(
                    text="Internal vuln scanner runs planned testing; benign scanning is expected.",
                    source="runbook", score=0.9,
                )],
                True,
                "completed",
            )
        # Patch the live rag service the pipeline holds.
        state.rag.retrieve_observed = _fake_retrieve  # type: ignore[method-assign]

    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}
    ))
    mock_provider.push("investigator", _tool_step())
    mock_provider.push("investigator", _final())

    return await state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.INVESTIGATE, state.prefs
    )


# --------------------------------------------------------------------------- #
# 1) The CONTEXT audit record captures knowledge / memory / enrichment
# --------------------------------------------------------------------------- #
async def test_context_record_written_with_why(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)

    rows = await state.audit.records_for_case(case.case_id)
    ctx = [r for r in rows if r.get("action_type") == ActionType.CONTEXT.value]
    assert ctx, "a CONTEXT explainability record must be written"
    rec = ctx[0]
    assert rec.get("actor") == "context"

    # Human-readable summary visible in the trace.
    summary = rec.get("result_summary") or ""
    assert "knowledge(" in summary and "[runbook]" in summary
    assert "memory(" in summary
    assert "enrichment:" in summary

    # Structured copy for the rationale endpoint.
    ti = rec.get("tool_input") or {}
    assert any(k.get("source") == "runbook" for k in ti["knowledge"])
    assert any("internal corporate range" in m for m in ti["memory"])
    assert ti["enrichment"] is not None and "is_malicious" in ti["enrichment"]


# --------------------------------------------------------------------------- #
# 2) The VERDICT record carries a reasoning excerpt
# --------------------------------------------------------------------------- #
async def test_verdict_record_has_reasoning(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)
    rows = await state.audit.records_for_case(case.case_id)
    verdicts = [r for r in rows if r.get("action_type") == ActionType.VERDICT.value]
    assert verdicts
    assert "reasoning=" in (verdicts[0].get("result_summary") or "")
    assert "credential stuffing" in (verdicts[0].get("result_summary") or "")


# --------------------------------------------------------------------------- #
# 3) The rationale endpoint assembles the full "why" object (no LLM)
# --------------------------------------------------------------------------- #
async def test_rationale_endpoint_assembles_why(app_state, mock_provider):
    state = app_state
    await state.tuning_store.add(TuningRecord(
        id="tune-linux-auth",
        rule_id="linux_auth",
        target="correlation_n",
        before=5,
        after=6,
        rationale="Raised after repeated false-positive clusters.",
    ))
    case = await _run_investigation(state, mock_provider)

    out = await case_rationale(case.case_id, state)

    assert out["case_id"] == case.case_id
    assert out["verdict"] == "TRUE_POSITIVE"
    assert out["confidence"] == 0.92
    assert out["status"]  # closed or needs_human, but populated
    # persona is deterministically assigned.
    assert out["persona"]
    # playbook block present (id may be empty if no match, but reason is recorded).
    assert "id" in out["playbook"] and "reason" in out["playbook"]
    assert out["playbook"]["reason"]  # playbook_selector DECISION captured
    assert "consulted" in out["playbook"]

    # knowledge with source.
    assert any(k["source"] == "runbook" for k in out["knowledge"])
    # memory facts injected.
    assert any("internal corporate range" in m for m in out["memory_used"])
    # Platform tuning is an immutable case-run snapshot, not a mutable-ledger join.
    assert out["platform_tuning_status"] == "recorded"
    assert out["platform_tuning"] == [{
        "record_id": "tune-linux-auth",
        "target": "correlation_n",
        "rule_id": "linux_auth",
        "before": 5,
        "after": 6,
        "applied_at": out["platform_tuning"][0]["applied_at"],
        "rationale": "Raised after repeated false-positive clusters.",
    }]
    # enrichment present.
    assert out["enrichment"] is not None and "reputation_score" in out["enrichment"]
    # tools the agent ran, with the issued query recorded (es_query is read-only).
    es_tools = [t for t in out["tools"] if t["tool"] == "es_query"]
    assert es_tools and es_tools[0]["query"]
    # investigator reasoning excerpt.
    assert "credential stuffing" in out["reasoning"]
    # deterministic decision rationale (case_manager branch that fired).
    assert out["decision_rationale"]
    # MITRE + evidence carried from the case (the formatter shapes the final
    # evidence text; we assert the structure is surfaced).
    assert "T1110" in out["mitre"]
    assert out["evidence"] and all("summary" in e and "event_ids" in e for e in out["evidence"])


# --------------------------------------------------------------------------- #
# 4) The existing trace endpoint still builds (CONTEXT flows through it)
# --------------------------------------------------------------------------- #
async def test_trace_still_builds_with_context(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)
    res = await case_trace(case.case_id, state)
    assert res["total"] >= 1
    actors = [s["actor"] for s in res["steps"]]
    assert "context" in actors  # the new CONTEXT record is surfaced in the trace
    # The context step carries its structured detail + readable summary.
    ctx_step = next(s for s in res["steps"] if s["actor"] == "context")
    assert ctx_step["action_type"] == ActionType.CONTEXT.value
    assert ctx_step["result_summary"]


# --------------------------------------------------------------------------- #
# 5) Defensive: rationale NEVER 404s and degrades gracefully
# --------------------------------------------------------------------------- #
async def test_rationale_unknown_case_is_empty_not_error(app_state):
    out = await case_rationale("does-not-exist", app_state)
    assert out["case_id"] == "does-not-exist"
    assert out["verdict"] == "" and out["knowledge"] == [] and out["memory_used"] == []
    assert out["enrichment"] is None and out["tools"] == []
    assert out["reasoning"] == "" and out["decision_rationale"] == ""
    assert out["platform_tuning_status"] == "not_recorded"
    assert out["platform_tuning"] == []


def test_rationale_projects_only_latest_investigation_run():
    """A cheap/latest run must not inherit an older run's context or tool calls."""
    rows = [
        {
            "actor": "playbook_selector",
            "action_type": ActionType.DECISION.value,
            "result_summary": "reason=old",
            "tool_input": {"playbook_selection": {"id": "old-playbook", "reason": "old"}},
        },
        {
            "actor": "context",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": {
                "memory": ["old memory"],
                "knowledge": [{"source": "runbook", "snippet": "old runbook"}],
                "playbook_detail": {"id": "old-playbook", "version": "1"},
            },
        },
        {
            "actor": "investigator",
            "action_type": ActionType.TOOL_CALL.value,
            "tool_name": "es_query",
            "query_text": "old query",
        },
        {
            "actor": "investigator",
            "action_type": ActionType.VERDICT.value,
            "result_summary": "reasoning=old reasoning",
        },
        {
            "actor": "playbook_selector",
            "action_type": ActionType.DECISION.value,
            "result_summary": "reason=new selection",
            "tool_input": {
                "playbook_selection": {"id": "selected-only", "reason": "new selection"},
                "platform_tuning": {
                    "status": "recorded",
                    "records": [{
                        "record_id": "tune-new",
                        "target": "correlation_n",
                        "rule_id": "rule-new",
                        "before": 2,
                        "after": 3,
                    }],
                },
            },
        },
        {
            "actor": "router",
            "action_type": ActionType.VERDICT.value,
            "result_summary": "reasoning=new cheap-path reasoning",
        },
    ]

    out = _build_rationale("case-reinvestigated", None, rows)

    assert out["memory_used"] == []
    assert out["knowledge"] == []
    assert out["tools"] == []
    assert out["reasoning"] == "new cheap-path reasoning"
    # Selection is not consultation: no investigator CONTEXT row, no used playbook.
    assert out["playbook"]["id"] == ""
    assert out["playbook"]["consulted"] is False
    assert out["platform_tuning"][0]["record_id"] == "tune-new"
    # No latest-run procedure telemetry is historical uncertainty, not proof
    # that a retrieval ran and returned zero references.
    assert out["procedure_provenance"]["retrieval_status"] == "unavailable"
    assert out["procedure_provenance"]["retrieval_reason"] == "historical_provenance_missing"


def test_rationale_preselector_pipeline_failure_does_not_inherit_prior_run():
    """A newer fail-to-human run cannot present the prior run as its provenance."""
    rows = [
        {
            "actor": "playbook_selector",
            "action_type": ActionType.DECISION.value,
            "result_summary": "reason=old selection",
        },
        {
            "actor": "procedure_provenance",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": {
                "retrieval_status": "measured",
                "retrieval_reason": "completed",
                "knowledge": [{"source": "runbook", "snippet": "old reference"}],
            },
        },
        {
            "actor": "investigator",
            "action_type": ActionType.TOOL_CALL.value,
            "tool_name": "es_query",
            "query_text": "old query",
        },
        {
            "actor": "investigator",
            "action_type": ActionType.VERDICT.value,
            "result_summary": "reasoning=old reasoning",
        },
        {
            "actor": "case_manager",
            "action_type": ActionType.DECISION.value,
            "result_summary": "old deterministic decision",
        },
        {
            "actor": "pipeline",
            "action_type": ActionType.ERROR.value,
            "result_summary": "pipeline error: failed before procedure selection",
        },
    ]

    out = _build_rationale("case-preselector-failure", None, rows)

    assert out["procedure_provenance"]["retrieval_status"] == "unavailable"
    assert (
        out["procedure_provenance"]["retrieval_reason"]
        == "pipeline_failed_before_provenance"
    )
    assert out["knowledge"] == []
    assert out["tools"] == []
    assert out["reasoning"] == ""
    assert out["decision_rationale"] == ""


def test_rationale_error_case_without_new_audit_boundary_fails_closed():
    """A lost terminal audit append cannot expose an older run as current."""
    rows = [
        {
            "ts": "2026-08-11T01:00:00+00:00",
            "actor": "playbook_selector",
            "action_type": ActionType.DECISION.value,
        },
        {
            "ts": "2026-08-11T01:00:01+00:00",
            "actor": "procedure_provenance",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": {
                "retrieval_status": "measured",
                "retrieval_reason": "completed",
                "knowledge": [{"source": "runbook", "snippet": "old reference"}],
            },
        },
        {
            "ts": "2026-08-11T01:00:02+00:00",
            "actor": "case_manager",
            "action_type": ActionType.DECISION.value,
            "result_summary": "old deterministic decision",
        },
    ]
    failed_case = SimpleNamespace(
        error="new pipeline failure",
        updated_at="2026-08-11T02:00:00+00:00",
        verdict=None,
        confidence=0.0,
        status=None,
        decision_by=None,
        agent_persona="",
        playbook_id="",
        mitre=[],
        evidence=[],
        history=[],
    )

    out = _build_rationale("case-missing-error-audit", failed_case, rows)

    assert out["procedure_provenance"]["retrieval_status"] == "unavailable"
    assert (
        out["procedure_provenance"]["retrieval_reason"]
        == "pipeline_failure_provenance_missing"
    )
    assert out["knowledge"] == []
    assert out["tools"] == []
    assert out["reasoning"] == ""
    assert out["decision_rationale"] == ""


def test_rationale_keeps_current_provenance_across_nonterminal_timeout_error():
    """Timeout telemetry inside a run is not mistaken for a new run boundary."""
    rows = [
        {
            "actor": "playbook_selector",
            "action_type": ActionType.DECISION.value,
        },
        {
            "actor": "pipeline",
            "action_type": ActionType.ERROR.value,
            "result_summary": "investigation timed out after 30s; capped to NEEDS_HUMAN",
        },
        {
            "actor": "procedure_provenance",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": {
                "retrieval_status": "measured",
                "retrieval_reason": "completed",
                "knowledge": [{"source": "runbook", "snippet": "current reference"}],
            },
        },
        {
            "actor": "case_manager",
            "action_type": ActionType.DECISION.value,
            "result_summary": "current deterministic decision",
        },
    ]

    out = _build_rationale("case-timeout", None, rows)

    assert out["procedure_provenance"]["retrieval_status"] == "measured"
    assert out["knowledge"] == [{
        "source": "runbook",
        "score": None,
        "document_id": "",
        "revision": None,
        "content_hash": "",
        "query_groups": [],
        "snippet": "current reference",
    }]
    assert out["decision_rationale"] == "current deterministic decision"


def test_rationale_distinguishes_measured_zero_from_not_attempted_and_unavailable():
    def _procedure_row(status: str | None, reason: str | None = None):
        tool_input = {
            "persona": {"selected_id": "generalist", "consulted": False},
            "playbook": {"selected_id": None, "consulted": False},
            "consultation_path": "strong_investigator",
            "knowledge": [],
            "retrieval_query_groups": [],
        }
        if status is not None:
            tool_input["retrieval_status"] = status
        if reason is not None:
            tool_input["retrieval_reason"] = reason
        return {
            "actor": "procedure_provenance",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": tool_input,
        }

    measured = _build_rationale(
        "case-measured-zero", None, [_procedure_row("measured", "completed")]
    )
    assert measured["knowledge"] == []
    assert measured["procedure_provenance"]["retrieval_status"] == "measured"
    assert measured["procedure_provenance"]["retrieval_reason"] == "completed"

    not_attempted = _build_rationale(
        "case-not-attempted",
        None,
        [_procedure_row("not_attempted", "router_benign_shortcut")],
    )
    assert not_attempted["knowledge"] == []
    assert not_attempted["procedure_provenance"]["retrieval_status"] == "not_attempted"
    assert (
        not_attempted["procedure_provenance"]["retrieval_reason"]
        == "router_benign_shortcut"
    )

    legacy = _build_rationale("case-legacy", None, [_procedure_row(None)])
    assert legacy["knowledge"] == []
    assert legacy["procedure_provenance"]["retrieval_status"] == "unavailable"
    assert legacy["procedure_provenance"]["retrieval_reason"] == "historical_provenance_missing"


def test_rationale_projects_structured_procedure_provenance():
    """Selected and consulted procedure facts remain distinct and attributable."""
    rows = [
        {
            "actor": "playbook_selector",
            "action_type": ActionType.DECISION.value,
            "result_summary": "reason=exact rule match",
            "tool_input": {
                "playbook_selection": {
                    "id": "web-scanner-activity",
                    "reason": "exact rule match",
                },
            },
        },
        {
            "actor": "context",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": {
                "knowledge": [{"source": "legacy", "snippet": "superseded"}],
                "playbook_detail": {"id": "web-scanner-activity", "version": "2"},
            },
        },
        {
            "actor": "procedure_provenance",
            "action_type": ActionType.CONTEXT.value,
            "tool_input": {
                "persona": {
                    "selected_id": "network_specialist",
                    "selection_reason": "entity_type=ip",
                    "consulted": True,
                },
                "playbook": {
                    "selected_id": "web-scanner-activity",
                    "selection_reason": "exact rule match",
                    "consulted": True,
                },
                "consultation_path": "strong_investigator",
                "retrieval_status": "measured",
                "retrieval_reason": "completed",
                "retrieval_query_groups": [
                    {"group": "cluster", "query": "ip scanner evidence"},
                    {"group": "playbook:1", "query": "approved scanner ranges"},
                ],
                "knowledge": [{
                    "source": "operator-runbook",
                    "score": 0.91,
                    "document_id": "runbook-scanner",
                    "revision": 4,
                    "content_hash": "abc123",
                    "query_groups": ["cluster", "playbook:1"],
                    "snippet": "Validate scanner ownership and change window.",
                }],
            },
        },
    ]

    out = _build_rationale("case-provenance", None, rows)

    assert out["procedure_provenance"] == {
        "persona": {
            "selected_id": "network_specialist",
            "selection_reason": "entity_type=ip",
            "consulted": True,
        },
        "playbook": {
            "selected_id": "web-scanner-activity",
            "selection_reason": "exact rule match",
            "consulted": True,
        },
        "consultation_path": "strong_investigator",
        "retrieval_status": "measured",
        "retrieval_reason": "completed",
        "retrieval_query_groups": [
            {"group": "cluster", "query": "ip scanner evidence"},
            {"group": "playbook:1", "query": "approved scanner ranges"},
        ],
        "knowledge": [{
            "source": "operator-runbook",
            "score": 0.91,
            "document_id": "runbook-scanner",
            "revision": 4,
            "content_hash": "abc123",
            "query_groups": ["cluster", "playbook:1"],
            "snippet": "Validate scanner ownership and change window.",
        }],
    }
    assert out["playbook"] == {
        "id": "web-scanner-activity",
        "version": "2",
        "reason": "exact rule match",
        "consulted": True,
    }
    assert out["knowledge"] == out["procedure_provenance"]["knowledge"]


async def test_tuning_snapshot_does_not_resurrect_an_older_threshold(app_state):
    """Only the newest active row for one knob can explain the current threshold."""
    state = app_state
    await state.tuning_store.add(TuningRecord(
        id="tune-old-matching",
        rule_id="linux_auth",
        target="correlation_n",
        before=5,
        after=6,
        applied_at="2026-01-01T00:00:00+00:00",
    ))
    await state.tuning_store.add(TuningRecord(
        id="tune-new-stale",
        rule_id="linux_auth",
        target="correlation_n",
        before=6,
        after=7,
        applied_at="2026-02-01T00:00:00+00:00",
    ))

    snapshot = await state.pipeline._platform_tuning_snapshot(_cluster(n=6), state.prefs)

    assert snapshot == {"status": "recorded", "records": []}


async def test_tuning_snapshot_does_not_attribute_an_unused_every_mode_n(app_state):
    """An EVERY rule can carry ``n``, but that value does not gate its trigger."""
    state = app_state
    await state.tuning_store.add(TuningRecord(
        id="tune-unused-every-n",
        rule_id="linux_auth",
        target="correlation_n",
        before=5,
        after=6,
    ))
    cluster = _cluster(n=6)
    cluster.trigger_reason.mode = "every"

    snapshot = await state.pipeline._platform_tuning_snapshot(cluster, state.prefs)

    assert snapshot == {"status": "recorded", "records": []}


async def test_tuning_snapshot_preserves_exact_source_feed_pairs(app_state):
    """Independent source/feed lists must never become a false cross-product."""
    state = app_state
    sources = [
        SourceInstance(
            id="source-a",
            source_type=SourceType.ELASTICSEARCH,
            config={
                "index_patterns": [
                    {"id": "feed-a", "pattern": "a-*", "severity_floor": 2},
                    {"id": "feed-b", "pattern": "a-b-*", "severity_floor": 4},
                ],
            },
        ),
        SourceInstance(
            id="source-b",
            source_type=SourceType.ELASTICSEARCH,
            config={
                "index_patterns": [
                    {"id": "feed-b", "pattern": "b-*", "severity_floor": 4},
                ],
            },
        ),
    ]
    prefs = state.prefs.model_copy(update={"sources": sources})
    await state.tuning_store.add(TuningRecord(
        id="tune-false-pair",
        rule_id="source-a:feed-b",
        target="severity_floor",
        before=3,
        after=4,
    ))
    events = [
        make_raw_event(id="source-a-event", ts_millis=1_700_000_000_000),
        make_raw_event(id="source-b-event", ts_millis=1_700_000_001_000),
    ]
    events[0].source_id = "source-a"
    events[0].feed_id = "feed-a"
    events[1].source_id = "source-b"
    events[1].feed_id = "feed-b"
    cluster = cluster_from_events(EntityType.IP, "203.0.113.50", events)

    snapshot = await state.pipeline._platform_tuning_snapshot(cluster, prefs)

    assert snapshot == {"status": "recorded", "records": []}
