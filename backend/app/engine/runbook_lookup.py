"""Runbook lookups: validation and parameter binding (Round 14 SPEC §4.10.8). Pure.

A Lookup step carries a declarative, read-only query template
(:class:`app.models.LookupTemplate`). This module owns the two things that can be
decided without touching a store, a connector, the network or the model gateway:

* :func:`validate_lookup` checks a template against the closed rules of §4.10.8 and
  returns plain-sentence issues (the runbook validator, the editor's live check, the
  import and the migration all use it through ``runbook_model.validate_runbook``).
* :func:`bind_lookup` resolves a template against one case's values and produces a
  :class:`LookupBinding`: every value bound as a STRUCTURED parameter (a filter value,
  the enrichment indicator, a group-by field), never concatenated into query text, and
  a window clamped to "now" and to the 30-day span. A value the case does not have, or
  one that fails its kind's grammar, makes the lookup :class:`LookupNotApplicable`
  with a plain reason ("This case has no IP address.").

Executing the bound lookup (the read-only log client and connector ``aggregate()``
and browse paths, the cached enrichment path, the case and campaign stores, the
bundled ATT&CK lookup, the 45-second timeout, the grants per tool, the stored
:class:`app.models.LookupResult`) belongs to ``engine/runbook_runs.py``.

Field names (log tools). A filter key or a group-by name is either one of the seven
LOGICAL names (:data:`LOOKUP_LOGICAL_FIELDS`: ``ip``, ``user``, ``host``, ``rule``,
``rule_name``, ``severity``, ``action``), which the run engine resolves per source
through ``connectors.base.aggregate_field``, or a physical dotted path
(``event.outcome``) read as written. Six of the logical names mean "this source's
mapped field": a logical name is what keeps a lookup right on a source whose mapping
is not ECS (Wazuh keeps the source IP in ``data.srcip``). ``action`` is the one
logical name with a FIXED path (:data:`LOOKUP_FIXED_FIELD_PATHS`): the ECS field
``event.action`` on every source, because no mapping names an action field. On a
source that does not record ``event.action`` an ``action`` split is empty, which means
"not recorded on this source", never "none"; a step that reads it says so, as it does
for any physical path. A physical path is for a field no mapping names. The binding
marks which is which (:attr:`BoundFilter.logical`, :attr:`LookupBinding.logical_group_by`).

Filter values on logical fields. The log fields behind ``ip``, ``user``, ``host`` and
``rule`` hold one kind of case value each, so a filter on one of them takes that case
value (``ip: "{{entity.ip}}"``) or a literal that passes the kind's grammar
(:data:`LOGICAL_FILTER_VALUES`); ``rule_name``, ``severity`` and ``action`` take a
literal only, since no case value holds them. Any other value could never equal what
the field holds (a user name on an IP field), so the lookup would store zero rows as
evidence collected automatically.

Trust (#9). Field names in ``filter`` and ``group_by`` come only from runbook text
(trusted once Published) and are checked against the evidence-field grammar of
``app/evidence_fields.py``. Every RESOLVED value comes from the case (and so from the
logs) and stays untrusted data however narrow its grammar: the binding carries it as a
parameter value and as a plain string in ``params`` for display, never as an
instruction.

Template values are a CLOSED set (``models.RUNBOOK_TEMPLATE_VALUES``). A filter value
is either a literal or exactly one ``{{template value}}``; a template is never mixed
with other text, so binding never builds a string out of case data.
"""

from __future__ import annotations

import difflib
import ipaddress
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping

from ..constants import INVISIBLE_TEXT_CLASS
from ..evidence_fields import EVIDENCE_MAX_KEY_CHARS, EVIDENCE_WILDCARD, RESERVED_KEYS
from ..models import (
    LOOKUP_TOOLS,
    RUNBOOK_LOOKUP_MAX_FILTERS,
    RUNBOOK_LOOKUP_MAX_GROUP_BY,
    RUNBOOK_LOOKUP_MAX_WINDOW_DAYS,
    RUNBOOK_LOOKUP_SEARCH_MAX_ROWS,
    RUNBOOK_TEMPLATE_VALUES,
    LookupTemplate,
    RunbookIssue,
)
from ..utils import dotted_get
from . import time_windows

# --------------------------------------------------------------------------- #
# Template values
# --------------------------------------------------------------------------- #
#: ``{{ name }}`` anywhere in a text (the name, group 1, still carries any surrounding
#: spaces; :func:`template_names_in` strips them). No lazy quantifier sits next to a
#: whitespace run, so a long hostile text is scanned in linear time.
TEMPLATE_TOKEN_RE = re.compile(r"\{\{([^{}]*)\}\}")
#: A value that is exactly one template and nothing else.
_WHOLE_TEMPLATE_RE = re.compile(r"^\{\{([^{}]*)\}\}$")

#: The noun each template value names in a plain sentence.
TEMPLATE_NOUNS: dict[str, str] = {
    "case.rule": "detection rule",
    "case.source_id": "source",
    "case.first_seen": "first-seen time",
    "case.last_seen": "last-seen time",
    "entity.ip": "IP address",
    "entity.user": "user",
    "entity.host": "host",
    "entity.domain": "domain",
    "entity.hash": "file hash",
    "entity.url": "URL",
    "entity.email": "email address",
}
assert set(TEMPLATE_NOUNS) == set(RUNBOOK_TEMPLATE_VALUES)  # one vocabulary

#: The entity kinds a template can name (``entity.<kind>``).
ENTITY_TEMPLATE_KINDS: tuple[str, ...] = tuple(
    name.split(".", 1)[1] for name in RUNBOOK_TEMPLATE_VALUES if name.startswith("entity.")
)
#: Template values an ``enrich`` lookup may take as its indicator (an observable that
#: threat-intel providers rate; a user, a host or a rule is not one).
INDICATOR_TEMPLATE_VALUES: tuple[str, ...] = (
    "entity.ip", "entity.domain", "entity.hash", "entity.url", "entity.email",
)

# Common misspellings, so the issue can name the value the author meant.
_TEMPLATE_SUGGESTIONS: dict[str, str] = {
    "entity.ipaddr": "entity.ip", "entity.ip_address": "entity.ip", "entity.ipaddress": "entity.ip",
    "entity.src_ip": "entity.ip", "entity.source_ip": "entity.ip", "entity.addr": "entity.ip",
    "entity.address": "entity.ip", "source.ip": "entity.ip", "entity.username": "entity.user",
    "entity.user_name": "entity.user", "entity.account": "entity.user", "user.name": "entity.user",
    "entity.hostname": "entity.host", "entity.host_name": "entity.host", "host.name": "entity.host",
    "entity.computer": "entity.host", "entity.file_hash": "entity.hash", "entity.sha256": "entity.hash",
    "entity.sha1": "entity.hash", "entity.md5": "entity.hash", "entity.fqdn": "entity.domain",
    "entity.mail": "entity.email", "entity.e-mail": "entity.email", "entity.link": "entity.url",
    "case.rule_id": "case.rule", "case.rule_name": "case.rule", "rule.name": "case.rule",
    "case.source": "case.source_id", "case.first_seen_at": "case.first_seen",
    "case.last_seen_at": "case.last_seen", "case.start": "case.first_seen", "case.end": "case.last_seen",
}


def template_name(value: Any) -> str | None:
    """The template value ``value`` is exactly (``"{{ entity.ip }}"`` gives
    ``"entity.ip"``), or ``None`` when it is not a single template."""
    if not isinstance(value, str):
        return None
    m = _WHOLE_TEMPLATE_RE.match(value.strip())
    return m.group(1).strip() if m else None


