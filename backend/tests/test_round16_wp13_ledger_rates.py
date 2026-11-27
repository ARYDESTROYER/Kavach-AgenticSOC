"""Round 16 WP13 (SPEC §3.4, §4.5 WP13, [dv] R3): every ledger row carries its price.

The gateway writes, beside ``cost``, the four undiscounted per-million rates
``pricing.cost_for`` resolved for the call, the cache-write TTL and the
``price_basis``. The stored cost then re-derives exactly with

    round((prompt * in + completion * out + cache_read * read + cache_write * write)
          / 1e6 * (0.5 if batch else 1), 8)

for a plain, a cached, a Batch and a Flex call and for every ``price_basis``. Still one
row per call (#6), and ``cost_for`` itself is unchanged.
"""

from __future__ import annotations

import itertools

import pytest

from app.config import ModelConfig
from app.constants import USAGE_READ_PATTERN, Role, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm import pricing
from app.llm.gateway import LLMGateway
from app.llm.providers import BaseProvider, CompletionResult, MockProvider
from app.models import USAGE_PRICE_BASES, UsageDoc
from app.stores.usage import UsageStore


class _Secrets:
    anthropic_api_key = None
    openai_api_key = None
    embedding_api_key = None

    def embedding_key(self):
        return None


class _Provider(BaseProvider):
    """Answers every call with the token counts and tier it was built with."""

    def __init__(self, **fields) -> None:
        self.fields = fields

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", model=model, **self.fields)


class _Overlay:
    def __init__(self, prices: dict[str, tuple[float, float]]) -> None:
        self.prices = prices

    async def as_price_tuple(self, model):  # noqa: ANN001
        return self.prices.get(model)


class _CustomModels:
    def __init__(self, ids: set[str]) -> None:
        self.ids = ids

    async def get_model(self, model):  # noqa: ANN001
        return {"id": model} if model in self.ids else None

    async def base_url_for(self, model):  # noqa: ANN001
        return None


def recompute(row: dict) -> float:
    """The SPEC §4.5 WP13 formula over a stored row's own numbers."""
    factor = 0.5 if row["batch"] else 1.0
    return round(
        (row["prompt_tokens"] * row["input_rate_per_million"]
         + row["completion_tokens"] * row["output_rate_per_million"]
         + row["cache_read_tokens"] * row["cache_read_rate_per_million"]
         + row["cache_write_tokens"] * row["cache_write_rate_per_million"])
        / 1e6 * factor,
        8,
    )


async def _rows(es: InMemoryESClient) -> list[dict]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


async def _one_call(model: str, *, demo: bool = False, overlay=None, custom=None,
                    **fields) -> dict:
    es = InMemoryESClient()
    gw = LLMGateway(
        secrets=_Secrets(), usage_store=UsageStore(es),
        provider_overrides={"mock": _Provider(**fields) if fields else MockProvider()},
        demo=demo, price_overlay=overlay, custom_models=custom,
    )
    result = await gw.complete(
        Role.INVESTIGATOR, [{"role": "user", "content": "x"}],
        ModelConfig(provider="mock", model=model), surface="investigate", case_id="case-1",
    )
    rows = await _rows(es)
    assert len(rows) == 1  # #6: still exactly one row per call
    assert rows[0]["cost"] == result.cost
    return rows[0]


