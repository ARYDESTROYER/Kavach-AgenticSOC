"""Shared tool plumbing: the §3.1 window precedence and clamp, input validation
templates and the prompt-side vs visible text helpers (chat revamp SPEC §3.1, §7.6)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from pydantic import Field

from app.agents.chat_tools.common import (
    MAX_WINDOW_DAYS,
    ToolInput,
    citation_id,
    opt_text,
    parse_input,
    resolve_window,
    text,
    visible_text,
)
from app.agents.prompts import fence_block
from app.models import TimeRange

from tests.test_chat_tools_support import make_ctx

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def test_window_precedence_tool_then_chip_then_default() -> None:
    chip = TimeRange(**{"from": "now-6h"})
    default = resolve_window(make_ctx(), now=NOW)
    assert (default.time_from, default.label, default.source, default.hours) == ("now-24h", "last 24h", "default", 24)
    request = resolve_window(make_ctx(time_range=chip), now=NOW)
    assert (request.time_from, request.source) == ("now-6h", "request")
    tool = resolve_window(make_ctx(time_range=chip), time_from="now-1h", now=NOW)
    assert (tool.time_from, tool.source, tool.clamped) == ("now-1h", "tool", False)
    hours = resolve_window(make_ctx(), window_hours=48, now=NOW)
    assert (hours.time_from, hours.hours) == ("now-48h", 48)


def test_window_is_clamped_into_the_request_and_bounded() -> None:
    chip = TimeRange(**{"from": "2026-10-08T00:00:00Z", "to": "2026-10-08T06:00:00Z"})
    wide = resolve_window(make_ctx(time_range=chip), time_from="now-30d", now=NOW)
    assert wide.clamped and wide.start == datetime(2026, 10, 8, tzinfo=timezone.utc)
    assert wide.end == datetime(2026, 10, 8, 6, tzinfo=timezone.utc)
    assert wide.label == "2026-10-08 00:00 → 2026-10-08 06:00 UTC"
    disjoint = resolve_window(make_ctx(time_range=chip), time_from="now-1h", now=NOW)
    assert disjoint.clamped and disjoint.start == wide.start and disjoint.end == wide.end
    huge = resolve_window(make_ctx(), time_from="now-400d", now=NOW)
    assert huge.clamped and huge.end - huge.start == timedelta(days=MAX_WINDOW_DAYS)
    assert huge.hours == 720


def test_window_errors_are_engine_templates() -> None:
    assert resolve_window(make_ctx(), time_from="last tuesday", now=NOW).startswith("Invalid time window")
    assert "before the end" in resolve_window(make_ctx(), time_from="now", time_to="now-1h", now=NOW)


class _Inp(ToolInput):
    size: int = Field(default=5, ge=1, le=10)
    name: str | None = None


def test_parse_input_names_only_known_fields() -> None:
    ok, err = parse_input(_Inp, {"size": "7", "unknown<<<x>>>": 1})
    assert err is None and ok.size == 7
    _bad, err = parse_input(_Inp, {"size": 99})
    assert err is not None and err.error == "Invalid input: check size" and err.status == "error"
    _bad, err = parse_input(_Inp, ["not", "an", "object"])
    assert err is not None and "named arguments" in (err.error or "")


def test_observation_text_keeps_invisible_characters_for_the_fence() -> None:
    """SPEC §7.6: a lookalike must reach the model as a visible escape, never as the
    real name (display_text would delete the ZWSP and turn it into "admin")."""
    lookalike = "ad\u200bmin"
    assert text(lookalike) == lookalike
    assert text("a\nb\tc") == "a b c" and len(text("x" * 500, 20)) == 20
    assert text("\ud800x") == "\\ud800x"  # a lone surrogate becomes escape text
    assert text({"a": 1}) == "" and text(3) == "3" and opt_text("  ") is None
    fenced = fence_block({"user": text(lookalike)}, source="tool", tool="search_logs")
    assert "\\u200b" in fenced and '"admin"' not in fenced


def test_visible_text_writes_invisible_characters_as_escape_text() -> None:
    assert visible_text("ad\u200bmin") == "ad\\u200bmin"
    assert visible_text("evil\u202egnp.exe") == "evil\\u202egnp.exe"
    assert visible_text("plain") == "plain"


def test_window_reports_trailing_and_hour_cap() -> None:
    week = resolve_window(make_ctx(), time_from="now-7d", now=NOW)
    assert week.trailing and not week.hours_capped and week.hours == 168
    quarter = resolve_window(make_ctx(), time_from="now-90d", now=NOW)
    assert quarter.trailing and quarter.hours_capped and quarter.hours == 720
    past = resolve_window(make_ctx(time_range=TimeRange(**{"from": "2026-09-01T00:00:00Z",
                                                           "to": "2026-09-02T00:00:00Z"})), now=NOW)
    assert not past.trailing and past.hours == 24


def test_citation_id_without_and_with_an_ordinal() -> None:
    assert citation_id("K", 2) == "K2"

    class Ctx:
        ordinal = 7

    assert citation_id("K", 3, Ctx()) == "K73"
    assert citation_id("K", 30, Ctx()) == "K79"  # index clamped to 1..9


def test_one_observation_shrinker_only() -> None:
    """WP-INT item 4: the engine shrinks observations with ``chat_protocol``'s
    alignment-safe ``shrink_observation``. The tool-side duplicate (which cut parallel
    series arrays independently) is gone and must not come back as a second, divergent
    implementation a tool could call."""
    from app.agents import chat_protocol
    from app.agents.chat_tools import common

    assert not hasattr(common, "shrink_observation")
    assert not hasattr(common, "observation_chars")
    assert callable(chat_protocol.shrink_observation)
