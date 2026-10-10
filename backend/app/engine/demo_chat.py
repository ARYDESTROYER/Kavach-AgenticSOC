"""Deterministic Demo Mode chat planner (chat revamp SPEC §5.5).

In Demo Mode every model call goes to ``DemoMockProvider``. For the agent-mode chat
prompt (a SYSTEM message carrying ``CHAT_AGENT_SYSTEM_MARKER``) the provider
delegates to :func:`plan_turn`, which plays the part of the model: it reads the
prompt the engine built and returns ONE protocol message (SPEC §4.1) — a
``tool``/``tools`` lookup step, or a ``final`` (header line, ``---ANSWER---``,
Markdown body). For the report-summary prompt (``REPORT_SUMMARY_SYSTEM_MARKER``) the
provider delegates to :func:`summarise_report`.

Why a planner and not canned answers: Demo Mode must demo every chat feature at $0
(SPEC §1) — several lookups per question, charts materialised from artifacts, view
changes of earlier blocks, report envelopes, the indicator taint rule and RBAC. The
planner proposes; the REAL engine validates, audits and executes every call exactly
as it would for a provider model, so the demo exercises the production path.

Rules, all structural so the planner can never become a back door:

* Pure and deterministic: no I/O, no randomness, no clock. The same prompt always
  yields the same bytes (tests pin whole transcripts).
* Tools: only names read back from the granted signature list in the SYSTEM prompt
  (``render_tool_signatures`` output, which lists only the caller's granted, in-scope
  tools). ``app_help`` is the fallback.
* The live question: the last user message that starts with ``USER_TURN_MARKER``.
* Completed calls and artifact refs (``tN.aK``): only from TRUSTED
  ``TOOL_CALL_HEADER`` lines outside any fence. A header-shaped line inside fenced
  data (a log value, a replayed answer) is never read.
* Numbers: only from the fenced observation JSON that follows each header, decoded
  structurally (a body that does not decode is ignored, never scraped).
* Earlier answers: only the engine digest and stored block ids (``mK.bJ``) in the
  ``prior_lookups`` fence, so "chart that by host" re-runs the exact earlier filters
  and "as a donut" re-views a stored block without inventing a number.
* Narration leads with the direct answer, cites numbers with units and windows,
  states basis and coverage, and offers three follow-ups that lead to other intents.
  Values read from logs or cases are shown as inline code in the Markdown body. The
  protocol header carries refs, views and product wording; its text leaves (a report's
  Summary and Next steps) are rebuilt from numbers, enums and case ids, so no log
  value or case text (titles, entities, evidence, recommendations) is copied into it.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Iterable, Mapping, Sequence

from ..agents.blocks import display_text
from ..agents.chat_events import (
    ANSWER_SEPARATOR,
    APP_DOCS_CLOSE,
    APP_DOCS_OPEN,
    CORRECTIVE_PREFIX,
    FINAL_ONLY_INSTRUCTION,
    PRODUCT_REFERENCE_HEADER,
    TOOL_CALL_HEADER_RE,
    ManifestEntry,
    extract_user_turn,
    parse_tool_call_header,
)
from ..agents.chat_tools.base import granted_tool_names
from ..agents.chat_tools.common import visible_text
from ..agents.chat_tools.taint import REFUSED_TAINT
from ..constants import UNTRUSTED_CLOSE, UNTRUSTED_OPEN
from ..models import ChatStarter

__all__ = [
    "DEMO_STARTERS",
    "MAX_PLAN_ROUNDS",
    "PromptView",
    "classify",
    "plan_turn",
    "read_prompt",
    "summarise_report",
]

# --------------------------------------------------------------------------- #
# The six Demo starters (SPEC §10.5; served by GET /api/chat/context in Demo).
# Each prompt drives a multi-lookup answer over values that exist in the seeded demo
# dataset; ``tools`` lists every tool its plan uses, so the empty state shows a card
# only when the caller may run all of them.
# --------------------------------------------------------------------------- #
DEMO_STARTERS: tuple[ChatStarter, ...] = (
    ChatStarter(
        id="investigate",
        label="Investigate",
        description="Walk the newest escalated case: evidence, decision and log activity.",
        prompt=("Investigate the newest escalated case: what happened, why is it still open, "
                "and what has its entity been doing in the logs?"),
        tools=["search_cases", "get_case", "explain_decision", "log_stats"],
    ),
    ChatStarter(
        id="hunt",
        label="Hunt an indicator",
        description="Pivot from a SQL injection case to its source IP: reputation, logs, cases.",
        prompt=("Hunt the source IP behind the newest SQL injection case: check its reputation, "
                "matching log events and related cases."),
        tools=["search_cases", "get_case", "lookup_indicator", "search_logs"],
    ),
    ChatStarter(
        id="posture",
        label="Posture now",
        description="Risk index, case load, false-positive rate and the 24-hour trend.",
        prompt=("How is our security posture right now? Include the risk index and how things "
                "trended over the last 24 hours."),
        tools=["soc_metrics"],
    ),
    ChatStarter(
        id="shift_brief",
        label="Shift brief",
        description="A handoff brief: open work, what needs attention first, key metrics.",
        prompt=("Write a shift brief for the incoming analyst: open work, what needs attention "
                "first, and the key metrics."),
        tools=["shift_report", "soc_metrics", "list_campaigns"],
    ),
    ChatStarter(
        id="explain_metric",
        label="Explain a metric",
        description="What the noise reduction funnel measures, with our own numbers.",
        prompt=("What does the noise reduction funnel measure, and what does ours show for the "
                "last 24 hours?"),
        tools=["app_help", "soc_metrics"],
    ),
    ChatStarter(
        id="learn_app",
        label="Learn the app",
        description="How to connect a log source, and what your access lets chat do.",
        prompt=("How do I connect a new log source, and what can I do from this chat with my "
                "access?"),
        tools=["app_help", "app_status"],
    ),
)

#: At most this many lookup rounds per turn (the planner's own bound; the longest plan,
#: an in-depth investigation, needs four at four lookups a time). Unlimited chat
#: (SPEC D1) sets no per-question cap; in bounded mode the engine's own
#: ``max_model_calls`` ends the turn earlier and the final says what did not run.
MAX_PLAN_ROUNDS = 12

# --------------------------------------------------------------------------- #
# Reading the prompt.
# --------------------------------------------------------------------------- #
_SIGNATURES_HEADING = "## Lookups available to you"
_KIND_RE = re.compile(r"\bkind\??=([a-z_]+(?:\|[a-z_]+)*)")
_SIGNATURE_LINE_RE = re.compile(r"^- ([a-z][a-z0-9_]{0,63})\((.*)$", re.MULTILINE)
_PARALLEL_RE = re.compile(r"in parallel \(at most (\d{1,2})\)")
_ANALYST_WINDOW_RE = re.compile(
    r"^- Time window selected by the analyst: (.{1,60}?)\. Use it", re.MULTILINE)
# ``render_chat_agent_system`` writes the request's @-scope enums on this line. A tool
# missing from the signatures may be outside these scopes rather than ungranted.
_SCOPES_RE = re.compile(r"^- The analyst limited lookups to: ([a-z]{2,16}(?:, [a-z]{2,16})*)\.$", re.MULTILINE)
# ``render_chat_agent_system`` names the granted tools CONFIGURATION switched off on
# this line (``prompts.DISABLED_TOOLS_LINE_PREFIX``): a tool absent for that reason
# is "turned off on this deployment", never a missing grant.
_DISABLED_RE = re.compile(
    r"^- Turned off on this deployment: ([a-z][a-z0-9_]{0,63}(?:, [a-z][a-z0-9_]{0,63})*)\.", re.MULTILINE)
_CASE_SCOPED_TEXT = "This conversation is about one case"
_FENCE_LABEL_RE = re.compile(r"^ source=(\S+)(?: tool=(\S+))?\s*$")
# The legacy ``needs_query`` second-call message (agents.chat._agg_message) and the
# one trusted line the engine appends when the window was clamped.
_LEGACY_PREFIX = "Results of the es_query are summarised below"
_LEGACY_NOTE_PREFIX = "Note: the requested time window was limited"
# The replay digest (chat_protocol.lookup_digest / block_listing).
_DIGEST_LINE_RE = re.compile(r"^Lookups (m[1-9][0-9]{0,2}): (.*)$")
_DIGEST_CALL_RE = re.compile(r"([a-z][a-z0-9_]{0,63})\(([^()]*)\) → ")
_DIGEST_ARG_RE = re.compile(r"^([A-Za-z0-9_.:-]{1,40})=(.*)$")
_BLOCK_LINE_RE = re.compile(
    r'^(m[1-9][0-9]{0,2})\.b([1-9][0-9]{0,2}) ([a-z_]+) "([^"\n]*)" views=\[([a-z_,]*)\]$')
# The product reference (app.knowledge.render.render_app_docs).
_SECTION_RE = re.compile(r"^\[(D[1-9][0-9]{0,2})\] (.+?)(?: \(Help Center: (.+)\))?$")
_UNCITABLE_RE = re.compile(r"^\[reference only, not citable\] (.+?)(?: \(Help Center: (.+)\))?$")
_TARGET_RE = re.compile(
    r"^- ([a-z]+:[A-Za-z0-9_.:-]{1,118}): (.+) \((the user can open it|needs (.+?); the user lacks it)\)$")
_FACT_RE = re.compile(r"^([a-z][a-z0-9_]{1,40}): ?(.*)$")
_KNOWN_FACT_SECTIONS = frozenset({
    "product", "mode", "capabilities", "sources", "models", "roles", "config", "policy",
})


@dataclass
class Result:
    """One completed tool call: its TRUSTED header plus the decoded observation."""

    ordinal: int
    tool: str
    status: str
    summary: str
    artifacts: tuple[ManifestEntry, ...] = ()
    observation: dict[str, Any] | None = None
    error: str | None = None
    input: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @property
    def obs(self) -> dict[str, Any]:
        return self.observation if isinstance(self.observation, dict) else {}

    @property
    def kind(self) -> str | None:
        value = self.obs.get("kind")
        if not isinstance(value, str):
            value = self.input.get("kind")
        return value if isinstance(value, str) else None

    def artifact(self, kind: str, nth: int = 1) -> ManifestEntry | None:
        """The ``nth`` artifact of ``kind`` this call offered (header manifest only)."""
        seen = 0
        for entry in self.artifacts:
            if entry.kind == kind:
                seen += 1
                if seen == nth:
                    return entry
        return None


@dataclass
class HelpSection:
    ref: str | None
    title: str
    crumb: str = ""
    href: str | None = None
    lines: list[str] = field(default_factory=list)
    console: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ConsoleTarget:
    id: str
    label: str
    allowed: bool
    requires: str | None = None


@dataclass
class Reference:
    """Trusted product facts from the ``PRODUCT_REFERENCE_HEADER`` messages."""

    sections: list[HelpSection] = field(default_factory=list)
    targets: list[ConsoleTarget] = field(default_factory=list)
    facts: dict[str, str] = field(default_factory=dict)

    def merge(self, other: "Reference") -> None:
        self.sections.extend(other.sections)
        known = {t.id for t in self.targets}
        self.targets.extend(t for t in other.targets if t.id not in known)
        for key, value in other.facts.items():
            self.facts.setdefault(key, value)


@dataclass(frozen=True)
class PriorBlock:
    key: str          # "m2"
    ref: str          # "m2.b1"
    view: str
    title: str
    views: tuple[str, ...]


@dataclass(frozen=True)
class PriorCall:
    key: str
    tool: str
    args: tuple[tuple[str, str], ...]

    def arg(self, name: str) -> str | None:
        return next((v for k, v in self.args if k == name), None)


@dataclass
class PromptView:
    """Everything the planner may read from one model step's prompt."""

    question: str = ""
    granted: tuple[str, ...] = ()
    kinds: dict[str, tuple[str, ...]] = field(default_factory=dict)
    max_parallel: int = 4
    analyst_window: str | None = None
    case_scoped: bool = False
    scopes: tuple[str, ...] = ()
    disabled: tuple[str, ...] = ()
    prior_blocks: list[PriorBlock] = field(default_factory=list)
    prior_calls: list[PriorCall] = field(default_factory=list)
    #: The analyst's earlier questions in this conversation (their own words, oldest
    #: first): a bare clarify option ("Cases") is read against the one before it.
    prior_questions: list[str] = field(default_factory=list)
    rounds: list[list[Result]] = field(default_factory=list)
    reference: Reference = field(default_factory=Reference)
    final_only: bool = False
    unrun: bool = False
    legacy: dict[str, Any] | None = None
    legacy_note: str | None = None

    def results(self) -> list[Result]:
        return [r for batch in self.rounds for r in batch]

    def can(self, tool: str, kind: Any = None) -> bool:
        """``tool`` is granted, and so is ``kind`` when the signature lists kinds."""
        if tool not in self.granted:
            return False
        if isinstance(kind, str) and self.kinds.get(tool):
            return kind in self.kinds[tool]
        return True

    def ok(self, tool: str, kind: str | None = None, *,
           where: Callable[[Result], bool] | None = None) -> Result | None:
        """The first successful call of ``tool`` (and ``kind``) with an observation."""
        for result in self.results():
            if result.tool != tool or not result.ok:
                continue
            if tool not in _REFERENCE_TOOLS and result.observation is None:
                continue
            if kind is not None and result.kind != kind:
                continue
            if where is not None and not where(result):
                continue
            return result
        return None

    def failed(self) -> list[Result]:
        return [r for r in self.results() if not r.ok]


_REFERENCE_TOOLS = frozenset({"app_help", "app_status"})


def _role(message: Mapping[str, Any]) -> str:
    role = message.get("role")
    return role if isinstance(role, str) else ""


def _content(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    return content if isinstance(content, str) else ""


def _signature_block(system: str) -> str:
    start = system.find(_SIGNATURES_HEADING)
    if start < 0:
        return ""
    start += len(_SIGNATURES_HEADING)
    end = system.find("\n## ", start)
    return system[start:] if end < 0 else system[start:end]


def _fence_body(text: str, source: str) -> list[str]:
    """The bodies of every fence labelled ``source`` in ``text`` (in order)."""
    bodies: list[str] = []
    label: str | None = None
    lines: list[str] = []
    for line in text.split("\n"):
        if label is not None:
            if line.strip() == UNTRUSTED_CLOSE:
                if label == source:
                    bodies.append("\n".join(lines))
                label = None
            else:
                lines.append(line)
            continue
        if line.startswith(UNTRUSTED_OPEN):
            match = _FENCE_LABEL_RE.match(line[len(UNTRUSTED_OPEN):])
            label = match.group(1) if match else ""
            lines = []
    return bodies


def _parse_echo(content: str) -> list[tuple[str, dict[str, Any]]] | None:
    """The calls of the engine's echo of a tools reply (``None`` if unreadable)."""
    try:
        obj = json.loads(content)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    if obj.get("action") == "tool":
        raw = [{"tool": obj.get("tool"), "input": obj.get("input")}]
    elif obj.get("action") == "tools" and isinstance(obj.get("calls"), list):
        raw = obj["calls"]
    else:
        return None
    calls: list[tuple[str, dict[str, Any]]] = []
    for item in raw:
        if isinstance(item, dict) and isinstance(item.get("tool"), str):
            inp = item.get("input")
            calls.append((item["tool"], inp if isinstance(inp, dict) else {}))
    return calls


def _attach(result: Result | None, label: tuple[str, str | None], body: str) -> None:
    """Attach a fenced observation to the call whose header it follows. Only a
    ``source=tool`` fence of the SAME tool counts (a ``tool_params`` fence holds the
    model's own inputs and is ignored)."""
    if result is None or label[0] != "tool" or label[1] != result.tool or result.observation is not None:
        return
    try:
        value = json.loads(body)
    except ValueError:
        return
    if not isinstance(value, dict):
        return
    if result.ok:
        result.observation = value
    elif isinstance(value.get("error"), str):
        result.error = value["error"]


def _parse_results(content: str, echo: list[tuple[str, dict[str, Any]]] | None) -> list[Result]:
    """Header lines (outside fences) and the observation fence after each."""
    results: list[Result] = []
    current: Result | None = None
    label: tuple[str, str | None] | None = None
    body: list[str] = []
    for line in content.split("\n"):
        if label is not None:
            if line.strip() == UNTRUSTED_CLOSE:
                _attach(current, label, "\n".join(body))
                label = None
            else:
                body.append(line)
            continue
        if line.startswith(UNTRUSTED_OPEN):
            match = _FENCE_LABEL_RE.match(line[len(UNTRUSTED_OPEN):])
            label = (match.group(1), match.group(2)) if match else ("", None)
            body = []
            continue
        header = parse_tool_call_header(line)
        if header is not None:
            current = Result(ordinal=header.ordinal, tool=header.tool, status=header.status,
                             summary=header.summary, artifacts=header.artifacts)
            results.append(current)
    if echo is not None and len(echo) == len(results):
        for result, (tool, inp) in zip(results, echo):
            if tool == result.tool:
                result.input = inp
    return results


_OMITTED_RE = re.compile(r"^\(\d+ lower-ranked Help Center sections? omitted")


def _parse_reference(content: str) -> Reference:
    ref = Reference()
    start = content.find(APP_DOCS_OPEN)
    end = content.find(APP_DOCS_CLOSE)
    if start < 0 or end < start:
        return ref
    current: HelpSection | None = None
    previous_blank = True
    for line in content[start + len(APP_DOCS_OPEN):end].split("\n"):
        blank, previous_blank = previous_blank, not line.strip()
        match = _SECTION_RE.match(line)
        if match:
            current = HelpSection(ref=match.group(1), title=match.group(2), crumb=match.group(3) or "")
            ref.sections.append(current)
            continue
        match = _UNCITABLE_RE.match(line)
        if match:
            current = HelpSection(ref=None, title=match.group(1), crumb=match.group(2) or "")
            ref.sections.append(current)
            continue
        if current is not None and line.startswith("Link: "):
            current.href = line[6:].strip()
            continue
        if current is not None and line.startswith("Console: "):
            current.console = [c.strip() for c in line[9:].split(",") if c.strip()]
            continue
        match = _TARGET_RE.match(line)
        if match:
            ref.targets.append(ConsoleTarget(
                id=match.group(1), label=match.group(2),
                allowed=match.group(3) == "the user can open it", requires=match.group(4)))
            current = None
            continue
        if line.startswith("Console destinations") or _OMITTED_RE.match(line):
            current = None
            continue
        # A deployment fact ("your_permissions: …") starts a paragraph of its own; a
        # line inside a Help Center excerpt that merely looks like one stays text.
        match = _FACT_RE.match(line)
        if match and (blank or current is None) and (
                "_" in match.group(1) or match.group(1) in _KNOWN_FACT_SECTIONS):
            ref.facts.setdefault(match.group(1), match.group(2).strip())
            current = None
            continue
        if current is not None:
            current.lines.append(line)
    return ref


def _parse_history(view: PromptView, messages: Sequence[Mapping[str, Any]]) -> None:
    """Stored block ids and lookup digests of retained earlier answers."""
    for message in messages:
        if _role(message) != "assistant":
            continue
        for body in _fence_body(_content(message), "prior_lookups"):
            for line in body.split("\n"):
                line = line.strip()
                block = _BLOCK_LINE_RE.match(line)
                if block:
                    key = block.group(1)
                    view.prior_blocks.append(PriorBlock(
                        key=key, ref=f"{key}.b{block.group(2)}", view=block.group(3),
                        title=block.group(4),
                        views=tuple(v for v in block.group(5).split(",") if v)))
                    continue
                digest = _DIGEST_LINE_RE.match(line)
                if not digest:
                    continue
                for call in _DIGEST_CALL_RE.finditer(digest.group(2)):
                    args: list[tuple[str, str]] = []
                    for part in call.group(2).split(", "):
                        arg = _DIGEST_ARG_RE.match(part.strip())
                        if arg:
                            args.append((arg.group(1), arg.group(2)))
                    view.prior_calls.append(PriorCall(key=digest.group(1), tool=call.group(1),
                                                      args=tuple(args)))


def read_prompt(messages: Sequence[Mapping[str, Any]]) -> PromptView:
    """Parse one model step's prompt (see the module docstring for the trust rules)."""
    view = PromptView()
    msgs = [m for m in messages if isinstance(m, Mapping)]
    system = "\n".join(_content(m) for m in msgs if _role(m) == "system")
    block = _signature_block(system)
    view.granted = tuple(dict.fromkeys(granted_tool_names(block)))
    for match in _SIGNATURE_LINE_RE.finditer(block):
        kinds = _KIND_RE.search(match.group(2))
        if kinds:
            view.kinds[match.group(1)] = tuple(kinds.group(1).split("|"))
    parallel = _PARALLEL_RE.search(system)
    view.max_parallel = max(1, min(16, int(parallel.group(1)))) if parallel else 4
    window = _ANALYST_WINDOW_RE.search(system)
    view.analyst_window = window.group(1) if window else None
    scopes = _SCOPES_RE.search(system)
    view.scopes = tuple(dict.fromkeys(scopes.group(1).split(", "))) if scopes else ()
    disabled = _DISABLED_RE.search(system)
    view.disabled = tuple(dict.fromkeys(disabled.group(1).split(", "))) if disabled else ()
    view.case_scoped = _CASE_SCOPED_TEXT in system

    live = -1
    for index, message in enumerate(msgs):
        if _role(message) == "user" and extract_user_turn(_content(message)) is not None:
            live = index
    if live < 0:
        return view
    view.question = (extract_user_turn(_content(msgs[live])) or "").strip()
    _parse_history(view, msgs[:live])
    for message in msgs[:live]:
        # Earlier user turns are replayed as plain user messages (never a tool result,
        # which opens with an engine header, nor the product reference).
        content = _content(message)
        if (_role(message) == "user" and content.strip() and not TOOL_CALL_HEADER_RE.match(content.split("\n", 1)[0])
                and not content.startswith(PRODUCT_REFERENCE_HEADER)):
            view.prior_questions.append((extract_user_turn(content) or content).strip()[:500])

    echo: list[tuple[str, dict[str, Any]]] | None = None
    echo_pending = False
    for message in msgs[live + 1:]:
        content = _content(message)
        if _role(message) == "assistant":
            echo = _parse_echo(content)
            echo_pending = True
            continue
        if _role(message) != "user":
            continue
        first = content.split("\n", 1)[0]
        if TOOL_CALL_HEADER_RE.match(first):
            view.rounds.append(_parse_results(content, echo))
            echo, echo_pending = None, False
        elif content.startswith(PRODUCT_REFERENCE_HEADER):
            view.reference.merge(_parse_reference(content))
        elif content.strip() == FINAL_ONLY_INSTRUCTION:
            view.final_only = True
            # After the turn deadline the engine echoes a tools reply that never ran.
            view.unrun = view.unrun or echo_pending
            echo, echo_pending = None, False
        elif content.startswith(CORRECTIVE_PREFIX):
            view.final_only = True
        elif content.startswith(_LEGACY_PREFIX):
            bodies = _fence_body(content, "log")
            try:
                parsed = json.loads(bodies[0]) if bodies else None
            except ValueError:
                parsed = None
            view.legacy = parsed if isinstance(parsed, dict) else {}
            note = next((ln for ln in content.split("\n") if ln.startswith(_LEGACY_NOTE_PREFIX)), None)
            view.legacy_note = note
            view.rounds.append([])
            echo, echo_pending = None, False
    return view


# --------------------------------------------------------------------------- #
# Formatting helpers (deterministic; numbers only from observations).
# --------------------------------------------------------------------------- #
def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _dig(obj: Any, *path: Any) -> Any:
    for key in path:
        if isinstance(obj, Mapping):
            obj = obj.get(key)
        elif isinstance(obj, list) and isinstance(key, int) and -len(obj) <= key < len(obj):
            obj = obj[key]
        else:
            return None
    return obj


def _count(value: Any) -> str:
    number = _num(value)
    return "0" if number is None else f"{int(round(number)):,}"


def _dec(value: Any, places: int = 1) -> str:
    number = _num(value)
    if number is None:
        return "—"
    text = f"{number:,.{places}f}"
    return text[:-2] if places == 1 and text.endswith(".0") else text


def _pct(value: Any, *, ratio: bool = False) -> str:
    number = _num(value)
    if number is None:
        return "not measured"
    return f"{_dec(number * 100 if ratio else number)}%"


def _usd(value: Any) -> str:
    number = _num(value) or 0.0
    if number == 0:
        return "$0.00"
    return f"${number:,.4f}" if abs(number) < 1 else f"${number:,.2f}"


def _minutes(value: Any) -> str:
    number = _num(value)
    if number is None:
        return "—"
    if number >= 120:
        return f"{_dec(number / 60)} h"
    return f"{_dec(number)} min"


def _plural(n: Any, one: str, many: str | None = None) -> str:
    number = _num(n)
    word = one if number is not None and int(round(number)) == 1 else (many or one + "s")
    return f"{_count(n)} {word}"


def _code(value: Any, limit: int = 80) -> str:
    """A log- or case-derived value as inline code, no backticks. Invisible characters
    are written as visible ``\\uXXXX`` escapes (``visible_text``, as the chart labels
    show them), never deleted: ``ad``+ZWSP+``min`` must not read as ``admin``."""
    text = visible_text(value if isinstance(value, str) else ("" if value is None else str(value)), limit)
    text = text.replace("`", "'").strip()
    return f"`{text}`" if text else "`(blank)`"


_MARKDOWN_SPECIALS_RE = re.compile(r"[`*_\[\]<>#|~]")


def _plain(value: Any, limit: int = 240) -> str:
    """Untrusted prose (an evidence summary) as plain text: no Markdown can survive."""
    text = display_text(value if isinstance(value, str) else "", limit)
    return _MARKDOWN_SPECIALS_RE.sub("", text).strip()


def _join(items: Sequence[str], conj: str = "and") -> str:
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])} {conj} {items[-1]}"


def _window(obs: Mapping[str, Any], fallback: str = "the selected window") -> str:
    value = obs.get("window")
    return display_text(value, 60) if isinstance(value, str) and value.strip() else fallback


_BARE_PERIODS = frozenset({"today", "yesterday", "this week", "last week", "this month", "last month",
                           "this quarter", "last quarter", "this year", "last year"})


def _in(label: str) -> str:
    """A window label with the words that introduce it: "in the last 24 hours",
    "over all time (since 3 Nov 2025)", "in September 2026", "this week", "since 1
    Mar 2026" (SPEC D7: humanised labels, never "in the all time")."""
    text = (label or "").strip()
    low = text.lower()
    if not text:
        return "in the selected window"
    if low.startswith(("last ", "past ", "previous ", "selected ")) and low.split(" (")[0] not in _BARE_PERIODS:
        return f"in the {text}"
    if low.startswith("all time"):
        return f"over {text}"
    if low.split(" (")[0] in _BARE_PERIODS or low.startswith(("since ", "from ", "between ")):
        return text
    if " – " in text and not low.startswith("the "):
        return "from " + text.replace(" – ", " to ", 1)
    return f"in {text}"


def _sources_answered(obs: Mapping[str, Any]) -> tuple[int, int]:
    sources = [s for s in obs.get("sources") or [] if isinstance(s, Mapping)]
    ok = sum(1 for s in sources if s.get("status") == "ok")
    return ok, len(sources)


def _coverage_phrase(obs: Mapping[str, Any]) -> str:
    ok, total = _sources_answered(obs)
    if not total:
        return ""
    if ok == total:
        return f"{ok} of {total} sources answered"
    return f"only {ok} of {total} sources answered, so the counts are partial"


def _log_total_is_lower_bound(obs: Mapping[str, Any]) -> bool:
    """A log lookup's ``total`` is a lower bound (a capped or unknown match count).
    A lower bound of zero says nothing, so it never qualifies."""
    return bool(obs.get("total_is_lower_bound")) and (_num(obs.get("total")) or 0) > 0


def _case_lower_bound(obs: Mapping[str, Any]) -> str:
    """Why a case search's ``count`` is a lower bound ("a lower bound: the newest 500
    cases were scanned"), or "" when the count is exact."""
    if obs.get("exact", True) is not False:
        return ""
    scanned = obs.get("scanned")
    return f"a lower bound: the newest {_count(scanned)} cases were scanned" if scanned else "a lower bound"


#: The data tools whose ``sources`` list says which log sources ANSWERED (elsewhere,
#: ``source_health``'s list is the sources' health, not who answered a lookup).
_ANSWERING_SOURCE_TOOLS = frozenset({"search_logs", "log_stats"})


def _coverage_bits(r: Result) -> list[tuple[str, str]]:
    """``(marker, clause)`` for each way one completed lookup's figures are
    incomplete: fewer log sources answered than were queried, or a count that is a
    lower bound. ``marker`` is the words the narration uses for the same disclosure,
    so a lead that already says it is not told twice."""
    o = r.obs
    bits: list[tuple[str, str]] = []
    if r.tool in _ANSWERING_SOURCE_TOOLS:
        ok, total = _sources_answered(o)
        if total and ok < total:
            bits.append((f"only {ok} of {total} sources answered",
                         f"only {ok} of {total} sources answered, so the counts are partial"))
        if _log_total_is_lower_bound(o):
            bits.append(("total is a lower bound", "the total is a lower bound"))
        if r.tool == "log_stats" and o.get("top_values_are_lower_bounds"):
            bits.append(("per-value counts are lower bounds",
                         "per-source top lists were merged, so the per-value counts are lower bounds"))
    elif r.tool == "search_cases":
        bound = _case_lower_bound(o)
        if bound:
            scanned = o.get("scanned")
            bits.append((bound, "the count is a lower bound"
                         + (f" (the newest {_count(scanned)} cases were scanned)" if scanned else "")))
    return bits


def _coverage_notes(view: PromptView, said: str = "") -> list[str]:
    """One engine-worded sentence per completed lookup whose figures are partial or
    a lower bound ("Log search: only 1 of 3 sources answered, so the counts are
    partial."), leaving out what ``said`` (the lead) already discloses. A report's
    lead keeps only its headline, so these follow it (Honesty: a partial result is
    partial; say so)."""
    notes: list[str] = []
    for r in view.results():
        if not r.ok or r.observation is None:
            continue
        clauses = [clause for marker, clause in _coverage_bits(r) if marker not in said]
        if clauses:
            name = _TOOL_NAMES.get(r.tool, r.tool)
            notes.append(f"{name[:1].upper()}{name[1:]}: {'; '.join(clauses)}.")
    return list(dict.fromkeys(notes))


def _basis_phrase(obs: Mapping[str, Any]) -> str:
    basis = obs.get("basis")
    if basis == "exact" and not obs.get("total_is_lower_bound") and not obs.get("top_values_are_lower_bounds"):
        return "Counts are exact."
    if obs.get("top_values_are_lower_bounds"):
        return "Per-source top lists were merged, so the per-value counts are lower bounds."
    if obs.get("total_is_lower_bound"):
        return "The source capped its count, so the total is a lower bound."
    if basis in ("sample", "newest_n"):
        return "Counts come from the newest events per source (a sample), so read them as indicative."
    return ""


_VIEW_WORDS: tuple[tuple[str, str], ...] = (
    ("horizontal bar", "hbar"), ("stacked", "stacked_bar"), ("sparkline", "sparkline"),
    ("donut", "donut"), ("doughnut", "donut"), ("pie", "donut"), ("table", "table"),
    ("funnel", "funnel"), ("area", "area"), ("line", "line"), ("column", "bar"), ("bar", "bar"),
    ("kpi", "kpi_group"), ("timeline", "timeline"),
)
_VIEW_LABEL = {
    "hbar": "horizontal bar chart", "bar": "bar chart", "donut": "donut", "table": "table",
    "line": "line chart", "area": "area chart", "stacked_bar": "stacked bar chart",
    "sparkline": "sparkline", "funnel": "funnel", "kpi_group": "set of key figures",
    "timeline": "timeline", "case_list": "case list",
}


def _block(result: Result | None, kind: str, *, nth: int = 1, view: str | None = None,
           title: str | None = None, top_n: int | None = None) -> dict[str, Any] | None:
    """A block request for an artifact named in ``result``'s TRUSTED header; the view
    is used only when the manifest offers it (else the artifact's default view)."""
    if result is None or not result.ok:
        return None
    entry = result.artifact(kind, nth)
    if entry is None:
        return None
    request: dict[str, Any] = {"ref": entry.ref}
    if entry.views:
        request["view"] = view if view in entry.views else entry.views[0]
    if title:
        request["title"] = title[:120]
    if top_n:
        request["top_n"] = int(top_n)
    return request


def _first_view(result: Result | None, kind: str, preferred: Sequence[str], nth: int = 1) -> str | None:
    if result is None:
        return None
    entry = result.artifact(kind, nth)
    if entry is None:
        return None
    return next((v for v in preferred if v in entry.views), entry.views[0] if entry.views else None)


# --------------------------------------------------------------------------- #
# Intent classification (SPEC §5.5 table, plus a few product rules from §5.6).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Ask:
    intent: str
    question: str
    lowered: str
    hours: int | None = None
    indicator: tuple[str, str] | None = None     # (value, lookup kind)
    case_id: str | None = None
    case_status: str | None = None                # selector: escalated | closed | ...
    techniques: tuple[str, ...] = ()
    field: str | None = None                      # log grouping field
    view: str | None = None                       # requested view (reshape)
    metric: str | None = None                     # soc_metrics kind (or "cost")
    topic: str = ""                               # app_help query
    keyword: str | None = None                    # case text keyword
    wants_access: bool = False
    wants_overview: bool = False
    report: str | None = None                     # report template when asked
    headings: tuple[str, ...] = ()                # requested report sections
    memory: str | None = None
    definition: bool = False                      # a "what does X count/measure" question
    log_filter: tuple[tuple[str, str], ...] = ()  # explicit log search: (("contains", "x"),)
    # Round 12 (SPEC D7-D11): the window the question names, a period comparison, a
    # creation-time bucket and a case grouping; whether a report is to be SAVED (the
    # header's ``report``); a trend's subject; a clarify kind; an entity to dig into.
    win: Win | None = None
    compare: Any = None
    compare_win: Win | None = None                # an explicit other period ("Q3 vs Q2")
    bucket: str | None = None
    group: str | None = None
    save: bool = False
    subject: str | None = None
    clarify: str | None = None
    entity: tuple[str, str] | None = None         # (kind, value): host | user | ip


_IPV4_RE = re.compile(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)(?!\.\d)")
_HASH_RE = re.compile(r"\b(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{40}|[a-fA-F0-9]{32})\b")
_URL_RE = re.compile(r"\b(?:https?|hxxps?)://[^\s<>\"'`]{3,200}", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b", re.IGNORECASE)
_FILE_SUFFIXES = frozenset({
    "pdf", "txt", "csv", "json", "html", "htm", "md", "py", "js", "ts", "log", "zip", "exe", "dll",
    "png", "jpg", "jpeg", "gif", "xml", "yml", "yaml", "doc", "docx", "xls", "xlsx", "ps1", "sh",
})
_CASE_ID_RE = re.compile(r"\b((?:case|demo)(?:-[a-z]+)?[-_][A-Za-z0-9][A-Za-z0-9_.-]{1,60})\b", re.IGNORECASE)
_CASE_WORD_ID_RE = re.compile(r"\bcase\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_.:-]{2,63})\b", re.IGNORECASE)
_TECHNIQUE_RE = re.compile(r"\b[Tt](\d{4})(?:\.(\d{3}))?\b")
_HUNT_CUE_RE = re.compile(r"\b(hunt|look ?up|reputation|ioc|indicator|check|investigate|pivot|sightings?)\b")

_GROUP_FIELDS: tuple[tuple[str, str], ...] = (
    ("source ip", "ip"), ("src ip", "ip"), ("ip address", "ip"), ("ips", "ip"), ("ip", "ip"),
    ("rule name", "rule_name"), ("rules", "rule"), ("rule", "rule"), ("users", "user"),
    ("user", "user"), ("accounts", "user"), ("account", "user"), ("hosts", "host"), ("host", "host"),
    ("machines", "host"), ("servers", "host"), ("endpoints", "host"), ("severity", "severity"),
    ("severities", "severity"), ("actions", "action"), ("action", "action"),
)
_FIELD_LABEL = {"ip": "source IP", "user": "user", "host": "host", "rule": "rule",
                "rule_name": "rule name", "severity": "severity", "action": "action"}

_CASE_KEYWORDS: tuple[tuple[str, str, str], ...] = (
    # (question pattern, case text keyword, display name)
    (r"sql ?i|sql injection|sqli", "sql", "SQL injection"),
    (r"brute", "brute", "brute-force"),
    (r"phish", "phish", "phishing"),
    (r"ransom", "ransom", "ransomware"),
    (r"impossible travel|travel", "travel", "impossible-travel"),
    (r"web ?shell", "webshell", "webshell"),
    (r"exfil", "exfil", "exfiltration"),
    (r"beacon|\bc2\b|command and control", "beacon", "C2 beacon"),
    (r"scanner|scan", "scan", "scanning"),
)

# Metric phrases (KPI glossary terms) → the soc_metrics kind that measures them.
_METRIC_TERMS: tuple[tuple[str, str, str], ...] = (
    (r"noise|funnel|reduction", "noise_funnel", "noise reduction funnel"),
    (r"false[- ]positive rate|fp rate|false positives?", "posture", "false-positive rate"),
    (r"(active )?risk index", "posture", "Active Risk Index"),
    (r"\bmtt[adr]\b|mean time|dwell|response time|respond timing", "timing", "MTTA, MTTR and MTTD"),
    (r"auto[- ]?clos", "auto_close_health", "auto-close rate"),
    (r"case mix|verdict mix", "case_mix", "case mix"),
    (r"coverage of att&ck|att&ck coverage|mitre coverage|technique coverage", "mitre_coverage",
     "ATT&CK coverage"),
    (r"automation rate|escalation rate", "posture", "automation and escalation rates"),
    (r"llm spend|ai (?:model )?spend|model spend|token cost", "cost", "AI spend"),
)

_DEFINITION_RE = re.compile(
    r"\b(what (?:does|do|is|are)\b(?! (?:our|we|my)\b)|what'?s (?:a|an|the)\b|explain|meaning|means?\b|"
    r"defin(?:e|ition)|how (?:is|are) .{0,40}(?:calculated|computed|measured)|"
    r"how do (?:you|we) (?:calculate|compute|measure))")
_HELP_RE = re.compile(
    r"^\s*(?:/help\b|how (?:do|can|should) (?:i|we)\b|how to\b|where (?:do|can|should) (?:i|we)\b|"
    r"where (?:is|are) (?:the )?[a-z &-]{0,40}(?:setting|settings|page|option|button|menu|tab)s?\b|"
    r"can (?:i|we)\b|is it possible\b|help me\b|what can (?:i|you|chat)\b)")
# Definitional forms ("Ask about this" topic questions, SPEC A7, and their like): what
# a KPI counts, what a setting controls, how a figure is calculated. They are answered
# from the Help Center (plus our own figure when a metric matches), never by a data
# intent that would show numbers without the definition.
_DEFINITIONAL_RE = re.compile(
    r"^\s*(?:"
    r"what does (?!(?:our|my|this|that|it)\b)(?:the |a |an )?.{1,90}?\b(?:counts?|measures?|means?|controls?|"
    r"tracks?|represents?)\b"
    r"|how (?:is|are) (?!(?:our|my)\b)(?:the |a |an )?.{1,90}?\b(?:calculated|computed|measured|derived|"
    r"attributed|scored|defined|counted)\b"
    r"|how does (?:the |a |an )?.{1,60}?\b(?:card|kpi|chart|metric|funnel|gauge|score|index|widget|panel|tile|"
    r"setting)s?\b"
    r"|how should (?:i|we) read\b"
    r"|what (?:is|are) (?:a|an)\s+[a-z]"
    r"|what(?: is|'s) the (?:difference|meaning)\b"
    r")")
# "Can we see brute force attempts?" asks for data, not for how to use the console.
_DATA_ASK_RE = re.compile(r"^\s*(?:can|could) (?:i|we|you) (?:see|show|get|find|list|pull|look at)\b")
_ACCESS_RE = re.compile(r"\b(what can (?:i|you|chat) do|my access|my role|my permissions?|permissions?|"
                        r"allowed to|am i able)\b")
_OVERVIEW_RE = re.compile(r"\b(version|demo mode|what is enabled|which features|deployment|configured)\b")
_CHANGE_RE = re.compile(
    r"^\s*(?:please\s+|can you\s+|could you\s+|would you\s+)?(close|resolve|delete|remove|disable|enable|"
    r"assign|reassign|escalate|approve|reject|create|add|update|change|modify|set|turn (?:on|off)|"
    r"restart|reset|block|isolate|contain|quarantine|suppress|mute|acknowledge|ack|edit|rename|"
    r"tune|purge|wipe)\b")
_REMEMBER_RE = re.compile(r"^\s*(?:please\s+)?(?:remember|note)\s+(?:that\s+)?(.{3,500})$", re.IGNORECASE)
_UNSUPPORTED_RE = re.compile(
    r"\b(user accounts?|console users|users and roles|roles|active sessions|sessions|background jobs|"
    r"jobs|notification channels?|notifications|dashboards?|secrets?|api keys?|passwords?)\b")
_LIST_CUE_RE = re.compile(r"\b(list|show|which|who|how many|what are)\b")
_SECTIONS_RE = re.compile(r"sections?:\s*(.{3,300}?)\s*\.?\s*$", re.IGNORECASE)
_BRUTE_RE = re.compile(r"\b(brute[- ]?forc\w*|password spray\w*|credential stuffing|failed (?:log ?ins?|logins?|"
                       r"sign[- ]?ins?|auth\w*)|(?:authentication|login|sign-?in) failures?)\b")
# Explicit log-search phrasing (wave-6 B5): "search logs for X", "find events containing
# X", "show me the logs mentioning X", "grep the logs for X", "search for X in the logs"
# run a log search for X, and "how many (log) events mention X" counts them; neither is
# ever answered with a case search. Matched on the original text (IGNORECASE) so the
# searched value keeps its casing.
_LOG_NOUN = r"(?:logs?|log events?|log entries|log lines|log records|events)"
_LOG_SEARCH_RE = re.compile(
    r"^\s*(?:please\s+)?(?:(?:can|could|would) (?:you|we|i)\s+)?(?:please\s+)?"
    r"(?:search|grep|query|scan|filter|find|look|check|show|see|list|get|pull)(?:\s+me)?"
    r"(?:\s+(?:in|through|at|into|across))?\s+(?:the\s+|our\s+|all\s+(?:the\s+)?)?(?:raw\s+)?"
    rf"{_LOG_NOUN}\s+"
    r"(?:for|containing|that contain|which contain|mentioning|that mention|which mention|matching|"
    r"that match|which match|with|about|including|that include)\s+(?P<term>.+?)\s*$",
    re.IGNORECASE)
_LOG_SEARCH_FOR_RE = re.compile(
    r"^\s*(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:search|grep|look)\s+for\s+"
    r"(?P<term>.+?)\s+(?:in|across|through)\s+(?:the\s+|our\s+|all\s+(?:the\s+)?)?"
    rf"{_LOG_NOUN}(?P<rest>(?:\s+(?:in|over|for|during|from|within)\s+(?:the\s+)?(?:last|past|previous)\b"
    r"[^,;]*|\s+(?:today|yesterday|this week|this month))?)\s*[?.!]*\s*$",
    re.IGNORECASE)
_LOG_COUNT_RE = re.compile(
    r"^\s*(?:how many|count(?: the)?|number of)\s+(?:log\s+)?(?:events?|logs?|log entries|log lines)\s+"
    r"(?:contain|mention|match|include|have|with|containing|mentioning|matching|including|that contain|"
    r"that mention|that match|that include)\s+(?P<term>.+?)\s*$",
    re.IGNORECASE)
# The words of a log search that are not part of the searched value. The window
# pattern stops before a trailing "by <field>" so "… in the last 7 days by user" keeps
# its grouping.
_LOG_TERM_WINDOW_RE = re.compile(
    r"\s+(?:(?:in|over|for|during|from|within)\s+(?:the\s+)?(?:last|past|previous)\b"
    r"(?:(?!\s+(?:by|per)\s+[a-z]).)*|today|yesterday|this (?:week|month)|overnight)$", re.IGNORECASE)
_LOG_WINDOW_ONLY_RE = re.compile(
    r"^(?:(?:the\s+)?(?:last|past|previous)\b.*|today|yesterday|this (?:week|month)|overnight)$", re.IGNORECASE)
_LOG_TERM_GROUP_RE = re.compile(r"\s+(?:by|per)\s+((?:source |src )?[a-z]+(?: [a-z]+)?)$", re.IGNORECASE)
_LOG_TERM_FIELD_RE = re.compile(
    r"^(?:the\s+)?(?P<field>host(?:name)?|machine|server|endpoint|user(?:name)?|account|(?:source |src )?ip"
    r"(?: address)?|rule)\s+(?P<value>\S{1,200})$", re.IGNORECASE)
_LOG_TERM_FIELDS = {"host": "host", "hostname": "host", "machine": "host", "server": "host", "endpoint": "host",
                    "user": "user", "username": "user", "account": "user", "rule": "rule"}
# A value the analyst quoted is searched as written, whatever its words.
_LOG_TERM_QUOTED_RE = re.compile(
    r"[\"“](?P<dq>[^\"”]{1,200})[\"”]|(?<!\w)['‘`](?P<sq>[^'’`]{1,200})['’`](?!\w)")
# Where a request goes on past the searched value ("for mimikatz, then summarise",
# "for 203.0.113.7 and look it up"): the value ends there.
_LOG_TERM_CLAUSE_RE = re.compile(r"\s*[,;]\s*|\s+(?:and|then|&)\s+", re.IGNORECASE)
_LOG_TERM_PLEASE_RE = re.compile(r"(?:[\s,]+please)+$", re.IGNORECASE)
_LOG_TAIL_LEAD_RE = re.compile(r"^(?:(?:and|then|also|please|now)\b[\s,]*)+", re.IGNORECASE)
# A clause after the value that asks for more than the search ("…, then summarise it")
# is answered by the search itself; one that asks for a lookup is not (below).
_LOG_TAIL_VERB_RE = re.compile(
    r"^(?:summari[sz]e|explain|show|tell|give|build|make|create|write|draft|chart|plot|graph|break|group|split|"
    r"count|list|compare|rank|sort|highlight|display|put|turn|add|send|share|export)\b", re.IGNORECASE)
_LOG_TAIL_LOOKUP_RE = re.compile(r"\b(?:hunt|look ?(?:it |them )?up|reputation|ioc|indicator|check|investigat\w*|"
                                 r"pivot|sightings?|enrich\w*)\b", re.IGNORECASE)
# Words that send the question to another intent ("logs for the escalated cases",
# "events for the top hosts", "events about the campaign") or name a level rather than
# text ("events with severity high"): not a log text search.
_LOG_TERM_OTHER_INTENT_RE = re.compile(
    r"\b(?:cases?|incidents?|alerts?|campaigns?|top|most|least|noisiest|busiest|loudest|severity|severities|"
    r"priority)\b", re.IGNORECASE)
# A determiner, pronoun or connective makes a phrase about something ("this host",
# "the attacker IP", "anything suspicious", "a user"), never a value to search for:
# such a back-reference belongs to the conversation (or the case) instead.
_LOG_TERM_STOP_WORDS = frozenset({
    "a", "an", "the", "this", "that", "these", "those", "it", "its", "them", "their", "theirs", "his", "her",
    "hers", "him", "my", "our", "ours", "your", "me", "us", "and", "or", "then", "all", "any", "every", "each",
    "some", "please", "anything", "something", "everything", "nothing", "anyone", "someone", "here", "there",
    "what", "which", "who", "whom", "whose", "where", "when", "why", "how", "also", "just", "same", "other",
})
# Generic entity words: a term made only of these names no value ("attacker IP", "hosts").
_LOG_TERM_GENERIC = frozenset({
    "host", "hosts", "hostname", "hostnames", "user", "users", "username", "usernames", "ip", "ips", "address",
    "addresses", "account", "accounts", "machine", "machines", "server", "servers", "endpoint", "endpoints",
    "attacker", "attackers", "victim", "victims", "alert", "alerts", "case", "cases", "incident", "incidents",
    "entity", "entities", "campaign", "campaigns", "rule", "rules", "source", "sources", "destination",
    "destinations", "affected", "related", "suspicious", "malicious", "event", "events", "log", "logs",
    "activity", "traffic", "indicator", "indicators", "ioc", "iocs",
})
#: Longest unquoted free-text value taken as a search term (in words).
_LOG_TERM_MAX_WORDS = 4
_LOG_FIELD_NOUNS = {"ip": "IP", "user": "user", "host": "host", "rule": "rule"}
_REPORT_TEMPLATES = ("shift", "posture", "investigation", "hunt", "ioc", "executive", "monthly", "infographic",
                     "investigation_brief", "custom")


# --------------------------------------------------------------------------- #
# Time windows (Round 12 SPEC D7): every phrase an analyst uses for a period becomes
# the window spec the tools accept (``all``, ``now-90d``, ``now-6M``, ``this_month``,
# ``last_quarter``, ``ytd``, ``2026-09``, ``2026-Q3``, ``{"from", "to"}``). Nothing is
# shortened: 90 days stays 90 days, "lifetime" is all time. A month or quarter named
# without its year ("September", "since March") needs today's date, which the planner
# never reads from a clock: it is resolved from the latest calendar bucket of an anchor
# lookup (:func:`_anchor_call`) before the lookups that use it run.
# --------------------------------------------------------------------------- #
_MONTH_NUMBERS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
    "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
    "oct": 10, "nov": 11, "dec": 12,
}
_MONTH_LONG = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
               "October", "November", "December")
_MONTH_SHORT = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# Full month names, plus the short forms that are never ordinary words. "May" and
# "March" are verbs too, so alone they count only after a preposition or before a year.
_MONTH_WORD = (r"(?:january|february|march|april|may|june|july|august|september|october|november|"
               r"december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)")
_SAFE_MONTH_WORD = (r"(?:january|february|april|june|july|august|september|october|november|december|"
                    r"jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)")
_UNIT_LETTER = {"m": "h", "h": "h", "d": "d", "w": "w", "M": "M", "y": "y"}
_UNIT_WORDS = {"h": ("hour", "hours"), "d": ("day", "days"), "w": ("week", "weeks"),
               "M": ("month", "months"), "y": ("year", "years")}
_UNIT_HOURS = {"h": 1, "d": 24, "w": 168, "M": 720, "y": 8760}
# Calendar tokens (``engine.time_windows``): their words and an approximate span in
# hours (used only where a tool takes whole hours, such as the shift snapshot).
_CALENDAR = {
    "today": ("today", 24, "day"), "yesterday": ("yesterday", 24, "day"),
    "this_week": ("this week", 168, "week"), "last_week": ("last week", 168, "week"),
    "this_month": ("this month", 720, "month"), "last_month": ("last month", 720, "month"),
    "this_quarter": ("this quarter", 2160, "quarter"), "last_quarter": ("last quarter", 2160, "quarter"),
    "ytd": ("this year to date", 8760, "year"), "this_year": ("this year", 8760, "year"),
    "last_year": ("last year", 8760, "year"),
}
_CALENDAR_PHRASES: tuple[tuple[str, str], ...] = (
    (r"\b(?:ytd|year[- ]to[- ]date|so far this year|this year so far)\b", "ytd"),
    (r"\b(?:mtd|month[- ]to[- ]date|so far this month)\b", "this_month"),
    (r"\b(?:qtd|quarter[- ]to[- ]date|so far this quarter)\b", "this_quarter"),
    (r"\btoday(?:'s)?\b|\bthis morning\b|\bso far today\b", "today"),
    (r"\byesterday(?:'s)?\b", "yesterday"),
    (r"\b(?:this|current) week(?:'s)?\b|\bweek to date\b", "this_week"),
    (r"\b(?:last|previous|prior) week(?:'s)?\b", "last_week"),
    (r"\b(?:this|current) month(?:'s)?\b", "this_month"),
    (r"\b(?:last|previous|prior) month(?:'s)?\b", "last_month"),
    (r"\b(?:this|current) quarter(?:'s)?\b", "this_quarter"),
    (r"\b(?:last|previous|prior) quarter(?:'s)?\b", "last_quarter"),
    (r"\b(?:this|current) year(?:'s)?\b", "this_year"),
    (r"\b(?:last|previous|prior) year(?:'s)?\b", "last_year"),
)
_ALL_TIME_RE = re.compile(
    r"\b(?:all[- ]?time|lifetime|life[- ]time|of all time|ever|in total|since (?:we|the) (?:start(?:ed)?|began|"
    r"beginning)|since inception|since day one|from (?:the )?(?:start|beginning)|overall|to date|so far|"
    r"entire history|whole history|all (?:the )?(?:history|data|cases))\b")
_RELATIVE_RE = re.compile(
    r"\b(?:(?:in|over|for|during|within)\s+)?(?:the\s+)?(?:last|past|previous|prior|trailing|recent)\s+"
    r"(\d{1,4})\s*[- ]?(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|mo|years?|yrs?|y)\b")
_BARE_SPAN_RE = re.compile(
    r"\b(?:(?:in|over|for|during|within|across)\s+(?:the\s+)?)?(\d{1,4})[- ](hours?|days?|weeks?|months?|years?)"
    r"(?!\s+ago)\b")
_ISO_DATE = r"(\d{4}-\d{2}-\d{2})"
_ISO_RANGE_RE = re.compile(
    rf"\b(?:from|between)?\s*{_ISO_DATE}\s*(?:to|until|through|thru|and|-|–|\.\.)\s*{_ISO_DATE}\b")
_ISO_SINCE_RE = re.compile(rf"\b(?:since|after|from)\s+{_ISO_DATE}\b")
_ISO_DAY_RE = re.compile(rf"\b(?:on|for)\s+{_ISO_DATE}\b")
_QUARTER_YEAR_RE = re.compile(r"\bq([1-4])\s*[- ]?\s*(20\d\d)\b|\b(20\d\d)\s*[- ]?\s*q([1-4])\b")
_QUARTER_ONLY_RE = re.compile(r"\bq([1-4])\b")
_MONTH_YEAR_RE = re.compile(rf"\b{_MONTH_WORD}\.?\s+(?:of\s+)?(20\d\d)\b")
_ISO_MONTH_RE = re.compile(r"\b(20\d\d)-(0[1-9]|1[0-2])\b(?!-\d)")
_SINCE_MONTH_RE = re.compile(rf"\b(?:since|from|after)\s+(?:the\s+(?:start|beginning)\s+of\s+)?({_MONTH_WORD})\b"
                             r"(?:\s+(20\d\d))?")
_NAMED_MONTH_RE = re.compile(
    rf"\b(?:in|for|during|of|over|on)\s+({_MONTH_WORD})\b|\b({_SAFE_MONTH_WORD})\b(?:'s)?")
_YEAR_RE = re.compile(r"\b(?:in|for|during|of|year)\s+(20\d\d)\b|\b(20\d\d)\s+(?:report|review|summary|figures|"
                      r"numbers|stats|metrics|posture|performance)\b")
_CADENCE: tuple[tuple[str, str], ...] = (
    (r"\bdaily (?:report|summary|brief|digest|review)\b", "now-24h"),
    (r"\bweekly (?:report|summary|brief|digest|review)\b", "now-7d"),
    (r"\bmonthly (?:soc )?(?:report|summary|brief|digest|review)\b", "last_month"),
    (r"\bquarterly (?:report|summary|brief|digest|review)\b", "last_quarter"),
    (r"\b(?:annual|yearly) (?:report|summary|brief|digest|review)\b", "last_year"),
)


@dataclass(frozen=True)
class Win:
    """One window the question names: ``spec`` is what the tools are sent (``None``
    only while a month or quarter named without its year waits for the anchor),
    ``phrase`` the planner's own words for it, ``hours`` its span in whole hours when
    one is meaningful (a trailing window; an approximation for calendar periods)."""

    spec: Any
    phrase: str
    hours: int | None = None
    all_time: bool = False
    unit: str | None = None          # the calendar unit of a calendar period
    pending: tuple[str, int] | None = None   # ("month"|"since"|"quarter", n): needs the year

    @property
    def bounded(self) -> bool:
        return not self.all_time and self.spec is not None or self.pending is not None


def _relative(n: int, unit: str) -> Win:
    """``now-<n><unit>`` with its phrase ("the last 90 days", "the last hour")."""
    n = max(1, n)
    one, many = _UNIT_WORDS[unit]
    phrase = f"the last {one}" if n == 1 else f"the last {n} {many}"
    return Win(spec=f"now-{n}{unit}", phrase=phrase, hours=n * _UNIT_HOURS[unit])


def _relative_from(number: str, word: str) -> Win:
    n = int(number)
    letter = word[0]
    if word.startswith(("mo", "month")):
        letter = "M"
    elif letter == "m":
        # Minutes: the case, metric and cost lookups count whole hours, so a span in
        # minutes is the last hour (it never reads as months).
        return _relative(1, "h")
    return _relative(n, _UNIT_LETTER.get(letter, "d"))


def _month_win(year: int, month: int) -> Win:
    return Win(spec=f"{year:04d}-{month:02d}", phrase=f"{_MONTH_LONG[month - 1]} {year}", hours=720, unit="month")


def _quarter_win(year: int, quarter: int) -> Win:
    return Win(spec=f"{year:04d}-Q{quarter}", phrase=f"Q{quarter} {year}", hours=2160, unit="quarter")


def _since_win(year: int, month: int) -> Win:
    return Win(spec={"from": f"{year:04d}-{month:02d}-01"}, phrase=f"since {_MONTH_SHORT[month - 1]} {year}")


def _day_phrase(iso: str) -> str:
    try:
        year, month, day = (int(p) for p in iso.split("-"))
        return f"{day} {_MONTH_SHORT[month - 1]} {year}"
    except (ValueError, IndexError):
        return iso


def _window_from(lowered: str) -> Win | None:
    """The window the question names, or None (each lookup's own default applies)."""
    low = lowered
    match = _ISO_RANGE_RE.search(low)
    if match:
        a, b = match.group(1), match.group(2)
        return Win(spec={"from": a, "to": b}, phrase=f"{_day_phrase(a)} to {_day_phrase(b)}")
    match = _ISO_SINCE_RE.search(low)
    if match:
        return Win(spec={"from": match.group(1)}, phrase=f"since {_day_phrase(match.group(1))}")
    match = _ISO_DAY_RE.search(low)
    if match:
        return Win(spec=match.group(1), phrase=_day_phrase(match.group(1)), hours=24, unit="day")
    match = _QUARTER_YEAR_RE.search(low)
    if match:
        quarter = int(match.group(1) or match.group(4))
        year = int(match.group(2) or match.group(3))
        return _quarter_win(year, quarter)
    match = _SINCE_MONTH_RE.search(low)
    if match:
        # After "since", "from" or "after", even "May" and "March" are months.
        month = _MONTH_NUMBERS[match.group(1)]
        if match.group(2):
            return _since_win(int(match.group(2)), month)
        return Win(spec=None, phrase=f"since {_MONTH_LONG[month - 1]}", pending=("since", month))
    match = _MONTH_YEAR_RE.search(low)
    if match:
        word = re.match(_MONTH_WORD, match.group(0)).group(0)  # type: ignore[union-attr]
        return _month_win(int(match.group(1)), _MONTH_NUMBERS[word])
    match = _ISO_MONTH_RE.search(low)
    if match:
        return _month_win(int(match.group(1)), int(match.group(2)))
    for pattern, token in _CADENCE:
        if re.search(pattern, low) and not _NAMED_MONTH_RE.search(low):
            return _token_win(token)
    # "In the last week" and "over the past month" are rolling spans; "last week" and
    # "last month" (no article) are the calendar periods.
    match = re.search(r"\bthe (?:last|past) (week|month|year)\b", low)
    if match:
        return {"week": _relative(7, "d"), "month": _relative(30, "d"), "year": _relative(12, "M")}[match.group(1)]
    for pattern, token in _CALENDAR_PHRASES:
        if re.search(pattern, low):
            return _token_win(token)
    match = _RELATIVE_RE.search(low)
    if match:
        return _relative_from(match.group(1), match.group(2))
    if _ALL_TIME_RE.search(low):
        return Win(spec="all", phrase="all time", all_time=True)
    match = _NAMED_MONTH_RE.search(low)
    if match:
        word = match.group(1) or match.group(2)
        return Win(spec=None, phrase=_MONTH_LONG[_MONTH_NUMBERS[word] - 1],
                   pending=("month", _MONTH_NUMBERS[word]), unit="month", hours=720)
    match = _QUARTER_ONLY_RE.search(low)
    if match:
        quarter = int(match.group(1))
        return Win(spec=None, phrase=f"Q{quarter}", pending=("quarter", quarter), unit="quarter", hours=2160)
    match = _YEAR_RE.search(low)
    if match:
        year = int(match.group(1) or match.group(2))
        return Win(spec=str(year), phrase=str(year), hours=8760, unit="year")
    if re.search(r"\b(?:last|past|previous) hour\b|\bthis hour\b", low):
        return _relative(1, "h")
    if re.search(r"\b(?:last|past|previous) day\b|\b24 ?h(?:ours?|rs?)?\b|\b(?:last|past) 24\b", low):
        return _relative(24, "h")
    if re.search(r"\b(?:past|last few|recent) (?:week|7 days)\b|\bthis past week\b", low):
        return _relative(7, "d")
    if re.search(r"\bpast month\b", low):
        return _relative(30, "d")
    if re.search(r"\bpast quarter\b", low):
        return _relative(3, "M")
    if re.search(r"\bpast year\b|\blast 12 months\b", low):
        return _relative(12, "M")
    if re.search(r"\bovernight\b", low):
        return _relative(12, "h")
    match = _BARE_SPAN_RE.search(low)
    if match:
        return _relative_from(match.group(1), match.group(2))
    return None


def _token_win(token: str) -> Win:
    if token in _CALENDAR:
        phrase, hours, unit = _CALENDAR[token]
        return Win(spec=token, phrase=phrase, hours=hours, unit=unit)
    match = re.fullmatch(r"now-(\d+)([hdwMy])", token)
    if match:
        return _relative(int(match.group(1)), match.group(2))
    return Win(spec=token, phrase=token)


def _anchored(win: Win | None, anchor: tuple[int, int] | None) -> Win | None:
    """A named month or quarter given its year from ``anchor`` (the current year and
    month, read from the anchor lookup's latest calendar bucket): the most recent one
    that is not in the future."""
    if win is None or win.pending is None:
        return win
    if anchor is None:
        return None
    year, month = anchor
    kind, number = win.pending
    if kind == "quarter":
        current = (month - 1) // 3 + 1
        return _quarter_win(year if number <= current else year - 1, number)
    target = year if number <= month else year - 1
    return _since_win(target, number) if kind == "since" else _month_win(target, number)


def _hours_from(lowered: str) -> int | None:
    """The span in hours of the window the question names (None without one)."""
    win = _window_from(lowered)
    return win.hours if win is not None else None


def _time_from(hours: int) -> str:
    # Whole days from two days up ("last 7d"), hours below that ("last 24h"): the tools
    # echo this expression in their window label, and "last 1d" reads oddly.
    return f"now-{hours // 24}d" if hours >= 48 and hours % 24 == 0 else f"now-{hours}h"


# Comparisons (SPEC P0-6): the compared period, as ``compare`` takes it.
_COMPARE_YOY_RE = re.compile(
    r"\bsame (?:period|time|week|month|quarter|day|days) (?:last|a|the previous|previous|prior) year\b|"
    r"\b(?:year[- ]over[- ]year|yoy|vs\.? (?:the )?same (?:period|time) last year)\b")
_COMPARE_PREVIOUS_RE = re.compile(
    r"\b(?:vs\.?|versus|compared? (?:to|with)|against|than|relative to)\s+(?:the\s+)?(?:last|previous|prior|"
    r"preceding|earlier|month before|week before|quarter before)\b|"
    r"\b(?:month|week|quarter|year|day)[- ]over[- ](?:month|week|quarter|year|day)\b|\b(?:mom|wow|qoq)\b|"
    r"\bcompared? (?:this|the current|our)\b|\bchanged? (?:since|from) (?:last|the previous)\b|"
    r"\bbetter or worse\b|\bimprov(?:ed|ing) (?:since|from|over)\b")
_COMPARE_STRIP_RE = re.compile(
    r"\b(?:vs\.?|versus|compared? (?:to|with)|against|than|relative to)\b.*$")


def _compare_from(lowered: str) -> Any:
    """``compare`` for a comparison question, else None."""
    if _COMPARE_YOY_RE.search(lowered):
        return "same_period_last_year"
    if _COMPARE_PREVIOUS_RE.search(lowered):
        return "previous_period"
    return None


def _compare_window(lowered: str) -> Win | None:
    """The window a comparison is ABOUT: the period before "vs", else the one named
    ("this month vs last month" is this month, compared with the one before)."""
    head = _COMPARE_STRIP_RE.sub("", _COMPARE_YOY_RE.sub("", lowered)).strip()
    win = _window_from(head) if head else None
    if win is None:
        win = _window_from(lowered)
    if win is not None and win.spec in ("last_week", "last_month", "last_quarter", "last_year") and re.search(
            r"\b(?:this|current)\b", lowered):
        win = _token_win(win.spec.replace("last_", "this_"))
    if win is None:
        unit = next((u for u, words in (("this_month", "month"), ("this_week", "week"),
                                         ("this_quarter", "quarter"), ("this_year", "year"))
                     if re.search(rf"\b{words}\b", lowered)), "this_month")
        win = _token_win(unit)
    return win


#: A breakdown by creation time: the calendar unit a question asks for.
_BUCKET_WORDS: tuple[tuple[str, str], ...] = (
    (r"\bmonth[- ]?wise\b|\b(?:by|per|each|every|a) month\b|\bmonthly\b|\bmonth by month\b|"
     r"\bmonth[- ]on[- ]month\b|\bsegregat\w* (?:\w+ ){0,3}month|\bper calendar month\b", "month"),
    (r"\bweek[- ]?wise\b|\b(?:by|per|each|every|a) week\b|\bweekly\b|\bweek by week\b", "week"),
    (r"\bday[- ]?wise\b|\b(?:by|per|each|every|a) day\b|\bdaily\b|\bday by day\b", "day"),
    (r"\bquarter[- ]?wise\b|\b(?:by|per|each|every|a) quarter\b|\bquarterly\b", "quarter"),
    (r"\byear[- ]?wise\b|\b(?:by|per|each|every|a) year\b|\byearly\b|\bannually\b", "year"),
    (r"\bhour[- ]?wise\b|\b(?:by|per|each|every|an) hour\b|\bhourly\b", "hour"),
)


def _bucket_from(lowered: str) -> str | None:
    return next((unit for pattern, unit in _BUCKET_WORDS if re.search(pattern, lowered)), None)


#: The window a breakdown by ``unit`` covers when the question names none.
_BUCKET_DEFAULT_WINDOWS = {"hour": "now-24h", "day": "now-30d", "week": "now-12w", "month": "now-12M",
                           "quarter": "all", "year": "all"}


def _bucket_default(unit: str | None) -> Win | None:
    token = _BUCKET_DEFAULT_WINDOWS.get(unit or "")
    if token is None:
        return None
    return Win(spec="all", phrase="all time", all_time=True) if token == "all" else _token_win(token)


def _natural_bucket(win: Win | None) -> str:
    """The calendar unit a breakdown of ``win`` reads best in (at most ~60 points)."""
    if win is None or win.all_time or win.pending is not None:
        return "month" if win is not None else "day"
    unit = win.unit
    if unit == "day":
        return "hour"
    if unit == "week":
        return "day"
    if unit == "month":
        return "week"
    if unit in ("quarter", "year"):
        return "month" if unit == "year" else "week"
    hours = win.hours or 24
    if hours <= 48:
        return "hour"
    if hours <= 24 * 45:
        return "day"
    if hours <= 24 * 200:
        return "week"
    return "month"


#: Case groupings (``case_stats group_by``) by the words that ask for them.
_CASE_GROUP_WORDS: tuple[tuple[str, str], ...] = (
    (r"\bwho (?:closed|resolved)\b|\bclosed (?:the )?most\b|\b(?:by|per) (?:closer|who closed)\b|"
     r"\bclosed by (?:analyst|whom|who)\b|\bwhich analysts? (?:closed|resolved)\b", "closed_by"),
    (r"\b(?:by|per|across|for each) (?:assignee|analyst|owner|person)s?\b|\bwho (?:is|are) (?:assigned|working)\b|"
     r"\bassigned to (?:whom|who)\b|\bwhich analysts?\b|\bper analyst\b|\banalyst workload\b", "assignee"),
    (r"\b(?:by|per|across|for each) severit(?:y|ies)\b|\bseverity (?:breakdown|split|mix)\b", "severity"),
    (r"\b(?:by|per|across|for each) (?:status|state)(?:es)?\b|\bstatus (?:breakdown|split|mix)\b", "status"),
    (r"\b(?:by|per|across|for each) verdicts?\b|\bverdict (?:breakdown|split)\b", "verdict"),
    (r"\b(?:by|per|across|for each) priorit(?:y|ies)\b", "priority"),
    (r"\b(?:by|per|across|for each) (?:detection )?rules?\b|\b(?:top|noisiest) (?:detection )?rules\b|"
     r"\bwhich rules?\b", "rule"),
    (r"\b(?:by|per|across|for each) (?:log )?sources?\b|\bwhich sources?\b", "source"),
    (r"\b(?:by|per|across|for each) (?:disposition|classification)s?\b", "disposition"),
    (r"\b(?:by|per|across|for each) (?:att&ck |mitre )?tactics?\b", "mitre_tactic"),
    (r"\b(?:by|per|across|for each) (?:att&ck |mitre )?techniques?\b", "mitre_technique"),
    (r"\b(?:decided by|who decided|by decision maker)\b", "decided_by"),
    (r"\bopen (?:vs\.?|versus|and) closed\b", "status_group"),
)


def _case_group_from(lowered: str) -> str | None:
    return next((fld for pattern, fld in _CASE_GROUP_WORDS if re.search(pattern, lowered)), None)


def _indicator(question: str, lowered: str) -> tuple[str, str] | None:
    match = _URL_RE.search(question)
    if match:
        return match.group(0).rstrip(".,;:!?)"), "url"
    match = _IPV4_RE.search(question)
    if match:
        return match.group(0), "ip"
    match = _HASH_RE.search(question)
    if match:
        return match.group(0).lower(), "hash"
    if _HUNT_CUE_RE.search(lowered) or len(lowered.split()) <= 4:
        for match in _DOMAIN_RE.finditer(question):
            value = match.group(0).lower().rstrip(".")
            suffix = value.rsplit(".", 1)[-1]
            if suffix in _FILE_SUFFIXES or "_" in value:
                continue
            if _CASE_ID_RE.fullmatch(value) or re.fullmatch(r"[\d.]+", value):
                continue
            if value.count(".") >= 1 and not value.startswith("e.g"):
                return value, "domain"
    return None


def _case_id(question: str) -> str | None:
    match = _CASE_ID_RE.search(question)
    if match and re.search(r"\d", match.group(1)):
        return match.group(1).rstrip(".:")
    match = _CASE_WORD_ID_RE.search(question)
    if match and re.search(r"\d", match.group(1)):
        return match.group(1).rstrip(".:")
    return None


def _case_status(lowered: str) -> str | None:
    for word, status in (("escalat", "escalated"), ("on hold", "on_hold"), ("investigating", "investigating"),
                         ("closed", "closed"), ("resolved", "resolved"), ("new case", "new")):
        if word in lowered:
            return status
    return None


def _keyword(lowered: str) -> tuple[str, str] | None:
    for pattern, keyword, name in _CASE_KEYWORDS:
        if re.search(pattern, lowered):
            return keyword, name
    return None


def _metric(lowered: str) -> tuple[str, str] | None:
    for pattern, kind, name in _METRIC_TERMS:
        if re.search(pattern, lowered):
            return kind, name
    return None


def _group_field(lowered: str) -> str | None:
    match = re.search(r"\b(?:by|per|across)\s+((?:source |src )?[a-z]+(?: [a-z]+)?)", lowered)
    if not match:
        return None
    phrase = match.group(1)
    for words, fld in _GROUP_FIELDS:
        if phrase == words or phrase.startswith(words + " ") or phrase.startswith(words):
            return fld
    return None


def _requested_view(lowered: str) -> str | None:
    match = re.search(r"\b(?:as|into|in|to)\s+(?:a\s+|an\s+)?([a-z ]{3,30}?)(?:\s+(?:chart|view|graph))?\s*[?.!]*$",
                      lowered)
    phrase = match.group(1) if match else ""
    if not phrase:
        match = re.search(r"\b(?:as|into)\s+(?:a\s+|an\s+)?([a-z ]{3,30})", lowered)
        phrase = match.group(1) if match else ""
    for word, view in _VIEW_WORDS:
        if word in phrase:
            return view
    return None


def _help_topic(question: str) -> str:
    """The Help Center query: the first clause, without question scaffolding."""
    text = re.split(r",?\s+and\s+(?=what|how|where|which|who|can|is|are)", question.strip(), maxsplit=1)[0]
    text = re.sub(r"^\s*(?:/help\s+|how (?:do|can|should) (?:i|we)\s+|how to\s+|where (?:do|can|should) "
                  r"(?:i|we)\s+|where (?:is|are)\s+|what (?:is|are|does|do)\s+|can (?:i|we)\s+|"
                  r"is it possible to\s+|help me\s+(?:with\s+)?|please\s+)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+in this console\b", "", text, flags=re.IGNORECASE)
    text = text.strip(" ?.!")
    return display_text(text or question, 200)


#: Words that ask for a report (or one of its forms) in this question.
_REPORT_NOUN_RE = re.compile(
    r"\b(reports?|brief|briefing|infographics?|one[- ]pager|executive (?:summary|overview|brief)|"
    r"exec summary)\b")
#: A request to MAKE one ("create a report", "give me whatever reports you can"):
#: the header then asks the server to save it to Reports (SPEC D11).
_SAVE_REPORT_RE = re.compile(
    r"\b(?:create|make|build|generate|produce|prepare|give|write|draft|compile|put together|save|export|"
    r"turn|need|want|send|share|run|do|get|pull)\b|\breports? you can\b|^\s*(?:/report|report|an? report)\b")
#: Performance words: a report about how the SOC is doing, not about one case or hunt.
_PERFORMANCE_RE = re.compile(
    r"\b(performance|lifetime|how (?:are|did|have) we (?:been )?doing|how did we do|kpis?|metrics|posture|"
    r"overall|whatever reports?|soc report|security report|operations report|summary report|status report|"
    r"management report|board report|leadership|stakeholders?|numbers)\b")


def _report_request(lowered: str, question: str = "") -> tuple[str | None, tuple[str, ...]]:
    if not _REPORT_NOUN_RE.search(lowered):
        return None, ()
    template = next((t for t in _REPORT_TEMPLATES if re.search(rf"\b{t.replace('_', ' ')}\b", lowered)), None)
    if re.search(r"\binvestigation brief\b|\bbrief (?:for|on|about) (?:case|incident)\b|\bcase brief\b", lowered):
        template = "investigation_brief"
    elif re.search(r"\binfographics?\b|\bone[- ]pager\b|\bvisual (?:summary|report)\b", lowered):
        template = "infographic"
    elif re.search(r"\bexec(?:utive)? (?:summary|overview|brief|report)\b|\bboard report\b|\bleadership\b", lowered):
        template = "executive"
    elif template is None and (re.search(r"\bmonthly\b", lowered) or (
            (_MONTH_YEAR_RE.search(lowered) or _NAMED_MONTH_RE.search(lowered) or _ISO_MONTH_RE.search(lowered))
            and re.search(r"\breports?\b", lowered))):
        template = "monthly"
    elif template is None and re.search(r"\b(performance|lifetime)\b", lowered):
        template = "executive"
    if template is None and re.search(r"\b(handoff|hand-off|handover|brief|briefing)\b", lowered):
        template = "shift"
    headings: tuple[str, ...] = ()
    match = _SECTIONS_RE.search(question or lowered)
    if match:
        # Headings keep the analyst's own casing ("IOC", "Next steps").
        parts = [p.strip(" .") for p in re.split(r",|\band\b", match.group(1)) if p.strip(" .")]
        headings = tuple(_sentence(display_text(p, 60)).rstrip(".") for p in parts[:8])
    return template or "custom", headings


_RESHAPE_STOP_WORDS = frozenset({
    "show", "that", "this", "those", "them", "these", "same", "chart", "graph", "view", "with", "into", "make",
    "turn", "display", "the", "instead", "please", "can", "you", "now", "previous", "last", "answer", "and",
    "for", "one", "put", "give", "change", "switch", "convert", "plot", "draw", "render", "again", "use",
    "horizontal", "vertical", "stacked", "column", "columns", "bar", "bars", "donut", "doughnut", "pie", "table",
    "line", "area", "funnel", "kpi", "kpis", "timeline", "sparkline", "instead", "not",
})


def _content_words(text: str) -> set[str]:
    """The words of ``text`` that name a subject (not a view or a back-reference)."""
    return set(re.findall(r"[a-z]{3,}", text.lower())) - _RESHAPE_STOP_WORDS


_LogFilter = tuple[tuple[str, str], ...]


def _log_term_split(term: str) -> tuple[str, str]:
    """``term`` cut where the request goes on past the searched value (a comma, "and",
    "then"): ``(value, rest)``. A quoted value is never cut inside its quotes."""
    quoted = _LOG_TERM_QUOTED_RE.search(term)
    cut = _LOG_TERM_CLAUSE_RE.search(term, quoted.end() if quoted else 0)
    if cut is None:
        return term, ""
    return term[:cut.start()], term[cut.end():]


def _log_term_strip(text: str) -> tuple[str, str | None]:
    """``text`` without its trailing window, "by <field>" grouping and "please", in
    either order: ``(value, group field)``."""
    # A leading space lets a bare "by user" or "in the last day" (a clause of its own)
    # match the same trailing patterns.
    text = " " + _LOG_TERM_PLEASE_RE.sub("", re.sub(r"[?!.]+$", "", text.strip())).strip()
    group: str | None = None
    for _ in range(2):
        grouped = _LOG_TERM_GROUP_RE.search(text)
        fld = _group_field(f"by {grouped.group(1).lower()}") if grouped else None
        if grouped and fld is not None:
            group = group or fld
            text = text[:grouped.start()]
        text = _LOG_TERM_WINDOW_RE.sub("", text)
    return text.strip(), group


def _log_term_filter(text: str, *, case_scoped: bool) -> _LogFilter | None:
    """One searched value as a log filter, else None (``text`` names no value).

    A quoted value is searched as written; a value named by its field ("host web-01")
    or an IPv4 address filters that field. Unquoted free text becomes a ``contains``
    filter only when it is a short run of words with no determiner, pronoun or
    connective ("this host", "the attacker IP", "anything suspicious" are references,
    not values), not only generic entity words ("attacker IP"), and naming no case,
    campaign or top-N subject; in the Case Manager chat (``case_scoped``) only a single
    word qualifies, so everyday references to the case's own entities stay case
    questions."""
    quoted = _LOG_TERM_QUOTED_RE.fullmatch(text)
    if quoted:
        value = (quoted.group("dq") or quoted.group("sq") or "").strip()
        return (("contains", value[:200]),) if value else None
    named = _LOG_TERM_FIELD_RE.match(text)
    if named:
        value = named.group("value").strip("\"'`\u201c\u201d\u2018\u2019")
        if not value or value.lower() in _LOG_TERM_STOP_WORDS or value.lower() in _LOG_TERM_GENERIC:
            return None
        word = named.group("field").lower()
        fld = "ip" if word.endswith(("ip", "address")) else _LOG_TERM_FIELDS.get(word, "host")
        return ((fld, value[:200]),)
    if _IPV4_RE.fullmatch(text):
        return (("ip", text),)
    words = [w.lower() for w in text.split()]
    if (not words or len(words) > (1 if case_scoped else _LOG_TERM_MAX_WORDS)
            or any(w in _LOG_TERM_STOP_WORDS for w in words) or all(w in _LOG_TERM_GENERIC for w in words)
            or _LOG_TERM_OTHER_INTENT_RE.search(text)):
        return None
    return (("contains", text[:200]),)


def _log_search(question: str, *, case_scoped: bool = False) -> tuple[str, _LogFilter, str | None] | None:
    """``(intent, filter, group field)`` for explicit log-search phrasing, else None.

    ``intent`` is ``logs`` (``search_logs``) or ``log_count`` (``log_stats``, for "how
    many events mention X"). The filter is the searched value (:func:`_log_term_filter`).
    A window or a "by <field>" grouping the question names is taken off the value (the
    window is read separately). The value ends at a comma, "and" or "then": a clause
    after it may group the count, name a window, add a second field-named value, or ask
    for more than the search ("then summarise"), which the search answers. None — so
    the other rules answer — when the question names no value (a back-reference such as
    "logs for this host"), asks for a named report ("… and build a hunt report"), or
    goes on to a lookup ("… and look it up"), a case, a campaign or a top-N."""
    intent = "logs"
    match = _LOG_COUNT_RE.match(question)
    if match:
        intent = "log_count"
    else:
        match = _LOG_SEARCH_RE.match(question) or _LOG_SEARCH_FOR_RE.match(question)
    if match is None:
        return None
    template, _headings = _report_request(question.lower())
    if template not in (None, "custom"):
        return None
    head, tail = _log_term_split(match.group("term").strip())
    head, group = _log_term_strip(head)
    log_filter: _LogFilter | None
    if not head or _LOG_WINDOW_ONLY_RE.match(head):
        # "Show me the logs for today": the window's events, no value to search for.
        # In the Case Manager chat that question is about the case's own logs.
        log_filter = None if case_scoped else ()
    else:
        log_filter = _log_term_filter(head, case_scoped=case_scoped)
    if log_filter is None:
        return None
    rest = _LOG_TAIL_LEAD_RE.sub("", tail.strip(" ,;")).strip(" ,;")
    if rest:
        if _LOG_TAIL_LOOKUP_RE.search(rest) or _LOG_TERM_OTHER_INTENT_RE.search(rest):
            return None
        value, rest_group = _log_term_strip(rest)
        group = group or rest_group
        if value and not _LOG_WINDOW_ONLY_RE.match(value) and not _LOG_TAIL_VERB_RE.match(value):
            # A second value joins the search only when it names another field ("host
            # web-01 and user bob"); "mimikatz and powershell" is not one text search.
            more = _log_term_filter(value, case_scoped=False)
            if more is None or more[0][0] == "contains" or more[0][0] in {key for key, _value in log_filter}:
                return None
            log_filter = log_filter + more
    return intent, log_filter, group


#: An object that makes a create/make/build request an ANSWER (a report, a chart, a
#: breakdown), never a change: "Create a report of lifetime performance" is a report.
_ANSWER_OBJECT_RE = re.compile(
    r"\b(reports?|brief|briefing|summary|summaries|overview|charts?|graphs?|plots?|tables?|lists?|breakdowns?|"
    r"exports?|infographics?|one[- ]pager|digest|analysis|recap|rundown|snapshot|review|timeline|"
    r"visuali[sz]ations?|comparison|trend|stats|statistics)\b")
_ANSWER_VERB_RE = re.compile(
    r"^\s*(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:create|make|build|generate|produce|prepare|draft|"
    r"compile|write|give|put together|export)\b")


def _is_change(low: str) -> bool:
    """A request to change something (chat is read-only). Asking to create, make,
    build or generate a report, chart, table or breakdown is not one (SPEC D9)."""
    if not _CHANGE_RE.match(low) or low.startswith(("show", "list", "summar")):
        return False
    return not (_ANSWER_VERB_RE.match(low) and _ANSWER_OBJECT_RE.search(low))


#: "Investigate everything about host dc01", "deep dive into user pnair".
_DEEP_RE = re.compile(
    r"\b(everything (?:about|on|for)|all (?:about|activity (?:of|for|from|on))|deep[- ]?dive|full (?:investigation|"
    r"picture|history)|in depth|in-depth|thorough(?:ly)?|complete (?:investigation|picture|history)|"
    r"leave no stone|end[- ]to[- ]end)\b")
_DEEP_ENTITY_RE = re.compile(
    r"\b(host(?:name)?|machine|server|endpoint|workstation|user(?:name)?|account|ip(?: address)?)\s+"
    r"[\"'`]?([A-Za-z0-9][A-Za-z0-9._@\\-]{1,62})[\"'`]?")
_DEEP_KINDS = {"host": "host", "hostname": "host", "machine": "host", "server": "host", "endpoint": "host",
               "workstation": "host", "user": "user", "username": "user", "account": "user", "ip": "ip",
               "ip address": "ip"}
_DEEP_STOP = frozenset({"the", "this", "that", "it", "a", "an", "our", "their", "over", "in", "for", "during",
                        "and", "with", "from", "last", "past", "activity", "behaviour", "behavior", "logs"})


def _deep_entity(question: str) -> tuple[str, str] | None:
    """``(kind, value)`` of the host, user or IP an in-depth investigation is about."""
    match = _IPV4_RE.search(question)
    if match:
        return "ip", match.group(0)
    for found in _DEEP_ENTITY_RE.finditer(question):
        value = found.group(2).strip(".,;:")
        if value.lower() in _DEEP_STOP or value.lower() in _LOG_TERM_GENERIC:
            continue
        return _DEEP_KINDS.get(found.group(1).lower(), "host"), value
    return None


#: Trend subjects: what a "trend" or "over time" question is about.
_TREND_SUBJECTS: tuple[tuple[str, str], ...] = (
    (r"\bmtt[adr]\b|\bmean time\b|\bresponse times?\b|\btime to (?:acknowledge|resolve|detect|respond)\b|"
     r"\bdwell\b|\bresolution time\b|\back(?:nowledg\w*)? time\b", "timing"),
    (r"\bfalse[- ]positive rate\b|\bfp rate\b|\bfalse positives?\b|\btrue[- ]positive rate\b|\btp rate\b|"
     r"\bautomation rate\b|\bauto[- ]?clos\w* rate\b|\bfp\b", "rates"),
    (r"\b(?:ai |llm |model )?(?:cost|costs|spend|spending|tokens?|budget)\b", "cost"),
    (r"\balerts?\b|\bevents?\b|\blog volume\b|\bingest\w*\b|\bnoise\b", "alerts"),
    (r"\brisk\b", "risk"),
    (r"\bcases?\b|\bincidents?\b|\bcase volume\b|\bworkload\b|\bbacklog\b", "cases"),
)
_TREND_RE = re.compile(
    r"\btrends?\b|\btrending\b|\bover time\b|\btrendline\b|\btime series\b|\bhistory of\b|\bevolution\b|"
    r"\b(?:going|gone|went) (?:up|down)\b|\b(?:month|week|quarter|day)[- ]over[- ](?:month|week|quarter|day)\b")


def _trend_subject(low: str) -> str | None:
    return next((subject for pattern, subject in _TREND_SUBJECTS if re.search(pattern, low)), None)


#: Genuinely ambiguous asks (SPEC D10): nothing to pick a reasonable default from.
_CLARIFY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"^\s*(?:please\s+)?(?:show|give|draw|plot|chart|display|get)?\s*(?:me\s+)?(?:the\s+|a\s+|our\s+)?"
     r"(?:trends?|trend ?lines?|graph|chart)\s*(?:please)?[?.!]*\s*$", "trend"),
    (r"^\s*(?:what(?:'s| is) the )?trend\??\s*$|^\s*how(?:'s| is) it trending\??\s*$", "trend"),
    (r"^\s*(?:please\s+)?compare(?:\s+(?:them|it|these|those|please))?\s*[?.!]*\s*$|^\s*(?:show|give)\s+(?:me\s+)?"
     r"(?:a\s+)?comparison\s*[?.!]*\s*$", "compare"),
    (r"^\s*(?:how many|how much|what(?:'s| is) the (?:count|number|total))\s*[?.!]*\s*$", "count"),
    (r"^\s*(?:please\s+)?(?:break (?:it|this|that) down|breakdown|split (?:it|this) up)\s*[?.!]*\s*$", "breakdown"),
)
#: The options each clarify offers (each ≤ 80 characters), and what a pick means.
CLARIFY_OPTIONS: dict[str, tuple[str, tuple[str, ...]]] = {
    "trend": ("Trend of what?", ("Alerts", "Cases", "AI cost", "FP rate")),
    "compare": ("Which periods should I compare?",
                ("This month vs last month", "This week vs last week", "This quarter vs last quarter",
                 "This month vs the same month last year")),
    "count": ("Count what?", ("Open cases", "Cases this week", "Alerts in the last 24 hours", "AI spend today")),
    "breakdown": ("Break down what, and by what?",
                  ("Cases by month", "Cases by severity", "Alerts by host", "AI spend by model")),
}
#: A bare clarify option the analyst picked, as the full question it stands for.
_CLARIFY_RESOLVE: dict[tuple[str, str], str] = {
    ("trend", "alerts"): "Show the alert trend for the last 30 days by day",
    ("trend", "cases"): "Show the case trend for the last 30 days by day",
    ("trend", "ai cost"): "Show the AI cost trend for the last 30 days by day",
    ("trend", "fp rate"): "Show the false-positive rate trend for the last 30 days by week",
    ("trend", "false-positive rate"): "Show the false-positive rate trend for the last 30 days by week",
}


def _clarify_kind(low: str, view: PromptView) -> str | None:
    """The clarify a question needs, else None. A follow-up with an earlier answer to
    work from ("chart it", "compare them") is not ambiguous."""
    for pattern, kind in _CLARIFY_PATTERNS:
        if re.search(pattern, low):
            if kind in ("breakdown", "compare") and (view.prior_calls or view.prior_blocks):
                return None
            if kind == "trend" and re.search(r"\b(chart|graph)\b", low) and view.prior_blocks:
                return None
            return kind
    return None


def _resolve_clarified(question: str, view: PromptView) -> str:
    """A bare clarify option ("Cases") as the question it answers, read from the
    analyst's previous question (their own words) when that one needed a clarify."""
    if not view.prior_questions:
        return question
    previous = view.prior_questions[-1].strip().lower()
    kind = next((k for pattern, k in _CLARIFY_PATTERNS if re.search(pattern, previous)), None)
    if kind is None:
        return question
    key = (kind, question.strip().strip(".!?").lower())
    return _CLARIFY_RESOLVE.get(key, question)


def _two_periods(low: str) -> tuple[Win, Win] | None:
    """``(window, other)`` for "Q3 vs Q2", "September vs August", "2026-09 vs 2026-08"."""
    if not re.search(r"\b(?:vs\.?|versus|compared? (?:to|with)|against|and)\b", low):
        return None
    parts = re.split(r"\b(?:vs\.?|versus|compared? (?:to|with)|against|and)\b", low, maxsplit=1)
    if len(parts) != 2:
        return None
    first, second = _window_from(parts[0]), _window_from(parts[1])
    if first is None or second is None or first.unit is None or first.unit != second.unit:
        return None
    if first.unit not in ("month", "quarter", "year"):
        return None
    return first, second


#: A case-store subject ("cases", "incidents", "tickets") for breakdowns and counts.
_CASE_SUBJECT_RE = re.compile(r"\b(cases?|incidents?|tickets?|investigations?|escalations?)\b")
_COUNT_CUE_RE = re.compile(
    r"\b(how many|number of|count|total|amount of|volume|stats|statistics|breakdown|break(?:ing)? down|split|"
    r"distribution|segregat\w*|group(?:ed)? by|per|each|every|tally)\b")


def classify(question: str, view: PromptView | None = None) -> Ask:
    """The intent of ``question`` (deterministic regex rules; order matters)."""
    view = view or PromptView()
    q = _resolve_clarified((question or "").strip(), view)
    low = q.lower()
    compare: Any = _compare_from(low)
    compare_win: Win | None = None
    if compare is not None:
        win: Win | None = _compare_window(low)
    else:
        two = _two_periods(low)
        win = _window_from(low)
        if two is not None:
            win, compare_win = two
            compare = "explicit"
    hours = win.hours if win is not None else None
    template, headings = _report_request(low, q)
    # A report request is saved to Reports (SPEC D11) unless it is a question ABOUT
    # reports ("how do I export a report?") or a shift brief that names no report.
    save = bool(template) and not re.search(
        r"^\s*(?:how|where|what|why|when|which|can i|is there|are there|do we|does|did)\b", low) and (
        template != "shift" or bool(re.search(r"\breports?\b", low)))
    base: dict[str, Any] = {"question": q, "lowered": low, "hours": hours, "topic": _help_topic(q),
                            "report": template, "headings": headings, "win": win, "compare": compare,
                            "compare_win": compare_win, "bucket": _bucket_from(low), "group": _case_group_from(low),
                            "save": save}

    def ask(intent: str, **extra: Any) -> Ask:
        fields = dict(base)
        fields.update(extra)
        return Ask(intent=intent, **fields)

    if not q:
        return ask("empty")
    remember = _REMEMBER_RE.match(q)
    if remember and not re.search(r"\?\s*$", q):
        return ask("remember", memory=display_text(remember.group(1).strip(), 500))
    if _is_change(low):
        return ask("change", save=False)

    # Follow-ups that reuse an earlier answer (SPEC §4.3 digest + stored block ids).
    requested_view = _requested_view(low)
    refers_back = bool(re.search(r"\b(that|it|this|those|them|these|same|previous|last answer)\b", low))
    # A view change needs a back-reference, a phrase that names nothing but the view
    # ("as a donut"), or a subject matching an earlier block's title ("the severity
    # chart as a bar chart"); "top hosts as a table" with no hosts block is a new ask.
    content = _content_words(low)
    titled = any(content & _content_words(b.title) for b in view.prior_blocks
                 if requested_view in b.views)
    if view.prior_blocks and requested_view and (refers_back or titled or not content):
        return ask("reshape", view=requested_view)
    group = _group_field(low)
    log_history = any(c.tool in ("log_stats", "search_logs") for c in view.prior_calls)
    if log_history and group and (refers_back or re.match(r"^\s*(chart|break|split|group|now)\b", low)):
        return ask("regroup", field=group)
    if group and refers_back and (view.prior_calls or view.prior_blocks) and not _CASE_SUBJECT_RE.search(low):
        # "Chart that by host" after a metrics answer: no log lookup to regroup; the
        # final says so instead of guessing a different question.
        return ask("regroup", field=group)
    if view.prior_calls and (win is not None or re.search(r"\bwithout the [a-z ]{2,30} filter\b", low)) and (
            re.search(r"\b(same|again|repeat|redo)\b", low)
            or re.match(r"^\s*(?:and\s+|now\s+)?(?:what|how) about\b", low)):
        return ask("rerun")
    clarify = None if view.case_scoped else _clarify_kind(low, view)
    if clarify:
        return ask("clarify", clarify=clarify, save=False)

    case_id = _case_id(q)
    if case_id:
        if template == "investigation_brief" or re.search(r"\bbrief\b", low):
            return ask("brief", case_id=case_id, report="investigation_brief",
                       save=not view.case_scoped and (save or bool(re.search(r"\bbrief\b", low))))
        return ask("case", case_id=case_id)
    if view.case_scoped and template == "investigation_brief":
        return ask("brief", save=False)
    # Explicit log-search phrasing that names a value runs a log lookup (wave-6 B5),
    # ahead of the hunt (a typed IP is a log filter here, not a reputation lookup the
    # analyst did not ask for) and of the case-scoped default; a how-to question ("can
    # I search logs for a user?") stays a help question, failed sign-ins keep their
    # brute-force plan, and a reference ("logs for this host", "events for the top
    # hosts") is left to the rules below (:func:`_log_search`).
    searched = (None if (_HELP_RE.search(low) and not _DATA_ASK_RE.match(low))
                else _log_search(q, case_scoped=view.case_scoped))
    if searched is not None:
        intent, log_filter, group = searched
        if any(key == "contains" and _BRUTE_RE.search(value.lower()) for key, value in log_filter):
            return ask("brute")
        # "Search logs for mimikatz by user" asks for a breakdown: a count by that field.
        return ask("log_count" if group else intent, log_filter=log_filter, field=group)
    deep = _DEEP_RE.search(low)
    if deep and not view.case_scoped:
        entity = _deep_entity(q)
        if entity is not None:
            return ask("deep", entity=entity, win=win or _relative(30, "d"))
    indicator = _indicator(q, low)
    if indicator:
        return ask("hunt", indicator=indicator)
    techniques = tuple(dict.fromkeys(
        f"T{m.group(1)}" + (f".{m.group(2)}" if m.group(2) else "") for m in _TECHNIQUE_RE.finditer(q)))
    if techniques:
        return ask("mitre", techniques=techniques)
    if _DEFINITIONAL_RE.search(low) and not re.search(r"\b(?:this|that) (?:case|alert|incident|entity)\b", low):
        metric = _metric(low)
        if metric:
            return ask("explain_metric", metric=metric[0], topic=metric[1], definition=True)
        return ask("help", definition=True, wants_access=bool(_ACCESS_RE.search(low)),
                   wants_overview=bool(_OVERVIEW_RE.search(low)), save=False)
    help_like = bool(_HELP_RE.search(low)) and not _DATA_ASK_RE.match(low)
    if view.case_scoped and not help_like and re.search(
            r"\b(this|it|why|what happened|summar\w+|explain|evidence|decision|decided|timeline|verdict|"
            r"risk|closed|escalat\w*|status|entity|attack|mitre|logs?|activity)\b", low):
        # The Case Manager chat is about ONE case (SPEC §4.6): its questions default
        # to that case rather than to a workspace-wide intent.
        return ask("case")
    metric = _metric(low)
    if metric and _DEFINITION_RE.search(low):
        return ask("explain_metric", metric=metric[0], topic=metric[1])
    if help_like or (_ACCESS_RE.search(low) and not re.search(r"\b(cases?|logs?|alerts?)\b", low)):
        return ask("help", wants_access=bool(_ACCESS_RE.search(low)),
                   wants_overview=bool(_OVERVIEW_RE.search(low)), save=False)
    # Period comparisons (SPEC P0-6), each over its own subject.
    if compare is not None and not template:
        subject = _trend_subject(low)
        if subject == "cost":
            return ask("cost")
        if subject == "alerts" and not _CASE_SUBJECT_RE.search(low):
            return ask("top", field=_group_field(low) or "rule")
        return ask("compare", subject=subject)
    # Performance, executive, monthly and infographic reports; a report request with no
    # other subject is one too ("Last 90 days or whatever reports you can").
    if template in ("executive", "monthly", "infographic") or (
            template in ("custom", "posture") and _PERFORMANCE_RE.search(low)
            and not re.search(r"\bsections?:|\b(?:hunt|ioc|indicator)\b", low)) or (
            template == "custom" and not _CASE_SUBJECT_RE.search(low) and not _keyword(low)
            and not re.search(r"\b(logs?|events?|hosts?|users?|ips?|rules?|cost|spend|noise|funnel|campaigns?|"
                              r"sources?|mitre|att&ck)\b", low)):
        chosen = template if template in ("executive", "monthly", "infographic", "posture") else "executive"
        if chosen == "monthly" and win is None:
            win = _token_win("last_month")
        return ask("perf_report", report=chosen, win=win, hours=win.hours if win else None)
    # Trends over time (SPEC P0-5): of what the question names, else a clarify.
    if not template and (_TREND_RE.search(low) or base["bucket"] and re.search(
            r"\b(mtt[adr]|response times?|fp rate|false[- ]positive rate|tp rate|automation rate|spend|cost)\b",
            low)):
        subject = _trend_subject(low)
        if subject is None:
            return ask("clarify", clarify="trend", save=False)
        if subject == "cost":
            return ask("cost", bucket=base["bucket"] or _natural_bucket(win or _relative(30, "d")))
        return ask("trend", subject=subject)
    if metric and not help_like and re.search(r"\b(?:our|ours|we|my)\b", low):
        # "What is our false-positive rate?" asks for our figure, not a definition.
        intent = {"posture": "posture", "noise_funnel": "noise", "cost": "cost"}.get(metric[0], "metric")
        return ask(intent, metric=metric[0] if intent == "metric" else None)
    if re.search(r"\b(runbooks?|playbooks?|knowledge base|guidance)\b", low):
        # Named before the data intents: "which runbooks cover brute force" asks for
        # guidance, not for failed sign-ins.
        return ask("knowledge")
    if template == "posture" or (template and re.search(r"\bposture\b", low)):
        return ask("posture", report="posture")
    if template == "investigation":
        return ask("case", case_status=_case_status(low) or "escalated")
    if template in ("hunt", "ioc"):
        found = _keyword(low)
        return ask("pivot", keyword=found[0] if found else None, topic=found[1] if found else "")
    if re.search(r"\b(shift|handoff|hand-off|handover|hand over|stand-?up)\b", low) or low.startswith("/shift"):
        return ask("shift", report="shift")
    if re.search(r"\b(noise|funnel)\b|\breduction\b", low):
        return ask("noise")
    if re.search(r"\b(cost|costs|spend|spent|spending|tokens?|budget|billing|money)\b|\$", low):
        return ask("cost")
    if _BRUTE_RE.search(low):
        return ask("brute")
    if re.search(r"\bhunt\w*\b|\bpivot\b", low):
        found = _keyword(low)
        return ask("pivot", keyword=found[0] if found else None, topic=found[1] if found else "")
    if re.search(r"\binvestigat\w*\b|\b(newest|latest|most recent)\b.*\bcase\b|\bwhy (?:was|is|did)\b.*\bcase\b",
                 low):
        return ask("case", case_status=_case_status(low) or "escalated")
    if re.search(r"(att&ck|mitre) coverage|technique coverage", low):
        return ask("metric", metric="mitre_coverage")
    if re.search(r"\b(att&ck|mitre|tactics?|techniques?)\b", low) and not base["group"]:
        return ask("mitre")
    if re.search(r"\b(silent|sources?|ingest\w*|connectors?|feeds?|coverage)\b", low) and not re.search(
            r"\bsource[- ]?(?:ips?|address(?:es)?)\b", low) and not (_CASE_SUBJECT_RE.search(low) and base["group"]):
        # "top source IPs" is a log question (handled by the top-N rule below).
        return ask("sources")
    if re.search(r"\bcampaigns?\b", low):
        return ask("campaigns")
    if re.search(r"\b(audit|who did|who changed|actions? taken|activity trail)\b", low):
        return ask("audit")
    automation = next((kind for pattern, kind in (
        (r"\bapprovals?\b|\bproposals?\b", "approvals"), (r"\btuning\b|\bthresholds?\b", "tuning"),
        (r"\bbaselines?\b", "baselines"), (r"\bschedulers?\b|\bbackground workers?\b", "schedulers"),
        (r"\btelemetry gaps?\b", "telemetry_gaps"), (r"\brule versions?\b", "rule_versions"),
    ) if re.search(pattern, low)), None)
    if automation:
        return ask("automation", metric=automation)
    # Exact counts and breakdowns over every case (SPEC D8, case_stats).
    case_subject = bool(_CASE_SUBJECT_RE.search(low))
    if case_subject and (base["bucket"] or base["group"] or (
            _COUNT_CUE_RE.search(low) and (win is not None or re.search(
                r"\b(open|active|closed|resolved|right now|currently|so far|in total|all[- ]time|ever)\b", low)))
            or re.search(r"\b(?:case|incident) (?:stats|statistics|numbers|counts?|volume|breakdown)\b", low)):
        return ask("breakdown")
    if re.search(r"\b(true positives?|confirmed (?:incidents?|threats?)|what happened today|"
                 r"today'?s (?:cases|incidents|activity)|summari[sz]e (?:today|the day))\b", low):
        return ask("tp")
    if _UNSUPPORTED_RE.search(low) and _LIST_CUE_RE.search(low) and not re.search(r"\b(logs?|events?|cases?)\b", low):
        return ask("unsupported", save=False)
    if re.search(r"\b(top|most|noisiest|busiest|loudest|which)\b", low) and re.search(
            r"\b(hosts?|machines?|servers?|endpoints?|users?|accounts?|ips?|ip addresses|rules?)\b", low):
        fld = next((f for words, f in _GROUP_FIELDS if re.search(rf"\b{words}\b", low)), "host")
        return ask("top", field=fld)
    if re.search(r"\bmost alerts\b|\bnoisiest\b", low):
        return ask("top", field="host")
    if re.search(r"\b(posture|how (?:are|is|'re) (?:we|things|the soc|our)|overview|risk index|"
                 r"state of|kpis?|metrics|how are we doing|performance)\b", low):
        return ask("posture")
    if re.search(r"\b(?:fp|tp|false[- ]positive|true[- ]positive|automation|auto[- ]?close) rates?\b", low):
        return ask("posture")
    if _DEFINITION_RE.search(low) or low.startswith(("what", "how", "where", "why")) and not re.search(
            r"\b(cases?|alerts?|incidents?|logs?|events?)\b", low):
        return ask("help", wants_access=bool(_ACCESS_RE.search(low)),
                   wants_overview=bool(_OVERVIEW_RE.search(low)), save=False)
    if re.search(r"\b(cases?|incidents?|alerts?)\b", low):
        return ask("cases")
    if template == "shift":
        return ask("shift")
    if view.case_scoped:
        return ask("case")
    if template:
        return ask("perf_report", report="executive")
    return ask("fallback")


# --------------------------------------------------------------------------- #
# Plans: the calls of lookup round ``done`` (0-based) for an intent; [] = answer now.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Call:
    tool: str
    input: dict[str, Any]


#: Lookups whose window is sent as ``window`` (any length, calendar periods, all
#: time); the log lookups also take ``time_from``, kept for plain trailing spans.
_LOG_WINDOW_TOOLS = frozenset({"log_stats", "search_logs"})


def _default_win(default: Win | str | int | None) -> Win | None:
    if default is None or isinstance(default, Win):
        return default
    if isinstance(default, int):
        return _relative(default // 24, "d") if default >= 48 and default % 24 == 0 else _relative(default, "h")
    return _token_win(default)


def _win_args(tool: str, ask: Ask, view: PromptView, default: Win | str | int | None = None) -> dict[str, Any]:
    """The window inputs of one call: the window the question names, else the
    planner's ``default`` — but only when the analyst selected no window (the request
    chip wins over a planner choice; a window the question names wins over the chip,
    which then clamps it, SPEC §4.8.4). Nothing is shortened (SPEC D7)."""
    win = ask.win if ask.win is not None and ask.win.spec is not None else None
    if win is None:
        win = None if view.analyst_window else _default_win(default)
    if win is None:
        return {}
    if tool in _LOG_WINDOW_TOOLS:
        if isinstance(win.spec, str) and re.fullmatch(r"now-\d+[hd]", win.spec) and win.hours:
            return {"time_from": _time_from(win.hours)}
        return {"window": win.spec}
    if tool == "shift_report":
        # The shift snapshot looks back at most 7 days.
        return {"window_hours": max(1, min(int(win.hours), 168))} if win.hours and not win.all_time else {}
    return {"window": win.spec}


def _windowed(ask: Ask, view: PromptView, default: Win | str | int | None = None) -> dict[str, Any]:
    """Window inputs for a case, metric, cost or audit lookup."""
    return _win_args("search_cases", ask, view, default)


def _log_window(ask: Ask, view: PromptView, default: Win | str | int | None = None) -> dict[str, Any]:
    return _win_args("log_stats", ask, view, default)


def _metric_window(ask: Ask, view: PromptView) -> dict[str, Any]:
    return _win_args("soc_metrics", ask, view)


def _compare_spec(ask: Ask) -> Any:
    """``compare`` as the tools take it ("previous_period", "same_period_last_year",
    or the other period's window for "Q3 vs Q2")."""
    if ask.compare == "explicit":
        other = ask.compare_win
        return other.spec if other is not None and other.spec is not None else None
    return ask.compare


# The anchor (see the window section): a 12-month breakdown by month whose latest
# bucket names the current month, so "September" and "since March" get their year
# from data, never from a clock. It is also useful context (cases per month).
_ANCHOR_WINDOW = "now-12M"
_BUCKET_LABEL_RE = re.compile(r"^([A-Z][a-z]{2}) (\d{4})\b")


def _anchor_call(view: PromptView) -> Call | None:
    if view.can("case_stats"):
        return Call("case_stats", {"window": _ANCHOR_WINDOW, "bucket": "month"})
    if view.can("soc_metrics", "trends"):
        return Call("soc_metrics", {"kind": "trends", "window": _ANCHOR_WINDOW, "bucket": "month"})
    if view.can("cost_usage"):
        return Call("cost_usage", {"window": _ANCHOR_WINDOW, "bucket": "month"})
    return None


def _anchor(view: PromptView) -> tuple[int, int] | None:
    """``(year, month)`` of the latest monthly bucket an anchor lookup returned."""
    for r in view.results():
        if not r.ok or r.observation is None:
            continue
        if r.input.get("window") != _ANCHOR_WINDOW and not str(r.obs.get("window") or "").startswith(
                "last 12 months"):
            continue
        labels = [b.get("label") for b in r.obs.get("buckets") or [] if isinstance(b, Mapping)]
        labels += [b for b in _dig(r.obs, "spend_per_bucket", "buckets") or [] if isinstance(b, str)]
        for label in reversed(labels):
            match = _BUCKET_LABEL_RE.match(str(label or ""))
            if match and match.group(1) in _MONTH_SHORT:
                return int(match.group(2)), _MONTH_SHORT.index(match.group(1)) + 1
    return None


def _needs_anchor(ask: Ask) -> bool:
    return any(w is not None and w.pending is not None for w in (ask.win, ask.compare_win))


def _resolved(view: PromptView, ask: Ask) -> Ask:
    """``ask`` with a month or quarter named without its year resolved from the anchor
    (unchanged when nothing waits for it, or when the anchor did not answer: then the
    named period is dropped and each lookup's own default applies)."""
    if not _needs_anchor(ask):
        return ask
    anchor = _anchor(view)
    win, other = _anchored(ask.win, anchor), _anchored(ask.compare_win, anchor)
    return replace(ask, win=win, compare_win=other, hours=win.hours if win is not None else None,
                   compare=ask.compare if other is not None or ask.compare != "explicit" else None)


def _anchored_plan(planner: Callable[[PromptView, Ask, int], list[Call]]) -> Callable[[PromptView, Ask, int], list[Call]]:
    """``planner`` preceded, when the question names a month or quarter without its
    year, by the anchor lookup that supplies the year."""
    def plan(view: PromptView, ask: Ask, done: int) -> list[Call]:
        if not _needs_anchor(ask):
            return planner(view, ask, done)
        anchor = _anchor_call(view)
        if anchor is None:
            return planner(view, _resolved(view, ask), done)
        if done == 0:
            return [anchor]
        return planner(view, _resolved(view, ask), done - 1)
    return plan


def _entity_of(obs: Mapping[str, Any]) -> tuple[str, str] | None:
    raw = _dig(obs, "case", "entity")
    if not isinstance(raw, str) or ":" not in raw:
        return None
    kind, value = raw.split(":", 1)
    return (kind.strip().lower(), value.strip()) if value.strip() else None


_LOOKUP_KIND = {"ip": "ip", "domain": "domain", "file_hash": "hash", "hash": "hash", "url": "url"}
_LOG_FILTER = {"ip": "ip", "user": "user", "host": "host"}


def _entity_log_call(kind: str, value: str, ask: Ask, view: PromptView, *, default: int | None) -> Call | None:
    """``log_stats`` over the entity's own field (what it did in the logs)."""
    fld = _LOG_FILTER.get(kind)
    if fld is None:
        return None
    group = {"user": "host", "host": "user", "ip": "host"}[fld]
    return Call("log_stats", {fld: value, "group_by": [group], **_log_window(ask, view, default)})


def _indicator_calls(value: str, kind: str, ask: Ask, view: PromptView, *, default: int | None) -> list[Call]:
    """SPEC §5.5: ``lookup_indicator`` ∥ ``search_logs(value)`` ∥ ``search_cases(entity)``."""
    calls: list[Call] = []
    lookup_kind = _LOOKUP_KIND.get(kind)
    if lookup_kind:
        calls.append(Call("lookup_indicator", {"indicator": value, "kind": lookup_kind}))
    log_filter = {"ip": {"ip": value}, "host": {"host": value}, "user": {"user": value}}.get(
        kind, {"contains": value})
    calls.append(Call("search_logs", {**log_filter, **_log_window(ask, view, default)}))
    calls.append(Call("search_cases", {"entity": value, "limit": 10}))
    return calls


def _newest_case(result: Result | None, *, prefer_indicator: bool = False) -> Mapping[str, Any] | None:
    cases = [c for c in (result.obs.get("cases") if result else None) or [] if isinstance(c, Mapping)]
    cases = [c for c in cases if isinstance(c.get("case_id"), str)]
    if prefer_indicator:
        for case in cases:
            entity = _entity_of({"case": case})
            if entity and entity[0] in _LOOKUP_KIND:
                return case
    return cases[0] if cases else None


def _plan_case(view: PromptView, ask: Ask, done: int) -> list[Call]:
    deep = bool(re.search(r"\b(investigat\w*|what happened|logs?|activity|doing)\b", ask.lowered))
    if ask.case_id or view.case_scoped and not ask.case_status:
        case_input = {"case_id": ask.case_id} if ask.case_id else {}
        if done == 0:
            return [Call("get_case", dict(case_input)), Call("explain_decision", dict(case_input))]
        if done == 1 and deep:
            entity = _entity_of(view.ok("get_case").obs if view.ok("get_case") else {})
            call = _entity_log_call(*entity, ask, view, default=24) if entity else None
            return [call] if call else []
        return []
    if done == 0:
        status = ask.case_status or "escalated"
        return [Call("search_cases", {"status": status, "sort_field": "created_at", "limit": 5})]
    if done == 1:
        case = _newest_case(view.ok("search_cases"))
        if case is None:
            return []
        case_id = case["case_id"]
        calls = [Call("get_case", {"case_id": case_id}), Call("explain_decision", {"case_id": case_id})]
        entity = _entity_of({"case": case})
        log_call = _entity_log_call(*entity, ask, view, default=24) if entity else None
        if log_call is not None:
            calls.append(log_call)
        return calls
    return []


def _plan_pivot(view: PromptView, ask: Ask, done: int) -> list[Call]:
    if done == 0:
        if ask.keyword:
            return [Call("search_cases", {"text": ask.keyword, "sort_field": "created_at", "limit": 5})]
        return [Call("search_cases", {"status_group": "active", "sort_field": "risk_score", "limit": 10})]
    if done == 1:
        case = _newest_case(view.ok("search_cases"), prefer_indicator=True)
        return [Call("get_case", {"case_id": case["case_id"]})] if case else []
    if done == 2:
        got = view.ok("get_case")
        entity = _entity_of(got.obs) if got else None
        if entity is None:
            return []
        return _indicator_calls(entity[1], entity[0], ask, view, default=168)
    return []


def _plan_reshape(view: PromptView, ask: Ask, done: int) -> list[Call]:
    return []


def _plan_regroup(view: PromptView, ask: Ask, done: int) -> list[Call]:
    if done:
        return []
    prior = next((c for c in reversed(view.prior_calls) if c.tool in ("log_stats", "search_logs")), None)
    if prior is None or ask.field is None:
        return []
    inp: dict[str, Any] = {"group_by": [ask.field], "top_n": 10}
    for key in ("ip", "user", "host", "rule", "contains", "time_from", "time_to", "window", "source_id"):
        value = prior.arg(key)
        if value and not value.startswith(("{", "[")):
            inp[key] = value
    severity = prior.arg("severity_gte")
    if severity and _num(_safe_float(severity)) is not None:
        inp["severity_gte"] = _safe_float(severity)
    if ask.win is not None and ask.win.spec is not None:
        for key in ("time_from", "time_to", "window"):
            inp.pop(key, None)
        inp.update(_win_args("log_stats", ask, view))
    return [Call("log_stats", inp)]


def _safe_float(value: str) -> float | None:
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


_RERUN_KEYS: dict[str, tuple[str, ...]] = {
    "log_stats": ("ip", "user", "host", "rule", "contains", "source_id", "group_by"),
    "search_logs": ("ip", "user", "host", "rule", "contains", "source_id"),
    "search_cases": ("text", "status", "status_group", "verdict", "entity", "severity", "rule"),
    "case_stats": ("text", "status", "status_group", "verdict", "entity", "severity", "rule", "group_by", "bucket",
                   "metrics", "top_n"),
    "soc_metrics": ("kind", "bucket"),
    "cost_usage": ("bucket",),
    "shift_report": (),
    "audit_search": ("actor", "action_type", "surface"),
}
_LIST_ARGS = frozenset({"group_by", "metrics"})
_INT_ARGS = frozenset({"top_n", "window_hours"})
_WITHOUT_FILTER_RE = re.compile(r"\bwithout the ([a-z][a-z ]{1,30}?) filter\b")


def _plan_rerun(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The latest answer's lookups again, with the window the question names ("same
    for all time") or without one filter ("…without the text filter"): the engine's
    zero-result suggestions as one-click follow-ups."""
    drop = _WITHOUT_FILTER_RE.search(ask.lowered)
    drop_key = drop.group(1).strip().replace(" ", "_") if drop else None
    if done or (ask.win is None and drop_key is None):
        return []
    latest = view.prior_calls[-1].key if view.prior_calls else None
    calls: list[Call] = []
    for prior in view.prior_calls:
        if prior.key != latest or prior.tool not in _RERUN_KEYS:
            continue
        inp: dict[str, Any] = {}
        for key in _RERUN_KEYS[prior.tool]:
            value = prior.arg(key)
            if not value or key == drop_key:
                continue
            if key in _LIST_ARGS:
                inp[key] = [v for v in value.split(",") if v]
            elif key in _INT_ARGS:
                number = _safe_float(value)
                if number is not None:
                    inp[key] = int(number)
            else:
                inp[key] = value
        if ask.win is not None:
            inp.update(_win_args(prior.tool, ask, view))
        else:
            for key in ("window", "time_from", "time_to", "window_hours"):
                value = prior.arg(key)
                if value and not value.startswith(("{", "[")):
                    inp[key] = int(value) if key == "window_hours" and value.isdigit() else value
        calls.append(Call(prior.tool, inp))
    return calls


def _plan_simple(build: Callable[[PromptView, Ask], list[Call]]) -> Callable[[PromptView, Ask, int], list[Call]]:
    def plan(view: PromptView, ask: Ask, done: int) -> list[Call]:
        return build(view, ask) if done == 0 else []
    return plan


#: ``log_stats`` interval for a calendar unit.
_INTERVALS = {"hour": "1h", "day": "1d", "week": "1w", "month": "1M", "quarter": "1q", "year": "1y"}


def _case_filters_for(ask: Ask) -> dict[str, Any]:
    """The case filters the question names (status group, severity, verdict, text)."""
    low = ask.lowered
    inp: dict[str, Any] = {}
    if re.search(r"\b(open|active|unresolved|still open|not (?:yet )?closed|outstanding|backlog|pending)\b", low):
        inp["status_group"] = "active"
    elif re.search(r"\b(closed|resolved|terminal)\b", low):
        inp["status_group"] = "terminal"
    if ask.group != "severity":
        severity = next((s for s in ("critical", "high", "medium", "low") if re.search(rf"\b{s}\b", low)), None)
        if severity:
            inp["severity"] = severity
    if ask.group != "verdict":
        verdict = next((v for p, v in ((r"needs?[- ]human", "NEEDS_HUMAN"), (r"false[- ]positives?", "FALSE_POSITIVE"),
                                       (r"true[- ]positives?", "TRUE_POSITIVE")) if re.search(p, low)), None)
        if verdict and not re.search(r"\b(?:fp|tp|false[- ]positive|true[- ]positive) rate\b", low):
            inp["verdict"] = verdict
    if re.search(r"\bunassigned\b", low):
        inp["assignee"] = "unassigned"
    found = _keyword(low)
    if found:
        inp["text"] = found[0]
    return inp


def _case_metrics_for(ask: Ask) -> list[str]:
    low = ask.lowered
    metrics = ["count"]
    for pattern, metric in ((r"\bfalse[- ]positive rate\b|\bfp rate\b", "fp_rate"),
                            (r"\btrue[- ]positive rate\b|\btp rate\b", "tp_rate"),
                            (r"\bauto[- ]?clos\w*\b|\bautomation\b", "auto_closed"),
                            (r"\bmttr\b|\btime to resolve\b|\bresolution time\b", "mttr_p50"),
                            (r"\bmtta\b|\btime to acknowledge\b", "mtta_p50"),
                            (r"\bmttd\b|\btime to detect\b", "mttd_p50"),
                            (r"\b(?:average |mean )?risk\b", "mean_risk")):
        if re.search(pattern, low) and metric not in metrics:
            metrics.append(metric)
    return metrics[:6]


def _plan_breakdown(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """Exact counts over every case (``case_stats``), grouped and bucketed as asked.
    Open cases broken down by when they were opened also list the oldest of them."""
    if done:
        return []
    filters = _case_filters_for(ask)
    inp: dict[str, Any] = dict(filters)
    stats_only = not ask.group and not ask.bucket
    if ask.group:
        inp["group_by"] = [ask.group]
        if ask.group in ("rule", "assignee", "source", "closed_by", "mitre_technique", "mitre_tactic"):
            inp["top_n"] = 10
    elif stats_only:
        inp["group_by"] = ["verdict"]
    if ask.bucket:
        inp["bucket"] = ask.bucket
    metrics = _case_metrics_for(ask)
    if stats_only and re.search(r"\b(stats|statistics|numbers|summary|overview)\b", ask.lowered):
        metrics = list(dict.fromkeys(metrics + ["fp_rate", "auto_closed", "human_closed", "open_now", "mttr_p50"]))[:6]
    if metrics != ["count"]:
        inp["metrics"] = metrics
    window = _windowed(ask, view)
    inp.update(window)
    calls = [Call("case_stats", inp)]
    if filters.get("status_group") == "active" and ask.bucket:
        # "When were they opened?": the oldest cases still open, beside the counts.
        calls.append(Call("search_cases", {**filters, "sort_field": "created_at", "sort_order": "asc", "limit": 5,
                                           **window}))
    elif stats_only and not filters and _anchor(view) is None:
        calls.append(Call("case_stats", {"bucket": _natural_bucket(ask.win) if ask.win else "month", **window}))
    return calls


def _plan_trend(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """A measure over time, bucketed by a calendar unit. Without a named window the
    last 30 days (stated in the answer) is the reasonable default."""
    if done:
        return []
    default = _bucket_default(ask.bucket) or _relative(30, "d")
    span = ask.win if ask.win is not None and ask.win.spec is not None else (None if view.analyst_window else default)
    bucket = ask.bucket or _natural_bucket(span or default)
    window = _windowed(ask, view, default)
    log_window = _log_window(ask, view, default)
    subject = ask.subject
    if subject == "timing":
        return [Call("case_stats", {"bucket": bucket, "metrics": ["count", "mttr_p50", "mtta_p50", "mttd_p50"],
                                    **window}),
                Call("soc_metrics", {"kind": "timing", "bucket": bucket, **window})]
    if subject == "rates":
        return [Call("case_stats", {"bucket": bucket, "metrics": ["count", "fp_rate", "tp_rate", "auto_closed"],
                                    **window})]
    if subject == "risk":
        return [Call("case_stats", {"bucket": bucket, "metrics": ["count", "mean_risk"], **window})]
    if subject == "alerts":
        return [Call("soc_metrics", {"kind": "trends", "bucket": bucket, **window}),
                Call("log_stats", {"group_by": ["severity"], "interval": _INTERVALS.get(bucket, "auto"),
                                   **log_window})]
    return [Call("soc_metrics", {"kind": "trends", "bucket": bucket, **window}),
            Call("case_stats", {"bucket": bucket, "group_by": ["severity"], **window})]


def _plan_compare(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """A period comparison: the headline figures, the posture tiles and the severity
    mix, each with ``compare`` (the changes come computed; SPEC P0-6)."""
    if done:
        return []
    compare = _compare_spec(ask)
    if compare is None:
        compare = "previous_period"
    window = _windowed(ask, view)
    filters = _case_filters_for(ask)
    calls = [Call("case_stats", {**filters, "metrics": ["count", "fp_rate", "tp_rate", "auto_closed", "mttr_p50"],
                                 "compare": compare, **window}),
             Call("soc_metrics", {"kind": "posture", "compare": compare, **window}),
             Call("case_stats", {**filters, "group_by": [ask.group or "severity"], "compare": compare, **window})]
    if ask.subject == "timing":
        calls.append(Call("soc_metrics", {"kind": "timing", "compare": compare, **window}))
    return calls


def _report_bucket(win: Win | None) -> str:
    if win is None or win.all_time or win.pending is not None:
        return "month"
    if win.unit in ("year",) or (win.hours or 0) >= 24 * 80:
        return "month"
    return _natural_bucket(win)


def _report_win(view: PromptView, ask: Ask) -> Win | None:
    """The window a performance report covers: the one the question names, else the
    analyst's chip, else the last 30 days (stated in the answer)."""
    if ask.win is not None and ask.win.spec is not None:
        return ask.win
    return None if view.analyst_window else _relative(30, "d")


def _plan_perf_report(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """The report recipe (SPEC P0-7): volume by period with rates and response times,
    posture, timing and the noise funnel in one parallel batch (each compared with the
    previous period for a bounded window), then the severity mix, the top rules, AI
    cost and the open work in a second."""
    win = _report_win(view, ask)
    scoped = replace(ask, win=win) if win is not None else ask
    window = _windowed(scoped, view)
    compare = {"compare": "previous_period"} if win is not None and not win.all_time else {}
    if done == 0:
        return [
            Call("case_stats", {"bucket": _report_bucket(win), "metrics": ["count", "fp_rate", "tp_rate",
                                                                             "auto_closed", "mttr_p50"],
                                **compare, **window}),
            Call("soc_metrics", {"kind": "posture", **compare, **window}),
            Call("soc_metrics", {"kind": "timing", **compare, **window}),
            Call("soc_metrics", {"kind": "noise_funnel", **window}),
        ]
    if done == 1:
        return [
            Call("case_stats", {"group_by": ["severity"], **window}),
            Call("case_stats", {"group_by": ["rule"], "top_n": 10, **window}),
            Call("cost_usage", dict(window)),
            Call("search_cases", {"status_group": "active", "sort_field": "risk_score", "limit": 5}),
        ]
    return []


def _plan_brief(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """An advisory investigation brief (SPEC P1-3): the case and its decision, then
    what its entity did in the logs, the other cases that carry it and its ATT&CK
    techniques, then the indicator's reputation when the entity is one."""
    case_input = {"case_id": ask.case_id} if ask.case_id else {}
    if done == 0:
        return [Call("get_case", dict(case_input)), Call("explain_decision", dict(case_input))]
    got = view.ok("get_case")
    entity = _entity_of(got.obs) if got else None
    if done == 1:
        calls: list[Call] = []
        if entity is not None:
            log_call = _entity_log_call(*entity, ask, view, default=168)
            if log_call is not None:
                calls.append(log_call)
            calls.append(Call("search_cases", {"entity": entity[1], "sort_field": "created_at", "limit": 10}))
        ids = [str(m.get("id")) for m in (got.obs.get("mitre") if got else None) or []
               if isinstance(m, Mapping) and re.fullmatch(r"T\d{4}(?:\.\d{3})?", str(m.get("id") or ""))]
        if ids:
            calls.append(Call("mitre_lookup", {"ids": list(dict.fromkeys(ids))[:5]}))
        return calls
    if done == 2 and entity is not None and _LOOKUP_KIND.get(entity[0]):
        return [Call("lookup_indicator", {"indicator": entity[1], "kind": _LOOKUP_KIND[entity[0]]})]
    return []


_DEEP_FIELD = {"host": "host", "user": "user", "ip": "ip"}
_PRIVATE_IP_RE = re.compile(r"^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)")


def _public_ip(result: Result | None) -> str | None:
    """The first public address among a log search's top values or sample rows."""
    if result is None:
        return None
    values = [t.get("value") for t in _dig(result.obs, "top_values", "ip") or [] if isinstance(t, Mapping)]
    values += [row.get("ip") for row in result.obs.get("sample_rows") or result.obs.get("rows") or []
               if isinstance(row, Mapping)]
    for value in values:
        if isinstance(value, str) and _IPV4_RE.fullmatch(value) and not _PRIVATE_IP_RE.match(value):
            return value
    return None
_DEEP_PIVOT = {"host": ("user", "ip"), "user": ("host", "ip"), "ip": ("host", "user")}


def _plan_deep(view: PromptView, ask: Ask, done: int) -> list[Call]:
    """An in-depth investigation of one host, user or IP (10+ lookups over 4 rounds,
    so the unlimited loop and its progress are visible): who and what touched it,
    which rules fired, its severity over time, the matching events, every case that
    carries it, the riskiest case's evidence and decision, ATT&CK, campaigns and the
    audit trail."""
    if ask.entity is None:
        return []
    kind, value = ask.entity
    fld = _DEEP_FIELD.get(kind, "host")
    first, second = _DEEP_PIVOT.get(kind, ("user", "ip"))
    default = _relative(30, "d")
    span = ask.win if ask.win is not None and ask.win.spec is not None else default
    window = _windowed(ask, view, default)
    logs = _log_window(ask, view, default)
    if done == 0:
        calls = [Call("log_stats", {fld: value, "group_by": [first], "top_n": 10, **logs}),
                 Call("log_stats", {fld: value, "group_by": ["rule"], "top_n": 10, **logs}),
                 Call("search_cases", {"entity": value, "sort_field": "risk_score", "limit": 10, **window}),
                 Call("case_stats", {"entity": value, "group_by": ["verdict"], **window})]
        if kind == "ip":
            calls.insert(0, Call("lookup_indicator", {"indicator": value, "kind": "ip"}))
        return calls
    if done == 1:
        return [Call("search_logs", {fld: value, **logs}),
                Call("log_stats", {fld: value, "group_by": [second], "top_n": 10, **logs}),
                Call("log_stats", {fld: value, "group_by": ["severity"],
                                   "interval": _INTERVALS.get(_natural_bucket(span), "auto"), **logs}),
                Call("log_stats", {fld: value, "group_by": ["action"], "top_n": 10, **logs})]
    if done == 2:
        case = _newest_case(view.ok("search_cases", where=lambda r: bool(_dig(r.obs, "filters", "entity"))))
        calls = [Call("list_campaigns", {"limit": 10}), Call("source_health", {})]
        if case is not None:
            calls[:0] = [Call("get_case", {"case_id": case["case_id"]}),
                         Call("explain_decision", {"case_id": case["case_id"]})]
        peer = _public_ip(view.ok("search_logs")) if kind != "ip" else None
        if peer is not None:
            # An address the matching events show (code evidence this turn): its reputation.
            calls.append(Call("lookup_indicator", {"indicator": peer, "kind": "ip"}))
        return calls
    if done == 3:
        got = view.ok("get_case")
        calls = []
        ids = [str(m.get("id")) for m in (got.obs.get("mitre") if got else None) or []
               if isinstance(m, Mapping) and re.fullmatch(r"T\d{4}(?:\.\d{3})?", str(m.get("id") or ""))]
        if ids:
            calls.append(Call("mitre_lookup", {"ids": list(dict.fromkeys(ids))[:5]}))
        case_id = _dig(got.obs, "case", "case_id") if got else None
        if isinstance(case_id, str) and case_id:
            calls.append(Call("audit_search", {"case_id": case_id, **window}))
        return calls
    return []


def _cost_inputs(ask: Ask, view: PromptView) -> dict[str, Any]:
    inp = dict(_windowed(ask, view, _bucket_default(ask.bucket)))
    if ask.bucket:
        inp["bucket"] = ask.bucket
    compare = _compare_spec(ask)
    if compare is not None:
        inp["compare"] = compare
    if re.search(r"\bby (?:ai )?role\b|\bper role\b", ask.lowered):
        inp["group_by"] = ["role"]
    elif re.search(r"\bby model\b|\bper model\b|\bwhich models?\b", ask.lowered):
        inp["group_by"] = ["model"]
    elif re.search(r"\bby surface\b|\bper surface\b", ask.lowered):
        inp["group_by"] = ["surface"]
    return inp


def _posture_calls(v: PromptView, a: Ask) -> list[Call]:
    window = _metric_window(a, v)
    trends: dict[str, Any] = {"kind": "trends", **window}
    if a.bucket:
        trends["bucket"] = a.bucket
    return [
        Call("soc_metrics", {"kind": "posture", **window}),
        Call("soc_metrics", trends),
        *([Call("soc_metrics", {"kind": "noise_funnel", **window})] if a.report else []),
    ]


def _top_calls(v: PromptView, a: Ask) -> list[Call]:
    inp: dict[str, Any] = {"group_by": [a.field or "host"], "top_n": 10, **_log_window(a, v, default=168)}
    compare = _compare_spec(a)
    if compare is not None:
        inp["compare"] = compare
    return [Call("log_stats", inp)]


_SIMPLE_PLANS: dict[str, Callable[[PromptView, Ask], list[Call]]] = {
    "posture": _posture_calls,
    "shift": lambda v, a: [
        Call("shift_report", _win_args("shift_report", a, v)),
        Call("soc_metrics", {"kind": "posture", **_metric_window(a, v)}),
        Call("list_campaigns", {"status": "open", "limit": 5}),
    ],
    "noise": lambda v, a: [Call("soc_metrics", {"kind": "noise_funnel", **_metric_window(a, v)})],
    "metric": lambda v, a: [Call("soc_metrics", {"kind": a.metric or "posture", **_metric_window(a, v)})],
    "cost": lambda v, a: [Call("cost_usage", _cost_inputs(a, v))],
    "brute": lambda v, a: [
        Call("log_stats", {"group_by": ["ip"], "contains": "fail", "top_n": 10, **_log_window(a, v)}),
        Call("search_cases", {"text": "brute", "sort_field": "created_at", "limit": 10}),
    ],
    "top": _top_calls,
    # An explicit log search: the tool's own window (the chip, else 24 h) unless the
    # question names one.
    "logs": lambda v, a: [Call("search_logs", {**dict(a.log_filter), **_log_window(a, v)})],
    "log_count": lambda v, a: [Call("log_stats", {**dict(a.log_filter), "group_by": [a.field or "host"],
                                                  "top_n": 10, **_log_window(a, v)})],
    "tp": lambda v, a: [
        Call("search_cases", {"verdict": "TRUE_POSITIVE", "limit": 10, **_windowed(a, v, default=24)}),
        Call("soc_metrics", {"kind": "case_mix", **_windowed(a, v, default=24)}),
    ],
    "hunt": lambda v, a: _indicator_calls(a.indicator[0], a.indicator[1], a, v, default=168)
    if a.indicator else [],
    "mitre": lambda v, a: [
        Call("mitre_lookup", {"ids": list(a.techniques)} if a.techniques else {"query": _mitre_query(a)}),
        Call("soc_metrics", {"kind": "mitre_coverage", **_metric_window(a, v)}),
    ],
    "sources": lambda v, a: [Call("source_health", {})],
    "campaigns": lambda v, a: [Call("list_campaigns", {"status": "open"} if "open" in a.lowered else {})],
    "audit": lambda v, a: [Call("audit_search", _windowed(a, v))],
    "automation": lambda v, a: [Call("automation_status", {"kind": a.metric or "approvals"})],
    "knowledge": lambda v, a: [Call("search_knowledge", (
        {"kind": "list_runbooks"} if re.search(r"\b(list|which|what) runbooks\b", a.lowered)
        else {"kind": "list_playbooks"} if re.search(r"\b(list|which|what) playbooks\b", a.lowered)
        else {"query": a.topic or a.question}))],
    "help": lambda v, a: [
        Call("app_help", {"query": a.topic}),
        *([Call("app_status", {"kind": "access"})] if a.wants_access else []),
        *([Call("app_status", {"kind": "overview"})] if a.wants_overview and not a.wants_access else []),
    ],
    "explain_metric": lambda v, a: [
        Call("app_help", {"query": a.topic}),
        (Call("cost_usage", _windowed(a, v)) if a.metric == "cost"
         else Call("soc_metrics", {"kind": a.metric or "posture", **_metric_window(a, v)})),
    ],
    # A case list counts its matches exactly and breaks them down by verdict and
    # status itself: no unrelated 24-hour case mix beside it (diagnosis/routing.md §5.17).
    "cases": lambda v, a: [Call("search_cases", _cases_filters(a, v))],
    "change": lambda v, a: [Call("app_help", {"query": _change_query(a)})],
    "unsupported": lambda v, a: [Call("app_help", {"query": a.question[:300]})],
    "clarify": lambda v, a: [],
    "fallback": lambda v, a: [
        # Orientation: what chat can answer, not a keyword search for an unmapped ask.
        Call("app_help", {"query": "Workspace Chat ask a question"}),
        Call("search_cases", {"status_group": "active", "sort_field": "risk_score", "limit": 5}),
    ],
}

_PLANS: dict[str, Callable[[PromptView, Ask, int], list[Call]]] = {
    name: _anchored_plan(plan) for name, plan in {
        "case": _plan_case,
        "pivot": _plan_pivot,
        "reshape": _plan_reshape,
        "regroup": _plan_regroup,
        "rerun": _plan_rerun,
        "breakdown": _plan_breakdown,
        "trend": _plan_trend,
        "compare": _plan_compare,
        "perf_report": _plan_perf_report,
        "brief": _plan_brief,
        "deep": _plan_deep,
        **{name: _plan_simple(build) for name, build in _SIMPLE_PLANS.items()},
    }.items()
}

#: The data tools each intent is ABOUT (for the "not available to your role" note).
_INTENT_TOOLS: dict[str, tuple[str, ...]] = {
    "posture": ("soc_metrics",), "shift": ("shift_report",), "noise": ("soc_metrics",),
    "metric": ("soc_metrics",), "cost": ("cost_usage",), "brute": ("log_stats", "search_cases"),
    "top": ("log_stats",), "tp": ("search_cases",), "hunt": ("lookup_indicator", "search_logs", "search_cases"),
    "pivot": ("search_cases", "get_case", "lookup_indicator", "search_logs"),
    "case": ("get_case", "explain_decision"), "mitre": ("mitre_lookup",), "sources": ("source_health",),
    "campaigns": ("list_campaigns",), "audit": ("audit_search",), "automation": ("automation_status",),
    "knowledge": ("search_knowledge",), "explain_metric": ("soc_metrics",), "cases": ("search_cases",),
    "regroup": ("log_stats",), "rerun": (), "logs": ("search_logs",), "log_count": ("log_stats",),
    "breakdown": ("case_stats",), "trend": ("case_stats", "soc_metrics"), "compare": ("case_stats", "soc_metrics"),
    "perf_report": ("case_stats", "soc_metrics", "cost_usage", "search_cases"),
    "brief": ("get_case", "explain_decision"), "deep": ("log_stats", "search_cases", "search_logs"),
}
_DATA_INTENTS = frozenset(_INTENT_TOOLS) - {"rerun"}
_TOOL_NAMES = {
    "soc_metrics": "SOC metrics", "shift_report": "the shift snapshot", "cost_usage": "AI cost data",
    "log_stats": "log statistics", "search_logs": "log search", "search_cases": "case search",
    "case_stats": "case counts", "get_case": "case details", "explain_decision": "the decision policy",
    "lookup_indicator": "indicator reputation", "mitre_lookup": "the ATT&CK corpus", "source_health":
    "source health", "list_campaigns": "campaigns", "audit_search": "the audit trail", "automation_status":
    "automation status", "search_knowledge": "the knowledge base",
}


def _change_query(ask: Ask) -> str:
    """The Help Center query for a change request: the action and its object, without
    ids or indicators (they would only add noise to a product-docs search)."""
    text = _CASE_ID_RE.sub(" ", ask.question)
    for pattern in (_URL_RE, _IPV4_RE, _HASH_RE):
        text = pattern.sub(" ", text)
    text = re.sub(r"[^A-Za-z &'-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return display_text(f"how to {text}" if text else ask.question, 300)


def _mitre_query(ask: Ask) -> str:
    words = [w for w in re.findall(r"[a-z][a-z0-9&-]{2,}", ask.lowered)
             if w not in {"what", "which", "the", "att&ck", "mitre", "technique", "techniques", "tactic",
                          "tactics", "and", "for", "about", "show", "explain", "does", "mean", "are", "our"}]
    return " ".join(words[:6]) or "credential access"


def _cases_filters(ask: Ask, view: PromptView) -> dict[str, Any]:
    low = ask.lowered
    inp: dict[str, Any] = {"limit": 10}
    if re.search(r"\b(open|active|unresolved)\b", low):
        inp["status_group"] = "active"
    elif re.search(r"\b(closed|resolved|terminal)\b", low):
        inp["status_group"] = "terminal"
    severity = next((s for s in ("critical", "high", "medium", "low") if s in low), None)
    if severity:
        inp["severity"] = severity
    verdict = next((v for p, v in ((r"needs?[- ]human", "NEEDS_HUMAN"), (r"false positive", "FALSE_POSITIVE"),
                                   (r"true positive", "TRUE_POSITIVE")) if re.search(p, low)), None)
    if verdict:
        inp["verdict"] = verdict
    if re.search(r"\bunassigned\b", low):
        inp["assignee"] = "unassigned"
    inp.update(_windowed(ask, view))
    return inp


def _degraded_calls(view: PromptView, ask: Ask) -> list[Call]:
    """When none of an intent's tools is granted: the Help Center plus the active
    cases (if the caller may read cases), so the answer still orients the analyst."""
    calls = [Call("app_help", {"query": (ask.topic or ask.question)[:300]})]
    if ask.intent != "search_cases" and view.can("search_cases"):
        calls.append(Call("search_cases", {"status_group": "active", "sort_field": "risk_score", "limit": 5}))
    return calls


def _call_key(tool: str, inp: Mapping[str, Any]) -> str:
    return json.dumps([tool, inp], sort_keys=True)


def _pending_calls(view: PromptView, ask: Ask) -> list[Call]:
    """Planned, granted calls that have not run yet, from the earliest plan stage
    that still has one. A stage the parallel bound split is finished before the next
    stage starts, so no planned call is dropped silently (it runs in a later round,
    or the final names it). Calls that ran — whatever their result — never repeat."""
    planner = _PLANS.get(ask.intent)
    if planner is None:
        return []
    # Each completed call accounts for ONE planned call: the same tool with the same
    # input, else the same tool whose input the echo did not carry (an unreadable
    # echo must never make a lookup run twice).
    remaining = list(view.results())

    def consume(call: Call) -> bool:
        key = _call_key(call.tool, call.input)
        for loose in (False, True):
            for index, result in enumerate(remaining):
                if result.tool == call.tool and (
                        (not result.input) if loose else _call_key(result.tool, result.input) == key):
                    del remaining[index]
                    return True
        return False

    for stage in range(len(view.rounds) + 1):
        wanted = planner(view, ask, stage)
        calls = [c for c in wanted if view.can(c.tool, c.input.get("kind"))]
        if stage == 0 and not calls and wanted:
            calls = [c for c in _degraded_calls(view, ask) if view.can(c.tool)]
        pending: list[Call] = []
        for call in calls:
            if call not in pending and not consume(call):
                pending.append(call)
        if pending:
            return pending
    return []


def _next_calls(view: PromptView, ask: Ask) -> list[Call]:
    """The next lookup round, filtered to granted tools and the parallel bound."""
    if view.final_only or len(view.rounds) >= MAX_PLAN_ROUNDS or not view.granted or view.legacy is not None:
        return []
    return _pending_calls(view, ask)[: view.max_parallel]


# --------------------------------------------------------------------------- #
# Narration: one sentence group per tool result (numbers from observations only).
# --------------------------------------------------------------------------- #
_VERDICT_WORDS = {"TRUE_POSITIVE": "true positive", "FALSE_POSITIVE": "false positive",
                  "NEEDS_HUMAN": "needs-human"}


def _verdict_word(value: Any) -> str:
    """A verdict enum as words ("true positive"); unknown values display-sanitised."""
    text = display_text(value if isinstance(value, str) else "", 30)
    return _VERDICT_WORDS.get(text.upper(), text.replace("_", " ").lower())


def _ranked(top: Sequence[Mapping[str, Any]], unit: str = "event") -> str:
    """``top`` (ranked ``{value, count}``) as a sentence fragment that is honest about
    ties: "`a` leads with 6 events, then `b` (5)" or "spread evenly, 1 event each"."""
    counts = [_num(t.get("count")) or 0 for t in top]
    if not top:
        return ""
    if len(top) > 1 and counts[0] == counts[-1]:
        shown = [_code(t.get("value")) for t in top[:3]]
        if len(top) > 3:
            shown.append(_plural(len(top) - 3, "other"))
        return f"spread evenly at {_plural(counts[0], unit)} each across {_join(shown)}"
    leaders = [t for t in top if (_num(t.get("count")) or 0) == counts[0]]
    if len(leaders) > 1:
        text = f"{_join([_code(t.get('value')) for t in leaders[:3]])} lead with {_plural(counts[0], unit)} each"
    else:
        text = f"{_code(top[0].get('value'))} leads with {_plural(counts[0], unit)}"
    rest = [f"{_code(t.get('value'))} ({_count(t.get('count'))})" for t in top[len(leaders):len(leaders) + 3]]
    return text + (f", then {_join(rest)}" if rest else "")


def _filter_words(filters: Iterable[tuple[str, Any]]) -> str:
    """Log filters in words: searched text as its bare code span ("`sql`"), a field by
    its noun ("IP `203.0.113.7`", "host `web-01`"), never the raw filter key."""
    parts: list[str] = []
    for key, value in filters:
        if key == "contains":
            parts.append(_code(value, 60))
        elif key == "severity_gte":
            parts.append(f"severity {_count(value)} or higher")
        elif key == "ids":
            parts.append(f"the {_plural(value, 'requested event ID')}")
        else:
            parts.append(f"{_LOG_FIELD_NOUNS.get(key, key.replace('_', ' '))} {_code(value, 60)}")
    return _join(parts)


def _no_log_events(o: Mapping[str, Any], what: str) -> str:
    """The zero-match sentence of a log lookup: "No log events match `x` in the last
    24h (5 of 5 sources answered)." (``what`` empty: no filter, "No log events in …")."""
    coverage = _coverage_phrase(o)
    matched = f" match {what}" if what else ""
    return f"No log events{matched} {_in(_window(o))}" + (f" ({coverage})." if coverage else ".")


def _say_log_stats(r: Result, *, subject: str | None = None) -> str:
    """A ``log_stats`` result in words. ``subject`` replaces the filter phrase
    ("matching `sql`", "for `web-01`"); without it the filters are named in words, and
    a zero total reads "No log events match …"."""
    o = r.obs
    window = _window(o)
    group_by = [g for g in o.get("group_by") or [] if isinstance(g, str)]
    fld = group_by[0] if group_by else None
    total = _num(o.get("total")) or 0
    top = [t for t in _dig(o, "top", fld) or [] if isinstance(t, Mapping)] if fld else []
    coverage = _coverage_phrase(o)
    label = _FIELD_LABEL.get(fld or "", fld or "value")
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    if subject is not None:
        scope = subject
    else:
        what = _filter_words(filters.items())
        if not total:
            return _no_log_events(o, what)
        scope = f"matching {what}" if what else ""
    lead = f"**{_plural(total, 'event')}** {scope + ' ' if scope else ''}{_in(window)}"
    if coverage:
        lead += f" ({coverage})"
    if not total or not top:
        return lead + "."
    lead += f"; by {label}, {_ranked(top)}."
    other = _num(_dig(o, "other", fld))
    if other:
        lead += f" {_plural(other, 'more event')} fall outside the top {len(top)}."
    basis = _basis_phrase(o)
    return f"{lead} {basis}".strip()


def _say_search_logs(r: Result, *, subject: str | None = None) -> str:
    """A ``search_logs`` result in words. ``subject`` names what was searched for;
    without it the filters are named in words, and a search with no filter counts the
    window's events ("12 log events in the last 24h")."""
    o = r.obs
    total = _num(o.get("total")) or 0
    coverage = _coverage_phrase(o)
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    what = subject or _filter_words(filters.items())
    if not total:
        return _no_log_events(o, what)
    matched = f" match {what}" if what else ""
    text = f"**{_plural(total, 'log event')}**{matched} {_in(_window(o))}"
    text += f" ({coverage})." if coverage else "."
    tops = o.get("top_values") if isinstance(o.get("top_values"), Mapping) else {}
    parts = []
    for fld in ("host", "user", "rule"):
        values = [t for t in tops.get(fld) or [] if isinstance(t, Mapping)][:3]
        if values:
            parts.append(f"{_FIELD_LABEL.get(fld, fld)}s {_join([_code(v.get('value')) for v in values])}")
    if parts:
        text += f" They involve {'; '.join(parts)}."
    if o.get("total_is_lower_bound"):
        text += " The total is a lower bound (the source capped its count)."
    return text


#: Words for an entity kind in narration ("user `dsingh`", "IP `203.0.113.9`").
_ENTITY_NOUNS = {"ip": "IP", "domain": "domain", "url": "URL", "file_hash": "file hash", "hash": "file hash",
                 "user": "user", "host": "host", "process": "process", "email": "email"}
#: The machine case title the pipeline writes: ``<kind>:<value> — <rule>[, <rule>…]``.
_MACHINE_TITLE_RE = re.compile(r"^([a-z][a-z_]{0,30}):(.+?) — (.+)$")


def _entity_phrase(raw: Any, limit: int = 80) -> str:
    """An entity in words (browser-QA D6): ``user:dsingh`` becomes "user `dsingh`".
    The value is log-derived, so it stays inline code; the kind is an engine word."""
    if not isinstance(raw, str) or not raw.strip():
        return ""
    if ":" not in raw:
        return _code(raw, limit)
    kind, value = raw.split(":", 1)
    kind = kind.strip().lower()
    if kind not in _ENTITY_NOUNS and not re.fullmatch(r"[a-z][a-z_]{0,30}", kind):
        return _code(raw, limit)   # an odd kind is shown exactly, never cleaned into a lookalike
    noun = _ENTITY_NOUNS.get(kind) or kind.replace("_", " ")
    return f"{noun} {_code(value.strip(), limit)}"


def _rule_words(rules: str, limit: int = 60) -> str:
    """Detection rule ids as plain words ("identity_signin" → "identity signin"),
    Markdown-neutral. Nothing is deleted, so no lookalike can form: invisible
    characters are written as visible ``\\uXXXX`` escapes (:func:`visible_text`, as
    :func:`_code` does), and a rule text carrying any other Markdown character
    (``ad*min_login``, ``ad<min>_login``) is shown exactly, as inline code."""
    text = rules if isinstance(rules, str) else ""
    if _MARKDOWN_SPECIALS_RE.search(text.replace("_", "")):
        return _code(text, limit)
    return visible_text(re.sub(r"[_\s]+", " ", text), limit).strip()


def _case_name(case: Mapping[str, Any], *, with_entity: bool = True) -> str:
    """A case in words for the narration (browser-QA D6): the machine title
    ``user:dsingh — identity_signin`` reads "identity signin on user `dsingh`". The
    case id and the exact title stay in the blocks and links. Any other title is
    free text from the case, so it stays inline code (:func:`_code`): exact, with
    its punctuation (``srv_db_01``) and any lookalike character visible."""
    title = case.get("title") if isinstance(case.get("title"), str) else ""
    match = _MACHINE_TITLE_RE.match(title.strip())
    if match:
        kind, value, rules = match.groups()
        what = _rule_words(rules) or "activity"
        return f"{what} on {_entity_phrase(f'{kind}:{value}')}" if with_entity else what
    if title.strip() and title.strip() != case.get("case_id"):
        return _code(title, 80)
    return _entity_phrase(case.get("entity")) if with_entity else ""


def _case_line(case: Mapping[str, Any]) -> str:
    bits = [_code(case.get("case_id"), 60)]
    name = _case_name(case)
    if name:
        bits.append(name)
    facts = []
    if case.get("severity"):
        facts.append(display_text(case.get("severity"), 20))
    if case.get("verdict"):
        facts.append(_verdict_word(case.get("verdict")))
    if _num(case.get("risk_score")) is not None:
        facts.append(f"risk {_count(case.get('risk_score'))}")
    if case.get("status"):
        facts.append(display_text(case.get("status"), 20).replace("_", " "))
    return " · ".join(bits) + (f" — {', '.join(facts)}" if facts else "")


def _case_noun(filters: Mapping[str, Any], noun: str) -> str:
    """"open case", "escalated case", "true-positive case"… from the search filters."""
    if noun != "case":
        return noun
    if filters.get("status_group") == "active":
        return "open case"
    if filters.get("status_group") == "terminal":
        return "closed case"
    if isinstance(filters.get("status"), str):
        return f"{display_text(filters['status'], 20).replace('_', ' ')} case"
    if isinstance(filters.get("verdict"), str):
        return f"{_verdict_word(filters['verdict'])} case"
    return noun


def _say_search_cases(r: Result, *, noun: str = "case") -> str:
    o = r.obs
    count = _num(o.get("count")) or 0
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    window = o.get("window") if isinstance(o.get("window"), str) else "all time"
    when = "" if window == "all time" else f" {_in(display_text(window, 60))}"
    text = f"**{_plural(count, _case_noun(filters, noun))}**{when}"
    bound = _case_lower_bound(o)
    if bound:
        text += f" ({bound})"
    by_status = o.get("by_status") if isinstance(o.get("by_status"), Mapping) else {}
    if by_status and count and not filters.get("status"):
        text += ": " + _join([f"{_count(n)} {display_text(s, 20).replace('_', ' ')}"
                              for s, n in sorted(by_status.items(), key=lambda kv: (-(_num(kv[1]) or 0), kv[0]))])
    return text + "."


def _case_bullets(r: Result | None, limit: int = 3) -> list[str]:
    cases = [c for c in (r.obs.get("cases") if r else None) or [] if isinstance(c, Mapping)]
    return [f"- {_case_line(c)}" for c in cases[:limit]]


def _say_posture(r: Result) -> list[str]:
    o = r.obs
    window = _window(o)
    severity = o.get("severity_counts") if isinstance(o.get("severity_counts"), Mapping) else {}
    critical = _num(severity.get("critical"))
    out = [
        f"**Active Risk Index {_dec(o.get('active_risk_index'), 0)}** over the "
        f"{_plural(_dig(o, 'open_now', 'count'), 'case')} open now (the index is not windowed); "
        f"{_plural(o.get('case_count'), 'case')} were created {_in(window)}"
        + (f", {_count(critical)} of them critical." if critical else ".")
    ]
    quality = o.get("quality") if isinstance(o.get("quality"), Mapping) else {}
    if quality:
        out.append(
            f"False-positive rate **{_pct(quality.get('false_positive_rate'), ratio=True)}**; "
            f"{_pct(quality.get('automation_rate'), ratio=True)} of closed cases were closed automatically "
            f"and {_pct(quality.get('escalation_rate'), ratio=True)} were escalated.")
    parts = [f"{_count(severity[s])} {s}" for s in ("critical", "high", "medium", "low", "info")
             if _num(severity.get(s))]
    if parts:
        out.append(f"By severity: {_join(parts)}.")
    timing = []
    lifecycle = o.get("lifecycle_minutes") if isinstance(o.get("lifecycle_minutes"), Mapping) else {}
    for key, name in (("mttd_minutes", "MTTD"), ("mtta_minutes", "MTTA"), ("mttr_minutes", "MTTR")):
        metric = lifecycle.get(key) if isinstance(lifecycle.get(key), Mapping) else None
        if metric is None:
            continue
        if metric.get("measured") and _num(metric.get("p50")) is not None:
            timing.append(f"{name} p50 {_minutes(metric.get('p50'))} (p90 {_minutes(metric.get('p90'))})")
        else:
            timing.append(f"{name} not measured yet")
    if timing:
        out.append(f"Timing: {_join(timing)}.")
    sla = o.get("sla") if isinstance(o.get("sla"), Mapping) else {}
    if sla.get("enabled") and _num(sla.get("evaluated")):
        out.append(f"SLA attainment {_pct(sla.get('attainment_pct'))} over {_plural(sla.get('evaluated'), 'case')} "
                   f"({_count(sla.get('response_breached'))} response and {_count(sla.get('resolve_breached'))} "
                   f"resolution breaches).")
    out.append(_completeness(o))
    return [s for s in out if s]


def _completeness(o: Mapping[str, Any]) -> str:
    comp = o.get("completeness") if isinstance(o.get("completeness"), Mapping) else {}
    if not comp:
        return ""
    fetched, total = _num(comp.get("fetched")), _num(comp.get("store_total"))
    if comp.get("truncated"):
        return (f"Computed from the newest {_count(fetched)} of {_count(total)} stored cases, so older cases "
                f"are not counted.")
    if comp.get("window_covered") is False:
        return "The case store does not reach back over the whole window, so the figures are partial."
    return f"Computed exactly from all {_plural(fetched, 'stored case')}." if fetched else ""


def _partial_completeness(o: Mapping[str, Any]) -> str:
    """:func:`_completeness` only when it is a caveat (the figures are partial)."""
    comp = o.get("completeness") if isinstance(o.get("completeness"), Mapping) else {}
    if comp.get("truncated") or comp.get("window_covered") is False:
        return _completeness(o)
    return ""


_UNIT_ADJECTIVE = {"hour": "hourly", "day": "daily", "week": "weekly", "month": "monthly", "quarter": "quarterly",
                   "year": "yearly"}


def _bucket_labels(o: Mapping[str, Any], size: int) -> list[str]:
    """The engine's calendar bucket labels ("Oct 2026", "W41 2026") when there is one
    per point, the period in progress marked; else []."""
    rows = [b for b in o.get("buckets") or [] if isinstance(b, Mapping)]
    if len(rows) != size:
        return []
    return [display_text(b.get("label"), 40) + (" (in progress)" if b.get("in_progress") else "") for b in rows]


def _say_trends(r: Result) -> str:
    o = r.obs
    new = [_num(v) for v in o.get("new_cases") or []]
    closed = [_num(v) for v in o.get("closed") or []]
    measured = [v for v in new if v is not None]
    if not measured:
        return ""
    unit = o.get("bucket") if isinstance(o.get("bucket"), str) else None
    bucket = _num(o.get("bucket_minutes"))
    labels = _bucket_labels(o, len(new))
    # ``size`` measures a distance between buckets ("1 hour before the latest");
    # ``kind`` names the buckets themselves. The bucket COUNT is never written as a
    # duration: a trailing 24 h window touches 25 hourly buckets (its first and last
    # are partial), and "last 24h (25 hours)" would contradict itself.
    if unit in _UNIT_ADJECTIVE:
        size, kind = unit, f"{_UNIT_ADJECTIVE[unit]} bucket"
    elif bucket == 60:
        size, kind = "hour", "hourly bucket"
    elif bucket == 1440:
        size, kind = "day", "daily bucket"
    elif bucket and bucket % 60 == 0:
        size = kind = f"{_dec(bucket / 60, 0)}-hour bucket"
    elif bucket:
        size = kind = f"{_dec(bucket, 0)}-minute bucket"
    else:
        size, kind = "bucket", "bucket"
    peak = max(measured)
    peak_at = max(i for i, v in enumerate(new) if v == peak)
    if labels:
        where = labels[peak_at]
    else:
        where = (f"the latest {size}" if peak_at == len(new) - 1
                 else f"{_plural(len(new) - 1 - peak_at, size)} before the latest")
    text = (f"Trend {_in(_window(o))} in {kind}s: {_count(sum(measured))} new and "
            f"{_count(sum(v for v in closed if v is not None))} closed cases; the peak was {where}, with "
            f"{_plural(peak, 'new case')}.")
    alerts = [v for v in (_num(a) for a in o.get("alerts") or []) if v is not None]
    if alerts:
        text += (f" Alert ingest was recorded in {len(alerts)} of the {len(new)} {kind}s "
                 f"({_count(sum(alerts))} alerts).")
    return text


def _stages(o: Mapping[str, Any]) -> dict[str, float]:
    out: dict[str, float] = {}
    for stage in o.get("stages") or []:
        if isinstance(stage, Mapping) and isinstance(stage.get("key"), str):
            value = _num(stage.get("total"))
            if value is not None:
                out[stage["key"]] = value
    return out


def _say_noise(r: Result) -> list[str]:
    o = r.obs
    stages = _stages(o)
    overall = _dig(o, "reduction_pct", "overall")
    before = _dig(o, "reduction_pct", "before_human")
    out = [
        f"**{_pct(overall)} noise reduction** {_in(_window(o))}: {_plural(stages.get('ingested'), 'alert')} "
        f"ingested became {_plural(stages.get('clustered'), 'cluster')} and "
        f"{_plural(stages.get('cases'), 'case')}, and **{_count(stages.get('needs_human'))} needed a human**."
    ]
    detail = []
    if "auto_cleared" in stages:
        detail.append(f"AI auto-cleared {_count(stages['auto_cleared'])}")
    if "escalated" in stages:
        detail.append(f"{_count(stages['escalated'])} were escalated")
    if "closed" in stages:
        detail.append(f"{_count(stages['closed'])} were closed by a human")
    if stages.get("policy_closed"):
        detail.append(f"{_count(stages['policy_closed'])} were closed by analyst policy")
    if detail:
        out.append(f"Of the cases, {_join(detail)}.")
    if _num(before) is not None:
        out.append(f"Before any human looked, volume was already down {_pct(before)}.")
    if _dig(o, "counters", "incomplete"):
        out.append("The ingest counters do not span the whole window yet, so the alert count is a lower bound.")
    drops = o.get("drops") if isinstance(o.get("drops"), Mapping) else {}
    if _num(drops.get("suppressed")) or _num(drops.get("ignored")):
        out.append(f"{_count(drops.get('suppressed'))} alerts were suppressed and {_count(drops.get('ignored'))} "
                   f"ignored by rules before clustering.")
    return out


def _say_case_mix(r: Result) -> str:
    o = r.obs
    verdicts = o.get("by_verdict") if isinstance(o.get("by_verdict"), Mapping) else {}
    parts = [f"{_count(n)} {display_text(v, 20).replace('_', ' ').lower()}"
             for v, n in sorted(verdicts.items(), key=lambda kv: (-(_num(kv[1]) or 0), kv[0]))]
    text = f"{_plural(o.get('cases'), 'case')} {_in(_window(o))}"
    if parts:
        text += f" ({_join(parts)})"
    if _num(o.get("avg_risk_score")) is not None:
        text += f", average risk {_dec(o.get('avg_risk_score'))}"
    return text + "."


def _say_timing(r: Result) -> str:
    o = r.obs
    lifecycle = o.get("lifecycle_minutes") if isinstance(o.get("lifecycle_minutes"), Mapping) else {}
    parts = []
    for key, name in (("mttd_minutes", "MTTD"), ("mtta_minutes", "MTTA"), ("mttr_minutes", "MTTR"),
                      ("dwell_minutes", "dwell")):
        metric = lifecycle.get(key) if isinstance(lifecycle.get(key), Mapping) else None
        if metric is None:
            continue
        if metric.get("measured") and _num(metric.get("p50")) is not None:
            count = f" over {_plural(metric.get('count'), 'case')}" if _num(metric.get("count")) else ""
            parts.append(f"{name} p50 {_minutes(metric.get('p50'))} (p90 {_minutes(metric.get('p90'))}){count}")
        else:
            parts.append(f"{name} not measured yet")
    return f"Response times {_in(_window(o))}: {_join(parts)}." if parts else ""


def _say_auto_close(r: Result) -> str:
    o = r.obs
    current = o.get("current") if isinstance(o.get("current"), Mapping) else {}
    text = (f"Auto-close {_in(_window(o))}: {_pct(current.get('rate'), ratio=True)} of "
            f"{_plural(current.get('decided'), 'decided case')} closed automatically, "
            f"{_count(current.get('routed_to_human'))} routed to a human.")
    if o.get("status") == "insufficient_evidence":
        text += " There is not enough history in the previous window to compare against yet."
    elif o.get("needs_attention"):
        text += " The rate moved enough versus the previous window to need attention."
    return text


def _say_mitre_coverage(r: Result) -> str:
    o = r.obs
    top = [t for t in o.get("top_techniques") or [] if isinstance(t, Mapping)][:3]
    text = (f"Cases cover {_count(o.get('covered_techniques'))} of {_count(o.get('total_techniques'))} ATT&CK "
            f"techniques ({_pct(o.get('coverage_pct'))})")
    if top:
        text += "; most seen: " + _join([f"{display_text(t.get('id'), 12)} {display_text(t.get('name'), 60)} "
                                         f"({_plural(t.get('cases'), 'case')})" for t in top])
    return text + "."


def _say_soc_metrics(r: Result) -> list[str]:
    kind = r.kind
    if kind == "posture":
        return _say_posture(r)
    if kind == "trends":
        return [_say_trends(r)]
    if kind == "noise_funnel":
        return _say_noise(r)
    if kind == "case_mix":
        return [_say_case_mix(r)]
    if kind == "timing":
        return [_say_timing(r)]
    if kind == "auto_close_health":
        return [_say_auto_close(r)]
    if kind == "mitre_coverage":
        return [_say_mitre_coverage(r)]
    # No narration for this kind: numbers are stated only from observations the
    # planner reads structurally, so point at the blocks instead of quoting text.
    return [f"The `{display_text(kind or 'soc_metrics', 40)}` metrics are shown below ({_window(r.obs)})."]


def _say_cost(r: Result) -> list[str]:
    o = r.obs
    simulated = " (simulated)" if o.get("simulated") else ""
    out = [f"**AI spend {_in(_window(o))}: {_usd(o.get('total_cost_usd'))}{simulated}** across "
           f"{_plural(o.get('calls'), 'model call')} and {_plural(o.get('total_tokens'), 'token')}."]
    for key, name in (("by_role", "By role"), ("by_model", "By model"), ("by_surface", "By surface")):
        rows = [x for x in o.get(key) or [] if isinstance(x, Mapping)][:4]
        if rows:
            out.append(f"{name}: " + _join([f"{_code(x.get('key'), 40)} {_usd(x.get('cost'))} "
                                            f"({_plural(x.get('calls'), 'call')})" for x in rows]) + ".")
    daily = _dig(o, "budget", "daily")
    if _dig(o, "budget", "enabled") and isinstance(daily, Mapping) and _num(daily.get("cap")):
        out.append(f"Today's budget: {_usd(daily.get('spent'))} of {_usd(daily.get('cap'))} "
                   f"({_pct(daily.get('fraction'), ratio=True)}, {display_text(daily.get('band'), 20) or 'ok'}). "
                   "The daily budget limits automatic investigations (at the limit they route to Needs human); "
                   "chat answers are not blocked by it.")
    return out


def _say_shift(r: Result, *, with_window: bool = True) -> list[str]:
    o = r.obs
    head = o.get("headline") if isinstance(o.get("headline"), Mapping) else {}
    # ``needs_human`` counts cases whose STATUS is Needs human (shift_report), not
    # every case with a needs-human verdict (those can be escalated or on hold).
    when = f" at the end of the {_window(o)}" if with_window else ""
    out = [f"**{_plural(head.get('open'), 'open case')}**{when}: "
           f"{_count(head.get('escalated'))} escalated, {_count(head.get('needs_human'))} in Needs human "
           f"status, {_count(head.get('unassigned'))} unassigned and {_count(head.get('sla_breached'))} past SLA."]
    changes = o.get("changes_vs_prior_window") if isinstance(o.get("changes_vs_prior_window"), Mapping) else {}
    moved = []
    for key, name in (("open", "open"), ("escalated", "escalated"), ("sla_breached", "past SLA")):
        delta = _num(_dig(changes, key, "delta"))
        if delta:
            moved.append(f"{name} {'+' if delta > 0 else '−'}{_count(abs(delta))}")
    if moved:
        out.append(f"Versus the previous window: {_join(moved)}.")
    return out


def _say_campaigns(r: Result) -> str:
    o = r.obs
    rows = [c for c in o.get("campaigns") or [] if isinstance(c, Mapping)]
    text = f"**{_plural(o.get('total'), 'campaign')}**"
    if o.get("status_filter"):
        text += f" ({display_text(o.get('status_filter'), 20)})"
    if not rows:
        return text + "."
    parts = []
    for c in rows[:3]:
        # Named by its display name, else by what ties it together (the shared
        # entity): the content-hash id stays in the table (browser-QA D6). The name
        # is stored text, so it is inline code like a case id (exact, lookalikes visible).
        name = _code(c.get("name"), 60) if isinstance(c.get("name"), str) and c.get("name").strip() else ""
        what = _plural(c.get("case_count"), "case")
        entities = [e for e in c.get("entities") or [] if isinstance(e, str)][:2]
        if entities:
            what += " sharing " + _join([_entity_phrase(e, 60) for e in entities])
        bits = []
        if c.get("severity"):
            bits.append(display_text(c.get("severity"), 20))
        mitre = [m for m in c.get("mitre") or [] if isinstance(m, str)][:3]
        if mitre:
            bits.append("ATT&CK " + ", ".join(display_text(m, 12) for m in mitre))
        detail = f" ({'; '.join(bits)})" if bits else ""
        parts.append(f"{name} with {what}{detail}" if name else f"{what}{detail}")
    return f"{text}: {_join(parts)}."


def _say_lookup(r: Result) -> str:
    o = r.obs
    value = _code(o.get("indicator"), 100)
    score = _num(o.get("reputation_score"))
    verdict = display_text(o.get("verdict"), 30) or "unknown"
    answered, queried = _num(o.get("providers_answered")) or 0, _num(o.get("providers_queried")) or 0
    # A Demo Mode synthetic result queried no provider, so no provider "answered".
    providers = ("a labelled Demo Mode synthetic result; no provider was queried"
                 if o.get("synthetic_demo_result") else f"{_count(answered)} of {_plural(queried, 'provider')} answered")
    if score is None:
        text = f"{value} has no reputation score ({providers})"
    else:
        text = f"**{value} scores {_count(score)}/100 ({verdict})** ({providers})"
    return text + "."


def _verdict_adjective(value: Any) -> str:
    """A verdict as a compound adjective ("true-positive", "needs-human")."""
    return _verdict_word(value).replace(" ", "-")


def _case_facts(case: Mapping[str, Any]) -> str:
    """The case's verdict as a predicate with its verb: "is a true positive at 99%
    confidence, risk 88/100, severity critical", "has a needs-human verdict at 88%
    confidence, …" (needs-human is a routing verdict, not a kind of case), "has no
    verdict yet, …". Risk and severity are separate axes, so each is named: a bare
    "risk 7 (critical)" reads as a critical risk band beside a LOW risk gauge."""
    verdict = _verdict_word(case.get("verdict"))
    if not verdict:
        text = "has no verdict yet"
    elif str(case.get("verdict") or "").upper() in ("TRUE_POSITIVE", "FALSE_POSITIVE"):
        text = f"is a {verdict}"
    else:
        text = f"has a {_verdict_adjective(case.get('verdict'))} verdict"
    confidence = _num(case.get("confidence"))
    if confidence is not None:
        text += f" at {_pct(confidence, ratio=True)} confidence"
    if _num(case.get("risk_score")) is not None:
        text += f", risk {_count(case.get('risk_score'))}/100"
    if case.get("severity"):
        text += f", severity {display_text(case.get('severity'), 20)}"
    return text


def _say_get_case(r: Result, *, lead: bool = True) -> list[str]:
    o = r.obs
    case = o.get("case") if isinstance(o.get("case"), Mapping) else {}
    out: list[str] = []
    if lead:
        name = _case_name(case)
        head = (f"**{_code(case.get('case_id'), 60)}**" + (f" ({name})" if name else "")
                + f" {_case_facts(case)}, status **{display_text(case.get('status'), 30).replace('_', ' ')}**")
        if case.get("decision_by"):
            head += f", last decided by {display_text(case.get('decision_by'), 30)}"
        out.append(head + ".")
    facts = []
    entity = _entity_phrase(case.get("entity"))
    if entity and entity not in _case_name(case):
        # The lead names the case by what happened to which entity (D6); the entity
        # is listed here only when that name does not already show it.
        facts.append(entity)
    rules = [x for x in case.get("rules") or [] if isinstance(x, str)][:3]
    if rules:
        facts.append(("rule " if len(rules) == 1 else "rules ") + _join([_code(x, 60) for x in rules]))
    if case.get("source"):
        facts.append(f"source {_code(case.get('source'), 60)}")
    if _num(case.get("member_events")) is not None:
        facts.append(_plural(case.get("member_events"), "member event"))
    if facts:
        out.append(f"It covers {_join(facts)}.")
    evidence = [e for e in o.get("evidence") or [] if isinstance(e, Mapping) and e.get("summary")]
    if evidence:
        out.append(f"Recorded evidence: {_plain(evidence[0].get('summary'))}")
    mitre = [m for m in o.get("mitre") or [] if isinstance(m, Mapping) and m.get("id")]
    if mitre:
        out.append("ATT&CK: " + _join([
            f"{display_text(m.get('id'), 12)} {display_text(m.get('name'), 60)}"
            + (f" ({display_text(m.get('tactic'), 40)})" if m.get("tactic") else "") for m in mitre[:4]]) + ".")
    return out


# decide() outcome → (verb, trailing words) for "the policy <verb> a <verdict> … <trail>".
_OUTCOME_WORDS: dict[str, tuple[str, str]] = {
    "needs_human": ("sends", " to a human"), "escalated": ("escalates", ""),
    "closed": ("auto-closes", ""), "resolved": ("auto-closes", ""), "auto_closed": ("auto-closes", ""),
    "open": ("keeps", " open"),
}


def _policy_reason(o: Mapping[str, Any], what: Mapping[str, Any]) -> str:
    """Why ``decide()`` lands where it does, from the policy table in the observation
    (enabled flag, minimum confidence, maximum risk) — numbers, never the model."""
    verdict = what.get("verdict")
    row = next((p for p in o.get("policy") or [] if isinstance(p, Mapping) and p.get("verdict") == verdict), None)
    if verdict == "NEEDS_HUMAN":
        return "a needs-human verdict never auto-closes (enforced in code)"
    if not isinstance(row, Mapping):
        return ""
    word = _verdict_word(verdict)
    if not row.get("auto_close_enabled"):
        return f"{word.replace(' ', '-')} auto-close is turned off in the policy"
    reasons = []
    confidence, minimum = _num(what.get("confidence")), _num(row.get("min_confidence"))
    if confidence is not None and minimum is not None and confidence < minimum:
        reasons.append(f"confidence {_pct(confidence, ratio=True)} is below the {_pct(minimum, ratio=True)} bar")
    risk, ceiling = _num(what.get("risk_score")), _num(row.get("max_risk_score"))
    if risk is not None and ceiling is not None and risk > ceiling:
        reasons.append(f"risk {_count(risk)} is above the {_count(ceiling)} ceiling")
    if reasons:
        return _join(reasons)
    return (f"it meets the {word} bar (confidence at least {_pct(minimum, ratio=True)}, risk at most "
            f"{_count(ceiling)})") if minimum is not None and ceiling is not None else ""


def _say_decision(r: Result) -> str:
    o = r.obs
    what = o.get("what_if") if isinstance(o.get("what_if"), Mapping) else {}
    if not what:
        return ""
    status = display_text(what.get("status"), 30)
    verb, trail = _OUTCOME_WORDS.get(status, ("gives", f" the status {status.replace('_', ' ')}"))
    text = (f"The deterministic auto-close policy {verb} a case with a {_verdict_adjective(what.get('verdict'))} "
            f"verdict at {_pct(_num(what.get('confidence')), ratio=True)} confidence and risk "
            f"{_count(what.get('risk_score'))}{trail}")
    reason = _policy_reason(o, what)
    text += f", because {reason}." if reason else "."
    recorded = o.get("recorded") if isinstance(o.get("recorded"), Mapping) else {}
    by = recorded.get("decision_by")
    if isinstance(by, str) and by and by != what.get("decision_by"):
        who = display_text(by, 30).replace("_", " ")
        text += f" The current status was recorded by {'an analyst' if who == 'analyst' else who}."
    return text


def _say_mitre(r: Result) -> list[str]:
    techniques = [t for t in r.obs.get("techniques") or [] if isinstance(t, Mapping)]
    out = []
    for tech in techniques[:3]:
        tactics = [display_text(t, 40) for t in tech.get("tactics") or [] if isinstance(t, str)]
        line = f"**{display_text(tech.get('id'), 12)} {display_text(tech.get('name'), 80)}**"
        if tactics:
            line += f" ({_join(tactics)})"
        description = _first_sentences(display_text(tech.get("description"), 400), 1)
        out.append(line + (f": {description}" if description else "."))
    if not techniques:
        out.append("No ATT&CK technique in the bundled corpus matches that.")
    return out


def _say_sources(r: Result) -> list[str]:
    o = r.obs
    cov = o.get("coverage") if isinstance(o.get("coverage"), Mapping) else {}
    silent = _num(cov.get("sources_silent")) or 0
    out = [f"**{_count(cov.get('sources_enabled'))} of {_plural(cov.get('sources_total'), 'source')} enabled; "
           f"{_count(silent)} silent.** Combined ingest is {_dec(cov.get('events_per_min'))} events/min."]
    rows = [s for s in o.get("sources") or [] if isinstance(s, Mapping)]
    flagged = [s for s in rows if s.get("silent") or s.get("last_poll_failed") or not s.get("enabled", True)]
    for s in (flagged or rows)[:5]:
        state = []
        if s.get("silent"):
            state.append("silent")
        if s.get("last_poll_failed"):
            state.append("last poll failed")
        if not s.get("enabled", True):
            state.append("disabled")
        state = state or [display_text(s.get("state"), 20) or "ok"]
        out.append(f"- {_code(s.get('name'), 60)} ({display_text(s.get('type'), 20)}, "
                   f"{display_text(s.get('kind'), 10)}): {', '.join(state)}")
    return out


def _say_audit(r: Result) -> str:
    o = r.obs
    by_type = o.get("by_action_type") if isinstance(o.get("by_action_type"), Mapping) else {}
    parts = [f"{_count(n)} {display_text(k, 30).replace('_', ' ')}"
             for k, n in sorted(by_type.items(), key=lambda kv: (-(_num(kv[1]) or 0), kv[0]))[:4]]
    text = f"**{_plural(o.get('matched'), 'audit row')}** {_in(_window(o))}"
    return text + (f": {_join(parts)}." if parts else ".")


def _say_knowledge(r: Result) -> tuple[list[str], list[str]]:
    o = r.obs
    chunks = [c for c in o.get("chunks") or [] if isinstance(c, Mapping)]
    lines, cites = [], []
    for chunk in chunks[:3]:
        ref = chunk.get("ref") if isinstance(chunk.get("ref"), str) and re.fullmatch(r"K\d{1,4}", chunk["ref"]) else None
        title = _plain(chunk.get("title"), 80) or "Untitled"
        source = display_text(chunk.get("source"), 30)
        trust = "curated" if chunk.get("trusted") else "imported, untrusted"
        lines.append(f"- **{title}** ({source}, {trust})" + (f" [{ref}]" if ref else ""))
        if ref:
            cites.append(ref)
    if not chunks:
        items = [x for x in (o.get("runbooks") or o.get("playbooks") or o.get("items") or [])
                 if isinstance(x, Mapping)]
        for item in items[:5]:
            lines.append(f"- {_plain(item.get('title') or item.get('name') or item.get('id'), 80)}")
    return lines, cites


def _say_result(r: Result) -> list[str]:
    """Generic narration for any successful result (used by the generic final)."""
    if r.tool == "log_stats":
        return [_say_log_stats(r)]
    if r.tool == "search_logs":
        return [_say_search_logs(r)]
    if r.tool == "search_cases":
        return [_say_search_cases(r), *_case_bullets(r)]
    if r.tool == "soc_metrics":
        return _say_soc_metrics(r)
    if r.tool == "cost_usage":
        return _say_cost(r)
    if r.tool == "shift_report":
        return _say_shift(r)
    if r.tool == "list_campaigns":
        return [_say_campaigns(r)]
    if r.tool == "lookup_indicator":
        return [_say_lookup(r)]
    if r.tool == "get_case":
        return _say_get_case(r)
    if r.tool == "explain_decision":
        return [_say_decision(r)]
    if r.tool == "mitre_lookup":
        return _say_mitre(r)
    if r.tool == "source_health":
        return _say_sources(r)
    if r.tool == "audit_search":
        return [_say_audit(r)]
    if r.tool == "search_knowledge":
        return _say_knowledge(r)[0]
    if r.tool in _REFERENCE_TOOLS:
        return []
    # No narration for this tool: state its engine summary (counts, never log text)
    # rather than promise blocks below — a lookup that found nothing shows none (D3).
    summary = _plain(r.summary, 200)
    return [_sentence(summary) if summary else f"`{r.tool}` completed."]


# --------------------------------------------------------------------------- #
# Help Center excerpts (trusted product reference).
# --------------------------------------------------------------------------- #
def _first_sentences(text: str, count: int = 2, limit: int = 320) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9*`])", text)
    out = ""
    for part in parts[:count]:
        candidate = f"{out} {part}".strip()
        if len(candidate) > limit and out:
            break
        out = candidate
    if len(out) > limit:
        out = out[: limit - 1].rstrip() + "…"
    return out


_LIST_ITEM_RE = re.compile(r"^(?:[-*]|\d+\.)\s+")


def _list_items(lines: Sequence[str], limit: int = 3) -> str:
    items = [_LIST_ITEM_RE.sub("", ln).strip() for ln in lines if _LIST_ITEM_RE.match(ln)]
    items = [re.sub(r"[;,]?\s*(?:and|or)$", "", i.rstrip(";.")).strip() for i in items if i]
    return "; ".join(items[:limit]) + "." if items else ""


def _table_summary(lines: Sequence[str], limit: int = 5) -> str:
    """A Markdown table as "Connector: Elasticsearch, OpenSearch and Wazuh" (the first
    column's values, which name what the table is about)."""
    rows = [[c.strip() for c in ln.strip().strip("|").split("|")] for ln in lines if ln.strip().startswith("|")]
    rows = [r for r in rows if r and not all(re.fullmatch(r":?-{3,}:?", c or "-") for c in r)]
    if len(rows) < 2 or not rows[0][0]:
        return ""
    values = [r[0].replace("`", "") for r in rows[1:] if r[0]][:limit]
    return f"{rows[0][0]}: {_join(values)}." if values else ""


def _lead(section: HelpSection) -> str:
    """The first readable prose of a Help Center excerpt: a sentence or two, a short
    list, or a one-line summary of a table. A fragment (an excerpt that starts mid-
    sentence) is skipped so the answer never quotes half a thought."""
    paragraphs: list[list[str]] = [[]]
    for line in section.lines:
        # The renderer's own shortening marker is not part of the docs' prose.
        line = line.replace(" … [excerpt shortened]", "…")
        if not line.strip():
            paragraphs.append([])
        else:
            paragraphs[-1].append(line.strip())
    paragraphs = [p for p in paragraphs if p]
    pieces: list[str] = []
    for index, para in enumerate(paragraphs):
        if all(line.startswith("|") for line in para):
            summary = _table_summary(para)
            if summary:
                pieces.append(summary)
            continue
        prose = [line for line in para if not _LIST_ITEM_RE.match(line)]
        if not prose:
            items = _list_items(para)
            if items:
                pieces.append(items)
            continue
        text = _first_sentences(" ".join(prose))
        if not text or not re.match(r"^[A-Z0-9*`\"(]", text):
            continue
        if text.endswith(":"):
            following = para if any(_LIST_ITEM_RE.match(ln) for ln in para) else (
                paragraphs[index + 1] if index + 1 < len(paragraphs) else [])
            items = _list_items(following)
            text = f"{text} {items}" if items else text.rstrip(":") + "."
        pieces.append(text)
        if sum(len(p) for p in pieces) >= 90:
            break
    lead = " ".join(pieces).strip()
    return lead if len(lead) >= 50 else ""


_TOPIC_STOP_WORDS = frozenset({
    "what", "which", "when", "where", "does", "have", "with", "from", "that", "this", "there", "their",
    "show", "tell", "about", "into", "over", "last", "hours", "days", "please", "could", "would", "should",
})


def _help_paragraphs(ref: Reference, limit: int = 2, *, topic: str = "",
                     require_match: bool = False) -> tuple[list[str], list[str]]:
    """``(lines, cited ids)``: the best cited sections with their lead prose; sections
    whose lead mentions the topic's words rank first (stable otherwise). With
    ``require_match`` a section that shares no topic word is left out entirely.
    Sections that share a title (one page split into excerpts) are shown once."""
    ordered = [w for w in re.findall(r"[a-z]{3,}", topic.lower()) if w not in _TOPIC_STOP_WORDS]
    words = {w for w in ordered if len(w) >= 4}
    # Adjacent topic words ("total cases") found in a section TITLE mark the section
    # that is about the thing asked, not one that merely mentions its words.
    phrases = {f"{a} {b}" for a, b in zip(ordered, ordered[1:])}
    ranked: list[tuple[int, int, HelpSection, str]] = []
    seen: set[str] = set()
    for position, section in enumerate(ref.sections):
        if section.ref is None or section.ref in seen:
            continue
        seen.add(section.ref)
        lead = _lead(section)
        title = section.title.lower()
        hay = f"{title} {lead}".lower()
        hits = sum(1 for w in words if w in hay)
        if require_match and not hits:
            continue
        score = hits + sum(1 for w in words if w in title) + 3 * sum(1 for p in phrases if p in title)
        ranked.append((-(score if lead else -1), position, section, lead))
    ranked.sort(key=lambda item: (item[0], item[1]))
    lines: list[str] = []
    cited: list[str] = []
    extra: list[str] = []
    titles: set[str] = set()
    for _score, _pos, section, lead in ranked:
        # The best-ranked excerpt of a title speaks for it; a second excerpt of the
        # same page would repeat the heading back to back.
        title_key = section.title.strip().lower()
        if title_key in titles:
            continue
        titles.add(title_key)
        if lead and len(lines) < limit:
            lines.append(f"**{display_text(section.title, 120)}** [{section.ref}]: {lead}")
            cited.append(section.ref or "")
        elif len(extra) < 3:
            extra.append(f"[{section.ref}] {display_text(section.title, 100)}")
            cited.append(section.ref or "")
    if extra:
        lines.append(f"Also see {_join(extra)}.")
    return lines, [c for c in cited if c]


def _console_ids(ref: Reference, limit: int = 3) -> list[str]:
    ids = [t.id for t in ref.targets if t.allowed] + [t.id for t in ref.targets if not t.allowed]
    for section in ref.sections:
        ids.extend(section.console)
    return list(dict.fromkeys(ids))[:limit]


def _console_sentence(ref: Reference, *, locked_prefix: str = "Locked for your role") -> str:
    allowed = [t for t in ref.targets if t.allowed][:2]
    locked = [t for t in ref.targets if not t.allowed][:3]
    parts = []
    if allowed:
        parts.append("Open it in the console: " + _join([f"**{display_text(t.label, 100)}**" for t in allowed]) + ".")
    if locked:
        parts.append(f"{locked_prefix}: " + _join([
            f"**{display_text(t.label, 100)}**" + (f" (needs {display_text(t.requires, 40)})" if t.requires else "")
            for t in locked]) + ".")
    return " ".join(parts)


# --------------------------------------------------------------------------- #
# Follow-ups (three, each leading to another intent the caller can run).
# --------------------------------------------------------------------------- #
_FOLLOW_UPS: dict[str, tuple[str, tuple[str, ...]]] = {
    "posture": ("How is our security posture right now?", ("soc_metrics",)),
    "noise": ("Show the noise reduction funnel for the last 24 hours", ("soc_metrics",)),
    "shift": ("Write a shift brief for the incoming analyst", ("shift_report",)),
    "tp": ("Summarise today's true positives", ("search_cases",)),
    "top": ("Which hosts generated the most events in the last 7 days?", ("log_stats",)),
    "cost": ("What did AI spend look like in the last 24 hours?", ("cost_usage",)),
    "sources": ("Are any log sources silent?", ("source_health",)),
    "campaigns": ("Which campaigns are open?", ("list_campaigns",)),
    "case": ("Investigate the newest escalated case", ("search_cases", "get_case")),
    "pivot": ("Hunt the source IP behind the newest SQL injection case", ("search_cases", "get_case")),
    "brute": ("Show failed sign-ins by source IP and the brute-force cases", ("log_stats", "search_cases")),
    "mitre": ("What is ATT&CK technique T1110, and how often do we see it?", ("mitre_lookup",)),
    "help": ("How do I connect a new log source?", ("app_help",)),
    "explain_metric": ("What does the false-positive rate measure, and what is ours?", ("app_help",)),
    "access": ("What can I do from this chat with my access?", ("app_help", "app_status")),
    "by_user": ("Break that down by user instead", ("log_stats",)),
    "by_host": ("Break that down by host instead", ("log_stats",)),
    "as_table": ("Show that as a table", ()),
    "week": ("Same for the last 7 days", ()),
}
_FOLLOW_UP_ORDER: dict[str, tuple[str, ...]] = {
    "posture": ("noise", "shift", "case", "tp"),
    "noise": ("posture", "explain_metric", "tp", "cost"),
    "metric": ("posture", "noise", "shift"),
    "shift": ("case", "posture", "campaigns", "tp"),
    "cost": ("posture", "noise", "access"),
    "brute": ("pivot", "mitre", "by_user"),
    "top": ("by_user", "case", "sources"),
    "logs": ("by_user", "week", "top", "sources"),
    "log_count": ("by_user", "week", "top", "sources"),
    "regroup": ("as_table", "case", "posture"),
    "tp": ("case", "shift", "posture"),
    "hunt": ("case", "mitre", "campaigns"),
    "pivot": ("case", "mitre", "campaigns"),
    "case": ("pivot", "shift", "posture"),
    "mitre": ("brute", "posture", "pivot"),
    "sources": ("top", "posture", "help"),
    "campaigns": ("case", "shift", "posture"),
    "audit": ("cost", "posture", "access"),
    "automation": ("posture", "shift", "access"),
    "knowledge": ("case", "mitre", "help"),
    "help": ("access", "posture", "explain_metric"),
    "explain_metric": ("posture", "shift", "help"),
    "reshape": ("posture", "shift", "case"),
    "rerun": ("as_table", "posture", "shift"),
    "cases": ("case", "tp", "shift"),
    "change": ("access", "help", "posture"),
    "unsupported": ("access", "help", "posture"),
    "remember": ("posture", "shift", "help"),
    "fallback": ("posture", "shift", "help"),
    "empty": ("posture", "shift", "help"),
}
_DEFAULT_FOLLOW_UPS = ("posture", "shift", "case", "tp", "noise", "help", "access", "explain_metric")


def _follow_ups(view: PromptView, intent: str, *, charts: bool = False, field: str | None = None,
                skip: Iterable[str] = ()) -> list[str]:
    skipped = set(skip) | {intent}
    order = list(_FOLLOW_UP_ORDER.get(intent, ())) + [k for k in _DEFAULT_FOLLOW_UPS]
    out: list[str] = []
    for key in order:
        if key in skipped or key not in _FOLLOW_UPS:
            continue
        if key in ("as_table", "week") and not charts:
            continue
        if key == "by_user" and field == "user":
            key = "by_host"
        text, tools = _FOLLOW_UPS[key]
        if not all(view.can(t) for t in tools) or text in out:
            continue
        out.append(text)
        if len(out) == 3:
            break
    return out


# --------------------------------------------------------------------------- #
# Finals.
# --------------------------------------------------------------------------- #
@dataclass
class Final:
    body: list[str]
    blocks: list[dict[str, Any]] = field(default_factory=list)
    citations: list[str] = field(default_factory=list)
    console_links: list[str] = field(default_factory=list)
    follow_ups: list[str] = field(default_factory=list)
    answer_kind: str = "data"
    unsupported: bool = False
    memory_proposal: dict[str, Any] | None = None
    #: Ordinals of failed calls the body already explains (not listed again).
    narrated: set[int] = field(default_factory=set)
    #: The short lead (1–2 paragraphs) that replaces ``body`` when the answer is wrapped
    #: into a report envelope: the report holds the detail (browser-QA D5). Empty =
    #: the first narrative paragraph of ``body``.
    lead: list[str] = field(default_factory=list)
    #: Disclosures that stay in the prose after the lead when the answer is wrapped
    #: into a report envelope: the console pointer, how to get what is missing and
    #: the lookups that did not complete. Only a builder that writes these notes into
    #: its own body sets it (the generic final); :func:`_compose_final` adds them
    #: after the lead for every other builder.
    notes: list[str] = field(default_factory=list)
    #: The closing sentence of an answer that carries a report envelope ("The report
    #: below is ready…"), added after every note so it ends the answer.
    closing: str = ""
    #: SPEC D10: a clarifying question (``{question, options, allow_custom}``).
    clarify: dict[str, Any] | None = None
    #: SPEC D11: the header's ``report`` (``{title, template}``): the server saves the
    #: answer's report to the Reports library after the message persists.
    report_request: dict[str, str] | None = None


def _keep(*blocks: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [b for b in blocks if b]


def _wanted_tools(view: PromptView, ask: Ask) -> list[str]:
    """Every tool the intent's plan asked for, round by round, before the grant filter
    (planners read earlier results through the view, so replaying them is exact)."""
    planner = _PLANS.get(ask.intent)
    if planner is None:
        return []
    wanted: list[str] = []
    for done in range(min(len(view.rounds), MAX_PLAN_ROUNDS - 1) + 1):
        try:
            calls = planner(view, ask, done)
        except Exception:  # noqa: BLE001 -- the note is advisory
            calls = []
        wanted.extend(c.tool for c in calls)
    return list(dict.fromkeys(wanted))


def _missing_split(view: PromptView, ask: Ask) -> tuple[list[str], list[str]]:
    """``(locked, scoped)``: the intent's data tools absent from the prompt because the
    caller lacks the grant (or the deployment switched them off), and those absent
    only because their catalogue scope is outside the analyst's @-scopes."""
    locked: list[str] = []
    scoped: list[str] = []
    for tool in _wanted_tools(view, ask):
        if tool in view.granted or tool not in _TOOL_NAMES:
            continue
        scope = _tool_scope(tool)
        if view.scopes and scope is not None and scope not in view.scopes:
            scoped.append(tool)
        else:
            locked.append(tool)
    return locked, scoped


def _missing_lead(view: PromptView, ask: Ask) -> tuple[str, str]:
    """``(lead, advice)``: what the answer lacks, then how to get it. Each locked tool
    names its own grant ("indicator reputation (needs enrichment:read) and log search
    (needs sources:read)"): grants are per tool, never alternatives across tools."""
    locked, scoped = _missing_split(view, ask)
    # A tool the prompt names as switched off by CONFIGURATION is not a grant gap:
    # the analyst may well hold the grant, so the note never names one for it.
    off = [t for t in locked if t in view.disabled]
    locked = [t for t in locked if t not in view.disabled]
    parts: list[str] = []
    advice: list[str] = []
    if off:
        parts.append(f"Turned off on this deployment: {_join([_TOOL_NAMES[t] for t in off])}")
        advice.append("An administrator can turn " + ("it" if len(off) == 1 else "them")
                      + " back on in Settings.")
    if locked:
        named = []
        for tool in locked:
            grants = _tool_grants(tool)
            named.append(_TOOL_NAMES[tool] + (f" (needs {_join(grants)})" if grants else ""))
        prefix = "not available" if parts else "Not available"
        parts.append(f"{prefix} to you in chat: {_join(named)}")
        advice.append("Ask an administrator for access, or open the matching console page.")
    if scoped:
        names = [_TOOL_NAMES[t] for t in scoped]
        selected = _join([_SCOPE_LABELS.get(s, s) for s in view.scopes])
        prefix = "outside" if parts else "Outside"
        parts.append(f"{prefix} the scopes you selected ({selected}): {_join(names)}")
        wanted = list(dict.fromkeys(s for t in scoped for s in [_tool_scope(t)] if s))
        noun = "scope" if len(wanted) == 1 else "scopes"
        advice.append(f"Add the {_join([_SCOPE_LABELS.get(s, s) for s in wanted])} {noun}, or remove the scope "
                      "chips, to include " + ("it." if len(scoped) == 1 else "them."))
    return "; ".join(parts), " ".join(advice)


#: The composer's scope chip labels (webui ``SCOPE_LABELS``), so the note names a
#: scope exactly as the analyst sees it.
_SCOPE_LABELS = {"logs": "Logs", "cases": "Cases", "metrics": "Metrics", "intel": "Threat intel",
                 "docs": "Help docs", "platform": "Platform"}


def _catalogue_tool(tool: str) -> Any:
    try:
        from ..agents.chat_tools.registry import get_tool
    except Exception:  # noqa: BLE001 -- the note degrades to names only
        return None
    try:
        return get_tool(tool)
    except Exception:  # noqa: BLE001
        return None


def _tool_grants(tool: str) -> list[str]:
    """The grants a tool requires, read from the tool catalogue (class attributes)."""
    found = _catalogue_tool(tool)
    return [f"{r}:{a}" for r, a in getattr(found, "requires", ()) or ()]


def _tool_scope(tool: str) -> str | None:
    """The tool's @-scope from the catalogue (``logs``, ``cases``, ``metrics``, …)."""
    scope = getattr(_catalogue_tool(tool), "scope", None)
    return scope if isinstance(scope, str) else None


def _failure_lines(view: PromptView, skip: Iterable[int] = ()) -> list[str]:
    skipped = set(skip)
    lines = []
    for r in view.failed():
        if r.ordinal in skipped:
            continue
        reason = display_text(r.summary, 160) or r.status
        lines.append(f"- `{r.tool}` {r.status}: {reason}")
    return lines


def _final_posture(view: PromptView, ask: Ask) -> Final | None:
    post, trend = view.ok("soc_metrics", "posture"), view.ok("soc_metrics", "trends")
    if post is None and trend is None:
        return None
    body = []
    window = _window((post or trend).obs)
    if post:
        body.extend(_say_posture(post))
    if trend:
        sentence = _say_trends(trend)
        if sentence:
            body.append(sentence)
    noise = view.ok("soc_metrics", "noise_funnel")
    if noise:
        body.append(_say_noise(noise)[0])
    blocks = _keep(
        _block(post, "kpis", view="kpi_group", title=f"Security posture ({window.split(' (')[0]})"),
        _block(trend, "series", view="line", title="Cases over time"),
        _block(post, "categories", view=_first_view(post, "categories", ("donut", "hbar")),
               title="Cases by severity"),
        _block(noise, "funnel", view="funnel", title="Noise reduction"),
    )
    # As a report: the headline, plus the caveat when the figures are partial.
    lead = body[:1] + ([caveat] if post and (caveat := _partial_completeness(post.obs)) else [])
    return Final(body=body, blocks=blocks, follow_ups=_follow_ups(view, "posture", charts=True), lead=lead)


def _final_noise(view: PromptView, ask: Ask) -> Final | None:
    noise = view.ok("soc_metrics", "noise_funnel")
    if noise is None:
        return None
    return Final(body=_say_noise(noise),
                 blocks=_keep(_block(noise, "funnel", view="funnel", title="Noise reduction"),
                              _block(noise, "kpis", view="kpi_group", title="Reduction figures")),
                 follow_ups=_follow_ups(view, "noise", charts=True))


def _final_metric(view: PromptView, ask: Ask) -> Final | None:
    result = view.ok("soc_metrics", ask.metric)
    if result is None:
        return None
    blocks = [b for kind in ("kpis", "series", "categories", "funnel", "mitre")
              for b in [_block(result, kind)] if b]
    return Final(body=_say_soc_metrics(result), blocks=blocks[:4],
                 follow_ups=_follow_ups(view, "metric", charts=True))


def _shift_steps(shift: Result | None, post: Result | None, camps: Result | None) -> list[str]:
    steps: list[str] = []
    o = shift.obs if shift else {}
    head = o.get("headline") if isinstance(o.get("headline"), Mapping) else {}
    breached = [b for b in _dig(o, "sla", "breached") or [] if isinstance(b, Mapping)]
    if breached:
        steps.append(f"Work the {_plural(len(breached), 'case')} past SLA first: "
                     + _join([_code(b.get("case_id"), 60) for b in breached[:3]]) + ".")
    if _num(head.get("needs_human")):
        steps.append(f"Decide the {_plural(head.get('needs_human'), 'case')} in Needs human status.")
    if _num(head.get("escalated")):
        steps.append(f"Confirm an owner and containment for the {_plural(head.get('escalated'), 'escalated case')}.")
    if _num(head.get("unassigned")):
        steps.append(f"Assign the {_plural(head.get('unassigned'), 'unassigned open case')}.")
    if camps and _num(camps.obs.get("total")):
        steps.append(f"Track the {_plural(camps.obs.get('total'), 'open campaign')} that link related cases.")
    fp = _num(_dig(post.obs if post else {}, "quality", "false_positive_rate"))
    if fp is not None and fp >= 0.7:
        steps.append(f"The false-positive rate is {_pct(fp, ratio=True)}: review tuning proposals for the "
                     "noisiest rules.")
    if shift is None:
        # "Nothing needs attention" is a finding only when the shift snapshot ran: an
        # @-scope or a missing grant that kept it out says nothing about the queue.
        steps.insert(0, "The shift snapshot was not read for this question, so open work is unknown here; check the "
                        "case queue in the console before handing over.")
    elif not steps:
        if _num(head.get("open")):
            steps.append(f"Review the {_plural(head.get('open'), 'open case')}; none is past SLA, escalated, in "
                         "Needs human status or unassigned.")
        else:
            steps.append("No open work needs attention right now; keep watching the queue.")
    return steps[:5]


def _final_shift(view: PromptView, ask: Ask) -> Final | None:
    shift = view.ok("shift_report")
    post = view.ok("soc_metrics", "posture")
    camps = view.ok("list_campaigns")
    if shift is None and post is None:
        return None
    window = _window((shift or post).obs)
    body: list[str] = []
    attention = [a for a in (shift.obs.get("attention") if shift else None) or [] if isinstance(a, Mapping)]
    if shift:
        # The brief's lead names the window once; the headline sentence then omits it.
        lines = _say_shift(shift, with_window=False)
        body.append(f"**Shift brief, {window}.** " + lines[0])
        body.extend(lines[1:])
        if attention:
            body.append("Needs attention first:")
            body.extend(f"- {_case_line(a)}" for a in attention[:3])
    posture_line = ""
    if post:
        p = post.obs
        posture_line = (f"Posture: Active Risk Index {_dec(p.get('active_risk_index'), 0)}, "
                        f"{_plural(p.get('case_count'), 'case')} {_in(_window(p))}, false-positive rate "
                        f"{_pct(_dig(p, 'quality', 'false_positive_rate'), ratio=True)}.")
        body.append(posture_line)
    if camps:
        body.append(_say_campaigns(camps))
    steps = _shift_steps(shift, post, camps)
    if not view.case_scoped:
        # The brief holds the detail (headline, open work, campaigns, metrics, next
        # steps); the prose is its 1–3 sentence lead (browser-QA D5). A Case Manager
        # turn keeps the full narration: its brief is unwrapped into plain blocks.
        lead = [body[0] if shift else posture_line]
        if attention:
            first = attention[0]
            why = [_case_name(first)]
            if first.get("status"):
                why.append(display_text(first.get("status"), 20).replace("_", " "))
            if _num(first.get("risk_score")) is not None:
                why.append(f"risk {_count(first.get('risk_score'))}")
            why = [w for w in why if w]
            lead.append(f"Start with {_code(first.get('case_id'), 60)}" + (f" ({', '.join(why)})" if why else "")
                        + ".")
        body = [line for line in lead if line]
    # One figure shown once (A34): the Summary's own text states only what no block
    # of the brief already shows. The Shift headline KPIs (beside it) carry the five
    # headline counts and the Security posture KPIs (under Key metrics) the posture
    # figures, so each sentence is the fallback for its missing block, never a repeat.
    headline_kpis = _block(shift, "kpis", view="kpi_group", title="Shift headline")
    posture_kpis = _block(post, "kpis", view="kpi_group", title="Security posture")
    summary = " ".join(s for s in (
        _say_shift(shift)[0] if shift and headline_kpis is None else "",
        posture_line if posture_kpis is None else "",
    ) if s)
    summary_section: dict[str, Any] = {"heading": "Summary", "items": _keep(headline_kpis)}
    plain_summary = _plain(summary.replace("**", ""), 1100)
    if plain_summary:
        # A blank summary is left out: the section validator rejects an empty string.
        # A section is shown only with a block, so with no headline KPIs the text is
        # the Summary's own block.
        if summary_section["items"]:
            summary_section["summary"] = plain_summary
        else:
            summary_section["items"] = [{"type": "markdown", "text": plain_summary}]
    sections = [
        summary_section,
        {"heading": "Open work", "items": _keep(
            _block(shift, "case_list", view="case_list", title="Needs attention"),
            _block(shift, "categories", view="hbar", title="Open cases by analyst"),
            _block(camps, "table", view="table", title="Open campaigns"))},
        {"heading": "Key metrics", "items": _keep(
            posture_kpis,
            _block(post, "categories", view=_first_view(post, "categories", ("donut", "hbar")),
                   title="Cases by severity"))},
        {"heading": "Next steps", "items": [
            {"type": "markdown", "text": "\n".join(f"{i}. {s}" for i, s in enumerate(steps, start=1))}]},
    ]
    sections = [s for s in sections if s["items"]]
    envelope = {"type": "report", "title": "Shift brief", "template": "shift", "sections": sections}
    if window.strip():
        envelope["subtitle"] = f"Last shift · {window}"
    return Final(body=body, blocks=[envelope], follow_ups=_follow_ups(view, "shift"), closing=_BRIEF_READY)


def _posture_steps(post: Result | None, noise: Result | None) -> list[str]:
    """Next steps that follow from the posture numbers (never invented values)."""
    steps: list[str] = []
    o = post.obs if post else {}
    open_now = _num(_dig(o, "open_now", "count"))
    critical = _num(_dig(o, "severity_counts", "critical"))
    if open_now:
        steps.append(f"Work down the {_plural(open_now, 'open case')} behind the risk index, highest risk first.")
    if critical:
        steps.append(f"Confirm containment for the {_plural(critical, 'critical case')} in the window.")
    mtta = _dig(o, "lifecycle_minutes", "mtta_minutes")
    if isinstance(mtta, Mapping) and not mtta.get("measured"):
        steps.append("Acknowledge cases as you pick them up, so MTTA becomes measurable.")
    fp = _num(_dig(o, "quality", "false_positive_rate"))
    if fp is not None and fp >= 0.7:
        steps.append(f"Review tuning proposals for the noisiest rules (false-positive rate {_pct(fp, ratio=True)}).")
    human = _stages(noise.obs).get("needs_human") if noise else None
    if human:
        steps.append(f"Decide the {_plural(human, 'case')} the funnel left for a human.")
    if steps:
        return steps[:5]
    if post is None:
        # No posture figures ran (an @-scope or a missing grant): no step can follow from them.
        return ["The posture figures were not read for this question, so no next step can be derived from them; "
                "check the Overview in the console."]
    return ["No follow-up is needed right now; re-run this report at the next handoff."]


#: The default sections of each report template (the composer's ``/report`` requests
#: list the same ones; the analyst's own list wins when the question names sections).
_TEMPLATE_HEADINGS: dict[str, tuple[str, ...]] = {
    "posture": ("Summary", "Key metrics", "Trends", "Noise reduction", "Next steps"),
    "investigation": ("Summary", "Evidence", "Timeline", "Decision", "Next steps"),
    "hunt": ("Hypothesis", "Findings", "Affected entities", "Related cases", "Next steps"),
    "ioc": ("Indicator", "Reputation", "Sightings", "Related cases", "Next steps"),
    "custom": ("Summary", "Findings", "Next steps"),
}
_INTENT_TEMPLATES = {"case": "investigation", "hunt": "ioc", "pivot": "hunt", "posture": "posture"}
_TEMPLATE_TITLES = {"posture": "Posture report", "investigation": "Investigation report", "hunt": "Hunt report",
                    "ioc": "IOC report", "custom": "Report"}
_ANY_LEAF = ("hbar", "bar", "donut", "table", "line", "area", "stacked_bar", "sparkline", "funnel", "entity",
             "case_list", "timeline", "mitre", "heatmap", "guide")
# Which leaf views a heading attracts, by its words. Specific headings claim their
# leaves first; the catch-all headings ("Findings", "Evidence") then take the rest.
_SECTION_VIEWS: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    (("indicator", "entit"), ("entity",)),
    (("reputation", "metric", "kpi", "figure", "decision"), ("kpi_group",)),
    (("metric", "kpi", "figure"), ("hbar", "bar", "donut")),
    (("trend",), ("line", "area", "bar", "stacked_bar", "sparkline")),
    (("noise", "funnel"), ("funnel",)),
    (("timeline", "history"), ("timeline",)),
    (("related case", "open work", "cases"), ("case_list",)),
    (("att&ck", "mitre", "technique"), ("mitre",)),
)
_CATCH_ALL_WORDS = ("sighting", "finding", "evidence", "detail")


def _report_steps(view: PromptView, ask: Ask) -> list[str]:
    """Next steps that follow from what the lookups found (never invented values)."""
    if ask.intent == "posture":
        return _posture_steps(view.ok("soc_metrics", "posture"), view.ok("soc_metrics", "noise_funnel"))
    if ask.intent == "case":
        got = view.ok("get_case")
        action = _dig(got.obs if got else {}, "case", "recommended_action")
        # The recommendation itself is case text: the narration quotes it; the report
        # step (a header leaf) only points at it.
        steps = ["Act on the recommendation recorded on the case." if isinstance(action, str) and action.strip()
                 else "",
                 "Confirm the recorded decision with the case owner.",
                 "Check other cases for the same entity before closing."]
        return [x for x in steps if x]
    if ask.intent in ("hunt", "pivot"):
        # The advice of the hunt's reading leads (the report's Summary carries only
        # the finding), so no step repeats the summary and none contradicts it.
        reading = _hunt_reading(view, _pivot_source(view, ask))
        logs = view.ok("search_logs")
        active = bool(logs and _num(logs.obs.get("total")))
        steps = [reading.advice or ("Review the matching events and the hosts they touch." if active
                                    else "Keep watching for the indicator; it is quiet in the logs.")]
        if reading.contain:
            steps.append("Block or monitor the indicator under your containment policy.")
        return steps + ["Re-run this hunt at the next shift."]
    return ["Verify the figures in the console before sharing.", "Re-run this report at the next handoff."]


def _log_figure(o: Mapping[str, Any], verb: str = "") -> str:
    """A log lookup's match count as a Summary clause, honest about its bound:
    "at least 4 log events matched it in the last 7d", "no log event matched it…"."""
    total = _num(o.get("total")) or 0
    verb = f" {verb}" if verb else ""
    if not total:
        return f"no log event{verb} {_in(_window(o))}"
    bound = "at least " if _log_total_is_lower_bound(o) else ""
    return f"{bound}{_plural(total, 'log event')}{verb} {_in(_window(o))}"


def _case_figure(o: Mapping[str, Any]) -> str:
    """The related-case count of a hunt as a Summary clause, honest about its bound."""
    count = _num(o.get("count")) or 0
    bound = bool(_case_lower_bound(o))
    if not count:
        scanned = o.get("scanned")
        if bound and scanned:
            return f"no case among the newest {_count(scanned)} scanned carries it as its entity"
        return f"no {'scanned ' if bound else ''}case carries it as its entity"
    verb, whose = ("carries", "its") if count == 1 else ("carry", "their")
    return f"{'at least ' if bound else ''}{_plural(count, 'case')} {verb} it as {whose} entity"


def _partial_sources(o: Mapping[str, Any]) -> str:
    """The Summary sentence for a log lookup only some sources answered, else ""."""
    ok, total = _sources_answered(o)
    if total and ok < total:
        return f"Only {ok} of {total} log sources answered, so the counts are partial."
    return ""


def _report_summary(final: Final, view: PromptView, ask: Ask) -> str:
    """The report's Summary leaf: numbers, enums and product wording only.

    The leaf is AI-provenance text inside the protocol header, so no value read from
    a log or a case (an entity, a title, an evidence summary) is copied into it; those
    stay in the narration, where they are shown as inline code. Per intent the
    summary is rebuilt from structured fields; otherwise it keeps the narration's
    opening paragraphs that carry no inline code and no recorded (untrusted) prose."""
    parts: list[str] = []
    if ask.intent == "case":
        got, decision = view.ok("get_case"), view.ok("explain_decision")
        case = _dig(got.obs, "case") if got else None
        if isinstance(case, Mapping) and case:
            parts.append(f"The case {_case_facts(case)}, and its status is "
                         f"{display_text(case.get('status'), 30).replace('_', ' ')}.")
        if decision:
            parts.append(_say_decision(decision))
    elif ask.intent in ("hunt", "pivot"):
        lookup, logs = view.ok("lookup_indicator"), view.ok("search_logs")
        related = view.ok("search_cases", where=lambda r: bool(_dig(r.obs, "filters", "entity")))
        if lookup and _num(lookup.obs.get("reputation_score")) is not None:
            parts.append(f"The indicator scores {_count(lookup.obs.get('reputation_score'))}/100 "
                         f"({display_text(lookup.obs.get('verdict'), 30) or 'unknown'}).")
        # Each figure once, honest about its bound, then what the figures mean
        # (engine wording only: no log or case value). The advice that goes with it
        # is the report's first Next step, never repeated here.
        figures = _join([f for f in (_log_figure(logs.obs, "matched it") if logs else "",
                                     _case_figure(related.obs) if related else "") if f])
        if figures:
            meaning = _hunt_reading(view, _pivot_source(view, ask)).meaning
            parts.append(f"{figures[:1].upper()}{figures[1:]}" + (f", {meaning}" if meaning else "") + ".")
        if logs:
            parts.append(_partial_sources(logs.obs))
    elif ask.intent in ("top", "regroup", "brute", "log_count", "logs"):
        result = view.ok("search_logs" if ask.intent == "logs" else "log_stats")
        if result:
            # An explicit search says it matched; a window's events (no value) just count.
            searched = ask.intent in ("logs", "log_count") and bool(ask.log_filter)
            figure = _log_figure(result.obs, "matched the search" if searched else "")
            parts.extend([f"{figure[:1].upper()}{figure[1:]}.", _partial_sources(result.obs)])
    if not parts:
        for paragraph in final.body[:4]:
            if ("`" in paragraph or paragraph.startswith(("- ", "Recorded", "From the Help"))
                    or paragraph.endswith(":") or paragraph in final.notes):
                continue
            parts.append(paragraph)
            if len(parts) == 2:
                break
    if ask.intent == "posture":
        post = view.ok("soc_metrics", "posture")
        caveat = _partial_completeness(post.obs) if post else ""
        if caveat and caveat not in parts:
            parts.append(caveat)
    # What the report lacks and why (a lookup the role cannot run, an @-scope left
    # out, a lookup this deployment switched off): engine words, never a value.
    gap, _advice = _missing_lead(view, ask) if ask.intent in _DATA_INTENTS else ("", "")
    if gap:
        parts.append(f"{gap}.")
    return " ".join(p for p in parts if p) or "The findings are in the sections below."


#: The closing sentence of an answer that carries a report envelope.
_REPORT_READY = "The report below is ready to add to your Reports."
#: ... and of one the analyst asked to create: the server saves it (SPEC D11) and the
#: line under the answer confirms it (or says why it could not).
_REPORT_SAVING = "The full report is below, and it is being saved to your Reports."
_BRIEF_READY = "The brief below is ready to add to a report."


def _is_narrative(paragraph: str) -> bool:
    """A prose paragraph: not a list item, a list heading or recorded case text."""
    return (bool(paragraph) and not paragraph.startswith(("- ", "Recorded")) and not paragraph.endswith(":")
            and not re.match(r"^\d+\. ", paragraph))


def _report_lead(final: Final, view: PromptView) -> list[str]:
    """The prose of an answer whose detail moved into a report envelope (browser-QA
    D5): the builder's ``lead`` (else the first narrative paragraph), at most two
    paragraphs, so with the closing sentence the answer is a 1–3 sentence lead.
    Disclosures follow it and never move into the report alone: the lookups whose
    figures are partial or a lower bound (:func:`_coverage_notes`, unless the lead
    already says so), then the builder's :attr:`Final.notes` (what is missing or
    failed)."""
    lead = [p for p in final.lead if p][:2]
    if not lead:
        lead = [p for p in final.body if _is_narrative(p)][:1]
    said = " ".join(lead + final.notes)
    return lead + _coverage_notes(view, said) + [n for n in final.notes if n]


def _as_report(final: Final, view: PromptView, ask: Ask, *, title: str, subtitle: str | None,
               summary: str, steps: Sequence[str] = ()) -> Final:
    """Wrap a final's blocks into a report envelope with the requested sections (the
    analyst's headings when the question lists them, else the template's). A blank
    ``subtitle`` is left out: the envelope validator rejects an empty one, and that
    would lose the whole envelope."""
    template = ask.report if ask.report in _REPORT_TEMPLATES else "custom"
    headings = list(ask.headings) or list(_TEMPLATE_HEADINGS.get(template, _TEMPLATE_HEADINGS["custom"]))
    leaves = [b for b in final.blocks if "ref" in b]
    plain_summary = _plain(summary.replace("**", ""), 1100)
    claimed: dict[str, list[dict[str, Any]]] = {h: [] for h in headings}
    placed: set[int] = set()
    for catch_all in (False, True):
        for heading in headings:
            low = heading.lower()
            if catch_all:
                if not any(w in low for w in _CATCH_ALL_WORDS):
                    continue
                views: set[str] = set(_ANY_LEAF)
            else:
                views = {v for words, wanted in _SECTION_VIEWS if any(w in low for w in words) for v in wanted}
            for index, leaf in enumerate(leaves):
                if index not in placed and (leaf.get("view") or "") in views:
                    claimed[heading].append(leaf)
                    placed.add(index)
    # The Summary carries the finding and what the report lacks (an access gap, a
    # partial count): with no Summary or Hypothesis heading (the IOC template, or the
    # analyst's own list) it leads the first section, so no disclosure is lost.
    home = next((h for h in headings if any(w in h.lower() for w in ("summary", "hypothesis"))),
                headings[0] if headings else None)
    sections: list[dict[str, Any]] = []
    for heading in headings:
        low = heading.lower()
        items = claimed[heading]
        if plain_summary and heading == home:
            items.insert(0, {"type": "markdown", "text": plain_summary})
        if any(w in low for w in ("next", "step", "recommend")):
            items.append({"type": "markdown", "text": "\n".join(
                f"{i}. {step}" for i, step in enumerate(steps or ["Re-run this report at the next handoff."], 1))})
        if items:
            sections.append({"heading": heading, "items": items})
    rest = [leaf for index, leaf in enumerate(leaves) if index not in placed]
    if rest:
        sections.append({"heading": "Details", "items": rest})
    envelope: dict[str, Any] = {"type": "report", "title": title, "template": template, "sections": sections[:12]}
    if subtitle and subtitle.strip():
        envelope["subtitle"] = subtitle.strip()[:200]
    final.blocks = [envelope]
    # The report holds the detail; the prose is its short lead (browser-QA D5). The
    # caller closes it with :data:`_REPORT_READY` after any notes.
    final.body = _report_lead(final, view)
    final.closing = _REPORT_READY
    return final


#: Case Manager turns are never added to reports (SPEC §1, #5; §4.6), so a report
#: request there gets the blocks unwrapped and this pointer instead of an envelope.
_CASE_REPORT_NOTE = ("Case conversations cannot be added to Reports. To build a report on this case, ask for it "
                     "in Workspace chat and add the result to your Reports there.")


def _unwrap_report(final: Final) -> Final:
    """A case-scoped final keeps the envelope's chart and list leaves as ordinary
    blocks, drops the envelope and its 'ready to add' sentence, and says where a
    report can be built instead."""
    leaves: list[dict[str, Any]] = []
    for block in final.blocks:
        if block.get("type") == "report":
            for section in block.get("sections") or []:
                leaves.extend(i for i in section.get("items") or [] if isinstance(i, dict) and "ref" in i)
        else:
            leaves.append(block)
    final.blocks = leaves[:12]
    final.closing = ""
    final.body.append(_CASE_REPORT_NOTE)
    return final


def _say_spend_buckets(o: Mapping[str, Any]) -> str:
    """"By month: the most was spent in Oct 2026 ($0.0027)." from ``spend_per_bucket``."""
    per = o.get("spend_per_bucket") if isinstance(o.get("spend_per_bucket"), Mapping) else {}
    labels = [display_text(b, 40) for b in per.get("buckets") or [] if isinstance(b, str)]
    values = [_num(v) for v in per.get("cost_usd") or []]
    if not labels or len(labels) != len(values) or not any(values):
        return ""
    peak = max(range(len(values)), key=lambda i: (values[i] or 0, i))
    unit = o.get("bucket") if isinstance(o.get("bucket"), str) else "period"
    return (f"By {unit}: the most was spent in {labels[peak]} ({_usd(values[peak])}); "
            f"{sum(1 for v in values if v)} of {_plural(len(values), unit)} had any spend.")


def _final_cost(view: PromptView, ask: Ask) -> Final | None:
    cost = view.ok("cost_usage")
    if cost is None:
        return None
    body = _say_cost(cost)
    buckets = _say_spend_buckets(cost.obs)
    if buckets:
        body.insert(1, buckets)
    comp = _comparison_of(cost.obs)
    if comp:
        body[1:1] = _say_comparison(comp, limit=4)
    return Final(body=body, blocks=_keep(
        _block_titled(cost, "comparison", view="kpi_group", title="Change versus the previous period"),
        _block(cost, "kpis", view="kpi_group", title="AI cost"),
        # cost_usage has no per-role time series, so §5.5's "stacked bar by role" is
        # spend over time (one series: plain bars) beside the by-role breakdown.
        _block(cost, "series", view="bar", title="AI spend over time"),
        _block(cost, "categories", view=_first_view(cost, "categories", ("donut", "hbar")), title="Spend by role"),
        _block(cost, "categories", nth=2, view="hbar", title="Spend by model"),
    ), follow_ups=_follow_ups(view, "cost", charts=True))


def _final_top(view: PromptView, ask: Ask, intent: str = "top") -> Final | None:
    stats = view.ok("log_stats")
    if stats is None:
        return None
    fld = (stats.obs.get("group_by") or [ask.field or "host"])[0]
    label = _FIELD_LABEL.get(fld, fld)
    window = _window(stats.obs)
    body = [_say_log_stats(stats)]
    comp = _comparison_of(stats.obs)
    if comp:
        body.extend(_say_comparison(comp, limit=2, with_note=False))
    tops = _comparison_of(stats.obs, "top_values")
    if tops:
        lines = _say_comparison(tops, limit=5, plain_labels=False)
        if lines:
            body.append(f"By {label}:")
            body.extend(f"- {line}" if not line.startswith("The latest") else line for line in lines)
    if intent == "regroup":
        body.insert(0, f"Re-ran the earlier lookup grouped by {label} (same filters).")
    # One block per figure set: the chart's view switcher already offers the table.
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title=f"Top {label}s ({window.split(' (')[0]})"),
        _block_titled(stats, "comparison", view="grouped_bar"),
    ), follow_ups=_follow_ups(view, intent, charts=True, field=fld))


def _log_subject(ask: Ask) -> str:
    """The searched value in words: "`zzqq`" for text, "host `web-01`" for a field."""
    return _filter_words(ask.log_filter)


def _log_follow_ups(view: PromptView, ask: Ask, total: float, field: str | None) -> list[str]:
    """A breakdown only when something matched; "the last 7 days" only for a shorter window."""
    skip = [] if total else ["by_user"]
    if ask.hours is not None and ask.hours >= 168:
        skip.append("week")
    return _follow_ups(view, ask.intent, charts=True, field=field, skip=skip)


def _final_logs(view: PromptView, ask: Ask) -> Final | None:
    """An explicit log search (``search_logs``): what matched, and the matching rows."""
    logs = view.ok("search_logs")
    if logs is None:
        return None
    total = _num(logs.obs.get("total")) or 0
    body = [_say_search_logs(logs, subject=_log_subject(ask) or None)]
    named = next((key for key, _value in ask.log_filter if key in ("user", "host")), None)
    title = "Matching log events" if ask.log_filter else "Log events"
    return Final(body=body, blocks=_keep(
        _block(logs, "table", view="table", title=title) if total else None,
    ), follow_ups=_log_follow_ups(view, ask, total, named))


def _final_log_count(view: PromptView, ask: Ask) -> Final | None:
    """A log count (``log_stats``) for a searched value, broken down by one field."""
    stats = view.ok("log_stats")
    if stats is None:
        return None
    total = _num(stats.obs.get("total")) or 0
    fld = (stats.obs.get("group_by") or [ask.field or "host"])[0]
    subject = _log_subject(ask)
    body = [_say_log_stats(stats, subject=f"matching {subject}" if subject else "") if total
            else _no_log_events(stats.obs, subject)]
    label = _FIELD_LABEL.get(fld, fld)
    title = f"{'Matching events' if ask.log_filter else 'Events'} by {label} ({_window(stats.obs)})"
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title=title) if total else None,
    ), follow_ups=_log_follow_ups(view, ask, total, fld))


def _final_brute(view: PromptView, ask: Ask) -> Final | None:
    stats, cases = view.ok("log_stats"), view.ok("search_cases")
    if stats is None and cases is None:
        return None
    body = []
    if cases:
        body.append(_say_search_cases(cases, noun="brute-force case"))
        body.extend(_case_bullets(cases))
    if stats:
        top = [t for t in _dig(stats.obs, "top", "ip") or [] if isinstance(t, Mapping)]
        # A text filter, not a parsed outcome field: say what was matched, not "failed sign-ins".
        body.append("Log events matching the text filter `fail`: " + _say_log_stats(stats, subject=""))
        peak = _num(top[0].get("count")) if top else None
        if peak is not None and peak <= 3:
            body.append("No single source IP dominates, so the logs do not show an active brute force right "
                        "now; the cases above hold the confirmed activity.")
        elif peak is not None:
            body.append(f"{_code(top[0].get('value'))} stands out; hunt it to check its reputation and "
                        "related cases.")
    return Final(body=body, blocks=_keep(
        _block(stats, "categories", view="hbar", title="Events matching 'fail' by source IP"),
        _block(cases, "case_list", view="case_list", title="Brute-force cases"),
    ), follow_ups=_follow_ups(view, "brute", charts=True, field="ip"))


def _final_tp(view: PromptView, ask: Ask) -> Final | None:
    tps, mix = view.ok("search_cases"), view.ok("soc_metrics", "case_mix")
    if tps is None and mix is None:
        return None
    body = []
    if tps:
        body.append(_say_search_cases(tps, noun="true positive"))
        body.extend(_case_bullets(tps))
    if mix:
        body.append("For context, " + _say_case_mix(mix))
    return Final(body=body, blocks=_keep(
        _block(tps, "kpis", view="kpi_group", title="True positives"),
        _block(mix, "categories", view=_first_view(mix, "categories", ("donut", "hbar")), title="Cases by verdict"),
        _block(tps, "case_list", view="case_list", title="True-positive cases"),
    ), follow_ups=_follow_ups(view, "tp", charts=True))


def _final_case(view: PromptView, ask: Ask) -> Final | None:
    missing = _case_missing(view, ask)
    if missing is not None:
        return missing
    got = view.ok("get_case")
    decision = view.ok("explain_decision")
    search = view.ok("search_cases")
    status_word = (ask.case_status or "matching").replace("_", " ")
    if got is None and decision is None:
        if search is not None and not _num(search.obs.get("count")):
            return Final(body=[f"No {status_word} case was found, so there is nothing to investigate "
                               f"({_say_search_cases(search).rstrip('.')})."],
                         follow_ups=_follow_ups(view, "case"))
        return None
    case = _dig(got.obs, "case") if got else None
    case = case if isinstance(case, Mapping) else {}
    body: list[str] = []
    if case:
        # The id is the handle; what happened to which entity names the case (D6).
        name = _case_name(case)
        lead = f"**{_code(case.get('case_id'), 60)}**" + (f" ({name})" if name else "")
        if search is not None and not ask.case_id:
            lead += f", the newest of {_plural(search.obs.get('count'), f'{status_word} case')},"
        lead += (f" {_case_facts(case)}, and its status is "
                 f"**{display_text(case.get('status'), 30).replace('_', ' ')}**.")
        body.append(lead)
    if decision:
        sentence = _say_decision(decision)
        if sentence:
            open_now = str(case.get("status") or "") in ("new", "investigating", "escalated", "on_hold")
            prefix = "Why it is still open: " if open_now else "How the policy sees it: "
            body.append(prefix + sentence[:1].lower() + sentence[1:])
    if got:
        body.extend(_say_get_case(got, lead=not case))
    stats = view.ok("log_stats")
    if stats:
        entity = _entity_of(got.obs) if got else None
        subject = f"for {_code(entity[1])}" if entity else ""
        body.append("In the logs: " + _say_log_stats(stats, subject=subject))
    action = _plain(_dig(case, "recommended_action"), 200)
    if action:
        body.append(f"Recorded recommendation: {action}")
    # As a report: the case in one sentence and its recorded recommendation (case
    # text, which the report's own leaves never carry); the decision is in the report.
    lead = body[:1] + ([f"Recorded recommendation: {action}"] if action else [])
    return Final(body=body, blocks=_keep(
        _block(got, "entity", view="entity", title="Case entity"),
        _block(got, "timeline", view="timeline", title="Status history"),
        _block(decision, "kpis", view="kpi_group", title="Decision inputs"),
        _block(stats, "categories", view="hbar", title="Entity activity in the logs"),
        _block(got, "mitre", view="mitre", title="ATT&CK techniques"),
    ), follow_ups=_follow_ups(view, "case", charts=bool(stats)), lead=lead)


def _indicator_body(view: PromptView, value: str | None) -> tuple[list[str], list[dict[str, Any]], set[int]]:
    """``(body, blocks, narrated failure ordinals)`` of an indicator hunt."""
    lookup = view.ok("lookup_indicator")
    logs = view.ok("search_logs")
    related = view.ok("search_cases", where=lambda r: bool(_dig(r.obs, "filters", "entity")))
    body: list[str] = []
    narrated: set[int] = set()
    if lookup:
        body.append(_say_lookup(lookup))
    else:
        refused = next((r for r in view.results() if r.tool == "lookup_indicator" and not r.ok), None)
        if refused is not None:
            narrated.add(refused.ordinal)
            reason = display_text(refused.summary, 160) or refused.status
            text = f"Reputation was not looked up ({reason})."
            if REFUSED_TAINT in refused.summary:
                # Only the taint refusal is about where the value came from; a private
                # address or an unknown kind was typed by the user and refused for that.
                text += (" Indicator lookups run only for a value you typed yourself or one a lookup found as "
                         "evidence for this question.")
            body.append(text)
    if logs:
        body.append(_say_search_logs(logs, subject=_code(value) if value else None))
    if related:
        count = _num(related.obs.get("count")) or 0
        bound, scanned = _case_lower_bound(related.obs), related.obs.get("scanned")
        if count:
            body.append(f"Cases with it as their entity: **{_count(count)}**" + (f" ({bound})." if bound else "."))
        elif bound:
            # Only the newest cases were scanned: "none found" covers those alone.
            among = f" among the newest {_count(scanned)} scanned" if scanned else " among those scanned"
            body.append(f"No case{among} has it as its entity.")
        else:
            body.append("No case has it as its entity.")
        body.extend(_case_bullets(related))
    # The entity card already shows the reputation gauge and the providers that
    # answered, so the lookup's "Reputation figures" KPI row is not shown beside it
    # (one figure shown once, browser-QA D4); it stands in only without the card.
    card = _block(lookup, "entity", view="entity", title="Indicator reputation")
    blocks = _keep(
        card,
        None if card else _block(lookup, "kpis", view="kpi_group", title="Reputation figures"),
        _block(logs, "table", view="table", title="Matching log events") if logs and _num(logs.obs.get("total")) else None,
        _block(related, "case_list", view="case_list", title="Related cases")
        if related and _num(related.obs.get("count")) else None,
    )
    return body, blocks, narrated


def _final_hunt(view: PromptView, ask: Ask) -> Final | None:
    value = ask.indicator[0] if ask.indicator else None
    body, blocks, narrated = _indicator_body(view, value)
    if not body:
        return None
    reading = _hunt_reading(view)
    if reading.text:
        body.append(reading.text)
    # As a report: the reputation result and what the sightings mean. The advice is
    # the report's first Next step, so the lead keeps the finding alone.
    lead = body[:1] + ([reading.finding] if reading.finding else [])
    return Final(body=body, blocks=blocks, follow_ups=_follow_ups(view, "hunt"), narrated=narrated, lead=lead)


_ENTITY_WORDS = {"ip": "source IP", "domain": "domain", "file_hash": "file hash", "hash": "file hash",
                 "url": "URL", "user": "user", "host": "host"}


def _is_false_positive(case: Any) -> bool:
    return isinstance(case, Mapping) and str(case.get("verdict") or "").upper() == "FALSE_POSITIVE"


@dataclass(frozen=True)
class _HuntReading:
    """What a hunt's sightings mean (engine wording, no new number).

    ``text`` is the plain answer's sentence (finding and advice). A report splits it:
    ``finding`` leads the prose (count-free, so it never restates the report's
    figures), ``meaning`` completes the Summary's figures sentence ("…, so they read
    as one incident": interpretation only, the figures precede it) and ``advice`` is
    the first Next step, so none repeats another. ``contain`` says whether the
    generic "block or monitor" step still applies (not after a false-positive,
    clean-reputation or no-signal finding, nor when the advice already says it)."""
    text: str = ""
    finding: str = ""
    meaning: str = ""
    advice: str = ""
    contain: bool = True


def _pivot_source(view: PromptView, ask: Ask) -> Mapping[str, Any] | None:
    """The case a pivot hunt started from, when it carries an entity to hunt."""
    got = view.ok("get_case") if ask.intent == "pivot" else None
    case = _dig(got.obs, "case") if got else None
    return case if isinstance(case, Mapping) and _entity_of(got.obs) else None


#: Reputation verdicts that call for no action beyond watching.
_CLEAN_VERDICTS = frozenset({"clean", "benign"})


def _hunt_reading(view: PromptView, source_case: Mapping[str, Any] | None = None) -> _HuntReading:
    """What the sightings mean (no number is new, and none is repeated).

    Zero, one and several related cases are three different findings: an indicator
    no case carries has no containment to keep (the reputation result is the only
    signal, and a clean one needs no action), and a case closed as a false positive
    needs no containment at all. ``source_case`` is the case a pivot hunt started
    from (it carries the entity)."""
    logs = view.ok("search_logs")
    related = view.ok("search_cases", where=lambda r: bool(_dig(r.obs, "filters", "entity")))
    if logs is None or related is None:
        return _HuntReading()
    sightings = _num(logs.obs.get("total")) or 0
    cases = _num(related.obs.get("count")) or 0
    linked = [c for c in related.obs.get("cases") or [] if isinstance(c, Mapping)]
    from_source = bool(source_case) and not any(c.get("case_id") == source_case.get("case_id") for c in linked)
    if source_case and from_source:
        linked.append(source_case)
    all_fp = bool(linked) and all(_is_false_positive(c) for c in linked)
    reputation = view.ok("lookup_indicator")
    if sightings:
        alongside = ", alongside the related cases" if cases else ""
        return _HuntReading(
            text=("It is still active in the logs: review the matching events and check the hosts they touch"
                  + (", and read them alongside the related cases" if cases else "") + "."),
            finding="It is still active in the logs" + (", and cases already carry it" if cases else "") + ".",
            meaning="so it is still active",
            advice=f"Review the matching events and check the hosts they touch{alongside}.")
    if not cases and source_case is None:
        if reputation is None:
            text = ("Nothing in the logs or the case store links it to activity here, and no reputation was "
                    "read, so this hunt found no signal for it; there is no case containment to keep.")
            return _HuntReading(text=text, finding=text, contain=False,
                                meaning="so this hunt found no signal for it and there is no case "
                                        "containment to keep")
        finding = ("Nothing in the logs or the case store links it to activity here, so the reputation result "
                   "above is the only signal; there is no case containment to keep.")
        meaning = "so the reputation result is the only signal and there is no case containment to keep"
        verdict = display_text(reputation.obs.get("verdict"), 30).lower()
        if verdict in _CLEAN_VERDICTS:
            advice = f"No action is needed beyond watching for it; its reputation is {verdict}."
        else:
            advice = "Block or monitor it under your policy if its reputation warrants it."
        return _HuntReading(text=f"{finding} {advice}", finding=finding, meaning=meaning, advice=advice,
                            contain=False)
    if all_fp:
        if len(linked) == 1:
            which = "its only case has" if not from_source else "the case it came from has"
            why = "that case has" if not from_source else "the case this hunt started from has"
        else:
            which = why = "every case carrying it has"
        finding = f"It is quiet in the logs and {which} a false-positive verdict, so no containment is needed"
        return _HuntReading(text=f"{finding}; watch for a return.", finding=f"{finding}.",
                            meaning=f"so no containment is needed: {why} a false-positive verdict",
                            advice="Watch for a return of the indicator.", contain=False)
    if cases <= 1:
        finding = "It is quiet in the logs and tied to a single case, so the activity looks contained"
        return _HuntReading(text=f"{finding}; keep the case's containment in place and watch for a return.",
                            finding=f"{finding}.", meaning="so the activity looks contained",
                            advice="Keep the case's containment in place and watch for a return.")
    return _HuntReading(
        text=("It is quiet in the logs but tied to several cases, so treat them as one incident and check each "
              "one's containment."),
        finding="It is quiet in the logs but tied to several cases, so they read as one incident.",
        meaning="so they read as one incident",
        advice="Treat the cases as one incident and check each one's containment.")


_NAME_AN_INDICATOR = "Name an indicator (an IP, domain, URL or hash) to hunt it directly."


def _final_pivot(view: PromptView, ask: Ask) -> Final | None:
    search = view.ok("search_cases", where=lambda r: not _dig(r.obs, "filters", "entity"))
    got = view.ok("get_case")
    if search is None and got is None:
        return None
    name = ask.topic or "matching"
    if search is not None and not _num(search.obs.get("count")):
        return Final(body=[f"No {name} case was found to pivot from ({_say_search_cases(search).rstrip('.')})."],
                     follow_ups=_follow_ups(view, "pivot"))
    body: list[str] = []
    entity = _entity_of(got.obs) if got else None
    case = got.obs.get("case") if got and isinstance(got.obs.get("case"), Mapping) else None
    if got and entity:
        source = case or {}
        if ask.keyword:
            # search_cases ran with the keyword sorted by creation time (newest first).
            anchor = f"Pivoted from the newest {name} case"
        else:
            # No indicator and no known attack type in the question: the plan anchors on
            # the riskiest open case that carries an indicator entity, and says so.
            anchor = ("The question names no indicator or known attack type, so this hunt is anchored on the "
                      "highest-risk open case with an indicator entity,")
        name = _case_name(source, with_entity=False)
        body.append(f"{anchor} {_code(source.get('case_id'), 60)}" + (f" ({name})" if name else "")
                    + f", which {_case_facts(source)}; its {_ENTITY_WORDS.get(entity[0], entity[0])} is "
                    f"**{_code(entity[1])}**.")
        if not ask.keyword:
            body.append(_NAME_AN_INDICATOR)
    elif got:
        body.extend(_say_get_case(got))
        body.append("That case has no IP, domain or hash entity to hunt.")
    indicator_lines, blocks, narrated = _indicator_body(view, entity[1] if entity else None)
    body.extend(indicator_lines)
    reading = _hunt_reading(view, case if entity else None)
    if reading.text:
        body.append(reading.text)
    if got:
        mitre = [m for m in got.obs.get("mitre") or [] if isinstance(m, Mapping) and m.get("id")]
        if mitre:
            body.append("The source case maps to ATT&CK " + _join([
                f"{display_text(m.get('id'), 12)} {display_text(m.get('name'), 60)}" for m in mitre[:3]]) + ".")
        blocks += _keep(_block(got, "mitre", view="mitre", title="ATT&CK techniques"))
    if not indicator_lines and got and entity:
        body.append("The follow-up lookups did not run.")
    # As a report: where the hunt started (and, when the question named no
    # indicator, how to aim it), then its headline finding — the first indicator
    # line (the reputation, or why it was not looked up, which is narrated and so
    # never listed again) with what the sightings mean. The sightings, the cases and
    # the advice (the first Next step) are in the report.
    start = " ".join(p for p in (body[:1] + [_NAME_AN_INDICATOR if _NAME_AN_INDICATOR in body else ""]) if p)
    found = " ".join(p for p in (indicator_lines[:1] + [reading.finding]) if p)
    lead = [p for p in (start, found or ("The follow-up lookups did not run." if got and entity else "")) if p]
    return Final(body=body, blocks=blocks, follow_ups=_follow_ups(view, "pivot"), narrated=narrated, lead=lead)


def _final_mitre(view: PromptView, ask: Ask) -> Final | None:
    lookup = view.ok("mitre_lookup")
    coverage = view.ok("soc_metrics", "mitre_coverage")
    if lookup is None:
        return None
    body = _say_mitre(lookup)
    if coverage:
        seen = {display_text(t.get("id"), 12): t for t in coverage.obs.get("top_techniques") or []
                if isinstance(t, Mapping)}
        for tech in [t for t in lookup.obs.get("techniques") or [] if isinstance(t, Mapping)][:3]:
            tid = display_text(tech.get("id"), 12)
            if tid in seen:
                body.append(f"{tid} appears in {_plural(seen[tid].get('cases'), 'case')} in the case store.")
            elif seen:
                body.append(f"{tid} is not among the most-seen techniques in your cases.")
    return Final(body=body, blocks=_keep(
        _block(lookup, "mitre", view="mitre", title="ATT&CK techniques"),
        _block(coverage, "kpis", view="kpi_group", title="ATT&CK coverage"),
    ), follow_ups=_follow_ups(view, "mitre"))


def _final_sources(view: PromptView, ask: Ask) -> Final | None:
    health = view.ok("source_health")
    if health is None:
        return None
    return Final(body=_say_sources(health), blocks=_keep(
        _block(health, "kpis", view="kpi_group", title="Ingest coverage"),
        _block(health, "table", view="table", title="Sources"),
    ), follow_ups=_follow_ups(view, "sources"))


def _final_campaigns(view: PromptView, ask: Ask) -> Final | None:
    camps = view.ok("list_campaigns")
    if camps is None:
        return None
    # The table lists each campaign with its case count, and the prose states the
    # total: the lookup's "Campaign figures" row would only repeat them.
    return Final(body=[_say_campaigns(camps)], blocks=_keep(
        _block(camps, "table", view="table", title="Campaigns"),
    ), follow_ups=_follow_ups(view, "campaigns"))


def _final_cases(view: PromptView, ask: Ask) -> Final | None:
    cases = view.ok("search_cases")
    if cases is None:
        return None
    mix = view.ok("soc_metrics", "case_mix")
    body = [_say_search_cases(cases), *_case_bullets(cases)]
    if mix:
        body.append("Across the window: " + _say_case_mix(mix))
    return Final(body=body, blocks=_keep(
        _block(cases, "kpis", view="kpi_group", title="Key figures"),
        _block(cases, "case_list", view="case_list", title="Matching cases"),
        _block(mix, "categories", view=_first_view(mix, "categories", ("donut", "hbar")), title="Cases by verdict"),
    ), follow_ups=_follow_ups(view, "cases", charts=bool(mix)))


def _final_help(view: PromptView, ask: Ask, intent: str = "help") -> Final | None:
    ref = view.reference
    help_result = view.ok("app_help")
    status = view.ok("app_status")
    if help_result is None and status is None:
        return None
    body: list[str] = []
    allowed = [t for t in ref.targets if t.allowed]
    paragraphs, cited = _help_paragraphs(ref, limit=3, topic=ask.topic)
    if ask.definition:
        # "What does X count / control?": the definition IS the direct answer, so the
        # Help Center leads and the console page follows as where to see it.
        if paragraphs:
            body.append("From the Help Center:")
            body.extend(paragraphs)
        elif help_result is not None:
            body.append("The Help Center has no section that defines this directly.")
        if allowed and help_result is not None:
            body.append("See it in the console: " + _join([f"**{display_text(t.label, 100)}**"
                                                          for t in allowed[:2]], "or") + ".")
    else:
        if allowed and help_result is not None:
            # Lead with the direct answer: where in the console the thing is done.
            body.append("Start in " + _join([f"**{display_text(t.label, 100)}**" for t in allowed[:2]], "or")
                        + "; the Help Center explains the steps.")
        if paragraphs:
            body.append("From the Help Center:")
            body.extend(paragraphs)
        elif help_result is not None:
            body.append("The Help Center has no section that answers this directly.")
    locked = _console_sentence(Reference(targets=[t for t in ref.targets if not t.allowed]))
    if locked:
        body.append(locked)
    if status is not None:
        usable = [t for t in (ref.facts.get("chat_lookups_you_can_use") or "").split(", ") if t]
        locked_tools = _locked_lookups(ref.facts.get("chat_lookups_locked") or "")
        if usable:
            body.append(f"With your access you can use **{_plural(len(usable), 'chat lookup')}**"
                        + (f"; locked: {_join(locked_tools)}." if locked_tools else ", none locked.")
                        + " Chat is read-only: it searches and explains, and never changes anything.")
        version = re.search(r"version=([0-9][0-9A-Za-z.+-]{0,30})", ref.facts.get("product", ""))
        if version:
            demo = "on" if "demo_mode=yes" in ref.facts.get("mode", "") else "off"
            body.append(f"This deployment runs version {version.group(1)} with Demo Mode {demo}.")
    return Final(body=body or ["No product reference was available."], blocks=_keep(
        _block(help_result, "guide", view="guide", title="Help Center"),
        _block(status, "kpis", view="kpi_group", title="Your access" if ask.wants_access else "Deployment"),
    ), citations=cited, console_links=_console_ids(ref), answer_kind="product_help",
        follow_ups=_follow_ups(view, intent, skip=("access",) if ask.wants_access else ()))


def _locked_lookups(fact: str, limit: int = 4) -> list[str]:
    """The ``chat_lookups_locked`` fact ("tool=grant; tool=grant") as display names
    with their grants, whole entries only (never cut inside a name)."""
    entries: list[str] = []
    for part in fact.split("; "):
        tool, _, grant = part.strip().partition("=")
        tool = tool.strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", tool):
            continue
        name = _TOOL_NAMES.get(tool, tool.replace("_", " "))
        grant = display_text(grant, 60).strip()
        entries.append(f"{name} (needs {grant})" if grant else name)
    if len(entries) > limit:
        entries = entries[:limit] + [f"{len(entries) - limit} more"]
    return entries


def _final_explain_metric(view: PromptView, ask: Ask) -> Final | None:
    metric = view.ok("cost_usage") if ask.metric == "cost" else view.ok("soc_metrics", ask.metric)
    if view.ok("app_help") is None and metric is None:
        return None
    body: list[str] = []
    paragraphs, cited = _help_paragraphs(view.reference, topic=ask.topic)
    if paragraphs:
        verb = "measure" if " and " in ask.topic or ask.topic.endswith("rates") else "measures"
        body.append(f"**What the {ask.topic} {verb}**, from the Help Center:")
        body.extend(paragraphs)
    if metric is not None:
        sentences = _say_cost(metric) if metric.tool == "cost_usage" else _say_soc_metrics(metric)
        body.append(f"**Ours:** {sentences[0]}")
        body.extend(sentences[1:3])
    blocks = []
    if metric is not None:
        for kind in ("funnel", "kpis", "series", "categories"):
            entry = _block(metric, kind)
            if entry:
                blocks.append(entry)
            if len(blocks) >= 2:
                break
    blocks += _keep(_block(view.ok("app_help"), "guide", view="guide", title="Help Center"))
    return Final(body=body, blocks=blocks, citations=cited, console_links=_console_ids(view.reference),
                 answer_kind="mixed" if metric is not None and paragraphs else ("data" if metric else "product_help"),
                 follow_ups=_follow_ups(view, "explain_metric", charts=metric is not None))


def _final_change(view: PromptView, ask: Ask) -> Final:
    body = ["I can't change that from chat: the assistant is read-only, so it can search and explain but "
            "never close, edit, assign or configure anything."]
    paragraphs, cited = _help_paragraphs(view.reference, limit=1, topic=_change_query(ask))
    console = _console_sentence(view.reference).replace("Open it in the console:", "Do it in the console:")
    if console:
        body.append(console)
    if paragraphs:
        body.append("From the Help Center:")
        body.extend(paragraphs)
    return Final(body=body, blocks=_keep(_block(view.ok("app_help"), "guide", view="guide", title="Help Center")),
                 citations=cited, console_links=_console_ids(view.reference), answer_kind="product_help",
                 follow_ups=_follow_ups(view, "change"))


def _final_unsupported(view: PromptView, ask: Ask) -> Final:
    body = ["Chat cannot read that data: it has no lookup for users, roles, sessions, jobs, notifications, "
            "dashboards or secrets, so I won't guess."]
    console = _console_sentence(view.reference)
    if console:
        body.append(console)
    paragraphs, cited = _help_paragraphs(view.reference, limit=1, topic=ask.question)
    if paragraphs:
        body.append("From the Help Center:")
        body.extend(paragraphs)
    return Final(body=body, citations=cited, console_links=_console_ids(view.reference),
                 answer_kind="product_help", unsupported=True, follow_ups=_follow_ups(view, "unsupported"))


def _final_remember(view: PromptView, ask: Ask) -> Final:
    fact = ask.memory or ""
    return Final(body=["I can't save memory myself. Confirm the proposal below to add this fact to operator "
                       f"memory: “{_plain(fact, 300)}”."],
                 answer_kind="conversation", memory_proposal={"op": "add", "text": fact},
                 follow_ups=_follow_ups(view, "remember"))


def _final_reshape(view: PromptView, ask: Ask) -> Final:
    wanted = ask.view or "table"
    candidates = [b for b in reversed(view.prior_blocks) if wanted in b.views]
    # The same subject-word test the classifier used to call this a view change.
    words = _content_words(ask.lowered)
    titled = [b for b in candidates if words & _content_words(b.title)]
    chosen = (titled or candidates or [None])[0]
    label = _VIEW_LABEL.get(wanted, wanted)
    if chosen is None:
        charts = [b for b in view.prior_blocks if b.view != "table"]
        latest = (charts or view.prior_blocks or [None])[-1]
        hint = (f" The latest one, {_code(latest.title, 80)}, can be shown as "
                f"{_join([_VIEW_LABEL.get(v, v) for v in latest.views], 'or')}.") if latest else ""
        return Final(body=[f"None of the earlier charts can be shown as a {label}.{hint}"],
                     answer_kind="conversation", follow_ups=_follow_ups(view, "reshape"))
    return Final(body=[f"Here is {_code(chosen.title, 80)} from the earlier answer as a {label}. No new lookup "
                       "was needed: the numbers are the stored ones."],
                 blocks=[{"ref": chosen.ref, "view": wanted}], answer_kind="data",
                 follow_ups=_follow_ups(view, "reshape"))


def _final_regroup(view: PromptView, ask: Ask) -> Final | None:
    """A regroup re-ran the earlier log lookup; without one there is nothing to
    regroup, and the answer says what the earlier figures came from instead."""
    if view.ok("log_stats") is not None:
        return _final_top(view, ask, "regroup")
    if any(c.tool in ("log_stats", "search_logs") for c in view.prior_calls):
        return None  # the log lookup was planned but did not run: the generic final explains
    label = _FIELD_LABEL.get(ask.field or "", ask.field or "that field")
    latest = view.prior_calls[-1].key if view.prior_calls else None
    sources = list(dict.fromkeys(_TOOL_NAMES.get(c.tool, c.tool) for c in view.prior_calls if c.key == latest))
    origin = f" (its figures came from {_join(sources)})" if sources else ""
    plural = f"{label}s"
    return Final(body=[f"The earlier answer did not come from a log lookup{origin}, so it cannot be regrouped by "
                       f"{label}. To count log events by {label}, ask for a fresh lookup, for example: which "
                       f"{plural} generated the most events in the last 24 hours?"],
                 answer_kind="conversation", follow_ups=_follow_ups(view, "regroup"))


def _final_rerun(view: PromptView, ask: Ask) -> Final | None:
    results = [r for r in view.results() if r.ok and r.observation is not None]
    if not results:
        return None
    body = [f"Re-ran the earlier lookups for the last {_plural(ask.hours, 'hour')}:" if ask.hours and ask.hours < 48
            else f"Re-ran the earlier lookups for the last {_plural((ask.hours or 24) // 24, 'day')}:"]
    for r in results:
        body.extend(_say_result(r)[:3])
    return Final(body=body, blocks=_default_blocks(results), follow_ups=_follow_ups(view, "rerun", charts=True))


def _default_blocks(results: Sequence[Result], limit: int = 8) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for r in results:
        for entry in r.artifacts:
            if len(blocks) >= limit:
                return blocks
            if entry.kind in ("query",):
                continue
            blocks.append({"ref": entry.ref, "view": entry.views[0]} if entry.views else {"ref": entry.ref})
    return blocks


def _final_legacy(view: PromptView, ask: Ask) -> Final:
    """A legacy ``needs_query`` result (only reachable after a scripted legacy reply):
    the aggregate has no header manifest, so the answer is prose and the engine shows
    the turn's artifacts in their default views."""
    agg = view.legacy or {}
    rows = _num(agg.get("returned_rows")) or 0
    body = [f"The log search returned **{_plural(rows, 'event')}**."]
    for key, name in (("top_source_ips", "source IPs"), ("top_hosts", "hosts"), ("top_users", "users"),
                      ("top_rules", "rules")):
        values = [v for v in agg.get(key) or [] if isinstance(v, Mapping)][:3]
        if values:
            body.append(f"Top {name}: " + _join([f"{_code(v.get('value'))} ({_count(v.get('count'))})"
                                                 for v in values]) + ".")
    if view.legacy_note:
        body.append("The requested time window was limited to the range you selected, so events outside it "
                    "are not counted.")
    return Final(body=body)


def _final_empty(view: PromptView, ask: Ask) -> Final:
    return Final(body=["Ask about your security data (cases, logs, metrics, threat intel, platform health) or "
                       "about how this console works. Chat is read-only."],
                 answer_kind="conversation", follow_ups=_follow_ups(view, "empty"))


def _final_no_tools(view: PromptView, ask: Ask) -> Final:
    return Final(body=["No lookups are available in this conversation, so I can't read any data to answer "
                       "this. Chat can still explain the console: open the Help Center from the console menu, "
                       "or ask an administrator for the permissions your question needs."],
                 answer_kind="product_help", unsupported=ask.intent in _DATA_INTENTS)


def _final_generic(view: PromptView, ask: Ask) -> Final:
    """Whatever ran, narrated per tool; used when an intent's own data is missing
    (restricted role, failures, an unrun round after the deadline) and as the
    orientation answer for the fallback intent."""
    data = [r for r in view.results() if r.ok and r.tool not in _REFERENCE_TOOLS and r.observation is not None]
    body: list[str] = []
    lead, advice = _missing_lead(view, ask) if ask.intent in _DATA_INTENTS else ("", "")
    locked, _scoped = _missing_split(view, ask) if lead else ([], [])
    if ask.intent == "fallback" and data:
        body.append("I could not map that to one specific lookup, so here is where things stand:")
    elif lead and data:
        # The direct answer to "why is this not the answer I asked for".
        reads = "what you can read" if locked else "what those scopes cover"
        body.append(f"{lead}, so this answer uses {reads}:")
    elif lead:
        # Nothing data-bearing ran: the missing access IS the answer, so it leads.
        body.append(f"{lead}, so no data backs this answer. {advice}".strip())
        advice = ""
    elif data:
        body.append("Here is what I could read for this question:")
    narration: list[str] = []
    for r in data:
        narration.extend(_say_result(r)[:4])
    body.extend(narration)
    # In a degraded answer only excerpts that match the question's topic are worth
    # showing; an unrelated top hit would read as an answer it is not.
    degraded = ask.intent != "fallback"
    paragraphs, cited = _help_paragraphs(view.reference, topic=(ask.topic or ask.question) if degraded else "",
                                         require_match=degraded)
    if paragraphs:
        body.append("From the Help Center:")
        body.extend(paragraphs)
    console = _console_sentence(view.reference)
    if console:
        body.append(console)
    if advice:
        body.append(advice)
    failures = _failure_lines(view)
    if failures:
        body.append("Lookups that did not complete:")
        body.extend(failures)
    if not body:
        body.append("I could not read any data for this question.")
    if data and paragraphs:
        kind = "mixed"
    elif data:
        kind = "data"
    else:
        kind = "product_help"
    # SPEC D9: "unsupported" only when this role can read no data at all (no data
    # lookup is granted). A lookup that failed, or a case that does not exist, is a
    # data answer with a note, never "chat cannot read that data".
    data_granted = [t for t in view.granted if t not in _REFERENCE_TOOLS and t != "recall_observation"]
    unsupported = not data and ask.intent in _DATA_INTENTS and not data_granted
    # Wrapped into a report envelope (a report request), the prose is a lead — what
    # the answer lacks and why, then the first finding — and these notes still follow
    # it: the report holds the data, never the disclosures (browser-QA D5).
    first = next((p for p in narration if _is_narrative(p)), "")
    opening = ""
    if lead and data:
        opening = body[0] if first else f"{lead}."
    notes = [console, advice, *(["Lookups that did not complete:", *failures] if failures else [])]
    return Final(body=body, blocks=_default_blocks(data), citations=cited,
                 console_links=_console_ids(view.reference), answer_kind=kind, unsupported=unsupported,
                 follow_ups=_follow_ups(view, ask.intent, charts=bool(data)),
                 lead=[p for p in (opening, first) if p], notes=[n for n in notes if n])


# --------------------------------------------------------------------------- #
# Round 12 finals: exact case counts and breakdowns, trends, period comparisons,
# performance reports, investigation briefs, in-depth investigations and clarify.
# Numbers come only from the fenced observations; header text leaves (report
# summaries, callouts, steps) are built from numbers, enums and engine labels.
# --------------------------------------------------------------------------- #
def _value_text(value: Any, unit: Any) -> str:
    """One measured value in its unit ("76.6%", "12 min", "$0.0027", "1,284")."""
    if _num(value) is None:
        return "not measured"
    if unit == "percent":
        return _pct(value)
    if unit == "minutes":
        return _minutes(value)
    if unit == "usd":
        return _usd(value)
    if unit == "score":
        return _dec(value)
    return _count(value)


def _change_text(row: Mapping[str, Any]) -> str:
    """A row's code-computed change: "+15, +50%", "+16.6 points", "new", "no change"."""
    if row.get("new"):
        return "new"
    change = _num(row.get("change"))
    if change is None:
        return "no comparison"
    if change == 0:
        return "no change"
    sign = "+" if change > 0 else "−"
    unit = row.get("unit")
    if unit == "percent":
        return f"{sign}{_dec(abs(change))} points"
    if unit == "minutes":
        return f"{sign}{_minutes(abs(change))}"
    if unit == "usd":
        return f"{sign}{_usd(abs(change))}"
    text = f"{sign}{_count(abs(change))}"
    pct = _num(row.get("change_pct"))
    return text + (f", {sign}{_dec(abs(pct))}%" if pct is not None and pct != 0 else "")


def _comparison_of(obs: Mapping[str, Any], part: str = "events") -> Mapping[str, Any] | None:
    """A result's comparison (``log_stats`` nests one per part: ``events`` and
    ``top_values``)."""
    comp = obs.get("comparison")
    if isinstance(comp, Mapping) and not isinstance(comp.get("rows"), list):
        comp = comp.get(part)
    return comp if isinstance(comp, Mapping) and isinstance(comp.get("rows"), list) else None


def _say_comparison(comp: Mapping[str, Any], *, limit: int = 5, plain_labels: bool = True,
                    skip: Iterable[str] = (), with_note: bool = True) -> list[str]:
    """``Cases: **47** in Oct 2026 to date vs 30 in Sep 2026 to date (+17, +56.7%).``
    per row (the subject against its baseline), then the in-progress note."""
    periods = [display_text(p, 40) for p in comp.get("periods") or [] if isinstance(p, str)]
    subject = display_text(comp.get("subject"), 40) or (periods[-1] if periods else "this period")
    baseline = display_text(comp.get("baseline"), 40) or (periods[-2] if len(periods) > 1 else "the period before")
    try:
        cur_at, base_at = periods.index(subject), periods.index(baseline)
    except ValueError:
        cur_at, base_at = -1, -2
    out: list[str] = []
    skipped = {s.lower() for s in skip}
    rows = [r for r in comp.get("rows") or [] if isinstance(r, Mapping)
            and display_text(r.get("label"), 60).lower() not in skipped]
    for row in rows[:limit]:
        values = row.get("values") if isinstance(row.get("values"), list) else []
        if len(values) < 2 or all(_num(v) is None for v in (values[cur_at], values[base_at])):
            continue
        label = display_text(row.get("label"), 60) if plain_labels else _code(row.get("label"), 60)
        unit = row.get("unit")
        if _num(values[base_at]) is None:
            out.append(f"{label}: **{_value_text(values[cur_at], unit)}** {_in(subject)}; not measured "
                       f"{_in(baseline)}, so there is no change to show.")
            continue
        flags = [_change_text(row)] + (["small sample"] if row.get("small_sample") and unit != "count" else [])
        out.append(f"{label}: **{_value_text(values[cur_at], unit)}** {_in(subject)} vs "
                   f"{_value_text(values[base_at], unit)} {_in(baseline)} ({'; '.join(flags)}).")
    note = comp.get("note")
    if with_note and isinstance(note, str) and note.strip() and out:
        out.append(_plain(note, 240))
    return out


def _entry_titled(result: Result | None, kind: str, *prefixes: str) -> ManifestEntry | None:
    """The first artifact of ``kind`` whose (engine) title starts with one of
    ``prefixes`` (any of that kind without prefixes)."""
    if result is None or not result.ok:
        return None
    for entry in result.artifacts:
        if entry.kind == kind and (not prefixes or entry.title.lower().startswith(tuple(p.lower() for p in prefixes))):
            return entry
    return None


def _block_titled(result: Result | None, kind: str, *prefixes: str, view: str | None = None,
                  title: str | None = None) -> dict[str, Any] | None:
    entry = _entry_titled(result, kind, *prefixes)
    if entry is None:
        return None
    request: dict[str, Any] = {"ref": entry.ref}
    if entry.views:
        request["view"] = view if view in entry.views else entry.views[0]
    if title:
        request["title"] = title[:120]
    return request


def _group_value(field: str, label: Any) -> str:
    """A grouped value in prose: an engine enum as words, a rule, assignee or source
    (case- or log-derived) as inline code."""
    if field in ("rule", "assignee", "source", "surface", "mitre_tactic", "mitre_technique", "closed_by"):
        text = display_text(label, 80)
        if field in ("assignee", "closed_by") and text in ("Unassigned", "Not closed"):
            return text.lower()
        return _code(label, 80)
    return display_text(label, 60) or "(none)"


def _stats_groups(o: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [g for g in o.get("groups") or [] if isinstance(g, Mapping)]


def _stats_noun(o: Mapping[str, Any]) -> str:
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    noun = _case_noun(filters, "case")
    if isinstance(filters.get("severity"), str) and noun == "case":
        noun = f"{display_text(filters['severity'], 20)}-severity case"
    return noun


def _stats_lead(o: Mapping[str, Any]) -> str:
    """"**19 cases are open right now**" or "**47 cases** over all time (since …)"."""
    total = _num(o.get("total")) or 0
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    window = _window(o, "all time")
    exact = "" if o.get("exact", True) is not False else " (a partial count)"
    if filters.get("status_group") == "active" and window.lower().startswith("all time"):
        verb = "is" if int(total) == 1 else "are"
        return f"**{_plural(total, 'case')} {verb} open right now**{exact}"
    return f"**{_plural(total, _stats_noun(o))}** {_in(window)}{exact}"


def _date_text(value: Any) -> str:
    """An ISO timestamp as a date ("18 Aug 2026"); "" when it is not one."""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", value if isinstance(value, str) else "")
    if not match or not 1 <= int(match.group(2)) <= 12:
        return ""
    return f"{int(match.group(3))} {_MONTH_SHORT[int(match.group(2)) - 1]} {match.group(1)}"


def _say_bucket_counts(o: Mapping[str, Any], *, unit_word: str | None = None) -> str:
    """"By the month they were opened: Aug 2026 3, Sep 2026 9 and Oct 2026 (in progress) 7."""
    buckets = [b for b in o.get("buckets") or [] if isinstance(b, Mapping)]
    unit = o.get("bucket") if isinstance(o.get("bucket"), str) else "period"
    if not buckets:
        return ""
    counts: dict[str, float] = {}
    for g in _stats_groups(o):
        if g.get("bucket") is not None and not g.get("key"):
            counts[str(g.get("bucket"))] = counts.get(str(g.get("bucket")), 0) + (_num(_dig(g, "metrics", "count")) or 0)
        elif g.get("bucket") is not None:
            counts[str(g.get("bucket"))] = counts.get(str(g.get("bucket")), 0) + (_num(_dig(g, "metrics", "count")) or 0)
    parts = []
    first = next((i for i, b in enumerate(buckets) if counts.get(str(b.get("label")))), len(buckets))
    if first >= 2 and first < len(buckets):
        # "None from Jan 2026 to Jul 2026": a leading run of empty periods in one phrase.
        parts.append(f"none from {display_text(buckets[0].get('label'), 40)} to "
                     f"{display_text(buckets[first - 1].get('label'), 40)}")
        buckets = buckets[first:]
    shown = buckets if len(buckets) <= 12 else [b for b in buckets if counts.get(str(b.get("label")))][-12:]
    for b in shown:
        label = display_text(b.get("label"), 40) + (" (in progress)" if b.get("in_progress") else "")
        parts.append(f"{label}: {_count(counts.get(str(b.get('label')), 0))}")
    if not parts:
        return ""
    lead = unit_word or f"By the {unit} they were opened"
    text = f"{lead}: {_join(parts)}."
    if len(buckets) > len(shown):
        text += f" ({_plural(len(buckets) - len(shown), unit)} with no cases are not listed; the chart shows every {unit}.)"
    missing = o.get("missing_created_note")
    if isinstance(missing, str) and missing.strip():
        text += f" {_sentence(_plain(missing, 160))}"
    return text


def _say_group_counts(o: Mapping[str, Any]) -> str:
    fields = [f for f in o.get("group_by") or [] if isinstance(f, str)]
    if not fields or o.get("bucket"):
        return ""
    field = fields[0]
    rows = [g for g in _stats_groups(o) if isinstance(g.get("key"), Mapping)]
    parts = [f"{_group_value(field, _dig(g, 'key', field))} {_count(_dig(g, 'metrics', 'count'))}" for g in rows[:8]]
    if not parts:
        return ""
    other = _num(_dig(o, "other", "metrics", "count"))
    name = {"closed_by": "who closed them", "decided_by": "who decided them", "status_group": "open or closed",
            "mitre_technique": "ATT&CK technique", "mitre_tactic": "ATT&CK tactic"}.get(field, field.replace("_", " "))
    text = f"By {name}: {_join(parts)}"
    if len(rows) > 8:
        text += f" and {_plural(len(rows) - 8, 'more group')}"
    if other:
        text += f"; {_plural(other, 'more case')} in smaller groups"
    text += "."
    if o.get("multi_valued"):
        text += f" A case can count under several {name}s, so these add up to more than the total."
    return text


_TOTAL_WORDS = {"fp_rate": "false-positive rate", "tp_rate": "true-positive rate", "auto_closed": "closed automatically",
                "human_closed": "closed by an analyst", "analyst_fp": "confirmed false positives by analysts",
                "mttr_p50": "MTTR median", "mtta_p50": "MTTA median", "mttd_p50": "MTTD median",
                "mttr_p90": "MTTR p90", "mtta_p90": "MTTA p90", "mttd_p90": "MTTD p90", "mean_risk": "average risk",
                "open_now": "open now"}


def _say_stats_totals(o: Mapping[str, Any]) -> str:
    totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
    units = o.get("units") if isinstance(o.get("units"), Mapping) else {}
    parts = []
    for metric in [m for m in o.get("metrics") or [] if isinstance(m, str)]:
        if metric == "count" or metric not in _TOTAL_WORDS:
            continue
        value = totals.get(metric)
        unit = units.get(metric)
        if metric in ("auto_closed", "human_closed", "analyst_fp", "open_now"):
            parts.append(f"{_count(value)} {_TOTAL_WORDS[metric]}")
        else:
            parts.append(f"{_TOTAL_WORDS[metric]} {_value_text(value, unit)}")
    return (_sentence(_join(parts)) if parts else "")


def _zero_suggestions(o: Mapping[str, Any]) -> tuple[str, list[str]]:
    """``(sentence, follow-ups)`` from a zero-match result's engine-built suggestions:
    each becomes a one-click question that re-runs the lookup (SPEC D10)."""
    labels = [display_text(s.get("label"), 60) for s in o.get("suggestions") or [] if isinstance(s, Mapping)]
    labels = [label for label in labels if label]
    if not labels:
        return "", []
    follow = []
    for label in labels[:3]:
        low = label.lower()
        if low == "all time":
            follow.append("Show the same for all time")
        elif low.startswith("without the "):
            follow.append(f"Show the same {low}")
        elif low.startswith(("last ", "this ")):
            follow.append(f"Show the same for the {low}" if low.startswith("last ") else f"Show the same for {low}")
    return f"To widen it: {_join(labels[:3], 'or')}.", follow


def _say_case_stats(r: Result) -> list[str]:
    o = r.obs
    total = _num(o.get("total")) or 0
    if not total:
        hint, _follow = _zero_suggestions(o)
        return [f"No {_stats_noun(o)} matched {_in(_window(o, 'all time'))}." + (f" {hint}" if hint else "")]
    out = [_stats_lead(o) + "."]
    for sentence in (_say_bucket_counts(o) if o.get("bucket") and not o.get("group_by") else "",
                     _say_group_counts(o), _say_stats_totals(o)):
        if sentence:
            out.append(sentence)
    if o.get("partial"):
        out.append(_plain(o.get("partial"), 240))
    comp = _comparison_of(o)
    if comp:
        out.extend(_say_comparison(comp))
    return out


def _stats_blocks(r: Result | None, *, series_view: str = "bar") -> list[dict[str, Any]]:
    """A ``case_stats`` result's blocks: the series (bars per period), the grouping
    (bars, or a donut for a small complete split), the comparison and the table."""
    if r is None:
        return []
    return _keep(
        _block_titled(r, "comparison", view="grouped_bar"),
        _block(r, "series", view=series_view),
        _block(r, "categories", view=_first_view(r, "categories", ("hbar", "bar"))),
        _block_titled(r, "series", "rates", view="line"),
        _block_titled(r, "series", "response times", view="line"),
        _block(r, "table", view="table") if not r.artifact("series") else None,
        _block(r, "kpis", view="kpi_group") if not (r.artifact("series") or r.artifact("categories")) else None,
    )


def _final_breakdown(view: PromptView, ask: Ask) -> Final | None:
    stats = view.ok("case_stats", where=lambda r: r.input.get("window") != _ANCHOR_WINDOW or not _needs_anchor(ask))
    if stats is None:
        return None
    o = stats.obs
    total = _num(o.get("total")) or 0
    body = _say_case_stats(stats)
    oldest = view.ok("search_cases")
    if oldest is not None and total:
        cases = [c for c in oldest.obs.get("cases") or [] if isinstance(c, Mapping)]
        if cases:
            first = cases[0]
            created = _date_text(first.get("created_at"))
            body.append(f"The oldest still open is {_code(first.get('case_id'), 60)} ({_case_name(first)}), opened "
                        f"{created}." if created else f"The oldest still open is {_code(first.get('case_id'), 60)}.")
            body.extend(_case_bullets(oldest, limit=5)[1:])
    volume = (view.ok("case_stats", where=lambda r: r is not stats and bool(r.obs.get("bucket"))
                      and r.input.get("window") != _ANCHOR_WINDOW)
              or view.ok("case_stats", where=lambda r: r is not stats and bool(r.obs.get("bucket"))))
    if volume is not None and volume is not stats:
        over = f" {_in(_window(volume.obs))}" if volume.input.get("window") == _ANCHOR_WINDOW else ""
        sentence = _say_bucket_counts(volume.obs, unit_word=f"Cases opened per {volume.obs.get('bucket')}{over}")
        if sentence:
            body.append(sentence)
    blocks = _stats_blocks(stats)
    if volume is not None and volume is not stats:
        blocks += _keep(_block(volume, "series", view="bar"))
    if oldest is not None and total:
        blocks += _keep(_block(oldest, "case_list", view="case_list", title="Oldest open cases"))
    follow: list[str] = []
    filters = o.get("filters") if isinstance(o.get("filters"), Mapping) else {}
    if not total:
        _hint, follow = _zero_suggestions(o)
    elif o.get("bucket") and not o.get("group_by"):
        follow = ["Break the same cases down by severity", "Compare this month with last month"]
        if filters.get("status_group") == "active":
            follow.insert(1, "Show the open cases by month as a table")
    else:
        follow = ["Show the same cases by month", "Compare this month with last month"]
    follow = [f for f in follow if f] + _follow_ups(view, "cases", charts=bool(blocks))
    return Final(body=body, blocks=blocks[:6], follow_ups=list(dict.fromkeys(follow))[:3])


_TREND_WORDS = {"timing": "Response times", "rates": "False-positive and true-positive rates",
                "risk": "Average risk", "alerts": "Alert and case volume", "cases": "Case volume"}


def _say_bucket_metric(o: Mapping[str, Any], metric: str, name: str) -> str:
    """"MTTR median per week: latest W41 2026 (in progress) 12 min; highest W39 2026 40 min.""" 
    buckets = [b for b in o.get("buckets") or [] if isinstance(b, Mapping)]
    units = o.get("units") if isinstance(o.get("units"), Mapping) else {}
    by_label = {str(g.get("bucket")): _num(_dig(g, "metrics", metric)) for g in _stats_groups(o)
                if g.get("bucket") is not None}
    points = [(display_text(b.get("label"), 40) + (" (in progress)" if b.get("in_progress") else ""),
               by_label.get(str(b.get("label")))) for b in buckets]
    measured = [(label, value) for label, value in points if value is not None]
    if not measured:
        return f"{name}: not measured in any {o.get('bucket') or 'period'} of this window."
    unit = units.get(metric)
    latest = measured[-1]
    best = max(measured, key=lambda p: p[1])
    text = (f"{name} per {o.get('bucket') or 'period'}: latest {latest[0]} {_value_text(latest[1], unit)}; "
            f"highest {best[0]} {_value_text(best[1], unit)}")
    return text + f" ({len(measured)} of {len(points)} periods measured)."


def _final_trend(view: PromptView, ask: Ask) -> Final | None:
    stats = view.ok("case_stats")
    trends = view.ok("soc_metrics", "trends")
    timing = view.ok("soc_metrics", "timing")
    logs = view.ok("log_stats")
    if stats is None and trends is None and timing is None:
        return None
    subject = ask.subject or "cases"
    body: list[str] = []
    window = _window((stats or trends or timing).obs)  # type: ignore[union-attr]
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        body.append(f"No period was named, so this shows {_in(window)}; ask for another window (all time, this "
                    "quarter, the last 6 months) to change it.")
    if subject == "timing" and stats is not None:
        o = stats.obs
        body.insert(0, f"**{_TREND_WORDS['timing']} {_in(window)}**, by {o.get('bucket') or 'period'} "
                       f"({_plural(o.get('total'), 'case')}, exact):")
        for metric, name in (("mttr_p50", "MTTR median"), ("mtta_p50", "MTTA median"), ("mttd_p50", "MTTD median")):
            body.append(f"- {_say_bucket_metric(o, metric, name)}")
        if timing is not None:
            body.append(_say_timing(timing))
    elif subject in ("rates", "risk") and stats is not None:
        o = stats.obs
        body.insert(0, f"**{_TREND_WORDS[subject]} {_in(window)}**, by {o.get('bucket') or 'period'} "
                       f"({_plural(o.get('total'), 'case')}, exact):")
        metrics = (("fp_rate", "False-positive rate"), ("tp_rate", "True-positive rate"),
                   ("auto_closed", "Closed automatically")) if subject == "rates" else (("mean_risk", "Average risk"),)
        for metric, name in metrics:
            body.append(f"- {_say_bucket_metric(o, metric, name)}")
        sentence = _say_stats_totals(o)
        if sentence:
            body.append(f"Over the whole window: {sentence[:1].lower()}{sentence[1:]}")
    else:
        if trends is not None:
            sentence = _say_trends(trends)
            if sentence:
                body.insert(0, sentence)
        if stats is not None:
            sentence = _say_bucket_counts(stats.obs, unit_word="") if not stats.obs.get("group_by") else ""
            groups = _say_group_counts(stats.obs) or ""
            if sentence:
                body.append(sentence)
            if groups:
                body.append(groups)
            elif stats.obs.get("group_by"):
                body.append(f"By severity, the cases are split as the stacked chart shows ({_plural(stats.obs.get('total'), 'case')}).")
        if logs is not None:
            body.append("Alert volume: " + _say_log_stats(logs, subject=""))
    blocks = _keep(
        _block_titled(stats, "series", "response times", view="line"),
        _block_titled(stats, "series", "rates", view="line"),
        _block_titled(stats, "series", "average risk", view="line"),
        _block(trends, "series", view="line", title="Cases opened and closed"),
        _block_titled(trends, "series", "alerts", view="bar"),
        _block(stats, "series", view="stacked_bar" if stats and stats.obs.get("group_by") else "bar")
        if subject in ("cases", "alerts") else None,
        _block_titled(logs, "series", view="line"),
        _block(timing, "kpis", view="kpi_group"),
    )
    follow = ["Compare this month with last month", "Show the same trend for the last 6 months by month"]
    return Final(body=body, blocks=blocks[:6], follow_ups=(follow + _follow_ups(view, "posture", charts=True))[:3])


def _final_compare(view: PromptView, ask: Ask) -> Final | None:
    head = view.ok("case_stats", where=lambda r: not r.obs.get("group_by") and bool(_comparison_of(r.obs)))
    post = view.ok("soc_metrics", "posture")
    mix = view.ok("case_stats", where=lambda r: bool(r.obs.get("group_by")) and bool(_comparison_of(r.obs)))
    timing = view.ok("soc_metrics", "timing")
    if head is None and post is None and mix is None:
        return None
    body: list[str] = []
    source = head or post or mix
    comp = _comparison_of(source.obs) if source else None  # type: ignore[union-attr]
    if comp:
        subject = display_text(comp.get("subject"), 40)
        baseline = display_text(comp.get("baseline"), 40)
        body.append(f"**{subject} compared with {baseline}** (changes computed exactly over every case):")
        body.extend(f"- {line}" for line in _say_comparison(comp, limit=6, with_note=False))
        note = comp.get("note")
        if isinstance(note, str) and note.strip():
            body.append(_plain(note, 240))
    elif head is not None:
        body.extend(_say_case_stats(head))
    if post is not None and _comparison_of(post.obs):
        rows = [r for r in _comparison_of(post.obs).get("rows") or [] if isinstance(r, Mapping)]  # type: ignore[union-attr]
        auto = next((r for r in rows if r.get("label") == "Automation rate"), None)
        if auto is not None:
            body.append(f"Automation rate: {_change_text(auto)} "
                        f"({_value_text((auto.get('values') or [None])[-1], 'percent')} now).")
    if mix is not None and _comparison_of(mix.obs):
        lines = _say_comparison(_comparison_of(mix.obs), limit=4, with_note=False)  # type: ignore[arg-type]
        if lines:
            body.append(f"By {display_text((mix.obs.get('group_by') or ['severity'])[0], 30).replace('_', ' ')}:")
            body.extend(f"- {line}" for line in lines)
    if timing is not None and _comparison_of(timing.obs):
        said = [str(r.get("label")) for r in (comp or {}).get("rows") or [] if isinstance(r, Mapping)]
        lines = _say_comparison(_comparison_of(timing.obs), limit=3, skip=said, with_note=False)  # type: ignore[arg-type]
        if lines:
            body.append("Response times: " + " ".join(lines))
    blocks = _keep(
        _block_titled(head, "comparison", view="kpi_group", title="Change versus the previous period"),
        _block_titled(mix, "comparison", view="grouped_bar", title="By severity"),
        _block(post, "kpis", view="kpi_group", title="Security posture with changes"),
        _block_titled(timing, "comparison", title="Response times with changes"),
    )
    follow = ["Show the same comparison by week", "Create an executive report for this month",
              "Compare with the same period last year"]
    if ask.compare == "same_period_last_year":
        follow[2] = "Compare this month with last month"
    return Final(body=body, blocks=blocks, follow_ups=follow)


_PERF_TITLES = {"executive": "SOC performance report", "monthly": "SOC report", "infographic": "Posture infographic",
                "posture": "Posture report"}


def _perf_title(template: str, label: str, all_time: bool) -> str:
    if template == "monthly":
        return f"{label} SOC report" if label else "Monthly SOC report"
    if all_time:
        return {"executive": "Lifetime performance report", "infographic": "Lifetime posture infographic",
                "posture": "Lifetime posture report"}.get(template, "Lifetime performance report")
    base = _PERF_TITLES.get(template, "SOC performance report")
    return f"{base}, {label}" if label else base


def _perf_steps(post: Result | None, noise: Result | None, rules: Result | None, cost: Result | None) -> list[str]:
    steps = _posture_steps(post, noise)
    groups = [g for g in (rules.obs.get("groups") if rules else None) or [] if isinstance(g, Mapping)]
    if groups:
        steps.append("Review tuning for the rules that open the most cases (see Top rules).")
    if cost is not None and _num(cost.obs.get("total_cost_usd")):
        steps.append("Check AI spend against the daily budget in Analytics › Cost.")
    return list(dict.fromkeys(steps))[:5]


def _final_perf_report(view: PromptView, ask: Ask) -> Final | None:
    vol = view.ok("case_stats", where=lambda r: bool(r.obs.get("bucket")) and r.input.get("window") != _ANCHOR_WINDOW)
    if vol is None:
        vol = view.ok("case_stats", where=lambda r: bool(r.obs.get("bucket")))
    sev = view.ok("case_stats", where=lambda r: "severity" in (r.obs.get("group_by") or []))
    rules = view.ok("case_stats", where=lambda r: "rule" in (r.obs.get("group_by") or []))
    post, timing = view.ok("soc_metrics", "posture"), view.ok("soc_metrics", "timing")
    noise, cost, open_cases = view.ok("soc_metrics", "noise_funnel"), view.ok("cost_usage"), view.ok("search_cases")
    if vol is None and post is None:
        return None
    template = ask.report if ask.report in ("executive", "monthly", "infographic", "posture") else "executive"
    o = (vol or post).obs  # type: ignore[union-attr]
    label = _window(o, "")
    all_time = label.lower().startswith("all time")
    title = _perf_title(template, "" if all_time else label, all_time)
    if template == "executive" and re.search(r"\bexec(?:utive)? (?:summary|overview|brief)\b", ask.lowered):
        title = f"Executive summary, {label}" if label and not all_time else "Executive summary"
    p = post.obs if post else {}
    quality = p.get("quality") if isinstance(p.get("quality"), Mapping) else {}
    totals = o.get("totals") if isinstance(o.get("totals"), Mapping) else {}
    cases = _num(o.get("total") if vol else p.get("case_count"))
    fp = totals.get("fp_rate") if vol else (_num(quality.get("false_positive_rate")) or 0) * 100
    automation = quality.get("automation_rate")
    mttr = _dig(p, "lifecycle_minutes", "mttr_minutes", "p50") if post else totals.get("mttr_p50")
    open_now = _dig(p, "open_now", "count")
    facts = [f"**{_plural(cases, 'case')}**"]
    if _num(fp) is not None:
        facts.append(f"false-positive rate **{_pct(fp)}**")
    if _num(automation) is not None:
        facts.append(f"**{_pct(automation, ratio=True)}** closed automatically")
    if _num(mttr) is not None:
        facts.append(f"MTTR median {_minutes(mttr)}")
    if _num(open_now) is not None:
        facts.append(f"**{_count(open_now)} open now**")
    span = (f" ({label.split(' (')[0]}, {label.split(' (', 1)[1].rstrip(')')})" if all_time and " (" in label
            else "")
    lead = f"**{title}**{span}: {_join(facts)}."
    summary_bits = [f"{_plural(cases, 'case')} {_in(label) if label else ''}".strip()]
    if _num(fp) is not None:
        summary_bits.append(f"false-positive rate {_pct(fp)}")
    if _num(automation) is not None:
        summary_bits.append(f"{_pct(automation, ratio=True)} closed automatically")
    if _num(mttr) is not None:
        summary_bits.append(f"MTTR median {_minutes(mttr)}")
    if _num(open_now) is not None:
        summary_bits.append(f"{_count(open_now)} open now")
    stages = _stages(noise.obs) if noise else {}
    overall = _dig(noise.obs, "reduction_pct", "overall") if noise else None
    if _num(overall) is not None:
        summary_bits.append(f"{_pct(overall)} noise reduction from {_count(stages.get('ingested'))} alerts")
    comp = _comparison_of(vol.obs) if vol else None
    change_lines = _say_comparison(comp, limit=3) if comp else []
    summary = _sentence(_join(summary_bits)) + (" " + " ".join(c.replace("**", "") for c in change_lines[:3])
                                                 if change_lines else "")
    steps = _perf_steps(post, noise, rules, cost)
    highlights: list[dict[str, Any]] = []
    if template == "infographic":
        if _num(fp) is not None:
            highlights.append({"type": "callout", "tone": "info",
                               "text": f"False-positive rate {_pct(fp)} over {_plural(cases, 'case')}."})
        if _num(automation) is not None:
            highlights.append({"type": "callout", "tone": "success",
                               "text": f"{_pct(automation, ratio=True)} of closed cases were closed automatically."})
        if _num(open_now):
            highlights.append({"type": "callout", "tone": "warning", "text": f"{_count(open_now)} cases are open now."})
    sections = [
        {"heading": "Summary", "items": _keep(
            {"type": "markdown", "text": _plain(summary, 1100)},
            _block(post, "kpis", view="kpi_group", title="Security posture"), *highlights)},
        {"heading": "Volume", "items": _keep(
            _block(vol, "series", view="bar", title="Cases opened per " + str(o.get("bucket") or "period")),
            _block(sev, "categories", view=_first_view(sev, "categories", ("donut", "hbar")), title="Cases by severity"),
            _block_titled(vol, "comparison", view="kpi_group", title="Change versus the previous period"))},
        {"heading": "Quality", "items": _keep(
            _block_titled(vol, "series", "rates", view="line", title="False-positive and true-positive rates"),
            _block_titled(vol, "series", "counts", view="bar", title="Closed automatically"))},
        {"heading": "Response times", "items": _keep(
            _block(timing, "kpis", view="kpi_group", title="Response times"),
            _block_titled(vol, "series", "response times", view="line", title="MTTR median per period"))},
        {"heading": "Noise reduction", "items": _keep(_block(noise, "funnel", view="funnel", title="Noise reduction"))},
        {"heading": "Top rules", "items": _keep(_block(rules, "categories", view="hbar", title="Rules that opened the most cases"))},
        {"heading": "Open work", "items": _keep(_block(open_cases, "case_list", view="case_list", title="Highest-risk open cases"))},
        {"heading": "AI cost", "items": _keep(_block(cost, "kpis", view="kpi_group", title="AI cost"))},
        {"heading": "Next steps", "items": [{"type": "markdown", "text": "\n".join(
            f"{i}. {s}" for i, s in enumerate(steps, start=1))}]},
    ]
    sections = [s for s in sections if s["items"]]
    envelope: dict[str, Any] = {"type": "report", "title": title, "template": template, "sections": sections}
    if label:
        envelope["subtitle"] = label[:200]
    if template == "infographic":
        envelope["layout"] = "infographic"
    body = [lead]
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        body.append("No period was named, so the report covers the last 30 days; ask for a lifetime report to cover "
                    "all time.")
    follow = ["Create the same report for all time" if not all_time else "Create the same report for the last 90 days",
              "Compare this month with last month", "Make an infographic of our posture this quarter"]
    if template == "infographic":
        follow[2] = "Create an executive summary for this quarter"
    final = Final(body=body, blocks=[envelope], follow_ups=follow, lead=body[:2], closing=_REPORT_READY)
    return final


def _confidence_word(value: Any) -> str:
    number = _num(value)
    if number is None:
        return "unknown"
    return "high" if number >= 0.85 else "medium" if number >= 0.6 else "low"


def _case_missing(view: PromptView, ask: Ask) -> Final | None:
    """The case the question names does not exist (or the caller cannot see it): a
    clear data answer, never "chat cannot read that data" (SPEC D9)."""
    failed = next((r for r in view.results() if r.tool in ("get_case", "explain_decision") and not r.ok), None)
    if failed is None or view.ok("get_case") is not None:
        return None
    reason = display_text(failed.summary, 120).lower()
    if "not found" not in reason and "no case" not in reason:
        return None
    named = _code(ask.case_id, 60) if ask.case_id else "that id"
    body = [f"No case with the id {named} was found: it does not exist, or it is outside what you can see. "
            "Check the id, or find the case by searching for words from its title."]
    follow = ["List the open cases", "Which cases were escalated this week?", "Show the newest escalated case"]
    return Final(body=body, follow_ups=follow, narrated={r.ordinal for r in view.failed()})


def _final_brief(view: PromptView, ask: Ask) -> Final | None:
    missing = _case_missing(view, ask)
    if missing is not None:
        return missing
    got, decision = view.ok("get_case"), view.ok("explain_decision")
    if got is None:
        return None
    case = _dig(got.obs, "case")
    case = case if isinstance(case, Mapping) else {}
    case_id = display_text(case.get("case_id"), 60) or (ask.case_id or "")
    stats = view.ok("log_stats")
    related = view.ok("search_cases", where=lambda r: bool(_dig(r.obs, "filters", "entity")))
    mitre = view.ok("mitre_lookup")
    lookup = view.ok("lookup_indicator")
    confidence = _confidence_word(case.get("confidence"))
    status = display_text(case.get("status"), 30).replace("_", " ")
    # The brief's own text leaves: numbers, enums and the case id only (no case text).
    assessment = (f"Advisory: this brief does not decide the case; the deterministic policy does. The case "
                  f"{_case_facts(case)}, status {status}. Confidence in the recorded verdict: {confidence}.")
    findings: list[str] = []
    if decision is not None:
        sentence = _say_decision(decision)
        if sentence:
            findings.append(sentence)
    if stats is not None:
        findings.append(f"Its entity appears in {_log_figure(stats.obs)}.")
    if related is not None:
        count = _num(related.obs.get("count")) or 0
        findings.append(f"{_plural(count, 'case')} carry the same entity." if count != 1 else
                        "Only this case carries the entity.")
    if lookup is not None and _num(lookup.obs.get("reputation_score")) is not None:
        findings.append(f"The indicator scores {_count(lookup.obs.get('reputation_score'))}/100 "
                        f"({display_text(lookup.obs.get('verdict'), 30) or 'unknown'}).")
    techniques = [m for m in got.obs.get("mitre") or [] if isinstance(m, Mapping) and m.get("id")]
    if techniques:
        findings.append(f"It maps to {_plural(len(techniques), 'ATT&CK technique')}.")
    couldnt: list[str] = []
    entity = _entity_of(got.obs)
    if entity is None:
        couldnt.append("The case has no entity, so its activity in the logs and related cases were not checked.")
    elif not _LOOKUP_KIND.get(entity[0]):
        couldnt.append("The entity is not an indicator (IP, domain, URL or hash), so no reputation was looked up.")
    for r in view.failed():
        couldnt.append(f"{_TOOL_NAMES.get(r.tool, r.tool)[:1].upper()}{_TOOL_NAMES.get(r.tool, r.tool)[1:]} "
                       f"did not complete ({display_text(r.status, 20)}).")
    if stats is not None and not stats.obs.get("total"):
        couldnt.append("Logs older than the sources keep were not available.")
    couldnt = couldnt or ["Everything this brief relies on was read."]
    steps = ["Confirm the recorded decision with the case owner.",
             "Check the other cases that carry the same entity before closing.",
             "Act on the recommendation recorded on the case." if case.get("recommended_action") else
             "Record a recommendation on the case once it is decided."]
    sections = [
        {"heading": "Assessment", "items": _keep({"type": "markdown", "text": _plain(assessment, 1100)},
                                                 _block(decision, "kpis", view="kpi_group", title="Decision inputs"))},
        {"heading": "Key findings", "items": [{"type": "markdown", "text": "\n".join(
            f"- {f}" for f in findings[:5])}] if findings else []},
        {"heading": "Affected entities", "items": _keep(
            _block(got, "entity", view="entity", title="Case entity"),
            _block(stats, "categories", view="hbar", title="Entity activity in the logs"),
            _block(lookup, "entity", view="entity", title="Indicator reputation"))},
        {"heading": "ATT&CK", "items": _keep(_block(mitre, "mitre", view="mitre", title="ATT&CK techniques")
                                             or _block(got, "mitre", view="mitre", title="ATT&CK techniques"))},
        {"heading": "Timeline", "items": _keep(_block(got, "timeline", view="timeline", title="Status history"))},
        {"heading": "Related cases", "items": _keep(_block(related, "case_list", view="case_list",
                                                           title="Cases with the same entity")
                                                    if related and _num(related.obs.get("count")) else None)},
        {"heading": "Next steps", "items": [{"type": "markdown", "text": "\n".join(
            f"{i}. {s}" for i, s in enumerate(steps, start=1))}]},
        {"heading": "What I couldn't check", "items": [{"type": "markdown", "text": "\n".join(
            f"- {c}" for c in couldnt[:5])}]},
    ]
    sections = [s for s in sections if s["items"]]
    title = f"Investigation brief: {case_id}" if case_id else "Investigation brief"
    envelope = {"type": "report", "title": title[:120], "template": "investigation_brief", "sections": sections,
                "subtitle": "Advisory · the case decision is made by policy"}
    name = _case_name(case)
    lead = [f"**Investigation brief for {_code(case_id, 60)}**" + (f" ({name})" if name else "")
            + f": the case {_case_facts(case)}, status **{status}**; confidence in the verdict is {confidence}.",
            "The brief is advisory: the case decision is made by the deterministic policy, not by this brief."]
    action = _plain(_dig(case, "recommended_action"), 200)
    body = lead + ([f"Recorded recommendation: {action}"] if action else [])
    return Final(body=body, blocks=[envelope], follow_ups=["Why was this case decided this way?",
                                                           "Show the other cases for the same entity",
                                                           "Investigate the newest escalated case"],
                 lead=body, closing=_REPORT_READY)


def _final_deep(view: PromptView, ask: Ask) -> Final | None:
    if ask.entity is None:
        return None
    kind, value = ask.entity
    results = [r for r in view.results() if r.ok and r.observation is not None]
    if not results:
        return None
    noun = {"host": "host", "user": "user", "ip": "IP"}.get(kind, kind)
    log_results = [r for r in results if r.tool == "log_stats"]
    window = _window(log_results[0].obs) if log_results else _window(results[0].obs)
    body = [f"**In-depth investigation of {noun} {_code(value)} {_in(window)}**: "
            f"{_plural(len(view.results()), 'lookup')} across logs, cases, decisions and threat intel."]
    lookup = view.ok("lookup_indicator")
    if lookup is not None:
        body.append(_say_lookup(lookup))
    said_total = False
    for r in log_results:
        group = (r.obs.get("group_by") or [""])[0]
        if group not in ("user", "host", "ip", "rule"):
            continue
        sentence = _say_log_stats(r, subject=f"for {_code(value)}")
        if said_total:
            # The total is the same for every grouping: say it once, then each ranking.
            sentence = sentence.split("; ", 1)[1] if "; " in sentence else ""
            sentence = sentence[:1].upper() + sentence[1:]
        if sentence:
            body.append(f"- {sentence}")
            said_total = True
    logs = view.ok("search_logs")
    if logs is not None:
        body.append(_say_search_logs(logs, subject=_code(value)))
    cases = view.ok("search_cases")
    stats = view.ok("case_stats")
    if stats is not None:
        body.extend(_say_case_stats(stats)[:2])
    elif cases is not None:
        body.append(_say_search_cases(cases))
    got = view.ok("get_case")
    if got is not None:
        body.append("Riskiest related case: " + " ".join(_say_get_case(got)[:2]))
        decision = view.ok("explain_decision")
        if decision is not None:
            sentence = _say_decision(decision)
            if sentence:
                body.append(sentence)
    mitre = view.ok("mitre_lookup")
    if mitre is not None:
        body.extend(_say_mitre(mitre)[:2])
    camps = view.ok("list_campaigns")
    if camps is not None:
        body.append(_say_campaigns(camps))
    audit = view.ok("audit_search")
    if audit is not None:
        body.append("Audit trail of that case: " + _say_audit(audit))
    if not (ask.win and ask.win.spec is not None) and not view.analyst_window:
        body.append("No period was named, so the logs and cases cover the last 30 days.")
    blocks = _keep(
        _block(lookup, "entity", view="entity", title="Indicator reputation"),
        *[_block(r, "categories", view="hbar") for r in log_results[:3]],
        _block_titled(next((r for r in log_results if (r.obs.get("group_by") or [""])[0] == "severity"), None),
                      "series", view="stacked_bar"),
        _block(logs, "table", view="table", title="Matching log events") if logs and _num(logs.obs.get("total")) else None,
        _block(cases, "case_list", view="case_list", title="Cases that carry it")
        if cases and _num(cases.obs.get("count")) else None,
        _block(stats, "categories", view="donut", title="Its cases by verdict") if stats and _num(stats.obs.get("total")) else None,
        _block(got, "timeline", view="timeline", title="Riskiest case: status history"),
        _block(mitre, "mitre", view="mitre", title="ATT&CK techniques"),
        _block(camps, "table", view="table", title="Campaigns"),
    )
    follow = [f"Give me an investigation brief for {display_text(_dig(got.obs, 'case', 'case_id'), 60)}"
              if got is not None and _dig(got.obs, "case", "case_id") else "Investigate the newest escalated case",
              "Which hosts generated the most alerts this week?", "Compare this month with last month"]
    return Final(body=body, blocks=blocks[:12], follow_ups=follow)


def _final_clarify(view: PromptView, ask: Ask) -> Final:
    question, options = CLARIFY_OPTIONS.get(ask.clarify or "trend", CLARIFY_OPTIONS["trend"])
    text = {
        "trend": "Which trend do you want: alerts, cases, AI cost or the false-positive rate?",
        "compare": "Which periods should I compare? Pick one, or name your own (for example Q3 vs Q2).",
        "count": "What should I count? Pick one, or say what you need.",
        "breakdown": "What should I break down, and by what? Pick one, or say what you need.",
    }.get(ask.clarify or "trend", question)
    return Final(body=[text], answer_kind="conversation",
                 clarify={"question": question, "options": list(options), "allow_custom": True})


_FINALS: dict[str, Callable[[PromptView, Ask], Final | None]] = {
    "posture": _final_posture, "noise": _final_noise, "metric": _final_metric, "shift": _final_shift,
    "cost": _final_cost, "top": _final_top, "brute": _final_brute, "tp": _final_tp, "case": _final_case,
    "logs": _final_logs, "log_count": _final_log_count,
    "hunt": _final_hunt, "pivot": _final_pivot, "mitre": _final_mitre, "sources": _final_sources,
    "campaigns": _final_campaigns, "cases": _final_cases, "help": _final_help,
    "explain_metric": _final_explain_metric, "change": _final_change, "unsupported": _final_unsupported,
    "remember": _final_remember, "reshape": _final_reshape, "rerun": _final_rerun,
    "regroup": lambda v, a: _final_regroup(v, a), "empty": _final_empty,
    "breakdown": _final_breakdown, "trend": _final_trend, "compare": _final_compare,
    "perf_report": _final_perf_report, "brief": _final_brief, "deep": _final_deep, "clarify": _final_clarify,
}


_LABEL_SPAN_RE = re.compile(r"^last (\d{1,4}) ?(h|d|w|hours?|days?|weeks?)$")


def _label_hours(label: str) -> int | None:
    """Hours of a trailing window label ("last 6h", "last 7d"); None otherwise."""
    match = _LABEL_SPAN_RE.match(label.strip().lower())
    if not match:
        return None
    n, unit = int(match.group(1)), match.group(2)[0]
    return n * {"h": 1, "d": 24, "w": 168}[unit]


def _hours_phrase(hours: int) -> str:
    if hours == 1:
        return "the last hour"
    if hours >= 48 and hours % 24 == 0:
        return f"the last {hours // 24} days"
    return f"the last {hours} hours"


def _window_note(view: PromptView, ask: Ask) -> str:
    """The effective-window sentence when the analyst selected a time chip (SPEC
    §3.1, §4.3): the chip applies only when the question names no window; a window
    the question names wins; a lookup whose window reached outside the chip was
    limited to it (§4.8.4). Derived from each observation's own window label and
    clamp flag, never assumed."""
    if not view.analyst_window:
        return ""
    windowed = [r for r in view.results()
                if r.ok and r.observation is not None and isinstance(r.obs.get("window"), str)]
    if not windowed:
        return ""
    chip = display_text(view.analyst_window, 60)

    def clamped(r: Result) -> bool:
        flag = r.obs.get("window_clamped_to_request")
        if isinstance(flag, bool):
            # Log AND metric observations carry the structured flag: exact.
            return flag
        if "window limited to the selected range" in r.summary:
            return True
        # An observation without the flag (another windowed tool): compare spans.
        span = _label_hours(_window(r.obs, ""))
        return ask.hours is not None and span is not None and span < ask.hours

    limited = [r for r in windowed if clamped(r)]
    if limited:
        which, held = ("1 lookup", "it was") if len(limited) == 1 else (f"{len(limited)} lookups", "they were")
        return (f"Window: {which} asked for a window reaching outside the {chip} you selected, so {held} "
                f"limited to the {chip}; a selected range is never widened.")
    if ask.win is not None and ask.win.spec is not None:
        return (f"Window: your question named {ask.win.phrase}, so the lookups used that window "
                f"instead of the {chip} you selected.")
    return f"Window: the {chip} you selected applies to the windowed lookups above."


def _pending_note(view: PromptView, ask: Ask) -> str:
    """Planned lookups the turn's round limit left unrun (the parallel bound split a
    plan over more rounds than the turn allows), named instead of dropped silently."""
    if view.final_only or len(view.rounds) < MAX_PLAN_ROUNDS:
        return ""
    try:
        pending = _pending_calls(view, ask)
    except Exception:  # noqa: BLE001 -- advisory only
        return ""
    names = list(dict.fromkeys(_TOOL_NAMES.get(c.tool, c.tool) for c in pending))
    if not names:
        return ""
    return (f"Not run within this question's {MAX_PLAN_ROUNDS} lookup rounds (at most "
            f"{_plural(view.max_parallel, 'lookup')} at a time here): {_join(names)}. Ask again to include "
            + ("it." if len(names) == 1 else "them."))


#: The lookup whose window a report's subtitle names, ahead of the intent's other
#: data tools: a hunt's sightings, not the case search that anchored it ("all time").
_REPORT_WINDOW_TOOLS: dict[str, tuple[str, ...]] = {"hunt": ("search_logs",), "pivot": ("search_logs",)}


def _report_window(view: PromptView, ask: Ask) -> str | None:
    """The report subtitle: the window of the intent's primary data lookup (then its
    other data tools in order, then any windowed lookup), else the analyst's chip."""
    order = _REPORT_WINDOW_TOOLS.get(ask.intent, ()) + _INTENT_TOOLS.get(ask.intent, ())
    for tool in dict.fromkeys(order):
        result = view.ok(tool)
        window = _window(result.obs, "") if result is not None else ""
        if window:
            return window
    windows = [_window(r.obs, "") for r in view.results() if r.ok and r.observation is not None]
    return next((w for w in windows if w), view.analyst_window)


def _compose_final(view: PromptView, ask: Ask) -> Final:
    if view.legacy is not None:
        return _final_legacy(view, ask)
    if not view.granted and ask.intent not in ("remember", "empty", "reshape"):
        return _final_no_tools(view, ask)
    builder = _FINALS.get(ask.intent)
    final = builder(view, ask) if builder is not None else None
    generic = final is None
    if final is None:
        final = _final_generic(view, ask)
    if (not view.case_scoped and ask.report and ask.intent != "shift" and any("ref" in b for b in final.blocks)
            and not any(b.get("type") == "report" for b in final.blocks)):
        # Wrapped first, so the report's lead replaces the narration while the notes
        # (what is missing, what failed, the window) still follow it. A generic final
        # carries its own notes (:attr:`Final.notes`); for the others they are added
        # below.
        if ask.report == "custom" and not re.search(r"\bcustom\b", ask.lowered):
            # "a report on case X" names no template: the intent's own one fits best.
            ask = replace(ask, report=_INTENT_TEMPLATES.get(ask.intent, "custom"))
        final = _as_report(
            final, view, ask, title=_TEMPLATE_TITLES.get(ask.report or "", "Report"),
            subtitle=_report_window(view, ask),
            summary=_report_summary(final, view, ask), steps=_report_steps(view, ask))
    if not generic:
        lead, advice = _missing_lead(view, ask) if ask.intent in _DATA_INTENTS else ("", "")
        primary = (_INTENT_TOOLS.get(ask.intent) or ("",))[0]
        if lead and primary and view.ok(primary) is None:
            # The intent's main data is missing: that leads the answer (what is
            # unavailable and why), and the advice closes it.
            locked, _scoped = _missing_split(view, ask)
            reads = "what you can read" if locked else "what those scopes cover"
            final.body.insert(0, f"{lead}, so this answer uses {reads}:")
            final.body.append(advice)
        elif lead:
            final.body.append(f"{lead}. {advice}".strip())
        failures = _failure_lines(view, skip=final.narrated)
        if failures:
            final.body.append("Lookups that did not complete:")
            final.body.extend(failures)
    pending = _pending_note(view, ask)
    if pending:
        final.body.append(pending)
    if view.case_scoped:
        # A Case Manager turn can never be added to a report (SPEC §1, #5; §4.6).
        if ask.report or any(b.get("type") == "report" for b in final.blocks):
            final = _unwrap_report(final)
    if view.unrun:
        final.body.append("The question reached its time limit before the remaining lookups ran, so this answer "
                          "uses only the lookups that completed.")
    elif view.final_only and not view.results() and ask.intent in _DATA_INTENTS:
        final.body.append("Tool use was closed for this question before any lookup ran, so no data backs this "
                          "answer. Ask again or narrow the question.")
    window_note = _window_note(view, ask)
    if window_note:
        final.body.append(window_note)
    envelope = next((b for b in final.blocks if b.get("type") == "report"), None)
    if ask.save and not view.case_scoped and envelope is not None:
        # SPEC D11: "create/make/build … a report" asks the SERVER to save it to
        # Reports once the answer persists; the title and template are the envelope's
        # own (engine words, the window label and case ids only).
        final.report_request = {"title": display_text(envelope.get("title"), 120) or "Report",
                                "template": str(envelope.get("template") or "custom")}
        final.closing = _REPORT_SAVING
    if final.closing and not view.case_scoped:
        # After every note (what is missing or failed, the time limit, the window):
        # the "ready to add" sentence ends the answer.
        final.body.append(final.closing)
    return final


def _render_final(final: Final) -> str:
    header: dict[str, Any] = {
        "action": "final",
        "blocks": final.blocks[:12],
        "citations": list(dict.fromkeys(final.citations))[:20],
        "console_links": list(dict.fromkeys(final.console_links))[:6],
        "follow_ups": [display_text(f, 140) for f in final.follow_ups[:3]],
        "answer_kind": final.answer_kind,
        "memory_proposal": final.memory_proposal,
    }
    if final.unsupported:
        header["unsupported"] = True
    if final.clarify:
        header["clarify"] = final.clarify
    if final.report_request:
        header["report"] = final.report_request
    body = "\n\n".join(_join_lists(final.body)).strip() or "No answer could be written."
    return json.dumps(header, ensure_ascii=True) + "\n" + ANSWER_SEPARATOR + "\n" + body


def _join_lists(lines: Sequence[str]) -> list[str]:
    """Paragraphs, keeping consecutive list items together as one list."""
    out: list[str] = []
    for line in lines:
        if not line:
            continue
        if out and re.match(r"^(?:- |\d+\. )", line) and (
                re.match(r"^(?:- |\d+\. )", out[-1].split("\n")[-1]) or out[-1].endswith(":")):
            out[-1] = f"{out[-1]}\n{line}"
        else:
            out.append(line)
    return out


def _render_calls(calls: Sequence[Call]) -> str:
    if len(calls) == 1:
        return json.dumps({"action": "tool", "tool": calls[0].tool, "input": calls[0].input}, ensure_ascii=True)
    return json.dumps({"action": "tools", "calls": [{"tool": c.tool, "input": c.input} for c in calls]},
                      ensure_ascii=True)


#: The answer when the planner itself fails: a valid, block-free §4.1 final (a planner
#: bug must degrade one Demo answer, never break the turn).
_SAFE_FINAL = (
    json.dumps({"action": "final", "blocks": [], "citations": [], "console_links": [], "follow_ups": [],
                "answer_kind": "conversation", "memory_proposal": None})
    + "\n" + ANSWER_SEPARATOR + "\n"
    + "The Demo assistant could not plan an answer to that question. Try one of the starters."
)


def plan_turn(messages: Sequence[Mapping[str, Any]]) -> str:
    """The Demo model's reply to one agent-mode chat step: a lookup round or a final."""
    try:
        view = read_prompt(messages)
        ask = classify(view.question, view)
        calls = _next_calls(view, ask)
        if calls:
            return _render_calls(calls)
        final = _compose_final(view, ask)
        if view.legacy is not None:
            # The legacy aggregate carries no header manifest, so no ref can be named:
            # a header-less prose final lets the engine show the turn's artifacts in
            # their default views (SPEC §4.1.1(c)) rather than an answer without them.
            return "\n\n".join(_join_lists(final.body)).strip()
        return _render_final(final)
    except Exception:  # noqa: BLE001 -- deterministic, but never allowed to break a turn
        return _SAFE_FINAL


# --------------------------------------------------------------------------- #
# Report summary (SPEC §9.2/§9.4): a deterministic template over the fenced digest.
# --------------------------------------------------------------------------- #
_NO_DIGEST_SUMMARY = (
    "Demo report summary: the report digest was missing or unreadable, so there is nothing to summarise."
)


def _digest_leaves(blocks: Any) -> Iterable[Mapping[str, Any]]:
    """Every block digest of an item, report sections flattened (bounded)."""
    for block in (blocks if isinstance(blocks, list) else [])[:60]:
        if not isinstance(block, Mapping):
            continue
        if block.get("type") == "report":
            for section in block.get("sections") or []:
                if isinstance(section, Mapping):
                    yield from _digest_leaves(section.get("blocks"))
        else:
            yield block


def _digest_value(value: Any, unit: Any) -> str:
    number = _num(value)
    if number is None:
        return "not measured"
    if unit == "percent":
        return _pct(number)
    if unit == "usd":
        return _usd(number)
    return _dec(number)


def _sentence(text: str) -> str:
    """``text`` with its first letter upper-cased (the rest untouched) and a full stop."""
    text = text.strip()
    return (text[:1].upper() + text[1:]).rstrip(".") + "." if text else ""


def summarise_report(messages: Sequence[Mapping[str, Any]]) -> str:
    """The Demo summary of a report (see :func:`_summarise_report`). Never raises: an
    unexpected digest shape degrades to the no-digest sentence, as ``plan_turn``
    degrades to its safe final."""
    try:
        return _summarise_report(messages)
    except Exception:  # noqa: BLE001 -- deterministic, but never allowed to fail a summary call
        return _NO_DIGEST_SUMMARY


def _summarise_report(messages: Sequence[Mapping[str, Any]]) -> str:
    """The Demo summary of a report: the ``{executive_summary, next_steps}`` JSON that
    ``REPORT_SUMMARY_SYSTEM`` asks for, built only from values in the fenced digest
    (``engine.report_digest``): item titles, KPI values, top categories, series
    trends and case counts, plus the sampling and truncation it discloses. Without a
    readable digest it returns one plain sentence saying so. Labels in the digest are
    log- or user-derived, so they are written as plain text (no Markdown survives);
    the report title and analyst notes are not quoted at all."""
    digest: Any = None
    template = None
    for message in messages:
        if _role(message) != "user":
            continue
        content = _content(message)
        match = re.search(r"^Report template: ([a-z]{2,20})\.", content, re.MULTILINE)
        template = template or (match.group(1) if match else None)
        for body in _fence_body(content, "report"):
            try:
                digest = json.loads(body)
            except ValueError:
                continue
    if not isinstance(digest, Mapping):
        return _NO_DIGEST_SUMMARY
    meta = digest.get("report") if isinstance(digest.get("report"), Mapping) else {}
    items = [i for i in digest.get("items") or [] if isinstance(i, Mapping)]
    # The report title is the user's own text: the summary describes the content and
    # never echoes it (a renamed report keeps the same summary).
    template = template or _plain(meta.get("template"), 20) or "custom"
    count = int(_num(meta.get("items")) or len(items))
    titles = [_plain(i.get("title"), 80) for i in items if _plain(i.get("title"), 80)][:5]
    figures: list[str] = []
    leaders: list[str] = []
    trends: list[str] = []
    case_ids: list[str] = []
    severity: dict[str, float] = {}
    open_cases = 0.0
    sampled = truncated = demo = False
    notes = 0
    for item in items:
        demo = demo or item.get("demo_data") is True
        notes += 1 if item.get("analyst_note_untrusted") else 0
        for leaf in _digest_leaves(item.get("blocks")):
            caption = str(leaf.get("basis") or "").lower()
            sampled = sampled or "sample" in caption or "newest" in caption
            truncated = truncated or leaf.get("truncated") is True
            for kpi in leaf.get("kpis") or []:
                if isinstance(kpi, Mapping) and _plain(kpi.get("label"), 60) and len(figures) < 4:
                    figures.append(f"{_plain(kpi.get('label'), 60)} {_digest_value(kpi.get('value'), kpi.get('unit'))}")
            categories = [c for c in leaf.get("categories") or [] if isinstance(c, Mapping)]
            if categories and len(leaders) < 2:
                leaders.append(f"{_plain(leaf.get('title'), 60) or 'a chart'} is led by "
                               f"{_plain(categories[0].get('label'), 60) or 'an unnamed value'} "
                               f"({_digest_value(categories[0].get('value'), leaf.get('unit'))})")
            for series in leaf.get("series") or []:
                if isinstance(series, Mapping) and series.get("trend") in ("up", "down") and len(trends) < 2:
                    trends.append(f"{_plain(series.get('series'), 60) or _plain(leaf.get('title'), 60)} is trending "
                                  f"{series['trend']} (last {_digest_value(series.get('last'), leaf.get('unit'))})")
            for cid in leaf.get("case_ids") or []:
                if isinstance(cid, str) and cid not in case_ids and len(case_ids) < 50:
                    case_ids.append(cid)
            for sev, n in (leaf.get("severities") or {}).items() if isinstance(leaf.get("severities"), Mapping) else ():
                if isinstance(sev, str) and _num(n):
                    severity[sev] = severity.get(sev, 0.0) + (_num(n) or 0.0)
            statuses = leaf.get("statuses") if isinstance(leaf.get("statuses"), Mapping) else {}
            open_cases += sum(_num(n) or 0 for st, n in statuses.items()
                              if st in ("new", "investigating", "escalated", "on_hold", "open"))
    parts = [f"This {template} report holds {_plural(count, 'item')}"
             + (f": {_join(titles)}" if titles else "") + "."]
    if figures:
        parts.append(f"Key figures: {_join(figures)}.")
    if leaders:
        parts.append(_sentence("; ".join(leaders)))
    if trends:
        parts.append(_sentence("; ".join(trends)))
    if severity:
        order = [s for s in ("critical", "high", "medium", "low", "info") if severity.get(s)]
        parts.append(f"It references {_plural(len(case_ids), 'case')}"
                     + (": " + _join([f"{_count(severity[s])} {s}" for s in order]) if order else "") + ".")
    elif case_ids:
        parts.append(f"It references {_plural(len(case_ids), 'case')}.")
    if sampled:
        parts.append("Some figures come from samples of the newest events, not exact counts.")
    if truncated:
        parts.append("Some tables and charts show only their top entries.")
    if demo:
        parts.append("The items come from Demo Mode's synthetic data.")
    if _num(_dig(digest, "omitted", "items")):
        parts.append(f"{_plural(_dig(digest, 'omitted', 'items'), 'item')} did not fit the digest and "
                     "are not reflected here.")
    # The bounded digest may also drop blocks (any kind: charts, tables, callouts,
    # text ...) or whole-answer sections (each holding several blocks) inside kept
    # items (report_digest's ``omitted.blocks``/``omitted.sections``): named
    # separately, never as one "charts or tables" count. Query blocks are never in a
    # digest (a native query is not summarised), which is a rule, not a lack of room.
    dropped_blocks = int(_num(_dig(digest, "omitted", "blocks")) or 0)
    dropped_sections = int(_num(_dig(digest, "omitted", "sections")) or 0)
    if dropped_blocks or dropped_sections:
        left = _join([_plural(dropped_blocks, "block") if dropped_blocks else "",
                      _plural(dropped_sections, "answer section") if dropped_sections else ""])
        verb = "was" if dropped_blocks + dropped_sections == 1 else "were"
        parts.append(f"{left} inside the items did not fit the digest and {verb} left out of this summary.")
    queries = int(_num(_dig(digest, "omitted", "query_blocks")) or 0)
    if queries:
        parts.append(f"{_plural(queries, 'query block')} {'is' if queries == 1 else 'are'} "
                     "not summarised; queries are never part of the digest.")
    summary = " ".join(parts)
    if len(summary) > 1200:
        summary = summary[:1199].rstrip() + "\u2026"
    steps: list[str] = []
    if severity.get("critical") or severity.get("high"):
        steps.append("Review the critical and high-severity cases first.")
    if open_cases:
        steps.append(f"Confirm an owner for the {_plural(open_cases, 'open case')} in this report.")
    if sampled or truncated:
        steps.append("Re-run the sampled or top-N lookups with a narrower filter before acting on them.")
    if notes:
        steps.append(f"Check the {_plural(notes, 'analyst note')} against the data before sharing.")
    steps.append("Verify the figures in the console before sharing this report.")
    steps.append("Regenerate this summary after adding or removing items.")
    return json.dumps({"executive_summary": summary, "next_steps": steps[:5]}, ensure_ascii=True)
