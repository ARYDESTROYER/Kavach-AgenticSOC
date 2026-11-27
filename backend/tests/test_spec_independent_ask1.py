"""SPEC-DERIVED, implementation-blind tests for ASK 1 (precedent corpus repair).

Written from ``tmp/SPEC.md`` alone, without reading ``app/tools/rag.py``,
``app/api/routes_rag.py``, ``app/api/routes_diagnostics.py``, ``app/api/routes.py``,
``app/stores/base.py``, ``app/stores/cases.py`` or ``app/stores/sql/repositories.py``.
Public names were discovered by CALLING the contract and by ``inspect`` at runtime, so
every bound asserted here is DERIVED from something the product itself reports rather
than copied out of the source.

Why implementation-blind matters for this particular feature: the repair pass is the
only code in the product that DELETES from the precedent corpus. A test derived from
the code can only confirm that the delete branch does whatever it does. These tests
instead pin the four things the spec says must be true of a destructive maintenance
pass — that it selects by re-derivation and not by prose, that it never deletes an
operator decision, that it records before it removes, and that it refuses rather than
collapsing a tier.

Also carries the CROSS-CUTTING gate-invariance truth table (X3/X4) and the cold-start
no-op (X8), because a corpus-repair change lives one import away from ``decide()`` and
non-negotiable #3 says the close/escalate authority may not move.
"""

from __future__ import annotations

import copy
from datetime import timedelta
from typing import Any

import pytest

from app.api.routes_diagnostics import _precedent_corpus_block
from app.config import Preferences
from app.constants import (
    SEVERITY_BANDS,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.case_manager import decide
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, EvidenceItem
from app.state import AppState
from app.tools.vectorstore import ESVectorStore, StoredChunk
from app.utils import now_utc

PRECEDENT_SOURCE = "resolved_case"


# --------------------------------------------------------------------------- #
# Builders — deliberately generic. No vendor, product, rule or detection name,
# no deployment-observed number, no scale-tied severity value (P2 / P4).
# --------------------------------------------------------------------------- #
def _confirmed_case(
    case_id: str,
    *,
    created_at: str,
    note: str = "",
    summary: str = "Recurring low-value pattern",
    outcome: Disposition = Disposition.FALSE_POSITIVE,
    verdict: Verdict = Verdict.FALSE_POSITIVE,
    labelled: bool = True,
) -> Case:
    """A terminal case carrying (or, with ``labelled=False``, lacking) analyst ground
    truth. ``note`` and ``summary`` are free prose the projector renders verbatim —
    A14 turns them into an attack surface on purpose."""
    history: list[dict[str, Any]] = []
    if labelled:
        history.append(
            {
                "ts": created_at,
                "event": "analyst_action",
                "action": "set_disposition",
                "note": note,
            }
        )
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.HOST, value="host-a"),
        rule_ids=["rule-a"],
        verdict=verdict,
        confidence=0.9,
        risk_score=12.5,
        status=CaseStatus.CLOSED,
        created_at=created_at,
        updated_at=created_at,
        decision_by=DecisionBy.ANALYST if labelled else DecisionBy.AGENT,
        disposition=outcome if labelled else None,
        history=history,
        evidence=[EvidenceItem(summary=summary, note=note)] if note else [EvidenceItem(summary=summary)],
        recommended_action="No action required.",
    )


def _unconfirmed_case(case_id: str, *, created_at: str) -> Case:
    """A terminal case the AGENT closed and no analyst ever reviewed — the
    ``model_unconfirmed`` tier's raw material."""
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.HOST, value="host-a"),
        rule_ids=["rule-a"],
        verdict=Verdict.TRUE_POSITIVE,
        confidence=0.95,
        risk_score=42.0,
        status=CaseStatus.CLOSED,
        created_at=created_at,
        updated_at=created_at,
        decision_by=DecisionBy.AGENT,
        disposition=None,
        history=[],
        evidence=[EvidenceItem(summary="Repeated pattern")],
        recommended_action="No action required.",
    )


def _enable_precedent(state: AppState, **rag_update: Any) -> None:
    update = {"enabled": True, "use_resolved_cases": True, "min_score": 0.0}
    update.update(rag_update)
    prefs = _current_prefs(state)
    _push_prefs(state, prefs.model_copy(update={"rag": prefs.rag.model_copy(update=update)}))


# ``RagService.set_prefs`` replaces the WHOLE preference document, so two helpers that
# each rebuild it from ``state.prefs`` would silently undo one another. Every push goes
# through this one accumulator instead.
# Stashed ON the state object (never in a dict keyed by ``id()``, which CPython
# recycles between tests) so two tests can never share an accumulator.
_PREFS_ATTR = "_spec_independent_prefs"


def _current_prefs(state: AppState) -> Preferences:
    return getattr(state, _PREFS_ATTR, None) or state.prefs


def _push_prefs(state: AppState, prefs: Preferences) -> None:
    setattr(state, _PREFS_ATTR, prefs)
    state.rag.set_prefs(prefs)


def _set_window(state: AppState, **window_update: Any) -> None:
    prefs = _current_prefs(state)
    precedent = prefs.precedent
    _push_prefs(
        state,
        prefs.model_copy(
            update={
                "precedent": precedent.model_copy(
                    update={"window": precedent.window.model_copy(update=window_update)}
                )
            }
        ),
    )


def _set_repair(state: AppState, **repair_update: Any) -> None:
    prefs = _current_prefs(state)
    precedent = prefs.precedent
    _push_prefs(
        state,
        prefs.model_copy(
            update={
                "precedent": precedent.model_copy(
                    update={"repair": precedent.repair.model_copy(update=repair_update)}
                )
            }
        ),
    )


def _change_embedding_space(state: AppState, suffix: str) -> None:
    """Move the corpus's embedding SPACE by renaming the configured embedding model.

    The model name is read off the live preference rather than written down, so this
    stays correct on a deployment configured for a different provider."""
    prefs = _current_prefs(state)
    current = prefs.embedding_model
    _push_prefs(
        state,
        prefs.model_copy(
            update={"embedding_model": current.model_copy(update={"model": current.model + suffix})}
        ),
    )


async def _precedent_chunks(state: AppState) -> list[StoredChunk]:
    return [
        c for c in await state.rag._store.list_all_chunks() if c.source == PRECEDENT_SOURCE
    ]


async def _by_case(state: AppState) -> dict[str, StoredChunk]:
    return {str((c.metadata or {}).get("case_id") or ""): c for c in await _precedent_chunks(state)}


