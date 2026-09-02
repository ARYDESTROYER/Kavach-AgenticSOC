"""Operator-facing precedent corpus repair — composition, refusal legibility, exclusion.

The framing these tests exist to pin down, because getting it wrong is how this whole
class of defect stayed invisible:

**REPROJECTION IS NOT THE REPAIR.** The precedent projection pages the case store
newest-first, so the bulk-confirmed cases that poisoned a corpus are still the newest
analyst-confirmed terminal cases — a rebuild RE-SELECTS them. On the deployment that
motivated this work the qualifying POOL was *more* verdict-skewed than the window drawn
from it, so no selection policy over that pool could restore a healthy corpus. A green
"rebuild succeeded" is therefore not evidence of anything, and the product must make
composition visible before and after, give the operator a supported trigger, and give
them an eviction path that actually holds.

The three deliverables, and what each test file section pins:

* **B1 — composition dry run, zero embedding calls.** The report cross-tabulates
  (analyst outcome x model verdict) rather than reporting outcomes alone, because
  outcome-only counts read PRISTINE on a corpus that is actively poisoning the model.
  It shows the qualifying POOL beside the selected window ("200 of 889") and the
  admission concentration, and it costs no provider spend.
* **B2 — the retention refusal made legible.** The collapse guard is a SIZE guard: a
  reprojection that keeps the count and flips every verdict passes it cleanly. Worse,
  the obvious repair (narrowing the window to drop a poisoned tail) trips the ratio
  floor and used to report as a generic FAILED collapse. An attributable reduction now
  says so distinctly — while the ZERO-projection refusal stays unconditional and
  untunable.
* **B5 — a force-deleted precedent stays deleted.** The exclusion marker is a predicate
  at EVERY producer, not one edit: the confirmed window, the unconfirmed candidate, the
  preserved-items path taken on an embedding-model change, the explicit bootstrap
  indexer, and the incremental close-time path. Ground truth is never touched.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes_diagnostics import (
    _build_alerts,
    _precedent_corpus_block,
    router as diagnostics_router,
)
from app.api.routes_rag import router as rag_router
from app.config import Preferences
from app.constants import (
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.analyst_outcomes import analyst_confirmed_outcome
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, EvidenceItem
from app.state import AppState
from app.tools import rag as rag_module
from app.stores.memory import EsKVStore
from app.stores.precedent_exclusions import (
    PRECEDENT_EXCLUSION_REASONS,
    PrecedentExclusionStore,
    normalise_note,
    normalise_reason,
)
from app.tools.rag import (
    EXCLUSION_SELECTABLE_KEYS,
    REFUSAL_EMPTY_PROJECTION,
    REFUSAL_RETENTION_FLOOR,
    REFUSAL_WINDOW_REDUCTION,
    ProjectionCollapsed,
    RagService,
)
from app.tools.vectorstore import StoredChunk


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
def _case(
    case_id: str,
    *,
    labelled: bool = True,
    outcome: Disposition = Disposition.FALSE_POSITIVE,
    verdict: Verdict = Verdict.FALSE_POSITIVE,
    rule: str = "auth_failure_burst",
    created_at: str = "2026-01-01T00:00:00Z",
    batch: str = "",
) -> Case:
    """A terminal case. ``labelled`` → carries independent analyst ground truth.

    ``outcome`` (the analyst's label) and ``verdict`` (the model's own judgement) are
    set INDEPENDENTLY on purpose: the whole point of the composition cross-tab is that
    those two axes can disagree, and an outcome-only report cannot see that they do.
    """
    history: list[dict[str, Any]] = []
    if labelled:
        entry: dict[str, Any] = {
            "ts": created_at,
            "event": "analyst_action",
            "action": "set_disposition",
            "note": "",
        }
        if batch:
            entry["batch"] = batch
        history.append(entry)
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        rule_ids=[rule],
        verdict=verdict,
        confidence=0.9,
        risk_score=12.5,
        status=CaseStatus.CLOSED,
        created_at=created_at,
        updated_at=created_at,
        decision_by=DecisionBy.ANALYST if labelled else DecisionBy.AGENT,
        disposition=outcome,
        history=history,
        evidence=[EvidenceItem(summary="Scheduled scanner burst")],
        recommended_action="No action required.",
    )


def _enable_precedent(state: AppState, **rag_update: Any) -> None:
    update = {"enabled": True, "use_resolved_cases": True, "min_score": 0.0}
    update.update(rag_update)
    state.rag.set_prefs(
        state.prefs.model_copy(
            update={"rag": state.prefs.rag.model_copy(update=update)}
        )
    )


def _set_window(state: AppState, **window_update: Any) -> None:
    precedent = state.prefs.precedent
    state.rag.set_prefs(
        state.prefs.model_copy(
            update={
                "precedent": precedent.model_copy(
                    update={"window": precedent.window.model_copy(update=window_update)}
                )
            }
        )
    )


async def _precedent_case_ids(state: AppState) -> set[str]:
    return {
        str((chunk.metadata or {}).get("case_id") or "")
        for chunk in await state.rag._store.list_all_chunks()
        if chunk.source == "resolved_case"
    }


# =========================================================================== #
# Constraint guard: nothing here may enable precedent promotion.
# =========================================================================== #
def test_precedent_promotion_stays_off_by_default() -> None:
    """Promotion is an operator decision and must not be acquired on upgrade.

    Pinned here because every surface this change adds is adjacent to it: composition
    reporting, refusal classification and exclusion all read the precedent corpus, and
    none of them may quietly widen what the investigator is TOLD about it.
    """
    promotion = Preferences().precedent.promotion
    assert promotion.enabled is False
    assert promotion.min_confirmed == 25


# =========================================================================== #
# B1 — composition dry run
# =========================================================================== #
async def test_composition_cross_tab_sees_what_outcome_only_counts_hide(
    app_state: AppState,
) -> None:
    """The joint distribution is the finding; the outcome marginal reads pristine.

    Every case here is ``outcome=false_positive`` — an outcome-only report calls that a
    clean benign baseline. Every case is ALSO ``verdict=NEEDS_HUMAN``: what the corpus
    actually tells a future investigation is "we saw this and escalated it every single
    time". Only the cross-tab separates the two readings.
    """
    _enable_precedent(app_state)
    for i in range(6):
        await app_state.cases.save(
            _case(
                f"poison-{i:03d}",
                verdict=Verdict.NEEDS_HUMAN,
                created_at=f"2026-02-01T00:{i:02d}:00Z",
            )
        )

    report = await app_state.rag.corpus_composition()
    confirmed = report["projected"]["confirmed"]

    # The marginal an outcome-only report would publish: unanimously benign. Green.
    assert confirmed["by_outcome"] == {"false_positive": 6}
    # The joint distribution, which says the opposite.
    assert confirmed["outcome_by_verdict"] == [
        {"outcome": "false_positive", "verdict": Verdict.NEEDS_HUMAN.value, "count": 6}
    ]
    assert confirmed["by_verdict"] == {Verdict.NEEDS_HUMAN.value: 6}


async def test_composition_reports_the_pool_the_window_was_drawn_from(
    app_state: AppState,
) -> None:
    """"200 of 889" must be legible, not implied.

    A window that is 100% one verdict looks equally bad whether the pool behind it is
    balanced (a selection problem a reprojection could fix) or equally skewed (a ground
    truth problem no selection policy can fix). The pool composition is what tells the
    two apart, so it is reported alongside the window's.
    """
    _enable_precedent(app_state)
    _set_window(app_state, size=4)
    for i in range(12):
        await app_state.cases.save(
            _case(
                f"pool-{i:03d}",
                verdict=Verdict.NEEDS_HUMAN,
                created_at=f"2026-03-01T00:{i:02d}:00Z",
            )
        )

    pool = (await app_state.rag.corpus_composition())["projected"]["pool"]

    assert pool["qualifying"] == 12
    assert pool["selected"] == 4
    assert pool["share"] == pytest.approx(4 / 12, rel=1e-3)
    assert pool["scan_complete"] is True
    # The pool is skewed exactly like the window, which is the proof that reprojecting
    # cannot repair this corpus.
    assert pool["composition"]["by_verdict"] == {Verdict.NEEDS_HUMAN.value: 12}


async def test_composition_reports_admission_concentration(app_state: AppState) -> None:
    """One bulk analyst action wearing 200 faces is invisible in every other count."""
    _enable_precedent(app_state)
    _set_window(app_state, size=10, max_transaction_fraction=0.0)
    for i in range(8):
        await app_state.cases.save(
            _case(f"bulk-{i:03d}", created_at=f"2026-04-01T00:{i:02d}:00Z", batch="one-click")
        )
    await app_state.cases.save(
        _case("solo-000", created_at="2026-04-02T00:00:00Z", batch="separate")
    )

    admission = (await app_state.rag.corpus_composition())["projected"]["admission"]

    assert admission["selected"] == 9
    assert admission["transactions"] == 2
    assert admission["max_transaction_documents"] == 8
    assert admission["max_transaction_share"] == pytest.approx(8 / 9, rel=1e-3)
    # Group LABELS never reach the payload — they are opaque batch ids or coarse time
    # buckets, and neither belongs on a diagnostics surface.
    assert "groups" not in admission
    assert "one-click" not in repr(admission)


async def test_composition_costs_zero_embedding_calls(app_state: AppState) -> None:
    """The report is derivable from a management read plus the per-case projector."""
    _enable_precedent(app_state)
    for i in range(3):
        await app_state.cases.save(_case(f"free-{i:03d}"))
    await app_state.rag.ensure_seeded()

    async def _forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("the composition report must never embed")

    app_state.rag._gateway.embed_with_provenance = _forbidden  # type: ignore[assignment]
    report = await app_state.rag.corpus_composition()

    assert report["embedding_calls"] == 0
    assert report["costs_provider_spend"] is False
    assert report["projected"]["available"] is True


async def test_rebuild_dry_run_mutates_nothing_and_returns_the_composition(
    app_state: AppState,
) -> None:
    """``dry_run`` is additive: the default rebuild is byte-identical to before."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("dry-000"))
    await app_state.rag.ensure_seeded()
    before = await app_state.rag._store.count()

    async def _forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("a dry run must never embed")

    app_state.rag._gateway.embed_with_provenance = _forbidden  # type: ignore[assignment]
    result = await app_state.rag.rebuild_corpus(dry_run=True)

    assert result["dry_run"] is True
    assert result["rebuilt"] is False
    assert result["chunks_before"] == before
    assert result["chunks_after"] == before
    assert await app_state.rag._store.count() == before
    assert "composition" in result


