"""Shared plumbing for the chat data tools (chat revamp SPEC §5.2, §5.3, §3.1).

Everything here is deterministic and side-effect free:

* :class:`ToolCall` / :func:`current_call` — the per-call identity the engine hands
  the toolbox (turn id, run-log step, tool-call ordinal and the turn's
  :class:`~app.agents.chat_tools.taint.TaintLedger`). The toolbox sets it in a
  ``ContextVar`` around ``tool.run`` so a tool reads it without widening the fixed
  ``run(ctx, **inp)`` signature, and parallel calls in one ``tools`` batch (each its
  own asyncio task) can never see each other's identity.
* :class:`ToolInput` + :func:`parse_input` — every tool validates the model's input
  with a Pydantic model. An unknown key is refused visibly (naming the accepted
  inputs), never silently dropped; an invalid value becomes an
  ENGINE-template error naming only our own field names (never the model's text).
* :func:`resolve_window` — the §3.1 time precedence (the model's window, then the
  request chip, then the default) with the §4.8.4 rule that nothing a tool is asked
  for may widen the window the request selected.
* Formatting helpers for summaries (engine templates + numbers + enums only) and the
  whitelisted case projection every case tool shares.
* :func:`logs_console_view` — the EXACT "Open in Logs" view of a log tool call (the
  same free text and source, and the window as absolute instants), or ``None`` when
  the Logs page cannot express the filter the tool ran with or a source it read (a
  live-tail ring) would ignore it (it never approximates one).
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
from decimal import ROUND_HALF_UP, Decimal
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace
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
    """Base for tool input models. Strings are stripped. Round 12 (SPEC, routing
    fix 4): an input name the lookup does not have is REFUSED with a message naming
    the accepted inputs (never silently dropped, so the model never believes a
    grouping or a filter ran when it did not); the model retries with a valid name."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# An input NAME a model chose is echoed (inside the fenced error only) when it looks
# like an identifier; anything else is counted, never echoed.
_INPUT_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,39}$")
_MAX_NAMED_UNKNOWN = 5


def accepted_inputs(model: type[BaseModel]) -> list[str]:
    """The input names ``model`` reads, in declaration order."""
    return list(model.model_fields)


def unknown_input_failure(model: type[BaseModel] | None, unknown: list[Any]) -> ToolOutcome:
    """The refusal for input names the lookup does not have. The TRUSTED summary
    names only our own inputs; the model's names appear in the fenced error (bounded,
    identifier-shaped ones only)."""
    accepted = ", ".join(accepted_inputs(model)) if model is not None else ""
    tail = f" Accepted inputs: {accepted}." if accepted else ""
    named = [k for k in unknown if isinstance(k, str) and _INPUT_NAME_RE.match(k)][:_MAX_NAMED_UNKNOWN]
    if named:
        verb = "is not an input" if len(named) == 1 else "are not inputs"
        error = f"Invalid input: {', '.join(named)} {verb} of this lookup.{tail}"
    else:
        error = f"Invalid input: unknown input names.{tail}"
    return ToolOutcome.failure(error, summary=f"Invalid input: unknown input names.{tail}")


def _constraint_hint(err: dict[str, Any]) -> str | None:
    """What a field accepts, from the SCHEMA side of a validation error only (its
    literal values or numeric bounds); the rejected value is never echoed."""
    kind = str(err.get("type") or "")
    ctx = err.get("ctx") if isinstance(err.get("ctx"), dict) else {}
    if kind == "literal_error" and isinstance(ctx.get("expected"), str):
        return f"one of {ctx['expected'][:300]}"
    for key, symbol in (("le", "at most"), ("lt", "below"), ("ge", "at least"), ("gt", "above")):
        if key in ctx and isinstance(ctx[key], (int, float)) and not isinstance(ctx[key], bool):
            return f"{symbol} {ctx[key]}"
    if kind in ("string_too_long", "too_long") and isinstance(ctx.get("max_length"), int):
        return f"at most {ctx['max_length']} long"
    if kind.startswith(("int_", "float_")):
        return "a number"
    if kind.startswith("bool"):
        return "true or false"
    return None