def template_names_in(text: Any) -> list[str]:
    """Every ``{{name}}`` in ``text``, in order (names are not checked)."""
    if not isinstance(text, str) or "{{" not in text:
        return []
    return [m.group(1).strip() for m in TEMPLATE_TOKEN_RE.finditer(text)]


def suggest_template(name: str) -> str | None:
    """The closed-set template value an unknown ``name`` most likely meant."""
    key = (name or "").strip().lower()
    if key in _TEMPLATE_SUGGESTIONS:
        return _TEMPLATE_SUGGESTIONS[key]
    close = difflib.get_close_matches(key, RUNBOOK_TEMPLATE_VALUES, n=1, cutoff=0.6)
    return close[0] if close else None


def unknown_template_message(owner: str, name: str) -> str:
    """The plain sentence for an unknown template value, naming the likely fix:
    "Step 'How many accounts were tried?' uses {{entity.ipaddr}}, which is not a case
    value. Use {{entity.ip}}." ``owner`` is how the sentence names the place."""
    shown = _shown(name, 60)
    suggestion = suggest_template(name)
    tail = (f" Use {{{{{suggestion}}}}}." if suggestion
            else " Use one of " + ", ".join("{{" + v + "}}" for v in RUNBOOK_TEMPLATE_VALUES) + ".")
    return f"{owner} uses {{{{{shown}}}}}, which is not a case value.{tail}"


# --------------------------------------------------------------------------- #
# The per-tool rules
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ToolRules:
    """What one lookup tool accepts. ``filter_keys`` is ``None`` for the log tools
    (keys are log field names, checked against the evidence-field grammar) or the
    closed set of logical keys the tool understands."""

    label: str
    filter_keys: frozenset[str] | None
    min_filters: int
    allow_group_by: bool
    needs_indicator: bool
    max_limit: int
    windowed: bool


#: The tools and the keys they read (SPEC §4.10.8):
#:
#: * ``log_stats`` and ``log_search``: ``filter`` maps log fields (a logical name of
#:   :data:`LOOKUP_LOGICAL_FIELDS` or a physical path) to a literal or one case value;
#:   ``log_stats`` may group by up to 2 fields (top 50 keys), ``log_search`` returns at
#:   most 20 rows. Both need a filter, so a lookup always looks at this case's data.
#: * ``enrich``: ``indicator`` is one observable case value; no filters.
#: * ``related_cases``: ``entity`` (cases sharing that case value) and/or ``rule``
#:   (cases from that rule) inside the window, at most 10 cases. A case is keyed by
#:   one entity of :data:`CASE_CARRIED_ENTITY_KINDS`, so ``entity`` takes only those.
#: * ``campaign``: with ``entity``, the campaigns that include that value; without
#:   it, the campaign the case belongs to. Campaigns bind cases on their entity, so
#:   ``entity`` takes the same kinds as ``related_cases``.
#: * ``mitre``: ``technique`` names one ATT&CK technique; without it, the case's own
#:   techniques.
TOOL_RULES: dict[str, ToolRules] = {
    "log_stats": ToolRules("Log statistics", None, 1, True, False, 50, True),
    "log_search": ToolRules("Log search", None, 1, False, False, RUNBOOK_LOOKUP_SEARCH_MAX_ROWS, True),
    "enrich": ToolRules("Enrichment", frozenset(), 0, False, True, 50, False),
    "related_cases": ToolRules("Related cases", frozenset({"entity", "rule"}), 1, False, False, 10, True),
    "campaign": ToolRules("Campaign", frozenset({"entity"}), 0, False, False, 20, False),
    "mitre": ToolRules("ATT&CK technique", frozenset({"technique"}), 0, False, False, 20, False),
}
assert set(TOOL_RULES) == set(LOOKUP_TOOLS)

#: Execution bounds the run engine applies (SPEC §4.10.8): each lookup times out at
#: 45 seconds (the chat tool timeout default) and a run executes at most 2 at once.
LOOKUP_TIMEOUT_S = 45
LOOKUP_MAX_CONCURRENT_PER_RUN = 2

#: The largest literal a filter may compare against.
LOOKUP_LITERAL_MAX_CHARS = 256
#: The names a lookup uses for its own settings. A log tool's filter key is a field
#: name, and the resolved parameters (``LookupBinding.params``, stored on
#: ``LookupResult.params`` and shown and audited as what ran) hold the filters and the
#: settings side by side, so a filter on one of these names would be overwritten there.
LOOKUP_SETTING_KEYS: frozenset[str] = frozenset({"limit", "group_by", "indicator", "window"})
#: The logical field names a log lookup may filter or group on. The run engine
#: resolves each per source through ``connectors.base.aggregate_field(<source prefs>,
#: name)``. Six mean "this source's mapped field": ``ip`` the source IP field, ``user``
#: the user field, ``host`` the host field, ``rule`` the rule field (the values cases
#: are keyed on), ``rule_name`` the rule name field and ``severity`` the severity
#: field. ``action`` is the exception: no mapping names an action field, so it is the
#: fixed ECS path ``event.action`` on every source (:data:`LOOKUP_FIXED_FIELD_PATHS`),
#: and on a source that does not record that field an ``action`` split is empty
#: ("not recorded on this source", never "none"). The same names as the keys of
#: ``connectors.base.AGGREGATE_FIELDS``, copied because this pure module imports no
#: connector (a test keeps the two equal). Any other name is a physical dotted path,
#: read as written on every source.
LOOKUP_LOGICAL_FIELDS: tuple[str, ...] = ("ip", "user", "host", "rule", "rule_name", "severity", "action")
#: The logical names whose physical path is the same on every source, whatever its
#: field mapping says (``connectors.base._FIXED_AGGREGATE_PATHS``; a test keeps the two
#: equal by asking ``aggregate_field`` under two different mappings). A step that reads
#: one names the path for the analyst, as it does for a physical path, so an empty
#: split on a source without that field is never read as "none".
LOOKUP_FIXED_FIELD_PATHS: dict[str, str] = {"action": "event.action"}
#: The entity kinds a stored case is keyed by (``Case.entity``: an IP address, a user
#: or a host; a rule-keyed case has none). File hashes, domains, URLs and email
#: addresses are values of a case's events, never its entity, so the case store and
#: the campaign graph can never find a case by one of them.
CASE_CARRIED_ENTITY_KINDS: frozenset[str] = frozenset({"ip", "user", "host"})
#: The tools that find cases (or campaigns of cases) by a case entity.
_CASE_ENTITY_TOOLS: frozenset[str] = frozenset({"related_cases", "campaign"})


@dataclass(frozen=True)
class LogicalFilterValue:
    """What a log filter on one logical field may compare against.

    ``template`` is the one case value the field holds (``None`` when no case value
    does), ``grammar`` the :func:`valid_value` kind a literal must pass (``None`` for
    free text) and ``noun`` how a sentence names such a value."""

    template: str | None
    grammar: str | None
    noun: str


