"""The auto-close gate's truth table, pinned (#3).

``engine.case_manager.decide()`` is the ONE authority over close/escalate. Everything
around it — the precedent corpus, its repair pass, retrieval, playbooks, the router —
may inform a verdict and may never move this boundary. That is easy to say and hard to
notice breaking: a threshold nudged in ``config.py``, or a class quietly enabled,
changes what closes itself on every deployment and no other test in the suite would
turn red.

So this file states the SHIPPED thresholds and the outcome at, below and above each of
them, for every verdict class, as explicit expectations. A future change to the policy
is then a deliberate edit HERE, in a file whose whole subject is that boundary, rather
than a silent side effect somewhere else.

Two things are deliberately derived rather than declared:

* which verdict classes can auto-close AT ALL is discovered BY CALLING ``decide()``
  with maximally favourable inputs, not by reading ``enabled`` off the config schema.
  Reading the schema would only prove the schema agrees with itself; calling the code
  proves the code agrees with the schema.
* the boundary points come from the shipped policy object, so the matrix is generated
  from whatever the product actually ships.
"""

from __future__ import annotations

import pytest

from app.config import AutoClosePolicy, VerdictAutoClose
from app.constants import CaseStatus, DecisionBy, Verdict
from app.engine.case_manager import decide

# A step small enough to sit strictly inside any float boundary the policy can express.
_EPSILON = 1e-6

_VERDICT_CLASSES: tuple[Verdict | None, ...] = (
    Verdict.FALSE_POSITIVE,
    Verdict.TRUE_POSITIVE,
    Verdict.NEEDS_HUMAN,
    None,
)


def _entry(policy: AutoClosePolicy, verdict: Verdict | None) -> VerdictAutoClose | None:
    """The policy entry a verdict class reads, or None when it has no closable entry."""
    if verdict == Verdict.FALSE_POSITIVE:
        return policy.false_positive
    if verdict == Verdict.TRUE_POSITIVE:
        return policy.true_positive
    return None


def _closes(policy: AutoClosePolicy, verdict: Verdict | None) -> bool:
    """Whether this verdict class can auto-close, ESTABLISHED BY CALLING decide().

    Maximally favourable inputs: perfect confidence and zero risk. Anything that still
    routes to a human under those conditions cannot auto-close under any input.
    """
    return (
        decide(verdict, 1.0, 0.0, policy).status == CaseStatus.CLOSED
    )


def test_the_shipped_auto_close_policy_is_what_it_says_it_is() -> None:
    """The defaults, stated. Conservative on purpose; changing one is a decision."""
    policy = AutoClosePolicy()

    assert policy.false_positive.enabled is True
    assert policy.false_positive.min_confidence == 0.85
    assert policy.false_positive.max_risk_score == 30.0
    assert policy.false_positive.objection_window_minutes == 1440

    # TRUE_POSITIVE auto-close is a supported OPT-IN and ships OFF.
    assert policy.true_positive.enabled is False
    assert policy.true_positive.min_confidence == 0.95
    assert policy.true_positive.max_risk_score == 10.0
    assert policy.true_positive.objection_window_minutes == 4320

    assert policy.needs_human.enabled is False


def test_only_the_classes_the_code_admits_can_auto_close() -> None:
    """Derived by CALLING decide(), never read off the config schema."""
    policy = AutoClosePolicy()
    closable = {v for v in _VERDICT_CLASSES if _closes(policy, v)}

    assert closable == {Verdict.FALSE_POSITIVE}, (
        "the set of auto-closable verdict classes changed; that is a policy decision "
        "and must be an explicit edit here"
    )


def test_needs_human_never_auto_closes_however_it_is_configured() -> None:
    """CODE-ENFORCED, not policy-tunable (#3).

    ``needs_human`` exists on the policy object, so an operator (or a migration, or a
    settings round-trip) can set ``enabled=True`` on it. ``_entry_for`` never returns
    it, so the value is inert — and a missing/unknown verdict fails safe the same way.
    """
    wide_open = VerdictAutoClose(
        enabled=True, min_confidence=0.0, max_risk_score=100.0
    )
    policy = AutoClosePolicy(needs_human=wide_open)

    for verdict in (Verdict.NEEDS_HUMAN, None):
        for confidence in (0.0, 0.5, 1.0):
            for risk in (0.0, 50.0, 100.0):
                decision = decide(verdict, confidence, risk, policy)
                assert decision.status == CaseStatus.NEEDS_HUMAN
                assert decision.decision_by == DecisionBy.SYSTEM
                assert decision.objection_window_expires_at is None


@pytest.mark.parametrize("verdict", [Verdict.FALSE_POSITIVE, Verdict.TRUE_POSITIVE])
def test_the_boundary_matrix_for_each_verdict_class(verdict: Verdict) -> None:
    """Below / AT / above each threshold, for each class, against the shipped policy.

    The comparison the code makes is ``confidence >= min`` and ``risk <= max``, so AT
    the boundary is INSIDE the closable region on both axes. That asymmetry (one
    ``>=``, one ``<=``) is exactly the kind of thing an edit gets backwards, so both
    boundaries are asserted from both sides.
    """
    policy = AutoClosePolicy()
    entry = _entry(policy, verdict)
    assert entry is not None
    closable = _closes(policy, verdict)

    confidences = (
        entry.min_confidence - _EPSILON,
        entry.min_confidence,
        entry.min_confidence + _EPSILON,
    )
    risks = (
        entry.max_risk_score - _EPSILON,
        entry.max_risk_score,
        entry.max_risk_score + _EPSILON,
    )
    for confidence in confidences:
        for risk in risks:
            clears = confidence >= entry.min_confidence and risk <= entry.max_risk_score
            expected = (
                CaseStatus.CLOSED
                if (closable and clears)
                else CaseStatus.NEEDS_HUMAN
            )
            decision = decide(verdict, confidence, risk, policy)
            assert decision.status == expected, (
                f"{verdict.value} at confidence={confidence} risk={risk}: "
                f"expected {expected.value}, got {decision.status.value}"
            )
            if expected == CaseStatus.CLOSED:
                assert decision.decision_by == DecisionBy.AGENT
                assert decision.objection_window_expires_at is not None
                assert decision.escalate is False
            else:
                assert decision.decision_by == DecisionBy.SYSTEM
                assert decision.objection_window_expires_at is None


def test_a_disabled_class_never_closes_at_any_point_in_the_matrix() -> None:
    """Turning a class off is absolute, not a stricter bar."""
    policy = AutoClosePolicy(
        false_positive=VerdictAutoClose(
            enabled=False, min_confidence=0.0, max_risk_score=100.0
        )
    )
    for confidence in (0.0, 0.5, 1.0):
        for risk in (0.0, 50.0, 100.0):
            assert (
                decide(Verdict.FALSE_POSITIVE, confidence, risk, policy).status
                == CaseStatus.NEEDS_HUMAN
            )


def test_escalation_prioritises_but_never_closes() -> None:
    """Escalation is a PRIORITY flag on a human-routed case, never a decision."""
    policy = AutoClosePolicy()
    decision = decide(Verdict.TRUE_POSITIVE, 0.99, 99.0, policy)

    assert decision.status == CaseStatus.NEEDS_HUMAN
    assert decision.escalate is True
    assert decision.objection_window_expires_at is None
