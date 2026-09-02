"""In-process multiplexed Server-Sent-Events (SSE) foundation (Round 3, Wave 1).

A single, in-memory ``EventBus`` is the server->client push spine for the live UI:

* in-app notifications (#8 — :class:`app.models.InAppNotification`),
* case activity / collaboration (#4 — :class:`app.models.CaseActivity`,
  status changes, comments, assignments), and
* agent investigation steps (#12 — :class:`app.models.TraceSpan` projections).

Design goals (all enforced here, no network needed to exercise them):

* ``publish(topic, event_type, data, ...)`` is FIRE-AND-FORGET and NON-BLOCKING — a
  slow or absent subscriber can never block a producer (the poller, the case manager,
  the notification dispatcher). A publish with zero subscribers is a cheap no-op that
  still appends to the per-topic replay history.
* ``subscribe(topics, user)`` returns an async generator that yields SSE-framed
  ``bytes`` (``id:`` + ``event:`` + ``data:`` frames) with:
    - a BOUNDED per-subscriber ring buffer (drop-OLDEST when a slow client backs up,
      so one stuck EventSource can never OOM the server),
    - ``Last-Event-ID`` REPLAY from a bounded per-topic history ring, and
    - a heartbeat comment every ``heartbeat_seconds`` to keep the connection (and any
      intermediary) alive.
* PER-USER SCOPING — an event may target a specific audience (a set of usernames). A
  subscriber only ever receives events that are broadcast OR explicitly addressed to
  its ``user``. The endpoint (integrator) is responsible for case-visibility scoping
  at publish time (it knows a case's assignee/watchers); the bus enforces the
  username audience filter so a subscriber never sees another user's notifications.
* BOUNDED SUBSCRIBER COUNT with drop-oldest eviction, so the bus itself is memory-safe
  under a flood of connections.

⚠ NON-NEGOTIABLES. This module is PURE TRANSPORT. It never touches the deterministic
close/escalate decision (#3): it only DELIVERS already-decided, already-rendered
payloads. It performs NO LLM calls (#6 is irrelevant here). Payloads handed to
``publish`` are expected to be already render-safe (the producers fence/escape any
log-derived value before it ever reaches a payload, per #9) — the bus JSON-encodes
them verbatim and never interprets them.

The bus is a MODULE-LEVEL SINGLETON (``get_event_bus()``) so it survives
``AppState._wire()`` rebuilds exactly like the KV-backed stores survive them — the
integrator imports the accessor, not an ``AppState`` attribute. It is configured from
``Preferences.realtime`` (:class:`app.config.RealtimeConfig`); when ``realtime.enabled``
is False the bus still exists and is safe to publish to (so producers need no
conditional), and the endpoint simply returns 204 so clients fall back to polling.
"""

from __future__ import annotations

import asyncio
import json
from collections import OrderedDict, deque
from typing import Any, AsyncIterator, Iterable

from .utils import iso_now, new_id

# --------------------------------------------------------------------------- #
# Tunables (module constants — bound memory regardless of config). These are
# deliberately NOT operator-tunable: they are the safety rails that keep a single
# process bounded. ``heartbeat_seconds`` IS operator-tunable (Preferences.realtime).
# --------------------------------------------------------------------------- #
# Per-subscriber outbound ring: a slow client buffers at most this many events
# before the OLDEST are dropped (drop-oldest, never block the producer).
DEFAULT_SUBSCRIBER_QUEUE = 256
# Per-topic replay history ring used to satisfy Last-Event-ID reconnects.
DEFAULT_HISTORY_PER_TOPIC = 256
# Hard cap on concurrent subscribers; the OLDEST subscriber is evicted when exceeded.
DEFAULT_MAX_SUBSCRIBERS = 1024
# Hard cap on the number of DISTINCT history topics kept for Last-Event-ID replay. Each
# per-case topic (cases:{id}) would otherwise create a ring that is never freed, so the
# history dict grew without bound (audit #32). LRU-evict the least-recently-published
# topic past this many.
DEFAULT_MAX_HISTORY_TOPICS = 2048
# Default heartbeat cadence when no config is supplied (mirrors RealtimeConfig).
DEFAULT_HEARTBEAT_SECONDS = 15


