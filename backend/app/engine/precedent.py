"""Rule-identity precedent authority — the deterministic half of "we have seen this".

The precedent corpus answers "have we resolved something like this before?" with an
embedding search, and the investigator reads the result as prose. That is enough for a
rule whose alerts carry rich per-case evidence, and structurally useless for one whose
alerts do not: the model reasons about THIS instance, finds no payload/URI/response to
verify, and returns ``NEEDS_HUMAN`` no matter how many analyst-confirmed benign
outcomes sit behind it. Volume of precedent cannot fix an evidence-sufficiency
judgement, so an operator who confirms 349 cases changes nothing.

This module supplies the missing deterministic layer, in three pure pieces:

* **Rule identity** (:func:`rule_identity`) — the canonical, order-independent key for
  "the same detection". Precedent is matched on this, never on embedding similarity
  alone: a 1.00 cosine hit from a DIFFERENT rule must never qualify.
* **Precedent promotion** (:func:`evaluate_precedent_signal`) — turns "N analyst-
  confirmed outcomes exist for this exact rule identity" into a structured, code-
  computed fact the investigator is told explicitly. It is EVIDENCE PROMOTION, not a
  close authority: the verdict still comes from the model and
  ``engine.case_manager.decide()`` still applies the operator's policy (#3). Nothing in
  this module is imported by ``case_manager``, and nothing here reads it.
* **Analyst rule policy** (:func:`match_analyst_rule_policy`) — an operator's explicit,
  audited, revocable declaration that a detection is benign in THEIR estate. Matching
  clusters are closed deterministically with no LLM call at all, under a decision owner
  (:class:`~app.constants.DecisionBy.ANALYST_POLICY`) that is deliberately distinct from
  both ``agent`` and ``analyst`` so the close can never be mistaken for agent
  performance nor laundered back into independent analyst ground truth.

Plus two supporting tallies: :func:`stratified_selection` (so one bulk analyst action
cannot evict every other rule — or every other OUTCOME — from the bounded precedent
window; it round-robins over N caller-supplied axes and knows what none of them mean)
and :func:`evaluate_futility` (so a rule with abundant precedent that still routes to human
says so instead of silently absorbing more operator effort).

Everything here is pure, deterministic and side-effect free.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Iterable, Mapping, Sequence, TypeVar

from ..constants import CaseStatus, DecisionBy, TERMINAL_CASE_STATUSES, Verdict

if TYPE_CHECKING:  # pragma: no cover — typing only
    from ..config import (
        AnalystRulePolicy,
        PrecedentFutilityConfig,
        PrecedentPromotionConfig,
    )
    from ..models import Case, Cluster, RagChunk

T = TypeVar("T")

# The joiner between the normalised rule ids of one identity. Chosen to match the
# tuner's existing recurrence key format (``entity|rules|outcome``) so the repository
# has exactly ONE rule-set spelling.
RULE_IDENTITY_SEPARATOR = "|"

# Metadata keys the precedent projection writes so rule identity is a first-class,
# matchable fact rather than a substring of the chunk text.
RULE_IDENTITY_KEY = "rule_identity"
RULE_IDS_KEY = "rule_ids"

# The precedent trust tier that may be promoted. The lower-trust ``model_unconfirmed``
# tier is the agent's OWN unreviewed output; promoting it would let a bad streak ratify
# itself, which is the exact compounding failure the tier was built to avoid.
PROMOTABLE_TRUST_CLASS = "analyst_confirmed"

# The confirmed outcome that a benign declaration is about.
OUTCOME_FALSE_POSITIVE = "false_positive"
OUTCOME_TRUE_POSITIVE = "true_positive"

_TERMINAL = frozenset(
    getattr(status, "value", status) for status in TERMINAL_CASE_STATUSES
)


def normalize_rule_id(value: Any) -> str:
    """Canonical rule key.

    Deliberately byte-identical to ``engine.threshold_tuner.normalize_rule_id`` so a
    rule means the same thing to the tuner, to precedent matching and to an operator
    policy. Duplicated rather than imported to keep this module free of the tuner's
    dependency graph; ``tests/test_precedent_authority.py`` asserts the two agree.
    """
    return str(value or "").strip()


def rule_identity(rule_ids: Iterable[Any]) -> str:
    """The canonical identity of a DETECTION SET.

    Sorted + de-duplicated + normalised, so ``["b", "a"]`` and ``["a", "b", "a"]`` are
    the same detection and ``["a"]`` is NOT the same detection as ``["a", "b"]``. An
    empty/blank set yields ``""`` — which never matches anything, by design: a cluster
    with no rule identity has nothing to be precedent-matched against.
    """
    normalised = sorted({normalize_rule_id(raw) for raw in (rule_ids or []) if normalize_rule_id(raw)})
    return RULE_IDENTITY_SEPARATOR.join(normalised)


def rule_identity_members(identity: str) -> tuple[str, ...]:
    """Split a rule identity back into its member rule ids."""
    return tuple(part for part in str(identity or "").split(RULE_IDENTITY_SEPARATOR) if part)


def cluster_rule_identity(cluster: "Cluster") -> str:
    """Rule identity of a correlated cluster (``rule_values`` is the cluster spelling)."""
    return rule_identity(getattr(cluster, "rule_values", None) or [])


def case_rule_identity(case: "Case") -> str:
    """Rule identity of a case (``rule_ids`` is the case spelling)."""
    return rule_identity(getattr(case, "rule_ids", None) or [])


# --------------------------------------------------------------------------- #
# Per-rule precedent distribution
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RulePrecedentCounts:
    """Analyst-confirmed precedent held for ONE rule identity."""

    rule_identity: str
    false_positive: int = 0
    true_positive: int = 0

    @property
    def total(self) -> int:
        return self.false_positive + self.true_positive

    @property
    def unanimous_false_positive(self) -> bool:
        return self.false_positive > 0 and self.true_positive == 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule_identity": self.rule_identity,
            "rule_ids": list(rule_identity_members(self.rule_identity)),
            "false_positive": self.false_positive,
            "true_positive": self.true_positive,
            "total": self.total,
            "unanimous_false_positive": self.unanimous_false_positive,
        }


@dataclass(frozen=True)
class PrecedentDistribution:
    """How analyst-confirmed precedent is spread across rule identities.

    ``available`` is False only when the corpus could not be read at all — an empty
    distribution from a healthy corpus is a real zero and the two are never conflated.
    ``unattributed`` counts confirmed precedent written BEFORE rule identity became
    projection metadata: it is reachable by retrieval but cannot be rule-matched, so it
    is reported separately instead of silently counting as either presence or absence.
    """

    available: bool = False
    reason: str = ""
    truncated: bool = False
    #: True when the operator has TURNED THE PRECEDENT SOURCE OFF. That is a configured
    #: state, not an unmeasurable one, and conflating the two puts a permanent "could not
    #: be evaluated" entry on the diagnostics surface of a correctly-configured
    #: deployment.
    disabled: bool = False
    scanned: int = 0
    unattributed: int = 0
    by_rule: Mapping[str, RulePrecedentCounts] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.by_rule is None:
            object.__setattr__(self, "by_rule", {})

    def counts_for(self, identity: str) -> RulePrecedentCounts | None:
        return self.by_rule.get(identity) if identity else None

    @property
    def total_confirmed(self) -> int:
        return sum(counts.total for counts in self.by_rule.values())

    def as_dict(self, *, limit: int = 50) -> dict[str, Any]:
        rows = sorted(
            (counts.as_dict() for counts in self.by_rule.values()),
            key=lambda row: (-int(row["total"]), str(row["rule_identity"])),
        )
        return {
            "available": self.available,
            "reason": self.reason,
            "truncated": self.truncated,
            "disabled": self.disabled,
            "scanned_chunks": self.scanned,
            "rule_identities": len(self.by_rule),
            "unattributed_documents": self.unattributed,
            "total_confirmed": self.total_confirmed,
            "returned": min(len(rows), max(0, limit)),
            "by_rule": rows[: max(0, limit)],
        }


def distribution_from_metadata(
    rows: Iterable[Mapping[str, Any]], *, truncated: bool = False, scanned: int | None = None
) -> PrecedentDistribution:
    """Build a distribution from precedent chunk METADATA rows.

    Each row is one stored precedent chunk's metadata. Only the analyst-confirmed tier
    is counted: the lower-trust ``model_unconfirmed`` tier shares the corpus source, and
    counting it here would let the agent's own auto-closes look like operator evidence.
    """
    buckets: dict[str, list[int]] = {}
    unattributed = 0
    seen = 0
    for row in rows:
        seen += 1
        if str(row.get("trust_class") or PROMOTABLE_TRUST_CLASS) != PROMOTABLE_TRUST_CLASS:
            continue
        outcome = str(row.get("outcome") or "")
        if outcome not in (OUTCOME_FALSE_POSITIVE, OUTCOME_TRUE_POSITIVE):
            continue
        identity = str(row.get(RULE_IDENTITY_KEY) or "")
        if not identity:
            unattributed += 1
            continue
        slot = buckets.setdefault(identity, [0, 0])
        if outcome == OUTCOME_FALSE_POSITIVE:
            slot[0] += 1
        else:
            slot[1] += 1
    return PrecedentDistribution(
        available=True,
        reason="",
        truncated=bool(truncated),
        scanned=int(scanned if scanned is not None else seen),
        unattributed=unattributed,
        by_rule={
            identity: RulePrecedentCounts(
                rule_identity=identity, false_positive=fp, true_positive=tp
            )
            for identity, (fp, tp) in buckets.items()
        },
    )


def unavailable_distribution(reason: str) -> PrecedentDistribution:
    """An explicitly UNKNOWN distribution — never a zero that reads like a real one."""
    return PrecedentDistribution(available=False, reason=str(reason or "unknown"), by_rule={})


def disabled_distribution(reason: str) -> PrecedentDistribution:
    """The operator turned the precedent source OFF. Configured, not unmeasurable."""
    return PrecedentDistribution(
        available=False, disabled=True, reason=str(reason or "disabled"), by_rule={}
    )


# --------------------------------------------------------------------------- #
# Precedent promotion
# --------------------------------------------------------------------------- #
#: ``qualified``      — promotion is on, the bar is cleared, the signal may be injected.
#: ``insufficient``   — measurable, but below the operator's confirmed-count bar.
#: ``conflicting``    — the rule's analyst history is NOT unanimous; never promote.
#: ``not_retrieved``  — the corpus holds the precedent but this run did not retrieve it.
#: ``unavailable``    — the distribution could not be measured; say so, never assume 0.
#: ``disabled``       — the operator has not enabled promotion.
#: ``not_applicable`` — the cluster carries no rule identity to match on.
PRECEDENT_STATUSES = (
    "qualified",
    "insufficient",
    "conflicting",
    "not_retrieved",
    "unavailable",
    "disabled",
    "not_applicable",
)


@dataclass(frozen=True)
class PrecedentSignal:
    """The deterministic per-case precedent fact, and why it did or did not qualify."""

    status: str = "disabled"
    reason: str = ""
    rule_identity: str = ""
    confirmed_false_positive: int = 0
    confirmed_true_positive: int = 0
    retrieved_matching: int = 0
    top_score: float | None = None
    min_confirmed: int = 0
    min_similarity: float = 0.0
    truncated: bool = False

    @property
    def qualifies(self) -> bool:
        return self.status == "qualified"

    @property
    def rule_ids(self) -> tuple[str, ...]:
        return rule_identity_members(self.rule_identity)

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "qualifies": self.qualifies,
            "rule_identity": self.rule_identity,
            "rule_ids": list(self.rule_ids),
            "confirmed_false_positive": self.confirmed_false_positive,
            "confirmed_true_positive": self.confirmed_true_positive,
            "retrieved_matching": self.retrieved_matching,
            "top_score": self.top_score,
            "min_confirmed": self.min_confirmed,
            "min_similarity": self.min_similarity,
            "truncated": self.truncated,
        }


def _chunk_matches_rule(chunk: "RagChunk", identity: str) -> bool:
    metadata = getattr(chunk, "metadata", None) or {}
    if str(metadata.get("trust_class") or PROMOTABLE_TRUST_CLASS) != PROMOTABLE_TRUST_CLASS:
        return False
    if str(metadata.get("outcome") or "") != OUTCOME_FALSE_POSITIVE:
        return False
    return str(metadata.get(RULE_IDENTITY_KEY) or "") == identity


def evaluate_precedent_signal(
    *,
    rule_ids: Iterable[Any],
    rag_chunks: Sequence["RagChunk"] | None,
    distribution: PrecedentDistribution | None,
    config: "PrecedentPromotionConfig",
) -> PrecedentSignal:
    """Decide whether this case's rule identity carries promotable analyst precedent.

    Pure. The gates, in order, and why each exists:

    1. **Enabled** — promotion is an explicit operator opt-in.
    2. **Rule identity present** — nothing to match on otherwise.
    3. **Distribution measurable** — an unreadable corpus is ``unavailable``, never a
       confidently-zero ``insufficient``.
    4. **Unanimity** — a rule whose analyst history contains ANY confirmed true positive
       is not "benign in this estate"; it is a rule the analysts disagree about.
    5. **Count bar** — at least ``min_confirmed`` analyst-confirmed FALSE POSITIVE
       outcomes for this exact identity.
    6. **Actually retrieved** — at least one same-identity confirmed-benign precedent
       was retrieved for THIS case above ``min_similarity``. This proves the corpus
       entry is reachable rather than merely counted, and keeps the signal anchored to
       evidence the model can also read.

    Note on ``min_similarity``: ``RagChunk.score`` is the retrieval RANK score (a
    min-max-normalised blend of vector similarity and BM25 when hybrid retrieval is on,
    and a backend-specific similarity when it is off). It is comparable within one
    retrieval, not across backends or queries — which is exactly why RULE IDENTITY, not
    similarity, is the authoritative gate here. ``min_similarity`` is only a secondary
    relevance floor.
    """
    identity = rule_identity(rule_ids)
    min_confirmed = max(1, int(getattr(config, "min_confirmed", 1) or 1))
    min_similarity = float(getattr(config, "min_similarity", 0.0) or 0.0)
    max_conflicting = max(0, int(getattr(config, "max_conflicting", 0) or 0))
    base = {
        "rule_identity": identity,
        "min_confirmed": min_confirmed,
        "min_similarity": min_similarity,
    }

    if not bool(getattr(config, "enabled", False)):
        return PrecedentSignal(
            status="disabled",
            reason="analyst-confirmed precedent promotion is turned off for this deployment",
            **base,
        )
    if not identity:
        return PrecedentSignal(
            status="not_applicable",
            reason="this cluster carries no detection-rule identity to match precedent against",
            **base,
        )
    if distribution is None or not distribution.available:
        return PrecedentSignal(
            status="unavailable",
            reason=(
                (distribution.reason if distribution is not None else "")
                or "the precedent corpus could not be read, so its per-rule counts are unknown"
            ),
            truncated=bool(distribution.truncated) if distribution is not None else False,
            **base,
        )

    counts = distribution.counts_for(identity) or RulePrecedentCounts(rule_identity=identity)
    tally = {
        "confirmed_false_positive": counts.false_positive,
        "confirmed_true_positive": counts.true_positive,
        "truncated": distribution.truncated,
    }

    if distribution.truncated:
        # A truncated read yields LOWER BOUNDS. A lower-bound benign count is safe to
        # compare upward against ``min_confirmed``, but a lower-bound MALICIOUS count can
        # never establish unanimity: "no confirmed true positive was seen" is not "no
        # confirmed true positive exists". Promoting here would tell the investigator a
        # rule is unanimously benign on evidence that could not be fully read.
        return PrecedentSignal(
            status="unavailable",
            reason=(
                "the precedent corpus read was truncated, so this rule's confirmed "
                "history is a lower bound and its unanimity cannot be established"
            ),
            **base,
            **tally,
        )

    if counts.true_positive > max_conflicting:
        return PrecedentSignal(
            status="conflicting",
            reason=(
                f"this rule identity holds {counts.true_positive} analyst-confirmed TRUE "
                f"POSITIVE outcome(s); its analyst history is not unanimously benign"
            ),
            **base,
            **tally,
        )
    if counts.false_positive < min_confirmed:
        return PrecedentSignal(
            status="insufficient",
            reason=(
                f"{counts.false_positive} analyst-confirmed benign precedent(s) for this rule "
                f"identity; {min_confirmed} are required"
                + (
                    " (the corpus read was truncated, so this is a lower bound)"
                    if distribution.truncated
                    else ""
                )
            ),
            **base,
            **tally,
        )

    matching = [chunk for chunk in (rag_chunks or []) if _chunk_matches_rule(chunk, identity)]
    top_score = max((float(getattr(c, "score", 0.0) or 0.0) for c in matching), default=None)
    if not matching or top_score is None or top_score < min_similarity:
        return PrecedentSignal(
            status="not_retrieved",
            reason=(
                "no analyst-confirmed benign precedent for this exact rule identity was "
                f"retrieved for this case above the {min_similarity} relevance floor"
                + (f" (best retrieved: {round(top_score, 4)})" if top_score is not None else "")
            ),
            retrieved_matching=len(matching),
            top_score=top_score,
            **base,
            **tally,
        )

    return PrecedentSignal(
        status="qualified",
        reason=(
            f"{counts.false_positive} analyst-confirmed benign outcome(s) and "
            f"{counts.true_positive} analyst-confirmed malicious outcome(s) for this exact "
            f"rule identity, with {len(matching)} retrieved for this case"
        ),
        retrieved_matching=len(matching),
        top_score=top_score,
        **base,
        **tally,
    )


# --------------------------------------------------------------------------- #
# Analyst rule policy (deterministic close, no LLM)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class AnalystPolicyMatch:
    """The operator declaration that covers every rule on a cluster."""

    policy_ids: tuple[str, ...]
    rule_ids: tuple[str, ...]
    reasons: tuple[str, ...]

    @property
    def summary(self) -> str:
        rules = ", ".join(self.rule_ids) or "n/a"
        return f"operator analyst policy covers rule(s) {rules}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "policy_ids": list(self.policy_ids),
            "rule_ids": list(self.rule_ids),
            "reasons": list(self.reasons),
        }


def match_analyst_rule_policy(
    *,
    rule_ids: Iterable[Any],
    source_id: str | None,
    policies: Iterable["AnalystRulePolicy"] | None,
    risk_score: float | None = None,
    now: datetime | None = None,
) -> AnalystPolicyMatch | None:
    """The live operator declaration covering this cluster, or ``None``.

    EVERY rule on the cluster must be covered, mirroring
    ``engine.cost_gate.passes_suppression``'s "only when every member is suppressed"
    discipline: a cluster that also fired an un-declared detection is NOT the thing the
    operator declared benign, and must still be investigated. A cluster with no rule
    identity never matches.

    ``risk_score`` is the cluster's deterministic risk. A declaration carrying an
    optional ``max_risk_score`` does not cover a cluster above that ceiling, so the
    outlier is investigated normally instead of being closed unseen.
    """
    wanted = [normalize_rule_id(raw) for raw in (rule_ids or [])]
    wanted = sorted({rid for rid in wanted if rid})
    if not wanted:
        return None
    reference = now or datetime.now(timezone.utc)
    scope = str(source_id or "")
    covered: dict[str, tuple[str, str]] = {}
    for policy in policies or []:
        if not policy.is_live(reference):
            continue
        policy_scope = str(getattr(policy, "source_id", "") or "")
        if policy_scope and policy_scope != scope:
            continue
        # Optional per-declaration risk ceiling. ``decide()`` bounds FALSE_POSITIVE
        # auto-close with ``max_risk_score``; a declaration had no equivalent, so a
        # declared rule closed at ANY computed risk. An operator can now say "benign
        # here, but not if it scores unusually high" and have the outlier investigated.
        ceiling = getattr(policy, "max_risk_score", None)
        if ceiling is not None and risk_score is not None and float(risk_score) > float(ceiling):
            continue
        target = normalize_rule_id(getattr(policy, "rule_id", ""))
        if not target or target not in wanted or target in covered:
            continue
        covered[target] = (
            str(getattr(policy, "id", "") or ""),
            str(getattr(policy, "reason", "") or ""),
        )
    if len(covered) != len(wanted):
        return None
    ordered = [covered[rid] for rid in wanted]
    return AnalystPolicyMatch(
        policy_ids=tuple(pid for pid, _reason in ordered),
        rule_ids=tuple(wanted),
        reasons=tuple(reason for _pid, reason in ordered),
    )


# --------------------------------------------------------------------------- #
# Precedent-window stratification
# --------------------------------------------------------------------------- #
def _round_robin_rank(
    items: list[T], axes: Sequence[Callable[[T], str]]
) -> list[T]:
    """Rank ``items`` by NESTED round-robin over ``axes`` (a full reordering).

    Every input item appears in the output exactly once — this ranks, it never drops.
    The first axis partitions the whole input and its groups are interleaved one item
    per pass; each group is then ranked by the REMAINING axes before the interleave, so
    axis 2 shares out the slots axis 1 already gave to one of its groups.

    An axis whose values are ALL IDENTICAL over the items it is handed carries no
    information, so it is SKIPPED and the next axis decides. That is what makes a
    single-group deployment degrade to the caller's plain input order rather than to a
    single-bucket no-op that still walks the interleave.

    Groups are visited in first-appearance order and input order is preserved inside a
    group, so a deterministic input gives a deterministic output.
    """
    if not axes:
        return items
    groups: dict[str, list[T]] = {}
    for item in items:
        groups.setdefault(str(axes[0](item)), []).append(item)
    if len(groups) <= 1:
        return _round_robin_rank(items, axes[1:])
    ranked = [_round_robin_rank(bucket, axes[1:]) for bucket in groups.values()]
    out: list[T] = []
    depth = 0
    deepest = max(len(bucket) for bucket in ranked)
    while depth < deepest:
        for bucket in ranked:
            if depth < len(bucket):
                out.append(bucket[depth])
        depth += 1
    return out


def stratified_selection(
    items: Sequence[T],
    key: Callable[[T], str] | Sequence[Callable[[T], str]],
    limit: int,
    *,
    transaction_key: Callable[[T], str] | None = None,
    max_per_transaction: int | None = None,
) -> list[T]:
    """Round-robin ``limit`` items across the distinct groups of one or MORE axes.

    A flat newest-N window means any BULK analyst action on one rule can evict every
    other rule from the precedent corpus — the precedent-starvation outage in a new
    form, triggered by an operator doing exactly what the product asked of them. Taking
    one item per group per pass gives every active group an equal floor and degrades to
    the plain newest-N order when there is only one group.

    Stratifying on rule identity alone is not enough, because the newest-first tiebreak
    INSIDE each rule's bucket has the same shape one level down: the slots fill with
    whatever outcome the deployment currently produces most of. ``key`` therefore
    accepts either ONE callable (the shipped contract, unchanged) or an ORDERED
    SEQUENCE of them, applied as a nested round-robin — outermost axis first.

    This function never learns what an axis MEANS. It is handed callables, counts their
    distinct values, and knows only how many it was given; the vocabulary lives with the
    caller (§ vendor agnosticism).

    ``max_per_transaction`` is a SOFT, DEFERRED admission cap, not a pre-filter. An item
    whose transaction group is already at the cap is moved to the BACK of the ranking
    rather than dropped, so the caller still receives ``limit`` items whenever ``limit``
    items exist — one bulk action can no longer buy the whole window, and a deployment
    whose ONLY material is that one bulk action loses nothing (with a single transaction
    group the deferral is provably a no-op: the admitted prefix and the deferred tail
    concatenate back to the same order). ``None`` or a non-positive cap means no cap.

    Contract preserved byte-for-byte for the shipped single-axis call: with one callable
    and no keyword arguments, an input whose axis has at most one distinct value returns
    ``list(items)[:limit]``, so cold start is provably unchanged.
    """
    if limit <= 0:
        return []
    axes: tuple[Callable[[T], str], ...] = (
        (key,) if callable(key) else tuple(key)  # type: ignore[arg-type]
    )
    ranked = _round_robin_rank(list(items), axes)
    if (
        transaction_key is not None
        and max_per_transaction is not None
        and max_per_transaction > 0
    ):
        taken: dict[str, int] = {}
        admitted: list[T] = []
        deferred: list[T] = []
        for item in ranked:
            group = str(transaction_key(item))
            count = taken.get(group, 0)
            if count < max_per_transaction:
                taken[group] = count + 1
                admitted.append(item)
            else:
                deferred.append(item)
        ranked = admitted + deferred
    return ranked[:limit]


# --------------------------------------------------------------------------- #
# Futility — "more confirmations will not change this"
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RuleOutcomeTally:
    """Observed case outcomes for one rule identity in the diagnostics window."""

    rule_identity: str
    total: int = 0
    routed_to_human: int = 0
    auto_closed: int = 0
    analyst_closed: int = 0
    policy_closed: int = 0
    #: Cases that never reached a decision at all — an un-investigated candidate, or one
    #: still in flight. They had no opportunity to auto-close, so including them would
    #: manufacture a low auto-close rate out of work that has not happened yet.
    undecided: int = 0

    @property
    def measurable(self) -> int:
        """Cases the agent COULD have decided.

        Excludes policy closes (they never reached the agent, so counting them would make
        a declaration look like an agent failure) and undecided cases (no decision was
        due yet).
        """
        return max(0, self.total - self.policy_closed - self.undecided)

    @property
    def human_involved(self) -> int:
        """Cases a human had to look at — routed to one, or closed by one."""
        return self.routed_to_human + self.analyst_closed

    @property
    def auto_close_rate(self) -> float | None:
        return round(self.auto_closed / self.measurable, 4) if self.measurable else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule_identity": self.rule_identity,
            "rule_ids": list(rule_identity_members(self.rule_identity)),
            "cases": self.total,
            "measurable_cases": self.measurable,
            "undecided": self.undecided,
            "routed_to_human": self.routed_to_human,
            "auto_closed": self.auto_closed,
            "analyst_closed": self.analyst_closed,
            "human_involved": self.human_involved,
            "policy_closed": self.policy_closed,
            "auto_close_rate": self.auto_close_rate,
        }


def _decision_value(case: "Case") -> str:
    return str(getattr(case.decision_by, "value", case.decision_by) or "")


def _status_value(case: "Case") -> str:
    return str(getattr(case.status, "value", case.status) or "")


def is_policy_closed(case: "Case") -> bool:
    """True when this case was closed by an operator's analyst rule policy.

    The single predicate every statistics consumer uses, so "exclude the deterministic
    policy close" is one decision made once rather than eleven independent string
    comparisons that can drift apart.

    It reads the DURABLE ``analyst_policy`` payload as well as ``decision_by``, because
    ``decision_by`` alone is erasable. Any analyst lifecycle action stamps
    ``decision_by = ANALYST``, and ``_guard_transition`` permits a same-status move — so
    ``confirm_fp`` on an already-CLOSED policy case (including in bulk) silently
    overwrote the marker. Every exclusion keyed on it stopped applying at once, and one
    declaration became N independent analyst labels for the threshold tuner. The payload
    is written only by the policy close and cleared by any writer that supersedes it (an
    investigation, a fail-to-human, a candidate rebuild), so it means exactly "this case
    is currently closed by declaration".
    """
    return (
        _decision_value(case) == DecisionBy.ANALYST_POLICY.value
        or getattr(case, "analyst_policy", None) is not None
    )


def rule_outcome_tally(cases: Iterable["Case"]) -> dict[str, RuleOutcomeTally]:
    """Per-rule-identity observed outcomes. Pure tally — nothing here decides anything."""
    raw: dict[str, list[int]] = {}
    for case in cases or []:
        identity = case_rule_identity(case)
        if not identity:
            continue
        slot = raw.setdefault(identity, [0, 0, 0, 0, 0, 0])
        slot[0] += 1
        decided_by = _decision_value(case)
        status = _status_value(case)
        terminal = status in _TERMINAL
        verdict = getattr(case, "verdict", None)
        if decided_by == DecisionBy.ANALYST_POLICY.value:
            slot[4] += 1
        elif terminal and decided_by == DecisionBy.AGENT.value:
            slot[2] += 1
        elif terminal and decided_by == DecisionBy.ANALYST.value:
            slot[3] += 1
        elif (
            verdict == Verdict.NEEDS_HUMAN
            or status == CaseStatus.NEEDS_HUMAN.value
            or (not terminal and verdict is not None)
        ):
            slot[1] += 1
        else:
            # No verdict, not terminal, not policy-closed: an un-investigated candidate
            # or a case still in flight. No decision was due, so it belongs in neither
            # the numerator nor the denominator of an auto-close rate.
            slot[5] += 1
    return {
        identity: RuleOutcomeTally(
            rule_identity=identity,
            total=slot[0],
            routed_to_human=slot[1],
            auto_closed=slot[2],
            analyst_closed=slot[3],
            policy_closed=slot[4],
            undecided=slot[5],
        )
        for identity, slot in raw.items()
    }


def evaluate_futility(
    *,
    distribution: PrecedentDistribution | None,
    tallies: Mapping[str, RuleOutcomeTally],
    config: "PrecedentFutilityConfig",
    promotion_enabled: bool = False,
) -> list[dict[str, Any]]:
    """Rules whose precedent is abundant but is NOT changing the outcome.

    The product tells the operator that analyst-confirmed outcomes are how the agent
    learns, and the tuner actively asks for more of them. When a rule already holds
    plenty and its cases still route to a human, asking for more is asking the operator
    to spend review time on something that cannot work. Say so, with the two remedies
    that CAN work: enrich the source so the alerts carry verifiable per-case evidence,
    or declare the rule benign with an analyst rule policy.

    Returns one row per futile rule, most-precedent first. Empty when nothing qualifies
    or when the distribution could not be measured (never a fabricated finding).
    """
    if not bool(getattr(config, "enabled", True)):
        return []
    if distribution is None or not distribution.available:
        return []
    min_confirmed = max(1, int(getattr(config, "min_confirmed", 1) or 1))
    min_cases = max(1, int(getattr(config, "min_recent_cases", 1) or 1))
    max_rate = float(getattr(config, "max_auto_close_rate", 0.0) or 0.0)

    rows: list[dict[str, Any]] = []
    for identity, counts in distribution.by_rule.items():
        if counts.false_positive < min_confirmed or not counts.unanimous_false_positive:
            continue
        tally = tallies.get(identity)
        if tally is None or tally.measurable < min_cases:
            continue
        rate = tally.auto_close_rate
        # ``human_involved``, not ``routed_to_human``: a rule whose cases an analyst
        # eventually CLOSES still consumed human review, and that is exactly the estate
        # this report exists for — an operator diligently working (and confirming) a
        # rule the agent never resolves. Gating on "still waiting for a human" would go
        # silent for the very scenario that produced this report.
        if rate is None or rate > max_rate or tally.human_involved <= 0:
            continue
        rules = ", ".join(rule_identity_members(identity)) or identity
        rows.append(
            {
                **tally.as_dict(),
                "analyst_confirmed_benign": counts.false_positive,
                "analyst_confirmed_malicious": counts.true_positive,
                "detail": (
                    f"This rule has {counts.false_positive} analyst-confirmed benign "
                    f"precedent(s) but {tally.human_involved} of its last "
                    f"{tally.measurable} decided case(s) still needed a human "
                    f"(auto-close rate {rate}). Confirming more cases of this rule will "
                    "not change that on its own."
                ),
                "remediation": (
                    "Enrich the source so these alerts carry the per-case evidence an "
                    "investigation needs, apply an analyst rule policy to close them "
                    "deterministically, or"
                    + (
                        " lower the promotion bar for this deployment."
                        if promotion_enabled
                        else " enable analyst-confirmed precedent promotion."
                    )
                ),
                "rules": rules,
            }
        )
    rows.sort(key=lambda row: (-int(row["analyst_confirmed_benign"]), str(row["rule_identity"])))
    return rows
