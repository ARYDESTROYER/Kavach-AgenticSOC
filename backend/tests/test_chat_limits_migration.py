"""``ChatAgentConfig.limits_mode`` and the staged ``chat_limits_version`` migration.

Version 1 (Round 12 SPEC D1, D5, D6): a stored chat configuration becomes ``unlimited``
unless an operator explicitly changed a limit knob away from its shipped default (then
it stays ``bounded`` with their values), and the stall timeout and concurrency defaults
rise.

Version 2 (Round 14 SPEC §4.2, ask 5): the five "Timeouts and capacity" defaults are
tripled. A persisted value that still equals the Round 12 default moves to the tripled
one, in both limits modes (D18); any other value is an administrator's choice and stays.
A block from before Round 12 chains through both steps; a value it chose under its own
release's defaults stays, even when it equals a Round 12 default.

The repair still never rejects a stored block: one bad value must not reset the rest of
``Preferences``."""

from __future__ import annotations

from typing import Any

import pytest

from app.config import (
    _CHAT_TRIPLED_DEFAULTS,
    CHAT_AGENT_BOUNDS,
    CURRENT_CHAT_LIMITS_VERSION,
    ChatAgentConfig,
    Preferences,
    _migrate_chat_limits,
)

# The Round 14 table (SPEC §4.2.1): key -> (default before, default after, bounds after).
TRIPLED: dict[str, tuple[int, int, tuple[int, int]]] = {
    "max_parallel": (4, 12, (1, 24)),
    "tool_timeout_s": (15, 45, (1, 120)),
    "model_step_timeout_s": (300, 900, (5, 1_800)),
    "max_concurrent_turns_per_user": (4, 12, (1, 24)),
    "max_concurrent_turns_global": (16, 48, (1, 100)),
}
ROUND12_DEFAULTS = {name: old for name, (old, _new, _bounds) in TRIPLED.items()}
ROUND14_DEFAULTS = {name: new for name, (_old, new, _bounds) in TRIPLED.items()}
# A value for each knob that is inside every release's bounds and equals no default.
CHOSEN = {
    "max_parallel": 6,
    "tool_timeout_s": 20,
    "model_step_timeout_s": 600,
    "max_concurrent_turns_per_user": 3,
    "max_concurrent_turns_global": 20,
}


def _capacity(agent: ChatAgentConfig) -> dict[str, int]:
    return {name: getattr(agent, name) for name in TRIPLED}


def _stored(**chat_agent: Any) -> dict[str, Any]:
    """A pre-Round-12 persisted Preferences document: a full dump whose chat block has
    the shipped defaults of that time (no marker, no Round 12 or 13 keys), with
    ``chat_agent`` overrides."""
    doc = Preferences().model_dump(mode="json")
    block = doc["chat_agent"]
    for key in ("limits_mode", "chat_daily_cap_usd", "animated_brand", "dynamic_starters",
                "chat_limits_version"):
        block.pop(key, None)
    block.update({"max_parallel": 4, "tool_timeout_s": 15, "model_step_timeout_s": 30,
                  "max_concurrent_turns_per_user": 2, "max_concurrent_turns_global": 8})
    block.update(chat_agent)
    doc["auto_close"]["false_positive"]["min_confidence"] = 0.97
    return doc


def _stored_round12(**chat_agent: Any) -> dict[str, Any]:
    """A Round 12 or 13 persisted Preferences document: the chat block at version 1
    with the Round 12 defaults (4 / 15 s / 300 s / 4 / 16), with ``chat_agent``
    overrides."""
    doc = Preferences().model_dump(mode="json")
    block = doc["chat_agent"]
    block.update(ROUND12_DEFAULTS)
    block.update({"limits_mode": "unlimited", "chat_limits_version": 1})
    block.update(chat_agent)
    doc["auto_close"]["false_positive"]["min_confidence"] = 0.97
    return doc


# --------------------------------------------------------------------------- #
# Fresh defaults and bounds (SPEC §4.2.1).
# --------------------------------------------------------------------------- #
def test_fresh_defaults_are_unlimited_with_the_tripled_capacity() -> None:
    cfg = ChatAgentConfig()
    assert cfg.limits_mode == "unlimited" and cfg.unlimited
    assert cfg.chat_daily_cap_usd is None and cfg.animated_brand is True
    assert _capacity(cfg) == ROUND14_DEFAULTS
    assert cfg.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION == 2
    assert Preferences().chat_agent.model_dump() == cfg.model_dump()


