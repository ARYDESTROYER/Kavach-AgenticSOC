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
* **Mapping-safe partition (storage form 3).** On the Elasticsearch state backend
  every KV namespace shares ONE dynamically mapped config index (default limit 1,000
  fields). Form 2 keyed the partition by conversation id and idempotency key
  (``conversations.<cid>.messages.…``, ``requests.<key>.…``), so every new
  conversation or request minted ~20 new mapped fields until writes failed for
  every namespace. Form 3 stores each conversation and each request record as ONE
  opaque canonical-JSON string in two arrays (:data:`CONVERSATION_ROWS_KEY`,
  :data:`REQUEST_ROWS_KEY`): the document's field paths are a fixed handful whatever
  it holds, and no stored value (a date-like title, a mixed-type legacy table row)
  can ever conflict with a dynamic mapping. Reads still accept form 2 rows; the next
  write re-encodes them.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Literal, TypeVar

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

_T = TypeVar("_T")

MAX_CONVERSATIONS_PER_USER = 50
MAX_MESSAGES_PER_CONVERSATION = 100
MAX_CONVERSATION_BYTES = 256_000
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

_SCHEMA_VERSION = 3
_PARTITION_PREFIX = "user-"
# Storage form 3: one opaque canonical-JSON string per conversation / request record
# (see the module docstring). Distinct names, because the form 2 keys are already
# mapped as objects in existing Elasticsearch config indexes and a string array
# written to an object field would be refused.
CONVERSATION_ROWS_KEY = "chat_conversation_rows"
REQUEST_ROWS_KEY = "chat_request_rows"
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
_DERIVED_RESPONSE_KEYS: frozenset[str] = frozenset({
    "answer", "message_id", "conversation_id", "conversation_title",
})
# The decoded legacy ``table`` is rebuilt from this table block when the stored form
# dropped it (SPEC §7.5: not persisted when a table block carries the same rows).
_TABLE_BLOCK_KEY = "table_block"
_LEGACY_TABLE_PREVIEW = 50
_LEGACY_QUERY_CHARS = 4_000
# A user message's ``response`` carries only who authored it (SPEC §4.8 taint rules
# replay it), and only when that is not the default "user".
USER_ORIGINS: frozenset[str] = frozenset({"user", "follow_up", "starter", "command", "continue"})
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


@dataclass(frozen=True)
class ChatExchangeReservation:
    status: Literal["reserved", "completed"]
    idempotency_key: str
    conversation_id: str
    conversation: ChatConversation | None = None
    assistant_message: ChatConversationMessage | None = None
    conversation_title: str | None = None
    lease_token: str | None = None


def normalize_user_id(user_id: str | None) -> str:
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


def partition_key_for_user(user_id: str | None) -> str:
    """Opaque deterministic key; raw usernames never appear in KV document ids."""
    digest = hashlib.sha256(normalize_user_id(user_id).encode("utf-8")).hexdigest()
    return f"{_PARTITION_PREFIX}{digest}"


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
    response: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, bool]:
    """``(stored, truncated)``: the scalar whitelist plus one ``presentation_json``
    string. ``truncated`` says the presentation had to be cut beyond the standard
    storage form. A legacy (already stored) form round-trips unchanged."""
    if not isinstance(response, dict):
        return None, False
    stored: dict[str, Any] = {}
    presentation: dict[str, Any] = {}
    for key, value in response.items():
        if key in _DERIVED_RESPONSE_KEYS or key == PRESENTATION_KEY:
            continue
        if key in STORED_SCALAR_KEYS and _is_scalar(value):
            if key == "query":
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
        compact, reduced = compact_presentation(presentation)
        if compact:
            try:
                stored[PRESENTATION_KEY] = canonical_json(compact)
            except (TypeError, ValueError):
                reduced = True
    truncated = bool(stored.get("truncated") or reduced)
    if truncated:
        stored["truncated"] = True
    return stored, truncated


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
    out = {k: copy.deepcopy(v) for k, v in stored.items() if k != PRESENTATION_KEY}
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


