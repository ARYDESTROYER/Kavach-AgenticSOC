"""Item E + §14 G3 — honest auto-close measurement from the APPEND-ONLY trail.

The defect these pin: the suite shipped THREE auto-close rates on three different
clocks (``quality_metrics.automation_rate`` and ``trend_metrics`` bucket by case
CREATION, ``auto_close_health`` by the LAST decision), and all three read the MUTABLE
``case.decision_by``/``case.status``. Those are LAST-WRITER fields — every analyst
lifecycle action stamps ``decision_by = ANALYST`` — so merely acknowledging an agent
auto-close rewrote history in every past window. The durable, point-in-time record
(``case_manager.apply()``'s append-only ``{"event": "decision"}`` history entry, plus
the pipeline's DECISION audit row beside it) already existed and nothing read it.

What is pinned here:

* the accessor reproduces the trail EXACTLY on a case that was reopened and re-decided,
  while the case's own mutable fields disagree with it;
* FIRST-decision anchoring is stable under reinvestigation — a re-decided case counts
  ONCE, in its original window, with its original outcome;
* an outage window DERIVED from the deployment's own provider-health record excludes
  exactly the decisions inside it, and the derivation is relative, never calendar-pinned
  (proved by shift-invariance, not by inspection);
* the closable-verdict-class list comes from ``case_manager._entry_for``, so a policy
  with ``needs_human.enabled = True`` still reports NEEDS_HUMAN as not-closable;
* the LEGACY series is byte-for-byte unchanged.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.config import AutoClosePolicy, VerdictAutoClose
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.metrics import (
    AUTO_CLOSE_MIN_DECIDED,
    DECISION_ANCHOR_FIRST,
    DECISION_ANCHOR_LAST,
    GATE_BLOCKED_CONFIDENCE,
    GATE_BLOCKED_CONFIDENCE_AND_RISK,
    GATE_BLOCKED_RISK,
    GATE_CLASS_DISABLED,
    GATE_CLEARED,
    GATE_NOT_CLOSABLE,
    GATE_UNRECORDED,
    anchored_decision_audit,
    auto_close_health,
    classify_auto_close_gate,
    decision_record,
    decision_records,
    derive_dependency_context,
    derive_outage_windows,
    parse_decision_audit_row,
    recorded_auto_close_health,
)
from app.models import Case, Entity

_FP_ON = AutoClosePolicy(
    false_positive=VerdictAutoClose(
        enabled=True, min_confidence=0.85, max_risk_score=30.0, objection_window_minutes=1440
    )
)


# --------------------------------------------------------------------------- #
# Builders — every instant is RELATIVE to the supplied ``now``. No calendar dates.
# --------------------------------------------------------------------------- #
def _base_now() -> datetime:
    """A deterministic-but-not-calendar-pinned clock, floored to the hour.

    Derived from the machine clock rather than written as a literal, so nothing in the
    outage tests below can accidentally depend on a specific date — the exact failure
    the portability tripwire over ``engine/metrics.py`` exists to prevent."""
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _case(
    cid: str,
    *,
    now: datetime,
    verdict: Verdict | None = Verdict.FALSE_POSITIVE,
    status: CaseStatus = CaseStatus.CLOSED,
    decision_by: DecisionBy | None = DecisionBy.AGENT,
) -> Case:
    """A case with NO decision entry yet — ``_decide`` appends those."""
    at = now.isoformat()
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        created_at=at,
        updated_at=at,
        verdict=verdict,
        confidence=0.95,
        status=status,
        decision_by=decision_by,
    )


def _decide(
    case: Case,
    *,
    at: datetime,
    status: CaseStatus,
    decision_by: DecisionBy,
    rationale: str = "test",
) -> Case:
    """Append ONE decision entry exactly as ``case_manager.apply()`` writes it."""
    case.history.append({
        "ts": at.isoformat(),
        "event": "decision",
        "status": status.value,
        "decision_by": decision_by.value,
        "escalate": False,
        "rationale": rationale,
    })
    case.status = status
    case.decision_by = decision_by
    case.updated_at = at.isoformat()
    return case


def _decided_case(
    cid: str,
    *,
    now: datetime,
    hours_ago: float,
    status: CaseStatus = CaseStatus.CLOSED,
    decision_by: DecisionBy = DecisionBy.AGENT,
    verdict: Verdict | None = Verdict.FALSE_POSITIVE,
) -> Case:
    at = now - timedelta(hours=hours_ago)
    case = _case(cid, now=at, verdict=verdict, status=status, decision_by=decision_by)
    return _decide(case, at=at, status=status, decision_by=decision_by)


def _audit_row(case_id: str, *, at: datetime, verdict: str, status: str,
               decision_by: str, risk: float, confidence: float, gate: str) -> dict:
    """A DECISION audit row in the EXACT wire shape the pipeline writes."""
    return {
        "actor": "case_manager",
        "case_id": case_id,
        "action_type": "decision",
        "ts": at.isoformat(),
        "result_summary": (
            f"verdict={verdict} status={status} decision_by={decision_by} "
            f"risk={risk} cost=0.0 confidence={confidence} auto_close_gate={gate}"
        ),
    }


# --------------------------------------------------------------------------- #
# (a) The point-in-time accessor
# --------------------------------------------------------------------------- #
def test_accessor_reproduces_the_trail_on_a_reopened_and_redecided_case() -> None:
    """The mutable case fields LIE about a reopened case; the trail does not.

    Sequence: the agent auto-closes it, an analyst reopens it (stamping
    ``decision_by = ANALYST``, exactly as every lifecycle action in ``api/routes.py``
    does), and a re-investigation decides it again — this time routed to a human. The
    case now reads ``needs_human``/``system``, and every mutable-field metric therefore
    reports it as "never auto-closed". The append-only trail still holds all three
    facts, and the accessor returns them unchanged."""
    now = _base_now()
    case = _case("c-reopened", now=now - timedelta(hours=40))
    _decide(case, at=now - timedelta(hours=40), status=CaseStatus.CLOSED,
            decision_by=DecisionBy.AGENT, rationale="FALSE_POSITIVE auto-closed")
    # An analyst reopens: routes.py stamps ANALYST and appends its own history entry,
    # which is NOT an ``event: decision`` row.
    case.history.append({"ts": (now - timedelta(hours=30)).isoformat(),
                         "event": "analyst_action", "action": "reopen"})
    case.status, case.decision_by = CaseStatus.OPEN, DecisionBy.ANALYST
    _decide(case, at=now - timedelta(hours=2), status=CaseStatus.NEEDS_HUMAN,
            decision_by=DecisionBy.SYSTEM, rationale="routed to human")

    records = decision_records(case)
    assert [(r.index, r.total, r.status, r.decision_by, r.auto_closed) for r in records] == [
        (0, 2, CaseStatus.CLOSED.value, DecisionBy.AGENT.value, True),
        (1, 2, CaseStatus.NEEDS_HUMAN.value, DecisionBy.SYSTEM.value, False),
    ]
    # The non-decision analyst_action entry is not mistaken for a decision.
    assert len(records) == 2

    first = decision_record(case)
    last = decision_record(case, anchor=DECISION_ANCHOR_LAST)
    assert first is not None and last is not None
    assert first.auto_closed is True and first.at == now - timedelta(hours=40)
    assert last.auto_closed is False and last.at == now - timedelta(hours=2)

    # The mutable fields the three legacy series read disagree with the record.
    assert case.decision_by == DecisionBy.SYSTEM and case.status == CaseStatus.NEEDS_HUMAN

    # And the rollup reproduces the trail exactly: ONE auto-close on record, anchored
    # 40h ago — so a 24h window sees nothing, while the lifetime tally sees it.
    out = recorded_auto_close_health([case], window_hours=24, policy=_FP_ON, now=now)
    assert out["current"]["decided"] == 0
    assert out["lifetime"]["decided"] == 1
    assert out["lifetime"]["auto_closed"] == 1
    # Under the legacy LAST-decision clock the same case is a current-window non-close.
    last_out = recorded_auto_close_health(
        [case], window_hours=24, policy=_FP_ON, now=now, anchor=DECISION_ANCHOR_LAST
    )
    assert last_out["current"]["decided"] == 1
    assert last_out["current"]["auto_closed"] == 0


def test_accessor_keeps_a_malformed_timestamp_in_place_instead_of_reordering() -> None:
    """An unreadable ``ts`` must not silently inherit a neighbour's instant, and must
    not be able to reorder an append-only trail."""
    now = _base_now()
    case = _case("c-bad-ts", now=now)
    case.history.append({"ts": "not-a-timestamp", "event": "decision",
                         "status": CaseStatus.CLOSED.value,
                         "decision_by": DecisionBy.AGENT.value})
    _decide(case, at=now, status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM)
    records = decision_records(case)
    assert [r.at for r in records] == [None, now]
    assert decision_record(case).at is None          # first stays first
    assert decision_record(case, anchor=DECISION_ANCHOR_LAST).at == now


def test_a_case_that_never_reached_the_case_manager_is_named_not_counted() -> None:
    """A fail-to-human case carries a NEEDS_HUMAN verdict but NO decision entry —
    ``decide()`` never ran on it. The legacy tally puts it in the denominator; the
    recorded one reports it as ``no_decision_record`` and leaves the rate alone."""
    now = _base_now()
    failed = _case("c-failed", now=now, verdict=Verdict.NEEDS_HUMAN,
                   status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM)
    assert decision_record(failed) is None
    out = recorded_auto_close_health([failed], window_hours=24, policy=_FP_ON, now=now)
    assert out["current"]["decided"] == 0
    assert out["current"]["no_decision_record"] == 1
    # The legacy series does count it as decided — the discontinuity, made explicit.
    legacy = auto_close_health([failed], window_hours=24, policy=_FP_ON, now=now)
    assert legacy["current"]["decided"] == 1


# --------------------------------------------------------------------------- #
# First-decision anchoring is stable under reinvestigation
# --------------------------------------------------------------------------- #
def test_first_decision_anchoring_counts_a_redecided_case_once() -> None:
    """Reinvestigating yesterday's auto-closes must not move today's rate.

    ``AUTO_CLOSE_MIN_DECIDED`` cases are auto-closed in the baseline window. Half of
    them are then re-decided today. Under FIRST anchoring the two windows are unchanged
    — each case is still counted once, in the window it was originally decided in.
    Under the legacy LAST clock the same input moves both windows."""
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    cases = [_decided_case(f"c{i}", now=now, hours_ago=36) for i in range(n)]
    fresh = [_decided_case(f"f{i}", now=now, hours_ago=3) for i in range(n)]

    before = recorded_auto_close_health(cases + fresh, window_hours=24, policy=_FP_ON, now=now)
    assert before["baseline"]["decided"] == n and before["baseline"]["auto_closed"] == n
    assert before["current"]["decided"] == n and before["current"]["auto_closed"] == n

    # Reinvestigate half the baseline cohort NOW; the re-run routes them to a human.
    for case in cases[: n // 2]:
        _decide(case, at=now - timedelta(minutes=5), status=CaseStatus.NEEDS_HUMAN,
                decision_by=DecisionBy.SYSTEM)

    after = recorded_auto_close_health(cases + fresh, window_hours=24, policy=_FP_ON, now=now)
    assert after["baseline"] == before["baseline"]
    assert after["current"] == before["current"]
    assert after["lifetime"]["decided"] == before["lifetime"]["decided"] == 2 * n

    # The legacy LAST clock moves both windows on the same input — that is the bug.
    moved = recorded_auto_close_health(
        cases + fresh, window_hours=24, policy=_FP_ON, now=now, anchor=DECISION_ANCHOR_LAST
    )
    assert moved["current"]["decided"] == n + n // 2
    assert moved["baseline"]["decided"] == n - n // 2


def test_a_later_analyst_retag_cannot_move_a_recorded_number() -> None:
    """The core correction: an analyst merely ACKNOWLEDGING an agent auto-close stamps
    ``decision_by = ANALYST`` and migrates the case out of the legacy ``auto_closed``
    tally. The recorded series reads the decision ENTRY and does not move."""
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    cases = [_decided_case(f"c{i}", now=now, hours_ago=3) for i in range(n)]
    recorded_before = recorded_auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now)
    legacy_before = auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now)
    assert recorded_before["current"]["rate"] == legacy_before["current"]["rate"] == 1.0

    for case in cases:                      # a bulk acknowledge, touching nothing else
        case.decision_by = DecisionBy.ANALYST

    assert recorded_auto_close_health(
        cases, window_hours=24, policy=_FP_ON, now=now
    )["current"] == recorded_before["current"]
    assert auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now
                             )["current"]["auto_closed"] == 0


# --------------------------------------------------------------------------- #
# (c) Outage exclusion — DERIVED, never a date literal
# --------------------------------------------------------------------------- #
def _provider_health(*, last_success: datetime | None, last_failure: datetime) -> dict:
    """A ``ProviderHealth.snapshot()`` in its real wire shape."""
    return {
        "state": "unauthenticated",
        "degraded": True,
        "threshold": 3,
        "providers": {
            "acme:completion": {
                "provider": "acme",
                "channel": "completion",
                "consecutive_failures": 7,
                "last_failure_class": "unauthenticated",
                "last_success_at": last_success.isoformat() if last_success else "",
                "last_failure_at": last_failure.isoformat(),
                "state": "unauthenticated",
            }
        },
    }


def test_outage_window_from_provider_health_excludes_exactly_its_own_rows() -> None:
    """Decisions taken while every model call was failing are not evidence about
    auto-close. The window is bounded by the deployment's OWN recorded
    last-success/last-failure instants."""
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    healthy = [_decided_case(f"ok{i}", now=now, hours_ago=20) for i in range(n)]
    during = [
        _decided_case(f"out{i}", now=now, hours_ago=6, status=CaseStatus.NEEDS_HUMAN,
                      decision_by=DecisionBy.SYSTEM)
        for i in range(n)
    ]
    health = _provider_health(
        last_success=now - timedelta(hours=10), last_failure=now - timedelta(hours=1)
    )

    windows = derive_outage_windows(provider_health=health)
    assert [w.subsystem for w in windows] == ["llm_provider"]
    assert windows[0].start_known is True

    out = recorded_auto_close_health(
        healthy + during, window_hours=24, policy=_FP_ON, now=now, provider_health=health
    )
    # The 20h-ago cohort predates last_success and survives; the 6h-ago cohort is inside.
    assert out["current"]["decided"] == n
    assert out["current"]["auto_closed"] == n
    assert out["current"]["excluded_outage"] == n
    assert out["current"]["excluded_outage_by_subsystem"] == {"llm_provider": n}
    assert out["current"]["rate"] == 1.0
    assert out["outage"]["evidence_available"] is True
    assert out["outage"]["excluded_current"] == n

    # Without the health record NOTHING is excluded and the rate is diluted — and the
    # response says the evidence was absent rather than claiming there was no outage.
    blind = recorded_auto_close_health(healthy + during, window_hours=24,
                                       policy=_FP_ON, now=now)
    assert blind["current"]["decided"] == 2 * n
    assert blind["current"]["excluded_outage"] == 0
    assert blind["outage"]["evidence_available"] is False
    assert blind["outage"]["windows"] == []


def test_a_window_with_only_outage_decisions_says_so_instead_of_reporting_collapse() -> None:
    """The failure mode the exclusion prevents: reporting "auto-close collapsed" when
    what actually happened is that the model provider was down."""
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    baseline = [_decided_case(f"b{i}", now=now, hours_ago=30) for i in range(n)]
    during = [
        _decided_case(f"o{i}", now=now, hours_ago=5, status=CaseStatus.NEEDS_HUMAN,
                      decision_by=DecisionBy.SYSTEM)
        for i in range(n)
    ]
    health = _provider_health(
        last_success=now - timedelta(hours=12), last_failure=now - timedelta(minutes=30)
    )
    out = recorded_auto_close_health(
        baseline + during, window_hours=24, policy=_FP_ON, now=now, provider_health=health
    )
    assert out["status"] == "outage_excluded"
    assert out["collapsed"] is False
    assert out["current"]["available"] is False
    assert out["current"]["rate"] == "—"
    assert "dependency" in out["current"]["reason"]


def test_a_collapsed_rag_projection_is_reported_as_stale_never_as_an_outage() -> None:
    """A collapse refusal PRESERVES the corpus, so it can never delete a decision.

    ``_guard_projection_collapse`` raises BEFORE anything is written and retrieval keeps
    serving the previous projection, so the refusal is positive evidence that the
    knowledge corpus kept working. Bracketing it backwards to ``healthy_at`` — the last
    successful PROJECTION, which on a long-lived process is the last restart — turned a
    corpus-preserving event into a multi-hundred-hour exclusion whose LENGTH was a
    function of the deployment's projection cadence. It is context now, not a window."""
    now = _base_now()
    collapsed = {
        "healthy_at": (now - timedelta(days=30)).isoformat(),
        "last_refusal": {"reason": "outgoing corpus collapsed", "collapsed": True,
                         "outgoing_total": 0, "at": (now - timedelta(hours=1)).isoformat()},
    }
    transient = {
        "healthy_at": (now - timedelta(days=30)).isoformat(),
        "last_refusal": {"reason": "one source timed out", "collapsed": False,
                         "outgoing_total": 1800, "at": (now - timedelta(hours=1)).isoformat()},
    }
    assert derive_outage_windows(rag_health=collapsed) == []
    assert derive_outage_windows(rag_health=transient) == []

    stale = derive_dependency_context(rag_health=collapsed)
    assert stale["corpus_stale_since"] == (now - timedelta(hours=1)).isoformat()
    assert "preserved the existing corpus" in stale["corpus_stale_detail"]
    assert derive_dependency_context(rag_health=transient)["corpus_stale_since"] == ""

    # And the rate itself is untouched: a healthy 1.0 stays 1.0.
    n = AUTO_CLOSE_MIN_DECIDED
    cases = [_decided_case(f"c{i}", now=now, hours_ago=2 + i * 0.1) for i in range(n)]
    out = recorded_auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now,
                                     rag_health=collapsed)
    assert out["current"]["decided"] == n
    assert out["current"]["rate"] == 1.0
    assert out["current"]["excluded_outage"] == 0
    assert out["status"] != "outage_excluded"
    assert out["outage"]["applied_windows"] == []
    assert out["outage"]["context"]["corpus_stale_since"]