@pytest.mark.parametrize("name", sorted(TRIPLED))
def test_each_capacity_knob_has_the_round14_default_and_bounds(name: str) -> None:
    old, new, bounds = TRIPLED[name]
    assert new == 3 * old                                         # the operator's ask: triple
    assert ChatAgentConfig.model_fields[name].default == new
    assert CHAT_AGENT_BOUNDS[name] == bounds
    lo, hi = bounds
    assert lo <= old <= hi and lo <= new <= hi                     # a stored old value never clamps


def test_the_migration_table_is_the_spec_table() -> None:
    assert _CHAT_TRIPLED_DEFAULTS == {name: (old, new) for name, (old, new, _b) in TRIPLED.items()}


def test_the_marker_bound_follows_the_current_version() -> None:
    assert CHAT_AGENT_BOUNDS["chat_limits_version"] == (0, CURRENT_CHAT_LIMITS_VERSION)
    # A marker from a later release is clamped, never rejected, and never re-decided.
    agent = Preferences.model_validate(_stored_round12(chat_limits_version=7)).chat_agent
    assert agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION
    assert _capacity(agent) == ROUND12_DEFAULTS


# --------------------------------------------------------------------------- #
# Version 2: a Round 12 or 13 block (SPEC §4.2.2).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("mode", ["unlimited", "bounded"])
def test_a_round12_block_at_the_old_defaults_moves_to_the_tripled_values(mode: str) -> None:
    prefs = Preferences.model_validate(_stored_round12(limits_mode=mode))
    agent = prefs.chat_agent
    # D18: the model call timeout moves in Bounded mode too.
    assert _capacity(agent) == ROUND14_DEFAULTS
    assert agent.limits_mode == mode                               # never re-decided
    assert agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION
    assert prefs.auto_close.false_positive.min_confidence == 0.97  # the rest is intact


@pytest.mark.parametrize("mode", ["unlimited", "bounded"])
@pytest.mark.parametrize("name", sorted(TRIPLED))
def test_a_changed_value_stays_and_the_rest_move(name: str, mode: str) -> None:
    agent = Preferences.model_validate(
        _stored_round12(limits_mode=mode, **{name: CHOSEN[name]})).chat_agent
    expected = dict(ROUND14_DEFAULTS, **{name: CHOSEN[name]})
    assert _capacity(agent) == expected


def test_every_changed_value_stays() -> None:
    agent = Preferences.model_validate(_stored_round12(**CHOSEN)).chat_agent
    assert _capacity(agent) == CHOSEN
    assert agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION


def test_a_bounded_block_that_kept_30_seconds_stays_at_30() -> None:
    agent = Preferences.model_validate(
        _stored_round12(limits_mode="bounded", max_tool_calls=25, model_step_timeout_s=30)).chat_agent
    assert agent.limits_mode == "bounded" and agent.max_tool_calls == 25
    assert agent.model_step_timeout_s == 30                        # 30 is not the old default
    assert agent.max_concurrent_turns_per_user == 12 and agent.max_concurrent_turns_global == 48


def test_the_migration_never_touches_the_per_question_knobs() -> None:
    stored = _stored_round12(limits_mode="bounded", max_tool_calls=25, turn_timeout_s=300)
    agent = Preferences.model_validate(stored).chat_agent
    assert (agent.max_tool_calls, agent.turn_timeout_s, agent.max_model_calls) == (25, 300, 5)
    # Bounded: lookups at once is still capped by the per-question lookup budget at use.
    assert agent.max_parallel == 12 and agent.effective_parallel == 12
    default_bounded = Preferences.model_validate(_stored_round12(limits_mode="bounded")).chat_agent
    assert default_bounded.effective_parallel == 10                 # min(12, max_tool_calls 10)


def test_a_stored_version2_block_is_never_re_decided() -> None:
    """An administrator who chose the Round 12 values after the migration keeps them."""
    migrated = Preferences.model_validate(_stored_round12()).model_dump(mode="json")
    assert migrated["chat_agent"]["chat_limits_version"] == 2
    migrated["chat_agent"].update(ROUND12_DEFAULTS)
    agent = Preferences.model_validate(migrated).chat_agent
    assert _capacity(agent) == ROUND12_DEFAULTS


