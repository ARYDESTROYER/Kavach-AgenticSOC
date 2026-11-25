"""Round 16 WP13 review: two defects found after the package was built.

* A self-hosted model registered through ``POST /api/llm/models/custom`` also gets a $0
  price overlay row (``routes_models.add_custom_model``), so the gateway's price lookup
  found the overlay first and every call to a registered local model was stamped
  ``price_basis="overlay"`` (an operator price override) instead of ``"custom"``. Only a
  registration whose overlay write was lost read ``custom``. A non-zero overlay an
  operator set on a registered model is still an override and still reads ``overlay``.
* ``GET /api/cases/{case_id}/events`` accepted any cursor that ``str.isdigit`` calls a
  digit, so a superscript two (``"²"``) reached ``int()`` and failed with a 500, and an
  Arabic-Indic digit was read as an offset. A cursor longer than nine characters was a
  422 from the query validator, not the route's own 400. Every cursor the route never
  returned is now one 400 ``case_events_bad_cursor``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import ModelConfig
from app.constants import USAGE_READ_PATTERN, Role, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import BaseProvider, CompletionResult
from app.stores.usage import UsageStore
from tests.test_round16_wp13_case_records import _app, _case, _save, _state


# --------------------------------------------------------------------------- #
# price_basis of a registered self-hosted model
# --------------------------------------------------------------------------- #
class _Secrets:
    anthropic_api_key = None
    openai_api_key = None
    embedding_api_key = None

    def embedding_key(self):
        return None


class _Provider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", model=model, prompt_tokens=2000, completion_tokens=400)


class _Overlay:
    def __init__(self, prices: dict[str, tuple[float, float]]) -> None:
        self.prices = prices

    async def as_price_tuple(self, model):
        return self.prices.get(model)


class _CustomModels:
    def __init__(self, ids: set[str]) -> None:
        self.ids = ids

    async def get_model(self, model):
        return {"id": model} if model in self.ids else None

    async def base_url_for(self, model):
        return None


async def _row(model: str, *, overlay: _Overlay, custom: _CustomModels) -> dict:
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_Secrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": _Provider()},
                    price_overlay=overlay, custom_models=custom)
    await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "x"}],
                      ModelConfig(provider="mock", model=model), surface="investigate",
                      case_id="case-1")
    resp = await es.search(USAGE_READ_PATTERN, {"size": 10, "query": {"match_all": {}}})
    rows = [h["_source"] for h in resp["hits"]["hits"]]
    assert len(rows) == 1
    return rows[0]


async def test_a_registered_model_with_its_zero_overlay_says_custom() -> None:
    # The registration writes both: the custom-model row and a $0 overlay row.
    row = await _row("local-llama-3", overlay=_Overlay({"local-llama-3": (0.0, 0.0)}),
                     custom=_CustomModels({"local-llama-3"}))
    assert row["price_basis"] == "custom"
    assert row["pricing_source"] == "exact"
    assert row["cost"] == 0.0
    assert row["input_rate_per_million"] == 0.0 and row["output_rate_per_million"] == 0.0


async def test_a_zero_overlay_on_a_catalog_model_is_still_an_overlay() -> None:
    row = await _row("gpt-4o", overlay=_Overlay({"gpt-4o": (0.0, 0.0)}),
                     custom=_CustomModels(set()))
    assert row["price_basis"] == "overlay" and row["cost"] == 0.0


async def test_a_priced_overlay_on_a_registered_model_is_still_an_overlay() -> None:
    row = await _row("local-llama-3", overlay=_Overlay({"local-llama-3": (0.5, 1.0)}),
                     custom=_CustomModels({"local-llama-3"}))
    assert row["price_basis"] == "overlay"
    assert row["cost"] == pytest.approx(0.0014)


def test_a_model_registered_through_the_route_is_stamped_custom() -> None:
    """End to end: the real registration route, the real overlay and custom-model
    stores, and the one ledger row the gateway writes for a call to that model."""
    from app.api.routes_models import router as models_router

    api = _app()
    api.include_router(models_router)
    with TestClient(api) as client:
        state = _state(client)
        added = client.post("/api/llm/models/custom", json={
            "model_id": "local-qwen", "base_url": "http://localhost:4000/v1", "label": "Local",
        })
        assert added.status_code == 200, added.text
        # The registration also wrote its $0 overlay row (the belt and braces).
        assert client.portal.call(state.price_overlay.as_price_tuple, "local-qwen") == (0.0, 0.0)

        async def _call() -> None:
            await state.gateway._record("investigator", "investigate", "case-cm-1", "local-qwen",
                                        1500, 300, 0, UsageOutcome.OK, None)

        client.portal.call(_call)
        rows = client.portal.call(lambda: state.usage_store.records_for_case("case-cm-1"))
        assert [r["price_basis"] for r in rows] == ["custom"]
        assert rows[0]["cost"] == 0.0 and rows[0]["input_rate_per_million"] == 0.0


# --------------------------------------------------------------------------- #
# The events cursor
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("cursor", ["²", "٣", "1234567890", "-1", "+1", " 1", "1.0", "abc"])
def test_a_cursor_the_route_never_returned_is_a_400(cursor: str) -> None:
    with TestClient(_app()) as client:
        _save(client, _case(member_event_ids=["a", "b", "c", "d"]))
        r = client.get("/api/cases/case-ev-1/events", params={"cursor": cursor})
        assert r.status_code == 400, (cursor, r.status_code)
        assert r.json()["detail"]["code"] == "case_events_bad_cursor"


def test_every_cursor_the_route_returns_is_accepted() -> None:
    with TestClient(_app()) as client:
        _save(client, _case(member_event_ids=[f"e{i}" for i in range(5)]))
        cursor, seen = None, 0
        while True:
            params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
            r = client.get("/api/cases/case-ev-1/events", params=params)
            assert r.status_code == 200, r.text
            seen += 1
            cursor = r.json()["next_cursor"]
            if cursor is None:
                break
        assert seen == 3
        assert client.get("/api/cases/case-ev-1/events", params={"cursor": "000000004"}).status_code == 200
