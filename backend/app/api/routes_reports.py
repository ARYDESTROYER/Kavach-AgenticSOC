"""Chat REPORTS routes (chat revamp SPEC §9.2), auto-discovered by ``main.py``.

* ``GET    /api/reports``                 — the caller's reports (index rows).
* ``POST   /api/reports``                 — create an empty report.
* ``GET    /api/reports/{id}``            — one report with its items and summary.
* ``PATCH  /api/reports/{id}``            — title, template, order, notes, removals
                                            under ``expected_version``.
* ``DELETE /api/reports/{id}``            — strict tombstone under ``expected_version``.
* ``POST   /api/reports/add``             — add BY REFERENCE from a persisted Workspace
                                            answer (one block, or the whole answer).
* ``POST   /api/reports/{id}/summary``    — one AI summary call (``?dry_run=1``: the
                                            token/cost estimate, no call).
* ``POST   /api/reports/from-conversation`` — Round 12: save a whole Workspace
                                            conversation as a new report (D11).

Round 12 (SPEC D11) also saves a chat answer as a report when the final header asked
for one: :func:`save_answer_as_report` (called by the chat turn route after the answer
is persisted) resolves the stored answer through the same add path, expands Brief
sections into items and is idempotent per request key.

Every route is owner-scoped (``current_username``; the shared ``default`` bucket when
auth is off) and requires ``cases:read``, like Workspace chat itself. Every mutation
writes one ``ActionType.REPORT`` audit row (#2) to the execution audit, so Demo Mode
rows stay in the demo stack.

Security properties held here:

* **Add by reference only (#5, #9).** The server loads the block from the caller's own
  persisted Workspace conversation and re-validates it; a client never sends block
  JSON (``ReportAddRequest`` forbids extra fields). Case-scoped chat turns are never
  written to Workspace history, so case content cannot be added by construction.
* **One gateway call per summary (#6).** ``gateway.complete(Role.CHAT, …,
  surface="report")`` with the fixed ``REPORT_SUMMARY_SYSTEM`` over the deterministic
  §9.4 digest (#7: aggregates only, never raw rows; notes and titles fenced as
  untrusted, #9). An idempotency key, a per-report single-flight lock and a per-user
  token bucket bound repeat spend; Demo Mode is exempt from the bucket and costs $0.
* **Never #3.** Reports are presentation data; nothing here touches ``decide()``.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import math
import re
import time
import weakref
from dataclasses import dataclass, field
from typing import Any, Mapping, Union

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import __version__ as APP_VERSION
from ..agents.blocks import (
    FALLBACK_TEXT,
    MAX_MARKDOWN,
    is_expired_block,
)
from ..agents.chat_protocol import notice_for_failure, parse_report_summary, turn_error_code
from ..constants import MAX_REPORT_ITEMS, MAX_REPORTS_PER_USER, ActionType, Role
from ..engine.report_digest import bounded_digest, report_summary_messages
from ..llm.gateway import GatewayError, UsageReceipt, estimate_message_tokens
from ..models import (
    ChatResponse,
    ChatSavedReport,
    Report,
    ReportAddRequest,
    ReportCreateRequest,
    ReportDeleteRequest,
    ReportItem,
    ReportListEntry,
    ReportPatchRequest,
    ReportSummary,
    ReportSummaryEstimate,
    ReportSummaryRequest,
    StepUsage,
    TurnUsage,
)
from ..state import AppState
from ..stores.chat_conversations import (
    ChatHistoryUnavailable,
    normalize_user_id,
    partition_key_for_user,
)
from ..stores.reports import (
    ReportConversationDraftExists,
    ReportFull,
    ReportItemUnknown,
    ReportLimitReached,
    ReportNotFound,
    ReportOrderInvalid,
    ReportPatch,
    ReportStore,
    ReportStoreUnavailable,
    ReportVersionConflict,
    new_item_id,
)
from ..utils import iso_now
from .deps import current_username, get_state, require_permission, resolve_grants

logger = logging.getLogger("tlsoc.api.reports")

router = APIRouter(prefix="/api")

# Report ids are minted by the store (``rpt-<uuid hex>``). Anything else is treated as
# absent, so a crafted path such as ``index`` can never address the owner's index doc.
_REPORT_ID_RE = re.compile(r"^rpt-[A-Za-z0-9]{1,64}$")

# §9.2 per-user summary token bucket: 10 generations per rolling hour (Demo exempt).
SUMMARY_BUCKET_CAPACITY = 10
SUMMARY_BUCKET_WINDOW_S = 3600.0
# A summary reply is ≤ 1 200 chars + 5 short steps (≈ 400 tokens). The call keeps
# headroom above that (reasoning models spend output tokens before answering) but
# never inherits an unbounded per-role max.
SUMMARY_MIN_OUTPUT_TOKENS = 1_024
SUMMARY_MAX_OUTPUT_TOKENS = 4_000
SUMMARY_EXPECTED_OUTPUT_TOKENS = 400
# A summary call may take this many chat model steps' time (``chat_agent.
# model_step_timeout_s``): one bounded call over a larger prompt than a chat step.
SUMMARY_TIMEOUT_FACTOR = 2.0

# Summary failures speak about the SUMMARY (the chat-turn notices describe a partial
# answer, which a summary never is: nothing is stored on failure). The code and
# ``retryable`` still come from the shared failure classifier.
SUMMARY_FAILURE_MESSAGES: dict[str, str] = {
    "budget_blocked": "The AI budget is used up, so no summary was written. Raise the budget or try again later.",
    "breaker_open": "The AI provider is paused after repeated errors, so no summary was written. Try again shortly.",
    "provider_unavailable": "The AI provider is unavailable or not configured, so no summary was written.",
    "report_summary_timeout": "The summary took too long and was stopped. Try again.",
    "internal": "The summary could not be generated. Try again.",
}


# --------------------------------------------------------------------------- #
# Response models (documented in openapi.json; the web client reads these shapes).
# --------------------------------------------------------------------------- #
class ReportListResponse(BaseModel):
    """``GET /api/reports``: ``{reports: [...]}`` newest first, plus the cap."""

    reports: list[ReportListEntry] = Field(default_factory=list)
    total: int = Field(default=0, ge=0)
    limit: int = MAX_REPORTS_PER_USER


class ReportAddResponse(BaseModel):
    """``POST /api/reports/add``: the updated report and the item id. ``added`` is
    False when the same source was already in the report (idempotent add);
    ``created_report`` is True when this add created the conversation's draft."""

    report: Report
    item_id: str
    added: bool = True
    created_report: bool = False


