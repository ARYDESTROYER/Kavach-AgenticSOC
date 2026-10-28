"""Audit event categories, friendly names and legacy derivations (Round 14 SPEC §4.5.5).

The single table lives in ``event_categories.json`` next to this module. The Console
reads the same file through a contract test (``webui/src/soc/components/audit/
events.ts``), so the backend and the page can never disagree about which category a
row belongs to or what it is called.

Two keys categorise a row:

* a row that carries the structured ``action`` (``auth.login``) is categorised by it:
  an exact ``actions`` entry wins, then its ``action_prefixes`` entry, otherwise the
  row is System and its token is shown;
* a row without ``action`` (every row written before Round 14, and new rows whose
  writer sets none, such as agent pipeline telemetry) is categorised by the pair
  ``(action_type, surface)``: a specific surface wins over ``*``, and an unknown
  ``action_type`` is System with its token shown, never hidden.

Scope membership is a partition (SPEC §4.5.5): **People and settings** is every row
whose actor is a person or a service acting for one, plus every row in the Access and
identity, Configuration and data or Case work categories; **Agent activity** is every
other row (so, the Agent pipeline and System categories, less the rows a person made).
``all`` is the union.

Legacy rows carry no ``outcome`` or ``actor_type``. Readers derive ``denied`` for
``access_denied`` and ``failure`` for ``error`` (otherwise "not recorded"), and an
actor kind from the known actor lists, and mark both as derived. The same derivations
compile into store queries (:mod:`app.audit.query`), so a filter on a derived value
returns exactly the rows the page labels with it.

This module is pure: it reads one bundled JSON file at import and has no I/O after.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from ..models import AUDIT_ACTOR_TYPES, AUDIT_CATEGORIES, AUDIT_TEXT_WRITE_CAP

FIXTURE_PATH = Path(__file__).with_name("event_categories.json")

#: The categories whose rows belong to People and settings (SPEC §4.5.5).
PEOPLE_CATEGORIES: tuple[str, ...] = ("access", "config", "case_work")
#: The categories whose rows belong to Agent activity when no person made them.
AGENT_CATEGORIES: tuple[str, ...] = ("agent", "system")
#: Actor kinds that put a row in People and settings whatever its category.
PEOPLE_ACTOR_TYPES: tuple[str, ...] = ("human", "service")
#: The free-text fields the write path caps (``truncate(..., 1000)`` appends "…").
TRUNCATABLE_FIELDS: tuple[str, ...] = ("prompt_excerpt", "tool_output_summary", "result_summary")
#: A bare event token (no dot) that names a category rather than an event family.
STAR = "*"
#: The outcome a legacy row without one reads, by its ``action_type`` (SPEC §4.5.3);
#: every other such row reads "Not recorded" (the ``unknown`` filter value).
DERIVED_OUTCOMES: Mapping[str, str] = {"access_denied": "denied", "error": "failure"}


@dataclass(frozen=True)
class EventInfo:
    """How the audit log shows one row: its category id and its friendly name."""

    category: str
    label: str


@dataclass(frozen=True)
class LegacyEvent:
    action_type: str
    surface: str
    category: str
    label: str


@dataclass(frozen=True)
class ActionEntry:
    action: str
    category: str
    label: str


@dataclass(frozen=True)
class PrefixEntry:
    prefix: str
    category: str
    label: str


@dataclass(frozen=True)
class EventTable:
    """The parsed fixture. Every lookup the read path needs is precomputed here."""

    version: int
    category_labels: Mapping[str, str]
    legacy: tuple[LegacyEvent, ...]
    prefixes: tuple[PrefixEntry, ...]
    actions: tuple[ActionEntry, ...]
    agent_actors: tuple[str, ...]
    system_actors: tuple[str, ...]
    actor_labels: Mapping[str, str]

    # Derived indexes (built in ``load_event_table``).
    legacy_by_key: Mapping[tuple[str, str], LegacyEvent]
    action_by_name: Mapping[str, ActionEntry]
    prefix_by_name: Mapping[str, PrefixEntry]
    specific_surfaces: Mapping[str, tuple[str, ...]]

    def legacy_event(self, action_type: str, surface: str) -> LegacyEvent | None:
        return self.legacy_by_key.get((action_type, surface)) or self.legacy_by_key.get(
            (action_type, STAR)
        )

    @property
    def known_action_types(self) -> tuple[str, ...]:
        return tuple(sorted({entry.action_type for entry in self.legacy}))


class EventTableError(ValueError):
    """The bundled fixture is malformed. Raised at import: a broken table must fail the
    boot loudly rather than mislabel or hide audit rows."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise EventTableError(message)


def _text(value: Any, what: str) -> str:
    _require(isinstance(value, str) and value.strip() == value and bool(value), f"{what} must be text")
    return value


