"""Item C — an EMPIRICAL embedding probe, and corpus COMPOSITION health.

Two silent failures, both of which a capability allowlist and a size guard let through.

**The embedding slot.** The only pre-save validation asked a bundled 23-row JSON
catalog whether a model declares the ``embedding`` capability, and exactly three ids
do. That is not a guard, it is a portability bug: every self-hosted / LiteLLM / vLLM /
Ollama embedding endpoint an operator actually runs is unknown to the catalog and
therefore unconfigurable, while the catalog says nothing whatsoever about an id it has
never seen. The portable answer is to ASK THE ENDPOINT — embed a fixed anchor, a fixed
contrast string and the anchor again, and state only what any real embedding space must
satisfy. Crucially the discrimination assertion is an ORDERING statement (the anchor is
closer to its own repeat than to the contrast), never an absolute cosine floor, because
similarity magnitudes are a property of the embedding family and a floor tuned to one
family rejects another.

**The corpus.** The existing projection guard is a SIZE guard. A reprojection that keeps
the chunk count and flips what every chunk says passes it cleanly — and on the
deployment that motivated this, the obvious dashboard (analyst outcome ALONE) read 198
``false_positive`` / 2 ``true_positive`` and stayed green for the whole incident while
the corpus was poisoning the model. These tests pin the cross-tab that shows it, the
class-share SHIFT alarm (not row count, not disagreement level), the
single-transaction concentration finding, and the stranded-in-an-old-vector-space count
a reprojection otherwise leaves invisible.
"""

from __future__ import annotations

import json
import math

import pytest

from app.api.routes_diagnostics import (
    _build_alerts,
    _corpus_composition_block,
    _embedding_space_block,
)
from app.api.routes_models import ModelTestBody, llm_model_test, probe_embedding_model
from app.config import ModelConfig
from app.llm.pricing import (
    EMBEDDING_CAPABILITY,
    capability_coverage,
    capability_state,
    load_registry,
    model_may_embed,
    model_supports_capability,
)
from app.stores.rag_health import RagHealthStore


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class _Batch:
    """The gateway's ``EmbeddingBatch`` shape, as the probe consumes it."""

    def __init__(self, vectors, *, provider="openai_compatible", model="m",
                 fallback=False, fallback_reason="") -> None:
        self.vectors = vectors
        self.provider = provider
        self.model = model
        self.fallback = fallback
        self.fallback_reason = fallback_reason


class _Gateway:
    """A gateway whose embed response is supplied by ``responder(texts)``."""

    def __init__(self, responder) -> None:
        self._responder = responder
        self.calls: list[list[str]] = []

    async def embed_with_provenance(self, texts, cfg, *, surface="rag", case_id=None):
        self.calls.append(list(texts))
        return self._responder(list(texts))


def _real_embedding(texts, *, dim=768, offset=0.0):
    """A well-behaved embedding space: deterministic per text, and a text is closer
    to itself than to a different one."""
    out = []
    for text in texts:
        seed = sum(ord(ch) * (index + 1) for index, ch in enumerate(text))
        vector = [
            math.sin((seed % 997) * (i + 1) * 0.017) + offset for i in range(dim)
        ]
        out.append(vector)
    return out


_CFG = ModelConfig(provider="openai_compatible", model="bge-m3", base_url="http://lan:8000/v1")


# --------------------------------------------------------------------------- #
# The allowlist that was never a guard
# --------------------------------------------------------------------------- #
def test_the_capability_allowlist_cannot_speak_for_most_of_its_own_catalog() -> None:
    """The measurement behind the change: the declaration covers a small minority."""
    coverage = capability_coverage(EMBEDDING_CAPABILITY)
    assert coverage["catalog_models"] > 0
    # A handful of declared embedding models out of the whole catalog. Asserted as an
    # inequality, not a hardcoded pair, so adding a catalog row never breaks this.
    assert 0 < coverage["declaring_models"] < coverage["catalog_models"]


def test_an_unknown_self_hosted_model_is_not_evidence_of_incapability() -> None:
    """The portability regression, at the helper level.

    ``model_supports_capability`` answers "does the catalog DECLARE this?", and for an
    operator's own endpoint the answer is always no — which is why using it as an
    acceptance gate makes every self-hosted embedding model unconfigurable.
    """
    self_hosted = "bge-m3"
    assert model_supports_capability(self_hosted, EMBEDDING_CAPABILITY) is False
    assert capability_state(self_hosted, EMBEDDING_CAPABILITY) == "unknown"
    # No evidence either way -> the catalog must not refuse it; the probe decides.
    assert model_may_embed(self_hosted) is True


def test_a_known_completion_model_is_still_refused_on_catalog_evidence() -> None:
    """The one refusal the catalog CAN back: a row that declares other capabilities."""
    assert capability_state("gpt-4o", EMBEDDING_CAPABILITY) == "declared_absent"
    assert model_may_embed("gpt-4o") is False
    assert model_may_embed("text-embedding-3-small") is True