def _clone_with_text(chunk: StoredChunk, text: str) -> StoredChunk:
    """A byte-for-byte copy of ``chunk`` except for its rendered text.

    The metadata, the vector, the embedding space and the ``doc_id`` all survive, so
    the ONLY thing a selector can notice is that the text no longer matches what the
    current builder would produce."""
    return StoredChunk(
        text=text,
        source=chunk.source,
        metadata=copy.deepcopy(chunk.metadata),
        embedding=list(chunk.embedding),
        embedding_model=chunk.embedding_model,
        dim=chunk.dim,
        doc_id=chunk.doc_id,
    )


async def _replace_text(state: AppState, chunk: StoredChunk, text: str) -> None:
    """Overwrite one stored chunk's text in place, leaving the corpus size alone."""
    document_id = str((chunk.metadata or {}).get("document_id") or "")
    await state.rag._store.delete_document(document_id)
    await state.rag._store.add([_clone_with_text(chunk, text)])


class _CountingEmbedder:
    """Counts every trip to the single LLM gateway's embedding entry point (#6)."""

    def __init__(self, state: AppState) -> None:
        self._inner = state.rag._gateway.embed_with_provenance
        self.calls = 0
        state.rag._gateway.embed_with_provenance = self  # type: ignore[assignment]

    async def __call__(self, *args: Any, **kwargs: Any):
        self.calls += 1
        return await self._inner(*args, **kwargs)


class _DeleteSpy:
    """Wraps the store's ONLY removal primitive so a test can prove a refusal never
    reached it — ``mutated == 0`` alone cannot distinguish "refused" from "deleted
    then miscounted"."""

    def __init__(self, state: AppState) -> None:
        self._inner = state.rag._store.delete_document
        self.calls: list[str] = []
        state.rag._store.delete_document = self  # type: ignore[assignment]

    async def __call__(self, document_id: str) -> int:
        self.calls.append(document_id)
        return await self._inner(document_id)


async def _seed_confirmed(state: AppState, n: int, *, prefix: str = "c") -> list[StoredChunk]:
    for i in range(n):
        await state.cases.save(
            _confirmed_case(f"{prefix}-{i:03d}", created_at=f"2026-02-01T00:{i:02d}:00Z")
        )
    await state.rag.ensure_seeded()
    return await _precedent_chunks(state)


def _ghost(template: StoredChunk, case_id: str, *, text: str = "orphaned render") -> StoredChunk:
    """A precedent chunk whose backing case is positively ABSENT from the case store."""
    metadata = copy.deepcopy(template.metadata)
    metadata["case_id"] = case_id
    metadata["document_id"] = f"{PRECEDENT_SOURCE}:{case_id}"
    return StoredChunk(
        text=text,
        source=PRECEDENT_SOURCE,
        metadata=metadata,
        embedding=list(template.embedding),
        embedding_model=template.embedding_model,
        dim=template.dim,
        doc_id=f"{PRECEDENT_SOURCE}:{case_id}",
    )


