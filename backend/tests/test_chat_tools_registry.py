"""The chat toolbox: catalogue, grant filtering, guarded execution and audit rows
(chat revamp SPEC §5.1–§5.3)."""

from __future__ import annotations

import asyncio
from typing import Any, ClassVar

import pytest

from app.agents.chat_tools.base import ChatTool, ChatToolContext, ToolOutcome
from app.agents.chat_tools.common import ToolCall, call_scope, current_call
from app.agents.chat_tools.registry import (
    LOG_TOOLS,
    TOOL_ORDER,
    audit_prefix,
    build_toolbox,
    catalogue,
    catalogue_grant_pairs,
    catalogue_infos,
)
from app.agents.chat_tools.taint import TaintLedger
from app.config import ChatAgentConfig, Preferences
from app.constants import ActionType
from app.rbac.policy import can_for_roles, resolve_matrix

from tests.test_chat_tools_support import RecordingAudit, make_ctx, tool_names

DATA_TOOLS = (
    "search_logs", "log_stats", "search_cases", "get_case", "soc_metrics", "shift_report",
    "list_campaigns", "lookup_indicator", "mitre_lookup", "search_knowledge", "cost_usage",
    "source_health", "automation_status", "explain_decision", "audit_search",
)


def test_catalogue_has_every_data_tool_in_spec_order() -> None:
    names = tool_names(catalogue())
    for name in DATA_TOOLS:
        assert name in names
    ranked = [n for n in TOOL_ORDER if n in names]
    assert names[: len(ranked)] == ranked


def test_catalogue_grant_pairs_cover_tools_kinds_and_optional_grants() -> None:
    pairs = catalogue_grant_pairs()
    for pair in [("sources", "read"), ("cases", "read"), ("metrics", "view"), ("enrichment", "read"),
                 ("rag", "read"), ("runbooks", "read"), ("playbooks", "read"), ("cost", "view"),
                 ("audit", "view"), ("automation", "read"), ("settings", "read"), ("proposals", "read"),
                 ("rules", "read"), ("models", "read"), ("memory", "read")]:
        assert pair in pairs


def test_build_toolbox_lists_only_granted_tools_and_signatures() -> None:
    ctx = make_ctx(grants=frozenset({("cases", "read")}))
    box = build_toolbox(ctx)
    names = box.names()
    assert "search_cases" in names and "get_case" in names and "explain_decision" in names
    assert "mitre_lookup" in names  # no grant needed
    assert "search_logs" not in names and "audit_search" not in names and "automation_status" not in names
    rendered = box.signatures()
    assert rendered.splitlines()[0].startswith("- ")
    assert "search_logs(" not in rendered and "search_cases(" in rendered


def test_custom_role_grants_shape_the_toolbox() -> None:
    """A custom role resolved through the real RBAC matrix: it inherits the tier-1
    analyst role, then DENIES sources:read and enrichment (deny-wins inside the role).
    The toolbox follows the resolved grants, with no audit write anywhere."""
    rbac = {
        "enabled": True,
        "custom_roles": [{
            "name": "case-reader",
            "inherits": ["analyst_tier1"],
            "grants": {"metrics": ["view"]},
            "denies": {"sources": ["read"], "enrichment": ["read"], "automation": ["read", "manage"]},
        }],
    }
    matrix = resolve_matrix(rbac)
    grants = frozenset(
        pair for pair in catalogue_grant_pairs()
        if can_for_roles("case-reader", [], pair[0], pair[1], matrix=matrix)
    )
    assert ("cases", "read") in grants and ("sources", "read") not in grants
    control, execution = RecordingAudit(), RecordingAudit()
    box = build_toolbox(make_ctx(grants=grants, control_audit=control, audit=execution))
    names = box.names()
    assert "soc_metrics" in names and "search_cases" in names
    assert "search_logs" not in names and "log_stats" not in names and "source_health" not in names
    assert "lookup_indicator" not in names
    infos = {i.name: i for i in catalogue_infos(grants)}
    assert infos["search_logs"].missing == ["sources:read"]
    assert "tuning" not in infos["automation_status"].kinds_allowed
    assert control.calls == [] and execution.calls == []