class ReportDeleteResponse(BaseModel):
    """``DELETE /api/reports/{id}``."""

    ok: bool = True
    id: str


# --------------------------------------------------------------------------- #
# Plumbing.
# --------------------------------------------------------------------------- #
def _http(status: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def _not_found(code: str = "report_not_found", message: str = "Report not found.") -> HTTPException:
    # Ownership is indistinguishable from absence on purpose.
    return _http(404, code, message)


def _actor(owner: str) -> str:
    """Audit actor: the username, or ``default`` when auth is off (SPEC §5.2)."""
    return owner or "default"


def _check_report_id(report_id: str | None) -> str:
    if not isinstance(report_id, str) or not _REPORT_ID_RE.match(report_id):
        raise _not_found()
    return report_id


def _store(state: AppState) -> ReportStore:
    """The ACTIVE report store: ``AppState.reports`` is demo-switchable (the demo
    stack's store over its throwaway KV while Demo Mode is on), so Demo reports never
    reach the tenant KV and vanish with the demo."""
    store = getattr(state, "reports", None)
    if not isinstance(store, ReportStore):
        raise _http(503, "report_store_unavailable", "Reports are temporarily unavailable.")
    return store


def _map_store_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ReportNotFound):
        return _not_found()
    if isinstance(exc, ReportVersionConflict):
        return _http(409, "report_version_conflict", "This report changed elsewhere. Reload it.",
                     current_version=exc.current_version)
    if isinstance(exc, ReportFull):
        return _http(409, "report_full", str(exc), reason=exc.reason)
    if isinstance(exc, ReportLimitReached):
        return _http(409, "report_limit",
                     f"You have {MAX_REPORTS_PER_USER} reports. Delete a report in Reports to start another.")
    if isinstance(exc, ReportConversationDraftExists):
        return _http(409, "report_conversation_draft_exists", str(exc), report_id=exc.report_id)
    if isinstance(exc, ReportItemUnknown):
        return _http(422, "report_item_unknown", "The report does not hold that item.", item_ids=exc.ids[:40])
    if isinstance(exc, ReportOrderInvalid):
        return _http(422, "report_item_order_invalid", str(exc))
    return _http(503, "report_store_unavailable", "Reports are temporarily unavailable.")


_STORE_ERRORS = (
    ReportNotFound, ReportVersionConflict, ReportFull, ReportLimitReached,
    ReportConversationDraftExists, ReportItemUnknown, ReportOrderInvalid, ReportStoreUnavailable,
)