# --------------------------------------------------------------------------- #
# Canonical SSE event-type (channel) names — the ONE registry of what this backend
# publishes.
#
# ⚠ WHY THIS EXISTS. A browser ``EventSource`` matches a typed ``event:`` field
# EXACTLY: ``addEventListener('agent', …)`` receives NOTHING from a producer that
# publishes ``agent.step``. Neither end can observe the mismatch — the publish
# succeeds, the subscription succeeds, the frames are simply never delivered — so the
# investigation-progress channel was silently dead from the day it was written.
# Naming the channels once, here, is what stops the two ends drifting again; the
# browser client mirrors this list in ``webui/src/lib/useEventStream.ts`` and its
# tests assert the two agree.
#
# These are TRANSPORT names only. Nothing here decides anything (#3): a frame is a
# NUDGE and the client always refetches authoritative state.
AGENT_STEP_EVENT = "agent.step"      # investigator/pipeline progress, room cases:{id}
CASE_ACTIVITY_EVENT = "case.activity"  # case collaboration timeline, room cases:{id}
INAPP_EVENT = "inapp"                # in-app notifications, topics notifications/inbox
JOB_EVENT = "job"                    # durable background-job progress, topic jobs
OVERFLOW_EVENT = "overflow"          # bus control frame: this subscriber dropped events

SSE_EVENT_TYPES: frozenset[str] = frozenset({
    AGENT_STEP_EVENT,
    CASE_ACTIVITY_EVENT,
    INAPP_EVENT,
    JOB_EVENT,
    OVERFLOW_EVENT,
})


# --------------------------------------------------------------------------- #
# SSE frame formatting (pure functions — unit-testable with no network).
# --------------------------------------------------------------------------- #
def _data_lines(payload: str) -> str:
    """Render a (possibly multi-line) JSON payload as one-or-more ``data:`` lines.

    Per the SSE spec each newline in the value becomes its own ``data:`` line; the
    client re-joins them with ``\\n``. Our payloads are compact single-line JSON, but
    we stay spec-correct so a value containing a newline can never break framing."""
    return "".join(f"data: {line}\n" for line in payload.split("\n"))


def format_sse(event_type: str, payload: str, *, event_id: str | None = None) -> str:
    """Format ONE SSE event frame as a string (``id:``? + ``event:`` + ``data:`` + blank).

    ``event_type`` selects the client-side ``addEventListener`` channel; ``payload`` is
    the already-JSON-encoded body. A trailing blank line terminates the frame. Field
    values are sanitised of embedded newlines for the single-token ``id``/``event``
    fields (a newline there would silently split the frame)."""
    out = ""
    if event_id is not None:
        out += f"id: {_one_line(event_id)}\n"
    out += f"event: {_one_line(event_type)}\n"
    out += _data_lines(payload)
    out += "\n"
    return out


def heartbeat_frame() -> str:
    """An SSE comment line used as a keep-alive heartbeat. A line beginning with ``:``
    is a comment the browser ignores, but it keeps the socket (and any proxy) warm."""
    return f": heartbeat {iso_now()}\n\n"


def _one_line(value: str) -> str:
    """Collapse CR/LF so a value can't break out of a single SSE field line (#9-style
    framing hygiene — an id/event token is never multi-line)."""
    return value.replace("\r", " ").replace("\n", " ")


# --------------------------------------------------------------------------- #
# Event record.
# --------------------------------------------------------------------------- #
class _Event:
    """One published event held in a topic's replay ring + fanned out to subscribers.

    ``audience`` is None for a broadcast (every subscriber on the topic) or a set of
    lowercased usernames for a targeted delivery (only those subscribers). ``seq`` is a
    monotonic per-bus counter used both as the SSE ``id`` (for Last-Event-ID replay)
    and to order replay deterministically."""

    __slots__ = ("seq", "id", "topic", "event_type", "payload", "audience", "ts")

    def __init__(
        self,
        seq: int,
        topic: str,
        event_type: str,
        payload: str,
        audience: frozenset[str] | None,
    ) -> None:
        self.seq = seq
        self.id = f"{seq}"
        self.topic = topic
        self.event_type = event_type
        self.payload = payload
        self.audience = audience
        self.ts = iso_now()

    def visible_to(self, user: str | None) -> bool:
        """True when a subscriber identified by ``user`` may receive this event.

        A broadcast (``audience is None``) is visible to everyone. A targeted event is
        visible only when the subscriber's lowercased username is in the audience. An
        anonymous subscriber (``user is None`` — auth disabled) sees broadcasts only;
        targeted events are addressed to a named user."""
        if self.audience is None:
            return True
        if user is None:
            return False
        return user.strip().lower() in self.audience

    def frame(self) -> str:
        return format_sse(self.event_type, self.payload, event_id=self.id)


