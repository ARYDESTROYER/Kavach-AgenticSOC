"""Noise-Reduction funnel — severity banding + rollup helpers (Round 7).

Turns the two ingest-side inputs of the Noise-Reduction funnel into the shared
5-band severity vocabulary and assembles the ``GET /api/metrics/noise-reduction``
report contract (§D of the Round-7 plan). Two responsibilities, both PURE:

1. **Banding** — project a raw source-asserted severity onto the canonical 5-band
   ladder by IMPORTING the single classifier authority in :mod:`app.engine.priority`
   (:func:`priority._severity_band_from_magnitude` + :func:`priority._normalise_severity`
   + :func:`priority.severity_scale_for_source`). The cut-points live ONLY in
   ``priority.py`` — this module never re-declares them (one place to tune 74/48/22/8).

2. **Rollup** — count raw events / clusters by band, and fuse the durable
   :class:`app.stores.noise_counters.NoiseCounterStore` window tally with a mutually
   exclusive case disposition tally plus additive operational views. Auto-cleared and
   Escalated partition opened cases; Closed by human overlaps Escalated as an
   analyst-attributed subset.

Everything here is DETERMINISTIC + advisory (#3): nothing is read by
``case_manager.decide()`` and no ``cluster_signature`` is recomputed (#4). Every helper is
defensive — a malformed event/case/counter degrades to a zero/``info`` band, never raises,
so a dashboard query can't fail and a poll tick can't break on the counters.
"""

from __future__ import annotations

from typing import Any

from ..constants import (
    CaseStatus,
    DecisionBy,
    SEVERITY_BANDS,
    TERMINAL_CASE_STATUSES,
    Verdict,
)
from ..models import Case
from .metrics import DASH, _window_filter, truncation_marker
from .priority import (
    _normalise_severity,
    _severity_band_from_magnitude,
    severity_band_from_events,
    severity_scale_for_source,  # re-exported: callers band by the source's scale
)

__all__ = [
    "severity_scale_for_source",
    "zero_bands",
    "band_for_severity",
    "count_events_by_band",
    "band_for_cluster",
    "count_clusters_by_band",
    "merge_bands",
    "empty_noise_delta",
    "events_per_min_from_ticks",
    "build_noise_reduction",
]

_INFO = "info"


# --------------------------------------------------------------------------- #
# Coverage observability — per-source ingest RATE from a small rolling tick deque.
# Shared by the pull poller (A5.1) + the push IngestService (A5.2). Pure + advisory
# (never feeds ``decide()``, #3); a deque hiccup degrades to 0.0, never raises.
# --------------------------------------------------------------------------- #
def events_per_min_from_ticks(ticks: Any) -> float:
    """Smoothed events/min from a rolling deque of ``(epoch_seconds, count)`` tick samples.

    Uses the wall-clock span between the FIRST and LAST sample; the arrivals counted are
    the tick counts AFTER the first sample (the first sample only marks the window START).
    Fewer than 2 samples or a non-positive span → ``0.0`` (not enough signal to state a
    rate yet — an honest zero, not a fabricated number). Never raises."""
    try:
        pts = list(ticks or [])
        if len(pts) < 2:
            return 0.0
        first_ts = float(pts[0][0])
        last_ts = float(pts[-1][0])
        span = last_ts - first_ts
        if span <= 0:
            return 0.0
        total = 0
        for _ts, cnt in pts[1:]:
            try:
                total += max(0, int(cnt or 0))
            except (TypeError, ValueError):
                continue
        return round(total / span * 60.0, 2)
    except Exception:  # noqa: BLE001 — a rate is advisory; never break a health read
        return 0.0


# --------------------------------------------------------------------------- #
# Banding + rollup helpers (used by the poller / ingest sink AND the report).
# --------------------------------------------------------------------------- #
def zero_bands() -> dict[str, int]:
    """A fresh ``{band: 0}`` dict over the canonical 5-band severity ladder."""
    return {b: 0 for b in SEVERITY_BANDS}


def band_for_severity(raw: Any, scale: str) -> str:
    """Band ONE raw source severity using the source's declared ``scale``.

    Projects the raw value onto 0-100 via the shared :func:`priority._normalise_severity`
    (scale-aware), then onto the 5-band ladder via :func:`priority._severity_band_from_magnitude`
    — the ONE cut-point authority. A missing/negative severity reads as ``info``."""
    try:
        val = float(raw) if raw is not None else 0.0
    except (TypeError, ValueError):
        return _INFO
    mag = _normalise_severity(val, scale)
    return _severity_band_from_magnitude(mag)