#: The value each logical field of a log filter takes: its own case value or a literal
#: of its kind. A filter that compares the IP field with a user name, a host name with
#: a file hash, or any field with a time could never match, so the lookup would store
#: zero rows as evidence; validation refuses it instead. ``rule_name``, ``severity``
#: and ``action`` take a literal only (no case value holds a rule name, a severity or
#: an action; ``{{case.rule}}`` is the rule field's value, filtered with ``rule``).
LOGICAL_FILTER_VALUES: dict[str, LogicalFilterValue] = {
    "ip": LogicalFilterValue("entity.ip", "ip", "an IP address"),
    "user": LogicalFilterValue("entity.user", "user", "a user name"),
    "host": LogicalFilterValue("entity.host", "host", "a host name"),
    "rule": LogicalFilterValue("case.rule", "rule", "a rule value"),
    "rule_name": LogicalFilterValue(None, "rule", "a rule name"),
    "severity": LogicalFilterValue(None, None, "a severity"),
    "action": LogicalFilterValue(None, None, "an action"),
}
assert set(LOGICAL_FILTER_VALUES) == set(LOOKUP_LOGICAL_FIELDS)  # one vocabulary
assert set(LOOKUP_FIXED_FIELD_PATHS) <= set(LOOKUP_LOGICAL_FIELDS)
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
#: A log field path: dotted segments of letters, digits, ``_``, ``@`` and ``-``.
_FIELD_RE = re.compile(r"^[A-Za-z_@][A-Za-z0-9_@-]*(?:\.[A-Za-z0-9_@-]+)*$")
#: Hidden characters and lone surrogate halves (which cannot be encoded, so they would
#: break a store write or a response): never in a literal, never in a message.
_INVISIBLE_RE = re.compile(f"[{INVISIBLE_TEXT_CLASS}\\ud800-\\udfff]")
_LINE_BREAK_RE = re.compile(r"[\r\n\t]")


def is_field_name(name: Any) -> bool:
    """True when ``name`` is a log field path a lookup may filter or group on: a
    dotted path (``source.ip``, ``event.outcome``, ``@timestamp``) of at most the
    evidence grammar's key length, never the evidence wildcard and never one of the
    projection's reserved keys (``app/evidence_fields.py``)."""
    if not isinstance(name, str):
        return False
    if not name or len(name) > EVIDENCE_MAX_KEY_CHARS:
        return False
    if name == EVIDENCE_WILDCARD or name in RESERVED_KEYS:
        return False
    # ``fullmatch``: a pattern's ``$`` also matches before a trailing line break, so
    # ``match`` would let ``"source.ip\n"`` through.
    return bool(_FIELD_RE.fullmatch(name))


def is_logical_field(name: Any) -> bool:
    """True when ``name`` is one of :data:`LOOKUP_LOGICAL_FIELDS` (exactly, in lower
    case): a field the run engine resolves through ``connectors.base.aggregate_field``
    (the source's field mapping, or the fixed path of :data:`LOOKUP_FIXED_FIELD_PATHS`)
    rather than reading as a physical path."""
    return isinstance(name, str) and name in LOOKUP_LOGICAL_FIELDS


def fixed_field_path(name: Any) -> str | None:
    """The physical path a logical name reads on every source (``action`` gives
    ``event.action``), or ``None`` for a mapped logical name or any other name."""
    return LOOKUP_FIXED_FIELD_PATHS.get(name) if isinstance(name, str) else None


#: How a sentence names the field forms a log lookup accepts.
_FIELD_FORMS = ("ip, user, host, rule, rule_name or severity (the source's mapped field), action "
                "(the ECS field event.action on every source), or a log field name such as event.outcome")


def _shown(text: str, limit: int = 80) -> str:
    """A bounded, one-line rendering of an author's text inside a message."""
    flat = _LINE_BREAK_RE.sub(" ", _INVISIBLE_RE.sub("", str(text)))
    return flat if len(flat) <= limit else flat[: limit - 3].rstrip() + "..."


def _literal_problem(value: str) -> str | None:
    """Why a literal filter value is not acceptable, or ``None``."""
    if not value.strip():
        return "is empty"
    if len(value) > LOOKUP_LITERAL_MAX_CHARS:
        return f"is {len(value):,} characters; the limit is {LOOKUP_LITERAL_MAX_CHARS:,}"
    if _INVISIBLE_RE.search(value) or _LINE_BREAK_RE.search(value):
        return "contains a line break or hidden characters"
    if "{{" in value or "}}" in value:
        return "mixes a case value with other text; use exactly one case value or plain text"
    return None


# --------------------------------------------------------------------------- #
# The window grammar
# --------------------------------------------------------------------------- #
#: ``case_first_seen``, ``case_last_seen`` or ``now``, with an optional offset.
_BOUND_RE = re.compile(r"^(case_first_seen|case_last_seen|now)(?:([+-])(\d{1,6})([mhdw]))?$")
_RELATIVE_TOKEN_RE = re.compile(r"^now-(\d{1,6})([mhdw])$")
#: Round 12 calendar tokens whose span can never exceed the 30-day bound.
_SHORT_CALENDAR_TOKENS = frozenset({"today", "yesterday", "this_week", "last_week"})
_UNIT_SECONDS = {"m": 60, "h": 3_600, "d": 86_400, "w": 604_800}
_ANCHOR_RANK = {"case_first_seen": 0, "case_last_seen": 1, "now": 2}
MAX_WINDOW_SPAN = timedelta(days=RUNBOOK_LOOKUP_MAX_WINDOW_DAYS)
#: An offset reaches at most 30 days before or after its anchor.
MAX_WINDOW_OFFSET = timedelta(days=RUNBOOK_LOOKUP_MAX_WINDOW_DAYS)

WINDOW_FORMS = (
    "case_first_seen-1h..case_last_seen+1h (an anchor of case_first_seen, case_last_seen "
    "or now, each with an optional offset in m, h, d or w), now-24h, now-7d, today, "
    "yesterday, this_week or last_week"
)


@dataclass(frozen=True)
class WindowBound:
    anchor: str            # case_first_seen | case_last_seen | now
    offset: timedelta


@dataclass(frozen=True)
class WindowSpec:
    """A parsed window: two anchored bounds, or one Round 12 token."""

    text: str
    start: WindowBound | None = None
    end: WindowBound | None = None
    token: str | None = None


def _parse_bound(raw: str) -> WindowBound | None:
    m = _BOUND_RE.match(raw.strip())
    if not m:
        return None
    anchor, sign, amount, unit = m.groups()
    offset = timedelta(0)
    if sign:
        offset = timedelta(seconds=int(amount) * _UNIT_SECONDS[unit])
        if sign == "-":
            offset = -offset
    return WindowBound(anchor, offset)


