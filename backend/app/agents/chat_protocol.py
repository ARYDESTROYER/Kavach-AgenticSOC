"""The chat-agent protocol: reply parser, live-text state machine, history replay,
observation shaping and the turn notices.

Chat revamp SPEC §4.1/§4.1.1 (protocol and parser rules), §4.3 (history replay),
§4.2 (structural observation shrinking), §4.5 (notices) and §5.4.1 (the
app-knowledge interface the engine calls). The §4.8 taint ledger and indicator
validation live with the tool that sends values out
(``chat_tools.taint``); the engine owns one ledger per turn.

Everything here is PURE (no I/O, no model calls) so it is cheap to test with golden
fixtures and safe to share between the engine (``agents/chat.py``), the routes and
the Demo planner. The engine owns the loop; this module owns what the loop parses,
renders and decides from text.

The protocol is text JSON on purpose (provider-agnostic; no native tool calling):

* a TOOL step is exactly one JSON object, ``{"action": "tool", ...}`` or
  ``{"action": "tools", "calls": [...]}``;
* the FINAL step is a header line, a ``---ANSWER---`` line, then Markdown.

Models do not always follow it, so the parser is lenient where leniency is safe
(a ```json fence, a trailing header, plain prose as a final, the legacy
``{"answer", "needs_query"}`` shape) and strict where it is not (only a JSON-like
reply that does not parse costs a corrective call).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable, Literal, Mapping, Protocol, Sequence

from ..models import ChatTurn, Citation, ConsoleLink, TurnNotice
from .blocks import (
    ALLOWED_VIEWS,
    block_view,
    display_text,
    is_expired_block,
    parse_persisted_blocks,
)
from .chat_events import (
    ANSWER_SEPARATOR_RE,
    HISTORY_DIGEST_MAX_CHARS,
    HISTORY_MAX_CHARS,
    HISTORY_MAX_EXCHANGES,
)
from .prompts import fence_block, neutralise_markers

# --------------------------------------------------------------------------- #
# §4.1 / §4.1.1 the reply parser.
# --------------------------------------------------------------------------- #
ReplyKind = Literal["tools", "final", "invalid"]
_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# Header keys that mark a trailing JSON object as a misplaced header (§4.1.1(d)).
_HEADER_KEYS = frozenset({"blocks", "citations", "action"})
# How far back the trailing-object search looks (a bound on pathological input).
_TRAILING_ATTEMPTS = 64
_FENCE_OPEN_RE = re.compile(r"^\s*```[A-Za-z0-9_-]*[ \t]*\n?")
_FENCE_CLOSE_RE = re.compile(r"\n?[ \t]*```\s*$")
# A tool call input is model-chosen data; bound it so a runaway reply cannot carry a
# megabyte of "input" into a tool, a header or the audit row.
MAX_TOOL_INPUT_CHARS = 4_000
# The legacy tool every ``needs_query`` reply maps to (§4.7, §4.1.1(f)).
LEGACY_QUERY_TOOL = "search_logs"


INPUT_TOO_LARGE = "Input too large; the lookup was not run"


@dataclass(frozen=True)
class ToolCallRequest:
    """One tool call the model asked for (name and input are untrusted model data).
    ``refusal`` is set by the parser when the call must not run at all (an input over
    :data:`MAX_TOOL_INPUT_CHARS`): running it with an emptied input would answer a
    broader question than the one asked."""

    tool: str
    input: dict[str, Any]
    refusal: str | None = None


@dataclass
class ParsedReply:
    """What one model reply asked for.

    ``kind``: ``tools`` (``calls`` holds the requests), ``final`` (``answer`` is the
    Markdown body, ``header`` the final header or ``None``) or ``invalid`` (JSON-like
    but unusable: the engine may send ONE corrective message, §4.1.1(c)).
    ``shape`` says how it was recognised: ``separator`` (§4.1), ``json`` (a bare
    action object), ``trailing`` (§4.1.1(d)), ``prose`` (§4.1.1(c)) or ``legacy``
    (§4.1.1(f)). A legacy ``needs_query`` reply is ``tools`` with ``legacy_query`` set
    and its preamble in ``answer``."""

    kind: ReplyKind
    calls: list[ToolCallRequest] = field(default_factory=list)
    header: dict[str, Any] | None = None
    answer: str = ""
    shape: str = ""
    legacy_query: dict[str, Any] | None = None
    reason: str = ""

    @property
    def legacy(self) -> bool:
        return self.shape == "legacy"


def _normalise_newlines(text: str) -> str:
    return (text or "").replace("\r\n", "\n").replace("\r", "\n")


def _strip_code_fence(text: str) -> str:
    """``text`` without one surrounding ```json … ``` fence (if it has one)."""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    body = _FENCE_OPEN_RE.sub("", stripped, count=1)
    return _FENCE_CLOSE_RE.sub("", body, count=1).strip()


def _load_object(text: str) -> dict[str, Any] | None:
    """A JSON object from ``text`` (a ```json fence allowed): the whole text, else the
    first object that starts at a ``{`` and decodes cleanly. ``None`` otherwise."""
    candidate = _strip_code_fence(text)
    if not candidate:
        return None
    try:
        value = json.loads(candidate)
        return value if isinstance(value, dict) else None
    except ValueError:
        pass
    start = candidate.find("{")
    if start < 0:
        return None
    try:
        value, _end = json.JSONDecoder().raw_decode(candidate, start)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _is_json_like(text: str) -> bool:
    """§4.1.1(c): a reply that starts with ``{`` (after a code fence) or mentions an
    ``"action"`` key was MEANT to be protocol JSON."""
    stripped = _strip_code_fence(text) if text.strip().startswith("```") else text.strip()
    return stripped.startswith("{") or '"action"' in text


def _trailing_object(text: str) -> tuple[str, dict[str, Any]] | None:
    """§4.1.1(d): a JSON object at the very END of ``text`` whose keys include
    ``blocks``, ``citations`` or ``action`` → ``(text_before_it, object)``."""
    body = text.rstrip()
    if body.endswith("```"):
        body = body[:-3].rstrip()
    if not body.endswith("}"):
        return None
    decoder = json.JSONDecoder()
    position = len(body)
    for _ in range(_TRAILING_ATTEMPTS):
        position = body.rfind("{", 0, position)
        if position < 0:
            return None
        try:
            value, end = decoder.raw_decode(body, position)
        except ValueError:
            continue
        if body[end:].strip():
            continue
        if isinstance(value, dict) and _HEADER_KEYS & set(value):
            prefix = body[:position].rstrip()
            # Drop a dangling ```json opener left before the object.
            prefix = re.sub(r"\n?[ \t]*```[A-Za-z0-9_-]*[ \t]*$", "", prefix).rstrip()
            return prefix, value
        return None
    return None


def input_too_large(value: Any) -> bool:
    """True when a model-chosen input is over :data:`MAX_TOOL_INPUT_CHARS`."""
    try:
        return len(json.dumps(value, default=str)) > MAX_TOOL_INPUT_CHARS
    except (TypeError, ValueError):
        return True


def _object_sequence(text: str) -> list[dict[str, Any]] | None:
    """Two or more JSON objects separated only by whitespace (and nothing else), or
    ``None``. A model that writes two action objects on separate lines instead of
    one ``tools`` batch must not lose the first to the trailing-object rule."""
    decoder = json.JSONDecoder()
    objects: list[dict[str, Any]] = []
    position = 0
    while position < len(text) and len(objects) <= _TRAILING_ATTEMPTS:
        while position < len(text) and text[position] in " \t\n":
            position += 1
        if position >= len(text):
            break
        try:
            value, position = decoder.raw_decode(text, position)
        except ValueError:
            return None
        if not isinstance(value, dict):
            return None
        objects.append(value)
    return objects if len(objects) >= 2 and position >= len(text) else None


def _bounded_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or input_too_large(value):
        return {}
    return {str(k): v for k, v in value.items()}


def _call_request(name: str, value: Any) -> ToolCallRequest:
    if isinstance(value, dict) and input_too_large(value):
        return ToolCallRequest(tool=name, input={}, refusal=INPUT_TOO_LARGE)
    return ToolCallRequest(tool=name, input=_bounded_input(value))


def _tool_calls(obj: dict[str, Any]) -> list[ToolCallRequest] | None:
    """The calls of a ``tool``/``tools`` action (``None`` when the shape is wrong)."""
    action = str(obj.get("action") or "").strip().lower()
    raw: list[Any]
    if action == "tool":
        raw = [{"tool": obj.get("tool"), "input": obj.get("input")}]
    elif action == "tools":
        raw = obj.get("calls") if isinstance(obj.get("calls"), list) else []
    else:
        return None
    calls = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = item.get("tool")
        if not isinstance(name, str) or not _TOOL_NAME_RE.match(name.strip()):
            continue
        calls.append(_call_request(name.strip(), item.get("input")))
    return calls or None


def _from_object(obj: dict[str, Any], *, shape: str, body: str | None = None) -> ParsedReply:
    """Classify one parsed JSON object (a header, a bare action or a legacy reply)."""
    action = obj.get("action")
    if isinstance(action, str):
        verb = action.strip().lower()
        if verb in ("tool", "tools"):
            calls = _tool_calls(obj)
            if not calls:
                return ParsedReply(kind="invalid", shape=shape, reason="bad_tool_call")
            return ParsedReply(kind="tools", calls=calls, shape=shape)
        if verb == "final":
            answer = body if body is not None else obj.get("answer")
            return ParsedReply(
                kind="final", header=obj, shape=shape,
                answer=answer if isinstance(answer, str) else "",
            )
        return ParsedReply(kind="invalid", shape=shape, reason="unknown_action")
    if isinstance(obj.get("answer"), str):
        # §4.1.1(f) legacy: {"answer": ...} with no action is a final; a truthy
        # needs_query with a dict query is a search_logs call (gated by grants/scopes).
        if obj.get("needs_query") and isinstance(obj.get("query"), dict):
            return ParsedReply(
                kind="tools", shape="legacy", answer=obj["answer"], header=obj,
                legacy_query=dict(obj["query"]),
                calls=[_call_request(LEGACY_QUERY_TOOL, obj["query"])],
            )
        return ParsedReply(kind="final", shape="legacy", answer=obj["answer"], header=obj)
    if body is not None and _HEADER_KEYS & set(obj):
        # A header without "action" but with final keys, followed by a body.
        return ParsedReply(kind="final", header=obj, shape=shape, answer=body)
    return ParsedReply(kind="invalid", shape=shape, reason="no_action")


def parse_reply(text: str) -> ParsedReply:
    """Parse one model reply by the §4.1.1 rules:

    (a) split on the FIRST separator line BEFORE any JSON extraction; the header is
        parsed only from the text before it (a ```json fence is allowed);
    (c) no separator and no parseable action JSON → the whole text is the final
        (``answer_kind`` conversation, no blocks); ``invalid`` (corrective) only when
        the text is JSON-like but unusable;
    (d) a trailing JSON object whose keys include ``blocks``/``citations``/``action``
        is stripped from the body and used as the header when none was found;
    (f) the legacy shapes. ((b) is :class:`AnswerStreamer`; (e) is the engine's
        ``finish_reason`` check.)

    With a separator the reply is a final unless its header is a well-formed TOOL
    action: a body after a broken or missing header is still a usable answer, and
    re-asking would cost a whole model call."""
    text = _normalise_newlines(text)
    match = ANSWER_SEPARATOR_RE.search(text)
    if match is not None:
        header_text = text[: match.start()]
        body = text[match.end():]
        if body.startswith("\n"):
            body = body[1:]
        header = _load_object(header_text) if header_text.strip() else None
        if header is not None:
            parsed = _from_object(header, shape="separator", body=body)
            if parsed.kind == "tools" and not parsed.legacy:
                return parsed
            if parsed.kind == "final" and parsed.shape == "separator":
                return parsed
            if parsed.legacy:
                # A legacy object before a separator: the body is the answer.
                return ParsedReply(kind="final", shape="separator", answer=body, header=None)
        trailing = _trailing_object(body)
        if trailing is not None and header is None:
            prefix, obj = trailing
            parsed = _from_object(obj, shape="trailing", body=prefix)
            if parsed.kind == "final":
                return parsed
        return ParsedReply(kind="final", shape="separator", answer=body, header=None)

    stripped = text.strip()
    if not stripped:
        return ParsedReply(kind="invalid", shape="empty", reason="empty")
    whole = None
    candidate = _strip_code_fence(stripped)
    if candidate.startswith("{"):
        try:
            value = json.loads(candidate)
            whole = value if isinstance(value, dict) else None
        except ValueError:
            whole = None
    if whole is not None:
        return _from_object(whole, shape="json")
    if candidate.startswith("{"):
        sequence = _object_sequence(candidate)
        if sequence is not None:
            # Several action objects back to back: one batch when every one is a
            # tool action (none is silently dropped), else a corrective.
            calls: list[ToolCallRequest] = []
            for obj in sequence:
                parsed = _from_object(obj, shape="json")
                if parsed.kind != "tools" or parsed.legacy:
                    return ParsedReply(kind="invalid", shape="json", reason="multiple_objects")
                calls.extend(parsed.calls)
            return ParsedReply(kind="tools", calls=calls, shape="json")
    trailing = _trailing_object(text)
    if trailing is not None:
        prefix, obj = trailing
        parsed = _from_object(obj, shape="trailing", body=prefix)
        if parsed.kind in ("final", "tools"):
            return parsed
    if candidate.startswith("{"):
        # Starts like an action object but is not one whole object: maybe one object
        # followed by chatter. Accept only a well-formed TOOL action from it.
        obj = _load_object(candidate)
        if obj is not None:
            parsed = _from_object(obj, shape="json")
            if parsed.kind == "tools":
                return parsed
        return ParsedReply(kind="invalid", shape="json", reason="unparseable")
    if _is_json_like(text):
        return ParsedReply(kind="invalid", shape="prose", reason="json_like")
    return ParsedReply(kind="final", shape="prose", answer=text.strip())


# --------------------------------------------------------------------------- #
# §4.1.1(b) the Live text state machine.
# --------------------------------------------------------------------------- #
class AnswerStreamer:
    """Turns the deltas of ONE model reply into the answer text to stream.

    Nothing is emitted until the header has parsed as ``action: final`` (or the reply
    opened with the separator itself): a tool step, a broken reply or plain prose is
    buffered silently, so a client never sees text that the parser would then
    discard. The separator is "matched" only once its whole line has arrived (the
    newline after it), which is what the ``len(separator) + 8`` hold-back of the spec
    amounts to: the tail of the buffer that could still turn out to be (or not be) a
    separator line is never decided early. After the match, body text streams as it
    arrives. ``streamed`` is everything emitted, for the engine's ``text.reset``
    check against the final parse."""

    def __init__(self) -> None:
        self._buffer = ""
        self._cr_pending = False
        self._state: Literal["header", "body", "silent"] = "header"
        self._body_start = 0
        self._emitted = 0
        # Where the separator search resumes: every COMPLETE line before this was
        # already ruled out, so each delta re-scans only the unfinished last line
        # (linear, not quadratic, in a long header-less reply).
        self._scan_from = 0

    @property
    def state(self) -> str:
        return self._state

    @property
    def streamed(self) -> str:
        return self._buffer[self._body_start:self._body_start + self._emitted] if self._state == "body" else ""

    def _append(self, delta: str) -> None:
        if self._cr_pending:
            delta = "\r" + delta
            self._cr_pending = False
        if delta.endswith("\r"):
            delta, self._cr_pending = delta[:-1], True
        self._buffer += delta.replace("\r\n", "\n").replace("\r", "\n")

    def _decide(self, *, final: bool) -> None:
        match = ANSWER_SEPARATOR_RE.search(self._buffer, self._scan_from)
        if match is None:
            self._scan_from = self._buffer.rfind("\n") + 1
            return
        line_complete = match.end() < len(self._buffer)
        if not line_complete and not final:
            return  # "---ANSWER---" may still continue on this line
        header_text = self._buffer[: match.start()]
        if header_text.strip():
            header = _load_object(header_text)
            action = str(header.get("action") or "").strip().lower() if header else ""
            if action != "final":
                self._state = "silent"
                return
        self._state = "body"
        self._body_start = min(len(self._buffer), match.end() + (1 if line_complete else 0))

    def _pending(self) -> str:
        start = self._body_start + self._emitted
        out = self._buffer[start:]
        self._emitted += len(out)
        return out

    def feed(self, delta: str) -> str:
        """Add one delta; return the text to stream now (``""`` for none)."""
        if not isinstance(delta, str) or not delta:
            return ""
        self._append(delta)
        if self._state == "header":
            self._decide(final=False)
        return self._pending() if self._state == "body" else ""

    def finish(self) -> str:
        """End of the reply: decide a separator on the last line, flush the body."""
        if self._cr_pending:
            self._cr_pending = False
            self._buffer += "\n"
        if self._state == "header":
            self._decide(final=True)
        return self._pending() if self._state == "body" else ""


# --------------------------------------------------------------------------- #
# §4.3 history replay.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PriorExchange:
    """One retained earlier exchange the caller replays into the prompt.

    The route builds these from the persisted Workspace conversation (its stored
    presentation: ``steps`` and ``blocks`` as persisted, positions intact) or, for
    stateless and case-scoped calls, from the client ``history`` (text only).
    ``origin`` is who authored ``user`` (only ``"user"`` counts for the indicator
    taint rule, §4.8); ``message_id`` is the assistant message id (``continue_of``)."""

    user: str = ""
    answer: str = ""
    message_id: str | None = None
    steps: tuple[Any, ...] = ()
    blocks: tuple[Any, ...] = ()
    origin: str = "user"

    @classmethod
    def from_turns(cls, turns: Iterable[ChatTurn | Mapping[str, Any]] | None) -> list["PriorExchange"]:
        """Pair a flat ``role``/``content`` history into exchanges (a user turn without
        a reply, or a reply without a prompt, is still one exchange)."""
        out: list[PriorExchange] = []
        pending: str | None = None
        for turn in turns or ():
            role = getattr(turn, "role", None) if not isinstance(turn, Mapping) else turn.get("role")
            content = getattr(turn, "content", None) if not isinstance(turn, Mapping) else turn.get("content")
            text = content if isinstance(content, str) else ""
            if role == "assistant":
                out.append(cls(user=pending or "", answer=text))
                pending = None
            else:
                if pending is not None:
                    out.append(cls(user=pending, answer=""))
                pending = text
        if pending is not None:
            out.append(cls(user=pending, answer=""))
        return out

    @classmethod
    def from_messages(cls, messages: Iterable[Any] | None) -> list["PriorExchange"]:
        """Pair persisted conversation messages (``ChatConversationMessage`` or dicts
        with ``role``, ``content``, ``id`` and the decoded ``response``)."""
        out: list[PriorExchange] = []
        pending: tuple[str, str] | None = None
        for message in messages or ():
            get = message.get if isinstance(message, Mapping) else (lambda k, m=message: getattr(m, k, None))
            role, content = get("role"), get("content")
            text = content if isinstance(content, str) else ""
            if role == "assistant":
                response = get("response") if isinstance(get("response"), Mapping) else {}
                steps = response.get("steps") if isinstance(response.get("steps"), list) else []
                blocks = response.get("blocks") if isinstance(response.get("blocks"), list) else []
                user, origin = pending if pending is not None else ("", "user")
                out.append(cls(user=user, answer=text, message_id=get("id"),
                               steps=tuple(steps), blocks=tuple(blocks), origin=origin))
                pending = None
            else:
                if pending is not None:
                    out.append(cls(user=pending[0], answer="", origin=pending[1]))
                origin = get("origin")
                pending = (text, origin if isinstance(origin, str) else "user")
        if pending is not None:
            out.append(cls(user=pending[0], answer="", origin=pending[1]))
        return out


def select_replay(
    exchanges: Sequence[PriorExchange],
    *,
    max_exchanges: int = HISTORY_MAX_EXCHANGES,
    max_chars: int = HISTORY_MAX_CHARS,
) -> list[PriorExchange]:
    """The newest ``max_exchanges`` exchanges whose user + answer text fits in
    ``max_chars`` (oldest dropped first). Applied identically to server history and
    to client ``history`` (SPEC §4.3)."""
    kept = list(exchanges)[-max(0, max_exchanges):] if max_exchanges > 0 else []
    while kept and sum(len(e.user) + len(e.answer) for e in kept) > max_chars:
        kept.pop(0)
    return kept


def _step_dict(step: Any) -> dict[str, Any]:
    if isinstance(step, Mapping):
        return dict(step)
    dump = getattr(step, "model_dump", None)
    return dump(mode="json") if callable(dump) else {}


def _digest_value(value: Any) -> str:
    return display_text(value, 60) if not isinstance(value, bool) else ("true" if value else "false")


def lookup_digest(key: str, steps: Iterable[Any], *, limit: int = HISTORY_DIGEST_MAX_CHARS) -> str:
    """``m3: log_stats(source=wazuh-prod, from=now-24h, group_by=source.ip) → 1,284
    events; …`` built from STORED tool steps (engine template + display chips). The
    values are untrusted (the caller fences the digest). Bounded to ``limit``."""
    parts: list[str] = []
    for raw in steps:
        step = _step_dict(raw)
        if step.get("kind", "tool") != "tool" or not isinstance(step.get("tool"), str):
            continue
        params = {}
        for source in (step.get("params"), step.get("untrusted_params")):
            if isinstance(source, Mapping):
                params.update({str(k): v for k, v in source.items()})
        args = ", ".join(f"{display_text(k, 40)}={_digest_value(v)}" for k, v in params.items() if v not in (None, ""))
        status = step.get("status") if isinstance(step.get("status"), str) else "ok"
        summary = display_text(step.get("summary"), 160)
        outcome = summary if status == "ok" else f"{status}" + (f": {summary}" if summary else "")
        parts.append(f"{step['tool']}({args}) → {outcome}".strip())
    if not parts:
        return ""
    text = f"Lookups {key}: " + "; ".join(parts)
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def block_listing(key: str, blocks: Sequence[dict[str, Any]], *, limit: int = 12) -> list[str]:
    """``m3.b1 hbar "Top source IPs" views=[hbar,bar,donut,table]`` per retained,
    non-expired DATA block (positions are the persisted ones, so the refs stay
    stable). Model-written prose and callouts are not listed (nothing to re-view)."""
    lines: list[str] = []
    for position, block in enumerate(blocks, start=1):
        if len(lines) >= limit:
            break
        if not isinstance(block, dict) or is_expired_block(block) or not block.get("artifact_kind"):
            continue
        kind = block.get("artifact_kind")
        views = [v for v in block.get("allowed_views") or [] if v in ALLOWED_VIEWS.get(kind, ())]
        title = display_text(block.get("title"), 80).replace('"', "'")
        lines.append(f'{key}.b{position} {block_view(block) or kind} "{title}" views=[{",".join(views)}]')
    return lines


@dataclass
class ReplayResult:
    """Prompt messages for the retained history plus the stored blocks addressable as
    ``mK.bJ`` (``{"m3": [block, …]}``) and the ``mK`` key of each message id."""

    messages: list[dict[str, str]] = field(default_factory=list)
    stored: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    keys_by_message_id: dict[str, str] = field(default_factory=dict)
    exchanges: list[PriorExchange] = field(default_factory=list)


PRIOR_DIGEST_INTRO = "Lookups and blocks of {key} (engine digest; the values are untrusted data):"


def render_replay(exchanges: Sequence[PriorExchange]) -> ReplayResult:
    """§4.3 replay: user turns verbatim as individual ``role=user`` messages (forged
    markers neutralised); each assistant answer as ``role=assistant`` inside the
    UNTRUSTED fence (``source=prior_answer``), followed by a fenced engine digest of
    its lookups and its stored data-block ids (``mK.bJ``). ``K`` numbers the retained
    assistant messages oldest → newest."""
    result = ReplayResult(exchanges=list(exchanges))
    for position, exchange in enumerate(exchanges, start=1):
        key = f"m{position}"
        if exchange.user:
            result.messages.append({"role": "user", "content": neutralise_markers(exchange.user)})
        blocks = parse_persisted_blocks(list(exchange.blocks)) if exchange.blocks else []
        if blocks:
            result.stored[key] = blocks
        if exchange.message_id:
            result.keys_by_message_id[str(exchange.message_id)] = key
        parts = [fence_block(exchange.answer or "", source="prior_answer")]
        digest = lookup_digest(key, exchange.steps)
        listing = block_listing(key, blocks)
        if digest or listing:
            parts.append(PRIOR_DIGEST_INTRO.format(key=key))
            parts.append(fence_block("\n".join([d for d in [digest] if d] + listing), source="prior_lookups"))
        result.messages.append({"role": "assistant", "content": "\n".join(parts)})
    return result


# --------------------------------------------------------------------------- #
# §4.2 structural observation shrinking.
# --------------------------------------------------------------------------- #
OBSERVATION_FLOOR_CHARS = 1_500
# Keys whose list is illustrative sample data beside an aggregate. ``rows`` is NOT
# one: for a tool such as ``audit_search`` the rows ARE the answer, so they shrink
# like any other ranked list (newest kept) instead of vanishing in the first pass.
_SAMPLE_KEYS = ("sample_rows", "samples", "sample", "examples", "sample_events")
OMITTED_KEY = "_omitted"
SHRUNK_KEY = "_shrunk_for_prompt"
OLDEST_DROPPED_KEY = "oldest_points_dropped"
OBSERVATION_TOO_LARGE = "Observation omitted: too large for one prompt"
# A series axis start and its step, as the tools spell them (``soc_metrics`` trends:
# ``first_bucket`` + ``bucket_minutes``; ``log_stats``: ``over_time.start`` +
# ``interval``). When the oldest points are dropped the start moves with them, so
# the arrays and their start keep describing the same buckets.
_SERIES_START_KEYS = (("first_bucket", "bucket_minutes"), ("start", "interval"))
_INTERVAL_RE = re.compile(r"^(\d{1,6})([smhdw])$")
_INTERVAL_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3_600, "d": 86_400, "w": 604_800}
_ISO_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$")
# Time keys that mark a list of objects as chronological (oldest → newest).
_CHRONO_KEYS = ("t", "ts", "at", "time", "timestamp", "date", "bucket")


