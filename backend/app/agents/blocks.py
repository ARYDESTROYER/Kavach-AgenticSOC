"""Answer blocks: the validated presentation contract of a chat answer.

Chat revamp SPEC §7 and ``docs/research/2026-10-chat-revamp/BLOCKS.md`` (v2
amendments win, then the spec, then the catalogue). A block is inert DATA: a chart,
a KPI row, a table, a case list, a timeline, an entity card, ATT&CK techniques, a
query, a callout, citations, an app-help guide, Markdown prose, or a ``report``
envelope of those. Nothing in a block can trigger a mutation (G10), and every string
in one is plain text that the client renders as a text node (G1/G2).

What this module owns:

* Pydantic v2 models for every block type (``extra="forbid"``), with the SPEC §7.4
  limits declared as field constraints so they reach ``openapi.json``.
* :func:`validate_blocks` — the single server-side choke point a live answer's
  blocks pass through before they are returned or persisted. It REPAIRS what can be
  repaired (strings are display-sanitised and clamped, lists are clipped with
  ``truncated: true``, non-finite numbers become ``null`` = not measured, series are
  aligned to their x axis, an unknown fallback-able enum takes its fallback) and
  DROPS what cannot (an unknown ``type``, a missing required field, a data block
  whose provenance is ``ai``). It never raises. Provenance is whatever the caller
  passes, so model output is validated with ``model_authored=True`` (or enters only
  as refs through :func:`parse_final_block_requests`/:func:`to_blocks`).
* :func:`parse_persisted_blocks` — the lenient replay form for STORED blocks (whose
  provenance it trusts). It never raises either, and it keeps every position (an
  invalid stored block becomes a fallback callout) so ``mK.bJ`` references from the
  history digest stay stable.
* :data:`ALLOWED_VIEWS` / :data:`DEFAULT_VIEW` (SPEC §7.3) and the enums, pinned to the
  webui ``schema.ts`` by ``webui/src/soc/chat/blocks/answer-blocks.contract.json``.
* :func:`display_text` — the server-side twin of the webui ``displayText()``.
* The typed requests the model's ``final`` header may carry (``{"ref": "t2.a1", ...}``,
  model-written ``callout``/``markdown``, the ``report`` envelope) and their
  materialisation: :func:`to_blocks` (artifact → block in a view), :func:`revise_view`
  (``mK.bJ``: a stored block in another view) and :func:`materialise_final_blocks`
  (a whole final header, report envelopes included).

Provenance rule (G5): numbers are materialised only from tool artifacts
(``provenance: code|source``). A block whose provenance is ``ai`` may only be prose
(``markdown``), a ``callout`` or the structural ``report`` envelope; any other ``ai``
block is dropped, so a number the model typed can never be charted. Model output
never gets to claim ``code``: it is either a ref the engine resolves or validated
with ``model_authored=True``, which overwrites its provenance first.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass, field
from types import SimpleNamespace
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Any, Iterable, Literal, Union, get_args

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
    model_validator,
)

from ..constants import INVISIBLE_TEXT_CLASS

if TYPE_CHECKING:  # the tool contract imports this module for its enums
    from .chat_tools.base import Artifact

# --------------------------------------------------------------------------- #
# Versions and limits (SPEC §7.4, BLOCKS.md §5.4). The webui clamps the same values.
# --------------------------------------------------------------------------- #
ANSWER_BLOCKS_MAJOR = 1
BLOCKS_VERSION = 1

MAX_BLOCKS_PER_MESSAGE = 12           # a report envelope counts as one
# A report ``section`` item snapshots a whole answer: its Markdown prose as one
# block, then up to MAX_BLOCKS_PER_MESSAGE of that turn's blocks (SPEC §9.1).
MAX_SECTION_BLOCKS = MAX_BLOCKS_PER_MESSAGE + 1
MAX_REPORT_SECTIONS = 12
MAX_REPORT_LEAVES = 40
MAX_BLOCKS_BYTES_TARGET = 40_000
MAX_BLOCKS_BYTES = 48_000             # hard: trailing blocks past this are dropped
MAX_SERIES = 8                        # 7 + "Other"
MAX_POINTS = 200                      # per series (the materialiser downsamples first)
MAX_DONUT_SEGMENTS = 6
MAX_TABLE_COLUMNS = 12
MAX_TABLE_ROWS = 200
MAX_CELL_CHARS = 500
MAX_HEATMAP_X = 48
MAX_HEATMAP_Y = 24
MAX_TITLE = 120
MAX_LABEL = 60
MAX_CAPTION = 280
MAX_CALLOUT = 600
MAX_MARKDOWN = 12_000
MAX_FALLBACK = 2_000
MAX_KPI_ITEMS = 6
MAX_TREND_POINTS = 60
MAX_CASE_LIST = 25
MAX_TIMELINE = 50
MAX_ENTITY_FACTS = 12
MAX_REPUTATION = 12
MAX_ENTITY_COUNTS = 4
MAX_RELATED_CASES = 5
MAX_MITRE = 60
MAX_QUERY_CHARS = 4_000
MAX_CITATION_ITEMS = 20
MAX_GUIDE_STEPS = 10
MAX_GUIDE_LINKS = 6
MAX_CATEGORY_CHARS = 200              # an x category / heatmap label keeps the full value
MAX_VALUE_CHARS = 512                 # an entity value (URL, hash, host)
MAX_DETAIL_CHARS = 500
MAX_SNIPPET = 280
MAX_SECTION_SUMMARY = 1_200
MAX_SOURCES = 20
MAX_TIMESTAMP_CHARS = 40

# Compact storage form (SPEC §7.5 / amendment 7): what a persisted answer keeps.
STORED_TABLE_ROWS = 25
STORED_SERIES_POINTS = 100
STORED_QUERY_CHARS = 1_000

FALLBACK_TEXT = "This part of the answer could not be displayed"
EXPIRED_TEXT = "Expired from saved history"

# --------------------------------------------------------------------------- #
# Enums (pinned by answer-blocks.contract.json; keep in sync with schema.ts).
# --------------------------------------------------------------------------- #
BlockType = Literal[
    "markdown", "kpi_group", "chart", "heatmap", "table", "case_list", "timeline",
    "entity", "mitre", "query", "callout", "citations", "guide", "report",
]
ChartKind = Literal["bar", "hbar", "stacked_bar", "line", "area", "donut", "sparkline", "funnel"]
ValueUnit = Literal[
    "count", "percent", "ratio", "score", "ms", "seconds", "minutes", "hours", "usd",
    "tokens", "bytes",
]
ColumnType = Literal[
    "text", "number", "time", "severity", "verdict", "status", "risk", "case", "entity",
    "mitre", "code",
]
ToneKey = Literal["info", "success", "warning", "critical"]
BlockProvenance = Literal["code", "source", "ai"]
ArtifactKind = Literal[
    "table", "kpis", "series", "categories", "funnel", "heatmap", "case_list", "timeline",
    "entity", "mitre", "guide", "query",
]
BlockView = Literal[
    "bar", "hbar", "stacked_bar", "line", "area", "donut", "sparkline", "funnel",
    "kpi_group", "table", "heatmap", "case_list", "timeline", "entity", "mitre", "guide",
    "query",
]
KpiDisplay = Literal["value", "gauge"]
SeverityKey = Literal["critical", "high", "medium", "low", "info"]
# The palette STATUS axis (webui palette.ts STATUS_COLOR) — used for colour semantics.
StatusKey = Literal["new", "investigating", "escalated", "on_hold", "resolved", "closed"]
# A case's lifecycle value as stored (CaseStatus): the StatusBadge renders all of them.
CaseStatusKey = Literal[
    "new", "open", "needs_human", "investigating", "escalated", "on_hold", "resolved", "closed",
]
VerdictKey = Literal[
    "true_positive", "false_positive", "benign", "needs_human", "suspicious", "duplicate",
    "undetermined",
]
EntityKind = Literal["ip", "domain", "url", "hash", "host", "user", "email", "process"]
ReputationVerdict = Literal["malicious", "suspicious", "clean", "unknown"]
TimelineKind = Literal["alert", "detection", "case", "action", "note"]
CitationBlockKind = Literal["runbook", "mitre", "case", "docs", "memory", "knowledge", "log"]
QueryLanguage = Literal["kql", "lucene", "esql", "dsl", "sql"]
XKind = Literal["category", "time"]
TimeBucket = Literal["1m", "5m", "15m", "1h", "6h", "1d", "1w"]
GoodDirection = Literal["up", "down", "none"]
ReportTemplate = Literal["investigation", "hunt", "ioc", "shift", "posture", "custom"]
# The InternalRef ``status`` opt mirrors the webui ``isSafeCaseResultStatus``.
NavStatus = Literal[
    "active", "new", "open", "needs_human", "investigating", "escalated", "on_hold",
    "resolved", "closed",
]

BLOCK_TYPES: tuple[str, ...] = get_args(BlockType)
CHART_KINDS: tuple[str, ...] = get_args(ChartKind)
VALUE_UNITS: tuple[str, ...] = get_args(ValueUnit)
COLUMN_TYPES: tuple[str, ...] = get_args(ColumnType)
TONES: tuple[str, ...] = get_args(ToneKey)
PROVENANCES: tuple[str, ...] = get_args(BlockProvenance)
ARTIFACT_KINDS: tuple[str, ...] = get_args(ArtifactKind)
BLOCK_VIEWS: tuple[str, ...] = get_args(BlockView)
KPI_DISPLAYS: tuple[str, ...] = get_args(KpiDisplay)
SEVERITY_KEYS: tuple[str, ...] = get_args(SeverityKey)
STATUS_KEYS: tuple[str, ...] = get_args(StatusKey)
CASE_STATUS_KEYS: tuple[str, ...] = get_args(CaseStatusKey)
VERDICT_KEYS: tuple[str, ...] = get_args(VerdictKey)
SEMANTIC_KEYS: tuple[str, ...] = tuple(dict.fromkeys(SEVERITY_KEYS + STATUS_KEYS + VERDICT_KEYS))
# Any severity / status / verdict palette key (webui ``SemanticKey``).
SemanticKey = Literal[SEMANTIC_KEYS]  # type: ignore[valid-type]
ENTITY_KINDS: tuple[str, ...] = get_args(EntityKind)
REPUTATION_VERDICTS: tuple[str, ...] = get_args(ReputationVerdict)
TIMELINE_KINDS: tuple[str, ...] = get_args(TimelineKind)
CITATION_BLOCK_KINDS: tuple[str, ...] = get_args(CitationBlockKind)
QUERY_LANGUAGES: tuple[str, ...] = get_args(QueryLanguage)
X_KINDS: tuple[str, ...] = get_args(XKind)
TIME_BUCKETS: tuple[str, ...] = get_args(TimeBucket)
GOOD_DIRECTIONS: tuple[str, ...] = get_args(GoodDirection)
REPORT_TEMPLATES: tuple[str, ...] = get_args(ReportTemplate)
NAV_STATUSES: tuple[str, ...] = get_args(NavStatus)

# The only block types the MODEL may author (provenance "ai"); see the module note.
AI_AUTHORED_TYPES: frozenset[str] = frozenset({"markdown", "callout", "report"})

# SPEC §7.3: artifact kind → the views the client may switch between without a model
# call. The FIRST entry of every row is the default view (DEFAULT_VIEW is derived),
# which is also the order the tool-call header lists them in. ``donut`` is offered
# only while the categories fit in MAX_DONUT_SEGMENTS (the materialiser drops it).
ALLOWED_VIEWS: dict[str, tuple[str, ...]] = {
    "categories": ("hbar", "bar", "donut", "table"),
    "series": ("line", "area", "bar", "stacked_bar", "sparkline", "table"),
    "funnel": ("funnel", "hbar", "table"),
    "kpis": ("kpi_group", "table"),
    "table": ("table",),
    "heatmap": ("heatmap", "table"),
    "case_list": ("case_list", "table"),
    "timeline": ("timeline", "table"),
    "entity": ("entity",),
    "mitre": ("mitre",),
    "guide": ("guide",),
    "query": ("query",),
}
DEFAULT_VIEW: dict[str, str] = {kind: views[0] for kind, views in ALLOWED_VIEWS.items()}
# A view is either a chart kind (block type "chart") or a block type of the same name.
VIEW_BLOCK_TYPE: dict[str, str] = {
    view: ("chart" if view in CHART_KINDS else view) for view in BLOCK_VIEWS
}

# --------------------------------------------------------------------------- #
# Patterns (also pinned in the contract file; JS RegExp-compatible on purpose).
# --------------------------------------------------------------------------- #
BLOCK_ID_PATTERN = r"^[a-z0-9][a-z0-9_.-]{0,47}$"
KEY_PATTERN = r"^[A-Za-z0-9_.:@-]{1,64}$"
PAGE_PATTERN = r"^[a-z][a-z_]{0,39}$"
ROUTE_TOKEN_PATTERN = r"^[A-Za-z0-9_.:@ -]{1,128}$"     # webui isSafeRouteToken
CASE_ID_PATTERN = r"^[A-Za-z0-9_.:@ /-]{1,128}$"        # webui isSafeCaseId
# A same-origin Help Center path (BLOCKS.md amendment 5, relaxed in wave 3): the
# version line, then zero or more lowercase segments, an optional trailing slash and an
# optional anchor. A segment is dot-separated runs of ``[a-z0-9_-]`` so dotted release
# pages (``releases/0.1.13/``) and the home (``/docs/0.1/``) are citable, while ``.`` and
# ``..`` segments, empty segments (``//``), schemes, hosts, queries, uppercase,
# percent-encoding and backslashes can never match. No look-around: Pydantic validates
# ``pattern`` with the Rust regex engine, and the webui compiles the same source. Every
# repetition is separator-led, so matching is linear. ``[0-9]`` rather than ``\d`` so
# Python and Rust (Unicode digits) accept exactly what JavaScript does. Accept/reject
# vectors are pinned in the shared contract file (``doc_ref_examples``).
DOC_REF_PATTERN = (
    r"^/docs/[0-9]{1,4}\.[0-9]{1,4}/"
    r"(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:/[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)*/?)?"
    r"(?:#[a-z0-9_-]+)?$"
)
TECHNIQUE_PATTERN = r"^T\d{4}(\.\d{3})?$"
SECTION_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"
# Logs deep-link opts (SPEC §10.7, "Open in Logs"): EXACTLY the webui router's
# ``DEEP_LINK_KEYS.logs`` grammar (``soc/router.tsx``), ASCII classes spelled out so
# Python, Rust (Pydantic) and JavaScript agree. A source id is the backend's plain-id
# grammar; a time bound is ``now``, ``now-<n>[mhdw]`` or an ISO-8601 shape with no
# space (a hand-typed ``+05:00`` reaching URLSearchParams as a space must fail closed);
# a log query is 1..512 code points with no control, format, unassigned, private-use or
# surrogate character and no line/paragraph separator (``[^\p{C}\u2028\u2029]``).
NAV_ID_PATTERN = r"^[A-Za-z0-9_.:-]{1,128}$"
NAV_TIME_PATTERN = r"^(?:now(?:-[0-9]{1,5}[mhdw])?|[0-9]{4}-[0-9]{2}-[0-9]{2}[0-9Tt:.Zz+-]{0,24})$"
MAX_LOG_QUERY_CHARS = 512
# An ISO-8601 calendar date, optionally with a time, optionally with a zone (a zone
# needs a time). ``[0-9]`` rather than ``\d`` so Python, which matches any Unicode
# digit with ``\d``, accepts exactly what JavaScript does. Pinned for both sides: on
# its own, Python's ``fromisoformat`` also takes basic format (``20261008T101010Z``)
# and week dates (``2026-W41-3``), which the client rejects, so a server-kept
# timestamp would have rendered as a fallback. The pattern also bounds every clock
# field and the offset (Python alone takes a "+05:60" offset); only the day-in-month
# and year 0 are left to code (``fromisoformat`` here, ``parseTimestamp`` there).
TIMESTAMP_PATTERN = (
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"(?:[Tt ](?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,9})?)?"
    r"(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])?)?$"
)

_BLOCK_ID_RE = re.compile(BLOCK_ID_PATTERN)
_KEY_RE = re.compile(KEY_PATTERN)
_ROUTE_TOKEN_RE = re.compile(ROUTE_TOKEN_PATTERN)
_CASE_ID_RE = re.compile(CASE_ID_PATTERN)
_DOC_REF_RE = re.compile(DOC_REF_PATTERN)
_TECHNIQUE_RE = re.compile(TECHNIQUE_PATTERN)
_PAGE_RE = re.compile(PAGE_PATTERN)
TIMESTAMP_RE = re.compile(TIMESTAMP_PATTERN)

# --------------------------------------------------------------------------- #
# Display sanitiser (BLOCKS.md amendment 4; the twin of webui displayText()).
# --------------------------------------------------------------------------- #
_INVISIBLE_RE = re.compile(f"[{INVISIBLE_TEXT_CLASS}]")
# Python strings can hold a LONE surrogate (from a JSON "\\ud800" escape); it cannot
# be encoded to UTF-8, so it would break the response serialiser. Valid astral
# characters are single code points in Python, so this only ever hits lone halves.
_SURROGATE_RE = re.compile("[\ud800-\udfff]")
_LINE_BREAKS_RE = re.compile(r"[\t\r\n]+")
ELLIPSIS = "…"


def strip_lone_surrogates(value: Any) -> Any:
    """``value`` with unpaired UTF-16 surrogate halves removed from every string,
    recursing through dicts and lists (non-string leaves are returned as is).

    A JSON ``"\\ud800"`` escape in model or log text decodes to a lone surrogate.
    Pydantic rejects it (``string_unicode``) and UTF-8 cannot encode it, so one stray
    escape would otherwise abort a live stream or a history write mid-turn."""
    if isinstance(value, str):
        return _SURROGATE_RE.sub("", value) if _SURROGATE_RE.search(value) else value
    if isinstance(value, dict):
        return {strip_lone_surrogates(k): strip_lone_surrogates(v) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_lone_surrogates(v) for v in value]
    if isinstance(value, tuple):
        return tuple(strip_lone_surrogates(v) for v in value)
    return value


def _js_number_text(value: int | float) -> str:
    """``String(value)`` as JavaScript writes a finite number (ECMAScript
    Number::toString), so a number shown through :func:`display_text` reads the same
    on both sides: ``1.0`` is ``"1"``, ``1e-07`` is ``"1e-7"``, ``1e21`` is ``"1e+21"``."""
    if isinstance(value, int):
        return str(value)
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # ``repr`` is the shortest round-trip digit string, which is also what JS uses.
    shortest = Decimal(repr(abs(value))).normalize().as_tuple()
    digits = "".join(map(str, shortest.digits))
    k = len(digits)
    n = int(shortest.exponent) + k   # the decimal point sits after n digits
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = f"0.{'0' * -n}{digits}"
    else:
        exponent = n - 1
        mantissa = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        body = f"{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"
    return sign + body


def display_text(value: Any, limit: int = MAX_LABEL, *, multiline: bool = False) -> str:
    """Make a value safe to DISPLAY: strip the shared invisible set (C0/C1, bidi,
    zero-width, variation selectors, tag characters, …; ``INVISIBLE_TEXT_CLASS``) and
    lone surrogates, fold line breaks to one space unless ``multiline``, trim a
    single-line value, and clamp to ``limit`` code points with a trailing ellipsis.
    Never linkifies, never raises.

    Exactly the webui ``displayText()``: a string is used as is; a finite number or a
    boolean is written as JavaScript writes it; anything else (``None``, NaN, a dict,
    a list, an object) becomes ``""`` — never ``str(dict)``, which would show a
    drifted label differently on each side.

    This is a DISPLAY sanitiser, not a prompt fence: model-bound text still goes
    through ``prompts.fence``/``fence_block``."""
    if isinstance(value, str):
        text = value
    elif isinstance(value, bool):
        text = "true" if value else "false"
    elif isinstance(value, (int, float)) and math.isfinite(value):
        text = _js_number_text(value)
    else:
        return ""
    text = _SURROGATE_RE.sub("", _INVISIBLE_RE.sub("", text))
    if multiline:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    else:
        text = _LINE_BREAKS_RE.sub(" ", text).strip()
    if limit > 0 and len(text) > limit:
        text = text[: max(0, limit - 1)].rstrip() + ELLIPSIS
    return text


def _scalar_text(value: Any, limit: int, *, multiline: bool = False) -> str:
    """Strict text coercion for a REQUIRED string field: a string or a plain scalar
    is accepted (and sanitised); a container is a validation error, never str(dict)."""
    if isinstance(value, str):
        return display_text(value, limit, multiline=multiline)
    if isinstance(value, bool) or (isinstance(value, (int, float)) and math.isfinite(value)):
        return display_text(value, limit)   # written as JavaScript writes it
    raise ValueError("expected text")


def _optional_text(value: Any, limit: int, *, multiline: bool = False) -> str | None:
    """Lenient optional text: ``None``/blank/containers become ``None``."""
    if value is None:
        return None
    try:
        text = _scalar_text(value, limit, multiline=multiline)
    except ValueError:
        return None
    return text or None


def finite_number(value: Any) -> int | float | None:
    """A finite JSON number, else ``None`` (= not measured, G3). Booleans and numeric
    strings are NOT numbers here (the webui applies the same rule)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return None


