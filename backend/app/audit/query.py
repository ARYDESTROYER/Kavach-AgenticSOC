"""The audit read filters as one predicate, compiled for every store (SPEC §4.5.5).

``GET /api/audit``, ``GET /api/audit/count`` and the audit export all ask the same
question of three different stores (Elasticsearch, SQL and, for a third-party
repository, a Python scan). The filters are first normalised into
:class:`AuditFilters`, then turned into a small predicate tree
(:func:`build_predicate`) whose leaves have one meaning:

* ``Eq(field, value)`` and ``In(field, values)``: the field is present and equals;
* ``Present(field)``: the field is present (not absent, not null);
* ``Prefix(field, prefix)``: present and starts with ``prefix`` (case-sensitive);
* ``Contains(field, text)``: present and contains ``text``, case-insensitive;
* ``TsRange(gte, lte)``: the row time is within the inclusive bounds.

``And``, ``Or`` and ``Not`` combine them. Every leaf is two-valued (never "unknown"),
so ``Not`` means the same thing in Elasticsearch, in SQL and in Python.

Every structured filter (the exact, prefix, time, category, scope, outcome and actor
kind filters) returns the same rows on every store. Free-text ``Contains`` differs in
two documented ways, so the stores agree exactly only on ASCII text and whole words:

* **Case folding.** The Python reference and SQLite fold ASCII letters only;
  PostgreSQL and Elasticsearch fold Unicode letters too (``É`` finds ``é`` there).
* **Analysed summaries on Elasticsearch.** ``result_summary``,
  ``tool_output_summary`` and ``prompt_excerpt`` are analysed text there, so a search
  matches whole words and phrases, and a partial word only within one word (``deni``
  finds "denied"; ``gin fail`` does not find "login failed", which SQL and the
  reference do find; punctuation between words is ignored, so ``login, failed`` finds
  "login failed" there only). The keyword fields (actor, action, target id and label,
  query text) match any substring on every store.

The offline parity test runs the fake Elasticsearch, whose phrase match is a plain
substring, so it proves the predicate and its compilation, not the analyser.

This module compiles the tree to an Elasticsearch query (:func:`to_es_query`) and
evaluates it in Python (:func:`matches`); the SQL compiler lives beside the SQL
repository (``stores/sql/repositories.py``). The legacy derivations of
:mod:`app.audit.events` (outcome, actor kind, category) compile into the same tree, so
a filter on a derived value returns exactly the rows the page labels with it.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence, Union

from ..utils import dotted_get, parse_es_timestamp
from . import events
from .events import TABLE, EventTable, ascii_lower


# --------------------------------------------------------------------------- #
# The predicate tree
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Eq:
    field: str
    value: str


@dataclass(frozen=True)
class In:
    field: str
    values: tuple[str, ...]


@dataclass(frozen=True)
class Present:
    field: str


@dataclass(frozen=True)
class Prefix:
    field: str
    prefix: str


@dataclass(frozen=True)
class Contains:
    field: str
    text: str


@dataclass(frozen=True)
class TsRange:
    gte: datetime | None = None
    lte: datetime | None = None


@dataclass(frozen=True)
class And:
    items: tuple["Predicate", ...]


@dataclass(frozen=True)
class Or:
    items: tuple["Predicate", ...]


@dataclass(frozen=True)
class Not:
    item: "Predicate"


Predicate = Union[Eq, In, Present, Prefix, Contains, TsRange, And, Or, Not]
TRUE: Predicate = And(())
FALSE: Predicate = Or(())


def all_of(*items: Predicate) -> Predicate:
    flat = [i for i in items if i != TRUE]
    if any(i == FALSE for i in flat):
        return FALSE
    return flat[0] if len(flat) == 1 else And(tuple(flat))


def any_of(*items: Predicate) -> Predicate:
    flat = [i for i in items if i != FALSE]
    if any(i == TRUE for i in flat):
        return TRUE
    return flat[0] if len(flat) == 1 else Or(tuple(flat))


def missing(name: str) -> Predicate:
    return Not(Present(name))


# --------------------------------------------------------------------------- #
# Fields: where each lives, and how Elasticsearch maps it
# --------------------------------------------------------------------------- #
#: Keyword fields mapped since the first release (a plain ``term`` is exact).
LEGACY_KEYWORD_FIELDS = frozenset({
    "action_type", "surface", "actor", "case_id", "source_id", "model", "tool_name",
    "app_version", "build_sha",
})
#: Round 14 fields. On an index created before Round 14 they map dynamically (text
#: with a ``.keyword`` sub-field) until the write index rolls over, so an exact match
#: is compiled for both mappings (see :func:`_es_dual`).
NEW_KEYWORD_FIELDS = frozenset({
    "outcome", "actor_type", "action", "actor_role", "session_ref", "request_id", "run_id",
    "target.type", "target.id", "client.ip", "client.ip_source",
})
#: Analysed text fields (searched with ``match_phrase`` plus a single-term wildcard,
#: so Elasticsearch matches words and phrases there; see the module docstring).
TEXT_FIELDS = frozenset({"result_summary", "tool_output_summary", "prompt_excerpt", "query_text"})
#: Fields searched by ``q`` (SPEC §4.5.5: event name, actor, target label and the four
#: summary fields; the event name also through its friendly label, below).
SEARCH_FIELDS: tuple[str, ...] = (
    "actor", "action", "action_type", "target.label",
    "result_summary", "tool_output_summary", "query_text", "prompt_excerpt",
)


# --------------------------------------------------------------------------- #
# Normalised filters
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class AuditFilters:
    """The read API's filters after validation. ``scope`` ``None`` means all rows.

    ``action_type`` is the legacy ``action`` query parameter (unchanged meaning);
    ``event`` is the structured action, a category id, or an event family (a bare
    token: rows whose ``action`` starts with ``<token>.`` or legacy rows whose
    ``action_type`` is the token)."""

    scope: str | None = None
    q: str | None = None
    action_type: str | None = None
    event: str | None = None
    actor: str | None = None
    actor_contains: str | None = None
    actor_kind: str | None = None
    outcome: str | None = None
    surface: str | None = None
    case_id: str | None = None
    source_id: str | None = None
    target: str | None = None
    ip: str | None = None
    ts_from: datetime | None = None
    ts_to: datetime | None = None
    # The raw time tokens as the caller sent them ("now-7d"), so a coalescing or
    # cursor binding key is stable while the resolved instants move with the clock.
    from_token: str | None = field(default=None, compare=False)
    to_token: str | None = field(default=None, compare=False)

    def binding(self) -> dict[str, Any]:
        """The filter set as plain data with the raw time tokens, for the cursor
        binding and the view-coalescing key (absent values dropped)."""
        out: dict[str, Any] = {}
        for f in fields(self):
            if f.name in ("ts_from", "ts_to"):
                continue
            value = getattr(self, f.name)
            if value not in (None, ""):
                out[f.name] = value
        return out

    def binding_hash(self) -> str:
        raw = json.dumps(self.binding(), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def with_scope(self, scope: str | None) -> "AuditFilters":
        from dataclasses import replace

        return replace(self, scope=scope)


# --------------------------------------------------------------------------- #
# Building the predicate
# --------------------------------------------------------------------------- #
def _legacy_entry_predicate(entry: events.LegacyEvent, table: EventTable) -> Predicate:
    """The rows one legacy ``(action_type, surface)`` entry names (a search by its
    friendly name). Category reads use :func:`_legacy_categories_predicate`."""
    parts: list[Predicate] = [missing("action"), Eq("action_type", entry.action_type)]
    if entry.surface == events.STAR:
        specific = table.specific_surfaces.get(entry.action_type)
        if specific:
            parts.append(Not(In("surface", specific)))
    else:
        parts.append(Eq("surface", entry.surface))
    return all_of(*parts)


def _legacy_categories_predicate(categories: frozenset[str], table: EventTable) -> Predicate:
    """Rows without ``action`` whose legacy ``(action_type, surface)`` category is one
    of ``categories`` (mirrors :func:`app.audit.events.classify`).

    Compiled per action type, not per fixture entry: one ``In`` for every action type
    all of whose rows are in, and a small branch for each action type whose specific
    surfaces split it, so the tree stays a handful of nodes on every store."""
    whole: list[str] = []
    split: list[Predicate] = []
    for action_type in table.known_action_types:
        star_in = table.legacy_by_key[(action_type, events.STAR)].category in categories
        specific = table.specific_surfaces.get(action_type, ())
        # The specific surfaces whose category differs from the '*' entry's side.
        flipped = tuple(
            surface for surface in specific
            if (table.legacy_by_key[(action_type, surface)].category in categories) != star_in
        )
        if star_in and not flipped:
            whole.append(action_type)
        elif star_in:
            split.append(all_of(Eq("action_type", action_type), Not(In("surface", flipped))))
        elif flipped:
            split.append(all_of(Eq("action_type", action_type), In("surface", flipped)))
    parts: list[Predicate] = []
    if whole:
        parts.append(In("action_type", tuple(sorted(whole))))
    parts.extend(split)
    if "system" in categories:
        # An unknown action type is System with its token shown, never hidden.
        parts.append(Not(In("action_type", table.known_action_types)))
    return all_of(missing("action"), any_of(*parts))


def _action_categories_predicate(categories: frozenset[str], table: EventTable) -> Predicate:
    """Rows with ``action`` whose category is one of ``categories``: an exact entry
    wins, then the action's prefix entry, otherwise System."""
    exact_in = tuple(sorted(e.action for e in table.actions if e.category in categories))
    exact_out = tuple(sorted(e.action for e in table.actions if e.category not in categories))
    prefixes_in = [p.prefix for p in table.prefixes if p.category in categories]
    parts: list[Predicate] = []
    if exact_in:
        parts.append(In("action", exact_in))
    if prefixes_in:
        prefixed = any_of(*(Prefix("action", f"{p}.") for p in prefixes_in))
        parts.append(all_of(prefixed, Not(In("action", exact_out))) if exact_out else prefixed)
    if "system" in categories:
        known_prefix = any_of(*(Prefix("action", f"{p.prefix}.") for p in table.prefixes))
        all_exact = tuple(sorted(table.action_by_name))
        parts.append(all_of(Not(known_prefix), Not(In("action", all_exact))))
    return all_of(Present("action"), any_of(*parts))