async def test_composition_degrades_when_precedent_is_switched_off(
    app_state: AppState,
) -> None:
    """A configured-off source reports a REASON, never a confident empty projection."""
    _enable_precedent(app_state, use_resolved_cases=False)
    report = await app_state.rag.corpus_composition()
    assert report["projected"]["available"] is False
    assert "turned off" in report["projected"]["reason"]


# =========================================================================== #
# B2 — the retention refusal, made legible
# =========================================================================== #
def _guard(prefs_retention: float, window_size: int, app_state: AppState):
    app_state.rag.set_prefs(
        app_state.prefs.model_copy(
            update={
                "rag": app_state.prefs.rag.model_copy(
                    update={
                        "enabled": True,
                        "use_resolved_cases": True,
                        "min_projection_retention": prefs_retention,
                    }
                ),
                "precedent": app_state.prefs.precedent.model_copy(
                    update={
                        "window": app_state.prefs.precedent.window.model_copy(
                            update={"size": window_size}
                        )
                    }
                ),
            }
        )
    )
    return app_state.rag


def _chunks(source: str, n: int) -> list[StoredChunk]:
    return [
        StoredChunk(
            text=f"{source}-{i}",
            source=source,
            metadata={"document_id": f"{source}:{i}"},
            embedding=[1.0],
            embedding_model="m",
            dim=1,
            doc_id=f"{source}:{i}",
        )
        for i in range(n)
    ]