def parse_input(model: type[ToolInput], inp: Any) -> tuple[Any, ToolOutcome | None]:
    """Validate ``inp`` with ``model``. Returns ``(parsed, None)`` or
    ``(None, failure)``. An unknown input name is refused with the accepted names
    (:func:`unknown_input_failure`); an invalid value names our own field and what it
    accepts (``Invalid input: check limit (at most 50)``), never the model's text."""
    if inp is None:
        inp = {}
    if not isinstance(inp, dict):
        return None, ToolOutcome.failure("Invalid input: expected an object of named arguments")
    unknown = [k for k in inp if not (isinstance(k, str) and k in model.model_fields)]
    if unknown:
        return None, unknown_input_failure(model, unknown)
    try:
        return model.model_validate(inp), None
    except ValidationError as exc:
        names: list[str] = []
        hints: dict[str, str] = {}
        for err in exc.errors():
            loc = err.get("loc") or ()
            head = loc[0] if loc else None
            if isinstance(head, str) and head in model.model_fields:
                if head not in names:
                    names.append(head)
                hint = _constraint_hint(err)
                if hint and head not in hints:
                    hints[head] = hint
            elif err.get("type") == "extra_forbidden":
                return None, unknown_input_failure(model, list(loc[:1]))
        if names:
            detail = ", ".join(f"{n} ({hints[n]})" if n in hints else n for n in names)
        else:
            detail = "arguments"
        return None, ToolOutcome.failure(f"Invalid input: check {detail}")


def none_if_blank(value: Any) -> Any:
    """``""`` → ``None`` (the model often sends empty strings for unset filters)."""
    if isinstance(value, str) and not value.strip():
        return None
    return value


# --------------------------------------------------------------------------- #
# §3.1 time window (Round 12 SPEC D7: all time, calendar periods, any length).
# --------------------------------------------------------------------------- #
# The legacy relative grammar (lower-case units: m = MINUTES). ``now-6M`` (upper-case
# M) is six MONTHS and goes through ``engine.time_windows``.
_RELATIVE_RE = re.compile(r"^now-(\d{1,5})([mhdw])$")
# A months/years chip bound (``models.TimeRange`` keeps ``now-6M`` and ``now-1y``).
_CALENDAR_RELATIVE_RE = re.compile(r"^now-(\d{1,5})([My])$")
_LEGACY_RELATIVE_RE = re.compile(r"^now(?:-\d{1,5}[mhdw])?$")
_ALL_TIME_WORDS = frozenset({"all", "all_time", "all time", "alltime", "lifetime", "ever", "*", "everything"})
#: The start instant an all-time window hands a log connector (no lower bound).
ALL_TIME_START = datetime(1970, 1, 1, tzinfo=timezone.utc)
ALL_TIME_LABEL = "all time"
# The Logs page (``GET /api/logs``) reads at most this many days; a longer window has
# no exact "Open in Logs" view (the tools themselves are not bounded).
LOGS_PAGE_MAX_DAYS = 90
# Kept for importers; Round 12 removed both clamps from the chat tools (SPEC D7).
MAX_WINDOW_DAYS = 90
MAX_WINDOW_HOURS = 720
WINDOW_HELP = (
    "use all, now-<n>[h|d|w|M|y], a calendar period (today, yesterday, this_week, last_week, "
    "this_month, last_month, this_quarter, last_quarter, ytd, this_year, last_year) or an "
    "ISO-8601 range {from, to}"
)
INVALID_WINDOW = f"Invalid time window: {WINDOW_HELP}"
EMPTY_WINDOW = "Invalid time window: the start must be before the end"
#: A tool window wholly outside the request's selected range: refused, never answered
#: with the whole selected range as if it were the period asked for (§4.8.4).
OUTSIDE_SELECTED_RANGE = ("Invalid time window: the period asked for lies wholly outside the selected time range; "
                          "widen the selected range or ask about a period inside it")
WINDOW_INPUT_DESCRIPTION = "window?=all|now-90d|now-6M|last_month|this_quarter|ytd|{from,to}"


