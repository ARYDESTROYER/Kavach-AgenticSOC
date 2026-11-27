"""P1 — the declared severity-ladder CONTRACT (offline, synthetic).

A raw severity number is meaningless without the ladder it was rated on: a 12 is
CRITICAL on a 0-16 ladder and LOW on a 0-100 one. The suite used to infer that ladder
from the number's own magnitude (``raw <= 10 ? raw*10 : raw``), which is not information
the number carries — it inflated a genuinely-low 0-100 score exactly as confidently as
it read a high 0-10 rating, and the two errors are indistinguishable from the value.

P1 replaces the inference with ONE operator-DECLARED number per source
(``config.SourceInstance.severity_scale_max``) projected through ONE shared formula
(``ocsf.model.project_severity_magnitude``)::

    magnitude = min(100, max(0, raw / scale_max * 100))

These tests pin the properties that formula must have, and the honesty obligations that
come with it:

* **Injectivity** — inside a declared ladder, distinct raws stay distinct, and the top of
  the scale is reached ONLY at the top of the scale. The retired guess failed this: it
  collapsed every raw above 10 onto the same reading.
* **The declaration is the only input** — not the connector type, not the source id, not
  a tag. A declared ceiling beats the shipped seed, and the same declaration on two
  different connector types produces the same band.
* **Saturation invalidates provenance** — a raw ABOVE the declared ceiling proves the
  declaration wrong, so the band stops being the source's claim and says so.
* **Fail-open** — an advisory derivation must never raise, and a malformed case must
  never 500 a read endpoint.
* **⛔ #3** — none of this reaches ``case_manager.decide()``. Pinned twice: the module is
  byte-identical, and its output is invariant to every band this file produces.

Everything here is synthetic: no rule name, index name, product name or number from any
real deployment. Offline (fake ES + mock LLM via the shared fixtures).
"""

from __future__ import annotations

import hashlib
import logging
import pathlib

import pytest