def test_zero_projection_refusal_is_unconditional_and_untunable(
    app_state: AppState,
) -> None:
    """No configuration may ever let an empty rebuild replace a live corpus.

    Retention is set to 0 (the documented way to switch the RATIO guard off entirely)
    and the shrink is perfectly attributable to a window reduction. Neither may open
    the zero case.
    """
    rag = _guard(0.0, 1, app_state)
    with pytest.raises(ProjectionCollapsed) as excinfo:
        rag._guard_projection_collapse({"resolved_case": 400}, [])
    assert excinfo.value.reason_code == REFUSAL_EMPTY_PROJECTION


def test_window_reduction_refusal_is_attributed_distinctly(app_state: AppState) -> None:
    """A DELIBERATE window narrowing is not a corpus loss and must not read as one."""
    rag = _guard(0.5, 40, app_state)
    with pytest.raises(ProjectionCollapsed) as excinfo:
        rag._guard_projection_collapse(
            {"resolved_case": 400}, _chunks("resolved_case", 40)
        )
    assert excinfo.value.reason_code == REFUSAL_WINDOW_REDUCTION
    message = str(excinfo.value)
    assert "ATTRIBUTABLE to a deliberate reduction of the precedent window" in message
    assert "configured window of 40" in message
    assert "min_projection_retention" in message


def test_a_shrink_that_takes_other_sources_down_is_not_attributed(
    app_state: AppState,
) -> None:
    """A window change cannot touch runbooks; a broken build takes everything.

    The attribution is deliberately conservative: reporting a genuine corpus loss as a
    reassuring "you asked for this" is far worse than the generic message.
    """
    rag = _guard(0.5, 40, app_state)
    with pytest.raises(ProjectionCollapsed) as excinfo:
        rag._guard_projection_collapse(
            {"resolved_case": 400, "runbook": 20},
            _chunks("resolved_case", 40) + _chunks("runbook", 1),
        )
    assert excinfo.value.reason_code == REFUSAL_RETENTION_FLOOR


def test_a_shrink_not_explained_by_the_window_bound_is_not_attributed(
    app_state: AppState,
) -> None:
    """The drop must be ARITHMETICALLY explained by the window, not merely coincident."""
    rag = _guard(0.5, 500, app_state)  # window is larger than either count
    with pytest.raises(ProjectionCollapsed) as excinfo:
        rag._guard_projection_collapse(
            {"resolved_case": 400}, _chunks("resolved_case", 40)
        )
    assert excinfo.value.reason_code == REFUSAL_RETENTION_FLOOR


def test_the_size_guard_cannot_see_composition(app_state: AppState) -> None:
    """A reprojection that keeps the count and flips every verdict passes CLEANLY.

    This is not a defect in the guard — it is a size guard and says so — but it is
    exactly why a clean projection is not evidence of a healthy corpus, and why the
    composition report has to be read separately.
    """
    rag = _guard(0.5, 200, app_state)
    rag._guard_projection_collapse(
        {"resolved_case": 40}, _chunks("resolved_case", 40)
    )  # does not raise


# =========================================================================== #
# B5 — a force-deleted precedent stays deleted
# =========================================================================== #
async def test_force_delete_alone_is_undone_by_the_next_projection(
    app_state: AppState,
) -> None:
    """The defect, pinned. A plain delete silently undoes itself."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("ghost-000"))
    await app_state.rag.ensure_seeded()
    assert "ghost-000" in await _precedent_case_ids(app_state)

    await app_state.rag.delete_document("resolved_case:ghost-000", force=True)
    assert "ghost-000" not in await _precedent_case_ids(app_state)

    app_state.rag._seeded = False  # any later reprojection
    await app_state.rag.ensure_seeded()
    assert "ghost-000" in await _precedent_case_ids(app_state), (
        "a plain force-delete is re-derived from the case store — the operator's "
        "action undid itself"
    )


async def test_exclusion_survives_reprojection(app_state: AppState) -> None:
    """EXCLUSION = DELETE + MARK. The mark is what makes the delete hold."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("gone-000"))
    await app_state.cases.save(_case("stay-000"))
    await app_state.rag.ensure_seeded()

    outcome = await app_state.rag.exclude_precedent_case(
        "gone-000", reason="mislabelled", note="bulk import artefact", actor="ana"
    )
    assert outcome["ok"] is True
    assert outcome["deleted"] == 1
    assert outcome["complete"] is True

    app_state.rag._seeded = False
    await app_state.rag.ensure_seeded()
    ids = await _precedent_case_ids(app_state)
    assert "gone-000" not in ids
    assert "stay-000" in ids