def count_events_by_band(events: Any, scale: str) -> dict[str, int]:
    """Tally an iterable of :class:`app.models.RawEvent` by severity band (source scale)."""
    counts = zero_bands()
    for ev in (events or []):
        band = band_for_severity(getattr(ev, "severity", None), scale)
        counts[band] = counts.get(band, 0) + 1
    return counts


def band_for_cluster(cluster: Any, scale: str) -> str:
    """Band ONE correlated cluster by its worst member severity (source scale).

    Prefers the cluster's ``trigger_reason.severity_max`` (what correlation recorded),
    falling back to the maximum member-event severity. Empty/unknown → ``info``."""
    raw: float | None = None
    tr = getattr(cluster, "trigger_reason", None)
    if tr is not None and getattr(tr, "severity_max", None) is not None:
        try:
            raw = float(tr.severity_max)
        except (TypeError, ValueError):
            raw = None
    if raw is None:
        sevs: list[float] = []
        for ev in (getattr(cluster, "member_events", None) or []):
            s = getattr(ev, "severity", None)
            if s is not None:
                try:
                    sevs.append(float(s))
                except (TypeError, ValueError):
                    continue
        raw = max(sevs) if sevs else None
    return band_for_severity(raw, scale)


def count_clusters_by_band(clusters: Any, scale: str) -> dict[str, int]:
    """Tally an iterable of :class:`app.models.Cluster` by severity band (source scale)."""
    counts = zero_bands()
    for cl in (clusters or []):
        band = band_for_cluster(cl, scale)
        counts[band] = counts.get(band, 0) + 1
    return counts


def merge_bands(a: dict[str, int] | None, b: dict[str, int] | None) -> dict[str, int]:
    """Sum two per-band dicts (unknown bands dropped, counts clamped non-negative)."""
    out = zero_bands()
    for band in SEVERITY_BANDS:
        av = a.get(band, 0) if isinstance(a, dict) else 0
        bv = b.get(band, 0) if isinstance(b, dict) else 0
        try:
            out[band] = max(0, int(av or 0)) + max(0, int(bv or 0))
        except (TypeError, ValueError):
            out[band] = 0
    return out


def empty_noise_delta() -> dict[str, Any]:
    """The zero counter delta the poller/ingest sink starts from each tick."""
    return {"ingested": zero_bands(), "clustered": zero_bands(),
            "suppressed": 0, "ignored": 0}


# --------------------------------------------------------------------------- #
# Case-disposition partition + overlapping operational views.
# --------------------------------------------------------------------------- #
def _status_val(case: Case) -> str:
    st = getattr(case, "status", None)
    return getattr(st, "value", st) if st is not None else ""


def _ever_escalated(case: Case) -> bool:
    for row in (getattr(case, "status_history", None) or []):
        try:
            if str(getattr(row, "to_status", "") or "") == CaseStatus.ESCALATED.value:
                return True
        except Exception:  # noqa: BLE001 — a malformed history row is not escalation
            continue
    return False


def _is_needs_human(case: Case) -> bool:
    """The AI could NOT resolve it → a human still owns it: an explicit NEEDS_HUMAN
    verdict, OR any still-open (non-terminal) case awaiting analyst work that has NOT been
    escalated. Excluding escalated cases here keeps the §D MECE priority honest
    (needs_human > escalated): an escalated-but-open case falls to the escalated bucket
    unless the AI explicitly punted it with a NEEDS_HUMAN verdict."""
    if getattr(case, "verdict", None) == Verdict.NEEDS_HUMAN:
        return True
    return _status_val(case) not in TERMINAL_CASE_STATUSES and not _is_escalated(case)


def _is_escalated(case: Case) -> bool:
    if _status_val(case) == CaseStatus.ESCALATED.value:
        return True
    if (getattr(case, "escalation_level", 0) or 0) > 0:
        return True
    return _ever_escalated(case)


def _is_auto_cleared(case: Case) -> bool:
    """A DETERMINISTIC AI auto-close: terminal, decided BY THE AGENT, FALSE_POSITIVE."""
    return (
        _status_val(case) in TERMINAL_CASE_STATUSES
        and getattr(case, "decision_by", None) == DecisionBy.AGENT
        and getattr(case, "verdict", None) == Verdict.FALSE_POSITIVE
    )


def _is_policy_closed(case: Case) -> bool:
    """Closed by an operator's analyst RULE POLICY — neither AI nor human case work."""
    return getattr(case, "decision_by", None) == DecisionBy.ANALYST_POLICY


