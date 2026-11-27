"""PROPOSAL LIFECYCLE — staleness, evidence provenance, expiry and bulk rejection.

The operational consequence of the approval defect. Because every strict approval
write failed for the deployment's entire life, pending proposals accumulated without
bound; some recommend changes that cannot take effect, and some are EVIDENCE-POISONED
— an operator's bulk backfill made model verdicts look like analyst ground truth, so a
card could read "97 analyst labels / 97 confirmed FP / 0 TP" when the independent
analyst count was ZERO. With approvals repaired those proposals became APPROVABLE, so
the queue itself now needs a product answer.

What this suite pins:

1. **A proposal whose evidence basis changed is REFUSED, not silently applied**, and
   the refusal is distinguishable from an ordinary failure (a machine-readable
   ``stale_proposal`` code + ``redraft_required``, HTTP 409, versus a plain 400 for a
   malformed payload). Nothing is audited and no configuration moves.
2. **Bulk-ratified evidence is never labelled analyst-confirmed** — not in the payload
   the tuner drafts, not in the API projection the card renders, and not in what the
   approve path is willing to enact.
3. **An expired proposal is not approvable and is swept** into a durable ``expired``
   state, while still being rejectable so a queue can be cleared.
4. **Bulk reject audits every item** through the SAME strict per-proposal decision
   path, is idempotent, and one bad item never aborts the batch.
5. **An inert rule never reaches the queue as an applicable change** — end to end,
   from the tuner's window to what the approve path would materialise.

Offline (fake ES + mock LLM). Route functions are called directly where the assertion
is about a phase boundary, and through the TestClient where it is about the wire shape.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi import HTTPException

from app.api.routes import approve_proposal, reject_proposal
from app.config import (
    CorrelationRule,
    Preferences,
    SourceInstance,
    ThresholdTuningConfig,
)
from app.constants import (
    AUDIT_READ_PATTERN,
    ActionType,
    CorrelationMode,
    EntityType,
    IngestMode,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine.threshold_tuner import (
    INERT_ALERTS_ROLE_OVERRIDE,
    StaleTuningProposal,
    materialize_approved_tuning,
    run_once,
)
from app.models import Case, Entity, FeedbackEntry, Proposal, TriggerReason
from app.state import AppState
from app.stores.proposals import (
    BULK_DECISION_LIMIT,
    PROVENANCE_BULK_RATIFIED,
    PROVENANCE_INDEPENDENT_ANALYST,
    PROVENANCE_KEY,
    PROVENANCE_MIXED,
    PROVENANCE_UNVERIFIED,
    evidence_fingerprint,
    evidence_summary,
    proposal_is_expired,
)
from app.stores.tuning import TuningStore
from app.tools.rag import precedent_ratification_entry
from app.utils import now_utc


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


class _FakeAudit:
    """Records ``record(...)`` kwargs so a test can assert on the trail."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def record(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)


def _decision_rows(state: AppState, proposal_id: str, action: str) -> list[dict[str, Any]]:
    """Every append-only audit document for one proposal decision."""
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


def _independent_provenance(total: int = 40, unlabelled: int = 6) -> dict[str, Any]:
    return {
        "independent_analyst_outcomes": total,
        "analyst_feedback_labels": total,
        "explicit_disposition_labels": 0,
        "bulk_ratified_model_verdicts": 0,
        "unlabelled_cases": unlabelled,
        "provenance": PROVENANCE_INDEPENDENT_ANALYST,
        "analyst_confirmed": True,
    }


def _apply_payload(rule_id: str, before: int, **over: Any) -> dict[str, Any]:
    """A bounded, in-policy correlation_n raise justified by independent evidence."""
    payload: dict[str, Any] = {
        "tuning": True,
        "action": "apply_change",
        "reason_code": "policy_requires_approval",
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
        PROVENANCE_KEY: _independent_provenance(),
        "dedupe_key": f"lifecycle-{rule_id}",
    }
    payload.update(over)
    return payload


def _tuning_proposal(state: AppState, rule_id: str, **over: Any) -> Proposal:
    before = state.execution_prefs.correlation_for(rule_id).n
    payload = _apply_payload(rule_id, before, **over)
    return Proposal(
        kind="tuning",
        payload=payload,
        created_by="tuner",
        evidence_fingerprint=evidence_fingerprint(payload),
    )


def _past(days: int = 1) -> str:
    return (now_utc() - timedelta(days=days)).isoformat()


