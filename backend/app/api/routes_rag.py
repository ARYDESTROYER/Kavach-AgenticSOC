"""RAG knowledge-base + operator-memory routes — Round 5 (Coupling-E extraction).

A cohesive slice carved OUT of the ``routes.py`` monolith with **byte-identical
paths, methods, auth dependencies, request/response bodies**. Handlers moved verbatim
(imports re-homed); the router is mounted in ``main.py`` under the SAME ``require_auth``
gate the monolith uses, so ``test_route_auth_coverage`` stays green.

It owns two closely-related surfaces:

* ``/api/rag/*`` — see + manage the RAG corpus the investigator/chat retrieve from
  (stats, list/get/import/delete documents, live retrieval preview).
* ``/api/memory/*`` — durable operator FACTS auto-injected as TRUSTED context into
  both automated investigations and chat.

NON-NEGOTIABLES held: #9 — imported/retrieved corpus text is UNTRUSTED and is fenced
by the RAG layer + rendered plain by the UI; memory NEVER overrides the deterministic
case_manager (it only informs the LLM). Every write is ``rag:manage``/``memory:manage``
gated.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..constants import ActionType
from ..state import AppState
from ..stores.precedent_exclusions import (
    PRECEDENT_EXCLUSION_REASONS,
    normalise_note,
    normalise_reason,
)
from ..tools.rag import (
    EXCLUSION_SELECTABLE_KEYS,
    PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT,
    PRECEDENT_RATIFICATION_PROVENANCE,
    TRUST_MODEL_UNCONFIRMED,
    is_bulk_ratified,
    precedent_ratification_entry,
)
from ..utils import iso_now, new_id
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.rag")

router = APIRouter(prefix="/api")


class RagDocumentsResponse(BaseModel):
    """The RAG corpus document-list envelope. Each document is a loose typed dict
    (title/source/chunk_count/…) rendered PLAIN by the UI (#9)."""

    documents: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0


class MemoryListResponse(BaseModel):
    """The operator-memory list envelope. Each entry is a loose typed dict
    (text/category/tags/source/active/…) rendered PLAIN by the UI (#9)."""

    entries: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0


# --------------------------------------------------------------------------- #
# RAG knowledge base — see + manage the corpus the investigator/chat retrieve
# from. Imports take effect immediately (same in-process corpus as retrieve()).
#
# These routes use ``state.rag_service`` (NOT the always-real ``state.rag``): while
# demo is engaged it returns the DEMO's isolated shared vector store, so the Knowledge
# page reflects the demo corpus and an import lands in the throwaway store (purged on
# demo disable) rather than surviving into the real corpus. Off demo the property is the
# real RagService — production behaviour is byte-identical.
# --------------------------------------------------------------------------- #
class RagImportRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=512)
    text: str = Field(..., min_length=1)
    source: str = "imported"
    tags: list[str] = Field(default_factory=list)


_RAG_MAX_TEXT = 1_000_000  # ~1MB cap on a single imported document body


