"""Regression: a provider outage must not silently empty the corpus (incident replay).

This module replays the production incident end to end and pins every acceptance
criterion from the report.

What happened: a deployment lost its embedding/LLM API key (HTTP 401 on every call).
The gateway degraded to local hash embeddings and kept going, so chunks written during
that window carried meaningless hash-space vectors; the next reprojection invalidated
and re-seeded the space and the corpus ended at ZERO rows. ``ensure_seeded`` is lazy
and signature-cached, so it considered itself done and never rebuilt. For three days
every case retrieved 0 knowledge and 0 precedents, auto-close was 0%, and
``GET /api/health`` returned ``ok`` with the Console showing "Healthy".

The source of truth survived — the analyst-confirmed cases were all still in the
database. Only the PROJECTION was gone.

Each test below names the acceptance criterion it pins.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from typing import Any

from app.constants import (
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.correlation import cluster_from_events
from app.llm.gateway import GatewayError
from app.llm.providers import EmbeddingResult, MockProvider, ProviderError
from app.models import Case, Entity
from app.state import AppState
from tests.conftest import make_raw_event


def _confirmed_case(case_id: str) -> Case:
    """A terminal case carrying INDEPENDENT analyst ground truth.

    This is the population that survived the incident untouched: 892 of these were
    still in the database while the corpus that projects them held zero.
    """
    history: list[dict[str, Any]] = [
        {"event": "analyst_action", "action": "set_disposition", "note": "reviewed"}
    ]
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        rule_ids=["ssh_bruteforce"],
        verdict=Verdict.FALSE_POSITIVE,
        confidence=0.9,
        risk_score=12.5,
        status=CaseStatus.CLOSED,
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        decision_by=DecisionBy.ANALYST,
        disposition=Disposition.FALSE_POSITIVE,
        history=history,
    )


async def seed_confirmed_cases(app_state: AppState, *, count: int) -> list[Case]:
    cases = [_confirmed_case(f"case-{index:04d}") for index in range(count)]
    for case in cases:
        await app_state.cases.save(case)
    return cases


# --------------------------------------------------------------------------- #
# The outage: HTTP 401 on every call, exactly as observed.
# --------------------------------------------------------------------------- #
class _ExpiredKeyProvider(MockProvider):
    """Every embedding call 401s; completions keep working.

    Isolates the embedding half of the outage so a test can assert corpus behaviour
    without also losing the ability to produce a verdict.
    """

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise ProviderError("HTTP 401: invalid_api_key", retryable=False, status=401)


class _TotalOutageProvider(MockProvider):
    """The full incident: 401 on completions AND embeddings."""

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise ProviderError("HTTP 401: invalid_api_key", retryable=False, status=401)

    async def complete(self, *args, **kwargs):  # type: ignore[override]
        raise ProviderError("HTTP 401: invalid_api_key", retryable=False, status=401)


def _cluster(ip: str = "1.2.3.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def _benign_router() -> str:
    return json.dumps(
        {"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}
    )


def _start_outage(app_state: AppState, provider: MockProvider) -> None:
    """Swap every provider override for one that 401s, as a key expiry would."""
    for name in list(app_state.gateway._providers):
        app_state.gateway._providers[name] = provider


# --------------------------------------------------------------------------- #
# Criterion 1 — with the provider returning 401, no chunk is persisted and the
#               pre-existing corpus is left intact.
# --------------------------------------------------------------------------- #
async def test_provider_401_persists_no_chunk_and_leaves_the_corpus_intact(
    app_state: AppState,
) -> None:
    await app_state.rag.ensure_seeded()
    before_count = await app_state.rag._store.count()
    before_docs = await app_state.rag._store.list_documents()
    assert before_count > 0, "the fixture must start from a healthy corpus"

    _start_outage(app_state, _ExpiredKeyProvider())
    # Force a fresh projection attempt, as a settings change or restart would.
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    # Nothing was written, and nothing was swept.
    assert await app_state.rag._store.count() == before_count
    assert await app_state.rag._store.list_documents() == before_docs
    # Critically: no chunk anywhere is in the fallback (hash) space.
    for doc in await app_state.rag._store.list_documents():
        for chunk in await app_state.rag._store.list_chunks(doc["document_id"]):
            assert chunk.metadata.get("embedding_fallback") is not True
            assert chunk.embedding_model != "mock-embed"


async def test_an_incremental_precedent_write_is_also_refused_during_an_outage(
    app_state: AppState,
) -> None:
    """The guard belongs at the embedding choke point, so EVERY write path inherits it."""
    await app_state.rag.ensure_seeded()
    before = await app_state.rag._store.count()

    _start_outage(app_state, _ExpiredKeyProvider())
    added = await app_state.rag.import_document("outage doc", "some text", source="imported")

    # NOTE the key: import_document returns ``chunk_count``. Asserting a key it never
    # returns would make this pass whether or not the write was refused.
    assert added["chunk_count"] == 0
    assert await app_state.rag._store.count() == before


# --------------------------------------------------------------------------- #
# Criterion 2 — a projection yielding zero documents while qualifying source
#               records exist fails loudly and does not replace the corpus.
# --------------------------------------------------------------------------- #
async def test_a_zero_projection_is_refused_loudly_and_keeps_the_corpus(
    app_state: AppState, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    await app_state.rag.ensure_seeded()
    before = await app_state.rag._store.count()
    assert before > 0

    async def _nothing() -> list[dict]:
        return []

    app_state.rag._enabled_seeds = _nothing        # type: ignore[method-assign]
    app_state.rag._runbook_seed_items = _nothing   # type: ignore[method-assign]
    app_state.rag._seeded = False
    with caplog.at_level(logging.ERROR, logger="tlsoc.tools.rag"):
        await app_state.rag.ensure_seeded()

    assert await app_state.rag._store.count() == before
    # ERROR, not the INFO line that was the ONLY trace both times this happened.
    assert any(
        record.levelno >= logging.ERROR and "REFUSED" in record.message
        for record in caplog.records
    )
    refusal = app_state.rag.last_refusal
    assert refusal is not None and refusal["collapsed"] is True


async def test_the_refusal_is_persisted_so_it_survives_a_restart(
    app_state: AppState,
) -> None:
    """The evidence died with the container both times; it must now be durable."""
    await app_state.rag.ensure_seeded()

    async def _nothing() -> list[dict]:
        return []

    app_state.rag._enabled_seeds = _nothing        # type: ignore[method-assign]
    app_state.rag._runbook_seed_items = _nothing   # type: ignore[method-assign]
    app_state.rag._seeded = False
    await app_state.rag.ensure_seeded()

    stored = await app_state.rag._health.load()
    assert stored["last_refusal"]["collapsed"] is True
    assert stored["last_refusal"]["outgoing_total"] > 0


async def test_an_ordinary_reseed_is_not_refused_because_of_operator_imports(
    app_state: AppState,
) -> None:
    """The guard must compare LIKE WITH LIKE, or it wedges normal deployments.

    ``ensure_seeded`` rebuilds only the MANAGED projection; operator imports are
    preserved in place, never re-embedded and never swept. Counting them as part of
    the "previous corpus" made every ordinary reseed look like a catastrophic shrink
    on any deployment whose imported library outnumbered its seed corpus — turning a
    safety guard into a self-inflicted outage.
    """
    await app_state.rag.ensure_seeded()
    for index in range(30):
        await app_state.rag.import_document(
            f"operator playbook {index}", "imported operator knowledge " * 40,
            source="imported",
        )
    total = await app_state.rag._store.count()
    assert total > 0

    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    assert app_state.rag.last_refusal is None
    assert app_state.rag._seeded is True
    assert await app_state.rag._store.count() == total


async def test_one_source_being_withdrawn_is_allowed_but_never_silent(
    app_state: AppState, caplog: pytest.LogCaptureFixture
) -> None:
    """A withdrawn source is a legitimate reconciliation, not a collapse.

    The fully reconciled sources (runbook/mitre/suppression) rebuild every enabled
    document, so absence from a new projection genuinely means the document was
    withdrawn — that is the documented contract the stale sweep depends on, and the
    collapse guard must not override it. It stays LOUD (a WARNING naming the source
    and both counts) rather than being blocked.
    """
    import logging

    await app_state.rag.ensure_seeded()
    before = await app_state.rag._store.count()
    full = await app_state.rag._enabled_seeds()

    async def _without_mitre() -> list[dict]:
        return [item for item in full if item.get("source") != "mitre"]

    app_state.rag._enabled_seeds = _without_mitre  # type: ignore[method-assign]
    app_state.rag._seeded = False
    with caplog.at_level(logging.WARNING, logger="tlsoc.tools.rag"):
        await app_state.rag.ensure_seeded()

    # The withdrawal was applied, not refused...
    assert await app_state.rag._store.count() < before
    assert app_state.rag.last_refusal is None
    # ...and it is recorded per source rather than vanishing into an INFO line.
    assert any(
        "SHRANK an enabled source" in record.message and "mitre" in record.message
        for record in caplog.records
    )
    assert app_state.rag.last_projection["mitre"]["collapsed"] is True


async def test_disabling_knowledge_sources_is_not_treated_as_a_collapse(
    app_state: AppState,
) -> None:
    """Turning a source off must not wedge seeding forever.

    A disabled source is EXPECTED to project to zero. Counting its existing chunks as
    something the rebuild "lost" refused every subsequent projection *and* stranded
    those chunks in the corpus, because the sweep that removes them never ran — a
    safety guard converting an ordinary settings change into a permanent outage.
    """
    await app_state.rag.ensure_seeded()
    assert await app_state.rag._store.count() > 0

    prefs = app_state.prefs
    app_state.rag.set_prefs(
        prefs.model_copy(
            update={
                "rag": prefs.rag.model_copy(
                    update={"use_mitre": False, "use_suppression_rules": False}
                )
            }
        )
    )
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    assert app_state.rag.last_refusal is None
    assert app_state.rag._seeded is True
    # The disabled sources were actually swept, not stranded.
    counts = await app_state.rag._chunk_counts_by_source()
    assert counts.get("mitre", 0) == 0
    assert counts.get("suppression", 0) == 0
    assert counts.get("runbook", 0) > 0


async def test_the_guard_ignores_sources_the_projection_does_not_own(
    app_state: AppState,
) -> None:
    """Precedent is a bounded window, never swept — it must not gate the guard.

    A deployment holding precedent that the CURRENT window no longer covers would
    otherwise have every projection refused for "collapsing" a source that is neither
    rebuilt nor deleted here.
    """
    from app.tools.rag import FULLY_RECONCILED_SEED_SOURCES, MANAGED_PROJECTION_SOURCES

    assert MANAGED_PROJECTION_SOURCES == FULLY_RECONCILED_SEED_SOURCES
    assert "resolved_case" not in MANAGED_PROJECTION_SOURCES
    assert "imported" not in MANAGED_PROJECTION_SOURCES

    prefs = app_state.prefs.model_copy(deep=True)
    prefs.rag.use_resolved_cases = True
    await app_state.update_prefs(prefs)
    await app_state.rag.ensure_seeded()

    # Precedent the bounded window does not cover, and an operator import.
    assert await app_state.rag._embed_and_add([
        {
            "text": "Resolved case rc-archived: analyst-confirmed outcome true_positive.",
            "source": "resolved_case",
            "doc_id": "resolved_case:rc-archived",
            "metadata": {
                "document_id": "resolved_case:rc-archived",
                "case_id": "rc-archived",
            },
        }
    ]) == 1
    before = await app_state.rag._store.count()

    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    assert app_state.rag.last_refusal is None
    assert await app_state.rag._store.count() == before


async def test_an_unreadable_previous_corpus_fails_safe(app_state: AppState) -> None:
    """A store read error must not silently switch the guard off.

    Returning "{}" for an unreadable store made it indistinguishable from an empty
    one, disabling the collapse guard in precisely the degraded conditions it exists
    for.
    """
    await app_state.rag.ensure_seeded()
    before = await app_state.rag._store.count()

    async def _unreadable() -> dict:
        raise RuntimeError("store unreadable")

    async def _nothing() -> list[dict]:
        return []

    app_state.rag._store.stats = _unreadable          # type: ignore[method-assign]
    app_state.rag._enabled_seeds = _nothing           # type: ignore[method-assign]
    app_state.rag._runbook_seed_items = _nothing      # type: ignore[method-assign]
    app_state.rag._seeded = False
    await app_state.rag.ensure_seeded()

    assert await app_state.rag._store.count() == before
    assert app_state.rag.last_refusal is not None


async def test_an_unreadable_store_is_never_reported_as_an_empty_corpus(
    app_state: AppState,
) -> None:
    """"Unreadable" and "empty" are different answers and must stay separable."""
    from app.api.routes import health

    await app_state.rag.ensure_seeded()

    async def _unreadable() -> dict:
        raise RuntimeError("store unreadable")

    app_state.rag._store.stats = _unreadable  # type: ignore[method-assign]
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    assert app_state.rag.corpus_degraded is False
    assert (await health(app_state)).degraded is False


# --------------------------------------------------------------------------- #
# Criterion 3 — GET /api/health reports degraded within one cycle of the corpus
#               reaching zero.
# --------------------------------------------------------------------------- #
async def test_public_health_reports_degraded_when_the_corpus_is_empty(
    app_state: AppState,
) -> None:
    from app.api.routes import health

    # Healthy first: a populated corpus is not a degradation.
    await app_state.rag.ensure_seeded()
    await app_state.rag.refresh_corpus_health()
    ok = await health(app_state)
    assert ok.degraded is False and ok.degraded_reasons == []

    # The corpus is lost (as it was, after the reprojection).
    await app_state.rag._store.clear()
    await app_state.rag.refresh_corpus_health()

    degraded = await health(app_state)
    assert degraded.degraded is True
    assert "rag_corpus_empty" in degraded.degraded_reasons
    # `status` keeps its historical state-store meaning so release tooling is unaffected.
    assert degraded.status == "ok"


async def test_public_health_never_leaks_corpus_detail(app_state: AppState) -> None:
    """/api/health is anonymous: codes only, never counts or source names."""
    from app.api.routes import health

    await app_state.rag._store.clear()
    await app_state.rag.refresh_corpus_health()
    body = (await health(app_state)).model_dump(mode="json")

    assert set(body["degraded_reasons"]) <= {
        "rag_corpus_empty",
        "rag_projection_refused",
        "llm_provider_unauthenticated",
        "llm_provider_quota_exhausted",
        "llm_provider_unavailable",
    }
    serialized = json.dumps(body)
    for forbidden in ("chunk", "runbook", "mitre", "resolved_case", "precedent"):
        assert forbidden not in serialized


async def test_the_public_health_probe_never_triggers_seeding(
    app_state: AppState,
) -> None:
    """An anonymous caller must not be able to trigger an embedding spend (#6)."""
    from app.api.routes import health

    await app_state.rag._store.clear()
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None

    async def _explode() -> list[dict]:
        raise AssertionError("the health probe must never seed")

    app_state.rag._enabled_seeds = _explode  # type: ignore[method-assign]
    await health(app_state)


# --------------------------------------------------------------------------- #
# Criterion 3 (cont.) — the reconciliation check: "N documents vs M qualifying
#                       source records".
# --------------------------------------------------------------------------- #
async def test_reconciliation_flags_a_corpus_that_lost_its_precedent(
    app_state: AppState,
) -> None:
    """The early-warning signal: the history still qualifies, the corpus is empty."""
    from app.api.routes_diagnostics import _precedent_corpus_block

    cases = await seed_confirmed_cases(app_state, count=8)
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.rag.use_resolved_cases = True
    await app_state.update_prefs(prefs)

    # The projection is gone but the source of truth is intact — the incident's shape.
    await app_state.rag._store.clear()

    block = await _precedent_corpus_block(app_state, cases, len(cases))
    reconciliation = block["reconciliation"]
    assert reconciliation["measured"] is True
    assert reconciliation["deficit"] is True
    assert reconciliation["qualifying_source_records"] == len(cases)
    assert reconciliation["corpus_documents"] == 0
    assert "qualifies" in reconciliation["detail"]


async def test_reconciliation_stays_silent_when_the_window_explains_the_gap(
    app_state: AppState,
) -> None:
    """N < M is NORMAL — the projection is a bounded window, not a full copy."""
    from app.api.routes_diagnostics import _reconciliation_block

    prefs = app_state.prefs.model_copy(deep=True)
    prefs.precedent.window.size = 5
    block = _reconciliation_block(
        prefs.rag,
        window=prefs.precedent,
        available=True,
        precedent_enabled=True,
        confirmed_exact=True,
        # 5 documents against 500 qualifying records is exactly the window doing its job.
        analyst_confirmed_documents=5,
        ground_truth={"analyst_confirmed_cases": 500, "truncated": False},
        corpus_may_be_truncated=False,
    )
    assert block["measured"] is True
    assert block["deficit"] is False
    assert block["expected_documents"] == 5


async def test_reconciliation_reports_unknown_rather_than_guessing(
    app_state: AppState,
) -> None:
    """A truncated read means "we could not tell", never "the corpus is fine"."""
    from app.api.routes_diagnostics import _reconciliation_block

    prefs = app_state.prefs.model_copy(deep=True)
    block = _reconciliation_block(
        prefs.rag,
        window=prefs.precedent,
        available=True,
        precedent_enabled=True,
        confirmed_exact=True,
        analyst_confirmed_documents=0,
        ground_truth={"analyst_confirmed_cases": 900, "truncated": True},
        corpus_may_be_truncated=False,
    )
    assert block["measured"] is False
    assert block["deficit"] is False
    assert block["reason"]


# --------------------------------------------------------------------------- #
# Criterion 4 — sustained provider auth failure surfaces a distinct health state,
#               and the case-level message names the real cause.
# --------------------------------------------------------------------------- #
async def test_sustained_auth_failure_surfaces_a_distinct_health_state(
    app_state: AppState,
) -> None:
    from app.api.routes import health
    from app.api.routes_diagnostics import _provider_health_block

    _start_outage(app_state, _TotalOutageProvider())
    for _ in range(3):
        with pytest.raises(GatewayError):
            await app_state.gateway.complete(
                "router", [{"role": "user", "content": "x"}],
                app_state.prefs.model_for("router"),
            )

    block = _provider_health_block(app_state)
    assert block["available"] is True
    assert block["state"] == "unauthenticated"
    assert block["degraded"] is True

    body = await health(app_state)
    assert "llm_provider_unauthenticated" in body.degraded_reasons


async def test_an_auth_failure_is_distinguishable_from_a_quota_or_transport_failure(
    app_state: AppState,
) -> None:
    """The whole point: 401 must not read the same as a timeout."""
    from app.llm.gateway import classify_provider_failure

    assert classify_provider_failure(
        ProviderError("HTTP 401: nope", retryable=False, status=401)
    ) == "unauthenticated"
    assert classify_provider_failure(
        ProviderError("HTTP 429: slow down", retryable=True, status=429)
    ) == "quota"
    assert classify_provider_failure(
        ProviderError("timeout: read", retryable=True)
    ) == "unavailable"
    assert classify_provider_failure(NotImplementedError()) == "unsupported"
    # A deployment with no key is NOT an outage; it is the supported keyless profile.
    assert classify_provider_failure(
        GatewayError("OpenAI API key not configured")
    ) == "not_configured"


async def test_a_single_failure_is_not_an_outage(app_state: AppState) -> None:
    """One transient error must never be reported as a system state."""
    from app.api.routes import health

    _start_outage(app_state, _TotalOutageProvider())
    with pytest.raises(GatewayError):
        await app_state.gateway.complete(
            "router", [{"role": "user", "content": "x"}],
            app_state.prefs.model_for("router"),
        )

    assert (await health(app_state)).degraded is False


async def test_the_time_cap_message_names_the_real_cause(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The operator chased latency for days because the surface said "time cap"."""
    import asyncio

    from app.agents import pipeline as pipeline_module

    _start_outage(app_state, _TotalOutageProvider())
    for _ in range(3):
        with pytest.raises(GatewayError):
            await app_state.gateway.complete(
                "router", [{"role": "user", "content": "x"}],
                app_state.prefs.model_for("router"),
            )

    async def _hang(*args, **kwargs):
        await asyncio.sleep(3600)

    # monkeypatch (not a bare assignment) so the stub is restored for every later
    # test — a leaked module global here silently breaks unrelated suites.
    monkeypatch.setattr(pipeline_module, "run_investigation", _hang)
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.caps.timeout_seconds = 1
    case = await app_state.pipeline.investigate_cluster(
        _cluster("7.7.7.7"), SourceSurface.INVESTIGATE, prefs
    )

    # #3 holds: the verdict is still NEEDS_HUMAN and the case never auto-closes.
    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.status != CaseStatus.CLOSED
    # ...but the explanation now names the credential failure, not the time cap.
    assert "credential" in (case.recommended_action or "").lower()
    assert case.error and "authentication" in case.error.lower()


# --------------------------------------------------------------------------- #
# Criterion 5 + 6 — clearing the outage rebuilds the corpus, and FALSE_POSITIVE
#                   verdicts resume.
# --------------------------------------------------------------------------- #
async def test_clearing_the_outage_rebuilds_the_corpus_automatically(
    app_state: AppState, mock_provider: MockProvider
) -> None:
    """Recovery must not require a container recreate."""
    await app_state.rag.ensure_seeded()
    healthy = await app_state.rag._store.count()

    # The corpus is lost and the seed cache still claims it is done — the dead end.
    await app_state.rag._store.clear()
    app_state.rag._seeded = True
    app_state.rag._seed_signature = app_state.rag._source_signature()
    assert await app_state.rag._store.count() == 0

    # The provider is healthy again; the next ordinary retrieval self-heals.
    observation = await app_state.rag.retrieve_observed("ssh brute force", top_k=3)
    assert await app_state.rag._store.count() == healthy
    assert observation.reason != "corpus_empty"


async def test_changing_the_embedding_model_reprojects_the_corpus(
    app_state: AppState,
) -> None:
    """The seed signature must include the embedding space it projected into.

    Without it, changing the embedding model left the cached signature untouched, so
    ``ensure_seeded`` short-circuited and the corpus went on serving vectors from a
    space the queries no longer live in.
    """
    await app_state.rag.ensure_seeded()
    before = app_state.rag._source_signature()

    prefs = app_state.rag._prefs
    app_state.rag.set_prefs(
        prefs.model_copy(
            update={
                "embedding_model": prefs.embedding_model.model_copy(
                    update={"model": "text-embedding-3-large"}
                )
            }
        )
    )

    after = app_state.rag._source_signature()
    assert after != before, "an embedding-model change must invalidate the seed cache"
    assert app_state.rag._seed_signature != after


async def test_the_rebuild_action_is_explicit_and_idempotent(
    app_state: AppState,
) -> None:
    """Criterion 5's "one documented action"."""
    await app_state.rag.ensure_seeded()
    healthy = await app_state.rag._store.count()

    await app_state.rag._store.clear()
    app_state.rag._seeded = True
    app_state.rag._seed_signature = app_state.rag._source_signature()

    first = await app_state.rag.rebuild_corpus()
    assert first["rebuilt"] is True and first["refused"] is False
    assert first["chunks_after"] == healthy

    # Idempotent: running it again converges rather than duplicating.
    second = await app_state.rag.rebuild_corpus()
    assert second["chunks_after"] == healthy


async def test_a_rebuild_during_an_outage_is_refused_not_destructive(
    app_state: AppState,
) -> None:
    """The recovery action must never become a second way to lose the corpus."""
    await app_state.rag.ensure_seeded()
    healthy = await app_state.rag._store.count()

    _start_outage(app_state, _ExpiredKeyProvider())
    result = await app_state.rag.rebuild_corpus()

    assert result["rebuilt"] is False
    assert await app_state.rag._store.count() == healthy


def _strong_router() -> str:
    """Route to the INVESTIGATOR, so the run actually consults the knowledge corpus.

    The ``obviously_benign`` router shortcut returns FALSE_POSITIVE without any
    retrieval at all, so asserting auto-close through it would pass whether or not the
    corpus was ever restored.
    """
    return json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "investigate"}
    )