def _future(days: int = 30) -> str:
    return (now_utc() + timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------- #
# 1. EVIDENCE BASIS CHANGED → REFUSE AND RE-DRAFT
# --------------------------------------------------------------------------- #
async def test_edited_evidence_is_refused_before_anything_is_audited_or_applied(
    app_state: AppState,
) -> None:
    """Rewriting the evidence behind a drafted recommendation invalidates it.

    The fingerprint covers the recommendation AND its provenance, so a payload edited
    after drafting — whether by a later process, a partially-migrated document, or a
    hand-crafted request — can no longer be enacted under the original approval.
    """
    prop = _tuning_proposal(app_state, "edited_rule")
    before = app_state.execution_prefs.correlation_for("edited_rule").n
    poisoned = dict(prop.payload)
    poisoned["analyst_samples"] = 97
    poisoned["confirmed_false_positives"] = 97
    await app_state.proposals.add(
        prop.model_copy(update={"payload": poisoned})  # fingerprint deliberately unchanged
    )

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 409
    detail = caught.value.detail
    assert isinstance(detail, dict)
    assert detail["error"] == "stale_proposal"
    assert detail["code"] == "evidence_fingerprint_mismatch"
    assert detail["redraft_required"] is True
    # Refused BEFORE the decision record and before any configuration moved.
    assert _decision_rows(app_state, prop.id, "approve") == []
    assert app_state.execution_prefs.correlation_for("edited_rule").n == before
    assert await app_state.tuning_store.list_strict(rule_id="edited_rule") == []
    # ... and it stays reviewable rather than being consumed by the failed attempt.
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"


async def test_a_proposal_drafted_before_provenance_existed_cannot_be_applied(
    app_state: AppState,
) -> None:
    """The exact pre-fix row: an internally consistent payload with no verifiable basis.

    Its numbers look impeccable — 97 analyst labels, 97 confirmed false positives — but
    nothing recorded WHERE they came from, and the bulk backfill is why that matters.
    Approving it would move a live threshold on the agent's own verdicts.
    """
    before = app_state.execution_prefs.correlation_for("legacy_rule").n
    legacy = Proposal(
        kind="tuning",
        payload={
            "tuning": True,
            "action": "apply_change",
            "rule_id": "legacy_rule",
            "target": "correlation_n",
            "before": before,
            "after": before + 1,
            "fp_rate": 0.97,
            "analyst_samples": 97,
            "observed_cases": 97,
            "unconfirmed_cases": 0,
            "confirmed_false_positives": 97,
            "confirmed_true_positives": 0,
        },
        created_by="tuner",
    )
    await app_state.proposals.add(legacy)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(legacy.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "evidence_fingerprint_missing"
    assert caught.value.detail["evidence"]["analyst_confirmed"] is False
    assert caught.value.detail["evidence"]["provenance"] == PROVENANCE_UNVERIFIED
    assert _decision_rows(app_state, legacy.id, "approve") == []
    assert app_state.execution_prefs.correlation_for("legacy_rule").n == before


async def test_live_threshold_drift_is_still_its_own_distinct_refusal(
    app_state: AppState,
) -> None:
    """The pre-existing staleness seam keeps its own code — evidence is not the issue."""
    prop = _tuning_proposal(app_state, "drifted_rule")
    await app_state.proposals.add(prop)
    # Someone raised the live threshold after the recommendation was drafted.
    await app_state.mutate_execution_prefs(lambda prefs: prefs.model_copy(update={
        "correlation_rules": {
            **prefs.correlation_rules,
            "drifted_rule": CorrelationRule(mode=CorrelationMode.THRESHOLD, n=int(
                prop.payload["before"]) + 4),
        }
    }))

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "live_threshold_changed"
    assert _decision_rows(app_state, prop.id, "approve") == []


async def test_a_stale_refusal_is_distinguishable_from_an_ordinary_failure(
    app_state: AppState,
) -> None:
    """Staleness is a 409 with a code; a malformed payload stays a plain 400 string.

    An operator must be able to tell "re-draft this" apart from "this request is
    broken" without reading prose.
    """
    broken = Proposal(
        kind="tuning",
        payload={"tuning": True, "action": "not_a_real_action", "rule_id": "r"},
        created_by="tuner",
        evidence_fingerprint="ev1:whatever",
    )
    await app_state.proposals.add(broken)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(broken.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 400
    assert isinstance(caught.value.detail, str)
    assert "unknown tuning approval action" in caught.value.detail


def test_materialize_refusals_carry_a_machine_readable_code() -> None:
    """The seam itself, without HTTP: every refusal names why, for any caller."""
    prefs = Preferences()
    payload = _apply_payload("pure_rule", int(prefs.correlation_for("pure_rule").n))
    fingerprint = evidence_fingerprint(payload)

    # Verified + current → materialises.
    updated, record, changed = materialize_approved_tuning(
        prefs, payload, proposal_id="p1", evidence_fingerprint_recorded=fingerprint,
    )
    assert changed is True and record is not None
    assert updated.correlation_for("pure_rule").n == payload["after"]

    with pytest.raises(StaleTuningProposal) as missing:
        materialize_approved_tuning(prefs, payload, proposal_id="p1")
    assert missing.value.tuning_evidence_code == "evidence_fingerprint_missing"

    with pytest.raises(StaleTuningProposal) as mismatch:
        materialize_approved_tuning(
            prefs, payload, proposal_id="p1", evidence_fingerprint_recorded="ev1:nope",
        )
    assert mismatch.value.tuning_evidence_code == "evidence_fingerprint_mismatch"

    # A fingerprint that matches a payload carrying NO provenance at all is still
    # unusable: it proves the numbers were not edited, never where they came from.
    bare = {key: value for key, value in payload.items() if key != PROVENANCE_KEY}
    with pytest.raises(StaleTuningProposal) as no_provenance:
        materialize_approved_tuning(
            prefs, bare, proposal_id="p1",
            evidence_fingerprint_recorded=evidence_fingerprint(bare),
        )
    assert no_provenance.value.tuning_evidence_code == "evidence_provenance_missing"

    # A ValueError subclass, so every existing caller keeps its current handling.
    assert isinstance(mismatch.value, ValueError)


def test_fingerprint_is_stable_deterministic_and_provenance_sensitive() -> None:
    """It must survive a JSON round-trip and change when the provenance story changes."""
    payload = _apply_payload("stable_rule", 5)
    assert evidence_fingerprint(payload) == evidence_fingerprint(dict(payload))
    assert evidence_fingerprint(payload).startswith("ev1:")

    reordered = {key: payload[key] for key in reversed(list(payload))}
    assert evidence_fingerprint(reordered) == evidence_fingerprint(payload)

    laundered = dict(payload)
    laundered[PROVENANCE_KEY] = {
        **_independent_provenance(),
        "independent_analyst_outcomes": 0,
        "bulk_ratified_model_verdicts": 40,
    }
    assert evidence_fingerprint(laundered) != evidence_fingerprint(payload)


# --------------------------------------------------------------------------- #
# 2. BULK-RATIFIED EVIDENCE IS NEVER "ANALYST-CONFIRMED"
# --------------------------------------------------------------------------- #
def test_bulk_ratified_evidence_is_never_labelled_analyst_confirmed() -> None:
    payload = _apply_payload("ratified_rule", 5)
    payload["analyst_samples"] = 0
    payload[PROVENANCE_KEY] = {
        "independent_analyst_outcomes": 0,
        "analyst_feedback_labels": 0,
        "explicit_disposition_labels": 0,
        "bulk_ratified_model_verdicts": 97,
        "unlabelled_cases": 0,
        "provenance": PROVENANCE_BULK_RATIFIED,
        "analyst_confirmed": False,
    }
    proposal = Proposal(
        kind="tuning", payload=payload, evidence_fingerprint=evidence_fingerprint(payload),
    )

    summary = evidence_summary(proposal)
    assert summary["provenance"] == PROVENANCE_BULK_RATIFIED
    assert summary["analyst_confirmed"] is False
    assert summary["independent_analyst_outcomes"] == 0
    assert summary["bulk_ratified_model_verdicts"] == 97
    assert summary["approvable"] is False
    assert summary["blocked_reason"] == "evidence_not_analyst_confirmed"
    assert "not analyst ground truth" in summary["label"]
    assert "analyst-confirmed" not in summary["label"]


def test_a_payload_cannot_relabel_bulk_ratification_as_analyst_confirmed() -> None:
    """``analyst_confirmed`` is DERIVED, never taken from the drafter's own claim."""
    payload = _apply_payload("liar_rule", 5)
    payload[PROVENANCE_KEY] = {
        "independent_analyst_outcomes": 0,
        "analyst_feedback_labels": 0,
        "explicit_disposition_labels": 0,
        "bulk_ratified_model_verdicts": 97,
        "unlabelled_cases": 0,
        "provenance": PROVENANCE_INDEPENDENT_ANALYST,   # the lie
        "analyst_confirmed": True,                      # ... and again
    }
    proposal = Proposal(
        kind="tuning", payload=payload, evidence_fingerprint=evidence_fingerprint(payload),
    )

    summary = evidence_summary(proposal)
    assert summary["provenance"] == PROVENANCE_BULK_RATIFIED
    assert summary["analyst_confirmed"] is False
    assert summary["approvable"] is False


def test_mixed_evidence_counts_only_the_independent_part() -> None:
    payload = _apply_payload("mixed_rule", 5)
    payload[PROVENANCE_KEY] = {
        "independent_analyst_outcomes": 40,
        "analyst_feedback_labels": 40,
        "explicit_disposition_labels": 0,
        "bulk_ratified_model_verdicts": 12,
        "unlabelled_cases": 3,
        "provenance": PROVENANCE_MIXED,
        "analyst_confirmed": True,
    }
    summary = evidence_summary(Proposal(
        kind="tuning", payload=payload, evidence_fingerprint=evidence_fingerprint(payload),
    ))
    assert summary["provenance"] == PROVENANCE_MIXED
    assert summary["analyst_confirmed"] is True
    assert summary["independent_analyst_outcomes"] == 40
    assert "12 bulk-ratified model verdicts are excluded" in summary["label"]
    assert summary["approvable"] is True


async def test_approve_refuses_a_threshold_change_standing_on_ratified_verdicts(
    app_state: AppState,
) -> None:
    """The dangerous moment, end to end: the agent must not tune itself."""
    before = app_state.execution_prefs.correlation_for("self_tuned_rule").n
    payload = _apply_payload("self_tuned_rule", before)
    payload["analyst_samples"] = 0
    payload[PROVENANCE_KEY] = {
        "independent_analyst_outcomes": 0,
        "analyst_feedback_labels": 0,
        "explicit_disposition_labels": 0,
        "bulk_ratified_model_verdicts": 97,
        "unlabelled_cases": 0,
        "provenance": PROVENANCE_BULK_RATIFIED,
        "analyst_confirmed": False,
    }
    prop = Proposal(
        kind="tuning",
        payload=payload,
        created_by="tuner",
        evidence_fingerprint=evidence_fingerprint(payload),
    )
    await app_state.proposals.add(prop)

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "evidence_not_analyst_confirmed"
    assert app_state.execution_prefs.correlation_for("self_tuned_rule").n == before
    assert _decision_rows(app_state, prop.id, "approve") == []


async def test_the_api_projection_carries_the_provenance_distinction(client) -> None:
    """The card renders exactly the claim the server is willing to act on."""
    state: AppState = client.app.state.tlsoc
    payload = _apply_payload("card_rule", 5)
    payload[PROVENANCE_KEY] = {
        "independent_analyst_outcomes": 0,
        "analyst_feedback_labels": 0,
        "explicit_disposition_labels": 0,
        "bulk_ratified_model_verdicts": 97,
        "unlabelled_cases": 0,
        "provenance": PROVENANCE_BULK_RATIFIED,
        "analyst_confirmed": False,
    }
    await state.proposals.add(Proposal(
        kind="tuning",
        payload=payload,
        created_by="tuner",
        evidence_fingerprint=evidence_fingerprint(payload),
    ))

    listed = client.get("/api/proposals?status=pending")
    assert listed.status_code == 200, listed.text
    row = next(p for p in listed.json()["proposals"] if p["kind"] == "tuning")
    assert row["evidence"]["analyst_confirmed"] is False
    assert row["evidence"]["provenance"] == PROVENANCE_BULK_RATIFIED
    assert row["evidence"]["approvable"] is False
    assert row["evidence"]["bulk_ratified_model_verdicts"] == 97
    # The lease/recovery identity stays internal; the evidence block is additive.
    assert "applying_token" not in row and "decision_actor" not in row


async def test_the_tuner_reports_bulk_ratified_volume_apart_from_analyst_labels(
    app_state: AppState,
) -> None:
    """End to end: a bulk-ratified window can never present itself as analyst evidence.

    Every case here carries the append-only ``precedent_ratification`` history event the
    bulk bootstrap writes. ``analyst_confirmed_outcome`` cannot see it — so the tuner
    still has ZERO independent labels — and the drafted proposal says so out loud
    instead of leaving the operator to assume the samples were human.
    """
    cases = [
        _ratified_case(f"r{i}", "ratified_rule") for i in range(30)
    ]
    prefs = _tuning_prefs(min_samples=25)
    audit = _FakeAudit()
    store = TuningStore(app_state.kv)

    async def _write(prefs_in: Preferences) -> Preferences:
        raise AssertionError("an unlabelled window must never write configuration")

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=_write,
    )

    assert outcome.auto_applied == []
    queued = await app_state.proposals.list(status="pending")
    assert len(queued) == 1
    payload = queued[0].payload
    # NOT an apply_change: there is nothing analyst-derived to justify one.
    assert payload["action"] == "collect_evidence"
    assert payload["analyst_samples"] == 0
    provenance = payload[PROVENANCE_KEY]
    assert provenance["independent_analyst_outcomes"] == 0
    assert provenance["bulk_ratified_model_verdicts"] == 30
    assert provenance["analyst_confirmed"] is False
    summary = evidence_summary(queued[0])
    assert summary["provenance"] == PROVENANCE_BULK_RATIFIED
    assert summary["analyst_confirmed"] is False


async def test_independent_analyst_evidence_is_recorded_and_verifiable(
    app_state: AppState,
) -> None:
    """The healthy path still drafts a verifiable, approvable recommendation."""
    cases = [_graded_case(f"g{i}", "graded_rule", tp=(i < 2)) for i in range(30)]
    prefs = _tuning_prefs(min_samples=25)
    audit = _FakeAudit()
    store = TuningStore(app_state.kv)

    async def _write(prefs_in: Preferences) -> Preferences:
        return prefs_in

    await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=_write,
    )

    queued = await app_state.proposals.list(status="pending")
    assert len(queued) == 1
    drafted = queued[0]
    assert drafted.payload["action"] == "apply_change"
    assert drafted.evidence_fingerprint == evidence_fingerprint(drafted.payload)
    summary = evidence_summary(drafted)
    assert summary["provenance"] == PROVENANCE_INDEPENDENT_ANALYST
    assert summary["analyst_confirmed"] is True
    assert summary["approvable"] is True
    # The re-draft key is provenance-aware, so a pre-provenance row cannot suppress it.
    assert drafted.payload["dedupe_key"].startswith("tuning:v3:")


# --------------------------------------------------------------------------- #
# 3. EXPIRY + GARBAGE COLLECTION
# --------------------------------------------------------------------------- #
async def test_an_expired_proposal_is_not_approvable(app_state: AppState) -> None:
    prop = _tuning_proposal(app_state, "lapsed_rule")
    before = app_state.execution_prefs.correlation_for("lapsed_rule").n
    await app_state.proposals.add(prop.model_copy(update={"expires_at": _past()}))

    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _Request(app_state), state=app_state)

    assert caught.value.status_code == 409
    assert caught.value.detail["error"] == "proposal_expired"
    assert caught.value.detail["redraft_required"] is True
    # Refused at the claim, before the audit phase and before any effect.
    assert _decision_rows(app_state, prop.id, "approve") == []
    assert app_state.execution_prefs.correlation_for("lapsed_rule").n == before
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"


