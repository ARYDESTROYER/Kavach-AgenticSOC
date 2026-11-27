"""Pure scoring for a replay run: close-eligibility, the paired table, the noise floor.

Nothing here does I/O. Close-eligibility is derived by IMPORTING and CALLING the
production :func:`app.engine.case_manager.decide` against the deployer's configured
policy — never copied, reimplemented, wrapped-and-modified, or monkeypatched, and never
inferred from the configuration schema. ``policy.needs_human`` is a real, settable
field that ``_entry_for`` ignores outright, so only behaviour is authoritative.

Every statistic that can be insufficient stays explicitly insufficient. No composite
score is produced anywhere in this module.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Any

from ...config import Preferences
from ...constants import CaseStatus
from ..case_manager import decide  # the untouched production authority (#3)
from .fixtures import canonical_json


@dataclass
class CellRecord:
    """One ``(fixture, arm, repeat)`` outcome."""

    fixture_id: str
    content_hash: str
    arm_id: str
    repeat: int
    replay_case_id: str = ""
    verdict: str | None = None
    confidence: float = 0.0
    risk_score: float = 0.0
    decision: dict[str, Any] = field(default_factory=dict)
    close_eligible: bool = False
    in_run_status: str = ""
    retrieval_observation_status: str = "not_measured"
    retrieval_input_fingerprint: str | None = None
    evidence_render_sha256: str = ""
    knowledge_refs: list[list[str]] = field(default_factory=list)
    cost_usd: float = 0.0
    calls: int = 0
    tokens: int = 0
    processing_tier: str = ""
    latency_ms: int = 0
    excluded: bool = False
    exclusion_reason: str | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "fixture_id": self.fixture_id,
            "content_hash": self.content_hash,
            "arm_id": self.arm_id,
            "repeat": self.repeat,
            "replay_case_id": self.replay_case_id,
            "verdict": self.verdict,
            "confidence": self.confidence,
            "risk_score": self.risk_score,
            "decide": dict(self.decision),
            "close_eligible": self.close_eligible,
            "in_run_status": self.in_run_status,
            "retrieval_observation_status": self.retrieval_observation_status,
            "retrieval_input_fingerprint": self.retrieval_input_fingerprint,
            "evidence_render_sha256": self.evidence_render_sha256,
            "knowledge_refs": [list(ref) for ref in self.knowledge_refs],
            "cost_usd": self.cost_usd,
            "calls": self.calls,
            "tokens": self.tokens,
            "processing_tier": self.processing_tier,
            "latency_ms": self.latency_ms,
            "excluded": self.excluded,
            "exclusion_reason": self.exclusion_reason,
        }


def offline_decision(
    verdict: Any, confidence: float, risk_score: float, prefs: Preferences
) -> tuple[dict[str, Any], bool]:
    """Score one recorded triple with the PRODUCTION ``decide()``, read-only.

    The comparable projection deliberately EXCLUDES ``objection_window_expires_at``:
    ``decide`` stamps it from the wall clock, so two identical triples produce unequal
    dataclasses and a naive equality would report a spurious discordant pair on every
    auto-closed cell.
    """
    result = decide(
        verdict,
        confidence,
        risk_score,
        prefs.auto_close,
        escalation_confidence=prefs.escalation_confidence,
        critical_severity=prefs.critical_severity,
    )
    projection = {
        "status": result.status.value,
        "decision_by": result.decision_by.value,
        "escalate": bool(result.escalate),
        "rationale": result.rationale,
    }
    return projection, result.status is CaseStatus.CLOSED


def retrieval_input_fingerprint(
    *,
    cluster_json: dict[str, Any],
    enrichment_json: dict[str, Any] | None,
    evidence_fields: list[str],
    evidence_max_chars: int,
    corpus_fingerprint: str,
    knowledge_refs: list[list[str]],
) -> str:
    """A stable identity for what retrieval actually put in front of the model.

    Structured rather than prompt-text, so an unrelated wording edit in the prompt
    module cannot flap the assertion. Chunk SCORES are excluded: a real embedding
    provider need not reproduce a float bit-for-bit.
    """
    payload = {
        "cluster": cluster_json,
        "enrichment": enrichment_json,
        "evidence_fields": list(evidence_fields),
        "evidence_max_chars": int(evidence_max_chars),
        "corpus_fingerprint": corpus_fingerprint,
        "knowledge": [list(ref) for ref in knowledge_refs],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def corpus_row(chunk: Any) -> tuple[str, str, str, str, str]:
    """The chunk identity ``corpus_fingerprint`` hashes AND the pin's sort key.

    Used for BOTH so that "same fingerprint" implies "same pinned order" as a theorem
    rather than a coincidence: neither persistent vector store defines a read order,
    and the in-memory store's search is a STABLE sort, so equal cosine scores are
    broken by insertion order. Two runs over a byte-identical corpus could otherwise
    present different knowledge to the model while reporting the same fingerprint.

    The ``or ""``/``or 0`` coercions are load-bearing: ``doc_id`` is nullable on both
    backends and a mixed ``None``/``str`` corpus would otherwise be unsortable.
    """
    return (
        str(getattr(chunk, "doc_id", "") or ""),
        str(getattr(chunk, "source", "") or ""),
        hashlib.sha256(str(getattr(chunk, "text", "")).encode("utf-8")).hexdigest(),
        str(getattr(chunk, "embedding_model", "") or ""),
        str(int(getattr(chunk, "dim", 0) or 0)),
    )


def corpus_fingerprint(chunks: list[Any]) -> str:
    """Identity of the pinned corpus: content and embedding space, order-independent.

    It does NOT cover the stored vectors themselves, so a silent re-embed within the
    same model and dimension would not move it.
    """
    rows = sorted(list(corpus_row(chunk)) for chunk in chunks)
    return hashlib.sha256(canonical_json(rows).encode("utf-8")).hexdigest()


def policy_fingerprint(prefs: Preferences) -> str:
    """Identity of the DECISION POLICY that scored a run's close-eligibility.

    ``close_eligible`` is a function of the auto-close policy and the two escalation
    thresholds. Without recording them, two artifacts can carry the same
    ``corpus_fingerprint`` — the documented cross-build pairing precondition — while a
    routine Settings edit between the runs flipped the outcome variable.
    """
    payload = {
        "auto_close": prefs.auto_close.model_dump(mode="json"),
        "escalation_confidence": float(prefs.escalation_confidence),
        "critical_severity": float(prefs.critical_severity),
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def policy_identity(prefs: Preferences) -> dict[str, Any]:
    """The recorded policy block: its fingerprint plus the values behind it."""
    return {
        "fingerprint": policy_fingerprint(prefs),
        "auto_close": prefs.auto_close.model_dump(mode="json"),
        "escalation_confidence": float(prefs.escalation_confidence),
        "critical_severity": float(prefs.critical_severity),
    }


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided EXACT binomial McNemar p over the discordant cells.

    Exact rather than the uncorrected chi-square because ``b + c`` is small here by
    construction, which is precisely where the asymptotic test is wrong.
    """
    n = int(b) + int(c)
    if n == 0:
        return 1.0
    k = min(int(b), int(c))
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / float(2 ** n)
    return min(1.0, 2.0 * tail)


