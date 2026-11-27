"""P1 consumers — the ONE advisory-band helper, its seven readers, and the ingest scale.

``Case.severity_band`` is a READ-TIME presentation field: no production write path
persists it (only the seeded demo corpus does), so every consumer that read the
attribute directly was reading ``None``. These tests pin the fix:

* :func:`app.engine.priority.band_of_case` is THE public helper (prefer-persisted →
  derive → ``info``, bare-except fail-open);
* the shift-report attention queue ranks on a RESOLVED severity band (the severity term
  of :func:`app.engine.shift_report.urgency_score` used to be 0.0 for every real case);
* the Elastic connector's ``severity_floor`` gate maps a raw severity through the
  source's DECLARED ceiling instead of the retired magnitude guess;
* the durable noise counters stamp the resolved ceiling on the ``by_source`` sub-block
  ONLY, keeping the pooled per-hour totals byte-identical;
* the agent-improvement endpoint refuses to compare per-band splits that cannot be shown
  to come from one ladder, and reports band-INDEPENDENT totals either way.

⛔ NON-NEGOTIABLE #3: nothing here feeds ``case_manager.decide()`` — every value is
advisory display / ordering / accounting. Fully offline.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.api.routes_metrics import (
    _counter_band_total,
    _severity_band_comparison,
)
from app.config import IndexPattern, Preferences, SourceInstance
from app.connectors.elastic import ElasticConnector
from app.constants import (
    CaseStatus,
    EntityType,
    IndexRole,
    IngestMode,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import shift_report
from app.engine.agent_improvement import _alert_volume
from app.engine.priority import band_of_case
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, RawEvent, TriggerReason
from app.stores.noise_counters import NoiseCounterStore, _merge_delta, _norm_bucket


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _case(
    *,
    case_id: str = "case-p1",
    risk: float = 10.0,
    severity_max: float | None = None,
    severity_band: str | None = None,
    source_id: str | None = None,
    age_minutes: float = 5.0,
    verdict: Verdict = Verdict.NEEDS_HUMAN,
    status: CaseStatus = CaseStatus.OPEN,
) -> Case:
    created = datetime.now(timezone.utc) - timedelta(minutes=age_minutes)
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        risk_score=risk,
        status=status,
        verdict=verdict,
        severity_band=severity_band,
        source_id=source_id,
        created_at=created.isoformat(),
        trigger_reason=(
            None
            if severity_max is None
            else TriggerReason(rule_value="r", severity_max=severity_max)
        ),
    )


def _prefs_with_source(ceiling: float | None) -> Preferences:
    return Preferences(
        setup_complete=True,
        sources=[
            SourceInstance(
                id="src-a",
                source_type=SourceType.ELASTICSEARCH,
                ingest_mode=IngestMode.PULL,
                severity_scale_max=ceiling,
            )
        ],
    )


class _MemKV:
    """The minimal KVStore surface ``NoiseCounterStore`` uses (offline)."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict] = {}

    async def get(self, ns: str, key: str):
        return self.docs.get((ns, key))

    async def put(self, ns: str, key: str, value: dict) -> None:
        self.docs[(ns, key)] = value

    async def put_if(self, ns: str, key: str, value: dict, rev=None) -> bool:
        self.docs[(ns, key)] = value
        return True

    async def delete(self, ns: str, key: str) -> None:
        self.docs.pop((ns, key), None)


# --------------------------------------------------------------------------- #
# (a) band_of_case — THE one helper
# --------------------------------------------------------------------------- #
def test_band_of_case_prefers_a_persisted_band() -> None:
    case = _case(severity_band="critical", risk=1.0)
    assert band_of_case(case, None) == "critical"


def test_band_of_case_derives_when_nothing_is_persisted() -> None:
    # No persisted band and no source severity → derived from the deterministic risk
    # total (90 → critical on the 74/48/22/8 advisory ladder).
    assert band_of_case(_case(risk=90.0), None) == "critical"


