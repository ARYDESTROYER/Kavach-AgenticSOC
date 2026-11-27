"""Running steps read as running (Round 13 polish).

Every catalogue tool has a present-progressive ``running_label`` ("Searching logs")
beside its past-tense ``label`` ("Searched logs"). ``step.start`` carries the running
form; ``step.end``, the response's steps and so every stored transcript keep the past
one (an old transcript's steps are untouched). The activity indicator follows the same
rule: the running form while a lookup runs, the past form once it ended."""

from __future__ import annotations

from types import SimpleNamespace
from typing import ClassVar

import pytest

from app.agents import chat as chat_module
from app.agents.chat_events import StepEndEvent, StepStartEvent
from app.agents.chat_tools import recall as recall_tool
from app.agents.chat_tools import registry
from app.agents.chat_tools.base import ChatTool
from app.api.routes_chat import _activity_label
from tests.test_chat_engine_loop import (
    LEGACY_ANSWER,
    LEGACY_QUERY,
    FakeGateway,
    StatsTool,
    WhitelistedSearchLogs,
    _RecordingEsQuery,
    final,
    make_ctx,
    make_engine,
    make_prefs,
    run,
    tool_call,
)


def _verb_and_rest(label: str) -> tuple[str, str]:
    verb, _, rest = label.partition(" ")
    return verb, rest


def _assert_pair(done: str, running: str) -> None:
    """``running`` is ``done`` with its verb in the -ing form ("Looked up X" →
    "Looking up X"): the same object, so the row never changes meaning when it ends."""
    assert done and running and running != done
    verb, rest = _verb_and_rest(running)
    assert verb.endswith("ing"), running
    assert rest == _verb_and_rest(done)[1], (done, running)


def test_every_catalogue_tool_has_a_running_and_a_done_label() -> None:
    tools = registry.catalogue()
    assert len(tools) >= 18
    for tool in tools:
        _assert_pair(tool.label, tool.running_label)
    # The engine's own re-read step too.
    _assert_pair(recall_tool.LABEL, recall_tool.RUNNING_LABEL)
    assert chat_module._LEGACY_LABEL == "Searched logs"
    _assert_pair(chat_module._LEGACY_LABEL, chat_module._LEGACY_RUNNING_LABEL)


def test_a_running_label_must_be_text() -> None:
    with pytest.raises(TypeError, match="running_label"):
        class Broken(ChatTool):  # noqa: F841 -- the class statement is the test
            name: ClassVar[str] = "broken_tool"
            label: ClassVar[str] = "Broke"
            running_label: ClassVar = 3  # type: ignore[assignment]
            scope: ClassVar[str] = "cases"
            signature: ClassVar[str] = "broken_tool() -- nothing"

            async def run(self, ctx, **inp):  # pragma: no cover - never runs
                raise AssertionError


async def test_step_start_is_present_progressive_and_step_end_keeps_the_past(monkeypatch: pytest.MonkeyPatch) -> None:
    real = next(tool for tool in registry.catalogue() if tool.name == "log_stats")

    class RunningStats(StatsTool):
        running_label: ClassVar[str] = real.running_label

    monkeypatch.setattr(registry, "_CATALOGUE", (RunningStats(),))
    gateway = FakeGateway([tool_call("log_stats", group_by="source.ip"), final("Done.")])
    prefs = make_prefs()
    events, resp, _ = await run(make_engine(gateway), "top source IPs?", prefs, make_ctx(prefs))
    starts = [e.step.label for e in events if isinstance(e, StepStartEvent) and e.step.kind == "tool"]
    ends = [e.step.label for e in events if isinstance(e, StepEndEvent) and e.step.kind == "tool"]
    assert starts == ["Counting log events"]
    assert ends == ["Counted log events"]
    # What is stored (the response's steps) keeps the past tense.
    assert [s.label for s in resp.steps if s.kind == "tool"] == ["Counted log events"]


async def test_a_tool_without_a_running_label_runs_under_its_label(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(registry, "_CATALOGUE", (StatsTool(),))
    gateway = FakeGateway([tool_call("log_stats", group_by="source.ip"), final("Done.")])
    prefs = make_prefs()
    events, _, _ = await run(make_engine(gateway), "top source IPs?", prefs, make_ctx(prefs))
    starts = [e.step.label for e in events if isinstance(e, StepStartEvent) and e.step.kind == "tool"]
    assert starts == ["Counted log events"]


async def test_the_legacy_log_query_runs_as_searching_and_ends_as_searched(monkeypatch: pytest.MonkeyPatch) -> None:
    class RunningSearchLogs(WhitelistedSearchLogs):
        running_label: ClassVar[str] = "Searching logs"

    monkeypatch.setattr(chat_module, "EsQueryTool", _RecordingEsQuery)
    monkeypatch.setattr(registry, "_CATALOGUE", (RunningSearchLogs(),))
    _RecordingEsQuery.runs = []
    gateway = FakeGateway([LEGACY_QUERY, LEGACY_ANSWER])
    prefs = make_prefs()
    events, resp, _ = await run(make_engine(gateway), "q", prefs, make_ctx(prefs))
    starts = [e.step.label for e in events if isinstance(e, StepStartEvent) and e.step.kind == "tool"]
    assert starts == ["Searching logs"]
    assert [s.label for s in resp.steps if s.kind == "tool"] == ["Searched logs"]


def test_activity_indicator_follows_the_step() -> None:
    step = SimpleNamespace(kind="tool", tool="search_logs", label="Searched logs")
    assert _activity_label(step, running=True) == "Searching logs"
    assert _activity_label(step) == "Searched logs"
    unknown = SimpleNamespace(kind="tool", tool="no_such_tool", label="x")
    assert _activity_label(unknown, running=True) == "Looking something up"
    model = SimpleNamespace(kind="model", tool=None, label="Thinking")
    assert _activity_label(model, running=True) == "Thinking"
