"""Round 14 SPEC §4.2.3 (D20, defect F20): the report AI summary wait.

A summary is one blocking request behind the Web UI proxy, which gives ``/api/`` 300 s
(``webui/nginx.conf``). The wait is ``min(2 x chat_agent.model_step_timeout_s, 280)``
seconds, so tripling the model call timeout (900 s by default, up to 1,800 s) can never
make the server wait past the proxy, and a timeout answers with the summary-timeout
error the Console shows."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.api import routes_reports
from app.api.routes_reports import (
    SUMMARY_FAILURE_MESSAGES,
    SUMMARY_TIMEOUT_CEILING_S,
    SUMMARY_TIMEOUT_FACTOR,
    summary_timeout_s,
)
from app.config import CHAT_AGENT_BOUNDS, ChatAgentConfig
from tests.test_reports_routes import _report_with_item, harness, summary_reply

PROXY_READ_TIMEOUT_S = 300.0  # webui/nginx.conf, location /api/


def test_the_ceiling_sits_below_the_web_proxy() -> None:
    assert SUMMARY_TIMEOUT_CEILING_S == 280.0 < PROXY_READ_TIMEOUT_S
    assert SUMMARY_TIMEOUT_FACTOR == 2.0


def test_the_wait_never_exceeds_280_seconds_for_any_storable_step_value() -> None:
    lo, hi = CHAT_AGENT_BOUNDS["model_step_timeout_s"]
    assert (lo, hi) == (5, 1_800)
    for step in range(lo, hi + 1):
        wait = summary_timeout_s(step)
        assert 0 < wait <= SUMMARY_TIMEOUT_CEILING_S, step
        assert wait == min(2.0 * step, 280.0), step


@pytest.mark.parametrize("step,expected", [
    (5, 10.0), (30, 60.0), (139, 278.0), (140, 280.0), (141, 280.0), (300, 280.0),
    (900, 280.0), (1_800, 280.0),
])
def test_the_wait_is_two_model_steps_up_to_the_ceiling(step: int, expected: float) -> None:
    assert summary_timeout_s(step) == expected


@pytest.mark.parametrize("raw", [None, 0, -5, "", "abc", float("nan"), float("inf"), True, [], {}])
def test_a_missing_or_malformed_step_reads_as_the_default(raw: Any) -> None:
    default = ChatAgentConfig.model_fields["model_step_timeout_s"].default
    assert default == 900
    assert summary_timeout_s(raw) == min(2.0 * default, 280.0) == 280.0


async def _summary_wait(h: Any, monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Spy on the summary route's ``asyncio.wait_for`` (delegating to the real one) and
    return the timeouts it was given for the model call."""
    seen: list[float] = []
    real_wait_for = asyncio.wait_for

    async def spy(aw: Any, timeout: float | None = None) -> Any:
        if "complete" in getattr(aw, "__qualname__", ""):
            seen.append(float(timeout) if timeout is not None else float("inf"))
        return await real_wait_for(aw, timeout)

    monkeypatch.setattr(routes_reports.asyncio, "wait_for", spy)
    return seen


@pytest.mark.parametrize("stored_step", [5, 140, 300, 900, 1_800])
async def test_the_summary_route_waits_at_most_280_seconds(stored_step: int, monkeypatch) -> None:
    async with harness() as h:
        prefs = h.state.prefs
        agent = prefs.chat_agent.model_copy(update={"model_step_timeout_s": stored_step})
        await h.state.update_prefs(prefs.model_copy(update={"chat_agent": agent}))
        assert h.state.execution_prefs.chat_agent.model_step_timeout_s == stored_step
        report = await _report_with_item(h)
        seen = await _summary_wait(h, monkeypatch)
        h.mock.push("chat", summary_reply())
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 200, resp.text
        assert seen == [min(2.0 * stored_step, 280.0)]
        assert seen[0] <= SUMMARY_TIMEOUT_CEILING_S < PROXY_READ_TIMEOUT_S


async def test_the_default_configuration_waits_280_seconds(monkeypatch) -> None:
    async with harness() as h:
        assert h.state.execution_prefs.chat_agent.model_step_timeout_s == 900
        report = await _report_with_item(h)
        seen = await _summary_wait(h, monkeypatch)
        h.mock.push("chat", summary_reply())
        assert (await h.client.post(f"/api/reports/{report['id']}/summary", json={})).status_code == 200
        assert seen == [280.0]


async def test_a_timeout_answers_with_the_summary_timeout_wording(monkeypatch) -> None:
    async with harness() as h:
        report = await _report_with_item(h)
        # A tiny ceiling makes the wait end at once; the route maps it to the 504.
        monkeypatch.setattr(routes_reports, "SUMMARY_TIMEOUT_CEILING_S", 0.05)

        async def slow(*_a: Any, **_k: Any) -> Any:
            await asyncio.sleep(5)
            raise AssertionError("not reached")

        h.mock.complete = slow  # type: ignore[method-assign]
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 504
        detail = resp.json()["detail"]
        assert detail["code"] == "report_summary_timeout"
        assert detail["message"] == SUMMARY_FAILURE_MESSAGES["report_summary_timeout"]
        assert detail["message"] == "The summary took too long. Try again, or summarise fewer items."
        assert "—" not in detail["message"] and "–" not in detail["message"]
