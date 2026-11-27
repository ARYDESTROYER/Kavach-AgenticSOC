"""Deterministic identities for source-pushed events.

Push transports do not all provide a vendor event id.  The engine nevertheless
needs a stable, non-empty id for in-batch de-duplication and idempotent case
attachment.  These helpers derive a bounded id from the configured source
instance plus either the vendor id or a canonical record fingerprint.

The ordinal is used only for id-less records.  That preserves two identical
records in one payload while making a retry of the same payload/order stable.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..utils import dotted_get

_NATIVE_ID_PATHS = ("id", "_id", "uuid", "event.id", "event_id")
#: A LEEF header's EventID names an event TYPE (a QID such as ``LoginFailed``), not
#: one occurrence, so it is never a per-event identity (Round 16 B33). The parsed record
#: keeps it as ``event_id`` for saved mappings and rules; only the identity skips it.
_LEEF_NATIVE_ID_PATHS = tuple(path for path in _NATIVE_ID_PATHS if path != "event_id")
_PREFIX = "push"


def native_event_uid(record: dict[str, Any]) -> str | None:
    """Return the first non-empty vendor identity in ``record``, if present.

    A LEEF record (the receiver sets ``leef_version``) never uses its header EventID:
    without a real per-event id it takes the record fingerprint plus ordinal, as CEF
    and syslog do, so distinct events of one type are never collapsed into one."""
    paths = _LEEF_NATIVE_ID_PATHS if "leef_version" in record else _NATIVE_ID_PATHS
    for path in paths:
        value = dotted_get(record, path)
        if isinstance(value, list):
            value = value[0] if value else None
        if value not in (None, ""):
            return str(value)
    return None


def _digest(value: str, length: int) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _scope_token(source_id: str) -> str:
    return _digest(str(source_id or "unknown-source"), 12)


def source_scoped_event_uid(
    source_id: str,
    *,
    native_uid: str | None = None,
    record: dict[str, Any] | None = None,
    ordinal: int = 0,
) -> str:
    """Build a deterministic, non-empty event id scoped to one source instance.

    Already-scoped ids for the same source are returned unchanged, which makes
    this safe to enforce both at connector normalization and at the ingest
    boundary.  Native ids intentionally omit the ordinal so duplicate delivery
    of one vendor event de-duplicates.  Id-less records include the ordinal so
    identical lines in a single payload remain distinct.
    """
    scope = _scope_token(source_id)
    prefix = f"{_PREFIX}:{scope}:"
    native = str(native_uid or "")
    if native.startswith(prefix):
        return native

    if native:
        material = f"native\x00{native}"
    else:
        canonical = json.dumps(
            record or {},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=str,
        )
        material = f"record\x00{int(ordinal)}\x00{canonical}"
    return f"{prefix}{_digest(material, 32)}"


__all__ = ["native_event_uid", "source_scoped_event_uid"]
