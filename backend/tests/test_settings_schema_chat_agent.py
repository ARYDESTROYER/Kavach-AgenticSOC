"""``chat_agent`` in the settings schema (chat revamp SPEC §4.2).

The block has a curated Settings editor ("Settings → General → Chat assistant"), and
the schema is still what the $0 Help Center fallback reads for settings-key questions
(SPEC §5.4.1), so its section must carry the same human name and declare every bound
the editor enforces.
"""
from __future__ import annotations

from app.api.settings_schema import settings_schema
from app.config import ChatAgentConfig


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