@dataclass(frozen=True)
class Window:
    """An effective time window: the expressions passed to a connector, the
    resolved instants, the whole-hour span (``hours``) for tools that take
    ``window_hours``, a humanised caption ``label`` and whether the request's own
    range narrowed what was asked (``clamped``).

    Round 12: ``all_time`` windows start at :data:`ALL_TIME_START` (a store reads them
    with no lower bound); ``tz`` is the operator timezone calendar periods were cut in;
    ``token`` the normalised input. There is no span cap."""

    time_from: str
    time_to: str
    start: datetime
    end: datetime
    hours: int
    label: str
    source: Literal["tool", "request", "default"]
    clamped: bool = False
    all_time: bool = False
    tz: str = "UTC"
    token: str = ""
    # The instant the window was resolved at, and the engine's own resolution when the
    # window came from ``engine.time_windows`` unchanged (kept for the aggregate API).
    ref: datetime | None = None
    engine: Any = None
    # The calendar unit the window's start was snapped to (``whole_periods``: whole
    # days for a span of days or weeks, whole months for months or years): the window
    # covers N whole periods, the last in progress, exactly as the aggregator counts
    # it. ``None`` when not aligned.
    aligned_to: str | None = None

    def iso_from(self) -> str:
        return self.start.isoformat()

    def iso_to(self) -> str:
        return self.end.isoformat()

    @property
    def created_from(self) -> str | None:
        """The store's lower bound: ``None`` for all time (no bound at all)."""
        return None if self.all_time else self.iso_from()

    @property
    def span_hours(self) -> float:
        return (self.end - self.start).total_seconds() / 3600

    @property
    def span_days(self) -> float:
        return self.span_hours / 24

    @property
    def hours_capped(self) -> bool:
        """Kept for importers: no window is capped any more (Round 12)."""
        return False

    @property
    def trailing(self) -> bool:
        """True when the window ends at the present (``to`` is ``now``)."""
        return self.time_to.strip().lower() == "now"

    def as_resolved(self) -> Any:
        """This window as an :class:`engine.time_windows.ResolvedWindow` (the aggregate
        API's input): ``start=None`` and no upper bound for a trailing all-time window
        (a record stamped after now is still counted, never dropped)."""
        from ...engine.time_windows import ResolvedWindow

        if self.engine is not None and not self.clamped:
            return self.engine
        return ResolvedWindow(
            start=None if self.all_time else self.start, end=self.end, label=self.label,
            tz=self.tz, token=self.token or self.time_from, now=self.ref or self.end,
            open_end=self.all_time and self.trailing,
            kind="all" if self.all_time else ("relative" if self.trailing else "range"),
        )


def whole_periods(window: Window) -> Window:
    """``window`` as every case, metric and cost lookup counts it
    (``engine.time_windows.align_whole_periods``): a relative window of days, weeks,
    months or years covers N whole periods of its own unit, the last in progress, and
    its label says so ("last 90 days (since 15 Jul 2026)", "last 6 months (since May
    2026)"). The start depends on the window alone, never on a breakdown, so one answer
    that counts "last 90 days" as a headline, by month, by severity, as posture tiles,
    as a noise funnel and as AI cost states one start and one population (Round 12
    SPEC §7.2 decision 28). Hours, a single day or month, calendar periods, ranges, all
    time and a window clamped into the request's range come back unchanged."""
    if window.all_time or window.clamped or window.aligned_to:
        return window
    from ...engine.time_windows import align_whole_periods

    try:
        resolved = window.as_resolved()
        aligned = align_whole_periods(resolved)
    except NotImplementedError:
        raise
    except Exception:  # noqa: BLE001 — an unalignable window stays as resolved
        return window
    start = getattr(aligned, "start", None)
    if aligned is resolved or start is None or start == window.start or start >= window.end:
        return window
    return replace(
        window, start=start, time_from=start.isoformat(), hours=_hours(start, window.end),
        label=str(aligned.label or window.label), engine=aligned,
        # The unit the START snapped to (whole days or whole months), which the
        # previous period steps back by.
        aligned_to=str(getattr(aligned, "aligned_to", None) or ""),
    )


def align_to_bucket(window: Window, unit: str | None) -> Window:
    """``window`` as the aggregators count it when it is broken down by the calendar
    ``unit``: :func:`whole_periods`, the same start for every breakdown ("last 6
    months" by month is May to October, its label "last 6 months (since May 2026)";
    "last 90 days" by month starts on 15 Jul, as by day and by severity), so the
    headline, the series, the bucket labels and the compared periods describe the same
    span. ``unit=None`` returns the window unchanged."""
    if not unit:
        return window
    return whole_periods(window)


def operator_tz(ctx: Any) -> str:
    """The operator timezone (``SlaPolicy.timezone``), a valid IANA name, else ``UTC``."""
    name = getattr(getattr(getattr(ctx, "prefs", None), "sla", None), "timezone", None)
    if isinstance(name, str) and name.strip():
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo(name.strip())
            return name.strip()
        except Exception:  # noqa: BLE001 — an unknown zone falls back to UTC
            pass
    return "UTC"


