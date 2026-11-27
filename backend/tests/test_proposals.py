"""PART 2 — agent-DRAFTED suppression/asset PROPOSALS with HUMAN APPROVAL.

Offline tests (fake ES + mock LLM, SQLite-capable). Covers:
  * ProposalStore round-trip over the KV (no migration): add/list/get/set_status,
    durable across a fresh store instance.
  * draft_suppression_proposal: proposes a sound literal field==value for a clean
    FP; returns None for denylisted/over-broad cases (bare IP, severity, cross-rule)
    and NEVER invents a selector absent from the events.
  * approve(suppression): appends a live SuppressionRule that the cost gate honours;
    enabled=False / expired rules are NOT dropped.
  * reject: prefs unchanged.
  * confirm_fp still 200s + still indexes the resolved_case RAG chunk even if the
    proposer raises (fail-safe isolation).
  * decide() is byte-identical (we didn't touch the close/escalate math).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import partial

import pytest

from app.agents.proposer import draft_suppression_proposal
from app.config import AutoClosePolicy, Preferences, SuppressionRule, VerdictAutoClose
from app.constants import (
    PROPOSALS_KEY,
    PROPOSALS_NS,
    CaseStatus,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.case_manager import Decision, decide
from app.engine.correlation import cluster_from_events
from app.engine.cost_gate import passes_suppression
from app.models import Case, Entity, Proposal
from app.state import AppState
from app.stores.proposals import PROVENANCE_KEY, ProposalStore, evidence_fingerprint

from tests.conftest import make_log_event, make_raw_event


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _fp_case(
    *, case_id: str = "c1", rule: str = "linux_auth", ip: str = "203.0.113.10",
    member_ids: list[str] | None = None,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=ip),
        rule_ids=[rule],
        member_event_ids=member_ids or [],
        verdict=Verdict.FALSE_POSITIVE,
        confidence=0.9,
        status=CaseStatus.CLOSED,
    )


async def _seed_events(state: AppState, *, rule: str, ip: str, n: int, **extra) -> list[str]:
    """Seed n matching log events into the fake ES; return their ids."""
    es = state.es
    ids = []
    for i in range(n):
        src = make_log_event(rule=rule, ip=ip, **extra)
        ids.append(es.add_log("all-logs-2026.06.16", src, doc_id=f"{rule}-{ip}-{i}"))
    return ids


# --------------------------------------------------------------------------- #
# ProposalStore round-trip (over the KV, no migration)
# --------------------------------------------------------------------------- #
async def test_proposal_store_crud(app_state: AppState) -> None:
    store: ProposalStore = app_state.proposals
    assert await store.list() == []

    p = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "linux_auth"},
        rationale="why", confidence=0.8, source_case_ids=["c1"], created_by="agent",
    )
    await store.add(p)

    listed = await store.list()
    assert len(listed) == 1 and listed[0].id == p.id
    assert await store.get(p.id) is not None
    assert await store.get("prop-nope") is None

    # filter by status
    assert len(await store.list(status="pending")) == 1
    assert len(await store.list(status="approved")) == 0

    # set_status records decided_by/decided_at
    updated = await store.set_status(p.id, "approved", by="alice")
    assert updated is not None and updated.status == "approved"
    assert updated.decided_by == "alice" and updated.decided_at
    assert len(await store.list(status="pending")) == 0
    assert len(await store.list(status="approved")) == 1

    # set_status on a missing id → None
    assert await store.set_status("prop-missing", "rejected", by="x") is None


async def test_proposal_store_durable_across_instances(app_state: AppState) -> None:
    p = Proposal(kind="memory", payload={"text": "host web01 is public"}, created_by="agent")
    await app_state.proposals.add(p)
    fresh = ProposalStore(app_state._kv)
    ids = [x.id for x in await fresh.list()]
    assert p.id in ids


async def test_concurrent_add_and_set_status_are_not_lost(app_state: AppState) -> None:
    # audit #26: a concurrent add + set_status must not drop the in-flight proposal nor
    # revert an approved one. Every mutation now routes through kv_mutate (lock + _rev).
    import asyncio

    store: ProposalStore = app_state.proposals
    seeded = [Proposal(kind="memory", payload={"i": i}, created_by="agent") for i in range(8)]
    for p in seeded:
        await store.add(p)
    late = Proposal(kind="memory", payload={"late": True}, created_by="agent")
    # Concurrently: add a new proposal while approving the 8 existing ones.
    await asyncio.gather(
        store.add(late),
        *[store.set_status(p.id, "approved", by="admin") for p in seeded],
    )
    everything = {p.id: p for p in await store.list()}
    assert late.id in everything, "the concurrent add was dropped"
    for p in seeded:
        assert everything[p.id].status == "approved", "an approval was clobbered"


async def test_strict_proposal_mutation_fails_closed_on_malformed_sibling(
    app_state: AppState,
) -> None:
    """A privileged decision must not erase a corrupt/forward-version neighbour."""
    proposal = Proposal(kind="memory", payload={"text": "Keep this row."})
    raw = {
        "entries": [
            proposal.model_dump(mode="json"),
            {"id": "opaque-future-row", "kind": "future-kind"},
        ],
        "future_metadata": {"owner": "newer-deployment"},
    }
    await app_state._kv.put(PROPOSALS_NS, PROPOSALS_KEY, raw)
    getter = getattr(app_state._kv, "get_strict", None) or app_state._kv.get
    before = await getter(PROPOSALS_NS, PROPOSALS_KEY)

    with pytest.raises(ValueError, match="invalid entry"):
        await app_state.proposals.claim_approval(
            proposal.id, by="alice", token="approval-corrupt"
        )

    after = await getter(PROPOSALS_NS, PROPOSALS_KEY)
    assert after == before


# --------------------------------------------------------------------------- #
# draft_suppression_proposal — sound proposals + anti-poisoning denials
# --------------------------------------------------------------------------- #
async def test_draft_proposes_literal_selector_for_clean_fp(app_state: AppState) -> None:
    ids = await _seed_events(app_state, rule="benign_scanner", ip="10.1.2.3", n=6)
    case = _fp_case(rule="benign_scanner", ip="10.1.2.3", member_ids=ids)

    prop = await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs)
    assert prop is not None
    assert prop.kind == "suppression"
    # The selector field is on the allowlist AND its value LITERALLY appears in events.
    field, value = prop.payload["field"], prop.payload["value"]
    assert field in ("event.module", "rule.name", "event.action", "event.code")
    # event.module / rule.name == "benign_scanner"; event.action == "login".
    assert value in ("benign_scanner", "login")
    assert prop.confidence > 0.5
    assert case.case_id in prop.source_case_ids
    assert prop.expires_at  # self-retiring


async def test_draft_returns_none_for_non_fp(app_state: AppState) -> None:
    ids = await _seed_events(app_state, rule="some_rule", ip="10.0.0.5", n=5)
    case = _fp_case(rule="some_rule", ip="10.0.0.5", member_ids=ids)
    case.verdict = Verdict.TRUE_POSITIVE
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None
    case.verdict = Verdict.NEEDS_HUMAN
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None
    case.verdict = None
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None


async def test_draft_returns_none_for_cross_rule(app_state: AppState) -> None:
    # Two distinct rule ids on the case → over-broad → propose nothing.
    ids = await _seed_events(app_state, rule="rule_a", ip="10.0.0.9", n=4)
    case = _fp_case(rule="rule_a", ip="10.0.0.9", member_ids=ids)
    case.rule_ids = ["rule_a", "rule_b"]
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None


async def test_draft_never_proposes_bare_entity_or_severity(app_state: AppState) -> None:
    # Even though source.ip / event.severity literally appear in the events, the
    # denylist forbids proposing on them — the selector must be a safe rule-ish field.
    ids = await _seed_events(app_state, rule="auth_fail", ip="198.51.100.7", n=5)
    case = _fp_case(rule="auth_fail", ip="198.51.100.7", member_ids=ids)
    prop = await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs)
    assert prop is not None
    field = prop.payload["field"]
    # Never the IP / user / host / severity field.
    assert field not in (
        app_state.prefs.source_ip_field, app_state.prefs.user_field,
        app_state.prefs.host_field, app_state.prefs.severity_field,
    )
    assert field not in ("@timestamp", "message", "event.original")


async def test_draft_never_invents_absent_selector(app_state: AppState) -> None:
    # No member events available at all → cannot derive any literal selector → None.
    case = _fp_case(rule="ghost_rule", ip="10.0.0.99", member_ids=[])
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None


async def test_draft_requires_value_prevalence(app_state: AppState) -> None:
    # A field whose value differs in every event (no dominant value) is not proposed
    # on that field; the proposer falls back to a field with a common value (rule).
    es = app_state.es
    ids = []
    for i in range(6):
        # process.name differs every event; event.module is constant.
        src = make_log_event(rule="const_rule", ip="10.5.5.5")
        src["process"] = {"name": f"proc-{i}"}
        ids.append(es.add_log("all-logs-2026.06.16", src, doc_id=f"prev-{i}"))
    case = _fp_case(rule="const_rule", ip="10.5.5.5", member_ids=ids)
    prop = await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs)
    assert prop is not None
    # Must NOT pick the per-event-varying process.name; picks the constant rule field.
    assert prop.payload["field"] != "process.name"
    assert prop.payload["value"] == "const_rule"


# --------------------------------------------------------------------------- #
# Approve / reject endpoints (HITL — human is the only live-write path)
# --------------------------------------------------------------------------- #
def _make_cluster(rule: str, ip: str, n: int = 6):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


async def test_approve_suppression_adds_live_rule(client) -> None:
    state: AppState = client.app.state.tlsoc
    # A pending suppression proposal targeting event.module==noisy_rule.
    p = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "noisy_rule",
                 "reason": "auto", "confidence": 0.9, "created_by": "agent", "enabled": True},
        rationale="from FP case", confidence=0.9, source_case_ids=["c-fp"], created_by="agent",
    )
    await state.proposals.add(p)

    # Before approval: a noisy_rule cluster is NOT suppressed.
    cluster = _make_cluster("noisy_rule", "10.9.9.9")
    assert passes_suppression(cluster, state.prefs) is True

    r = client.post(f"/api/proposals/{p.id}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["proposal"]["status"] == "approved"

    # The rule is now live in prefs and the matching cluster is dropped.
    rules = state.prefs.suppression_rules
    assert any(rr.field == "event.module" and rr.value == "noisy_rule" for rr in rules)
    cluster2 = _make_cluster("noisy_rule", "10.9.9.9")
    assert passes_suppression(cluster2, state.prefs) is False

    # Approving an already-decided proposal → 409.
    assert client.post(f"/api/proposals/{p.id}/approve").status_code == 409
    # Unknown id → 404.
    assert client.post("/api/proposals/prop-nope/approve").status_code == 404


async def test_approved_rule_honors_enabled_and_expiry(client) -> None:
    state: AppState = client.app.state.tlsoc
    # disabled rule → NOT dropped
    p_dis = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "disabled_rule", "enabled": False},
        confidence=0.8, created_by="agent",
    )
    await state.proposals.add(p_dis)
    assert client.post(f"/api/proposals/{p_dis.id}/approve").status_code == 200
    cluster = _make_cluster("disabled_rule", "10.2.2.2")
    assert passes_suppression(cluster, state.prefs) is True  # disabled → still investigated

    # expired rule → NOT dropped
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    p_exp = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "expired_rule", "enabled": True, "expires_at": past},
        confidence=0.8, created_by="agent", expires_at=past,
    )
    await state.proposals.add(p_exp)
    assert client.post(f"/api/proposals/{p_exp.id}/approve").status_code == 200
    cluster2 = _make_cluster("expired_rule", "10.3.3.3")
    assert passes_suppression(cluster2, state.prefs) is True  # expired → still investigated


async def test_reject_leaves_prefs_unchanged(client) -> None:
    state: AppState = client.app.state.tlsoc
    before = list(state.prefs.suppression_rules)
    p = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "rejected_rule"},
        confidence=0.7, created_by="agent",
    )
    await state.proposals.add(p)
    r = client.post(f"/api/proposals/{p.id}/reject")
    assert r.status_code == 200
    assert r.json()["proposal"]["status"] == "rejected"
    # Prefs untouched; the rejected rule never went live.
    assert state.prefs.suppression_rules == before
    cluster = _make_cluster("rejected_rule", "10.4.4.4")
    assert passes_suppression(cluster, state.prefs) is True
    # Reject again → 409.
    assert client.post(f"/api/proposals/{p.id}/reject").status_code == 409


async def test_approve_automation_ack_records_review_only(client) -> None:
    """A generic automation checkpoint is acknowledgement-only, never implicit Memory."""
    state: AppState = client.app.state.tlsoc
    before_prefs = state.execution_prefs.model_dump(mode="json")
    before_memory = [m.model_dump(mode="json") for m in await state.memory.list(False)]
    p = Proposal(
        kind="automation_ack",
        payload={"rule_id": "lead-review", "reason": "Lead sign-off required"},
        rationale="Review this automation checkpoint.",
        confidence=0.6,
        source_case_ids=["case-review"],
        created_by="automation",
    )
    await state.proposals.add(p)

    response = client.post(f"/api/proposals/{p.id}/approve")
    assert response.status_code == 200, response.text
    assert response.json()["proposal"]["status"] == "approved"
    assert state.execution_prefs.model_dump(mode="json") == before_prefs
    assert [m.model_dump(mode="json") for m in await state.memory.list(False)] == before_memory


async def test_approve_explicit_memory_still_materialises_trusted_fact(client) -> None:
    """Explicit governed Memory proposals retain their existing approval semantics."""
    state: AppState = client.app.state.tlsoc
    p = Proposal(
        kind="memory",
        payload={"text": "Scanner 10.0.0.12 is approved.", "category": "operations"},
        rationale="Record a reviewed maintenance fact.",
        confidence=0.9,
        created_by="agent",
    )
    await state.proposals.add(p)

    response = client.post(f"/api/proposals/{p.id}/approve")
    assert response.status_code == 200, response.text
    entries = await state.memory.list(False)
    materialised = next(m for m in entries if m.text == "Scanner 10.0.0.12 is approved.")
    assert materialised.review_status == "approved"


async def test_approve_tuning_materializes_bounded_change_and_ledger(client) -> None:
    state: AppState = client.app.state.tlsoc
    before = state.execution_prefs.correlation_for("reviewed_rule").n
    payload = {
        "tuning": True,
        "action": "apply_change",
        "reason_code": "policy_requires_approval",
        "reason": "Independent analyst evidence supports a bounded change.",
        "recommended_action": "Approve the bounded threshold increase.",
        "rule_id": " reviewed_rule ",
        "target": "correlation_n",
        "before": before,
        "after": before + 1,
        "fp_rate": 0.72,
        "analyst_samples": 40,
        "observed_cases": 46,
        "unconfirmed_cases": 6,
        "confirmed_false_positives": 37,
        "confirmed_true_positives": 3,
        "evidence_basis": "analyst outcomes",
        # A threshold change may only be applied on a verifiable, independent basis.
        PROVENANCE_KEY: {
            "independent_analyst_outcomes": 40,
            "analyst_feedback_labels": 31,
            "explicit_disposition_labels": 9,
            "bulk_ratified_model_verdicts": 0,
            "unlabelled_cases": 6,
            "provenance": "independent_analyst",
            "analyst_confirmed": True,
        },
        "dedupe_key": "test-reviewed-rule",
    }
    p = Proposal(
        kind="tuning",
        payload=payload,
        created_by="tuner",
        evidence_fingerprint=evidence_fingerprint(payload),
    )
    await state.proposals.add(p)

    response = client.post(f"/api/proposals/{p.id}/approve")
    assert response.status_code == 200, response.text
    assert response.json()["proposal"]["status"] == "approved"
    assert state.execution_prefs.correlation_for("reviewed_rule").n == before + 1
    records = await state.tuning_store.list(rule_id="reviewed_rule", active_only=True)
    assert len(records) == 1
    assert records[0].review_proposal_id == p.id
    assert records[0].evidence_source == "analyst_confirmed_approved"


async def test_approve_tuning_ledger_failure_restores_threshold_and_retries(
    client, monkeypatch: pytest.MonkeyPatch,
) -> None:
    state: AppState = client.app.state.tlsoc
    before = state.execution_prefs.correlation_for("reviewed_saga_rule").n
    payload = {
        "tuning": True,
        "action": "apply_change",
        "reason_code": "policy_requires_approval",
        "rule_id": "reviewed_saga_rule",
        "target": "correlation_n",
        "before": before,
        "after": before + 1,
        "fp_rate": 0.72,
        "analyst_samples": 40,
        "observed_cases": 40,
        "confirmed_false_positives": 37,
        "confirmed_true_positives": 3,
        PROVENANCE_KEY: {
            "independent_analyst_outcomes": 40,
            "analyst_feedback_labels": 40,
            "explicit_disposition_labels": 0,
            "bulk_ratified_model_verdicts": 0,
            "unlabelled_cases": 0,
            "provenance": "independent_analyst",
            "analyst_confirmed": True,
        },
    }
    p = Proposal(
        kind="tuning",
        payload=payload,
        created_by="tuner",
        evidence_fingerprint=evidence_fingerprint(payload),
    )
    await state.proposals.add(p)
    original_append = state.tuning_store.add_approved_proposal_strict

    async def ledger_unavailable(_record):  # noqa: ANN001
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(
        state.tuning_store, "add_approved_proposal_strict", ledger_unavailable,
    )
    failed = client.post(f"/api/proposals/{p.id}/approve")
    assert failed.status_code == 503
    assert state.execution_prefs.correlation_for("reviewed_saga_rule").n == before
    assert await state.tuning_store.list_strict(rule_id="reviewed_saga_rule") == []

    # The released approval remains retryable; recovery applies and records exactly
    # one change rather than leaving a hidden partial success.
    monkeypatch.setattr(
        state.tuning_store, "add_approved_proposal_strict", original_append,
    )
    retried = client.post(f"/api/proposals/{p.id}/approve")
    assert retried.status_code == 200, retried.text
    assert state.execution_prefs.correlation_for("reviewed_saga_rule").n == before + 1
    records = await state.tuning_store.list_strict(rule_id="reviewed_saga_rule")
    assert len(records) == 1 and records[0].review_proposal_id == p.id


async def test_approve_evidence_request_acknowledges_without_threshold_write(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state: AppState = client.app.state.tlsoc
    before = state.execution_prefs.correlation_for("thin_rule").n
    async def _unexpected_prefs_write(_mutate) -> Preferences:
        raise AssertionError("evidence acknowledgement must not persist preferences")

    monkeypatch.setattr(state, "mutate_execution_prefs", _unexpected_prefs_write)

    p = Proposal(
        kind="tuning",
        payload={
            "tuning": True,
            "action": "collect_evidence",
            "reason_code": "insufficient_analyst_evidence",
            "reason": "Too few independent labels.",
            "recommended_action": "Grade more cases.",
            "rule_id": "thin_rule",
            "target": "evidence_collection",
            "before": before,
            "after": before,
        },
        created_by="tuner",
    )
    await state.proposals.add(p)
    response = client.post(f"/api/proposals/{p.id}/approve")
    assert response.status_code == 200, response.text
    assert state.execution_prefs.correlation_for("thin_rule").n == before
    assert await state.tuning_store.list(rule_id="thin_rule") == []


def test_list_proposals_filters_by_status(client) -> None:
    # Empty to start.
    assert client.get("/api/proposals").json()["count"] == 0
    # Add two pending proposals via the store (on the app loop, via the test portal).
    state: AppState = client.app.state.tlsoc
    p1 = Proposal(kind="suppression", payload={"field": "event.module", "value": "r1"}, created_by="agent")
    p2 = Proposal(kind="suppression", payload={"field": "event.module", "value": "r2"}, created_by="agent")
    client.portal.call(state.proposals.add, p1)
    client.portal.call(state.proposals.add, p2)
    assert client.get("/api/proposals").json()["count"] == 2
    assert client.get("/api/proposals?status=pending").json()["count"] == 2
    assert client.get("/api/proposals?status=approved").json()["count"] == 0


# --------------------------------------------------------------------------- #
# confirm_fp drafts a proposal end-to-end + fail-safe isolation
# --------------------------------------------------------------------------- #
def test_confirm_fp_drafts_proposal(client) -> None:
    state: AppState = client.app.state.tlsoc
    # Seed events + a closed-able case with a single rule.
    ids = client.portal.call(partial(_seed_events, state, rule="quiet_rule", ip="10.7.7.7", n=5))
    case = _fp_case(case_id="cfp", rule="quiet_rule", ip="10.7.7.7", member_ids=ids)
    case.status = CaseStatus.NEEDS_HUMAN
    case.verdict = Verdict.FALSE_POSITIVE
    client.portal.call(state.cases.save, case)

    r = client.post("/api/cases/cfp/action", json={"action": "confirm_fp", "analyst": "ana", "note": "benign scanner"})
    assert r.status_code == 200

    proposals = client.get("/api/proposals?status=pending").json()["proposals"]
    assert any(p["source_case_ids"] == ["cfp"] for p in proposals)


def test_confirm_fp_succeeds_and_indexes_rag_even_if_proposer_raises(client, monkeypatch) -> None:
    state: AppState = client.app.state.tlsoc
    # Force resolved_case RAG indexing ON so we can assert the chunk is written.
    prefs = state.prefs.model_copy(update={
        "rag": state.prefs.rag.model_copy(update={"enabled": True, "use_resolved_cases": True}),
    })
    client.portal.call(state.update_prefs, prefs)

    # Make the proposer EXPLODE — the close must still 200 and still index the chunk.
    import app.agents.proposer as proposer_mod

    async def _boom(*a, **k):
        raise RuntimeError("proposer blew up")

    monkeypatch.setattr(proposer_mod, "draft_suppression_proposal", _boom)

    indexed: dict = {}
    orig_index = state.rag.index_resolved_case

    async def _spy(case, note=""):
        indexed["called"] = True
        return await orig_index(case, note=note)

    monkeypatch.setattr(state.rag, "index_resolved_case", _spy)

    ids = client.portal.call(partial(_seed_events, state, rule="boom_rule", ip="10.8.8.8", n=3))
    case = _fp_case(case_id="cboom", rule="boom_rule", ip="10.8.8.8", member_ids=ids)
    case.status = CaseStatus.OPEN
    client.portal.call(state.cases.save, case)

    r = client.post("/api/cases/cboom/action", json={"action": "confirm_fp", "analyst": "ana", "note": "fp"})
    assert r.status_code == 200  # the analyst's close is NEVER broken by the proposer
    assert indexed.get("called") is True  # the resolved_case RAG chunk was still indexed
    # No proposal was drafted (the proposer raised → caught → nothing added).
    assert client.get("/api/proposals").json()["count"] == 0


# --------------------------------------------------------------------------- #
# decide() byte-identical — we did NOT touch the close/escalate math
# --------------------------------------------------------------------------- #
def test_decide_is_unchanged() -> None:
    """A focused equality snapshot over (verdict, confidence, risk, policy) combos.

    These EXPECTED values were captured from the unmodified case_manager.decide();
    any drift means the verdict/close math was altered (a Part-2 guardrail breach).
    """
    policy = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=True, min_confidence=0.8, max_risk_score=40.0,
                                        objection_window_minutes=60),
        true_positive=VerdictAutoClose(enabled=False, min_confidence=0.9, max_risk_score=20.0,
                                       objection_window_minutes=60),
    )

    def shape(d: Decision) -> tuple:
        # objection_window_expires_at is time-relative — assert only its presence.
        return (d.status, d.decision_by, d.escalate, bool(d.objection_window_expires_at))

    # FP clears the bar → auto-closed by agent, objection window set.
    d = decide(Verdict.FALSE_POSITIVE, 0.9, 10.0, policy)
    assert shape(d) == (CaseStatus.CLOSED, d.decision_by, False, True)
    assert d.status == CaseStatus.CLOSED and d.decision_by.value == "agent"

    # FP below confidence bar → human, no window.
    d = decide(Verdict.FALSE_POSITIVE, 0.5, 10.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.decision_by.value == "system"
    assert d.objection_window_expires_at is None

    # FP over risk bar → human.
    d = decide(Verdict.FALSE_POSITIVE, 0.95, 80.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN

    # TP class disabled → human; high-confidence TP escalates.
    d = decide(Verdict.TRUE_POSITIVE, 0.95, 50.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.escalate is True

    # TP low confidence + low risk → human, no escalation.
    d = decide(Verdict.TRUE_POSITIVE, 0.1, 5.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.escalate is False

    # NEEDS_HUMAN never auto-closes.
    d = decide(Verdict.NEEDS_HUMAN, 1.0, 0.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.decision_by.value == "system"

    # Unknown / None verdict → human (fail-safe).
    d = decide(None, 1.0, 0.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN
