"""Runbook matching: Applies when, selection and Why attached (Round 14 SPEC §4.10.4).

Pure and deterministic. :func:`match` takes a frozen :class:`CaseFacts` and the
catalog of matchable versions (every Published operator runbook and every built-in
not replaced by a Published operator copy; never a draft, an in-review or a retired
version, see :func:`matchable_catalog`) and returns the winner with a structured
explanation. It costs nothing (no model call, #6) and never reads or writes a store.

Semantics of ``applies_when`` (``app.models.AppliesWhen``):

* Every present criterion is any-of; every present criterion must match.
  ``rule_ids`` match a case rule value exactly; ``mitre`` matches a case technique,
  a parent technique (``T1110``) matching its sub-techniques (``T1110.003``) but not
  the reverse; ``entity_types`` the case's entity kinds; ``severity_at_least`` the
  case severity on the ladder info < low < medium < high < critical; ``sources`` a
  source id or ``type:<SourceType>``; ``verdicts`` and ``statuses`` the case's;
  ``any_tags`` a case tag (case-insensitive); ``min_event_count`` the event count.
* A fact the case cannot answer yet is PENDING, not failed: before an investigation
  a cluster has no verdict, status, analyst tags and usually no techniques
  (``CaseFacts`` carries ``None`` for them). Pending ``mitre``, ``any_tags``,
  ``severity_at_least`` and ``min_event_count`` are tolerated only behind a rule
  match: a runbook that names rules is chosen by its rules for the investigator's
  guidance, and those criteria are checked when the case is evaluated again after
  the verdict (D43), when every fact is known. A runbook with no rule match and a
  pending criterion does not match yet, so a technique-only runbook never matches
  every case on its entity type alone.
* A pending ``verdicts`` or ``statuses`` criterion always blocks, rule match or not.
  The verdict and the status are what the investigation and the case policy decide,
  so a runbook that applies only to an outcome (``verdicts: [FALSE_POSITIVE]``)
  never becomes the investigator's trusted guidance before that outcome exists: its
  text would steer the very verdict it is conditioned on (#3, #9). Such a runbook
  matches only in the evaluation after the verdict.
* Source types are configuration, never pending: a ``type:<SourceType>`` criterion
  matches only when the caller resolved the case's source ids to types
  (``source_types``); without them it fails (it is listed as missed, with the source
  ids the case has), so an operator's source condition is never silently skipped.
* ``always`` marks the fallback (Generic incident); it is the lowest tier and wins
  only when nothing else matched. A runbook with no criterion at all never matches
  automatically (it is attached by hand).

Selection: the highest tier (3 when ``rule_ids`` matched; 2 when ``mitre`` matched
and the runbook has no ``rule_ids``; 1 when only other criteria matched; 0 for the
fallback), then the highest ``priority``, then the most matched criteria, then the
newest ``published_at``, then the id ascending. A tie that survives to the id rule is
reported (``MatchExplanation.tie``, :attr:`MatchResult.tied`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, Mapping

from ..models import (
    SEVERITY_LEVELS,
    AppliesWhen,
    MatchedCriterion,
    MatchExplanation,
    MissedCriterion,
    RunbookDefinition,
)
from .priority import band_of_case
from .runbook_lookup import ENTITY_TYPE_TO_KIND

# --------------------------------------------------------------------------- #
# Case facts
# --------------------------------------------------------------------------- #
#: Values reported in an explanation are bounded so a stored ``attached_reason``
#: stays small whatever the case carries.
EXPLANATION_MAX_VALUES = 20
EXPLANATION_MAX_VALUE_CHARS = 256
_SEVERITY_RANK = {level: rank for rank, level in enumerate(SEVERITY_LEVELS)}
#: Runbook entity kinds a case entity type maps to (a rule-keyed case has none).
CASE_ENTITY_KINDS: dict[str, str] = dict(ENTITY_TYPE_TO_KIND)


@dataclass(frozen=True)
class CaseFacts:
    """What a case (or a cluster before it is investigated) says about itself.

    ``None`` means "not known yet" (pending): ``verdict``, ``status``, ``tags`` and
    ``mitre`` before an investigation, ``severity`` or ``event_count`` when nobody
    computed them. ``source_types`` is ``None`` when the caller did not resolve source
    ids to types; a ``type:`` criterion then fails rather than waits (the module
    docstring says why). An empty tuple means "known to be none"."""

    rule_values: tuple[str, ...] = ()
    entity_types: frozenset[str] = frozenset()
    severity: str | None = None
    source_ids: tuple[str, ...] = ()
    source_types: tuple[str, ...] | None = None
    verdict: str | None = None
    status: str | None = None
    tags: tuple[str, ...] | None = None
    event_count: int | None = None
    mitre: tuple[str, ...] | None = None


#: An ATT&CK technique or sub-technique id. ``Case.mitre`` is model output that log
#: content can steer, so a value outside this grammar is never matched, stored or
#: written into an explanation.
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")


def technique_id(value: Any) -> str | None:
    """``value`` as an upper-case technique id (``T1110``, ``T1110.003``), or ``None``
    when it is not one."""
    if not isinstance(value, str):
        return None
    text = value.strip().upper()
    return text if _TECHNIQUE_RE.match(text) else None


def _techniques(values: Iterable[Any]) -> tuple[str, ...]:
    """The well-formed technique ids among ``values``, upper case, first seen first."""
    return _dedup(technique_id(v) for v in values)


def _dedup(values: Iterable[Any]) -> tuple[str, ...]:
    out: list[str] = []
    for value in values:
        if isinstance(value, str):
            text = value.strip()
            if text and text not in out:
                out.append(text)
    return tuple(out)


def _enum_value(value: Any) -> str | None:
    raw = getattr(value, "value", value)
    return raw if isinstance(raw, str) and raw else None


def _source_types(source_ids: tuple[str, ...], mapping: Mapping[str, str] | None) -> tuple[str, ...] | None:
    if mapping is None:
        return None
    return _dedup(_enum_value(mapping.get(sid)) for sid in source_ids)


def case_event_count(case: Any) -> int | None:
    """How many events a stored case holds: its member list (``member_event_keys``,
    else ``member_event_ids``), which is what :func:`case_facts_from_cluster` counts
    (``Cluster.count``) for the same incident; else the trigger's ``observed_count``
    for a case stored without members; else ``None`` (unknown). The observed count is
    only the densest window of the primary rule, so it is never preferred over the
    members (the rule ``engine.threshold_tuner`` follows)."""
    members = getattr(case, "member_event_keys", None) or getattr(case, "member_event_ids", None) or []
    if members:
        return len(members)
    trigger = getattr(case, "trigger_reason", None)
    observed = getattr(trigger, "observed_count", 0) if trigger is not None else 0
    if isinstance(observed, int) and not isinstance(observed, bool) and observed > 0:
        return observed
    return None


def case_facts_from_case(
    case: Any,
    *,
    prefs: Any = None,
    severity: str | None = None,
    source_types: Mapping[str, str] | None = None,
) -> CaseFacts:
    """:class:`CaseFacts` for a stored :class:`app.models.Case` (the attachment path
    and the second evaluation after the verdict).

    Pass ``prefs``, the live :class:`app.config.Preferences`: the severity band is
    then derived on the case source's declared severity ladder by the one shared
    helper ``engine.priority.band_of_case(case, prefs)``. Without it the helper reads
    the source's severity on the 0 to 100 identity ladder, so a Wazuh level 12 on a
    declared 0 to 16 ladder would read "low" where the Console shows "critical".
    ``severity``, when given, is used as the band as it is. ``source_types`` maps a
    source id to its ``SourceType`` value; pass it whenever the catalog may hold a
    ``type:`` criterion, which fails without it. The techniques are known once the
    case has a verdict; before that an empty list is pending.

    The facts agree with :func:`case_facts_from_cluster` for the same incident: the
    event count is the member count (:func:`case_event_count`) and the sources are
    the case's own (``source_id``). ``source_breakdown`` is never read: the
    cross-source pass sets it to the sources of every case in the linked group (the
    same value on every member), so it says what other cases saw, not this one."""
    rule_values: list[Any] = list(getattr(case, "rule_ids", None) or [])
    trigger = getattr(case, "trigger_reason", None)
    if trigger is not None:
        rule_values += [getattr(trigger, "rule_value", ""), *(getattr(trigger, "rule_values", None) or [])]
    entity = getattr(case, "entity", None)
    kinds: set[str] = set()
    if entity is not None:
        kind = CASE_ENTITY_KINDS.get(_enum_value(getattr(entity, "type", None)) or "")
        if kind:
            kinds.add(kind)
    band = severity if severity in _SEVERITY_RANK else band_of_case(case, prefs)
    source_ids = _dedup([getattr(case, "source_id", None)])
    verdict = _enum_value(getattr(case, "verdict", None))
    mitre_values = _techniques(getattr(case, "mitre", None) or [])
    count = case_event_count(case)
    return CaseFacts(
        rule_values=_dedup(rule_values),
        entity_types=frozenset(kinds),
        severity=band if band in _SEVERITY_RANK else None,
        source_ids=source_ids,
        source_types=_source_types(source_ids, source_types),
        verdict=verdict,
        status=_enum_value(getattr(case, "status", None)),
        tags=_dedup(getattr(case, "tags", None) or []),
        event_count=count,
        mitre=mitre_values if (verdict is not None or mitre_values) else None,
    )


def case_facts_from_cluster(
    cluster: Any,
    *,
    severity: str | None = None,
    source_types: Mapping[str, str] | None = None,
    mitre: Iterable[str] | None = None,
) -> CaseFacts:
    """:class:`CaseFacts` for a correlated :class:`app.models.Cluster` before its
    investigation (the investigator guidance path). Verdict, status and tags are
    pending (a runbook conditioned on a verdict or a status never matches here);
    ``mitre`` is known only when the caller extracted techniques the source asserted
    on the cluster's events. Pass ``source_types`` as for
    :func:`case_facts_from_case`."""
    rule_values: list[Any] = list(getattr(cluster, "rule_values", None) or [])
    try:
        primary = cluster.primary_rule()
    except Exception:  # noqa: BLE001 - a malformed cluster has no primary rule
        primary = None
    if primary:
        rule_values.insert(0, primary)
    entity = getattr(cluster, "entity", None)
    kinds: set[str] = set()
    if entity is not None:
        kind = CASE_ENTITY_KINDS.get(_enum_value(getattr(entity, "type", None)) or "")
        if kind:
            kinds.add(kind)
    try:
        source_ids = _dedup(cluster.contributing_source_ids())
    except Exception:  # noqa: BLE001
        source_ids = _dedup([getattr(cluster, "source_id", None)])
    count = int(getattr(cluster, "count", 0) or 0) or len(getattr(cluster, "member_event_keys", None) or []) or None
    mitre_values = _techniques(mitre) if mitre is not None else ()
    return CaseFacts(
        rule_values=_dedup(rule_values),
        entity_types=frozenset(kinds),
        severity=severity if severity in _SEVERITY_RANK else None,
        source_ids=source_ids,
        source_types=_source_types(source_ids, source_types),
        verdict=None,
        status=None,
        tags=None,
        event_count=count,
        mitre=mitre_values or None,
    )


# --------------------------------------------------------------------------- #
# The catalog
# --------------------------------------------------------------------------- #
RunbookOrigin = Literal["builtin", "operator", "imported"]


@dataclass(frozen=True)
class MatchableRunbook:
    """One matchable version: a built-in, or the live (Published) version of an
    operator runbook. ``published_at`` is ISO-8601 (``None`` for a built-in, which
    then counts as the oldest on the published-at tie rule)."""

    id: str
    version: int
    definition: RunbookDefinition
    origin: RunbookOrigin = "builtin"
    published_at: str | None = None

    @property
    def title(self) -> str:
        return self.definition.title


def matchable_catalog(
    builtins: Iterable[MatchableRunbook],
    operator_published: Iterable[MatchableRunbook],
    *,
    replaced_builtin_ids: Iterable[str] = (),
) -> tuple[MatchableRunbook, ...]:
    """The catalog :func:`match` runs over: every Published operator runbook (the
    caller passes only live, non-retired versions) and every built-in that no
    Published operator copy replaces. A built-in id always wins an id collision (an
    operator document that shadowed a bundled id was never used, §4.10.17). Ordered
    built-ins first, then operator runbooks, each by id."""
    replaced = set(replaced_builtin_ids)
    out: dict[str, MatchableRunbook] = {}
    for item in sorted(builtins, key=lambda r: r.id):
        if item.id not in replaced and item.id not in out:
            out[item.id] = item
    for item in sorted(operator_published, key=lambda r: r.id):
        if item.id not in out:
            out[item.id] = item
    return tuple(out.values())


# --------------------------------------------------------------------------- #
# Evaluation
# --------------------------------------------------------------------------- #
_LIST_CRITERIA = ("rule_ids", "mitre", "entity_types", "sources", "verdicts", "statuses", "any_tags")
#: Criteria whose fact is the outcome of the investigation or the case policy: while
#: it is pending the runbook never matches, even behind a rule match (module
#: docstring).
OUTCOME_CRITERIA: frozenset[str] = frozenset({"verdicts", "statuses"})
#: The order criteria are evaluated and listed in an explanation.
CRITERIA_ORDER: tuple[str, ...] = (
    "rule_ids", "mitre", "entity_types", "severity_at_least", "sources", "verdicts", "statuses",
    "any_tags", "min_event_count", "always",
)


def _bounded(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        if len(out) >= EXPLANATION_MAX_VALUES:
            break
        text = str(value)
        out.append(text if len(text) <= EXPLANATION_MAX_VALUE_CHARS else text[:EXPLANATION_MAX_VALUE_CHARS])
    return out


def technique_matches(expected: str, actual: str) -> bool:
    """A runbook technique matches a case technique when they are equal or the
    runbook names the parent of the case's sub-technique (``T1110`` matches
    ``T1110.003``; ``T1110.003`` does not match ``T1110``). Both must be well-formed
    technique ids: anything else (``T1110.`` followed by free text) never matches."""
    want = technique_id(expected)
    have = technique_id(actual)
    if want is None or have is None:
        return False
    return have == want or ("." not in want and have.startswith(want + "."))


def present_criteria(aw: AppliesWhen) -> list[str]:
    """The criteria a runbook states, in :data:`CRITERIA_ORDER`."""
    out: list[str] = []
    for name in CRITERIA_ORDER:
        if name in _LIST_CRITERIA:
            if getattr(aw, name):
                out.append(name)
        elif name == "severity_at_least" and aw.severity_at_least is not None:
            out.append(name)
        elif name == "min_event_count" and aw.min_event_count is not None:
            out.append(name)
        elif name == "always" and aw.always:
            out.append(name)
    return out


@dataclass(frozen=True)
class Evaluation:
    """One runbook evaluated against one case. ``pending`` lists criteria whose fact
    is not known yet; ``matches`` is the rule of the module docstring; ``tier`` is
    ``None`` when it does not match. When it does not match, ``missed`` holds every
    failed criterion and then every pending one (``actual`` ``None``). When it
    matches with pending criteria (behind a rule match), they are in ``pending`` and
    in the explanation's ``missed`` with ``actual`` ``None`` ("not known yet"), so the
    Why attached text lists them too."""

    matched: tuple[MatchedCriterion, ...]
    missed: tuple[MissedCriterion, ...]
    pending: tuple[str, ...]
    matches: bool
    tier: int | None

    def explanation(self, *, tie: bool = False) -> MatchExplanation:
        return MatchExplanation(
            tier=self.tier if self.tier is not None else 0,
            matched=list(self.matched),
            missed=list(self.missed),
            tie=tie,
        )


def _check(name: str, aw: AppliesWhen, facts: CaseFacts) -> tuple[str, Any, Any]:
    """``("matched", value, None)``, ``("missed", expected, actual)`` or
    ``("pending", expected, None)`` for one present criterion."""
    if name == "rule_ids":
        wanted = [r.strip() for r in aw.rule_ids if r and r.strip()]
        hits = [r for r in facts.rule_values if r in wanted]
        if hits:
            return "matched", _bounded(hits), None
        return "missed", _bounded(wanted), _bounded(facts.rule_values)
    if name == "mitre":
        wanted = [t.strip().upper() for t in aw.mitre if t and t.strip()]
        if facts.mitre is None:
            return "pending", _bounded(wanted), None
        have = _techniques(facts.mitre)  # facts built by hand are held to the grammar too
        hits = [t for t in have if any(technique_matches(w, t) for w in wanted)]
        if hits:
            return "matched", _bounded(hits), None
        return "missed", _bounded(wanted), _bounded(have)
    if name == "entity_types":
        hits = [t for t in aw.entity_types if t in facts.entity_types]
        if hits:
            return "matched", _bounded(hits), None
        return "missed", list(aw.entity_types), sorted(facts.entity_types)
    if name == "severity_at_least":
        if facts.severity is None:
            return "pending", aw.severity_at_least, None
        if _SEVERITY_RANK.get(facts.severity, -1) >= _SEVERITY_RANK[aw.severity_at_least or "info"]:
            return "matched", facts.severity, None
        return "missed", aw.severity_at_least, facts.severity
    if name == "sources":
        wanted_ids = [s.strip() for s in aw.sources if s.strip() and not s.strip().startswith("type:")]
        wanted_types = [s.strip()[5:] for s in aw.sources if s.strip().startswith("type:")]
        hits = [s for s in facts.source_ids if s in wanted_ids]
        if facts.source_types:
            hits += [f"type:{t}" for t in facts.source_types if t in wanted_types]
        if hits:
            return "matched", _bounded(hits), None
        # Source types are configuration, never "not known yet": without them a
        # ``type:`` criterion fails closed (the module docstring).
        actual = list(facts.source_ids) + [f"type:{t}" for t in (facts.source_types or ())]
        return "missed", _bounded(aw.sources), _bounded(actual)
    if name == "verdicts":
        if facts.verdict is None:
            return "pending", list(aw.verdicts), None
        if facts.verdict in aw.verdicts:
            return "matched", facts.verdict, None
        return "missed", list(aw.verdicts), facts.verdict
    if name == "statuses":
        if facts.status is None:
            return "pending", _bounded(aw.statuses), None
        if facts.status in [s.strip() for s in aw.statuses]:
            return "matched", facts.status, None
        return "missed", _bounded(aw.statuses), facts.status
    if name == "any_tags":
        if facts.tags is None:
            return "pending", _bounded(aw.any_tags), None
        wanted = {t.strip().casefold() for t in aw.any_tags if t.strip()}
        hits = [t for t in facts.tags if t.casefold() in wanted]
        if hits:
            return "matched", _bounded(hits), None
        return "missed", _bounded(aw.any_tags), _bounded(facts.tags)
    if name == "min_event_count":
        if facts.event_count is None:
            return "pending", aw.min_event_count, None
        if facts.event_count >= int(aw.min_event_count or 0):
            return "matched", facts.event_count, None
        return "missed", aw.min_event_count, facts.event_count
    if name == "always":
        return "matched", None, None
    raise ValueError(f"unknown criterion {name}")  # pragma: no cover


def evaluate(facts: CaseFacts, definition: RunbookDefinition) -> Evaluation:
    """Evaluate one runbook's ``applies_when`` against ``facts`` (see the module
    docstring for the rule)."""
    aw = definition.applies_when
    names = present_criteria(aw)
    matched: list[MatchedCriterion] = []
    missed: list[MissedCriterion] = []
    pending: list[tuple[str, Any]] = []
    for name in names:
        state, a, b = _check(name, aw, facts)
        if state == "matched":
            matched.append(MatchedCriterion(criterion=name, value=a))
        elif state == "missed":
            missed.append(MissedCriterion(criterion=name, expected=a, actual=b))
        else:
            pending.append((name, a))
    matched_names = {m.criterion for m in matched}
    if aw.always:
        return Evaluation(tuple(matched), (), (), True, 0)
    if not names:
        return Evaluation((), (), (), False, None)
    rule_hit = "rule_ids" in matched_names
    waits_for_outcome = any(name in OUTCOME_CRITERIA for name, _ in pending)
    ok = not missed and bool(matched) and not waits_for_outcome and (not pending or rule_hit)
    # A pending criterion is reported as missed with no actual value ("not known
    # yet"): when it keeps the runbook from matching, and when the runbook matched on
    # its rules without it, so the explanation never hides a condition that was not
    # checked.
    missed += [MissedCriterion(criterion=name, expected=expected, actual=None)
               for name, expected in pending]
    tier: int | None = None
    if ok:
        if rule_hit:
            tier = 3
        elif "mitre" in matched_names and not aw.rule_ids:
            tier = 2
        else:
            tier = 1
    return Evaluation(tuple(matched), tuple(missed), tuple(name for name, _ in pending), ok, tier)


def near_misses(facts: CaseFacts, runbook: RunbookDefinition | MatchableRunbook) -> list[MissedCriterion]:
    """The criteria that keep ``runbook`` from matching ``facts`` (empty when it
    matches): every failed criterion and, when they block the match, the ones whose
    fact is not known yet (``actual`` ``None``). Used by the editor's match preview."""
    definition = runbook.definition if isinstance(runbook, MatchableRunbook) else runbook
    result = evaluate(facts, definition)
    return [] if result.matches else list(result.missed)


#: A near miss in the match preview: at least one criterion matched and exactly
#: this many failed.
NEAR_MISS_MAX_FAILED = 1


def is_near_miss(result: Evaluation) -> bool:
    """True when ``result`` did not match but came close: at least one criterion
    matched and exactly one failed (a fallback or an empty runbook never is)."""
    return (not result.matches and bool(result.matched)
            and 0 < len(result.missed) <= NEAR_MISS_MAX_FAILED)


# --------------------------------------------------------------------------- #
# Selection
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RankedCandidate:
    """A matching runbook with its explanation and rank key."""

    runbook: MatchableRunbook
    evaluation: Evaluation
    explanation: MatchExplanation

    @property
    def tier(self) -> int:
        return self.explanation.tier


@dataclass(frozen=True)
class MatchResult:
    """The winner (``None`` when nothing matched), its explanation, every matching
    candidate in rank order, and the ids that tied with the winner up to the id rule
    (the winner first; empty without a tie)."""

    winner: MatchableRunbook | None
    explanation: MatchExplanation | None
    candidates: tuple[RankedCandidate, ...] = field(default_factory=tuple)
    tied: tuple[str, ...] = ()


def _published_ts(value: str | None) -> float:
    if not value:
        return float("-inf")
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return float("-inf")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def _rank_key(item: MatchableRunbook, result: Evaluation) -> tuple[Any, ...]:
    return (
        -(result.tier if result.tier is not None else -1),
        -int(item.definition.priority),
        -len(result.matched),
        -_published_ts(item.published_at),
    )