def test_a_failing_embedding_channel_never_deletes_the_auto_close_denominator() -> None:
    """The embedding channel fails SOFT — the gateway records it and continues on local
    hash embeddings — so completions, verdicts and ``decide()`` all still run. Excluding
    those decisions replaced a real, healthy rate with an unmeasurable dash, and (worse)
    masked a genuine collapse behind an unrelated revoked embedding key."""
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    health = {
        "state": "unauthenticated",
        "degraded": True,
        "threshold": 3,
        "providers": {
            "acme:completion": {
                "provider": "acme", "channel": "completion", "state": "ok",
                "consecutive_failures": 0, "last_failure_class": "",
                "last_success_at": (now - timedelta(minutes=2)).isoformat(),
                "last_failure_at": "",
            },
            "acme:embedding": {
                "provider": "acme", "channel": "embedding", "state": "unauthenticated",
                "consecutive_failures": 9, "last_failure_class": "unauthenticated",
                "last_success_at": "",
                "last_failure_at": (now - timedelta(minutes=30)).isoformat(),
            },
        },
    }
    assert derive_outage_windows(provider_health=health) == []
    degraded = derive_dependency_context(provider_health=health)["degraded_channels"]
    assert [row["key"] for row in degraded] == ["acme:embedding"]
    assert "no decision is excluded" in degraded[0]["detail"]

    # A HEALTHY window stays healthy...
    healthy = [_decided_case(f"h{i}", now=now, hours_ago=2 + i * 0.1) for i in range(n)]
    out = recorded_auto_close_health(healthy, window_hours=24, policy=_FP_ON, now=now,
                                     provider_health=health)
    assert out["current"]["decided"] == n
    assert out["current"]["rate"] == 1.0
    assert out["outage"]["excluded_current"] == 0

    # ...and a genuine COLLAPSE is still reported as one, not hidden behind the
    # embedding key. This is the incident the exclusion was supposed to prevent.
    baseline = [_decided_case(f"b{i}", now=now, hours_ago=30 + i * 0.1) for i in range(n)]
    during = [
        _decided_case(f"c{i}", now=now, hours_ago=5 + i * 0.1,
                      status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM)
        for i in range(n)
    ]
    collapsed = recorded_auto_close_health(
        baseline + during, window_hours=24, policy=_FP_ON, now=now, provider_health=health
    )
    assert collapsed["status"] == "collapsed"
    assert collapsed["needs_attention"] is True
    assert collapsed["current"]["rate"] == 0.0


