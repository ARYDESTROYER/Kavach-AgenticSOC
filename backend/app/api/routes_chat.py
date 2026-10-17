"""Chat turn routes: streaming, Stop, the live token meter and "Ask about this".

Chat revamp SPEC §6 (streaming lifecycle, events, Stop and recovery), §4.2
(concurrency bounds), §4.5 (first-call failures), §4.6 (the case-scoped entry
point), §8 (``/chat/context``, whose starters are the static evergreen set since Round 13;
the dynamic ones are ``GET /api/chat/starters``) and §10.7 (topics).

ONE engine, two entry points (#5): ``POST /api/chat`` (blocking, in ``routes.py``)
and ``POST /api/chat/stream`` (NDJSON) both call :func:`run_chat_turn`, which

1. runs every check that can fail BEFORE a response starts — auth (the route
   dependency), the caller's grants (``resolve_grants``: no audit rows), the
   per-user and global concurrency admission (429 ``chat_busy``), body validation
   (model choice), the conversation lookup, the idempotency reservation (including
   the completed-key replay) and source resolution — so a stream never answers 200
   and then fails on something the blocking route reports as an HTTP error;
2. starts the turn as a task in the process-local :class:`ChatTurnRegistry`. The
   task owns the reservation, the per-request source client and persistence, and
   holds ``state.mutation_gate.admit()`` for its whole life; the HTTP response only
   relays its queue. A client that disconnects does not stop the turn: it completes,
   persists, and a retry with the same key replays it (409 + ``retry_after`` until
   then). Stop is server-side (``POST /api/chat/turns/{id}/cancel``). A factory reset
   cancels every registered turn before draining; such a turn persists nothing.

Round 12 (SPEC D1, D6, D11, D13, §3.2, §3.6):

* **Lease heartbeat.** A Workspace reservation is owned for :data:`TURN_LEASE_SECONDS`
  and renewed every :data:`TURN_HEARTBEAT_S` while the turn runs (the owner's small
  live-state document, never the transcript), so a turn of any length keeps its key —
  a same-key retry gets 409 + ``retry_after`` naming the running ``turn_id`` and
  ``conversation_id``, and re-attaches — while a crashed process's lease still
  expires. A BILLED turn that could not be saved ENDS its reservation: the key stays
  held for a full lease (never billed twice) but nothing reads ``running``.
* **Re-attach.** Every relayed event also enters the turn's bounded
  :class:`TurnEventRing`; ``GET /api/chat/turns/{id}/events?after=<seq>`` replays it
  (text deltas coalesced) and tails it live to the terminal event, and finished turns
  stay readable for :data:`RECENT_TURN_TTL_S`. ``GET /api/chat/turns/active`` lists the
  caller's running turns. Both are owner-checked and process-local, like the registry.
* **``chat.turn`` frames** (started, progress, finished, failed, needs_input) are
  published on the ``chat`` topic to the owner only (``realtime.publish_chat_turn``):
  engine labels and counts, never prompt, answer or log text, and never retained in
  the bus's replay ring. Anonymous subscribers (auth disabled) never receive them;
  that client polls ``turns/active``. ``POST /api/chat/turns/{id}/seen`` publishes an
  owner-only ``chat.read`` frame naming a turn whose outcome is on screen, so the
  owner's other consoles drop its mark (it stores nothing). Turns, their event rings and Stop are bound to
  the owner's ACCOUNT generation (a deleted and re-created username sees none of its
  predecessor's turns), and a reset or shutdown forgets finished turns' rings.
* **Concurrency** comes from ``ChatAgentConfig`` (defaults 4 per user, 16 per
  backend); a refusal is 429 ``chat_busy`` with ``retry_after``, ``scope`` and
  ``limit``.
* **Conversation summary** (D4): the stored summary is loaded and handed to the engine
  (``summary_text``/``summary_covers_through``); a new one in the turn outcome is
  stored on the conversation. **Step observations**: the outcome's per-step
  observations go to the owner's ring and each stored step gets ``observation_ref``.
  **Reports** (D11): a final header that asked for a report makes the server save the
  persisted answer as one (``routes_reports.save_answer_as_report``) and return
  ``ChatResponse.saved_report``; a save that could not happen returns
  ``saved_report_error`` (``report_limit``, ``report_unavailable``, ``report_empty``)
  instead, recorded on the answer too. Case-scoped turns never save one.

Persistence (SPEC §7.5) is the store's job; this module decides WHAT is saved: the
D1 rule (a first model call that failed before anything was billed is answered with
its notice and saves nothing), Stop (saved once a model call was billed, so a retry
replays it; aborted otherwise), the user message's ``origin`` (taint rules replay it)
and the conversation's last time window. Case-scoped turns never enter Workspace
history; their case-thread append is deduplicated by the idempotency key inside the
engine, and they are not auto-replayed by the client after a lost connection (a
replay would bill the model again; the client offers Retry instead).
"""

from __future__ import annotations

import asyncio
import bisect
import functools
import inspect
import json
import logging
import math
import re
import time
from array import array
from collections import OrderedDict
from dataclasses import dataclass, field, is_dataclass, replace
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from ..agents.chat import TurnOutcome
from ..agents.chat_events import (
    MAX_TEXT_DELTA_CHARS,
    NDJSON_CONTENT_TYPE,
    PING_INTERVAL_S,
    STREAM_HEADERS,
    ChatStreamEventModel,
    PingEvent,
    StepStartEvent,
    TextDeltaEvent,
    TextResetEvent,
    TurnDoneEvent,
    TurnErrorEvent,
    TurnStartEvent,
    encode_event,
)
from ..agents.chat_protocol import PriorExchange, render_replay, select_replay, turn_error_code
from ..config import ModelConfig, Preferences
from ..constants import ActionType
from ..engine.mutation_gate import MutationAdmissionClosed
from ..models import (
    CHAT_TOPIC_MAX_CHARS,
    CONSOLE_TOPIC_ID_PATTERN,
    ChatActiveTurn,
    ChatBudgetInfo,
    ChatContextBounds,
    ChatContextInfo,
    ChatConversation,
    ChatRates,
    ChatRequest,
    ChatReportSaveError,
    ChatResponse,
    ChatSavedReport,
    ChatTopicQuestion,
    DiscoverLink,
    TextStreamingInfo,
)
from ..state import AppState, ChatSourceUnavailable
from ..stores.chat_conversations import (
    ChatConversationMissing,
    ChatExchangeReservation,
    ChatHistoryUnavailable,
    ChatIdempotencyConflict,
    ChatRequestCapacityBusy,
    ChatRequestFailed,
    ChatRequestInProgress,
    IDEMPOTENCY_PENDING_TTL_SECONDS,
    normalize_user_id,
)
from ..realtime import publish_chat_read, publish_chat_turn
from ..stores.sessions import SessionStore
from ..utils import iso_now, new_id, now_utc
from .deps import (
    _bearer,
    access_view_for,
    current_username,
    get_state,
    live_session_limits,
    require_permission,
)

logger = logging.getLogger("tlsoc.api.chat")

router = APIRouter(prefix="/api")

# --------------------------------------------------------------------------- #
# Constants.
# --------------------------------------------------------------------------- #
# Seconds a client should wait before retrying a refused turn. Busy (429) waits for
# a running turn to finish; in-progress (409) polls for the replay to appear.
CHAT_BUSY_RETRY_AFTER_S = 5
IN_PROGRESS_RETRY_AFTER_S = 2
# Round 12 turn lease (SPEC D1, ``diagnosis/limits.md`` R2): a Workspace reservation is
# owned for TURN_LEASE_SECONDS and the running turn renews it every
# TURN_HEARTBEAT_S, so a turn of ANY length keeps its key (a same-key retry waits)
# and a crashed process's lease still expires on its own. Module-level for tests.
TURN_HEARTBEAT_S: float = 60.0
TURN_LEASE_SECONDS = IDEMPOTENCY_PENDING_TTL_SECONDS
# Round 12 reattach (SPEC D13): a finished turn's event ring stays readable this long
# (and at most this many finished turns per process), so a client that reconnects just
# after the end still gets the terminal event.
RECENT_TURN_TTL_S = 300.0
MAX_RECENT_TURNS = 256
# The per-turn event ring keeps at most this many entries (consecutive text deltas are
# coalesced into text entries, usage and step.progress keep only their latest) …
TURN_RING_MAX_ENTRIES = 2_000
# … and at most this much answer text: characters, and text deltas (one seq marker
# each). Coalescing means the entry count alone never bounds the text an unlimited
# answer streams, so these do (PR #131 review). A million characters is about 250,000
# tokens, far beyond any one answer; a streamed delta is typically one token (about
# four characters). Past either bound the OLDEST text is dropped, one segment of
# 1/TURN_RING_TEXT_SEGMENTS of the bound at a time (a text entry closes once it holds
# that much), and a rejoin that had not yet read the dropped text gets a ``text.reset``
# in its place: its text restarts from the retained tail, never spliced across the
# hole, and its ``turn.done`` still carries the whole persisted answer. The text bound
# counts characters, not bytes: CPython stores a string at 1, 2 or 4 bytes per
# character (the widest character in it decides), so per ring that is 1 to 4 MB of text
# plus about 1 MB of markers (4 bytes each). A finished turn kept for re-attach
# (RECENT_TURN_TTL_S) also keeps its terminal ``turn.done``, which carries the whole
# saved answer (the same object as the handle's ``response``); that answer is not
# bounded here.
TURN_RING_MAX_TEXT_CHARS = 1_000_000
TURN_RING_MAX_TEXT_DELTAS = 250_000
TURN_RING_TEXT_SEGMENTS = 16
# chat.turn progress frames are published at most this often per turn.
TURN_PROGRESS_PUBLISH_S = 1.0
# The idle interval between ``ping`` lines (module-level so tests can shorten it).
STREAM_PING_INTERVAL_S: float = float(PING_INTERVAL_S)
# /chat/context is cached per principal (SPEC §8) and invalidated when a turn ends.
CONTEXT_CACHE_TTL_S = 30.0
CONTEXT_CACHE_MAX_ENTRIES = 512
# The meter's calibration is a ratio; one odd turn must not swing it wildly.
CALIBRATION_BOUNDS = (0.25, 4.0)
CHARS_PER_TOKEN = 4
# Response fields that are presentation-only metadata, kept with the stored answer
# so the meter can calibrate against this conversation's last turn.
ESTIMATE_KEY = "estimate_prompt_tokens"

_SAFE_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,128}$"
_SAFE_ID_RE = re.compile(_SAFE_ID_PATTERN)
_TOPIC_ID_PATTERN = CONSOLE_TOPIC_ID_PATTERN
_PROVIDERS = frozenset({"anthropic", "openai", "mock", "azure", "bedrock", "vertex", "openai_compatible"})
_RESET_MESSAGE = "A maintenance reset stopped this answer before it was saved. Try again shortly."
_INTERNAL_MESSAGE = "The answer could not be completed. Try again."
_HISTORY_MESSAGE = "The answer was written but could not be saved to your history. Try again."
# A billed answer whose save failed keeps its reservation (SPEC §6.4: never aborted
# once billed), so the same key only waits; the honest next step is a new request.
_HISTORY_BILLED_MESSAGE = (
    "The answer was written but could not be saved to your history. "
    "Ask again to start a new request."
)
_BILLED_INTERNAL_MESSAGE = "The answer could not be completed. Ask again to start a new request."
_CONFLICT_MESSAGE = "The conversation changed while the response was being saved."

_END = object()  # queue sentinel: the turn task finished

# A running turn acts for its owner only while the authority it was admitted with
# lasts (Round 12 final review, L1). Why it was stopped:
# * ``session_ended`` — the session that started it was revoked (sign-out, an admin
#   revoke, sign out everywhere, refresh-token reuse) or expired, or the account was
#   disabled, deleted or replaced by a new account of the same name;
# * ``access_changed`` — the owner no longer holds every grant the turn was admitted
#   with (a role or custom-role change, or an RBAC matrix edit).
STOP_SESSION_ENDED = "session_ended"
STOP_ACCESS_CHANGED = "access_changed"
_SESSION_ENDED_MESSAGE = (
    "Your session ended, so this answer was stopped before it finished. Sign in again to ask."
)
_ACCESS_CHANGED_MESSAGE = (
    "Your access changed, so this answer was stopped before it finished. "
    "Ask again to use your current access."
)
# The pull check (``_drive``) runs before every model step and lookup batch: on the
# first ``step.start`` of each run of them (one batch announces all its lookups at
# once, so it costs one check). Explicit revocations do not wait for it: they stop the
# turn at once (``stop_chat_turns_for``).


# --------------------------------------------------------------------------- #
# The turn registry (process-local; SPEC §4.2, §6.1(b), §6.4).
# --------------------------------------------------------------------------- #
class ChatTurnBusy(RuntimeError):
    """A per-user or global concurrency bound is reached (HTTP 429 ``chat_busy``)."""

    def __init__(self, scope: str) -> None:
        super().__init__(scope)
        self.scope = scope


# Text entry seq markers (offsets inside one text entry) as 4-byte unsigned ints: a
# marker per streamed delta, so a list of Python ints would cost ~9x the memory.
_ENDS_TYPECODE = "I" if array("I").itemsize >= 4 else "L"