def categories_predicate(categories: "frozenset[str] | tuple[str, ...]", table: EventTable = TABLE) -> Predicate:
    """Rows whose category (:func:`app.audit.events.classify`) is one of
    ``categories``: by ``action`` for rows that carry it, else by the legacy
    ``(action_type, surface)`` key."""
    wanted = frozenset(categories)
    return any_of(
        _action_categories_predicate(wanted, table),
        _legacy_categories_predicate(wanted, table),
    )


def category_predicate(category: str, table: EventTable = TABLE) -> Predicate:
    """Rows of one category. Mirrors :func:`app.audit.events.classify`."""
    return categories_predicate(frozenset({category}), table)


def scope_predicate(scope: str | None, table: EventTable = TABLE) -> Predicate:
    """People and settings, Agent activity (its complement) or every row.

    People and settings is the union of the rows a person or a service made (by the
    recorded ``actor_type``) and every Access, Configuration or Case work row, whoever
    made it; Agent activity is exactly the Agent pipeline and System rows no person
    made. So an agent's ``run.attached`` or a system's ``runbook.migrated`` is People
    and settings, and a row keeps its scope across the Round 14 upgrade (a legacy row
    and its new-shape successor land in the same scope)."""
    if scope in (None, "all"):
        return TRUE
    people = any_of(
        In("actor_type", events.PEOPLE_ACTOR_TYPES),
        categories_predicate(events.PEOPLE_CATEGORIES, table),
    )
    if scope == "people":
        return people
    if scope == "agent":
        return Not(people)
    raise ValueError(f"unknown audit scope {scope!r}")


