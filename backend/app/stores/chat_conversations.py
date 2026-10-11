"""Durable, bounded, per-user Workspace chat history.

Workspace transcripts are intentionally separate from case-scoped collaboration
threads.  Every normalized principal owns a hashed KV partition, so one user's
history read/write never loads every other user's transcript.  The legacy shared
document is read lazily and migrated one principal at a time.

Unlike the platform's best-effort auxiliary stores, chat persistence is part of the
send contract: a saved turn must really be durable.  This module therefore uses the
strict KV hooks when a backend exposes them, verifies every compare-and-set, and
raises :class:`ChatHistoryUnavailable` instead of returning optimistic success.

Chat revamp storage form (SPEC §7.5):

* **Opaque presentation.** An assistant message stores a small whitelist of scalar
  fields plus ONE canonical-JSON string, ``presentation_json``, holding every
  structured field (blocks, steps, citations, console links, follow-ups, notice,
  usage, the legacy table ...). The Elasticsearch KV index maps the partition
  document dynamically, so a nested block, row or series would let log- or
  model-derived values mint field names and types in the shared config index; an
  opaque string cannot. Reads decode leniently and still accept the legacy
  pre-revamp dict ``response``; the decoded ``response.answer`` is re-injected from
  the message content (the routes add ``message_id`` from the message id).
* **Compact storage.** A stored presentation is at most
  :data:`MAX_PRESENTATION_BYTES`, measured as stored (the JSON string escaped inside
  the partition document) (tables keep 25 rows, series 100 points, step
  queries 1 kB, and the legacy ``table`` is dropped when a table block carries the
  same rows); live turns keep the full limits.
* **Downgrade before drop.** Over :data:`MAX_CONVERSATION_BYTES` the oldest answers'
  blocks become "Expired from saved history" stubs and their steps lose params and
  queries; whole exchanges are dropped only after that, so prompt and answer text
  always outlive older charts. Because the presentation cap is measured as stored,
  twelve maximal rich exchanges always fit while their prompt and answer text
  average under ~4 kB each (12 × (16 kB + text + ~0.7 kB of metadata) ≤ 256 kB).
* **Pins, totals, search.** Up to :data:`MAX_PINNED_CONVERSATIONS` pinned
  conversations are exempt from eviction and listed first; cumulative token/cost
  totals survive trimming; ``search`` matches titles, message text and block titles.
* **Compact receipts.** An idempotency receipt keeps the assistant message id, a
  bounded copy of the answer text and the scalar whitelist only — never the full
  response — so 256 receipts cannot outgrow the transcript they protect.
* **Partition storage form, per backend.** Both forms are always READ; which one is
  WRITTEN depends on the KV backend (:func:`app.stores.case_thread.opaque_rows_for`).

  - *Form 2, keyed* (``conversations.<cid>``, ``requests.<key>``) on the SQL backend
    (PostgreSQL / SQLite). Every released build reads exactly this, and the PostgreSQL
    Compose profile's supported image-only rollback never rewrites state, so the
    previous build must keep reading AND writing the partition: it rewrites the whole
    document in form 2 and, had it found form 3, would have read no history and erased
    it with its next turn.
  - *Form 3, opaque rows* everywhere else (the Elasticsearch KV adapter). There every
    KV namespace shares ONE dynamically mapped config index (default limit 1,000
    fields), and form 2 mints ~20 mapped fields per conversation or request until
    writes fail for every namespace. Form 3 stores each conversation and each request
    record as ONE opaque canonical-JSON string in two arrays
    (:data:`CONVERSATION_ROWS_KEY`, :data:`REQUEST_ROWS_KEY`): the document's field
    paths are a fixed handful whatever it holds, and no stored value (a date-like
    title, a mixed-type legacy table row) can conflict with a dynamic mapping. It is
    ONE-WAY: a build released before it reads an empty history and its next write
    drops the rows, so an image rollback on the Elasticsearch backend after this build
    has written loses the chat history written since (that backend has no supervised
    rollback; the trade is a bounded mapping vs. failing every KV write).

Round 12 (SPEC D1/D4/D13, chat without limits):

* **Full text, never evicted.** Every exchange also gets its OWN document in this
  namespace (``x-<hash>``, one opaque ``chat_exchange_json`` string: the full user
  text, the full answer text and the full, uncompacted stored response). The
  partition row keeps a bounded INLINE copy of each message (the form above: 12,000 /
  24,000 characters, a compact presentation); when the inline copy is not the whole
  message the stored response carries ``truncated`` plus the scalar marker
  ``exchange_saved`` and reads restore the message from its exchange document, so an
  answer of any length (60,000+ characters) replays byte for byte. No message is
  removed from a conversation: over :data:`MAX_CONVERSATION_BYTES` the OLDEST
  exchange-backed messages' inline copies shrink to short previews (no query), and
  older pre-Round-12 answers are only downgraded as before.
* **A hard inline ceiling (archive pages).** A row keeps at most
  :data:`ARCHIVE_TRIGGER_MESSAGES` messages; past it the oldest move — whole pairs,
  oldest first — to the conversation's archive pages (``a-<hash>``, one opaque
  ``chat_archive_json`` string of :data:`ARCHIVE_PAGE_MESSAGES` stored messages each:
  an exchange-backed answer and its question as previews, an older answer whole, as
  its only copy) until :data:`INLINE_KEEP_MESSAGES` remain. The row records the
  archive as ``chat_archive`` ``{count, oldest_at}`` (a key outside the conversation
  model; ``message_count`` counts archived messages, which are retained). Pages are
  written first, then the row under its compare-and-set, so an interrupted archive
  leaves the row a little longer and never loses a message.
* **Windowed reads.** :meth:`ChatConversationStore.get` returns the newest
  :data:`TRANSCRIPT_WINDOW` messages restored to full text (``earlier_message_count``
  counts the rest; ``messages_page`` reads them a page at a time); the turn route reads
  the whole transcript but restores only what the replay uses (after the running
  summary). Saving, renaming, pinning, the step inspector, feedback and reports read
  ONE answer (``get_exchange``/``message``), never the transcript. A search reads the
  full text of partial and archived messages concurrently, at most
  :data:`DEEP_SEARCH_MAX_LOADS` documents, and says when that cut it short.
* **Running summary** (D4): ``s-<hash>`` holds the engine's conversation summary
  (``chat_summary_json``); the row records ``summary_covers_through``.
* **Step observations** (P1-1): the observations the model saw, per answer, in a
  per-user ring of :data:`OBSERVATION_RING_SIZE` slots (``o-<hash>``; index
  ``oi-<hash>``), each step's observation at most :data:`MAX_OBSERVATION_CHARS`
  characters. Older answers' step inspectors report the observation as no longer
  stored. Aggregates only, exactly as the model saw them (#7).
* **Live state** (``v-<hash>``, one per owner, one opaque ``chat_live_json``): the
  turn heartbeat's lease entries and the row flags. A row reads ``running`` while a
  turn holds a reservation for it and has not ENDED (a brand-new thread is listed as
  a temporary row from its reservation); ``needs_input`` after a clarifying question,
  ``failed`` after a failed turn (a billed one ENDS its reservation: the key stays
  held for a full lease so a same-key retry never bills twice, but nothing reads
  running); ``unread`` once an answer is saved, until :meth:`mark_read`. The
  heartbeat, ``mark_read`` and the failed mark write ONLY this small document, never
  the partition. A conversation a running turn answers in is never evicted.

Every new document uses fixed, ``chat_``-prefixed field names and one opaque string,
so the Elasticsearch mapping stays bounded; keys are SHA-256 digests of the owner's
partition key and the message/conversation id (never a raw username), at most 43
characters (the SQL ``kv.key`` column is 128). The KV contract has no delete, so a
removed document is overwritten by an empty one (``{"schema": 1}``).

**SQL image rollback (honest notes).** The previous (Stable) build reads and writes
the partition rows only. Rolled back, it shows each message's inline copy: answers
longer than 24,000 characters end at that limit with its "truncated" marker, older
messages of a long conversation appear as short previews, and the messages of an
archived conversation's pages are not shown (the row's count makes it say older
turns were removed). Its writes keep every message and its stored response (and so
the ``exchange_saved`` marker), so rolling forward restores the full text — except
where the previous build answered in a conversation of more than 100 messages or
256 kB: it trims that conversation to its own window, and the trimmed messages do
not come back; and a conversation it rewrites loses its ``chat_archive`` record, so
its archived messages are no longer linked (the pages and exchange documents stay in
the namespace until a factory reset). It also drops the Round-12 row fields
(``summary_covers_through``) on its next write, like the revamp fields before them;
the summary and live-state documents themselves survive.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Iterable, Iterator, Literal, TypeVar

from ..agents.blocks import (
    STORED_QUERY_CHARS,
    STORED_SERIES_POINTS,
    STORED_TABLE_ROWS,
    expire_block,
    is_expired_block,
    parse_persisted_blocks,
    table_cell,
)
from ..constants import (
    CHAT_CONVERSATIONS_KEY,
    CHAT_CONVERSATIONS_NS,
    USER_PREFS_DEFAULT_BUCKET,
)
from ..models import (
    ChatConversation,
    ChatConversationMatch,
    ChatConversationMessage,
    ChatConversationSearchHit,
    ChatConversationSummary,
    TimeRange,
)
from ..utils import iso_now, new_id
from .base import KVStore
from .case_thread import opaque_rows_for

_T = TypeVar("_T")
_C = TypeVar("_C", bound=ChatConversationSummary)

logger = logging.getLogger("tlsoc.stores.chat_conversations")

MAX_CONVERSATIONS_PER_USER = 50
# The previous build's transcript window. Round 12 no longer removes messages; the
# constant stays for importers and for the rollback notes in the module docstring.
MAX_MESSAGES_PER_CONVERSATION = 100
# The INLINE budget of one conversation row (Round 12: over it, the oldest
# exchange-backed messages' inline copies become previews; nothing is removed).
MAX_CONVERSATION_BYTES = 256_000
# Inline copy limits (the full text lives in the message's exchange document).
MAX_USER_MESSAGE_CHARS = 12_000
MAX_ASSISTANT_MESSAGE_CHARS = 24_000
# Retained for importers; the bounded storage form is now MAX_PRESENTATION_BYTES.
MAX_RESPONSE_BYTES = 64_000
MAX_TITLE_CHARS = 80
MAX_PREVIEW_CHARS = 160
MAX_IDEMPOTENCY_RECORDS = 256
IDEMPOTENCY_PENDING_TTL_SECONDS = 10 * 60
CAS_RETRIES = 8
# SPEC §7.5 Pin: pinned conversations are exempt from the 50-conversation eviction,
# so a listing of at most 50 + 10 rows always holds every pinned thread.
MAX_PINNED_CONVERSATIONS = 10
MAX_LIST_LIMIT = MAX_CONVERSATIONS_PER_USER + MAX_PINNED_CONVERSATIONS
# SPEC §7.5 Compact storage: one stored assistant presentation.
MAX_PRESENTATION_BYTES = 16_384
# A completed receipt outlives its transcript message; it keeps only this much of the
# answer text for a lost-response replay after retention removed the message.
MAX_RECEIPT_CONTENT_CHARS = 2_000
MAX_SEARCH_CHARS = 200
MAX_SNIPPET_CHARS = 160

# --- Round 12 auxiliary documents (same namespace; see the module docstring). ------ #
AUX_SCHEMA = 1
EXCHANGE_KEY_PREFIX = "x-"
SUMMARY_KEY_PREFIX = "s-"
OBSERVATION_KEY_PREFIX = "o-"
OBSERVATION_INDEX_PREFIX = "oi-"
EXCHANGE_FIELD = "chat_exchange_json"
SUMMARY_FIELD = "chat_summary_json"
OBSERVATION_FIELD = "chat_observation_json"
OBSERVATION_INDEX_FIELD = "chat_observation_index_json"
# The scalar marker on a stored assistant response whose full exchange is in its own
# document. Internal: never returned to clients.
EXCHANGE_MARKER = "exchange_saved"
# A shrunken inline copy (an old exchange-backed message past the inline budget).
REDUCED_PREVIEW_CHARS = 280
# Exchange documents read concurrently when a transcript is restored.
HYDRATE_CONCURRENCY = 16
# The engine's running conversation summary (D4), stored as text.
MAX_SUMMARY_CHARS = 64_000
# Step observations (P1-1): the most recent answers whose observations are kept, per
# user; per step and per answer bounds.
OBSERVATION_RING_SIZE = 100
MAX_OBSERVATION_CHARS = 24_000
MAX_OBSERVATION_STEPS = 120
MAX_OBSERVATION_DOC_CHARS = 1_500_000
# Documents (exchange documents and archive pages) one search may read for messages
# whose inline copy is a preview; past it the search says it was cut short.
DEEP_SEARCH_MAX_LOADS = 500
OBSERVATION_REF_RE = re.compile(r"^o(?P<slot>[0-9]{1,4}):(?P<turn>[A-Za-z0-9._:-]{1,128})$")
# --- Live state (leases and row flags), one small document per owner. ---------- #
# The lease heartbeat, ``mark_read`` and the failed/needs-input marks write ONLY this
# document, never the partition (whose rewrite costs grow with the transcripts).
LIVE_STATE_PREFIX = "v-"
LIVE_STATE_FIELD = "chat_live_json"
MAX_LIVE_FLAGS = 200
_ROW_STATUSES = frozenset({"idle", "running", "needs_input", "failed"})
# --- Archive (the hard inline ceiling). ---------------------------------------- #
# A conversation row keeps at most ARCHIVE_TRIGGER_MESSAGES messages inline; past it
# the oldest move to the conversation's archive pages (``a-<hash>``, one opaque
# ``chat_archive_json`` string of ARCHIVE_PAGE_MESSAGES stored messages each) until
# INLINE_KEEP_MESSAGES remain. The row records the archive as ``chat_archive``
# ({count, oldest_at}), a key outside the conversation model.
ARCHIVE_KEY_PREFIX = "a-"
ARCHIVE_FIELD = "chat_archive_json"
ARCHIVE_ROW_KEY = "chat_archive"
ARCHIVE_TRIGGER_MESSAGES = 140
INLINE_KEEP_MESSAGES = 100
ARCHIVE_PAGE_MESSAGES = 200
# ``GET /chat/conversations/{id}`` returns the newest TRANSCRIPT_WINDOW messages (each
# restored to its full text); older ones are read a page at a time (``messages_page``).
TRANSCRIPT_WINDOW = 100
MAX_MESSAGE_PAGE = 100
# Wire-only conversation fields that are never stored on a row.
_UNSTORED_ROW_FIELDS = ("earlier_message_count",)

# The ``schema`` a partition document records: the storage form it was written in.
KEYED_STORAGE_FORM = 2
OPAQUE_STORAGE_FORM = 3
_SCHEMA_VERSION = OPAQUE_STORAGE_FORM
_PARTITION_PREFIX = "user-"
# Storage form 3: one opaque canonical-JSON string per conversation / request record
# (see the module docstring). Distinct names, because the form 2 keys are already
# mapped as objects in existing Elasticsearch config indexes and a string array
# written to an object field would be refused.
CONVERSATION_ROWS_KEY = "chat_conversation_rows"
REQUEST_ROWS_KEY = "chat_request_rows"
# Storage form 2 (keyed by conversation id / idempotency key).
_LEGACY_CONVERSATIONS_KEY = "conversations"
_LEGACY_REQUESTS_KEY = "requests"

# The ONE opaque string that holds an assistant message's structured presentation.
PRESENTATION_KEY = "presentation_json"
# Scalar response fields stored as plain values (they never carry log- or model-
# derived field NAMES, and their types are fixed). Everything else is presentation.
STORED_SCALAR_KEYS: frozenset[str] = frozenset({
    "query", "case_id", "cost", "idempotency_key", "effective_model",
    "effective_source_id", "effective_source_name", "truncated", "turn_id",
    "blocks_version",
})
# Re-derived on decode (the message itself is the truth), never stored twice.
# ``user_message_id`` (Round 12 WP-FIX1) is the id of the message before the answer: a
# restored transcript reads it from that message, so it is never stored either.
_DERIVED_RESPONSE_KEYS: frozenset[str] = frozenset({
    "answer", "message_id", "conversation_id", "conversation_title", "user_message_id",
})
# The decoded legacy ``table`` is rebuilt from this table block when the stored form
# dropped it (SPEC §7.5: not persisted when a table block carries the same rows).
_TABLE_BLOCK_KEY = "table_block"
_LEGACY_TABLE_PREVIEW = 50
_LEGACY_QUERY_CHARS = 4_000
# A user message's ``response`` carries only who authored it (SPEC §4.8 taint rules
# replay it), and only when that is not the default "user".
USER_ORIGINS: frozenset[str] = frozenset({
    "user", "follow_up", "starter", "command", "continue",
    # Round 12 (SPEC §3.1): a clarify pick and a step-inspector retry.
    "clarify", "retry_step",
})
_ORIGIN_KEY = "origin"
# Compaction tiers: (table rows, series points, timeline events, case items, query chars).
_STANDARD_TIER = (STORED_TABLE_ROWS, STORED_SERIES_POINTS, STORED_TABLE_ROWS, STORED_TABLE_ROWS, STORED_QUERY_CHARS)
_TIGHT_TIER = (10, 50, 10, 10, 500)
# Step fields an expired (downgraded) answer no longer keeps (SPEC §7.5 Retention).
_STEP_DETAIL_KEYS = ("params", "untrusted_params", "query")


class ChatHistoryUnavailable(RuntimeError):
    """The history backend could not prove that a read or write succeeded."""


class ChatRequestInProgress(RuntimeError):
    """The same idempotency key currently owns an unexpired model invocation."""


class ChatRequestFailed(ChatRequestInProgress):
    """The same idempotency key belongs to a BILLED turn whose answer could not be
    saved (an ENDED reservation, :meth:`ChatConversationStore.end_reservation`).
    Nothing is running: the key stays held until its lease runs out (a retry never
    bills the same answer twice), but a retry is told the request failed instead of
    waiting for a turn that will never finish. A subclass of
    :class:`ChatRequestInProgress`, so older callers still refuse the retry."""


CHAT_REQUEST_FAILED_MESSAGE = (
    "This request was answered but could not be saved. Ask again to start a new request."
)


class ChatRequestCapacityBusy(RuntimeError):
    """A principal already owns the maximum number of live request leases."""


class ChatIdempotencyConflict(RuntimeError):
    """An idempotency key was reused for a materially different request."""


class ChatConversationMissing(RuntimeError):
    """A requested owned conversation no longer exists."""


class ChatPinLimitReached(RuntimeError):
    """Pinning one more conversation would exceed :data:`MAX_PINNED_CONVERSATIONS`."""


@dataclass(frozen=True)
class ChatHistoryPage:
    conversations: list[ChatConversationSummary]
    total: int
    history_truncated: bool
    total_conversation_count: int
    oldest_retained_at: str | None
    # A search whose full-text reads hit :data:`DEEP_SEARCH_MAX_LOADS`: older messages
    # of some conversations were not searched (the listing says so; never silent).
    search_incomplete: bool = False


class ChatMessageMissing(LookupError):
    """A message id named by a page request is not part of the conversation."""


@dataclass(frozen=True)
class ChatExchangeReservation:
    status: Literal["reserved", "completed"]
    idempotency_key: str
    conversation_id: str
    conversation: ChatConversation | None = None
    assistant_message: ChatConversationMessage | None = None
    conversation_title: str | None = None
    lease_token: str | None = None


@dataclass(frozen=True)
class ConversationSummaryRecord(Mapping):
    """The stored running conversation summary (SPEC D4, §3.6) the routes hand to
    the engine with the replay history. Readable as attributes (``text``,
    ``covers_through``) and as a mapping (``summary_text``,
    ``summary_covers_through``, ``text``, ``covers_through``), so either engine
    convention works. The text is model-written from tainted content: the engine
    must fence it (``CONVERSATION_SUMMARY``, #9)."""

    text: str
    covers_through: str | None = None
    updated_at: str | None = None

    @property
    def summary_text(self) -> str:
        return self.text

    @property
    def summary_covers_through(self) -> str | None:
        return self.covers_through

    def _as_dict(self) -> dict[str, Any]:
        return {
            "summary_text": self.text, "summary_covers_through": self.covers_through,
            "text": self.text, "covers_through": self.covers_through,
        }

    def __getitem__(self, key: str) -> Any:
        return self._as_dict()[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._as_dict())

    def __len__(self) -> int:
        return 4


@dataclass(frozen=True)
class ExchangeRecord:
    """One exchange document's payload (the full text of one question and answer)."""

    conversation_id: str
    user_message_id: str
    assistant_message_id: str
    user_content: str
    assistant_content: str
    response: dict[str, Any] | None
    created_at: str = ""


@dataclass
class _Removed:
    """Conversations a write removed (eviction, delete, clear): their auxiliary
    documents (exchanges, archive pages, summary, observations, feedback, live flags)
    are blanked after the partition write is confirmed."""

    conversations: list[ChatConversation] = field(default_factory=list)
    archives: dict[str, dict[str, Any]] = field(default_factory=dict)

    def reset(self) -> None:
        self.conversations.clear()
        self.archives.clear()

    def take(self, data: dict[str, Any], conversations: Iterable[ChatConversation]) -> None:
        archives = data.get("archives") or {}
        for conversation in conversations:
            self.conversations.append(conversation)
            if conversation.id in archives:
                self.archives[conversation.id] = dict(archives[conversation.id])


# Background cleanup tasks are named with this prefix, so a shutdown or factory reset
# can finish the ones running on its own event loop (``drain_background_cleanup``).
CLEANUP_TASK_PREFIX = "chat-history-cleanup"


async def drain_background_cleanup(timeout: float = 10.0) -> int:
    """Wait (bounded) for the chat-history cleanup tasks of the running event loop —
    called on shutdown and factory reset, so best-effort blanking finishes instead of
    being dropped with the loop. Returns how many were pending."""
    current = asyncio.current_task()
    pending = [
        task for task in asyncio.all_tasks()
        if task is not current and not task.done() and task.get_name().startswith(CLEANUP_TASK_PREFIX)
    ]
    if pending:
        await asyncio.wait(pending, timeout=max(0.1, timeout))
    return len(pending)


def _supports_concurrent_writes(kv: Any) -> bool:
    """Whether best-effort cleanup may write several documents at once (and off the
    request path). Not on SQLite: it serialises writers, and an in-memory database
    shares ONE connection on which concurrent transactions fail — there, cleanup
    stays sequential and inline, as before (local writes are fast)."""
    engine = getattr(kv, "_engine", None)
    try:
        return engine.url.get_backend_name() != "sqlite"
    except AttributeError:
        return True


def normalize_user_id(user_id: str | None) -> str:
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


def partition_key_for_user(user_id: str | None) -> str:
    """Opaque deterministic key; raw usernames never appear in KV document ids."""
    digest = hashlib.sha256(normalize_user_id(user_id).encode("utf-8")).hexdigest()
    return f"{_PARTITION_PREFIX}{digest}"


def _aux_key(prefix: str, *parts: str) -> str:
    """A short opaque key (prefix + 40 hex) derived from the owner's PARTITION KEY and
    the record id, so no raw username or id reaches a key, the key fits the SQL
    ``kv.key`` column, and a factory clear can rebuild every key from the registry."""
    digest = hashlib.sha256("\x00".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:40]
    return f"{prefix}{digest}"


def exchange_key(partition_key: str, assistant_message_id: str) -> str:
    """The exchange document key of one answer (Round 12)."""
    return _aux_key(EXCHANGE_KEY_PREFIX, "exchange", partition_key, assistant_message_id)


def summary_key(partition_key: str, conversation_id: str) -> str:
    """The running-summary document key of one conversation (Round 12, D4)."""
    return _aux_key(SUMMARY_KEY_PREFIX, "summary", partition_key, conversation_id)


def observation_slot_key(partition_key: str, slot: int) -> str:
    """One slot of the owner's step-observation ring (Round 12, P1-1)."""
    return _aux_key(OBSERVATION_KEY_PREFIX, "observation", partition_key, str(int(slot)))


def observation_index_key(partition_key: str) -> str:
    return _aux_key(OBSERVATION_INDEX_PREFIX, "observation-index", partition_key)


def live_state_key(partition_key: str) -> str:
    """The owner's live-state document (leases and row flags)."""
    return _aux_key(LIVE_STATE_PREFIX, "live-state", partition_key)


def archive_page_key(partition_key: str, conversation_id: str, page: int) -> str:
    """One archive page of one conversation."""
    return _aux_key(ARCHIVE_KEY_PREFIX, "archive", partition_key, conversation_id, str(int(page)))


def derive_title(message: str) -> str:
    title = " ".join(str(message or "").split()).strip()
    if not title:
        return "New conversation"
    if len(title) <= MAX_TITLE_CHARS:
        return title
    return title[: MAX_TITLE_CHARS - 1].rstrip() + "…"


def _clip(value: str, limit: int) -> tuple[str, bool]:
    text = str(value or "")
    if len(text) <= limit:
        return text, False
    marker = "\n… [truncated in saved history]"
    return text[: max(0, limit - len(marker))].rstrip() + marker, True


# --------------------------------------------------------------------------- #
# Storage form of one assistant response (SPEC §7.5).
# --------------------------------------------------------------------------- #
def canonical_json(value: Any) -> str:
    """Sorted, compact, NaN-free JSON: equal presentations always encode to equal
    bytes, so size accounting and test comparisons are deterministic."""
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        default=str,
    )


