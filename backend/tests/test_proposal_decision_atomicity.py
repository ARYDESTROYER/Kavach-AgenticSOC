"""Proposal APPROVE/REJECT durability boundary — the effect must never outlive a
reported failure.

Regression suite for a confirmed production defect: ``approve_proposal`` used to run
the configuration EFFECT first and only then write the strict, ``event_id``-keyed
decision audit row and finalise the proposal. A failure at either later step returned
503 ("Approval could not be durably completed; no success was reported") while the
database had *already* recorded the tuning ledger row, the ``prefs.correlation_rules``
threshold bump, and an audit line saying the proposal was approved — with the proposal
still ``pending`` and re-offered in the UI. Silent divergence between what an operator
believes the configuration is and what it actually is.

The route now runs four ordered phases — PREPARE (pure validation), AUDIT, EFFECT,
FINALISE. Every piece is idempotent (``record_strict`` deduplicates on ``event_id``;
suppression checks ``approval_proposal_id``; Memory takes ``proposal_id``; tuning uses
``allow_idempotent_replay``), so audit-first is safe *and* a retry converges on exactly
one applied effect instead of double-applying.

The invariant these tests pin:
  **an operator who is told the decision FAILED must never find the configuration
  changed by that attempt.**

Offline (fake ES + mock LLM). The route functions are called directly so the failure
injection sits exactly on the phase boundary under test.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from fastapi import HTTPException

from app.api.routes import approve_proposal, reject_proposal
from app.constants import AUDIT_READ_PATTERN, ActionType
from app.models import Proposal
from app.state import AppState
from app.stores.proposals import PROVENANCE_KEY, evidence_fingerprint


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class _Request:
    """Minimal Request stand-in (auth is OFF in tests → ``current_username`` → '')."""

    def __init__(self, state: AppState) -> None:
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.scope = {"type": "http"}
        self.app = type("_App", (), {"state": type("_S", (), {"tlsoc": state})()})()


def _decision_rows(state: AppState, proposal_id: str, action: str) -> list[dict[str, Any]]:
    """Every append-only audit document for one proposal decision.

    Reads the fake ES store directly rather than by document id so a *duplicate*
    decision row would be visible even if it were written under another id.
    """
    es = state.control_audit._es
    rows: list[dict[str, Any]] = []
    for index in es._matching_indices(AUDIT_READ_PATTERN):
        for src in es.docs.get(index, {}).values():
            if src.get("action_type") != ActionType.PROPOSAL.value:
                continue
            summary = str(src.get("result_summary") or "")
            if f"proposal_id={proposal_id}" in summary and f"action={action}" in summary:
                rows.append(src)
    return rows


def _suppression_proposal() -> Proposal:
    return Proposal(
        kind="suppression",
        payload={
            "field": "event.module",
            "value": "atomicity_rule",
            "reason": "auto",
            "confidence": 0.9,
            "created_by": "agent",
            "enabled": True,
        },
        rationale="from an FP case",
        confidence=0.9,
        source_case_ids=["c-fp"],
        created_by="agent",
    )


def _memory_proposal(text: str = "Scanner 10.0.0.12 is an approved asset.") -> Proposal:
    return Proposal(
        kind="memory",
        payload={"text": text, "category": "operations"},
        rationale="Record a reviewed maintenance fact.",
        confidence=0.9,
        created_by="agent",
    )


def _tuning_proposal(state: AppState, rule_id: str) -> Proposal:
    """A bounded, in-policy correlation_n increase for ``rule_id``.

    Carries a verifiable evidence basis (independent analyst provenance + the matching
    fingerprint) because the approve path now refuses to enact a threshold change it
    cannot prove the origin of. See ``test_proposal_lifecycle.py`` for the refusals.
    """
    before = state.execution_prefs.correlation_for(rule_id).n
    payload = {
        "tuning": True,
        "action": "apply_change",
        "reason_code": "policy_requires_approval",
        "reason": "Independent analyst evidence supports a bounded change.",
        "recommended_action": "Approve the bounded threshold increase.",
        "rule_id": rule_id,
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
        PROVENANCE_KEY: {
            "independent_analyst_outcomes": 40,
            "analyst_feedback_labels": 31,
            "explicit_disposition_labels": 9,
            "bulk_ratified_model_verdicts": 0,
            "unlabelled_cases": 6,
            "provenance": "independent_analyst",
            "analyst_confirmed": True,
        },
        "dedupe_key": f"atomicity-{rule_id}",
    }
    return Proposal(
        kind="tuning",
        payload=payload,
        created_by="tuner",
        evidence_fingerprint=evidence_fingerprint(payload),
    )


def _fail_audit(state: AppState, monkeypatch: pytest.MonkeyPatch, *, times: int = 1):
    """Make the strict decision audit fail its first ``times`` calls."""
    original = state.control_audit.record_strict
    calls = {"n": 0}

    async def _record(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] <= times:
            raise RuntimeError("audit ledger unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(state.control_audit, "record_strict", _record)
    return calls


def _fail_finalize(state: AppState, monkeypatch: pytest.MonkeyPatch, *, times: int = 1):
    """Make strict proposal finalisation fail its first ``times`` calls."""
    original = state.proposals.finalize_approval
    calls = {"n": 0}

    async def _finalize(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] <= times:
            raise RuntimeError("proposal finalisation unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(state.proposals, "finalize_approval", _finalize)
    return calls


# --------------------------------------------------------------------------- #
# A FAILED strict decision audit must leave the configuration untouched.
# This is the exact divergence the report reproduced in production.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_tuning_audit_failure_leaves_prefs_and_ledger_untouched(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    before = app_state.execution_prefs.correlation_for("atomic_rule").n
    prefs_before = app_state.execution_prefs.model_dump(mode="json")
    prop = _tuning_proposal(app_state, "atomic_rule")
    await app_state.proposals.add(prop)
    _fail_audit(app_state, monkeypatch)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 503
    # The reported failure is TRUE: nothing was applied.
    assert app_state.execution_prefs.correlation_for("atomic_rule").n == before
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before
    assert await app_state.tuning_store.list_strict(rule_id="atomic_rule") == []
    assert _decision_rows(app_state, prop.id, "approve") == []
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert "audit ledger unavailable" in str(stored.approval_error)
    # ... and the operator is told so, with the evidence to check.
    detail = str(caught.value.detail)
    assert "applied no configuration change" in detail
    assert f"proposal-decision:{prop.id}:approve" in detail


@pytest.mark.asyncio
async def test_suppression_audit_failure_leaves_suppression_rules_untouched(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    rules_before = [r.model_dump(mode="json") for r in app_state.execution_prefs.suppression_rules]
    prop = _suppression_proposal()
    await app_state.proposals.add(prop)
    _fail_audit(app_state, monkeypatch)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 503
    assert [
        r.model_dump(mode="json") for r in app_state.execution_prefs.suppression_rules
    ] == rules_before
    assert not any(
        r.approval_proposal_id == prop.id
        for r in app_state.execution_prefs.suppression_rules
    )
    assert _decision_rows(app_state, prop.id, "approve") == []
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"


@pytest.mark.asyncio
async def test_memory_audit_failure_writes_no_memory(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    prop = _memory_proposal("Audit-first reviewed fact.")
    await app_state.proposals.add(prop)
    _fail_audit(app_state, monkeypatch)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 503
    assert [
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ] == []
    assert not any(m.text == "Audit-first reviewed fact." for m in await app_state.memory.list(False))
    assert _decision_rows(app_state, prop.id, "approve") == []


@pytest.mark.asyncio
async def test_audit_failure_is_retryable_and_converges_for_tuning(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Failing before the effect is the safe direction: the retry simply applies once."""
    before = app_state.execution_prefs.correlation_for("retry_rule").n
    prop = _tuning_proposal(app_state, "retry_rule")
    await app_state.proposals.add(prop)
    _fail_audit(app_state, monkeypatch)

    with pytest.raises(HTTPException):
        await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert app_state.execution_prefs.correlation_for("retry_rule").n == before

    retried = await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert retried["ok"] is True and retried["proposal"]["status"] == "approved"
    assert app_state.execution_prefs.correlation_for("retry_rule").n == before + 1
    records = await app_state.tuning_store.list_strict(rule_id="retry_rule")
    assert len(records) == 1 and records[0].review_proposal_id == prop.id
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