def parse_window(window: Any) -> tuple[WindowSpec | None, str | None]:
    """``(spec, None)`` for a valid window, else ``(None, reason)``. The reason is a
    predicate that completes "... has a window that <reason>". A span that is fixed by
    the text (both bounds on one anchor, or a token) must be at most 30 days; a span
    that depends on the case is clamped to its last 30 days when the lookup is bound."""
    if not isinstance(window, str) or not window.strip():
        return None, f"is empty. Use {WINDOW_FORMS}."
    text = window.strip()
    shown = _shown(text, 60)
    if ".." in text:
        lo_raw, _, hi_raw = text.partition("..")
        lo, hi = _parse_bound(lo_raw), _parse_bound(hi_raw)
        if lo is None or hi is None:
            return None, f"is not in a form Agentic SOC reads ('{shown}'). Use {WINDOW_FORMS}."
        for bound in (lo, hi):
            if abs(bound.offset) > MAX_WINDOW_OFFSET:
                return None, (f"reaches more than {RUNBOOK_LOOKUP_MAX_WINDOW_DAYS} days from its "
                              f"anchor ('{shown}').")
        if hi.anchor == "now" and hi.offset > timedelta(0):
            return None, f"ends after now ('{shown}')."
        if _ANCHOR_RANK[lo.anchor] > _ANCHOR_RANK[hi.anchor]:
            return None, f"starts at a later point than it ends ('{shown}')."
        if lo.anchor == hi.anchor:
            span = hi.offset - lo.offset
            if span <= timedelta(0):
                return None, f"starts at or after its end ('{shown}')."
            if span > MAX_WINDOW_SPAN:
                return None, f"spans more than {RUNBOOK_LOOKUP_MAX_WINDOW_DAYS} days ('{shown}')."
        return WindowSpec(text=text, start=lo, end=hi), None
    m = _RELATIVE_TOKEN_RE.match(text)
    if m:
        seconds = int(m.group(1)) * _UNIT_SECONDS[m.group(2)]
        if seconds <= 0:
            return None, f"is empty ('{shown}')."
        if timedelta(seconds=seconds) > MAX_WINDOW_SPAN:
            return None, f"spans more than {RUNBOOK_LOOKUP_MAX_WINDOW_DAYS} days ('{shown}')."
        return WindowSpec(text=text, token=text), None
    if text in _SHORT_CALENDAR_TOKENS:
        return WindowSpec(text=text, token=text), None
    return None, f"is not in a form Agentic SOC reads ('{shown}'). Use {WINDOW_FORMS}."


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
#: At most this many issues are reported for one check (``runbook_model`` caps the
#: parser and the validator at this number and adds one ``more_issues`` issue). The
#: lookup check stops where nothing more could be reported: a filter or group-by list
#: is read at most this many entries past its own limit, and its loop ends once more
#: issues than this are found.
RUNBOOK_MAX_ISSUES = 200


def _issue(path: str, code: str, message: str) -> RunbookIssue:
    return RunbookIssue(path=path, code=code, message=message)


def validate_lookup(
    lookup: LookupTemplate,
    *,
    path: str = "lookup",
    owner: str = "This lookup",
) -> list[RunbookIssue]:
    """Every problem with one lookup template, as plain-sentence issues.

    ``path`` prefixes each issue's path (``steps[2].lookup``); ``owner`` is how the
    sentences name the step ("Step 'How many accounts were tried?'"). Checked: the
    tool's accepted keys, at most 8 filters, field names against the evidence-field
    grammar (and never one of the lookup's own setting names,
    :data:`LOOKUP_SETTING_KEYS`), literals, every template value against the closed
    set (and an ``enrich`` indicator against the indicator kinds), a log filter on a
    logical field against the value that field holds (:data:`LOGICAL_FILTER_VALUES`),
    ``group_by``
    (``log_stats`` only, at most 2 fields), the limit per tool (``log_search`` at most 20 rows, ``related_cases`` at
    most 10) and the window grammar with its 30-day span.

    The work is bounded however many filters or group-by fields a template carries:
    each list is read at most :data:`RUNBOOK_MAX_ISSUES` entries past its limit (the
    limit is already reported), and stops once more issues than that are found."""
    issues: list[RunbookIssue] = []
    rules = TOOL_RULES.get(lookup.tool)
    if rules is None:  # pragma: no cover - the model's Literal already refuses it
        return [_issue(f"{path}.tool", "invalid", f"{owner} uses an unknown lookup tool.")]

    # Filters ------------------------------------------------------------------
    filters = dict(lookup.filter or {})
    if len(filters) > RUNBOOK_LOOKUP_MAX_FILTERS:
        issues.append(_issue(f"{path}.filter", "too_many",
                             f"{owner} has {len(filters)} filters; the limit is "
                             f"{RUNBOOK_LOOKUP_MAX_FILTERS}."))
    filters_allowed = rules.filter_keys is None or bool(rules.filter_keys)
    if not filters_allowed and filters:
        issues.append(_issue(f"{path}.filter", "not_allowed",
                             f"{owner} uses {rules.label.lower()}, which takes no filters. "
                             f"Remove them."))
    elif len(filters) < rules.min_filters:
        noun = "a filter" if rules.filter_keys is None else (
            "a filter (" + " or ".join(sorted(rules.filter_keys)) + ")")
        issues.append(_issue(f"{path}.filter", "required",
                             f"{owner} needs {noun}, so it looks at this case's data."))
    for n, (key, raw_value) in enumerate(filters.items() if filters_allowed else ()):
        if n >= RUNBOOK_LOOKUP_MAX_FILTERS + RUNBOOK_MAX_ISSUES or len(issues) > RUNBOOK_MAX_ISSUES:
            break
        fpath = f"{path}.filter.{key}"
        if rules.filter_keys is None:
            if not is_field_name(key):
                issues.append(_issue(fpath, "invalid",
                                     f"{owner} filters on '{_shown(key, 60)}', which is not a field. "
                                     f"Use {_FIELD_FORMS}."))
                continue
            if key in LOOKUP_SETTING_KEYS:
                issues.append(_issue(fpath, "not_allowed",
                                     f"{owner} filters on '{key}', a name the lookup uses for its own "
                                     f"settings. Filter on another field."))
                continue
        elif rules.filter_keys and key not in rules.filter_keys:
            issues.append(_issue(fpath, "not_allowed",
                                 f"{owner} filters on '{_shown(key, 60)}'; "
                                 f"{rules.label.lower()} accepts "
                                 + " or ".join(sorted(rules.filter_keys)) + "."))
            continue
        issues.extend(_validate_filter_value(lookup.tool, key, raw_value, fpath, owner))

    # Group by -------------------------------------------------------------------
    group_by = list(lookup.group_by or [])
    if group_by and not rules.allow_group_by:
        issues.append(_issue(f"{path}.group_by", "not_allowed",
                             f"{owner} groups results, which only log statistics can do."))
    elif len(group_by) > RUNBOOK_LOOKUP_MAX_GROUP_BY:
        issues.append(_issue(f"{path}.group_by", "too_many",
                             f"{owner} groups by {len(group_by)} fields; the limit is "
                             f"{RUNBOOK_LOOKUP_MAX_GROUP_BY}."))
    seen: set[str] = set()
    for i, name in enumerate(group_by[: RUNBOOK_LOOKUP_MAX_GROUP_BY + RUNBOOK_MAX_ISSUES]):
        if len(issues) > RUNBOOK_MAX_ISSUES:
            break
        if not is_field_name(name):
            issues.append(_issue(f"{path}.group_by[{i}]", "invalid",
                                 f"{owner} groups by '{_shown(name, 60)}', which is not a field. "
                                 f"Use {_FIELD_FORMS}."))
        elif name in seen:
            issues.append(_issue(f"{path}.group_by[{i}]", "duplicate",
                                 f"{owner} groups by {name} twice."))
        seen.add(name)

    # Indicator ------------------------------------------------------------------
    if rules.needs_indicator:
        name = template_name(lookup.indicator)
        if not (lookup.indicator or "").strip():
            issues.append(_issue(f"{path}.indicator", "required",
                                 f"{owner} needs the case value to enrich, such as {{{{entity.ip}}}}."))
        elif name is None:
            issues.append(_issue(f"{path}.indicator", "invalid",
                                 f"{owner} must enrich exactly one case value, such as "
                                 f"{{{{entity.ip}}}}, not other text."))
        elif name not in RUNBOOK_TEMPLATE_VALUES:
            issues.append(_issue(f"{path}.indicator", "template_value",
                                 unknown_template_message(owner, name)))
        elif name not in INDICATOR_TEMPLATE_VALUES:
            issues.append(_issue(f"{path}.indicator", "not_allowed",
                                 f"{owner} enriches {{{{{name}}}}}; enrichment takes "
                                 + ", ".join("{{" + v + "}}" for v in INDICATOR_TEMPLATE_VALUES)
                                 + "."))
    elif lookup.indicator not in (None, ""):
        issues.append(_issue(f"{path}.indicator", "not_allowed",
                             f"{owner} sets an indicator, which only enrichment uses. Remove it."))

    # Limit --------------------------------------------------------------------
    # Only a log search states its row cap as a rule the author must meet; the other
    # tools' internal bounds (10 related cases, 20 campaigns or techniques) are applied
    # when the lookup is bound, so the default limit of 20 never reads as a problem.
    if lookup.tool == "log_search" and lookup.limit > rules.max_limit:
        issues.append(_issue(f"{path}.limit", "too_many",
                             f"{owner} asks for {lookup.limit} rows; a log search returns at most "
                             f"{rules.max_limit}."))

    # Window ---------------------------------------------------------------------
    _spec, reason = parse_window(lookup.window)
    if reason is not None:
        issues.append(_issue(f"{path}.window", "invalid", f"{owner} has a window that {reason}"))
    return issues