def test_scopes_filter_the_toolbox() -> None:
    box = build_toolbox(make_ctx(), scopes=["cases"])
    assert set(box.names()) <= {t.name for t in catalogue() if t.scope == "cases"}
    assert "search_cases" in box.names()


def test_zero_indicator_lookups_turns_the_tool_off() -> None:
    prefs = Preferences(chat_agent=ChatAgentConfig(max_indicator_lookups=0))
    box = build_toolbox(make_ctx(prefs=prefs))
    assert "lookup_indicator" not in box.names()


async def test_execute_refuses_ungranted_tool_with_one_access_denied_row() -> None:
    control = RecordingAudit()
    execution = RecordingAudit()
    ctx = make_ctx(grants=frozenset({("cases", "read")}), control_audit=control, audit=execution)
    box = build_toolbox(ctx)
    out = await box.execute("audit_search", {}, turn_id="turn-9", step=3, ordinal=2)
    assert out.status == "denied" and not out.ok
    assert "audit:view" in (out.error or "")
    assert len(control.calls) == 1
    row = control.calls[0]
    assert row["action_type"] == ActionType.ACCESS_DENIED
    assert row["surface"] == "chat" and row["actor"] == "alice" and row["tool_name"] == "audit_search"
    assert row["result_summary"].startswith("turn=turn-9 step=3")
    assert execution.calls == []


async def test_execute_refuses_ungranted_kind() -> None:
    control = RecordingAudit()
    ctx = make_ctx(grants=frozenset({("automation", "read")}), control_audit=control)
    box = build_toolbox(ctx)
    out = await box.execute("automation_status", {"kind": "approvals"}, turn_id="t", step=1)
    assert out.status == "denied"
    assert len(control.calls) == 1 and "proposals:read" in control.calls[0]["result_summary"]


async def test_execute_record_denial_false_leaves_the_row_to_the_caller() -> None:
    control = RecordingAudit()
    box = build_toolbox(make_ctx(grants=frozenset(), control_audit=control))
    out = await box.execute("search_cases", {}, record_denial=False)
    assert out.status == "denied" and control.calls == []


async def test_execute_unknown_and_out_of_scope_tools() -> None:
    control = RecordingAudit()
    box = build_toolbox(make_ctx(control_audit=control), scopes=["docs"])
    unknown = await box.execute("drop_table", {})
    assert unknown.status == "error" and unknown.error == "Unknown tool"
    skipped = await box.execute("search_cases", {})
    assert skipped.status == "skipped"
    assert control.calls == []  # a scope is a selection, not a permission


class _SlowTool(ChatTool):
    name: ClassVar[str] = "slow_probe"
    label: ClassVar[str] = "Slow probe"
    scope: ClassVar[str] = "platform"
    signature: ClassVar[str] = "slow_probe() -- test only"

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        await asyncio.sleep(5)
        return ToolOutcome(ok=True, summary="never")


class _BoomTool(ChatTool):
    name: ClassVar[str] = "boom_probe"
    label: ClassVar[str] = "Boom probe"
    scope: ClassVar[str] = "platform"
    signature: ClassVar[str] = "boom_probe() -- test only"

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        raise RuntimeError("secret connection string postgres://u:p@db")


class _EchoTool(ChatTool):
    name: ClassVar[str] = "echo_probe"
    label: ClassVar[str] = "Echo probe"
    scope: ClassVar[str] = "platform"
    signature: ClassVar[str] = "echo_probe(x?) -- test only"
    display_keys: ClassVar[tuple[str, ...]] = ("x",)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        call = current_call()
        return ToolOutcome(ok=True, summary=f"step {call.step if call else None}",
                           observation={"keys": sorted(inp)})