async def test_exclusion_never_touches_ground_truth(app_state: AppState) -> None:
    """The audit-hostile workaround this replaces was destroying the analyst's label."""
    _enable_precedent(app_state)
    case = _case("truth-000")
    await app_state.cases.save(case)
    await app_state.rag.ensure_seeded()
    before = analyst_confirmed_outcome(case)
    history_before = list(case.history)

    await app_state.rag.exclude_precedent_case("truth-000", reason="duplicate")

    after = await app_state.cases.get("truth-000")
    assert analyst_confirmed_outcome(after) == before
    assert list(after.history) == history_before
    assert after.disposition == case.disposition
    assert after.decision_by == case.decision_by
    assert after.status == case.status
    assert list(after.feedback) == list(case.feedback)


async def test_exclusion_survives_the_preserved_items_migration_path(
    app_state: AppState,
) -> None:
    """The path that re-embeds straight from the PRE-MIGRATION snapshot.

    ``_reseed`` carries precedent the bounded window can no longer reach across an
    embedding-space change by re-embedding the stored chunks directly — it never
    consults the per-case projector. Without its own check, the first embedding-model
    change a deployment ever makes would resurrect every exclusion at once.
    """
    _enable_precedent(app_state, min_projection_retention=0.0)
    await app_state.cases.save(_case("carry-000"))
    await app_state.rag.ensure_seeded()

    # Mark WITHOUT deleting, so only the preserved-items path can put it back.
    await app_state.rag._exclusions.exclude(
        "carry-000", reason="superseded", max_entries=100
    )
    await app_state.rag._refresh_exclusions(force=True)
    assert "carry-000" in await _precedent_case_ids(app_state)

    await app_state.rag._reseed()

    assert "carry-000" not in await _precedent_case_ids(app_state)


async def test_exclusion_blocks_the_incremental_close_time_path(
    app_state: AppState,
) -> None:
    """The documented SIDE EFFECT: an excluded case stops being indexed on close."""
    _enable_precedent(app_state)
    case = _case("close-000")
    await app_state.cases.save(case)
    await app_state.rag.ensure_seeded()
    await app_state.rag.exclude_precedent_case("close-000", reason="sensitive")

    assert await app_state.rag.index_resolved_case(case, note="re-closed") == 0
    assert "close-000" not in await _precedent_case_ids(app_state)


async def _seed_unconfirmed(state: AppState, prefix: str, n: int = 4) -> None:
    """``n`` agent-closed cases inside the tier's age-out horizon.

    The unconfirmed guards are compounding — confidence floor, recurrence floor and an
    age-out on the TERMINAL timestamp — so the fixtures have to be recent and repeated
    or the tier legitimately yields nothing and the test would pass vacuously.
    """
    now = datetime.now(timezone.utc)
    for i in range(n):
        at = (now - timedelta(minutes=i + 1)).isoformat()
        state_case = _case(f"{prefix}-{i:03d}", labelled=False, created_at=at)
        await state.cases.save(state_case)


async def test_exclusion_blocks_the_unconfirmed_tier_and_bootstrap_seam(
    app_state: AppState,
) -> None:
    """The lower-trust tier and the bulk-ratification seam are producers too."""
    _enable_precedent(app_state, use_unconfirmed_resolved_cases=True)
    await _seed_unconfirmed(app_state, "unconf")
    candidates = await app_state.rag.unconfirmed_precedent_candidates(50)
    assert {case.case_id for case, _ in candidates} == {f"unconf-{i:03d}" for i in range(4)}

    await app_state.rag.exclude_precedent_case("unconf-000", reason="other")

    survivors = await app_state.rag.unconfirmed_precedent_candidates(50)
    assert "unconf-000" not in {case.case_id for case, _ in survivors}
    assert len(survivors) == 3


async def test_exclusion_blocks_the_explicit_bootstrap_indexer(
    app_state: AppState,
) -> None:
    """``index_precedent_items`` receives items from OUTSIDE the per-case projector."""
    _enable_precedent(app_state, use_unconfirmed_resolved_cases=True)
    await _seed_unconfirmed(app_state, "boot")
    candidates = await app_state.rag.unconfirmed_precedent_candidates(50)
    assert candidates

    await app_state.rag.exclude_precedent_case("boot-000", reason="other")
    indexed = await app_state.rag.index_precedent_items(
        [item for _case, item in candidates], ratified_by="ana", batch_id="b1"
    )

    # The three that are not excluded are still indexed; the excluded one is dropped
    # even though the caller handed it in as an already-projected item.
    assert indexed == 3
    assert "boot-000" not in await _precedent_case_ids(app_state)


async def test_restore_lets_the_precedent_return_on_the_next_projection(
    app_state: AppState,
) -> None:
    """Un-exclusion removes the marker only; it never mints a chunk itself."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("back-000"))
    await app_state.rag.ensure_seeded()
    await app_state.rag.exclude_precedent_case("back-000", reason="mislabelled")
    assert "back-000" not in await _precedent_case_ids(app_state)

    restored = await app_state.rag.restore_precedent_case("back-000")
    assert restored == {"ok": True, "case_id": "back-000", "found": True, "count": 0}
    # Nothing was written by the restore itself.
    assert "back-000" not in await _precedent_case_ids(app_state)

    app_state.rag._seeded = False
    await app_state.rag.ensure_seeded()
    assert "back-000" in await _precedent_case_ids(app_state)


async def test_an_unreadable_exclusion_set_keeps_the_last_known_one(
    app_state: AppState,
) -> None:
    """Degrading to "nothing is excluded" would resurrect every exclusion at once."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("keep-000"))
    await app_state.rag.ensure_seeded()
    await app_state.rag.exclude_precedent_case("keep-000", reason="other")

    async def _broken() -> None:
        return None

    app_state.rag._exclusions.load = _broken  # type: ignore[assignment]
    await app_state.rag._refresh_exclusions(force=True)

    assert app_state.rag.exclusions_stale is True
    assert app_state.rag.excluded_case_ids() == frozenset({"keep-000"})
    app_state.rag._seeded = False
    await app_state.rag.ensure_seeded()
    assert "keep-000" not in await _precedent_case_ids(app_state)


