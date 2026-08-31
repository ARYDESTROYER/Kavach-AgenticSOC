"""Round 7 / W0.7 — severity ladder + read-time advisory bands.

Covers the new 5-band SEVERITY ladder (``priority._severity_band_from_magnitude``,
mirroring the webui ``badges.tsx::severityBandFromNumber`` EXACTLY: 74/48/22/8), the
3-band 48/22 impact/urgency projection (``priority._band_from_magnitude``), the pure
``priority.advisory_bands`` derivation, and the READ-TIME population of the five
advisory fields on ``GET /api/cases`` + ``/api/cases/{id}``.

⛔ NON-NEGOTIABLE #3: none of these advisory bands ever feeds ``case_manager.decide()``.
They are derived AFTER the fact, purely for display / ordering. Offline: fake ES +
mock LLM via the shared ``app_state`` fixture.
"""

from __future__ import annotations

import pytest

from app.config import Preferences, PriorityMatrix, SourceInstance
from app.constants import CaseStatus, EntityType, SourceSurface, SourceType, Verdict
from app.engine.priority import (
    _band_from_magnitude,
    _severity_band_from_magnitude,
    advisory_bands,
    severity_band_from_events,
)
from app.models import Case, Entity, TriggerReason


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
DECLARED_SOURCE_ID = "src-0-10"


def _declared_source(ceiling: float = 10.0, source_id: str = DECLARED_SOURCE_ID) -> SourceInstance:
    """A source that DECLARES its native severity-ladder ceiling.

    One number describes any native ladder, so these tests can pin a raw 8 as a
    source-asserted CRITICAL without depending on the connector type or on the retired
    ``raw <= 10 ? raw*10`` magnitude guess. Cases must carry the matching ``source_id``
    for the declaration to resolve."""
    return SourceInstance(
        id=source_id,
        source_type=SourceType.ELASTICSEARCH,
        display_name="declared native ladder",
        severity_scale_max=ceiling,
    )


def _case(
    *,
    case_id: str = "case-w07",
    ip: str = "203.0.113.50",
    risk: float = 72.0,
    severity_max: float | None = 8.0,
    escalation_level: int = 0,
    source_id: str | None = None,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=ip),
        risk_score=risk,
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.8,
        status=CaseStatus.OPEN,
        escalation_level=escalation_level,
        source_id=source_id,
        trigger_reason=(
            None
            if severity_max is None
            else TriggerReason(rule_value="r", severity_max=severity_max)
        ),
    )


# --------------------------------------------------------------------------- #
# 5-band SEVERITY ladder — mirrors badges.tsx::severityBandFromNumber EXACTLY
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("mag", "band"),
    [
        (100.0, "critical"),
        (74.0, "critical"),   # >= 74 critical cut
        (73.99, "high"),
        (48.0, "high"),       # >= 48 high cut
        (47.99, "medium"),
        (22.0, "medium"),     # >= 22 medium cut
        (21.99, "low"),
        (8.0, "low"),         # >= 8 low cut
        (7.99, "info"),
        (0.0, "info"),        # sub-8 magnitude reads INFO, not a low alert
    ],
)
def test_severity_band_5band_cuts_mirror_badges(mag: float, band: str) -> None:
    assert _severity_band_from_magnitude(mag) == band


@pytest.mark.parametrize(
    ("mag", "band"),
    [
        (100.0, "high"),
        (48.0, "high"),      # 3-band shares the 48 high cut
        (47.99, "medium"),
        (22.0, "medium"),    # 3-band shares the 22 medium cut
        (21.99, "low"),
        (0.0, "low"),        # no info band on the impact/urgency axis
    ],
)
def test_impact_urgency_3band_cuts(mag: float, band: str) -> None:
    assert _band_from_magnitude(mag) == band