def test_a_channelless_provider_row_is_read_as_completion() -> None:
    """Rows written before the channel split carry no ``channel``. ``ProviderHealth``
    defaults it to completion on both write paths, so reading it back as anything else
    would silently stop excluding a real provider outage."""
    now = _base_now()
    legacy = {
        "providers": {
            "acme": {
                "provider": "acme", "state": "unavailable",
                "last_success_at": (now - timedelta(hours=6)).isoformat(),
                "last_failure_at": (now - timedelta(minutes=5)).isoformat(),
            }
        }
    }
    assert [w.subsystem for w in derive_outage_windows(provider_health=legacy)] == [
        "llm_provider"
    ]


def test_no_recorded_call_reports_no_evidence_never_no_outage() -> None:
    """``evidence_available`` is about OBSERVATIONS, not about whether an object was
    handed in. ``AppState`` always builds the tracker and ``snapshot()`` always answers,
    so keying off the object made the flag invariantly true — including on a deployment
    that has never made a single model call."""
    now = _base_now()
    cases = [_decided_case(f"c{i}", now=now, hours_ago=2) for i in range(AUTO_CLOSE_MIN_DECIDED)]
    fresh = {"state": "ok", "degraded": False, "threshold": 3, "providers": {}}
    out = recorded_auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now,
                                     provider_health=fresh)
    assert out["outage"]["evidence_available"] is False
    assert out["outage"]["windows"] == []

    observed = {
        "state": "unavailable", "degraded": True, "threshold": 3,
        "providers": {
            "acme:completion": {
                "provider": "acme", "channel": "completion", "state": "unavailable",
                "last_success_at": (now - timedelta(hours=3)).isoformat(),
                "last_failure_at": (now - timedelta(minutes=1)).isoformat(),
            }
        },
    }
    seen = recorded_auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now,
                                      provider_health=observed)
    assert seen["outage"]["evidence_available"] is True


