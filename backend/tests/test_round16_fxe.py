"""Round 16 FXE: entity investigation over every source, Demo chat, and What's new.

* Entity investigation finds an entity that only a push source holds: a LEEF record a
  QRadar webhook delivered (read with the source's field mapping, as the Logs page shows
  it), and, in Demo Mode, an address only the QRadar Demo source holds. A muted push
  source is never read. The empty answer names its widest window in words.
* Demo chat reads "closed by the AI agent" as the AI's closes, not every close.
* An account seeded at startup on an installation whose setup is complete starts with
  What's new marked seen; before setup completes (the local demo) it does not.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pytest

from app import whats_new
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import WHATS_NEW_SEEN_PREF_KEY
from app.state import AppState


def _final_verdict() -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": "NEEDS_HUMAN", "confidence": 0.4,
            "evidence": [{"summary": "scripted evidence", "event_ids": []}],
            "mitre": [], "recommended_action": "review", "reproduce_query": "",
        },
    })


def _script_investigation(mock_provider: MockProvider) -> None:
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", _final_verdict())


def _leef(ip: str, user: str) -> str:
    when = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return f"LEEF:1.0|IBM|QRadar|7.5|LoginFailed|src={ip}\tusrName={user}\tdevTime={when}"


def _push_source(client, source_id: str, **config: Any) -> None:
    made = client.post("/api/sources", json={
        "id": source_id, "source_type": "webhook", "config": {"format_hint": "leef", **config},
    })
    assert made.status_code == 200, made.text


def _deliver(client, source_id: str, payload: str) -> None:
    accepted = client.post(f"/api/ingest/{source_id}", content=payload.encode(),
                           headers={"Content-Type": "text/plain"})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["received"] == 1


# --------------------------------------------------------------------------- #
# Entity investigation over push sources
# --------------------------------------------------------------------------- #
def test_an_ip_only_a_leef_push_source_holds_is_investigated(client, mock_provider) -> None:
    ip = "192.0.2.144"
    _push_source(client, "qradar-push")
    _deliver(client, "qradar-push", _leef(ip, "jdoe"))
    # The Logs page shows it with the source's normalised address.
    logs = client.get("/api/logs", params={"source_id": "qradar-push"}).json()["logs"]
    assert [row["source_ip"] for row in logs] == [ip]

    _script_investigation(mock_provider)
    response = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip}})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["entity"] == {"type": "ip", "value": ip}
    assert body["source_id"] == "qradar-push"
    assert body["trigger_reason"]["mode"] == "manual"


def test_a_user_only_a_push_source_holds_is_investigated(client, mock_provider) -> None:
    _push_source(client, "qradar-users")
    _deliver(client, "qradar-users", _leef("192.0.2.145", "pnair-push"))
    _script_investigation(mock_provider)
    response = client.post("/api/investigate", json={"entity": {"type": "user", "value": "pnair-push"}})
    assert response.status_code == 200, response.text
    assert response.json()["source_id"] == "qradar-users"


def test_a_muted_push_source_is_never_read(client, mock_provider) -> None:
    ip = "192.0.2.146"
    _push_source(client, "qradar-muted", role="ignore")
    _deliver(client, "qradar-muted", _leef(ip, "muted"))
    response = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip}})
    assert response.status_code == 400
    assert mock_provider.calls == []


def test_a_named_source_is_the_only_one_searched(client, mock_provider) -> None:
    """Naming a source keeps the search to it: the push ring is not a fallback then."""
    ip = "192.0.2.147"
    _push_source(client, "qradar-named")
    _deliver(client, "qradar-named", _leef(ip, "named"))
    response = client.post("/api/investigate", json={
        "entity": {"type": "ip", "value": ip}, "source_id": "not-a-source",
    })
    assert response.status_code == 400
    assert "No events found" not in response.json()["detail"]


def test_the_empty_answer_names_the_widest_window_in_words(client) -> None:
    response = client.post("/api/investigate", json={"entity": {"type": "ip", "value": "198.51.100.78"}})
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail == "No events found for ip 198.51.100.78 in the last 365 days"
    assert "now-" not in detail


@pytest.mark.parametrize("window, words", [
    ("now-365d", "the last 365 days"),
    ("now-24h", "the last 24 hours"),
    ("now-7d", "the last 7 days"),
    ("2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"),
])
def test_window_words(window: str, words: str) -> None:
    from app.api.routes import _window_words

    assert _window_words(window) == words


def test_the_console_names_the_same_widest_window_the_server_searches() -> None:
    """The Investigate page's empty answer names the ladder's last rung in words."""
    from pathlib import Path

    from app.api.routes import _window_words
    from app.engine.case_cluster import WIDEN_LADDER

    page = Path(__file__).resolve().parents[2] / "webui/src/soc/pages/Investigate.tsx"
    words = _window_words(WIDEN_LADDER[-1])
    assert f"export const WIDEST_SEARCH_WORDS = '{words}';" in page.read_text(encoding="utf-8")


def test_demo_entity_investigation_finds_an_ip_only_qradar_holds(client) -> None:
    from app.connectors.base import StructuredQuery

    enabled = client.post("/api/demo/enable", json={"mode": "seeded", "seed": 1337, "history_days": 2})
    assert enabled.status_code == 200, enabled.text
    state = client.app.state.tlsoc
    splunk = state.demo_source_connector("demo-splunk")
    rows = client.get("/api/sources/demo-qradar/logs?limit=200").json()["logs"]

    async def _in_splunk(ip: str) -> bool:
        found = await splunk.search(state.execution_prefs, StructuredQuery(ip=ip, time_from="now-365d", size=1))
        return bool(found.events)

    candidates = [row["source_ip"] for row in rows if row.get("source_ip")]
    only_qradar = next(ip for ip in candidates if not client.portal.call(_in_splunk, ip))

    response = client.post("/api/investigate", json={"entity": {"type": "ip", "value": only_qradar}})

    assert response.status_code == 200, response.text
    assert response.json()["source_id"] == "demo-qradar"
    assert response.json()["entity"]["value"] == only_qradar


# --------------------------------------------------------------------------- #
# Demo chat: "closed by the AI agent"
# --------------------------------------------------------------------------- #
def test_demo_chat_reads_closed_by_the_ai_agent_as_the_ai_closes() -> None:
    from tests.test_demo_chat_round12 import _generic_obs, drive, ran

    def closes(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        out = _generic_obs(tool, inp)
        out.update(total=33, window="the last 24 hours", filters={"status_group": "terminal"},
                   totals={"count": 33, "auto_closed": 31, "human_closed": 2})
        return out

    rounds, _header, body = drive("How many cases were closed by the AI agent in the last 24 hours?", closes)
    (stats,) = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats["status_group"] == "terminal"
    assert {"auto_closed", "human_closed"} <= set(stats["metrics"])
    assert body.startswith("**31 cases**"), body
    assert "of 33 closed cases" in body, body


@pytest.mark.parametrize("question", [
    "How many cases were closed by the AI agent this week?",
    "cases resolved by the AI last month",
    "how many were closed by an agent today",
    "cases closed by automation",
])
def test_the_passive_close_by_the_ai_is_an_automatic_close(question: str) -> None:
    from app.engine.demo_chat import _AUTO_CLOSE_RE

    assert _AUTO_CLOSE_RE.search(question.lower())


def test_a_person_closing_is_not_an_automatic_close() -> None:
    from app.engine.demo_chat import _AUTO_CLOSE_RE

    assert not _AUTO_CLOSE_RE.search("how many cases were closed by the analyst this week")
    assert not _AUTO_CLOSE_RE.search("cases closed by pnair")


# --------------------------------------------------------------------------- #
# What's new: an account seeded at startup
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _fresh_latest_cache():
    whats_new.latest_update_id.cache_clear()
    yield
    whats_new.latest_update_id.cache_clear()


async def _seeding_state() -> AppState:
    mock = MockProvider()
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="fxe-seed-secret", auth_seed_admin=True,
    )
    state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    await state.startup(start_poller=False)
    return state


async def test_the_admin_seeded_before_setup_completes_keeps_the_welcome() -> None:
    """The local demo seeds Admin before it posts setup/complete: the welcome shows once."""
    state = await _seeding_state()
    try:
        assert state.prefs.setup_complete is False
        assert await state.users.get("Admin") is not None
        prefs = await state.user_prefs.get("Admin")
        assert WHATS_NEW_SEEN_PREF_KEY not in (prefs.misc or {})
    finally:
        await state.shutdown()


async def test_an_admin_seeded_on_a_completed_install_starts_with_whats_new_seen() -> None:
    """Sign-in turned on after setup: the seeded account never ran the update."""
    state = await _seeding_state()
    try:
        assert await state.users.delete("Admin")
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await state.seed_users()
        assert await state.users.get("Admin") is not None
        prefs = await state.user_prefs.get("Admin")
        assert (prefs.misc or {})[WHATS_NEW_SEEN_PREF_KEY] == whats_new.latest_update_id()
    finally:
        await state.shutdown()


async def test_a_failed_stamp_never_fails_seeding(monkeypatch) -> None:
    state = await _seeding_state()
    try:
        assert await state.users.delete("Admin")
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))

        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("prefs store down")

        monkeypatch.setattr(state.user_prefs, "patch", _broken)
        await state.seed_users()
        assert await state.users.get("Admin") is not None
        assert state._seeded_default_admin is True
    finally:
        await state.shutdown()
