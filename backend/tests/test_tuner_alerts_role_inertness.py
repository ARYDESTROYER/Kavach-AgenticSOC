"""The tuner never drafts a ``correlation_n`` raise that the pipeline would discard.

``engine/correlation.correlate()`` deliberately overrides per-rule correlation to
``mode=EVERY, n=1`` for any group carrying an alerts-role event, so that every SIEM
alert becomes exactly one case. That override is intentional and is NOT changed here.

The defect this file pins: the tuner did not know about the override. On an
alerts-only deployment it drafted (and, with automatic apply enabled, wrote + audited
as "auto-applied ... reversible") a ``correlation_n`` 1->2 raise for every noisy rule.
The pipeline discarded each raise on the very next poll, the FP rate never moved, and
the same rules were re-drafted forever.

Covered here:
  * A rule whose cases ALL record the alerts-role override (effective ``mode=every``)
    gets NO ``correlation_n`` proposal, no ledger row, no config write, and no
    "auto-applied ... reversible" audit.
  * The same rule is RE-TARGETED to a feed ``severity_floor`` raise when one exists
    (a knob the ingest path honours for alerts feeds), carrying the structural reason.
  * With no bounded alternative it is reported as untunable-by-n: on the outcome, in
    the TUNING audit trail, and as a review-ONLY Approvals finding that can never
    mutate a threshold.
  * A normal events-role rule is COMPLETELY UNAFFECTED (the main regression risk).
  * Mixed evidence, minority evidence, and zero observed cases never trigger the skip.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from app.config import (
    CorrelationRule,
    Preferences,
    RuleDefinition,
    RuleMatch,
    SourceInstance,
    ThresholdTuningConfig,
)
from app.constants import (
    ActionType,
    CorrelationMode,
    EntityType,
    IngestMode,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import threshold_tuner as tuner
from app.engine.threshold_tuner import (
    INERT_ALERTS_ROLE_OVERRIDE,
    INERT_CONFIGURED_MODE_EVERY,
    INERT_INLINE_RULE_CORRELATION,
    RuleStat,
    correlation_n_inert_reason,
    derive_proposals,
    inert_correlation_skips,
    materialize_approved_tuning,
    run_once,
)
from app.models import Case, Entity, FeedbackEntry, TriggerReason
from app.state import AppState
from app.stores.tuning import TuningStore
from app.utils import now_utc


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class FakeAudit:
    """Records ``record(...)`` kwargs so a test can assert on the TUNING trail."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def record(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)

    def summaries(self, action_type: ActionType) -> list[str]:
        return [
            str(call.get("result_summary") or "")
            for call in self.calls
            if call.get("action_type") == action_type
        ]


def _case(
    *,
    case_id: str,
    rule: str,
    mode: str = "threshold",
    n: int = 5,
    primary_rule: str | None = None,
    rule_ids: list[str] | None = None,
    tp: bool = False,
    trigger: bool = True,
    observed_count: int = 6,
    severity_max: float | None = 5.0,
    days_ago: int = 1,
) -> Case:
    """A CLOSED, analyst-graded case whose ``trigger_reason`` records the EFFECTIVE
    correlation mode/n that actually fired (what ``correlate()`` writes into the
    cluster meta and the poller copies onto the case)."""
    ids = rule_ids if rule_ids is not None else [rule]
    reason = (
        TriggerReason(
            rule_value=(primary_rule if primary_rule is not None else rule),
            mode=mode,
            n=n,
            observed_count=observed_count,
            severity_max=severity_max,
            rule_values=list(ids),
        )
        if trigger
        else None
    )
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.10"),
        rule_ids=ids,
        member_event_ids=[f"{case_id}-e{i}" for i in range(observed_count)],
        verdict=Verdict.TRUE_POSITIVE if tp else Verdict.FALSE_POSITIVE,
        confidence=0.9,
        status="closed",  # type: ignore[arg-type]
        updated_at=(now_utc() - timedelta(days=days_ago)).isoformat(),
        trigger_reason=reason,
        feedback=[
            FeedbackEntry(
                analyst="analyst",
                actual_outcome="true_positive" if tp else "false_positive",
            )
        ],
    )


