"""Anchored follow-up selection (Round 13 SPEC-chat §4.1, T4).

Every answer ends with at most three follow-up chips, chosen by :func:`select_follow_ups`
from two pools:

* the model's own ``follow_ups`` header chips, kept only when they are ANCHORED: they
  name something this answer shows (an entity value, a case by number or id, a rule,
  an ATT&CK technique, a source, a dimension, a metric or a window), or something a
  lookup of this answer asked for when it found nothing. A chip that names an ATT&CK
  technique this answer does not show is never anchored (the audit's T1110 chip after a
  T1190 answer, A13);
* deterministic, value-free chips built from the answer's artifacts ("Break this down
  by severity instead", "Compare this with the previous 7 days"). The model resolves
  "this answer" from the replay digest on the next turn.

Pure, deterministic and bounded: no I/O, no clock, no model call (#6); at most
:data:`MAX_MODEL_CHIPS` model chips are checked against at most :data:`MAX_ANCHORS`
anchors through one compiled pattern, so a hostile header cannot stall the event
loop. It runs in the engine's final assembly for every answer, live and in Demo (the
Demo planner is a provider behind the same engine). Anchors may be log-derived values:
they are only matched,
never copied into a chip, so a deterministic chip carries no log value; the one value
a deterministic chip may name is an ATT&CK technique id that passed the bundled-corpus
grammar. Chips keep ``origin: "follow_up"`` when sent (taint class unchanged, #9).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Mapping, Sequence

from ..constants import OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES
from .blocks import display_text
from .chat_starter_text import ref_value

#: At most this many chips per answer (``ChatResponse.follow_ups``).
MAX_FOLLOW_UPS = 3
#: Without data artifacts (product help, conversation) model chips are kept unchecked,
#: at most this many.
MAX_UNCHECKED = 2
#: Anchors shorter than this never anchor a chip (tokens of 3 characters or more).
ANCHOR_MIN_CHARS = 3
#: The top labels of a ranked artifact that become anchors.
ANCHOR_TOP_LABELS = 10
#: The longest chip kept (``ChatResponse`` bounds follow-ups the same way).
FOLLOW_UP_MAX_CHARS = 140
#: At most this many usable model chips are checked (at most 3 are ever shown), read
#: from at most :data:`MODEL_CHIPS_SCANNED` header entries: a prompt-injected header
#: with thousands of chips costs no more than one with three.
MAX_MODEL_CHIPS = 6
MODEL_CHIPS_SCANNED = 24
#: At most this many anchors per answer, in artifact order (the match runs as ONE
#: compiled pattern per answer, never one per chip and anchor).
MAX_ANCHORS = 200
#: An anchor longer than this never anchors a chip (a chip is at most 140 characters).
ANCHOR_MAX_CHARS = 120

#: Tools whose artifacts are product help, not data (no anchors, no deterministic chips).
PRODUCT_TOOLS = frozenset({"app_help", "app_status"})
#: Tools whose artifacts are reference text (the runbook library, knowledge search):
#: they anchor chips, but an answer that shows only reference is judged like product
#: help (its model chips are kept unchecked, at most two).
REFERENCE_TOOLS = frozenset({"search_knowledge"})
#: Tools that take a ``compare`` input (the "out" chips need one).
COMPARE_TOOLS = frozenset({"case_stats", "log_stats", "soc_metrics", "cost_usage"})

Direction = Literal["in", "out"]


@dataclass(frozen=True)
class ArtifactInfo:
    """What the selector reads of one artifact the answer shows: its kind and data
    (``Artifact.data``), the tool that produced it with that call's input, the window
    caption, and the source names the call read."""

    kind: str
    tool: str | None = None
    data: Mapping[str, Any] = field(default_factory=dict)
    window: str | None = None
    title: str | None = None
    params: Mapping[str, Any] = field(default_factory=dict)
    sources: tuple[str, ...] = ()
    #: The call that produced it matched nothing (its observation carries zero-result
    #: suggestions): its anchors count, but no deterministic chip is built from it
    #: ("Break this down by severity" over zero cases helps nobody).
    zero: bool = False
    #: Case display numbers by internal case id, from the same call's observation (a
    #: case list artifact carries only the id; the analyst and the model see the number).
    case_numbers: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_artifact(
        cls, artifact: Any, *, tool: str | None = None, params: Mapping[str, Any] | None = None,
        sources: Iterable[str] = (), zero: bool = False, case_numbers: Mapping[str, str] | None = None,
    ) -> "ArtifactInfo":
        data = getattr(artifact, "data", None)
        window = getattr(artifact, "window", None)
        title = getattr(artifact, "title", None)
        return cls(
            kind=str(getattr(artifact, "kind", "") or ""),
            tool=tool if isinstance(tool, str) else None,
            data=data if isinstance(data, Mapping) else {},
            window=window if isinstance(window, str) else None,
            title=title if isinstance(title, str) else None,
            params=params if isinstance(params, Mapping) else {},
            sources=tuple(s for s in sources if isinstance(s, str)),
            zero=bool(zero),
            case_numbers=case_numbers if isinstance(case_numbers, Mapping) else {},
        )

    @classmethod
    def from_lookup(
        cls, tool: str | None, params: Mapping[str, Any] | None, *, window: str | None = None,
        sources: Iterable[str] = (), case_numbers: Mapping[str, str] | None = None,
    ) -> "ArtifactInfo":
        """A lookup that ran but has nothing to show (it matched nothing, failed or was
        denied): the filter values it asked for, the window its result names and the
        sources it read still anchor chips (the answer is about that lookup), and no
        deterministic chip is built from it."""
        params = params if isinstance(params, Mapping) else {}
        values = [v for key, v in params.items() if key not in _NON_FILTER_INPUTS and isinstance(v, str)]
        return cls(
            kind="lookup", tool=tool if isinstance(tool, str) else None,
            data={"values": values[:_LOOKUP_VALUES]}, window=window if isinstance(window, str) else None,
            params=params, sources=tuple(s for s in sources if isinstance(s, str)), zero=True,
            case_numbers=case_numbers if isinstance(case_numbers, Mapping) else {},
        )

    @property
    def is_reference(self) -> bool:
        return self.kind != "guide" and self.tool in REFERENCE_TOOLS

    @property
    def is_data(self) -> bool:
        return self.kind != "guide" and self.tool not in PRODUCT_TOOLS and self.tool not in REFERENCE_TOOLS


@dataclass(frozen=True)
class FollowUpChip:
    """One deterministic chip: its text, whether it goes deeper into this answer
    (``in``) or widens it (``out``), and the tools its next turn needs."""

    text: str
    direction: Direction
    tools: tuple[str, ...] = ()


# --------------------------------------------------------------------------- #
# Labels (engine words only; never a log value).
# --------------------------------------------------------------------------- #
#: Entity fields a ranked categories artifact can be over, by normalised dimension key
#: (log_stats keys, their display labels and the entity kinds), with the chip's words.
ENTITY_FIELD_LABELS: dict[str, str] = {
    "ip": "source IP", "source_ip": "source IP", "src_ip": "source IP",
    "user": "user", "host": "host", "domain": "domain", "url": "URL", "hash": "file hash",
    "email": "email address", "process": "process",
}
#: The next dimensions a breakdown chip offers, per tool, in the SPEC order.
BREAKDOWN_DIMENSIONS: dict[str, tuple[tuple[str, str], ...]] = {
    "case_stats": (("severity", "severity"), ("rule", "rule"), ("verdict", "verdict"),
                   ("assignee", "assignee"), ("source", "source")),
    "log_stats": (("ip", "source IP"), ("user", "user"), ("host", "host"), ("action", "event action")),
}
#: Display labels a tool writes as an artifact ``dimension``, back to their group key.
_DIMENSION_KEYS: dict[str, str] = {
    "source_ip": "ip", "src_ip": "ip", "ip": "ip", "user": "user", "user_name": "user", "host": "host",
    "host_name": "host", "hostname": "host", "rule": "rule",
    "rule_name": "rule_name", "severity": "severity", "action": "action", "event_action": "action",
    "verdict": "verdict", "status": "status", "open_or_closed": "status_group",
    "status_group": "status_group", "priority": "priority", "assignee": "assignee", "source": "source",
    "surface": "surface", "disposition": "disposition", "tactic": "mitre_tactic",
    "technique": "mitre_technique", "mitre_tactic": "mitre_tactic", "mitre_technique": "mitre_technique",
    "decided_by": "decided_by", "closed_by": "closed_by",
}
#: The anchor words of a dimension (the words an analyst would use in a chip).
_DIMENSION_ANCHORS: dict[str, str] = {
    "ip": "source IP", "user": "user", "host": "host", "rule": "rule", "rule_name": "rule",
    "severity": "severity", "action": "action", "verdict": "verdict", "status": "status",
    "status_group": "status", "priority": "priority", "assignee": "assignee", "source": "source",
    "surface": "surface", "disposition": "disposition", "mitre_tactic": "tactic",
    "mitre_technique": "technique", "decided_by": "decided by", "closed_by": "closed by",
}
#: Entity kinds as the "What else did this {kind} do" chip names them.
ENTITY_KIND_WORDS: dict[str, str] = {
    "ip": "IP address", "host": "host", "user": "user", "domain": "domain", "url": "URL",
    "hash": "file", "email": "email address", "process": "process",
}
#: The widening ladder of the "Show the same for the {next window}" chip.
WINDOW_LADDER: tuple[str, ...] = (
    "last hour", "last 24 hours", "last 7 days", "last 30 days", "last 90 days", "all time",
)
_LADDER_ALIASES: dict[str, int] = {
    "last hour": 0, "last 1 hour": 0, "last 60 minutes": 0,
    "last 24 hours": 1, "last day": 1, "last 1 day": 1,
    "last 7 days": 2, "last week": 2, "last 1 week": 2,
    "last 30 days": 3, "last month": 3,
    "last 90 days": 4, "last 3 months": 4,
    "all time": 5,
}
_LAST_N_RE = re.compile(r"^last (\d{1,3}(?:,\d{3})*) (minute|hour|day|week|month|quarter|year)s?$")
_LAST_ONE_RE = re.compile(r"^(?:last|past) (minute|hour|day|week|month|quarter|year)$")
_THIS_RE = re.compile(r"^this (week|month|quarter|year)$")
_WINDOW_START_RE = re.compile(r"^(last |past |this |previous |today|yesterday|all time|since |until |week of |month of )")
_PARENTHETICAL_RE = re.compile(r"\s*\([^()]*\)\s*$")
_MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december"
_MONTH_ABBREVIATIONS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"
_DAY_LABEL = rf"\d{{1,2}} (?:{_MONTH_ABBREVIATIONS})"
_YEAR_LABEL = r"(?:19|20)\d{2}"
#: The calendar window labels the tools write (``engine.time_windows``), casefolded and
#: without a zone suffix: "october 2026", "q3 2026", "2025", "2026 to date", "w14 2026",
#: "14 sep 2026", "1 sep – 30 sep 2026" (an instant range adds "hh:mm" to each end).
_CALENDAR_LABEL_RE = re.compile(
    rf"^(?:(?P<month>(?:{_MONTH_NAMES}) {_YEAR_LABEL})"
    rf"|(?P<quarter>q[1-4] {_YEAR_LABEL})"
    rf"|(?P<year>{_YEAR_LABEL})"
    rf"|(?P<ytd>{_YEAR_LABEL} to date)"
    rf"|(?P<week>w\d{{2}} {_YEAR_LABEL})"
    rf"|(?P<day>{_DAY_LABEL} {_YEAR_LABEL})"
    rf"|(?P<range>{_DAY_LABEL}(?: {_YEAR_LABEL})?(?: \d{{2}}:\d{{2}})? [–-] {_DAY_LABEL} {_YEAR_LABEL}"
    rf"(?: \d{{2}}:\d{{2}})?))$"
)
#: The period a calendar label covers ("Compare this with the previous {period}"); a
#: year to date and an explicit range have none.
_CALENDAR_PERIODS = {"month": "month", "quarter": "quarter", "year": "year", "week": "week", "day": "day"}
#: A token that stands alone as an ATT&CK technique id ("T1110", "T1110.001"), never
#: one inside a longer token such as the host name "t1000-web01".
_TECHNIQUE_RE = re.compile(r"(?<![\w.-])T\d{4}(?:\.\d{3})?(?![\w-])(?!\.\d)", re.IGNORECASE)
_TRAILING_PUNCT = "?.!… "
#: Input keys of a lookup that are not filter values (windows, shapes, limits).
_NON_FILTER_INPUTS = frozenset({
    "window", "window_hours", "time_from", "time_to", "compare", "limit", "top_n", "sort_field",
    "sort_order", "bucket", "interval", "metrics", "group_by", "kind", "all_sources", "attention_limit",
    "include", "fields", "page", "offset", "view",
})
_LOOKUP_VALUES = 12
#: At most this many case id and number pairs of one lookup anchor (a case list
#: anchors at most twenty rows the same way), read from at most
#: :data:`_CASE_PAIRS_SCANNED` pairs (the engine keeps at most 100 per lookup).
_CASE_PAIRS = 20
_CASE_PAIRS_SCANNED = 100
#: At most this much of an answer's text is read for the cases it names.
ANSWER_SCANNED_CHARS = 64_000
#: A case number or id stands as a whole token: no word character, ".", ":", "/", "#"
#: or "-" joined to either side ("." may end a sentence after it). A number from any
#: valid template matches ("INC/2026/0042", "SOC#0042", "IR 0042"); a part of a longer
#: reference never does (``demo_chat._names_handle`` reads case handles the same way).
_REF_BEFORE = r"(?<![\w.:/#-])"
_REF_AFTER = r"(?![\w:/#-]|\.\w)"
#: Case-shaped whatever the numbering template: the default display number
#: ("CASE-000042") and the internal id the pipeline mints ("case-" and 32 hex digits).
_DEFAULT_CASE_SHAPES = (r"case-[0-9]+", r"case-[0-9a-f]{32}")
#: Entity facts whose values name what the card is about (the case, its rules, source
#: and assignee); the other facts are closed-vocabulary words.
_ANCHOR_FACTS = frozenset({"case", "rules", "rule", "source", "assignee"})
#: Table column types whose cells identify a row.
_ANCHOR_CELL_TYPES = frozenset({"case", "code", "entity"})
#: Labels the tools write for a remainder or a missing value (``stats.group_label``,
#: the top-N "Other" fold): engine words, never something the answer is about, so they
#: never anchor ("Do other SOC teams see this?" is not about an "Other" bar).
PLACEHOLDER_LABELS = frozenset({
    "other", "others", "(none)", "none", "(empty)", "empty", "unknown", "unassigned", "not closed", "no verdict",
    "no verdict yet", "not classified", "no severity", "no priority", "no rule", "default source",
    "no technique", "no tactic", "not decided",
})

_OPEN = frozenset(OPEN_CASE_STATUSES)
_CLOSED = frozenset(TERMINAL_CASE_STATUSES)


# --------------------------------------------------------------------------- #
# Normalisation and anchors.
# --------------------------------------------------------------------------- #
def normalise(text: Any) -> str:
    """Case-insensitive, whitespace-normalised display text ("" for a non-string)."""
    value = display_text(text, 0) if isinstance(text, str) else ""
    return " ".join(value.casefold().split())


def _same_key(text: Any) -> str:
    """The equality key of a chip or question: normalised, trailing punctuation off."""
    return normalise(text).rstrip(_TRAILING_PUNCT)


def _dimension_key(value: Any) -> str | None:
    """The group key of a dimension a tool wrote ("ip", "Source IP", "source.ip")."""
    if not isinstance(value, str):
        return None
    key = "_".join(value.strip().casefold().replace("-", " ").replace(".", " ").split())
    return _DIMENSION_KEYS.get(key)


def _window_labels(caption: str | None) -> list[str]:
    """The window labels inside an artifact caption ("44 cases · exact · last 24 hours"
    → ["last 24 hours"]); a bare label is itself. A dated or zoned label also yields its
    bare form ("last 7 days (since 11 oct 2026)" → "last 7 days", "september 2026
    (asia/kolkata)" → "september 2026"), the words a chip uses. Relative labels ("last
    7 days", "this week", "since 1 mar 2026") and calendar labels ("october 2026", "q3
    2026", "2026 to date", "1 sep – 30 sep 2026") both count."""
    out: list[str] = []
    for part in (caption or "").split(" · "):
        label = normalise(part)
        if not label:
            continue
        bare = _PARENTHETICAL_RE.sub("", label).strip()
        if _WINDOW_START_RE.match(label) or _CALENDAR_LABEL_RE.match(bare):
            out.append(label)
            if bare and bare != label:
                out.append(bare)
    return out


def _strings(values: Any, limit: int) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    return [v for v in values[:limit] if isinstance(v, str)]


def _labels_of(rows: Any, key: str, limit: int) -> list[str]:
    if not isinstance(rows, (list, tuple)):
        return []
    out: list[str] = []
    for row in rows[:limit]:
        if isinstance(row, Mapping) and isinstance(row.get(key), str):
            out.append(row[key])
    return out


def _cells(value: Any) -> list[str]:
    """A table cell as anchor strings: a comma list ("T1110, T1078") is split."""
    if not isinstance(value, str):
        return []
    return [part.strip() for part in value.split(",") if part.strip()] if "," in value else [value]


def _fact_values(facts: Any) -> list[str]:
    out: list[str] = []
    for fact in facts if isinstance(facts, (list, tuple)) else ():
        if isinstance(fact, Mapping) and str(fact.get("label") or "").casefold() in _ANCHOR_FACTS:
            out += _cells(fact.get("value"))
    return out


def _case_refs(case_id: Any, info: ArtifactInfo, number: Any = None) -> list[str]:
    """A case as the analyst may name it: its display number and its internal id."""
    out = [v for v in (number, info.case_numbers.get(case_id) if isinstance(case_id, str) else None)
           if isinstance(v, str)]
    if isinstance(case_id, str):
        out.append(case_id)
    return out


def _answer_words(answer_text: Any) -> str:
    """An answer's prose as the selector reads it: normalised, at most
    :data:`ANSWER_SCANNED_CHARS` read."""
    return normalise(answer_text[:ANSWER_SCANNED_CHARS]) if isinstance(answer_text, str) else ""


def _whole_refs(values: Iterable[str], *patterns: str) -> re.Pattern[str] | None:
    """ONE pattern matching any of ``values`` (normalised literals, longest first) or
    ``patterns`` (case-insensitive) as a whole case reference, or None for nothing."""
    unique = sorted({v for v in values if v}, key=lambda v: (-len(v), v))
    options = [re.escape(v) for v in unique] + [p for p in patterns if p]
    if not options:
        return None
    return re.compile(_REF_BEFORE + "(?:" + "|".join(options) + ")" + _REF_AFTER, re.IGNORECASE)


def _observed_pairs(artifacts: Sequence[ArtifactInfo]) -> list[tuple[str, str]]:
    """The normalised case id and number pairs the turn's lookups observed (at most
    :data:`_CASE_PAIRS_SCANNED` per lookup), in order."""
    out: list[tuple[str, str]] = []
    for info in artifacts:
        for case_id, number in list(info.case_numbers.items())[:_CASE_PAIRS_SCANNED]:
            if isinstance(case_id, str) and isinstance(number, str) and len(case_id) <= 160 and len(number) <= 160:
                out.append((normalise(case_id), normalise(number)))
    return out


def named_cases(answer_text: Any, candidates: Iterable[Any]) -> frozenset[str]:
    """The ``candidates`` (case numbers and ids, normalised) that an answer's own words
    name as whole tokens, Markdown marks around them or not ("**`CASE-000046`** (…)"
    names "case-000046"; so does "Start with `INC/2026/0042`" name "inc/2026/0042").
    Only the case number and id pairs the turn's lookups observed are candidates, so a
    case the prose invents never anchors anything."""
    words = _answer_words(answer_text)
    pattern = _whole_refs(normalise(c) for c in candidates if isinstance(c, str) and len(c) <= 160) if words else None
    if pattern is None:
        return frozenset()
    return frozenset(match.group(0) for match in pattern.finditer(words))


def _asked_cases(params: Mapping[str, Any]) -> set[str]:
    """The case a lookup was asked about (``get_case(case_id=…)``): its answer is about
    that case even when it shows only the case's figures."""
    value = params.get("case_id") if isinstance(params, Mapping) else None
    return {normalise(value)} if isinstance(value, str) and value.strip() else set()


def _artifact_anchors(info: ArtifactInfo, named: frozenset[str] = frozenset()) -> list[str]:
    data, kind = info.data, info.kind
    raw: list[str] = []
    if kind == "categories":
        raw += _strings(data.get("labels"), ANCHOR_TOP_LABELS)
    elif kind == "comparison":
        raw += _labels_of(data.get("rows"), "label", ANCHOR_TOP_LABELS)
        raw += _labels_of(data.get("periods"), "label", 8)
    elif kind == "series":
        series = data.get("series") if isinstance(data.get("series"), list) else []
        raw += _labels_of([s for s in series if not (isinstance(s, Mapping) and s.get("key") == "other")],
                          "label", ANCHOR_TOP_LABELS)
    elif kind == "kpis":
        raw += _labels_of(data.get("items"), "label", ANCHOR_TOP_LABELS)
    elif kind == "funnel":
        raw += _strings(data.get("stages"), ANCHOR_TOP_LABELS)
    elif kind == "heatmap":
        raw += _strings(data.get("y"), ANCHOR_TOP_LABELS)
        raw += [v for v in (data.get("x_label"), data.get("y_label")) if isinstance(v, str)]
    elif kind == "table":
        columns = data.get("columns") if isinstance(data.get("columns"), list) else []
        rows = data.get("rows") if isinstance(data.get("rows"), list) else []
        for index, column in enumerate(columns):
            if not isinstance(column, Mapping):
                continue
            if isinstance(column.get("label"), str):
                raw.append(column["label"])
            ctype = column.get("type") or "text"
            # Identifying cells: case, code and entity columns, and the row label (the
            # first column when it is text: a campaign, rule, source or group name).
            if ctype in _ANCHOR_CELL_TYPES or (index == 0 and ctype == "text"):
                for row in rows[:ANCHOR_TOP_LABELS]:
                    cell = row[index] if isinstance(row, (list, tuple)) and index < len(row) else None
                    raw += _cells(cell)
    elif kind == "case_list":
        for item in (data.get("items") or [])[:ANCHOR_TOP_LABELS * 2]:
            if isinstance(item, Mapping):
                raw += _case_refs(item.get("case_id"), info, item.get("case_number"))
    elif kind == "entity":
        entity = data.get("entity") if isinstance(data.get("entity"), Mapping) else {}
        if isinstance(entity.get("value"), str):
            raw.append(entity["value"])
        raw += _fact_values(data.get("facts"))
        for related in (data.get("related_cases") or [])[:ANCHOR_TOP_LABELS]:
            if isinstance(related, Mapping):
                raw += _case_refs(related.get("case_id"), info, related.get("case_number"))
    elif kind == "mitre":
        for technique in (data.get("techniques") or [])[:ANCHOR_TOP_LABELS * 2]:
            if isinstance(technique, Mapping):
                raw += [v for v in (technique.get("id"), technique.get("name")) if isinstance(v, str)]
    elif kind == "query":
        if isinstance(data.get("source_name"), str):
            raw.append(data["source_name"])
    elif kind == "lookup":
        raw += _strings(data.get("values"), _LOOKUP_VALUES)
        raw += [_DIMENSION_ANCHORS[key] for key in sorted(_input_dimensions(info.params))]
    dimension = _dimension_key(data.get("dimension"))
    if dimension is not None:
        raw.append(_DIMENSION_ANCHORS[dimension])
    elif isinstance(data.get("dimension"), str):
        raw.append(data["dimension"])
    # A case the same lookup observed anchors by display number AND internal id (a
    # case card or row names the number, while the question, a starter, an Ask AI chip
    # or the model may name the id: "Why does case case-0042 need a person?"), but only
    # when this answer shows it: this artifact names it, the lookup was asked about it,
    # or the answer's own words name it. A case the lookup merely observed (the shift
    # snapshot's attention queue behind an "Open cases by analyst" chart) is never an
    # anchor, so no chip offers to investigate a case the answer never mentions.
    shown = {normalise(v) for v in raw if isinstance(v, str)} | named | _asked_cases(info.params)
    kept = 0
    for case_id, number in list(info.case_numbers.items())[:_CASE_PAIRS_SCANNED]:
        if kept >= _CASE_PAIRS:
            break
        if not (isinstance(case_id, str) and isinstance(number, str)):
            continue
        if normalise(case_id) in shown or normalise(number) in shown:
            raw += _case_refs(case_id, info, number)
            kept += 1
    raw += _window_labels(info.window)
    raw += list(info.sources)
    return raw


def _anchor_values(artifacts: Sequence[ArtifactInfo], answer_text: Any) -> list[str]:
    """Every raw anchor value of the data and reference artifacts, in order (unbounded
    in count, each artifact bounded by its own limits)."""
    shown = [info for info in artifacts if info.is_data or info.is_reference]
    named = named_cases(answer_text, (v for pair in _observed_pairs(shown) for v in pair))
    return [value for info in shown for value in _artifact_anchors(info, named)]


def answer_anchors(artifacts: Sequence[ArtifactInfo], *, answer_text: str = "") -> list[str]:
    """The anchors of an answer: normalised, between :data:`ANCHOR_MIN_CHARS` and
    :data:`ANCHOR_MAX_CHARS` long, never an engine placeholder label ("Other",
    "Unassigned"), deduplicated in order and at most :data:`MAX_ANCHORS`. Data and
    reference artifacts contribute; product help does not. ``answer_text`` (the
    answer's prose) decides which observed cases the answer names (:func:`named_cases`)."""
    seen: dict[str, None] = {}
    for value in _anchor_values(artifacts, answer_text):
        if not isinstance(value, str) or len(value) > ANCHOR_MAX_CHARS * 2:
            continue
        anchor = normalise(value)
        if ANCHOR_MIN_CHARS <= len(anchor) <= ANCHOR_MAX_CHARS and anchor not in PLACEHOLDER_LABELS:
            seen.setdefault(anchor, None)
            if len(seen) >= MAX_ANCHORS:
                return list(seen)
    return list(seen)


def _techniques(text: str) -> list[str]:
    """The ATT&CK technique ids ``text`` names as standalone tokens (casefolded)."""
    return [t.casefold() for t in _TECHNIQUE_RE.findall(text)]


def _is_technique(tid: str) -> bool:
    upper = tid.upper()
    return ref_value("technique", upper) == upper


class _AnchorIndex:
    """One answer's anchors as ONE compiled whole-word pattern (a plural "s"/"es"
    allowed, so "low" never anchors "below"), plus the technique ids the answer shows
    (any anchor that names one, a table cell included)."""

    def __init__(self, anchors: Sequence[str]) -> None:
        unique = sorted({a for a in anchors if a}, key=lambda a: (-len(a), a))
        self.pattern = (re.compile(r"(?<!\w)(?:" + "|".join(re.escape(a) for a in unique) + r")(?:e?s)?(?!\w)")
                        if unique else None)
        shown = {t for anchor in unique for t in _techniques(anchor)}
        # A sub-technique and its parent are one topic (T1110.001 after a T1110 answer).
        self.techniques = shown | {t.split(".", 1)[0] for t in shown}

    def anchored(self, chip: str, *, question: str = "") -> bool:
        text = normalise(chip)
        if not text or self.pattern is None:
            return False
        asked = set(_techniques(normalise(question)))
        asked |= {t.split(".", 1)[0] for t in asked}
        for tid in _techniques(text):
            # A technique this answer does not show and the question did not name is
            # off topic (the T1110 chip after a T1190 answer, A13), whatever else the
            # chip names. Only an id the bundled corpus holds is a technique.
            parent = tid.split(".", 1)[0]
            if not ({tid, parent} & (self.techniques | asked)) and _is_technique(tid):
                return False
        return self.pattern.search(text) is not None


def is_anchored(chip: str, anchors: Sequence[str], *, question: str = "") -> bool:
    """True when ``chip`` names at least one anchor and no ATT&CK technique that is
    neither shown by an anchor nor in the current question."""
    return _AnchorIndex(anchors).anchored(chip, question=question)


# --------------------------------------------------------------------------- #
# Deterministic chips.
# --------------------------------------------------------------------------- #
def _period_of(label: str) -> str | None:
    """The period a window label covers, for "Compare this with the previous {period}"
    ("last 7 days" → "7 days", "this month" → "month", "today" → "day", "october 2026"
    → "month", "q3 2026" → "quarter", "2025" → "year"; "2026 to date" and a range
    → none)."""
    value = _PARENTHETICAL_RE.sub("", label).strip()
    if value in ("today", "yesterday"):
        return "day"
    calendar = _CALENDAR_LABEL_RE.match(value)
    if calendar is not None:
        return _CALENDAR_PERIODS.get(calendar.lastgroup or "")
    match = _LAST_N_RE.match(value)
    if match:
        count, unit = int(match.group(1).replace(",", "")), match.group(2)
        return unit if count == 1 else f"{match.group(1)} {unit}s"
    match = _LAST_ONE_RE.match(value) or _THIS_RE.match(value)
    return match.group(1) if match else None


def _next_window(label: str) -> str | None:
    value = _PARENTHETICAL_RE.sub("", label).strip()
    index = _LADDER_ALIASES.get(value)
    if index is None or index + 1 >= len(WINDOW_LADDER):
        return None
    return WINDOW_LADDER[index + 1]


def _show_same(window: str) -> str:
    return "Show the same for all time" if window == "all time" else f"Show the same for the {window}"


def suggestion_question(label: Any) -> str | None:
    """The follow-up question a zero-result suggestion label asks, in the words the
    console's zero-result chips send (webui ``suggestionQuestion``): "All time" →
    "Show the same for all time", "Without the rule filter" → "Show the same without
    the rule filter". Labels are engine templates, never model or log text."""
    if not isinstance(label, str) or not label.strip():
        return None
    value = label.strip()
    # Only the first letter is lowered: the label's own words keep their case
    # ("Without the source IP filter" → "…without the source IP filter").
    low = value[:1].lower() + value[1:]
    key = value.casefold()
    if key == "all time":
        return "Show the same for all time"
    if key == "all sources":
        return "Show the same across all sources"
    if key == "any severity":
        return "Show the same for any severity"
    if key.startswith("without the "):
        return f"Show the same {low}"
    if key.startswith("last "):
        return f"Show the same for the {low}"
    return f"Show the same for {low}"


_SHOW_SAME_RE = re.compile(r"^show the same (?:for the |for |across )?")
_WITHOUT_FILTER_RE = re.compile(r"^without the (.+) filter$")


def _widening_anchors(questions: Sequence[str]) -> list[str]:
    """What this answer's zero-result suggestions name, from their questions
    (:func:`suggestion_question`): "Show the same for the last 7 days" → "last 7 days";
    "Show the same without the source IP filter" → that phrase and "source ip"."""
    out: list[str] = []
    for question in questions:
        rest = _SHOW_SAME_RE.sub("", _same_key(question))
        if rest == _same_key(question):
            continue
        out.append(rest)
        match = _WITHOUT_FILTER_RE.match(rest)
        if match:
            out.append(match.group(1))
    return [a for a in out if ANCHOR_MIN_CHARS <= len(a) <= ANCHOR_MAX_CHARS]


def _input_dimensions(params: Mapping[str, Any]) -> set[str]:
    value = params.get("group_by")
    names = value if isinstance(value, (list, tuple)) else (value.split(",") if isinstance(value, str) else [])
    out: set[str] = set()
    for name in names:
        key = _dimension_key(name) if isinstance(name, str) else None
        if key is None and isinstance(name, str):
            key = _dimension_key(name.split(".")[-1])
        if key is not None:
            out.add(key)
    return out


def _has_compare(info: ArtifactInfo) -> bool:
    value = info.params.get("compare")
    return value not in (None, "", False, [], {})


def deterministic_chips(artifacts: Sequence[ArtifactInfo]) -> list[FollowUpChip]:
    """The value-free chips this answer's artifacts support, "in" chips in artifact
    order then "out" chips. Each names the tools its next turn needs."""
    data_artifacts = [a for a in artifacts if a.is_data and not a.zero]
    chips: list[FollowUpChip] = []
    compared = any(a.kind == "comparison" or (a.tool in COMPARE_TOOLS and _has_compare(a)) for a in data_artifacts)
    breakdown_done: set[str] = set()
    used_by_tool: dict[str, set[str]] = {}
    for info in data_artifacts:
        if info.tool in BREAKDOWN_DIMENSIONS:
            used = used_by_tool.setdefault(info.tool, set())
            used |= _input_dimensions(info.params)
            key = _dimension_key(info.data.get("dimension"))
            if key is not None:
                used.add(key)
    for info in data_artifacts:
        data = info.data
        if info.kind == "categories" and not data.get("ordered") and _strings(data.get("labels"), 1):
            dimension = data.get("dimension")
            raw_key = "_".join(dimension.strip().casefold().replace(".", " ").split()) if isinstance(dimension, str) else ""
            label = ENTITY_FIELD_LABELS.get(_dimension_key(dimension) or raw_key)
            if label is not None:
                chips.append(FollowUpChip(f"Investigate the top {label} in this answer", "in", ("search_logs",)))
        if info.tool in BREAKDOWN_DIMENSIONS and info.tool not in breakdown_done:
            breakdown_done.add(info.tool)
            used = used_by_tool.get(info.tool, set())
            nxt = next((label for key, label in BREAKDOWN_DIMENSIONS[info.tool] if key not in used), None)
            if nxt is not None:
                chips.append(FollowUpChip(f"Break this down by {nxt} instead", "in", (info.tool,)))
        if info.kind == "case_list":
            statuses = {str(item.get("status") or "") for item in data.get("items") or [] if isinstance(item, Mapping)}
            if statuses & _OPEN and statuses & _CLOSED:
                chips.append(FollowUpChip(
                    "Which of these cases are still open, and who has them?", "in", ("search_cases",)))
        if info.kind == "mitre":
            for technique in data.get("techniques") or []:
                tid = technique.get("id") if isinstance(technique, Mapping) else None
                if isinstance(tid, str) and ref_value("technique", tid) == tid:
                    chips.append(FollowUpChip(
                        f"Explain {tid} and whether other cases show it", "in", ("mitre_lookup", "search_cases")))
                    break
        if info.kind == "entity":
            entity = data.get("entity") if isinstance(data.get("entity"), Mapping) else {}
            word = ENTITY_KIND_WORDS.get(str(entity.get("kind") or ""))
            if word is not None and isinstance(entity.get("value"), str) and entity["value"]:
                chips.append(FollowUpChip(f"What else did this {word} do in the last 7 days?", "in", ("search_logs",)))
    for info in data_artifacts:
        if info.kind not in ("series", "kpis", "categories") or info.tool not in COMPARE_TOOLS:
            continue
        windows = _window_labels(info.window)
        if not windows:
            continue
        if compared:
            nxt = _next_window(windows[-1])
            if nxt is not None:
                chips.append(FollowUpChip(_show_same(nxt), "out", (info.tool,)))
        else:
            period = _period_of(windows[-1])
            if period is not None:
                chips.append(FollowUpChip(f"Compare this with the previous {period}", "out", (info.tool,)))
    return chips


# --------------------------------------------------------------------------- #
# Selection.
# --------------------------------------------------------------------------- #
def _clean_chip(value: Any) -> str:
    """A model chip as the response shows it: display-sanitised, single line; a chip
    over :data:`FOLLOW_UP_MAX_CHARS` is dropped, never cut into a different question."""
    if not isinstance(value, str) or len(value) > FOLLOW_UP_MAX_CHARS * 4:
        return ""
    text = display_text(value, 0)
    return text if 0 < len(text) <= FOLLOW_UP_MAX_CHARS else ""


def _compiles(pattern: Any) -> bool:
    """A non-empty regular expression that compiles (a bad one is ignored)."""
    if not isinstance(pattern, str) or not pattern or len(pattern) > 2_000:
        return False
    try:
        re.compile(pattern)
    except re.error:
        return False
    return True


class _CaseRefs:
    """The cases an answer shows, for the rule that a follow-up names a case only when
    this answer shows it (SPEC §4.1, polish round PB4): a case an artifact names (a case
    list row, an entity card's Case fact or related case, a case cell), the case a
    lookup was asked about, and a case the answer's own words name. A case is one
    observed number and id pair (either form shows it), else the reference itself."""

    def __init__(self, artifacts: Sequence[ArtifactInfo], answer_text: Any,
                 case_number_pattern: str | None) -> None:
        self.words = _answer_words(answer_text)
        self.shown = {normalise(v) for v in _anchor_values(artifacts, answer_text) if isinstance(v, str)}
        self.pairs: dict[str, tuple[str, str]] = {}
        for pair in _observed_pairs(artifacts):
            for value in pair:
                self.pairs.setdefault(value, pair)
        shapes = list(_DEFAULT_CASE_SHAPES)
        if _compiles(case_number_pattern):
            shapes.insert(0, f"(?:{case_number_pattern})")
        self.pattern = _whole_refs(self.pairs, *shapes)

    def _said(self, value: str) -> bool:
        pattern = _whole_refs((value,))
        return bool(self.words) and pattern is not None and pattern.search(self.words) is not None

    def names_unshown(self, chip: str) -> bool:
        """True when ``chip`` names a case reference this answer does not show."""
        text = normalise(chip)
        if not text or self.pattern is None:
            return False
        for match in self.pattern.finditer(text):
            ref = match.group(0)
            if ref.isdigit():
                # A bare number ("{seq}" numbering) cannot be told from a count in a
                # chip's words ("the top 5 rules"): it is never taken for a case here.
                continue
            forms = self.pairs.get(ref, (ref,))
            if not any(form in self.shown or self._said(form) for form in forms):
                return True
        return False


def select_follow_ups(
    model_chips: list[str],
    artifacts: Sequence[ArtifactInfo],
    *,
    question: str,
    earlier_questions: Sequence[str],
    allowed_tools: frozenset[str],
    answer_kind: str,
    widening: Sequence[str] = (),
    answer_text: str = "",
    case_number_pattern: str | None = None,
) -> list[str]:
    """Up to three follow-up chips for one answer (SPEC §4.1):

    1. anchors come from the data and reference artifacts the answer shows, and from
       the lookups it ran that show nothing (``ArtifactInfo.from_lookup``); a case a
       lookup observed anchors only when the answer shows it (an artifact or
       ``answer_text`` names it, or the lookup was asked about it);
    2. a model chip is kept only when anchored; without data artifacts (product help,
       conversation, or reference only: the runbook library, knowledge) model chips are
       kept unchecked, at most two. A chip that asks one of ``widening`` (the questions
       of this answer's own zero-result suggestions, :func:`suggestion_question`) is
       anchored: it re-runs this answer's lookup;
    3. deterministic chips come from the artifacts;
    4. slot 1 is the first anchored model chip, else a deterministic "in" chip; slot 2
       the next anchored model chip, else an unused "in" chip; slot 3 a deterministic
       "out" chip, else the next anchored model chip;
    5. a chip equal (normalised) to the current question, an earlier question or
       another chip is dropped, and so is a deterministic chip whose tools the caller
       cannot run;
    6. a model chip that names a case this answer does not show (an artifact or the
       answer's words) is dropped, checked or not: a case a lookup observed, by number
       or id, and any case-shaped reference (``case_number_pattern``, the configured
       numbering template's numbers, the default "CASE-000042" and the internal id).
    """
    blocked = {_same_key(question)} | {_same_key(q) for q in earlier_questions if isinstance(q, str)}
    blocked.discard("")
    seen: set[str] = set()

    def fresh(text: str) -> bool:
        key = _same_key(text)
        if not key or key in blocked or key in seen:
            return False
        return True

    model: list[str] = []
    model_keys: set[str] = set()
    # Bounded whatever the header holds: at most MODEL_CHIPS_SCANNED entries are read
    # and MAX_MODEL_CHIPS usable ones are checked (at most three are shown).
    for chip in model_chips[:MODEL_CHIPS_SCANNED] if isinstance(model_chips, (list, tuple)) else ():
        text = _clean_chip(chip)
        key = _same_key(text)
        if text and key not in blocked and key not in model_keys:
            model_keys.add(key)
            model.append(text)
            if len(model) >= MAX_MODEL_CHIPS:
                break

    # Product help never carries data artifacts (the engine enforces it); any other
    # stated kind is judged by what the answer actually shows. A lookup that ran but
    # shows nothing (``ArtifactInfo.from_lookup``) still makes it a data answer.
    data_artifacts = [] if answer_kind == "product_help" else [a for a in artifacts if a.is_data]
    if not data_artifacts:
        # Unchecked, but never about a case the answer does not show (product help and
        # conversation show none, so only a case their words name stays).
        cases = _CaseRefs([a for a in artifacts if a.is_reference], answer_text, case_number_pattern)
        return [c for c in model if not cases.names_unshown(c)][:MAX_UNCHECKED]

    widen_list = [w for w in list(widening)[:MODEL_CHIPS_SCANNED] if isinstance(w, str)]
    widen = {_same_key(w) for w in widen_list}
    # The zero-result chips are shown in the same row, so what they name anchors too
    # ("Same for the last 7 days" names the "Last 7 days" suggestion).
    shown = [a for a in artifacts if a.is_data or a.is_reference]
    cases = _CaseRefs(shown, answer_text, case_number_pattern)
    index = _AnchorIndex(_widening_anchors(widen_list) + answer_anchors(shown, answer_text=answer_text))
    anchored = [c for c in model if (_same_key(c) in widen or index.anchored(c, question=question))
                and not cases.names_unshown(c)]
    usable = [c for c in deterministic_chips(data_artifacts)
              if all(t in allowed_tools for t in c.tools)]
    inward = [c.text for c in usable if c.direction == "in"]
    outward = [c.text for c in usable if c.direction == "out"]

    def take(queue: list[str]) -> str | None:
        while queue:
            text = queue.pop(0)
            if fresh(text):
                seen.add(_same_key(text))
                return text
        return None

    chosen: list[str] = []
    for first, second in ((anchored, inward), (anchored, inward), (outward, anchored)):
        picked = take(first) or take(second)
        if picked is not None:
            chosen.append(picked)
    return chosen[:MAX_FOLLOW_UPS]


__all__ = [
    "ANCHOR_MIN_CHARS",
    "ANCHOR_TOP_LABELS",
    "ArtifactInfo",
    "BREAKDOWN_DIMENSIONS",
    "COMPARE_TOOLS",
    "ENTITY_FIELD_LABELS",
    "ENTITY_KIND_WORDS",
    "FollowUpChip",
    "MAX_ANCHORS",
    "MAX_FOLLOW_UPS",
    "MAX_MODEL_CHIPS",
    "MAX_UNCHECKED",
    "PLACEHOLDER_LABELS",
    "REFERENCE_TOOLS",
    "WINDOW_LADDER",
    "answer_anchors",
    "deterministic_chips",
    "is_anchored",
    "named_cases",
    "normalise",
    "select_follow_ups",
    "suggestion_question",
]