def observation_budget(observation_chars: int, calls: int) -> int:
    """Per-call characters: ``observation_chars // calls`` with a 1 500 floor."""
    return max(OBSERVATION_FLOOR_CHARS, int(observation_chars) // max(1, calls))


def observation_size(observation: Any) -> int:
    """The serialised size the fence will carry (``fence_block`` uses
    ``json.dumps(ensure_ascii=True)``, so non-ASCII counts as its escape)."""
    try:
        return len(json.dumps(observation, default=str, ensure_ascii=True))
    except (TypeError, ValueError):
        return len(str(observation))


def _lists(value: Any, path: tuple[Any, ...] = ()) -> Iterable[tuple[tuple[Any, ...], list[Any]]]:
    if isinstance(value, dict):
        for key, item in value.items():
            if key == OMITTED_KEY:
                continue
            yield from _lists(item, path + (key,))
    elif isinstance(value, list):
        yield path, value
        for index, item in enumerate(value):
            yield from _lists(item, path + (index,))


def _dicts(value: Any, path: tuple[Any, ...] = ()) -> Iterable[tuple[tuple[Any, ...], dict[str, Any]]]:
    if isinstance(value, dict):
        yield path, value
        for key, item in value.items():
            if key != OMITTED_KEY:
                yield from _dicts(item, path + (key,))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _dicts(item, path + (index,))


def _path_label(path: tuple[Any, ...]) -> str:
    return ".".join(str(p) for p in path if not isinstance(p, int)) or "items"


def _is_number(item: Any) -> bool:
    return isinstance(item, (int, float)) and not isinstance(item, bool)


def _is_series_values(items: list[Any]) -> bool:
    """A list of numbers (gaps as ``null``): a time series's values. Tools emit them
    oldest → newest, never ranked, so they shrink from the OLD end."""
    return bool(items) and all(item is None or _is_number(item) for item in items)


def _is_time_axis(items: list[Any]) -> bool:
    return bool(items) and all(isinstance(item, str) and _ISO_TIME_RE.match(item) for item in items)


def _chronological(items: list[Any]) -> bool:
    """A list of timestamps, or of objects sharing a time key, ordered oldest →
    newest (a newest-first list such as audit rows is ranked like a top-N and keeps
    its head)."""
    if len(items) < 2:
        return False
    if _is_time_axis(items):
        return items[0] < items[-1] and all(a <= b for a, b in zip(items, items[1:]))
    if not all(isinstance(item, dict) for item in items):
        return False
    for key in _CHRONO_KEYS:
        values = [item.get(key) for item in items]
        if all(isinstance(v, str) for v in values) or all(_is_number(v) for v in values):
            return values[0] < values[-1] and all(a <= b for a, b in zip(values, values[1:]))
    return False


def _parse_time(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed


def _advance_series_start(parent: dict[str, Any], dropped: int, *, ambiguous: bool = False) -> None:
    """Move the series start in ``parent`` forward by ``dropped`` buckets. A start the
    engine cannot advance (unknown step or format, or one shared by series of
    different lengths) becomes ``null`` rather than stay pointing at buckets that are
    no longer in the arrays."""
    for start_key, step_key in _SERIES_START_KEYS:
        start = parent.get(start_key)
        if not isinstance(start, str):
            continue
        if ambiguous:
            parent[start_key] = None
            continue
        step = parent.get(step_key)
        seconds: int | None = None
        if _is_number(step) and step > 0:
            seconds = int(step * 60) if step_key == "bucket_minutes" else int(step)
        elif isinstance(step, str) and (match := _INTERVAL_RE.match(step.strip())):
            seconds = int(match.group(1)) * _INTERVAL_UNIT_SECONDS[match.group(2)]
        parsed = _parse_time(start)
        if seconds and parsed is not None:
            parent[start_key] = (parsed + timedelta(seconds=seconds * dropped)).isoformat()
        else:
            parent[start_key] = None


@dataclass
class _ShrinkUnit:
    """One thing the shrinker can halve: a ranked list (keeps its head) or a group of
    equal-length series arrays in one object (shrunk TOGETHER, keeping the newest
    tail, so the arrays stay aligned with each other and with their start key)."""

    path: tuple[Any, ...]
    lists: list[tuple[str, list[Any]]]
    parent: dict[str, Any] | None = None
    keep_tail: bool = False
    shared_start: bool = False  # the parent holds other series groups too

    @property
    def length(self) -> int:
        return len(self.lists[0][1])

    def size(self) -> int:
        return sum(observation_size(items) for _label, items in self.lists)


def _shrink_units(value: dict[str, Any]) -> list[_ShrinkUnit]:
    units: list[_ShrinkUnit] = []
    grouped: set[int] = set()
    for path, parent in _dicts(value):
        by_length: dict[int, list[tuple[str, list[Any]]]] = {}
        for key, item in parent.items():
            if key in (OMITTED_KEY, SHRUNK_KEY) or not isinstance(item, list) or len(item) < 2:
                continue
            if _is_series_values(item) or all(isinstance(v, str) for v in item):
                by_length.setdefault(len(item), []).append((_path_label(path + (key,)), item))
        has_start = any(isinstance(parent.get(k), str) for k, _step in _SERIES_START_KEYS)
        first_unit = len(units)
        for members in by_length.values():
            # Parallel arrays need at least one numeric member; a lone string list is
            # a plain ranked list handled below.
            if not any(_is_series_values(items) for _label, items in members):
                continue
            has_axis = any(_is_time_axis(items) for _label, items in members)
            has_labels = any(not _is_series_values(items) and not _is_time_axis(items)
                             for _label, items in members)
            grouped.update(id(items) for _label, items in members)
            # Numbers beside a time axis or a series start (or alone) are a time
            # series: keep the newest tail. Numbers beside plain labels are a ranked
            # label/value pair: keep the head. Either way they shrink together.
            series = has_axis or has_start or not has_labels
            units.append(_ShrinkUnit(path=path, lists=members, parent=parent if series else None,
                                     keep_tail=series))
        series_here = [u for u in units[first_unit:] if u.parent is not None]
        for unit in series_here:
            unit.shared_start = len(series_here) > 1
    for path, items in _lists(value):
        if len(items) > 1 and id(items) not in grouped:
            units.append(_ShrinkUnit(path=path, lists=[(_path_label(path), items)],
                                     keep_tail=_chronological(items)))
    return units


def shrink_observation(observation: Any, budget: int) -> tuple[dict[str, Any], bool]:
    """Fit ``observation`` into ``budget`` characters STRUCTURALLY (never by cutting
    characters, so it stays valid JSON): drop sample rows first, then repeatedly
    halve the largest shrinkable unit — a ranked list keeps its head (top-N, newest
    first), a chronological list or a group of parallel series arrays keeps its
    NEWEST tail, shrunk together with its start moved forward so the arrays stay
    aligned — then drop the largest top-level keys, and as a last resort keep only a
    fixed engine note. What was removed is recorded under ``_omitted`` (counts and
    key names, engine-built) so the model can say the data was partial. Returns
    ``(observation, shrunk)``."""
    try:
        value = json.loads(json.dumps(observation if isinstance(observation, dict) else {"value": observation},
                                      default=str, ensure_ascii=False))
    except (TypeError, ValueError):
        value = {"value": str(observation)}
    if observation_size(value) <= budget:
        return value, False
    omitted: dict[str, Any] = {}

    def fits() -> bool:
        value[OMITTED_KEY] = omitted
        value[SHRUNK_KEY] = True
        return observation_size(value) <= budget

    # 1. Sample rows go first: they are the least aggregated part.
    for path, items in list(_lists(value)):
        if path and path[-1] in _SAMPLE_KEYS and items:
            omitted[_path_label(path)] = omitted.get(_path_label(path), 0) + len(items)
            items.clear()
    if fits():
        return value, True
    # 2. Halve the largest unit until everything fits or nothing is left to halve.
    for _ in range(400):
        units = _shrink_units(value)
        if not units:
            break
        unit = max(units, key=lambda u: (u.size(), -len(u.path)))
        keep = unit.length // 2
        dropped = unit.length - keep
        for label, items in unit.lists:
            if unit.keep_tail:
                del items[:dropped]
                oldest = omitted.setdefault(OLDEST_DROPPED_KEY, {})
                oldest[label] = oldest.get(label, 0) + dropped
            else:
                del items[keep:]
                omitted[label] = omitted.get(label, 0) + dropped
        if unit.parent is not None:
            _advance_series_start(unit.parent, dropped, ambiguous=unit.shared_start)
        if fits():
            return value, True
    # 3. Drop the largest top-level keys.
    dropped_keys: list[str] = []
    while True:
        keys = [k for k in value if k not in (OMITTED_KEY, SHRUNK_KEY)]
        if not keys:
            break
        largest = max(keys, key=lambda k: observation_size(value[k]))
        value.pop(largest)
        dropped_keys.append(display_text(largest, 40))
        omitted["keys"] = dropped_keys
        if fits():
            return value, True
    return {"note": OBSERVATION_TOO_LARGE, SHRUNK_KEY: True}, True


# --------------------------------------------------------------------------- #
# §4.5 notices.
# --------------------------------------------------------------------------- #
NOTICE_MESSAGES: dict[str, str] = {
    "budget": "The AI budget limit has been reached, so no answer was generated.",
    "breaker": "The AI provider is paused after repeated failures. Try again shortly.",
    "provider_config": "The AI model is not configured or its key was rejected.",
    "provider_down": "The AI provider is unavailable right now. Try again shortly.",
    "partial": "The answer may be incomplete because a step failed.",
    "length": "Answer cut at the output limit",
    "timeout": "Stopped at the time limit; this shows what was found so far.",
    "cap": "Reached this turn's lookup limit; the answer uses the results gathered so far.",
    "cancelled": "Stopped.",
    "unsupported": "Chat cannot read that data. Use the linked console page instead.",
    "denied": "Some lookups were not run because they need permissions you do not have.",
    # A POLICY refusal (a private/reserved/internal indicator, a value that did not
    # come from the analyst or this turn's evidence, an invalid kind): no grant would
    # help, so the notice must not send the analyst to ask for one. Same wire kind
    # ("denied": "Some lookups were not allowed"), so older clients keep working.
    "policy": ("Some lookups were not run because policy does not allow them: private or "
               "internal values, and values that did not come from you or this turn's results, "
               "are never sent to outside services."),
    "denied_policy": ("Some lookups were not run: some need permissions you do not have, and "
                      "policy does not allow the others."),
    "not_saved": "Not saved to the case thread",
}


def make_notice(key: str, *, retryable: bool | None = None) -> TurnNotice:
    """A notice from the engine templates (``key`` is a NOTICE_MESSAGES key)."""
    kind = {"provider_config": "provider", "provider_down": "provider", "length": "partial",
            "policy": "denied", "denied_policy": "denied"}.get(key, key)
    default_retry = key in ("breaker", "provider_down", "partial", "timeout")
    return TurnNotice(kind=kind, message=NOTICE_MESSAGES[key],
                      retryable=default_retry if retryable is None else retryable)


def notice_for_failure(exc: BaseException) -> TurnNotice:
    """§4.5 mapping: BudgetBlocked → budget; BreakerOpen → breaker; not_configured/
    unauthenticated → provider (not retryable); quota/unavailable → provider
    (retryable); a step timeout → timeout; anything else (incl. a stream that broke
    mid-answer) → partial. BudgetBlocked is checked first: it is a GatewayError
    subclass, like BreakerOpen."""
    from ..llm.gateway import BreakerOpen, BudgetBlocked

    if isinstance(exc, BudgetBlocked):
        return make_notice("budget")
    if isinstance(exc, BreakerOpen):
        return make_notice("breaker")
    if isinstance(exc, TimeoutError):
        return make_notice("timeout")
    failure = str(getattr(exc, "failure_class", "") or "")
    if failure in ("not_configured", "unauthenticated"):
        return make_notice("provider_config")
    if failure in ("quota", "unavailable", "unsupported"):
        return make_notice("provider_down")
    if not failure and isinstance(exc, Exception) and str(exc).endswith(" API key not configured"):
        return make_notice("provider_config")
    return make_notice("partial")


# The ``turn.error`` code (SPEC §6.2) a route reports for a notice kind.
TURN_ERROR_CODE_FOR_NOTICE: dict[str, str] = {
    "budget": "budget_blocked",
    "breaker": "breaker_open",
    "provider": "provider_unavailable",
}


def turn_error_code(notice: TurnNotice | None) -> str:
    return TURN_ERROR_CODE_FOR_NOTICE.get(notice.kind if notice else "", "internal")


# --------------------------------------------------------------------------- #
# §5.4.1 the app-knowledge interface the engine calls (implemented by the app
# knowledge package; the engine works without it).
# --------------------------------------------------------------------------- #
@dataclass
class FallbackAnswer:
    """A deterministic ($0) product-help answer: extractive text from the bundled
    Help Center, its ``D*`` citations and console links (``allowed`` resolved from
    the caller's grants), and optional engine-built blocks (a ``guide``)."""

    answer: str
    citations: list[Citation] = field(default_factory=list)
    console_links: list[ConsoleLink] = field(default_factory=list)
    blocks: list[dict[str, Any]] = field(default_factory=list)
    notice: TurnNotice | None = None
    follow_ups: list[str] = field(default_factory=list)


# Why the model could not run, in the app-knowledge package's vocabulary (it words
# the notice of the $0 answer from it).
FALLBACK_REASONS = ("not_configured", "unauthenticated", "budget", "breaker", "quota", "unavailable")


def fallback_reason(exc: BaseException | None) -> str:
    """The :data:`FALLBACK_REASONS` value for a failed first call (``None`` = no
    model can run at all, e.g. the legacy mock provider)."""
    if exc is None:
        return "not_configured"
    from ..llm.gateway import BreakerOpen, BudgetBlocked

    if isinstance(exc, BudgetBlocked):
        return "budget"
    if isinstance(exc, BreakerOpen):
        return "breaker"
    failure = str(getattr(exc, "failure_class", "") or "")
    if failure in FALLBACK_REASONS:
        return failure
    if str(exc).endswith(" API key not configured"):
        return "not_configured"
    return "unavailable"


class AppKnowledge(Protocol):
    """What the engine needs from the app-knowledge package (SPEC §5.4/§5.4.1)."""

    def fallback_answer(
        self, question: str, *, grants: frozenset[tuple[str, str]], reason: str, topic: str | None = None,
    ) -> FallbackAnswer | Mapping[str, Any] | None:
        """The extractive answer when ``question`` routes to app help, else None.
        ``reason`` is one of :data:`FALLBACK_REASONS`. ``topic`` (an "Ask about this"
        console_map topic id) pins that topic's glossary sections first; the engine
        passes it only when the turn has one."""

    def resolve_console_links(
        self, ids: Sequence[str], *, grants: frozenset[tuple[str, str]],
    ) -> Sequence[ConsoleLink | Mapping[str, Any]]:
        """``console_map`` ids → links (unknown ids dropped; ``allowed`` from grants)."""

    def render_reference(self, observations: Sequence[Mapping[str, Any]]) -> str:
        """The trusted "Product reference" message for this batch's ``app_help`` /
        ``app_status`` observations (markers neutralised, operator values fenced)."""

    def rebase_citations(self, outcome: Any, taken: Sequence[Citation]) -> None:
        """Renumber an ``app_help`` outcome's ``D*`` ids after those already taken."""


def coerce_fallback_answer(value: Any) -> FallbackAnswer | None:
    """Accept a :class:`FallbackAnswer`, a mapping or an object with the same fields
    (the app-knowledge package may return its own type); invalid parts are dropped."""
    if value is None:
        return None
    get = value.get if isinstance(value, Mapping) else (lambda k: getattr(value, k, None))
    answer = get("answer") or get("text")
    if not isinstance(answer, str) or not answer.strip():
        return None
    citations: list[Citation] = []
    for item in get("citations") or []:
        try:
            citations.append(item if isinstance(item, Citation) else Citation.model_validate(
                item if isinstance(item, Mapping) else getattr(item, "__dict__", {})))
        except Exception:  # noqa: BLE001 -- an invalid citation is dropped
            continue
    links = coerce_console_links(get("console_links") or [])
    blocks = [b for b in (get("blocks") or []) if isinstance(b, dict)]
    notice = get("notice")
    if not isinstance(notice, TurnNotice):
        try:
            notice = TurnNotice.model_validate(notice) if isinstance(notice, Mapping) else None
        except Exception:  # noqa: BLE001
            notice = None
    follow_ups = [f for f in (get("follow_ups") or []) if isinstance(f, str)]
    return FallbackAnswer(answer=answer, citations=citations, console_links=links, blocks=blocks,
                          notice=notice, follow_ups=follow_ups)


def coerce_console_links(values: Iterable[Any]) -> list[ConsoleLink]:
    out: list[ConsoleLink] = []
    for item in values or ():
        try:
            out.append(item if isinstance(item, ConsoleLink) else ConsoleLink.model_validate(
                item if isinstance(item, Mapping) else getattr(item, "__dict__", {})))
        except Exception:  # noqa: BLE001
            continue
    return out


# --------------------------------------------------------------------------- #
# §9.2 the report-summary reply.
# --------------------------------------------------------------------------- #
MAX_EXECUTIVE_SUMMARY = 1_200
MAX_NEXT_STEPS = 5
MAX_NEXT_STEP_CHARS = 300


def parse_report_summary(text: str) -> tuple[str, list[str]]:
    """``(executive_summary, next_steps)`` from a REPORT_SUMMARY_SYSTEM reply
    (``{"executive_summary": "...", "next_steps": [...]}``, a fence allowed). A reply
    that is not that JSON is used whole as the summary with no next steps. Both are
    display-sanitised and bounded (≤ 1 200 chars, ≤ 5 steps)."""
    obj = _load_object(text or "")
    summary_raw: Any = None
    steps_raw: Any = None
    if obj is not None:
        summary_raw = obj.get("executive_summary") or obj.get("summary")
        steps_raw = obj.get("next_steps")
    if not isinstance(summary_raw, str):
        summary_raw = "" if obj is not None else (text or "")
    summary = display_text(summary_raw, MAX_EXECUTIVE_SUMMARY, multiline=True).strip()
    steps: list[str] = []
    for item in steps_raw if isinstance(steps_raw, list) else []:
        if isinstance(item, str):
            step = display_text(item, MAX_NEXT_STEP_CHARS)
            if step:
                steps.append(step)
        if len(steps) >= MAX_NEXT_STEPS:
            break
    return summary, steps