# --------------------------------------------------------------------------- #
# advisory_bands — the five flat presentation fields
# --------------------------------------------------------------------------- #
def test_advisory_bands_returns_five_fields() -> None:
    prefs = Preferences(
        asset_criticality={"203.0.113.50": 90.0},
        priority_matrix=PriorityMatrix(enabled=True),
        sources=[_declared_source(10.0)],
    )
    bands = advisory_bands(
        _case(risk=72.0, severity_max=8.0, source_id=DECLARED_SOURCE_ID), prefs
    )
    assert set(bands) == {
        "severity_band",
        "severity_source",
        "impact_band",
        "urgency_band",
        "priority_level",
    }
    # severity_max 8.0 on the source's DECLARED 0-10 ladder -> 8/10*100 = 80 -> critical,
    # source-asserted.
    assert bands["severity_band"] == "critical"
    assert bands["severity_source"] == "source_asserted"
    # asset criticality 90 -> high impact; risk 72 -> high urgency; high/high -> P1.
    assert bands["impact_band"] == "high"
    assert bands["urgency_band"] == "high"
    assert bands["priority_level"] == "P1"


def test_advisory_bands_severity_source_flip() -> None:
    prefs = Preferences()
    # A source-asserted severity flags source_asserted — whatever ladder resolves, the
    # PROVENANCE is about who produced the number, not about how it was projected.
    asserted = advisory_bands(_case(severity_max=8.0), prefs)
    assert asserted["severity_source"] == "source_asserted"
    # No source severity -> DERIVED from the deterministic risk total.
    derived = advisory_bands(_case(severity_max=None, risk=45.0), prefs)
    assert derived["severity_source"] == "derived"
    assert derived["severity_band"] == "medium"   # risk 45 -> medium (5-band)


def test_an_unconfigured_source_is_the_identity_ladder_with_no_id_allowlist() -> None:
    """The hardcoded demo-source-id frozenset is GONE, and the default replaced it.

    That allowlist existed for exactly one reason: to force a known set of ids onto the
    identity projection, because the fallback for everything else was the
    ``raw <= 10 ? raw*10`` magnitude guess. UNDECLARED now MEANS the identity projection,
    so the special case became the default and the id list could be deleted — which also
    fixed the demo id the stale frozenset had omitted and removed a hardcoded id list
    from a vendor-agnostic engine.

    Pinned as an EQUIVALENCE, not as a value, so a re-introduced allowlist would fail
    this test: an id that was on the old list, one that was missing from it, and an
    arbitrary id must all resolve identically, with or without a ``demo`` tag.
    """
    prefs = Preferences()          # nothing configured -> nothing to resolve, for any id
    baseline = severity_band_from_events(_case(severity_max=10.0, source_id="ordinary"), prefs)
    assert baseline["scale_max"] == 100.0
    assert baseline["value"] == 10.0
    assert baseline["band"] == "low"

    for source_id in ("demo-wazuh", "demo-splunk", "demo-entra-id", "demo-qradar"):
        case = _case(severity_max=10.0, source_id=source_id)
        assert severity_band_from_events(case, prefs) == baseline, source_id
        case.tags = ["demo"]
        assert severity_band_from_events(case, prefs) == baseline, source_id


def test_a_configured_source_keeps_its_declared_ladder_whatever_its_id_looks_like() -> None:
    """A configured source's DECLARED ceiling is the only input — its id is inert.

    An id that merely LOOKS like a demo id used to be a real hazard, because the retired
    allowlist matched on the id string. Now the id is not consulted at all: two sources
    that differ only in their id resolve identically."""
    declared = severity_band_from_events(
        _case(severity_max=10.0, source_id="demo-wazuh"),
        Preferences(sources=[_declared_source(16.0, source_id="demo-wazuh")]),
    )
    assert declared["scale_max"] == 16.0
    assert declared["value"] == pytest.approx(62.5, abs=0.01)

    neutral = severity_band_from_events(
        _case(severity_max=10.0, source_id="prod-sensor"),
        Preferences(sources=[_declared_source(16.0, source_id="prod-sensor")]),
    )
    assert neutral["value"] == declared["value"]
    assert neutral["band"] == declared["band"]
    assert neutral["scale_max"] == declared["scale_max"]


