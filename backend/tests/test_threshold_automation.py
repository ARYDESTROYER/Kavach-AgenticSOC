"""Wave 6 / F10 — threshold automation (post-decision, #3-safe).

Offline tests (fake ES + mock LLM). They assert the central #3 boundary: automation
runs AFTER decide()+apply()+save and may ONLY tag / recommend / notify / attach a
runbook (Round 14; a run is human workflow, never a decision) / open a HITL Proposal. It can
NEVER set case.status/disposition, never auto-close, and decide() stays the ONLY
producer of CLOSED.
"""

from __future__ import annotations

import pytest

from app.config import (
    AutomationRule,
    Preferences,
    ThresholdAutomationConfig,
)
from app.constants import (
    AUDIT_WRITE_ALIAS,
    ActionType,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.case_manager import decide
from app.engine.threshold_automation import ThresholdAutomation, evaluate
from app.models import Case, Entity
from app.state import AppState


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _case(
    *, case_id: str = "c1", verdict: Verdict | None = Verdict.TRUE_POSITIVE,
    risk: float = 80.0, status: CaseStatus = CaseStatus.NEEDS_HUMAN,
    rule: str = "modsec_sqli", source_id: str = "src-1",
    entity_type: EntityType = EntityType.IP, ip: str = "203.0.113.5",
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=entity_type, value=ip),
        rule_ids=[rule],
        source_id=source_id,
        risk_score=risk,
        verdict=verdict,
        confidence=0.9,
        status=status,
    )


def _rule(id_: str, action: str, *, priority: int = 100, enabled: bool = True,
          conditions: dict | None = None, payload: dict | None = None) -> AutomationRule:
    return AutomationRule(
        id=id_, action=action, priority=priority, enabled=enabled,
        conditions=conditions or {}, payload=payload or {},
    )


def _prefs_with(rules: list[AutomationRule], *, enabled: bool = True) -> Preferences:
    return Preferences(
        threshold_automation=ThresholdAutomationConfig(enabled=enabled, rules=rules)
    )


# --------------------------------------------------------------------------- #
# evaluate() — matching + priority order + disabled-by-default
# --------------------------------------------------------------------------- #
def test_no_rules_by_default_yields_no_actions() -> None:
    # Autopilot overhaul: the ENGINE defaults ON, but the OOB Preferences ship NO rules,
    # so evaluate() is still a byte-identical no-op (nothing to match).
    prefs = Preferences()
    assert prefs.threshold_automation.enabled is True
    assert prefs.threshold_automation.rules == []
    assert evaluate(_case(), prefs) == []


def test_rules_match_in_priority_order() -> None:
    rules = [
        _rule("low", "tag", priority=300, payload={"tag": "c"}),
        _rule("high", "tag", priority=10, payload={"tag": "a"}),
        _rule("mid", "tag", priority=100, payload={"tag": "b"}),
    ]
    actions = evaluate(_case(), _prefs_with(rules))
    assert [a.rule_id for a in actions] == ["high", "mid", "low"]


def test_conditions_all_of_match() -> None:
    case = _case(verdict=Verdict.TRUE_POSITIVE, risk=80.0, rule="modsec_sqli",
                 source_id="src-1", entity_type=EntityType.IP)
    # Matches: all conditions hold.
    r = _rule("m", "tag", conditions={
        "verdict": "TRUE_POSITIVE", "min_risk": 50, "source_id": "src-1",
        "rule_name": "modsec_sqli", "entity_type": "ip",
    }, payload={"tag": "match"})
    assert [a.rule_id for a in evaluate(case, _prefs_with([r]))] == ["m"]

    # One condition fails (wrong verdict) → no match.
    r2 = _rule("nm", "tag", conditions={"verdict": "FALSE_POSITIVE"})
    assert evaluate(case, _prefs_with([r2])) == []

    # min_risk above the case risk → no match.
    r3 = _rule("nm2", "tag", conditions={"min_risk": 99})
    assert evaluate(case, _prefs_with([r3])) == []

    # status condition.
    r4 = _rule("st", "tag", conditions={"status": "needs_human"})
    assert [a.rule_id for a in evaluate(case, _prefs_with([r4]))] == ["st"]


def test_disabled_rule_skipped() -> None:
    rules = [_rule("off", "tag", enabled=False), _rule("on", "tag")]
    assert [a.rule_id for a in evaluate(_case(), _prefs_with(rules))] == ["on"]


# --------------------------------------------------------------------------- #
# execute() — SAFE actions apply directly (#3-safe)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_tag_and_recommend_apply_without_touching_status(app_state: AppState) -> None:
    case = _case(case_id="ct", status=CaseStatus.NEEDS_HUMAN)
    await app_state.cases.save(case)
    rules = [
        _rule("tag1", "tag", priority=10, payload={"tag": "auto-high-risk"}),
        _rule("rec1", "recommend", priority=20, payload={"text": "isolate the host"}),
    ]
    prefs = _prefs_with(rules)

    status_before, disposition_before = case.status, case.disposition
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    await automation.run(case, prefs, save=app_state.cases.save)

    # SAFE actions applied: tag + a recommendation comment.
    assert "auto-high-risk" in case.tags
    assert any("isolate the host" in c.body for c in case.comments)
    # Status / disposition are UNTOUCHED (#3).
    assert case.status == status_before
    assert case.disposition == disposition_before
    # Each action recorded on the additive audit list.
    assert {a["action"] for a in case.automation_actions} == {"tag", "recommend"}
    # ...and persisted.
    reloaded = await app_state.cases.get("ct")
    assert "auto-high-risk" in reloaded.tags