def event_predicate(event: str, table: EventTable = TABLE) -> Predicate:
    if event in table.category_labels:
        return category_predicate(event, table)
    if "." in event:
        return Eq("action", event)
    return any_of(
        Prefix("action", f"{event}."),
        all_of(missing("action"), Eq("action_type", event)),
    )


def outcome_predicate(outcome: str) -> Predicate:
    """A recorded outcome, or the legacy derivation of
    :func:`app.audit.events.derive_outcome` (SPEC §4.5.3).

    ``unknown`` is the filter for the page's "Not recorded": a row that recorded
    ``unknown`` (an audit-first write whose request was cancelled) and every row that
    recorded no outcome and derives none (so not ``access_denied`` or ``error``), the
    same rows the Outcome column labels "Not recorded"."""
    stored = Eq("outcome", outcome)
    derived_from = tuple(sorted(
        action_type for action_type, value in events.DERIVED_OUTCOMES.items() if value == outcome
    ))
    if outcome == "unknown":
        deriving = tuple(sorted(events.DERIVED_OUTCOMES))
        return any_of(stored, all_of(missing("outcome"), Not(In("action_type", deriving))))
    if not derived_from:
        return stored
    return any_of(stored, all_of(missing("outcome"), In("action_type", derived_from)))


def actor_kind_predicate(kind: str, table: EventTable = TABLE) -> Predicate:
    """A recorded actor kind, or the legacy derivation of
    :func:`app.audit.events.derive_actor_type`."""
    stored = Eq("actor_type", kind)
    if kind == "agent":
        derived: Predicate = In("actor", table.agent_actors)
    elif kind == "system":
        derived = In("actor", table.system_actors)
    elif kind == "human":
        named = tuple(sorted({*table.agent_actors, *table.system_actors, ""}))
        derived = all_of(
            Present("actor"),
            Not(In("actor", named)),
            categories_predicate(events.PEOPLE_CATEGORIES, table),
        )
    else:
        return stored
    return any_of(stored, all_of(missing("actor_type"), derived))