def test_an_incidental_demo_tag_cannot_steer_a_declared_ladder() -> None:
    """An analyst-authored tag is not an isolation invariant and must not pick a ladder."""
    prefs = Preferences(sources=[_declared_source(16.0, source_id="prod-sensor")])
    untagged = severity_band_from_events(_case(severity_max=10.0, source_id="prod-sensor"), prefs)
    tagged_case = _case(severity_max=10.0, source_id="prod-sensor")
    tagged_case.tags = ["demo"]
    assert severity_band_from_events(tagged_case, prefs) == untagged
    assert untagged["scale_max"] == 16.0
    assert untagged["value"] == pytest.approx(62.5, abs=0.01)


def test_advisory_bands_priority_none_when_matrix_disabled() -> None:
    # A DISABLED matrix -> no effective priority level (agrees with #14). (Autopilot
    # overhaul flipped the DEFAULT to ON; pin it OFF here to exercise the disabled path.)
    prefs = Preferences(asset_criticality={"203.0.113.50": 90.0})
    prefs.priority_matrix.enabled = False
    bands = advisory_bands(_case(risk=72.0, severity_max=8.0), prefs)
    assert bands["impact_band"] == "high"
    assert bands["urgency_band"] == "high"
    assert bands["priority_level"] is None


def test_advisory_bands_no_prefs_resolves_only_severity() -> None:
    """prefs=None -> only the (prefs-free) severity axis resolves; the rest stay None.

    With no Preferences there is no source to resolve, so the severity axis falls back to
    the IDENTITY ceiling and reads the raw number as-is. That is the honest answer, and
    it is the SAME answer the declared path gives once a ladder exists — the second half
    below proves the difference is the declaration and nothing else."""
    bands = advisory_bands(_case(severity_max=8.0), None)
    assert bands["severity_source"] == "source_asserted"
    assert bands["severity_band"] == "low"        # 8/100 -> low, no magnitude guess
    assert bands["impact_band"] is None
    assert bands["urgency_band"] is None
    assert bands["priority_level"] is None

    # The SAME case, once its source declares a 0-10 ladder, reads CRITICAL — so the
    # prefs-free reading above is a missing declaration, never a lost provenance.
    declared = advisory_bands(
        _case(severity_max=8.0, source_id=DECLARED_SOURCE_ID),
        Preferences(sources=[_declared_source(10.0)]),
    )
    assert declared["severity_band"] == "critical"
    assert declared["severity_source"] == "source_asserted"


_FIVE_KEYS = {
    "severity_band",
    "severity_source",
    "impact_band",
    "urgency_band",
    "priority_level",
}


def test_advisory_bands_degrades_on_edge_values() -> None:
    # Edge case: no trigger_reason, zero risk, uncatalogued entity — must degrade cleanly.
    prefs = Preferences(priority_matrix=PriorityMatrix(enabled=True))
    bands = advisory_bands(_case(severity_max=None, risk=0.0), prefs)
    assert set(bands) == _FIVE_KEYS
    assert bands["severity_band"] == "info"       # risk 0 -> derived info
    assert bands["severity_source"] == "derived"


def test_advisory_bands_fail_open_when_internal_raises(monkeypatch) -> None:
    # If an internal axis derivation blows up, advisory_bands swallows it: the axis reads
    # None while the others still resolve — it NEVER propagates the exception (never 500).
    import app.engine.priority as priority_mod

    def _boom(*_a, **_k):  # noqa: ANN002, ANN003
        raise RuntimeError("boom")

    monkeypatch.setattr(priority_mod, "impact_band", _boom)
    prefs = Preferences(
        asset_criticality={"203.0.113.50": 90.0},
        priority_matrix=PriorityMatrix(enabled=True),
        sources=[_declared_source(10.0)],
    )
    bands = advisory_bands(
        _case(risk=72.0, severity_max=8.0, source_id=DECLARED_SOURCE_ID), prefs
    )
    assert set(bands) == _FIVE_KEYS
    assert bands["severity_band"] == "critical"   # severity axis still resolves
    assert bands["impact_band"] is None           # the raising axis degrades to None
    # priority needs impact -> also None (no impact band to look up).
    assert bands["priority_level"] is None


