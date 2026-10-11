"""``GET /api/chat/context`` carries the brand-ring switch (Round 12, SPEC D13).

The web console animates a thin ring around the logo while a chat answer is being
written unless an administrator turned ``ChatAgentConfig.animated_brand`` off. The
console learns the switch from ``bounds.animated_brand``; an operator's logo itself is
never animated (web side).
"""

from __future__ import annotations

from types import SimpleNamespace

from app.config import ChatAgentConfig
from app.models import ChatContextBounds
from tests.test_chat_context_route import _client


def test_bounds_project_the_switch_from_the_config() -> None:
    assert ChatContextBounds.from_config(ChatAgentConfig()).animated_brand is True
    off = ChatAgentConfig().model_copy(update={"animated_brand": False})
    assert ChatContextBounds.from_config(off).animated_brand is False
    # A config without the field (an older shape) reads as on.
    legacy = SimpleNamespace(**{
        name: getattr(ChatAgentConfig(), name)
        for name in ChatContextBounds.model_fields
        if name != "animated_brand"
    })
    assert ChatContextBounds.from_config(legacy).animated_brand is True


def test_context_route_reports_the_switch() -> None:
    with _client() as client:
        assert client.get("/api/chat/context").json()["bounds"]["animated_brand"] is True
    with _client() as client:                     # a fresh app: /chat/context is cached 30 s
        state = client.app.state.tlsoc
        cfg = state.prefs.chat_agent.model_copy(update={"animated_brand": False})
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"chat_agent": cfg}))
        assert client.get("/api/chat/context").json()["bounds"]["animated_brand"] is False


def test_switching_it_back_on_is_never_served_from_the_context_cache() -> None:
    with _client() as client:
        state = client.app.state.tlsoc
        assert client.get("/api/chat/context").json()["bounds"]["animated_brand"] is True
        off = state.prefs.chat_agent.model_copy(update={"animated_brand": False})
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"chat_agent": off}))
        assert client.get("/api/chat/context").json()["bounds"]["animated_brand"] is False
        on = state.prefs.chat_agent.model_copy(update={"animated_brand": True})
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={"chat_agent": on}))
        assert client.get("/api/chat/context").json()["bounds"]["animated_brand"] is True