def _json_size(value: Any) -> int:
    try:
        return len(canonical_json(value).encode("utf-8"))
    except (TypeError, ValueError):
        return MAX_CONVERSATION_BYTES + 1


def stored_presentation_size(presentation: Any) -> int:
    """Bytes ``presentation`` occupies in its stored message JSON: its canonical JSON
    is stored as a JSON *string*, so every quote and backslash is escaped once more
    (a quote-dense table of short cells grows by ~40 %). :data:`MAX_PRESENTATION_BYTES`
    caps THIS size, because it is what ``_trim_messages`` counts against
    :data:`MAX_CONVERSATION_BYTES` — capping the unescaped form let twelve
    quote-dense answers overflow the transcript and lose the 12-rich guarantee."""
    try:
        return len(json.dumps(canonical_json(presentation), ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return MAX_CONVERSATION_BYTES + 1


def _is_scalar(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str, int)):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _empty(value: Any) -> bool:
    return value is None or value == [] or value == {}


def _clip_list(items: Any, limit: int, *, tail: bool = False) -> tuple[list[Any], bool]:
    values = list(items) if isinstance(items, (list, tuple)) else []
    if len(values) <= limit:
        return values, False
    return (values[-limit:] if tail else values[:limit]), True


def _clip_text(value: Any, limit: int) -> tuple[Any, bool]:
    if isinstance(value, str) and len(value) > limit:
        return value[: max(0, limit - 1)].rstrip() + "…", True
    return value, False


def _compact_block(block: Any, tier: tuple[int, int, int, int, int]) -> Any:
    """One block cut to the storage tier: lists shortened (and disclosed with
    ``truncated``/``total`` or ``downsampled_for_storage``), never values altered."""
    if not isinstance(block, dict):
        return block
    rows_cap, points_cap, events_cap, items_cap, query_cap = tier
    out = dict(block)
    kind = out.get("type")
    if kind == "table":
        rows, clipped = _clip_list(out.get("rows"), rows_cap)
        if clipped:
            out["total"] = out.get("total") if isinstance(out.get("total"), int) else len(out.get("rows") or [])
            out["rows"], out["truncated"] = rows, True
    elif kind == "chart":
        x = out.get("x") if isinstance(out.get("x"), dict) else None
        values = x.get("values") if x is not None and isinstance(x.get("values"), list) else None
        if values is not None and len(values) > points_cap:
            # A time axis keeps its NEWEST points, a category axis the first (largest)
            # ones, mirroring the live clip in blocks.ChartBlock.
            tail = x.get("kind") == "time"
            start = len(values) - points_cap if tail else 0
            stop = start + points_cap
            out["x"] = {**x, "values": values[start:stop]}
            series = []
            for item in out.get("series") or []:
                if isinstance(item, dict) and isinstance(item.get("values"), list):
                    item = {**item, "values": item["values"][start:stop]}
                series.append(item)
            out["series"] = series
            if isinstance(out.get("drill"), list):
                out["drill"] = out["drill"][start:stop]
            out["downsampled_for_storage"] = True
    elif kind == "timeline":
        events, clipped = _clip_list(out.get("events"), events_cap, tail=True)
        if clipped:
            out["total"] = out.get("total") if isinstance(out.get("total"), int) else len(out.get("events") or [])
            out["events"], out["truncated"] = events, True
    elif kind == "case_list":
        items, clipped = _clip_list(out.get("items"), items_cap)
        if clipped:
            out["total"] = out.get("total") if isinstance(out.get("total"), int) else len(out.get("items") or [])
            out["items"], out["truncated"] = items, True
    elif kind == "query":
        out["query"], _ = _clip_text(out.get("query"), query_cap)
    elif kind == "report":
        sections = []
        for section in out.get("sections") or []:
            if isinstance(section, dict) and isinstance(section.get("blocks"), list):
                section = {**section, "blocks": [_compact_block(leaf, tier) for leaf in section["blocks"]]}
            sections.append(section)
        out["sections"] = sections
    return out


def _compact_step(step: Any, query_cap: int, *, drop_untrusted: bool = False, strip: bool = False) -> Any:
    if not isinstance(step, dict):
        return step
    out = dict(step)
    out["query"], _ = _clip_text(out.get("query"), query_cap)
    if drop_untrusted or strip:
        out.pop("untrusted_params", None)
    if strip:
        for key in _STEP_DETAIL_KEYS:
            out.pop(key, None)
    return {k: v for k, v in out.items() if not _empty(v)}


def _legacy_table_matches(table: Any, block: Any) -> bool:
    """True when ``block`` (a table block) carries the legacy ``table``'s rows."""
    if not isinstance(table, dict) or not isinstance(block, dict) or block.get("type") != "table":
        return False
    labels = [str(c.get("label")) if isinstance(c, dict) else None for c in block.get("columns") or []]
    if [str(c) for c in table.get("columns") or []] != labels:
        return False
    legacy_rows = [r for r in table.get("rows") or [] if isinstance(r, (list, tuple))]
    block_rows = block.get("rows") or []
    if len(block_rows) < len(legacy_rows):
        return False
    return all(
        [table_cell(cell) for cell in row] == list(block_rows[index])
        for index, row in enumerate(legacy_rows)
    )


def _blocks_of(presentation: dict[str, Any]) -> list[Any]:
    blocks = presentation.get("blocks")
    return list(blocks) if isinstance(blocks, list) else []


def _expire_largest(presentation: dict[str, Any]) -> bool:
    """Expire the largest not-yet-expired block; False when none is left."""
    blocks = _blocks_of(presentation)
    candidates = [
        (index, _json_size(block)) for index, block in enumerate(blocks)
        if isinstance(block, dict) and not is_expired_block(block)
    ]
    if not candidates:
        return False
    index, _size = max(candidates, key=lambda item: (item[1], -item[0]))
    blocks[index] = expire_block(blocks[index])
    presentation["blocks"] = blocks
    return True


def compact_presentation(
    presentation: dict[str, Any], *, max_bytes: int = MAX_PRESENTATION_BYTES,
) -> tuple[dict[str, Any], bool]:
    """The storage form of one answer's presentation (SPEC §7.5 Compact storage).

    Returns ``(compact, reduced)``. The standard pass always runs (25 table rows, 100
    series points, 1 kB step queries, the legacy ``table`` dropped when a table block
    holds the same rows). ``max_bytes`` bounds the STORED (string-escaped) size, see
    :func:`stored_presentation_size`. When the result is still over it, it tightens in
    steps — fewer rows/points, then the largest blocks become expired stubs, then
    step details and citation snippets go, then steps and citations themselves — and
    ``reduced`` is True (the caller marks the answer ``truncated``). Never raises."""
    data = {k: copy.deepcopy(v) for k, v in presentation.items() if not _empty(v)}
    reduced = False

    def _apply(tier: tuple[int, int, int, int, int], *, drop_untrusted: bool = False) -> None:
        data["blocks"] = [_compact_block(block, tier) for block in _blocks_of(data)]
        if isinstance(data.get("steps"), list):
            data["steps"] = [_compact_step(step, tier[4], drop_untrusted=drop_untrusted) for step in data["steps"]]
        if not data["blocks"]:
            data.pop("blocks", None)

    # Match the legacy table against the blocks BEFORE they are clipped: it repeats
    # the first rows of the search table block the live answer carried.
    table = data.get("table")
    match = (
        next((b for b in _blocks_of(data) if _legacy_table_matches(table, b)), None)
        if isinstance(table, dict) else None
    )
    _apply(_STANDARD_TIER)
    if isinstance(table, dict):
        if match is not None and isinstance(match.get("id"), str):
            data.pop("table", None)
            data[_TABLE_BLOCK_KEY] = match["id"]
        else:
            rows, clipped = _clip_list(table.get("rows"), STORED_TABLE_ROWS)
            data["table"] = {**table, "rows": rows, "truncated": bool(table.get("truncated") or clipped)}
    if stored_presentation_size(data) <= max_bytes:
        return data, reduced

    reduced = True
    _apply(_TIGHT_TIER, drop_untrusted=True)
    if isinstance(data.get("table"), dict):
        data["table"] = {**data["table"], "rows": (data["table"].get("rows") or [])[:_TIGHT_TIER[0]], "truncated": True}
    for citation in data.get("citations") or []:
        if isinstance(citation, dict):
            citation.pop("snippet", None)
    while stored_presentation_size(data) > max_bytes and _expire_largest(data):
        pass
    if stored_presentation_size(data) > max_bytes:
        data.pop("table", None)
        data.pop(_TABLE_BLOCK_KEY, None)
        if isinstance(data.get("steps"), list):
            data["steps"] = [_compact_step(step, 0, strip=True) for step in data["steps"]]
        data["citations"] = (data.get("citations") or [])[:10]
        data["console_links"] = (data.get("console_links") or [])[:6]
    if stored_presentation_size(data) > max_bytes:
        # Pathological (e.g. a maximal markdown block): keep only the small facts.
        keep = ("usage", "notice", "answer_kind", "stream_mode", "follow_ups", "memory_proposal")
        data = {k: data[k] for k in keep if k in data}
    return {k: v for k, v in data.items() if not _empty(v)}, reduced


def _origin_of(value: Any) -> str:
    return value if isinstance(value, str) and value in USER_ORIGINS else "user"


def encode_user_response(origin: str | None) -> dict[str, Any] | None:
    """A user message's stored ``response``: only a non-default origin (§4.8)."""
    origin = _origin_of(origin)
    return None if origin == "user" else {_ORIGIN_KEY: origin}


def encode_assistant_response(
    response: dict[str, Any] | None, *, compact: bool = True,
) -> tuple[dict[str, Any] | None, bool]:
    """``(stored, truncated)``: the scalar whitelist plus one ``presentation_json``
    string. ``truncated`` says the presentation had to be cut beyond the standard
    storage form. A legacy (already stored) form round-trips unchanged.

    ``compact=False`` (Round 12: the exchange document) keeps the presentation whole:
    no row, point or byte limit applies, so the restored answer equals the live one."""
    if not isinstance(response, dict):
        return None, False
    stored: dict[str, Any] = {}
    presentation: dict[str, Any] = {}
    for key, value in response.items():
        if key in _DERIVED_RESPONSE_KEYS or key in (PRESENTATION_KEY, EXCHANGE_MARKER):
            continue
        if key in STORED_SCALAR_KEYS and _is_scalar(value):
            if key == "query" and compact:
                value, _ = _clip_text(value, _LEGACY_QUERY_CHARS)
            if value is not None:
                stored[key] = value
        elif not _empty(value):
            presentation[key] = value
    existing = _load_presentation(response)
    if existing:
        presentation = {**existing, **presentation}
    reduced = False
    if presentation:
        if compact:
            kept, reduced = compact_presentation(presentation)
        else:
            kept = {k: copy.deepcopy(v) for k, v in presentation.items() if not _empty(v)}
        if kept:
            try:
                stored[PRESENTATION_KEY] = canonical_json(kept)
            except (TypeError, ValueError):
                reduced = True
    truncated = bool(stored.get("truncated") or reduced)
    if truncated:
        stored["truncated"] = True
    return stored, truncated


def _comparable(stored: dict[str, Any] | None, content: str) -> str:
    """A canonical form of a stored response as a client would read it (decoded,
    internal markers and the storage flag aside): two storage forms that compare
    equal restore the same answer."""
    decoded = decode_response(stored, role="assistant", content=content) or {}
    decoded.pop("truncated", None)
    try:
        return canonical_json(decoded)
    except (TypeError, ValueError):
        return ""


def inline_is_complete(full: dict[str, Any] | None, inline: dict[str, Any] | None) -> bool:
    """Whether the compact INLINE stored response restores exactly what the full
    (exchange document) form restores (Round 12)."""
    if full is None and inline is None:
        return True
    return _comparable(full, "") == _comparable(inline, "")


def exchange_backed(message: ChatConversationMessage) -> bool:
    """An assistant message whose full exchange lives in its own document."""
    response = message.response
    return (
        message.role == "assistant" and isinstance(response, dict)
        and response.get(EXCHANGE_MARKER) is True
    )


def needs_hydration(message: ChatConversationMessage) -> bool:
    """An exchange-backed answer whose inline copy is not the whole exchange."""
    return exchange_backed(message) and bool((message.response or {}).get("truncated"))


def _preview(text: str, limit: int = REDUCED_PREVIEW_CHARS) -> str:
    flat = str(text or "")
    if len(flat) <= limit:
        return flat
    return flat[: max(0, limit - 1)].rstrip() + "…"


def _reduced_assistant(message: ChatConversationMessage) -> ChatConversationMessage:
    """The smallest inline copy of an exchange-backed answer: a short preview and the
    small scalars (the full exchange, its query included, is restored from its
    document on read)."""
    response = message.response if isinstance(message.response, dict) else {}
    scalars = {
        k: v for k, v in response.items()
        if k in STORED_SCALAR_KEYS and k != "query" and _is_scalar(v)
    }
    scalars[EXCHANGE_MARKER] = True
    scalars["truncated"] = True
    return message.model_copy(update={"content": _preview(message.content), "response": scalars})


def _is_minimal(message: ChatConversationMessage) -> bool:
    """An inline copy with nothing left to shrink (no presentation, a short text)."""
    response = message.response if isinstance(message.response, dict) else {}
    return PRESENTATION_KEY not in response and len(message.content) <= REDUCED_PREVIEW_CHARS


def _is_reduced(message: ChatConversationMessage) -> bool:
    """A shrunken inline copy whose reads always come from the exchange document."""
    response = message.response if isinstance(message.response, dict) else {}
    return _is_minimal(message) and response.get("truncated") is True


def _load_presentation(stored: Any) -> dict[str, Any] | None:
    """The decoded ``presentation_json`` of a stored response (``None`` when absent
    or unreadable: a corrupt string must never fail a replay)."""
    if not isinstance(stored, dict):
        return None
    raw = stored.get(PRESENTATION_KEY)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _table_from_block(block: Any) -> dict[str, Any] | None:
    if not isinstance(block, dict) or block.get("type") != "table":
        return None
    columns = [str(c.get("label") or c.get("key") or "") for c in block.get("columns") or [] if isinstance(c, dict)]
    rows = [list(r) for r in block.get("rows") or [] if isinstance(r, (list, tuple))]
    return {
        "columns": columns,
        "rows": rows[:_LEGACY_TABLE_PREVIEW],
        "truncated": bool(block.get("truncated")) or len(rows) > _LEGACY_TABLE_PREVIEW,
    }


def decode_response(stored: Any, *, role: str, content: str) -> dict[str, Any] | None:
    """The API form of a stored message ``response`` (lenient).

    Assistant: the scalars, the decoded presentation and ``answer`` re-injected from
    the message content (so ``messages[i].response.answer`` keeps working). A legacy
    pre-revamp dict (no ``presentation_json``) is returned as stored plus ``answer``.
    User: the stored dict (only ``origin``) unchanged. The routes add
    ``message_id`` to the responses they return (the message id is the truth)."""
    if role != "assistant":
        return copy.deepcopy(stored) if isinstance(stored, dict) else None
    if not isinstance(stored, dict):
        return None
    if set(stored) <= {EXCHANGE_MARKER}:
        return None  # an answer stored without a response (only the internal marker)
    out = {k: copy.deepcopy(v) for k, v in stored.items() if k not in (PRESENTATION_KEY, EXCHANGE_MARKER)}
    presentation = _load_presentation(stored)
    if presentation:
        for key, value in presentation.items():
            if key == _TABLE_BLOCK_KEY:
                continue
            out.setdefault(key, value)
        block_id = presentation.get(_TABLE_BLOCK_KEY)
        if out.get("table") is None and isinstance(block_id, str):
            match = next(
                (b for b in parse_persisted_blocks(out.get("blocks"))
                 if isinstance(b, dict) and b.get("id") == block_id),
                None,
            )
            table = _table_from_block(match)
            if table is not None:
                out["table"] = table
    out["answer"] = content
    return out


def downgrade_stored_response(stored: Any) -> Any:
    """SPEC §7.5 Retention: an old answer keeps its text, scalars, usage, notice and
    citations, while every block becomes an "Expired from saved history" stub (id,
    title and what it was) and every step loses its params and query. Idempotent."""
    if not isinstance(stored, dict):
        return stored
    if PRESENTATION_KEY not in stored and any(
        isinstance(v, (dict, list)) for k, v in stored.items() if k not in _DERIVED_RESPONSE_KEYS
    ):
        # A legacy nested dict: migrate it to the storage form first.
        stored, _ = encode_assistant_response(stored)
        stored = stored or {}
    presentation = _load_presentation(stored)
    if not presentation:
        return stored
    changed = dict(presentation)
    changed["blocks"] = [
        block if is_expired_block(block) else expire_block(block)
        for block in _blocks_of(presentation) if isinstance(block, dict)
    ]
    if isinstance(changed.get("steps"), list):
        changed["steps"] = [_compact_step(step, 0, strip=True) for step in changed["steps"]]
    changed.pop("table", None)
    changed.pop(_TABLE_BLOCK_KEY, None)
    changed = {k: v for k, v in changed.items() if not _empty(v)}
    if changed == presentation:
        return stored
    out = dict(stored)
    if changed:
        out[PRESENTATION_KEY] = canonical_json(changed)
    else:
        out.pop(PRESENTATION_KEY, None)
    return out


def _message_size(message: ChatConversationMessage) -> int:
    return _json_size(message.model_dump(mode="json")) + 1


def _trim_messages(
    messages: list[ChatConversationMessage],
) -> tuple[list[ChatConversationMessage], bool]:
    """Fit one transcript's INLINE copies into :data:`MAX_CONVERSATION_BYTES`
    without removing any message (Round 12: answer text is never evicted).

    Over the budget, oldest first and never the newest exchange: an exchange-backed
    answer and its question shrink to short previews (their full text is restored
    from the exchange document on read); a pre-Round-12 answer is downgraded as
    before (blocks expired, step details stripped, text kept). A transcript of
    pre-Round-12 text alone may stay over the budget: its text is the only copy.
    Returns ``(kept, False)`` — the second value (messages removed) is always False."""
    kept = list(messages)
    sizes = [_message_size(m) for m in kept]
    total = sum(sizes) + 1
    if total <= MAX_CONVERSATION_BYTES:
        return kept, False
    protected = 2 if len(kept) >= 2 else len(kept)

    def _replace(index: int, replacement: ChatConversationMessage) -> None:
        nonlocal total
        size = _message_size(replacement)
        total += size - sizes[index]
        sizes[index] = size
        kept[index] = replacement

    for index in range(len(kept) - protected):
        if total <= MAX_CONVERSATION_BYTES:
            break
        message = kept[index]
        if message.role != "assistant" or not message.response:
            continue
        if exchange_backed(message):
            if not _is_minimal(message):
                _replace(index, _reduced_assistant(message))
            prior = kept[index - 1] if index > 0 else None
            if prior is not None and prior.role == "user" and len(prior.content) > REDUCED_PREVIEW_CHARS:
                _replace(index - 1, prior.model_copy(update={"content": _preview(prior.content)}))
            continue
        downgraded = downgrade_stored_response(message.response)
        if downgraded != message.response:
            _replace(index, message.model_copy(update={"response": downgraded}))
    return kept, False


def _decoded_message(message: ChatConversationMessage) -> ChatConversationMessage:
    return message.model_copy(update={
        "response": decode_response(message.response, role=message.role, content=message.content),
    })


def _decoded(conversation: ChatConversation | None) -> ChatConversation | None:
    if conversation is None:
        return None
    return conversation.model_copy(update={
        "messages": [_decoded_message(m) for m in conversation.messages],
    })


def turns_removed(conversation: ChatConversation | ChatConversationSummary) -> bool:
    """Whether retention REMOVED messages from this thread (SPEC §7.5).

    ``history_truncated`` keeps its pre-revamp meaning — something in the thread was
    shortened: clipped prompt/answer text, an answer tightened to fit the storage
    cap, or removed turns — so it cannot tell a one-exchange thread with one large
    answer from a thread that lost turns. Removal is exactly ``total_message_count >
    message_count`` (the lifetime count only ever grows), and both fields are on the
    summary and the conversation, so a client derives the same answer: with
    ``message_count`` below 100 the turns went "to stay within the storage limit",
    at 100 the 100-message window removed them."""
    total = int(conversation.total_message_count or 0)
    return total > int(conversation.message_count or 0)


def _summary(conversation: ChatConversationSummary) -> ChatConversationSummary:
    if type(conversation) is ChatConversationSummary:
        return conversation
    return ChatConversationSummary(**conversation.model_dump(
        exclude={"messages", "summary_covers_through", "earlier_message_count", "match"},
    ))


def _listing_order(rows: Iterable[_C]) -> list[_C]:
    """Pinned conversations first, then newest first (both by ``updated_at``)."""
    ordered = sorted(rows, key=lambda item: (item.updated_at, item.id), reverse=True)
    return [c for c in ordered if c.pinned] + [c for c in ordered if not c.pinned]


# --------------------------------------------------------------------------- #
# Live state: leases (the turn heartbeat) and row flags (unread, failed, needs input).
# --------------------------------------------------------------------------- #
def _empty_live() -> dict[str, Any]:
    return {"leases": {}, "flags": {}}


def _decode_live(doc: Any, partition_key: str) -> dict[str, Any]:
    """The owner's live state (lenient: an absent, foreign or corrupt document is
    empty, never fatal)."""
    payload = _load_row((doc or {}).get(LIVE_STATE_FIELD)) if isinstance(doc, dict) else None
    if not isinstance(payload, dict) or payload.get("owner") != partition_key:
        return _empty_live()
    leases = payload.get("leases") if isinstance(payload.get("leases"), dict) else {}
    flags = payload.get("flags") if isinstance(payload.get("flags"), dict) else {}
    return {
        "leases": {str(k): dict(v) for k, v in leases.items() if isinstance(v, dict)},
        "flags": {str(k): dict(v) for k, v in flags.items() if isinstance(v, dict)},
    }


def _encode_live(live: dict[str, Any], partition_key: str) -> dict[str, Any]:
    """Storage form of the live state; expired leases and the oldest flags beyond
    :data:`MAX_LIVE_FLAGS` are dropped, so the document stays small."""
    leases = {
        key: entry for key, entry in (live.get("leases") or {}).items()
        if isinstance(entry, dict) and not _is_stale(entry.get("at"), MAX_IDEMPOTENCY_LEASE_SECONDS)
    }
    flags = dict(live.get("flags") or {})
    if len(flags) > MAX_LIVE_FLAGS:
        newest = sorted(flags.items(), key=lambda item: str(item[1].get("at") or ""), reverse=True)
        flags = dict(newest[:MAX_LIVE_FLAGS])
    return {"schema": AUX_SCHEMA, LIVE_STATE_FIELD: canonical_json({
        "owner": partition_key, "leases": leases, "flags": flags,
    })}


def _lease_entry(live: dict[str, Any] | None, key: str, record: dict[str, Any]) -> dict[str, Any] | None:
    """The heartbeat entry of reservation ``key`` when it belongs to the record's
    current lease token."""
    entry = ((live or {}).get("leases") or {}).get(key)
    token = record.get("lease_token")
    if isinstance(entry, dict) and isinstance(token, str) and token and entry.get("token") == token:
        return entry
    return None


def _lease_held(key: str, record: Any, live: dict[str, Any] | None) -> bool:
    """Whether reservation ``key`` still owns its idempotency key: in progress and
    renewed (the record itself, or the heartbeat in the live state) within its
    lease. An ENDED reservation (a billed turn whose save failed) still holds it
    until the lease runs out, so a same-key retry never bills the same answer twice."""
    if not isinstance(record, dict) or record.get("status") != "in_progress":
        return False
    if not _request_stale(record):
        return True
    entry = _lease_entry(live, key, record)
    return entry is not None and not _is_stale(entry.get("at"), entry.get("ttl") or record.get("lease_seconds"))


def _turn_running(key: str, record: Any, live: dict[str, Any] | None) -> bool:
    """Whether reservation ``key`` belongs to a turn that is still running (held and
    not ended): the ``running`` status, the temporary row and the eviction guard."""
    return _lease_held(key, record, live) and not record.get("ended")


def _live_requests(data: dict[str, Any], live: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Reservations whose turn is still running."""
    return [
        record for key, record in (data.get("requests") or {}).items()
        if _turn_running(str(key), record, live)
    ]


def _running_conversations(
    data: dict[str, Any], live: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """``{conversation_id: newest running reservation}`` (Round 12 ``running`` status)."""
    out: dict[str, dict[str, Any]] = {}
    for record in _live_requests(data, live):
        cid = record.get("conversation_id")
        if isinstance(cid, str) and cid:
            current = out.get(cid)
            if current is None or str(record.get("created_at") or "") > str(current.get("created_at") or ""):
                out[cid] = record
    return out


def _effective_flags(
    conversation_id: str, row_status: str, row_unread: bool,
    running: dict[str, Any], live: dict[str, Any] | None,
) -> tuple[str, bool]:
    """``(status, unread)`` as the owner sees them: ``running`` while a turn runs,
    else the live-state flags (a legacy row's own fields when it has none)."""
    status, unread = row_status, row_unread
    flag = ((live or {}).get("flags") or {}).get(conversation_id)
    if isinstance(flag, dict):
        if flag.get("status") in _ROW_STATUSES and flag.get("status") != "running":
            status = flag["status"]
        if isinstance(flag.get("unread"), bool):
            unread = flag["unread"]
    if status == "running":
        status = "idle"  # a stored "running" never outlives its turn
    if conversation_id in running:
        status = "running"
    return status, unread


def _with_live_status(
    conversation: _C, running: dict[str, Any], live: dict[str, Any] | None = None,
) -> _C:
    status, unread = _effective_flags(
        conversation.id, conversation.status, conversation.unread, running, live,
    )
    if status != conversation.status or unread != conversation.unread:
        return conversation.model_copy(update={"status": status, "unread": unread})
    return conversation


def _pending_rows(known: Iterable[str], running: dict[str, dict[str, Any]]) -> list[ChatConversation]:
    """Temporary rows for brand-new threads whose first answer is still being written:
    the reservation names the conversation id and the question's title (Round 12).
    ``known``: the ids of the stored conversations (never shadowed)."""
    stored = set(known)
    rows: list[ChatConversation] = []
    for cid, record in running.items():
        if cid in stored:
            continue
        title = record.get("title")
        if not isinstance(title, str) or not title:
            continue
        stamp = str(record.get("created_at") or iso_now())
        try:
            rows.append(ChatConversation(
                id=cid, title=title, preview="", created_at=stamp, updated_at=stamp,
                message_count=0, total_message_count=0, status="running", unread=False,
            ))
        except Exception:  # noqa: BLE001 -- a corrupt reservation never hides the listing
            continue
    return rows


def _empty_partition() -> dict[str, Any]:
    """The DECODED form of an empty partition (store it with :func:`_encode_partition`)."""
    return {
        "schema": _SCHEMA_VERSION,
        "conversations": {},
        "archives": {},
        "requests": {},
        "history_truncated": False,
        "total_conversation_count": 0,
    }


def _load_row(value: Any) -> dict[str, Any] | None:
    """One stored row: an opaque JSON string (form 3) or, leniently, an object."""
    if isinstance(value, dict):
        return copy.deepcopy(value)
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def stored_conversation_rows(doc: Any) -> dict[str, dict[str, Any]]:
    """A partition document's raw conversation rows by id, in either storage form
    (form 3 opaque rows win when present; an unreadable row is skipped)."""
    if not isinstance(doc, dict):
        return {}
    rows = doc.get(CONVERSATION_ROWS_KEY)
    if isinstance(rows, list):
        out: dict[str, dict[str, Any]] = {}
        for item in rows:
            raw = _load_row(item)
            cid = raw.get("id") if raw is not None else None
            if isinstance(cid, str) and cid and cid not in out:
                out[cid] = raw
        return out
    legacy = doc.get(_LEGACY_CONVERSATIONS_KEY)
    return {str(k): v for k, v in legacy.items()} if isinstance(legacy, dict) else {}


def stored_request_rows(doc: Any) -> dict[str, dict[str, Any]]:
    """A partition document's idempotency records by key, in either storage form."""
    if not isinstance(doc, dict):
        return {}
    rows = doc.get(REQUEST_ROWS_KEY)
    if isinstance(rows, list):
        out: dict[str, dict[str, Any]] = {}
        for item in rows:
            raw = _load_row(item)
            key = raw.get("key") if raw is not None else None
            record = raw.get("record") if raw is not None else None
            if isinstance(key, str) and key and isinstance(record, dict) and key not in out:
                out[key] = record
        return out
    legacy = doc.get(_LEGACY_REQUESTS_KEY)
    return {
        str(k): copy.deepcopy(v) for k, v in legacy.items() if isinstance(v, dict)
    } if isinstance(legacy, dict) else {}


def is_opaque_form(doc: Any) -> bool:
    """Whether a stored partition document is in storage form 3 (opaque rows)."""
    return isinstance(doc, dict) and (
        isinstance(doc.get(CONVERSATION_ROWS_KEY), list) or isinstance(doc.get(REQUEST_ROWS_KEY), list)
    )


def with_stored_rows(
    doc: Any,
    *,
    conversations: dict[str, dict[str, Any]] | None = None,
    requests: dict[str, dict[str, Any]] | None = None,
    opaque: bool | None = None,
) -> dict[str, Any]:
    """A copy of a partition document with its raw rows replaced (``None`` keeps the
    document's own), in storage form 3 when ``opaque`` and form 2 otherwise (``None``
    keeps the document's own form; a document in neither form gets form 3). For
    repair tools and tests that patch a row; rows are written exactly as the store
    writes them."""
    base = copy.deepcopy(doc) if isinstance(doc, dict) else {}
    conv = stored_conversation_rows(base) if conversations is None else conversations
    reqs = stored_request_rows(base) if requests is None else requests
    if opaque is None:
        opaque = is_opaque_form(base) or not (
            isinstance(base.get(_LEGACY_CONVERSATIONS_KEY), dict)
            or isinstance(base.get(_LEGACY_REQUESTS_KEY), dict)
        )
    for key in (_LEGACY_CONVERSATIONS_KEY, _LEGACY_REQUESTS_KEY, CONVERSATION_ROWS_KEY, REQUEST_ROWS_KEY):
        base.pop(key, None)
    conv = {cid: {**row, "id": cid} for cid, row in conv.items() if isinstance(row, dict)}
    reqs = {key: record for key, record in reqs.items() if isinstance(record, dict)}
    if not opaque:
        base["schema"] = KEYED_STORAGE_FORM
        base[_LEGACY_CONVERSATIONS_KEY] = copy.deepcopy(conv)
        base[_LEGACY_REQUESTS_KEY] = copy.deepcopy(reqs)
        return base
    base["schema"] = OPAQUE_STORAGE_FORM
    base[CONVERSATION_ROWS_KEY] = [canonical_json(row) for row in conv.values()]
    base[REQUEST_ROWS_KEY] = [
        canonical_json({"key": key, "record": record}) for key, record in reqs.items()
    ]
    return base


def _rev(doc: dict[str, Any] | None) -> int:
    try:
        return max(0, int((doc or {}).get("_rev", 0)))
    except (TypeError, ValueError):
        return 0


def _parse_time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _is_stale(value: Any, ttl_seconds: Any = None) -> bool:
    timestamp = _parse_time(value)
    if timestamp is None:
        return True
    return (datetime.now(timezone.utc) - timestamp).total_seconds() >= _lease_ttl(ttl_seconds)


# The longest lease a reservation may ask for (a turn's configured worst case is far
# below it; the bound only keeps a corrupt record from pinning a key for ever).
MAX_IDEMPOTENCY_LEASE_SECONDS = 2 * 60 * 60


def _lease_ttl(value: Any) -> float:
    """A reservation's lease length: its stored ``lease_seconds`` (never shorter than
    the default, never longer than the bound), else the default."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return float(IDEMPOTENCY_PENDING_TTL_SECONDS)
    if seconds != seconds:  # NaN
        return float(IDEMPOTENCY_PENDING_TTL_SECONDS)
    return min(max(seconds, float(IDEMPOTENCY_PENDING_TTL_SECONDS)), float(MAX_IDEMPOTENCY_LEASE_SECONDS))


def _request_stale(request: dict[str, Any]) -> bool:
    """Whether an ``in_progress`` reservation's lease has expired."""
    return _is_stale(request.get("updated_at"), request.get("lease_seconds"))


def _archive_info(raw: Any) -> dict[str, Any]:
    """A stored row's archive record ``{count, oldest_at}`` (count 0 when none)."""
    info = raw.get(ARCHIVE_ROW_KEY) if isinstance(raw, dict) else None
    count = info.get("count") if isinstance(info, dict) else None
    if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
        return {"count": 0, "oldest_at": None}
    oldest = info.get("oldest_at")
    return {"count": int(count), "oldest_at": oldest if isinstance(oldest, str) and oldest else None}


def _normalize_conversation(
    raw: Any, cid: str, archive: dict[str, Any] | None = None,
) -> ChatConversation | None:
    try:
        conversation = ChatConversation.model_validate(raw)
    except Exception:  # noqa: BLE001 -- one corrupt row must not hide valid siblings
        return None
    info = archive if archive is not None else _archive_info(raw)
    messages = list(conversation.messages)
    # Archived messages are retained (in the conversation's archive pages): they count.
    retained = len(messages) + int(info.get("count") or 0)
    total = max(int(conversation.total_message_count or 0), retained)
    oldest = info.get("oldest_at") or (messages[0].created_at if messages else None)
    return conversation.model_copy(update={
        "id": str(cid),
        "message_count": retained,
        "total_message_count": total,
        "history_truncated": bool(conversation.history_truncated or total > retained),
        "oldest_retained_at": oldest,
        "earlier_message_count": 0,
    })


def _normalize_summary(raw: Any, cid: str) -> ChatConversationSummary | None:
    """A row's summary fields WITHOUT validating its messages (the listing reads every
    row of the partition; only the message count is needed from the transcript)."""
    if not isinstance(raw, dict):
        return None
    messages = raw.get("messages") if isinstance(raw.get("messages"), list) else []
    info = _archive_info(raw)
    fields = {k: v for k, v in raw.items() if k not in ("messages", ARCHIVE_ROW_KEY)}
    try:
        summary = ChatConversationSummary.model_validate(fields)
    except Exception:  # noqa: BLE001 -- one corrupt row must not hide valid siblings
        return None
    retained = len(messages) + int(info["count"])
    total = max(int(summary.total_message_count or 0), retained)
    first = messages[0].get("created_at") if messages and isinstance(messages[0], dict) else None
    oldest = info["oldest_at"] or (first if isinstance(first, str) else None)
    return summary.model_copy(update={
        "id": str(cid),
        "message_count": retained,
        "total_message_count": total,
        "history_truncated": bool(summary.history_truncated or total > retained),
        "oldest_retained_at": oldest,
    })


def _decode_partition(doc: dict[str, Any] | None) -> dict[str, Any]:
    """Lenient: either storage form; a corrupt row is skipped, never fatal."""
    decoded = _empty_partition()
    if not isinstance(doc, dict):
        return decoded
    rows: dict[str, ChatConversation] = {}
    archives: dict[str, dict[str, Any]] = {}
    for cid, raw in stored_conversation_rows(doc).items():
        info = _archive_info(raw)
        conversation = _normalize_conversation(raw, str(cid), info)
        if conversation is not None:
            rows[str(cid)] = conversation
            if info["count"]:
                archives[str(cid)] = info
    requests = stored_request_rows(doc)
    retained = len(rows)
    decoded.update({
        "conversations": rows,
        "archives": archives,
        "requests": requests,
        "history_truncated": bool(doc.get("history_truncated", False)),
        "total_conversation_count": max(
            retained, int(doc.get("total_conversation_count", retained) or retained),
        ),
    })
    return decoded


def _encode_partition(data: dict[str, Any], *, opaque: bool = True) -> dict[str, Any]:
    """Storage form 3 when ``opaque`` (every conversation and request record is ONE
    opaque string, so the document's mapped field paths never depend on what it
    holds), else form 2, exactly as released builds write it (see the module
    docstring for which backend gets which)."""
    requests = {
        key: record for key, record in (data.get("requests") or {}).items()
        if isinstance(record, dict)
    }
    scalars = {
        "history_truncated": bool(data.get("history_truncated", False)),
        "total_conversation_count": max(
            len(data["conversations"]),
            int(data.get("total_conversation_count", 0) or 0),
        ),
    }
    archives = data.get("archives") or {}

    def _row(cid: str, conversation: ChatConversation) -> dict[str, Any]:
        row = conversation.model_dump(mode="json")
        for name in _UNSTORED_ROW_FIELDS:
            row.pop(name, None)
        info = archives.get(cid)
        if isinstance(info, dict) and int(info.get("count") or 0) > 0:
            row[ARCHIVE_ROW_KEY] = {"count": int(info["count"]), "oldest_at": info.get("oldest_at")}
            # The row's own count is its inline messages (the previous build recounts).
            row["message_count"] = len(conversation.messages)
        return row

    if not opaque:
        return {
            "schema": KEYED_STORAGE_FORM,
            _LEGACY_CONVERSATIONS_KEY: {
                cid: _row(cid, conversation)
                for cid, conversation in data["conversations"].items()
            },
            _LEGACY_REQUESTS_KEY: copy.deepcopy(requests),
            **scalars,
        }
    return {
        "schema": OPAQUE_STORAGE_FORM,
        CONVERSATION_ROWS_KEY: [
            canonical_json(_row(cid, conversation))
            for cid, conversation in data["conversations"].items()
        ],
        REQUEST_ROWS_KEY: [
            canonical_json({"key": key, "record": record})
            for key, record in requests.items()
        ],
        **scalars,
    }


def _usage_totals(response: Any) -> tuple[int, float] | None:
    """``(total_tokens, cost)`` of a response's ``usage``; None without usage."""
    usage = response.get("usage") if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return None
    tokens = usage.get("total_tokens")
    cost = usage.get("cost")
    if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0:
        return None
    if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost < 0:
        cost = 0.0
    return tokens, float(cost)


def _time_range_or_none(value: Any) -> TimeRange | None:
    if value is None or isinstance(value, TimeRange):
        return value
    try:
        return TimeRange.model_validate(value)
    except Exception:  # noqa: BLE001 -- presentation state, never fatal
        return None


def _receipt_response(stored: dict[str, Any] | None, content_clipped: bool) -> dict[str, Any] | None:
    """A receipt's compact response: the scalar whitelist only (SPEC §7.5), plus the
    exchange marker (Round 12) so a replay after the message left the row (archived
    or evicted) is still restored from its exchange document when that exists."""
    if not isinstance(stored, dict):
        return None
    backed = stored.get(EXCHANGE_MARKER) is True
    scalars = {
        k: v for k, v in stored.items()
        # The exchange document restores the query; only a legacy receipt keeps it.
        if k in STORED_SCALAR_KEYS and not (backed and k == "query") and _is_scalar(v)
    }
    if content_clipped or PRESENTATION_KEY in stored:
        # Replayed from the receipt alone, the answer lacks its presentation.
        scalars["truncated"] = True
    if backed:
        scalars[EXCHANGE_MARKER] = True
        scalars["truncated"] = True
    return scalars


def _fold(text: Any) -> str:
    """Whitespace folded to single spaces, lower-cased: the ONE form a search needle
    and every searched text are compared in, so a phrase that crosses a line break
    or a double space (common in Markdown answers) still matches."""
    return " ".join(str(text or "").split()).lower()


def _snippet(text: str, needle: str) -> str:
    """At most 160 characters of ``text`` (whitespace folded) around ``needle``."""
    flat = " ".join(str(text or "").split())
    if len(flat) <= MAX_SNIPPET_CHARS:
        return flat
    at = max(0, flat.lower().find(needle))
    room = MAX_SNIPPET_CHARS - 2            # two ellipses at most
    begin = max(0, min(at - (room - len(needle)) // 2, len(flat) - room))
    end = min(len(flat), begin + room)
    return ("\u2026" if begin > 0 else "") + flat[begin:end] + ("\u2026" if end < len(flat) else "")


def _block_titles(stored: Any) -> list[str]:
    """Every block title of a stored assistant response (report leaves included)."""
    presentation = _load_presentation(stored)
    blocks = presentation.get("blocks") if presentation else (
        stored.get("blocks") if isinstance(stored, dict) else None
    )
    titles: list[str] = []
    for block in blocks if isinstance(blocks, list) else []:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("title"), str):
            titles.append(block["title"])
        for section in block.get("sections") or [] if block.get("type") == "report" else []:
            if not isinstance(section, dict):
                continue
            if isinstance(section.get("heading"), str):
                titles.append(section["heading"])
            for leaf in section.get("blocks") or []:
                if isinstance(leaf, dict) and isinstance(leaf.get("title"), str):
                    titles.append(leaf["title"])
    return titles


def _match(conversation: ChatConversation, needle: str) -> ChatConversationMatch | None:
    """Where ``needle`` (lower-case) occurs: the title, the newest message whose text
    holds it, else the newest answer whose block titles do."""
    title = conversation.title or ""
    if needle in _fold(title):
        return ChatConversationMatch(message_id=None, snippet=_snippet(title, needle))
    for message in reversed(conversation.messages):
        if needle in _fold(message.content):
            return ChatConversationMatch(
                message_id=message.id, snippet=_snippet(message.content, needle),
            )
    # Parsing every stored presentation is the expensive part of a search, so skip
    # one whose raw JSON cannot contain the needle: every needle WORD must appear in
    # it (whitespace between words may differ). Exact for words without a quote,
    # backslash or control character, which JSON would escape.
    words = needle.split()
    prefilter = all(ch >= " " and ch not in '"\\' for ch in needle)
    for message in reversed(conversation.messages):
        if message.role != "assistant":
            continue
        raw = (message.response or {}).get(PRESENTATION_KEY) if isinstance(message.response, dict) else None
        if prefilter and isinstance(raw, str):
            lowered = raw.lower()
            if not all(word in lowered for word in words):
                continue
        for block_title in _block_titles(message.response):
            if needle in _fold(block_title):
                return ChatConversationMatch(
                    message_id=message.id, snippet=_snippet(block_title, needle),
                )
    return None


# A live-state change that found nothing to write.
_UNCHANGED = object()


def _find_row(doc: Any, conversation_id: str) -> dict[str, Any] | None:
    """One stored row of a RAW partition document by id, parsing only that row (a
    form 3 row is a JSON string: rows that cannot contain the id are skipped)."""
    if not isinstance(doc, dict):
        return None
    rows = doc.get(CONVERSATION_ROWS_KEY)
    if isinstance(rows, list):
        marker = canonical_json(conversation_id)
        for item in rows:
            if isinstance(item, str) and marker not in item:
                continue
            raw = _load_row(item)
            if raw is not None and raw.get("id") == conversation_id:
                return raw
        return None
    legacy = doc.get(_LEGACY_CONVERSATIONS_KEY)
    raw = legacy.get(conversation_id) if isinstance(legacy, dict) else None
    return copy.deepcopy(raw) if isinstance(raw, dict) else None


def _decode_row(doc: Any, conversation_id: str) -> tuple[ChatConversation | None, dict[str, Any]]:
    """``(conversation, archive info)`` of one row of a raw partition document."""
    raw = _find_row(doc, conversation_id)
    if raw is None:
        return None, {"count": 0, "oldest_at": None}
    info = _archive_info(raw)
    return _normalize_conversation(raw, conversation_id, info), info


def _archived_form(messages: list[ChatConversationMessage]) -> list[ChatConversationMessage]:
    """How messages are kept in an archive page: an exchange-backed answer and its
    question as short previews (their full text is in the exchange document), any
    other message whole (its stored copy is the only one)."""
    out = list(messages)
    for index, message in enumerate(out):
        if not exchange_backed(message):
            continue
        if not _is_minimal(message):
            out[index] = _reduced_assistant(message)
        prior = out[index - 1] if index > 0 else None
        if prior is not None and prior.role == "user" and len(prior.content) > REDUCED_PREVIEW_CHARS:
            out[index - 1] = prior.model_copy(update={"content": _preview(prior.content)})
    return out


class ChatConversationStore:
    """Strict CRUD and retry-safe sends over per-principal KV partitions.

    ``opaque_rows`` overrides the per-backend storage form (see the module docstring);
    tests use it, production lets the backend decide."""

    def __init__(self, kv: KVStore, *, opaque_rows: bool | None = None) -> None:
        self._kv = kv
        self._locks: dict[str, asyncio.Lock] = {}
        self._index_lock = asyncio.Lock()
        # Background cleanup of conversations a turn's write evicted (tracked, so a
        # task is never garbage-collected mid-run; ``wait_for_cleanup`` awaits them).
        self._cleanup: set[asyncio.Future] = set()
        self._concurrent_writes = _supports_concurrent_writes(kv)
        self._opaque_rows = opaque_rows_for(kv) if opaque_rows is None else bool(opaque_rows)
        self._storage_form = OPAQUE_STORAGE_FORM if self._opaque_rows else KEYED_STORAGE_FORM

    def _encode(self, data: dict[str, Any]) -> dict[str, Any]:
        """A decoded partition in this backend's storage form."""
        return _encode_partition(data, opaque=self._opaque_rows)

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def _strict_get(self, key: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None)
        try:
            value = (
                await getter(CHAT_CONVERSATIONS_NS, key)
                if callable(getter)
                else await self._kv.get(CHAT_CONVERSATIONS_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat history could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise ChatHistoryUnavailable("Chat history returned an invalid document.")
        return copy.deepcopy(value)

    async def _strict_put_if(
        self, key: str, value: dict[str, Any], expected_rev: int
    ) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        try:
            return bool(
                await writer(CHAT_CONVERSATIONS_NS, key, value, expected_rev)
                if callable(writer)
                else await self._kv.put_if(
                    CHAT_CONVERSATIONS_NS, key, value, expected_rev
                )
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat history could not be saved.") from exc

    async def _strict_mutate(
        self,
        key: str,
        change: Callable[[dict[str, Any] | None], tuple[dict[str, Any] | None, _T]],
        *,
        lock: asyncio.Lock | None = None,
    ) -> _T:
        """Compare-and-set ``change(current) -> (proposed, result)``; a ``proposed``
        of ``None`` writes nothing (the change found nothing to do)."""
        async with (lock or self._lock_for(key)):
            for _attempt in range(CAS_RETRIES):
                current = await self._strict_get(key)
                expected = _rev(current)
                proposed, result = change(copy.deepcopy(current))
                if proposed is None:
                    return result
                saved = copy.deepcopy(proposed)
                saved["_rev"] = expected + 1
                if not await self._strict_put_if(key, saved, expected):
                    continue
                confirmed = await self._strict_get(key)
                if _rev(confirmed) < expected + 1:
                    raise ChatHistoryUnavailable(
                        "Chat history storage did not confirm the write."
                    )
                return result
        raise ChatHistoryUnavailable("Chat history changed too quickly; retry the request.")

    async def _register_partition(self, partition_key: str) -> None:
        """Record the partition in the index the factory reset walks. Read first: an
        already registered partition costs no write (every turn calls this)."""
        index = await self._strict_get(CHAT_CONVERSATIONS_KEY) or {}
        if partition_key in {str(item) for item in (index.get("partitions") or [])}:
            return

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, None]:
            doc = copy.deepcopy(current or {})
            partitions = {str(item) for item in (doc.get("partitions") or [])}
            if partition_key in partitions:
                return None, None
            partitions.add(partition_key)
            doc["schema"] = self._storage_form
            doc["partitions"] = sorted(partitions)
            return doc, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _change, lock=self._index_lock
        )

    async def _migrate_legacy(
        self, uid: str, partition_key: str, legacy: dict[str, Any]
    ) -> dict[str, Any] | None:
        raw_rows = (legacy.get("conversations") or {}).get(uid)
        if not isinstance(raw_rows, dict) or not raw_rows:
            return None
        migrated_rows: dict[str, ChatConversation] = {}
        for cid, raw in raw_rows.items():
            conversation = _normalize_conversation(raw, str(cid))
            if conversation is not None:
                migrated_rows[str(cid)] = conversation
        if not migrated_rows:
            return None

        await self._register_partition(partition_key)

        def _create(current: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
            data = _decode_partition(current)
            if not data["conversations"]:
                data["conversations"] = dict(migrated_rows)
                data["total_conversation_count"] = len(migrated_rows)
            return self._encode(data), data

        migrated = await self._strict_mutate(partition_key, _create)

        # Cleanup is deliberately second phase: a failed partition write leaves the
        # legacy copy intact. A failed cleanup is safe and the next read is idempotent.
        def _cleanup(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            doc = copy.deepcopy(current or {})
            conversations = dict(doc.get("conversations") or {})
            conversations.pop(uid, None)
            doc["conversations"] = conversations
            partitions = {str(item) for item in (doc.get("partitions") or [])}
            partitions.add(partition_key)
            doc["partitions"] = sorted(partitions)
            doc["schema"] = self._storage_form
            return doc, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _cleanup, lock=self._index_lock
        )
        return migrated

    async def _partition_doc(self, user_id: str | None) -> tuple[str, dict[str, Any] | None]:
        """The owner's RAW partition document (a legacy shared copy is migrated first);
        ``None`` when the owner has no history."""
        uid = normalize_user_id(user_id)
        key = partition_key_for_user(uid)
        current = await self._strict_get(key)
        if current is not None:
            return key, current
        legacy = await self._strict_get(CHAT_CONVERSATIONS_KEY)
        migrated = await self._migrate_legacy(uid, key, legacy or {})
        if migrated is None:
            return key, None
        return key, await self._strict_get(key)

    async def _load_partition(self, user_id: str | None) -> tuple[str, dict[str, Any]]:
        key, doc = await self._partition_doc(user_id)
        return key, _decode_partition(doc)

    async def _ensure_partition_key(self, user_id: str | None) -> str:
        """The owner's partition key, registered for the factory reset (no decode)."""
        key, _doc = await self._partition_doc(user_id)
        await self._register_partition(key)
        return key

    async def _ensure_partition(self, user_id: str | None) -> tuple[str, dict[str, Any]]:
        key, data = await self._load_partition(user_id)
        await self._register_partition(key)
        return key, data

    # ------------------------------------------------------------------ #
    # Round 12 auxiliary documents (exchange, summary, observations, live
    # state, archive pages).
    # ------------------------------------------------------------------ #
    async def _put_aux(self, key: str, value: dict[str, Any]) -> None:
        """Overwrite one auxiliary document under its ``_rev`` compare-and-set. It has
        one writer per key in practice, so a retry only meets a concurrent blank; no
        per-key lock is kept (one per exchange would grow without bound)."""
        for _attempt in range(CAS_RETRIES):
            current = await self._strict_get(key)
            expected = _rev(current)
            saved = copy.deepcopy(value)
            saved["_rev"] = expected + 1
            if await self._strict_put_if(key, saved, expected):
                return
        raise ChatHistoryUnavailable("Chat history changed too quickly; retry the request.")

    async def _get_aux(self, key: str, field_name: str) -> Any:
        """The decoded opaque payload of one auxiliary document; ``None`` when absent,
        blanked or unreadable (a corrupt document never fails a read)."""
        doc = await self._strict_get(key)
        raw = (doc or {}).get(field_name)
        if not isinstance(raw, str) or not raw:
            return None
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return None

    async def _blank(self, key: str) -> None:
        """Best effort: overwrite an auxiliary document with an empty one (the KV
        contract has no delete). A failure leaves it for the factory reset."""
        try:
            await self._put_aux(key, {"schema": AUX_SCHEMA})
        except Exception as exc:  # noqa: BLE001 -- the owning write already succeeded
            logger.warning("chat auxiliary document could not be blanked (%s)", type(exc).__name__)

    async def _write_exchange(self, partition_key: str, record: ExchangeRecord) -> None:
        payload = {
            "owner": partition_key,
            "conversation_id": record.conversation_id,
            "user_message_id": record.user_message_id,
            "assistant_message_id": record.assistant_message_id,
            "user_content": record.user_content,
            "assistant_content": record.assistant_content,
            "response": record.response,
            "created_at": record.created_at,
        }
        try:
            encoded = canonical_json(payload)
        except (TypeError, ValueError) as exc:
            raise ChatHistoryUnavailable("The chat answer could not be encoded for storage.") from exc
        await self._put_aux(
            exchange_key(partition_key, record.assistant_message_id),
            {"schema": AUX_SCHEMA, EXCHANGE_FIELD: encoded},
        )

    async def _load_exchange(
        self, partition_key: str, assistant_message_id: str, *, strict: bool = False,
    ) -> ExchangeRecord | None:
        """One exchange document, or ``None`` when it is absent, blanked or not this
        owner's. An unreadable document is ``None`` for readers (the inline copy is
        shown) but raises :class:`ChatHistoryUnavailable` when ``strict``: a writer
        must never mistake "could not read" for "absent" and rewrite the answer
        without its full text."""
        try:
            payload = await self._get_aux(exchange_key(partition_key, assistant_message_id), EXCHANGE_FIELD)
        except ChatHistoryUnavailable as exc:
            if strict:
                raise
            logger.warning("chat exchange document unreadable (%s)", exc)
            return None
        if not isinstance(payload, dict) or payload.get("owner") != partition_key:
            return None
        if payload.get("assistant_message_id") != assistant_message_id:
            return None
        response = payload.get("response")
        return ExchangeRecord(
            conversation_id=str(payload.get("conversation_id") or ""),
            user_message_id=str(payload.get("user_message_id") or ""),
            assistant_message_id=assistant_message_id,
            user_content=str(payload.get("user_content") or ""),
            assistant_content=str(payload.get("assistant_content") or ""),
            response=response if isinstance(response, dict) else None,
            created_at=str(payload.get("created_at") or ""),
        )

    async def _blank_exchange(self, partition_key: str, assistant_message_id: str) -> None:
        await self._blank(exchange_key(partition_key, assistant_message_id))

    # --- live state ------------------------------------------------------- #
    async def _load_live(self, partition_key: str, *, strict: bool = False) -> dict[str, Any]:
        """The owner's live state. Readers degrade to an empty state (statuses fall
        back to the stored defaults); a ``strict`` reader (the idempotency decision)
        fails instead, so an unreadable heartbeat never lets a running turn's key be
        reclaimed."""
        try:
            doc = await self._strict_get(live_state_key(partition_key))
        except ChatHistoryUnavailable:
            if strict:
                raise
            logger.warning("chat live state unreadable; statuses use their stored defaults")
            return _empty_live()
        return _decode_live(doc, partition_key)

    async def _change_live(
        self, partition_key: str, change: Callable[[dict[str, Any]], Any],
    ) -> Any:
        """Apply ``change(live) -> result`` in place under compare-and-set. A change
        that returns ``False`` (nothing to do) or :data:`_UNCHANGED` (``None`` is then
        returned) writes nothing."""
        def _write(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, Any]:
            live = _decode_live(current, partition_key)
            result = change(live)
            if result is _UNCHANGED:
                return None, None
            if result is False:
                return None, False
            return _encode_live(live, partition_key), result

        return await self._strict_mutate(live_state_key(partition_key), _write)

    async def _change_live_soft(
        self, partition_key: str, change: Callable[[dict[str, Any]], Any], what: str,
    ) -> None:
        """Best effort :meth:`_change_live`: a status is a convenience, never a
        reason to fail the write that already succeeded."""
        try:
            await self._change_live(partition_key, change)
        except Exception as exc:  # noqa: BLE001
            logger.warning("chat live state not updated (%s: %s)", what, type(exc).__name__)

    async def _mark_answered(
        self, partition_key: str, conversation_id: str, response: Any, idempotency_key: str | None,
    ) -> None:
        """A saved answer: unread until its owner opens it; ``needs_input`` after a
        clarifying question (D10, D13); its turn's lease entry is dropped."""
        clarify = response.get("clarify") if isinstance(response, dict) else None
        status = "needs_input" if isinstance(clarify, dict) and clarify else "idle"
        now = iso_now()

        def _change(live: dict[str, Any]) -> None:
            if idempotency_key:
                live["leases"].pop(idempotency_key, None)
            live["flags"][conversation_id] = {"unread": True, "status": status, "at": now}

        await self._change_live_soft(partition_key, _change, "answered")

    async def _end_lease(
        self, partition_key: str, idempotency_key: str, lease_token: str,
        *, failed_conversation: str | None = None,
    ) -> None:
        """Drop a finished turn's lease entry; ``failed_conversation`` reads ``failed``
        until its next answer."""
        now = iso_now()

        def _change(live: dict[str, Any]) -> None:
            entry = live["leases"].get(idempotency_key)
            if isinstance(entry, dict) and entry.get("token") in (None, lease_token):
                live["leases"].pop(idempotency_key, None)
            if failed_conversation:
                flag = dict(live["flags"].get(failed_conversation) or {})
                flag.update({"status": "failed", "at": now})
                live["flags"][failed_conversation] = flag

        await self._change_live_soft(partition_key, _change, "lease end")

    # --- archive pages ---------------------------------------------------- #
    async def _load_archive_page(
        self, partition_key: str, conversation_id: str, page: int,
    ) -> list[ChatConversationMessage] | None:
        """One archive page's stored messages, or ``None`` when absent, blanked or not
        this conversation's. Raises :class:`ChatHistoryUnavailable` when unreadable."""
        payload = await self._get_aux(archive_page_key(partition_key, conversation_id, page), ARCHIVE_FIELD)
        if not isinstance(payload, dict) or payload.get("owner") != partition_key:
            return None
        if payload.get("conversation_id") != conversation_id:
            return None
        out: list[ChatConversationMessage] = []
        for index, raw in enumerate(payload.get("messages") or []):
            try:
                out.append(ChatConversationMessage.model_validate(raw))
            except Exception:  # noqa: BLE001 -- one corrupt entry keeps its place
                out.append(ChatConversationMessage(
                    id=f"chatmsg-unreadable-{int(page)}-{index}", role="assistant",
                    content="", response={"truncated": True},
                ))
        return out

    async def _archive_slice(
        self, partition_key: str, conversation_id: str, count: int, start: int, stop: int,
        *, strict: bool = True,
    ) -> list[ChatConversationMessage]:
        """Archived messages ``[start, stop)`` (global order, oldest first), pages read
        concurrently. A missing page leaves a gap; an unreadable one raises unless
        not ``strict`` (search and blanking), when it leaves a gap too."""
        start, stop = max(0, int(start)), min(int(count), int(stop))
        if start >= stop:
            return []
        first, last = start // ARCHIVE_PAGE_MESSAGES, (stop - 1) // ARCHIVE_PAGE_MESSAGES
        gate = asyncio.Semaphore(HYDRATE_CONCURRENCY)

        async def _page(number: int) -> list[ChatConversationMessage] | None:
            async with gate:
                try:
                    return await self._load_archive_page(partition_key, conversation_id, number)
                except ChatHistoryUnavailable:
                    if strict:
                        raise
                    logger.warning("chat archive page unreadable")
                    return None

        pages = await asyncio.gather(*(_page(n) for n in range(first, last + 1)))
        out: list[ChatConversationMessage] = []
        for number, messages in zip(range(first, last + 1), pages):
            if not messages:
                continue
            base = number * ARCHIVE_PAGE_MESSAGES
            out.extend(messages[max(start, base) - base: min(stop, base + ARCHIVE_PAGE_MESSAGES) - base])
        return out

    async def _find_archived(
        self, partition_key: str, conversation_id: str, count: int, message_id: str,
    ) -> int | None:
        """The global index of an archived message (pages searched newest first)."""
        if count <= 0:
            return None
        for number in range((count - 1) // ARCHIVE_PAGE_MESSAGES, -1, -1):
            messages = await self._load_archive_page(partition_key, conversation_id, number)
            if not messages:
                continue
            base = number * ARCHIVE_PAGE_MESSAGES
            limit = min(ARCHIVE_PAGE_MESSAGES, count - base)
            for index, message in enumerate(messages[:limit]):
                if message.id == message_id:
                    return base + index
        return None

    async def _slice(
        self, partition_key: str, conversation: ChatConversation, info: dict[str, Any],
        start: int, stop: int, *, strict: bool = True,
    ) -> list[ChatConversationMessage]:
        """Messages ``[start, stop)`` of the whole transcript (archive, then row)."""
        count = int(info.get("count") or 0)
        out: list[ChatConversationMessage] = []
        if start < count:
            out.extend(await self._archive_slice(
                partition_key, conversation.id, count, start, min(stop, count), strict=strict,
            ))
        out.extend(conversation.messages[max(0, start - count): max(0, stop - count)])
        return out

    async def _write_archive(
        self, partition_key: str, conversation_id: str, count: int,
        messages: list[ChatConversationMessage],
    ) -> None:
        """Append ``messages`` after the first ``count`` archived ones (whole pages are
        rewritten: the page holding ``count`` keeps its first entries, anything an
        interrupted earlier write left past them is replaced)."""
        page = count // ARCHIVE_PAGE_MESSAGES
        offset = count - page * ARCHIVE_PAGE_MESSAGES
        items: list[ChatConversationMessage] = []
        if offset:
            existing = await self._load_archive_page(partition_key, conversation_id, page)
            if existing is None or len(existing) < offset:
                raise ChatHistoryUnavailable("An archive page of this conversation is missing.")
            items = list(existing[:offset])
        items.extend(messages)
        while items:
            chunk, items = items[:ARCHIVE_PAGE_MESSAGES], items[ARCHIVE_PAGE_MESSAGES:]
            await self._put_aux(archive_page_key(partition_key, conversation_id, page), {
                "schema": AUX_SCHEMA,
                ARCHIVE_FIELD: canonical_json({
                    "owner": partition_key, "conversation_id": conversation_id, "page": page,
                    "messages": [message.model_dump(mode="json") for message in chunk],
                }),
            })
            page += 1

    async def _maybe_archive(self, partition_key: str, conversation_id: str) -> None:
        """Keep one conversation row under its inline ceiling (Round 12): past
        :data:`ARCHIVE_TRIGGER_MESSAGES` messages, the oldest move to the archive pages
        (an exchange-backed answer and its question as short previews — their full
        text stays in the exchange document; an older answer whole, as its only
        copy) until :data:`INLINE_KEEP_MESSAGES` remain, never splitting a question
        from its answer. The pages are written first, then the row under its
        compare-and-set (only if nothing archived it meanwhile). Best effort: a
        failure leaves the row a little longer and the next answer retries."""
        try:
            async with self._lock_for(f"archive:{partition_key}"):
                doc = await self._strict_get(partition_key)
                conversation, info = _decode_row(doc, conversation_id)
                if conversation is None or len(conversation.messages) <= ARCHIVE_TRIGGER_MESSAGES:
                    return
                messages = list(conversation.messages)
                cut = len(messages) - INLINE_KEEP_MESSAGES
                while cut > 0 and messages[cut - 1].role != "assistant":
                    cut -= 1
                if cut <= 0:
                    return
                count = int(info["count"])
                ids = [message.id for message in messages[:cut]]
                oldest = info["oldest_at"] or messages[0].created_at
                await self._write_archive(partition_key, conversation_id, count, _archived_form(messages[:cut]))

                def _apply(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
                    data = _decode_partition(current)
                    row = data["conversations"].get(conversation_id)
                    now_count = int((data["archives"].get(conversation_id) or {}).get("count") or 0)
                    if row is None or now_count != count or [m.id for m in row.messages[:cut]] != ids:
                        return None, False
                    data["archives"][conversation_id] = {"count": count + cut, "oldest_at": oldest}
                    data["conversations"][conversation_id] = row.model_copy(
                        update={"messages": list(row.messages[cut:])},
                    )
                    return self._encode(data), True

                await self._strict_mutate(partition_key, _apply)
        except Exception as exc:  # noqa: BLE001 -- the answer is already saved
            logger.warning("chat conversation not archived (%s)", type(exc).__name__)

    async def _blank_archive(
        self, partition_key: str, conversation_id: str, info: dict[str, Any],
        gate: asyncio.Semaphore | None = None,
    ) -> None:
        """Blank a removed conversation's archive pages and the exchange documents only
        they reference (best effort), pages concurrently behind ``gate``. The page past
        the count is probed too: an interrupted archive write may have left one."""
        gate = gate or self._cleanup_gate()
        count = int((info or {}).get("count") or 0)

        async def _page(number: int) -> None:
            async with gate:
                try:
                    messages = await self._load_archive_page(partition_key, conversation_id, number)
                except ChatHistoryUnavailable:
                    messages = []
            if messages is None:
                return
            await asyncio.gather(*(
                self._gated(gate, self._blank_exchange(partition_key, message.id))
                for message in messages if exchange_backed(message)
            ))
            async with gate:
                await self._blank(archive_page_key(partition_key, conversation_id, number))

        await asyncio.gather(*(
            _page(number) for number in range(count // ARCHIVE_PAGE_MESSAGES + 1 + (1 if count else 0))
        ))

    def _cleanup_gate(self) -> asyncio.Semaphore:
        return asyncio.Semaphore(HYDRATE_CONCURRENCY if self._concurrent_writes else 1)

    @staticmethod
    async def _gated(gate: asyncio.Semaphore, work: Awaitable[Any]) -> Any:
        async with gate:
            return await work

    def _in_background(self, work: Awaitable[Any], name: str) -> None:
        """Run best-effort cleanup off the caller's critical path, as a TRACKED task
        (kept referenced until done; :meth:`wait_for_cleanup` awaits them all)."""
        task = asyncio.ensure_future(work)
        try:
            task.set_name(name)
        except AttributeError:  # pragma: no cover - every supported runtime has it
            pass
        self._cleanup.add(task)
        task.add_done_callback(self._cleanup_done)

    def _cleanup_done(self, task: asyncio.Future) -> None:
        self._cleanup.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.warning("chat history cleanup failed (%s)", type(task.exception()).__name__)

    async def wait_for_cleanup(self) -> None:
        """Await every background cleanup started so far (tests, factory reset)."""
        while self._cleanup:
            await asyncio.gather(*list(self._cleanup), return_exceptions=True)

    async def _blank_removed(self, partition_key: str, removed: _Removed) -> None:
        """Blank every auxiliary document of conversations a write removed —
        concurrently behind one semaphore (:data:`HYDRATE_CONCURRENCY`), since an
        evicted or deleted conversation can be very long (one exchange document per
        answer, plus its archive pages)."""
        if not removed.conversations:
            return
        ids: set[str] = set()
        gate = self._cleanup_gate()
        jobs: list[Awaitable[Any]] = []
        for conversation in removed.conversations:
            ids.add(conversation.id)
            jobs.extend(
                self._gated(gate, self._blank_exchange(partition_key, message.id))
                for message in conversation.messages if exchange_backed(message)
            )
            jobs.append(self._blank_archive(
                partition_key, conversation.id, removed.archives.get(conversation.id) or {}, gate,
            ))
            jobs.append(self._gated(gate, self._blank(summary_key(partition_key, conversation.id))))
        await asyncio.gather(*jobs)
        try:
            await self._scrub_observations(partition_key, ids)
        except Exception as exc:  # noqa: BLE001 -- best effort, like the blanks above
            logger.warning("chat step observations not scrubbed (%s)", type(exc).__name__)
        try:
            # The owner's ratings of these answers (their comments are user text).
            from .chat_feedback import ChatFeedbackStore

            await ChatFeedbackStore(self._kv).forget_partition_conversations(partition_key, ids)
        except Exception as exc:  # noqa: BLE001 -- best effort
            logger.warning("chat feedback not removed (%s)", type(exc).__name__)

        def _forget(live: dict[str, Any]) -> bool:
            dropped = [cid for cid in ids if cid in live["flags"]]
            for cid in dropped:
                live["flags"].pop(cid, None)
            return bool(dropped)

        await self._change_live_soft(partition_key, _forget, "forget")

    async def _hydrate(
        self,
        partition_key: str,
        conversation: ChatConversation,
        *,
        after: str | None = None,
        known: dict[str, ExchangeRecord] | None = None,
        only: set[str] | None = None,
        last: int | None = None,
        first: int | None = None,
        strict: bool = False,
    ) -> ChatConversation:
        """Restore exchange-backed messages whose inline copy is partial from their
        exchange documents (STORED form in, stored form out). Which ones:
        ``after`` — only messages after that message id (the engine replays a running
        summary for the rest); ``only`` — these assistant message ids; ``last`` /
        ``first`` — only among the newest / oldest that many messages. A restored
        answer also restores its question (the message before it). A missing
        document leaves the inline copy, still ``truncated``; so does an unreadable
        one, unless ``strict``: then it raises :class:`ChatHistoryUnavailable` (a
        caller about to SNAPSHOT the answer — a report — must never mistake "could
        not read" for the stored preview)."""
        messages = list(conversation.messages)
        start = 0
        if after:
            position = next((i for i, m in enumerate(messages) if m.id == after), None)
            start = position + 1 if position is not None else 0
        targets = [i for i in range(start, len(messages)) if needs_hydration(messages[i])]
        if only is not None:
            targets = [i for i in targets if messages[i].id in only]
        if last is not None:
            targets = [i for i in targets if i >= len(messages) - max(0, int(last))]
        if first is not None:
            targets = [i for i in targets if i < max(0, int(first))]
        if not targets:
            return conversation
        gate = asyncio.Semaphore(HYDRATE_CONCURRENCY)

        async def _load(index: int) -> tuple[int, ExchangeRecord | None]:
            mid = messages[index].id
            if known and mid in known:
                return index, known[mid]
            async with gate:
                return index, await self._load_exchange(partition_key, mid, strict=strict)

        for index, record in await asyncio.gather(*(_load(i) for i in targets)):
            if record is None:
                continue
            response = dict(record.response or {})
            response[EXCHANGE_MARKER] = True
            if not response.get("truncated"):
                response.pop("truncated", None)
            messages[index] = messages[index].model_copy(update={
                "content": record.assistant_content, "response": response,
            })
            prior = messages[index - 1] if index > 0 else None
            if prior is not None and prior.role == "user" and prior.id == record.user_message_id:
                messages[index - 1] = prior.model_copy(update={"content": record.user_content})
        return conversation.model_copy(update={"messages": messages})

    # ------------------------------------------------------------------ #
    # Reads.
    # ------------------------------------------------------------------ #
    async def list_page(
        self, user_id: str | None, *, limit: int = 30, offset: int = 0
    ) -> ChatHistoryPage:
        """Summaries with every pinned conversation first, then newest first. A
        conversation with a question in flight reads ``running``; a brand-new thread
        whose first answer is still being written is listed as a temporary row
        (``running``, no messages) from its reservation (Round 12, D13). Rows are read
        WITHOUT validating their messages (only the count is listed)."""
        key, doc = await self._partition_doc(user_id)
        live = await self._load_live(key)
        running = _running_conversations({"requests": stored_request_rows(doc)}, live)
        summaries: list[ChatConversationSummary] = []
        for cid, raw in stored_conversation_rows(doc).items():
            summary = _normalize_summary(raw, str(cid))
            if summary is not None:
                summaries.append(_with_live_status(summary, running, live))
        retained = len(summaries)
        pending = [_summary(row) for row in _pending_rows((s.id for s in summaries), running)]
        rows = _listing_order([*summaries, *pending])
        start = max(0, int(offset))
        end = start + max(0, int(limit))
        stored_total = int((doc or {}).get("total_conversation_count", retained) or retained)
        total_lifetime = max(retained, stored_total)
        return ChatHistoryPage(
            conversations=[_summary(item) for item in rows[start:end]],
            total=len(rows),
            history_truncated=bool(
                (doc or {}).get("history_truncated", False) or total_lifetime > retained
            ),
            total_conversation_count=total_lifetime,
            oldest_retained_at=min(
                (item.created_at for item in summaries), default=None
            ),
        )

    async def list_for_user(
        self, user_id: str | None, *, limit: int = 30, offset: int = 0
    ) -> tuple[list[ChatConversationSummary], int]:
        page = await self.list_page(user_id, limit=limit, offset=offset)
        return page.conversations, page.total

    async def search(
        self, user_id: str | None, query: str, *, limit: int = 30, offset: int = 0,
    ) -> ChatHistoryPage:
        """SPEC §7.5 Search: a case-insensitive substring over titles, user and
        assistant text and block titles, in listing order; each hit names where it
        matched (``match.message_id`` is None for a title hit). Round 12: a message
        whose inline copy is a preview, and every archived message, is searched in its
        full text — the documents are read concurrently, at most
        :data:`DEEP_SEARCH_MAX_LOADS` per search; past that the page says
        ``search_incomplete`` (older messages of some conversations were not searched)."""
        needle = " ".join(str(query or "").split()).lower()[:MAX_SEARCH_CHARS]
        key, data = await self._load_partition(user_id)
        live = await self._load_live(key)
        running = _running_conversations(data, live)
        rows = _listing_order(_with_live_status(c, running, live) for c in data["conversations"].values())
        hits: list[ChatConversationSearchHit] = []
        incomplete = False
        if needle:
            found = {conversation.id: _match(conversation, needle) for conversation in rows}
            deep, incomplete = await self._deep_search(
                key, data, [c for c in rows if found[c.id] is None], needle,
            )
            for conversation in rows:
                match = found[conversation.id] or deep.get(conversation.id)
                if match is not None:
                    hits.append(ChatConversationSearchHit(**_summary(conversation).model_dump(), match=match))
        start = max(0, int(offset))
        end = start + max(0, int(limit))
        retained = len(rows)
        total_lifetime = max(retained, int(data.get("total_conversation_count", retained)))
        return ChatHistoryPage(
            conversations=list(hits[start:end]),
            total=len(hits),
            history_truncated=bool(
                data.get("history_truncated", False) or total_lifetime > retained
            ),
            total_conversation_count=total_lifetime,
            oldest_retained_at=min((item.oldest_retained_at or item.created_at for item in rows), default=None),
            search_incomplete=incomplete,
        )

    async def _deep_search(
        self, partition_key: str, data: dict[str, Any], conversations: list[ChatConversation], needle: str,
    ) -> tuple[dict[str, ChatConversationMatch], bool]:
        """Full-text matches for conversations the inline copies did not match, and
        whether the read budget cut the search short. Budget order: newest
        conversation first; in each, its row's partial messages newest first, then
        its archive pages newest first; then the archived partial messages."""
        budget = [DEEP_SEARCH_MAX_LOADS]
        incomplete = False
        gate = asyncio.Semaphore(HYDRATE_CONCURRENCY)

        def _take() -> bool:
            if budget[0] <= 0:
                return False
            budget[0] -= 1
            return True

        async def _record(mid: str) -> ExchangeRecord | None:
            async with gate:
                return await self._load_exchange(partition_key, mid)

        async def _page(cid: str, number: int) -> tuple[str, int, list[ChatConversationMessage] | None]:
            async with gate:
                try:
                    return cid, number, await self._load_archive_page(partition_key, cid, number)
                except ChatHistoryUnavailable:
                    return cid, number, None

        # Phase 1: the rows' partial messages and the archive pages.
        row_reads: dict[str, list[ChatConversationMessage]] = {}
        page_reads: list[tuple[str, int]] = []
        for conversation in conversations:
            wanted = []
            for message in reversed(conversation.messages):
                if not needs_hydration(message):
                    continue
                if not _take():
                    incomplete = True
                    break
                wanted.append(message)
            row_reads[conversation.id] = wanted
            count = int((data.get("archives") or {}).get(conversation.id, {}).get("count") or 0)
            for number in range((count - 1) // ARCHIVE_PAGE_MESSAGES, -1, -1) if count else ():
                if not _take():
                    incomplete = True
                    break
                page_reads.append((conversation.id, number))
        records: dict[str, ExchangeRecord | None] = {}
        mids = [m.id for wanted in row_reads.values() for m in wanted]
        loaded = await asyncio.gather(*(_record(mid) for mid in mids), *(_page(c, n) for c, n in page_reads))
        records.update(zip(mids, loaded[: len(mids)]))
        archived: dict[str, list[tuple[int, ChatConversationMessage]]] = {}
        for cid, number, messages in loaded[len(mids):]:  # type: ignore[misc]
            count = int(data["archives"][cid]["count"])
            base = number * ARCHIVE_PAGE_MESSAGES
            for index, message in enumerate((messages or [])[: max(0, count - base)]):
                archived.setdefault(cid, []).append((base + index, message))
        # Phase 2: the archived messages whose copy is partial (newest first).
        more: list[str] = []
        for conversation in conversations:
            for _index, message in sorted(archived.get(conversation.id, []), key=lambda item: -item[0]):
                if needs_hydration(message):
                    if not _take():
                        incomplete = True
                        break
                    more.append(message.id)
        records.update(zip(more, await asyncio.gather(*(_record(mid) for mid in more))))

        out: dict[str, ChatConversationMatch] = {}
        for conversation in conversations:
            ordered = list(reversed(conversation.messages))
            ordered += [m for _i, m in sorted(archived.get(conversation.id, []), key=lambda item: -item[0])]
            in_row = {m.id for m in conversation.messages}
            match = None
            for position, message in enumerate(ordered):
                if message.id not in in_row:
                    # An archived copy: its own (preview) text and block titles first.
                    match = _match(conversation.model_copy(update={"messages": [message], "title": ""}), needle)
                    if match is not None and match.message_id is None:
                        match = None
                if match is None:
                    record = records.get(message.id)
                    if record is not None:
                        if needle in _fold(record.assistant_content):
                            match = ChatConversationMatch(
                                message_id=message.id, snippet=_snippet(record.assistant_content, needle),
                            )
                        elif needle in _fold(record.user_content):
                            question = ordered[position + 1] if position + 1 < len(ordered) else None
                            match = ChatConversationMatch(
                                message_id=question.id if question is not None and question.role == "user"
                                else message.id,
                                snippet=_snippet(record.user_content, needle),
                            )
                if match is not None:
                    out[conversation.id] = match
                    break
        return out, incomplete

    async def get(
        self,
        user_id: str | None,
        conversation_id: str,
        *,
        window: int | None = TRANSCRIPT_WINDOW,
        hydrate_after: str | None = None,
        hydrate_last: int | None = None,
        hydrate_first: int | None = None,
        hydrate: bool = True,
        strict: bool = False,
    ) -> ChatConversation | None:
        """One owned conversation with decoded message responses.

        ``window``: the newest that many messages (``None``: the whole transcript,
        archive pages included); ``earlier_message_count`` says how many older ones
        were left out (``messages_page`` reads them). Every message of the result is
        restored to its full text unless narrowed: ``hydrate_after`` (only after that
        message id — the turn route passes the running summary's ``covers_through``),
        ``hydrate_last``/``hydrate_first`` (only the newest/oldest that many), or
        ``hydrate=False`` (inline copies only). ``strict``: an exchange document that
        cannot be read raises :class:`ChatHistoryUnavailable` instead of leaving the
        inline preview (callers that snapshot answers, e.g. a report)."""
        key, doc = await self._partition_doc(user_id)
        conversation, info = _decode_row(doc, str(conversation_id))
        if conversation is None:
            return None
        live = await self._load_live(key)
        running = _running_conversations({"requests": stored_request_rows(doc)}, live)
        conversation = _with_live_status(conversation, running, live)
        total = int(info["count"]) + len(conversation.messages)
        start = 0 if window is None else max(0, total - max(0, int(window)))
        # One message more on each side is read so a question or answer at the edge
        # is restored with its partner, then left out.
        lo, hi = max(0, start - 1), total
        messages = await self._slice(key, conversation, info, lo, hi)
        window_conversation = conversation.model_copy(update={"messages": messages})
        if hydrate:
            window_conversation = await self._hydrate(
                key, window_conversation, after=hydrate_after, last=hydrate_last,
                first=None if hydrate_first is None else hydrate_first + (start - lo),
                strict=strict,
            )
        kept = window_conversation.messages[start - lo:] if total else []
        return _decoded(conversation.model_copy(update={
            "messages": kept, "earlier_message_count": start,
        }))

    async def messages_page(
        self, user_id: str | None, conversation_id: str, *, before: str | None = None,
        limit: int = 50,
    ) -> tuple[list[ChatConversationMessage], int] | None:
        """Up to ``limit`` messages immediately BEFORE message ``before`` (the newest
        ones when ``before`` is None), oldest first and restored to their full text,
        plus how many older ones remain. ``None`` when the conversation is not owned;
        :class:`ChatMessageMissing` when ``before`` is not one of its messages."""
        key, doc = await self._partition_doc(user_id)
        conversation, info = _decode_row(doc, str(conversation_id))
        if conversation is None:
            return None
        count = int(info["count"])
        total = count + len(conversation.messages)
        if before is None:
            end = total
        else:
            position = next((i for i, m in enumerate(conversation.messages) if m.id == before), None)
            end = count + position if position is not None else await self._find_archived(
                key, conversation.id, count, before,
            )
            if end is None:
                raise ChatMessageMissing("message not found")
        start = max(0, end - max(1, min(int(limit), MAX_MESSAGE_PAGE)))
        lo, hi = max(0, start - 1), min(total, end + 1)
        messages = await self._slice(key, conversation, info, lo, hi)
        restored = await self._hydrate(key, conversation.model_copy(update={"messages": messages}))
        kept = restored.messages[start - lo: start - lo + (end - start)]
        return [_decoded_message(m) for m in kept], start

    async def _locate(
        self, user_id: str | None, conversation_id: str, message_id: str, *, strict: bool = False,
    ) -> tuple[ChatConversation | None, list[ChatConversationMessage], int | None]:
        """``(conversation row, restored neighbourhood, index of the message in it)``:
        the message, the one before and the one after, read from the row or the
        archive and restored to their full text (one exchange document per answer;
        ``strict``: an unreadable one raises instead of leaving the preview)."""
        key, doc = await self._partition_doc(user_id)
        conversation, info = _decode_row(doc, str(conversation_id))
        if conversation is None:
            return None, [], None
        count = int(info["count"])
        position = next((i for i, m in enumerate(conversation.messages) if m.id == str(message_id)), None)
        if position is not None:
            index = count + position
        else:
            index = await self._find_archived(key, conversation.id, count, str(message_id)) if count else None
            if index is None:
                return conversation, [], None
        lo = max(0, index - 1)
        hi = min(count + len(conversation.messages), index + 2)
        window = await self._slice(key, conversation, info, lo, hi)
        restored = await self._hydrate(
            key, conversation.model_copy(update={"messages": window}), strict=strict,
        )
        target = next((i for i, m in enumerate(restored.messages) if m.id == str(message_id)), None)
        return conversation, list(restored.messages), target

    async def message(
        self, user_id: str | None, conversation_id: str, message_id: str,
    ) -> ChatConversationMessage | None:
        """One owned message, decoded and restored to its full form — reading only
        that message's exchange document (the step inspector, feedback checks)."""
        _conversation, window, target = await self._locate(user_id, conversation_id, message_id)
        return _decoded_message(window[target]) if target is not None else None

    async def get_exchange(
        self, user_id: str | None, conversation_id: str, message_id: str, *, strict: bool = False,
    ) -> ChatConversation | None:
        """The owned conversation (its fields) whose ``messages`` are only the answer
        ``message_id`` and its neighbours — the question before it — restored to full
        text. ``messages`` is empty when the message is not part of the conversation;
        ``None`` when the conversation is not owned. Reports resolve an answer through
        this instead of the whole transcript, with ``strict=True``: an exchange
        document that cannot be read raises :class:`ChatHistoryUnavailable`, so a
        report never snapshots the inline preview as the answer."""
        conversation, window, target = await self._locate(
            user_id, conversation_id, message_id, strict=strict,
        )
        if conversation is None:
            return None
        kept = window[: target + 1] if target is not None else []
        return _decoded(conversation.model_copy(update={"messages": kept, "earlier_message_count": 0}))

    async def get_message(
        self, user_id: str | None, conversation_id: str, message_id: str, *, strict: bool = False,
    ) -> tuple[ChatConversation, ChatConversationMessage] | None:
        """``(conversation, decoded message)`` for one owned message (the reports
        package resolves "Add to report" through this, SPEC §9.2). The conversation's
        ``messages`` hold only that message and the question before it."""
        conversation = await self.get_exchange(user_id, conversation_id, message_id, strict=strict)
        if conversation is None:
            return None
        message = next((m for m in conversation.messages if m.id == str(message_id)), None)
        return (conversation, message) if message is not None else None

    async def exists(self, user_id: str | None, conversation_id: str) -> bool:
        """Whether the caller owns the conversation (no transcript is read)."""
        _key, doc = await self._partition_doc(user_id)
        return _find_row(doc, str(conversation_id)) is not None

    @staticmethod
    def _prune_requests(data: dict[str, Any], live: dict[str, Any] | None = None) -> None:
        requests = data.get("requests", {})
        if len(requests) <= MAX_IDEMPOTENCY_RECORDS:
            return
        # Completed receipts are the safest records to age out.  Abandoned leases
        # must also be reclaimable, otherwise a sequence of crashed workers can grow
        # one user's partition without bound.  Never evict a live lease: its worker
        # still needs the token to complete or abort the exact request safely.
        evictable = sorted(
            (
                (key, value)
                for key, value in requests.items()
                if value.get("status") == "completed"
                or (
                    value.get("status") == "in_progress"
                    and not _lease_held(str(key), value, live)
                )
            ),
            key=lambda item: (
                0 if item[1].get("status") == "completed" else 1,
                str(item[1].get("updated_at") or ""),
                item[0],
            ),
        )
        excess = max(0, len(requests) - MAX_IDEMPOTENCY_RECORDS)
        for key, _value in evictable[:excess]:
            requests.pop(key, None)

    @staticmethod
    def _append_to_data(
        data: dict[str, Any],
        *,
        conversation_id: str,
        require_existing: bool,
        user_content: str,
        assistant_content: str,
        response: dict[str, Any] | None,
        model: str | None,
        source_id: str | None,
        source_name: str | None,
        idempotency_key: str | None,
        now: str,
        user_origin: str | None = None,
        time_range: TimeRange | dict[str, Any] | None | Literal[False] = False,
        user_message_id: str | None = None,
        assistant_message_id: str | None = None,
        exchange_saved: bool = False,
        removed: _Removed | None = None,
        live: dict[str, Any] | None = None,
    ) -> tuple[ChatConversation | None, str | None]:
        """Append one exchange to the decoded partition ``data`` (in place).

        ``exchange_saved`` (Round 12): the caller has written the exchange document,
        so the inline copy may be partial — it is marked and restored on read, and
        nothing counts as "shortened" in ``history_truncated``. ``removed`` collects
        the conversations retention evicted (their auxiliary documents are blanked by
        the caller after the write). ``live`` (the owner's live state) tells which
        conversations have a turn still running: like pinned ones, those are never
        evicted, so a long turn always finds the conversation it is answering in.

        The row's ``status``/``unread`` stay at their defaults: the owner's live-state
        document holds them (the caller marks the answer unread there)."""
        rows: dict[str, ChatConversation] = dict(data["conversations"])
        archives: dict[str, dict[str, Any]] = data.setdefault("archives", {})
        archived = int((archives.get(conversation_id) or {}).get("count") or 0)
        existing = rows.get(conversation_id)
        if require_existing and existing is None:
            return None, None
        is_new = existing is None
        if existing is None:
            existing = ChatConversation(
                id=conversation_id,
                title=derive_title(user_content),
                preview="",
                created_at=now,
                updated_at=now,
                message_count=0,
                total_message_count=0,
                messages=[],
                total_tokens=0,
                total_cost=0.0,
                usage_turns=0,
            )

        saved_user, user_truncated = _clip(user_content, MAX_USER_MESSAGE_CHARS)
        saved_assistant, assistant_truncated = _clip(
            assistant_content, MAX_ASSISTANT_MESSAGE_CHARS
        )
        stored_response, response_truncated = encode_assistant_response(response)
        if exchange_saved:
            # The exchange document holds the whole exchange: the inline copy is a
            # bounded view of it, marked so reads restore the rest.
            full, _ = encode_assistant_response(response, compact=False)
            partial = bool(
                user_truncated or assistant_truncated or response_truncated
                or not inline_is_complete(full, stored_response)
            )
            stored_response = dict(stored_response or {})
            stored_response.pop("truncated", None)
            if partial or (full or {}).get("truncated"):
                stored_response["truncated"] = True
            stored_response[EXCHANGE_MARKER] = True
            shortened = bool((full or {}).get("truncated"))
        else:
            if stored_response is not None and (
                user_truncated or assistant_truncated or response_truncated
            ):
                stored_response["truncated"] = True
            shortened = bool(user_truncated or assistant_truncated or response_truncated)
        user_message = ChatConversationMessage(
            id=user_message_id or new_id("chatmsg-"),
            role="user",
            content=saved_user,
            created_at=now,
            response=encode_user_response(user_origin),
            idempotency_key=idempotency_key,
        )
        assistant_message = ChatConversationMessage(
            id=assistant_message_id or new_id("chatmsg-"),
            role="assistant",
            content=saved_assistant,
            created_at=now,
            response=stored_response,
            model=(str(model).strip() or None) if model is not None else None,
            source_id=(str(source_id).strip() or None) if source_id is not None else None,
            source_name=(str(source_name).strip() or None)
            if source_name is not None else None,
            idempotency_key=idempotency_key,
        )
        candidate = [*existing.messages, user_message, assistant_message]
        messages, retention_truncated = _trim_messages(candidate)
        total_messages = max(existing.total_message_count, len(existing.messages) + archived) + 2
        history_truncated = bool(existing.history_truncated or retention_truncated or shortened)
        preview, _ = _clip(assistant_content, MAX_PREVIEW_CHARS)
        oldest = (archives.get(conversation_id) or {}).get("oldest_at") if archived else None
        updates: dict[str, Any] = {
            "messages": messages,
            "message_count": len(messages) + archived,
            "total_message_count": total_messages,
            "history_truncated": history_truncated,
            "oldest_retained_at": oldest or (messages[0].created_at if messages else None),
            "preview": " ".join(preview.split()),
            "updated_at": now,
            "model": assistant_message.model or existing.model,
            "source_id": assistant_message.source_id
            if source_id is not None else existing.source_id,
            "source_name": assistant_message.source_name
            if source_name is not None else existing.source_name,
            # Round 12 live state lives in the owner's live-state document.
            "status": "idle",
            "unread": False,
        }
        # Cumulative usage (SPEC §7.5 Summary fields): incremented here, so trimming
        # never shrinks it. A pre-revamp conversation has no knowable earlier total
        # and stays ``None`` ("—"), never a misleading partial sum.
        totals = _usage_totals(response)
        if totals is not None and existing.total_tokens is not None:
            tokens, cost = totals
            updates["total_tokens"] = int(existing.total_tokens) + tokens
            updates["total_cost"] = round(float(existing.total_cost or 0.0) + cost, 10)
            updates["usage_turns"] = int(existing.usage_turns or 0) + 1
        if time_range is not False:
            # model_copy does not validate, so the window is validated here (leniently:
            # an unusable one is simply not recorded).
            updates["time_range"] = _time_range_or_none(time_range)
        stored = existing.model_copy(update=updates)
        rows[conversation_id] = stored
        if is_new:
            data["total_conversation_count"] = max(
                len(rows), int(data.get("total_conversation_count", 0)) + 1
            )
        # Pinned conversations (SPEC §7.5) and conversations a running turn is
        # answering in are exempt; the newest other 50 stay. An exempt running one is
        # evicted by a later write once its turn has ended, never under it.
        running = set(_running_conversations(data, live))
        # The conversation answered now is the newest anyway (and its own reservation
        # is still in progress inside this write): it competes like any other.
        running.discard(conversation_id)
        exempt = {cid for cid, item in rows.items() if item.pinned or cid in running}
        evictable = [item for cid, item in rows.items() if cid not in exempt]
        if len(evictable) > MAX_CONVERSATIONS_PER_USER:
            keep = sorted(
                evictable, key=lambda item: (item.updated_at, item.id), reverse=True
            )[:MAX_CONVERSATIONS_PER_USER]
            kept_ids = {item.id for item in keep} | exempt
            if removed is not None:
                for cid, item in rows.items():
                    if cid not in kept_ids:
                        removed.conversations.append(item)
                        removed.archives[cid] = dict(archives.get(cid) or {})
            rows = {cid: item for cid, item in rows.items() if cid in kept_ids}
            for cid in list(archives):
                if cid not in rows:
                    archives.pop(cid, None)
            data["history_truncated"] = True
            # Completed receipts remain bounded independently of transcript rows.
            # Keeping them allows a lost-response retry to replay after the original
            # assistant message (or entire old conversation) ages out of retention.
        data["conversations"] = rows
        return stored, assistant_message.id

    async def append_exchange(
        self,
        user_id: str | None,
        *,
        conversation_id: str | None,
        user_content: str,
        assistant_content: str,
        response: dict[str, Any] | None = None,
        model: str | None = None,
        source_id: str | None = None,
        source_name: str | None = None,
        idempotency_key: str | None = None,
        user_origin: str | None = None,
    ) -> ChatConversation | None:
        """Append one exchange without a reservation (tests, imports). Like
        :meth:`complete_exchange`, the full exchange is written to its own document
        first; the result is the conversation's newest window, restored."""
        key = await self._ensure_partition_key(user_id)
        live = await self._load_live(key)
        cid = str(conversation_id or new_id("chat-"))
        now = iso_now()
        user_mid, assistant_mid = new_id("chatmsg-"), new_id("chatmsg-")
        await self._write_exchange(key, ExchangeRecord(
            conversation_id=cid, user_message_id=user_mid, assistant_message_id=assistant_mid,
            user_content=str(user_content or ""), assistant_content=str(assistant_content or ""),
            response=encode_assistant_response(response, compact=False)[0], created_at=now,
        ))
        removed = _Removed()

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], ChatConversation | None]:
            data = _decode_partition(current)
            removed.reset()
            stored, _assistant_id = self._append_to_data(
                data,
                conversation_id=cid,
                require_existing=conversation_id is not None,
                user_content=user_content,
                assistant_content=assistant_content,
                response=response,
                model=model,
                source_id=source_id,
                source_name=source_name,
                idempotency_key=idempotency_key,
                now=now,
                user_origin=user_origin,
                user_message_id=user_mid,
                assistant_message_id=assistant_mid,
                exchange_saved=True,
                removed=removed,
                live=live,
            )
            return self._encode(data), stored

        try:
            stored = await self._strict_mutate(key, _change)
        except ChatHistoryUnavailable:
            raise
        except Exception:
            await self._blank_exchange(key, assistant_mid)
            raise
        if stored is None:
            await self._blank_exchange(key, assistant_mid)
            return None
        await self._blank_removed(key, removed)
        await self._mark_answered(key, cid, response, None)
        await self._maybe_archive(key, cid)
        return await self.get(user_id, cid)

    @staticmethod
    def _receipt_message(
        request: dict[str, Any], *, idempotency_key: str, fallback_id: str, now: str,
    ) -> ChatConversationMessage | None:
        """The assistant message a completed receipt can still replay after the
        transcript lost it (bounded text + scalars only)."""
        if request.get("assistant_content") is None:
            return None
        return ChatConversationMessage(
            id=str(request.get("assistant_message_id") or fallback_id),
            role="assistant",
            content=str(request.get("assistant_content") or ""),
            created_at=str(request.get("updated_at") or now),
            response=copy.deepcopy(request.get("assistant_response")),
            model=request.get("model"),
            source_id=request.get("source_id"),
            source_name=request.get("source_name"),
            idempotency_key=idempotency_key,
        )

    def _completed_reservation(
        self,
        data: dict[str, Any],
        request: dict[str, Any],
        *,
        idempotency_key: str,
        conversation_id: str,
        now: str,
    ) -> ChatExchangeReservation:
        """A completed receipt in STORED form (restored and decoded by
        :meth:`_finish_reservation` outside the compare-and-set)."""
        conversation = data["conversations"].get(conversation_id)
        assistant_id = str(request.get("assistant_message_id") or "")
        assistant = next(
            (
                item
                for item in (conversation.messages if conversation else [])
                if item.id == assistant_id
            ),
            None,
        )
        if assistant is None:
            assistant = self._receipt_message(
                request, idempotency_key=idempotency_key,
                fallback_id=assistant_id or new_id("chatmsg-replay-"), now=now,
            )
        if assistant is None:
            raise ChatHistoryUnavailable(
                "The completed chat receipt could not be restored."
            )
        return ChatExchangeReservation(
            status="completed",
            idempotency_key=idempotency_key,
            conversation_id=conversation_id,
            conversation=conversation,
            assistant_message=assistant,
            conversation_title=str(
                request.get("conversation_title")
                or (conversation.title if conversation else "Conversation")
            ),
        )

    async def _finish_reservation(
        self,
        partition_key: str,
        reservation: ChatExchangeReservation,
        *,
        known: dict[str, ExchangeRecord] | None = None,
    ) -> ChatExchangeReservation:
        """Decode a completed reservation, restoring ONLY its answer (and the question
        before it) to full text: the conversation's other messages keep their inline
        copies (the routes read its id and title, and the answer)."""
        if reservation.status != "completed":
            return reservation
        conversation = reservation.conversation
        assistant = reservation.assistant_message
        if conversation is not None and assistant is not None and any(
            m.id == assistant.id for m in conversation.messages
        ):
            conversation = await self._hydrate(partition_key, conversation, only={assistant.id}, known=known)
            assistant = next((m for m in conversation.messages if m.id == assistant.id), assistant)
        elif assistant is not None and needs_hydration(assistant):
            restored = await self._hydrate(partition_key, ChatConversation(
                id=reservation.conversation_id, title="Conversation",
                created_at=assistant.created_at, updated_at=assistant.created_at, messages=[assistant],
            ), known=known)
            assistant = restored.messages[0]
        return replace(
            reservation,
            conversation=_decoded(conversation),
            assistant_message=_decoded_message(assistant) if assistant is not None else None,
        )

    async def reserve_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        conversation_id: str | None,
        lease_seconds: float | None = None,
        title_hint: str | None = None,
    ) -> ChatExchangeReservation:
        """Reserve ``idempotency_key`` for one exchange. ``lease_seconds`` is how long
        the reservation stays owned without completing or renewing
        (:meth:`renew_exchange`; Round 12: a running turn renews it every minute), never
        shorter than :data:`IDEMPOTENCY_PENDING_TTL_SECONDS`. ``title_hint`` (the
        question) names the temporary history row of a brand-new thread while its first
        answer is written (stored as a bounded title only)."""
        key = await self._ensure_partition_key(user_id)
        # The heartbeat lives in the live state: an unreadable one must not let a
        # running turn's key be reclaimed (strict).
        live = await self._load_live(key, strict=True)
        cid = str(conversation_id or new_id("chat-"))
        now = iso_now()
        lease = _lease_ttl(lease_seconds)
        title = derive_title(title_hint) if isinstance(title_hint, str) and title_hint.strip() else None

        def _change(
            current: dict[str, Any] | None,
        ) -> tuple[dict[str, Any], ChatExchangeReservation]:
            data = _decode_partition(current)
            rows: dict[str, ChatConversation] = data["conversations"]
            request = data["requests"].get(idempotency_key)
            if request is not None:
                if request.get("fingerprint") != request_fingerprint:
                    raise ChatIdempotencyConflict(
                        "The idempotency key belongs to a different chat request."
                    )
                request_cid = str(request.get("conversation_id") or cid)
                if request.get("status") == "completed":
                    return self._encode(data), self._completed_reservation(
                        data, request, idempotency_key=idempotency_key,
                        conversation_id=request_cid, now=now,
                    )
                if conversation_id is not None and request_cid not in rows:
                    raise ChatConversationMissing("conversation not found")
                if _lease_held(idempotency_key, request, live):
                    if request.get("ended"):
                        raise ChatRequestFailed(CHAT_REQUEST_FAILED_MESSAGE)
                    raise ChatRequestInProgress("This chat request is already in progress.")
                # A crashed worker's bounded lease may be reclaimed only by the exact
                # same request fingerprint and conversation target.
                lease_token = new_id("chatlease-")
                request["updated_at"] = now
                request["status"] = "in_progress"
                request["lease_token"] = lease_token
                request["lease_seconds"] = lease
                request.pop("ended", None)
                if title and not request.get("title"):
                    request["title"] = title
                data["requests"][idempotency_key] = request
                return self._encode(data), ChatExchangeReservation(
                    status="reserved",
                    idempotency_key=idempotency_key,
                    conversation_id=request_cid,
                    lease_token=lease_token,
                )

            if conversation_id is not None and conversation_id not in rows:
                raise ChatConversationMissing("conversation not found")

            lease_token = new_id("chatlease-")
            record: dict[str, Any] = {
                "status": "in_progress",
                "fingerprint": request_fingerprint,
                "conversation_id": cid,
                "created_at": now,
                "updated_at": now,
                "lease_token": lease_token,
                "lease_seconds": lease,
            }
            if title:
                record["title"] = title
            data["requests"][idempotency_key] = record
            self._prune_requests(data, live)
            if len(data["requests"]) > MAX_IDEMPOTENCY_RECORDS:
                raise ChatRequestCapacityBusy(
                    "Too many chat requests are in progress; retry shortly."
                )
            return self._encode(data), ChatExchangeReservation(
                status="reserved",
                idempotency_key=idempotency_key,
                conversation_id=cid,
                lease_token=lease_token,
            )

        reservation = await self._strict_mutate(key, _change)
        return await self._finish_reservation(key, reservation)

    async def renew_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        lease_token: str,
        lease_seconds: float | None = None,
    ) -> bool:
        """The turn lease heartbeat (Round 12): move the reservation's lease forward
        while its turn is still running. It writes only the owner's small live-state
        document, never the partition. ``False`` when the lease is no longer this
        caller's (completed, aborted, ended or reclaimed): the heartbeat stops."""
        key = partition_key_for_user(user_id)
        now = iso_now()
        ttl = _lease_ttl(lease_seconds)

        def _renew(live: dict[str, Any]) -> Any:
            entry = live["leases"].get(idempotency_key)
            if not isinstance(entry, dict):
                return _UNCHANGED  # no entry: verified against the partition below
            if entry.get("token") != lease_token or entry.get("fingerprint") != request_fingerprint:
                return False
            entry["at"] = now
            entry["ttl"] = ttl
            return True

        verdict = await self._change_live(key, _renew)
        if verdict is not None:
            return bool(verdict)
        # The entry is gone (completed or aborted), or its write failed at reserve
        # time: the partition record decides.
        doc = await self._strict_get(key)
        record = stored_request_rows(doc).get(idempotency_key)
        if (
            record is None or record.get("status") != "in_progress" or record.get("ended")
            or record.get("fingerprint") != request_fingerprint
            or record.get("lease_token") != lease_token
        ):
            return False

        def _restore(live: dict[str, Any]) -> None:
            live["leases"][idempotency_key] = {
                "token": lease_token, "fingerprint": request_fingerprint, "at": now, "ttl": ttl,
            }

        await self._change_live(key, _restore)
        return True

    async def complete_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        conversation_id: str,
        lease_token: str,
        requested_existing_conversation: bool,
        user_content: str,
        assistant_content: str,
        response: dict[str, Any] | None,
        model: str | None,
        source_id: str | None,
        source_name: str | None,
        user_origin: str | None = None,
        time_range: TimeRange | dict[str, Any] | None | Literal[False] = False,
    ) -> ChatExchangeReservation:
        """Append the exchange under the caller's lease and turn the reservation into
        a compact receipt. ``user_origin`` is stored on the user message (§4.8);
        ``time_range`` (when given, ``None`` included) becomes the conversation's last
        composer window; usage totals are incremented from ``response.usage``.

        Round 12: the full exchange is written to its own document FIRST, then the
        partition (inline copy + receipt) under the compare-and-set, so a saved answer
        of any length always has its full text. A write the store refused blanks that
        document again. Afterwards the answer is marked unread, the row archived past
        its inline ceiling, and only the answer itself is restored for the caller."""
        key = await self._ensure_partition_key(user_id)
        live = await self._load_live(key)
        now = iso_now()
        user_mid, assistant_mid = new_id("chatmsg-"), new_id("chatmsg-")
        record = ExchangeRecord(
            conversation_id=str(conversation_id), user_message_id=user_mid,
            assistant_message_id=assistant_mid, user_content=str(user_content or ""),
            assistant_content=str(assistant_content or ""),
            response=encode_assistant_response(response, compact=False)[0], created_at=now,
        )
        await self._write_exchange(key, record)
        removed = _Removed()
        appended = [False]

        def _change(
            current: dict[str, Any] | None,
        ) -> tuple[dict[str, Any], ChatExchangeReservation]:
            removed.reset()
            appended[0] = False
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if (
                request is None and requested_existing_conversation
                and conversation_id not in data["conversations"]
            ):
                # The conversation was deleted while its turn ran (a delete drops its
                # reservations): say so, not "the reservation no longer matches".
                raise ChatConversationMissing("conversation not found")
            if request is None or request.get("fingerprint") != request_fingerprint:
                raise ChatIdempotencyConflict("The chat reservation no longer matches.")
            if str(request.get("conversation_id") or "") != conversation_id:
                raise ChatIdempotencyConflict("The chat reservation target changed.")
            if request.get("status") == "completed":
                return self._encode(data), self._completed_reservation(
                    data, request, idempotency_key=idempotency_key,
                    conversation_id=conversation_id, now=now,
                )
            if request.get("lease_token") != lease_token:
                raise ChatRequestInProgress(
                    "This chat request is owned by a newer retry lease."
                )
            conversation, assistant_id = self._append_to_data(
                data,
                conversation_id=conversation_id,
                require_existing=requested_existing_conversation,
                user_content=user_content,
                assistant_content=assistant_content,
                response=response,
                model=model,
                source_id=source_id,
                source_name=source_name,
                idempotency_key=idempotency_key,
                now=now,
                user_origin=user_origin,
                time_range=time_range,
                user_message_id=user_mid,
                assistant_message_id=assistant_mid,
                exchange_saved=True,
                removed=removed,
                live=live,
            )
            if conversation is None or assistant_id is None:
                raise ChatConversationMissing("conversation not found")
            assistant = next(item for item in conversation.messages if item.id == assistant_id)
            receipt_content, content_clipped = _clip(assistant.content, MAX_RECEIPT_CONTENT_CHARS)
            data["requests"][idempotency_key] = {
                **{k: v for k, v in request.items() if k not in ("title", "ended")},
                "status": "completed",
                "updated_at": now,
                "assistant_message_id": assistant_id,
                "assistant_content": receipt_content,
                "assistant_response": _receipt_response(assistant.response, content_clipped),
                "conversation_title": conversation.title,
                "model": assistant.model,
                "source_id": assistant.source_id,
                "source_name": assistant.source_name,
            }
            self._prune_requests(data, live)
            appended[0] = True
            return self._encode(data), ChatExchangeReservation(
                status="completed",
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                conversation=conversation,
                assistant_message=assistant,
                conversation_title=conversation.title,
                lease_token=lease_token,
            )

        try:
            reservation = await self._strict_mutate(key, _change)
        except ChatHistoryUnavailable:
            raise  # the write may have landed: the exchange document must stay
        except Exception:
            await self._blank_exchange(key, assistant_mid)
            raise
        if not appended[0]:
            await self._blank_exchange(key, assistant_mid)
        if removed.conversations and self._concurrent_writes:
            # Retention evicted another (possibly very long) conversation: its
            # documents are blanked in the background, so this turn's answer is
            # never kept waiting for an unrelated thread's cleanup (best effort; the
            # factory reset covers anything left).
            self._in_background(self._blank_removed(key, removed), f"{CLEANUP_TASK_PREFIX}:evicted")
        elif removed.conversations:
            await self._blank_removed(key, removed)
        if appended[0]:
            await self._mark_answered(key, conversation_id, response, idempotency_key)
            await self._maybe_archive(key, conversation_id)
        return await self._finish_reservation(key, reservation, known={assistant_mid: record})

    async def abort_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        lease_token: str,
        mark_failed: bool = False,
    ) -> None:
        """Release a reservation (nothing saved). ``mark_failed`` (Round 12): the
        turn failed, so the conversation it targeted, when it exists, reads
        ``failed`` until its next answer."""
        key = partition_key_for_user(user_id)
        target: dict[str, Any] = {}

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, None]:
            target.clear()
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if not (
                request is not None
                and request.get("status") == "in_progress"
                and request.get("fingerprint") == request_fingerprint
                and request.get("lease_token") == lease_token
            ):
                return None, None
            data["requests"].pop(idempotency_key, None)
            cid = str(request.get("conversation_id") or "")
            target.update({"cid": cid, "exists": cid in data["conversations"]})
            return self._encode(data), None

        await self._strict_mutate(key, _change)
        if target:
            await self._end_lease(
                key, idempotency_key, lease_token,
                failed_conversation=target["cid"] if mark_failed and target.get("exists") else None,
            )

    async def end_reservation(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        lease_token: str,
    ) -> bool:
        """A BILLED turn failed after its model calls (Round 12). Its reservation is
        kept, so a same-key retry still gets 409 until the lease runs out and never
        bills the same answer twice (SPEC §6.4), but it is marked ENDED: the turn no
        longer reads as running, a brand-new thread's temporary row disappears, and
        an existing conversation reads ``failed`` until its next answer. The lease
        restarts now (``updated_at``), so the key is held a full lease after the
        failure. False when the reservation is no longer this caller's."""
        key = partition_key_for_user(user_id)
        now = iso_now()
        target: dict[str, Any] = {}

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            target.clear()
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if not (
                request is not None
                and request.get("status") == "in_progress"
                and request.get("fingerprint") == request_fingerprint
                and request.get("lease_token") == lease_token
            ):
                return None, False
            request["ended"] = True
            request["updated_at"] = now
            cid = str(request.get("conversation_id") or "")
            target.update({"cid": cid, "exists": cid in data["conversations"]})
            return self._encode(data), True

        ended = await self._strict_mutate(key, _change)
        if ended:
            await self._end_lease(
                key, idempotency_key, lease_token,
                failed_conversation=target["cid"] if target.get("exists") else None,
            )
        return ended

    async def _update_row(
        self,
        user_id: str | None,
        conversation_id: str,
        change: Callable[[ChatConversation], dict[str, Any] | None],
    ) -> bool:
        """Apply ``change(row) -> updates | None`` to one owned row WITHOUT touching
        ``updated_at``; writes only when something changes. False when not owned."""
        key, doc = await self._partition_doc(user_id)
        cid = str(conversation_id)
        existing, _info = _decode_row(doc, cid)
        if existing is None:
            return False
        updates = change(existing)
        if not updates or all(getattr(existing, k, None) == v for k, v in updates.items()):
            return True

        def _write(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            fresh = _decode_partition(current)
            row = fresh["conversations"].get(cid)
            if row is None:
                return None, False
            again = change(row)
            if not again:
                return None, True
            fresh["conversations"][cid] = row.model_copy(update=again)
            return self._encode(fresh), True

        return await self._strict_mutate(key, _write)

    async def mark_read(self, user_id: str | None, conversation_id: str) -> bool:
        """Clear ``unread`` once the owner has opened the conversation (Round 12,
        D13). ``needs_input`` and ``failed`` stay until the next answer. Writes only
        the owner's live-state document (nothing when already read). False when the
        conversation is not owned."""
        key, doc = await self._partition_doc(user_id)
        cid = str(conversation_id)
        raw = _find_row(doc, cid)
        if raw is None:
            return False
        row_unread = raw.get("unread") is True
        now = iso_now()

        def _clear(live: dict[str, Any]) -> bool:
            flag = live["flags"].get(cid)
            unread = flag["unread"] if isinstance(flag, dict) and isinstance(flag.get("unread"), bool) else row_unread
            if not unread:
                return False
            live["flags"][cid] = {**(flag or {}), "unread": False, "at": now}
            return True

        await self._change_live(key, _clear)
        return True

    async def mark_failed(self, user_id: str | None, conversation_id: str) -> bool:
        """Record that the conversation's latest turn failed (Round 12, D13). Writes
        only the owner's live-state document."""
        key, doc = await self._partition_doc(user_id)
        cid = str(conversation_id)
        if _find_row(doc, cid) is None:
            return False
        now = iso_now()

        def _fail(live: dict[str, Any]) -> bool:
            flag = dict(live["flags"].get(cid) or {})
            if flag.get("status") == "failed":
                return False
            flag.update({"status": "failed", "at": now})
            live["flags"][cid] = flag
            return True

        await self._change_live(key, _fail)
        return True

    # ------------------------------------------------------------------ #
    # Running conversation summary (SPEC D4, §3.6).
    # ------------------------------------------------------------------ #
    async def get_summary(
        self, user_id: str | None, conversation_id: str,
    ) -> ConversationSummaryRecord | None:
        """The stored running summary of one owned conversation, or None."""
        key = partition_key_for_user(user_id)
        payload = await self._get_aux(summary_key(key, str(conversation_id)), SUMMARY_FIELD)
        if not isinstance(payload, dict) or payload.get("owner") != key:
            return None
        if payload.get("conversation_id") != str(conversation_id):
            return None
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        covers = payload.get("covers_through")
        return ConversationSummaryRecord(
            text=text, covers_through=covers if isinstance(covers, str) and covers else None,
            updated_at=str(payload.get("updated_at") or "") or None,
        )

    async def set_summary(
        self, user_id: str | None, conversation_id: str, text: str, covers_through: str | None,
    ) -> bool:
        """Store the engine's new running summary (text + the newest message id it
        folds in). ``covers_through`` must name a message of the conversation (its
        row or its archive); the row records it as ``summary_covers_through``. False
        when not owned or invalid."""
        key, doc = await self._partition_doc(user_id)
        cid = str(conversation_id)
        conversation, info = _decode_row(doc, cid)
        clean = str(text or "")[:MAX_SUMMARY_CHARS]
        if conversation is None or not clean.strip():
            return False
        if (
            covers_through is not None and covers_through not in {m.id for m in conversation.messages}
            and await self._find_archived(key, cid, int(info["count"]), covers_through) is None
        ):
            return False
        await self._put_aux(summary_key(key, cid), {
            "schema": AUX_SCHEMA,
            SUMMARY_FIELD: canonical_json({
                "owner": key, "conversation_id": cid, "text": clean,
                "covers_through": covers_through, "updated_at": iso_now(),
            }),
        })
        return await self._update_row(
            user_id, cid,
            lambda row: {"summary_covers_through": covers_through}
            if row.summary_covers_through != covers_through else None,
        )

    # ------------------------------------------------------------------ #
    # Step observations (P1-1): a per-user ring of answers.
    # ------------------------------------------------------------------ #
    async def save_observations(
        self,
        user_id: str | None,
        *,
        turn_id: str,
        conversation_id: str,
        steps: dict[int, dict[str, Any]],
    ) -> tuple[str, set[int]] | None:
        """Store one answer's per-step observations in the owner's ring and return
        ``(observation_ref, stored step indexes)``. The ring keeps the newest
        :data:`OBSERVATION_RING_SIZE` answers; an answer keeps at most
        :data:`MAX_OBSERVATION_STEPS` steps within :data:`MAX_OBSERVATION_DOC_CHARS`
        (later steps get no ref). None when nothing could be stored."""
        if not steps or not isinstance(turn_id, str) or not re.match(r"^[A-Za-z0-9._:-]{1,128}$", turn_id):
            return None
        kept: dict[str, Any] = {}
        size = 0
        for index in sorted(steps)[:MAX_OBSERVATION_STEPS]:
            try:
                encoded = canonical_json(steps[index])
            except (TypeError, ValueError):
                continue
            if size + len(encoded) > MAX_OBSERVATION_DOC_CHARS:
                break
            kept[str(int(index))] = steps[index]
            size += len(encoded)
        if not kept:
            return None
        key = partition_key_for_user(user_id)
        index_key = observation_index_key(key)
        now = iso_now()

        def _allocate(current: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
            payload = _load_row((current or {}).get(OBSERVATION_INDEX_FIELD)) or {}
            counter = payload.get("next") if isinstance(payload.get("next"), int) else 0
            slots = payload.get("slots") if isinstance(payload.get("slots"), dict) else {}
            slot = max(0, int(counter)) % OBSERVATION_RING_SIZE
            slots[str(slot)] = {"turn_id": turn_id, "conversation_id": str(conversation_id), "at": now}
            doc = {"schema": AUX_SCHEMA, OBSERVATION_INDEX_FIELD: canonical_json(
                {"next": int(counter) + 1, "slots": slots})}
            return doc, slot

        slot = await self._strict_mutate(index_key, _allocate)
        await self._put_aux(observation_slot_key(key, slot), {
            "schema": AUX_SCHEMA,
            OBSERVATION_FIELD: canonical_json({
                "owner": key, "turn_id": turn_id, "conversation_id": str(conversation_id),
                "stored_at": now, "steps": kept,
            }),
        })
        return f"o{slot}:{turn_id}", {int(i) for i in kept}

    async def get_observation(
        self, user_id: str | None, observation_ref: str, step_index: int,
    ) -> dict[str, Any] | None:
        """One stored step observation of the caller's own answer, or None when the
        ref is malformed, the ring slot now holds a newer answer, or the step has none."""
        match = OBSERVATION_REF_RE.match(str(observation_ref or ""))
        if match is None:
            return None
        slot = int(match.group("slot"))
        if slot >= OBSERVATION_RING_SIZE:
            return None
        key = partition_key_for_user(user_id)
        payload = await self._get_aux(observation_slot_key(key, slot), OBSERVATION_FIELD)
        if not isinstance(payload, dict) or payload.get("owner") != key:
            return None
        if payload.get("turn_id") != match.group("turn"):
            return None
        steps = payload.get("steps") if isinstance(payload.get("steps"), dict) else {}
        step = steps.get(str(int(step_index)))
        if not isinstance(step, dict):
            return None
        return {**step, "stored_at": payload.get("stored_at"), "conversation_id": payload.get("conversation_id")}

    async def discard_observations(self, user_id: str | None, observation_ref: str) -> bool:
        """Blank one answer's ring slot again (its answer was never saved). Only the
        slot that still holds that answer is blanked: a ring that has since reused
        it for a newer answer is left alone. True when something was blanked."""
        match = OBSERVATION_REF_RE.match(str(observation_ref or ""))
        if match is None or int(match.group("slot")) >= OBSERVATION_RING_SIZE:
            return False
        key = partition_key_for_user(user_id)
        slot, turn_id = match.group("slot"), match.group("turn")
        index_key = observation_index_key(key)

        def _drop(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            payload = _load_row((current or {}).get(OBSERVATION_INDEX_FIELD)) or {}
            slots = payload.get("slots") if isinstance(payload.get("slots"), dict) else {}
            entry = slots.get(slot)
            if not isinstance(entry, dict) or entry.get("turn_id") != turn_id:
                return None, False
            slots.pop(slot, None)
            payload["slots"] = slots
            return {"schema": AUX_SCHEMA, OBSERVATION_INDEX_FIELD: canonical_json(payload)}, True

        if not await self._strict_mutate(index_key, _drop):
            return False
        stored = await self._get_aux(observation_slot_key(key, int(slot)), OBSERVATION_FIELD)
        if isinstance(stored, dict) and stored.get("turn_id") == turn_id:
            await self._blank(observation_slot_key(key, int(slot)))
        return True

    async def _clear_observations(self, partition_key: str) -> None:
        """Blank the owner's WHOLE observation ring and its index (every slot ever
        used, whatever conversation it names — a clear or a factory reset leaves no
        step observation behind, even one whose conversation was already gone).
        Best effort."""
        index_key = observation_index_key(partition_key)
        try:
            payload = await self._get_aux(index_key, OBSERVATION_INDEX_FIELD)
        except ChatHistoryUnavailable:
            payload = None
            used = OBSERVATION_RING_SIZE  # unknown: every slot
        else:
            counter = payload.get("next") if isinstance(payload, dict) else None
            used = min(OBSERVATION_RING_SIZE, counter) if isinstance(counter, int) and counter > 0 else 0
            slots = payload.get("slots") if isinstance(payload, dict) and isinstance(payload.get("slots"), dict) else {}
            listed = [int(s) for s in slots if str(s).isdigit() and int(s) < OBSERVATION_RING_SIZE]
            used = max([used, *(s + 1 for s in listed)])
        gate = self._cleanup_gate()

        async def _one(slot: int) -> None:
            async with gate:
                await self._blank(observation_slot_key(partition_key, slot))

        await asyncio.gather(*(_one(slot) for slot in range(used)))
        await self._blank(index_key)

    async def _scrub_observations(self, partition_key: str, conversation_ids: set[str]) -> None:
        """Blank the ring slots of removed conversations (best effort)."""
        if not conversation_ids:
            return
        index_key = observation_index_key(partition_key)
        payload = await self._get_aux(index_key, OBSERVATION_INDEX_FIELD)
        if not isinstance(payload, dict):
            return
        slots = payload.get("slots") if isinstance(payload.get("slots"), dict) else {}
        doomed = [s for s, v in slots.items()
                  if isinstance(v, dict) and v.get("conversation_id") in conversation_ids]
        if not doomed:
            return
        for slot in doomed:
            try:
                await self._blank(observation_slot_key(partition_key, int(slot)))
            except (TypeError, ValueError):
                continue

        def _drop(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            fresh = _load_row((current or {}).get(OBSERVATION_INDEX_FIELD)) or {}
            fresh_slots = fresh.get("slots") if isinstance(fresh.get("slots"), dict) else {}
            for slot in doomed:
                value = fresh_slots.get(slot)
                if isinstance(value, dict) and value.get("conversation_id") in conversation_ids:
                    fresh_slots.pop(slot, None)
            fresh["slots"] = fresh_slots
            return {"schema": AUX_SCHEMA, OBSERVATION_INDEX_FIELD: canonical_json(fresh)}, None

        await self._strict_mutate(index_key, _drop)

    # ------------------------------------------------------------------ #
    # Message presentation updates (D11: the saved report of an answer).
    # ------------------------------------------------------------------ #
    async def update_message_response(
        self, user_id: str | None, conversation_id: str, message_id: str, updates: dict[str, Any],
    ) -> bool:
        """Merge ``updates`` (response fields such as ``saved_report``) into one owned
        stored answer — its exchange document and its inline copy — without touching
        ``updated_at``. False when the answer is not owned or not in the row.

        An exchange-backed answer is never rewritten without its exchange record: an
        exchange document that cannot be READ raises :class:`ChatHistoryUnavailable`
        (nothing is written), and the inline copy always keeps the exchange marker and
        its ``truncated`` flag (a clipped question or answer stays restorable)."""
        key, doc = await self._partition_doc(user_id)
        cid, mid = str(conversation_id), str(message_id)
        conversation, _info = _decode_row(doc, cid)
        message = next((m for m in (conversation.messages if conversation else []) if m.id == mid), None)
        if message is None or message.role != "assistant":
            return False
        record = await self._load_exchange(key, mid, strict=True) if exchange_backed(message) else None
        full_stored: dict[str, Any] | None = None
        if record is not None:
            full = decode_response(record.response, role="assistant", content=record.assistant_content) or {}
            full.update(copy.deepcopy(updates))
            full_stored = encode_assistant_response(full, compact=False)[0]
            await self._write_exchange(key, replace(record, response=full_stored))

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            fresh = _decode_partition(current)
            row = fresh["conversations"].get(cid)
            messages = list(row.messages) if row is not None else []
            position = next((i for i, m in enumerate(messages) if m.id == mid), None)
            if row is None or position is None:
                return None, False
            target = messages[position]
            previous = target.response if isinstance(target.response, dict) else {}
            was_truncated = previous.get("truncated") is True
            backed = exchange_backed(target)
            if backed and full_stored is not None and record is not None:
                if _is_reduced(target):
                    return None, True  # a preview: reads restore it from the exchange document
                inline, reduced = encode_assistant_response(full_stored)
                inline = dict(inline or {})
                inline.pop("truncated", None)
                clipped = (
                    len(record.assistant_content) != len(target.content)
                    or len(record.user_content) > MAX_USER_MESSAGE_CHARS
                )
                if (
                    was_truncated or reduced or clipped or full_stored.get("truncated")
                    or not inline_is_complete(full_stored, inline)
                ):
                    inline["truncated"] = True
                inline[EXCHANGE_MARKER] = True
                stored_response: dict[str, Any] | None = inline
            else:
                # No exchange record (a pre-Round-12 answer, or its exchange document
                # is absent): update the inline copy, keeping its marker and flag.
                decoded = decode_response(target.response, role="assistant", content=target.content) or {}
                decoded.update(copy.deepcopy(updates))
                encoded, _ = encode_assistant_response(decoded)
                stored_response = dict(encoded or {})
                if backed:
                    stored_response[EXCHANGE_MARKER] = True
                if was_truncated:
                    stored_response["truncated"] = True
            messages[position] = target.model_copy(update={"response": stored_response})
            fresh["conversations"][cid] = row.model_copy(update={"messages": messages})
            return self._encode(fresh), True

        return await self._strict_mutate(key, _change)

    async def update(
        self,
        user_id: str | None,
        conversation_id: str,
        *,
        title: str | None = None,
        pinned: bool | None = None,
    ) -> ChatConversation | None:
        """Rename and/or pin one owned conversation in ONE write (SPEC §7.5 Pin).

        A rename moves the conversation to the top of the recency order, as before;
        pinning never changes ``updated_at``. Pinning an 11th conversation raises
        :class:`ChatPinLimitReached` and writes nothing. ``None`` when not owned.
        Returns the conversation's summary fields only (``messages`` is empty and
        ``earlier_message_count`` counts them): no transcript is read or restored."""
        key = partition_key_for_user(user_id)
        await self._partition_doc(user_id)  # a legacy shared history is migrated first
        cid = str(conversation_id)
        cleaned = " ".join(str(title).split()).strip()[:MAX_TITLE_CHARS] if title is not None else None
        requests: dict[str, Any] = {}

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, ChatConversation | None]:
            data = _decode_partition(current)
            requests.clear()
            requests.update(data["requests"])
            existing = data["conversations"].get(cid)
            if existing is None:
                return None, None
            updates: dict[str, Any] = {}
            if pinned is not None and bool(pinned) != existing.pinned:
                if pinned:
                    count = sum(1 for item in data["conversations"].values() if item.pinned)
                    if count >= MAX_PINNED_CONVERSATIONS:
                        raise ChatPinLimitReached(
                            f"At most {MAX_PINNED_CONVERSATIONS} conversations can be pinned."
                        )
                updates["pinned"] = bool(pinned)
            if cleaned:
                updates["title"] = cleaned
                updates["updated_at"] = iso_now()
            if not updates:
                return None, existing
            stored = existing.model_copy(update=updates)
            data["conversations"][cid] = stored
            return self._encode(data), stored

        stored = await self._strict_mutate(key, _change)
        if stored is None:
            return None
        live = await self._load_live(key)
        stored = _with_live_status(stored, _running_conversations({"requests": requests}, live), live)
        return stored.model_copy(update={"messages": [], "earlier_message_count": stored.message_count})

    async def rename(
        self, user_id: str | None, conversation_id: str, title: str
    ) -> ChatConversation | None:
        return await self.update(user_id, conversation_id, title=title)

    async def set_pinned(
        self, user_id: str | None, conversation_id: str, pinned: bool
    ) -> ChatConversation | None:
        return await self.update(user_id, conversation_id, pinned=pinned)

    async def set_report_id(
        self, user_id: str | None, conversation_id: str, report_id: str | None,
    ) -> bool:
        """Record (or clear) the conversation's draft report id (SPEC §9.1) without
        touching ``updated_at``. False when the conversation is not owned/retained."""
        key = partition_key_for_user(user_id)
        await self._partition_doc(user_id)
        cid = str(conversation_id)

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            data = _decode_partition(current)
            existing = data["conversations"].get(cid)
            if existing is None:
                return None, False
            data["conversations"][cid] = existing.model_copy(update={"report_id": report_id or None})
            return self._encode(data), True

        return await self._strict_mutate(key, _change)

    async def delete(self, user_id: str | None, conversation_id: str) -> bool:
        """Delete one owned conversation; its exchange, archive, summary,
        step-observation, feedback and live-state records are blanked afterwards."""
        key = partition_key_for_user(user_id)
        await self._partition_doc(user_id)
        cid = str(conversation_id)
        removed = _Removed()

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            removed.reset()
            data = _decode_partition(current)
            if cid not in data["conversations"]:
                return None, False
            removed.take(data, [data["conversations"].pop(cid)])
            data["archives"].pop(cid, None)
            # This count means retained + retention-evicted conversations, not a
            # lifetime audit counter. An explicit delete therefore decrements it,
            # while any prior retention gap remains intact.
            data["total_conversation_count"] = max(
                len(data["conversations"]),
                int(data.get("total_conversation_count", 0)) - 1,
            )
            data["requests"] = {
                key: value
                for key, value in data["requests"].items()
                if value.get("conversation_id") != cid
            }
            return self._encode(data), True

        deleted = await self._strict_mutate(key, _change)
        if deleted:
            await self._blank_removed(key, removed)
        return deleted

    async def clear(self, user_id: str | None) -> int:
        key, doc = await self._partition_doc(user_id)
        if not stored_conversation_rows(doc):
            return 0
        removed = _Removed()

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
            removed.reset()
            data = _decode_partition(current)
            removed.take(data, data["conversations"].values())
            return self._encode(_empty_partition()), len(removed.conversations)

        cleared = await self._strict_mutate(key, _change)
        await self._blank_removed(key, removed)
        await self._clear_observations(key)
        await self._blank(live_state_key(key))
        return cleared

    async def clear_all(self) -> int:
        """Factory-reset every registered hashed partition plus the legacy index,
        blanking every conversation's auxiliary documents and each owner's live
        state (Round 12)."""
        await self.wait_for_cleanup()
        index = await self._strict_get(CHAT_CONVERSATIONS_KEY) or {}
        keys = sorted({str(item) for item in (index.get("partitions") or [])})
        cleared = 0
        for key in keys:
            removed = _Removed()

            def _clear(current: dict[str, Any] | None, removed: _Removed = removed) -> tuple[dict[str, Any], int]:
                removed.reset()
                data = _decode_partition(current)
                removed.take(data, data["conversations"].values())
                return self._encode(_empty_partition()), len(removed.conversations)

            cleared += await self._strict_mutate(key, _clear)
            await self._blank_removed(key, removed)
            await self._clear_observations(key)
            await self._blank(live_state_key(key))

        def _clear_index(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            return {"schema": self._storage_form, "partitions": [], "conversations": {}}, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _clear_index, lock=self._index_lock
        )
        return cleared