def _logical_value_hint(expected: LogicalFilterValue) -> str:
    """The fix a sentence offers for a logical field: its case value or a literal."""
    if expected.template is not None:
        return f"use {{{{{expected.template}}}}} or {expected.noun}"
    return f"write {expected.noun}"


def _validate_filter_value(tool: str, key: str, raw_value: Any, path: str, owner: str) -> list[RunbookIssue]:
    value = raw_value if isinstance(raw_value, str) else str(raw_value)
    name = template_name(value)
    out: list[RunbookIssue] = []
    # A log tool's logical field holds one kind of value (LOGICAL_FILTER_VALUES).
    expected = LOGICAL_FILTER_VALUES.get(key) if TOOL_RULES[tool].filter_keys is None else None
    if name is not None:
        if name not in RUNBOOK_TEMPLATE_VALUES:
            return [_issue(path, "template_value", unknown_template_message(owner, name))]
        if expected is not None and name != expected.template:
            if expected.template is None:
                reason = (f"{owner} filters {key} on {{{{{name}}}}}, but no case value is "
                          f"{expected.noun}; {_logical_value_hint(expected)} instead.")
                if key == "rule_name" and name == "case.rule":
                    reason = (f"{owner} filters {key} on {{{{case.rule}}}}, the value of the rule field; "
                              f"filter rule on it instead, or {_logical_value_hint(expected)}.")
            else:
                reason = f"{owner} filters {key} on {{{{{name}}}}}; {_logical_value_hint(expected)}."
            return [_issue(path, "not_allowed", reason)]
        if tool in _CASE_ENTITY_TOOLS and key == "entity" and not name.startswith("entity."):
            out.append(_issue(path, "not_allowed",
                              f"{owner} looks for cases sharing {{{{{name}}}}}; use an entity value "
                              f"such as {{{{entity.ip}}}}."))
        elif (tool in _CASE_ENTITY_TOOLS and key == "entity"
              and name.split(".", 1)[1] not in CASE_CARRIED_ENTITY_KINDS):
            # The case store finds cases by their entity and the campaign graph binds
            # cases on it; neither ever holds a hash, a domain, a URL or an email
            # address, so this lookup would always read "none" (false evidence).
            out.append(_issue(path, "not_allowed",
                              f"Cases are keyed by an IP address, a user or a host, so {owner[:1].lower()}"
                              f"{owner[1:]} never finds a case by {{{{{name}}}}}. Use a log lookup on the "
                              f"{TEMPLATE_NOUNS[name]} field instead."))
        if tool == "related_cases" and key == "rule" and name != "case.rule":
            out.append(_issue(path, "not_allowed",
                              f"{owner} matches the rule against {{{{{name}}}}}; use {{{{case.rule}}}} "
                              f"or a rule name."))
        if tool == "mitre":
            out.append(_issue(path, "not_allowed",
                              f"{owner} names a technique with a case value; write a technique id "
                              f"such as T1110."))
        return out
    problem = _literal_problem(value)
    if problem is not None:
        return [_issue(path, "invalid", f"{owner} filters {_shown(key, 40)} on a value that {problem}.")]
    if expected is not None and expected.grammar is not None and valid_value(expected.grammar, value) is None:
        hint = _logical_value_hint(expected)
        return [_issue(path, "invalid",
                       f"{owner} filters {key} on '{_shown(value.strip(), 40)}', which is not "
                       f"{expected.noun}. {hint[:1].upper()}{hint[1:]}.")]
    if tool in ("related_cases", "campaign") and key == "entity":
        out.append(_issue(path, "invalid",
                          f"{owner} must look for cases sharing a case value such as "
                          f"{{{{entity.ip}}}}, not fixed text."))
    if tool == "mitre" and not _TECHNIQUE_RE.match(value.strip().upper()):
        out.append(_issue(path, "invalid",
                          f"{owner} names '{_shown(value, 40)}', which is not an ATT&CK technique id "
                          f"such as T1110 or T1110.003."))
    return out


# --------------------------------------------------------------------------- #
# Case values and their grammars
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CaseValues:
    """The values a lookup template can resolve against, for one case.

    ``entities`` maps an entity kind (``ip``, ``user``, ``host``, ``domain``, ``hash``,
    ``url``, ``email``) to its values, the case's primary entity first; a template
    takes the first value that passes its kind's grammar. Every value is untrusted
    (it comes from the logs) and is only ever bound as a parameter."""

    rule: str | None = None
    source_id: str | None = None
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    entities: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


_HASH_RE = re.compile(r"[0-9A-Fa-f]{32}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64}|[0-9A-Fa-f]{128}")
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_TLD = r"(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})"
_DOMAIN_RE = re.compile(rf"(?:{_LABEL}\.)+{_TLD}")
_EMAIL_RE = re.compile(rf"[A-Za-z0-9._%+-]{{1,64}}@(?:{_LABEL}\.)+{_TLD}")
_URL_RE = re.compile(r"https?://[^\s/?#\"'<>`\\{}|^]+[^\s\"'<>`\\{}|^]*", re.IGNORECASE)
_SOURCE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}")
#: Punctuation a host or user name may carry besides letters, digits and marks.
_IDENT_PUNCT = frozenset("_.@\\$:/#+-")
_MAX_CHARS = {"ip": 45, "hash": 128, "domain": 253, "url": 2048, "email": 254,
              "host": 256, "user": 256, "rule": 256, "source_id": 128}


def _is_ip(value: str) -> bool:
    if "%" in value:  # a zone id carries free text
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _is_identifier(value: str, *, spaces: bool) -> bool:
    """Letters, digits and marks of any script, the identifier punctuation and (for a
    user name) single inner spaces; at least one letter or digit."""
    has_alnum = False
    prev_space = True
    for index, ch in enumerate(value):
        if ch == " ":
            if not spaces or prev_space:
                return False
            prev_space = True
            continue
        prev_space = False
        if ch in _IDENT_PUNCT:
            continue
        major = unicodedata.category(ch)[0]
        if major in "LN":
            has_alnum = True
            continue
        if major == "M" and index > 0:
            continue
        return False
    return has_alnum and not prev_space


