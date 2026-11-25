"""Forwarding EXPLAINABILITY (Round 4 Wave 3) — a read-only "why did / didn't this
cluster auto-investigate?" narrator.

``explain_forwarding(cluster, prefs)`` reproduces — WITHOUT re-deciding anything — the
exact chain of gates that :func:`app.engine.ingest.handle_clusters` walks to choose
between ``pipeline.investigate_cluster`` (auto-forward to the LLM investigator) and
``pipeline.register_candidate`` (registered OPEN for manual triage). It returns a plain
python object (a :class:`ForwardingExplanation`) whose ``gate`` field names the FIRST
gate that decided the outcome, plus a one-line human-readable ``sentence``.

Design invariants (the same non-negotiables the rest of Round 4 holds):

* **#3 — a PURE, ADVISORY narrator.** It NEVER imports ``case_manager``, NEVER calls or
  reads ``decide()``, and NEVER changes a case's status/disposition. It only *describes*
  the deterministic auto-forward gate that runs BEFORE any verdict exists; the
  close/escalate decision stays a pure fn in ``case_manager.decide()``.
* **#4 — read-only.** It never recomputes / mutates ``cluster_signature``; it only reads
  the cluster's already-computed provenance flags (``is_alert``,
  ``auto_investigate_eligible``, ``source_id``, ``rule_values``).
* **#6 — no LLM call.** Pure logic over prefs + cluster → no ``UsageDoc``.
* **#9 — no prompt.** It builds no prompt over event bodies; the ``sentence`` it returns
  is a code-assembled summary of TRUSTED config/flags, never interpolated log text.

The gate order MIRRORS ``handle_clusters`` exactly so the explanation can never disagree
with what actually happened:

  1. ``ignored``            — every member belongs to an IGNORE feed → dropped entirely.
  2. ``suppressed``         — every member matches a live suppression rule → dropped.
  3. ``background_scan``    — the global automated-investigation switch is OFF.
  4. ``severity_floor``     — every member is below its feed's ``severity_floor``
                              (``cluster.auto_investigate_eligible`` is False).
  5. ``auto_correlate``     — the per-source and/or per-feed Auto-Correlate toggle is OFF.
  6. ``risk_floor``         — an events-role cluster that is neither allowlisted nor
                              above the available-signal routing floor → candidate.
  7. ``forwarded``          — all gates pass → auto-investigated.

``cost_gate`` / ``budget`` are surfaced ADVISORY-only in the explanation's ``notes`` (they
are enforced deeper in the pipeline / by the pre-flight :class:`app.engine.budget.BudgetGate`,
which fails safe to NEEDS_HUMAN and never silently closes, #3) — they are NOT part of the
``handle_clusters`` forwarding branch itself, so they never override the seven gates above.

DEFAULTS OFF is not applicable here — this module is a pure read-time explainer with no
behaviour of its own; it changes nothing until a caller asks it a question.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field

from ..config import Preferences
from ..constants import IndexRole
from ..engine.risk import compute_routing_risk
from ..models import Cluster
from ..utils import dotted_get

# The gate names, in the exact order ``handle_clusters`` evaluates them. Exposed so a
# UI / test can assert against a stable vocabulary.
GATES: tuple[str, ...] = (
    "ignored",
    "suppressed",
    "background_scan",
    "severity_floor",
    "auto_correlate",
    "risk_floor",
    "forwarded",
)


@dataclass
class ForwardingExplanation:
    """A read-only, advisory account of the auto-forward decision for one cluster.

    PURE DATA — it carries the deciding ``gate`` (one of :data:`GATES`), whether the
    cluster ``forwarded`` (auto-investigated) vs registered as a candidate, a
    human-readable ``sentence``, and ``notes`` (advisory cost/budget context). It never
    carries a verdict/status and can never close a case (#3)."""

    gate: str
    forwarded: bool
    dropped: bool
    sentence: str
    source_id: str | None = None
    is_alert: bool = False
    notes: list[str] = field(default_factory=list)
    # Round 16 ([comp] R3): the available-signal routing score, computed only when the
    # walk reached the risk-floor gate (``None`` when an earlier gate decided), the
    # configured floor, and whether the floor decided (an events-role cluster that is
    # not on the allowlist). The stored case risk, scored after enrichment, is another
    # number and never decided this (#3).
    routing_total: float | None = None
    risk_floor: float | None = None
    routing_gate_applied: bool = False

    def to_dict(self) -> dict:
        return {
            "gate": self.gate,
            "forwarded": self.forwarded,
            "dropped": self.dropped,
            "sentence": self.sentence,
            "source_id": self.source_id,
            "is_alert": self.is_alert,
            "notes": list(self.notes),
            "routing_total": self.routing_total,
            "risk_floor": self.risk_floor,
            "routing_gate_applied": self.routing_gate_applied,
        }


# --------------------------------------------------------------------------- #
# Gate probes — read-only mirrors of the ingest gates (they IMPORT nothing from
# ingest to keep this file self-contained + free of a decide() import chain, but
# reproduce the SAME logic so the explanation matches reality).
# --------------------------------------------------------------------------- #
def _source_for(cluster: Cluster, prefs: Preferences):
    sid = cluster.source_id
    if not sid:
        return None
    return next((s for s in prefs.sources if s.id == sid), None)


def _feed_for_event(ev, feeds, by_id):
    """The feed an event belongs to: by tagged ``feed_id`` else longest-pattern
    ``_index`` match (mirrors ingest._auto_correlate_allowed / _is_ignored_cluster)."""
    feed = by_id.get(ev.feed_id) if ev.feed_id else None
    if feed is not None:
        return feed
    idx = ev.index or ""
    best = None
    best_len = -1
    for f in feeds:
        if f.pattern and idx and fnmatch.fnmatch(idx, f.pattern) and len(f.pattern) > best_len:
            best, best_len = f, len(f.pattern)
    return best


def _is_ignored(cluster: Cluster, prefs: Preferences) -> bool:
    """True when EVERY in-scope member belongs to an IGNORE feed (mirror of
    ingest._is_ignored_cluster)."""
    src = _source_for(cluster, prefs)
    if src is None:
        return False
    feeds = src.feeds()
    ignore_feeds = [f for f in feeds if f.role == IndexRole.IGNORE]
    if not ignore_feeds:
        return False
    members = cluster.member_events or []
    if not members:
        return False
    by_id = {f.id: f for f in feeds}
    for ev in members:
        feed = _feed_for_event(ev, feeds, by_id)
        if feed is None or feed.role != IndexRole.IGNORE:
            return False
    return True


def _passes_suppression(cluster: Cluster, prefs: Preferences) -> bool:
    """False when EVERY member matches a live suppression rule (mirror of
    cost_gate.passes_suppression — reproduced here to avoid importing anything that
    could pull the decision chain)."""
    rules = [r for r in prefs.suppression_rules if r.is_live()]
    if not rules:
        return True
    for ev in cluster.member_events:
        suppressed = any(str(dotted_get(ev.source, r.field)) == r.value for r in rules)
        if not suppressed:
            return True
    return False


def _auto_correlate_allowed(cluster: Cluster, prefs: Preferences) -> bool:
    """The per-source + per-feed Auto-Correlate gate (mirror of
    ingest._auto_correlate_allowed)."""
    src = _source_for(cluster, prefs)
    if src is None:
        return True
    if not src.auto_correlate():
        return False
    feeds = src.feeds()
    if not feeds:
        return True
    by_id = {f.id: f for f in feeds}
    for ev in cluster.member_events:
        feed = _feed_for_event(ev, feeds, by_id)
        if feed is not None and not feed.effective_auto_investigate():
            return False
    return True


def _on_allowlist(cluster: Cluster, prefs: Preferences) -> bool:
    """Whether an events-role cluster's rules clear the auto-forward allowlist. An
    alerts-role cluster (``is_alert``) always clears it (SIEM detections auto-forward),
    matching ``handle_clusters``' ``cluster.is_alert or wildcard or any(...)``."""
    if cluster.is_alert:
        return True
    allow = set(prefs.auto_forward_allowlist)
    if "*" in allow:
        return True
    return any(r in allow for r in cluster.rule_values)


# --------------------------------------------------------------------------- #
# The public narrator.
# --------------------------------------------------------------------------- #
def explain_forwarding(cluster: Cluster, prefs: Preferences) -> ForwardingExplanation:
    """Explain, read-only, WHICH gate decided auto-investigation for ``cluster``.

    Walks the SAME ordered gates as :func:`app.engine.ingest.handle_clusters` and
    returns a :class:`ForwardingExplanation` naming the FIRST deciding gate. Advisory
    only — it NEVER calls ``decide()`` and never mutates anything (#3)."""
    sid = cluster.source_id
    is_alert = bool(cluster.is_alert)
    notes: list[str] = []

    # Advisory cost/budget context (NOT a forwarding gate — surfaced only). It never
    # overrides the seven gates below; the pre-flight BudgetGate fails safe to
    # NEEDS_HUMAN downstream (#3), never a silent close.
    if not _passes_suppression(cluster, prefs):
        pass  # handled as gate #2 below
    if prefs.caps.kill_switch:
        notes.append("kill switch is engaged (all investigations are stopped)")

    floor = float(prefs.auto_investigate_risk_floor)

    def _mk(gate: str, forwarded: bool, dropped: bool, sentence: str,
            routing_total: float | None = None, gate_applied: bool = False) -> ForwardingExplanation:
        return ForwardingExplanation(
            gate=gate, forwarded=forwarded, dropped=dropped, sentence=sentence,
            source_id=sid, is_alert=is_alert, notes=notes,
            routing_total=routing_total, risk_floor=floor, routing_gate_applied=gate_applied,
        )

    # 1) IGNORE feed — the only role that DROPS entirely (no case, no candidate).
    if _is_ignored(cluster, prefs):
        return _mk(
            "ignored", forwarded=False, dropped=True,
            sentence="Dropped: every member event belongs to an IGNORE feed (muted at ingest).",
        )

    # 2) Suppression — an entirely-suppressed cluster is the intended drop.
    if not _passes_suppression(cluster, prefs):
        return _mk(
            "suppressed", forwarded=False, dropped=True,
            sentence="Dropped: every member event matches a live suppression rule.",
        )

    # 3) Global automated-investigation switch.
    if not prefs.background_scan_enabled:
        return _mk(
            "background_scan", forwarded=False, dropped=False,
            sentence="Registered as a candidate for manual triage: automated background "
                     "investigation is disabled (background_scan_enabled is off).",
        )

    # 4) Per-feed severity_floor — below-floor on every member → candidate (never dropped).
    if not cluster.auto_investigate_eligible:
        return _mk(
            "severity_floor", forwarded=False, dropped=False,
            sentence="Registered as a candidate: every member event is below its feed's "
                     "severity_floor, so the cluster is not auto-forwarded (but is still "
                     "correlated and never dropped).",
        )

    # 5) Per-source / per-feed Auto-Correlate toggle.
    if not _auto_correlate_allowed(cluster, prefs):
        return _mk(
            "auto_correlate", forwarded=False, dropped=False,
            sentence="Registered as a candidate: the Auto-Correlate toggle is off for this "
                     "source or one of its feeds, routing the cluster to manual triage.",
        )

    # 6) Events clusters forward when explicitly allowlisted OR when their
    # available-signal routing score reaches the configured floor. Reputation is
    # unknown before investigation, exactly as in handle_clusters.
    routing_score = compute_routing_risk(cluster, prefs, reputation=None).total
    floor_applies = not _on_allowlist(cluster, prefs)
    if floor_applies and routing_score < prefs.auto_investigate_risk_floor:
        return _mk(
            "risk_floor", forwarded=False, dropped=False,
            sentence=(
                "Registered as a candidate: its rules are not on the auto-forward "
                f"allowlist and its available-signal routing score {int(routing_score)} "
                f"is below the configured floor {prefs.auto_investigate_risk_floor}."
            ),
            routing_total=routing_score, gate_applied=True,
        )

    # 7) All gates passed → auto-forwarded to the investigator.
    if is_alert:
        why = "it is an alerts-role SIEM detection"
    elif _on_allowlist(cluster, prefs):
        why = "its rules are on the auto-forward allowlist"
    else:
        why = (
            f"its available-signal routing score {int(routing_score)} reaches the "
            f"configured floor {prefs.auto_investigate_risk_floor}"
        )
    return _mk(
        "forwarded", forwarded=True, dropped=False,
        sentence=f"Auto-investigated: background scan is on, the cluster is above its "
                 f"severity_floor, Auto-Correlate is on, and {why}.",
        routing_total=routing_score, gate_applied=floor_applies,
    )
