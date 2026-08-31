"""The OCSF event model (pinned to ``OCSF_VERSION``).

This is a pragmatic subset of the Open Cybersecurity Schema Framework: the
objects and attributes the triage engine actually reasons over, plus the
first-class ``unmapped`` catch-all so no source data is ever lost. It is NOT the
full OCSF taxonomy — connectors set the class/category they best fit and drop
everything else into ``unmapped`` (documented per-connector in ``mappings``).

Design rules:
  * ``time`` is epoch milliseconds (UTC) — the suite's single time unit.
  * ``severity_id`` is the OCSF 0..6 scale; ``severity_to_score()`` projects it
    onto the 0..100 scale the deterministic risk engine consumes.
  * ``raw_data`` keeps the original source record (for audit/repro); ``unmapped``
    keeps source fields with no OCSF home. BOTH are attacker-influenceable log
    data and MUST be fenced as UNTRUSTED when placed in any prompt (#9).
"""

from __future__ import annotations

import math
from typing import Any

from pydantic import BaseModel, Field

from ..constants import (
    DEFAULT_SEVERITY_SCALE_MAX,
    OCSF_CAT_FINDINGS,
    OCSF_CLASS_BASE_EVENT,
    OCSF_SEVERITY_TO_SCORE,
    OCSF_VERSION,
)


# --------------------------------------------------------------------------- #
# Nested OCSF objects (subset)
# --------------------------------------------------------------------------- #
class Product(BaseModel):
    name: str | None = None
    vendor_name: str | None = None
    version: str | None = None


class Metadata(BaseModel):
    """Provenance: which product/connector produced and normalised this event."""

    version: str = OCSF_VERSION          # OCSF schema version
    product: Product = Field(default_factory=Product)
    # Suite-specific provenance (additive; lives under metadata so it travels with
    # the event). ``source_type`` is the SourceType value of the originating
    # connector; ``connector`` is the connector instance id; ``uid`` is the
    # source-native record id (used as the stable event id).
    source_type: str | None = None
    connector: str | None = None
    uid: str | None = None
    original_time: str | None = None     # the source's own timestamp string, verbatim


class Endpoint(BaseModel):
    ip: str | None = None
    port: int | None = None
    hostname: str | None = None
    mac: str | None = None
    uid: str | None = None
    domain: str | None = None


class User(BaseModel):
    name: str | None = None
    uid: str | None = None
    type: str | None = None
    domain: str | None = None
    email_addr: str | None = None


class Device(BaseModel):
    hostname: str | None = None
    ip: str | None = None
    uid: str | None = None
    type: str | None = None
    os: str | None = None


class Observable(BaseModel):
    """A typed indicator extracted from the event (ip, user, hostname, hash, ...)."""

    name: str                    # the OCSF attribute path, e.g. "src_endpoint.ip"
    type: str                    # observable type, e.g. "IP Address", "User", "Hostname"
    value: str


# --------------------------------------------------------------------------- #
# severity helpers
# --------------------------------------------------------------------------- #
def severity_id_to_score(severity_id: int | None) -> float:
    """OCSF severity_id (0..6) → the 0..100 score the risk engine uses."""
    if severity_id is None:
        return 0.0
    return OCSF_SEVERITY_TO_SCORE.get(int(severity_id), 0.0)


def project_severity_magnitude(
    raw: Any, scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX
) -> float:
    """THE projection: a raw NATIVE severity → the canonical 0-100 magnitude.

    One formula, one place, shared by every severity surface in the suite (the
    advisory band ladder in ``engine/priority.py``, the Noise-Reduction bucketing,
    and :func:`score_to_severity_id` below)::

        magnitude = min(100, max(0, raw / scale_max * 100))

    ``scale_max`` is the operator-DECLARED ceiling of the source's native severity
    ladder (``config.SourceInstance.severity_scale_max``). One declared number
    describes any ladder — 0..10, 0..16, 0..1000 — which is why this function has no
    per-vendor branch and no magnitude guess: the old ``raw <= 10 ? raw*10 : raw``
    heuristic could not tell a genuinely-low 0..100 score from a high 0..10 rating and
    inverted both. An undeclared ceiling is ``DEFAULT_SEVERITY_SCALE_MAX`` (100), which
    makes the projection the IDENTITY on the OCSF score every normaliser already emits.

    Fail-open and total: a non-numeric or non-finite ``raw`` reads 0.0, and a missing /
    non-numeric / non-positive / NON-FINITE ``scale_max`` falls back to the default rather
    than dividing by zero or by infinity. ``inf`` is rejected as deliberately as ``0``:
    it passes every ``> 0`` test yet would silently read EVERY severity as 0.0. NEVER
    raises."""
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(value):        # NaN / ±inf — no honest magnitude
        return 0.0
    try:
        ceiling = float(scale_max)
    except (TypeError, ValueError):
        ceiling = DEFAULT_SEVERITY_SCALE_MAX
    if not math.isfinite(ceiling) or ceiling <= 0:   # 0 / negative / NaN / inf
        ceiling = DEFAULT_SEVERITY_SCALE_MAX
    return min(100.0, max(0.0, value / ceiling * 100.0))


