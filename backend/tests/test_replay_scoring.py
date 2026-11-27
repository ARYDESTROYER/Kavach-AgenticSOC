"""Scoring contract for the replay harness: decide() offline, McNemar, the noise floor."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from app.config import Preferences
from app.constants import CaseStatus, Verdict
from app.engine import case_manager
from app.engine.replay import scoring
from app.engine.replay.scoring import (
    CellRecord,
    arm_comparison,
    arm_summary,
    corpus_fingerprint,
    mcnemar_chi2_corrected,
    mcnemar_exact,
    noise_floor,
    offline_decision,
    paired_fixture_ids,
    paired_table,
    policy_fingerprint,
)


def _cell(fixture: str, arm: str, repeat: int, close: bool, verdict: str = "FALSE_POSITIVE"):
    return CellRecord(
        fixture_id=fixture, content_hash="h", arm_id=arm, repeat=repeat,
        verdict=verdict, close_eligible=close,
        retrieval_observation_status="measured",
        retrieval_input_fingerprint="fp",
    )


def _closing_prefs() -> Preferences:
    prefs = Preferences()
    prefs.auto_close.false_positive.enabled = True
    prefs.auto_close.false_positive.min_confidence = 0.5
    prefs.auto_close.false_positive.max_risk_score = 100.0
    return prefs


def test_offline_scorer_calls_the_production_decide_unmodified():
    """The scorer must be the shipped authority, not a copy of it (#3, R4)."""
    assert scoring.decide is case_manager.decide
    source = Path(case_manager.__file__).read_bytes()
    before = hashlib.md5(source).hexdigest()
    offline_decision(Verdict.FALSE_POSITIVE, 0.99, 5.0, _closing_prefs())
    assert scoring.decide is case_manager.decide
    assert hashlib.md5(Path(case_manager.__file__).read_bytes()).hexdigest() == before


def test_needs_human_is_never_close_eligible_even_with_a_needs_human_policy():
    """Close-eligibility is derived from BEHAVIOUR, never from the config schema.

    ``policy.needs_human`` is a real, settable field that ``_entry_for`` ignores
    unconditionally, so a scorer that read the schema would report the opposite.
    """
    prefs = _closing_prefs()
    prefs.auto_close.needs_human.enabled = True
    prefs.auto_close.needs_human.min_confidence = 0.0
    prefs.auto_close.needs_human.max_risk_score = 100.0
    projection, close_eligible = offline_decision(Verdict.NEEDS_HUMAN, 1.0, 0.0, prefs)
    assert close_eligible is False
    assert projection["status"] == CaseStatus.NEEDS_HUMAN.value


def test_decide_comparison_excludes_the_wall_clock_objection_window():
    """decide() stamps a live objection window, so raw dataclass equality is wrong."""
    prefs = _closing_prefs()
    first = case_manager.decide(Verdict.FALSE_POSITIVE, 0.99, 1.0, prefs.auto_close)
    second = case_manager.decide(Verdict.FALSE_POSITIVE, 0.99, 1.0, prefs.auto_close)
    assert first.objection_window_expires_at is not None
    one, _ = offline_decision(Verdict.FALSE_POSITIVE, 0.99, 1.0, prefs)
    two, _ = offline_decision(Verdict.FALSE_POSITIVE, 0.99, 1.0, prefs)
    assert one == two
    # The full dataclasses may legitimately differ only in that one stamped field.
    assert (first.status, first.decision_by, first.escalate, first.rationale) == (
        second.status, second.decision_by, second.escalate, second.rationale
    )

    cells = [
        _cell("fx-1", "a", 0, True), _cell("fx-1", "b", 0, True),
        _cell("fx-2", "a", 0, True), _cell("fx-2", "b", 0, True),
    ]
    table = paired_table(cells, "a", "b")
    assert (table["b"], table["c"]) == (0, 0)


@pytest.mark.parametrize(
    "b,c,expected",
    [(0, 0, 1.0), (5, 0, 0.0625), (3, 1, 0.625), (1, 3, 0.625), (10, 10, 1.0)],
)
def test_mcnemar_exact_binomial_known_values(b: int, c: int, expected: float):
    assert mcnemar_exact(b, c) == pytest.approx(expected)


def test_corrected_chi_square_is_reported_only_beside_the_exact_p():
    assert mcnemar_chi2_corrected(0, 0) is None
    assert mcnemar_chi2_corrected(5, 0) == pytest.approx(16 / 5)


def test_noise_floor_is_required_before_any_arm_claim():
    """One repeat cannot measure self-consistency, so no comparison may be claimed."""
    cells = [_cell("fx-1", "a", 0, True), _cell("fx-1", "b", 0, False)]
    floor = noise_floor(cells, ["a", "b"], repeats=1)
    assert floor["measured"] is False
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert result["verdict"] == "insufficient_evidence"
    assert result["reason"] == "noise_floor_not_measured"
    assert result["exceeds_noise_floor"] is False


def test_difference_below_the_measured_floor_is_indistinguishable_from_noise():
    cells: list[CellRecord] = []
    # Arm "a" disagrees with itself on two of four fixtures: a 0.5 floor.
    for index in range(4):
        fixture = f"fx-{index}"
        cells.append(_cell(fixture, "a", 0, index < 2))
        cells.append(_cell(fixture, "a", 1, index < 4))
        cells.append(_cell(fixture, "b", 0, index < 1))
        cells.append(_cell(fixture, "b", 1, index < 1))
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    assert floor["pooled_close_disagreement_rate"] == pytest.approx(0.5)
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert result["verdict"] == "indistinguishable_from_noise"
    assert result["exceeds_noise_floor"] is False
    # An insufficient/indistinguishable outcome is never converted into a score.
    assert "score" not in json.dumps(result)


def test_no_discordant_pairs_is_its_own_verdict():
    cells = [
        _cell("fx-1", "a", 0, True), _cell("fx-1", "b", 0, True),
        _cell("fx-1", "a", 1, True), _cell("fx-1", "b", 1, True),
    ]
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert result["verdict"] == "no_discordant_pairs"
    assert (result["b"], result["c"]) == (0, 0)


def test_excluded_cells_leave_the_denominator_entirely():
    """An analyst-policy short-circuit has no triple, so it cannot be a discordant pair."""
    cells = [
        _cell("fx-1", "a", 0, True), _cell("fx-1", "b", 0, False),
        _cell("fx-2", "a", 0, False), _cell("fx-2", "b", 0, True),
    ]
    cells[2].excluded = True
    cells[2].exclusion_reason = "analyst_policy"
    cells[2].verdict = None
    table = paired_table(cells, "a", "b")
    assert table["n_pairs"] == 1
    assert (table["b"], table["c"]) == (1, 0)


_INFERENTIAL = (
    "rate_a", "rate_b", "rate_difference", "p_exact", "mcnemar_chi2_corrected",
    "gross_discordance_rate",
)


def _assert_insufficient(result: dict) -> None:
    """An insufficient result may carry OBSERVATIONS but never inferential statistics.

    Both halves matter: without the second, a fix that blanks the whole object passes;
    without the first, ``p_exact`` could ship without the counts that give it meaning.
    """
    assert result["verdict"] == "insufficient_evidence"
    for key in _INFERENTIAL:
        assert result[key] is None, (key, result[key])
    for key in ("n_pairs", "a", "b", "c", "d"):
        assert isinstance(result[key], int)


def test_every_insufficient_path_withholds_the_inferential_statistics():
    """R8/LIMITATIONS: an insufficient result is never converted into a rate or a p."""
    ten = []
    for index in range(10):
        fixture = f"fx-{index}"
        ten.append(_cell(fixture, "a", 0, True))
        ten.append(_cell(fixture, "b", 0, False))

    # 1. single arm
    floor_one = noise_floor(ten, ["a"], repeats=2)
    _assert_insufficient(
        arm_comparison(ten, ["a"], floor_one, alpha=0.05, run_incomplete=False)
    )
    # 2. the noise floor was never measured (repeats=1 is a legal submission)
    floor = noise_floor(ten, ["a", "b"], repeats=1)
    assert floor["measured"] is False
    result = arm_comparison(ten, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    _assert_insufficient(result)
    assert result["reason"] == "noise_floor_not_measured"
    # A significant p and a 100pp difference would otherwise have shipped here.
    assert (result["b"], result["c"]) == (10, 0)

    # 3. no paired fixtures at all
    lonely = [_cell("fx-1", "a", 0, True), _cell("fx-2", "b", 0, False)]
    lonely += [_cell("fx-1", "a", 1, True), _cell("fx-2", "b", 1, False)]
    floor_lonely = noise_floor(lonely, ["a", "b"], repeats=2)
    _assert_insufficient(
        arm_comparison(lonely, ["a", "b"], floor_lonely, alpha=0.05, run_incomplete=False)
    )

    # 4. run_incomplete, with a measured floor and real pairs behind it
    both = []
    for index in range(6):
        fixture = f"fx-{index}"
        for repeat in (0, 1):
            both.append(_cell(fixture, "a", repeat, True))
            both.append(_cell(fixture, "b", repeat, index < 1))
    floor_both = noise_floor(both, ["a", "b"], repeats=2)
    assert floor_both["measured"] is True
    incomplete = arm_comparison(
        both, ["a", "b"], floor_both, alpha=0.05, run_incomplete=True
    )
    _assert_insufficient(incomplete)
    assert incomplete["reason"] == "run_incomplete"

    # The inverse guard: a SUFFICIENT result must still carry them.
    sufficient = arm_comparison(
        both, ["a", "b"], floor_both, alpha=0.05, run_incomplete=False
    )
    assert sufficient["verdict"] != "insufficient_evidence"
    for key in _INFERENTIAL:
        assert sufficient[key] is not None, key


def test_the_floor_guard_compares_a_net_difference_with_a_net_floor():
    """A NET signed difference tested against a GROSS flip rate suppresses real effects."""
    cells: list[CellRecord] = []
    # 20 fixtures. Arm "a" changes its mind about 8 of them between repeats — a 0.40
    # GROSS per-fixture flip rate — but SYMMETRICALLY, so its own close rate does not
    # move at all. Arm "b" is perfectly self-consistent.
    for index in range(20):
        fixture = f"fx-{index}"
        cells.append(_cell(fixture, "a", 0, index < 10))
        cells.append(_cell(fixture, "a", 1, 4 <= index < 14))
        cells.append(_cell(fixture, "b", 0, index < 4))
        cells.append(_cell(fixture, "b", 1, index < 4))
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    assert floor["pooled_close_disagreement_rate"] == pytest.approx(0.4)
    assert floor["pooled_close_rate_swing"] == pytest.approx(0.0)

    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert result["noise_floor_basis"] == "net_close_rate_swing"
    assert result["p_exact"] < 0.05
    assert result["above_noise_floor"] is True
    assert result["verdict"] == "difference_exceeds_noise_floor"
    # A gross-vs-gross guard would have suppressed this: the between-arm gross
    # discordance (0.30) is below the within-arm gross flip rate (0.40).
    assert result["gross_discordance_rate"] == pytest.approx(0.3)
    assert result["rate_difference"] == pytest.approx(0.3)


def test_a_genuinely_unstable_arm_is_still_reported_as_noise():
    """The guard is not simply weakened: a large self-swing still suppresses a claim."""
    cells: list[CellRecord] = []
    for index in range(20):
        fixture = f"fx-{index}"
        # Arm "a" swings its own close rate 1.0 -> 0.5 between repeats.
        cells.append(_cell(fixture, "a", 0, True))
        cells.append(_cell(fixture, "a", 1, index < 10))
        cells.append(_cell(fixture, "b", 0, index >= 6))
        cells.append(_cell(fixture, "b", 1, index >= 6))
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    assert floor["pooled_close_rate_swing"] == pytest.approx(0.5)
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert result["above_noise_floor"] is False
    assert result["verdict"] == "indistinguishable_from_noise"


def test_above_the_floor_but_untestable_is_underpowered_not_noise():
    """"Add fixtures" and "abandon the hypothesis" are different answers."""
    cells: list[CellRecord] = []
    for index in range(20):
        fixture = f"fx-{index}"
        for repeat in (0, 1):
            cells.append(_cell(fixture, "a", repeat, index < 5))
            cells.append(_cell(fixture, "b", repeat, False))
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    assert floor["pooled_close_disagreement_rate"] == pytest.approx(0.0)
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert (result["b"], result["c"]) == (5, 0)
    assert result["above_noise_floor"] is True
    assert result["significant_at_alpha"] is False   # min attainable p is 2**-4
    assert result["exceeds_noise_floor"] is False
    assert result["verdict"] == "underpowered"
    assert result["reason"] == "too_few_discordant_pairs"


def test_the_floor_comparison_is_null_where_no_floor_was_measured():
    cells = [_cell("fx-1", "a", 0, True), _cell("fx-1", "b", 0, False)]
    floor = noise_floor(cells, ["a", "b"], repeats=1)
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    # Unavailable stays null; it never becomes a measured ``false``.
    assert result["above_noise_floor"] is None
    assert result["significant_at_alpha"] is None
    assert result["exceeds_noise_floor"] is False


def test_a_floor_measured_on_fewer_observations_than_the_table_is_undersampled():
    """A floor may not gate a claim it did not cover."""
    cells: list[CellRecord] = []
    for index in range(8):
        fixture = f"fx-{index}"
        cells.append(_cell(fixture, "a", 0, True))
        cells.append(_cell(fixture, "b", 0, False))
    # Only fixture 0 has a second repeat, so the floor rests on ONE comparison.
    cells.append(_cell("fx-0", "a", 1, True))
    cells.append(_cell("fx-0", "b", 1, False))
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    assert floor["measured"] is True and floor["min_compared"] == 1
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    _assert_insufficient(result)
    assert result["reason"] == "noise_floor_undersampled"
    assert result["noise_floor_coverage"] == pytest.approx(0.125)


def test_an_unmeasured_retrieval_rate_is_null_not_a_measured_zero():
    """Zero comparisons and N perfectly stable comparisons must not look identical."""
    unmeasured: list[CellRecord] = []
    measured: list[CellRecord] = []
    for index in range(5):
        fixture = f"fx-{index}"
        for repeat in (0, 1):
            cell = _cell(fixture, "a", repeat, True)
            cell.retrieval_observation_status = "not_measured"
            cell.retrieval_input_fingerprint = None
            unmeasured.append(cell)
            measured.append(_cell(fixture, "a", repeat, True))
    left = noise_floor(unmeasured, ["a"], repeats=2)["per_arm"][0]
    right = noise_floor(measured, ["a"], repeats=2)["per_arm"][0]
    assert left != right
    assert left["retrieval_compared"] == 0
    assert left["retrieval_disagreement_rate"] is None
    assert right["retrieval_compared"] == 5
    assert right["retrieval_disagreement_rate"] == 0.0


def test_rates_are_null_when_their_denominator_is_zero():
    floor = noise_floor([], ["a", "b"], repeats=2)
    assert floor["measured"] is False
    for row in floor["per_arm"]:
        assert row["compared"] == 0
        assert row["close_disagreement_rate"] is None
        assert row["verdict_disagreement_rate"] is None
        assert row["close_rate_swing"] is None
    assert floor["pooled_close_disagreement_rate"] is None
    assert floor["pooled_close_rate_swing"] is None


def test_arm_rates_are_paired_and_the_unpaired_one_is_named_as_such():
    """Two unpaired per-arm rates can show an effect the paired table says is zero."""
    cells: list[CellRecord] = []
    for index in range(4):
        fixture = f"fx-{index}"
        for repeat in (0, 1):
            cells.append(_cell(fixture, "a", repeat, index == 0 or index == 2))
            cells.append(_cell(fixture, "b", repeat, index == 0))
    # Arm "b" loses fixture 2 to a one-sided pipeline error.
    for cell in cells:
        if cell.fixture_id == "fx-2" and cell.arm_id == "b":
            cell.excluded, cell.exclusion_reason = True, "pipeline_error"

    paired = paired_fixture_ids(cells, ["a", "b"])
    floor = noise_floor(cells, ["a", "b"], repeats=2)
    comparison = arm_comparison(
        cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False
    )
    arms = [
        arm_summary(cells, arm_id, {}, paired_ids=paired) for arm_id in ("a", "b")
    ]
    # The unpaired figures genuinely differ — that is the trap.
    assert arms[0]["close_eligible_rate_unpaired"] != arms[1]["close_eligible_rate_unpaired"]
    # The headline rate is paired and agrees with the paired table by construction.
    assert arms[0]["close_eligible_rate"] == comparison["rate_a"]
    assert arms[1]["close_eligible_rate"] == comparison["rate_b"]
    assert arms[0]["n_primary_paired"] == comparison["n_pairs"] == 3


def test_every_arm_count_states_its_own_denominator():
    """``scored`` pools repeats while ``close_eligible`` is repeat 0; both are labelled."""
    cells: list[CellRecord] = []
    for index in range(3):
        fixture = f"fx-{index}"
        cells.append(_cell(fixture, "a", 0, index < 2))
        cells.append(_cell(fixture, "a", 1, index < 2))
    cells[-1].excluded, cells[-1].exclusion_reason = True, "spend_bound"

    summary = arm_summary(cells, "a", {})
    assert summary["scored"] == 5 and summary["primary_scored"] == 3
    assert summary["pooled_basis"] == "all_repeats"
    assert summary["close_eligible_basis"] == "repeat_0"
    assert summary["close_eligible_rate_unpaired"] == pytest.approx(
        summary["close_eligible"] / summary["primary_scored"]
    )
    # ``scored / repeats`` is 2.5 here, so the denominator is NOT derivable.
    assert summary["scored"] / 2 != summary["primary_scored"]


def test_the_sidedness_of_the_test_is_stated_in_the_payload():
    cells = [_cell("fx-1", "a", 0, True), _cell("fx-1", "b", 0, True)]
    floor = noise_floor(cells, ["a", "b"], repeats=1)
    result = arm_comparison(cells, ["a", "b"], floor, alpha=0.05, run_incomplete=False)
    assert result["test"] == "mcnemar_exact_binomial"
    assert result["alternative"] == "two_sided"
    assert mcnemar_exact(5, 0) == pytest.approx(0.0625)


def test_the_policy_fingerprint_moves_with_the_policy_and_only_with_it():
    """``close_eligible`` is a function of the policy, so pairing must detect a change."""
    base = _closing_prefs()
    same = _closing_prefs()
    assert policy_fingerprint(base) == policy_fingerprint(same)

    moved = _closing_prefs()
    moved.auto_close.false_positive.min_confidence = 0.95
    assert policy_fingerprint(moved) != policy_fingerprint(base)
    # And the recorded triple really does flip under it.
    _projection, before = offline_decision(Verdict.FALSE_POSITIVE, 0.9, 5.0, base)
    _projection, after = offline_decision(Verdict.FALSE_POSITIVE, 0.9, 5.0, moved)
    assert before is True and after is False


def test_the_corpus_pin_order_is_a_function_of_the_fingerprint():
    """Same fingerprint must imply same pinned order, or retrieval ties flip."""
    from app.engine.replay.scoring import corpus_row
    from app.tools.vectorstore import StoredChunk

    chunks = [
        StoredChunk(
            text="shared boilerplate", source="runbook", metadata={},
            embedding=[0.1] * 4, embedding_model="m", dim=4, doc_id=doc,
        )
        for doc in ("doc-b", "doc-a")
    ]
    reversed_chunks = list(reversed(chunks))
    assert corpus_fingerprint(chunks) == corpus_fingerprint(reversed_chunks)
    assert sorted(chunks, key=corpus_row) == sorted(reversed_chunks, key=corpus_row)
    assert [c.doc_id for c in sorted(chunks, key=corpus_row)] == ["doc-a", "doc-b"]