def test_outage_derivation_is_relative_and_never_calendar_pinned() -> None:
    """SHIFT-INVARIANCE, the property a hardcoded date cannot have.

    Every input instant is moved by an arbitrary offset; every derived bound must move
    by exactly the same offset, and the classification of every case must be identical.
    A date literal compiled into the module would break this — which is precisely how
    such a filter comes to be correct in one deployment and wrong in every other."""
    def _run(base: datetime) -> tuple[dict, list[tuple[float, str]]]:
        n = AUTO_CLOSE_MIN_DECIDED
        cases = (
            [_decided_case(f"a{i}", now=base, hours_ago=20) for i in range(n)]
            + [_decided_case(f"b{i}", now=base, hours_ago=6) for i in range(n)]
        )
        health = _provider_health(
            last_success=base - timedelta(hours=10), last_failure=base - timedelta(hours=1)
        )
        out = recorded_auto_close_health(
            cases, window_hours=24, policy=_FP_ON, now=base, provider_health=health
        )
        offsets = [
            (
                round(
                    (base - datetime.fromisoformat(str(w["end"]))).total_seconds() / 3600.0, 6
                ),
                str(w["subsystem"]),
            )
            for w in out["outage"]["windows"]
        ]
        return out, offsets

    a, offsets_a = _run(_base_now())
    b, offsets_b = _run(_base_now() - timedelta(days=911, hours=7))
    assert offsets_a == offsets_b
    for block in ("current", "baseline", "lifetime"):
        assert a[block] == b[block], block
    assert a["status"] == b["status"]


# --------------------------------------------------------------------------- #
# (d)+(e) The gate: recorded inputs, closable class, what blocked the bar
# --------------------------------------------------------------------------- #
def test_closable_class_comes_from_entry_for_not_from_the_config_schema() -> None:
    """``AutoClosePolicy.needs_human`` is a REAL, settable field — and
    ``case_manager._entry_for`` ignores it unconditionally. Classifying from the schema
    would report a closable class that code can never close."""
    policy = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=True, min_confidence=0.5, max_risk_score=90.0),
        needs_human=VerdictAutoClose(enabled=True, min_confidence=0.0, max_risk_score=100.0),
    )
    assert classify_auto_close_gate(policy, Verdict.NEEDS_HUMAN, 1.0, 0.0) == GATE_NOT_CLOSABLE
    assert classify_auto_close_gate(policy, None, 1.0, 0.0) == GATE_NOT_CLOSABLE
    assert classify_auto_close_gate(policy, Verdict.FALSE_POSITIVE, 0.9, 10.0) == GATE_CLEARED


