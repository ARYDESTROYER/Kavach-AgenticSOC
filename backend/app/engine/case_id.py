"""Customisable case-ID nomenclature (F7).

``case_id`` stays the immutable internal id (``case-<uuid>``). ``case_number`` is a
human-facing DISPLAY id rendered from an operator-configured template against an
ALLOWLISTED placeholder set, backed by an atomic-ish per-bucket sequence in the KV
store. Everything here is pure render/validate logic plus a tiny SequenceStore; no
new index/table/migration (it reuses the shared KVStore the MEMORY store uses).

Allowlisted placeholders (anything else → template rejected):
    {prefix}              the configured prefix (default "CASE")
    {sep}                 a separator hint ("-")
    {seq}  / {seq:0Nd}    the next sequence number (optionally zero-padded width N)
    {year} / {yy}         4-digit / 2-digit year of creation
    {mm} / {dd}           2-digit month / day of creation
    {source}             the originating source name (slugified), or ""
    {verdict}            the LLM verdict value (lower-cased), or ""

Template injection is prevented by validating EVERY ``{...}`` token against the
allowlist before rendering; an unknown token makes ``validate_template`` return
``(False, error)`` and ``render`` raise ``ValueError``.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..utils import now_utc

logger = logging.getLogger("tlsoc.engine.case_id")

# KV namespace for the case-number sequence (one counter per reset bucket).
CASE_SEQ_NS = "case_seq"

# Bare (no-format-spec) placeholders. ``seq`` is special-cased (supports {seq:0Nd}).
_ALLOWED_BARE = {"prefix", "sep", "seq", "year", "yy", "mm", "dd", "source", "verdict"}

# Matches a single {...} token, capturing the name and an optional :format-spec.
_TOKEN_RE = re.compile(r"\{([a-zA-Z_]+)(:[^}]*)?\}")
# A seq format spec we accept: zero-padded decimal, e.g. ":06d" or ":d".
_SEQ_SPEC_RE = re.compile(r"^:0?\d*d$")


def validate_template(template: str) -> tuple[bool, str]:
    """Return ``(ok, error)``. Rejects empty templates, unknown placeholders, and
    invalid format specs (only ``seq`` may carry a ``:0Nd`` spec)."""
    if not isinstance(template, str) or not template.strip():
        return False, "template must be a non-empty string"
    if len(template) > 200:
        return False, "template too long (max 200 characters)"
    # Reject any stray unmatched braces (e.g. a lone '{' or '}').
    stripped = _TOKEN_RE.sub("", template)
    if "{" in stripped or "}" in stripped:
        return False, "unbalanced or malformed { } in template"
    for m in _TOKEN_RE.finditer(template):
        name, spec = m.group(1), m.group(2)
        if name not in _ALLOWED_BARE:
            return False, f"unknown placeholder: {{{name}}}"
        if spec:
            if name != "seq":
                return False, f"placeholder {{{name}}} does not take a format spec"
            if not _SEQ_SPEC_RE.match(spec):
                return False, f"invalid seq format spec '{spec}' (use e.g. {{seq:06d}})"
    return True, ""


def _slug(value: str) -> str:
    """Lower-case, alnum/dash slug of a source name (bounded). Keeps the rendered
    id filesystem/url-safe and stable."""
    out = re.sub(r"[^a-zA-Z0-9]+", "-", (value or "").strip()).strip("-").lower()
    return out[:40]


def render(template: str, ctx: dict[str, Any]) -> str:
    """Render ``template`` against ``ctx`` (which must supply at least ``seq``).

    ``ctx`` keys: seq:int (required), prefix:str, sep:str, source:str, verdict:str.
    year/yy/mm/dd default to the current UTC date unless overridden in ctx. Raises
    ``ValueError`` for an invalid template (defence in depth; callers should
    validate first)."""
    ok, err = validate_template(template)
    if not ok:
        raise ValueError(f"invalid case-id template: {err}")

    now = now_utc()
    seq = int(ctx.get("seq", 0))
    values: dict[str, str] = {
        "prefix": str(ctx.get("prefix", "CASE")),
        "sep": str(ctx.get("sep", "-")),
        "year": str(ctx.get("year", now.year)),
        "yy": f"{int(ctx.get('year', now.year)) % 100:02d}",
        "mm": f"{int(ctx.get('month', now.month)):02d}",
        "dd": f"{int(ctx.get('day', now.day)):02d}",
        "source": _slug(str(ctx.get("source", ""))),
        "verdict": str(ctx.get("verdict", "")).lower(),
    }

    def _sub(m: re.Match[str]) -> str:
        name, spec = m.group(1), m.group(2)
        if name == "seq":
            if spec:
                # spec is like ":06d"/":d"; apply via format to the int.
                return format(seq, spec[1:])
            return str(seq)
        return values.get(name, "")

    return _TOKEN_RE.sub(_sub, template)


def reset_bucket(reset_period: str, now: Any | None = None) -> str:
    """The sequence bucket key suffix for a reset policy. The counter is per bucket,
    so changing periods rolls a fresh sequence at each boundary."""
    dt = now or now_utc()
    period = (reset_period or "none").lower()
    if period == "calendar_year":
        return f"y{dt.year}"
    if period == "fiscal_year":
        # Fiscal year starting in April (a common default); FY label = the year it ends.
        fy = dt.year + 1 if dt.month >= 4 else dt.year
        return f"fy{fy}"
    if period == "fiscal_quarter":
        # Fiscal quarters anchored to an April-start fiscal year.
        fy = dt.year + 1 if dt.month >= 4 else dt.year
        # Month → fiscal quarter (Apr-Jun=1 ... Jan-Mar=4).
        fq = ((dt.month - 4) % 12) // 3 + 1
        return f"fy{fy}q{fq}"
    return "all"


def preview_samples(
    template: str, *, prefix: str = "CASE", seq_start: int = 1, count: int = 5
) -> dict[str, Any]:
    """Render ``count`` consecutive sample ids without touching any store. Used by
    the settings live-preview endpoint. Returns ``{samples, valid, error}``."""
    ok, err = validate_template(template)
    if not ok:
        return {"samples": [], "valid": False, "error": err}
    samples: list[str] = []
    start = max(int(seq_start), 0)
    for i in range(max(count, 0)):
        try:
            samples.append(render(template, {"seq": start + i, "prefix": prefix}))
        except ValueError as exc:  # pragma: no cover — validate_template guards this
            return {"samples": [], "valid": False, "error": str(exc)}
    return {"samples": samples, "valid": True, "error": ""}


async def allocate_case_number(
    seq_store: Any, fmt: Any, *, source: str = "", at: Any | None = None,
    bucket_at: Any | None = None,
) -> str:
    """The display number the product gives a new case (F7): the next value of the
    configured reset bucket's sequence, rendered through the operator template.

    ``fmt`` is a ``CaseIdFormatConfig``; ``source`` fills ``{source}``. ``at`` is the
    case's creation time (default now): it fills the date placeholders and, unless
    ``bucket_at`` is given, picks the reset bucket. ``bucket_at`` picks the bucket on
    its own: Demo seeding numbers every past case from the CURRENT bucket, so cases
    seeded either side of a reset boundary never share a number (a seeded history is
    numbered at once, not period by period as it happened). Returns "" when numbering
    is off or no sequence store is wired. May raise (the callers keep case creation
    safe)."""
    if fmt is None or not getattr(fmt, "enabled", False) or seq_store is None:
        return ""
    bucket = reset_bucket(fmt.reset_period, bucket_at if bucket_at is not None else at)
    seq = await seq_store.next(fmt.prefix, bucket, start=fmt.seq_start)
    ctx: dict[str, Any] = {"seq": seq, "prefix": fmt.prefix, "source": source or ""}
    if at is not None:
        ctx.update({"year": at.year, "month": at.month, "day": at.day})
    return render(fmt.template, ctx)


class SequenceStore:
    """A tiny monotonic per-bucket counter over the shared :class:`KVStore`.

    Each bucket (``<prefix>:<reset_bucket>``) maps to a single KV document
    ``{"value": <int>}``. ``next()`` is read-modify-write — fine at our
    case-creation cadence (the poller is effectively single-threaded for case
    creation). When a Redis client is supplied, an atomic ``INCR`` is used instead.
    Never raises: a store failure falls back to a best-effort/local value and is
    logged, so case creation can never break on a counter glitch."""

    def __init__(self, kv: Any, *, redis: Any | None = None) -> None:
        self._kv = kv
        self._redis = redis

    @staticmethod
    def _key(prefix: str, bucket: str) -> str:
        return f"{(prefix or 'CASE')}:{bucket}"

    async def next(self, prefix: str, bucket: str, *, start: int = 1) -> int:
        key = self._key(prefix, bucket)
        # Atomic path: Redis INCR (when wired). Seed to start-1 first so the first
        # INCR returns ``start``.
        if self._redis is not None:
            try:  # pragma: no cover — Redis is not used in offline tests
                redis_key = f"{CASE_SEQ_NS}:{key}"
                created = await self._redis.setnx(redis_key, int(start) - 1)
                _ = created
                return int(await self._redis.incr(redis_key))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Redis case-seq INCR failed (%s); using KV fallback", exc)
        # KV read-modify-write fallback.
        try:
            doc = await self._kv.get(CASE_SEQ_NS, key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("case-seq get(%s) failed: %s", key, exc)
            doc = None
        current = 0
        if isinstance(doc, dict):
            try:
                current = int(doc.get("value", 0))
            except (TypeError, ValueError):
                current = 0
        nxt = current + 1 if current >= int(start) else int(start)
        try:
            await self._kv.put(CASE_SEQ_NS, key, {"value": nxt})
        except Exception as exc:  # noqa: BLE001
            logger.warning("case-seq put(%s) failed: %s", key, exc)
        return nxt
