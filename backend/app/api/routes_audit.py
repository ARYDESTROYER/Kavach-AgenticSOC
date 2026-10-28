"""The audit log read API (Round 14 SPEC §4.5.5, §4.5.10).

Moved from ``routes_search.py`` and widened. Every route is a read of the append-only
audit (#2): nothing here updates or deletes a row. Gate: ``audit:view``.

* ``GET /api/audit``: one page of records, newest first by default, with an honest
  total (``total_relation`` ``eq`` or ``gte``), an opaque signed ``next_cursor``, the
  per-run totals of the investigations on the page and the deployment's retention.
* ``GET /api/audit/count``: an exact count up to ``cap`` (at most 100,001), then
  ``gte``; the export dialog uses it.
* ``GET /api/audit/records/{record_id}``: one record, or ``404
  audit_record_not_found``.

**Backward compatibility.** Every parameter of the old route keeps its meaning:
``action`` filters ``action_type``, ``actor`` is an exact match, ``surface``,
``case_id`` and ``source_id`` filter as before (each of these five takes at most 512
characters, far more than any value the suite writes), and ``from`` and ``to`` take the
forms the old Elasticsearch range accepted, with its meaning (:func:`_parse_time`:
date math such as ``now-7d`` or ``now-1d/d``, an ISO 8601 time, a date, a year or
month, epoch milliseconds; a partial ``to`` is filled the way Elasticsearch fills an
``lte`` bound; each takes at most 64 characters, far more than any of these forms
needs). A call without ``scope`` reads every row 100 at a time; ``limit`` 0
or absent means that default, and any other whole number is clamped to 1 to 200 (the
rest comes through ``next_cursor``), never refused. New behaviour comes only through
new parameter names (``scope``, ``q``, ``event``, ``actor_contains``, ``actor_kind``,
``outcome``, ``target``, ``ip``, ``order``, ``cursor``). ``records`` and ``total``
are still the response's keys. A bad value of any parameter, ``limit`` and ``cap``
included, answers ``422`` with ``{"detail": {"code": "audit_invalid_filter" |
"audit_invalid_time", "message"}}``; the ``audit:view`` gate is checked first, so a
caller without it gets ``403`` (and an ``access_denied`` row) whatever it sends.

**Paging is a snapshot.** The first page resolves the time window once and the cursor
carries the resolved instants, so ``now-7d`` does not move under "Load more". Each
store pages inside its own snapshot (an Elasticsearch point-in-time; a SQL high-water
time), the per-run totals are counted inside the same snapshot, and a store that runs
out keeps its final count in the cursor, so ``total`` is the same on every page.

**Demo Mode** (SPEC §3.5, D11). While Demo Mode is on, agent activity is Demo data
and sign-ins and settings changes are real: People and settings reads the real
control store's People rows and the Demo store's People rows, Agent activity reads
the Demo store, and All (or no ``scope``) is the two together, the real control
store's People rows and every Demo row, so it never shows a real agent row under the
Demo badge. Demo rows carry ``record_id`` prefix ``demo:`` and ``demo: true``. The
merged cursor holds a position per store, signed together, and each page is the
time-ordered merge of the next rows of each.

**Open snapshots are bounded and aged.** A list read that is abandoned before its last
page would hold its point-in-time until it expires. The route remembers the snapshots
open reads hold, per process, and forgets (closing its snapshot) a read idle longer
than the point-in-time keep-alive, a read bound to another Demo run and a read that
holds a store which is no longer current, so an ended Demo stack is never kept alive
here. At most eight reads per signed-in caller and 128 in all stay open (with sign-in
off every person is one anonymous caller, so only the process bound applies); past a
bound, a read never continued past its first page closes before one being paged, the
one idle longest first. "Load more" on a closed read answers ``409
audit_cursor_expired`` with a message that names the cause (open a long time, newer
searches took its place, or Demo Mode switched) and the page reloads from the top.
The snapshot handles themselves (an Elasticsearch point-in-time id grows with the
number of shards the audit indices span) stay in that registry and never enter the
cursor, which carries only the read's id and each store's sort position, so the
cursor stays small however many indices the audit spans; a read the registry no
longer holds (a restart included) answers the same ``409``.

**View auditing** (D8): a search, a page read, a count or a record opened writes one
``audit_view`` row per user per distinct filter set per five minutes to the control
store, best-effort (:mod:`app.audit.views`). A count or a record opened with the
page's filters coalesces into the list read's row, a record only when it is one of the
rows those filters select; any other record opened is recorded by its own id.

Every value is returned as stored and renders as plain text (#9); ``prompt_excerpt``
and ``tool_output_summary`` carry fenced untrusted log data.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
import unicodedata
import weakref
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import ValidationError

from ..audit import events, views
from ..audit.audit_log import AUDIT_PIT_KEEP_ALIVE_SECONDS
from ..audit.query import AuditFilters, build_predicate, matches
from ..models import (
    AUDIT_ACTOR_TYPES,
    AUDIT_COUNT_MAX_CAP,
    AUDIT_LEGACY_DEFAULT_LIMIT,
    AUDIT_OUTCOMES,
    AUDIT_PAGE_DEFAULT_LIMIT,
    AUDIT_PAGE_MAX_LIMIT,
    AUDIT_SCOPES,
    AUDIT_SEARCH_MAX_CHARS,
    AUDIT_TOTAL_TRACK_LIMIT,
    AuditCount,
    AuditPage,
    AuditRecord,
    AuditRetention,
    decode_audit_record_id,
    encode_audit_record_id,
    normalise_audit_ip,
)
from ..state import AppState
from ..stores.base import AuditCursorExpired, AuditHit, AuditSearchPage
from ..utils import parse_es_timestamp
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.audit")

router = APIRouter(prefix="/api", tags=["audit"])

#: The longest ``cursor`` accepted (the read's id and each store's sort position; a
#: store's snapshot handle stays in the open-read registry, never in the cursor).
_MAX_CURSOR_CHARS = 8192
_CURSOR_VERSION = 3
#: The member of a store position that names its snapshot (an Elasticsearch
#: point-in-time id, which grows with the number of shards the audit indices span).
_HANDLE = "pit"
_EVENT_RE = re.compile(r"[a-z_]{1,32}(\.[a-z_]{1,32})?")
#: Elasticsearch date math anchored on ``now``: any chain of ``+N<unit>``,
#: ``-N<unit>`` and ``/<unit>`` (rounding), units ``y M w d h H m s``.
_DATE_MATH_RE = re.compile(r"now((?:[+-]\d{1,6}[yMwdhHms]|/[yMwdhHms])*)")
_DATE_MATH_OP_RE = re.compile(r"([+-])(\d{1,6})([yMwdhHms])|/([yMwdhHms])")
_YEAR_RE = re.compile(r"\d{4}")
_MONTH_RE = re.compile(r"(\d{4})-(\d{2})")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
#: Elasticsearch's default ``date`` format is ``strict_date_optional_time||
#: epoch_millis``: a number that is not a four-digit year is epoch milliseconds.
_EPOCH_MILLIS_RE = re.compile(r"\d{1,16}")
#: The time of an ISO 8601 value (after ``T``), its zone removed: which parts are given.
_ISO_TIME_RE = re.compile(r"(\d{2})(?::?(\d{2})(?::?(\d{2})([.,]\d+)?)?)?")
_ISO_ZONE_RE = re.compile(r"(?:[Zz]|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d+)?)?)?)$")
#: A whole number parameter (``limit``, ``cap``): an optional sign and digits.
_WHOLE_RE = re.compile(r"[+-]?\d+")
_MILLISECOND = timedelta(milliseconds=1)
_MICROSECOND = timedelta(microseconds=1)
#: The longest ``from`` or ``to`` value. The longest form any client sends, an ISO 8601
#: time with nanoseconds and a zone offset, is under 40 characters; the bound keeps
#: each ``audit_view`` row, which records the value as sent, small.
TIME_MAX_CHARS = 64
_ORDERS: tuple[str, ...] = ("desc", "asc")
_RETENTION_TTL = 60.0
_retention_cache: dict[str, tuple[float, AuditRetention]] = {}


def _http(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _invalid(message: str) -> HTTPException:
    return _http(422, "audit_invalid_filter", message)


def _invalid_time(message: str) -> HTTPException:
    return _http(422, "audit_invalid_time", message)


def _optional_enum(values: tuple[str, ...]) -> dict[str, Any]:
    """The OpenAPI schema of an optional closed-vocabulary parameter. The parameter
    is typed ``str`` so a bad value is refused by :func:`_choice` with the coded 422
    the Console maps to copy, while the schema still lists the allowed values."""
    return {"anyOf": [{"enum": list(values), "type": "string"}, {"type": "null"}]}


# --------------------------------------------------------------------------- #
# Parameters
# --------------------------------------------------------------------------- #
def _printable(value: str) -> bool:
    """No control, format, surrogate, private-use or unassigned characters and no
    line or paragraph separators (the ``q`` and ``actor_contains`` grammar)."""
    return all(
        not unicodedata.category(ch).startswith("C") and ch not in "  "
        for ch in value
    )


def _bounded_text(value: str | None, name: str, max_chars: int) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) > max_chars or not _printable(text):
        raise _invalid(f"'{name}' must be 1 to {max_chars} printable characters.")
    return text


#: The longest value an old exact-match parameter (``actor``, ``action``, ``surface``,
#: ``case_id``, ``source_id``) takes. Every value the suite writes is far shorter (a
#: user name is at most 160 characters), so the old meaning is unchanged; the bound
#: keeps each ``audit_view`` row, which records the filters, small.
EXACT_MAX_CHARS = 512


def _exact(value: str | None, name: str) -> str | None:
    """An old exact-match parameter: absent when empty, otherwise matched exactly as
    sent (never stripped), and at most :data:`EXACT_MAX_CHARS` characters."""
    if not value:
        return None
    if len(value) > EXACT_MAX_CHARS:
        raise _invalid(f"'{name}' must be at most {EXACT_MAX_CHARS} characters.")
    return value


def _choice(value: str | None, name: str, allowed: tuple[str, ...]) -> str | None:
    """A closed-vocabulary parameter: absent when blank, else one of ``allowed``."""
    if value is None or not value.strip():
        return None
    text = value.strip()
    if text not in allowed:
        listed = ", ".join(allowed[:-1]) + f" or {allowed[-1]}" if len(allowed) > 1 else allowed[0]
        raise _invalid(f"'{name}' must be {listed}.")
    return text


def _order(value: str | None) -> str:
    return _choice(value, "order", _ORDERS) or "desc"


def _shift_months(instant: datetime, months: int) -> datetime:
    """``instant`` moved by calendar months in UTC, the day clamped to the target
    month's length (31 March minus one month is the last day of February)."""
    index = instant.year * 12 + (instant.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    last = (datetime(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return instant.replace(year=year, month=month, day=min(instant.day, last))


def _add(instant: datetime, amount: int, unit: str) -> datetime:
    if unit in ("y", "M"):
        return _shift_months(instant, amount * (12 if unit == "y" else 1))
    seconds = {"w": 604_800, "d": 86_400, "h": 3_600, "H": 3_600, "m": 60, "s": 1}[unit]
    return instant + timedelta(seconds=seconds * amount)


def _floor(instant: datetime, unit: str) -> datetime:
    if unit == "s":
        return instant.replace(microsecond=0)
    if unit == "m":
        return instant.replace(second=0, microsecond=0)
    if unit in ("h", "H"):
        return instant.replace(minute=0, second=0, microsecond=0)
    day = instant.replace(hour=0, minute=0, second=0, microsecond=0)
    if unit == "d":
        return day
    if unit == "w":  # ISO weeks start on Monday, as in Elasticsearch
        return day - timedelta(days=day.weekday())
    if unit == "M":
        return day.replace(day=1)
    return day.replace(month=1, day=1)


def _round(instant: datetime, unit: str, side: str) -> datetime:
    """Elasticsearch rounding: down for ``from`` (``gte``); for ``to`` (``lte``) up
    to the last instant of the unit, so the whole unit is included."""
    start = _floor(instant, unit)
    return start if side == "from" else _add(start, 1, unit) - _MICROSECOND


def _to_millisecond(instant: datetime, side: str) -> datetime:
    """A bound as Elasticsearch applies it to a ``date`` field, which keeps
    milliseconds: a row matches by its time cut to the millisecond. So ``from`` starts
    at the next whole millisecond and ``to`` ends at the last microsecond of its
    millisecond, which gives every store (SQL keeps microseconds) the same rows."""
    floor = instant.replace(microsecond=instant.microsecond - instant.microsecond % 1000)
    if side == "to":
        return floor + _MILLISECOND - _MICROSECOND
    return floor if floor == instant else floor + _MILLISECOND


def _end_of_day(start: datetime) -> datetime:
    """The last instant of the day ``start`` begins."""
    return start + timedelta(days=1) - _MICROSECOND


def _iso_unit(text: str) -> timedelta | None:
    """The unit of the last time part an ISO 8601 value gives (an hour, a minute, a
    second, or a millisecond for any fraction), or ``None`` when it gives no time."""
    for index, char in enumerate(text):
        if char in "Tt ":
            time_part = text[index + 1:]
            break
    else:
        return None
    match = _ISO_TIME_RE.fullmatch(_ISO_ZONE_RE.sub("", time_part, count=1))
    if match is None:
        return timedelta(seconds=1)
    if match.group(2) is None:
        return timedelta(hours=1)
    if match.group(3) is None:
        return timedelta(minutes=1)
    if match.group(4) is None:
        return timedelta(seconds=1)
    return _MILLISECOND


def _parse_time(raw: str | None, side: str, now: datetime) -> datetime | None:
    """One end of the time window, in UTC, or ``None`` when absent.

    The forms the old route passed to an Elasticsearch ``range`` (``gte`` for
    ``from``, ``lte`` for ``to``) keep the meaning Elasticsearch gives them, on every
    store:

    * date math anchored on ``now`` (``now``, ``now-7d``, ``now-1d/d``, ``now/M``;
      ``now`` is cut to the millisecond, rounding is down for ``from`` and up to the
      last instant of the unit for ``to``);
    * epoch milliseconds (a number that is not a four-digit year);
    * a year (``2026``), a month (``2026-10``), a date or an ISO 8601 time (naive
      means UTC). For ``from`` the missing parts are the earliest (``2026`` is 1
      January 2026 at midnight). For ``to`` they are filled as Elasticsearch fills an
      ``lte`` bound: a missing month or day is 1 and a missing time is the end of the
      day, so ``to=2026`` ends on 1 January 2026 at 23:59:59.999 and ``to=2026-10`` on
      1 October; a time ends with the last instant of its last given part
      (``T10:00`` includes 10:00:59.999).

    Every bound then applies at the millisecond, as Elasticsearch's ``date`` field
    stores it (:func:`_to_millisecond`). Anything else, or a value longer than
    :data:`TIME_MAX_CHARS` once trimmed, is ``422 audit_invalid_time``."""
    if raw is None or not raw.strip():
        return None
    text = raw.strip()
    if len(text) > TIME_MAX_CHARS:
        raise _invalid_time(f"'{side}' must be at most {TIME_MAX_CHARS} characters.")
    out_of_range = _invalid_time(f"'{side}' is out of range.")
    try:
        math = _DATE_MATH_RE.fullmatch(text)
        if math:
            # Elasticsearch's ``now`` is the current millisecond.
            instant = now.replace(microsecond=now.microsecond - now.microsecond % 1000)
            for sign, amount, unit, rounding in _DATE_MATH_OP_RE.findall(math.group(1)):
                if rounding:
                    instant = _round(instant, rounding, side)
                else:
                    instant = _add(instant, int(amount) * (-1 if sign == "-" else 1), unit)
            return _to_millisecond(instant, side)
        if _YEAR_RE.fullmatch(text):
            start = datetime(int(text), 1, 1, tzinfo=timezone.utc)
            return start if side == "from" else _end_of_day(start)
        month = _MONTH_RE.fullmatch(text)
        if month:
            start = datetime(int(month.group(1)), int(month.group(2)), 1, tzinfo=timezone.utc)
            return start if side == "from" else _end_of_day(start)
        if _EPOCH_MILLIS_RE.fullmatch(text):
            return _to_millisecond(datetime.fromtimestamp(int(text) / 1000, tz=timezone.utc), side)
    except (OverflowError, OSError, ValueError) as exc:
        raise out_of_range from exc
    if _DATE_RE.fullmatch(text):
        try:
            day = datetime.fromisoformat(text).replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise _invalid_time(f"'{side}' is not a date.") from exc
        return day if side == "from" else _end_of_day(day)
    candidate = text[:-1] + "+00:00" if text[-1:] in ("Z", "z") else text
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise _invalid_time(f"'{side}' must be 'now', 'now-7d' or an ISO 8601 time.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    unit = _iso_unit(text)
    try:
        if side == "to" and unit is not None and unit > _MILLISECOND:
            # The parts not given are the end of the last one given (local time, as
            # written; the zone offset is unchanged by the fill).
            parsed = parsed + unit - _MICROSECOND
        return _to_millisecond(parsed.astimezone(timezone.utc), side)
    except OverflowError as exc:
        raise out_of_range from exc


def _whole_number(raw: str | None, name: str, *, default: int, upper: int) -> int:
    """``limit`` and ``cap``: absent, blank or 0 means ``default``; any other whole
    number is clamped to 1 to ``upper`` (never refused, as the old ``limit`` was);
    anything that is not a whole number is the coded ``422``."""
    if raw is None or not raw.strip():
        return default
    text = raw.strip()
    if not _WHOLE_RE.fullmatch(text):
        raise _invalid(f"'{name}' must be a whole number.")
    digits = text.lstrip("+-").lstrip("0")
    if not digits:
        return default
    if text.startswith("-"):
        return 1
    # A number longer than any bound is clamped without parsing all of it.
    return upper if len(digits) > 12 else min(int(digits), upper)


_WHOLE_NUMBER_SCHEMA: dict[str, Any] = {"anyOf": [{"type": "integer"}, {"type": "null"}]}


def _now() -> datetime:
    """The clock the relative times resolve against (one seam, so a test can move it)."""
    return datetime.now(timezone.utc)


def _filters(
    *,
    scope: str | None,
    q: str | None,
    action: str | None,
    event: str | None,
    actor: str | None,
    actor_contains: str | None,
    actor_kind: str | None,
    outcome: str | None,
    surface: str | None,
    case_id: str | None,
    source_id: str | None,
    target: str | None,
    ip: str | None,
    from_: str | None,
    to: str | None,
    now: datetime | None = None,
) -> AuditFilters:
    """Validate the read API's parameters into :class:`AuditFilters`. Every refusal is
    a coded ``422`` (``audit_invalid_filter`` or ``audit_invalid_time``)."""
    event_value = (event or "").strip() or None
    if event_value is not None and not _EVENT_RE.fullmatch(event_value):
        raise _invalid("'event' must be an event such as auth.login or a category such as access.")
    ip_value = None
    if ip is not None and ip.strip():
        ip_value = normalise_audit_ip(ip.strip())
        if ip_value is None or "/" in ip:
            raise _invalid("'ip' must be one IPv4 or IPv6 address.")
    moment = now or _now()
    return AuditFilters(
        scope=_choice(scope, "scope", AUDIT_SCOPES),
        q=_bounded_text(q, "q", AUDIT_SEARCH_MAX_CHARS),
        action_type=_exact(action, "action"),
        event=event_value,
        actor=_exact(actor, "actor"),
        actor_contains=_bounded_text(actor_contains, "actor_contains", 128),
        actor_kind=_choice(actor_kind, "actor_kind", AUDIT_ACTOR_TYPES),
        outcome=_choice(outcome, "outcome", AUDIT_OUTCOMES),
        surface=_exact(surface, "surface"),
        case_id=_exact(case_id, "case_id"),
        source_id=_exact(source_id, "source_id"),
        target=_bounded_text(target, "target", 256),
        ip=ip_value,
        ts_from=_parse_time(from_, "from", moment),
        ts_to=_parse_time(to, "to", moment),
        from_token=(from_ or "").strip() or None,
        to_token=(to or "").strip() or None,
    )


def _filter_params(
    scope: str | None = Query(
        None, description="people, agent or all; absent reads every row",
        json_schema_extra=_optional_enum(AUDIT_SCOPES),
    ),
    q: str | None = Query(None, description="search: event name, actor, target and the summaries"),
    action: str | None = Query(None, description="exact action_type (unchanged meaning)"),
    event: str | None = Query(
        None, description="structured action (auth.login), category id or event family",
    ),
    actor: str | None = Query(None, description="exact actor (unchanged meaning)"),
    actor_contains: str | None = Query(None, description="actor contains, case-insensitive"),
    actor_kind: str | None = Query(None, json_schema_extra=_optional_enum(AUDIT_ACTOR_TYPES)),
    outcome: str | None = Query(
        None,
        description="success, failure, denied, partial, or unknown (Not recorded: no outcome recorded "
                    "and none derived, or a recorded unknown)",
        json_schema_extra=_optional_enum(AUDIT_OUTCOMES),
    ),
    surface: str | None = None,
    case_id: str | None = None,
    source_id: str | None = None,
    target: str | None = Query(None, description="target id"),
    ip: str | None = Query(None, description="client IP address"),
    from_: str | None = Query(
        None, alias="from",
        description="start: now-7d, now-1d/d, an ISO 8601 time, a date or epoch milliseconds",
    ),
    to: str | None = Query(None, description="end, in the same forms as 'from'"),
) -> AuditFilters:
    """The shared filter parameters of every audit read route."""
    return _filters(
        scope=scope, q=q, action=action, event=event, actor=actor,
        actor_contains=actor_contains, actor_kind=actor_kind, outcome=outcome,
        surface=surface, case_id=case_id, source_id=source_id, target=target, ip=ip,
        from_=from_, to=to,
    )


# --------------------------------------------------------------------------- #
# Which stores a read covers (Demo split)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _Source:
    name: str  # "control" | "demo"
    repo: Any
    scope: str | None
    demo: bool


def _sources(state: AppState, scope: str | None) -> list[_Source]:
    """The stores a read of ``scope`` covers and the scope each is read with.

    With Demo Mode off it is the control store alone. With Demo Mode on, agent
    activity is Demo data and sign-ins and settings changes are real (D11): People and
    settings reads the People rows of both stores, Agent activity reads the Demo store
    only, and All (or no scope) is exactly those two together, the control store's
    People rows and every Demo row. So All is always People plus Agent, and a real
    agent row is never shown under the Demo badge. The count route and the audit
    export read the same split."""
    control = state.control_audit
    demo = getattr(state, "demo_audit", None)
    if demo is None:
        return [_Source("control", control, scope, False)]
    if scope == "agent":
        return [_Source("demo", demo, "agent", True)]
    if scope == "people":
        return [_Source("control", control, "people", False), _Source("demo", demo, "people", True)]
    return [_Source("control", control, "people", False), _Source("demo", demo, None, True)]


# --------------------------------------------------------------------------- #
# The signed cursor
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _CursorState:
    """What a verified cursor carries: the read it continues (``chain``), the time
    window its first page resolved, and each store's entry (``{"at": position}``, with
    ``"held": true`` when the position's snapshot handle is kept in the open-read
    registry, or ``{"done": true, "total", "relation"}`` for a store that ran out)."""

    chain: str
    ts_from: datetime | None
    ts_to: datetime | None
    positions: dict[str, dict[str, Any]]


def _cursor_key(state: AppState) -> bytes:
    return hashlib.sha256(b"agentic-soc:audit-read-cursor:v1\x00" + state.export_cursor_signing_key).digest()


def _subject(actor: str) -> str:
    return hashlib.sha256(actor.encode("utf-8")).hexdigest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _iso_or_none(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value is not None else None


def _encode_cursor(state: AppState, *, actor: str, filters: AuditFilters, order: str,
                   chain: str, positions: dict[str, Any], run: str) -> str:
    """``run`` is the Demo run the page was read under (``""`` with Demo Mode off):
    the cursor continues only while that run is current."""
    payload = _b64(json.dumps(
        {
            "v": _CURSOR_VERSION,
            "sub": _subject(actor),
            "f": filters.binding_hash(),
            "o": order,
            "d": run,
            "k": chain,
            "tf": _iso_or_none(filters.ts_from),
            "tt": _iso_or_none(filters.ts_to),
            "p": positions,
        },
        sort_keys=True, separators=(",", ":"), ensure_ascii=True,
    ).encode("utf-8"))
    signature = _b64(hmac.new(_cursor_key(state), payload.encode("ascii"), hashlib.sha256).digest())
    encoded = f"{payload}.{signature}"
    if len(encoded) > _MAX_CURSOR_CHARS:
        raise _http(503, "audit_unavailable", "The audit store returned a position too large to continue from.")
    return encoded


def _expired() -> HTTPException:
    return _http(
        409, "audit_cursor_expired",
        "The list was refreshed because it had been open a long time.",
    )


def _closed_for_room() -> HTTPException:
    return _http(
        409, "audit_cursor_expired",
        "The list was refreshed because many newer searches were opened after it.",
    )


def _demo_switched() -> HTTPException:
    return _http(
        409, "audit_cursor_expired",
        "The list was refreshed because Demo Mode was turned on or off.",
    )


def _not_a_cursor() -> HTTPException:
    return _http(400, "audit_cursor_invalid", "That cursor is not one this server issued.")


def _instant(value: Any) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("not an instant")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("not an aware instant")
    return parsed


def _decode_cursor(state: AppState, cursor: str, *, actor: str, filters: AuditFilters,
                   order: str) -> _CursorState:
    """The state of a cursor this server signed for this caller, this filter set,
    this order and this Demo run. A cursor whose signature or binding does not hold
    (a restart with a process key, another filter set, a Demo switch, an older
    cursor version) is "expired": the page reloads from the top."""
    # Every cursor this server issues is ASCII (URL-safe base64 and one dot); anything
    # else is not one of ours (and ``hmac.compare_digest`` refuses non-ASCII text).
    if len(cursor) > _MAX_CURSOR_CHARS or not cursor.isascii() or cursor.count(".") != 1:
        raise _not_a_cursor()
    payload, signature = cursor.split(".", 1)
    expected = _b64(hmac.new(_cursor_key(state), payload.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected.encode("ascii"), signature.encode("ascii")):
        raise _expired()
    try:
        value = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise _not_a_cursor() from None
    if (
        not isinstance(value, dict)
        or value.get("v") != _CURSOR_VERSION
        or value.get("sub") != _subject(actor)
        or value.get("f") != filters.binding_hash()
        or value.get("o") != order
        or not isinstance(value.get("k"), str)
        or not isinstance(value.get("p"), dict)
        or not all(
            isinstance(entry, dict) and (
                entry.get("done") is True
                or ("at" in entry and (entry.get("held") is not True or isinstance(entry["at"], dict)))
            )
            for entry in value["p"].values()
        )
    ):
        raise _expired()
    if value.get("d") != (state.demo_run_id or ""):
        # The stores this read paged are not the ones a read covers now.
        raise _demo_switched()
    try:
        ts_from, ts_to = _instant(value.get("tf")), _instant(value.get("tt"))
    except ValueError:
        raise _expired() from None
    return _CursorState(value["k"], ts_from, ts_to, dict(value["p"]))


# --------------------------------------------------------------------------- #
# The snapshots open reads hold (bounded, aged, process-local)
# --------------------------------------------------------------------------- #
#: The most list reads one signed-in caller keeps a snapshot open for.
OPEN_READS_PER_CALLER = 8
#: The most list reads the process keeps a snapshot open for (Elasticsearch caps
#: open point-in-time contexts at 300 per node by default). With sign-in off every
#: person is the same anonymous caller, so only this bound applies to them.
OPEN_READS_TOTAL = 128
#: How many reads closed to make room are remembered, so "Load more" on one can say
#: why it reloads.
OPEN_READS_REMEMBERED = 1024


def _weak(repo: Any) -> Callable[[], Any]:
    """A reference to ``repo`` that does not keep it alive (a store that does not
    support weak references is held strongly)."""
    try:
        return weakref.ref(repo)
    except TypeError:
        return lambda: repo


@dataclass
class _OpenRead:
    """One list read that has a next page."""

    caller: str
    #: ``(reference to the repository, position)`` for every store its next page
    #: continues from. The references are weak, so an ended Demo stack is never kept
    #: alive by a read nobody continues.
    holds: tuple[tuple[Callable[[], Any], Any], ...]
    #: The Demo run its cursor is bound to (``""`` with Demo Mode off).
    run: str
    #: Monotonic time of its latest page.
    at: float
    #: Whether "Load more" has been used on it.
    continued: bool
    #: The snapshot handle of each store its next page continues in, by store name
    #: (kept here so the cursor never carries it).
    handles: dict[str, Any] = field(default_factory=dict)

    def resolved(self) -> list[tuple[Any, Any]]:
        """``(repository, position)`` for each store still alive (a store already
        gone has nothing left to close)."""
        out: list[tuple[Any, Any]] = []
        for ref, position in self.holds:
            repo = ref()
            if repo is not None:
                out.append((repo, position))
        return out


class _OpenReads:
    """The store positions (each may hold an Elasticsearch point-in-time) of the list
    reads that have a next page, keyed by the read's chain id.

    A read is forgotten, and its snapshot closed, when no later page could use it:
    idle longer than the point-in-time keep-alive (the snapshot has expired), bound to
    another Demo run (its cursor is refused) or holding a store that is no longer the
    current one (Demo Mode ended or the store was replaced). Stores are referenced
    weakly, so the registry never keeps an ended Demo stack alive. Past the per-caller
    and process bounds, a read never continued past its first page (a refresh or a
    filter change usually left it) closes before one being paged, the one idle longest
    first."""

    def __init__(
        self,
        *,
        per_caller: int = OPEN_READS_PER_CALLER,
        total: int = OPEN_READS_TOTAL,
        idle_seconds: float = AUDIT_PIT_KEEP_ALIVE_SECONDS,
        remembered: int = OPEN_READS_REMEMBERED,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.per_caller = per_caller
        self.total = total
        self.idle_seconds = idle_seconds
        self.remembered = remembered
        self._clock = clock
        self._reads: OrderedDict[str, _OpenRead] = OrderedDict()
        self._closed_for_room: OrderedDict[str, None] = OrderedDict()

    def __len__(self) -> int:
        return len(self._reads)

    def held_repositories(self) -> list[Any]:
        """Every live repository an open read references (for diagnostics and tests)."""
        return [repo for read in self._reads.values() for repo, _position in read.resolved()]

    def prune(self, *, live: list[Any], run: str) -> list[tuple[Any, Any]]:
        """Forget the reads no later page can use; return their holds to close."""
        now = self._clock()
        stale = [
            chain for chain, read in self._reads.items()
            if now - read.at >= self.idle_seconds
            or read.run != run
            or any(all(ref() is not current for current in live) for ref, _position in read.holds)
        ]
        evicted: list[tuple[Any, Any]] = []
        for chain in stale:
            evicted.extend(self._reads.pop(chain).resolved())
        return evicted

    def hold(self, caller: str, chain: str, holds: list[tuple[Any, Any]], *,
             run: str, continued: bool,
             handles: dict[str, Any] | None = None) -> list[tuple[Any, Any]]:
        """Record what ``chain`` now holds (and the snapshot handle of each store by
        name); return the holds of the reads closed to stay within the bounds (the
        caller closes them)."""
        self._reads.pop(chain, None)
        weak = tuple((_weak(repo), position) for repo, position in holds)
        self._reads[chain] = _OpenRead(caller, weak, run, self._clock(), continued, dict(handles or {}))
        evicted: list[tuple[Any, Any]] = []
        if caller:
            mine = [key for key, read in self._reads.items() if read.caller == caller and key != chain]
            evicted.extend(self._make_room(mine, len(mine) + 1 - self.per_caller))
        others = [key for key in self._reads if key != chain]
        evicted.extend(self._make_room(others, len(others) + 1 - self.total))
        return evicted

    def _make_room(self, keys: list[str], count: int) -> list[tuple[Any, Any]]:
        if count <= 0:
            return []
        # ``keys`` is oldest first; the sort is stable, so within each kind the read
        # idle longest goes first.
        victims = sorted(keys, key=lambda key: self._reads[key].continued)[:count]
        evicted: list[tuple[Any, Any]] = []
        for key in victims:
            evicted.extend(self._reads.pop(key).resolved())
            self._closed_for_room[key] = None
            self._closed_for_room.move_to_end(key)
        while len(self._closed_for_room) > self.remembered:
            self._closed_for_room.popitem(last=False)
        return evicted

    def handle(self, chain: str, name: str) -> Any | None:
        """The snapshot handle ``chain`` holds for the store ``name``, or ``None`` when
        the read is not held (closed, forgotten, or the process restarted)."""
        read = self._reads.get(chain)
        return None if read is None else read.handles.get(name)

    def closed_for_room(self, chain: str) -> bool:
        """Whether ``chain`` was closed because newer reads needed its place."""
        return chain in self._closed_for_room

    def release(self, chain: str) -> list[tuple[Any, Any]]:
        """Forget ``chain``; return what it held (to close when the read failed)."""
        read = self._reads.pop(chain, None)
        return read.resolved() if read is not None else []


_open_reads_by_state: "weakref.WeakKeyDictionary[AppState, _OpenReads]" = weakref.WeakKeyDictionary()


def _open_reads(state: AppState) -> _OpenReads:
    reads = _open_reads_by_state.get(state)
    if reads is None:
        reads = _OpenReads()
        _open_reads_by_state[state] = reads
    return reads


def _live_audit_stores(state: AppState) -> list[Any]:
    """The audit stores a read can page right now."""
    return [repo for repo in (state.control_audit, getattr(state, "demo_audit", None)) if repo is not None]


async def _close_holds(holds: list[tuple[Any, Any]]) -> None:
    for repo, position in holds:
        try:
            await repo.close_search_cursor(position)
        except Exception as exc:  # noqa: BLE001 (a snapshot left open expires on its own)
            logger.debug("Audit read: closing an evicted snapshot failed: %s", exc)


#: Closes started after their request was cancelled (kept so they are not collected
#: before they run).
_DETACHED_CLOSES: set["asyncio.Task[None]"] = set()


def _close_detached(holds: list[tuple[Any, Any]]) -> None:
    """Close ``holds`` in the background: the request that opened them was cancelled,
    so it can no longer await the close itself."""
    if not holds:
        return
    task = asyncio.ensure_future(_close_holds(holds))
    _DETACHED_CLOSES.add(task)
    task.add_done_callback(_DETACHED_CLOSES.discard)


def _split_handles(positions: dict[str, dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """The cursor's per-store entries without their snapshot handles, and the handles
    by store name (for the open-read registry)."""
    entries: dict[str, dict[str, Any]] = {}
    handles: dict[str, Any] = {}
    for name, entry in positions.items():
        at = entry.get("at")
        if entry.get("done") is not True and isinstance(at, dict) and at.get(_HANDLE):
            handles[name] = at[_HANDLE]
            entries[name] = {"at": {k: v for k, v in at.items() if k != _HANDLE}, "held": True}
        else:
            entries[name] = entry
    return entries, handles


def _restore_handles(reads: _OpenReads, chain: str,
                     positions: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The cursor's per-store entries with each held snapshot handle put back from the
    registry. A read the registry no longer holds answers ``409 audit_cursor_expired``
    with the cause it knows."""
    restored: dict[str, dict[str, Any]] = {}
    for name, entry in positions.items():
        if entry.get("held") is True:
            handle = reads.handle(chain, name)
            if handle is None:
                raise _closed_for_room() if reads.closed_for_room(chain) else _expired()
            restored[name] = {"at": {**entry["at"], _HANDLE: handle}}
        else:
            restored[name] = entry
    return restored


# --------------------------------------------------------------------------- #
# Records
# --------------------------------------------------------------------------- #
def _record_id(hit: AuditHit, demo: bool) -> str:
    return encode_audit_record_id(hit.store, hit.ref, index=hit.index, demo=demo)  # type: ignore[arg-type]


def to_record(doc: dict[str, Any], record_id: str, *, demo: bool) -> AuditRecord:
    """One stored row as the read API returns it: as stored, plus the read-time
    projections (category, friendly name, derived outcome and actor kind, Demo flag,
    the fields that hit the write cap). Lenient: a value that drifted is dropped as
    not recorded, never a reason to hide the row."""
    info = events.classify(doc)
    outcome, outcome_derived = events.derive_outcome(doc)
    actor_type, actor_type_derived = events.derive_actor_type(doc)
    data = {
        **{k: v for k, v in doc.items() if isinstance(k, str)},
        "record_id": record_id,
        "outcome": outcome,
        "outcome_derived": outcome_derived,
        "actor_type": actor_type,
        "actor_type_derived": actor_type_derived,
        "category": info.category,
        "event_label": info.label,
        "demo": demo,
        "truncated_fields": events.truncated_fields(doc),
    }
    try:
        return AuditRecord.model_validate(data)
    except ValidationError:
        # A drifted value no lenient validator anticipated: keep the row with its
        # core text, and say nothing it cannot back.
        keep = {
            k: data.get(k) for k in (
                "ts", "surface", "actor", "action_type", "case_id", "source_id", "model",
                "result_summary", "tool_output_summary", "query_text", "prompt_excerpt",
                "tool_name", "event_id", "app_version", "build_sha",
            )
        }
        return AuditRecord.model_validate({
            **{k: (v if v is None or isinstance(v, str) else str(v)) for k, v in keep.items()},
            "record_id": record_id,
            "category": info.category,
            "event_label": info.label,
            "demo": demo,
            "truncated_fields": events.truncated_fields(doc),
        })


# --------------------------------------------------------------------------- #
# Retention (the scope line)
# --------------------------------------------------------------------------- #
def _state_backend(state: AppState) -> str:
    """The own-state backend as the storage lifecycle names it (``routes_storage``)."""
    configured = str(getattr(state.secrets, "state_backend", "elasticsearch") or "elasticsearch")
    if configured == "elasticsearch":
        return str(getattr(state.es, "storage_lifecycle_backend", "elasticsearch") or "elasticsearch")
    return configured


async def _retention(state: AppState) -> AuditRetention:
    """``volatile`` for the in-memory store; the hot and warm days only where the
    lifecycle is actually enforced on the audit ledger (Elasticsearch with an active
    policy). ``None`` days mean the log is kept until an administrator removes it."""
    backend = _state_backend(state)
    if backend == "memory":
        return AuditRetention(volatile=True)
    if backend != "elasticsearch":
        return AuditRetention()
    config = state.prefs.storage_lifecycle
    key = json.dumps([backend, config.model_dump(mode="json")], sort_keys=True)
    cached = _retention_cache.get(key)
    now = time.monotonic()
    if cached is not None and now - cached[0] < _RETENTION_TTL:
        return cached[1]
    from ..engine.storage_lifecycle import lifecycle_status

    try:
        status = await lifecycle_status(state_backend=backend, config=config, es=state.es)
    except Exception as exc:  # noqa: BLE001 (the scope line degrades, the read does not)
        logger.info("Audit retention status unavailable: %s", exc)
        return AuditRetention()
    if status.get("effective_state") == "active":
        retention = AuditRetention(hot_days=int(config.hot_days), warm_days=int(config.warm_days))
    else:
        retention = AuditRetention()
    _retention_cache.clear()
    _retention_cache[key] = (now, retention)
    return retention


# --------------------------------------------------------------------------- #
# View auditing (best-effort)
# --------------------------------------------------------------------------- #
def _actor_name(user: Any) -> str:
    return str(getattr(user, "username", "") or "")


def _request_context(request: Request) -> Any:
    """The request's audit context when the identity writers' helper is installed
    (``app.audit.context.audit_context``, SPEC §4.5.4); ``None`` otherwise."""
    try:
        from ..audit import context as audit_context_module  # type: ignore[attr-defined]
    except ImportError:
        return None
    builder = getattr(audit_context_module, "audit_context", None)
    if builder is None:
        return None
    try:
        return builder(request)
    except Exception as exc:  # noqa: BLE001 (a view row must never fail the read)
        logger.debug("audit context unavailable for a view row: %s", exc)
        return None


def _filter_text(filters: AuditFilters) -> str:
    return " ".join(f"{k}={v}" for k, v in sorted(filters.binding().items()))


def _view_summary(filters: AuditFilters, order: str) -> str:
    parts = _filter_text(filters)
    if order != "desc":
        parts = f"{parts} order={order}".strip()
    text = "searched the audit log" + (": " + parts if parts else "")
    return text[:1000]


async def _note_view(state: AppState, request: Request, user: Any, view: dict[str, Any], summary: str) -> None:
    await views.RECORDER.note(
        state.control_audit,
        actor=_actor_name(user) or "default",
        view=view,
        summary=summary,
        context=_request_context(request),
    )


# --------------------------------------------------------------------------- #
# Reading pages
# --------------------------------------------------------------------------- #
@dataclass
class _PageRead:
    records: list[AuditRecord] = field(default_factory=list)
    total: int = 0
    relation: str = "eq"
    next_positions: dict[str, dict[str, Any]] | None = None
    run_totals: dict[str, int] = field(default_factory=dict)
    #: ``(repository, position)`` for every store the next page continues from.
    holds: list[tuple[Any, Any]] = field(default_factory=list)


def _merge_key(hit: AuditHit) -> float:
    parsed = parse_es_timestamp(hit.doc.get("ts"))
    return parsed.timestamp() if parsed is not None else float("-inf")


def _merge(pages: list[tuple[_Source, AuditSearchPage]], order: str, limit: int) -> list[tuple[_Source, int]]:
    """A k-way merge by time that keeps each store's own order (only the heads are
    compared), so the rows taken from each store are always a prefix of its page.
    Returns ``(source, index into that page)`` in display order."""
    heads = [0] * len(pages)
    out: list[tuple[_Source, int]] = []
    while len(out) < limit:
        best: int | None = None
        best_key = 0.0
        for i, (_source, page) in enumerate(pages):
            if heads[i] >= len(page.hits):
                continue
            key = _merge_key(page.hits[heads[i]])
            if best is None or (key > best_key if order == "desc" else key < best_key):
                best, best_key = i, key
        if best is None:
            break
        out.append((pages[best][0], heads[best]))
        heads[best] += 1
    return out


async def _run_totals(paired: list[tuple[_Source, AuditSearchPage]], by_source: dict[str, list[int]],
                      predicates: dict[str, Any]) -> dict[str, int]:
    """Per ``run_id`` on the page, its event count under the same filters, counted
    inside each store's snapshot (so the count never includes rows "Load more" cannot
    reach)."""
    totals: dict[str, int] = {}
    for source, page in paired:
        ids = sorted({
            str(page.hits[i].doc.get("run_id"))
            for i in by_source.get(source.name, [])
            if isinstance(page.hits[i].doc.get("run_id"), str) and page.hits[i].doc.get("run_id")
        })
        if not ids:
            continue
        try:
            counts = await source.repo.run_totals(predicates[source.name], ids, snapshot=page.start)
        except Exception as exc:  # noqa: BLE001 (group headers fall back to the rows shown)
            logger.info("Audit run totals unavailable: %s", exc)
            continue
        for run, count in counts.items():
            totals[run] = totals.get(run, 0) + int(count)
    return totals


def _first_page_snapshots(active: list[tuple[_Source, Any]], results: list[Any]) -> list[tuple[Any, Any]]:
    """The snapshots this request opened: the start of every first page (a store read
    without an incoming position) that came back."""
    return [
        (source.repo, result.start)
        for (source, position), result in zip(active, results)
        if position is None and isinstance(result, AuditSearchPage) and result.start is not None
    ]


def _close_when_fetched(active: list[tuple[_Source, Any]], tasks: list["asyncio.Future[Any]"]) -> None:
    """After a cancelled request: close each first page's snapshot once its fetch ends
    (now for those already done), since no cursor will ever name it."""
    for (source, position), task in zip(active, tasks):
        if position is not None:
            continue

        def closed(done: "asyncio.Future[Any]", repo: Any = source.repo) -> None:
            if done.cancelled() or done.exception() is not None:
                return
            page = done.result()
            if isinstance(page, AuditSearchPage) and page.start is not None:
                _close_detached([(repo, page.start)])

        task.add_done_callback(closed)


async def _read_page(
    state: AppState,
    *,
    filters: AuditFilters,
    order: str,
    limit: int,
    positions: dict[str, dict[str, Any]] | None,
) -> _PageRead:
    sources = _sources(state, filters.scope)
    active: list[tuple[_Source, Any]] = []
    finished: list[dict[str, Any]] = []
    for source in sources:
        if positions is None:
            active.append((source, None))
            continue
        entry = positions.get(source.name)
        if entry is None:
            continue  # a store this read never covered
        if entry.get("done") is True:
            finished.append(entry)
            continue
        active.append((source, entry.get("at")))
    predicates = {s.name: build_predicate(filters.with_scope(s.scope)) for s, _ in active}

    async def fetch(source: _Source, position: Any) -> AuditSearchPage:
        return await source.repo.search_page(
            predicates[source.name], order=order, limit=limit, cursor=position,
            track_total=AUDIT_TOTAL_TRACK_LIMIT,
        )

    # Every store is read at once. If one fails, or the request is cancelled, the
    # snapshots the others just opened are closed: no cursor will ever continue them,
    # and the in-memory store's snapshot is a copy that would never expire.
    tasks = [asyncio.ensure_future(fetch(s, p)) for s, p in active]
    try:
        results = await asyncio.gather(*tasks, return_exceptions=True)
    except asyncio.CancelledError:
        _close_when_fetched(active, tasks)
        raise
    failure = next((r for r in results if isinstance(r, BaseException)), None)
    if failure is not None:
        await _close_holds(_first_page_snapshots(active, results))
        if isinstance(failure, AuditCursorExpired):
            raise _expired() from None
        if isinstance(failure, HTTPException):
            raise failure
        if not isinstance(failure, Exception):
            raise failure
        logger.warning("Audit read failed: %s", failure)
        raise _http(503, "audit_unavailable", "The audit log could not be read.") from failure
    pages: list[AuditSearchPage] = list(results)
    try:
        return await _assemble(active, pages, finished, positions, order, limit, predicates)
    except asyncio.CancelledError:
        _close_detached(_first_page_snapshots(active, pages))
        raise


async def _assemble(
    active: list[tuple[_Source, Any]],
    pages: list[AuditSearchPage],
    finished: list[dict[str, Any]],
    positions: dict[str, dict[str, Any]] | None,
    order: str,
    limit: int,
    predicates: dict[str, Any],
) -> _PageRead:
    """One page from the stores' pages: the merge by time, the records, the per-run
    totals and each store's next position."""
    paired = list(zip((s for s, _ in active), pages))
    taken = _merge(paired, order, limit)
    by_source: dict[str, list[int]] = {}
    for source, idx in taken:
        by_source.setdefault(source.name, []).append(idx)

    page_of = {s.name: p for s, p in paired}
    records: list[AuditRecord] = []
    for source, idx in taken:
        hit = page_of[source.name].hits[idx]
        try:
            record_id = _record_id(hit, source.demo)
        except ValueError:
            logger.warning("Audit read: a row has no valid record id and was skipped (%s)", hit.index)
            continue
        records.append(to_record(hit.doc, record_id, demo=source.demo))

    # Counted before any snapshot is closed below.
    run_totals = await _run_totals(paired, by_source, predicates)

    next_positions: dict[str, dict[str, Any]] = {}
    holds: list[tuple[Any, Any]] = []
    for (source, previous), page in zip(active, pages):
        consumed = by_source.get(source.name, [])
        if page.exhausted and len(consumed) == len(page.hits):
            # Ran out: keep its final count so later pages report the same total.
            next_positions[source.name] = {"done": True, "total": int(page.total), "relation": page.relation}
            last = page.hits[-1].position if page.hits else page.start
            await source.repo.close_search_cursor(last if last is not None else previous)
            continue
        if consumed:
            position = page.hits[consumed[-1]].position
        else:
            position = page.start if page.start is not None else previous
        next_positions[source.name] = {"at": position}
        holds.append((source.repo, position))
    if positions is not None:
        for name, entry in positions.items():
            next_positions.setdefault(name, entry)
    more = any(entry.get("done") is not True for entry in next_positions.values())

    total = sum(page.total for page in pages) + sum(int(e.get("total") or 0) for e in finished)
    relation = "gte" if (
        any(page.relation == "gte" for page in pages) or any(e.get("relation") == "gte" for e in finished)
    ) else "eq"
    return _PageRead(
        records=records,
        total=total,
        relation=relation,
        next_positions=next_positions if more else None,
        run_totals=run_totals,
        holds=holds if more else [],
    )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
#: The one ``audit:view`` gate. Declared on each route's ``dependencies`` so it runs
#: before the filter parameters are validated (a caller without the grant gets 403
#: and its ``access_denied`` row, never the parameter grammar), and taken again as
#: ``user`` (FastAPI runs the same dependency once per request).
_AUDIT_VIEW = require_permission("audit", "view")


def _empty_window(filters: AuditFilters) -> bool:
    return filters.ts_from is not None and filters.ts_to is not None and filters.ts_from > filters.ts_to


@router.get("/audit", response_model=AuditPage, dependencies=[Depends(_AUDIT_VIEW)])
async def list_audit(
    request: Request,
    filters: AuditFilters = Depends(_filter_params),
    cursor: str | None = Query(None, description="next_cursor of the previous page"),
    order: str = Query("desc", json_schema_extra={"enum": list(_ORDERS)}),
    limit: str | None = Query(
        None,
        description="1 to 200, larger values clamped; absent or 0 is 100 without 'scope', 50 with it",
        json_schema_extra=_WHOLE_NUMBER_SCHEMA,
    ),
    state: AppState = Depends(get_state),
    user: Any = Depends(_AUDIT_VIEW),
) -> AuditPage:
    """One page of audit records with an honest total (SPEC §4.5.5). Read-only (#2)."""
    direction = _order(order)
    default_limit = AUDIT_PAGE_DEFAULT_LIMIT if filters.scope is not None else AUDIT_LEGACY_DEFAULT_LIMIT
    size = _whole_number(limit, "limit", default=default_limit, upper=AUDIT_PAGE_MAX_LIMIT)
    actor_name = _actor_name(user)
    reads = _open_reads(state)
    await _close_holds(reads.prune(live=_live_audit_stores(state), run=state.demo_run_id or ""))
    # Read after the prune's awaits and before the page's first one, so the stores the
    # page covers and the run its cursor is bound to are the same.
    run = state.demo_run_id or ""
    positions = None
    if cursor:
        resumed = _decode_cursor(state, cursor, actor=actor_name, filters=filters, order=direction)
        # The window the first page resolved, not "now" again: the pages of one read
        # are one question.
        filters = replace(filters, ts_from=resumed.ts_from, ts_to=resumed.ts_to)
        chain = resumed.chain
        positions = _restore_handles(reads, chain, resumed.positions)
    else:
        chain = secrets.token_urlsafe(12)
    if _empty_window(filters):
        read = _PageRead()
    else:
        try:
            read = await _read_page(state, filters=filters, order=direction, limit=size, positions=positions)
        except HTTPException as exc:
            if exc.status_code == 409:
                await _close_holds(reads.release(chain))
                if reads.closed_for_room(chain):
                    raise _closed_for_room() from None
            raise
    if read.next_positions is None:
        reads.release(chain)
        next_cursor = None
    else:
        entries, handles = _split_handles(read.next_positions)
        try:
            next_cursor = _encode_cursor(
                state, actor=actor_name, filters=filters, order=direction, chain=chain,
                positions=entries, run=run,
            )
        except HTTPException:
            # No cursor can continue this read: release what it holds now.
            await _close_holds(reads.release(chain) + read.holds)
            raise
        # An anonymous caller (sign-in off) is everyone at once: only the process
        # bound applies to it.
        caller = _subject(actor_name) if actor_name else ""
        await _close_holds(reads.hold(
            caller, chain, read.holds, run=run, continued=positions is not None, handles=handles,
        ))
    page = AuditPage(
        records=read.records,
        total=read.total,
        total_relation=read.relation,  # type: ignore[arg-type]
        next_cursor=next_cursor,
        run_totals=read.run_totals,
        retention=await _retention(state),
    )
    await _note_view(state, request, user, {"list": filters.binding()}, _view_summary(filters, direction))
    return page


@router.get("/audit/count", response_model=AuditCount, dependencies=[Depends(_AUDIT_VIEW)])
async def count_audit(
    request: Request,
    filters: AuditFilters = Depends(_filter_params),
    cap: str | None = Query(
        None, description="exact up to this many (1 to 100,001; absent or 0 is 100,001)",
        json_schema_extra=_WHOLE_NUMBER_SCHEMA,
    ),
    state: AppState = Depends(get_state),
    user: Any = Depends(_AUDIT_VIEW),
) -> AuditCount:
    """Exact up to ``cap``, then ``relation: "gte"`` (SPEC §4.5.5). The export dialog
    asks before it offers an export, and the export job asks again before it reads.

    A count is a search of the audit log, so it is recorded like one (D8): with the
    page's own filters it joins the list read's ``audit_view`` row."""
    bound = _whole_number(cap, "cap", default=AUDIT_COUNT_MAX_CAP, upper=AUDIT_COUNT_MAX_CAP)
    if _empty_window(filters):
        result = AuditCount(count=0, relation="eq")
    else:
        try:
            counts = await asyncio.gather(*(
                source.repo.count_matching(build_predicate(filters.with_scope(source.scope)), cap=bound)
                for source in _sources(state, filters.scope)
            ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Audit count failed: %s", exc)
            raise _http(503, "audit_unavailable", "The audit log could not be counted.") from exc
        count = sum(c for c, _ in counts)
        relation = "gte" if any(r == "gte" for _, r in counts) else "eq"
        if count > bound or (count >= bound and relation == "gte"):
            result = AuditCount(count=bound, relation="gte")
        else:
            result = AuditCount(count=count, relation=relation)  # type: ignore[arg-type]
    await _note_view(state, request, user, {"list": filters.binding()}, _view_summary(filters, "desc"))
    return result


def _selected_by(state: AppState, filters: AuditFilters, doc: dict[str, Any], *, demo: bool) -> bool:
    """Whether the read ``filters`` names would list this row: the record's store is one
    that read covers and the row matches that store's predicate."""
    if _empty_window(filters):
        return False
    for source in _sources(state, filters.scope):
        if source.demo == demo:
            return matches(build_predicate(filters.with_scope(source.scope)), doc)
    return False


@router.get("/audit/records/{record_id}", response_model=AuditRecord, dependencies=[Depends(_AUDIT_VIEW)])
async def get_audit_record(
    record_id: str,
    request: Request,
    filters: AuditFilters = Depends(_filter_params),
    state: AppState = Depends(get_state),
    user: Any = Depends(_AUDIT_VIEW),
) -> AuditRecord:
    """One record by its E12 id, or ``404 audit_record_not_found`` (also for an id
    that does not parse, and for a Demo record while Demo Mode is off).

    The filter parameters are optional and never narrow the answer: the page sends
    its current filters so an open of one of the rows they list counts toward the list
    read's ``audit_view`` row (D8; J and K through the list add nothing). A record those
    filters would not list, or an open without filters, is recorded on its own, by its
    id, once per record per five minutes."""
    not_found = _http(404, "audit_record_not_found", "This record is not in the current store.")
    try:
        ref = decode_audit_record_id(record_id)
    except ValueError:
        raise not_found from None
    repo = getattr(state, "demo_audit", None) if ref.demo else state.control_audit
    if repo is None:
        raise not_found
    try:
        hit = await repo.get_record(ref)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Audit record read failed: %s", exc)
        raise _http(503, "audit_unavailable", "The audit log could not be read.") from exc
    if hit is None:
        raise not_found
    record = to_record(hit.doc, record_id, demo=ref.demo)
    binding = filters.binding()
    if binding and _selected_by(state, filters, hit.doc, demo=ref.demo):
        view: dict[str, Any] = {"list": binding}
        summary = f"opened audit record {record_id} while viewing: {_filter_text(filters)}"[:1000]
    else:
        view, summary = {"record": record_id}, f"opened audit record {record_id}"
    await _note_view(state, request, user, view, summary)
    return record