def mcnemar_chi2_corrected(b: int, c: int) -> float | None:
    """The continuity-corrected chi-square, reported only BESIDE the exact p."""
    n = int(b) + int(c)
    if n == 0:
        return None
    return round(((abs(int(b) - int(c)) - 1) ** 2) / float(n), 6)


def _scored(cells: list[CellRecord]) -> list[CellRecord]:
    return [cell for cell in cells if not cell.excluded]


def paired_table(
    cells: list[CellRecord], arm_a: str, arm_b: str, *, repeat: int = 0
) -> dict[str, int]:
    """The 2x2 paired table over fixtures scored in BOTH arms at ``repeat``."""
    by_arm: dict[str, dict[str, CellRecord]] = {arm_a: {}, arm_b: {}}
    for cell in _scored(cells):
        if cell.repeat != repeat or cell.arm_id not in by_arm:
            continue
        by_arm[cell.arm_id][cell.fixture_id] = cell
    shared = sorted(set(by_arm[arm_a]) & set(by_arm[arm_b]))
    a = b = c = d = 0
    for fixture_id in shared:
        left = by_arm[arm_a][fixture_id].close_eligible
        right = by_arm[arm_b][fixture_id].close_eligible
        if left and right:
            a += 1
        elif left and not right:
            b += 1
        elif not left and right:
            c += 1
        else:
            d += 1
    return {"a": a, "b": b, "c": c, "d": d, "n_pairs": len(shared)}