# =========================================================================== #
# A12 — the selector is DERIVE-AND-COMPARE, not a text search
# =========================================================================== #
async def test_a12a_superseded_render_is_selected_as_stale(app_state: AppState) -> None:
    """A12(a). Catches: a selector that only looks for a known-bad phrase.

    The stale chunk's text here shares no vocabulary at all with any precedent
    template, so a phrase/blocklist selector finds nothing and reports a clean corpus.
    Only ``render(current builder, case) != stored text`` sees it.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 4)
    victim = chunks[0]
    await _replace_text(app_state, victim, "text produced by a render this build no longer emits")

    result = await app_state.rag.repair_precedent_projection()

    assert result["stale"] == 1
    assert result["would_repair"] == 1
    assert result["current"] == len(chunks) - 1
    # Every candidate lands in exactly one of the four classes (A11).
    assert (
        result["current"] + result["stale"] + result["undetermined"] + result["not_projecting"]
        == result["scanned"]
    )


async def test_a12b_monkeypatching_the_builder_makes_the_current_render_read_stale(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A12(b). Catches: a selector hard-coded to one template generation.

    The corpus is written by the builder that is current at seed time and is then left
    COMPLETELY UNTOUCHED. Only the builder moves. A derive-and-compare selector must
    now call every stored chunk stale; anything that compares against a stored marker,
    a template id or a fixed phrase list still calls them current.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 3)
    before = {c.doc_id: c.text for c in chunks}

    clean = await app_state.rag.repair_precedent_projection()
    assert clean["stale"] == 0, "corpus written by the current builder must start clean"

    rag_type = type(app_state.rag)
    previous = rag_type._resolved_case_text

    def _different_format(case: Case, outcome: str, note: str) -> str:
        # Same FACTS, a different render. Not a marker, not a version — a format.
        return f"[{outcome}] {case.case_id} :: {note or 'n/a'}"

    monkeypatch.setattr(rag_type, "_resolved_case_text", staticmethod(_different_format))

    after = await app_state.rag.repair_precedent_projection()

    assert after["stale"] == len(chunks)
    assert after["current"] == 0
    # The sweep really was unmodified: the corpus still holds the original bytes.
    assert {c.doc_id: c.text for c in await _precedent_chunks(app_state)} == before


# =========================================================================== #
# A13 — the tier landmine
# =========================================================================== #
async def test_a13_current_unconfirmed_render_survives_and_the_text_selector_hazard_is_pinned(
    app_state: AppState,
) -> None:
    """A13. Catches: a repair that selects the unconfirmed tier by its own prose.

    The unconfirmed projector legitimately renders a phrase that reads like a defect
    ("...NOT reviewed or confirmed by an analyst"). A sweep that hunted for that phrase
    would delete or rewrite every legitimate unconfirmed chunk on the estate. This test
    (a) proves the real pass leaves them byte-identical, and (b) proves a
    case-insensitive substring selector on that same phrase WOULD have hit them — the
    hazard is pinned, not merely avoided.
    """
    _enable_precedent(app_state, use_unconfirmed_resolved_cases=True)
    recent = now_utc()
    recurrence = _current_prefs(app_state).rag.unconfirmed_precedent.min_recurrence
    for i in range(recurrence + 1):
        created = (recent - timedelta(days=1, minutes=i)).isoformat().replace("+00:00", "Z")
        await app_state.cases.save(_unconfirmed_case(f"u-{i:03d}", created_at=created))
    await app_state.rag.ensure_seeded()

    before = {c.doc_id: c.text for c in await _precedent_chunks(app_state)}
    unconfirmed = [c for c in await _precedent_chunks(app_state) if app_state.rag._is_unconfirmed(c)]
    assert unconfirmed, "fixture must actually populate the unconfirmed tier"

    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    tier = result["tiers"]["model_unconfirmed"]
    assert tier["scanned"] == len(unconfirmed)
    assert tier["current"] == len(unconfirmed)
    assert tier["stale"] == 0
    assert result["evicted"] == 0 and result["repaired"] == 0
    assert spy.calls == []
    assert embedder.calls == 0
    # BYTE-IDENTICAL, and no exclusion marker landed on the way past.
    assert {c.doc_id: c.text for c in await _precedent_chunks(app_state)} == before
    for chunk in await _precedent_chunks(app_state):
        keys = set((chunk.metadata or {}).keys())
        assert not {k for k in keys if "exclu" in k.lower()}

    # (b) The hazard. The distinguishing phrase is DERIVED from the stored render:
    # the words the unconfirmed projector emits that the confirmed one does not.
    sample = unconfirmed[0].text
    phrase = sample.split(".")[0]
    assert phrase, "the unconfirmed render must have a leading clause to select on"
    naive_hits = [
        c for c in await _precedent_chunks(app_state) if phrase.lower() in c.text.lower()
    ]
    assert naive_hits, (
        "a case-insensitive substring selector on the unconfirmed projector's own prose "
        "WOULD have selected legitimate current chunks — this is the landmine the "
        "derive-and-compare selector steps over"
    )


# =========================================================================== #
# A14 — prose injection
# =========================================================================== #
async def test_a14_confirmed_chunk_quoting_the_unconfirmed_phrase_is_left_alone(
    app_state: AppState,
) -> None:
    """A14. Catches: a selector that reads log/analyst-authored prose as a signal.

    Analyst notes and evidence summaries are operator- and source-authored text (#9).
    A case whose note AND evidence summary both quote the unconfirmed projector's own
    wording renders a CLEAN confirmed chunk that nevertheless contains the phrase. It
    must not be selected, rewritten or removed.
    """
    _enable_precedent(app_state, use_unconfirmed_resolved_cases=True)
    recent = now_utc()
    # The tier has a recurrence bar; seed to whatever the shipped config asks for so
    # the fixture cannot silently stop exercising the tier if that bar moves.
    recurrence = _current_prefs(app_state).rag.unconfirmed_precedent.min_recurrence
    for i in range(recurrence):
        created = (recent - timedelta(days=1, minutes=i)).isoformat().replace("+00:00", "Z")
        await app_state.cases.save(_unconfirmed_case(f"u-{i:03d}", created_at=created))
    await app_state.rag.ensure_seeded()
    unconfirmed = [c for c in await _precedent_chunks(app_state) if app_state.rag._is_unconfirmed(c)]
    assert unconfirmed
    phrase = unconfirmed[0].text.split(".")[0]

    await app_state.cases.save(
        _confirmed_case(
            "quoting-000",
            created_at="2026-02-02T00:00:00Z",
            note=phrase,
            summary=phrase,
        )
    )
    # Seeding is idempotent against an unchanged source signature, so the new case is
    # projected through the ordinary rebuild rather than by re-calling ensure_seeded().
    await app_state.rag.rebuild_corpus(dry_run=False)

    quoting = (await _by_case(app_state))["quoting-000"]
    assert phrase.lower() in quoting.text.lower(), "fixture must really inject the phrase"
    before = quoting.text

    spy = _DeleteSpy(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["stale"] == 0
    assert result["repaired"] == 0 and result["evicted"] == 0
    assert spy.calls == []
    assert (await _by_case(app_state))["quoting-000"].text == before


# =========================================================================== #
# A19 — UNDETERMINED never deletes
# =========================================================================== #
async def test_a19_unreadable_case_store_is_a_counted_skip_with_no_writes_or_deletes(
    app_state: AppState,
) -> None:
    """A19. Catches: a pass that treats "I could not read the case" as "the case is
    gone" — the single worst failure mode available to this feature, because a case
    store blip would silently evict the corpus.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 5)
    before = {c.doc_id: c.text for c in chunks}

    async def _raises(*_args: Any, **_kwargs: Any) -> Case:
        raise RuntimeError("case store unavailable")

    app_state.cases.get = _raises  # type: ignore[assignment]

    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["undetermined"] == len(chunks)
    assert result["absent"] == 0 and result["would_evict"] == 0
    assert result["repaired"] == 0 and result["evicted"] == 0 and result["mutated"] == 0
    assert embedder.calls == 0
    assert spy.calls == []
    # An unreadable classification is not a complete pass, so the result may never
    # claim the tier is clean.
    assert result["complete"] is False
    assert {c.doc_id: c.text for c in await _precedent_chunks(app_state)} == before