def window_label(time_from: str, time_to: str, start: datetime, end: datetime) -> str:
    """``last 24 hours`` / ``last 30 days`` for a trailing relative window, ``all time``
    for an all-time one, else a UTC minute range."""
    from ...models import humanise_relative_window

    if time_to.strip().lower() == "now":
        if start <= ALL_TIME_START:
            return ALL_TIME_LABEL
        # ``now-6M`` (a months chip) is six MONTHS: read case-sensitively, never
        # lower-cased into six minutes.
        calendar = _CALENDAR_RELATIVE_RE.match(time_from.strip())
        if calendar:
            return humanise_relative_window(int(calendar.group(1)), calendar.group(2))
        match = _RELATIVE_RE.match(time_from.strip().lower())
        if match:
            return humanise_relative_window(int(match.group(1)), match.group(2))
    return f"{start.strftime('%Y-%m-%d %H:%M')} → {end.strftime('%Y-%m-%d %H:%M')} UTC"


def _hours(start: datetime, end: datetime, *, lo: int = 1) -> int:
    span = (end - start).total_seconds() / 3600
    return max(math.ceil(span), lo)


def _is_all(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() in _ALL_TIME_WORDS


def _is_now_relative(expr: Any) -> bool:
    """``now`` / ``now-<n>[mhdw]`` in the legacy grammar (``m`` = MINUTES). ``now-6M``
    (upper-case M, months) is not: the calendar resolver reads it."""
    if not isinstance(expr, str):
        return False
    text = expr.strip()
    lowered = text.lower()
    return lowered.startswith("now") and "M" not in text[3:] and bool(_LEGACY_RELATIVE_RE.match(lowered))


def _legacy_bound(expr: str, ref: datetime) -> tuple[datetime, str] | None:
    """``now``/``now-<n>[mhdw]``/ISO, resolved the classic way (``m`` = minutes)."""
    text = expr.strip()
    lowered = text.lower()
    if lowered.startswith("now"):
        if not _is_now_relative(text):
            return None  # ``now-6M`` is six months: the calendar resolver reads it
        moment = resolve_time_expr(lowered, ref)
        return (moment, lowered) if moment is not None else None
    moment = resolve_time_expr(text, ref)
    return (moment, text) if moment is not None else None


def _engine_window(spec: Any, tz: str, ref: datetime) -> Any:
    """``engine.time_windows.resolve_window`` (calendar periods, months, years, ISO
    ranges), or ``None`` when it cannot read the spec."""
    from ...engine import time_windows

    try:
        resolved = time_windows.resolve_window(spec, tz=tz, now=ref)
    except NotImplementedError:
        raise
    except Exception:  # noqa: BLE001 — an unreadable window is the caller's error
        return None
    return resolved if getattr(resolved, "end", None) is not None else None


@dataclass(frozen=True)
class _Span:
    start: datetime | None        # None = all time
    end: datetime
    time_from: str
    time_to: str
    label: str | None = None      # None = derive with window_label()
    token: str = ""
    engine: Any = None            # the engine's ResolvedWindow, when it resolved this


def _span_from_resolved(resolved: Any, ref: datetime) -> _Span:
    start = resolved.start
    end = resolved.end
    trailing = bool(getattr(resolved, "open_end", False)) or abs((end - ref).total_seconds()) < 1
    return _Span(
        start=start, end=end,
        time_from=start.isoformat() if start is not None else ALL_TIME_START.isoformat(),
        time_to="now" if trailing else end.isoformat(),
        label=str(resolved.label or "") or None, token=str(getattr(resolved, "token", "") or ""),
        engine=resolved,
    )


def _all_time_span(ref: datetime) -> _Span:
    return _Span(None, ref, ALL_TIME_START.isoformat(), "now", ALL_TIME_LABEL, "all")


def _legacy_span(time_from: str, ref: datetime) -> _Span | None:
    """A trailing ``now-<n>[mhdw]`` window (the classic grammar, ``m`` = minutes). A
    start before :data:`ALL_TIME_START` (``now-99999d``) is all time."""
    bound = _legacy_bound(time_from, ref)
    if bound is None:
        return None
    if bound[0] <= ALL_TIME_START:
        return _all_time_span(ref)
    return _Span(bound[0], ref, bound[1], "now", token=bound[1])


def _resolve_spec(spec: Any, tz: str, ref: datetime) -> _Span | str | None:
    """One ``window`` input: all time, the legacy relative grammar, a calendar period,
    ``now-<n>M``/``now-<n>y``, an ISO range ``{from, to}`` or ``"a..b"``."""
    if isinstance(spec, dict):
        lowered = {str(k).strip().lower(): v for k, v in spec.items()}
        return _resolve_range(lowered.get("from") or lowered.get("start"),
                              lowered.get("to") or lowered.get("end"), tz, ref)
    if not isinstance(spec, str) or not spec.strip():
        return None
    text = spec.strip()
    if _is_all(text):
        return _all_time_span(ref)
    if ".." in text:
        left, _, right = text.partition("..")
        return _resolve_range(left or None, right or None, tz, ref)
    if text.lower().startswith("now-") and _is_now_relative(text):
        return _legacy_span(text, ref)
    resolved = _engine_window(text, tz, ref)
    return _span_from_resolved(resolved, ref) if resolved is not None else None


def _resolve_range(time_from: Any, time_to: Any, tz: str, ref: datetime) -> _Span | str | None:
    """A ``{from, to}`` range (also ``"a..b"`` and ``time_from``/``time_to``).

    Only a range whose bounds are both ``now``/``now-<n>[mhdw]`` keeps the classic
    trailing grammar. Every other bound (an ISO date or instant, a calendar token, a
    period literal, ``now-6M``) is resolved by ``engine.time_windows`` in the operator
    timezone (Round 12 SPEC §3.5, D7): a naive instant or a date is local time, a ``to``
    DATE is inclusive (the window runs to the end of that day) and the label is
    humanised ("1 Mar – 10 Oct 2026"). A ``from`` alone that names a period
    (``last_month``, ``2026-Q3``, ``now-6M``) means that whole period; an ISO date or
    instant alone means "since then"."""
    from_expr = none_if_blank(time_from)
    to_expr = none_if_blank(time_to)
    if from_expr is not None and not isinstance(from_expr, str):
        return None
    if to_expr is not None and not isinstance(to_expr, str):
        return None
    if from_expr is None:
        return None
    to_is_now = to_expr is None or to_expr.strip().lower() == "now"
    if _is_all(from_expr) and to_is_now:
        return _all_time_span(ref)
    if to_is_now and _is_now_relative(from_expr):
        return _legacy_span(from_expr, ref)
    if to_expr is None and not _is_all(from_expr) and _legacy_bound(from_expr, ref) is None:
        # A period name or ``now-6M`` on its own: the whole period it names.
        return _resolve_spec(from_expr, tz, ref)
    spec: dict[str, Any] = {"from": "all" if _is_all(from_expr) else from_expr}
    if to_expr is not None:
        spec["to"] = to_expr
    from ...engine import time_windows

    try:
        resolved = time_windows.resolve_window(spec, tz=tz, now=ref)
    except NotImplementedError:
        raise
    except ValueError as exc:
        # An empty range is named as such; anything else is an unreadable window.
        return EMPTY_WINDOW if "empty" in str(exc) else None
    except Exception:  # noqa: BLE001 — an unreadable window is the caller's error
        return None
    return _span_from_resolved(resolved, ref)


# Kept for importers: ``time_from``/``time_to`` resolve exactly like a ``{from, to}`` range.
_resolve_bounds = _resolve_range

# A lower-case ``m`` window ("now-6m", "6m", "last 6m") is MINUTES in the classic
# grammar but reads like MONTHS: the case, metric and cost lookups (where a minute
# window is meaningless) refuse it instead of answering a different question.
_MINUTE_WINDOW_RE = re.compile(r"^(?:now\s*-\s*|(?:last|past|previous|trailing)?[\s_-]*)\d{1,6}\s*m$")
AMBIGUOUS_MINUTES = (
    "Invalid time window: now-<n>m means minutes; use now-<n>M for months, now-<n>d for days "
    "or now-<n>h for hours"
)


def _minute_window(spec: Any) -> bool:
    """Does ``spec`` (a window string or a ``{from, to}`` object) use a lower-case
    ``m`` (minutes) relative bound?"""
    if isinstance(spec, dict):
        return any(_minute_window(v) for v in spec.values())
    if not isinstance(spec, str):
        return False
    text = spec.strip()
    if ".." in text:
        return any(_minute_window(part) for part in text.split(".."))
    return bool(_MINUTE_WINDOW_RE.match(text))


_WINDOW_SPEC_CHARS = 80


def window_input(value: Any) -> Any:
    """The ``window`` input as the model may send it, normalised for validation: a
    bounded string, or a ``{from, to}`` object of bounded strings (``start``/``end``
    accepted as aliases). Anything else is left for the field's own type error."""
    value = none_if_blank(value)
    if isinstance(value, str):
        if len(value) > _WINDOW_SPEC_CHARS:
            raise ValueError("window is too long")
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            name = {"start": "from", "end": "to"}.get(str(key).strip().lower(), str(key).strip().lower())
            if name not in ("from", "to") or not (item is None or isinstance(item, str)):
                raise ValueError("window is {from, to}")
            if isinstance(item, str) and len(item) > _WINDOW_SPEC_CHARS:
                raise ValueError("window is too long")
            if item is not None and item.strip():
                out[name] = item.strip()
        if "from" not in out:
            raise ValueError("window needs from")
        return out
    return value


def resolve_window(
    ctx: ChatToolContext,
    *,
    window: Any = None,
    time_from: str | None = None,
    time_to: str | None = None,
    window_hours: int | None = None,
    default_hours: int = 24,
    default: str | None = None,
    now: datetime | None = None,
    minutes_ok: bool = True,
) -> Window | str:
    """The effective window for one call, or an engine-template error string.

    Precedence (SPEC §3.1): a window in the tool input (``window``, or
    ``time_from``/``time_to``, or ``window_hours`` — set by the model from the user's
    own words) → the request's ``time_range`` chip (``ctx.time_range``) → the screen
    context's ``context.time_range`` (``ctx.context_time_range``) → the tool's own
    default (``default``, a window spec such as ``"all"``, else ``default_hours``).

    Round 12 (SPEC D7): a window may be all time, ``now-<n>[h|d|w|M|y]``, a calendar
    period in the operator timezone (``SlaPolicy.timezone``) or an ISO range, of any
    length (no 90-day or 720-hour clamp). §4.8.4 still holds: when the request
    selected a range (the chip), a tool window is CLAMPED into it — nothing a model
    reads in a tool result can widen what the user selected — and ``clamped`` says
    so. An "All time" chip never clamps. The screen context is only a default.

    ``minutes_ok=False`` (the case, metric and cost lookups) refuses a lower-case
    ``m`` relative window ("now-6m" is six MINUTES, which reads like six months). A
    ``window_hours`` or relative window reaching back before 1970 is all time. A
    clamped calendar window keeps no calendar token: its previous period is the same
    length immediately before it, never a whole calendar period."""
    ref = now or datetime.now(timezone.utc)
    tz = operator_tz(ctx)
    chip = ctx.time_range
    source: Literal["tool", "request", "default"]
    window = none_if_blank(window)
    span: _Span | None
    if window is not None:
        if none_if_blank(time_from) is not None or none_if_blank(time_to) is not None:
            return "Invalid input: give window or time_from/time_to, not both"
        if not minutes_ok and _minute_window(window):
            return AMBIGUOUS_MINUTES
        span = _resolve_spec(window, tz, ref)
        if span is None:
            return INVALID_WINDOW
        source = "tool"
    elif none_if_blank(time_from) is not None or none_if_blank(time_to) is not None:
        if not minutes_ok and (_minute_window(time_from) or _minute_window(time_to)):
            return AMBIGUOUS_MINUTES
        span = _resolve_bounds(time_from if none_if_blank(time_from) is not None else f"now-{default_hours}h",
                               time_to, tz, ref)
        if span is None:
            return INVALID_WINDOW
        source = "tool"
    elif window_hours is not None:
        hours = max(1, int(window_hours))
        if hours * 3600 >= (ref - ALL_TIME_START).total_seconds():
            # "Everything" said as a huge hour count: all time (never an overflow).
            span = _all_time_span(ref)
        else:
            span = _Span(ref - timedelta(hours=hours), ref, f"now-{hours}h", "now", token=f"now-{hours}h")
        source = "tool"
    elif ctx.default_range is not None:
        selected = ctx.default_range
        start, end = selected.resolve(ref)
        if getattr(selected, "is_all_time", False):
            span = _Span(None, end, ALL_TIME_START.isoformat(), selected.to,
                         selected.label(), "all")
        else:
            # A trailing relative chip ("now-6M", "now-24h") keeps its relative token, so a
            # bucketed lookup aligns it to whole periods exactly like the same window
            # asked for in words (``align_to_bucket``).
            relative = selected.to == "now" and bool(
                _RELATIVE_RE.match(selected.from_) or _CALENDAR_RELATIVE_RE.match(selected.from_))
            span = _Span(start, end, selected.from_, selected.to,
                         token=selected.from_ if relative else f"{selected.from_}..{selected.to}")
        source = "request"
    else:
        spec = default if default is not None else f"now-{default_hours}h"
        span = _resolve_spec(spec, tz, ref)
        if span is None:
            return INVALID_WINDOW
        source = "default"
    if isinstance(span, str):
        return span
    if span.start is not None and span.start >= span.end:
        return EMPTY_WINDOW

    start = span.start if span.start is not None else ALL_TIME_START
    end = span.end
    from_expr, to_expr = span.time_from, span.time_to
    all_time = span.start is None
    label = span.label
    clamped = False
    if source == "tool" and chip is not None and not getattr(chip, "is_all_time", False):
        chip_start, chip_end = chip.resolve(ref)
        if start < chip_start:
            start, from_expr, clamped, all_time = chip_start, chip.from_, True, False
        if end > chip_end:
            end, to_expr, clamped = chip_end, chip.to, True
        if start >= end:
            # No overlap at all: refused (the whole selected range would answer a
            # different question than the one asked).
            return OUTSIDE_SELECTED_RANGE
        if clamped:
            label = None
    elif source == "tool" and chip is not None:
        # An "All time" chip: only the end bound still applies.
        chip_start, chip_end = chip.resolve(ref)
        if end > chip_end:
            end, to_expr, clamped, label = chip_end, chip.to, True, None
    if all_time and to_expr.strip().lower() == "now":
        label = ALL_TIME_LABEL
    if all_time:
        token = "all"
    elif clamped:
        # The clamped range itself: a calendar token ("this_month") no longer
        # describes it, so nothing may step back a whole calendar period from it.
        token = f"{start.isoformat()}..{end.isoformat()}"
    else:
        token = span.token or from_expr
    return Window(
        time_from=from_expr, time_to=to_expr, start=start, end=end,
        hours=_hours(start, end), label=label or window_label(from_expr, to_expr, start, end),
        source=source, clamped=clamped, all_time=all_time, tz=tz,
        token=token, ref=ref,
        engine=None if clamped else span.engine,
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
    precedence and request clamp; a window longer than the Logs page's 90 days, or
    all time, has no exact view) written as ABSOLUTE UTC instants
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
        ctx, window=getattr(args, "window", None), time_from=getattr(args, "time_from", None),
        time_to=getattr(args, "time_to", None), now=now,
    )
    if isinstance(window, str):
        return None
    interval = getattr(args, "interval", None)
    if isinstance(interval, str):
        # ``log_stats`` counts the window aligned to whole periods of its series
        # (``logs.aligned_log_window``): the view opens exactly that window. A lazy
        # import: the log tools import this module.
        from .logs import aligned_log_window

        window, _interval = aligned_log_window(window, interval)
    if window.all_time or window.end - window.start > timedelta(days=LOGS_PAGE_MAX_DAYS):
        return None  # the Logs page reads at most 90 days: no exact view of a longer window
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