async def test_the_exclusion_bound_is_relative_to_the_configured_window(
    app_state: AppState,
) -> None:
    """Bounded relative to the operator's own window, never by a constant."""
    _enable_precedent(app_state)
    _set_window(app_state, size=3)
    assert app_state.rag._exclusion_bound() == 12
    _set_window(app_state, size=200)
    assert app_state.rag._exclusion_bound() == 800


async def test_the_exclusion_set_refuses_to_grow_past_its_bound(
    app_state: AppState,
) -> None:
    """A deny list several windows deep means the corpus policy is wrong, not the rows."""
    _enable_precedent(app_state)
    _set_window(app_state, size=1)  # bound = 4
    for i in range(4):
        assert (await app_state.rag.exclude_precedent_case(f"cap-{i}", reason="other"))["ok"]
    overflow = await app_state.rag.exclude_precedent_case("cap-4", reason="other")
    assert overflow["ok"] is False
    assert overflow["capped"] is True
    # Refreshing an EXISTING marker is always allowed, so a bounded set stays editable.
    assert (await app_state.rag.exclude_precedent_case("cap-0", reason="duplicate"))["ok"]


async def test_bulk_selection_filters_on_projection_metadata_keys_only(
    app_state: AppState,
) -> None:
    """Never a free-text rule-title match: a title is content and gets rewritten."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("sel-000", rule="rule_a"))
    await app_state.cases.save(_case("sel-001", rule="rule_b"))
    await app_state.rag.ensure_seeded()

    picked = await app_state.rag.select_precedent_cases({"rule_identity": "rule_a"})
    assert picked["ok"] is True
    assert picked["case_ids"] == ["sel-000"]

    rejected = await app_state.rag.select_precedent_cases({"title": "SSH brute force"})
    assert rejected["ok"] is False
    assert "unsupported selection key" in rejected["reason"]
    assert "title" not in EXCLUSION_SELECTABLE_KEYS


# =========================================================================== #
# The stored marker itself
# =========================================================================== #
def test_reason_is_a_bounded_enum_and_the_note_is_stripped() -> None:
    """Neither ever enters a corpus chunk or a prompt — but both are bounded anyway."""
    assert normalise_reason("MISLABELLED") == "mislabelled"
    assert normalise_reason("anything else at all") == "other"
    assert normalise_reason(None) == "other"
    assert "other" in PRECEDENT_EXCLUSION_REASONS

    flattened = normalise_note("line one\nline\ttwo\x00three")
    assert "\n" not in flattened and "\t" not in flattened and "\x00" not in flattened
    assert flattened == "line one line two three"
    assert len(normalise_note("x" * 5000)) <= 280


async def test_marker_never_reaches_a_corpus_chunk(app_state: AppState) -> None:
    """#9-adjacent: the operator's note is a UI/audit field, never model-facing."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("quiet-000"))
    await app_state.cases.save(_case("quiet-001"))
    await app_state.rag.ensure_seeded()
    await app_state.rag.exclude_precedent_case(
        "quiet-000", reason="sensitive", note="SECRETNOTEMARKER", actor="ana"
    )
    app_state.rag._seeded = False
    await app_state.rag.ensure_seeded()

    for chunk in await app_state.rag._store.list_all_chunks():
        assert "SECRETNOTEMARKER" not in chunk.text
        assert "SECRETNOTEMARKER" not in repr(chunk.metadata)


class _FlakyKV:
    """A KV stand-in whose reads fail, to pin the load-vs-empty distinction."""

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        raise RuntimeError("backend down")

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        return None


async def test_store_load_reports_unreadable_as_none_not_empty() -> None:
    store = PrecedentExclusionStore(_FlakyKV())  # type: ignore[arg-type]
    assert await store.load() is None


# =========================================================================== #
# The service degrades cleanly with no exclusion store wired at all
# =========================================================================== #
async def test_no_exclusion_store_is_a_no_op(app_state: AppState) -> None:
    """Every historical construction (and any deployment that never excludes) is
    byte-identical: with no store there are no markers and every predicate is inert."""
    rag = RagService(app_state.rag._gateway, Preferences())
    assert rag._is_case_excluded("anything") is False
    await rag._refresh_exclusions(force=True)
    assert rag.excluded_case_ids() == frozenset()
    payload = await rag.precedent_exclusions()
    assert payload["supported"] is False
    assert payload["available"] is False
    outcome = await rag.exclude_precedent_case("x", reason="other")
    assert outcome["ok"] is False