def _alerts_case(case_id: str, rule: str) -> Case:
    """A case produced through the alerts-role override: effective mode EVERY, n=1."""
    return _case(case_id=case_id, rule=rule, mode="every", n=1, observed_count=1)


def _prefs(**over: Any) -> Preferences:
    cfg = ThresholdTuningConfig(
        enabled=True,
        min_samples=over.pop("min_samples", 25),
        fp_rate_target=over.pop("fp_rate_target", 0.30),
        max_n_step=over.pop("max_n_step", 1),
        shadow_eval=True,
        cadence=over.pop("cadence", "nightly"),
        auto_apply_confirmed=over.pop("auto_apply_confirmed", True),
    )
    return Preferences(threshold_tuning=cfg, **over)


def _alerts_feed_source(rule: str, *, role: str = "alerts") -> SourceInstance:
    return SourceInstance(
        id="src1",
        source_type=SourceType.ELASTICSEARCH,
        ingest_mode=IngestMode.PULL,
        config={
            "index_patterns": [
                {
                    "pattern": ".alerts-security.alerts-tlsoc",
                    "id": "feedA",
                    "role": role,
                    "severity_floor": 2,
                    "query": rule,
                }
            ]
        },
    )


def _writer_capture():
    box: dict[str, Preferences] = {}

    async def _write(prefs: Preferences) -> Preferences:
        box["prefs"] = prefs
        return prefs

    return _write, box


def _kinds(props: list[tuner.TuningProposal]) -> list[str]:
    return [p.kind for p in props]


# --------------------------------------------------------------------------- #
# The pure detector
# --------------------------------------------------------------------------- #
def test_inert_reason_requires_positive_unanimous_majority_evidence() -> None:
    prefs = _prefs()

    # Unanimous EVERY evidence covering everything observed → inert.
    inert = RuleStat(rule_id="r", observed=30, primary_cases=30, primary_mode_every=30)
    assert correlation_n_inert_reason(prefs, inert) == INERT_ALERTS_ROLE_OVERRIDE

    # No evidence at all → today's behaviour.
    assert correlation_n_inert_reason(prefs, RuleStat(rule_id="r", observed=30)) is None

    # One contrary THRESHOLD firing is enough to refuse the skip.
    mixed = RuleStat(
        rule_id="r", observed=30, primary_cases=30,
        primary_mode_every=29, primary_mode_threshold=1,
    )
    assert correlation_n_inert_reason(prefs, mixed) is None

    # The override explains a minority of what was observed → not proven.
    minority = RuleStat(rule_id="r", observed=30, primary_cases=14, primary_mode_every=14)
    assert correlation_n_inert_reason(prefs, minority) is None
    # Exactly half is the boundary and counts as proven.
    half = RuleStat(rule_id="r", observed=30, primary_cases=15, primary_mode_every=15)
    assert correlation_n_inert_reason(prefs, half) == INERT_ALERTS_ROLE_OVERRIDE

    # An empty rule id is never classified.
    assert correlation_n_inert_reason(prefs, RuleStat(rule_id=""), rule_id="") is None