# DEPRECATED string scale ids, kept ONLY so a legacy caller that still passes the old
# token keeps its exact behaviour. These are alias NAMES a caller may hand us, not a
# runtime vendor lookup: nothing in the suite resolves a source to one of these any
# more (a source declares its ceiling as a number — see ``SourceInstance``). Any string
# NOT listed here (``"auto"``, ``"unknown"``, anything else) resolves to ``None``, which
# each caller maps to its own documented fallback.
_LEGACY_SCALE_CEILINGS: dict[str, float] = {
    "ocsf_0_100": 100.0,
    "0-100": 100.0,
    "0_100": 100.0,
    "0_10": 10.0,
    "0-10": 10.0,
    "wazuh_0_16": 16.0,
}


def resolve_severity_scale_max(scale: Any) -> float | None:
    """Coerce a caller-supplied ``scale`` into a POSITIVE numeric ceiling, or ``None``.

    Accepts the modern numeric ceiling directly and, for back-compat, the deprecated
    string scale ids in :data:`_LEGACY_SCALE_CEILINGS`. Returns ``None`` for ``"auto"``,
    for any unrecognised string, and for a non-positive / non-numeric / NON-FINITE number
    (``nan`` and ``±inf`` alike) — the caller then applies ITS OWN documented fallback
    (the legacy magnitude heuristic in :func:`score_to_severity_id`; the default 100
    ceiling everywhere else). Never raises."""
    if scale is None or isinstance(scale, bool):
        return None                     # a bool is never a ceiling
    if isinstance(scale, (int, float)):
        ceiling = float(scale)
        if not math.isfinite(ceiling) or ceiling <= 0:
            return None
        return ceiling
    if isinstance(scale, str):
        return _LEGACY_SCALE_CEILINGS.get(scale)
    return None


def _legacy_alias_magnitude(value: float, scale: str) -> float:
    """The DEPRECATED string-alias arms of :func:`score_to_severity_id`, byte-identical.

    These are alias NAMES a legacy caller may still hand us; nothing in the suite
    resolves a source to one of them any more (a source declares its ceiling as a
    number). Each arm reproduces its ORIGINAL expression exactly — re-associating
    ``value * 10.0`` into ``value / 10.0 * 100.0`` moves a handful of doubles across an
    OCSF cut by one ULP, which a back-compat arm may not do. Anything unrecognised
    (``"auto"``, ``"unknown"``, …) falls through to the legacy magnitude heuristic.

    Derived from the ONE alias table (:data:`_LEGACY_SCALE_CEILINGS`) so a token can
    never be recognised in one place and not the other; only the ARITHMETIC is per-arm,
    reproducing each original expression exactly.

    Positive ``value`` only (the caller has already returned for ``<= 0``). Total."""
    ceiling = _LEGACY_SCALE_CEILINGS.get(scale)
    if ceiling is None:                 # "auto"/"unknown"/unrecognised
        return value * 10.0 if value <= 10 else value
    if ceiling == 100.0:
        return value                    # original arm: `pass` — already 0..100
    if ceiling == 10.0:
        return value * 10.0             # original arm: `s * 10.0`, NOT `s / 10 * 100`
    return value / ceiling * 100.0      # original arm: `s / 16.0 * 100.0`