def paired_rows(
    cells: list[CellRecord], arm_a: str, arm_b: str, *, repeat: int = 0
) -> list[dict[str, Any]]:
    """One row per fixture in the primary paired table, for the artifact."""
    by_arm: dict[str, dict[str, CellRecord]] = {arm_a: {}, arm_b: {}}
    for cell in _scored(cells):
        if cell.repeat != repeat or cell.arm_id not in by_arm:
            continue
        by_arm[cell.arm_id][cell.fixture_id] = cell
    rows: list[dict[str, Any]] = []
    for fixture_id in sorted(set(by_arm[arm_a]) & set(by_arm[arm_b])):
        left = by_arm[arm_a][fixture_id]
        right = by_arm[arm_b][fixture_id]
        cell = (
            "a" if left.close_eligible and right.close_eligible
            else "b" if left.close_eligible
            else "c" if right.close_eligible
            else "d"
        )
        rows.append({
            "fixture_id": fixture_id,
            "a_close_eligible": left.close_eligible,
            "b_close_eligible": right.close_eligible,
            "a_verdict": left.verdict,
            "b_verdict": right.verdict,
            "cell": cell,
        })
    return rows


def paired_fixture_ids(
    cells: list[CellRecord], arm_ids: list[str], *, repeat: int = 0
) -> list[str]:
    """The fixtures scored in BOTH arms at ``repeat`` — the one paired population."""
    if len(arm_ids) < 2:
        return []
    sets = [
        {
            cell.fixture_id
            for cell in _scored(cells)
            if cell.arm_id == arm_id and cell.repeat == repeat
        }
        for arm_id in arm_ids[:2]
    ]
    return sorted(sets[0] & sets[1])