#: What engine text says for a figure that was not measured (Round 13 T36: no em dash
#: on screen; the run log and step summaries read "FP rate not available").
NOT_AVAILABLE = "not available"


def round_half_up(value: float) -> int:
    """The nearest integer, a half rounded away from zero (``Decimal`` ``ROUND_HALF_UP``
    over the float's exact value): 47.5 -> 48, 47.4 -> 47, -1.5 -> -2. For every
    non-negative figure this is the integer the console's gauge shows (``Math.round``),
    so a step summary never says 47 beside a gauge that says 48 (Round 13 T1)."""
    return int(Decimal(value).to_integral_value(rounding=ROUND_HALF_UP))


def fmt_int(value: Any) -> str:
    """``1,284``, rounded half away from zero (never truncated); ``not available``
    for a missing value."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return NOT_AVAILABLE
    return f"{value if isinstance(value, int) else round_half_up(value):,}"


def console_num(number: float, places: int) -> str:
    """``number`` as the console writes it (``toLocaleString`` with at most ``places``
    decimals, rounded half up): "78", "7.5", "1,284"; trailing zeros dropped."""
    step = Decimal(1).scaleb(-places)
    # Binary noise first (0.145 * 100 is 14.499999999999998, a tile's 14.5): the tools
    # round a rate to two decimals before the console rounds it again.
    quantized = Decimal(str(round(number, 6))).quantize(step, rounding=ROUND_HALF_UP)
    if quantized.is_zero():
        quantized = abs(quantized)  # never "-0"
    text = f"{quantized:,.{places}f}"
    return text.rstrip("0").rstrip(".") if places and "." in text else text


def fmt_pct(value: Any, *, ratio: bool = False, missing: str = NOT_AVAILABLE) -> str:
    """A rate exactly as the console's figures show it (Round 13 close: one figure, one
    form), from a 0..100 value or a 0..1 ``ratio``: a whole percent from 10% up, one
    decimal under 10%, "<1%" for a sliver, rounded half up ("75.6" reads "76%", "7.45"
    reads "7.5%"). A step summary and the planner's prose share it, so neither says
    "75.6%" beside a tile that says "76%". ``missing`` (``not available``) for a missing
    value."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return missing
    number = float(value) * 100 if ratio else float(value)
    if 0 < number < 1:
        return "<1%"
    return f"{console_num(number, 1 if abs(number) < 10 else 0)}%"


