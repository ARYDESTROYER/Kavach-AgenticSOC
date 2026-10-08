"""Shared plumbing for the chat data tools (chat revamp SPEC §5.2, §5.3, §3.1).

Everything here is deterministic and side-effect free:

* :class:`ToolCall` / :func:`current_call` — the per-call identity the engine hands
  the toolbox (turn id, run-log step, tool-call ordinal and the turn's
  :class:`~app.agents.chat_tools.taint.TaintLedger`). The toolbox sets it in a
  ``ContextVar`` around ``tool.run`` so a tool reads it without widening the fixed
  ``run(ctx, **inp)`` signature, and parallel calls in one ``tools`` batch (each its
  own asyncio task) can never see each other's identity.
* :class:`ToolInput` + :func:`parse_input` — every tool validates the model's input
  with a Pydantic model. Unknown keys are ignored; an invalid value becomes an
  ENGINE-template error naming only our own field names (never the model's text).
* :func:`resolve_window` — the §3.1 time precedence (the model's window, then the
  request chip, then the default) with the §4.8.4 rule that nothing a tool is asked
  for may widen the window the request selected.
* Formatting helpers for summaries (engine templates + numbers + enums only) and the
  whitelisted case projection every case tool shares.
* :func:`logs_console_view` — the EXACT "Open in Logs" view of a log tool call (the
  same free text, window and source), or ``None`` when the Logs page cannot express
  the filter the tool ran with (it never approximates one).
* Two text helpers with different jobs: :func:`text` / :func:`opt_text` bound an
  OBSERVATION leaf but KEEP invisible characters (SPEC §7.6: ``fence_block`` renders
  them as visible ``\\uXXXX`` escapes, so ``admin`` + ZWSP never reaches a model as
  ``admin``), and :func:`visible_text` writes them as visible escape text for an
  evidence label a person reads. Artifact text is display-sanitised by the blocks
  layer when it is materialised.
"""

from __future__ import annotations

import math
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Iterator, Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from ...constants import INVISIBLE_TEXT_CLASS
from ...models import resolve_time_expr
from ..blocks import ELLIPSIS, NAV_ID_PATTERN, NAV_TIME_PATTERN, display_text, is_safe_log_query
from .base import ChatToolContext, ToolOutcome

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .taint import TaintLedger

# --------------------------------------------------------------------------- #
# Per-call identity (set by the toolbox around ``tool.run``).
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ToolCall:
    """Who is calling, for audit correlation and the taint rules.

    ``turn_id`` and ``step`` (the run-log ``ChatStep.index``) prefix every audit
    row's ``result_summary`` as ``turn=<id> step=<n>`` (§5.2); ``ordinal`` is the
    turn-global tool-call number N of ``tN`` refs; ``taint`` is the turn's ledger of
    user-authored text and code-provenance evidence (§4.8.3)."""

    turn_id: str = ""
    step: int | None = None
    ordinal: int | None = None
    taint: "TaintLedger | None" = None


_CURRENT_CALL: ContextVar[ToolCall | None] = ContextVar("chat_tool_call", default=None)


def current_call() -> ToolCall | None:
    """The :class:`ToolCall` of the running tool, or ``None`` outside the toolbox."""
    return _CURRENT_CALL.get()


@contextmanager
def call_scope(call: ToolCall | None) -> Iterator[None]:
    """Bind ``call`` for the duration of the block (tests use it directly)."""
    token = _CURRENT_CALL.set(call)
    try:
        yield
    finally:
        _CURRENT_CALL.reset(token)


def call_ordinal(ctx: Any = None) -> int | None:
    """The turn-global ordinal N of the running call: the toolbox binding, else an
    ``ordinal`` attribute on a per-call context an engine passed to ``run``."""
    call = current_call()
    ordinal = call.ordinal if call is not None else getattr(ctx, "ordinal", None)
    return ordinal if isinstance(ordinal, int) and not isinstance(ordinal, bool) and 1 <= ordinal <= 99 else None