def noise_floor(cells: list[CellRecord], arm_ids: list[str], repeats: int) -> dict[str, Any]:
    """Self-consistency of each arm, MEASURED from this run's own repeats.

    Never assumed from configuration: the shipped default completion family drops the
    configured temperature entirely at the provider boundary while other providers send
    it, so the floor is deployment- and model-specific and only a measurement is
    honest.

    Two DIFFERENT quantities are measured, because the arm-vs-arm guard needs one that
    is on its own scale:

    * ``close_disagreement_rate`` — the GROSS per-fixture flip rate, i.e. how often one
      arm changes its mind about a fixture between repeats;
    * ``close_rate_swing`` — the NET movement of that arm's own close RATE between
      consecutive repeats, which is the same functional as the between-arm
      ``rate_difference``, measured under a known null (one arm against itself).

    Every rate ships with its denominator beside it and is ``None`` — never ``0.0`` —
    when that denominator is zero, so an unmeasured quantity is never readable as a
    measured zero.
    """
    per_arm: list[dict[str, Any]] = []
    pooled_gross = 0.0
    pooled_swing = 0.0
    compared_counts: list[int] = []
    measured = repeats >= 2
    for arm_id in arm_ids:
        by_repeat: dict[int, dict[str, CellRecord]] = {}
        for cell in _scored(cells):
            if cell.arm_id != arm_id:
                continue
            by_repeat.setdefault(cell.repeat, {})[cell.fixture_id] = cell
        compared = close_diff = verdict_diff = 0
        retrieval_compared = retrieval_diff = 0
        swing = 0.0
        for index in range(max(0, repeats - 1)):
            left = by_repeat.get(index, {})
            right = by_repeat.get(index + 1, {})
            shared = sorted(set(left) & set(right))
            left_closed = right_closed = 0
            for fixture_id in shared:
                one, two = left[fixture_id], right[fixture_id]
                compared += 1
                close_diff += int(one.close_eligible != two.close_eligible)
                verdict_diff += int(one.verdict != two.verdict)
                left_closed += int(one.close_eligible)
                right_closed += int(two.close_eligible)
                if (
                    one.retrieval_observation_status == "measured"
                    and two.retrieval_observation_status == "measured"
                ):
                    retrieval_compared += 1
                    retrieval_diff += int(
                        one.retrieval_input_fingerprint != two.retrieval_input_fingerprint
                    )
            if shared:
                swing = max(swing, abs(left_closed - right_closed) / len(shared))
        close_rate = (close_diff / compared) if compared else None
        per_arm.append({
            "arm_id": arm_id,
            "compared": compared,
            "close_disagreement_rate": (
                round(close_rate, 6) if close_rate is not None else None
            ),
            "close_rate_swing": round(swing, 6) if compared else None,
            "verdict_disagreement_rate": (
                round(verdict_diff / compared, 6) if compared else None
            ),
            # The retrieval denominator is its OWN: a pair is only compared when both
            # cells reported a measured observation, so it is emitted beside the rate.
            "retrieval_compared": retrieval_compared,
            "retrieval_disagreement_rate": (
                round(retrieval_diff / retrieval_compared, 6)
                if retrieval_compared else None
            ),
        })
        compared_counts.append(compared)
        if compared:
            pooled_gross = max(pooled_gross, close_rate or 0.0)
            pooled_swing = max(pooled_swing, swing)
        else:
            measured = False
    any_compared = any(count > 0 for count in compared_counts)
    return {
        "measured": bool(measured),
        "repeat_pairs": max(0, repeats - 1),
        "per_arm": per_arm,
        # The smallest per-arm comparison count: the coverage the floor actually rests
        # on, which the arm comparison requires to be at least as large as its own n.
        "min_compared": min(compared_counts) if compared_counts else 0,
        # The MAXIMUM across arms, not the mean: a floor that under-states any arm's
        # own instability would let that instability be reported as a difference.
        "pooled_close_disagreement_rate": (
            round(pooled_gross, 6) if any_compared else None
        ),
        "pooled_close_rate_swing": round(pooled_swing, 6) if any_compared else None,
    }


