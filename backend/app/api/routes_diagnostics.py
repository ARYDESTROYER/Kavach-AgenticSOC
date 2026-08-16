"""Operator diagnostics: make the SILENT failures observable.

Every defect in the precedent/auto-close incident was silent. An operator changed an
unrelated setting, the precedent corpus collapsed, auto-close stopped forever, and the
only trace in the whole system was ``RAG seeded with 20 chunk(s)`` at INFO — a line
that reads exactly the same whether N is 2000 or 0. This router turns each of those
into a DIAGNOSABLE STATE an operator can actually see:

* **Precedent-corpus health** — corpus size, per-source chunk/document counts, the last
  projection's per-source before/after deltas (``RagService.last_projection``), and an
  explicit boolean for "0 analyst-confirmed precedents available". Paired with the
  analyst-confirmed ground truth actually present in the case history, so "nobody has
  graded anything" is distinguishable from "the projection is broken".
* **SQL schema-migration state** — ``stores.sql.engine.SCHEMA_MIGRATION_STATUS``. A
  ``failed`` state means privileged strict audit writes (proposal approve/reject) are
  broken; that must never be invisible.
* **Auto-close health** — the rolling rate from :func:`engine.metrics.auto_close_health`,
  which distinguishes an auto-close collapse from a quiet period.

Design notes:

* **Authenticated, RBAC-gated, and deliberately NOT on ``/api/health``.** That endpoint
  is public (the Console reads it before login), and publishing corpus counts, per-source
  detection posture and state-backend internals there would hand an anonymous caller a
  read on the deployment. This surface gates on the existing ``settings:read`` grant —
  the same read-only operator grant every built-in role already holds and the one an
  operator uses to diagnose configuration — following the ``routes_schedulers.py``
  precedent of picking the grant of the page that consumes the evidence.
* **Read-only.** No writes, no LLM, no seeding: the corpus is read through the
  seed-free ``snapshot_documents_strict`` seam so merely *asking* about corpus health
  can never trigger an embedding spend or mutate the projection.
* **Honest about unknowns.** ``RagService.last_projection`` is in-process only and empty
  until the first projection in that process; that is reported as ``not_yet_projected``,
  never as a zero that looks like a collapse. Every signal that could not be evaluated
  is listed in ``unknowns`` so insufficient evidence stays explicit.
* **Advisory (#3).** Nothing here is read by ``case_manager.decide()``; the auto-close
  policy and the corpus counts are displayed, never fed back.
* **No prompt path (#9).** Corpus source labels are sanitised at write time and are
  returned here as plain JSON the UI renders escaped — exactly as ``GET /api/rag/stats``
  already does. Nothing on this surface ever reaches a model prompt, and no secret,
  case id, document text, or chunk content is returned.
* **Additive + default-safe (#10).** New read-only endpoints only — no new background
  behaviour, no new configuration, existing deployments are byte-identical.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Query

from ..engine.metrics import (
    analyst_confirmed_case_ids,
    auto_close_health,
    precedent_ground_truth,
)
from ..engine.precedent import (
    evaluate_futility,
    rule_outcome_tally,
    unavailable_distribution,
)
from ..state import AppState
from ..utils import iso_now
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.diagnostics")
router = APIRouter(prefix="/api")

# Bound the case read exactly like the posture rollups do. The response carries the
# truncation marker so a partial (newest-N) tally is never presented as a complete one.
_STORE_FETCH_LIMIT = 5000

# The RAG source that holds analyst-confirmed precedent. Imported lazily in
# :func:`_precedent_source` so this router can still report a degraded-but-honest
# answer if the RAG module is unavailable on a stripped deployment.
_PRECEDENT_SOURCE_FALLBACK = "resolved_case"


def _precedent_source() -> str:
    try:
        from ..tools.rag import RESOLVED_CASE_SOURCE

        return str(RESOLVED_CASE_SOURCE)
    except Exception:  # noqa: BLE001 — diagnostics must never fail on an import
        return _PRECEDENT_SOURCE_FALLBACK


async def _load_cases(state: AppState) -> tuple[list, int]:
    """Newest-first case page + the store's reported total. A store error degrades to
    an empty page rather than failing the request; the caller reports the gap."""
    try:
        cases, total = await state.cases.list(limit=_STORE_FETCH_LIMIT)
        return list(cases), int(total)
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("diagnostics case load soft-failed: %s", exc)
        return [], 0


def _projection_block(rag: Any) -> dict[str, Any]:
    """The last RAG projection outcome, per source, or an HONEST not-yet-projected.

    ``RagService.last_projection`` is published on every projection and is IN-PROCESS
    ONLY: it is empty until the first projection runs in this process (and after a
    restart). Reporting that as a set of zeroes would manufacture exactly the false
    "the corpus collapsed" signal this endpoint exists to make trustworthy, so the
    empty state is reported as ``not_yet_projected`` with ``available: false``."""
    raw = getattr(rag, "last_projection", None) if rag is not None else None
    if not isinstance(raw, dict) or not raw:
        return {
            "available": False,
            "state": "not_yet_projected",
            "scope": "in_process",
            "reason": (
                "no RAG projection has run in this process yet, so per-source "
                "before/after counts are unknown (this record does not survive a "
                "restart); it is not evidence of an empty or collapsed corpus"
            ),
            "sources": {},
            "shrank_sources": [],
            "collapsed_sources": [],
        }
    sources: dict[str, Any] = {}
    shrank: list[str] = []
    collapsed: list[str] = []
    for name, row in raw.items():
        if not isinstance(row, dict):
            continue
        key = str(name)
        sources[key] = dict(row)
        enabled = bool(row.get("source_enabled", True))
        # A source the operator just turned OFF is EXPECTED to go to zero; only a
        # still-enabled source shrinking is a defect worth surfacing.
        if enabled and bool(row.get("shrank")):
            shrank.append(key)
        if enabled and bool(row.get("collapsed")):
            collapsed.append(key)
    return {
        "available": True,
        "state": "recorded",
        "scope": "in_process",
        "reason": "",
        "sources": sources,
        "shrank_sources": sorted(shrank),
        "collapsed_sources": sorted(collapsed),
    }


async def _corpus_snapshot(rag: Any) -> tuple[bool, str, list[dict[str, Any]]]:
    """Read persisted document metadata WITHOUT seeding or embedding.

    Returns ``(available, reason, documents)``. ``available`` is False only when the
    store could not be read at all — an empty list from a healthy store is a real,
    trustworthy zero, and the two are never conflated."""
    if rag is None:
        return False, "the RAG service is not wired on this deployment", []
    strict = getattr(rag, "snapshot_documents_strict", None)
    if strict is not None:
        try:
            rows = await strict()
            return True, "", [r for r in rows if isinstance(r, dict)]
        except Exception as exc:  # noqa: BLE001 — an outage must read as unknown
            logger.warning("diagnostics corpus snapshot soft-failed: %s", exc)
            return False, f"the vector store could not be read ({type(exc).__name__})", []
    snapshot = getattr(rag, "snapshot_documents", None)
    if snapshot is None:
        return False, "this RAG service exposes no read-only corpus snapshot", []
    try:
        rows = await snapshot()
    except Exception as exc:  # noqa: BLE001
        logger.warning("diagnostics corpus snapshot soft-failed: %s", exc)
        return False, f"the vector store could not be read ({type(exc).__name__})", []
    return True, "", [r for r in rows if isinstance(r, dict)]


async def _precedent_corpus_block(state: AppState, cases: list, store_total: int) -> dict[str, Any]:
    """Precedent-corpus health: size, per-source counts, and the explicit starvation
    flag — plus the analyst-confirmed ground truth the case history actually holds, so
    a labelling gap ("nobody has graded anything") is distinguishable from a broken
    projection ("hundreds of confirmed outcomes, zero precedent in the corpus")."""
    rag = getattr(state, "rag_service", None)
    rag_cfg = getattr(getattr(state, "prefs", None), "rag", None)
    rag_enabled = bool(getattr(rag_cfg, "enabled", False))
    precedent_enabled = bool(getattr(rag_cfg, "use_resolved_cases", False))
    # The optional LOWER-TRUST precedent tier shares the same corpus source, so when it
    # is on, a raw per-source document count is NOT an analyst-confirmed count.
    unconfirmed_enabled = bool(
        precedent_enabled and getattr(rag_cfg, "use_unconfirmed_resolved_cases", False)
    )
    source = _precedent_source()

    available, reason, docs = await _corpus_snapshot(rag)
    chunks_by_source: dict[str, int] = {}
    documents_by_source: dict[str, int] = {}
    precedent_document_ids: set[str] = set()
    total_chunks = 0
    for row in docs:
        name = str(row.get("source") or "unknown")
        try:
            count = max(0, int(row.get("chunk_count") or 0))
        except (TypeError, ValueError):
            count = 0
        chunks_by_source[name] = chunks_by_source.get(name, 0) + count
        documents_by_source[name] = documents_by_source.get(name, 0) + 1
        total_chunks += count
        if name == source:
            precedent_document_ids.add(str(row.get("document_id") or ""))

    precedent_documents = int(documents_by_source.get(source, 0))
    precedent_chunks = int(chunks_by_source.get(source, 0))

    # How many of those precedent documents are ANALYST-CONFIRMED.
    #
    # With only the confirmed tier active (the default) every precedent document is
    # analyst-confirmed by construction, so the per-source count is exact. With the
    # lower-trust tier enabled the two share a source, so the confirmed subset is
    # counted by intersecting the corpus's precedent document ids with the ids the
    # confirmed projection would produce for the fetched cases — exact whenever the
    # whole case store was fetched, and an explicit LOWER BOUND when it was not (which
    # is reported rather than allowed to fake a starvation).
    confirmed_exact = True
    if unconfirmed_enabled:
        confirmed_ids = {
            f"{source}:{case_id}" for case_id in analyst_confirmed_case_ids(cases)
        }
        analyst_confirmed_documents = len(precedent_document_ids & confirmed_ids)
        confirmed_exact = store_total <= len(cases)
    else:
        analyst_confirmed_documents = precedent_documents

    # The explicit boolean the incident report asked for. It is True ONLY when we
    # positively KNOW the corpus holds no analyst-confirmed precedent; ``known`` says
    # whether the flag means anything at all, so an unreadable store (or a bounded
    # lower-bound count) can never be mistaken for a confirmed zero (and vice versa).
    known = bool(available and confirmed_exact)
    zero_precedents = bool(known and analyst_confirmed_documents == 0)

    if not available:
        status = "unknown"
        status_reason = reason
    elif not confirmed_exact:
        status = "unknown"
        status_reason = (
            "the lower-trust precedent tier shares this corpus source and the case "
            "store was only partially fetched, so the analyst-confirmed count is a "
            "lower bound rather than a confirmed total"
        )
    elif not rag_enabled:
        status = "disabled"
        status_reason = "retrieval is turned off, so no precedent is reachable by an investigation"
    elif not precedent_enabled:
        status = "disabled"
        status_reason = (
            "the resolved-case precedent source is turned off, so a zero precedent "
            "count is the configured behaviour"
        )
    elif zero_precedents:
        status = "starved"
        status_reason = (
            "the precedent source is enabled but the corpus holds 0 analyst-confirmed "
            "precedents; auto-close comparisons have no institutional memory to work from"
        )
    else:
        status = "ok"
        status_reason = ""

    return {
        # ``available`` — the corpus itself could be read.
        # ``known``     — the analyst-confirmed count below is a trustworthy TOTAL
        #                 (readable corpus AND an exact, non-lower-bound count).
        "available": bool(available),
        "known": known,
        "reason": reason,
        "status": status,
        "status_reason": status_reason,
        "rag_enabled": rag_enabled,
        "precedent_source": source,
        "precedent_source_enabled": precedent_enabled,
        "unconfirmed_tier_enabled": unconfirmed_enabled,
        "precedent_documents": precedent_documents,
        "precedent_chunks": precedent_chunks,
        "analyst_confirmed_precedent_documents": analyst_confirmed_documents,
        # False when the count above is a bounded LOWER BOUND rather than a total.
        "analyst_confirmed_count_exact": bool(available and confirmed_exact),
        # THE flag: "0 analyst-confirmed precedents available", as a diagnosable state.
        "zero_analyst_confirmed_precedents": zero_precedents,
        # True only when the source is ENABLED and positively known to be empty.
        "starved": bool(status == "starved"),
        "total_chunks": total_chunks,
        "total_documents": len(docs),
        "chunks_by_source": dict(sorted(chunks_by_source.items())),
        "documents_by_source": dict(sorted(documents_by_source.items())),
        "projection": _projection_block(rag),
        "ground_truth": precedent_ground_truth(cases, store_total=store_total),
    }


_MAX_DISTRIBUTION_ROWS = 50
_MAX_FUTILE_RULES = 20


async def _precedent_effectiveness_block(state: AppState, cases: list) -> dict[str, Any]:
    """Is the precedent an operator has built actually CHANGING anything?

    Two silent failures live here, and both cost an operator real review time:

    * **Starvation by success.** The bounded precedent window is filled newest-first, so
      a bulk analyst action on ONE rule can evict every other rule's precedent — the
      precedent-corpus outage again, this time triggered by an operator doing exactly
      what the product asked of them. Publishing the per-rule distribution makes that
      visible BEFORE it bites, instead of after auto-close collapses.
    * **Futility.** For a detection whose alerts carry no per-case evidence, an
      investigation can never verify that THIS instance is benign, so it keeps routing
      to a human however much confirmed history stands behind the rule. The product
      nonetheless asks for more confirmations — indefinitely, with no signal that they
      cannot help. Naming those rules, with the two remedies that CAN work, is the
      difference between a dead end and a decision.

    Read-only, seed-free and advisory (#3). Every count is honest about its bound: an
    unreadable corpus reports ``available: false`` rather than an empty distribution, and
    a truncated corpus read marks its counts as a lower bound.
    """
    rag = getattr(state, "rag_service", None)
    prefs = getattr(state, "prefs", None)
    block = getattr(prefs, "precedent", None)
    promotion = getattr(block, "promotion", None)
    futility_cfg = getattr(block, "futility", None)
    window_cfg = getattr(block, "window", None)

    reader = getattr(rag, "precedent_distribution", None) if rag is not None else None
    if reader is None:
        distribution = unavailable_distribution(
            "this deployment's retrieval service does not expose a per-rule precedent "
            "distribution"
        )
    else:
        try:
            distribution = await reader()
        except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
            logger.warning("diagnostics precedent distribution soft-failed: %s", exc)
            distribution = unavailable_distribution(
                f"the precedent corpus could not be read ({type(exc).__name__})"
            )

    tallies = rule_outcome_tally(cases)
    # WHY the report did not run matters as much as its result. An empty ``futile_rules``
    # can mean "measured, nothing found" or "never evaluated", and rendering the second
    # as the first puts a green badge on a deployment nobody has actually checked.
    if futility_cfg is None:
        futility_measured, futility_reason = False, (
            "this deployment has no precedent-futility configuration, so the report did "
            "not run"
        )
    elif not bool(getattr(futility_cfg, "enabled", True)):
        futility_measured, futility_reason = False, (
            "precedent-futility reporting is turned off for this deployment"
        )
    elif distribution.disabled:
        futility_measured, futility_reason = False, distribution.reason
    elif not distribution.available:
        futility_measured, futility_reason = False, (
            distribution.reason or "the precedent corpus could not be read"
        )
    elif distribution.truncated:
        # A truncated read yields LOWER BOUNDS. Recommending that an operator
        # permanently declare a rule benign on evidence that could not be fully read is
        # exactly the kind of confident-looking wrong answer this surface exists to
        # prevent, so the report is withheld rather than published.
        futility_measured, futility_reason = False, (
            "the precedent corpus read was truncated, so per-rule counts are lower "
            "bounds and cannot support a recommendation"
        )
    else:
        futility_measured, futility_reason = True, ""

    futile = (
        evaluate_futility(
            distribution=distribution,
            tallies=tallies,
            config=futility_cfg,
            promotion_enabled=bool(getattr(promotion, "enabled", False)),
        )
        if futility_measured
        else []
    )
    return {
        "promotion_enabled": bool(getattr(promotion, "enabled", False)),
        "promotion_min_confirmed": int(getattr(promotion, "min_confirmed", 0) or 0),
        "window_size": int(getattr(window_cfg, "size", 0) or 0),
        "window_stratified": bool(getattr(window_cfg, "stratify_by_rule", False)),
        "distribution": distribution.as_dict(limit=_MAX_DISTRIBUTION_ROWS),
        # True only when the report actually ran; ``futility_reason`` says why not.
        "futility_measured": futility_measured,
        "futility_reason": futility_reason,
        "futile_rules": futile[:_MAX_FUTILE_RULES],
        "futile_rule_count": len(futile),
    }


def _schema_migration_block(state: AppState) -> dict[str, Any]:
    """The in-place SQL schema-migration outcome.

    A ``failed`` state means privileged STRICT audit writes — proposal approve/reject
    and the update control plane — are broken on this deployment. That is precisely the
    class of failure that must not stay invisible, so the remediation SQL travels with
    the state."""
    backend = str(getattr(getattr(state, "secrets", None), "state_backend", "") or "")
    try:
        from ..stores.sql.engine import SCHEMA_MIGRATION_STATUS

        raw = dict(SCHEMA_MIGRATION_STATUS)
    except Exception as exc:  # noqa: BLE001 — SQLAlchemy is optional on a core image
        return {
            "available": False,
            "state": "not_applicable",
            "state_backend": backend,
            "detail": "",
            "remediation": "",
            "failed": False,
            "reason": f"the SQL state backend is not installed ({type(exc).__name__})",
        }
    migration_state = str(raw.get("state") or "not_applicable")
    return {
        "available": True,
        "state": migration_state,
        "state_backend": backend,
        "detail": str(raw.get("detail") or ""),
        "remediation": str(raw.get("remediation") or ""),
        "failed": migration_state == "failed",
        "reason": "",
    }


def _alert(severity: str, alert_id: str, title: str, detail: str, remediation: str = "") -> dict[str, str]:
    return {
        "id": alert_id,
        "severity": severity,
        "title": title,
        "detail": detail,
        "remediation": remediation,
    }


def _build_alerts(
    precedent: dict[str, Any],
    migration: dict[str, Any],
    auto_close: dict[str, Any],
    effectiveness: dict[str, Any] | None = None,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Turn the three blocks into an operator-readable ``(alerts, unknowns)`` pair.

    ``alerts`` are POSITIVELY DETECTED conditions. ``unknowns`` are signals that could
    not be evaluated — kept separate and explicit so an empty ``alerts`` list is never
    silently read as "everything is fine" when it actually means "we could not tell"."""
    alerts: list[dict[str, str]] = []
    unknowns: list[dict[str, str]] = []

    if not precedent["known"]:
        unknowns.append(
            _alert(
                "unknown", "precedent_corpus_unreadable",
                "Analyst-confirmed precedent count is unknown",
                precedent.get("reason")
                or precedent.get("status_reason")
                or "the corpus could not be read",
                "Check the vector store / state backend connectivity.",
            )
        )
    elif precedent["starved"]:
        alerts.append(
            _alert(
                "critical", "precedent_corpus_starved",
                "0 analyst-confirmed precedents available",
                precedent["status_reason"],
                "Confirm case outcomes (analyst feedback or an explicit disposition) so "
                "precedent can be projected, and verify the resolved-case RAG source.",
            )
        )

    projection = precedent.get("projection") or {}
    if projection.get("available"):
        for name in projection.get("collapsed_sources") or []:
            alerts.append(
                _alert(
                    "critical", f"rag_source_collapsed:{name}",
                    f"RAG source '{name}' collapsed to zero on the last projection",
                    f"{name} went to 0 chunk(s) while it is still enabled.",
                    "Inspect the projection inputs before re-seeding; the previous corpus is gone.",
                )
            )
        for name in projection.get("shrank_sources") or []:
            if name in (projection.get("collapsed_sources") or []):
                continue
            alerts.append(
                _alert(
                    "warning", f"rag_source_shrank:{name}",
                    f"RAG source '{name}' shrank on the last projection",
                    f"{name} lost chunks while it is still enabled.",
                    "Confirm the shrink was intended; a re-seed must never silently shrink a source.",
                )
            )
    else:
        unknowns.append(
            _alert(
                "unknown", "rag_projection_unknown", "Last RAG projection outcome is unknown",
                str(projection.get("reason") or "no projection has been recorded in this process"),
                "",
            )
        )

    if migration.get("failed"):
        alerts.append(
            _alert(
                "critical", "sql_schema_migration_failed",
                "SQL schema migration failed — strict audit writes are broken",
                str(migration.get("detail") or "the in-place schema migration did not apply"),
                str(migration.get("remediation") or ""),
            )
        )

    ac_status = str(auto_close.get("status") or "")
    if ac_status == "collapsed":
        alerts.append(
            _alert(
                "critical", "auto_close_collapsed", "Auto-close rate collapsed",
                str(auto_close.get("reason") or ""),
                "Check the precedent corpus, the investigation path, and the auto-close policy "
                "thresholds — decided volume held steady, so this is not a quiet period.",
            )
        )
    elif ac_status == "never_fired":
        alerts.append(
            _alert(
                "warning", "auto_close_never_fired", "Auto-close is enabled but has never fired",
                str(auto_close.get("reason") or ""),
                "Verify the confidence/risk bars in the auto-close policy are reachable.",
            )
        )
    elif ac_status == "degraded":
        alerts.append(
            _alert(
                "warning", "auto_close_degraded", "Auto-close rate dropped sharply",
                str(auto_close.get("reason") or ""), "",
            )
        )
    elif ac_status in ("insufficient_evidence", "no_volume"):
        unknowns.append(
            _alert(
                "unknown", f"auto_close_{ac_status}", "Auto-close health could not be measured",
                str(auto_close.get("reason") or ""), "",
            )
        )

    # Precedent effectiveness — the "more confirmations will not help" signal. This is a
    # WARNING, not a critical: nothing is broken, but the operator is currently being
    # asked to spend review time on something that cannot change the outcome.
    if effectiveness:
        distribution = effectiveness.get("distribution") or {}
        if distribution.get("disabled"):
            # The operator turned the precedent source off. That is configured
            # behaviour, not an unmeasurable signal, and reporting it as an unknown
            # would permanently deny a correctly-configured deployment a clean bill of
            # health — the same distinction the corpus block already makes.
            pass
        elif not distribution.get("available"):
            unknowns.append(
                _alert(
                    "unknown", "precedent_distribution_unknown",
                    "Per-rule precedent distribution is unknown",
                    str(distribution.get("reason") or "the corpus could not be read"),
                    "Check the vector store / state backend connectivity.",
                )
            )
        elif distribution.get("truncated"):
            unknowns.append(
                _alert(
                    "unknown", "precedent_distribution_truncated",
                    "Per-rule precedent counts are a lower bound",
                    "The precedent corpus read hit its scan ceiling, so every per-rule "
                    "count below is a lower bound. Precedent promotion and the "
                    "'more confirmations will not help' report are both withheld rather "
                    "than answered from a partial read.",
                    "Reduce the corpus, or move to a backend that can read it whole.",
                )
            )
        if not effectiveness.get("futility_measured") and not distribution.get("disabled"):
            unknowns.append(
                _alert(
                    "unknown", "precedent_futility_not_measured",
                    "Whether analyst precedent is helping could not be measured",
                    str(effectiveness.get("futility_reason") or "the report did not run"),
                    "",
                )
            )
        for row in effectiveness.get("futile_rules") or []:
            alerts.append(
                _alert(
                    "warning",
                    f"precedent_not_effective:{row.get('rule_identity')}",
                    f"Analyst precedent is not changing the outcome for {row.get('rules')}",
                    str(row.get("detail") or ""),
                    str(row.get("remediation") or ""),
                )
            )
        unattributed = int(distribution.get("unattributed_documents") or 0)
        if distribution.get("available") and unattributed > 0:
            unknowns.append(
                _alert(
                    "unknown", "precedent_rule_identity_missing",
                    f"{unattributed} precedent document(s) carry no rule identity",
                    "These were projected before rule identity became precedent metadata, "
                    "so they are retrievable but cannot be rule-matched or counted per "
                    "rule. They are reported separately rather than counted as absent.",
                    "They are re-tagged automatically on the next retrieval projection; "
                    "re-confirm or re-index the affected cases to converge sooner.",
                )
            )

    return alerts, unknowns


@router.get("/diagnostics/health")
async def diagnostics_health(
    window_hours: int = Query(default=24, ge=1, le=8760),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """The operator diagnostics roll-up for the conditions that used to fail silently.

    Returns the precedent-corpus health signal (size, per-source projection counts, and
    the explicit "0 analyst-confirmed precedents available" flag), the SQL
    schema-migration state, and the rolling auto-close health signal — plus a flat
    ``alerts`` list of positively-detected conditions and a SEPARATE ``unknowns`` list
    of signals that could not be evaluated, so an empty ``alerts`` is never mistaken for
    a clean bill of health. There is no composite health score — only the two counts.

    Authenticated and gated on ``settings:read``. This detail is deliberately NOT on the
    public ``GET /api/health``: corpus counts and per-source detection posture must not
    be readable by an anonymous caller.

    Read-only and seed-free — asking about corpus health never triggers an embedding
    spend, a projection, or any write. Advisory only; never read by ``decide()`` (#3)."""
    cases, store_total = await _load_cases(state)
    precedent = await _precedent_corpus_block(state, cases, store_total)
    effectiveness = await _precedent_effectiveness_block(state, cases)
    migration = _schema_migration_block(state)
    auto_close = auto_close_health(
        cases,
        window_hours=int(window_hours),
        policy=getattr(getattr(state, "prefs", None), "auto_close", None),
        store_total=store_total,
    )
    alerts, unknowns = _build_alerts(precedent, migration, auto_close, effectiveness)
    return {
        "generated_at": iso_now(),
        "window_hours": int(window_hours),
        "demo_active": bool(getattr(state, "demo_active", False)),
        "state_backend": str(getattr(getattr(state, "secrets", None), "state_backend", "") or ""),
        "precedent_corpus": precedent,
        # Per-rule precedent distribution + the "more confirmations will not help"
        # finding. Advisory; never read by decide() (#3).
        "precedent_effectiveness": effectiveness,
        "schema_migration": migration,
        "auto_close": auto_close,
        "alerts": alerts,
        "unknowns": unknowns,
        # Plain counts, deliberately NOT a composite health score: "no alerts" and
        # "nothing could be measured" are different answers and stay separable.
        "alert_count": len(alerts),
        "unknown_count": len(unknowns),
    }