@pytest.fixture
def probe_catalogue(monkeypatch: pytest.MonkeyPatch):
    from app.agents.chat_tools import registry

    tools = catalogue() + (_SlowTool(), _BoomTool(), _EchoTool())
    monkeypatch.setattr(registry, "_CATALOGUE", tools)
    yield tools


async def test_execute_times_out_with_engine_template(probe_catalogue) -> None:
    audit = RecordingAudit()
    box = build_toolbox(make_ctx(audit=audit))
    out = await box.execute("slow_probe", {}, turn_id="t1", step=1, timeout_s=0.05)
    assert out.status == "timeout" and "timed out" in (out.error or "")
    assert len(audit.calls) == 1 and audit.calls[0]["action_type"] == ActionType.TOOL_CALL


async def test_execute_never_leaks_exception_text(probe_catalogue) -> None:
    audit = RecordingAudit()
    box = build_toolbox(make_ctx(audit=audit))
    out = await box.execute("boom_probe", {})
    assert out.status == "error"
    assert "postgres" not in (out.error or "") and "postgres" not in out.summary
    assert "postgres" not in str(audit.calls)


async def test_execute_drops_reserved_kwargs_and_binds_call(probe_catalogue) -> None:
    box = build_toolbox(make_ctx())
    out = await box.execute("echo_probe", {"x": 1, "ctx": "evil", "self": 2, "not-an-id": 3}, step=7)
    assert out.ok and out.observation == {"keys": ["x"]}
    assert out.summary == "step 7"
    assert current_call() is None  # the binding does not leak out of execute


async def test_execution_audit_row_shape(probe_catalogue) -> None:
    audit = RecordingAudit()
    box = build_toolbox(make_ctx(audit=audit, user=""))
    await box.execute("echo_probe", {"x": "v", "unlisted": "secret"}, turn_id="turn-1", step=4, ordinal=3)
    row = audit.calls[0]
    assert row["actor"] == "default"  # auth off
    assert row["surface"] == "chat" and row["tool_name"] == "echo_probe"
    assert row["tool_input"] == {"x": "v"}  # whitelisted display params only
    assert row["result_summary"].startswith("turn=turn-1 step=4 t3 echo_probe ok")


def test_audit_prefix_and_log_tools() -> None:
    assert audit_prefix(ToolCall(turn_id="abc def", step=2)) == "turn=abc?def step=2"
    assert audit_prefix(None) == ""
    assert LOG_TOOLS == {"search_logs", "log_stats"}


async def test_lookup_budget_is_reserved_and_released_by_execute() -> None:
    from app.enrichment.base import ProviderResult

    audit = RecordingAudit()
    ledger = TaintLedger(["check 8.8.8.8 and 1.1.1.1 and 9.9.9.9"], max_per_turn=1)
    answers: list[Any] = []

    async def enrich(value, kind):
        return list(answers)

    box = build_toolbox(make_ctx(audit=audit, enrich=enrich))
    # A refused value (private IP) does not consume the single lookup.
    refused = await box.execute("lookup_indicator", {"indicator": "10.1.1.1"}, taint=ledger)
    assert refused.status == "denied" and ledger.lookups == 0 and ledger.reserved == 0
    # No provider answered: the analyst got nothing, so the lookup is given back.
    unanswered = await box.execute("lookup_indicator", {"indicator": "9.9.9.9"}, taint=ledger)
    assert unanswered.ok and ledger.lookups == 0 and ledger.reserved == 0
    answers.append(ProviderResult(provider="abuseipdb", indicator="8.8.8.8", indicator_kind="ip", score=5))
    first = await box.execute("lookup_indicator", {"indicator": "8.8.8.8"}, taint=ledger)
    assert first.ok and ledger.lookups == 1
    second = await box.execute("lookup_indicator", {"indicator": "1.1.1.1"}, taint=ledger)
    assert second.status == "skipped" and "limit" in (second.error or "")