# At most this many citations per call, so ``citation_id`` stays inside the
# ``^[A-Z][0-9]{1,3}$`` citation id pattern for every ordinal of a turn.
MAX_CITATIONS_PER_CALL = 9


def citation_id(prefix: str, index: int, ctx: Any = None) -> str:
    """A citation id unique within the TURN: ``K31`` is the first knowledge result of
    tool call t3 (``<prefix><ordinal><index>``, index 1..9), so two calls in one turn
    can never both mint ``K1`` and shadow each other. Without an ordinal (a direct
    call outside the loop) it is ``<prefix><index>``. The observation shows the same
    id, so the model cites exactly what the server can resolve."""
    ordinal = call_ordinal(ctx)
    index = max(1, min(int(index), MAX_CITATIONS_PER_CALL))
    return f"{prefix}{ordinal}{index}" if ordinal is not None else f"{prefix}{index}"


# --------------------------------------------------------------------------- #
# Input validation.
# --------------------------------------------------------------------------- #


class ToolInput(BaseModel):
    """Base for tool input models: unknown keys are ignored (a model that adds a
    harmless extra key still gets its lookup) and strings are stripped."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


def parse_input(model: type[ToolInput], inp: Any) -> tuple[Any, ToolOutcome | None]:
    """Validate ``inp`` with ``model``. Returns ``(parsed, None)`` or
    ``(None, failure)`` whose error names only fields of ``model`` (engine text)."""
    if inp is None:
        inp = {}
    if not isinstance(inp, dict):
        return None, ToolOutcome.failure("Invalid input: expected an object of named arguments")
    try:
        return model.model_validate(inp), None
    except ValidationError as exc:
        names: list[str] = []
        for err in exc.errors():
            loc = err.get("loc") or ()
            head = loc[0] if loc else None
            if isinstance(head, str) and head in model.model_fields and head not in names:
                names.append(head)
        detail = ", ".join(names) if names else "arguments"
        return None, ToolOutcome.failure(f"Invalid input: check {detail}")


def none_if_blank(value: Any) -> Any:
    """``""`` → ``None`` (the model often sends empty strings for unset filters)."""
    if isinstance(value, str) and not value.strip():
        return None
    return value


# --------------------------------------------------------------------------- #
# §3.1 time window.
# --------------------------------------------------------------------------- #
_RELATIVE_RE = re.compile(r"^now-(\d{1,5})([mhdw])$")
MAX_WINDOW_DAYS = 90
# The longest whole-hour span a ``window_hours`` engine function is asked for.
MAX_WINDOW_HOURS = 720


@dataclass(frozen=True)
class Window:
    """An effective time window: the expressions passed to a connector, the
    resolved instants, the whole-hour span (``hours``, clamped 1..720) for tools
    that take ``window_hours``, a caption ``label`` and whether the request's own
    range narrowed what was asked (``clamped``).

    ``hours`` is a CEILING of the span capped at 720 (30 days) while a window may
    span 90 days, so a tool that counts back ``hours`` from an instant must check
    :attr:`hours_capped` (and :attr:`trailing`) before it reuses ``label``; see
    ``metrics.metric_window``."""

    time_from: str
    time_to: str
    start: datetime
    end: datetime
    hours: int
    label: str
    source: Literal["tool", "request", "default"]
    clamped: bool = False

    def iso_from(self) -> str:
        return self.start.isoformat()

    def iso_to(self) -> str:
        return self.end.isoformat()

    @property
    def span_hours(self) -> float:
        return (self.end - self.start).total_seconds() / 3600

    @property
    def hours_capped(self) -> bool:
        """True when the span is longer than :data:`MAX_WINDOW_HOURS`, so ``hours``
        covers only the newest part of it."""
        return self.span_hours > MAX_WINDOW_HOURS + 1e-9

    @property
    def trailing(self) -> bool:
        """True when the window ends at the present (``to`` is ``now``)."""
        return self.time_to.strip().lower() == "now"


def window_label(time_from: str, time_to: str, start: datetime, end: datetime) -> str:
    """``last 24h`` for a trailing relative window, else a UTC minute range."""
    if time_to.strip().lower() == "now":
        match = _RELATIVE_RE.match(time_from.strip().lower())
        if match:
            return f"last {int(match.group(1))}{match.group(2)}"
    return f"{start.strftime('%Y-%m-%d %H:%M')} → {end.strftime('%Y-%m-%d %H:%M')} UTC"


def _hours(start: datetime, end: datetime, *, lo: int = 1, hi: int = MAX_WINDOW_HOURS) -> int:
    span = (end - start).total_seconds() / 3600
    return min(max(math.ceil(span), lo), hi)


def resolve_window(
    ctx: ChatToolContext,
    *,
    time_from: str | None = None,
    time_to: str | None = None,
    window_hours: int | None = None,
    default_hours: int = 24,
    now: datetime | None = None,
) -> Window | str:
    """The effective window for one call, or an engine-template error string.

    Precedence (SPEC §3.1): a window in the tool input (``time_from``/``time_to``
    or ``window_hours``, which the model sets from the user's own words) → the
    request's ``time_range`` chip (``ctx.time_range``) → ``default_hours``.
    §4.8.4: when the request selected a range, a tool window is CLAMPED into it —
    nothing a model reads in a tool result can widen what the user selected —
    and ``clamped`` says so. A window is at most 90 days (the start moves)."""
    ref = now or datetime.now(timezone.utc)
    chip = ctx.time_range
    from_expr = none_if_blank(time_from)
    to_expr = none_if_blank(time_to)
    source: Literal["tool", "request", "default"]
    if from_expr is not None or to_expr is not None:
        from_expr = str(from_expr or f"now-{default_hours}h").strip()
        to_expr = str(to_expr or "now").strip()
        start = resolve_time_expr(from_expr.lower() if from_expr.lower().startswith("now") else from_expr, ref)
        end = resolve_time_expr(to_expr.lower() if to_expr.lower().startswith("now") else to_expr, ref)
        if start is None or end is None:
            return "Invalid time window: use now, now-<n>[m|h|d|w] or an ISO-8601 timestamp"
        if start >= end:
            return "Invalid time window: the start must be before the end"
        if from_expr.lower().startswith("now"):
            from_expr = from_expr.lower()
        if to_expr.lower().startswith("now"):
            to_expr = to_expr.lower()
        source = "tool"
    elif window_hours is not None:
        hours = max(1, int(window_hours))
        from_expr, to_expr = f"now-{hours}h", "now"
        start, end = ref - timedelta(hours=hours), ref
        source = "tool"
    elif chip is not None:
        start, end = chip.resolve(ref)
        from_expr, to_expr = chip.from_, chip.to
        source = "request"
    else:
        from_expr, to_expr = f"now-{default_hours}h", "now"
        start, end = ref - timedelta(hours=default_hours), ref
        source = "default"

    clamped = False
    if source == "tool" and chip is not None:
        chip_start, chip_end = chip.resolve(ref)
        if start < chip_start:
            start, from_expr, clamped = chip_start, chip.from_, True
        if end > chip_end:
            end, to_expr, clamped = chip_end, chip.to, True
        if start >= end:
            start, end = chip_start, chip_end
            from_expr, to_expr, clamped = chip.from_, chip.to, True
    if end - start > timedelta(days=MAX_WINDOW_DAYS):
        start = end - timedelta(days=MAX_WINDOW_DAYS)
        from_expr, clamped = start.isoformat(), True
    return Window(
        time_from=from_expr, time_to=to_expr, start=start, end=end,
        hours=_hours(start, end), label=window_label(from_expr, to_expr, start, end),
        source=source, clamped=clamped,
    )


# --------------------------------------------------------------------------- #
# "Open in Logs" (SPEC §10.3, §10.7): the exact console view of a log tool call.
# --------------------------------------------------------------------------- #
_NAV_ID_RE = re.compile(NAV_ID_PATTERN)
_NAV_TIME_RE = re.compile(NAV_TIME_PATTERN)
# Filters the Logs page has no field for: a call that used any of them gets "Copy
# query" only, never a Logs view that would silently show a WIDER result.
LOGS_UNEXPRESSIBLE_FILTERS: tuple[str, ...] = ("ip", "user", "host", "rule", "severity_gte", "ids")


def _to_millis(moment: datetime, *, round_up: bool) -> datetime:
    """``moment`` in UTC at millisecond precision (the browser's Date precision),
    the sub-millisecond rest rounded INTO the window (a start up, an end down)."""
    moment = moment.astimezone(timezone.utc)
    rest = moment.microsecond % 1000
    if rest:
        moment += timedelta(microseconds=(1000 - rest) if round_up else -rest)
    return moment


def nav_instant(moment: datetime, *, round_up: bool) -> str:
    """``moment`` as a router-grammar UTC instant (``2026-10-08T12:00:00.250Z``;
    whole seconds drop the fraction). Rounded INTO the window (:func:`_to_millis`),
    so a link is never wider than the window it names and a 90-day span never grows
    past the Logs page's 90-day bound."""
    moment = _to_millis(moment, round_up=round_up)
    millis = moment.microsecond // 1000
    return moment.strftime("%Y-%m-%dT%H:%M:%S") + (f".{millis:03d}" if millis else "") + "Z"


def _searched_every_source(observation: dict[str, Any]) -> bool | None:
    """Whether the call's sources all applied its query (``True``), at least one
    did not (``False``), or the observation lists none (``None``: one connector).

    A push source's live-tail ring (mode ``buffer``) IGNORES query, from and to:
    the log tools filter its rows themselves, but ``GET /api/logs`` returns the
    whole ring, so the Logs view of such a call would be WIDER than its block.
    Positive evidence only: a listed source whose mode is not ``search`` (missing,
    unknown) counts as not searched."""
    sources = observation.get("sources")
    if sources is None:
        return None
    if not isinstance(sources, list) or not sources:
        return False
    return all(isinstance(s, dict) and s.get("mode") == "search" for s in sources)


def logs_console_view(
    ctx: ChatToolContext, args: Any, observation: Any = None, *, now: datetime | None = None,
) -> dict[str, Any] | None:
    """``{"page": "logs", "opts": {logQuery?, from, to, sourceId?}}`` for a log tool
    call whose filter the Logs page can express EXACTLY, else ``None``.

    The Logs page (``GET /api/logs``) filters by free text (``contains``), a time
    window and one optional source, so the view is exact only when:

    * the call used no other filter (:data:`LOGS_UNEXPRESSIBLE_FILTERS`);
    * its free text is router-safe (single line, no control/format characters) and
      has no edge whitespace (the Logs page trims what it sends);
    * every source it read APPLIED that filter: the call's ``observation`` must say
      what ran — one connector search (``observation["source"]``) or a fan-out
      (``observation["sources"]``) whose every entry is mode ``search``. A live-tail
      ring (mode ``buffer``) anywhere in the call means no view (the Logs page
      would show the whole, unfiltered ring);
    * the source is NAMED (the request's selected source, else the call's
      ``source_id``), or the call fanned out over every browse-capable source
      (what the Logs page reads without a source). A call that read the one
      implicit primary source gets no view: its id is not known here, and guessing
      would be fabricating a filter.

    The window is the one the tool resolved (:func:`resolve_window`: the same
    precedence, request clamp and 90-day cap) written as ABSOLUTE UTC instants
    (:func:`nav_instant`), so a stored answer reopened next week still opens the
    window its data came from rather than a relative ``now-24h`` re-evaluated
    then. ``now`` is the instant the call started (``ChatToolbox.execute`` passes
    it); a relative bound the connector evaluated on its own clock differs from it
    only by the call's latency.

    ``args`` is the tool's parsed input (read with ``getattr``; this module cannot
    import the log tools). Pure apart from reading the clock when ``now`` is None."""
    if any(getattr(args, key, None) not in (None, [], ()) for key in LOGS_UNEXPRESSIBLE_FILTERS):
        return None
    if not isinstance(observation, dict):
        return None  # nothing says what ran, so nothing says the view is exact
    searched = _searched_every_source(observation)
    if searched is False:
        return None
    window = resolve_window(
        ctx, time_from=getattr(args, "time_from", None), time_to=getattr(args, "time_to", None), now=now,
    )
    if isinstance(window, str):
        return None
    if _to_millis(window.start, round_up=True) >= _to_millis(window.end, round_up=False):
        return None  # a sub-millisecond window has no millisecond link
    start, end = nav_instant(window.start, round_up=True), nav_instant(window.end, round_up=False)
    if not (_NAV_TIME_RE.fullmatch(start) and _NAV_TIME_RE.fullmatch(end)):
        return None
    opts: dict[str, Any] = {}
    contains = getattr(args, "contains", None)
    if contains is not None:
        if not isinstance(contains, str) or contains != contains.strip() or not is_safe_log_query(contains):
            return None
        opts["logQuery"] = contains
    opts["from"], opts["to"] = start, end
    source = getattr(ctx, "source_id", None) or getattr(args, "source_id", None)
    if source:
        if not isinstance(source, str) or not _NAV_ID_RE.fullmatch(source):
            return None
        if searched is None and not isinstance(observation.get("source"), str):
            return None  # neither one connector search nor a listed fan-out ran
        opts["sourceId"] = source
    elif searched is None:
        return None  # the implicit primary source: its id is not known here
    return {"page": "logs", "opts": opts}


# --------------------------------------------------------------------------- #
# Formatting (engine templates only).
# --------------------------------------------------------------------------- #


def fmt_int(value: Any) -> str:
    """``1,284``; ``—`` for a missing value."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "—"
    return f"{int(value):,}"


def fmt_pct(value: Any, *, ratio: bool = False, digits: int = 1) -> str:
    """A percentage string from a 0..100 value (or a 0..1 ``ratio``)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return "—"
    return f"{(value * 100 if ratio else value):.{digits}f}%"


def finite(value: Any) -> float | None:
    """A finite float, else ``None`` (the em-dash ``"—"`` of a metric is ``None``)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def ratio_to_pct(value: Any, digits: int = 1) -> float | None:
    """A 0..1 ratio as a 0..100 percent value (``None`` when not measured)."""
    number = finite(value)
    return None if number is None else round(number * 100, digits)


_INVISIBLE_RE = re.compile(f"[{INVISIBLE_TEXT_CLASS}]")
_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")
_PROMPT_LINE_BREAKS_RE = re.compile(r"[\t\r\n]+")


def _escape(match: "re.Match[str]") -> str:
    return f"\\u{ord(match.group()):04x}"


def _scalar(value: Any) -> str | None:
    """A string for a string, a JavaScript-style number or a boolean; else ``None``
    (never ``str(dict)``), exactly the inputs ``display_text`` accepts."""
    if isinstance(value, str):
        return value
    if isinstance(value, (bool, int, float)):
        return display_text(value, 0) or None
    return None


def _bound(value: str, limit: int) -> str:
    if limit > 0 and len(value) > limit:
        return value[: max(0, limit - 1)].rstrip() + ELLIPSIS
    return value


def text(value: Any, limit: int = 200) -> str:
    """Single-line, bounded text for an OBSERVATION leaf (prompt-bound).

    Unlike ``display_text`` it KEEPS invisible characters (zero-width, bidi, tag and
    C0/C1 characters): the engine fences every observation with ``fence_block``,
    whose ``ensure_ascii`` serialisation writes them as visible ``\\uXXXX`` escapes,
    so lookalike evidence stays visible to the model ("admin" + ZWSP is not
    "admin", SPEC §7.6) and two such values are never merged. Line breaks fold to a
    space and the length is bounded so a hostile value cannot bloat or reshape the
    payload; a lone surrogate half (reachable only through a JSON escape, and not
    encodable) is written as escape text."""
    raw = _scalar(value)
    if raw is None:
        return ""
    raw = _LONE_SURROGATE_RE.sub(_escape, raw)
    return _bound(_PROMPT_LINE_BREAKS_RE.sub(" ", raw).strip(), limit)


def opt_text(value: Any, limit: int = 200) -> str | None:
    """:func:`text`, or ``None`` for a missing/blank value."""
    out = text(value, limit) if value not in (None, "") else ""
    return out or None


def visible_text(value: Any, limit: int = 200) -> str:
    """Bounded text with every invisible character written as visible ``\\uXXXX``
    escape text, for an EVIDENCE label a person reads (a top-values bar, an event
    cell). ``display_text`` deletes invisible characters, which would show
    ``admin`` and ``admin`` + ZWSP as two identical labels with different counts;
    escaped, the lookalike is visible on screen as it is to the model."""
    raw = _scalar(value)
    if raw is None:
        return ""
    raw = _INVISIBLE_RE.sub(_escape, _LONE_SURROGATE_RE.sub(_escape, raw))
    return _bound(_PROMPT_LINE_BREAKS_RE.sub(" ", raw).strip(), limit)


def iso_or_none(value: Any) -> str | None:
    """An ISO-8601 string for datetimes/strings, else ``None``."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str) and value.strip():
        return value.strip()[:40]
    return None


def millis_to_iso(millis: Any) -> str | None:
    number = finite(millis)
    if number is None or number <= 0:
        return None
    return datetime.fromtimestamp(number / 1000, tz=timezone.utc).isoformat()


def enum_value(value: Any) -> str | None:
    """``Enum.value`` or the plain string, else ``None``."""
    raw = getattr(value, "value", value)
    return str(raw) if isinstance(raw, str) and raw else None


# --------------------------------------------------------------------------- #
# The shared whitelisted case projection.
# --------------------------------------------------------------------------- #
_VERDICT_SEMANTIC = {
    "TRUE_POSITIVE": "true_positive",
    "FALSE_POSITIVE": "false_positive",
    "NEEDS_HUMAN": "needs_human",
}
_SEVERITIES = ("critical", "high", "medium", "low", "info")


def case_severity(case: Any, prefs: Any) -> str | None:
    """The advisory severity band (``engine.priority.band_of_case``), fail-soft."""
    try:
        from ...engine.priority import band_of_case

        band = band_of_case(case, prefs)
    except Exception:  # noqa: BLE001 — presentation only
        band = getattr(case, "severity_band", None)
    return band if band in _SEVERITIES else None


def case_priority(case: Any, prefs: Any) -> str | None:
    level = getattr(case, "priority_level", None)
    if level:
        return str(level)
    try:
        from ...engine.priority import advisory_bands

        level = advisory_bands(case, prefs).get("priority_level")
    except Exception:  # noqa: BLE001 — presentation only
        level = None
    return str(level) if level else None


def case_entity(case: Any) -> str | None:
    entity = getattr(case, "entity", None)
    if entity is None:
        return None
    kind = enum_value(getattr(entity, "type", None)) or "entity"
    return text(f"{kind}:{getattr(entity, 'value', '')}", 300)


def case_row(case: Any, prefs: Any) -> dict[str, Any]:
    """The ONE whitelisted case projection a model may see (§5.2): identity,
    lifecycle, verdict, risk and a few bounded descriptive strings. Never
    ``member_event_ids``, ``history``, ``verdict_history``, ``evidence`` bodies,
    comments or notification records. The strings are log/LLM-derived and reach a
    model only inside the engine's fence."""
    return {
        "case_id": text(getattr(case, "case_id", ""), 128),
        "case_number": opt_text(getattr(case, "case_number", ""), 64),
        "title": text(getattr(case, "title", "") or getattr(case, "case_id", ""), 160),
        "status": enum_value(getattr(case, "status", None)),
        "verdict": enum_value(getattr(case, "verdict", None)),
        "confidence": finite(getattr(case, "confidence", None)),
        "risk_score": finite(getattr(case, "risk_score", None)),
        "severity": case_severity(case, prefs),
        "priority": case_priority(case, prefs),
        "entity": case_entity(case),
        "rules": [text(r, 120) for r in list(getattr(case, "rule_ids", []) or [])[:3]],
        "source": opt_text(getattr(case, "source_name", None) or getattr(case, "source_id", None), 120),
        "created_at": iso_or_none(getattr(case, "created_at", None)),
        "assignee": opt_text(getattr(case, "assignee", ""), 120),
        "decision_by": enum_value(getattr(case, "decision_by", None)),
    }


def case_list_item(case: Any, prefs: Any) -> dict[str, Any]:
    """A ``case_list`` artifact item (BLOCKS.md §5.3)."""
    return {
        "case_id": str(getattr(case, "case_id", "")),
        "title": display_text(getattr(case, "title", "") or getattr(case, "case_id", ""), 120),
        "severity": case_severity(case, prefs),
        "verdict": _VERDICT_SEMANTIC.get(enum_value(getattr(case, "verdict", None)) or ""),
        "status": enum_value(getattr(case, "status", None)),
        "risk": finite(getattr(case, "risk_score", None)),
        "created_at": iso_or_none(getattr(case, "created_at", None)),
    }


def verdict_semantic(value: Any) -> str | None:
    return _VERDICT_SEMANTIC.get(enum_value(value) or "")


def kpi(
    key: str,
    label: str,
    value: Any,
    unit: str = "count",
    *,
    context: str | None = None,
    bound: bool = False,
    display: str | None = None,
    semantic: str | None = None,
    delta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One ``kpis`` artifact item (blocks ``KpiItem`` field names). ``value: None``
    means not measured (G3); ``bound`` renders "≥" for a lower bound (G4)."""
    item: dict[str, Any] = {"key": key, "label": label, "value": finite(value), "unit": unit}
    if context:
        item["context"] = display_text(context, 60)
    if bound:
        item["bound"] = "lower"
    if display:
        item["display"] = display
    if semantic:
        item["semantic"] = semantic
    if delta:
        item["delta"] = delta
    return item


def categories(
    pairs: list[tuple[Any, Any]], *, unit: str = "count", dimension: str | None = None,
    other: Any = None,
) -> dict[str, Any]:
    """A ``categories`` artifact payload, sorted by value desc then label (stable
    colours, SPEC §7.3). ``None`` values sort last."""
    rows = [(display_text(label, 200) or "—", finite(value)) for label, value in pairs]
    rows.sort(key=lambda r: (r[1] is None, -(r[1] or 0), r[0]))
    data: dict[str, Any] = {
        "labels": [r[0] for r in rows], "values": [r[1] for r in rows], "unit": unit,
    }
    if dimension:
        data["dimension"] = dimension
    if other is not None and finite(other):
        data["other"] = finite(other)
    return data


def column(
    key: str, label: str, type_: str = "text", *, unit: str | None = None,
    untrusted: bool = False, align: str | None = None,
) -> dict[str, Any]:
    col: dict[str, Any] = {"key": key, "label": label, "type": type_}
    if unit:
        col["unit"] = unit
    if untrusted:
        col["untrusted"] = True
    if align:
        col["align"] = align
    return col


__all__ = [
    "MAX_CITATIONS_PER_CALL",
    "MAX_WINDOW_DAYS",
    "MAX_WINDOW_HOURS",
    "ToolCall",
    "ToolInput",
    "Window",
    "call_scope",
    "case_entity",
    "case_list_item",
    "case_priority",
    "call_ordinal",
    "case_row",
    "case_severity",
    "citation_id",
    "categories",
    "column",
    "current_call",
    "enum_value",
    "finite",
    "fmt_int",
    "fmt_pct",
    "iso_or_none",
    "kpi",
    "millis_to_iso",
    "none_if_blank",
    "opt_text",
    "parse_input",
    "ratio_to_pct",
    "resolve_window",
    "text",
    "verdict_semantic",
    "visible_text",
    "window_label",
]