from app.config import (
    SEEDED_SCALE_SOURCE_TYPE,
    SEEDED_SEVERITY_SCALE_MAX,
    Preferences,
    SourceInstance,
)
from app.constants import (
    DEFAULT_SEVERITY_SCALE_MAX,
    CaseStatus,
    EntityType,
    IngestMode,
    SEVERITY_BANDS,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import priority as priority_mod
from app.engine.priority import (
    _normalise_severity,
    advisory_bands,
    band_of_case,
    severity_band_from_events,
    severity_scale_max_for_source,
)
from app.models import Case, Entity, TriggerReason
from app.ocsf.model import project_severity_magnitude


# --------------------------------------------------------------------------- #
# helpers — synthetic sources + cases, no vendor/rule/index names anywhere
# --------------------------------------------------------------------------- #
def _source(
    source_id: str,
    *,
    ceiling: float | None = None,
    source_type: SourceType = SourceType.ELASTICSEARCH,
    ingest_mode: IngestMode = IngestMode.PULL,
) -> SourceInstance:
    return SourceInstance(
        id=source_id,
        source_type=source_type,
        ingest_mode=ingest_mode,
        display_name=f"source {source_id}",
        severity_scale_max=ceiling,
    )


def _case(
    *,
    case_id: str = "case-p1",
    severity_max: float | None = None,
    source_id: str | None = None,
    risk: float = 30.0,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.50"),
        source_id=source_id,
        risk_score=risk,
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.8,
        status=CaseStatus.OPEN,
        trigger_reason=(
            None
            if severity_max is None
            else TriggerReason(rule_value="synthetic-rule", severity_max=severity_max)
        ),
    )


# --------------------------------------------------------------------------- #
# 1. INJECTIVITY — distinct raws inside a declared ladder stay distinct
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("ceiling", [7.0, 10.0, 16.0, 100.0, 1000.0])
def test_distinct_raws_inside_a_declared_ladder_give_distinct_magnitudes(ceiling: float) -> None:
    """N distinct raws spread over [0, C] must give N DISTINCT magnitudes.

    This is the property the retired magnitude guess could not hold. Under
    ``raw <= 10 ? raw*10 : raw`` every raw above 10 that a 0-10 reading would have
    saturated collapsed onto the SAME number — ``_normalise_severity(21, 0-10)`` and
    ``_normalise_severity(90, 0-10)`` were both 100, so two events an order of magnitude
    apart were indistinguishable. A linear projection against a declared ceiling is
    injective on its own domain by construction; this pins it so no future heuristic can
    re-introduce a flat region."""
    raws = [ceiling * i / 8.0 for i in range(9)]      # 0, C/8, ... , C
    mags = [project_severity_magnitude(r, ceiling) for r in raws]
    assert len(set(mags)) == len(raws), f"projection collapsed distinct raws: {mags}"
    assert mags == sorted(mags)                       # and strictly ordered


@pytest.mark.parametrize("ceiling", [7.0, 10.0, 16.0, 100.0, 1000.0])
def test_the_top_of_the_scale_is_reached_only_at_the_top_of_the_scale(ceiling: float) -> None:
    """100.0 must mean "the source rated this at its own maximum", and nothing else.

    Under the retired guess a raw of 10 on ANY unresolvable ladder read 100 — so the
    strongest signal the system has was routinely manufactured out of a mid-range value.
    """
    assert project_severity_magnitude(ceiling, ceiling) == 100.0
    for i in range(8):                                # every raw strictly below C
        raw = ceiling * i / 8.0
        assert project_severity_magnitude(raw, ceiling) < 100.0, raw


def test_the_same_raw_reads_differently_on_different_declared_ladders() -> None:
    """The ladder — not the number — decides the band. One raw, four honest answers."""
    raw = 12.0
    bands = {
        ceiling: severity_band_from_events(
            _case(severity_max=raw, source_id="s"),
            Preferences(sources=[_source("s", ceiling=ceiling)]),
        )["band"]
        for ceiling in (16.0, 100.0, 1000.0)
    }
    assert bands[16.0] == "critical"      # 12/16 -> 75.0
    assert bands[100.0] == "low"          # 12/100 -> 12.0
    assert bands[1000.0] == "info"        # 12/1000 -> 1.2
    assert len(set(bands.values())) == 3


def test_the_legacy_wrapper_projects_through_the_same_one_formula() -> None:
    """``_normalise_severity`` is a thin wrapper, not a second implementation."""
    for ceiling in (10.0, 16.0, 100.0, 1000.0):
        for raw in (0.0, 1.0, 7.5, 12.0, 99.0):
            assert _normalise_severity(raw, ceiling) == project_severity_magnitude(raw, ceiling)
    # An unresolvable ceiling degrades to the identity, never to a magnitude guess.
    assert _normalise_severity(8.0, None) == 8.0
    assert _normalise_severity(8.0, "not a ladder") == 8.0
    assert _normalise_severity(8.0, 0) == 8.0


# --------------------------------------------------------------------------- #
# 2. ROUTE LEVEL — two cases on ONE source band differently over HTTP
# --------------------------------------------------------------------------- #
def test_get_cases_bands_two_severities_on_one_source_differently(client) -> None:
    """The end-to-end read path must preserve the ladder, not flatten it.

    Two cases from the SAME configured pull source, whose only difference is the severity
    that source asserted, must come back from ``GET /api/cases`` with DIFFERENT bands. The
    source declares nothing, so both project through the identity — which is exactly the
    reading that makes 24 and 88 distinguishable. The retired guess left 24 and 88
    unscaled too, but it is pinned here at the ROUTE because this is the surface an
    analyst actually triages on, and because the read-time projection must resolve the
    ladder from the case's ``source_id`` against the stored Preferences."""
    state = client.app.state.tlsoc
    prefs = state.prefs.model_copy(update={"sources": [_source("pull-a")]})
    client.portal.call(state.update_prefs, prefs)

    client.portal.call(
        state.cases.save, _case(case_id="p1-lo", severity_max=24.0, source_id="pull-a")
    )
    client.portal.call(
        state.cases.save, _case(case_id="p1-hi", severity_max=88.0, source_id="pull-a")
    )

    body = client.get("/api/cases").json()
    rows = {c["case_id"]: c for c in body["cases"] if c["case_id"].startswith("p1-")}
    assert set(rows) == {"p1-lo", "p1-hi"}
    assert rows["p1-lo"]["severity_band"] != rows["p1-hi"]["severity_band"]
    assert rows["p1-lo"]["severity_band"] == "medium"      # 24 -> medium (>=22 cut)
    assert rows["p1-hi"]["severity_band"] == "critical"    # 88 -> critical (>=74 cut)
    # Both are the SOURCE's own claim — the provenance chip must say so honestly.
    assert rows["p1-lo"]["severity_source"] == "source_asserted"
    assert rows["p1-hi"]["severity_source"] == "source_asserted"


def test_get_cases_reflects_a_declared_ladder_over_http(client) -> None:
    """Declaring the source's ladder re-bands its cases on the next read — no migration.

    The band is derived at READ time from the stored declaration, so changing the
    declaration changes what the analyst sees WITHOUT rewriting a single case document.
    """
    state = client.app.state.tlsoc
    client.portal.call(
        state.update_prefs,
        state.prefs.model_copy(update={"sources": [_source("pull-b")]}),
    )
    client.portal.call(
        state.cases.save, _case(case_id="p1-decl", severity_max=8.0, source_id="pull-b")
    )

    def _band() -> str:
        rows = client.get("/api/cases").json()["cases"]
        return next(c for c in rows if c["case_id"] == "p1-decl")["severity_band"]

    assert _band() == "low"          # undeclared -> identity -> 8.0

    client.portal.call(
        state.update_prefs,
        state.prefs.model_copy(update={"sources": [_source("pull-b", ceiling=10.0)]}),
    )
    assert _band() == "critical"     # declared 0-10 -> 80.0, same stored case

    # The stored case was never mutated — the band is a response projection only.
    stored = client.portal.call(state.cases.get, "p1-decl")
    assert stored.severity_band is None


# --------------------------------------------------------------------------- #
# 3. THE DECLARATION IS THE ONLY INPUT — it beats the seed and ignores the type
# --------------------------------------------------------------------------- #
def test_a_declared_ceiling_beats_the_shipped_seed() -> None:
    """The seeded connector type must not override an operator's own declaration.

    The seed exists so the one connector the suite ships ladder knowledge of works out of
    the box. It is written into the source's OWN editable field at construction time and
    is never a runtime branch, so an operator running a customised rule set declares a
    different ceiling and keeps it — including one far outside anything the suite ships.

    Written against the seed CONSTANTS rather than against a literal connector and
    number, so the property holds if the seeded connector or its value ever changes, and
    so this file states no vendor ladder of its own."""
    seeded = _source("seeded", source_type=SEEDED_SCALE_SOURCE_TYPE)
    assert seeded.severity_scale_max == SEEDED_SEVERITY_SCALE_MAX   # seeded, undeclared

    other = SEEDED_SEVERITY_SCALE_MAX * 10.0                        # anything but the seed
    declared = _source("declared", source_type=SEEDED_SCALE_SOURCE_TYPE, ceiling=other)
    assert declared.severity_scale_max == other                     # the seed stood aside
    assert severity_scale_max_for_source(declared) == other

    # ...and the band follows the declaration. The SAME raw reads differently under the
    # seed, which is what proves the declaration — not the connector — decided it.
    raw = other / 2.0
    sev = severity_band_from_events(
        _case(severity_max=raw, source_id="declared"), Preferences(sources=[declared])
    )
    assert sev["scale_max"] == other
    assert sev["value"] == 50.0 and sev["band"] == "high"
    assert sev["source"] == "source_asserted"

    under_seed = severity_band_from_events(
        _case(severity_max=raw, source_id="seeded"), Preferences(sources=[seeded])
    )
    assert under_seed["scale_max"] == SEEDED_SEVERITY_SCALE_MAX
    assert under_seed["band"] != sev["band"]


def test_the_same_declaration_on_any_connector_type_reads_identically() -> None:
    """No read path branches on ``source_type``, ``ingest_mode`` or the source id.

    The ceiling is deliberately NOT the seeded value, so the seeded connector's row
    proves the DECLARATION drove the result and not the seed it would otherwise get."""
    ceiling = 25.0
    assert ceiling != SEEDED_SEVERITY_SCALE_MAX
    shapes = [
        _source("s", ceiling=ceiling, source_type=SEEDED_SCALE_SOURCE_TYPE,
                ingest_mode=IngestMode.PULL),
        _source("s", ceiling=ceiling, source_type=SourceType.ELASTICSEARCH,
                ingest_mode=IngestMode.PULL),
        _source("s", ceiling=ceiling, source_type=SourceType.GENERIC,
                ingest_mode=IngestMode.PUSH_HTTP),
    ]
    results = [
        severity_band_from_events(
            _case(severity_max=15.0, source_id="s"), Preferences(sources=[shape])
        )
        for shape in shapes
    ]
    assert all(r == results[0] for r in results)
    assert results[0]["scale_max"] == ceiling
    assert results[0]["value"] == 60.0 and results[0]["band"] == "high"


def test_an_undeclared_source_is_the_identity_whatever_its_type() -> None:
    """Undeclared MEANS the identity projection — the honest reading of an unlabelled number."""
    for source_type, mode in (
        (SourceType.ELASTICSEARCH, IngestMode.PULL),
        (SourceType.OPENSEARCH, IngestMode.PULL),
        (SourceType.GENERIC, IngestMode.PUSH_HTTP),
    ):
        inst = _source("u", source_type=source_type, ingest_mode=mode)
        assert severity_scale_max_for_source(inst) == DEFAULT_SEVERITY_SCALE_MAX
        sev = severity_band_from_events(
            _case(severity_max=8.0, source_id="u"), Preferences(sources=[inst])
        )
        assert sev["scale_max"] == DEFAULT_SEVERITY_SCALE_MAX
        assert sev["value"] == 8.0 and sev["band"] == "low"


# --------------------------------------------------------------------------- #
# 4. SATURATION — a raw above the ceiling invalidates the source's provenance
# --------------------------------------------------------------------------- #
def test_a_raw_above_the_declared_ceiling_loses_its_source_provenance(caplog) -> None:
    """Saturation is not a band, it is EVIDENCE THE DECLARATION IS WRONG.

    Once the projection clamps, the 100 the UI would show is our own arithmetic, not the
    source's claim, so the provenance token must stop saying ``source_asserted``. The band
    is still returned (a read surface must degrade, never fail), and one structured line
    names the source, its ceiling and the offending raw so the operator can correct it.
    """
    priority_mod._saturation_logged.clear()
    prefs = Preferences(sources=[_source("sat", ceiling=16.0)])
    case = _case(case_id="p1-sat", severity_max=20.0, source_id="sat")

    with caplog.at_level(logging.WARNING, logger="app.engine.priority"):
        sev = severity_band_from_events(case, prefs)

    assert sev["source"] == "source_out_of_range"
    assert sev["source"] != "source_asserted"
    assert sev["value"] == 100.0                 # clamped, never above the ceiling of the ladder
    assert sev["raw"] == 20.0                    # the offending value is reported verbatim
    assert sev["scale_max"] == 16.0
    assert sev["band"] in SEVERITY_BANDS         # a band is STILL returned

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    rendered = warnings[0].getMessage()
    assert "sat" in rendered and "16.0" in rendered and "20.0" in rendered


def test_the_saturation_notice_is_deduped_so_a_case_list_cannot_flood_the_log(caplog) -> None:
    """One misdeclared source must cost ONE line, not one line per case per request."""
    priority_mod._saturation_logged.clear()
    prefs = Preferences(sources=[_source("sat", ceiling=16.0)])

    with caplog.at_level(logging.WARNING, logger="app.engine.priority"):
        for i in range(25):
            severity_band_from_events(
                _case(case_id=f"p1-sat-{i}", severity_max=20.0 + i, source_id="sat"), prefs
            )

    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1


def test_the_saturation_dedupe_stops_logging_when_it_stops_remembering(caplog) -> None:
    """Past its cap the bounded set must go SILENT, not go unbounded-noisy.

    The dedupe set is bounded so it cannot grow without limit. The hazard is the
    combination: if the emit is gated only on the CAP while the key is recorded only
    below it, then at exactly the moment the set fills up every later render of the same
    case logs again — one WARNING per case per ``GET /api/cases``, which is the flood the
    mechanism exists to prevent. The emit is therefore gated on RECORDING the key."""
    priority_mod._saturation_logged.clear()
    try:
        for i in range(priority_mod._SATURATION_LOG_CAP):
            priority_mod._saturation_logged.add((f"other-{i}", 10.0))
        prefs = Preferences(sources=[_source("sat", ceiling=16.0)])

        with caplog.at_level(logging.WARNING, logger="app.engine.priority"):
            for i in range(50):
                severity_band_from_events(
                    _case(case_id=f"p1-cap-{i}", severity_max=20.0, source_id="sat"), prefs
                )

        assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 0
        # And the bound genuinely held — nothing was recorded past the cap.
        assert len(priority_mod._saturation_logged) == priority_mod._SATURATION_LOG_CAP
    finally:
        priority_mod._saturation_logged.clear()


def test_saturation_is_a_property_of_the_ceiling_not_of_the_value() -> None:
    """The SAME raw is in range or out of range depending only on the declaration."""
    case = _case(severity_max=20.0, source_id="s")
    out_of_range = severity_band_from_events(
        case, Preferences(sources=[_source("s", ceiling=16.0)])
    )
    in_range = severity_band_from_events(
        case, Preferences(sources=[_source("s", ceiling=100.0)])
    )
    assert out_of_range["source"] == "source_out_of_range"
    assert in_range["source"] == "source_asserted"
    assert in_range["value"] == 20.0 and in_range["band"] == "low"   # 8 <= 20 < 22
    # Exactly AT the ceiling is in range — the boundary belongs to the source.
    at_ceiling = severity_band_from_events(
        _case(severity_max=16.0, source_id="s"),
        Preferences(sources=[_source("s", ceiling=16.0)]),
    )
    assert at_ceiling["source"] == "source_asserted"
    assert at_ceiling["value"] == 100.0


def test_the_three_provenance_tokens_are_distinguishable() -> None:
    """``source_asserted`` / ``derived`` / ``source_out_of_range`` are three answers to
    "who graded this", and a consumer must be able to tell them apart."""
    priority_mod._saturation_logged.clear()
    prefs = Preferences(sources=[_source("s", ceiling=16.0)])
    asserted = severity_band_from_events(_case(severity_max=8.0, source_id="s"), prefs)
    derived = severity_band_from_events(_case(severity_max=None, risk=45.0, source_id="s"), prefs)
    saturated = severity_band_from_events(_case(severity_max=99.0, source_id="s"), prefs)
    tokens = {asserted["source"], derived["source"], saturated["source"]}
    assert tokens == {"source_asserted", "derived", "source_out_of_range"}
    # Only the source-asserted reading carries a raw the source actually stated.
    assert derived["raw"] is None and asserted["raw"] == 8.0


# --------------------------------------------------------------------------- #
# 5. CARRY-FORWARD — a bare re-upsert must not wipe the declaration
#    (the primary regression lives in tests/test_connectors_api.py; this pins the
#    OTHER shapes of the same "rebuild the SourceInstance from the body" hazard)
# --------------------------------------------------------------------------- #
def test_make_primary_and_repeated_toggles_preserve_the_declaration(client) -> None:
    """Every body shape that OMITS the ceiling must carry the stored value forward.

    ``upsert_source`` rebuilds the ``SourceInstance`` from the request body, so any field
    the editor does not resend is silently dropped — the exact defect Round 9 fixed for
    ``configured_secrets``. Wiping the ceiling would re-band every one of that source's
    cases against the identity on the next read, from a make-primary click.
    """
    body = {"id": "carry-1", "source_type": "elasticsearch", "display_name": "s", "config": {}}
    assert client.post("/api/sources", json={**body, "severity_scale_max": 16}).status_code == 200

    def _ceiling() -> float | None:
        rows = client.get("/api/sources").json()["sources"]
        return next(s for s in rows if s["id"] == "carry-1")["severity_scale_max"]

    assert _ceiling() == 16.0
    for shape in (
        {**body, "is_primary": True},          # make-primary
        {**body, "enabled": False},            # bulk disable
        {**body, "enabled": True},             # bulk re-enable
        {**body, "display_name": "renamed"},   # a plain rename from the editor
    ):
        assert client.post("/api/sources", json=shape).status_code == 200
        assert _ceiling() == 16.0, shape


# --------------------------------------------------------------------------- #
# 6. FAIL-OPEN — an advisory derivation never raises; a bad case never 500s
# --------------------------------------------------------------------------- #
class _ExplodingCase:
    """A case-shaped object whose every interesting attribute raises."""

    @property
    def trigger_reason(self):  # noqa: ANN201
        raise RuntimeError("boom")

    @property
    def severity_band(self):  # noqa: ANN201
        raise RuntimeError("boom")

    @property
    def risk_score(self):  # noqa: ANN201
        raise RuntimeError("boom")

    @property
    def source_id(self):  # noqa: ANN201
        raise RuntimeError("boom")


@pytest.mark.parametrize(
    "bad",
    [_ExplodingCase(), object(), None],
    ids=["exploding-properties", "bare-object", "none"],
)
def test_advisory_bands_never_raises_on_a_malformed_case(bad) -> None:
    """The five presentation fields must degrade to None, not propagate an exception."""
    for prefs in (None, Preferences(), Preferences(sources=[_source("s", ceiling=16.0)])):
        bands = advisory_bands(bad, prefs)
        assert set(bands) == {
            "severity_band", "severity_source", "impact_band", "urgency_band", "priority_level",
        }
        assert bands["severity_band"] is None
        assert bands["severity_source"] is None


@pytest.mark.parametrize(
    "bad",
    [_ExplodingCase(), object(), None],
    ids=["exploding-properties", "bare-object", "none"],
)
def test_band_of_case_fails_open_to_the_honest_floor(bad) -> None:
    """The public band helper answers ``info`` — "nothing said anything" — never raises."""
    assert band_of_case(bad) == "info"
    assert band_of_case(bad, Preferences()) == "info"


@pytest.mark.parametrize(
    "declaration",
    [None, "not a number", "", 0, -1, float("nan"), True, False, [], {}],
    ids=[
        "none", "text", "empty", "zero", "negative", "nan", "true", "false", "list", "dict",
    ],
)
def test_an_unusable_declaration_degrades_to_the_identity(declaration) -> None:
    """A garbage stored ceiling reads as UNDECLARED, and can never divide.

    Storage is fail-open on purpose: a hand-edited or legacy config carrying nonsense
    must not make Preferences unloadable, and must never reach the division. (The typed
    API boundary is strict instead — ``SourceUpsert`` rejects a non-positive ceiling with
    422; see tests/test_connectors_api.py.)

    ``True`` is in the set deliberately: a bool IS an ``int`` in Python, so an unguarded
    ceiling of ``True`` would divide by 1 and turn every severity into 100. The guard
    that stops it lives in ``resolve_severity_scale_max``, which every path through the
    resolver and through ``score_to_severity_id`` goes through first."""
    from types import SimpleNamespace

    inst = SimpleNamespace(id="s", severity_scale_max=declaration)
    assert severity_scale_max_for_source(inst) == DEFAULT_SEVERITY_SCALE_MAX
    # The same value handed to the band derivation reads as undeclared end to end.
    sev = severity_band_from_events(
        _case(severity_max=8.0, source_id="s"),
        Preferences.model_construct(sources=[inst], priority_matrix=None),
    )
    assert sev["scale_max"] == DEFAULT_SEVERITY_SCALE_MAX
    assert sev["value"] == 8.0


@pytest.mark.parametrize("declaration", [float("inf"), float("-inf"), float("nan")])
def test_a_non_finite_ceiling_is_rejected_as_firmly_as_a_zero_one(declaration) -> None:
    """``inf`` is not a ladder — and it is far more dangerous than ``0``.

    A zero ceiling is obviously unusable and every guard already caught it. ``inf``
    passes every ``> 0`` test, divides without raising, and would read EVERY severity from
    that source as ``0.0`` — Informational — while still labelling the band as the
    source's own claim. It would also serialize into the stored Preferences document as
    the non-standard JSON token ``Infinity``. It reads as UNDECLARED everywhere the
    guards run."""
    from types import SimpleNamespace

    from app.ocsf.model import resolve_severity_scale_max

    assert resolve_severity_scale_max(declaration) is None
    assert severity_scale_max_for_source(
        SimpleNamespace(id="s", severity_scale_max=declaration)
    ) == DEFAULT_SEVERITY_SCALE_MAX
    # Even handed straight to the bare projection it cannot silence a severity.
    assert project_severity_magnitude(100.0, declaration) == 100.0
    # And the stored model coerces it to "undeclared" rather than refusing to load.
    assert _source("s", ceiling=None).severity_scale_max is None
    assert SourceInstance.model_validate({
        "id": "s", "source_type": SourceType.ELASTICSEARCH.value,
        "ingest_mode": IngestMode.PULL.value, "severity_scale_max": declaration,
    }).severity_scale_max is None


def test_the_deprecated_string_aliases_are_byte_identical_including_at_the_cuts() -> None:
    """A back-compat arm may not move an answer by one ULP.

    The shared projection re-associates ``value * 10.0`` into ``value / 10.0 * 100.0``.
    IEEE-754 multiplication is not associative, so those are different doubles for some
    inputs — and a handful of them land exactly ON an OCSF cut one way and just below it
    the other, changing the returned ``severity_id``. The deprecated string arms
    therefore keep their ORIGINAL expressions. These seven inputs are the complete set
    that differed; each is a ``math.nextafter`` neighbour of a cut preimage."""
    import math

    from app.ocsf.model import score_to_severity_id

    # The re-associated arithmetic really does differ — this is the hazard, stated.
    assert 3.9999999999999996 * 10.0 == 39.99999999999999      # below the 40 cut
    assert 3.9999999999999996 / 10.0 * 100.0 == 40.0           # exactly ON it

    for alias in ("ocsf_0_100", "0-100", "0_100"):
        assert score_to_severity_id(14.999999999999998, alias) == 1     # not 2
    for alias in ("0_10", "0-10"):
        assert score_to_severity_id(3.9999999999999996, alias) == 2     # not 3
        assert score_to_severity_id(6.999999999999999, alias) == 3      # not 4

    # ...and the surviving "auto" arm is untouched, as is the 0-16 alias (whose original
    # expression WAS the shared one).
    assert score_to_severity_id(8.0, "auto") == 4
    assert score_to_severity_id(12.0, "wazuh_0_16") == 4

    # Property: across every alias, at every ULP neighbourhood of every cut preimage, the
    # id is unchanged from the per-alias arithmetic it replaced.
    def legacy(score, scale):
        s = float(score)
        if s <= 0:
            return 1
        if scale in ("ocsf_0_100", "0-100", "0_100"):
            pass
        elif scale in ("0_10", "0-10"):
            s = s * 10.0
        elif scale == "wazuh_0_16":
            s = s / 16.0 * 100.0
        elif s <= 10:
            s = s * 10.0
        return 5 if s >= 90 else 4 if s >= 70 else 3 if s >= 40 else 2 if s >= 15 else 1

    values = [0.5, 1.0, 5.0, 8.0, 10.0, 12.0, 16.0, 50.0, 100.0, 1000.0]
    for ceiling in (1.0, 10.0, 16.0, 100.0):
        for cut in (15, 40, 70, 90):
            pre = cut * ceiling / 100.0
            for k in range(-3, 4):
                v = pre
                for _ in range(abs(k)):
                    v = math.nextafter(v, math.inf if k > 0 else -math.inf)
                values.append(v)
    for alias in ("auto", "unknown", "ocsf_0_100", "0-100", "0_100", "0_10", "0-10",
                  "wazuh_0_16"):
        for v in values:
            assert score_to_severity_id(v, alias) == legacy(v, alias), (alias, repr(v))


def test_there_is_exactly_one_declaration_TIER_so_read_and_write_cannot_disagree() -> None:
    """A source's ceiling is declared per SOURCE, and nowhere else.

    A global ``Preferences``-level ceiling would be readable by the case chip (which has
    ``prefs`` in hand) but INVISIBLE to the ingest-side surfaces, which resolve the
    ceiling from the event's own source instance: the durable Noise-Reduction counters,
    the OCSF ``severity_id`` a normaliser stamps, and a feed's ``severity_floor`` gate.
    The same raw number would then read ``critical`` on the case and ``low`` in the
    funnel — and the counters are bucketed by band at WRITE time, so that split could
    never be re-projected. One tier, read identically everywhere."""
    assert "severity_scale_max" not in Preferences.model_fields
    assert "severity_scale_max" in SourceInstance.model_fields

    # Same raw, same source, zero-config profile: chip and ingest ceiling agree.
    from app.engine.noise_counters import count_events_by_band, severity_scale_for_source
    from app.models import RawEvent

    prefs = Preferences()
    assert prefs.source_by_id("anything") is None
    ingest_ceiling = severity_scale_for_source(prefs.source_by_id("anything"))
    chip = severity_band_from_events(_case(severity_max=8.0, source_id="anything"), prefs)
    assert ingest_ceiling == chip["scale_max"] == DEFAULT_SEVERITY_SCALE_MAX
    event = RawEvent(id="e", timestamp="2026-01-01T00:00:00Z", severity=8.0,
                     source_id="anything", raw={})
    bands = count_events_by_band([event], ingest_ceiling)
    assert bands[chip["band"]] == 1


def test_the_bool_guard_lives_in_the_resolver_that_every_call_path_uses() -> None:
    """``project_severity_magnitude`` is guarded by its callers, not by itself.

    The raw projection accepts any float-able ceiling, and ``float(True) == 1.0``, so a
    bool reaching it directly would inflate every severity to 100. Both in-repo call
    sites (``priority._normalise_severity`` and ``ocsf.score_to_severity_id``) resolve
    the ceiling through ``resolve_severity_scale_max`` first, which rejects bools
    explicitly. This test states that division of responsibility exactly, so a future
    direct caller of the projection knows it must resolve first."""
    from app.ocsf.model import resolve_severity_scale_max, score_to_severity_id

    assert resolve_severity_scale_max(True) is None      # the guard that protects everyone
    assert resolve_severity_scale_max(False) is None
    # Guarded paths: a bool reads as undeclared.
    assert _normalise_severity(8.0, True) == 8.0
    assert score_to_severity_id(8, True) == score_to_severity_id(8, "auto")
    # UNGUARDED path: the bare projection would divide by 1 — documented, not endorsed.
    assert project_severity_magnitude(8.0, True) == 100.0


def test_a_source_whose_attribute_access_raises_still_cannot_500_a_read() -> None:
    """The fail-open guarantee lives at the READ SURFACE, which is where it must hold.

    ``severity_scale_max_for_source`` reads the declaration with ``getattr``, so a
    pathological source object whose attribute access RAISES propagates out of the
    resolver (unreachable with a real ``SourceInstance``, which is a Pydantic model, but
    worth stating precisely rather than over-claiming). What must never break is the
    presentation surface: ``advisory_bands`` — the function ``GET /api/cases`` and
    ``/api/cases/{id}`` call — swallows it and degrades every axis to ``None``.
    """

    class _ExplodingSource:
        id = "s"

        @property
        def severity_scale_max(self):  # noqa: ANN201
            raise RuntimeError("boom")

    prefs = Preferences.model_construct(sources=[_ExplodingSource()], priority_matrix=None)
    case = _case(severity_max=8.0, source_id="s")

    # The resolver itself is NOT total against a raising property — pinned honestly.
    with pytest.raises(RuntimeError):
        severity_band_from_events(case, prefs)

    # ...but the read surface is, which is the property that actually protects the route.
    bands = advisory_bands(case, prefs)
    assert bands["severity_band"] is None
    assert bands["severity_source"] is None
    assert band_of_case(case, prefs) == "info"


def test_get_cases_stays_200_when_the_ladder_resolution_raises(client, monkeypatch) -> None:
    """A bad case can NEVER 500 ``GET /api/cases`` — pinned at the HTTP boundary.

    The fail-open is asserted with the failure injected INSIDE ``priority`` (where a real
    malformed source/case would raise), not at the route's own call site, so the guard
    being tested is the one the derivation actually owns."""
    state = client.app.state.tlsoc
    client.portal.call(
        state.cases.save, _case(case_id="p1-boom", severity_max=8.0, source_id="whatever")
    )

    def _boom(*_a, **_k):  # noqa: ANN002, ANN003
        raise RuntimeError("boom")

    monkeypatch.setattr(priority_mod, "_scale_max_for_case", _boom)
    res = client.get("/api/cases")
    assert res.status_code == 200
    row = next(c for c in res.json()["cases"] if c["case_id"] == "p1-boom")
    assert row["severity_band"] is None


# --------------------------------------------------------------------------- #
# 7. ⛔ #3 — decide() is untouched, and invariant to every band above
# --------------------------------------------------------------------------- #
def test_case_manager_module_is_byte_identical() -> None:
    """``engine/case_manager.py`` is the deterministic close/escalate authority (#3).

    P1 touches the ADVISORY read layer only, so the decision module must not have moved
    a single byte. Pinned by content hash rather than by behaviour because a behavioural
    test cannot prove that no new import, no new branch and no new input was added."""
    path = pathlib.Path(priority_mod.__file__).with_name("case_manager.py")
    digest = hashlib.md5(path.read_bytes()).hexdigest()   # noqa: S324 — integrity, not crypto
    assert digest == "212873cd13d822a7b64752635285ff1f", (
        "engine/case_manager.py changed — the P1 severity ladder is ADVISORY and must "
        "never reach decide() (#3)."
    )


def test_case_manager_has_no_import_edge_into_the_advisory_ladder() -> None:
    """decide() cannot consume what it cannot see: no import reaches the band layer.

    Checked over the parsed IMPORT statements rather than the raw text, so ordinary prose
    in a comment ("priority human attention") is not mistaken for a dependency, and so a
    renamed alias cannot smuggle the module in."""
    import ast

    path = pathlib.Path(priority_mod.__file__).with_name("case_manager.py")
    tree = ast.parse(path.read_text(encoding="utf-8"))

    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            for alias in node.names:
                imported.add(f"{node.module or ''}.{alias.name}")

    banned = ("priority", "ocsf", "noise_counters", "shift_report")
    offenders = [m for m in imported for b in banned if b in m]
    assert not offenders, f"case_manager.py imports the advisory layer: {offenders}"

    # And no advisory SYMBOL is referenced by name anywhere in the module body.
    names = {
        n.id for n in ast.walk(tree) if isinstance(n, ast.Name)
    } | {
        n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
    }
    for symbol in (
        "severity_band", "severity_band_from_events", "advisory_bands", "band_of_case",
        "severity_scale_max", "project_severity_magnitude", "severity_scale_max_for_source",
    ):
        assert symbol not in names, f"case_manager.py references {symbol!r}"


def test_decide_is_invariant_to_every_severity_band_this_ladder_can_produce() -> None:
    """Same (verdict, confidence, risk, policy) -> same decision, whatever the band.

    Four cases that resolve to four DIFFERENT bands (and three different provenance
    tokens) are derived between two identical ``decide()`` calls; the decision must be
    byte-identical, because it is a pure function of inputs the ladder is not one of."""
    from app.engine.case_manager import decide

    priority_mod._saturation_logged.clear()
    prefs = Preferences(sources=[_source("s", ceiling=16.0)])
    args = (Verdict.TRUE_POSITIVE, 0.8, 30.0, prefs.auto_close)
    kwargs = {
        "escalation_confidence": prefs.escalation_confidence,
        "critical_severity": prefs.critical_severity,
    }
    before = decide(*args, **kwargs)

    derivations = [
        severity_band_from_events(_case(severity_max=1.0, source_id="s"), prefs),
        severity_band_from_events(_case(severity_max=12.0, source_id="s"), prefs),
        severity_band_from_events(_case(severity_max=99.0, source_id="s"), prefs),
        severity_band_from_events(_case(severity_max=None, risk=45.0, source_id="s"), prefs),
    ]
    bands = {d["band"] for d in derivations}
    assert len(bands) >= 3, f"the fixture must exercise genuinely different bands: {bands}"
    assert {d["source"] for d in derivations} == {
        "source_asserted", "source_out_of_range", "derived",
    }

    after = decide(*args, **kwargs)
    assert after == before


def test_deriving_a_band_never_mutates_the_case_it_read() -> None:
    """The ladder is READ-TIME: nothing it computes is persisted onto the case (#3, §1.4)."""
    prefs = Preferences(sources=[_source("s", ceiling=16.0)])
    case = _case(severity_max=12.0, source_id="s")
    snapshot = case.model_dump(mode="json")

    severity_band_from_events(case, prefs)
    advisory_bands(case, prefs)
    band_of_case(case, prefs)

    assert case.model_dump(mode="json") == snapshot
    assert case.severity_band is None
    assert case.priority_level is None