# --------------------------------------------------------------------------- #
# The probe
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_chat_model_in_the_embedding_slot_is_rejected_by_the_probe() -> None:
    """A completion endpoint that answers with one constant vector for every input.

    This is the shape a chat model in the embedding slot produces when the wire does
    not simply error: numeric, stable, plausible — and useless, because it cannot
    distinguish two different inputs. The refusal must name what was OBSERVED.
    """
    constant = [0.5] * 1536
    gateway = _Gateway(lambda texts: _Batch([list(constant) for _ in texts],
                                            provider="openai", model="gpt-4o"))
    out = await probe_embedding_model(gateway, ModelConfig(provider="openai", model="gpt-4o"))

    assert out["ok"] is False
    failed = {c["id"] for c in out["checks"] if not c["passed"]}
    assert "distinct_inputs_distinct_vectors" in failed
    assert "discriminates_between_inputs" in failed
    # The message states the observation, not a capability claim.
    assert "1536" in out["message"]
    assert "against itself" in out["message"]
    assert out["observed"]["dimensions"] == 1536
    assert out["observed"]["distinct_vectors"] is False
    # Never a bare capability assertion.
    assert "not declared" not in out["message"]


@pytest.mark.asyncio
async def test_a_prose_response_is_rejected_as_not_an_embedding_response() -> None:
    gateway = _Gateway(lambda texts: _Batch([["ok"] for _ in texts]))
    out = await probe_embedding_model(gateway, _CFG)

    assert out["ok"] is False
    assert {c["id"] for c in out["checks"] if not c["passed"]} == {
        "numeric_vector_response"
    }
    assert "not an embedding response" in out["message"]


@pytest.mark.asyncio
async def test_the_local_fallback_is_never_certified_as_the_configured_model() -> None:
    """The gateway degrades to deterministic local hash vectors on a provider failure.

    Those vectors pass every numeric and ordering check, so without an explicit
    fallback check the probe would certify a model whose endpoint rejected the request.
    """
    gateway = _Gateway(lambda texts: _Batch(
        _real_embedding(texts, dim=256), provider="mock", model="mock-embed",
        fallback=True, fallback_reason="unauthenticated",
    ))
    out = await probe_embedding_model(gateway, _CFG)

    assert out["ok"] is False
    assert out["checks"][0]["id"] == "configured_provider_answered"
    assert out["checks"][0]["passed"] is False
    assert "unauthenticated" in out["message"]
    assert "nothing was learned about it" in out["message"]


@pytest.mark.asyncio
async def test_a_self_hosted_openai_compatible_embedding_model_passes() -> None:
    """THE portability regression test.

    The bundled catalog has never heard of this model id, so the allowlist gate
    rejected it outright. The probe judges the endpoint's actual response and passes it.
    """
    gateway = _Gateway(lambda texts: _Batch(
        _real_embedding(texts, dim=1024), provider="openai_compatible", model="bge-m3",
    ))
    out = await probe_embedding_model(gateway, _CFG)

    assert out["ok"] is True, out["message"]
    assert all(c["passed"] for c in out["checks"])
    assert out["observed"]["dimensions"] == 1024
    assert out["observed"]["fallback"] is False
    assert "usable embedding space" in out["message"]
    # And the catalog still has no opinion about it — that is exactly the point.
    assert capability_state("bge-m3", EMBEDDING_CAPABILITY) == "unknown"


@pytest.mark.asyncio
async def test_discrimination_is_an_ordering_statement_not_a_similarity_floor() -> None:
    """A family whose unrelated sentences sit at very high cosine still passes.

    Similarity magnitudes differ wildly between embedding families. Any absolute floor
    is tuned to whichever family the author had in front of them; the ordering holds for
    every space that encodes meaning at all.
    """
    base = _real_embedding(["anchor"], dim=512)[0]

    def _tight(texts):
        vectors = []
        for text in texts:
            # Every vector is a 99.9% copy of one direction -> all cosines ~0.999.
            jitter = 0.0 if text.startswith("authentication") else 0.001
            vectors.append([value + jitter for value in base])
        return _Batch(vectors, provider="openai_compatible", model="tight-family")

    out = await probe_embedding_model(_Gateway(_tight), _CFG)

    assert out["ok"] is True, out["message"]
    assert out["observed"]["self_similarity"] > out["observed"]["contrast_similarity"]
    # The similarities themselves are extremely high; no floor rejected them.
    assert out["observed"]["contrast_similarity"] > 0.99


@pytest.mark.asyncio
async def test_an_all_zero_vector_is_rejected() -> None:
    gateway = _Gateway(lambda texts: _Batch([[0.0] * 64 for _ in texts]))
    out = await probe_embedding_model(gateway, _CFG)

    assert out["ok"] is False
    failed = {c["id"] for c in out["checks"] if not c["passed"]}
    assert "non_zero_vectors" in failed


@pytest.mark.asyncio
async def test_unstable_dimensionality_is_rejected() -> None:
    def _wobble(texts):
        return _Batch([_real_embedding([t], dim=128 + i * 8)[0] for i, t in enumerate(texts)])

    out = await probe_embedding_model(_Gateway(_wobble), _CFG)

    assert out["ok"] is False
    failed = {c["id"] for c in out["checks"] if not c["passed"]}
    assert "stable_dimensionality" in failed


@pytest.mark.asyncio
async def test_a_gateway_error_reports_the_failure_not_a_capability_verdict() -> None:
    class _Boom:
        async def embed_with_provenance(self, *a, **k):
            raise RuntimeError("connection refused")

    out = await probe_embedding_model(_Boom(), _CFG)
    assert out["ok"] is False
    assert out["checks"] == [
        {"id": "call_succeeded", "passed": False, "detail": "connection refused"}
    ]
    assert "nothing was observed" in out["message"]