@pytest.mark.parametrize(
    ("confidence", "risk", "expected"),
    [
        (0.90, 10.0, GATE_CLEARED),
        (0.10, 10.0, GATE_BLOCKED_CONFIDENCE),
        (0.90, 99.0, GATE_BLOCKED_RISK),
        (0.10, 99.0, GATE_BLOCKED_CONFIDENCE_AND_RISK),
    ],
)
def test_gate_label_mirrors_decide_exactly(confidence, risk, expected) -> None:
    """The label and the decision must never disagree, so the label is derived from the
    SAME predicate ``decide()`` applies."""
    from app.engine.case_manager import decide

    assert classify_auto_close_gate(_FP_ON, Verdict.FALSE_POSITIVE, confidence, risk) == expected
    closed = decide(Verdict.FALSE_POSITIVE, confidence, risk, _FP_ON).status == CaseStatus.CLOSED
    assert closed is (expected == GATE_CLEARED)


def test_a_disabled_class_is_reported_as_disabled_not_as_a_missed_bar() -> None:
    off = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=False),
        true_positive=VerdictAutoClose(enabled=False),
    )
    assert classify_auto_close_gate(off, Verdict.FALSE_POSITIVE, 1.0, 0.0) == GATE_CLASS_DISABLED
    assert classify_auto_close_gate(None, Verdict.FALSE_POSITIVE, 1.0, 0.0) == GATE_UNRECORDED


def test_audit_rows_are_paired_with_the_verdict_that_produced_them() -> None:
    """A case can carry MORE THAN ONE decision and the verdict can CHANGE between them,
    so a flat ``max(confidence) GROUP BY case_id`` would splice one run's confidence onto
    another run's verdict. Grouping and anchoring keeps each fact with its own decision."""
    now = _base_now()
    rows = [
        # Newest first, as the store returns them.
        _audit_row("c1", at=now - timedelta(hours=1), verdict="TRUE_POSITIVE",
                   status="needs_human", decision_by="system", risk=95.0,
                   confidence=0.99, gate=GATE_BLOCKED_RISK),
        _audit_row("c1", at=now - timedelta(hours=30), verdict="FALSE_POSITIVE",
                   status="closed", decision_by="agent", risk=5.0,
                   confidence=0.90, gate=GATE_CLEARED),
    ]
    first = anchored_decision_audit(rows)["c1"]
    assert (first["verdict"], first["confidence"], first["gate"]) == (
        "FALSE_POSITIVE", 0.90, GATE_CLEARED
    )
    assert first["decisions_observed"] == 2
    last = anchored_decision_audit(rows, anchor=DECISION_ANCHOR_LAST)["c1"]
    assert (last["verdict"], last["confidence"], last["gate"]) == (
        "TRUE_POSITIVE", 0.99, GATE_BLOCKED_RISK
    )
    # The highest confidence on record (0.99) belongs to the TRUE_POSITIVE run only.
    assert first["confidence"] != max(r["confidence"] for r in
                                      [parse_decision_audit_row(x) for x in rows])


def test_a_legacy_audit_row_reads_back_as_unrecorded_never_as_cleared() -> None:
    """Rows written before the gate tokens existed lack them. That absence is reported,
    not guessed at — which is the entire point of an evidence-quality signal."""
    now = _base_now()
    legacy = {
        "actor": "case_manager", "case_id": "c-old", "action_type": "decision",
        "ts": now.isoformat(),
        "result_summary": ("verdict=FALSE_POSITIVE status=closed decision_by=agent "
                           "risk=5.0 cost=0.0"),
    }
    parsed = parse_decision_audit_row(legacy)
    assert parsed["gate"] == GATE_UNRECORDED and parsed["confidence"] is None
    assert parsed["verdict"] == "FALSE_POSITIVE" and parsed["risk"] == 5.0


def test_a_gate_from_a_DIFFERENT_run_is_never_pasted_onto_the_anchored_decision() -> None:
    """The two anchors come from different populations: the history anchor walks the
    case's own UNBOUNDED trail, while the audit anchor is the first row of a BOUNDED
    page (the route reads ``window_hours * 2 + 1`` back). On an ordinary reopen +
    re-investigation whose FIRST decision predates that page, a case-id-only join
    labelled a 40-day-old AGENT AUTO-CLOSE with the later run's ``blocked_*`` gate — a
    logically impossible pair — and then reported ``gate_coverage: 1.0`` over it."""
    now = _base_now()
    first_at = now - timedelta(days=40)
    second_at = now - timedelta(hours=2)
    case = _case("c-old", now=first_at, status=CaseStatus.CLOSED,
                 decision_by=DecisionBy.AGENT)
    _decide(case, at=first_at, status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT)
    _decide(case, at=second_at, status=CaseStatus.NEEDS_HUMAN,
            decision_by=DecisionBy.SYSTEM)
    # Only the RECENT row survives the bounded audit read.
    page = [_audit_row("c-old", at=second_at, verdict="TRUE_POSITIVE",
                       status="needs_human", decision_by="system", risk=95.0,
                       confidence=0.4, gate=GATE_BLOCKED_CONFIDENCE_AND_RISK)]

    out = recorded_auto_close_health([case], window_hours=24, policy=_FP_ON, now=now,
                                     decision_audit_rows=page)
    life = out["lifetime"]
    assert life["decided"] == 1 and life["auto_closed"] == 1
    # Unrecorded, NOT the other run's gate — and the coverage number says so.
    assert life["gate"][GATE_UNRECORDED] == 1
    assert life["gate"][GATE_BLOCKED_CONFIDENCE_AND_RISK] == 0
    assert life["gate_explained"] == 0
    assert life["gate_coverage"] == 0.0

    # With the anchoring row present, the SAME code pairs it and explains the decision.
    full = page + [_audit_row("c-old", at=first_at, verdict="FALSE_POSITIVE",
                              status="closed", decision_by="agent", risk=5.0,
                              confidence=0.95, gate=GATE_CLEARED)]
    paired = recorded_auto_close_health([case], window_hours=24, policy=_FP_ON, now=now,
                                        decision_audit_rows=full)["lifetime"]
    assert paired["gate"][GATE_CLEARED] == 1
    assert paired["gate_coverage"] == 1.0