def _is_rule(value: str) -> bool:
    """A rule value is free text from the source (it may hold spaces, colons or
    brackets) but never a line break, a control or hidden character, or a template."""
    if "{{" in value or "}}" in value:
        return False
    return all(unicodedata.category(ch)[0] != "C" for ch in value)


_GRAMMAR: dict[str, Any] = {
    "ip": _is_ip,
    "hash": lambda v: bool(_HASH_RE.fullmatch(v)),
    "domain": lambda v: bool(_DOMAIN_RE.fullmatch(v)),
    "email": lambda v: bool(_EMAIL_RE.fullmatch(v)),
    "url": lambda v: bool(v.isascii() and _URL_RE.fullmatch(v)),
    "host": lambda v: _is_identifier(v, spaces=False),
    "user": lambda v: _is_identifier(v, spaces=True),
    "rule": _is_rule,
    "source_id": lambda v: bool(_SOURCE_ID_RE.fullmatch(v)),
}


def valid_value(kind: str, raw: Any) -> str | None:
    """``raw`` trimmed when it passes ``kind``'s grammar, else ``None``. Nothing else
    is changed: a value that fails is never cut or altered into a different value."""
    check = _GRAMMAR.get(kind)
    if check is None or not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value or len(value) > _MAX_CHARS[kind] or _INVISIBLE_RE.search(value):
        return None
    return value if check(value) else None


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def iso_utc(dt: datetime) -> str:
    """``2026-10-26T14:31:00Z``: the one timestamp form a binding emits."""
    return _aware(dt).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class ResolvedValue:
    """One template value resolved for one case."""

    name: str              # the template value, e.g. ``entity.ip``
    kind: str              # the grammar it passed: ip, user, host, ..., rule, source_id, time
    value: str


@dataclass(frozen=True)
class LookupNotApplicable:
    """The lookup cannot run on this case (``LookupResult.status = "not_applicable"``);
    ``reason`` is the plain sentence the step shows."""

    reason: str
    template: str | None = None


def resolve_template(name: str, values: CaseValues) -> ResolvedValue | LookupNotApplicable:
    """Resolve one closed-set template value against ``values``."""
    noun = TEMPLATE_NOUNS.get(name)
    if noun is None:
        return LookupNotApplicable(f"This lookup uses {{{{{_shown(name, 40)}}}}}, which is not a case value.", name)
    missing = LookupNotApplicable(f"This case has no {noun}.", name)
    invalid = LookupNotApplicable(f"This case's {noun} is not in a form a lookup can use.", name)
    if name in ("case.first_seen", "case.last_seen"):
        moment = values.first_seen if name == "case.first_seen" else values.last_seen
        if moment is None:
            return missing
        return ResolvedValue(name, "time", iso_utc(moment))
    if name == "case.rule":
        if not (values.rule or "").strip():
            return missing
        ok = valid_value("rule", values.rule)
        return ResolvedValue(name, "rule", ok) if ok else invalid
    if name == "case.source_id":
        if not (values.source_id or "").strip():
            return missing
        ok = valid_value("source_id", values.source_id)
        return ResolvedValue(name, "source_id", ok) if ok else invalid
    kind = name.split(".", 1)[1]
    candidates = [v for v in (values.entities.get(kind) or ()) if isinstance(v, str) and v.strip()]
    if not candidates:
        return missing
    for candidate in candidates:
        ok = valid_value(kind, candidate)
        if ok is not None:
            return ResolvedValue(name, kind, ok)
    return invalid


# --------------------------------------------------------------------------- #
# Binding
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class BoundFilter:
    """One structured filter: a field (or logical key) and the value it must equal.
    ``template`` names the case value it came from, ``None`` for a literal.
    ``logical`` is true for a log tool's logical field name
    (:data:`LOOKUP_LOGICAL_FIELDS`), which the run engine resolves through the
    source's field mapping; false for a physical path, and for the keys of the other
    tools (``entity``, ``rule``, ``technique``), which are that tool's own."""

    key: str
    value: str
    template: str | None = None
    logical: bool = False


@dataclass(frozen=True)
class LookupBinding:
    """A lookup bound to one case, ready for ``engine/runbook_runs.py`` to execute
    through the read-only paths. Every resolved value is untrusted data, carried as a
    parameter (``filters``, ``indicator``), never as query text. ``window_to`` is
    already cut to ``ran_at`` (``window_clamped``) and the span to its last 30 days
    (``span_clamped``). ``params`` is the plain-string view stored on
    :class:`app.models.LookupResult`. ``logical_group_by`` lists the ``group_by``
    names that are logical fields, in order; the run engine resolves those (and every
    filter with ``logical`` set) through the source's field mapping
    (``connectors.base.aggregate_field``) and reads every other name as a path."""

    tool: str
    filters: tuple[BoundFilter, ...]
    group_by: tuple[str, ...]
    indicator: ResolvedValue | None
    limit: int
    window_from: datetime | None
    window_to: datetime | None
    window_clamped: bool
    span_clamped: bool
    ran_at: datetime
    params: dict[str, str]
    logical_group_by: tuple[str, ...] = ()

    @property
    def window_from_iso(self) -> str:
        return iso_utc(self.window_from) if self.window_from else ""

    @property
    def window_to_iso(self) -> str:
        return iso_utc(self.window_to) if self.window_to else ""


def resolve_window_bounds(
    spec: WindowSpec,
    values: CaseValues,
    *,
    now: datetime,
    tz: str = "UTC",
) -> tuple[datetime, datetime] | LookupNotApplicable:
    """The two instants of ``spec`` for one case, before any clamp. A case time near
    the ends of the calendar (event times are log-derived, so a year-9999 timestamp is
    possible) binds as not applicable instead of raising."""
    try:
        if spec.token is not None:
            resolved = time_windows.resolve_window(spec.token, tz=tz, now=now)
            start = resolved.start if resolved.start is not None else resolved.end - MAX_WINDOW_SPAN
            return _aware(start), _aware(resolved.end)
        assert spec.start is not None and spec.end is not None
        out: list[datetime] = []
        for bound in (spec.start, spec.end):
            if bound.anchor == "now":
                base: datetime | None = now
            elif bound.anchor == "case_first_seen":
                base = values.first_seen
            else:
                base = values.last_seen if values.last_seen is not None else values.first_seen
            if base is None:
                return LookupNotApplicable("This case has no first-seen time, so the search window is unknown.")
            out.append(_aware(base) + bound.offset)
        return out[0], out[1]
    except (OverflowError, ValueError):
        return LookupNotApplicable(_OUT_OF_RANGE_REASON)


#: The reason a lookup gives when a case time cannot be placed on the calendar.
_OUT_OF_RANGE_REASON = "This case's times are outside the supported range, so the search window is unknown."