# --------------------------------------------------------------------------- #
# The model-test route's embedding mode
# --------------------------------------------------------------------------- #
class _CustomModels:
    def __init__(self, row=None) -> None:
        self._row = row

    async def get_model(self, mid):
        return self._row


class _PriceOverlay:
    async def as_price_tuple(self, mid):
        return None


class _RouteState:
    def __init__(self, gateway, custom_row=None) -> None:
        self.gateway = gateway
        self.custom_models = _CustomModels(custom_row)
        self.price_overlay = _PriceOverlay()


@pytest.mark.asyncio
async def test_model_test_route_validates_an_embedding_model_before_saving() -> None:
    """An operator can settle the question BEFORE the model reaches the config."""
    gateway = _Gateway(lambda texts: _Batch(
        _real_embedding(texts, dim=1024), provider="openai_compatible", model="bge-m3",
    ))
    state = _RouteState(gateway, custom_row={
        "provider": "openai_compatible", "base_url": "http://lan:8000/v1",
    })
    out = await llm_model_test(
        ModelTestBody(model="bge-m3", mode="embedding"), state=state,
    )

    assert out["ok"] is True
    assert out["mode"] == "embedding"
    assert out["observed"]["dimensions"] == 1024
    # The catalog declaration travels as CONTEXT, never as the verdict.
    assert out["catalog_declaration"]["state"] == "unknown"
    assert out["catalog_declaration"]["declaring_models"] < out["catalog_declaration"]["catalog_models"]
    # The probe embedded through the ONE gateway (#6) — three fixed strings.
    assert len(gateway.calls) == 1 and len(gateway.calls[0]) == 3


@pytest.mark.asyncio
async def test_model_test_route_embedding_mode_reports_a_rejection() -> None:
    constant = [0.25] * 512
    gateway = _Gateway(lambda texts: _Batch([list(constant) for _ in texts],
                                            provider="openai", model="gpt-4o"))
    out = await llm_model_test(
        ModelTestBody(model="gpt-4o", mode="embedding"), state=_RouteState(gateway),
    )
    assert out["ok"] is False
    assert out["error"] == out["message"]
    assert "512" in out["error"]
    assert out["catalog_declaration"]["state"] == "declared_absent"


@pytest.mark.asyncio
async def test_model_test_route_rejects_an_unknown_mode() -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        await llm_model_test(
            ModelTestBody(model="bge-m3", mode="vision"), state=_RouteState(_Gateway(lambda t: None)),
        )
    assert excinfo.value.status_code == 400