def _derived_label_predicates(needle: str, table: EventTable) -> list[Predicate]:
    """The rows whose name the page derives from an ``action_prefixes`` entry
    ("Runbook" + "publish failed" for ``runbook.publish_failed``) and contains
    ``needle`` (already ASCII-lowered).

    A derived name is ``<prefix label> <verb with spaces>``, so ``needle`` is found in
    it when it lies inside the prefix label (every action of the prefix), or when it is
    the end of the prefix label, a space, then the start of the verb (the actions whose
    verb starts that way). A needle wholly inside the verb is found by the ``action``
    token search itself (:func:`search_predicate`). Actions with an exact entry show
    that entry's name instead, so they are left to :func:`app.audit.events.
    matching_event_keys`."""
    out: list[Predicate] = []
    for entry in table.prefixes:
        label = ascii_lower(entry.label)
        heads: set[str] = set()
        if needle in label:
            heads.add(f"{entry.prefix}.")
        for index, char in enumerate(needle):
            if char != " ":
                continue
            head, tail = needle[:index], needle[index + 1:]
            if head and tail and label.endswith(head):
                heads.add(f"{entry.prefix}.{tail.replace(' ', '_')}")
        if not heads:
            continue
        exact = tuple(sorted(a for a in table.action_by_name if a.startswith(f"{entry.prefix}.")))
        derived = any_of(*(Prefix("action", head) for head in sorted(heads)))
        out.append(all_of(derived, Not(In("action", exact))) if exact else derived)
    return out


def search_predicate(text: str, table: EventTable = TABLE) -> Predicate:
    """``q``: a substring of any searched field, or of the event name the page shows.

    The event name is found three ways: an exact or legacy entry's name
    (:func:`app.audit.events.matching_event_keys`), a name derived from an action
    prefix (:func:`_derived_label_predicates`), and the ``action`` token with the
    spaces of ``q`` read as underscores ("publish failed" finds
    ``runbook.publish_failed``)."""
    by_field = [Contains(name, text) for name in SEARCH_FIELDS]
    needle = ascii_lower(text)
    if " " in needle:
        by_field.append(Contains("action", needle.replace(" ", "_")))
    actions, legacy = events.matching_event_keys(text, table)
    by_label: list[Predicate] = []
    if actions:
        by_label.append(In("action", tuple(sorted(actions))))
    by_label.extend(_legacy_entry_predicate(entry, table) for entry in legacy)
    by_label.extend(_derived_label_predicates(needle, table))
    return any_of(*by_field, *by_label)