def test_explicitly_configured_mode_every_is_config_side_inert() -> None:
    """A rule an operator explicitly configured as EVERY never consults ``n`` either."""
    prefs = _prefs(correlation_rules={"r": CorrelationRule(mode=CorrelationMode.EVERY, n=1)})
    st = RuleStat(rule_id="r", observed=30, primary_cases=30, primary_mode_threshold=30)
    assert correlation_n_inert_reason(prefs, st) == INERT_CONFIGURED_MODE_EVERY

    # An inline RuleDefinition override wins, exactly as it does in correlate().
    inline_every = _prefs(
        correlation_rules={"r": CorrelationRule(mode=CorrelationMode.THRESHOLD, n=5)},
        rule_catalog=[
            RuleDefinition(
                name="r",
                match=RuleMatch(field="event.code", op="equals", value="r"),
                correlation=CorrelationRule(mode=CorrelationMode.EVERY, n=1),
            )
        ],
    )
    assert correlation_n_inert_reason(inline_every, st) == INERT_CONFIGURED_MODE_EVERY
    inline_threshold = _prefs(
        correlation_rules={"r": CorrelationRule(mode=CorrelationMode.EVERY, n=1)},
        rule_catalog=[
            RuleDefinition(
                name="r",
                match=RuleMatch(field="event.code", op="equals", value="r"),
                correlation=CorrelationRule(mode=CorrelationMode.THRESHOLD, n=5),
            )
        ],
    )
    # An inline THRESHOLD correlation is ALSO inert, for a different structural reason:
    # correlation_for_def resolves rd.correlation before correlation_rules[name], and
    # apply_correlation_n only ever writes the latter — so the raise lands where the
    # pipeline never reads it. Same defect class as the alerts-role override.
    assert correlation_n_inert_reason(inline_threshold, st) == INERT_INLINE_RULE_CORRELATION


def test_inline_rule_definition_correlation_is_inert_for_any_mode() -> None:
    """apply_correlation_n writes correlation_rules; an inline correlation shadows it.

    ``Preferences.correlation_for_def`` returns ``rd.correlation`` whenever a matched
    RuleDefinition carries one, so the correlation_rules entry the writer materialises
    is unreachable configuration for that rule regardless of the inline mode.
    """
    st = RuleStat(rule_id="r", observed=40, primary_cases=40, primary_mode_threshold=40)
    for mode, n in ((CorrelationMode.THRESHOLD, 5), (CorrelationMode.NEVER, 1)):
        prefs = _prefs(
            rule_catalog=[
                RuleDefinition(
                    name="r",
                    match=RuleMatch(field="event.code", op="equals", value="r"),
                    correlation=CorrelationRule(mode=mode, n=n),
                )
            ],
        )
        assert correlation_n_inert_reason(prefs, st) == INERT_INLINE_RULE_CORRELATION, mode
        # The writer really does target a location correlation_for_def ignores.
        rd = next(r for r in prefs.rule_catalog if r.name == "r")
        assert prefs.correlation_for_def(rd).mode == mode

    # A RuleDefinition WITHOUT an inline correlation is unaffected — the by-name
    # correlation_rules entry is exactly what the pipeline reads for it.
    plain = _prefs(
        correlation_rules={"r": CorrelationRule(mode=CorrelationMode.THRESHOLD, n=3)},
        rule_catalog=[
            RuleDefinition(
                name="r", match=RuleMatch(field="event.code", op="equals", value="r")
            )
        ],
    )
    assert correlation_n_inert_reason(plain, st) is None


def test_inherited_default_correlation_every_is_not_a_per_rule_verdict() -> None:
    """A tenant-wide ``default_correlation`` is a global posture, not a statement about
    this rule, so it deliberately keeps today's behaviour (the Demo sandbox runs this
    way on purpose). Only an EXPLICIT per-rule EVERY is treated as config-side inert."""
    prefs = _prefs(default_correlation=CorrelationRule(mode=CorrelationMode.EVERY, n=1))
    st = RuleStat(
        rule_id="r", observed=30, total=30, fp=30, fp_lower_bound=0.88,
        primary_cases=30, primary_mode_threshold=30,
    )
    assert correlation_n_inert_reason(prefs, st) is None
    assert inert_correlation_skips(prefs, {"r": st}) == {}
    assert _kinds(derive_proposals(prefs, {"r": st})) == ["correlation_n"]


