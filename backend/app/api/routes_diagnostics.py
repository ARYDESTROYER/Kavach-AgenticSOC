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
* **Read-only over the corpus, with ONE bounded advisory write.** No LLM, no seeding
  and no projection mutation: the corpus is read through the seed-free
  ``snapshot_documents_strict`` seam, so merely *asking* about corpus health can never
  trigger an embedding spend or change what is stored. The single exception is the
  composition BASELINE: a class-share shift cannot be measured without a prior reading,
  so each read may append one ``{at, rows, shares}`` entry (no case id, no chunk text,
  no rule identity, no secret) to the advisory ``rag_health`` KV document. It is capped
  at eight readings, written only when the reading actually changed and only above the
  row floor on an untruncated read, CAS-routed, and fail-open — a write failure reports
  the shift as unmeasured rather than failing the request.
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
* **Additive + default-safe (#10).** New endpoints only — no new configuration, no new
  scheduled or background work; the one advisory composition write above happens inside
  the request that reads the endpoint and nowhere else.
"""

from __future__ import annotations

import asyncio
import logging
from time import monotonic
from typing import Any

from fastapi import APIRouter, Depends, Query

from ..constants import CaseStatus
from ..engine.analyst_outcomes import analyst_confirmed_outcome, ground_truth_supply
from ..engine.metrics import (
    analyst_confirmed_case_ids,
    auto_close_health,
    precedent_ground_truth,
)
from ..engine.precedent import (
    RULE_IDENTITY_KEY,
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


async def _precedent_exclusions(rag: Any) -> dict[str, Any]:
    """The operator precedent-exclusion set, read fail-open.

    A missing/older RAG service (or a store glitch) reports ``supported``/``available``
    honestly rather than a confident zero: an exclusion set that could not be read is an
    unknown, and reporting it as "nothing is excluded" would make the blocks below blame
    the projection for an operator action.
    """
    reader = getattr(rag, "precedent_exclusions", None) if rag is not None else None
    if reader is None:
        return {"available": False, "supported": False, "count": 0, "case_ids": [], "by_rule": {}}
    try:
        payload = await reader()
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("precedent exclusion read soft-failed: %s", exc)
        return {"available": False, "supported": True, "count": 0, "case_ids": [], "by_rule": {}}
    block = dict(payload or {})
    # The per-case ``entries`` map carries the operator's free-text note. This router is
    # gated on ``settings:read``, which every built-in role holds, while the exclusion
    # entries themselves live behind ``rag:read`` on
    # ``GET /api/rag/precedent/exclusions``. Publish only what this surface needs — the
    # count, the ids and the per-rule/per-reason breakdown — rather than widening the
    # audience of an operator-authored field for no diagnostic gain.
    block.pop("entries", None)
    return block


async def _precedent_text_staleness(rag: Any, cases: list) -> dict[str, Any]:
    """Per-tier counts of precedent whose stored TEXT no longer matches the projection.

    Read fail-open and FREE: one management read of the corpus, the case page this
    endpoint already fetched as the only case source, and the ordinary per-case
    projector. It embeds nothing and writes nothing.

    Before this, stale precedent text was invisible on EVERY surface. The composition
    report compares metadata tallies, the collapse guard is a size guard, and the
    distribution reads metadata rows with the text discarded — so a chunk rendered by an
    old builder tallied identically to a freshly projected one and no metric moved.
    """
    reader = getattr(rag, "precedent_text_staleness", None) if rag is not None else None
    if reader is None:
        return {
            "available": False,
            "reason": "this RAG service does not measure precedent text staleness",
            "complete": False,
            "truncated": False,
            "scanned": 0,
            "stale": 0,
            "by_trust_class": {},
        }
    try:
        return dict(await reader(cases))
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("precedent staleness read soft-failed: %s", exc)
        return {
            "available": False,
            "reason": f"precedent text staleness could not be measured ({type(exc).__name__})",
            "complete": False,
            "truncated": False,
            "scanned": 0,
            "stale": 0,
            "by_trust_class": {},
        }


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
    exclusions = await _precedent_exclusions(rag)
    excluded_ids = {str(cid) for cid in (exclusions.get("case_ids") or [])}
    # Analyst-confirmed terminal cases the projection can draw from, MINUS the ones an
    # operator excluded. Subtracting them is what stops the reconciliation below
    # reporting a deficit and blaming the projection for a deliberate operator action.
    projectable_after_exclusions = _projectable_precedent_records(cases, excluded_ids)

    available, reason, docs = await _corpus_snapshot(rag)
    stale_text = await _precedent_text_staleness(rag, cases)
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
    elif zero_precedents and excluded_ids and projectable_after_exclusions == 0:
        # OPERATOR-EXCLUDED, not starved. Without this branch a broad exclusion — the
        # supported repair for a poisoned corpus — reports as the exact incident
        # signature this block exists to detect, so the product would raise a CRITICAL
        # against an operator for doing what it told them to do.
        status = "operator_excluded"
        status_reason = (
            f"every qualifying case ({len(excluded_ids)} excluded) is operator-excluded "
            "from the precedent corpus, so an empty corpus is the requested state rather "
            "than a projection failure"
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
        # The operator exclusion set: count, ids and the per-rule breakdown. Published
        # here so a small corpus can be attributed to a deliberate operator action rather
        # than to a broken projection.
        "exclusions": exclusions,
        # Per-tier stale-text counts. COUNTS ONLY — no chunk text reaches this
        # surface, and measuring it costs zero embedding calls. ``complete: false``
        # means the measurement could not cover the whole corpus (a truncated backend
        # read, or a case off the fetched page), so "0 stale" would be unsupportable.
        "stale_text_chunks": stale_text,
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
            projectable_records=projectable_after_exclusions,
            excluded_records=len(excluded_ids),
            corpus_may_be_truncated=_corpus_may_be_truncated(rag, total_chunks),
        ),
    }


def _projectable_precedent_records(cases: list, excluded: set[str] | None = None) -> int:
    """Analyst-confirmed cases the precedent projection can ACTUALLY draw from.

    Deliberately NOT ``precedent_ground_truth()["analyst_confirmed_cases"]``: that
    counts every analyst-confirmed case regardless of status, while the projection
    scans only CLOSED and RESOLVED cases (see ``RagService._resolved_case_items``).
    Analyst feedback on an escalated or in-progress case is perfectly ordinary, and
    counting it as projectable would manufacture a deficit against a corpus that is
    behaving exactly as designed. The two must be measured over the same population.

    ``excluded`` is the operator's precedent-exclusion set, and subtracting it is the
    same rule applied once more: the projection deliberately skips those cases, so
    counting them as projectable would report a deficit against a corpus that is doing
    exactly what the operator asked — and blame the projection for it.
    """
    terminal = {CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value}
    skip = excluded or set()
    count = 0
    for case in cases:
        status = getattr(getattr(case, "status", None), "value", None)
        if str(status or "") not in terminal:
            continue
        if str(getattr(case, "case_id", "") or "") in skip:
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
    excluded_records: int = 0,
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
        # Qualifying records the OPERATOR removed from the projection on purpose. They
        # are already subtracted from ``qualifying_source_records``; the count is
        # published so the subtraction is visible rather than implicit.
        "operator_excluded_records": int(excluded_records or 0),
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


# --------------------------------------------------------------------------- #
# CORPUS COMPOSITION — the health signal a size guard cannot give.
# --------------------------------------------------------------------------- #
# The existing projection guard is a SIZE guard: it refuses a rebuild that emptied or
# drastically shrank the corpus. A reprojection that keeps the same chunk count and
# flips the meaning of every one of them passes it cleanly, and that is not a
# hypothetical. On the deployment that motivated this work, the obvious dashboard —
# ANALYST OUTCOME ALONE — read 198 ``false_positive`` / 2 ``true_positive``. That looks
# exactly like a healthy SOC corpus, and it stayed green for the entire incident, while
# the corpus was actively poisoning the model: nearly all of those rows carried no
# independent ground truth at all, so the agent was reading its own prior verdicts back
# as operator evidence and confirming itself.
#
# Outcome alone cannot show that. The CROSS-TAB can:
#
#     (analyst outcome  x  model verdict  x  ground-truth source)
#
# Split those 198 rows by the source of their label and by what the model itself had
# said, and the same corpus reads "196 of 200 rows have ground_truth_source=none and
# agree with the model's own verdict" — a sentence no operator would call healthy.
#
# What this alarms on, and what it deliberately does NOT:
#
# * ROW COUNT — never. Size is the guard that already exists, and a corpus is allowed
#   to be small, to grow and to shrink.
# * DISAGREEMENT LEVEL — never. "The analyst disagreed with the model" is what a
#   working queue produces all day; alarming on it fires permanently on exactly the
#   deployments where analysts do the most work, and goes quiet on the ones where
#   nobody grades anything. It is an inverted signal.
# * CLASS-SHARE SHIFT — yes. Composition MOVING is the observable a poisoning event
#   produces and a healthy corpus does not. It needs a baseline, so readings are kept
#   as a bounded series in the durable health record (``RagHealthStore``); a deployment
#   with no prior reading reports the shift as UNMEASURED rather than as zero.
# * SINGLE-TRANSACTION CONCENTRATION — yes. A cell that is overwhelmingly one bulk
#   action speaks with one voice however many rows it holds, and the bounded precedent
#   window then evicts everything else. Reported with the evidence NAMED (the share of
#   the cell held by one rule identity, and the share carrying a bulk-ratification
#   marker), because those are proxies for "one transaction" rather than a transaction
#   id the corpus does not store.
#
# Advisory only (#3): nothing here is read by ``decide()``, by scoring, or by the
# projection. Read-only over corpus METADATA — no chunk text, no case id and no analyst
# identity leaves this block. The dominating RULE IDENTITY is named plainly, exactly as
# the sibling ``precedent_effectiveness.distribution`` block on this same
# ``settings:read`` response already does, because the operator cannot act on "one
# contributor holds this class" without knowing which one. Nothing here is persisted
# with an identity attached: ``observe_composition`` stores only ``{at, rows, shares}``.
# Nothing on this surface reaches a prompt (#9); it is plain JSON the Console escapes.
_COMPOSITION_MIN_ROWS = 25
#: A cell's share of the corpus must move by at least this much to be called a shift.
#: Scale-free by construction (a fraction of the corpus, not a row count), so it is not
#: tuned to any deployment's volume, vendor or rule set.
_COMPOSITION_SHIFT_ALARM = 0.25
#: Concentration needs BOTH: the cell must dominate the corpus, and one contributor
#: must dominate the cell. Either alone is ordinary.
_COMPOSITION_CELL_DOMINANCE = 0.5
_COMPOSITION_WITHIN_CELL_DOMINANCE = 0.9
#: How many cells are published and compared. MUST NOT exceed
#: ``stores.rag_health._MAX_COMPOSITION_CELLS`` (the baseline the shift is measured
#: against is truncated at that cap): a cell that fits here but not there would drop
#: out of the stored baseline and read back as a movement from zero on the next pass.
_MAX_COMPOSITION_CELLS = 40

#: What a chunk carrying no independent ground-truth source is labelled as. The empty
#: string is what the lower-trust tier writes; publishing it as ``none`` keeps the axis
#: readable without inventing a source.
_NO_GROUND_TRUTH_SOURCE = "none"


def _cell_key(source: str, outcome: str, verdict: str) -> str:
    return f"{source}|{outcome}|{verdict}"


def _top_contributor(identity: str) -> str:
    """The rule identity that dominates a cell, named PLAINLY.

    This was a truncated unsalted digest, documented as "non-reversible". It was
    neither: the sibling ``precedent_effectiveness.distribution`` block in the SAME
    response body publishes every analyst-confirmed ``rule_identity`` and its
    ``rule_ids`` in the clear (and the futility alert prints the rule names), so the
    digest was reversible by inspection of its own payload — a 12-hex digest of one of
    a handful of published preimages. Nor did it protect anything on the storage path:
    ``RagHealthStore.observe_composition`` persists only ``{at, rows, shares}`` keyed by
    ``source|outcome|verdict``, so no rule identity, hashed or plain, was ever stored.

    It cost the finding its actionability and bought no confidentiality, so the plain
    identity is published — consistently with the sibling block, behind the same
    ``settings:read`` grant, as plain JSON the Console renders escaped.
    """
    return str(identity or "")


async def _precedent_metadata_rows(rag: Any) -> tuple[bool, str, list[dict[str, Any]], bool]:
    """``(available, reason, rows, truncated)`` — precedent chunk METADATA, seed-free.

    Reads the same management seam the per-rule distribution uses, so the composition
    and the distribution can never disagree about what is in the corpus. A deployment
    whose retrieval service does not expose it reports UNAVAILABLE rather than an empty
    composition, because an empty cross-tab and an unread one are different answers.
    """
    reader = getattr(rag, "_precedent_chunk_metadata", None) if rag is not None else None
    if reader is None:
        return False, (
            "this deployment's retrieval service does not expose precedent chunk "
            "metadata, so corpus composition could not be read"
        ), [], False
    try:
        rows, truncated = await reader()
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("diagnostics corpus composition read soft-failed: %s", exc)
        return False, f"the precedent corpus could not be read ({type(exc).__name__})", [], False
    clean = [dict(row) for row in rows if isinstance(row, dict)]
    return True, "", clean, bool(truncated)


# --------------------------------------------------------------------------- #
# ONE corpus read per short TTL, shared by the composition + embedding-space blocks.
# --------------------------------------------------------------------------- #
# Both new blocks read the WHOLE corpus, and the Elasticsearch vector store answers
# that from one bounded ``match_all`` page whose ``_source`` carries every stored
# EMBEDDING VECTOR — so a corpus at the ceiling is a very large read. This endpoint is
# fired by the Overview health strip on every refresh, so performing that read twice
# per request (once for the cross-tab, once for the space audit) would turn an
# observability surface into a load source on exactly the large deployments it matters
# most on.
#
# These two single-slot caches memoize each read for a short TTL, following the
# ``api/metrics_shared`` pattern: a STRONG reference to the service the read came from
# plus an ``is`` identity guard, so a Demo Mode service swap (or a fresh service in a
# test) can never be served another service's corpus, and a recycled ``id()`` can never
# alias two objects. One lock per cache gives single-flight, so the dashboard's parallel
# fan-out shares one scan instead of racing duplicates. Read-only and advisory (#3);
# the TTL is the explicit staleness bound and nothing on this path feeds ``decide()``.
CORPUS_READ_TTL_SECONDS = 15.0

_documents_read_lock = asyncio.Lock()
_precedent_read_lock = asyncio.Lock()
#: ``(rag, at, value)`` for each cached read, or None before the first one.
_documents_read_entry: tuple[Any, float, tuple[bool, str, list[dict[str, Any]]]] | None = None
_precedent_read_entry: tuple[
    Any, float, tuple[bool, str, list[dict[str, Any]], bool]
] | None = None


def _fresh(entry: tuple[Any, float, Any] | None, rag: Any, now: float) -> bool:
    return (
        entry is not None
        and entry[0] is rag
        and (now - entry[1]) < CORPUS_READ_TTL_SECONDS
    )


async def _cached_corpus_documents(rag: Any) -> tuple[bool, str, list[dict[str, Any]]]:
    """``_corpus_snapshot`` behind the short TTL. Callers get their own outer list."""
    global _documents_read_entry
    async with _documents_read_lock:
        now = monotonic()
        if not _fresh(_documents_read_entry, rag, now):
            _documents_read_entry = (rag, now, await _corpus_snapshot(rag))
        available, reason, docs = _documents_read_entry[2]  # type: ignore[index]
    return available, reason, list(docs)


async def _cached_precedent_rows(
    rag: Any,
) -> tuple[bool, str, list[dict[str, Any]], bool]:
    """``_precedent_metadata_rows`` behind the short TTL."""
    global _precedent_read_entry
    async with _precedent_read_lock:
        now = monotonic()
        if not _fresh(_precedent_read_entry, rag, now):
            _precedent_read_entry = (rag, now, await _precedent_metadata_rows(rag))
        available, reason, rows, truncated = _precedent_read_entry[2]  # type: ignore[index]
    return available, reason, list(rows), truncated


def _composition_cells(rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], int]:
    """The (source x outcome x verdict) cross-tab over precedent chunk metadata."""
    cells: dict[str, dict[str, Any]] = {}
    for row in rows:
        source = str(row.get("ground_truth_source") or "").strip() or _NO_GROUND_TRUTH_SOURCE
        outcome = str(row.get("outcome") or "").strip() or "unlabelled"
        verdict = str(row.get("verdict") or "").strip() or "none"
        key = _cell_key(source, outcome, verdict)
        cell = cells.get(key)
        if cell is None:
            cell = cells[key] = {
                "cell": key,
                "ground_truth_source": source,
                "outcome": outcome,
                "verdict": verdict,
                "rows": 0,
                "bulk_ratified_rows": 0,
                "_by_identity": {},
            }
        cell["rows"] += 1
        if bool(row.get("bulk_ratified")):
            cell["bulk_ratified_rows"] += 1
        identity = str(row.get(RULE_IDENTITY_KEY) or "")
        by_identity = cell["_by_identity"]
        by_identity[identity] = by_identity.get(identity, 0) + 1
    return cells, len(rows)


def _shift_block(
    shares: dict[str, float], previous: dict[str, Any] | None, *, rows: int
) -> dict[str, Any]:
    """Class-share movement against the recorded baseline reading.

    The baseline is the OLDEST reading still in the bounded series, not the previous
    one (see ``RagHealthStore.observe_composition``): observation and alerting share
    one operator-facing read, so comparing against the previous reading made a
    poisoning finding visible on exactly ONE request and gone from the next. Its
    instant travels with the finding as ``baseline_at``.

    ``measured`` is False — never a zero shift — when there is no baseline yet or the
    corpus is too small for a share to mean anything. A share delta is compared against
    a SCALE-FREE fraction, so the same rule applies to a 40-row corpus and a 40,000-row
    one.
    """
    block: dict[str, Any] = {
        "measured": False,
        "reason": "",
        "baseline_at": "",
        "baseline_rows": None,
        "max_delta": None,
        "total_variation": None,
        "shifted": False,
        "moved_cells": [],
    }
    if rows < _COMPOSITION_MIN_ROWS:
        block["reason"] = (
            f"the corpus holds {rows} precedent row(s), below the {_COMPOSITION_MIN_ROWS} "
            "needed for a class share to carry information"
        )
        return block
    if not isinstance(previous, dict) or not previous:
        block["reason"] = (
            "no previous composition reading is on file, so there is nothing to compare "
            "against yet (this reading becomes the baseline)"
        )
        return block
    baseline = {
        str(key): float(value)
        for key, value in (previous.get("shares") or {}).items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }
    if not baseline:
        block["reason"] = "the previous composition reading carried no class shares"
        return block
    moved: list[dict[str, Any]] = []
    total_variation = 0.0
    for key in sorted(set(baseline) | set(shares)):
        before = baseline.get(key, 0.0)
        after = shares.get(key, 0.0)
        delta = after - before
        total_variation += abs(delta)
        if abs(delta) >= _COMPOSITION_SHIFT_ALARM:
            moved.append({
                "cell": key,
                "from": round(before, 4),
                "to": round(after, 4),
                "delta": round(delta, 4),
            })
    moved.sort(key=lambda row: -abs(float(row["delta"])))
    max_delta = max((abs(float(row["delta"])) for row in moved), default=0.0)
    if not moved:
        max_delta = max(
            (abs(shares.get(key, 0.0) - baseline.get(key, 0.0))
             for key in set(baseline) | set(shares)),
            default=0.0,
        )
    block.update(
        measured=True,
        baseline_at=str(previous.get("at") or ""),
        baseline_rows=int(previous.get("rows") or 0),
        max_delta=round(max_delta, 4),
        # Half the summed absolute movement: the fraction of the corpus that changed
        # class between the two readings.
        total_variation=round(total_variation / 2.0, 4),
        shifted=bool(moved),
        moved_cells=moved[:_MAX_COMPOSITION_CELLS],
    )
    return block


def _concentration_block(
    cells: dict[str, dict[str, Any]], *, rows: int
) -> dict[str, Any]:
    """Cells a single contributor dominates — "one transaction wrote this class"."""
    block: dict[str, Any] = {
        "measured": False,
        "reason": "",
        "concentrated": False,
        "cells": [],
    }
    if rows < _COMPOSITION_MIN_ROWS:
        block["reason"] = (
            f"the corpus holds {rows} precedent row(s), below the {_COMPOSITION_MIN_ROWS} "
            "needed for concentration to mean anything"
        )
        return block
    block["measured"] = True
    findings: list[dict[str, Any]] = []
    for cell in cells.values():
        cell_rows = int(cell["rows"])
        cell_share = cell_rows / rows if rows else 0.0
        if cell_share < _COMPOSITION_CELL_DOMINANCE:
            continue
        by_identity: dict[str, int] = cell["_by_identity"]
        top_identity, top_rows = "", 0
        for identity, count in sorted(by_identity.items()):
            if identity and count > top_rows:
                top_identity, top_rows = identity, count
        identity_share = top_rows / cell_rows if cell_rows else 0.0
        bulk_share = int(cell["bulk_ratified_rows"]) / cell_rows if cell_rows else 0.0
        if max(identity_share, bulk_share) < _COMPOSITION_WITHIN_CELL_DOMINANCE:
            continue
        findings.append({
            "cell": cell["cell"],
            "ground_truth_source": cell["ground_truth_source"],
            "outcome": cell["outcome"],
            "verdict": cell["verdict"],
            "rows": cell_rows,
            "cell_share": round(cell_share, 4),
            "top_contributor": _top_contributor(top_identity),
            "top_contributor_share": round(identity_share, 4),
            "bulk_ratified_share": round(bulk_share, 4),
        })
    findings.sort(key=lambda row: (-float(row["cell_share"]), str(row["cell"])))
    block["cells"] = findings[:_MAX_COMPOSITION_CELLS]
    block["concentrated"] = bool(findings)
    return block


async def _corpus_composition_block(state: AppState) -> dict[str, Any]:
    """Corpus COMPOSITION health: the cross-tab, its movement, and its concentration.

    See the module-level note above ``_COMPOSITION_MIN_ROWS`` for why outcome alone is
    not a health signal and what this block alarms on instead. Everything here is
    measured, bounded and honest about what it could not measure: an unreadable corpus
    reports ``available: false``, a truncated read publishes the cross-tab but withholds
    both alarms (a partial read of a corpus is a biased sample of it, and biased shares
    are exactly the wrong input to a shift comparison), and a corpus with no prior
    reading reports the shift as UNMEASURED rather than as no movement.
    """
    rag = getattr(state, "rag_service", None)
    rag_cfg = getattr(getattr(state, "prefs", None), "rag", None)
    rag_enabled = bool(getattr(rag_cfg, "enabled", False))
    precedent_enabled = bool(getattr(rag_cfg, "use_resolved_cases", False))
    block: dict[str, Any] = {
        "available": False,
        "disabled": False,
        "reason": "",
        "truncated": False,
        "rows": 0,
        "cells": [],
        # The view that read PRISTINE throughout the incident, published beside the
        # cross-tab on purpose: an operator who has been reading it should be able to
        # see the same number here and the split that contradicts it.
        "outcome_only_view": {},
        "by_ground_truth_source": {},
        "independent_ground_truth_share": None,
        "shift": {"measured": False, "reason": "", "shifted": False, "moved_cells": []},
        "concentration": {"measured": False, "reason": "", "concentrated": False,
                          "cells": []},
    }
    if not rag_enabled or not precedent_enabled:
        block["disabled"] = True
        block["reason"] = (
            "the resolved-case precedent source is turned off, so there is no corpus "
            "composition to measure"
        )
        return block

    available, reason, rows, truncated = await _cached_precedent_rows(rag)
    block["available"] = available
    block["reason"] = reason
    block["truncated"] = truncated
    if not available:
        return block

    cells, total = _composition_cells(rows)
    block["rows"] = total
    by_outcome: dict[str, int] = {}
    by_source: dict[str, int] = {}
    independent = 0
    for cell in cells.values():
        by_outcome[cell["outcome"]] = by_outcome.get(cell["outcome"], 0) + cell["rows"]
        by_source[cell["ground_truth_source"]] = (
            by_source.get(cell["ground_truth_source"], 0) + cell["rows"]
        )
        if cell["ground_truth_source"] != _NO_GROUND_TRUTH_SOURCE:
            independent += cell["rows"]
    block["outcome_only_view"] = dict(sorted(by_outcome.items()))
    block["by_ground_truth_source"] = dict(sorted(by_source.items()))
    block["independent_ground_truth_share"] = (
        round(independent / total, 4) if total else None
    )
    # Shares are computed over the SAME bounded set of cells the baseline stores, so a
    # cell that fell off the persisted end can never come back as a movement from zero.
    # Selection is by row count (largest cells first) and is deterministic.
    ranked = sorted(
        cells.values(), key=lambda cell: (-int(cell["rows"]), str(cell["cell"]))
    )[:_MAX_COMPOSITION_CELLS]
    shares = {
        str(cell["cell"]): (int(cell["rows"]) / total if total else 0.0)
        for cell in ranked
    }
    published = sorted(
        (
            {
                "cell": cell["cell"],
                "ground_truth_source": cell["ground_truth_source"],
                "outcome": cell["outcome"],
                "verdict": cell["verdict"],
                "rows": int(cell["rows"]),
                "share": round(shares.get(cell["cell"], 0.0), 4),
                "bulk_ratified_rows": int(cell["bulk_ratified_rows"]),
                "contributors": len([i for i in cell["_by_identity"] if i]),
            }
            for cell in cells.values()
        ),
        key=lambda row: (-int(row["rows"]), str(row["cell"])),
    )
    block["cells"] = published[:_MAX_COMPOSITION_CELLS]

    if truncated:
        # A truncated read is a BIASED sample of the corpus. Publishing its cross-tab is
        # useful; comparing its shares against a baseline taken from a different partial
        # read would manufacture a shift out of the read itself.
        partial = (
            "the corpus read hit its scan ceiling, so these shares are drawn from a "
            "partial read and cannot be compared against a baseline"
        )
        block["shift"]["reason"] = partial
        block["concentration"]["reason"] = partial
        return block

    # Record this reading and get the previous one back. The write is conditional (an
    # unchanged reading appends nothing) and fail-open — if it fails, the shift simply
    # reports as unmeasured.
    previous: dict[str, Any] | None = None
    health = getattr(rag, "_health", None)
    observer = getattr(health, "observe_composition", None) if health is not None else None
    if total < _COMPOSITION_MIN_ROWS:
        # Below the floor a share is noise, and RECORDING it would make that noise the
        # baseline the next reading is judged against — manufacturing a shift out of a
        # corpus simply growing past the floor.
        block["shift"] = _shift_block({}, None, rows=total)
        block["concentration"] = _concentration_block(cells, rows=total)
        return block
    if observer is None:
        block["shift"]["reason"] = (
            "this deployment keeps no durable composition history, so a class-share "
            "shift cannot be measured"
        )
    else:
        try:
            observation = await observer(shares, rows=total)
            previous = observation.get("previous") if isinstance(observation, dict) else None
        except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
            logger.warning("composition observation soft-failed: %s", exc)
            previous = None
        block["shift"] = _shift_block(shares, previous, rows=total)
    block["concentration"] = _concentration_block(cells, rows=total)
    return block


# --------------------------------------------------------------------------- #
# EMBEDDING SPACE — what a reprojection would strand.
# --------------------------------------------------------------------------- #
def _is_local_fallback_space(model: str) -> bool:
    """Whether a stored space tag is the gateway's OWN local hash fallback.

    Not a vendor or model allowlist: this is our own degraded-mode marker. When no
    embedding provider answers, ``LLMGateway.embed_with_provenance`` falls back to the
    deterministic local hasher and stamps the chunk with the ``mock`` embedding
    identity, which is also the prefix ``llm.provider_health`` already treats as
    "not a real provider outage". Matching that same prefix here keeps the two
    conventions in one shape.
    """
    return str(model or "").strip().lower().startswith("mock")


def _embedding_space_block(
    state: AppState, available: bool, reason: str, docs: list[dict[str, Any]]
) -> dict[str, Any]:
    """Documents left behind in a SUPERSEDED vector space, or proof that none are.

    Vectors from two embedding models are not comparable, so a document embedded by the
    old model is unreachable by a query embedded with the new one: not deleted, not
    counted as missing, not logged — simply never retrieved again. A rebuild that
    re-embeds the bounded precedent window leaves everything outside that window exactly
    there, and every count on this surface (corpus size, per-source chunks, the
    reconciliation) keeps reporting those documents as present, because they are.

    So the count is stated explicitly: how many documents and chunks carry an embedding
    space other than the one the configured embedding model produces. ``stranded: 0``
    with ``available: true`` is the positive statement that none are — the "or prove
    none is" half — and a document whose stored space tag is blank (projected before the
    tag existed) is reported as UNATTRIBUTED rather than counted either way.

    THE LOCAL HASH FALLBACK IS NOT A SUPERSEDED SPACE. A deployment with no embedding
    provider configured is running the supported keyless/offline profile (Gate 2): the
    gateway degrades to local hash embeddings, and both the corpus AND every query land
    in that same space, so retrieval is entirely self-consistent and nothing is
    unreachable. Counting it as stranded raised a permanent ``critical`` on every
    default install whose remediation ("rebuild the corpus") re-produces the identical
    space — an alarm no operator could ever clear. Those documents are counted
    separately as ``fallback_documents`` and reported as an UNKNOWN: from the corpus
    metadata alone we cannot tell the supported keyless profile (fully reachable) from
    a deployment that has since acquired a real embedding provider (in which case they
    do need reprojecting), and inventing a verdict either way would be a guess.
    """
    configured = ""
    prefs = getattr(state, "prefs", None)
    model_for = getattr(prefs, "model_for", None)
    if callable(model_for):
        try:
            configured = str(getattr(model_for("embedding"), "model", "") or "")
        except Exception:  # noqa: BLE001 — diagnostics degrade, never 500
            configured = ""
    block: dict[str, Any] = {
        "available": bool(available),
        "reason": reason,
        # Stranding only COSTS anything while retrieval is on. The count is still
        # measured and published with retrieval off (it is what a re-enable would
        # inherit), but it does not raise an alert — the same distinction the
        # precedent block makes between a configured state and a defect.
        "rag_enabled": bool(getattr(getattr(prefs, "rag", None), "enabled", False)),
        "configured_model": configured,
        "spaces": {},
        "stranded_documents": 0,
        "stranded_chunks": 0,
        "stranded_sources": [],
        "unattributed_documents": 0,
        # Chunks the gateway embedded with its LOCAL HASH fallback because no embedding
        # provider answered. Reachable on the keyless profile, stale once a real
        # provider is configured — reported, never alarmed on (see the docstring).
        "fallback_documents": 0,
        "fallback_chunks": 0,
        "fallback_sources": [],
        "mixed_spaces": False,
        "measured": False,
    }
    if not available:
        return block
    if not configured:
        block["reason"] = (
            "the configured embedding model could not be read, so a stored space "
            "cannot be compared against it"
        )
        return block
    spaces: dict[str, dict[str, Any]] = {}
    stranded_docs = 0
    stranded_chunks = 0
    unattributed = 0
    stranded_sources: set[str] = set()
    fallback_docs = 0
    fallback_chunks = 0
    fallback_sources: set[str] = set()
    for row in docs:
        model = str(row.get("embedding_model") or "").strip()
        try:
            chunks = max(0, int(row.get("chunk_count") or 0))
        except (TypeError, ValueError):
            chunks = 0
        if not model:
            unattributed += 1
            continue
        entry = spaces.setdefault(model, {"documents": 0, "chunks": 0, "dims": []})
        entry["documents"] += 1
        entry["chunks"] += chunks
        try:
            dim = int(row.get("dim") or 0)
        except (TypeError, ValueError):
            dim = 0
        if dim and dim not in entry["dims"]:
            entry["dims"].append(dim)
        if model == configured:
            continue
        if _is_local_fallback_space(model):
            fallback_docs += 1
            fallback_chunks += chunks
            fallback_sources.add(str(row.get("source") or "unknown"))
            continue
        stranded_docs += 1
        stranded_chunks += chunks
        stranded_sources.add(str(row.get("source") or "unknown"))
    for entry in spaces.values():
        entry["dims"] = sorted(entry["dims"])
    block.update(
        measured=True,
        spaces=dict(sorted(spaces.items())),
        stranded_documents=stranded_docs,
        stranded_chunks=stranded_chunks,
        stranded_sources=sorted(stranded_sources),
        unattributed_documents=unattributed,
        fallback_documents=fallback_docs,
        fallback_chunks=fallback_chunks,
        fallback_sources=sorted(fallback_sources),
        mixed_spaces=len(spaces) > 1,
    )
    return block


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
    composition: dict[str, Any] | None = None,
    embedding_space: dict[str, Any] | None = None,
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

    # ------------------------------------------------------------------ #
    # Operator EXCLUSIONS: attributable, and never a wolf cry.
    # ------------------------------------------------------------------ #
    exclusions = precedent.get("exclusions") or {}
    if exclusions.get("supported") and not exclusions.get("available"):
        # An unreadable exclusion set makes the reconciliation above a guess: excluded
        # records cannot be subtracted, so a deliberate operator action could read as a
        # projection deficit. Say so instead of publishing a confident comparison.
        unknowns.append(
            _alert(
                "unknown", "precedent_exclusions_unreadable",
                "The precedent exclusion set could not be read",
                "Cases an operator excluded from the precedent corpus cannot be "
                "subtracted from the qualifying-record count, so the corpus-vs-history "
                "reconciliation may understate the corpus.",
                "Check the state backend; the projection keeps honouring the last "
                "exclusion set it successfully read.",
            )
        )

    projection = precedent.get("projection") or {}
    # A REFUSED projection is a first-class condition: the rebuild did not happen and
    # the corpus is whatever it was before, which may be stale or already empty.
    refusal = precedent.get("last_refusal") or {}
    if refusal.get("collapsed"):
        # An ATTRIBUTABLE window reduction is not a corpus loss and must not be reported
        # as one: the operator deliberately narrowed the precedent window (the obvious
        # move for dropping a poisoned tail) and the ratio floor blocked it. Nothing was
        # destroyed, and the remedy is the retention floor, not the embedding provider.
        if str(refusal.get("reason_code") or "") == "window_size_reduction":
            alerts.append(
                _alert(
                    "warning", "rag_projection_refused_window_reduction",
                    "A deliberate precedent-window reduction was refused",
                    str(refusal.get("reason") or "")[:400],
                    "Nothing was lost — the previous corpus is intact. Lower "
                    "rag.min_projection_retention (or set it to 0) to let the intended "
                    "reduction through. A projection reaching zero is refused regardless.",
                )
            )
        else:
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

    # ------------------------------------------------------------------ #
    # EMBEDDING SPACE: documents a reprojection stranded in the old space.
    # ------------------------------------------------------------------ #
    # Not a size signal and not visible in any count: the chunks are still there, still
    # counted, and permanently unreachable by a query embedded with the current model.
    if embedding_space and embedding_space.get("measured"):
        stranded_docs = int(embedding_space.get("stranded_documents") or 0)
        if stranded_docs > 0 and embedding_space.get("rag_enabled"):
            sources = ", ".join(embedding_space.get("stranded_sources") or []) or "unknown"
            alerts.append(
                _alert(
                    "critical", "rag_embedding_space_stranded",
                    f"{stranded_docs} document(s) are stranded in a superseded "
                    "embedding space",
                    f"{stranded_docs} document(s) / "
                    f"{int(embedding_space.get('stranded_chunks') or 0)} chunk(s) in "
                    f"{sources} were embedded by a different model than the configured "
                    f"{embedding_space.get('configured_model') or 'embedding model'}. "
                    "Vectors from two models are not comparable, so those chunks are "
                    "still counted as present but can never be retrieved again.",
                    "Rebuild the knowledge corpus so every chunk lives in one space. "
                    "Until then the stranded documents are invisible to retrieval "
                    "while every corpus count keeps reporting them as present.",
                )
            )
        fallback_docs = int(embedding_space.get("fallback_documents") or 0)
        if fallback_docs > 0 and embedding_space.get("rag_enabled"):
            # NOT an alert. On the supported keyless profile these chunks and every
            # query share the same local hash space, so retrieval is self-consistent
            # and there is nothing to fix; the corpus metadata cannot distinguish that
            # from a deployment that has since configured a real embedding provider.
            # Saying which of the two it is would be a guess, so it is an unknown.
            unknowns.append(
                _alert(
                    "unknown", "rag_embedding_local_fallback",
                    f"{fallback_docs} document(s) were embedded by the local hash "
                    "fallback",
                    f"{fallback_docs} document(s) / "
                    f"{int(embedding_space.get('fallback_chunks') or 0)} chunk(s) in "
                    f"{', '.join(embedding_space.get('fallback_sources') or []) or 'unknown'} "
                    "carry the gateway's local hash-embedding space, which is what it "
                    "produces when no embedding provider answers. With no embedding "
                    "provider configured this is the supported keyless profile and "
                    "queries land in the same space, so they are fully reachable.",
                    "If an embedding provider IS configured, reproject the knowledge "
                    "corpus so those chunks live in its space; on the keyless profile "
                    "no action is needed.",
                )
            )
    elif embedding_space is not None and not embedding_space.get("available"):
        unknowns.append(
            _alert(
                "unknown", "rag_embedding_space_unknown",
                "Whether any documents are stranded in an old embedding space is unknown",
                str(embedding_space.get("reason") or "the corpus could not be read"),
                "",
            )
        )

    # ------------------------------------------------------------------ #
    # CORPUS COMPOSITION: what a size guard cannot see.
    # ------------------------------------------------------------------ #
    if composition and composition.get("available"):
        shift = composition.get("shift") or {}
        if shift.get("shifted"):
            moved = ", ".join(
                f"{row.get('cell')} {row.get('from')}->{row.get('to')}"
                for row in (shift.get("moved_cells") or [])[:3]
            )
            baseline_at = str(shift.get("baseline_at") or "the previous observation")
            alerts.append(
                _alert(
                    "critical", "rag_composition_shift",
                    "The precedent corpus changed composition, not just size",
                    f"Class shares moved by up to {shift.get('max_delta')} against the "
                    f"reading taken at {baseline_at} ({moved}). The size guard cannot "
                    "see this: a reprojection that keeps the same chunk count and flips "
                    "what those chunks say passes it cleanly.",
                    "Compare the (ground-truth source x outcome x verdict) cross-tab "
                    "against the previous reading before trusting precedent again, and "
                    "check what was projected between the two.",
                )
            )
        elif shift.get("reason") and int(composition.get("rows") or 0) >= _COMPOSITION_MIN_ROWS:
            # Only an unknown once there IS a corpus to have a composition. Below the
            # floor there is nothing to say, and saying it would put a permanent
            # "could not be evaluated" entry on every fresh deployment beside the
            # starvation alert that already describes the same emptiness.
            unknowns.append(
                _alert(
                    "unknown", "rag_composition_shift_unknown",
                    "Whether the precedent corpus changed composition is unknown",
                    str(shift.get("reason") or ""), "",
                )
            )
        concentration = composition.get("concentration") or {}
        for row in concentration.get("cells") or []:
            alerts.append(
                _alert(
                    "warning", f"rag_composition_concentrated:{row.get('cell')}",
                    "One contributor holds nearly all of a precedent class",
                    f"{row.get('rows')} row(s) — {row.get('cell_share')} of the corpus "
                    f"— sit in {row.get('cell')}, and "
                    f"{row.get('top_contributor_share')} of that cell comes from the "
                    f"single rule identity {row.get('top_contributor') or 'unknown'} "
                    f"(bulk-ratified share {row.get('bulk_ratified_share')}). The "
                    "corpus now speaks with one voice about this class.",
                    "Confirm outcomes across more detections, or narrow the precedent "
                    "window, so one bulk action cannot define a class on its own.",
                )
            )
    elif composition is not None and not composition.get("disabled") and composition.get("reason"):
        unknowns.append(
            _alert(
                "unknown", "rag_composition_unknown",
                "Precedent corpus composition could not be read",
                str(composition.get("reason") or ""), "",
            )
        )

    return alerts, unknowns


@router.get("/diagnostics/precedent-composition")
async def diagnostics_precedent_composition(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """WHAT the precedent corpus is made of — now, and after a rebuild. Read-only.

    **Reprojection is not the repair, and this endpoint is what proves it.** The
    projection pages the case store newest-first, so on the deployment that motivated
    this the bulk-confirmed cases were still the newest analyst-confirmed terminal cases:
    a rebuild RE-SELECTS them and converges on the composition it just replaced. Worse,
    the qualifying POOL was MORE skewed than the window drawn from it, so no selection
    policy over that pool could have produced a healthy corpus. A successful rebuild is
    therefore not evidence of repair, and "the job succeeded" must never be read as one.

    What makes that visible, and what the payload carries:

    * the JOINT (analyst outcome x model verdict) cross-tab, for the CURRENT corpus and
      for the projection a rebuild WOULD produce. Per-outcome counts alone read PRISTINE
      through the entire incident — a corpus that is 100% ``outcome=false_positive`` and
      also 100% ``verdict=NEEDS_HUMAN`` is telling the investigator "we escalated this
      every time", not "this is benign";
    * per-rule counts, and chunk/document totals;
    * the size of the qualifying POOL the bounded window was drawn from, so "200 of 889"
      is legible rather than implied;
    * the admission CONCENTRATION — how much of the selected window one operator
      transaction bought.

    It is deliberately a SEPARATE endpoint rather than a block inside
    ``/api/diagnostics/health``: deriving the would-be projection costs a bounded scan of
    the case store, and the health rollup is polled by the Console. It costs **zero
    embedding calls** either way — both halves come from a management read plus the
    ordinary per-case projector, whose metadata already carries both axes.

    Gated on ``settings:read`` like the rest of this router, seed-free, and advisory (#3).
    """
    rag = getattr(state, "rag_service", None)
    reader = getattr(rag, "corpus_composition", None) if rag is not None else None
    if reader is None:
        return {
            "generated_at": iso_now(),
            "available": False,
            "reason": (
                "this deployment's retrieval service does not expose a corpus "
                "composition report"
            ),
        }
    try:
        payload = await reader()
    except Exception as exc:  # noqa: BLE001 — diagnostics degrade, never 500
        logger.warning("precedent composition soft-failed: %s", exc)
        return {
            "generated_at": iso_now(),
            "available": False,
            "reason": f"the composition report could not be produced ({type(exc).__name__})",
        }
    return {"generated_at": iso_now(), "available": True, "reason": "", **dict(payload or {})}


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

    Seed-free, and read-only over everything an operator would call state: asking about
    corpus health never triggers an embedding spend, a projection, a case write or a
    configuration change. It does perform ONE bounded advisory write — the composition
    baseline a class-share shift is measured against, described in the module docstring.
    Advisory only; never read by ``decide()`` (#3)."""
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
    # Corpus COMPOSITION (the cross-tab a size guard cannot see) and the EMBEDDING
    # SPACE (what a reprojection stranded). Both are read-only and both degrade to an
    # explicit "could not be measured" rather than to a healthy-looking zero.
    composition = await _corpus_composition_block(state)
    rag = getattr(state, "rag_service", None)
    space_available, space_reason, space_docs = await _cached_corpus_documents(rag)
    embedding_space = _embedding_space_block(
        state, space_available, space_reason, space_docs
    )
    alerts, unknowns = _build_alerts(
        precedent, migration, auto_close, effectiveness, provider_health,
        composition, embedding_space,
    )
    return {
        "generated_at": iso_now(),
        "window_hours": int(window_hours),
        "demo_active": bool(getattr(state, "demo_active", False)),
        "state_backend": str(getattr(getattr(state, "secrets", None), "state_backend", "") or ""),
        "precedent_corpus": precedent,
        # Corpus SUPPLY, beside the corpus-health block above. Rendering and selecting
        # precedent better cannot refresh a corpus nothing new is being labelled into,
        # so this reports how long since the last qualifying precedent and how much
        # recorded feedback arrives with no ground truth at all. MEASURED VALUES ONLY —
        # no threshold, no status, no verdict, and an unmeasurable number stays null
        # rather than becoming a zero. Nothing here feeds `alerts`/`unknowns`.
        "ground_truth_supply": ground_truth_supply(cases, store_total=store_total),
        # Per-rule precedent distribution + the "more confirmations will not help"
        # finding. Advisory; never read by decide() (#3).
        "precedent_effectiveness": effectiveness,
        # COMPOSITION, not size: the (ground-truth source x analyst outcome x model
        # verdict) cross-tab, its movement against the previous reading, and any class
        # a single contributor holds on its own. ``outcome_only_view`` is published
        # beside it deliberately — that is the number that read pristine while the
        # corpus was poisoning the model.
        "corpus_composition": composition,
        # What an embedding-model change WOULD strand: documents still counted as
        # present but unreachable because they live in a superseded vector space.
        "embedding_space": embedding_space,
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