def _label(value: Any, what: str) -> str:
    text = _text(value, what)
    _require("\u2014" not in text and "\u2013" not in text, f"{what} must not contain a dash")
    _require(text[:1].isupper() or text[:1].isdigit(), f"{what} must start in sentence case")
    return text


def load_event_table(raw: Mapping[str, Any]) -> EventTable:
    """Validate and index one fixture document (exposed for the contract tests)."""
    _require(isinstance(raw, Mapping), "the fixture must be an object")
    version = raw.get("version")
    _require(isinstance(version, int) and version >= 1, "version must be a positive integer")

    categories = raw.get("categories")
    _require(isinstance(categories, list), "categories must be a list")
    labels: dict[str, str] = {}
    for item in categories:
        cid = _text(item.get("id"), "category id")
        _require(cid in AUDIT_CATEGORIES, f"unknown category id {cid!r}")
        _require(cid not in labels, f"duplicate category {cid!r}")
        scope = item.get("scope")
        _require(
            scope == ("people" if cid in PEOPLE_CATEGORIES else "agent"),
            f"category {cid!r} names the wrong scope",
        )
        labels[cid] = _label(item.get("label"), f"category {cid!r} label")
    _require(set(labels) == set(AUDIT_CATEGORIES), "every category must be listed once")

    legacy: list[LegacyEvent] = []
    by_key: dict[tuple[str, str], LegacyEvent] = {}
    for item in raw.get("legacy_events") or []:
        entry = LegacyEvent(
            action_type=_text(item.get("action_type"), "legacy action_type"),
            surface=_text(item.get("surface"), "legacy surface"),
            category=_text(item.get("category"), "legacy category"),
            label=_label(item.get("label"), "legacy label"),
        )
        _require(entry.category in labels, f"unknown category {entry.category!r}")
        key = (entry.action_type, entry.surface)
        _require(key not in by_key, f"duplicate legacy key {key!r}")
        by_key[key] = entry
        legacy.append(entry)
    specific: dict[str, list[str]] = {}
    for at, surface in by_key:
        if surface != STAR:
            _require((at, STAR) in by_key, f"legacy key {(at, surface)!r} has no '*' entry")
            specific.setdefault(at, []).append(surface)

    prefixes: list[PrefixEntry] = []
    by_prefix: dict[str, PrefixEntry] = {}
    for item in raw.get("action_prefixes") or []:
        entry = PrefixEntry(
            prefix=_text(item.get("prefix"), "action prefix"),
            category=_text(item.get("category"), "prefix category"),
            label=_label(item.get("label"), "prefix label"),
        )
        _require(entry.category in labels, f"unknown category {entry.category!r}")
        _require("." not in entry.prefix, f"prefix {entry.prefix!r} must not contain a dot")
        _require(entry.prefix not in by_prefix, f"duplicate prefix {entry.prefix!r}")
        by_prefix[entry.prefix] = entry
        prefixes.append(entry)

    actions: list[ActionEntry] = []
    by_action: dict[str, ActionEntry] = {}
    from ..models import _AUDIT_ACTION_RE  # the write-side grammar, one definition

    for item in raw.get("actions") or []:
        entry = ActionEntry(
            action=_text(item.get("action"), "action"),
            category=_text(item.get("category"), "action category"),
            label=_label(item.get("label"), "action label"),
        )
        _require(entry.category in labels, f"unknown category {entry.category!r}")
        _require(bool(_AUDIT_ACTION_RE.fullmatch(entry.action)), f"bad action {entry.action!r}")
        _require(entry.action not in by_action, f"duplicate action {entry.action!r}")
        by_action[entry.action] = entry
        actions.append(entry)

    actors = raw.get("actors") or {}
    agent_actors = tuple(_text(a, "agent actor") for a in actors.get("agent") or [])
    system_actors = tuple(_text(a, "system actor") for a in actors.get("system") or [])
    _require(not set(agent_actors) & set(system_actors), "an actor is listed as both agent and system")
    actor_labels = {
        _text(k, "actor label key"): _label(v, "actor label")
        for k, v in (raw.get("actor_labels") or {}).items()
    }

    return EventTable(
        version=version,
        category_labels=labels,
        legacy=tuple(legacy),
        prefixes=tuple(prefixes),
        actions=tuple(actions),
        agent_actors=agent_actors,
        system_actors=system_actors,
        actor_labels=actor_labels,
        legacy_by_key=by_key,
        action_by_name=by_action,
        prefix_by_name=by_prefix,
        specific_surfaces={k: tuple(sorted(v)) for k, v in specific.items()},
    )


def _load_bundled() -> EventTable:
    try:
        raw = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover - packaging error
        raise EventTableError(f"cannot read {FIXTURE_PATH.name}: {exc}") from exc
    return load_event_table(raw)