def test_inert_skips_are_empty_when_n_tuning_is_disabled() -> None:
    """With ``max_n_step`` 0 nothing was going to be drafted by n anyway."""
    prefs = _prefs(max_n_step=0)
    stats = {"r": RuleStat(
        rule_id="r", observed=30, total=30, fp=30, fp_lower_bound=0.88,
        primary_cases=30, primary_mode_every=30,
    )}
    assert inert_correlation_skips(prefs, stats) == {}


def test_inert_skips_ignore_a_rule_already_tuned_this_window() -> None:
    prefs = _prefs()
    stats = {"r": RuleStat(
        rule_id="r", observed=30, total=30, fp=30, fp_lower_bound=0.88,
        primary_cases=30, primary_mode_every=30,
    )}
    assert inert_correlation_skips(prefs, stats) == {"r": INERT_ALERTS_ROLE_OVERRIDE}
    assert inert_correlation_skips(prefs, stats, already_tuned={"r": 2}) == {}


# --------------------------------------------------------------------------- #
# derive_proposals — the alerts-role rule
# --------------------------------------------------------------------------- #
def test_alerts_role_rule_gets_no_correlation_n_proposal() -> None:
    """The defect: 30 noisy cases that all fired via the override drafted an n raise."""
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", "External Admin Panel Successful Access") for i in range(30)]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)
    st = stats["External Admin Panel Successful Access"]
    assert st.total == 30 and st.fp_lower_bound > 0.30, "the rule really is noisy"
    assert st.primary_mode_every == 30 and st.primary_mode_threshold == 0

    props = derive_proposals(prefs, stats)
    assert "correlation_n" not in _kinds(props)
    assert props == [], "no bounded alternative exists, so nothing may be drafted"


def test_alerts_role_rule_is_retargeted_to_a_feed_severity_floor() -> None:
    """Prefer a knob that CAN take effect over silently doing nothing."""
    rule = "External Admin Panel Successful Access"
    prefs = _prefs(sources=[_alerts_feed_source(rule)])
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)

    props = derive_proposals(prefs, stats)
    assert _kinds(props) == ["severity_floor"]
    prop = props[0]
    assert prop.rule_id == rule
    assert prop.before == 2 and prop.after == 3
    assert prop.feed_key == "src1:feedA"
    # The structural reason travels with the re-targeted change.
    assert prop.inert_reason == INERT_ALERTS_ROLE_OVERRIDE


# --------------------------------------------------------------------------- #
# The regression pin — an events-role rule is COMPLETELY unaffected
# --------------------------------------------------------------------------- #
def test_events_role_rule_still_drafts_correlation_n_exactly_as_before() -> None:
    prefs = _prefs()
    cases = [_case(case_id=f"e{i}", rule="events_rule") for i in range(30)]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)
    assert stats["events_rule"].primary_mode_threshold == 30

    props = derive_proposals(prefs, stats)
    assert len(props) == 1
    prop = props[0]
    assert prop.kind == "correlation_n"
    assert prop.rule_id == "events_rule"
    assert prop.before == 5 and prop.after == 6  # default n 5, +1 bounded step
    assert prop.inert_reason is None
    assert inert_correlation_skips(prefs, stats) == {}


async def test_events_role_rule_still_auto_applies_and_audits_as_before(
    app_state: AppState,
) -> None:
    prefs = _prefs()
    cases = [_case(case_id=f"e{i}", rule="events_rule") for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )

    assert outcome.inert_rules == []
    assert len(outcome.auto_applied) == 1
    record = outcome.auto_applied[0]
    assert record.target == "correlation_n" and record.before == 5 and record.after == 6
    assert box["prefs"].correlation_for("events_rule").n == 6
    summaries = audit.summaries(ActionType.TUNING)
    assert len(summaries) == 1
    assert "auto-applied correlation_n" in summaries[0] and "reversible" in summaries[0]


def test_events_role_rule_with_an_alerts_sibling_is_unaffected() -> None:
    """One noisy alerts rule must not suppress a different, genuinely tunable rule."""
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", "alerts_rule") for i in range(30)]
    cases += [_case(case_id=f"e{i}", rule="events_rule") for i in range(30)]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)

    props = derive_proposals(prefs, stats)
    assert [(p.rule_id, p.kind) for p in props] == [("events_rule", "correlation_n")]
    assert inert_correlation_skips(prefs, stats) == {"alerts_rule": INERT_ALERTS_ROLE_OVERRIDE}