# --------------------------------------------------------------------------- #
# Corpus composition
# --------------------------------------------------------------------------- #
class _MemKV:
    """The minimal KVStore surface ``RagHealthStore`` uses (offline)."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict] = {}

    async def get(self, ns: str, key: str):
        return self.docs.get((ns, key))

    async def put(self, ns: str, key: str, value: dict) -> None:
        self.docs[(ns, key)] = dict(value)


class _CompRag:
    def __init__(self, rows, *, truncated=False, health=None, fail=False,
                 documents=None) -> None:
        self._rows = rows
        self._truncated = truncated
        self._fail = fail
        self._health = health
        self._documents = documents or []

    async def _precedent_chunk_metadata(self):
        if self._fail:
            raise RuntimeError("vector store unavailable")
        return list(self._rows), self._truncated

    async def snapshot_documents_strict(self):
        return list(self._documents)


class _CompPrefs:
    class _Rag:
        enabled = True
        use_resolved_cases = True

    def __init__(self) -> None:
        self.rag = _CompPrefs._Rag()


class _CompState:
    def __init__(self, rag) -> None:
        self.rag_service = rag
        self.prefs = _CompPrefs()


def _row(*, source, outcome, verdict, identity="rule:a", bulk=False):
    return {
        "ground_truth_source": source,
        "outcome": outcome,
        "verdict": verdict,
        "rule_identity": identity,
        "bulk_ratified": bulk,
    }


def _poisoned_corpus(n=200):
    """The incident's corpus: outcome alone reads 198 FP / 2 TP and looks pristine,
    while almost every row carries no independent label and merely echoes the model."""
    rows = [
        _row(source="", outcome="false_positive", verdict="false_positive",
             identity=f"rule:{i % 7}")
        for i in range(n - 4)
    ]
    rows += [
        _row(source="analyst_feedback", outcome="false_positive",
             verdict="false_positive", identity="rule:1")
        for _ in range(2)
    ]
    rows += [
        _row(source="analyst_feedback", outcome="true_positive",
             verdict="true_positive", identity="rule:2")
        for _ in range(2)
    ]
    return rows


@pytest.mark.asyncio
async def test_composition_reports_the_cross_tab_not_outcome_alone() -> None:
    """198/2 is the number that stayed green; the cross-tab is the one that does not."""
    health = RagHealthStore(_MemKV())
    block = await _corpus_composition_block(
        _CompState(_CompRag(_poisoned_corpus(), health=health))
    )

    assert block["available"] is True
    assert block["rows"] == 200
    # The view an operator had been reading: pristine.
    assert block["outcome_only_view"] == {"false_positive": 198, "true_positive": 2}
    # The view that contradicts it.
    assert block["by_ground_truth_source"]["none"] == 196
    assert block["independent_ground_truth_share"] == pytest.approx(0.02)
    # Every published cell carries all three axes.
    for cell in block["cells"]:
        assert {"ground_truth_source", "outcome", "verdict"} <= set(cell)


@pytest.mark.asyncio
async def test_composition_alarms_on_a_class_share_shift_not_on_row_count() -> None:
    """Same row count, flipped classes: the size guard sees nothing, this does."""
    kv = _MemKV()
    health = RagHealthStore(kv)
    before = [
        _row(source="analyst_feedback", outcome="false_positive",
             verdict="false_positive", identity=f"rule:{i % 9}")
        for i in range(100)
    ]
    first = await _corpus_composition_block(_CompState(_CompRag(before, health=health)))
    assert first["shift"]["measured"] is False
    assert "no previous composition reading" in first["shift"]["reason"]

    after = [
        _row(source="", outcome="true_positive", verdict="true_positive",
             identity=f"rule:{i % 9}")
        for i in range(100)  # identical row COUNT
    ]
    second = await _corpus_composition_block(_CompState(_CompRag(after, health=health)))

    assert second["rows"] == first["rows"]          # size guard: nothing happened
    assert second["shift"]["measured"] is True
    assert second["shift"]["shifted"] is True
    assert second["shift"]["max_delta"] == 1.0
    assert second["shift"]["total_variation"] == 1.0

    alerts, _ = _build_alerts({"known": True, "starved": False, "status_reason": "",
                               "reason": "", "projection": {"available": True,
                                                            "collapsed_sources": [],
                                                            "shrank_sources": []}},
                              {}, {}, None, None, second, None)
    assert any(a["id"] == "rag_composition_shift" for a in alerts)


@pytest.mark.asyncio
async def test_a_composition_shift_survives_being_read_more_than_once() -> None:
    """Observation and alerting share ONE operator-facing read, so a baseline that
    advanced to the newest reading made the alarm one-shot: the first request after a
    poisoning consumed the finding for everybody and every later request reported a
    zero delta on a still-poisoned corpus. Two components already read this endpoint
    independently, so an operator could reach it after it had gone quiet."""
    health = RagHealthStore(_MemKV())
    before = [
        _row(source="analyst_feedback", outcome="false_positive",
             verdict="false_positive", identity=f"rule:{i % 9}")
        for i in range(100)
    ]
    after = [
        _row(source="", outcome="true_positive", verdict="true_positive",
             identity=f"rule:{i % 9}")
        for i in range(100)
    ]
    await _corpus_composition_block(_CompState(_CompRag(before, health=health)))
    # Each read gets a FRESH rag object, so the short TTL corpus cache cannot mask this.
    reads = [
        await _corpus_composition_block(_CompState(_CompRag(after, health=health)))
        for _ in range(3)
    ]
    for i, read in enumerate(reads):
        assert read["shift"]["shifted"] is True, i
        assert read["shift"]["max_delta"] == 1.0, i
        alerts, _ = _build_alerts({"known": True, "starved": False, "status_reason": "",
                                   "reason": "", "projection": {"available": True,
                                                                "collapsed_sources": [],
                                                                "shrank_sources": []}},
                                  {}, {}, None, None, read, None)
        assert any(a["id"] == "rag_composition_shift" for a in alerts), i
    # An unchanged reading still appends nothing, so polling cannot roll the finding
    # out of the bounded series just by being read.
    assert len((await health.load()).get("composition") or []) == 2


@pytest.mark.asyncio
async def test_a_corpus_that_merely_grows_does_not_alarm() -> None:
    """Row count is never the signal: doubling a corpus without changing its class
    shares must stay silent."""
    health = RagHealthStore(_MemKV())

    def _uniform(n):
        return [
            _row(source="analyst_feedback", outcome="false_positive",
                 verdict="false_positive", identity=f"rule:{i % 11}")
            for i in range(n)
        ]

    await _corpus_composition_block(_CompState(_CompRag(_uniform(60), health=health)))
    grown = await _corpus_composition_block(
        _CompState(_CompRag(_uniform(600), health=health))
    )

    assert grown["rows"] == 600
    assert grown["shift"]["measured"] is True
    assert grown["shift"]["shifted"] is False
    assert grown["shift"]["max_delta"] == 0.0


@pytest.mark.asyncio
async def test_analyst_model_disagreement_alone_never_alarms() -> None:
    """Disagreement is what a working queue produces; alarming on it would fire
    permanently exactly where analysts do the most work."""
    health = RagHealthStore(_MemKV())
    disagreeing = [
        _row(source="analyst_feedback", outcome="false_positive",
             verdict="true_positive", identity=f"rule:{i % 13}")
        for i in range(120)
    ]
    # Observe the SAME composition twice: nothing moved, so nothing may fire.
    await _corpus_composition_block(_CompState(_CompRag(disagreeing, health=health)))
    block = await _corpus_composition_block(
        _CompState(_CompRag(disagreeing, health=health))
    )

    assert block["shift"]["shifted"] is False
    alerts, _ = _build_alerts({"known": True, "starved": False, "status_reason": "",
                               "reason": "", "projection": {"available": True,
                                                            "collapsed_sources": [],
                                                            "shrank_sources": []}},
                              {}, {}, None, None, block, None)
    assert [a for a in alerts if a["id"].startswith("rag_composition")] == []


@pytest.mark.asyncio
async def test_single_transaction_concentration_is_reported_with_its_evidence() -> None:
    """One bulk action on one detection now owns a whole class of the corpus."""
    health = RagHealthStore(_MemKV())
    rows = [
        _row(source="", outcome="false_positive", verdict="false_positive",
             identity="rule:noisy-one", bulk=True)
        for _ in range(180)
    ]
    rows += [
        _row(source="analyst_feedback", outcome="true_positive",
             verdict="true_positive", identity=f"rule:{i}")
        for i in range(20)
    ]
    block = await _corpus_composition_block(_CompState(_CompRag(rows, health=health)))

    assert block["concentration"]["measured"] is True
    assert block["concentration"]["concentrated"] is True
    finding = block["concentration"]["cells"][0]
    assert finding["rows"] == 180
    assert finding["cell_share"] == pytest.approx(0.9)
    assert finding["top_contributor_share"] == 1.0
    assert finding["bulk_ratified_share"] == 1.0
    # The dominating identity is NAMED. It used to be an unsalted 12-hex digest
    # documented as "non-reversible", but the sibling ``distribution`` block on the
    # SAME response publishes every rule identity in the clear, so the digest was
    # reversible by inspection of its own payload while costing the finding the one
    # thing that makes it actionable. Nothing is persisted with an identity attached.
    assert finding["top_contributor"] == "rule:noisy-one"

    alerts, _ = _build_alerts({"known": True, "starved": False, "status_reason": "",
                               "reason": "", "projection": {"available": True,
                                                            "collapsed_sources": [],
                                                            "shrank_sources": []}},
                              {}, {}, None, None, block, None)
    concentrated = [a for a in alerts if a["id"].startswith("rag_composition_concentrated")]
    assert concentrated and "rule:noisy-one" in concentrated[0]["detail"]
    # ...and the durable baseline still carries shares only — no identity, hashed or not.
    stored = (await health.load()).get("composition") or []
    assert stored and all(
        set(entry) == {"at", "rows", "shares"} and "noisy-one" not in json.dumps(entry)
        for entry in stored
    )


@pytest.mark.asyncio
async def test_a_small_corpus_reports_unmeasured_rather_than_a_share() -> None:
    health = RagHealthStore(_MemKV())
    block = await _corpus_composition_block(
        _CompState(_CompRag([_row(source="", outcome="false_positive",
                                  verdict="false_positive")] * 5, health=health))
    )
    assert block["rows"] == 5
    assert block["shift"]["measured"] is False
    assert block["concentration"]["measured"] is False
    assert "below the" in block["shift"]["reason"]


@pytest.mark.asyncio
async def test_a_truncated_corpus_read_publishes_the_cross_tab_but_no_alarm() -> None:
    """A partial read is a biased sample: its shares must not become a shift."""
    health = RagHealthStore(_MemKV())
    block = await _corpus_composition_block(
        _CompState(_CompRag(_poisoned_corpus(), truncated=True, health=health))
    )
    assert block["truncated"] is True
    assert block["cells"]                      # the cross-tab is still useful
    assert block["shift"]["measured"] is False
    assert block["concentration"]["measured"] is False
    assert "scan ceiling" in block["shift"]["reason"]


@pytest.mark.asyncio
async def test_an_unreadable_corpus_is_unavailable_not_an_empty_composition() -> None:
    block = await _corpus_composition_block(_CompState(_CompRag([], fail=True)))
    assert block["available"] is False
    assert block["cells"] == []
    assert "could not be read" in block["reason"]

    _, unknowns = _build_alerts({"known": True, "starved": False, "status_reason": "",
                                 "reason": "", "projection": {"available": True,
                                                              "collapsed_sources": [],
                                                              "shrank_sources": []}},
                                {}, {}, None, None, block, None)
    assert any(u["id"] == "rag_composition_unknown" for u in unknowns)


@pytest.mark.asyncio
async def test_a_disabled_precedent_source_is_configured_not_unknown() -> None:
    state = _CompState(_CompRag([]))
    state.prefs.rag.use_resolved_cases = False
    block = await _corpus_composition_block(state)

    assert block["disabled"] is True
    assert block["available"] is False
    _, unknowns = _build_alerts({"known": True, "starved": False, "status_reason": "",
                                 "reason": "", "projection": {"available": True,
                                                              "collapsed_sources": [],
                                                              "shrank_sources": []}},
                                {}, {}, None, None, block, None)
    assert [u for u in unknowns if u["id"] == "rag_composition_unknown"] == []


@pytest.mark.asyncio
async def test_the_composition_baseline_is_bounded_and_only_grows_on_a_change() -> None:
    kv = _MemKV()
    store = RagHealthStore(kv)
    first = await store.observe_composition({"a": 1.0}, rows=100)
    assert first["previous"] is None and first["recorded"] is True

    repeat = await store.observe_composition({"a": 1.0}, rows=100)
    assert repeat["recorded"] is False               # unchanged -> no new row
    assert repeat["observations"] == 1

    changed = await store.observe_composition({"a": 0.4, "b": 0.6}, rows=100)
    assert changed["recorded"] is True
    assert changed["previous"]["shares"] == {"a": 1.0}

    for i in range(20):
        await store.observe_composition({"a": i / 100.0}, rows=100)
    doc = await store.load()
    assert len(doc["composition"]) <= 8           # bounded series
    # Never a corpus extract: shares and a row count only (#9).
    assert set(doc["composition"][0]) == {"at", "rows", "shares"}


# --------------------------------------------------------------------------- #
# Embedding space — what a reprojection strands
# --------------------------------------------------------------------------- #
class _SpaceRagCfg:
    enabled = True


class _SpacePrefs:
    def __init__(self, model="text-embedding-3-small") -> None:
        self._model = model
        self.rag = _SpaceRagCfg()

    def model_for(self, role):
        return ModelConfig(provider="openai", model=self._model)


class _SpaceState:
    def __init__(self, model="text-embedding-3-small") -> None:
        self.prefs = _SpacePrefs(model)


def _doc(did, *, source, model, chunks=3, dim=1536):
    return {"document_id": did, "source": source, "chunk_count": chunks,
            "embedding_model": model, "dim": dim}


def test_documents_left_in_a_superseded_embedding_space_are_counted() -> None:
    """An embedding-model change re-embeds the bounded window; everything outside it
    keeps being COUNTED as present while being unreachable by every query."""
    docs = [
        _doc("resolved_case:new-1", source="resolved_case", model="text-embedding-3-small"),
        _doc("resolved_case:old-1", source="resolved_case", model="legacy-embed", dim=384),
        _doc("resolved_case:old-2", source="resolved_case", model="legacy-embed", dim=384),
        _doc("seed:runbook", source="runbook", model="legacy-embed", dim=384, chunks=40),
    ]
    block = _embedding_space_block(_SpaceState(), True, "", docs)

    assert block["measured"] is True
    assert block["mixed_spaces"] is True
    assert block["stranded_documents"] == 3
    assert block["stranded_chunks"] == 3 + 3 + 40
    assert block["stranded_sources"] == ["resolved_case", "runbook"]
    assert block["spaces"]["legacy-embed"]["documents"] == 3

    alerts, _ = _build_alerts({"known": True, "starved": False, "status_reason": "",
                               "reason": "", "projection": {"available": True,
                                                            "collapsed_sources": [],
                                                            "shrank_sources": []}},
                              {}, {}, None, None, None, block)
    stranded = [a for a in alerts if a["id"] == "rag_embedding_space_stranded"]
    assert stranded and "never be retrieved again" in stranded[0]["detail"]


def test_a_single_space_corpus_proves_that_nothing_is_stranded() -> None:
    """The 'or prove none is' half: a positive, measured zero."""
    docs = [
        _doc("a", source="runbook", model="text-embedding-3-small"),
        _doc("b", source="resolved_case", model="text-embedding-3-small"),
    ]
    block = _embedding_space_block(_SpaceState(), True, "", docs)

    assert block["measured"] is True
    assert block["stranded_documents"] == 0
    assert block["mixed_spaces"] is False

    alerts, unknowns = _build_alerts({"known": True, "starved": False,
                                      "status_reason": "", "reason": "",
                                      "projection": {"available": True,
                                                     "collapsed_sources": [],
                                                     "shrank_sources": []}},
                                     {}, {}, None, None, None, block)
    assert [a for a in alerts if a["id"] == "rag_embedding_space_stranded"] == []
    assert [u for u in unknowns if u["id"] == "rag_embedding_space_unknown"] == []


def test_an_untagged_document_is_unattributed_not_stranded() -> None:
    """A chunk projected before the space tag existed proves nothing either way."""
    docs = [
        _doc("legacy", source="runbook", model=""),
        _doc("current", source="runbook", model="text-embedding-3-small"),
    ]
    block = _embedding_space_block(_SpaceState(), True, "", docs)
    assert block["unattributed_documents"] == 1
    assert block["stranded_documents"] == 0


def test_an_unreadable_corpus_reports_the_stranded_count_as_unknown() -> None:
    block = _embedding_space_block(_SpaceState(), False, "the vector store could not be read", [])
    assert block["available"] is False
    assert block["measured"] is False

    _, unknowns = _build_alerts({"known": True, "starved": False, "status_reason": "",
                                 "reason": "", "projection": {"available": True,
                                                              "collapsed_sources": [],
                                                              "shrank_sources": []}},
                                {}, {}, None, None, None, block)
    assert any(u["id"] == "rag_embedding_space_unknown" for u in unknowns)


# --------------------------------------------------------------------------- #
# #3 — none of this is ever allowed near the decision
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_composition_and_probe_never_touch_decide(monkeypatch) -> None:
    from app.engine import case_manager

    def _boom(*args, **kwargs):  # pragma: no cover - only runs on a regression
        raise AssertionError("advisory diagnostics must never call decide()")

    monkeypatch.setattr(case_manager, "decide", _boom)
    health = RagHealthStore(_MemKV())
    await _corpus_composition_block(_CompState(_CompRag(_poisoned_corpus(), health=health)))
    await probe_embedding_model(
        _Gateway(lambda texts: _Batch(_real_embedding(texts))), _CFG
    )


@pytest.mark.asyncio
async def test_an_empty_corpus_does_not_add_a_permanent_shift_unknown() -> None:
    """A fresh deployment already gets a starvation alert; "composition unknown" on
    top of it is noise about the same emptiness, so it is withheld below the floor."""
    health = RagHealthStore(_MemKV())
    block = await _corpus_composition_block(_CompState(_CompRag([], health=health)))
    assert block["available"] is True and block["rows"] == 0

    _, unknowns = _build_alerts({"known": True, "starved": True,
                                 "status_reason": "no precedent", "reason": "",
                                 "projection": {"available": True,
                                                "collapsed_sources": [],
                                                "shrank_sources": []}},
                                {}, {}, None, None, block, None)
    assert [u for u in unknowns if u["id"] == "rag_composition_shift_unknown"] == []


@pytest.mark.asyncio
async def test_the_diagnostics_endpoint_publishes_both_new_blocks() -> None:
    """End to end over the real AppState wiring, so the private read seams and the
    durable health record are exercised as they actually ship."""
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes_diagnostics import router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.state import AppState

    state = AppState(es=InMemoryESClient(), secrets=Secrets(_env_file=None))
    await state.startup()
    try:
        api = FastAPI()
        api.state.tlsoc = state
        api.include_router(router, dependencies=[Depends(require_auth)])
        payload = TestClient(api).get("/api/diagnostics/health").json()
    finally:
        await state.shutdown()

    composition = payload["corpus_composition"]
    assert composition["available"] is True
    assert "outcome_only_view" in composition and "cells" in composition
    space = payload["embedding_space"]
    assert space["measured"] is True
    # A corpus that has never been projected strands nothing — a measured zero, not a
    # silence.
    assert space["stranded_documents"] == 0
    assert space["configured_model"]


@pytest.mark.asyncio
async def test_a_corpus_below_the_floor_never_becomes_the_baseline() -> None:
    """Recording a share drawn from a handful of rows would manufacture a shift the
    moment the corpus grew past the floor. Nothing is recorded below it."""
    kv = _MemKV()
    health = RagHealthStore(kv)
    tiny = [_row(source="", outcome="false_positive", verdict="false_positive")] * 10
    await _corpus_composition_block(_CompState(_CompRag(tiny, health=health)))
    assert await health.load() == {}          # no observation was written

    grown = [
        _row(source="analyst_feedback", outcome="true_positive",
             verdict="true_positive", identity=f"rule:{i % 5}")
        for i in range(60)
    ]
    block = await _corpus_composition_block(_CompState(_CompRag(grown, health=health)))
    # First reading ABOVE the floor: a baseline is established, not a shift claimed.
    assert block["shift"]["measured"] is False
    assert block["shift"]["shifted"] is False
    assert "no previous composition reading" in block["shift"]["reason"]


def test_the_published_cell_cap_never_exceeds_the_persisted_baseline_cap() -> None:
    """A cell that is published but not persisted would read back as a movement from
    zero on the next pass — a shift manufactured by the cap, not by the corpus."""
    from app.api import routes_diagnostics
    from app.stores import rag_health

    assert (
        routes_diagnostics._MAX_COMPOSITION_CELLS
        <= rag_health._MAX_COMPOSITION_CELLS
    )


@pytest.mark.asyncio
async def test_the_corpus_is_read_once_per_ttl_not_once_per_block() -> None:
    """The ES vector store answers a whole-corpus read from one bounded page whose
    ``_source`` carries every stored EMBEDDING VECTOR. This endpoint is polled by the
    Overview health strip, so re-reading that per block per poll would make an
    observability surface a load source on the largest deployments."""
    from app.api import routes_diagnostics

    class _CountingRag(_CompRag):
        def __init__(self, rows) -> None:
            super().__init__(rows)
            self.metadata_reads = 0
            self.document_reads = 0

        async def _precedent_chunk_metadata(self):
            self.metadata_reads += 1
            return await super()._precedent_chunk_metadata()

        async def snapshot_documents_strict(self):
            self.document_reads += 1
            return await super().snapshot_documents_strict()

    rag = _CountingRag(_poisoned_corpus())
    state = _CompState(rag)
    for _ in range(4):
        await _corpus_composition_block(state)
        await routes_diagnostics._cached_corpus_documents(rag)

    assert rag.metadata_reads == 1
    assert rag.document_reads == 1

    # A DIFFERENT service (Demo Mode swap, or the next test) is never served this one's
    # corpus — the identity guard, not the TTL, decides that.
    other = _CountingRag([])
    await _corpus_composition_block(_CompState(other))
    assert other.metadata_reads == 1


def test_a_self_hosted_embedding_model_can_actually_BE_CONFIGURED(client) -> None:
    """The acceptance gate, end to end. The probe is worthless if the settings write
    still refuses whatever the bundled 23-row catalog has never heard of — which is
    every self-hosted / LiteLLM / vLLM / Ollama endpoint and every model newer than
    this build. Refuse only on POSITIVE evidence of incapability."""
    unknown = "bge-m3"
    assert capability_state(unknown, EMBEDDING_CAPABILITY) == "unknown"

    ok = client.put("/api/settings",
                    json={"embedding_model": {"provider": "openai", "model": unknown}})
    assert ok.status_code == 200, ok.text
    stored = client.get("/api/settings").json()["prefs"]["embedding_model"]["model"]
    assert stored == unknown

    # ...and the one refusal the catalog CAN back still stands: a bundled row that
    # declares other capabilities and not ``embedding``.
    declared_absent = next(
        (mid for mid in load_registry()
         if capability_state(mid, EMBEDDING_CAPABILITY) == "declared_absent"),
        "",
    )
    assert declared_absent, "the bundled catalog must contain at least one such row"
    refused = client.put(
        "/api/settings",
        json={"embedding_model": {"provider": "openai", "model": declared_absent}},
    )
    assert refused.status_code == 422
    detail = refused.json()["detail"]
    assert "WITHOUT the embedding capability" in detail
    # The refusal points at the empirical probe rather than dead-ending the operator.
    assert "/api/llm/models/test" in detail


def test_the_keyless_profile_is_not_reported_as_a_stranded_corpus() -> None:
    """A deployment with no embedding key runs the supported keyless/offline profile
    (Gate 2): the gateway degrades to local hash embeddings, so the corpus AND every
    query land in that same space and retrieval is entirely self-consistent. Comparing
    the producing model against the configured preference name raised a permanent
    ``critical`` on every default install — one whose stated remediation ("rebuild the
    corpus") re-produces the identical space, so no operator could ever clear it."""
    docs = [
        _doc("seed:runbook", source="runbook", model="mock-embed", dim=256, chunks=12),
        _doc("seed:mitre", source="mitre", model="mock-embed", dim=256, chunks=8),
    ]
    block = _embedding_space_block(_SpaceState(), True, "", docs)

    assert block["measured"] is True
    assert block["stranded_documents"] == 0
    assert block["stranded_chunks"] == 0
    assert block["fallback_documents"] == 2
    assert block["fallback_chunks"] == 20
    assert block["fallback_sources"] == ["mitre", "runbook"]

    alerts, unknowns = _build_alerts(
        {"known": True, "starved": False, "status_reason": "", "reason": "",
         "projection": {"available": True, "collapsed_sources": [], "shrank_sources": []}},
        {}, {}, None, None, None, block,
    )
    assert [a for a in alerts if a["id"] == "rag_embedding_space_stranded"] == []
    # Reported, because we cannot tell the keyless profile from a deployment that has
    # since configured a real provider — but reported as an UNKNOWN, not as a verdict.
    fallback = [u for u in unknowns if u["id"] == "rag_embedding_local_fallback"]
    assert fallback and "keyless profile" in fallback[0]["detail"]


def test_a_real_superseded_space_is_still_stranded_beside_the_fallback() -> None:
    """The carve-out is for the LOCAL HASH space only. A genuine model change still
    strands everything the reprojection left behind — the incident this block exists
    for — and the two populations are counted separately."""
    docs = [
        _doc("new", source="resolved_case", model="text-embedding-3-small"),
        _doc("old", source="resolved_case", model="legacy-embed", dim=384),
        _doc("degraded", source="runbook", model="mock-embed", dim=256),
    ]
    block = _embedding_space_block(_SpaceState(), True, "", docs)

    assert block["stranded_documents"] == 1
    assert block["stranded_sources"] == ["resolved_case"]
    assert block["fallback_documents"] == 1
    alerts, _ = _build_alerts(
        {"known": True, "starved": False, "status_reason": "", "reason": "",
         "projection": {"available": True, "collapsed_sources": [], "shrank_sources": []}},
        {}, {}, None, None, None, block,
    )
    assert [a["id"] for a in alerts if a["id"].startswith("rag_embedding")] == [
        "rag_embedding_space_stranded"
    ]


@pytest.mark.asyncio
async def test_a_default_install_raises_no_stranding_alert_after_seeding() -> None:
    """End to end on a real, default, keyless ``AppState``: seed the corpus exactly as
    the first retrieval does, then read the real endpoint. This is the reproduction the
    unit tests above could not see, because they never seeded a corpus."""
    from app.api.routes_diagnostics import diagnostics_health
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.state import AppState

    state = AppState(es=InMemoryESClient(), secrets=Secrets(_env_file=None))
    await state.rag_service.ensure_seeded()
    payload = await diagnostics_health(window_hours=24, state=state, _=None)

    space = payload["embedding_space"]
    assert space["measured"] is True
    assert space["stranded_documents"] == 0
    assert space["fallback_documents"] > 0
    assert [a for a in payload["alerts"] if a["id"] == "rag_embedding_space_stranded"] == []


def test_stranding_is_measured_but_not_alarmed_while_retrieval_is_off() -> None:
    """With retrieval disabled nothing is being retrieved anyway, so a stranded count
    is inherited state to report, not a defect to page an operator about."""
    docs = [
        _doc("a", source="resolved_case", model="legacy-embed", dim=384),
        _doc("b", source="resolved_case", model="text-embedding-3-small"),
    ]
    state = _SpaceState()
    state.prefs.rag.enabled = False
    block = _embedding_space_block(state, True, "", docs)

    assert block["stranded_documents"] == 1        # still measured and published
    assert block["rag_enabled"] is False
    alerts, _ = _build_alerts({"known": True, "starved": False, "status_reason": "",
                               "reason": "", "projection": {"available": True,
                                                            "collapsed_sources": [],
                                                            "shrank_sources": []}},
                              {}, {}, None, None, None, block)
    assert [a for a in alerts if a["id"] == "rag_embedding_space_stranded"] == []