def bind_lookup(
    lookup: LookupTemplate,
    values: CaseValues,
    *,
    now: datetime,
    tz: str = "UTC",
) -> LookupBinding | LookupNotApplicable:
    """Bind ``lookup`` to one case.

    Returns :class:`LookupNotApplicable` when a template value is missing or fails its
    grammar, or when the window is empty once cut to ``now``. Otherwise every filter,
    the indicator and the window are resolved: ``window_to = min(resolved end, now)``
    (``window_clamped``), and a case-dependent span over 30 days keeps its last 30
    days (``span_clamped``). The template is assumed valid (:func:`validate_lookup`);
    an invalid one binds as not applicable rather than raising."""
    ran_at = _aware(now)
    rules = TOOL_RULES.get(lookup.tool)
    if rules is None:
        return LookupNotApplicable("This lookup uses a tool Agentic SOC does not have.")
    if validate_lookup(lookup):
        return LookupNotApplicable("This lookup has problems in its runbook, so it did not run.")

    log_tool = rules.filter_keys is None
    filters: list[BoundFilter] = []
    params: dict[str, str] = {}
    for key, raw_value in (lookup.filter or {}).items():
        logical = log_tool and is_logical_field(key)
        name = template_name(raw_value)
        if name is None:
            literal = raw_value.strip()
            if lookup.tool == "mitre":
                literal = literal.upper()
            filters.append(BoundFilter(key, literal, None, logical))
            params[key] = literal
            continue
        resolved = resolve_template(name, values)
        if isinstance(resolved, LookupNotApplicable):
            return resolved
        filters.append(BoundFilter(key, resolved.value, name, logical))
        params[key] = resolved.value

    indicator: ResolvedValue | None = None
    if rules.needs_indicator:
        name = template_name(lookup.indicator) or ""
        resolved = resolve_template(name, values)
        if isinstance(resolved, LookupNotApplicable):
            return resolved
        indicator = resolved
        params["indicator"] = resolved.value

    if lookup.group_by:
        params["group_by"] = ", ".join(lookup.group_by)
    limit = min(lookup.limit, rules.max_limit)
    params["limit"] = str(limit)

    window_from: datetime | None = None
    window_to: datetime | None = None
    window_clamped = span_clamped = False
    if rules.windowed:
        spec, _reason = parse_window(lookup.window)
        if spec is None:  # pragma: no cover - validate_lookup refused it above
            return LookupNotApplicable("This lookup's search window is not valid.")
        bounds = resolve_window_bounds(spec, values, now=ran_at, tz=tz)
        if isinstance(bounds, LookupNotApplicable):
            return bounds
        window_from, window_to = bounds
        if window_to > ran_at:
            window_to = ran_at
            window_clamped = True
        if window_to - window_from > MAX_WINDOW_SPAN:
            window_from = window_to - MAX_WINDOW_SPAN
            span_clamped = True
        if window_from >= window_to:
            if window_from >= ran_at:
                return LookupNotApplicable("The search window starts after now, so there is nothing to search yet.")
            return LookupNotApplicable("The search window is empty for this case: it starts after it ends.")

    return LookupBinding(
        tool=lookup.tool,
        filters=tuple(filters),
        group_by=tuple(lookup.group_by or ()),
        indicator=indicator,
        limit=limit,
        window_from=window_from,
        window_to=window_to,
        window_clamped=window_clamped,
        span_clamped=span_clamped,
        ran_at=ran_at,
        params=params,
        logical_group_by=tuple(g for g in (lookup.group_by or ()) if log_tool and is_logical_field(g)),
    )


# --------------------------------------------------------------------------- #
# Case values from stored records
# --------------------------------------------------------------------------- #
#: Case entity types (``EntityType``) to template kinds; a rule-keyed case has none.
ENTITY_TYPE_TO_KIND: dict[str, str] = {
    "ip": "ip", "user": "user", "host": "host", "domain": "domain", "file_hash": "hash",
}


def _from_millis(value: Any) -> datetime | None:
    try:
        millis = int(value or 0)
    except (TypeError, ValueError):
        return None
    if millis <= 0:
        return None
    try:
        return datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _from_iso(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _aware(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return _aware(datetime.fromisoformat(value.strip().replace("Z", "+00:00")))
    except ValueError:
        return None


def _merge_entities(
    primary: tuple[str, str] | None,
    extra: Mapping[str, Iterable[str]] | None,
) -> dict[str, tuple[str, ...]]:
    out: dict[str, list[str]] = {}
    if primary is not None:
        out.setdefault(primary[0], []).append(primary[1])
    for kind, items in (extra or {}).items():
        if kind not in ENTITY_TEMPLATE_KINDS:
            continue
        bucket = out.setdefault(kind, [])
        for item in items or ():
            if isinstance(item, str) and item.strip() and item not in bucket:
                bucket.append(item)
    return {k: tuple(v) for k, v in out.items() if v}


#: The event fields an entity value of each kind is read from, in order; an event
#: gives at most one value per kind (the first field present). IP, user and host are
#: the event's own projections (``RawEvent.ip``, ``.user``, ``.host``, read through
#: the source's field mapping). A case's primary entity is only ever an IP, a host, a
#: user or a rule (the correlation ladders), so a file hash, a domain, a URL or an
#: email address reaches a lookup only from the case's events:
#:
#: * hash: the fields the cross-source pass reads (``RawEvent._FILE_HASH_FIELDS``),
#:   lower case;
#: * domain: the cross-source domain fields (``RawEvent._DOMAIN_FIELDS``) except
#:   ``host.domain``, which names the host's own directory domain, never a domain the
#:   event observed (a destination, a link or a sender);
#: * url and email: the ECS fields that carry them.
EVENT_ENTITY_FIELDS: dict[str, tuple[str, ...]] = {
    "hash": ("file.hash.sha256", "file.hash.sha1", "file.hash.md5", "process.hash.sha256",
             "hash.sha256", "sha256", "data.sha256"),
    "domain": ("url.domain", "destination.domain", "dns.question.name", "domain", "data.domain"),
    "url": ("url.full", "url.original"),
    "email": ("email.from.address", "email.sender.address", "user.email"),
}
#: The kinds read from the event's projections rather than its fields.
_PROJECTED_KINDS: tuple[str, ...] = ("ip", "user", "host")
#: At most this many values of one kind are kept from a case's events (the most
#: frequent first); a template takes the first that passes its grammar.
ENTITY_VALUES_MAX_PER_KIND = 20


def _first_text(value: Any) -> str | None:
    """A field value as one string: the first item of a list (ECS keeps several
    addresses in one field), ``None`` for anything that is not text or a number."""
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (str, int, float)):
        text = str(value).strip()
        return text or None
    return None


def entity_values_from_events(events: Iterable[Any]) -> dict[str, list[str]]:
    """The entity values of a case's events, per template kind (``ip``, ``user``,
    ``host``, ``hash``, ``domain``, ``url``, ``email``), most frequent first, then by
    value; at most :data:`ENTITY_VALUES_MAX_PER_KIND` each. Pure: it reads only the
    events it is given (``RawEvent`` or anything with the same attributes and a
    ``source`` mapping). Values are untrusted and are checked against their kind's
    grammar only when a template resolves (:func:`resolve_template`).

    The run engine passes the result as ``extra`` to :func:`case_values_from_case`
    (the case's member events); :func:`case_values_from_cluster` uses it for the
    cluster's events."""
    counts: dict[str, dict[str, int]] = {kind: {} for kind in (*_PROJECTED_KINDS, *EVENT_ENTITY_FIELDS)}
    for event in events or ():
        for kind in _PROJECTED_KINDS:
            value = _first_text(getattr(event, kind, None))
            if value is not None:
                counts[kind][value] = counts[kind].get(value, 0) + 1
        source = getattr(event, "source", None)
        if not isinstance(source, Mapping):
            continue
        doc = source if isinstance(source, dict) else dict(source)
        for kind, paths in EVENT_ENTITY_FIELDS.items():
            for path in paths:
                value = _first_text(dotted_get(doc, path))
                if value is None:
                    continue
                if kind == "hash":
                    value = value.lower()
                counts[kind][value] = counts[kind].get(value, 0) + 1
                break
    return {
        kind: [v for v, _n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))][:ENTITY_VALUES_MAX_PER_KIND]
        for kind, c in counts.items()
        if c
    }