# --------------------------------------------------------------------------- #
# False-positive guards on the detector
# --------------------------------------------------------------------------- #
def test_mixed_role_evidence_does_not_trigger_the_skip() -> None:
    """A rule fed by BOTH an events-role and an alerts-role feed stays tunable."""
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", "mixed_rule") for i in range(20)]
    cases += [_case(case_id=f"e{i}", rule="mixed_rule") for i in range(20)]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)
    st = stats["mixed_rule"]
    assert st.primary_mode_every == 20 and st.primary_mode_threshold == 20

    assert inert_correlation_skips(prefs, stats) == {}
    assert _kinds(derive_proposals(prefs, stats)) == ["correlation_n"]


def test_rule_with_no_observed_cases_does_not_trigger_the_skip() -> None:
    """A rule the window never produced a case for has no evidence either way."""
    prefs = _prefs()
    stats = tuner._accumulate_rule_stats([], ewma_alpha=0.3, z=1.96)
    assert stats == {}
    assert inert_correlation_skips(prefs, stats) == {}

    # And a hand-built stat with volume but no trigger evidence keeps drafting.
    blind = {"blind_rule": RuleStat(
        rule_id="blind_rule", observed=30, total=30, fp=30, fp_lower_bound=0.88,
    )}
    assert inert_correlation_skips(prefs, blind) == {}
    assert _kinds(derive_proposals(prefs, blind)) == ["correlation_n"]


def test_cases_without_trigger_evidence_do_not_trigger_the_skip() -> None:
    prefs = _prefs()
    cases = [_case(case_id=f"n{i}", rule="legacy_rule", trigger=False) for i in range(30)]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)
    assert stats["legacy_rule"].primary_cases == 0
    assert inert_correlation_skips(prefs, stats) == {}
    assert _kinds(derive_proposals(prefs, stats)) == ["correlation_n"]


def test_secondary_rule_ids_are_never_credited_with_the_primary_mode() -> None:
    """``trigger_reason`` describes the PRIMARY rule only, so a co-occurring rule id
    must not inherit its EVERY mode as evidence about itself."""
    prefs = _prefs()
    cases = [
        _case(
            case_id=f"m{i}",
            rule="primary_rule",
            mode="every",
            n=1,
            rule_ids=["primary_rule", "secondary_rule"],
        )
        for i in range(30)
    ]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)
    assert stats["secondary_rule"].primary_cases == 0
    assert stats["primary_rule"].primary_mode_every == 30

    skips = inert_correlation_skips(prefs, stats)
    assert skips == {"primary_rule": INERT_ALERTS_ROLE_OVERRIDE}
    # The secondary rule keeps today's behaviour exactly.
    assert [(p.rule_id, p.kind) for p in derive_proposals(prefs, stats)] == [
        ("secondary_rule", "correlation_n")
    ]


# --------------------------------------------------------------------------- #
# run_once — no inert write, no false "auto-applied", and it IS surfaced
# --------------------------------------------------------------------------- #
async def test_run_once_never_applies_or_claims_an_inert_change(
    app_state: AppState,
) -> None:
    rule = "External Admin Panel Successful Access"
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )

    assert outcome.ran is True
    assert outcome.auto_applied == [], "an inert change must never be applied"
    assert await store.list(active_only=True) == [], "no ledger row may claim the apply"
    assert "prefs" not in box, "no configuration write at all"
    # No audit row may claim an auto-applied, reversible correlation_n change.
    summaries = audit.summaries(ActionType.TUNING)
    assert not any("auto-applied" in text and "reversible" in text for text in summaries)
    assert outcome.reason == "correlation_n tuning is structurally inert for every noisy rule"


