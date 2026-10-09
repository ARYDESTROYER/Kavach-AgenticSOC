"""Every data tool on the Demo Mode stack (chat revamp SPEC §5.3, §1 "Demo Mode
demos every feature at $0"): demo stores and sources only, rows on the DEMO audit,
artifacts that render, whitelisted observations."""

from __future__ import annotations

from app.agents.chat_tools.registry import build_toolbox
from app.agents.chat_tools.taint import TaintLedger
from app.agents.prompts import fence_block
from app.constants import UNTRUSTED_CLOSE, UNTRUSTED_OPEN

import pytest_asyncio

from tests.test_chat_tools_support import (
    assert_artifacts_render,
    assert_observation_whitelisted,
    build_demo_state,
    demo_context,
)


@pytest_asyncio.fixture
async def demo_state():
    state = await build_demo_state()
    try:
        yield state
    finally:
        await state.disable_demo()
        await state.shutdown()


DEMO_CALLS = [
    ("search_logs", {}),
    ("search_logs", {"source_id": "demo-wazuh", "size": 5}),
    ("log_stats", {"group_by": ["ip", "user"], "include_heatmap": True}),
    ("search_cases", {"status_group": "active"}),
    ("search_cases", {"verdict": "TRUE_POSITIVE"}),
    ("soc_metrics", {"kind": "posture", "compare_previous": True}),
    ("soc_metrics", {"kind": "trends"}),
    ("soc_metrics", {"kind": "noise_funnel"}),
    ("soc_metrics", {"kind": "case_mix"}),
    ("soc_metrics", {"kind": "timing"}),
    ("soc_metrics", {"kind": "mitre_coverage"}),
    ("soc_metrics", {"kind": "auto_close_health"}),
    ("soc_metrics", {"kind": "agent_improvement"}),
    ("soc_metrics", {"kind": "feedback"}),
    ("shift_report", {}),
    ("list_campaigns", {}),
    ("lookup_indicator", {"indicator": "198.51.100.77"}),
    ("mitre_lookup", {"query": "brute force"}),
    ("search_knowledge", {"query": "brute force runbook"}),
    ("search_knowledge", {"kind": "list_runbooks"}),
    ("search_knowledge", {"kind": "list_playbooks"}),
    ("cost_usage", {}),
    ("source_health", {}),
    ("automation_status", {"kind": "tuning"}),
    ("automation_status", {"kind": "baselines"}),
    ("automation_status", {"kind": "approvals"}),
    ("automation_status", {"kind": "schedulers"}),
    ("automation_status", {"kind": "telemetry_gaps"}),
    ("explain_decision", {"verdict": "FALSE_POSITIVE", "confidence": 0.9, "risk_score": 20}),
    ("audit_search", {}),
]


async def test_every_data_tool_runs_on_the_demo_stack(demo_state) -> None:
    state = demo_state
    ctx = demo_context(state)
    box = build_toolbox(ctx)
    ledger = TaintLedger(["is 198.51.100.77 malicious?"])
    real_audit_before = await state._real_audit.records(surface="chat", limit=50)
    cases, _total = await state.cases.list(limit=1)
    calls = DEMO_CALLS + [
        ("get_case", {"case_id": cases[0].case_id, "include": ["summary", "timeline", "decision", "rationale"]}),
        ("explain_decision", {"case_id": cases[0].case_id, "include": ["forwarding"]}),
    ]
    for step, (name, inp) in enumerate(calls, start=1):
        out = await box.execute(name, inp, turn_id="turn-demo", step=step, ordinal=step, taint=ledger)
        assert out.ok, (name, inp, out.status, out.error)
        assert out.summary, name
        assert_observation_whitelisted(out)
        assert_artifacts_render(out)
        fenced = fence_block(out.observation, source="tool", tool=name)
        assert fenced.count(UNTRUSTED_OPEN) == 1 and fenced.count(UNTRUSTED_CLOSE) == 1, name
    # Rows landed on the DEMO execution audit, never on the real one.
    demo_rows = await state.audit.records(surface="chat", limit=200)
    assert len([r for r in demo_rows if str(r.get("result_summary", "")).startswith("turn=turn-demo")]) == len(calls)
    assert {r["action_type"] for r in demo_rows if r.get("tool_name") in ("search_logs", "log_stats")} == {"es_query"}
    assert await state._real_audit.records(surface="chat", limit=50) == real_audit_before


async def test_demo_specific_behaviour(demo_state) -> None:
    state = demo_state
    ctx = demo_context(state)
    box = build_toolbox(ctx)
    # All five demo sources are read by default (no source selected, > 1 browsable).
    logs = await box.execute("search_logs", {})
    assert len(logs.observation["sources"]) == 5
    # Costs are labelled simulated; the budget needs models:read.
    cost = await box.execute("cost_usage", {})
    assert cost.observation["simulated"] is True and "budget" in cost.observation
    no_models = build_toolbox(demo_context(state, grants=frozenset({("cost", "view")})))
    cost2 = await no_models.execute("cost_usage", {})
    assert "budget" not in cost2.observation
    # Lookups return a labelled synthetic result and never dispatch.
    ledger = TaintLedger(["check 203.0.113.77"])
    lookup = await box.execute("lookup_indicator", {"indicator": "203.0.113.77"}, taint=ledger)
    assert lookup.observation["synthetic_demo_result"] is True
    # Source health reports the five demo sources from the demo overlay.
    health = await box.execute("source_health", {})
    assert health.observation["coverage"]["sources_total"] == 5
    assert all(s["demo"] for s in health.observation["sources"])


async def test_every_demo_artifact_materialises_in_every_allowed_view(demo_state) -> None:
    """Contract with the materialiser (SPEC §7.3): each artifact a tool produces
    becomes at least one valid block in EVERY view it advertises, unless it holds no
    data at all (zero rows, points or items), which yields no block in ANY view
    (browser-QA D3: never an empty shell)."""
    from app.agents.blocks import MaterialiseOptions, _materialise, to_blocks

    box = build_toolbox(demo_context(demo_state))
    ledger = TaintLedger(["is 198.51.100.77 malicious?"])
    count = empty = 0
    for i, (name, inp) in enumerate(DEMO_CALLS, start=1):
        out = await box.execute(name, inp, ordinal=i, step=i, taint=ledger)
        for artifact in out.artifacts:
            outcomes = {view: _materialise(artifact, MaterialiseOptions(block_id=f"b{i}{artifact.id}", view=view))
                        for view in artifact.views()}
            if any(outcome == "empty" for _blocks, outcome in outcomes.values()):
                assert all(blocks == [] and outcome == "empty"
                           for blocks, outcome in outcomes.values()), (name, artifact.kind)
                empty += 1
                continue
            for view, (blocks, _outcome) in outcomes.items():
                assert blocks, (name, artifact.kind, view)
                assert blocks == to_blocks(artifact, MaterialiseOptions(block_id=f"b{i}{artifact.id}", view=view))
                count += 1
    assert count > 100 and empty < 5
