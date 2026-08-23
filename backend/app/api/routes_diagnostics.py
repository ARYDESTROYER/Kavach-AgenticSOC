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

from ..constants import CaseStatus
from ..engine.analyst_outcomes import analyst_confirmed_outcome
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
from .metrics_shared import fetch_case_page

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
    an empty page rather than failing the request; the caller reports the gap.

    Served through the SHARED short-TTL page cache (``api/metrics_shared``) — the
    Overview health strip fires this endpoint alongside the posture/noise rollups
    every refresh, and all of them read the same newest-N page. The cache is keyed by
    (store identity, fetch limit), so a monkeypatched ``_STORE_FETCH_LIMIT`` or a
    Demo Mode store swap always bypasses stale pages."""
    try:
        cases, total = await fetch_case_page(state.cases, _STORE_FETCH_LIMIT)
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
        # True only when the emptiness is a DEGRADATION (previously projected or
        # seeding already ran), never on a cold start.
        "corpus_degraded": bool(getattr(rag, "corpus_degraded", False)),
        "projection": _projection_block(rag),
        "ground_truth": precedent_ground_truth(cases, store_total=store_total),
        # The last REFUSED projection (in-process, falling back to the durable
        # record so a restart does not erase the evidence).
        "last_refusal": await _last_refusal(rag),
        # "N documents vs M qualifying source records" — see _reconciliation_block.
        "reconciliation": _reconciliation_block(
            rag_cfg,
            window=getattr(getattr(state, "prefs", None), "precedent", None),
            available=available,
            rag_enabled=rag_enabled,
            precedent_enabled=precedent_enabled,
            confirmed_exact=confirmed_exact,
            analyst_confirmed_documents=analyst_confirmed_documents,
            ground_truth=precedent_ground_truth(cases, store_total=store_total),
            projectable_records=_projectable_precedent_records(cases),
            corpus_may_be_truncated=_corpus_may_be_truncated(rag, total_chunks),
        ),
    }


def _projectable_precedent_records(cases: list) -> int:
    """Analyst-confirmed cases the precedent projection can ACTUALLY draw from.

    Deliberately NOT ``precedent_ground_truth()["analyst_confirmed_cases"]``: that
    counts every analyst-confirmed case regardless of status, while the projection
    scans only CLOSED and RESOLVED cases (see ``RagService._resolved_case_items``).
    Analyst feedback on an escalated or in-progress case is perfectly ordinary, and
    counting it as projectable would manufacture a deficit against a corpus that is
    behaving exactly as designed. The two must be measured over the same population.
    """
    terminal = {CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value}
    count = 0
    for case in cases:
        status = getattr(getattr(case, "status", None), "value", None)
        if str(status or "") not in terminal:
            continue
        if analyst_confirmed_outcome(case)[0] is not None:
            count += 1
    return count


async def _last_refusal(rag: Any) -> dict[str, Any]:
    """The last refused/failed projection: in-process first, durable record second.

    The in-process value is authoritative when present (it is this process's own
    truth); the persisted record covers the restart that erased the evidence both
    times this happened in production. Fail-open — never breaks the endpoint.
    """
    live = getattr(rag, "last_refusal", None)
    if isinstance(live, dict) and live:
        return {**live, "scope": "in_process"}
    health = getattr(rag, "_health", None)
    if health is None:
        return {}
    try:
        doc = await health.load()
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("RAG health record read soft-failed: %s", exc)
        return {}
    stored = (doc or {}).get("last_refusal")
    if isinstance(stored, dict) and stored:
        return {**stored, "scope": "durable"}
    return {}


def _corpus_may_be_truncated(rag: Any, total_chunks: int) -> bool:
    """Whether the corpus read may have hit its backend scan ceiling.

    The ES vector store answers document metadata from ONE bounded page, so a corpus
    at that ceiling may have been cut short — and a reconciliation built on a
    truncated read would manufacture a deficit on any large corpus. Fail SAFE: if we
    cannot tell, treat the read as possibly truncated.
    """
    probe = getattr(rag, "_read_may_be_truncated", None)
    if probe is None:
        return False
    try:
        return bool(probe(int(total_chunks)))
    except Exception:  # noqa: BLE001
        return True


def _reconciliation_block(
    rag_cfg: Any,
    *,
    window: Any,
    available: bool,
    precedent_enabled: bool,
    confirmed_exact: bool,
    analyst_confirmed_documents: int,
    ground_truth: dict[str, Any],
    corpus_may_be_truncated: bool,
    rag_enabled: bool = True,
    projectable_records: int | None = None,
) -> dict[str, Any]:
    """Compare the corpus (N) with the qualifying source history (M).

    The corpus is a PROJECTION of the case history. The source of truth survived both
    incidents intact — 892 analyst-confirmed cases were still in the database while the
    corpus held zero — so comparing the two is the earliest available signal that the
    projection, rather than the history, is what broke.

    ``N < M`` is NORMAL and never alerts: the precedent projection is a bounded window
    over the newest qualifying cases, so the honest expectation is
    ``min(M, window_size)``. A deficit is only claimed when the corpus holds less than
    ``rag.min_projection_retention`` of that expectation — the same floor the projection
    guard itself uses, so the two cannot disagree.

    Every uncertainty is reported as a ``reason`` and NOT as a deficit: an unreadable
    corpus, a lower-bound confirmed count, a truncated case read and a truncated corpus
    read all mean "we could not tell", which is a different answer from "the corpus is
    fine".
    """
    block: dict[str, Any] = {
        "measured": False,
        "deficit": False,
        "reason": "",
        "detail": "",
        "corpus_documents": int(analyst_confirmed_documents),
        "qualifying_source_records": None,
        "expected_documents": None,
        "window_size": None,
    }
    if not rag_enabled or not precedent_enabled:
        # Configured behaviour, not an unmeasurable signal. Retrieval switched off
        # means no precedent is projected on purpose; alerting on that would report a
        # correctly-configured deployment as broken.
        block["reason"] = ""
        return block
    if not available:
        block["reason"] = "the corpus could not be read"
        return block
    if not confirmed_exact:
        block["reason"] = (
            "the analyst-confirmed corpus count is a lower bound rather than a total"
        )
        return block
    if corpus_may_be_truncated:
        block["reason"] = (
            "the corpus read hit its scan ceiling, so the document count is a lower bound"
        )
        return block
    if not isinstance(ground_truth, dict) or ground_truth.get("truncated"):
        block["reason"] = (
            "the case history read was truncated, so the qualifying-record count is a "
            "lower bound"
        )
        return block
    # Count only what the projection can actually draw from (terminal + confirmed).
    qualifying = (
        projectable_records
        if isinstance(projectable_records, int)
        else ground_truth.get("analyst_confirmed_cases")
    )
    if not isinstance(qualifying, int):
        block["reason"] = "the qualifying analyst-confirmed record count is unavailable"
        return block

    # The operator's bounded precedent window (prefs.precedent.window).
    try:
        from ..config import PrecedentWindowConfig

        configured = getattr(window, "window", None)
        window_size = int(
            getattr(configured, "size", None) or PrecedentWindowConfig().size
        )
    except Exception:  # noqa: BLE001
        window_size = 200
    expected = min(int(qualifying), max(0, window_size))
    block.update(
        measured=True,
        qualifying_source_records=int(qualifying),
        expected_documents=int(expected),
        window_size=int(window_size),
    )
    if expected <= 0:
        # Nothing qualifies yet: an empty corpus is a labelling gap, not a defect.
        return block
    retention = float(getattr(rag_cfg, "min_projection_retention", 0.0) or 0.0)
    # Even with the ratio guard disabled, a total absence against a qualifying history
    # is still a deficit — that is the exact shape of both incidents.
    floor = expected * retention if retention > 0.0 else 0.0
    if analyst_confirmed_documents < floor or (
        expected > 0 and analyst_confirmed_documents == 0
    ):
        block["deficit"] = True
        block["detail"] = (
            f"the corpus holds {analyst_confirmed_documents} analyst-confirmed "
            f"precedent document(s) but the case history qualifies {qualifying} "
            f"record(s) (expected about {expected} within the current window of "
            f"{window_size})"
        )
    return block


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


def _provider_health_block(state: AppState) -> dict[str, Any]:
    """Aggregate LLM/embedding provider health — the outage nothing could name.

    An HTTP 401 on every call is not a per-case failure, it is a system state. Each
    individual failure was already handled correctly (the case failed to a human, the
    ledger recorded an error row), which is exactly why the AGGREGATE condition stayed
    invisible for three days while the operator chased latency and evidence quality.

    Provider NAMES are already public configuration; no key, endpoint, prompt or
    provider response text is ever included here (#9). Advisory only (#3).
    """
    tracker = getattr(state, "_provider_health", None)
    if tracker is None:
        return {"available": False, "state": "unknown", "degraded": False, "providers": {}}
    try:
        snapshot = tracker.snapshot()
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("provider-health snapshot soft-failed: %s", exc)
        return {"available": False, "state": "unknown", "degraded": False, "providers": {}}
    return {"available": True, **snapshot}


def _build_alerts(
    precedent: dict[str, Any],
    migration: dict[str, Any],
    auto_close: dict[str, Any],
    effectiveness: dict[str, Any] | None = None,
    provider_health: dict[str, Any] | None = None,
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

    # ------------------------------------------------------------------ #
    # The corpus reached ZERO. The loudest signal this module can produce.
    # ------------------------------------------------------------------ #
    # A knowledge corpus at zero is not "a small corpus": every investigation runs
    # with no runbook, no ATT&CK context and no precedent, so auto-close stops
    # entirely. It is reported ahead of the precedent-specific signals because it
    # subsumes them — precedent starvation is a symptom when the whole corpus is gone.
    if precedent.get("available") and precedent.get("rag_enabled"):
        # ``corpus_degraded`` carries the cold-start distinction: an empty corpus on a
        # deployment that has never projected is "not seeded yet", not a loss. Without
        # this the very first boot reports a CRITICAL corpus outage.
        if int(precedent.get("total_chunks") or 0) == 0 and precedent.get("corpus_degraded"):
            alerts.append(
                _alert(
                    "critical", "rag_corpus_empty",
                    "The knowledge corpus is EMPTY",
                    "Retrieval is enabled but the corpus holds 0 chunks, so every "
                    "investigation runs with no runbook, ATT&CK or precedent context "
                    "and auto-close cannot fire.",
                    "Rebuild the corpus (Jobs -> rebuild knowledge corpus). If the "
                    "rebuild is refused, check the embedding provider credentials "
                    "first — a projection is refused rather than allowed to replace a "
                    "good corpus with an empty one.",
                )
            )

    # ------------------------------------------------------------------ #
    # RECONCILIATION: "corpus has N documents but M qualifying records exist".
    # ------------------------------------------------------------------ #
    # The early-warning signal for BOTH incidents. The corpus is a PROJECTION of the
    # case history, so a large divergence between what the history qualifies and what
    # the corpus holds means the projection is broken — visible long before auto-close
    # drifts far enough for anyone to notice.
    #
    # N < M is normal and must NOT alert: the precedent projection is a BOUNDED window
    # (PrecedentWindowConfig.size, default 200) over the newest qualifying cases. The
    # comparison is therefore against ``min(M, window_size)``, not raw M. Every honesty
    # gate is respected — an unreadable corpus, a lower-bound count or a truncated case
    # read yields an ``unknown``, never an alert.
    reconciliation = precedent.get("reconciliation") or {}
    if reconciliation.get("measured"):
        if reconciliation.get("deficit"):
            alerts.append(
                _alert(
                    "critical", "precedent_projection_deficit",
                    "The precedent corpus holds far fewer documents than the case "
                    "history qualifies",
                    str(reconciliation.get("detail") or ""),
                    "The corpus is a projection of the case history, so a large "
                    "divergence means the projection is broken rather than the history "
                    "being small. Rebuild the corpus and check the embedding provider.",
                )
            )
    elif reconciliation.get("reason"):
        unknowns.append(
            _alert(
                "unknown", "precedent_projection_reconciliation_unknown",
                "Corpus-vs-source-history reconciliation could not be measured",
                str(reconciliation.get("reason") or ""),
                "",
            )
        )

    projection = precedent.get("projection") or {}
    # A REFUSED projection is a first-class condition: the rebuild did not happen and
    # the corpus is whatever it was before, which may be stale or already empty.
    refusal = precedent.get("last_refusal") or {}
    if refusal.get("collapsed"):
        alerts.append(
            _alert(
                "critical", "rag_projection_refused",
                "The last knowledge projection was REFUSED",
                str(refusal.get("reason") or "")[:400],
                "The existing corpus was preserved rather than replaced by an empty or "
                "drastically smaller one. Fix the underlying cause (most often the "
                "embedding provider) and rebuild.",
            )
        )

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

    # ------------------------------------------------------------------ #
    # Provider outage. A distinct state, never folded into a generic error.
    # ------------------------------------------------------------------ #
    if provider_health and provider_health.get("available") and provider_health.get("degraded"):
        provider_state = str(provider_health.get("state") or "")
        names = ", ".join(
            name
            for name, row in sorted((provider_health.get("providers") or {}).items())
            if str(row.get("state") or "ok") != "ok"
        )
        if provider_state == "unauthenticated":
            alerts.append(
                _alert(
                    "critical", "llm_provider_unauthenticated",
                    "The model provider is rejecting our credentials",
                    f"Consecutive authentication failures from: {names or 'the configured provider'}. "
                    "Every investigation is failing to a human and the knowledge corpus "
                    "cannot be rebuilt while this persists.",
                    "Check the provider API key (expired, revoked, or rotated). Case "
                    "verdicts are unaffected — no case is auto-closed on a failed call.",
                )
            )
        elif provider_state == "quota_exhausted":
            alerts.append(
                _alert(
                    "critical", "llm_provider_quota_exhausted",
                    "The model provider is refusing calls for quota/rate reasons",
                    f"Consecutive quota failures from: {names or 'the configured provider'}.",
                    "Check the provider plan limits and rate ceilings.",
                )
            )
        else:
            alerts.append(
                _alert(
                    "warning", "llm_provider_unavailable",
                    "The model provider is not answering",
                    f"Consecutive failures from: {names or 'the configured provider'}.",
                    "Check provider status and network egress.",
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
    provider_health = _provider_health_block(state)
    alerts, unknowns = _build_alerts(
        precedent, migration, auto_close, effectiveness, provider_health
    )
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
        # Aggregate model-provider health (consecutive auth/quota/transport failures).
        "llm_provider": provider_health,
        "auto_close": auto_close,
        "alerts": alerts,
        "unknowns": unknowns,
        # Plain counts, deliberately NOT a composite health score: "no alerts" and
        # "nothing could be measured" are different answers and stay separable.
        "alert_count": len(alerts),
        "unknown_count": len(unknowns),
    }