# =========================================================================== #
# A20 — NOT-PROJECTING is reported, never deleted
# =========================================================================== #
async def test_a20_excluded_and_label_withdrawn_cases_are_reported_not_deleted(
    app_state: AppState,
) -> None:
    """A20. Catches: a pass that "tidies up" chunks whose case no longer qualifies.

    Both of these are OPERATOR decisions whose home is the exclusion API: an excluded
    case, and a case whose analyst label was withdrawn. Deleting either would destroy
    evidence of a human choice and would make the exclusion list and the corpus
    disagree about who is in charge.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 5, prefix="np")
    assert len(chunks) == 5

    # EXCLUDED — recorded directly so the exclusion's own corpus sweep does not remove
    # the chunk first; the repair pass must meet a chunk whose case is on the list.
    await app_state.rag._exclusions.exclude(
        "np-000",
        reason="mislabelled",
        note="",
        # The cap the product itself applies, asked for rather than assumed.
        max_entries=app_state.rag._exclusion_bound(),
    )
    await app_state.rag._refresh_exclusions(force=True)
    # LABEL WITHDRAWN — the case is still there, the analyst ground truth is not.
    await app_state.cases.save(
        _confirmed_case("np-001", created_at="2026-02-01T00:01:00Z", labelled=False)
    )

    before = {c.doc_id: c.text for c in await _precedent_chunks(app_state)}

    spy = _DeleteSpy(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["not_projecting"] == 2
    assert result["excluded"] == 1
    assert result["withdrawn"] == 1
    assert result["absent"] == 0
    assert result["would_evict"] == 0 and result["evicted"] == 0
    assert spy.calls == []
    assert {c.doc_id: c.text for c in await _precedent_chunks(app_state)} == before


# =========================================================================== #
# A21 — the ONLY delete branch, and the record that precedes it
# =========================================================================== #
async def test_a21_only_a_positively_absent_case_evicts_and_the_payload_precedes_removal(
    app_state: AppState,
) -> None:
    """A21. Catches: an eviction that records nothing, or records after the fact.

    The evicted payload IS the reconstruction path — the prior render is by definition
    the stale one, so nothing else can bring the chunk back. The sink therefore asserts,
    at the moment it is called, that the chunk is STILL in the corpus: a pass that
    deleted first and recorded second would leave an unrecoverable gap if the audit
    write failed.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 8, prefix="ab")
    ghost = _ghost(chunks[0], "absent-000", text="render of a case that is gone")
    await app_state.rag._store.add([ghost])

    recorded: list[dict[str, Any]] = []
    still_present_at_record: list[bool] = []

    async def _sink(payload: dict[str, Any]) -> None:
        recorded.append(copy.deepcopy(payload))
        live = {c.doc_id for c in await _precedent_chunks(app_state)}
        still_present_at_record.append(ghost.doc_id in live)

    result = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=_sink)

    assert result["absent"] == 1
    assert result["evicted"] == 1
    # Only the absent case evicted — the other seven are untouched.
    assert result["not_projecting"] == 1
    assert len(await _precedent_chunks(app_state)) == len(chunks)

    assert still_present_at_record == [True], "the payload must be written BEFORE removal"
    assert len(recorded) == 1
    payload = recorded[0]
    # The reconstruction path needs all three (A21).
    assert payload["document_id"] == ghost.metadata["document_id"]
    assert payload["text"] == ghost.text
    assert payload["metadata"]["case_id"] == "absent-000"

    # Removal is verified by RE-READ, not from a return value.
    assert ghost.doc_id not in {c.doc_id for c in await _precedent_chunks(app_state)}
    assert result["evicted_documents"] == [ghost.metadata["document_id"]]


async def test_a21_a_failed_record_leaves_the_chunk_in_place(app_state: AppState) -> None:
    """A21, the other half. Catches: an eviction that proceeds when the trail is down.

    If the append-only record cannot be written there is no reconstruction path, so the
    only safe outcome is to leave the chunk alone and say the run did not complete.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 8, prefix="rec")
    ghost = _ghost(chunks[0], "absent-001")
    await app_state.rag._store.add([ghost])

    async def _broken(_payload: dict[str, Any]) -> None:
        raise RuntimeError("append-only trail unavailable")

    result = await app_state.rag.repair_precedent_projection(dry_run=False, on_evict=_broken)

    assert result["evicted"] == 0
    assert result["mutated"] == 0
    assert result["ok"] is False
    assert ghost.doc_id in {c.doc_id for c in await _precedent_chunks(app_state)}


# =========================================================================== #
# A22 / A23 / A26 — text and vector cannot decouple
# =========================================================================== #
async def test_a22_a26_changed_text_is_re_embedded_exactly_once_through_the_gateway(
    app_state: AppState,
) -> None:
    """A22 + A26. Catches: a repair that rewrites text and keeps the old vector.

    A chunk whose text says one thing and whose vector points at another is worse than
    a stale chunk: retrieval still finds it under the old meaning and then shows the
    operator the new words. The vector must MOVE, and the move must be billed exactly
    once per repaired chunk through the single gateway (#6).
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 3, prefix="emb")
    victim = chunks[0]
    # The vector the CURRENT render legitimately embeds to. Captured before anything is
    # disturbed, so it is the answer a faithful re-embed must reproduce.
    current_vector = list(victim.embedding)
    # A planted vector that is not the answer to any render here: the corruption a
    # "wrote the text, kept the vector" repair would leave behind.
    planted = [0.0] * len(current_vector)
    planted[0] = 1.0
    assert planted != current_vector
    stale = _clone_with_text(victim, "wholly different wording with no shared content terms")
    stale.embedding = planted
    await app_state.rag._store.delete_document(str(victim.metadata["document_id"]))
    await app_state.rag._store.add([stale])
    written_stale = (await _by_case(app_state))[str(victim.metadata["case_id"])]
    assert written_stale.embedding == planted

    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["repaired"] == 1
    # Exactly one embedding per repaired chunk — no fan-out, no whole-corpus re-embed.
    assert result["embedding_calls"] == result["repaired"]
    assert embedder.calls == result["repaired"]

    after = (await _by_case(app_state))[str(victim.metadata["case_id"])]
    assert after.text != written_stale.text
    assert after.embedding != planted, (
        "text and vector decoupled: the repair wrote new text over the planted vector"
    )
    # …and the new vector is the one the REPAIRED TEXT embeds to, not merely "different".
    assert after.embedding == current_vector
    # A16: repaired IN PLACE — same doc_id, same tier, same corpus size, zero deletes.
    assert after.doc_id == victim.doc_id
    assert (after.metadata or {}).get("trust_class") == (victim.metadata or {}).get("trust_class")
    assert len(await _precedent_chunks(app_state)) == len(chunks)


async def test_a23_byte_identical_re_render_costs_zero_embedding_calls(
    app_state: AppState,
) -> None:
    """A23. Catches: a pass that re-embeds everything it looked at.

    A corpus that is already current is the COMMON case. Charging the operator an
    embedding per chunk to discover that is how a maintenance pass becomes something
    nobody dares run.
    """
    _enable_precedent(app_state)
    await _seed_confirmed(app_state, 6, prefix="free")

    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["stale"] == 0
    assert result["current"] == result["scanned"] == 6
    assert result["embedding_calls"] == 0
    assert embedder.calls == 0