def score_to_severity_id(score: float | None, scale: str | float = "auto") -> int:
    """A severity score → the nearest OCSF severity_id (0..6), scale-aware.

    ``scale`` disambiguates the source's native range so a genuine LOW 0..100 severity
    is not inflated (audit #36 — the old magnitude guess x10'd any value <= 10, so an
    OCSF severity of 8 became 80 → High). It accepts:

    * a NUMBER — the source's declared severity-ladder ceiling
      (``config.SourceInstance.severity_scale_max``). This is what the resolver
      ``engine.priority.severity_scale_max_for_source`` now returns, and it is projected
      through the ONE shared :func:`project_severity_magnitude` formula.
    * the DEPRECATED string ids ``"ocsf_0_100"`` / ``"0-100"`` / ``"0_100"`` (ceiling
      100), ``"0_10"`` / ``"0-10"`` (ceiling 10) and ``"wazuh_0_16"`` (ceiling 16) —
      byte-identical to their previous behaviour.
    * ``"auto"`` (default) — the legacy magnitude heuristic (``<=10 ? x10 : as-is``),
      kept UNCHANGED for callers that cannot resolve the source ceiling. This arm is
      deliberate back-compat and is pinned by ``tests/test_receivers.py``; it is the one
      place in the suite where the retired guess survives.

    BYTE-IDENTICAL back-compat: the deprecated string arms keep their ORIGINAL
    arithmetic, not the re-associated shared projection. IEEE-754 multiplication is not
    associative, so ``s / 10.0 * 100.0`` is not ``s * 10.0`` for every double (e.g.
    ``3.9999999999999996`` lands exactly ON the 40 cut one way and just below it the
    other, moving the returned id). A legacy caller must not observe a 1-ULP boundary
    shift; the shared projection applies to the NUMERIC ceilings, which are new here and
    have no prior behaviour to preserve.
    """
    if score is None:
        return 0
    s = float(score)
    if s <= 0:
        return 1                        # Informational
    if isinstance(scale, str):
        s = _legacy_alias_magnitude(s, scale)
    else:
        ceiling = resolve_severity_scale_max(scale)
        if ceiling is not None:
            s = project_severity_magnitude(s, ceiling)
        elif s <= 10:                   # unusable number — legacy magnitude heuristic
            s = s * 10.0
    # NOTE — these 90/70/40/15 cuts are the OCSF ``severity_id`` vocabulary
    # (1=Informational .. 5=Critical), a PUBLIC STANDARD. They are deliberately NOT the
    # 74/48/22/8 cuts of the advisory display ladder in ``engine/priority.py``: that
    # ladder is our own 5-band presentation chip and is free to differ. Only the
    # PROJECTION onto 0-100 is shared (:func:`project_severity_magnitude`); collapsing
    # the two cut ladders would corrupt a standard mapping.
    if s >= 90:
        return 5                        # Critical
    if s >= 70:
        return 4                        # High
    if s >= 40:
        return 3                        # Medium
    if s >= 15:
        return 2                        # Low
    return 1                            # Informational


# --------------------------------------------------------------------------- #
# The event
# --------------------------------------------------------------------------- #
class OCSFEvent(BaseModel):
    """A normalised security event in the canonical OCSF subset."""

    # Classification (self-describing semantics for the LLM)
    category_uid: int = OCSF_CAT_FINDINGS
    class_uid: int = OCSF_CLASS_BASE_EVENT
    activity_id: int = 0
    type_uid: int = 0                    # = class_uid * 100 + activity_id (auto if 0)
    class_name: str | None = None
    activity_name: str | None = None

    # Severity + time
    severity_id: int = 0
    time: int = 0                        # epoch millis (UTC)

    # Human/agent-facing
    message: str = ""
    status: str | None = None

    # Provenance
    metadata: Metadata = Field(default_factory=Metadata)

    # Entities / observables (the risk + correlation engine reads these)
    src_endpoint: Endpoint = Field(default_factory=Endpoint)
    dst_endpoint: Endpoint = Field(default_factory=Endpoint)
    device: Device = Field(default_factory=Device)
    actor_user: User = Field(default_factory=User)
    observables: list[Observable] = Field(default_factory=list)

    # Finding/rule identity (maps onto the suite's ``rule`` / ``rule_name``)
    finding_title: str | None = None     # the detection/rule name (rule_name)
    rule_uid: str | None = None          # the rule id/value (rule)
    count: int = 1

    # Lossless carry-through (FENCE as UNTRUSTED in prompts)
    unmapped: dict[str, Any] = Field(default_factory=dict)
    raw_data: dict[str, Any] = Field(default_factory=dict)

    def model_post_init(self, __context: Any) -> None:  # noqa: D401
        # Auto-compute type_uid the OCSF way when a caller didn't set it.
        if not self.type_uid and self.class_uid:
            object.__setattr__(self, "type_uid", self.class_uid * 100 + self.activity_id)

    # --- projections the engine uses -------------------------------------- #
    @property
    def severity_score(self) -> float:
        return severity_id_to_score(self.severity_id)

    @property
    def event_id(self) -> str:
        """Stable id for cursor dedup + member_event_ids: the source-native uid."""
        return self.metadata.uid or ""

    @property
    def ip(self) -> str | None:
        return self.src_endpoint.ip or self.device.ip

    @property
    def user(self) -> str | None:
        return self.actor_user.name

    @property
    def host(self) -> str | None:
        return self.device.hostname or self.src_endpoint.hostname