def arm_summary(
    cells: list[CellRecord],
    arm_id: str,
    arm_models: dict[str, Any],
    *,
    arm_knobs: dict[str, Any] | None = None,
    paired_ids: list[str] | None = None,
) -> dict[str, Any]:
    """One arm's descriptive aggregates, with every denominator stated.

    ``close_eligible_rate`` is computed over the PAIRED fixture population, so with two
    arms it equals ``arm_comparison``'s ``rate_a``/``rate_b`` by construction and the
    two arms' rates are always over the same fixtures. The arm's own unpaired figure is
    kept as ``close_eligible_rate_unpaired`` and is explicitly named: differencing two
    unpaired rates can show an effect the paired table in the same report says is zero.

    ``scored`` pools every repeat while ``close_eligible`` counts repeat 0 only, so
    both bases are labelled and ``primary_scored`` — the actual denominator — is
    emitted rather than left to be inferred from ``scored / repeats`` (which is wrong
    whenever exclusion was asymmetric across repeats).
    """
    scored = [cell for cell in _scored(cells) if cell.arm_id == arm_id]
    primary = [cell for cell in scored if cell.repeat == 0]
    closed = sum(1 for cell in primary if cell.close_eligible)
    paired: list[CellRecord] | None = None
    if paired_ids is not None:
        wanted = set(paired_ids)
        paired = [cell for cell in primary if cell.fixture_id in wanted]
    closed_paired = (
        sum(1 for cell in paired if cell.close_eligible) if paired is not None else None
    )
    verdict_mix: dict[str, int] = {}
    tier_mix: dict[str, int] = {}
    for cell in scored:
        key = cell.verdict if cell.verdict is not None else "null"
        verdict_mix[key] = verdict_mix.get(key, 0) + 1
        tier = cell.processing_tier or "unconfirmed"
        tier_mix[tier] = tier_mix.get(tier, 0) + 1
    latencies = sorted(cell.latency_ms for cell in scored)
    return {
        "arm_id": arm_id,
        "models": arm_models,
        # The arm's effective non-default knobs, so a reader can see WHAT distinguished
        # this arm rather than inferring it from the arm id.
        "knobs": dict(arm_knobs or {}),
        "scored": len(scored),
        "pooled_basis": "all_repeats",
        "primary_scored": len(primary),
        "close_eligible_basis": "repeat_0",
        "close_eligible": closed,
        "close_eligible_rate_unpaired": (
            round(closed / len(primary), 6) if primary else None
        ),
        "n_primary_paired": len(paired) if paired is not None else None,
        "close_eligible_paired": closed_paired,
        "close_eligible_rate": (
            round(closed_paired / len(paired), 6)
            if paired and closed_paired is not None else None
        ),
        "verdict_mix": verdict_mix,
        "escalated": sum(1 for cell in scored if cell.decision.get("escalate")),
        "mean_confidence": round(
            sum(cell.confidence for cell in scored) / len(scored), 6
        ) if scored else None,
        "mean_risk_score": round(
            sum(cell.risk_score for cell in scored) / len(scored), 6
        ) if scored else None,
        "cost_usd": round(sum(cell.cost_usd for cell in scored), 6),
        "calls": sum(cell.calls for cell in scored),
        "tokens": sum(cell.tokens for cell in scored),
        "processing_tier_mix": tier_mix,
        "median_latency_ms": latencies[len(latencies) // 2] if latencies else 0,
    }


def arm_comparison(
    cells: list[CellRecord],
    arm_ids: list[str],
    floor: dict[str, Any],
    *,
    alpha: float,
    run_incomplete: bool,
) -> dict[str, Any]:
    """The paired arm-vs-arm result, or an explicit insufficient-evidence verdict.

    The inferential statistics are computed only AFTER every insufficiency gate has
    passed, so an ``insufficient_evidence`` result can never ship a rate, a difference
    or a p-value beside it. The raw counts ``a``/``b``/``c``/``d``/``n_pairs`` are
    observations and are always present, which is what keeps the other guarantee true:
    ``p_exact`` is never emitted without the discordant counts that give it meaning.

    The noise-floor guard compares like with like. ``rate_difference`` is a NET signed
    difference, so it is tested against the largest NET close-rate swing any arm shows
    against ITSELF (``pooled_close_rate_swing``), not against the gross per-fixture
    disagreement rate, which is a different quantity on a different scale. The gross
    between-arm discordance is reported separately.

    ``exceeds_noise_floor`` is the CONJUNCTION of two independent conditions, which are
    also reported separately: ``above_noise_floor`` (the floor comparison alone) and
    ``significant_at_alpha`` (the test alone). A difference that clears the floor on
    too few discordant pairs for ANY split to reach ``alpha`` is reported as
    ``underpowered`` — "add fixtures" — rather than as noise.
    """
    base: dict[str, Any] = {
        "basis": "repeat_0",
        "test": "mcnemar_exact_binomial",
        "alternative": "two_sided",
        "arm_a": arm_ids[0] if arm_ids else "",
        "arm_b": arm_ids[1] if len(arm_ids) > 1 else "",
        "n_pairs": 0, "a": 0, "b": 0, "c": 0, "d": 0,
        "rate_a": None, "rate_b": None, "rate_difference": None,
        "gross_discordance_rate": None,
        "p_exact": None,
        "mcnemar_chi2_corrected": None,
        "alpha": alpha,
        "noise_floor_basis": "net_close_rate_swing",
        "noise_floor_value": None,
        "noise_floor_coverage": None,
        "above_noise_floor": None,
        "significant_at_alpha": None,
        "exceeds_noise_floor": False,
        "verdict": "insufficient_evidence",
        "reason": "run_incomplete",
    }
    if len(arm_ids) < 2:
        base["reason"] = "single_arm"
        return base
    table = paired_table(cells, arm_ids[0], arm_ids[1])
    base.update(table)
    if not floor.get("measured"):
        base["reason"] = "noise_floor_not_measured"
        return base
    if table["n_pairs"] == 0:
        base["reason"] = "no_paired_fixtures"
        return base
    if run_incomplete:
        base["reason"] = "run_incomplete"
        return base
    min_compared = int(floor.get("min_compared", 0) or 0)
    base["noise_floor_coverage"] = round(min_compared / table["n_pairs"], 6)
    if min_compared < table["n_pairs"]:
        # A floor measured on fewer observations than the comparison it is gating is
        # not a floor. Derived from the run's own shape, never a tuned constant.
        base["reason"] = "noise_floor_undersampled"
        return base

    base["reason"] = ""
    base["p_exact"] = mcnemar_exact(table["b"], table["c"])
    base["mcnemar_chi2_corrected"] = mcnemar_chi2_corrected(table["b"], table["c"])
    base["rate_a"] = round((table["a"] + table["b"]) / table["n_pairs"], 6)
    base["rate_b"] = round((table["a"] + table["c"]) / table["n_pairs"], 6)
    base["rate_difference"] = round(base["rate_a"] - base["rate_b"], 6)
    base["gross_discordance_rate"] = round(
        (table["b"] + table["c"]) / table["n_pairs"], 6
    )

    net_floor = float(floor.get("pooled_close_rate_swing") or 0.0)
    gross_floor = float(floor.get("pooled_close_disagreement_rate") or 0.0)
    inclusive = False
    if gross_floor == 0.0 and min_compared > 0:
        # Zero observed self-disagreement is not evidence of a zero floor. Use the
        # one-sided zero-event upper limit at the run's OWN alpha, so no arbitrary
        # confidence level enters. At an ordinary alpha this is a no-op — reaching
        # significance already needs a larger difference than the limit.
        upper = 1.0 - alpha ** (1.0 / min_compared)
        if upper > net_floor:
            net_floor, inclusive = upper, True
    base["noise_floor_value"] = round(net_floor, 6)

    difference = abs(base["rate_difference"] or 0.0)
    above = difference >= net_floor if inclusive else difference > net_floor
    significant = base["p_exact"] < alpha
    base["above_noise_floor"] = bool(above)
    base["significant_at_alpha"] = bool(significant)
    base["exceeds_noise_floor"] = bool(above and significant)
    if table["b"] + table["c"] == 0:
        base["verdict"] = "no_discordant_pairs"
        return base
    # The smallest two-sided exact p attainable with b+c discordant pairs is
    # 2**(1-(b+c)); when that already exceeds alpha, NO arrangement of these pairs
    # could reach it, so the run is underpowered rather than null.
    testable = (2.0 ** (1 - (table["b"] + table["c"]))) < alpha
    if above and significant:
        base["verdict"] = "difference_exceeds_noise_floor"
    elif above and not testable:
        base["verdict"] = "underpowered"
        base["reason"] = "too_few_discordant_pairs"
    else:
        base["verdict"] = "indistinguishable_from_noise"
    return base