def _is_human_closed(case: Case) -> bool:
    """The last stage of the funnel: a case that reached a TERMINAL state (resolved/
    closed) with explicit ANALYST decision authority. This intentionally excludes
    policy-driven AGENT closures (including opt-in TRUE_POSITIVE auto-close), SYSTEM
    routing, and legacy records with missing provenance; none proves a human performed
    the close. Filtering only the default FALSE_POSITIVE auto-close would overstate
    human work. This is the "handled by a human" bucket the §D flow
    (…→escalated→closed) ends on. Advisory tally only (#3)."""
    return (
        _status_val(case) in TERMINAL_CASE_STATUSES
        and getattr(case, "decision_by", None) == DecisionBy.ANALYST
    )


def _band_of_case(case: Case, prefs: Any) -> str:
    """The advisory severity band for a case (prefer a persisted band; else derive)."""
    band = getattr(case, "severity_band", None)
    if band in SEVERITY_BANDS:
        return band
    try:
        derived = severity_band_from_events(case, prefs).get("band")
        if derived in SEVERITY_BANDS:
            return derived
    except Exception:  # noqa: BLE001 — advisory only; never raise on a bad case
        pass
    return _INFO


def _stage(key: str, label: str, *, source: str, deterministic: bool,
           total: Any, by_severity: Any) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "source": source,
        "deterministic": deterministic,
        "total": total,
        "by_severity": by_severity,
    }


def _reduction(numer: int, denom: int) -> Any:
    """``(1 - numer/denom)`` as a 0-100 PERCENT (rounded to 0.1); DASH when denom is 0.

    The contract field is ``*_pct`` and the TS type + ``NoiseFunnel`` render it as
    ``{value}%``, so this returns a percentage in [0,100], never a fraction."""
    if denom <= 0:
        return DASH
    return round(max(0.0, 1.0 - (numer / denom)) * 100, 1)