def test_band_of_case_rejects_an_unrecognised_persisted_band() -> None:
    """A log/attacker-influenced band string is never trusted as a band (#9)."""
    case = _case(severity_band="; DROP TABLE", risk=90.0)
    assert band_of_case(case, None) == "critical"  # derived, NOT the junk string


def test_band_of_case_uses_the_declared_source_ceiling() -> None:
    case = _case(severity_max=8.0, source_id="src-a")
    # Declared 0-10 ladder: 8 → 80 → critical. Undeclared (identity): 8 → 8 → low.
    assert band_of_case(case, _prefs_with_source(10.0)) == "critical"
    assert band_of_case(case, _prefs_with_source(None)) == "low"


def test_band_of_case_fails_open_to_info_and_never_raises() -> None:
    class _Broken:
        @property
        def severity_band(self):  # noqa: ANN202 — deliberately explosive
            raise RuntimeError("boom")

    assert band_of_case(_Broken(), None) == "info"  # type: ignore[arg-type]
    assert band_of_case(object(), object()) == "info"  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# (b) the shift report — the severity term was ZERO for every real case
# --------------------------------------------------------------------------- #
def test_urgency_score_now_weighs_a_resolved_severity_band() -> None:
    prefs = _prefs_with_source(10.0)
    case = _case(
        risk=0.0, severity_max=8.0, source_id="src-a", age_minutes=0.0,
        verdict=Verdict.TRUE_POSITIVE, status=CaseStatus.OPEN,
    )
    # risk 0 + age 0 + no escalation/NEEDS_HUMAN bump ⇒ the score is PURELY the severity
    # term: a declared 0-10 ladder puts raw 8 at 80 ⇒ critical ⇒ weight 1.0 × 0.25.
    # Before: severity_band was None on every real case ⇒ weight 0.0 ⇒ score 0.0.
    assert shift_report.urgency_score(case, prefs=prefs) == pytest.approx(0.25, abs=1e-6)
    # Without prefs the ceiling is the identity, so raw 8 is a LOW band (weight 0.25).
    # Still non-zero: the point is that the severity axis now CONTRIBUTES at all.
    assert shift_report.urgency_score(case) == pytest.approx(0.0625, abs=1e-6)


def test_attention_queue_row_carries_the_resolved_band() -> None:
    prefs = _prefs_with_source(10.0)
    rows = shift_report.attention_queue(
        [_case(risk=0.0, severity_max=8.0, source_id="src-a")], prefs=prefs
    )
    assert rows and rows[0]["severity_band"] == "critical"


def test_attention_queue_row_carries_the_bands_PROVENANCE_too() -> None:
    """A queue that shows a band must say where the band came from.

    Every row now carries a ``severity_band``, and for a case whose source asserted
    nothing that band is a pure function of the ``risk_score`` printed beside it. Shown
    without provenance it reads as an independent second opinion. The token is the same
    three-way vocabulary the Cases list badges."""
    prefs = _prefs_with_source(10.0)
    asserted = shift_report.attention_queue(
        [_case(risk=0.0, severity_max=8.0, source_id="src-a")], prefs=prefs
    )
    derived = shift_report.attention_queue(
        [_case(risk=72.0, severity_max=None, source_id="src-a")], prefs=prefs
    )
    saturated = shift_report.attention_queue(
        [_case(risk=0.0, severity_max=99.0, source_id="src-a")], prefs=prefs
    )
    assert asserted[0]["severity_source"] == "source_asserted"
    assert derived[0]["severity_source"] == "derived"
    assert saturated[0]["severity_source"] == "source_out_of_range"
    # The derived row's band really is a restatement of its own risk — which is exactly
    # why the provenance token has to travel with it.
    assert derived[0]["severity_band"] == "high" and derived[0]["risk_score"] == 72.0