def test_the_audit_write_gap_still_counts_as_the_same_decision() -> None:
    """``apply()`` stamps the history entry and the pipeline writes the audit row right
    after the case is saved, so the two instants differ by one document's persistence
    latency. That gap must not degrade coverage."""
    now = _base_now()
    at = now - timedelta(hours=2)
    case = _decided_case("c-gap", now=now, hours_ago=2)
    row = _audit_row("c-gap", at=at + timedelta(seconds=3), verdict="FALSE_POSITIVE",
                     status="closed", decision_by="agent", risk=5.0, confidence=0.95,
                     gate=GATE_CLEARED)
    life = recorded_auto_close_health([case], window_hours=24, policy=_FP_ON, now=now,
                                      decision_audit_rows=[row])["lifetime"]
    assert life["gate"][GATE_CLEARED] == 1
    assert life["gate_coverage"] == 1.0


def test_an_analyst_policy_close_is_NAMED_not_pooled_with_cases_decide_never_reached() -> None:
    """``pipeline._close_by_analyst_policy`` never calls ``decide()``: it persists
    ``verdict=None, status=CLOSED, decision_by=ANALYST_POLICY`` and a non-decision
    history entry. Such a case therefore has no decision record, and testing
    ``is_policy_closed`` only AFTER the record guard made ``policy_closed`` structurally
    dead while the deliberate $0 close was reported as "decide() never ran"."""
    now = _base_now()
    policy_case = _case("c-policy", now=now - timedelta(hours=2), verdict=None,
                        status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST_POLICY)
    policy_case.confidence = 0.0
    policy_case.analyst_policy = {"rule_identity": "declared-benign", "matched": True}
    policy_case.history.append({
        "ts": (now - timedelta(hours=2)).isoformat(),
        "event": "analyst_policy",
        "action": "close_false_positive",
    })
    human = _case("c-human", now=now - timedelta(hours=2), verdict=Verdict.NEEDS_HUMAN,
                  status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM)

    out = recorded_auto_close_health([policy_case, human], window_hours=24,
                                     policy=_FP_ON, now=now)
    life = out["lifetime"]
    assert life["policy_closed"] == 1
    assert life["policy_closed_no_decision_record"] == 1
    # The genuine fail-to-human is still named as one, and the two are not pooled.
    assert life["no_decision_record"] == 1
    # Neither is evidence about auto-close, so neither pads the denominator (#3-safe).
    assert life["decided"] == 0
    # It has no decision instant, so it is set-wide and repeats — never invented into
    # a window from ``created_at``.
    assert out["current"]["policy_closed"] == 1
    assert out["gate_series"]["buckets"] and all(
        bucket["policy_closed"] == 0 for bucket in out["gate_series"]["buckets"]
    )


def test_the_gate_breakdown_extends_the_tally_and_is_labelled_evidence_quality() -> None:
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    cases, rows = [], []
    for i in range(n):
        at = now - timedelta(hours=2)
        cases.append(_decided_case(f"g{i}", now=now, hours_ago=2))
        rows.append(_audit_row(f"g{i}", at=at, verdict="FALSE_POSITIVE", status="closed",
                               decision_by="agent", risk=5.0, confidence=0.95,
                               gate=GATE_CLEARED))
    blocked = _decided_case("blocked", now=now, hours_ago=2,
                            status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM)
    cases.append(blocked)
    rows.append(_audit_row("blocked", at=now - timedelta(hours=2), verdict="FALSE_POSITIVE",
                           status="needs_human", decision_by="system", risk=5.0,
                           confidence=0.10, gate=GATE_BLOCKED_CONFIDENCE))
    # One case with no audit row at all.
    cases.append(_decided_case("dark", now=now, hours_ago=2,
                               status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM))

    out = recorded_auto_close_health(cases, window_hours=24, policy=_FP_ON, now=now,
                                     decision_audit_rows=rows)
    current = out["current"]
    assert current["decided"] == n + 2
    assert current["gate"][GATE_CLEARED] == n
    assert current["gate"][GATE_BLOCKED_CONFIDENCE] == 1
    assert current["gate"][GATE_UNRECORDED] == 1
    assert current["closable_class"] == n + 1
    assert current["gate_explained"] == n + 1
    assert current["gate_coverage"] == round((n + 1) / (n + 2), 4)

    series = out["gate_series"]
    assert series["signal"] == "evidence_quality"
    assert series["tuning_target"] is False
    assert "never a threshold-tuning target" in series["disclaimer"]
    assert sum(b["decided"] for b in series["buckets"]) == n + 2
    assert sum(b["gate"][GATE_CLEARED] for b in series["buckets"]) == n
    # It is a TIME SERIES over the reported window, zero-filled.
    assert len(series["buckets"]) >= 24
    assert all(b["t"] for b in series["buckets"])


def test_the_response_names_the_legacy_series_and_its_discontinuity() -> None:
    out = recorded_auto_close_health([], window_hours=24, policy=_FP_ON, now=_base_now())
    assert out["legacy_series"]["name"] == "auto_close_health"
    assert "expected to differ" in out["legacy_series"]["note"]
    assert out["source"] == "append_only_decision_trail"
    assert out["anchor"] == DECISION_ANCHOR_FIRST


# --------------------------------------------------------------------------- #
# (b) The legacy series is byte-for-byte unchanged
# --------------------------------------------------------------------------- #
# A frozen fixture + its EXACT legacy output, captured from the pre-change module.
# If a future edit moves `auto_close_health` by a single byte this fails, which is the
# whole guarantee: the corrected metric ships BESIDE the shipped one, never over it.
_LEGACY_NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)


def _legacy_fixture() -> list[Case]:
    cases: list[Case] = []
    for i in range(12):
        cases.append(_decided_case(f"L-base-{i}", now=_LEGACY_NOW, hours_ago=36))
    for i in range(3):
        cases.append(_decided_case(f"L-base-h{i}", now=_LEGACY_NOW, hours_ago=36,
                                   status=CaseStatus.NEEDS_HUMAN,
                                   decision_by=DecisionBy.SYSTEM))
    for i in range(11):
        cases.append(_decided_case(f"L-now-{i}", now=_LEGACY_NOW, hours_ago=5,
                                   status=CaseStatus.NEEDS_HUMAN,
                                   decision_by=DecisionBy.SYSTEM))
    for i in range(4):
        cases.append(_decided_case(f"L-now-a{i}", now=_LEGACY_NOW, hours_ago=5))
    return cases