def build_noise_reduction(
    cases: list[Case],
    counters: dict[str, Any],
    *,
    window_hours: int,
    store_total: int | None = None,
    fetched_count: int | None = None,
    prefs: Any = None,
    generated_at: str,
    now: Any = None,
) -> dict[str, Any]:
    """Assemble the ``GET /api/metrics/noise-reduction`` §D contract (pure).

    ``cases`` is the store page (BEFORE window filtering); ``counters`` is the
    :meth:`NoiseCounterStore.read_window` result. ``ingested``/``clustered`` come from the
    durable counters (by band); ``cases`` plus the mutually exclusive Auto-cleared /
    Escalated partition come from the case tally. ``closed`` is an overlapping,
    analyst-attributed subset of Escalated and is therefore not added to that partition.
    When the counters are still warming up
    (``available: false``) the ingested/clustered totals are ``null`` and ``overall_pct``
    is DASH, so the UI degrades to a case-only funnel. Never raises."""
    counters = counters or {}
    available = bool(counters.get("available"))

    fetched = int(fetched_count) if fetched_count is not None else len(cases)
    window_cases = _window_filter(list(cases), window_hours=max(0, int(window_hours or 0)), now=now)
    cases_total = len(window_cases)

    # Internal mutually exclusive disposition tally (each case in exactly one bucket,
    # priority order). ``closed`` is a SEPARATE, OVERLAPPING view: terminal cases
    # explicitly decided by an ANALYST. It is a subset of the analyst path, not a third
    # outcome to add beside Auto-cleared and Escalated.
    cases_bands = zero_bands()
    nh_bands = zero_bands()
    esc_bands = zero_bands()
    ac_bands = zero_bands()
    closed_bands = zero_bands()
    policy_bands = zero_bands()
    nh = esc = ac = closed = policy = 0
    for c in window_cases:
        band = _band_of_case(c, prefs)
        cases_bands[band] = cases_bands.get(band, 0) + 1
        if _is_policy_closed(c):
            # Closed by an operator's analyst RULE POLICY. Its OWN mutually exclusive
            # bucket: it is not an AI auto-clear (no model ran) and not human case work
            # (nobody worked this case), and without this branch it would silently land
            # in the Escalated residual fold below and be rendered as escalated volume.
            policy += 1
            policy_bands[band] = policy_bands.get(band, 0) + 1
            continue
        if _is_human_closed(c):
            closed += 1
            closed_bands[band] = closed_bands.get(band, 0) + 1
        if _is_needs_human(c):
            nh += 1
            nh_bands[band] = nh_bands.get(band, 0) + 1
        elif _is_escalated(c):
            esc += 1
            esc_bands[band] = esc_bands.get(band, 0) + 1
        elif _is_auto_cleared(c):
            ac += 1
            ac_bands[band] = ac_bands.get(band, 0) + 1
        # else → the true_positive residual (cases_total − nh − esc − ac; #D §client-derived)

    # The funnel's terminal "Escalated" node must carry EVERY case the AI did not
    # auto-clear (i.e. raised for a human): the escalated MECE bucket PLUS the
    # needs_human bucket PLUS the true_positive residual. The UI (NoiseFunnel.tsx) fans
    # ``cases`` out into only auto_cleared / escalated / closed, so without this fold the
    # needs_human + residual cases would render in NO terminal node and the visible
    # outcomes would fail to account for every windowed case. Equivalently this is
    # ``cases_total − auto_cleared`` (per band). The STANDALONE ``needs_human`` stage +
    # the nh-based reduction headline below are left unchanged (kept for other
    # consumers); only THIS stage folds the otherwise-invisible buckets in. Advisory
    # only (#3) — nothing here is read by ``decide()``.
    # ``policy`` is subtracted alongside ``ac``: a declared-benign close is not work
    # raised for a human, so folding it into Escalated would overstate human load.
    esc_stage_total = esc + nh + max(0, cases_total - nh - esc - ac - policy)
    esc_stage_bands = zero_bands()
    for band in SEVERITY_BANDS:
        band_residual = max(
            0,
            cases_bands.get(band, 0)
            - nh_bands.get(band, 0)
            - esc_bands.get(band, 0)
            - ac_bands.get(band, 0)
            - policy_bands.get(band, 0),
        )
        esc_stage_bands[band] = nh_bands.get(band, 0) + esc_bands.get(band, 0) + band_residual

    # Counter-derived ingested/clustered bands (null when warming up).
    if available:
        ing_bands = merge_bands(counters.get("ingested"), None)
        clu_bands = merge_bands(counters.get("clustered"), None)
        ingested_total: Any = sum(ing_bands.values())
        clustered_total: Any = sum(clu_bands.values())
        ing_by_sev: Any = ing_bands
        clu_by_sev: Any = clu_bands
    else:
        ingested_total = None
        clustered_total = None
        ing_by_sev = None
        clu_by_sev = None

    stages = [
        _stage("ingested", "Alerts ingested", source="counters", deterministic=True,
               total=ingested_total, by_severity=ing_by_sev),
        _stage("clustered", "After clustering", source="counters", deterministic=True,
               total=clustered_total, by_severity=clu_by_sev),
        _stage("cases", "Cases opened", source="cases", deterministic=False,
               total=cases_total, by_severity=cases_bands),
        _stage("auto_cleared", "Auto-cleared by AI", source="cases", deterministic=True,
               total=ac, by_severity=ac_bands),
        # Folds needs_human + the true_positive residual in (see the esc_stage_* comment
        # above) so the terminal outcomes account for every windowed case.
        _stage("escalated", "Escalated", source="cases", deterministic=True,
               total=esc_stage_total, by_severity=esc_stage_bands),
        _stage("needs_human", "Needs a human", source="cases", deterministic=True,
               total=nh, by_severity=nh_bands),
        # Additive analyst-owned subset: a case that reached a terminal state with
        # explicit ANALYST decision authority. It overlaps Escalated; consumers must not
        # add it to Auto-cleared + Escalated. ``deterministic=False`` marks HUMAN
        # decision authority, not deterministic auto-close.
        _stage("closed", "Closed by human", source="cases", deterministic=False,
               total=closed, by_severity=closed_bands),
        # Mutually exclusive with Auto-cleared and Escalated (subtracted from the
        # residual fold above), so the three terminal nodes still account for every
        # windowed case. ``deterministic=True`` — it IS a deterministic close, just an
        # operator's rather than the agent's.
        _stage("policy_closed", "Closed by analyst policy", source="cases",
               deterministic=True, total=policy, by_severity=policy_bands),
    ]

    overall = _reduction(nh, ingested_total) if (available and isinstance(ingested_total, int)) else DASH
    human_reduction = _reduction(nh, cases_total)

    return {
        "window_hours": max(0, int(window_hours or 0)),
        "generated_at": generated_at,
        "bands": list(SEVERITY_BANDS),
        "stages": stages,
        "drops": {
            "suppressed": int(counters.get("suppressed", 0) or 0),
            "ignored": int(counters.get("ignored", 0) or 0),
        },
        "reduction": {
            "overall_pct": overall,
            "human_reduction_pct": human_reduction,
        },
        "counters": {
            "available": available,
            "since": counters.get("since"),
            "incomplete": bool(counters.get("incomplete")),
        },
        "cases_meta": truncation_marker(fetched, store_total),
    }