def finite(value: Any) -> float | None:
    """A finite float, else ``None`` (a metric's not-measured value is ``None``)."""
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
        "case_number": opt_text(getattr(case, "case_number", ""), 64),
        "title": display_text(getattr(case, "title", "") or getattr(case, "case_id", ""), 120),
        "severity": case_severity(case, prefs),
        "verdict": _VERDICT_SEMANTIC.get(enum_value(getattr(case, "verdict", None)) or ""),
        "status": enum_value(getattr(case, "status", None)),
        "risk": finite(getattr(case, "risk_score", None)),
        "created_at": iso_or_none(getattr(case, "created_at", None)),
    }


def verdict_semantic(value: Any) -> str | None:
    return _VERDICT_SEMANTIC.get(enum_value(value) or "")


#: The ``KpiItem.delta.period_label`` of every "versus the previous window" change
#: (posture KPIs, the shift headline): one wording wherever two tiles sit together.
PREVIOUS_WINDOW_LABEL = "vs previous window"


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


#: The row label of a counted LOG value that is empty (``""`` or only whitespace): the
#: events were counted, only their value is blank, so the row is worded, never the em
#: dash a missing figure would read as (Round 13 T36; BLOCKS G3 keeps the dash for "not
#: measured"). Parenthesised like Kibana's own empty-value label so it does not read as
#: a log value; ``chat_followups.PLACEHOLDER_LABELS`` keeps it from anchoring a chip.
EMPTY_VALUE_LABEL = "(empty)"
#: The row label of a category with no label at all (the word ``stats.group_label``
#: uses for a missing value).
MISSING_LABEL = "(none)"