def test_attention_queue_provenance_fails_open_and_never_breaks_the_queue() -> None:
    """A malformed case degrades to the WEAKER claim, never to an exception."""

    class _Exploding:
        id = "src-a"

        @property
        def severity_scale_max(self):  # noqa: ANN201
            raise RuntimeError("boom")

    prefs = Preferences.model_construct(sources=[_Exploding()], priority_matrix=None)
    rows = shift_report.attention_queue(
        [_case(risk=50.0, severity_max=8.0, source_id="src-a")], prefs=prefs
    )
    assert rows and rows[0]["severity_source"] == "derived"


def test_build_shift_report_threads_prefs_and_still_works_without_them() -> None:
    cases = [_case(risk=0.0, severity_max=8.0, source_id="src-a")]
    with_prefs = shift_report.build_shift_report(cases, prefs=_prefs_with_source(10.0))
    without = shift_report.build_shift_report(cases)
    assert with_prefs["attention_queue"][0]["severity_band"] == "critical"
    # prefs is OPTIONAL: no caller breaks, the identity ceiling is used instead.
    assert without["attention_queue"][0]["severity_band"] == "low"


# --------------------------------------------------------------------------- #
# (d) the Elastic connector no longer bypasses the declared scale
# --------------------------------------------------------------------------- #
def _feed(floor: int) -> IndexPattern:
    return IndexPattern(pattern="all-logs-*", role=IndexRole.EVENTS, severity_floor=floor)


def _raw(severity: float) -> RawEvent:
    return RawEvent(
        id="e1",
        index="all-logs-2026.08.30",
        timestamp_millis=1,
        severity=severity,
        raw={},
    )


def test_elastic_floor_gate_uses_the_declared_ceiling() -> None:
    conn = ElasticConnector(InMemoryESClient(), connector_id="src-a")
    feed = _feed(4)  # OCSF severity_id High
    # A genuinely LOW severity on the DEFAULT (identity) ceiling: 9 → severity_id 1,
    # below the floor. The old unscaled call magnitude-guessed 9 → 90 → id 5 → eligible.
    ev = conn._tag_events([_raw(9.0)], feed=feed, prefs=_prefs_with_source(None))[0]
    assert ev.auto_investigate_eligible is False
    # The SAME raw 9 on a DECLARED 0-10 ladder is genuinely high → 90 → id 5 → eligible.
    ev = conn._tag_events([_raw(9.0)], feed=feed, prefs=_prefs_with_source(10.0))[0]
    assert ev.auto_investigate_eligible is True


def test_elastic_floor_gate_never_drops_a_below_floor_event() -> None:
    """#4: below-floor only marks the event ineligible — it is still returned."""
    conn = ElasticConnector(InMemoryESClient(), connector_id="src-a")
    out = conn._tag_events([_raw(1.0)], feed=_feed(4), prefs=_prefs_with_source(None))
    assert len(out) == 1 and out[0].auto_investigate_eligible is False


def test_elastic_severity_scale_max_fails_open() -> None:
    conn = ElasticConnector(InMemoryESClient(), connector_id="src-a")

    class _Explosive:
        def source_by_id(self, _sid):  # noqa: ANN202
            raise RuntimeError("boom")

    assert conn._severity_scale_max(_Explosive()) == 100.0
    assert conn._severity_scale_max(None) == 100.0