async def test_a24_dry_run_is_the_default_and_reports_every_class(
    app_state: AppState,
) -> None:
    """A24. Catches: a destructive default.

    Discovered by CALLING with no arguments: if the default were a real run this test
    would see writes. Also pins that the dry run reports all four classes plus both
    intents and completeness, per tier — the numbers an operator reads before deciding.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 4, prefix="dry")
    await _replace_text(app_state, chunks[0], "a render this build no longer emits")
    before = {c.doc_id: c.text for c in await _precedent_chunks(app_state)}

    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection()

    assert result["dry_run"] is True
    assert result["would_repair"] == 1
    assert result["repaired"] == 0 and result["evicted"] == 0 and result["mutated"] == 0
    assert embedder.calls == 0 and spy.calls == []
    assert {c.doc_id: c.text for c in await _precedent_chunks(app_state)} == before

    required = {
        "scanned",
        "current",
        "stale",
        "undetermined",
        "not_projecting",
        "would_repair",
        "would_evict",
        "complete",
    }
    for tier_name, tier in result["tiers"].items():
        assert required <= set(tier), f"{tier_name} is missing {required - set(tier)}"


# =========================================================================== #
# A25 — idempotence
# =========================================================================== #
async def test_a25_second_run_selects_nothing_writes_nothing_and_bills_nothing(
    app_state: AppState,
) -> None:
    """A25. Catches: a repair that is not a fixed point.

    A pass that re-selects its own output would bill an embedding per chunk on every
    run for ever, and would make "did it work?" unanswerable.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 5, prefix="idem")
    await _replace_text(app_state, chunks[0], "superseded wording")
    await _replace_text(app_state, chunks[1], "another superseded wording")

    first = await app_state.rag.repair_precedent_projection(dry_run=False)
    assert first["repaired"] == 2
    after_first = {c.doc_id: c.text for c in await _precedent_chunks(app_state)}

    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    second = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert second["stale"] == 0
    assert second["would_repair"] == 0 and second["repaired"] == 0
    assert second["mutated"] == 0
    assert second["embedding_calls"] == 0
    assert embedder.calls == 0
    assert spy.calls == []
    assert {c.doc_id: c.text for c in await _precedent_chunks(app_state)} == after_first


# =========================================================================== #
# A27 — the per-run cap is DERIVED from the configured window
# =========================================================================== #
async def test_a27_cap_and_eviction_floor_scale_with_the_configured_window(
    app_state: AppState,
) -> None:
    """A27 / A28. Catches: a bound hard-coded to one estate's volume (P2).

    Nothing here asserts a target number. It asserts the RELATIONSHIP: change the
    configured precedent window and both adaptive bounds move with it, monotonically
    and proportionally. A literal would fail the smaller and the larger window alike.
    """
    _enable_precedent(app_state)
    _set_window(app_state, size=40)
    small = await app_state.rag.repair_precedent_projection()
    _set_window(app_state, size=80)
    doubled = await app_state.rag.repair_precedent_projection()
    _set_window(app_state, size=400)
    large = await app_state.rag.repair_precedent_projection()

    for key in ("repair_cap", "eviction_floor"):
        assert small[key] < doubled[key] < large[key], f"{key} must scale with the window"
        # Doubling the window doubles the allowance: derived, not stepped or clamped.
        assert doubled[key] == small[key] * 2
        assert large[key] == small[key] * 10
        assert small[key] >= 1