def categories(
    pairs: list[tuple[Any, Any]], *, unit: str = "count", dimension: str | None = None,
    other: Any = None, ordered: bool = False,
) -> dict[str, Any]:
    """A ``categories`` artifact payload, sorted by value desc then label (stable
    colours, SPEC §7.3). ``None`` values sort last. ``ordered`` keeps ``pairs`` in the
    order given (a canonical order such as Critical, High, Medium, Low, Info) and marks
    the payload so materialisation keeps it too (Round 12 SPEC §7.2 decision 27)."""
    rows = [(display_text(label, 200) or MISSING_LABEL, finite(value)) for label, value in pairs]
    if not ordered:
        rows.sort(key=lambda r: (r[1] is None, -(r[1] or 0), r[0]))
    data: dict[str, Any] = {
        "labels": [r[0] for r in rows], "values": [r[1] for r in rows], "unit": unit,
    }
    if ordered:
        data["ordered"] = True
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
    "AMBIGUOUS_MINUTES",
    "EMPTY_VALUE_LABEL",
    "EMPTY_WINDOW",
    "OUTSIDE_SELECTED_RANGE",
    "MAX_CITATIONS_PER_CALL",
    "MAX_WINDOW_DAYS",
    "MISSING_LABEL",
    "MAX_WINDOW_HOURS",
    "ToolCall",
    "ToolInput",
    "Window",
    "align_to_bucket",
    "whole_periods",
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
    "NOT_AVAILABLE",
    "console_num",
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
    "round_half_up",
    "text",
    "verdict_semantic",
    "visible_text",
    "window_label",
]
