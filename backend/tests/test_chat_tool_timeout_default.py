"""A chat lookup without a configured timeout runs on the configuration's own default
(Round 14 SPEC §4.2.1: 45 s since the tripling), never on a second copy of the old
15 s figure."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.agents.chat_tools import logs as L
from app.agents.chat_tools import registry as R
from app.agents.chat_tools.base import ToolOutcome
from app.config import ChatAgentConfig, Preferences

from tests.test_chat_tools_support import make_ctx


def test_the_default_is_the_configurations_own() -> None:
    assert ChatAgentConfig.model_fields["tool_timeout_s"].default == 45
    assert R.DEFAULT_TOOL_TIMEOUT_S == 45.0
    assert L._DEFAULT_TOOL_TIMEOUT_S == R.DEFAULT_TOOL_TIMEOUT_S


@pytest.mark.parametrize("prefs", [
    SimpleNamespace(),                                         # no chat_agent block
    SimpleNamespace(chat_agent=None),
    SimpleNamespace(chat_agent=SimpleNamespace()),             # a block without the key
    SimpleNamespace(chat_agent=SimpleNamespace(tool_timeout_s=0)),
    SimpleNamespace(chat_agent=SimpleNamespace(tool_timeout_s=None)),
    SimpleNamespace(chat_agent=SimpleNamespace(tool_timeout_s="15")),
    SimpleNamespace(chat_agent=SimpleNamespace(tool_timeout_s=True)),
], ids=["no-block", "none-block", "no-key", "zero", "none", "text", "bool"])
def test_missing_or_unusable_preferences_use_the_default(prefs: Any) -> None:
    assert R.configured_tool_timeout(SimpleNamespace(prefs=prefs)) == 45.0
    assert R.configured_tool_timeout(SimpleNamespace()) == 45.0


def test_a_configured_timeout_wins() -> None:
    ctx = SimpleNamespace(prefs=Preferences(chat_agent=ChatAgentConfig(tool_timeout_s=7)))
    assert R.configured_tool_timeout(ctx) == 7.0


@pytest.mark.asyncio
async def test_a_lookup_without_chat_agent_preferences_runs_on_45_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[float] = []

    async def fake_wait_for(coro: Any, timeout: float) -> ToolOutcome:
        coro.close()  # the tool itself is not under test
        seen.append(timeout)
        return ToolOutcome(ok=True, summary="read")

    box = R.build_toolbox(make_ctx(prefs=SimpleNamespace()))   # preferences with no chat_agent block
    monkeypatch.setattr(asyncio, "wait_for", fake_wait_for)
    out = await box.execute("get_case", {"case_id": "case-0000000000000001"}, turn_id="t", step=1)
    assert out.ok, out.error
    assert seen == [45.0]