def build_predicate(filters: AuditFilters, table: EventTable = TABLE) -> Predicate:
    parts: list[Predicate] = [scope_predicate(filters.scope, table)]
    if filters.ts_from is not None or filters.ts_to is not None:
        parts.append(TsRange(filters.ts_from, filters.ts_to))
    if filters.action_type:
        parts.append(Eq("action_type", filters.action_type))
    if filters.event:
        parts.append(event_predicate(filters.event, table))
    if filters.actor:
        parts.append(Eq("actor", filters.actor))
    if filters.actor_contains:
        parts.append(Contains("actor", filters.actor_contains))
    if filters.actor_kind:
        parts.append(actor_kind_predicate(filters.actor_kind, table))
    if filters.outcome:
        parts.append(outcome_predicate(filters.outcome))
    if filters.surface:
        parts.append(Eq("surface", filters.surface))
    if filters.case_id:
        parts.append(Eq("case_id", filters.case_id))
    if filters.source_id:
        parts.append(Eq("source_id", filters.source_id))
    if filters.target:
        parts.append(Eq("target.id", filters.target))
    if filters.ip:
        parts.append(Eq("client.ip", filters.ip))
    if filters.q:
        parts.append(search_predicate(filters.q, table))
    return all_of(*parts)


# --------------------------------------------------------------------------- #
# Python evaluation (the reference semantics; used by the generic fallback)
# --------------------------------------------------------------------------- #
def _value(doc: Mapping[str, Any], name: str) -> str | None:
    value = dotted_get(doc, name) if isinstance(doc, Mapping) else None
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return value if isinstance(value, str) else (
        json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else str(value)
    )


def _ts(doc: Mapping[str, Any]) -> datetime | None:
    return parse_es_timestamp(doc.get("ts")) if isinstance(doc, Mapping) else None


def matches(pred: Predicate, doc: Mapping[str, Any]) -> bool:
    """Evaluate ``pred`` against one stored row."""
    if isinstance(pred, And):
        return all(matches(item, doc) for item in pred.items)
    if isinstance(pred, Or):
        return any(matches(item, doc) for item in pred.items)
    if isinstance(pred, Not):
        return not matches(pred.item, doc)
    if isinstance(pred, Present):
        return _value(doc, pred.field) is not None
    if isinstance(pred, Eq):
        return _value(doc, pred.field) == pred.value
    if isinstance(pred, In):
        return _value(doc, pred.field) in pred.values
    if isinstance(pred, Prefix):
        value = _value(doc, pred.field)
        return value is not None and value.startswith(pred.prefix)
    if isinstance(pred, Contains):
        value = _value(doc, pred.field)
        return value is not None and ascii_lower(pred.text) in ascii_lower(value)
    if isinstance(pred, TsRange):
        when = _ts(doc)
        if when is None:
            return False
        if pred.gte is not None and when < pred.gte:
            return False
        if pred.lte is not None and when > pred.lte:
            return False
        return True
    raise TypeError(f"not an audit predicate: {pred!r}")


# --------------------------------------------------------------------------- #
# Elasticsearch
# --------------------------------------------------------------------------- #
MATCH_ALL: dict[str, Any] = {"match_all": {}}
MATCH_NONE: dict[str, Any] = {"bool": {"must_not": [{"match_all": {}}]}}