def test_an_unresolvable_source_reads_as_the_IDENTITY_on_every_severity_surface() -> None:
    """"Cannot resolve the source" must mean one thing, not two.

    Three surfaces resolve a ceiling for the SAME record: OCSF normalisation
    (``ocsf.ecs._severity_scale``), the batch/synchronous lane split
    (``event_detection.event_is_batch_eligible``) and the per-feed floor gate. Each used
    to have its own fallback for an unresolvable source, and one of them kept the retired
    ``raw <= 10 ? raw*10`` guess — so an already-canonical OCSF Informational score of
    10.0 read as ``severity_id`` 5 (Critical) there and 1 everywhere else, and the same
    event routed to opposite lanes depending only on whether its source happened to be
    registered."""
    from app.engine.event_detection import event_is_batch_eligible
    from app.ocsf.ecs import _severity_scale
    from app.ocsf.model import score_to_severity_id

    class _Explosive:
        def source_by_id(self, _sid):  # noqa: ANN202
            raise RuntimeError("boom")

    configured = _prefs_with_source(None)           # a source that declares NO ceiling
    unregistered = Preferences()                    # no sources at all

    # Every arm — success, no-match, and a raising lookup — is the identity ceiling.
    assert _severity_scale(configured, "src-a") == 100.0
    assert _severity_scale(configured, "not-configured") == 100.0
    assert _severity_scale(configured, None) == 100.0
    assert _severity_scale(_Explosive(), "src-a") == 100.0
    assert score_to_severity_id(10.0, _severity_scale(configured, "nope")) == 1

    # ...and the lane split agrees with it for both sources, instead of flipping.
    ev = RawEvent(id="e", index="i", timestamp_millis=1, severity=10.0,
                  source_id="src-a", raw={})
    assert event_is_batch_eligible(ev, configured) is True
    assert event_is_batch_eligible(ev, unregistered) is True
    # A DECLARED narrow ladder still wins over the default.
    assert event_is_batch_eligible(ev, _prefs_with_source(10.0)) is False


# --------------------------------------------------------------------------- #
# (e) the durable counters stamp the ceiling on the by_source SUB-BLOCK only
# --------------------------------------------------------------------------- #
def test_pooled_totals_carry_no_ceiling_and_stay_unchanged() -> None:
    delta = {
        "ingested": {"critical": 2, "low": 3},
        "clustered": {"low": 1},
        "suppressed": 1,
        "ignored": 0,
        "source_id": "src-a",
        "severity_scale_max": 16.0,
    }
    bucket = _merge_delta(None, delta)
    assert "severity_scale_max" not in bucket  # one bucket pools EVERY source
    assert bucket["ingested"]["critical"] == 2 and bucket["ingested"]["low"] == 3
    assert bucket["by_source"]["src-a"]["severity_scale_max"] == 16.0


def test_ceiling_survives_a_normalisation_round_trip() -> None:
    bucket = _merge_delta(
        None,
        {"ingested": {"low": 1}, "clustered": {}, "suppressed": 0, "ignored": 0,
         "source_id": "src-a", "severity_scale_max": 16.0},
    )
    # A stored bucket is re-normalised on EVERY tick; the stamp must not be stripped.
    assert _norm_bucket(bucket)["by_source"]["src-a"]["severity_scale_max"] == 16.0


def test_two_ceilings_in_one_hour_read_as_not_provable() -> None:
    base = {"ingested": {"low": 1}, "clustered": {}, "suppressed": 0, "ignored": 0,
            "source_id": "src-a"}
    bucket = _merge_delta(None, {**base, "severity_scale_max": 16.0})
    bucket = _merge_delta(bucket, {**base, "severity_scale_max": 10.0})
    assert bucket["by_source"]["src-a"]["severity_scale_max"] is None


def test_a_delta_without_a_source_id_folds_into_the_pooled_totals_only() -> None:
    bucket = _merge_delta(
        None, {"ingested": {"low": 4}, "clustered": {}, "suppressed": 0, "ignored": 0}
    )
    assert bucket["by_source"] == {} and bucket["ingested"]["low"] == 4


@pytest.mark.asyncio
async def test_read_window_reports_a_mixed_ladder_as_not_provable() -> None:
    store = NoiseCounterStore(_MemKV())
    now = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
    # An older hour recorded before the ceiling was captured …
    await store.record(
        {"ingested": {"critical": 5}, "clustered": {}, "suppressed": 0, "ignored": 0,
         "source_id": "src-a"},
        now=now - timedelta(hours=40),
    )
    # … and a recent hour that records it.
    await store.record(
        {"ingested": {"low": 5}, "clustered": {}, "suppressed": 0, "ignored": 0,
         "source_id": "src-a", "severity_scale_max": 100.0},
        now=now - timedelta(hours=2),
    )
    recent = await store.read_window(24, now=now, end_exclusive=True)
    combined = await store.read_window(24 * 7, now=now, end_exclusive=True)
    assert recent["by_source"]["src-a"]["severity_scale_max"] == 100.0
    assert combined["by_source"]["src-a"]["severity_scale_max"] is None  # mixture
    # Pooled totals are untouched by any of this.
    assert _counter_band_total(combined["ingested"]) == 10