def event_time_span(events: Iterable[Any]) -> tuple[datetime | None, datetime | None]:
    """The earliest and the latest event time among ``events`` (each event's
    ``timestamp_millis``, when it is a positive time the calendar can hold), as UTC
    datetimes; ``(None, None)`` when no event has one. Pure."""
    millis: list[int] = []
    for event in events or ():
        raw = getattr(event, "timestamp_millis", None)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            continue
        if raw > 0 and _from_millis(raw) is not None:
            millis.append(int(raw))
    if not millis:
        return None, None
    return _from_millis(min(millis)), _from_millis(max(millis))


def _latest(*moments: datetime | None) -> datetime | None:
    known = [m for m in moments if m is not None]
    return max(known) if known else None


def _earliest(*moments: datetime | None) -> datetime | None:
    known = [m for m in moments if m is not None]
    return min(known) if known else None


def case_values_from_case(
    case: Any,
    *,
    extra: Mapping[str, Iterable[str]] | None = None,
    events: Iterable[Any] | None = None,
) -> CaseValues:
    """Best-effort :class:`CaseValues` for a stored :class:`app.models.Case`.

    The run engine passes ``events``, the case's member events it loaded. They give
    the case's real span: first seen is the earlier of ``first_seen_millis`` and the
    earliest event, last seen the latest event (:func:`event_time_span`). A Case has
    no last-seen field: without events, last seen is the end of the triggering window,
    else first seen, else the creation time. That is only a LOWER bound, because the
    triggering window is the densest window of the primary rule (or the newest
    batch's after a merge), not the case's last event, so a ``case_last_seen`` window
    would stop at the first burst and miss what came after. Pass the events whenever
    a lookup may run.

    The primary entity comes first; ``extra`` adds values for every kind, after it.
    A stored case carries one entity (an IP, a host or a user, or none for a
    rule-keyed case), so a lookup on ``{{entity.hash}}``, ``{{entity.domain}}``,
    ``{{entity.url}}`` or ``{{entity.email}}``, and on the case's other users and
    hosts, resolves only from its events: when ``extra`` is not given, it is
    ``entity_values_from_events(events)``."""
    events_list = list(events) if events is not None else None
    if extra is None and events_list is not None:
        extra = entity_values_from_events(events_list)
    entity = getattr(case, "entity", None)
    primary: tuple[str, str] | None = None
    if entity is not None:
        etype = getattr(getattr(entity, "type", None), "value", getattr(entity, "type", None))
        kind = ENTITY_TYPE_TO_KIND.get(str(etype or ""))
        if kind and isinstance(getattr(entity, "value", None), str):
            primary = (kind, entity.value)
    trigger = getattr(case, "trigger_reason", None)
    rule = (getattr(trigger, "rule_value", "") or "") if trigger is not None else ""
    if not rule:
        rule_ids = [r for r in (getattr(case, "rule_ids", None) or []) if isinstance(r, str) and r.strip()]
        rule = rule_ids[0] if rule_ids else ""
    first_seen = _from_millis(getattr(case, "first_seen_millis", 0))
    window_end = _from_millis(getattr(trigger, "window_end", 0)) if trigger is not None else None
    window_start = _from_millis(getattr(trigger, "window_start", 0)) if trigger is not None else None
    created = _from_iso(getattr(case, "created_at", None))
    events_first, events_last = event_time_span(events_list or ())
    first_seen = _earliest(first_seen, events_first)
    if first_seen is None:
        first_seen = window_start or created
    # Every known moment the case reached is a lower bound of its last event; the
    # latest event, when the events are given, is the best of them.
    last_seen = _latest(events_last, window_end, first_seen) or created
    return CaseValues(
        rule=rule or None,
        source_id=getattr(case, "source_id", None) or None,
        first_seen=first_seen,
        last_seen=last_seen,
        entities=_merge_entities(primary, extra),
    )


def case_values_from_cluster(cluster: Any) -> CaseValues:
    """:class:`CaseValues` for a correlated :class:`app.models.Cluster` before it is a
    case: the primary entity first, then the entity values of its member events
    (:func:`entity_values_from_events`: IPs, users, hosts, file hashes, domains, URLs
    and email addresses) by how often they occur. First and last seen span the
    cluster's ``first_seen_millis`` and ``last_seen_millis`` and its member events, so
    the same incident binds the same window here and through
    :func:`case_values_from_case` with its events."""
    entity = getattr(cluster, "entity", None)
    primary: tuple[str, str] | None = None
    if entity is not None:
        etype = getattr(getattr(entity, "type", None), "value", getattr(entity, "type", None))
        kind = ENTITY_TYPE_TO_KIND.get(str(etype or ""))
        if kind and isinstance(getattr(entity, "value", None), str):
            primary = (kind, entity.value)
    members = list(getattr(cluster, "member_events", None) or [])
    extra = entity_values_from_events(members)
    primary_rule = None
    try:
        primary_rule = cluster.primary_rule()
    except Exception:  # noqa: BLE001 - a malformed cluster has no primary rule
        primary_rule = None
    events_first, events_last = event_time_span(members)
    first_seen = _earliest(_from_millis(getattr(cluster, "first_seen_millis", 0)), events_first)
    last_seen = _latest(_from_millis(getattr(cluster, "last_seen_millis", 0)), events_last, first_seen)
    return CaseValues(
        rule=primary_rule or None,
        source_id=getattr(cluster, "source_id", None) or None,
        first_seen=first_seen,
        last_seen=last_seen,
        entities=_merge_entities(primary, extra),
    )


__all__ = [
    "BoundFilter",
    "CASE_CARRIED_ENTITY_KINDS",
    "CaseValues",
    "ENTITY_TEMPLATE_KINDS",
    "ENTITY_TYPE_TO_KIND",
    "ENTITY_VALUES_MAX_PER_KIND",
    "EVENT_ENTITY_FIELDS",
    "INDICATOR_TEMPLATE_VALUES",
    "LOGICAL_FILTER_VALUES",
    "LOOKUP_FIXED_FIELD_PATHS",
    "LOOKUP_LITERAL_MAX_CHARS",
    "LOOKUP_LOGICAL_FIELDS",
    "LOOKUP_MAX_CONCURRENT_PER_RUN",
    "LOOKUP_SETTING_KEYS",
    "LOOKUP_TIMEOUT_S",
    "LogicalFilterValue",
    "LookupBinding",
    "LookupNotApplicable",
    "MAX_WINDOW_SPAN",
    "RUNBOOK_MAX_ISSUES",
    "ResolvedValue",
    "TEMPLATE_NOUNS",
    "TEMPLATE_TOKEN_RE",
    "TOOL_RULES",
    "ToolRules",
    "WINDOW_FORMS",
    "WindowSpec",
    "bind_lookup",
    "case_values_from_case",
    "case_values_from_cluster",
    "entity_values_from_events",
    "event_time_span",
    "fixed_field_path",
    "is_field_name",
    "is_logical_field",
    "iso_utc",
    "parse_window",
    "resolve_template",
    "resolve_window_bounds",
    "suggest_template",
    "template_name",
    "template_names_in",
    "unknown_template_message",
    "valid_value",
    "validate_lookup",
]
