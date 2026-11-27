"""The per-turn re-attach ring bounds its answer TEXT, not only its entry count
(PR #131 review, Codex P1).

Consecutive ``text.delta`` events are coalesced into text entries, so the entry
bound (``TURN_RING_MAX_ENTRIES``) alone never bounded the text an unlimited answer
streams, and a finished turn's ring is kept for re-attach. The ring now also holds at
most ``TURN_RING_MAX_TEXT_CHARS`` characters in at most ``TURN_RING_MAX_TEXT_DELTAS``
deltas (plus the one delta that crossed a bound), dropping the OLDEST text a segment at
a time. A reader that had not read the dropped text gets ONE ``text.reset`` in its
place (never text spliced across the hole); a reader at or past it resumes exactly.

Every test is offline and drives the ring (and the rejoin generator) directly.
"""

from __future__ import annotations

import json
from typing import Any

from app.agents.chat_events import (
    MAX_TEXT_DELTA_CHARS,
    StepStartEvent,
    TextDeltaEvent,
    TextResetEvent,
    TurnDoneEvent,
    TurnStartEvent,
    UsageEvent,
)
from app.api import routes_chat
from app.api.routes_chat import ChatTurnHandle, TurnEventRing, _reattach
from app.models import ChatResponse


def _apply(lines: list[tuple[int, Any]], text: str = "") -> tuple[str, int]:
    """What a client's projection holds after these lines (the turn runner's rules:
    ``turn.start`` and ``text.reset`` clear the text, a delta appends), and its cursor."""
    cursor = 0
    for seq, event in lines:
        cursor = max(cursor, seq)
        kind = event.type
        if kind in ("turn.start", "text.reset"):
            text = ""
        elif kind == "text.delta":
            text += event.text
    return text, cursor


def _stream(ring: TurnEventRing, total_chars: int, size: int) -> str:
    """Append ``total_chars`` of distinguishable answer text in ``size``-char deltas."""
    original: list[str] = []
    written = 0
    index = 0
    while written < total_chars:
        piece = f"{index:07d}"[-size:].rjust(size, "~")[:size]
        ring.append(TextDeltaEvent(text=piece))
        original.append(piece)
        written += len(piece)
        index += 1
    return "".join(original)


# --------------------------------------------------------------------------- #
# The bound.
# --------------------------------------------------------------------------- #
def test_the_default_bounds_cover_any_realistic_answer() -> None:
    assert routes_chat.TURN_RING_MAX_TEXT_CHARS >= 1_000_000
    assert routes_chat.TURN_RING_MAX_TEXT_DELTAS >= routes_chat.TURN_RING_MAX_TEXT_CHARS // 4
    ring = TurnEventRing()
    assert (ring.max_text_chars, ring.max_text_deltas) == (
        routes_chat.TURN_RING_MAX_TEXT_CHARS, routes_chat.TURN_RING_MAX_TEXT_DELTAS)


def test_a_huge_streamed_answer_stays_under_the_default_text_bound() -> None:
    ring = TurnEventRing()
    ring.append(TurnStartEvent(turn_id="turn-huge"))
    big = TextDeltaEvent(text="x" * MAX_TEXT_DELTA_CHARS)
    for _ in range(1_000):                       # 4,000,000 characters streamed
        ring.append(big)
        assert ring.text_chars <= ring.max_text_chars + MAX_TEXT_DELTA_CHARS
    retained = sum(len(e["text"]) for e in ring.entries if e["kind"] == "text")
    assert retained == ring.text_chars <= routes_chat.TURN_RING_MAX_TEXT_CHARS
    assert ring.text_chars >= routes_chat.TURN_RING_MAX_TEXT_CHARS * 0.9   # it keeps most of it
    assert ring.gap is True and ring.text_gap_seq > 1
    ring.append(TurnDoneEvent(response=ChatResponse(answer="x")))
    lines = ring.after(0)
    assert [e.type for _s, e in lines][:2] == ["turn.start", "text.reset"]
    assert lines[-1][1].type == "turn.done" and lines[-1][0] == ring.terminal_seq
    assert sum(len(e.text) for _s, e in lines if e.type == "text.delta") == ring.text_chars