@pytest.mark.parametrize(
    ("label", "model", "fields"),
    [
        ("plain", "claude-sonnet-4-6", {"prompt_tokens": 1240, "completion_tokens": 310}),
        ("cached", "claude-sonnet-4-6", {"prompt_tokens": 1000, "completion_tokens": 200,
                                         "cache_read_tokens": 5000, "cache_write_tokens": 2000}),
        ("batch", "claude-haiku-4-5", {"prompt_tokens": 3000, "completion_tokens": 1000,
                                       "cache_read_tokens": 700, "batch": True,
                                       "processing_tier": "batch"}),
        ("flex", "gpt-5", {"prompt_tokens": 4321, "completion_tokens": 987,
                           "cache_read_tokens": 1200, "processing_tier": "flex"}),
    ],
)
async def test_the_stored_rates_re_derive_the_stored_cost(label, model, fields) -> None:
    row = await _one_call(model, **fields)
    assert row["price_basis"] == "catalog"
    assert row["cache_write_ttl"] == "5m"
    assert row["cost"] > 0, label
    assert recompute(row) == row["cost"], label
    # The rates are the undiscounted ones cost_for resolved: a Batch row keeps its
    # catalog input rate and its own flag applies the half.
    in_rate, out_rate = pricing.resolve_price(model)
    assert (row["input_rate_per_million"], row["output_rate_per_million"]) == (in_rate, out_rate)
    read, write_5m, _ = pricing.cache_rates(model, in_rate)
    assert row["cache_read_rate_per_million"] == read
    assert row["cache_write_rate_per_million"] == write_5m
    # Flex is recorded only: cost_for applies no Flex factor today.
    assert row["processing_tier"] == fields.get("processing_tier", "standard")
    assert row["batch"] is bool(fields.get("batch", False))


async def test_an_overlay_row_says_overlay_and_carries_the_overlay_rates() -> None:
    row = await _one_call("gpt-4o", overlay=_Overlay({"gpt-4o": (2.0, 6.0)}),
                          prompt_tokens=1500, completion_tokens=250, cache_read_tokens=900)
    assert row["price_basis"] == "overlay"
    assert row["pricing_source"] == "exact"
    assert (row["input_rate_per_million"], row["output_rate_per_million"]) == (2.0, 6.0)
    assert row["cache_read_rate_per_million"] == pytest.approx(0.2)
    assert recompute(row) == row["cost"]


async def test_a_custom_model_row_is_free_and_says_custom() -> None:
    row = await _one_call("local-llama-3", custom=_CustomModels({"local-llama-3"}),
                          prompt_tokens=2000, completion_tokens=400)
    assert row["price_basis"] == "custom"
    assert row["cost"] == 0.0 and recompute(row) == 0.0
    assert row["input_rate_per_million"] == 0.0 and row["output_rate_per_million"] == 0.0


async def test_an_overlay_wins_over_a_custom_registration() -> None:
    row = await _one_call("local-llama-3", overlay=_Overlay({"local-llama-3": (0.5, 1.0)}),
                          custom=_CustomModels({"local-llama-3"}),
                          prompt_tokens=2000, completion_tokens=400)
    assert row["price_basis"] == "overlay"
    assert recompute(row) == row["cost"] == pytest.approx(0.0014)


async def test_the_mock_provider_row_says_mock_with_zero_rates() -> None:
    row = await _one_call("mock")
    assert row["price_basis"] == "mock"
    assert row["pricing_source"] == "zero"
    assert row["cost"] == 0.0 == recompute(row)
    assert {row[k] for k in ("input_rate_per_million", "output_rate_per_million",
                             "cache_read_rate_per_million", "cache_write_rate_per_million")} == {0.0}


async def test_a_demo_row_records_the_synthetic_rates_it_was_charged() -> None:
    row = await _one_call("claude-sonnet-4-6", demo=True, prompt_tokens=1200,
                          completion_tokens=300, cache_read_tokens=400)
    assert row["price_basis"] == "demo_simulated"
    assert row["pricing_source"] == "zero"
    assert (row["input_rate_per_million"], row["output_rate_per_million"]) == (3.0, 15.0)
    # The synthetic cost ignores the cache, so its recorded cache rates are zero.
    assert row["cache_read_rate_per_million"] == 0.0
    assert row["cost"] > 0 and recompute(row) == row["cost"]