# --------------------------------------------------------------------------- #
# Subscriber.
# --------------------------------------------------------------------------- #
class _Subscriber:
    """One connected client's outbound queue. Bounded ring with drop-oldest so a slow
    reader never blocks a producer and never grows without bound."""

    __slots__ = ("id", "user", "topics", "_queue", "_event", "_dropped", "_maxlen")

    def __init__(self, user: str | None, topics: frozenset[str], maxlen: int) -> None:
        self.id = new_id("sub-")
        # Store the lowercased username for the audience match (None == anonymous).
        self.user = user.strip().lower() if user else None
        self.topics = topics
        self._maxlen = maxlen
        self._queue: deque[_Event] = deque(maxlen=maxlen)
        self._event = asyncio.Event()
        self._dropped = 0

    def offer(self, event: _Event) -> None:
        """Enqueue an event for this subscriber (non-blocking). When the ring is full
        the OLDEST event is dropped (``deque(maxlen=...)`` evicts the left end), and a
        drop counter is bumped so a later frame can tell the client it missed events."""
        if len(self._queue) == self._maxlen and self._maxlen > 0:
            self._dropped += 1
        self._queue.append(event)
        self._event.set()

    def wants(self, event: _Event) -> bool:
        return event.topic in self.topics and event.visible_to(self.user)

    async def drain(self) -> list[_Event]:
        """Wait until at least one event is queued, then atomically return + clear the
        whole current batch. Used by the streaming generator's main loop."""
        await self._event.wait()
        batch = list(self._queue)
        self._queue.clear()
        self._event.clear()
        return batch

    def pop_dropped(self) -> int:
        n = self._dropped
        self._dropped = 0
        return n


