"""Small, dependency-light helpers used across the backend."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now_utc().isoformat()


def to_millis(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def parse_es_timestamp(value: Any) -> datetime | None:
    """Parse an Elasticsearch @timestamp value (ISO string or epoch millis)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Heuristic: > 1e12 is epoch millis, otherwise seconds.
        ts = float(value)
        if ts > 1e12:
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        # A stringified epoch (e.g. a source that JSON-encodes "@timestamp" as
        # "1719763200000") must go through the numeric epoch path — otherwise
        # fromisoformat rejects it -> None -> time 0 (1970), mis-dating the event and
        # collapsing distinct same-rule bursts into ONE case (audit #15).
        if re.fullmatch(r"-?\d+(\.\d+)?", s):
            try:
                return parse_es_timestamp(float(s))
            except (ValueError, OverflowError, OSError):
                return None
        # Elasticsearch commonly emits "...Z"; fromisoformat handles "+00:00". Handle a
        # lower-cased "z" too (a caller may have lower-cased the string) (audit #17).
        s = re.sub(r"[zZ]$", "+00:00", s)
        try:
            dt = datetime.fromisoformat(s)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def dotted_get(doc: dict[str, Any], path: str, default: Any = None) -> Any:
    """Read a dotted field path from a (possibly nested) document.

    Handles both nested objects ({"source": {"ip": x}}) and flattened keys
    ({"source.ip": x}), which Elasticsearch sources may use interchangeably.
    """
    if not path:
        return default
    if path in doc:  # flattened key present verbatim
        return doc[path]
    cur: Any = doc
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def first_nonempty(*values: Any) -> Any:
    for v in values:
        if v not in (None, "", [], {}):
            return v
    return None


def new_id(prefix: str = "") -> str:
    uid = uuid.uuid4().hex
    return f"{prefix}{uid}" if prefix else uid


def slug(value: Any, fallback: str = "feed") -> str:
    """A stable, filesystem/key-safe slug for an arbitrary string.

    Lowercases, replaces every run of non-alphanumeric characters with a single
    ``-`` and trims leading/trailing ``-``. Used to derive a deterministic feed id
    from its index pattern (so a legacy ``{pattern, role}`` entry yields the SAME id
    on every load — no migration, idempotent). Returns ``fallback`` when the input
    slugifies to empty (e.g. ``"*"`` → ``""`` → fallback)."""
    s = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return s or fallback


def stable_signature(*parts: Any) -> str:
    """Deterministic, order-defined signature used as the case idempotency key.

    The SAME logical cluster must always produce the SAME signature so re-polling
    a window does not create duplicate cases (Section 6.1 / 11.4).
    """
    norm = "|".join(_norm_part(p) for p in parts)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:32]


def _norm_part(p: Any) -> str:
    if isinstance(p, (list, tuple, set)):
        return ",".join(sorted(str(x) for x in p))
    return str(p)


def coerce_float(value: Any, default: float = 0.0) -> float:
    """Best-effort numeric coercion for heterogeneous severity values."""
    if value is None:
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        m = re.search(r"-?\d+(\.\d+)?", s)
        if m:
            try:
                return float(m.group(0))
            except ValueError:
                return default
        # Common severity words mapped to a rough numeric scale.
        words = {
            "info": 1, "informational": 1, "low": 3, "medium": 5,
            "warning": 5, "high": 7, "error": 7, "critical": 9, "severe": 9,
            "emergency": 10, "alert": 9,
        }
        mapped = words.get(s.lower(), default)
        # ``default`` is typed as a float, but callers legitimately pass ``None`` to mean
        # "report that this value is not numeric" — ``es/fake.py::_to_comparable`` does,
        # with an explicit type-ignore, and then guards its result against None. This
        # line used to be ``float(words.get(...))``, so that documented call raised a
        # TypeError instead: an unparseable string blew up range/sort evaluation rather
        # than comparing as "unknown". Hand a non-numeric default straight back.
        if mapped is None:
            return mapped  # type: ignore[return-value]
        return float(mapped)
    return default


def truncate(text: str | None, limit: int = 500) -> str:
    if not text:
        return ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def extract_json(text: str | None) -> dict | None:
    """Best-effort extraction of a single JSON object from an LLM response.

    Handles raw JSON, ```json fenced blocks, and JSON embedded in prose by
    locating the outermost balanced ``{...}``. Returns ``None`` if nothing
    parseable is found (callers then fail safe).
    """
    if not text:
        return None
    text = text.strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except (json.JSONDecodeError, ValueError):
        pass
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            obj = json.loads(fence.group(1))
            return obj if isinstance(obj, dict) else None
        except (json.JSONDecodeError, ValueError):
            pass
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start: i + 1])
                        return obj if isinstance(obj, dict) else None
                    except (json.JSONDecodeError, ValueError):
                        return None
    return None