# =========================================================================== #
# Diagnostics must not cry wolf
# =========================================================================== #
async def test_broad_exclusion_reports_as_operator_excluded_not_starved(
    app_state: AppState,
) -> None:
    """The exact incident signature must stay reserved for the incident.

    "0 analyst-confirmed precedents" is a CRITICAL because it is what a destroyed corpus
    looks like. An operator who excluded every qualifying case produced the same number
    deliberately — reporting that as the incident would raise a critical against them for
    doing what the product told them to do.
    """
    _enable_precedent(app_state)
    cases = [_case("excl-000"), _case("excl-001")]
    for case in cases:
        await app_state.cases.save(case)
    await app_state.rag.ensure_seeded()
    for case in cases:
        await app_state.rag.exclude_precedent_case(case.case_id, reason="mislabelled")

    block = await _precedent_corpus_block(app_state, cases, len(cases))

    assert block["status"] == "operator_excluded"
    assert block["starved"] is False
    assert block["zero_analyst_confirmed_precedents"] is True
    assert block["exclusions"]["count"] == 2
    assert sorted(block["exclusions"]["case_ids"]) == ["excl-000", "excl-001"]
    assert block["exclusions"]["by_rule"] == {"auth_failure_burst": 2}
    assert block["exclusions"]["by_reason"] == {"mislabelled": 2}

    alerts, _unknowns = _build_alerts(block, {}, {}, None, None)
    assert not [a for a in alerts if a["id"] == "precedent_corpus_starved"]


async def test_reconciliation_subtracts_excluded_cases(app_state: AppState) -> None:
    """Otherwise the block reports a deficit and blames the projection for an operator."""
    _enable_precedent(app_state)
    cases = [_case(f"rec-{i:03d}") for i in range(4)]
    for case in cases:
        await app_state.cases.save(case)
    await app_state.rag.ensure_seeded()
    await app_state.rag.exclude_precedent_case("rec-000", reason="duplicate")
    await app_state.rag.exclude_precedent_case("rec-001", reason="duplicate")

    block = await _precedent_corpus_block(app_state, cases, len(cases))
    reconciliation = block["reconciliation"]

    assert reconciliation["measured"] is True
    assert reconciliation["deficit"] is False
    assert reconciliation["qualifying_source_records"] == 2
    assert reconciliation["operator_excluded_records"] == 2
    assert reconciliation["corpus_documents"] == 2


def test_an_unreadable_exclusion_set_is_an_unknown_not_a_clean_bill() -> None:
    """A comparison built on an unreadable exclusion set is a guess, and says so."""
    precedent = {
        "known": True,
        "starved": False,
        "available": True,
        "rag_enabled": True,
        "total_chunks": 12,
        "exclusions": {"supported": True, "available": False, "count": 0},
    }
    _alerts, unknowns = _build_alerts(precedent, {}, {}, None, None)
    assert any(u["id"] == "precedent_exclusions_unreadable" for u in unknowns)


def test_an_attributed_window_reduction_is_not_a_critical_corpus_loss() -> None:
    """Nothing was destroyed, and the remedy is the retention floor, not the provider."""
    precedent = {
        "known": True,
        "starved": False,
        "available": True,
        "rag_enabled": True,
        "total_chunks": 400,
        "last_refusal": {
            "collapsed": True,
            "reason": "…ATTRIBUTABLE to a deliberate reduction of the precedent window…",
            "reason_code": REFUSAL_WINDOW_REDUCTION,
        },
    }
    alerts, _unknowns = _build_alerts(precedent, {}, {}, None, None)
    ids = {a["id"]: a for a in alerts}
    assert "rag_projection_refused" not in ids
    assert ids["rag_projection_refused_window_reduction"]["severity"] == "warning"


# =========================================================================== #
# The HTTP surfaces
# =========================================================================== #
def _api(app_state: AppState) -> TestClient:
    api = FastAPI()
    api.include_router(rag_router)
    api.include_router(diagnostics_router)
    api.state.tlsoc = app_state
    return TestClient(api)


async def test_exclusion_routes_are_audited_end_to_end(app_state: AppState) -> None:
    """A destructive corpus mutation must leave a record. Both directions."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("api-000"))
    await app_state.rag.ensure_seeded()

    with _api(app_state) as client:
        created = client.post(
            "/api/rag/precedent/exclusions",
            json={"case_ids": ["api-000"], "reason": "mislabelled", "note": "bulk artefact"},
        )
        assert created.status_code == 200, created.text
        assert created.json()["excluded"] == 1
        assert created.json()["case_ids"] == ["api-000"]

        listed = client.get("/api/rag/precedent/exclusions")
        assert listed.status_code == 200, listed.text
        assert listed.json()["count"] == 1
        assert listed.json()["reasons"] == list(PRECEDENT_EXCLUSION_REASONS)

        restored = client.delete("/api/rag/precedent/exclusions/api-000")
        assert restored.status_code == 200, restored.text
        assert client.delete("/api/rag/precedent/exclusions/api-000").status_code == 404

    rows = await app_state.audit.records(surface="rag_precedent_exclusion", limit=50)
    summaries = [str(r.get("result_summary") or "") for r in rows]
    assert any("excluded case from the precedent corpus" in s for s in summaries)
    assert any("restored case to the precedent corpus" in s for s in summaries)
    assert all("ground_truth_unchanged=true" in s for s in summaries)


async def test_force_delete_is_now_audited(app_state: AppState) -> None:
    """It was not before: the most destructive corpus mutation left no trace at all."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("audit-000"))
    await app_state.rag.ensure_seeded()

    with _api(app_state) as client:
        deleted = client.delete(
            "/api/rag/documents/resolved_case:audit-000", params={"force": "true"}
        )
        assert deleted.status_code == 200, deleted.text

    rows = await app_state.audit.records(surface="rag_document_delete", limit=10)
    assert len(rows) == 1
    summary = str(rows[0].get("result_summary") or "")
    assert "resolved_case:audit-000" in summary
    assert "force=True" in summary


