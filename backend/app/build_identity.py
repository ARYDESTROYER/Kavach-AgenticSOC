"""Public, non-secret build identity for persisted operational records.

The API already exposes the running source version and ``TLSOC_BUILD_SHA`` through
``/api/health/build-info``.  Persisted cases, audit events, and usage rows reuse that
same identity so an operator can reconstruct which build produced a record.

Historical records must never be attributed to the process that merely *reads* them,
so the domain models keep nullable defaults.  Callers stamp only genuinely new rows.
"""

from __future__ import annotations

import logging
import os
import re
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


# --------------------------------------------------------------------------- #
# Two *different* questions about the same value.
#
# ``build_stamp`` answers "was this stamped at all?" — the broad completeness test
# behind ``/api/health/build-info``'s ``provenance_complete``. Any non-blank,
# non-``unknown`` string passes, deliberately: a tarball, Nix, Bazel, or CI build
# identifier is honest provenance even though it is not a git object id.
#
# ``engine/update_service`` asks a strictly narrower question — "is this an exact,
# immutable source revision I can pin an upgrade to?" — and answers it with an exact
# 40-hex match. Two independent definitions of "immutable revision" used to live in
# the two modules, so an operator reading build-info saw ``provenance_complete: true``
# while supervised updates refused the same build with no visible reason.
#
# The predicate below is that narrow question, named once and shared. It is
# deliberately NOT merged into ``build_stamp``: collapsing them would report every
# non-git builder as incomplete, a portability regression aimed squarely at the
# deployers furthest from the GitHub-shaped happy path.
# --------------------------------------------------------------------------- #

_SOURCE_REVISION_RE = re.compile(r"[0-9a-f]{40}")

#: Advisory codes reported beside — never instead of — the completeness fields.
BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION = "commit_sha_not_exact_source_revision"
BUILD_IDENTITY_PARTIALLY_STAMPED = "build_identity_partially_stamped"


def is_exact_source_revision(value: object) -> bool:
    """True when ``value`` is an exact git object id (40 lowercase hex characters).

    This is the identity an upgrade can be pinned to. A short ``rev-parse`` output, a
    ``<sha>-dirty`` suffix, a tag name, a CI build number, and ``unknown`` are all
    honest provenance but are NOT exact revisions, so they answer False.

    Note deliberately kept at 40 hex: widening to a 64-hex sha256 object id spans two
    independently deployed units (backend and updater), and relaxing only this side
    would move the refusal later, into the privileged supervised flow.
    """

    return _SOURCE_REVISION_RE.fullmatch(str(value or "").strip().lower()) is not None


def build_identity_advisories(
    commit_sha: str | None = None, build_time: str | None = None
) -> list[str]:
    """Advisory codes for a stamped-but-unpinnable build identity.

    Purely additive: it never changes whether a build counts as *stamped*. Callers
    pass the already-normalized ``build_stamp`` values, or omit them to read the
    current process environment.
    """

    sha = build_stamp("TLSOC_BUILD_SHA") if commit_sha is None else commit_sha
    when = build_stamp("TLSOC_BUILD_DATE") if build_time is None else build_time
    advisories: list[str] = []
    if sha != "unknown" and not is_exact_source_revision(sha):
        advisories.append(BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION)
    if (sha == "unknown") != (when == "unknown"):
        advisories.append(BUILD_IDENTITY_PARTIALLY_STAMPED)
    return advisories


def log_build_identity_advisories(log: logging.Logger | None = None) -> list[str]:
    """Emit one WARNING per advisory at startup. Never raises, never blocks boot.

    A degraded build identity is a real operational problem — every record produced
    by this process inherits it, and supervised updates refuse it — but it is not a
    reason to refuse traffic, so this is strictly observational.
    """

    logger = log or logging.getLogger("tlsoc.build_identity")
    commit_sha = build_stamp("TLSOC_BUILD_SHA")
    build_time = build_stamp("TLSOC_BUILD_DATE")
    advisories = build_identity_advisories(commit_sha, build_time)
    for code in advisories:
        if code == BUILD_IDENTITY_NOT_EXACT_SOURCE_REVISION:
            logger.warning(
                "Build identity TLSOC_BUILD_SHA=%r is stamped but is not an exact "
                "source revision; supervised updates require an immutable 40-character "
                "commit id.",
                commit_sha,
            )
        elif code == BUILD_IDENTITY_PARTIALLY_STAMPED:
            logger.warning(
                "Build identity is half-stamped (TLSOC_BUILD_SHA=%r, "
                "TLSOC_BUILD_DATE=%r); pass both build arguments so records and image "
                "labels identify one coherent build.",
                commit_sha,
                build_time,
            )
    return advisories
