"""Round 12 (SPEC D1, D5, D6): ``ChatAgentConfig.limits_mode`` and the one-time
``chat_limits_version`` migration.

A stored chat configuration becomes ``unlimited`` unless an operator explicitly
changed a limit knob away from its shipped default (then it stays ``bounded`` with
their values). The repair still never rejects a stored block: one bad value must not
reset the rest of ``Preferences``."""

from __future__ import annotations

from typing import Any

import pytest

from app.config import (
    CHAT_AGENT_BOUNDS,
    CURRENT_CHAT_LIMITS_VERSION,
    ChatAgentConfig,
    Preferences,
)


def _stored(**chat_agent: Any) -> dict[str, Any]:
    """A pre-Round-12 persisted Preferences document: a full dump whose chat block has
    the OLD shipped defaults and no Round 12 keys, with ``chat_agent`` overrides."""
    doc = Preferences().model_dump(mode="json")
    block = doc["chat_agent"]
    for key in ("limits_mode", "chat_daily_cap_usd", "animated_brand", "chat_limits_version"):
        block.pop(key, None)
    block.update({"model_step_timeout_s": 30, "max_concurrent_turns_per_user": 2,
                  "max_concurrent_turns_global": 8})
    block.update(chat_agent)
    doc["auto_close"]["false_positive"]["min_confidence"] = 0.97
    return doc


def test_fresh_defaults_are_unlimited_with_the_round12_knobs() -> None:
    cfg = ChatAgentConfig()
    assert cfg.limits_mode == "unlimited" and cfg.unlimited
    assert cfg.chat_daily_cap_usd is None and cfg.animated_brand is True
    assert (cfg.max_concurrent_turns_per_user, cfg.max_concurrent_turns_global) == (4, 16)
    assert cfg.model_step_timeout_s == 300 and CHAT_AGENT_BOUNDS["model_step_timeout_s"] == (5, 900)
    assert cfg.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION


def test_a_stored_default_configuration_becomes_unlimited() -> None:
    prefs = Preferences.model_validate(_stored())
    agent = prefs.chat_agent
    assert agent.limits_mode == "unlimited"
    # Old defaults are defaults, not choices: they move to the new ones.
    assert agent.model_step_timeout_s == 300
    assert (agent.max_concurrent_turns_per_user, agent.max_concurrent_turns_global) == (4, 16)
    assert agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION
    assert prefs.auto_close.false_positive.min_confidence == 0.97      # the rest is intact


def test_an_explicit_limit_keeps_bounded_mode_and_its_values() -> None:
    prefs = Preferences.model_validate(_stored(max_tool_calls=25))
    agent = prefs.chat_agent
    assert agent.limits_mode == "bounded" and agent.max_tool_calls == 25
    assert agent.model_step_timeout_s == 30          # bounded keeps today's behaviour exactly
    assert (agent.max_concurrent_turns_per_user, agent.max_concurrent_turns_global) == (4, 16)


@pytest.mark.parametrize("knob,value", [
    ("max_model_calls", 8), ("turn_timeout_s", 300), ("turn_token_ceiling", 200_000),
    ("final_max_tokens", 8_000), ("observation_chars", 12_000), ("final_reserve_tokens", 20_000),
])
def test_every_limit_knob_counts_as_an_explicit_choice(knob: str, value: int) -> None:
    assert Preferences.model_validate(_stored(**{knob: value})).chat_agent.limits_mode == "bounded"


def test_non_limit_knobs_do_not_make_a_configuration_bounded() -> None:
    agent = Preferences.model_validate(_stored(
        max_parallel=8, tool_timeout_s=60, max_indicator_lookups=0, allow_text_streaming=False,
        internal_domains=["corp.example"], model_step_timeout_s=120,
    )).chat_agent
    assert agent.limits_mode == "unlimited" and agent.model_step_timeout_s == 120   # a chosen value stays


def test_the_migration_runs_once() -> None:
    migrated = Preferences.model_validate(_stored()).model_dump(mode="json")
    # An operator later chooses bounded with the default knobs: never re-decided.
    migrated["chat_agent"]["limits_mode"] = "bounded"
    again = Preferences.model_validate(migrated).chat_agent
    assert again.limits_mode == "bounded" and again.model_step_timeout_s == 300
    # And a stored concurrency of 2 chosen AFTER the migration is kept.
    migrated["chat_agent"]["max_concurrent_turns_per_user"] = 2
    assert Preferences.model_validate(migrated).chat_agent.max_concurrent_turns_per_user == 2


def test_an_explicit_mode_without_a_marker_is_respected() -> None:
    assert Preferences.model_validate(_stored(limits_mode="bounded")).chat_agent.limits_mode == "bounded"
    assert Preferences.model_validate(
        _stored(limits_mode="unlimited", max_tool_calls=25)).chat_agent.limits_mode == "unlimited"


def test_programmatic_constructions() -> None:
    assert ChatAgentConfig(max_tool_calls=2).limits_mode == "bounded"          # a cap means bounded
    assert ChatAgentConfig(allow_text_streaming=False).limits_mode == "unlimited"
    assert ChatAgentConfig(model_step_timeout_s=30).model_step_timeout_s == 30   # not a persisted block
    assert ChatAgentConfig(limits_mode=" BOUNDED ").limits_mode == "bounded"


@pytest.mark.parametrize("raw,expected", [
    (None, None), (0, None), (-5, None), ("nan", None), (float("inf"), None), ("abc", None),
    (True, None), ("2.5", 2.5), (10, 10.0),
])
def test_the_chat_cap_is_repaired_never_rejected(raw: Any, expected: float | None) -> None:
    assert ChatAgentConfig.model_validate({"chat_daily_cap_usd": raw}).chat_daily_cap_usd == expected


@pytest.mark.parametrize("raw,expected", [("off", False), (0, False), ("yes", True), ([], True), (False, False)])
def test_animated_brand_is_repaired(raw: Any, expected: bool) -> None:
    assert ChatAgentConfig.model_validate({"animated_brand": raw}).animated_brand is expected


@pytest.mark.parametrize("stored", [
    {"limits_mode": 7, "chat_limits_version": "x", "model_step_timeout_s": 10_000},
    {"limits_mode": "sometimes", "chat_daily_cap_usd": {"a": 1}},
    {"chat_limits_version": 99, "limits_mode": None},
])
def test_malformed_round12_values_never_reset_preferences(stored: dict[str, Any]) -> None:
    doc = _stored(**stored)
    prefs = Preferences.model_validate(doc)
    assert prefs.auto_close.false_positive.min_confidence == 0.97
    agent = prefs.chat_agent
    assert agent.limits_mode in ("unlimited", "bounded")
    for name, (lo, hi) in CHAT_AGENT_BOUNDS.items():
        assert lo <= getattr(agent, name) <= hi, name


async def test_the_config_store_migrates_a_stored_document() -> None:
    from app.constants import CONFIG_DOC_ID, CONFIG_INDEX
    from app.es.fake import InMemoryESClient
    from app.stores.config_store import ConfigStore

    es = InMemoryESClient()
    await es.index_doc(CONFIG_INDEX, _stored(), doc_id=CONFIG_DOC_ID)
    prefs = await ConfigStore(es).load()
    assert prefs.chat_agent.limits_mode == "unlimited"
    assert prefs.auto_close.false_positive.min_confidence == 0.97