async def test_bulk_exclusion_dry_run_selects_without_excluding(
    app_state: AppState,
) -> None:
    """Selection resolves the population first, so the operator sees what they will hit."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("sel-a", rule="rule_a"))
    await app_state.cases.save(_case("sel-b", rule="rule_b"))
    await app_state.rag.ensure_seeded()

    with _api(app_state) as client:
        preview = client.post(
            "/api/rag/precedent/exclusions",
            json={"select": {"rule_identity": "rule_a"}, "reason": "other", "dry_run": True},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["case_ids"] == ["sel-a"]
        assert preview.json()["excluded"] == 0

        rejected = client.post(
            "/api/rag/precedent/exclusions",
            json={"select": {"note": "anything"}, "reason": "other"},
        )
        assert rejected.status_code == 400, rejected.text

    assert app_state.rag.excluded_case_ids() == frozenset()


async def test_composition_is_answerable_without_running_anything(
    app_state: AppState,
) -> None:
    """Both the RAG surface and the diagnostics surface answer, seed-free and free."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("comp-000", verdict=Verdict.NEEDS_HUMAN))
    await app_state.rag.ensure_seeded()

    with _api(app_state) as client:
        rag_view = client.get("/api/rag/precedent/composition")
        assert rag_view.status_code == 200, rag_view.text
        assert rag_view.json()["embedding_calls"] == 0

        diag = client.get("/api/diagnostics/precedent-composition")
        assert diag.status_code == 200, diag.text
        body = diag.json()
        assert body["available"] is True
        assert body["projected"]["confirmed"]["outcome_by_verdict"] == [
            {
                "outcome": "false_positive",
                "verdict": Verdict.NEEDS_HUMAN.value,
                "count": 1,
            }
        ]