def _drop_oldest_exchange(kept: list[ChatConversationMessage], sizes: list[int]) -> None:
    """Remove the oldest message and any assistant replies that would be orphaned."""
    kept.pop(0)
    sizes.pop(0)
    while kept and kept[0].role == "assistant" and len(kept) > 1:
        kept.pop(0)
        sizes.pop(0)


def _trim_messages(
    messages: list[ChatConversationMessage],
) -> tuple[list[ChatConversationMessage], bool]:
    """Bound one transcript: 100 messages, then :data:`MAX_CONVERSATION_BYTES`.

    Over the byte cap the OLDEST answers are downgraded first (blocks expired, step
    details stripped; their text kept); whole exchanges are dropped only when that is
    not enough, and never the newest exchange. Returns ``(kept, truncated)`` where
    ``truncated`` means messages were removed (a downgrade alone removes none)."""
    kept = list(messages[-MAX_MESSAGES_PER_CONVERSATION:])
    truncated = len(kept) < len(messages)
    sizes = [_message_size(m) for m in kept]
    total = sum(sizes) + 1
    if total <= MAX_CONVERSATION_BYTES:
        return kept, truncated
    protected = 2 if len(kept) >= 2 else len(kept)
    for index in range(len(kept) - protected):
        if total <= MAX_CONVERSATION_BYTES:
            break
        message = kept[index]
        if message.role != "assistant" or not message.response:
            continue
        downgraded = downgrade_stored_response(message.response)
        if downgraded == message.response:
            continue
        replacement = message.model_copy(update={"response": downgraded})
        size = _message_size(replacement)
        total += size - sizes[index]
        sizes[index] = size
        kept[index] = replacement
    while len(kept) > 2 and total > MAX_CONVERSATION_BYTES:
        before = len(kept)
        _drop_oldest_exchange(kept, sizes)
        total = sum(sizes) + 1
        truncated = truncated or len(kept) < before
    return kept, truncated


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


def _summary(conversation: ChatConversation) -> ChatConversationSummary:
    return ChatConversationSummary(**conversation.model_dump(exclude={"messages"}))


def _listing_order(rows: Iterable[ChatConversation]) -> list[ChatConversation]:
    """Pinned conversations first, then newest first (both by ``updated_at``)."""
    ordered = sorted(rows, key=lambda item: (item.updated_at, item.id), reverse=True)
    return [c for c in ordered if c.pinned] + [c for c in ordered if not c.pinned]


