"""``chat_agent`` in the settings schema (chat revamp SPEC §4.2).

The block has a curated Settings editor ("Settings → General → Chat assistant"), and
the schema is still what the $0 Help Center fallback reads for settings-key questions
(SPEC §5.4.1), so its section must carry the same human name and declare every bound
the editor enforces.

Round 14 SPEC §4.2: the "Timeouts and capacity" defaults are tripled; the schema
endpoint publishes the new defaults and ranges, and a save keeps values up to them.
"""
from __future__ import annotations

from app.api.settings_schema import settings_schema
from app.config import CURRENT_CHAT_LIMITS_VERSION, ChatAgentConfig


def _chat_agent_section() -> dict:
    sections = {s["key"]: s for s in settings_schema()["sections"]}
    assert "chat_agent" in sections
    return sections["chat_agent"]


def test_chat_agent_section_uses_the_console_name() -> None:
    section = _chat_agent_section()
    assert section["title"] == "Chat assistant"
    assert section["kind"] == "object"
    assert section["model"] == "ChatAgentConfig"


def test_every_chat_agent_field_is_described_with_its_bounds() -> None:
    section = _chat_agent_section()
    described = {f["name"]: f for f in section["fields"]}
    assert set(described) == set(ChatAgentConfig.model_fields)
    for name, field in described.items():
        if field["type"] == "integer":
            # The curated editor clamps to exactly these; a knob without a declared
            # range would let the long-tail view offer an unbounded control again.
            assert isinstance(field.get("minimum"), int), name
            assert isinstance(field.get("maximum"), int), name
            assert field["minimum"] <= field["default"] <= field["maximum"], name
    assert described["default_stream_mode"]["choices"] == ["steps", "text"]


def test_round12_limits_fields_are_described() -> None:
    """SPEC D1/D5/D13: the mode switch, the optional chat cap and the brand toggle are
    part of the block (the curated editor shows the mode first)."""
    described = {f["name"]: f for f in _chat_agent_section()["fields"]}
    assert described["limits_mode"]["choices"] == ["unlimited", "bounded"]
    assert described["limits_mode"]["default"] == "unlimited"
    assert described["chat_daily_cap_usd"]["default"] is None
    assert described["animated_brand"]["default"] is True
    assert all(f["description"] for f in described.values())


# Round 14 SPEC §4.2.1: the "Timeouts and capacity" knobs, tripled, with their ranges.
ROUND14_CAPACITY = {
    "max_parallel": (12, 1, 24),
    "tool_timeout_s": (45, 1, 120),
    "model_step_timeout_s": (900, 5, 1_800),
    "max_concurrent_turns_per_user": (12, 1, 24),
    "max_concurrent_turns_global": (48, 1, 100),
}


def test_round14_capacity_fields_carry_the_tripled_defaults_and_bounds() -> None:
    described = {f["name"]: f for f in _chat_agent_section()["fields"]}
    for name, (default, lo, hi) in ROUND14_CAPACITY.items():
        field = described[name]
        assert (field["default"], field["minimum"], field["maximum"]) == (default, lo, hi), name
    marker = described["chat_limits_version"]
    assert (marker["default"], marker["maximum"]) == (CURRENT_CHAT_LIMITS_VERSION, CURRENT_CHAT_LIMITS_VERSION) == (2, 2)


def test_the_settings_schema_endpoint_returns_the_new_bounds(client) -> None:
    """The route the long-tail settings view and the Help Center read (settings:read)."""
    resp = client.get("/api/settings/schema")
    assert resp.status_code == 200
    sections = {s["key"]: s for s in resp.json()["sections"]}
    described = {f["name"]: f for f in sections["chat_agent"]["fields"]}
    for name, (default, lo, hi) in ROUND14_CAPACITY.items():
        field = described[name]
        assert (field["default"], field["minimum"], field["maximum"]) == (default, lo, hi), name


def test_a_settings_save_keeps_values_up_to_the_new_ceilings(client) -> None:
    """A value above a Round 12 ceiling (8 lookups at once, 10 questions per user,
    900 s) is no longer clamped on save, and a fresh read returns it."""
    agent = client.get("/api/settings").json()["prefs"]["chat_agent"]
    assert {name: agent[name] for name in ROUND14_CAPACITY} == {
        name: default for name, (default, _lo, _hi) in ROUND14_CAPACITY.items()}
    ceilings = {name: hi for name, (_default, _lo, hi) in ROUND14_CAPACITY.items()}
    resp = client.put("/api/settings", json={"chat_agent": {**agent, **ceilings}})
    assert resp.status_code == 200, resp.text
    saved = client.get("/api/settings").json()["prefs"]["chat_agent"]
    assert {name: saved[name] for name in ROUND14_CAPACITY} == ceilings
    assert saved["chat_limits_version"] == CURRENT_CHAT_LIMITS_VERSION