def test_many_tiny_deltas_are_bounded_by_the_delta_markers() -> None:
    ring = TurnEventRing(max_text_chars=1_000_000, max_text_deltas=1_600)
    ring.append(TurnStartEvent(turn_id="turn-tiny"))
    for index in range(20_000):
        ring.append(TextDeltaEvent(text="" if index % 3 == 0 else "a"))   # empty deltas too
        assert ring.text_deltas <= 1_601
    markers = sum(len(e["ends"]) for e in ring.entries if e["kind"] == "text")
    assert markers == ring.text_deltas <= 1_600
    assert ring.text_chars == sum(len(e["text"]) for e in ring.entries if e["kind"] == "text")
    assert ring.gap is True and len(ring.entries) <= 1 + routes_chat.TURN_RING_TEXT_SEGMENTS + 1


def test_a_normal_answer_is_unchanged() -> None:
    ring = TurnEventRing()
    ring.append(TurnStartEvent(turn_id="turn-normal"))
    original = _stream(ring, 40_000, 4)            # a long, realistic answer
    ring.append(UsageEvent(totals={"calls": 1, "total_tokens": 10}))
    ring.append(TurnDoneEvent(response=ChatResponse(answer=original)))
    assert ring.gap is False and ring.text_gap_seq == 0
    assert [e["kind"] for e in ring.entries] == ["event", "text", "event", "event"]
    lines = ring.after(0)
    assert not [e for _s, e in lines if e.type == "text.reset"]
    assert all(len(e.text) <= MAX_TEXT_DELTA_CHARS for _s, e in lines if e.type == "text.delta")
    assert _apply(lines)[0] == original
    # A resume at every chunk boundary it emitted continues exactly.
    for cut in range(1, len(lines)):
        held, cursor = _apply(lines[:cut])
        assert _apply(ring.after(cursor), held)[0] == original, cut


# --------------------------------------------------------------------------- #
# Rejoin across and after a dropped region.
# --------------------------------------------------------------------------- #
def _bounded_ring() -> tuple[TurnEventRing, str]:
    """A small bound (8,000 chars, 500-char segments) holding a 40,000-char answer
    streamed in 8-char deltas: seqs 2..5001 are text, 5002 is usage, 5003 the end."""
    ring = TurnEventRing(max_text_chars=8_000, max_text_deltas=1_000_000)
    ring.append(TurnStartEvent(turn_id="turn-bounded"))
    original = _stream(ring, 40_000, 8)
    ring.append(UsageEvent(totals={"calls": 1, "total_tokens": 10_000}))
    ring.append(TurnDoneEvent(response=ChatResponse(answer=original)))
    return ring, original


def test_rejoining_after_the_dropped_region_signals_the_gap() -> None:
    ring, original = _bounded_ring()
    gap = ring.text_gap_seq
    assert ring.gap is True and 2 < gap < 5001
    retained = original[-ring.text_chars:]
    assert ring.text_chars <= 8_000
    # A reader that held part of the dropped text (or none of it) gets ONE reset, in
    # seq order, tagged with the last dropped seq, then the retained tail: never its
    # held prefix glued onto the tail.
    for seen in (0, 1, 2, 777, gap - 1):
        held = original[: max(0, seen - 1) * 8]
        lines = ring.after(seen)
        resets = [(s, e) for s, e in lines if e.type == "text.reset"]
        assert resets == [(gap, TextResetEvent())], seen
        seqs = [s for s, _e in lines]
        assert seqs == sorted(seqs) and seqs[-1] == ring.terminal_seq
        text, cursor = _apply(lines, held)
        assert text == retained and original.endswith(text), seen
        assert cursor == ring.terminal_seq
    # The wire form the rejoin endpoint sends: a ``text.reset`` line with its seq.
    line = routes_chat.encode_ring_line(gap, TextResetEvent())
    assert json.loads(line) == {"type": "text.reset", "seq": gap}
    # The terminal event still carries the whole persisted answer.
    assert ring.after(0)[-1][1].response.answer == original


def test_rejoining_within_the_retained_text_resumes_exactly() -> None:
    ring, original = _bounded_ring()
    gap = ring.text_gap_seq
    # A reader at or past the last dropped seq had read everything dropped: it resumes
    # exactly, with no reset, from every seq up to the end.
    for seen in range(gap, ring.terminal_seq + 1, 37):
        held = original[: min(seen - 1, 5000) * 8]
        lines = ring.after(seen)
        assert not [e for _s, e in lines if e.type == "text.reset"], seen
        assert _apply(lines, held)[0] == original, seen
    # And from every chunk boundary of a replay that began after the gap.
    first = ring.after(gap)
    for cut in range(1, len(first)):
        held, cursor = _apply(first[:cut], original[: (gap - 1) * 8])
        assert _apply(ring.after(cursor), held)[0] == original, cut


