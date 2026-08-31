"""ADVISORY triage derivation — severity / impact / urgency / priority bands.

These are PURE, side-effect-free, READ-TIME derivations used only for the case
PRESENTATION / aggregation surfaces (the "four honest chips" + the ITIL priority
grid). They turn already-recorded facts on a :class:`app.models.Case` into the
human-facing advisory bands the UI renders.

⛔ NON-NEGOTIABLE #3: NOTHING here ever feeds ``engine/case_manager.decide()``.
``decide()`` stays a pure function of ``(verdict, confidence, risk_score, policy)``;
the bands below are derived AFTER the fact, purely for display/reporting/ordering.
The accompanying test asserts ``decide()`` output is INVARIANT to any priority band.

Each derived value is honestly DISTINCT from ``risk_score`` (the 0-100 deterministic
risk number):

* ``severity`` — the SOURCE-asserted maximum member-event severity (what the SIEM/
  EDR claimed about the events), NOT our computed risk. Recorded on the case's
  ``trigger_reason.severity_max`` (falling back to the risk-breakdown only when a
  source never asserted a severity).
* ``impact`` — derived from ASSET CRITICALITY (how important the affected entity is),
  via :func:`app.engine.risk._asset_criticality`.
* ``urgency`` — derived from the deterministic ``risk_score`` (how pressing the
  situation is right now) blended with escalation.
* ``priority`` — the ITIL Impact×Urgency → P1..P4 lookup against the operator's
  :class:`app.config.PriorityMatrix`. ADVISORY ordering only.

All inputs are case-derived (some source/log-influenceable): the functions treat
them as plain DATA — they never interpolate anything into a prompt (#9 lives at the
prompt boundary; this module returns plain values the UI render-escapes).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import Preferences, PriorityMatrix
from ..constants import DEFAULT_SEVERITY_SCALE_MAX, SEVERITY_BANDS
from ..models import Case
from ..ocsf.model import project_severity_magnitude, resolve_severity_scale_max
from .risk import _asset_criticality

logger = logging.getLogger(__name__)

# Advisory band vocabulary. The SEVERITY axis uses the full 5-band ladder
# (critical/high/medium/low/info); the impact/urgency/risk axes project onto the
# 3-band {high, medium, low} subset. Operators tune the P-level grid via
# Preferences.priority_matrix; the band CUTS here are deliberately fixed + documented
# (advisory display), not a decision surface (#3).
_CRITICAL = "critical"
_HIGH = "high"
_MEDIUM = "medium"
_LOW = "low"
_INFO = "info"

# 0-100 magnitude cut points — THE single source of truth for the advisory ladder
# (``constants.SEVERITY_BANDS`` references these 74/48/22/8 cuts). They mirror the webui
# ``badges.tsx::severityBandFromNumber`` (palette ``scoreBand`` 74/48/22 + an <8 info
# floor) EXACTLY so the backend severity chip and the front-end badge never drift.
#
# NOTE — these cuts are DELIBERATELY not the 90/70/40/15 cuts in
# ``app/ocsf/model.py::score_to_severity_id``. That ladder maps onto the OCSF
# ``severity_id`` vocabulary (1=Informational .. 5=Critical), a PUBLIC STANDARD we do not
# get to re-cut; this ladder is our own 5-band presentation chip, matched to the front-end
# badge. Only the PROJECTION onto the 0-100 magnitude is shared between them
# (:func:`app.ocsf.model.project_severity_magnitude`) — unifying the cuts as well would
# corrupt a standard mapping.
_BAND_CRIT_CUT = 74.0    # >=74 -> critical
_BAND_HIGH_CUT = 48.0    # >=48 -> high
_BAND_MED_CUT = 22.0     # >=22 -> medium
_BAND_INFO_CUT = 8.0     # >=8 -> low; <8 -> info (severity axis only)


def _severity_band_from_magnitude(mag: float) -> str:
    """Map a 0-100 magnitude onto the FULL 5-band SEVERITY ladder.

    Mirrors the webui ``badges.tsx::severityBandFromNumber`` EXACTLY (the ONE front-end
    severity authority): ``scoreBand`` gives critical>=74 / high>=48 / medium>=22 / low,
    then a sub-8 magnitude reads as ``info`` (a genuinely-nil score is informational, not
    a low alert). Advisory display only — never feeds ``decide()`` (#3)."""
    if mag >= _BAND_CRIT_CUT:
        return _CRITICAL
    if mag >= _BAND_HIGH_CUT:
        return _HIGH
    if mag >= _BAND_MED_CUT:
        return _MEDIUM
    if mag >= _BAND_INFO_CUT:
        return _LOW
    return _INFO


def _band_from_magnitude(magnitude: float) -> str:
    """Map a 0-100 magnitude onto the 3-band high/medium/low ladder (advisory display).

    Shares the severity ladder's 48/22 high/medium cuts so the impact/urgency/risk chips
    order-agree with severity; it has no critical/info band (impact/urgency are
    {high, medium, low} advisory chips). Never feeds ``decide()`` (#3)."""
    if magnitude >= _BAND_HIGH_CUT:
        return _HIGH
    if magnitude >= _BAND_MED_CUT:
        return _MEDIUM
    return _LOW


# --------------------------------------------------------------------------- #
# The severity CEILING — one declared number per source, no vendor branch.
#
# A source's native severity ladder is described by exactly ONE number: its ceiling
# (``config.SourceInstance.severity_scale_max``). The projection onto the canonical
# 0-100 magnitude is then a single formula shared with the OCSF layer
# (:func:`app.ocsf.model.project_severity_magnitude`):
#
#     magnitude = min(100, max(0, raw / scale_max * 100))
#
# What this REPLACED, and why:
#   * a per-``source_type`` runtime branch (Wazuh → 0-16, push → 0-100, pull → 0-10).
#     Vendor knowledge now lives ONLY as a SEED written into the source's editable
#     ceiling at construction time (``config.SEEDED_SEVERITY_SCALE_MAX``); no read path
#     asks what product a source is.
#   * a hardcoded demo-source-id allowlist that forced those sources onto the identity
#     projection. Undeclared now MEANS the identity projection, so the special case
#     became the default and the allowlist is gone (it was also stale — it omitted a
#     demo source, which therefore got the wrong ladder).
#   * the ``raw <= 10 ? raw*10 : raw`` magnitude guess for an unresolvable scale. A guess
#     cannot tell a genuinely-low 0-100 score from a high 0-10 rating; it inverted both.
#     Undeclared now projects through the IDENTITY and says so honestly.
#
# Precedence: DECLARED ceiling > seeded default > ``DEFAULT_SEVERITY_SCALE_MAX`` (100).
# --------------------------------------------------------------------------- #

# Provenance tokens for the severity band (the honest "who graded this" chip).
_SRC_ASSERTED = "source_asserted"      # the source's own number, projected as declared
_SRC_DERIVED = "derived"               # no source severity at all → our risk total
_SRC_OUT_OF_RANGE = "source_out_of_range"   # raw exceeded the declared ceiling — see below

# Bounded set of (source_id, ceiling) pairs already reported as out-of-range, so ONE
# misdeclared source logs ONE line instead of one per case on every ``GET /api/cases``.
# Process-local + advisory: losing it on restart only re-emits the notice once.
_SATURATION_LOG_CAP = 256
_saturation_logged: set[tuple[str, float]] = set()


def severity_scale_max_for_source(inst: Any) -> float:
    """THE resolver: the severity-ladder CEILING a configured source asserts severity on.

    Given a resolved :class:`app.config.SourceInstance` (or ``None`` when the source is
    unknown / unconfigured), returns the POSITIVE ceiling used to project a raw source
    severity onto 0-100. There is no ``source_type`` branch and no scale vocabulary any
    more — the source carries one declared number:

    * a declared (or seeded) ``severity_scale_max`` → that number.
    * ``None`` / unconfigured / undeclared / unusable → ``DEFAULT_SEVERITY_SCALE_MAX``
      (100), i.e. the IDENTITY projection on the canonical OCSF ``severity_score``.

    Total + fail-open: a duck-typed object, a missing attribute or a garbage value all
    degrade to the default rather than raising. Advisory display / accounting only — it
    never feeds ``case_manager.decide()`` (#3).

    ``severity_scale_for_source`` is a deprecated alias of this function, kept so the
    existing call sites (poller / ingest / event detection / OCSF normalisation /
    Noise-Reduction counters) keep importing the SAME one resolver."""
    if inst is None:
        return DEFAULT_SEVERITY_SCALE_MAX
    ceiling = resolve_severity_scale_max(getattr(inst, "severity_scale_max", None))
    return ceiling if ceiling is not None else DEFAULT_SEVERITY_SCALE_MAX


# Deprecated NAME for the one resolver above (it returns a numeric ceiling now, not a
# scale id). Kept as an alias so every existing importer resolves the same function.
severity_scale_for_source = severity_scale_max_for_source


def _scale_max_for_case(case: Case, prefs: Preferences | None) -> float:
    """The severity-ladder CEILING the case's source asserts ``severity_max`` on.

    A bare magnitude is ambiguous without provenance — a rule level of 12 on a 0-16
    ladder is CRITICAL, while a score of 12 on a 0-100 ladder is LOW — so we look the
    case's ``source_id`` up against the operator's configured ``Preferences.sources`` and
    read that source's DECLARED ceiling.

    Fallbacks, in order:

    * no ``prefs`` → ``DEFAULT_SEVERITY_SCALE_MAX`` (identity).
    * a configured source that does not declare a ceiling → its seeded default, else the
      identity.
    * no ``source_id``, or an unmatched one (including the zero-config profile, where the
      implicit single source has no ``SourceInstance`` at all) → the identity.

    There is deliberately NO Preferences-level fallback. This is a READ-time surface, and
    the ingest-time surfaces that must agree with it — OCSF normalisation, the durable
    Noise-Reduction band counters, the per-feed severity floor — resolve the ceiling from
    the EVENT's own source instance. A global fallback only this function could see would
    make the case chip read ``critical`` for the very same raw number the funnel had
    already tallied as ``low``, and the counters are bucketed by band at write time, so
    that split could never be re-projected. One declaration tier, read identically
    everywhere.

    Never raises."""
    if prefs is None:
        return DEFAULT_SEVERITY_SCALE_MAX
    source_id = getattr(case, "source_id", None)
    if not source_id:
        return DEFAULT_SEVERITY_SCALE_MAX
    for s in getattr(prefs, "sources", None) or []:
        if getattr(s, "id", None) == source_id:
            return severity_scale_max_for_source(s)
    return DEFAULT_SEVERITY_SCALE_MAX


def _normalise_severity(
    raw: float, scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX
) -> float:
    """Project a source-asserted severity onto 0-100 against the source's DECLARED ceiling.

    Thin, stable wrapper over the ONE shared projection
    (:func:`app.ocsf.model.project_severity_magnitude`)::

        magnitude = min(100, max(0, raw / scale_max * 100))

    ``scale_max`` is the number :func:`severity_scale_max_for_source` returns. For
    back-compat it also accepts the deprecated string scale ids (``"0_10"`` → ceiling 10,
    and so on); anything unresolvable — including the old ``"unknown"`` token — falls back
    to ``DEFAULT_SEVERITY_SCALE_MAX`` (100, the identity), because the retired
    ``raw <= 10 ? raw*10 : raw`` guess is exactly what this change deletes.

    Clamped to 0..100. Never raises."""
    ceiling = resolve_severity_scale_max(scale_max)
    return project_severity_magnitude(
        raw, ceiling if ceiling is not None else DEFAULT_SEVERITY_SCALE_MAX
    )


def _note_severity_saturation(case: Case, raw: float, ceiling: float) -> None:
    """Log ONE structured line the first time a source oversteps its declared ceiling.

    A raw severity ABOVE the declared ceiling is proof the declaration is wrong (or that
    the source changed its ladder). Advisory + fail-open: a logging problem is swallowed,
    and the bounded dedupe set keeps a misdeclared source from flooding the log on a
    case-list render.

    The emit is gated on RECORDING the key, never merely on the cap: a set that logged
    while refusing to remember would stop deduplicating at exactly the moment it filled
    up, which is the flood this exists to prevent. Once the cap is reached the notice is
    simply dropped — the bound is the point, and this is advisory log hygiene, not
    evidence."""
    try:
        source_id = str(getattr(case, "source_id", None) or "")
        key = (source_id, float(ceiling))
        if key in _saturation_logged:
            return
        if len(_saturation_logged) >= _SATURATION_LOG_CAP:
            return
        _saturation_logged.add(key)
        logger.warning(
            "severity above declared ceiling: source_id=%s severity_scale_max=%s raw=%s "
            "(band clamped to 100; declare the source's real ceiling to fix)",
            source_id or "<unset>",
            ceiling,
            raw,
        )
    except Exception:  # noqa: BLE001 — an advisory notice must never break a read
        pass


def severity_band_from_events(case: Case, prefs: Preferences | None = None) -> dict[str, Any]:
    """SOURCE-asserted severity band for a case (NOT risk).

    Reads the maximum member-event severity the SOURCE asserted (recorded on
    ``trigger_reason.severity_max`` by correlation) and projects it onto 0-100 against the
    source's DECLARED severity-ladder ceiling (resolved from the case's ``source_id``
    against ``prefs.sources`` — see :func:`_scale_max_for_case`). One declared number
    describes any native ladder, so a rule level of 12 on a declared 0-16 ladder reads
    HIGH while a score of 12 on an undeclared (100) ladder reads LOW — no magnitude guess,
    no per-vendor branch.

    When no source severity was ever asserted (``severity_max`` is None) we DERIVE a band
    from the deterministic risk total as a last resort, and flag ``source`` accordingly so
    the UI can badge "(derived)" honestly.

    PROVENANCE — ``source`` is one of THREE tokens:

    * ``"source_asserted"`` — the source's own number, projected as declared.
    * ``"derived"`` — no source severity existed; the band comes from our risk total.
    * ``"source_out_of_range"`` — the raw value EXCEEDED the declared ceiling, so the
      projection saturated at 100. A raw above the ceiling PROVES the ceiling wrong, which
      means the band is no longer the source's claim but an artefact of our own clamped
      arithmetic. The UI must therefore NOT show a "source" provenance chip for it, and
      one structured log line names the source, its ceiling and the raw value so the
      operator can correct the declaration.

    Returns ``{band, value (0-100), raw, source, scale_max, scale}`` where ``scale_max``
    is the resolved numeric ceiling used for the projection (``scale`` is the deprecated
    alias of the same number)."""
    tr = case.trigger_reason
    raw = None
    if tr is not None and tr.severity_max is not None:
        raw = float(tr.severity_max)
    if raw is not None:
        scale_max = _scale_max_for_case(case, prefs)
        mag = _normalise_severity(raw, scale_max)
        provenance = _SRC_ASSERTED
        if raw > scale_max:
            provenance = _SRC_OUT_OF_RANGE
            _note_severity_saturation(case, raw, scale_max)
        return {
            "band": _severity_band_from_magnitude(mag),
            "value": round(mag, 2),
            "raw": raw,
            "source": provenance,
            "scale_max": scale_max,
            # Deprecated key: the resolved ceiling under its former name, so an older
            # reader still finds a value here instead of a KeyError.
            "scale": scale_max,
        }
    # No source severity — fall back to the deterministic risk total (clearly flagged
    # as DERIVED, never claimed to be source-asserted).
    mag = max(0.0, min(100.0, float(case.risk_score)))
    return {
        "band": _severity_band_from_magnitude(mag),
        "value": round(mag, 2),
        "raw": None,
        "source": _SRC_DERIVED,
        "scale_max": DEFAULT_SEVERITY_SCALE_MAX,
        "scale": DEFAULT_SEVERITY_SCALE_MAX,
    }


def band_of_case(case: Case, prefs: Preferences | None = None) -> str:
    """THE advisory severity band for a case — the ONE helper every consumer calls.

    ``Case.severity_band`` is a READ-TIME presentation field: no production write path
    ever persists it (only the seeded demo corpus does), so a consumer that reads the
    attribute directly sees ``None`` on every real case and silently degrades — e.g. an
    attention-queue ranking whose severity term is then zero for the whole queue. This
    helper is the fix, and it is deliberately PUBLIC so no consumer has to re-derive the
    fallback chain:

    1. a band already PERSISTED on the case (the demo corpus, or a case already passed
       through the read-time projection) wins — it is what the operator is looking at;
    2. otherwise DERIVE it from the source-asserted severity against the source's
       declared ceiling (:func:`severity_band_from_events`, which needs ``prefs`` to
       resolve that ceiling and falls back to the deterministic risk total when the
       source never asserted a severity);
    3. otherwise ``"info"`` — the honest floor for "nothing said anything".

    ``prefs`` is OPTIONAL so every existing caller keeps working: with ``None`` the
    derivation still runs, on the identity ceiling. Total + FAIL-OPEN (bare except): a
    malformed case degrades to ``"info"`` and NEVER raises, because this feeds read-only
    presentation surfaces that must not 500. Advisory only — never read by
    ``case_manager.decide()`` (#3), and NOTHING here is persisted onto the case."""
    try:
        band = getattr(case, "severity_band", None)
        if band in SEVERITY_BANDS:
            return band
    except Exception:  # noqa: BLE001 — advisory only; never raise on a bad case
        pass
    try:
        derived = severity_band_from_events(case, prefs).get("band")
        if derived in SEVERITY_BANDS:
            return derived
    except Exception:  # noqa: BLE001 — advisory only; never raise on a bad case
        pass
    return _INFO


def impact_band(case: Case, prefs: Preferences) -> dict[str, Any]:
    """IMPACT band from the affected entity's ASSET CRITICALITY.

    Uses the SAME deterministic ``risk._asset_criticality`` the risk engine uses (so
    impact and the risk breakdown agree on what "critical asset" means), but surfaces
    it as a standalone advisory band rather than folding it into one risk number.
    Returns ``{band, value (0-100), criticality, entity}``."""
    entity_value = case.entity.value if case.entity else ""
    crit = _asset_criticality(entity_value, prefs) if entity_value else 0.0
    crit = max(0.0, min(100.0, float(crit)))
    return {
        "band": _band_from_magnitude(crit),
        "value": round(crit, 2),
        "criticality": round(crit, 2),
        "entity": entity_value,
    }


def urgency_band(case: Case, prefs: Preferences) -> dict[str, Any]:
    """URGENCY band — how pressing the situation is, from the deterministic risk score
    blended with the escalation flag.

    Urgency answers "how fast must someone act", which the deterministic ``risk_score``
    already captures (volume/velocity/reputation/diversity); an escalated case is
    treated as at least HIGH urgency. Returns ``{band, value (0-100), escalated}``.
    This is advisory: it never gates the decision."""
    mag = max(0.0, min(100.0, float(case.risk_score)))
    escalated = bool(case.escalation_level and case.escalation_level > 0)
    band = _band_from_magnitude(mag)
    if escalated and band != _HIGH:
        band = _HIGH
    return {"band": band, "value": round(mag, 2), "escalated": escalated}


def derive_priority(impact: str, urgency: str, matrix: PriorityMatrix) -> dict[str, Any]:
    """ITIL Impact×Urgency → P1..P4 lookup (ADVISORY ordering only) — THE ONE authority.

    Round 5 (bug #14): this is now the SINGLE source of truth for priority derivation.
    Both consumers — the triage chip (:func:`derive_triage`) and the shift report
    (:func:`app.engine.shift_report.derive_priority`, which delegates here) — call it,
    so they can never disagree on whether the matrix is enabled again.

    ``matrix.enabled`` gates the DERIVATION: when the operator has NOT enabled the ITIL
    priority grid, there is no effective priority (``level`` is ``None`` and
    ``enabled`` is ``False``) — the previous behaviour where the chip silently derived a
    P-level from a disabled matrix (while the shift report correctly showed none) was
    the bug. When enabled, ``"{impact}/{urgency}"`` is looked up in the operator's
    :class:`PriorityMatrix`, falling back to ``matrix.default_priority`` for any
    unmapped pair.

    Returns ``{level, enabled, impact, urgency, matched, default}`` where ``level`` is
    ``None`` when the matrix is disabled. Pure display/ordering — it MUST NEVER be
    passed to ``case_manager.decide()`` (a regression test pins decide()'s invariance)."""
    enabled = bool(getattr(matrix, "enabled", False))
    key = f"{impact}/{urgency}"
    raw = matrix.matrix.get(key)
    matched = raw is not None
    if not enabled:
        # Matrix disabled → NO effective priority (agreement with the shift report).
        level = None
    elif matched:
        level = raw
    else:
        level = matrix.default_priority
    return {
        "level": level,
        "enabled": enabled,
        "impact": impact,
        "urgency": urgency,
        "matched": matched,
        "default": matrix.default_priority,
    }


def derive_triage(case: Case, prefs: Preferences) -> dict[str, Any]:
    """Assemble the FOUR honestly-distinct advisory chips for a case in one shot.

    Returns a dict with ``risk`` (the existing 0-100 deterministic score + its
    breakdown — passed through, never recomputed here), ``severity`` (source),
    ``impact`` (asset criticality), and ``priority`` (the ITIL derivation), each with
    the inputs a UI HelpTip can show. Pure + defensive: a missing field degrades to a
    zero/low band, never raises. NONE of this is read by ``decide()`` (#3)."""
    severity = severity_band_from_events(case, prefs)
    impact = impact_band(case, prefs)
    urgency = urgency_band(case, prefs)
    priority = derive_priority(impact["band"], urgency["band"], prefs.priority_matrix)

    rb = case.risk_breakdown.model_dump(mode="json") if case.risk_breakdown else {}
    risk_chip = {
        "value": round(float(case.risk_score), 2),
        "band": _band_from_magnitude(max(0.0, min(100.0, float(case.risk_score)))),
        "breakdown": rb,
        "inputs": {
            "definition": (
                "Deterministic 0-100 risk score — a weighted blend of 5 factors: "
                "Volume (25%, how many events, log-normalised so it levels off ~50), "
                "Velocity (20%, events/min, full near 10/min, 0 below 3 events or a "
                "sub-second window), Reputation (30%, heaviest — worst threat-intel "
                "reputation among the cluster's IPs, 0 if no IP), Diversity (15%, "
                "distinct rule types, maxes at 5) and Asset criticality (10%, how "
                "important the targeted asset is; 0 if uncatalogued). The risk score "
                "only ranks what's investigated first — it never closes or escalates a "
                "case on its own."
            ),
        },
    }
    severity_chip = {
        **severity,
        "inputs": {
            "definition": (
                "The MAXIMUM severity the SOURCE asserted on the member events — the "
                "SIEM/EDR's own rating, not our computed risk."
            ),
            "severity_max": (case.trigger_reason.severity_max if case.trigger_reason else None),
            "severity_min": (case.trigger_reason.severity_min if case.trigger_reason else None),
        },
    }
    impact_chip = {
        **impact,
        "inputs": {
            "definition": (
                "How important the affected asset is, from the operator's asset-"
                "criticality map / internal-network policy."
            ),
            "entity_type": (case.entity.type.value if case.entity else ""),
            "entity_value": impact["entity"],
        },
    }
    priority_chip = {
        **priority,
        "urgency": urgency,
        "inputs": {
            "definition": (
                "ITIL priority = Impact × Urgency, looked up in the operator's priority "
                "matrix. ADVISORY ordering only — it never changes the verdict or the "
                "deterministic close/escalate decision."
            ),
            "impact_band": impact["band"],
            "urgency_band": urgency["band"],
            "matrix_enabled": prefs.priority_matrix.enabled,
        },
    }
    return {
        "risk": risk_chip,
        "severity": severity_chip,
        "impact": impact_chip,
        "priority": priority_chip,
    }


def advisory_bands(case: Case, prefs: Preferences | None = None) -> dict[str, Any]:
    """Read-time ADVISORY bands for the case PRESENTATION surfaces (list + detail).

    Returns the five FLAT presentation fields the case-list / case-detail render onto a
    :class:`app.models.Case`:

    * ``severity_band`` — 5-band {critical/high/medium/low/info} SOURCE-asserted severity.
    * ``severity_source`` — honest provenance: ``"source_asserted"``, ``"derived"`` (no
      source severity existed), or ``"source_out_of_range"`` (the raw value exceeded the
      source's declared ceiling, so the band is our clamped arithmetic, not the source's
      claim — the UI must not badge it as source-asserted).
    * ``impact_band`` — 3-band {high/medium/low} asset-criticality impact.
    * ``urgency_band`` — 3-band {high/medium/low} risk-blended urgency.
    * ``priority_level`` — the ITIL ``"P1".."P4"`` (or ``None`` when the matrix is off).

    Pure + FAIL-OPEN: any missing/malformed field degrades to ``None`` instead of raising,
    so a bad case can NEVER 500 the ``GET /api/cases`` endpoints. When ``prefs`` is None
    only the (prefs-free) severity axis is resolved; impact/urgency/priority need the
    operator's asset map + ITIL grid. NONE of this is read by ``case_manager.decide()``
    (#3) — it is derived AFTER the fact, purely for display/ordering."""
    out: dict[str, Any] = {
        "severity_band": None,
        "severity_source": None,
        "impact_band": None,
        "urgency_band": None,
        "priority_level": None,
    }
    try:
        sev = severity_band_from_events(case, prefs)
        out["severity_band"] = sev.get("band")
        out["severity_source"] = sev.get("source")
    except Exception:  # noqa: BLE001 — advisory only; never raise on a bad case
        pass
    if prefs is None:
        return out
    imp_band: str | None = None
    urg_band: str | None = None
    try:
        imp_band = impact_band(case, prefs).get("band")
        out["impact_band"] = imp_band
    except Exception:  # noqa: BLE001
        pass
    try:
        urg_band = urgency_band(case, prefs).get("band")
        out["urgency_band"] = urg_band
    except Exception:  # noqa: BLE001
        pass
    try:
        matrix = getattr(prefs, "priority_matrix", None)
        if matrix is not None and imp_band and urg_band:
            out["priority_level"] = derive_priority(imp_band, urg_band, matrix).get("level")
    except Exception:  # noqa: BLE001
        pass
    return out