async def test_pool_completeness_is_measured_by_cases_scanned_not_cases_qualified(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A truncated scan must not report as a complete measurement.

    Comparing the QUALIFYING count against the scan cap would call the pool complete on
    any deployment whose qualifying rate is low — which is every deployment where this
    report matters. Completeness is decided by how many cases were actually examined.
    """
    _enable_precedent(app_state)
    monkeypatch.setattr(rag_module, "_RESOLVED_CASE_SCAN_CAP", 4)
    for i in range(10):
        # Only two qualify, so the qualifying count stays far below the cap while the
        # scan itself is cut short at it.
        await app_state.cases.save(
            _case(
                f"trunc-{i:03d}",
                labelled=i < 2,
                created_at=f"2026-06-01T00:{i:02d}:00Z",
            )
        )

    pool = (await app_state.rag.corpus_composition())["projected"]["pool"]

    assert pool["scanned_cases"] == 4
    assert pool["qualifying"] < pool["scan_cap"]
    assert pool["scan_complete"] is False


async def test_the_marker_behaves_identically_on_an_es_backed_kv_store() -> None:
    """It rides the shared CAS mutate helper, so no backend gets its own semantics.

    One JSON document through the existing ``KVStore`` abstraction — no new index, no
    SQL table, no migration — which is what makes the exclusion contract the same on
    Elasticsearch, PostgreSQL and SQLite.
    """
    store = PrecedentExclusionStore(EsKVStore(InMemoryESClient()))

    assert await store.load() == {}
    created = await store.exclude(
        "case-es-1", reason="superseded", note="a\nb", actor="ana", max_entries=10
    )
    assert created["ok"] is True and created["already"] is False

    rows = await store.load()
    assert set(rows) == {"case-es-1"}
    assert rows["case-es-1"]["reason"] == "superseded"
    assert rows["case-es-1"]["note"] == "a b"
    assert rows["case-es-1"]["actor"] == "ana"
    assert rows["case-es-1"]["at"]

    # Concurrent writers on the same document must not lose each other's row.
    await asyncio.gather(
        *(
            store.exclude(f"case-es-{i}", reason="other", max_entries=10)
            for i in range(2, 6)
        )
    )
    assert set(await store.load()) == {f"case-es-{i}" for i in range(1, 6)}

    assert (await store.restore("case-es-1"))["found"] is True
    assert (await store.restore("case-es-1"))["found"] is False
    assert "case-es-1" not in await store.load()


async def test_excluding_never_changes_the_corpus_source_signature(
    app_state: AppState,
) -> None:
    """An exclusion must not trigger a full, BILLABLE re-embed of the corpus.

    The exclusion set is deliberately absent from ``_source_signature``: a changed
    signature reprojects everything at the operator's expense, and evicting one record
    does not need that. The eviction is a targeted delete, and every later projection
    honours the marker from the set it reloads at its own start.
    """
    _enable_precedent(app_state)
    await app_state.cases.save(_case("sig-000"))
    await app_state.rag.ensure_seeded()
    before = app_state.rag._source_signature()

    await app_state.rag.exclude_precedent_case("sig-000", reason="mislabelled")

    assert app_state.rag._source_signature() == before
    assert app_state.rag._seeded is True  # no reprojection was forced

    async def _forbidden(*_args: Any, **_kwargs: Any):
        raise AssertionError("an exclusion must not re-embed the corpus")

    app_state.rag._gateway.embed_with_provenance = _forbidden  # type: ignore[assignment]
    await app_state.rag.ensure_seeded()  # short-circuits on the unchanged signature


# =========================================================================== #
# An exclusion must never REPORT a removal it did not make
# =========================================================================== #
@pytest.mark.asyncio
async def test_a_failed_delete_is_reported_incomplete_not_complete(
    app_state: AppState,
) -> None:
    """``delete_document`` is fail-soft and answers "the store raised" with the SAME
    ``{deleted: 0, found: False}`` it uses for "no such document", so inferring
    completeness from it told the operator the precedent was gone while it was still in
    the corpus. Completeness is now VERIFIED by re-reading, and fails closed."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("c-0"))
    await app_state.rag.ensure_seeded()
    assert "c-0" in await _precedent_case_ids(app_state)

    async def _boom(document_id: str):
        raise RuntimeError("state backend write timeout")

    app_state.rag._store.delete_document = _boom  # type: ignore[method-assign]
    out = await app_state.rag.exclude_precedent_case(
        "c-0", reason="mislabelled", note="", actor="tester"
    )
    assert out["ok"] is True, "the durable marker still landed"
    assert out["complete"] is False, "an unverified removal is never reported complete"
    assert "c-0" in await _precedent_case_ids(app_state)


@pytest.mark.asyncio
async def test_an_excluded_case_can_never_be_retrieved_even_if_a_chunk_survives(
    app_state: AppState,
) -> None:
    """Defence in depth. One exclusion reason is literally "must not appear in retrieved
    context at all", so a chunk the delete could not remove must still be unreachable
    from a prompt."""
    _enable_precedent(app_state)
    await app_state.cases.save(_case("c-0"))
    await app_state.cases.save(_case("c-1"))
    await app_state.rag.ensure_seeded()

    async def _boom(document_id: str):
        raise RuntimeError("state backend write timeout")

    app_state.rag._store.delete_document = _boom  # type: ignore[method-assign]
    await app_state.rag.exclude_precedent_case(
        "c-0", reason="sensitive", note="", actor="tester"
    )
    hits = await app_state.rag.retrieve("Scheduled scanner burst auth_failure_burst")
    retrieved = {
        str((c.metadata or {}).get("case_id") or "")
        for c in hits
        if c.source == "resolved_case"
    }
    assert "c-0" not in retrieved
    assert "c-1" in retrieved, "only the excluded case is filtered"


@pytest.mark.asyncio
async def test_precedent_left_under_the_pre_fix_grouping_is_removable(
    app_state: AppState,
) -> None:
    """A deployment that indexed precedent before the per-case document-identity fix
    holds chunks under the shared ``seed:resolved_case`` grouping. Skipping those in the
    legacy reconciliation removed the ONLY handle the delete has, so the exclusion was a
    permanent no-op that reported success — a re-issue and a full rebuild were no-ops
    too, while the precedent kept reaching prompts."""
    from dataclasses import replace as dataclass_replace

    _enable_precedent(app_state)
    await app_state.cases.save(_case("legacy-1"))
    await app_state.cases.save(_case("modern-1"))
    await app_state.rag.ensure_seeded()

    store = app_state.rag._store
    doc = f"resolved_case:legacy-1"
    chunks = await store.list_chunks(doc)
    assert chunks
    await store.delete_document(doc)
    await store.add([
        dataclass_replace(
            c, metadata={k: v for k, v in (c.metadata or {}).items() if k != "document_id"}
        )
        for c in chunks
    ])
    # A fresh process: the seed cache is cold, so the reconciliation runs again.
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None

    out = await app_state.rag.exclude_precedent_case(
        "legacy-1", reason="wrong_label", note="", actor="op"
    )
    assert out["complete"] is True
    assert out["deleted"] >= 1
    assert await _precedent_case_ids(app_state) == {"modern-1"}


# =========================================================================== #
# "unknown" is not "nothing is excluded"
# =========================================================================== #
@pytest.mark.asyncio
async def test_a_cold_process_never_resurrects_precedent_on_an_unreadable_store(
    app_state: AppState,
) -> None:
    """On a process that has NEVER read the exclusion store, an empty in-memory set is
    the absence of knowledge — not "nothing is excluded". Degrading to the latter made
    the very next projection re-derive every excluded precedent, and because
    ``resolved_case`` is exempt from the stale sweep those chunks then survived a full
    ``rebuild_corpus()``: the exclusion silently undid itself."""
    _enable_precedent(app_state)
    for cid in ("c-0", "c-1", "c-2"):
        await app_state.cases.save(_case(cid))
    await app_state.rag.ensure_seeded()
    for cid in ("c-0", "c-1"):
        await app_state.rag.exclude_precedent_case(
            cid, reason="wrong_label", note="", actor="op"
        )
    assert await _precedent_case_ids(app_state) == {"c-2"}

    fresh = RagService(
        app_state.gateway,
        app_state.prefs,
        store=app_state.rag._store,
        cases=app_state.cases,
        exclusions=app_state.rag._exclusions,
    )
    calls = {"n": 0}

    async def _unreadable():
        calls["n"] += 1
        return None

    fresh._exclusions.load = _unreadable  # type: ignore[method-assign]
    await fresh.ensure_seeded()

    assert calls["n"] >= 1, "the projection really did try to read the set"
    assert await _precedent_case_ids(app_state) == {"c-2"}, "no exclusion was resurrected"
    assert fresh._seeded is False, "the projection failed closed, corpus left as-is"


@pytest.mark.asyncio
async def test_a_stale_but_KNOWN_set_still_projects(app_state: AppState) -> None:
    """The weaker condition must NOT fail closed: a process that has read the set keeps
    its last known-good copy, and a slightly old deny list still denies."""
    _enable_precedent(app_state)
    for cid in ("c-0", "c-1"):
        await app_state.cases.save(_case(cid))
    await app_state.rag.ensure_seeded()
    await app_state.rag.exclude_precedent_case(
        "c-0", reason="wrong_label", note="", actor="op"
    )

    async def _unreadable():
        return None

    app_state.rag._exclusions.load = _unreadable  # type: ignore[method-assign]
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    assert app_state.rag._seeded is True
    assert app_state.rag.exclusions_stale is True
    assert await _precedent_case_ids(app_state) == {"c-1"}