_REL_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def relative_to_millis(expr: Any, now: datetime | None = None) -> int:
    """Resolve a time expression to epoch millis.

    Accepts ``"now"``, ``"now-24h"``, ``"now-30m"``, ``"now+1d"``, an ISO string,
    or an int/float already in epoch millis.
    """
    now = now or now_utc()
    if expr is None:
        return to_millis(now)
    if isinstance(expr, (int, float)):
        v = float(expr)
        return int(v if v > 1e12 else v * 1000)
    raw = str(expr).strip()
    s = raw.lower()  # lower-cased ONLY for the "now[±Nunit]" keyword matching
    if s in ("now", ""):
        return to_millis(now)
    if s.startswith("now"):
        rest = s[3:]
        if not rest:
            return to_millis(now)
        sign = 1 if rest[0] == "+" else -1
        body = rest[1:]
        m = re.match(r"(\d+)([smhdw])", body)
        if m:
            amount = int(m.group(1)) * _REL_UNITS[m.group(2)]
            return to_millis(now) + sign * amount * 1000
        return to_millis(now)
    # Parse the ORIGINAL-case string: lower-casing an absolute ISO turns "...Z" into
    # "...z", which parse_es_timestamp used to miss -> None -> silently collapse to
    # now(), corrupting an absolute time-range window (audit #17).
    dt = parse_es_timestamp(raw)
    return to_millis(dt) if dt else to_millis(now)


def parse_millis_strict(value: Any) -> int | None:
    """Epoch millis for an ABSOLUTE timestamp, or ``None`` when it cannot be parsed.

    The strict counterpart of the ``parse_es_timestamp`` → :func:`to_millis` pair.
    Unlike :func:`relative_to_millis` it NEVER substitutes ``now()`` for a value it
    could not understand: an unparseable timestamp reports failure so the caller can
    decide (the case-window push-down keeps such a record rather than silently
    dropping it from every historical window — Non-negotiable #4)."""
    dt = parse_es_timestamp(value)
    return to_millis(dt) if dt is not None else None


def relative_to_millis_strict(expr: Any, now: datetime | None = None) -> int | None:
    """Strict :func:`relative_to_millis`: ``None`` instead of a silent ``now()``.

    :func:`relative_to_millis` resolves anything it cannot parse to ``now()``. That
    is the right default for a *query* window that must always produce a bound, but
    it is wrong for a *filter* bound, where "I could not read this" and "the caller
    asked for right now" are different answers. This variant keeps the accepted
    grammar byte-identical (``now``/``now±Nunit``/ISO/epoch) and returns ``None`` for
    everything else. :func:`relative_to_millis` itself is unchanged — existing callers
    depend on its now-default."""
    if expr is None:
        return None
    if isinstance(expr, bool):
        return None
    if isinstance(expr, (int, float)):
        v = float(expr)
        return int(v if v > 1e12 else v * 1000)
    raw = str(expr).strip()
    if not raw:
        return None
    s = raw.lower()  # lower-cased ONLY for the "now[±Nunit]" keyword matching
    if s == "now":
        return to_millis(now or now_utc())
    if s.startswith("now"):
        rest = s[3:]
        if not rest or rest[0] not in "+-":
            return None
        # Prefix match, exactly like ``relative_to_millis`` — the ONLY intended
        # difference between the two is what happens when nothing parses.
        m = re.match(r"(\d+)([smhdw])", rest[1:])
        if not m:
            return None
        sign = 1 if rest[0] == "+" else -1
        amount = int(m.group(1)) * _REL_UNITS[m.group(2)]
        return to_millis(now or now_utc()) + sign * amount * 1000
    # Parse the ORIGINAL-case string (see relative_to_millis: lower-casing an
    # absolute ISO turns "...Z" into "...z").
    return parse_millis_strict(raw)


def millis_to_iso_utc(millis: int) -> str:
    """Epoch millis → the SAME ISO-8601 UTC spelling the stores persist.

    ``Case.created_at`` is produced by :func:`iso_now`, i.e.
    ``datetime.now(timezone.utc).isoformat()`` → ``YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00``.
    Store-level windowing compares that column LEXICOGRAPHICALLY (the existing
    ``count_new_scans`` / ``count_created_since`` idiom), which is only correct when
    both bounds are normalised to this exact spelling first — hence this helper.
    Built by exact integer arithmetic rather than ``fromtimestamp(ms / 1000.0)`` so a
    float rounding error can never shift the bound by a microsecond."""
    return (
        datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=int(millis))
    ).isoformat()


def relative_to_iso_utc_strict(expr: Any, now: datetime | None = None) -> str | None:
    """:func:`relative_to_millis_strict` rendered as :func:`millis_to_iso_utc`."""
    millis = relative_to_millis_strict(expr, now=now)
    return None if millis is None else millis_to_iso_utc(millis)