class TurnEventRing:
    """The bounded per-turn event ring a client re-attaches to (Round 12, SPEC D13).

    Every relayed event gets the next ``seq`` (1, 2, 3 … — the line number of a
    ``POST /chat/stream`` relay that was attached from the start, pings excluded).
    Consecutive ``text.delta`` events are stored as text entries that remember where
    each seq ended, so a replay ``after`` any seq resumes mid-answer exactly; a
    ``text.reset`` drops the text before it; ``usage`` and ``step.progress`` keep only
    their latest value (per step). Past :data:`TURN_RING_MAX_ENTRIES` the oldest
    entries after ``turn.start`` are dropped; the terminal event is always kept.

    The answer text is bounded too (PR #131 review): at most ``max_text_chars``
    characters in at most ``max_text_deltas`` deltas, plus the delta that crossed the
    bound. A text entry closes once it holds 1/:data:`TURN_RING_TEXT_SEGMENTS` of
    either bound, and past a bound the OLDEST text entries are dropped whole, so the
    seq bookkeeping of every retained entry stays exact and no append ever shifts
    the whole text. Any drop sets ``gap``. Dropped answer text (a text entry, or a
    ``text.reset`` event the entry bound dropped) raises ``text_gap_seq`` to its last
    seq; a reader ``after`` a seq below it is sent ONE ``text.reset`` tagged
    ``text_gap_seq`` in its place (in seq order), so it discards the text it holds and
    continues from the retained tail instead of splicing text across the hole. A
    reader at or past ``text_gap_seq`` had read everything that was dropped and
    resumes exactly. A ``text.reset`` from the engine clears ``text_gap_seq``: that
    retained event tells every earlier reader to discard its text."""

    def __init__(
        self,
        max_entries: int = TURN_RING_MAX_ENTRIES,
        max_text_chars: int = TURN_RING_MAX_TEXT_CHARS,
        max_text_deltas: int = TURN_RING_MAX_TEXT_DELTAS,
    ) -> None:
        self.seq = 0
        self.max_entries = max(8, int(max_entries))
        self.max_text_chars = max(1, int(max_text_chars))
        self.max_text_deltas = max(1, int(max_text_deltas))
        self._segment_chars = max(1, self.max_text_chars // TURN_RING_TEXT_SEGMENTS)
        self._segment_deltas = max(1, self.max_text_deltas // TURN_RING_TEXT_SEGMENTS)
        self.entries: list[dict[str, Any]] = []
        self.gap = False
        self.terminal_seq: int | None = None
        # The answer text held now (every text entry), and the last seq of answer text
        # the ring dropped (0: nothing a reader still needs was dropped).
        self.text_chars = 0
        self.text_deltas = 0
        self.text_gap_seq = 0

    def append(self, event: BaseModel) -> int:
        self.seq += 1
        seq = self.seq
        kind = getattr(event, "type", "")
        if kind == "text.delta":
            text = str(getattr(event, "text", "") or "")
            last = self.entries[-1] if self.entries else None
            if (last is not None and last["kind"] == "text"
                    and len(last["text"]) < self._segment_chars
                    and len(last["ends"]) < self._segment_deltas):
                last["text"] += text
                last["ends"].append(len(last["text"]))
                last["last"] = seq
            else:
                self.entries.append({"kind": "text", "first": seq, "last": seq, "text": text,
                                     "ends": array(_ENDS_TYPECODE, [len(text)])})
            self.text_chars += len(text)
            self.text_deltas += 1
            self._bound_text()
            self._bound_entries()
            return seq
        if kind == "text.reset":
            self.entries = [e for e in self.entries if e["kind"] != "text"]
            self.text_chars = self.text_deltas = 0
            self.text_gap_seq = 0
        elif kind == "usage":
            self.entries = [e for e in self.entries if getattr(e.get("event"), "type", "") != "usage"]
        elif kind == "step.progress":
            index = getattr(event, "index", None)
            self.entries = [
                e for e in self.entries
                if not (getattr(e.get("event"), "type", "") == "step.progress"
                        and getattr(e.get("event"), "index", None) == index)
            ]
        self.entries.append({"kind": "event", "seq": seq, "event": event})
        if kind in ("turn.done", "turn.error"):
            self.terminal_seq = seq
        self._bound_entries()
        return seq

    def _bound_text(self) -> None:
        """Drop the oldest text entries while the text is over a bound, never the
        newest one (the entry the stream is writing; it alone stays under a bound plus
        one delta)."""
        while self.text_chars > self.max_text_chars or self.text_deltas > self.max_text_deltas:
            index = next((i for i, e in enumerate(self.entries) if e["kind"] == "text"), None)
            if index is None or index == len(self.entries) - 1:
                return
            self._dropped(self.entries.pop(index))

    def _bound_entries(self) -> None:
        while len(self.entries) > self.max_entries:
            # Keep turn.start (the first entry) and the terminal event (the last).
            drop = 1 if len(self.entries) > 1 and getattr(self.entries[0].get("event"), "type", "") == "turn.start" else 0
            self._dropped(self.entries.pop(drop))

    def _dropped(self, entry: dict[str, Any]) -> None:
        self.gap = True
        if entry["kind"] == "text":
            self.text_chars -= len(entry["text"])
            self.text_deltas -= len(entry["ends"])
            self.text_gap_seq = max(self.text_gap_seq, entry["last"])
        elif getattr(entry.get("event"), "type", "") == "text.reset":
            self.text_gap_seq = max(self.text_gap_seq, entry["seq"])

    def after(self, after_seq: int) -> list[tuple[int, BaseModel]]:
        """``(seq, event)`` lines for everything after ``after_seq``. A text run comes
        back as ``text.delta`` chunks of at most :data:`MAX_TEXT_DELTA_CHARS` that are
        cut ONLY at original delta boundaries, each tagged with the seq of the last
        delta it ends with, so resuming ``after`` any tag a client saw continues
        exactly where that chunk ended (no gap, no repeat). Original deltas are never
        longer than that bound (``TextDeltaEvent`` refuses it); one that somehow were
        is split, its leading pieces tagged with the seq BEFORE it — a resume then
        repeats that piece rather than skipping text.

        A reader ``after`` a seq below ``text_gap_seq`` missed answer text the ring has
        dropped: it gets ONE ``text.reset`` tagged ``text_gap_seq``, in seq order (every
        retained text entry is newer), before the retained text."""
        out: list[tuple[int, BaseModel]] = []
        gap = self.text_gap_seq if after_seq < self.text_gap_seq else 0
        for entry in self.entries:
            if gap and (entry["seq"] if entry["kind"] == "event" else entry["first"]) > gap:
                out.append((gap, TextResetEvent()))
                gap = 0
            if entry["kind"] == "event":
                if entry["seq"] > after_seq:
                    out.append((entry["seq"], entry["event"]))
                continue
            if entry["last"] <= after_seq:
                continue
            ends: array = entry["ends"]
            first: int = entry["first"]
            text: str = entry["text"]
            # ``index``: the first original delta not yet sent; ``position`` its start.
            index = 0 if after_seq < first else after_seq - first + 1
            position = ends[index - 1] if index > 0 else 0
            while index < len(ends):
                limit = position + MAX_TEXT_DELTA_CHARS
                # The last whole delta that still fits under the chunk bound.
                last = bisect.bisect_right(ends, limit, lo=index) - 1
                if last >= index:
                    out.append((first + last, TextDeltaEvent(text=text[position:ends[last]])))
                    position, index = ends[last], last + 1
                    continue
                # A single delta longer than the bound (never expected): send its first
                # piece tagged with the previous seq, so a resume repeats, never skips.
                out.append((first + index - 1, TextDeltaEvent(text=text[position:limit])))
                position = limit
                if position >= ends[index]:
                    index += 1
        if gap:
            out.append((gap, TextResetEvent()))
        return out


def encode_ring_line(seq: int, event: BaseModel) -> bytes:
    """One re-attach NDJSON line: the event plus its ``seq`` (clients that parse
    the stream contract ignore the extra key; the re-attaching client resumes with
    ``after=<last seq seen>``)."""
    payload = event.model_dump(mode="json")
    payload["seq"] = int(seq)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


class _Signal:
    """A level-triggered wake-up for re-attached readers: ``waiter()`` returns the
    current event, ``fire()`` sets it and installs a fresh one. A reader that takes
    its waiter BEFORE reading the ring can never miss an append."""

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def waiter(self) -> asyncio.Event:
        return self._event

    def fire(self) -> None:
        event, self._event = self._event, asyncio.Event()
        event.set()


# The engine's own model-step labels (the only model-step labels the indicator shows).
_MODEL_LABELS = frozenset({
    "Thinking", "Writing the answer", "Wrote the answer", "Planned lookups",
    "Reply format corrected", "Model call failed",
})


def _activity_label(step: Any) -> str | None:
    """An ENGINE-template label for the activity indicator (never model or log text):
    a registered tool's own label, or one of the engine's model-step labels."""
    kind = getattr(step, "kind", None)
    if kind == "model":
        label = getattr(step, "label", "")
        return label if label in _MODEL_LABELS else "Thinking"
    tool_name = getattr(step, "tool", None)
    if isinstance(tool_name, str) and tool_name:
        try:
            from ..agents.chat_tools.registry import get_tool

            tool = get_tool(tool_name)
        except Exception:  # noqa: BLE001 -- the indicator degrades to a generic label
            tool = None
        label = getattr(tool, "label", None) if tool is not None else None
        if isinstance(label, str) and label:
            return label[:120]
    return "Looking something up"


@dataclass(eq=False)
class ChatTurnHandle:
    """One running turn: its event queue, Stop flag and outcome.

    The task appends events; the stream response relays them. ``detached`` is set
    once the response stopped reading (client gone), after which events are dropped
    from the QUEUE rather than queued for nobody — they still enter ``ring``, the
    bounded per-turn event ring ``GET /chat/turns/{id}/events`` replays (Round 12).
    ``response`` is the final (persisted) response, ``error`` the terminal
    ``turn.error`` and ``http_error`` what the blocking route raises for it."""

    turn_id: str
    owner: str
    idempotency_key: str | None = None
    case_id: str | None = None
    # The owner's ACCOUNT generation (``engine.jobs.account_generation``): a username
    # can be deleted and created again, and the new account must never see, re-attach
    # to or stop its predecessor's turns. ``""`` with auth off (the shared profile).
    generation: str = ""
    # What a synthesised ``turn.start`` names when the turn fails before the engine
    # emitted its own (SPEC §6.2: ``turn.start`` is always the first line).
    conversation_id: str | None = None
    model: str | None = None
    stream_mode: str = "steps"
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    detached: bool = False
    reset_cancelled: bool = False
    # Set on the first line of the task body. A task cancelled BEFORE that never runs
    # its try/finally (CancelledError is thrown into an unstarted coroutine), so
    # ``cancel_all`` only hard-cancels running turns and flags the others.
    running: bool = False
    start_sent: bool = False
    response: ChatResponse | None = None
    error: TurnErrorEvent | None = None
    http_error: HTTPException | None = None
    started: float = field(default_factory=time.monotonic)
    # --- Round 12 (SPEC D13): re-attach ring, live progress, owner-only frames. ---
    ring: TurnEventRing = field(default_factory=TurnEventRing)
    signal: _Signal = field(default_factory=_Signal)
    started_at: str = field(default_factory=iso_now)
    label: str = "Thinking"
    lookups: int = 0
    tokens: int = 0
    finished_at: float | None = None
    # ``publish(handle, phase, retain)`` — set by ``run_chat_turn`` to the active bus.
    publisher: Any = None
    _last_progress: float = 0.0
    # --- The authority the turn was admitted with (Round 12 final review, L1). ---
    # The principal as signed in (``owner`` is its normalised form), the session id
    # and token version its access token carried (``None`` for a token without them),
    # that token's ``exp`` (epoch seconds; the fallback end of the sign-in when the
    # session row does not record it), and the grants the turn's tools were resolved
    # with. ``stop_reason`` is set when that authority ended (``STOP_SESSION_ENDED`` /
    # ``STOP_ACCESS_CHANGED``); ``forget`` keeps the stopped turn's event ring out of
    # the re-attach cache.
    author: str = ""
    sid: str | None = None
    token_version: int | None = None
    token_expires_at: float | None = None
    grants: frozenset = frozenset()
    stop_reason: str | None = None
    forget: bool = False

    def emit(self, event: BaseModel) -> None:
        if isinstance(event, TurnStartEvent):
            self.start_sent = True
            if event.conversation_id and not self.conversation_id:
                self.conversation_id = event.conversation_id
        self.ring.append(event)
        self._track(event)
        if not self.detached:
            self.queue.put_nowait(event)
        self.signal.fire()

    def _track(self, event: BaseModel) -> None:
        """Live progress for ``GET /chat/turns/active`` and ``chat.turn`` frames:
        engine labels and counts only."""
        kind = getattr(event, "type", "")
        changed = False
        if kind in ("step.start", "step.end"):
            step = getattr(event, "step", None)
            label = _activity_label(step)
            if label and label != self.label:
                self.label, changed = label, True
            if kind == "step.end" and getattr(step, "kind", None) == "tool":
                self.lookups += 1
                changed = True
        elif kind == "usage":
            totals = getattr(event, "totals", None)
            tokens = getattr(totals, "total_tokens", None)
            if isinstance(tokens, int) and tokens >= 0 and tokens != self.tokens:
                self.tokens, changed = tokens, True
        elif kind == "text.delta" and self.label != "Writing the answer":
            self.label, changed = "Writing the answer", True
        if changed:
            now = time.monotonic()
            if now - self._last_progress >= TURN_PROGRESS_PUBLISH_S:
                self._last_progress = now
                self.publish("progress", retain=False)

    def publish(self, phase: str, *, retain: bool = False) -> None:
        if self.publisher is None:
            return
        try:
            self.publisher(self, phase, retain)
        except Exception as exc:  # noqa: BLE001 -- the indicator never fails a turn
            logger.debug("chat.turn publish failed (%s)", type(exc).__name__)

    def active_view(self) -> ChatActiveTurn:
        return ChatActiveTurn(
            turn_id=self.turn_id, conversation_id=self.conversation_id, case_id=self.case_id,
            started_at=self.started_at, label=self.label[:120], lookups=self.lookups,
            tokens=self.tokens, status="running",
        )

    def done(self, response: ChatResponse) -> None:
        """The terminal ``turn.done`` (the persisted response is the truth)."""
        self.response = response
        self.emit(TurnDoneEvent(response=response))

    def fail(
        self, code: str, message: str, *, retryable: bool, http: HTTPException | None,
        notice: Any = None, response: ChatResponse | None = None,
    ) -> None:
        """The terminal ``turn.error``. ``response`` is what the blocking route still
        answers with (the D1 notice response); ``http`` what it raises otherwise."""
        if self.error is not None or (self.response is not None and response is None):
            return
        if not self.start_sent:
            # The turn failed before the engine's first event (a reset racing the
            # start, an unreadable stored history): the stream still opens with
            # ``turn.start`` so the client learns the turn id (Stop) and the contract
            # "turn.start first, turn.done/turn.error last" holds.
            self.emit(TurnStartEvent(
                turn_id=self.turn_id, conversation_id=self.conversation_id, model=self.model,
                stream_mode=self.stream_mode if self.stream_mode in ("steps", "text") else "steps",
            ))
        self.error = TurnErrorEvent(code=code, message=message, retryable=retryable, notice=notice)
        self.http_error = http
        if response is not None:
            self.response = response
        self.emit(self.error)

    def finish(self) -> None:
        if not self.finished.is_set():
            self.finished_at = time.monotonic()
            self.finished.set()
            self.queue.put_nowait(_END)
            self.signal.fire()
            if self.error is not None:
                phase = "failed"
            elif self.response is not None and self.response.clarify is not None:
                phase = "needs_input"
            else:
                phase = "finished"
            self.publish(phase)


class _Slot:
    """One admitted concurrency slot, released exactly once."""

    def __init__(self, registry: "ChatTurnRegistry", owner: str) -> None:
        self._registry = registry
        self._owner = owner
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._registry.release(self._owner)


class ChatTurnRegistry:
    """Strong references to every running chat turn, plus admission and Stop.

    Process-local by design (SPEC §4.2: "process-local semaphore registry"): the
    supported runtime is one backend process. Counting is synchronous, so an admit
    check and its increment can never interleave with another request."""

    def __init__(self) -> None:
        self._turns: dict[str, ChatTurnHandle] = {}
        # Round 12: finished turns whose event ring is still readable (re-attach just
        # after the end), oldest first; bounded by count and RECENT_TURN_TTL_S.
        self._recent: OrderedDict[str, ChatTurnHandle] = OrderedDict()
        self._per_owner: dict[str, int] = {}
        self._active = 0
        # Strong references to the cleanup a turn task needs when it ended without
        # running its own ``finally`` (see ``_on_turn_task_done``).
        self._cleanups: set[asyncio.Task] = set()
        # /chat/context cache: key -> (expires monotonic, info). Lives here so it is
        # per AppState and is invalidated when one of the owner's turns ends.
        self.context_cache: dict[tuple[Any, ...], tuple[float, ChatContextInfo]] = {}

    # --- admission ---------------------------------------------------------- #
    def acquire(self, owner: str, *, per_user: int, global_limit: int) -> _Slot:
        if self._active >= max(1, int(global_limit)):
            raise ChatTurnBusy("global")
        if self._per_owner.get(owner, 0) >= max(1, int(per_user)):
            raise ChatTurnBusy("user")
        self._per_owner[owner] = self._per_owner.get(owner, 0) + 1
        self._active += 1
        return _Slot(self, owner)

    def release(self, owner: str) -> None:
        count = self._per_owner.get(owner, 0) - 1
        if count > 0:
            self._per_owner[owner] = count
        else:
            self._per_owner.pop(owner, None)
        self._active = max(0, self._active - 1)

    @property
    def active(self) -> int:
        return self._active

    # --- turns -------------------------------------------------------------- #
    def register(self, handle: ChatTurnHandle) -> None:
        self._turns[handle.turn_id] = handle

    def unregister(self, handle: ChatTurnHandle) -> None:
        if self._turns.get(handle.turn_id) is handle:
            self._turns.pop(handle.turn_id, None)
            self._remember(handle)

    def _remember(self, handle: ChatTurnHandle) -> None:
        if handle.reset_cancelled or handle.forget:
            # A reset's turns are never replayed (see ``cancel_all``), nor a turn
            # stopped because its owner's account ended (see ``stop_owner``).
            return
        self._recent[handle.turn_id] = handle
        self._recent.move_to_end(handle.turn_id)
        self._prune_recent()

    def _prune_recent(self) -> None:
        now = time.monotonic()
        while self._recent:
            oldest = next(iter(self._recent.values()))
            ended = oldest.finished_at if oldest.finished_at is not None else now
            if len(self._recent) > MAX_RECENT_TURNS or now - ended > RECENT_TURN_TTL_S:
                self._recent.popitem(last=False)
                continue
            break

    def get(self, turn_id: str) -> ChatTurnHandle | None:
        return self._turns.get(turn_id)

    def find(self, turn_id: str, owner: str, generation: str = "") -> ChatTurnHandle | None:
        """The caller's own running or recently finished turn (Round 12 re-attach);
        ``None`` for anyone else's — including a deleted account's turn seen by a new
        account of the same name (ownership is indistinguishable from absence)."""
        self._prune_recent()
        handle = self._turns.get(turn_id) or self._recent.get(turn_id)
        if handle is None or handle.owner != owner or handle.generation != generation:
            return None
        return handle

    def running(self) -> list[ChatTurnHandle]:
        return list(self._turns.values())

    def active_for(self, owner: str) -> int:
        return self._per_owner.get(owner, 0)

    def running_for(self, owner: str, generation: str = "") -> list[ChatTurnHandle]:
        """The caller's own turns still running, oldest first (``turns/active``)."""
        return sorted(
            (
                h for h in self._turns.values()
                if h.owner == owner and h.generation == generation and not h.finished.is_set()
            ),
            key=lambda h: h.started,
        )

    def running_with_key(self, owner: str, key: str, generation: str = "") -> ChatTurnHandle | None:
        """The caller's own running turn that holds idempotency key ``key``."""
        return next(
            (
                h for h in self._turns.values()
                if h.owner == owner and h.generation == generation and h.idempotency_key == key
                and not h.finished.is_set()
            ),
            None,
        )

    def request_stop(self, turn_id: str, owner: str, generation: str = "") -> bool:
        """Set the Stop flag of the caller's own running turn (SPEC §6.4). The
        in-flight step finishes and is recorded; no new step starts."""
        handle = self._turns.get(turn_id)
        if (
            handle is None or handle.owner != owner or handle.generation != generation
            or handle.finished.is_set()
        ):
            return False
        handle.cancel_event.set()
        return True

    def track_cleanup(self, task: asyncio.Task) -> None:
        self._cleanups.add(task)
        task.add_done_callback(self._cleanups.discard)

    # --- authority ended (Round 12 final review, L1) ------------------------ #
    def owner_turns(self, owner: str) -> list[ChatTurnHandle]:
        """Every turn of ``owner`` still running, in ANY account generation (a
        deleted account's turns are stopped with it)."""
        return [h for h in self._turns.values() if h.owner == owner and not h.finished.is_set()]

    async def stop_owner(
        self, owner: str, *, generation: str | None = None, sid: str | None = None,
        except_sid: str | None = None, reason: str = STOP_SESSION_ENDED,
        timeout: float = 10.0,
    ) -> int:
        """Stop the running turns of ``owner`` whose authority ended, and wait
        (bounded) for each to unwind. ``sid`` limits it to the turns that session
        started (a single-session sign-out or revoke); ``except_sid`` to every OTHER
        session's turns ("sign out other devices"); ``generation`` to one account.

        Each turn is stopped like a reset stops it (``cancel_all``): a RUNNING turn is
        hard-cancelled at its current await (an in-flight model call or lookup is
        abandoned), one not yet started is flagged and stops on its first step. It
        saves nothing, makes no further model call or lookup, and its stream ends with
        a non-retryable ``turn.error`` saying why. When the whole account is affected
        (no ``sid``/``except_sid``), the owner's finished turns' event rings are
        forgotten too, so nothing they wrote can be replayed."""
        handles = [
            h for h in self.owner_turns(owner)
            if (generation is None or h.generation == generation)
            and (sid is None or h.sid == sid)
            and (except_sid is None or (h.sid is not None and h.sid != except_sid))
        ]
        account_wide = sid is None and except_sid is None
        if account_wide:
            for turn_id in [
                k for k, h in self._recent.items()
                if h.owner == owner and (generation is None or h.generation == generation)
            ]:
                self._recent.pop(turn_id, None)
        return await self.stop(handles, reason=reason, forget=account_wide, timeout=timeout)

    async def stop(
        self, handles: list[ChatTurnHandle], *, reason: str, forget: bool = False,
        timeout: float = 10.0,
    ) -> int:
        """Stop ``handles`` because their authority ended (see :meth:`stop_owner`)."""
        handles = [h for h in handles if not h.finished.is_set()]
        for handle in handles:
            handle.stop_reason = handle.stop_reason or reason
            handle.forget = handle.forget or forget
            handle.cancel_event.set()
            if handle.running and handle.task is not None and not handle.task.done():
                handle.task.cancel()
        tasks = [h.task for h in handles if h.task is not None and not h.task.done()]
        if tasks:
            await asyncio.wait(tasks, timeout=max(0.1, timeout))
        return len(handles)

    async def cancel_all(self, *, timeout: float = 10.0) -> int:
        """Stop every registered turn (factory reset, shutdown) and wait, bounded, for
        each to abort its reservation and release its resources.

        A RUNNING turn is hard-cancelled: CancelledError lands at its current await,
        inside its try, so it aborts and settles. A turn whose task has not taken its
        first step is only flagged: cancelling it would throw CancelledError into a
        coroutine that never entered its try/finally, leaving its slot, registration,
        reservation and waiting clients behind. On its first step it sees the flag and
        takes the same abort path a closed gate gives it."""
        handles = [h for h in self._turns.values() if h.task is not None and not h.task.done()]
        for handle in handles:
            handle.reset_cancelled = True
            if handle.running:
                handle.task.cancel()  # type: ignore[union-attr]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.1, timeout)
        if handles:
            await asyncio.wait([h.task for h in handles], timeout=max(0.1, deadline - loop.time()))  # type: ignore[misc]
        # Let the done-callback cleanup of any task that never ran its body finish too.
        cleanups = [task for task in self._cleanups if not task.done()]
        if cleanups:
            await asyncio.wait(cleanups, timeout=max(0.1, deadline - loop.time()))
        # Chat history's background cleanup (documents of conversations retention
        # evicted) finishes too, instead of being dropped with the loop.
        from ..stores.chat_conversations import drain_background_cleanup

        await drain_background_cleanup(timeout=max(0.1, deadline - loop.time()))
        # A reset or shutdown also forgets the finished turns' event rings: their text
        # (partial answers included) must never replay to whoever signs in next.
        self._recent.clear()
        return len(handles)

    # --- /chat/context cache ------------------------------------------------ #
    def context_get(self, key: tuple[Any, ...]) -> ChatContextInfo | None:
        entry = self.context_cache.get(key)
        if entry is None:
            return None
        if entry[0] < time.monotonic():
            self.context_cache.pop(key, None)
            return None
        return entry[1]

    def context_put(self, key: tuple[Any, ...], info: ChatContextInfo) -> None:
        if len(self.context_cache) >= CONTEXT_CACHE_MAX_ENTRIES:
            oldest = min(self.context_cache, key=lambda k: self.context_cache[k][0])
            self.context_cache.pop(oldest, None)
        self.context_cache[key] = (time.monotonic() + CONTEXT_CACHE_TTL_S, info)

    def invalidate_context(self, owner: str) -> None:
        for key in [k for k in self.context_cache if k and k[0] == owner]:
            self.context_cache.pop(key, None)


# --------------------------------------------------------------------------- #
# HTTP error shapes.
# --------------------------------------------------------------------------- #
def _history_http(exc: Exception | None = None) -> HTTPException:
    return HTTPException(status_code=503, detail={
        "code": "chat_history_unavailable",
        "message": (str(exc) if exc else "") or "Chat history is temporarily unavailable.",
    })


def _conflict_http(code: str, message: str, *, retry_after: int | None = None) -> HTTPException:
    detail: dict[str, Any] = {"code": code, "message": message}
    headers = None
    if retry_after is not None:
        # The client reads the body (ApiError exposes no headers), proxies the header.
        detail["retry_after"] = retry_after
        headers = {"Retry-After": str(retry_after)}
    return HTTPException(status_code=409, detail=detail, headers=headers)


def _busy_http(exc: ChatTurnBusy, limit: int | None = None) -> HTTPException:
    """429 ``chat_busy`` (SPEC D6): a capacity bound, never a token limit. The body
    carries ``retry_after`` (the client shows "Waiting for another answer to finish"
    and retries with backoff), the bound's ``scope`` (``user``/``global``) and its
    ``limit``."""
    message = (
        "You already have the maximum number of chat answers running; wait for one to finish."
        if exc.scope == "user"
        else "The assistant is busy with other answers; try again shortly."
    )
    detail: dict[str, Any] = {
        "code": "chat_busy", "message": message, "retry_after": CHAT_BUSY_RETRY_AFTER_S,
        "scope": exc.scope,
    }
    if isinstance(limit, int) and limit > 0:
        detail["limit"] = limit
    return HTTPException(
        status_code=429, detail=detail, headers={"Retry-After": str(CHAT_BUSY_RETRY_AFTER_S)},
    )


def _reset_http() -> HTTPException:
    return HTTPException(status_code=503, detail={
        "code": "factory_reset_in_progress", "message": _RESET_MESSAGE,
    })


def _internal_http() -> HTTPException:
    return HTTPException(status_code=500, detail={
        "code": "chat_internal_error", "message": _INTERNAL_MESSAGE,
    })


class _TurnFailure(Exception):
    """A mapped persistence failure inside the turn task."""

    def __init__(self, code: str, message: str, *, retryable: bool, http: HTTPException) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.http = http


# --------------------------------------------------------------------------- #
# Request identity and model choice (SPEC §3.1).
# --------------------------------------------------------------------------- #
def chat_request_fingerprint(body: ChatRequest) -> str:
    """The idempotency identity: ``routes._chat_request_fingerprint`` (one definition)."""
    from .routes import _chat_request_fingerprint

    return _chat_request_fingerprint(body)


async def _chat_model_config(state: AppState, model_id: str, base: ModelConfig) -> ModelConfig | None:
    """``base`` switched to ``model_id`` when it is an enabled chat model: a bundled
    model the registry declares ``chat`` for (provider from the registry, so custom,
    Azure, Bedrock and Vertex ids route correctly) or an operator-registered custom
    model (its provider and endpoint). None otherwise."""
    from ..llm.pricing import capability_state, provider_for

    if capability_state(model_id, "chat") == "declared":
        provider = provider_for(model_id)
        if provider in _PROVIDERS:
            return base.model_copy(update={"model": model_id, "provider": provider, "base_url": None})
    try:
        row = await state.custom_models.get_model(model_id)
    except Exception:  # noqa: BLE001 -- an unreadable catalogue enables nothing
        row = None
    if isinstance(row, dict):
        provider = str(row.get("provider") or "openai_compatible")
        if provider in _PROVIDERS:
            return base.model_copy(update={
                "model": model_id, "provider": provider, "base_url": row.get("base_url") or None,
            })
    return None


async def _effective_prefs(
    state: AppState, request: Request, body: ChatRequest, grants: frozenset[tuple[str, str]],
) -> Preferences:
    """The execution prefs with this turn's chat model (SPEC §3.1): the configured
    default, or ``body.model`` when it is an enabled chat model (else 422
    ``chat_model_unavailable``) and the caller holds ``models:read`` (else 403)."""
    prefs = state.execution_prefs
    model_id = (body.model or "").strip()
    if not model_id or model_id == prefs.chat_model.model:
        return prefs
    if ("models", "read") not in grants:
        try:
            await state.control_audit.record(
                action_type=ActionType.ACCESS_DENIED, surface="chat",
                actor=current_username(request) or "default",
                result_summary="denied a non-default chat model (requires models:read)",
            )
        except Exception:  # noqa: BLE001 -- the refusal stands without its row
            pass
        raise HTTPException(status_code=403, detail={
            "code": "chat_model_forbidden",
            "message": "Choosing a chat model requires the models:read permission.",
        })
    resolved = await _chat_model_config(state, model_id, prefs.chat_model)
    if resolved is None:
        raise HTTPException(status_code=422, detail={
            "code": "chat_model_unavailable",
            "message": "The selected model is not an enabled chat model.",
        })
    return prefs.model_copy(update={"chat_model": resolved})


# --------------------------------------------------------------------------- #
# Preflight.
# --------------------------------------------------------------------------- #
@dataclass
class _TurnPlan:
    """Everything a turn task needs, resolved before any response starts."""

    body: ChatRequest
    author: str
    owner: str
    grants: frozenset[tuple[str, str]]
    prefs: Preferences
    engine: Any
    store: Any
    persist_workspace: bool
    request_key: str
    fingerprint: str
    existing: ChatConversation | None = None
    reservation: ChatExchangeReservation | None = None
    source_conn: Any = None
    owned_client: Any = None
    source_id: str | None = None
    source_name: str | None = None
    ctx: Any = None
    completed: bool = False
    replay: ChatResponse | None = None
    outcome: TurnOutcome | None = None
    # Round 12: the stored running conversation summary (D4, §3.6) handed to the engine.
    summary: Any = None
    # The caller's account generation (turns are bound to it, see ChatTurnHandle).
    generation: str = ""
    # The ring ref of this turn's stored step observations (P1-1), discarded again
    # when the answer is never saved (no conversation is left to own them).
    observation_ref: str | None = None

    @property
    def billed(self) -> bool:
        return bool(self.outcome is not None and self.outcome.billed)


@dataclass
class ChatTurnStart:
    """What :func:`run_chat_turn` started: a completed-key ``replay`` (no model call)
    or a running ``handle``."""

    replay: ChatResponse | None = None
    handle: ChatTurnHandle | None = None


def _question_id(conversation: Any, assistant: Any) -> str | None:
    """The persisted id of the question ``assistant`` answers: the user message just
    before it in ``conversation`` (Round 12 WP-FIX1, ``ChatResponse.user_message_id``),
    or ``None`` when it is not there."""
    messages = list(getattr(conversation, "messages", None) or [])
    for index, message in enumerate(messages):
        if message.id == getattr(assistant, "id", None):
            prior = messages[index - 1] if index > 0 else None
            return prior.id if prior is not None and prior.role == "user" else None
    return None


def _replay_response(reservation: ChatExchangeReservation) -> ChatResponse:
    """A completed receipt as the response the original request returned, with its
    assistant ``message_id`` (SPEC §7.5)."""
    conversation = reservation.conversation
    assistant = reservation.assistant_message
    if assistant is None:
        raise _history_http(ChatHistoryUnavailable("The completed chat response could not be restored."))
    payload = dict(assistant.response or {})
    # A command reply (``/compact``) ran on no source and maybe no model: it never
    # borrows the conversation's.
    inherit = conversation if conversation is not None and not payload.get("command") else None
    payload.update({
        "answer": assistant.content,
        "conversation_id": reservation.conversation_id,
        "conversation_title": reservation.conversation_title
        or (conversation.title if conversation else "Conversation"),
        "idempotency_key": reservation.idempotency_key,
        "effective_model": assistant.model or (inherit.model if inherit else None),
        "effective_source_id": assistant.source_id or (inherit.source_id if inherit else None),
        "effective_source_name": assistant.source_name or (inherit.source_name if inherit else None),
        "truncated": bool(payload.get("truncated")),
        "message_id": assistant.id,
        "user_message_id": _question_id(conversation, assistant),
    })
    try:
        return ChatResponse.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 -- a corrupt durable receipt is a store failure
        raise _history_http(ChatHistoryUnavailable("The completed chat response is invalid.")) from exc


async def _abort(plan: _TurnPlan, *, failed: bool = False) -> None:
    """Release the reservation (nothing saved) — never raises. ``failed`` (Round 12):
    the turn failed, so an existing conversation reads ``failed`` until its next
    answer (a Stop or a maintenance reset is not a failure)."""
    reservation = plan.reservation
    if reservation is None or plan.completed or reservation.status != "reserved":
        return
    try:
        await plan.store.abort_exchange(
            plan.author, idempotency_key=plan.request_key,
            request_fingerprint=plan.fingerprint, lease_token=reservation.lease_token or "",
            mark_failed=failed,
        )
    except Exception as exc:  # noqa: BLE001 -- the lease still expires on its own
        logger.warning("chat reservation abort failed (%s)", type(exc).__name__)
    plan.completed = True  # never aborted twice


async def _end_billed(plan: _TurnPlan) -> None:
    """A BILLED turn that could not be saved keeps its reservation (never aborted,
    SPEC §6.4: a same-key retry waits for the lease instead of paying for the same
    answer twice). The reservation is ENDED instead (``store.end_reservation``): the
    key stays held for a full lease, but the turn no longer reads as running — the
    conversation reads ``failed`` and a brand-new thread's temporary row disappears,
    agreeing with the ``turn.error`` the client got. Never raises."""
    if not plan.persist_workspace:
        return
    reservation = plan.reservation
    ender = getattr(plan.store, "end_reservation", None)
    if reservation is not None and reservation.status == "reserved" and not plan.completed and callable(ender):
        try:
            if await ender(
                plan.author, idempotency_key=plan.request_key,
                request_fingerprint=plan.fingerprint, lease_token=reservation.lease_token or "",
            ):
                return
        except Exception as exc:  # noqa: BLE001 -- the lease still expires on its own
            logger.info("chat reservation not ended (%s)", type(exc).__name__)
    if plan.existing is None:
        return
    marker = getattr(plan.store, "mark_failed", None)
    if not callable(marker):
        return
    try:
        await marker(plan.author, plan.existing.id)
    except Exception as exc:  # noqa: BLE001 -- the status is a convenience
        logger.info("chat conversation status not updated (%s)", type(exc).__name__)


async def _close_owned(plan: _TurnPlan) -> None:
    client, plan.owned_client = plan.owned_client, None
    if client is None:
        return
    try:
        await client.close()
    except Exception:  # noqa: BLE001
        pass


def turn_lease_seconds(cfg: Any = None) -> int:
    """How long a Workspace reservation stays owned without a heartbeat (Round 12).

    A turn has no configured worst case any more (SPEC D1: unlimited turns), so the
    reservation is NOT sized to the turn: it is owned for :data:`TURN_LEASE_SECONDS`
    and the running turn renews it every :data:`TURN_HEARTBEAT_S`
    (:func:`_lease_heartbeat`). A same-key retry therefore waits for a turn of any
    length (never billing it twice, SPEC §6.4), while a crashed process's lease still
    expires on its own. ``cfg`` is accepted for compatibility and ignored."""
    return int(TURN_LEASE_SECONDS)


async def _lease_heartbeat(plan: "_TurnPlan") -> None:
    """Renew the turn's reservation every :data:`TURN_HEARTBEAT_S` while it runs.
    Stops when the lease is no longer this turn's (completed, aborted, reclaimed).
    A failed renewal is retried on the next beat; the lease outlives several misses."""
    reservation = plan.reservation
    if reservation is None or reservation.status != "reserved":
        return
    while True:
        await asyncio.sleep(max(0.01, float(TURN_HEARTBEAT_S)))
        if plan.completed:
            return
        try:
            renewed = await plan.store.renew_exchange(
                plan.author, idempotency_key=plan.request_key,
                request_fingerprint=plan.fingerprint, lease_token=reservation.lease_token or "",
                lease_seconds=TURN_LEASE_SECONDS,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 -- the next beat retries
            logger.warning("chat lease heartbeat failed (%s)", type(exc).__name__)
            continue
        if not renewed:
            return


class AccountRegistryUnavailable(RuntimeError):
    """The account registry could not be read, so the caller's account generation is
    unknown. Mapped to a retryable 503 (:func:`_account_http`) BEFORE a turn is
    admitted or looked up: a turn never carries a generation nobody can match."""


ACCOUNT_RETRY_AFTER_S = 2


def _account_http() -> HTTPException:
    return HTTPException(status_code=503, detail={
        "code": "chat_account_unavailable",
        "message": "Your account details could not be read. Try again in a moment.",
        "retry_after": ACCOUNT_RETRY_AFTER_S,
    }, headers={"Retry-After": str(ACCOUNT_RETRY_AFTER_S)})


async def account_generation_for(state: AppState, author: str | None) -> str:
    """The caller's ACCOUNT generation (``engine.jobs.account_generation`` over the
    username and the account's creation time), binding turns, their event rings and
    Stop to one account: a deleted and re-created username is a different account.
    ``""`` with auth off or for an account without a stored record (an environment
    account cannot be re-created).

    The account record is read STRICTLY (like the Jobs routes): ``UserStore`` reads
    swallow storage errors and return nothing, which would bind a turn started during
    a storage blip to ``""`` for its whole life — every later request computes the
    real generation, so Stop, ``turns/active`` and re-attach would never find it.
    A failed read raises :class:`AccountRegistryUnavailable` instead."""
    name = str(author or "").strip()
    users = getattr(state, "users", None)
    if not name or users is None:
        return ""
    from ..constants import USERS_KEY, USERS_NS
    from ..engine.jobs import account_generation
    from ..models import User

    kv = getattr(users, "_kv", None)
    getter = getattr(kv, "get_strict", None) or getattr(kv, "get", None)
    if not callable(getter):
        # A user store without a KV document (a test double): its own lookup, which
        # must raise rather than answer "no such user" when it cannot read.
        lookup = getattr(users, "get", None)
        if not callable(lookup):
            return ""
        try:
            user = await lookup(name)
        except Exception as exc:  # noqa: BLE001
            raise AccountRegistryUnavailable("account registry unavailable") from exc
        created = getattr(user, "created_at", None) if user is not None else None
        return account_generation(name, created) if isinstance(created, str) and created else ""
    try:
        doc = await getter(USERS_NS, USERS_KEY)
        if doc is not None and not isinstance(doc, dict):
            raise ValueError("invalid account registry")
        raw = (doc or {}).get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("invalid account registry")
    except Exception as exc:  # noqa: BLE001
        raise AccountRegistryUnavailable("account registry unavailable") from exc
    needle = name.lower()
    for row in raw:
        try:
            user = User.model_validate(row)
        except Exception:  # noqa: BLE001 -- one corrupt row never hides the others
            continue
        if user.username.strip().lower() != needle:
            continue
        created = getattr(user, "created_at", None)
        return account_generation(name, created) if isinstance(created, str) and created else ""
    return ""


async def _generation_or_503(state: AppState, author: str | None) -> str:
    try:
        return await account_generation_for(state, author)
    except AccountRegistryUnavailable as exc:
        raise _account_http() from exc


# --------------------------------------------------------------------------- #
# The turn's authority (Round 12 final review, L1).
#
# A turn's grants are resolved once, when it is admitted; in unlimited mode it may
# then run for up to the hidden fuse (60 minutes, 200 model calls). It keeps acting
# for its owner only while the authority it was admitted with lasts:
#
# * PUSH — every path that ends a session or an account, or changes a role, stops
#   the owner's running turns at once (:func:`stop_chat_turns_for`,
#   :func:`recheck_chat_turns_for`): sign-out, a session revoke (self or admin),
#   sign out other devices, sign out everywhere, refresh-token reuse, disabling or
#   deleting the account, and a role or custom-role change. A refresh re-keys the
#   session, so its running turns move with it (:func:`rebind_chat_turns_for`).
# * PULL — defence in depth, for what no push covers (a sign-in expiring, an RBAC
#   matrix edit, another path added later): ``_drive`` re-checks
#   (:func:`turn_authority_lost`) before every model step and lookup batch, which the
#   engine announces with ``step.start`` before doing any work, and ends the turn
#   without running that step.
# --------------------------------------------------------------------------- #
class _AuthorityLost(Exception):
    """The turn's authority ended (``reason`` is a ``STOP_*`` value)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _session_ended_http() -> HTTPException:
    return HTTPException(status_code=401, detail={
        "code": "session_invalid", "reason": STOP_SESSION_ENDED, "message": _SESSION_ENDED_MESSAGE,
    })


def _access_changed_http() -> HTTPException:
    return HTTPException(status_code=403, detail={
        "code": "chat_access_changed", "message": _ACCESS_CHANGED_MESSAGE,
    })


def _fail_authority(handle: "ChatTurnHandle", reason: str) -> None:
    """The terminal, non-retryable ``turn.error`` of a turn whose authority ended."""
    if reason == STOP_ACCESS_CHANGED:
        handle.fail("internal", _ACCESS_CHANGED_MESSAGE, retryable=False, http=_access_changed_http())
    else:
        handle.fail("internal", _SESSION_ENDED_MESSAGE, retryable=False, http=_session_ended_http())


def _session_identity(
    request: Request, state: AppState,
) -> tuple[str | None, int | None, float | None]:
    """The session id, token version and ``exp`` (epoch seconds) the caller's access
    token carries (``None`` each with auth off or for a token without them).

    Read once, before the turn awaits anything (``run_chat_turn``). ``require_auth``
    has already verified this token's signature and expiry for this request, so the
    claims are read without the expiry comparison: a token that expires while the
    turn is being admitted still names its sign-in, and its recorded ``exp`` stops
    the turn at its first check instead of leaving it bound to no session."""
    auth = getattr(state, "auth", None)
    if auth is None or not getattr(auth, "is_enabled", False):
        return None, None, None
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    claims = auth.claims_of(token) if token else None
    expired_claims = getattr(auth, "expired_session_claims", None)
    if not isinstance(claims, dict) and token and callable(expired_claims):
        claims = expired_claims(token)
    if not isinstance(claims, dict):
        return None, None, None
    sid = claims.get("sid")
    try:
        tv = int(claims.get("tv", 0) or 0)
    except (TypeError, ValueError):
        tv = 0
    try:
        exp: float | None = float(claims.get("exp") or 0) or None
    except (TypeError, ValueError):
        exp = None
    return (sid if isinstance(sid, str) and sid else None), tv, exp


async def turn_authority_lost(state: AppState, handle: "ChatTurnHandle") -> str | None:
    """Why ``handle`` may no longer act for its owner (a ``STOP_*`` value), or
    ``None`` while its authority lasts. The same rules a new request meets
    (``deps.require_auth``/``evaluate_session`` and the route's grants), plus the
    account generation a turn is bound to:

    * the account is gone or disabled (the synced user view every request reads);
    * the sign-in that started the turn ended: its access token expired (the
      token's own ``exp``, which a new request meets as a 401; a refresh of the
      session moves it, see :func:`rebind_chat_turns_for`), or its session was
      revoked, its token version is behind the owner's (sign out everywhere), or it
      is past its idle limit or its hard limit (the absolute lifetime, or the access
      token's ``exp`` the row records, whichever is earlier: the rule ``/auth/me``
      and the session list apply);
    * the account was replaced by a new account of the same name;
    * the owner no longer holds every grant the turn was admitted with.

    Like the request path, it denies only on an explicit negative signal: a session
    registry or account registry that cannot be read is not a reason to stop.
    Never raises. With auth off it is always ``None`` (no I/O)."""
    auth = getattr(state, "auth", None)
    if auth is None or not getattr(auth, "is_enabled", False):
        return None
    try:
        principal = auth.principal(handle.author)
        if principal is None:
            return STOP_SESSION_ENDED
        now = now_utc().timestamp()
        # The access token the turn was admitted with (no I/O, so a registry that
        # cannot be read never extends a turn past it).
        if handle.token_expires_at is not None and now > handle.token_expires_at:
            return STOP_SESSION_ENDED
        sessions = getattr(state, "sessions", None)
        if handle.sid and sessions is not None:
            current_tv = await sessions.token_version_for(handle.author)
            if handle.token_version is not None and handle.token_version < int(current_tv or 0):
                return STOP_SESSION_ENDED
            row = await sessions.get(handle.sid)
            if row is not None:
                limits = live_session_limits(state, principal)
                if sessions.is_active(row, **limits.kwargs()) is not None:
                    return STOP_SESSION_ENDED
                hard, _idle = SessionStore._expiry_epochs(row, **limits.kwargs())
                if hard is not None and now > hard:
                    return STOP_SESSION_ENDED
        try:
            generation = await account_generation_for(state, handle.author)
        except AccountRegistryUnavailable:
            generation = handle.generation  # unknown is not a change
        if generation != handle.generation:
            return STOP_SESSION_ENDED
        if handle.grants:
            view = await access_view_for(state, principal)
            if not all(view.allows(resource, action) for resource, action in handle.grants):
                return STOP_ACCESS_CHANGED
    except Exception as exc:  # noqa: BLE001 -- a failed check is not a revocation
        logger.warning("chat turn authority check failed (%s)", type(exc).__name__)
        return None
    return None


class _AuthorityGuard:
    """The pull check ``_drive`` runs before every model step and lookup batch. The
    engine announces each model step with one ``step.start`` and each lookup batch
    with a run of consecutive ``step.start`` events (one per lookup) before doing any
    of its work, so the check runs on the FIRST ``step.start`` of each run. A stop
    already decided is final."""

    def __init__(self, state: AppState, handle: "ChatTurnHandle") -> None:
        self._state = state
        self._handle = handle
        self._in_run = False
        self.checks = 0

    async def before(self, event: BaseModel) -> str | None:
        """``event`` is about to be relayed: the reason the turn must stop first, or
        ``None``. Only a ``step.start`` that opens a run is checked."""
        if self._handle.stop_reason:
            return self._handle.stop_reason
        opens = isinstance(event, StepStartEvent) and not self._in_run
        self._in_run = isinstance(event, StepStartEvent)
        if not opens:
            return None
        self.checks += 1
        return await turn_authority_lost(self._state, self._handle)


async def stop_chat_turns_for(
    state: AppState, username: str | None, *, sid: str | None = None,
    except_sid: str | None = None, reason: str = STOP_SESSION_ENDED,
) -> int:
    """Stop ``username``'s running chat turns because their authority ended (see
    :meth:`ChatTurnRegistry.stop_owner`): all of them, only those ``sid`` started,
    or all but ``except_sid``'s. Called by the session and account routes. Waits
    (bounded) for the turns to unwind; never raises (a revoke never fails on it)."""
    name = str(username or "").strip()
    if not name:
        return 0
    try:
        return await state.chat_turns.stop_owner(
            normalize_user_id(name), sid=sid, except_sid=except_sid, reason=reason,
            timeout=_STOP_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("chat turns not stopped (%s)", type(exc).__name__)
        return 0


async def recheck_chat_turns_for(state: AppState, username: str | None) -> int:
    """Re-check every running chat turn of ``username`` now (after its account was
    disabled, or its role or custom roles changed) and stop those whose authority
    ended. A change that only adds grants stops nothing. Never raises."""
    name = str(username or "").strip()
    auth = getattr(state, "auth", None)
    if not name or auth is None or not getattr(auth, "is_enabled", False):
        return 0
    try:
        if auth.principal(name) is None:
            # Disabled (or gone): the whole account's turns stop, rings forgotten.
            return await stop_chat_turns_for(state, name)
        registry = state.chat_turns
        stopped: dict[str, list[ChatTurnHandle]] = {}
        for handle in registry.owner_turns(normalize_user_id(name)):
            reason = await turn_authority_lost(state, handle)
            if reason is not None:
                stopped.setdefault(reason, []).append(handle)
        count = 0
        for reason, handles in stopped.items():
            count += await registry.stop(
                handles, reason=reason, forget=reason == STOP_SESSION_ENDED,
                timeout=_STOP_TIMEOUT_S,
            )
        return count
    except Exception as exc:  # noqa: BLE001
        logger.warning("chat turns not re-checked (%s)", type(exc).__name__)
        return 0


def rebind_chat_turns_for(
    state: AppState, username: str | None, old_sid: str | None, new_sid: str | None,
    *, token_expires_at: float | None = None,
) -> int:
    """A refresh (``POST /auth/refresh``) re-keys ONE logical session from ``old_sid``
    to ``new_sid`` and issues a new access token. The running turns the session
    started follow it: ending the refreshed session stops them, and the new token's
    ``exp`` (``token_expires_at``, epoch seconds) replaces the one they were admitted
    with. Returns how many turns moved. Never raises."""
    name = str(username or "").strip()
    if not name or not old_sid or not new_sid:
        return 0
    try:
        moved = 0
        for handle in state.chat_turns.owner_turns(normalize_user_id(name)):
            if handle.sid != old_sid:
                continue
            handle.sid = new_sid
            if token_expires_at is not None:
                handle.token_expires_at = token_expires_at
            moved += 1
        return moved
    except Exception as exc:  # noqa: BLE001
        logger.warning("chat turns not rebound (%s)", type(exc).__name__)
        return 0


# How long a session or account route waits for the stopped turns to unwind.
_STOP_TIMEOUT_S = 10.0


def _in_progress_http(handle: ChatTurnHandle | None, message: str) -> HTTPException:
    """409 ``chat_request_in_progress``. When the turn holding the key runs here, the
    detail names it (``turn_id``, ``conversation_id``; the caller's own turn — the
    registry is owner-checked): a client whose stream died before ``turn.start`` can
    re-attach (``GET /chat/turns/{turn_id}/events``) instead of polling."""
    exc = _conflict_http("chat_request_in_progress", message, retry_after=IN_PROGRESS_RETRY_AFTER_S)
    if handle is not None and isinstance(exc.detail, dict):
        exc.detail["turn_id"] = handle.turn_id
        if handle.conversation_id:
            exc.detail["conversation_id"] = handle.conversation_id
    return exc


def replay_read_options(cfg: Any, summary: Any) -> dict[str, Any]:
    """How much of a conversation the turn (and the ``/chat/context`` estimate, which
    must agree with it) restores to full text: the whole transcript is read (archive
    pages included — the engine's taint and lookup ledgers count every exchange),
    but only the messages the replay will use are restored — in ``unlimited`` mode
    those after the running summary (D4), in ``bounded`` mode only the newest
    exchanges ``select_replay`` can keep."""
    from ..agents.chat_protocol import HISTORY_MAX_EXCHANGES

    if getattr(cfg, "limits_mode", "unlimited") == "bounded":
        return {"window": None, "hydrate_last": 2 * HISTORY_MAX_EXCHANGES + 2}
    return {"window": None, "hydrate_after": getattr(summary, "covers_through", None)}


async def _prepare(
    request: Request, body: ChatRequest, state: AppState, *,
    author: str, owner: str, grants: frozenset[tuple[str, str]], generation: str = "",
) -> _TurnPlan:
    """The synchronous preflight (SPEC §6.1(a)); raises the HTTP error the blocking
    route has always returned. Aborts its own reservation when a later step fails."""
    effective_case_id = body.case_id or (body.context.case_id if body.context else None)
    persist_workspace = bool(body.persist_conversation and not effective_case_id)
    prefs = await _effective_prefs(state, request, body, grants)
    plan = _TurnPlan(
        body=body, author=author, owner=owner, grants=grants, prefs=prefs,
        engine=state.chat_engine, store=state.chat_conversations,
        persist_workspace=persist_workspace,
        request_key=body.idempotency_key or new_id("chatreq-"),
        fingerprint=chat_request_fingerprint(body),
        generation=generation,
    )
    registry = state.chat_turns
    if persist_workspace and body.idempotency_key:
        holder = registry.running_with_key(owner, body.idempotency_key, generation)
        if holder is not None:
            # The turn holding this key is still running in this process: a same-key
            # retry waits for it, whatever the age of its lease (SPEC §6.4, A21), and
            # learns which turn it is, so it can re-attach.
            raise _in_progress_http(holder, "This chat request is already in progress.")
    if persist_workspace and body.conversation_id:
        try:
            # D4: the running summary covers the oldest messages, so only the ones
            # after it are restored to full text for the replay.
            plan.summary = await _load_summary(plan.store, author, body.conversation_id)
            plan.existing = await plan.store.get(
                author, body.conversation_id, **replay_read_options(prefs.chat_agent, plan.summary),
            )
        except ChatHistoryUnavailable as exc:
            raise _history_http(exc) from exc
        if plan.existing is None:
            raise HTTPException(status_code=404, detail="conversation not found")
    if persist_workspace:
        try:
            plan.reservation = await plan.store.reserve_exchange(
                author, idempotency_key=plan.request_key,
                request_fingerprint=plan.fingerprint, conversation_id=body.conversation_id,
                lease_seconds=turn_lease_seconds(prefs.chat_agent),
                # Names the temporary "answering" row of a brand-new thread (D13).
                title_hint=body.message if not body.conversation_id else None,
            )
        except ChatHistoryUnavailable as exc:
            raise _history_http(exc) from exc
        except ChatRequestFailed as exc:
            # A billed turn under this key ended without a saved answer: nothing is
            # running, so the retry is told so (not retryable with this key; the
            # key stays held, so the answer is never billed twice).
            raise _conflict_http("chat_request_failed", str(exc)) from exc
        except ChatRequestInProgress as exc:
            raise _in_progress_http(
                registry.running_with_key(owner, plan.request_key, generation), str(exc),
            ) from exc
        except ChatRequestCapacityBusy as exc:
            raise _conflict_http("chat_request_capacity_busy", str(exc)) from exc
        except ChatIdempotencyConflict as exc:
            raise _conflict_http("chat_idempotency_conflict", str(exc)) from exc
        except ChatConversationMissing as exc:
            raise HTTPException(status_code=404, detail="conversation not found") from exc
        if plan.reservation.status == "completed":
            # A historical receipt replays even if its source was later disabled.
            plan.replay = _replay_response(plan.reservation)
            return plan
    try:
        # Resolved after the replay chance: a new execution rejects an unusable
        # explicit source, a completed one never needs it.
        try:
            conn, owned, sid, name = state.chat_source_connector(body.source_id)
        except ChatSourceUnavailable as exc:
            raise HTTPException(status_code=422, detail={
                "code": "chat_source_unavailable", "message": str(exc),
            }) from exc
        plan.source_conn, plan.owned_client, plan.source_id, plan.source_name = conn, owned, sid, name
        plan.ctx = await state.build_chat_tool_context(
            request, body, grants=grants, prefs=prefs, log_source=conn,
            source_id=body.source_id or None, case_id=effective_case_id,
        )
        if body.topic and is_dataclass(plan.ctx) and getattr(plan.ctx, "topic", None) != body.topic:
            # "Ask about this" (SPEC A7): the validated topic id reaches app_help and
            # the $0 Help Center answer for THIS turn only (never prompt text).
            plan.ctx = replace(plan.ctx, topic=body.topic)
    except BaseException:
        await _close_owned(plan)
        await _abort(plan)
        raise
    return plan


async def _load_summary(store: Any, author: str, conversation_id: str) -> Any:
    """The stored running summary (D4), or None. A summary that cannot be read is
    not fatal: the engine then replays without it."""
    getter = getattr(store, "get_summary", None)
    if not callable(getter):
        return None
    try:
        return await getter(author, conversation_id)
    except ChatHistoryUnavailable:
        return None


def _publish_turn(state: AppState, handle: ChatTurnHandle, phase: str, retain: bool = False) -> None:
    """One owner-only ``chat.turn`` frame (SPEC §3.2): ids, phase, an engine label and
    counts — never prompt, answer or log text. Anonymous subscribers (auth off) never
    receive targeted frames; that client polls ``GET /api/chat/turns/active``.

    Never retained in the bus's replay ring (``retain`` is ignored): the audience is a
    username, which can be deleted and created again, and a new account must never
    replay its predecessor's frames (the Jobs/Inbox convention). A client that missed
    frames reconciles through ``GET /chat/turns/active`` and re-attaches."""
    del retain
    publish_chat_turn(state.event_bus, handle.owner, {
        "turn_id": handle.turn_id, "conversation_id": handle.conversation_id,
        "case_id": handle.case_id, "phase": phase, "label": handle.label[:120],
        "lookups": handle.lookups, "tokens": handle.tokens,
    }, retain=False)


async def run_chat_turn(request: Request, body: ChatRequest, state: AppState) -> ChatTurnStart:
    """Shared by ``/chat`` and ``/chat/stream``: preflight, then start the turn task
    (or return the completed-key replay). Every failure here is an HTTP error."""
    author = current_username(request)
    owner = normalize_user_id(author)
    # The sign-in the turn acts for, read before any await: the access token can
    # expire while the turn is being admitted (``_session_identity``).
    identity = _session_identity(request, state)
    grants = await state.chat_grants(request)
    # Before any slot is taken: a turn is never admitted without a generation its
    # owner can match later (Stop, turns/active, re-attach).
    generation = await _generation_or_503(state, author)
    cfg = state.execution_prefs.chat_agent
    registry = state.chat_turns
    per_user = int(getattr(cfg, "max_concurrent_turns_per_user", 4) or 4)
    global_limit = int(getattr(cfg, "max_concurrent_turns_global", 16) or 16)
    effective_case_id = body.case_id or (body.context.case_id if body.context else None)
    if body.persist_conversation and not effective_case_id and body.idempotency_key:
        holder = registry.running_with_key(owner, body.idempotency_key, generation)
        if holder is not None:
            # A same-key retry of the caller's OWN running turn (a dropped stream
            # re-attaching) is answered before concurrency admission: that turn
            # already holds its slot, so at the bound the retry must still learn
            # which turn it is (409 naming it), never get 429 ``chat_busy``.
            raise _in_progress_http(holder, "This chat request is already in progress.")
    try:
        slot = registry.acquire(owner, per_user=per_user, global_limit=global_limit)
    except ChatTurnBusy as exc:
        raise _busy_http(exc, per_user if exc.scope == "user" else global_limit) from exc
    started = False
    try:
        plan = await _prepare(
            request, body, state, author=author, owner=owner, grants=grants, generation=generation,
        )
        if plan.replay is not None:
            return ChatTurnStart(replay=plan.replay)
        if state.mutation_gate.closed:
            await _close_owned(plan)
            await _abort(plan)
            raise _reset_http()
        handle = ChatTurnHandle(
            turn_id=new_id("turn-"), owner=owner, generation=generation,
            idempotency_key=plan.request_key if plan.persist_workspace else body.idempotency_key,
            case_id=plan.ctx.case_id if plan.ctx is not None else None,
            conversation_id=plan.reservation.conversation_id if plan.reservation is not None else None,
            model=plan.prefs.chat_model.model, stream_mode=body.stream_mode or "steps",
        )
        # The authority the turn was admitted with (re-checked while it runs).
        handle.author = author or ""
        handle.sid, handle.token_version, handle.token_expires_at = identity
        handle.grants = frozenset(grants)
        handle.publisher = functools.partial(_publish_turn, state)
        registry.register(handle)
        handle.publish("started")
        handle.task = asyncio.create_task(
            _turn_main(state, handle, plan, slot), name=f"chat-turn:{handle.turn_id}",
        )
        handle.task.add_done_callback(
            functools.partial(_on_turn_task_done, state, handle, plan, slot),
        )
        started = True
        return ChatTurnStart(handle=handle)
    finally:
        if not started:
            slot.release()


# --------------------------------------------------------------------------- #
# The turn task.
# --------------------------------------------------------------------------- #
def _replay_messages(conversation: ChatConversation | None) -> list[dict[str, Any]]:
    """Persisted messages as ``PriorExchange.from_messages`` input: decoded
    presentation on answers, the stored ``origin`` on user messages (§4.8)."""
    out: list[dict[str, Any]] = []
    for message in (conversation.messages if conversation else []):
        item: dict[str, Any] = {"role": message.role, "content": message.content, "id": message.id}
        if message.role == "assistant":
            item["response"] = message.response or {}
        else:
            origin = (message.response or {}).get("origin") if isinstance(message.response, dict) else None
            item["origin"] = origin if isinstance(origin, str) else "user"
        out.append(item)
    return out


def _with_legacy_discover(
    response: ChatResponse, body: ChatRequest, prefs: Preferences, ctx: Any = None,
) -> ChatResponse:
    """``discover`` keeps its pre-revamp meaning (SPEC §3.2): the first successful
    log search of the turn as a Discover link over its effective window — resolved
    exactly as the search resolved it (``resolve_window`` over the step's own window
    input and the turn's tool context: chip clamp, then context, then 24 h), so the
    link never names a window the search did not use."""
    if response.discover is not None or not response.query:
        return response
    step = next(
        (s for s in response.steps if s.kind == "tool" and s.tool == "search_logs" and s.status == "ok"),
        None,
    )
    if step is None:
        return response
    params = step.params
    raw_from = params.get("time_from") if isinstance(params.get("time_from"), str) else None
    raw_to = params.get("time_to") if isinstance(params.get("time_to"), str) else None
    time_from, time_to = raw_from or "now-24h", raw_to or "now"
    if ctx is not None:
        from ..agents.chat_tools.common import resolve_window

        window = resolve_window(ctx, time_from=raw_from, time_to=raw_to)
        if not isinstance(window, str):
            time_from, time_to = window.time_from, window.time_to
    data_view = body.context.data_view if body.context and body.context.data_view else prefs.data_view_pattern
    try:
        link = DiscoverLink(
            query=response.query or "*", language="kuery", data_view_pattern=str(data_view),
            time_from=str(time_from or "now-24h"), time_to=str(time_to or "now"),
        )
    except Exception:  # noqa: BLE001 -- a convenience link, never a failed turn
        return response
    return response.model_copy(update={"discover": link})


async def _turn_main(state: AppState, handle: ChatTurnHandle, plan: _TurnPlan, slot: _Slot) -> None:
    handle.running = True  # from here on, a cancel lands inside the try below
    heartbeat: asyncio.Task | None = None
    try:
        if handle.reset_cancelled:
            # ``cancel_all`` reached this turn before its first step (a reset or
            # shutdown racing the start): abort exactly like a closed gate would.
            raise MutationAdmissionClosed("chat turn stopped before it started")
        if handle.stop_reason:
            # ``stop_owner`` reached this turn before its first step.
            raise _AuthorityLost(handle.stop_reason)
        async with state.mutation_gate.admit():
            if plan.persist_workspace and plan.reservation is not None:
                # Round 12: the reservation lease is renewed while the turn runs.
                heartbeat = asyncio.create_task(
                    _lease_heartbeat(plan), name=f"chat-turn-lease:{handle.turn_id}",
                )
            await _drive(state, handle, plan)
    except MutationAdmissionClosed:
        await _abort(plan)
        handle.fail("internal", _RESET_MESSAGE, retryable=True, http=_reset_http())
    except _AuthorityLost as exc:
        # The pull check found the owner's authority ended before the next step: that
        # step never ran, nothing is saved, and the reservation is released (a later
        # request runs fresh under the owner's current authority).
        handle.stop_reason = handle.stop_reason or exc.reason
        await _abort(plan)
        _fail_authority(handle, handle.stop_reason)
    except asyncio.CancelledError:
        # Reset or shutdown, or ``stop_owner`` (the owner's authority ended): nothing
        # is persisted and the reservation is released so a retry with the same key
        # runs fresh.
        await _abort(plan)
        if handle.stop_reason and not handle.reset_cancelled:
            _fail_authority(handle, handle.stop_reason)
        else:
            handle.fail("internal", _RESET_MESSAGE, retryable=True, http=_reset_http())
        raise
    except _TurnFailure as exc:
        # Saving failed after the turn ran. A billed turn keeps its reservation (it is
        # never aborted, SPEC §6.4): a retry waits for the lease instead of paying for
        # the same answer twice, so ``_drive`` marked such a failure not retryable.
        if not plan.billed:
            await _abort(plan, failed=True)
        else:
            await _end_billed(plan)
        handle.fail(exc.code, exc.message, retryable=exc.retryable, http=exc.http)
    except Exception as exc:  # noqa: BLE001 -- the stream always ends with one terminal line
        logger.exception("chat turn %s failed (%s)", handle.turn_id, type(exc).__name__)
        if not plan.billed:
            await _abort(plan, failed=True)
        elif not plan.completed:
            await _end_billed(plan)
        # Billed but unsaved: the kept reservation would answer the same key with 409
        # until its lease expires, so only a new request (Ask again) helps.
        stuck = plan.billed and not plan.completed
        handle.fail(
            "internal", _BILLED_INTERNAL_MESSAGE if stuck else _INTERNAL_MESSAGE,
            retryable=not stuck, http=_internal_http(),
        )
    finally:
        if heartbeat is not None:
            heartbeat.cancel()
        try:
            await _close_owned(plan)
            if plan.observation_ref and not plan.completed:
                # The answer was never saved: its step observations go too.
                await _discard_observations(plan)
        finally:
            # Synchronous, so a cancel landing on the await above cannot skip it.
            _settle(state, handle, plan, slot)


def _settle(
    state: AppState, handle: ChatTurnHandle, plan: _TurnPlan, slot: _Slot, *, reset: bool = False,
) -> None:
    """Release the turn's capacity and registration and end its waiters. Idempotent
    and synchronous (it runs from ``finally`` and from a task done-callback)."""
    slot.release()
    registry = state.chat_turns
    registry.unregister(handle)
    registry.invalidate_context(plan.owner)
    if handle.response is None and handle.error is None:
        if reset or handle.reset_cancelled:
            handle.fail("internal", _RESET_MESSAGE, retryable=True, http=_reset_http())
        elif handle.stop_reason:
            _fail_authority(handle, handle.stop_reason)
        else:
            handle.fail("internal", _INTERNAL_MESSAGE, retryable=True, http=_internal_http())
    handle.finish()


def _on_turn_task_done(
    state: AppState, handle: ChatTurnHandle, plan: _TurnPlan, slot: _Slot, task: asyncio.Task,
) -> None:
    """Belt and braces for a turn task that ended WITHOUT running its own body — it
    was cancelled before its first step by something other than ``cancel_all`` (an
    event-loop shutdown cancelling every task, say). Its ``finally`` never ran, so
    capacity is released here at once and the reservation abort and client close run
    in a tracked cleanup task before the stream and blocking waiters are released."""
    if handle.finished.is_set():
        return
    slot.release()
    registry = state.chat_turns
    registry.unregister(handle)

    async def _cleanup() -> None:
        try:
            await _abort(plan)
            await _close_owned(plan)
        finally:
            _settle(state, handle, plan, slot, reset=True)

    try:
        cleanup = task.get_loop().create_task(_cleanup(), name=f"chat-turn-cleanup:{handle.turn_id}")
    except RuntimeError:  # the loop is closing: end the waiters; the lease expires on its own
        _settle(state, handle, plan, slot, reset=True)
        return
    registry.track_cleanup(cleanup)


def _accepts(func: Any, name: str) -> bool:
    """Whether ``func`` takes keyword ``name`` (or ``**kwargs``): the engine's Round 12
    parameters are passed only when the engine in this build understands them."""
    try:
        parameters = inspect.signature(func).parameters
    except (TypeError, ValueError):
        return False
    return name in parameters or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values())


def _summary_kwargs(engine: Any, summary: Any) -> dict[str, Any]:
    """The stored running summary as the engine's ``summary_text`` /
    ``summary_covers_through`` (SPEC §3.6)."""
    text = getattr(summary, "text", None)
    if not isinstance(text, str) or not text.strip():
        return {}
    run_turn = getattr(engine, "run_turn", None)
    if not _accepts(run_turn, "summary_text"):
        return {}
    out: dict[str, Any] = {"summary_text": text}
    if _accepts(run_turn, "summary_covers_through"):
        out["summary_covers_through"] = getattr(summary, "covers_through", None)
    return out


def _observation_payload(step: Any, observation: Any) -> dict[str, Any] | None:
    """The stored form of one step's observation (P1-1): exactly the aggregate the
    model saw (#7: never raw log rows), bounded at ``MAX_OBSERVATION_CHARS`` by the
    same structural shrink the engine uses, with the step's engine metadata."""
    from ..agents.chat_protocol import shrink_observation
    from ..stores.chat_conversations import MAX_OBSERVATION_CHARS

    if not isinstance(observation, dict):
        return None
    # The engine hands ``{ref, tool, summary, observation, untrusted_params}``; a bare
    # observation dict is accepted too.
    params: dict[str, str] = {}
    summary: str | None = None
    if isinstance(observation.get("observation"), dict):
        raw_params = observation.get("untrusted_params")
        if isinstance(raw_params, dict):
            params = {str(k)[:64]: str(v)[:400] for k, v in list(raw_params.items())[:20]}
        summary = observation.get("summary") if isinstance(observation.get("summary"), str) else None
        observation = observation["observation"]
    try:
        size = len(json.dumps(observation, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return None
    truncated = False
    if size > MAX_OBSERVATION_CHARS:
        observation, truncated = shrink_observation(observation, MAX_OBSERVATION_CHARS)
    try:
        observation = json.loads(json.dumps(observation, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return None
    return {
        "tool": getattr(step, "tool", None),
        "ordinal": getattr(step, "ordinal", None),
        "status": getattr(step, "status", None),
        "label": getattr(step, "label", None),
        "summary": (summary or getattr(step, "summary", None) or None),
        "observation": observation,
        "params": params,
        "truncated": bool(truncated),
    }


async def _store_observations(
    plan: _TurnPlan, outcome: Any, response: ChatResponse, conversation_id: str | None,
) -> ChatResponse:
    """Persist the turn's per-step observations in the owner's ring and set each
    stored step's ``observation_ref`` (Round 12, P1-1). Best effort: a failure only
    means no step inspector for this answer."""
    observations = getattr(outcome, "observations", None)
    saver = getattr(plan.store, "save_observations", None)
    if not observations or not isinstance(observations, dict) or not callable(saver) or not conversation_id:
        return response
    by_index = {step.index: step for step in response.steps if step.kind == "tool"}
    payloads: dict[int, dict[str, Any]] = {}
    for index, observation in observations.items():
        step = by_index.get(index) if isinstance(index, int) else None
        if step is None:
            continue
        payload = _observation_payload(step, observation)
        if payload is not None:
            payloads[index] = payload
    if not payloads or not response.turn_id:
        return response
    try:
        saved = await saver(plan.author, turn_id=response.turn_id, conversation_id=conversation_id,
                            steps=payloads)
    except Exception as exc:  # noqa: BLE001 -- the answer is never lost for its inspector
        logger.warning("chat step observations not stored (%s)", type(exc).__name__)
        return response
    if not saved:
        return response
    ref, stored = saved
    plan.observation_ref = ref
    return response.model_copy(update={"steps": [
        step.model_copy(update={"observation_ref": ref}) if step.index in stored else step
        for step in response.steps
    ]})


async def _discard_observations(plan: _TurnPlan) -> None:
    """Blank the step observations of a turn whose answer was never saved (its save
    failed, or the conversation was deleted mid-turn): log-derived aggregates are
    never left tied to a conversation that does not hold the answer. Best effort;
    the factory reset clears the whole ring either way."""
    ref, plan.observation_ref = plan.observation_ref, None
    discard = getattr(plan.store, "discard_observations", None)
    if not ref or not callable(discard):
        return
    try:
        await discard(plan.author, ref)
    except Exception as exc:  # noqa: BLE001 -- the turn's own outcome is what matters
        logger.warning("chat step observations not discarded (%s)", type(exc).__name__)


async def _persist_summary(plan: _TurnPlan, outcome: Any, conversation_id: str) -> None:
    """Store the engine's NEW running summary on the conversation (D4, §3.6)."""
    text = getattr(outcome, "summary_text", None)
    setter = getattr(plan.store, "set_summary", None)
    if not isinstance(text, str) or not text.strip() or not callable(setter):
        return
    try:
        await setter(plan.author, conversation_id, text, getattr(outcome, "summary_covers_through", None))
    except Exception as exc:  # noqa: BLE001 -- the next turn compacts again
        logger.warning("chat conversation summary not stored (%s)", type(exc).__name__)


async def _drive(state: AppState, handle: ChatTurnHandle, plan: _TurnPlan) -> None:
    body = plan.body
    reservation = plan.reservation
    prior = PriorExchange.from_messages(_replay_messages(plan.existing)) if plan.existing is not None else None
    outcome = plan.outcome = TurnOutcome(turn_id=handle.turn_id)
    estimate = 0
    agen = plan.engine.run_turn(
        body.message, plan.prefs,
        case_id=body.case_id, history=None if prior is not None else body.history,
        context=body.context, author=plan.author, source=plan.source_conn,
        can_manage_memory=("memory", "manage") in plan.grants, tool_context=plan.ctx,
        can_comment_case=("cases", "comment") in plan.grants, prior_exchanges=prior,
        turn_id=handle.turn_id, stream_mode=body.stream_mode, cancel=handle.cancel_event,
        origin=body.origin, idempotency_key=handle.idempotency_key, outcome=outcome,
        conversation_id=reservation.conversation_id if reservation is not None else None,
        continue_of=body.continue_of,
        **(_summary_kwargs(plan.engine, plan.summary) if plan.persist_workspace else {}),
    )
    guard = _AuthorityGuard(state, handle)
    try:
        async for event in agen:
            if isinstance(event, TurnDoneEvent):
                continue  # re-emitted below as the persisted response
            if isinstance(event, TurnStartEvent):
                estimate = event.estimate.prompt_tokens
            # The engine announces every model step and lookup batch before doing any
            # of its work, and waits here until the announcement is taken: the
            # owner's authority is re-checked first, and when it ended the step never
            # runs (closing the engine ends the turn at this point).
            reason = await guard.before(event)
            if reason is not None:
                raise _AuthorityLost(reason)
            handle.emit(event)
    finally:
        await agen.aclose()
    response = outcome.response
    if response is None:
        raise RuntimeError("the chat engine ended without a response")
    response = _with_legacy_discover(response, body, plan.prefs, plan.ctx)
    # A reply to a chat command (``/compact``) read no source: it names none, and the
    # conversation keeps the source its answers ran on.
    source_id = None if response.command else plan.source_id
    source_name = None if response.command else plan.source_name
    provenance = {
        "effective_source_id": source_id,
        "effective_source_name": source_name,
    }
    first_call_failed = not outcome.persist
    if not plan.persist_workspace:
        # Case-scoped and stateless turns: never Workspace history, never a report.
        final = response.model_copy(update={"idempotency_key": body.idempotency_key, **provenance})
        if first_call_failed:
            _fail_first_call(handle, final)
        else:
            handle.done(final)
        return
    if first_call_failed or (outcome.cancelled and not outcome.billed):
        # D1 (§4.5) or a Stop before anything was billed: save nothing; a retry with
        # the same key runs fresh. The answer names only an EXISTING conversation.
        await _abort(plan, failed=first_call_failed)
        final = response.model_copy(update={
            "conversation_id": plan.existing.id if plan.existing else None,
            "conversation_title": plan.existing.title if plan.existing else None,
            "idempotency_key": plan.request_key, "message_id": None, "user_message_id": None,
            **provenance,
        })
        if first_call_failed:
            _fail_first_call(handle, final)
        else:
            handle.done(final)
        return
    assert reservation is not None
    response = await _store_observations(plan, outcome, response, reservation.conversation_id)
    with_provenance = response.model_copy(update={"idempotency_key": plan.request_key, **provenance})
    stored = with_provenance.model_dump(mode="json")
    if estimate:
        stored[ESTIMATE_KEY] = int(estimate)
    try:
        completed = await plan.store.complete_exchange(
            plan.author,
            idempotency_key=plan.request_key,
            request_fingerprint=plan.fingerprint,
            conversation_id=reservation.conversation_id,
            lease_token=reservation.lease_token or "",
            requested_existing_conversation=body.conversation_id is not None,
            user_content=body.message,
            assistant_content=response.answer,
            response=stored,
            model=response.effective_model,
            source_id=source_id,
            source_name=source_name,
            user_origin=body.origin,
            time_range=body.time_range,
            # T6: the model's title from the first answer; the store applies it only
            # when this exchange creates the conversation (never after a rename).
            **({"system_title": outcome.title} if outcome.title else {}),
        )
    except ChatHistoryUnavailable as exc:
        if plan.billed:
            # The reservation is kept (ended), so "Retry same request" would only meet
            # 409 chat_request_failed until the lease expires: offer Ask again.
            raise _TurnFailure(
                "history_unavailable", _HISTORY_BILLED_MESSAGE, retryable=False,
                http=_history_http(ChatHistoryUnavailable(_HISTORY_BILLED_MESSAGE)),
            ) from exc
        raise _TurnFailure("history_unavailable", _HISTORY_MESSAGE, retryable=True,
                           http=_history_http(exc)) from exc
    except (ChatConversationMissing, ChatIdempotencyConflict) as exc:
        message = _CONFLICT_MESSAGE if isinstance(exc, ChatConversationMissing) else str(exc)
        raise _TurnFailure("history_unavailable", message, retryable=False,
                           http=_conflict_http("chat_idempotency_conflict", message)) from exc
    except ChatRequestFailed as exc:
        raise _TurnFailure("history_unavailable", str(exc), retryable=False,
                           http=_conflict_http("chat_request_failed", str(exc))) from exc
    except ChatRequestInProgress as exc:
        raise _TurnFailure("history_unavailable", str(exc), retryable=True,
                           http=_conflict_http("chat_request_in_progress", str(exc),
                                               retry_after=IN_PROGRESS_RETRY_AFTER_S)) from exc
    plan.completed = True
    conversation = completed.conversation
    assistant = completed.assistant_message
    if conversation is None or assistant is None:
        raise _TurnFailure("history_unavailable", _HISTORY_MESSAGE, retryable=True, http=_history_http(
            ChatHistoryUnavailable("The saved conversation could not be restored.")))
    await _persist_summary(plan, outcome, conversation.id)
    final = with_provenance.model_copy(update={
        "conversation_id": conversation.id,
        "conversation_title": conversation.title,
        "truncated": bool((assistant.response or {}).get("truncated")),
        "message_id": assistant.id,
        "user_message_id": _question_id(conversation, assistant),
    })
    saved_report, report_error = await _save_report_from_turn(
        state, plan, outcome, conversation.id, assistant.id,
    )
    if saved_report is not None:
        final = final.model_copy(update={"saved_report": saved_report})
    if report_error is not None:
        final = final.model_copy(update={"saved_report_error": report_error})
    handle.done(final)


_REPORT_LIMIT_MESSAGE = (
    "This answer was not saved to Reports: you already have {limit} reports. "
    "Delete one in Reports, then save this answer again."
)
_REPORT_UNAVAILABLE_MESSAGE = (
    "This answer was not saved to Reports because Reports could not be reached. "
    "Save it again in a moment."
)
_REPORT_EMPTY_MESSAGE = "This answer had nothing that could be saved to Reports."


def _report_error(code: str) -> ChatReportSaveError:
    from ..constants import MAX_REPORTS_PER_USER

    if code == "report_limit":
        return ChatReportSaveError(
            code="report_limit", message=_REPORT_LIMIT_MESSAGE.format(limit=MAX_REPORTS_PER_USER),
            retryable=False,
        )
    if code == "report_empty":
        return ChatReportSaveError(code="report_empty", message=_REPORT_EMPTY_MESSAGE, retryable=False)
    return ChatReportSaveError(code="report_unavailable", message=_REPORT_UNAVAILABLE_MESSAGE, retryable=True)


async def _save_report_from_turn(
    state: AppState, plan: _TurnPlan, outcome: Any, conversation_id: str, message_id: str,
) -> tuple[ChatSavedReport | None, ChatReportSaveError | None]:
    """D11: when the final header asked for a report, the SERVER (never the model)
    creates it from the persisted answer through the server-resolved add path —
    owner-scoped, strict CAS, Brief sections expanded into items, idempotent per
    request key — and records it on the stored answer. Workspace turns only (a
    case-scoped turn never reaches here).

    The outcome is never silent: ``(saved, None)`` names the report (and how many
    sections did not fit); a save that could not happen returns ``(None, error)`` —
    ``report_limit`` (the owner's library is full), ``report_unavailable`` (the store
    failed; the same save may work later) or ``report_empty`` (nothing to save) —
    and the error is recorded on the stored answer too, so a replay shows it. The
    answer itself is already saved either way."""
    from ..stores.reports import ReportLimitReached, ReportNotFound

    request = getattr(outcome, "report_request", None)
    if not isinstance(request, dict) or not request:
        return None, None
    from .routes_reports import save_answer_as_report

    saved: ChatSavedReport | None = None
    error: ChatReportSaveError | None = None
    try:
        saved = await save_answer_as_report(
            state, plan.author, conversation_id=conversation_id, message_id=message_id,
            title=request.get("title"), template=request.get("template"),
            idempotency_key=plan.request_key,
        )
        if saved is None:
            error = _report_error("report_empty")
    except ReportLimitReached:
        error = _report_error("report_limit")
    except ReportNotFound:
        # The owner deleted the report this request already saved: the delete stands.
        return None, None
    except Exception as exc:  # noqa: BLE001 -- the answer stands; the error is reported
        logger.warning("chat report not saved (%s)", type(exc).__name__)
        error = _report_error("report_unavailable")
    if error is not None and error.retryable:
        # "Save as report" (POST /api/reports/from-answer) saves the report this answer
        # asked for: its title and template travel on the stored error, server-side.
        error = ChatReportSaveError.model_validate({
            **error.model_dump(), "title": request.get("title"), "template": request.get("template"),
        })
    updater = getattr(plan.store, "update_message_response", None)
    if callable(updater):
        record = (
            {"saved_report": saved.model_dump(mode="json")} if saved is not None
            else {"saved_report_error": error.model_dump(mode="json")} if error is not None else None
        )
        if record is not None:
            try:
                await updater(plan.author, conversation_id, message_id, record)
            except Exception as exc:  # noqa: BLE001 -- a replay then shows the answer without the line
                logger.info("report outcome not recorded on the answer (%s)", type(exc).__name__)
    return saved, error


def _fail_first_call(handle: ChatTurnHandle, response: ChatResponse) -> None:
    """D1 (§4.5): the stream ends with ``turn.error`` (no response to keep); the
    blocking route answers 200 with the notice response, which clients do not append
    to history."""
    notice = response.notice
    handle.fail(
        turn_error_code(notice), (notice.message if notice else "") or _INTERNAL_MESSAGE,
        retryable=bool(notice.retryable) if notice else True, http=None, notice=notice,
        response=response,
    )


# --------------------------------------------------------------------------- #
# POST /api/chat/stream (SPEC §6.1).
# --------------------------------------------------------------------------- #
class NDJSONStreamingResponse(StreamingResponse):
    """``application/x-ndjson``: one :class:`ChatStreamEventModel` per line."""

    media_type = NDJSON_CONTENT_TYPE


class _NDJSONSchemaDoc(JSONResponse):
    """Documentation-only ``response_class`` for ``/chat/stream``.

    The handler always RETURNS an :class:`NDJSONStreamingResponse` instance, which
    FastAPI passes through untouched; ``response_class`` only shapes ``openapi.json``.
    For a non-JSON class FastAPI seeds the 200 schema with ``{"type": "string"}`` and
    then merges the documented model into it, producing the unsatisfiable
    ``{"$ref": ..., "type": "string"}`` (OpenAPI 3.1 applies sibling keywords
    jointly). A JSON-family class seeds ``{}``, so each NDJSON line is documented as
    exactly ``ChatStreamEventModel``."""

    media_type = NDJSON_CONTENT_TYPE


class ChatTurnCancelResult(BaseModel):
    """``POST /api/chat/turns/{turn_id}/cancel``: the Stop was accepted."""

    ok: bool = True
    turn_id: str


async def _relay(handle: ChatTurnHandle) -> AsyncIterator[bytes]:
    """Relay the turn's queue, with a ``ping`` after every idle interval. One getter
    task outlives each timeout, so an event is never lost to a timed-out wait."""
    getter: asyncio.Future | None = None
    try:
        while True:
            if getter is None:
                getter = asyncio.ensure_future(handle.queue.get())
            done, _pending = await asyncio.wait({getter}, timeout=STREAM_PING_INTERVAL_S)
            if not done:
                yield encode_event(PingEvent())
                continue
            item, getter = getter.result(), None
            if item is _END:
                return
            yield encode_event(item)
    finally:
        # The client stopped reading (or the turn ended): the turn itself goes on and
        # persists; only the relay stops.
        handle.detached = True
        if getter is not None and not getter.done():
            getter.cancel()


async def _replay_lines(response: ChatResponse) -> AsyncIterator[bytes]:
    """A completed-key replay: ``turn.start {replayed: true}`` then ``turn.done``."""
    yield encode_event(TurnStartEvent(
        turn_id=response.turn_id or new_id("turn-"), conversation_id=response.conversation_id,
        model=response.effective_model, stream_mode=response.stream_mode or "steps", replayed=True,
    ))
    yield encode_event(TurnDoneEvent(response=response))


@router.post(
    "/chat/stream",
    response_class=_NDJSONSchemaDoc,
    responses={200: {
        "model": ChatStreamEventModel,
        "description": (
            "NDJSON: one ChatStreamEvent per line. turn.start first; turn.done (the "
            "persisted response) or turn.error last; ping every idle 10 s."
        ),
    }},
)
async def chat_stream(
    body: ChatRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> NDJSONStreamingResponse:
    """The streaming twin of ``POST /api/chat`` (same body, same preflight errors)."""
    start = await run_chat_turn(request, body, state)
    if start.replay is not None:
        return NDJSONStreamingResponse(_replay_lines(start.replay), headers=dict(STREAM_HEADERS))
    assert start.handle is not None
    return NDJSONStreamingResponse(_relay(start.handle), headers=dict(STREAM_HEADERS))


async def run_chat_blocking(request: Request, body: ChatRequest, state: AppState) -> ChatResponse:
    """``POST /api/chat``: the same turn, awaited. A first-call failure (§4.5) is a
    200 with the notice; persistence failures keep their historical HTTP codes. The
    turn runs as a task, so a dropped client connection never interrupts it."""
    start = await run_chat_turn(request, body, state)
    if start.replay is not None:
        return start.replay
    handle = start.handle
    assert handle is not None
    # Nobody relays this turn's queue (the event ring still records it for re-attach).
    handle.detached = True
    await handle.finished.wait()
    if handle.response is not None:
        return handle.response
    raise handle.http_error or _internal_http()


# --------------------------------------------------------------------------- #
# POST /api/chat/turns/{turn_id}/cancel (SPEC §6.4).
# --------------------------------------------------------------------------- #
@router.post("/chat/turns/{turn_id}/cancel", response_model=ChatTurnCancelResult)
async def cancel_chat_turn(
    request: Request,
    turn_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatTurnCancelResult:
    """Stop the caller's own running turn. The in-flight step finishes and is
    recorded, no new step starts, and the stream ends with ``turn.done`` carrying a
    ``cancelled`` notice. 404 when unknown, finished or not the caller's (ownership
    is indistinguishable from absence)."""
    author = current_username(request)
    generation = await _generation_or_503(state, author)
    if not state.chat_turns.request_stop(turn_id, normalize_user_id(author), generation):
        raise HTTPException(status_code=404, detail="turn not found")
    try:
        await state.execution_audit.record(
            action_type=ActionType.CONTEXT, surface="chat", actor=author or "default",
            result_summary=f"turn={turn_id} stop requested",
        )
    except Exception:  # noqa: BLE001 -- Stop never fails on its audit row
        pass
    return ChatTurnCancelResult(ok=True, turn_id=turn_id)


# --------------------------------------------------------------------------- #
# Round 12 (SPEC D13, §3.2): the caller's running turns and live re-attach.
# --------------------------------------------------------------------------- #
@router.get("/chat/turns/active", response_model=list[ChatActiveTurn])
async def active_chat_turns(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> list[ChatActiveTurn]:
    """The caller's own running chat turns, oldest first: ids, start time, an engine
    label, lookups and tokens — never prompt, answer or log text. Process-local, like
    the turn registry (the supported runtime is one backend process). With auth
    disabled (targeted ``chat.turn`` frames never reach anonymous subscribers) the
    client polls this every 5 s while it knows a turn is running."""
    author = current_username(request)
    generation = await _generation_or_503(state, author)
    return [
        handle.active_view()
        for handle in state.chat_turns.running_for(normalize_user_id(author), generation)
    ]


async def _reattach(handle: ChatTurnHandle, after: int) -> AsyncIterator[bytes]:
    """Replay the ring after ``after`` (text coalesced), then tail live until the
    terminal event, with a ``ping`` after every idle interval."""
    cursor = max(0, int(after))
    while True:
        waiter = handle.signal.waiter()  # taken BEFORE reading: no append is missed
        lines = handle.ring.after(cursor)
        for seq, event in lines:
            yield encode_ring_line(seq, event)
            cursor = max(cursor, seq)
        terminal = handle.ring.terminal_seq
        if terminal is not None and cursor >= terminal:
            return
        if handle.finished.is_set() and terminal is None:
            return  # ended without a terminal line (never expected): close cleanly
        if lines:
            continue
        try:
            await asyncio.wait_for(waiter.wait(), timeout=STREAM_PING_INTERVAL_S)
        except asyncio.TimeoutError:
            yield encode_event(PingEvent())


@router.get(
    "/chat/turns/{turn_id}/events",
    response_class=_NDJSONSchemaDoc,
    responses={200: {
        "model": ChatStreamEventModel,
        "description": (
            "NDJSON: the turn's events after `after` (each line also carries its `seq`; "
            "answer text coalesced), then the live tail, ending with turn.done or "
            "turn.error; ping every idle 10 s."
        ),
    }},
)
async def chat_turn_events(
    request: Request,
    turn_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    after: int = Query(default=0, ge=0, le=10_000_000),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> NDJSONStreamingResponse:
    """Re-attach to the caller's own running (or just finished) turn (SPEC D13):
    a replay of its bounded event ring after ``after`` — consecutive text deltas
    coalesced, ``usage`` and ``step.progress`` at their latest — then the live tail,
    ending with the terminal event. Resume with ``after=<last seq seen>``. 404 for an
    unknown or expired turn and for anyone else's (ownership is indistinguishable
    from absence). Reading never holds a concurrency slot and never stops the turn."""
    author = current_username(request)
    generation = await _generation_or_503(state, author)
    handle = state.chat_turns.find(turn_id, normalize_user_id(author), generation)
    if handle is None:
        raise HTTPException(status_code=404, detail="turn not found")
    return NDJSONStreamingResponse(_reattach(handle, after), headers=dict(STREAM_HEADERS))


@router.post("/chat/turns/{turn_id}/seen", status_code=204, response_class=Response)
async def chat_turn_seen(
    request: Request,
    turn_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Response:
    """The caller has their own turn's outcome on screen (an answer, a question or a
    failure, in a Workspace or a Case Manager chat). Their other consoles hear it and
    drop the mark they may hold for it. Nothing is stored. Always 204, for any
    well-formed turn id: the notice goes only to the caller's own consoles and names
    the turn, plus its conversation or case while the server still keeps the finished
    turn (5 minutes)."""
    # An owner-only ``chat.read`` frame naming the turn and where it ran (SPEC §7.2
    # decision 17). Case chat and failures have no stored "unread" state to clear, so
    # this is their only cross-console signal, and an analyst may look at an outcome
    # long after the registry forgot the turn (after a meeting): the frame then names
    # the turn alone, which is all a console matches on. It reaches only the caller's
    # consoles and carries ids only, so a turn id that is unknown, expired or someone
    # else's changes nothing for anyone else and tells the caller nothing (the
    # conversation or case is named only from the caller's OWN live record). Best
    # effort: a frame that cannot go out is not an error.
    # (A comment, not the docstring: the docstring is the published OpenAPI description.)
    author = current_username(request)
    generation = await _generation_or_503(state, author)
    handle = state.chat_turns.find(turn_id, normalize_user_id(author), generation)
    try:
        publish_chat_read(
            state.event_bus, author, handle.conversation_id if handle is not None else None,
            turn_id=turn_id, case_id=handle.case_id if handle is not None else None,
        )
    except Exception:  # noqa: BLE001 -- a nudge; nothing else depends on it
        logger.debug("chat.read frame not published", exc_info=True)
    return Response(status_code=204)


# --------------------------------------------------------------------------- #
# GET /api/chat/context (SPEC §8).
# --------------------------------------------------------------------------- #
def _context_window(model: str, custom: dict[str, Any] | None) -> int | None:
    if isinstance(custom, dict):
        window = custom.get("context_window")
        if isinstance(window, int) and not isinstance(window, bool) and window > 0:
            return window
    try:
        from ..llm.pricing import load_registry

        value = int((load_registry().get(model) or {}).get("context_window") or 0)
    except Exception:  # noqa: BLE001
        return None
    return value or None


async def _rates(state: AppState, model: str, custom: dict[str, Any] | None) -> ChatRates:
    """Effective per-million rates for ``model``, priced exactly as the ledger prices
    it (operator overlay, then $0 for a registered custom model, then the tables).
    Demo Mode reports its synthetic rates."""
    from ..llm.gateway import _DEMO_IN_RATE, _DEMO_OUT_RATE
    from ..llm.pricing import cache_rates, resolve_price

    if state.demo_active:
        rate_in = _DEMO_IN_RATE * 1_000_000
        return ChatRates(
            input_per_million=round(rate_in, 6),
            output_per_million=round(_DEMO_OUT_RATE * 1_000_000, 6),
            cache_read_per_million=round(0.1 * rate_in, 6),
        )
    overlay = None
    try:
        overlay = await state.price_overlay.as_price_tuple(model)
    except Exception:  # noqa: BLE001
        overlay = None
    if overlay is None and custom is not None:
        overlay = (0.0, 0.0)
    rate_in, rate_out = resolve_price(model, overlay)
    return ChatRates(
        input_per_million=max(0.0, float(rate_in)),
        output_per_million=max(0.0, float(rate_out)),
        cache_read_per_million=max(0.0, float(cache_rates(model, float(rate_in))[0])),
    )


def _budget_state(status: dict[str, Any] | None) -> str:
    """ok | approaching | reached from the budget gate's status bands."""
    if not isinstance(status, dict) or not status.get("enabled"):
        return "ok"
    state = "ok"
    for window in ("daily", "monthly"):
        band = status.get(window) if isinstance(status.get(window), dict) else {}
        fraction = band.get("fraction")
        if band.get("band") == "over" or (isinstance(fraction, (int, float)) and fraction >= 1.0):
            return "reached"
        if band.get("band") == "warn":
            state = "approaching"
    return state


def _calibration(conversation: ChatConversation | None) -> float | None:
    """actual ÷ estimate of the conversation's last measured turn: the first model
    call's real prompt tokens over the engine's chars/4 estimate of that prompt."""
    for message in reversed(conversation.messages if conversation else []):
        if message.role != "assistant" or not isinstance(message.response, dict):
            continue
        estimate = message.response.get(ESTIMATE_KEY)
        steps = message.response.get("steps")
        if not isinstance(estimate, int) or isinstance(estimate, bool) or estimate <= 0 or not isinstance(steps, list):
            return None
        first = next((s for s in steps if isinstance(s, dict) and s.get("kind") == "model"), None)
        usage = first.get("usage") if isinstance(first, dict) else None
        if not isinstance(usage, dict) or usage.get("estimated"):
            return None
        actual = sum(
            int(usage.get(k) or 0) for k in ("input_tokens", "cache_read_tokens", "cache_write_tokens")
            if isinstance(usage.get(k), int)
        )
        if actual <= 0:
            return None
        ratio = actual / estimate
        if not math.isfinite(ratio):
            return None
        return round(min(max(ratio, CALIBRATION_BOUNDS[0]), CALIBRATION_BOUNDS[1]), 3)
    return None


async def _history_estimate(
    state: AppState, owner_name: str, conversation_id: str | None,
    cfg: Any = None, context_window: int | None = None,
) -> tuple[int, int, ChatConversation | None]:
    """``(tokens, exchanges, conversation)`` for the history the NEXT turn replays,
    selected exactly as the engine selects it: in ``bounded`` mode the §4.3
    ``select_replay`` window; in ``unlimited`` mode (SPEC D4) the stored running
    summary (fenced) plus every exchange after it, less the oldest ones the turn
    will fold into the summary (``plan_fold``) — read the same way the turn reads
    them (``replay_read_options``: only those messages are restored to full text).
    ``exchanges`` counts the exchanges replayed verbatim."""
    from ..agents.chat_protocol import (
        clean_summary,
        conversation_exchanges,
        drop_summarised,
        plan_fold,
        render_conversation_summary,
        summary_max_chars,
    )
    from ..llm.gateway import estimate_message_tokens

    if not conversation_id:
        return 0, 0, None
    store = state.chat_conversations
    unlimited = getattr(cfg, "limits_mode", "unlimited") != "bounded"
    try:
        summary = await _load_summary(store, owner_name, conversation_id) if unlimited else None
        conversation = await store.get(owner_name, conversation_id, **replay_read_options(cfg, summary))
    except ChatHistoryUnavailable:
        return 0, 0, None
    except TypeError:  # a store without the windowed read (tests, third parties)
        try:
            conversation = await store.get(owner_name, conversation_id)
        except ChatHistoryUnavailable:
            return 0, 0, None
        summary = None
    if conversation is None:
        return 0, 0, None
    exchanges = PriorExchange.from_messages(_replay_messages(conversation))
    if not unlimited:
        kept = select_replay(conversation_exchanges(exchanges))
        if not kept:
            return 0, 0, conversation
        return estimate_message_tokens(render_replay(kept).messages), len(kept), conversation
    text = getattr(summary, "text", None)
    summary_text = (
        clean_summary(text, limit=summary_max_chars(context_window)) if isinstance(text, str) and text else ""
    )
    pending = conversation_exchanges(
        drop_summarised(exchanges, getattr(summary, "covers_through", None)) if summary_text else exchanges
    )
    verbatim = pending[plan_fold(pending, context_window):]
    messages: list[dict[str, str]] = []
    if summary_text:
        messages.extend(render_conversation_summary(summary_text))
    if verbatim:
        messages.extend(render_replay(verbatim, unbounded=True).messages)
    if not messages:
        return 0, 0, conversation
    return estimate_message_tokens(messages), len(verbatim), conversation


@router.get("/chat/context", response_model=ChatContextInfo)
async def chat_context(
    request: Request,
    conversation_id: str | None = Query(default=None, max_length=128, pattern=_SAFE_ID_PATTERN),
    model: str | None = Query(default=None, max_length=200),
    case_id: str | None = Query(default=None, max_length=128),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatContextInfo:
    """Everything the composer meter needs (SPEC §8): the effective model and its
    limits, the static prompt and history estimates, the caller's tool catalogue,
    the live-text availability, the §4.2 bounds, calibration and the static evergreen
    starters (Round 13 SPEC D2: no case-store read).
    Money and budget fields need ``models:read``; ``spent_today``/``remaining`` also
    ``cost:view``. Cached per principal for 30 s (dropped when one of the caller's
    turns ends) and resolved without audit rows."""
    from ..agents.chat_tools.registry import build_toolbox, catalogue_infos
    from ..agents.prompts import render_chat_agent_system
    from ..engine.chat_starters import evergreen_starters
    from ..llm.gateway import estimate_message_tokens

    author = current_username(request)
    owner = normalize_user_id(author)
    grants = await state.chat_grants(request)
    registry = state.chat_turns
    prefs = state.execution_prefs
    cfg = prefs.chat_agent
    # The limits mode, the operator timezone and the brand-ring switch are part of the
    # answer: a change to any of them is never served from the 30-second cache.
    key = (
        owner, state.demo_active, conversation_id, (model or "").strip(), case_id, grants,
        getattr(cfg, "limits_mode", None), getattr(getattr(prefs, "sla", None), "timezone", None),
        getattr(cfg, "animated_brand", None),
    )
    cached = registry.context_get(key)
    if cached is not None:
        return cached

    chat_model = prefs.chat_model
    requested = (model or "").strip()
    if requested and requested != chat_model.model and ("models", "read") in grants:
        chat_model = await _chat_model_config(state, requested, chat_model) or chat_model
    custom = None
    try:
        custom = await state.custom_models.get_model(chat_model.model)
    except Exception:  # noqa: BLE001
        custom = None
    custom = custom if isinstance(custom, dict) else None

    effective_prefs = prefs.model_copy(update={"chat_model": chat_model})
    ctx = await state.build_chat_tool_context(
        request, None, grants=grants, prefs=effective_prefs, case_id=case_id or None,
    )
    toolbox = build_toolbox(ctx, ())
    from ..agents.chat_tools.common import operator_tz

    unlimited = getattr(cfg, "limits_mode", "unlimited") != "bounded"
    timezone_name = operator_tz(ctx)
    system = render_chat_agent_system(
        toolbox.signatures(), max_parallel=cfg.max_parallel, case_scoped=bool(case_id),
        # The same configuration-disabled line a turn's prompt carries (estimate parity).
        disabled_tools=toolbox.disabled if (unlimited or cfg.max_model_calls > 1) else (),
        timezone=timezone_name,
    )
    window = _context_window(chat_model.model, custom)
    history_tokens, history_exchanges, conversation = (0, 0, None)
    if not case_id:
        history_tokens, history_exchanges, conversation = await _history_estimate(
            state, author, conversation_id, cfg, window,
        )

    gateway = getattr(state.chat_engine, "_gateway", None) or state.gateway
    streams = bool(gateway.text_streaming_supported(chat_model.provider))
    if not cfg.allow_text_streaming:
        text_streaming = TextStreamingInfo(available=False, reason="disabled_by_admin")
    elif not streams:
        text_streaming = TextStreamingInfo(available=False, reason="model_does_not_stream")
    else:
        text_streaming = TextStreamingInfo(available=True, reason=None)

    budget_status: dict[str, Any] | None = None
    if not state.demo_active:
        try:
            budget_status = await state.budget_gate.status()
        except Exception:  # noqa: BLE001 -- the meter degrades to tokens only
            budget_status = None
    from ..agents.chat import _max_output

    floor = max(int(chat_model.max_tokens), int(cfg.final_max_tokens))
    info: dict[str, Any] = {
        "model": chat_model.model,
        "context_window": window,
        # D3: an unlimited turn asks for the model's catalogue maximum at every step.
        "max_output_tokens": (
            max(int(chat_model.max_tokens), _max_output(chat_model.model) or floor) if unlimited else floor
        ),
        # SPEC §3.1: the limits mode (bounded-mode notices and knobs) and the operator
        # timezone calendar windows are labelled in.
        "limits_mode": "unlimited" if unlimited else "bounded",
        "timezone": timezone_name,
        "chars_per_token": CHARS_PER_TOKEN,
        "static_prompt_tokens": estimate_message_tokens([{"role": "system", "content": system}]),
        "history_tokens": history_tokens,
        "history_exchanges": history_exchanges,
        "tools": catalogue_infos(grants, ctx),
        "text_streaming": text_streaming,
        "bounds": ChatContextBounds.from_config(cfg),
        "calibration": _calibration(conversation),
        "budget_state": _budget_state(budget_status),
        # Round 13 (SPEC D2): the static evergreen set, no store read; the dynamic cards
        # come from GET /api/chat/starters.
        "starters": evergreen_starters(demo=state.demo_active),
    }
    if ("models", "read") in grants:
        budget = prefs.budget
        info["rates"] = await _rates(state, chat_model.model, custom)
        info["simulated"] = bool(state.demo_active)
        if state.demo_active:
            # Demo spend is simulated and never meets the tenant's budget gate.
            info["budget"] = ChatBudgetInfo(enabled=False)
        else:
            daily = budget.daily_usd if budget.daily_usd is not None and budget.daily_usd > 0 else None
            info["budget"] = ChatBudgetInfo(
                enabled=bool(budget.enabled), daily_limit=daily,
                soft_warn_pct=float(budget.soft_warn_pct), on_exceed=budget.on_exceed,
            )
            if ("cost", "view") in grants and budget_status is not None:
                spent = (budget_status.get("daily") or {}).get("spent")
                if isinstance(spent, (int, float)) and not isinstance(spent, bool) and math.isfinite(spent):
                    info["spent_today"] = max(0.0, float(spent))
                    info["remaining"] = (round(daily - float(spent), 6) if daily is not None else None)
    result = ChatContextInfo.model_validate(info)
    registry.context_put(key, result)
    return result


# --------------------------------------------------------------------------- #
# GET /api/chat/topics/{topic_id} (SPEC §10.7 "Ask about this").
# --------------------------------------------------------------------------- #
@router.get("/chat/topics/{topic_id}", response_model=ChatTopicQuestion)
async def chat_topic(
    topic_id: str = Path(..., max_length=CHAT_TOPIC_MAX_CHARS, pattern=_TOPIC_ID_PATTERN),
    _=Depends(require_permission("cases", "read")),
) -> ChatTopicQuestion:
    """The server's templated question for a console-map topic (``kpi:mtta``,
    ``settings:models``). The page sends it with ``origin: "starter"``; client text
    never stands in for it. 404 for an unknown topic."""
    from ..knowledge import AppKnowledgeUnavailable, load_app_knowledge, topic_question

    try:
        knowledge = await load_app_knowledge()
    except AppKnowledgeUnavailable as exc:
        raise HTTPException(status_code=404, detail="topic not found") from exc
    question = topic_question(topic_id, knowledge=knowledge)
    if not question:
        raise HTTPException(status_code=404, detail="topic not found")
    return ChatTopicQuestion(topic=topic_id, question=question)


__all__ = [
    "CHAT_BUSY_RETRY_AFTER_S",
    "TURN_HEARTBEAT_S",
    "TURN_LEASE_SECONDS",
    "ChatTurnBusy",
    "ChatTurnCancelResult",
    "ChatTurnHandle",
    "ChatTurnRegistry",
    "ChatTurnStart",
    "IN_PROGRESS_RETRY_AFTER_S",
    "NDJSONStreamingResponse",
    "TurnEventRing",
    "active_chat_turns",
    "chat_request_fingerprint",
    "chat_turn_events",
    "router",
    "run_chat_blocking",
    "run_chat_turn",
]