TABLE: EventTable = _load_bundled()


# --------------------------------------------------------------------------- #
# Row classification (the Python side of the one definition)
# --------------------------------------------------------------------------- #
def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else str(value)


def _humanise_verb(verb: str) -> str:
    return verb.replace("_", " ").strip()


def classify(doc: Mapping[str, Any], table: EventTable = TABLE) -> EventInfo:
    """The category id and friendly name of one stored row (see the module doc)."""
    action = _str_or_none(doc.get("action"))
    if action is not None:
        entry = table.action_by_name.get(action)
        if entry is not None:
            return EventInfo(entry.category, entry.label)
        prefix, dot, verb = action.partition(".")
        pentry = table.prefix_by_name.get(prefix) if dot else None
        if pentry is not None:
            return EventInfo(pentry.category, f"{pentry.label} {_humanise_verb(verb)}".strip())
        return EventInfo("system", action or "Unknown event")
    action_type = _str_or_none(doc.get("action_type")) or ""
    surface = _str_or_none(doc.get("surface")) or ""
    legacy = table.legacy_event(action_type, surface)
    if legacy is not None:
        return EventInfo(legacy.category, legacy.label)
    return EventInfo("system", action_type or "Unknown event")


def derive_outcome(doc: Mapping[str, Any]) -> tuple[str | None, bool]:
    """``(outcome, derived)``. A recorded outcome is returned as stored; a legacy row
    reads ``denied`` for ``access_denied`` and ``failure`` for ``error``, otherwise
    ``None`` ("Not recorded")."""
    stored = doc.get("outcome")
    if stored is not None:
        return (stored if isinstance(stored, str) else str(stored)), False
    derived = DERIVED_OUTCOMES.get(_str_or_none(doc.get("action_type")) or "")
    if derived is not None:
        return derived, True
    return None, False


def derive_actor_type(doc: Mapping[str, Any], table: EventTable = TABLE) -> tuple[str | None, bool]:
    """``(actor_type, derived)``. A recorded kind is returned as stored. For a legacy
    row: a known agent actor reads ``agent``, a known system actor ``system``, and any
    other named actor of a row in a People category (access, configuration, case work)
    reads ``human``; otherwise ``None``."""
    stored = doc.get("actor_type")
    if stored is not None:
        return (stored if isinstance(stored, str) else str(stored)), False
    actor = _str_or_none(doc.get("actor"))
    if actor is None:
        return None, False
    if actor in table.agent_actors:
        return "agent", True
    if actor in table.system_actors:
        return "system", True
    if actor and classify(doc, table).category in PEOPLE_CATEGORIES:
        return "human", True
    return None, False


def in_people_scope(doc: Mapping[str, Any], table: EventTable = TABLE) -> bool:
    """Is the row in People and settings (else it is in Agent activity)?"""
    actor_type = doc.get("actor_type")
    if actor_type is not None and str(actor_type) in PEOPLE_ACTOR_TYPES:
        return True
    return classify(doc, table).category in PEOPLE_CATEGORIES


def truncated_fields(doc: Mapping[str, Any]) -> list[str]:
    """The text fields that hit the 1,000-character write cap (``truncate`` keeps
    999 characters and appends "…")."""
    out: list[str] = []
    for field in TRUNCATABLE_FIELDS:
        value = doc.get(field)
        if isinstance(value, str) and len(value) == AUDIT_TEXT_WRITE_CAP and value.endswith("…"):
            out.append(field)
    return out


def matching_event_keys(text: str, table: EventTable = TABLE) -> tuple[list[str], list[LegacyEvent]]:
    """The exact actions and legacy events whose friendly name contains ``text``
    (ASCII case-insensitive; the labels are ASCII), so a search for "signed in" finds
    the rows the page labels "Signed in" on every store."""
    needle = ascii_lower(text)
    if not needle:
        return [], []
    actions = [e.action for e in table.actions if needle in ascii_lower(e.label)]
    legacy = [e for e in table.legacy if needle in ascii_lower(e.label)]
    return actions, legacy


def ascii_lower(text: str) -> str:
    """Lower-case ASCII letters only: the folding of SQLite's ``lower()`` and of the
    Python reference, so those two agree byte for byte. PostgreSQL's ``lower()`` and
    Elasticsearch's ``case_insensitive`` also fold non-ASCII letters, so on those
    stores a search for ``É`` finds ``é`` as well (see :mod:`app.audit.query`)."""
    return text.translate(_ASCII_LOWER)


_ASCII_LOWER = {code: code + 32 for code in range(ord("A"), ord("Z") + 1)}

# Fail at import if the actor kinds drift from the model's literal.
assert set(PEOPLE_ACTOR_TYPES) <= set(AUDIT_ACTOR_TYPES)