# --------------------------------------------------------------------------- #
# routes — GET /api/cases + /api/cases/{id} populate the advisory bands
# --------------------------------------------------------------------------- #
async def test_list_cases_populates_advisory_bands(app_state) -> None:
    from app.api.routes import list_cases

    state = app_state
    prefs = state.prefs.model_copy(update={
        "asset_criticality": {"203.0.113.50": 90.0},
        "priority_matrix": PriorityMatrix(enabled=True),
        "sources": [_declared_source(10.0)],
    })
    await state.update_prefs(prefs)
    await state.cases.save(_case(
        case_id="case-list-1", risk=72.0, severity_max=8.0, source_id=DECLARED_SOURCE_ID,
    ))

    res = await list_cases(state=state, from_=None, to=None)
    case = next(c for c in res.cases if c.case_id == "case-list-1")
    assert case.severity_band == "critical"
    assert case.severity_source == "source_asserted"
    assert case.impact_band == "high"
    assert case.urgency_band == "high"
    assert case.priority_level == "P1"


async def test_get_case_populates_advisory_bands(app_state) -> None:
    from app.api.routes import get_case

    state = app_state
    prefs = state.prefs.model_copy(update={
        "asset_criticality": {"203.0.113.50": 90.0},
        "priority_matrix": PriorityMatrix(enabled=True),
        "sources": [_declared_source(10.0)],
    })
    await state.update_prefs(prefs)
    await state.cases.save(_case(
        case_id="case-get-1", risk=72.0, severity_max=8.0, source_id=DECLARED_SOURCE_ID,
    ))

    case = await get_case("case-get-1", state=state)
    assert case.severity_band == "critical"
    assert case.impact_band == "high"
    assert case.priority_level == "P1"


async def test_read_time_bands_never_mutate_the_stored_case(app_state) -> None:
    # The advisory bands are a model_copy on the RESPONSE only — the stored case stays
    # clean (default None) so nothing downstream (or decide()) ever sees them.
    from app.api.routes import get_case

    state = app_state
    await state.cases.save(_case(case_id="case-clean", risk=72.0, severity_max=8.0))
    await get_case("case-clean", state=state)
    stored = await state.cases.get("case-clean")
    assert stored.severity_band is None
    assert stored.priority_level is None


async def test_get_case_is_fail_open_when_derivation_raises(app_state, monkeypatch) -> None:
    # If band derivation blows up, the endpoint must still return 200 with the case
    # (bands unpopulated) — a malformed case can never 500 the endpoint.
    import app.api.routes as routes_mod

    state = app_state
    await state.cases.save(_case(case_id="case-boom", risk=72.0, severity_max=8.0))

    def _boom(_case_arg, _prefs):  # noqa: ANN001
        raise RuntimeError("boom")

    monkeypatch.setattr(routes_mod, "advisory_bands", _boom)
    case = await routes_mod.get_case("case-boom", state=state)
    assert case.case_id == "case-boom"
    assert case.severity_band is None        # derivation swallowed -> unchanged case


# --------------------------------------------------------------------------- #
# ⛔ #3 — the read-time bands never change the deterministic decision
# --------------------------------------------------------------------------- #
def test_advisory_bands_invariant_to_decide() -> None:
    from app.engine.case_manager import decide

    prefs = Preferences(priority_matrix=PriorityMatrix(enabled=True))
    base = decide(Verdict.TRUE_POSITIVE, 0.8, 72.0, prefs.auto_close,
                  escalation_confidence=prefs.escalation_confidence,
                  critical_severity=prefs.critical_severity)
    advisory_bands(_case(risk=72.0, severity_max=8.0), prefs)   # derive (side-effect free)
    again = decide(Verdict.TRUE_POSITIVE, 0.8, 72.0, prefs.auto_close,
                   escalation_confidence=prefs.escalation_confidence,
                   critical_severity=prefs.critical_severity)
    assert again == base