def test_running_the_migration_twice_is_a_no_op() -> None:
    once = Preferences.model_validate(_stored_round12()).model_dump(mode="json")
    twice = Preferences.model_validate(once).model_dump(mode="json")
    assert once == twice
    block = dict(_stored_round12()["chat_agent"])
    first = _migrate_chat_limits(dict(block))
    assert _migrate_chat_limits(dict(first)) == first


# --------------------------------------------------------------------------- #
# Both steps: a block from before Round 12 chains to the current values.
# --------------------------------------------------------------------------- #
def test_a_stored_pre_round12_configuration_chains_to_the_tripled_values() -> None:
    prefs = Preferences.model_validate(_stored())
    agent = prefs.chat_agent
    assert agent.limits_mode == "unlimited"
    # 30 s / 2 / 8 become 300 / 4 / 16 in step 1 and 900 / 12 / 48 in step 2; lookups at
    # once and the lookup timeout, unchanged in Round 12, move in step 2.
    assert _capacity(agent) == ROUND14_DEFAULTS
    assert agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION
    assert prefs.auto_close.false_positive.min_confidence == 0.97      # the rest is intact


def test_an_explicit_limit_keeps_bounded_mode_and_its_values() -> None:
    prefs = Preferences.model_validate(_stored(max_tool_calls=25))
    agent = prefs.chat_agent
    assert agent.limits_mode == "bounded" and agent.max_tool_calls == 25
    # Step 1 keeps a Bounded block's 30 s; step 2 moves only 300, so 30 stays.
    assert agent.model_step_timeout_s == 30
    assert (agent.max_concurrent_turns_per_user, agent.max_concurrent_turns_global) == (12, 48)
    assert (agent.max_parallel, agent.tool_timeout_s) == (12, 45)


def test_a_pre_round12_choice_equal_to_a_round12_default_is_kept() -> None:
    """A value chosen before Round 12 differs from that release's default, so it is a
    choice; step 2 must not mistake it for the Round 12 default it happens to equal."""
    agent = Preferences.model_validate(
        _stored(max_concurrent_turns_per_user=4, max_concurrent_turns_global=16)).chat_agent
    assert agent.limits_mode == "unlimited"
    assert (agent.max_concurrent_turns_per_user, agent.max_concurrent_turns_global) == (4, 16)
    # The untouched knobs still chain to the current defaults.
    assert (agent.max_parallel, agent.tool_timeout_s, agent.model_step_timeout_s) == (12, 45, 900)
    assert agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION


@pytest.mark.parametrize("mode_knobs", [{}, {"max_tool_calls": 25}], ids=["unlimited", "bounded"])
def test_a_pre_round12_model_call_timeout_of_300_is_kept(mode_knobs: dict[str, int]) -> None:
    """300 s was the pre-Round-12 maximum: a legal choice there (default 30), not the
    Round 12 default it equals."""
    agent = Preferences.model_validate(_stored(model_step_timeout_s=300, **mode_knobs)).chat_agent
    assert agent.limits_mode == ("bounded" if mode_knobs else "unlimited")
    assert agent.model_step_timeout_s == 300
    assert (agent.max_concurrent_turns_per_user, agent.max_concurrent_turns_global) == (12, 48)


def test_a_chosen_value_is_kept_through_every_later_step() -> None:
    """The steps share what they found chosen: for each step-1 knob, a pre-Round-12
    block holding that knob's Round 12 default keeps it, and nothing else is affected."""
    step1_round12_values = {"model_step_timeout_s": 300, "max_concurrent_turns_per_user": 4,
                            "max_concurrent_turns_global": 16}
    for name, value in step1_round12_values.items():
        block = dict(_stored(**{name: value})["chat_agent"])
        migrated = _migrate_chat_limits(block)
        assert migrated[name] == value, name
        others = {n: migrated[n] for n in TRIPLED if n != name}
        assert others == {n: v for n, v in ROUND14_DEFAULTS.items() if n != name}, name


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
    assert agent.limits_mode == "unlimited"
    # Chosen values stay through both steps.
    assert (agent.model_step_timeout_s, agent.max_parallel, agent.tool_timeout_s) == (120, 8, 60)


def test_the_migration_runs_once() -> None:
    migrated = Preferences.model_validate(_stored()).model_dump(mode="json")
    # An operator later chooses bounded with the default knobs: never re-decided.
    migrated["chat_agent"]["limits_mode"] = "bounded"
    again = Preferences.model_validate(migrated).chat_agent
    assert again.limits_mode == "bounded" and again.model_step_timeout_s == 900
    # And a stored concurrency of 2 chosen AFTER the migration is kept.
    migrated["chat_agent"]["max_concurrent_turns_per_user"] = 2
    assert Preferences.model_validate(migrated).chat_agent.max_concurrent_turns_per_user == 2