async def test_parallel_calls_see_their_own_call_identity(probe_catalogue) -> None:
    box = build_toolbox(make_ctx())
    outs = await asyncio.gather(*(box.execute("echo_probe", {}, step=i) for i in range(1, 6)))
    assert [o.summary for o in outs] == [f"step {i}" for i in range(1, 6)]


def test_call_scope_restores_previous_binding() -> None:
    outer = ToolCall(turn_id="a", step=1)
    with call_scope(outer):
        with call_scope(ToolCall(turn_id="b", step=2)):
            assert current_call().turn_id == "b"
        assert current_call() is outer
    assert current_call() is None


async def test_kind_aliases_cannot_bypass_the_kind_grant() -> None:
    """``proposals`` folds to ``approvals`` and ``runbooks`` to ``list_runbooks``: the
    grant check must see the folded kind, or an alias would skip that kind's grant."""
    control = RecordingAudit()
    box = build_toolbox(make_ctx(grants=frozenset({("automation", "read"), ("rag", "read")}),
                                 control_audit=control))
    for name, kind in (("automation_status", "proposals"), ("automation_status", "Baseline"),
                       ("search_knowledge", "runbooks"), ("search_knowledge", "playbooks")):
        out = await box.execute(name, {"kind": kind})
        assert out.status == "denied", (name, kind)
    assert len(control.calls) == 4
    # The tools re-check on their own too (an engine calling run directly).
    from app.agents.chat_tools.intel import SearchKnowledgeTool
    from app.agents.chat_tools.ops import AutomationStatusTool

    ctx = make_ctx(grants=frozenset({("automation", "read"), ("rag", "read")}))
    assert (await AutomationStatusTool().run(ctx, kind="proposals")).status == "denied"
    assert (await SearchKnowledgeTool().run(ctx, kind="runbooks")).status == "denied"


def test_prompt_signatures_list_only_the_callers_usable_kinds() -> None:
    """A model is never invited into a kind the caller cannot use (each attempt would
    write an ACCESS_DENIED row), nor into one the deployment cannot serve."""
    automation_only = build_toolbox(make_ctx(grants=frozenset({("automation", "read"), ("rag", "read")})))
    rendered = automation_only.signatures()
    line = next(ln for ln in rendered.splitlines() if ln.startswith("- automation_status("))
    assert "kind=tuning|schedulers|telemetry_gaps" in line
    assert "approvals" not in line and "baselines" not in line and "rule_versions" not in line
    knowledge = next(ln for ln in rendered.splitlines() if ln.startswith("- search_knowledge("))
    assert "list_runbooks" not in knowledge and "list_playbooks" not in knowledge
    # The catalogue instance is untouched: the next caller gets its own signature.
    full = build_toolbox(make_ctx())
    assert "list_runbooks" in next(ln for ln in full.signatures().splitlines()
                                    if ln.startswith("- search_knowledge("))
    # rules:read alone would only unlock rule_versions, which this context cannot
    # serve (no rule_versions store), so the tool stays out of the prompt.
    assert "automation_status" not in build_toolbox(make_ctx(grants=frozenset({("rules", "read")}))).names()


async def test_unknown_kind_of_a_kind_gated_tool_is_denied_without_any_kind_grant() -> None:
    control, audit = RecordingAudit(), RecordingAudit()
    box = build_toolbox(make_ctx(grants=frozenset({("cases", "read")}), control_audit=control, audit=audit))
    out = await box.execute("automation_status", {"kind": "bogus"})
    assert out.status == "denied" and len(control.calls) == 1 and audit.calls == []
    # A caller holding a kind grant reaches input validation instead (no denial row).
    control2 = RecordingAudit()
    box2 = build_toolbox(make_ctx(grants=frozenset({("automation", "read")}), control_audit=control2))
    bad = await box2.execute("automation_status", {"kind": "bogus"})
    assert bad.status == "error" and bad.error == "Invalid input: check kind" and control2.calls == []