# --------------------------------------------------------------------------- #
# The bus.
# --------------------------------------------------------------------------- #
class EventBus:
    """An in-process, asyncio-friendly multiplexed pub/sub for SSE fan-out.

    Thread-affinity: intended to live on ONE event loop (FastAPI's). All mutation of
    the subscriber registry happens synchronously inside ``publish``/``subscribe`` —
    there are no awaits between read + write of shared state, so no lock is needed on a
    single loop. ``publish`` is callable from any coroutine on that loop and returns
    immediately."""

    def __init__(
        self,
        *,
        heartbeat_seconds: int = DEFAULT_HEARTBEAT_SECONDS,
        subscriber_queue: int = DEFAULT_SUBSCRIBER_QUEUE,
        history_per_topic: int = DEFAULT_HISTORY_PER_TOPIC,
        max_subscribers: int = DEFAULT_MAX_SUBSCRIBERS,
        max_history_topics: int = DEFAULT_MAX_HISTORY_TOPICS,
    ) -> None:
        self._heartbeat_seconds = max(1, int(heartbeat_seconds))
        self._subscriber_queue = max(1, int(subscriber_queue))
        self._history_per_topic = max(0, int(history_per_topic))
        self._max_subscribers = max(1, int(max_subscribers))
        self._max_history_topics = max(1, int(max_history_topics))
        self._seq = 0
        self._subscribers: dict[str, _Subscriber] = {}
        # Per-topic replay ring (bounded), LRU-capped by topic COUNT (audit #32): an
        # OrderedDict whose least-recently-published topic is evicted past the cap, so a
        # flood of distinct cases:{id} topics can't grow history without bound.
        self._history: OrderedDict[str, deque[_Event]] = OrderedDict()

    # --- configuration (re-applied from Preferences.realtime on prefs reload) ---
    def configure(self, *, heartbeat_seconds: int | None = None) -> None:
        """Apply runtime-tunable config (currently the heartbeat cadence) from
        ``Preferences.realtime``. Safe to call repeatedly; affects new heartbeats. Never
        drops existing subscribers."""
        if heartbeat_seconds is not None:
            self._heartbeat_seconds = max(1, int(heartbeat_seconds))

    @property
    def heartbeat_seconds(self) -> int:
        return self._heartbeat_seconds

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    # --- publish (fire-and-forget, non-blocking) ---
    def publish(
        self,
        topic: str,
        event_type: str,
        data: Any,
        *,
        audience: Iterable[str] | None = None,
        retain: bool = True,
    ) -> str:
        """Publish ``data`` to ``topic`` under the SSE ``event_type`` channel.

        FIRE-AND-FORGET + NON-BLOCKING: appends to the topic's replay ring and offers
        the event to every matching subscriber's bounded queue, then returns the event
        id. Safe with ZERO subscribers (a cheap history append). Safe to call when
        realtime is disabled (the endpoint just won't be serving anyone).

        ``audience`` — None broadcasts to every subscriber on the topic; an iterable of
        usernames restricts delivery to those users (per-user scoping for #8). Names are
        lowercased for a case-insensitive match.

        ``data`` is JSON-encoded with ``default=str`` so a Pydantic ``model_dump`` dict,
        a datetime, etc. all serialise; a non-serialisable value never raises into the
        producer (it falls back to a stringified payload)."""
        aud: frozenset[str] | None
        if audience is None:
            aud = None
        else:
            aud = frozenset(str(u).strip().lower() for u in audience if str(u).strip())
        payload = _encode(data)
        self._seq += 1
        event = _Event(self._seq, topic, event_type, payload, aud)
        # Replay history is normally bounded and retained even with no subscribers.
        # A producer may explicitly disable retention for identity-sensitive data
        # whose audience key is mutable (for example a deleted/recreated username).
        if retain and self._history_per_topic > 0:
            ring = self._history.get(topic)
            if ring is None:
                ring = deque(maxlen=self._history_per_topic)
                self._history[topic] = ring
                # LRU-evict the least-recently-published topic past the cap (audit #32).
                while len(self._history) > self._max_history_topics:
                    self._history.popitem(last=False)
            else:
                self._history.move_to_end(topic)  # mark most-recently-published
            ring.append(event)
        # Fan out (non-blocking offer to each matching subscriber).
        for sub in self._subscribers.values():
            if sub.wants(event):
                sub.offer(event)
        return event.id

    # --- replay support ---
    def replay(self, topics: frozenset[str], user: str | None, after_id: str | None) -> list[_Event]:
        """Events on ``topics`` visible to ``user`` with ``seq`` strictly greater than
        ``after_id`` (the client's Last-Event-ID), in seq order. Empty when ``after_id``
        is None/invalid or nothing newer exists. Used to replay missed events on
        reconnect. Bounded by the per-topic history ring."""
        if after_id is None:
            return []
        try:
            after = int(str(after_id).strip())
        except (TypeError, ValueError):
            return []
        out: list[_Event] = []
        for topic in topics:
            for ev in self._history.get(topic, ()):  # type: ignore[arg-type]
                if ev.seq > after and ev.visible_to(user):
                    out.append(ev)
        out.sort(key=lambda e: e.seq)
        return out

    # --- subscribe (async generator yielding SSE-framed bytes) ---
    async def subscribe(
        self,
        topics: Iterable[str],
        user: str | None = None,
        *,
        last_event_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        """Subscribe to ``topics`` and yield SSE-framed ``bytes`` until the consumer
        stops iterating (the client disconnects / the StreamingResponse is closed).

        Yields, in order:
          1. an initial ``: connected`` comment (flushes headers immediately),
          2. any Last-Event-ID REPLAY frames (missed events on reconnect),
          3. live event frames as they arrive, and
          4. a heartbeat comment every ``heartbeat_seconds`` of idleness.

        PER-USER SCOPING is enforced via the event audience: a subscriber only sees
        broadcasts + events addressed to its ``user``. The subscriber is registered on
        entry and ALWAYS unregistered in ``finally`` (even on cancellation), so a
        disconnect frees the slot. Bounded-subscriber eviction drops the OLDEST
        subscriber when the cap is exceeded."""
        topic_set = frozenset(str(t) for t in topics if str(t))
        sub = _Subscriber(user, topic_set, self._subscriber_queue)
        self._register(sub)
        # Snapshot the seq at registration: events published AFTER this are delivered LIVE
        # via the subscriber queue, so replay must NOT also re-send them (audit #33). Any
        # event with seq > reg_seq was offered to our queue when it published; capping the
        # replay at reg_seq makes replay and live cover disjoint ranges — no duplicate frame.
        reg_seq = self._seq
        try:
            # Flush headers right away so the browser's EventSource fires ``onopen``.
            yield b": connected\n\n"
            # Replay anything the client missed since its Last-Event-ID, up to the seq at
            # registration (later events arrive live).
            for ev in self.replay(topic_set, sub.user, last_event_id):
                if ev.seq <= reg_seq:
                    yield ev.frame().encode("utf-8")
            while True:
                try:
                    batch = await asyncio.wait_for(sub.drain(), timeout=self._heartbeat_seconds)
                except asyncio.TimeoutError:
                    # Evicted (bounded-subscriber cap) while idle → stop so the socket
                    # closes and the client reconnects (audit #34).
                    if sub.id not in self._subscribers:
                        break
                    # Idle — keep the connection warm.
                    yield heartbeat_frame().encode("utf-8")
                    continue
                # Evicted mid-stream: the cap dropped us from the registry (and woke the
                # drain). Stop streaming so the StreamingResponse unwinds and the socket
                # closes — otherwise the connection lingers as a ZOMBIE that gets no
                # events yet holds a slot, defeating the flood bound and silently muting
                # the client (audit #34).
                if sub.id not in self._subscribers:
                    break
                dropped = sub.pop_dropped()
                if dropped:
                    # Tell the client it missed events (it can refetch authoritative
                    # state). A control event on a reserved channel, never a real model.
                    yield format_sse(
                        OVERFLOW_EVENT,
                        _encode({"dropped": dropped, "ts": iso_now()}),
                    ).encode("utf-8")
                for ev in batch:
                    yield ev.frame().encode("utf-8")
        finally:
            self._unregister(sub.id)

    # --- registry helpers (synchronous; single-loop, no lock needed) ---
    def _register(self, sub: _Subscriber) -> None:
        # Evict the OLDEST subscriber(s) if we're at/over the cap (dict preserves
        # insertion order). This bounds memory even under a connection flood.
        while len(self._subscribers) >= self._max_subscribers and self._subscribers:
            oldest_id = next(iter(self._subscribers))
            self._unregister(oldest_id)
        self._subscribers[sub.id] = sub

    def _unregister(self, sub_id: str) -> None:
        sub = self._subscribers.pop(sub_id, None)
        if sub is not None:
            # Wake any pending drain so the generator's finally can complete promptly.
            sub._event.set()  # noqa: SLF001 — same module, intentional

    def clear(self) -> None:
        """Drop all subscribers + history. Test/shutdown helper; never used on the hot
        path. Wakes pending drains so their generators unwind."""
        for sub_id in list(self._subscribers):
            self._unregister(sub_id)
        self._history.clear()


def _encode(data: Any) -> str:
    """JSON-encode a payload defensively: a Pydantic dict, datetime, etc. serialise via
    ``default=str``; anything that still can't encode degrades to a stringified payload
    rather than raising into a fire-and-forget producer."""
    try:
        return json.dumps(data, default=str, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError):
        return json.dumps({"_unencodable": str(data)}, separators=(",", ":"))


# --------------------------------------------------------------------------- #
# Module-level singleton accessor (survives AppState._wire() rebuilds).
# --------------------------------------------------------------------------- #
_BUS: EventBus | None = None


def get_event_bus() -> EventBus:
    """The process-wide :class:`EventBus` singleton.

    A MODULE global (not an ``AppState`` attribute) so it survives every
    ``AppState._wire()`` rebuild — producers (poller / case manager / notification
    dispatcher) and the ``GET /api/events`` endpoint all import THIS accessor and share
    the one bus. Lazily constructed on first use with safe defaults; the integrator may
    call ``configure_event_bus(prefs.realtime)`` after prefs load to apply the operator's
    heartbeat cadence."""
    global _BUS
    if _BUS is None:
        _BUS = EventBus()
    return _BUS


def configure_event_bus(realtime: Any | None) -> EventBus:
    """Apply ``Preferences.realtime`` (a :class:`app.config.RealtimeConfig`) to the
    singleton and return it. Tolerates None (leaves defaults). Idempotent — safe to call
    on every prefs reload. Does NOT toggle anything off: when ``realtime.enabled`` is
    False the bus still exists and is safe to publish to; the ENDPOINT decides whether to
    serve a stream (204 when disabled)."""
    bus = get_event_bus()
    if realtime is not None:
        hb = getattr(realtime, "heartbeat_seconds", None)
        if hb is not None:
            bus.configure(heartbeat_seconds=int(hb))
    return bus


def reset_event_bus() -> None:
    """Drop the singleton (tests only). The next ``get_event_bus()`` builds a fresh one."""
    global _BUS
    if _BUS is not None:
        _BUS.clear()
    _BUS = None