# --------------------------------------------------------------------------- #
# A FAILED finalisation: the effect and its evidence are already durable, so the
# state must be coherent and the retry must converge on exactly ONE applied effect.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_finalize_failure_state_is_coherent_and_retry_applies_tuning_once(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    before = app_state.execution_prefs.correlation_for("finalize_rule").n
    prop = _tuning_proposal(app_state, "finalize_rule")
    await app_state.proposals.add(prop)
    _fail_finalize(app_state, monkeypatch)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 503
    # Coherent: audited AND applied, only the status transition is missing.
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1
    assert app_state.execution_prefs.correlation_for("finalize_rule").n == before + 1
    ledger = await app_state.tuning_store.list_strict(rule_id="finalize_rule")
    assert len(ledger) == 1
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert "finalisation unavailable" in str(stored.approval_error)
    # The 503 must NOT claim a clean no-op — the config really did change.
    detail = str(caught.value.detail)
    assert "applied no configuration change" not in detail
    assert "was applied and audited" in detail
    assert f"proposal-decision:{prop.id}:approve" in detail

    # The retry converges: still exactly one change, one ledger row, one audit row.
    retried = await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert retried["ok"] is True and retried["proposal"]["status"] == "approved"
    assert app_state.execution_prefs.correlation_for("finalize_rule").n == before + 1
    assert len(await app_state.tuning_store.list_strict(rule_id="finalize_rule")) == 1
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


