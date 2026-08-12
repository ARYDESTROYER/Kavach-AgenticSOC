"""Public, non-secret build identity for persisted operational records.

The API already exposes the running source version and ``TLSOC_BUILD_SHA`` through
``/api/health/build-info``.  Persisted cases, audit events, and usage rows reuse that
same identity so an operator can reconstruct which build produced a record.

Historical records must never be attributed to the process that merely *reads* them,
so the domain models keep nullable defaults.  Callers stamp only genuinely new rows.
"""

from __future__ import annotations

import os
from typing import TypeVar

from pydantic import BaseModel

from . import __version__

_RecordT = TypeVar("_RecordT", bound=BaseModel)


def build_stamp(environment_key: str) -> str:
    """Return an honest normalized public build stamp.

    Missing, blank, and case-insensitive ``unknown`` values all remain the explicit
    literal ``"unknown"``.  We deliberately do not inspect ``.git`` or invent a SHA
    inside the runtime image.
    """

    value = os.getenv(environment_key, "unknown").strip()
    return value if value and value.lower() != "unknown" else "unknown"


def current_record_provenance() -> dict[str, str]:
    """The producing-build fields for a new persisted operational record."""

    return {
        "app_version": __version__,
        "build_sha": build_stamp("TLSOC_BUILD_SHA"),
    }


def originating_record_provenance(existing: object | None) -> dict[str, str | None]:
    """Return immutable creation provenance for a new or reconstructed record.

    Cases are mutable upserts.  An existing case therefore keeps its original values,
    including legacy ``None`` values; a later deployment must not masquerade as the
    build that created it.
    """

    if existing is None:
        return current_record_provenance()
    return {
        "app_version": getattr(existing, "app_version", None),
        "build_sha": getattr(existing, "build_sha", None),
    }


def stamp_new_record(record: _RecordT) -> _RecordT:
    """Apply one coherent current-build pair to an incompletely stamped new record.

    A partial pair cannot identify a build reliably.  If either field is absent, both
    are replaced together from the current process; a complete caller-supplied pair is
    preserved for explicit producer hand-offs and deterministic fixtures.
    """

    if all(
        getattr(record, field, None) not in (None, "")
        for field in ("app_version", "build_sha")
    ):
        return record
    return record.model_copy(update=current_record_provenance())