def match(
    facts: CaseFacts,
    catalog: Iterable[MatchableRunbook],
    *,
    fallback: bool = True,
) -> MatchResult:
    """Choose the runbook for ``facts`` from ``catalog`` (see the module docstring).
    ``fallback=False`` (``runbooks.fallback`` off) leaves out every ``always``
    runbook. Pure and deterministic: the same facts and catalog always give the same
    result."""
    scored: list[tuple[tuple[Any, ...], MatchableRunbook, Evaluation]] = []
    for item in catalog:
        if not fallback and item.definition.applies_when.always:
            continue
        result = evaluate(facts, item.definition)
        if result.matches:
            scored.append((_rank_key(item, result), item, result))
    if not scored:
        return MatchResult(None, None, (), ())
    scored.sort(key=lambda entry: (entry[0], entry[1].id))
    top_key = scored[0][0]
    tied = tuple(entry[1].id for entry in scored if entry[0] == top_key)
    tie = len(tied) > 1
    candidates = tuple(
        RankedCandidate(item, result, result.explanation(tie=(tie and index == 0)))
        for index, (_key, item, result) in enumerate(scored)
    )
    winner = candidates[0]
    return MatchResult(winner.runbook, winner.explanation, candidates, tied if tie else ())


# --------------------------------------------------------------------------- #
# Plain words (audit rows, chat, the Why attached summary)
# --------------------------------------------------------------------------- #
_CRITERION_NOUNS: dict[str, tuple[str, str]] = {
    "rule_ids": ("rule", "rules"),
    "mitre": ("technique", "techniques"),
    "entity_types": ("entity type", "entity types"),
    "sources": ("source", "sources"),
    "any_tags": ("tag", "tags"),
}
_VERDICT_WORDS = {"TRUE_POSITIVE": "true positive", "FALSE_POSITIVE": "false positive",
                  "NEEDS_HUMAN": "needs a person"}