def test_an_explicit_mode_without_a_marker_is_respected() -> None:
    assert Preferences.model_validate(_stored(limits_mode="bounded")).chat_agent.limits_mode == "bounded"
    assert Preferences.model_validate(
        _stored(limits_mode="unlimited", max_tool_calls=25)).chat_agent.limits_mode == "unlimited"


# --------------------------------------------------------------------------- #
# Programmatic constructions are never migrated.
# --------------------------------------------------------------------------- #
def test_programmatic_constructions() -> None:
    assert ChatAgentConfig(max_tool_calls=2).limits_mode == "bounded"          # a cap means bounded
    assert ChatAgentConfig(allow_text_streaming=False).limits_mode == "unlimited"
    assert ChatAgentConfig(model_step_timeout_s=30).model_step_timeout_s == 30   # not a persisted block
    assert ChatAgentConfig(limits_mode=" BOUNDED ").limits_mode == "bounded"


def test_a_programmatic_construction_at_the_old_defaults_is_untouched() -> None:
    assert _capacity(ChatAgentConfig(**ROUND12_DEFAULTS)) == ROUND12_DEFAULTS
    # A partial block (no persisted markers) at version 1 is not a stored dump either.
    partial = ChatAgentConfig.model_validate({"chat_limits_version": 1, **ROUND12_DEFAULTS})
    assert _capacity(partial) == ROUND12_DEFAULTS
    assert partial.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION


def test_lookups_at_once_is_capped_by_the_lookup_budget_only_in_bounded_mode() -> None:
    # Unlimited (D1): max_tool_calls is not a cap, so it never limits parallelism.
    unlimited = ChatAgentConfig(limits_mode="unlimited", max_tool_calls=3, max_parallel=8)
    assert unlimited.limits_mode == "unlimited"
    assert (unlimited.max_tool_calls, unlimited.max_parallel) == (3, 8)
    assert unlimited.effective_parallel == 8
    # Bounded: one batch can never be larger than the per-question lookup budget, but
    # that limit is applied at use, never written back over the operator's value.
    bounded = ChatAgentConfig(limits_mode="bounded", max_tool_calls=3, max_parallel=8)
    assert (bounded.max_tool_calls, bounded.max_parallel) == (3, 8)
    assert bounded.effective_parallel == 3
    # A stored unlimited block keeps its parallelism through Preferences too.
    prefs = Preferences.model_validate(
        _stored(limits_mode="unlimited", chat_limits_version=CURRENT_CHAT_LIMITS_VERSION,
                max_tool_calls=3, max_parallel=8))
    assert prefs.chat_agent.max_parallel == 8


def test_a_mode_round_trip_keeps_lookups_at_once() -> None:
    """Bounded → Unlimited (and a save while Bounded) never lowers the stored
    ``max_parallel``: switching modes is lossless (SPEC D1)."""
    stored = _stored(limits_mode="unlimited", chat_limits_version=CURRENT_CHAT_LIMITS_VERSION,
                     max_tool_calls=3, max_parallel=8)
    as_bounded = Preferences.model_validate(stored).chat_agent.model_dump(mode="json")
    as_bounded["limits_mode"] = "bounded"
    saved_bounded = Preferences.model_validate(_stored(**as_bounded)).chat_agent
    assert (saved_bounded.limits_mode, saved_bounded.max_parallel) == ("bounded", 8)
    assert saved_bounded.effective_parallel == 3
    back = saved_bounded.model_dump(mode="json")
    back["limits_mode"] = "unlimited"
    saved_unlimited = Preferences.model_validate(_stored(**back)).chat_agent
    assert (saved_unlimited.limits_mode, saved_unlimited.max_parallel) == ("unlimited", 8)
    assert saved_unlimited.effective_parallel == 8


# --------------------------------------------------------------------------- #
# Repair never rejects.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("raw,expected", [
    (None, None), (0, None), (-5, None), ("nan", None), (float("inf"), None), ("abc", None),
    (True, None), ("2.5", 2.5), (10, 10.0),
])
def test_the_chat_cap_is_repaired_never_rejected(raw: Any, expected: float | None) -> None:
    assert ChatAgentConfig.model_validate({"chat_daily_cap_usd": raw}).chat_daily_cap_usd == expected