async def test_an_expired_proposal_is_hidden_from_the_queue_before_any_sweep(
    app_state: AppState,
) -> None:
    """Read-time honesty does not wait for the sweeper to succeed."""
    live = Proposal(kind="automation_ack", payload={}, expires_at=_future())
    lapsed = Proposal(kind="automation_ack", payload={}, expires_at=_past())
    await app_state.proposals.add(live)
    await app_state.proposals.add(lapsed)

    pending = await app_state.proposals.list(status="pending")
    assert [p.id for p in pending] == [live.id]
    everything = {p.id: p.status for p in await app_state.proposals.list()}
    assert everything[lapsed.id] == "expired"
    # The projection is a VIEW: persistence is untouched until a sweep runs.
    persisted = {p.id: p.status for p in await app_state.proposals.list_strict()}
    assert persisted[lapsed.id] == "pending"


async def test_the_sweeper_makes_expiry_durable_and_is_idempotent(
    app_state: AppState,
) -> None:
    live = Proposal(kind="automation_ack", payload={}, expires_at=_future())
    lapsed = Proposal(kind="automation_ack", payload={}, expires_at=_past())
    never = Proposal(kind="automation_ack", payload={})
    for row in (live, lapsed, never):
        await app_state.proposals.add(row)

    swept = await app_state.proposals.sweep_expired()
    assert [p.id for p in swept] == [lapsed.id]
    persisted = {p.id: p.status for p in await app_state.proposals.list_strict()}
    assert persisted == {live.id: "pending", lapsed.id: "expired", never.id: "pending"}
    # Nobody decided it — the row never claims a human retired it.
    retired = await app_state.proposals.get(lapsed.id)
    assert retired is not None
    assert retired.decided_by is None and retired.decision_actor is None

    # Idempotent, and a no-op sweep performs no write at all.
    async def _explode(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("a no-op sweep must not write")

    original_put = app_state.kv.put
    app_state.kv.put = _explode  # type: ignore[method-assign]
    try:
        assert await app_state.proposals.sweep_expired() == []
    finally:
        app_state.kv.put = original_put  # type: ignore[method-assign]


async def test_the_list_endpoint_sweeps_and_reports_what_it_retired(client) -> None:
    state: AppState = client.app.state.tlsoc
    lapsed = Proposal(kind="automation_ack", payload={}, expires_at=_past())
    await state.proposals.add(lapsed)

    listed = client.get("/api/proposals")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["expired_swept"] == 1
    row = next(p for p in body["proposals"] if p["id"] == lapsed.id)
    assert row["status"] == "expired" and row["expired"] is True
    assert not [p for p in client.get("/api/proposals?status=pending").json()["proposals"]
                if p["id"] == lapsed.id]
    # The housekeeping transition is itself audited (#2).
    es = state.audit._es
    summaries = [
        str(src.get("result_summary") or "")
        for index in es._matching_indices(AUDIT_READ_PATTERN)
        for src in es.docs.get(index, {}).values()
    ]
    assert any(lapsed.id in text and "expired 1 pending proposals" in text for text in summaries)


async def test_an_expired_proposal_can_still_be_rejected(app_state: AppState) -> None:
    """Retiring dead review work is how a queue is cleared, and it changes nothing."""
    lapsed = Proposal(kind="automation_ack", payload={}, expires_at=_past())
    await app_state.proposals.add(lapsed)
    await app_state.proposals.sweep_expired()

    result = await reject_proposal(lapsed.id, _Request(app_state), state=app_state)

    assert result["ok"] is True
    assert result["proposal"]["status"] == "rejected"
    assert len(_decision_rows(app_state, lapsed.id, "reject")) == 1


async def test_a_suppression_rule_lifetime_is_not_a_review_deadline(
    app_state: AppState,
) -> None:
    """``expires_at`` on a suppression proposal is the RULE's lifetime, not the row's.

    Approving one with a short (even past) lifetime must keep working exactly as it
    always has — retiring the operator's review item for an unrelated reason would be a
    silent behaviour change.
    """
    prop = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "short_lived", "enabled": True},
        confidence=0.8,
        created_by="agent",
        expires_at=_past(),
    )
    assert proposal_is_expired(prop) is False
    await app_state.proposals.add(prop)

    result = await approve_proposal(prop.id, _Request(app_state), state=app_state)
    assert result["ok"] is True
    assert result["proposal"]["status"] == "approved"


