"""Item A4 — the investigation-progress SSE channel was dead on arrival.

A browser ``EventSource`` matches a typed ``event:`` field EXACTLY. The client listened
on ``agent``; the pipeline has only ever published ``agent.step``. Neither end can
observe that: the publish succeeds, the subscription succeeds, and the frames are simply
never delivered — so not one agent-step frame had ever reached a browser.

These tests pin the two halves of the fix:
  * the backend names its channels ONCE (``app.realtime.SSE_EVENT_TYPES``) and the
    producer uses the constant rather than a literal, and
  * a subscriber on the per-case room really does receive an ``event: agent.step`` frame.

The webui half (``STREAM_CHANNELS`` in ``src/lib/useEventStream.ts`` + the
``useAgentSteps`` consumer) is pinned by ``src/lib/__tests__/useEventStream.test.tsx``,
which reads this module's registry off disk so the two ends cannot drift again.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.realtime import (
    AGENT_STEP_EVENT,
    CASE_ACTIVITY_EVENT,
    INAPP_EVENT,
    JOB_EVENT,
    OVERFLOW_EVENT,
    SSE_EVENT_TYPES,
    EventBus,
)


def test_registry_lists_exactly_the_channels_the_backend_publishes() -> None:
    assert SSE_EVENT_TYPES == {
        AGENT_STEP_EVENT, CASE_ACTIVITY_EVENT, INAPP_EVENT, JOB_EVENT, OVERFLOW_EVENT,
    }
    # The exact wire tokens. Changing one of these is a client-visible break.
    assert AGENT_STEP_EVENT == "agent.step"
    assert CASE_ACTIVITY_EVENT == "case.activity"


def test_pipeline_publishes_through_the_registry_not_a_literal() -> None:
    """The producer imports the constant. A second literal is exactly how the two ends
    drifted apart in the first place."""
    source = (Path(__file__).resolve().parents[1] / "app" / "agents" / "pipeline.py").read_text()
    assert "AGENT_STEP_EVENT" in source
    assert '"agent.step"' not in source.replace('logger.debug("agent.step', "")


@pytest.mark.asyncio
async def test_a_case_room_subscriber_receives_a_typed_agent_step_frame() -> None:
    """End to end over the bus: the frame really carries ``event: agent.step``, which is
    the token an ``addEventListener`` has to match."""
    bus = EventBus(heartbeat_seconds=60)
    frames: list[str] = []

    async def _consume() -> None:
        async for chunk in bus.subscribe(["cases:case-0001"], user=None):
            frames.append(chunk.decode("utf-8"))
            if len(frames) >= 2:  # ": connected" + the first real frame
                break

    task = asyncio.create_task(_consume())
    await asyncio.sleep(0)  # let the subscriber register before publishing
    bus.publish("cases:case-0001", AGENT_STEP_EVENT,
                {"case_id": "case-0001", "step": "tools", "status": "running"})
    await asyncio.wait_for(task, timeout=5)

    assert frames[0] == ": connected\n\n"
    assert "event: agent.step\n" in frames[1]
    payload = json.loads(frames[1].split("data: ", 1)[1].split("\n", 1)[0])
    assert payload["step"] == "tools"
    bus.clear()


@pytest.mark.asyncio
async def test_the_old_channel_name_would_have_delivered_nothing() -> None:
    """Regression guard for the actual defect: a listener on ``agent`` never matches an
    ``agent.step`` frame, which is why the channel was silently dead."""
    bus = EventBus(heartbeat_seconds=60)
    bus.publish("cases:case-0002", AGENT_STEP_EVENT, {"case_id": "case-0002", "step": "triage"})
    replayed = bus.replay(frozenset({"cases:case-0002"}), None, "0")
    assert replayed and replayed[0].event_type == AGENT_STEP_EVENT
    assert replayed[0].event_type != "agent"
    bus.clear()