# =========================================================================== #
# A28 / A29 — the collapse guard
# =========================================================================== #
async def test_a28_mass_eviction_refuses_without_ever_calling_the_delete_primitive(
    app_state: AppState,
) -> None:
    """A28. Catches: a guard that counts after deleting, or reports a refusal it did
    not actually perform.

    ``mutated == 0`` is not proof — a pass could delete and then miscount. The delete
    primitive itself is spied, so the refusal is proven at the only place that matters.
    The tier size and the eviction count are both DERIVED from the fixture, and the
    thresholds are read off the run's own report rather than assumed.
    """
    _enable_precedent(app_state)
    _set_window(app_state, size=40)
    live = await _seed_confirmed(app_state, 12, prefix="mass")
    template = live[0]
    # Enough orphans to clear BOTH the absolute floor and the fraction of the tier.
    probe = await app_state.rag.repair_precedent_projection()
    floor = int(probe["eviction_floor"])
    fraction = float(probe["eviction_fraction"])
    # Solve G > fraction * (live + G)  =>  G > fraction*live / (1 - fraction).
    assert 0.0 <= fraction < 1.0
    by_fraction = int(fraction * len(live) / (1.0 - fraction)) + 1
    ghost_count = max(floor + 1, by_fraction)
    await app_state.rag._store.add(
        [_ghost(template, f"gone-{i:03d}") for i in range(ghost_count)]
    )
    tier_size = len(await _precedent_chunks(app_state))
    assert ghost_count > floor
    assert ghost_count > fraction * tier_size

    spy = _DeleteSpy(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["refused"] is True
    assert result["ok"] is False
    assert result["reason_code"]
    assert result["mutated"] == 0
    assert result["evicted"] == 0
    assert spy.calls == [], "a refusal must never reach the delete primitive"
    assert len(await _precedent_chunks(app_state)) == tier_size

    # A30: a REPORTED outcome, not an exception — seeding still works afterwards.
    await app_state.rag.ensure_seeded()
    assert len(await _precedent_chunks(app_state)) >= len(live)


async def test_a28_setting_the_ratio_to_zero_does_not_open_the_guard(
    app_state: AppState,
) -> None:
    """A28. Catches: a guard combined by OR, where lowering the ratio disables it.

    The two thresholds are ANDed, so 0.0 means "every eviction is above the share" and
    the absolute floor alone decides. Setting it to zero must therefore make the guard
    STRICTER, never permissive.
    """
    _enable_precedent(app_state)
    _set_window(app_state, size=40)
    live = await _seed_confirmed(app_state, 12, prefix="ratio")
    probe = await app_state.rag.repair_precedent_projection()
    floor = int(probe["eviction_floor"])
    await app_state.rag._store.add([_ghost(live[0], f"z-{i:03d}") for i in range(floor + 1)])

    _set_repair(app_state, eviction_fraction=0.0)
    spy = _DeleteSpy(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["refused"] is True
    assert result["mutated"] == 0
    assert spy.calls == []


async def test_a29_emptying_a_tier_refuses_unconditionally_and_untunably(
    app_state: AppState,
) -> None:
    """A29. Catches: a "the case store is empty so the corpus should be too" pass.

    The eviction count here is deliberately BELOW the mass-eviction floor, and both
    tunables are set as permissively as their schema allows, so the only thing that can
    refuse is the unconditional zero guard. A tier reaching zero is never a legitimate
    outcome of a maintenance pass.
    """
    _enable_precedent(app_state)
    live = await _seed_confirmed(app_state, 1, prefix="solo")
    template = live[0]
    # Replace the only real chunk with orphans, so the whole tier would evict.
    await app_state.rag._store.delete_document(str(template.metadata["document_id"]))
    await app_state.rag._store.add([_ghost(template, f"empty-{i}") for i in range(2)])

    probe = await app_state.rag.repair_precedent_projection()
    assert probe["would_evict"] < probe["eviction_floor"], (
        "fixture must stay under the mass-eviction floor so only the zero guard can fire"
    )

    # As permissive as the schema allows, on both dials.
    _set_repair(app_state, eviction_fraction=1.0, eviction_floor=100000)
    spy = _DeleteSpy(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["refused"] is True
    assert result["mutated"] == 0 and result["evicted"] == 0
    assert spy.calls == []
    assert len(await _precedent_chunks(app_state)) == 2


# =========================================================================== #
# A31 — truncation, against an ES-TYPED store
# =========================================================================== #
async def test_a31_truncated_read_on_an_es_typed_store_never_claims_a_clean_corpus(
    app_state: AppState,
) -> None:
    """A31. Catches: a pass that mistakes "one page of the corpus" for "the corpus".

    The in-memory store returns everything it holds, so a truncation test built on it
    passes VACUOUSLY. This one builds a real ``ESVectorStore``, asks it (by recording
    the page size it actually sends) how large one read can be, then fills it one chunk
    past that. The pass must report the read as incomplete and must not claim zero
    stale chunks remain.
    """
    _enable_precedent(app_state)
    seeded = await _seed_confirmed(app_state, 3, prefix="trunc")
    template = seeded[0]

    es = InMemoryESClient()
    store = ESVectorStore(es)
    observed_page_size: dict[str, int] = {}
    real_search = es.search

    async def _record(index: str, body: dict[str, Any]) -> dict[str, Any]:
        if index == store._index:
            observed_page_size["size"] = int(body.get("size") or 0)
        return await real_search(index, body)

    es.search = _record  # type: ignore[assignment]

    await store.add(await app_state.rag._store.list_all_chunks())
    await store.list_all_chunks()
    ceiling = observed_page_size["size"]
    assert ceiling > 0, "the ES-typed store must page its corpus read"

    # CONTROL: the SAME ES-typed store, under the ceiling, must report a COMPLETE read.
    # Without this the assertion below would pass against an implementation that simply
    # never claims completeness on an ES store — a vacuous pass.
    app_state.rag._store = store
    control = await app_state.rag.repair_precedent_projection()
    assert control["complete"] is True
    assert control["scanned"] == len(seeded)

    # One chunk past the ceiling, in the SAME embedding space so the embedding-space
    # refusal (A32) cannot pre-empt the truncation report.
    filler = [
        StoredChunk(
            text=f"unrelated corpus document {i}",
            source="runbook",
            metadata={"document_id": f"runbook:filler-{i}"},
            embedding=list(template.embedding),
            embedding_model=template.embedding_model,
            dim=template.dim,
            doc_id=f"runbook:filler-{i}",
        )
        for i in range(ceiling)
    ]
    await store.add(filler)
    assert await store.count() > ceiling
    assert len(await store.list_all_chunks()) == ceiling, "the read really is truncated"

    app_state.rag._store = store
    result = await app_state.rag.repair_precedent_projection()

    assert result["complete"] is False
    for tier_name, tier in result["tiers"].items():
        assert tier["complete"] is False, f"{tier_name} claimed a complete read"


# =========================================================================== #
# X3 / X4 — gate invariance (cross-cutting, non-negotiable #3)
# =========================================================================== #
def _closable_verdicts_by_calling() -> set[Verdict | None]:
    """Derive the auto-closable verdict class BY CALLING ``decide()``.

    Not from the config schema: the schema has an ``enabled`` flag for every class,
    including the one the code refuses to honour. Every class is switched ON as
    permissively as the schema allows, and the answer is whatever actually closes.
    """
    from app.config import AutoClosePolicy, VerdictAutoClose

    wide_open = VerdictAutoClose(
        enabled=True, min_confidence=0.0, max_risk_score=100.0, objection_window_minutes=0
    )
    policy = AutoClosePolicy(
        false_positive=wide_open.model_copy(),
        true_positive=wide_open.model_copy(),
        needs_human=wide_open.model_copy(),
    )
    closable: set[Verdict | None] = set()
    for verdict in list(Verdict) + [None]:
        decision = decide(verdict, 1.0, 0.0, policy)
        if decision.status == CaseStatus.CLOSED:
            closable.add(verdict)
    return closable


def test_x4_needs_human_never_auto_closes_even_with_its_policy_wide_open() -> None:
    """X4. Catches: a policy field quietly becoming load-bearing for NEEDS_HUMAN.

    The closable class is derived by CALLING the code with every class enabled and
    every threshold at its most permissive. NEEDS_HUMAN must still not appear, because
    #3 makes that a CODE guarantee rather than a configuration one. Unverdicted (None)
    must not appear either — no verdict is not a decision.
    """
    closable = _closable_verdicts_by_calling()

    assert Verdict.NEEDS_HUMAN not in closable
    assert None not in closable
    assert closable, "some verdict class must be closable, or the policy is inert"
    assert closable <= set(Verdict) - {Verdict.NEEDS_HUMAN}


def test_x3_gate_invariance_truth_table_over_the_shipped_thresholds() -> None:
    """X3. Catches: a silent threshold move.

    The shipped policy is read from ``Preferences()`` — the defaults an operator who
    changes nothing actually gets — and the matrix walks BELOW / AT / ABOVE each
    threshold for every verdict class. Nothing here is a literal: each probe point is
    computed from the entry's own thresholds, so a deliberate threshold change updates
    the fixture automatically while an ACCIDENTAL change to the comparison operators
    (``>=`` becoming ``>``, ``<=`` becoming ``<``) or to which class is enabled fails.
    """
    policy = Preferences().auto_close
    entries = {
        Verdict.FALSE_POSITIVE: policy.false_positive,
        Verdict.TRUE_POSITIVE: policy.true_positive,
        Verdict.NEEDS_HUMAN: policy.needs_human,
    }
    closable = _closable_verdicts_by_calling()
    epsilon = 0.001

    for verdict, entry in entries.items():
        may_close = entry.enabled and verdict in closable
        for confidence, risk, expect_close in (
            # AT both bounds — inclusive on both sides.
            (entry.min_confidence, entry.max_risk_score, may_close),
            # ABOVE the confidence bar, BELOW the risk ceiling — the comfortable case.
            (min(1.0, entry.min_confidence + epsilon), max(0.0, entry.max_risk_score - epsilon), may_close),
            # BELOW the confidence bar — never closes, whatever the risk.
            (max(0.0, entry.min_confidence - epsilon), max(0.0, entry.max_risk_score - epsilon), False),
            # ABOVE the risk ceiling — never closes, whatever the confidence.
            (1.0, entry.max_risk_score + epsilon, False),
            # Both wrong.
            (0.0, 100.0, False),
        ):
            decision = decide(verdict, confidence, risk, policy)
            closed = decision.status == CaseStatus.CLOSED
            assert closed is expect_close, (
                f"{verdict.value} at confidence={confidence} risk={risk}: "
                f"expected close={expect_close}, got status={decision.status.value}"
            )
            if closed:
                assert decision.decision_by == DecisionBy.AGENT

    # The shipped posture itself: exactly one class closes out of the box, and it is
    # not the one the operator must never lose sight of.
    shipped_enabled = {v for v, e in entries.items() if e.enabled}
    assert Verdict.NEEDS_HUMAN not in shipped_enabled


# =========================================================================== #
# X8 — cold start
# =========================================================================== #
async def test_x8_cold_start_repair_is_a_clean_no_op(app_state: AppState) -> None:
    """X8 (+A38). Catches: a maintenance pass that needs bootstrapping.

    A fresh deployment has no stored precedent config, no cases, no exclusions and no
    corpus. The pass must be a reported no-op: no refusal, no write, no delete, no
    embedding call, and no requirement for a new table, migration or environment
    variable to reach that answer.
    """
    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["scanned"] == 0
    assert result["stale"] == 0 and result["not_projecting"] == 0 and result["undetermined"] == 0
    assert result["repaired"] == 0 and result["evicted"] == 0 and result["mutated"] == 0
    assert result["refused"] is False
    assert result["embedding_calls"] == 0
    assert embedder.calls == 0 and spy.calls == []


# =========================================================================== #
# A37 — the read-only diagnostics figure costs nothing
# =========================================================================== #
async def test_a37_per_tier_stale_text_chunks_is_reported_without_embedding(
    app_state: AppState,
) -> None:
    """A37. Catches: an observability figure that bills the operator to look at it.

    Also catches a figure derived from the repair's own WRITE path: the number is read
    with the gateway's embedding entry point replaced by a tripwire.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 4, prefix="obs")
    await _replace_text(app_state, chunks[0], "a render this build no longer emits")

    async def _forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("reporting staleness must never embed")

    app_state.rag._gateway.embed_with_provenance = _forbidden  # type: ignore[assignment]

    cases, store_total = await app_state.cases.list(limit=200)
    block = await _precedent_corpus_block(app_state, cases, store_total)

    staleness = block["stale_text_chunks"]
    per_tier = staleness["by_trust_class"]
    assert per_tier, "the diagnostics block must report staleness PER TIER"
    assert sum(int(tier["stale"]) for tier in per_tier.values()) == 1
    assert all("stale" in tier and "scanned" in tier for tier in per_tier.values())
    # Reading it is free: the tripwire above would have raised on any embedding call.
    assert staleness["complete"] is True

    # The same figure must also be free on the composition report.
    report = await app_state.rag.corpus_composition()
    assert report["embedding_calls"] == 0


# --------------------------------------------------------------------------- #
# A guard on this file's own fixtures: nothing above may smuggle in a
# deployment-observed number or a vendor vocabulary (P2 / P4).
# --------------------------------------------------------------------------- #
def test_the_shared_severity_ladder_is_the_products_own_vocabulary() -> None:
    """Pins that these fixtures never invent a band name or a scale-tied number.

    Catches a future edit to this file that hard-codes a band vocabulary instead of
    reading the product's own ladder.
    """
    assert len(SEVERITY_BANDS) == len(set(SEVERITY_BANDS))
    assert all(isinstance(band, str) and band.islower() for band in SEVERITY_BANDS)


# =========================================================================== #
# A35 / A39 — the audited, permission-gated route
# =========================================================================== #
def _repair_app(secrets, mock_provider, holder: dict[str, AppState]):
    from contextlib import asynccontextmanager

    from fastapi import FastAPI

    from app.api.routes import router as base_router
    from app.api.routes_rag import router as rag_router

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides
        )
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        holder["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(base_router)
    api.include_router(rag_router)
    return api


def test_a35_a39_the_route_audits_counts_and_ids_but_never_chunk_text(
    secrets, mock_provider
) -> None:
    """A35 + A39. Catches: chunk TEXT leaking onto the append-only trail.

    The repair's audit row is a management record, not a corpus copy: the trail is
    long-lived, widely readable and holds source-influenced prose (#9) if you let it.
    The ONE deliberate exception is the evicted payload of A21, which is scoped to the
    delete path alone. A dry run must record nothing at all.
    """
    from fastapi.testclient import TestClient

    holder: dict[str, AppState] = {}
    with TestClient(_repair_app(secrets, mock_provider, holder)) as client:
        state = holder["state"]

        async def _prepare() -> str:
            _enable_precedent(state)
            chunks = await _seed_confirmed(state, 4, prefix="route")
            await _replace_text(state, chunks[0], "a render this build no longer emits")
            return str(chunks[0].text)

        original_text = client.portal.call(_prepare)  # type: ignore[attr-defined]

        surfaces_before = client.portal.call(  # type: ignore[attr-defined]
            lambda: state.audit.records(limit=200)
        )

        dry = client.post("/api/rag/precedent/repair", json={"dry_run": True})
        assert dry.status_code == 200, dry.text
        assert dry.json()["would_repair"] == 1
        after_dry = client.portal.call(  # type: ignore[attr-defined]
            lambda: state.audit.records(limit=200)
        )
        assert len(after_dry) == len(surfaces_before), "a dry run must record nothing"

        real = client.post("/api/rag/precedent/repair", json={"dry_run": False})
        assert real.status_code == 200, real.text
        assert real.json()["repaired"] == 1

        rows = client.portal.call(  # type: ignore[attr-defined]
            lambda: state.audit.records(limit=200)
        )
        new_rows = rows[: len(rows) - len(surfaces_before)] if surfaces_before else rows
        assert new_rows, "a real repair must reach the append-only trail"

        blob = repr(new_rows)
        # Counts and identifiers are welcome; the rendered corpus text is not.
        assert "resolved_case:route-" in blob or "route-" in blob
        for fragment in (original_text, "a render this build no longer emits"):
            assert fragment not in blob, "chunk text must never reach the audit trail"


def test_a36_the_state_changing_repair_route_declares_an_authz_dependency() -> None:
    """A36. Catches: a new mutating route that no permission guards.

    Read WITHOUT opening the module: the route object's own dependant tree is asked
    whether anything in it is a permission requirement, and the answer is compared
    against the sibling exclusion route the criterion says it is modelled on.
    """
    from fastapi import FastAPI

    from app.api.routes_rag import router as rag_router

    api = FastAPI()
    api.include_router(rag_router)
    guards: dict[str, set[str]] = {}
    for route in api.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/rag/precedent") and "POST" in (getattr(route, "methods", None) or set()):
            dependant = getattr(route, "dependant", None)
            names = set()
            stack = list(getattr(dependant, "dependencies", []) or [])
            while stack:
                node = stack.pop()
                call = getattr(node, "call", None)
                if call is not None:
                    names.add(getattr(call, "__qualname__", repr(call)))
                stack.extend(getattr(node, "dependencies", []) or [])
            guards[path] = names

    repair = guards.get("/api/rag/precedent/repair")
    sibling = guards.get("/api/rag/precedent/exclusions")
    assert repair is not None and sibling is not None
    assert repair, "the repair route declares no dependency at all"
    # Modelled on the sibling: it carries at least the same guards.
    assert sibling <= repair, f"repair guards {sorted(repair)} vs sibling {sorted(sibling)}"


# =========================================================================== #
# A10 — ONE pass over the corpus
# =========================================================================== #
async def test_a10_the_corpus_is_read_once_and_never_fanned_out_per_document(
    app_state: AppState,
) -> None:
    """A10. Catches: O(documents x corpus) reads on a large precedent corpus.

    Every backend materialises the whole corpus to answer ``list_chunks``, so calling
    it once per document turns one read into a full scan PER DOCUMENT. On a corpus with
    thousands of precedent documents that is the difference between a maintenance pass
    and an outage. The bound asserted is DERIVED — one read regardless of how many
    documents the fixture holds — not a magic number.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 6, prefix="scan")
    assert len({str((c.metadata or {}).get("document_id")) for c in chunks}) == 6

    store = app_state.rag._store
    real_all = store.list_all_chunks
    real_one = store.list_chunks
    counts = {"all": 0, "per_document": 0}

    async def _all():
        counts["all"] += 1
        return await real_all()

    async def _one(document_id: str):
        counts["per_document"] += 1
        return await real_one(document_id)

    store.list_all_chunks = _all  # type: ignore[assignment]
    store.list_chunks = _one  # type: ignore[assignment]

    await app_state.rag.repair_precedent_projection()

    assert counts["per_document"] == 0, "the corpus must not be fanned out per document"
    assert counts["all"] == 1, f"one pass, not {counts['all']}"


# =========================================================================== #
# A18 — an out-of-window CLEAN chunk is untouched
# =========================================================================== #
async def test_a18_out_of_window_clean_chunks_are_neither_rewritten_nor_evicted(
    app_state: AppState,
) -> None:
    """A18. Catches: a pass that reads "outside the current window" as "not projecting".

    The window governs SELECTION for a fresh projection; it says nothing about whether
    an already-stored chunk is still faithful to its case. A repair that narrowed the
    window and then evicted everything below the new cut would silently destroy the
    corpus every time an operator tuned that dial.
    """
    _enable_precedent(app_state)
    _set_window(app_state, size=6)
    chunks = await _seed_confirmed(app_state, 6, prefix="win")
    before = {c.doc_id: (c.text, tuple(c.embedding)) for c in chunks}
    assert len(before) == 6

    # Narrow the window well below what the corpus already holds.
    _set_window(app_state, size=2)

    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["scanned"] == len(before)
    assert result["current"] == len(before), "a narrower window does not make a chunk stale"
    assert result["stale"] == 0 and result["not_projecting"] == 0 and result["absent"] == 0
    assert result["evicted"] == 0 and result["repaired"] == 0
    assert spy.calls == [] and embedder.calls == 0
    assert {c.doc_id: (c.text, tuple(c.embedding)) for c in await _precedent_chunks(app_state)} == before


# =========================================================================== #
# A33 — the migration hole is closed
# =========================================================================== #
async def test_a33_an_embedding_model_change_re_derives_rather_than_carrying_old_text(
    app_state: AppState,
) -> None:
    """A33. Catches: the preserved-items path re-embedding stored text verbatim.

    This is the defect that made the whole feature necessary: a chunk whose render was
    superseded got carried, byte-for-byte, across every future embedding migration,
    because the preserved path re-embedded ``chunk.text`` instead of re-deriving it.
    Repair alone does not close that hole — the hole is on a DIFFERENT path. So the
    test repairs first, then drives the preserved path with an embedding-model change,
    and asserts the old render never comes back.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 4, prefix="mig")
    victim = chunks[0]
    superseded = "a render this build no longer emits"
    await _replace_text(app_state, victim, superseded)

    repaired = await app_state.rag.repair_precedent_projection(dry_run=False)
    assert repaired["repaired"] == 1
    after_repair = (await _by_case(app_state))[str(victim.metadata["case_id"])]
    assert after_repair.text != superseded
    current_render = after_repair.text

    # Now change the embedding SPACE, which is what sends every stored chunk through
    # the preserved-items path.
    _change_embedding_space(app_state, "-next")
    await app_state.rag.ensure_seeded()

    migrated = await _by_case(app_state)
    assert str(victim.metadata["case_id"]) in migrated, "the case must survive the migration"
    assert migrated[str(victim.metadata["case_id"])].text == current_render
    # The superseded render is gone from the WHOLE corpus, not just from that document.
    assert all(c.text != superseded for c in await _precedent_chunks(app_state))


# =========================================================================== #
# A32 — a changed embedding space refuses rather than half-migrating
# =========================================================================== #
async def test_a32_a_changed_embedding_space_refuses_with_no_write(
    app_state: AppState,
) -> None:
    """A32. Catches: a repair that re-embeds into a space the corpus is not in.

    Mixing two embedding spaces in one corpus silently degrades every retrieval that
    touches it, and there is no marker to find the mixture afterwards. The ordinary
    reseed owns that migration; the repair must stand down and say so.
    """
    _enable_precedent(app_state)
    chunks = await _seed_confirmed(app_state, 4, prefix="space")
    before = {c.doc_id: (c.text, tuple(c.embedding)) for c in chunks}
    await _replace_text(app_state, chunks[0], "a render this build no longer emits")

    _change_embedding_space(app_state, "-other")

    spy = _DeleteSpy(app_state)
    embedder = _CountingEmbedder(app_state)
    result = await app_state.rag.repair_precedent_projection(dry_run=False)

    assert result["refused"] is True
    assert result["reason_code"]
    assert result["mutated"] == 0
    assert embedder.calls == 0 and spy.calls == []
    stored = {c.doc_id: (c.text, tuple(c.embedding)) for c in await _precedent_chunks(app_state)}
    # Nothing was written; the corpus still holds exactly what it held, stale chunk and all.
    assert set(stored) == set(before)