def parse_timestamp(text: str) -> datetime | None:
    """The instant a :data:`TIMESTAMP_PATTERN` string names (a naive one is read as
    UTC), else ``None`` — for a string outside the shared grammar (``fullmatch``: a
    Python ``$`` would also accept a trailing newline) or an impossible date
    (2026-02-30, year 0)."""
    if not isinstance(text, str) or not TIMESTAMP_RE.fullmatch(text):
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso_or_none(value: Any) -> str | None:
    """A valid shared-grammar timestamp string (sanitised, bounded), else ``None``."""
    text = _optional_text(value, MAX_TIMESTAMP_CHARS)
    if not text or parse_timestamp(text) is None:
        return None
    return text


def _enum_or(value: Any, allowed: tuple[str, ...], fallback: Any) -> Any:
    """Case-insensitive enum match with a fallback for a drifted value."""
    if isinstance(value, str):
        candidate = value.strip().lower()
        if candidate in allowed:
            return candidate
    return fallback


def _clip(items: Any, limit: int) -> tuple[list[Any], bool]:
    """``(items[:limit], was_clipped)``; a non-list becomes ``[]``."""
    if not isinstance(items, (list, tuple)):
        return [], False
    seq = list(items)
    return seq[:limit], len(seq) > limit


def _filter_valid(adapter: TypeAdapter, items: Any, limit: int) -> tuple[list[Any], bool]:
    """Validate items one by one, DROPPING the invalid ones (an invalid sub-item is
    dropped, never fatal), and keep at most ``limit``. Returns ``(items, clipped)``."""
    if not isinstance(items, (list, tuple)):
        return [], False
    out: list[Any] = []
    clipped = False
    for item in items:
        try:
            parsed = adapter.validate_python(item)
        except Exception:  # noqa: BLE001 -- one bad sub-item never sinks the block
            continue
        if len(out) >= limit:
            clipped = True
            break
        out.append(parsed)
    return out, clipped


# Annotated field types: sanitise first, then the declared bound documents the limit
# in the JSON schema (it can never fire, because the sanitiser clamps).
def _text_type(limit: int, *, multiline: bool = False) -> Any:
    def _sanitise(value: Any) -> str:
        return _scalar_text(value, limit, multiline=multiline)

    return Annotated[str, BeforeValidator(_sanitise), Field(max_length=limit)]


def _opt_text_type(limit: int, *, multiline: bool = False) -> Any:
    def _sanitise(value: Any) -> str | None:
        return _optional_text(value, limit, multiline=multiline)

    return Annotated[Union[str, None], BeforeValidator(_sanitise), Field(max_length=limit)]


Title = _text_type(MAX_TITLE)
OptTitle = _opt_text_type(MAX_TITLE)
Label = _text_type(MAX_LABEL)
OptLabel = _opt_text_type(MAX_LABEL)
OptCaption = _opt_text_type(MAX_CAPTION)
Category = _text_type(MAX_CATEGORY_CHARS)
Number = Union[int, float]
OptNumber = Annotated[Union[int, float, None], BeforeValidator(finite_number)]
OptTimestamp = Annotated[Union[str, None], BeforeValidator(_iso_or_none), Field(max_length=MAX_TIMESTAMP_CHARS)]
OptSeverity = Annotated[Union[SeverityKey, None], BeforeValidator(lambda v: _enum_or(v, SEVERITY_KEYS, None))]
OptVerdict = Annotated[Union[VerdictKey, None], BeforeValidator(lambda v: _enum_or(v, VERDICT_KEYS, None))]
OptCaseStatus = Annotated[Union[CaseStatusKey, None], BeforeValidator(lambda v: _enum_or(v, CASE_STATUS_KEYS, None))]
OptSemantic = Annotated[Union[SemanticKey, None], BeforeValidator(lambda v: _enum_or(v, SEMANTIC_KEYS, None))]


def _finite_required(value: Any) -> int | float:
    number = finite_number(value)
    if number is None:
        raise ValueError("expected a finite number")
    return number


FiniteNumber = Annotated[Union[int, float], BeforeValidator(_finite_required)]