def _empty_partition() -> dict[str, Any]:
    """The DECODED form of an empty partition (store it with :func:`_encode_partition`)."""
    return {
        "schema": _SCHEMA_VERSION,
        "conversations": {},
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


def with_stored_rows(
    doc: Any,
    *,
    conversations: dict[str, dict[str, Any]] | None = None,
    requests: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """A copy of a partition document in storage form 3 with its raw rows replaced
    (``None`` keeps the document's own). For repair tools and tests that patch a row;
    the rows are written exactly as the store writes them."""
    base = copy.deepcopy(doc) if isinstance(doc, dict) else {}
    conv = stored_conversation_rows(base) if conversations is None else conversations
    reqs = stored_request_rows(base) if requests is None else requests
    for key in (_LEGACY_CONVERSATIONS_KEY, _LEGACY_REQUESTS_KEY):
        base.pop(key, None)
    base["schema"] = _SCHEMA_VERSION
    base[CONVERSATION_ROWS_KEY] = [
        canonical_json({**row, "id": cid}) for cid, row in conv.items() if isinstance(row, dict)
    ]
    base[REQUEST_ROWS_KEY] = [
        canonical_json({"key": key, "record": record}) for key, record in reqs.items()
        if isinstance(record, dict)
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


def _is_stale(value: Any) -> bool:
    timestamp = _parse_time(value)
    if timestamp is None:
        return True
    return (datetime.now(timezone.utc) - timestamp).total_seconds() >= (
        IDEMPOTENCY_PENDING_TTL_SECONDS
    )


def _normalize_conversation(raw: Any, cid: str) -> ChatConversation | None:
    try:
        conversation = ChatConversation.model_validate(raw)
    except Exception:  # noqa: BLE001 -- one corrupt row must not hide valid siblings
        return None
    messages = list(conversation.messages)
    retained = len(messages)
    total = max(int(conversation.total_message_count or 0), retained)
    return conversation.model_copy(update={
        "id": str(cid),
        "message_count": retained,
        "total_message_count": total,
        "history_truncated": bool(conversation.history_truncated or total > retained),
        "oldest_retained_at": messages[0].created_at if messages else None,
    })


def _decode_partition(doc: dict[str, Any] | None) -> dict[str, Any]:
    """Lenient: either storage form; a corrupt row is skipped, never fatal."""
    decoded = _empty_partition()
    if not isinstance(doc, dict):
        return decoded
    rows: dict[str, ChatConversation] = {}
    for cid, raw in stored_conversation_rows(doc).items():
        conversation = _normalize_conversation(raw, str(cid))
        if conversation is not None:
            rows[str(cid)] = conversation
    requests = stored_request_rows(doc)
    retained = len(rows)
    decoded.update({
        "conversations": rows,
        "requests": requests,
        "history_truncated": bool(doc.get("history_truncated", False)),
        "total_conversation_count": max(
            retained, int(doc.get("total_conversation_count", retained) or retained),
        ),
    })
    return decoded


def _encode_partition(data: dict[str, Any]) -> dict[str, Any]:
    """Storage form 3: every conversation and request record is ONE opaque string,
    so the document's mapped field paths never depend on what it holds."""
    return {
        "schema": _SCHEMA_VERSION,
        CONVERSATION_ROWS_KEY: [
            canonical_json(conversation.model_dump(mode="json"))
            for conversation in data["conversations"].values()
        ],
        REQUEST_ROWS_KEY: [
            canonical_json({"key": key, "record": record})
            for key, record in (data.get("requests") or {}).items()
            if isinstance(record, dict)
        ],
        "history_truncated": bool(data.get("history_truncated", False)),
        "total_conversation_count": max(
            len(data["conversations"]),
            int(data.get("total_conversation_count", 0) or 0),
        ),
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
    """A receipt's compact response: the scalar whitelist only (SPEC §7.5)."""
    if not isinstance(stored, dict):
        return None
    scalars = {k: v for k, v in stored.items() if k in STORED_SCALAR_KEYS and _is_scalar(v)}
    if content_clipped or PRESENTATION_KEY in stored:
        # Replayed from the receipt alone, the answer lacks its presentation.
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


class ChatConversationStore:
    """Strict CRUD and retry-safe sends over per-principal KV partitions."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._locks: dict[str, asyncio.Lock] = {}
        self._index_lock = asyncio.Lock()

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
        change: Callable[[dict[str, Any] | None], tuple[dict[str, Any], _T]],
        *,
        lock: asyncio.Lock | None = None,
    ) -> _T:
        async with (lock or self._lock_for(key)):
            for _attempt in range(CAS_RETRIES):
                current = await self._strict_get(key)
                expected = _rev(current)
                proposed, result = change(copy.deepcopy(current))
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
        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            doc = copy.deepcopy(current or {})
            partitions = {str(item) for item in (doc.get("partitions") or [])}
            partitions.add(partition_key)
            doc["schema"] = _SCHEMA_VERSION
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
            return _encode_partition(data), data

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
            doc["schema"] = _SCHEMA_VERSION
            return doc, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _cleanup, lock=self._index_lock
        )
        return migrated

    async def _load_partition(self, user_id: str | None) -> tuple[str, dict[str, Any]]:
        uid = normalize_user_id(user_id)
        key = partition_key_for_user(uid)
        current = await self._strict_get(key)
        if current is not None:
            return key, _decode_partition(current)
        legacy = await self._strict_get(CHAT_CONVERSATIONS_KEY)
        migrated = await self._migrate_legacy(uid, key, legacy or {})
        return key, migrated if migrated is not None else _empty_partition()

    async def _ensure_partition(self, user_id: str | None) -> tuple[str, dict[str, Any]]:
        key, data = await self._load_partition(user_id)
        await self._register_partition(key)
        return key, data

    async def list_page(
        self, user_id: str | None, *, limit: int = 30, offset: int = 0
    ) -> ChatHistoryPage:
        """Summaries with every pinned conversation first, then newest first."""
        _key, data = await self._load_partition(user_id)
        rows = _listing_order(data["conversations"].values())
        retained = len(rows)
        start = max(0, int(offset))
        end = start + max(0, int(limit))
        total_lifetime = max(retained, int(data.get("total_conversation_count", retained)))
        return ChatHistoryPage(
            conversations=[_summary(item) for item in rows[start:end]],
            total=retained,
            history_truncated=bool(
                data.get("history_truncated", False) or total_lifetime > retained
            ),
            total_conversation_count=total_lifetime,
            oldest_retained_at=min(
                (item.created_at for item in rows), default=None
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
        matched (``match.message_id`` is None for a title hit)."""
        needle = " ".join(str(query or "").split()).lower()[:MAX_SEARCH_CHARS]
        _key, data = await self._load_partition(user_id)
        rows = _listing_order(data["conversations"].values())
        hits: list[ChatConversationSearchHit] = []
        if needle:
            for conversation in rows:
                found = _match(conversation, needle)
                if found is not None:
                    hits.append(ChatConversationSearchHit(**_summary(conversation).model_dump(), match=found))
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
            oldest_retained_at=min((item.created_at for item in rows), default=None),
        )

    async def get(self, user_id: str | None, conversation_id: str) -> ChatConversation | None:
        """One owned conversation with decoded message responses."""
        _key, data = await self._load_partition(user_id)
        return _decoded(data["conversations"].get(str(conversation_id)))

    async def get_message(
        self, user_id: str | None, conversation_id: str, message_id: str,
    ) -> tuple[ChatConversation, ChatConversationMessage] | None:
        """``(conversation, decoded message)`` for one owned retained message (the
        reports package resolves "Add to report" through this, SPEC §9.2)."""
        conversation = await self.get(user_id, conversation_id)
        if conversation is None:
            return None
        message = next((m for m in conversation.messages if m.id == str(message_id)), None)
        return (conversation, message) if message is not None else None

    @staticmethod
    def _prune_requests(data: dict[str, Any]) -> None:
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
                    and _is_stale(value.get("updated_at"))
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
    ) -> tuple[ChatConversation | None, str | None]:
        rows: dict[str, ChatConversation] = dict(data["conversations"])
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
        if stored_response is not None and (
            user_truncated or assistant_truncated or response_truncated
        ):
            stored_response["truncated"] = True
        user_message = ChatConversationMessage(
            id=new_id("chatmsg-"),
            role="user",
            content=saved_user,
            created_at=now,
            response=encode_user_response(user_origin),
            idempotency_key=idempotency_key,
        )
        assistant_message = ChatConversationMessage(
            id=new_id("chatmsg-"),
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
        total_messages = max(existing.total_message_count, len(existing.messages)) + 2
        history_truncated = bool(
            existing.history_truncated
            or retention_truncated
            or user_truncated
            or assistant_truncated
            or response_truncated
        )
        preview, _ = _clip(assistant_content, MAX_PREVIEW_CHARS)
        updates: dict[str, Any] = {
            "messages": messages,
            "message_count": len(messages),
            "total_message_count": total_messages,
            "history_truncated": history_truncated,
            "oldest_retained_at": messages[0].created_at if messages else None,
            "preview": " ".join(preview.split()),
            "updated_at": now,
            "model": assistant_message.model or existing.model,
            "source_id": assistant_message.source_id
            if source_id is not None else existing.source_id,
            "source_name": assistant_message.source_name
            if source_name is not None else existing.source_name,
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
        unpinned = [item for item in rows.values() if not item.pinned]
        if len(unpinned) > MAX_CONVERSATIONS_PER_USER:
            # Pinned conversations are exempt (SPEC §7.5); the newest unpinned 50 stay.
            keep = sorted(
                unpinned, key=lambda item: (item.updated_at, item.id), reverse=True
            )[:MAX_CONVERSATIONS_PER_USER]
            kept_ids = {item.id for item in keep} | {item.id for item in rows.values() if item.pinned}
            rows = {cid: item for cid, item in rows.items() if cid in kept_ids}
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
        key, _data = await self._ensure_partition(user_id)
        cid = str(conversation_id or new_id("chat-"))
        now = iso_now()

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], ChatConversation | None]:
            data = _decode_partition(current)
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
            )
            return _encode_partition(data), stored

        return _decoded(await self._strict_mutate(key, _change))

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
            conversation=_decoded(conversation),
            assistant_message=_decoded_message(assistant),
            conversation_title=str(
                request.get("conversation_title")
                or (conversation.title if conversation else "Conversation")
            ),
        )

    async def reserve_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        conversation_id: str | None,
    ) -> ChatExchangeReservation:
        key, _data = await self._ensure_partition(user_id)
        cid = str(conversation_id or new_id("chat-"))
        now = iso_now()

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
                    return _encode_partition(data), self._completed_reservation(
                        data, request, idempotency_key=idempotency_key,
                        conversation_id=request_cid, now=now,
                    )
                if conversation_id is not None and request_cid not in rows:
                    raise ChatConversationMissing("conversation not found")
                if not _is_stale(request.get("updated_at")):
                    raise ChatRequestInProgress("This chat request is already in progress.")
                # A crashed worker's bounded lease may be reclaimed only by the exact
                # same request fingerprint and conversation target.
                lease_token = new_id("chatlease-")
                request["updated_at"] = now
                request["status"] = "in_progress"
                request["lease_token"] = lease_token
                data["requests"][idempotency_key] = request
                return _encode_partition(data), ChatExchangeReservation(
                    status="reserved",
                    idempotency_key=idempotency_key,
                    conversation_id=request_cid,
                    lease_token=lease_token,
                )

            if conversation_id is not None and conversation_id not in rows:
                raise ChatConversationMissing("conversation not found")

            lease_token = new_id("chatlease-")
            data["requests"][idempotency_key] = {
                "status": "in_progress",
                "fingerprint": request_fingerprint,
                "conversation_id": cid,
                "created_at": now,
                "updated_at": now,
                "lease_token": lease_token,
            }
            self._prune_requests(data)
            if len(data["requests"]) > MAX_IDEMPOTENCY_RECORDS:
                raise ChatRequestCapacityBusy(
                    "Too many chat requests are in progress; retry shortly."
                )
            return _encode_partition(data), ChatExchangeReservation(
                status="reserved",
                idempotency_key=idempotency_key,
                conversation_id=cid,
                lease_token=lease_token,
            )

        return await self._strict_mutate(key, _change)

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
        composer window; usage totals are incremented from ``response.usage``."""
        key, _data = await self._ensure_partition(user_id)
        now = iso_now()

        def _change(
            current: dict[str, Any] | None,
        ) -> tuple[dict[str, Any], ChatExchangeReservation]:
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if request is None or request.get("fingerprint") != request_fingerprint:
                raise ChatIdempotencyConflict("The chat reservation no longer matches.")
            if str(request.get("conversation_id") or "") != conversation_id:
                raise ChatIdempotencyConflict("The chat reservation target changed.")
            if request.get("status") == "completed":
                return _encode_partition(data), self._completed_reservation(
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
            )
            if conversation is None or assistant_id is None:
                raise ChatConversationMissing("conversation not found")
            assistant = next(item for item in conversation.messages if item.id == assistant_id)
            receipt_content, content_clipped = _clip(assistant.content, MAX_RECEIPT_CONTENT_CHARS)
            data["requests"][idempotency_key] = {
                **request,
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
            self._prune_requests(data)
            return _encode_partition(data), ChatExchangeReservation(
                status="completed",
                idempotency_key=idempotency_key,
                conversation_id=conversation_id,
                conversation=_decoded(conversation),
                assistant_message=_decoded_message(assistant),
                conversation_title=conversation.title,
                lease_token=lease_token,
            )

        return await self._strict_mutate(key, _change)

    async def abort_exchange(
        self,
        user_id: str | None,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        lease_token: str,
    ) -> None:
        key, _data = await self._load_partition(user_id)

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            data = _decode_partition(current)
            request = data["requests"].get(idempotency_key)
            if (
                request is not None
                and request.get("status") == "in_progress"
                and request.get("fingerprint") == request_fingerprint
                and request.get("lease_token") == lease_token
            ):
                data["requests"].pop(idempotency_key, None)
            return _encode_partition(data), None

        await self._strict_mutate(key, _change)

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
        :class:`ChatPinLimitReached` and writes nothing. ``None`` when not owned."""
        key, _data = await self._load_partition(user_id)
        cid = str(conversation_id)
        cleaned = " ".join(str(title).split()).strip()[:MAX_TITLE_CHARS] if title is not None else None

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], ChatConversation | None]:
            data = _decode_partition(current)
            existing = data["conversations"].get(cid)
            if existing is None:
                return _encode_partition(data), None
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
            stored = existing.model_copy(update=updates) if updates else existing
            data["conversations"][cid] = stored
            return _encode_partition(data), stored

        return _decoded(await self._strict_mutate(key, _change))

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
        key, _data = await self._load_partition(user_id)
        cid = str(conversation_id)

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], bool]:
            data = _decode_partition(current)
            existing = data["conversations"].get(cid)
            if existing is None:
                return _encode_partition(data), False
            data["conversations"][cid] = existing.model_copy(update={"report_id": report_id or None})
            return _encode_partition(data), True

        return await self._strict_mutate(key, _change)

    async def delete(self, user_id: str | None, conversation_id: str) -> bool:
        key, _data = await self._load_partition(user_id)
        cid = str(conversation_id)

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], bool]:
            data = _decode_partition(current)
            if cid not in data["conversations"]:
                return _encode_partition(data), False
            data["conversations"].pop(cid, None)
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
            return _encode_partition(data), True

        return await self._strict_mutate(key, _change)

    async def clear(self, user_id: str | None) -> int:
        key, data = await self._load_partition(user_id)
        count = len(data["conversations"])

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
            current_count = len(_decode_partition(current)["conversations"])
            return _encode_partition(_empty_partition()), current_count

        return await self._strict_mutate(key, _change) if count else 0

    async def clear_all(self) -> int:
        """Factory-reset every registered hashed partition plus the legacy index."""
        index = await self._strict_get(CHAT_CONVERSATIONS_KEY) or {}
        keys = sorted({str(item) for item in (index.get("partitions") or [])})
        cleared = 0
        for key in keys:
            def _clear(current: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
                count = len(_decode_partition(current)["conversations"])
                return _encode_partition(_empty_partition()), count

            cleared += await self._strict_mutate(key, _clear)

        def _clear_index(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            return {"schema": _SCHEMA_VERSION, "partitions": [], "conversations": {}}, None

        await self._strict_mutate(
            CHAT_CONVERSATIONS_KEY, _clear_index, lock=self._index_lock
        )
        return cleared
