"""Demo Mode on and off never undo a real settings save that raced them (Round 14).

Turning Demo Mode on builds and seeds a whole Demo stack before it commits; turning it
off tears that stack down first. A real settings save that lands in between (and has
already been audited) must survive: the Demo switch is written onto the LIVE settings
read inside the write lock (``AppState.mutate_prefs``), never onto a copy taken before
the slow part began.
"""

from __future__ import annotations

from typing import Any

from app.config import Secrets
from app.engine.demo_runtime import DemoStack
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState


def _state() -> AppState:
    mock = MockProvider()
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    return AppState.create(secrets=secrets, es=InMemoryESClient(),
                           provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})


async def _save_budget(state: AppState, daily_usd: float) -> None:
    budget = state.prefs.budget.model_copy(update={"daily_usd": daily_usd})
    await state.update_prefs(state.prefs.model_copy(update={"budget": budget}))


async def test_enabling_demo_keeps_a_settings_save_made_while_the_stack_seeds(monkeypatch) -> None:
    state = _state()
    await state.startup(start_poller=False)
    try:
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        original = DemoStack.run_capability_pass

        async def _racing_pass(self: Any) -> None:
            await _save_budget(state, 42.0)  # an operator saves Settings meanwhile
            await original(self)

        monkeypatch.setattr(DemoStack, "run_capability_pass", _racing_pass)
        await state.enable_demo(mode="seeded", seed=1337, history_days=1)
        assert state.prefs.demo.active is True
        assert state.prefs.budget.daily_usd == 42.0
        stored = await state.config_store.load()
        assert stored.demo.active is True and stored.budget.daily_usd == 42.0
    finally:
        await state.shutdown()


async def test_disabling_demo_keeps_a_settings_save_made_while_the_stack_is_torn_down(monkeypatch) -> None:
    state = _state()
    await state.startup(start_poller=False)
    try:
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await state.enable_demo(mode="seeded", seed=1337, history_days=1)
        original = DemoStack.purge

        async def _racing_purge(self: Any) -> None:
            await _save_budget(state, 7.0)
            await original(self)

        monkeypatch.setattr(DemoStack, "purge", _racing_purge)
        await state.disable_demo()
        assert state.prefs.demo.active is False
        assert state.prefs.budget.daily_usd == 7.0
        stored = await state.config_store.load()
        assert stored.demo.active is False and stored.budget.daily_usd == 7.0
    finally:
        await state.shutdown()