async def _audit(state: AppState, owner: str, summary: str, *, action: ActionType = ActionType.REPORT,
                 model: str | None = None) -> None:
    """One append-only row per mutation (#2). Ids and counts only: titles and notes
    are user text and stay in the report itself. An audit glitch never fails the
    mutation that already happened (the platform-wide convention)."""
    try:
        await state.audit.record(
            action_type=action, surface="report", actor=_actor(owner), model=model,
            result_summary=summary[:500],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("report audit write failed (%s)", exc)


async def _link_conversation(state: AppState, owner: str, conversation_id: str | None,
                             report_id: str | None) -> None:
    """Best effort: tell the chat store which report is a conversation's draft (the
    ``ChatConversationSummary.report_id`` field), when the store offers a setter. The
    report index stays the source of truth (``ReportStore.drafts_by_conversation``)."""
    if not conversation_id:
        return
    setter = getattr(state.chat_conversations, "set_report_id", None)
    if not callable(setter):
        return
    try:
        await setter(owner, conversation_id, report_id)
    except Exception as exc:  # noqa: BLE001 -- the report itself is already saved
        logger.info("conversation report link not updated (%s)", exc)


# --------------------------------------------------------------------------- #
# Reading a persisted Workspace answer (the add-by-reference source).
# --------------------------------------------------------------------------- #
def _field(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, Mapping) else getattr(obj, name, None)


def presentation_of(message: Any) -> dict[str, Any]:
    """The decoded presentation fields of a stored assistant message.

    SPEC §7.5 stores them as ONE opaque canonical-JSON string ``presentation_json``
    beside a scalar whitelist (``stores.chat_conversations.encode_assistant_response``).
    This adapter reads every form leniently, so it does not depend on whether the
    store hands back the stored or the decoded message: (1) a decoded or legacy
    ``response`` dict whose ``blocks``/``steps``/``usage`` sit at the top level;
    (2) ``response.presentation_json``; (3) a message-level ``presentation_json``.
    Like the store's own ``decode_response``, a top-level scalar wins over the same key
    inside the presentation; anything that does not decode to an object is ignored."""
    import json

    payload: dict[str, Any] = {}
    response = _field(message, "response")
    if isinstance(response, Mapping):
        payload.update({k: v for k, v in response.items() if k != "presentation_json"})
    for raw in (
        response.get("presentation_json") if isinstance(response, Mapping) else None,
        _field(message, "presentation_json"),
    ):
        if isinstance(raw, str) and raw:
            try:
                decoded = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if isinstance(decoded, dict):
                for key, value in decoded.items():
                    payload.setdefault(key, value)
    return payload


@dataclass
class _Answer:
    """One persisted assistant answer and the user question it answered.

    ``stored_truncated``: saved history cut this answer (text, presentation or both)
    for storage. ``presentation_lost``: the stored presentation held blocks but could
    not be read back, so only the plain text survived — adding it would silently drop
    those blocks (G4), so the add routes refuse instead."""

    message: Any
    question: str
    response: ChatResponse
    stored_truncated: bool
    presentation_lost: bool = False


def _resolve_answer(conversation: Any, message_id: str) -> _Answer | None:
    messages = list(_field(conversation, "messages") or [])
    for index, message in enumerate(messages):
        if _field(message, "id") != message_id:
            continue
        if _field(message, "role") != "assistant":
            return None
        question = ""
        for prior in reversed(messages[:index]):
            if _field(prior, "role") == "user":
                question = str(_field(prior, "content") or "")
                break
        payload = presentation_of(message)
        content = _field(message, "content")
        answer_text = content if isinstance(content, str) else str(payload.get("answer") or "")
        lost = False
        try:
            response = ChatResponse.model_validate({**payload, "answer": answer_text})
        except Exception:  # noqa: BLE001 -- the stored presentation drifted
            # A text-only answer loses nothing by degrading to its text; one that held
            # blocks would lose them silently, so it is marked and refused at add time.
            response = ChatResponse(answer=answer_text)
            blocks = payload.get("blocks")
            lost = isinstance(blocks, list) and len(blocks) > 0
        return _Answer(message, question, response, bool(payload.get("truncated")), lost)
    return None


def _all_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Top-level blocks then report leaves, in display order (block ids are unique
    across both within one stored answer)."""
    out: list[dict[str, Any]] = []
    for block in blocks:
        out.append(block)
        if block.get("type") == "report":
            for section in block.get("sections") or []:
                out.extend(leaf for leaf in (section or {}).get("blocks") or [] if isinstance(leaf, dict))
    return out


def _unusable(block: dict[str, Any]) -> bool:
    """A retention stub or the replay fallback that replaced an invalid stored block."""
    return is_expired_block(block) or (
        block.get("type") == "callout" and block.get("text") == FALLBACK_TEXT
        and block.get("provenance") == "code"
    )


# The effective window a tool reported is the trailing segment of the engine-written
# block caption (``blocks._caption``: truncation · basis · window), in the tool window
# label grammar: ``last 24h``, ``2026-10-01 00:00 → 2026-10-02 00:00 UTC``, ``all time``.
_CAPTION_WINDOW_RE = re.compile(r"^(last \d+[smhdw]|all time|.+ → .+)$")


def _caption_window(block: Any) -> str | None:
    caption = block.get("caption") if isinstance(block, dict) else None
    if not isinstance(caption, str):
        return None
    segments = [s.strip() for s in caption.split(" · ")]
    return next((s for s in reversed(segments) if _CAPTION_WINDOW_RE.match(s)), None)


def _window_of(params: Mapping[str, Any]) -> str | None:
    if isinstance(params.get("window"), str) and params["window"]:
        return params["window"]
    start, end = params.get("time_from"), params.get("time_to")
    if isinstance(start, str) and start:
        return f"{start} → {end if isinstance(end, str) and end else 'now'}"
    hours = params.get("window_hours")
    if isinstance(hours, (int, float)) and not isinstance(hours, bool) and hours > 0:
        return f"last {int(hours)}h"
    return None


# The chat tools that query the turn's log source (``effective_source_name``).
_LOG_TOOLS: frozenset[str] = frozenset({"search_logs", "log_stats"})


def _scope_for(answer: _Answer, conversation: Any, *, block: dict[str, Any] | None,
               demo: bool) -> dict[str, Any]:
    """SPEC §9.1 scope, captured SERVER-side at add time: the effective window and
    sources of the lookups behind the item, the model that wrote the answer, this
    build's version and whether it was Demo data.

    Window precedence: the effective window the tool stated in the block caption(s)
    (a section with differently windowed blocks lists each once), then a window chip
    on the producing step, then the conversation's composer window."""
    steps = [s for s in answer.response.steps if s.kind == "tool"]
    from_step = block.get("from_step") if isinstance(block, dict) else None
    if isinstance(from_step, int):
        relevant = [s for s in steps if s.index == from_step] or steps
    else:
        relevant = steps
    covered = [block] if block is not None else _all_blocks(list(answer.response.blocks))
    windows = list(dict.fromkeys(w for w in (_caption_window(b) for b in covered) if w))
    window = "; ".join(windows) if windows else None
    if window is None:
        window = next((w for w in (_window_of(s.params) for s in relevant) if w), None)
    if window is None:
        time_range = _field(conversation, "time_range")
        label = getattr(time_range, "label", None)
        window = label() if callable(label) else None
    sources: list[str] = []
    for step in relevant:
        for name in step.sources:
            if name and name not in sources:
                sources.append(name)
    # The turn's resolved log source is credited only when a lookup behind the item
    # actually searched logs (an older step that did not record its sources). Case,
    # metric, cost and knowledge lookups read the app's own store, never that feed.
    if (not sources and answer.response.effective_source_name
            and any(step.tool in _LOG_TOOLS for step in relevant)):
        sources.append(answer.response.effective_source_name)
    usage = answer.response.usage
    generated_by = (
        _field(answer.message, "model") or answer.response.effective_model
        or (usage.model if usage is not None else None)
    )
    return {
        "window": window,
        "sources": sources[:20],
        "generated_by": generated_by if isinstance(generated_by, str) else None,
        "app_version": APP_VERSION,
        "demo": demo,
    }


def _build_item(answer: _Answer, conversation: Any, *, conversation_id: str, message_id: str,
                block_id: str | None, demo: bool) -> ReportItem:
    """The first (or only) item of :func:`_build_items`."""
    return _build_items(answer, conversation, conversation_id=conversation_id,
                        message_id=message_id, block_id=block_id, demo=demo)[0]


def _build_items(answer: _Answer, conversation: Any, *, conversation_id: str, message_id: str,
                 block_id: str | None, demo: bool) -> list[ReportItem]:
    """Snapshot one stored block (or the whole answer as a ``section``) into report
    items. Raises 404 when the block never existed and 409 ``block_unavailable`` when
    it was trimmed or expired from saved history.

    A whole answer keeps ALL of its text (Round 12: answers are not truncated): the
    text is split into Markdown blocks on paragraph breaks, followed by the turn's
    blocks. When that is more than one section snapshot holds
    (``MAX_SECTION_BLOCKS``), the answer continues in further ``section`` items
    titled "(continued)", whose source block id is ``#<n>``; the first item keeps the
    whole-answer identity (block id ``None``)."""
    from ..agents.blocks import MAX_SECTION_BLOCKS
    from ..stores.reports import continuation_block_id

    blocks = list(answer.response.blocks)
    unavailable = _http(409, "block_unavailable",
                        "That result has expired from saved history; ask again to refresh it.")
    if answer.presentation_lost:
        raise _http(409, "block_unavailable",
                    "That answer could not be read back from saved history; ask again to refresh it.")
    if block_id is not None:
        block = next((b for b in _all_blocks(blocks) if b.get("id") == block_id), None)
        if block is None:
            if answer.stored_truncated:
                raise unavailable
            raise _not_found("block_not_found", "That block is not part of this answer.")
        if _unusable(block):
            raise unavailable
        item = ReportItem.model_validate({
            "id": new_item_id(), "kind": "block", "block": block, "note": None,
            "source": {"conversation_id": conversation_id, "message_id": message_id, "block_id": block_id},
            "scope": _scope_for(answer, conversation, block=block, demo=demo),
            "added_at": iso_now(),
        })
        # Re-validation (ReportItem → parse_persisted_blocks) replaces an unreadable
        # block with the fallback stub; never snapshot that as if it were the evidence.
        if _unusable(item.block):
            raise unavailable
        return [item]
    if any(_unusable(b) for b in _all_blocks(blocks)):
        raise unavailable
    parts = [*_text_blocks(answer.response.answer or "", prefix="answer"), *blocks]
    if not parts:
        raise _http(409, "block_unavailable", "This answer has nothing to add.")
    title = answer.question or "Answer"
    scope = _scope_for(answer, conversation, block=None, demo=demo)
    items: list[ReportItem] = []
    for part, start in enumerate(range(0, len(parts), MAX_SECTION_BLOCKS)):
        # Saved history cut this answer (its text carries "[truncated in saved
        # history]", or its presentation was reduced): every section says so (G4).
        snapshot = {"title": title if part == 0 else f"{title} (continued)",
                    "blocks": parts[start:start + MAX_SECTION_BLOCKS],
                    "truncated": answer.stored_truncated}
        items.append(ReportItem.model_validate({
            "id": new_item_id(), "kind": "section", "block": snapshot, "note": None,
            "source": {"conversation_id": conversation_id, "message_id": message_id,
                       "block_id": None if part == 0 else continuation_block_id(part + 1)},
            "scope": scope, "added_at": iso_now(),
        }))
    return items


# --------------------------------------------------------------------------- #
# Round 12: reports saved from chat (SPEC D11) and "Save conversation as report".
# --------------------------------------------------------------------------- #
# The answer text of a saved report, split into Markdown blocks this long at most.
_TEXT_CHUNK = MAX_MARKDOWN - 200


def report_id_for(owner: str | None, key: str, purpose: str) -> str:
    """A deterministic report id for one request (idempotency: the same key always
    names the same report, so a retried request never duplicates it)."""
    digest = hashlib.sha256(
        "\x00".join(("report", purpose, normalize_user_id(owner), str(key))).encode("utf-8")
    ).hexdigest()[:32]
    return f"rpt-{digest}"


def _text_blocks(text: str, *, prefix: str) -> list[dict[str, Any]]:
    """The answer text as Markdown blocks (split on paragraph breaks)."""
    text = (text or "").strip()
    chunks: list[str] = []
    while text:
        if len(text) <= _TEXT_CHUNK:
            chunks.append(text)
            break
        cut = text.rfind("\n\n", 0, _TEXT_CHUNK)
        if cut < _TEXT_CHUNK // 2:
            cut = text.rfind("\n", 0, _TEXT_CHUNK)
        if cut < _TEXT_CHUNK // 2:
            cut = _TEXT_CHUNK
        chunks.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    return [
        {"id": f"{prefix}{'' if i == 0 else f'-{i + 1}'}", "type": "markdown", "provenance": "ai", "text": chunk}
        for i, chunk in enumerate(chunks) if chunk
    ]


def _section_items(
    answer: _Answer, conversation: Any, *, title: str, blocks: list[dict[str, Any]],
    conversation_id: str, message_id: str, block_id: str, demo: bool,
) -> list[ReportItem]:
    """One or more ``section`` items (a section snapshot holds at most
    ``MAX_SECTION_BLOCKS`` blocks; a longer one continues in the next item)."""
    from ..agents.blocks import MAX_SECTION_BLOCKS

    out: list[ReportItem] = []
    usable = [b for b in blocks if isinstance(b, dict) and not _unusable(b)]
    for part, start in enumerate(range(0, len(usable), MAX_SECTION_BLOCKS)):
        group = usable[start:start + MAX_SECTION_BLOCKS]
        heading = title if part == 0 else f"{title} (continued)"
        source_block = block_id if part == 0 else f"{block_id[:44]}#{part + 1}"
        item = ReportItem.model_validate({
            "id": new_item_id(), "kind": "section",
            "block": {"title": heading, "blocks": group, "truncated": answer.stored_truncated},
            "source": {"conversation_id": conversation_id, "message_id": message_id,
                       "block_id": source_block[:48]},
            "scope": _scope_for(answer, conversation, block=None, demo=demo),
            "added_at": iso_now(),
        })
        out.append(item)
    return out


def items_for_answer(
    answer: _Answer, conversation: Any, *, conversation_id: str, message_id: str, demo: bool,
    expand_briefs: bool = True,
) -> list[ReportItem]:
    """The report items of one persisted answer (D11): its text as a "Summary"
    section, every Brief section as its own section (``expand_briefs``), and every
    other block as its own item. Expired and unreadable blocks are left out. Built
    server-side from the STORED answer only (the model never supplies block JSON)."""
    if answer.presentation_lost:
        return []
    items: list[ReportItem] = []
    text_blocks = _text_blocks(answer.response.answer or "", prefix="answer")
    if text_blocks:
        items.extend(_section_items(
            answer, conversation, title="Summary", blocks=text_blocks,
            conversation_id=conversation_id, message_id=message_id, block_id="answer", demo=demo,
        ))
    for block in answer.response.blocks:
        if not isinstance(block, dict) or _unusable(block):
            continue
        block_id = str(block.get("id") or "")
        if block.get("type") == "report" and expand_briefs:
            for section in block.get("sections") or []:
                if not isinstance(section, dict):
                    continue
                leaves: list[dict[str, Any]] = []
                summary = section.get("summary")
                section_id = str(section.get("id") or "section")
                if isinstance(summary, str) and summary.strip():
                    leaves.append({"id": f"{section_id}-summary"[:48], "type": "markdown",
                                   "provenance": "ai", "text": summary})
                leaves.extend(leaf for leaf in section.get("blocks") or [] if isinstance(leaf, dict))
                if not leaves:
                    continue
                items.extend(_section_items(
                    answer, conversation, title=str(section.get("heading") or "Section"),
                    blocks=leaves, conversation_id=conversation_id, message_id=message_id,
                    block_id=f"{block_id}.{section_id}", demo=demo,
                ))
            continue
        item = ReportItem.model_validate({
            "id": new_item_id(), "kind": "block", "block": block, "note": None,
            "source": {"conversation_id": conversation_id, "message_id": message_id, "block_id": block_id or None},
            "scope": _scope_for(answer, conversation, block=block, demo=demo),
            "added_at": iso_now(),
        })
        if not _unusable(item.block):
            items.append(item)
    return items


def _clean_title(value: Any, fallback: str) -> str:
    """A report title from untrusted text (a model header or a conversation title):
    display-safe plain text, single line, bounded (#9 — rendered as text, fenced as
    untrusted wherever it later reaches a model)."""
    from ..agents.blocks import display_text
    from ..constants import MAX_REPORT_TITLE_CHARS

    text = display_text(value if isinstance(value, str) else "", MAX_REPORT_TITLE_CHARS) if value else ""
    return text or display_text(fallback, MAX_REPORT_TITLE_CHARS) or "Untitled report"


def _clean_template(value: Any, default: str = "custom") -> str:
    from ..models import REPORT_TEMPLATE_NAMES

    return value if isinstance(value, str) and value in REPORT_TEMPLATE_NAMES else default


async def save_answer_as_report(
    state: AppState, owner: str, *, conversation_id: str, message_id: str,
    title: Any = None, template: Any = None, idempotency_key: str,
) -> ChatSavedReport | None:
    """D11: save one persisted Workspace answer as a NEW report, server-side —
    owner-scoped, strict CAS, Brief sections expanded into items, idempotent per
    request key (the same key returns the same report). ``None`` when the answer has
    nothing to save. Audited (#2). Raises the store errors (limit, unavailable) and
    :class:`ChatHistoryUnavailable`; the chat route reports each one to the user."""
    # Only this answer and its question are read (never the whole transcript).
    conversation = await _owned_exchange(state, owner, conversation_id, message_id)
    if conversation is None:
        return None
    answer = _resolve_answer(conversation, message_id)
    if answer is None:
        return None
    items = items_for_answer(
        answer, conversation, conversation_id=conversation_id, message_id=message_id,
        demo=bool(getattr(state, "demo_active", False)),
    )
    if not items:
        return None
    report, created = await _store(state).create_with_items(
        owner, title=_clean_title(title, str(_field(conversation, "title") or "")),
        template=_clean_template(template), items=items,
        # The chat request key already names one answer; the conversation is part of
        # the derivation so a key can never resolve to another conversation's report.
        report_id=report_id_for(owner, f"{conversation_id}\x00{idempotency_key}", "answer"),
    )
    if created:
        await _audit(
            state, owner,
            f"report created from chat: {report.id} items={len(report.items)} "
            f"skipped={max(0, len(items) - len(report.items))} "
            f"message={message_id} template={report.template}",
        )
    return ChatSavedReport(
        id=report.id, title=report.title, items=len(report.items),
        skipped=max(0, len(items) - len(report.items)) if created else 0,
    )


def _takes_strict(func: Any) -> bool:
    try:
        params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        return False
    return "strict" in params or any(p.kind is p.VAR_KEYWORD for p in params.values())


async def _owned_exchange(state: AppState, owner: str, conversation_id: str, message_id: str) -> Any:
    """The owned conversation holding only the answer ``message_id`` and its question
    (``ChatConversationStore.get_exchange``; ``None`` when not owned). A store
    without it falls back to the whole conversation. Read STRICTLY: every caller
    snapshots the answer into a report, so an exchange document that cannot be read
    raises :class:`ChatHistoryUnavailable` (a retryable 503) instead of handing back
    the stored preview as if it were the whole answer."""
    store = state.chat_conversations
    getter = getattr(store, "get_exchange", None)
    if callable(getter):
        if _takes_strict(getter):
            return await getter(owner, conversation_id, message_id, strict=True)
        return await getter(owner, conversation_id, message_id)
    return await store.get(owner, conversation_id)


class ReportFromConversationRequest(BaseModel):
    """``POST /api/reports/from-conversation``: save a whole Workspace conversation as
    a new report (each answer one section). ``idempotency_key`` makes a retry return
    the same report."""

    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]{1,128}$")
    title: str | None = Field(default=None, max_length=200)
    template: str | None = Field(default=None, max_length=40)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128,
                                        pattern=r"^[A-Za-z0-9._:-]+$")