def _join(parts: list[str]) -> str:
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _criterion_words(item: MatchedCriterion) -> str:
    name, value = item.criterion, item.value
    if name in _CRITERION_NOUNS:
        values = [str(v) for v in (value if isinstance(value, list) else [value])]
        if name == "sources":
            values = [f"type {v[5:]}" if v.startswith("type:") else v for v in values]
        single, plural = _CRITERION_NOUNS[name]
        return f"{single if len(values) == 1 else plural} {_join(values)}"
    if name == "severity_at_least":
        return f"severity {value}"
    if name == "verdicts":
        return f"verdict {_VERDICT_WORDS.get(str(value), str(value))}"
    if name == "statuses":
        return f"status {str(value).replace('_', ' ')}"
    if name == "min_event_count":
        count = int(value) if isinstance(value, int) else 0
        return f"{count:,} events"
    return name


def describe_explanation(explanation: MatchExplanation | None, *, tied: int = 0) -> str:
    """One sentence for an explanation: "Matched rule ssh_auth_failed and technique
    T1110", "Fallback: no other runbook matched this case.", with the tie sentence
    appended when ``explanation.tie`` is set: "2 runbooks matched equally; the first
    by name was chosen." when ``tied`` gives the count (2 or more), else "More than
    one runbook matched equally; ..." (a stored explanation keeps no count)."""
    if explanation is None:
        return "No runbook matched this case."
    if explanation.tier == 0:
        text = "Fallback: no other runbook matched this case."
    else:
        parts = [_criterion_words(m) for m in explanation.matched]
        text = ("Matched " + _join(parts) + ".") if parts else "Matched."
    if explanation.tie:
        # A stored explanation keeps only ``tie``; the count is known only when the
        # caller still has the match result.
        text += (f" {tied:,} runbooks matched equally; the first by name was chosen." if tied >= 2
                 else " More than one runbook matched equally; the first by name was chosen.")
    return text


__all__ = [
    "CRITERIA_ORDER",
    "CaseFacts",
    "Evaluation",
    "MatchResult",
    "MatchableRunbook",
    "NEAR_MISS_MAX_FAILED",
    "RankedCandidate",
    "case_event_count",
    "case_facts_from_case",
    "case_facts_from_cluster",
    "describe_explanation",
    "evaluate",
    "is_near_miss",
    "match",
    "matchable_catalog",
    "near_misses",
    "present_criteria",
    "technique_id",
    "technique_matches",
]