# --------------------------------------------------------------------------- #
# (f) band-level comparison is suppressed across the changeover, totals are not
# --------------------------------------------------------------------------- #
def _window(bands: dict[str, int], ceiling: float | None, *, attributed: bool = True):
    sub = {"ingested": dict(bands), "clustered": {}, "suppressed": 0, "ignored": 0,
           "severity_scale_max": ceiling}
    return {
        "available": True,
        "ingested": dict(bands),
        "clustered": {},
        "by_source": {"src-a": sub} if attributed else {},
    }


def test_band_comparison_available_when_one_ceiling_is_recorded_throughout() -> None:
    cur = _window({"low": 10}, 100.0)
    comb = _window({"low": 20}, 100.0)
    assert _severity_band_comparison(cur, comb) == {"available": True, "reason": ""}


def test_band_comparison_suppressed_when_a_window_records_no_ceiling() -> None:
    out = _severity_band_comparison(_window({"low": 10}, 100.0), _window({"low": 20}, None))
    assert out["available"] is False and "one single severity ceiling" in out["reason"]


def test_band_comparison_suppressed_when_the_ceilings_differ() -> None:
    out = _severity_band_comparison(_window({"low": 10}, 100.0), _window({"low": 20}, 16.0))
    assert out["available"] is False and "different ladders" in out["reason"]


def test_band_comparison_suppressed_when_volume_is_unattributed() -> None:
    unattributed = _window({"low": 10}, None, attributed=False)
    out = _severity_band_comparison(unattributed, unattributed)
    assert out["available"] is False and "not attributed" in out["reason"]


def test_band_comparison_is_trivially_available_with_no_volume() -> None:
    empty = {"available": True, "ingested": {}, "clustered": {}, "by_source": {}}
    assert _severity_band_comparison(empty, empty)["available"] is True


def test_alert_volume_keeps_band_independent_totals_when_bands_are_suppressed() -> None:
    """The suppression must not degrade VOLUME reporting, and the preceding-window
    total must come from the pooled totals — a band-by-band subtraction clamps each
    band at zero, so volume that MOVED between bands would inflate the baseline."""
    suppressed = {
        "available": True,
        "incomplete": False,
        "window_basis": "complete_utc_days",
        "severity_band_comparison": {"available": False, "reason": "measured reason"},
        "current": {"ingested": None, "clustered": None,
                    "ingested_total": 1000, "clustered_total": 500},
        "baseline": {"ingested": None, "clustered": None,
                     "ingested_total": 1000, "clustered_total": 500},
    }
    out = _alert_volume(suppressed, current_days=28, baseline_days=28)
    assert out["status"] == "enough_data"
    assert out["severity_band_comparison"]["available"] is False
    assert out["severity_band_comparison"]["reason"] == "measured reason"
    assert out["current"]["ingested_alerts"] == 1000
    assert out["baseline"]["ingested_alerts"] == 1000
    assert out["delta"]["ingested_per_day_relative"] == 0.0


def test_alert_volume_still_totals_a_legacy_band_only_comparison() -> None:
    """Back-compat: a caller that supplies only per-band maps still gets totals."""
    legacy = {
        "available": True,
        "incomplete": False,
        "window_basis": "complete_utc_days",
        "current": {"ingested": {"low": 7}, "clustered": {"low": 3}},
        "baseline": {"ingested": {"low": 5}, "clustered": {"low": 2}},
    }
    out = _alert_volume(legacy, current_days=7, baseline_days=7)
    assert out["current"]["ingested_alerts"] == 7
    assert out["baseline"]["ingested_alerts"] == 5
    # Nothing proved the ladder, so the band comparison is reported unavailable.
    assert out["severity_band_comparison"]["available"] is False