class ReportFromConversationResponse(BaseModel):
    """The saved report, how many items it holds, how many answers did not fit
    (``skipped``) and whether this call created it (False: an idempotent replay)."""

    report: Report
    items: int = Field(ge=0)
    skipped: int = Field(default=0, ge=0)
    created: bool = True


@router.post("/reports/from-conversation", response_model=ReportFromConversationResponse)
async def report_from_conversation(
    body: ReportFromConversationRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ReportFromConversationResponse:
    """"Save conversation as report" (SPEC D11): every answer of one caller-owned
    Workspace conversation becomes one section (its question as the heading, then
    the answer text and blocks), in order, up to the report's item limit. The server
    resolves every item from the persisted conversation; nothing is client-supplied
    content. Case-scoped chat never enters Workspace history, so a case conversation
    can never be saved this way."""
    owner = current_username(request)
    try:
        # Only the oldest answers a report can hold are restored to full text: each
        # answer is at least one item and the report keeps MAX_REPORT_ITEMS.
        getter = state.chat_conversations.get
        conversation = await getter(
            owner, body.conversation_id, window=None, hydrate_first=2 * MAX_REPORT_ITEMS + 2,
            # Strict: an answer whose full text cannot be read is a retryable 503,
            # never its stored preview saved as the answer.
            **({"strict": True} if _takes_strict(getter) else {}),
        )
    except ChatHistoryUnavailable as exc:
        raise _http(503, "chat_history_unavailable", "Chat history is temporarily unavailable.") from exc
    if conversation is None:
        raise _not_found("conversation_not_found", "That conversation is not available.")
    demo = bool(getattr(state, "demo_active", False))
    items: list[ReportItem] = []
    answers = 0
    beyond = 0
    for message in list(_field(conversation, "messages") or []):
        if _field(message, "role") != "assistant":
            continue
        answers += 1
        if len(items) >= MAX_REPORT_ITEMS:
            beyond += 1  # cannot fit: counted as skipped, never restored or snapshotted
            continue
        answer = _resolve_answer(conversation, str(_field(message, "id")))
        if answer is None or answer.presentation_lost:
            continue
        blocks = [*_text_blocks(answer.response.answer or "", prefix="answer"),
                  *[b for b in answer.response.blocks if isinstance(b, dict)]]
        items.extend(_section_items(
            answer, conversation, title=answer.question or "Answer", blocks=blocks,
            conversation_id=body.conversation_id, message_id=str(_field(message, "id")),
            block_id="answer", demo=demo,
        ))
    if not items:
        raise _http(409, "report_empty", "This conversation has no answers to save.")
    key = body.idempotency_key
    report_id = None
    if key:
        # The key is bound to WHAT is saved: reusing it for another conversation,
        # title or template saves that request as its own report (never returns the
        # first request's report as if this one had been saved).
        report_id = report_id_for(owner, "\x00".join((
            body.conversation_id, body.title or "", body.template or "", key,
        )), "conversation")
    try:
        report, created = await _store(state).create_with_items(
            owner, title=_clean_title(body.title, str(_field(conversation, "title") or "")),
            template=_clean_template(body.template), items=items,
            report_id=report_id,
        )
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if created:
        await _audit(
            state, owner,
            f"report created from conversation: {report.id} items={len(report.items)} "
            f"answers={answers}",
        )
    return ReportFromConversationResponse(
        report=report, items=len(report.items),
        skipped=max(0, len(items) - len(report.items)) + beyond,
        created=created,
    )


# --------------------------------------------------------------------------- #
# Summary admission: single-flight per report + per-user token bucket.
# --------------------------------------------------------------------------- #
class TokenBucket:
    """A per-key token bucket (``capacity`` tokens refilled evenly over ``window_s``).
    Process-local, like the chat concurrency bounds; bounded to ``max_keys`` keys."""

    def __init__(self, capacity: int = SUMMARY_BUCKET_CAPACITY,
                 window_s: float = SUMMARY_BUCKET_WINDOW_S, *, clock: Any = time.monotonic,
                 max_keys: int = 4096) -> None:
        self.capacity = float(capacity)
        self.rate = float(capacity) / float(window_s)
        self.clock = clock
        self.max_keys = max_keys
        self._state: dict[str, tuple[float, float]] = {}

    def _level(self, key: str, now: float) -> float:
        tokens, stamp = self._state.get(key, (self.capacity, now))
        return min(self.capacity, tokens + (now - stamp) * self.rate)

    def take(self, key: str) -> float | None:
        """Consume one token; ``None`` when allowed, else the seconds until one is free."""
        now = float(self.clock())
        tokens = self._level(key, now)
        if tokens < 1.0:
            self._state[key] = (tokens, now)
            return max(1.0, (1.0 - tokens) / self.rate)
        self._state[key] = (tokens - 1.0, now)
        if len(self._state) > self.max_keys:
            # Forget the fullest bucket (it would refill to capacity anyway).
            fullest = max(self._state, key=lambda k: self._level(k, now))
            self._state.pop(fullest, None)
        return None

    def refund(self, key: str) -> None:
        """Give back a token for a call that was refused before any spend."""
        now = float(self.clock())
        self._state[key] = (min(self.capacity, self._level(key, now) + 1.0), now)


@dataclass
class SummaryGuard:
    """Process-local summary admission for one AppState."""

    bucket: TokenBucket = field(default_factory=TokenBucket)
    locks: dict[str, asyncio.Lock] = field(default_factory=dict)

    def lock_for(self, key: str) -> asyncio.Lock:
        lock = self.locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self.locks[key] = lock
        return lock

    def release(self, key: str) -> None:
        lock = self.locks.get(key)
        if lock is not None and not lock.locked():
            self.locks.pop(key, None)


_GUARDS: "weakref.WeakKeyDictionary[Any, SummaryGuard]" = weakref.WeakKeyDictionary()


def summary_guard(state: Any) -> SummaryGuard:
    """The summary guard of ``state`` (created on first use; dies with the state)."""
    guard = _GUARDS.get(state)
    if guard is None:
        guard = SummaryGuard()
        _GUARDS[state] = guard
    return guard


def _summary_model_cfg(state: AppState) -> Any:
    prefs = state.execution_prefs
    cfg = prefs.chat_model
    max_tokens = min(max(int(cfg.max_tokens or 0), SUMMARY_MIN_OUTPUT_TOKENS), SUMMARY_MAX_OUTPUT_TOKENS)
    return cfg.model_copy(update={"max_tokens": max_tokens})


def _gateway(state: AppState) -> Any:
    """The ACTIVE gateway: the chat engine's (demo-switchable, a frozen attribute per
    SPEC §4.7), so a Demo summary runs on the $0 demo gateway and its ledger."""
    engine = getattr(state, "chat_engine", None)
    return getattr(engine, "_gateway", None) or state.gateway


def _context_window(model: str) -> int | None:
    try:
        from ..llm.pricing import load_registry

        value = int((load_registry().get(model) or {}).get("context_window") or 0)
    except Exception:  # noqa: BLE001
        return None
    return value or None


async def _estimate_cost(gateway: Any, model: str, prompt: int, completion: int, *, demo: bool) -> float | None:
    if demo:
        from ..llm import gateway as gateway_module

        synthetic = getattr(gateway_module, "_demo_synthetic_cost", None)
        return float(synthetic(prompt, completion)) if callable(synthetic) else 0.0
    from ..llm.pricing import cost_for

    overlay = None
    resolver = getattr(gateway, "_effective_price_tuple", None)
    if callable(resolver):
        try:
            overlay = await resolver(model)
        except Exception:  # noqa: BLE001 -- the estimate falls back to the built-in rate
            overlay = None
    try:
        cost = float(cost_for(model, prompt, completion, overlay))
    except Exception:  # noqa: BLE001
        return None
    return cost if math.isfinite(cost) and cost >= 0 else None


# --------------------------------------------------------------------------- #
# Routes.
# --------------------------------------------------------------------------- #
@router.get("/reports", response_model=ReportListResponse)
async def list_reports(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ReportListResponse:
    """The caller's reports, newest first (no items; open one with GET by id)."""
    try:
        entries = await _store(state).list(current_username(request))
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    return ReportListResponse(reports=entries, total=len(entries))


@router.post("/reports", response_model=Report)
async def create_report(
    request: Request,
    body: ReportCreateRequest | None = Body(default=None),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Report:
    """Create an empty report. With ``conversation_id`` it becomes that (caller-owned)
    conversation's draft; a conversation has at most one (409 with its id)."""
    body = body or ReportCreateRequest()
    owner = current_username(request)
    if body.conversation_id is not None:
        try:
            exists = getattr(state.chat_conversations, "exists", None)
            owned = (
                await exists(owner, body.conversation_id) if callable(exists)
                else await state.chat_conversations.get(owner, body.conversation_id) is not None
            )
        except ChatHistoryUnavailable as exc:
            raise _http(503, "chat_history_unavailable", "Chat history is temporarily unavailable.") from exc
        if not owned:
            raise _not_found("conversation_not_found", "That conversation is not available.")
    try:
        report = await _store(state).create(
            owner, title=body.title, template=body.template, conversation_id=body.conversation_id,
        )
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    await _link_conversation(state, owner, report.conversation_id, report.id)
    await _audit(state, owner, f"report created: {report.id} (template={report.template})")
    return report


@router.post("/reports/add", response_model=ReportAddResponse)
async def add_to_report(
    body: ReportAddRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ReportAddResponse:
    """Add one block (``block_id``) or the whole answer (a ``section``) of a persisted
    Workspace answer the caller owns. The server resolves and snapshots the content;
    with no ``report_id`` the conversation's draft is used (created on first add)."""
    owner = current_username(request)
    if body.report_id is not None:
        _check_report_id(body.report_id)
    try:
        # Only the answer and its question are read (never the whole transcript).
        conversation = await _owned_exchange(state, owner, body.conversation_id, body.message_id)
    except ChatHistoryUnavailable as exc:
        raise _http(503, "chat_history_unavailable", "Chat history is temporarily unavailable.") from exc
    if conversation is None:
        raise _not_found("conversation_not_found", "That conversation is not available.")
    answer = _resolve_answer(conversation, body.message_id)
    if answer is None:
        raise _not_found("message_not_found", "That answer is not in this conversation.")
    item, *continuations = _build_items(
        answer, conversation, conversation_id=body.conversation_id, message_id=body.message_id,
        block_id=body.block_id, demo=bool(getattr(state, "demo_active", False)),
    )
    title = str(_field(conversation, "title") or "") or "Untitled report"
    try:
        outcome = await _store(state).add_item(
            owner, item, report_id=body.report_id,
            draft_conversation_id=body.conversation_id if body.report_id is None else None,
            draft_title=title, continuations=continuations,
        )
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if outcome.created_report:
        await _link_conversation(state, owner, body.conversation_id, outcome.report.id)
        await _audit(state, owner, f"report created: {outcome.report.id} (draft of {body.conversation_id})")
    if outcome.added:
        await _audit(
            state, owner,
            f"report item added: {outcome.report.id} item={outcome.item_id} kind={item.kind} "
            f"parts={1 + len(continuations)} "
            f"message={body.message_id} block={body.block_id or '-'} version={outcome.report.version}",
        )
    return ReportAddResponse(
        report=outcome.report, item_id=outcome.item_id, added=outcome.added,
        created_report=outcome.created_report,
    )


@router.get("/reports/{report_id}", response_model=Report)
async def get_report(
    report_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Report:
    _check_report_id(report_id)
    try:
        report = await _store(state).get(current_username(request), report_id)
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if report is None:
        raise _not_found()
    return report


@router.patch("/reports/{report_id}", response_model=Report)
async def patch_report(
    report_id: str,
    body: ReportPatchRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Report:
    """Title, template, item order, notes and removals in one strict-CAS write under
    ``expected_version`` (409 ``report_version_conflict`` with ``current_version``)."""
    _check_report_id(report_id)
    if all(getattr(body, name) is None for name in ("title", "template", "item_order", "notes", "remove_items")):
        raise _http(422, "report_patch_empty", "Nothing to change.")
    owner = current_username(request)
    patch = ReportPatch(
        title=body.title, template=body.template, item_order=body.item_order,
        notes=body.notes, remove_items=body.remove_items,
    )
    try:
        report = await _store(state).update(
            owner, report_id, expected_version=body.expected_version, patch=patch,
        )
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if report.version != body.expected_version:
        changed = [n for n in ("title", "template", "item_order", "notes", "remove_items")
                   if getattr(body, n) is not None]
        await _audit(
            state, owner,
            f"report updated: {report.id} fields={','.join(changed)} items={len(report.items)} "
            f"version={report.version}",
        )
    return report


@router.delete("/reports/{report_id}", response_model=ReportDeleteResponse)
async def delete_report(
    report_id: str,
    request: Request,
    body: ReportDeleteRequest | None = Body(default=None),
    expected_version: int | None = Query(default=None, ge=0),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ReportDeleteResponse:
    """Strict tombstone under ``expected_version`` (body, or the query parameter for
    clients whose DELETE cannot carry a body), then removal from the index."""
    _check_report_id(report_id)
    version = body.expected_version if body is not None else expected_version
    if version is None:
        raise _http(422, "report_expected_version_required", "expected_version is required.")
    owner = current_username(request)
    try:
        deleted = await _store(state).delete(owner, report_id, expected_version=version)
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if deleted.conversation_id:
        # It was that conversation's draft (also when this call only completed an
        # interrupted delete): the next "Add to report" starts a new one.
        await _link_conversation(state, owner, deleted.conversation_id, None)
    await _audit(state, owner, f"report deleted: {report_id}")
    return ReportDeleteResponse(ok=True, id=report_id)


@router.post(
    "/reports/{report_id}/summary",
    response_model=Union[Report, ReportSummaryEstimate],
    responses={
        200: {"description": "The report with its new summary, or with ``dry_run=1`` the "
                             "ReportSummaryEstimate (no model call)."},
    },
)
async def summarise_report(
    report_id: str,
    request: Request,
    body: ReportSummaryRequest | None = Body(default=None),
    dry_run: bool = Query(default=False),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Report | ReportSummaryEstimate:
    """Generate (or estimate) the AI executive summary: ONE ``gateway.complete`` call
    with ``surface="report"`` over the §9.4 digest, so exactly one UsageDoc. Repeats
    are bounded by the idempotency key (same key → the stored result, no call), a
    per-report single-flight lock (a concurrent second click → 409) and a per-user
    token bucket (10 per hour; Demo exempt). A report whose bounded digest could keep
    none of its items is refused (409 ``report_too_large_to_summarise``) before any
    spend, for the estimate too. Failure messages describe the summary, not a chat
    turn (:data:`SUMMARY_FAILURE_MESSAGES`)."""
    _check_report_id(report_id)
    owner = current_username(request)
    store = _store(state)
    demo = bool(getattr(state, "demo_active", False))
    expected = body.expected_version if body is not None else None
    key = body.idempotency_key if body is not None else None
    try:
        record = await store.get_record(owner, report_id)
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if record is None:
        raise _not_found()
    report = record.report
    if expected is not None and expected != report.version:
        raise _map_store_error(ReportVersionConflict(report.version))
    model_cfg = _summary_model_cfg(state)
    gateway = _gateway(state)

    if dry_run:
        digest = bounded_digest(report)
        if digest.empty:
            raise _too_large()
        messages = report_summary_messages(report, digest=digest.text)
        prompt = estimate_message_tokens(messages)
        expected_out = min(model_cfg.max_tokens, SUMMARY_EXPECTED_OUTPUT_TOKENS)
        money = ("models", "read") in await resolve_grants(request, [("models", "read")])
        cost = await _estimate_cost(gateway, model_cfg.model, prompt, expected_out, demo=demo) if money else None
        return ReportSummaryEstimate(
            prompt_tokens=prompt, max_output_tokens=model_cfg.max_tokens,
            total_tokens=prompt + expected_out, cost=cost, simulated=demo, model=model_cfg.model,
        )

    if key and record.summary_key == key and report.summary is not None:
        return report  # idempotent replay: the stored result, no model call
    if not report.items:
        raise _http(409, "report_empty", "Add something to the report before summarising it.")

    guard = summary_guard(state)
    lock_key = f"{partition_key_for_user(owner)}:{report_id}"
    lock = guard.lock_for(lock_key)
    if lock.locked():
        raise _http(409, "report_summary_in_progress", "A summary for this report is already being written.")
    try:
        async with lock:
            return await _generate_summary(
                state, store, owner, report_id, key=key, expected=expected, demo=demo,
                model_cfg=model_cfg, gateway=gateway, guard=guard,
            )
    finally:
        # Dropped once released so the lock table stays bounded; a request that
        # arrived meanwhile saw ``locked()`` above and got the 409.
        guard.release(lock_key)


def _too_large() -> HTTPException:
    return _http(409, "report_too_large_to_summarise",
                 "This report's content is too large to summarise. Remove some items and try again.")


async def _generate_summary(
    state: AppState, store: ReportStore, owner: str, report_id: str, *, key: str | None,
    expected: int | None, demo: bool, model_cfg: Any, gateway: Any, guard: SummaryGuard,
) -> Report:
    try:
        record = await store.get_record(owner, report_id)
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    if record is None:
        raise _not_found()
    report = record.report
    if expected is not None and expected != report.version:
        raise _map_store_error(ReportVersionConflict(report.version))
    if key and record.summary_key == key and report.summary is not None:
        return report
    if not report.items:
        raise _http(409, "report_empty", "Add something to the report before summarising it.")
    digest = bounded_digest(report)
    if digest.empty:
        # The bounded digest could keep none of the report's items: a call over it would
        # bill a summary of nothing and store it as current. Refused before any spend
        # (and before the caller's allowance is touched).
        raise _too_large()
    bucket_key = normalize_user_id(owner)
    if not demo:
        retry_after = guard.bucket.take(bucket_key)
        if retry_after is not None:
            seconds = int(math.ceil(retry_after))
            raise HTTPException(
                status_code=429,
                detail={"code": "report_summary_rate_limited",
                        "message": f"Summary limit reached ({SUMMARY_BUCKET_CAPACITY} per hour). Try again later.",
                        "retry_after": seconds},
                headers={"Retry-After": str(seconds)},
            )
    messages = report_summary_messages(report, digest=digest.text)
    receipt = UsageReceipt()
    step_timeout = getattr(getattr(state.execution_prefs, "chat_agent", None), "model_step_timeout_s", 30)
    timeout = float(step_timeout or 30) * SUMMARY_TIMEOUT_FACTOR
    try:
        result = await asyncio.wait_for(
            gateway.complete(Role.CHAT, messages, model_cfg, surface="report", usage_receipt=receipt),
            timeout=timeout,
        )
    except (GatewayError, asyncio.TimeoutError) as exc:
        if receipt.rows == 0 and not demo:
            guard.bucket.refund(bucket_key)  # refused before any spend: no charge to the bucket
        notice = notice_for_failure(exc)
        code = "report_summary_timeout" if isinstance(exc, asyncio.TimeoutError) else turn_error_code(notice)
        await _audit(state, owner, f"report summary failed: {report_id} ({code})", model=model_cfg.model)
        message = SUMMARY_FAILURE_MESSAGES.get(code, SUMMARY_FAILURE_MESSAGES["internal"])
        raise _http(504 if code == "report_summary_timeout" else 503, code, message,
                    retryable=notice.retryable) from exc
    model_name = receipt.model or getattr(result, "model", None) or model_cfg.model
    usage = TurnUsage.from_steps(
        [StepUsage(**receipt.step_usage_fields())],
        model=model_name, pricing_source=receipt.pricing_source or None,
        simulated=demo or bool(receipt.simulated), context_window=_context_window(model_name),
    )
    await _audit(
        state, owner,
        f"report summary model call: {report_id} tokens={usage.total_tokens} cost={usage.cost:.6f}",
        action=ActionType.PROMPT, model=model_name,
    )
    text, steps = parse_report_summary(getattr(result, "text", "") or "")
    if not text:
        raise _http(502, "report_summary_invalid", "The model returned no summary. Try again.")
    summary = ReportSummary(
        executive_summary=text, next_steps=steps, model=model_name, usage=usage,
        generated_at=iso_now(), based_on_version=report.version,
    )
    try:
        updated = await store.set_summary(owner, report_id, summary, idempotency_key=key)
    except _STORE_ERRORS as exc:
        raise _map_store_error(exc) from exc
    await _audit(
        state, owner,
        f"report summary generated: {report_id} based_on_version={report.version} "
        f"tokens={usage.total_tokens}",
        model=model_name,
    )
    return updated


__all__ = [
    "SUMMARY_FAILURE_MESSAGES",
    "ReportAddResponse",
    "ReportFromConversationRequest",
    "ReportFromConversationResponse",
    "ReportDeleteResponse",
    "ReportListResponse",
    "SummaryGuard",
    "TokenBucket",
    "items_for_answer",
    "presentation_of",
    "report_id_for",
    "router",
    "save_answer_as_report",
    "summary_guard",
]
