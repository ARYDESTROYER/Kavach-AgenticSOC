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
  model-written ``callout``/``markdown``, the ``report`` envelope) and the
  materialisation signature :func:`to_blocks`, which the engine package implements.

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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Any, Iterable, Literal, Union, get_args

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    TypeAdapter,
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
DOC_REF_PATTERN = r"^/docs/\d+\.\d+/[a-z0-9/_-]+/?(#[a-z0-9_-]+)?$"   # amendment 5
TECHNIQUE_PATTERN = r"^T\d{4}(\.\d{3})?$"
SECTION_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"
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
class NavRefOpts(_Strict):
    """The validated ``NavOpts`` subset a block may carry (BLOCKS.md InternalRef)."""

    caseId: str | None = Field(default=None, pattern=CASE_ID_PATTERN)
    severity: SeverityKey | None = None
    status: NavStatus | None = None
    window: int | None = Field(default=None, ge=1, le=720)
    tab: str | None = Field(default=None, pattern=ROUTE_TOKEN_PATTERN)
    section: str | None = Field(default=None, pattern=ROUTE_TOKEN_PATTERN)
    anchor: str | None = Field(default=None, pattern=ROUTE_TOKEN_PATTERN)


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

_NAV_OPT_KEYS = ("caseId", "severity", "status", "window", "tab", "section", "anchor")


def clean_nav_opts(raw: Any) -> dict[str, str | int]:
    """Keep only the valid ``NavOpts`` entries of ``raw`` (unknown keys and invalid
    values are DROPPED one by one). Shared with ``models.ConsoleLink.opts``."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str | int] = {}
    for key in _NAV_OPT_KEYS:
        if key not in raw:
            continue
        try:
            parsed = NavRefOpts.model_validate({key: raw[key]})
        except Exception:  # noqa: BLE001
            continue
        value = getattr(parsed, key)
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

    @model_validator(mode="before")
    @classmethod
    def _base_repair(cls, data: Any) -> Any:
        """Fail-safe provenance (G5: a missing/unknown value is ``ai``) and lenient
        ``artifact_kind``/``allowed_views`` (unknown entries dropped)."""
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out["provenance"] = _enum_or(out.get("provenance"), PROVENANCES, "ai")
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
])


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
    dump a block through here, never with a bare ``exclude_none`` dump."""
    return _prune(block.model_dump(mode="json", exclude_none=True))


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


def _leaf_request(value: Any) -> Any:
    if isinstance(value, (BlockRefRequest, ModelCalloutRequest, ModelMarkdownRequest)):
        return value
    if isinstance(value, dict) and "ref" in value:
        return BlockRefRequest.model_validate(value)
    if isinstance(value, dict) and value.get("type") == "callout":
        return ModelCalloutRequest.model_validate(value)
    if isinstance(value, dict) and value.get("type") == "markdown":
        return ModelMarkdownRequest.model_validate(value)
    raise ValueError("a report leaf is a ref, a callout or markdown")


LeafRequest = Annotated[
    Union[BlockRefRequest, ModelCalloutRequest, ModelMarkdownRequest],
    BeforeValidator(_leaf_request),
]
_LEAF_REQUEST = TypeAdapter(LeafRequest)


class ReportSectionRequest(_Strict):
    heading: Title
    items: list[LeafRequest] = Field(default_factory=list, max_length=MAX_REPORT_LEAVES)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["items"], _ = _filter_valid(_LEAF_REQUEST, data.get("items"), MAX_REPORT_LEAVES)
        return data


class ReportEnvelopeRequest(_Strict):
    """The model-written ``report`` envelope; leaves only (no nested report)."""

    type: Literal["report"]
    title: Title
    template: ReportTemplate = "custom"
    sections: list[ReportSectionRequest] = Field(min_length=1, max_length=MAX_REPORT_SECTIONS)

    @model_validator(mode="before")
    @classmethod
    def _repair(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            data["template"] = _enum_or(data.get("template"), REPORT_TEMPLATES, "custom")
            sections, _ = _clip(data.get("sections"), MAX_REPORT_SECTIONS)
            data["sections"] = sections
        return data

    @model_validator(mode="after")
    def _leaf_budget(self) -> "ReportEnvelopeRequest":
        if sum(len(s.items) for s in self.sections) > MAX_REPORT_LEAVES:
            raise ValueError("a report holds at most 40 leaves")
        return self


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
    for index, item in enumerate(raw, start=1):
        if len(out) >= MAX_BLOCKS_PER_MESSAGE:
            dropped.append(DroppedBlock(str(index), _type_of(item), "block_limit"))
            continue
        try:
            out.append(_FINAL_REQUEST.validate_python(item))
        except Exception as exc:  # noqa: BLE001
            dropped.append(DroppedBlock(str(index), _type_of(item), _reason(exc)))
    return out, dropped


# --------------------------------------------------------------------------- #
# Materialisation (SPEC §7.3). Implemented by the engine package (WP-F); the
# signature is fixed here so tools, engine and tests agree on it.
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


def to_blocks(artifact: "Artifact", options: MaterialiseOptions) -> list[dict[str, Any]]:
    """Materialise ``artifact`` into validated block dicts (usually one) in the
    requested view. Deterministic; never invents numbers; numbers come only from
    ``artifact.data`` and carry ``artifact.provenance``. Implemented by WP-F."""
    raise NotImplementedError("answer-block materialisation is implemented by the chat engine package")


def revise_view(block: dict[str, Any], view: str, *, block_id: str, title: str | None = None) -> dict[str, Any] | None:
    """``mK.bJ`` (SPEC §4.1): rebuild a STORED block of a retained earlier turn in
    another ``view`` from its ``allowed_views``, re-using only the numbers already in
    the stored block (never creating any). ``None`` when the view is not allowed or
    the stored block is a retention stub. Implemented by WP-F."""
    raise NotImplementedError("stored-block view changes are implemented by the chat engine package")


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