def test_a_reader_that_keeps_up_never_sees_a_reset() -> None:
    ring = TurnEventRing(max_text_chars=4_000, max_text_deltas=1_000_000)
    ring.append(TurnStartEvent(turn_id="turn-live"))
    held, cursor = _apply(ring.after(0))
    original = ""
    for index in range(3_000):
        piece = f"{index:05d}|"
        ring.append(TextDeltaEvent(text=piece))
        original += piece
        if index % 7 == 0:                     # a live reader polling the ring
            lines = ring.after(cursor)
            assert not [e for _s, e in lines if e.type == "text.reset"]
            held, cursor = _apply(lines, held)
    held, cursor = _apply(ring.after(cursor), held)
    assert ring.gap is True and held == original


def test_entry_bound_drops_of_answer_text_also_signal_the_gap() -> None:
    # A text entry the ENTRY bound dropped: a reader that held part of it restarts.
    ring = TurnEventRing(max_entries=8)
    ring.append(TurnStartEvent(turn_id="turn-entries"))       # 1
    ring.append(TextDeltaEvent(text="Hel"))                   # 2
    ring.append(TextDeltaEvent(text="lo"))                    # 3
    for index in range(10):                                   # 4..13
        ring.append(StepStartEvent(step={"index": index, "kind": "tool", "tool": "log_stats", "label": "x"}))
    ring.append(TextDeltaEvent(text=" world"))                # 14
    assert ring.text_gap_seq == 3
    text, _cursor = _apply(ring.after(2), "Hel")
    assert text == " world"                                   # never "Hel world"
    assert _apply(ring.after(3), "Hello")[0] == "Hello world"  # read it all: exact
    # A ``text.reset`` event the entry bound dropped: still a reset for earlier readers.
    ring = TurnEventRing(max_entries=8)
    ring.append(TurnStartEvent(turn_id="turn-reset"))         # 1
    ring.append(TextDeltaEvent(text="old"))                   # 2
    ring.append(TextResetEvent())                             # 3
    for index in range(10):                                   # 4..13
        ring.append(StepStartEvent(step={"index": index, "kind": "tool", "tool": "log_stats", "label": "x"}))
    ring.append(TextDeltaEvent(text="new"))                   # 14
    assert not [e for e in ring.entries if getattr(e.get("event"), "type", "") == "text.reset"]
    assert ring.text_gap_seq == 3
    assert _apply(ring.after(2), "old")[0] == "new"           # never "oldnew"


def test_an_engine_text_reset_clears_the_gap_and_the_text_totals() -> None:
    ring = TurnEventRing(max_text_chars=1_000, max_text_deltas=1_000_000)
    ring.append(TurnStartEvent(turn_id="turn-engine-reset"))
    _stream(ring, 5_000, 10)
    assert ring.text_gap_seq > 0
    reset_seq = ring.append(TextResetEvent())
    assert (ring.text_gap_seq, ring.text_chars, ring.text_deltas) == (0, 0, 0)
    ring.append(TextDeltaEvent(text="Again"))
    lines = ring.after(5)
    assert [(s, e.type) for s, e in lines if e.type == "text.reset"] == [(reset_seq, "text.reset")]
    assert _apply(lines, "stale text")[0] == "Again"


async def test_the_rejoin_endpoint_sends_the_reset_line() -> None:
    handle = ChatTurnHandle(turn_id="turn-rejoin", owner="ann",
                            ring=TurnEventRing(max_text_chars=2_000, max_text_deltas=1_000_000))
    handle.emit(TurnStartEvent(turn_id="turn-rejoin"))
    original = ""
    for index in range(1_000):
        piece = f"{index:04d}."
        handle.emit(TextDeltaEvent(text=piece))
        original += piece
    handle.done(ChatResponse(answer=original))
    handle.finish()
    gap = handle.ring.text_gap_seq
    assert gap > 1
    lines: list[dict[str, Any]] = []
    async for raw in _reattach(handle, 10):
        payload = json.loads(raw)
        if payload["type"] != "ping":
            lines.append(payload)
    assert [line for line in lines if line["type"] == "text.reset"] == [{"type": "text.reset", "seq": gap}]
    assert [line["seq"] for line in lines] == sorted(line["seq"] for line in lines)
    tail = "".join(line["text"] for line in lines if line["type"] == "text.delta")
    assert original.endswith(tail) and len(tail) == handle.ring.text_chars
    assert lines[-1]["type"] == "turn.done" and lines[-1]["response"]["answer"] == original