async def test_inertness_reason_appears_in_the_observation_and_audit_output(
    app_state: AppState,
) -> None:
    rule = "External Admin Panel Successful Access"
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, _box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )

    # (a) the observation output
    assert len(outcome.inert_rules) == 1
    row = outcome.inert_rules[0]
    assert row["rule_id"] == rule
    assert row["target"] == "correlation_n"
    assert row["reason"] == INERT_ALERTS_ROLE_OVERRIDE
    assert "alerts-role" in row["detail"] or "EVERY" in row["detail"]
    assert row["retargeted_to"] is None
    assert row["observed_cases"] == 30 and row["analyst_samples"] == 30
    assert row["observed_mode_every"] == 30 and row["observed_mode_threshold"] == 0

    # (b) the append-only audit trail
    summaries = audit.summaries(ActionType.TUNING)
    inert_rows = [text for text in summaries if "structurally inert" in text]
    assert len(inert_rows) == 1
    assert rule in inert_rows[0]
    assert INERT_ALERTS_ROLE_OVERRIDE in inert_rows[0]
    assert "no bounded alternative" in inert_rows[0]

    # (c) a review-ONLY Approvals finding with the operator-facing reason
    stored = [p for p in await app_state.proposals.list() if p.kind == "tuning"]
    assert len(stored) == 1
    payload = stored[0].payload
    assert payload["action"] == "review_finding"
    assert payload["reason_code"] == INERT_ALERTS_ROLE_OVERRIDE
    assert payload["target"] == tuner.CORRELATION_N_INERT_KIND
    assert payload["before"] == payload["after"], "there is nothing to apply"
    assert payload["inert_reason"] == INERT_ALERTS_ROLE_OVERRIDE
    assert "cannot reduce its volume" in payload["reason"]
    assert "severity" in payload["recommended_action"]


async def test_inert_review_finding_approval_can_never_mutate_a_threshold(
    app_state: AppState,
) -> None:
    """Approving the finding is an acknowledgement — the approval path writes nothing."""
    rule = "noisy_alerts_rule"
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    store = TuningStore(app_state._kv)
    write, _box = _writer_capture()

    await run_once(
        prefs, cases, app_state.proposals, FakeAudit(),
        tuning_store=store, write_prefs=write,
    )
    stored = [p for p in await app_state.proposals.list() if p.kind == "tuning"]
    assert len(stored) == 1

    new_prefs, record, changed = materialize_approved_tuning(
        prefs, stored[0].payload, proposal_id=stored[0].id,
    )
    assert record is None and changed is False
    assert new_prefs is prefs
    assert new_prefs.correlation_for(rule).n == prefs.correlation_for(rule).n


async def test_inert_rule_is_reported_but_not_re_proposed_every_pass(
    app_state: AppState,
) -> None:
    """The forever-redraft loop is gone: repeated passes never grow the queue or n."""
    rule = "noisy_alerts_rule"
    prefs = _prefs()
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    first = await run_once(prefs, cases, app_state.proposals, audit,
                           tuning_store=store, write_prefs=write)
    second = await run_once(prefs, cases, app_state.proposals, audit,
                            tuning_store=store, write_prefs=write)

    assert len(first.inert_rules) == 1 and len(second.inert_rules) == 1
    assert first.auto_applied == [] and second.auto_applied == []
    assert "prefs" not in box
    assert await store.list() == []
    # add_unique deduplicates the standing finding instead of stacking a new row.
    stored = [p for p in await app_state.proposals.list() if p.kind == "tuning"]
    assert len(stored) == 1
    assert prefs.correlation_for(rule).n == 5, "the live threshold never moved"