# --------------------------------------------------------------------------- #
# 4. BULK REJECT — through the strict audit path, per proposal
# --------------------------------------------------------------------------- #
async def test_bulk_reject_audits_every_item_through_the_strict_path(client) -> None:
    state: AppState = client.app.state.tlsoc
    rows = [Proposal(kind="automation_ack", payload={"i": i}) for i in range(3)]
    for row in rows:
        await state.proposals.add(row)

    response = client.post("/api/proposals/bulk-reject", json={
        "ids": [r.id for r in rows],
        "reason": "queue predates the approval fix",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert sorted(body["rejected"]) == sorted(r.id for r in rows)
    assert body["failed"] == []
    for row in rows:
        # One append-only, event_id-keyed decision record each — the same row the
        # single-proposal endpoint writes, carrying the operator's reason.
        decisions = _decision_rows(state, row.id, "reject")
        assert len(decisions) == 1
        assert "reason=queue predates the approval fix" in decisions[0]["result_summary"]
        stored = await state.proposals.get(row.id)
        assert stored is not None and stored.status == "rejected"
        assert stored.decision_reason == "queue predates the approval fix"


async def test_bulk_reject_is_idempotent(client) -> None:
    state: AppState = client.app.state.tlsoc
    row = Proposal(kind="automation_ack", payload={})
    await state.proposals.add(row)
    payload = {"ids": [row.id, row.id], "reason": "clearing"}

    first = client.post("/api/proposals/bulk-reject", json=payload)
    second = client.post("/api/proposals/bulk-reject", json=payload)

    assert first.status_code == 200 and second.status_code == 200
    # Duplicate ids within one request collapse; a replayed request is a no-op.
    assert first.json()["requested"] == 1
    assert first.json()["rejected"] == [row.id]
    assert second.json()["ok"] is True
    assert second.json()["already_rejected"] == [row.id]
    assert second.json()["rejected"] == []
    assert len(_decision_rows(state, row.id, "reject")) == 1


async def test_one_bad_item_does_not_abort_the_batch(client, monkeypatch) -> None:
    """Partial success is reported per item rather than failing everything."""
    state: AppState = client.app.state.tlsoc
    good_a = Proposal(kind="automation_ack", payload={"n": "a"})
    doomed = Proposal(kind="automation_ack", payload={"n": "b"})
    good_b = Proposal(kind="automation_ack", payload={"n": "c"})
    for row in (good_a, doomed, good_b):
        await state.proposals.add(row)

    original = state.control_audit.record_strict

    async def _selective(*args: Any, **kwargs: Any) -> None:
        if kwargs.get("event_id") == f"proposal-decision:{doomed.id}:reject":
            raise RuntimeError("audit ledger unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(state.control_audit, "record_strict", _selective)

    response = client.post("/api/proposals/bulk-reject", json={
        "ids": [good_a.id, "prop-does-not-exist", doomed.id, good_b.id],
        "reason": "bulk cleanup",
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert sorted(body["rejected"]) == sorted([good_a.id, good_b.id])
    assert sorted(body["failed"]) == sorted(["prop-does-not-exist", doomed.id])
    outcomes = {r["id"]: r["outcome"] for r in body["results"]}
    assert outcomes["prop-does-not-exist"] == "missing"
    assert outcomes[doomed.id] == "incomplete"
    # The two healthy proposals really were decided, and the failed one stayed pending
    # with no half-written decision record.
    assert (await state.proposals.get(good_a.id)).status == "rejected"
    assert (await state.proposals.get(good_b.id)).status == "rejected"
    assert (await state.proposals.get(doomed.id)).status == "pending"
    assert _decision_rows(state, doomed.id, "reject") == []


async def test_bulk_reject_clears_expired_review_work(client) -> None:
    state: AppState = client.app.state.tlsoc
    lapsed = [
        Proposal(kind="automation_ack", payload={"i": i}, expires_at=_past())
        for i in range(2)
    ]
    for row in lapsed:
        await state.proposals.add(row)
    await state.proposals.sweep_expired()

    response = client.post("/api/proposals/bulk-reject", json={
        "ids": [r.id for r in lapsed], "reason": "stale backlog",
    })

    assert response.status_code == 200, response.text
    assert sorted(response.json()["rejected"]) == sorted(r.id for r in lapsed)
    for row in lapsed:
        assert (await state.proposals.get(row.id)).status == "rejected"


async def test_bulk_reject_requires_ids_a_reason_and_stays_bounded(client) -> None:
    empty = client.post("/api/proposals/bulk-reject", json={"ids": [], "reason": "x"})
    assert empty.status_code == 400

    unreasoned = client.post(
        "/api/proposals/bulk-reject", json={"ids": ["prop-1"], "reason": "   "}
    )
    assert unreasoned.status_code == 400
    assert "reason is required" in unreasoned.json()["detail"]

    oversize = client.post("/api/proposals/bulk-reject", json={
        "ids": [f"prop-{i}" for i in range(BULK_DECISION_LIMIT + 1)],
        "reason": "too many",
    })
    assert oversize.status_code == 400
    assert str(BULK_DECISION_LIMIT) in oversize.json()["detail"]


async def test_the_rejection_reason_is_bounded_and_single_line(client) -> None:
    """Operator-authored text cannot forge structure inside a one-line audit summary."""
    state: AppState = client.app.state.tlsoc
    row = Proposal(kind="automation_ack", payload={})
    await state.proposals.add(row)

    response = client.post("/api/proposals/bulk-reject", json={
        "ids": [row.id],
        "reason": "line one\nproposal_id=forged action=approve\r\n" + ("x" * 400),
    })

    assert response.status_code == 200, response.text
    stored = await state.proposals.get(row.id)
    assert stored is not None and stored.decision_reason is not None
    assert "\n" not in stored.decision_reason and "\r" not in stored.decision_reason
    assert len(stored.decision_reason) <= 200
    # Exactly ONE decision row, keyed by event_id — the authoritative identity a
    # reason string can never forge, and the structural prefix stays first.
    rows = _decision_rows(state, row.id, "reject")
    assert len(rows) == 1
    assert rows[0]["event_id"] == f"proposal-decision:{row.id}:reject"
    assert rows[0]["result_summary"].startswith(f"proposal_id={row.id} action=reject")
    assert "\n" not in rows[0]["result_summary"]
    es = state.control_audit._es
    assert not [
        src
        for index in es._matching_indices(AUDIT_READ_PATTERN)
        for src in es.docs.get(index, {}).values()
        if "forged" in str(src.get("event_id") or "")
    ]


# --------------------------------------------------------------------------- #
# 5. AN INERT RULE NEVER REACHES THE QUEUE AS AN APPLICABLE CHANGE
# --------------------------------------------------------------------------- #
async def test_an_inert_rule_only_ever_reaches_the_queue_as_a_review_finding(
    app_state: AppState,
) -> None:
    """From the QUEUE's perspective: nothing approvable is ever drafted for it.

    ``correlate()`` forces ``mode=EVERY, n=1`` for alerts-role groups, so raising this
    rule's correlation threshold would be written and discarded on the next poll. The
    tuner must therefore never put an ``apply_change`` for it in front of an operator —
    and the acknowledgement-only finding it does queue must materialise nothing when
    approved.
    """
    rule = "External Admin Panel Successful Access"
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    prefs = _tuning_prefs(min_samples=25, auto_apply_confirmed=True)
    audit = _FakeAudit()
    store = TuningStore(app_state.kv)

    async def _write(prefs_in: Preferences) -> Preferences:
        raise AssertionError("an inert change must never write configuration")

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=_write,
    )

    assert outcome.auto_applied == []
    assert [row["reason"] for row in outcome.inert_rules] == [INERT_ALERTS_ROLE_OVERRIDE]

    queued = await app_state.proposals.list(status="pending")
    assert len(queued) == 1
    finding = queued[0]
    assert finding.payload["action"] == "review_finding"
    assert finding.payload["before"] == finding.payload["after"]
    assert finding.payload["inert_reason"] == INERT_ALERTS_ROLE_OVERRIDE
    assert not [p for p in queued if p.payload.get("action") == "apply_change"]

    # Approving the finding acknowledges the observation and materialises NOTHING.
    async def _no_writes(_mutate: Any) -> Preferences:
        raise AssertionError("a review finding must never persist preferences")

    app_state.mutate_execution_prefs = _no_writes  # type: ignore[method-assign]
    result = await approve_proposal(finding.id, _Request(app_state), state=app_state)
    assert result["proposal"]["status"] == "approved"
    assert await store.list_strict() == []
    assert len(_decision_rows(app_state, finding.id, "approve")) == 1


# --------------------------------------------------------------------------- #
# Case + prefs builders for the tuner-driven tests above
# --------------------------------------------------------------------------- #
def _tuning_prefs(**over: Any) -> Preferences:
    cfg = ThresholdTuningConfig(
        enabled=True,
        min_samples=over.pop("min_samples", 25),
        fp_rate_target=over.pop("fp_rate_target", 0.30),
        max_n_step=over.pop("max_n_step", 1),
        shadow_eval=True,
        cadence="nightly",
        auto_apply_confirmed=over.pop("auto_apply_confirmed", False),
    )
    return Preferences(threshold_tuning=cfg, sources=[_events_source()], **over)


def _events_source() -> SourceInstance:
    return SourceInstance(
        id="src1",
        source_type=SourceType.ELASTICSEARCH,
        ingest_mode=IngestMode.PULL,
        config={"index_patterns": [{"pattern": "all-logs-*", "id": "feedA", "role": "events"}]},
    )


def _base_case(case_id: str, rule: str, *, mode: str, n: int, observed: int) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.10"),
        rule_ids=[rule],
        member_event_ids=[f"{case_id}-e{i}" for i in range(observed)],
        verdict=Verdict.FALSE_POSITIVE,
        confidence=0.9,
        status="closed",  # type: ignore[arg-type]
        updated_at=(now_utc() - timedelta(days=1)).isoformat(),
        trigger_reason=TriggerReason(
            rule_value=rule, mode=mode, n=n, observed_count=observed,
            severity_max=5.0, rule_values=[rule],
        ),
    )


def _graded_case(case_id: str, rule: str, *, tp: bool = False) -> Case:
    """A closed case an analyst independently graded."""
    case = _base_case(case_id, rule, mode="threshold", n=5, observed=6)
    case.verdict = Verdict.TRUE_POSITIVE if tp else Verdict.FALSE_POSITIVE
    case.feedback = [
        FeedbackEntry(
            analyst="analyst",
            actual_outcome="true_positive" if tp else "false_positive",
        )
    ]
    return case


def _ratified_case(case_id: str, rule: str) -> Case:
    """A closed case whose MODEL verdict an operator bulk-ratified as weak precedent.

    No ``FeedbackEntry`` and no ``analyst_action`` — deliberately, because that is the
    whole point of the upstream fix: this is not analyst ground truth.
    """
    case = _base_case(case_id, rule, mode="threshold", n=5, observed=6)
    case.history = [precedent_ratification_entry(
        actor="operator", batch_id="batch-1", outcome="false_positive", confidence=0.9,
    )]
    return case


def _alerts_case(case_id: str, rule: str) -> Case:
    """A case produced through the alerts-role override: effective mode EVERY, n=1."""
    case = _base_case(case_id, rule, mode="every", n=1, observed=1)
    case.feedback = [FeedbackEntry(analyst="analyst", actual_outcome="false_positive")]
    return case