@router.get("/rag/stats")
async def rag_stats(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """Corpus stats: total chunks, count by source, embedding model/dim, doc count."""
    return await state.rag_service.rag_stats()


@router.get("/rag/documents", response_model=RagDocumentsResponse)
async def rag_documents(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """List all documents in the RAG corpus (seeds grouped as seed:<source>)."""
    docs = await state.rag_service.list_documents()
    return {"documents": docs, "count": len(docs)}


@router.get("/rag/documents/{document_id}")
async def rag_document(
    document_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """A single document + its chunks. 404 if no such document."""
    doc = await state.rag_service.get_document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="document not found")
    return doc


@router.post("/rag/import", deprecated=True)
async def rag_import(
    body: RagImportRequest,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Deprecated request-bound single-document import compatibility route.

    New operator workflows submit bounded ``rag_import`` Jobs so indexing survives
    navigation and has durable progress. The document is chunked and embedded and
    takes effect immediately for retrieval. 400 on empty/oversized text.
    """
    title = (body.title or "").strip()
    text = body.text or ""
    if not title or not text.strip():
        raise HTTPException(status_code=400, detail="title and text are required")
    if len(text) > _RAG_MAX_TEXT:
        raise HTTPException(status_code=400, detail="text too large (max ~1MB)")
    result = await state.rag_service.import_document(
        title, text, source=(body.source or "imported").strip() or "imported", tags=body.tags
    )
    if not result.get("chunk_count"):
        raise HTTPException(status_code=400, detail="document produced no indexable chunks")
    return result


@router.delete("/rag/documents/{document_id}")
async def rag_delete_document(
    document_id: str,
    request: Request,
    force: bool = False,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Delete an imported document. 404 if missing; 400 if a guarded seed source
    (runbook/mitre/suppression/resolved_case) unless ``?force=true``.

    Every SUCCESSFUL delete is audited. It previously was not: a ``force=true`` delete
    is the single most destructive corpus mutation the API offers — it removes protected
    built-in knowledge or an analyst-confirmed precedent — and it left no record at all,
    so "where did that runbook go?" was unanswerable. The row carries the document id and
    the force flag; no chunk text ever enters it (#9).

    For a PRECEDENT document, note that a plain force-delete does not stay deleted: the
    next projection re-derives that case from the case store. ``POST
    /api/rag/precedent/exclusions`` is the supported way to make a precedent removal
    stick, and it performs this same delete as its second half.
    """
    result = await state.rag_service.delete_document(document_id, force=force)
    if not result.get("found"):
        raise HTTPException(status_code=404, detail="document not found")
    if result.get("guarded"):
        raise HTTPException(
            status_code=400,
            detail="built-in seed corpus is protected; pass force=true to delete",
        )
    actor = current_username(request) or "operator"
    try:
        await state.audit.record(
            action_type=ActionType.CONTEXT,
            surface="rag_document_delete",
            actor=actor,
            result_summary=(
                f"deleted knowledge document {document_id} "
                f"chunks={int(result.get('deleted') or 0)} force={bool(force)}"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — the delete already happened
        logger.warning("rag document delete audit failed for %s: %s", document_id, exc)
    return {"document_id": document_id, "deleted": result.get("deleted", 0)}


@router.get("/rag/search")
async def rag_search(
    q: str,
    top_k: int = 5,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """Run a retrieval against the live corpus and return the chunks RAG would feed
    an investigation — so an operator can SEE what the knowledge base returns."""
    query = (q or "").strip()
    if not query:
        return {"query": "", "chunks": [], "count": 0}
    await state.rag_service.ensure_seeded()
    chunks = await state.rag_service.retrieve(query, top_k=max(1, min(int(top_k or 5), 50)))
    return {
        "query": query,
        "count": len(chunks),
        "chunks": [c.model_dump() for c in chunks],
    }


# --------------------------------------------------------------------------- #
# BULK GROUND-TRUTH BOOTSTRAP — escaping the precedent cold start honestly.
#
# The precedent corpus only accepts analyst-confirmed outcomes
# (``engine/analyst_outcomes.analyst_confirmed_outcome``), and that gate is CORRECT:
# letting the agent index its own unreviewed closes would be a self-confirmation loop.
# But a fully autonomous deployment can never satisfy it, so the only way anyone has
# had to seed precedent is scripting ``POST /api/cases/{id}/feedback`` a few thousand
# times — which forges analyst feedback and makes model verdicts look like independent
# ground truth to the THRESHOLD TUNER as well as to RAG (a tuning proposal then honestly
# reports "97 analyst labels / 97 confirmed FP" when the true independent count is zero).
#
# This endpoint is the supported alternative. It ratifies MODEL verdicts into the
# explicitly weaker ``model_unconfirmed`` tier and records that provenance durably.
#
# What it does NOT do, deliberately:
#   * it does NOT write ``FeedbackEntry`` rows, so ``analyst_confirmed_outcome`` still
#     returns nothing for these cases and the threshold tuner's independent-evidence
#     count is unchanged;
#   * it does NOT fabricate analyst identity — the marker records the ratifying
#     OPERATOR and states that the outcome is not an independent analyst outcome;
#   * it does NOT upgrade any trust tier — a ratified precedent stays
#     ``model_unconfirmed`` for ever unless a human actually classifies the case;
#   * it does NOT touch ``status``/``disposition``/``decision_by`` or go anywhere near
#     the deterministic ``decide()`` (#3).
# --------------------------------------------------------------------------- #
_PRECEDENT_BOOTSTRAP_MAX = 1000

_PRECEDENT_BOOTSTRAP_DISCLAIMER = [
    "Ratified entries are indexed as the lower-trust 'model_unconfirmed' precedent "
    "tier and are always outranked and share-capped against analyst-confirmed ones.",
    "No analyst feedback is written and no analyst identity is fabricated: "
    "independent analyst-outcome counts (threshold tuning included) are unchanged.",
    "Nothing is promoted: a ratified case stays 'model_unconfirmed' until a human "
    "explicitly classifies it.",
    "Case status, disposition and decision_by are untouched; the deterministic "
    "close/escalate decision is never involved.",
]


class PrecedentBootstrapRequest(BaseModel):
    """An explicit, honest ratification of MODEL verdicts as weak precedent."""

    acknowledgement: str = Field(
        ...,
        description=(
            "Must be exactly: " + PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT
        ),
    )
    limit: int = Field(default=200, ge=1, le=_PRECEDENT_BOOTSTRAP_MAX)
    # A caller-supplied idempotency key for one logical backfill. Re-running with the
    # same key (or none) is safe either way: already-ratified cases are skipped.
    batch_id: str = Field(default="", max_length=64)
    dry_run: bool = False


def _precedent_preview(state: AppState) -> dict[str, Any]:
    rag_cfg = getattr(state.prefs, "rag", None)
    guards = getattr(rag_cfg, "unconfirmed_precedent", None)
    return {
        "tier_enabled": bool(
            getattr(rag_cfg, "use_resolved_cases", False)
            and getattr(rag_cfg, "use_unconfirmed_resolved_cases", False)
        ),
        "use_resolved_cases": bool(getattr(rag_cfg, "use_resolved_cases", False)),
        "use_unconfirmed_resolved_cases": bool(
            getattr(rag_cfg, "use_unconfirmed_resolved_cases", False)
        ),
        "trust_class": TRUST_MODEL_UNCONFIRMED,
        "provenance": PRECEDENT_RATIFICATION_PROVENANCE,
        "acknowledgement_required": PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT,
        "max_batch": _PRECEDENT_BOOTSTRAP_MAX,
        "guards": guards.model_dump(mode="json") if guards is not None else {},
        "does_not": list(_PRECEDENT_BOOTSTRAP_DISCLAIMER),
    }


async def perform_precedent_candidate(
    case: Any,
    item: dict[str, Any],
    state: AppState,
    *,
    actor: str,
    batch_id: str,
) -> dict[str, Any]:
    """Idempotently ratify and project one lower-trust precedent candidate.

    The history marker is the first-writer authority. If a worker restarts after the
    case save but before projection acknowledgement, re-entering this helper skips the
    duplicate history append and safely upserts the same ``resolved_case:<id>`` RAG
    document. Both the synchronous route and durable Jobs runner use this seam.
    """
    newly_ratified = not is_bulk_ratified(case)
    if newly_ratified:
        entry = precedent_ratification_entry(
            actor=actor,
            batch_id=batch_id,
            outcome=str((item.get("metadata") or {}).get("outcome") or ""),
            confidence=float(case.confidence or 0.0),
        )
        case.history.append(entry)
        await state.cases.save(case)
        try:
            await state.audit.record(
                action_type=ActionType.CONTEXT,
                surface="rag_precedent_bootstrap",
                actor=actor,
                case_id=case.case_id,
                result_summary=(
                    "bulk-ratified MODEL verdict as precedent "
                    f"trust_class={TRUST_MODEL_UNCONFIRMED} "
                    f"provenance={PRECEDENT_RATIFICATION_PROVENANCE} "
                    f"batch={batch_id} independent_analyst_outcome=false"
                ),
            )
        except Exception as exc:  # existing domain audit remains fail-soft per row
            logger.warning(
                "precedent ratification audit failed for %s: %s", case.case_id, exc
            )
    indexed = await state.rag_service.index_precedent_items(
        [item], ratified_by=actor, batch_id=batch_id
    )
    if indexed < 1:
        raise RuntimeError("precedent projection produced no indexable chunk")
    if not any(
        isinstance(entry, dict)
        and entry.get("event") == "precedent_projection_ack"
        for entry in list(case.history or [])
    ):
        case.history.append(
            {
                "ts": iso_now(),
                "event": "precedent_projection_ack",
                "batch_id": str(batch_id or ""),
                "projected_by": str(actor or ""),
            }
        )
        await state.cases.save(case)
    return {"ratified": newly_ratified, "indexed": indexed}


def is_precedent_projected(case: Any) -> bool:
    """Durable acknowledgement that the ratified case reached the RAG projection."""
    return any(
        isinstance(entry, dict)
        and entry.get("event") == "precedent_projection_ack"
        for entry in list(getattr(case, "history", None) or [])
    )


@router.get("/rag/precedent/bootstrap")
async def precedent_bootstrap_status(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """Preview the bulk bootstrap: tier state, guards, and how many cases qualify.

    Read-only. ``eligible`` counts guard-passing candidates within the bounded scan;
    ``pending`` is how many of those are not yet ratified."""
    preview = _precedent_preview(state)
    candidates: list[Any] = []
    if preview["tier_enabled"]:
        candidates = await state.rag_service.unconfirmed_precedent_candidates(
            _PRECEDENT_BOOTSTRAP_MAX
        )
    preview["eligible"] = len(candidates)
    preview["pending"] = sum(1 for case, _ in candidates if not is_bulk_ratified(case))
    return preview


async def perform_precedent_bootstrap(
    body: PrecedentBootstrapRequest,
    state: AppState,
    actor: str,
) -> dict[str, Any]:
    """Canonical domain operation for lower-trust precedent ratification.

    HTTP and durable-job callers enforce their own live permissions before entering
    this helper. Keeping the mutation here makes their ground-truth, provenance,
    idempotency, indexing, and per-case audit semantics identical.
    """
    if (body.acknowledgement or "").strip() != PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT:
        raise HTTPException(
            status_code=400,
            detail=(
                "explicit acknowledgement required; send acknowledgement="
                f"{PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT!r}"
            ),
        )
    preview = _precedent_preview(state)
    if not preview["tier_enabled"]:
        raise HTTPException(
            status_code=409,
            detail=(
                "the lower-trust precedent tier is disabled; enable "
                "rag.use_resolved_cases and rag.use_unconfirmed_resolved_cases in "
                "settings before bootstrapping (this endpoint never enables it for you)"
            ),
        )

    actor = (actor or "operator").strip() or "operator"
    batch_id = (body.batch_id or "").strip() or new_id("ratify")
    # The scan cap is the ENDPOINT's bound, not ``guards.max_items``: the operator is
    # deliberately seeding a backlog here, whereas ``max_items`` bounds how much the
    # automatic periodic projection may (re-)derive on its own. Everything ratified
    # stays subject to the age-out, rank penalty and context-share caps at retrieval,
    # so a large backlog buys visibility, never influence.
    candidates = await state.rag_service.unconfirmed_precedent_candidates(
        _PRECEDENT_BOOTSTRAP_MAX
    )
    already = [pair for pair in candidates if is_bulk_ratified(pair[0])]
    pending_projection = [
        pair
        for pair in candidates
        if is_bulk_ratified(pair[0]) and not is_precedent_projected(pair[0])
    ]
    pending = [pair for pair in candidates if not is_bulk_ratified(pair[0])]
    batch = (pending_projection + pending)[: int(body.limit)]

    ratified: list[str] = []
    failed: list[str] = []
    indexed = 0
    if not body.dry_run:
        for case, item in batch:
            try:
                outcome = await perform_precedent_candidate(
                    case,
                    item,
                    state,
                    actor=actor,
                    batch_id=batch_id,
                )
            except Exception as exc:  # noqa: BLE001 — one bad case must not abort the batch
                logger.warning(
                    "precedent ratification could not complete %s: %s", case.case_id, exc
                )
                failed.append(case.case_id)
                continue
            ratified.append(case.case_id)
            indexed += int(outcome["indexed"])

    await state.audit.record(
        action_type=ActionType.CONTEXT,
        surface="rag_precedent_bootstrap",
        actor=actor,
        result_summary=(
            f"precedent bootstrap batch={batch_id} dry_run={body.dry_run} "
            f"eligible={len(candidates)} ratified={len(ratified)} indexed={indexed} "
            f"already_ratified={len(already)} failed={len(failed)} "
            f"trust_class={TRUST_MODEL_UNCONFIRMED} "
            f"provenance={PRECEDENT_RATIFICATION_PROVENANCE} "
            "independent_analyst_outcome=false"
        ),
    )

    return {
        "ok": not failed,
        "batch_id": batch_id,
        "at": iso_now(),
        "actor": actor,
        "dry_run": bool(body.dry_run),
        "trust_class": TRUST_MODEL_UNCONFIRMED,
        "provenance": PRECEDENT_RATIFICATION_PROVENANCE,
        "eligible": len(candidates),
        "selected": len(batch),
        "ratified": len(ratified),
        "indexed": indexed,
        "already_ratified": len(already),
        "failed": failed,
        # Still un-ratified after this batch — call again with the same body to resume.
        "remaining": max(0, len(pending) - len(ratified)),
        "case_ids": ratified[:100],
        "does_not": list(_PRECEDENT_BOOTSTRAP_DISCLAIMER),
    }


@router.post("/rag/precedent/bootstrap", deprecated=True)
async def precedent_bootstrap(
    body: PrecedentBootstrapRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
    __=Depends(require_permission("cases", "write")),
) -> dict[str, Any]:
    """Deprecated request-bound bulk-ratification compatibility route.

    New operator workflows submit ``precedent_bootstrap`` through ``POST /api/jobs``
    for durable per-case progress and projection recovery.

    Bounded, idempotent, resumable, and explicitly acknowledged. The route preserves
    the historical synchronous API while sharing the exact domain operation with the
    durable Jobs subsystem.
    """
    return await perform_precedent_bootstrap(
        body,
        state,
        current_username(request) or "operator",
    )


# --------------------------------------------------------------------------- #
# PRECEDENT CORPUS REPAIR — composition, and exclusions that stay excluded.
#
# Two distinct operator questions, answered by two read/write surfaces:
#
#   * ``GET /api/rag/precedent/composition`` — WHAT IS IN THERE, and what would a
#     rebuild put in there? A dry run that costs zero embedding calls. Read it BEFORE
#     rebuilding: reprojection is not a repair, because the projection re-selects the
#     same newest qualifying cases it selected last time.
#   * ``/api/rag/precedent/exclusions`` — evict ONE precedent so it STAYS evicted. A
#     plain force-delete does not: the next projection re-derives the case and puts it
#     straight back, and until now the only way to make it stick was to destroy the
#     analyst's own label — which rewrites ground truth and corrupts the threshold
#     tuner's independent-evidence count.
#
# Neither surface touches ground truth (#3-adjacent, and deliberately): no feedback row,
# no disposition, no decision_by, no status, no history rewrite. Neither the exclusion
# reason nor its note ever enters a corpus chunk or a prompt (#9) — they are UI/audit
# fields only.
# --------------------------------------------------------------------------- #
_EXCLUSION_MAX_CASE_IDS = 200


class PrecedentExclusionRequest(BaseModel):
    """Exclude one or more cases from the precedent corpus.

    Supply ``case_ids`` directly, or ``select`` a population by the projection's OWN
    metadata keys. Free-text rule-title matching is deliberately NOT offered: a title is
    content, and a detection-content update rewrites it underneath a saved selection.
    """

    case_ids: list[str] = Field(default_factory=list, max_length=_EXCLUSION_MAX_CASE_IDS)
    # Bounded implicitly by the allowlist check below: any key that is not one of the
    # projection's own metadata keys is a 400, so this map can never exceed that set.
    select: dict[str, str] = Field(default_factory=dict)
    reason: str = Field(default="other", max_length=64)
    note: str = Field(default="", max_length=2000)
    dry_run: bool = False


@router.get("/rag/precedent/composition")
async def precedent_composition(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """The corpus as it stands, beside the projection a rebuild WOULD produce.

    Read-only and free: it embeds nothing, seeds nothing and writes nothing, because both
    halves are derivable from a management read plus the ordinary per-case projector,
    whose item metadata already carries the analyst outcome AND the model verdict.

    Reports the JOINT (analyst outcome x model verdict) distribution rather than either
    marginal alone — outcome-only counts read PRISTINE on a corpus that is actively
    poisoning the model — plus per-rule counts, chunk/document totals, the size of the
    QUALIFYING POOL the window was drawn from (so "200 of 889" is visible), and how
    concentrated the selected window is in one operator transaction.
    """
    return await state.rag_service.corpus_composition()


@router.get("/rag/precedent/exclusions")
async def precedent_exclusions(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "read")),
) -> dict[str, Any]:
    """The case-scoped precedent exclusion set: count, ids, per-rule and per-reason.

    ``available: false`` means the set could not be READ — never that nothing is
    excluded. The two are different answers and conflating them would report a broad
    exclusion as an empty one.
    """
    payload = await state.rag_service.precedent_exclusions()
    payload["reasons"] = list(PRECEDENT_EXCLUSION_REASONS)
    payload["selectable_keys"] = sorted(EXCLUSION_SELECTABLE_KEYS)
    return payload


@router.post("/rag/precedent/exclusions")
async def precedent_exclude(
    body: PrecedentExclusionRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Exclude cases from the precedent corpus: DELETE + MARK, per case, atomically.

    The marker is written first so no producer can re-derive the precedent while its
    chunks are being removed; the delete follows. Idempotent — re-issuing the same
    exclusion refreshes the marker and finishes any removal that did not complete.

    ``dry_run`` resolves the selection and returns the case ids WITHOUT excluding
    anything. Every exclusion is audited per case.

    Ground truth is untouched: the case keeps its analyst label, so
    ``analyst_confirmed_outcome`` — and the threshold tuner's independent-evidence count,
    which is derived from it — are unchanged. Side effect, by design: an excluded case is
    also no longer indexed by the incremental close-time path.
    """
    rag = state.rag_service
    reason = normalise_reason(body.reason)
    note = normalise_note(body.note)
    case_ids = [str(cid).strip() for cid in body.case_ids if str(cid).strip()]
    selection: dict[str, Any] = {}
    if body.select:
        selection = await rag.select_precedent_cases(dict(body.select))
        if not selection.get("ok"):
            raise HTTPException(status_code=400, detail=str(selection.get("reason") or ""))
        case_ids.extend(str(cid) for cid in selection.get("case_ids") or [])
    # De-duplicate while preserving the caller's order, then bound.
    seen: set[str] = set()
    ordered: list[str] = []
    for case_id in case_ids:
        if case_id not in seen:
            seen.add(case_id)
            ordered.append(case_id)
    ordered = ordered[:_EXCLUSION_MAX_CASE_IDS]
    if not ordered:
        raise HTTPException(
            status_code=400, detail="no case matched; supply case_ids or a select filter"
        )
    if body.dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "reason": reason,
            "selected": len(ordered),
            "case_ids": ordered,
            "selection": selection,
            "excluded": 0,
        }

    actor = current_username(request) or "operator"
    excluded: list[str] = []
    incomplete: list[str] = []
    failed: list[dict[str, str]] = []
    for case_id in ordered:
        outcome = await rag.exclude_precedent_case(
            case_id, reason=reason, note=note, actor=actor
        )
        if not outcome.get("ok"):
            failed.append({"case_id": case_id, "reason": str(outcome.get("reason") or "")})
            continue
        excluded.append(case_id)
        if not outcome.get("complete"):
            incomplete.append(case_id)
        try:
            await state.audit.record(
                action_type=ActionType.CONTEXT,
                surface="rag_precedent_exclusion",
                actor=actor,
                case_id=case_id,
                result_summary=(
                    f"excluded case from the precedent corpus reason={reason} "
                    f"chunks_deleted={int(outcome.get('deleted') or 0)} "
                    f"complete={bool(outcome.get('complete'))} "
                    "ground_truth_unchanged=true"
                ),
            )
        except Exception as exc:  # noqa: BLE001 — the exclusion already stands
            logger.warning("precedent exclusion audit failed for %s: %s", case_id, exc)
    return {
        "ok": not failed,
        "dry_run": False,
        "at": iso_now(),
        "actor": actor,
        "reason": reason,
        "selected": len(ordered),
        "excluded": len(excluded),
        "case_ids": excluded,
        # Marker written, chunks not removed. The exclusion is in force either way;
        # re-issue the same request to finish the removal.
        "incomplete": incomplete,
        "failed": failed,
        "selection": selection,
    }


class PrecedentRepairRequest(BaseModel):
    """Re-render stored precedent from the CURRENT builder and rewrite what drifted.

    There is no selector here, and that is the design. No metadata key records which
    generation of the builder produced a chunk's text, so the ONLY honest selector is
    to render each case again through the same projector the projection uses and
    compare the two strings. A free-text selector over chunk TEXT would be strictly
    worse than the free-text metadata selector this module already refuses: precedent
    text carries the analyst note, the model's recommended action and log-derived
    evidence summaries, so matching prose means matching attacker- and
    operator-influenceable content (#9).
    """

    #: DEFAULT. Resolves and reports without embedding, writing or deleting anything.
    dry_run: bool = True


@router.post("/rag/precedent/repair")
async def precedent_repair(
    body: PrecedentRepairRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Repair precedent whose stored TEXT no longer matches the current projection.

    ``dry_run`` (the default) reports per-tier ``scanned / current / stale /
    undetermined / not_projecting`` counts plus ``would_repair`` and ``would_evict``,
    and costs nothing. A real run re-embeds exactly the chunks whose re-render differs
    and upserts them on their existing chunk id — one metered embedding per repaired
    chunk (#6), bounded per run by a cap derived from the configured precedent window.

    The ONLY removable chunk is one whose case is POSITIVELY absent from the case
    store. An operator-EXCLUDED case and one whose analyst label was WITHDRAWN are
    reported, never deleted: those are operator decisions and their home is the
    exclusion API. Before any removal the evicted document id, text and metadata are
    written to the append-only audit trail — that record is the only reconstruction
    path, because the store upserts and a repair is idempotent and re-derivable but not
    reversible to the prior render.

    Ground truth is untouched: no feedback row, no disposition, no decision_by, no
    status, no history rewrite (#3).
    """
    actor = current_username(request) or "operator"

    async def _record_evicted(payload: dict[str, Any]) -> None:
        """Write the payload BEFORE its chunk is destroyed. Raising blocks the removal.

        This is the ONE place a precedent chunk's text reaches the audit trail, and it
        is deliberate: an eviction is unrecoverable without it. ``record_strict``
        propagates a durability failure, and the caller treats that as "no record, no
        removal" rather than destroying evidence it could not preserve.
        """
        await state.audit.record_strict(
            action_type=ActionType.CONTEXT,
            surface="rag_precedent_repair",
            actor=actor,
            case_id=str(payload.get("case_id") or "") or None,
            tool_name="precedent_evicted_chunk",
            tool_input=payload,
            result_summary=(
                "evicted precedent whose case is absent from the case store "
                f"document_id={payload.get('document_id')} "
                f"trust_class={payload.get('trust_class')} "
                "ground_truth_unchanged=true"
            ),
        )

    report = await state.rag_service.repair_precedent_projection(
        dry_run=bool(body.dry_run), on_evict=_record_evicted
    )
    if body.dry_run:
        # A dry run mutates nothing, so it leaves no trail: an append-only log of
        # "somebody looked" would bury the records that describe an actual change.
        return report
    try:
        tiers = report.get("tiers") or {}
        await state.audit.record(
            action_type=ActionType.CONTEXT,
            surface="rag_precedent_repair",
            actor=actor,
            # COUNTS, DOCUMENT IDS AND REASON CODES ONLY. The evicted-payload record
            # above is the deliberate, narrow exception and is scoped to the delete
            # path alone; a summary row must never carry corpus text.
            result_summary=(
                f"repaired the precedent projection scanned={int(report.get('scanned') or 0)} "
                f"repaired={int(report.get('repaired') or 0)} "
                f"evicted={int(report.get('evicted') or 0)} "
                f"remaining={int(report.get('remaining') or 0)} "
                f"complete={bool(report.get('complete'))} "
                f"refused={bool(report.get('refused'))} "
                f"reason_code={str(report.get('reason_code') or '')} "
                + " ".join(
                    f"{name}.stale={int(tier.get('stale') or 0)}"
                    for name, tier in sorted(tiers.items())
                )
                + " ground_truth_unchanged=true"
            ),
            tool_name="precedent_repair",
            tool_input={
                "repaired_documents": list(report.get("repaired_documents") or []),
                "evicted_documents": list(report.get("evicted_documents") or []),
                "incomplete_evictions": list(report.get("incomplete_evictions") or []),
                # Written, but not visible on the verifying read-back. Document ids
                # only, like every other list here.
                "unverified_repairs": list(report.get("unverified_repairs") or []),
            },
        )
    except Exception as exc:  # noqa: BLE001 — the repair already stands
        logger.warning("precedent repair audit failed: %s", exc)
    return report


@router.delete("/rag/precedent/exclusions/{case_id}")
async def precedent_restore(
    case_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Drop a precedent exclusion. 404 when the case is not excluded.

    Removes the marker only: the precedent reappears on the NEXT ordinary projection,
    derived from the case store exactly as it would have been. Nothing is written to the
    corpus here — an un-exclusion must not be able to mint a chunk the projection would
    not have produced.
    """
    outcome = await state.rag_service.restore_precedent_case(case_id)
    if not outcome.get("ok"):
        raise HTTPException(status_code=400, detail=str(outcome.get("reason") or ""))
    if not outcome.get("found"):
        raise HTTPException(status_code=404, detail="case is not excluded")
    actor = current_username(request) or "operator"
    try:
        await state.audit.record(
            action_type=ActionType.CONTEXT,
            surface="rag_precedent_exclusion",
            actor=actor,
            case_id=str(case_id),
            result_summary=(
                "restored case to the precedent corpus; it is re-derived on the next "
                "projection ground_truth_unchanged=true"
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("precedent restore audit failed for %s: %s", case_id, exc)
    return {"ok": True, "case_id": str(case_id), "count": int(outcome.get("count") or 0)}


# --------------------------------------------------------------------------- #
# Operator MEMORY — durable facts the agents remember (auto-injected as TRUSTED
# operator context into BOTH automated investigations and chat). Editing is
# EXPLICIT (here, source="human") or via chat ("remember:"/"forget", source="agent").
# Memory NEVER overrides the deterministic case_manager — it only informs the LLM.
# --------------------------------------------------------------------------- #
class MemoryCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    category: str = ""
    tags: list[str] = Field(default_factory=list)


class MemoryUpdate(BaseModel):
    text: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    active: bool | None = None
    review_status: str | None = Field(default=None, pattern=r"^(approved|pending)$")


@router.get("/memory", response_model=MemoryListResponse)
async def list_memory(
    active_only: bool = False,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "read")),
) -> dict[str, Any]:
    """List operator memory entries (newest first). ``?active_only=true`` hides
    de-activated facts."""
    entries = await state.memory.list(active_only=active_only)
    return {
        "entries": [e.model_dump(mode="json") for e in entries],
        "count": len(entries),
    }


@router.post("/memory")
async def add_memory(
    body: MemoryCreate,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "manage")),
) -> dict[str, Any]:
    """Add an operator fact (source='human'). Auto-injected into future
    investigations + chat as TRUSTED context."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    entry = await state.memory.add(
        text,
        category=body.category,
        tags=body.tags,
        source="human",
        author=current_username(request),
        review_status="approved",
        approved_by=current_username(request),
    )
    return entry.model_dump(mode="json")


@router.put("/memory/{entry_id}")
async def update_memory(
    entry_id: str,
    body: MemoryUpdate,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "manage")),
) -> dict[str, Any]:
    """Edit a memory entry (text/category/tags) or toggle ``active``."""
    patch = body.model_dump(exclude_none=True)
    if patch.get("review_status") == "approved":
        patch["approved_by"] = current_username(request) or "operator"
    updated = await state.memory.update(entry_id, **patch)
    if updated is None:
        raise HTTPException(status_code=404, detail="memory entry not found")
    return updated.model_dump(mode="json")


@router.delete("/memory/{entry_id}")
async def delete_memory(
    entry_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "manage")),
) -> dict[str, Any]:
    """Permanently delete a memory entry. 404 if missing."""
    ok = await state.memory.delete(entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="memory entry not found")
    return {"ok": True, "id": entry_id}