_LEGACY_SNAPSHOT = (
    "{\"baseline\": {\"analyst_decided\": 0, \"auto_closed\": 12, \"available\": true, \"decided\": 15,"
    " \"policy_closed\": 0, \"rate\": 0.8, \"reason\": \"\", \"routed_to_human\": 3}, \"collapsed\": "
    "false, \"comparable\": true, \"current\": {\"analyst_decided\": 0, \"auto_closed\": 4, "
    "\"available\": true, \"decided\": 15, \"policy_closed\": 0, \"rate\": 0.2667, \"reason\": \"\", "
    "\"routed_to_human\": 11}, \"fetched\": 30, \"generated_at\": \"2026-08-06T12:00:00+00:00\", "
    "\"lifetime\": {\"analyst_decided\": 0, \"auto_closed\": 16, \"available\": true, \"decided\": 30, "
    "\"policy_closed\": 0, \"rate\": 0.5333, \"reason\": \"\", \"routed_to_human\": 14}, "
    "\"needs_attention\": true, \"policy\": {\"any_enabled\": true, \"available\": true, "
    "\"false_positive_enabled\": true, \"reason\": \"\", \"true_positive_enabled\": false}, \"reason\":"
    " \"the auto-close rate dropped from 0.8 to 0.2667 while decided volume held steady\", "
    "\"status\": \"degraded\", \"store_total\": 30, \"thresholds\": {\"baseline_min_rate\": 0.05, "
    "\"degraded_drop_fraction\": 0.5, \"min_decided\": 10, \"near_zero_rate\": 0.02, "
    "\"steady_volume_fraction\": 0.5}, \"truncated\": false, \"volume_steady\": true, "
    "\"window_hours\": 24}"
)


def test_the_legacy_auto_close_series_is_byte_for_byte_unchanged() -> None:
    out = auto_close_health(
        _legacy_fixture(), window_hours=24, policy=_FP_ON, now=_LEGACY_NOW, store_total=30
    )
    assert json.dumps(out, sort_keys=True, default=str) == _LEGACY_SNAPSHOT


def test_the_legacy_series_gained_no_new_keys() -> None:
    """Additive-only applies to the NEW series. The legacy one gains nothing at all —
    a new key there would still change what an existing consumer sees."""
    legacy = auto_close_health([], window_hours=24, policy=_FP_ON, now=_LEGACY_NOW)
    assert set(legacy) == {
        "window_hours", "generated_at", "current", "baseline", "lifetime", "policy",
        "status", "reason", "collapsed", "volume_steady", "comparable",
        "needs_attention", "thresholds", "truncated", "store_total", "fetched",
    }
    assert set(legacy["current"]) == {
        "decided", "auto_closed", "routed_to_human", "analyst_decided", "policy_closed",
        "rate", "available", "reason",
    }


# --------------------------------------------------------------------------- #
# (d) §14 G3 — the DECISION audit row records the gate INPUTS, appended at the END
# --------------------------------------------------------------------------- #
def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": 'source.ip : "1.2.3.4"',
        },
    })


def _cluster(ip: str = "1.2.3.4", n: int = 3):
    from app.engine.correlation import cluster_from_events
    from tests.conftest import make_raw_event

    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


async def _decision_row(app_state, mock_provider, *, verdict: str, confidence: float) -> dict:
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", _final_verdict(verdict, confidence))
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.INVESTIGATE, app_state.prefs
    )
    rows = await app_state.audit.records_for_case(case.case_id, limit=200)
    decision = [
        r for r in rows
        if str(r.get("actor")) == "case_manager" and str(r.get("action_type")) == "decision"
    ]
    assert len(decision) == 1, decision
    return {"case": case, "row": decision[0]}


async def test_the_decision_audit_row_appends_confidence_and_the_gate_at_the_end(
    app_state, mock_provider
) -> None:
    """§14 G3: the row recorded verdict/status/decision_by/risk/cost but NOT confidence,
    so a missed close bar could not be explained from the append-only trail at all.

    APPEND-ONLY: the existing tokens keep their exact spelling AND their exact order —
    ``result_summary`` is an audit history string and older readers index into it — and
    the two new facts are appended strictly after them."""
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.90
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    out = await _decision_row(app_state, mock_provider,
                              verdict="FALSE_POSITIVE", confidence=0.40)
    case, summary = out["case"], str(out["row"]["result_summary"])
    tokens = [t.split("=", 1)[0] for t in summary.split()]

    # The pre-existing prefix, in its original order, byte-for-byte.
    assert tokens[:5] == ["verdict", "status", "decision_by", "risk", "cost"]
    assert summary.startswith(
        f"verdict=FALSE_POSITIVE status={case.status.value} "
        f"decision_by={case.decision_by.value} risk={case.risk_score} "
    )
    # The new facts, appended at the END.
    assert tokens[5:] == ["confidence", "auto_close_gate"]

    parsed = parse_decision_audit_row(out["row"])
    assert parsed["confidence"] == pytest.approx(0.40)
    # 0.40 < min_confidence 0.90, risk is inside the ceiling → the bar was missed on
    # CONFIDENCE, and the trail now says so.
    assert parsed["gate"] == GATE_BLOCKED_CONFIDENCE
    assert case.status != CaseStatus.CLOSED


async def test_a_cleared_gate_is_recorded_on_an_actual_auto_close(
    app_state, mock_provider
) -> None:
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.5
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    out = await _decision_row(app_state, mock_provider,
                              verdict="FALSE_POSITIVE", confidence=0.97)
    assert out["case"].status == CaseStatus.CLOSED
    assert out["case"].decision_by == DecisionBy.AGENT
    parsed = parse_decision_audit_row(out["row"])
    assert parsed["gate"] == GATE_CLEARED
    assert parsed["confidence"] == pytest.approx(0.97)

    # End to end: the rollup reads the real trail and explains the real decision.
    health = recorded_auto_close_health(
        [out["case"]], window_hours=24, policy=p.auto_close,
        decision_audit_rows=[out["row"]],
    )
    assert health["lifetime"]["decided"] == 1
    assert health["lifetime"]["auto_closed"] == 1
    assert health["lifetime"]["gate"][GATE_CLEARED] == 1
    assert health["lifetime"]["gate_coverage"] == 1.0