async def test_retargeted_severity_floor_is_applied_and_reported(
    app_state: AppState,
) -> None:
    """The alternative that CAN take effect is applied, and the reason is still visible."""
    rule = "External Admin Panel Successful Access"
    prefs = _prefs(sources=[_alerts_feed_source(rule)])
    cases = [_alerts_case(f"a{i}", rule) for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )

    assert len(outcome.auto_applied) == 1
    record = outcome.auto_applied[0]
    assert record.target == "severity_floor" and record.rule_id == "src1:feedA"
    assert record.before == 2 and record.after == 3
    assert box["prefs"].sources[0].feeds()[0].severity_floor == 3
    # correlation_n was never touched.
    assert box["prefs"].correlation_for(rule).n == 5

    assert len(outcome.inert_rules) == 1
    assert outcome.inert_rules[0]["retargeted_to"] == "severity_floor"
    inert_rows = [t for t in audit.summaries(ActionType.TUNING) if "structurally inert" in t]
    assert len(inert_rows) == 1 and "re-targeted to severity_floor" in inert_rows[0]
    # No review-only finding is drafted when a real alternative was taken.
    stored = [p for p in await app_state.proposals.list() if p.kind == "tuning"]
    assert stored == []


async def test_configured_mode_every_rule_is_never_n_tuned(app_state: AppState) -> None:
    """An operator-configured EVERY rule is the same situation and is skipped too."""
    rule = "every_rule"
    prefs = _prefs(
        correlation_rules={rule: CorrelationRule(mode=CorrelationMode.EVERY, n=1)},
    )
    # Evidence deliberately says THRESHOLD: the LIVE config is what decides here.
    cases = [_case(case_id=f"c{i}", rule=rule) for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )

    assert outcome.auto_applied == []
    assert "prefs" not in box
    assert [row["reason"] for row in outcome.inert_rules] == [INERT_CONFIGURED_MODE_EVERY]
    stored = [p for p in await app_state.proposals.list() if p.kind == "tuning"]
    assert len(stored) == 1
    assert stored[0].payload["reason_code"] == INERT_CONFIGURED_MODE_EVERY
    assert stored[0].payload["action"] == "review_finding"


# --------------------------------------------------------------------------- #
# The safety rails still hold for the new path
# --------------------------------------------------------------------------- #
async def test_inert_finding_is_review_only_even_through_handle_proposal(
    app_state: AppState,
) -> None:
    """No caller can push the review-only finding down a config-writer path."""
    prefs = _prefs()
    outcome = tuner.TuningOutcome(ran=True)
    prop = tuner.TuningProposal(
        rule_id="r",
        kind=tuner.CORRELATION_N_INERT_KIND,
        before=5,
        after=5,
        stat=RuleStat(rule_id="r", observed=30, total=30, fp=30, fp_lower_bound=0.9),
        inert_reason=INERT_ALERTS_ROLE_OVERRIDE,
    )
    calls: list[Any] = []

    def _writer(_prefs: Preferences, _prop: tuner.TuningProposal) -> Preferences | None:
        calls.append(_prop)  # pragma: no cover — must never run
        return _prefs

    new_prefs, record = await tuner._handle_proposal(
        prop, prefs, [], prefs.threshold_tuning,
        proposals=app_state.proposals, audit=None,
        tuning_store=TuningStore(app_state._kv),
        writers={tuner.CORRELATION_N_INERT_KIND: _writer},
        outcome=outcome,
    )
    assert new_prefs is prefs and record is None
    assert calls == [], "a review-only finding must never reach a config writer"
    assert len(outcome.proposals) == 1


@pytest.mark.parametrize("action", ["review_finding", "collect_evidence", "review_history"])
def test_acknowledgement_actions_never_write_configuration(action: str) -> None:
    prefs = _prefs()
    updated, record, changed = materialize_approved_tuning(
        prefs,
        {"action": action, "rule_id": "r", "target": "correlation_n", "before": 5, "after": 6},
        proposal_id="prop-1",
    )
    assert updated is prefs and record is None and changed is False


def test_module_still_never_imports_the_close_decision(  # noqa: D103 — #3 guard
) -> None:
    import inspect

    source = inspect.getsource(tuner)
    assert "case_manager" not in source
    assert "decide(" not in source