@pytest.mark.asyncio
async def test_finalize_failure_retry_appends_one_suppression_rule(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    prop = _suppression_proposal()
    await app_state.proposals.add(prop)
    _fail_finalize(app_state, monkeypatch)

    with pytest.raises(HTTPException):
        await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert len([
        r for r in app_state.execution_prefs.suppression_rules
        if r.approval_proposal_id == prop.id
    ]) == 1

    retried = await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert retried["ok"] is True
    assert len([
        r for r in app_state.execution_prefs.suppression_rules
        if r.approval_proposal_id == prop.id
    ]) == 1
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


@pytest.mark.asyncio
async def test_finalize_failure_retry_appends_one_memory_entry(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    prop = _memory_proposal("Exactly-once reviewed fact for finalisation.")
    await app_state.proposals.add(prop)
    _fail_finalize(app_state, monkeypatch)

    with pytest.raises(HTTPException):
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    retried = await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert retried["ok"] is True
    assert len([
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]) == 1
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


# --------------------------------------------------------------------------- #
# A FAILED effect (after a durable decision record) must still report the truth.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_effect_failure_reports_a_truthful_message_and_compensates_tuning(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    before = app_state.execution_prefs.correlation_for("effect_rule").n
    prop = _tuning_proposal(app_state, "effect_rule")
    await app_state.proposals.add(prop)
    original_append = app_state.tuning_store.add_approved_proposal_strict

    async def _ledger_unavailable(_record):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(
        app_state.tuning_store, "add_approved_proposal_strict", _ledger_unavailable,
    )
    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 503
    detail = str(caught.value.detail)
    # Truthful: the audit row exists, so the message must not claim "not recorded".
    assert "applied no configuration change" not in detail
    assert "did not complete" in detail
    assert f"proposal-decision:{prop.id}:approve" in detail
    # commit_approved_tuning still compensates its own threshold write.
    assert app_state.execution_prefs.correlation_for("effect_rule").n == before

    monkeypatch.setattr(
        app_state.tuning_store, "add_approved_proposal_strict", original_append,
    )
    retried = await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert retried["ok"] is True
    assert app_state.execution_prefs.correlation_for("effect_rule").n == before + 1
    assert len(await app_state.tuning_store.list_strict(rule_id="effect_rule")) == 1
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


# --------------------------------------------------------------------------- #
# The happy path is unchanged for every kind: effect + exactly one decision row.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_successful_suppression_approval_applies_effect_and_audits_once(
    app_state: AppState,
) -> None:
    prop = _suppression_proposal()
    await app_state.proposals.add(prop)

    result = await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert result["ok"] is True and result["proposal"]["status"] == "approved"
    assert any(
        r.field == "event.module" and r.value == "atomicity_rule"
        and r.approval_proposal_id == prop.id
        for r in app_state.execution_prefs.suppression_rules
    )
    rows = _decision_rows(app_state, prop.id, "approve")
    assert len(rows) == 1 and "kind=suppression" in str(rows[0]["result_summary"])


@pytest.mark.asyncio
async def test_successful_memory_approval_applies_effect_and_audits_once(
    app_state: AppState,
) -> None:
    prop = _memory_proposal()
    await app_state.proposals.add(prop)

    result = await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert result["ok"] is True and result["proposal"]["status"] == "approved"
    materialised = [
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]
    assert len(materialised) == 1 and materialised[0].review_status == "approved"
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


@pytest.mark.asyncio
async def test_successful_tuning_approval_applies_effect_and_audits_once(
    app_state: AppState,
) -> None:
    before = app_state.execution_prefs.correlation_for("happy_rule").n
    prop = _tuning_proposal(app_state, "happy_rule")
    await app_state.proposals.add(prop)

    result = await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert result["ok"] is True and result["proposal"]["status"] == "approved"
    assert app_state.execution_prefs.correlation_for("happy_rule").n == before + 1
    ledger = await app_state.tuning_store.list_strict(rule_id="happy_rule")
    assert len(ledger) == 1 and ledger[0].review_proposal_id == prop.id
    assert len(_decision_rows(app_state, prop.id, "approve")) == 1


@pytest.mark.asyncio
async def test_successful_automation_ack_audits_once_and_changes_nothing(
    app_state: AppState,
) -> None:
    prefs_before = app_state.execution_prefs.model_dump(mode="json")
    memory_before = [m.model_dump(mode="json") for m in await app_state.memory.list(False)]
    prop = Proposal(
        kind="automation_ack",
        payload={"rule_id": "lead-review", "reason": "Lead sign-off required"},
        rationale="Review this automation checkpoint.",
        created_by="automation",
    )
    await app_state.proposals.add(prop)

    result = await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert result["ok"] is True and result["proposal"]["status"] == "approved"
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before
    assert [m.model_dump(mode="json") for m in await app_state.memory.list(False)] == memory_before
    rows = _decision_rows(app_state, prop.id, "approve")
    assert len(rows) == 1 and "kind=automation_ack" in str(rows[0]["result_summary"])


@pytest.mark.asyncio
async def test_decision_audit_never_claims_a_confirmed_effect_up_front(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The row is written before the effect, so its wording must not assert success."""
    prop = _memory_proposal("Wording check.")
    await app_state.proposals.add(prop)
    _fail_finalize(app_state, monkeypatch)

    with pytest.raises(HTTPException):
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    rows = _decision_rows(app_state, prop.id, "approve")
    assert len(rows) == 1
    summary = str(rows[0]["result_summary"])
    assert "effect=confirmed" not in summary
    assert "decision=authorized" in summary and "effect=pending" in summary


# --------------------------------------------------------------------------- #
# PREPARE: an invalid payload is refused BEFORE any decision evidence is written.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_invalid_payload_is_refused_without_a_decision_audit_row(
    app_state: AppState,
) -> None:
    prop = Proposal(kind="memory", payload={"text": "   "}, rationale="", created_by="agent")
    await app_state.proposals.add(prop)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 400
    assert _decision_rows(app_state, prop.id, "approve") == []
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"


@pytest.mark.asyncio
async def test_stale_tuning_proposal_is_refused_without_a_decision_audit_row(
    app_state: AppState,
) -> None:
    """A recommendation overtaken by a live change is 409'd before it is audited."""
    prop = _tuning_proposal(app_state, "stale_rule")
    await app_state.proposals.add(prop)
    # Someone raised the live threshold in the meantime. The evidence basis itself is
    # intact (the fingerprint is recomputed for the shifted payload), so this pins the
    # live-configuration staleness seam specifically.
    stale_payload = dict(prop.payload)
    stale_payload["before"] = int(stale_payload["before"]) + 5
    stale_payload["after"] = int(stale_payload["after"]) + 5
    await app_state.proposals.add(
        prop.model_copy(update={
            "id": prop.id + "-stale",
            "payload": stale_payload,
            "evidence_fingerprint": evidence_fingerprint(stale_payload),
        })
    )

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id + "-stale", _Request(app_state), state=app_state)

    assert caught.value.status_code == 409
    assert _decision_rows(app_state, prop.id + "-stale", "approve") == []
    assert await app_state.tuning_store.list_strict(rule_id="stale_rule") == []


# --------------------------------------------------------------------------- #
# REJECT — audited, and never an effect of any kind.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["suppression", "memory", "tuning", "automation_ack"])
async def test_reject_audits_and_never_mutates_prefs_or_memory(
    app_state: AppState, kind: str,
) -> None:
    builders = {
        "suppression": lambda: _suppression_proposal(),
        "memory": lambda: _memory_proposal("Rejected fact."),
        "tuning": lambda: _tuning_proposal(app_state, "rejected_rule"),
        "automation_ack": lambda: Proposal(kind="automation_ack", rationale="Lead review"),
    }
    prop = builders[kind]()
    await app_state.proposals.add(prop)
    prefs_before = app_state.execution_prefs.model_dump(mode="json")
    memory_before = [m.model_dump(mode="json") for m in await app_state.memory.list(False)]

    result = await reject_proposal(prop.id, _Request(app_state), state=app_state)

    assert result["ok"] is True and result["proposal"]["status"] == "rejected"
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before
    assert [m.model_dump(mode="json") for m in await app_state.memory.list(False)] == memory_before
    assert await app_state.tuning_store.list_strict() == []
    rows = _decision_rows(app_state, prop.id, "reject")
    assert len(rows) == 1 and "effect=none" in str(rows[0]["result_summary"])
    assert _decision_rows(app_state, prop.id, "approve") == []


@pytest.mark.asyncio
async def test_reject_audit_failure_changes_nothing_and_says_so(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    prop = _suppression_proposal()
    await app_state.proposals.add(prop)
    prefs_before = app_state.execution_prefs.model_dump(mode="json")
    _fail_audit(app_state, monkeypatch)

    with pytest.raises(HTTPException) as caught:
        await reject_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 503
    assert "no configuration, Memory or case state was changed" in str(caught.value.detail)
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before
    assert _decision_rows(app_state, prop.id, "reject") == []
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"

    retried = await reject_proposal(prop.id, _Request(app_state), state=app_state)
    assert retried["ok"] is True and retried["proposal"]["status"] == "rejected"
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before


# --------------------------------------------------------------------------- #
# The swallowed exception must reach the log — diagnosing this defect in production
# took hours because the only trace was the proposal's approval_error field.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_failed_approval_logs_the_swallowed_exception(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    prop = _tuning_proposal(app_state, "logged_rule")
    await app_state.proposals.add(prop)
    _fail_audit(app_state, monkeypatch)

    with caplog.at_level(logging.ERROR, logger="tlsoc.api"):
        with pytest.raises(HTTPException):
            await approve_proposal(prop.id, _Request(app_state), state=app_state)

    failures = [
        r for r in caplog.records
        if r.name == "tlsoc.api" and "approval failed" in r.getMessage()
    ]
    assert failures, "the swallowed approval exception must be logged"
    assert "audit phase" in failures[0].getMessage()
    assert failures[0].exc_info is not None, "the traceback must be logged, not just the text"
    assert "audit ledger unavailable" in caplog.text


@pytest.mark.asyncio
async def test_failed_rejection_logs_the_swallowed_exception(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    prop = Proposal(kind="automation_ack", rationale="Lead review")
    await app_state.proposals.add(prop)
    _fail_audit(app_state, monkeypatch)

    with caplog.at_level(logging.ERROR, logger="tlsoc.api"):
        with pytest.raises(HTTPException):
            await reject_proposal(prop.id, _Request(app_state), state=app_state)

    failures = [
        r for r in caplog.records
        if r.name == "tlsoc.api" and "rejection failed" in r.getMessage()
    ]
    assert failures and failures[0].exc_info is not None
    assert "audit ledger unavailable" in caplog.text