async def test_every_basis_the_gateway_writes_is_in_the_vocabulary() -> None:
    rows = [
        await _one_call("claude-sonnet-4-6", prompt_tokens=10, completion_tokens=5),
        await _one_call("gpt-4o", overlay=_Overlay({"gpt-4o": (1.0, 2.0)}),
                        prompt_tokens=10, completion_tokens=5),
        await _one_call("m-1", custom=_CustomModels({"m-1"}), prompt_tokens=10, completion_tokens=5),
        await _one_call("mock"),
        await _one_call("mock", demo=True),
    ]
    assert sorted(r["price_basis"] for r in rows) == sorted(USAGE_PRICE_BASES)


async def test_error_and_batch_fold_rows_carry_rates_too() -> None:
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_Secrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": MockProvider()})
    # The Batch fold path: no cost passed, so _record prices it itself at 0.5.
    await gw._record("investigator", "investigate", "case-1", "claude-sonnet-4-6",
                     8000, 900, 0, UsageOutcome.OK, None, cache_read_tokens=300, batch=True)
    # An abandoned call: estimated tokens, cost priced in _record.
    await gw._record("chat", "chat", "case-1", "gpt-4o", 640, 12, 50, UsageOutcome.ERROR,
                     usage_estimated=True)
    rows = await _rows(es)
    assert len(rows) == 2
    for row in rows:
        assert row["price_basis"] == "catalog"
        assert recompute(row) == row["cost"] > 0


async def test_an_embedding_row_carries_rates() -> None:
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_Secrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": MockProvider()})
    await gw.embed(["alpha", "beta"], ModelConfig(provider="mock", model="mock-embed"))
    rows = await _rows(es)
    assert rows and all(r["price_basis"] == "mock" and recompute(r) == r["cost"] for r in rows)


def test_rates_for_matches_cost_for_over_a_grid() -> None:
    """``rates_for`` names exactly the rates ``cost_for`` bills: the formula over them
    equals ``cost_for`` for every model kind, overlay, cache mix, TTL and Batch flag.

    The two forms add the same terms in a different order before rounding to 8 places,
    so a value that lies on a half-way point of the 8th decimal can round one unit
    apart (``cost_for`` is not changed, SPEC §4.5 WP13); everywhere else they agree to
    the last digit."""
    exact = total = 0
    models = ["claude-sonnet-4-6", "claude-opus-4-8", "gpt-5", "gpt-4o-mini",
              "claude-opus-9-preview", "unknown-model-x", "mock"]
    overlays = [None, (2.5, 7.5)]
    tokens = [(0, 0, 0, 0), (1240, 310, 0, 0), (999, 1, 12345, 0), (7, 3, 0, 4096),
              (123457, 65432, 98765, 4321)]
    for model, overlay, (p, c, cr, cw), ttl, batch in itertools.product(
        models, overlays, tokens, ("5m", "1h"), (False, True),
    ):
        rates = pricing.rates_for(model, overlay, cache_write_ttl=ttl)
        expected = pricing.cost_for(model, p, c, overlay, cache_read_tokens=cr,
                                    cache_write_tokens=cw, cache_write_ttl=ttl, batch=batch)
        derived = recompute({
            "prompt_tokens": p, "completion_tokens": c, "cache_read_tokens": cr,
            "cache_write_tokens": cw, "batch": batch,
            "input_rate_per_million": rates.input_per_million,
            "output_rate_per_million": rates.output_per_million,
            "cache_read_rate_per_million": rates.cache_read_per_million,
            "cache_write_rate_per_million": rates.cache_write_per_million,
        })
        assert abs(derived - expected) <= 1.000001e-8, (model, overlay, p, c, cr, cw, ttl, batch)
        assert rates.cache_write_ttl == ttl
        total += 1
        exact += derived == expected
    assert exact >= 0.9 * total


def test_an_old_row_reads_rate_not_recorded() -> None:
    old = UsageDoc.model_validate({"role": "router", "model": "gpt-4o", "cost": 0.01})
    assert old.price_basis is None and old.input_rate_per_million is None
    assert "price_basis" not in old.model_dump(mode="json")