def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "no action required",
            "reproduce_query": 'source.ip : "9.9.9.9"',
        },
    })


async def test_the_full_outage_and_recovery_cycle(
    app_state: AppState, mock_provider: MockProvider
) -> None:
    """Criterion 6 end to end: outage -> everything held -> restore -> service resumes.

    This is the incident as one narrative, because each half is only meaningful with
    the other: preserving the corpus is worthless if it never comes back, and coming
    back is worthless if the outage corrupted it first.
    """
    from app.api.routes import health

    prefs = app_state.prefs.model_copy(deep=True)
    prefs.auto_close.false_positive.enabled = True
    prefs.auto_close.false_positive.min_confidence = 0.5
    prefs.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(prefs)

    await app_state.rag.ensure_seeded()
    healthy_count = await app_state.rag._store.count()
    healthy_docs = await app_state.rag._store.list_documents()
    assert healthy_count > 0

    # ---- 1. THE OUTAGE: 401 on every embedding call. ----
    healthy_providers = dict(app_state.gateway._providers)
    _start_outage(app_state, _ExpiredKeyProvider())
    app_state.rag._seeded = False
    app_state.rag._seed_signature = None
    await app_state.rag.ensure_seeded()

    # The corpus is untouched and carries no hash-space vector.
    assert await app_state.rag._store.count() == healthy_count
    assert await app_state.rag._store.list_documents() == healthy_docs
    for doc in healthy_docs:
        for chunk in await app_state.rag._store.list_chunks(doc["document_id"]):
            assert chunk.metadata.get("embedding_fallback") is not True

    # ---- 2. THE CORPUS IS LOST ANYWAY, and the seed cache latches. ----
    await app_state.rag._store.clear()
    app_state.rag._seeded = True
    app_state.rag._seed_signature = app_state.rag._source_signature()
    await app_state.rag.refresh_corpus_health()
    assert (await health(app_state)).degraded is True

    # A rebuild attempted DURING the outage is refused, never destructive.
    refused = await app_state.rag.rebuild_corpus()
    assert refused["rebuilt"] is False

    # ---- 3. RECOVERY: the key is restored. ----
    app_state.gateway._providers.clear()
    app_state.gateway._providers.update(healthy_providers)
    rebuild = await app_state.rag.rebuild_corpus()
    assert rebuild["rebuilt"] is True
    assert rebuild["chunks_after"] == healthy_count
    assert (await health(app_state)).degraded is False

    # ---- 4. The corpus is genuinely USABLE again, not merely non-empty. ----
    observation = await app_state.rag.retrieve_observed("ssh brute force", top_k=3)
    assert observation.measured is True
    assert observation.chunks

    # ---- 5. And FALSE_POSITIVE auto-close resumes through the INVESTIGATOR path,
    #         which is the one that actually consults the corpus. ----
    mock_provider.push("router", _strong_router())
    mock_provider.push("investigator", _final_verdict("FALSE_POSITIVE", 0.95))
    case = await app_state.pipeline.investigate_cluster(
        _cluster("9.9.9.9"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )
    assert case.verdict == Verdict.FALSE_POSITIVE
    assert case.status == CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.AGENT
    # Step 4 above independently proved the corpus is readable and returns content,
    # so this auto-close is not the vacuous router-shortcut path: the run went through
    # the investigator with a live corpus behind it.


async def test_the_rebuild_job_is_submittable_and_actually_rebuilds(
    app_state: AppState,
) -> None:
    """Criterion 5 through the surface an OPERATOR actually uses.

    ``rebuild_corpus()`` being correct is not the same as the documented action being
    reachable: the Job kind has to validate an empty params body, resolve its RBAC
    grant, register a handler, and run to a terminal state.
    """
    from contextlib import asynccontextmanager

    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes_jobs import router
    from app.constants import JobStatus

    await app_state.rag.ensure_seeded()
    healthy = await app_state.rag._store.count()
    await app_state.rag._store.clear()
    app_state.rag._seeded = True
    app_state.rag._seed_signature = app_state.rag._source_signature()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        api.state.tlsoc = app_state
        yield

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        response = client.post(
            "/api/jobs",
            json={
                "kind": "rag_rebuild",
                "idempotency_key": "rebuild-after-outage",
                "params": {},
            },
        )
        assert response.status_code == 202, response.text
        job_id = response.json()["job_id"]
        assert response.json()["kind"] == "rag_rebuild"

        for _ in range(200):
            detail = client.get(f"/api/jobs/{job_id}").json()
            if detail["status"] in {
                JobStatus.SUCCEEDED.value, JobStatus.FAILED.value,
                JobStatus.PARTIAL.value, JobStatus.CANCELLED.value,
            }:
                break
            await asyncio.sleep(0.05)

        assert detail["status"] == JobStatus.SUCCEEDED.value, detail
        assert detail["result"]["counts"]["chunks_after"] == healthy

    assert await app_state.rag._store.count() == healthy


async def test_a_sustained_embedding_outage_alone_degrades_health(
    app_state: AppState,
) -> None:
    """Criterion 6's "health degraded" leg, under a 401 and an INTACT corpus.

    The corpus surviving the outage is the point of criterion 1 — so the degradation
    here must come from the provider signal, not from an empty corpus. Without it, an
    outage that has not yet destroyed anything is still invisible.
    """
    from app.api.routes import health

    await app_state.rag.ensure_seeded()
    intact = await app_state.rag._store.count()
    assert intact > 0
    assert (await health(app_state)).degraded is False

    _start_outage(app_state, _ExpiredKeyProvider())
    for _ in range(3):
        app_state.rag._seeded = False
        app_state.rag._seed_signature = None
        await app_state.rag.ensure_seeded()

    body = await health(app_state)
    assert body.degraded is True
    assert "llm_provider_unauthenticated" in body.degraded_reasons
    # ...and the corpus really is still intact, so this is the provider signal.
    assert await app_state.rag._store.count() == intact


async def test_recovery_clears_the_degraded_health_signal(app_state: AppState) -> None:
    from app.api.routes import health

    await app_state.rag.ensure_seeded()
    await app_state.rag._store.clear()
    await app_state.rag.refresh_corpus_health()
    assert (await health(app_state)).degraded is True

    await app_state.rag.rebuild_corpus()
    assert (await health(app_state)).degraded is False