@pytest.mark.parametrize("raw,expected", [("off", False), (0, False), ("yes", True), ([], True), (False, False)])
def test_animated_brand_is_repaired(raw: Any, expected: bool) -> None:
    assert ChatAgentConfig.model_validate({"animated_brand": raw}).animated_brand is expected


@pytest.mark.parametrize("name,raw,expected", [
    ("max_parallel", 99, 24), ("max_parallel", 0, 1),
    ("max_concurrent_turns_per_user", 30, 24), ("model_step_timeout_s", 10_000, 1_800),
    ("model_step_timeout_s", 1, 5), ("tool_timeout_s", 500, 120),
    ("max_concurrent_turns_global", 1_000, 100), ("max_parallel", "lots", 12),
])
def test_capacity_values_are_clamped_to_the_new_bounds(name: str, raw: Any, expected: int) -> None:
    agent = Preferences.model_validate(
        _stored_round12(chat_limits_version=CURRENT_CHAT_LIMITS_VERSION, **{name: raw})).chat_agent
    assert getattr(agent, name) == expected
    assert agent.max_tool_calls == 10                              # one bad value, nothing else


@pytest.mark.parametrize("stored", [
    {"limits_mode": 7, "chat_limits_version": "x", "model_step_timeout_s": 10_000},
    {"limits_mode": "sometimes", "chat_daily_cap_usd": {"a": 1}},
    {"chat_limits_version": 99, "limits_mode": None},
    {"chat_limits_version": True, "max_parallel": 4.0, "tool_timeout_s": "15"},
])
def test_malformed_round12_values_never_reset_preferences(stored: dict[str, Any]) -> None:
    doc = _stored(**stored)
    prefs = Preferences.model_validate(doc)
    assert prefs.auto_close.false_positive.min_confidence == 0.97
    agent = prefs.chat_agent
    assert agent.limits_mode in ("unlimited", "bounded")
    for name, (lo, hi) in CHAT_AGENT_BOUNDS.items():
        assert lo <= getattr(agent, name) <= hi, name


# --------------------------------------------------------------------------- #
# Both state backends migrate what they load.
# --------------------------------------------------------------------------- #
async def test_the_config_store_migrates_a_stored_document() -> None:
    from app.constants import CONFIG_DOC_ID, CONFIG_INDEX
    from app.es.fake import InMemoryESClient
    from app.stores.config_store import ConfigStore

    es = InMemoryESClient()
    await es.index_doc(CONFIG_INDEX, _stored(), doc_id=CONFIG_DOC_ID)
    prefs = await ConfigStore(es).load()
    assert prefs.chat_agent.limits_mode == "unlimited"
    assert _capacity(prefs.chat_agent) == ROUND14_DEFAULTS
    assert prefs.auto_close.false_positive.min_confidence == 0.97


async def test_the_config_store_migrates_a_stored_round12_document() -> None:
    from app.constants import CONFIG_DOC_ID, CONFIG_INDEX
    from app.es.fake import InMemoryESClient
    from app.stores.config_store import ConfigStore

    es = InMemoryESClient()
    await es.index_doc(CONFIG_INDEX, _stored_round12(max_parallel=6), doc_id=CONFIG_DOC_ID)
    prefs = await ConfigStore(es).load()
    assert _capacity(prefs.chat_agent) == dict(ROUND14_DEFAULTS, max_parallel=6)
    assert prefs.chat_agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION
    assert prefs.auto_close.false_positive.min_confidence == 0.97


async def test_the_sql_config_store_migrates_a_stored_round12_document() -> None:
    from app.stores.sql.engine import build_async_engine, create_all
    from app.stores.sql.repositories import SqlConfigStore, SqlKVStore

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        kv = SqlKVStore(engine)
        # The Round 12 document exactly as a Round 12 or 13 backend stored it.
        await kv.put("config", "preferences", _stored_round12(model_step_timeout_s=600))
        prefs = await SqlConfigStore(kv).load()
        assert _capacity(prefs.chat_agent) == dict(ROUND14_DEFAULTS, model_step_timeout_s=600)
        assert prefs.chat_agent.chat_limits_version == CURRENT_CHAT_LIMITS_VERSION
        assert prefs.auto_close.false_positive.min_confidence == 0.97
    finally:
        await engine.dispose()
