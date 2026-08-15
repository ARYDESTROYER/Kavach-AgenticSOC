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
from ..tools.rag import (
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
    force: bool = False,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Delete an imported document. 404 if missing; 400 if a guarded seed source
    (runbook/mitre/suppression/resolved_case) unless ``?force=true``."""
    result = await state.rag_service.delete_document(document_id, force=force)
    if not result.get("found"):
        raise HTTPException(status_code=404, detail="document not found")
    if result.get("guarded"):
        raise HTTPException(
            status_code=400,
            detail="built-in seed corpus is protected; pass force=true to delete",
        )
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
