"""The Demo planner's window note when the question names the scope chip's own window.

Round 12 (WP-GEN-B): with a scope chip selected, a question that names the SAME window
("in total" / "lifetime" / "all time" with the All time chip, "the last 6 months" with
6mo, "the past year" with 12mo, …) must not read as if the question replaced the chip
("your question named all time, so the lookups used that window instead of the all
time you selected"). The note confirms the window once. A question naming a DIFFERENT
window still says it replaced the chip, in English ("the all-time range", never "the
all time you selected"). Driven live through ``POST /api/chat/stream`` in Demo Mode.
"""
from __future__ import annotations

from typing import Any, Iterator

import pytest

from tests.test_chat_golden_set import _stream

#: (question, chip, the window phrase the confirmation names)
SAME_WINDOW: list[tuple[str, dict[str, str], str]] = [
    ("How many cases have we had in total?", {"from": "all"}, "all-time range"),
    ("How many cases have we had all time?", {"from": "all"}, "all-time range"),
    ("Show lifetime case counts", {"from": "all"}, "all-time range"),
    ("How many cases since the beginning?", {"from": "all"}, "all-time range"),
    ("How many cases ever?", {"from": "all"}, "all-time range"),
    ("How many cases in all time by verdict?", {"from": "all"}, "all-time range"),
    ("What did we spend all time?", {"from": "all"}, "all-time range"),
    ("Show top rules over all time", {"from": "all"}, "all-time range"),
    ("Show a monthly breakdown of cases for all time", {"from": "all"}, "all-time range"),
    ("How many cases were opened in the last 6 months?", {"from": "now-6M"}, "last 6 months"),
    ("Cases by month for the last 6 months", {"from": "now-6M"}, "last 6 months"),
    ("How many cases were opened in the past 12 months?", {"from": "now-12M"}, "last 12 months"),
    ("How many cases were opened in the past year?", {"from": "now-12M"}, "last 12 months"),
    ("How many cases were opened in the last year?", {"from": "now-1y"}, "past year"),
    ("How many cases were opened in the last 24 hours?", {"from": "now-24h"}, "last 24 hours"),
    ("How many cases were opened in the last day?", {"from": "now-24h"}, "last 24 hours"),
    ("How many cases were opened in the last 7 days?", {"from": "now-7d"}, "last 7 days"),
    ("How many cases were opened in the last 30 days?", {"from": "now-30d"}, "last 30 days"),
    ("What did we spend in the last 30 days?", {"from": "now-30d"}, "last 30 days"),
    ("How many cases were opened in the last 90 days?", {"from": "now-90d"}, "last 90 days"),
    ("Cases by week for the last 90 days", {"from": "now-90d"}, "last 90 days"),
    ("How many cases were opened in the last hour?", {"from": "now-1h"}, "last hour"),
    ("Show log events in the last hour", {"from": "now-1h"}, "last hour"),
]


def _window_lines(answer: str) -> list[str]:
    return [line.strip() for line in answer.splitlines() if line.strip().startswith("Window:")]


@pytest.mark.parametrize(("question", "chip", "phrase"), SAME_WINDOW,
                         ids=[f"{c['from']}:{q}" for q, c, _ in SAME_WINDOW])
def test_a_question_naming_the_chip_window_confirms_it_once(demo_client, question: str,
                                                            chip: dict[str, str], phrase: str) -> None:
    answer = _stream(demo_client, question, time_range=chip)["answer"]
    lines = _window_lines(answer)
    assert lines == [f"Window: the {phrase} you selected applies to the windowed lookups above."], (question, lines)
    assert "your question named" not in answer
    assert "instead of the" not in answer
    assert "which replaces the" not in answer
    assert "the all time you selected" not in answer


def test_a_different_window_still_says_it_replaced_the_chip_in_english(demo_client) -> None:
    narrower = _stream(demo_client, "How many cases were opened in the last 6 months?",
                       time_range={"from": "all"})["answer"]
    assert _window_lines(narrower) == [
        "Window: your question named the last 6 months, so the lookups used that window instead of the "
        "all-time range you selected."
    ]
    calendar = _stream(demo_client, "How many cases were opened this week?", time_range={"from": "now-7d"})["answer"]
    assert _window_lines(calendar) == [
        "Window: your question named this week, so the lookups used that window instead of the last 7 days "
        "you selected."
    ]
    for answer in (narrower, calendar):
        assert "the all time you selected" not in answer


def test_no_chip_means_no_window_note(demo_client) -> None:
    answer = _stream(demo_client, "How many cases have we had in total?")["answer"]
    assert _window_lines(answer) == []


@pytest.fixture(scope="module")
def demo_client() -> Iterator[Any]:
    from tests.test_chat_golden_set import client as golden_client

    yield from golden_client.__wrapped__()