def _nonneg_int_or_none(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _pos_int_or_none(value: Any) -> int | None:
    number = _nonneg_int_or_none(value)
    return number if number else None


def _category_label(value: Any) -> Any:
    """An axis label keeps alignment even when the source value is missing: a null or
    a container becomes an empty label instead of failing the whole chart."""
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return value
    return ""


def _risk_or_none(value: Any) -> int | float | None:
    number = finite_number(value)
    if number is None or number < 0 or number > 100:
        return None
    return number


OptRisk = Annotated[Union[int, float, None], BeforeValidator(_risk_or_none)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- #
# Typed in-app / Help Center references (never URLs; the client re-validates).
# --------------------------------------------------------------------------- #
def is_safe_log_query(value: Any) -> bool:
    """The router's log-query rule: 1..512 code points, none of them in Unicode
    category C (control, format, surrogate, private use, unassigned) or a line or
    paragraph separator. Never trimmed: the query is the exact filter text."""
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_LOG_QUERY_CHARS:
        return False
    return not any(ch in "\u2028\u2029" or unicodedata.category(ch).startswith("C") for ch in value)


class NavRefOpts(_Strict):
    """The validated ``NavOpts`` subset a block may carry (BLOCKS.md InternalRef),
    including the Logs deep-link keys ``logQuery``/``from``/``to``/``sourceId`` that
    "Open in Logs" needs (validated exactly like the router's deep links)."""

    caseId: str | None = Field(default=None, pattern=CASE_ID_PATTERN)
    severity: SeverityKey | None = None
    status: NavStatus | None = None
    window: int | None = Field(default=None, ge=1, le=720)
    tab: str | None = Field(default=None, pattern=ROUTE_TOKEN_PATTERN)
    section: str | None = Field(default=None, pattern=ROUTE_TOKEN_PATTERN)
    anchor: str | None = Field(default=None, pattern=ROUTE_TOKEN_PATTERN)
    logQuery: str | None = Field(default=None, min_length=1, max_length=MAX_LOG_QUERY_CHARS)
    # ``from`` on the wire (a Python keyword here): only the wire name is accepted,
    # and :func:`dump_block` dumps ``by_alias`` so it is also the name written.
    from_: str | None = Field(default=None, alias="from", pattern=NAV_TIME_PATTERN)
    to: str | None = Field(default=None, pattern=NAV_TIME_PATTERN)
    sourceId: str | None = Field(default=None, pattern=NAV_ID_PATTERN)

    @field_validator("logQuery")
    @classmethod
    def _log_query(cls, value: str | None) -> str | None:
        if value is not None and not is_safe_log_query(value):
            raise ValueError("log query must be plain single-line text")
        return value


# Python attribute → wire key, in declaration order.
_NAV_OPT_ATTRS: dict[str, str] = {
    name: (info.alias or name) for name, info in NavRefOpts.model_fields.items()
}


class InternalRef(_Strict):
    """An in-app destination: a page id plus validated options. The webui checks
    ``page`` with ``isPageId`` (the backend has no page registry, only the grammar)."""

    page: str = Field(pattern=PAGE_PATTERN)
    opts: NavRefOpts | None = None


class DocRef(_Strict):
    """A same-origin Help Center page, e.g. ``/docs/0.1/analyst/chat/#sources``."""

    doc: str = Field(pattern=DOC_REF_PATTERN)


_INTERNAL_REF = TypeAdapter(InternalRef)
_DOC_REF = TypeAdapter(DocRef)


def parse_ref(value: Any) -> InternalRef | DocRef | None:
    """A valid :class:`InternalRef` or :class:`DocRef`, else ``None`` (dropped)."""
    if isinstance(value, (InternalRef, DocRef)):
        return value
    if not isinstance(value, dict):
        return None
    try:
        return _DOC_REF.validate_python(value) if "doc" in value else _INTERNAL_REF.validate_python(value)
    except Exception:  # noqa: BLE001
        return None


def _required_ref(value: Any) -> InternalRef | DocRef:
    ref = parse_ref(value)
    if ref is None:
        raise ValueError("invalid reference")
    return ref


def _internal_ref_or_none(value: Any) -> InternalRef | None:
    ref = parse_ref(value)
    return ref if isinstance(ref, InternalRef) else None


OptNavRef = Annotated[Union[InternalRef, None], BeforeValidator(_internal_ref_or_none)]
OptAnyRef = Annotated[Union[DocRef, InternalRef, None], BeforeValidator(parse_ref)]
AnyRef = Annotated[Union[DocRef, InternalRef], BeforeValidator(_required_ref)]

# The wire keys of the Logs deep link ("Open in Logs", SPEC §13 A14).
LOG_NAV_KEYS = ("logQuery", "from", "to", "sourceId")


def clean_nav_opts(raw: Any) -> dict[str, str | int]:
    """Keep only the valid ``NavOpts`` entries of ``raw`` (unknown keys and invalid
    values are DROPPED one by one). Shared with ``models.ConsoleLink.opts``."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str | int] = {}
    for attr, key in _NAV_OPT_ATTRS.items():
        if key not in raw:
            continue
        try:
            parsed = NavRefOpts.model_validate({key: raw[key]})
        except Exception:  # noqa: BLE001
            continue
        value = getattr(parsed, attr)
        if value is not None:
            out[key] = value
    return out


# --------------------------------------------------------------------------- #
# Block models.
# --------------------------------------------------------------------------- #
class ExpiredInfo(_Strict):
    """What a retention-downgraded block used to be (SPEC §7.5 Retention)."""

    type: BlockType
    artifact_kind: ArtifactKind | None = None


class _BlockBase(_Strict):
    """Fields every block carries (BLOCKS.md §5.2 + v2 amendment 1)."""

    # Declared first so it leads the serialized dict; each block narrows it to a
    # Literal, which is what the ``type`` discriminator dispatches on.
    type: BlockType
    id: str = Field(pattern=BLOCK_ID_PATTERN)
    title: OptTitle = None
    caption: OptCaption = None
    provenance: BlockProvenance
    # The artifact kind this block was materialised from; None for model-written blocks.
    artifact_kind: ArtifactKind | None = None
    # Views the client may switch between without a model call (SPEC §7.3).
    allowed_views: list[BlockView] = Field(default_factory=list, max_length=len(BLOCK_VIEWS))
    untrusted: bool = False
    truncated: bool = False
    total: Annotated[Union[int, None], BeforeValidator(_nonneg_int_or_none)] = None
    as_of: OptTimestamp = None
    from_step: Annotated[Union[int, None], BeforeValidator(_pos_int_or_none)] = None
    fallback_text: _opt_text_type(MAX_FALLBACK, multiline=True) = None
    downsampled_for_storage: bool = False
    # The EXACT console view of this block's data ("Open in Logs": the same filter,
    # window and source the tool ran with), built by deterministic code from the
    # tool's own input, never by the model: an ``ai`` block never carries one, and an
    # invalid ref is dropped rather than failing the block.
    open_in: OptNavRef = None

    @model_validator(mode="before")
    @classmethod
    def _base_repair(cls, data: Any) -> Any:
        """Fail-safe provenance (G5: a missing/unknown value is ``ai``) and lenient
        ``artifact_kind``/``allowed_views`` (unknown entries dropped)."""
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["provenance"] = _enum_or(out.get("provenance"), PROVENANCES, "ai")
        if out["provenance"] == "ai":
            out.pop("open_in", None)   # navigation targets are never model-made
        out["artifact_kind"] = _enum_or(out.get("artifact_kind"), ARTIFACT_KINDS, None)
        views = out.get("allowed_views")
        out["allowed_views"] = [
            v for v in dict.fromkeys(_enum_or(x, BLOCK_VIEWS, None) for x in views) if v
        ] if isinstance(views, (list, tuple)) else []
        for flag in ("truncated", "downsampled_for_storage"):
            if flag in out and not isinstance(out[flag], bool):
                out[flag] = bool(out[flag]) if isinstance(out[flag], (int, float)) else False
        # A malformed ``untrusted`` flag fails SAFE: labels render as untrusted (G7).
        if "untrusted" in out and not isinstance(out["untrusted"], bool):
            out["untrusted"] = True
        return out

    def view(self) -> str:
        """The block's current view (a chart kind, else the block type)."""
        return str(getattr(self, "kind", None) or getattr(self, "type"))

    @model_validator(mode="after")
    def _views_coherent(self) -> "_BlockBase":
        """``allowed_views`` must sit inside the artifact kind's §7.3 row and include
        the current view; a model-written block (no artifact kind) has none."""
        kind = self.artifact_kind
        if kind is None:
            self.allowed_views = []
            return self
        allowed = ALLOWED_VIEWS[kind]
        current = self.view()
        if current not in allowed:
            raise ValueError(f"view {current!r} is not allowed for artifact kind {kind!r}")
        views = [v for v in self.allowed_views if v in allowed]
        if current not in views:
            views.insert(0, current)
        self.allowed_views = views  # type: ignore[assignment]
        return self


class MarkdownBlock(_BlockBase):
    type: Literal["markdown"]
    text: _text_type(MAX_MARKDOWN, multiline=True)


class KpiDelta(_Strict):
    value: FiniteNumber
    period_label: Label
    good_direction: GoodDirection = "none"

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["good_direction"] = _enum_or(data.get("good_direction"), GOOD_DIRECTIONS, "none")
        return data


class KpiTrend(_Strict):
    points: list[OptNumber] = Field(max_length=MAX_TREND_POINTS)
    window_label: Label

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            points, _ = _clip(data.get("points"), MAX_TREND_POINTS)
            data["points"] = points
        return data


_KPI_DELTA = TypeAdapter(KpiDelta)
_KPI_TREND = TypeAdapter(KpiTrend)


def _lenient(adapter: TypeAdapter) -> Any:
    def _parse(value: Any) -> Any:
        if value is None:
            return None
        try:
            return adapter.validate_python(value)
        except Exception:  # noqa: BLE001 -- an invalid optional sub-object is dropped
            return None
    return _parse


class KpiItem(_Strict):
    key: str = Field(pattern=KEY_PATTERN)
    label: Label
    value: OptNumber
    unit: ValueUnit
    bound: Literal["lower"] | None = None
    context: OptLabel = None
    delta: Annotated[Union[KpiDelta, None], BeforeValidator(_lenient(_KPI_DELTA))] = None
    semantic: OptSemantic = None
    trend: Annotated[Union[KpiTrend, None], BeforeValidator(_lenient(_KPI_TREND))] = None
    ref: OptNavRef = None
    # "gauge" draws a 0-100 index as RiskGauge (amendment 2); otherwise a value tile.
    display: KpiDisplay | None = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            if "value" not in data:
                data["value"] = None
            data["bound"] = "lower" if data.get("bound") == "lower" else None
            data["display"] = _enum_or(data.get("display"), KPI_DISPLAYS, None)
            if isinstance(data.get("unit"), str):
                data["unit"] = data["unit"].strip().lower()
        return data

    @model_validator(mode="after")
    def _gauge_range(self) -> "KpiItem":
        # A gauge only makes sense for a 0-100 index; anything else is a value tile.
        if self.display == "gauge" and self.value is not None and not 0 <= self.value <= 100:
            self.display = None
        return self

    # ``value: null`` (= not measured, G3) is kept explicit by :func:`dump_block`, the
    # one canonical dump. It is deliberately NOT a ``model_serializer``: an untyped
    # serializer erases the model's serialization JSON schema, so ``openapi.json``
    # would describe a KPI item as an empty object.


_KPI_ITEM = TypeAdapter(KpiItem)


class KpiGroupBlock(_BlockBase):
    type: Literal["kpi_group"]
    items: list[KpiItem] = Field(min_length=1, max_length=MAX_KPI_ITEMS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            items, clipped = _filter_valid(_KPI_ITEM, data.get("items"), MAX_KPI_ITEMS)
            data["items"] = items
            if clipped:
                data["truncated"] = True
        return data


class ChartX(_Strict):
    kind: XKind = "category"
    values: list[Category] = Field(max_length=MAX_POINTS)
    label: OptLabel = None
    bucket: TimeBucket | None = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["kind"] = _enum_or(data.get("kind"), X_KINDS, "category")
            data["bucket"] = _enum_or(data.get("bucket"), TIME_BUCKETS, None)
            values = data.get("values")
            data["values"] = (
                [_category_label(v) for v in values] if isinstance(values, (list, tuple)) else []
            )
        return data


class ChartSeries(_Strict):
    key: str = Field(pattern=KEY_PATTERN)
    label: Label
    semantic: OptSemantic = None
    values: list[OptNumber] = Field(max_length=MAX_POINTS)


class ChartReferenceY(_Strict):
    axis: Literal["y"]
    value: FiniteNumber
    label: Label


class ChartReferenceX(_Strict):
    axis: Literal["x"]
    value: Category
    label: Label


_CHART_REFERENCE = TypeAdapter(Annotated[Union[ChartReferenceY, ChartReferenceX], Field(discriminator="axis")])
_CHART_SERIES = TypeAdapter(ChartSeries)


class ChartBlock(_BlockBase):
    type: Literal["chart"]
    kind: ChartKind
    unit: ValueUnit
    y_label: OptLabel = None
    x: ChartX
    series: list[ChartSeries] = Field(min_length=1, max_length=MAX_SERIES)
    reference: Annotated[
        Union[ChartReferenceY, ChartReferenceX, None],
        BeforeValidator(_lenient(_CHART_REFERENCE)),
    ] = None
    last_in_progress: bool = False
    drill: list[OptNavRef] | None = Field(default=None, max_length=MAX_POINTS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        """Clip to the point/series limits (time keeps the NEWEST points, categories
        the first ones, which the materialiser sorted by size), align every series and
        the drill list to the x axis (padding with ``null`` = not measured)."""
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if isinstance(data.get("kind"), str):
            data["kind"] = data["kind"].strip().lower()
        if isinstance(data.get("unit"), str):
            data["unit"] = data["unit"].strip().lower()
        x = data.get("x")
        if not isinstance(x, dict):
            return data
        x = dict(x)
        values = list(x.get("values")) if isinstance(x.get("values"), (list, tuple)) else []
        n = len(values)
        keep_tail = _enum_or(x.get("kind"), X_KINDS, "category") == "time"
        start = max(0, n - MAX_POINTS) if keep_tail else 0
        stop = n if keep_tail else min(n, MAX_POINTS)
        if n > MAX_POINTS:
            data["truncated"] = True
        x["values"] = values[start:stop]
        data["x"] = x
        width = stop - start
        series, clipped = _clip(data.get("series"), MAX_SERIES)
        if clipped:
            data["truncated"] = True
        aligned: list[Any] = []
        for item in series:
            if not isinstance(item, dict):
                continue
            item = dict(item)
            raw = list(item.get("values")) if isinstance(item.get("values"), (list, tuple)) else []
            raw = raw[start:stop]
            raw += [None] * (width - len(raw))
            item["values"] = raw
            aligned.append(item)
        series_items, _ = _filter_valid(_CHART_SERIES, aligned, MAX_SERIES)
        data["series"] = series_items
        drill = data.get("drill")
        if isinstance(drill, (list, tuple)):
            drill = list(drill)[start:stop]
            data["drill"] = drill + [None] * (width - len(drill)) if any(d is not None for d in drill) else None
        else:
            data["drill"] = None
        return data

    @model_validator(mode="after")
    def _shape(self) -> "ChartBlock":
        if self.kind in ("donut", "sparkline", "funnel") and len(self.series) != 1:
            raise ValueError(f"a {self.kind} chart has exactly one series")
        if self.kind == "donut" and len(self.x.values) > MAX_DONUT_SEGMENTS:
            raise ValueError("a donut has at most 6 segments (fold the tail into Other)")
        return self


class HeatmapAxis(_Strict):
    values: list[Category]
    label: OptLabel = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("values"), (list, tuple)):
            data = {**data, "values": [_category_label(v) for v in data["values"]]}
        return data


class HeatmapBlock(_BlockBase):
    type: Literal["heatmap"]
    unit: ValueUnit
    x: HeatmapAxis
    y: HeatmapAxis
    cells: list[list[OptNumber]]

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        """Clip to 48 × 24 and align the y-major cell grid to both axes."""
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if isinstance(data.get("unit"), str):
            data["unit"] = data["unit"].strip().lower()
        axes: dict[str, int] = {}
        for name, limit in (("x", MAX_HEATMAP_X), ("y", MAX_HEATMAP_Y)):
            axis = data.get(name)
            if not isinstance(axis, dict):
                return data
            axis = dict(axis)
            values, clipped = _clip(axis.get("values"), limit)
            if clipped:
                data["truncated"] = True
            axis["values"] = values
            data[name] = axis
            axes[name] = len(values)
        rows = data.get("cells") if isinstance(data.get("cells"), (list, tuple)) else []
        grid: list[list[Any]] = []
        for r in range(axes["y"]):
            row = rows[r] if r < len(rows) and isinstance(rows[r], (list, tuple)) else []
            row = list(row)[: axes["x"]]
            grid.append(row + [None] * (axes["x"] - len(row)))
        data["cells"] = grid
        return data


class TableColumn(_Strict):
    key: str = Field(pattern=KEY_PATTERN)
    label: Label
    type: ColumnType = "text"
    unit: ValueUnit | None = None
    align: Literal["left", "right"] | None = None
    untrusted: bool = False

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            # An unknown column type renders as text: the safe fallback (G9).
            data["type"] = _enum_or(data.get("type"), COLUMN_TYPES, "text")
            data["unit"] = _enum_or(data.get("unit"), VALUE_UNITS, None)
            data["align"] = _enum_or(data.get("align"), ("left", "right"), None)
            if "untrusted" in data and not isinstance(data["untrusted"], bool):
                data["untrusted"] = True  # fail safe (G7)
        return data


def table_cell(value: Any) -> str | int | float | bool | None:
    """One table cell: a sanitised bounded string, a finite number, a bool or null.
    Anything else (a dict, a list, NaN) is null — never ``str(container)``."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return finite_number(value)
    if isinstance(value, str):
        return display_text(value, MAX_CELL_CHARS)
    return None


Cell = Annotated[Union[str, int, float, bool, None], BeforeValidator(table_cell)]


class TableSort(_Strict):
    key: str = Field(pattern=KEY_PATTERN)
    dir: Literal["asc", "desc"] = "desc"


_TABLE_COLUMN = TypeAdapter(TableColumn)
_TABLE_SORT = TypeAdapter(TableSort)


class TableBlock(_BlockBase):
    type: Literal["table"]
    columns: list[TableColumn] = Field(min_length=1, max_length=MAX_TABLE_COLUMNS)
    rows: list[list[Cell]] = Field(max_length=MAX_TABLE_ROWS)
    sort: Annotated[Union[TableSort, None], BeforeValidator(_lenient(_TABLE_SORT))] = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        """Repair column keys positionally (a row is a positional array, so dropping a
        column would misalign every row), clip, and align each row to the columns."""
        if not isinstance(data, dict):
            return data
        data = dict(data)
        raw_columns, clipped_cols = _clip(data.get("columns"), MAX_TABLE_COLUMNS)
        columns: list[Any] = []
        seen: set[str] = set()
        for i, col in enumerate(raw_columns):
            col = dict(col) if isinstance(col, dict) else {"label": f"Column {i + 1}"}
            key = col.get("key")
            if not isinstance(key, str) or not _KEY_RE.match(key) or key in seen:
                key = f"c{i + 1}"
            while key in seen:  # an explicit "c2" may already hold the positional name
                key = f"{key}_"
            seen.add(key)
            col["key"] = key
            if not isinstance(col.get("label"), (str, int, float)) or not str(col.get("label")).strip():
                col["label"] = key
            columns.append(col)
        width = len(columns)
        rows, clipped_rows = _clip(data.get("rows"), MAX_TABLE_ROWS)
        aligned = []
        for row in rows:
            cells = list(row)[:width] if isinstance(row, (list, tuple)) else []
            aligned.append(cells + [None] * (width - len(cells)))
        data["columns"] = columns
        data["rows"] = aligned
        if clipped_cols or clipped_rows:
            data["truncated"] = True
        sort = data.get("sort")
        if isinstance(sort, dict) and sort.get("key") not in seen:
            data["sort"] = None
        return data


class CaseListItem(_Strict):
    case_id: str = Field(pattern=CASE_ID_PATTERN)
    title: Title
    severity: OptSeverity = None
    verdict: OptVerdict = None
    status: OptCaseStatus = None
    risk: OptRisk = None
    created_at: OptTimestamp = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        # A case without a usable title still lists under its id.
        if isinstance(data, dict) and not _optional_text(data.get("title"), MAX_TITLE):
            data = {**data, "title": data.get("case_id")}
        return data


_CASE_LIST_ITEM = TypeAdapter(CaseListItem)


class CaseListBlock(_BlockBase):
    type: Literal["case_list"]
    items: list[CaseListItem] = Field(max_length=MAX_CASE_LIST)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            items, clipped = _filter_valid(_CASE_LIST_ITEM, data.get("items"), MAX_CASE_LIST)
            data["items"] = items
            if clipped:
                data["truncated"] = True
        return data


class TimelineEvent(_Strict):
    at: Annotated[str, BeforeValidator(lambda v: _iso_or_none(v) or "")] = Field(min_length=1, max_length=MAX_TIMESTAMP_CHARS)
    label: _text_type(160)
    detail: _opt_text_type(MAX_DETAIL_CHARS, multiline=True) = None
    kind: Annotated[Union[TimelineKind, None], BeforeValidator(lambda v: _enum_or(v, TIMELINE_KINDS, None))] = None
    semantic: OptSemantic = None
    ref: OptNavRef = None


_TIMELINE_EVENT = TypeAdapter(TimelineEvent)


def _sort_instant(value: str) -> float:
    """Epoch seconds for ordering (a naive timestamp is read as UTC)."""
    parsed = parse_timestamp(value)
    return math.inf if parsed is None else parsed.timestamp()


class TimelineBlock(_BlockBase):
    type: Literal["timeline"]
    events: list[TimelineEvent] = Field(max_length=MAX_TIMELINE)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            events, _ = _filter_valid(_TIMELINE_EVENT, data.get("events"), 10_000)
            # Ascending by instant (stable), then the newest MAX_TIMELINE are kept.
            events.sort(key=lambda e: _sort_instant(e.at))
            if len(events) > MAX_TIMELINE:
                events = events[-MAX_TIMELINE:]
                data["truncated"] = True
            data["events"] = events
        return data


class EntityRef(_Strict):
    kind: EntityKind
    value: _text_type(MAX_VALUE_CHARS)


class EntityFact(_Strict):
    label: Label
    value: _text_type(MAX_DETAIL_CHARS)
    untrusted: bool = False


class ReputationRow(_Strict):
    provider: Label
    verdict: ReputationVerdict = "unknown"
    score: OptNumber = None
    detail: _opt_text_type(MAX_SNIPPET) = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["verdict"] = _enum_or(data.get("verdict"), REPUTATION_VERDICTS, "unknown")
        return data


class RelatedCase(_Strict):
    case_id: str = Field(pattern=CASE_ID_PATTERN)
    title: Title
    severity: OptSeverity = None


_ENTITY_FACT = TypeAdapter(EntityFact)
_REPUTATION_ROW = TypeAdapter(ReputationRow)
_RELATED_CASE = TypeAdapter(RelatedCase)


class EntityBlock(_BlockBase):
    type: Literal["entity"]
    entity: EntityRef
    risk: OptRisk = None
    verdict: OptVerdict = None
    facts: list[EntityFact] = Field(default_factory=list, max_length=MAX_ENTITY_FACTS)
    reputation: list[ReputationRow] = Field(default_factory=list, max_length=MAX_REPUTATION)
    counts: list[KpiItem] = Field(default_factory=list, max_length=MAX_ENTITY_COUNTS)
    related_cases: list[RelatedCase] = Field(default_factory=list, max_length=MAX_RELATED_CASES)
    first_seen: OptTimestamp = None
    last_seen: OptTimestamp = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            entity = data.get("entity")
            if isinstance(entity, dict) and isinstance(entity.get("kind"), str):
                data["entity"] = {**entity, "kind": entity["kind"].strip().lower()}
            for name, adapter, limit in (
                ("facts", _ENTITY_FACT, MAX_ENTITY_FACTS),
                ("reputation", _REPUTATION_ROW, MAX_REPUTATION),
                ("counts", _KPI_ITEM, MAX_ENTITY_COUNTS),
                ("related_cases", _RELATED_CASE, MAX_RELATED_CASES),
            ):
                items, clipped = _filter_valid(adapter, data.get(name), limit)
                data[name] = items
                if clipped:
                    data["truncated"] = True
        return data


class MitreTechnique(_Strict):
    id: str = Field(pattern=TECHNIQUE_PATTERN)
    name: OptTitle = None
    tactic: OptLabel = None
    count: OptNumber = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("id"), str):
            data = {**data, "id": data["id"].strip().upper()}
        return data


_MITRE_TECHNIQUE = TypeAdapter(MitreTechnique)


class MitreBlock(_BlockBase):
    type: Literal["mitre"]
    techniques: list[MitreTechnique] = Field(max_length=MAX_MITRE)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            items, clipped = _filter_valid(_MITRE_TECHNIQUE, data.get("techniques"), MAX_MITRE)
            data["techniques"] = items
            if clipped:
                data["truncated"] = True
        return data


class QueryBlock(_BlockBase):
    type: Literal["query"]
    language: QueryLanguage
    query: _text_type(MAX_QUERY_CHARS, multiline=True)
    source_name: OptTitle = None
    hits: OptNumber = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("language"), str):
            data = {**data, "language": data["language"].strip().lower()}
        return data


class CalloutBlock(_BlockBase):
    type: Literal["callout"]
    tone: ToneKey = "info"
    text: _text_type(MAX_CALLOUT, multiline=True)
    # Set only on a retention stub (see :func:`expire_block`).
    expired: Annotated[Union[ExpiredInfo, None], BeforeValidator(_lenient(TypeAdapter(ExpiredInfo)))] = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = {**data, "tone": _enum_or(data.get("tone"), TONES, "info")}
        return data


class CitationItem(_Strict):
    n: int = Field(ge=1, le=99)
    kind: CitationBlockKind
    label: Title
    ref: OptAnyRef = None
    snippet: _opt_text_type(MAX_SNIPPET, multiline=True) = None


_CITATION_ITEM = TypeAdapter(CitationItem)


class CitationsBlock(_BlockBase):
    type: Literal["citations"]
    items: list[CitationItem] = Field(max_length=MAX_CITATION_ITEMS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            items, clipped = _filter_valid(_CITATION_ITEM, data.get("items"), MAX_CITATION_ITEMS)
            data["items"] = items
            if clipped:
                data["truncated"] = True
        return data


class GuideStep(_Strict):
    text: _text_type(MAX_CAPTION, multiline=True)


class GuideLink(_Strict):
    label: Label
    ref: AnyRef


_GUIDE_STEP = TypeAdapter(GuideStep)
_GUIDE_LINK = TypeAdapter(GuideLink)


class GuideBlock(_BlockBase):
    type: Literal["guide"]
    steps: list[GuideStep] = Field(default_factory=list, max_length=MAX_GUIDE_STEPS)
    links: list[GuideLink] = Field(default_factory=list, max_length=MAX_GUIDE_LINKS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["steps"], s_clip = _filter_valid(_GUIDE_STEP, data.get("steps"), MAX_GUIDE_STEPS)
            data["links"], l_clip = _filter_valid(_GUIDE_LINK, data.get("links"), MAX_GUIDE_LINKS)
            if s_clip or l_clip:
                data["truncated"] = True
        return data


LeafBlock = Annotated[
    Union[
        MarkdownBlock, KpiGroupBlock, ChartBlock, HeatmapBlock, TableBlock, CaseListBlock,
        TimelineBlock, EntityBlock, MitreBlock, QueryBlock, CalloutBlock, CitationsBlock,
        GuideBlock,
    ],
    Field(discriminator="type"),
]
_LEAF_BLOCK = TypeAdapter(LeafBlock)


class ReportScope(_Strict):
    window_label: OptLabel = None
    sources: list[Annotated[str, BeforeValidator(lambda v: _scalar_text(v, MAX_TITLE))]] = Field(default_factory=list, max_length=MAX_SOURCES)
    generated_at: Annotated[str, BeforeValidator(lambda v: _iso_or_none(v) or "")] = Field(min_length=1, max_length=MAX_TIMESTAMP_CHARS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            sources, _ = _clip(data.get("sources"), MAX_SOURCES)
            data["sources"] = [s for s in sources if isinstance(s, str) and display_text(s, MAX_TITLE)]
        return data


class ReportSection(_Strict):
    id: str = Field(pattern=SECTION_ID_PATTERN)
    heading: Title
    summary: _opt_text_type(MAX_SECTION_SUMMARY, multiline=True) = None
    blocks: list[LeafBlock] = Field(default_factory=list, max_length=MAX_REPORT_LEAVES)


class ReportBlock(_BlockBase):
    """A document made of sections whose leaves are ordinary blocks (no nesting)."""

    type: Literal["report"]
    title: Title  # type: ignore[assignment]  # required here, optional on the base
    subtitle: _opt_text_type(200) = None
    template: Annotated[Union[ReportTemplate, None], BeforeValidator(lambda v: None if v is None else _enum_or(v, REPORT_TEMPLATES, "custom"))] = None
    scope: ReportScope
    sections: list[ReportSection] = Field(min_length=1, max_length=MAX_REPORT_SECTIONS)

    @model_validator(mode="after")
    def _leaf_budget(self) -> "ReportBlock":
        leaves = sum(len(s.blocks) for s in self.sections)
        if leaves == 0:
            raise ValueError("a report needs at least one resolved leaf")
        if leaves > MAX_REPORT_LEAVES:
            raise ValueError("a report holds at most 40 leaves")
        return self


AnswerBlock = Annotated[
    Union[
        MarkdownBlock, KpiGroupBlock, ChartBlock, HeatmapBlock, TableBlock, CaseListBlock,
        TimelineBlock, EntityBlock, MitreBlock, QueryBlock, CalloutBlock, CitationsBlock,
        GuideBlock, ReportBlock,
    ],
    Field(discriminator="type"),
]
_ANSWER_BLOCK = TypeAdapter(AnswerBlock)

BLOCK_MODELS: dict[str, type[_BlockBase]] = {
    "markdown": MarkdownBlock, "kpi_group": KpiGroupBlock, "chart": ChartBlock,
    "heatmap": HeatmapBlock, "table": TableBlock, "case_list": CaseListBlock,
    "timeline": TimelineBlock, "entity": EntityBlock, "mitre": MitreBlock,
    "query": QueryBlock, "callout": CalloutBlock, "citations": CitationsBlock,
    "guide": GuideBlock, "report": ReportBlock,
}


def _collect_field_names(models: Iterable[type[BaseModel]]) -> frozenset[str]:
    names: set[str] = set()
    for model in models:
        names.update(model.model_fields)
    return frozenset(names)


# Every schema field name (used to keep validation reasons value-free).
_FIELD_NAMES = _collect_field_names([
    *BLOCK_MODELS.values(), NavRefOpts, InternalRef, DocRef, ExpiredInfo, KpiDelta, KpiTrend,
    KpiItem, ChartX, ChartSeries, ChartReferenceY, ChartReferenceX, HeatmapAxis, TableColumn,
    TableSort, CaseListItem, TimelineEvent, EntityRef, EntityFact, ReputationRow, RelatedCase,
    MitreTechnique, CitationItem, GuideStep, GuideLink, ReportScope, ReportSection,
]) | frozenset(_NAV_OPT_ATTRS.values())   # wire aliases (``from``) appear in error paths


# --------------------------------------------------------------------------- #
# Validation entry points.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class DroppedBlock:
    """One block (or report leaf) that :func:`validate_blocks` could not keep.
    ``path`` is the position ("3", "2.s1.4") and ``reason`` an engine-safe code
    (never raw exception text, which could echo attacker-controlled values)."""

    path: str
    type: str | None
    reason: str


# Keys dropped from the canonical dict when they hold their "nothing to say" value,
# so a stored answer stays compact (SPEC §7.5). Enum defaults (``tone: "info"``,
# ``x.kind: "category"``) stay explicit; ``null`` is dropped except a KPI ``value``.
_PRUNE_WHEN_FALSE = frozenset({"untrusted", "truncated", "downsampled_for_storage", "last_in_progress"})
_PRUNE_WHEN_EMPTY = frozenset({
    "allowed_views", "facts", "reputation", "counts", "related_cases", "steps", "links", "sources",
})


def _prune(value: Any) -> Any:
    if isinstance(value, dict):
        out = {
            k: _prune(v) for k, v in value.items()
            if not ((k in _PRUNE_WHEN_FALSE and v is False) or (k in _PRUNE_WHEN_EMPTY and v == []))
        }
        if out.get("type") == "kpi_group" and isinstance(out.get("items"), list):
            # ``exclude_none`` dropped a KPI's ``value: null``; put it back, because
            # an absent value and "not measured" must never look alike (G3).
            out["items"] = [
                {**item, "value": None} if isinstance(item, dict) and "value" not in item else item
                for item in out["items"]
            ]
        return out
    if isinstance(value, list):
        return [_prune(v) for v in value]
    return value


def dump_block(block: BaseModel) -> dict[str, Any]:
    """The canonical wire/storage dict of a validated block: ``null`` optionals and
    false/empty flags are omitted (absent = default), while a KPI ``value: null``
    (= not measured, G3) and every enum stay explicit. Re-validating the result is a
    no-op, so the live path and the replay path converge on the same bytes. Always
    dump a block through here, never with a bare ``exclude_none`` dump (and never
    without ``by_alias``: a Logs ref's ``from`` is the alias of ``NavRefOpts.from_``)."""
    return _prune(block.model_dump(mode="json", exclude_none=True, by_alias=True))


def _type_of(raw: Any) -> str | None:
    if isinstance(raw, dict) and isinstance(raw.get("type"), str):
        return raw["type"][:32]
    return None


_ERROR_TYPE_RE = re.compile(r"^[a-z_]{1,40}$")


def _reason(exc: Exception) -> str:
    """A stable, VALUE-FREE reason code for a validation failure: the pydantic error
    type plus the schema field path. Location parts that are not schema field names
    (an attacker-chosen extra key, a union tag) are dropped, so nothing from the
    rejected payload can ride into a notice, a log line or a prompt."""
    errors = getattr(exc, "errors", None)
    if callable(errors):
        try:
            first = errors()[0]
            kind = str(first.get("type") or "invalid")
            if not _ERROR_TYPE_RE.match(kind):
                kind = "invalid"
            loc = ".".join(
                p for p in (str(part) for part in first.get("loc", ()))
                if p in _FIELD_NAMES
            )
            return f"{kind}:{loc}" if loc else kind
        except Exception:  # noqa: BLE001
            pass
    return "invalid"


def _validate_one(
    raw: Any, path: str, *, allow_ai_data: bool, adapter: TypeAdapter
) -> tuple[BaseModel | None, DroppedBlock | None]:
    btype = _type_of(raw)
    if not isinstance(raw, dict):
        return None, DroppedBlock(path, None, "not_an_object")
    if btype not in BLOCK_TYPES:
        return None, DroppedBlock(path, btype, "unknown_type")
    try:
        block = adapter.validate_python(raw)
    except Exception as exc:  # noqa: BLE001 -- recorded as a code, never raised
        return None, DroppedBlock(path, btype, _reason(exc))
    if block.provenance == "ai" and block.type not in AI_AUTHORED_TYPES and not allow_ai_data:
        # G5: a data block must be materialised from a tool artifact. A number the
        # model typed is never charted, tabulated or tallied.
        return None, DroppedBlock(path, btype, "ai_data_block")
    return block, None


def _unique_id(candidate: Any, fallback: str, used: set[str]) -> str:
    base = candidate if isinstance(candidate, str) and _BLOCK_ID_RE.match(candidate) else fallback
    out, n = base, 2
    while out in used:
        suffix = f"-{n}"
        out = f"{base[: 48 - len(suffix)]}{suffix}"
        n += 1
    used.add(out)
    return out


def _with_id(raw: Any, fallback: str, used: set[str]) -> Any:
    if not isinstance(raw, dict):
        return raw
    return {**raw, "id": _unique_id(raw.get("id"), fallback, used)}


def _prepare_report(
    raw: dict[str, Any], path: str, used: set[str], dropped: list[DroppedBlock],
    *, allow_ai_data: bool,
) -> dict[str, Any]:
    """Validate a report's leaves one by one (recording each drop) so one bad leaf
    never sinks the whole document, then hand the cleaned envelope to the model."""
    out = dict(raw)
    sections_raw, clipped = _clip(raw.get("sections"), MAX_REPORT_SECTIONS)
    if clipped:
        out["truncated"] = True
    sections: list[dict[str, Any]] = []
    leaves = 0
    for s_index, section in enumerate(sections_raw, start=1):
        if not isinstance(section, dict):
            dropped.append(DroppedBlock(f"{path}.s{s_index}", None, "not_an_object"))
            continue
        kept: list[dict[str, Any]] = []
        blocks = section.get("blocks") if isinstance(section.get("blocks"), (list, tuple)) else []
        for b_index, leaf in enumerate(blocks, start=1):
            leaf_path = f"{path}.s{s_index}.{b_index}"
            if leaves >= MAX_REPORT_LEAVES:
                dropped.append(DroppedBlock(leaf_path, _type_of(leaf), "report_leaf_limit"))
                out["truncated"] = True
                continue
            if _type_of(leaf) == "report":
                dropped.append(DroppedBlock(leaf_path, "report", "nested_report"))
                continue
            block, drop = _validate_one(
                _with_id(leaf, f"b{len(used) + 1}", used), leaf_path,
                allow_ai_data=allow_ai_data, adapter=_LEAF_BLOCK,
            )
            if drop is not None:
                dropped.append(drop)
                continue
            kept.append(dump_block(block))  # type: ignore[arg-type]
            leaves += 1
        sid = section.get("id")
        heading = _optional_text(section.get("heading"), MAX_TITLE)
        sections.append({
            **section,
            "id": sid if isinstance(sid, str) and re.match(SECTION_ID_PATTERN, sid) else f"s{s_index}",
            # A missing heading must not sink the whole document.
            "heading": heading or f"Section {s_index}",
            "blocks": kept,
        })
    out["sections"] = [s for s in sections if s["blocks"]]
    return out


def _as_model_authored(raw: Any) -> Any:
    """Strip any provenance claim from a block the MODEL wrote: whatever it says,
    it is ``ai`` and was materialised from no artifact. Report leaves too."""
    if not isinstance(raw, dict):
        return raw
    out = {**raw, "provenance": "ai", "artifact_kind": None, "allowed_views": []}
    out.pop("open_in", None)
    sections = raw.get("sections")
    if out.get("type") == "report" and isinstance(sections, (list, tuple)):
        out["sections"] = [
            {**section, "blocks": [_as_model_authored(leaf) for leaf in section["blocks"]]}
            if isinstance(section, dict) and isinstance(section.get("blocks"), (list, tuple))
            else section
            for section in sections
        ]
    return out


def validate_blocks(
    raw: Any, *, model_authored: bool = False, allow_ai_data: bool = False,
    max_bytes: int = MAX_BLOCKS_BYTES,
) -> tuple[list[dict[str, Any]], list[DroppedBlock]]:
    """Validate and repair a live answer's blocks. NEVER raises.

    Returns ``(blocks, dropped)``: ``blocks`` are canonical dicts (see
    :func:`dump_block`) ready for ``ChatResponse.blocks``; ``dropped`` lists what was
    removed and why, so the engine can add one quiet notice line. Enforced here:
    the block schema and its repairs, unique ids (a duplicate is suffixed), at most
    :data:`MAX_BLOCKS_PER_MESSAGE` blocks (a report counts as one), at most 40 report
    leaves, the G5 provenance rule, and the serialized-size hard cap ``max_bytes``
    (trailing blocks are dropped first; the answer prose is not a block, so it is
    never what gets cut).

    G5 is decided by the ``provenance`` each block carries, so the CALLER states
    where the blocks came from:

    * ``model_authored=True`` — anything the model wrote. Every block (and report
      leaf) is forced to ``provenance: "ai"`` with no ``artifact_kind`` BEFORE
      validation, so a data block is dropped as ``ai_data_block`` however it labels
      itself, and ``allow_ai_data`` is ignored. The normal path for model output is
      :func:`parse_final_block_requests` + :func:`to_blocks` (refs to tool artifacts,
      prose and callouts only); use this flag for anything else the model emits.
    * ``model_authored=False`` (default) — blocks the ENGINE materialised from tool
      artifacts; their ``provenance`` is trusted as given.

    ``allow_ai_data`` keeps an ``ai`` data block (tests and fixtures only)."""
    if model_authored:
        allow_ai_data = False
        if isinstance(raw, (list, tuple)):
            raw = [_as_model_authored(item) for item in raw]
    dropped: list[DroppedBlock] = []
    if not isinstance(raw, (list, tuple)):
        if raw is not None:
            dropped.append(DroppedBlock("0", None, "not_a_list"))
        return [], dropped
    used: set[str] = set()
    out: list[dict[str, Any]] = []
    size = 2  # the enclosing "[]"
    for index, item in enumerate(raw, start=1):
        path = str(index)
        if len(out) >= MAX_BLOCKS_PER_MESSAGE:
            dropped.append(DroppedBlock(path, _type_of(item), "block_limit"))
            continue
        candidate = _with_id(item, f"b{index}", used)
        if _type_of(candidate) == "report" and isinstance(candidate, dict):
            candidate = _prepare_report(candidate, path, used, dropped, allow_ai_data=allow_ai_data)
        block, drop = _validate_one(candidate, path, allow_ai_data=allow_ai_data, adapter=_ANSWER_BLOCK)
        if drop is not None:
            dropped.append(drop)
            continue
        dumped = dump_block(block)  # type: ignore[arg-type]
        encoded = len(json.dumps(dumped, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        if size + encoded > max_bytes:
            dropped.append(DroppedBlock(path, block.type, "size_limit"))  # type: ignore[union-attr]
            continue
        size += encoded
        out.append(dumped)
    return out, dropped


def fallback_block(block_id: str, *, fallback_text: Any = None) -> dict[str, Any]:
    """The quiet callout that stands in for a block that cannot be displayed (G9)."""
    stub: dict[str, Any] = {
        "id": block_id, "type": "callout", "tone": "info", "provenance": "code",
        "text": FALLBACK_TEXT,
    }
    text = _optional_text(fallback_text, MAX_FALLBACK, multiline=True)
    if text:
        stub["fallback_text"] = text
    return stub


def parse_persisted_blocks(raw: Any, *, limit: int = MAX_BLOCKS_PER_MESSAGE) -> list[dict[str, Any]]:
    """Lenient replay parse of STORED ``blocks``. NEVER raises and keeps POSITIONS:
    an invalid stored block becomes :func:`fallback_block` with its original id (when
    that id is valid), so ``mK.bJ`` digest references still point at the same slot.
    No size cap (stored answers were already compacted, SPEC §7.5); at most ``limit``
    blocks (:data:`MAX_SECTION_BLOCKS` for a report section snapshot) — a caller that
    must disclose clipping compares ``len(raw)`` with ``limit``.

    Stored provenance is TRUSTED here: these blocks passed :func:`validate_blocks`
    when they were written. ``ChatResponse.blocks`` and the report models use this
    function, so neither is an entry point for model output — model-written blocks
    go through :func:`parse_final_block_requests`/:func:`to_blocks` or
    ``validate_blocks(..., model_authored=True)`` first."""
    if not isinstance(raw, (list, tuple)):
        return []
    used: set[str] = set()
    out: list[dict[str, Any]] = []
    for index, item in enumerate(list(raw)[:max(0, limit)], start=1):
        candidate = _with_id(item, f"b{index}", used)
        if _type_of(candidate) == "report" and isinstance(candidate, dict):
            candidate = _prepare_report(candidate, str(index), used, [], allow_ai_data=False)
        block, drop = _validate_one(candidate, str(index), allow_ai_data=False, adapter=_ANSWER_BLOCK)
        if block is not None:
            out.append(dump_block(block))
            continue
        block_id = candidate["id"] if isinstance(candidate, dict) else _unique_id(None, f"b{index}", used)
        fallback = candidate.get("fallback_text") if isinstance(candidate, dict) else None
        out.append(fallback_block(block_id, fallback_text=fallback))
    return out


def expire_block(block: dict[str, Any]) -> dict[str, Any]:
    """The retention stub for an old stored block (SPEC §7.5): a valid quiet callout
    that keeps the id, the title and what the block was, and drops its data."""
    btype = _type_of(block) if _type_of(block) in BLOCK_TYPES else "markdown"
    kind = _enum_or(block.get("artifact_kind"), ARTIFACT_KINDS, None) if isinstance(block, dict) else None
    block_id = block.get("id") if isinstance(block, dict) and isinstance(block.get("id"), str) else "b1"
    if not _BLOCK_ID_RE.match(block_id):
        block_id = "b1"
    stub: dict[str, Any] = {
        "id": block_id, "type": "callout", "tone": "info", "provenance": "code",
        "text": EXPIRED_TEXT, "expired": {"type": btype, "artifact_kind": kind},
    }
    title = _optional_text(block.get("title") if isinstance(block, dict) else None, MAX_TITLE)
    if title:
        stub["title"] = title
    return dump_block(CalloutBlock.model_validate(stub))


def is_expired_block(block: Any) -> bool:
    """True for a retention stub (report "add" answers 409 ``block_unavailable``)."""
    return isinstance(block, dict) and block.get("type") == "callout" and isinstance(block.get("expired"), dict)


def block_view(block: dict[str, Any]) -> str | None:
    """The current view of a block dict (a chart kind, else the block type)."""
    if not isinstance(block, dict):
        return None
    if block.get("type") == "chart":
        return block.get("kind") if isinstance(block.get("kind"), str) else None
    return block.get("type") if isinstance(block.get("type"), str) else None


def allowed_views_for(artifact_kind: str, *, categories: int | None = None) -> list[str]:
    """SPEC §7.3 row for ``artifact_kind`` (``donut`` only while ``categories`` ≤ 6)."""
    views = list(ALLOWED_VIEWS.get(artifact_kind, ()))
    if "donut" in views and categories is not None and categories > MAX_DONUT_SEGMENTS:
        views.remove("donut")
    return views


# --- honest views: totals only where the values add up ------------------------ #
# A stack draws a slot total and a donut a centre total plus shares. A total of
# medians, rates, scores or durations is meaningless ("median 12 min + p90 40 min =
# 52 min" reads as a fact and is not one), so those two views are offered only for
# additive units, or for percentages/ratios whose parts reconcile to the whole (a 100 %
# stack, a share-of-total donut). The exact twin of the webui ``views.isAdditive`` /
# ``chartKindFits`` (same units, same tolerance, same grouping); the client keeps the
# rule as its last guard, the server keeps it so it never OFFERS a view (to the model in
# the tool-call header and replay digest, or to the "Show as" menu) the client refuses.
ADDITIVE_UNITS: tuple[str, ...] = ("count", "tokens", "bytes", "usd")
SHARE_TOLERANCE = 0.5          # percentage points a set of parts may drift from 100
TOTAL_VIEWS: frozenset[str] = frozenset({"stacked_bar", "donut"})   # the views that draw a total


def _parts_make_whole(groups: Iterable[Iterable[Any]], unit: str) -> bool:
    """Do the parts of every complete group reconcile to 100 (or 1 for ``ratio``)? A
    group with a missing part says nothing either way (the renderer hatches it or
    withholds the total), but at least one group must reconcile, so an all-missing set
    is never waved through."""
    whole = 1.0 if unit == "ratio" else 100.0
    tolerance = SHARE_TOLERANCE / 100 if unit == "ratio" else SHARE_TOLERANCE
    checked = 0
    for group in groups:
        parts = [finite_number(v) for v in group]
        if not parts or any(p is None for p in parts):
            continue
        if abs(sum(parts) - whole) > tolerance:   # type: ignore[arg-type]
            return False
        checked += 1
    return checked > 0


def values_are_additive(unit: Any, groups: Iterable[Iterable[Any]]) -> bool:
    """Can these values be summed into a total that means something? ``groups`` are
    the parts of each total: per x slot across the series for a stack, the categories
    of the one series for a donut. Score and the duration units never add up."""
    unit = _unit(unit)
    if unit in ADDITIVE_UNITS:
        return True
    if unit in ("percent", "ratio"):
        return _parts_make_whole(list(groups), unit)
    return False


def _stack_groups(x: list[Any], series: list[Any]) -> list[list[Any]]:
    """The parts of each stacked slot: every series' value at that x (missing = None)."""
    columns = [s.get("values") if isinstance(s, dict) and isinstance(s.get("values"), (list, tuple)) else []
               for s in series]
    return [[col[i] if i < len(col) else None for col in columns] for i in range(len(x))]


def chart_kind_fits(block: dict[str, Any], kind: str) -> bool:
    """Can this CHART block's data honestly be drawn as ``kind``? The twin of the webui
    ``views.chartKindFits``: a donut is one series of at most six categories whose
    values add up (and, server-side only, a complete population: a donut of a clipped
    top-N would draw a whole that is not one); a stack needs additive values; a
    sparkline or funnel draws exactly one series; every other kind fits."""
    series = [s for s in (block.get("series") or []) if isinstance(s, dict)]
    x = block.get("x") if isinstance(block.get("x"), dict) else {}
    x_values = list(x.get("values") or [])
    single = len(series) == 1
    if kind == "donut":
        return (single and len(x_values) <= MAX_DONUT_SEGMENTS and x.get("kind", "category") == "category"
                and not block.get("truncated")
                and values_are_additive(block.get("unit"), [series[0].get("values") or []]))
    if kind == "stacked_bar":
        return values_are_additive(block.get("unit"), _stack_groups(x_values, series))
    if kind in ("sparkline", "funnel"):
        return single
    return True


def artifact_views(artifact: Any) -> list[str]:
    """The views an artifact can HONESTLY be shown in (SPEC §7.3 row, narrowed by its
    data): ``donut`` only for a complete population of at most six additive categories,
    ``sparkline`` only for one series, ``stacked_bar`` only for additive series values.
    The tool-call header should list exactly these (``chat_tools.base.Artifact.views``
    may delegate here); :func:`to_blocks` never materialises a view outside them."""
    kind = str(getattr(artifact, "kind", "") or "")
    views = list(ALLOWED_VIEWS.get(kind, ()))
    data = getattr(artifact, "data", None)
    if not isinstance(data, dict):
        return views
    if kind == "categories":
        labels = data.get("labels") if isinstance(data.get("labels"), (list, tuple)) else []
        values = data.get("values") if isinstance(data.get("values"), (list, tuple)) else []
        complete = (not getattr(artifact, "truncated", False) and not finite_number(data.get("other"))
                    and len(labels) <= MAX_DONUT_SEGMENTS)
        parts = [values[i] if i < len(values) else None for i in range(len(labels))]
        if not (complete and values_are_additive(data.get("unit"), [parts])):
            views = [v for v in views if v != "donut"]
    elif kind == "series":
        x = data.get("x") if isinstance(data.get("x"), (list, tuple)) else []
        series = [s for s in (data.get("series") or []) if isinstance(s, dict)]
        if len(series) > 1:
            views = [v for v in views if v != "sparkline"]
        if not values_are_additive(data.get("unit"), _stack_groups(list(x), series)):
            views = [v for v in views if v != "stacked_bar"]
    return views


def semantic_verdict(value: Any) -> str | None:
    """Map a stored verdict (``TRUE_POSITIVE``, ``true_positive``) to a VerdictKey."""
    return _enum_or(value, VERDICT_KEYS, None)


def semantic_status(value: Any) -> str | None:
    """Map a stored case status to a :data:`CaseStatusKey` (``None`` when unknown)."""
    return _enum_or(value, CASE_STATUS_KEYS, None)


# --------------------------------------------------------------------------- #
# What the model's ``final`` header may ask for (SPEC §4.1). The engine's protocol
# parser validates header entries against these; materialisation turns them into
# blocks. A ref is the ONLY way a number reaches a block.
# --------------------------------------------------------------------------- #
ARTIFACT_REF_PATTERN = r"^t([1-9][0-9]{0,2})\.a([1-9][0-9]{0,2})$"   # tN.aK, this turn
STORED_REF_PATTERN = r"^m([1-9][0-9]{0,2})\.b([1-9][0-9]{0,2})$"     # mK.bJ, earlier turn
ARTIFACT_REF_RE = re.compile(ARTIFACT_REF_PATTERN)
STORED_REF_RE = re.compile(STORED_REF_PATTERN)


class BlockRefRequest(_Strict):
    """``{"ref": "t2.a1", "view": "hbar", "title": "...", "top_n": 10}``."""

    ref: str = Field(pattern=f"{ARTIFACT_REF_PATTERN}|{STORED_REF_PATTERN}")
    view: BlockView | None = None
    title: OptTitle = None
    top_n: int | None = Field(default=None, ge=1, le=MAX_POINTS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["view"] = _enum_or(data.get("view"), BLOCK_VIEWS, None)
            top_n = data.get("top_n")
            if top_n is not None:
                number = finite_number(top_n)
                data["top_n"] = None if number is None else min(max(int(number), 1), MAX_POINTS)
        return data

    @property
    def is_stored(self) -> bool:
        return bool(STORED_REF_RE.match(self.ref))


class ModelCalloutRequest(_Strict):
    type: Literal["callout"]
    tone: ToneKey = "info"
    text: _text_type(MAX_CALLOUT, multiline=True)
    title: OptTitle = None

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = {**data, "tone": _enum_or(data.get("tone"), TONES, "info")}
        return data


class ModelMarkdownRequest(_Strict):
    type: Literal["markdown"]
    text: _text_type(MAX_MARKDOWN, multiline=True)
    title: OptTitle = None


def _only(value: dict[str, Any], model: type[BaseModel]) -> dict[str, Any]:
    """The keys of ``value`` that ``model`` reads. Models add keys of their own (an
    ``id``, a ``provenance`` claim, a ``type`` beside a ``ref``); dropping the WHOLE
    request for that lost a valid callout or chart (a wave-1 strictness bug). The
    claim itself is meaningless anyway: a ref's provenance comes from the artifact
    and a model-written block is always ``ai``."""
    return {k: v for k, v in value.items() if k in model.model_fields}


def _leaf_request(value: Any) -> Any:
    if isinstance(value, (BlockRefRequest, ModelCalloutRequest, ModelMarkdownRequest)):
        return value
    if isinstance(value, dict) and "ref" in value:
        return BlockRefRequest.model_validate(_only(value, BlockRefRequest))
    if isinstance(value, dict) and value.get("type") == "callout":
        return ModelCalloutRequest.model_validate(_only(value, ModelCalloutRequest))
    if isinstance(value, dict) and value.get("type") == "markdown":
        return ModelMarkdownRequest.model_validate(_only(value, ModelMarkdownRequest))
    raise ValueError("a report leaf is a ref, a callout or markdown")


LeafRequest = Annotated[
    Union[BlockRefRequest, ModelCalloutRequest, ModelMarkdownRequest],
    BeforeValidator(_leaf_request),
]
_LEAF_REQUEST = TypeAdapter(LeafRequest)


def _count_valid(adapter: TypeAdapter, items: Any, limit: int) -> tuple[list[Any], int]:
    """Like :func:`_filter_valid`, but returns how many entries were NOT kept
    (invalid or over ``limit``) so the engine can say so in its one notice."""
    if items is None:
        return [], 0
    if not isinstance(items, (list, tuple)):
        return [], 1
    out: list[Any] = []
    lost = 0
    for item in items:
        if len(out) >= limit:
            lost += 1
            continue
        try:
            out.append(adapter.validate_python(item))
        except Exception:  # noqa: BLE001 -- one bad leaf never sinks the section
            lost += 1
    return out, lost


class ReportSectionRequest(_Strict):
    """One model-written section. Tolerant like the leaves (wave-1 strictness fix):
    keys it does not read (an ``id``) are ignored, ``blocks`` — the persisted
    section's own key in BLOCKS.md — is accepted for ``items``, and a missing heading
    gets a neutral one. ``invalid_items`` is ENGINE-SET (any model value is
    overwritten): the leaves that could not be kept, for the turn's one notice."""

    heading: Title
    summary: _opt_text_type(MAX_SECTION_SUMMARY, multiline=True) = None
    items: list[LeafRequest] = Field(default_factory=list, max_length=MAX_REPORT_LEAVES)
    invalid_items: int = 0

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            raw = data.get("items")
            if raw is None:
                raw = data.get("blocks")
            items, lost = _count_valid(_LEAF_REQUEST, raw, MAX_REPORT_LEAVES)
            data = {**_only(data, cls), "items": items, "invalid_items": lost}
            if not isinstance(data.get("heading"), str) or not data["heading"].strip():
                data["heading"] = "Details"
        return data


_SECTION_REQUEST = TypeAdapter(ReportSectionRequest)


class ReportEnvelopeRequest(_Strict):
    """The model-written ``report`` envelope; leaves only (no nested report). Keys
    it does not read are ignored rather than fatal (a whole brief was lost for an
    ``id``), sections past the limit and leaves past the 40-leaf budget are clipped
    instead of failing the envelope, and every leaf that was lost is counted in the
    ENGINE-SET ``invalid_items`` so the answer says so."""

    type: Literal["report"]
    title: Title
    subtitle: _opt_text_type(200) = None
    template: ReportTemplate = "custom"
    sections: list[ReportSectionRequest] = Field(min_length=1, max_length=MAX_REPORT_SECTIONS)
    invalid_items: int = 0

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = _only(data, cls)
            data["template"] = _enum_or(data.get("template"), REPORT_TEMPLATES, "custom")
            if not isinstance(data.get("title"), str) or not data["title"].strip():
                data["title"] = "Report"
            raw_sections = data.get("sections")
            raw_sections = list(raw_sections) if isinstance(raw_sections, (list, tuple)) else []
            sections: list[ReportSectionRequest] = []
            lost = 0
            budget = MAX_REPORT_LEAVES
            for raw in raw_sections:
                if len(sections) >= MAX_REPORT_SECTIONS:
                    lost += _raw_leaf_count(raw)
                    continue
                try:
                    section = _SECTION_REQUEST.validate_python(raw)
                except Exception:  # noqa: BLE001 -- one bad section never sinks the brief
                    lost += _raw_leaf_count(raw)
                    continue
                lost += section.invalid_items
                if len(section.items) > budget:
                    lost += len(section.items) - budget
                    section = section.model_copy(update={"items": section.items[:budget]})
                budget -= len(section.items)
                sections.append(section)
            data["sections"] = sections
            data["invalid_items"] = lost
        return data

    @model_validator(mode="after")
    def _leaf_budget(self) -> "ReportEnvelopeRequest":
        if sum(len(s.items) for s in self.sections) > MAX_REPORT_LEAVES:
            raise ValueError("a report holds at most 40 leaves")
        return self


def _raw_leaf_count(raw: Any) -> int:
    """How many leaves an unparsable/clipped raw section held (at least one)."""
    if isinstance(raw, dict):
        items = raw.get("items") if raw.get("items") is not None else raw.get("blocks")
        if isinstance(items, (list, tuple)):
            return max(1, len(items))
    return 1


def _final_request(value: Any) -> Any:
    if isinstance(value, ReportEnvelopeRequest):
        return value
    if isinstance(value, dict) and value.get("type") == "report":
        return ReportEnvelopeRequest.model_validate(value)
    return _leaf_request(value)


FinalBlockRequest = Annotated[
    Union[BlockRefRequest, ModelCalloutRequest, ModelMarkdownRequest, ReportEnvelopeRequest],
    BeforeValidator(_final_request),
]
_FINAL_REQUEST = TypeAdapter(FinalBlockRequest)


def parse_final_block_requests(raw: Any) -> tuple[list[Any], list[DroppedBlock]]:
    """Parse ``final.blocks`` leniently: each entry becomes a typed request or a
    :class:`DroppedBlock`; at most :data:`MAX_BLOCKS_PER_MESSAGE`. Never raises."""
    dropped: list[DroppedBlock] = []
    if not isinstance(raw, (list, tuple)):
        return [], ([DroppedBlock("0", None, "not_a_list")] if raw is not None else [])
    out: list[Any] = []
    seen: set[tuple[Any, ...]] = set()
    for index, item in enumerate(raw, start=1):
        if len(out) >= MAX_BLOCKS_PER_MESSAGE:
            dropped.append(DroppedBlock(str(index), _type_of(item), "block_limit"))
            continue
        try:
            request = _FINAL_REQUEST.validate_python(item)
        except Exception as exc:  # noqa: BLE001
            dropped.append(DroppedBlock(str(index), _type_of(item), _reason(exc)))
            continue
        if isinstance(request, BlockRefRequest):
            # An identical repeat adds nothing and must not use up the block limit.
            key = (request.ref, request.view, request.top_n)
            if key in seen:
                continue
            seen.add(key)
        out.append(request)
    return out, dropped


# --------------------------------------------------------------------------- #
# Materialisation (SPEC §7.3): tool artifacts → answer blocks.
#
# A block is a PROJECTION of an artifact, never a computation: every number in a
# block is a number the tool put in ``Artifact.data`` (G5), re-ordered or clipped but
# never summed, averaged or folded. That is why a donut is offered only for a
# COMPLETE category population (no "Other" slice has to be invented), why a time
# series past the point limit keeps its newest points instead of being re-bucketed,
# and why a view change of a STORED block (``mK.bJ``) first turns the block back into
# the artifact data it came from and then re-runs the very same projection.
#
# Every table view has a canonical column layout (stable column keys per artifact
# kind, below) so that projection is reversible: a stored table can become a chart
# again without guessing which column held which number.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class MaterialiseOptions:
    """How one artifact should become a block: the requested ``view`` (None = the
    kind's default), a clamped, display-sanitised ``title`` and ``top_n``, the block
    ``block_id`` and the effective window ``caption``."""

    block_id: str
    view: str | None = None
    title: str | None = None
    top_n: int | None = None
    caption: str | None = None
    from_step: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# The y-series label a chart shows when the artifact names none (one unit per chart, G6).
_UNIT_LABELS: dict[str, str] = {
    "count": "Count", "percent": "Percent", "ratio": "Ratio", "score": "Score",
    "ms": "Milliseconds", "seconds": "Seconds", "minutes": "Minutes", "hours": "Hours",
    "usd": "Cost (USD)", "tokens": "Tokens", "bytes": "Bytes",
}
_BASIS_CAPTIONS: dict[str, str] = {
    "newest_n": "Sampled from the newest events",
    "sample": "Sample",
    "cached": "Cached result",
}
# Canonical table-view column keys per artifact kind (see the section note).
_CATEGORY_COLUMNS = ("label", "value")
_FUNNEL_COLUMNS = ("stage", "value")
_KPI_COLUMNS = ("label", "value", "unit", "context")
_HEATMAP_COLUMNS = ("y", "x", "value")
_CASE_COLUMNS = ("case_id", "title", "severity", "verdict", "status", "risk", "created_at")
_TIMELINE_COLUMNS = ("at", "label", "detail", "kind")
_SERIES_X_COLUMN = "x"
# Fields every block carries that are not artifact data (stripped when a stored
# block is turned back into artifact data for a view change).
_BASE_FIELDS = frozenset(_BlockBase.model_fields)


def _unit(value: Any, fallback: str = "count") -> str:
    return _enum_or(value, VALUE_UNITS, fallback)


def _label_text(value: Any, limit: int = MAX_CATEGORY_CHARS) -> str:
    """A category / axis / row label: text or a JS-formatted number, else ``""``."""
    if isinstance(value, bool):
        return ""
    if isinstance(value, (str, int, float)):
        return display_text(value, limit)
    return ""


def _fmt_count(value: int) -> str:
    return f"{value:,}"


def _caption(
    artifact: Any, options: MaterialiseOptions, truncation: str | None,
) -> str | None:
    """The scope caption: truncation disclosure (G4), sample basis, effective window.
    An explicit ``options.caption`` (a stored block's, on a view change) is kept, but
    a truncation phrase it does not already state is put in front of it: a stored
    caption can predate the clipping (storage compaction, a smaller view)."""
    if options.caption:
        explicit = display_text(options.caption, MAX_CAPTION)
        if truncation and truncation not in explicit:
            return display_text(f"{truncation} · {explicit}" if explicit else truncation, MAX_CAPTION) or None
        return explicit or None
    parts: list[str] = []
    if truncation:
        parts.append(truncation)
    basis = _BASIS_CAPTIONS.get(str(getattr(artifact, "basis", None) or ""))
    if basis:
        parts.append(basis)
    window = getattr(artifact, "window", None)
    if isinstance(window, str) and window.strip():
        parts.append(display_text(window, 80))
    text = " · ".join(p for p in parts if p)
    return display_text(text, MAX_CAPTION) or None


def _honest_block_views(raw: dict[str, Any], kind: str) -> list[str]:
    """``raw``'s ``allowed_views`` narrowed to what the block AS SHOWN supports: a
    chart is judged exactly as the client's "Show as" menu judges it (it re-renders
    this same data); any other view of the data (a table, say) is judged on the data
    read back from it, which is what a later ``mK.bJ`` view change would use, so a
    clipped top-N table never offers a donut or a stack that no longer adds up."""
    views = [v for v in raw.get("allowed_views") or [] if isinstance(v, str)]
    if raw.get("type") == "chart":
        return [v for v in views if v not in CHART_KINDS or chart_kind_fits(raw, v)]
    if not TOTAL_VIEWS.intersection(views):
        return views
    data = _artifact_data_from_block({**raw, "artifact_kind": kind})
    honest = set(artifact_views(SimpleNamespace(kind=kind, data=data, truncated=bool(raw.get("truncated"))))
                 if isinstance(data, dict) else ())
    return [v for v in views if v not in TOTAL_VIEWS or v in honest]


def _views_of(artifact: Any) -> list[str]:
    """The artifact's own view list (``Artifact.views()``, else the §7.3 row) narrowed
    to the views its data can honestly support (:func:`artifact_views`), so a requested
    stack or donut of values that do not add up falls back to the default view."""
    honest = artifact_views(artifact)
    views = getattr(artifact, "views", None)
    if callable(views):
        try:
            return [v for v in views() if v in BLOCK_VIEWS and v in honest]
        except Exception:  # noqa: BLE001 -- a duck-typed artifact falls back to the table
            pass
    return honest


def _top_n(options: MaterialiseOptions, available: int) -> int:
    limit = options.top_n if isinstance(options.top_n, int) and options.top_n > 0 else available
    return max(0, min(limit, available))


def _sorted_categories(data: dict[str, Any]) -> tuple[list[str], list[int | float | None]]:
    """Labels and values aligned, sorted by value descending (not measured last), ties
    by label, so the order — and with it every colour — is deterministic."""
    labels = data.get("labels") if isinstance(data.get("labels"), (list, tuple)) else []
    values = data.get("values") if isinstance(data.get("values"), (list, tuple)) else []
    pairs = [
        (_label_text(label), finite_number(values[i]) if i < len(values) else None)
        for i, label in enumerate(labels)
    ]
    pairs.sort(key=lambda p: (p[1] is None, -(p[1] or 0), p[0]))
    return [p[0] for p in pairs], [p[1] for p in pairs]


def _value_label(data: dict[str, Any], unit: str) -> str:
    label = data.get("value_label")
    return display_text(label, MAX_LABEL) if isinstance(label, str) and label.strip() else _UNIT_LABELS.get(unit, "Value")


def _base_block(
    artifact: Any, options: MaterialiseOptions, views: list[str],
) -> dict[str, Any]:
    title = options.title or getattr(artifact, "title", None)
    out: dict[str, Any] = {
        "id": options.block_id,
        "provenance": getattr(artifact, "provenance", "code"),
        "artifact_kind": getattr(artifact, "kind", None),
        "allowed_views": views,
        "untrusted": bool(getattr(artifact, "untrusted_labels", False)),
        "as_of": getattr(artifact, "as_of", None),
        "from_step": options.from_step,
    }
    if title:
        out["title"] = title
    open_in = artifact.data.get("open_in") if isinstance(getattr(artifact, "data", None), dict) else None
    if isinstance(open_in, dict):
        # The tool-side "exact console view" (see ``_BlockBase.open_in``); validation
        # keeps it only when it is a valid ref, and never on an ``ai`` block.
        out["open_in"] = open_in
    return out


def _with_truncation(
    block: dict[str, Any], artifact: Any, options: MaterialiseOptions, *, shown: int,
    available: int, noun: str | None = "Top",
) -> dict[str, Any]:
    """Set ``truncated``/``total`` and the caption from what is shown vs. what the
    artifact (or the tool's population) holds."""
    population = getattr(artifact, "total", None)
    population = population if isinstance(population, int) and not isinstance(population, bool) and population >= 0 else None
    clipped = shown < available
    truncated = bool(block.get("truncated")) or bool(getattr(artifact, "truncated", False)) or clipped
    phrase: str | None = None
    if truncated:
        whole = population if population is not None and population > shown else (available if clipped else None)
        block["total"] = whole
        if noun is None:
            phrase = "Partial result"
        elif noun == "Latest":
            phrase = f"Latest {_fmt_count(shown)} of {_fmt_count(whole)}" if whole else f"Latest {_fmt_count(shown)}"
        else:
            phrase = f"{noun} {_fmt_count(shown)} of {_fmt_count(whole)}" if whole else f"{noun} {_fmt_count(shown)} shown"
    block["truncated"] = truncated
    caption = _caption(artifact, options, phrase)
    if caption:
        block["caption"] = caption
    elif truncated:
        block["caption"] = "Partial result"
    return block


def _number_column(key: str, label: str, unit: str | None) -> dict[str, Any]:
    column: dict[str, Any] = {"key": key, "label": label, "type": "number", "align": "right"}
    if unit:
        column["unit"] = unit
    return column


def _text_column(key: str, label: str, *, untrusted: bool = False, ctype: str = "text") -> dict[str, Any]:
    column: dict[str, Any] = {"key": key, "label": label, "type": ctype}
    if untrusted:
        column["untrusted"] = True
    return column


def _build_categories(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    data = artifact.data
    labels, values = _sorted_categories(data)
    unit = _unit(data.get("unit"))
    other = finite_number(data.get("other"))
    # A donut is a part-to-whole: only for a COMPLETE population that fits in six
    # slices (an "Other" slice would be a number the tool never produced).
    complete = not getattr(artifact, "truncated", False) and not other and len(labels) <= MAX_DONUT_SEGMENTS
    if not complete:
        views = [v for v in views if v != "donut"]
        if view == "donut":
            view = views[0] if views else "hbar"
    n = _top_n(options, len(labels)) if view != "donut" else len(labels)
    # The view's own limit is a clip like top_n, so it is disclosed the same way
    # (``total`` + caption) instead of being cut later by validation.
    n = min(n, MAX_TABLE_ROWS if view == "table" else MAX_POINTS)
    block = _base_block(artifact, options, views)
    dimension = _label_text(data.get("dimension"), MAX_LABEL) or None
    if view == "table":
        block.update({
            "type": "table",
            "columns": [
                _text_column(_CATEGORY_COLUMNS[0], dimension or "Value", untrusted=block["untrusted"]),
                _number_column(_CATEGORY_COLUMNS[1], _value_label(data, unit), unit),
            ],
            "rows": [[labels[i], values[i]] for i in range(n)],
        })
    else:
        block.update({
            "type": "chart", "kind": view, "unit": unit,
            "x": {"kind": "category", "values": labels[:n], **({"label": dimension} if dimension else {})},
            "series": [{"key": "value", "label": _value_label(data, unit), "values": values[:n]}],
        })
        drill = data.get("drill")
        if isinstance(drill, (list, tuple)) and len(drill) == len(data.get("labels") or []):
            # Re-align the drill refs with the sorted labels (by original label text).
            by_label = {_label_text(lbl): ref for lbl, ref in zip(data.get("labels") or [], drill)}
            block["drill"] = [by_label.get(lbl) for lbl in labels[:n]]
    return _with_truncation(block, artifact, options, shown=n, available=len(labels))


def _series_rows(data: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]], bool]:
    x_raw = data.get("x") if isinstance(data.get("x"), (list, tuple)) else []
    x = [_label_text(v) for v in x_raw]
    series: list[dict[str, Any]] = []
    for index, item in enumerate(data.get("series") or []):
        if not isinstance(item, dict):
            continue
        raw = item.get("values") if isinstance(item.get("values"), (list, tuple)) else []
        values = [finite_number(raw[i]) if i < len(raw) else None for i in range(len(x))]
        key = item.get("key") if isinstance(item.get("key"), str) and _KEY_RE.match(item["key"]) else f"s{index + 1}"
        entry: dict[str, Any] = {
            "key": key,
            "label": _label_text(item.get("label"), MAX_LABEL) or key,
            "values": values,
        }
        semantic = _enum_or(item.get("semantic"), SEMANTIC_KEYS, None)
        if semantic:
            entry["semantic"] = semantic
        series.append(entry)
    x_kind = _enum_or(data.get("x_kind"), X_KINDS, None)
    if x_kind is None:
        x_kind = "time" if x and all(parse_timestamp(v) is not None for v in x) else "category"
    return x, series, x_kind == "time"


def _series_order(series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Descending total (not-measured points count as nothing), ties by label; a
    series named "Other" always goes last (``--chart-8``)."""
    def key(item: dict[str, Any]) -> tuple[bool, float, str]:
        other = str(item.get("key")).lower() == "other" or str(item.get("label")).lower() == "other"
        total = sum(v for v in item["values"] if v is not None)
        return (other, -total, str(item.get("label")))
    return sorted(series, key=key)


def _build_series(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    data = artifact.data
    x, series, is_time = _series_rows(data)
    series = _series_order(series)
    unit = _unit(data.get("unit"))
    if len(series) > 1:
        # A sparkline draws exactly one series; never pick one silently.
        views = [v for v in views if v != "sparkline"]
        if view == "sparkline":
            view = views[0] if views else "line"
    available = len(series)
    keep = _top_n(options, available)
    if keep > MAX_SERIES:
        others = [s for s in series[:keep] if str(s["key"]).lower() == "other"]
        keep_list = [s for s in series[:keep] if str(s["key"]).lower() != "other"][: MAX_SERIES - len(others)] + others
    else:
        keep_list = series[:keep]
    points = len(x)
    start = max(0, points - MAX_POINTS) if is_time else 0
    stop = points if is_time else min(points, MAX_POINTS)
    block = _base_block(artifact, options, views)
    if view == "table":
        columns = [_text_column(_SERIES_X_COLUMN, _label_text(data.get("x_label"), MAX_LABEL) or ("Time" if is_time else "Category"),
                                ctype="time" if is_time else "text", untrusted=block["untrusted"] and not is_time)]
        columns += [_number_column(s["key"], s["label"], unit) for s in keep_list[: MAX_TABLE_COLUMNS - 1]]
        # A table holds fewer rows than a chart holds points: time keeps the newest.
        if stop - start > MAX_TABLE_ROWS:
            if is_time:
                start = stop - MAX_TABLE_ROWS
            else:
                stop = start + MAX_TABLE_ROWS
        rows = [
            [x[i], *(s["values"][i] for s in keep_list[: MAX_TABLE_COLUMNS - 1])]
            for i in range(start, stop)
        ]
        block.update({"type": "table", "columns": columns, "rows": rows})
    else:
        x_block: dict[str, Any] = {"kind": "time" if is_time else "category", "values": x[start:stop]}
        x_label = _label_text(data.get("x_label"), MAX_LABEL)
        if x_label:
            x_block["label"] = x_label
        bucket = _enum_or(data.get("bucket"), TIME_BUCKETS, None)
        if bucket:
            x_block["bucket"] = bucket
        block.update({
            "type": "chart", "kind": view, "unit": unit, "x": x_block,
            "series": [{**s, "values": s["values"][start:stop]} for s in keep_list],
        })
        if data.get("last_in_progress") is True and is_time and stop == points:
            block["last_in_progress"] = True
        if isinstance(data.get("reference"), dict):
            block["reference"] = data["reference"]
    shown_points = stop - start
    if shown_points < points:
        return _with_truncation(block, artifact, options, shown=shown_points, available=points,
                                noun="Latest" if is_time else "Top")
    return _with_truncation(block, artifact, options, shown=len(keep_list), available=available)


def _build_funnel(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    data = artifact.data
    stages_raw = data.get("stages") if isinstance(data.get("stages"), (list, tuple)) else []
    values_raw = data.get("values") if isinstance(data.get("values"), (list, tuple)) else []
    stages = [_label_text(s) for s in stages_raw][:MAX_POINTS]
    values = [finite_number(values_raw[i]) if i < len(values_raw) else None for i in range(len(stages))]
    unit = _unit(data.get("unit"))
    block = _base_block(artifact, options, views)
    if view == "table":
        block.update({
            "type": "table",
            "columns": [_text_column(_FUNNEL_COLUMNS[0], "Stage"),
                        _number_column(_FUNNEL_COLUMNS[1], _value_label(data, unit), unit)],
            "rows": [[stages[i], values[i]] for i in range(len(stages))],
        })
    else:
        # Stages keep their order (a funnel is ordered by definition, never by size).
        block.update({
            "type": "chart", "kind": view, "unit": unit,
            "x": {"kind": "category", "values": stages},
            "series": [{"key": "value", "label": _value_label(data, unit), "values": values}],
        })
    return _with_truncation(block, artifact, options, shown=len(stages), available=len(stages))


def _build_kpis(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    raw = [i for i in (artifact.data.get("items") or []) if isinstance(i, dict)]
    items: list[dict[str, Any]] = []
    for item in raw:
        # An item the KPI schema rejects would be dropped silently by validation;
        # leave it out here instead, where it still counts towards ``total``.
        try:
            _KPI_ITEM.validate_python(item)
        except Exception:  # noqa: BLE001
            continue
        items.append(dict(item))
    limit = MAX_KPI_ITEMS if view == "kpi_group" else MAX_TABLE_ROWS
    n = min(_top_n(options, len(items)), limit)
    block = _base_block(artifact, options, views)
    if view == "table":
        block.update({
            "type": "table",
            "columns": [_text_column("label", "Metric"), _number_column("value", "Value", None),
                        _text_column("unit", "Unit"), _text_column("context", "Context")],
            "rows": [
                [_label_text(i.get("label"), MAX_LABEL), finite_number(i.get("value")),
                 _unit(i.get("unit")), _label_text(i.get("context"), MAX_LABEL) or None]
                for i in items[:n]
            ],
        })
    else:
        block.update({"type": "kpi_group", "items": items[:n]})
    return _with_truncation(block, artifact, options, shown=n, available=len(raw), noun="Showing")


def _build_table(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    data = artifact.data
    all_columns = [dict(c) for c in (data.get("columns") or []) if isinstance(c, dict)]
    columns = all_columns[:MAX_TABLE_COLUMNS]
    if getattr(artifact, "untrusted_labels", False):
        # Source rows are log-derived: every text-like column renders as untrusted (G7).
        for column in columns:
            if column.get("type", "text") in ("text", "entity", "code"):
                column.setdefault("untrusted", True)
    rows = [list(r)[: len(columns)] for r in (data.get("rows") or []) if isinstance(r, (list, tuple))]
    n = min(_top_n(options, len(rows)), MAX_TABLE_ROWS)
    block = _base_block(artifact, options, views)
    block.update({"type": "table", "columns": columns, "rows": rows[:n]})
    if isinstance(data.get("sort"), dict):
        block["sort"] = data["sort"]
    clipped_columns = len(all_columns) - len(columns)
    if clipped_columns:
        block["truncated"] = True  # hidden columns are a partial result too (G4)
    out = _with_truncation(block, artifact, options, shown=n, available=len(rows))
    if clipped_columns:
        note = f"First {_fmt_count(len(columns))} of {_fmt_count(len(all_columns))} columns"
        caption = out.get("caption")
        out["caption"] = display_text(
            note if caption in (None, "", "Partial result") else f"{caption} · {note}", MAX_CAPTION)
    return out


def _build_heatmap(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    data = artifact.data
    x = [_label_text(v) for v in (data.get("x") or [])]
    y = [_label_text(v) for v in (data.get("y") or [])]
    raw_cells = data.get("cells") if isinstance(data.get("cells"), (list, tuple)) else []
    unit = _unit(data.get("unit"))
    block = _base_block(artifact, options, views)
    x_label = _label_text(data.get("x_label"), MAX_LABEL) or None
    y_label = _label_text(data.get("y_label"), MAX_LABEL) or None
    rows_n = min(_top_n(options, len(y)), MAX_HEATMAP_Y)
    cols_n = min(len(x), MAX_HEATMAP_X)

    def cell(r: int, c: int) -> int | float | None:
        row = raw_cells[r] if r < len(raw_cells) and isinstance(raw_cells[r], (list, tuple)) else []
        return finite_number(row[c]) if c < len(row) else None

    if view == "table":
        # Long format (y, x, value): a 48-column grid cannot be a 12-column table.
        # Measured cells only, largest first (ties keep grid order).
        cells = [(y[r], x[c], cell(r, c)) for r in range(len(y)) for c in range(len(x)) if cell(r, c) is not None]
        cells.sort(key=lambda t: -(t[2] or 0))
        block.update({
            "type": "table",
            "columns": [_text_column("y", y_label or "Row", untrusted=block["untrusted"]),
                        _text_column("x", x_label or "Column", untrusted=block["untrusted"]),
                        _number_column("value", _value_label(data, unit), unit)],
            "rows": [list(t) for t in cells[:MAX_TABLE_ROWS]],
        })
        return _with_truncation(block, artifact, options, shown=min(len(cells), MAX_TABLE_ROWS), available=len(cells))
    block.update({
        "type": "heatmap", "unit": unit,
        "x": {"values": x[:cols_n], **({"label": x_label} if x_label else {})},
        "y": {"values": y[:rows_n], **({"label": y_label} if y_label else {})},
        "cells": [[cell(r, c) for c in range(cols_n)] for r in range(rows_n)],
    })
    if cols_n < len(x):
        block["truncated"] = True
    return _with_truncation(block, artifact, options, shown=rows_n, available=len(y))


def _build_case_list(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    items = [dict(i) for i in (artifact.data.get("items") or []) if isinstance(i, dict)]
    limit = MAX_CASE_LIST if view == "case_list" else MAX_TABLE_ROWS
    n = min(_top_n(options, len(items)), limit)
    block = _base_block(artifact, options, views)
    if view == "table":
        block.update({
            "type": "table",
            "columns": [
                _text_column("case_id", "Case", ctype="case"), _text_column("title", "Title", untrusted=True),
                _text_column("severity", "Severity", ctype="severity"),
                _text_column("verdict", "Verdict", ctype="verdict"),
                _text_column("status", "Status", ctype="status"),
                {"key": "risk", "label": "Risk", "type": "risk", "unit": "score", "align": "right"},
                _text_column("created_at", "Created", ctype="time"),
            ],
            "rows": [
                [i.get("case_id"), i.get("title"), _enum_or(i.get("severity"), SEVERITY_KEYS, None),
                 semantic_verdict(i.get("verdict")), semantic_status(i.get("status")),
                 finite_number(i.get("risk")), _iso_or_none(i.get("created_at"))]
                for i in items[:n]
            ],
        })
    else:
        block.update({"type": "case_list", "items": items[:n]})
    return _with_truncation(block, artifact, options, shown=n, available=len(items))


def _build_timeline(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
    events = [dict(e) for e in (artifact.data.get("events") or []) if isinstance(e, dict)]
    events.sort(key=lambda e: _sort_instant(e.get("at")) if isinstance(e.get("at"), str) else math.inf)
    limit = MAX_TIMELINE if view == "timeline" else MAX_TABLE_ROWS
    n = min(_top_n(options, len(events)), limit)
    shown = events[-n:] if n else []   # the newest events, still ascending
    block = _base_block(artifact, options, views)
    if view == "table":
        block.update({
            "type": "table",
            "columns": [_text_column("at", "Time", ctype="time"),
                        _text_column("label", "Event", untrusted=block["untrusted"]),
                        _text_column("detail", "Detail", untrusted=block["untrusted"]),
                        _text_column("kind", "Kind")],
            "rows": [[e.get("at"), e.get("label"), e.get("detail"),
                      _enum_or(e.get("kind"), TIMELINE_KINDS, None)] for e in shown],
        })
    else:
        block.update({"type": "timeline", "events": shown})
    return _with_truncation(block, artifact, options, shown=len(shown), available=len(events), noun="Latest")


def _build_passthrough(block_type: str, keys: tuple[str, ...]) -> Any:
    """Single-view kinds whose artifact data already IS the block body."""
    def build(artifact: Any, options: MaterialiseOptions, view: str, views: list[str]) -> dict[str, Any]:
        block = _base_block(artifact, options, views)
        block["type"] = block_type
        for key in keys:
            if key in artifact.data:
                block[key] = artifact.data[key]
        return _with_truncation(block, artifact, options, shown=1, available=1, noun=None)
    return build


_BUILDERS: dict[str, Any] = {
    "categories": _build_categories,
    "series": _build_series,
    "funnel": _build_funnel,
    "kpis": _build_kpis,
    "table": _build_table,
    "heatmap": _build_heatmap,
    "case_list": _build_case_list,
    "timeline": _build_timeline,
    "entity": _build_passthrough("entity", (
        "entity", "risk", "verdict", "facts", "reputation", "counts", "related_cases",
        "first_seen", "last_seen",
    )),
    "mitre": _build_passthrough("mitre", ("techniques",)),
    "guide": _build_passthrough("guide", ("steps", "links")),
    "query": _build_passthrough("query", ("language", "query", "source_name", "hits")),
}


def to_blocks(artifact: "Artifact", options: MaterialiseOptions) -> list[dict[str, Any]]:
    """Materialise ``artifact`` into validated block dicts (one, or none when the
    artifact cannot form a valid block) in the requested view.

    Deterministic; never invents numbers: numbers come only from ``artifact.data``
    and carry ``artifact.provenance`` (``code``/``source``, never ``ai``). A view the
    artifact does not offer falls back to the kind's default view; ``top_n`` and
    ``title`` arrive clamped and display-sanitised from :class:`BlockRefRequest`."""
    kind = getattr(artifact, "kind", None)
    builder = _BUILDERS.get(kind) if isinstance(kind, str) else None
    data = getattr(artifact, "data", None)
    if builder is None or not isinstance(data, dict):
        return []
    if getattr(artifact, "provenance", None) not in ("code", "source"):
        return []  # G5: only a tool-produced artifact can carry numbers
    views = _views_of(artifact)
    view = options.view if options.view in views else DEFAULT_VIEW[kind]
    try:
        raw = builder(artifact, options, view, list(views))
        if raw.get("type") == "chart" and not chart_kind_fits(raw, str(raw.get("kind"))):
            # The CLIPPED block no longer supports its kind (a top-N cut that breaks a
            # 100 % stack, say): draw the honest default instead of an invented total.
            raw = builder(artifact, options, DEFAULT_VIEW[kind], list(views))
        raw["allowed_views"] = _honest_block_views(raw, kind)
    except Exception:  # noqa: BLE001 -- a malformed artifact never sinks the answer
        return []
    block, _drop = _validate_one(raw, "1", allow_ai_data=False, adapter=_LEAF_BLOCK)
    return [dump_block(block)] if block is not None else []


# --- stored blocks back to artifact data (for ``mK.bJ`` view changes) ---------- #
def _column_index(block: dict[str, Any], key: str) -> int | None:
    for index, column in enumerate(block.get("columns") or []):
        if isinstance(column, dict) and column.get("key") == key:
            return index
    return None


def _table_column(block: dict[str, Any], key: str) -> list[Any] | None:
    index = _column_index(block, key)
    if index is None:
        return None
    return [row[index] if isinstance(row, list) and index < len(row) else None for row in block.get("rows") or []]


def _column_unit(block: dict[str, Any], key: str) -> str:
    index = _column_index(block, key)
    column = (block.get("columns") or [])[index] if index is not None else {}
    return _unit(column.get("unit") if isinstance(column, dict) else None)


def artifact_data_from_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """The artifact data a STORED block was materialised from (the inverse of the
    projection above), or ``None`` when the block cannot be read back (a stub, a
    model-written block, or a table whose canonical columns are missing). A block's
    ``open_in`` console view travels with its data, so a view change keeps it."""
    data = _artifact_data_from_block(block)
    if data is not None and isinstance(block.get("open_in"), dict):
        data["open_in"] = block["open_in"]
    return data


def _artifact_data_from_block(block: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(block, dict) or is_expired_block(block):
        return None
    kind = block.get("artifact_kind")
    btype = block.get("type")
    if kind not in ARTIFACT_KINDS:
        return None
    if kind == "categories":
        if btype == "chart":
            series = (block.get("series") or [{}])[0]
            x = block.get("x") or {}
            return {"labels": list(x.get("values") or []), "values": list(series.get("values") or []),
                    "unit": block.get("unit"), "dimension": x.get("label"), "value_label": series.get("label")}
        labels, values = _table_column(block, "label"), _table_column(block, "value")
        if labels is None or values is None:
            return None
        return {"labels": labels, "values": values, "unit": _column_unit(block, "value")}
    if kind == "series":
        if btype == "chart":
            x = block.get("x") or {}
            return {"x": list(x.get("values") or []), "series": list(block.get("series") or []),
                    "unit": block.get("unit"), "x_kind": x.get("kind"), "bucket": x.get("bucket"),
                    "x_label": x.get("label"), "last_in_progress": block.get("last_in_progress", False),
                    "reference": block.get("reference")}
        x_values = _table_column(block, _SERIES_X_COLUMN)
        if x_values is None:
            return None
        series = []
        unit = "count"
        x_kind = "category"
        for column in block.get("columns") or []:
            if not isinstance(column, dict):
                continue
            if column.get("key") == _SERIES_X_COLUMN:
                x_kind = "time" if column.get("type") == "time" else "category"
                continue
            unit = _unit(column.get("unit"), unit)
            series.append({"key": column.get("key"), "label": column.get("label"),
                           "values": _table_column(block, column.get("key")) or []})
        return {"x": x_values, "series": series, "unit": unit, "x_kind": x_kind}
    if kind == "funnel":
        if btype == "chart":
            series = (block.get("series") or [{}])[0]
            return {"stages": list((block.get("x") or {}).get("values") or []),
                    "values": list(series.get("values") or []), "unit": block.get("unit"),
                    "value_label": series.get("label")}
        stages, values = _table_column(block, "stage"), _table_column(block, "value")
        if stages is None or values is None:
            return None
        return {"stages": stages, "values": values, "unit": _column_unit(block, "value")}
    if kind == "kpis":
        if btype == "kpi_group":
            return {"items": list(block.get("items") or [])}
        labels, values = _table_column(block, "label"), _table_column(block, "value")
        if labels is None or values is None:
            return None
        units = _table_column(block, "unit") or []
        contexts = _table_column(block, "context") or []
        items = []
        for i, label in enumerate(labels):
            item = {"key": f"k{i + 1}", "label": label, "value": values[i],
                    "unit": _unit(units[i] if i < len(units) else None)}
            if i < len(contexts) and contexts[i]:
                item["context"] = contexts[i]
            items.append(item)
        return {"items": items}
    if kind == "heatmap":
        if btype == "heatmap":
            x, y = block.get("x") or {}, block.get("y") or {}
            return {"x": list(x.get("values") or []), "y": list(y.get("values") or []),
                    "cells": list(block.get("cells") or []), "unit": block.get("unit"),
                    "x_label": x.get("label"), "y_label": y.get("label")}
        ys, xs, values = _table_column(block, "y"), _table_column(block, "x"), _table_column(block, "value")
        if ys is None or xs is None or values is None:
            return None
        y_axis = list(dict.fromkeys(ys))
        x_axis = list(dict.fromkeys(xs))
        grid: list[list[Any]] = [[None] * len(x_axis) for _ in y_axis]
        for yv, xv, value in zip(ys, xs, values):
            grid[y_axis.index(yv)][x_axis.index(xv)] = value
        return {"x": x_axis, "y": y_axis, "cells": grid, "unit": _column_unit(block, "value")}
    if kind == "case_list":
        if btype == "case_list":
            return {"items": list(block.get("items") or [])}
        columns = {key: _table_column(block, key) for key in _CASE_COLUMNS}
        if columns["case_id"] is None:
            return None
        rows = len(columns["case_id"])
        return {"items": [
            {key: (columns[key][i] if columns[key] is not None else None) for key in _CASE_COLUMNS}
            for i in range(rows)
        ]}
    if kind == "timeline":
        if btype == "timeline":
            return {"events": list(block.get("events") or [])}
        columns = {key: _table_column(block, key) for key in _TIMELINE_COLUMNS}
        if columns["at"] is None or columns["label"] is None:
            return None
        return {"events": [
            {key: columns[key][i] for key in _TIMELINE_COLUMNS if columns[key] is not None and columns[key][i] is not None}
            for i in range(len(columns["at"]))
        ]}
    # Single-view kinds: the block body is the artifact data.
    return {k: v for k, v in block.items() if k not in _BASE_FIELDS}


def revise_view(block: dict[str, Any], view: str, *, block_id: str, title: str | None = None) -> dict[str, Any] | None:
    """``mK.bJ`` (SPEC §4.1): rebuild a STORED block of a retained earlier turn in
    another ``view`` from its ``allowed_views``, re-using only the numbers already in
    the stored block (never creating any). ``None`` when the view is not allowed or
    the stored block is a retention stub or cannot be read back."""
    if not isinstance(block, dict) or is_expired_block(block):
        return None
    allowed = [v for v in (block.get("allowed_views") or []) if isinstance(v, str)]
    current = block_view(block)
    if current and current not in allowed:
        allowed.insert(0, current)
    if view not in allowed:
        return None
    data = artifact_data_from_block(block)
    if data is None:
        return None
    from .chat_tools.base import Artifact  # lazy: the tool contract imports this module

    provenance = block.get("provenance") if block.get("provenance") in ("code", "source") else None
    if provenance is None:
        return None
    try:
        artifact = Artifact(
            id="a1", kind=block["artifact_kind"], title=str(block.get("title") or ""), data=data,
            provenance=provenance, untrusted_labels=block.get("untrusted") is True,
            total=block.get("total") if isinstance(block.get("total"), int) else None,
            # A compacted or clipped stored block stays disclosed as partial (G4).
            truncated=bool(block.get("truncated") or block.get("downsampled_for_storage")),
            as_of=block.get("as_of") or iso_now_utc(),
        )
    except ValueError:
        return None
    revised = to_blocks(artifact, MaterialiseOptions(
        block_id=block_id, view=view, title=title or block.get("title"),
        caption=block.get("caption"), from_step=block.get("from_step"),
    ))
    if not revised:
        return None
    out = revised[0]
    if block_view(out) != view:
        return None  # the projection fell back to another view: not what was asked
    # Offer only views both the stored list and the read-back data support.
    out["allowed_views"] = [v for v in out.get("allowed_views") or [] if v in allowed] or [view]
    return out


def iso_now_utc() -> str:
    """Now as an ISO-8601 UTC string inside the shared timestamp grammar."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# --- resolving a final header's block requests (SPEC §4.1) --------------------- #
@dataclass(frozen=True)
class TurnArtifact:
    """An artifact produced by THIS turn, addressable as ``ref`` (``t3.a1``)."""

    ref: str
    artifact: Any
    from_step: int | None = None


@dataclass
class MaterialisedFinal:
    """The validated blocks of a final answer and what could not be resolved."""

    blocks: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[DroppedBlock] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    expired: list[str] = field(default_factory=list)
    resolved_refs: list[str] = field(default_factory=list)


UNAVAILABLE_NOTICE_ONE = "1 requested item was not available from this turn's results."
UNAVAILABLE_NOTICE_MANY = "{n} requested items were not available from this turn's results."
# Requests the parser could not keep at all (malformed ref, unknown block type, a
# leaf past a limit): counted, never echoed (the reason codes stay in ``dropped``).
UNUSABLE_NOTICE_ONE = "1 requested item could not be shown."
UNUSABLE_NOTICE_MANY = "{n} requested items could not be shown."
EXPIRED_NOTICE = "Some earlier results have expired from saved history; ask again to refresh them."
REPORT_EMPTY_NOTICE = "The requested brief could not be built from this turn's results."


def _stored_lookup(stored: Any, ref: str) -> tuple[str, dict[str, Any] | None]:
    """``("ok"|"missing"|"expired", block)`` for an ``mK.bJ`` ref."""
    match = STORED_REF_RE.match(ref)
    if not match or not hasattr(stored, "get"):
        return "missing", None
    blocks = stored.get(f"m{match.group(1)}")
    if not isinstance(blocks, (list, tuple)):
        return "missing", None
    index = int(match.group(2)) - 1
    if index >= len(blocks) or not isinstance(blocks[index], dict):
        return "missing", None
    block = blocks[index]
    if is_expired_block(block):
        return "expired", None
    return "ok", block


def materialise_final_blocks(
    requests: Iterable[Any],
    *,
    artifacts: dict[str, TurnArtifact] | None = None,
    stored: dict[str, list[dict[str, Any]]] | None = None,
    generated_at: str | None = None,
    window_label: str | None = None,
    sources: Iterable[str] = (),
    dropped_requests: Iterable[DroppedBlock] = (),
) -> MaterialisedFinal:
    """Turn a final header's parsed requests (:func:`parse_final_block_requests`)
    into validated blocks.

    * ``tN.aK`` resolves against ``artifacts`` (this turn's) and materialises through
      :func:`to_blocks`; ``mK.bJ`` resolves against ``stored`` (``{"m3": [block, …]}``,
      positions as persisted) and allows a VIEW CHANGE only (:func:`revise_view`).
    * Model-written ``callout``/``markdown`` become ``provenance: "ai"`` blocks.
    * A ``report`` envelope's leaves are resolved the same way; an envelope with no
      resolved leaf is dropped (the caller adds one notice line).
    * Unknown or expired refs never produce numbers: they are counted and ONE quiet
      engine callout says so. ``dropped_requests`` (the parser's drops from
      :func:`parse_final_block_requests`) and the leaves an envelope could not keep
      are counted in the same callout, so nothing the model asked for vanishes
      silently; a dropped ``report`` request reads as the brief not being built.

    Block ids are assigned in order (``b1``, ``b2``, … including report leaves);
    everything passes :func:`validate_blocks` last."""
    artifacts = artifacts or {}
    stored = stored or {}
    out = MaterialisedFinal()
    counter = [0]

    def next_id() -> str:
        counter[0] += 1
        return f"b{counter[0]}"

    def duplicate(request: Any, seen: set[tuple[Any, ...]]) -> bool:
        """The same ref in the same view again (in one container) adds nothing: a
        model repeating ``t2.a1`` twelve times gets one block, not twelve."""
        if not isinstance(request, BlockRefRequest):
            return False
        key = (request.ref, request.view, request.top_n)
        if key in seen:
            return True
        seen.add(key)
        return False

    def resolve(request: Any) -> list[dict[str, Any]]:
        if isinstance(request, BlockRefRequest):
            if request.is_stored:
                status, block = _stored_lookup(stored, request.ref)
                if status == "expired":
                    out.expired.append(request.ref)
                    return []
                if block is None:
                    out.unresolved.append(request.ref)
                    return []
                block_id = next_id()
                views = [request.view] if request.view else []
                views.append(block_view(block) or "")
                for view in views:
                    revised = revise_view(block, view, block_id=block_id, title=request.title)
                    if revised is not None:
                        out.resolved_refs.append(request.ref)
                        return [revised]
                out.unresolved.append(request.ref)
                return []
            entry = artifacts.get(request.ref)
            if entry is None:
                out.unresolved.append(request.ref)
                return []
            made = to_blocks(entry.artifact, MaterialiseOptions(
                block_id=next_id(), view=request.view, title=request.title,
                top_n=request.top_n, from_step=entry.from_step,
            ))
            if not made:
                out.unresolved.append(request.ref)
            else:
                out.resolved_refs.append(request.ref)
            return made
        if isinstance(request, ModelCalloutRequest):
            block = {"type": "callout", "id": next_id(), "provenance": "ai",
                     "tone": request.tone, "text": request.text}
            if request.title:
                block["title"] = request.title
            return [block]
        if isinstance(request, ModelMarkdownRequest):
            block = {"type": "markdown", "id": next_id(), "provenance": "ai", "text": request.text}
            if request.title:
                block["title"] = request.title
            return [block]
        return []

    blocks: list[dict[str, Any]] = []
    report_failed = 0
    unusable = 0
    for drop in dropped_requests:
        if isinstance(drop, DroppedBlock) and drop.type == "report":
            report_failed += 1
        else:
            unusable += 1
    seen_top: set[tuple[Any, ...]] = set()
    for request in requests:
        if isinstance(request, ReportEnvelopeRequest):
            report_id = next_id()
            unusable += request.invalid_items
            sections = []
            seen_report: set[tuple[Any, ...]] = set()
            for s_index, section in enumerate(request.sections, start=1):
                leaves: list[dict[str, Any]] = []
                for item in section.items:
                    if not duplicate(item, seen_report):
                        leaves.extend(resolve(item))
                if leaves:
                    entry: dict[str, Any] = {"id": f"s{s_index}", "heading": section.heading, "blocks": leaves}
                    if section.summary:
                        entry["summary"] = section.summary
                    sections.append(entry)
            if not any(s["blocks"] for s in sections):
                out.unresolved.append("report")
                continue
            scope: dict[str, Any] = {
                "generated_at": generated_at or iso_now_utc(),
                "sources": [s for s in sources if isinstance(s, str) and s.strip()][:MAX_SOURCES],
            }
            if window_label:
                scope["window_label"] = window_label
            report: dict[str, Any] = {
                "type": "report", "id": report_id, "provenance": "ai", "title": request.title,
                "template": request.template, "scope": scope, "sections": sections,
            }
            if request.subtitle:
                report["subtitle"] = request.subtitle
            blocks.append(report)
        elif not duplicate(request, seen_top):
            blocks.extend(resolve(request))
    notes: list[str] = []
    missing = sum(1 for ref in out.unresolved if ref != "report")
    report_failed += len(out.unresolved) - missing
    if missing:
        notes.append(UNAVAILABLE_NOTICE_ONE if missing == 1 else UNAVAILABLE_NOTICE_MANY.format(n=missing))
    if unusable:
        notes.append(UNUSABLE_NOTICE_ONE if unusable == 1 else UNUSABLE_NOTICE_MANY.format(n=unusable))
    if report_failed:
        notes.append(REPORT_EMPTY_NOTICE)
    if out.expired:
        notes.append(EXPIRED_NOTICE)
    validated, dropped = validate_blocks(blocks)
    if notes:
        # The notice is engine text (``code``); it is appended after validation so a
        # full answer cannot crowd it out silently: it replaces nothing and is simply
        # skipped when the message is already at the block limit.
        notice = {"type": "callout", "id": next_id(), "provenance": "code", "tone": "info",
                  "text": " ".join(notes)}
        more, more_dropped = validate_blocks([*validated, notice])
        validated, dropped = more, dropped + more_dropped
    out.blocks = validated
    out.dropped = dropped
    return out


def iter_leaf_blocks(blocks: Iterable[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    """Every renderable block, descending into report sections (exports, digests)."""
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "report":
            for section in block.get("sections") or []:
                for leaf in (section or {}).get("blocks") or []:
                    if isinstance(leaf, dict):
                        yield leaf
        else:
            yield block