async def test_a_true_positive_routed_to_a_human_records_the_disabled_class(
    app_state, mock_provider
) -> None:
    """TP auto-close is OFF by default, so a confident TP is not a MISSED BAR — it is a
    class that was never a candidate. The trail distinguishes the two."""
    out = await _decision_row(app_state, mock_provider,
                              verdict="TRUE_POSITIVE", confidence=0.99)
    parsed = parse_decision_audit_row(out["row"])
    assert parsed["gate"] == GATE_CLASS_DISABLED
    assert out["case"].status != CaseStatus.CLOSED


# --------------------------------------------------------------------------- #
# The endpoint — shipped BESIDE the legacy one, behind the same grant
# --------------------------------------------------------------------------- #
def _client(*, auth: bool = False):
    from contextlib import asynccontextmanager

    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes import router as monolith_router
    from app.api.routes_metrics import router as metrics_router
    from app.config import Preferences, Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    kwargs = dict(_env_file=None, es_store_enabled=False, redis_url="",
                  anthropic_api_key=None, openai_api_key=None)
    if auth:
        kwargs.update(auth_enabled=True, auth_jwt_secret="recorded-autoclose-secret",
                      auth_seed_admin=True)
    secrets = Secrets(**kwargs)
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock,
                                                    "mock": mock})
        await state.startup(start_poller=False)
        prefs: Preferences = state.prefs.model_copy(update={"setup_complete": True})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if auth else []
    api.include_router(monolith_router, dependencies=deps)
    api.include_router(metrics_router, dependencies=deps)
    return TestClient(api)


def test_the_recorded_endpoint_ships_beside_the_legacy_one() -> None:
    with _client() as client:
        legacy = client.get("/api/metrics/auto-close-health?window_hours=24")
        recorded = client.get("/api/metrics/auto-close-health/recorded?window_hours=24")
        assert legacy.status_code == 200, legacy.text
        assert recorded.status_code == 200, recorded.text

        body = recorded.json()
        assert body["source"] == "append_only_decision_trail"
        assert body["anchor"] == DECISION_ANCHOR_FIRST
        assert body["gate_series"]["signal"] == "evidence_quality"
        assert body["gate_series"]["tuning_target"] is False
        # The bounded audit read states its own reach, so a low ``gate_coverage`` is
        # legible as "the trail older than this was not read".
        assert body["gate_series"]["audit_span_hours"] == 24 * 2 + 1
        assert body["legacy_series"]["name"] == "auto_close_health"
        # A deployment with no health OBSERVATION reports NO EVIDENCE, never "no
        # outage". This client has made no model call, and ``AppState`` always builds
        # the provider tracker, so the flag must be keyed off the recorded rows.
        assert body["outage"]["evidence_available"] is False
        assert body["outage"]["windows"] == []
        assert body["outage"]["context"]["degraded_channels"] == []
        assert body["outage"]["context"]["corpus_stale_since"] == ""
        # The legacy payload gained nothing.
        assert "gate_series" not in legacy.json()
        assert "outage" not in legacy.json()

        # The anchor is selectable and validated.
        assert client.get(
            "/api/metrics/auto-close-health/recorded?anchor=last"
        ).json()["anchor"] == DECISION_ANCHOR_LAST
        assert client.get(
            "/api/metrics/auto-close-health/recorded?anchor=sideways"
        ).status_code == 422


def test_the_recorded_endpoint_requires_the_same_metrics_grant() -> None:
    with _client(auth=True) as client:
        assert client.get("/api/metrics/auto-close-health/recorded").status_code == 401
        login = client.post("/api/auth/login",
                            json={"username": "Admin", "password": "Admin@123"})
        assert login.status_code == 200, login.text
        assert client.get("/api/metrics/auto-close-health/recorded").status_code == 200


def test_an_outage_with_no_known_start_is_clamped_not_extrapolated() -> None:
    """The provider tracker is IN-PROCESS: a restart mid-outage leaves a crossed
    threshold with no recorded success at all. Applying that window unbounded would
    delete every historical decision on the strength of evidence about the present —
    the same class of error as a calendar-pinned filter. It is clamped to the reported
    span instead, and both the derived and the applied window are published."""
    now = _base_now()
    n = AUTO_CLOSE_MIN_DECIDED
    ancient = [_decided_case(f"old{i}", now=now, hours_ago=200) for i in range(n)]
    recent = [
        _decided_case(f"new{i}", now=now, hours_ago=3, status=CaseStatus.NEEDS_HUMAN,
                      decision_by=DecisionBy.SYSTEM)
        for i in range(n)
    ]
    health = _provider_health(last_success=None, last_failure=now - timedelta(minutes=10))
    derived = derive_outage_windows(provider_health=health)
    assert derived[0].start_known is False

    out = recorded_auto_close_health(
        ancient + recent, window_hours=24, policy=_FP_ON, now=now, provider_health=health
    )
    # The current window is excluded...
    assert out["current"]["decided"] == 0
    assert out["current"]["excluded_outage"] == n
    # ...but the 200h-old cohort, far outside the reported span, is NOT deleted.
    assert out["lifetime"]["decided"] == n
    assert out["lifetime"]["auto_closed"] == n
    assert out["outage"]["windows"][0]["start_known"] is False
    assert out["outage"]["windows"][0]["start"] is None
    assert out["outage"]["applied_windows"][0]["start"] is not None
    assert "clamped" in out["outage"]["applied_windows"][0]["detail"]


async def test_the_route_helper_reads_the_real_audit_trail_end_to_end(
    app_state, mock_provider
) -> None:
    """Store round-trip: the route's bounded audit read really does return the
    ``case_manager`` DECISION row, and the rollup really does explain the real
    decision from it. ``actor`` is filtered in the parser, not in the store query."""
    from app.api.routes_metrics import _load_decision_audit

    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.5
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    out = await _decision_row(app_state, mock_provider,
                              verdict="FALSE_POSITIVE", confidence=0.97)
    rows = await _load_decision_audit(app_state, window_hours=24)
    parsed = [parse_decision_audit_row(r) for r in rows]
    kept = [x for x in parsed if x is not None]
    # Non-``case_manager`` DECISION rows (the router's, for one) are read and dropped.
    assert len(rows) > len(kept) >= 1
    assert {x["case_id"] for x in kept} == {out["case"].case_id}

    health = recorded_auto_close_health(
        [out["case"]], window_hours=24, policy=p.auto_close, decision_audit_rows=rows,
    )
    assert health["lifetime"]["gate"][GATE_CLEARED] == 1
    assert health["lifetime"]["gate_coverage"] == 1.0
    assert health["gate_series"]["audit_rows_seen"] == 1