def _es_dual(name: str, clause_for: Any) -> dict[str, Any]:
    """A clause that holds whether ``name`` is mapped as a keyword (the Round 14
    template) or dynamically as text with a ``.keyword`` sub-field (an audit index
    created before Round 14 and not yet rolled over).

    ``<name>.keyword`` exists only under the dynamic mapping, so it is used when it is
    there; otherwise ``<name>`` itself is a keyword (or ``ip``) field and is used as
    is. The guard keeps an analysed text field from matching one token of a longer
    value (``case`` must not match ``case-000123``)."""
    keyword = f"{name}.keyword"
    return {
        "bool": {
            "should": [
                clause_for(keyword),
                {"bool": {"filter": [clause_for(name)], "must_not": [{"exists": {"field": keyword}}]}},
            ],
            "minimum_should_match": 1,
        }
    }


def _es_exact(name: str, clause_for: Any) -> dict[str, Any]:
    return _es_dual(name, clause_for) if name in NEW_KEYWORD_FIELDS else clause_for(name)


def _wildcard_value(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("*", "\\*").replace("?", "\\?")
    return f"*{escaped}*"


def _wildcard(name: str, text: str) -> dict[str, Any]:
    return {"wildcard": {name: {"value": _wildcard_value(text), "case_insensitive": True}}}


def _es_contains(name: str, text: str) -> dict[str, Any]:
    if name in LEGACY_KEYWORD_FIELDS:
        return _wildcard(name, text)
    if name in NEW_KEYWORD_FIELDS:
        # A substring needs no exactness guard: both mappings hold the whole value.
        return {"bool": {"should": [_wildcard(name, text), _wildcard(f"{name}.keyword", text)],
                         "minimum_should_match": 1}}
    clauses: list[dict[str, Any]] = [{"match_phrase": {name: {"query": text}}}]
    if not any(ch.isspace() for ch in text):
        # One analysed token: a partial word ("deni" in "denied") is found too.
        clauses.append(_wildcard(name, ascii_lower(text)))
    if name in ("query_text", "target.label"):
        clauses.append(_wildcard(f"{name}.keyword", text))
    return {"bool": {"should": clauses, "minimum_should_match": 1}}


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def to_es_query(pred: Predicate) -> dict[str, Any]:
    if isinstance(pred, And):
        if not pred.items:
            return dict(MATCH_ALL)
        return {"bool": {"filter": [to_es_query(i) for i in pred.items]}}
    if isinstance(pred, Or):
        if not pred.items:
            return {"bool": {"must_not": [{"match_all": {}}]}}
        names = {i.field for i in pred.items if isinstance(i, Prefix)}
        if len(names) == 1 and all(isinstance(i, Prefix) for i in pred.items):
            # Prefixes of one field (a category's action prefixes): one clause under one
            # mapping guard, the same rows as a guard per prefix.
            prefixes = [i.prefix for i in pred.items]  # type: ignore[union-attr]
            return _es_exact(names.pop(), lambda name: {"bool": {
                "should": [{"prefix": {name: prefix}} for prefix in prefixes],
                "minimum_should_match": 1,
            }})
        return {"bool": {"should": [to_es_query(i) for i in pred.items], "minimum_should_match": 1}}
    if isinstance(pred, Not):
        return {"bool": {"must_not": [to_es_query(pred.item)]}}
    if isinstance(pred, Present):
        return {"exists": {"field": pred.field}}
    if isinstance(pred, Eq):
        return _es_exact(pred.field, lambda name: {"term": {name: pred.value}})
    if isinstance(pred, In):
        if not pred.values:
            return {"bool": {"must_not": [{"match_all": {}}]}}
        return _es_exact(pred.field, lambda name: {"terms": {name: list(pred.values)}})
    if isinstance(pred, Prefix):
        return _es_exact(pred.field, lambda name: {"prefix": {name: pred.prefix}})
    if isinstance(pred, Contains):
        return _es_contains(pred.field, pred.text)
    if isinstance(pred, TsRange):
        bounds: dict[str, str] = {}
        if pred.gte is not None:
            bounds["gte"] = _iso(pred.gte)
        if pred.lte is not None:
            bounds["lte"] = _iso(pred.lte)
        return {"range": {"ts": bounds}} if bounds else dict(MATCH_ALL)
    raise TypeError(f"not an audit predicate: {pred!r}")


def run_ids_filter(run_ids: Sequence[str]) -> Predicate:
    return In("run_id", tuple(sorted(set(run_ids))))