@pytest.mark.asyncio
async def test_notify_action_dispatches_via_callback(app_state: AppState) -> None:
    case = _case(case_id="cn")
    await app_state.cases.save(case)
    seen: list[tuple[str, str]] = []

    async def _notify(c, trigger):
        seen.append((c.case_id, trigger))

    automation = ThresholdAutomation(app_state.proposals, app_state.audit, notify=_notify)
    rules = [_rule("n", "notify", payload={"trigger": "escalated"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert seen == [("cn", "escalated")]
    assert case.status == CaseStatus.NEEDS_HUMAN  # unchanged


# --------------------------------------------------------------------------- #
# request_approval → HITL Proposal (NO live write)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_request_approval_creates_pending_proposal_no_live_write(app_state: AppState) -> None:
    case = _case(case_id="ca")
    await app_state.cases.save(case)
    suppression_before = list(app_state.prefs.suppression_rules)

    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("appr", "request_approval", payload={
        "kind": "suppression", "field": "event.module", "value": "modsec_sqli",
        "confidence": 0.7,
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    # A PENDING proposal exists; nothing was written live.
    pending = await app_state.proposals.list(status="pending")
    assert any(p.source_case_ids == ["ca"] and p.created_by == "automation" for p in pending)
    # No live suppression rule materialised (only approval writes live).
    assert list(app_state.prefs.suppression_rules) == suppression_before
    # The case records the proposal id, status untouched.
    appr = [a for a in case.automation_actions if a["action"] == "request_approval"]
    assert appr and appr[0].get("proposal_id")
    assert case.status == CaseStatus.NEEDS_HUMAN


# --------------------------------------------------------------------------- #
# bug #11 — request_approval proposals ROUND-TRIP through Approvals/Proposals.
#
# Before: a generic ``request_approval`` (no field/value) forced kind="suppression",
# so approving it 400'd ("invalid suppression payload") — a dead end. Now the kind is
# resolved to one the approve path can process: a COMPLETE suppression stays
# suppression; explicit Memory stays Memory; anything else becomes an
# acknowledgement-only automation review that always approves cleanly.
# --------------------------------------------------------------------------- #
def test_resolve_proposal_kind_round_trips() -> None:
    from app.engine.threshold_automation import _resolve_proposal_kind

    # A complete suppression payload → suppression (round-trips to a live rule).
    assert _resolve_proposal_kind({"field": "event.module", "value": "sqli"}) == "suppression"
    assert _resolve_proposal_kind(
        {"kind": "suppression", "field": "f", "value": "v"}
    ) == "suppression"
    # A PARTIAL suppression becomes review-only acknowledgement — never emit a kind
    # the approve path would 400 on or materialise it as something stronger.
    assert _resolve_proposal_kind(
        {"kind": "suppression", "field": "f"}
    ) == "automation_ack"
    assert _resolve_proposal_kind({"kind": "suppression"}) == "automation_ack"
    # An explicit Memory stays Memory; a generic gate is acknowledgement-only.
    assert _resolve_proposal_kind({"kind": "memory", "text": "note"}) == "memory"
    assert _resolve_proposal_kind({}) == "automation_ack"
    # An unknown requested kind remains safely reviewable without acquiring Memory
    # semantics.
    assert _resolve_proposal_kind({"kind": "escalate"}) == "automation_ack"


@pytest.mark.asyncio
async def test_generic_request_approval_proposal_is_approvable(app_state: AppState) -> None:
    """A generic ``request_approval`` (no suppression shape) must be APPROVABLE — not a
    dead end. It becomes an acknowledgement-only review and round-trips through the
    REAL approve route without a 400 or unrelated materialisation."""
    from app.api.routes import approve_proposal

    case = _case(case_id="approvable")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    # A generic approval gate — NO field/value, NO explicit kind.
    rules = [_rule("gate", "request_approval", payload={
        "rationale": "Escalation requires a lead's sign-off.",
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    pending = await app_state.proposals.list(status="pending")
    prop = next(p for p in pending if p.source_case_ids == ["approvable"])
    assert prop.kind == "automation_ack"
    assert (prop.payload or {}).get("rule_id") == "gate"
    assert not (prop.payload or {}).get("text")

    # The full round-trip: approval marks the checkpoint reviewed, but creates no
    # Memory, suppression, preference, or case-lifecycle side effect.
    status_before = case.status
    memories_before = [m.model_dump(mode="json") for m in await app_state.memory.list(False)]
    prefs_before = app_state.execution_prefs.model_dump(mode="json")
    res = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert res["ok"] is True
    approved = await app_state.proposals.get(prop.id)
    assert approved is not None and approved.status == "approved"
    assert case.status == status_before  # approval never touches the case lifecycle (#3)
    assert [m.model_dump(mode="json") for m in await app_state.memory.list(False)] == memories_before
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before


@pytest.mark.asyncio
async def test_explicit_memory_request_approval_still_materialises_memory(
    app_state: AppState,
) -> None:
    """The new generic review kind must not weaken a deliberate Memory proposal."""
    from app.api.routes import approve_proposal

    case = _case(case_id="memory")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("remember", "request_approval", payload={
        "kind": "memory",
        "text": "The approved maintenance scanner uses the internal relay.",
        "category": "operations",
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    prop = next(
        p for p in await app_state.proposals.list(status="pending")
        if p.source_case_ids == ["memory"]
    )
    assert prop.kind == "memory"
    res = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert res["ok"] is True
    memories = await app_state.memory.list(False)
    assert any(
        m.text == "The approved maintenance scanner uses the internal relay."
        and m.review_status == "approved"
        for m in memories
    )


@pytest.mark.asyncio
async def test_concurrent_memory_approval_materialises_exactly_once(
    app_state: AppState,
) -> None:
    """Only one strict pending->applying claim may cross the side-effect boundary."""
    import asyncio

    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.models import Proposal

    prop = Proposal(
        kind="memory",
        payload={"text": "The maintenance relay is approved."},
        rationale="Record a reviewed fact.",
    )
    await app_state.proposals.add(prop)
    req = _ApproveRequest(app_state)
    results = await asyncio.gather(
        approve_proposal(prop.id, req, state=app_state),
        approve_proposal(prop.id, req, state=app_state),
        return_exceptions=True,
    )

    assert sum(isinstance(result, dict) and result.get("ok") is True for result in results) == 1
    conflicts = [result for result in results if isinstance(result, HTTPException)]
    assert len(conflicts) == 1 and conflicts[0].status_code == 409
    materialised = [
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]
    assert len(materialised) == 1


@pytest.mark.asyncio
async def test_memory_approval_storage_failure_is_visible_and_retryable(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fail-soft KV write can never become a reported trusted-Memory success."""
    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.constants import MEMORY_NS
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Must persist before trust."})
    await app_state.proposals.add(prop)
    original = app_state.memory._kv.put_if_strict

    async def _fail_memory(namespace, key, value, expected_rev):
        if namespace == MEMORY_NS:
            raise RuntimeError("memory store unavailable")
        return await original(namespace, key, value, expected_rev)

    monkeypatch.setattr(app_state.memory._kv, "put_if_strict", _fail_memory)
    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert caught.value.status_code == 503
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert "memory store unavailable" in str(stored.approval_error)
    assert not any(m.approval_proposal_id == prop.id for m in await app_state.memory.list(False))


@pytest.mark.asyncio
async def test_retry_after_finalize_failure_does_not_duplicate_memory(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A confirmed side effect is reused if strict proposal finalisation must retry."""
    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Exactly-once reviewed fact."})
    await app_state.proposals.add(prop)
    original = app_state.proposals.finalize_approval
    calls = 0

    async def _fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("proposal finalisation unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(app_state.proposals, "finalize_approval", _fail_once)
    with pytest.raises(HTTPException) as first:
        await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert first.value.status_code == 503
    assert len([
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]) == 1
    audit = await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:approve"
    )
    assert audit is not None
    assert f"proposal_id={prop.id}" in str(audit.get("result_summary"))

    second = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert second["ok"] is True
    assert len([
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]) == 1


@pytest.mark.asyncio
async def test_approval_crash_after_audit_keeps_first_actor_on_different_operator_retry(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale retry confirms the first immutable effect/audit instead of reattributing."""
    from app.api import routes as routes_module
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Alice reviewed this fact."})
    await app_state.proposals.add(prop)
    claimed, outcome = await app_state.proposals.claim_approval(
        prop.id, by="alice", token="approval-before-crash"
    )
    assert outcome == "claimed" and claimed is not None
    assert claimed.decision_actor == "alice"

    # The first process durably completed its effect and audit, then died before
    # proposal finalisation. These writes are the state the second process sees.
    await app_state.memory.add_approved_proposal_strict(
        "Alice reviewed this fact.",
        proposal_id=prop.id,
        author="alice",
    )
    await app_state.control_audit.record_strict(
        action_type=ActionType.PROPOSAL,
        event_id=f"proposal-decision:{prop.id}:approve",
        ts=claimed.decision_audit_at,
        surface="proposal",
        actor="alice",
        result_summary=(
            f"proposal_id={prop.id} action=approve kind=memory "
            "decision=authorized effect=pending finalization=pending"
        ),
    )

    monkeypatch.setattr(
        type(app_state.proposals),
        "_lease_is_stale",
        staticmethod(lambda _proposal: True),
    )
    monkeypatch.setattr(routes_module, "current_username", lambda _request: "bob")
    retried = await routes_module.approve_proposal(
        prop.id, _ApproveRequest(app_state), state=app_state
    )

    assert retried["ok"] is True
    assert "decision_actor" not in retried["proposal"]
    assert "applying_token" not in retried["proposal"]
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.decided_by == "alice"
    assert stored.decision_actor == "alice"
    memories = [
        item for item in await app_state.memory.list(False)
        if item.approval_proposal_id == prop.id
    ]
    assert len(memories) == 1 and memories[0].author == "alice"
    audit = await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:approve"
    )
    assert audit is not None and audit["actor"] == "alice"


@pytest.mark.asyncio
async def test_approval_audit_failure_is_visible_and_retryable_without_duplicate_effect(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No approval success is reported without strict append-only evidence.

    The decision record is written BEFORE the effect, so an audit failure leaves the
    configuration untouched — an operator told the approval failed must never find
    the change already applied. The retry then converges on exactly one effect.
    """
    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Audited reviewed fact."})
    await app_state.proposals.add(prop)
    original = app_state.control_audit.record_strict
    calls = 0

    async def _fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("audit ledger unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(app_state.control_audit, "record_strict", _fail_once)
    with pytest.raises(HTTPException) as first:
        await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert first.value.status_code == 503
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert "audit ledger unavailable" in str(stored.approval_error)
    assert [
        item for item in await app_state.memory.list(False)
        if item.approval_proposal_id == prop.id
    ] == []

    retried = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert retried["ok"] is True
    assert len([
        item for item in await app_state.memory.list(False)
        if item.approval_proposal_id == prop.id
    ]) == 1
    assert await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:approve"
    ) is not None


@pytest.mark.asyncio
async def test_rejection_audit_failure_keeps_proposal_retryable(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject uses the same strict claim/audit/finalise boundary as approve."""
    from fastapi import HTTPException

    from app.api.routes import reject_proposal
    from app.models import Proposal

    prop = Proposal(kind="automation_ack", rationale="Lead review")
    await app_state.proposals.add(prop)
    original = app_state.control_audit.record_strict
    calls = 0

    async def _fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("audit ledger unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(app_state.control_audit, "record_strict", _fail_once)
    with pytest.raises(HTTPException) as first:
        await reject_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert first.value.status_code == 503
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert stored.decision_intent == "reject"

    retried = await reject_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert retried["ok"] is True
    assert retried["proposal"]["status"] == "rejected"
    assert "applying_token" not in retried["proposal"]
    assert await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:reject"
    ) is not None


@pytest.mark.asyncio
async def test_rejection_crash_after_audit_keeps_first_actor_on_retry(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A different operator can recover a stale rejection without owning its audit."""
    from app.api import routes as routes_module
    from app.models import Proposal

    prop = Proposal(kind="automation_ack", rationale="Review this checkpoint.")
    await app_state.proposals.add(prop)
    claimed, outcome = await app_state.proposals.claim_rejection(
        prop.id, by="alice", token="rejection-before-crash"
    )
    assert outcome == "claimed" and claimed is not None
    await app_state.control_audit.record_strict(
        action_type=ActionType.PROPOSAL,
        event_id=f"proposal-decision:{prop.id}:reject",
        ts=claimed.decision_audit_at,
        surface="proposal",
        actor="alice",
        result_summary=(
            f"proposal_id={prop.id} action=reject kind=automation_ack "
            "effect=none finalization=pending"
        ),
    )

    monkeypatch.setattr(
        type(app_state.proposals),
        "_lease_is_stale",
        staticmethod(lambda _proposal: True),
    )
    monkeypatch.setattr(routes_module, "current_username", lambda _request: "bob")
    retried = await routes_module.reject_proposal(
        prop.id, _ApproveRequest(app_state), state=app_state
    )

    assert retried["ok"] is True
    assert "decision_actor" not in retried["proposal"]
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.decided_by == "alice"
    assert stored.decision_actor == "alice"
    audit = await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:reject"
    )
    assert audit is not None and audit["actor"] == "alice"


@pytest.mark.asyncio
async def test_complete_suppression_request_approval_still_round_trips(app_state: AppState) -> None:
    """A ``request_approval`` carrying a COMPLETE suppression payload keeps the
    suppression round-trip (approving it adds a live rule) — no regression."""
    from app.api.routes import approve_proposal

    case = _case(case_id="suppr")
    await app_state.cases.save(case)
    n_rules_before = len(app_state.prefs.suppression_rules)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("appr", "request_approval", payload={
        "kind": "suppression", "field": "event.module", "value": "modsec_sqli",
        "confidence": 0.7,
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    prop = next(
        p for p in await app_state.proposals.list(status="pending")
        if p.source_case_ids == ["suppr"]
    )
    assert prop.kind == "suppression"
    res = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert res["ok"] is True
    # A live suppression rule was materialised by the approve path.
    assert len(app_state.prefs.suppression_rules) == n_rules_before + 1


class _ApproveRequest:
    """Minimal Request stand-in for the approve route (auth OFF in tests → the route's
    ``current_username`` resolves to '' without a cookie). Exposes ``app.state.tlsoc``
    so ``get_state(request)`` resolves the live AppState."""

    def __init__(self, state: AppState) -> None:
        self.headers = {}
        self.cookies = {}
        self.scope = {"type": "http"}
        self.app = type("_App", (), {"state": type("_S", (), {"tlsoc": state})()})()


# --------------------------------------------------------------------------- #
# run_playbook → ATTACHES a runbook (Round 14 SPEC §4.10.16, §4.10.18). Before
# Round 14 it queued a forced re-investigation; the stored action keeps its name.
# --------------------------------------------------------------------------- #
class _Attacher:
    """Records every ``attach(case, runbook_id, rule_id)`` call."""

    def __init__(self, result: object = "run") -> None:
        self.calls: list[tuple[str, str | None, str]] = []
        self.result = result

    async def __call__(self, case, runbook_id, rule_id):
        self.calls.append((case.case_id, runbook_id, rule_id))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.mark.asyncio
@pytest.mark.parametrize(("payload", "migrated", "expected"), [
    # What the Rule editor's "Attach a runbook" writes.
    ({"runbook_id": "phishing-suspicious-email"}, {}, "phishing-suspicious-email"),
    # runbook_id wins over a legacy playbook_id.
    ({"runbook_id": "malware-endpoint", "playbook_id": "brute_force_login"}, {}, "malware-endpoint"),
    # A retired bundled procedure id the map does not hold (the migration map leaves
    # out a stored copy the bundled procedure shadowed): the merged built-in.
    ({"playbook_id": "brute_force_login"}, {"acme-login": "acme-login-2"}, "brute-force-password-spray"),
    # The map holds a retired bundled id only when a configured folder's file held it,
    # and that file is what the rule ran: its migrated runbook.
    ({"playbook_id": "brute_force_login"}, {"brute_force_login": "brute_force_login-imported"},
     "brute_force_login-imported"),
    # An operator procedure through the migration's id map.
    ({"playbook_id": "acme-login"}, {"acme-login": "acme-login-2"}, "acme-login-2"),
    # A retired reference runbook id before (or without) the migration.
    ({"playbook_id": "malware"}, {}, "malware-endpoint"),
    # An id that resolves to nothing still reaches the attacher, so its skip row (and
    # the case's record) names the id that failed.
    ({"playbook_id": "custom_pb"}, {}, "custom_pb"),
    # Names nothing: the attacher still runs so it records the skip.
    ({}, {}, None),
])
async def test_run_playbook_attaches_the_runbook_resolved_at_fire_time(
    app_state: AppState, payload: dict, migrated: dict, expected: str | None,
) -> None:
    case = _case(case_id="cp")
    await app_state.cases.save(case)
    attach = _Attacher()

    async def _migrated():
        return migrated

    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=_migrated,
    )
    rules = [_rule("pb", "run_playbook", payload=payload)]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert attach.calls == [("cp", expected, "pb")]
    # The stored rule is never rewritten (load order against the migration).
    assert rules[0].payload == payload
    assert case.status == CaseStatus.NEEDS_HUMAN  # an attach never moves status (#3)
    assert case.disposition is None
    detail = case.automation_actions[-1]["detail"]
    assert detail == f"attach_runbook={expected or '(none)'} attached=True"


@pytest.mark.asyncio
async def test_run_playbook_without_an_attacher_attaches_nothing(app_state: AppState) -> None:
    case = _case(case_id="cpn")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("pb", "run_playbook", payload={"playbook_id": "brute_force_login"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert case.automation_actions[-1]["detail"] == (
        "attach_runbook=brute-force-password-spray attached=False"
    )
    assert case.status == CaseStatus.NEEDS_HUMAN


@pytest.mark.asyncio
async def test_run_playbook_failures_never_break_the_case_path(app_state: AppState) -> None:
    """A failing attacher and an unreadable id map: the rule still records its action,
    resolves through the retired bundled ids, and the case path carries on."""
    case = _case(case_id="cpf")
    await app_state.cases.save(case)
    attach = _Attacher(result=RuntimeError("store down"))

    async def _broken_map():
        raise RuntimeError("marker unreadable")

    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=_broken_map,
    )
    rules = [
        _rule("pb", "run_playbook", payload={"playbook_id": "ransomware_response"}, priority=1),
        _rule("t", "tag", payload={"tag": "after"}, priority=2),
    ]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert attach.calls == [("cpf", "ransomware-destructive", "pb")]
    assert case.automation_actions[0]["detail"] == "attach_runbook=ransomware-destructive attached=False"
    assert "after" in case.tags  # the next rule still ran
    assert case.status == CaseStatus.NEEDS_HUMAN


@pytest.mark.asyncio
async def test_run_playbook_reports_not_attached_when_the_attacher_skips(app_state: AppState) -> None:
    case = _case(case_id="cps")
    await app_state.cases.save(case)
    attach = _Attacher(result=None)  # skipped (with its own audit row) or already there
    automation = ThresholdAutomation(app_state.proposals, app_state.audit, attach_runbook=attach)
    rules = [_rule("pb", "run_playbook", payload={"runbook_id": "data-exfiltration"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert case.automation_actions[-1]["detail"] == "attach_runbook=data-exfiltration attached=False"


async def _runs(state: AppState, case_id: str) -> list:
    return list((await state.runbook_runs.get(case_id)).runs)


@pytest.mark.asyncio
async def test_a_run_playbook_rule_attaches_a_runbook_on_the_real_stack(app_state: AppState) -> None:
    """The bound automation attaches through ``runbook_runs.attach_by_automation``:
    a ``run.attached`` row with actor ``threshold_automation``, the run marked as
    attached by a rule, and the case status untouched (#3)."""
    from app.engine.threshold_automation import bind_runbook_automation

    case = _case(case_id="real-attach")
    await app_state.cases.save(case)
    attach, migrated = bind_runbook_automation(app_state)
    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=migrated,
    )
    rules = [_rule("pb", "run_playbook", payload={"playbook_id": "brute_force_login"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    runs = await _runs(app_state, "real-attach")
    assert [r.runbook_id for r in runs] == ["brute-force-password-spray"]
    assert runs[0].attached_by == "rule"
    assert runs[0].attached_reason.get("automation_rule") == "pb"
    assert case.automation_actions[-1]["detail"] == (
        "attach_runbook=brute-force-password-spray attached=True"
    )
    assert case.status == CaseStatus.NEEDS_HUMAN
    rows = await app_state.audit.records_for_actor("threshold_automation", limit=20)
    assert "run.attached" in {r.get("action") for r in rows}

    # Idempotent per case and runbook (#4): a second firing attaches nothing new.
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert len(await _runs(app_state, "real-attach")) == 1
    assert case.automation_actions[-1]["detail"].endswith("attached=False")


@pytest.mark.asyncio
async def test_a_rule_naming_an_unknown_runbook_is_skipped_with_a_reason(app_state: AppState) -> None:
    from app.engine.threshold_automation import bind_runbook_automation

    case = _case(case_id="real-skip")
    await app_state.cases.save(case)
    attach, migrated = bind_runbook_automation(app_state)
    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=migrated,
    )
    rules = [_rule("pb", "run_playbook", payload={"runbook_id": "no-such-runbook"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert await _runs(app_state, "real-skip") == []
    rows = await app_state.audit.records_for_actor("threshold_automation", limit=20)
    skipped = [r for r in rows if r.get("action") == "run.attach_skipped"]
    assert skipped and "does not exist" in skipped[0].get("result_summary", "")
    assert case.status == CaseStatus.NEEDS_HUMAN


@pytest.mark.asyncio
async def test_a_rule_naming_an_unmigrated_procedure_records_the_id_it_skipped(app_state: AppState) -> None:
    """SPEC §4.10.16 "Needs a runbook": a stored ``playbook_id`` that resolves to
    nothing is skipped as a runbook that does not exist, and the skip row and the
    case's record name that id, so the audit says which legacy id failed (#2)."""
    from app.engine.threshold_automation import bind_runbook_automation

    case = _case(case_id="real-unmigrated")
    await app_state.cases.save(case)
    attach, migrated = bind_runbook_automation(app_state)
    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=migrated,
    )
    rules = [_rule("pb", "run_playbook", payload={"playbook_id": "custom_pb"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert await _runs(app_state, "real-unmigrated") == []
    rows = await app_state.audit.records_for_actor("threshold_automation", limit=20)
    skipped = [r for r in rows if r.get("action") == "run.attach_skipped"]
    assert len(skipped) == 1
    assert skipped[0]["tool_input"]["runbook_id"] == "custom_pb"
    assert "does not exist" in skipped[0]["result_summary"]
    assert case.automation_actions[-1]["detail"] == "attach_runbook=custom_pb attached=False"


@pytest.mark.asyncio
async def test_a_folder_procedure_with_a_bundled_id_attaches_its_migrated_runbook(app_state: AppState) -> None:
    """SPEC §4.10.16: ``payload.playbook_id`` resolves through the migration's id map.
    A configured folder's file that held a retired bundled id was the live procedure a
    rule naming that id ran, so the rule attaches its migrated runbook; a stored copy
    the bundled procedure shadowed never does (the built-in wins)."""
    from app.engine.threshold_automation import ThresholdAutomation as _Automation

    attach = _Attacher()
    for id_map, expected in (
        ({"playbook_dir:brute_force_login": "brute_force_login-imported",
          "playbooks:brute_force_login": "brute_force_login-imported-2"}, "brute_force_login-imported"),
        ({"playbooks:brute_force_login": "brute_force_login-imported"}, "brute-force-password-spray"),
    ):
        from app.engine.runbook_migration import migrated_procedure_ids

        async def _migrated(id_map=id_map):
            return migrated_procedure_ids({"id_map": id_map})

        case = _case(case_id=f"folder-{len(attach.calls)}")
        await app_state.cases.save(case)
        automation = _Automation(
            app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=_migrated,
        )
        rules = [_rule("pb", "run_playbook", payload={"playbook_id": "brute_force_login"})]
        await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
        assert attach.calls[-1] == (case.case_id, expected, "pb")


@pytest.mark.asyncio
async def test_the_bound_attacher_records_a_skip_in_the_real_audit_while_demo_mode_is_on(
    app_state: AppState,
) -> None:
    """While Demo Mode is on the active run store and audit are the Demo ones, so a
    real case's rule attaches nothing; its ``run.attach_skipped`` row (with the reason)
    lands in the REAL control audit, never the Demo one (#2)."""
    from app.engine.threshold_automation import DEMO_MODE_SKIP_REASON, bind_runbook_automation

    case = _case(case_id="demo-on")
    real_audit = app_state.control_audit

    class _DemoState:
        demo_active = True
        runbook_library = None
        control_audit = real_audit

    attach, migrated = bind_runbook_automation(_DemoState())
    assert await attach(case, "brute-force-password-spray", "pb") is None
    assert await migrated() == {}
    rows = await real_audit.records_for_actor("threshold_automation", limit=20)
    skipped = [r for r in rows if r.get("action") == "run.attach_skipped"]
    assert len(skipped) == 1
    row = skipped[0]
    assert row["case_id"] == "demo-on"
    assert row["tool_input"] == {"runbook_id": "brute-force-password-spray", "rule_id": "pb",
                                 "reason": DEMO_MODE_SKIP_REASON}
    assert row["result_summary"] == f"No runbook attached: {DEMO_MODE_SKIP_REASON}"
    assert "\u2014" not in DEMO_MODE_SKIP_REASON

    class _NoAudit:
        demo_active = True
        runbook_library = None

    no_audit_attach, _ = bind_runbook_automation(_NoAudit())
    assert await no_audit_attach(case, None, "pb") is None  # never raises


@pytest.mark.asyncio
async def test_the_demo_bound_attacher_attaches_into_the_demo_stack_only(app_state: AppState) -> None:
    """D45 parity (SPEC §4.10.16): a Demo stack's automation attaches a ``run_playbook``
    rule's runbook into the DEMO run store and writes its ``run.attached`` row to the
    DEMO audit, never the real ones. Once that stack is no longer active (Demo Mode off)
    the same callable attaches nothing and writes nothing anywhere."""
    from app.engine.threshold_automation import bind_demo_runbook_automation

    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    stack = app_state._demo  # noqa: SLF001 - the stack this automation belongs to
    real_audit = app_state.control_audit
    attach, migrated = bind_demo_runbook_automation(app_state, lambda: app_state._demo is stack)  # noqa: SLF001
    assert await migrated() == {}  # the real marker, read only (none on a fresh store)
    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, attach_runbook=attach, migrated_procedures=migrated,
    )
    case = _case(case_id="demo-rule")
    await app_state.cases.save(case)
    rules = [_rule("pb", "run_playbook", payload={"playbook_id": "brute_force_login"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    demo_runs = list((await app_state.runbook_runs.get("demo-rule")).runs)
    assert [r.runbook_id for r in demo_runs] == ["brute-force-password-spray"]
    assert demo_runs[0].attached_by == "rule"
    assert list((await app_state.real_runbook_runs.get("demo-rule")).runs) == []
    demo_rows = await stack.audit.records_for_actor("threshold_automation", limit=20)
    assert "run.attached" in {r.get("action") for r in demo_rows}
    real_rows = await real_audit.records_for_actor("threshold_automation", limit=20)
    assert not [r for r in real_rows if str(r.get("action", "")).startswith("run.")]
    assert case.automation_actions[-1]["detail"] == (
        "attach_runbook=brute-force-password-spray attached=True"
    )
    assert case.status == CaseStatus.NEEDS_HUMAN  # an attach never moves status (#3)

    await app_state.disable_demo()
    assert await attach(_case(case_id="after-demo"), "brute-force-password-spray", "pb") is None
    assert list((await app_state.runbook_runs.get("after-demo")).runs) == []
    real_rows = await real_audit.records_for_actor("threshold_automation", limit=20)
    assert not [r for r in real_rows if str(r.get("action", "")).startswith("run.")]

    def _broken() -> bool:
        raise RuntimeError("stack unknown")

    broken_attach, _ = bind_demo_runbook_automation(app_state, _broken)
    assert await broken_attach(_case(case_id="broken"), "malware-endpoint", "pb") is None


@pytest.mark.asyncio
async def test_a_migrated_shadowed_copy_never_hijacks_a_rule_naming_the_bundled_id(
    secrets, mock_provider,
) -> None:
    """HANDOFF (A3, A7a): a rule naming ``brute_force_login``, with a stored operator
    document of that id that the bundled procedure shadowed (migrated as the Draft
    ``brute_force_login-imported``), attaches ``brute-force-password-spray`` and is
    not skipped. A rule naming a migrated operator procedure attaches its runbook."""
    from app.constants import PLAYBOOKS_KEY, PLAYBOOKS_NS
    from app.engine.threshold_automation import bind_runbook_automation
    from app.es.fake import InMemoryESClient
    from app.stores.memory import EsKVStore

    def _procedure(doc_id: str, title: str) -> str:
        # The legacy procedure shape (as in test_runbook_migration.py).
        return (
            f"---\nid: {doc_id}\nname: {title}\n"
            "description: Work a suspicious sign-in from an unexpected place.\n"
            "match:\n  rule_ids: [vpn_auth]\n  entity_types: [ip, user]\n  mitre: [T1078]\n"
            "  min_event_count: 3\npriority: 60\nrag_queries: [vpn sign-in policy]\n"
            "escalate_if: A sign-in succeeds from the flagged address.\n---\n"
            "## Look at part 1\nCheck the sign-in records for part 1. Note anything unusual.\n\n"
            "## Look at part 2\nCheck the sign-in records for part 2. Note anything unusual.\n"
        )

    es = InMemoryESClient()
    await EsKVStore(es).put(PLAYBOOKS_NS, PLAYBOOKS_KEY, {"documents": {
        doc_id: {"content": _procedure(doc_id, title), "revision": 2, "created_by": "alice",
                 "updated_by": "alice", "created_at": "2026-01-01T00:00:00+00:00",
                 "updated_at": "2026-01-02T00:00:00+00:00"}
        for doc_id, title in (("brute_force_login", "Our brute force copy"), ("acme-login", "Acme sign-in"))
    }})
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    try:
        marker = (await state.runbook_library.read_marker()).marker
        assert marker.id_map["playbooks:brute_force_login"] == "brute_force_login-imported"
        attach, migrated = bind_runbook_automation(state)
        assert "brute_force_login" not in await migrated()
        automation = ThresholdAutomation(
            state.proposals, state.audit, attach_runbook=attach, migrated_procedures=migrated,
        )
        bundled = _case(case_id="shadow-1")
        await state.cases.save(bundled)
        await automation.run(bundled, _prefs_with([
            _rule("pb", "run_playbook", payload={"playbook_id": "brute_force_login"}),
        ]), save=state.cases.save)
        assert [r.runbook_id for r in await _runs(state, "shadow-1")] == ["brute-force-password-spray"]
        rows = await state.audit.records_for_actor("threshold_automation", limit=20)
        assert not [r for r in rows if r.get("action") == "run.attach_skipped"]

        operator = _case(case_id="shadow-2")
        await state.cases.save(operator)
        await automation.run(operator, _prefs_with([
            _rule("pb2", "run_playbook", payload={"playbook_id": "acme-login"}),
        ]), save=state.cases.save)
        assert [r.runbook_id for r in await _runs(state, "shadow-2")] == [
            marker.id_map["playbooks:acme-login"],
        ]
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# THE #3 GUARDRAIL — automation can NEVER set status; NEEDS_HUMAN/escalated never close
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_automation_cannot_close_a_needs_human_case(app_state: AppState) -> None:
    case = _case(case_id="cnh", verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN)
    await app_state.cases.save(case)
    # Even a malicious-looking rule can only tag/recommend/notify/queue/propose — none
    # of which write status. The executor double-asserts status didn't move.
    rules = [
        _rule("t", "tag", payload={"tag": "x"}),
        _rule("r", "recommend", payload={"text": "y"}),
    ]
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert case.status != CaseStatus.CLOSED


@pytest.mark.asyncio
async def test_executor_raises_if_an_action_mutated_status(app_state: AppState, monkeypatch) -> None:
    """Defence-in-depth: if a future action ever mutated status, the executor's
    post-run #3 assertion fires (status is byte-stable across automation)."""
    case = _case(case_id="cmut")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)

    # Patch _execute_one to illegally close the case (simulating a regression).
    async def _bad(c, action, prefs):
        c.status = CaseStatus.CLOSED
        return True

    monkeypatch.setattr(automation, "_execute_one", _bad)
    rules = [_rule("bad", "tag")]
    with pytest.raises(AssertionError):
        await automation.run(case, _prefs_with(rules), save=app_state.cases.save)


# --------------------------------------------------------------------------- #
# decide() is the ONLY producer of CLOSED (verdict math byte-identical)
# --------------------------------------------------------------------------- #
def test_decide_is_only_producer_of_closed() -> None:
    """Automation must never short-circuit the close decision. Sweep verdict/risk
    combos and assert CLOSED only ever comes from decide() (per the policy)."""
    prefs = Preferences()
    policy = prefs.auto_close

    # FP clears the FP bar (default enabled, min_conf 0.85, max_risk 30) → CLOSED.
    d = decide(Verdict.FALSE_POSITIVE, 0.9, 10.0, policy)
    assert d.status == CaseStatus.CLOSED and d.decision_by == DecisionBy.AGENT

    # NEEDS_HUMAN never closes regardless of inputs.
    for conf in (0.0, 0.5, 1.0):
        d = decide(Verdict.NEEDS_HUMAN, conf, 0.0, policy)
        assert d.status != CaseStatus.CLOSED

    # TP default policy is disabled → never closes (even at high confidence).
    d = decide(Verdict.TRUE_POSITIVE, 0.99, 5.0, policy)
    assert d.status != CaseStatus.CLOSED

    # None/unknown verdict → human (fail-safe), never CLOSED.
    assert decide(None, 1.0, 0.0, policy).status != CaseStatus.CLOSED


@pytest.mark.asyncio
async def test_automation_audits_each_action(app_state: AppState) -> None:
    case = _case(case_id="caud")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("t", "tag", payload={"tag": "audited"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    rows = await app_state.audit.records_for_case("caud")
    types = {
        (r.get("action_type") if isinstance(r, dict) else getattr(r, "action_type", None))
        for r in rows
    }
    # AUTOMATION action_type was recorded (may be the enum value string).
    assert ActionType.AUTOMATION.value in {str(getattr(t, "value", t)) for t in types}
